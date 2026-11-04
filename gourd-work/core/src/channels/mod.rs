//! channels — IM channel integration (WeChat / Feishu / DingTalk).
//!
//! Mirrors the Java kernel's core.channel package:
//! - `Channel` trait: getChannelName / isBound / sendReply / sendNotify /
//!   unbindSession / getBoundSessionIds.
//! - `ChannelRoutingTable`: one active session per channel, persisted to
//!   `<home>/.gwork/channels/routing-state.json` (atomic write).
//! - `ChannelState`: IDLE / AWAITING_SELECTION / ACTIVE.
//! - `ChannelCommandHandler`: in-IM commands (/switch /new /help, digit selection).
//! - Credential stores: per-channel `<home>/.gwork/channels/<name>-bindings.json`.
//!
//! The heavy transport (WeChat HTTP polling, Feishu/DingTalk WebSocket streams)
//! lives in the per-channel modules:
//!
//! * [`transport`] — injectable HTTP/WS clients (production `reqwest` /
//!   `tokio-tungstenite`, tests use scripted fakes; **no test hits the network**).
//! * [`wechat`] — upstream API client plus the per-channel link state machine
//!   (bindings, pending sessions, connections).
//! * [`runner`] — the long-lived tasks: reconnect-with-backoff loops, graceful
//!   shutdown via `CancellationToken`, and the inbound-message seam.
//! * [`feishu_pb`] — hand-written Pbbp2 protobuf codec for Feishu frames.
//!
//! ## Not yet wired up — read before "finishing" this module
//!
//! `feishu` and `dingtalk` link modules do **not** exist yet, and nothing in the
//! kernel calls into `wechat` / `runner` / `transport` either:
//! `server/channels_api.rs` still answers the binding endpoints from the
//! credential store alone, so `feishu_bind` reports `bound: true` without ever
//! opening a stream. That is a **false success** and the worst kind of defect
//! here — the UI shows a working channel that cannot carry a single message.
//!
//! The transport layer below is real and unit-tested, but it is an island until
//! three things happen: (1) the `feishu` / `dingtalk` modules are written,
//! (2) `channels_api` starts a link through `runner::ChannelHub` and reports the
//! *actual* connection state, and (3) `server::serve_with_static` spawns the hub
//! tasks at startup. Until then the honest answer from those endpoints is a 501
//! with a reason, not a 200.

pub mod feishu_pb;
pub mod runner;
pub mod transport;
pub mod wechat;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::config::Settings;

/// Channel lifecycle state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ChannelState {
    Idle,
    AwaitingSelection,
    Active,
}

impl Default for ChannelState {
    fn default() -> Self {
        ChannelState::Idle
    }
}

/// A route: which session a channel currently forwards to.
///
/// `state` is **optional on the wire** for two reasons:
///   - files written by the Java kernel have no such key, and must keep parsing;
///   - Java's `ChannelRoutingTable.load` reads only `activeSessionId` /
///     `projectRoot` and skips entries whose session id is empty, so a
///     state-only entry is invisible to it — writing one cannot confuse the
///     other kernel.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ChannelRoute {
    #[serde(rename = "activeSessionId")]
    pub active_session_id: String,
    #[serde(rename = "projectRoot", skip_serializing_if = "Option::is_none")]
    pub project_root: Option<String>,
    /// Persisted lifecycle state. `None` means "derive it": a non-empty
    /// `activeSessionId` implies [`ChannelState::Active`], exactly as Java's
    /// `load()` re-derives its state map.
    #[serde(rename = "state", skip_serializing_if = "Option::is_none")]
    pub state: Option<ChannelState>,
}

/// The channels directory (`<home>/.gwork/channels`).
pub fn channels_dir() -> PathBuf {
    Settings::gwork_home().join("channels")
}

/// Default routing-state file name (Java: `ChannelRoutingTable.STORE_FILE`).
pub const ROUTING_FILE: &str = "routing-state.json";

/// Validate a `sessionId` arriving from the wire.
///
/// Mirrors the Java guard repeated in all 13 `WebChannel` endpoints:
/// `sessionId.contains("..") || contains("/") || contains("\\")`. Session ids are
/// used as JSON object keys *and* as directory names downstream, so a traversal
/// sequence here would escape the channels directory. Empty is rejected too —
/// Java's `null` check plus the fact that an empty key would silently collide
/// across channels.
pub fn is_safe_session_id(id: &str) -> bool {
    !id.is_empty() && !id.contains("..") && !id.contains('/') && !id.contains('\\')
}

/// Routing table: channel name → active route + state.
///
/// The on-disk location is injectable ([`RoutingTable::load_from`]) so tests can
/// point it at a scratch directory. The default constructor still resolves to
/// `<home>/.gwork/channels/routing-state.json`, matching the Java kernel — and
/// matching it matters, because both kernels read the same file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct RoutingTable {
    routes: HashMap<String, ChannelRoute>,
    states: HashMap<String, ChannelState>,
    /// Where `save()` writes. Not part of the wire format.
    #[serde(skip)]
    path: PathBuf,
}

impl Default for RoutingTable {
    fn default() -> Self {
        Self {
            routes: HashMap::new(),
            states: HashMap::new(),
            path: channels_dir().join(ROUTING_FILE),
        }
    }
}

impl RoutingTable {
    /// The default on-disk path.
    pub fn default_path() -> PathBuf {
        channels_dir().join(ROUTING_FILE)
    }

    /// Load from the default path.
    pub fn load() -> Self {
        Self::load_from(Self::default_path())
    }

    /// Load from an explicit path. A missing or corrupt file yields an empty
    /// table — never a panic, and never a destructive write.
    ///
    /// The wire format is the **bare channel → route map**:
    /// `{"wechat": {"activeSessionId": "work-x", "projectRoot": "/p"}}`.
    /// That is what Java's `ChannelRoutingTable.save` writes and what its `load`
    /// iterates, and it is what [`save`] here writes — the two kernels share this
    /// file.
    ///
    /// Parsing it as `Self` instead (an earlier shape) looked for `routes` /
    /// `states` keys, found neither, and — because the struct derives `Default`
    /// and does not deny unknown fields — **silently produced an empty table**.
    /// Every route then read back as absent: the Java kernel's bindings were
    /// invisible here, our own `save()` did not round-trip, and inbound messages
    /// re-entered the session-selection flow instead of being forwarded.
    pub fn load_from(path: PathBuf) -> Self {
        let Ok(content) = std::fs::read_to_string(&path) else {
            return Self { path, ..Default::default() };
        };
        let routes: HashMap<String, ChannelRoute> = match serde_json::from_str(&content) {
            Ok(r) => r,
            Err(e) => {
                // Corrupt file: report and start empty rather than guessing. Do
                // not write back — an empty table would erase the other kernel's
                // routes on its next read-modify-write.
                tracing::warn!(error = %e, path = %path.display(), "channel routing state unreadable; starting empty");
                return Self { path, ..Default::default() };
            }
        };
        let mut table = Self { routes, states: HashMap::new(), path };
        // Drop entries that carry neither a session nor a state: they are
        // leftovers and would otherwise keep the file alive forever.
        table.routes.retain(|_, r| {
            !r.active_session_id.is_empty() || r.state.is_some_and(|s| s != ChannelState::Idle)
        });
        // Java's load() re-derives the state map from the routes it read: any
        // channel with a non-empty activeSessionId is ACTIVE. An explicitly
        // persisted state wins, because it is the only way an
        // `AwaitingSelection` (which has no session id yet) can survive — and
        // this kernel reloads the table on every inbound message, so a state
        // that is not on disk is a state that never existed.
        for (channel, route) in table.routes.iter() {
            let state = match route.state {
                Some(s) => s,
                None if !route.active_session_id.is_empty() => ChannelState::Active,
                None => ChannelState::Idle,
            };
            table.states.insert(channel.clone(), state);
        }
        table
    }

    /// The path this table persists to.
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn save(&self) {
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if self.routes.is_empty() {
            let _ = std::fs::remove_file(&self.path);
            return;
        }
        if let Ok(json) = serde_json::to_string_pretty(&self.routes) {
            // Atomic replace: a crash mid-write must not leave a truncated file
            // that the *other* kernel then parses as "no routes".
            let tmp = self.path.with_extension("json.tmp");
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, &self.path);
            }
        }
    }

    pub fn get_active_session(&self, channel: &str) -> Option<String> {
        self.routes.get(channel).map(|r| r.active_session_id.clone())
    }

    pub fn get_active_route(&self, channel: &str) -> Option<&ChannelRoute> {
        self.routes.get(channel)
    }

    pub fn set_active_session(&mut self, channel: &str, session_id: &str, project_root: Option<String>) {
        self.routes.insert(channel.to_string(), ChannelRoute {
            active_session_id: session_id.to_string(),
            project_root,
            // Derived from the session id on load, so leaving it out keeps the
            // file in the shape Java writes.
            state: None,
        });
        self.states.insert(channel.to_string(), ChannelState::Active);
        self.save();
    }

    pub fn get_state(&self, channel: &str) -> ChannelState {
        self.states.get(channel).copied().unwrap_or(ChannelState::Idle)
    }

    /// Set a channel's lifecycle state **and persist it**.
    ///
    /// Persisting is not optional here: `process_inbound_text` reloads the table
    /// from disk for every inbound message, and the `/switch` → digit selection
    /// flow spans two messages. With the state kept only in memory the second
    /// message saw `Idle`, `handle_message` refused to treat the digit as a
    /// selection, and the user's choice was silently forwarded to the agent as
    /// prompt text instead.
    ///
    /// `Active` is written as `None` (derived from the session id) to stay
    /// byte-compatible with Java; `Idle` with no route removes the entry rather
    /// than littering the file.
    pub fn set_state(&mut self, channel: &str, state: ChannelState) {
        self.states.insert(channel.to_string(), state);
        match self.routes.get_mut(channel) {
            Some(route) => {
                if state == ChannelState::Active {
                    route.state = None;
                } else if state == ChannelState::Idle && route.active_session_id.is_empty() {
                    // Nothing but a state to remember: drop the entry.
                    self.routes.remove(channel);
                    self.states.remove(channel);
                } else {
                    route.state = Some(state);
                }
            }
            None => {
                if state != ChannelState::Idle {
                    self.routes.insert(
                        channel.to_string(),
                        ChannelRoute { state: Some(state), ..Default::default() },
                    );
                }
            }
        }
        self.save();
    }

    pub fn remove_channel(&mut self, channel: &str) {
        self.routes.remove(channel);
        self.states.remove(channel);
        self.save();
    }

    pub fn is_active_session(&self, channel: &str, session_id: &str) -> bool {
        self.routes.get(channel).map(|r| r.active_session_id == session_id).unwrap_or(false)
    }

    pub fn all_routing(&self) -> &HashMap<String, ChannelRoute> {
        &self.routes
    }
}

/// A session option presented to the user in the IM selection flow.
#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub label: String,
    #[serde(rename = "projectRoot", skip_serializing_if = "Option::is_none")]
    pub project_root: Option<String>,
}

/// Command handler: consumes in-IM commands before they reach the AI.
pub struct ChannelCommandHandler;

impl ChannelCommandHandler {
    /// Returns Some(reply) if the message was consumed as a command, None to forward to AI.
    pub fn handle_message(text: &str, sessions: &[SessionInfo], state: ChannelState) -> Option<CommandAction> {
        let trimmed = text.trim();
        match trimmed {
            "/switch" | "/切换" => Some(CommandAction::ListSessions),
            "/new" | "/新建" => Some(CommandAction::NewSession),
            "/help" | "/帮助" => Some(CommandAction::Help),
            _ => {
                // Digit selection while awaiting selection
                if state == ChannelState::AwaitingSelection {
                    if trimmed == "0" {
                        return Some(CommandAction::NewSession);
                    }
                    if let Ok(n) = trimmed.parse::<usize>() {
                        if n >= 1 && n <= sessions.len() {
                            return Some(CommandAction::SelectSession(n - 1));
                        }
                    }
                }
                None
            }
        }
    }

    /// Render the session selection list.
    pub fn render_session_list(sessions: &[SessionInfo]) -> String {
        if sessions.is_empty() {
            return "暂无会话，回复任意内容新建会话。".to_string();
        }
        let mut out = String::from("请选择会话（回复序号，0=新建）：\n");
        for (i, s) in sessions.iter().enumerate() {
            out.push_str(&format!("{}. {}\n", i + 1, s.label));
        }
        out.push_str("0. 新建会话");
        out
    }

    pub fn render_help() -> String {
        "/switch 切换会话\n/new 新建会话\n/help 帮助".to_string()
    }
}

/// The action a command resolves to.
#[derive(Debug, Clone, PartialEq)]
pub enum CommandAction {
    ListSessions,
    NewSession,
    Help,
    SelectSession(usize),
}

/// Generic credential store: sessionId → JSON binding, persisted to a file.
///
/// Two constructors, on purpose:
///
/// * [`CredentialStore::new`] resolves `<home>/.gwork/channels/<file_name>` —
///   what production uses, and what the Java kernel's
///   `AbstractCredentialStore` writes to.
/// * [`CredentialStore::at`] takes an absolute path — what tests use.
///
/// The injectable constructor is not a convenience. Without it every test that
/// exercises a bind/unbind path writes into the developer's real `~/.gwork`,
/// which on this machine holds 556 session roots and 236 model configs. A test
/// suite that mutates the user's live configuration is a data-loss bug with a
/// green checkmark on it.
#[derive(Debug, Clone)]
pub struct CredentialStore {
    path: PathBuf,
}

impl CredentialStore {
    /// Store for `<channels_dir>/<file_name>`.
    pub fn new(file_name: &str) -> Self {
        Self::at(channels_dir().join(file_name))
    }

    /// Store at an explicit path (tests, or a redirected home).
    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// The backing file.
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> HashMap<String, serde_json::Value> {
        let Ok(content) = std::fs::read_to_string(&self.path) else {
            return HashMap::new();
        };
        serde_json::from_str(&content).unwrap_or_default()
    }

    pub fn save(&self, bindings: &HashMap<String, serde_json::Value>) {
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if bindings.is_empty() {
            // Java deletes the file when the map empties out; keeping a stale
            // `{}` around would make "no bindings" indistinguishable from
            // "bindings failed to load" for a reader that checks existence.
            let _ = std::fs::remove_file(&self.path);
            return;
        }
        if let Ok(json) = serde_json::to_string_pretty(bindings) {
            let tmp = self.path.with_extension("json.tmp");
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, &self.path);
            }
        }
    }

    pub fn get(&self, session_id: &str) -> Option<serde_json::Value> {
        self.load().remove(session_id)
    }

    pub fn set(&self, session_id: &str, binding: serde_json::Value) {
        let mut map = self.load();
        map.insert(session_id.to_string(), binding);
        self.save(&map);
    }

    pub fn remove(&self, session_id: &str) {
        let mut map = self.load();
        map.remove(session_id);
        self.save(&map);
    }

    /// All bound session ids.
    pub fn session_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.load().into_keys().collect();
        ids.sort();
        ids
    }
}

/// Strip markdown for plain-text IM delivery (WeChat).
pub fn strip_markdown(text: &str) -> String {
    let mut out = text.to_string();
    // Remove code fences
    let fence = regex::Regex::new(r"```[\s\S]*?```").unwrap();
    out = fence.replace_all(&out, "[代码]").to_string();
    // Bold / italic markers
    out = out.replace("**", "").replace("__", "");
    let italic = regex::Regex::new(r"\*([^*\n]+)\*").unwrap();
    out = italic.replace_all(&out, "$1").to_string();
    // Heading markers
    let heading = regex::Regex::new(r"(?m)^#{1,6}\s+").unwrap();
    out = heading.replace_all(&out, "").to_string();
    out
}

/// Split a long message into chunks for IM delivery (WeChat 2000-char limit).
pub fn chunk_message(text: &str, limit: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= limit {
        return vec![text.to_string()];
    }
    let mut chunks = Vec::new();
    let mut idx = 0;
    let mut part = 1;
    while idx < chars.len() {
        let end = (idx + limit).min(chars.len());
        let mut piece: String = chars[idx..end].iter().collect();
        if part > 1 {
            piece = format!("({}) {}", part, piece);
        }
        chunks.push(piece);
        idx = end;
        part += 1;
    }
    chunks
}

/// Dispatch a proactive notification to a named channel (used by loop tasks).
///
/// Appends to `<channels>/<name>-notify-log.ndjson`. The live runners drain this
/// log when they are connected, so a notification emitted while a channel is
/// down is not lost — it is delivered on reconnect.
pub fn channels_notify(channel: &str, text: &str) {
    channels_notify_in(&channels_dir(), channel, text);
}

/// [`channels_notify`] against an explicit directory (tests).
pub fn channels_notify_in(dir: &Path, channel: &str, text: &str) {
    let _ = std::fs::create_dir_all(dir);
    let log_file = dir.join(format!("{}-notify-log.ndjson", channel));
    let entry = serde_json::json!({
        "time": chrono::Utc::now().to_rfc3339(),
        "text": text,
    });
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&log_file) {
        let _ = writeln!(f, "{}", entry);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_command_dispatch() {
        let sessions = vec![SessionInfo { session_id: "work-a".into(), label: "A".into(), project_root: None }];
        assert_eq!(
            ChannelCommandHandler::handle_message("/switch", &sessions, ChannelState::Idle),
            Some(CommandAction::ListSessions)
        );
        assert_eq!(
            ChannelCommandHandler::handle_message("/new", &sessions, ChannelState::Idle),
            Some(CommandAction::NewSession)
        );
        assert_eq!(
            ChannelCommandHandler::handle_message("1", &sessions, ChannelState::AwaitingSelection),
            Some(CommandAction::SelectSession(0))
        );
        assert_eq!(
            ChannelCommandHandler::handle_message("0", &sessions, ChannelState::AwaitingSelection),
            Some(CommandAction::NewSession)
        );
        // Not a command → forward to AI
        assert_eq!(ChannelCommandHandler::handle_message("hello", &sessions, ChannelState::Active), None);
    }

    #[test]
    fn test_strip_markdown() {
        let md = "**bold** and `code` and ```block```";
        let out = strip_markdown(md);
        assert!(!out.contains("**"));
        assert!(out.contains("[代码]"));
    }

    #[test]
    fn test_chunk_message() {
        let long = "a".repeat(4500);
        let chunks = chunk_message(&long, 2000);
        assert_eq!(chunks.len(), 3);
        assert!(chunks[1].starts_with("(2)"));
    }

    /// Scratch directory helper. Every persistence test in this module must go
    /// through it: `RoutingTable::default()` and `CredentialStore::new()` both
    /// resolve into the developer's real `~/.gwork`.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "gwork-channels-test-{}-{}",
            tag,
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_routing_table_roundtrip() {
        let dir = scratch("routing");
        let path = dir.join(ROUTING_FILE);
        let mut t = RoutingTable::load_from(path.clone());
        t.set_active_session("wechat", "work-x", Some("/proj".into()));
        assert_eq!(t.get_active_session("wechat"), Some("work-x".into()));
        assert_eq!(t.get_state("wechat"), ChannelState::Active);
        assert!(t.is_active_session("wechat", "work-x"));

        // Reload from disk: the route survives and the state is re-derived.
        let reloaded = RoutingTable::load_from(path);
        assert_eq!(reloaded.get_active_session("wechat"), Some("work-x".into()));
        assert_eq!(reloaded.get_state("wechat"), ChannelState::Active);
        assert_eq!(
            reloaded.get_active_route("wechat").and_then(|r| r.project_root.clone()),
            Some("/proj".into())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn routing_table_removing_the_last_route_deletes_the_file() {
        let dir = scratch("routing-remove");
        let path = dir.join(ROUTING_FILE);
        let mut t = RoutingTable::load_from(path.clone());
        t.set_active_session("feishu", "work-a", None);
        assert!(path.exists());
        t.remove_channel("feishu");
        assert!(!path.exists(), "an empty routing table must not leave a file behind");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn routing_table_corrupt_file_yields_empty_not_panic() {
        let dir = scratch("routing-corrupt");
        let path = dir.join(ROUTING_FILE);
        std::fs::write(&path, "{not json").unwrap();
        let t = RoutingTable::load_from(path);
        assert!(t.all_routing().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn credential_store_writes_only_to_the_injected_path() {
        let dir = scratch("creds");
        let store = CredentialStore::at(dir.join("feishu-bindings.json"));
        store.set("work-1", serde_json::json!({"openId": "ou_abc"}));
        assert_eq!(
            store.get("work-1").unwrap()["openId"].as_str(),
            Some("ou_abc")
        );
        assert_eq!(store.session_ids(), vec!["work-1".to_string()]);
        assert!(dir.join("feishu-bindings.json").exists());

        store.remove("work-1");
        assert!(store.get("work-1").is_none());
        assert!(
            !dir.join("feishu-bindings.json").exists(),
            "emptying the store must delete the file (Java AbstractCredentialStore.save)"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn credential_store_survives_a_corrupt_file() {
        let dir = scratch("creds-corrupt");
        let path = dir.join("wechat-bindings.json");
        std::fs::write(&path, "[[[").unwrap();
        let store = CredentialStore::at(path.clone());
        assert!(store.load().is_empty());
        // A subsequent write must recover the file rather than propagate garbage.
        store.set("work-2", serde_json::json!({"botToken": "t"}));
        assert_eq!(store.load().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The guard every endpoint depends on. A traversal sequence in a sessionId
    /// would let a caller write a binding file outside the channels directory.
    #[test]
    fn session_id_traversal_is_rejected() {
        assert!(is_safe_session_id("work-abc123"));
        assert!(is_safe_session_id("global-config"));
        assert!(!is_safe_session_id(""));
        assert!(!is_safe_session_id(".."));
        assert!(!is_safe_session_id("work-../escape"));
        assert!(!is_safe_session_id("work/a"));
        assert!(!is_safe_session_id("work\\a"));
        assert!(!is_safe_session_id("../../.gwork/settings.json"));
    }

    #[test]
    fn notify_log_appends_ndjson_lines() {
        let dir = scratch("notify");
        channels_notify_in(&dir, "wechat", "first");
        channels_notify_in(&dir, "wechat", "second");
        let content = std::fs::read_to_string(dir.join("wechat-notify-log.ndjson")).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("first"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
