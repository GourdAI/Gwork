//! acp — Agent Client Protocol (ACP) agent implementation over stdio.
//!
//! GWork acts as an ACP *agent*: editors (Zed/VSCode/IDEA) spawn `gwork acp`
//! as a subprocess and communicate via newline-delimited JSON-RPC 2.0 on
//! stdin/stdout. Protocol version = 1.
//!
//! Implemented handlers: initialize, session/new, session/load, session/prompt,
//! session/cancel. Streaming updates are sent as `session/update`
//! notifications (agent_message_chunk / agent_thought_chunk / tool_call).
//!
//! CRITICAL: stdout must contain ONLY JSON-RPC lines. All logging goes to stderr.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;

use crate::config::{ModelConfig, Settings};
use crate::llm::ChatMessage;
use crate::protocol::Frame;
use crate::react::{ReActAgent, ReActConfig};
use crate::tools::ToolRegistry;

pub const LATEST_PROTOCOL_VERSION: i64 = 1;

/// Per-session ACP state.
struct AcpSessionContext {
    cwd: String,
    cancel: CancellationToken,
}

/// The ACP agent runtime.
pub struct AcpAgent {
    sessions: Arc<Mutex<HashMap<String, AcpSessionContext>>>,
    registry: Arc<ToolRegistry>,
    /// Outbound writer (stdout).
    writer: Arc<Mutex<tokio::io::Stdout>>,
}

impl AcpAgent {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            registry: Arc::new(ToolRegistry::default_registry()),
            writer: Arc::new(Mutex::new(tokio::io::stdout())),
        }
    }

    /// Run the ACP agent loop (reads stdin until EOF).
    pub async fn run(&self) -> anyhow::Result<()> {
        let stdin = tokio::io::stdin();
        let mut reader = BufReader::new(stdin).lines();
        while let Some(line) = reader.next_line().await? {
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }
            let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            // Dispatch by presence of id (request) vs notification
            let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
            let id = msg.get("id").cloned();
            let params = msg.get("params").cloned().unwrap_or(json!({}));
            if method.is_empty() {
                continue;
            }
            match id {
                Some(id) => {
                    // Request → respond
                    let result = self.handle_request(method, params).await;
                    self.send_response(&id, result).await;
                }
                None => {
                    // Notification (e.g. session/cancel)
                    self.handle_notification(method, params).await;
                }
            }
        }
        Ok(())
    }

    async fn handle_request(&self, method: &str, params: Value) -> Value {
        match method {
            "initialize" => self.handle_initialize(params).await,
            "session/new" => self.handle_session_new(params).await,
            "session/load" => self.handle_session_load(params).await,
            "session/prompt" => self.handle_session_prompt(params).await,
            "authenticate" | "logout" => json!({}),
            "session/list" => json!({ "sessions": [] }),
            _ => json!({ "error": format!("unknown method: {}", method) }),
        }
    }

    async fn handle_notification(&self, method: &str, params: Value) {
        if method == "session/cancel" {
            let session_id = params.get("sessionId").and_then(|s| s.as_str()).unwrap_or("");
            let sessions = self.sessions.lock().await;
            if let Some(ctx) = sessions.get(session_id) {
                ctx.cancel.cancel();
            }
        }
    }

    async fn handle_initialize(&self, _params: Value) -> Value {
        json!({
            "protocolVersion": LATEST_PROTOCOL_VERSION,
            "agentCapabilities": {
                "mcp": { "capabilities": { "tools": true, "resources": true } },
                "promptCapabilities": { "image": true, "audio": true, "embeddedContext": true }
            },
            "authMethods": [],
            "agentInfo": {
                "name": "GWork",
                "version": env!("CARGO_PKG_VERSION"),
            }
        })
    }

    async fn handle_session_new(&self, params: Value) -> Value {
        let cwd = params.get("cwd").and_then(|c| c.as_str()).unwrap_or(".").to_string();
        let session_id = format!("work-{}", &uuid::Uuid::new_v4().to_string()[..8]);
        self.sessions.lock().await.insert(session_id.clone(), AcpSessionContext {
            cwd,
            cancel: CancellationToken::new(),
        });
        json!({ "sessionId": session_id })
    }

    async fn handle_session_load(&self, params: Value) -> Value {
        let session_id = params.get("sessionId").and_then(|s| s.as_str()).unwrap_or("").to_string();
        let cwd = params.get("cwd").and_then(|c| c.as_str()).unwrap_or(".").to_string();
        self.sessions.lock().await.insert(session_id.clone(), AcpSessionContext {
            cwd,
            cancel: CancellationToken::new(),
        });
        json!({})
    }

    async fn handle_session_prompt(&self, params: Value) -> Value {
        let session_id = params.get("sessionId").and_then(|s| s.as_str()).unwrap_or("").to_string();
        let prompt_blocks = params.get("prompt").and_then(|p| p.as_array()).cloned().unwrap_or_default();

        // Extract text and images from content blocks
        let mut text_parts = Vec::new();
        let mut image_urls = Vec::new();
        for block in &prompt_blocks {
            match block.get("type").and_then(|t| t.as_str()) {
                Some("text") => {
                    if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                        text_parts.push(t.to_string());
                    }
                }
                Some("image") => {
                    if let Some(data) = block.get("data").and_then(|d| d.as_str()) {
                        let mime = block.get("mimeType").and_then(|m| m.as_str()).unwrap_or("image/png");
                        image_urls.push(format!("data:{};base64,{}", mime, data));
                    } else if let Some(uri) = block.get("uri").and_then(|u| u.as_str()) {
                        image_urls.push(uri.to_string());
                    }
                }
                _ => {}
            }
        }
        let user_text = text_parts.join("\n");

        // Resolve session context
        let (cwd, cancel) = {
            let sessions = self.sessions.lock().await;
            match sessions.get(&session_id) {
                Some(ctx) => (ctx.cwd.clone(), ctx.cancel.clone()),
                None => {
                    self.send_message_chunk(&session_id, "Session not found. Create a session first.").await;
                    return json!({ "stopReason": "end_turn" });
                }
            }
        };

        // Load settings and resolve the model (acpModel → defaultModel → first enabled).
        let settings = Settings::load_default().unwrap_or_default();
        let Some(model) = resolve_acp_model(&settings) else {
            self.send_message_chunk(&session_id, "No model configured. Add a model in GWork settings.").await;
            return json!({ "stopReason": "end_turn" });
        };

        // Build history
        let workspace = std::path::PathBuf::from(&cwd);
        let system = crate::react::prompt::build_system_prompt(&settings, &workspace.to_string_lossy())
            + &crate::react::prompt::build_agent_roster(&workspace, &settings.permission);
        let mut history = vec![ChatMessage::system(system)];
        history.push(ChatMessage::user_with_images(&user_text, image_urls));

        // Frame bridge: convert ReAct frames → ACP session/update notifications
        let (frame_tx, mut frame_rx) = mpsc::unbounded_channel::<Frame>();
        let sid = session_id.clone();
        let writer = self.writer.clone();
        let bridge = tokio::spawn(async move {
            while let Some(frame) = frame_rx.recv().await {
                let update = frame_to_acp_update(&sid, &frame);
                if let Some(update) = update {
                    let notification = json!({
                        "jsonrpc": "2.0",
                        "method": "session/update",
                        "params": update
                    });
                    let mut line = serde_json::to_string(&notification).unwrap_or_default();
                    line.push('\n');
                    let mut w = writer.lock().await;
                    let _ = w.write_all(line.as_bytes()).await;
                    let _ = w.flush().await;
                }
            }
        });

        // Run ReAct
        // Read before `settings` is moved into the config literal below.
        //
        // ACP has its own thinking-depth setting rather than the per-session
        // context the chat UI writes.
        let acp_thinking = settings.general.acp_thinking_depth.clone();
        let config = ReActConfig {
            session_id: session_id.clone(),
            workspace,
            // ACP sessions are driven by an external client and have no local
            // session storage; per-session artefacts fall back to the workspace.
            session_dir: None,
            model,
            settings,
            access_mode: "full".into(),
            max_turns: 30,
            run_id: format!("acp-{}", &uuid::Uuid::new_v4().to_string()[..8]),
            start_seq: 0,
            hitl_approved: true,
            // No caller-supplied whitelist: ACP runs derive their gate from
            // `settings.permission` inside the loop.
            gate: None,
            change_ledger: None,
            // ACP is a top-level run: nothing delegated it.
            subagent_depth: 0,
            root_session_id: session_id.clone(),
            thinking: acp_thinking,
            // ACP has no local session storage: no ledger seed, no window.
            context_length: 0,
            turn_start_ms: chrono::Utc::now().timestamp_millis(),
            usage_seed: crate::session_usage::SessionUsageSum::default(),
            // ACP runs out of process with no chat-input surface, so there is no
            // `/compact` to honour.
            force_compact: false,
            compact_focus: None,
        };
        let agent = ReActAgent::new(self.registry.clone());
        let result = agent.run(&config, history, frame_tx, cancel).await;

        drop(bridge);

        if result.final_answer.is_empty() && result.interrupted() {
            self.send_message_chunk(&session_id, "[interrupted]").await;
        }

        json!({ "stopReason": "end_turn" })
    }

    /// Send an agent_message_chunk notification.
    async fn send_message_chunk(&self, session_id: &str, text: &str) {
        let notification = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": text }
                }
            }
        });
        let mut line = serde_json::to_string(&notification).unwrap_or_default();
        line.push('\n');
        let mut w = self.writer.lock().await;
        let _ = w.write_all(line.as_bytes()).await;
        let _ = w.flush().await;
    }

    async fn send_response(&self, id: &Value, result: Value) {
        let response = json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result
        });
        let mut line = serde_json::to_string(&response).unwrap_or_default();
        line.push('\n');
        let mut w = self.writer.lock().await;
        let _ = w.write_all(line.as_bytes()).await;
        let _ = w.flush().await;
    }
}

/// Convert a ReAct protocol frame to an ACP session/update params object.
fn frame_to_acp_update(session_id: &str, frame: &Frame) -> Option<Value> {
    match frame.frame_type.as_str() {
        "text" => {
            let text = frame.text.as_deref().unwrap_or("");
            if text.is_empty() {
                return None;
            }
            Some(json!({
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": text }
                }
            }))
        }
        "reason" => {
            let text = frame.text.as_deref().unwrap_or("");
            if text.is_empty() {
                return None;
            }
            Some(json!({
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "agent_thought_chunk",
                    "content": { "type": "text", "text": text }
                }
            }))
        }
        "action_start" => {
            let tool_name = frame.tool_name.as_deref().unwrap_or("tool");
            let action_id = frame.action_id.as_deref().unwrap_or("");
            Some(json!({
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": action_id,
                    "title": tool_name,
                    "kind": "execute",
                    "status": "in_progress"
                }
            }))
        }
        "action_end" => {
            let action_id = frame.action_id.as_deref().unwrap_or("");
            let failed = frame.extra.get("failed").and_then(|f| f.as_bool()).unwrap_or(false);
            let result: String = frame.text.as_deref().unwrap_or("").chars().take(20000).collect();
            Some(json!({
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": action_id,
                    "status": if failed { "failed" } else { "completed" },
                    "content": [{ "type": "content", "content": [{ "type": "text", "text": result }] }]
                }
            }))
        }
        _ => None,
    }
}

/// Resolve which model an ACP run uses.
///
/// Precedence: `general.acpModel` → `defaultModel` → first enabled model. The
/// first step is what was missing: the settings page lets a user pin a model
/// specifically for editor sessions (ACP runs in a separate process and shares
/// no chat-session state), but the old code jumped straight to
/// `default_model_config()`, so the pin was silently ignored and every ACP run
/// used the chat default. A dangling `acpModel` (the model was deleted; Java's
/// `repairRemovedModelReferences` clears it, but a hand-edited file may not) falls
/// through to the default rather than failing.
fn resolve_acp_model(settings: &Settings) -> Option<ModelConfig> {
    if let Some(name) = settings.general.acp_model.as_deref() {
        if !name.trim().is_empty() {
            if let Some(m) = settings.get_model(name) {
                return Some(m.clone());
            }
        }
    }
    settings.default_model_config().cloned()
}

/// Entry point for `gwork acp` mode.
pub async fn run_acp() -> anyhow::Result<()> {
    let agent = AcpAgent::new();
    agent.run().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_frame_to_acp_update_text() {
        let frame = Frame::text_delta("sess", "hello");
        let update = frame_to_acp_update("sess", &frame).unwrap();
        assert_eq!(update["update"]["sessionUpdate"], "agent_message_chunk");
        assert_eq!(update["update"]["content"]["text"], "hello");
    }

    #[test]
    fn test_frame_to_acp_update_tool() {
        let frame = Frame::action_start("sess", "bash", "act-1", json!({}));
        let update = frame_to_acp_update("sess", &frame).unwrap();
        assert_eq!(update["update"]["sessionUpdate"], "tool_call");
        assert_eq!(update["update"]["toolCallId"], "act-1");
    }

    #[test]
    fn test_unknown_frame_returns_none() {
        let frame = Frame::done("sess");
        assert!(frame_to_acp_update("sess", &frame).is_none());
    }

    // ─── acpModel resolution ────────────────────────────────────────────────

    fn model(name: &str) -> ModelConfig {
        ModelConfig { name: name.to_string(), enabled: true, ..Default::default() }
    }

    /// The regression: a pinned `acpModel` must win over the chat default.
    #[test]
    fn acp_model_pin_overrides_the_default_model() {
        let mut settings = Settings::default();
        settings.models.insert("chat-default".into(), model("chat-default"));
        settings.models.insert("pinned".into(), model("pinned"));
        settings.default_model = "chat-default".into();
        settings.general.acp_model = Some("pinned".into());

        let got = resolve_acp_model(&settings).expect("must resolve");
        assert_eq!(got.name, "pinned", "the ACP pin was ignored — this is the bug");
    }

    /// No pin → fall back to the default model.
    #[test]
    fn absent_acp_model_uses_the_default() {
        let mut settings = Settings::default();
        settings.models.insert("chat-default".into(), model("chat-default"));
        settings.default_model = "chat-default".into();
        settings.general.acp_model = None;

        let got = resolve_acp_model(&settings).expect("must resolve");
        assert_eq!(got.name, "chat-default");
    }

    /// A pin pointing at a deleted model must fall through to the default,
    /// not fail — a hand-edited settings.json may still carry a stale reference.
    #[test]
    fn dangling_acp_model_falls_back_to_default() {
        let mut settings = Settings::default();
        settings.models.insert("chat-default".into(), model("chat-default"));
        settings.default_model = "chat-default".into();
        settings.general.acp_model = Some("no-longer-exists".into());

        let got = resolve_acp_model(&settings).expect("must still resolve");
        assert_eq!(got.name, "chat-default");
    }

    /// A pin to a *disabled* model must not be used: `get_model` filters on
    /// enabled, so this falls back rather than selecting an unusable model.
    #[test]
    fn disabled_pinned_model_falls_back() {
        let mut settings = Settings::default();
        settings.models.insert("chat-default".into(), model("chat-default"));
        let mut off = model("off");
        off.enabled = false;
        settings.models.insert("off".into(), off);
        settings.default_model = "chat-default".into();
        settings.general.acp_model = Some("off".into());

        let got = resolve_acp_model(&settings).expect("must still resolve");
        assert_eq!(got.name, "chat-default");
    }

    /// Empty/whitespace pin is treated as absent.
    #[test]
    fn blank_acp_model_is_ignored() {
        let mut settings = Settings::default();
        settings.models.insert("m".into(), model("m"));
        settings.default_model = "m".into();
        settings.general.acp_model = Some("   ".into());
        assert_eq!(resolve_acp_model(&settings).unwrap().name, "m");
    }

    /// No models at all → None, so the caller shows "No model configured".
    #[test]
    fn no_models_resolves_to_none() {
        assert!(resolve_acp_model(&Settings::default()).is_none());
    }
}
