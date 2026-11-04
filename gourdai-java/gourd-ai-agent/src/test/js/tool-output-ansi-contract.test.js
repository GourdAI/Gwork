/* ===== tool-output-ansi-contract.test.js =====
   工具输出里的 ANSI 颜色码必须在前端被剥干净。

   现场事故（2026-10-30 用户报「rust 的命令是不是有问题，为什么显示的红色」）：
   PowerShell 5.1 会把 native command 的 stderr 包成 `\x1b[31m…\x1b[0m`。
   ESC 字节在 HTML 里不可见，于是 `<pre>` 里剩下的是字面量 `[31m` / `[0m`，
   直接插进错误文本中间——用户看到的是
     remote: [31m[session-…] 404 not found![0m
   看起来就像「输出坏了」，实际命令行为正确（git 真的返回了 404）。

   为什么必须在前端再剥一遍（内核已剥）：
   1) 历史会话里已落盘的旧消息不会因内核修复而重写，回放依旧带码；
   2) Java 内核 ProcessExecutor 目前未做剥离（两内核存在阶段差）；
   3) 终端面板早就有 stripAnsi（app-terminal.js），工具卡没有——同一份输出
      在两个面板里一个有颜色码一个没有，本身就不一致。

   断言取向：
   - stripAnsiForDisplay 是真函数，用 vm 直接驱动（不靠正则搜源码）；
   - 必须踩到「不误伤」：未被 ESC 引导的 `[31]`/`[0m` 是用户真实文本
     （正则、栈帧、数组下标），剥多了比不剥更糟；
   - renderToolBody 是唯一入口：新增的工具 renderer 不得绕过它。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.resolve(__dirname, '../../main/resources/static');
const msgJs = fs.readFileSync(path.join(STATIC, 'js', 'app-message.js'), 'utf8');

/* 只在 vm 里求值 app-message.js 顶部的 stripAnsiForDisplay 区段：
   整个文件依赖 jQuery/escapeHtml/DOM，全量求值会炸；用正则截出函数体
   不可靠（函数体内有字符串），改为跑一段「最小壳」——把文件里的
   stripAnsiForDisplay 及其三个正则原样搬进沙箱。两者拼接来源相同，
   不会出现「测的不是产品代码」。 */
function loadStripAnsi() {
    const start = msgJs.indexOf('var ANSI_CSI_RE');
    const end = msgJs.indexOf('window.stripAnsiForDisplay');
    assert.ok(start > 0 && end > start, 'stripAnsiForDisplay 及其正则必须存在于 app-message.js');
    const src = msgJs.slice(start, end) + '\nthis.__strip = stripAnsiForDisplay;';
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(src, ctx, { filename: 'app-message.js#stripAnsiForDisplay' });
    return ctx.__strip;
}

const strip = loadStripAnsi();

test('剥掉 PowerShell 红色包装（现场形态）', () => {
    const raw = 'git : remote: \u001b[31m[session-c442] 404 not found!\u001b[0m\n';
    assert.strictEqual(strip(raw), 'git : remote: [session-c442] 404 not found!\n');
});

test('剥掉多段/带参/OSC 序列', () => {
    assert.strictEqual(strip('\u001b[1m\u001b[31mbold red\u001b[0m done'), 'bold red done');
    assert.strictEqual(strip('a\u001b[2K\u001b[1;1Hb'), 'ab');
    assert.strictEqual(strip('\u001b]0;title\u0007body'), 'body');
});

test('【关键回归】不误伤普通方括号文本', () => {
    // 这些都不是 ESC 引导的序列，是用户真实内容：绝不能删
    const cases = [
        'arr[31] and match r"[0m"',
        'File "x.py", line 31, in <module>',
        'grep -E "[1;2]" src/',
        '[stderr]',
        '[exit code: 1]'
    ];
    for (const c of cases) {
        assert.strictEqual(strip(c), c, '不得改动无 ESC 的文本: ' + c);
    }
});

test('无 ESC 时原样返回（快速路径，不重建字符串）', () => {
    const s = '普通输出，无颜色码';
    assert.strictEqual(strip(s), s);
    assert.strictEqual(strip(''), '');
    assert.strictEqual(strip(null), null);
    assert.strictEqual(strip(undefined), undefined);
});

test('中文与 emoji 不受影响', () => {
    assert.strictEqual(strip('\u001b[32m✓ 构建成功\u001b[0m → 用时 3s 🎉'), '✓ 构建成功 → 用时 3s 🎉');
});

test('renderToolBody 是唯一入口：分发前先剥', () => {
    // 护栏：任何工具 renderer 的 text 都必须经过 renderToolBody（它内部先剥再分发）。
    // 若未来有人新增 renderer 并绕过它直接 bodyEl.textContent = text，
    // 就会重新把颜色码漏给用户——这条断言钉住入口唯一性。
    const fn = msgJs.slice(msgJs.indexOf('function renderToolBody('));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.match(body, /text = stripAnsiForDisplay\(text\)/,
        'renderToolBody 必须在分发前剥 ANSI（否则所有专用 renderer 都会漏码）');
});

test('【本轮修的 P1】展开全文兕底路径必须自己过 stripAnsi', () => {
    /* 历史缺陷：renderToolBody 内部剥的是它的**局部副本**，返回 false 后调用方
       手上那个 `full` 仍是原始串。旧写法 `bodyEl.textContent = full` 于是把 ESC
       原样写进 DOM。
       【为何此前护栏没拦住】上一条只验证了「renderToolBody 内部有剥离」，而这条
       兕底分支根本不经过它（命不中 renderer 时），因此两条断言必须分开钉。 */
    assert.match(msgJs, /bodyEl\.textContent = stripAnsiForDisplay\(full\)/,
        '展开全文的兕底分支必须写成 stripAnsiForDisplay(full)');
    assert.doesNotMatch(msgJs, /bodyEl\.textContent = full;/, 
        '不得存在未剥 ANSI 的 bodyEl.textContent = full（会把 ESC 直写进 DOM）');
});

test('两内核 UI 副本都要有剥离（Java static 与 Rust 壳 desktop/ui）', () => {
    const repoRoot = path.resolve(__dirname, '../../../../../');
    const mirror = path.join(repoRoot, 'gourd-work', 'desktop', 'ui', 'js', 'app-message.js');
    if (!fs.existsSync(mirror)) return;
    const mirrorJs = fs.readFileSync(mirror, 'utf8');
    assert.ok(mirrorJs.indexOf('stripAnsiForDisplay') > 0,
        'desktop/ui 副本缺 stripAnsiForDisplay：Rust 壳里颜色码会重新出现');
});

test('Rust 内核侧也在源头剥（textcodec::strip_ansi + 命令路径接线）', () => {
    const repoRoot = path.resolve(__dirname, '../../../../../');
    const core = path.join(repoRoot, 'gourd-work', 'core', 'src');
    if (!fs.existsSync(core)) return;
    const textcodec = fs.readFileSync(path.join(core, 'textcodec.rs'), 'utf8');
    assert.match(textcodec, /pub fn strip_ansi/,
        'textcodec 必须提供 strip_ansi');
    // 三个命令输出出口：bash 工具、HITL 批准后执行、git
    const builtin = fs.readFileSync(path.join(core, 'tools', 'builtin', 'mod.rs'), 'utf8');
    assert.ok(builtin.indexOf('strip_ansi') > 0,
        'bash 工具输出必须剥离 ANSI（否则 UI 里看到字面量 [31m）');
    const server = fs.readFileSync(path.join(core, 'server', 'mod.rs'), 'utf8');
    assert.ok(server.indexOf('strip_ansi') > 0,
        'HITL 批准后的命令执行路径同样必须剥离');
    const gitops = fs.readFileSync(path.join(core, 'gitops.rs'), 'utf8');
    assert.ok(gitops.indexOf('strip_ansi') > 0,
        'git 输出同样必须剥离（color.ui=always 时会带码）');
});
