//! server — HTTP + WebSocket server compatible with the existing frontend.
//!
//! Endpoints (mirrors Java kernel's WebController):
//! - GET  /web/chat/meta            → app metadata (title/version/workspace/homeDir/defaultModel)
//! - GET  /web/chat/sessions        → session list
//! - POST /web/chat/sessions/delete → delete session (sessionId via query or form)
//! - POST /web/chat/sessions/rename → rename session
//! - GET  /web/chat/models          → available models + selected + accessMode
//! - POST /web/chat/models/select   → switch model (modelName field)
//! - POST /web/chat/thinking/select → persist thinking depth
//! - POST /web/chat/context/select  → persist context length
//! - POST /web/chat/access/select   → persist access mode
//! - GET  /web/chat/messages        → load message history
//! - GET  /web/chat/replay          → replay stream frames
//! - POST /web/chat/input           → send message / answer question / approve HITL
//! - POST /web/chat/interrupt       → cancel running task
//! - GET  /web/chat/todos           → parse TODO checklist
//! - GET  /web/chat/hints           → input hints
//! - GET  /web/chat/usage/stats     → usage statistics
//! - GET  /web/chat/memory/list     → list memory entries
//! - POST /web/chat/memory/delete   → delete memory entry
//! - POST /web/chat/memory/clear    → clear all memory
//! - GET  /web/settings/general     → general settings
//! - POST /web/settings/general/save→ save general settings
//! - GET  /web/settings/permission  → permission settings
//! - POST /web/settings/permission/save → save permission settings
//! - WS   /web/gate                 → streaming frames
//!
//! The server is designed to be embedded in the Tauri desktop app or run standalone.

// ── Endpoint sub-modules (phase A–E feature parity) ─────────────────────
pub mod attachments_api;
pub mod changes_api;
pub mod channels_api;
pub mod commands;
pub mod filer_api;
pub mod flex_body;
pub mod git_api;
pub mod guard;
pub mod loop_api;
pub mod loop_driver;
pub mod loop_runner;
pub mod misc_api;
pub mod projects_api;
pub mod settings_api;
pub mod skills_market_api;

use std::collections::HashMap;
use std::net::SocketAddr;
    use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
    use std::sync::Arc;
    use std::time::Instant;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Multipart, Query, State};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Form, Json, Router};
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio_util::sync::CancellationToken;
use tracing::info;

use crate::config::Settings;
use crate::llm::ChatMessage;
use crate::protocol::Frame;
use crate::react::prompt::build_system_prompt;
use crate::react::{ReActAgent, ReActConfig, StopReason, SuspensionPoint};
use crate::session::{SessionStore, StoredMessage};
use crate::tools::ToolRegistry;

use self::flex_body::{FlexBody, FlexBodyRejection};

/// A running task handle.
struct RunningTask {
    cancel: CancellationToken,
    /// The run this handle belongs to.
    ///
    /// Needed so `/web/chat/interrupt` can tell "you asked me to stop a run that
    /// is no longer the current one" (`turn_changed`) from "nothing is running"
    /// (`not_running`). The frontend sends the `runId` it believes is active;
    /// that value can be stale — history replay overwrites `activeRunId` and does
    /// not restore it — and cancelling the *new* run because of a stale id would
    /// stop work the user never asked to stop. Java makes the same distinction
    /// (`WebGate.java:2346-2348`) and returns the authoritative id so the client
    /// can recalibrate and retry.
    run_id: String,
}

/// Shared application state.
pub struct AppState {
    pub settings: RwLock<Settings>,
    pub session_store: SessionStore,
    pub registry: Arc<ToolRegistry>,
    /// MCP manager, shared with `registry` so the settings endpoints can
    /// hot-plug servers (add/update/toggle/remove) without a restart.
    pub mcp: Arc<crate::mcp::McpManager>,
    /// File-change ledger for capturing write/edit operations.
    pub change_ledger: Arc<crate::changes::ChangeLedger>,
    /// Loop scheduler.
    pub loop_scheduler: Arc<crate::loop_task::LoopScheduler>,
    /// Message queue manager.
    pub queue_manager: Arc<crate::queue::QueueManager>,
    /// Terminal registry.
    pub terminal_registry: Arc<crate::terminal::TerminalRegistry>,
    /// Filesystem watcher for the editor's "changed on disk" reload.
    /// Broadcasts `filer_change` frames over the gate WS (see `crate::watcher`).
    pub watcher: Arc<crate::watcher::WorkspaceWatcher>,
    /// Active WebSocket senders per session (for frame broadcast).
    ws_clients: Mutex<HashMap<String, Vec<mpsc::UnboundedSender<Frame>>>>,
    /// Running tasks: session_id → handle.
    running: Mutex<HashMap<String, RunningTask>>,
    /// Suspension points: session_id → serialized SuspensionPoint JSON.
    suspensions: Mutex<HashMap<String, SuspensionPoint>>,
    /// Per-session event sequence counters.
    seq_counters: Mutex<HashMap<String, Arc<AtomicI64>>>,
    /// Throttle state for the issued-seq watermark (see `record_issued_seq`).
    issued_seq_flush: Mutex<HashMap<String, IssuedFlushState>>,
    /// Per-session selected model override.
    session_models: Mutex<HashMap<String, String>>,
    /// Per-session access mode override.
    session_access: Mutex<HashMap<String, String>>,
    /// sessionId → workspace root registry, shared with the Java kernel via
    /// `~/.gwork/session-roots.json`. Drives the global-vs-project split of
    /// `/web/chat/sessions` and per-session storage routing.
    pub session_roots: Arc<crate::session::SessionRoots>,
    /// Whether `settings.json` parsed successfully at startup.
    ///
    /// Load failure must never lead to a destructive write: `persist_settings`
    /// refuses to rewrite the `models` / `providers` / `defaultModel` sections
    /// when this is false, because in that state the in-memory map is empty and
    /// writing it would erase the user's real configuration on disk. This exact
    /// failure mode happened once (a probe call to `general/save` against a
    /// kernel whose config load had failed wiped 24 model entries), so the guard
    /// is load-bearing, not defensive decoration.
    pub settings_loaded: AtomicBool,
    /// Remote-deployed model mirror: generation + "is the mirror still live".
    ///
    /// See [`crate::remote::mirror`]. Owned by `AppState` because two decisions
    /// read it on hot paths: the overlay endpoint bumps the generation, and
    /// `persist_settings` refuses to write the mirrored sections back to disk.
    pub mirror: crate::remote::mirror::MirrorState,
    /// Workspace root.
    pub workspace: std::path::PathBuf,
}

/// First value a freshly created event-sequence counter must hand out, given
/// the highest `eventSeq` already persisted in the session's stream file.
///
/// This is the load-bearing line of the kernel-restart resume fix: the
/// frontend rebuilds its dedupe cursor from that same file on replay and the
/// live gate (app-streaming.js `applySequencedGateChunk`) silently drops every
/// frame at or below the cursor, so a counter that restarts at zero after a
/// reboot emits frames the UI discards without a trace — the run executes
/// (tools, TODO, HTTP all live) while the main area spins on "waiting for
/// response" until the run ends and history replay finally renders it.
/// Seeding one above the watermark is the only value safe in both directions:
/// at or below it re-triggers the drop, and the watermark itself would hand
/// out a seq the file already carries.
///
/// Free function so the decision is unit-testable without constructing an
/// `AppState` (its watcher/registry fields have no test constructor); the
/// end-to-end proof lives outside the repo, this test is the in-repo tooth.
fn seed_from_watermark(watermark: i64) -> i64 {
    watermark.max(-1) + 1
}

impl AppState {
    /// Get or create the event sequence counter for a session.
    ///
    /// On first creation the counter is seeded from the session's watermarks,
    /// not from zero: the **persisted** stream watermark (`max_stream_seq`)
    /// and the **issued** high-water mark (`read_issued_seq`), whichever is
    /// higher. The frontend rebuilds its dedupe cursor from the stream file on
    /// replay and the live gate drops every frame at or below the cursor, so a
    /// zeroed counter after a kernel restart makes all frames of the next run
    /// invisible: the run executes (tools, TODO, HTTP all live) while the main
    /// content area spins on "waiting for response" until the run ends and
    /// history replay finally renders it. The issued mark additionally covers
    /// frames that were handed out but never persisted (transient and
    /// slash-command frames advance the in-memory cursor without reaching the
    /// stream file), which is what keeps a restart *without a page reload*
    /// safe too. New sessions have neither file (both -1 → seed 0), so their
    /// behaviour is unchanged.
    pub async fn seq_for(&self, session_id: &str) -> Arc<AtomicI64> {
        if let Some(counter) = self.seq_counters.lock().await.get(session_id) {
            return counter.clone();
        }
        // Scan outside the lock: an 84 MB stream file must not stall counter
        // creation for every other session.
        let store = store_for(self, session_id);
        let watermark = store
            .max_stream_seq(session_id)
            .max(store.read_issued_seq(session_id));
        let mut counters = self.seq_counters.lock().await;
        // A concurrent creator may have won the race; adopt its counter rather
        // than inserting a second one (two live counters for one session would
        // hand out duplicate seqs).
        if let Some(counter) = counters.get(session_id) {
            return counter.clone();
        }
        let counter = Arc::new(AtomicI64::new(seed_from_watermark(watermark)));
        counters.insert(session_id.to_string(), counter.clone());
        counter
    }

    async fn is_busy(&self, session_id: &str) -> bool {
        self.running.lock().await.contains_key(session_id)
    }
}

/// Start the HTTP+WS server on the given address.
pub async fn serve(addr: SocketAddr, workspace: std::path::PathBuf) -> anyhow::Result<()> {
    serve_with_static(addr, workspace, None).await
}

/// Start the HTTP+WS server, optionally serving a static UI directory at `/`.
pub async fn serve_with_static(
    addr: SocketAddr,
    workspace: std::path::PathBuf,
    static_dir: Option<std::path::PathBuf>,
) -> anyhow::Result<()> {
    // Records whether settings.json parsed at startup; consumed by AppState so
    // persist_settings can refuse destructive writes on a failed load.
    let loaded_flag = Arc::new(AtomicBool::new(false));
    let settings = match Settings::load_default() {
        Ok(s) => {
            loaded_flag.store(true, Ordering::SeqCst);
            s
        }
        Err(e) => {
            // Log loudly: running with defaults means every settings write is
            // partially disabled (see `settings_loaded`).
            tracing::error!(error = %e, "settings.json failed to load; running with defaults and read-protecting models/providers on disk");
            Settings::default()
        }
    };
    let mcp = Arc::new(crate::mcp::McpManager::new());

    // ── Cold start: bind the socket BEFORE any eager loading ────────────────
    //
    // WHY THIS ORDERING (measured, not guessed): the port used to become
    // connectable only at the very end of this function, *after* settings.json
    // (136 KB / 236 models) had been parsed, `session-roots.json` (25 KB / 556
    // bindings) loaded, every MCP server handshaked and the loop scheduler
    // restored. The desktop shell polls the port to decide when the kernel is up,
    // so all of that time was charged to "app is frozen on the splash screen".
    //
    // Binding first costs one syscall and makes the kernel reachable immediately;
    // everything below is either cheap or moved off the startup path.
    let listener = tokio::net::TcpListener::bind(addr).await?;

    // ── MCP connect is now lazy (background), not an eager startup await ─────
    //
    // `connect_all` spawns each configured stdio server and awaits a full
    // JSON-RPC handshake (`initialize` + `tools/list`) **serially**. Its own
    // deadline budget is 30 s per RPC with a 10 s per-read timeout, so a single
    // hung `npx`/`uvx` server — a cold npm cache, a missing binary, a proxy
    // prompt — stalls startup for up to 30 s *per server*, and a failure in one
    // does not stop the others from being awaited in turn.
    //
    // None of that is needed to serve HTTP: the tools only matter once a chat run
    // actually asks for them, and `McpManager` is already shared by `Arc` with the
    // registry, so tools registered later become visible without a restart (the
    // settings endpoints rely on exactly that hot-plug path).
    //
    // So the handshake is spawned and the server starts serving at once. A slow or
    // broken MCP server now degrades to "its tools appear a moment later / never",
    // instead of "the whole kernel does not come up".
    let mcp_servers = load_mcp_servers();
    if !mcp_servers.is_empty() {
        let mcp_bg = mcp.clone();
        tokio::spawn(async move {
            mcp_bg.connect_all(&mcp_servers).await;
        });
    }

    let registry = ToolRegistry::default_registry().with_mcp(mcp.clone());

    // Filesystem watcher: frames it produces are drained by a task below and
    // broadcast to session-less ("*") gate subscribers. Constructed before
    // AppState because AppState owns it.
    let (watch_tx, mut watch_rx) = mpsc::unbounded_channel::<crate::protocol::Frame>();
    let watcher = Arc::new(crate::watcher::WorkspaceWatcher::new(
        watch_tx,
        Some(workspace.clone()),
    ));

    let state = Arc::new(AppState {
        settings: RwLock::new(settings),
        session_store: SessionStore::new(),
        registry: Arc::new(registry),
        mcp: mcp.clone(),
        change_ledger: Arc::new(crate::changes::ChangeLedger::new(workspace.clone())),
        loop_scheduler: Arc::new(crate::loop_task::LoopScheduler::new(workspace.clone())),
        queue_manager: Arc::new(crate::queue::QueueManager::new()),
        terminal_registry: Arc::new(crate::terminal::TerminalRegistry::new()),
        watcher: watcher.clone(),
        ws_clients: Mutex::new(HashMap::new()),
        running: Mutex::new(HashMap::new()),
        suspensions: Mutex::new(HashMap::new()),
        seq_counters: Mutex::new(HashMap::new()),
        issued_seq_flush: Mutex::new(HashMap::new()),
        session_models: Mutex::new(HashMap::new()),
        session_access: Mutex::new(HashMap::new()),
        session_roots: Arc::new(crate::session::SessionRoots::load()),
        settings_loaded: AtomicBool::new(loaded_flag.load(Ordering::SeqCst)),
        mirror: crate::remote::mirror::MirrorState::new(),
        workspace,
    });

    // Remote-deployed mode marker. Must be set BEFORE the router is built: the
    // overlay endpoint reads it, and a request can arrive on the first tick after
    // the listener binds.
    //
    // Env-var source mirrors the credential injection convention (a command-line
    // flag would be visible in `ps` on the remote host). Only a **present and
    // truthy** value flips the marker on: the CLI's `--remote-deployed` flag sets
    // it before calling this function, and an unconditional store here would
    // silently undo that on every launch that did not also export the variable.
    if let Ok(raw) = std::env::var(crate::remote::mirror::ENV_REMOTE_DEPLOYED) {
        let t = raw.trim();
        if !(t.is_empty() || t == "0" || t.eq_ignore_ascii_case("false")) {
            crate::remote::mirror::set_remote_deployed(true);
        }
    }

    // Drain watcher frames → broadcast to every session-less gate subscriber.
    {
        let st = state.clone();
        tokio::spawn(async move {
            while let Some(frame) = watch_rx.recv().await {
                broadcast_frame(&st, "*", frame).await;
            }
        });
    }

    // Restore loop tasks from disk. Off the startup path: it reads and parses
    // `loop-tasks.json` and re-arms every cron trigger, none of which has to
    // happen before the first HTTP request can be answered.
    {
        let st = state.clone();
        tokio::spawn(async move {
            st.loop_scheduler.restore().await;
        });
    }

    // Start the loop scheduler driver (periodic trigger loop)
    loop_driver::start(state.clone());

    let app = Router::new()
        .route("/web/chat/meta", get(chat_meta))
        .route("/web/chat/sessions", get(chat_sessions))
        .route("/web/chat/sessions/delete", post(chat_sessions_delete))
        .route("/web/chat/sessions/rename", post(chat_sessions_rename))
        .route("/web/chat/models", get(chat_models))
        .route("/web/chat/models/select", post(chat_models_select))
        .route("/web/chat/thinking/select", post(chat_thinking_select))
        .route("/web/chat/context/select", post(chat_context_select))
        .route("/web/chat/access/select", post(chat_access_select))
        .route("/web/chat/messages", get(chat_messages))
        .route("/web/chat/replay", get(chat_replay))
        .route("/web/chat/input", post(chat_input))
        .route("/web/chat/interrupt", post(chat_interrupt))
        .route("/web/chat/todos", get(chat_todos))
        .route("/web/chat/hints", get(chat_hints))
        .route("/web/chat/usage/stats", get(chat_usage_stats))
        .route("/web/chat/memory/list", get(chat_memory_list))
        .route("/web/chat/memory/delete", post(chat_memory_delete))
        .route("/web/chat/memory/clear", post(chat_memory_clear))
        .route("/web/settings/general", get(settings_general))
        .route("/web/settings/general/save", post(settings_general_save))
        .route("/web/settings/permission", get(settings_permission))
        .route("/web/settings/permission/save", post(settings_permission_save))
        .route("/web/settings/llm/models", get(settings_llm_models))
        .route("/web/settings/llm/models/get", get(settings_llm_model_get))
        .route("/web/settings/llm/models/add", post(settings_llm_model_add))
        .route("/web/settings/llm/models/remove", post(settings_llm_model_remove))
        .route("/web/settings/llm/models/update", post(settings_llm_model_update))
        .route("/web/settings/llm/models/toggle", post(settings_llm_model_toggle))
        .route("/web/settings/llm/models/default", post(settings_llm_model_default))
        // ── Phase A: attachments ──
        .route("/web/chat/attachment/upload", post(attachments_api::upload))
        .route("/web/chat/attachment/meta", get(attachments_api::meta))
        .route("/web/chat/attachment/list", get(attachments_api::list))
        // ── Phase B: loop tasks ──
        .route("/web/chat/loop/list", get(loop_api::list))
        .route("/web/chat/loop/get", get(loop_api::get))
        .route("/web/chat/loop-run", get(chat_loop_run))
        .route("/web/chat/loop/add", post(loop_api::add))
        .route("/web/chat/loop/update", post(loop_api::update))
        .route("/web/chat/loop/remove", post(loop_api::remove))
        .route("/web/chat/loop/toggle", post(loop_api::toggle))
        .route("/web/chat/loop/trigger", post(loop_api::trigger))
        // ── Phase C: IM channels ──
        .route("/web/chat/wechat/qrcode", get(channels_api::wechat_qrcode))
        .route("/web/chat/wechat/qrcode/status", get(channels_api::wechat_qrcode_status))
        .route("/web/chat/wechat/unbind", post(channels_api::wechat_unbind))
        .route("/web/chat/wechat/status", get(channels_api::wechat_status))
        .route("/web/chat/feishu/bind", post(channels_api::feishu_bind))
        .route("/web/chat/feishu/unbind", post(channels_api::feishu_unbind))
        .route("/web/chat/feishu/status", get(channels_api::feishu_status))
        .route("/web/chat/dingtalk/bind", post(channels_api::dingtalk_bind))
        .route("/web/chat/dingtalk/unbind", post(channels_api::dingtalk_unbind))
        .route("/web/chat/dingtalk/status", get(channels_api::dingtalk_status))
        .route("/chat/channel/status", get(channels_api::channel_status))
        .route("/chat/channel/sessions", get(channels_api::channel_sessions))
        .route("/chat/channel/routing", post(channels_api::channel_routing))
        // ── Phase D: file changes ──
        .route("/web/chat/changes/run", get(changes_api::run))
        .route("/web/chat/changes/diff", get(changes_api::diff))
        .route("/web/chat/changes/session", get(changes_api::session))
        .route("/web/chat/changes/undo/file", post(changes_api::undo_file))
        .route("/web/chat/changes/undo/run", post(changes_api::undo_run))
        .route("/web/chat/changes/reapply/run", post(changes_api::reapply_run))
        // ── Projects / filer / git ──
        .route("/web/chat/projects", get(projects_api::list))
        .route("/web/chat/projects/add", post(projects_api::add))
        .route("/web/chat/projects/create", post(projects_api::create))
        .route("/web/chat/projects/mkdir", post(projects_api::mkdir))
        .route("/web/chat/projects/browse", get(projects_api::browse))
        .route("/web/chat/projects/remove", post(projects_api::remove))
        .route("/web/chat/projects/rename", post(projects_api::rename))
        .route("/web/chat/projects/locate", post(projects_api::locate))
        .route("/web/chat/filer/tree", get(filer_api::tree))
        .route("/web/chat/filer/read", get(filer_api::read))
        .route("/web/chat/filer/write", post(filer_api::write))
        .route("/web/chat/filer/search", get(filer_api::search))
        .route("/web/chat/filer/raw", get(filer_api::raw))
        .route("/web/chat/filer/watch", post(filer_api::watch))
        .route("/web/chat/git/status", get(git_api::status))
        .route("/web/chat/git/diff", get(git_api::diff))
        .route("/web/chat/git/stage", post(git_api::stage))
        .route("/web/chat/git/unstage", post(git_api::unstage))
        .route("/web/chat/git/commit", post(git_api::commit))
        // POST: asks the session's model to draft a commit message from the
        // diff (Java `GitService.summary`). GET on the same path is the plain
        // commit-history listing, kept for tooling that polls the log.
        .route("/web/chat/git/summary", post(git_api::summary).get(git_api::log))
        .route("/web/chat/git/log", get(git_api::log))
        .route("/web/chat/git/init", post(git_api::init))
        .route("/web/chat/git/remote", get(git_api::remote))
        .route("/web/chat/git/file-content", get(git_api::file_content))
        // ── Queue / steer / rewind / replay / tool-usage ──
        .route("/web/chat/queue", get(misc_api::queue_list))
        .route("/web/chat/queue/add", post(misc_api::queue_add))
        .route("/web/chat/queue/shift", post(misc_api::queue_shift))
        .route("/web/chat/queue/clear", post(misc_api::queue_clear))
        .route("/web/chat/steer", post(misc_api::steer))
        .route("/web/chat/rewind", post(misc_api::rewind))
        .route("/web/chat/replay/full", get(misc_api::replay_full))
        .route("/web/chat/session/tool-usage", get(misc_api::tool_usage))
        // ── Settings extras (ACP / skills / MCP / providers / OpenAPI) ──
        // LSP was removed from both kernels by product decision; do not re-add
        // routes here without also restoring the settings UI.
        .route("/web/settings/acp/info", get(settings_api::acp_info))
        .route("/web/settings/acp/model/save", post(settings_api::acp_model_save))
        .route("/web/settings/acp/thinking/save", post(settings_api::acp_thinking_save))
        .route("/web/settings/acp/context/save", post(settings_api::acp_context_save))
        .route("/web/settings/skills/installed", get(settings_api::skills_installed))
        // `markets` lives with the rest of the marketplace chain: it must list
        // every registered adapter (skillhub / clawhub / modelscope). A
        // hardcoded single-market stub here silently deletes the other tabs.
        .route("/web/settings/skills/markets", get(skills_market_api::skills_markets))
        .route("/web/settings/skills/uninstall", post(settings_api::skills_uninstall))
        .route("/web/settings/skills/toggle", post(settings_api::skills_toggle))
        // Marketplace chain. `install` is POST + form-encoded because the
        // frontend's $.ajax sends no contentType (jQuery then uses
        // x-www-form-urlencoded); the other four are GET + query.
        .route("/web/settings/skills/proxy", get(skills_market_api::skills_proxy))
        .route("/web/settings/skills/detail", get(skills_market_api::skills_detail))
        .route("/web/settings/skills/categories", get(skills_market_api::skills_categories))
        .route("/web/settings/skills/install", post(skills_market_api::skills_install))
        .route("/web/settings/skills/icon", get(skills_market_api::skills_icon))
        .route("/web/settings/mcp/servers", get(settings_api::mcp_servers))
        .route("/web/settings/mcp/servers/add", post(settings_api::mcp_server_add))
        .route("/web/settings/mcp/servers/update", post(settings_api::mcp_server_update))
        .route("/web/settings/mcp/servers/remove", post(settings_api::mcp_server_remove))
        .route("/web/settings/mcp/servers/toggle", post(settings_api::mcp_server_toggle))
        .route("/web/settings/mcp/servers/check", post(settings_api::mcp_server_check))
        .route("/web/settings/mcp/servers/tools", get(settings_api::mcp_server_tools))
        .route("/web/settings/mcp/servers/tools/save", post(settings_api::mcp_server_tools_save))
        .route("/web/settings/mcp/import/parse", post(settings_api::mcp_import_parse))
        .route("/web/settings/mcp/import/parse/string", post(settings_api::mcp_import_parse_string))
        .route("/web/settings/providers", get(settings_api::providers_list))
        .route("/web/settings/providers/get", get(settings_api::providers_get))
        .route("/web/settings/providers/add", post(settings_api::providers_add))
        .route("/web/settings/providers/update", post(settings_api::providers_update))
        .route("/web/settings/providers/remove", post(settings_api::providers_remove))
        .route("/web/settings/providers/toggle", post(settings_api::providers_toggle))
        .route("/web/settings/providers/fetch", post(settings_api::providers_fetch))
        .route("/web/settings/providers/sync-models", post(settings_api::providers_sync_models))
        .route("/web/settings/openapi/servers", get(settings_api::openapi_servers))
        .route("/web/settings/openapi/servers/add", post(settings_api::openapi_server_add))
        .route("/web/settings/openapi/servers/update", post(settings_api::openapi_server_update))
        .route("/web/settings/openapi/servers/remove", post(settings_api::openapi_server_remove))
        .route("/web/settings/openapi/servers/toggle", post(settings_api::openapi_server_toggle))
        .route("/web/settings/openapi/servers/check", post(settings_api::openapi_server_check))
        .route("/web/settings/openapi/servers/apis", get(settings_api::openapi_server_apis))
        .route("/web/settings/openapi/servers/apis/save", post(settings_api::openapi_server_apis_save))
        .route("/web/settings/overlay", post(settings_api::overlay))
        .route("/web/settings/mirror-state", get(settings_api::mirror_state))
        .route("/web/gate", get(ws_gate))
        .route("/web/terminal", get(ws_terminal));

    // Serve static UI files if a directory is provided.
    //
    // Registered BEFORE the layers below on purpose. `Router::layer` wraps the
    // routes present at the time it is called; adding the fallback afterwards
    // would leave the whole static surface outside the guard. Whether axum also
    // retro-applies a layer to a later fallback is not something to bet a
    // security boundary on, so the ordering makes it structurally impossible to
    // get wrong.
    let app = if let Some(dir) = &static_dir {
        app.fallback_service(
            tower_http::services::ServeDir::new(dir)
                .append_index_html_on_directories(true),
        )
    } else {
        app
    };

    // ── Request guard: Origin/Host check + Basic Auth ────────────────────────
    //
    // Applied to the whole router, not to individual routes: `/web/terminal`
    // spawns an interactive shell and `/web/chat/input` drives the agent, so any
    // route left out is a remote-code-execution entry point. See `guard` for the
    // reproduced attack chain.
    //
    // Layer order: `.layer()` calls wrap in reverse, so the guard added first
    // runs *outermost* — matching Java, which registers `WebAuthFilter` ahead of
    // `CrossFilter` (`App.java:192-194`). A rejected request never reaches a
    // handler, and the CORS layer still decorates the rejection response.
    let app = app
        .layer(guard::cors_layer())
        .layer(axum::middleware::from_fn_with_state(state.clone(), guard_middleware));

    let app = app.with_state(state);

    info!(addr = %addr, "GWork Rust kernel server starting");
    // The listener was bound at the top of this function, before any eager
    // loading, so the port is already connectable by the time we get here.
    axum::serve(listener, app).await?;
    Ok(())
}

/// Middleware adapter for [`guard::classify`].
///
/// Reads the credentials from `AppState` on every request rather than capturing
/// them once at startup: the settings page can change them at runtime, and a
/// stale capture would mean a newly-set password silently did not take effect
/// until the next restart (or, worse, a cleared password kept rejecting).
async fn guard_middleware(
    State(state): State<Arc<AppState>>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let (parts, body) = req.into_parts();
    let method = parts.method.clone();
    let path = guard::path_of(&parts.uri).to_string();
    let (origin, host, authorization) = guard::parts_from(&parts);

    let auth = {
        let settings = state.settings.read().await;
        guard::BasicAuth::effective(
            settings.general.web_auth_user.as_deref(),
            settings.general.web_auth_pass.as_deref(),
        )
    };

    let verdict = guard::classify(
        &method,
        &path,
        origin.as_deref(),
        host.as_deref(),
        authorization.as_deref(),
        &auth,
    );
    if verdict != guard::Verdict::Allow {
        // Log rejections: a silent 403 looks exactly like a broken frontend, and
        // the reason string is the only thing that distinguishes "malicious page"
        // from "user typed the wrong password".
        tracing::warn!(
            method = %method,
            path = %path,
            origin = origin.as_deref().unwrap_or("-"),
            host = host.as_deref().unwrap_or("-"),
            verdict = ?verdict,
            "request rejected by guard"
        );
        return guard::reject(&verdict);
    }

    next.run(axum::extract::Request::from_parts(parts, body)).await
}

/// Load MCP server configs from settings.json "mcpServers" key.
fn load_mcp_servers() -> HashMap<String, crate::mcp::McpServerConfig> {
    let home = Settings::gwork_home();
    let path = home.join("settings.json");
    let Ok(content) = std::fs::read_to_string(&path) else {
        return HashMap::new();
    };
    // Strip a leading BOM before parsing: serde_json rejects it outright, and
    // without this a Notepad-saved settings.json made every MCP server silently
    // disappear (the parse below failed into the empty map, no log, no hint).
    // Same strip as `Settings::load_from` and the settings writers.
    let Ok(v) = serde_json::from_str::<serde_json::Value>(crate::config::strip_bom(&content)) else {
        return HashMap::new();
    };
    let Some(servers) = v.get("mcpServers").and_then(|s| s.as_object()) else {
        return HashMap::new();
    };

    // Parse **per entry** rather than the whole map at once. With a single
    // `from_value::<HashMap<..>>` call, one malformed entry made the entire map
    // fail and `unwrap_or_default()` turned that into "user has no MCP servers"
    // — silent, total, and undiagnosable from the UI. Skipping only the bad
    // entry keeps the rest working and logs what went wrong.
    let mut out = HashMap::new();
    for (name, entry) in servers {
        match serde_json::from_value::<crate::mcp::McpServerConfig>(entry.clone()) {
            Ok(cfg) => {
                out.insert(name.clone(), cfg);
            }
            Err(e) => {
                tracing::warn!(server = %name, error = %e, "skipping malformed mcpServers entry");
            }
        }
    }
    out
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async fn chat_meta(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let settings = state.settings.read().await;
    let home = dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    Json(serde_json::json!({
        "code": 200,
        "data": {
            "title": "GWork",
            // Single source of truth: [workspace.package].version in the root
            // Cargo.toml (every crate sets `version.workspace = true`). This was
            // a hardcoded "0.4.0-rust" that had drifted from the 0.3.0 in
            // Cargo.toml / tauri.conf.json / package.json, so the About panel and
            // the installer filename disagreed. Same pattern as acp.rs.
            "version": env!("CARGO_PKG_VERSION"),
            "workspace": state.workspace.to_string_lossy(),
            "homeDir": home,
            "defaultModel": settings.default_model,
            "locale": settings.general.locale,
            "darkMode": settings.general.dark_mode,
        }
    }))
}

/// Session store routed by ownership: bound sessions live under their
/// project root (`<root>/.gwork/sessions/`), unbound ones in the global
/// area. Mirrors the Java kernel's SessionLocator resolution so both
/// kernels read and write the same directory for a given session.
pub(crate) fn store_for(state: &AppState, session_id: &str) -> SessionStore {
    match state.session_roots.bound_root(session_id) {
        Some(root) => SessionStore::with_base(crate::session::sessions_root_for(&root)),
        None => SessionStore::new(),
    }
}

/// Decode and validate the `X-Session-Cwd` header (percent-encoded absolute
/// path), bind the session to that root, and return the routed store.
/// Absent/invalid header → routed store without a new binding, same fallback
/// as the Java kernel.
/// Pull the raw `X-Session-Cwd` header off a request. No decoding here:
/// `bind_session_cwd` owns it (it also owns the "absent → existing binding or
/// global area" rule), so every caller must hand it the untouched value.
fn cwd_header_of(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get("x-session-cwd")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

pub(crate) fn bind_session_cwd(state: &AppState, session_id: &str, header: Option<&str>) -> SessionStore {
    let Some(raw) = header else {
        return store_for(state, session_id);
    };
    let decoded = percent_decode(raw);
    if decoded.is_empty() || decoded.contains("..") {
        return store_for(state, session_id);
    }
    // Existence gate, deliberately kept.
    //
    // It looks like it would break remote workspaces ("the shell sends paths
    // from another machine"), but it does not: in remote-deployed mode this
    // kernel runs **on the remote host**, so the cwd it receives is a local path
    // from its own point of view and `is_dir()` passes. Same for the WSL channel
    // (the kernel runs inside the distro). There is no deployment shape where a
    // legitimate cwd is invisible to the process that must store sessions under
    // it.
    //
    // What the gate does buy is real: without it, a stale `localStorage` cwd (a
    // directory the user deleted, or a remote path left over from a disconnected
    // connection) would be accepted as an owning root, and the first write would
    // create a whole `<cwd>/.gwork/sessions/<sid>` tree at an arbitrary path.
    // Falling back to the global area instead is the safe answer, and it matches
    // the header's documented contract ("absent/invalid → existing binding or
    // global area").
    //
    // Java's `SessionLocator.bindSessionRoot` skips this check, but it also has
    // `detectDataHome` scanning candidate roots for existing data — a different
    // way of avoiding the same "bind to a path with nothing there" outcome.
    // This kernel has no such scan, so the existence check is what stands in for
    // it. Removing it without adding that scan would be a net loss.
    let root = std::path::Path::new(&decoded);
    if !root.is_dir() {
        return store_for(state, session_id);
    }
    let normalized = root.to_string_lossy().to_string();
    state.session_roots.bind(session_id, &normalized);
    SessionStore::with_base(crate::session::sessions_root_for(&normalized))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Session ids currently occupied by loop tasks (runtime + bound); the
/// sidebar renders a clock icon on those entries.
async fn loop_session_ids(state: &AppState) -> std::collections::HashSet<String> {
    let tasks = state.loop_scheduler.list_all_global().await;
    let mut ids = std::collections::HashSet::new();
    for t in &tasks {
        if let Some(id) = &t.runtime_session_id {
            ids.insert(id.clone());
        }
        if let Some(id) = &t.bound_session_id {
            ids.insert(id.clone());
        }
    }
    ids
}

/// Session list entry in the Java kernel's wire shape:
/// `{sessionId, label, time, projectRoot?, loop?}`. The frontend's
/// `toSessionEntries` reads exactly these keys; any other shape renders an
/// empty sidebar.
fn session_item(
    id: &str,
    title: &str,
    time: i64,
    project_root: Option<&str>,
    is_loop: bool,
) -> serde_json::Value {
    let mut item = serde_json::json!({
        "sessionId": id,
        "label": title,
        "time": time,
    });
    if let Some(root) = project_root {
        item["projectRoot"] = serde_json::json!(root);
    }
    if is_loop {
        item["loop"] = serde_json::json!(true);
    }
    item
}

#[derive(serde::Deserialize)]
struct SessionsQuery {
    #[serde(default)]
    root: String,
}

async fn chat_sessions(
    State(state): State<Arc<AppState>>,
    Query(q): Query<SessionsQuery>,
) -> Json<serde_json::Value> {
    let loop_ids = loop_session_ids(&state).await;
    let root = q.root.trim().to_string();

    let items: Vec<serde_json::Value> = if root.is_empty() {
        // Global view: sessions in the global area that are NOT bound to a
        // project. The Java kernel removes bound leftovers from the global
        // list; bound sessions are listed under their project instead.
        state
            .session_store
            .list_sessions()
            .iter()
            .filter(|s| state.session_roots.bound_root(&s.id).is_none())
            .map(|s| session_item(&s.id, &s.title, s.last_activity, None, loop_ids.contains(&s.id)))
            .collect()
    } else {
        // Project view: sessions stored under that root.
        let dir = crate::session::sessions_root_for(&root);
        state
            .session_store
            .list_sessions_in(&dir)
            .iter()
            .map(|s| {
                session_item(
                    &s.id,
                    &s.title,
                    s.last_activity,
                    Some(root.as_str()),
                    loop_ids.contains(&s.id),
                )
            })
            .collect()
    };
    Json(serde_json::json!({ "code": 200, "data": items }))
}

#[derive(serde::Deserialize)]
struct SessionIdQuery {
    #[serde(rename = "sessionId", default)]
    session_id: String,
    /// Owning workspace root. The frontend appends it (`rootQ`) for every
    /// project-scoped session; without honouring it the delete resolves against
    /// the global area and silently misses the real directory.
    #[serde(default)]
    root: String,
}

/// Resolve the store for a session, preferring an explicit `root`.
///
/// Precedence: explicit absolute `root` → the ownership registry → global.
///
/// The registry alone is not sufficient: it is an in-memory map persisted to
/// `session-roots.json`, and a binding recorded by the *other* kernel (or lost
/// when that file is rewritten) leaves this kernel with no entry, so a
/// project-scoped session would resolve to the global area. The frontend always
/// knows the root it listed the session under, so its value wins.
fn store_for_root(state: &AppState, session_id: &str, root: &str) -> SessionStore {
    let trimmed = root.trim();
    if !trimmed.is_empty() && std::path::Path::new(trimmed).is_absolute() {
        return SessionStore::with_base(crate::session::sessions_root_for(trimmed));
    }
    store_for(state, session_id)
}

// ── Suspension persistence ────────────────────────────────────────────────
//
// WHY THIS EXISTS: the in-memory `suspensions` map is lost on restart. A session
// that was waiting on an approval or a question then hangs forever — the card is
// still on screen (the frontend replays it from the stream), the user clicks it,
// and `/web/chat/input` answers **409 "No pending approval"** because the map is
// empty. Persisting the suspension next to the session makes it survive a
// restart; the in-memory map stays as a hot cache and the disk is the fallback.
//
// Stored at `<sessionDir>/suspension.json`, routed through `store_for` exactly
// like `context.json`, so a project session's suspension lives under the
// project's `.gwork/sessions/<sid>/` and a global one under
// `~/.gwork/sessions/<sid>/`. `session-roots.json` (already persisted) restores
// the same routing after a restart, so the file is found again.

/// On-disk path of a session's suspension point.
fn suspension_file(state: &AppState, session_id: &str) -> std::path::PathBuf {
    store_for(state, session_id)
        .session_dir_pub(session_id)
        .join("suspension.json")
}

/// Persist a suspension point (write-through, called at the single insert site).
fn persist_suspension(state: &AppState, session_id: &str, sp: &SuspensionPoint) {
    let path = suspension_file(state, session_id);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string(sp) {
        // Atomic temp+rename: a crash mid-write must not leave a truncated file
        // that parses as "no suspension" and strands the session anyway.
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

/// Read a persisted suspension point (the disk fallback for the in-memory map).
/// A missing or corrupt file yields `None` — an unreadable suspension degrades to
/// "nothing pending", the same as before this existed, never a hard error.
fn read_suspension_file(state: &AppState, session_id: &str) -> Option<SuspensionPoint> {
    let raw = std::fs::read_to_string(suspension_file(state, session_id)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Delete the persisted suspension point.
fn clear_suspension_file(state: &AppState, session_id: &str) {
    let _ = std::fs::remove_file(suspension_file(state, session_id));
}

/// A suspension older than this is treated as expired.
///
/// Two reasons, one safety and one hygiene:
/// * **Safety** — a stale approval must not be honoured. If the kernel suspended
///   on `rm -rf …` yesterday and the user clicks the (still-rendered) card today,
///   executing that command now is not what they think they are approving. The
///   Java kernel sidesteps this by keeping suspensions purely in the live session
///   snapshot, which does not survive a restart at all; now that this kernel
///   *persists* them, an age bound is what stops a resurrected card from firing.
/// * **Hygiene** — the one leftover case the persistence layer cannot otherwise
///   reach is "suspended, then the user never answers, never deletes, never
///   interrupts". Such an entry would sit on disk forever; the lazy check below
///   removes it the next time anything touches that session.
///
/// 24 h is comfortably longer than any real approval decision and shorter than
/// "stale". It is a time bound, not a count bound, so an LRU would be the wrong
/// tool (a busy session must not evict a genuinely pending approval).
const SUSPENSION_TTL_MS: i64 = 24 * 60 * 60 * 1000;

/// Whether a suspension has outlived [`SUSPENSION_TTL_MS`].
///
/// Pure (takes `now_ms`) so the boundary is unit-testable without waiting a day.
/// A suspension whose clock is skewed into the future (`age < 0`) is **not**
/// expired — a bad timestamp must not silently discard a live approval.
fn suspension_expired_at(sp: &SuspensionPoint, now_ms: i64) -> bool {
    let age = now_ms - sp.created_at;
    age > SUSPENSION_TTL_MS
}

/// Atomically read, validate and consume the pending suspension.
///
/// The whole **read → validate → remove** happens under ONE lock hold (and the
/// disk fallback is read under that same hold), so two concurrent submissions
/// cannot both pass validation and both resume the run. That race matters here:
/// a double resume would execute an approved **irreversible** command (`rm -rf`
/// and friends) twice, or inject a question answer twice. An earlier
/// peek-then-drop split took the lock twice and reopened exactly that window.
///
/// `validate` returns `Ok(())` to consume, or `Err(description)` to reject
/// **without** consuming — an actionId mismatch or a wrong-kind submission must
/// leave the suspension intact on both memory and disk, so the correct
/// submission afterwards still finds it.
///
/// Returns:
/// * `Ok(Some(sp))` — validated and consumed (memory + disk both cleared);
/// * `Ok(None)` — nothing pending;
/// * `Err(desc)` — validation failed, suspension left intact.
async fn consume_suspension<F>(
    state: &AppState,
    session_id: &str,
    validate: F,
) -> Result<Option<SuspensionPoint>, &'static str>
where
    F: FnOnce(&SuspensionPoint) -> Result<(), &'static str>,
{
    let mut susp = state.suspensions.lock().await;
    // In-memory first, disk fallback — both under the lock, so a concurrent
    // request cannot slip in between the read and the removal. The disk read is a
    // tiny file and this path is cold (only on approve/answer), so holding the
    // mutex across it is fine; correctness (atomicity) outweighs the micro-cost.
    let sp = match susp.get(session_id) {
        Some(sp) => sp.clone(),
        None => match read_suspension_file(state, session_id) {
            Some(sp) => sp,
            None => return Ok(None),
        },
    };
    // TTL gate, before validation: an expired suspension is treated as absent and
    // cleaned from both memory and disk, so a stale approval is never honoured and
    // the on-disk file does not linger. Surfacing it as `Ok(None)` ("nothing
    // pending") makes the caller answer 409, exactly as if it had already been
    // consumed — the frontend then drops the dead card.
    if suspension_expired_at(&sp, chrono::Utc::now().timestamp_millis()) {
        susp.remove(session_id);
        clear_suspension_file(state, session_id);
        return Ok(None);
    }
    if let Err(desc) = validate(&sp) {
        return Err(desc);
    }
    susp.remove(session_id);
    clear_suspension_file(state, session_id);
    Ok(Some(sp))
}

/// Consume the pending suspension from both memory and disk unconditionally (no
/// validation). Used by delete/interrupt, which clear whatever is pending.
async fn drop_suspension(state: &AppState, session_id: &str) {
    state.suspensions.lock().await.remove(session_id);
    clear_suspension_file(state, session_id);
}

async fn chat_sessions_delete(
    State(state): State<Arc<AppState>>,
    Query(q): Query<SessionIdQuery>,
    form: Option<Form<SessionIdQuery>>,
) -> Json<serde_json::Value> {
    // Accept sessionId from query string OR form body
    let (session_id, root) = if !q.session_id.is_empty() {
        (q.session_id, q.root)
    } else if let Some(Form(f)) = form {
        (f.session_id, f.root)
    } else {
        (String::new(), String::new())
    };
    if !SessionStore::is_valid_id(&session_id) {
        return Json(serde_json::json!({"code": 400, "description": "Invalid session ID"}));
    }

    // Stop any in-flight run first: a live task keeps appending frames and would
    // recreate the directory after deletion (Java interrupts for the same reason).
    if let Some(t) = state.running.lock().await.remove(&session_id) {
        t.cancel.cancel();
    }
    // Remove from memory AND disk: a suspension persisted before a restart must
    // not survive the session it belonged to.
    drop_suspension(&state, &session_id).await;
    // Evict the per-session in-memory maps too. They are keyed by sessionId and
    // grow without bound: `seq_counters` (event sequence), `session_models`
    // (model override) and `session_access` (access-mode override) are written on
    // every chat turn but were never removed here, so a long-lived kernel that
    // creates and deletes many sessions leaks one entry per deleted session in
    // each map. The Java kernel drops the whole session object on delete
    // (`engine.removeSession` + `webGate.cleanupSession`); these three maps are
    // this kernel's equivalent of that per-session state.
    state.seq_counters.lock().await.remove(&session_id);
    state.session_models.lock().await.remove(&session_id);
    state.session_access.lock().await.remove(&session_id);

    let store = store_for_root(&state, &session_id, &root);
    // Report the real outcome. Answering 200 unconditionally — as this handler
    // did — made a failed delete look successful: the frontend then dropped its
    // local state while the directory stayed on disk, so the session reappeared
    // on the next refresh and could not be removed at all.
    match store.delete_session(&session_id) {
        Ok(true) => {
            // Forget the ownership binding so a re-created session with the same
            // id is not routed to a stale root.
            state.session_roots.unbind(&session_id);
            Json(serde_json::json!({"code": 200, "data": {"deleted": true}}))
        }
        Ok(false) => Json(serde_json::json!({"code": 404, "description": "Session not found"})),
        Err(e) => Json(serde_json::json!({
            "code": 500,
            "description": format!("会话目录删除失败: {}", e)
        })),
    }
}

#[derive(serde::Deserialize)]
struct RenameForm {
    #[serde(rename = "sessionId", default)]
    session_id: String,
    /// Frontend sends `label` (Java contract); `title` accepted for compat.
    #[serde(default)]
    label: String,
    #[serde(default)]
    title: String,
    /// Owning workspace root; routes the write to the project sessions dir.
    #[serde(default)]
    root: String,
}

async fn chat_sessions_rename(
    State(state): State<Arc<AppState>>,
    Form(form): Form<RenameForm>,
) -> Json<serde_json::Value> {
    if !SessionStore::is_valid_id(&form.session_id) {
        return Json(serde_json::json!({"code": 400, "description": "Invalid session ID"}));
    }
    let label = if !form.label.trim().is_empty() {
        form.label.trim().to_string()
    } else {
        form.title.trim().to_string()
    };
    if label.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "Label is required"}));
    }
    let store = if form.root.trim().is_empty() {
        store_for(&state, &form.session_id)
    } else {
        SessionStore::with_base(crate::session::sessions_root_for(form.root.trim()))
    };
    store.rename_session(&form.session_id, &label);
    Json(serde_json::json!({"code": 200}))
}

async fn chat_models(State(state): State<Arc<AppState>>, Query(q): Query<SessionIdQuery>) -> Json<serde_json::Value> {
    let settings = state.settings.read().await;
    // Wire shape must match the Java kernel exactly: the frontend validates
    // `Array.isArray(data.list)` and treats anything else as a failed load
    // (empty dropdown, "no matching models").
    let list: Vec<serde_json::Value> = settings
        .models
        .values()
        .filter(|m| m.enabled && m.visibled)
        .map(|m| {
            serde_json::json!({
                "model": m.model,
                "name": m.name,
                "description": m.description_or_model(),
                "standard": m.standard,
                "provider": m.provider,
                "thinkingLevels": crate::reasoning::selectable_codes(&m.standard, &m.model),
            })
        })
        .collect();

    // Per-session UI context (persisted next to the session so a restart
    // restores what the picker showed).
    let ctx = if q.session_id.is_empty() {
        crate::session::SessionContext::default()
    } else {
        store_for(&state, &q.session_id).read_context(&q.session_id)
    };

    // Resolve selected model: live session override > persisted context > default
    let selected = if q.session_id.is_empty() {
        settings.default_model.clone()
    } else {
        let sm = state.session_models.lock().await;
        match sm.get(&q.session_id).cloned() {
            Some(name) => name,
            None => ctx
                .model
                .clone()
                .unwrap_or_else(|| settings.default_model.clone()),
        }
    };

    // Access mode: same precedence as the run path (`resolve_access_mode`), so
    // what the picker shows is exactly what the next run will enforce.
    let access_mode = if q.session_id.is_empty() {
        "default".to_string()
    } else {
        let am = state.session_access.lock().await;
        resolve_access_mode(
            "",
            am.get(&q.session_id).map(String::as_str),
            ctx.access_mode.as_deref(),
        )
    };

    let thinking_depth = ctx.thinking.unwrap_or_else(|| "auto".into());
    let context_length = ctx.context_length.unwrap_or(crate::usage::DEFAULT_CONTEXT_LENGTH);

    Json(serde_json::json!({
        "code": 200,
        "data": {
            "list": list,
            "selected": selected,
            "thinkingDepth": thinking_depth,
            "contextLength": context_length,
            "contextLengthDefault": crate::usage::DEFAULT_CONTEXT_LENGTH,
            "contextOptions": crate::usage::CONTEXT_LENGTH_OPTIONS,
            "accessMode": access_mode,
        }
    }))
}

#[derive(serde::Deserialize)]
struct ModelSelectForm {
    #[serde(default)]
    model: String,
    #[serde(rename = "modelName", default)]
    model_name: String,
    #[serde(rename = "sessionId", default)]
    session_id: String,
}

async fn chat_models_select(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Form(form): Form<ModelSelectForm>,
) -> Json<serde_json::Value> {
    // Frontend sends "modelName"; accept both for compatibility.
    let model = if !form.model_name.is_empty() {
        form.model_name
    } else {
        form.model
    };
    let exists = {
        let settings = state.settings.read().await;
        settings.models.contains_key(&model)
    };
    if !exists {
        return Json(serde_json::json!({"code": 404, "description": "Model not found"}));
    }

    if form.session_id.is_empty() {
        // No session (settings page): change the global default.
        {
            let mut settings = state.settings.write().await;
            settings.default_model = model.clone();
        }
        save_default_model(&model);
    } else {
        // Session-level selection ONLY. The Java kernel writes the session
        // context here and never touches the global default; rewriting
        // settings.json from a per-session picker change would silently
        // change every future session's model.
        state
            .session_models
            .lock()
            .await
            .insert(form.session_id.clone(), model.clone());
        let store = bind_session_cwd(&state, &form.session_id, cwd_header_of(&headers).as_deref());
        // Field-level update under the store's process-wide lock: the welcome
        // page inherits model + thinking + context in three concurrent POSTs,
        // and a whole-document read/modify/write here silently dropped whichever
        // sibling field the other requests had just written.
        store.update_context(&form.session_id, |ctx| ctx.model = Some(model));
    }
    Json(serde_json::json!({"code": 200}))
}

fn save_default_model(model: &str) {
    let home = Settings::gwork_home();
    let path = home.join("settings.json");
    if let Ok(content) = std::fs::read_to_string(&path) {
        if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(obj) = v.as_object_mut() {
                obj.insert("defaultModel".into(), serde_json::json!(model));
                let _ = std::fs::write(&path, serde_json::to_string_pretty(&v).unwrap_or_default());
            }
        }
    }
}

#[derive(serde::Deserialize)]
#[allow(dead_code)]
struct ThinkingForm {
    #[serde(rename = "sessionId", default)]
    session_id: String,
    #[serde(default)]
    depth: String,
}

async fn chat_thinking_select(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Form(form): Form<ThinkingForm>,
) -> Json<serde_json::Value> {
    if let Some(r) = reject_bad_session_id(&form.session_id) {
        return r;
    }
    if !form.session_id.is_empty() && !form.depth.is_empty() {
        let store = bind_session_cwd(&state, &form.session_id, cwd_header_of(&headers).as_deref());
        let depth = form.depth.clone();
        store.update_context(&form.session_id, |ctx| ctx.thinking = Some(depth));
        return Json(serde_json::json!({"code": 200, "data": form.depth}));
    }
    Json(serde_json::json!({"code": 200}))
}

#[derive(serde::Deserialize)]
#[allow(dead_code)]
struct ContextForm {
    #[serde(rename = "sessionId", default)]
    session_id: String,
    /// The frontend sends **`contextLength`** (`app-history.js` posts
    /// `{sessionId, contextLength}`), matching the Java kernel's
    /// `@Param("contextLength")`. This struct used to declare only `length`,
    /// so the field never bound: the handler saw an empty value, took the
    /// "nothing to do" branch and answered `code:200` — the context-length
    /// picker looked like it worked while persisting nothing at all.
    /// `length` is kept as an alias so any caller using the old name still works.
    #[serde(rename = "contextLength", alias = "length", default)]
    context_length: String,
}

async fn chat_context_select(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Form(form): Form<ContextForm>,
) -> Json<serde_json::Value> {
    if let Some(r) = reject_bad_session_id(&form.session_id) {
        return r;
    }
    if !form.session_id.is_empty() && !form.context_length.is_empty() {
        let parsed: i64 = form.context_length.trim().parse().unwrap_or(0);
        if crate::usage::CONTEXT_LENGTH_OPTIONS.contains(&parsed) {
            let store = bind_session_cwd(&state, &form.session_id, cwd_header_of(&headers).as_deref());
            store.update_context(&form.session_id, |ctx| ctx.context_length = Some(parsed));
            return Json(serde_json::json!({"code": 200, "data": parsed}));
        }
        return Json(serde_json::json!({"code": 400, "description": "Unsupported context length"}));
    }
    Json(serde_json::json!({"code": 200}))
}

/// Reject a `sessionId` that could escape the sessions root, the way the Java
/// kernel does (`Assert.isEmpty || contains("..") || contains("/") ||
/// contains("\\")` → `Result.failure("invalid_session")`).
///
/// Returns `None` when the id is acceptable. An **empty** id is allowed through
/// because several endpoints treat "no session" as a legitimate global-scope
/// call; `SessionStore::sanitize_id` is the backstop for everything else.
fn reject_bad_session_id(session_id: &str) -> Option<Json<serde_json::Value>> {
    if session_id.is_empty() {
        return None;
    }
    if session_id.contains("..") || session_id.contains('/') || session_id.contains('\\') {
        return Some(Json(serde_json::json!({"code": 400, "description": "invalid_session"})));
    }
    None
}

#[derive(serde::Deserialize)]
struct AccessForm {
    #[serde(rename = "sessionId", default)]
    session_id: String,
    #[serde(rename = "accessMode", default)]
    access_mode: String,
    #[serde(default)]
    mode: String,
}

async fn chat_access_select(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Form(form): Form<AccessForm>,
) -> Json<serde_json::Value> {
    if let Some(r) = reject_bad_session_id(&form.session_id) {
        return r;
    }
    let mode = if !form.access_mode.is_empty() {
        form.access_mode
    } else {
        form.mode
    };
    if !form.session_id.is_empty() && !mode.is_empty() {
        state
            .session_access
            .lock()
            .await
            .insert(form.session_id.clone(), mode.clone());
        // Persist so a restart restores the picker's shown level.
        let store = bind_session_cwd(&state, &form.session_id, cwd_header_of(&headers).as_deref());
        let persisted = mode.clone();
        store.update_context(&form.session_id, |ctx| ctx.access_mode = Some(persisted));
        // If switching to full, release a pending HITL approval — the user has
        // just said "stop asking me", so the card must go away. Consume ONLY a
        // `hitl` suspension (atomically, via `consume_suspension`): a pending
        // **question** (ask_user) is unrelated to the access mode and must survive
        // the switch. The previous `take_suspension` consumed whatever was pending
        // and then broadcast only for `hitl`, so switching to full while a question
        // was waiting silently deleted the question — the card stayed on screen but
        // answering it 409'd. Java's `HITL.clearPending` is likewise HITL-only.
        if mode == "full" {
            // Err(_) here means "a non-hitl suspension is pending" — leave it
            // intact and still report success (the access switch itself worked).
            if let Ok(Some(sp)) = consume_suspension(&state, &form.session_id, |sp| {
                if sp.kind == "hitl" { Ok(()) } else { Err("not an approval") }
            })
            .await
            {
                let frame = Frame::hitl_released(&form.session_id, sp.action_id.as_deref());
                broadcast_frame(&state, &form.session_id, frame).await;
            }
        }
    }
    Json(serde_json::json!({"code": 200}))
}

/// Single precedence rule for a session's access mode, shared by the run path
/// (`run_react_session`) and the display path (`chat_models`) so the picker and
/// the HITL gate can never disagree about the same session.
///
/// explicit request field > live in-memory override > persisted session context
/// > `"default"`. Empty or unrecognised values fall through rather than
/// poisoning the chain: a client that sends `accessMode=` (present but empty)
/// must behave exactly like one that omits the field.
fn resolve_access_mode(explicit: &str, live: Option<&str>, persisted: Option<&str>) -> String {
    for candidate in [explicit, live.unwrap_or_default(), persisted.unwrap_or_default()] {
        match candidate {
            "full" | "default" => return candidate.to_string(),
            _ => continue,
        }
    }
    "default".to_string()
}

#[derive(serde::Deserialize)]
struct MessagesQuery {
    #[serde(rename = "sessionId", default)]
    session_id: String,
}

async fn chat_messages(
    State(state): State<Arc<AppState>>,
    Query(q): Query<MessagesQuery>,
) -> Json<serde_json::Value> {
    if !SessionStore::is_valid_id(&q.session_id) {
        return Json(serde_json::json!({"code": 400, "description": "Invalid session ID"}));
    }
    let store = store_for(&state, &q.session_id);
    let msgs = store.load_messages(&q.session_id);
    let items: Vec<serde_json::Value> = msgs
        .iter()
        .map(|m| {
            // body(): Java assistant lines carry their text under `text`,
            // reading `content` alone yields empty bubbles.
            let mut item = serde_json::json!({
                "role": m.role,
                "content": m.body(),
                "createdAt": m.created_at,
            });
            // Suspension placeholder marker so the frontend can render the
            // question-card anchor exactly like the Java kernel's history.
            if m.is_pending_notice() {
                item["metadata"] = serde_json::json!({ "_pendingNotice": 1 });
            }
            item
        })
        .collect();
    Json(serde_json::json!({"code": 200, "data": items}))
}

#[derive(serde::Deserialize)]
#[allow(dead_code)]
struct ReplayQuery {
    #[serde(rename = "sessionId", default)]
    session_id: String,
    #[serde(default)]
    rounds: u32,
    /// Cursor for "load earlier rounds": only frames with eventSeq below it.
    #[serde(rename = "beforeSeq")]
    before_seq: Option<i64>,
    /// Cursor for live-stream recovery: only frames with eventSeq above it.
    #[serde(rename = "afterSeq")]
    after_seq: Option<i64>,
    #[serde(default)]
    limit: Option<usize>,
    /// Legacy full-load tail (kept for old frontends; capped like Java's
    /// DEFAULT_FULL_TAIL so a bare request can never dump a 100MB stream).
    #[serde(default)]
    tail: Option<usize>,
}

/// Hard cap for the parameter-less legacy branch (mirrors Java's
/// `SessionStreamStore.DEFAULT_FULL_TAIL`).
const REPLAY_DEFAULT_FULL_TAIL: usize = 2000;

/// A conversation round boundary: index of the `user` frame that opens it.
fn round_starts(frames: &[serde_json::Value]) -> Vec<usize> {
    frames
        .iter()
        .enumerate()
        .filter(|(_, f)| f.get("type").and_then(|t| t.as_str()) == Some("user"))
        .map(|(i, _)| i)
        .collect()
}

fn seq_of(frame: &serde_json::Value) -> i64 {
    frame
        .get("eventSeq")
        .and_then(|s| s.as_i64())
        .unwrap_or(0)
}

async fn chat_replay(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ReplayQuery>,
) -> Json<serde_json::Value> {
    if !SessionStore::is_valid_id(&q.session_id) {
        return Json(serde_json::json!({"code": 400, "description": "Invalid session ID"}));
    }
    let store = store_for(&state, &q.session_id);
    let busy = state.is_busy(&q.session_id).await;

    // ── Fast path: one sequential scan, only the requested window parsed ──
    //
    // The old implementation called `load_stream_frames` unconditionally:
    // every line of an 84 MB / 115k-line stream was deserialized into a
    // `Value` tree before *any* branch ran, and every "load earlier" click
    // paid that again. 99% of those lines are `text`/`reason` token deltas;
    // parsing is the bottleneck (a `Value` tree is 2-4x the raw JSON and
    // `#[serde(flatten)]` forces serde's `Content` slow path), not disk IO.
    //
    // `load_replay_window` probes `eventSeq`/`type` as raw text, parses only
    // the selected lines, and projects consecutive same-kind main-line deltas
    // into one frame. That last step matters just as much as the parse: the
    // browser consumes replay frames 50 per animation frame, so 115k deltas
    // alone needed ~38 s of rAF budget (>12 s timeout was the symptom).
    //
    // Response contract is unchanged field-for-field (app-history.js
    // :1899-1911 and app-streaming.js's gate both depend on it).
    let mode = if let Some(after) = q.after_seq {
        crate::session::ReplayMode::After { after_seq: after, limit: q.limit }
    } else if q.rounds > 0 || q.before_seq.is_some() {
        crate::session::ReplayMode::Rounds {
            before_seq: q.before_seq,
            rounds: q.rounds as usize,
        }
    } else {
        crate::session::ReplayMode::Tail { cap: q.tail.unwrap_or(REPLAY_DEFAULT_FULL_TAIL) }
    };
    let w = store.load_replay_window(&q.session_id, mode);
    let run_id = if busy { w.last_run_id } else { None };

    if q.after_seq.is_some() {
        let more = w.total_after > w.events.len();
        let (first, last) = bounds_of(&w.events);
        return Json(serde_json::json!({
            "code": 200,
            "data": {
                "events": w.events,
                "totalCount": 0,
                "totalRounds": 0,
                "remainingRounds": 0,
                "hasMore": more,
                "firstSeq": first,
                "lastSeq": last,
                "latestSeq": last,
                "running": busy,
                "runId": run_id,
            }
        }));
    }

    if q.rounds > 0 || q.before_seq.is_some() {
        if w.total_rounds == 0 {
            return empty_envelope(w.latest_seq, busy, run_id);
        }
        let (first, last) = bounds_of(&w.events);
        return Json(serde_json::json!({
            "code": 200,
            "data": {
                "events": w.events,
                "totalCount": w.events.len(),
                "totalRounds": w.total_rounds,
                "remainingRounds": w.remaining_rounds,
                "hasMore": w.remaining_rounds > 0,
                "firstSeq": first,
                "lastSeq": last,
                "latestSeq": last,
                "running": busy,
                "runId": run_id,
            }
        }));
    }

    // ── legacy parameter-less / tail branch ──
    let (first, last) = bounds_of(&w.events);
    let total_rounds = w.events
        .iter()
        .filter(|f| f.get("type").and_then(|t| t.as_str()) == Some("user"))
        .count();
    Json(serde_json::json!({
        "code": 200,
        "data": {
            "events": w.events,
            "totalCount": 0,
            "totalRounds": total_rounds,
            "remainingRounds": 0,
            "hasMore": false,
            "firstSeq": first,
            "lastSeq": last,
            "latestSeq": last,
            "running": busy,
            "runId": run_id,
        }
    }))
}

fn all_last_seq(frames: &[serde_json::Value]) -> i64 {
    frames.last().map(seq_of).unwrap_or(0)
}

fn empty_envelope(latest: i64, running: bool, run_id: Option<String>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "code": 200,
        "data": {
            "events": Vec::<serde_json::Value>::new(),
            "totalCount": 0,
            "totalRounds": 0,
            "remainingRounds": 0,
            "hasMore": false,
            "firstSeq": 0,
            "lastSeq": 0,
            "latestSeq": latest,
            "running": running,
            "runId": run_id,
        }
    }))
}

fn bounds_of(events: &[serde_json::Value]) -> (i64, i64) {
    (
        events.first().map(seq_of).unwrap_or(0),
        events.last().map(seq_of).unwrap_or(0),
    )
}

// ─── chat_input (the main entry point) ────────────────────────────────────────

#[derive(serde::Deserialize, Default)]
struct InputFields {
    #[serde(default)]
    input: String,
    #[serde(rename = "sessionId", default)]
    session_id: String,
    #[serde(default)]
    model: String,
    #[serde(rename = "questionAnswer", default)]
    question_answer: String,
    #[serde(rename = "hitlAction", default)]
    hitl_action: String,
    #[serde(rename = "actionId", default)]
    action_id: String,
    #[serde(rename = "accessMode", default)]
    access_mode: String,
    /// Already-persisted attachment paths (`uploads/xxx`), with same-order types.
    #[serde(rename = "attachmentPaths", default)]
    attachment_paths: Vec<String>,
    #[serde(rename = "attachmentPathTypes", default)]
    attachment_path_types: Vec<String>,
    /// Raw uploaded file bytes captured during multipart parse (name, type, bytes).
    #[serde(skip)]
    uploaded_files: Vec<(String, String, Vec<u8>)>,
    /// Declared attachment types for uploaded files (same order).
    #[serde(skip)]
    uploaded_types: Vec<String>,
}

async fn chat_input(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    payload: InputPayload,
) -> Json<serde_json::Value> {
    let fields = payload.into_fields();
    let session_id = if fields.session_id.is_empty() {
        SessionStore::new_session_id()
    } else {
        fields.session_id.clone()
    };

    if !SessionStore::is_valid_id(&session_id) {
        return Json(serde_json::json!({"code": 400, "description": "Invalid session ID"}));
    }

    // Bind the session to its declared project root (X-Session-Cwd) BEFORE
    // any storage access: the Java kernel resolves every session directory
    // through this binding, and the sidebar's global/project split depends
    // on it. Absent header → existing binding or global area.
    let cwd_header = headers
        .get("x-session-cwd")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let store = bind_session_cwd(&state, &session_id, cwd_header.as_deref());

    // Resume paths: questionAnswer / hitlAction are not subject to busy check
    let is_resume = !fields.question_answer.is_empty() || !fields.hitl_action.is_empty();

    if !is_resume && state.is_busy(&session_id).await {
        return Json(serde_json::json!({"code": 200, "data": "busy"}));
    }

    // Handle question answer resume
    if !fields.question_answer.is_empty() {
        return handle_question_answer(&state, &session_id, &fields).await;
    }

    // Handle HITL approval/denial resume
    if !fields.hitl_action.is_empty() {
        return handle_hitl_action(&state, &session_id, &fields).await;
    }

    // ── Slash-command dispatch (Java `WsGate.handleCommand` / `WebGate.isCommand`) ──
    //
    // Must run before the normal-input path: the frontend posts several actions
    // as literal command text through this same endpoint, including the
    // "重新运行" / "继续运行" buttons (`app-message.js:560-561` → `/rerun`,
    // `/continue`). Without interception those strings reached the model as a
    // prompt, so the button deleted the previous answer's DOM rows and then
    // rendered a conversational reply to the text "/rerun".
    //
    // An unrecognised `/name` returns None and falls through to the model,
    // matching Java's registry → skill → plain-input fallback chain.
    if let Some(cmd) = commands::parse(&fields.input) {
        return handle_slash_command(&state, &store, &session_id, &cmd, &fields).await;
    }

    // Normal input: persist user message and spawn run
    let now = chrono::Utc::now().timestamp_millis();

    // ── Attachment processing ──
    let session_dir = store.session_dir_pub(&session_id);
    let mut image_urls: Vec<String> = Vec::new();
    let mut file_refs: Vec<String> = Vec::new();
    // Session-relative paths of the image attachments in this submission
    // (`uploads/<name>`). Kept separately from `image_urls`: the frame needs the
    // *path* (so replay can re-fetch a thumbnail via `/attachment/meta`), while
    // the model needs the *data URL*. Java carries the same split
    // (`savedImagePaths` for the frame vs `imageBlocks` for the prompt).
    let mut image_paths: Vec<String> = Vec::new();
    // `blocks` entries for the persisted user line (Java `ImageBlock` shape).
    // Built from the same data URL that goes to the model, so the stored line
    // and the prompt can never disagree about what was attached.
    let mut image_blocks: Vec<serde_json::Value> = Vec::new();

    // 1) Newly uploaded files: persist to uploads dir, then classify
    for (i, (file_name, _, bytes)) in fields.uploaded_files.iter().enumerate() {
        let declared = fields.uploaded_types.get(i).map(|s| s.as_str()).unwrap_or("file");
        let truncated = crate::attachments::truncate_attachment_name(file_name);
        if let Some(saved) = crate::attachments::save_attachment(&session_dir, &truncated, declared, bytes) {
            let ext = crate::attachments::ext_of_name(&saved.name);
            if crate::attachments::is_image_attachment(&ext, declared) {
                // Java parity (WebGate.java:734): the path is recorded as soon as the
                // bytes are on disk, **before** the read-back. A read-back failure
                // means the model misses this image this turn, but the path is real,
                // so the frame still carries it and the frontend can render the
                // thumbnail on replay (WebGate.java:741-743 says exactly this).
                image_paths.push(saved.path.clone());
                if let Some(url) = crate::attachments::read_image_data_url(&session_dir, &saved.path) {
                    if let Some(block) = crate::attachments::image_block_json(&url) {
                        image_blocks.push(block);
                    }
                    image_urls.push(url);
                }
            } else {
                // Java parity (WebGate.java:747): `fileAttachments.add(relPath)` —
                // the **session-relative** path `uploads/<name>`, not the bare file
                // name. This kernel pushed `saved.name`, so the model was told
                // `[附件: report.pdf]` with no directory component: nothing in the
                // workspace is named that, and the attachment was unreachable even
                // in principle. `saved.path` is already `uploads/<name>`.
                file_refs.push(saved.path.clone());
            }
        }
    }

    // 2) Already-persisted references (attachmentPaths): classify by type declaration
    for (i, rel_path) in fields.attachment_paths.iter().enumerate() {
        let declared = fields.attachment_path_types.get(i).map(|s| s.as_str()).unwrap_or("file");
        let ext = crate::attachments::ext_of_name(rel_path);
        if declared == "image" && crate::attachments::is_image_attachment(&ext, "image") {
            image_paths.push(rel_path.clone());
            if let Some(url) = crate::attachments::read_image_data_url(&session_dir, rel_path) {
                if let Some(block) = crate::attachments::image_block_json(&url) {
                    image_blocks.push(block);
                }
                image_urls.push(url);
            }
        } else {
            // Java parity (WebGate.resolveAttachmentRefs:2086): `fileRefs.add(path)`
            // keeps the whole `uploads/<name>` reference. Stripping it down to the
            // bare name (as this kernel did) loses the directory the bytes actually
            // live in, so the model cannot resolve the attachment.
            file_refs.push(rel_path.clone());
        }
    }

    // 3) Inject file attachments as text prefix (Java contract: `[附件: 路径]`).
    //
    // The two synthesized prompts mirror `WebGate.onChatInput`: a bare file
    // attachment becomes "…\n请帮我处理这些附件", a bare image becomes
    // "请描述这张图片"/"请描述这些图片". Without them an attachment-only
    // submission reached the model as a path list carrying no instruction.
    let effective_input = {
        let with_files = if file_refs.is_empty() {
            fields.input.clone()
        } else {
            let prefix: Vec<String> = file_refs.iter().map(|n| format!("[附件: {}]", n)).collect();
            if fields.input.is_empty() {
                format!("{}\n请帮我处理这些附件", prefix.join("\n"))
            } else {
                format!("{}\n{}", prefix.join("\n"), fields.input)
            }
        };
        if with_files.is_empty() && !image_urls.is_empty() {
            if image_urls.len() > 1 {
                "请描述这些图片".to_string()
            } else {
                "请描述这张图片".to_string()
            }
        } else {
            with_files
        }
    };

    // ── Java-parity launch gate (WebGate.onChatInput:905) ───────────────────
    //
    // Java wraps the *entire* launch — command dispatch, the `canResume`
    // continuation and `performAgentTaskAsync` — in
    // `if (isNotEmpty(currentInput) || !imageBlocks.isEmpty())`, falling through
    // to `return ACCEPTED` when both are empty: nothing is persisted and no run
    // is started.
    //
    // This kernel had no such gate, so a blank submission persisted an empty
    // user turn and spawned a full model run. An empty prompt is not inert: the
    // system prompt carries the project's memory preview, and the model
    // reconstructed a task from it — observed live as a 140-second autonomous
    // loop executing bash inside the user's real repository.
    if effective_input.trim().is_empty() && image_urls.is_empty() {
        return Json(serde_json::json!({"code": 200, "data": "accepted"}));
    }

    // Java's UserMessage is rebuilt from `blocks` by the polymorphic
    // ChatMessage.fromJson; a content-only line would deserialize into
    // an empty message there. Mirror Java's own write shape: one TextBlock
    // followed by an ImageBlock per image (the order the user's own Java-written
    // history uses).
    let mut blocks: Vec<serde_json::Value> = vec![serde_json::json!({
        "@type": "com.gourdai.ai.chat.content.TextBlock",
        "text": effective_input,
    })];
    blocks.extend(image_blocks.iter().cloned());

    let _ = store.append_message(
        &session_id,
        &StoredMessage {
            role: "USER".into(),
            content: effective_input.clone(),
            blocks: Some(blocks),
            text: None,
            created_at: now,
            metadata: if image_paths.is_empty() && file_refs.is_empty() {
                None
            } else {
                Some(serde_json::json!({
                    // Counted from the paths, not the data URLs: Java records the
                    // path as soon as the bytes land (WebGate.java:734), so an
                    // image whose read-back failed still counts as attached.
                    "images": image_paths.len(),
                    "files": file_refs.clone(),
                }))
            },
        },
    );

    // Record user frame in stream.
    //
    // Persist-only, deliberately NOT broadcast: the sending client already
    // rendered its own bubble optimistically (app-streaming.js sendMessage),
    // and the gate handler renders a second bubble for every `user` frame it
    // receives — broadcasting here produced the exact "every message shows
    // twice" defect. The Java kernel has the same split (WebGate.recordUser
    // persists; no user frame is emitted to the client). Loop prompts keep
    // their `user_input` broadcast because no client rendered those.
    let seq_counter = state.seq_for(&session_id).await;
    // Attachment paths ride along on the frame (Java `WebChunk.imagePaths` /
    // `filePaths`, filled only on `user` frames). History replay reads exactly
    // these two keys — `app-history.js:2151` — and turns them back into real
    // thumbnails via `/attachment/meta`. Without them a reopened session showed
    // the text of an attachment message but none of its images or file chips,
    // even though the bytes were still on disk.
    let mut user_frame = Frame::new("user")
        .session(&session_id)
        .text(&effective_input)
        .seq(seq_counter.fetch_add(1, Ordering::SeqCst));
    if !image_paths.is_empty() {
        user_frame = user_frame.extra("imagePaths", serde_json::json!(image_paths));
    }
    if !file_refs.is_empty() {
        user_frame = user_frame.extra("filePaths", serde_json::json!(file_refs));
    }
    persist_frame(&state, &session_id, &user_frame).await;

    spawn_run(state, session_id.clone(), effective_input, fields.model, fields.access_mode, false, image_urls);

    Json(serde_json::json!({"code": 200, "data": {"sessionId": session_id}}))
}

/// Execute a slash command posted to `/web/chat/input`.
///
/// Mirrors Java `WsGate.handleCommand`. Two shapes of command:
///
/// * **Report-only** (`/rewind`, `/clear`, `/compact`) mutate session state and
///   answer with frames. No model run — Java gates its frame block on
///   `!ctx.isAgentTask()`, and these commands never set that.
/// * **Agent** (`/rerun`, `/continue`) start a model run and emit no command
///   frame; the run's own frames are the output.
///
/// ## Frames are broadcast, never persisted
///
/// Java sends these through `socket.send`, not `emitToClient`, so they never
/// reach the stream file. That is load-bearing rather than incidental:
/// `handleRewind` deletes DOM rows, and history replay has no `rewind` handler
/// (`app-history.js` notes the replay path never sees the transient frames).
/// Persisting one would make a reload delete rows a second time — the history
/// already lacks the removed messages, so the card count would drift further with
/// every reload.
///
/// ## The `done` frame is not optional
///
/// `sendCommandSilent` sets `isStreaming = true` and shows the thinking indicator
/// *before* posting. A report-only command that answers without `done` leaves the
/// UI spinning forever with a stop button that has nothing to stop. Java sends it
/// for exactly this reason (`WsGate.java:1075-1079`).
async fn handle_slash_command(
    state: &Arc<AppState>,
    store: &SessionStore,
    session_id: &str,
    cmd: &commands::ParsedCommand,
    fields: &InputFields,
) -> Json<serde_json::Value> {
    let seq_counter = state.seq_for(session_id).await;

    /// Broadcast frames without writing them to the stream file (see above).
    async fn emit(state: &Arc<AppState>, session_id: &str, frames: Vec<Frame>) {
        for frame in frames {
            broadcast_frame(state, session_id, frame).await;
        }
    }

    match cmd.name.as_str() {
        "rewind" => {
            let count = match commands::rewind_count(&cmd.args) {
                Ok(n) => n,
                Err(message) => {
                    // Report rather than silently rewinding one message: the user
                    // asked for something else, and a wrong-count rewind destroys
                    // history they wanted to keep.
                    let mut seq = seq_counter.load(Ordering::SeqCst);
                    let frames = commands::command_frames(session_id, &message, &mut seq);
                    seq_counter.store(seq, Ordering::SeqCst);
                    emit(state, session_id, frames).await;
                    return Json(serde_json::json!({"code": 400, "description": message}));
                }
            };
            let removed = store.rewind(session_id, count);
            let mut seq = seq_counter.load(Ordering::SeqCst);
            let frames = commands::rewind_frames(session_id, removed, &mut seq);
            seq_counter.store(seq, Ordering::SeqCst);
            emit(state, session_id, frames).await;
            info!(session = %session_id, requested = count, removed, "slash command /rewind");
            return Json(serde_json::json!({"code": 200, "data": {"sessionId": session_id, "removed": removed}}));
        }

        "clear" => {
            let removed = store.clear_messages(session_id);
            let mut seq = seq_counter.load(Ordering::SeqCst);
            let frames = commands::command_frames(
                session_id,
                &format!("已清空会话记录（{} 条）", removed),
                &mut seq,
            );
            seq_counter.store(seq, Ordering::SeqCst);
            emit(state, session_id, frames).await;
            info!(session = %session_id, removed, "slash command /clear");
            return Json(serde_json::json!({"code": 200, "data": {"sessionId": session_id, "removed": removed}}));
        }

        "compact" => {
            // One-shot flag consumed by the next run (see `run_react_session`).
            // Persisted on the session context so it survives a kernel restart
            // between the command and that run.
            let focus = commands::compact_focus(&cmd.args);
            let focus_for_ctx = focus.clone();
            store.update_context(session_id, |ctx| {
                ctx.force_compact = Some(true);
                ctx.compact_focus = focus_for_ctx;
            });

            let mut seq = seq_counter.load(Ordering::SeqCst);
            let frames = commands::command_frames(
                session_id,
                &commands::compact_message(focus.as_deref()),
                &mut seq,
            );
            seq_counter.store(seq, Ordering::SeqCst);
            emit(state, session_id, frames).await;
            info!(session = %session_id, focus = focus.as_deref().unwrap_or("-"), "slash command /compact");
            return Json(serde_json::json!({"code": 200, "data": {"sessionId": session_id}}));
        }

        "rerun" => {
            // Java `RerunCommand`: drop trailing messages back through the last
            // USER message, then re-run with that message's text. Removing the
            // user turn too is what makes the re-run a genuine repeat rather than
            // a follow-up — otherwise the history would carry the prompt twice.
            let mut msgs = store.load_messages(session_id);
            let mut last_user: Option<String> = None;
            while let Some(m) = msgs.pop() {
                if m.role == "USER" {
                    last_user = Some(m.content.clone());
                    break;
                }
            }
            let Some(prompt) = last_user else {
                let mut seq = seq_counter.load(Ordering::SeqCst);
                let frames = commands::command_frames(session_id, "没有可重新运行的任务", &mut seq);
                seq_counter.store(seq, Ordering::SeqCst);
                emit(state, session_id, frames).await;
                return Json(serde_json::json!({"code": 200, "data": {"sessionId": session_id}}));
            };
            // Write back the truncated history. `rewind` counts from the end, so
            // the number to drop is however many messages were popped.
            let before = store.load_messages(session_id).len();
            let dropped = before.saturating_sub(msgs.len());
            if dropped > 0 {
                store.rewind(session_id, dropped);
            }
            info!(session = %session_id, dropped, "slash command /rerun");
            spawn_run(
                state.clone(),
                session_id.to_string(),
                prompt,
                fields.model.clone(),
                fields.access_mode.clone(),
                false,
                Vec::new(),
            );
            return Json(serde_json::json!({"code": 200, "data": {"sessionId": session_id}}));
        }

        "continue" => {
            // Java `ContinueCommand`: run against the existing history with no new
            // user message. An empty prompt is deliberate — `run_react_session`
            // only upgrades the history tail when the input is non-empty, so the
            // stored conversation is replayed as-is and the model continues it.
            info!(session = %session_id, "slash command /continue");
            spawn_run(
                state.clone(),
                session_id.to_string(),
                String::new(),
                fields.model.clone(),
                fields.access_mode.clone(),
                false,
                Vec::new(),
            );
            return Json(serde_json::json!({"code": 200, "data": {"sessionId": session_id}}));
        }

        // `parse` only returns supported names, so this is unreachable; a 400 is
        // better than a silent no-op if the two lists ever drift.
        other => Json(serde_json::json!({"code": 400, "description": format!("unsupported command: {}", other)})),
    }
}

/// Input payload: accepts both urlencoded Form and Multipart.
enum InputPayload {
    Form(InputFields),
    Multipart(InputFields),
}

impl InputPayload {
    fn into_fields(self) -> InputFields {
        match self {
            InputPayload::Form(f) => f,
            InputPayload::Multipart(f) => f,
        }
    }
}

#[axum::async_trait]
impl<S> axum::extract::FromRequest<S> for InputPayload
where
    S: Send + Sync,
{
    type Rejection = FlexBodyRejection;

    async fn from_request(req: axum::http::Request<axum::body::Body>, state: &S) -> Result<Self, Self::Rejection> {
        let content_type = req
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();

        if content_type.contains("multipart/form-data") {
            // Parse multipart
            let mut fields = InputFields::default();
            // Collect uploaded files (name, declared_type, bytes) to persist after sessionId is known
            let mut uploaded: Vec<(String, String, Vec<u8>)> = Vec::new();
            let mut decl_types: Vec<String> = Vec::new();
            if let Ok(mut multipart) = Multipart::from_request(req, state).await {
                while let Ok(Some(field)) = multipart.next_field().await {
                    let name = field.name().unwrap_or_default().to_string();
                    if field.file_name().is_some() {
                        // Capture attachment file bytes
                        let file_name = field.file_name().unwrap_or("attachment").to_string();
                        let bytes = field.bytes().await.unwrap_or_default().to_vec();
                        uploaded.push((file_name, String::new(), bytes));
                        continue;
                    }
                    let value = field.text().await.unwrap_or_default();
                    match name.as_str() {
                        "input" => fields.input = value,
                        "sessionId" => fields.session_id = value,
                        "model" => fields.model = value,
                        "questionAnswer" => fields.question_answer = value,
                        "hitlAction" => fields.hitl_action = value,
                        "actionId" => fields.action_id = value,
                        "accessMode" => fields.access_mode = value,
                        "attachmentTypes" => decl_types.push(value),
                        "attachmentPaths" => fields.attachment_paths.push(value),
                        "attachmentPathTypes" => fields.attachment_path_types.push(value),
                        _ => {}
                    }
                }
            }
            // Attach uploaded file bytes to fields for later persistence
            fields.uploaded_files = uploaded;
            fields.uploaded_types = decl_types;
            Ok(InputPayload::Multipart(fields))
        } else {
            // ── Everything except multipart: read the body, then sniff ──────
            //
            // This branch used to be
            //   `if let Ok(Form(f)) = Form::<InputFields>::from_request(..) { fields = f; }`
            // with an `InputFields::default()` fallback. axum's `Form` rejects a
            // JSON body with **415**, so the `Ok` arm never matched and the
            // handler proceeded with *every* field empty — `sessionId` ignored
            // (a brand-new session was minted), `input` blank, `accessMode`
            // fallen back, attachments dropped — while still answering 200.
            // Nothing anywhere surfaced the failure.
            //
            // That is how an empty prompt reached `spawn_run` (see the launch
            // gate in `chat_input`). Decoding is now deliberate and a decode
            // failure is a **rejection**, never a silent empty run. Sniff order
            // matches `FlexBody`: JSON wins when declared, or when the payload
            // merely looks like JSON, because a hand-written `fetch` frequently
            // omits Content-Type.
            let bytes = axum::body::Bytes::from_request(req, state)
                .await
                .map_err(|e| FlexBodyRejection(format!("cannot read body: {}", e)))?;
            let text = String::from_utf8_lossy(&bytes);
            let head = text.trim();

            // An empty body is legitimate: resume paths send only their own keys
            // and the all-default DTO is what the Java handler would have seen.
            if head.is_empty() {
                return Ok(InputPayload::Form(InputFields::default()));
            }

            if content_type.contains("application/json")
                || head.starts_with('{')
                || head.starts_with('[')
            {
                return serde_json::from_slice::<InputFields>(&bytes)
                    .map(InputPayload::Form)
                    .map_err(|e| FlexBodyRejection(format!("invalid JSON body: {}", e)));
            }

            serde_urlencoded::from_str::<InputFields>(&text)
                .map(InputPayload::Form)
                .map_err(|e| FlexBodyRejection(format!("invalid form body: {}", e)))
        }
    }
}

/// Handle question answer submission (resume from ask_user suspension).
async fn handle_question_answer(
    state: &Arc<AppState>,
    session_id: &str,
    fields: &InputFields,
) -> Json<serde_json::Value> {
    // Atomically read → validate kind → consume (see `consume_suspension`). A
    // question answer submitted against a HITL suspension must 409 WITHOUT
    // consuming it, so the correct approval afterwards still finds it; and two
    // concurrent answers must not both resume the run.
    let sp = match consume_suspension(state, session_id, |sp| {
        if sp.kind == "question" { Ok(()) } else { Err("Pending task is not a question") }
    })
    .await
    {
        Ok(Some(sp)) => sp,
        Ok(None) => {
            return Json(serde_json::json!({"code": 409, "description": "No pending question"}))
        }
        Err(desc) => return Json(serde_json::json!({"code": 409, "description": desc})),
    };

    // Parse answers
    let answers: serde_json::Value = serde_json::from_str::<serde_json::Value>(&fields.question_answer)
        .map(|v| v["answers"].clone())
        .unwrap_or(serde_json::json!([]));

    // Emit question_answered frame
    let seq_counter = state.seq_for(session_id).await;
    let frame = Frame::question_answered(session_id, &fields.action_id, answers.clone())
        .seq(seq_counter.fetch_add(1, Ordering::SeqCst));
    persist_frame(state, session_id, &frame).await;
    broadcast_frame(state, session_id, frame).await;

    // Build the answer text to inject as tool result
    let answer_text = format_answers_for_llm(&answers);

    // Resume the run: restore messages, add tool result, continue
    let messages: Vec<ChatMessage> = serde_json::from_str(&sp.messages_json).unwrap_or_default();
    spawn_resume(
        state.clone(),
        session_id.to_string(),
        sp,
        messages,
        answer_text,
    );

    Json(serde_json::json!({"code": 200}))
}

/// Handle HITL approval/denial.
async fn handle_hitl_action(
    state: &Arc<AppState>,
    session_id: &str,
    fields: &InputFields,
) -> Json<serde_json::Value> {
    let approved = fields.hitl_action == "approve" || fields.hitl_action == "allow";
    // Atomically read → validate (kind + actionId) → consume, all under one lock
    // hold (see `consume_suspension`). Two concurrent approvals must not both
    // pass and both resume — that would run an approved irreversible command
    // twice. A mismatch or wrong kind rejects WITHOUT consuming, so the pending
    // approval survives on memory and disk for the correct submission.
    //
    // Strict actionId check (Java `WebGate.java:804-814`): a tool approval is
    // irreversible (`rm -rf` and friends), so when the client sends an actionId it
    // MUST match the pending one, otherwise a stale or replayed card could approve
    // a different command than the one the user saw. A client that sends no
    // actionId falls back to legacy behaviour (approve whatever is pending),
    // matching Java's warn-and-continue path.
    let action_id = fields.action_id.clone();
    let sp = match consume_suspension(state, session_id, move |sp| {
        if sp.kind != "hitl" {
            return Err("Pending task is not an approval");
        }
        if !action_id.is_empty() && action_id != sp.action_id.as_deref().unwrap_or("") {
            return Err("ACTION_MISMATCH");
        }
        Ok(())
    })
    .await
    {
        Ok(Some(sp)) => sp,
        Ok(None) => {
            return Json(serde_json::json!({"code": 409, "description": "No pending approval"}))
        }
        Err(desc) => return Json(serde_json::json!({"code": 409, "description": desc})),
    };

    if approved {
        // Execute the approved command NOW (it was not run before suspension)
        // and feed the real output back as the tool result.
        let command = sp.pending_command.clone().unwrap_or_default();
        let output = if command.is_empty() {
            "The approved command could not be determined.".to_string()
        } else {
            execute_approved_command(&state.workspace, &command).await
        };
        let messages: Vec<ChatMessage> = serde_json::from_str(&sp.messages_json).unwrap_or_default();
        spawn_resume(
            state.clone(),
            session_id.to_string(),
            sp,
            messages,
            output,
        );
    } else {
        // Denied: inject denial as tool result
        let messages: Vec<ChatMessage> = serde_json::from_str(&sp.messages_json).unwrap_or_default();
        spawn_resume(
            state.clone(),
            session_id.to_string(),
            sp,
            messages,
            "The user denied approval for this command. Do not retry it.".to_string(),
        );
    }

    Json(serde_json::json!({"code": 200}))
}

fn format_answers_for_llm(answers: &serde_json::Value) -> String {
    let mut parts = Vec::new();
    if let Some(arr) = answers.as_array() {
        for (i, a) in arr.iter().enumerate() {
            let text = a["text"].as_str().unwrap_or("");
            let skipped = a["skipped"].as_bool().unwrap_or(false);
            if skipped {
                parts.push(format!("Q{}: (skipped)", i + 1));
            } else {
                parts.push(format!("Q{}: {}", i + 1, text));
            }
        }
    }
    if parts.is_empty() {
        "(user provided no answer)".to_string()
    } else {
        parts.join("\n")
    }
}

/// Execute an approved command synchronously and return its combined output.
/// Used when the user approves a HITL-gated bash command: the command was NOT
/// executed before suspension, so we must run it now and feed the real output back.
async fn execute_approved_command(workspace: &std::path::Path, command: &str) -> String {
    // Same transport as `BashTool::execute`: `prepare_powershell` builds
    // `-EncodedCommand` (Base64 of UTF-16LE), falling back to a UTF-8+BOM
    // `.ps1` when the command is too long for the command line. Sending the
    // raw string via `-Command` here was the same defect class the bash tool
    // already fixed: the outer shell pre-evaluated dollar variables and
    // backticks, dropped
    // non-ASCII characters, failed on over-long commands, and let
    // `Get-Content` mis-decode UTF-8 sources.
    let mut temp_script: Option<std::path::PathBuf> = None;
    let mut cmd = if cfg!(windows) {
        let prepared = match crate::tools::builtin::prepare_powershell(command) {
            Ok(p) => p,
            Err(e) => return format!("Failed to prepare PowerShell command: {}", e),
        };
        temp_script = prepared.temp_script;
        // `command` is already encoded into argv -- do not append it again.
        let mut c = tokio::process::Command::new(&prepared.argv[0]);
        c.args(&prepared.argv[1..]);
        // GUI host: without this every approved command flashes a black
        // console window (same defect class as gitops / terminal spawns).
        //
        // Attribute block, not a bare statement: `creation_flags` lives behind
        // tokio's `cfg_windows!`, so the method does not exist on a non-Windows
        // target, while `if cfg!(windows)` (a runtime `if`) still type-checks
        // both arms -> E0599 on the ubuntu-latest CI gate. The attribute is
        // stripped before type checking -- the form gitops.rs already uses.
        #[cfg(windows)]
        {
            c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        c
    } else {
        let mut c = tokio::process::Command::new("sh");
        c.arg("-c");
        c.arg(command);
        c
    };
    cmd.current_dir(workspace);
    // `output()` below waits for the child to exit, so the script file is no
    // longer needed once it returns; the guard removes it on function exit,
    // covering every early return (spawn error / timeout) without repetition.
    let _guard = crate::tools::builtin::TempScriptGuard::new(temp_script);
    match tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output()).await {
        Ok(Ok(output)) => {
            let stdout = crate::textcodec::decode_bytes(&output.stdout);
            let stderr = crate::textcodec::decode_bytes(&output.stderr);
            // 同 format_output：ANSI 颜色码必须在 UI 之前剔干净，否则用户看到的是
            // 残存的「[31m」「[0m」而不是颜色（HTML 不解释 ESC）。
            let stdout = crate::textcodec::strip_ansi(&stdout);
            let stderr = crate::textcodec::strip_ansi(&stderr);
            let code = output.status.code().unwrap_or(-1);
            let mut text = String::new();
            if !stdout.is_empty() { text.push_str(&stdout); }
            if !stderr.is_empty() {
                if !text.is_empty() { text.push('\n'); }
                text.push_str("[stderr]\n");
                text.push_str(&stderr);
            }
            text.push_str(&format!("\n[exit code: {}]", code));
            text
        }
        Ok(Err(e)) => format!("Command spawn failed: {}", e),
        Err(_) => "Command timed out after 300s".to_string(),
    }
}

/// Spawn a new ReAct run.
fn spawn_run(
    state: Arc<AppState>,
    session_id: String,
    input: String,
    model_name: String,
    access_mode: String,
    hitl_approved: bool,
    image_urls: Vec<String>,
) {
    let cancel = CancellationToken::new();
    let cancel_clone = cancel.clone();
    // Generated here rather than inside `run_react_session` so the handle
    // registered below already carries it: an interrupt arriving before the run
    // reaches that point would otherwise have no id to compare against.
    let run_id = new_run_id();
    let run_id_reg = run_id.clone();

    tokio::spawn(async move {
        // Register running task
        state
            .running
            .lock()
            .await
            .insert(session_id.clone(), RunningTask { cancel: cancel_clone, run_id: run_id_reg });

        run_react_session(state, session_id, input, model_name, access_mode, hitl_approved, cancel, None, Vec::new(), image_urls, run_id).await;
    });
}

/// Mint a run id (one input → one run).
fn new_run_id() -> String {
    format!("run-{}", &uuid::Uuid::new_v4().to_string()[..8])
}

/// Inject the answer/approval as the tool result for the suspended call.
///
/// Defensive dedup for suspension snapshots written by an older kernel: the
/// `ReActAgent::run` exit gate used to repair *every* return path, including
/// ask_user/HITL suspensions, so `messages_json` can already contain a bogus
/// INTERRUPTED_MARKER tool result for this very call id. Appending the real
/// answer after it leaves two `tool` messages for one call; the model reads
/// "the call was cancelled, do not repeat it" first and discards the answer.
/// Replace any pre-existing result instead of stacking a second one.
///
/// Pure function so both the happy path and the legacy-poisoned path are
/// locked by unit tests without standing up a server.
fn inject_resume_result(
    messages: &mut Vec<ChatMessage>,
    tool_call_id: Option<&str>,
    injected_text: &str,
) {
    match tool_call_id {
        Some(id) if !id.is_empty() => {
            let replacement = ChatMessage::tool_result(id, injected_text);
            if let Some(existing) = messages
                .iter_mut()
                .find(|m| m.tool_call_id.as_deref() == Some(id))
            {
                *existing = replacement;
            } else {
                messages.push(replacement);
            }
        }
        // Fallback: no tool_call_id recorded (legacy snapshot), use a user message.
        _ => messages.push(ChatMessage::user(injected_text)),
    }
}

/// Spawn a resumed run from a suspension point.
fn spawn_resume(
    state: Arc<AppState>,
    session_id: String,
    sp: SuspensionPoint,
    mut messages: Vec<ChatMessage>,
    injected_text: String,
) {
    let cancel = CancellationToken::new();
    let cancel_clone = cancel.clone();
    let model_name = sp.model_name.clone();
    let access_mode = sp.access_mode.clone();
    let run_id = new_run_id();
    let run_id_reg = run_id.clone();
    // Per-invocation adjudication, NOT run-level immunity.
    //
    // This used to be `sp.kind == "hitl"`, which granted the *entire* resumed run
    // blanket approval: after the user approved one `rm -rf`, every subsequent
    // bash call in that run — including a different, more dangerous one — sailed
    // through the gate. That is the exact defect the Java kernel avoids by clearing
    // the decision in `onObservation` (`HITLInterceptor.java:192-195`), so each
    // command is adjudicated on its own.
    //
    // Setting it false here is safe and does not cause a re-prompt loop, because
    // this kernel does not re-dispatch the approved tool call: `handle_hitl_action`
    // already ran the command via `execute_approved_command` and injected its
    // output as the `tool_result` for `pending_tool_call_id` (below). The model
    // sees a complete tool_call→tool_result pair and moves on. Only genuinely NEW
    // commands get gated again — which is the intended per-invocation semantics.
    let hitl_approved = false;

    // On resume, the message history ends with an assistant message carrying
    // tool_calls; inject the answer/approval as its tool result (see
    // `inject_resume_result` above for the legacy-snapshot dedup).
    if !injected_text.is_empty() {
        inject_resume_result(
            &mut messages,
            sp.pending_tool_call_id.as_deref(),
            &injected_text,
        );
    }

    tokio::spawn(async move {
        state
            .running
            .lock()
            .await
            .insert(session_id.clone(), RunningTask { cancel: cancel_clone, run_id: run_id_reg });

        run_react_session(
            state,
            session_id,
            String::new(), // no new user input
            model_name,
            access_mode,
            hitl_approved,
            cancel,
            Some(sp),
            messages,
            Vec::new(), // no image attachments on resume
            run_id,
        )
        .await;
    });
}

/// Execute a full ReAct session run.
#[allow(clippy::too_many_arguments)]
async fn run_react_session(
    state: Arc<AppState>,
    session_id: String,
    input: String,
    model_name: String,
    access_mode: String,
    hitl_approved: bool,
    cancel: CancellationToken,
    _resume_point: Option<SuspensionPoint>,
    resume_messages: Vec<ChatMessage>,
    image_urls: Vec<String>,
    run_id: String,
) {
    let settings = state.settings.read().await.clone();
    // Ownership-routed store: bound sessions live under their project root.
    let store = store_for(&state, &session_id);

    // The run's workspace, resolved ONCE and used by both the system prompt and
    // `ReActConfig`. Two copies of this derivation is how the two drifted: the
    // prompt block used `project_root_of(&session_dir)` while the config used
    // `state.workspace`, so a bound session could be told about one project and
    // have its tools run in another.
    //
    // Why this is not simply `project_root_of(&session_dir)`: for an *unbound*
    // (global) session the store base is `<harness_base>/.gwork/sessions`, so
    // walking up three levels yields `<harness_base>` — the user's home
    // directory, not `state.workspace` (`~/GWork`). That is the right answer for
    // the *global-area* lookups below (skills/memory legitimately live under
    // `<harness_base>/.gwork`), and the wrong answer for the run's workspace:
    // using it would move every global session's tool cwd and workspace boundary
    // into `$HOME`, a wider write surface than intended.
    //
    // `bound_root` is the authoritative signal that the session actually owns a
    // project directory, so the derivation is gated on it. This matters most for
    // remote workspaces: the kernel there is launched by an SSH exec (cwd =
    // `$HOME`), so without this a session bound to `/srv/host/project` would run
    // its tools in `$HOME` and read/write/grep the wrong tree entirely.
    let run_workspace = resolve_run_workspace(
        state.session_roots.bound_root(&session_id).as_deref(),
        &state.workspace,
    );

    // Resolve model: explicit > session override > default
    let model = {
        let sm = state.session_models.lock().await;
        sm.get(&session_id).cloned()
    }
    .or_else(|| {
        if !model_name.is_empty() {
            Some(model_name.clone())
        } else {
            None
        }
    })
    .and_then(|name| settings.get_model(&name).cloned())
    .or_else(|| settings.default_model_config().cloned());

    let Some(model) = model else {
        let frame = Frame::error(&session_id, "No model configured. Add a model in Settings.");
        broadcast_frame(&state, &session_id, frame).await;
        // This early return bypasses `ReActAgent::run`, so its single terminal
        // gate cannot cover it. The frontend leaves its streaming state ONLY on
        // `done` — without this the composer stays locked in "thinking" after
        // the error, exactly the "task ended unfinished" symptom.
        let done = Frame::done(&session_id).run(&run_id);
        broadcast_frame(&state, &session_id, done).await;
        state.running.lock().await.remove(&session_id);
        return;
    };

    // Session-selected context window: denominator of the meter ring and of the
    // skill-listing budget alike (Java `ContextLengthPolicy.resolveRuntime`).
    // Read **before** the access-mode resolution below: the persisted context is
    // now one of its inputs.
    let mut session_ctx = store.read_context(&session_id);
    let context_length = session_ctx
        .context_length
        .unwrap_or(settings.general.context_length);

    // Resolve access mode: explicit > live session override > persisted context >
    // "default". The persisted tier is what `/web/chat/models` echoes to the
    // picker, so omitting it here made the two disagree for any client that does
    // not re-send the field on every request (a stale bundled UI, a hand-written
    // fetch, a restart before the map is repopulated): the picker showed "full"
    // while the run gated as "default" — the exact "I chose full access, why is
    // it still asking" symptom.
    let live_access = {
        let am = state.session_access.lock().await;
        am.get(&session_id).cloned()
    };
    let effective_access = resolve_access_mode(
        &access_mode,
        live_access.as_deref(),
        session_ctx.access_mode.as_deref(),
    );

    // Build conversation history
    // `run_id` is minted by the caller (`spawn_run` / `spawn_resume`) so the
    // registered `RunningTask` and this run share one id — see `new_run_id`.
    let seq_counter = state.seq_for(&session_id).await;
    let start_seq = seq_counter.load(Ordering::SeqCst);

    // Consume the one-shot `/compact` request.
    //
    // Captured before clearing, then cleared here rather than after the
    // compression pass, because this run may never reach one (a cancelled or
    // immediately-suspended turn) and leaving the flag set would make some later,
    // unrelated turn compress unexpectedly. Java's contract is "将在下一轮推理开始
    // 时生效" — the next run owns it, and only it.
    //
    // Only rewritten when it was actually set, so an ordinary run does not pay a
    // disk write.
    let force_compact = session_ctx.force_compact.unwrap_or(false);
    // The focus travels with the flag. Both are consumed together, so a focus can
    // never outlive the compression it was meant to steer (and an unrelated later
    // turn can never inherit it).
    let compact_focus = if force_compact { session_ctx.compact_focus.clone() } else { None };
    if force_compact {
        session_ctx.force_compact = None;
        session_ctx.compact_focus = None;
        // Consume only the one-shot flags, not the whole document: the user may
        // have changed the model/thinking/context pickers while this run was
        // starting, and writing the stale `session_ctx` snapshot back would
        // resurrect their old choices.
        store.update_context(&session_id, |ctx| {
            ctx.force_compact = None;
            ctx.compact_focus = None;
        });
    }

    let mut history: Vec<ChatMessage> = if !resume_messages.is_empty() {
        resume_messages
    } else {
        let window = settings.general.history_window_size as usize;
        let mut history = store.to_chat_messages(&session_id, window);
        // Prepend system prompt.
        //
        // Both blocks are resolved against the session's **project** root, not
        // `state.workspace`: for a session bound to another project the kernel's
        // workspace points somewhere else entirely, so the agent would be told
        // about the wrong project's skills and memories (and none of the ones it
        // can actually use).
        let session_dir = store.session_dir_pub(&session_id);
        // `project_root` drives the *global-area* lookups (skills, memory, agent
        // definitions): for an unbound session it resolves to `<harness_base>`,
        // which is exactly where those live. The run's workspace is a different
        // question and is answered by `run_workspace` above — do not conflate them.
        let project_root = project_root_of(&session_dir);
        // The listing budget is a fraction of the session's context window, so it
        // must be resolved from the same place the model picker and the compression
        // budget read it: the persisted per-session context, falling back to the
        // global default. Reading `settings.general.context_length` here instead
        // would silently ignore a per-session override.
        let budget_fraction = settings.general.skill_listing_budget_fraction;
        let max_desc = settings.general.skill_listing_max_desc_chars as usize;
        let skills_summary = match &project_root {
            Some(root) => crate::skills::SkillRegistry::with_workspace(root)
                .prompt_summary_with_budget(Some(context_length), budget_fraction, max_desc),
            None => crate::skills::SkillRegistry::new()
                .prompt_summary_with_budget(Some(context_length), budget_fraction, max_desc),
        };
        let memory_preview = build_memory_preview(project_root.as_deref());
        // Custom agent definitions are scanned from the session's **project** root,
        // same as skills: a session bound to another project must see that
        // project's `.gwork/agents`, not the kernel's install directory.
        let agents_root = project_root
            .clone()
            .unwrap_or_else(|| state.workspace.clone());
        let agent_roster =
            crate::react::prompt::build_agent_roster(&agents_root, &settings.permission);
        let system = build_system_prompt(&settings, &run_workspace.to_string_lossy())
            + &skills_summary
            + &memory_preview
            + &agent_roster;
        history.insert(0, ChatMessage::system(system));
        // Ensure the latest user message is included (with images if any).
        //
        // `chat_input` persists the user turn to `<sid>.messages.ndjson` **before**
        // spawning this run, so `to_chat_messages` has already read that very line
        // back and `history.last()` *is* the current input. The previous guard
        // (`last != input → push`) could therefore never fire on the normal path,
        // and `image_urls` was dropped on **every** attachment submission: the
        // model got a text-only message while the persisted metadata still claimed
        // `{"images":1}`. Verified against a mock provider — a png upload reached
        // the wire as `content: "请描述这张图片"` with no `image_url` part at all.
        //
        // So when the tail already matches, **upgrade it in place** to the
        // multimodal form. Appending instead would send the user's text twice.
        let tail_is_current_input = !input.is_empty()
            && history.last().map(|m| m.content_text()) == Some(input.clone());
        if tail_is_current_input {
            if !image_urls.is_empty() {
                let last = history.len() - 1;
                history[last] = ChatMessage::user_with_images(&input, image_urls.clone());
            }
        } else if !input.is_empty() || !image_urls.is_empty() {
            history.push(ChatMessage::user_with_images(&input, image_urls.clone()));
        }
        history
    };

    // ── TODO resume calibration (Java `HarnessEngine.injectTodoCalibration`) ──
    //
    // A run that stopped abnormally leaves TODO.md on disk, and its state lags
    // reality: the interrupt may have landed before the `todowrite` that would
    // have marked the item in progress. Resuming without saying so makes the
    // model re-execute finished work — the "it started the whole task over after
    // I pressed continue" symptom. The snapshot plus the instruction to cross-check
    // prior observations first is what prevents that.
    //
    // Injected into `history` only, never persisted: it is a one-turn steering
    // message, and storing it would let it reappear on every later replay.
    if session_ctx.interrupted.unwrap_or(false) {
        session_ctx.interrupted = None;
        // Clear only the one-shot flag under the lock; a whole-document write of
        // the run-start snapshot would clobber picker changes made meanwhile.
        store.update_context(&session_id, |ctx| ctx.interrupted = None);
        let todo_file = store
            .session_dir_pub(&session_id)
            .join(crate::session::TODO_FILE_NAME);
        if let Ok(raw) = std::fs::read_to_string(&todo_file) {
            // A stored JSON envelope would calibrate to nothing (zero task
            // lines), leaving the resuming run blind to the real stored state.
            // Heal in memory for the snapshot and persist the repair so every
            // later reader agrees.
            let raw = match crate::todo::heal_content(&raw) {
                Some(healed) => {
                    let body = if healed.ends_with('\n') {
                        healed.clone()
                    } else {
                        format!("{}\n", healed)
                    };
                    let _ = std::fs::write(&todo_file, &body);
                    healed
                }
                None => raw,
            };
            if let Some(calibration) = crate::todo::build_resume_calibration(&raw) {
                history.push(ChatMessage::user(calibration));
                info!(session = %session_id, "TODO resume calibration injected");
            }
        }
    }

    // Create frame channel
    let (frame_tx, mut frame_rx) = mpsc::unbounded_channel::<Frame>();

    // Forward frames to WS clients + persist to stream file
    let state_fwd = state.clone();
    let sid_fwd = session_id.clone();
    let fwd_handle = tokio::spawn(async move {
        while let Some(frame) = frame_rx.recv().await {
            persist_frame(&state_fwd, &sid_fwd, &frame).await;
            broadcast_frame(&state_fwd, &sid_fwd, frame).await;
        }
    });

    // Run ReAct
    let session_dir = store.session_dir_pub(&session_id);
    // Meter ledger seed (Java `WebGate.emitToClient` → `sumUsage`): scanned once
    // at spawn so every context_size frame can carry the session-cumulative
    // `args.total*` rows. The user frame of this very turn is already persisted
    // (chat_input appends before spawning), so it is counted.
    let usage_seed = crate::session_usage::sum_usage(
        &session_dir.join(format!("{}.stream.ndjson", crate::session::sanitize_id(&session_id))),
    );
    let config = ReActConfig {
        session_id: session_id.clone(),
        workspace: run_workspace.clone(),
        // Session-scoped storage so per-session artefacts (TODO.md) land where
        // `/web/chat/todos` reads them. The store is already ownership-routed,
        // so this resolves to the project root for bound sessions.
        session_dir: Some(session_dir),
        model: model.clone(),
        settings: settings.clone(),
        access_mode: effective_access.clone(),
        max_turns: settings.general.max_turns,
        run_id: run_id.clone(),
        start_seq,
        hitl_approved,
        gate: None,
        change_ledger: Some(state.change_ledger.clone()),
        // The interactive chat run is a top-level run.
        subagent_depth: 0,
        root_session_id: session_id.clone(),
        // The reasoning level the user picked. `chat_thinking_select` has always
        // persisted this into the session context, and `reasoning::selectable_codes`
        // has always told the picker which levels the model offers — but nothing
        // read the stored value when building the request, so the selector changed
        // only the UI. It now reaches the wire through the dialect layer.
        thinking: session_ctx.thinking.clone(),
        context_length,
        turn_start_ms: chrono::Utc::now().timestamp_millis(),
        usage_seed,
        // `/compact` sets this on the session context; it is consumed (cleared)
        // above so one command forces exactly one pass rather than making every
        // subsequent turn re-compress.
        force_compact,
        compact_focus,
    };
    let agent = ReActAgent::new(state.registry.clone());
    // Clone the frame sender BEFORE it is moved into `run`, so a post-run frame
    // can still be queued in order with everything the run produced.
    //
    // Why not just `await` the forwarder after the run: a **background** sub-agent
    // (`task`/`multitask` with `background=true`) is spawned with its own clone of
    // this sender and deliberately outlives the tool call and the parent run
    // (`tools/agent.rs`). While one is pending the channel never closes, so
    // awaiting the forwarder would block until the sub-agent finished — minutes,
    // potentially — and because the `running` cleanup below sits after it, the
    // session would stay flagged as running and the user could not start a new
    // turn. Sending through a clone keeps FIFO ordering with the run's own frames
    // at zero blocking cost.
    let post_run_tx = frame_tx.clone();
    let result = agent.run(&config, history, frame_tx, cancel).await;

    // Update seq counter
    seq_counter.store(result.next_seq, Ordering::SeqCst);

    // Handle suspension: persist the suspension point
    match result.stop_reason {
        StopReason::SuspendedQuestion | StopReason::SuspendedHitl => {
            let kind = if result.stop_reason == StopReason::SuspendedQuestion {
                "question"
            } else {
                "hitl"
            };
            let sp = SuspensionPoint {
                session_id: session_id.clone(),
                run_id: run_id.clone(),
                kind: kind.to_string(),
                next_seq: result.next_seq,
                access_mode: effective_access,
                model_name: model.name.clone(),
                pending_command: result.pending_command.clone(),
                action_id: result.pending_tool_call_id.clone(),
                pending_tool_call_id: result.pending_tool_call_id.clone(),
                messages_json: serde_json::to_string(&result.messages).unwrap_or_default(),
                created_at: chrono::Utc::now().timestamp_millis(),
            };
            // Write-through: keep the in-memory hot cache AND persist to disk so
            // the suspension survives a kernel restart (see the persistence block
            // above `chat_sessions_delete`).
            persist_suspension(&state, &session_id, &sp);
            state.suspensions.lock().await.insert(session_id.clone(), sp);
        }
        _ => {}
    }

    // Persist assistant response
    if !result.final_answer.is_empty() {
        let _ = store.append_message(
            &session_id,
            &StoredMessage {
                role: "ASSISTANT".into(),
                // Dual-write: Java readers split — getText() prefers `text`,
                // the messages endpoint reads `content`. Writing only one of
                // them silently blanks the other kernel's history view.
                content: result.final_answer.clone(),
                text: Some(result.final_answer.clone()),
                blocks: None,
                created_at: chrono::Utc::now().timestamp_millis(),
                metadata: Some(serde_json::json!({
                    "inputTokens": result.usage.prompt_tokens,
                    "outputTokens": result.usage.completion_tokens,
                    "model": model.name,
                })),
            },
        );
    }

    // ── File-change ledger wrap-up + `file_changes` frame ────────────────────
    //
    // `clean` mirrors Java's `!streamFailed`: a normal completion or a
    // suspension (ask_user / HITL — flow control, not failure) wraps up READY,
    // while cancel / max-turns / error wrap up INCOMPLETE + possiblyIncomplete,
    // because the last few writes may never have been recorded. Undo still works
    // in the abnormal case; the flag only lets the UI warn the list may be short.
    //
    // Java finishes on every termination path for the same reason its comment
    // gives: `ready` is the first gate on undo, and the moment a user most needs
    // to roll back is after an abnormal stop — "agent 跑挂了、工作区被改乱".
    let clean = matches!(
        result.stop_reason,
        StopReason::Completed | StopReason::SuspendedQuestion | StopReason::SuspendedHitl
    );
    // Remember an abnormal exit so the next turn can calibrate against TODO.md.
    //
    // Only the abnormal paths touch the flag: a normal completion, an ask_user
    // wait and a HITL wait are flow control, not failure, and injecting a
    // "previous run was interrupted" snapshot into one of those would be a lie
    // the model would then act on. Java draws the same line, which is why its
    // calibration call sits behind `if (removeLastAnswer)`.
    //
    // Set only the one-shot flag through `update_context`. `session_ctx` is the
    // run-start snapshot and was moved into the config above; writing it back
    // whole would also resurrect the picker values from before this run.
    if !clean {
        store.update_context(&session_id, |ctx| ctx.interrupted = Some(true));
    }

    if let Some(summary) = state.change_ledger.finish(&session_id, &run_id, clean) {
        // `finish` returns None when the run touched no tracked file or was
        // already finished, so this only fires when there is a real snapshot.
        // Queued through the run's own channel: ordering with `done` is preserved
        // and the forwarder does the persist + broadcast, exactly as for every
        // other frame.
        let frame = Frame::file_changes(&session_id, &run_id, summary)
            .seq(seq_counter.fetch_add(1, Ordering::SeqCst));
        let _ = post_run_tx.send(frame);
    }
    // Dropping the handle does not abort the forwarder task; it keeps draining so
    // background sub-agent frames still reach the UI after this run ends.
    drop(post_run_tx);

    // Cleanup
    drop(fwd_handle);
    state.running.lock().await.remove(&session_id);
    info!(session = %session_id, turns = result.turns_used, stop = ?result.stop_reason, "run completed");
}

/// Derive a project root from a session directory.
///
/// `<root>/.gwork/sessions/<sid>` → `<root>`. Shared by the skills and memory
/// prompt blocks so both resolve against the same project; `None` when the path
/// does not have that shape (callers then fall back to the global stores).
fn project_root_of(session_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    session_dir
        .parent()          // sessions
        .and_then(|p| p.parent())  // .gwork
        .and_then(|p| p.parent())  // <root>
        .map(|p| p.to_path_buf())
}

/// Resolve the workspace a ReAct run operates in.
///
/// Split out as a free function **because the call site cannot be unit-tested**:
/// it lives inside the run spawner, which needs a live provider to reach. That is
/// exactly how the sub-agent model-inheritance defect stayed invisible for so
/// long — the one line that made the tradeoff was buried in a function nobody
/// could exercise without a real LLM. A wrong answer here is silent and severe:
/// tools would `read`/`write`/`grep`/`bash` against the wrong directory tree.
///
/// `bound_root` is the session's owning project (from `session-roots.json`),
/// `kernel_workspace` is the install-time workspace passed to `serve`.
///
/// ## Why not derive it from the session directory
///
/// [`project_root_of`] walks `<root>/.gwork/sessions/<sid>` up three levels. For
/// a **bound** session that yields the project root — correct. For an **unbound**
/// (global) session the base is `<harness_base>/.gwork/sessions`, so it yields
/// `<harness_base>`: the user's home directory. That is the right answer for the
/// global-area lookups (skills and memory really do live under
/// `<harness_base>/.gwork`), and the wrong answer for a run's workspace — it
/// would move every global session's tool cwd and HITL write boundary into
/// `$HOME`, a much wider surface than the intended `~/GWork`.
///
/// So the two questions are answered separately, and this one is gated on the
/// binding registry rather than on path shape.
///
/// ## Why this matters most for remote workspaces
///
/// A remote-deployed kernel is launched by an SSH `exec`, so its process cwd is
/// `$HOME` and `kernel_workspace` is whatever the launcher passed. Without this
/// resolution a session bound to `/srv/host/project` would run its tools in
/// `$HOME` — the agent would report on the wrong project while the UI showed the
/// right one, and every file operation would land outside the workspace the user
/// selected.
pub(crate) fn resolve_run_workspace(
    bound_root: Option<&str>,
    kernel_workspace: &std::path::Path,
) -> std::path::PathBuf {
    match bound_root {
        // A blank binding is treated as absent: `SessionRoots::bind` already
        // refuses empty roots, but a hand-edited `session-roots.json` could hold
        // one, and `PathBuf::from("")` would make every relative tool path
        // resolve against the process cwd — the least predictable answer of all.
        Some(root) if !root.trim().is_empty() => std::path::PathBuf::from(root),
        _ => kernel_workspace.to_path_buf(),
    }
}

/// Build a memory preview block for the system prompt (top entries by importance).
///
/// Reads the **session's project** memory, falling back to global: the entries
/// relevant to a run are the ones scoped to the project it operates on, which is
/// also where `memory_extract` writes. Reading only the global store (as an
/// earlier version did) meant a project with 160 memories contributed nothing to
/// its own system prompt.
fn build_memory_preview(project_root: Option<&std::path::Path>) -> String {
    let store = match project_root {
        Some(root) => crate::memory::MemoryStore::workspace(root),
        None => crate::memory::MemoryStore::global(),
    };
    let entries = store.load_all();
    if entries.is_empty() {
        return String::new();
    }
    let mut out = String::from("\n## Long-term Memory (top entries)\n");
    for e in entries.iter().take(10) {
        let preview: String = e.content.chars().take(150).collect();
        out.push_str(&format!("- [{}] {}: {}\n", e.key, e.title, preview));
    }
    out
}

/// Persist a frame to the session's .stream.ndjson file (ownership-routed).
pub(crate) async fn persist_frame(state: &Arc<AppState>, session_id: &str, frame: &Frame) {
    store_for(state, session_id).append_stream_frame(session_id, frame);
}

/// Throttle bookkeeping for the issued-seq watermark.
#[derive(Default)]
struct IssuedFlushState {
    last_flush: Option<Instant>,
    frames_since: u32,
}

/// Record the highest `eventSeq` handed out for a session, so a kernel
/// restart can seed the next counter above what the frontend cursor may
/// already hold (see `seq_for`).
///
/// Throttled: a text-delta-heavy run broadcasts thousands of frames and a
/// synchronous file write per frame would sit on the hot path. The flush is
/// **write-ahead** (record the seq *before* trusting it as durable) and
/// bounded by time and frame count; lifecycle frames (`done`, `error`,
/// `done_suspended`) flush immediately because they end a run and the
/// watermark must be current before the next run can start. The residual
/// window is therefore a kernel *crash* inside a run (at most the throttle
/// interval of issued seqs), not a clean restart between runs — and a crash
/// that also takes the page down rebuilds the cursor from disk anyway.
///
/// `"*"` is the watcher's pseudo-session (no stream file, no cursor); it is
/// excluded so recording cannot create a stray directory.
const ISSUED_FLUSH_MS: u128 = 2000;
const ISSUED_FLUSH_FRAMES: u32 = 200;

async fn record_issued_seq(state: &Arc<AppState>, session_id: &str, seq: i64, frame_type: &str) {
    if session_id == "*" || seq < 0 {
        return;
    }
    let immediate = matches!(frame_type, "done" | "error" | "done_suspended");
    let flush_now = {
        let mut map = state.issued_seq_flush.lock().await;
        let st = map.entry(session_id.to_string()).or_default();
        st.frames_since += 1;
        let now = Instant::now();
        let due = immediate
            || st.frames_since >= ISSUED_FLUSH_FRAMES
            || st.last_flush
                .map(|t| now.duration_since(t).as_millis() >= ISSUED_FLUSH_MS)
                .unwrap_or(true);
        if due {
            st.last_flush = Some(now);
            st.frames_since = 0;
        }
        due
    };
    if flush_now {
        // Outside the ws_clients lock: file IO must not stall other sessions'
        // broadcasts. Monotonic inside `write_issued_seq`, so an out-of-order
        // flush cannot regress the mark.
        store_for(state, session_id).write_issued_seq(session_id, seq);
    }
}

/// Broadcast a frame to all WS clients subscribed to a session.
pub(crate) async fn broadcast_frame(state: &Arc<AppState>, session_id: &str, frame: Frame) {
    let seq = frame.event_seq;
    let frame_type = frame.frame_type.clone();
    let mut clients = state.ws_clients.lock().await;
    // Clean up dead senders while we're here
    if let Some(senders) = clients.get_mut(session_id) {
        senders.retain(|tx| !tx.is_closed());
        for tx in senders.iter() {
            let _ = tx.send(frame.clone());
        }
    }
    // Also broadcast to "all" subscribers (gate without session filter)
    if let Some(senders) = clients.get_mut("*") {
        senders.retain(|tx| !tx.is_closed());
        for tx in senders.iter() {
            let _ = tx.send(frame.clone());
        }
    }
    drop(clients);
    // Record the issued high-water mark *after* the frame left the senders:
    // the watermark must never claim a seq the frontend could not have seen.
    if let Some(seq) = seq {
        record_issued_seq(state, session_id, seq, &frame_type).await;
    }
}

/// POST /web/chat/interrupt — stop the running task.
///
/// Returns a **semantic** status under `data.status`, matching Java
/// (`WebGate.interruptSession`) and what the frontend branches on
/// (`app-streaming.js:requestInterrupt`):
///
/// - `cancelled`    — the run was stopped; a matching `done` frame follows.
/// - `turn_changed` — the client's `runId` is stale, so nothing was cancelled and
///   the authoritative id is returned for the client to recalibrate and retry.
/// - `not_running`  — no run to stop.
///
/// The previous version returned a bare `{"code":200}` for every case. The
/// frontend reads `resp.data.status`; getting `undefined` made it fall through to
/// `reconcileSessionRunning` with no retry, so the UI stayed in its streaming
/// state — the timer kept running and pressing Stop again did nothing. That is
/// the reported "cannot stop the task" symptom, and it happened even when the
/// cancellation itself had worked.
async fn chat_interrupt(
    State(state): State<Arc<AppState>>,
    payload: InterruptPayload,
) -> Json<serde_json::Value> {
    let session_id = payload.session_id;
    if session_id.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "MISSING_SESSION_ID"}));
    }

    // Peek before removing: a stale `runId` must not cancel the *current* run.
    // The user asked to stop the turn they were watching; if a new turn has since
    // started, cancelling it would destroy work they never asked to stop.
    let expected = payload.run_id.trim().to_string();
    {
        let running = state.running.lock().await;
        if let Some(t) = running.get(&session_id) {
            if !expected.is_empty() && t.run_id != expected {
                let authoritative = t.run_id.clone();
                drop(running);
                return Json(serde_json::json!({
                    "code": 200,
                    "data": { "status": "turn_changed", "runId": authoritative }
                }));
            }
        }
    }

    let task = state.running.lock().await.remove(&session_id);
    let status = match task {
        Some(t) => {
            t.cancel.cancel();
            "cancelled"
        }
        None => "not_running",
    };

    // Also clear any suspension (memory AND disk): a run suspended on HITL or a
    // question has no entry in `running`, so without this the Stop button would
    // leave the approval card hanging forever.
    drop_suspension(&state, &session_id).await;

    Json(serde_json::json!({"code": 200, "data": {"status": status}}))
}

/// Interrupt payload: accepts query or form.
struct InterruptPayload {
    session_id: String,
    /// The run the client believes is active; empty means "whatever is running".
    run_id: String,
}

/// Form body for `/web/chat/interrupt`.
///
/// Separate from `SessionIdQuery` because the interrupt also carries `runId`:
/// the frontend posts `{sessionId, runId}` (`app-streaming.js:27-29`) and the
/// stale-run check depends on it. Reusing the session-id-only struct would drop
/// `runId` on the floor and make every interrupt look like "stop whatever is
/// running", cancelling a newer turn the user never asked to stop.
#[derive(serde::Deserialize, Default)]
struct InterruptForm {
    #[serde(rename = "sessionId", default)]
    session_id: String,
    #[serde(rename = "runId", default)]
    run_id: String,
}

#[axum::async_trait]
impl<S> axum::extract::FromRequest<S> for InterruptPayload
where
    S: Send + Sync,
{
    type Rejection = std::convert::Infallible;

    async fn from_request(req: axum::http::Request<axum::body::Body>, state: &S) -> Result<Self, Self::Rejection> {
        // Query string first. Parse it as a whole: the previous code stripped the
        // `sessionId=` prefix and then fed the *bare value* to
        // `form_urlencoded::parse`, which treats a string with no `=` as a key
        // with an empty value — so `?sessionId=abc` always yielded "". The
        // endpoint then removed nothing, cancelled nothing, and still answered
        // 200, which made a working Stop look broken (and made any test using the
        // query form silently prove nothing).
        let uri = req.uri().clone();
        let mut session_id = String::new();
        let mut run_id = String::new();
        for (k, v) in url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes()) {
            match k.as_ref() {
                "sessionId" => session_id = v.into_owned(),
                "runId" => run_id = v.into_owned(),
                _ => {}
            }
        }
        if session_id.is_empty() {
            // Try form body (this is what the frontend actually sends).
            if let Ok(Form(f)) = Form::<InterruptForm>::from_request(req, state).await {
                session_id = f.session_id;
                if run_id.is_empty() {
                    run_id = f.run_id;
                }
            }
        }
        Ok(InterruptPayload { session_id, run_id })
    }
}

// ─── todos / hints / usage ────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
#[allow(dead_code)]
struct TodosQuery {
    #[serde(rename = "sessionId", default)]
    session_id: String,
}

/// GET /web/chat/todos — the session's task checklist.
///
/// Reads `TODO.md` from the **session directory** (ownership-routed, exactly
/// where `todowrite` writes it — see `ToolContext::todo_file`). It used to read
/// a single `<workspace>/.gwork/TODO.md`, so every session shared one file and a
/// session bound to a project never saw its own list: the task panel rendered
/// empty no matter what the agent had written.
///
/// Response shape is Java's `{exists, raw, items, stats}`, not a bare array. The
/// frontend distinguishes three states from it — no file / empty file / file with
/// unparseable content (`malformed` in `app-todos.js`) — and a bare array
/// collapses all three into "no tasks", which also hides the task chip.
async fn chat_todos(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Query(q): Query<TodosQuery>,
) -> Json<serde_json::Value> {
    // Java rejects these outright; without the check the id reaches the path
    // join below. `sanitize_id` is the backstop, but the 400 is the contract.
    if q.session_id.contains("..") || q.session_id.contains('/') || q.session_id.contains('\\') {
        return Json(serde_json::json!({"code": 400, "description": "Invalid sessionId"}));
    }
    let cwd = headers
        .get("x-session-cwd")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    if let Some(h) = cwd.as_deref() {
        if percent_decode(h).contains("..") {
            return Json(serde_json::json!({"code": 400, "description": "Invalid Session Cwd"}));
        }
    }
    // Binds the session to its declared project root when the header is present,
    // then returns the routed store (same helper `chat_input` uses).
    let store = bind_session_cwd(&state, &q.session_id, cwd.as_deref());

    let empty_stats = serde_json::json!({
        "total": 0, "pending": 0, "inProgress": 0, "done": 0
    });

    if q.session_id.is_empty() {
        return Json(serde_json::json!({
            "code": 200,
            "data": { "exists": false, "items": [], "stats": empty_stats }
        }));
    }

    let todo_file = store.session_dir_pub(&q.session_id).join(crate::session::TODO_FILE_NAME);
    let Ok(raw) = std::fs::read_to_string(&todo_file) else {
        return Json(serde_json::json!({
            "code": 200,
            "data": { "exists": false, "items": [], "stats": empty_stats }
        }));
    };

    // Read-side self-healing: sessions written by a kernel without the
    // write-path normaliser still hold JSON envelopes on disk, and this
    // endpoint is what turns them into the panel's "malformed" state. Heal
    // once here — the panel polls this endpoint, so an old session repairs
    // itself the moment the user opens the task panel — and answer from the
    // repaired bytes so panel and disk agree from this request on.
    let raw = match crate::todo::heal_content(&raw) {
        Some(healed) => {
            let body = if healed.ends_with('\n') {
                healed.clone()
            } else {
                format!("{}\n", healed)
            };
            if std::fs::write(&todo_file, &body).is_ok() {
                body
            } else {
                healed
            }
        }
        None => raw,
    };

    let (items, stats) = parse_todo_items(&raw);
    Json(serde_json::json!({
        "code": 200,
        "data": { "exists": true, "raw": raw, "items": items, "stats": stats }
    }))
}

/// Parse a Markdown checklist into Java's item + stats shape.
///
/// `## Heading` lines set the group of every checkbox that follows them, so the
/// panel can render sections. Returns `(items, stats)`.
///
/// Checkbox states: `- [ ]` pending, `- [/]` in progress, `- [x]`/`- [X]` done.
/// `line` is the 1-based source line number (the panel uses it to target a row),
/// `## Group heading` — a checklist section title.
static TODO_GROUP_RE: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| regex::Regex::new(r"^\s*##\s+.+$").unwrap());

/// A whole checkbox line (`- [ ] text`, `- [x] text`, `- [/] text`).
static TODO_CHECK_RE: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| regex::Regex::new(r"^\s*-\s*\[( |x|X|/)\]\s+.+$").unwrap());

/// Same line, capturing the status marker.
static TODO_STATUS_RE: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| regex::Regex::new(r"^\s*-\s*\[([ xX/])]\s+.+$").unwrap());

/// Marker-only pattern, used to strip the prefix and keep the text. It must
/// NOT end in `.+$`: [`TODO_CHECK_RE`] matches the whole line, so reusing it for
/// the strip would replace the text along with the marker and yield "".
/// (Java: `line.replaceFirst("^\\s*-\\s*\\[[ xX/]]\\s+", "").trim()`.)
static TODO_MARKER_RE: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| regex::Regex::new(r"^\s*-\s*\[[ xX/]]\s+").unwrap());

/// `raw` is the trimmed original line (kept so a round-trip write cannot lose
/// formatting the parser does not model).
fn parse_todo_items(content: &str) -> (Vec<serde_json::Value>, serde_json::Value) {
    let mut items = Vec::new();
    let mut group = String::new();
    let (mut total, mut pending, mut in_progress, mut done) = (0usize, 0usize, 0usize, 0usize);

    // Compiled once, not per request. The task panel polls `/web/chat/todos`, so
    // these four patterns used to be recompiled on every poll — pure CPU waste on
    // the async worker. `once_cell::sync::Lazy` is the established pattern in this
    // repo (config, hitl/shape, skills, tools/agent, tools/web).
    let group_re = &*TODO_GROUP_RE;
    let check_re = &*TODO_CHECK_RE;
    let status_re = &*TODO_STATUS_RE;
    let marker_re = &*TODO_MARKER_RE;

    for (i, line) in content.lines().enumerate() {
        if group_re.is_match(line) {
            group = line
                .trim_start()
                .trim_start_matches('#')
                .trim_start_matches('#')
                .trim()
                .to_string();
            continue;
        }
        if !check_re.is_match(line) {
            continue;
        }
        total += 1;
        let marker = status_re
            .captures(line)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_else(|| " ".to_string());
        let status = match marker.as_str() {
            " " => {
                pending += 1;
                "pending"
            }
            "/" => {
                in_progress += 1;
                "in_progress"
            }
            _ => {
                done += 1;
                "done"
            }
        };
        let text = marker_re.replace(line, "").trim().to_string();
        items.push(serde_json::json!({
            "line": i + 1,
            "status": status,
            "text": text,
            "raw": line.trim(),
            "group": group,
        }));
    }

    let stats = serde_json::json!({
        "total": total,
        "pending": pending,
        "inProgress": in_progress,
        "done": done,
    });
    (items, stats)
}

/// GET /web/chat/hints — the `/` and `@` completion list.
///
/// Java `WebController.hints()` returns one flat array of
/// `{name, description, type}` where `type` is `command`, `subagent` or
/// `skill`. The frontend **filters on that field**
/// (`app-history.js:2732-2739`):
///
/// ```js
/// var filterType = (trigger === '@') ? 'subagent' : 'skill';
/// if (cmd.type !== filterType) continue;
/// ```
///
/// This endpoint previously answered with four hard-coded prompt *strings*.
/// Strings have no `.type`, so `undefined !== 'skill'` discarded every entry,
/// `cmdVisibleItems` came out empty and `showCmdComplete` bailed to
/// `hideCmdCompleteFor` — the panel never opened at all for either trigger.
/// The agent, skill and command sources all existed already; only this handler
/// was never wired to them.
///
/// The scan is per-request and uncached, matching `AgentManager::load`'s
/// reasoning: a user who adds `.gwork/skills/foo` expects to see it on the next
/// `/` without restarting the kernel. Both scans are a couple of `read_dir`s
/// over small directories.
async fn chat_hints(State(_state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "code": 200, "data": build_hints() }))
}

/// Build the completion list. Split out of the handler so it can be tested
/// without standing up an `AppState` — the handler reads nothing from it.
fn build_hints() -> Vec<serde_json::Value> {
    // No session context on this endpoint, so the project scope is the
    // process's working directory — the workspace the kernel was started in.
    // Both registries merge their global directory in regardless, so a failure
    // to resolve it degrades to "global entries only" rather than an empty panel.
    let workspace = std::env::current_dir().ok();

    let mut data: Vec<serde_json::Value> = Vec::new();

    for (name, description) in commands::completable() {
        data.push(serde_json::json!({
            "name": name,
            "description": description,
            "type": "command",
        }));
    }

    let agents = crate::agents::AgentManager::load(workspace.as_deref());
    for def in agents.visible() {
        data.push(serde_json::json!({
            "name": def.name,
            "description": def.description,
            "type": "subagent",
        }));
    }

    let registry = match workspace.as_deref() {
        Some(ws) => crate::skills::SkillRegistry::with_workspace(ws),
        None => crate::skills::SkillRegistry::new(),
    };
    // Java de-duplicates by name while iterating `engine.getSkills()`; the first
    // entry wins. `load_all` already resolves workspace-over-global shadowing,
    // but the guard is kept so a duplicate can never produce two identical rows
    // in the panel.
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for skill in registry.load_all() {
        if !seen.insert(skill.name.clone()) {
            continue;
        }
        data.push(serde_json::json!({
            "name": skill.name,
            "description": hint_description(&skill.description),
            "type": "skill",
        }));
    }

    data
}

/// First line of a skill description, capped for the completion row.
///
/// Java truncates to 30 characters and appends an ellipsis. The cap counts
/// **characters, not bytes**: skill descriptions here are usually Chinese, and
/// slicing a 3-byte char mid-sequence would panic the handler.
fn hint_description(raw: &str) -> String {
    let first_line = raw.lines().next().unwrap_or("").trim();
    let mut out = String::new();
    for (i, c) in first_line.chars().enumerate() {
        if i >= 30 {
            out.push_str("...");
            return out;
        }
        out.push(c);
    }
    out
}

#[derive(serde::Deserialize)]
#[allow(dead_code)]
struct UsageQuery {
    #[serde(default = "default_days")]
    days: u32,
}

fn default_days() -> u32 {
    30
}

/// GET /web/chat/loop-run — restore the "task run parameters" banner for a
/// loop execution session. The Java kernel reads the evidence from the live
/// session context / snapshot; this kernel does not record loop-run evidence
/// yet, so it answers the contract's "no evidence" shape (`data: null`) and
/// the frontend clears the banner instead of hitting a 404 on every open.
async fn chat_loop_run(
    State(_state): State<Arc<AppState>>,
    Query(q): Query<SessionIdQuery>,
) -> Json<serde_json::Value> {
    if q.session_id.is_empty()
        || q.session_id.contains("..")
        || q.session_id.contains('/')
        || q.session_id.contains('\\')
    {
        return Json(serde_json::json!({"code": 400, "description": "Invalid sessionId"}));
    }
    Json(serde_json::json!({"code": 200, "data": null}))
}

async fn chat_usage_stats(
    State(_state): State<Arc<AppState>>,
    Query(q): Query<UsageQuery>,
) -> Json<serde_json::Value> {
    // `compute_report` walks every sessions root and reads each session's
    // `.stream.ndjson` **synchronously** — measured at 179 MB across 81 files on
    // this machine, ~2.2 s of blocking I/O and JSON parsing.
    //
    // Running that inline on a tokio worker starves the whole runtime: while one
    // usage/stats call was in flight, even `/web/chat/meta` (1 ms unloaded) took
    // 2178 ms, and the 12 concurrent `sessions?root=` calls the sidebar fires on
    // load all stalled ~3.8 s. That single endpoint was therefore the cause of
    // both "the API is slow" and "startup is slow".
    //
    // `spawn_blocking` moves the scan onto the dedicated blocking pool, so async
    // handlers keep making progress. A real fix would be an incrementally
    // maintained ledger like the Java kernel's (38 ms for the same query); this
    // removes the cross-endpoint interference without changing the wire shape.
    let days = q.days;
    let report = tokio::task::spawn_blocking(move || crate::usage::compute_report(days))
        .await
        .unwrap_or_else(|e| {
            tracing::error!(error = %e, "usage stats computation panicked");
            crate::usage::UsageReport(serde_json::json!({}))
        });
    Json(serde_json::json!({
        "code": 200,
        "data": report.0,
    }))
}

// ─── memory endpoints ─────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
#[allow(dead_code)]
struct MemoryListQuery {
    #[serde(default = "default_scope")]
    scope: String,
}

fn default_scope() -> String {
    "workspace".into()
}

/// Resolve which directory a memory request addresses.
///
/// `scope=global` → `~/.gwork/memory`. `scope=workspace` → the project named by
/// the `X-Session-Cwd` header (the memory page has its own project picker, so the
/// cwd is not implied by the session).
///
/// Returns `(store, effective_scope, aliased)`. When `general.memoryIsolation` is
/// off, workspace memory *is* global memory: the Java kernel reports that with
/// `aliased:true` and the UI shows a hint instead of a second, contradictory
/// list — and, critically, refuses to clear it from the workspace tab.
fn resolve_memory_scope(
    isolation_enabled: bool,
    scope: &str,
    cwd_header: Option<&str>,
) -> Result<(crate::memory::MemoryStore, &'static str, bool), &'static str> {
    let global = scope != "workspace";
    if global {
        return Ok((crate::memory::MemoryStore::global(), "global", false));
    }
    if !isolation_enabled {
        return Ok((crate::memory::MemoryStore::global(), "global", true));
    }
    let Some(raw) = cwd_header else {
        return Err("workspace scope requires X-Session-Cwd");
    };
    let decoded = percent_decode(raw);
    if decoded.is_empty() || decoded.contains("..") {
        return Err("Invalid Session Cwd");
    }
    let path = std::path::Path::new(&decoded);
    if !path.is_absolute() || !path.is_dir() {
        return Err("Invalid Session Cwd");
    }
    Ok((crate::memory::MemoryStore::workspace(path), "workspace", false))
}

/// Java's `memoryList` item limit; `total` still reports the full count so the UI
/// can render "shown/total" and set `hasMore`.
const MEMORY_LIST_LIMIT: usize = 200;

fn memory_item(e: &crate::memory::MemoryEntry) -> serde_json::Value {
    serde_json::json!({
        "key": e.key,
        "title": e.title,
        // The frontend renders `it.content`; the previous `fact` key left every
        // card body blank.
        "content": e.content,
        "importance": e.importance,
        // Display timestamp, not `createdAt` — the UI prints it verbatim.
        "time": e.time,
        "ttl": e.ttl,
        "ttlKnown": e.ttl_known,
        "expiresAtEpochMs": e.expires_at_epoch_ms,
    })
}

async fn chat_memory_list(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Query(q): Query<MemoryListQuery>,
) -> Json<serde_json::Value> {
    // Java accepts only these two; anything else is a caller bug, not an empty list.
    if q.scope != "workspace" && q.scope != "global" {
        return Json(serde_json::json!({"code": 400, "description": "scope must be workspace or global"}));
    }
    let cwd = headers
        .get("x-session-cwd")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let isolation = state.settings.read().await.general.memory_isolation;
    let (store, effective, aliased) = match resolve_memory_scope(isolation, &q.scope, cwd.as_deref()) {
        Ok(v) => v,
        Err(e) => return Json(serde_json::json!({"code": 400, "description": e})),
    };

    // Directory scan + front-matter parse of up to hundreds of files: keep it off
    // the async worker (same reasoning as `chat_usage_stats`).
    let report = tokio::task::spawn_blocking(move || {
        let entries = store.load_all();
        let total = entries.len();
        let items: Vec<serde_json::Value> = entries.iter().take(MEMORY_LIST_LIMIT).map(memory_item).collect();
        (total, items)
    })
    .await
    .unwrap_or_else(|e| {
        tracing::error!(error = %e, "memory list panicked");
        (0, Vec::new())
    });

    Json(serde_json::json!({
        "code": 200,
        "data": {
            "scope": if q.scope == "global" { "global" } else { "workspace" },
            "effectiveScope": effective,
            "aliased": aliased,
            "items": report.1,
            "total": report.0,
            "hasMore": report.0 > report.1.len(),
        }
    }))
}

/// Body of `POST /web/chat/memory/{delete,clear}`.
///
/// The frontend sends JSON (`headers['Content-Type'] = 'application/json'`), so a
/// `Form<...>` extractor answered 415 and every delete/clear silently failed.
#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct MemoryScopeBody {
    #[serde(default)]
    key: String,
    #[serde(default)]
    scope: String,
}

async fn chat_memory_delete(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    FlexBody(form): FlexBody<MemoryScopeBody>,
) -> Json<serde_json::Value> {
    if form.key.trim().is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "key is required"}));
    }
    let scope = if form.scope.is_empty() { "workspace" } else { form.scope.as_str() };
    if scope != "workspace" && scope != "global" {
        return Json(serde_json::json!({"code": 400, "description": "scope must be workspace or global"}));
    }
    let cwd = headers.get("x-session-cwd").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let isolation = state.settings.read().await.general.memory_isolation;
    let (store, _effective, aliased) = match resolve_memory_scope(isolation, scope, cwd.as_deref()) {
        Ok(v) => v,
        Err(e) => return Json(serde_json::json!({"code": 400, "description": e})),
    };
    // Refuse to delete from the workspace tab while it is aliased to global: the
    // user would be removing shared memories while believing they are scoped.
    if aliased {
        return Json(serde_json::json!({
            "code": 400,
            "description": "WORKSPACE_MEMORY_ALIASED_TO_GLOBAL"
        }));
    }
    let key = form.key.clone();
    let deleted = tokio::task::spawn_blocking(move || store.delete(&key))
        .await
        .unwrap_or(false);
    Json(serde_json::json!({"code": 200, "data": {"deleted": deleted}}))
}

async fn chat_memory_clear(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    FlexBody(form): FlexBody<MemoryScopeBody>,
) -> Json<serde_json::Value> {
    let scope = if form.scope.is_empty() { "workspace" } else { form.scope.as_str() };
    if scope != "workspace" && scope != "global" {
        return Json(serde_json::json!({"code": 400, "description": "scope must be workspace or global"}));
    }
    let cwd = headers.get("x-session-cwd").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let isolation = state.settings.read().await.general.memory_isolation;
    let (store, _effective, aliased) = match resolve_memory_scope(isolation, scope, cwd.as_deref()) {
        Ok(v) => v,
        Err(e) => return Json(serde_json::json!({"code": 400, "description": e})),
    };
    if aliased {
        // The frontend matches this exact token to show the "switch to global to
        // confirm" explanation instead of a generic failure.
        return Json(serde_json::json!({
            "code": 400,
            "description": "WORKSPACE_MEMORY_ALIASED_TO_GLOBAL"
        }));
    }
    let removed = tokio::task::spawn_blocking(move || {
        let entries = store.load_all();
        let mut n = 0usize;
        for e in &entries {
            if store.delete(&e.key) {
                n += 1;
            }
        }
        n
    })
    .await
    .unwrap_or(0);
    Json(serde_json::json!({"code": 200, "data": {"removed": removed}}))
}

// ─── settings endpoints ───────────────────────────────────────────────────────

async fn settings_general(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let settings = state.settings.read().await;
    Json(general_payload(&settings))
}

/// Build the `GET /web/settings/general` response body.
///
/// Extracted from the handler so the one security-relevant property in it — the
/// password is never echoed — is asserted against the value actually returned,
/// rather than against source text.
fn general_payload(settings: &Settings) -> serde_json::Value {
    serde_json::json!({
        "code": 200,
        "data": {
            "historyWindowSize": settings.general.history_window_size,
            "apiRetries": settings.general.api_retries,
            "maxTurns": settings.general.max_turns,
            "autoRethink": settings.general.auto_rethink,
            "contextLength": settings.general.context_length,
            "compressionRatio": settings.general.compression_ratio,
            "compressionTargetRatio": settings.general.compression_target_ratio,
            "compressionReservedOutputTokens": settings.general.compression_reserved_output_tokens,
            "compressionMaxMessages": settings.general.compression_max_messages,
            "memoryEnabled": settings.general.memory_enabled,
            "memoryIsolation": settings.general.memory_isolation,
            "locale": settings.general.locale,
            "darkMode": settings.general.dark_mode,
            // Skill listing budget. Reported normalized, not raw: the value that
            // actually drives the prompt is the clamped one, and echoing back a
            // stored typo would make the settings page claim a budget the kernel
            // is not using.
            "skillListingBudgetFraction": crate::skills::normalize_budget_fraction(
                Some(settings.general.skill_listing_budget_fraction),
            ),
            "skillListingMaxDescChars": crate::skills::normalize_max_desc_chars(
                settings.general.skill_listing_max_desc_chars as usize,
            ),
            // Assistant display name for the chat header. `null` = not set;
            // the frontend falls back to the built-in "GWork".
            "assistantName": settings.general.assistant_name.clone(),
            // Whether Basic Auth is enforced, and the username. The password is
            // deliberately **never** returned.
            //
            // Java's `generalGet` does `Result.succeed(settings.getGeneral())`,
            // which serialises `webAuthPass` in plaintext to any caller that can
            // reach the endpoint. That is a leak, not a contract to match: this
            // kernel already masks `apiKey` for the same reason
            // (`settings_api::mask_api_key`). A settings page needs to know
            // "is auth on, as whom" to render the form; it never needs the secret.
            "webAuthEnabled": guard::BasicAuth::from_settings(
                settings.general.web_auth_user.as_deref(),
                settings.general.web_auth_pass.as_deref(),
            )
            .is_enforced(),
            "webAuthUser": settings.general.web_auth_user.clone().unwrap_or_default(),
        }
    })
}

#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct GeneralSaveBody {
    #[serde(rename = "historyWindowSize")]
    history_window_size: Option<u32>,
    #[serde(rename = "apiRetries")]
    api_retries: Option<u32>,
    #[serde(rename = "maxTurns")]
    max_turns: Option<u32>,
    #[serde(rename = "autoRethink")]
    auto_rethink: Option<bool>,
    #[serde(rename = "contextLength")]
    context_length: Option<i64>,
    #[serde(rename = "compressionRatio")]
    compression_ratio: Option<u32>,
    #[serde(rename = "compressionTargetRatio")]
    compression_target_ratio: Option<u32>,
    #[serde(rename = "compressionReservedOutputTokens")]
    compression_reserved_output_tokens: Option<u64>,
    #[serde(rename = "compressionMaxMessages")]
    compression_max_messages: Option<u32>,
    #[serde(rename = "memoryEnabled")]
    memory_enabled: Option<bool>,
    #[serde(rename = "memoryIsolation")]
    memory_isolation: Option<bool>,
    locale: Option<String>,
    #[serde(rename = "darkMode")]
    dark_mode: Option<bool>,
    #[serde(rename = "skillListingBudgetFraction")]
    skill_listing_budget_fraction: Option<u32>,
    #[serde(rename = "skillListingMaxDescChars")]
    skill_listing_max_desc_chars: Option<u32>,
    /// Assistant display name. `Option<Option<String>>`: absent = leave
    /// alone, explicit null or blank = clear back to the built-in default.
    #[serde(rename = "assistantName", default, deserialize_with = "double_option")]
    assistant_name: Option<Option<String>>,
    /// Basic Auth credentials.
    ///
    /// `Option<Option<String>>`, not `Option<String>`: the two nesting levels
    /// distinguish **key absent** (leave the stored value alone) from **key
    /// present and null** (clear it). Collapsing them would make "save only
    /// `{darkMode:true}`" indistinguishable from "clear the password", and a
    /// partial save from the appearance panel would silently disable auth.
    ///
    /// Java hits the same wall from the other side — `bindTo` skips nulls, so
    /// `WebSettingsController.generalSave` has to hand-check
    /// `tmp.hasKey("webAuthUser") && tmp.get("webAuthUser").isNull()` to support
    /// clearing at all.
    #[serde(rename = "webAuthUser", default, deserialize_with = "double_option")]
    web_auth_user: Option<Option<String>>,
    #[serde(rename = "webAuthPass", default, deserialize_with = "double_option")]
    web_auth_pass: Option<Option<String>>,
}

/// Deserialize into `Option<Option<T>>` so absent / null / value are distinct.
fn double_option<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // `Option::deserialize` gives `None` for an explicit JSON null and
    // `Some(v)` for a value; serde only calls this function when the key is
    // present at all, so the outer `Some` means "the key was in the body".
    Ok(Some(<Option<String> as serde::Deserialize>::deserialize(
        deserializer,
    )?))
}

/// POST /web/settings/general/save
///
/// Partial-update semantics: only keys present in the body are written. The
/// frontend relies on this — the memory view saves a single toggle
/// (`{memoryEnabled:false}`) and the appearance panel saves only `{locale}`;
/// treating absent keys as "reset to default" would wipe unrelated settings.
async fn settings_general_save(
    State(state): State<Arc<AppState>>,
    Json(body): Json<GeneralSaveBody>,
) -> Json<serde_json::Value> {
    {
        let mut settings = state.settings.write().await;
        if let Some(v) = body.history_window_size { settings.general.history_window_size = v; }
        if let Some(v) = body.api_retries { settings.general.api_retries = v; }
        if let Some(v) = body.max_turns { settings.general.max_turns = v; }
        if let Some(v) = body.auto_rethink { settings.general.auto_rethink = v; }
        // The context window is a fixed set of options (Java
        // `ContextLengthPolicy.isAllowed`); an arbitrary value would make the
        // compression budget disagree with what the model actually accepts.
        if let Some(v) = body.context_length {
            if crate::usage::CONTEXT_LENGTH_OPTIONS.contains(&v) {
                settings.general.context_length = v;
            }
        }
        // Clamped exactly like Java's setters, so a bad value from the wire
        // cannot disable compression (ratio 0) or make it a no-op (target 100).
        if let Some(v) = body.compression_ratio { settings.general.compression_ratio = v.clamp(1, 100); }
        if let Some(v) = body.compression_target_ratio { settings.general.compression_target_ratio = v.clamp(10, 95); }
        if let Some(v) = body.compression_reserved_output_tokens { settings.general.compression_reserved_output_tokens = v.max(1_000); }
        if let Some(v) = body.compression_max_messages { settings.general.compression_max_messages = v.max(1); }
        if let Some(v) = body.memory_enabled { settings.general.memory_enabled = v; }
        if let Some(v) = body.memory_isolation { settings.general.memory_isolation = v; }
        if let Some(v) = body.locale { settings.general.locale = v; }
        if let Some(v) = body.dark_mode { settings.general.dark_mode = v; }
        // Normalized rather than clamped, matching Java
        // `SkillListingPolicy.normalizeFraction`: a 0 or a 99 here is a config
        // mistake, and clamping would silently accept a budget the user never
        // asked for (0 would empty the listing entirely).
        if let Some(v) = body.skill_listing_budget_fraction {
            settings.general.skill_listing_budget_fraction =
                crate::skills::normalize_budget_fraction(Some(v));
        }
        if let Some(v) = body.skill_listing_max_desc_chars {
            settings.general.skill_listing_max_desc_chars =
                crate::skills::normalize_max_desc_chars(v as usize) as u32;
        }
        // Trim and cap the display name: it lands in a fixed-width header
        // row, and a pasted paragraph would stretch it. Blank = clear.
        if let Some(v) = body.assistant_name {
            settings.general.assistant_name = v
                .map(|s| s.trim().chars().take(32).collect::<String>())
                .filter(|s| !s.is_empty());
        }
        // Credentials: outer `Some` = the key was in the body; inner `None` =
        // an explicit null = clear it. An empty/whitespace string also clears,
        // because `BasicAuth::is_enforced` treats a blank half as "not
        // configured" and storing `""` would leave a key on disk that reads back
        // as configured-but-inert.
        if let Some(v) = body.web_auth_user {
            settings.general.web_auth_user = v.filter(|s| !s.trim().is_empty());
        }
        if let Some(v) = body.web_auth_pass {
            settings.general.web_auth_pass = v.filter(|s| !s.trim().is_empty());
        }
    }
    // Persist outside the write lock: persist_settings takes a read lock itself.
    // The result reaches the UI: general/save is the settings page's primary
    // save path, and answering an unconditional 200 while the disk write was
    // refused (corrupt settings.json) left the page showing values that do not
    // exist on disk — the frontend's `.done` never ran its error branch because
    // the transport itself succeeded. Report the real outcome.
    let saved = persist_settings(&state).await;
    if saved {
        Json(serde_json::json!({"code": 200}))
    } else {
        Json(serde_json::json!({
            "code": 500,
            "msg": "settings.json 无法解析或写入失败，本次保存未落盘。请修复该文件后重试。",
            "message": "settings.json 无法解析或写入失败，本次保存未落盘。请修复该文件后重试。"
        }))
    }
}

/// Build the `general` patch that `persist_settings` merges into settings.json.
///
/// Extracted from `persist_settings` so the one security-relevant branch in it
/// is unit-testable: when `settings_loaded` is false the Basic Auth keys are
/// **omitted**, because the in-memory credentials are then `None` as a
/// consequence of the failed parse rather than of the user having none. Writing
/// them would erase a real password and leave the kernel serving with auth
/// silently off — turning a parse error into an unauthenticated kernel.
///
/// Every other key is written regardless of `loaded`: they come from a struct
/// with safe defaults and are what the failing save call intended to change.
fn general_patch(settings: &Settings, loaded: bool) -> serde_json::Value {
    let mut patch = serde_json::json!({
        "historyWindowSize": settings.general.history_window_size,
        "apiRetries": settings.general.api_retries,
        "maxTurns": settings.general.max_turns,
        // Now that this kernel implements AutoRethink and compression it is an
        // authority for these keys, so they round-trip through save. They were
        // previously absent from both the struct and this list: the values on
        // disk survived only because `merge_section` merges field-by-field, and
        // the kernel ignored them entirely — which is why every long run died at
        // turn 20 despite `"autoRethink": true` sitting in the file.
        "autoRethink": settings.general.auto_rethink,
        "contextLength": settings.general.context_length,
        "compressionRatio": settings.general.compression_ratio,
        "compressionTargetRatio": settings.general.compression_target_ratio,
        "compressionReservedOutputTokens": settings.general.compression_reserved_output_tokens,
        "compressionMaxMessages": settings.general.compression_max_messages,
        "memoryEnabled": settings.general.memory_enabled,
        "memoryIsolation": settings.general.memory_isolation,
        "locale": settings.general.locale,
        "darkMode": settings.general.dark_mode,
        // Must be listed here too, not only in the GET/save handlers: this kernel
        // is an authority for these keys, so omitting them would mean a value set
        // through the settings page could never be written back to disk — the exact
        // defect the `autoRethink` comment above records.
        "skillListingBudgetFraction": settings.general.skill_listing_budget_fraction,
        "skillListingMaxDescChars": settings.general.skill_listing_max_desc_chars,
        "assistantName": settings.general.assistant_name.clone(),
    });

    // Basic Auth credentials: written only on a good load. See the doc comment.
    //
    // `None` serialises to an explicit JSON null rather than being dropped, which
    // matters: `merge_section` only overwrites keys present in the patch, so
    // dropping them would leave a cleared password sitting on disk.
    if loaded {
        if let Some(map) = patch.as_object_mut() {
            map.insert(
                "webAuthUser".into(),
                serde_json::json!(settings.general.web_auth_user),
            );
            map.insert(
                "webAuthPass".into(),
                serde_json::json!(settings.general.web_auth_pass),
            );
        }
    }
    patch
}

/// Write the in-memory settings back to `settings.json`.
///
/// Replaces the previous per-section savers, which had two defects:
///   - `save_settings_general` only wrote when the file already existed **and**
///     parsed, so on a fresh install (no settings.json) saving silently did
///     nothing — the UI reported success and the value was gone after restart;
///   - `permission/save` never persisted at all.
///
/// Unknown top-level keys are preserved (read-modify-write), so settings written
/// by the Java kernel that this kernel does not model are not destroyed.
/// Whether `persist_settings` may write the `models` / `providers` /
/// `defaultModel` sections back to disk.
///
/// Split out as a pure function because **both** of its inputs guard against a
/// silent, unrecoverable loss and neither is reachable from a unit test at the
/// call site (`persist_settings` needs a live `AppState` and touches the real
/// `~/.gwork/settings.json`):
///
/// * `loaded == false` — settings.json did not parse at startup, so the in-memory
///   model map is empty *because the load failed*, not because the user has none.
///   Writing it back erases the real configuration. This happened once: a stray
///   `general/save` against a kernel whose config load had failed wiped a
///   24-model setup.
/// * `mirrored == true` — the model table came from the desktop shell over
///   `/web/settings/overlay`, not from this machine. Persisting it would write the
///   shell's **apiKey values** into the remote user's settings.json, which is the
///   exact leak the mirror exists to prevent (Java's `mirrored` flag refuses the
///   write for the same reason). It would also outlive the connection that
///   supplied it, since the mirror is memory-only by design.
///
/// `general` / `permission` still persist in both cases: they come from a struct
/// with safe defaults and are what the failing call actually intended to change.
fn model_sections_persistable(loaded: bool, mirrored: bool) -> bool {
    loaded && !mirrored
}

    async fn persist_settings(state: &Arc<AppState>) -> bool {
        let home = Settings::gwork_home();
        let path = home.join("settings.json");
        let settings = state.settings.read().await;

        // Same three-state read as every writer in `server/settings_api`
        // (`read_settings_for_update`). The old inline read here collapsed
        // "bytes on disk that did not parse" into an empty object, so a file
        // corrupted *at runtime* (external tool writing a BOM, truncation, disk
        // error) was erased on the next save — the startup `settings_loaded`
        // snapshot this function used to rely on cannot see runtime damage,
        // which is exactly the window this guard closes.
        //
        // `Usable` hands back the parsed object (BOM already stripped);
        // `Unreadable` refuses the write: nothing this save owns is worth more
        // than whatever is still recoverable from the damaged file.
        let mut v = match crate::server::settings_api::read_settings_for_update(&path) {
            crate::server::settings_api::SettingsRead::Usable(obj) => {
                serde_json::Value::Object(obj)
            }
            crate::server::settings_api::SettingsRead::Unreadable => {
                tracing::error!(
                    path = %path.display(),
                    "settings.json did not parse; refusing the save (writing would erase whatever is still recoverable)"
                );
                return false;
            }
        };
        let Some(obj) = v.as_object_mut() else { return false };

    // Field-level merge for `general` / `permission` rather than whole-object
    // replacement: the Java kernel models more keys here than this one does
    // (intentChainMaxTokens, ...). The two kernels share one
    // settings.json, so clobbering the whole section would silently delete
    // configuration the user made through the other kernel.
    //
    // The compression keys are now written explicitly below rather than left to
    // this merge: this kernel implements them, so it must also be able to change
    // them. Leaving them merge-only would mean a value set here could never be
    // saved back.
    let loaded = state.settings_loaded.load(Ordering::SeqCst);
    if !loaded {
        tracing::error!(
            "settings.json did not parse at startup; leaving webAuthUser/webAuthPass untouched on disk (writing them would silently disable auth)"
        );
    }
    merge_section(obj, "general", general_patch(&settings, loaded));
    merge_section(obj, "permission", serde_json::json!({
        "tools": settings.permission.tools,
        "disallowedTools": settings.permission.disallowed_tools,
        "bashExemptDirs": settings.permission.bash_exempt_dirs,
    }));

    // ── Destructive-write guard ────────────────────────────────────────────
    // If settings.json failed to parse at startup, the in-memory `models` /
    // `providers` / `defaultModel` are empty *because the load failed*, not
    // because the user has none. Writing them back would erase the real
    // configuration on disk — which is exactly how a stray `general/save` call
    // once wiped a 24-model setup. Those sections are skipped in that state;
    // `general` / `permission` still persist because they come from a struct
    // with safe defaults and are what the failing call intended to change.
    //
    // `loaded` was read once above and drives both this guard and the auth-key
    // omission in `general_patch`; re-reading the atomic here would let the two
    // disagree if anything ever flipped it mid-save.
    //
    // ── Mirror guard (remote-deployed mode) ──────────────────────────────
    // A mirror means the model table in memory came from the desktop shell, not
    // from this machine. Persisting it would write the shell's apiKey values
    // into the remote user's settings.json — the exact leak the mirror exists
    // to prevent (Java's `mirrored` flag refuses the write for the same reason).
    // The mirror also lives only in memory by design, so a save here would
    // outlive the connection that supplied it.
    let mirrored = state.mirror.is_mirrored();
    if mirrored {
        tracing::warn!(
            "remote mirror is active; refusing to persist models/providers/defaultModel \
             (they belong to the desktop shell and must not reach this machine's disk)"
        );
    }
    if !model_sections_persistable(loaded, mirrored) {
        if !loaded {
            tracing::error!(
                "settings.json did not parse at startup; refusing to rewrite models/providers/defaultModel (would erase user data)"
            );
        }
        let _ = std::fs::create_dir_all(&home);
        let _ = std::fs::write(&path, serde_json::to_string_pretty(&v).unwrap_or_default());
        return true;
    }

    obj.insert("defaultModel".into(), serde_json::json!(settings.default_model));

    // Per-model **merge**, not replacement. The previous code rebuilt every
    // model object from a fixed field list, which silently dropped:
    //   - `description` (modelled in `ModelConfig` but absent from the list);
    //   - fields this kernel does not model at all but the Java kernel does —
    //     `userAgent`, `uid`, `capabilities`, `contextLength`, `proxy`,
    //     `defaultAutoToolCall`, `defaultToolContext`, `defaultOptions`.
    // Both kernels share one settings.json, so any save here used to erase
    // configuration the user had made through the Java kernel.
    //
    // Insertion order is preserved twice over: `settings.models` is an
    // IndexMap, and serde_json's `preserve_order` feature keeps the on-disk
    // Map ordered. The frontend groups the model picker by "provider changed
    // vs previous entry", so a re-sort would shatter 3 providers into ~96
    // alternating group headers.
    let existing_models = obj
        .get("models")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let mut models_map = serde_json::Map::new();
    for (k, m) in &settings.models {
        // Start from whatever is already on disk for this key, then overlay the
        // fields this kernel owns. Unknown siblings survive untouched.
        let mut entry = existing_models
            .get(k)
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();

        entry.insert("name".into(), serde_json::json!(m.name));
        entry.insert("enabled".into(), serde_json::json!(m.enabled));
        entry.insert("visibled".into(), serde_json::json!(m.visibled));
        entry.insert("scope".into(), serde_json::json!(m.scope));
        entry.insert("apiUrl".into(), serde_json::json!(m.api_url));
        entry.insert("apiKey".into(), serde_json::json!(m.api_key));
        entry.insert("standard".into(), serde_json::json!(m.standard));
        entry.insert("provider".into(), serde_json::json!(m.provider));
        entry.insert("model".into(), serde_json::json!(m.model));
        entry.insert("headers".into(), serde_json::json!(m.headers));
        entry.insert("timeout".into(), serde_json::json!(m.timeout));
        // Only write `description` when set: an empty string here would
        // overwrite a real description with a blank one on every save.
        if !m.description.trim().is_empty() {
            entry.insert("description".into(), serde_json::json!(m.description));
        }

        models_map.insert(k.clone(), serde_json::Value::Object(entry));
    }
    obj.insert("models".into(), serde_json::Value::Object(models_map));

    let _ = std::fs::create_dir_all(&home);
    match std::fs::write(&path, serde_json::to_string_pretty(&v).unwrap_or_default()) {
        Ok(()) => true,
        Err(e) => {
            tracing::error!(error = %e, path = %path.display(), "failed to write settings.json");
            false
        }
    }
}

/// Re-read settings.json into the in-memory `AppState`.
///
/// **Why this exists.** Two families of handlers write settings.json:
///   - the `llm/models/*` and `general|permission/save` handlers mutate
///     `state.settings` first and then call [`persist_settings`], which
///     serialises that in-memory struct back over the `models` /
///     `defaultModel` / `general` / `permission` sections;
///   - the `providers/*` handlers (add/update/remove/toggle/sync-models) work
///     directly on the raw JSON on disk, because a provider owns fields this
///     kernel does not model (`userAgent`, `uid`, `capabilities`, `proxy`, ...).
///
/// Without a reload the second family's changes are invisible to the first:
/// deleting a provider cascades its models out of the file, but the stale
/// in-memory table still holds them, so the next `general/save` writes them
/// straight back — resurrecting models together with the deleted provider's
/// API key. Disk is therefore the single source of truth, and every
/// disk-only mutation must be followed by this call.
///
/// A parse failure deliberately leaves the in-memory copy untouched: replacing
/// it with `Settings::default()` would empty `models`, and `persist_settings`
/// would then treat the empty table as authoritative (its destructive-write
/// guard keys off `settings_loaded`, which stays true from startup).
pub(crate) async fn reload_settings_from_disk(state: &Arc<AppState>) {
    match Settings::load_default() {
        Ok(fresh) => {
            let mut guard = state.settings.write().await;
            *guard = fresh;
        }
        Err(e) => {
            tracing::error!(error = %e, "settings.json reload failed after a disk-only write; keeping the previous in-memory copy");
        }
    }
}

/// Overwrite only the keys present in `patch`, leaving sibling keys untouched.
fn merge_section(obj: &mut serde_json::Map<String, serde_json::Value>, key: &str, patch: serde_json::Value) {
    let entry = obj
        .entry(key.to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !entry.is_object() {
        *entry = serde_json::json!({});
    }
    let Some(target) = entry.as_object_mut() else { return };
    let Some(src) = patch.as_object() else { return };
    for (k, val) in src {
        target.insert(k.clone(), val.clone());
    }
}

async fn settings_permission(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let settings = state.settings.read().await;
    Json(serde_json::json!({
        "code": 200,
        "data": {
            "tools": settings.permission.tools,
            "disallowedTools": settings.permission.disallowed_tools,
            "bashExemptDirs": settings.permission.bash_exempt_dirs,
        }
    }))
}

/// Body of `POST /web/settings/permission/save`.
///
/// JSON with **array** fields. The previous form-shaped port had three separate
/// defects, all silent:
///   - `Form<...>` → HTTP 415 on every save (frontend sends `application/json`);
///   - fields typed `Option<String>` (comma-separated) while the frontend sends
///     real JSON arrays, so even a form post would have parsed to nothing;
///   - `bashExemptDirs` was missing entirely, so the bash approval exemptions
///     configured in the UI could never be saved (or cleared);
///   - nothing was persisted, so a restart reverted the whole panel.
#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct PermissionSaveBody {
    /// Accepted for wire compatibility but deliberately **not applied**.
    ///
    /// The frontend always sends `tools: ["**"]`. Writing it would silently widen
    /// permissions for anyone who had narrowed `permission.tools` in
    /// settings.json. The Java kernel ignores this key too, so ignoring it here
    /// is both faithful and the safer default.
    tools: Option<Vec<String>>,
    #[serde(rename = "disallowedTools")]
    disallowed_tools: Option<Vec<String>>,
    #[serde(rename = "bashExemptDirs")]
    bash_exempt_dirs: Option<Vec<String>>,
}

/// POST /web/settings/permission/save
///
/// Update semantics mirror the Java kernel exactly, because the frontend is
/// written against them:
///   - `disallowedTools`: **always replaced**. An absent key means "no tools are
///     disallowed", so the list is cleared — this is a full-replace field.
///   - `bashExemptDirs`: replaced **only when the key is present**. The panel
///     submits partial payloads from other entry points, and clearing exemptions
///     on an unrelated save would silently re-enable approval prompts (or worse,
///     drop directories the user relies on). The UI therefore always sends this
///     key explicitly when the user edits it, including sending `[]` to clear.
async fn settings_permission_save(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PermissionSaveBody>,
) -> Json<serde_json::Value> {
    let _ = &body.tools; // see doc: accepted, not applied
    {
        let mut settings = state.settings.write().await;
        settings.permission.disallowed_tools = clean_strings(body.disallowed_tools);
        if let Some(dirs) = body.bash_exempt_dirs {
            settings.permission.bash_exempt_dirs = clean_strings(Some(dirs));
        }
    }
    if persist_settings(&state).await {
        Json(serde_json::json!({"code": 200}))
    } else {
        Json(serde_json::json!({
            "code": 500,
            "msg": "settings.json 无法解析或写入失败，本次保存未落盘。",
            "message": "settings.json 无法解析或写入失败，本次保存未落盘。"
        }))
    }
}

/// Trim, drop empties and de-duplicate a submitted string list (preserving order).
fn clean_strings(v: Option<Vec<String>>) -> Vec<String> {
    let Some(v) = v else { return Vec::new() };
    let mut seen = std::collections::HashSet::new();
    v.into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && seen.insert(s.clone()))
        .collect()
}

// ─── LLM model CRUD endpoints ─────────────────────────────────────────────────

async fn settings_llm_models(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let settings = state.settings.read().await;
    // Settings panel only: the FULL model table including disabled entries, so
    // the UI can render switch states. Order is settings order (not sorted),
    // matching the chat/automation pickers.
    let list: Vec<serde_json::Value> = settings
        .models
        .values()
        .map(|m| {
            serde_json::json!({
                "name": m.name_or_model(),
                "model": m.model,
                "standard": m.standard_or_provider(),
                "apiUrl": m.api_url,
                // Masked, never plaintext: rendering only needs "is a key set"
                // and its rough shape. Java's putMaskedApiKey does the same, and
                // its comment records that returning plaintext here used to
                // contradict the providers endpoint.
                "apiKey": settings_api::mask_api_key(&m.api_key),
                "hasKey": !m.api_key.is_empty(),
                "enabled": m.enabled,
                "visibled": m.visibled,
                "scope": m.scope,
                "provider": m.provider,
                "timeout": m.timeout,
            })
        })
        .collect();

    // `effectiveDefault` is what the frontend actually reads
    // (app-model-settings.js: `llmDefaultModel = res.data.effectiveDefault`)
    // to draw the header hint and the "default" star. Returning a bare array —
    // as this handler used to — left it undefined, so the star never lit up.
    // Same resolution as /web/chat/models' `selected`: defaultModel when it still
    // points at a live model, else the first enabled one.
    let effective_default = settings
        .default_model_config()
        .map(|m| m.name_or_model())
        .unwrap_or_default();

    Json(serde_json::json!({
        "code": 200,
        "data": {
            "list": list,
            "default": settings.default_model,
            "effectiveDefault": effective_default,
        }
    }))
}

#[derive(serde::Deserialize)]
struct ModelGetQuery {
    #[serde(default)]
    name: String,
}

async fn settings_llm_model_get(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ModelGetQuery>,
) -> Json<serde_json::Value> {
    let settings = state.settings.read().await;
    match settings.models.get(&q.name) {
        Some(m) => Json(serde_json::json!({
            "code": 200,
            "data": {
                "name": m.name_or_model(),
                "enabled": m.enabled,
                "visibled": m.visibled,
                "scope": m.scope,
                "apiUrl": m.api_url,
                // MASKED. This endpoint feeds the edit form, and the form does
                // not prefill secrets — it submits `apiKey` only when the user
                // actually typed one. Returning the plaintext key here would be
                // read back as a real value and re-submitted, and it puts every
                // stored secret on the wire to the renderer. Java masks this
                // endpoint for exactly that reason (`putMaskedApiKey`).
                "apiKey": settings_api::mask_api_key(&m.api_key),
                "hasKey": !m.api_key.is_empty(),
                "standard": m.standard_or_provider(),
                "provider": m.provider,
                "model": m.model,
                "headers": m.headers,
                "timeout": m.timeout,
                "isDefault": settings.default_model == m.name_or_model(),
            }
        })),
        None => Json(serde_json::json!({"code": 404, "description": "Model not found"})),
    }
}

#[derive(serde::Deserialize, Default)]
struct ModelAddForm {
    #[serde(default)]
    name: String,
    #[serde(rename = "apiUrl", default)]
    api_url: String,
    #[serde(rename = "apiKey", default)]
    api_key: String,
    #[serde(default)]
    standard: String,
    #[serde(default)]
    provider: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    timeout: String,
}

async fn settings_llm_model_add(
    State(state): State<Arc<AppState>>,
    Form(form): Form<ModelAddForm>,
) -> Json<serde_json::Value> {
    if form.model.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "model is required"}));
    }
    let name = if form.name.is_empty() { form.model.clone() } else { form.name.clone() };
    let mut settings = state.settings.write().await;
    let mc = crate::config::ModelConfig {
        name: name.clone(),
        enabled: true,
        visibled: true,
        scope: "user".into(),
        api_url: form.api_url,
        api_key: form.api_key,
        standard: if form.standard.is_empty() { "openai".into() } else { form.standard },
        provider: form.provider,
        model: form.model,
        description: String::new(),
        headers: std::collections::HashMap::new(),
        timeout: if form.timeout.is_empty() { "120".into() } else { form.timeout },
    };
    settings.models.insert(name.clone(), mc);
    drop(settings);
    if !save_settings_full(&state).await {
        return Json(serde_json::json!({"code": 500, "msg": "settings.json 写入失败，模型未落盘。", "message": "settings.json 写入失败，模型未落盘。"}));
    }
    Json(serde_json::json!({"code": 200, "data": {"name": name}}))
}

#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct ModelNameForm {
    #[serde(default)]
    name: String,
}

async fn settings_llm_model_remove(
    State(state): State<Arc<AppState>>,
    Form(form): Form<ModelNameForm>,
) -> Json<serde_json::Value> {
    let mut settings = state.settings.write().await;
    // `shift_remove`, not `remove`: IndexMap's `remove` is an alias for
    // `swap_remove`, which moves the *last* entry into the vacated slot. That
    // reorders the model table, and the frontend groups the picker by
    // "provider changed vs previous entry" — one swap can split a provider
    // block in two. Java's `AgentSettings.removeModel` documents the same
    // invariant ("其余模型相对顺序不变").
    if settings.models.shift_remove(&form.name).is_some() {
        // Repair dangling references, mirroring Java's
        // `AgentSettings.repairRemovedModelReferences`. Without this the
        // deleted model stays selected as the default: the picker then
        // highlights nothing (the name is no longer in the list) and the next
        // turn falls back to an arbitrary model.
        if settings.default_model == form.name {
            settings.default_model = settings
                .models
                .iter()
                .find(|(_, m)| m.enabled)
                .map(|(k, _)| k.clone())
                .unwrap_or_default();
        }
        if settings.general.acp_model.as_deref() == Some(form.name.as_str()) {
            settings.general.acp_model = None;
        }
        drop(settings);
        if (!save_settings_full(&state).await) {
            return Json(serde_json::json!({"code": 500, "msg": "settings.json 写入失败，本次修改未落盘。", "message": "settings.json 写入失败，本次修改未落盘。"}));
        }
        Json(serde_json::json!({"code": 200}))
    } else {
        Json(serde_json::json!({"code": 404, "description": "Model not found"}))
    }
}

#[derive(serde::Deserialize, Default)]
struct ModelUpdateForm {
    #[serde(default)]
    name: String,
    #[serde(rename = "apiUrl")]
    api_url: Option<String>,
    #[serde(rename = "apiKey")]
    api_key: Option<String>,
    standard: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    timeout: Option<String>,
}

async fn settings_llm_model_update(
    State(state): State<Arc<AppState>>,
    Form(form): Form<ModelUpdateForm>,
) -> Json<serde_json::Value> {
    let mut settings = state.settings.write().await;
    if let Some(m) = settings.models.get_mut(&form.name) {
        if let Some(v) = form.api_url { m.api_url = v; }
        // Guard the masked value. `llm/models/get` returns `sk-a****wxyz`, and a
        // client that prefills its form from that response would submit the mask
        // back — silently replacing the real secret with a string that can never
        // authenticate. The frontend is written not to do this (it submits
        // `apiKey` only when the user actually typed), but the kernel must not
        // depend on every client being correct about a secret.
        if let Some(v) = form.api_key {
            if !is_masked_key(&v) {
                m.api_key = v;
            }
        }
        if let Some(v) = form.standard { m.standard = v; }
        if let Some(v) = form.provider { m.provider = v; }
        if let Some(v) = form.model { m.model = v; }
        if let Some(v) = form.timeout { m.timeout = v; }
        drop(settings);
        if (!save_settings_full(&state).await) {
            return Json(serde_json::json!({"code": 500, "msg": "settings.json 写入失败，本次修改未落盘。", "message": "settings.json 写入失败，本次修改未落盘。"}));
        }
        Json(serde_json::json!({"code": 200}))
    } else {
        Json(serde_json::json!({"code": 404, "description": "Model not found"}))
    }
}

/// Whether a submitted key is a masked echo rather than a real secret.
///
/// `mask_api_key` produces either `""`, `"****"`, or `<4>****<4>`, so the
/// `****` run is the reliable tell. A genuine key containing four literal
/// asterisks is not a shape any provider issues.
fn is_masked_key(v: &str) -> bool {
    v.contains("****")
}

#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct ModelToggleForm {
    #[serde(default)]
    name: String,
    /// Absent stays `None`, which the handler reads as "flip the stored value".
    /// `serde_urlencoded` parses `"true"`/`"false"` into this bool directly.
    #[serde(default)]
    enabled: Option<bool>,
}

/// POST /web/settings/llm/models/toggle
///
/// `FlexBody`, not `Form`: the frontend's `postJson` sends
/// `Content-Type: application/json`, which axum's `Form` rejects with 415 —
/// surfacing in the UI as a generic "network error" toast on the enable/disable
/// switch. See `flex_body` for the full rationale.
async fn settings_llm_model_toggle(
    State(state): State<Arc<AppState>>,
    FlexBody(form): FlexBody<ModelToggleForm>,
) -> Json<serde_json::Value> {
    let mut settings = state.settings.write().await;
    if let Some(m) = settings.models.get_mut(&form.name) {
        m.enabled = form.enabled.unwrap_or(!m.enabled);
        drop(settings);
        if (!save_settings_full(&state).await) {
            return Json(serde_json::json!({"code": 500, "msg": "settings.json 写入失败，本次修改未落盘。", "message": "settings.json 写入失败，本次修改未落盘。"}));
        }
        Json(serde_json::json!({"code": 200}))
    } else {
        Json(serde_json::json!({"code": 404, "description": "Model not found"}))
    }
}

/// POST /web/settings/llm/models/default — "set as default model".
///
/// Same 415 trap as `settings_llm_model_toggle`; this is the endpoint behind
/// the user-reported "error when selecting the default model".
async fn settings_llm_model_default(
    State(state): State<Arc<AppState>>,
    FlexBody(form): FlexBody<ModelNameForm>,
) -> Json<serde_json::Value> {
    let mut settings = state.settings.write().await;
    if settings.models.contains_key(&form.name) {
        settings.default_model = form.name.clone();
        drop(settings);
        save_default_model(&form.name);
        Json(serde_json::json!({"code": 200}))
    } else {
        Json(serde_json::json!({"code": 404, "description": "Model not found"}))
    }
}

/// Persist settings after a model-CRUD change.
///
/// Delegates to `persist_settings` so there is exactly one writer for
/// settings.json. Two near-identical savers is how the old code ended up with
/// `permission/save` persisting nothing while `general/save` persisted a subset.
///
/// `must_use`: every model-CRUD endpoint answers 200 unconditionally, so a
/// failed disk write must surface in the response body instead of vanishing.
#[must_use = "a failed save must reach the HTTP response, not vanish"]
async fn save_settings_full(state: &Arc<AppState>) -> bool {
    persist_settings(state).await
}

// ─── WebSocket gate ───────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct GateQuery {
    #[serde(rename = "sessionId", default)]
    session_id: String,
}

async fn ws_gate(
    ws: WebSocketUpgrade,
    Query(q): Query<GateQuery>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, q.session_id, state))
}

async fn handle_ws(socket: WebSocket, session_id: String, state: Arc<AppState>) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (frame_tx, mut frame_rx) = mpsc::unbounded_channel::<Frame>();

    // Register client
    let key = if session_id.is_empty() {
        "*".to_string()
    } else {
        session_id.clone()
    };
    state
        .ws_clients
        .lock()
        .await
        .entry(key.clone())
        .or_default()
        .push(frame_tx.clone());

    use futures_util::{SinkExt, StreamExt};

    let send_task = tokio::spawn(async move {
        while let Some(frame) = frame_rx.recv().await {
            let json = frame.to_json();
            if ws_tx.send(Message::Text(json)).await.is_err() {
                break;
            }
        }
    });

    // Read loop: handle ping/pong and close
    while let Some(msg) = ws_rx.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                if text.trim() == "ping" || text.contains("\"type\":\"ping\"") {
                    // Heartbeat — no action needed
                }
            }
            Ok(Message::Close(_)) => break,
            Err(_) => break,
            _ => {}
        }
    }

    // Cleanup: remove this client's sender from the registry
    send_task.abort();
    {
        let mut clients = state.ws_clients.lock().await;
        if let Some(senders) = clients.get_mut(&key) {
            senders.retain(|tx| !tx.is_closed());
            if senders.is_empty() {
                clients.remove(&key);
            }
        }
    }
}

// ─── WebSocket terminal gateway ───────────────────────────────────

#[derive(serde::Deserialize)]
struct TerminalQuery {
    #[serde(rename = "sessionId", default)]
    session_id: String,
}

async fn ws_terminal(
    ws: WebSocketUpgrade,
    Query(q): Query<TerminalQuery>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws_terminal(socket, q.session_id, state))
}

async fn handle_ws_terminal(socket: WebSocket, session_id: String, state: Arc<AppState>) {
    use futures_util::{SinkExt, StreamExt};

    let term_id = if session_id.is_empty() {
        format!("term-{}", &uuid::Uuid::new_v4().to_string()[..8])
    } else {
        session_id.clone()
    };

    // Spawn the shell if not already running
    {
        let already = state.terminal_registry.has_session(&term_id).await;
        if !already {
            if state.terminal_registry.spawn(&term_id, &state.workspace).await.is_err() {
                return;
            }
        }
    }

    // Subscribe to the session's output. Each WS connection gets its own
    // receiver, so a reconnect neither steals nor duplicates the stream.
    let mut output_rx = match state.terminal_registry.subscribe(&term_id).await {
        Some(rx) => rx,
        None => return,
    };

    let (mut ws_tx, mut ws_rx) = socket.split();

    // Forward shell output → WS
    let out_task = tokio::spawn(async move {
        while let Some(chunk) = output_rx.recv().await {
            let payload = serde_json::json!({"type": "output", "data": chunk}).to_string();
            if ws_tx.send(Message::Text(payload)).await.is_err() {
                break;
            }
        }
    });

    // WS input → shell stdin
    while let Some(msg) = ws_rx.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                // Input protocol: {"type":"input","data":"..."} or raw line
                let line = if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                    v.get("data").and_then(|d| d.as_str()).unwrap_or("").to_string()
                } else {
                    text
                };
                if !state.terminal_registry.write(&term_id, &line).await {
                    break;
                }
            }
            Ok(Message::Close(_)) => break,
            Err(_) => break,
            _ => {}
        }
    }

    out_task.abort();
    // Deliberately do NOT close the session here: the shell outlives a single WS
    // connection so a page refresh reconnects to the same live shell instead of
    // spawning a new one (which is what produced the duplicated prompts).
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── access-mode precedence (picker and run path must agree) ─────────────

    #[test]
    fn access_mode_explicit_wins_over_everything() {
        assert_eq!(resolve_access_mode("full", Some("default"), Some("default")), "full");
        assert_eq!(resolve_access_mode("default", Some("full"), Some("full")), "default");
    }

    #[test]
    fn access_mode_live_override_beats_persisted() {
        assert_eq!(resolve_access_mode("", Some("full"), Some("default")), "full");
        assert_eq!(resolve_access_mode("", Some("default"), Some("full")), "default");
    }

    #[test]
    fn access_mode_persisted_survives_a_restart_with_no_field() {
        // The regression this locks: after a kernel restart the in-memory map is
        // empty and a client that omits the field must still get the persisted
        // tier — otherwise the picker (which echoes persistence) shows "full"
        // while the run gates as "default".
        assert_eq!(resolve_access_mode("", None, Some("full")), "full");
    }

    #[test]
    fn access_mode_empty_and_garbage_fall_through() {
        assert_eq!(resolve_access_mode("", Some(""), Some("")), "default");
        assert_eq!(resolve_access_mode("FULL", None, None), "default", "case-sensitive like the frontend normalizeMode");
        assert_eq!(resolve_access_mode("", Some("bogus"), Some("full")), "full", "garbage live tier must not mask a good persisted one");
        assert_eq!(resolve_access_mode("bogus", Some("bogus"), None), "default");
    }

    // ── event-seq resume watermark (kernel restart) ────────────────────────
    //
    // The end-to-end proof of this fix (kill the kernel mid-history, reboot,
    // assert the next run's frames clear the frontend cursor) lives outside
    // the repo; these are the in-repo teeth so a revert of the seed line can
    // never ship green again.

    /// The seed must sit exactly one above the persisted watermark: at or
    /// below it the frontend gate silently drops the frame, and the watermark
    /// itself would re-issue a seq the stream file already carries.
    #[test]
    fn seq_seed_is_one_above_the_persisted_watermark() {
        assert_eq!(seed_from_watermark(41), 42);
        assert_eq!(seed_from_watermark(0), 1);
        assert_eq!(seed_from_watermark(1_000_000), 1_000_001);
    }

    /// An absent or empty stream file reads as -1, so a brand-new session
    /// still starts at seq 0 — the fresh-conversation behaviour must not move.
    #[test]
    fn seq_seed_of_an_empty_or_absent_stream_is_zero() {
        assert_eq!(seed_from_watermark(-1), 0);
    }

    /// Directional invariant across the whole input range: the first handed
    /// out seq may never replay a persisted one.
    #[test]
    fn seq_seed_never_replays_a_persisted_seq() {
        for watermark in [-1i64, 0, 1, 7, 42, 999_999] {
            assert!(
                seed_from_watermark(watermark) > watermark,
                "watermark {watermark} must seed strictly above itself"
            );
        }
    }

    /// Wiring guard: the behavioural tests above pin the free function, this
    /// one pins that `seq_for` still routes new counters through it (a revert
    /// to `AtomicI64::new(0)` inside `seq_for` would otherwise stay green).
    #[test]
    fn seq_for_seeds_through_the_watermark_helper() {
        let src = include_str!("mod.rs");
        let start = src.find("pub async fn seq_for").expect("seq_for missing");
        let end = src[start..]
            .find("async fn is_busy")
            .expect("is_busy boundary missing");
        let body = &src[start..start + end];
        assert!(
            body.contains("seed_from_watermark(watermark)"),
            "seq_for must seed new counters through seed_from_watermark"
        );
        assert!(
            body.contains("max_stream_seq"),
            "seq_for must read the persisted watermark before seeding"
        );
        assert!(
            body.contains("read_issued_seq"),
            "seq_for must also read the issued watermark: transient and slash \
             frames advance the frontend cursor without reaching the stream file"
        );
        // The double-checked lock is concurrency-correctness, not decoration:
        // the scan runs outside the lock, so a concurrent creator can win the
        // race and the loser must adopt its counter — two live counters for
        // one session would hand out duplicate seqs. A behavioural test would
        // need a filesystem race, so the re-check is pinned by shape here.
        assert_eq!(
            body.matches("counters.get(session_id)").count(),
            1,
            "the post-scan adopt re-check inside the lock must survive"
        );
        // The issued-mark recorder is what closes the restart-without-reload
        // window; dropping its call from the broadcast path would leave the
        // seed blind to transient frames again.
        let bstart = src
            .find("pub(crate) async fn broadcast_frame")
            .expect("broadcast_frame missing");
        let bend = src[bstart..]
            .find("POST /web/chat/interrupt")
            .expect("interrupt boundary missing");
        let bbody = &src[bstart..bstart + bend];
        assert!(
            bbody.contains("record_issued_seq"),
            "broadcast_frame must record the issued high-water mark"
        );
    }

    // ── /web/chat/todos parsing (Java `WebController.todos` parity) ──────────

    /// Panel-vs-tool parity, the divergence users actually saw: `todowrite`
    /// reported one count while the task panel rendered another for the same
    /// file. Both read this file, so a checklist must yield identical tallies.
    /// `crate::todo::measure` is the tool-side rule, `parse_todo_items` the
    /// panel-side one; they are deliberately not the same parser (see the
    /// `todo.rs` module docs), so the agreement is asserted rather than assumed.
    #[test]
    fn todo_panel_and_tool_agree_on_a_normal_checklist() {
        let md = "## 组\n- [x] A\n- [ ] B\n\nprose\n- [/] C\n";
        let (items, stats) = parse_todo_items(md);
        assert_eq!(3, items.len(), "{:?}", items);
        assert_eq!(3, stats["total"]);
        assert_eq!(1, stats["pending"]);
        assert_eq!(1, stats["inProgress"]);
        assert_eq!(1, stats["done"]);

        let tool = crate::todo::measure(md);
        assert_eq!(3, tool.total);
        assert_eq!(1, tool.pending);
        assert_eq!(1, tool.in_progress);
        assert_eq!(1, tool.done);
    }

    /// The panel endpoint and the resume-calibration injection must both
    /// self-heal stored envelopes: without them an old session keeps showing
    /// the "malformed" panel state (and calibrating to nothing) forever,
    /// because nothing on the read path ever repairs the file.
    #[test]
    fn read_paths_heal_stored_json_envelopes() {
        let src = include_str!("mod.rs");
        let endpoint = src
            .find("async fn chat_todos")
            .expect("chat_todos handler missing");
        let parser = src[endpoint..]
            .find("fn parse_todo_items(content: &str)")
            .expect("parse_todo_items missing after the handler");
        let endpoint_body = &src[endpoint..endpoint + parser];
        assert!(
            endpoint_body.contains("heal_content"),
            "chat_todos no longer heals stored envelopes; old sessions would render malformed forever"
        );

        let calib = src
            .find("TODO resume calibration (Java")
            .expect("resume calibration block missing");
        let calib_end = src[calib..]
            .find("Create frame channel")
            .expect("calibration block end missing");
        let calib_body = &src[calib..calib + calib_end];
        assert!(
            calib_body.contains("heal_content"),
            "resume calibration no longer heals stored envelopes"
        );
    }

    /// A JSON envelope parses to nothing on **both** sides — which is precisely
    /// why normalising must happen on the way in, at `todowrite`, rather than
    /// being patched over in this endpoint.
    #[test]
    fn todo_panel_also_sees_zero_tasks_in_a_json_envelope() {
        let dirty = "[{\"content\": \"A\", \"status\": \"done\"}]";
        assert!(parse_todo_items(dirty).0.is_empty());
        assert_eq!(0, crate::todo::count_checkbox_lines(dirty));
        // And after the tool sanitises it, the panel sees the real count.
        let repaired = crate::todo::sanitize_todo_markdown(
            "[{\"todos\": \"- [x] A\\n- [ ] B\"}]",
        );
        assert_eq!(2, parse_todo_items(&repaired).0.len());
    }

    #[test]
    fn todo_parser_counts_all_four_states() {
        let md = "- [ ] todo one\n- [/] doing\n- [x] done lower\n- [X] done upper\n";
        let (items, stats) = parse_todo_items(md);
        assert_eq!(items.len(), 4);
        assert_eq!(stats["total"], 4);
        assert_eq!(stats["pending"], 1);
        assert_eq!(stats["inProgress"], 1);
        assert_eq!(stats["done"], 2, "both [x] and [X] count as done");
    }

    #[test]
    fn todo_parser_maps_each_state_name() {
        let (items, _) = parse_todo_items("- [ ] a\n- [/] b\n- [x] c\n");
        assert_eq!(items[0]["status"], "pending");
        assert_eq!(items[1]["status"], "in_progress");
        assert_eq!(items[2]["status"], "done");
    }

    #[test]
    fn todo_parser_strips_the_marker_from_text() {
        let (items, _) = parse_todo_items("- [x]   修复缺陷J   \n");
        assert_eq!(items[0]["text"], "修复缺陷J");
        assert_eq!(items[0]["raw"], "- [x]   修复缺陷J");
    }

    /// `line` is 1-based over the **whole document**, not over checkboxes only:
    /// the panel uses it to address the source row.
    #[test]
    fn todo_parser_reports_absolute_line_numbers() {
        let md = "# Title\n\nsome prose\n\n- [ ] first\n- [x] second\n";
        let (items, _) = parse_todo_items(md);
        assert_eq!(items[0]["line"], 5);
        assert_eq!(items[1]["line"], 6);
    }

    /// `## Heading` groups every checkbox below it until the next heading.
    #[test]
    fn todo_parser_tracks_groups() {
        let md = "## 第一阶段\n- [ ] a\n- [x] b\n## 第二阶段\n- [/] c\n";
        let (items, _) = parse_todo_items(md);
        assert_eq!(items[0]["group"], "第一阶段");
        assert_eq!(items[1]["group"], "第一阶段");
        assert_eq!(items[2]["group"], "第二阶段");
    }

    #[test]
    fn todo_parser_leaves_group_empty_before_any_heading() {
        let (items, _) = parse_todo_items("- [ ] orphan\n");
        assert_eq!(items[0]["group"], "");
    }

    /// `#` (h1) is not a group — only `##` is, matching the Java regex.
    #[test]
    fn todo_parser_only_treats_h2_as_a_group() {
        let (items, _) = parse_todo_items("# 顶层标题\n- [ ] a\n");
        assert_eq!(items[0]["group"], "");
    }

    #[test]
    fn todo_parser_ignores_non_checkbox_lines() {
        let md = "prose\n* not a checkbox\n- no bracket\n- [] empty marker\n- [ ] real\n";
        let (items, stats) = parse_todo_items(md);
        assert_eq!(items.len(), 1, "only the well-formed checkbox is parsed");
        assert_eq!(items[0]["text"], "real");
        assert_eq!(stats["total"], 1);
    }

    /// An indented checkbox is still a checkbox (nested list items).
    #[test]
    fn todo_parser_accepts_indented_checkboxes() {
        let (items, stats) = parse_todo_items("  - [ ] nested\n\t- [x] tabbed\n");
        assert_eq!(items.len(), 2);
        assert_eq!(stats["total"], 2);
    }

    /// The frontend's `malformed` state depends on this: a file with content but
    /// no parseable checkbox yields zero items, so `exists && items.empty && raw`
    /// can be detected. Returning a fake item would hide the condition.
    #[test]
    fn todo_parser_on_unparseable_content_yields_empty_items() {
        let md = "这个文件不是清单格式\n只是普通段落\n";
        let (items, stats) = parse_todo_items(md);
        assert!(items.is_empty());
        assert_eq!(stats["total"], 0);
        assert_eq!(stats["pending"], 0);
    }

    #[test]
    fn todo_parser_on_empty_input_is_all_zero() {
        let (items, stats) = parse_todo_items("");
        assert!(items.is_empty());
        for key in ["total", "pending", "inProgress", "done"] {
            assert_eq!(stats[key], 0, "{} should be 0", key);
        }
    }

    // ── sessionId validation (Java `invalid_session` parity) ────────────────

    #[test]
    fn bad_session_ids_are_rejected() {
        for evil in ["../escape", "..\\escape", "a/b", "a\\b", "work-1/../../x", ".."] {
            let r = reject_bad_session_id(evil);
            assert!(r.is_some(), "{:?} should be rejected", evil);
            let body = r.unwrap().0;
            assert_eq!(body["code"], 400);
            assert_eq!(body["description"], "invalid_session");
        }
    }

    #[test]
    fn normal_session_ids_pass() {
        for ok in ["work-abc123", "work-mvpz8c0m", "sub-task-1", ""] {
            assert!(reject_bad_session_id(ok).is_none(), "{:?} should be accepted", ok);
        }
    }

    // ── API key masking ───────────────────────────────────────────────────────
    //
    // `llm/models` and `llm/models/get` used to return the stored key in
    // plaintext. Both now mask it, and `llm/models/update` refuses to write a
    // masked value back. These three tests lock that: without them a future
    // refactor could re-expose every stored secret and nothing would fail.

    #[test]
    fn mask_api_key_matches_the_java_rule() {
        use super::settings_api::mask_api_key;
        // Java `WebSettingsController.maskApiKey`: empty → "", len ≤ 8 → "****",
        // else first4 + "****" + last4.
        assert_eq!(mask_api_key(""), "");
        assert_eq!(mask_api_key("abc"), "****");
        assert_eq!(mask_api_key("12345678"), "****", "exactly 8 chars masks entirely");
        assert_eq!(mask_api_key("123456789"), "1234****6789", "9 chars shows 4+4");
        assert_eq!(mask_api_key("sk-abcdefghijklmnop"), "sk-a****mnop");
        // Non-ASCII must not panic or slice mid-character.
        assert_eq!(mask_api_key("密钥一二三四五六七八九"), "密钥一二****六七八九");
    }

    #[test]
    fn masked_key_is_never_written_back_over_a_real_secret() {
        // The shapes mask_api_key can produce.
        for masked in ["", "****", "sk-a****wxyz", "1234****6789"] {
            assert!(
                is_masked_key(masked) || masked.is_empty(),
                "{:?} must be recognised as a masked echo (empty is harmless: it clears the key)",
                masked
            );
        }
        // Real secrets must pass through untouched.
        for real in [
            "sk-proj-abc123def456",
            "ak_9f3c2b1a",
            "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
        ] {
            assert!(!is_masked_key(real), "{:?} is a real key and must be accepted", real);
        }
    }

    /// The guard must not be satisfiable by a key that merely *contains* the
    /// mask substring in a legitimate position — but four literal asterisks are
    /// not a shape any provider issues, so treating them as an echo is correct.
    /// This test documents that trade-off rather than leaving it implicit.
    #[test]
    fn mask_detection_keys_off_the_four_asterisk_run() {
        assert!(is_masked_key("****"));
        assert!(is_masked_key("abcd****wxyz"));
        assert!(!is_masked_key("abc***def"), "three asterisks is not the mask shape");
        assert!(!is_masked_key("sk-live-000000"));
    }

    // ── ask_user / HITL resume injection ─────────────────────────────────────

    #[test]
    fn resume_injects_the_real_answer_as_the_only_tool_result() {
        // Healthy snapshot: assistant declared ask_user, no result yet.
        let mut msgs = vec![ChatMessage::user("which option?")];
        inject_resume_result(&mut msgs, Some("call-ask"), "Q1: 全量根治\nQ2: 不要兼容旧帧");
        let results: Vec<_> = msgs
            .iter()
            .filter(|m| m.tool_call_id.as_deref() == Some("call-ask"))
            .collect();
        assert_eq!(results.len(), 1, "exactly one result per tool call");
        assert_eq!(results[0].content_text(), "Q1: 全量根治\nQ2: 不要兼容旧帧");
        assert!(!results[0].content_text().contains("中断"));
    }

    #[test]
    fn resume_replaces_a_legacy_interrupted_marker_instead_of_stacking_it() {
        // Snapshot written by the buggy kernel: the run-exit repair gate faked
        // an INTERRUPTED_MARKER result for the suspended call. The real answer
        // must replace it — two tool messages would make the model read the
        // cancellation notice first and discard the answer (work-mw205svw).
        let mut msgs = vec![
            ChatMessage::user("which option?"),
            ChatMessage::tool_result(
                "call-ask",
                "[该工具调用因任务中断/取消未执行完成，无输出结果。请勿直接重复执行同一调用]",
            ),
        ];
        inject_resume_result(&mut msgs, Some("call-ask"), "Q1: 全量根治\nQ2: 不要兼容旧帧");
        let results: Vec<_> = msgs
            .iter()
            .filter(|m| m.tool_call_id.as_deref() == Some("call-ask"))
            .collect();
        assert_eq!(results.len(), 1, "must not stack two results for one call");
        assert_eq!(results[0].content_text(), "Q1: 全量根治\nQ2: 不要兼容旧帧");
        assert!(!results[0].content_text().contains("中断"));
    }

    #[test]
    fn resume_without_call_id_falls_back_to_a_user_message() {
        let mut msgs: Vec<ChatMessage> = Vec::new();
        inject_resume_result(&mut msgs, None, "Q1: approved");
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].role, crate::llm::Role::User);
        assert_eq!(msgs[0].content_text(), "Q1: approved");
    }

    // ── suspension TTL ──────────────────────────────────────────────────────

    fn sp_created_at(created_at: i64) -> SuspensionPoint {
        SuspensionPoint {
            session_id: "work-ttl".into(),
            run_id: "run-1".into(),
            kind: "hitl".into(),
            next_seq: 1,
            access_mode: "default".into(),
            model_name: "m".into(),
            pending_command: Some("echo x".into()),
            action_id: Some("call-1".into()),
            pending_tool_call_id: Some("call-1".into()),
            messages_json: "[]".into(),
            created_at,
        }
    }

    #[test]
    fn suspension_expires_after_the_ttl() {
        let now = 1_700_000_000_000i64;
        // Just inside the window: still live.
        let fresh = sp_created_at(now - (SUSPENSION_TTL_MS - 1));
        assert!(!suspension_expired_at(&fresh, now), "under the TTL must stay live");
        // Exactly at the boundary: `age > TTL` is the rule, so equal is still live.
        let edge = sp_created_at(now - SUSPENSION_TTL_MS);
        assert!(!suspension_expired_at(&edge, now), "age == TTL is not yet expired");
        // One millisecond past: expired.
        let stale = sp_created_at(now - (SUSPENSION_TTL_MS + 1));
        assert!(suspension_expired_at(&stale, now), "age > TTL must expire");
        // A day-old approval is definitively expired.
        let day_old = sp_created_at(now - 25 * 60 * 60 * 1000);
        assert!(suspension_expired_at(&day_old, now));
    }

    #[test]
    fn a_clock_skewed_into_the_future_is_not_expired() {
        // A bad/skewed timestamp must not silently discard a live approval: a
        // negative age is treated as fresh, not expired.
        let now = 1_700_000_000_000i64;
        let future = sp_created_at(now + 60_000);
        assert!(!suspension_expired_at(&future, now), "future-dated must not expire");
    }

    #[test]
    fn ttl_is_one_day_in_milliseconds() {
        // Pin the constant: a typo (seconds vs millis) would either expire
        // everything instantly or never.
        assert_eq!(SUSPENSION_TTL_MS, 86_400_000);
    }

    // ─── Basic Auth settings wiring ────────────────────────────────────────
    //
    // These lock the three-way distinction in `GeneralSaveBody`: key absent /
    // key present-and-null / key present-with-value. Collapsing any two of them
    // produces a silent failure — a partial save from the appearance panel
    // would clear the password, or a clear request would be ignored.

    fn parse_general(json: &str) -> GeneralSaveBody {
        serde_json::from_str(json).expect("GeneralSaveBody must parse")
    }

    #[test]
    fn absent_auth_keys_leave_the_stored_credentials_alone() {
        // The appearance panel saves only `{"darkMode":true}`. If that wiped the
        // password, enabling dark mode would silently disable auth.
        let b = parse_general(r#"{"darkMode":true}"#);
        assert_eq!(b.web_auth_user, None, "absent key must be None, not Some(None)");
        assert_eq!(b.web_auth_pass, None);
        assert_eq!(b.dark_mode, Some(true));
    }

    #[test]
    fn explicit_null_clears_the_credential() {
        // Java's generalSave hand-checks `hasKey && isNull` for exactly this;
        // `bindTo` skips nulls so clearing would otherwise be impossible.
        let b = parse_general(r#"{"webAuthUser":null,"webAuthPass":null}"#);
        assert_eq!(b.web_auth_user, Some(None), "present-and-null must be Some(None)");
        assert_eq!(b.web_auth_pass, Some(None));
    }

    #[test]
    fn a_value_sets_the_credential() {
        let b = parse_general(r#"{"webAuthUser":"admin","webAuthPass":"s3cret"}"#);
        assert_eq!(b.web_auth_user, Some(Some("admin".to_string())));
        assert_eq!(b.web_auth_pass, Some(Some("s3cret".to_string())));
    }

    #[test]
    fn the_three_states_are_mutually_distinguishable() {
        // The whole point of Option<Option<String>>: no two of these may compare
        // equal, or the save handler cannot tell "don't touch" from "clear".
        let absent = parse_general(r#"{}"#).web_auth_pass;
        let nulled = parse_general(r#"{"webAuthPass":null}"#).web_auth_pass;
        let valued = parse_general(r#"{"webAuthPass":"x"}"#).web_auth_pass;
        assert_ne!(absent, nulled);
        assert_ne!(nulled, valued);
        assert_ne!(absent, valued);
    }

    #[test]
    fn blank_and_whitespace_credentials_are_treated_as_clearing() {
        // `BasicAuth::is_enforced` reads a blank half as "not configured", so
        // storing `""` would leave a key on disk that reads back as
        // configured-but-inert — the settings page would show auth as on while
        // the kernel enforced nothing.
        let a = guard::BasicAuth::from_settings(Some(""), Some("s3cret"));
        assert!(!a.is_enforced());
        let a = guard::BasicAuth::from_settings(Some("admin"), Some("   "));
        assert!(!a.is_enforced());
        // The save handler's `.filter(|s| !s.trim().is_empty())` turns these into
        // None, so nothing inert is persisted.
        let stored: Option<String> = Some("   ".to_string()).filter(|s| !s.trim().is_empty());
        assert_eq!(stored, None);
    }

    #[test]
    fn the_general_get_payload_never_carries_the_password() {
        // Java's `generalGet` returns the whole `GeneralGroupDo`, which
        // serialises `webAuthPass` in plaintext to anyone who can reach the
        // endpoint. This kernel masks `apiKey` for the same reason; the password
        // must not be echoed either.
        //
        // Asserted on the value the handler actually returns, not on source text:
        // a string search would pass while the real payload leaked, and would
        // also break on an unrelated rename.
        let mut s = Settings::default();
        s.general.web_auth_user = Some("admin".into());
        s.general.web_auth_pass = Some("s3cret".into());

        let payload = general_payload(&s);
        let data = payload.get("data").expect("payload must have data");

        // The page needs to know auth is on, and as whom.
        assert_eq!(data["webAuthEnabled"], serde_json::json!(true));
        assert_eq!(data["webAuthUser"], serde_json::json!("admin"));

        // The secret must appear nowhere in the response — not under its own key,
        // and not as a substring of any serialised value.
        assert!(data.get("webAuthPass").is_none(), "password key must be absent");
        let rendered = serde_json::to_string(&payload).unwrap();
        assert!(
            !rendered.contains("s3cret"),
            "password value must not appear anywhere in the response: {}",
            rendered
        );
    }

    #[test]
    fn web_auth_enabled_reflects_whether_auth_is_actually_enforced() {
        // The flag must track `is_enforced`, not merely "a username is set":
        // a half-configured pair enforces nothing, and telling the page auth is
        // on would hide the misconfiguration from the user.
        let cases = [
            (None, None, false),
            (Some("admin"), None, false),
            (None, Some("s3cret"), false),
            (Some("admin"), Some(""), false),
            (Some("admin"), Some("s3cret"), true),
        ];
        for (user, pass, expected) in cases {
            let mut s = Settings::default();
            s.general.web_auth_user = user.map(|v| v.to_string());
            s.general.web_auth_pass = pass.map(|v| v.to_string());
            let data = general_payload(&s);
            assert_eq!(
                data["data"]["webAuthEnabled"],
                serde_json::json!(expected),
                "user={:?} pass={:?}",
                user,
                pass
            );
            // The username is echoed for the form even when auth is off, so the
            // user can see and repair a half-configured pair.
            assert_eq!(
                data["data"]["webAuthUser"],
                serde_json::json!(user.unwrap_or_default())
            );
        }
    }

    // ─── resolve_run_workspace ───────────────────────────────────────────
    //
    // These guard the one line that decides where a run's tools operate. The
    // call site cannot be unit-tested (it needs a live provider), so the
    // decision was extracted; without these the function could be "simplified"
    // back to `project_root_of(&session_dir)` and every global session would
    // silently start running in `$HOME`.

    #[test]
    fn a_bound_session_runs_in_its_own_project() {
        let kernel = std::path::Path::new("/home/u/GWork");
        assert_eq!(
            resolve_run_workspace(Some("/srv/host/project-alpha"), kernel),
            std::path::PathBuf::from("/srv/host/project-alpha"),
            "绑定会话必须在自己项目里跑工具，而不是内核安装目录"
        );
    }

    #[test]
    fn an_unbound_session_runs_in_the_kernel_workspace_not_home() {
        let kernel = std::path::Path::new("/home/u/GWork");
        // The regression this pins: `project_root_of` on a global session's
        // directory yields `<harness_base>` (= `/home/u`), which would widen the
        // tool cwd and the HITL write boundary to the whole home directory.
        assert_eq!(resolve_run_workspace(None, kernel), kernel);
        assert_ne!(
            resolve_run_workspace(None, kernel),
            std::path::PathBuf::from("/home/u"),
            "全局会话不得落进家目录"
        );
    }

    #[test]
    fn a_blank_binding_is_treated_as_absent() {
        let kernel = std::path::Path::new("/home/u/GWork");
        // A hand-edited session-roots.json could hold an empty root.
        // `PathBuf::from("")` would resolve every relative tool path against the
        // process cwd — the least predictable answer available.
        for blank in ["", "   ", "\t"] {
            assert_eq!(
                resolve_run_workspace(Some(blank), kernel),
                kernel,
                "空白绑定 {:?} 必须视同未绑定",
                blank
            );
        }
    }

    #[test]
    fn the_remote_workspace_shape_resolves_to_the_remote_path() {
        // The concrete remote-deployed case: kernel launched by SSH exec, so its
        // own workspace is `$HOME`-ish, while the session belongs to a project
        // directory on that same remote host.
        let kernel = std::path::Path::new("/home/deploy");
        assert_eq!(
            resolve_run_workspace(Some("/home/deploy/work/api"), kernel),
            std::path::PathBuf::from("/home/deploy/work/api")
        );
    }

    /// **Wiring** contract: the run spawner must actually *use*
    /// [`resolve_run_workspace`], and must feed its result into `ReActConfig`.
    ///
    /// The unit tests above pin the function's behaviour, but they cannot see
    /// whether anything calls it. A caller that reverts to `state.workspace.clone()`
    /// keeps every one of them green while remote sessions silently run their
    /// tools in the kernel's install directory — the exact defect this resolution
    /// exists to prevent. This is the same shape as the sub-agent model-inheritance
    /// gap: guarding the value producer while leaving the consumer unguarded.
    ///
    /// Anchors are built with `concat!` and comments are stripped first, so this
    /// test's own source and the explanatory comment above the call site cannot
    /// satisfy it (the `include_str!` self-match trap).
    #[test]
    fn the_run_spawner_resolves_the_workspace_through_the_binding() {
        let src = strip_comments(&crate_src("src/server/mod.rs"));
        let body = fn_body(&src, "run_react_session");

        let call = ["resolve_run", "_workspace("].concat();
        assert!(
            body.contains(&call),
            "run_react_session 必须经 resolve_run_workspace 解析工作区，\
             否则远端会话会在内核安装目录里跑工具"
        );
        // The binding registry must be the input — that is what distinguishes a
        // bound project session from a global one.
        let bound = ["bound_root(&session", "_id)"].concat();
        assert!(
            body.contains(&bound),
            "工作区解析必须以会话绑定为输入"
        );

        // And the resolved value must reach the run config, not be dropped.
        let cfg_field = ["workspace: run_", "workspace"].concat();
        assert!(
            body.contains(&cfg_field),
            "ReActConfig.workspace 必须由解析结果填充"
        );
        // Negative: the spawner must not hand the kernel's own workspace to the
        // config directly (that is the pre-fix behaviour).
        let direct = ["workspace: state.work", "space.clone()"].concat();
        assert!(
            !body.contains(&direct),
            "不得把 state.workspace 直接交给 ReActConfig（绕过绑定解析）"
        );
    }

    /// The two derivations must stay distinguishable: `project_root_of` answers
    /// "which global area do skills/memory live in", `resolve_run_workspace`
    /// answers "where do tools run". Conflating them is the defect these tests
    /// exist to catch, so pin the divergence on the unbound case.
    #[test]
    fn project_root_and_run_workspace_diverge_for_global_sessions() {
        let harness_base = std::path::Path::new("/home/u");
        let session_dir = harness_base.join(".gwork").join("sessions").join("work-x");
        // Global-area lookups: `<harness_base>` is correct here.
        assert_eq!(project_root_of(&session_dir).as_deref(), Some(harness_base));
        // Run workspace: must NOT be `<harness_base>`.
        let kernel = harness_base.join("GWork");
        assert_eq!(resolve_run_workspace(None, &kernel), kernel);
        assert_ne!(
            resolve_run_workspace(None, &kernel),
            project_root_of(&session_dir).unwrap(),
            "两个推导在全局会话上必须给出不同答案"
        );
    }

    // ─── model_sections_persistable ────────────────────────────────────
    //
    // Both inputs guard a silent, unrecoverable loss. The call site cannot be
    // unit-tested (it needs a live AppState and writes the real settings.json),
    // so the decision was extracted — without these the guard could be
    // "simplified" to `if !loaded` and the remote mirror would start leaking the
    // desktop shell's apiKeys onto the remote machine's disk.

    #[test]
    fn model_sections_persist_only_on_a_good_load_without_a_mirror() {
        assert!(
            model_sections_persistable(true, false),
            "正常本地内核：必须能保存模型配置（否则设置页保存无效）"
        );
    }

    #[test]
    fn a_failed_load_blocks_the_model_sections() {
        assert!(
            !model_sections_persistable(false, false),
            "加载失败时内存模型表是空的，写回会抹掉用户真实配置"
        );
    }

    #[test]
    fn an_active_mirror_blocks_the_model_sections() {
        // The security-critical one: the mirrored table carries the desktop
        // shell's apiKeys. Writing it puts those secrets on the remote machine's
        // disk, where they outlive the connection that supplied them.
        assert!(
            !model_sections_persistable(true, true),
            "镜像态下绝不得把模型/供应商/默认模型写盘（apiKey 泄漏面）"
        );
    }

    #[test]
    fn both_blockers_together_still_block() {
        assert!(!model_sections_persistable(false, true));
    }

    /// Wiring pin for the P1-③ review finding: `persist_settings` must read the
    /// disk state through the shared three-state guard, not a private inline
    /// `unwrap_or_else(json!({}))`. The startup `settings_loaded` snapshot only
    /// covers corruption present at boot; a file damaged at *runtime* (external
    /// tool writing a BOM, truncation) parsed as an empty object here, and the
    /// save then erased `mcpServers`/`apiServers` and every other section the
    /// merge does not own. A guard read refuses that write instead.
    #[test]
    fn persist_settings_reads_through_the_three_state_guard() {
        let src = include_str!("mod.rs");
        let body = src
            .split_once("async fn persist_settings")
            .expect("persist_settings present")
            .1
            .split_once("// ── Destructive-write guard ─")
            .expect("persist body continues")
            .0;
        // The refusal arm must RETURN — falling through would merge into the
        // empty object and write it back, which is the exact erase this guard
        // exists to prevent. Assert on the arm body, not just the guard name
        // (a mutation that keeps the name but drops the return must fail).
        let arm = body
            .split_once("SettingsRead::Unreadable => {")
            .expect("the Unreadable arm must exist in persist_settings")
            .1
            .split_once("}")
            .expect("the arm must close")
            .0;
        assert!(
            arm.contains("return false;"),
            "the Unreadable arm must return without writing (persist_settings now \
             reports the refusal via its bool return); arm body: {arm}"
        );
        assert!(
            !body.contains("unwrap_or_else(|| serde_json::json!({}))"),
            "the empty-object fallback must not come back: a runtime-corrupted \
             file would be erased by the next save"
        );
    }

    #[test]
    fn general_patch_omits_auth_keys_when_the_load_failed() {
        // On a failed parse the in-memory credentials are None *because the load
        // failed*, not because the user has none. Writing that back would erase a
        // real password and leave the kernel serving with auth silently off — a
        // parse error turning into an unauthenticated kernel.
        let s = Settings::default();

        let ok = general_patch(&s, true);
        let obj = ok.as_object().unwrap();
        assert!(obj.contains_key("webAuthUser"), "a good load must round-trip credentials");
        assert!(obj.contains_key("webAuthPass"));
        // The keys this kernel has always owned are unaffected by the flag.
        assert!(obj.contains_key("autoRethink"));
        assert!(obj.contains_key("skillListingBudgetFraction"));

        let failed = general_patch(&s, false);
        let obj = failed.as_object().unwrap();
        assert!(
            !obj.contains_key("webAuthUser"),
            "a failed load must not write credentials (would erase the real ones)"
        );
        assert!(!obj.contains_key("webAuthPass"));
        // Everything else still persists: the user's save intent for those keys
        // is honoured, and they come from a struct with safe defaults.
        assert!(obj.contains_key("autoRethink"));
        assert!(obj.contains_key("locale"));
    }

    #[test]
    fn general_patch_carries_the_configured_credentials() {
        let mut s = Settings::default();
        s.general.web_auth_user = Some("admin".into());
        s.general.web_auth_pass = Some("s3cret".into());
        let obj = general_patch(&s, true);
        assert_eq!(obj["webAuthUser"], serde_json::json!("admin"));
        assert_eq!(obj["webAuthPass"], serde_json::json!("s3cret"));
    }

    #[test]
    fn cleared_credentials_persist_as_json_null() {
        // `None` must serialise to an explicit null, not be dropped: dropping it
        // would leave the old password on disk after the user cleared it, and
        // `merge_section` only overwrites keys that are present in the patch.
        let s = Settings::default();
        let obj = general_patch(&s, true);
        assert!(obj.get("webAuthUser").unwrap().is_null());
        assert!(obj.get("webAuthPass").unwrap().is_null());
    }

    // ── version single source of truth ─────────────────────────────────────

    /// Read a crate source file relative to `core/`.
    fn crate_src(rel: &str) -> String {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
        std::fs::read_to_string(&p)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", p.display()))
    }

    /// Slice out one function body by name (brace-matched, comment-blind is
    /// fine here: neither function contains a `{`/`}` inside a string literal).
    fn fn_body(src: &str, name: &str) -> String {
        let start = src
            .find(&format!("fn {name}"))
            .unwrap_or_else(|| panic!("fn {name} not found"));
        let open = src[start..].find('{').map(|i| start + i).expect("no body");
        let mut depth = 0usize;
        for (i, c) in src[open..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return src[open..=open + i].to_string();
                    }
                }
                _ => {}
            }
        }
        panic!("unbalanced braces in fn {name}");
    }

    /// Strip `//` and `/* */` comments while keeping string literals intact.
    ///
    /// The guards below scan for version literals, and the code they guard
    /// *documents* the old hardcoded value in a comment — scanning raw source
    /// made the guard fail on its own explanation. Same reason the JS guards
    /// run `codeOnly()` before asserting. Rust block comments nest, so depth is
    /// tracked. Char literals are not special-cased: a `'/'` still falls through
    /// to the ordinary branch because the next char is neither `/` nor `*`.
    fn strip_comments(src: &str) -> String {
        let mut out = String::with_capacity(src.len());
        let mut chars = src.chars().peekable();
        let mut in_str = false;
        while let Some(c) = chars.next() {
            if in_str {
                out.push(c);
                match c {
                    '\\' => {
                        if let Some(&n) = chars.peek() {
                            out.push(n);
                            chars.next();
                        }
                    }
                    '"' => in_str = false,
                    _ => {}
                }
                continue;
            }
            match c {
                '"' => {
                    in_str = true;
                    out.push(c);
                }
                '/' => match chars.peek() {
                    Some('/') => {
                        while let Some(&n) = chars.peek() {
                            if n == '\n' {
                                break;
                            }
                            chars.next();
                        }
                    }
                    Some('*') => {
                        chars.next();
                        let mut depth = 1usize;
                        while depth > 0 {
                            match chars.next() {
                                Some('/') if chars.peek() == Some(&'*') => {
                                    chars.next();
                                    depth += 1;
                                }
                                Some('*') if chars.peek() == Some(&'/') => {
                                    chars.next();
                                    depth -= 1;
                                }
                                Some(_) => {}
                                None => break,
                            }
                        }
                    }
                    _ => out.push(c),
                },
                _ => out.push(c),
            }
        }
        out
    }

    /// `strip_comments` is guard infrastructure: if it silently stopped
    /// stripping, every literal-scanning guard below would go permanently red
    /// (or, worse, be "fixed" by deleting the assertion). Pin its behaviour.
    #[test]
    fn strip_comments_drops_comments_but_keeps_string_contents() {
        let src = r#"
            // a line comment mentioning "version": "0.9.9"
            let url = "http://x/y";   // trailing
            /* block "version": "0.8.8" */
            /* nested /* inner */ outer */
            let keep = "version": "0.1.0";
        "#;
        let got = strip_comments(src);
        assert!(!got.contains("0.9.9"), "line comment survived: {got}");
        assert!(!got.contains("0.8.8"), "block comment survived: {got}");
        assert!(!got.contains("inner"), "nested block comment survived: {got}");
        assert!(!got.contains("trailing"), "trailing comment survived: {got}");
        // The `//` inside a string literal must NOT start a comment.
        assert!(got.contains("http://x/y"), "string literal was eaten: {got}");
        // Real code is preserved.
        assert!(got.contains("0.1.0"), "code was stripped: {got}");
    }

    /// `/web/chat/meta` must report the workspace version, not a literal.
    ///
    /// This is the regression guard for a real drift: the handler hardcoded
    /// `"version": "0.4.0-rust"` while Cargo.toml / tauri.conf.json /
    /// package.json all said 0.3.0, so the About panel and the installer
    /// filename disagreed and nothing failed loudly. `env!("CARGO_PKG_VERSION")`
    /// is resolved at compile time from `[workspace.package].version` (core sets
    /// `version.workspace = true`), so it cannot drift.
    #[test]
    fn chat_meta_reports_the_workspace_version_not_a_literal() {
        let body = strip_comments(&fn_body(&crate_src("src/server/mod.rs"), "chat_meta"));
        assert!(
            body.contains("env!(\"CARGO_PKG_VERSION\")"),
            "chat_meta must take its version from CARGO_PKG_VERSION, got:\n{body}"
        );
        // A re-hardcoded literal is exactly the drift this guards against.
        assert!(
            !body.contains("\"version\": \"0."),
            "chat_meta must not hardcode a version literal:\n{body}"
        );
        assert!(
            !body.contains("-rust"),
            "the -rust suffix was the drifted value; version must be plain semver:\n{body}"
        );
    }

    /// The MCP `initialize` handshake must identify itself with the workspace
    /// version, never a hardcoded literal.
    ///
    /// The clientInfo is built in exactly one place (`initialize_params`) and
    /// shared by every transport's handshake, so the invariant is "one derived
    /// literal, zero hardcoded". An earlier form of this test asserted *two*
    /// derived copies because connect and probe each spelled the handshake out;
    /// that pinned the duplication rather than the contract. Centralizing it is
    /// strictly better, so the count is now one — and the assertion also checks
    /// no transport bypasses the helper with its own literal.
    #[test]
    fn mcp_client_info_uses_the_workspace_version() {
        let src = strip_comments(&crate_src("src/mcp/mod.rs"));
        let literals = src.matches("\"version\": \"0.").count();
        assert_eq!(
            literals, 0,
            "mcp/mod.rs must not hardcode the client version; use env!(\"CARGO_PKG_VERSION\")"
        );
        let derived = src.matches("\"version\": env!(\"CARGO_PKG_VERSION\")").count();
        assert_eq!(
            derived, 1,
            "the clientInfo version must have a single source of truth (initialize_params), found {derived}"
        );
        // Every handshake path must go through that helper, or one could drift
        // back to a literal. stdio connect + streamable + sse = 3 call sites.
        let helper_calls = src.matches("initialize_params()").count();
        assert!(
            helper_calls >= 3,
            "all transport handshakes must call initialize_params(), found {helper_calls}"
        );
    }
    // ─── /web/chat/hints (completion list) ─────────────────────────────────

    /// The regression this endpoint was fixed for.
    ///
    /// The old handler returned four prompt *strings*. The frontend filters on
    /// `cmd.type` (`app-history.js:2739`), which is `undefined` on a string, so
    /// every entry was skipped and the `/` and `@` panels never opened. Each
    /// entry must therefore be an object carrying all three fields.
    #[test]
    fn hints_entries_are_objects_with_name_description_and_type() {
        let data = build_hints();
        assert!(!data.is_empty(), "an empty list leaves the panel closed");

        for entry in &data {
            assert!(
                entry.is_object(),
                "entries must be objects; a bare string has no .type and is filtered out: {entry}"
            );
            for field in ["name", "description", "type"] {
                assert!(
                    entry.get(field).and_then(|v| v.as_str()).is_some(),
                    "entry is missing the string field `{field}`: {entry}"
                );
            }
        }
    }

    /// `@` shows `subagent` and `/` shows `skill`; the panel is empty for a
    /// trigger whose type is absent. The built-in agents guarantee the `@` side
    /// is never empty, so that trigger is asserted unconditionally.
    #[test]
    fn hints_cover_the_types_the_two_triggers_filter_on() {
        let data = build_hints();

        let types: std::collections::HashSet<&str> =
            data.iter().filter_map(|e| e["type"].as_str()).collect();

        assert!(
            types.contains("subagent"),
            "the built-in agents must appear under `@`, got types {types:?}"
        );
        // Only `command`, `subagent` and `skill` exist in the Java contract; an
        // unknown value would be silently dropped by the frontend filter.
        for t in &types {
            assert!(
                matches!(*t, "command" | "subagent" | "skill"),
                "unknown hint type `{t}` will never match a trigger"
            );
        }
    }

    /// `command` rows are carried for Java parity but no trigger selects them:
    /// `app-history.js:2732` maps `@` to `subagent` and everything else to
    /// `skill`. Asserting they are *present* would pin a row the UI cannot show;
    /// what must hold is that they never masquerade as one of the two live types.
    #[test]
    fn command_rows_never_collide_with_a_trigger_type() {
        let advertised: std::collections::HashSet<&str> =
            commands::completable().map(|(name, _)| name).collect();

        for entry in build_hints() {
            let (Some(name), Some(kind)) = (entry["name"].as_str(), entry["type"].as_str()) else {
                panic!("entry is missing name/type: {entry}");
            };
            if advertised.contains(name) && kind != "command" {
                panic!("slash command `{name}` is typed `{kind}` and would render under a trigger");
            }
        }
    }

    /// Every advertised command must actually be dispatched. Advertising one the
    /// dispatcher ignores sends the literal text to the model — the original
    /// `/rerun` bug.
    ///
    /// Checked here against the live endpoint payload rather than against the
    /// table alone: `commands.rs` owns the table-level invariant, while this one
    /// catches a `build_hints` that starts emitting rows from somewhere else.
    #[test]
    fn every_command_row_in_the_payload_is_dispatchable() {
        let rows: Vec<String> = build_hints()
            .iter()
            .filter(|e| e["type"].as_str() == Some("command"))
            .filter_map(|e| e["name"].as_str().map(str::to_string))
            .collect();
        assert!(!rows.is_empty(), "the payload carries no command rows at all");

        for name in rows {
            assert!(
                commands::is_supported(&name),
                "/{name} is offered in the panel but not dispatched"
            );
            assert!(
                !commands::is_cli_only(&name),
                "/{name} is cli-only and must never reach the panel"
            );
        }
    }

    /// The dispatcher's `match` arms and the command table must stay in step.
    ///
    /// They are two hand-maintained lists in different files: `COMMANDS` decides
    /// what `parse` accepts, and the `match` in `handle_slash_command` decides
    /// what actually happens. A name in the table with no arm falls into the
    /// `other =>` branch and answers HTTP 400 while the UI spins on a `done`
    /// frame that never comes; an arm with no table row is dead code, because
    /// `parse` refuses the name before the match is ever reached.
    ///
    /// Derived from the source text rather than from the table, so that adding a
    /// row without an arm fails here instead of in production.
    #[test]
    fn every_dispatch_arm_matches_a_table_row() {
        let src = include_str!("mod.rs");
        let start = src
            .find("async fn handle_slash_command")
            .expect("handle_slash_command missing");
        let body = &src[start..];
        let end = body
            .find("unsupported command:")
            .expect("the fallback arm anchors the end of the match");
        let body = &body[..end];

        // Arms are written `"name" => {`; requiring the `=>` on the same line
        // keeps other string literals in the function from being read as arms.
        let arms: std::collections::HashSet<&str> = body
            .lines()
            .filter_map(|line| {
                let t = line.trim();
                let rest = t.strip_prefix('"')?;
                let (name, tail) = rest.split_once('"')?;
                tail.trim_start().starts_with("=>").then_some(name)
            })
            .collect();

        // Self-check: an extraction pattern that found nothing must fail loudly
        // rather than pass vacuously.
        assert!(
            arms.len() >= 5,
            "only found {} dispatch arms, the extraction pattern has drifted: {arms:?}",
            arms.len()
        );

        let table: std::collections::HashSet<&str> =
            ["rewind", "rerun", "continue", "compact", "clear"]
                .into_iter()
                .filter(|n| commands::is_supported(n))
                .collect();
        assert_eq!(
            table.len(),
            5,
            "the known-command list no longer matches the table"
        );

        let missing_arm: Vec<&&str> = table.iter().filter(|n| !arms.contains(**n)).collect();
        assert!(
            missing_arm.is_empty(),
            "dispatched with no match arm (HTTP 400 + a UI that never stops spinning): {missing_arm:?}"
        );

        let dead_arm: Vec<&&str> = arms.iter().filter(|n| !table.contains(**n)).collect();
        assert!(
            dead_arm.is_empty(),
            "match arm for a name `parse` rejects, so it is unreachable: {dead_arm:?}"
        );
    }

    /// Java truncates a skill description to its first line and 30 characters.
    /// The cap counts characters: slicing a multi-byte char would panic, and
    /// these descriptions are usually Chinese.
    #[test]
    fn skill_descriptions_are_first_line_and_capped() {
        assert_eq!(hint_description("一行描述"), "一行描述");
        assert_eq!(hint_description("第一行\n第二行"), "第一行", "only the first line is shown");

        let long = "字".repeat(50);
        let out = hint_description(&long);
        assert!(out.ends_with("..."), "an over-long description must be elided: {out}");
        assert_eq!(
            out.chars().count(),
            33,
            "30 characters plus the ellipsis, counted in chars not bytes"
        );

        assert_eq!(hint_description(""), "");
    }
}
