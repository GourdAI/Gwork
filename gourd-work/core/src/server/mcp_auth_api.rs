//! server::mcp_auth_api — 连接器认证（MCP connector auth）的 6 个 axum handler。
//!
//! 安全边界（务必保持）：**凭据只落本机 `<home>/.gwork/mcp-credentials.json`，
//! 不进 settings.json，不返回 token 值**。本模块对 `settings.json` 只有只读访问，
//! 其中 `mcpServers[name]` 仅保存非密钥的认证声明（`authType` 与令牌弹窗文案）。
//! 静态 token 与 OAuth token 一律交给 `crate::mcp::auth::CredentialVault`；
//! 所有响应都只报告「有没有凭据」，绝不携带凭据值、`Authorization` 头值或
//! 密钥派生信息，也绝不把用户输入的 token 写回 settings.json。
//!
//! | Method | Path                                      | 用途 |
//! |--------|-------------------------------------------|------|
//! | GET    | `/web/settings/mcp/auth/state?name=`      | 认证声明 + 是否已有凭据 |
//! | POST   | `/web/settings/mcp/auth/start`            | 启动 OAuth，返回浏览器 URL |
//! | GET    | `/web/settings/mcp/auth/status?name=`     | 轮询授权会话 |
//! | POST   | `/web/settings/mcp/auth/cancel`           | 取消授权会话 |
//! | POST   | `/web/settings/mcp/auth/token`            | 保存静态 token 到本机凭据库 |
//! | POST   | `/web/settings/mcp/auth/clear`            | 清除该服务器的全部凭据 |
//!
//! 响应统一为 `Json<serde_json::Value>`，成功 `{ok:true, ...}`、失败
//! `{ok:false, error:"..."}`；不使用 HTTP 4xx/5xx 表达业务失败，与既有
//! settings 面板的 ajax 取值方式保持一致。

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use super::AppState;
use crate::mcp::auth::{AuthKind, AuthPhase, AuthSpec, StaticToken};
use crate::mcp::McpServerConfig;

// ─── Query / body shapes ─────────────────────────────────────────────────────

/// `GET` 端点共用的 `?name=` 查询参数。
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct NameQuery {
    pub name: String,
}

/// `POST` 端点共用的 `{"name": ...}` 请求体。
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct NameBody {
    pub name: String,
}

/// `/auth/token` 的请求体。`token` 只在本次请求的内存中存在，落盘目标是
/// 本机凭据库，settings.json 与所有响应都不含它。
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct TokenBody {
    pub name: String,
    pub token: String,
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/// 只读地取出 `settings.json` 里的 `mcpServers[name]`。
///
/// 与 `settings_api::read_settings_key` 等价的读取策略（含 BOM 剥离、缺失/损坏
/// 文件一律视为「无此连接器」），但刻意实现在本文件内：该文件由主代理并行维护，
/// 其 `read_settings_key` 是私有的，且本模块不需要任何写入路径。
async fn read_mcp_entry(name: &str) -> Option<Value> {
    let path = crate::config::Settings::gwork_home().join("settings.json");
    let text = tokio::fs::read_to_string(&path).await.ok()?;
    let trimmed = crate::config::strip_bom(&text).trim();
    if trimmed.is_empty() {
        return None;
    }
    let root: Value = serde_json::from_str(trimmed).ok()?;
    root.get("mcpServers")?.as_object()?.get(name).cloned()
}

/// 把一条 settings 记录解析成 `McpServerConfig`（带 `#[serde(default)]`）。
///
/// 只用于取 `url` 与交给 `AuthManager::start` 的连接配置；未知字段被 serde
/// 忽略，解析失败退化为默认值而不是让整个端点 500。
fn config_of(entry: &Value) -> McpServerConfig {
    serde_json::from_value::<McpServerConfig>(entry.clone()).unwrap_or_default()
}

/// `AuthSpec::from_entry` 的键名兼容层。
///
/// settings.json 里的声明是 camelCase（`authType` / `tokenLabel` /
/// `tokenHelpUrl` / ...），且可能嵌套在 `auth` 对象里，也可能是扁平的旧写法；
/// 而 `AuthSpec` 是普通 serde 结构体，字段命名策略由 `mcp::auth` 决定
/// （snake_case、camelCase、或逐字段 `alias` 都可能出现，该文件正由主代理并行维护）。
/// 因此这里构造两份**各自只含一种命名**的视图分别交给 `from_entry`，再把结果
/// 逐字段合并（非空者优先）：既能在任何命名策略下读出声明，又不会因同一视图里
/// 同时出现主名与 alias 而触发 serde 的 duplicate field 错误。
/// 优先顺序与 `from_entry` 一致：嵌套 `auth` 对象优先，外层扁平键仅作补充。
fn auth_spec_for(entry: &Value) -> AuthSpec {
    /// (camelCase, snake_case)
    const FIELDS: &[(&str, &str)] = &[
        ("authType", "auth_type"),
        ("tokenLabel", "token_label"),
        ("tokenHelpUrl", "token_help_url"),
        ("tokenHelpText", "token_help_text"),
        ("tokenHeader", "token_header"),
        ("tokenPrefix", "token_prefix"),
        ("clientId", "client_id"),
        ("authDeviceFlow", "auth_device_flow"),
        ("authQrModal", "auth_qr_modal"),
        ("deviceAuthorizationEndpoint", "device_authorization_endpoint"),
        ("devicePollIntervalSecs", "device_poll_interval_secs"),
    ];

    let source = entry.get("auth").filter(|v| v.is_object()).unwrap_or(entry);
    let mut camel = serde_json::Map::new();
    let mut snake = serde_json::Map::new();
    for (c, s) in FIELDS {
        let Some(v) = source
            .get(*c)
            .or_else(|| source.get(*s))
            .or_else(|| entry.get(*c))
            .or_else(|| entry.get(*s))
            .cloned()
        else {
            continue;
        };
        camel.insert((*c).to_string(), v.clone());
        snake.insert((*s).to_string(), v);
    }
    // `scopes` 单独成第三个视图：一旦它的类型不合法（例如上游给了字符串），
    // serde 只会让这一个视图退化为默认值，不会连累 authType / 弹窗文案。
    let mut scopes_only = serde_json::Map::new();
    if let Some(v) = source
        .get("scopes")
        .or_else(|| entry.get("scopes"))
        .cloned()
    {
        scopes_only.insert("scopes".to_string(), v);
    }

    let from_camel = AuthSpec::from_entry(&Value::Object(camel));
    let from_snake = AuthSpec::from_entry(&Value::Object(snake));
    let from_scopes = AuthSpec::from_entry(&Value::Object(scopes_only));
    merge_specs(from_snake, from_camel, from_scopes.scopes)
}

/// 逐字段取「非空者优先」。用 `Default` + 赋值而非结构体字面量，
/// 上游给 `AuthSpec` 增字段时不会让本文件编译失败。
fn merge_specs(primary: AuthSpec, fallback: AuthSpec, scopes: Vec<String>) -> AuthSpec {
    fn pick(a: String, b: String) -> String {
        if a.trim().is_empty() { b } else { a }
    }
    let mut out = AuthSpec::default();
    out.auth_type = pick(primary.auth_type, fallback.auth_type);
    out.token_label = pick(primary.token_label, fallback.token_label);
    out.token_help_url = pick(primary.token_help_url, fallback.token_help_url);
    out.token_help_text = pick(primary.token_help_text, fallback.token_help_text);
    out.token_header = pick(primary.token_header, fallback.token_header);
    out.token_prefix = pick(primary.token_prefix, fallback.token_prefix);
    out.client_id = pick(primary.client_id, fallback.client_id);
    out.scopes = if primary.scopes.is_empty() {
        if fallback.scopes.is_empty() { scopes } else { fallback.scopes }
    } else {
        primary.scopes
    };
    out.auth_device_flow = primary.auth_device_flow || fallback.auth_device_flow;
    out.auth_qr_modal = primary.auth_qr_modal || fallback.auth_qr_modal;
    out.device_authorization_endpoint = pick(
        primary.device_authorization_endpoint,
        fallback.device_authorization_endpoint,
    );
    out.device_poll_interval_secs = if primary.device_poll_interval_secs > 0 {
        primary.device_poll_interval_secs
    } else {
        fallback.device_poll_interval_secs
    };
    out
}

/// `AuthPhase` 的 wire 名称。显式 match 而不是 `serde_json::to_value`：前端
/// (`app-mcp-auth.js`) 硬编码比较 `done` / `failed` / `cancelled` / `idle`，
/// 这里自己锁定 snake_case，上游 serde 策略的变化不会悄悄改掉线上契约。
fn phase_value(phase: AuthPhase) -> Value {
    match phase {
        AuthPhase::Preparing => json!("preparing"),
        AuthPhase::WaitingForBrowser => json!("waiting_for_browser"),
        AuthPhase::Exchanging => json!("exchanging"),
        AuthPhase::Done => json!("done"),
        AuthPhase::Failed => json!("failed"),
        AuthPhase::Cancelled => json!("cancelled"),
    }
}

/// 当前 epoch 秒，写入 `StaticToken::stored_at`。
fn now_epoch_secs() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// `/auth/state` 成功响应的唯一构造器：`connected` 与 `needsAuth` 的规则
/// 只在这里定义一次，便于纯函数测试断言形状。
fn state_payload(
    name: &str,
    auth_type: &str,
    has_credential: bool,
    label: &str,
    help_url: &str,
    help_text: &str,
    phase: Value,
    error: Option<String>,
    device_flow: bool,
    qr_modal: bool,
) -> Value {
    json!({
        "ok": true,
        "name": name,
        "authType": auth_type,
        "connected": has_credential,
        "needsAuth": auth_type != "none" && !has_credential,
        "hasCredential": has_credential,
        "label": label,
        "helpUrl": help_url,
        "helpText": help_text,
        "phase": phase,
        "error": error,
        // Non-secret presentation metadata for the two WorkBuddy-style flows.
        "authDeviceFlow": device_flow,
        "authQrModal": qr_modal,
    })
}

fn ok_payload() -> Value {
    json!({"ok": true})
}

fn error_payload(message: impl Into<String>) -> Value {
    json!({"ok": false, "error": message.into()})
}

// ─── Handlers ───────────────────────────────────────────────────────────────

/// `GET /web/settings/mcp/auth/state?name=` — 认证声明 + 凭据存在性。
///
/// `hasCredential` = 本机凭据库里存在该 URL 的 OAuth 凭据或静态 token；
/// `connected` 按约定简化为与 `hasCredential` 相同；`needsAuth` 只在声明了
/// token/oauth 且尚无凭据时为真。`phase` / `error` 在此固定为 `idle` / `null`：
/// 授权会话的状态由 `/auth/status` 独占轮询，避免本端点消费掉
/// `AuthManager::status` 的终态结果（Done/Failed/Cancelled）。
pub async fn mcp_auth_state(
    State(state): State<Arc<AppState>>,
    Query(q): Query<NameQuery>,
) -> Json<Value> {
    let name = q.name.trim().to_string();
    let Some(entry) = read_mcp_entry(&name).await else {
        return Json(error_payload("connector not found"));
    };

    let spec = auth_spec_for(&entry);
    let config = config_of(&entry);
    let url = config.url.trim();
    let vault = state.mcp_auth.vault();
    let has_credential = !url.is_empty()
        && (vault.has_oauth(url).await || vault.get_static(url).await.is_some());

    Json(state_payload(
        &name,
        spec.kind().as_str(),
        has_credential,
        &spec.token_label,
        &spec.token_help_url,
        &spec.token_help_text,
        json!("idle"),
        None,
        spec.auth_device_flow,
        spec.auth_qr_modal,
    ))
}

/// `POST /web/settings/mcp/auth/device/start` — RFC 8628 Device Flow.
///
/// Only for connectors declaring `authDeviceFlow: true`. Unlike `/auth/start`
/// it returns `userCode` + `verificationUri` (no system browser); the UI shows
/// a QR/code modal and the background task polls the token endpoint itself.
pub async fn mcp_auth_device_start(
    State(state): State<Arc<AppState>>,
    Json(body): Json<NameBody>,
) -> Json<Value> {
    let name = body.name.trim().to_string();
    let Some(entry) = read_mcp_entry(&name).await else {
        return Json(error_payload("connector not found"));
    };
    let spec = auth_spec_for(&entry);
    if spec.kind() != AuthKind::Oauth || !spec.auth_device_flow {
        return Json(error_payload("connector does not declare authDeviceFlow with authType=oauth"));
    }
    let config = config_of(&entry);
    // Honour the user's 「MCP 重试次数」 setting (default 3) as the
    // transient-failure budget for device polling, rather than hardcoding a
    // second number that would silently diverge from a knob the user can see
    // and change on the general settings page.
    //
    // Clamped here even though the settings-update path already clamps to
    // [1,10]: `Settings` deserialized straight from disk is **not** clamped
    // (see `web_tool_keys_use_java_wire_names_and_safe_defaults`), so a
    // hand-edited settings.json could otherwise ask for thousands of retries.
    // Same defence-in-depth as `web_retry::RetryPolicy::from_settings`, which
    // re-clamps at its own consumption point for the same reason.
    let transient_budget = state.settings.read().await.general.mcp_retries.clamp(1, 10);
    match state.mcp_auth.start_device(&name, &config, &spec, transient_budget).await {
        Ok(s) => Json(json!({
            "ok": true,
            "phase": "waiting_for_browser",
            "userCode": s.user_code,
            "verificationUri": s.verification_uri,
            "expiresIn": s.expires_in,
        })),
        Err(e) => Json(error_payload(e.to_string())),
    }
}

/// `POST /web/settings/mcp/auth/start` — 仅对 `authType: oauth` 启动浏览器授权。
///
/// 成功时立即返回 `authorizationUrl`（会话在后台继续完成回调与换 token）；
/// token 型连接器必须使用 `/auth/token`。
pub async fn mcp_auth_start(
    State(state): State<Arc<AppState>>,
    Json(body): Json<NameBody>,
) -> Json<Value> {
    let name = body.name.trim().to_string();
    let Some(entry) = read_mcp_entry(&name).await else {
        return Json(error_payload("connector not found"));
    };

    let spec = auth_spec_for(&entry);
    match spec.kind() {
        AuthKind::Oauth => {
            let config = config_of(&entry);
            match state.mcp_auth.start(&name, &config, &spec).await {
                Ok(authorization_url) => Json(json!({
                    "ok": true,
                    "phase": "waiting_for_browser",
                    "authorizationUrl": authorization_url,
                })),
                Err(e) => Json(error_payload(e.to_string())),
            }
        }
        AuthKind::Token => Json(error_payload("use /auth/token")),
        AuthKind::None => Json(error_payload("connector does not require authorization")),
    }
}

/// `GET /web/settings/mcp/auth/status?name=` — 轮询授权会话。
///
/// 无会话返回 `phase:"idle"`；有会话返回 snake_case 的阶段、浏览器 URL、
/// 错误信息与会话名。终态由 `AuthManager::status` 在本次轮询后清理。
pub async fn mcp_auth_status(
    State(state): State<Arc<AppState>>,
    Query(q): Query<NameQuery>,
) -> Json<Value> {
    let name = q.name.trim().to_string();
    match state.mcp_auth.status(&name).await {
        None => Json(json!({"ok": true, "phase": "idle"})),
        Some(s) => Json(json!({
            "ok": true,
            "phase": phase_value(s.phase),
            "authorizationUrl": s.authorization_url,
            "userCode": s.user_code,
            "verificationUri": s.verification_uri,
            "expiresIn": s.expires_in,
            "error": s.error,
            "name": s.name,
        })),
    }
}

/// `POST /web/settings/mcp/auth/cancel` — 取消在途授权会话。
pub async fn mcp_auth_cancel(
    State(state): State<Arc<AppState>>,
    Json(body): Json<NameBody>,
) -> Json<Value> {
    let cancelled = state.mcp_auth.cancel(body.name.trim()).await;
    Json(json!({"ok": cancelled}))
}

/// `POST /web/settings/mcp/auth/token` — 保存静态 token 到本机凭据库。
///
/// 校验顺序：token 非空 → 连接器存在 → 声明为 `authType: token` → URL 非空。
/// 只写 `CredentialVault`（键由服务器 URL 规范化），不写 settings.json，
/// 成功响应只有 `{ok:true}`。
pub async fn mcp_auth_token(
    State(state): State<Arc<AppState>>,
    Json(body): Json<TokenBody>,
) -> Json<Value> {
    if body.token.trim().is_empty() {
        return Json(error_payload("token is required"));
    }
    let name = body.name.trim().to_string();
    let Some(entry) = read_mcp_entry(&name).await else {
        return Json(error_payload("connector not found"));
    };

    let spec = auth_spec_for(&entry);
    if spec.kind() != AuthKind::Token {
        return Json(error_payload("connector is not authType=token"));
    }
    let config = config_of(&entry);
    if config.url.trim().is_empty() {
        return Json(error_payload("connector has no URL"));
    }

    let stored = StaticToken {
        value: body.token,
        header: spec.header_name(),
        prefix: spec.prefix(),
        stored_at: now_epoch_secs(),
    };
    match state.mcp_auth.vault().set_static(&config.url, stored).await {
        Ok(()) => Json(ok_payload()),
        Err(e) => Json(error_payload(e.to_string())),
    }
}

/// `POST /web/settings/mcp/auth/clear` — 清除该连接器的 OAuth 与静态凭据。
pub async fn mcp_auth_clear(
    State(state): State<Arc<AppState>>,
    Json(body): Json<NameBody>,
) -> Json<Value> {
    let name = body.name.trim().to_string();
    let Some(entry) = read_mcp_entry(&name).await else {
        return Json(error_payload("connector not found"));
    };
    let config = config_of(&entry);
    match state.mcp_auth.vault().clear_all(&config.url).await {
        Ok(()) => Json(ok_payload()),
        Err(e) => Json(error_payload(e.to_string())),
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_spec_for_reads_nested_camel_case_and_flat_legacy_declarations() {
        let nested = json!({
            "type": "streamable",
            "url": "https://mcp.example/mcp",
            "auth": {
                "authType": "token",
                "tokenLabel": "D&B Access Token",
                "tokenHelpUrl": "https://example.com/token",
                "tokenHelpText": "only stored locally",
                "tokenHeader": "X-Api-Key",
                "tokenPrefix": "none",
                "clientId": "client-1",
                "scopes": ["mcp.read"]
            }
        });
        let spec = auth_spec_for(&nested);
        assert_eq!(spec.kind(), AuthKind::Token);
        assert_eq!(spec.token_label, "D&B Access Token");
        assert_eq!(spec.token_help_url, "https://example.com/token");
        assert_eq!(spec.token_help_text, "only stored locally");
        assert_eq!(spec.header_name(), "X-Api-Key");
        assert_eq!(spec.prefix(), "");
        assert_eq!(spec.client_id, "client-1");
        assert_eq!(spec.scopes, vec!["mcp.read".to_string()]);

        let flat = json!({"authType": "oauth", "tokenLabel": "Login"});
        assert_eq!(auth_spec_for(&flat).kind(), AuthKind::Oauth);
        assert_eq!(auth_spec_for(&flat).token_label, "Login");

        // 嵌套声明优先于外层扁平的旧拼写。
        let mixed = json!({
            "authType": "token",
            "auth": {"authType": "oauth"}
        });
        assert_eq!(auth_spec_for(&mixed).kind(), AuthKind::Oauth);

        let legacy = json!({"type": "stdio", "command": "npx"});
        assert_eq!(auth_spec_for(&legacy).kind(), AuthKind::None);
        assert_eq!(auth_spec_for(&legacy).header_name(), "Authorization");
        assert_eq!(auth_spec_for(&legacy).prefix(), "Bearer ");
    }

    #[test]
    fn static_token_serialization_is_exact_and_no_response_exposes_the_secret() {
        let stored = StaticToken {
            value: "s3cr3t".to_string(),
            header: "Authorization".to_string(),
            prefix: "Bearer ".to_string(),
            stored_at: 1,
        };
        let serialized = serde_json::to_value(&stored).unwrap();
        let mut keys: Vec<&str> = serialized
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort();
        assert_eq!(keys, vec!["header", "prefix", "stored_at", "value"]);

        // 凭据库里的记录确实持有值；但任何 HTTP 响应都不能持有它。
        assert_eq!(serialized["value"], json!("s3cr3t"));
        let responses = vec![
            ok_payload(),
            error_payload("bad request"),
            state_payload(
                "svc",
                "token",
                true,
                "Access Token",
                "https://example.com/token",
                "local only",
                json!("idle"),
                None,
                false,
                false,
            ),
            json!({"ok": true, "phase": "waiting_for_browser", "authorizationUrl": "https://as.example/authorize"}),
            json!({"ok": true, "phase": "idle"}),
            json!({"ok": true, "phase": "done", "authorizationUrl": null, "error": null, "name": "svc"}),
        ];
        for response in &responses {
            let rendered = serde_json::to_string(response).unwrap();
            assert!(!rendered.contains("s3cr3t"), "response leaked the token: {rendered}");
            assert!(response.get("token").is_none(), "response has a token field");
            assert!(response.get("value").is_none(), "response has a value field");
            assert!(response.get("authorization").is_none());
        }

        let body: TokenBody =
            serde_json::from_value(json!({"name": "svc", "token": "s3cr3t"})).unwrap();
        assert_eq!(body.name, "svc");
        assert_eq!(body.token, "s3cr3t");
    }

    #[test]
    fn state_payload_shape_and_flags_are_stable() {
        let payload = state_payload(
            "dnb",
            "oauth",
            false,
            "Token",
            "https://help",
            "local",
            json!("idle"),
            None,
            true,   // authDeviceFlow
            false,  // authQrModal
        );
        let mut keys: Vec<&str> = payload.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(
            keys,
            vec![
                "authDeviceFlow",
                "authQrModal",
                "authType",
                "connected",
                "error",
                "hasCredential",
                "helpText",
                "helpUrl",
                "label",
                "name",
                "needsAuth",
                "ok",
                "phase",
            ]
        );
        assert_eq!(payload["ok"], json!(true));
        assert_eq!(payload["name"], json!("dnb"));
        assert_eq!(payload["authType"], json!("oauth"));
        assert_eq!(payload["connected"], json!(false));
        assert_eq!(payload["needsAuth"], json!(true));
        assert_eq!(payload["hasCredential"], json!(false));
        assert_eq!(payload["label"], json!("Token"));
        assert_eq!(payload["helpUrl"], json!("https://help"));
        assert_eq!(payload["helpText"], json!("local"));
        assert_eq!(payload["phase"], json!("idle"));
        assert!(payload["error"].is_null());
        assert_eq!(payload["authDeviceFlow"], json!(true));
        assert_eq!(payload["authQrModal"], json!(false));

        let with_credential = state_payload("dnb", "token", true, "", "", "", json!("idle"), None, false, false);
        assert_eq!(with_credential["connected"], json!(true));
        assert_eq!(with_credential["hasCredential"], json!(true));
        assert_eq!(with_credential["needsAuth"], json!(false));

        let none_kind = state_payload("stdio", "none", false, "", "", "", json!("idle"), None, false, false);
        assert_eq!(none_kind["needsAuth"], json!(false));

        let failed = state_payload("dnb", "oauth", false, "", "", "", json!("failed"), Some("denied".into()), false, true);
        assert_eq!(failed["phase"], json!("failed"));
        assert_eq!(failed["error"], json!("denied"));
        assert_eq!(failed["authQrModal"], json!(true));
    }

    #[test]
    fn phase_values_are_snake_case_strings_and_envelopes_are_exact() {
        assert_eq!(phase_value(AuthPhase::Preparing), json!("preparing"));
        assert_eq!(
            phase_value(AuthPhase::WaitingForBrowser),
            json!("waiting_for_browser")
        );
        assert_eq!(phase_value(AuthPhase::Exchanging), json!("exchanging"));
        assert_eq!(phase_value(AuthPhase::Done), json!("done"));
        assert_eq!(phase_value(AuthPhase::Failed), json!("failed"));
        assert_eq!(phase_value(AuthPhase::Cancelled), json!("cancelled"));

        let ok = ok_payload();
        assert_eq!(ok.as_object().unwrap().len(), 1);
        assert_eq!(ok["ok"], json!(true));
        let err = error_payload("boom");
        assert_eq!(err.as_object().unwrap().len(), 2);
        assert_eq!(err["ok"], json!(false));
        assert_eq!(err["error"], json!("boom"));
    }

    #[test]
    fn config_of_is_pure_and_defaults_missing_fields() {
        let entry = json!({
            "type": "streamable",
            "url": "https://mcp.example/mcp",
            "auth": {"authType": "oauth"}
        });
        let cfg = config_of(&entry);
        assert_eq!(cfg.url, "https://mcp.example/mcp");
        assert_eq!(cfg.kind, "streamable");
        // 缺省即启用：settings 里没写 enabled 的连接器仍应连线。
        assert!(cfg.enabled);
        assert!(cfg.args.is_empty());

        // 记录不是对象时退化为默认值，而不是让端点 500。
        let broken = config_of(&json!("not an object"));
        assert_eq!(broken.url, "");
        assert!(broken.headers.is_empty());

        // 扁平声明里的 scopes 也要能读到（交给 OAuth scope 协商）。
        let flat = json!({"authType": "token", "scopes": ["mcp.read", "mcp.write"]});
        let spec = auth_spec_for(&flat);
        assert_eq!(spec.kind(), AuthKind::Token);
        assert_eq!(
            spec.scopes,
            vec!["mcp.read".to_string(), "mcp.write".to_string()]
        );
    }

    /// Device Flow 的瞬时故障重试预算必须取自设置页的「MCP 重试次数」
    /// (`general.mcpRetries`)，而不是在认证模块里另写一个常量。
    ///
    /// 这条是**接线钉子**：`start_device` 需要完整的 `AppState` 才能真跑，
    /// 所以这里钉住三件必须同时成立的事——
    /// ① 端点确实从 settings 读 `mcp_retries`；
    /// ② 读到的值确实传进了 `start_device`（而不是读了不用）；
    /// ③ 消费点做了 clamp，防止手改 settings.json 绕过设置页的 [1,10] 限制。
    ///
    /// 纯文本断言是脆弱的（改排版就红），所以只钉最小必要片段；预算的
    /// 算术行为由 `mcp::oauth` 的 `device_poll_*` / `back_off_poll_interval`
    /// 行为测试保证。
    #[test]
    fn device_start_reads_its_retry_budget_from_the_mcp_retries_setting() {
        let src = include_str!("mcp_auth_api.rs");
        let handler = src
            .split("pub async fn mcp_auth_device_start")
            .nth(1)
            .expect("mcp_auth_device_start 必须存在");
        let body = handler.split("\npub async fn ").next().unwrap_or(handler);

        assert!(
            body.contains("general.mcp_retries"),
            "device start 必须从设置项 general.mcp_retries 读取重试预算，\
             不得在认证模块里另写常量（会与用户在设置页看到的「MCP 重试次数」漂移）"
        );
        assert!(
            body.contains(".clamp(1, 10)"),
            "消费点必须 clamp：Settings 直接从磁盘反序列化时不做 clamp，\
             手改 settings.json 写 mcpRetries:9999 就会重试近万次"
        );
        assert!(
            body.contains("start_device(&name, &config, &spec, transient_budget)"),
            "读到的预算必须真正传给 start_device；只读不用等于没接线"
        );

        // 对端：认证模块的签名必须接收这个预算，否则接线是假的。
        let auth_src = include_str!("../mcp/auth.rs");
        assert!(
            auth_src.contains("transient_budget: u32"),
            "AuthManager::start_device 必须接收 transient_budget 参数"
        );
        assert!(
            !auth_src.contains("MAX_CONSECUTIVE_TRANSIENT"),
            "认证模块不得再自带硬编码的重试上限常量：预算必须来自设置项"
        );
    }
}
