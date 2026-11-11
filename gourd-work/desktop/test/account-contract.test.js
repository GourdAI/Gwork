/* 账号链路接线契约：CI 只跑 test:js（desktop crate 的 Rust 单测在 Linux 上
   因缺 WebKitGTK 被排除），所以跨文件登记必须在这里锁死。
   覆盖：lib.rs handler / build.rs COMMANDS / capabilities / ipc_bridge /
   bootstrap 脚本顺序 / index.html 入口 / 12 份 locale 的 account 键。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const COMMANDS = [
  'auth_status', 'auth_login', 'auth_register',
  'auth_logout', 'auth_refresh', 'auth_self'
];

test('lib.rs registers every auth command in generate_handler!', () => {
  const src = read('src-tauri/src/lib.rs');
  assert.ok(src.includes('mod auth;'), 'auth module must be declared');
  assert.ok(src.includes('auth::install(&handle);'), 'setup must install AuthState and restore the session');
  const handler = src.slice(src.indexOf('.invoke_handler('), src.indexOf('.build(tauri::generate_context!())'));
  for (const c of COMMANDS) {
    assert.ok(handler.includes('auth::' + c + ','), 'missing handler registration: ' + c);
  }
});

test('build.rs COMMANDS and capabilities/default.json cover every auth command (ACL)', () => {
  const build = read('src-tauri/build.rs');
  for (const c of COMMANDS) {
    assert.ok(build.includes('"' + c + '",'), 'missing build.rs COMMANDS entry: ' + c);
  }
  const caps = JSON.parse(read('src-tauri/capabilities/default.json'));
  const perms = caps.permissions;
  for (const c of COMMANDS) {
    const allow = 'allow-' + c.replace(/_/g, '-');
    assert.ok(perms.includes(allow), 'missing capability: ' + allow);
  }
});

test('ipc_bridge exposes all six auth methods through window.__GOURD_IPC__', () => {
  const src = read('src-tauri/src/ipc_bridge.rs');
  const METHODS = ['authStatus', 'authLogin', 'authRegister', 'authLogout', 'authRefresh', 'authSelf'];
  for (const m of METHODS) {
    assert.ok(src.includes(m + ': function'), 'missing bridge method: ' + m);
  }
  // 每个方法必须 invoke 到对应 snake_case command，避免只摆了个空壳。
  for (const c of COMMANDS) {
    assert.ok(src.includes("invoke('" + c + "'"), 'bridge never invokes ' + c);
  }
});

test('app-account.js is loaded by bootstrap and entry exists in index.html', () => {
  const boot = read('ui/js/app-bootstrap.js');
  assert.ok(boot.includes("'/js/app-account.js',"), 'app-account.js must be in APP_SCRIPTS');
  const html = read('ui/index.html');
  assert.ok(html.includes('id="accountEntryBtn"'), 'account entry button missing');
  assert.ok(html.includes('data-i18n="account.entry"'), 'entry i18n key missing');
  /* 【布局纪律】用户卡片取代原设置按钮，成为 sidebar-footer 的【首子项】，
     更新按钮是末子项：底栏 space-between 下首子项恒贴左端、末子项恒贴右端，
     卡片位置不随「有无更新」跳变（与原设置按钮同一纪律）。 */
  const footer = html.slice(html.indexOf('class="sidebar-footer"'));
  assert.ok(footer.indexOf('id="accountEntryBtn"') >= 0,
    'account card must live INSIDE sidebar-footer (it replaced the settings button)');
  assert.ok(footer.indexOf('id="accountEntryBtn"') < footer.indexOf('id="sidebarUpdateBtn"'),
    'account card must be the first footer child, update button the last');
  assert.ok(!html.includes('id="settingsBtn"'),
    'standalone settings button must be removed; settings entry lives in the account popover');
  assert.ok(html.includes('class="account-card"'), 'account card class missing');
  assert.ok(!html.includes('account-entry-btn'), 'old top-header entry must be removed');
});

test('12 locales all carry the same account key set', () => {
  const dir = path.join(ROOT, 'ui', 'locales');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  assert.strictEqual(files.length, 12, 'expected 12 locale files');
  const expected = [
    'close', 'entry', 'sign_in', 'sign_up', 'sign_up_submit', 'sign_out',
    'username', 'email', 'password', 'working', 'signed_in', 'required',
    'password_policy', 'failed',
    // 用户卡片 / 信息弹层（参考设计稿）新增键
    'plan', 'points', 'memory', 'feedback', 'unavailable',
    // 登录弹框主标题（Qoder 式：标题说明当前在做什么，随登录/注册切换）
    'auth_title_login', 'auth_title_register',
    // 左栏手写体标语（Qoder 式艺术字，随语言切换）
    'auth_slogan'
  ].sort();
  for (const f of files) {
    const obj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.ok(obj.account, f + ' missing account section');
    assert.deepStrictEqual(Object.keys(obj.account).sort(), expected, f + ' account key set mismatch');
    for (const k of expected) {
      assert.strictEqual(typeof obj.account[k], 'string', f + ':' + k + ' must be a string');
      assert.ok(obj.account[k].length > 0, f + ':' + k + ' must not be empty');
    }
  }
});

test('every t(\'account.*\') literal key in app-account.js exists in all locales', () => {
  const src = read('ui/js/app-account.js');
  const keys = new Set();
  const rx = /\bt\(\s*'([^']+)'/g;
  let m;
  while ((m = rx.exec(src)) !== null) keys.add(m[1]);
  const dir = path.join(ROOT, 'ui', 'locales');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const obj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const k of keys) {
      if (k.indexOf('account.') !== 0) continue;
      const leaf = k.slice('account.'.length);
      assert.ok(obj.account && typeof obj.account[leaf] === 'string',
        f + ' missing key used by app-account.js: ' + k);
    }
  }
});

test('Rust auth module keeps the long-lived session contract', () => {
  const src = read('src-tauri/src/auth.rs');
  // 后台地址按产品决策写死，不做配置入口。
  assert.ok(src.includes('pub const AUTH_BASE_URL: &str = "https://www.gourdwork.com";'));
  // refresh/logout 必须带 Origin，否则 SESSION_COOKIE_SECURE=true 时
  // SessionCookieOriginGuard 会 403。
  assert.ok(src.includes('.header("Origin", request_origin(&self.base_url))'));
  // 轮换后的 refresh cookie 必须回写 keyring，否则重启会触发服务端 replay 撤销。
  assert.ok(src.includes('keyring_store(&session).await;'));
  // 启动时从 keyring 恢复并刷新一次（进程重启也算「使用」）。
  assert.ok(src.includes('pub async fn restore(&self) -> AuthStatus'));
  assert.ok(src.includes('if let Some(s) = keyring_load().await'));
  // 保活任务按 access token 到期时间提前刷新。
  assert.ok(src.includes('REFRESH_LEAD_SECS'));
  assert.ok(src.includes('pub fn start_keeper(&self)'));
  // 显式退出才撤销并清凭据。
  assert.ok(src.includes('pub async fn logout(&self)'));
  assert.ok(src.includes('keyring_clear().await;'));

  // Code review 回归：并发 refresh 必须串行化，否则两个请求都带旧 secret，
  // 错开服务端 30s grace window 会被判 replay 并撤销整个会话（掉线）。
  assert.ok(src.includes('session_lock: tokio::sync::Mutex<()>'));
  assert.ok(src.includes('let _guard = self.session_lock.lock().await;'));
  // refresh 失败后必须退避，否则 access_expires_at 仍过期 → 每秒打一次
  // refresh，撞上服务端 CriticalRateLimit。
  assert.ok(src.includes('tokio::time::sleep(RETRY_INTERVAL).await;'));
  // 只有服务端精确 code 才算「会话已死」，绝不能用宽泛的 "invalid" 子串
  // 判断（网络/TLS 抖动时会误清用户凭据）。
  assert.ok(src.includes('AUTH_SESSION_REVOKED'));
  assert.ok(src.includes('AUTH_ORIGIN_FORBIDDEN'));
  // 会话错误码要透传给客户端，否则无法区分撤销与限流。
  assert.ok(src.includes('.get("code")'));
});

test('absolute session ceiling matches between backend and desktop client', () => {
  // 服务端硬上限与客户端自算上限必须一致：不一致时客户端会臆造一个更早的
  // 到期时间，在服务端仍认为会话有效时提前把用户判成登出。
  const days = (source, re) => {
    const m = source.match(re);
    assert.ok(m, 'absolute TTL constant not found');
    return Number(m[1]);
  };
  const backend = fs.readFileSync(
    path.join(ROOT, '..', '..', 'gourd-work-admin', 'service', 'auth_token.go'),
    'utf8'
  );
  const goDays = days(backend, /LoginSessionAbsoluteTTL\s*=\s*(\d+)\s*\*\s*24\s*\*\s*time\.Hour/);
  const rust = read('src-tauri/src/auth.rs');
  const clientDays = days(rust, /ABSOLUTE_TTL_SECS:\s*i64\s*=\s*(\d+)\s*\*\s*24\s*\*\s*60\s*\*\s*60/);
  assert.equal(clientDays, goDays,
    'auth.rs::ABSOLUTE_TTL_SECS must equal service/auth_token.go::LoginSessionAbsoluteTTL');
  // 产品决策：放宽到一年，避免常开的桌面端每季度被强制登出。
  assert.equal(goDays, 365);
});
