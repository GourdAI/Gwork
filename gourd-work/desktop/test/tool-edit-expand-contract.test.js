/**
 * 契约测试：edit 工具卡「点开是空的」修复 + 工具输出面板统一（2026-11 用户报障）。
 *
 * ── 缺陷现场 ────────────────────────────────────────────────────────────────
 * ① Rust 内核 edit 的 action_end 不带 args（协议注释明确「回放由 action_start +
 *    action_end 重建」），也没有 Java 内核的 args.diff 扩展字段；结果文本只有
 *    "Edited … (N replacement(s) at line L)"。旧渲染器只认 args.diff / '---' 前缀，
 *    成功时又把结果文本整段隐藏 → html 恒为空串却 return true，展开就是一块空板。
 * ② 展开面板双轨：兜底文本自带 0 10px 8px 内边距（比 header 窄一圈、无底色），
 *    bash/read 等渲染器各自内联 padding:0 + 自带底色（--bg-code-block 深 / --bg-code 浅
 *    两种），edit 内联 12px/1.5 压过对齐层 ⑦ 的 12.5px/1.6 —— 宽度、底色、字号三不齐。
 *
 * ── 修复口径（本测试钉住的目标状态）──────────────────────────────────────────
 * JS：synthesizeEditDiff 从 old_str/new_str 合成 diff（首行号解析 "at line L"）；
 *     action_start 把完整 args 暂存到卡片（_toolArgs），updateToolCardContent 在
 *     end 帧 args 缺失时取回；成功摘要一行常显（is-ok）；空 html 绝不 return true；
 *     渲染器不写内联视觉样式，改挂 is-edit/is-bash/is-file 类；兜底文本包 .tool-plain-out。
 * CSS：.tool-card-body 全宽 padding:0 + 限高 320px；四类输出统一 --bg-code 浅底、
 *     14px 内节奏；diff 行 14px 左缘与其它输出对齐。
 *
 * ── 测试形态 ────────────────────────────────────────────────────────────────
 * synthesizeEditDiff 是纯函数：从真实源码切出函数体在 node:vm 真跑（不复制实现）。
 * edit 渲染器依赖 DOM/jQuery/i18n，用轻量假 bodyEl（classList/innerHTML/style 记录）
 * + escapeHtml/GourdI18n 桩真跑，断言产物 HTML 非空、含 diff 行与成功摘要。
 * 其余用源码/CSS 字符串断言 + 双镜像（desktop 与 java static）函数体逐字一致。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MIRRORS = [
    { name: 'desktop', js: path.join(ROOT, 'gourd-work/desktop/ui/js/app-message.js'), css: path.join(ROOT, 'gourd-work/desktop/ui/css/app.css') },
    { name: 'java-static', js: path.join(ROOT, 'gourdai-java/gourd-ai-agent/src/main/resources/static/js/app-message.js'), css: path.join(ROOT, 'gourdai-java/gourd-ai-agent/src/main/resources/static/css/app.css') },
];

function read(f) { return fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'); }

/* 花括号配平切函数体（与 stale-agent-frame.test.js 同手法，只切不 eval 副本） */
function extractBlock(src, anchor, label) {
    const start = src.indexOf(anchor);
    assert.ok(start >= 0, label + '：锚点丢失 ' + anchor);
    let depth = 0, i = src.indexOf('{', start);
    assert.ok(i >= 0, label + '：无函数体起始');
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    assert.equal(depth, 0, label + '：花括号不配平');
    return src.slice(start, i + 1);
}

/* ===== 一、synthesizeEditDiff 纯函数真跑 ===== */
function loadSynth(src, label) {
    const body = extractBlock(src, 'function synthesizeEditDiff(args, text) {', label);
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(body + '\nthis.fn = synthesizeEditDiff;', sandbox);
    return sandbox.fn;
}

for (const m of MIRRORS) {
    const src = read(m.js);
    const synth = loadSynth(src, m.name);

    test(m.name + '：old_str/new_str 合成带行号 hunk 的 diff（Rust 内核路径）', () => {
        const diff = synth({ old_str: 'aaa\nbbb', new_str: 'ccc' }, 'Edited x.rs (1 replacement(s) at line 42)');
        assert.ok(diff, '必须合成出 diff');
        assert.ok(diff.startsWith('@@ -42,2 +42,1 @@'), '首行号必须取 "at line 42"：' + diff.split('\n')[0]);
        assert.ok(diff.includes('-aaa') && diff.includes('-bbb') && diff.includes('+ccc'));
    });

    test(m.name + '：无结果文案时从 1 起行号；尾部换行不多画空行', () => {
        const diff = synth({ old_str: 'x\n', new_str: 'y\n' }, null);
        assert.ok(diff.startsWith('@@ -1,1 +1,1 @@'), diff);
        assert.equal(diff.split('\n').filter(l => l === '-' || l === '+').length, 0, '尾部换行不得合成空删除/新增行');
    });

    test(m.name + '：缺 old_str/new_str 时返回 null（交还其它路径）', () => {
        assert.equal(synth({}, 'Edited x'), null);
        assert.equal(synth(null, 'Edited x'), null);
        assert.equal(synth({ old_str: '', new_str: '' }, 'x'), null);
    });

    test(m.name + '：CRLF args 归一化为 LF（内核 EOL 转写后落盘的是 LF，diff 不得残留 \\r）', () => {
        const diff = synth({ old_str: 'a\r\nb\r\n', new_str: 'c\r\n' }, 'Edited x (1 replacement(s) at line 3)');
        assert.ok(diff, 'CRLF 输入必须能合成');
        assert.ok(!diff.includes('\r'), 'diff 里不得残留回车符（pre-wrap 会多画占位）');
        assert.ok(diff.startsWith('@@ -3,2 +3,1 @@'), 'CRLF 尾部换行不得多计一行：' + diff.split('\n')[0]);
        assert.ok(diff.includes('-a') && diff.includes('-b') && diff.includes('+c'));
    });
}

/* ===== 二、edit 渲染器真跑：Rust 帧形态（无 args.diff、英文成功文案）不再空板 ===== */
function loadEditRenderer(src, label) {
    const synth = extractBlock(src, 'function synthesizeEditDiff(args, text) {', label);
    const start = src.indexOf('window._toolRenderers.edit = function');
    assert.ok(start >= 0, label + '：edit 渲染器丢失');
    let depth = 0, i = src.indexOf('{', start);
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    /* 函数表达式以 }; 结尾 */
    const renderer = src.slice(start, i + 2);
    const sandbox = {
        window: { _toolRenderers: {} },
        escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        GourdI18n: { t: k => k },
    };
    vm.createContext(sandbox);
    vm.runInContext(synth + '\n' + renderer, sandbox);
    return sandbox.window._toolRenderers.edit;
}
function fakeBody() {
    const classes = new Set();
    return {
        innerHTML: '', style: {},
        classList: { add: c => classes.add(c), contains: c => classes.has(c) },
        _classes: classes,
    };
}

for (const m of MIRRORS) {
    const src = read(m.js);
    const render = loadEditRenderer(src, m.name);

    test(m.name + '：Rust edit 帧（args 仅 old/new、结果 Edited…）展开必须有内容', () => {
        const body = fakeBody();
        const ok = render(body, 'Edited AGENTS.md (1 replacement(s) at line 7)',
            { file_path: 'AGENTS.md', old_str: '旧内容', new_str: '新内容' }, false);
        assert.equal(ok, true);
        assert.ok(body.innerHTML.length > 0, '展开不得是空板（用户报障核心）');
        assert.ok(body.innerHTML.includes('git-line-del') && body.innerHTML.includes('git-line-add'), '必须渲染 diff 行');
        assert.ok(body.innerHTML.includes('Edited AGENTS.md'), '成功摘要必须常显（改在哪一行的唯一线索）');
        assert.ok(body._classes.has('is-edit'), '视觉走 CSS 类');
        assert.equal(Object.keys(body.style).length, 0, '不得再写内联视觉样式');
    });

    test(m.name + '：失败帧渲染错误段；完全无内容时 return false 交还兜底', () => {
        const body = fakeBody();
        const ok = render(body, 'old_str not found in x.rs', { old_str: 'a', new_str: 'b' }, true);
        assert.equal(ok, true);
        assert.ok(body.innerHTML.includes('is-error') && body.innerHTML.includes('old_str not found'));
        const empty = fakeBody();
        assert.equal(render(empty, '', {}, false), false, '空输入必须交还纯文本兜底，不得 return true 留空板');
    });

    test(m.name + '：failed=true 且无 diff 无文案时仍渲染警示段（不得空板）', () => {
        const body = fakeBody();
        const ok = render(body, '', {}, true);
        assert.equal(ok, true, '失败态保底必须自渲染，不得 return false 落空串兜底');
        assert.ok(body.innerHTML.includes('is-error') && body.innerHTML.includes('chat.edit_failed'));
    });

    test(m.name + '：Java 扩展字段 args.diff 路径保持原行为', () => {
        const body = fakeBody();
        const diff = '@@ -1,1 +1,1 @@\n-a\n+b';
        const ok = render(body, '编辑成功', { diff }, false);
        assert.equal(ok, true);
        assert.ok(body.innerHTML.includes('git-line-add'));
    });
}

/* ===== 三、args 回填链路（end 帧不带 args 时从卡片取回）===== */
for (const m of MIRRORS) {
    const src = read(m.js);
    test(m.name + '：action_start 暂存 _toolArgs，updateToolCardContent 缺失时取回', () => {
        const upd = extractBlock(src, 'function updateToolCardContent(sess, cardEl, toolName, toolTitle, args, text, meta, options, failed) {', m.name);
        assert.ok(upd.includes('if (!args && cardEl && cardEl._toolArgs) args = cardEl._toolArgs;'),
            'end 帧 args 缺失必须取回 start 暂存（否则实时/回放 edit 卡都拿不到 old_str/new_str）');
        const shell = extractBlock(src, 'function createToolCardShell(sess, toolName, args, toolTitle, actionId, agentBody, argsStr) {', m.name);
        assert.ok(shell.includes('card._toolArgs = args'), 'createToolCardShell 必须暂存完整 args');
        const adopt = extractBlock(src, 'function adoptArgsStreamingCard(sess, card, toolName, args, presentationTitle, agentBody, batchMeta, argsStr) {', m.name);
        assert.ok(adopt.includes('card._toolArgs = args'), '骨架转正必须补存 args（draft 期参数不存在）');
        assert.ok(src.includes('approvedCard._toolArgs = args'), 'HITL 接管路径必须补存 args');
    });

    test(m.name + '：渲染器视觉全部走 CSS 类，兜底文本包 .tool-plain-out', () => {
        assert.ok(!/bodyEl\.style\.(padding|maxHeight|fontSize|fontFamily|lineHeight|overflow)\s*=/.test(src),
            '渲染器不得再写内联视觉样式（会压过对齐层 ⑦ 且造成双轨宽度/底色）');
        assert.ok(src.includes("bodyEl.classList.add('is-bash')"));
        assert.ok(src.includes("bodyEl.classList.add('is-file')"));
        assert.ok(src.includes('<div class="tool-plain-out">'), '兜底文本必须包统一面板');
        assert.ok(src.includes('<pre class="tool-file-pre">'), 'read/write/todo 高亮体走统一类');
    });
}

/* ===== 四、CSS 统一口径 ===== */
function ruleBody(css, selector) {
    const m = css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
    assert.ok(m, '规则缺失: ' + selector);
    return m[1];
}
for (const m of MIRRORS) {
    const css = read(m.css);
    test(m.name + '：卡体全宽 padding:0 + 320px 限高；四类输出同底同内距', () => {
        const body = ruleBody(css, '.tool-card-body');
        assert.match(body, /padding:\s*0\s*;/, '卡体必须全宽（与 header 同宽，阴影块不再窄一圈）');
        assert.match(body, /max-height:\s*320px/, '兜底限高统一 320px');
        assert.match(ruleBody(css, '.tool-plain-out'), /background:\s*var\(--bg-code\)/);
        assert.match(ruleBody(css, '.tool-file-pre'), /background:\s*var\(--bg-code\)/);
        assert.match(ruleBody(css, '.bash-output'), /background:\s*var\(--bg-code\)\s*;/, 'bash 不得再用深色 --bg-code-block（与其余输出两种底）');
        assert.match(ruleBody(css, '.grep-result, .file-listing'), /background:\s*var\(--bg-code\)/);
        assert.match(ruleBody(css, '.tool-card-body.is-edit'), /background:\s*var\(--bg-code\)/);
        assert.ok(css.includes('.tool-card-body.is-bash, .tool-card-body.is-file, .tool-card-body.is-edit { max-height: 320px; }'),
            'bash/read/edit 限高必须与兜底同档（原先三档并存）');
        assert.ok(css.includes('.tool-card-body.is-edit .git-diff-line { padding: 0 14px; }'),
            'diff 行左缘必须与其它输出的 14px 节奏对齐');
        const batch = ruleBody(css, '.batch-tool-items > .tool-card .tool-card-body');
        assert.match(batch, /padding-left:\s*0\s*;/, '批次成员卡体同样全宽');
    });
}

/* ===== 五、双镜像一致性（单侧修复会被同步冲掉）===== */
test('双镜像 synthesizeEditDiff 与 edit 渲染器函数体逐字一致', () => {
    const anchors = [
        'function synthesizeEditDiff(args, text) {',
        'window._toolRenderers.edit = function(bodyEl, text, args, failed) {',
    ];
    for (const a of anchors) {
        const bodies = MIRRORS.map(m => extractBlock(read(m.js), a, m.name));
        assert.equal(bodies[1], bodies[0], a + ' 双镜像漂移');
    }
});
test('双镜像 app.css 逐字一致（process-flat-contract ① 同口径）', () => {
    assert.equal(read(MIRRORS[1].css), read(MIRRORS[0].css));
});