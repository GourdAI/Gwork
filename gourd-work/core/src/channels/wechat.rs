//! wechat — WeChat iLink Bot channel (HTTP long-poll transport).
//!
//! Port of the Java kernel's `WeChatClient` + `WeChatLink`. The protocol is pure
//! HTTP/JSON against `https://ilinkai.weixin.qq.com`; there is no WebSocket and no
//! SDK. Two halves:
//!
//! * [`WeChatClient`] — the upstream API: QR fetch, QR status poll, `getupdates`
//!   long-poll, `sendmessage`, `getconfig`, `sendtyping`. Every method takes an
//!   injected [`HttpTransport`] and an injectable base URL, so tests drive it
//!   against a scripted fake and never touch the network.
//! * [`WeChatLink`] — the channel state: bindings, the poll loop, and reply
//!   delivery. Implements [`ChannelLoop`] so [`super::runner::run_with_reconnect`]
//!   supervises it.
//!
//! ## The QR endpoints are the ones that were lying
//!
//! The previous `channels_api.rs` returned a fabricated `qrcode` UUID and an empty
//! `qrcode_img_content`, and derived the scan status from "does a binding exist for
//! this sessionId" — which has nothing to do with whether anyone scanned anything.
//! The frontend rendered an unscannable QR and then polled a status that could only
//! ever be `waiting` or a false `confirmed`. [`WeChatClient::fetch_qrcode`] and
//! [`WeChatClient::poll_qr_status`] now call the real upstream, and return `None`
//! when it is unreachable so the endpoint can report an honest failure.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use super::runner::{process_inbound_text, InboundSink, Replier};
use super::transport::{HttpReq, HttpTransport, LONG_POLL_TIMEOUT};
use super::{is_safe_session_id, CredentialStore, RoutingTable};

/// Upstream base URL (Java: `WeChatClient.BASE_URL`).
pub const BASE_URL: &str = "https://ilinkai.weixin.qq.com";
/// Credential file name (Java: `WeChatCredentialStore.STORE_FILE`).
pub const STORE_FILE: &str = "wechat-bindings.json";
/// iLink protocol version sent in every POST body's `base_info`.
const CHANNEL_VERSION: &str = "1.0.0";
/// WeChat text message length limit (Java: `WeChatLink.sendReplyDo` maxLen).
const MAX_MESSAGE_LEN: usize = 2000;

/// A persisted WeChat binding. Field names match `WeChatCredentialStore.toNode`
/// exactly, because the Java kernel reads the same file.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WeChatBinding {
    #[serde(rename = "botToken")]
    pub bot_token: String,
    #[serde(rename = "ilinkBotId")]
    pub ilink_bot_id: String,
    #[serde(rename = "ilinkUserId")]
    pub ilink_user_id: String,
    pub cursor: String,
    #[serde(rename = "lastContextToken")]
    pub last_context_token: String,
    #[serde(rename = "lastFromUserId")]
    pub last_from_user_id: String,
    /// `typing_ticket` from `getconfig`; ~24h validity. Not persisted by Java, so
    /// not persisted here either — it is re-fetched on the first message.
    #[serde(skip)]
    pub typing_ticket: Option<String>,
}

impl WeChatBinding {
    /// Java's `fromNode` rejects an entry with no `botToken`; without that guard a
    /// half-written file would resurrect a binding that cannot authenticate.
    pub fn is_valid(&self) -> bool {
        !self.bot_token.is_empty()
    }
}

/// One inbound message extracted from a `getupdates` response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WeChatMessage {
    pub text: String,
    pub from_user_id: String,
    pub context_token: String,
}

/// Result of a `getupdates` call.
#[derive(Debug, Clone, PartialEq)]
pub enum Updates {
    /// `ret == 0`: a cursor plus zero or more messages.
    Ok { cursor: String, messages: Vec<WeChatMessage> },
    /// `ret == -14`: the bot token expired; the caller must unbind.
    Expired,
    /// Any other failure (transport error, unexpected `ret`).
    Failed(String),
}

/// QR scan status (Java: `WeChatClient.pollQRStatus`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QrStatus {
    Wait,
    Scanned,
    /// Carries the credentials needed to complete the binding.
    Confirmed {
        bot_token: String,
        ilink_bot_id: String,
        ilink_user_id: String,
        baseurl: Option<String>,
    },
    Expired,
    /// Upstream answered but with an unrecognised status.
    Unknown,
}

/// A fetched QR code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QrCode {
    pub qrcode: String,
    pub qrcode_img_content: String,
}

/// The upstream API client.
pub struct WeChatClient {
    http: Arc<dyn HttpTransport>,
    base_url: String,
}

impl WeChatClient {
    pub fn new(http: Arc<dyn HttpTransport>) -> Self {
        Self {
            http,
            base_url: BASE_URL.to_string(),
        }
    }

    /// Client pointed at a custom base URL (tests, or a proxy).
    pub fn with_base_url(http: Arc<dyn HttpTransport>, base_url: impl Into<String>) -> Self {
        Self {
            http,
            base_url: base_url.into(),
        }
    }

    /// `X-WECHAT-UIN`: base64 of a random int. Java: `generateUin()`. The upstream
    /// uses it for coarse rate-limiting; a stable value would look like a bot loop.
    fn uin_header() -> String {
        use base64::Engine;
        let n: u32 = rand::random::<u32>() >> 1; // keep it positive, like Java's nextInt(MAX)
        base64::engine::general_purpose::STANDARD.encode(n.to_string().as_bytes())
    }

    fn get(&self, path_and_query: &str) -> HttpReq {
        HttpReq::get(format!("{}{}", self.base_url, path_and_query))
            .header("Content-Type", "application/json")
            .header("X-WECHAT-UIN", Self::uin_header())
            .header("iLink-App-ClientVersion", "1")
    }

    fn post(&self, path: &str, body: serde_json::Value, bot_token: &str) -> HttpReq {
        HttpReq::post(
            format!("{}{}", self.base_url, path),
            body.to_string(),
        )
        .header("Content-Type", "application/json")
        .header("AuthorizationType", "ilink_bot_token")
        .header("Authorization", format!("Bearer {}", bot_token))
        .header("X-WECHAT-UIN", Self::uin_header())
    }

    /// Fetch a bot login QR code. `None` when the upstream is unreachable or
    /// answers `ret != 0` — the caller must surface a real failure, not a fake QR.
    pub async fn fetch_qrcode(&self) -> Option<QrCode> {
        let resp = match self.http.send(self.get("/ilink/bot/get_bot_qrcode?bot_type=3")).await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(error = %e, "[WeChat] fetchQRCode transport error");
                return None;
            }
        };
        let root: serde_json::Value = match serde_json::from_str(&resp) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "[WeChat] fetchQRCode: non-JSON response");
                return None;
            }
        };
        let ret = root.get("ret").and_then(|v| v.as_i64()).unwrap_or(-1);
        if ret != 0 {
            tracing::warn!(
                ret,
                msg = root.get("msg").and_then(|v| v.as_str()).unwrap_or(""),
                "[WeChat] fetchQRCode failed"
            );
            return None;
        }
        let qrcode = root.get("qrcode").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let img = root
            .get("qrcode_img_content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if qrcode.is_empty() {
            // A `ret == 0` with no qrcode is still unusable; reporting success here
            // is exactly the bug this module replaces.
            tracing::warn!("[WeChat] fetchQRCode: ret=0 but qrcode is empty");
            return None;
        }
        Some(QrCode {
            qrcode,
            qrcode_img_content: img,
        })
    }

    /// Poll the scan status for a QR token.
    pub async fn poll_qr_status(&self, qrcode: &str) -> Option<QrStatus> {
        let url = format!(
            "/ilink/bot/get_qrcode_status?qrcode={}",
            percent_encode(qrcode)
        );
        let resp = match self.http.send(self.get(&url)).await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(error = %e, "[WeChat] pollQRStatus transport error");
                return None;
            }
        };
        let root: serde_json::Value = match serde_json::from_str(&resp) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "[WeChat] pollQRStatus: non-JSON response");
                return None;
            }
        };
        let ret = root.get("ret").and_then(|v| v.as_i64()).unwrap_or(-1);
        let status = root.get("status").and_then(|v| v.as_str()).unwrap_or("");

        // Java keeps a known status even when ret != 0 ("某些过渡状态可能 ret 非零但
        // status 存在"), and only falls back to Unknown for an unrecognised one.
        match status {
            "wait" => Some(QrStatus::Wait),
            "scaned" => Some(QrStatus::Scanned),
            "expired" => Some(QrStatus::Expired),
            "confirmed" => {
                if ret != 0 {
                    // `confirmed` without ret==0 carries no credentials; treating it
                    // as confirmed would bind an empty token.
                    tracing::warn!(ret, "[WeChat] pollQRStatus: confirmed but ret != 0");
                    return Some(QrStatus::Unknown);
                }
                Some(QrStatus::Confirmed {
                    bot_token: str_field(&root, "bot_token"),
                    ilink_bot_id: str_field(&root, "ilink_bot_id"),
                    ilink_user_id: str_field(&root, "ilink_user_id"),
                    baseurl: root
                        .get("baseurl")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string()),
                })
            }
            _ => {
                if ret == 0 {
                    Some(QrStatus::Wait)
                } else {
                    Some(QrStatus::Unknown)
                }
            }
        }
    }

    /// Long-poll for message updates (~35s server-side hold).
    pub async fn get_updates(&self, bot_token: &str, cursor: &str) -> Updates {
        let body = serde_json::json!({
            "get_updates_buf": cursor,
            "base_info": { "channel_version": CHANNEL_VERSION },
        });
        let req = self
            .post("/ilink/bot/getupdates", body, bot_token)
            .with_timeout(LONG_POLL_TIMEOUT);
        let resp = match self.http.send(req).await {
            Ok(r) => r,
            Err(e) => return Updates::Failed(e.to_string()),
        };
        let root: serde_json::Value = match serde_json::from_str(&resp) {
            Ok(v) => v,
            Err(e) => return Updates::Failed(format!("non-JSON response: {}", e)),
        };
        let ret = root.get("ret").and_then(|v| v.as_i64()).unwrap_or(-1);
        if ret == -14 {
            return Updates::Expired;
        }
        if ret != 0 {
            return Updates::Failed(format!("ret={}", ret));
        }

        let new_cursor = str_field(&root, "get_updates_buf");
        let mut messages = Vec::new();
        // The field is `msgs`, not `updates` (Java BUG1), and only
        // `message_type == 1` entries are user messages (Java BUG8).
        if let Some(msgs) = root.get("msgs").and_then(|v| v.as_array()) {
            for m in msgs {
                let msg_type = m.get("message_type").and_then(|v| v.as_i64()).unwrap_or(0);
                if msg_type != 1 {
                    continue;
                }
                // Text lives at item_list[0].text_item.text (Java BUG2).
                let text = m
                    .get("item_list")
                    .and_then(|v| v.as_array())
                    .and_then(|a| a.first())
                    .and_then(|item| item.get("text_item"))
                    .and_then(|t| t.get("text"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string();
                messages.push(WeChatMessage {
                    text,
                    from_user_id: str_field(m, "from_user_id"),
                    context_token: str_field(m, "context_token"),
                });
            }
        }
        Updates::Ok {
            cursor: new_cursor,
            messages,
        }
    }

    /// Send a text message. The body shape is load-bearing: Java's BUG4 note says a
    /// missing `client_id` / `message_state` / `item_list` wrapper gets the message
    /// silently dropped by the server.
    pub async fn send_message(
        &self,
        bot_token: &str,
        to_user_id: &str,
        context_token: &str,
        text: &str,
    ) -> bool {
        let client_id = uuid::Uuid::new_v4().simple().to_string();
        let body = serde_json::json!({
            "msg": {
                "from_user_id": "",
                "to_user_id": to_user_id,
                "client_id": client_id,
                "message_type": 2,   // BOT
                "message_state": 2,  // FINISH
                "item_list": [ { "type": 1, "text_item": { "text": text } } ],
                "context_token": context_token,
            },
            "base_info": { "channel_version": CHANNEL_VERSION },
        });
        match self.http.send(self.post("/ilink/bot/sendmessage", body, bot_token)).await {
            Ok(resp) => {
                let ret = serde_json::from_str::<serde_json::Value>(&resp)
                    .ok()
                    .and_then(|v| v.get("ret").and_then(|r| r.as_i64()))
                    .unwrap_or(-1);
                if ret != 0 {
                    tracing::warn!(ret, "[WeChat] sendMessage failed");
                }
                ret == 0
            }
            Err(e) => {
                tracing::warn!(error = %e, "[WeChat] sendMessage transport error");
                false
            }
        }
    }

    /// Fetch the `typing_ticket` for a user (needed before `send_typing`).
    pub async fn get_config(
        &self,
        bot_token: &str,
        ilink_user_id: &str,
        context_token: &str,
    ) -> Option<String> {
        let body = serde_json::json!({
            "ilink_user_id": ilink_user_id,
            "context_token": context_token,
            "base_info": { "channel_version": CHANNEL_VERSION },
        });
        let resp = self.http.send(self.post("/ilink/bot/getconfig", body, bot_token)).await.ok()?;
        let root: serde_json::Value = serde_json::from_str(&resp).ok()?;
        if root.get("ret").and_then(|v| v.as_i64()).unwrap_or(-1) != 0 {
            return None;
        }
        root.get("typing_ticket")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    }

    /// Send the "typing" indicator. `status`: 1 = start, 2 = stop.
    pub async fn send_typing(
        &self,
        bot_token: &str,
        ilink_user_id: &str,
        typing_ticket: &str,
        status: i64,
    ) -> bool {
        let body = serde_json::json!({
            "ilink_user_id": ilink_user_id,
            "typing_ticket": typing_ticket,
            "status": status,
            "base_info": { "channel_version": CHANNEL_VERSION },
        });
        match self.http.send(self.post("/ilink/bot/sendtyping", body, bot_token)).await {
            Ok(resp) => serde_json::from_str::<serde_json::Value>(&resp)
                .ok()
                .and_then(|v| v.get("ret").and_then(|r| r.as_i64()))
                .unwrap_or(-1)
                == 0,
            Err(_) => false,
        }
    }
}

fn str_field(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// Percent-encode a query value the way Java's `encodeURIComponent` does: spaces
/// become `%20` (not `+`), and `!'()~` stay literal.
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'\''
            | b'(' | b')' | b'~' | b'*' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

// ─── Link ─────────────────────────────────────────────────────────────────────

/// The WeChat channel: bindings, poll loop, reply delivery.
pub struct WeChatLink {
    dir: PathBuf,
    routing_path: PathBuf,
    client: WeChatClient,
    bindings: RwLock<HashMap<String, WeChatBinding>>,
    sink: RwLock<Arc<dyn InboundSink>>,
    running: AtomicRunning,
    /// The owning `Arc`, installed by [`WeChatLink::set_self`] once the hub has
    /// wrapped this link. The replier needs an `Arc` to call back into the link;
    /// storing it avoids unsafe self-referencing.
    ///
    /// Deliberately a **std** RwLock, not tokio's: `clone_handle` is called from
    /// synchronous code and must not await. It is only ever held for the length
    /// of a clone, so it cannot block a worker.
    self_handle: std::sync::RwLock<Option<Arc<Self>>>,
}

/// Small wrapper so `is_connected` can report the Java semantics
/// (`!bindings.isEmpty() && running`).
struct AtomicRunning(std::sync::atomic::AtomicBool);

impl AtomicRunning {
    fn new() -> Self {
        Self(std::sync::atomic::AtomicBool::new(false))
    }
    fn set(&self, v: bool) {
        self.0.store(v, Ordering::SeqCst);
    }
    fn get(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

use std::sync::atomic::Ordering;

impl WeChatLink {
    pub fn new(
        dir: PathBuf,
        routing_path: PathBuf,
        http: Arc<dyn HttpTransport>,
        sink: Arc<dyn InboundSink>,
    ) -> Self {
        Self {
            client: WeChatClient::new(http),
            dir,
            routing_path,
            bindings: RwLock::new(HashMap::new()),
            sink: RwLock::new(sink),
            running: AtomicRunning::new(),
            self_handle: std::sync::RwLock::new(None),
        }
    }

    /// Link with a custom upstream base URL (tests).
    pub fn with_base_url(
        dir: PathBuf,
        routing_path: PathBuf,
        http: Arc<dyn HttpTransport>,
        sink: Arc<dyn InboundSink>,
        base_url: impl Into<String>,
    ) -> Self {
        Self {
            client: WeChatClient::with_base_url(http, base_url),
            dir,
            routing_path,
            bindings: RwLock::new(HashMap::new()),
            sink: RwLock::new(sink),
            running: AtomicRunning::new(),
            self_handle: std::sync::RwLock::new(None),
        }
    }

    pub async fn set_sink(&self, sink: Arc<dyn InboundSink>) {
        *self.sink.write().await = sink;
    }

    fn store(&self) -> CredentialStore {
        CredentialStore::at(self.dir.join(STORE_FILE))
    }

    /// Restore bindings from disk, dropping entries with no `botToken`.
    pub async fn load_bindings(&self) {
        let raw = self.store().load();
        let mut map = self.bindings.write().await;
        map.clear();
        for (sid, value) in raw {
            match serde_json::from_value::<WeChatBinding>(value) {
                Ok(b) if b.is_valid() => {
                    tracing::info!(session = %sid, "[WeChat] restored binding");
                    map.insert(sid, b);
                }
                Ok(_) => tracing::warn!(session = %sid, "[WeChat] skipped binding without botToken"),
                Err(e) => tracing::warn!(session = %sid, error = %e, "[WeChat] unreadable binding"),
            }
        }
    }

    pub async fn bound_session_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.bindings.read().await.keys().cloned().collect();
        ids.sort();
        ids
    }

    /// Bind a session to a scanned bot. One `ilinkUserId` maps to one session, so
    /// any previous session holding the same user is unbound first (Java parity).
    pub async fn bind_session(
        &self,
        session_id: &str,
        bot_token: &str,
        ilink_bot_id: &str,
        ilink_user_id: &str,
    ) {
        if !is_safe_session_id(session_id) || bot_token.is_empty() {
            tracing::warn!(session = %session_id, "[WeChat] refused invalid bind_session");
            return;
        }
        {
            let mut map = self.bindings.write().await;
            // Evict other sessions bound to the same WeChat user.
            map.retain(|sid, b| sid == session_id || b.ilink_user_id != ilink_user_id);
            map.insert(
                session_id.to_string(),
                WeChatBinding {
                    bot_token: bot_token.to_string(),
                    ilink_bot_id: ilink_bot_id.to_string(),
                    ilink_user_id: ilink_user_id.to_string(),
                    cursor: String::new(),
                    last_context_token: String::new(),
                    last_from_user_id: String::new(),
                    typing_ticket: None,
                },
            );
            self.persist(&map);
        }
        tracing::info!(session = %session_id, user = %ilink_user_id, "[WeChat] session bound");
    }

    pub async fn unbind_session(&self, session_id: &str) {
        let mut map = self.bindings.write().await;
        if map.remove(session_id).is_some() {
            self.persist(&map);
            tracing::info!(session = %session_id, "[WeChat] session unbound");
        }
    }

    /// Write the in-memory map to disk. Called with the write lock held.
    fn persist(&self, map: &HashMap<String, WeChatBinding>) {
        let mut raw: HashMap<String, serde_json::Value> = HashMap::new();
        for (sid, b) in map {
            if let Ok(v) = serde_json::to_value(b) {
                raw.insert(sid.clone(), v);
            }
        }
        self.store().save(&raw);
    }

    /// Java's `isConnected`: bindings exist and the poll loop is running.
    pub async fn is_connected(&self) -> bool {
        !self.bindings.read().await.is_empty() && self.running.get()
    }

    /// Java's `isBound`: connected **and** this session is the active route.
    pub async fn is_bound(&self, session_id: &str) -> bool {
        self.is_connected().await
            && RoutingTable::load_from(self.routing_path.clone()).is_active_session("wechat", session_id)
    }

    /// The single active binding (Java: `getActiveBinding` — credentials are
    /// global, the routing table decides which session they serve).
    async fn active_binding(&self) -> Option<WeChatBinding> {
        self.bindings.read().await.values().next().cloned()
    }

    /// Send a reply out through WeChat, chunked to the 2000-char limit.
    ///
    /// Requires a `context_token`, which only exists after the user has sent a
    /// message. Java logs and skips in that case; doing anything else would post
    /// into a conversation the bot has no handle on.
    pub async fn send_reply(&self, reply: &str) {
        if reply.trim().is_empty() {
            return;
        }
        let Some(binding) = self.active_binding().await else {
            tracing::warn!("[WeChat] send_reply: no active binding");
            return;
        };
        let to_user = if binding.last_from_user_id.is_empty() {
            binding.ilink_user_id.clone()
        } else {
            binding.last_from_user_id.clone()
        };
        if binding.last_context_token.is_empty() {
            tracing::warn!("[WeChat] send_reply skipped: no contextToken (user must message first)");
            return;
        }
        let clean = super::strip_markdown(reply);
        let clean = if clean.trim().is_empty() { reply } else { &clean };
        for chunk in super::chunk_message(clean, MAX_MESSAGE_LEN) {
            self.client
                .send_message(&binding.bot_token, &to_user, &binding.last_context_token, &chunk)
                .await;
        }
    }

    /// One polling pass over every binding. Returns `Err` only when the whole pass
    /// failed (so the supervisor backs off); per-binding failures are logged.
    async fn poll_all(&self) -> anyhow::Result<()> {
        let session_ids = self.bound_session_ids().await;
        if session_ids.is_empty() {
            // Nothing bound: idle briefly rather than hammering upstream. The
            // supervisor's backoff handles the retry cadence.
            return Ok(());
        }
        for sid in session_ids {
            self.poll_once(&sid).await;
        }
        Ok(())
    }

    async fn poll_once(&self, session_id: &str) {
        let binding = {
            let map = self.bindings.read().await;
            match map.get(session_id) {
                Some(b) => b.clone(),
                None => return,
            }
        };

        match self.client.get_updates(&binding.bot_token, &binding.cursor).await {
            Updates::Expired => {
                tracing::warn!(session = %session_id, "[WeChat] token expired; auto-unbinding");
                self.unbind_session(session_id).await;
                return;
            }
            Updates::Failed(e) => {
                tracing::debug!(session = %session_id, error = %e, "[WeChat] getupdates failed");
                return;
            }
            Updates::Ok { cursor, messages } => {
                if !cursor.is_empty() {
                    let mut map = self.bindings.write().await;
                    if let Some(b) = map.get_mut(session_id) {
                        b.cursor = cursor;
                    }
                    self.persist(&map);
                }
                for msg in messages {
                    if msg.text.is_empty() {
                        continue;
                    }
                    self.handle_message(session_id, msg).await;
                }
            }
        }
    }

    async fn handle_message(&self, session_id: &str, msg: WeChatMessage) {
        // Cache the reply context before anything else: `send_reply` needs it and
        // the command flow below may reply immediately.
        {
            let mut map = self.bindings.write().await;
            if let Some(b) = map.get_mut(session_id) {
                b.last_context_token = msg.context_token.clone();
                b.last_from_user_id = msg.from_user_id.clone();
            }
            self.persist(&map);
        }

        // "Typing" indicator: fetch the ticket once per binding, then start/stop
        // around the agent run. Best-effort — a failure here must not drop the
        // message.
        let ticket = {
            let mut map = self.bindings.write().await;
            let b = map.get_mut(session_id);
            let existing = b.and_then(|b| b.typing_ticket.clone());
            match existing {
                Some(t) => Some(t),
                None => {
                    let b = map.get(session_id).cloned();
                    drop(map);
                    let fetched = match b {
                        Some(b) => {
                            self.client
                                .get_config(&b.bot_token, &msg.from_user_id, &msg.context_token)
                                .await
                        }
                        None => None,
                    };
                    if let Some(t) = &fetched {
                        let mut map = self.bindings.write().await;
                        if let Some(b) = map.get_mut(session_id) {
                            b.typing_ticket = Some(t.clone());
                        }
                    }
                    fetched
                }
            }
        };
        if let Some(t) = &ticket {
            self.client
                .send_typing(&binding_token(self, session_id).await, &msg.from_user_id, t, 1)
                .await;
        }

        let sink = self.sink.read().await.clone();
        let replier = WeChatReplier { link: self.clone_handle() };
        let consumed = process_inbound_text(
            "wechat",
            &msg.text,
            &self.routing_path,
            &sink,
            &replier,
        )
        .await;

        if let Some(t) = &ticket {
            if !consumed {
                self.client
                    .send_typing(&binding_token(self, session_id).await, &msg.from_user_id, t, 2)
                    .await;
            }
        }
    }

    /// Self-handle for the replier. The hub owns the `Arc`, so this is only used
    /// from inside `poll_once` where the link is already behind an `Arc`.
    fn clone_handle(&self) -> Arc<Self> {
        // SAFETY-free approach: the hub stores `Arc<WeChatLink>`; the replier needs
        // one. Rather than unsafe self-referencing, the hub passes its Arc in via
        // `set_self`. Until then, replies fall back to the sink.
        self.self_handle
            .read()
            .ok()
            .and_then(|g| g.clone())
            .unwrap_or_else(|| Arc::new(WeChatLink::detached()))
    }
}

/// Detached link used only as a fallback handle; it has no transport and its
/// replies are no-ops. Reaching it means `set_self` was never called.
impl WeChatLink {
    fn detached() -> Self {
        Self {
            dir: PathBuf::new(),
            routing_path: PathBuf::new(),
            client: WeChatClient::new(Arc::new(NoHttp)),
            bindings: RwLock::new(HashMap::new()),
            sink: RwLock::new(Arc::new(super::runner::LogSink::new(std::env::temp_dir()))),
            running: AtomicRunning::new(),
            // std RwLock, matching the field type: the bare `RwLock` import in
            // this file is tokio's.
            self_handle: std::sync::RwLock::new(None),
        }
    }

    /// Install the owning `Arc` so the replier can call back into this link.
    pub async fn set_self(&self, me: Arc<Self>) {
        if let Ok(mut g) = self.self_handle.write() {
            *g = Some(me);
        }
    }
}

struct NoHttp;
#[async_trait]
impl HttpTransport for NoHttp {
    async fn send(&self, _req: HttpReq) -> anyhow::Result<String> {
        anyhow::bail!("detached WeChatLink has no transport")
    }
}

async fn binding_token(link: &WeChatLink, session_id: &str) -> String {
    link.bindings
        .read()
        .await
        .get(session_id)
        .map(|b| b.bot_token.clone())
        .unwrap_or_default()
}

/// Replier that sends command responses back out through WeChat.
struct WeChatReplier {
    link: Arc<WeChatLink>,
}

impl Replier for WeChatReplier {
    fn reply_blocking(&self, text: &str) {
        let link = self.link.clone();
        let text = text.to_string();
        tokio::spawn(async move {
            link.send_reply(&text).await;
        });
    }
}

#[async_trait]
/// Implemented for `Arc<WeChatLink>`, not `WeChatLink`: the hub owns the link
/// behind an `Arc` (the replier needs a handle to call back into it), and
/// `run_with_reconnect` takes a `Box<dyn ChannelLoop>`. Every method the body
/// uses goes through interior mutability, so `&self` is enough and no `&mut`
/// into the `Arc` is required.
impl super::runner::ChannelLoop for Arc<WeChatLink> {
    fn name(&self) -> &'static str {
        "wechat"
    }

    /// One supervised "connection": mark running, then poll until cancelled.
    ///
    /// WeChat has no persistent socket, so the loop *is* the connection. Each pass
    /// is a long-poll (up to ~35s server-side), which is why the interval between
    /// passes is short: the server already held us.
    async fn serve_once(&mut self, cancel: CancellationToken) -> anyhow::Result<()> {
        self.running.set(true);
        // Deliver anything queued while the channel was down.
        for text in super::runner::drain_notify_log(&self.dir, "wechat") {
            self.send_reply(&text).await;
        }
        loop {
            if cancel.is_cancelled() {
                self.running.set(false);
                return Ok(());
            }
            if let Err(e) = self.poll_all().await {
                self.running.set(false);
                return Err(e);
            }
            tokio::select! {
                _ = cancel.cancelled() => {
                    self.running.set(false);
                    return Ok(());
                }
                _ = tokio::time::sleep(Duration::from_secs(2)) => {}
            }
        }
    }
}

impl Drop for WeChatLink {
    fn drop(&mut self) {
        self.running.set(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::transport::testing::FakeHttp;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "gwork-wechat-test-{}-{}",
            tag,
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn link(dir: PathBuf, http: Arc<FakeHttp>) -> WeChatLink {
        WeChatLink::with_base_url(
            dir.clone(),
            dir.join(super::super::ROUTING_FILE),
            http,
            Arc::new(super::super::runner::LogSink::new(dir)),
            "https://fake.weixin.test",
        )
    }

    // ── client: QR ────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn fetch_qrcode_parses_a_real_upstream_response() {
        let http = FakeHttp::new();
        http.on(
            "get_bot_qrcode",
            r#"{"ret":0,"msg":"ok","qrcode":"QR123","qrcode_img_content":"https://weixin/qr/QR123"}"#,
        );
        let client = WeChatClient::with_base_url(http.clone(), "https://fake.weixin.test");
        let qr = client.fetch_qrcode().await.expect("must parse");
        assert_eq!(qr.qrcode, "QR123");
        assert_eq!(qr.qrcode_img_content, "https://weixin/qr/QR123");
        // The iLink headers are part of the contract; a missing UIN gets throttled.
        let headers = http.last_headers.lock().unwrap();
        assert!(headers.iter().any(|(k, _)| k == "X-WECHAT-UIN"));
        assert!(headers.iter().any(|(k, v)| k == "iLink-App-ClientVersion" && v == "1"));
    }

    /// The bug this replaces: an unreachable upstream must yield `None`, never a
    /// fabricated QR.
    #[tokio::test]
    async fn fetch_qrcode_returns_none_when_upstream_is_unreachable() {
        let http = FakeHttp::new();
        http.fail("get_bot_qrcode", "connection refused");
        let client = WeChatClient::with_base_url(http, "https://fake.weixin.test");
        assert!(client.fetch_qrcode().await.is_none());
    }

    #[tokio::test]
    async fn fetch_qrcode_returns_none_on_nonzero_ret() {
        let http = FakeHttp::new();
        http.on("get_bot_qrcode", r#"{"ret":-1,"msg":"rate limited"}"#);
        let client = WeChatClient::with_base_url(http, "https://fake.weixin.test");
        assert!(client.fetch_qrcode().await.is_none());
    }

    /// `ret == 0` with an empty qrcode is still unusable.
    #[tokio::test]
    async fn fetch_qrcode_rejects_an_empty_qrcode_token() {
        let http = FakeHttp::new();
        http.on("get_bot_qrcode", r#"{"ret":0,"qrcode":"","qrcode_img_content":"x"}"#);
        let client = WeChatClient::with_base_url(http, "https://fake.weixin.test");
        assert!(client.fetch_qrcode().await.is_none());
    }

    #[tokio::test]
    async fn fetch_qrcode_returns_none_on_garbage_body() {
        let http = FakeHttp::new();
        http.on("get_bot_qrcode", "<html>502 Bad Gateway</html>");
        let client = WeChatClient::with_base_url(http, "https://fake.weixin.test");
        assert!(client.fetch_qrcode().await.is_none());
    }

    // ── client: QR status ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn poll_qr_status_maps_every_known_state() {
        let client = |body: &'static str| {
            let http = FakeHttp::new();
            http.on("get_qrcode_status", body);
            WeChatClient::with_base_url(http, "https://fake.weixin.test")
        };

        assert_eq!(
            client(r#"{"ret":0,"status":"wait"}"#).poll_qr_status("q").await,
            Some(QrStatus::Wait)
        );
        assert_eq!(
            client(r#"{"ret":0,"status":"scaned"}"#).poll_qr_status("q").await,
            Some(QrStatus::Scanned)
        );
        assert_eq!(
            client(r#"{"ret":0,"status":"expired"}"#).poll_qr_status("q").await,
            Some(QrStatus::Expired)
        );
        assert_eq!(
            client(r#"{"ret":0,"status":"confirmed","bot_token":"BT","ilink_bot_id":"B1","ilink_user_id":"U1","baseurl":"https://alt"}"#)
                .poll_qr_status("q")
                .await,
            Some(QrStatus::Confirmed {
                bot_token: "BT".into(),
                ilink_bot_id: "B1".into(),
                ilink_user_id: "U1".into(),
                baseurl: Some("https://alt".into()),
            })
        );
    }

    /// A `confirmed` without `ret == 0` carries no credentials; binding it would
    /// store an empty token that can never authenticate.
    #[tokio::test]
    async fn poll_qr_status_refuses_confirmed_without_ret_zero() {
        let http = FakeHttp::new();
        http.on("get_qrcode_status", r#"{"ret":-5,"status":"confirmed"}"#);
        let client = WeChatClient::with_base_url(http, "https://fake.weixin.test");
        assert_eq!(client.poll_qr_status("q").await, Some(QrStatus::Unknown));
    }

    /// Java keeps a known status even when `ret != 0`.
    #[tokio::test]
    async fn poll_qr_status_keeps_a_known_status_despite_nonzero_ret() {
        let http = FakeHttp::new();
        http.on("get_qrcode_status", r#"{"ret":-1,"status":"scaned"}"#);
        let client = WeChatClient::with_base_url(http, "https://fake.weixin.test");
        assert_eq!(client.poll_qr_status("q").await, Some(QrStatus::Scanned));
    }

    #[tokio::test]
    async fn poll_qr_status_unrecognised_status_is_unknown() {
        let http = FakeHttp::new();
        http.on("get_qrcode_status", r#"{"ret":-1,"status":"banana"}"#);
        let client = WeChatClient::with_base_url(http, "https://fake.weixin.test");
        assert_eq!(client.poll_qr_status("q").await, Some(QrStatus::Unknown));
    }

    #[tokio::test]
    async fn poll_qr_status_returns_none_when_unreachable() {
        let http = FakeHttp::new();
        http.fail("get_qrcode_status", "timeout");
        let client = WeChatClient::with_base_url(http, "https://fake.weixin.test");
        assert!(client.poll_qr_status("q").await.is_none());
    }

    /// The qrcode token is user-controlled and lands in a query string.
    #[tokio::test]
    async fn poll_qr_status_percent_encodes_the_token() {
        let http = FakeHttp::new();
        http.on("get_qrcode_status", r#"{"ret":0,"status":"wait"}"#);
        let client = WeChatClient::with_base_url(http.clone(), "https://fake.weixin.test");
        client.poll_qr_status("a b&c=d").await;
        let url = http.last_url.lock().unwrap().clone().unwrap();
        assert!(url.contains("qrcode=a%20b%26c%3Dd"), "{}", url);
        assert!(!url.contains(' '), "a raw space would break the request line");
    }

    #[test]
    fn percent_encode_matches_javascript_encode_uri_component() {
        assert_eq!(percent_encode("abc-_.!~*'()"), "abc-_.!~*'()");
        assert_eq!(percent_encode("a b"), "a%20b");
        assert_eq!(percent_encode("&=?"), "%26%3D%3F");
        assert_eq!(percent_encode("你好"), "%E4%BD%A0%E5%A5%BD");
    }

    // ── client: getupdates ────────────────────────────────────────────────────

    #[tokio::test]
    async fn get_updates_extracts_text_from_the_nested_item_list() {
        let http = FakeHttp::new();
        http.on(
            "getupdates",
            r#"{"ret":0,"get_updates_buf":"CUR2","msgs":[
                {"message_type":1,"from_user_id":"U1","context_token":"CT1",
                 "item_list":[{"text_item":{"text":"hello bot"}}]},
                {"message_type":2,"from_user_id":"U9","item_list":[{"text_item":{"text":"system noise"}}]}
            ]}"#,
        );
        let client = WeChatClient::with_base_url(http.clone(), "https://fake.weixin.test");
        let out = client.get_updates("BT", "CUR1").await;
        assert_eq!(
            out,
            Updates::Ok {
                cursor: "CUR2".into(),
                messages: vec![WeChatMessage {
                    text: "hello bot".into(),
                    from_user_id: "U1".into(),
                    context_token: "CT1".into(),
                }],
            },
            "message_type != 1 must be filtered out"
        );
        // The cursor and base_info are part of the request contract.
        let body = http.last_body.lock().unwrap().clone().unwrap();
        assert!(body.contains("\"get_updates_buf\":\"CUR1\""), "{}", body);
        assert!(body.contains("\"channel_version\":\"1.0.0\""), "{}", body);
        let headers = http.last_headers.lock().unwrap();
        assert!(headers.iter().any(|(k, v)| k == "Authorization" && v == "Bearer BT"));
        assert!(headers.iter().any(|(k, v)| k == "AuthorizationType" && v == "ilink_bot_token"));
    }

    #[tokio::test]
    async fn get_updates_reports_token_expiry_as_a_distinct_outcome() {
        let http = FakeHttp::new();
        http.on("getupdates", r#"{"ret":-14}"#);
        let client = WeChatClient::with_base_url(http, "https://fake.weixin.test");
        assert_eq!(client.get_updates("BT", "").await, Updates::Expired);
    }

    #[tokio::test]
    async fn get_updates_transport_error_is_failed_not_expired() {
        let http = FakeHttp::new();
        http.fail("getupdates", "dns error");
        let client = WeChatClient::with_base_url(http, "https://fake.weixin.test");
        match client.get_updates("BT", "").await {
            Updates::Failed(e) => assert!(e.contains("dns error"), "{}", e),
            other => panic!("expected Failed, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn get_updates_with_no_msgs_yields_an_empty_list() {
        let http = FakeHttp::new();
        http.on("getupdates", r#"{"ret":0,"get_updates_buf":"C"}"#);
        let client = WeChatClient::with_base_url(http, "https://fake.weixin.test");
        assert_eq!(
            client.get_updates("BT", "").await,
            Updates::Ok { cursor: "C".into(), messages: vec![] }
        );
    }

    // ── client: sendmessage ───────────────────────────────────────────────────

    #[tokio::test]
    async fn send_message_builds_the_full_ilink_envelope() {
        let http = FakeHttp::new();
        http.on("sendmessage", r#"{"ret":0}"#);
        let client = WeChatClient::with_base_url(http.clone(), "https://fake.weixin.test");
        assert!(client.send_message("BT", "U1", "CT1", "hi there").await);

        let body: serde_json::Value =
            serde_json::from_str(http.last_body.lock().unwrap().as_ref().unwrap()).unwrap();
        let msg = &body["msg"];
        assert_eq!(msg["to_user_id"], "U1");
        assert_eq!(msg["from_user_id"], "");
        assert_eq!(msg["message_type"], 2);
        assert_eq!(msg["message_state"], 2);
        assert_eq!(msg["context_token"], "CT1");
        assert_eq!(msg["item_list"][0]["type"], 1);
        assert_eq!(msg["item_list"][0]["text_item"]["text"], "hi there");
        // A missing client_id gets the message silently dropped upstream.
        let cid = msg["client_id"].as_str().unwrap();
        assert_eq!(cid.len(), 32, "client_id must be a dashless uuid, got {}", cid);
        assert_eq!(body["base_info"]["channel_version"], "1.0.0");
    }

    #[tokio::test]
    async fn send_message_reports_failure_honestly() {
        let http = FakeHttp::new();
        http.on("sendmessage", r#"{"ret":-1,"msg":"rejected"}"#);
        let client = WeChatClient::with_base_url(http, "https://fake.weixin.test");
        assert!(!client.send_message("BT", "U1", "CT1", "hi").await);
    }

    #[tokio::test]
    async fn each_send_message_uses_a_fresh_client_id() {
        let http = FakeHttp::new();
        http.on("sendmessage", r#"{"ret":0}"#);
        let client = WeChatClient::with_base_url(http.clone(), "https://fake.weixin.test");
        client.send_message("BT", "U1", "CT1", "a").await;
        let first = serde_json::from_str::<serde_json::Value>(
            http.last_body.lock().unwrap().as_ref().unwrap(),
        )
        .unwrap()["msg"]["client_id"]
            .as_str()
            .unwrap()
            .to_string();
        client.send_message("BT", "U1", "CT1", "b").await;
        let second = serde_json::from_str::<serde_json::Value>(
            http.last_body.lock().unwrap().as_ref().unwrap(),
        )
        .unwrap()["msg"]["client_id"]
            .as_str()
            .unwrap()
            .to_string();
        assert_ne!(first, second, "a reused client_id would be deduplicated upstream");
    }

    // ── client: getconfig / sendtyping ────────────────────────────────────────

    #[tokio::test]
    async fn get_config_returns_the_typing_ticket() {
        let http = FakeHttp::new();
        http.on("getconfig", r#"{"ret":0,"typing_ticket":"TKT"}"#);
        let client = WeChatClient::with_base_url(http, "https://fake.weixin.test");
        assert_eq!(client.get_config("BT", "U1", "CT1").await.as_deref(), Some("TKT"));
    }

    #[tokio::test]
    async fn get_config_returns_none_on_error_ret() {
        let http = FakeHttp::new();
        http.on("getconfig", r#"{"ret":-1}"#);
        let client = WeChatClient::with_base_url(http, "https://fake.weixin.test");
        assert!(client.get_config("BT", "U1", "CT1").await.is_none());
    }

    #[tokio::test]
    async fn send_typing_sends_the_status_field() {
        let http = FakeHttp::new();
        http.on("sendtyping", r#"{"ret":0}"#);
        let client = WeChatClient::with_base_url(http.clone(), "https://fake.weixin.test");
        assert!(client.send_typing("BT", "U1", "TKT", 2).await);
        let body = http.last_body.lock().unwrap().clone().unwrap();
        assert!(body.contains("\"status\":2"), "{}", body);
        assert!(body.contains("\"typing_ticket\":\"TKT\""), "{}", body);
    }

    // ── link: bindings ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn bind_session_persists_real_credentials() {
        let dir = scratch("bind");
        let l = link(dir.clone(), FakeHttp::new());
        l.bind_session("work-1", "BT", "B1", "U1").await;

        let raw = CredentialStore::at(dir.join(STORE_FILE)).load();
        let b = raw.get("work-1").expect("binding must be on disk");
        assert_eq!(b["botToken"], "BT");
        assert_eq!(b["ilinkBotId"], "B1");
        assert_eq!(b["ilinkUserId"], "U1");
        assert_eq!(b["cursor"], "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The core anti-fake-success assertion: a bind with no token writes nothing.
    #[tokio::test]
    async fn bind_session_refuses_an_empty_token_and_writes_nothing() {
        let dir = scratch("bind-empty");
        let l = link(dir.clone(), FakeHttp::new());
        l.bind_session("work-1", "", "B1", "U1").await;
        assert!(l.bindings.read().await.is_empty());
        assert!(!dir.join(STORE_FILE).exists(), "no credential file may be created");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn bind_session_rejects_a_traversal_session_id() {
        let dir = scratch("bind-traversal");
        let l = link(dir.clone(), FakeHttp::new());
        l.bind_session("../../etc/passwd", "BT", "B1", "U1").await;
        assert!(l.bindings.read().await.is_empty());
        assert!(!dir.join(STORE_FILE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// One WeChat user maps to one session; re-binding evicts the old one.
    #[tokio::test]
    async fn rebinding_the_same_user_evicts_the_previous_session() {
        let dir = scratch("rebind");
        let l = link(dir.clone(), FakeHttp::new());
        l.bind_session("work-old", "BT", "B1", "U1").await;
        l.bind_session("work-new", "BT", "B1", "U1").await;
        let ids = l.bound_session_ids().await;
        assert_eq!(ids, vec!["work-new".to_string()]);
        let raw = CredentialStore::at(dir.join(STORE_FILE)).load();
        assert!(!raw.contains_key("work-old"), "the evicted session must leave disk too");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn unbind_removes_the_binding_and_deletes_the_file_when_last() {
        let dir = scratch("unbind");
        let l = link(dir.clone(), FakeHttp::new());
        l.bind_session("work-1", "BT", "B1", "U1").await;
        assert!(dir.join(STORE_FILE).exists());
        l.unbind_session("work-1").await;
        assert!(l.bindings.read().await.is_empty());
        assert!(!dir.join(STORE_FILE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn load_bindings_skips_entries_without_a_token() {
        let dir = scratch("load");
        let store = CredentialStore::at(dir.join(STORE_FILE));
        let mut raw = HashMap::new();
        raw.insert("good".to_string(), serde_json::json!({"botToken": "BT", "ilinkUserId": "U"}));
        raw.insert("bad".to_string(), serde_json::json!({"botToken": "", "ilinkUserId": "U"}));
        store.save(&raw);

        let l = link(dir.clone(), FakeHttp::new());
        l.load_bindings().await;
        assert_eq!(l.bound_session_ids().await, vec!["good".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn load_bindings_preserves_the_cursor_across_a_restart() {
        let dir = scratch("cursor");
        let l = link(dir.clone(), FakeHttp::new());
        l.bind_session("work-1", "BT", "B1", "U1").await;
        l.bindings.write().await.get_mut("work-1").unwrap().cursor = "CUR9".into();
        {
            let map = l.bindings.read().await;
            l.persist(&map);
        }

        let l2 = link(dir.clone(), FakeHttp::new());
        l2.load_bindings().await;
        assert_eq!(l2.bindings.read().await["work-1"].cursor, "CUR9");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── link: connection semantics ────────────────────────────────────────────

    #[tokio::test]
    async fn is_connected_requires_both_a_binding_and_a_running_loop() {
        let dir = scratch("connected");
        let l = link(dir.clone(), FakeHttp::new());
        assert!(!l.is_connected().await, "no bindings → not connected");
        l.bind_session("work-1", "BT", "B1", "U1").await;
        assert!(!l.is_connected().await, "bindings but loop not running → not connected");
        l.running.set(true);
        assert!(l.is_connected().await);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Java's `isBound` is `isConnected() && routingTable.isActiveSession(...)`.
    /// A binding alone is not enough — this is what the old code got wrong.
    #[tokio::test]
    async fn is_bound_requires_the_session_to_be_the_active_route() {
        let dir = scratch("isbound");
        let l = link(dir.clone(), FakeHttp::new());
        l.bind_session("work-1", "BT", "B1", "U1").await;
        l.running.set(true);
        assert!(!l.is_bound("work-1").await, "bound but not routed → not isBound");

        let mut routing = RoutingTable::load_from(dir.join(super::super::ROUTING_FILE));
        routing.set_active_session("wechat", "work-1", None);
        assert!(l.is_bound("work-1").await);
        assert!(!l.is_bound("work-2").await);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── link: poll loop ───────────────────────────────────────────────────────

    #[tokio::test]
    async fn poll_once_forwards_a_message_and_advances_the_cursor() {
        let dir = scratch("poll");
        let http = FakeHttp::new();
        http.on(
            "getupdates",
            r#"{"ret":0,"get_updates_buf":"CUR2","msgs":[
                {"message_type":1,"from_user_id":"U1","context_token":"CT1",
                 "item_list":[{"text_item":{"text":"do it"}}]}]}"#,
        );
        let l = link(dir.clone(), http);
        l.bind_session("work-1", "BT", "B1", "U1").await;
        // Route the message so it reaches the sink instead of the selection flow.
        let mut routing = RoutingTable::load_from(dir.join(super::super::ROUTING_FILE));
        routing.set_active_session("wechat", "work-1", None);

        l.poll_once("work-1").await;

        assert_eq!(l.bindings.read().await["work-1"].cursor, "CUR2");
        assert_eq!(l.bindings.read().await["work-1"].last_context_token, "CT1");
        assert_eq!(l.bindings.read().await["work-1"].last_from_user_id, "U1");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Token expiry must unbind, not silently keep polling with a dead token.
    #[tokio::test]
    async fn poll_once_unbinds_when_the_token_expired() {
        let dir = scratch("expired");
        let http = FakeHttp::new();
        http.on("getupdates", r#"{"ret":-14}"#);
        let l = link(dir.clone(), http);
        l.bind_session("work-1", "BT", "B1", "U1").await;
        l.poll_once("work-1").await;
        assert!(l.bindings.read().await.is_empty());
        assert!(!dir.join(STORE_FILE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn poll_once_survives_a_transport_failure_and_keeps_the_binding() {
        let dir = scratch("pollfail");
        let http = FakeHttp::new();
        http.fail("getupdates", "upstream 502");
        let l = link(dir.clone(), http);
        l.bind_session("work-1", "BT", "B1", "U1").await;
        l.poll_once("work-1").await; // must not panic
        assert_eq!(l.bound_session_ids().await, vec!["work-1".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn poll_all_with_no_bindings_is_a_clean_noop() {
        let dir = scratch("pollnone");
        let http = FakeHttp::new();
        let l = link(dir.clone(), http.clone());
        assert!(l.poll_all().await.is_ok());
        assert_eq!(http.call_count(), 0, "must not call upstream with nothing bound");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Graceful stop: cancelling the token ends `serve_once` and clears `running`.
    #[tokio::test]
    async fn serve_once_stops_on_cancellation_and_clears_running() {
        let dir = scratch("serve");
        let http = FakeHttp::new();
        // The ChannelLoop impl lives on Arc<WeChatLink>, because that is what the
        // hub owns and what run_with_reconnect boxes.
        let l = Arc::new(link(dir.clone(), http));
        let cancel = CancellationToken::new();
        cancel.cancel();
        let out = super::super::runner::ChannelLoop::serve_once(&mut Arc::clone(&l), cancel).await;
        assert!(out.is_ok());
        assert!(!l.running.get(), "a stopped loop must not report itself connected");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── link: reply ───────────────────────────────────────────────────────────

    #[tokio::test]
    async fn send_reply_is_skipped_without_a_context_token() {
        let dir = scratch("reply-noctx");
        let http = FakeHttp::new();
        http.on("sendmessage", r#"{"ret":0}"#);
        let l = link(dir.clone(), http.clone());
        l.bind_session("work-1", "BT", "B1", "U1").await;
        l.send_reply("hello").await;
        assert_eq!(http.call_count(), 0, "no contextToken → nothing may be sent");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn send_reply_chunks_long_text_and_strips_markdown() {
        let dir = scratch("reply-chunk");
        let http = FakeHttp::new();
        http.on("sendmessage", r#"{"ret":0}"#);
        let l = link(dir.clone(), http.clone());
        l.bind_session("work-1", "BT", "B1", "U1").await;
        {
            let mut map = l.bindings.write().await;
            let b = map.get_mut("work-1").unwrap();
            b.last_context_token = "CT".into();
            b.last_from_user_id = "U1".into();
        }
        let long = format!("**bold** {}", "x".repeat(4500));
        l.send_reply(&long).await;
        // 4500+ chars at 2000/chunk → 3 sends.
        assert_eq!(http.call_count(), 3, "expected 3 chunks");
        let body = http.last_body.lock().unwrap().clone().unwrap();
        assert!(!body.contains("**"), "markdown must be stripped for WeChat");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn send_reply_with_no_binding_does_nothing() {
        let dir = scratch("reply-nobind");
        let http = FakeHttp::new();
        let l = link(dir.clone(), http.clone());
        l.send_reply("hello").await;
        assert_eq!(http.call_count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn binding_without_a_token_is_invalid() {
        assert!(!WeChatBinding::default().is_valid());
        assert!(WeChatBinding { bot_token: "x".into(), ..Default::default() }.is_valid());
    }
}
