const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const STATIC_DIR = path.resolve(__dirname, '../../main/resources/static');
const jsSource = fs.readFileSync(path.join(STATIC_DIR, 'js/app-model-settings.js'), 'utf8').replace(/^\uFEFF/, '');
const htmlSource = fs.readFileSync(path.join(STATIC_DIR, 'model-settings.html'), 'utf8').replace(/^\uFEFF/, '');
const cssSource = fs.readFileSync(path.join(STATIC_DIR, 'css/model-settings.css'), 'utf8').replace(/^\uFEFF/, '');

/** 按函数名从 IIFE 源码中切出完整函数声明（花括号配平计数） */
function extractFunction(source, name) {
    const start = source.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('function not found: ' + name);
    let i = source.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) { end = i; break; }
        }
    }
    if (end < 0) throw new Error('unbalanced braces: ' + name);
    return source.slice(start, end + 1);
}

/** 把纯函数从页面脚本中抽出来跑真实行为（visibleModels 依赖两个模块级状态，以参数注入） */
const searchHarness = new Function(
    'fetchedModels', 'modelSearchQuery',
    extractFunction(jsSource, 'parseModelSearchTerms') + '\n' +
    extractFunction(jsSource, 'modelMatchesSearch') + '\n' +
    extractFunction(jsSource, 'visibleModels') + '\n' +
    'return { parseModelSearchTerms: parseModelSearchTerms, modelMatchesSearch: modelMatchesSearch, visibleModels: visibleModels };'
);

const fixtureModels = [
    { id: 'gpt-4o' },
    { id: 'gpt-4o-mini' },
    { id: 'claude-3-5-sonnet' },
    { id: 'Aionly-aws-opus' }
];

function visibleWith(query) {
    return searchHarness(fixtureModels, query).visibleModels().map((m) => m.id);
}

/* ===================== 行为：匹配口径与聊天模型下拉搜索一致 ===================== */

test('空关键词返回全量列表（顺序严格保持）', () => {
    assert.deepEqual(visibleWith(''), fixtureModels.map((m) => m.id));
    assert.deepEqual(visibleWith(null), fixtureModels.map((m) => m.id));
    assert.deepEqual(visibleWith('   '), fixtureModels.map((m) => m.id));
});

test('单关键词子串匹配 + 大小写不敏感', () => {
    assert.deepEqual(visibleWith('gpt'), ['gpt-4o', 'gpt-4o-mini']);
    assert.deepEqual(visibleWith('GPT-4O'), ['gpt-4o', 'gpt-4o-mini']);
    assert.deepEqual(visibleWith('Sonnet'), ['claude-3-5-sonnet']);
});

test('多关键词空格分词按 AND 匹配（「aws opus」两词都要命中）', () => {
    assert.deepEqual(visibleWith('gpt mini'), ['gpt-4o-mini']);
    assert.deepEqual(visibleWith('aws opus'), ['Aionly-aws-opus']);
    // 只命中一个词不算数
    assert.deepEqual(visibleWith('gpt zzz'), []);
});

test('零命中返回空数组，不抛异常', () => {
    assert.deepEqual(visibleWith('nonexistent'), []);
});

test('parseModelSearchTerms：小写化 + 空白分词 + 去首尾空白', () => {
    const api = searchHarness([], '');
    assert.deepEqual(api.parseModelSearchTerms('  AWS   opus '), ['aws', 'opus']);
    assert.deepEqual(api.parseModelSearchTerms(undefined), []);
    assert.deepEqual(api.parseModelSearchTerms('gpt-4o'), ['gpt-4o']);
});

test('缺 id 的模型条目不崩溃且不命中', () => {
    const api = searchHarness([{ id: null }, { id: 'gpt-4o' }, {}], 'gpt');
    assert.deepEqual(api.visibleModels().map((m) => m.id), ['gpt-4o']);
    assert.equal(api.modelMatchesSearch({ id: null }, ['x']), false);
});

/* ===================== 契约：HTML 结构 ===================== */

test('HTML：模型管理标题行内联搜索框 + 一键清除按钮', () => {
    const header = htmlSource.match(/<div class="form-group-header">[\s\S]*?<\/div>\s*<div class="provider-model-header-actions">/);
    assert.ok(header, '未找到模型管理标题行');
    assert.match(header[0], /id="msModelSearchInput"/);
    assert.match(header[0], /data-i18n-placeholder="settings\.providers\.search_placeholder"/);
    assert.match(header[0], /id="msModelSearchClear"/);
    assert.match(header[0], /class="ms-model-search"/);
});

test('HTML：无命中空态元素（与「暂无模型」区分）', () => {
    assert.match(htmlSource, /id="msProviderModelsSearchEmpty"[^>]*data-i18n="settings\.providers\.search_no_result"/);
    assert.match(htmlSource, /id="msProviderModelsSearchEmpty"[^>]*style="display:none"/);
});

/* ===================== 契约：交互与状态复位 ===================== */

test('输入 150ms 防抖后才过滤渲染', () => {
    const start = jsSource.indexOf("$searchInput.on('input'");
    const end = jsSource.indexOf('});', start);
    const block = jsSource.slice(start, end);
    assert.ok(start >= 0, '未找到搜索输入绑定');
    assert.match(block, /clearTimeout\(modelSearchTimer\)/);
    assert.match(block, /modelSearchQuery = val;/);
    assert.match(block, /\}, 150\)/);
});

test('renderModelsList 渲染过滤结果而非全量列表', () => {
    const start = jsSource.indexOf('function renderModelsList()');
    const end = jsSource.indexOf('function toggleProviderModel', start);
    const block = jsSource.slice(start, end);
    assert.ok(start >= 0 && end > start, '未找到 renderModelsList 函数');
    assert.match(block, /var models = visibleModels\(\);/);
    assert.match(block, /models\.forEach\(function \(model\)/);
    assert.doesNotMatch(block, /fetchedModels\.forEach/);
});

test('零命中显示「未找到」空态并隐藏列表；无模型显示原「暂无模型」空态', () => {
    const start = jsSource.indexOf('function renderModelsList()');
    const end = jsSource.indexOf('function toggleProviderModel', start);
    const block = jsSource.slice(start, end);
    assert.match(block, /\$searchEmpty\.show\(\);\s*\n\s*\$modelsList\.hide\(\);/);
    assert.match(block, /fetchedModels\.length === 0[\s\S]*\$modelsEmpty\.show\(\);/);
    // 搜索框随空列表收起、有模型时恢复
    assert.match(block, /\$searchBox\.toggle\(fetchedModels\.length > 0\)/);
});

test('批量全选/全不选/反选只作用于可见（过滤后）行', () => {
    const start = jsSource.indexOf("$('#msProviderModelsSelectAll, #msProviderModelsSelectNone, #msProviderModelsInvert')");
    // 切到第一个 });（即内部 .each(function(){...}) 的收尾）——已包含 $modelsList.find 断言目标
    const end = jsSource.indexOf('});', start);
    const block = jsSource.slice(start, end);
    assert.ok(start >= 0, '未找到批量选择处理器');
    assert.match(block, /\$modelsList\.find\('\.provider-model-toggle'\)/);
});

test('供应商真正切换时清空搜索词，同供应商重渲染保留', () => {
    const start = jsSource.indexOf('function renderDetailForm(provider)');
    const end = jsSource.indexOf('function openModelDialog', start);
    const block = jsSource.slice(start, end);
    assert.ok(start >= 0, '未找到 renderDetailForm 函数');
    assert.match(block, /var providerKey = provider \? provider\.name : '__add__';/);
    assert.match(block, /if \(providerKey !== modelSearchProviderKey\) \{\s*\n\s*clearModelSearch\(false\);/);
});

test('关闭视图时清空搜索并复位供应商键', () => {
    const start = jsSource.indexOf('function closeModelSettings()');
    const end = jsSource.indexOf('function', start + 10);
    const block = jsSource.slice(start, end);
    assert.ok(start >= 0, '未找到 closeModelSettings 函数');
    assert.match(block, /clearModelSearch\(false\);/);
    assert.match(block, /modelSearchProviderKey = null;/);
});

test('一键清除按钮绑定 clearModelSearch(true) 立即重绘', () => {
    assert.match(jsSource, /\$searchClear\.on\('click', function \(\) \{\s*\n\s*clearModelSearch\(true\);/);
});

/* ===================== 契约：样式 ===================== */

test('CSS：搜索框自适应宽度、聚焦高亮、清除按钮', () => {
    assert.match(cssSource, /\.ms-model-search \{\s*\n[^}]*flex: 1 1 auto;/);
    assert.match(cssSource, /\.ms-model-search input:focus \{ border-color: var\(--accent\); \}/);
    assert.match(cssSource, /\.ms-model-search-clear:hover \{ background: var\(--bg-hover\); color: var\(--text-primary\); \}/);
});

/* ===================== 契约：12 语言包 ===================== */

test('全部 12 个语言包包含 search_placeholder / search_no_result', () => {
    const localeDir = path.join(STATIC_DIR, 'locales');
    const files = fs.readdirSync(localeDir).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 12, '语言包数量应为 12');
    for (const file of files) {
        const pack = JSON.parse(fs.readFileSync(path.join(localeDir, file), 'utf8'));
        const ph = pack.settings.providers.search_placeholder;
        const nr = pack.settings.providers.search_no_result;
        assert.ok(typeof ph === 'string' && ph.trim().length > 0, file + ' 缺 search_placeholder');
        assert.ok(typeof nr === 'string' && nr.trim().length > 0, file + ' 缺 search_no_result');
        assert.notEqual(ph, nr, file + ' 两键文案不应相同');
    }
});
