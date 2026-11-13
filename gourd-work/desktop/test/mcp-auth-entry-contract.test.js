/**
 * 连接器认证「零入口」回归护栏（行为级）。
 *
 * 背景：后端 6 个 /mcp/auth/* 端点、CredentialVault、OAuth 全流程、前端
 * token/OAuth 弹窗全部齐备且 1480+ 单测全绿，但如果保存表单不提交
 * auth.authType 声明，/auth/state 恒返回 none，所有弹窗永远走「立即放行」
 * —— 能力齐备却零入口，是本仓库反复出现的「假绿」形态。
 *
 * 因此本文件不做字符串凑数，而是：
 *   ① 用 vm 真跑 buildMcpBodyObj，验证三种选择分别产出正确声明；
 *   ② 验证 stdio 不产出 auth（vault 凭据不注入子进程环境）；
 *   ③ 验证凭据「值」绝不出现在配置请求体里；
 *   ④ 验证后端 build_entry 白名单 + mcp_servers 回传 + resolve_auth_headers
 *      消费链在源码里闭合（不是只数字符串，而是钉住确切的键名与入口）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const UI = path.join(ROOT, 'gourd-work', 'desktop', 'ui');
const CORE = path.join(ROOT, 'gourd-work', 'core', 'src');
const read = p => fs.readFileSync(p, 'utf8');

const settingsSrc = read(path.join(UI, 'js', 'app-settings-mcp.js'));
const skillsHtml = read(path.join(UI, 'skills.html'));
const settingsApi = read(path.join(CORE, 'server', 'settings_api.rs'));
const authApi = read(path.join(CORE, 'server', 'mcp_auth_api.rs'));
const mcpMod = read(path.join(CORE, 'mcp', 'mod.rs'));
const serverMod = read(path.join(CORE, 'server', 'mod.rs'));

/** 真跑 buildMcpBodyObj：最小 jQuery 桩，覆盖它读取的全部表单项。 */
function runBuild({ type = 'streamable', authKind = 'none', values = {} } = {}) {
  const fnSrc = /function buildMcpBodyObj\(\)[\s\S]*?\n    }/.exec(settingsSrc);
  assert.ok(fnSrc, '无法从 app-settings-mcp.js 提取 buildMcpBodyObj');
  const vals = Object.assign({
    mcpName: 'demo',
    mcpScope: 'user',
    mcpRemoteUrl: 'https://mcp.example.com/mcp',
    mcpHeaders: '',
    mcpTimeout: '',
    mcpCommand: '',
    mcpArgs: '',
    mcpEnv: '',
    mcpAuthType: authKind
  }, values);
  const toasts = [];
  const sandbox = {
    GourdI18n: { t: k => k },
    showToast: m => toasts.push(m),
    parseKvLines: () => ({}),
    parseTimeout: v => v,
    mcpEditType: null,
    $: sel => ({
      val: () => {
        const m = /^#([\w-]+)/.exec(sel);
        return m ? (vals[m[1]] === undefined ? '' : vals[m[1]]) : '';
      },
      attr: () => type,
      find: () => ({ val: () => '' })
    })
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSrc[0] + '\nthis.__build = buildMcpBodyObj;', sandbox);
  return { body: sandbox.__build(), toasts };
}

test('① 表单三个选项分别产出 none / token / oauth 声明（零入口回归）', () => {
  for (const kind of ['none', 'token', 'oauth']) {
    const { body } = runBuild({ authKind: kind });
    assert.ok(body, kind + ' 未产出请求体');
    assert.equal(body.auth.authType, kind, kind + ' 声明丢失');
    assert.equal(body.type, 'streamable');
    assert.equal(body.url, 'https://mcp.example.com/mcp');
  }
});

test('② 声明只允许 authType 一个键，绝不携带凭据值', () => {
  for (const kind of ['none', 'token', 'oauth']) {
    const { body } = runBuild({ authKind: kind });
    assert.deepEqual(Object.keys(body.auth), ['authType'],
      'auth 声明里混入了凭据或多余字段（会落进 settings.json）');
    for (const forbidden of ['token', 'value', 'secret', 'apiKey', 'password', 'accessToken']) {
      assert.ok(!(forbidden in body), '请求体带凭据字段 ' + forbidden);
    }
  }
  // 未知/伪造值一律收敛为 none，不能让非法 authType 落盘
  assert.equal(runBuild({ authKind: 'evil' }).body.auth.authType, 'none');
});

test('③ stdio 不声明 auth（vault 凭据不注入子进程 env，避免新空转）', () => {
  const { body } = runBuild({ type: 'stdio', authKind: 'token', values: { mcpCommand: 'npx -y demo' } });
  assert.ok(body, 'stdio 合法表单应可提交');
  assert.equal(body.command, 'npx -y demo');
  assert.ok(!('auth' in body), 'stdio 声明了 auth，但启动路径不消费 CredentialVault');
  // UI 侧同步把选择器隐藏并复位
  assert.match(settingsSrc, /\$\('#mcpAuthTypeGroup'\)\.toggle\(isRemote\)/);
  assert.match(settingsSrc, /if \(!isRemote\) \$\('#mcpAuthType'\)\.val\('none'\)/);
});

test('④ 选择器真实存在于 MCP 表单 DOM，且三态选项齐全', () => {
  assert.match(skillsHtml, /<select id="mcpAuthType"/, 'skills.html 缺认证方式选择器');
  for (const v of ['none', 'token', 'oauth']) {
    assert.match(skillsHtml, new RegExp('<option value="' + v + '"'), '缺 ' + v + ' 选项');
  }
  assert.match(skillsHtml, /settings\.mcp\.auth_type_label/, 'label 未走 i18n');
});

test('⑤ 12 份语言包都有 5 个新键，且中文不是英文占位', () => {
  const dir = path.join(UI, 'locales');
  const keys = ['auth_type_label', 'auth_type_none', 'auth_type_token', 'auth_type_oauth', 'auth_type_hint'];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  assert.equal(files.length, 12, '语言包数量不是 12');
  for (const f of files) {
    const m = JSON.parse(read(path.join(dir, f))).settings.mcp;
    for (const k of keys) {
      assert.equal(typeof m[k], 'string', f + ' 缺 settings.mcp.' + k);
      assert.ok(m[k].length > 0, f + ':' + k + ' 为空');
    }
  }
  const zh = JSON.parse(read(path.join(dir, 'zh-CN.json'))).settings.mcp;
  assert.equal(zh.auth_type_label, '认证方式');
  assert.match(zh.auth_type_oauth, /扫码|账号登录/);
});

test('⑦ window.McpAuth 只能有一个实现（重复定义会按 bootstrap 顺序静默覆盖）', () => {
  const jsDir = path.join(UI, 'js');
  const defs = fs.readdirSync(jsDir).filter(f => f.endsWith('.js'))
    .filter(f => /window\.McpAuth\s*=/.test(read(path.join(jsDir, f))));
  assert.deepEqual(defs, ['app-settings-mcp.js'],
    'McpAuth 定义必须唯一；多份实现会因加载顺序互相覆盖且 API 名不一致');
  const bootstrap = read(path.join(jsDir, 'app-bootstrap.js'));
  assert.ok(!bootstrap.includes('app-mcp-auth.js'), 'bootstrap 仍加载已删除的重复实现');
  assert.match(bootstrap, /\/js\/app-settings-mcp\.js/, 'bootstrap 未加载 McpAuth 实现');
});

test('⑥ 后端闭环：白名单落盘 → 列表回传 → /auth/state 读取 → 请求头注入', () => {
  // 落盘白名单必须包含 authType 且不含任何凭据字段。
  // sanitize_auth_decl 现在是「按字段名 + 按类型」双重白名单（STRING_FIELDS /
  // BOOL_FIELDS / NUMBER_FIELDS + scopes 特判），不是单张 ALLOWED 表。这里扫描
  // 全部字段表的并集，只查其中一张会漏放（例如把 token 塞进 NUMBER_FIELDS）。
  const tables = [...settingsApi.matchAll(/const (?:STRING_FIELDS|BOOL_FIELDS|NUMBER_FIELDS|ALLOWED): &\[&str\] = &\[([\s\S]*?)\];/g)];
  assert.ok(tables.length >= 3, `找不到 sanitize_auth_decl 的字段白名单表（应有 STRING/BOOL/NUMBER 三张，实际 ${tables.length} 张）`);
  const whitelist = tables.map((m) => m[1]).join('\n');
  assert.match(whitelist, /"authType"/, '白名单未放行 authType 声明');
  for (const bad of ['"token"', '"secret"', '"value"', '"password"', '"apiKey"', '"clientSecret"', '"refreshToken"']) {
    assert.ok(!whitelist.includes(bad), '白名单放行了凭据字段 ' + bad);
  }
  // scopes 是唯一结构化字段，必须按「只保留字符串元素」清洗，否则能夹带对象密钥。
  assert.match(settingsApi, /obj\.get\("scopes"\)/, 'sanitize_auth_decl 未对 scopes 做结构化清洗');
  assert.match(settingsApi, /filter\(\|v\| v\.is_string\(\)\)/, 'scopes 清洗未过滤非字符串元素（可夹带嵌套密钥）');
  assert.match(settingsApi, /entry\["auth"\] = sanitize_auth_decl\(auth\)/, 'add 未落盘声明');
  assert.match(settingsApi, /item\["auth"\] = v\.clone\(\)/, '列表接口未回传声明（表单无法回显）');
  // /auth/state 用同一份声明判定 authType，且按声明分流
  assert.match(authApi, /fn auth_spec_for\(/, '缺声明解析');
  assert.match(authApi, /"authType": auth_type/, '/auth/state 响应未带 authType');
  assert.match(authApi, /"needsAuth": auth_type != "none" && !has_credential/, 'needsAuth 判据不对');
  assert.match(authApi, /AuthKind::Oauth =>/, '/auth/start 未分流 OAuth');
  assert.match(authApi, /AuthKind::Token use \/auth\/token|"use \/auth\/token"/, '/auth/start 未拒绝 token 型');
  // 请求路径真的消费声明注入 Authorization
  assert.match(mcpMod, /AuthSpec::from_config\(config\)/, 'resolve_auth_headers 未读声明');
  assert.match(mcpMod, /vault\.get_static\(url\)/, '未读静态 token');
  assert.match(mcpMod, /oauth::bearer_header_for\(url, &vault\)/, '未注入 OAuth bearer');
  // 6 条路由都注册
  const routes = ['state', 'start', 'status', 'cancel', 'token', 'clear'];
  for (const r of routes) {
    assert.match(serverMod, new RegExp('/web/settings/mcp/auth/' + r + '"'), '未注册 /auth/' + r);
  }
});
