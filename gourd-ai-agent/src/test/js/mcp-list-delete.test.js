/**
 * 契约测试：MCP 服务器列表行必须提供「删除」入口。
 *
 * 背景：列表行长期只有「编辑 + 启用开关」两个控件，删除入口只藏在编辑表单页里，
 * 很容易被误认为「只能禁用不能删除」。此测试锁定列表行删除按钮的结构与行为契约，
 * 同时保证 static 源与 tauri/ui 发布副本保持一致。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticJsDir = path.resolve(__dirname, '../../main/resources/static/js');
const source = fs
    .readFileSync(path.join(staticJsDir, 'app-settings-mcp.js'), 'utf8')
    .replace(/^\uFEFF/, '');

function sliceBetween(startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.ok(start >= 0, `未找到起始标记: ${startMarker}`);
    const end = source.indexOf(endMarker, start);
    assert.ok(end > start, `未找到结束标记: ${endMarker}`);
    return source.slice(start, end);
}

test('列表行渲染出删除按钮（含 data-name 与 i18n 标题）', () => {
    const renderer = sliceBetween('function renderMcpList(list) {', '// MCP 列表事件委托');
    assert.match(renderer, /var tDelete = GourdI18n\.t\('common\.delete'\);/);
    assert.match(
        renderer,
        /class="mcp-action-btn delete mcp-delete-btn" data-name="' \+ escapeAttr\(name\) \+ '" title="' \+ tDelete \+ '"/
    );
    // 删除按钮必须位于操作区内（与编辑按钮同容器、开关之前）
    const actions = renderer.indexOf('mcp-server-actions');
    const deleteBtn = renderer.indexOf('mcp-delete-btn');
    const toggle = renderer.indexOf('class="toggle-switch"');
    assert.ok(actions >= 0 && deleteBtn > actions, '删除按钮必须在 mcp-server-actions 容器内');
    assert.ok(toggle > deleteBtn, '删除按钮应排在启用开关之前');
});

test('列表行删除按钮走统一的确认 + 删除链路', () => {
    const delegation = sliceBetween('// MCP 列表事件委托', '// MCP 工具列表查看');
    assert.match(
        delegation,
        /\.on\('click', '\.mcp-delete-btn', function \(e\) \{\s*e\.stopPropagation\(\);\s*mcpConfirmRemoveServer\(\$\(this\)\.attr\('data-name'\)\);\s*\}\)/
    );
    // 行点击处理器必须排除操作按钮，避免点删除时误进工具列表
    assert.match(delegation, /if \(\$\(e\.target\)\.closest\('\.mcp-action-btn'\)\.length\) return;/);
});

test('确认弹窗单一来源：表单页删除按钮复用 mcpConfirmRemoveServer', () => {
    assert.match(
        source,
        /function mcpConfirmRemoveServer\(name\) \{\s*if \(!name\) return;\s*layConfirm\([\s\S]*?mcpRemoveServer\(name\);/
    );
    const formHandler = sliceBetween("$('#mcpFormDeleteBtn').on('click'", '// MCP 检测连接');
    assert.match(formHandler, /mcpConfirmRemoveServer\(mcpEditName\)/);
    assert.doesNotMatch(formHandler, /layConfirm\(/, '表单页不应重复内联确认弹窗');
});

test('删除接口与刷新链路保持可用', () => {
    assert.match(source, /postJson\('\/web\/settings\/mcp\/servers\/remove', \{ name: name \}/);
    assert.match(source, /if \(resp\.code === 200\) \{ showMcpListView\(\); loadMcpList\(\); \}/);
});

test('tauri/ui 发布副本与 static 源保持同步', () => {
    const mirrorPath = path.resolve(
        __dirname,
        '../../../gourd-ai-tauri/ui/js/app-settings-mcp.js'
    );
    if (!fs.existsSync(mirrorPath)) {
        return; // 副本不存在时跳过（例如仅检出 agent 模块）
    }
    const mirror = fs.readFileSync(mirrorPath, 'utf8').replace(/^\uFEFF/, '');
    assert.equal(mirror, source, 'gourd-ai-tauri/ui 副本已与 static 源不同步，请同步后再提交');
});
