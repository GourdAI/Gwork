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
    pub async fn login(&self, username: &str, password: &str) -> Result<AuthStatus, String> {
        let _guard = self.session_lock.lock().await;
        let url = format!("{}/api/user/login", self.base_url);
        let resp = self
            .client
            .post(&url)
            .header("Origin", request_origin(&self.base_url))
            .header("Accept", "application/json")
            .json(&serde_json::json!({ "username": username, "password": password }))
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
    pub async fn register(
        &self,
        username: &str,
        password: &str,
        email: &str,
    ) -> Result<AuthStatus, String> {
        let url = format!("{}/api/user/register", self.base_url);
        let mut payload = serde_json::json!({ "username": username, "password": password });
        if !email.trim().is_empty() {
            payload["email"] = serde_json::Value::String(email.trim().to_string());
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
) -> Result<AuthStatus, String> {
    state_of(&app)?
        .register(&username, &password, &email)
        .await
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
}
