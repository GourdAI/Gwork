// 模型配置页「删除类提示词」契约测试。
//
// 背景：三个删除入口的确认文案曾用多段 i18n 词条字符串拼接造句，
// 中文产出「确认删除？模型管理？手动添加模型删除」这种不成句碎片；
// 德/英/日等语序不同又无空格分隔，粘连成「Confirm delete?Model Management？Add ModelDelete」。
// 其中删除服务商还错用了 add_title（「添加服务商」）词条，且后端是级联删除
// （removeProviderCascade 会连带删除该供应商名下全部模型），旧文案对影响范围零提示。
//
// 本测试用「整句式 key + 占位符」的结构约束把它们钉死，防止回退到拼接写法。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const JS_PATH = path.join(ROOT, 'main/resources/static/js/app-model-settings.js');
const LOCALE_DIR = path.join(ROOT, 'main/resources/static/locales');

const source = fs.readFileSync(JS_PATH, 'utf8').replace(/^\uFEFF/, '');

const LOCALES = fs.readdirSync(LOCALE_DIR).filter(f => f.endsWith('.json')).sort();

function loadLocale(name) {
    return JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, name), 'utf8'));
}

function get(obj, keyPath) {
    return keyPath.split('.').reduce((o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined), obj);
}

function sliceFn(name, nextName) {
    const start = source.indexOf('function ' + name);
    assert.ok(start >= 0, '未找到函数 ' + name);
    const end = nextName ? source.indexOf('function ' + nextName, start) : source.length;
    assert.ok(end > start, '未找到函数 ' + name + ' 的结束边界');
    return source.slice(start, end);
}

// ---------------------------------------------------------------------------
// 1. 源码层面：三个删除入口必须使用整句式 key，且不得再拼接造句
// ---------------------------------------------------------------------------

test('清空模型列表确认框使用整句式 key，且不再拼接 confirm_delete/model_management/add_model', () => {
    const start = source.indexOf("$('#msProviderClearModelsBtn')");
    assert.ok(start >= 0, '未找到清空模型列表按钮绑定');
    const end = source.indexOf('// 手动添加模型', start);
    assert.ok(end > start, '未找到清空模型列表绑定结束边界');
    const block = source.slice(start, end);

    assert.match(block, /GourdI18n\.t\('settings\.providers\.clear_models_confirm',\s*\[fetchedModels\.length\]\)/,
        '清空确认框应使用带数量的整句式 key');
    assert.doesNotMatch(block, /settings\.confirm_delete/, '不得再使用 confirm_delete 词条拼接');
    assert.doesNotMatch(block, /settings\.providers\.add_model/, '删除场景不得引用「手动添加模型」词条');
});

test('删除服务商确认框使用整句式 key，且不得引用 add_title（添加服务商）词条', () => {
    const block = sliceFn('deleteProvider', 'toggleProvider');

    assert.match(block, /settings\.providers\.delete_provider_confirm/,
        '应使用 delete_provider_confirm 整句式 key');
    assert.match(block, /settings\.providers\.delete_provider_confirm_no_models/,
        '应提供无模型时的确认文案分支');
    assert.doesNotMatch(block, /settings\.providers\.add_title/,
        '删除场景引用「添加服务商」词条会把动词写成「添加」');
    assert.doesNotMatch(block, /settings\.confirm_delete/,
        '不得再使用 confirm_delete 词条拼接');
});

test('删除服务商确认框必须提示级联删除的模型数量（后端为 removeProviderCascade）', () => {
    const block = sliceFn('deleteProvider', 'toggleProvider');

    // 必须从 currentProvider.models 取真实数量并作为占位符参数传入
    assert.match(block, /currentProvider\.models[\s\S]{0,80}length/,
        '确认框需统计该供应商名下模型数量');
    assert.match(block, /delete_provider_confirm',\s*\[currentProvider\.name,\s*modelCount\]/,
        '级联数量必须作为第二个占位符参数传入');
});

test('删除单个手动模型必须有二次确认（此前点一下即移除并写库）', () => {
    const start = source.indexOf("'.provider-model-remove-btn'");
    assert.ok(start >= 0, '未找到单模型删除按钮绑定');
    const end = source.indexOf("'.provider-model-default-btn'", start);
    assert.ok(end > start, '未找到单模型删除绑定结束边界');
    const block = source.slice(start, end);

    assert.match(block, /layConfirm\(/, '删除单个模型必须弹确认框');
    assert.match(block, /settings\.providers\.remove_model_confirm/, '确认框应使用 remove_model_confirm 整句式 key');
    assert.match(block, /\[modelId\]/, '确认文案应带出模型 ID');

    // 确认后才执行删除：layConfirm 回调内才是 removeManualModel
    const confirmIdx = block.indexOf('layConfirm(');
    const removeIdx = block.indexOf('removeManualModel(');
    assert.ok(confirmIdx >= 0 && removeIdx > confirmIdx,
        'removeManualModel 必须位于 layConfirm 回调内（确认后才删）');
});

test('模型配置页不再存在「多段 i18n 词条直接相加造句」的残留写法', () => {
    // 匹配形如 GourdI18n.t('a') + GourdI18n.t('b') 或 GourdI18n.t('a') + '...' + GourdI18n.t('b')
    const concatRe = /GourdI18n\.t\([^)]*\)\s*\+\s*(?:'[^']*'\s*\+\s*)?GourdI18n\.t\(/g;
    const hits = (source.match(concatRe) || []);
    assert.deepEqual(hits, [],
        '发现拼接造句残留：\n' + hits.join('\n'));
});

// ---------------------------------------------------------------------------
// 2. 语言包层面：新增 key 必须齐全、带正确占位符、且不再是碎片拼接
// ---------------------------------------------------------------------------

const REQUIRED_KEYS = [
    'settings.providers.clear_models_confirm',
    'settings.providers.delete_provider_confirm',
    'settings.providers.delete_provider_confirm_no_models',
    'settings.providers.remove_model_confirm',
    'settings.providers.load_providers_failed',
    'settings.providers.edit_model_title',
    'settings.providers.fetch_models_failed',
    'settings.providers.model_exists_named',
    'settings.providers.field_required',
    'settings.providers.model_count'
];

test('12 个语言包全部提供新增的整句式 key（不允许回落或缺失）', () => {
    assert.equal(LOCALES.length, 12, '语言包数量应为 12，实际 ' + LOCALES.length);

    const missing = [];
    for (const loc of LOCALES) {
        const j = loadLocale(loc);
        for (const key of REQUIRED_KEYS) {
            const v = get(j, key);
            if (typeof v !== 'string' || !v.trim()) missing.push(loc + ' -> ' + key);
        }
    }
    assert.deepEqual(missing, [], '缺失的 key：\n' + missing.join('\n'));
});

test('带占位符的 key 在每种语言中都保留了对应占位符（防止翻译时丢参）', () => {
    const placeholderMap = {
        'settings.providers.clear_models_confirm': ['{0}'],
        'settings.providers.delete_provider_confirm': ['{0}', '{1}'],
        'settings.providers.delete_provider_confirm_no_models': ['{0}'],
        'settings.providers.remove_model_confirm': ['{0}'],
        'settings.providers.model_exists_named': ['{0}'],
        'settings.providers.field_required': ['{0}'],
        'settings.providers.model_count': ['{0}']
    };

    const problems = [];
    for (const loc of LOCALES) {
        const j = loadLocale(loc);
        for (const [key, tokens] of Object.entries(placeholderMap)) {
            const v = get(j, key);
            if (typeof v !== 'string') continue; // 缺失由上一个用例负责
            for (const tk of tokens) {
                if (!v.includes(tk)) problems.push(loc + ' -> ' + key + ' 缺少 ' + tk);
            }
        }
    }
    assert.deepEqual(problems, [], '占位符丢失：\n' + problems.join('\n'));
});

test('删除类确认文案是完整句式，而非碎片拼接产物（不含连续问号等拼接痕迹）', () => {
    const problems = [];
    const keys = [
        'settings.providers.clear_models_confirm',
        'settings.providers.delete_provider_confirm',
        'settings.providers.delete_provider_confirm_no_models',
        'settings.providers.remove_model_confirm'
    ];

    for (const loc of LOCALES) {
        const j = loadLocale(loc);
        for (const key of keys) {
            const v = get(j, key);
            if (typeof v !== 'string') continue;
            if (/[?？]\s*[?？]/.test(v)) problems.push(loc + ' -> ' + key + ' 出现连续问号: ' + v);
            // 拼接产物的特征：问号后直接紧跟拉丁大写字母（如 Confirm delete?Model Management）。
            // 中文/日文「？其」「？配」这类紧邻是正常写法，不在此列。
            if (/[?？][A-Z]/.test(v)) problems.push(loc + ' -> ' + key + ' 疑似粘连: ' + v);
        }
    }
    assert.deepEqual(problems, [], '文案结构异常：\n' + problems.join('\n'));
});

test('语言包保持 CRLF 行尾且不含裸 LF（仓库行尾契约）', () => {
    const bad = [];
    for (const loc of LOCALES) {
        const s = fs.readFileSync(path.join(LOCALE_DIR, loc), 'utf8');
        const bareLF = (s.match(/(?<!\r)\n/g) || []).length;
        if (bareLF > 0) bad.push(loc + ': ' + bareLF + ' 个裸 LF');
    }
    assert.deepEqual(bad, [], '行尾异常：\n' + bad.join('\n'));
});

test('语言包均为合法 JSON 且格式未被整体重排（键序稳定、无 BOM）', () => {
    for (const loc of LOCALES) {
        const p = path.join(LOCALE_DIR, loc);
        const raw = fs.readFileSync(p);
        assert.notEqual(raw[0], 0xEF, loc + ' 不应带 BOM');
        const s = raw.toString('utf8');
        assert.doesNotThrow(() => JSON.parse(s), loc + ' 不是合法 JSON');
        // 仓库约定缩进后跟两个空格再跟值
        assert.match(s, /"clear_models_confirm":  "/, loc + ' 插入格式与仓库约定不一致');
    }
});
