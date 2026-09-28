/**
 * 契约测试：助手气泡与用户消息右边界同线对齐（app.css）。
 *
 * 背景：卡片头部状态点（.tool-status-icon / .thinking-status-dot /
 * .agent-status-icon / .tool-batch-header .tool-status-icon）全部
 * margin-left:auto 钉在助手气泡最右缘；而用户消息的右边界在
 * .user-msg-col 的 100% 处。此前助手气泡被限制为 92%，两条右边界
 * 差约 60px，整列状态点悬在半空形成游离竖列（用户截图中红框处）。
 *
 * 覆盖：
 * - app.css：.msg-row.assistant .msg-bubble 必须通栏（max-width 与
 *   min-width 均为 100%），与 .user-msg-col 的 100% 严格同线
 * - min-width 存在的意义：短内容时状态点仍贴行尾而非跟随内容收缩
 * - 移动端 @media (max-width: 768px) 覆盖（100% !important + unset）不受影响
 * - gourd-ai-tauri/ui 发布副本与 static 源同步（存在镜像时才比对）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
const appCss = readStatic('css', 'app.css');

/* 提取选择器的规则块（含大括号），便于断言具体属性。
   匹配条件是「选择器后紧跟 {」而非首次出现：类名常被注释提及（如 847 行注释里的
   .thinking-status-dot），按首次出现提取会读到注释后面的无关规则。 */
function ruleBlock(css, selector) {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(esc + '\\s*\\{').exec(css);
    if (!m) return null;
    const open = css.indexOf('{', m.index);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}') {
            depth--;
            if (depth === 0) return css.slice(m.index, i + 1);
        }
    }
    return null;
}

test('助手气泡通栏 100%：与用户消息右边界（user-msg-col 100%）严格同线', () => {
    const block = ruleBlock(appCss, '.msg-row.assistant .msg-bubble');
    assert.ok(block, 'app.css 缺少 .msg-row.assistant .msg-bubble 规则');
    assert.match(block, /max-width:\s*100%/,
        'max-width 必须为 100%（92% 会让状态点列与用户消息右边界错位约 60px）');
    assert.match(block, /min-width:\s*100%/,
        'min-width 必须为 100%（短内容时状态点仍贴行尾而非跟随内容收缩）');
});

test('回归护栏：助手气泡不得回退到窄于用户列的宽度（92% 形态即缺陷形态）', () => {
    const block = ruleBlock(appCss, '.msg-row.assistant .msg-bubble');
    assert.ok(block);
    assert.ok(!/max-width:\s*9\d%/.test(block),
        '助手气泡窄于用户列会重现「悬空状态点列」缺陷，宽度不得回退为 9x%');
});

test('状态点仍钉在行尾：margin-left:auto 契约不变（对齐依赖此锚点）', () => {
    const dot = ruleBlock(appCss, '.tool-status-icon');
    assert.ok(dot, '缺少 .tool-status-icon 规则');
    assert.match(dot, /margin-left:\s*auto/);
    const tdot = ruleBlock(appCss, '.thinking-status-dot');
    assert.ok(tdot, '缺少 .thinking-status-dot 规则');
    assert.match(tdot, /margin-left:\s*auto/);
});

test('移动端覆盖不受影响：@media 768px 下气泡仍 100% 且解除 min-width', () => {
    const m = appCss.match(/@media\s*\(max-width:\s*768px\)\s*\{/);
    assert.ok(m, '缺少移动端媒体查询');
    const tail = appCss.slice(m.index);
    assert.match(tail, /\.msg-row\.user \.msg-bubble,\s*\.msg-row\.assistant \.msg-bubble\s*\{\s*max-width:\s*100% !important;\s*min-width:\s*unset !important;\s*\}/);
});

test('gourd-ai-tauri/ui 发布副本与 static 源同步（存在镜像时才比对）', () => {
    const mirror = path.resolve(__dirname, '../../../../gourd-ai-tauri/ui/css/app.css');
    if (!fs.existsSync(mirror)) return; /* 本仓未检出镜像时跳过，CI 不因此挂 */
    const mirrorText = fs.readFileSync(mirror, 'utf8').replace(/^\uFEFF/, '');
    assert.equal(mirrorText, appCss,
        'gourd-ai-tauri/ui 副本已与 static 源不同步，请运行 node gourd-ai-tauri/cmd/prepare-ui.js 后重试');
});
