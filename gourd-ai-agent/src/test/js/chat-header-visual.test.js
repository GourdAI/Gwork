const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');

test('思考块头部不再携带展开箭头节点与样式', () => {
    const message = readStatic('js', 'app-message.js');
    const css = readStatic('css', 'app.css');
    const codeCss = readStatic('css', 'code.css');
    assert.doesNotMatch(message, /thinking-block-toggle/);
    assert.doesNotMatch(css, /\.thinking-block-toggle/);
    assert.doesNotMatch(codeCss, /\.thinking-block-toggle/);
});

test('思考图标与智能体图标均为 currentColor SVG，无 emoji 字形', () => {
    const message = readStatic('js', 'app-message.js');
    const thinking = message.match(/var THINKING_SVG = '([^']+)';/);
    assert.ok(thinking, 'THINKING_SVG 常量应存在');
    assert.match(thinking[1], /^<svg[\s\S]*currentColor[\s\S]*<\/svg>$/);
    assert.doesNotMatch(thinking[1], /[\u{1F000}-\u{1FAFF}\u2600-\u27BF]/u);

    const agent = message.match(/var AGENT_SVG = '([^']+)';/);
    assert.ok(agent, 'AGENT_SVG 常量应存在');
    assert.match(agent[1], /^<svg[\s\S]*currentColor[\s\S]*<\/svg>$/);
    assert.match(message, /agent-icon">' \+ AGENT_SVG/);
    assert.doesNotMatch(message, /🤖/);
    assert.equal((agent[1].match(/fill="currentColor" stroke="none"/g) || []).length, 3, '机器人填充点不得继承 SVG 描边');
});

test('思考图标为单主体灵感星芒，不回退为灯泡或双半球大脑', () => {
    const message = readStatic('js', 'app-message.js');
    const thinking = message.match(/var THINKING_SVG = '([^']+)';/);
    assert.ok(thinking, 'THINKING_SVG 常量应存在');
    const svg = thinking[1];
    // 与工具图标共享 16 网格和 1.2px 线宽，避免同一 18px 画布内视觉重量失衡
    assert.match(svg, /viewBox="0 0 16 16"/);
    assert.match(svg, /stroke="currentColor"/);
    assert.match(svg, /stroke-width="1\.2"/);
    assert.match(svg, /stroke-linecap="round"/);
    assert.match(svg, /stroke-linejoin="round"/);
    assert.equal((svg.match(/<path /g) || []).length, 2, '灵感星芒应由两个连续线性主体组成');
    assert.doesNotMatch(svg, /<g transform=/);
    assert.doesNotMatch(svg, /<circle /);
    assert.doesNotMatch(svg, /M6\.33 1\.33|M9\.67 1\.33|M12 5a3 3/);
    assert.doesNotMatch(svg, /灯泡|brain-circuit/);
});

test('对话区图标尺寸统一为 18px（工具/智能体/思考），变更 chip 维持 16px', () => {
    const css = readStatic('css', 'app.css');
    assert.match(css, /\.tool-type-icon svg,\s*\.agent-icon svg \{ width: 18px; height: 18px; display: block; stroke: currentColor; \}/);
    assert.match(css, /\.file-changes-chip \.tool-type-icon svg \{ width: 16px; height: 16px;/);
});

test('工具耗时恒定排在状态点之前，状态点排序不随耗时出现而变化（勿回退 has-duration 方案）', () => {
    const message = readStatic('js', 'app-message.js');
    const css = readStatic('css', 'app.css');
    // duration 直接插到状态点之前：DOM 顺序与视觉顺序一致
    assert.match(message, /\.find\('\.tool-status-icon'\)\.first\(\)\[0\][\s\S]{0,150}?\.before\(span\)/);
    // 状态点为容器内最大 order、耗时恒定在它前一位；排序不因类切换变化
    assert.match(css, /\.tool-status-icon \{ order: 6;/);
    assert.match(css, /\.tool-duration \{ order: 5;/);
    // 旧的 has-duration 布局覆盖必须保持移除：它让排序在过渡窗口里异步变化，产生可见闪跳
    assert.doesNotMatch(message, /addClass\('has-duration'\)/);
    assert.doesNotMatch(css, /\.tool-card-header\.has-duration/);
});

test('状态点在模板中位于 header 末尾（DOM 序 = 视觉序，勿回退到 DOM 第 2 位 / 首位）', () => {
    const message = readStatic('js', 'app-message.js');
    // 旧形态（type 后紧跟状态点）不得存在
    assert.doesNotMatch(message, /'<span class="tool-type-icon"><\/span>'\s*\+\s*'<span class="tool-status-icon/, '模板不得回退为 type 后紧跟状态点');
    assert.doesNotMatch(message, /<span class="tool-type-icon"><\/span><span class="tool-status-icon loading"><\/span>/);
    // HITL 卡旧形态（header 以状态点开头）不得存在
    assert.doesNotMatch(message, /<div class="tool-card-header">'\s*\+\s*'<span class="tool-status-icon warn"/);
    // 批量卡新形态抽查：进度之后、header 结束之前是状态点
    assert.match(message, /'<span class="tool-batch-progress"><\/span>'\s*\+\s*'<span class="tool-status-icon loading"><\/span>'\s*\+\s*'<\/div>'/);
});

test('三处状态点的 transition 不得包含 all（布局属性入过渡会再次产生闪跳）', () => {
    const css = readStatic('css', 'app.css');
    assert.doesNotMatch(css, /transition:\s*all 0\.3s/, '状态点的 transition: all 0.3s 不得回归');
    assert.match(css, /\.tool-status-icon \{[^}]*transition: background-color 0\.3s, box-shadow 0\.3s;/);
    assert.match(css, /\.thinking-status-dot \{[^}]*transition: background-color 0\.3s, box-shadow 0\.3s;/);
});

test('状态点保留语义色，不再被统一灰色覆盖', () => {
    const css = readStatic('css', 'app.css');
    assert.match(css, /\.tool-status-icon\.done \{ background: var\(--color-success/);
    assert.match(css, /\.agent-status-icon\.done \{ background: var\(--color-success/);
    assert.match(css, /\.thinking-status-dot \{[^}]*background: var\(--color-success/);
    assert.match(css, /\.thinking-block-dots span \{[^}]*background: var\(--accent\)/);
    assert.doesNotMatch(css, /\.thinking-status-dot \{ background: var\(--text-tertiary\)/);
    assert.doesNotMatch(css, /\.thinking-block-dots span \{ background: var\(--text-secondary\)/);
});
