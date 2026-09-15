const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
    path.resolve(__dirname, '../../main/resources/static/js/app-model-settings.js'),
    'utf8'
).replace(/^\uFEFF/, '');
const html = fs.readFileSync(
    path.resolve(__dirname, '../../main/resources/static/model-settings.html'),
    'utf8'
).replace(/^\uFEFF/, '');
const cssSettings = fs.readFileSync(
    path.resolve(__dirname, '../../main/resources/static/css/settings.css'),
    'utf8'
).replace(/^\uFEFF/, '');
const cssModelSettings = fs.readFileSync(
    path.resolve(__dirname, '../../main/resources/static/css/model-settings.css'),
    'utf8'
).replace(/^\uFEFF/, '');
const localesDir = path.resolve(__dirname, '../../main/resources/static/locales');
const LOCALES = ['zh-CN', 'zh-TW', 'en', 'de', 'el', 'es', 'fr', 'ja', 'pt', 'ro', 'ru', 'vi'];

test('模型行内渲染「设为默认」星标与「默认」徽标', () => {
    const start = source.indexOf('function renderModelsList()');
    const end = source.indexOf('function toggleProviderModel', start);
    assert.ok(start >= 0 && end > start, '未找到 renderModelsList 函数');
    const block = source.slice(start, end);
    assert.match(block, /provider-model-default-btn/, '缺少星标按钮渲染');
    assert.match(block, /provider-model-default-tag/, '缺少「默认」徽标渲染');
    assert.match(block, /llmDefaultModel === llmName/, '未按实际生效默认模型比对');
    assert.match(block, /set_default_model/, '星标 title 未走 i18n');
    assert.match(block, /default_badge/, '徽标文案未走 i18n');
});

test('点击星标调用默认模型端点：成功静默不弹 toast，失败提示原因', () => {
    const start = source.indexOf('function setDefaultModel(');
    const end = source.indexOf('// ==================== CRUD 操作', start);
    assert.ok(start >= 0 && end > start, '未找到 setDefaultModel 函数');
    const block = source.slice(start, end);

    assert.match(block, /postJson\('\/web\/settings\/llm\/models\/default', \{ name: llmName \}/, '未调用默认模型端点');

    const okIdx = block.indexOf('code === 200');
    const elseIdx = block.indexOf('} else {', okIdx);
    assert.ok(okIdx >= 0 && elseIdx > okIdx, '未找到成功/失败分支');
    const okBranch = block.slice(okIdx, elseIdx);
    assert.doesNotMatch(okBranch, /showToast/, '成功分支不得弹 toast（静默反馈）');
    assert.match(okBranch, /reloadModels/, '成功后应通知聊天组件刷新模型下拉');
    assert.match(okBranch, /renderModelsList/, '成功后应重绘模型列表（星标高亮）');
    assert.match(okBranch, /updateDefaultModelHint/, '成功后应刷新页头提示');

    const failBranch = block.slice(elseIdx);
    assert.match(failBranch, /showToast/, '失败分支应提示原因');
});

test('星标点击走事件委托且已是默认时幂等', () => {
    const start = source.indexOf("$modelsList.on('click', '.provider-model-default-btn'");
    assert.ok(start >= 0, '缺少星标点击事件委托');
    const block = source.slice(start, start + 600);
    assert.match(block, /llmDefaultModel/, '点击处理未做默认值判断');
    assert.match(block, /setDefaultModel\(llmName\)/, '点击处理未调用 setDefaultModel');
});

test('loadLlmModelsCache 缓存 effectiveDefault 并刷新页头提示', () => {
    const start = source.indexOf('function loadLlmModelsCache(');
    const end = source.indexOf('function renderModelsList', start);
    assert.ok(start >= 0 && end > start, '未找到 loadLlmModelsCache 函数');
    const block = source.slice(start, end);
    assert.match(block, /res\.data\.effectiveDefault/, '未缓存后端 effectiveDefault');
    assert.match(block, /updateDefaultModelHint/, '未刷新页头提示');
});

test('模型设置页头部提供默认模型提示容器（初始隐藏）', () => {
    const hintIdx = html.indexOf('id="msDefaultModelHint"');
    assert.ok(hintIdx >= 0, '缺少页头默认模型提示容器');
    assert.ok(html.indexOf('id="msDefaultModelHintText"') > hintIdx, '缺少提示文本节点');
    const tagStart = html.lastIndexOf('<', hintIdx);
    const tagEnd = html.indexOf('>', hintIdx);
    assert.match(html.slice(tagStart, tagEnd), /display:none/, '初始隐藏防闪烁');
});

test('星标/徽标/页头提示样式已定义', () => {
    assert.match(cssSettings, /\.provider-model-default-btn\s*\{/, '缺少星标按钮样式');
    assert.match(cssSettings, /\.provider-model-default-btn\.active/, '缺少星标高亮态样式');
    assert.match(cssSettings, /\.provider-model-default-tag\s*\{/, '缺少默认徽标样式');
    assert.match(cssModelSettings, /\.model-settings-default-hint\s*\{/, '缺少页头提示样式');
});

test('12 语言包含默认模型三键且行尾为纯 CRLF', () => {
    for (const l of LOCALES) {
        const raw = fs.readFileSync(path.join(localesDir, l + '.json'));
        const parsed = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
        const sp = parsed.settings.providers;
        for (const k of ['default_model_hint', 'set_default_model', 'default_badge']) {
            assert.ok(typeof sp[k] === 'string' && sp[k].length > 0, `${l} 缺少 settings.providers.${k}`);
        }
        const b = raw.toString('latin1');
        const crlf = (b.match(/\r\n/g) || []).length;
        const lf = (b.match(/\n/g) || []).length;
        assert.equal(lf - crlf, 0, `${l} 存在裸 LF 行尾`);
    }
});
