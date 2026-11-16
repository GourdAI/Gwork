//! `mcp::qrcode_vendor` — 厂商私有扫码授权协议适配器。
//!
//! ## 为什么独立于 `mcp::oauth`
//!
//! `mcp::oauth` 实现的是 MCP 规范的 OAuth 2.1（RFC 9728/8414 发现 → PKCE →
//! DCR → loopback 回调）。腾讯系官方 MCP **不是**规范授权服务器：腾讯文档的
//! 官方接入是「客户端生成随机码 → 用户扫码授权页绑定账号 → 客户端轮询换
//! token」，没有任何 well-known 元数据。把这类协议塞进 OAuth 发现流程会在第一
//! 跳就失败。因此这里按厂商单独适配，`auth::AuthManager::start_qrcode_poll`
//! 只负责会话状态机，具体报文由本模块封装。
//!
//! ## 已支持厂商
//!
//! * `tencent-docs` — 腾讯文档官方 MCP（协议复刻自官方 setup.sh，2026-11 实测）：
//!   - 授权页：`https://docs.qq.com/scenario/open-claw.html?nlc=1&authType=1&code=<16位hex>&mcp_source=desktop`
//!   - 轮询：`GET https://docs.qq.com/oauth/v2/mcp/token/get?code=<code>`
//!   - 成功：`{"ret":0,"data":{"token":"...","expired":false}}`，token 原样放
//!     `Authorization` 头（**不带 Bearer 前缀**）。
//!   - `ret=11510` 尚未授权（继续轮询）；`data.expired=true` 码过期；
//!     `ret=400006` 凭据失效；`ret=400007` VIP 额度不足。
//!
//! 安全边界：轮询端点必须 https（复用 `oauth::device_uri_is_allowed`）；
//! 本模块只产出 token 值，落盘由调用方写 `CredentialVault`，绝不进 settings.json。

use serde_json::Value;

/// 一次扫码会话的启动产物。
pub struct QrSession {
    /// 渲染成二维码 / 在浏览器打开的授权 URL。
    pub authorization_url: String,
    /// 会话有效期（秒），UI 倒计时用。
    pub expires_in_secs: u64,
    /// 轮询间隔下限（秒）。
    pub poll_interval_secs: u64,
    /// 厂商私有会话数据（轮询时原样带回）。
    pub(crate) vendor: VendorSession,
}

pub(crate) enum VendorSession {
    TencentDocs { code: String },
}

/// 一次轮询的判定结果。
pub enum QrPollOutcome {
    /// 拿到 token（调用方负责落盘）。
    Granted(String),
    /// 用户尚未完成授权，继续轮询。
    Pending,
    /// 明确失败（过期 / 拒绝 / 额度不足），附带面向用户的中文原因。
    Failed(String),
    /// 瞬态故障（5xx/429/网络），调用方按预算退避重试。
    Transient,
}

/// 按 `qrVendor` 启动会话。未知厂商返回 None（调用方报错）。
pub async fn start(vendor: &str, client: &reqwest::Client) -> Option<Result<QrSession, String>> {
    match vendor.trim() {
        "tencent-docs" => Some(start_tencent_docs(client).await),
        _ => None,
    }
}

/// 按会话轮询一次（仅 crate 内使用：`VendorSession` 为 pub(crate)，
/// 与 auth 状态机同可见性，消除 private_interfaces 警告）。
pub(crate) async fn poll(client: &reqwest::Client, session: &VendorSession) -> QrPollOutcome {
    match session {
        VendorSession::TencentDocs { code } => poll_tencent_docs(client, code).await,
    }
}

/* ─────────────────────────── 腾讯文档 ─────────────────────────── */

const TDOCS_AUTH_URL: &str = "https://docs.qq.com/scenario/open-claw.html";
const TDOCS_POLL_URL: &str = "https://docs.qq.com/oauth/v2/mcp/token/get";
/// 官方 setup.sh 的授权链接有效期约 5 分钟；轮询 2s 一次（脚本建议 2–3s）。
const TDOCS_EXPIRES_SECS: u64 = 300;
const TDOCS_POLL_SECS: u64 = 2;

/// 16 位小写 hex 随机会话码（对齐官方 `openssl rand -hex 8`）。
fn gen_code() -> String {
    use rand::RngCore as _;
    let mut bytes = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

async fn start_tencent_docs(client: &reqwest::Client) -> Result<QrSession, String> {
    // 授权 URL 必须 https（与轮询端点同一守卫），否则拒绝把用户导向明文页。
    if !super::oauth::device_uri_is_allowed(TDOCS_AUTH_URL)
        || !super::oauth::device_uri_is_allowed(TDOCS_POLL_URL)
    {
        return Err("腾讯文档授权端点必须是 https".into());
    }
    let code = gen_code();
    let authorization_url = format!(
        "{}?nlc=1&authType=1&code={}&mcp_source=desktop",
        TDOCS_AUTH_URL, code
    );
    // 会话码只在本机内存与轮询请求里出现，不进 settings.json、不回显给 UI。
    let _ = client; // 启动阶段无需网络：码由本地生成，授权页由用户打开。
    Ok(QrSession {
        authorization_url,
        expires_in_secs: TDOCS_EXPIRES_SECS,
        poll_interval_secs: TDOCS_POLL_SECS,
        vendor: VendorSession::TencentDocs { code },
    })
}

async fn poll_tencent_docs(client: &reqwest::Client, code: &str) -> QrPollOutcome {
    let url = format!("{}?code={}", TDOCS_POLL_URL, code);
    let resp = match client
        .get(&url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return QrPollOutcome::Transient,
    };
    let status = resp.status().as_u16();
    if status == 429 || (500..600).contains(&status) {
        return QrPollOutcome::Transient;
    }
    let text = match resp.text().await {
        Ok(t) => t,
        Err(_) => return QrPollOutcome::Transient,
    };
    let value: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        // 非 JSON（网关 HTML 错误页等）按瞬态处理，交给重试预算兜底。
        Err(_) => return QrPollOutcome::Transient,
    };
    classify_tdocs(&value)
}

/// 纯函数判定，便于不触网单测。
fn classify_tdocs(value: &Value) -> QrPollOutcome {
    let ret = value.get("ret").and_then(Value::as_i64).unwrap_or(-1);
    let data = value.get("data");
    let expired = data
        .and_then(|d| d.get("expired"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if expired {
        return QrPollOutcome::Failed("授权码已过期，请重新发起扫码授权".into());
    }
    // token 非空即成功（官方脚本以 .data.token 为准，不显式判 ret==0）。
    if let Some(token) = data.and_then(|d| d.get("token")).and_then(Value::as_str) {
        if !token.trim().is_empty() {
            return QrPollOutcome::Granted(token.trim().to_string());
        }
    }
    match ret {
        11510 => QrPollOutcome::Pending,
        400006 => QrPollOutcome::Failed("授权已失效，请重新扫码授权".into()),
        400007 => QrPollOutcome::Failed(
            "腾讯文档 MCP 额度不足（VIP 权限），请升级后重试：https://docs.qq.com/vip".into(),
        ),
        0 => QrPollOutcome::Pending, // ret=0 但尚无 token：授权进行中
        _ => QrPollOutcome::Failed(format!("腾讯文档授权失败（ret={}），请重试", ret)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn code_is_16_lowercase_hex() {
        let c = gen_code();
        assert_eq!(c.len(), 16);
        assert!(c.chars().all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase()));
        assert_ne!(gen_code(), gen_code(), "会话码必须随机");
    }

    #[test]
    fn classify_granted_when_token_present() {
        let out = classify_tdocs(&json!({"ret":0,"data":{"token":"T-123","expired":false}}));
        assert!(matches!(out, QrPollOutcome::Granted(t) if t == "T-123"));
    }

    #[test]
    fn classify_pending_on_11510_and_on_zero_without_token() {
        assert!(matches!(classify_tdocs(&json!({"ret":11510})), QrPollOutcome::Pending));
        assert!(matches!(classify_tdocs(&json!({"ret":0,"data":{}})), QrPollOutcome::Pending));
    }

    #[test]
    fn classify_expired_wins_over_token() {
        let out = classify_tdocs(&json!({"ret":0,"data":{"token":"T","expired":true}}));
        assert!(matches!(out, QrPollOutcome::Failed(_)));
    }

    #[test]
    fn classify_vip_and_invalid_are_actionable_failures() {
        assert!(matches!(classify_tdocs(&json!({"ret":400007})), QrPollOutcome::Failed(m) if m.contains("额度")));
        assert!(matches!(classify_tdocs(&json!({"ret":400006})), QrPollOutcome::Failed(_)));
        assert!(matches!(classify_tdocs(&json!({"ret":99999})), QrPollOutcome::Failed(_)));
    }

    #[tokio::test]
    async fn start_builds_https_authorization_url_with_code() {
        let client = reqwest::Client::new();
        let s = start("tencent-docs", &client).await.unwrap().unwrap();
        assert!(s.authorization_url.starts_with("https://docs.qq.com/scenario/open-claw.html?"));
        assert!(s.authorization_url.contains("nlc=1"));
        assert!(s.authorization_url.contains("authType=1"));
        assert!(s.authorization_url.contains("mcp_source=desktop"));
        assert!(s.authorization_url.contains("code="));
        assert_eq!(s.expires_in_secs, 300);
        assert!(matches!(s.vendor, VendorSession::TencentDocs { .. }));
    }

    #[tokio::test]
    async fn unknown_vendor_returns_none() {
        let client = reqwest::Client::new();
        assert!(start("no-such-vendor", &client).await.is_none());
    }
}