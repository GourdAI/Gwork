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

/* ── Rust 注释剥离 ─────────────────────────────────────────────────────────
   【codereview 修复：M1 护栏缺口】变异测试实测：把真实请求路径
   `/api/verification?email=` 改成 `/api/verify?email=`，契约测试依然全绿 ——
   因为该字符串同时出现在模块文档（`//!`）与函数文档（`///`）里，
   `src.includes(...)` 被注释喂饱了，等于没有护栏。
   所有针对 Rust 侧「代码里必须真的写了 X」的断言，一律先剥离注释再匹配。

   状态机覆盖双引号字符串、单引号字符字面量、行注释与块注释四种上下文。
   注意：URL 里的 `//`（如 "https://..."）必须留在字符串态里，不能被当成
   行注释 —— 这正是不能简单用 split('//') 的原因。 */
function stripRustComments(src) {
  let out = '';
  let i = 0;
  let inStr = false;
  let inChar = false;
  let inLine = false;
  let inBlock = false;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      i++; continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i += 2; } else { i++; }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === '\\') { if (n !== undefined) { out += n; i += 2; } else { i++; } continue; }
      if (c === '"') inStr = false;
      i++; continue;
    }
    if (inChar) {
      out += c;
      if (c === '\\') { if (n !== undefined) { out += n; i += 2; } else { i++; } continue; }
      if (c === "'") inChar = false;
      i++; continue;
    }
    if (c === '/' && n === '/') { inLine = true; i += 2; continue; }
    if (c === '/' && n === '*') { inBlock = true; i += 2; continue; }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    // 生命周期标注（'static / '_）不是字符字面量：只在形如 'x' 时进字符态。
    if (c === "'" && n !== undefined && src[i + 2] === "'") { inChar = true; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

/* 取某个函数/impl 方法体的代码切片（已剥离注释）。找不到时返回 ''。 */
function rustBody(stripped, startMarker, endMarker) {
  const s = stripped.indexOf(startMarker);
  if (s < 0) return '';
  const e = endMarker ? stripped.indexOf(endMarker, s) : -1;
  return stripped.slice(s, e > s ? e : undefined);
}

test('stripRustComments keeps real code and URLs, drops doc comments', () => {
  // 自校验：剥离函数本身若坏了（过度剥离），下游所有断言都会变成假绿。
  // 用一段同时含文档注释、字符串内 URL、行尾注释的样本锁住它的行为。
  const sample = [
    '//! doc line with https://example.com/api/x',
    '/// another doc',
    'let url = format!("{}/api/verification?email={}", base, e); // trailing',
    '/* block',
    '   still block */ let ok = true;',
    "let c = 'a';",
    "let life: &'static str = \"z\";",
  ].join('\n');
  const s = stripRustComments(sample);
  assert.ok(s.includes('let url = format!("{}/api/verification?email={}"'),
    'real code with a URL must survive comment stripping');
  assert.ok(!s.includes('doc line'), 'doc comments must be stripped');
  assert.ok(!s.includes('another doc'), '/// comments must be stripped');
  assert.ok(!s.includes('trailing'), 'trailing line comments must be stripped');
  assert.ok(!s.includes('still block'), 'block comments must be stripped');
  assert.ok(s.includes("let c = 'a';"), 'char literals must survive');
  assert.ok(s.includes("&'static str"), 'lifetime annotations must survive');
});

const COMMANDS = [
  'auth_status', 'auth_login', 'auth_register',
  'auth_send_code', 'auth_config',
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

test('ipc_bridge exposes all auth methods through window.__GOURD_IPC__', () => {
  const src = read('src-tauri/src/ipc_bridge.rs');
  const METHODS = ['authStatus', 'authLogin', 'authRegister', 'authSendCode', 'authConfig', 'authLogout', 'authRefresh', 'authSelf'];
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
    'auth_slogan',
    // 注册缺参修复：确认密码 / 邮箱验证必需标签 / 验证码行（admin Register
    // 开启邮箱验证时强制 email + verification_code）
    'password_confirm', 'email_required', 'code', 'code_placeholder',
    'send_code', 'code_retry', 'code_sent', 'code_required',
    'email_first', 'password_mismatch'
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

test('register/login payloads match the admin parameter contract', () => {
  const raw = read('src-tauri/src/auth.rs');
  /* 全部走剥离注释后的代码，注释里写多少遍端点都不算数（见 stripRustComments）。 */
  const src = stripRustComments(raw);
  // 注册：后台开启邮箱验证时 email + verification_code 均为必填
  // （admin controller/user.go::Register 解码 model.User 的 verification_code）。
  assert.ok(src.includes('payload["verification_code"]'),
    'register must send verification_code when provided');
  assert.ok(src.includes('pub async fn send_verification_code'),
    'auth.rs must expose the verification-code sender (GET /api/verification)');
  assert.ok(src.includes('"{}/api/verification?email={}"'),
    'verification code endpoint path must match admin router (code, not comment)');
  // 登录：后台开启密码加密传输时只接受 password_encrypted + encryption_key_id。
  assert.ok(src.includes('"password_encrypted": encrypted'), 'login must send the encrypted payload field');
  assert.ok(src.includes('"encryption_key_id": key.kid'), 'login must carry the encryption key id');
  assert.ok(src.includes('"{}/api/user/login/encryption-key"'),
    'encryption key endpoint path must appear in code, not just comments');
  // v2 信封的标签与 AAD 必须与 admin password_crypto.go 逐字一致。
  assert.ok(src.includes('Oaep::new_with_label::<sha2::Sha256, _>("password-v2")'),
    'RSA-OAEP must hash label AND MGF1 with SHA-256 (matches Go rsa.DecryptOAEP(sha256.New(),...))');
  assert.ok(src.includes('format!("password-v2:{}", kid)'),
    'AES-GCM AAD must bind the key id');
  // UI：注册表单必须有验证码行与确认密码字段，且发送按钮带 data-act。
  const ui = read('ui/js/app-account.js');
  assert.ok(ui.includes('accountCode'), 'register form must render the code input');
  assert.ok(ui.includes('accountPassword2'), 'register form must render the confirm-password input');
  assert.ok(ui.includes("data-act=\"send-code\""), 'send-code button must carry the delegate action');
  assert.ok(ui.includes('i.authRegister(username, password, email, code)'),
    'submit must pass email + verification code through the bridge');
});

/* 【codereview 修复：M5 护栏缺口】
   变异测试实测：把登录加密探测从 `.await?` 改成 `.await.unwrap_or_default()`
   （即「探测失败就静默发明文密码」）后，原先的文本断言全部照绿 —— 因为
   `password_encrypted` / `encryption_key_id` 字样依旧存在，变异只改了失败
   分支的降级方式。

   本仓库 CI 只跑 test:js（见文件头注释：Linux 缺 WebKitGTK，desktop crate
   的 Rust 单测被排除），所以 auth.rs 里的 `unavailable_must_not_be_treated_
   as_plaintext` 在 CI 上不会执行。这里必须在 JS 侧把同一语义锁住，否则
   CI 上该缺陷永远 SURVIVE。

   锁死的是**结构**而非字面量：判定必须是三态（Required / 明确关闭 / 旧后台
   404 回退明文 / 无法判定必须报错），且 login() 里对「无法判定」只允许
   `return Err`，不允许任何形式的静默降级。 */
test('login encryption probe must never silently fall back to plaintext', () => {
  const src = stripRustComments(read('src-tauri/src/auth.rs'));

  // 判定必须是三态枚举，而不是 bool/Option 这类会被压平的形状。
  for (const variant of ['Required(', 'Disabled', 'LegacyBackend', 'Unavailable(']) {
    assert.ok(src.includes('LoginEncryption::' + variant) || src.includes(variant),
      'login encryption decision must keep the 4-state enum, missing: ' + variant);
  }
  assert.ok(src.includes('enum LoginEncryption'),
    'the decision type must be an explicit enum (a bool invites silent plaintext)');

  // 判定必须被抽成纯函数：只有纯函数才能被单测直接断言每个分支。
  assert.ok(src.includes('fn decide_login_encryption(status: u16, body: &str) -> LoginEncryption'),
    'the decision must live in a pure function so its branches are unit-testable');

  // 旧版后台没有该端点（404）才允许明文；这是唯一合法的「非确认关闭」回退。
  assert.ok(src.includes('status == 404'),
    'only a 404 (legacy backend without the endpoint) may fall back to plaintext');
  assert.ok(src.includes('LoginEncryption::LegacyBackend'),
    'legacy backends must be a distinct state, not folded into Disabled');

  // admin 的业务错误是 HTTP 200 + success:false（ApiErrorT→ApiErrorStatus(200)），
  // 只看状态码会漏掉「开了加密但公钥没配好」，进而静默发明文。
  const decide = rustBody(src, 'fn decide_login_encryption', '\nfn ');
  assert.ok(decide.includes('!success'),
    'HTTP 200 + success:false must be treated as a failure, not as "encryption off"');

  // login() 对「无法判定」只能报错退出。
  const login = rustBody(src, 'pub async fn login(&self', '\n    /// 注册。');
  assert.ok(login.includes('LoginEncryption::Unavailable(reason) =>'),
    'login() must handle the Unavailable arm explicitly');
  assert.ok(login.includes('return Err(format!('),
    'login() must abort on an undecidable probe instead of sending plaintext');
  // 精确盯住 M5 的变异形状：任何形式的 unwrap_or_default / unwrap_or(false)
  // 都会把「探测失败」变成「当作没开加密」。
  assert.ok(!/login_encryption\(\)[\s\S]{0,80}unwrap_or/.test(login),
    'login() must not swallow probe failures with unwrap_or*() — that is the silent-plaintext bug');
  assert.ok(!login.includes('.unwrap_or(false)'),
    'no bool-flattening of the encryption decision');

  /* 【M5 精确护栏 —— 变异测试实测的存活缺口】
     M5 变异体是 `let _k = self.login_encryption().await; match
     LoginEncryption::Disabled { ... }`：它丢弃探测结果、把 match 的判定对象
     换成硬编码常量，却**保留了全部 arm**，因此上面基于 arm 文本的断言全部
     照过（变异实测 SURVIVE）。真正要锁死的不变量是：login() 必须
     **直接对探测调用本身做 match**，判定对象不能是被丢弃的结果或常量。 */
  assert.ok(login.includes('match self.login_encryption().await {'),
    'login() must match directly on the probe call, not on a discarded result or a constant');
  assert.ok(!/match\s+LoginEncryption::/.test(login),
    'login() must not match on a hardcoded LoginEncryption::* constant (that discards the probe — the M5 silent-plaintext bug)');

  // 双探测真相源必须已移除：加密与否只问 encryption-key 端点自己。
  assert.ok(!/auth_config\(\)[\s\S]{0,200}password_login_encryption_enabled/.test(login),
    'login() must not gate encryption on a second /api/status probe');
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
