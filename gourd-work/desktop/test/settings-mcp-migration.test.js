/* ===== 设置页 MCP / 接口配置迁移契约 =====
 *
 * 用户拍板「设置页不要再留存相应设置」：MCP 配置与 OpenAPI 接口配置整块
 * 迁入「技能·连接器·接口」主视图，设置页彻底删除对应 tab / 内容 / 路由。
 *
 * 同时锁定：后端 /web/settings/mcp/* 与 /web/settings/openapi/* 必须保留
 * （配置仍落 settings.json 的 mcpServers / apiServers，Agent 运行时依赖），
 * 以及 Java static 镜像的 LSP tab 不得被误删。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const UI = path.join(REPO, 'gourd-work', 'desktop', 'ui');
const STATIC = path.join(REPO, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static');
const read = p => fs.readFileSync(p, 'utf8');

const VARIANTS = [
  { tag: 'desktop', base: UI },
  { tag: 'static', base: STATIC },
];

test('① 设置页不再留存 MCP / 接口配置的任何入口或内容', () => {
  VARIANTS.forEach(v => {
    const s = read(path.join(v.base, 'settings.html'));
    ['data-tab="mcp"', 'data-tab="openapi"', 'settingsTabMcp', 'settingsTabOpenapi',
      'id="mcpServerList"', 'id="openapiServerList"', 'id="mcpAddBtn"', 'id="openapiAddBtn"']
      .forEach(k => assert.ok(!s.includes(k), v.tag + ': settings.html 残留 ' + k));
  });
});

test('② 技能页承载三个 pane 与迁移后的完整 DOM id', () => {
  VARIANTS.forEach(v => {
    const s = read(path.join(v.base, 'skills.html'));
    ['skillsPaneSkills', 'skillsPaneConnectors', 'skillsPaneInterfaces', 'skillsAddMcpBtn', 'mcpMarketRoot',
      'id="mcpServerList"', 'id="mcpFormView"', 'id="mcpToolsView"', 'id="mcpAddBtn"', 'id="mcpSaveBtn"',
      'id="openapiServerList"', 'id="openapiFormView"', 'id="openapiApisView"',
      'id="openapiAddBtn"', 'id="openapiSaveBtn"']
      .forEach(k => assert.ok(s.includes(k), v.tag + ': skills.html 缺少 ' + k));
    assert.ok(!s.includes('id="settingsTabMcp"'), v.tag + ': 不得残留设置浮层根 id');
    assert.ok(!s.includes('id="settingsTabOpenapi"'), v.tag + ': 不得残留设置浮层根 id');
    // 两个配置 pane 默认隐藏，技能 pane 默认显示
    assert.match(s, /id="skillsPaneSkills"/);
    assert.ok(/id="skillsPaneConnectors"[^>]*style="display:none"/.test(s), v.tag + ': connectors 默认应隐藏');
    assert.ok(/id="skillsPaneInterfaces"[^>]*style="display:none"/.test(s), v.tag + ': interfaces 默认应隐藏');
  });
});

test('③ app-settings.js 不再路由到已迁移的两个 tab', () => {
  VARIANTS.forEach(v => {
    const s = read(path.join(v.base, 'js', 'app-settings.js'));
    ['_settingsMcp', '_settingsOpenapi', 'settingsTabMcp', 'settingsTabOpenapi', '#mcpFormActions', '#openapiFormActions']
      .forEach(k => assert.ok(!s.includes(k), v.tag + ': app-settings.js 残留 ' + k));
    ['general', 'appearance', 'permission', 'acp', 'about'].forEach(t => {
      assert.ok(s.includes("targetTab === '" + t + "'"), v.tag + ': 误删 tab 分支 ' + t);
    });
  });
});

test('④ 配置模块与后端 API 全部保留（只换入口，不换能力）', () => {
  ['app-settings-mcp.js', 'app-settings-openapi.js'].forEach(f => {
    assert.ok(fs.existsSync(path.join(UI, 'js', f)), '缺前端模块 ' + f);
  });
  const bootstrap = read(path.join(UI, 'js', 'app-bootstrap.js'));
  assert.match(bootstrap, /\/js\/app-settings-mcp\.js/, 'bootstrap 仍须加载 MCP 配置模块');
  assert.match(bootstrap, /\/js\/app-settings-openapi\.js/, 'bootstrap 仍须加载 OpenAPI 配置模块');
  const mod = read(path.join(REPO, 'gourd-work', 'core', 'src', 'server', 'mod.rs'));
  assert.match(mod, /\.route\("\/web\/settings\/mcp\/servers"/, '后端 /web/settings/mcp/servers 路由必须注册');
  assert.match(mod, /\.route\("\/web\/settings\/openapi\//, '后端 /web/settings/openapi/* 路由必须注册');
});

test('⑤ Java static 镜像的 LSP tab 不得被误删', () => {
  const s = read(path.join(STATIC, 'settings.html'));
  assert.match(s, /data-tab="lsp"/, 'static 侧 LSP tab 是独立能力，迁移时不得连带删除');
  assert.match(s, /id="lspServerList"/);
});
