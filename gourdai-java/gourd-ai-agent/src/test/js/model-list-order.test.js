const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildEntries } = require('../../main/resources/static/js/model-list-order.js');

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
