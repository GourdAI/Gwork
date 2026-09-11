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
});

test('工具耗时经 has-duration 标记由 CSS 排在状态点之前', () => {
    const message = readStatic('js', 'app-message.js');
    const css = readStatic('css', 'app.css');
    assert.match(message, /\$\(header\)\.addClass\('has-duration'\)/);
    assert.match(css, /\.tool-card-header\.has-duration \.tool-duration \{ order: 4; margin-left: auto; \}/);
    assert.match(css, /\.tool-card-header\.has-duration \.tool-status-icon \{ order: 5; margin-left: 0; \}/);
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
