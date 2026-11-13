//! auth.rs — 桌面端账号登录态（注册 / 登录 / 登出 / 会话保活）。
//!
//! 后台是 `gourd-work-admin`（QuantumNous/new-api），地址按产品决策写死
//! `https://www.gourdwork.com`，不做配置（见 Q2 拍板）。
//!
//! ## 为什么在 Rust 侧发请求，而不是 WebView fetch
//! 页面跑在 `tauri.localhost`，直连 `www.gourdwork.com` 是跨源：登录/注册路由
//! 未挂 CORS（router/api-router.go 的顺序使后置 `Use(CORS())` 不回溯），
//! 且带 HttpOnly 刷新 cookie 需要 credentials 模式 —— 浏览器层必被拦。
//! Rust 用 reqwest 直连则没有 CORS；但 `SessionCookieOriginGuard`
//! （middleware/auth_origin.go:18-35）在 `SESSION_COOKIE_SECURE=true` 时要求
//! refresh/logout 必须带**可验证的 Origin**（无 Origin/Referer 直接 403），
//! 因此这些请求显式带 `Origin: https://www.gourdwork.com` —— 与 request.Host
//! 同源，guard 的 `isAllowedSessionOrigin` 第一条比较即通过。
//!
//! ## 为什么手写 cookie jar
//! workspace 的 reqwest 0.12 features 只有 json/stream/rustls-tls，**没有 cookies**。
//! 我们不引新依赖，只提取 `Set-Cookie: new_api_refresh=<sid.secret>` 的 name=value
//! 段存进内存 + keyring，刷新/登出时手动拼 `Cookie` 头。cookie 的
//! Path=/api/user/auth、HttpOnly、SameSite 都是浏览器语义，原生 HTTP 客户端
//! 只需把值原样回传。
//!
//! ## 长期登录态（本次修复的核心）
//! 后端把会话 TTL 改成了「滑动 idle 窗口 + 365 天绝对上限」：每次 refresh 成功
//! 都会把 `expires_at` 推到 `now + 30 天`（不超过 created_at + 365 天）。
//! 所以桌面端只要**持续刷新就不掉线**：
//!   - access token 仅 15 分钟，登录后起一个常驻任务按 `access_expires_at`
//!     提前 60 秒自动 refresh；
//!   - 进程重启（用户关窗再打开）也算「使用」：从 keyring 恢复 refresh cookie
//!     后立即 refresh 一次，拿到新 access token，无需重新输密码；
//!   - 只有显式点「退出登录」才调用 logout 撤销会话并清 keyring。
//! 凭据只存 OS keyring（独立 service 名），绝不进 settings.json / localStorage。
//!
//! ## 参数契约（与 gourd-work-admin 对齐，2026 注册缺参修复）
//! admin 的 `POST /api/user/register` 直接解码 `model.User`：开启邮箱验证
//! （`GET /api/status` 的 `email_verification`）时**必须**带
//! `verification_code`，否则返回「Email verification is enabled...」；验证码
//! 由 `GET /api/verification?email=...` 下发。旧实现只发 username/password/
//! email，注册必失败 —— 现已补齐，并在 UI 提供「发送验证码」入口。
//! `POST /api/user/login` 在后台开启密码加密传输时只接受
//! `password_encrypted` + `encryption_key_id`（v2 信封：RSA-OAEP/SHA-256
//! label="password-v2" 包裹随机 AES-256 密钥，AES-GCM 加密密码，AAD 为
//! "password-v2:<kid>"），明文 password 会被判 Invalid parameters。
//! **是否需要加密只问 `GET /api/user/login/encryption-key` 自己的 `enabled`
//! 字段**（它就是 admin 的权威开关），不要用 `/api/status` 的
//! password_login_encryption_enabled 做前置判断：两条链路一旦有一条探测失败，
//! 就会静默退回明文并让后台报出误导性的「密码错误」。

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine as _;
use rsa::pkcs8::DecodePublicKey;
use rsa::{Oaep, RsaPublicKey};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::async_runtime;

/// 后台地址：产品决策写死，不提供配置入口。
pub const AUTH_BASE_URL: &str = "https://www.gourdwork.com";
const REFRESH_COOKIE_NAME: &str = "new_api_refresh";
const KEYRING_SERVICE: &str = "gwork-desktop-account";
const KEYRING_KEY: &str = "session";
/// access token 到期前多久发起刷新（15 分钟 TTL，留足网络抖动余量）。
const REFRESH_LEAD_SECS: i64 = 60;
/// refresh 失败后的重试间隔。
const RETRY_INTERVAL: Duration = Duration::from_secs(30);
/// 单次 HTTP 超时。
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);

/// 对外暴露的登录态（不含任何凭据）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AuthStatus {
    pub signed_in: bool,
    pub username: String,
    pub display_name: String,
    pub user_id: i64,
    /// access token 的到期时间（Unix 秒），前端仅用于展示。
    pub access_expires_at: i64,
/// 会话绝对上限到期时间（Unix 秒，来自 session.created_at + 365 天）。
    pub session_expires_at: i64,
    /// 非成功态的提示（如「后台暂不可用」），成功为空。
    pub message: String,
}

/// 内存中保存的一份会话凭据。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct StoredSession {
    /// `sid.secret`，与 `sid` 分开存，refresh 要带 `X-Auth-Session`。
    refresh_token: String,
    sid: String,
    access_token: String,
    access_expires_at: i64,
    session_expires_at: i64,
    username: String,
    display_name: String,
    user_id: i64,
}

/// 全局会话状态。用 `std::sync::Mutex` 而非 tokio Mutex：所有临界区都极短
/// （只做 clone/赋值），网络请求在锁外进行，不会阻塞 runtime。
pub struct AuthState {
    session: Mutex<Option<StoredSession>>,
    client: reqwest::Client,
    /// 保活任务是否已启动（进程生命周期内只起一次）。
    keeper_started: Mutex<bool>,
    /// 会话写操作互斥锁：login / refresh / logout 必须串行。
    ///
    /// 服务端 refresh 是「轮换密钥」：同一时刻两个请求若都带旧 secret，靠
    /// 30 秒 grace window 才不冲突；一旦错开超过窗口，后者会被判为 replay
    /// 并**撤销整个会话**（掉线）。保活任务、启动恢复、authorized_get、
    /// 手动刷新四路都可能同时调 refresh，因此这里串行化，并且持锁后重新
    /// snapshot —— 后一个请求会读到前一个刚轮换写入的新 secret，从而
    /// 走正常的 current→next 轮换而非 previous 分支。
    session_lock: tokio::sync::Mutex<()>,
    base_url: String,
}

impl AuthState {
    pub fn new() -> Self {
        Self::with_base_url(AUTH_BASE_URL)
    }

    /// 测试可注入本地地址；生产固定走 `AUTH_BASE_URL`。
    pub fn with_base_url(base_url: impl Into<String>) -> Self {
        let client = reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            // 只走直连：系统代理会破坏 Origin/Host 一致性，也会让本地联调失真。
            .no_proxy()
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            session: Mutex::new(None),
            client,
            keeper_started: Mutex::new(false),
            session_lock: tokio::sync::Mutex::new(()),
            base_url: base_url.into().trim_end_matches('/').to_string(),
        }
    }

    pub fn snapshot(&self) -> Option<StoredSession> {
        self.session.lock().ok().and_then(|g| g.clone())
    }

    fn store(&self, s: Option<StoredSession>) {
        if let Ok(mut g) = self.session.lock() {
            *g = s;
        }
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ───────────────── 注册能力探测（GET /api/status）─────────────────
//
// 注册相关的后台开关是部署级配置，桌面端不能写死假设：渲染注册表单前用
// GET /api/status 探测一次（进程内缓存 60s）。探测失败时按「邮箱可选」降级
// ——此时若后台实际开启了邮箱验证，后台会用精确的业务错误文案拒绝注册，
// 用户可见，不会静默失败。
//
// 注意：**登录加密不走这里**。是否需要密码加密传输，只问
// GET /api/user/login/encryption-key 自己的 enabled（见 login_encryption），
// 绝不能用 /api/status 的开关做前置判断——那条链路一旦探测失败就会静默退回
// 明文，正是本轮修掉的缺陷。因此 AuthConfig 刻意【不】承载登录加密开关。

/// `GET /api/status` 中与【注册】流程相关的开关子集。
/// 登录加密判定见 `login_encryption()`，不在此结构体内（勿在此新增）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AuthConfig {
    /// 注册时是否强制邮箱 + 验证码（admin: common.EmailVerificationEnabled）。
    pub email_verification: bool,
    /// 是否允许密码注册（admin: common.PasswordRegisterEnabled）。
    pub password_register_enabled: bool,
}

#[derive(Debug, Deserialize, Default)]
struct StatusWire {
    #[serde(default)]
    email_verification: bool,
    #[serde(default = "default_true")]
    password_register_enabled: bool,
}

fn default_true() -> bool {
    true
}

/// `GET /api/user/login/encryption-key` 的响应子集。
/// admin controller/user.go::GetPasswordEncryptionKey 在加密未开启时只回
/// `{enabled:false}`（不带公钥），开启时回 `{enabled:true,kid,public_key}`。
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
struct EncryptionKeyWire {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    kid: String,
    #[serde(default)]
    public_key: String,
}

/// `GET /api/user/login/encryption-key` 的判定结果。
///
/// 三态是刻意区分的，不能压成 bool：
/// - `Disabled`：后台**明确回答**加密关闭（`{success:true,enabled:false}`），
///   此时明文登录是后台认可的用法；
/// - `LegacyBackend`：后台**根本没这个端点**（404，旧版 admin）或响应无法
///   解析。这种情况下也必须回退明文 —— 否则对接旧版后台的客户端会从
///   「本来能登录」变成「硬失败」；
/// - `Required`：后台要求加密且给出了可用公钥。
///
/// 唯一**不**回退明文的是 `Unavailable`（传输失败/非 404 的服务端错误）：
/// 这时后台可能已开启加密，静默发明文会让后台回一句误导性的
/// "Invalid parameters"，用户看到的却是「密码错误」，且日志里没有任何
/// 指向真因的线索。宁可把真实故障报出来。
#[derive(Debug, Clone, PartialEq)]
enum LoginEncryption {
    /// 后台明确要求加密，公钥可用。
    Required(EncryptionKeyWire),
    /// 后台明确回答未开启加密。
    Disabled,
    /// 后台没有该端点（旧版 admin，404）或响应不是合法 JSON：按明文登录。
    LegacyBackend,
    /// 无法判定（网络失败 / 5xx / 声称开启却无公钥）：必须报错，不得发明文。
    Unavailable(String),
}

impl LoginEncryption {
    /// 是否需要走 v2 信封加密。
    fn is_required(&self) -> bool {
        matches!(self, LoginEncryption::Required(_))
    }
}

/// 纯判定函数：由 HTTP 状态码 + 响应体决定登录加密策略。
///
/// 抽成纯函数是为了让它**可以被单测直接击杀**。此前这段逻辑内联在
/// `login()` 里，护栏只能靠 `src.includes("password_encrypted")` 这类文本
/// 匹配，把 `.await?` 改成 `.await.unwrap_or_default()`（探测失败即静默
/// 发明文）都不会让任何测试变红 —— 变异测试实测该缺陷 SURVIVE。
///
/// 注意 admin 的错误响应约定：`ApiErrorT` → `ApiErrorStatus(c, http.StatusOK, ...)`，
/// 即**业务错误也是 HTTP 200** + `{success:false,message}`。因此只看状态码
/// 会漏掉「后台声称开启加密却没配好公钥」这类 200 错误，必须同时看
/// `success` 字段。
fn decide_login_encryption(status: u16, body: &str) -> LoginEncryption {
    // 旧版后台没有这个端点：路由不存在，按明文登录（该版本也不校验加密）。
    if status == 404 {
        return LoginEncryption::LegacyBackend;
    }
    let v: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        // 非 JSON（例如网关返回的 HTML 错误页）：无法判定，不猜。
        Err(e) => {
            return LoginEncryption::Unavailable(format!(
                "获取登录加密公钥失败：响应不是合法 JSON（HTTP {}，{}）",
                status, e
            ))
        }
    };
    let success = v.get("success").and_then(|x| x.as_bool()).unwrap_or(false);
    let message = || {
        v.get("message")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string()
    };
    // HTTP 200 + success:false 是 admin 的业务错误形态，同样不能当成功。
    if status < 200 || status >= 300 || !success {
        let msg = message();
        return LoginEncryption::Unavailable(if msg.is_empty() {
            format!("获取登录加密公钥失败（HTTP {}）", status)
        } else {
            msg
        });
    }
    let wire: EncryptionKeyWire =
        serde_json::from_value(v.get("data").cloned().unwrap_or_default()).unwrap_or_default();
    if !wire.enabled {
        return LoginEncryption::Disabled;
    }
    if wire.kid.is_empty() || wire.public_key.is_empty() {
        // 声称开启加密却给不出可用公钥：后台侧配置不一致（私钥未落库等）。
        let msg = message();
        return LoginEncryption::Unavailable(if msg.is_empty() {
            "后台已开启密码加密传输但未提供公钥，请联系管理员".to_string()
        } else {
            msg
        });
    }
    LoginEncryption::Required(wire)
}

/// 进程内能力缓存：60s TTL。Mutex 里放 (取到的时刻, 配置)。
static CONFIG_CACHE: Mutex<Option<(i64, AuthConfig)>> = Mutex::new(None);

fn config_cache_get() -> Option<AuthConfig> {
    let g = CONFIG_CACHE.lock().ok()?;
    let (at, cfg) = g.as_ref()?;
    if now_secs() - at > 60 {
        return None;
    }
    Some(cfg.clone())
}

fn config_cache_put(cfg: &AuthConfig) {
    if let Ok(mut g) = CONFIG_CACHE.lock() {
        *g = Some((now_secs(), cfg.clone()));
    }
}

/// 登录加密公钥缓存：5 分钟 TTL，与 web 端 password-encryption.ts 的
/// KEY_CACHE_TTL_MS 一致。公钥在后台侧只在重新生成密钥时变化，缓存是安全的。
static KEY_CACHE: Mutex<Option<(i64, EncryptionKeyWire)>> = Mutex::new(None);

const KEY_CACHE_TTL_SECS: i64 = 300;

fn key_cache_get() -> Option<EncryptionKeyWire> {
    let g = KEY_CACHE.lock().ok()?;
    let (at, key) = g.as_ref()?;
    if now_secs() - at > KEY_CACHE_TTL_SECS {
        return None;
    }
    Some(key.clone())
}

fn key_cache_put(key: &EncryptionKeyWire) {
    if let Ok(mut g) = KEY_CACHE.lock() {
        *g = Some((now_secs(), key.clone()));
    }
}

/// 加密密码为 admin v2 信封：
/// `v2.<base64(RSA-OAEP(aes_key, label="password-v2"))>.<base64(nonce)>.<base64(ct||tag)>`
/// AAD = "password-v2:<kid>"。与 admin common/password_crypto.go::DecryptPassword
/// 及 web 端 password-encryption.ts 逐字段对齐。
fn encrypt_password_v2(password: &str, public_key_pem: &str, kid: &str) -> Result<String, String> {
    let block = pem::parse(public_key_pem).map_err(|e| format!("后台公钥无法解析: {}", e))?;
    let public_key = RsaPublicKey::from_public_key_der(block.contents())
        .map_err(|e| format!("后台公钥格式错误: {}", e))?;
    let mut aes_key = [0u8; 32];
    let mut nonce_bytes = [0u8; 12];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut aes_key);
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let padding = Oaep::new_with_label::<sha2::Sha256, _>("password-v2");
    let wrapped = public_key
        .encrypt(&mut rand::thread_rng(), padding, &aes_key)
        .map_err(|e| format!("密码加密失败: {}", e))?;
    let cipher = Aes256Gcm::new_from_slice(&aes_key)
        .map_err(|e| format!("密码加密初始化失败: {}", e))?;
    let aad = format!("password-v2:{}", kid);
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: password.as_bytes(),
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| "密码加密失败".to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD;
    Ok(format!(
        "v2.{}.{}.{}",
        b64.encode(&wrapped),
        b64.encode(&nonce_bytes),
        b64.encode(&ct)
    ))
}

impl AuthState {
    /// 探测后台账号能力（带 60s 缓存）。失败返回 None（调用方按关闭降级）。
    pub async fn auth_config(&self) -> Option<AuthConfig> {
        if let Some(cfg) = config_cache_get() {
            return Some(cfg);
        }
        let url = format!("{}/api/status", self.base_url);
        let resp = self
            .client
            .get(&url)
            .header("Accept", "application/json")
            .send()
            .await
            .ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let body = resp.text().await.ok()?;
        let v: serde_json::Value = serde_json::from_str(&body).ok()?;
        let data = v.get("data").unwrap_or(&v);
        let wire: StatusWire = serde_json::from_value(data.clone()).ok()?;
        let cfg = AuthConfig {
            email_verification: wire.email_verification,
            password_register_enabled: wire.password_register_enabled,
        };
        config_cache_put(&cfg);
        Some(cfg)
    }

    /// 取登录加密策略（admin: GET /api/user/login/encryption-key）。
    ///
    /// 该端点自身就返回 `enabled`，是「登录是否需要加密传输」的**唯一真相源**：
    /// 加密关闭时 admin 回 `{enabled:false}`（不带公钥），开启时回
    /// `{enabled:true,kid,public_key}`。
    ///
    /// 【codereview 修复 1】此前 login() 先靠 `GET /api/status` 的
    /// password_login_encryption_enabled 判断，再去取公钥。/api/status 是另一条
    /// 链路，它一旦探测失败就返回 None，login 会 `.unwrap_or(false)` 静默发明文
    /// 密码，后台则对该请求判 "Invalid parameters" —— 用户看到误导性文案，日志
    /// 里也没有指向真因的线索。现在探测链路只剩一条，少一次往返，也不存在两个
    /// 开关互相矛盾的可能。
    ///
    /// 【codereview 修复 2】判定逻辑抽成纯函数 `decide_login_encryption`，并区分
    /// 「后台确认关闭」「后台没有该端点（旧版 admin，404）」与「无法判定」三态。
    /// 上一版把取公钥失败一律当致命错误，会让对接**旧版后台**（404，且该版本
    /// 根本不校验加密）的客户端从「能登录」退化成「硬失败」。
    pub async fn login_encryption(&self) -> LoginEncryption {
        if let Some(key) = key_cache_get() {
            return if key.enabled && !key.kid.is_empty() && !key.public_key.is_empty() {
                LoginEncryption::Required(key)
            } else {
                LoginEncryption::Disabled
            };
        }
        let url = format!("{}/api/user/login/encryption-key", self.base_url);
        let resp = match self
            .client
            .get(&url)
            .header("Origin", request_origin(&self.base_url))
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                return LoginEncryption::Unavailable(format!("无法连接后台: {}", e));
            }
        };
        let status = resp.status().as_u16();
        let body = match resp.text().await {
            Ok(b) => b,
            Err(e) => {
                return LoginEncryption::Unavailable(format!("读取响应失败: {}", e));
            }
        };
        let decision = decide_login_encryption(status, &body);
        if let LoginEncryption::Required(ref wire) = decision {
            // 公钥只在后台重新生成密钥时变化，缓存与 web 端同为 5 分钟。
            key_cache_put(wire);
        } else if matches!(decision, LoginEncryption::Disabled) {
            key_cache_put(&EncryptionKeyWire::default());
        }
        decision
    }

    /// 发送注册邮箱验证码（admin: GET /api/verification?email=...）。
    /// 返回后台的 message（成功提示或精确错误）。
    pub async fn send_verification_code(&self, email: &str) -> Result<String, String> {
        let email = email.trim();
        if email.is_empty() {
            return Err("请先填写邮箱地址".to_string());
        }
        let url = format!(
            "{}/api/verification?email={}",
            self.base_url,
            urlenc(email)
        );
        let resp = self
            .client
            .get(&url)
            .header("Origin", request_origin(&self.base_url))
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| format!("无法连接后台: {}", e))?;
        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
        let v: serde_json::Value = serde_json::from_str(&body)
            .map_err(|_| format!("后台返回无法解析（{}）", status.as_u16()))?;
        let msg = v
            .get("message")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        if !status.is_success() || v.get("success").and_then(|x| x.as_bool()) == Some(false) {
            return Err(if msg.is_empty() {
                format!("验证码发送失败（HTTP {}）", status.as_u16())
            } else {
                msg
            });
        }
        Ok(if msg.is_empty() {
            "验证码已发送，请查收邮箱".to_string()
        } else {
            msg
        })
    }
}

/// 最小 URL 编码：邮箱只会出现 @ . _ - 与字母数字，其余按百分号编码。
fn urlenc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// 从 `Set-Cookie` 头里取指定 name 的 `name=value` 段。
/// 只取第一个 `;`，属性（Path/Expires/HttpOnly/SameSite）一概丢弃。
fn extract_set_cookie(headers: &reqwest::header::HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(|raw| {
            let pair = raw.split(';').next()?.trim();
            let mut parts = pair.splitn(2, '=');
            let key = parts.next()?.trim();
            let value = parts.next()?.trim();
            if key == name && !value.is_empty() {
                Some(value.to_string())
            } else {
                None
            }
        })
}

/// keyring 是同步 API，异步上下文必须 spawn_blocking（与 remote/secrets.rs 同一纪律）。
async fn keyring_load() -> Option<StoredSession> {
    async_runtime::spawn_blocking(|| {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_KEY).ok()?;
        let raw = entry.get_password().ok()?;
        serde_json::from_str::<StoredSession>(&raw).ok()
    })
    .await
    .ok()
    .flatten()
}

async fn keyring_store(s: &StoredSession) {
    let raw = match serde_json::to_string(s) {
        Ok(v) => v,
        Err(_) => return,
    };
    let _ = async_runtime::spawn_blocking(move || {
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_KEY) {
            let _ = entry.set_password(&raw);
        }
    })
    .await;
}

async fn keyring_clear() {
    let _ = async_runtime::spawn_blocking(|| {
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_KEY) {
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(_) => {}
            }
        }
    })
    .await;
}

/// 统一解析 new-api 的响应：HTTP 非 2xx 或 `success:false` 都算业务错误。
fn parse_api_response<T: for<'de> Deserialize<'de>>(
    status: reqwest::StatusCode,
    body: &str,
) -> Result<T, String> {
    let v: serde_json::Value = serde_json::from_str(body)
        .map_err(|_e| format!("后台返回无法解析（{}）", status.as_u16()))?;
    if !status.is_success() || v.get("success").and_then(|x| x.as_bool()) == Some(false) {
        // new-api 的 writeAuthSessionError 把精确原因放在 code 里，message 只是
        // HTTP StatusText（如 "Unauthorized"）。把 code 带出来，客户端才能
        // 区分「会话已撤销」与「网络/限流/后台 5xx」，避免误清用户凭据。
        let code = v
            .get("code")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("");
        let msg = v
            .get("message")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("后台返回 HTTP {}", status.as_u16()));
        return Err(if code.is_empty() {
            msg
        } else {
            format!("{} [{}]", msg, code)
        });
    }
    let data = v.get("data").cloned().unwrap_or(serde_json::Value::Null);
    serde_json::from_value(data).map_err(|e| format!("后台响应字段缺失: {}", e))
}

#[derive(Debug, Deserialize)]
struct AuthData {
    access_token: String,
    #[serde(default)]
    access_expires_at: i64,
    #[serde(default)]
    session: SessionData,
    #[serde(default)]
    user: UserData,
}

#[derive(Debug, Deserialize, Default)]
struct SessionData {
    #[serde(default)]
    sid: String,
    #[serde(default)]
    created_at: i64,
    #[serde(default)]
    expires_at: i64,
}

#[derive(Debug, Deserialize, Default)]
struct UserData {
    #[serde(default)]
    id: i64,
    #[serde(default)]
    username: String,
    #[serde(default)]
    display_name: String,
}

/// 365 天绝对上限（与 service/auth_token.go::LoginSessionAbsoluteTTL 保持一致）。
/// 产品决策：桌面端常驻保活会把 30 天空闲窗一直往前推，硬上限放宽到一年，
/// 避免常开的桌面端每季度被强制登出；两端必须同时改，否则客户端会提前
/// 臆造一个更早的到期时间。
const ABSOLUTE_TTL_SECS: i64 = 365 * 24 * 60 * 60;

fn session_from_auth_data(
    data: AuthData,
    refresh_token: String,
    fallback: Option<&StoredSession>,
) -> StoredSession {
    let sid = if data.session.sid.is_empty() {
        // refresh 响应同样带 session.sid；万一后端省略，用旧值兜底。
        fallback.map(|s| s.sid.clone()).unwrap_or_default()
    } else {
        data.session.sid.clone()
    };
    // refresh token 里的第一段就是 sid（服务端 splitRefreshToken 的契约）。
    let sid = if sid.is_empty() {
        refresh_token.split('.').next().unwrap_or("").to_string()
    } else {
        sid
    };
    let username = if data.user.username.is_empty() {
        fallback.map(|s| s.username.clone()).unwrap_or_default()
    } else {
        data.user.username.clone()
    };
    let display_name = if data.user.display_name.is_empty() {
        username.clone()
    } else {
        data.user.display_name.clone()
    };
    let user_id = if data.user.id != 0 {
        data.user.id
    } else {
        fallback.map(|s| s.user_id).unwrap_or(0)
    };
    let session_expires_at = if data.session.created_at > 0 {
        data.session.created_at + ABSOLUTE_TTL_SECS
    } else {
        // refresh 响应带的 session.created_at 是该会话创建时刻；若缺失则
        // 用「当前 idle 到期」兜底，绝不臆造一个更早的绝对上限。
        data.session.expires_at
    };
    StoredSession {
        refresh_token,
        sid,
        access_token: data.access_token,
        access_expires_at: data.access_expires_at,
        session_expires_at,
        username,
        display_name,
        user_id,
    }
}

/// 组装会话请求公共头。
/// refresh/logout 必须带 Origin（见模块头注释）；login/register 带上也无害，
/// 且能避免 secure cookie 部署下将来给这些路由补 guard 时出现不对称。
fn request_origin(base: &str) -> String {
    // 与 request.Host 同源：base 形如 https://www.gourdwork.com。
    base.trim_end_matches('/').to_string()
}

impl AuthState {
    /// 登录。成功后写内存 + keyring，并启动保活任务。
    /// 后台开启密码加密传输时，自动取公钥并以 v2 信封提交
    /// （明文 password 在该配置下会被后台判 Invalid parameters）。
    pub async fn login(&self, username: &str, password: &str) -> Result<AuthStatus, String> {
        let _guard = self.session_lock.lock().await;
        let url = format!("{}/api/user/login", self.base_url);
        let mut payload = serde_json::json!({ "username": username, "password": password });
        // 是否需要加密，只问 /api/user/login/encryption-key 这一个端点。
        // 不再依赖 /api/status 的探测结果 —— 见 login_encryption 的说明。
        match self.login_encryption().await {
            LoginEncryption::Required(key) => {
                let encrypted = encrypt_password_v2(password, &key.public_key, &key.kid)?;
                payload = serde_json::json!({
                    "username": username,
                    "password_encrypted": encrypted,
                    "encryption_key_id": key.kid,
                });
            }
            // 后台明确关闭加密，或后台是没有该端点的旧版本：明文是它认可的用法。
            LoginEncryption::Disabled | LoginEncryption::LegacyBackend => {}
            // 无法判定：绝不能静默退回明文。后台若已开启加密，明文会被判
            // "Invalid parameters"，用户只会看到误导性的「密码错误」。
            LoginEncryption::Unavailable(reason) => {
                return Err(format!(
                    "无法确认后台是否要求密码加密传输：{}（为避免用明文密码重试，已中止登录）",
                    reason
                ))
            }
        }
        let resp = self
            .client
            .post(&url)
            .header("Origin", request_origin(&self.base_url))
            .header("Accept", "application/json")
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("无法连接后台: {}", e))?;
        let status = resp.status();
        let refresh = extract_set_cookie(resp.headers(), REFRESH_COOKIE_NAME)
            .ok_or_else(|| "后台未返回登录会话（Set-Cookie 缺失）".to_string())?;
        let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
        let data: AuthData = parse_api_response(status, &body)?;
        if data.access_token.is_empty() || data.session.sid.is_empty() {
            // 两阶段验证（2FA / 邮箱 challenge）会返回非标准 data，桌面端
            // 暂不支持；明确报错而不是静默当成登录成功。
            return Err("该账号需要额外验证（两步验证/邮箱验证），请先在网页端完成".to_string());
        }
        let session = session_from_auth_data(data, refresh, None);
        self.store(Some(session.clone()));
        keyring_store(&session).await;
        self.start_keeper();
        Ok(self.status())
    }

    /// 注册。new-api 的注册接口只返回 `{success:true}` 不发 token，因此
    /// 成功后自动用同一组凭据登录，用户无需再输一次。
    ///
    /// 参数契约（admin controller/user.go::Register）：后台开启邮箱验证时
    /// `email` 与 `verification_code` 均为必填，缺任何一个都会被拒
    /// （"Email verification is enabled, please enter email address and
    /// verification code"）。验证码先经 `send_verification_code` 下发。
    pub async fn register(
        &self,
        username: &str,
        password: &str,
        email: &str,
        verification_code: &str,
    ) -> Result<AuthStatus, String> {
        let url = format!("{}/api/user/register", self.base_url);
        let mut payload = serde_json::json!({ "username": username, "password": password });
        if !email.trim().is_empty() {
            payload["email"] = serde_json::Value::String(email.trim().to_string());
        }
        if !verification_code.trim().is_empty() {
            payload["verification_code"] =
                serde_json::Value::String(verification_code.trim().to_string());
        }
        let resp = self
            .client
            .post(&url)
            .header("Origin", request_origin(&self.base_url))
            .header("Accept", "application/json")
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("无法连接后台: {}", e))?;
        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
        // 注册响应没有 data 字段，单独按 success 判定。
        let v: serde_json::Value = serde_json::from_str(&body)
            .map_err(|_| format!("后台返回无法解析（{}）", status.as_u16()))?;
        if !status.is_success() || v.get("success").and_then(|x| x.as_bool()) == Some(false) {
        // new-api 的 writeAuthSessionError 把精确原因放在 code 里，message 只是
        // HTTP StatusText（如 "Unauthorized"）。把 code 带出来，客户端才能
        // 区分「会话已撤销」与「网络/限流/后台 5xx」，避免误清用户凭据。
        let code = v
            .get("code")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("");
        let msg = v
            .get("message")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("后台返回 HTTP {}", status.as_u16()));
        return Err(if code.is_empty() {
            msg
        } else {
            format!("{} [{}]", msg, code)
        });
        }
        self.login(username, password).await
    }

    /// 刷新会话。成功后更新 access token **与** 轮换后的 refresh cookie，
    /// 后者必须写回 keyring —— 否则重启后会拿旧 secret 去 refresh，被服务端
    /// 的 replay 检测判为复用而撤销整个会话。
    pub async fn refresh(&self) -> Result<AuthStatus, String> {
        // 串行化：并发的两路 refresh 若都用旧 secret，会踩服务端的 replay
        // 检测（错开 grace window 时整个会话被撤销）。持锁后重新读取，
        // 若前一个请求已经轮换出仍然有效的新令牌，直接复用即可。
        let _guard = self.session_lock.lock().await;
        let current = self.snapshot().ok_or_else(|| "尚未登录".to_string())?;
        if current.refresh_token.is_empty() || current.sid.is_empty() {
            return Err("登录凭据不完整，请重新登录".to_string());
        }
        if current.access_expires_at > now_secs() + REFRESH_LEAD_SECS {
            // 已有有效 access token（另一路刚刷新过）：不再轮换，避免
            // 无谓消耗一次 refresh secret 并引入并发风险。
            return Ok(self.status());
        }
        let url = format!("{}/api/user/auth/refresh", self.base_url);
        let resp = self
            .client
            .post(&url)
            .header("Origin", request_origin(&self.base_url))
            .header("Accept", "application/json")
            .header("X-Auth-Session", &current.sid)
            .header(
                "Cookie",
                format!("{}={}", REFRESH_COOKIE_NAME, current.refresh_token),
            )
            .send()
            .await
            .map_err(|e| format!("无法连接后台: {}", e))?;
        let status = resp.status();
        // 轮换后的新 cookie；服务端异常时可能没有，保留旧值以免丢会话。
        let rotated = extract_set_cookie(resp.headers(), REFRESH_COOKIE_NAME)
            .unwrap_or_else(|| current.refresh_token.clone());
        let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
        let data: AuthData = parse_api_response(status, &body)?;
        if data.access_token.is_empty() {
            return Err("后台刷新未返回访问令牌".to_string());
        }
        let mut session = session_from_auth_data(data, rotated, Some(&current));
        if session.sid.is_empty() {
            session.sid = current.sid.clone();
        }
        // 绝对上限以服务端 session.created_at 为准；若 refresh 响应没带
        // created_at（旧版本后台），保留已算出的值，不要把上限拉长。
        if session.session_expires_at <= 0 {
            session.session_expires_at = current.session_expires_at;
        }
        self.store(Some(session.clone()));
        keyring_store(&session).await;
        Ok(self.status())
    }

    /// 退出登录：服务端撤销会话 + 清本地凭据。即便网络失败也必须清本地，
    /// 否则「退出」后重启又被 keyring 自动恢复成登录态。
    pub async fn logout(&self) -> Result<(), String> {
        let _guard = self.session_lock.lock().await;
        let current = self.snapshot();
        if let Some(ref s) = current {
            if !s.refresh_token.is_empty() {
                let url = format!("{}/api/user/auth/logout", self.base_url);
                let _ = self
                    .client
                    .post(&url)
                    .header("Origin", request_origin(&self.base_url))
                    .header("Accept", "application/json")
                    .header("X-Auth-Session", &s.sid)
                    .header(
                        "Cookie",
                        format!("{}={}", REFRESH_COOKIE_NAME, s.refresh_token),
                    )
                    .bearer_auth(&s.access_token)
                    .send()
                    .await;
            }
        }
        self.store(None);
        keyring_clear().await;
        Ok(())
    }

    /// 启动恢复：从 keyring 读回会话 → 立即 refresh 一次 → 启动保活。
    /// 这是「桌面端不退出就一直登录」的另一半：进程重启也算一次使用。
    pub async fn restore(&self) -> AuthStatus {
        if let Some(s) = keyring_load().await {
            self.store(Some(s));
            if let Err(e) = self.refresh().await {
                // 会话已在服务端不可恢复（绝对上限到期 / 改密码 / replay 撤销）：
                // 必须清掉 keyring 里的陈旧凭据，否则每次启动都会拿一个死会话
                // 反复重试，且「退出登录」的清除效果会被下次恢复覆盖。
                // 网络类错误保留凭据等保活任务重试，不能误清。
                if is_session_terminal_error(&e) {
                    tracing::warn!(error = %e, "stored session is no longer valid; clearing");
                    self.store(None);
                    keyring_clear().await;
                } else {
                    tracing::warn!(error = %e, "startup refresh failed (transient); will retry");
                }
            }
        }
        self.start_keeper();
        self.status()
    }

    pub fn status(&self) -> AuthStatus {
        match self.snapshot() {
            Some(s) => AuthStatus {
                signed_in: !s.access_token.is_empty() && s.access_expires_at > now_secs(),
                username: s.username,
                display_name: s.display_name,
                user_id: s.user_id,
                access_expires_at: s.access_expires_at,
                session_expires_at: s.session_expires_at,
                message: String::new(),
            },
            None => AuthStatus::default(),
        }
    }

    /// 需要鉴权的后台请求（如 /api/user/self）。access token 临近到期时先刷新。
    pub async fn authorized_get(&self, path: &str) -> Result<serde_json::Value, String> {
        if self
            .snapshot()
            .map(|s| s.access_expires_at <= now_secs() + REFRESH_LEAD_SECS)
            .unwrap_or(true)
        {
            self.refresh().await?;
        }
        let s = self.snapshot().ok_or_else(|| "尚未登录".to_string())?;
        let url = format!("{}{}", self.base_url, path);
        let resp = self
            .client
            .get(&url)
            .header("Origin", request_origin(&self.base_url))
            .header("Accept", "application/json")
            .bearer_auth(&s.access_token)
            .send()
            .await
            .map_err(|e| format!("无法连接后台: {}", e))?;
        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
        parse_api_response(status, &body)
    }

    /// 常驻保活任务：按 access_expires_at 提前刷新；失败按固定间隔重试，
    /// 网络抖动（后台暂不可达）不会把用户踢下线。
    pub fn start_keeper(&self) {
        if let Ok(mut started) = self.keeper_started.lock() {
            if *started {
                return;
            }
            *started = true;
        }
        // 直接取 Arc<AuthState> 交给 'static 任务；KeeperState 本身是静态量，
        // 不能 clone（OnceLock 没有 Clone）。
        let Some(state) = KEEPER_STATE.get() else {
            return;
        };
        async_runtime::spawn(async move {
            loop {
                let Some(s) = state.snapshot() else {
                    // 已退出：保活空转但不清 started，重新登录后立即恢复。
                    tokio::time::sleep(RETRY_INTERVAL).await;
                    continue;
                };
                let wait = (s.access_expires_at - now_secs() - REFRESH_LEAD_SECS)
                    .max(1)
                    .min(RETRY_INTERVAL.as_secs() as i64);
                tokio::time::sleep(Duration::from_secs(wait as u64)).await;
                let ok = match state.refresh().await {
                    Ok(_) => true,
                    Err(e) => {
                        tracing::warn!(error = %e, "auth keep-alive refresh failed; will retry");
                        // 会话被服务端撤销（绝对上限/改密码）时才真正清本地状态；
                        // 网络错误保留凭据，下次重试。
                        if is_session_terminal_error(&e) {
                            state.store(None);
                            keyring_clear().await;
                        }
                        false
                    }
                };
                if !ok {
                    // 关键：失败后必须退避。否则 access_expires_at 仍是过期的旧值，
                    // 循环顶部算出的 wait 会被 max(1) 压成 1 秒，于是每秒打一次
                    // refresh —— 后台暂不可达时几秒内就会撞上服务端的
                    // CriticalRateLimit（20 次 / 20 分钟）而被限流。
                    tokio::time::sleep(RETRY_INTERVAL).await;
                }
                // 成功时直接回到顶部，按新的 access_expires_at 睡到下次临期。
            }
        });
    }
}

/// 只有「会话已不可恢复」的错误才清本地；其余（超时/5xx/连接失败/限流/
/// TLS 或证书错误）一律保留凭据等下次重试。
///
/// 依据 service/auth_session.go::AuthSessionErrorCode 与
/// controller/auth_session.go::writeAuthSessionError：服务端把精确原因放在
/// `code`，`message` 只是 HTTP StatusText。绝不能用宽泛的 "invalid" 子串
/// 判断——TLS/响应解析错误也可能含它，那样会在网络抖动时把用户凭据清掉，
/// 直接破坏「不退出就一直登录」。
fn is_session_terminal_error(err: &str) -> bool {
    let upper = err.to_ascii_uppercase();
    const TERMINAL_CODES: &[&str] = &[
        "AUTH_SESSION_REVOKED",  // 会话被撤销 / 绝对上限到期 / 改密码
        "AUTH_UNAUTHORIZED",     // refresh token 无效或已过期
        "AUTH_TOKEN_EXPIRED",    // access token 过期且无有效会话
        "AUTH_SESSION_MISMATCH", // sid 与 cookie 不匹配
    ];
    // 注意 AUTH_ORIGIN_FORBIDDEN（部署配置问题）、限流、5xx、网络错误都
    // 不在列表里：它们不代表会话已死，清凭据会造成无谓登出。
    TERMINAL_CODES.iter().any(|c| upper.contains(c))
}

/// keeper 任务需要跨 `'static` 拿到 AuthState。Tauri 的 `manage` 会把它放进
/// 全局状态，这里用一个进程级 OnceLock 存 Arc，避免给每个 command 传 State
/// 生命周期参数（async command 里 `State<'_>` 跨 await 很受限）。
struct KeeperState(std::sync::OnceLock<Arc<AuthState>>);
impl KeeperState {
    const fn new() -> Self {
        Self(std::sync::OnceLock::new())
    }
    fn install(&self, state: Arc<AuthState>) {
        let _ = self.0.set(state);
    }
    fn get(&self) -> Option<Arc<AuthState>> {
        self.0.get().cloned()
    }
}
static KEEPER_STATE: KeeperState = KeeperState::new();

/// 由 lib.rs 的 setup 调用：创建状态、恢复会话、启动保活。
pub fn install(app: &tauri::AppHandle) -> Arc<AuthState> {
    use tauri::Manager;
    let state = Arc::new(AuthState::new());
    KEEPER_STATE.install(state.clone());
    app.manage(state.clone());
    let s = state.clone();
    async_runtime::spawn(async move {
        let _ = s.restore().await;
    });
    state
}

// ───────────────────────── Tauri commands ─────────────────────────

fn state_of(app: &tauri::AppHandle) -> Result<Arc<AuthState>, String> {
    use tauri::Manager;
    app.try_state::<Arc<AuthState>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| "账号模块未初始化".to_string())
}

#[tauri::command]
pub async fn auth_status(app: tauri::AppHandle) -> Result<AuthStatus, String> {
    Ok(state_of(&app)?.status())
}

#[tauri::command]
pub async fn auth_login(
    app: tauri::AppHandle,
    username: String,
    password: String,
) -> Result<AuthStatus, String> {
    state_of(&app)?.login(&username, &password).await
}

#[tauri::command]
pub async fn auth_register(
    app: tauri::AppHandle,
    username: String,
    password: String,
    email: String,
    verification_code: String,
) -> Result<AuthStatus, String> {
    state_of(&app)?
        .register(&username, &password, &email, &verification_code)
        .await
}

#[tauri::command]
pub async fn auth_send_code(app: tauri::AppHandle, email: String) -> Result<String, String> {
    state_of(&app)?.send_verification_code(&email).await
}

#[tauri::command]
pub async fn auth_config(app: tauri::AppHandle) -> Result<AuthConfig, String> {
    state_of(&app)?
        .auth_config()
        .await
        .ok_or_else(|| "后台暂不可用，无法获取注册配置".to_string())
}

#[tauri::command]
pub async fn auth_logout(app: tauri::AppHandle) -> Result<AuthStatus, String> {
    state_of(&app)?.logout().await?;
    Ok(state_of(&app)?.status())
}

#[tauri::command]
pub async fn auth_refresh(app: tauri::AppHandle) -> Result<AuthStatus, String> {
    state_of(&app)?.refresh().await
}

#[tauri::command]
pub async fn auth_self(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    state_of(&app)?.authorized_get("/api/user/self").await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_named_cookie_from_set_cookie_header() {
        let mut h = reqwest::header::HeaderMap::new();
        h.append(
            reqwest::header::SET_COOKIE,
            "new_api_has_session=1; Path=/; SameSite=Strict"
                .parse()
                .unwrap(),
        );
        h.append(
            reqwest::header::SET_COOKIE,
            "new_api_refresh=sid123.secret456; Path=/api/user/auth; HttpOnly; SameSite=Strict; Max-Age=2592000"
                .parse()
                .unwrap(),
        );
        assert_eq!(
            extract_set_cookie(&h, REFRESH_COOKIE_NAME),
            Some("sid123.secret456".to_string())
        );
        assert_eq!(extract_set_cookie(&h, "absent"), None);
    }

    #[test]
    fn session_from_login_response_derives_absolute_ceiling() {
        let data: AuthData = serde_json::from_value(serde_json::json!({
            "access_token": "jwt",
            "access_expires_at": 1700000900,
            "session": { "sid": "s1", "created_at": 1700000000, "expires_at": 1702592000 },
            "user": { "id": 7, "username": "alice", "display_name": "Alice" }
        }))
        .unwrap();
        let s = session_from_auth_data(data, "s1.secret".into(), None);
        assert_eq!(s.sid, "s1");
        assert_eq!(s.refresh_token, "s1.secret");
        assert_eq!(s.session_expires_at, 1700000000 + ABSOLUTE_TTL_SECS);
        assert_eq!(s.username, "alice");
    }

    #[test]
    fn refresh_response_without_user_keeps_identity() {
        let old = StoredSession {
            sid: "s1".into(),
            refresh_token: "old".into(),
            access_token: "old-jwt".into(),
            username: "alice".into(),
            display_name: "Alice".into(),
            user_id: 7,
            access_expires_at: 1,
            session_expires_at: 2,
        };
        let data: AuthData = serde_json::from_value(serde_json::json!({
            "access_token": "new-jwt",
            "access_expires_at": 1700001800,
            "session": { "sid": "s1", "created_at": 1700000000, "expires_at": 1702592000 }
        }))
        .unwrap();
        let s = session_from_auth_data(data, "s1.newsecret".into(), Some(&old));
        assert_eq!(s.username, "alice");
        assert_eq!(s.user_id, 7);
        assert_eq!(s.refresh_token, "s1.newsecret");
    }

    #[test]
    fn terminal_errors_are_distinguished_from_transient_errors() {
        assert!(is_session_terminal_error("Unauthorized [AUTH_SESSION_REVOKED]"));
        assert!(is_session_terminal_error("Unauthorized [AUTH_UNAUTHORIZED]"));
        assert!(!is_session_terminal_error("无法连接后台: connection timed out"));
        assert!(!is_session_terminal_error("后台返回 HTTP 500"));
        assert!(!is_session_terminal_error("后台返回 HTTP 429 [AUTH_RATE_LIMIT]"));
        assert!(!is_session_terminal_error("Forbidden [AUTH_ORIGIN_FORBIDDEN]"));
        // 关键回归：宽泛的 "invalid" 子串（TLS/解析错误）绝不能被当作会话已死。
        assert!(!is_session_terminal_error("invalid peer certificate"));
    }

    #[test]
    fn api_error_response_is_rejected_with_message() {
        let err = parse_api_response::<AuthData>(
            reqwest::StatusCode::OK,
            r#"{"success":false,"message":"用户名或密码错误"}"#,
        )
        .unwrap_err();
        assert!(err.contains("用户名或密码错误"));
    }

    /// v2 信封必须能被 admin 的 DecryptPassword 语义解开：结构 4 段、
    /// wrapped key 长度 = RSA 模长、nonce 12 字节、AAD 绑定 kid。
    /// 这里用 rsa 私钥自签自解，防止信封拼装顺序/标签漂移。
    #[test]
    fn v2_envelope_roundtrips_with_admin_decrypt_semantics() {
        use rsa::pkcs8::EncodePublicKey;
        use rsa::traits::PublicKeyParts;
        use rsa::RsaPrivateKey;
        let mut rng = rand::thread_rng();
        let priv_key = RsaPrivateKey::new(&mut rng, 2048).unwrap();
        let pub_pem = pem::encode(&pem::Pem::new(
            "PUBLIC KEY",
            priv_key
                .to_public_key()
                .to_public_key_der()
                .unwrap()
                .to_vec(),
        ));
        let kid = "test-kid-1";
        let envelope = encrypt_password_v2("pässwörd-中文-12345678", &pub_pem, kid).unwrap();
        let parts: Vec<&str> = envelope.split('.').collect();
        assert_eq!(parts.len(), 4);
        assert_eq!(parts[0], "v2");
        let b64 = base64::engine::general_purpose::STANDARD;
        let wrapped = b64.decode(parts[1]).unwrap();
        let nonce = b64.decode(parts[2]).unwrap();
        let ct = b64.decode(parts[3]).unwrap();
        assert_eq!(wrapped.len(), priv_key.size());
        assert_eq!(nonce.len(), 12);
        assert!(ct.len() > 16);
        // 按 admin password_crypto.go 的解密路径还原明文。
        let aes_key = rsa::Oaep::new_with_label::<sha2::Sha256, _>("password-v2");
        let key = priv_key.decrypt(aes_key, &wrapped).unwrap();
        assert_eq!(key.len(), 32);
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let aad = format!("password-v2:{}", kid);
        let plain = cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ct,
                    aad: aad.as_bytes(),
                },
            )
            .unwrap();
        assert_eq!(String::from_utf8(plain).unwrap(), "pässwörd-中文-12345678");
        // kid 不匹配（AAD 被篡改）必须解密失败。
        let bad = cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ct,
                    aad: b"password-v2:other-kid",
                },
            )
            .is_err();
        assert!(bad, "AAD must bind the key id");
    }

    #[test]
    fn urlenc_escapes_at_sign_for_query() {
        assert_eq!(urlenc("a@b.com"), "a%40b.com");
        assert_eq!(urlenc("a-b_c.d~e"), "a-b_c.d~e");
    }

    // ───── 登录加密判定（decide_login_encryption）─────
    //
    // 这组测试是 M5「探测失败即静默发明文」缺陷的真实护栏：判定被抽成纯函数
    // 后，每个分支都能被直接断言，把 `.await?` 换成 `.unwrap_or_default()`
    // 之类的降级会让 `unavailable_must_not_be_treated_as_plaintext` 变红。
    // 文本匹配（src.includes("password_encrypted")）挡不住这类变异 —— 变异
    // 测试实测其 SURVIVE。

    fn ok_body(data: serde_json::Value) -> String {
        serde_json::json!({ "success": true, "message": "", "data": data }).to_string()
    }

    #[test]
    fn encryption_enabled_with_usable_key_requires_v2_envelope() {
        let body = ok_body(serde_json::json!({
            "enabled": true,
            "kid": "abc123",
            "public_key": "-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----"
        }));
        match decide_login_encryption(200, &body) {
            LoginEncryption::Required(k) => {
                assert_eq!(k.kid, "abc123");
                assert!(k.public_key.contains("PUBLIC KEY"));
                assert!(decide_login_encryption(200, &body).is_required());
            }
            other => panic!("expected Required, got {:?}", other),
        }
    }

    #[test]
    fn backend_confirms_encryption_off_is_plaintext_login() {
        // admin GetPasswordEncryptionKey：未开启时只回 {enabled:false}
        let body = ok_body(serde_json::json!({ "enabled": false }));
        assert_eq!(decide_login_encryption(200, &body), LoginEncryption::Disabled);
        assert!(!decide_login_encryption(200, &body).is_required());
    }

    #[test]
    fn legacy_backend_without_the_endpoint_falls_back_to_plaintext() {
        // 旧版 admin 没有 /api/user/login/encryption-key，路由 404。
        // 该版本也不校验加密，因此必须允许明文，否则升级前能登录的部署会硬失败。
        assert_eq!(
            decide_login_encryption(404, "<html>404 page not found</html>"),
            LoginEncryption::LegacyBackend
        );
        assert_eq!(decide_login_encryption(404, ""), LoginEncryption::LegacyBackend);
    }

    /// admin 的 `ApiErrorT` 走 `ApiErrorStatus(c, http.StatusOK, ...)`：
    /// **业务错误的 HTTP 状态码是 200**，只靠 `status.is_success()` 判定会漏。
    /// 典型场景：后台开了加密但私钥未落库 → 200 + success:false。
    #[test]
    fn admin_business_error_carries_http_200_and_must_not_be_plaintext() {
        let body = serde_json::json!({
            "success": false,
            "message": "Database error, please contact the administrator"
        })
        .to_string();
        match decide_login_encryption(200, &body) {
            LoginEncryption::Unavailable(msg) => assert!(msg.contains("Database error")),
            other => panic!("HTTP 200 + success:false must be Unavailable, got {:?}", other),
        }
    }

    #[test]
    fn enabled_but_missing_public_key_is_unavailable_not_plaintext() {
        let body = ok_body(serde_json::json!({ "enabled": true, "kid": "k1", "public_key": "" }));
        assert!(matches!(
            decide_login_encryption(200, &body),
            LoginEncryption::Unavailable(_)
        ));
        let body2 = ok_body(serde_json::json!({ "enabled": true, "kid": "", "public_key": "pem" }));
        assert!(matches!(
            decide_login_encryption(200, &body2),
            LoginEncryption::Unavailable(_)
        ));
    }

    #[test]
    fn transport_and_parse_failures_are_unavailable() {
        assert!(matches!(
            decide_login_encryption(500, "internal error"),
            LoginEncryption::Unavailable(_)
        ));
        assert!(matches!(
            decide_login_encryption(502, "<html>Bad Gateway</html>"),
            LoginEncryption::Unavailable(_)
        ));
        // 200 但响应体不是 JSON（网关/代理插入了 HTML）
        assert!(matches!(
            decide_login_encryption(200, "<html>ok</html>"),
            LoginEncryption::Unavailable(_)
        ));
        // 200 + JSON 但没有 success 字段：不可信，按无法判定处理
        assert!(matches!(
            decide_login_encryption(200, "{\"data\":{}}"),
            LoginEncryption::Unavailable(_)
        ));
    }

    /// M5 的语义级护栏：任何「无法判定」都不得被当成「后台确认关闭」。
    /// 这条断言把三态与二值压平区分开来 —— 若有人把 Unavailable 归并进
    /// Disabled（即恢复静默发明文的老行为），此测试立即变红。
    #[test]
    fn unavailable_must_not_be_treated_as_plaintext() {
        let untrusted = [
            (500u16, "boom".to_string()),
            (200, "{\"success\":false,\"message\":\"no key\"}".to_string()),
            (200, "not json at all".to_string()),
            (
                200,
                ok_body(serde_json::json!({ "enabled": true, "kid": "k", "public_key": "" })),
            ),
        ];
        for (status, body) in untrusted {
            let d = decide_login_encryption(status, &body);
            assert!(
                matches!(d, LoginEncryption::Unavailable(_)),
                "status={} body={} must stay Unavailable, got {:?}",
                status,
                body,
                d
            );
            assert_ne!(d, LoginEncryption::Disabled, "must not fall back to plaintext");
            assert_ne!(d, LoginEncryption::LegacyBackend, "must not fall back to plaintext");
            assert!(!d.is_required());
        }
        // 反向对照：只有这两种才允许明文。
        assert!(matches!(
            decide_login_encryption(404, "nope"),
            LoginEncryption::LegacyBackend
        ));
        assert!(matches!(
            decide_login_encryption(200, &ok_body(serde_json::json!({"enabled": false}))),
            LoginEncryption::Disabled
        ));
    }
}
