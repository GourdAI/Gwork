/**
 * 契约测试：MCP 模块升级包（对齐 soloncode 上游 v2026.9.15 的 MCP 增强）。
 *
 * 覆盖：
 * - A：McpTypeResolver 类型别名标准化（local/http/remote/sse-http/streamable-http、streamable_stateless）
 * - B：JSON 字符串导入（后端 /import/parse/string 端点 + 前端导入下拉菜单与粘贴对话框）
 * - D：tools/save 空值防御（null → emptyList）
 * - E：连接检测 HTTP 分支使用 listTools()+doOnError 错误链
 * - F：细节组（toggle 成功后刷新、检测超时专用提示、撤销导入统一 layConfirm、空状态文案）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const javaRoot = path.resolve(__dirname, '../../main/java');
const LOCALES = ['de', 'el', 'en', 'es', 'fr', 'ja', 'pt', 'ro', 'ru', 'vi', 'zh-CN', 'zh-TW'];

function readStatic(...segs) {
    return fs.readFileSync(path.join(staticRoot, ...segs), 'utf8').replace(/^\uFEFF/, '');
}
function readJava(...segs) {
    return fs.readFileSync(path.join(javaRoot, ...segs), 'utf8').replace(/^\uFEFF/, '');
}

// ====================================================================
// A：McpTypeResolver
// ====================================================================

test('A: McpTypeResolver 覆盖全部上游别名（含 streamable_stateless）', () => {
    const src = readJava('com/gourdai/core/config/McpTypeResolver.java');
    for (const alias of ['stdio', 'local', 'sse', 'ssehttp', 'sse_http', 'sse-http', 'streamable', 'streamablehttp', 'streamable_http', 'streamable-http', 'http', 'remote', 'streamable_stateless']) {
        assert.ok(src.includes('"' + alias + '"'), `缺少别名: ${alias}`);
    }
    assert.match(src, /McpChannel\.STREAMABLE_STATELESS/);
});

test('A: 控制器 list/add/update/check 均接入 McpTypeResolver', () => {
    const src = readJava('com/gourdai/core/portal/web/WebSettingsController.java');
    // list：stdio 判断改走 resolver
    assert.match(src, /McpTypeResolver\.isStdio\(params\.getTypeOrTransport\(\)\)/);
    // add：先标准化再校验，非法类型报 Unsupported type
    assert.match(src, /String rawType = root\.get\("type"\)\.getString\(\);\s*String type = McpTypeResolver\.standardize\(rawType\);/);
    assert.match(src, /if \(!McpTypeResolver\.isValid\(type\)\) \{\s*return Result\.failure\("Unsupported type: " \+ rawType\);/);
    // update：无法识别请求值时回落到已有配置
    assert.match(src, /type = McpTypeResolver\.standardize\(existing\.getTypeOrTransport\(\)\)/);
    // add 与 update 均需 isValid 校验（防止非法类型/空壳配置落库）
    const validChecks = src.match(/if \(!McpTypeResolver\.isValid\(type\)\) \{/g) || [];
    assert.equal(validChecks.length, 2, 'add 与 update 都应校验类型合法性');
    // update 的类型校验必须发生在摘除引擎实例之前（避免半程状态）
    const updStart = src.indexOf('public Result mcpServersUpdate');
    const updEnd = src.indexOf('public Result mcpServersToggle');
    const upd = src.slice(updStart, updEnd);
    const validIdx = upd.indexOf('if (!McpTypeResolver.isValid(type))');
    const removeIdx = upd.indexOf('engine.removeMcpServer(lookupName)');
    assert.ok(validIdx >= 0 && validIdx < removeIdx, 'update 应先校验类型再摘除引擎实例');
    // 分支统一
    assert.match(src, /if \(McpTypeResolver\.isStdio\(type\)\) \{/);
    assert.match(src, /} else if \(McpTypeResolver\.isHttpType\(type\)\) \{/);
});

// ====================================================================
// E：连接检测错误链
// ====================================================================

test('E: 检测连接 HTTP 分支使用 listTools()+doOnError 错误链', () => {
    const src = readJava('com/gourdai/core/portal/web/WebSettingsController.java');
    assert.match(src, /AtomicReference<Throwable> errorRef = new AtomicReference<>\(\);/);
    assert.match(src, /client\.getClient\(\)\.listTools\(\)\s*\.doOnError\(err -> \{\s*errorRef\.set\(err\);\s*\}\)\s*\.block\(\);/);
    assert.match(src, /String channel = McpTypeResolver\.toChannel\(type\);/);
});

// ====================================================================
// D：tools/save 空值防御
// ====================================================================

test('D: tools/save 空值防御（null → emptyList，@Param required=false）', () => {
    const src = readJava('com/gourdai/core/portal/web/WebSettingsController.java');
    assert.match(src, /@Param\(value = "disallowedTools", required = false\) String\[\] disallowedTools/);
    assert.match(src, /disallowedTools == null\s*\?\s*Collections\.emptyList\(\)\s*:\s*Arrays\.asList\(disallowedTools\)/);
});

// ====================================================================
// B：后端 parse/string + 共享解析
// ====================================================================

test('B: 新增 /import/parse/string 端点并与文件导入共享 parseMcpConfigNode', () => {
    const src = readJava('com/gourdai/core/portal/web/WebSettingsController.java');
    assert.match(src, /@Mapping\("\/web\/settings\/mcp\/import\/parse\/string"\)/);
    assert.match(src, /public Result mcpImportParseString\(@Body String json\)/);
    assert.match(src, /private Result parseMcpConfigNode\(ONode root\)/);
    // 两个端点都必须调用共享方法（同一套解析逻辑）
    const calls = src.match(/return parseMcpConfigNode\(root\);/g) || [];
    assert.equal(calls.length, 2, '文件导入与字符串导入都应调用 parseMcpConfigNode');
    // type 别名标准化 + 未知类型显式报错
    assert.match(src, /serverType = McpTypeResolver\.standardize\(type\);/);
    assert.match(src, /server\.put\("error", "不支持的服务器类型: " \+ serverType\);/);
    // 解析结果含 enabled/scope，可直接用于 /mcp/servers/add
    assert.match(src, /server\.put\("enabled", true\);\s*server\.put\("scope", "user"\);/);
});

// ====================================================================
// B：前端导入下拉菜单 + 字符串导入对话框
// ====================================================================

test('B: settings.html 导入按钮改为下拉菜单（文件/字符串两项）', () => {
    const html = readStatic('settings.html');
    assert.match(html, /<div class="mcp-import-menu-wrap">/);
    assert.match(html, /<div class="mcp-import-menu" id="mcpImportMenu">/);
    assert.match(html, /data-action="file" data-i18n="settings\.mcp\.import_json_file"/);
    assert.match(html, /data-action="string" data-i18n="settings\.mcp\.import_json_str"/);
});

test('B: 前端菜单事件与字符串导入对话框（POST /import/parse/string）', () => {
    const js = readStatic('js', 'app-settings-mcp.js');
    // 菜单开关
    assert.match(js, /\$\('#mcpImportBtn'\)\.on\('click', function \(e\) \{\s*e\.stopPropagation\(\);\s*\$\('#mcpImportMenu'\)\.toggleClass\('show'\);\s*\}\);/);
    // 点击空白关闭
    assert.match(js, /\$\(document\)\.on\('click', function \(\) \{\s*\$\('#mcpImportMenu'\)\.removeClass\('show'\);\s*\}\);/);
    // 菜单项分发
    assert.match(js, /if \(action === 'file'\) \{\s*\$\('#mcpImportFileInput'\)\.trigger\('click'\);\s*\} else if \(action === 'string'\) \{\s*showImportStringDialog\(\);\s*\}/);
    // 字符串对话框：POST 到复用端点 + 输入框
    assert.match(js, /function showImportStringDialog\(\)/);
    assert.match(js, /url: '\/web\/settings\/mcp\/import\/parse\/string'/);
    assert.match(js, /id="importStringInput"/);
    // 空输入与非法 JSON 的前端校验
    assert.match(js, /showToast\(GourdI18n\.t\('settings\.mcp\.json_empty'\), 'error'\);/);
    assert.match(js, /showToast\(GourdI18n\.t\('settings\.mcp\.json_invalid'\), 'error'\);/);
});

// ====================================================================
// F：细节组
// ====================================================================

test('F1: toggle 后强制刷新列表（确保开关状态与服务端一致）', () => {
    const js = readStatic('js', 'app-settings-mcp.js');
    const fn = js.slice(js.indexOf('function mcpToggleServer'), js.indexOf('// MCP 按钮事件'));
    assert.match(fn, /loadMcpList\(\);/, 'toggle 回调应刷新列表');
    assert.match(fn, /\/\/ 无论成败都刷新列表/, '应带有一致性注释（防止回退为仅失败时刷新）');
    assert.doesNotMatch(fn, /'error'\);\s*loadMcpList\(\);/, '不应回到「内联刷新」旧写法');
});

test('F2: 检测连接超时使用专用提示（15 秒）', () => {
    const js = readStatic('js', 'app-settings-mcp.js');
    assert.match(js, /var msg = textStatus === 'timeout' \? GourdI18n\.t\('settings\.mcp\.check_timeout'\) : GourdI18n\.t\('settings\.network_error'\);/);
});

test('F3: 撤销导入确认改用 layConfirm（与全局弹窗风格统一）', () => {
    const js = readStatic('js', 'app-settings-mcp.js');
    assert.match(js, /layConfirm\(tRollbackConfirm, function\(\) \{/);
    assert.doesNotMatch(js, /if \(!confirm\(tRollbackConfirm\)\) return;/, '不应使用原生 confirm');
});

test('F4: 空状态文案使用专用键（不再拼接 no_data）', () => {
    const js = readStatic('js', 'app-settings-mcp.js');
    assert.match(js, /GourdI18n\.t\('settings\.mcp\.empty'\)/);
    assert.match(js, /GourdI18n\.t\('settings\.mcp\.empty_desc'\)/);
    assert.match(js, /GourdI18n\.t\('settings\.mcp\.no_tools'\)/);
    assert.match(js, /GourdI18n\.t\('settings\.mcp\.no_tools_desc'\)/);
    assert.doesNotMatch(js, /GourdI18n\.t\('common\.no_data'\)\s*\+\s*GourdI18n\.t\('settings\.mcp\.title'\)/);
    assert.doesNotMatch(js, /GourdI18n\.t\('common\.no_data'\)\s*\+\s*GourdI18n\.t\('settings\.mcp\.tools_title'\)/);
});

// ====================================================================
// streamable_stateless 前端贯通
// ====================================================================

test('streamable_stateless 贯通：导入/编辑展示/保存兜底', () => {
    const js = readStatic('js', 'app-settings-mcp.js');
    // 编辑展示（远程配置区）
    assert.match(js, /\$\('#mcpConfigRemote'\)\.toggle\(type === 'sse' \|\| type === 'streamable' \|\| type === 'streamable_stateless'\);/);
    // 保存请求体分支
    assert.match(js, /\} else if \(type === 'sse' \|\| type === 'streamable' \|\| type === 'streamable_stateless'\) \{\s*var url = \$\('#mcpRemoteUrl'\)/);
    // 导入请求体分支
    assert.match(js, /\} else if \(srv\.type === 'sse' \|\| srv\.type === 'streamable' \|\| srv\.type === 'streamable_stateless'\) \{/);
    // 类型兜底（无匹配按钮时保留编辑对象原始类型）
    assert.match(js, /var mcpEditType = null;/);
    assert.match(js, /\.attr\('data-type'\) \|\| mcpEditType \|\| 'stdio';/);
});

// ====================================================================
// CSS
// ====================================================================

test('CSS：下拉菜单与字符串对话框样式齐备', () => {
    const css = readStatic('css', 'settings.css');
    assert.match(css, /\.mcp-import-menu-wrap \{/);
    assert.match(css, /\.mcp-import-menu\.show \{/);
    assert.match(css, /\.mcp-import-menu-item \{/);
    assert.match(css, /\.import-string-textarea \{/);
    assert.match(css, /\.import-string-hint \{/);
    assert.match(css, /\.import-string-code \{/);
});

// ====================================================================
// i18n 12 语言包
// ====================================================================

test('i18n：12 个语言包含全部 16 个新键且非空', () => {
    const NEW_KEYS = ['import_json_file', 'import_json_str', 'json_dialog_title', 'json_hint', 'json_format_hint', 'json_placeholder', 'json_parse_hint', 'json_empty', 'json_invalid', 'parse_btn', 'parse_failed_retry', 'check_timeout', 'empty', 'empty_desc', 'no_tools', 'no_tools_desc'];
    for (const lang of LOCALES) {
        const json = JSON.parse(readStatic('locales', lang + '.json'));
        const mcp = json.settings && json.settings.mcp;
        assert.ok(mcp, `${lang}: 缺少 settings.mcp`);
        for (const k of NEW_KEYS) {
            assert.equal(typeof mcp[k], 'string', `${lang}: 缺少 ${k}`);
            assert.ok(mcp[k].trim(), `${lang}: ${k} 为空`);
        }
        assert.match(mcp.json_format_hint, /import-string-code/, `${lang}: json_format_hint 结构丢失`);
    }
});
