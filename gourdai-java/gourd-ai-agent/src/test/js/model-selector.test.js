const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticJs = path.resolve(__dirname, '../../main/resources/static/js');
const selector = require(path.join(staticJs, 'model-selector.js'));

/* ===================== 上下文窗口纯工具（与聊天页同口径） ===================== */

test('parseContextLengthValue：数字 / 256K / 1M / 非法输入', () => {
    assert.equal(selector.parseContextLengthValue(256000), 256000);
    assert.equal(selector.parseContextLengthValue('256K'), 256000);
    assert.equal(selector.parseContextLengthValue('1m'), 1000000);
    assert.equal(selector.parseContextLengthValue('512k'), 512000);
    assert.equal(selector.parseContextLengthValue('abc'), 0);
    assert.equal(selector.parseContextLengthValue(null), 0);
    assert.equal(selector.parseContextLengthValue(undefined), 0);
});

test('normalizeContextLength：未知值一律回落默认 256K', () => {
    assert.equal(selector.normalizeContextLength(1000000), 1000000);
    assert.equal(selector.normalizeContextLength('512K'), 512000);
    assert.equal(selector.normalizeContextLength(999), 256000);
    assert.equal(selector.normalizeContextLength(''), 256000);
    assert.equal(selector.normalizeContextLength(null), 256000);
    assert.equal(selector.DEFAULT_CONTEXT_LENGTH, 256000);
    assert.deepEqual(selector.CONTEXT_LENGTH_OPTIONS, [128000, 256000, 512000, 1000000]);
});

test('contextLengthLabel：固定四档短标签', () => {
    assert.equal(selector.contextLengthLabel(128000), '128K');
    assert.equal(selector.contextLengthLabel(256000), '256K');
    assert.equal(selector.contextLengthLabel(512000), '512K');
    assert.equal(selector.contextLengthLabel(1000000), '1M');
});

/* ===================== 思考档位工具 ===================== */

test('normalizeThinkingCode：off→auto、minimal→low 的历史值归一', () => {
    assert.equal(selector.normalizeThinkingCode('off'), 'auto');
    assert.equal(selector.normalizeThinkingCode('minimal'), 'low');
    assert.equal(selector.normalizeThinkingCode(null), 'auto');
    assert.equal(selector.normalizeThinkingCode('xhigh'), 'xhigh');
});

test('fallbackThinkingLevels：anthropic 系 5 档，其余 3 档', () => {
    assert.deepEqual(selector.fallbackThinkingLevels('anthropic'),
        ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual(selector.fallbackThinkingLevels('claude'),
        ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual(selector.fallbackThinkingLevels('openai'), ['low', 'medium', 'high']);
    assert.deepEqual(selector.fallbackThinkingLevels(''), ['low', 'medium', 'high']);
});

/* ===================== 模型行归一 ===================== */

test('normalizeRow：兼容 description / 字符串 / thinkingLevels 三态语义', () => {
    const a = selector.normalizeRow({ name: 'AWS-claude', description: '旗舰', provider: 'AWS' });
    assert.equal(a.desc, '旗舰');
    assert.equal(a.model, 'AWS-claude');
    assert.equal(a.thinkingLevels, null); // 未下发 → null（走兜底）

    const b = selector.normalizeRow({ name: 'X-y', thinkingLevels: [] });
    assert.deepEqual(b.thinkingLevels, []); // 明确不可调 → 保持空数组

    const c = selector.normalizeRow({ name: 'X-y', thinkingLevels: ['low', 'high'] });
    assert.deepEqual(c.thinkingLevels, ['low', 'high']);

    const d = selector.normalizeRow('bare-model');
    assert.equal(d.name, 'bare-model'); // 旧接口字符串项
    assert.equal(d.thinkingLevels, null);
});

/* ===================== 档位选项与 chips ===================== */

const rows = [
    { name: 'A-x', provider: 'A', standard: 'openai', thinkingLevels: ['low', 'high'] },
    { name: 'B-y', provider: 'B', standard: 'anthropic', thinkingLevels: null },
    { name: 'C-z', thinkingLevels: [] }
];

test('thinkingOptionsFor：auto 置顶 + 模型自身档位；null 走兜底、[] 仅剩 auto', () => {
    assert.deepEqual(selector.thinkingOptionsFor(rows, 'A-x').map((o) => o.value),
        ['auto', 'low', 'high']);
    assert.deepEqual(selector.thinkingOptionsFor(rows, 'B-y').map((o) => o.value),
        ['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual(selector.thinkingOptionsFor(rows, 'C-z').map((o) => o.value), ['auto']);
    // 未收录的模型名 → 按接口类型未知兜底（3 档）
    assert.deepEqual(selector.thinkingOptionsFor(rows, 'unknown').map((o) => o.value),
        ['auto', 'low', 'medium', 'high']);
});

test('thinkingChipsHtml：仅「默认」一项时返回空串（隐藏选择器），其余渲染 chips 且激活态正确', () => {
    assert.equal(selector.thinkingChipsHtml(rows, 'C-z', 'auto'), '');
    const html = selector.thinkingChipsHtml(rows, 'A-x', 'high');
    assert.ok(html.includes('class="model-thinking-opts"'));
    assert.ok(html.includes('data-thinking="high"'));
    assert.ok(html.includes('model-thinking-chip active'));
    assert.ok(html.includes('class="model-thinking-label"'));
});

test('contextChipsHtml：固定档位 chips，激活态跟随当前值（含未知值回落默认）', () => {
    const html = selector.contextChipsHtml(1000000);
    assert.equal(html.split('model-context-chip').length - 1, 4);
    assert.ok(html.includes('data-context="1000000"'));
    assert.ok(html.includes('model-context-chip active'));
    // 未知值 → 回落默认 256K 档
    const fallback = selector.contextChipsHtml(999);
    assert.ok(fallback.indexOf('class="model-context-chip active" data-context="256000"') >= 0);
});

test('thinkingTagLabel：默认档或不适用档不显示，命中档返回标签', () => {
    assert.equal(selector.thinkingTagLabel(rows, 'A-x', 'auto'), '');
    assert.equal(selector.thinkingTagLabel(rows, 'A-x', 'xhigh'), ''); // 不在档位集内
    assert.equal(selector.thinkingTagLabel(rows, 'A-x', 'high'), 'history.thinking.high.label');
});

/* ===================== 组件源码契约 ===================== */

test('公共选择器：集中承载下拉渲染/折叠/定位/隐藏语义，并向调用方暴露生命周期', () => {
    const src = fs.readFileSync(path.join(staticJs, 'model-selector.js'), 'utf8');
    // 集中调用公共下拉渲染器（自动化/ACP 不再各自重复）
    assert.match(src, /GourdModelDropdown\.render\(/);
    assert.match(src, /GourdModelDropdown\.setCollapsed\(/);
    assert.match(src, /if \(listEl && !GourdModelDropdown\.scrollToActive\(listEl\)\) listEl\.scrollTop = 0;/);
    // 无档位隐藏 / null-[] 语义 / 事件与生命周期
    assert.match(src, /if \(opts\.length <= 1\) return '';/);
    assert.match(src, /levels == null/);
    assert.match(src, /\?\s*[\w.\[\]]+\s*:\s*null/);
    assert.match(src, /\[object Array\]/);
    assert.match(src, /if \(cfg\.onOpen\) cfg\.onOpen\(\);/);
    assert.match(src, /\$\(document\)\.off\(ns\);/);
    assert.match(src, /instances\[i\] !== handle/);
    assert.match(src, /var handle = \{ update: render, destroy: destroy, close: closeSelf \};/);
});

test('自动化页接入公共选择器：短名展示、自身档位、上下文 chips 与保存/回填', () => {
    const auto = fs.readFileSync(path.join(staticJs, 'app-automation.js'), 'utf8');
    assert.match(auto, /GourdModelSelector\.create\(/);
    assert.match(auto, /GourdModelSelector\.thinkingOptionsFor\(formState\.models, name\)/);
    assert.match(auto, /id="autoModelContextTag"/);
    assert.match(auto, /onChange: function \(v\) \{ formState\.contextLength = v; \}/);
    // 保存与回填
    assert.match(auto, /contextLength: formState\.contextLength \|\| ''/);
    assert.match(auto, /formState\.contextLength = x\.contextLength \|\| '';/);
    // 任务列表卡片展示上下文档位标签
    assert.match(auto, /GourdModelSelector\.contextLengthLabel\(x\.contextLength\)/);
    // 失效模型展示回落（与运行时 getModelOrMain 兜底一致）
    assert.match(auto, /return formState\.defaultModel \|\| m;/);
});

test('ACP 页接入公共选择器：失效模型回退、上下文保存端点和状态接线', () => {
    const acp = fs.readFileSync(path.join(staticJs, 'app-settings-acp.js'), 'utf8');
    assert.match(acp, /GourdModelSelector\.create\(/);
    assert.match(acp, /GourdModelSelector\.normalizeRows\(info\.models \|\| \[\]\)/);
    assert.match(acp, /GourdModelSelector\.parseContextLengthValue\(info\.acpContextLength\)/);
    assert.match(acp, /class="model-context-tag"/);
    // 保存端点与字段
    assert.match(acp, /\/web\/settings\/acp\/context\/save/);
    assert.match(acp, /acpContextLength: value/);
    // 失效模型回退：current 不在列表时回落 defaultModel
    assert.match(acp, /return acpState\.defaultModel \|\| cur;/);
    // 三处保存函数均由组件回调驱动
    assert.match(acp, /onSelect: function \(name\) \{ saveAcpModel\(name\); \}/);
    assert.match(acp, /onChange: function \(v\) \{ saveAcpThinking\(v\); \}/);
    assert.match(acp, /onChange: function \(v\) \{ saveAcpContext\(v\); \}/);
});

/* ===================== i18n：上下文保存失败提示 12 语种齐备 ===================== */

test('12 个语言包均提供 settings.acp.context_save_failed 且行尾保持 CRLF 无 BOM', () => {
    const dir = path.resolve(staticJs, '../locales');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 12);
    for (const f of files) {
        const raw = fs.readFileSync(path.join(dir, f), 'utf8');
        assert.notEqual(raw.charCodeAt(0), 0xFEFF, `${f} 不应有 BOM`);
        assert.equal(raw.split('\r\n').join('').indexOf('\n'), -1, `${f} 不应含裸 LF`);
        const json = JSON.parse(raw.replace(/^\uFEFF/, ''));
        const v = json.settings && json.settings.acp && json.settings.acp.context_save_failed;
        assert.equal(typeof v, 'string', `${f} 缺少 settings.acp.context_save_failed`);
        assert.ok(v.length > 0, `${f} 的 context_save_failed 为空`);
    }
});
