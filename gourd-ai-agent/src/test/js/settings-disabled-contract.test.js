/**
 * 契约测试：禁用条目置灰 + toggle 刷新全模块对齐（上游 8ea79ac2）。
 *
 * 覆盖：
 * - MCP/LSP/OpenAPI 列表项在 disabled 时添加 `disabled` 类（整行置灰）
 * - CSS：.mcp-server-item.disabled 与 .mcp-server-icon 变体规则
 * - LSP/OpenAPI toggle 后刷新列表（无论成败，确保与服务端一致）
 * - tauri/ui 发布副本与 static 源同步（3 个 JS + settings.css）
 *
 * 背景：上游 8ea79ac2「为禁用的MCP/LSP/Mounts/OpenAPI条目添加disabled样式并在toggle成功后
 * 重新加载列表」在 MCP 升级包（方案一 F 组）中仅完成了 MCP 的 toggle 刷新，本测试锁定补齐后的契约。
 * Mounts 模块已随挂载点功能整体移除（TalentRegistry 改造），相关用例同步删除。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');

function readStatic(...segs) {
    return fs.readFileSync(path.join(staticRoot, ...segs), 'utf8').replace(/^\uFEFF/, '');
}

function sliceBetween(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.ok(start >= 0, `未找到起始标记: ${startMarker}`);
    const end = source.indexOf(endMarker, start);
    assert.ok(end > start, `未找到结束标记: ${endMarker}`);
    return source.slice(start, end);
}

// ====================================================================
// disabled 置灰类（四模块 render）
// ====================================================================

test('MCP：列表项渲染支持 disabled 置灰（renderMcpList）', () => {
    const js = readStatic('js', 'app-settings-mcp.js');
    assert.match(
        js,
        /html \+= '<div class="mcp-server-item' \+ \(item\.enabled === false \? ' disabled' : ''\) \+ '" data-name="' \+ escapeAttr\(name\) \+ '">'/
    );
});

test('LSP / OpenAPI：列表项渲染支持 disabled 置灰', () => {
    const lsp = readStatic('js', 'app-settings-lsp.js');
    const openapi = readStatic('js', 'app-settings-openapi.js');
    const needle = /html \+= '<div class="mcp-server-item' \+ \(item\.enabled === false \? ' disabled' : ''\) \+ '" data-name="' \+ escapeAttr\(name\) \+ '">'/;
    assert.match(lsp, needle);
    assert.match(openapi, needle);
});


test('CSS：.mcp-server-item.disabled 置灰规则存在（含图标变体）', () => {
    const css = readStatic('css', 'settings.css');
    assert.match(css, /\.mcp-server-item\.disabled \{ opacity: 0\.5; \}/);
    assert.match(css, /\.mcp-server-item\.disabled \.mcp-server-icon \{ opacity: 0\.5; \}/);
});

// ====================================================================
// toggle 刷新（LSP / OpenAPI）
// ====================================================================

test('LSP：toggle 无论成败都刷新列表', () => {
    const js = readStatic('js', 'app-settings-lsp.js');
    const fn = sliceBetween(js, 'function lspToggleServer', '// LSP 按钮事件');
    assert.match(fn, /\/\/ 无论成败都刷新列表，确保开关状态与服务端一致/);
    assert.match(fn, /loadLspList\(\);/);
    assert.doesNotMatch(fn, /'error'\); loadLspList\(\);/, '不应回到「仅失败时刷新」旧写法');
});

test('OpenAPI：toggle 无论成败都刷新列表', () => {
    const js = readStatic('js', 'app-settings-openapi.js');
    const fn = sliceBetween(js, 'function openapiToggleServer', '// OpenApi 按钮事件');
    assert.match(fn, /\/\/ 无论成败都刷新列表，确保开关状态与服务端一致/);
    assert.match(fn, /loadOpenapiList\(\);/);
    assert.doesNotMatch(fn, /'error'\); loadOpenapiList\(\);/, '不应回到「仅失败时刷新」旧写法');
});


// ====================================================================
// tauri/ui 发布副本同步
// ====================================================================

test('tauri/ui 发布副本与 static 源保持同步（本批 5 个文件）', (t) => {
    const files = [
        ['js', 'app-settings-mcp.js'],
        ['js', 'app-settings-lsp.js'],
        ['js', 'app-settings-openapi.js'],
        ['css', 'settings.css']
    ];

    // 防两种假象：
    //  ① 历史版本把镜像根写成 '../../../'（__dirname=gourd-ai-agent/src/test/js，3 级只到
    //     模块根，拼出 gourd-ai-agent/gourd-ai-tauri/ui），再配“不存在就 continue” 变成
    //     永远静默通过 —— 从未真正比对过任何文件。
    //  ② 反过来“断言同级模块必须存在”会在稀疏检出（只拉 gourd-ai-agent）时假红。
    // 对策：先自证【路径算术】。用同一份相对基准同时算出 staticRoot 与 repoRoot，
    // 两者必须指向同一个 gourd-ai-agent；路径层数算错时这个断言必失败。
    const repoRoot = path.resolve(__dirname, '../../../..');
    assert.equal(
        path.join(repoRoot, 'gourd-ai-agent'),
        path.resolve(staticRoot, '../../../..'),
        `镜像路径算术错误：从 test/js 向上四级得 ${repoRoot}，加 gourd-ai-agent 后与 staticRoot 不同源`
    );

    const mirrorRoot = path.join(repoRoot, 'gourd-ai-tauri', 'ui');
    if (!fs.existsSync(mirrorRoot)) {
        // ui/ 是 prepare-ui.js 生成的构建产物（已 gitignore），干净检出时本就不存在。
        // 用 node:test 的 skip 而非 return：报告里会显式出现 SKIP + 原因，不伪装成 PASS。
        t.skip('镜像目录不存在（gourd-ai-tauri/ui 由 cmd/prepare-ui.js 生成且已 gitignore）');
        return;
    }

    for (const segs of files) {
        const mirrorPath = path.join(mirrorRoot, ...segs);
        assert.ok(fs.existsSync(mirrorPath), '镜像文件缺失: ' + segs.join('/'));
        const source = fs.readFileSync(path.join(staticRoot, ...segs));
        const mirror = fs.readFileSync(mirrorPath);
        assert.ok(
            source.equals(mirror),
            `gourd-ai-tauri/ui 副本已与 static 源不同步：${segs.join('/')}，请同步后再提交`
        );
    }
});
