const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
const history = readStatic('js', 'app-history.js');
const modelSettings = readStatic('js', 'app-model-settings.js');

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
