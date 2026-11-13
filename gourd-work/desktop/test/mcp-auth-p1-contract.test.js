/**
 * P1 行为级护栏：三种 WorkBuddy 风格授权形态必须真的被触发，而不是只
 * 存在于源码字符串里。用 vm 真跑 window.McpAuth 的 IIFE，桩掉 jQuery/ajax，
 * 断言 /auth/state 之后实际发出的是哪个请求、弹窗里渲染了什么。
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
const js = read(path.join(UI, 'js', 'app-settings-mcp.js'));
const iife = /\/\* MCP-AUTH-MODULE-START \*\/([\s\S]*?)\/\* MCP-AUTH-MODULE-END \*\//.exec(js);
assert.ok(iife, '无法定位 McpAuth IIFE');

/** 构造一个可观测的沙箱；stateResponse 决定分流，ajax 记录所有请求。 */
function harness(stateResponse) {
  const calls = [];
  const dom = { dialogs: [], appended: '', removed: false, overlays: [] };
  const elem = () => {
    const e = {
      _html: '', _text: '', _val: '', _attrs: {}, _handlers: {},
      html(v) { if (v === undefined) return this._html; this._html = v; dom.appended += v; return this; },
      text(v) { if (v === undefined) return this._text; this._text = v; return this; },
      val(v) { if (v === undefined) return this._val; this._val = v; return this; },
      append(v) { dom.appended += v; return this; },
      remove() { dom.removed = true; return this; },
      show() { return this; }, hide() { return this; },
      on(ev, fn) { this._handlers[ev] = fn; return this; },
      off() { return this; }, filter() { return this; }, find() { return elem(); },
      addClass() { return this; }, removeClass() { return this; },
      toggle() { return this; }, prop() { return this; }, trigger() { return this; },
      attr() { return ''; }, length: 1
    };
    return e;
  };
  const ajax = opts => {
    calls.push(opts);
    let resp = {};
    if (opts.url.includes('/auth/state')) resp = stateResponse;
    else if (opts.url.includes('/auth/device/start')) resp = { ok: true, userCode: 'ABCD-EFGH', verificationUri: 'https://as.example/device', expiresIn: 300 };
    else if (opts.url.includes('/auth/start')) resp = { ok: true, authorizationUrl: 'https://as.example/authorize?qr=1' };
    else if (opts.url.includes('/auth/token')) resp = { ok: true };
    else if (opts.url.includes('/auth/cancel') || opts.url.includes('/auth/clear')) resp = { ok: true };
    const d = { done(cb) { cb(resp); return this; }, fail() { return this; } };
    return d;
  };
  const $ = sel => {
    const e = elem();
    dom.overlays.push(sel);
    return e;
  };
  $.ajax = ajax;
  const sandbox = {
    window: { GourdI18n: { t: k => k }, open: (...a) => calls.push({ open: a }) },
    GourdI18n: { t: k => k },
    $, jQuery: $,
    console, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    // URL 必须由沙箱提供：showQrModal 用 new URL() 解析校验 https（而非前缀正则），
    // 少了它 ReferenceError 会被 catch 吞掉→ 所有 URL 都判为不安全 → iframe 永不渲染。
    Date, Math, String, Number, JSON, encodeURIComponent, Promise, RegExp, Error, URL
  };
  sandbox.window.open = (...a) => calls.push({ open: a });
  vm.createContext(sandbox);
  vm.runInContext(iife[1], sandbox);
  return { api: sandbox.window.McpAuth, calls, dom, sandbox };
}

const tick = () => new Promise(r => setImmediate(r));

test('① authDeviceFlow=true 走 /auth/device/start，渲染 user_code 与倒计时，不开系统浏览器', async () => {
  const h = harness({ ok: true, authType: 'oauth', connected: false, needsAuth: true, authDeviceFlow: true });
  const result = await h.api.openDialog('demo');
  await tick();
  assert.equal(result, false, '弹窗应接管流程');
  assert.ok(h.calls.some(c => c.url && c.url.includes('/auth/device/start')),
    '未调用 Device Flow 起点');
  assert.ok(!h.calls.some(c => c.url && c.url.includes('/auth/start') && !c.url.includes('device')),
    '不应走普通 OAuth 起点');
  assert.ok(!h.calls.some(c => c.open), 'Device Flow 不应打开系统浏览器');
  assert.match(h.dom.appended, /ABCD-EFGH/, '弹窗未渲染 user_code');
  assert.match(h.dom.appended, /mcpAuthCountdown/, '弹窗缺倒计时容器');
  assert.match(h.dom.appended, /https:\/\/as\.example\/device/, '弹窗未给出验证链接');
});

test('② authQrModal=true 走 iframe 弹窗（sandbox + https 白名单），不打开系统浏览器', async () => {
  const h = harness({ ok: true, authType: 'oauth', connected: false, needsAuth: true, authQrModal: true });
  await h.api.openDialog('demo');
  await tick();
  assert.ok(h.calls.some(c => c.url && c.url.endsWith('/auth/start')), '未调用 OAuth 起点');
  assert.ok(!h.calls.some(c => c.open), 'authQrModal 不应打开系统浏览器');
  assert.match(h.dom.appended, /<iframe[^>]+mcpAuthQrFrame/, '未渲染内嵌二维码 iframe');
  assert.match(h.dom.appended, /sandbox="allow-forms allow-scripts/, 'iframe 缺 sandbox');
  assert.match(h.dom.appended, /https:\/\/as\.example\/authorize/, 'iframe src 未指向授权页');
});

test('③ 普通 oauth 仍打开系统浏览器；token 型仍走 token 弹窗；none 立即放行', async () => {
  const plain = harness({ ok: true, authType: 'oauth', connected: false, needsAuth: true });
  await plain.api.openDialog('demo'); await tick();
  assert.ok(plain.calls.some(c => c.open), '普通 OAuth 应打开系统浏览器');
  assert.ok(!plain.calls.some(c => c.url && c.url.includes('/auth/device/start')));

  const tok = harness({ ok: true, authType: 'token', connected: false, needsAuth: true, label: 'API Key' });
  await tok.api.openDialog('demo'); await tick();
  assert.match(tok.dom.appended, /type="password"/, 'token 型应渲染密码输入框');
  assert.ok(!tok.calls.some(c => c.url && c.url.includes('/auth/start')));

  const none = harness({ ok: true, authType: 'none', connected: false, needsAuth: false });
  assert.equal(await none.api.openDialog('demo'), true);
});

test('④ 非 https 的 iframe 被拒绝（防把任意 URL 塞进应用内页面）', async () => {
  const h = harness({ ok: true, authType: 'oauth', connected: false, needsAuth: true, authQrModal: true });
  // 直接调导出的 showQrModal，验证白名单判据本身
  const r = h.api.showQrModal('demo', 'http://evil.example/authorize', null);
  assert.equal(r, false, 'http URL 必须被拒绝');
  assert.ok(!/iframe/.test(h.dom.appended), '被拒后不得渲染 iframe');
});

test('⑤ 后端契约闭合：state 带两个标志、device 端点已注册、状态轮询回传 userCode', () => {
  const api = read(path.join(CORE, 'server', 'mcp_auth_api.rs'));
  const mod = read(path.join(CORE, 'server', 'mod.rs'));
  const settings = read(path.join(CORE, 'server', 'settings_api.rs'));
  const market = read(path.join(CORE, 'server', 'mcp_market_api.rs'));
  const auth = read(path.join(CORE, 'mcp', 'auth.rs'));
  const oauth = read(path.join(CORE, 'mcp', 'oauth.rs'));

  assert.match(api, /"authDeviceFlow": device_flow/, '/auth/state 未透传 authDeviceFlow');
  assert.match(api, /"authQrModal": qr_modal/, '/auth/state 未透传 authQrModal');
  assert.match(api, /AuthKind::Oauth \|\| !spec\.auth_device_flow/, 'device 端点未校验声明');
  assert.match(api, /"userCode": s\.user_code/, 'device 端点未返回 userCode');
  assert.match(api, /"userCode": s\.user_code/, 'status 轮询未回传 userCode');
  assert.match(mod, /mcp\/auth\/device\/start.{0,80}mcp_auth_device_start/, '路由未注册');
  assert.match(settings, /"authDeviceFlow", "authQrModal"/, '落盘白名单未放行新声明');
  assert.match(market, /body\.auth = Some\(sanitize_auth_decl\(auth\)\)/,
    '市场安装必须复用同一份白名单过滤后再透传认证声明（防上游 token 进入内存中的 McpBody）');
  assert.match(auth, /pub async fn start_device\(/, 'AuthManager 缺 start_device');
  assert.match(auth, /complete_device_flow\(/, 'Device Flow 后台轮询未接线');
  // slow_down 的算术（+5s、上限 60s）由 oauth.rs 的纯函数 back_off_poll_interval
  // 保证，并有 Rust 行为测试直接断言其输出；这里只钉「接线」：SlowDown 分支必须
  // 调用该共享函数，而不是自己内联一份可能漂移的算法。
  // 注意：断言写成跨行容错的形式，避免只改排版（单行 match 臂 ↔ block）就假红。
  assert.match(auth, /DevicePollOutcome::SlowDown\s*=>\s*\{?[\s\S]{0,120}?back_off_poll_interval/,
    'SlowDown 分支未调用 oauth::back_off_poll_interval');
  assert.match(oauth, /pub fn back_off_poll_interval/, 'oauth.rs 缺 back_off_poll_interval 纯函数');
  assert.match(oauth, /DEVICE_POLL_SLOW_DOWN_STEP_SECS:\s*u64\s*=\s*5/, 'slow_down 步长不是 RFC 8628 §3.5 规定的 5 秒');
  assert.match(oauth, /DEVICE_POLL_INTERVAL_CAP_SECS:\s*u64\s*=\s*60/, '轮询间隔上限不是 60 秒');
});

test('⑥ 12 语言包 8 个 P1 键齐全，中文不是英文占位；CSS 有三个新样式', () => {
  const keys = ['auth_device_title', 'auth_device_waiting', 'auth_device_hint', 'auth_device_expires',
    'auth_device_open', 'auth_qr_title', 'auth_qr_hint', 'auth_qr_https_only'];
  const dir = path.join(UI, 'locales');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  assert.equal(files.length, 12);
  for (const f of files) {
    const m = JSON.parse(read(path.join(dir, f))).settings.mcp;
    for (const k of keys) assert.equal(typeof m[k], 'string', f + ' 缺 ' + k);
  }
  assert.equal(JSON.parse(read(path.join(dir, 'zh-CN.json'))).settings.mcp.auth_device_title, '扫码授权');
  const css = read(path.join(UI, 'css', 'mcp-auth.css'));
  for (const cls of ['.mcp-auth-device-code', '.mcp-auth-countdown', '.mcp-auth-qr-frame']) {
    assert.ok(css.includes(cls), 'CSS 缺 ' + cls);
  }
});
