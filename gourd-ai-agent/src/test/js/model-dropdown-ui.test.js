const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticJs = path.resolve(__dirname, '../../main/resources/static/js');

// localStorage 桩：模块通过 UMD 暴露，node 环境下无浏览器全局，折叠态读写需可控
const store = {};
global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
};

const md = require(path.join(staticJs, 'model-dropdown-ui.js'));
const { buildEntries } = require(path.join(staticJs, 'model-list-order.js'));

function resetStore() { Object.keys(store).forEach((k) => delete store[k]); }

const models = [
    { name: 'AWS-claude-sonnet-5', model: 'claude-sonnet-5', provider: 'AWS', desc: '通用旗舰' },
    { name: 'AWS-claude-opus-5', model: 'claude-opus-5', provider: 'AWS' },
    { name: 'OpenAI-gpt-5', model: 'gpt-5', provider: 'OpenAI' },
    { name: 'local-qwen', model: 'qwen3', provider: '' }
];

function renderWith(opts) {
    return md.render(Object.assign({
        segments: md.toSegments(buildEntries(models)),
        currentModel: 'AWS-claude-sonnet-5',
        currentProvider: 'AWS',
        otherLabel: '其他',
        emptyText: 'EMPTY',
        itemHtml: (m) => `<i data-model="${m.name}"></i>`
    }, opts || {}));
}

test('toSegments 保序分段，不跨段聚合', () => {
    const interleaved = [
        { name: 'A1', provider: 'A' },
        { name: 'B1', provider: 'B' },
        { name: 'A2', provider: 'A' }
    ];
    const segs = md.toSegments(buildEntries(interleaved));
    assert.deepEqual(segs.map((s) => s.provider), ['A', 'B', 'A']);
    assert.deepEqual(segs.map((s) => s.models.map((m) => m.name)), [['A1'], ['B1'], ['A2']]);
});

test('搜索命中模型名 / 模型 ID / 描述', () => {
    resetStore();
    assert.equal(renderWith({ query: 'opus' }).matched, 1);
    assert.equal(renderWith({ query: 'gpt-5' }).matched, 1);
    assert.equal(renderWith({ query: '旗舰' }).matched, 1);
});

test('搜索命中服务商时整组保留', () => {
    resetStore();
    const r = renderWith({ query: 'aws' });
    assert.equal(r.matched, 2);
    assert.ok(r.html.includes('AWS-claude-sonnet-5'));
    assert.ok(r.html.includes('AWS-claude-opus-5'));
});

test('多词按 AND 匹配', () => {
    resetStore();
    assert.equal(renderWith({ query: 'aws opus' }).matched, 1);
    assert.equal(renderWith({ query: 'aws gpt' }).matched, 0);
});

test('无命中时输出空态文案', () => {
    resetStore();
    const r = renderWith({ query: 'zzz-not-exist' });
    assert.equal(r.matched, 0);
    assert.ok(r.html.includes('EMPTY'));
});

test('服务商 >= 3 时默认只展开当前模型所在组', () => {
    resetStore();
    const r = renderWith({});
    // AWS 组展开、OpenAI 与「其他」组折叠
    const wraps = r.html.match(/<div class="model-dropdown-group-wrap[^"]*"/g);
    assert.equal(wraps.length, 3);
    assert.ok(!wraps[0].includes('collapsed'), 'AWS 组应展开');
    assert.ok(wraps[1].includes('collapsed'), 'OpenAI 组应折叠');
    assert.ok(wraps[2].includes('collapsed'), '其他组应折叠');
});

test('用户显式折叠态优先于默认策略且可持久化', () => {
    resetStore();
    md.setCollapsed('AWS', true);
    md.setCollapsed('OpenAI', false);
    const wraps = renderWith({}).html.match(/<div class="model-dropdown-group-wrap[^"]*"/g);
    assert.ok(wraps[0].includes('collapsed'), 'AWS 被显式折叠');
    assert.ok(!wraps[1].includes('collapsed'), 'OpenAI 被显式展开');
    assert.equal(JSON.parse(store[md.STORE_KEY]).AWS, true);
});

test('搜索期间忽略折叠态，命中组一律展开', () => {
    resetStore();
    md.setCollapsed('OpenAI', true);
    const r = renderWith({ query: 'gpt' });
    assert.equal(r.matched, 1);
    assert.ok(!r.html.includes('collapsed'), '搜索时不应有折叠组');
});

test('空 provider 组用 otherLabel 兜底且折叠态 key 不与真实 provider 冲突', () => {
    resetStore();
    const r = renderWith({ query: 'qwen' });
    assert.ok(r.html.includes('>其他<'));
    md.setCollapsed('', true);
    assert.equal(JSON.parse(store[md.STORE_KEY]).__other__, true);
});

test('firstModel 始终为具体模型名，无额外首项', () => {
    resetStore();
    // 三处选模器统一为「只列具体模型」（空值在各页展示层回落默认模型），
    // 渲染器不再支持插入非模型项；回车首选也因此永不会是空串
    assert.equal(renderWith({}).firstModel, 'AWS-claude-sonnet-5');
    assert.equal(renderWith({ query: 'gpt' }).firstModel, 'OpenAI-gpt-5');
    assert.equal(renderWith({ query: '不存在的模型' }).firstModel, null);
});

test('itemHtml 输出被转义拼接，组头带 provider 与计数', () => {
    resetStore();
    const html = renderWith({ query: 'aws' }).html;
    assert.ok(html.includes('data-provider="AWS"'));
    assert.ok(html.includes('<span class="model-group-count">2</span>'));
});

test('三处渲染均接入公共下拉模块', () => {
    const history = fs.readFileSync(path.join(staticJs, 'app-history.js'), 'utf8');
    const automation = fs.readFileSync(path.join(staticJs, 'app-automation.js'), 'utf8');
    const acp = fs.readFileSync(path.join(staticJs, 'app-settings-acp.js'), 'utf8');
    for (const src of [history, automation, acp]) {
        assert.match(src, /GourdModelDropdown\.render\(/);
        assert.match(src, /GourdModelDropdown\.setCollapsed\(/);
    }
    // 搜索框骨架：聊天页写在 chat.html，另两处由公共模块生成
    assert.match(automation, /GourdModelDropdown\.searchHtml\(/);
    assert.match(acp, /GourdModelDropdown\.searchHtml\(/);

    // ACP / 自动化已与会话页对齐：不再传 leading 首项，而是用 effectiveModel() 做展示层回落
    for (const src of [history, automation, acp]) {
        assert.doesNotMatch(src, /leading\s*:/, '不应再向公共渲染器传 leading 首项');
    }
    for (const src of [automation, acp]) {
        assert.match(src, /function effectiveModel\(\)/);
    }
    assert.doesNotMatch(md.render.toString(), /leading/, '渲染器已移除 leading 分支');

    const chatHtml = fs.readFileSync(path.resolve(staticJs, '../chat.html'), 'utf8');
    assert.match(chatHtml, /id="welcomeModelList"/);
    assert.match(chatHtml, /id="chatModelList"/);
    assert.equal((chatHtml.match(/class="model-search-input"/g) || []).length, 2);

    // 新模块必须在 app-history.js 之前加载
    const bootstrap = fs.readFileSync(path.join(staticJs, 'app-bootstrap.js'), 'utf8');
    assert.ok(bootstrap.indexOf('model-dropdown-ui.js') < bootstrap.indexOf('app-history.js'));
});

test('12 个语言包均补齐搜索/折叠文案键', () => {
    const dir = path.resolve(staticJs, '../locales');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 12);
    for (const f of files) {
        const json = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\uFEFF/, ''));
        for (const k of ['model_search_placeholder', 'model_search_empty', 'model_group_toggle']) {
            assert.equal(typeof json.history[k], 'string', `${f} 缺少 history.${k}`);
            assert.ok(json.history[k].length > 0, `${f} 的 history.${k} 为空`);
        }
    }
});
