/**
 * 契约测试：① 尾部 trace 详情弹层已彻底移除；② 任务监控右栏左分隔线不再戳进顶条。
 *
 * 这两项都是「删掉某段 UI / 收窄某条线」的改动，没有运行时行为可沙箱执行，
 * 故用源码级不变量钉住：改动前用户看到的两处缺陷，任何一处复活即红。
 * 同时保留正向断言（耗时徽标仍生成、用量卡才是 TPS/TTFT 的唯一去处），
 * 防止有人以「删干净」为名把徽标或明细卡一起删掉。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const UI = path.join(__dirname, '..', 'ui');
const read = (p) => fs.readFileSync(path.join(UI, p), 'utf8');
const msg = read('js/app-message.js');
const ctx = read('js/app-context.js');
const appCss = read('css/app.css');
const codeCss = read('css/code.css');
const monitorCss = read('css/task-monitor.css');

// ── ① trace-pop 弹层移除 ──────────────────────────────────────────────

test('app-message.js：弹层生成器与开合事件全部移除', () => {
    // 只禁弹层专属标识符；aria-expanded / tabindex / role 等在别处（HITL、折叠等
    // 并行主题）是合法的无障碍属性，不能全局禁用。
    for (const dead of [
        'buildTracePop', 'traceTpsText', 'traceTtftText', 'traceEsc',
        'closeAllTracePops', 'has-pop', 'trace-pop'
    ]) {
        assert.ok(!msg.includes(dead),
            '弹层残留（应已删除）: ' + dead);
    }
    // 4 个 document 委托不得复活
    assert.ok(!/\.trace-item\.has-pop/.test(msg), 'has-pop 事件委托不得复活');
});

test('app-message.js：静态耗时徽标仍生成（时钟 + 文本 + 原生 title）', () => {
    assert.match(msg, /function appendTraceBadge\(/, '徽标渲染入口必须保留');
    assert.match(msg, /function traceElapsedText\(/, '耗时文本格式化必须保留');
    assert.match(msg, /TRACE_TIME_SVG, elapsedTxt/, '仍是时钟图标 + 耗时文本');
    assert.match(msg, /class="trace-item" title=/, '静态徽标用原生 title，不再是 disclosure');
    assert.ok(!/tabindex="0" role="button"/.test(msg), '不得再做可聚焦按钮');
});

test('CSS：.trace-pop 族规则与 code.css 覆写全部移除，基础徽标样式保留', () => {
    for (const css of [appCss, codeCss]) {
        assert.ok(!css.includes('.trace-pop'), 'CSS 不得再有 .trace-pop 规则');
        assert.ok(!css.includes('has-pop'), 'CSS 不得再有 .has-pop 规则');
    }
    // 徽标本体的视觉样式必须还在（用户仍要看到那个时钟徽标）
    assert.match(appCss, /\.msg-trace \.trace-item \{/, '.trace-item 基础样式必须保留');
    assert.match(appCss, /\.msg-trace \.trace-ic/, '时钟图标样式必须保留');
    // 用量卡宽度规则只服务 .context-meter-pop
    assert.match(codeCss, /body\.code-mode #chatView \.context-meter-pop/);
});

test('TPS / TTFT / 总用时统一在 app-context.js 用量卡，且 12 语言包键齐全', () => {
    assert.match(ctx, /function ctxTpsText\(/, 'TPS 仍在用量卡');
    assert.match(ctx, /function ctxTtftText\(/, 'TTFT 已迁入用量卡');
    assert.match(ctx, /ctxRow\(GourdI18n\.t\('chat\.output_tps'\)/, 'TPS 行接线');
    assert.match(ctx, /ctxRow\(GourdI18n\.t\('chat\.ttft'\)/, 'TTFT 行接线');
    const dir = path.join(UI, 'locales');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 12);
    for (const f of files) {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        for (const k of ['output_tps', 'tps_unit', 'ttft']) {
            assert.ok(j.chat && j.chat[k], f + ' 缺 chat.' + k);
        }
    }
});

// ── ② 任务监控右栏左分隔线不戳进顶条 ──────────────────────────────────

test('task-monitor.css：左分隔线改用伪元素且 is-electron 下压到 44px', () => {
    // 根因：原 border-left 从 top:0 一路画到 bottom，穿过 44px 标题栏。
    assert.ok(!/\.task-monitor-drawer\s*\{[^}]*border-left:/s.test(monitorCss),
        '不得再用 border-left（会画进顶条）');
    assert.match(monitorCss, /\.task-monitor-drawer::after\s*\{/,
        '左线必须改为绝对定位伪元素');
    assert.match(monitorCss, /body\.is-electron \.task-monitor-drawer::after\s*\{\s*top:\s*44px;/,
        '桌面壳顶行 44px 内不得出现竖线（跨栈契约同值）');
    // ::after 必须 absolute + left:0 + 1px，且不能吃掉指针事件
    const rule = monitorCss.match(/\.task-monitor-drawer::after\s*\{([^}]*)\}/)[1];
    assert.match(rule, /position:\s*absolute/);
    assert.match(rule, /left:\s*0/);
    assert.match(rule, /width:\s*1px/);
    assert.match(rule, /pointer-events:\s*none/);
});

test('task-monitor.css：修复不得破坏 44px 跨栈契约与打开态', () => {
    // drawer 自身 top/background/width 不能动（改了会重现「头部色差」报障）
    const base = monitorCss.match(/\.task-monitor-drawer\s*\{([^}]*)\}/)[1];
    assert.match(base, /top:\s*0/);
    assert.match(base, /background:\s*var\(--bg-main\)/);
    assert.match(base, /width:\s*var\(--task-monitor-width\)/);
    assert.match(monitorCss, /body\.is-electron \.task-monitor-drawer::before\s*\{[\s\S]*?height:\s*44px/,
        '顶行色带仍是 44px');
    assert.match(monitorCss, /body\.task-monitor-open \.task-monitor-drawer\s*\{[\s\S]*?visibility:\s*visible/,
        '打开态仍在');
});
