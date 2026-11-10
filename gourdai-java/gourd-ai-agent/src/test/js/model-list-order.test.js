const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildEntries, groupKeyOf } = require('../../main/resources/static/js/model-list-order.js');

function renderedModelNames(models) {
    return buildEntries(models)
        .filter((entry) => entry.type === 'model')
        .map((entry) => entry.model.name);
}

const interleavedModels = [
    { name: 'A1', provider: 'A' },
    { name: 'B1', provider: 'B' },
    { name: 'A2', provider: 'A' }
];

test('chat model dropdown preserves interleaved provider order', () => {
    assert.deepEqual(renderedModelNames(interleavedModels), ['A1', 'B1', 'A2']);
    assert.deepEqual(
        buildEntries(interleavedModels).map((entry) => entry.type === 'model' ? entry.model.name : `provider:${entry.provider}`),
        ['provider:A', 'A1', 'provider:B', 'B1', 'provider:A', 'A2']
    );
});

/* 同一渠道（providerId 相同）但展示名漂移过：只能分段一次，
   否则会多渲染一个标题 —— 即用户报的「同一服务商重复」。 */
const sameChannelStaleNames = [
    { name: 'AiOnly-m1', provider: 'AiOnly', providerId: 'chan1' },
    { name: 'AiOnly-m2', provider: 'StaleName', providerId: 'chan1' },
    { name: 'AiOnly-m3', provider: 'AiOnly-雪峰', providerId: 'chan1' }
];

/* 两个渠道共用同一展示名（同 URL 多密钥）：必须分成两段，不得误并。 */
const distinctChannelsSameName = [
    { name: 'A-m1', provider: 'AiOnly', providerId: 'chan1' },
    { name: 'B-m1', provider: 'AiOnly', providerId: 'chan2' }
];

test('grouping key prefers channel id over display name', () => {
    assert.equal(groupKeyOf({ provider: 'AiOnly', providerId: 'chan1' }), 'chan1');
    assert.equal(groupKeyOf({ provider: 'AiOnly' }), 'AiOnly');
    assert.equal(groupKeyOf({ providerId: 'chan1' }), 'chan1');
    assert.equal(groupKeyOf({}), '');
});

test('stale display names within one channel do not create a duplicate header', () => {
    const headers = buildEntries(sameChannelStaleNames)
        .filter((entry) => entry.type === 'provider')
        .map((entry) => entry.provider);
    // 一个渠道 = 一个标题（取首个模型的展示名）
    assert.deepEqual(headers, ['AiOnly']);
    // 三个模型都在该段内
    assert.deepEqual(renderedModelNames(sameChannelStaleNames), ['AiOnly-m1', 'AiOnly-m2', 'AiOnly-m3']);
});

test('two channels sharing a display name stay separate segments', () => {
    const headers = buildEntries(distinctChannelsSameName)
        .filter((entry) => entry.type === 'provider')
        .map((entry) => entry.key);
    assert.deepEqual(headers, ['chan1', 'chan2']);
});

test('legacy models without providerId keep grouping by display name', () => {
    const legacy = [
        { name: 'A1', provider: 'A' },
        { name: 'B1', provider: 'B' },
        { name: 'A2', provider: 'A' }
    ];
    assert.deepEqual(
        buildEntries(legacy).map((e) => e.type === 'model' ? e.model.name : `provider:${e.provider}`),
        ['provider:A', 'A1', 'provider:B', 'B1', 'provider:A', 'A2']
    );
});

test('chat and automation renderers both use the shared order-preserving entries', () => {
    const staticJs = path.resolve(__dirname, '../../main/resources/static/js');
    const historySource = fs.readFileSync(path.join(staticJs, 'app-history.js'), 'utf8');
    const automationSource = fs.readFileSync(path.join(staticJs, 'app-automation.js'), 'utf8');
    const selectorSource = fs.readFileSync(path.join(staticJs, 'model-selector.js'), 'utf8');

    assert.match(historySource, /ModelListOrder\.buildEntries\(modelList\)/);
    // 自动化页经公共选择器消费同一保序分段逻辑（组件内部对 models() 结果调用 buildEntries）
    assert.match(automationSource, /GourdModelSelector\.create\(/);
    assert.match(selectorSource, /ModelListOrder\.buildEntries\(models\)/);
    assert.deepEqual(renderedModelNames(interleavedModels), ['A1', 'B1', 'A2']);
});
