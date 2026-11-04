const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
const history = readStatic('js', 'app-history.js');
const modelSettings = readStatic('js', 'app-model-settings.js');
const chatHtml = readStatic('chat.html');
const appCss = readStatic('css', 'app.css');
const codeCss = readStatic('css', 'code.css');

const CONTEXT_VALUES = [128000, 256000, 512000, 1000000];
const CONTEXT_LABELS = ['128K', '256K', '512K', '1M'];
const LOCALES = ['de', 'el', 'en', 'es', 'fr', 'ja', 'pt', 'ro', 'ru', 'vi', 'zh-CN', 'zh-TW'];

test('上下文选择器使用稳定的 256K 默认值和固定四档', () => {
    assert.match(history, /var DEFAULT_CONTEXT_LENGTH = 256000;/);
    assert.match(history, /var CONTEXT_LENGTH_OPTIONS = \[128000, 256000, 512000, 1000000\];/);
    assert.match(history, /var sessionContextMap = \{\};/);
    for (const value of CONTEXT_VALUES) assert.match(history, new RegExp(String(value)));
    for (const label of CONTEXT_LABELS) assert.match(history, new RegExp(label));
    assert.match(history, /return DEFAULT_CONTEXT_LENGTH;/);
});

test('模型响应读取会话上下文，但模型条目不再携带每模型上下文长度', () => {
    assert.match(history, /data && data\.contextLength/);
    assert.match(history, /data && data\.contextOptions/);
    const pushStart = history.indexOf('modelList.push(');
    const pushEnd = history.indexOf(');', pushStart);
    assert.ok(pushStart >= 0 && pushEnd > pushStart, '未找到模型列表构造');
    assert.doesNotMatch(history.slice(pushStart, pushEnd), /contextLength/);
    assert.doesNotMatch(history, /model-item-ctx/);
});

test('当前模型项生成上下文 chips，并与思考 chips 共用两处下拉渲染', () => {
    assert.match(history, /function contextChipsHtml\(/);
    assert.match(history, /class="model-context-opts"/);
    assert.match(history, /class="model-context-chip/);
    assert.match(history, /data-context="/);
    assert.match(history, /app\.context_label/);
    assert.match(history, /thinkingChipsHtml\(\) \+ contextChipsHtml\(\)/);
    assert.match(history, /closest\('\.model-context-chip'\)/);
});

test('上下文选择先更新会话缓存，再 POST 到 context/select；新会话也会继承保存', () => {
    assert.match(history, /function selectContext\(contextLength\)/);
    const selectStart = history.indexOf('function selectContext(');
    const selectEnd = history.indexOf('\n}\n\n// Toggle dropdown', selectStart);
    const selectBlock = history.slice(selectStart, selectEnd);
    assert.match(selectBlock, /sessionContextMap\[sid\] = selected/);
    assert.match(selectBlock, /\/web\/chat\/context\/select/);
    assert.match(selectBlock, /contextLength: selected/);
    assert.match(history, /sessionContextMap\[newSessionId\] = contextLength/);
    assert.match(history, /contextLength: contextLength/);
});

test('模型设置页彻底移除模型上下文长度输入、解析和提交字段', () => {
    assert.doesNotMatch(modelSettings, /maxInputTokens/);
    assert.doesNotMatch(modelSettings, /model_context/);
    assert.doesNotMatch(modelSettings, /parseTokensInput/);
    assert.doesNotMatch(modelSettings, /formatTokensInput/);
    assert.doesNotMatch(modelSettings, /msManualModelTokens|msManualContextLengthList/);
    assert.doesNotMatch(modelSettings, /<datalist/i);
});

test('12 个语言包均提供 app.context_label 且 JSON 合法', () => {
    for (const lang of LOCALES) {
        const raw = readStatic('locales', `${lang}.json`);
        const json = JSON.parse(raw);
        assert.equal(typeof json.app.context_label, 'string', `${lang} 缺少 app.context_label`);
        assert.ok(json.app.context_label.trim().length > 0, `${lang} 的 app.context_label 为空`);
    }
});

// 选中态样式一致性：思考 chip 与上下文 chip 在同一模型项内紧邻渲染，
// 任一方式多出/缺少 border-color 都会让同一个「已选中」呈现两种视觉（回归 bug：1M 带蓝圈、超高只有底色）。
function cssRuleDeclarations(css, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}'));
    assert.ok(match, `app.css 缺少规则 ${selector}`);
    return match[1].split(';').map((s) => s.trim()).filter(Boolean).sort();
}

test('思考 chip 与上下文 chip 的选中态声明逐条一致', () => {
    const thinking = cssRuleDeclarations(appCss, '.model-thinking-chip.active');
    const context = cssRuleDeclarations(appCss, '.model-context-chip.active');
    assert.deepEqual(thinking, context, '两区选中态样式必须同款，否则同一「已选中」会出现两种视觉');
    assert.ok(thinking.includes('border-color: var(--accent)'), '选中态必须包含 accent 描边');
});

// 收起态的模型按钮必须同时展示思考档位与上下文窗口：只显示其中一个，
// 用户就无法在收起状态判断当前会话的上下文档位（回归 bug：抽屉里选了 1M，按钮上看不出来）。
test('模型按钮同时展示思考档位标签与上下文窗口标签', () => {
    assert.match(chatHtml, /id="welcomeModelThinkingTag"/);
    assert.match(chatHtml, /id="chatModelThinkingTag"/);
    assert.match(chatHtml, /class="model-context-tag" id="welcomeModelContextTag"/);
    assert.match(chatHtml, /class="model-context-tag" id="chatModelContextTag"/);

    assert.match(history, /\$\('#chatModelContextTag'\)\.text\(contextTagLabel\)/);
    assert.match(history, /\$\('#welcomeModelContextTag'\)\.text\(contextTagLabel\)/);
    assert.match(history, /var contextTagLabel = contextLengthLabel\(getSelectedContext\(\)\);/);
    assert.match(history, /app\.context_label/);

    assert.match(appCss, /\.model-selector-current \.model-context-tag \{/);
    // 标签位于按钮内模型名右侧，窄屏容器查询下与思考标签一同隐藏，避免只剩图标时溢出
    assert.match(codeCss, /\.model-selector-current \.model-context-tag,/);
});
