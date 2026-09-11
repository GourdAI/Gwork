const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
    path.resolve(__dirname, '../../main/resources/static/js/app-model-settings.js'),
    'utf8'
).replace(/^\uFEFF/, '');

test('供应商删除成功后立即刷新聊天模型列表', () => {
    const start = source.indexOf('function deleteProvider()');
    const end = source.indexOf('function toggleProvider', start);
    assert.ok(start >= 0 && end > start, '未找到 deleteProvider 函数');
    const block = source.slice(start, end);
    assert.match(block, /if \(res\.code === 200\)[\s\S]*typeof window\.reloadModels === 'function'[\s\S]*window\.reloadModels\(\)/);
});
