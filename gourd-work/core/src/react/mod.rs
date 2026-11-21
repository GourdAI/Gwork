//! react — ReAct (Reason + Act) agent loop.
//!
//! Implements the classic Thought → Action → Observation cycle:
//! 1. Send conversation + tool definitions to the LLM
//! 2. If LLM returns tool_calls → execute tools → feed results back → goto 1
//! 3. If LLM returns text-only → emit final answer → done
//!
//! Supports: streaming deltas, HITL suspension, ask_user suspension,
//! cooperative cancellation, retry with backoff, max-turn guard, loop detection,
//! batch frames for parallel tool calls, and context_size reporting.

pub mod prompt;

use std::collections::HashMap;
use std::sync::Arc;

pub mod bg_gate;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::config::{ModelConfig, Settings};
use crate::llm::{ChatMessage, Role, StreamEvent, ToolCall, UsageInfo};
use crate::protocol::Frame;
use crate::tools::{ToolContext, ToolOutput, ToolRegistry};

/// Wall clock in epoch milliseconds.
fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Minimum gap between two `action_args` progress frames for one tool call
/// (Java `ReasonTask.ARGS_PROGRESS_INTERVAL_MS`).
pub const ARGS_PROGRESS_INTERVAL_MS: i64 = 200;

/// Minimum gap between two live `tps_progress` frames (ms), measured on the
/// same monotonic clock as the window denominator.
///
/// Deliberately coarser than `ARGS_PROGRESS_INTERVAL_MS`: the meter is a
/// hover-only readout a human reads at ~2 Hz, while a tool-argument counter
/// must look "typing". Two frames per second is the whole budget.
pub const TPS_PROGRESS_INTERVAL_MS: u64 = 500;

/// Sliding-window decode-speed meter for **one model call**.
///
/// This is a *measurement* of the stream's own delta-arrival rate, not a
/// provider token count: streaming dialects deliver output in arbitrary text
/// fragments, so `window_tokens` counts deltas actually received during the
/// window and `window_ms` is the real elapsed monotonic time between the two
/// emission instants. Both halves come from the same window, so the ratio can
/// never mix a numerator from one interval with a denominator from another.
/// At settlement the authoritative provider-reported pair in `context_size`
/// replaces this live readout (different unit, hence the expected jump).
///
/// Event-driven on purpose: no `tokio::time::interval`, no background task.
/// A frame is emitted only when a real delta arrives AND a full interval has
/// elapsed, so a silent stream emits nothing and the idle cap still trips.
///
/// Both the throttle and the denominator use [`std::time::Instant`]: mixing a
/// wall clock (`chrono::Utc::now`) into the throttle let an NTP step backwards
/// freeze emissions indefinitely, and a step forwards produced a phantom
/// 1000 tokens/s reading. A monotonic clock cannot be stepped.
#[derive(Debug, Clone)]
pub struct TpsMeter {
    /// Output deltas actually observed since the last emit.
    pub window_tokens: u64,
    /// Monotonic instant of the window start (= last emit, or first-delta anchor).
    pub window_started_at: std::time::Instant,
    /// Whether this model call has already seen its first visible delta.
    /// One meter is built per model call (and rebuilt on a transport retry),
    /// so this is a **per-turn** latch. It must never be the run-level TTFT
    /// latch: that one is set only once per run, which used to leak the whole
    /// prefill/TTFT wait of turns 2+ into the first speed window.
    first_delta_seen: bool,
}

impl TpsMeter {
    pub fn new(started_at: std::time::Instant) -> Self {
        Self {
            window_tokens: 0,
            window_started_at: started_at,
            first_delta_seen: false,
        }
    }

    /// Record one visible output delta.
    pub fn on_delta(&mut self) {
        self.window_tokens = self.window_tokens.saturating_add(1);
    }

    /// Re-anchor the window at `now` **without** clearing observed deltas.
    /// Called on a model call's first visible delta: everything before it was
    /// prompt processing / TTFT wait, not decode time, and must not enter the
    /// denominator.
    pub fn reset_window(&mut self, now: std::time::Instant) {
        self.window_started_at = now;
    }

    /// Record a visible delta and report whether it was this model call's
    /// **first** one. On that first delta the window is re-anchored here, so
    /// the caller cannot forget to do it and cannot accidentally use a
    /// run-level latch instead. A fresh `TpsMeter` (new turn, or transport
    /// retry) reports `true` again by construction.
    ///
    /// Returns `true` ⇒ caller should emit the `(0, 0, ttftMs)` latch frame.
    pub fn note_delta(&mut self, now: std::time::Instant) -> bool {
        let first = !self.first_delta_seen;
        if first {
            self.first_delta_seen = true;
            self.reset_window(now);
        }
        self.on_delta();
        first
    }

    /// True when a full interval has elapsed on the monotonic clock and the
    /// window has real output. Pure function of the stored state, so the
    /// throttle is table-testable without sleeping (Windows timer granularity
    /// makes wall-clock timing assertions flaky).
    pub fn should_emit(&self, now: std::time::Instant) -> bool {
        self.window_tokens > 0
            && now.saturating_duration_since(self.window_started_at)
                >= std::time::Duration::from_millis(TPS_PROGRESS_INTERVAL_MS)
    }

    /// Consume the current window: returns `(deltas, ms)` measured over exactly
    /// the same interval, then resets the window at `now`. Callers only invoke
    /// this after `should_emit`, which guarantees `deltas > 0` and `ms >= 500`,
    /// so no window can be cleared without a frame being sent.
    pub fn take_window(&mut self, now: std::time::Instant) -> (u64, u64) {
        let ms = now
            .saturating_duration_since(self.window_started_at)
            .as_millis() as u64;
        let tokens = self.window_tokens;
        self.window_tokens = 0;
        self.window_started_at = now;
        (tokens, ms)
    }
}

/// Minimum byte growth between two `action_args` progress frames for one tool
/// call (Java `ReasonTask.ARGS_PROGRESS_BYTES`).
pub const ARGS_PROGRESS_BYTES: u64 = 4096;

/// Throttle state for one tool call's argument-progress frames.
///
/// A model streaming a large argument (a whole file through `write`) emits
/// thousands of deltas. Forwarding each one is a frame storm: every frame is a
/// WebSocket write on the server and a DOM update on the client, and the client
/// only ever renders the *cumulative* byte count, so intermediate values are
/// pure waste. Java applies a dual threshold — emit when **either** enough time
/// has passed **or** enough bytes have accumulated — and these constants match it.
///
/// The two thresholds cover opposite failure modes: the time threshold keeps a
/// slow trickle of deltas visibly moving, and the byte threshold keeps a fast
/// burst responsive instead of updating only every 200 ms.
#[derive(Debug, Clone)]
pub struct ArgsProgress {
    /// Cumulative argument bytes seen so far.
    pub bytes: u64,
    /// Bytes as of the last emitted frame.
    pub last_emit_bytes: u64,
    /// Timestamp of the last emitted frame.
    pub last_emit_at: i64,
}

impl ArgsProgress {
    /// Start tracking at `now`, having emitted nothing yet.
    ///
    /// `last_emit_at` is seeded to `now` rather than 0 so the first progress
    /// frame waits a full interval: the skeleton card was *just* created by
    /// `action_draft`, so an immediate "0 B" update would be noise.
    pub fn new(now: i64) -> Self {
        Self {
            bytes: 0,
            last_emit_bytes: 0,
            last_emit_at: now,
        }
    }

    /// Whether a progress frame is due at `now`.
    ///
    /// Pure function of the stored state and the caller's clock, so the throttle
    /// is testable without sleeping — Windows timer granularity makes
    /// wall-clock-based timing tests flaky.
    pub fn should_emit(&self, now: i64) -> bool {
        now.saturating_sub(self.last_emit_at) >= ARGS_PROGRESS_INTERVAL_MS
            || self.bytes.saturating_sub(self.last_emit_bytes) >= ARGS_PROGRESS_BYTES
    }

    /// Record that a frame carrying `bytes` went out at `now`.
    pub fn mark_emitted(&mut self, bytes: u64, now: i64) {
        self.last_emit_bytes = bytes;
        self.last_emit_at = now;
    }
}

/// Configuration for a ReAct run.
#[derive(Default)]
pub struct ReActConfig {
    pub session_id: String,
    pub workspace: std::path::PathBuf,
    /// The session's own storage directory (`<sessions_root>/<sessionId>`), when
    /// the caller can resolve it.
    ///
    /// Per-session artefacts belong here, not in the shared workspace. The Java
    /// kernel writes `TODO.md` to `<sessions_root>/<sessionId>/TODO.md`
    /// (`TodoTalent.getTodoPath`), so a kernel that writes it to the workspace
    /// instead produces task lists the frontend can never read back — every
    /// session would appear to have no tasks, and concurrent sessions would
    /// overwrite one shared file.
    ///
    /// `None` for callers with no session storage (CLI one-shots, ACP, and
    /// sub-agents, whose `sub-*` ids are not real sessions); tools then fall
    /// back to the workspace path so those modes keep working.
    pub session_dir: Option<std::path::PathBuf>,
    pub model: ModelConfig,
    pub settings: Settings,
    pub access_mode: String,
    /// Live view of the session's access-tier override (`AppState.session_access`),
    /// consulted at **every tool invocation** rather than frozen at run start.
    ///
    /// Why this exists: `access_mode` above is a snapshot taken when the run
    /// spawns. A user who flips the picker to 完全访问 *mid-run* used to keep
    /// getting approval cards for the rest of that run — the exact "我切了完全
    /// 访问为什么还弹授权" report (session work-mwlp18n3: picker showed full,
    /// two `hitl` frames still fired inside one run). `/web/chat/access/select`
    /// writes the shared map; this handle reads it, so the very next bash call
    /// gates on the tier the picker shows.
    ///
    /// `None` for callers with no interactive tier surface (CLI one-shots, ACP,
    /// loop tasks, sub-agents): they keep the spawn-time `access_mode` semantics.
    /// The resolver lives in [`ToolContext::live_access_mode`] — one place, so
    /// the approval gate and the workspace boundary can never disagree.
    pub access_override:
        Option<std::sync::Arc<tokio::sync::Mutex<std::collections::HashMap<String, String>>>>,
    pub max_turns: u32,
    /// Unique ID for this run (one input → one run).
    pub run_id: String,
    /// Starting event sequence number (continues from session's last seq).
    pub start_seq: i64,
    /// True when resuming after HITL approval (skip re-prompting).
    pub hitl_approved: bool,
    /// Tool whitelist for this run.
    ///
    /// `None` means "derive it from `settings.permission`", which is what every
    /// existing caller wants and keeps the field optional at construction sites.
    /// Sub-agents pass their definition's gate, so the whitelist is enforced in
    /// `ToolRegistry::execute` rather than merely omitted from the definitions
    /// sent to the model.
    pub gate: Option<Arc<crate::tools::ToolGate>>,
    /// Nesting level of this run. 0 = the main agent; a sub-agent run is its
    /// delegator's level + 1. Carried into [`ToolContext`] so `task`/`multitask`
    /// can refuse to delegate past [`crate::team::MAX_SUBAGENT_DEPTH`].
    pub subagent_depth: u32,
    /// The **real** session the user is looking at.
    ///
    /// Equal to `session_id` for a top-level run. For a sub-agent, `session_id` is
    /// the synthetic `sub-<task_id>` used for its own bookkeeping, while this stays
    /// the id of the conversation the frames must be rendered into. Without it,
    /// nested delegation (a sub-agent delegating further) would stamp frames with
    /// its own `sub-*` id and the cards would land in a phantom session.
    pub root_session_id: String,
    /// User-selected reasoning level (`reasoning::selectable_codes` vocabulary),
    /// `None` for provider default.
    ///
    /// Threaded to the wire by [`crate::llm::LlmClient::stream_chat`].
    /// `/web/chat/thinking/select` has always persisted this into the session
    /// context, and `reasoning::selectable_codes` has always computed which levels
    /// a model offers — but nothing ever read the stored value when building a
    /// request, so the picker changed only the UI.
    pub thinking: Option<String>,
    /// Optional file-change ledger for capturing write/edit before/after states.
    pub change_ledger: Option<Arc<crate::changes::ChangeLedger>>,
    /// Session-selected context window (ring denominator of the frontend meter).
    /// 0 = unknown; the meter then hides the percentage instead of inventing one.
    pub context_length: i64,
    /// Run subscription moment (wall-clock ms). Carried on `reason_start` and
    /// `context_size` frames so the frontend can tick live elapsed time and
    /// invalidate the previous turn's settled value (Java `turnStartMs`).
    pub turn_start_ms: i64,
    /// Session-cumulative usage scanned from the stream file at run start
    /// (Java `SessionStreamStore.sumUsage`). Seeded once per run; the in-run
    /// counters then advance on top of it, so every `context_size` frame can
    /// carry the `args.total*` ledger the meter's cumulative rows read.
    pub usage_seed: crate::session_usage::SessionUsageSum,
    /// Force one compression pass at the start of this run, ignoring the trigger
    /// threshold (Java `HarnessEngine.requestCompact`, set by `/compact`).
    ///
    /// Applies to the first turn only; see the call site in the loop.
    pub force_compact: bool,
    /// The `/compact <focus>` instruction, if the command carried one.
    ///
    /// Consumed with the same first-turn-only lifetime as `force_compact`. It used
    /// to be accepted by the command parser, persisted on the session context and
    /// reported back to the user as "聚焦：…", then dropped without ever reaching
    /// the compressor — so the UI promised a steer that never happened. It now
    /// reaches `compress()` and lands in the retained window as an explicit focus
    /// turn.
    pub compact_focus: Option<String>,
    /// 本次 run 是否为「异常中断后的恢复执行」（契约 §3.3）。
    ///
    /// 由 `run_react_session` 的 abnormal-exit 校准分支（`session_ctx.interrupted`）
    /// 置位；透传到 `ToolContext`，让 todo 工具 footer 的恢复 [提示] 行只在校准
    /// 语境出现。常规 run（含 ask_user/HITL 的正常挂起恢复）保持 false。
    pub resume_calibration: bool,
}

/// Model first-token latency (ms): model-call request start → first upstream frame.
///
/// 【2026-11 用户拍板】只测模型响应：首帧可以是正文/思考/工具调用任意一种；
/// 工具执行是本地时间，绝不计入（旧「run 起点 → 首个可见字符」口径在多轮
/// 工具型任务里把本地执行算成了模型延迟，session work-mwlhix12: 518.50s）。
///
/// **Pure** so the whole timing contract is table-testable without a wall clock.
/// `None` means the model never responded at all, which is deliberately different
/// from a real 0 ms first token (never fabricate a 0). `saturating_duration_since`
/// guards against an implausible out-of-order pair instead of panicking/underflowing.
fn ttft_ms_since(
    started_at: std::time::Instant,
    first_frame: Option<std::time::Instant>,
) -> Option<u64> {
    let first = first_frame?;
    Some(first.saturating_duration_since(started_at).as_millis() as u64)
}

/// Why the run stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    /// Model produced a final text answer.
    Completed,
    /// Suspended waiting for user answer (ask_user).
    SuspendedQuestion,
    /// Suspended waiting for HITL approval.
    SuspendedHitl,
    /// User cancelled.
    Cancelled,
    /// Hit max turns.
    MaxTurns,
    /// Unrecoverable error.
    Error,
}

/// Result of a ReAct run.
pub struct ReActResult {
    pub final_answer: String,
    pub turns_used: u32,
    pub usage: UsageInfo,
    pub stop_reason: StopReason,
    /// Next event sequence number (for persisting).
    pub next_seq: i64,
    /// The full message history after the run (for resume persistence).
    pub messages: Vec<ChatMessage>,
    /// For HITL suspension: the command awaiting approval.
    pub pending_command: Option<String>,
    /// For HITL suspension: the timeout the model requested (honored on approval).
    pub pending_timeout_ms: Option<u64>,
    /// For HITL suspension: whether the model requested background execution.
    pub pending_background: bool,
    /// For suspension: the tool_call_id of the tool that triggered it.
    /// Needed on resume to inject a proper `tool` role message.
    pub pending_tool_call_id: Option<String>,
}

impl ReActResult {
    pub fn interrupted(&self) -> bool {
        !matches!(self.stop_reason, StopReason::Completed)
    }
}

/// The ReAct agent executor.
pub struct ReActAgent {
    registry: Arc<ToolRegistry>,
}

impl ReActAgent {
    pub fn new(registry: Arc<ToolRegistry>) -> Self {
        Self { registry }
    }

    /// Run the ReAct loop with streaming frame emission.
    ///
    /// `frame_tx` receives all protocol frames for the frontend.
    /// `history` is the conversation so far (system + user + assistant messages).
    /// `cancel` is cooperatively checked between turns and during tool execution.
    pub async fn run(
        &self,
        config: &ReActConfig,
        history: Vec<ChatMessage>,
        frame_tx: mpsc::UnboundedSender<Frame>,
        cancel: CancellationToken,
    ) -> ReActResult {
        let mut result = self
            .run_inner(config, history, frame_tx.clone(), cancel)
            .await;

        // SINGLE TERMINAL GATE. Every abnormal exit inside `run_inner` emits an
        // `error` frame but returns without `done`, because the frontend leaves
        // its streaming state ONLY on `done` (`app-streaming.js` calls
        // `finishStream` from the done branch). The visible symptom is exactly
        // "task ended unfinished": after the last tool card (or a lone
        // thinking block) the run stops with no final answer, no button reset,
        // and no way to tell whether it failed. Measured with a mock provider:
        //   reasonOnly / emptyStop / toolThinkOnly / http400 / eof
        // all ended with `stop=Error`, `done=0`, `error=1`.
        //
        // Doing this once here — rather than adding a `done` to each of the
        // nine `error`/`MaxTurns` returns — is what makes it impossible to
        // miss a newly added exit later, and covers every caller (HTTP, ACP,
        // CLI and team) through the same gate.
        //
        // `Completed` / `Cancelled` already emitted `done` themselves;
        // `Suspended*` emitted `done_suspended`. Emitting a second one would
        // double-`finishStream` and could fold a live resumed run.
        if matches!(result.stop_reason, StopReason::Error | StopReason::MaxTurns) {
            // Hand late interjections back before `done`, same as the normal
            // end: `done` is what makes the frontend read the queue, and a
            // steer typed while the run was failing must not be lost.
            if let Some(dir) = config.session_dir.as_ref() {
                let left = settle_steers(
                    &crate::queue::QueueManager::new(),
                    dir,
                    &config.run_id,
                    true,
                );
                if !left.is_empty() {
                    let f = Frame::steer_dropped(
                        &config.session_id,
                        serde_json::json!({ "count": left.len(), "items": left }),
                    )
                    .run(&config.run_id)
                    .seq(result.next_seq);
                    result.next_seq += 1;
                    let _ = frame_tx.send(f);
                }
            }
            let f = Frame::done(&config.session_id)
                .run(&config.run_id)
                .seq(result.next_seq);
            result.next_seq += 1;
            let _ = frame_tx.send(f);
        }

        // Pairing repair as the single exit gate, so it covers *every* return
        // path (cancel, error, max-turns, suspension) rather than having to be
        // remembered at each one.
        //
        // Why this is mandatory and not defensive polish: cancellation can now
        // land between pushing `assistant(tool_calls)` and pushing all of its
        // tool results — the bash tool and the LLM stream both abort promptly on
        // Stop, which is exactly what makes that window reachable. Those messages
        // are persisted, and an OpenAI-compatible provider hard-rejects a
        // `tool_calls` entry with no matching `tool` message
        // ("No tool output found for tool call …"). Retrying the identical
        // request can never self-heal, so the session would fail on every
        // subsequent turn until the user abandoned it.
        //
        // SUSPENSION IS THE ONE DELIBERATE EXCEPTION. ask_user / HITL end a run
        // with an `assistant(tool_calls)` turn that intentionally has no tool
        // result yet: the result is injected by `spawn_resume` only after the
        // user answers / approves. Repairing that turn here inserts
        // INTERRUPTED_MARKER, and `server/mod.rs` then persists the poisoned
        // array into `SuspensionPoint.messages_json`. On resume the model reads
        // "该工具调用因任务中断/取消未执行完成…请勿直接重复执行" *before* the real
        // answer, concludes the question was cancelled, and finishes the turn
        // with reasoning-only output — zero visible text, zero tool calls.
        // That is exactly the "问答已提交但任务无法正常执行" incident: session
        // work-mw205svw, run-f3e7512f = 463 `reason` frames + `done`, and none
        // of the two answers ("全量根治" / "不要兼容旧帧") reached the model.
        // `spawn_resume` adds the matching `tool` message in its place. Only the
        // *pending* call is exempt: a parallel batch may contain other calls that
        // genuinely died mid-flight, and those still need a placeholder or the
        // provider rejects the whole history on the resumed request.
        let suspended_call: Vec<String> = match result.stop_reason {
            StopReason::SuspendedQuestion | StopReason::SuspendedHitl => {
                result.pending_tool_call_id.clone().into_iter().collect()
            }
            _ => Vec::new(),
        };
        // Scope the exemption to the LAST assistant(tool_calls) group: Gemini
        // synthesises call ids like `gemini-call-0` per stream, so an older
        // orphan can reuse the exact id of the current pending call. Matching by
        // string across the whole history would exempt that older orphan too and
        // leave the resumed request with an unpaired tool_call (HTTP 400).
        let repaired =
            repair_tool_pairing_except_in_last_group(&mut result.messages, &suspended_call);
        if repaired > 0 {
            warn!(
                session = %config.session_id,
                repaired,
                "repaired orphaned tool_calls before persisting history"
            );
        }
        result
    }

    /// The loop itself; `run` wraps it with the pairing-repair exit gate.
    async fn run_inner(
        &self,
        config: &ReActConfig,
        history: Vec<ChatMessage>,
        frame_tx: mpsc::UnboundedSender<Frame>,
        cancel: CancellationToken,
    ) -> ReActResult {
        // 官方模型未登录时构造失败：发一个 error 帧并走统一的 done 出口，
        // 不能 panic，也不能拿空 key 向官方 relay 发请求。
        let client = match crate::llm::LlmClient::with_retries(
            config.model.clone(),
            config.settings.general.model_retries,
        ) {
            Ok(c) => c,
            Err(e) => {
                let msg = format!("Failed to start LLM stream: {}", e);
                let f = Frame::error(&config.session_id, &msg)
                    .run(&config.run_id)
                    .seq(config.start_seq);
                let _ = frame_tx.send(f);
                return ReActResult {
                    final_answer: msg,
                    turns_used: 0,
                    usage: UsageInfo::default(),
                    stop_reason: StopReason::Error,
                    next_seq: config.start_seq + 1,
                    messages: history,
                    pending_command: None,
                    pending_timeout_ms: None,
                    pending_background: false,
                    pending_tool_call_id: None,
                };
            }
        };
        // 【2026-11 用户决策】react 层重试预算与传输层同源同 clamp：
        // 前台「正在重试 n/N」的 N 必须是用户设置的 modelRetries，
        // 而不是 turns/maxTurns（AutoRethink 会把 20 扩到 30/40，
        // 用户看到「设置 10 却重试 40」就是那条串线）。
        let model_retry_budget = config
            .settings
            .general
            .model_retries
            .clamp(1, crate::tools::web_retry::MAX_ATTEMPTS_CEILING);
        // One gate for the whole run: the caller's (a sub-agent whitelist) when
        // given, otherwise the user's global `disallowedTools`. Resolved once here
        // so the definitions sent to the model and the `execute` check cannot
        // disagree about what this run may call.
        //
        // The interactive chat path always supplies a gate (built from
        // permission + the conversation's connector selection), so the fallback
        // below serves CLI/ACP/loop callers only — they keep every enabled
        // connector, which is their pre-picker behaviour.
        let gate: Arc<crate::tools::ToolGate> = config.gate.clone().unwrap_or_else(|| {
            Arc::new(crate::tools::ToolGate::from_permission(
                &config.settings.permission,
            ))
        });
        // What a delegated sub-agent inherits from this run. Hoisted beside the
        // gate for the same reason: both are fixed for the whole run, while a
        // `ToolContext` is rebuilt for every tool call. Sharing one `Arc` keeps
        // that per-call cost at a refcount bump instead of deep-copying the
        // model credentials and the entire model registry each time.
        let run_model = Arc::new(config.model.clone());
        let run_settings = Arc::new(config.settings.clone());
        // ── Cold-start race: wait for MCP handshakes before snapshotting ─────
        // The kernel starts serving HTTP immediately and handshakes MCP servers
        // on a background task (a hung `npx` must not delay startup). But the
        // tool list below is snapshotted ONCE per run and reused for every turn,
        // so a run that began mid-handshake never saw those tools at all — the
        // model answered "I don't have that tool" for a server that was in fact
        // connecting, and only the NEXT conversation would show it.
        //
        // Bounded wait, so this can never make startup worse than it was: it
        // returns immediately when nothing is configured (the latch defaults to
        // settled) or when handshakes already finished, and otherwise caps at
        // MCP_STARTUP_WAIT. Timeout is not an error — proceed with whatever
        // connected, exactly like before, just without silently dropping the
        // tools that arrived a moment later.
        const MCP_STARTUP_WAIT: std::time::Duration = std::time::Duration::from_secs(10);
        if let Some(mcp) = self.registry.mcp() {
            if !mcp.wait_for_startup(MCP_STARTUP_WAIT).await {
                warn!(
                    session = %config.session_id,
                    waited_secs = MCP_STARTUP_WAIT.as_secs(),
                    "MCP servers still connecting after {:?}; this run may not see all MCP tools",
                    MCP_STARTUP_WAIT
                );
            }
        }
        let tool_defs = self
            .registry
            .definitions_async(&config.settings.permission, Some(&gate))
            .await;
        // ── Tool-visibility guard (Qoder / ZCode / Java parity) ──────────────
        // The wire `tools` field is the ONLY schema source; the system prompt
        // gets a compact NAME-ONLY roster derived from this exact same list,
        // so the two can never disagree about what is callable. Cost is capped
        // at 2 KB — the definitions themselves are NOT duplicated here.
        //
        // A truly empty list is a configuration fault, not a normal mode: every
        // built-in (including the skill tools) was filtered away, so the
        // request would omit `tools` altogether and the model could do nothing
        // but emit a pure-text intent declaration that ends the run. Say so
        // loudly, and tell the model no tools exist so at least its answer is
        // an honest one instead of "I'll call todoread first".
        if tool_defs.is_empty() {
            warn!(
                session = %config.session_id,
                workspace = %config.workspace.display(),
                "no tool definitions available for this run; the model will see NO callable tools"
            );
        }
        let tools = if tool_defs.is_empty() {
            None
        } else {
            Some(tool_defs.clone())
        };
        let roster = crate::react::prompt::tool_roster_prompt(tools.as_deref());
        let visibility_note = if roster.is_empty() {
            crate::react::prompt::NO_TOOLS_NOTICE.to_string()
        } else {
            roster
        };

        let mut messages = history;
        // Append to the existing system message (callers always build one) or
        // create it when a caller handed us history without one. Mutating in
        // place keeps message count, role order and replay byte-identical.
        let sys_text = messages
            .first()
            .filter(|m| m.role == Role::System)
            .map(|m| m.content_text())
            .unwrap_or_default();
        let sys_text = format!("{}{}", sys_text, visibility_note);
        if messages.first().is_some_and(|m| m.role == Role::System) {
            messages[0] = ChatMessage::system(sys_text);
        } else {
            messages.insert(0, ChatMessage::system(sys_text));
        }
        // Fixed per-request overheads. Both count against the context window and
        // must be included in the compression budget, or the trigger fires late
        // (tool definitions alone run to thousands of tokens).
        let tools_tokens = crate::compress::estimate_tools_tokens(&tool_defs);
        let system_tokens = messages
            .first()
            .filter(|m| m.role == Role::System)
            .map(|m| crate::compress::estimate_text_tokens(&m.content_text()))
            .unwrap_or(0);
        let mut total_usage = UsageInfo::default();
        let mut turns = 0u32;
        // Decode-speed accumulator (Java TurnTimer parity): wall time of the timed
        // generation segments plus the completion tokens those segments produced.
        // Tool execution, approval waits and sub-agent scheduling are excluded,
        // so the ratio is a comparable decode throughput across models.
        let mut generation_ms_total: u64 = 0;
        let mut generated_tokens_total: u64 = 0;
        // Latch for the model's FIRST-TOKEN latency of the most recent model
        // call: request issued → first upstream frame of ANY kind (content,
        // reasoning, tool-call start/args, usage).
        //
        // 【2026-11 用户拍板】旧口径是「run 起点 → 首个可见字符」，工具执行与多轮
        // 模型往返全部计入。生产会话 work-mwlhix12：本轮前 8.6 分钟模型只发工具
        // 调用帧、没有正文/思考，卡面显示 TTFT=518.50s——数值忠实但语义误导。
        // 工具执行是本地时间，不属于模型延迟：TTFT 只测「模型首字响应」。
        //
        // 生命周期（code review 修正）：
        // - 每个模型调用（含 react 层重试/腐蚀门禁重试）开头清零：新请求新时钟。
        //   不清零会把上一次调用的读数带进新调用——旧调用只发了 Error（从未成功
        //   响应）时新调用会一直显示 '--'，直到下一轮结算才恢复。
        // - 传输层 Retry 事件也清零（新 attempt 重新计时，见 Retry 分支）。
        // - 工具执行阶段刻意保留上一次调用的读数（与前端 _ctxTiming 缓存同语义：
        //   展示最近一次模型响应的首字延迟，而不是显示 '--'）。
        // 声明不初始化：首个动作就是每次调用开头的清零，初始值永不被读
        // （unused_assignments 警告）；Rust 流敏感初始化保证读前必有赋值。
        let mut model_ttft_ms: Option<u64>;

        // ── P2: retry/latency budget (Java's four caps, aligned 2026-10-31) ──
        // Java production incident work-mua28gy6: 34 retries burned 5 tiers of
        // backoff over 67.6 minutes with zero visible progress. Root cause:
        // timeout ≠ rejection — upstream already accepted the request and is
        // generating (and billing); retrying re-sends the full context, and a
        // larger context times out *more* easily: a positive feedback loop.
        // So timeout-class failures get their own ≤2-per-round allowance, and
        // one model call's total retry time is capped regardless of failure
        // class. Both budgets are per call, never per run: a run-wide cap is a
        // countdown on the task itself, so any run outliving it dies on its
        // first transient error (see Cap 3 below).
        //
        // Cap 1: single-stream idle ceiling — no SSE data for this long means
        // the stream is dead (Java `streamIdleCap = modelTimeout + 30s`;
        // reqwest's `.timeout()` is a whole-request cap and cannot express
        // "per-chunk idleness" on a long, healthy stream).
        let stream_idle_cap =
            std::time::Duration::from_secs(config.model.timeout_secs().saturating_add(30));
        // Cap 2: single-stream total wall-clock (Java `STREAM_TOTAL_CAP = 30min`,
        // enforced there with a plain JDK latch; here a deadline on the
        // receive loop). A legitimately long answer can be legitimately long,
        // but 30 minutes of one completion is a stuck stream, not an answer.
        let stream_total_cap = std::time::Duration::from_secs(30 * 60);
        // Cap 3: per-model-call retry deadline (Java `REASON_RETRY_TOTAL_DEADLINE
        // = 45min` on `RetryTask.totalDeadline`). `RetryTask` is constructed
        // *inside* `callWithRetry` and takes its `startNanos` on entry, so Java's
        // budget re-arms on every turn and is shared only by that turn's physical
        // retries. Bounded with `Instant` so a clock jump cannot extend or
        // fake-expire it (same reason the D-1 await_tasks fix used nanoTime on the
        // Java side).
        //
        // This is deliberately NOT a whole-run budget, which is what it used to be.
        // A run-level deadline turns 45 minutes into a countdown on the *task*:
        // every long run that outlives it loses the ability to absorb a single
        // transient network error, so one reqwest hiccup at minute 46 kills a task
        // that had been healthy for 45 minutes — reported in production as
        // "error sending request for url (…) The run's retry budget of 45 minutes
        // is exhausted". Java's own argument for why this budget cannot hurt a
        // legitimate long answer (`ReasonTask` javadoc: “首次尝试永不受约束…
        // 45min > 30min ⇒ 一个正常完成的长回答（含深度思考）永远不会碰到本预算”)
        // holds *only* because the budget re-arms per call.
        let mut retry_deadline = retry_deadline_from_now();
        // Marks the next loop iteration as another *attempt at the same model
        // call* rather than a fresh turn. Only a fresh turn re-arms the deadline
        // (Java: one `RetryTask` per `callWithRetry`, shared by that call's
        // retries). Re-arming on a retry too would make the deadline unreachable
        // and resurrect the infinite-retry shape it exists to bound — so every
        // retry-of-the-same-call branch below must set this flag, and nothing else
        // may. `p2_retry_deadline_is_per_call_not_per_run` pins the set.
        let mut retry_of_same_call = false;
        // 【2026-11 用户决策】本次模型调用已用的重试次数（react 层）。
        // 与 retry_deadline 同生命周期：新调用清零，同调用重试累加；
        // 上限 = model_retry_budget（用户设置的 modelRetries）。
        let mut call_retries = 0u32;
        // Timeout-bucket counter, reset every round (Java counts per turn).
        let mut timeout_retries = 0u32;
        // Mutable: AutoRethink extends the ceiling as the run progresses
        // (Java `ReActOptions.addMaxTurns`). `initial` is kept for the extension
        // step size, which Java derives from it.
        let initial_max_turns = config.max_turns.max(1);
        let mut max_turns = initial_max_turns;
        let mut seq = config.start_seq;
        let started_at = std::time::Instant::now();
        // Loop detection (Java `StopLoopInterceptor`, redesigned 2026-11-20
        // after the work-mwod1kcs false kill; competitor-aligned).
        //
        // Two defects were fixed together:
        //
        // 1. The old fingerprint truncated every argument value to 120 chars.
        //    A long shared prefix (e.g. `$f='C:\Apps\HBuilderX\...\compiler-sfc.cjs.js';
        //    Select-String -Pattern '<different symbol>'`) ate the whole budget,
        //    so 12 *different* investigation commands collapsed into one
        //    fingerprint and the run was stopped mid-debugging. Arguments are
        //    now canonicalised in full and hashed — no truncation.
        //
        // 2. The old shape was "windowed frequency → 3 reminders → hard stop".
        //    Claude Code and Codex have no behavioural loop detector at all;
        //    DSH (`repeat-tool-reminder`) uses a *consecutive* chain with
        //    escalating reminders at 3/5/8 and **never blocks or stops**
        //    ("Advisory, not veto" — its design notes explicitly reject
        //    hard stops to protect legitimate polling/re-checking). This
        //    kernel now follows DSH: consecutive-chain counting, escalating
        //    soft reminders, no repetition-based hard stop. The only bound on
        //    AutoRethink extension is context exhaustion (+ the user's Stop).
        //
        // Progress awareness (user decision 2026-11-20): a successful
        // write/edit between two identical calls, or a *different* result for
        // the same call, means the repeat produced new information — the
        // chain restarts instead of escalating. Edit→restart→poll cycles are
        // legitimate debugging, not spinning.
        let mut loop_chain: Option<LoopChain> = None;
        // Whether the previous executed round successfully mutated workspace
        // state (write/edit). Consumed by the chain judge below.
        let mut prev_round_mutated = false;

        // Turn-based todo-staleness reminder (Qoder CLI `todo_reminder`). Counts
        // reasoning turns since the last `todowrite` and since the last reminder;
        // the dual gate + per-run cap at the injection site keep it a gentle
        // nudge rather than per-turn spam. Forgiven when the model writes on its
        // own.
        let mut turns_since_todowrite = 0u32;
        let mut turns_since_todo_reminder = 0u32;
        let mut todo_reminders = 0u32;

        // P1: consecutive turns where the model returned neither text nor tool
        // calls. An empty round can never be progress; silently treating it as
        // "completed" ended runs with an empty final answer and no explanation
        // (the other half of the "long task ends wrong" symptom).
        let mut empty_rounds = 0u32;

        // Corrupted-stream retries, **run-level and never reset**.
        //
        // Run-scoped on purpose: a turn-scoped bucket would be re-armed by
        // every successful round, so a provider that corrupts intermittently
        // could burn the whole 45-minute `retry_deadline` — the shape actually
        // recorded on session work-mw8wizyz (3.5M input tokens, then "retry
        // budget exhausted"). Corruption is a property of the upstream, not of
        // one turn, so the allowance is spent once for the run.
        let mut corruption_retries = 0u32;

        // There is deliberately no output-volume or "no progress" judgement
        // here. A pair of such checks lived here (P4, 2026-10-31) and was
        // removed: one killed healthy runs, the other was unreachable.
        //
        // The diminishing-output half counted any round whose completion-token
        // delta fell under 500 as filler. A normal agent round — one sentence of
        // narration plus one tool call — is 30–200 tokens, so the counter rose
        // monotonically from turn 10 and never reset, and the run was killed at
        // the first extension point. Measured on run-8248faa3 (deltas 49, 103,
        // 153, 178, 120, 32, 69, 181, 121, 100, 113, 153, 148, 109, 47, 79, 121,
        // 77): the verdict was already true at turn 13 while the model was
        // reading files, grepping and writing its TODO, with 13 successful tool
        // calls on record.
        //
        // The silent-round half was unreachable: a round with neither text nor
        // tool calls is caught by the P1 empty-response branch below, which
        // always continues or returns before this point.
        //
        // Java has no equivalent of either check (`ReasonTask.java:500-528`
        // extends unconditionally at the threshold; a repo-wide search for
        // diminish/deltaToken/noProgress/stagnat finds nothing). Its only
        // stuck-detector is `StopLoopInterceptor`, mirrored below as a soft
        // reminder.
        //
        // Be honest about what is left, because the obvious reading of the
        // extension point below is wrong: for a healthy run, nothing here stops
        // it. `context_exhausted` fires only when a compression pass cannot get
        // back under the trigger, which needs the protected prefix or the
        // `min_reserved_messages` floor to exceed the window on its own;
        // measured normal runs sit at 13K-98K against a 223K trigger, so it
        // effectively never fires. The loop guard is advisory-only (DSH
        // semantics, 2026-11-20): reminders never stop a run. A model doing
        // varied but useless work therefore extends indefinitely and only the
        // user's Stop ends it. That is the deliberate trade, and it matches
        // Java / Claude Code / Codex / DSH: every attempt to bound this by
        // behaviour (output volume, reminder caps) killed healthy runs, and a
        // wrong bound costs more than no bound.

        // Convergence gate (Java `EXTRA_CONVERGE_PENDING` /
        // `EXTRA_CONVERGE_DEFERRED_COUNT`): armed whenever a convergence-oriented
        // prompt is injected, consumed by the text-only branch below.
        let mut converge_pending = false;
        let mut converge_deferred = 0u32;
        // P3: background-gate deferral counter (Java `bgGateDeferredCount`).
        // Run-scoped like the converge counter; the gate consumes it only at the
        // text-answer END.
        let mut bg_deferred = 0u32;

        // Context compression (Java `ContextCompressionInterceptor`).
        let compress_cfg =
            crate::compress::CompressionConfig::from_settings(&config.settings.general);
        let mut calibration = crate::compress::Calibration::default();

        // Session-cumulative ledger for the meter's `args.total*` rows. The seed
        // covers every closed run plus the in-flight tail scanned at spawn time;
        // `run_usage` (this run's own accumulation) is added on top per call, so
        // the figure advances live without re-reading the stream file mid-run.
        let seed = config.usage_seed.clone();

        // A stateless handle. The read-modify-write serialisation does not live
        // in this value but in `queue::QUEUE_LOCK`, a process-wide `static`, so
        // building one here still excludes the HTTP handlers' `add`, the frontend
        // `shift()` loop and the badge refresh on the same `queue.json`. Threading
        // a single `Arc<QueueManager>` in through `ReActConfig` would change no
        // behaviour whatsoever — that was the original shape of the plan, and it
        // was superseded; do not re-introduce it on the strength of this comment.
        let queue_mgr = crate::queue::QueueManager::new();

        // Helper: emit a frame with run id + seq
        macro_rules! emit {
            ($frame:expr) => {{
                let f = $frame.run(&config.run_id).seq(seq);
                seq += 1;
                let _ = frame_tx.send(f);
            }};
        }

        // Helper: settle the steer mailbox when a run ends.
        //
        // Interjections left in `queue.json` at exit must be resolved explicitly,
        // not merely left on disk: the frontend clears its pending chip only on a
        // `steer_cancelled` / `steer_dropped` frame. `requeue` distinguishes the two
        // outcomes Java draws between them — a Stop throws them away, a run that
        // simply ended hands them back to the queue for the next turn.
        //
        // Call sites are always *before* the `done` frame (see [`Frame::steer_cancelled`]).
        // Not strictly idempotent: the `cancelled` branch empties the mailbox so a
        // repeat emits nothing, but the `dropped` branch only reads, so a repeat
        // would re-announce the same ids. Harmless either way — the frontend
        // dedupes on `steerResolved` — and unreachable in practice because every
        // exit returns immediately after settling, so one run settles exactly once.
        // (See [`settle_steers`] for the same caveat; do not call this twice.)
        macro_rules! steer_exit {
            ($frame:expr, $requeue:expr) => {{
                if let Some(dir) = config.session_dir.as_ref() {
                    let left = settle_steers(&queue_mgr, dir, &config.run_id, $requeue);
                    if !left.is_empty() {
                        emit!($frame(
                            &config.session_id,
                            serde_json::json!({ "count": left.len(), "items": left }),
                        ));
                    }
                }
            }};
        }

        loop {
            // 【2026-11 用户决策】重试不再烧轮次：同一次模型调用的重试
            // （retry_of_same_call）不递增 turns。旧实现 turns += 1 无条件
            // 执行，重试既虚增「正在重试 n/N」的 n，又吃掉 maxTurns 预算。
            if !retry_of_same_call {
                turns += 1;
            }

            // Cap 3 re-arm point: a fresh turn is a fresh `callWithRetry`, so it
            // gets its own retry budget (Java constructs `RetryTask` per call and
            // takes `startNanos` on entry). A retry of the *same* call — flagged by
            // the two retry branches below — skips this and keeps burning the
            // budget it already started, which is what keeps the deadline
            // reachable at all.
            if !retry_of_same_call {
                retry_deadline = retry_deadline_from_now();
                // 新调用 = 新的重试计数（与 deadline 同生命周期）。
                call_retries = 0;
            }
            retry_of_same_call = false;

            if cancel.is_cancelled() {
                // Emit `done` before returning. The frontend leaves its streaming
                // state only on a `done` frame for the active run
                // (`app-streaming.js`: "等 steer_cancelled + done 收敛"); without
                // it the UI stays in "thinking" forever — the timer keeps running
                // and pressing Stop again does nothing, which is exactly the
                // reported symptom. Java emits `WebChunk.ofDone()` on every
                // interrupt path for the same reason.
                steer_exit!(Frame::steer_cancelled, false);
                emit!(Frame::done(&config.session_id));
                return ReActResult {
                    final_answer: String::new(),
                    turns_used: turns,
                    usage: total_usage,
                    stop_reason: StopReason::Cancelled,
                    next_seq: seq,
                    messages,
                    pending_command: None,
                    pending_timeout_ms: None,
                    pending_background: false,
                    pending_tool_call_id: None,
                };
            }

            // ── Context compression (Java `onReasonStart`) ──────────────────
            // Runs before the request is built. Without it a long run grows
            // without bound and eventually fails with a provider 400 that no
            // retry can fix — the failure mode this kernel used to hit once
            // AutoRethink started letting runs past turn 20.
            let outcome = crate::compress::compress(
                messages,
                &compress_cfg,
                system_tokens,
                tools_tokens,
                &calibration,
                // A manual `/compact` forces exactly one pass, at the start of the
                // run (Java: "将在下一轮推理开始时生效"). Later turns go back to the
                // threshold, so the flag cannot make every turn re-compress.
                //
                // NOTE: `turns` was already incremented at the top of this loop,
                // so the first iteration is `turns == 1` — NOT 0. This condition
                // was previously `turns == 0`, which is unreachable and silently
                // disabled both the forced pass and the focus instruction.
                config.force_compact && turns == 1,
                // The focus instruction shares that first-turn-only lifetime: it
                // steers the single forced pass and must not leak into later,
                // threshold-triggered compressions.
                if config.force_compact && turns == 1 {
                    config.compact_focus.as_deref()
                } else {
                    None
                },
            );
            if outcome.compressed {
                info!(
                    session = %config.session_id,
                    turn = turns,
                    messages = %format!("{}->{}", outcome.before_count, outcome.after_count),
                    tokens = %format!("{}->{}", outcome.before_tokens, outcome.after_tokens),
                    "context compressed"
                );
                // Tell the frontend so the content area can draw the
                // "已压缩上下文" divider at exactly this point in the stream
                // (Java `WebStreamBuilder.onContextSizeEvent`). Emitted before
                // any frame of this turn, so the divider lands between the
                // pre-compression tool groups and whatever this turn produces.
                emit!(Frame::context_compacted(
                    &config.session_id,
                    outcome.before_count,
                    outcome.after_count,
                    outcome.before_tokens,
                    outcome.after_tokens,
                ));
            }
            messages = outcome.messages;
            // Context pressure for this turn, snapshot here (Java caches it in
            // `onReasonStart` for the same reason: one value per turn, shared by
            // every tool call the model makes in that turn).
            let pressure = crate::compress::context_pressure(outcome.after_tokens, &compress_cfg);
            let observation_cap = crate::compress::observation_cap(pressure);
            // Set when a compression pass could not bring the context back under
            // the trigger. This is the honest "out of room" signal, and it is what
            // bounds AutoRethink's otherwise unlimited turn extension. Recomputed
            // every turn, so it lives inside the loop.
            let context_exhausted = outcome.after_tokens > compress_cfg.trigger_threshold();

            // ── Turn budget (Java `ReasonTask.run` 494-538) ──────────────────
            if config.settings.general.auto_rethink {
                // Soft budget: at ~80% of the ceiling, inject a self-review and
                // extend, leaving headroom for the model to change strategy or
                // wrap up. Java has no hard fuse at all on this branch.
                //
                // It cannot be copied literally here. Java pairs unlimited
                // extension with compression *and* accepts that a run may simply
                // keep going; this kernel bounds extension by the context budget
                // instead, because once compression can no longer fit the history
                // into the window, more turns cannot help — they only guarantee a
                // 400. Stopping there with an honest message beats sending a
                // request that is certain to be rejected.
                let threshold = (max_turns - 1).max((max_turns as f64 * 0.8) as u32);
                if turns >= threshold {
                    // 2026-11-20 (user decision, competitor-aligned): the ONLY
                    // early stop left is context exhaustion. The old
                    // `|| loop_reminders >= MAX_LOOP_REMINDERS` disjunct killed
                    // a healthy debugging run (work-mwod1kcs) whose "repeats"
                    // were a fingerprint-truncation artefact; even with the
                    // fingerprint fixed, repetition is a strategy signal for
                    // the model (advisory reminders), not a kill signal for
                    // the harness — Claude Code / Codex / DSH all agree.
                    if context_exhausted {
                        let msg = format!(
                            "Stopped after {} turns (context window exhausted); the task may be incomplete. \
                             Starting a new session, or lowering the retained history, will give it room to continue.",
                            turns.saturating_sub(1)
                        );
                        // Ended on its own, not by Stop → hand the interjections
                        // back rather than discarding what the user typed.
                        steer_exit!(Frame::steer_dropped, true);
                        emit!(Frame::error(&config.session_id, &msg));
                        return ReActResult {
                            final_answer: msg,
                            turns_used: turns,
                            usage: total_usage,
                            stop_reason: StopReason::MaxTurns,
                            next_seq: seq,
                            messages,
                            pending_command: None,
                            pending_timeout_ms: None,
                            pending_background: false,
                            pending_tool_call_id: None,
                        };
                    }
                    // Java: `addTurns = max(10, initialMaxTurns / 2)`
                    let add = 10u32.max(initial_max_turns / 2);
                    max_turns += add;
                    info!(
                        session = %config.session_id,
                        turn = turns,
                        max_turns,
                        "auto-rethink: extending turn budget and injecting self-review"
                    );
                    messages.push(ChatMessage::user(rethink_prompt(turns)));
                    // The self-review is itself a convergence-oriented injection,
                    // so arm the gate: a reply of "on reflection, continuing is
                    // the right move" is an intent declaration, not an answer.
                    converge_pending = true;
                }
            } else if turns > max_turns {
                // Hard stop, matching Java's standard (non-AutoRethink) branch.
                let msg = format!(
                    "Reached maximum turns ({}). Task may be incomplete.",
                    max_turns
                );
                steer_exit!(Frame::steer_dropped, true);
                emit!(Frame::error(&config.session_id, &msg));
                return ReActResult {
                    final_answer: msg,
                    turns_used: turns,
                    usage: total_usage,
                    stop_reason: StopReason::MaxTurns,
                    next_seq: seq,
                    messages,
                    pending_command: None,
                    pending_timeout_ms: None,
                    pending_background: false,
                    pending_tool_call_id: None,
                };
            }

            // ── Interjection (steer) injection ───────────────────────────────
            // Drained here, at the start of a reasoning step, which is the only
            // point where new user input can enter a live turn without breaking
            // tool-call pairing.
            if let Some(dir) = config.session_dir.as_ref() {
                let mut applied: Vec<serde_json::Value> = Vec::new();
                // `shift_steer`, never `shift`: plain queued messages are the
                // frontend's to dispatch as their own later turns. Swallowing them
                // here put them in the model's context while the UI was still
                // waiting on them, which is how a typed message could end up both
                // acted-on and invisible.
                while let Some(item) = queue_mgr.shift_steer(dir) {
                    info!(
                        session = %config.session_id,
                        steer = %item.origin_steer_id.as_deref().unwrap_or("-"),
                        "injecting queued interjection"
                    );
                    // Every drained item carries a usable id by construction
                    // (`shift_steer` selects on it), so the `if let` is the
                    // invariant check, not an expected skip.
                    if let Some(env) = steer_envelope(&item, &config.run_id) {
                        applied.push(env);
                    }
                    let text = queued_message_text(&item);
                    if !text.trim().is_empty() {
                        messages.push(ChatMessage::user(text));
                        // A steer can change the goal, so the next text-only reply
                        // must not be taken as final without a check.
                        converge_pending = true;
                    }
                }
                // Emitted even when nothing was injected into `messages` (a pure
                // attachment interjection whose file failed to read): the frontend
                // resolves its pending chip on this frame, so staying silent there
                // would hang the UI on "accepted" forever. Java does the same —
                // `SteerInterceptor` logs "skipped empty injection" and still lets
                // WebGate publish the applied event.
                if !applied.is_empty() {
                    emit!(Frame::steer_applied(
                        &config.session_id,
                        serde_json::json!({ "count": applied.len(), "items": applied }),
                    ));
                }
            }

            // P3: background completion notices (Java `injectBackgroundNotices`).
            // Drained at the top of every reasoning turn: "the kernel tells the
            // model" instead of "the model polls bash_output", saving one full LLM
            // round-trip per poll. Injected as user messages (some providers reject
            // mid-history system messages — same rationale as Java). No notice ⇒ no
            // message, no allocation, no behavior change.
            let notices = bg_gate::drain(&config.session_id).await;
            if !notices.is_empty() {
                info!(
                    session = %config.session_id,
                    turn = turns,
                    count = notices.len(),
                    "injecting background completion notice(s)"
                );
                for n in notices {
                    messages.push(ChatMessage::user(n));
                    // A notice can change what "done" means: the next text-only
                    // reply must not be taken as final without a check.
                    converge_pending = true;
                }
            }

            // Emit reason_start (carries turnStartMs so the meter's elapsed row
            // restarts immediately instead of freezing on the previous trace).
            emit!(Frame::reason_start(
                &config.session_id,
                config.turn_start_ms
            ));

            // Repair before sending, too: history rebuilt from disk may already
            // contain an orphan from a run that died before this gate existed
            // (or from a crash mid-turn). Without this the very first request of
            // a resumed session 400s and burns every retry on the same payload.
            let orphans = repair_tool_pairing(&mut messages);
            if orphans > 0 {
                warn!(session = %config.session_id, orphans, "repaired orphaned tool_calls in loaded history");
            }

            // Stream LLM response
            let mut rx = match client
                .stream_chat(messages.clone(), tools.clone(), config.thinking.as_deref())
                .await
            {
                Ok(rx) => rx,
                Err(e) => {
                    let msg = format!("Failed to start LLM stream: {}", e);
                    emit!(Frame::error(&config.session_id, &msg));
                    return ReActResult {
                        final_answer: msg,
                        turns_used: turns,
                        usage: total_usage,
                        stop_reason: StopReason::Error,
                        next_seq: seq,
                        messages,
                        pending_command: None,
                        pending_timeout_ms: None,
                        pending_background: false,
                        pending_tool_call_id: None,
                    };
                }
            };

            // Accumulate the response
            let mut content_buf = String::new();
            // Thinking/reasoning text of this round, accumulated for the
            // **corruption gate only** — never fed back into `messages`
            // (`ChatMessage` has no reasoning field; Java keeps its
            // `streamedReasoningBuf` for replay suppression, not history).
            //
            // It must exist because `ReasoningDelta` is emit-only: without a
            // buffer the gate can only see `content_buf`, so a turn whose
            // damage lands in the *thinking* block passes as clean. That is the
            // reported "思考也有乱码" case — long-thinking models emit minutes of
            // reasoning with zero content, so on those runs the gate would have
            // had nothing to look at at all.
            let mut reasoning_buf = String::new();
            let mut tool_calls: Vec<ToolCall> = Vec::new();
            let mut stream_error: Option<String> = None;
            // P2 caps 1+2 start when the first byte of *this* stream is
            // awaited; idle is measured chunk-to-chunk, total from first
            // select (Java: idle latch reset per event, total latch per stream).
            // Any frame from the upstream — content, reasoning, tool-call
            // start/args, usage — proves the connection is alive and resets the
            // idle clock. See the reset in the `rx.recv()` arm below.
            let stream_started_at = std::time::Instant::now();
            let mut last_chunk_at = std::time::Instant::now();
            // A fresh model call = a fresh first-token clock. This covers the
            // react-layer retries (empty/partial-output failure, corruption gate)
            // that re-issue the request through `continue` without a transport
            // Retry event — without the reset the new call would either carry a
            // stale reading or (after an Error-only attempt) show '--' until the
            // next turn settles. Tool-execution gaps deliberately keep the last
            // reading: the card shows the most recent model response's latency.
            model_ttft_ms = None;
            // Start of the first visible model output in this stream; the decode
            // segment is [first_content_at, usage settlement]. None until a real
            // content/reasoning delta arrives (Java TurnTimer.onVisibleOutput).
            let mut first_content_at: Option<std::time::Instant> = None;
            let mut idle_expired = false;
            let mut total_expired = false;
            // Per-tool-call argument-progress throttle state, keyed by stream
            // index (Java keys by `toolCallKey`, which is the same index).
            let mut args_progress: HashMap<u32, ArgsProgress> = HashMap::new();
            // Live decode-speed meter for this model call. Event-driven: it only
            // emits when a real delta arrives AND a full interval has elapsed,
            // so no timer task is created and the idle cap still sees silence.
            let mut tps_meter = TpsMeter::new(std::time::Instant::now());
            // `finish_reason` of the stream that ended this round. `length`
            // means the model hit its output cap rather than finishing, which
            // is the *actionable* half of a truncated tool-call error: the fix
            // is a larger cap or a smaller argument, not a retry.
            let mut finish_reason = String::new();

            // Cancellation must be checked *inside* the receive loop, not only
            // between turns. A single streamed completion can run for minutes on a
            // long answer, and the previous `while let Some(event) = rx.recv()`
            // form had no exit other than the stream ending on its own — so Stop
            // appeared to do nothing until the model finished the whole turn.
            // Dropping `rx` here also drops the request task, closing the
            // connection instead of leaving it streaming into a dead run.
            loop {
                // P2: measure idle against the last *received* event, total
                // against the stream's start, before every select. A stream
                // that stalls with no data at all still trips here — the
                // cancelled arm below is not the only reason a select needs a
                // third arm.
                if last_chunk_at.elapsed() > stream_idle_cap {
                    idle_expired = true;
                    break;
                }
                if stream_started_at.elapsed() > stream_total_cap {
                    total_expired = true;
                    break;
                }
                let event = tokio::select! {
                    biased;
                    _ = tokio::time::sleep_until(tokio::time::Instant::from_std(
                        last_chunk_at + stream_idle_cap,
                    )) => {
                        idle_expired = true;
                        break;
                    }
                    _ = tokio::time::sleep_until(tokio::time::Instant::from_std(
                        stream_started_at + stream_total_cap,
                    )) => {
                        total_expired = true;
                        break;
                    }
                    ev = rx.recv() => match ev {
                        Some(ev) => {
                            // ANY event from the transport is liveness, not just
                            // `ContentDelta`. Long-thinking models emit a stream of
                            // `ReasoningDelta` with zero content for minutes, and a
                            // large tool argument is nothing but
                            // `ToolCallArgsDelta`. Resetting only on visible text
                            // (the old behaviour) turned the idle cap into a
                            // from-stream-start total cap: a healthy, active
                            // reasoning stream was killed at 150s as "no data
                            // received" even though frames never stopped — the
                            // exact "thinking done then timeout + retry" symptom.
                            // Java's `req.stream().timeout(idleCap)` resets its
                            // latch on every onNext of *any* event type; this is
                            // the equivalent. A genuinely dead stream emits
                            // nothing, so it still trips both sleep arms above.
                            last_chunk_at = std::time::Instant::now();
                            // TTFT = model first-token latency: the FIRST upstream
                            // frame of this call proves the model responded — a
                            // tool-call frame counts exactly like a text delta
                            // (the old visible-only latch charged minutes of local
                            // tool execution into "first token", session
                            // work-mwlhix12: 518.50s). Latched once per call; each
                            // new call / transport retry re-arms it (fresh clock).
                            //
                            // Retry AND Error are transport-generated signals, NOT
                            // model output: an exhausted attempt's Error must never
                            // latch a fake "first token" (that would violate the
                            // null-vs-0 contract: the model never responded).
                            if model_ttft_ms.is_none()
                                && !matches!(ev, StreamEvent::Retry { .. } | StreamEvent::Error(_))
                            {
                                model_ttft_ms = ttft_ms_since(stream_started_at, Some(last_chunk_at));
                            }
                            ev
                        }
                        None => break,
                    },
                    _ = cancel.cancelled() => {
                        info!(session = %config.session_id, turn = turns, "cancelled during LLM stream");
                        // Same contract as the turn-boundary check above: the
                        // frontend needs `done` to leave its streaming state.
                        steer_exit!(Frame::steer_cancelled, false);
                        emit!(Frame::done(&config.session_id));
                        return ReActResult {
                            final_answer: String::new(),
                            turns_used: turns,
                            usage: total_usage,
                            stop_reason: StopReason::Cancelled,
                            next_seq: seq,
                            messages,
                            pending_command: None, pending_timeout_ms: None, pending_background: false,
                            pending_tool_call_id: None,
                        };
                    }
                };
                match event {
                    StreamEvent::ContentDelta(delta) => {
                        content_buf.push_str(&delta);
                        let now = std::time::Instant::now();
                        // `first_content_at` times the authoritative decode segment
                        // for the settlement frame. TTFT is latched separately at
                        // the transport (`rx.recv()` arm) on the first upstream
                        // frame of ANY kind, so nothing to do here.
                        if first_content_at.is_none() {
                            first_content_at = Some(now);
                        }
                        // `note_delta` re-anchors on this model call's FIRST visible
                        // delta (per-turn, not run-level): prefill/TTFT wait must not
                        // enter any speed window, including turns 2+ and retries.
                        // The first-delta frame carries the latched TTFT immediately,
                        // with no speed yet, instead of waiting for the first 500 ms.
                        if tps_meter.note_delta(now) {
                            emit!(Frame::tps_progress(&config.session_id, 0, 0, model_ttft_ms,));
                        }
                        emit!(Frame::text_delta(&config.session_id, &delta));
                        if tps_meter.should_emit(now) {
                            // `should_emit` guarantees tokens > 0 && ms >= 500, so
                            // no window is ever consumed without a frame going out.
                            let (tokens, ms) = tps_meter.take_window(now);
                            emit!(Frame::tps_progress(
                                &config.session_id,
                                ms,
                                tokens,
                                model_ttft_ms,
                            ));
                        }
                    }
                    StreamEvent::ReasoningDelta(delta) => {
                        reasoning_buf.push_str(&delta);
                        emit!(Frame::reason(&config.session_id, &delta));
                        let now = std::time::Instant::now();
                        if first_content_at.is_none() {
                            first_content_at = Some(now);
                        }
                        if tps_meter.note_delta(now) {
                            emit!(Frame::tps_progress(&config.session_id, 0, 0, model_ttft_ms,));
                        }
                        if tps_meter.should_emit(now) {
                            let (tokens, ms) = tps_meter.take_window(now);
                            emit!(Frame::tps_progress(
                                &config.session_id,
                                ms,
                                tokens,
                                model_ttft_ms,
                            ));
                        }
                    }
                    StreamEvent::ToolCallStart { index, id, name } => {
                        while tool_calls.len() <= index as usize {
                            tool_calls.push(ToolCall {
                                id: String::new(),
                                call_type: "function".into(),
                                function: crate::llm::FunctionCall {
                                    name: String::new(),
                                    arguments: String::new(),
                                },
                            });
                        }
                        tool_calls[index as usize].id = id.clone();
                        tool_calls[index as usize].function.name = name.clone();

                        // Skeleton card, emitted the moment the model names the
                        // function — before a single argument byte exists.
                        //
                        // Without this the screen stays blank for the whole
                        // argument-streaming phase (80+ s for a large `write`),
                        // because `action_args` only updates a card that already
                        // exists and `action_start` is not emitted until the
                        // arguments are complete. See `Frame::action_draft`.
                        //
                        // Degrade exactly like Java: no id or no name means the
                        // endpoint gave us nothing to pair a skeleton with, so
                        // emit nothing and let `action_start` build the card.
                        //
                        // 契约 §4.2：ask_user / complete_task 不建骨架卡（生命周期
                        // 帧抑制，见 LIFECYCLE_SUPPRESSED_TOOLS）。仍记 args_progress
                        // 以便执行段统一 remove，避免节流状态泄漏到后续轮次。
                        if !id.is_empty() && !name.is_empty() {
                            args_progress.insert(index, ArgsProgress::new(now_ms()));
                            if !lifecycle_suppressed(&name) {
                                emit!(Frame::action_draft(&config.session_id, &name, &id));
                            }
                        }
                    }
                    StreamEvent::ToolCallArgsDelta { index, args } => {
                        if let Some(tc) = tool_calls.get_mut(index as usize) {
                            tc.function.arguments.push_str(&args);
                            // Report progress (cumulative bytes), throttled.
                            //
                            // Every delta used to emit a frame. A model streaming a
                            // large argument in small chunks produces thousands of
                            // deltas, so that was a frame storm: each one is a WS
                            // write plus a DOM update on the client. Java applies a
                            // dual threshold (time OR bytes) for exactly this
                            // reason; the constants match it.
                            let bytes = tc.function.arguments.len() as u64;
                            let id = tc.id.clone();
                            // 契约 §4.2：抑制名单内的工具无骨架卡，进度帧无处可更新，
                            // 跳过（仍累计 bytes，执行段的收尾 flush 同样被抑制）。
                            let suppressed = lifecycle_suppressed(&tc.function.name);
                            if let Some(p) = args_progress.get_mut(&index) {
                                p.bytes = bytes;
                                if !suppressed && p.should_emit(now_ms()) {
                                    p.mark_emitted(bytes, now_ms());
                                    emit!(Frame::action_args(&config.session_id, &id, bytes));
                                }
                            } else {
                                // No draft was registered (the endpoint gave no
                                // id/name), so there is no skeleton card to
                                // update. Emitting progress for a card that does
                                // not exist is a no-op on the client; skip it.
                            }
                        }
                    }
                    StreamEvent::Retry {
                        attempt,
                        max,
                        reason,
                        delivered,
                    } => {
                        // The transport is re-issuing the same request.
                        //
                        // 【2026-11 用户决策】首字节前的失败也到达这里
                        // （delivered=false）：旧实现静默重试，用户观感是
                        // 「报错了但根本没重试」。现在两种形态都发 retry 帧，
                        // 计数一律是 attempt/modelRetries（Java
                        // RetryNotifyInterceptor 契约），不再是 turns/maxTurns。
                        // A retry is a brand-new request: the model's first-token
                        // clock restarts with it (both delivered and pre-first-byte
                        // failures). The next attempt's first upstream frame
                        // re-latches `model_ttft_ms` at the transport.
                        //
                        // 口径边界（有意为之）：时钟锚点是 stream_started_at（本
                        // 次 stream_chat 的起点），传输层退避（client.rs 的
                        // 500*2^attempt ms）与失败 attempt 的耗时无法在 react 层
                        // 区分，故计入。TTFT 因此是「请求侧首字延迟」的保守上界，
                        // 绝不掺入工具执行等本地业务时间。
                        model_ttft_ms = None;
                        if !delivered {
                            // Nothing was rendered: accumulators are empty and
                            // the DOM has no seam to roll back. Only surface the
                            // retry banner (no discardPartial). The decode latch
                            // stays untouched — no visible delta ever happened,
                            // so there is nothing to re-anchor.
                            warn!(
                                session = %config.session_id,
                                turn = turns,
                                attempt,
                                max,
                                error = %reason,
                                "stream attempt failed before first byte; retrying (visible)"
                            );
                            last_chunk_at = std::time::Instant::now();
                            emit!(Frame::retry(&config.session_id, attempt, max, &reason));
                            continue;
                        }
                        // The failed attempt had *already* delivered deltas.
                        // Every accumulator below has absorbed those deltas, so
                        // they must be dropped or the retry appends on top:
                        //
                        // - `content_buf`  → the answer rendered twice;
                        // - `tool_calls`   → two argument streams concatenated
                        //   into one `arguments` string, which is invalid JSON
                        //   and aborts the turn as "truncated mid tool-call
                        //   arguments" — a self-inflicted failure the message
                        //   blames on the model;
                        // - `args_progress`→ stale byte counts for skeleton
                        //   cards whose ids the new attempt will never reuse.
                        //
                        // Java needs no such branch: its accumulators are locals
                        // inside the `callWithRetry` lambda (`streamedReasoningBuf`,
                        // `argsProgresses` in `ReasonTask.java`), rebuilt on
                        // every physical attempt. Here the retry loop lives one
                        // layer *below* the accumulators, so the reset has to be
                        // driven by the event.
                        //
                        // The frontend is told the same thing (`discardPartial`),
                        // because the deltas already reached the DOM: clearing
                        // engine state alone would leave a half-typed bubble and
                        // orphan skeleton cards on screen.
                        warn!(
                            session = %config.session_id,
                            turn = turns,
                            attempt,
                            max,
                            error = %reason,
                            "stream attempt delivered partial output; discarding accumulators before transport retry"
                        );
                        content_buf.clear();
                        reasoning_buf.clear();
                        tool_calls.clear();
                        // A transport retry discards the partial deltas: the timed
                        // decode segment of the aborted attempt must start over too.
                        first_content_at = None;
                        args_progress.clear();
                        // A fresh meter + a cleared per-turn marker means the next
                        // attempt's first visible delta re-anchors the window again,
                        // so its prefill wait is excluded just like any other turn.
                        let retry_now = std::time::Instant::now();
                        tps_meter = TpsMeter::new(retry_now);
                        // The retry restarts the round's clock: the new attempt
                        // is a fresh stream, and measuring the idle/total caps
                        // against the aborted one would trip them immediately.
                        last_chunk_at = std::time::Instant::now();
                        emit!(Frame::stream_retry(
                            &config.session_id,
                            attempt,
                            max,
                            &reason
                        ));
                    }
                    StreamEvent::Done {
                        finish_reason: fr,
                        usage,
                    } => {
                        finish_reason = fr;
                        // A provider may omit `usage` (or the stream may end
                        // abnormally). The frontend ends its live speed window on
                        // `context_size`, so we deliberately leave that case to the
                        // frontend's `done` fallback instead of fabricating a zero
                        // settlement frame here — a zero payload would be persisted,
                        // replayed and counted by `session_usage::sum_usage` as if it
                        // were a real model call.
                        if let Some(u) = usage {
                            // Accumulate via UsageInfo::add so prompt_tokens sums
                            // the *normalised* input (cache included) exactly like
                            // Java's Metrics.addUsage; the old field-by-field +=
                            // dropped cache tokens entirely.
                            total_usage.add(&u);
                            // Close the decode segment: only a stream that produced
                            // visible output AND reported completion tokens counts.
                            // Duration and tokens are accumulated as a pair, so a
                            // missing half can never inflate the speed (Java
                            // TurnTimer.onUsageSettled).
                            if let Some(t0) = first_content_at.take() {
                                let gen_ms = t0.elapsed().as_millis() as u64;
                                if gen_ms > 0 && u.completion_tokens > 0 {
                                    generation_ms_total =
                                        generation_ms_total.saturating_add(gen_ms);
                                    generated_tokens_total = generated_tokens_total
                                        .saturating_add(u.completion_tokens as u64);
                                }
                            }
                            let input = u.normalized_input();
                            emit!(Frame::context_size(
                                &config.session_id,
                                &crate::protocol::ContextSizePayload {
                                    input_tokens: input,
                                    output_tokens: u.completion_tokens,
                                    cache_read: u.effective_cache_read(),
                                    cache_creation: u.cache_creation_tokens,
                                    cache_rate: crate::llm::types::cache_hit_rate(
                                        input,
                                        u.effective_cache_read()
                                    ),
                                    message_count: messages.len() as u64,
                                    context_length: config.context_length,
                                    turn_start_ms: config.turn_start_ms,
                                    total_input: seed
                                        .input_tokens()
                                        .saturating_add(total_usage.prompt_tokens),
                                    total_output: seed
                                        .output_tokens()
                                        .saturating_add(total_usage.completion_tokens),
                                    total_cache_creation: seed
                                        .cache_creation_tokens()
                                        .saturating_add(total_usage.cache_creation_tokens),
                                    total_cache_read: seed
                                        .cache_read_tokens()
                                        .saturating_add(total_usage.cache_read_tokens),
                                    // Java counts user frames + trace frames; the
                                    // in-flight AI turn has no trace yet, so it is
                                    // not counted until its run closes.
                                    total_messages: seed.message_count(),
                                    generation_ms: generation_ms_total,
                                    generated_tokens: generated_tokens_total,
                                    ttft_ms: model_ttft_ms,
                                }
                            ));
                            // Anchor the local estimator to the provider's real
                            // count for the next turn (Java
                            // `calibrateWithRealUsage`). The estimate and the
                            // billing tokenizer disagree — different vocabularies
                            // plus per-request overhead — and without this the
                            // compression trigger fires on a guess.
                            if u.prompt_tokens > 0 {
                                calibration = crate::compress::Calibration {
                                    real_tokens: u.prompt_tokens as i64,
                                    real_message_count: messages.len(),
                                };
                            }
                        }
                    }
                    StreamEvent::Error(msg) => {
                        warn!(error = %msg, "LLM stream error");
                        stream_error = Some(msg);
                    }
                }
            }

            // P2: if the stream expired idle/total, synthesise the error
            // here so it flows through the same retry/fail classification as
            // provider-reported errors (rather than a bespoke exit path that
            // would have to re-implement the timeout bucket below).
            if stream_error.is_none() {
                if idle_expired {
                    stream_error = Some(format!(
                        "LLM stream timed out: no data received for {}s",
                        stream_idle_cap.as_secs()
                    ));
                    warn!(
                        session = %config.session_id,
                        turn = turns,
                        idle_secs = stream_idle_cap.as_secs(),
                        "stream idle cap reached; treating as timeout-class failure"
                    );
                } else if total_expired {
                    stream_error = Some(format!(
                        "LLM stream exceeded total cap of {}s",
                        stream_total_cap.as_secs()
                    ));
                    warn!(
                        session = %config.session_id,
                        turn = turns,
                        total_secs = stream_total_cap.as_secs(),
                        "stream total cap reached; treating as timeout-class failure"
                    );
                }
            }

            // If the stream errored and produced nothing, retry or fail
            if let Some(err) = stream_error {
                if content_buf.is_empty() && tool_calls.is_empty() {
                    // 【2026-11 用户决策】非 200 一律重试：不再按错误类别
                    // 快速失败（旧 is_non_retryable 门控把网关 403 排队判成
                    // 致命，第 1 次就放弃）。重试次数 = 用户设置的
                    // modelRetries（与传输层同一预算、同一 clamp），计数
                    // 展示 attempt/modelRetries，不再是 turns/maxTurns。
                    // 保留的护栏：超时类每轮 ≤2（系统性慢上游）、单次调用
                    // 45 分钟总预算。二者都只在重试路径上生效。
                    let timeout_class = crate::llm::client::is_timeout_class(&err);
                    // P2 cap 4: timeout-class failures ≤2 per round (Java:
                    // “连续两次都超时说明是系统性原因，第三次同样会超时”).
                    // AutoRethink keeps `turns < max_turns` permanently true,
                    // so without this bucket an upstream outage retries forever
                    // — the work-mua28gy6 shape.
                    //
                    // Cap 3: this model call's whole retry budget. Any failure
                    // class. Re-armed per turn (Java `RetryTask` lifetime), shared
                    // by this call's retries, `Instant`-based so a wall-clock jump
                    // cannot fake-extend it.
                    let timeout_out =
                        timeout_class && timeout_retries >= MAX_TIMEOUT_RETRIES_PER_TURN;
                    let deadline_out = std::time::Instant::now() > retry_deadline;
                    let retries_out = call_retries >= model_retry_budget;
                    if !timeout_out && !deadline_out && !retries_out {
                        if timeout_class {
                            timeout_retries += 1;
                        }
                        call_retries += 1;
                        // Same call, so keep its deadline (see the re-arm point at
                        // the top of this loop).
                        retry_of_same_call = true;
                        emit!(Frame::retry(
                            &config.session_id,
                            call_retries,
                            model_retry_budget,
                            &err
                        ));
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                        continue;
                    } else {
                        let msg = if timeout_out {
                            format!(
                                "{}\nTimeout-class failures happened {} times this turn; the \
                                 upstream appears systemically slow, so the run stopped instead \
                                 of retrying identical requests. Check the provider status, or \
                                 increase the model timeout in settings.",
                                err, MAX_TIMEOUT_RETRIES_PER_TURN
                            )
                        } else if deadline_out {
                            format!(
                                "{}\nThis model call has spent {} minutes retrying without one \
                                 successful response, so the run stopped instead of retrying the \
                                 same request again. Resend the message to continue.",
                                err,
                                MODEL_CALL_RETRY_DEADLINE_SECS / 60
                            )
                        } else if retries_out {
                            format!(
                                "{}\nModel call failed after {} retries (the modelRetries budget \
                                 in settings). Resend the message to continue.",
                                err, model_retry_budget
                            )
                        } else {
                            err
                        };
                        emit!(Frame::error(&config.session_id, &msg));
                        return ReActResult {
                            final_answer: msg,
                            turns_used: turns,
                            usage: total_usage,
                            stop_reason: StopReason::Error,
                            next_seq: seq,
                            messages,
                            pending_command: None,
                            pending_timeout_ms: None,
                            pending_background: false,
                            pending_tool_call_id: None,
                        };
                    }
                } else {
                    // The stream died *after* producing partial output (gateway
                    // timeout, proxy reset, provider crash). The accumulated
                    // text or half-streamed tool calls are NOT a final answer:
                    // closing the run here is exactly the "task ended
                    // unfinished, no explanation" failure users report.
                    //
                    // This used to give up unconditionally, because re-running
                    // the turn would render the answer twice — the partial
                    // deltas had already reached the UI and nothing could take
                    // them back. That is no longer true: `Frame::stream_retry`
                    // carries `discardPartial`, and the frontend
                    // (`discardPartialRetryDom`) rolls back exactly the blocks
                    // this attempt produced, leaving already-executed tools of
                    // earlier turns untouched. So the turn can now be retried
                    // under the same budget as an empty-output failure.
                    //
                    // Java behaves this way too: its accumulators live inside
                    // the `callWithRetry` lambda, so a retry starts clean.
                    //
                    // 【2026-11 用户决策】与空输出分支同契约：非 200 一律
                    // 重试，次数 = modelRetries，计数 attempt/modelRetries。
                    let timeout_class = crate::llm::client::is_timeout_class(&err);
                    let timeout_out =
                        timeout_class && timeout_retries >= MAX_TIMEOUT_RETRIES_PER_TURN;
                    let deadline_out = std::time::Instant::now() > retry_deadline;
                    let retries_out = call_retries >= model_retry_budget;
                    if !timeout_out && !deadline_out && !retries_out {
                        if timeout_class {
                            timeout_retries += 1;
                        }
                        call_retries += 1;
                        // Discard before signalling, so the retry frame is the
                        // only thing left on screen from this attempt.
                        content_buf.clear();
                        reasoning_buf.clear();
                        tool_calls.clear();
                        args_progress.clear();
                        finish_reason.clear();
                        warn!(
                            session = %config.session_id,
                            turn = turns,
                            error = %err,
                            "stream died after partial output; discarding it and retrying the turn"
                        );
                        emit!(Frame::stream_retry(
                            &config.session_id,
                            call_retries,
                            model_retry_budget,
                            &err
                        ));
                        // Same call, so keep its deadline (see the re-arm point at
                        // the top of this loop).
                        retry_of_same_call = true;
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                        continue;
                    }
                    let msg = format!(
                        "LLM stream failed after partial output ({}). The incomplete turn was discarded rather than treated as a final answer; send the message again to retry.",
                        err
                    );
                    warn!(session = %config.session_id, turn = turns, error = %err, "stream truncated mid-response; aborting turn");
                    emit!(Frame::error(&config.session_id, &msg));
                    return ReActResult {
                        final_answer: msg,
                        turns_used: turns,
                        usage: total_usage,
                        stop_reason: StopReason::Error,
                        next_seq: seq,
                        messages,
                        pending_command: None,
                        pending_timeout_ms: None,
                        pending_background: false,
                        pending_tool_call_id: None,
                    };
                }
            }

            // A round that reached the model (stream completed, any content)
            // resets the timeout bucket: Java's counter is per-turn, so one
            // healthy round must not carry the previous round's timeouts.
            timeout_retries = 0;

            // Filter out empty tool calls
            tool_calls.retain(|tc| !tc.id.is_empty() && !tc.function.name.is_empty());

            // ── Corruption gate ──────────────────────────────────────────────
            //
            // Must run BEFORE the broken-JSON check below: a mangled argument
            // stream is usually *also* invalid JSON, and the two need opposite
            // remedies. "Arguments incomplete" is either a length cap (retrying
            // is futile) or a dropped connection; this one is upstream damage to
            // a stream the transport considered successful, so a clean retry is
            // exactly right and must not be pre-empted by the wrong error text.
            //
            // Damage site decides the terminal behaviour, and the split is the
            // whole point:
            //
            // - **tool call** → never execute, retry clean, then fail hard.
            //   A corrupt `file_path` is still valid JSON, so it passed the
            //   broken check and ran a real `read` of a nonsense path
            //   (work-mw8wizyz: the "File not found" card the user reported, and
            //   then the model spent its whole turn chasing that garbage). The
            //   same damage on a `write` would destroy a real file.
            // - **prose/thinking** → retry clean, then keep the output and warn.
            //   Deliberately NOT fatal: U+FFFD is a legitimate character a model
            //   can emit (debugging a codec, reviewing this very bug), and
            //   killing a healthy run over it repeats a mistake already made once
            //   in this file — the removed P4 "diminishing output" pair of checks
            //   judged healthy agent rounds as filler and terminated a run that
            //   had 13 successful tool calls on record (see the "no output-volume
            //   or no-progress judgement" note near the run's local counters,
            //   and `turn_budget_has_no_output_volume_or_no_progress_gate`).
            //   Text the user can still read beats an error bubble.
            let corrupt_tools = corrupt_argument_calls(&tool_calls);
            // `prose_hits` covers BOTH the answer and the thinking block. They
            // are the same class of damage (a readable-text corruption with no
            // tool to protect), so they share the remedy: retry clean, then keep
            // the output with a warning. Scanning only `content_buf` would leave
            // the reported "思考也有乱码" case undetected on long-thinking models,
            // which emit reasoning for minutes with an empty content buffer.
            let mut prose_hits = corruption_signatures(&content_buf);
            for sig in corruption_signatures(&reasoning_buf) {
                if !prose_hits.contains(&sig) {
                    prose_hits.push(sig);
                }
            }
            if !corrupt_tools.is_empty() || !prose_hits.is_empty() {
                let retryable = corruption_retries < MAX_CORRUPTION_RETRIES
                    && std::time::Instant::now() <= retry_deadline
                    && turns < max_turns;
                if retryable {
                    corruption_retries += 1;
                    // Same shape as the partial-output retry path, and for the
                    // same defensive reason: drop every accumulator so the retry
                    // cannot concatenate onto the damaged half, and tell the
                    // frontend to roll back what this attempt already rendered
                    // (discardPartial) — otherwise the garbled bubble and the
                    // orphan skeleton cards stay on screen beside the retry's
                    // clean output, which is exactly the "old card shapes still
                    // showing" complaint.
                    //
                    // These are technically redundant: `continue` re-enters the
                    // turn loop, which re-declares all of them per round. They
                    // stay because the partial-output retry above clears them
                    // too, and a future edit that moves the declarations outside
                    // the loop would otherwise turn this into a silent
                    // concatenate-onto-garbage bug.
                    content_buf.clear();
                    reasoning_buf.clear();
                    tool_calls.clear();
                    args_progress.clear();
                    finish_reason.clear();
                    warn!(
                        session = %config.session_id,
                        turn = turns,
                        attempt = corruption_retries,
                        max = MAX_CORRUPTION_RETRIES,
                        corrupt_tools = %corrupt_tools.join(","),
                        prose_signatures = %prose_hits.join(","),
                        "upstream stream corruption detected; discarding partial output and retrying clean"
                    );
                    emit!(Frame::stream_retry(
                        &config.session_id,
                        corruption_retries,
                        MAX_CORRUPTION_RETRIES,
                        &format!(
                            "上游返回的数据已损坏（{}）",
                            if corrupt_tools.is_empty() {
                                prose_hits.join(",")
                            } else {
                                let mut all = corrupt_tools.clone();
                                all.extend(prose_hits.iter().map(|s| s.to_string()));
                                all.join(",")
                            }
                        ),
                    ));
                    // Same call, so keep its retry deadline (see the re-arm
                    // point at the top of this loop).
                    retry_of_same_call = true;
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    continue;
                }

                if !corrupt_tools.is_empty() {
                    // The parenthetical must name the damage, and it must never be
                    // empty: in the shape actually reported (corrupt tool arguments,
                    // readable prose) `prose_hits` is empty, so interpolating it
                    // alone printed "corrupted ()" — a message that looks broken
                    // while the run is failing. Fall back to naming the damaged
                    // call itself, which is the evidence the user can act on.
                    let damage = if prose_hits.is_empty() {
                        format!("damaged arguments in: {}", corrupt_tools.join(", "))
                    } else {
                        prose_hits.join(", ")
                    };
                    let msg = format!(
                        "The model stream was corrupted ({}), so the tool call(s) {} were \
                         NOT executed — running them on damaged arguments risks writing to \
                         the wrong file. The damaged output was discarded rather than treated \
                         as a result. Resend the message to retry; if it keeps happening, \
                         switch model or provider.",
                        damage,
                        corrupt_tools.join(", ")
                    );
                    warn!(
                        session = %config.session_id,
                        turn = turns,
                        tools = %corrupt_tools.join(","),
                        retries = corruption_retries,
                        "corrupted tool-call arguments after retries exhausted; refusing to execute"
                    );
                    steer_exit!(Frame::steer_dropped, true);
                    // Discarding error: the final attempt's damaged deltas are
                    // already rendered (garbled bubble + orphan skeleton cards)
                    // and no `stream_retry` will follow to clear them, since
                    // that only fires *before* a retry. Roll them back so the
                    // error replaces known-bad bytes instead of sitting under
                    // them — the "old card shapes still showing" complaint.
                    emit!(Frame::error_discarding(&config.session_id, &msg));
                    return ReActResult {
                        final_answer: msg,
                        turns_used: turns,
                        usage: total_usage,
                        stop_reason: StopReason::Error,
                        next_seq: seq,
                        messages,
                        pending_command: None,
                        pending_timeout_ms: None,
                        pending_background: false,
                        pending_tool_call_id: None,
                    };
                }

                // Prose-only damage, retries exhausted: keep the answer, but say
                // so. U+FFFD is visible in the text itself; naming the cause is
                // what stops it looking like a model that went mad.
                warn!(
                    session = %config.session_id,
                    turn = turns,
                    signatures = %prose_hits.join(","),
                    retries = corruption_retries,
                    "corrupted model text after retries exhausted; surfacing it with a warning"
                );
                // Only when there is nothing left to run. An `error` frame makes
                // the client call `markToolCardFailed`, which would stamp the
                // *legitimate* skeleton cards of this round as failed a moment
                // before we execute them — a red card over work that actually
                // succeeded. Log-only is the honest degradation there.
                if tool_calls.is_empty() {
                    emit!(Frame::error(
                        &config.session_id,
                        &format!(
                            "上游返回的数据存在损坏（{}），以下内容可能包含乱码。",
                            prose_hits.join(", ")
                        ),
                    ));
                }
            }

            // Reject tool calls whose arguments are not valid JSON before
            // executing anything.
            //
            // A `finish_reason=length` truncation (output token cap) or a
            // dropped connection can leave a call's arguments as broken JSON.
            // The per-call parse below used to fall back to `{}` on failure,
            // which *executed the tool with empty arguments* — a `write` with
            // no path, a `bash` with no command — and fed the nonsense result
            // back into reasoning. Aborting the turn is cheaper than a
            // corrupted file or a phantom command run.
            let broken = broken_argument_calls(&tool_calls);
            if !broken.is_empty() {
                // Name the actual cause. "The model truncated" is only true for
                // one of the two ways this happens, and the remedies are
                // opposite:
                //
                // - `finish_reason=length`: we hit the output-token cap, so
                //   resending the *same* message truncates identically. The fix
                //   is a smaller argument or a larger cap. (This was the common
                //   shape while the Anthropic default cap was 8192 instead of
                //   Java's 32000.)
                // - otherwise: the connection died mid-argument, or a transport
                //   retry replayed into a non-cleared accumulator. Resending is
                //   genuinely the right move.
                let cause = if finish_reason == "length" {
                    "the model hit its maximum output token limit"
                } else {
                    "the stream ended before the arguments were complete"
                };
                let remedy = if finish_reason == "length" {
                    "Retry with a smaller edit (split it into several tool calls) or raise the model's maximum output tokens; resending the same request will truncate the same way."
                } else {
                    "Send the message again to retry."
                };
                let msg = format!(
                    "Tool-call arguments were incomplete ({}) because {}; the turn was aborted instead of executing partial calls. {}",
                    broken.join(", "), cause, remedy
                );
                warn!(
                    session = %config.session_id,
                    turn = turns,
                    tools = %broken.join(","),
                    finish_reason = %finish_reason,
                    "truncated tool-call arguments; aborting turn"
                );
                emit!(Frame::error(&config.session_id, &msg));
                return ReActResult {
                    final_answer: msg,
                    turns_used: turns,
                    usage: total_usage,
                    stop_reason: StopReason::Error,
                    next_seq: seq,
                    messages,
                    pending_command: None,
                    pending_timeout_ms: None,
                    pending_background: false,
                    pending_tool_call_id: None,
                };
            }

            if tool_calls.is_empty() {
                // No tool calls → final answer
                let answer = content_buf.trim().to_string();

                // P1: empty-output handling. Neither text nor tool calls can
                // never be progress; the old code fell straight through to
                // `done` + `StopReason::Completed` with an empty final answer,
                // ending a run "normally" with nothing and no explanation —
                // directly contradicting the partial-output branch above, which
                // refuses to treat truncated output as an answer.
                //
                // Java (`ReasonTask.java:685-726`) retries with an injected
                // prompt up to 3 times, but its `return` sits *outside* the
                // `if (count < 3)`: once the counter fills, no prompt is
                // injected, no END is set, and the loop spins with a monotonically
                // growing working memory. That specific shape must NOT be copied
                // — after the cap we stop honestly with an error.
                if answer.is_empty() {
                    empty_rounds += 1;
                    if empty_rounds <= MAX_EMPTY_ROUNDS {
                        warn!(
                            session = %config.session_id,
                            empty_round = empty_rounds,
                            turn = turns,
                            "empty model response; injecting format-correction prompt"
                        );
                        messages.push(ChatMessage::user(empty_response_prompt(
                            turns,
                            empty_rounds,
                        )));
                        continue;
                    }
                    let msg = format!(
                        "Model returned an empty response {} times in a row; the run was \
                         stopped instead of treating silence as completion. Resend the \
                         message to retry, or switch to a different model.",
                        MAX_EMPTY_ROUNDS
                    );
                    warn!(session = %config.session_id, turn = turns, "empty responses exhausted; stopping honestly");
                    steer_exit!(Frame::steer_dropped, true);
                    emit!(Frame::error(&config.session_id, &msg));
                    return ReActResult {
                        final_answer: msg,
                        turns_used: turns,
                        usage: total_usage,
                        stop_reason: StopReason::Error,
                        next_seq: seq,
                        messages,
                        pending_command: None,
                        pending_timeout_ms: None,
                        pending_background: false,
                        pending_tool_call_id: None,
                    };
                }
                empty_rounds = 0;

                // Convergence gate (Java `shouldDeferImplicitEnd`).
                //
                // Right after a self-review, loop warning or steer injection, a
                // text-only reply is often a transitional statement of intent
                // ("evidence is sufficient, now fixing the two P0s") rather than
                // an answer for the user. Judging it final ends the run with the
                // task unfinished — the failure recorded against Java session
                // work-mupc5nd0, where a Loop terminated "normally" at 0/10 TODOs.
                //
                // Bounded at MAX_CONVERGE_DEFERRALS: one check is enough to
                // correct a misjudged intent declaration, and if the model still
                // insists on plain text it genuinely believes it is done. Without
                // a cap the gate becomes its own dead loop — the model wants to
                // stop but never can.
                if converge_pending
                    && converge_deferred < MAX_CONVERGE_DEFERRALS
                    && !answer.is_empty()
                {
                    // 契约 §2.1 放行判据：TODO 全完成 或 回答去空白 ≥400 字符，
                    // 任一命中即放行 END，不注入校验——完整回答被门禁反复打回
                    // 重写，正是「总结输出两遍」的直接成因。读取失败（None）
                    // 按现状保守处理：不放行，仍走校验。
                    let todo_raw = std::fs::read_to_string(crate::session::todo_path(
                        config.session_dir.as_deref(),
                        &config.workspace,
                    ))
                    .ok();
                    if converge_release(&answer, todo_raw.as_deref()) {
                        info!(
                            session = %config.session_id,
                            "convergence gate released: TODO all done or answer already substantial"
                        );
                    } else {
                        converge_deferred += 1;
                        warn!(
                            session = %config.session_id,
                            deferred = converge_deferred,
                            "convergence gate deferred an implicit end (intent declaration suspected)"
                        );
                        // The declaration must enter history, otherwise the check
                        // prompt follows the previous user message and the model
                        // cannot see what it just said.
                        messages.push(ChatMessage::assistant(answer.clone()));
                        messages.push(ChatMessage::user(completion_check_prompt(
                            converge_deferred,
                        )));
                        // Stays armed: the next text-only reply is gated too, until
                        // the cap is reached.
                        continue;
                    }
                }

                // P3: background-task gate (Java `bgGateArmed`, three END points
                // unified here because this kernel has exactly one text-answer
                // END — converge gate above runs first, so a *deferred* converge
                // check cannot be double-counted by this gate too).
                //
                // A text-only END while background work is still running is a false
                // promise: after the turn ends there is no executor to consume the
                // completion notices, so "I'll be notified and continue" cannot
                // happen. Bounded at MAX_BG_GATE_DEFERRALS (same reasoning as the
                // converge gate: after two deferrals the model has accounted for
                // its work, or there is genuinely nothing actionable, and its
                // reply is respected — an uncapped gate is its own dead loop).
                let running = bg_gate::running_count(&config.session_id).await;
                if running > 0 && bg_deferred < bg_gate::MAX_BG_GATE_DEFERRALS {
                    bg_deferred += 1;
                    warn!(
                        session = %config.session_id,
                        running,
                        deferred = bg_deferred,
                        "background gate deferred implicit END; background task(s) still running"
                    );
                    // The reply must enter history, or the check prompt follows the
                    // previous user message and the model cannot see what it said.
                    messages.push(ChatMessage::assistant(answer.clone()));
                    messages.push(ChatMessage::user(bg_gate::background_gate_prompt(
                        bg_deferred,
                        running,
                    )));
                    continue;
                }

                let elapsed = started_at.elapsed().as_millis() as u64;
                emit!(Frame::trace(
                    &config.session_id,
                    &config.model.name,
                    &total_usage,
                    elapsed,
                    &answer,
                    generation_ms_total,
                    generated_tokens_total
                ));
                // Interjections that arrived too late for any reasoning boundary
                // are not lost: they go back to the durable queue and the frontend
                // dispatches them as the next turn, which is exactly what
                // `processMessageQueue` after this `done` is built to do.
                steer_exit!(Frame::steer_dropped, true);
                emit!(Frame::done(&config.session_id));
                return ReActResult {
                    final_answer: answer,
                    turns_used: turns,
                    usage: total_usage,
                    stop_reason: StopReason::Completed,
                    next_seq: seq,
                    messages,
                    pending_command: None,
                    pending_timeout_ms: None,
                    pending_background: false,
                    pending_tool_call_id: None,
                };
            }

            // Loop fingerprint for this round, computed *before* execution but
            // judged *after* it (below): progress awareness needs the results.
            // `None` (unparseable args) opts the round out of the chain entirely
            // — Java's "宁漏勿误判" policy.
            let fingerprint = loop_fingerprint(&tool_calls, &content_buf);
            // Per-call result hashes + mutation flag, filled during execution.
            let mut round_results: Vec<u64> = Vec::with_capacity(tool_calls.len());
            let mut round_mutated = false;

            // Turn-based todo-staleness reminder (Qoder CLI `todo_reminder`).
            //
            // Count this reasoning turn, then forgive the budget the moment the
            // model writes its checklist on its own. Otherwise, past the dual
            // gate, read TODO.md and inject the current list plus a nudge — the
            // panel lags when a model batches work and forgets to write, and the
            // footer nudge cannot reach a model that never calls a todo tool.
            turns_since_todowrite += 1;
            turns_since_todo_reminder += 1;
            if tool_calls.iter().any(|tc| tc.function.name == "todowrite") {
                turns_since_todowrite = 0;
                todo_reminders = 0;
            } else if todo_reminder_due(
                turns_since_todowrite,
                turns_since_todo_reminder,
                todo_reminders,
            ) {
                // Same resolution as `ToolContext::todo_file` (single source:
                // `session::todo_path`). Read only past the gate (at most once
                // per `TODO_REMINDER_TURNS_BETWEEN` turns).
                let todo_path =
                    crate::session::todo_path(config.session_dir.as_deref(), &config.workspace);
                if let Ok(raw) = std::fs::read_to_string(&todo_path) {
                    if crate::todo::has_unfinished_items(&raw) {
                        messages.push(ChatMessage::user(crate::todo::stale_reminder(&raw)));
                        turns_since_todo_reminder = 0;
                        todo_reminders += 1;
                    }
                }
            }

            // Add the assistant message with tool_calls to history
            let assistant_msg = ChatMessage {
                role: Role::Assistant,
                content: if content_buf.is_empty() {
                    None
                } else {
                    Some(crate::llm::MessageContent::Text(content_buf.clone()))
                },
                tool_calls: Some(tool_calls.clone()),
                tool_call_id: None,
                name: None,
            };
            messages.push(assistant_msg);

            // If multiple tool calls, emit a batch declaration
            //
            // 契约 §4.2 自审修复（D1）：批次声明只统计【可见】成员——抑制名单内
            // 的工具（ask_user/complete_task）不发 action_start/end，前端按
            // batchSize 记完成数（doneCount >= batchSize 才收口转绿）。把它们
            // 算进分母，批次进度永远停在 (n-1)/n、头部 loading 永不收口
            // （finishStream 兜底前用户一直看到「执行中」）。Java 侧
            // createVisibleBatch 按 WebToolVisibilityPolicy 过滤，同一口径。
            // 过滤后可见成员 <2 时整帧不发（normalizeBatchMeta 要求 ≥2）。
            let visible_members: Vec<serde_json::Value> = tool_calls
                .iter()
                .enumerate()
                .filter(|(_, tc)| !lifecycle_suppressed(&tc.function.name))
                .map(|(i, tc)| {
                    serde_json::json!({
                        "actionId": tc.id,
                        "index": i,
                        "toolName": tc.function.name,
                    })
                })
                .collect();
            if visible_members.len() > 1 {
                let batch_id = format!("batch-{}", &config.run_id);
                emit!(Frame::action_batch(
                    &config.session_id,
                    &batch_id,
                    visible_members
                ));
            }

            // Execute each tool call.
            //
            // 契约 §4.2：complete_task 排到批尾（同批还有其他调用时它必须最后
            // 执行）；`stream_index` 保留原始流式索引，args_progress 按它记账。
            let ordered_calls = order_complete_task_last(tool_calls.clone());
            let batch_has_ask = ordered_calls
                .iter()
                .any(|(_, tc)| tc.function.name == "ask_user");
            // 契约 §4.2：complete_task 成功执行后把 summary 作为 final_answer
            // 直通 END（跳过收敛/后台门禁）。批内先记录，批末统一收尾——保证
            // 同批其他调用的 tool result 都已配对入史。
            let mut completed_summary: Option<String> = None;
            for (stream_index, tc) in ordered_calls.iter() {
                let tc_index = *stream_index;
                if cancel.is_cancelled() {
                    // `done` for the same reason as the other cancel exits.
                    //
                    // This catches "the batch has not started yet". A Stop landing
                    // while a tool is *already executing* is caught by the race
                    // around `registry.execute` below — this check alone could never
                    // see it, and that gap was the reported "Stop needs two clicks".
                    // (The previous comment claimed this was the exit a Stop most
                    // often lands on; measured, it is not — it fires only between
                    // calls, so the in-flight case fell through to the tool's own
                    // timeout.)
                    //
                    // Note the assistant turn declaring these calls is already in
                    // `messages` while some results are not: the pairing repair in
                    // `run` fills the gaps before this history is persisted,
                    // otherwise the next request 400s on the orphaned calls.
                    steer_exit!(Frame::steer_cancelled, false);
                    emit!(Frame::done(&config.session_id));
                    return ReActResult {
                        final_answer: String::new(),
                        turns_used: turns,
                        usage: total_usage,
                        stop_reason: StopReason::Cancelled,
                        next_seq: seq,
                        messages,
                        pending_command: None,
                        pending_timeout_ms: None,
                        pending_background: false,
                        pending_tool_call_id: None,
                    };
                }

                let args: serde_json::Value =
                    serde_json::from_str(&tc.function.arguments).unwrap_or(serde_json::json!({}));

                info!(tool = %tc.function.name, action_id = %tc.id, "executing tool");

                // Forced final progress flush.
                //
                // The throttle can swallow the tail: if the last chunk arrived
                // under both thresholds, the skeleton card is left showing a stale
                // byte count that never matches the argument that actually ran.
                // Java emits one last frame on `TOOL_CALL_END` for exactly this
                // reason; this kernel has no such stream event, so the equivalent
                // point is here — immediately before `action_start` converts the
                // skeleton into the real card.
                //
                // `remove` rather than `get_mut`: this tool call is done
                // streaming, so its throttle state must not leak into a later
                // turn that reuses the same stream index.
                //
                // 契约 §4.2：抑制名单内的工具无骨架卡，收尾 flush 同样跳过。
                let suppressed = lifecycle_suppressed(&tc.function.name);
                if let Some(p) = args_progress.remove(&(tc_index as u32)) {
                    if !suppressed && p.bytes > p.last_emit_bytes {
                        emit!(Frame::action_args(&config.session_id, &tc.id, p.bytes));
                    }
                }

                // Emit action_start with full args（抑制名单除外：ask_user 走
                // question 卡、complete_task 走最终 text 帧，不建工具卡）。
                if !suppressed {
                    emit!(Frame::action_start(
                        &config.session_id,
                        &tc.function.name,
                        &tc.id,
                        args.clone()
                    ));
                }

                // 契约 §4.2：同批含 ask_user 时 complete_task 不执行、不结束——
                // 提问还等着用户回答，此刻提交完成自相矛盾。返回错误回执入史，
                // 批内其他调用（含 ask_user 的挂起）照常推进。
                let output = if tc.function.name == "complete_task" && batch_has_ask {
                    ToolOutput::err(COMPLETE_TASK_WITH_ASK_ERROR)
                } else {
                    let tool_ctx = ToolContext {
                        workspace: config.workspace.clone(),
                        session_dir: config.session_dir.clone(),
                        session_id: config.session_id.clone(),
                        // Stamp this invocation's tool_call_id so suspension frames
                        // carry the same actionId the resume path persists.
                        tool_call_id: tc.id.clone(),
                        run_id: config.run_id.clone(),
                        frame_tx: Some(frame_tx.clone()),
                        access_mode: config.access_mode.clone(),
                        // Live tier handle: the gates re-resolve per invocation so a
                        // mid-run picker switch takes effect on the very next tool call.
                        access_override: config.access_override.clone(),
                        cancel: cancel.clone(),
                        hitl_approved: config.hitl_approved,
                        change_ledger: config.change_ledger.clone(),
                        // Raw configured literals, resolved at judgement time so `~`
                        // and environment variables follow runtime changes (Java
                        // `HitlStrategy.java:492`).
                        bash_exempt_dirs: config.settings.permission.bash_exempt_dirs.clone(),
                        resume_calibration: config.resume_calibration,
                        gate: Some(gate.clone()),
                        subagent_depth: config.subagent_depth,
                        root_session_id: config.root_session_id.clone(),
                        thinking: config.thinking.clone(),
                        // Model and settings of *this* run, so `task`/`multitask`
                        // delegate on what the conversation actually selected rather
                        // than re-deriving a global default (see `ToolContext::model`).
                        model: run_model.clone(),
                        settings: run_settings.clone(),
                    };

                    let started = std::time::Instant::now();
                    // Cancellation must race the **whole tool execution**, not merely be
                    // checked before it starts.
                    //
                    // Until here the loop awaited `execute(...)` with no cancel branch, so
                    // an in-flight tool could not be interrupted and the run could not
                    // leave until it returned on its own. Measured against the real kernel
                    // with a stalled provider: a Stop taken during `webfetch` answered
                    // `{status:"cancelled"}` and then emitted `done` **8271 ms** later —
                    // precisely the remaining time of that tool's own request. A Stop
                    // landing inside the LLM receive loop settles in 6 ms, which is why
                    // the defect looks intermittent (it depends entirely on which phase
                    // the user happens to be looking at).
                    //
                    // Only `bash` polled the token internally; everything else ignored it:
                    // `webfetch` (60 s), `websearch` (30 s), MCP `call_tool` (120 s RPC
                    // deadline), `await_tasks` (300 s poll loop), and `task`/`multitask`,
                    // which forward the same token to the sub-agent but still awaited the
                    // delegation *here* — measured at **7767 ms** for a Stop taken while a
                    // foreground sub-agent was running. Racing at this single call site
                    // covers every tool, including third-party MCP ones and any added
                    // later, rather than depending on each tool remembering to poll.
                    //
                    // `biased` makes the cancel branch win when both are ready: tokio
                    // otherwise polls in random order, so a Stop taken at the exact instant
                    // a tool finished would flip between outcomes — the kind of
                    // nondeterminism a cancellation test must not have.
                    //
                    // Abandoning the future is safe *for the UI* because the parent emits
                    // its own closing `action_end` here, and a sub-agent's teardown no
                    // longer lives inside this future (`tools/agent.rs` runs the delegation
                    // on a detached task, so dropping the join handle lets the sub-agent
                    // finish and report itself through `agent_end` with `success=false`).
                    // An earlier version of this branch instead waited a grace period for
                    // the tool to clean up; measured, that made **every** Stop take 2 s and
                    // still lost the `agent_end`, because a parent and its child share one
                    // cancellation instant and always race to the same deadline.
                    //
                    // After this change the same probe measures 7 ms / 4 ms / 5 ms for the
                    // tool, stream and sub-agent phases respectively.
                    let output = tokio::select! {
                        biased;
                        _ = cancel.cancelled() => {
                            // Close the card this run opened with `action_start`, with a
                            // reason. The frontend's stream-end sweep does neutralise a
                            // leftover loading icon (`app-streaming.js:1107` turns a tool
                            // card's into `warn`), so the defect without this frame is not a
                            // stuck spinner but an **unexplained** yellow warning: the user
                            // cannot tell whether they stopped it or it failed. Emitting it
                            // says so. Same text the bash tool's own result produces, so a
                            // stopped tool looks identical however it was interrupted.
                            //
                            // 契约 §4.2：抑制名单内的工具没有开过卡，取消时也不补关卡路。
                            if !suppressed {
                                emit!(Frame::action_end_failed(
                                    &config.session_id,
                                    &tc.function.name,
                                    &tc.id,
                                    "Cancelled by user",
                                ));
                            }
                            steer_exit!(Frame::steer_cancelled, false);
                            emit!(Frame::done(&config.session_id));
                            return ReActResult {
                                final_answer: String::new(),
                                turns_used: turns,
                                usage: total_usage,
                                stop_reason: StopReason::Cancelled,
                                next_seq: seq,
                                messages,
                                pending_command: None, pending_timeout_ms: None, pending_background: false,
                                pending_tool_call_id: None,
                            };
                        }
                        output = self.registry.execute(&tc.function.name, args, &tool_ctx) => output,
                    };
                    let _duration_ms = started.elapsed().as_millis() as u64;
                    output
                };

                // Check for suspension
                if let Some(suspend) = &output.suspend {
                    match suspend.kind {
                        crate::tools::SuspendKind::Question => {
                            // Question frame already emitted by the tool.
                            // 契约 §4.2：ask_user 挂起会立即结束本 run，批尾的
                            // complete_task 因此不会执行。为它补一条互斥错误回执入史，
                            // 保证 tool_call→result 配对完整（否则恢复后的请求会因
                            // 孤儿 tool_call 400）；语义即「本批含待回答提问，不能同时
                            // 提交完成」。complete_task 已被排到批尾，必在挂起调用之后。
                            if batch_has_ask {
                                for (_, other) in ordered_calls.iter() {
                                    if other.function.name == "complete_task" {
                                        messages.push(ChatMessage::tool_result(
                                            &other.id,
                                            COMPLETE_TASK_WITH_ASK_ERROR,
                                        ));
                                    }
                                }
                            }
                            emit!(Frame::done_suspended(&config.session_id));
                            return ReActResult {
                                final_answer: String::new(),
                                turns_used: turns,
                                usage: total_usage,
                                stop_reason: StopReason::SuspendedQuestion,
                                next_seq: seq,
                                messages,
                                pending_command: None,
                                pending_timeout_ms: None,
                                pending_background: false,
                                pending_tool_call_id: Some(tc.id.clone()),
                            };
                        }
                        crate::tools::SuspendKind::Hitl => {
                            // 自审修复（Rust 子代理 P2）：HITL 挂起同样立即结束本 run，
                            // 批尾的 complete_task 不会执行。与 Question 分支同口径补
                            // 互斥错误回执入史——否则恢复回放时该孤儿调用被填
                            // INTERRUPTED_MARKER（「任务中断…请勿重复执行」），模型收到
                            // 的语义与「本批含待审批操作，不能同时提交完成」完全不同，
                            // 可能据此放弃收尾。complete_task 已排到批尾，必在挂起调用之后。
                            for (_, other) in ordered_calls.iter() {
                                if other.function.name == "complete_task" {
                                    messages.push(ChatMessage::tool_result(
                                        &other.id,
                                        COMPLETE_TASK_WITH_ASK_ERROR,
                                    ));
                                }
                            }
                            emit!(Frame::done_suspended(&config.session_id));
                            return ReActResult {
                                final_answer: String::new(),
                                turns_used: turns,
                                usage: total_usage,
                                stop_reason: StopReason::SuspendedHitl,
                                next_seq: seq,
                                messages,
                                pending_command: suspend.command.clone(),
                                pending_timeout_ms: suspend.timeout_ms,
                                pending_background: suspend.background,
                                pending_tool_call_id: Some(tc.id.clone()),
                            };
                        }
                    }
                }

                // Emit action_end frame (with result preview for the stream)。
                // 契约 §4.2：抑制名单内的工具不建卡也不关卡路——complete_task 的
                // summary 若进 action_end 预览就是第二份总结，ask_user 的呈现是
                // question 卡。错误回执仍入史（模型可见），只是不渲染工具卡。
                let result_preview: String = output.text.chars().take(2000).collect();
                if !suppressed {
                    if output.is_error {
                        emit!(Frame::action_end_failed(
                            &config.session_id,
                            &tc.function.name,
                            &tc.id,
                            &result_preview,
                        ));
                    } else {
                        emit!(Frame::action_end(
                            &config.session_id,
                            &tc.function.name,
                            &tc.id,
                            &result_preview,
                        ));
                    }
                }

                // 契约 §4.2：complete_task 成功执行 → 记录 summary，批末直通 END。
                // tool result（ok(summary)）仍照常入史，保证 tool_call→result 配对
                // 完整；summary 的呈现走批末的 text 帧，不走 action_end。
                if tc.function.name == "complete_task" && !output.is_error {
                    completed_summary = Some(output.text.clone());
                }

                // Loop-guard evidence (progress awareness): hash the *full*
                // result, and note successful state mutations. Same call with
                // a different answer = new information, not spinning; a
                // successful write/edit between identical probes legitimises
                // the re-run (edit → restart → poll).
                round_results.push(simple_hash(&output.text));
                if !output.is_error && STATE_MUTATING_TOOLS.contains(&tc.function.name.as_str()) {
                    round_mutated = true;
                }

                // Add tool result to messages.
                //
                // Capped here rather than left to the compressor. This line used to
                // push `&output.text` verbatim (the old comment read "full text,
                // not preview"), so a single large `read` or a long `bash` log
                // entered the context at full size and the compressor then had to
                // evict *real history* to make room — the user-visible symptom was
                // the model forgetting earlier work, and the cause looked like a
                // compression bug.
                //
                // Truncating at the source is the only lossless saving available:
                // a tool can be re-called with pagination, while a passage the
                // compressor summarised away cannot be recovered. The cap tightens
                // with context pressure (64K → 24K → 8K chars) so a run with room
                // to spare still sees full output.
                //
                // The frame above keeps its own 2000-char preview: that is what the
                // UI renders, and it is deliberately independent of what the model
                // is allowed to see.
                //
                // 超大输出先落盘再截断：整段文本存进会话存储，模型拿到预览 +
                // 文件路径，可用 read/grep 取回任意部分，不必重跑命令。落盘
                // 失败时退回纯截断，工具执行不受影响。
                let persisted = crate::tools::output::persist_if_large(
                    &output.text,
                    &crate::tools::output::store_dir(
                        &config.workspace,
                        config.session_dir.as_deref(),
                    ),
                    &tc.function.name,
                    &tc.id,
                );
                let observation = crate::compress::sanitise_observation(
                    persisted.as_deref().unwrap_or(&output.text),
                    observation_cap,
                );
                if observation.len() != output.text.len() {
                    debug!(
                        session = %config.session_id,
                        tool = %tc.function.name,
                        original = output.text.chars().count(),
                        cap = observation_cap,
                        pressure = format!("{:.2}", pressure),
                        "tool observation truncated"
                    );
                }
                // 视觉通道：工具返回的图片（read 磁盘图片）随观测一起入站。
                // 图片不参与 sanitise_observation 截断（那是对文本的）；
                // 截断会丢掉图片让模型以为"看到了"。文本部分照常截断。
                if output.image_urls.is_empty() {
                    messages.push(ChatMessage::tool_result(&tc.id, observation));
                } else {
                    messages.push(ChatMessage::tool_result_with_images(
                        &tc.id,
                        &observation,
                        output.image_urls.clone(),
                    ));
                }
            }

            // 契约 §4.2：complete_task 成功执行后的直通 END。
            //
            // summary 就是用户看到的最终回答：发一个 text 帧（整段，不逐 token
            // 流式——它不是模型增量输出，重复流式只会渲染两遍）+ trace + done，
            // StopReason::Completed。跳过收敛门禁与后台门禁——模型已显式声明
            // 完成并交付总结，再注入校验提示就是逼它写第二份。
            //
            // 放在批末而非 complete_task 执行点：同批其他调用的 tool result 必须
            // 先配对入史（complete_task 已被 order_complete_task_last 排到批尾，
            // 此处所有调用都已处理完）。
            if let Some(summary) = completed_summary {
                steer_exit!(Frame::steer_dropped, true);
                // 契约 §4.2「若 summary 未曾流式输出」判重（自审修复 D2）：
                // 模型有时先把总结作为正文流式输出、再调 complete_task 提交
                // 同一段文字。此时正文已经逐 token 发过 text 帧，再整段补发
                // 就是用户看到的第二份总结。判重口径：去除首尾空白后与本轮
                // 已流式正文（content_buf）完全相同 → 跳过补发；不同（哪怕
                // 只是扩写）仍补发——summary 是模型钦定的最终回答，宁可多一
                // 段也不丢交付。Java finishByCompleteTask 同口径。
                if summary.trim() != content_buf.trim() {
                    // 整段一个 text 帧（phase=TEXT），不逐 token 流式：summary 不是
                    // 模型增量输出，重复流式只会渲染两遍。
                    emit!(Frame::text_delta(&config.session_id, &summary));
                }
                emit!(Frame::trace(
                    &config.session_id,
                    &config.model.name,
                    &total_usage,
                    started_at.elapsed().as_millis() as u64,
                    &summary,
                    generation_ms_total,
                    generated_tokens_total,
                ));
                emit!(Frame::done(&config.session_id));
                return ReActResult {
                    final_answer: summary,
                    turns_used: turns,
                    usage: total_usage,
                    stop_reason: StopReason::Completed,
                    next_seq: seq,
                    messages,
                    pending_command: None,
                    pending_timeout_ms: None,
                    pending_background: false,
                    pending_tool_call_id: None,
                };
            }

            // Loop guard (DSH `repeat-tool-reminder` semantics, 2026-11-20):
            // judged after execution so progress awareness can see the
            // results. Consecutive-chain counting with escalating reminders
            // at 3/5/8; advisory only — never blocks, never stops the run.
            // The reminder lands after this round's tool results, exactly
            // where DSH's `additionalContexts` puts it.
            if let Some(fp) = fingerprint.as_deref() {
                let repeats =
                    loop_chain_step(&mut loop_chain, fp, round_results, prev_round_mutated);
                if repeats > 0 {
                    warn!(
                        session = %config.session_id,
                        repeats,
                        "repeat chain threshold reached, injecting advisory reminder"
                    );
                    messages.push(ChatMessage::user(loop_detected_prompt(repeats)));
                    converge_pending = true;
                }
                prev_round_mutated = round_mutated;
            } else {
                // Fingerprint unavailable (unparseable arguments): the round
                // neither extends nor resets the chain ("宁漏勿误判"), but a
                // successful mutation still counts as progress for the next
                // judgeable round.
                prev_round_mutated |= round_mutated;
            }

            // Loop back for next reasoning turn
        }
    }
}

/// Marker written for a tool call that never produced a result.
///
/// Deliberately tells the model *not* to blindly re-run the call: the reason it
/// has no result is usually that the user pressed Stop, and re-executing a write
/// or a bash command that already ran once can double-apply its side effects.
const INTERRUPTED_MARKER: &str = "[该工具调用因任务中断/取消未执行完成，无输出结果。请勿直接重复执行同一调用；若确实需要该结果，请先评估副作用再决定。]";

/// Escalating reminder thresholds on the *consecutive* repeat chain, ported
/// from DSH `repeat-tool-reminder` (defaults `[3, 5, 8]`). At each threshold a
/// reminder is injected once; past the last the chain goes silent. **No
/// threshold ever blocks a call or stops the run** — DSH's design notes
/// explicitly reject "escalate to block" because it kills legitimate polling
/// and re-checking, and Claude Code / Codex ship no behavioural detector at
/// all. The old `LOOP_WINDOW`/`MAX_LOOP_REMINDERS` hard-stop shape killed a
/// healthy debugging run (work-mwod1kcs, 448 turns) and is gone.
const LOOP_REMINDER_THRESHOLDS: [u32; 3] = [3, 5, 8];

/// State of the consecutive-repeat chain (DSH: one chain per agent, reset by
/// any different tracked call). `last_results` holds the previous round's
/// per-call result hashes so progress awareness can tell "same call, new
/// information" from "same call, same answer".
struct LoopChain {
    fingerprint: String,
    count: u32,
    /// Which of [`LOOP_REMINDER_THRESHOLDS`] already fired for this chain.
    fired: usize,
    /// Result hashes of the previous round's calls (same order as the batch).
    last_results: Vec<u64>,
}

/// Tools whose successful execution mutates workspace state. A successful
/// mutation between two identical calls means the world changed under the
/// model's feet — re-running the same probe is then legitimate verification
/// (edit → restart dev server → poll), not spinning.
///
/// `write`/`edit` are the only registered file-mutating tools in this kernel
/// (tools/builtin/mod.rs). `multiedit`/`notebookedit` were Claude Code names
/// carried over from the Java mirror — dead entries here, removed. Edits made
/// through `bash` are not listed: their result text changes too, so the
/// result-hash leg of progress awareness covers them.
const STATE_MUTATING_TOOLS: &[&str] = &["write", "edit"];

/// Pure decision step of the loop guard, table-testable without a live run.
///
/// Returns the reminder count to inject (0 = silent). `results` are this
/// round's per-call result hashes; `mutated` says whether this round executed
/// a successful state-mutating tool. Progress awareness: when the fingerprint
/// repeats but the results differ from the previous round, or the previous
/// round successfully mutated state, the chain restarts at 1 — the repeat is
/// producing new information.
fn loop_chain_step(
    chain: &mut Option<LoopChain>,
    fingerprint: &str,
    results: Vec<u64>,
    prev_mutated: bool,
) -> u32 {
    let repeats = match chain {
        Some(c) if c.fingerprint == fingerprint => {
            let new_info = prev_mutated || c.last_results != results;
            if new_info {
                c.count = 1;
                c.fired = 0;
                c.last_results = results;
                return 0;
            }
            c.count += 1;
            c.last_results = results;
            c.count
        }
        _ => {
            *chain = Some(LoopChain {
                fingerprint: fingerprint.to_string(),
                count: 1,
                fired: 0,
                last_results: results,
            });
            return 0;
        }
    };
    // Fire each threshold at most once per chain; past the last, silence.
    let c = chain.as_mut().expect("chain set above");
    if c.fired < LOOP_REMINDER_THRESHOLDS.len() && repeats >= LOOP_REMINDER_THRESHOLDS[c.fired] {
        c.fired += 1;
        return repeats;
    }
    0
}

/// Turn-based todo-staleness reminder, ported from Qoder CLI `todo_reminder`
/// (decoded runtime `MMi = {TURNS_SINCE_WRITE:10, TURNS_BETWEEN_REMINDERS:10}`).
///
/// Dual gate: nudge only when the checklist has gone this many reasoning turns
/// without a `todowrite` AND this many turns since the last reminder. The first
/// threshold is the staleness signal; the second stops a stale list from being
/// re-announced every turn. The footer's `[继续]` nudge only reaches a model that
/// already calls a todo tool — this one is independent of that discipline.
const TODO_REMINDER_TURNS_SINCE_WRITE: u32 = 10;
const TODO_REMINDER_TURNS_BETWEEN: u32 = 10;

/// Cap on todo reminders per run. A model that
/// ignores the nudge this many times is not going to be moved by a fourth;
/// forgiven to zero whenever it calls `todowrite` on its own.
const MAX_TODO_REMINDERS: u32 = 3;

/// Whether the turn gates for a todo-staleness reminder are met (Qoder dual
/// gate + per-run cap). The checklist gate (`has_unfinished_items`) is evaluated
/// by the caller only once this returns true, so TODO.md is not read every turn.
fn todo_reminder_due(turns_since_write: u32, turns_since_reminder: u32, reminders: u32) -> bool {
    turns_since_write >= TODO_REMINDER_TURNS_SINCE_WRITE
        && turns_since_reminder >= TODO_REMINDER_TURNS_BETWEEN
        && reminders < MAX_TODO_REMINDERS
}

/// How many times the convergence gate may re-judge a text-only reply as
/// "keep going" (Java `MAX_CONVERGE_DEFERRALS = 2`).
///
/// One completion check is enough to correct a misread intent declaration. If
/// the model still answers with plain text twice, it really does consider the
/// task finished and its reply is respected — an uncapped gate would become a
/// dead loop of its own, where the model wants to stop but never can.
const MAX_CONVERGE_DEFERRALS: u32 = 2;

/// How many consecutive empty model responses (no text, no tool calls) are
/// retried with an injected correction prompt before the run stops honestly.
/// Java (`ReasonTask.java:685-726`) uses the same 3 but its counter, once full,
/// leaves the loop spinning with no prompt and no END — that shape is a bug,
/// not a contract.
const MAX_EMPTY_ROUNDS: u32 = 3;

/// Corrupted-stream retries allowed per run (see `corruption_retries`).
///
/// Two, matching `MAX_TIMEOUT_RETRIES_PER_TURN`: a transient upstream glitch
/// usually clears on the next request, and by the third the damage is systemic
/// — continuing would repeat the work-mw8wizyz shape (3.5M input tokens burned,
/// then "retry budget exhausted").
///
/// Note the *terminal* behaviour differs by damage site, which is the point of
/// the split: a corrupt tool call ends the run with an error (executing it
/// could destroy a file), while corrupt prose is surfaced as-is with a warning
/// (a model that legitimately prints U+FFFD — say, while debugging a codec —
/// must not be killed for it).
const MAX_CORRUPTION_RETRIES: u32 = 2;

/// P2: timeout-class failures allowed per round before the run stops
/// honestly. Java `ReasonTask` timeout bucket: “连续两次都超时说明是系统性
/// 原因，第三次同样会超时” — production evidence work-mua28gy6 (34 retries,
/// 67.6 minutes, zero progress).
const MAX_TIMEOUT_RETRIES_PER_TURN: u32 = 2;

/// P2: per-model-call retry budget in seconds. Java `REASON_RETRY_TOTAL_DEADLINE
/// = 45min`, taken as `startNanos` inside `callWithRetry`, which runs once per
/// turn: the total wall-clock time one model call may spend in retry/failure
/// loops, regardless of failure class, shared by that call's physical retries.
/// Re-armed on every fresh turn (`retry_of_same_call`), never run-wide — a
/// run-wide deadline turns the budget into a countdown on the task itself, so a
/// long but healthy run loses the ability to absorb a single transient error
/// after 45 minutes.
///
/// Bounded so no failure class can spin forever under AutoRethink's ever-rising
/// `turns < max_turns`.
const MODEL_CALL_RETRY_DEADLINE_SECS: u64 = 45 * 60;

/// The deadline for a fresh model call's retry budget (`Instant`-based, so a
/// wall-clock jump cannot extend or fake-expire it). Single source for both the
/// initial value and the per-turn re-arm, so the two can never drift apart.
fn retry_deadline_from_now() -> std::time::Instant {
    std::time::Instant::now() + std::time::Duration::from_secs(MODEL_CALL_RETRY_DEADLINE_SECS)
}

/// Loop fingerprint for one round, Java `StopLoopInterceptor` semantics:
/// tool name + hash of the *fully* canonicalised arguments (except
/// NAME_ONLY_TOOLS, whose args change every round by design), or a hash of
/// the text prefix for a text-only round.
///
/// Full-value hashing is the work-mwod1kcs fix: the old 120-char-per-value
/// truncation collapsed distinct commands sharing a long prefix into one
/// fingerprint. Hashing keeps the fingerprint compact without losing any
/// distinguishing bytes.
///
/// Returns `None` when a tool-call's arguments cannot be parsed as JSON — an
/// unparseable payload makes the fingerprint unreliable, and Java's policy is
/// "rather miss than misjudge" (放弃整条指纹而非拼入字面量).
fn loop_fingerprint(tool_calls: &[ToolCall], content: &str) -> Option<String> {
    if !tool_calls.is_empty() {
        let mut sb = String::new();
        for tc in tool_calls {
            sb.push_str("tool:");
            sb.push_str(&tc.function.name);
            if NAME_ONLY_TOOLS.contains(&tc.function.name.as_str()) {
                continue;
            }
            sb.push_str("#args:");
            sb.push_str(&format!(
                "{:x}",
                simple_hash(&canonical_args(&tc.function.arguments)?)
            ));
        }
        return Some(sb);
    }
    if !content.trim().is_empty() {
        // Hashed prefix, deliberately without a turn stamp: stamping would make
        // even a genuinely repeated reply look different (Java 2026-10-02 fix).
        let prefix: String = content.trim().chars().take(120).collect();
        return Some(format!("text:{:x}", simple_hash(&prefix)));
    }
    None
}

/// Tools whose arguments are excluded from the loop fingerprint: their args
/// legitimately change every round (a todo list grows as the task progresses),
/// so including them would make "normal progress" look like variance and the
/// detector blind (Java `NAME_ONLY_TOOLS`).
const NAME_ONLY_TOOLS: &[&str] = &["todowrite", "todoread"];

/// 生命周期帧抑制名单（契约 §4.2 末段，语义对齐 Java `WebToolVisibilityPolicy`）。
///
/// 这两个工具不是「工作步骤」而是「会话控制」：ask_user 的呈现是 question 卡
/// （question 帧照常发），complete_task 的呈现是最终回答 text 帧。给它们建
/// action 工具卡只会让用户看到一张「ask_user 执行中/完成」的噪声卡，且
/// complete_task 的 summary 若再进 action_end 预览就是第二份总结。
/// 抑制覆盖 action_draft（骨架）/ action_args（进度）/ action_start / action_end。
const LIFECYCLE_SUPPRESSED_TOOLS: &[&str] = &["ask_user", "complete_task"];

/// 该工具是否抑制生命周期帧（见 [`LIFECYCLE_SUPPRESSED_TOOLS`]）。
fn lifecycle_suppressed(tool_name: &str) -> bool {
    LIFECYCLE_SUPPRESSED_TOOLS.contains(&tool_name)
}

/// 契约 §4.2：complete_task 必须最后执行——同批还有其他调用时把它排到批尾。
///
/// 稳定排序：其余调用保持模型给出的相对顺序。返回 (重排后的调用, 原始流式索引)
/// 对，索引用于取回 `args_progress`（它按流式 index 记账，重排后不能错位）。
/// 没有 complete_task 时原样返回，零开销。
fn order_complete_task_last(tool_calls: Vec<ToolCall>) -> Vec<(usize, ToolCall)> {
    let indexed: Vec<(usize, ToolCall)> = tool_calls.into_iter().enumerate().collect();
    if !indexed
        .iter()
        .any(|(_, tc)| tc.function.name == "complete_task")
    {
        return indexed;
    }
    let (mut rest, completes): (Vec<_>, Vec<_>) = indexed
        .into_iter()
        .partition(|(_, tc)| tc.function.name != "complete_task");
    rest.extend(completes);
    rest
}

/// 契约 §4.2：同批含 ask_user（或 HITL 待审批操作）时 complete_task 不得结束任务——
/// 提问/审批还等着用户回应，此刻提交「完成」是自相矛盾的。返回错误回执（不挂起、
/// 不 END），让模型先等回应或撤回完成声明。文案双内核逐字一致（自审对齐：旧版
/// Rust 带前缀后缀、Java 只有中段，且 HITL 场景提 ask_user 语义错位，统一为现版）。
const COMPLETE_TASK_WITH_ASK_ERROR: &str =
    "complete_task 未结束任务：本批含待用户回应的挂起操作（提问或审批），不能同时提交完成。请先等待用户回应，再决定是否收尾。";

/// Canonical argument string for fingerprinting: parse the JSON, sort keys,
/// include values **in full**, and emit the result via serde_json so every
/// structural character inside keys/values is escaped (hashed by the caller).
/// Key order and whitespace differences must not produce different
/// fingerprints; different `file_path` / `command` values must.
///
/// The old form truncated every value to 120 chars "defensively". That was the
/// work-mwod1kcs false kill: commands sharing a >120-char prefix (a long
/// `$f='C:\Apps\HBuilderX\...'` path assignment) differed only *after* the cut,
/// so 12 distinct Select-String investigations fingerprinted identically and
/// the run was stopped as "repeated unproductive tool calls". Full values cost
/// nothing here — the result is hashed, never stored raw.
///
/// The intermediate form joined raw values with `|` and `=` (Java
/// `canonicalArgsOf` still does). Unescaped delimiters let constructively
/// different payloads canonicalise identically — `{"a":"x|b=y"}` vs
/// `{"a":"x","b":"y"}` — so a genuinely new call could be misread as a repeat.
/// JSON emission escapes `"` and `\` inside every string, making the mapping
/// injective: distinct argument trees always produce distinct strings.
/// (Java parity is deliberately not maintained — that kernel is slated for
/// removal; Rust is the single source of truth.)
fn canonical_args(raw: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    serde_json::to_string(&canonical_value(&v)).ok()
}

/// Recursive canonicalisation into a fresh JSON value: objects sort their keys
/// at every depth, arrays keep order, scalars pass through unchanged. No
/// truncation anywhere. The caller serialises the result, which is where
/// delimiter safety comes from.
fn canonical_value(v: &serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::Object(m) => {
            // Explicit sort, then re-insert into a fresh Map. The workspace
            // builds serde_json with `preserve_order` (IndexMap-backed, needed
            // for settings.json — see Cargo.toml), so BTreeMap → Map::collect
            // would *not* guarantee sorted output; insertion order is what
            // counts, and we control it here.
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let mut sorted = serde_json::Map::new();
            for k in keys {
                sorted.insert(
                    k.clone(),
                    canonical_value(m.get(k).unwrap_or(&serde_json::Value::Null)),
                );
            }
            serde_json::Value::Object(sorted)
        }
        serde_json::Value::Array(a) => {
            serde_json::Value::Array(a.iter().map(canonical_value).collect())
        }
        other => other.clone(),
    }
}

/// Stable, dependency-free string hash (FNV-1a 64). Only used for text
/// fingerprints where equality — not cryptographic strength — matters.
fn simple_hash(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Prompt injected after an empty model response (no text, no tool calls).
/// Wording follows Java `ReasonTask.java:702-707` (format correction) with the
/// reflection variant merged for fully empty rounds (`:712-719`).
fn empty_response_prompt(turn: u32, attempt: u32) -> String {
    format!(
        "【系统指令：输出格式修正 (Format Correction)】\n\
         您在第 {turn} 轮中返回了空响应（无思考内容、无行动、无最终答案）（第 {attempt}/{MAX_EMPTY_ROUNDS} 次尝试）。\n\n\
         请立即启动自我反思：\n\
         1. **回溯任务目标**：重新审视您最初被分配的任务核心目标，检查是否偏离了主线。\n\
         2. **审视历史轨迹**：回顾最近的 Observation 和之前的思考链，定位导致空响应的原因。\n\
         3. **策略修正**：若当前路径受阻，请果断切换思路或拆分为更小的子任务推进。\n\n\
         请输出下一步行动（工具调用）或面向用户的最终回答。"
    )
}

/// Self-review prompt injected when the turn budget is extended
/// (Java `ReasonTask` auto-rethink, wording kept identical).
fn rethink_prompt(turn: u32) -> String {
    format!(
        "【系统指令：自我反思 (Self-Reflection)】\n\
         当前任务已执行至第 {turn} 回合。为了确保任务准确高效完成，请立即启动自审程序：\n\n\
         1. **核心目标检查**：重新审视用户最初提出的核心问题和当前要解决的任务，评估你当前的方向是否偏离了主线？\n\
         2. **有效性评估**：检查历史 Observation。如果最近的尝试没有带来有效新线索，说明当前策略已失效，请必须更换思路或换个角度切入。\n\
         3. **强制收敛**：若评估判定由于客观限制确实无法达成，请梳理已知线索，并在 Final Answer 中向用户复盘并申请协助。\n\n\
         根据新策略决定下一步行动，或输出 Final Answer 结束任务"
    )
}

/// 契约 §2.1：收敛门禁的放行判据（纯函数，表驱动可测）。
///
/// 两条任一命中即放行 END：
/// 1. 会话 TODO.md 存在且全部完成（无 `[ ]`/`[/]` 未完成项）——清单是模型自己
///    维护的完成证据，全勾后再拦「意图声明」就是误伤；
/// 2. 回答去除空白后 ≥ [`CONVERGE_RELEASE_ANSWER_CHARS`] 字符——已成规模的回答
///    是完整交付而非一句意图声明，打回重写只会产出第二份重复总结。
///
/// `todo_raw = None`（文件不存在/读取失败）按现状保守处理：该判据不命中，
/// 仍由字符数判据与原有门禁兜底。空清单（total=0）不算「全部完成」——
/// 没有任何完成证据时放行等于门禁形同虚设。
fn converge_release(answer: &str, todo_raw: Option<&str>) -> bool {
    if let Some(raw) = todo_raw {
        let p = crate::todo::measure(raw);
        if p.total > 0 && !crate::todo::has_unfinished_items(raw) {
            return true;
        }
    }
    answer.chars().filter(|c| !c.is_whitespace()).count() >= CONVERGE_RELEASE_ANSWER_CHARS
}

/// 契约 §2.1 的「回答已成规模」阈值（去除空白后的字符数）。
const CONVERGE_RELEASE_ANSWER_CHARS: usize = 400;

/// Completion-check prompt injected when the convergence gate defers an implicit
/// end (Java `completionCheckPromptFor`, wording kept identical).
///
/// 契约 §2.2 改「补缺式」：旧文案第 2 条要求「重新输出完整总结报告」，模型照做
/// 就把已交付的总结原样再写一遍——这正是双份总结的成因。新文案三分支：未完成
/// 继续做；已完整直接确认结束；有遗漏只补遗漏，严禁复述。
fn completion_check_prompt(deferred: u32) -> String {
    format!(
        "【系统提示：任务完成校验 (Completion Check)】\n\
         你刚才的纯文本回复可能是过渡性意图声明而非最终回答。请核验：\n\
         1. 若任务清单仍有未完成事项：继续执行它们，不要停止；\n\
         2. 若上一条回复已是面向用户的完整回答：直接确认结束，不要重复输出已说过的内容；\n\
         3. 若确有遗漏：只补充遗漏部分（验证结果、遗留事项），严禁复述已交付的总结。\n\
         （第 {deferred}/{MAX_CONVERGE_DEFERRALS} 次校验，之后将按普通最终回答处理）"
    )
}

/// Loop-detected reminder (Java `StopLoopInterceptor`, wording kept identical).
/// Escalates DSH-style: gentle at 3, explicit at 5/8. Advisory only.
///
/// Suggests a different angle only. It must not instruct the model to end the
/// task: that phrasing made the model emit a transitional intent declaration as
/// its final answer, so a Loop terminated "normally" with 0/10 TODOs done.
/// The "若确认任务已全部完成" exit is kept (a genuinely finished task may end),
/// but the reminder never *commands* convergence.
fn loop_detected_prompt(count: u32) -> String {
    if count <= LOOP_REMINDER_THRESHOLDS[0] {
        format!(
            "【系统提示：检测到潜在循环 (Loop Detected)】\n\
             系统检测到您已连续 {count} 次执行完全相同的工具调用（参数与结果均未变化），可能存在\"原地打转\"的情况。\n\n\
             请审视历史 Observation：如果最近的尝试没有带来有效新线索，请更换思路或换个角度切入；不要重复执行已执行过且未产生新信息的操作。\n\
             若确认任务已全部完成，可给出面向用户的总结作为最终回答；若尚未完成，请继续执行未完成事项。"
        )
    } else {
        format!(
            "【系统提示：检测到潜在循环 (Loop Detected)】\n\
             您已连续 {count} 次执行完全相同的工具调用（参数与结果均未变化）。重复同一调用不会产生新信息。\n\n\
             请不要再以完全相同的参数调用该工具。请执行以下步骤：\n\
             1. **有效性评估**：当前策略已失效，必须更换思路或换个角度切入（换工具、换参数、换排查方向）。\n\
             2. **阻塞上报**：若客观限制导致无法推进，请向用户说明卡点与已排除的方向，请求协助。\n\
             3. **任务完成校验**：若确认任务已全部完成，可给出面向用户的总结作为最终回答；若尚未完成，请继续执行未完成事项。"
        )
    }
}

/// One interjection as it appears on the wire (`args.items[]`).
///
/// Field names and values are Java's `buildSteerArgs` verbatim — the frontend
/// indexes them by `steerId` and renders `text` plus attachment paths, and the same
/// shape is shared by applied / cancelled / dropped so one renderer covers all three.
///
/// `text` is deliberately the **raw** interjection, not [`queued_message_text`]:
/// that helper's `[用户附带图片: …]` suffix exists for the model, while the frontend
/// upgrades `imagePaths`/`filePaths` into real tiles itself. Echoing both would show
/// a tile *and* a line of machine paths.
///
/// `None` for an item without a usable id: such a row would be dropped by the
/// frontend's `if (!item.steerId)` guard anyway, and silently unrenderable rows are
/// easier to spot as an invariant breach than a half-drawn bubble.
fn steer_envelope(item: &crate::queue::QueuedMessage, run_id: &str) -> Option<serde_json::Value> {
    let steer_id = item
        .origin_steer_id
        .as_deref()
        .filter(|s| !s.trim().is_empty())?;
    Some(serde_json::json!({
        "steerId": steer_id,
        "text": item.content,
        "runId": run_id,
        "createdAt": item.timestamp,
        "imagePaths": item.image_paths,
        "filePaths": item.file_paths,
    }))
}

/// Resolve the interjections left in `queue.json` when a run ends. Returns the
/// envelopes to announce; empty means nothing to emit.
///
/// `requeue` is Java's split between the two exits, and the file work differs
/// because this kernel's mailbox *is* `queue.json` (Java's is the in-memory
/// `SteerRunState.pending`, so a drop has to be persisted there; here a drop only
/// has to stop an item from surviving):
///
/// * `false` — Stop: remove the interjections for good, so a message the user
///   abandoned does not come back as the next turn's input. Announce
///   `steer_cancelled`.
/// * `true` — the run ended on its own: **leave the file alone** and announce
///   `steer_dropped`. The item is already durable exactly where the frontend's
///   `processMessageQueue` will `shift()` it after this run's `done`.
///
/// The dropped path is read-only rather than take-then-re-add even though the two
/// leave the same net file. The gap between the two writes is observable: a
/// concurrent frontend `shift()` or badge refresh landing in it sees the item
/// missing, and `add` would then re-append it at the **tail**, silently reordering
/// a queue the user built in a specific order. Nothing here needs to move the item
/// at all, so it does not.
///
/// (Re-announcing the same id on a repeated call is harmless either way — the
/// frontend skips rows already in its `steerResolved` set — but each exit returns
/// immediately, so a run settles exactly once.)
///
/// Ordering that does matter: this frame goes out **before** `done`, because `done`
/// is what makes the frontend read the queue.
fn settle_steers(
    queue_mgr: &crate::queue::QueueManager,
    dir: &std::path::Path,
    run_id: &str,
    requeue: bool,
) -> Vec<serde_json::Value> {
    let left = if requeue {
        queue_mgr.read(dir)
    } else {
        queue_mgr.take_steers(dir)
    };
    // `steer_envelope` is the single authority on what counts as an interjection
    // (it returns `None` for a missing or blank id), so plain queued items fall out
    // here without a second copy of that predicate. A mutation check deleted an
    // explicit id filter above this line and every test still passed — proof that
    // keeping it would only suggest a guard that does no work.
    left.iter()
        .filter_map(|i| steer_envelope(i, run_id))
        .collect()
}

/// Render a queued interjection as message text.
///
/// Attachments are named inline rather than dropped: the frontend's steer path
/// accepts `imagePaths`/`filePaths`, and silently discarding them would leave the
/// model reading "see the attached screenshot" with no screenshot. (The Java
/// kernel's `Form<SteerForm>` port had exactly this bug — a repeated key made it
/// drop every attachment.)
fn queued_message_text(item: &crate::queue::QueuedMessage) -> String {
    let mut text = item.content.clone();
    if !item.image_paths.is_empty() {
        text.push_str(&format!(
            "\n[用户附带图片: {}]",
            item.image_paths.join(", ")
        ));
    }
    if !item.file_paths.is_empty() {
        text.push_str(&format!("\n[用户附带文件: {}]", item.file_paths.join(", ")));
    }
    text
}

/// Ensure every `assistant(tool_calls)` entry has a matching `tool` result.
///
/// Returns how many placeholder results were inserted. Idempotent: a healthy
/// history returns 0 and is left byte-identical.
///
/// An OpenAI-compatible provider rejects a request whose `tool_calls` array
/// contains an id with no corresponding `tool` message, and because the payload
/// is identical on every attempt, no amount of retrying fixes it — the session
/// is bricked until the user starts a new one. This is the same failure the Java
/// kernel guards with `ToolCallPairRepair`.
///
/// Placeholders are inserted rather than the assistant turn being dropped: the
/// turn carries the model's reasoning and any sibling results that *did*
/// complete, and removing it would also desynchronise the frontend's action
/// cards from the persisted history.
fn repair_tool_pairing(messages: &mut Vec<ChatMessage>) -> usize {
    repair_tool_pairing_except(messages, &[])
}

/// Like [`repair_tool_pairing`], but leave the listed call ids unrepaired.
///
/// `skip` carries the suspended tool call when a run ended on ask_user / HITL:
/// its result is pending user input, not lost. Everything else in the same
/// batch is still repaired.
fn repair_tool_pairing_except_in_last_group(
    messages: &mut Vec<ChatMessage>,
    skip: &[String],
) -> usize {
    if skip.is_empty() {
        return repair_tool_pairing_except(messages, skip);
    }
    // Only the final assistant(tool_calls) turn can be the suspension that is
    // waiting for user input. Everything before it belongs to completed turns
    // and must be repaired unconditionally, even if a synthesised id collides.
    let Some(last_group) = messages
        .iter()
        .rposition(|m| m.tool_calls.as_ref().is_some_and(|c| !c.is_empty()))
    else {
        return repair_tool_pairing_except(messages, skip);
    };
    let mut head = messages[..last_group].to_vec();
    let mut tail = messages[last_group..].to_vec();
    let mut repaired = repair_tool_pairing_except(&mut head, &[]);
    repaired += repair_tool_pairing_except(&mut tail, skip);
    head.extend(tail);
    *messages = head;
    repaired
}

fn repair_tool_pairing_except(messages: &mut Vec<ChatMessage>, skip: &[String]) -> usize {
    let mut repaired = 0usize;
    let mut i = 0usize;
    while i < messages.len() {
        // Clone to release the borrow before mutating `messages` below.
        let calls = match &messages[i].tool_calls {
            Some(c) if !c.is_empty() => c.clone(),
            _ => {
                i += 1;
                continue;
            }
        };

        // The contiguous run of tool results that follows this assistant turn.
        let mut j = i + 1;
        while j < messages.len() && messages[j].role == Role::Tool {
            j += 1;
        }

        let have: std::collections::HashSet<String> = messages[i + 1..j]
            .iter()
            .filter_map(|m| m.tool_call_id.clone())
            .collect();

        // Append the missing results at the end of the run, in declaration order,
        // so the group stays contiguous and correctly paired.
        let mut insert_at = j;
        for tc in &calls {
            if tc.id.is_empty() || skip.iter().any(|id| id == &tc.id) || have.contains(&tc.id) {
                continue;
            }
            messages.insert(
                insert_at,
                ChatMessage::tool_result(&tc.id, INTERRUPTED_MARKER),
            );
            insert_at += 1;
            repaired += 1;
        }

        // Step past the whole (now complete) group.
        i = insert_at.max(i + 1);
    }
    repaired
}

/// Tool calls whose streamed arguments are not valid JSON — the signature of
/// an output truncated mid tool-call (`finish_reason=length`, dropped
/// connection). Extracted as a pure function so the guard that aborts the
/// turn instead of executing `{}` is testable without a live run.
fn broken_argument_calls(tool_calls: &[ToolCall]) -> Vec<String> {
    tool_calls
        .iter()
        .filter(|tc| serde_json::from_str::<serde_json::Value>(&tc.function.arguments).is_err())
        .map(|tc| tc.function.name.clone())
        .collect()
}

/// Corruption signatures that make a streamed fragment untrustworthy.
///
/// Both were observed live on session work-mw8wizyz (wx-paas-platform), where a
/// single bad byte from the upstream latched the LLM stream's decoder into GBK
/// and mangled the rest of the turn:
///
/// - `\u{FFFD}` — a byte that was not valid UTF-8. An SSE/JSON body is UTF-8 by
///   contract, so a replacement character is *always* upstream damage, never
///   legitimate model output. This is the `` the user reported in
///   the thinking block and the answer bubble.
/// - `<arg_key>` / `<arg_value>` — the *provider's* internal tool-call framing
///   leaking through as data. These tokens do not exist anywhere in this
///   codebase (verified by grep), so their arrival means the upstream
///   mis-framed a call. The leaked markup then sat inside a `file_path`
///   argument, which stayed **valid JSON** and so sailed past
///   [`broken_argument_calls`] into a real `read` of a nonsense path.
///
/// Deliberately NOT in this list: `<tool_call`, `</think>`, `<parameter=`,
/// `tool_calls":`. Those are ordinary text in a repository that works on agent
/// tooling — `git_api.rs` keeps a list of exactly these markers, and this very
/// debugging session quoted them. Rejecting them would break every healthy run
/// that touches this code. [`is_foreign_framing_leak`] is therefore the narrow,
/// high-confidence subset.
///
/// Returns the matched signature names so the log line can say *why*.
pub(crate) fn corruption_signatures(text: &str) -> Vec<&'static str> {
    let mut hits = Vec::new();
    if text.contains('\u{FFFD}') {
        hits.push("U+FFFD");
    }
    if is_foreign_framing_leak(text) {
        hits.push("foreign tool framing");
    }
    hits
}

/// Whether `text` carries the provider's leaked tool-call framing.
///
/// Requires BOTH halves of the pair. A lone `<arg_key>` could plausibly be
/// quoted prose (a user pasting the evidence of this very bug, say); the paired
/// `<arg_key>…</arg_key><arg_value>` shape is what a mis-framed call actually
/// looks like and is not something anyone writes by hand.
fn is_foreign_framing_leak(text: &str) -> bool {
    text.contains("<arg_key>") && text.contains("<arg_value>")
}

/// Tool calls whose arguments parse as JSON but cannot be trusted.
///
/// [`broken_argument_calls`] only rejects *invalid* JSON. The reported failure
/// was the opposite shape: a damaged `file_path` value inside a perfectly
/// well-formed `{"file_path":"…"}` object, which the loop then executed. Running
/// a tool on bytes we know are corrupt is how a `write` destroys a real file and
/// how a `read` sends the model chasing a path that never existed — so this is
/// the second half of the same gate.
///
/// A call is untrusted when its name or arguments carry a corruption signature.
/// Kept separate from the JSON check so the two failure modes stay
/// distinguishable in logs: one means "truncated", this one means "mangled".
fn corrupt_argument_calls(tool_calls: &[ToolCall]) -> Vec<String> {
    tool_calls
        .iter()
        .filter(|tc| {
            !corruption_signatures(&tc.function.name).is_empty()
                || !corruption_signatures(&tc.function.arguments).is_empty()
        })
        .map(|tc| {
            let name = if tc.function.name.is_empty() {
                "<unnamed>"
            } else {
                tc.function.name.as_str()
            };
            name.to_string()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::{FunctionCall, ToolCall};

    // ─── TTFT (time to first token) ─────────────────────────────────────────

    /// TTFT is "model-call request → first upstream frame", null when the model
    /// never responded (never a fabricated 0), and the FIRST latch wins — a later
    /// frame must not rewrite it.
    #[test]
    fn ttft_is_first_upstream_frame_from_request_start() {
        let t0 = std::time::Instant::now();
        let at = |ms| t0 + std::time::Duration::from_millis(ms);
        assert_eq!(ttft_ms_since(t0, None), None, "no model response ⇒ no TTFT");
        assert_eq!(
            ttft_ms_since(t0, Some(at(0))),
            Some(0),
            "instant first token is a real 0"
        );
        assert_eq!(ttft_ms_since(t0, Some(at(1_690))), Some(1_690));
        assert_eq!(
            ttft_ms_since(t0, Some(at(5))),
            Some(5),
            "sub-10ms must not be rounded away"
        );
        // Clock anomaly (first before start) must not underflow to a huge u64.
        assert_eq!(
            ttft_ms_since(at(9_000), Some(t0)),
            Some(0),
            "out-of-order pair clamps to 0"
        );
    }

    /// 【2026-11 用户拍板】TTFT = model first-token latency only. The latch must be
    /// armed at the TRANSPORT (`rx.recv()` arm) by the first upstream frame of ANY
    /// kind — tool-call frames included — measured from that call's request start,
    /// never from the run start (session work-mwlhix12: minutes of local tool
    /// execution leaked into a "518.50s first token"). Retry/Error are transport
    /// signals, not model output; every new model call and every transport retry
    /// re-arms the clock. Source-level pin: a pure-function test cannot see which
    /// arm writes the variable.
    #[test]
    fn ttft_latch_is_armed_at_transport_by_any_frame_and_reset_on_retry() {
        let src = include_str!("mod.rs");
        let norm = src.replace("\r\n", "\n");
        // Only inspect PRODUCT code. The test module below quotes the very same
        // strings these assertions look for; searching the whole file would let a
        // test literal "prove" a wire that was removed from production (a source
        // guard that can never go red). Truncate at the first test module.
        let product = norm.split("#[cfg(test)]").next().unwrap_or("");
        // Latched exactly once, at the transport, from the per-call request clock.
        // Retry AND Error must both be excluded: an exhausted attempt's Error is
        // transport-generated, and latching it would fabricate a "first token"
        // for a model that never responded (null-vs-0 contract).
        assert_eq!(
            product.matches("if model_ttft_ms.is_none()\n                                && !matches!(ev, StreamEvent::Retry { .. } | StreamEvent::Error(_))").count(),
            1,
            "TTFT must latch on the first upstream frame (any kind) in the rx.recv() arm, excluding Retry AND Error"
        );
        assert!(
            product
                .contains("model_ttft_ms = ttft_ms_since(stream_started_at, Some(last_chunk_at));"),
            "TTFT must be measured from THIS call's request start, not the run start"
        );
        // The old run-start → first-visible-character wiring must be gone entirely.
        assert!(
            !product.contains("first_visible_at"),
            "the old run-level visible-character latch must not come back"
        );
        // Every CALL SITE of ttft_ms_since must use the PER-CALL clock: the only
        // legal anchor is stream_started_at. The fn definition itself (which
        // takes a parameter) is not a call site and must be excluded, otherwise
        // the guard is red on correct code. Covers bare and qualified spellings
        // of any other clock.
        let anchor = "ttft_ms_since(stream_started_at,";
        assert!(
            product.contains(anchor),
            "the per-call anchor must be in use"
        );
        let call_sites = product.matches("ttft_ms_since(").count()
            - product.matches("fn ttft_ms_since(").count();
        assert_eq!(
            call_sites,
            product.matches(anchor).count(),
            "every ttft_ms_since call site must anchor at stream_started_at \
             (run-start / fabricated clocks are forbidden)"
        );
        // A fresh model call re-arms the clock right beside its stream clock.
        // This covers the react-layer retries (empty/partial-output, corruption
        // gate) which `continue` without a transport Retry event: without this
        // reset an Error-only attempt would leave the next call showing '--'.
        let call_start = product
            .split("let stream_started_at = std::time::Instant::now();")
            .nth(1)
            .unwrap_or("")
            .split("loop {")
            .next()
            .unwrap_or("");
        assert!(
            call_start.contains("model_ttft_ms = None;"),
            "each model call must reset the TTFT latch beside stream_started_at"
        );
        // The retry branch re-arms the latch BEFORE the delivered/not-delivered
        // split, so both retry shapes restart the model clock; the decode segment
        // reset stays in the delivered branch.
        // Whitespace-normalised copy for layout-sensitive splits: rustfmt may
        // wrap the match-arm pattern across lines.
        let flat: String = product.split_whitespace().collect::<Vec<_>>().join(" ");
        // rustfmt may keep the arm pattern on one line or expand it per-field
        // (with a trailing comma); accept both layouts.
        let retry = flat
            .split("StreamEvent::Retry { attempt, max, reason, delivered } =>")
            .nth(1)
            .or_else(|| {
                flat.split("StreamEvent::Retry { attempt, max, reason, delivered, } =>")
                    .nth(1)
            })
            .unwrap_or("")
            .split("emit!(Frame::stream_retry")
            .next()
            .unwrap_or("");
        assert!(
            retry.contains("first_content_at = None;"),
            "retry must drop the aborted decode segment"
        );
        assert!(
            retry.contains("model_ttft_ms = None;"),
            "retry is a fresh request: the model first-token clock must restart"
        );
        let (before_split, _after) = retry
            .split_once("if !delivered {")
            .expect("delivered split must exist");
        assert!(
            before_split.contains("model_ttft_ms = None;"),
            "the TTFT reset must cover pre-first-byte retries too"
        );
        // Wire it into the settlement frame.
        assert!(
            product.contains("ttft_ms: model_ttft_ms,"),
            "context_size payload must carry the latched model TTFT"
        );
    }

    fn call(id: &str, name: &str) -> ToolCall {
        ToolCall {
            id: id.to_string(),
            call_type: "function".into(),
            function: FunctionCall {
                name: name.into(),
                arguments: "{}".into(),
            },
        }
    }

    fn assistant_calling(ids: &[(&str, &str)]) -> ChatMessage {
        ChatMessage {
            role: Role::Assistant,
            content: None,
            tool_calls: Some(ids.iter().map(|(id, n)| call(id, n)).collect()),
            tool_call_id: None,
            name: None,
        }
    }

    // ─── tool-visibility guard (task ended unfinished) ───────────────────

    /// End-to-end shape of the incident the guard fixes. Before the fix, a
    /// settings file with `permission.tools = []` filtered out EVERY definition
    /// (including the skill tools), `dialect.rs` omitted the `tools` key, and
    /// the model — told by the system prompt to "call tools directly" but
    /// seeing none — replied with a one-line intent declaration that the loop
    /// closed as `Completed`. Reproduced in session work-mw3cpqs4: three
    /// consecutive `turns=1 stop=Completed` runs, zero `executing tool`,
    /// inputTokens ~2.7K vs ~15.8K once tools were visible again.
    #[test]
    fn empty_permission_allowlist_still_offers_tools_to_the_model() {
        let reg = crate::tools::ToolRegistry::default_registry();
        let mut perm = crate::config::PermissionSettings::default();
        perm.tools = vec![];
        let defs = reg.definitions(&perm, None);
        // Layer 1: fail-open, so the wire request carries `tools` again.
        assert!(defs.len() > 10, "empty allowlist must not blind the model");
        // Layer 2: the system prompt gets a compact roster from THAT SAME list.
        let roster = crate::react::prompt::tool_roster_prompt(Some(&defs));
        assert!(roster.contains("Available tools"), "{}", roster);
        assert!(
            roster.contains("skillread"),
            "skill tools must be visible in the roster"
        );
        assert!(
            !roster.contains("\"properties\""),
            "roster must not duplicate the JSON Schema"
        );
        assert!(
            roster.len() < 2300,
            "roster must stay token-cheap, got {}",
            roster.len()
        );
        // Layer 3: a genuinely empty list is an explicit, honest state.
        assert!(crate::react::prompt::tool_roster_prompt(None).is_empty());
        assert!(crate::react::prompt::NO_TOOLS_NOTICE.contains("无可用工具"));
    }

    /// Source pin: the guard must be wired into `run_inner`, not left as an
    /// unused helper that a later refactor can silently drop. A pure-function
    /// test alone would stay green forever if the call site disappeared.
    #[test]
    fn tool_visibility_guard_is_wired_into_run_inner() {
        let src = include_str!("mod.rs");
        let product = src.split("#[cfg(test)]").next().unwrap_or("");
        let run_inner = product
            .split_once("async fn run_inner(")
            .map(|(_, rest)| {
                rest.split("/// Marker written for a tool call")
                    .next()
                    .unwrap_or("")
            })
            .unwrap_or("");
        assert!(
            run_inner.contains("tool_roster_prompt(tools.as_deref())"),
            "the compact roster must be derived from the same tools sent on the wire"
        );
        assert!(
            run_inner.contains("NO_TOOLS_NOTICE"),
            "an empty tool set must be stated explicitly to the model"
        );
        assert!(
            run_inner.contains("ChatMessage::system(sys_text)"),
            "the roster must be appended to the system message"
        );
        // The wire definitions and the roster must come from ONE list.
        assert!(
            run_inner.contains("Some(tool_defs.clone())"),
            "wire tools and the prompt roster must share one source"
        );
    }

    // ─── terminal done gate (abnormal exits must close the UI) ───────────

    /// Every `Error` / `MaxTurns` return inside `run_inner` emits `error` but
    /// historically did NOT emit `done`; the frontend only leaves its streaming
    /// state on `done`, so the run looked like "ended unfinished" — after the
    /// last tool card, or after a lone thinking block, with no final answer.
    /// The fix lives in `run()`'s single exit gate, not at each return, so this
    /// guard pins the gate's shape: it must match both reasons, must not fire
    /// for Completed/Cancelled/Suspended (they already emitted their own done),
    /// and must send through the same channel with a monotonic seq.
    #[test]
    fn abnormal_exits_close_with_done_at_the_single_gate() {
        let src = include_str!("mod.rs");
        let run = src
            .split_once("pub async fn run(")
            .expect("run present")
            .1
            .split_once("/// The loop itself; `run` wraps it")
            .expect("run_inner follows run")
            .0;
        assert!(
            run.contains(
                "if matches!(result.stop_reason, StopReason::Error | StopReason::MaxTurns)"
            ),
            "the terminal gate must cover BOTH Error and MaxTurns"
        );
        assert!(
            run.contains("Frame::done(&config.session_id)"),
            "the gate must actually emit done"
        );
        assert!(
            run.contains(".seq(result.next_seq)") && run.contains("result.next_seq += 1"),
            "done must be seq-stamped so replay ordering stays exact"
        );
        assert!(
            run.contains("Frame::steer_dropped") && run.contains("true,"),
            "late interjections must be handed back before done"
        );
        // Negative shape: the gate must NOT live inside run_inner's nine
        // individual returns (that is the shape that kept missing exits).
        let inner = src
            .split_once("async fn run_inner(")
            .expect("run_inner present")
            .1
            .split_once("/// Marker written for a tool call")
            .expect("helpers follow the loop")
            .0;
        let error_returns = inner.matches("emit!(Frame::error(").count();
        assert!(
            error_returns >= 7,
            "guard premise: run_inner has many error exits, got {error_returns}"
        );
        let done_in_inner = inner.matches("emit!(Frame::done(").count();
        assert!(
            done_in_inner == 6,
            "only the 4 cancel paths + completion + complete_task direct-through should own a done; got {done_in_inner}"
        );
        // Wiring guard: the pure function below is unit-tested, but that proves
        // nothing about whether `run()` actually calls it. A mutation that
        // swapped this back to the whole-history `repair_tool_pairing_except`
        // left every behaviour test green — the resumed request would still
        // 400 on a reused synthesised call id.
        assert!(
            run.contains("repair_tool_pairing_except_in_last_group("),
            "the run exit gate must scope the suspension exemption to the last group"
        );
    }

    // ─── suspension exemption must not leak into older groups ───────────

    #[test]
    fn suspension_skip_does_not_exempt_an_older_orphan_with_the_same_id() {
        // Gemini synthesises `gemini-call-0` per stream, so the very
        // same id can appear in an older, genuinely orphaned group and in the
        // pending suspension. A global string match would exempt both and the
        // resumed request would 400 on the unpaired older call.
        let mut msgs = vec![
            ChatMessage::user("task"),
            assistant_calling(&[("gemini-call-0", "bash")]), // older orphan
            ChatMessage::user("follow-up"),
            assistant_calling(&[("gemini-call-0", "ask_user")]), // pending
        ];
        let skip = vec!["gemini-call-0".to_string()];
        let repaired = repair_tool_pairing_except_in_last_group(&mut msgs, &skip);
        assert_eq!(repaired, 1, "only the older orphan is repaired");
        let results: Vec<_> = msgs
            .iter()
            .filter(|m| m.tool_call_id.as_deref() == Some("gemini-call-0"))
            .collect();
        // Exactly one placeholder: the older group. The pending one stays free
        // for spawn_resume to inject the real answer.
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].content_text(), INTERRUPTED_MARKER);
        assert!(
            msgs.last().unwrap().tool_calls.is_some(),
            "the pending suspension must remain the last turn, unrepaired"
        );
    }

    // ─── broken_argument_calls (truncation guard) ────────────────────

    #[test]
    fn truncated_tool_arguments_are_detected_before_execution() {
        let mut tc = call("c1", "write");
        tc.function.arguments = "{\"file_path\": \"a.rs\", \"content\": \"half-writ".into();
        assert_eq!(broken_argument_calls(&[tc]), vec!["write".to_string()]);
    }

    #[test]
    fn complete_tool_arguments_pass_the_guard() {
        let a = call("c1", "bash"); // arguments = "{}"
        let mut b = call("c2", "write");
        b.function.arguments = "{\"file_path\":\"x\"}".into();
        assert!(broken_argument_calls(&[a, b]).is_empty());
    }

    // ─── corruption gate (U+FFFD / leaked provider framing) ────────────────
    //
    // These pin the exact damage recorded on session work-mw8wizyz. The point
    // the first test proves is subtle and is *why* this gate exists at all: the
    // corrupt arguments below are VALID JSON, so `broken_argument_calls` waves
    // them through and the loop runs a real tool on them.

    /// The reported bug: a mangled `file_path` that is still well-formed JSON.
    /// `broken_argument_calls` must NOT catch it (it parses fine) while
    /// `corrupt_argument_calls` must — proving the two gates are not redundant.
    #[test]
    fn valid_json_with_corrupt_value_is_caught_only_by_the_corruption_gate() {
        let mut tc = call("c1", "read");
        // Verbatim shape from the stream dump: leaked `<arg_key>/<arg_value>`
        // framing plus dropped characters, all inside a valid JSON object.
        tc.function.arguments =
            "{\"file_path\":\"37/w 20 |4 Util ...\\\"</think></think><tool_call>bash<arg_key>command</arg_key><arg_value>Select-String -Path/w-ai/wxai-agent/src/main/java/org/d/org/grom/ai/models/ChatClient.java\"}"
                .into();
        assert!(
            serde_json::from_str::<serde_json::Value>(&tc.function.arguments).is_ok(),
            "precondition: this is valid JSON, so the truncation gate cannot see it"
        );
        assert!(
            broken_argument_calls(&[tc.clone()]).is_empty(),
            "the truncation gate must stay blind to valid JSON (it is the corruption gate's job)"
        );
        assert_eq!(
            corrupt_argument_calls(&[tc]),
            vec!["read".to_string()],
            "leaked provider framing inside a valid JSON value must be rejected before execution"
        );
    }

    /// A replacement character in the argument value is caught too, and the
    /// tool name is reported (a corrupt *name* cannot be executed either).
    #[test]
    fn replacement_char_in_arguments_is_corrupt() {
        let mut tc = call("c1", "read");
        tc.function.arguments = "{\"file_path\":\"src/\u{FFFD}main.rs\"}".into();
        assert_eq!(corrupt_argument_calls(&[tc]), vec!["read".to_string()]);
    }

    /// A corrupt tool *name* is flagged, and an empty name is reported as
    /// `<unnamed>` rather than dropped silently from the message.
    #[test]
    fn corrupt_name_is_flagged_and_empty_name_is_named() {
        let mut named = call("c1", "read");
        named.function.name = "re\u{FFFD}d".into();
        assert_eq!(
            corrupt_argument_calls(&[named]),
            vec!["re\u{FFFD}d".to_string()]
        );

        let mut anon = call("c2", "");
        anon.function.name = String::new();
        anon.function.arguments = "{\"p\":\"\u{FFFD}\"}".into();
        assert_eq!(
            corrupt_argument_calls(&[anon]),
            vec!["<unnamed>".to_string()]
        );
    }

    /// Healthy arguments of every kind must pass. This is the false-positive
    /// guard: `<tool_call>`, `</think>`, `<parameter=`, `tool_calls":` and a lone
    /// `<arg_key>` are all legitimate text in a repo that works on agent tooling
    /// (and this very debugging session quoted them), so only the *paired*
    /// `<arg_key>…<arg_value>` framing and U+FFFD may trip the gate.
    #[test]
    fn agent_tooling_text_in_arguments_is_not_corruption() {
        let mut a = call("c1", "grep");
        a.function.arguments = "{\"pattern\":\"<tool_call>\",\"include\":\"*.rs\"}".into();
        let mut b = call("c2", "grep");
        b.function.arguments =
            "{\"pattern\":\"<parameter=|tool_calls\\\\\\\":\",\"include\":\"*\"}".into();
        let mut c = call("c3", "write");
        // A lone `<arg_key>` is quotable prose; only the paired framing counts.
        c.function.arguments =
            "{\"file_path\":\"x.md\",\"content\":\"the token <arg_key> appears\"}".into();
        let mut d = call("c4", "read");
        d.function.arguments = "{\"file_path\":\"src/main.rs\"}".into();
        assert!(
            corrupt_argument_calls(&[a, b, c, d]).is_empty(),
            "agent-tooling markup and lone fragments are not corruption"
        );
    }

    /// The paired framing signature is what fires, and both halves are
    /// required — this is the anti-false-positive contract for the leak check.
    #[test]
    fn foreign_framing_leak_requires_the_paired_shape() {
        assert!(is_foreign_framing_leak(
            "<arg_key>command</arg_key><arg_value>x</arg_value>"
        ));
        assert!(
            !is_foreign_framing_leak("only <arg_key> here"),
            "a lone key is prose"
        );
        assert!(
            !is_foreign_framing_leak("only <arg_value> here"),
            "a lone value is prose"
        );
        assert!(
            !is_foreign_framing_leak("clean arguments"),
            "clean text never trips"
        );
    }

    /// `corruption_signatures` names every hit so logs and the user-facing
    /// error can say *why*, and clean text yields nothing.
    #[test]
    fn corruption_signatures_reports_each_hit() {
        assert_eq!(corruption_signatures("healthy text").len(), 0);
        assert_eq!(corruption_signatures("bad \u{FFFD} byte"), vec!["U+FFFD"]);
        assert_eq!(
            corruption_signatures("<arg_key>x</arg_key><arg_value>y</arg_value>"),
            vec!["foreign tool framing"]
        );
        // Both at once (the real dump had both): order is stable.
        let both = corruption_signatures("\u{FFFD} <arg_key>x</arg_key><arg_value>y</arg_value>");
        assert_eq!(both, vec!["U+FFFD", "foreign tool framing"]);
    }

    /// Prose corruption detection used by the keep-the-answer branch: content
    /// with a replacement character is flagged, clean content is not.
    #[test]
    fn prose_corruption_is_detected_in_content_buffer() {
        assert!(
            corruption_signatures("a normal assistant reply").is_empty(),
            "clean prose must not trip the gate"
        );
        assert!(
            !corruption_signatures("a reply with \u{FFFD} inside").is_empty(),
            "a replacement character in prose is corruption"
        );
    }

    // ─── repair_tool_pairing ────────────────────────────────────────────────

    #[test]
    fn healthy_history_is_left_untouched() {
        let mut msgs = vec![
            ChatMessage::system("sys"),
            ChatMessage::user("task"),
            assistant_calling(&[("c1", "read")]),
            ChatMessage::tool_result("c1", "ok"),
            ChatMessage::assistant("done"),
        ];
        let before = msgs.clone();
        assert_eq!(
            repair_tool_pairing(&mut msgs),
            0,
            "healthy history needs no repair"
        );
        assert_eq!(msgs.len(), before.len());
        assert_eq!(
            msgs[3].content_text(),
            "ok",
            "existing results must not be touched"
        );
    }

    #[test]
    fn orphaned_call_gets_a_placeholder_result() {
        // The exact shape a Stop mid-turn produces: the assistant turn was
        // persisted, its tool result never was.
        let mut msgs = vec![
            ChatMessage::system("sys"),
            ChatMessage::user("task"),
            assistant_calling(&[("c1", "bash")]),
        ];
        assert_eq!(repair_tool_pairing(&mut msgs), 1);
        assert_eq!(msgs.len(), 4);
        let last = &msgs[3];
        assert_eq!(last.role, Role::Tool);
        assert_eq!(last.tool_call_id.as_deref(), Some("c1"));
        assert!(last.content_text().contains("未执行完成"));
    }

    #[test]
    fn partially_completed_parallel_batch_is_filled_in_order() {
        // Three calls declared, only the middle one produced a result before the
        // interrupt. Both missing ones must be filled, in declaration order.
        let mut msgs = vec![
            assistant_calling(&[("a", "read"), ("b", "read"), ("c", "read")]),
            ChatMessage::tool_result("b", "middle result"),
        ];
        assert_eq!(repair_tool_pairing(&mut msgs), 2);
        let ids: Vec<Option<String>> = msgs
            .iter()
            .filter(|m| m.role == Role::Tool)
            .map(|m| m.tool_call_id.clone())
            .collect();
        assert_eq!(
            ids,
            vec![Some("b".into()), Some("a".into()), Some("c".into())],
            "existing result stays first, missing ones appended in declaration order"
        );
        assert_eq!(
            msgs[1].content_text(),
            "middle result",
            "real result must survive"
        );
    }

    #[test]
    fn repair_is_idempotent() {
        let mut msgs = vec![assistant_calling(&[("c1", "bash")])];
        assert_eq!(repair_tool_pairing(&mut msgs), 1);
        assert_eq!(
            repair_tool_pairing(&mut msgs),
            0,
            "second pass must be a no-op"
        );
        assert_eq!(msgs.len(), 2);
    }

    #[test]
    fn repair_handles_multiple_groups_in_one_history() {
        let mut msgs = vec![
            assistant_calling(&[("c1", "read")]),
            ChatMessage::tool_result("c1", "ok"),
            ChatMessage::assistant("thinking"),
            assistant_calling(&[("c2", "bash")]), // orphan
            ChatMessage::user("next"),
            assistant_calling(&[("c3", "grep")]), // orphan
        ];
        assert_eq!(repair_tool_pairing(&mut msgs), 2);
        // Every declared call now has exactly one result.
        for id in ["c1", "c2", "c3"] {
            let n = msgs
                .iter()
                .filter(|m| m.tool_call_id.as_deref() == Some(id))
                .count();
            assert_eq!(n, 1, "{id} must have exactly one tool result");
        }
        // The c2 placeholder must sit before the following user message, keeping
        // the group contiguous.
        let c2 = msgs
            .iter()
            .position(|m| m.tool_call_id.as_deref() == Some("c2"))
            .unwrap();
        let user = msgs
            .iter()
            .position(|m| m.content_text() == "next")
            .unwrap();
        assert!(c2 < user, "c2 result must precede the later user message");
    }

    #[test]
    fn repair_leaves_the_suspended_call_alone_but_heals_its_siblings() {
        // Real shape when ask_user shares a batch with another tool: the
        // question's result is pending user input (must NOT be faked), while a
        // sibling that died mid-flight still needs a placeholder.
        let mut msgs = vec![
            ChatMessage::user("task"),
            assistant_calling(&[("c-ask", "ask_user"), ("c-dead", "bash")]),
        ];
        let skip = vec!["c-ask".to_string()];
        assert_eq!(repair_tool_pairing_except(&mut msgs, &skip), 1);
        assert_eq!(
            msgs.iter()
                .filter(|m| m.tool_call_id.as_deref() == Some("c-ask"))
                .count(),
            0,
            "suspended call must stay unrepaired so spawn_resume can inject the real answer"
        );
        assert_eq!(
            msgs.iter()
                .filter(|m| m.tool_call_id.as_deref() == Some("c-dead"))
                .count(),
            1,
            "the other orphan still needs a placeholder"
        );
    }

    #[test]
    fn empty_call_id_is_not_repaired() {
        // A call with no id cannot be paired with anything; inventing a result
        // for it would add a message the provider cannot match either.
        let mut msgs = vec![assistant_calling(&[("", "read")])];
        assert_eq!(repair_tool_pairing(&mut msgs), 0);
        assert_eq!(msgs.len(), 1);
    }

    // ─── prompt wording contracts ───────────────────────────────────────────

    #[test]
    fn loop_reminder_never_orders_a_final_answer() {
        // The wording that broke Java session work-mupc5nd0: telling the model to
        // "output your Final Answer" made it emit a one-line intent declaration,
        // which the text-only branch judged as the final answer — ending a Loop
        // with 0/10 TODOs done. The reminder may only suggest a different angle.
        let p = loop_detected_prompt(3);
        assert!(p.contains("Loop Detected"));
        assert!(p.contains("更换思路"));
        assert!(
            !p.contains("直接输出 Final Answer"),
            "must not force convergence"
        );
        // It must still offer both exits, so a genuinely finished task can end.
        assert!(p.contains("若确认任务已全部完成"));
        assert!(p.contains("若尚未完成"));
    }

    #[test]
    fn completion_check_offers_both_exits() {
        // 契约 §2.2「补缺式」：三分支——继续做 / 直接确认结束 / 只补遗漏。
        // 旧断言「完整总结报告」正是双份总结的成因，按新文案反转。
        let p = completion_check_prompt(1);
        assert!(p.contains("Completion Check"));
        assert!(
            p.contains("继续执行它们，不要停止"),
            "must allow continuing"
        );
        assert!(
            p.contains("直接确认结束，不要重复输出已说过的内容"),
            "must allow ending without repeating"
        );
        assert!(p.contains("只补充遗漏部分"), "must allow gap-filling only");
        assert!(
            p.contains("严禁复述已交付的总结"),
            "must forbid re-summarising"
        );
        assert!(
            !p.contains("完整总结报告"),
            "旧「重新输出完整总结」文案必须消失"
        );
        assert!(p.contains("1/2"), "must show the deferral counter");
        assert!(!p.contains("直接输出 Final Answer"));
    }

    // ─── 契约 §2.1：收敛门禁放行判据 ─────────────────────────────────────────

    /// TODO 全完成 → 放行（即使回答很短）。清单是模型自己维护的完成证据。
    #[test]
    fn converge_releases_when_todo_all_done() {
        let done = "## H\n- [x] A\n- [x] B\n";
        assert!(converge_release("改完了。", Some(done)));
    }

    /// TODO 有未完成项且回答短 → 不放行（原门禁行为保持）。
    #[test]
    fn converge_still_defers_short_answer_with_open_todo() {
        let open = "- [x] A\n- [ ] B\n";
        assert!(!converge_release("接下来修 B。", Some(open)));
        let in_progress = "- [/] A\n";
        assert!(!converge_release("正在做 A。", Some(in_progress)));
    }

    /// 回答去空白 ≥400 字符 → 放行（即使 TODO 仍有未完成项——已成规模的回答
    /// 是完整交付，打回重写只会产出第二份重复总结）。
    #[test]
    fn converge_releases_substantial_answer_regardless_of_todo() {
        let long = "甲".repeat(400);
        assert!(converge_release(&long, Some("- [ ] B\n")));
        assert!(converge_release(&long, None));
        // 空白不计入：399 个实字符 + 大量空白仍不放行。
        let padded = format!("{}{}", "甲".repeat(399), " \n\t".repeat(100));
        assert!(!converge_release(&padded, None));
        // 恰好 400（含空白剔除后）放行——边界闭区间。
        let exact = format!("{}{}", "甲".repeat(200), "乙 ".repeat(200));
        assert!(converge_release(&exact, None));
    }

    /// 读取失败/无清单 → 该判据不命中，保守走原门禁；空清单不算「全部完成」。
    #[test]
    fn converge_missing_or_empty_todo_is_conservative() {
        assert!(!converge_release("短回答", None));
        assert!(!converge_release("短回答", Some("")));
        assert!(!converge_release("短回答", Some("完全不是清单")));
    }

    /// 源码级守护：门禁分支必须真的接上放行判据（纯函数测试全绿但调用点
    /// 漏接是本仓库踩过的坑，见 forced_compact 的教训）。
    #[test]
    fn converge_gate_call_site_uses_release_predicate() {
        let src = include_str!("mod.rs");
        let norm: String = src.split_whitespace().collect();
        assert!(
            norm.contains("ifconverge_release(&answer,todo_raw.as_deref())"),
            "converge gate must consult converge_release before deferring"
        );
        assert!(
            norm.contains("crate::session::todo_path("),
            "release predicate must read the session TODO via session::todo_path"
        );
    }

    #[test]
    fn rethink_prompt_carries_the_turn_number() {
        let p = rethink_prompt(17);
        assert!(p.contains("Self-Reflection"));
        assert!(p.contains("第 17 回合"));
        assert!(p.contains("核心目标检查"));
        assert!(p.contains("强制收敛"));
    }

    #[test]
    fn converge_gate_is_bounded() {
        // An unbounded gate is its own dead loop: the model wants to stop but
        // never can. Two deferrals is the contract.
        assert_eq!(MAX_CONVERGE_DEFERRALS, 2);
        assert_eq!(
            LOOP_REMINDER_THRESHOLDS,
            [3, 5, 8],
            "DSH repeat-tool-reminder defaults"
        );
        assert_eq!(MAX_EMPTY_ROUNDS, 3, "Java emptyRetryCounter cap");
    }

    // ─── P0: loop fingerprint (full-value hashing) ─────────────────────────

    fn tc(name: &str, args: &str) -> ToolCall {
        ToolCall {
            id: format!("call_{name}"),
            call_type: "function".into(),
            function: crate::llm::FunctionCall {
                name: name.into(),
                arguments: args.into(),
            },
        }
    }

    #[test]
    fn fingerprint_ignores_key_order_and_whitespace() {
        // The old fingerprint used the raw arguments string, so `read` with
        // reordered keys looked like a *different* call and the detector was
        // blind to it. Canonicalisation must treat these as identical.
        let a = loop_fingerprint(&[tc("read", r#"{"path":"a.rs","offset":1}"#)], "");
        let b = loop_fingerprint(&[tc("read", r#"{ "offset": 1, "path": "a.rs" }"#)], "");
        assert_eq!(a, b);
        assert!(a.is_some());
    }

    #[test]
    fn fingerprint_keeps_real_differences() {
        // Different file paths are substantively different calls — they must
        // NOT be collapsed by canonicalisation.
        let a = loop_fingerprint(&[tc("read", r#"{"path":"a.rs"}"#)], "");
        let b = loop_fingerprint(&[tc("read", r#"{"path":"b.rs"}"#)], "");
        assert_ne!(a, b);
    }

    #[test]
    fn fingerprint_name_only_tools_drop_args() {
        // todowrite's args change every round *by design* (the list grows as
        // work progresses). Including them made normal progress look like
        // variance and the detector blind — the measured 0-triggers root cause.
        let a = loop_fingerprint(&[tc("todowrite", r#"{"todos":[1,2,3]}"#)], "");
        let b = loop_fingerprint(&[tc("todowrite", r#"{"todos":[1,2,3,4,5]}"#)], "");
        assert_eq!(a, b, "todowrite must fingerprint by name only");
    }

    #[test]
    fn fingerprint_unparseable_args_yields_none() {
        // Java's policy: better miss than misjudge. A broken payload makes the
        // fingerprint unreliable, so the round must not participate in loop
        // counting at all (not "count as identical to the last one").
        assert!(loop_fingerprint(&[tc("bash", "{not json")], "").is_none());
    }

    #[test]
    fn fingerprint_text_rounds_hash_the_prefix() {
        // Text-only rounds participate via a hashed 120-char prefix. No turn
        // stamp: stamping makes even a genuinely repeated reply look different.
        let a = loop_fingerprint(&[], "我认为应该先检查配置文件的内容");
        let b = loop_fingerprint(&[], "我认为应该先检查配置文件的内容");
        let c = loop_fingerprint(&[], "完全不同的另一段文本，用来对照");
        assert_eq!(a, b);
        assert_ne!(a, c);
        // Empty content rounds have no fingerprint at all.
        assert!(loop_fingerprint(&[], "   ").is_none());
        // The fingerprint must depend ONLY on the prefix: two 200-char texts
        // sharing the first 120 chars are the same fingerprint even though
        // their lengths (and hence any length-derived stamp) differ. This is
        // the mutation-detection pin: a stamp derived from length or position
        // turns a genuine repeat into "different" and the detector blind.
        let shared: String = "同一段完全相同的前缀内容用来对齐指纹。".repeat(8); // >120 chars, identical in both
        let long1 = shared.clone() + "然后甲版本开始分叉，后续内容各不相同甲甲甲";
        let long2 = shared.clone() + "乙版本从这里开始完全不一样乙乙乙乙乙乙";
        assert!(shared.chars().count() >= 120);
        assert_eq!(
            loop_fingerprint(&[], &long1),
            loop_fingerprint(&[], &long2),
            "same 120-char prefix must fingerprint identically despite length diff"
        );
    }

    // ─── Output volume must never gate the turn budget ─────────────────────

    /// Per-round completion-token deltas from run-8248faa3, recovered from the
    /// `context_size` frames of a run that was reading files, grepping and
    /// writing its TODO list (13 successful tool calls on record) when it was
    /// killed with "no observable progress across recent turns".
    ///
    /// This is a production distribution, not a hand-picked one. The removed
    /// check treated "< 500 tokens in a round" as filler, and every single
    /// round here is under 200 — which is simply what one sentence of
    /// narration plus one tool call costs. The earlier test for this logic
    /// defined a "healthy" round as 800+ tokens, so it passed while the
    /// shipped behaviour killed healthy runs.
    const MEASURED_HEALTHY_DELTAS: [u64; 18] = [
        49, 103, 153, 178, 120, 32, 69, 181, 121, 100, 113, 153, 148, 109, 47, 79, 121, 77,
    ];

    #[test]
    fn real_agent_rounds_are_small_and_must_not_be_judged_as_filler() {
        // Pins the premise of the regression: if a future change reintroduces
        // an output-volume judgement, this is the distribution it has to
        // survive. The 500-token bar failed on all 18 rounds.
        assert!(
            MEASURED_HEALTHY_DELTAS.iter().all(|d| *d < 500),
            "measured healthy rounds all fall under the old 500-token filler bar"
        );
        let max = MEASURED_HEALTHY_DELTAS.iter().copied().max().unwrap();
        assert_eq!(max, 181, "busiest healthy round in the sample");
    }

    #[test]
    fn turn_budget_has_no_output_volume_or_no_progress_gate() {
        // Java extends unconditionally at the threshold (`ReasonTask.java`
        // 500-528) and has no diminishing-output or no-progress judgement
        // anywhere; a repo-wide search for diminish/deltaToken/noProgress/
        // stagnat finds nothing. Keep this kernel aligned: the only thing
        // allowed to bound AutoRethink is an exhausted context window. The
        // loop-reminder cap joined the ban list on 2026-11-20 (work-mwod1kcs).
        let src = include_str!("mod.rs");
        // Scope to the loop body: the comment block explaining *why* these
        // names are gone, and this test itself, both mention them by design.
        let body = src
            .split("async fn run_inner")
            .nth(1)
            .and_then(|s| s.split("mod tests").next())
            .expect("run_inner body must be locatable");
        // Strip line comments: the extension point's own explanation quotes
        // the banned identifiers verbatim.
        let body: String = body
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n");
        let body = body.as_str();
        for banned in [
            "DIMINISHING_DELTA_TOKENS",
            "DIMINISHING_MIN_TURNS",
            "DIMINISHING_STOP_ROUNDS",
            "NO_PROGRESS_STOP_ROUNDS",
            "diminishing_rounds",
            "no_progress_rounds",
            // 2026-11-20: the repetition-based hard stop is banned too. It
            // killed work-mwod1kcs (448 turns of legitimate debugging judged
            // as "repeated unproductive tool calls"). Reminders are advisory.
            // (The explaining comment at the extension point mentions the old
            // identifiers by design, so strip comments before the ban scan.)
            "MAX_LOOP_REMINDERS",
            "loop_reminders",
        ] {
            assert!(
                !body.contains(banned),
                "`{banned}` is back in the loop body: behavioural judgements \
                 must not gate the turn budget (killed healthy runs)"
            );
        }
        assert!(
            body.contains("if context_exhausted {"),
            "the extension point must gate on context exhaustion only"
        );
        assert!(
            !body.contains("no observable progress"),
            "the stop reason that killed healthy runs must not come back"
        );
        assert!(
            !body.contains("repeated unproductive tool calls"),
            "the stop reason that killed work-mwod1kcs must not come back"
        );
    }

    /// Name-based bans are not enough: the defect can be reintroduced under
    /// any identifier (mutation N1 added a bare `|| turns >= 10` and survived
    /// the ban list). Pin the *shape* instead — the extension-point condition
    /// must be exactly the one allowed term, so any extra disjunct fails
    /// regardless of how it is spelled.
    #[test]
    fn extension_point_condition_has_exactly_one_allowed_term() {
        let src = include_str!("mod.rs");
        let marker = "let threshold = (max_turns - 1).max((max_turns as f64 * 0.8) as u32);";
        let after = src
            .split(marker)
            .nth(1)
            .expect("AutoRethink threshold computation must exist");
        let cond = after
            .split_once("if turns >= threshold {")
            .and_then(|(_, rest)| rest.split_once('{'))
            .map(|(head, _)| {
                // Strip line comments: the block explains the removed disjunct
                // by quoting it verbatim.
                head.lines()
                    .map(|l| l.split("//").next().unwrap_or(""))
                    .collect::<Vec<_>>()
                    .join(" ")
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .expect("the extension point must guard on `turns >= threshold`");
        assert_eq!(
            cond, "if context_exhausted",
            "the early-stop condition at the AutoRethink extension point must \
             stay exactly this one term. Java extends unconditionally here \
             (`ReasonTask.java:500-528`); every extra disjunct added to this \
             line so far has stopped healthy runs — including the loop-reminder \
             cap removed on 2026-11-20 (work-mwod1kcs)."
        );
    }

    /// Pinning the condition line is still not enough. Two mutations proved it:
    /// N5 added a separate early `return` *before* the turn-budget block, and
    /// N6 folded `|| turns >= 13` into `context_exhausted`'s definition. Both
    /// reintroduced the defect verbatim, both left the guarded line
    /// byte-identical, and both survived the whole 65-test suite.
    ///
    /// Count the stop sites instead. The turn budget may end a run in exactly
    /// two places: the AutoRethink early stop and the non-AutoRethink hard
    /// stop. Any third `StopReason::MaxTurns` return in the loop body is a new
    /// way to kill a run early, whatever it is called and wherever it sits.
    #[test]
    fn loop_body_has_exactly_two_turn_budget_stop_sites() {
        let src = include_str!("mod.rs");
        let body = src
            .split("async fn run_inner")
            .nth(1)
            .and_then(|s| s.split("mod tests").next())
            .expect("run_inner body must be locatable");
        let sites = body.matches("stop_reason: StopReason::MaxTurns,").count();
        assert_eq!(
            sites, 2,
            "the turn budget must end a run in exactly two places (AutoRethink \
             early stop + non-AutoRethink hard stop). A third one means a new \
             early-kill path was added; mutation N5 added one before the \
             budget block and passed every other test in this file."
        );
    }

    /// Closes the N6 route: the early stop reads `context_exhausted`, so
    /// anything folded into that variable's definition reaches the stop without
    /// touching the guarded condition. Pin the definition to the token budget
    /// alone — it must stay a statement about context size, not about turns.
    #[test]
    fn context_exhausted_is_defined_only_by_the_token_budget() {
        let src = include_str!("mod.rs");
        let body = src
            .split("async fn run_inner")
            .nth(1)
            .and_then(|s| s.split("mod tests").next())
            .expect("run_inner body must be locatable");
        let def = body
            .split("let context_exhausted =")
            .nth(1)
            .and_then(|s| s.split_once(';'))
            .map(|(head, _)| head.trim().to_string())
            .expect("context_exhausted must be defined in the loop body");
        assert_eq!(
            def, "outcome.after_tokens > compress_cfg.trigger_threshold()",
            "`context_exhausted` must mean exactly \"compression could not get \
             back under the trigger\". Mutation N6 appended `|| turns >= 13` \
             here and reintroduced the healthy-run kill while the extension \
             point itself stayed byte-identical."
        );
        assert_eq!(
            body.matches("let context_exhausted =").count(),
            1,
            "only one definition, or the pinned one above can be shadowed"
        );
    }

    // ─── P2: retry/latency budget ──────────────────────────────────────────

    /// Pure-function model of the retry gate: given the failure class, the
    /// round's timeout counter, and whether *this model call's* deadline is past,
    /// decide retry vs stop. Mirrors the loop body's `!fatal && !timeout_out &&
    /// !deadline_out && turns < max_turns` exactly — the lesson from the D-1
    /// round: Windows timer granularity makes wall-clock tests flaky, so the
    /// decision logic is table-driven and the loop only threads state in.
    fn retry_gate(
        fatal: bool,
        timeout_class: bool,
        timeout_retries: u32,
        deadline_out: bool,
    ) -> bool {
        let timeout_out = timeout_class && timeout_retries >= MAX_TIMEOUT_RETRIES_PER_TURN;
        !fatal && !timeout_out && !deadline_out
    }

    #[test]
    fn p2_retry_gate_lets_transient_failures_retry() {
        assert!(
            retry_gate(false, false, 0, false),
            "generic transient: retry"
        );
        assert!(retry_gate(false, true, 0, false), "first timeout: retry");
        assert!(retry_gate(false, true, 1, false), "second timeout: retry");
    }

    #[test]
    fn p2_retry_gate_stops_deterministic_immediately() {
        assert!(!retry_gate(true, false, 0, false), "fatal never retries");
        assert!(
            !retry_gate(true, true, 2, true),
            "fatal overrides everything"
        );
    }

    #[test]
    fn p2_retry_gate_buckets_timeouts_at_two() {
        // work-mua28gy6: the third identical timeout is guaranteed to fail the
        // same way — the bucket must cut the loop exactly at the cap.
        assert!(
            !retry_gate(false, true, 2, false),
            "third timeout-class: stop"
        );
        assert!(!retry_gate(false, true, 5, false), "way past cap: stop");
        // The bucket is *timeout-only*: a round of generic 5xx retries must not
        // consume the timeout allowance.
        assert!(
            retry_gate(false, false, 5, false),
            "generic retries don't touch the timeout bucket"
        );
    }

    #[test]
    fn p2_retry_gate_deadline_cuts_any_class() {
        assert!(!retry_gate(false, false, 0, true), "deadline out: stop");
        assert!(!retry_gate(false, true, 0, true), "deadline beats bucket");
    }

    /// Source-level guard (mutation pins, this module's include_str! convention):
    /// the loop's retry branch must gate on the timeout bucket AND the deadline
    /// AND reset the bucket after a healthy round. Dropping any one resurrects
    /// the infinite-retry shape under AutoRethink.
    #[test]
    fn p2_retry_branch_gates_on_bucket_and_deadline() {
        let src = include_str!("mod.rs");
        let body = src
            .split("P2: if the stream expired idle/total")
            .nth(1)
            .unwrap_or("");
        let body = body
            .split("// Filter out empty tool calls")
            .next()
            .unwrap_or(body);
        // Whitespace-normalised: rustfmt may wrap the statement across lines;
        // the pin is about the tokens, not the layout.
        let norm: String = body.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(
            norm.contains("let timeout_out = timeout_class && timeout_retries >= MAX_TIMEOUT_RETRIES_PER_TURN;"),
            "timeout bucket must gate the retry (M-pin: bucket removed → infinite timeout retries)"
        );
        assert!(
            norm.contains("let deadline_out = std::time::Instant::now() > retry_deadline;"),
            "run deadline must gate the retry (M-pin: deadline removed → any-class infinite retry)"
        );
        assert!(
            norm.contains("let retries_out = call_retries >= model_retry_budget;"),
            "the user's modelRetries budget must gate the retry (M-pin: budget \
             removed → retries bounded only by the 45min deadline)"
        );
        assert!(
            norm.contains("if !timeout_out && !deadline_out && !retries_out"),
            "all three gates must gate together (M-pin: dropped conjunct). \
             【2026-11 用户决策】fatal（按错误类别快速失败）与 turns < max_turns \
             已按用户要求移除：非 200 一律重试、重试不烧轮次；防无限重试的职责 \
             由 retries_out（modelRetries）+ deadline_out + timeout_out 承担。"
        );
        assert!(
            norm.contains("Timeout-class failures happened"),
            "the honest stop message must explain the timeout bucket"
        );
        assert!(
            norm.contains("This model call has spent {} minutes retrying"),
            "the honest stop message must explain the per-call deadline"
        );
        assert!(
            norm.contains("Model call failed after {} retries"),
            "the honest stop message must explain the modelRetries budget"
        );
    }

    /// Source-level guard for the Cap-3 *scope*, which the gate pin above cannot
    /// see: the deadline must be re-armed per model call (Java constructs
    /// `RetryTask` inside `callWithRetry`, taking `startNanos` on entry) and must
    /// NOT be re-armed by a retry of the same call.
    ///
    /// Both mutations are silent and both passed this file's whole suite before:
    ///
    /// - **Run-wide** (`retry_deadline` computed once before the loop): turns the
    ///   budget into a countdown on the *task*. Production symptom: a healthy
    ///   46-minute run died on its first transient reqwest error with "The run's
    ///   retry budget of 45 minutes is exhausted". Java's javadoc argument for
    ///   why 45min cannot kill a legitimate long answer only holds because the
    ///   budget re-arms per call.
    /// - **Re-armed unconditionally at the top of the loop**: every retry gets a
    ///   fresh 45 minutes, so the deadline can never expire and Cap 3 stops
    ///   bounding anything — resurrecting the work-mua28gy6 infinite-retry shape
    ///   it exists to prevent. This is why the two retry branches must set
    ///   `retry_of_same_call` and nothing else may.
    #[test]
    fn p2_retry_deadline_is_per_call_not_per_run() {
        let src = include_str!("mod.rs");
        let body = src
            .split("async fn run_inner")
            .nth(1)
            .and_then(|s| s.split("mod tests").next())
            .expect("run_inner body must be locatable");
        let norm = body.replace("\r\n", "\n");

        // The re-arm must sit at the very top of the loop body, ahead of the
        // cancel check, and be conditional on the flag. The slice is delimited by
        // `turns += 1;` … `if cancel.is_cancelled()` on purpose: slicing to the
        // *next* `turns += 1` instead spans the whole loop body, which makes
        // every `contains` below vacuously true and the guard worthless.
        let rearm = norm
            .split("turns += 1;")
            .nth(1)
            .unwrap_or("")
            .split("if cancel.is_cancelled()")
            .next()
            .unwrap_or("");
        let p_flag = rearm.find("if !retry_of_same_call {");
        let p_rearm = rearm.find("retry_deadline = retry_deadline_from_now();");
        let p_clear = rearm.find("retry_of_same_call = false;");
        assert!(
            p_flag.is_some() && p_rearm.is_some() && p_clear.is_some(),
            "the loop top must re-arm the deadline under the flag and then clear \
             it (M-pin: run-wide deadline kills healthy long runs on their first \
             transient error; unconditional re-arm makes Cap 3 unreachable)"
        );
        // Order matters: guard → re-arm → clear. A clear placed before the
        // guarded re-arm is the same as re-arming unconditionally.
        assert!(
            p_flag.unwrap() < p_rearm.unwrap() && p_rearm.unwrap() < p_clear.unwrap(),
            "the flag must be read before it is cleared, or the re-arm happens \
             on retries too and the deadline can never expire"
        );

        // Every retry-of-the-same-call branch must claim the flag, or the re-arm
        // above silently becomes unconditional for that branch. The count is
        // deliberately a hard equality rather than a minimum: any newly added
        // retry branch then has to decide explicitly whether it restarts a model
        // call (fresh budget) or retries the current one (keep the budget), and
        // failing this test is what forces that decision.
        //
        // The three are: the empty-output retry, the partial-output retry, and the
        // upstream-corruption retry.
        assert_eq!(
            norm.matches("retry_of_same_call = true;").count(),
            3,
            "exactly the three retry-of-the-same-call branches (empty-output, \
             partial-output, upstream-corruption) may keep the existing deadline; \
             a fourth setter means a path that should start a fresh call does not, \
             and a missing one means the deadline re-arms mid-call"
        );

        // Initial arm + per-turn re-arm, both through the shared helper so the
        // two can never drift to different budgets. Counted as assignment
        // statements: the helper's own `fn` definition also contains the name and
        // sits inside this same slice, so counting bare call sites reads 3.
        assert_eq!(
            norm.matches("retry_deadline = retry_deadline_from_now();")
                .count(),
            2,
            "exactly two arms of the deadline (initial + per-turn re-arm)"
        );

        // 【2026-11 用户决策】重试不烧轮次：turns 只能在「非重试」守卫内递增。
        // 旧实现无条件 turns += 1，同一次调用的重试既虚增前台重试计数，
        // 又吃掉 maxTurns 预算（用户看到「设置 10 却重试 40」的另一半）。
        let p_loop = norm
            .find("loop {")
            .expect("run_inner must have its turn loop");
        let p_turns = norm.find("turns += 1;").expect("turns must still advance");
        let p_guard = norm[..p_turns]
            .rfind("if !retry_of_same_call {")
            .expect("the turns increment must sit under a retry_of_same_call guard");
        assert!(
            p_loop < p_guard && p_guard < p_turns,
            "turns += 1 must be guarded by !retry_of_same_call inside the loop; \
             an unconditional increment burns the turn budget on retries"
        );
        // 重试计数与 deadline 同生命周期：新调用清零，且必须在同一守卫内。
        let p_reset = rearm.find("call_retries = 0;");
        assert!(
            p_reset.is_some() && p_reset.unwrap() > p_rearm.unwrap(),
            "call_retries must reset beside the deadline re-arm (fresh call = \
             fresh retry count); without it the second call inherits the first \
             call's spent budget"
        );
    }

    /// The budget must be the per-call one Java uses, and the shared helper must
    /// be the only thing that turns it into a deadline.
    #[test]
    fn p2_retry_deadline_budget_matches_java_per_call() {
        assert_eq!(
            MODEL_CALL_RETRY_DEADLINE_SECS,
            45 * 60,
            "Java REASON_RETRY_TOTAL_DEADLINE = Duration.ofMinutes(45)"
        );
        let src = include_str!("mod.rs");
        let helper = src
            .split("fn retry_deadline_from_now()")
            .nth(1)
            .and_then(|s| s.split('}').next())
            .expect("the deadline helper must exist");
        assert!(
            helper.contains("MODEL_CALL_RETRY_DEADLINE_SECS"),
            "the helper must derive from the single budget constant, not restate \
             a number that can drift from it"
        );
    }

    #[test]
    fn p2_timeout_bucket_resets_after_a_healthy_round() {
        let src = include_str!("mod.rs");
        let body = src
            .split("A round that reached the model")
            .nth(1)
            .unwrap_or("");
        let body = body
            .split("// Filter out empty tool calls")
            .next()
            .unwrap_or(body);
        assert!(
            body.contains("timeout_retries = 0;"),
            "bucket must reset after a completed round, or one outage scars the whole run"
        );
    }

    /// P3: the background gate must intercept the text-answer END after the
    /// converge gate and before trace/done, push the reply into history, and
    /// keep going — falling through would emit `done` with the unverified
    /// "I'll be notified" promise as the final answer, which is precisely the
    /// failure this gate exists to prevent.
    #[test]
    fn p3_background_gate_defers_the_text_end_instead_of_completing() {
        let src = include_str!("mod.rs");
        let body = src.split("P3: background-task gate").nth(1).unwrap_or("");
        let body = body
            .split("let elapsed = started_at.elapsed()")
            .next()
            .unwrap_or(body);
        let norm = body.replace("\r\n", "\n");
        assert!(
            norm.contains("bg_gate::running_count(&config.session_id).await"),
            "gate must consult the notice center for running tasks (M-pin: gate removed → false promises END the run)"
        );
        assert!(
            norm.contains("running > 0 && bg_deferred < bg_gate::MAX_BG_GATE_DEFERRALS"),
            "gate must arm only when tasks run AND deferrals remain (M-pin: cap dropped → model can never stop)"
        );
        assert!(
            norm.contains("messages.push(ChatMessage::assistant(answer.clone()));"),
            "the deferred reply must enter history before the check prompt"
        );
        assert!(
            norm.contains("bg_gate::background_gate_prompt("),
            "the check prompt must be injected"
        );
        assert!(
            norm.trim_end().ends_with("continue;")
                || norm.contains("));\n                    continue;"),
            "the gate must `continue` the loop, never fall through to done (M8-class pin)"
        );
    }

    /// P3: notices must be drained at the top of every reasoning turn, as user
    /// messages, arming the converge gate (a notice can change what "done" means).
    #[test]
    fn p3_notices_drain_at_the_top_of_each_turn() {
        let src = include_str!("mod.rs");
        let body = src
            .split("P3: background completion notices")
            .nth(1)
            .unwrap_or("");
        let body = body.split("// Emit reason_start").next().unwrap_or(body);
        let norm = body.replace("\r\n", "\n");
        assert!(
            norm.contains("bg_gate::drain(&config.session_id).await"),
            "notices must be drained every turn (M-pin: drain removed → the model must poll again)"
        );
        assert!(
            norm.contains("messages.push(ChatMessage::user(n));"),
            "notices must enter the message list as user messages"
        );
        assert!(
            norm.contains("converge_pending = true;"),
            "a notice must arm the converge gate for the next text-only reply"
        );
    }

    #[test]
    fn p2_stream_caps_are_wired_into_the_receive_select() {
        let src = include_str!("mod.rs");
        let body = src
            .split("P2: measure idle against the last")
            .nth(1)
            .unwrap_or("");
        let body = body
            .split("StreamEvent::ContentDelta")
            .next()
            .unwrap_or(body);
        let norm = body.replace("\r\n", "\n");
        assert!(
            norm.contains("last_chunk_at.elapsed() > stream_idle_cap"),
            "idle cap must be checked (M-pin: removed → a dead stream hangs the turn forever)"
        );
        assert!(
            norm.contains("stream_started_at.elapsed() > stream_total_cap"),
            "total cap must be checked"
        );
        assert!(
            norm.contains("idle_expired = true;"),
            "idle expiry must set the flag that synthesises the timeout error"
        );
    }

    /// The idle clock must reset on EVERY received event, not just visible text.
    /// Reasoning/thinking deltas and tool-argument deltas are the only frames a
    /// long-thinking model emits for minutes; when the reset lived solely in the
    /// `ContentDelta` arm, an active reasoning stream hit the 150s idle cap as
    /// "no data received" (the reported incident) and was retried 24/30 times.
    /// Java's `req.stream().timeout(idleCap)` resets on any onNext — this pins
    /// the Rust equivalent to the `rx.recv()` arm, which sees all event types.
    #[test]
    fn idle_clock_resets_on_any_received_event_not_only_content() {
        let src = include_str!("mod.rs");
        // The reset must be in the receive arm, before the per-variant match.
        let recv = src
            .split("ev = rx.recv() => match ev {")
            .nth(1)
            .unwrap_or("");
        let recv = recv.split("None => break,").next().unwrap_or(recv);
        assert!(
            recv.contains("last_chunk_at = std::time::Instant::now();"),
            "receiving ANY event must reset the idle clock (M-pin: removed → long thinking times out)"
        );
        // ...and must NOT be duplicated back into a single variant arm: a reset
        // only on ContentDelta would leave reasoning/tool-args streams unwatched.
        let cd = src
            .split("StreamEvent::ContentDelta(delta) => {")
            .nth(1)
            .unwrap_or("");
        let cd = cd.split("StreamEvent::ReasoningDelta").next().unwrap_or(cd);
        assert!(
            !cd.contains("last_chunk_at"),
            "ContentDelta must not own the idle reset alone; it belongs to the recv arm"
        );
    }

    // ─── source-level wiring guards (mutation-tested) ──────────────────────

    /// The P1 empty-response branch must `continue` after injecting the
    /// correction prompt — falling through would emit `done` with an empty
    /// final answer: the silent EMPTY-END defect exactly as it was before
    /// this change (mutation M8 pin).
    #[test]
    fn p1_empty_rounds_continue_rather_than_end() {
        let src = include_str!("mod.rs");
        let body = src.split("P1: empty-output handling").nth(1).unwrap_or("");
        let body = body.split("empty_rounds = 0;").next().unwrap_or(body);
        assert!(
            body.replace("\r\n", "\n").contains("empty_response_prompt(\n                            turns,\n                            empty_rounds,\n                        )));\n                        continue;"),
            "the injected empty-response prompt must be followed by `continue` (mutation M8 pin)"
        );
        assert!(
            body.replace("\r\n", "\n")
                .contains("stop_reason: StopReason::Error"),
            "past MAX_EMPTY_ROUNDS the run must stop with Error, never Completed"
        );
    }

    // ─── loop chain: DSH consecutive semantics + progress awareness ────────

    /// Three identical calls with identical results fire the first reminder.
    #[test]
    fn chain_fires_at_three_identical_rounds() {
        let fp = loop_fingerprint(&[tc("read", r#"{"path":"a.rs"}"#)], "").unwrap();
        let mut chain = None;
        assert_eq!(loop_chain_step(&mut chain, &fp, vec![42], false), 0);
        assert_eq!(loop_chain_step(&mut chain, &fp, vec![42], false), 0);
        assert_eq!(
            loop_chain_step(&mut chain, &fp, vec![42], false),
            3,
            "third identical round fires"
        );
    }

    /// Escalation 3/5/8, each threshold fires once, then silence — never a stop.
    #[test]
    fn chain_escalates_3_5_8_then_goes_silent() {
        let fp = loop_fingerprint(&[tc("bash", r#"{"command":"x"}"#)], "").unwrap();
        let mut chain = None;
        let mut fired = vec![];
        for i in 1..=20u32 {
            let r = loop_chain_step(&mut chain, &fp, vec![7], false);
            if r > 0 {
                fired.push((i, r));
            }
        }
        assert_eq!(
            fired,
            vec![(3, 3), (5, 5), (8, 8)],
            "DSH thresholds, once each, then silent"
        );
    }

    /// A different call resets the chain (DSH: any different tracked call).
    #[test]
    fn chain_resets_on_different_call() {
        let fa = loop_fingerprint(&[tc("read", r#"{"path":"a.rs"}"#)], "").unwrap();
        let fb = loop_fingerprint(&[tc("read", r#"{"path":"b.rs"}"#)], "").unwrap();
        let mut chain = None;
        loop_chain_step(&mut chain, &fa, vec![1], false);
        loop_chain_step(&mut chain, &fa, vec![1], false);
        loop_chain_step(&mut chain, &fb, vec![2], false); // reset
        assert_eq!(
            loop_chain_step(&mut chain, &fa, vec![1], false),
            0,
            "chain restarted at 1"
        );
        assert_eq!(loop_chain_step(&mut chain, &fa, vec![1], false), 0);
        assert_eq!(loop_chain_step(&mut chain, &fa, vec![1], false), 3);
    }

    /// Progress awareness A: same call, *different result* = new information.
    /// The chain restarts instead of escalating — polling a build log that
    /// keeps changing is legitimate, not spinning.
    #[test]
    fn same_call_new_result_restarts_chain() {
        let fp = loop_fingerprint(&[tc("bash", r#"{"command":"poll"}"#)], "").unwrap();
        let mut chain = None;
        let mut fired = 0;
        for i in 0..12u64 {
            if loop_chain_step(&mut chain, &fp, vec![i], false) > 0 {
                fired += 1;
            }
        }
        assert_eq!(fired, 0, "12 polls with changing output must never remind");
    }

    /// Progress awareness B: a successful write/edit between identical probes
    /// legitimises the re-run (edit → restart → poll). work-mwod1kcs shape.
    #[test]
    fn mutation_between_identical_calls_restarts_chain() {
        let fp = loop_fingerprint(&[tc("bash", r#"{"command":"check"}"#)], "").unwrap();
        let mut chain = None;
        let mut fired = 0;
        for _ in 0..12 {
            if loop_chain_step(&mut chain, &fp, vec![9], true) > 0 {
                fired += 1;
            }
        }
        assert_eq!(fired, 0, "edit-between-probes cycles must never remind");
    }

    /// The work-mwod1kcs false kill, replayed: 12 Select-String commands that
    /// share a >120-char path prefix but differ in the pattern. The old
    /// 120-char truncation collapsed them into one fingerprint (3 reminders →
    /// hard stop at turn 448). Full-value hashing must keep them distinct.
    #[test]
    fn long_shared_prefix_commands_must_not_collide() {
        let prefix = "$f='C:\\Apps\\HBuilderX\\plugins\\uniapp-cli-vite\\node_modules\\@dcloudio\\uni-cli-shared\\lib\\dom2\\web\\@vue\\compiler-sfc\\dist\\compiler-sfc.cjs.js'; ";
        assert!(
            prefix.chars().count() > 120,
            "premise: prefix exceeds the old truncation budget"
        );
        let patterns = [
            "function fileToScope",
            "function resolveFS",
            "new ScriptCompileContext",
            "fileToScopeCache",
            "Unresolvable type reference",
            "function resolveTypeReference",
            "function recordTypes",
            "function recordType\\b",
            "extraOptions",
            "class ScriptCompileContext",
            "ScriptCompileContext = class",
            "invalidateTypeCache",
        ];
        let mut chain = None;
        let mut fired = 0;
        for (i, p) in patterns.iter().enumerate() {
            let args = serde_json::json!({ "command": format!("{prefix}Select-String -Path $f -Pattern '{p}'"), "timeout": 30000 });
            let fp = loop_fingerprint(&[tc("bash", &args.to_string())], "").unwrap();
            if loop_chain_step(&mut chain, &fp, vec![i as u64], false) > 0 {
                fired += 1;
            }
        }
        assert_eq!(
            fired, 0,
            "12 distinct investigation commands must not remind (work-mwod1kcs regression)"
        );
    }

    /// Key order inside *nested* objects must also canonicalise (the old form
    /// serialised nested values verbatim, so reordered nested keys looked
    /// different and the detector was blind to genuine repeats).
    #[test]
    fn fingerprint_canonicalises_nested_key_order() {
        let a = loop_fingerprint(&[tc("x", r#"{"opt":{"b":2,"a":1}}"#)], "");
        let b = loop_fingerprint(&[tc("x", r#"{"opt":{"a":1,"b":2}}"#)], "");
        assert_eq!(a, b);
    }

    /// Delimiter injection: the old raw-join form (`k=v|k2=v2`) let value
    /// content impersonate structure — `{"a":"x|b=y"}` and `{"a":"x","b":"y"}`
    /// canonicalised to the SAME string, so a genuinely different call could
    /// be misread as a repeat. JSON emission escapes `"`/`\` inside strings,
    /// making distinct argument trees always fingerprint distinctly.
    #[test]
    fn fingerprint_delimiters_in_values_cannot_impersonate_structure() {
        let a = loop_fingerprint(&[tc("x", r#"{"a":"x|b=y"}"#)], "");
        let b = loop_fingerprint(&[tc("x", r#"{"a":"x","b":"y"}"#)], "");
        assert_ne!(
            a, b,
            "a value containing '|k=v' must not collide with real extra keys"
        );
        // Same idea with '=' and nested objects, plus the escaped-quote shape.
        let c = loop_fingerprint(&[tc("x", r#"{"a":"1","b":"2"}"#)], "");
        let d = loop_fingerprint(&[tc("x", r#"{"a":"1\",\"b\":\"2"}"#)], "");
        assert_ne!(c, d, "escaped quotes in a value must not forge keys");
        // And sanity: the injection pair really is semantically different —
        // canonical strings must differ at the canonical_args level too.
        assert_ne!(
            canonical_args(r#"{"a":"x|b=y"}"#),
            canonical_args(r#"{"a":"x","b":"y"}"#)
        );
    }

    /// The workspace builds serde_json with `preserve_order` (IndexMap). The
    /// canonicaliser must sort by explicit insertion, not rely on Map's
    /// default ordering — this pins that the emitted canonical string is
    /// key-sorted regardless of input order, at every depth.
    #[test]
    fn canonical_args_emits_sorted_keys_despite_preserve_order() {
        let a = canonical_args(r#"{"z":1,"opt":{"b":2,"a":1},"m":[3,{"y":4,"x":5}]}"#).unwrap();
        let b = canonical_args(r#"{"m":[3,{"x":5,"y":4}],"opt":{"a":1,"b":2},"z":1}"#).unwrap();
        assert_eq!(a, b);
        // Sorted emission: "m" before "opt" before "z"; nested "a" before "b".
        assert!(a.find("\"m\"").unwrap() < a.find("\"opt\"").unwrap());
        assert!(a.find("\"opt\"").unwrap() < a.find("\"z\"").unwrap());
        assert!(a.find("\"a\"").unwrap() < a.find("\"b\"").unwrap());
    }

    /// Mutation list hygiene: only tools actually registered in this kernel
    /// belong in STATE_MUTATING_TOOLS. Claude Code names (multiedit /
    /// notebookedit) are dead config and must not creep back in — a stale
    /// entry silently claims "progress" for a tool that can never run.
    #[test]
    fn state_mutating_tools_are_registered_tools() {
        assert_eq!(STATE_MUTATING_TOOLS, ["write", "edit"]);
        let reg = crate::tools::registry::ToolRegistry::default_registry();
        for name in STATE_MUTATING_TOOLS {
            assert!(
                reg.get(name).is_some(),
                "{name} must be a registered tool (no dead mutation entries)"
            );
        }
    }

    // ─── todo-staleness reminder (Qoder `todo_reminder` port) ────────────────

    /// The dual gate is the anti-spam core: a reminder needs BOTH enough turns
    /// since the last write AND enough turns since the last reminder. Either one
    /// alone must not fire — a stale list re-announced every turn is the defect
    /// the second threshold exists to prevent.
    #[test]
    fn todo_reminder_requires_both_turn_gates() {
        let w = TODO_REMINDER_TURNS_SINCE_WRITE;
        let b = TODO_REMINDER_TURNS_BETWEEN;
        assert!(todo_reminder_due(w, b, 0), "both gates met → due");
        assert!(
            !todo_reminder_due(w - 1, b, 0),
            "one turn short of write gate → not due"
        );
        assert!(
            !todo_reminder_due(w, b - 1, 0),
            "one turn short of reminder gate → not due"
        );
        assert!(!todo_reminder_due(0, 0, 0), "fresh write → not due");
        // Just after a reminder the reminder-gate resets even if still stale.
        assert!(
            !todo_reminder_due(w, 0, 1),
            "reminder just fired → cooldown"
        );
    }

    /// The per-run cap holds even when both turn gates stay met forever.
    #[test]
    fn todo_reminder_respects_per_run_cap() {
        let w = TODO_REMINDER_TURNS_SINCE_WRITE;
        let b = TODO_REMINDER_TURNS_BETWEEN;
        assert!(
            todo_reminder_due(w, b, MAX_TODO_REMINDERS - 1),
            "last allowed reminder"
        );
        assert!(
            !todo_reminder_due(w, b, MAX_TODO_REMINDERS),
            "cap reached → silent"
        );
        assert!(
            !todo_reminder_due(w, b, MAX_TODO_REMINDERS + 5),
            "past cap → silent"
        );
    }

    /// Source-level wiring guard (mutation-tested): the loop must forgive the
    /// budget on a self-initiated `todowrite`, gate the file read behind
    /// `has_unfinished_items`, and inject `stale_reminder` — not a bare nudge.
    #[test]
    fn todo_reminder_is_wired_with_forgiveness_and_checklist_gate() {
        let src = include_str!("mod.rs");
        let block = src
            .split("Count this reasoning turn, then forgive the budget")
            .nth(1)
            .unwrap_or("");
        let block = block
            .split("// Add the assistant message with tool_calls to history")
            .next()
            .unwrap_or(block);
        // Whitespace-normalised (rustfmt may wrap long calls across lines).
        let norm: String = block.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(
            norm.contains("tc.function.name == \"todowrite\"")
                && norm.contains("todo_reminders = 0;"),
            "a self-initiated todowrite must reset the staleness counter and forgive the budget"
        );
        assert!(
            norm.contains("todo_reminder_due(turns_since_todowrite, turns_since_todo_reminder, todo_reminders")
                || norm.contains("todo_reminder_due( turns_since_todowrite, turns_since_todo_reminder, todo_reminders"),
            "the dual gate must guard the injection"
        );
        assert!(
            norm.contains("crate::todo::has_unfinished_items(&raw)"),
            "an empty / fully-done checklist must not trigger a reminder"
        );
        assert!(
            norm.contains("crate::todo::stale_reminder(&raw)"),
            "the injected message must carry the current list, not a bare nudge"
        );
    }

    // ─── P1: empty response prompt ─────────────────────────────────────────

    #[test]
    fn empty_response_prompt_offers_both_exits_and_counts() {
        let p = empty_response_prompt(12, 2);
        assert!(p.contains("空响应"));
        assert!(p.contains("2/3"), "must show the retry counter");
        assert!(
            p.contains("回溯任务目标"),
            "reflection body (Java :712-719)"
        );
        assert!(
            p.contains("工具调用"),
            "must ask for an action OR an answer"
        );
    }

    // ─── queued interjection rendering ──────────────────────────────────────

    #[test]
    fn queued_message_keeps_attachment_references() {
        // The Java `Form<SteerForm>` port silently dropped every attachment
        // because a repeated key collapsed; a steer saying "see the screenshot"
        // with no screenshot leaves the model guessing.
        let item = crate::queue::QueuedMessage {
            content: "look at this".into(),
            image_paths: vec!["C:/a.png".into()],
            file_paths: vec!["C:/b.log".into()],
            timestamp: 0,
            origin_steer_id: Some("s1".into()),
        };
        let text = queued_message_text(&item);
        assert!(text.contains("look at this"));
        assert!(text.contains("C:/a.png"), "image path must survive");
        assert!(text.contains("C:/b.log"), "file path must survive");
    }

    #[test]
    fn queued_message_without_attachments_is_verbatim() {
        let item = crate::queue::QueuedMessage {
            content: "plain steer".into(),
            ..Default::default()
        };
        assert_eq!(queued_message_text(&item), "plain steer");
    }

    // ─── steer wire envelope (applied / cancelled / dropped share it) ───────

    fn steer_item(id: &str, text: &str) -> crate::queue::QueuedMessage {
        crate::queue::QueuedMessage {
            content: text.into(),
            image_paths: vec!["uploads/a.png".into()],
            file_paths: vec!["uploads/b.pdf".into()],
            timestamp: 1_730_000_000_000,
            origin_steer_id: Some(id.into()),
        }
    }

    #[test]
    fn steer_envelope_matches_the_java_field_names() {
        // The frontend reads exactly these keys (`item.steerId`, `item.text`,
        // `item.imagePaths`) for all three steer events; a rename here makes an
        // interjection invisible again — the original bug — with everything still
        // "passing" on the Rust side.
        let env = steer_envelope(&steer_item("s-1", "看这张图"), "run-9").unwrap();
        assert_eq!(env["steerId"], "s-1");
        assert_eq!(env["text"], "看这张图");
        assert_eq!(env["runId"], "run-9");
        assert_eq!(env["createdAt"], 1_730_000_000_000i64);
        assert_eq!(env["imagePaths"][0], "uploads/a.png");
        assert_eq!(env["filePaths"][0], "uploads/b.pdf");

        // Raw text, never the LLM-facing attachment suffix: the frontend upgrades
        // the paths into tiles itself and would otherwise show a tile *and* a path.
        let raw = env["text"].as_str().unwrap();
        assert!(!raw.contains('['), "frame text must be raw, got {raw}");
        assert!(
            !raw.contains("uploads/"),
            "paths belong in their own fields"
        );
    }

    #[test]
    fn steer_envelope_requires_a_usable_id() {
        // A row without an id is dropped by the frontend's own guard, so emitting
        // one is a silent no-op; `None` keeps that visible as an invariant breach.
        for bad in ["", "   "] {
            let item = crate::queue::QueuedMessage {
                content: "x".into(),
                origin_steer_id: Some(bad.into()),
                ..Default::default()
            };
            assert!(steer_envelope(&item, "r").is_none(), "blank id: {bad:?}");
        }
        let no_id = crate::queue::QueuedMessage {
            content: "x".into(),
            ..Default::default()
        };
        assert!(steer_envelope(&no_id, "r").is_none());
    }

    /// The two exits Java draws between: Stop throws interjections away, a run that
    /// ended normally hands them back. Getting this wrong either destroys user input
    /// or replays a message the user already watched being cancelled.
    #[test]
    fn settle_steers_deletes_only_on_the_cancelled_exit() {
        let dir = std::env::temp_dir().join(format!("gwork-settle-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let qm = crate::queue::QueueManager::new();
        qm.add(&dir, "stop me".into(), vec![], vec![], Some("s-1".into()));
        qm.add(&dir, "typed earlier".into(), vec![], vec![], None);

        // requeue = false (Stop): interjection is gone from the file for good…
        let gone = settle_steers(&qm, &dir, "run-1", false);
        assert_eq!(gone.len(), 1);
        assert_eq!(gone[0]["steerId"], "s-1");
        let rest = qm.list(&dir);
        assert_eq!(
            rest.len(),
            1,
            "a cancelled steer must not survive in the queue"
        );
        assert_eq!(rest[0].content, "typed earlier");

        // …and the plain item is untouched either way: it is the frontend's to send.
        std::fs::remove_dir_all(&dir).ok();

        let dir = std::env::temp_dir().join(format!("gwork-settle2-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let qm = crate::queue::QueueManager::new();
        qm.add(
            &dir,
            "late steer".into(),
            vec!["u/i.png".into()],
            vec![],
            Some("s-2".into()),
        );
        qm.add(&dir, "plain".into(), vec![], vec![], None);

        // requeue = true (normal end): the frame must not arrive before the item is
        // back on disk, because the frontend refreshes its badge from this frame.
        let back = settle_steers(&qm, &dir, "run-2", true);
        assert_eq!(back.len(), 1);
        let after = qm.list(&dir);
        assert_eq!(
            after.len(),
            2,
            "the dropped steer must be durably re-queued"
        );
        let requeued = after
            .iter()
            .find(|m| m.origin_steer_id.as_deref() == Some("s-2"))
            .unwrap();
        assert_eq!(
            requeued.content, "late steer",
            "content must survive the hand-back"
        );
        assert_eq!(
            requeued.image_paths,
            vec!["u/i.png".to_string()],
            "attachments too"
        );

        // A normal exit must not consume the queue: the item stays put for the
        // frontend's post-`done` dispatch, and the frame is a notification only.
        assert_eq!(settle_steers(&qm, &dir, "run-2", true).len(), 1);
        assert_eq!(
            qm.list(&dir).len(),
            2,
            "a dropped steer must stay durable; take-then-re-add leaves the file \
             unchanged and would make a repeated settle re-announce the same item"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Regression lock for the actual reported defect: the drain may never take a
    /// plain queued message. An unconditional `shift()` in the loop fed the model
    /// while the UI kept waiting, so the message was acted on and invisible at once.
    #[test]
    fn run_drain_uses_the_selective_pop_only() {
        let src = include_str!("mod.rs");
        // The loop only, up to the first helper: widening past it would let a
        // `shift()` living in some unrelated function pass for a violation, and
        // would let the helpers' own calls blur the assertion being made.
        let body = src
            .split_once("async fn run_inner")
            .expect("run_inner present")
            .1
            .split_once("/// One interjection as it appears on the wire")
            .expect("helpers follow the loop")
            .0;
        assert!(
            !body.contains("queue_mgr.shift("),
            "the step-boundary drain must not use the unguarded `shift()` — it would \
             swallow the frontend's plain queued messages"
        );
        assert!(
            body.contains("queue_mgr.shift_steer("),
            "the drain must go through `shift_steer`"
        );
        // Every steer exit settles before its `done`, mirroring WebGate's ordering.
        // 不用固定行窗：complete_task 直通路径在 settle 与 done 之间隔着多行
        // trace 帧（契约 §4.2），行窗会随帧参数增减而误判。改用语义守护——
        // 自上一个 done 以来必须出现过 steer_exit，即每个 done 都被一次结算
        // 「兜底」，与「done 前必先结算」等价且对块大小稳健。
        let mut done_seen = 0usize;
        let mut settled_since_last_done = false;
        for (i, line) in body.lines().enumerate() {
            if line.contains("steer_exit!(") {
                settled_since_last_done = true;
            }
            if line.contains("emit!(Frame::done(") {
                done_seen += 1;
                assert!(
                    settled_since_last_done,
                    "`done` at react line ~{i} has no steer settlement before it"
                );
                settled_since_last_done = false;
            }
        }
        assert_eq!(
            done_seen, 6,
            "3 boundary cancel paths + the in-flight-tool cancel + completion + complete_task direct-through emit `done`"
        );
    }

    // ─── turn-budget arithmetic ─────────────────────────────────────────────

    #[test]
    fn rethink_threshold_and_extension_match_java() {
        // Java: thresholdTurn = max(maxTurns - 1, (int)(maxTurns * 0.8))
        //       addTurns      = max(10, initialMaxTurns / 2)
        for initial in [20u32, 8, 15, 30, 3] {
            let max_turns = initial;
            let threshold = (max_turns - 1).max((max_turns as f64 * 0.8) as u32);
            let add = 10u32.max(initial / 2);
            // The threshold must never exceed the ceiling, or the extension would
            // fire after the hard stop had already happened.
            assert!(
                threshold <= max_turns,
                "initial={initial} threshold={threshold}"
            );
            // And it must leave at least one turn of headroom to act on the
            // self-review, which is the whole point of intervening early.
            assert!(threshold < max_turns || max_turns == 1, "initial={initial}");
            assert!(add >= 10, "initial={initial} add={add}");
            assert!(max_turns + add > max_turns);
        }
        // Concrete Java values for the default ceiling of 20.
        let threshold = (20u32 - 1).max((20f64 * 0.8) as u32);
        assert_eq!(threshold, 19);
        assert_eq!(10u32.max(20 / 2), 10);
    }

    // ─── Stop responsiveness (the "two clicks to stop" regression lock) ───────
    //
    // These are source-level guards, following this module's existing `include_str!`
    // convention (see `run_drain_uses_the_selective_pop_only`). A timing assertion
    // here would be flaky on CI, and the real latency is verified end-to-end against
    // a live kernel; what must not regress is the *shape* — an in-flight tool racing
    // the cancellation token. Reverting to a bare `.await` reproduces the user-visible
    // defect silently: every unit test stays green while Stop takes as long as the
    // tool's own timeout.

    /// The tool call must be raced against `cancel`, never awaited plainly.
    #[test]
    fn an_inflight_tool_call_races_the_cancellation_token() {
        let src = include_str!("mod.rs");
        let body = loop_body(src);

        assert!(
            !body.contains("self.registry.execute(&tc.function.name, args, &tool_ctx).await"),
            "a plainly awaited tool call is the original defect: the run cannot leave \
             until the tool returns on its own, so the `done` frame arrives seconds (or \
             minutes) after a successful Stop"
        );
        assert!(
            body.contains(
                "output = self.registry.execute(&tc.function.name, args, &tool_ctx) => output"
            ),
            "the tool call must be one arm of the select that races cancellation"
        );
        // Deterministic winner when both arms are ready.
        assert!(
            body.contains("biased;"),
            "cancel must win the race deterministically"
        );
    }

    /// A cancelled tool must still close its own card.
    ///
    /// The frontend can sweep a leftover loading icon, but that yields an unexplained
    /// warning; the emitted frame is what tells the user *why* the row stopped.
    #[test]
    fn cancelling_a_tool_still_emits_action_end_and_done() {
        let src = include_str!("mod.rs");
        let body = loop_body(src);
        let arm = body
            .split_once("_ = cancel.cancelled() => {")
            .expect("cancel arm present")
            .1
            // First arm only: the other cancel sites are the turn-boundary checks.
            .split_once("output = self.registry.execute")
            .expect("tool arm follows the cancel arm")
            .0;

        // Self-check on the slicing itself: `loop_body` starts at the tool loop, so
        // this arm must not be the LLM-stream one (which logs that distinctive line).
        // Without it, a wrong anchor would silently assert against some other cancel
        // path that already emits these frames, and the guard would pass vacuously.
        assert!(
            !arm.contains("cancelled during LLM stream"),
            "sliced the wrong cancel arm — the guard would prove nothing"
        );

        // Assert the *emit*, not merely the frame's construction: a mutant that
        // builds the frame and discards it (`let _ = Frame::action_end_failed(..)`)
        // still contains the type name, so asserting the type alone was proven
        // toothless by mutation check M3.
        assert!(
            arm.contains("emit!(Frame::action_end_failed("),
            "without an emitted `action_end` the stopped tool is reported by the sweep \
             as an unexplained warning instead of a user cancellation"
        );
        assert!(
            arm.contains("steer_exit!(Frame::steer_cancelled, false)"),
            "pending interjections must be announced before `done`, as on every other \
             cancel exit"
        );
        assert!(
            arm.contains("emit!(Frame::done(&config.session_id))"),
            "the frontend leaves its streaming state only on `done`; without it the \
             timer runs on and the user clicks Stop a second time"
        );
    }

    /// A foreground delegation must run on its own task, so abandoning the tool
    /// future cannot abandon the sub-agent's teardown.
    #[test]
    fn a_foreground_sub_agent_outlives_the_future_it_was_called_from() {
        let src = include_str!("../tools/agent.rs");
        let fg = src
            .split_once("// Foreground: block until done.")
            .expect("foreground branch present")
            .1
            .split_once("let status = if result.success")
            .expect("branch ends at the status line")
            .0;

        // Semantic, format-insensitive discriminator. What matters is *where* the
        // delegation is awaited: inside the spawned task (so abandoning the parent
        // future leaves the sub-agent running, and it still emits `agent_end` to stop
        // its card's spinner — `app-message.js:2673` swaps `.loading` on that frame and
        // nowhere else) or inline in the parent future (so the abort reaches the
        // sub-agent mid-run and its card spins forever).
        //
        // A text search for `.execute_task(\n` would only catch one particular line
        // wrapping, and a whitespace-free `!contains("ORCHESTRATOR")` fails outright
        // because the new code legitimately clones the global. Position relative to
        // the spawn is the property that actually decides the behaviour.
        let spawn_at = fg.find("tokio::spawn(async move {");
        let exec_at = fg.find(".execute_task(");
        assert!(
            spawn_at.is_some() && exec_at.is_some() && exec_at > spawn_at,
            "the delegation must be awaited INSIDE the spawned task, i.e. `.execute_task(` \
             must follow `tokio::spawn`; found spawn at {spawn_at:?}, execute_task at {exec_at:?}"
        );
        assert!(
            fg.contains("r = handle =>"),
            "the spawned handle must be one arm of the cancellation race"
        );
        assert!(
            fg.contains("_ = ctx.cancel.cancelled()"),
            "the tool itself must return promptly on Stop"
        );
    }

    /// The wire that makes a sub-agent run on the conversation's model.
    ///
    /// `tools/agent.rs` can only inherit what this loop puts on the context, so
    /// this is the one place the value is chosen. Mutation testing proved the gap:
    /// swapping `config.model` for `settings.default_model_config()` here left
    /// every test in `tools::` green while reintroducing the reported defect in
    /// full — sub-agents silently running on the global default rather than the
    /// model the user picked.
    ///
    /// Asserted at the source level because the alternative is standing up a live
    /// provider: the field is consumed by a spawned sub-agent run, not returned.
    #[test]
    fn the_tool_context_inherits_this_runs_model_and_settings() {
        let src = include_str!("mod.rs");
        // Cut the test module off first. Without this the negative assertion
        // below matches *its own needle* in this very function and the test fails
        // against correct code (observed while writing it).
        let production = &src[..src.find("#[cfg(test)]").unwrap_or(src.len())];
        let setup = production
            .split_once("async fn run_inner")
            .expect("run_inner present")
            .1;

        // The run's own model, not one re-derived from settings. Both halves
        // matter: the first pins what is read, the second rules out the exact
        // substitution the mutant made.
        assert!(
            setup.contains("let run_model = Arc::new(config.model.clone());"),
            "the delegation model must be THIS run's model (`config.model`)"
        );
        assert!(
            setup.contains("let run_settings = Arc::new(config.settings.clone());"),
            "delegated settings must be the run's live copy (`config.settings`)"
        );
        assert!(
            !setup.contains("let run_model = Arc::new(config.settings.default_model_config()"),
            "resolving the run model from `defaultModel` is the bug being guarded"
        );

        // And they must actually reach the context the tools read.
        let ctx_literal = setup
            .split_once("let tool_ctx = ToolContext {")
            .expect("tool context literal present")
            .1
            .split_once("};")
            .expect("literal terminates")
            .0;
        for field in ["model: run_model.clone()", "settings: run_settings.clone()"] {
            assert!(
                ctx_literal.contains(field),
                "`{field}` missing from ToolContext: task/multitask would fall back \
                 to the global default and the sub-agent would answer on the wrong model"
            );
        }
    }

    /// Just the `for (tc_index, tc) in tool_calls` loop, so an unrelated `.await`
    /// elsewhere in the file cannot satisfy or defeat the guards above.
    fn loop_body(src: &str) -> String {
        src.split_once("// Execute each tool call")
            .expect("tool loop present")
            .1
            .split_once("/// Marker written for a tool call that never produced a result")
            .expect("helpers follow the loop")
            .0
            .to_string()
    }

    // ─── ArgsProgress throttle ─────────────────────────────────────────────
    //
    // These drive the clock explicitly rather than sleeping: Windows timer
    // granularity makes wall-clock timing assertions flaky, and a pure
    // `should_emit(now)` keeps the whole throttle table-testable.

    // ─── live TPS meter throttle ────────────────────────────────────────────
    //
    // Drive the clock explicitly with `Instant` arithmetic: no sleeping, no
    // wall-clock flakiness, pure state transitions. Both the throttle and the
    // denominator use the same monotonic clock, so an NTP step can neither
    // freeze emissions nor fabricate a phantom speed.

    /// Explicit-clock helper: `t0 + ms`. Named distinctly from the local `at`
    /// closure used by the TTFT table test above.
    fn tps_at(t0: std::time::Instant, ms: u64) -> std::time::Instant {
        t0 + std::time::Duration::from_millis(ms)
    }

    #[test]
    fn tps_meter_does_not_emit_before_a_real_delta() {
        let t0 = std::time::Instant::now();
        let m = TpsMeter::new(t0);
        assert!(!m.should_emit(tps_at(t0, 0)), "no output yet");
        assert!(
            !m.should_emit(tps_at(t0, 20_000)),
            "a long wait with no output is still no frame"
        );
    }

    #[test]
    fn tps_meter_emits_once_per_interval_and_measures_the_same_window() {
        let t0 = std::time::Instant::now();
        let mut m = TpsMeter::new(t0);
        for _ in 0..50 {
            m.on_delta();
        }
        assert!(
            !m.should_emit(tps_at(t0, 499)),
            "one ms short of the interval"
        );
        assert!(
            m.should_emit(tps_at(t0, 500)),
            "exactly one interval with real output"
        );
        let (tokens, ms) = m.take_window(tps_at(t0, 500));
        assert_eq!(tokens, 50, "every observed delta is counted, no estimation");
        assert_eq!(ms, 500, "denominator is the real elapsed monotonic time");
        assert!(
            !m.should_emit(tps_at(t0, 999)),
            "window restarts after an emit"
        );
        m.on_delta();
        assert!(m.should_emit(tps_at(t0, 1_000)));
    }

    #[test]
    fn tps_meter_note_delta_reanchors_the_first_delta_only() {
        let t0 = std::time::Instant::now();
        let mut m = TpsMeter::new(t0); // stream starts here
                                       // 6 s of prompt processing / TTFT wait, then two visible deltas.
        assert!(m.note_delta(tps_at(t0, 6_000)), "first delta is reported");
        assert!(
            !m.note_delta(tps_at(t0, 6_010)),
            "only the first is reported"
        );
        // The 6 s wait must not enter the denominator.
        let (_, ms) = m.take_window(tps_at(t0, 6_500));
        assert_eq!(
            ms, 500,
            "only the 500 ms decode window, not the 6 s TTFT wait"
        );
    }

    /// Regression for the P1 code-review finding: the old code keyed the
    /// re-anchor off the **run-level** TTFT latch, so it only ever happened on
    /// the run's FIRST model call. Every later turn (and every transport retry)
    /// charged its whole prefill wait into the first speed window.
    #[test]
    fn tps_meter_reanchors_on_every_model_call_and_after_a_retry() {
        let t0 = std::time::Instant::now();
        // Turn 1: stream starts at t0, first visible delta at +6 s.
        let mut turn1 = TpsMeter::new(t0);
        assert!(turn1.note_delta(tps_at(t0, 6_000)));
        let (_, ms1) = turn1.take_window(tps_at(t0, 6_500));
        assert_eq!(ms1, 500, "turn 1 excludes its TTFT wait");

        // Turn 2: a NEW meter (as the react loop does), 8 s of prefill this time.
        // With the old run-level latch this would have produced (8000, 1).
        let t1 = tps_at(t0, 10_000);
        let mut turn2 = TpsMeter::new(t1);
        assert!(
            turn2.note_delta(tps_at(t1, 8_000)),
            "turn 2 must still get a first-delta re-anchor"
        );
        let (tokens2, ms2) = turn2.take_window(tps_at(t1, 8_500));
        assert_eq!(ms2, 500, "turn 2 excludes its own TTFT wait too");
        assert_eq!(tokens2, 1, "the first delta is still counted");

        // Transport retry inside the same turn: fresh meter, fresh latch.
        let t2 = tps_at(t0, 30_000);
        let mut retried = TpsMeter::new(t2);
        assert!(
            retried.note_delta(tps_at(t2, 4_000)),
            "retry must re-arm the latch"
        );
        let (_, ms3) = retried.take_window(tps_at(t2, 4_500));
        assert_eq!(ms3, 500, "retried attempt excludes its prefill wait");
    }

    #[test]
    fn tps_meter_has_no_wall_clock_to_be_skewed() {
        // A wall-clock step used to freeze `should_emit` (backwards) or produce
        // a phantom 1000 tokens/s reading (forwards). The monotonic Instant
        // used now cannot be stepped at all; verify the throttle is purely a
        // function of elapsed monotonic time.
        let t0 = std::time::Instant::now();
        let mut m = TpsMeter::new(t0);
        m.note_delta(tps_at(t0, 100));
        assert!(!m.should_emit(tps_at(t0, 599)));
        assert!(m.should_emit(tps_at(t0, 600)));
        let (tokens, ms) = m.take_window(tps_at(t0, 600));
        assert_eq!(
            (tokens, ms),
            (1, 500),
            "one delta over a real 500 ms window"
        );
    }

    /// Live progress frames must be transient and must not be forwarded by a
    /// sub-agent. Both lists are silent-failure surfaces: a missing entry makes
    /// the frame either bloat every stream file or overwrite the parent meter.
    #[test]
    fn tps_progress_is_wired_into_the_transient_and_subagent_lists() {
        let session = include_str!("../session/mod.rs");
        let team = include_str!("../team/mod.rs");
        assert!(
            session.contains("\"reason_start\" | \"tps_progress\""),
            "session store must skip live progress frames"
        );
        assert!(
            team.contains("| \"tps_progress\""),
            "sub-agent forwarding must drop live progress frames"
        );
    }

    #[test]
    fn throttle_constants_match_the_java_kernel() {
        // Shared semantics with `ReasonTask`: a drift here would make the two
        // kernels emit progress at visibly different rates for the same model.
        assert_eq!(ARGS_PROGRESS_INTERVAL_MS, 200);
        assert_eq!(ARGS_PROGRESS_BYTES, 4096);
    }

    #[test]
    fn a_fresh_progress_waits_a_full_interval() {
        // `last_emit_at` is seeded to `now`, not 0: the skeleton card was just
        // created by `action_draft`, so an immediate "0 B" update is noise.
        let p = ArgsProgress::new(1_000);
        assert!(!p.should_emit(1_000), "same instant must not emit");
        assert!(
            !p.should_emit(1_199),
            "one ms short of the interval must not emit"
        );
        assert!(p.should_emit(1_200), "exactly one interval must emit");
    }

    #[test]
    fn the_time_threshold_fires_on_a_slow_trickle() {
        // A model dribbling bytes must still show movement, or the card looks
        // frozen even though the run is alive.
        let mut p = ArgsProgress::new(0);
        p.bytes = 10;
        assert!(!p.should_emit(100), "under both thresholds");
        assert!(
            p.should_emit(200),
            "time threshold reached with only 10 bytes"
        );
        p.mark_emitted(10, 200);
        assert!(!p.should_emit(399), "interval restarts after an emit");
        assert!(p.should_emit(400));
    }

    #[test]
    fn the_byte_threshold_fires_on_a_fast_burst() {
        // A fast burst must stay responsive instead of updating only every
        // 200 ms — this is the threshold the time rule cannot cover.
        let mut p = ArgsProgress::new(0);
        p.bytes = ARGS_PROGRESS_BYTES - 1;
        assert!(!p.should_emit(1), "one byte short must not emit");
        p.bytes = ARGS_PROGRESS_BYTES;
        assert!(
            p.should_emit(1),
            "byte threshold fires well inside the interval"
        );
        p.mark_emitted(ARGS_PROGRESS_BYTES, 1);
        p.bytes = ARGS_PROGRESS_BYTES + 100;
        assert!(!p.should_emit(2), "counter restarts after an emit");
        p.bytes = ARGS_PROGRESS_BYTES * 2;
        assert!(p.should_emit(2), "a second full chunk fires again");
    }

    #[test]
    fn throttling_a_long_stream_collapses_thousands_of_deltas() {
        // The actual defect this guards: a large `write` streams thousands of
        // small deltas over ~80 s. Unthrottled, that is thousands of WS writes
        // and DOM updates for a counter the client only ever renders as a total.
        let mut p = ArgsProgress::new(0);
        let mut emitted = 0u32;
        let mut now = 0i64;
        // 8000 deltas of 100 bytes each, one per millisecond (8 s of streaming).
        for _ in 0..8000 {
            now += 1;
            p.bytes += 100;
            if p.should_emit(now) {
                p.mark_emitted(p.bytes, now);
                emitted += 1;
            }
        }
        assert!(
            emitted < 200,
            "8000 deltas must collapse to a small number of frames, got {}",
            emitted
        );
        // But it must not collapse to nothing — the card has to keep moving.
        assert!(
            emitted > 10,
            "progress must still be visible, got {}",
            emitted
        );
    }

    #[test]
    fn saturating_arithmetic_survives_a_backwards_clock() {
        // A skewed or non-monotonic clock must not panic in debug builds or wrap
        // into a huge interval that silently stops all progress reporting.
        let mut p = ArgsProgress::new(1_000);
        p.bytes = 10;
        assert!(
            !p.should_emit(500),
            "clock went backwards: no emit, no panic"
        );
        // Bytes below the last emit (a reset) must not underflow either.
        p.mark_emitted(5_000, 1_000);
        p.bytes = 100;
        assert!(
            !p.should_emit(1_000),
            "bytes < last_emit_bytes must not underflow"
        );
    }

    // ─── transport retry must not double-concatenate tool arguments ──────────
    //
    // Regression for "Model output was truncated mid tool-call arguments (read)".
    //
    // The retry loop lives in `llm/client.rs`, *below* the react accumulators.
    // A stream that died mid-body therefore retried the request while
    // `tool_calls[i].function.arguments` still held the first attempt's half,
    // and the second attempt's deltas appended on top:
    //
    //     {"file_pa{"file_path":"x.rs"}
    //
    // which is not JSON, so `broken_argument_calls` rejected it and the turn
    // aborted — blaming the model for the client's own replay. Java never showed
    // this because its accumulators are locals inside the `callWithRetry` lambda.
    #[tokio::test]
    async fn transport_retry_after_partial_stream_does_not_double_arguments() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // One SSE line carrying a tool-call delta. Built with serde_json rather
        // than a hand-written `format!`: the payload has three nesting levels of
        // escaping (JSON inside a JSON string inside a Rust literal), and a
        // brace-count slip there produces a line the dialect parser silently
        // ignores — which would make this test pass by never exercising
        // anything at all.
        fn tool_call_delta(args: &str) -> String {
            let v = serde_json::json!({
                "choices": [{
                    "delta": {
                        "tool_calls": [{
                            "index": 0,
                            "id": "c1",
                            "function": { "name": "read", "arguments": args }
                        }]
                    }
                }]
            });
            format!("data: {}\n\n", v)
        }
        const FINISH_TOOLS: &str =
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n";
        const DONE: &str = "data: [DONE]\n\n";
        const HDR: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n";

        // A real file for the surviving `read` call to open.
        let tmp = std::env::temp_dir().join(format!("gwork-retry-test-{}.txt", std::process::id()));
        std::fs::write(&tmp, b"hello").unwrap();
        let full_args = serde_json::json!({ "file_path": tmp.to_string_lossy() }).to_string();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let mut n = 0u32;
            loop {
                if let Ok((mut sock, _)) = listener.accept().await {
                    let mut buf = [0u8; 8192];
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_millis(300),
                        sock.read(&mut buf),
                    )
                    .await;
                    n += 1;
                    match n {
                        1 => {
                            // Attempt 1: a well-formed 200 header promising far
                            // more bytes than we send, then HALF a tool-call's
                            // arguments, then the socket dies. hyper surfaces the
                            // shortfall as a body read error — exactly the
                            // mid-stream failure the retry loop must survive.
                            let body = format!(
                                "{}Content-Length: 999999\r\n\r\n{}",
                                HDR,
                                tool_call_delta("{\"file_pa")
                            );
                            let _ = sock.write_all(body.as_bytes()).await;
                            // Graceful FIN, NOT `drop(sock)`: an abrupt close with
                            // bytes still in the send buffer makes Windows emit
                            // RST, which discards them — the client then never
                            // sees the partial delta, `delivered` stays false and
                            // the retry goes silent. The test would pass without
                            // ever exercising the double-concatenation bug.
                            let _ = sock.shutdown().await;
                            drop(sock);
                            continue;
                        }
                        2 => {
                            // Attempt 2 (the transport retry): the complete tool
                            // call, properly terminated. If the react loop had
                            // kept attempt 1's half-argument, the concatenation
                            // would be invalid JSON and the turn would abort.
                            let body = format!("{}Connection: close\r\n\r\n", HDR)
                                + &tool_call_delta(&full_args)
                                + FINISH_TOOLS
                                + DONE;
                            let _ = sock.write_all(body.as_bytes()).await;
                            let _ = sock.shutdown().await;
                        }
                        _ => {
                            // Turn 2: a plain final answer, so the run ends
                            // Completed instead of looping on the same tool call
                            // until the turn budget runs out.
                            let text = serde_json::json!({
                                "choices": [{ "delta": { "content": "all done" } }]
                            });
                            let body = format!("{}Connection: close\r\n\r\n", HDR)
                                + &format!("data: {}\n\n", text)
                                + "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
                                + DONE;
                            let _ = sock.write_all(body.as_bytes()).await;
                            let _ = sock.shutdown().await;
                        }
                    }
                }
            }
        });

        let model = crate::config::ModelConfig {
            name: "mock".into(),
            standard: "openai".into(),
            api_url: format!("http://127.0.0.1:{}", port),
            api_key: "k".into(),
            model: "mock".into(),
            ..Default::default()
        };
        let mut settings = crate::config::Settings::default();
        // The two retry knobs MUST hold different values here, or this test
        // cannot tell which one the client was built from: `api_retries`
        // (web tools) and `model_retries` (LLM streams) both default to 3, so
        // leaving them equal let a revert of the `react` wiring to
        // `api_retries` pass unnoticed (verified by mutation).
        //
        // `api_retries = 0` is the discriminating choice: `with_retries` floors
        // it at 1 attempt, so a regression gives the stream no retry budget at
        // all, no `retry` frame is emitted, and the precondition assert below
        // fails loudly instead of passing vacuously.
        settings.general.api_retries = 0;
        settings.general.model_retries = 3;

        let config = ReActConfig {
            access_override: None,
            session_id: "work-retry-itest".into(),
            workspace: std::env::temp_dir(),
            session_dir: None,
            model,
            settings,
            access_mode: "full".into(),
            max_turns: 3,
            run_id: "run-retry-itest".into(),
            start_seq: 0,
            hitl_approved: true,
            gate: None,
            change_ledger: None,
            context_length: 0,
            turn_start_ms: 0,
            usage_seed: Default::default(),
            force_compact: false,
            compact_focus: None,
            resume_calibration: false,
            subagent_depth: 0,
            root_session_id: "work-retry-itest".into(),
            thinking: None,
        };

        let registry = std::sync::Arc::new(crate::tools::ToolRegistry::default_registry());
        let agent = ReActAgent::new(registry);
        let (frame_tx, mut frame_rx) = tokio::sync::mpsc::unbounded_channel();
        let cancel = tokio_util::sync::CancellationToken::new();

        let history = vec![
            crate::llm::types::ChatMessage::system("sys"),
            crate::llm::types::ChatMessage::user("read the file"),
        ];

        let run = agent.run(&config, history, frame_tx, cancel);
        let collector = tokio::spawn(async move {
            let mut frames = Vec::new();
            while let Some(f) = frame_rx.recv().await {
                frames.push(f);
            }
            frames
        });
        let result = run.await;
        let frames = collector.await.unwrap();

        // FIRST assert the precondition actually held: a mid-stream transport
        // retry happened and the frontend was told to drop the partial DOM.
        // Ordering matters — without this, every assertion below could pass
        // vacuously if the mock's truncated first attempt never triggered the
        // retry loop at all (the exact "test is green but proves nothing" trap).
        let retry_frame = frames.iter().find(|f| {
            f.frame_type == "retry" && f.extra["discardPartial"] == serde_json::json!(true)
        });
        assert!(
            retry_frame.is_some(),
            "a mid-stream transport retry must emit a discardPartial retry frame; got frames {:?}",
            frames
                .iter()
                .map(|f| f.frame_type.as_str())
                .collect::<Vec<_>>()
        );

        // Which retry knob actually reached the LLM client. `api_retries` is 0
        // and `model_retries` is 3 in this test ON PURPOSE: they are the two
        // knobs a settings.json carries, and the loop must be wired to the
        // model one. The frame's `max` is that budget as the client saw it, so
        // it is the only thing here that can tell the two apart — counting
        // attempts cannot, because one failure is survivable by any budget ≥1
        // and `with_retries` floors 0 to 1.
        //
        // Verified by mutation: with this assert removed, reverting
        // `run_inner` to `api_retries` keeps the whole test green.
        assert_eq!(
            retry_frame.unwrap().extra["max"],
            serde_json::json!(3),
            "the stream retry budget must come from settings.general.model_retries (3), \
             not api_retries (0 in this test); a floor of 1 proves the wiring regressed"
        );

        // The user-visible symptom must be gone: the retried attempt's arguments
        // replaced the aborted attempt's half, instead of concatenating onto it.
        let truncation = frames.iter().find(|f| {
            f.frame_type == "error"
                && f.text
                    .as_deref()
                    .map(|t| t.contains("truncated mid tool-call"))
                    .unwrap_or(false)
        });
        assert!(
            truncation.is_none(),
            "arguments must not be double-concatenated across a transport retry; got {:?}",
            truncation.map(|f| f.text.clone())
        );
        assert_eq!(
            result.stop_reason,
            StopReason::Completed,
            "the retried turn must complete; final_answer={:?}",
            result.final_answer
        );

        let _ = std::fs::remove_file(&tmp);
    }

    // ─── corruption gate end-to-end (work-mw8wizyz) ─────────────────────────
    //
    // The live failure, compressed into a mock: one bad byte from the upstream
    // garbled the turn, the garbling landed inside a tool-call argument that
    // stayed VALID JSON (so `broken_argument_calls` waved it through), and the
    // loop executed a real `read` of a nonsense path. The user saw a
    // "File not found" tool card, a garbled thinking block, and the model spent
    // the rest of the run chasing its own garbage until the 45-minute retry
    // budget ran out.
    //
    // Three behaviours must hold, one test each:
    //   1. corrupt tool arguments are never executed — the turn retries clean;
    //   2. retries exhausted ⇒ honest terminal error that rolls back the DOM;
    //   3. corrupt *prose* must NOT kill a healthy run (false-positive guard).

    /// Mock SSE helpers, shared by the corruption tests below.
    fn corrupt_mock_parts() -> (String, String, String) {
        // The exact leaked-framing shape from the session dump, wrapped so it
        // stays valid JSON — that validity is the whole point of the gate.
        let corrupt_args = serde_json::json!({
            "file_path": "37/w 20 |4 Util ...\"</think><tool_call>bash<arg_key>command</arg_key><arg_value>Select-String -Path/w-ai/wxai-agent/org/d/org/grom/ChatClient.java"
        })
        .to_string();

        let tool_call_line = format!(
            "data: {}\n\n",
            serde_json::json!({
                "choices": [{
                    "delta": {
                        "tool_calls": [{
                            "index": 0,
                            "id": "c-corrupt",
                            "function": { "name": "read", "arguments": corrupt_args }
                        }]
                    }
                }]
            })
        );
        let finish_tools =
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n".to_string();
        let done = "data: [DONE]\n\n".to_string();
        (tool_call_line, finish_tools, done)
    }

    /// 1. A corrupt tool call must never reach the executor; the turn retries
    ///    clean and the run completes. Asserts on FRAMES (no `action_start`
    ///    ever emitted) because that is what proves non-execution — the tool
    ///    registry is real here, so a leak would also touch the filesystem.
    #[tokio::test]
    async fn corrupt_tool_arguments_are_never_executed_and_retry_clean() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let (tool_line, finish_tools, done) = corrupt_mock_parts();
        const HDR: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n";

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let mut n = 0u32;
            loop {
                if let Ok((mut sock, _)) = listener.accept().await {
                    let mut buf = [0u8; 16384];
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_millis(300),
                        sock.read(&mut buf),
                    )
                    .await;
                    n += 1;
                    let body = if n == 1 {
                        // Attempt 1: the corrupt tool call, properly terminated —
                        // a "successful" stream as far as the transport knows.
                        format!("{}Connection: close\r\n\r\n", HDR)
                            + &tool_line
                            + &finish_tools
                            + &done
                    } else {
                        // Attempt 2 (the corruption gate's clean retry): a plain
                        // final answer, so the run completes.
                        let text = serde_json::json!({
                            "choices": [{ "delta": { "content": "recovered answer" } }]
                        });
                        format!("{}Connection: close\r\n\r\n", HDR)
                            + &format!("data: {}\n\n", text)
                            + "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
                            + &done
                    };
                    let _ = sock.write_all(body.as_bytes()).await;
                    let _ = sock.shutdown().await;
                }
            }
        });

        let config = corruption_itest_config(port, "work-corrupt-retry-itest", 5);
        let agent = ReActAgent::new(std::sync::Arc::new(
            crate::tools::ToolRegistry::default_registry(),
        ));
        let (frame_tx, mut frame_rx) = tokio::sync::mpsc::unbounded_channel();
        let cancel = tokio_util::sync::CancellationToken::new();
        let run = agent.run(
            &config,
            vec![
                crate::llm::types::ChatMessage::system("sys"),
                crate::llm::types::ChatMessage::user("go"),
            ],
            frame_tx,
            cancel,
        );
        let collector = tokio::spawn(async move {
            let mut frames = Vec::new();
            while let Some(f) = frame_rx.recv().await {
                frames.push(f);
            }
            frames
        });
        let result = run.await;
        let frames = collector.await.unwrap();

        // Precondition first: the corruption gate must have fired and told the
        // client to roll back. Without this, everything below could pass
        // vacuously (e.g. if the dialect parser silently dropped the delta).
        assert!(
            frames
                .iter()
                .any(|f| f.frame_type == "retry"
                    && f.extra["discardPartial"] == serde_json::json!(true)),
            "the corruption gate must emit a discardPartial retry frame; got {:?}",
            frames
                .iter()
                .map(|f| f.frame_type.as_str())
                .collect::<Vec<_>>()
        );
        // The corrupt call never executed: `action_start` is emitted only at
        // execution time, so its absence is the proof (no File-not-found card,
        // no filesystem touch, no garbage fed back into the model).
        assert!(
            !frames.iter().any(|f| f.frame_type == "action_start"),
            "a corrupt tool call must never be executed"
        );
        assert_eq!(result.stop_reason, StopReason::Completed);
        assert!(
            result.final_answer.contains("recovered answer"),
            "the clean retry must produce the real answer; got {:?}",
            result.final_answer
        );
    }

    /// 2. Retries exhausted ⇒ the run ends with an honest error that carries
    ///    `discardPartial` (the last attempt's garbage is already on screen and
    ///    no further retry frame will clear it), and the corrupt call still
    ///    never executed.
    #[tokio::test]
    async fn corrupt_stream_exhausts_retries_then_fails_with_discard() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let (tool_line, finish_tools, done) = corrupt_mock_parts();
        const HDR: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n";

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                if let Ok((mut sock, _)) = listener.accept().await {
                    let mut buf = [0u8; 16384];
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_millis(300),
                        sock.read(&mut buf),
                    )
                    .await;
                    // EVERY attempt corrupt: the systematic-damage case where the
                    // budget must run out and the run must stop honestly — the
                    // exact anti-pattern of work-mw8wizyz was retrying this for
                    // 45 minutes.
                    let body = format!("{}Connection: close\r\n\r\n", HDR)
                        + &tool_line
                        + &finish_tools
                        + &done;
                    let _ = sock.write_all(body.as_bytes()).await;
                    let _ = sock.shutdown().await;
                }
            }
        });

        let config = corruption_itest_config(port, "work-corrupt-exhaust-itest", 10);
        let agent = ReActAgent::new(std::sync::Arc::new(
            crate::tools::ToolRegistry::default_registry(),
        ));
        let (frame_tx, mut frame_rx) = tokio::sync::mpsc::unbounded_channel();
        let cancel = tokio_util::sync::CancellationToken::new();
        let run = agent.run(
            &config,
            vec![
                crate::llm::types::ChatMessage::system("sys"),
                crate::llm::types::ChatMessage::user("go"),
            ],
            frame_tx,
            cancel,
        );
        let collector = tokio::spawn(async move {
            let mut frames = Vec::new();
            while let Some(f) = frame_rx.recv().await {
                frames.push(f);
            }
            frames
        });
        let result = run.await;
        let frames = collector.await.unwrap();

        assert!(
            !frames.iter().any(|f| f.frame_type == "action_start"),
            "exhausted or not, the corrupt call must never execute"
        );
        let err = frames
            .iter()
            .find(|f| f.frame_type == "error")
            .expect("a terminal error frame must be emitted");
        assert_eq!(
            err.extra["discardPartial"],
            serde_json::json!(true),
            "the terminal error must roll back the last attempt's garbage DOM"
        );
        assert_eq!(result.stop_reason, StopReason::Error);
        assert!(
            result.final_answer.contains("NOT executed"),
            "the error must say the calls were refused, not pretend they ran: {:?}",
            result.final_answer
        );
        // This mock's damage is confined to the tool arguments (attempt 1 emits
        // no content and no reasoning), so `prose_hits` is empty here — the
        // exact input that used to render "corrupted ()" with an empty
        // parenthetical. The message must still name the damage.
        assert!(
            !result.final_answer.contains("corrupted ()"),
            "the damage parenthetical must never be empty; got {:?}",
            result.final_answer
        );
        assert!(
            result.final_answer.contains("damaged arguments in: read"),
            "with empty prose signatures the message must fall back to naming \
             the damaged call; got {:?}",
            result.final_answer
        );
        // Bounded: MAX_CORRUPTION_RETRIES(2) retries + 1 exhausted round = 3
        // model requests, never the whole turn budget. Pinned because the
        // counter is run-level BY DESIGN — a per-turn reset would reintroduce
        // the 45-minute burn.
        assert!(
            result.turns_used <= MAX_CORRUPTION_RETRIES + 1,
            "corruption retries must be run-bounded; turns_used={}",
            result.turns_used
        );
    }

    /// 3. False-positive guard: corrupt *prose* (no tool calls) must NOT kill
    ///    the run. A model legitimately printing U+FFFD — debugging a codec,
    ///    reviewing this very bug — keeps its answer; killing it would repeat
    ///    the removed diminishing-output heuristic's mistake (healthy runs
    ///    terminated by an output-shape guess).
    #[tokio::test]
    async fn corrupt_prose_keeps_the_answer_instead_of_killing_the_run() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        const HDR: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n";
        let garbled = "analysis with a \u{FFFD} inside but still readable";

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let garbled_owned = garbled.to_string();
        tokio::spawn(async move {
            loop {
                if let Ok((mut sock, _)) = listener.accept().await {
                    let mut buf = [0u8; 16384];
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_millis(300),
                        sock.read(&mut buf),
                    )
                    .await;
                    // Every attempt returns the same slightly-garbled prose with
                    // a clean stop: text-only, nothing dangerous to refuse.
                    let text = serde_json::json!({
                        "choices": [{ "delta": { "content": garbled_owned } }]
                    });
                    let body = format!("{}Connection: close\r\n\r\n", HDR)
                        + &format!("data: {}\n\n", text)
                        + "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
                        + "data: [DONE]\n\n";
                    let _ = sock.write_all(body.as_bytes()).await;
                    let _ = sock.shutdown().await;
                }
            }
        });

        let config = corruption_itest_config(port, "work-corrupt-prose-itest", 10);
        let agent = ReActAgent::new(std::sync::Arc::new(
            crate::tools::ToolRegistry::default_registry(),
        ));
        let (frame_tx, mut frame_rx) = tokio::sync::mpsc::unbounded_channel();
        let cancel = tokio_util::sync::CancellationToken::new();
        let run = agent.run(
            &config,
            vec![
                crate::llm::types::ChatMessage::system("sys"),
                crate::llm::types::ChatMessage::user("go"),
            ],
            frame_tx,
            cancel,
        );
        let collector = tokio::spawn(async move {
            let mut frames = Vec::new();
            while let Some(f) = frame_rx.recv().await {
                frames.push(f);
            }
            frames
        });
        let result = run.await;
        let frames = collector.await.unwrap();

        assert_eq!(
            result.stop_reason,
            StopReason::Completed,
            "garbled prose must not kill a text-only run; final={:?}",
            result.final_answer
        );
        assert!(
            result.final_answer.contains(garbled),
            "the answer must survive verbatim; got {:?}",
            result.final_answer
        );
        // The user is still told why the text looks odd — but only after the
        // retry budget is spent, and never with discardPartial (the answer text
        // itself is being KEPT; rolling back would delete it).
        let err = frames.iter().find(|f| f.frame_type == "error");
        if let Some(e) = err {
            assert_ne!(
                e.extra["discardPartial"],
                serde_json::json!(true),
                "a kept answer must not be rolled back"
            );
        }
    }

    /// 4. The gate must see damage that lands ONLY in the thinking block.
    ///
    /// `ReasoningDelta` is emit-only, so before a reasoning accumulator existed
    /// the gate could scan `content_buf` alone — and this test fails: attempt 1
    /// streams clean content with a clean stop, so the run completes and no
    /// retry frame is ever emitted. It is an integration test rather than a
    /// pure-function one precisely because unit tests on
    /// `corruption_signatures` stay green either way: they cannot see WHICH
    /// buffer the gate reads. This is the reported "思考也有乱码" case, and on
    /// long-thinking models the content buffer stays empty for minutes, so
    /// reasoning is often the ONLY text available to judge.
    #[tokio::test]
    async fn corrupt_reasoning_alone_still_fires_the_gate() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        const HDR: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n";

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let mut n = 0u32;
            loop {
                if let Ok((mut sock, _)) = listener.accept().await {
                    let mut buf = [0u8; 16384];
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_millis(300),
                        sock.read(&mut buf),
                    )
                    .await;
                    n += 1;
                    let body = if n == 1 {
                        // Attempt 1: the *thinking* text is damaged, the visible
                        // content is clean and the stream terminates normally —
                        // a "successful" response whose only defect is in
                        // reasoning. No tool call, so nothing dangerous runs;
                        // the point is that the damage is still caught.
                        let reasoning = serde_json::json!({
                            "choices": [{
                                "delta": { "reasoning_content": "思考过程 \u{FFFD} 乱码" }
                            }]
                        });
                        let text = serde_json::json!({
                            "choices": [{ "delta": { "content": "clean visible answer" } }]
                        });
                        format!("{}Connection: close\r\n\r\n", HDR)
                            + &format!("data: {}\n\n", reasoning)
                            + &format!("data: {}\n\n", text)
                            + "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
                            + "data: [DONE]\n\n"
                    } else {
                        // Attempt 2 (the gate's clean retry): fully healthy.
                        let text = serde_json::json!({
                            "choices": [{ "delta": { "content": "recovered answer" } }]
                        });
                        format!("{}Connection: close\r\n\r\n", HDR)
                            + &format!("data: {}\n\n", text)
                            + "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
                            + "data: [DONE]\n\n"
                    };
                    let _ = sock.write_all(body.as_bytes()).await;
                    let _ = sock.shutdown().await;
                }
            }
        });

        let config = corruption_itest_config(port, "work-corrupt-reason-itest", 10);
        let agent = ReActAgent::new(std::sync::Arc::new(
            crate::tools::ToolRegistry::default_registry(),
        ));
        let (frame_tx, mut frame_rx) = tokio::sync::mpsc::unbounded_channel();
        let cancel = tokio_util::sync::CancellationToken::new();
        let run = agent.run(
            &config,
            vec![
                crate::llm::types::ChatMessage::system("sys"),
                crate::llm::types::ChatMessage::user("go"),
            ],
            frame_tx,
            cancel,
        );
        let collector = tokio::spawn(async move {
            let mut frames = Vec::new();
            while let Some(f) = frame_rx.recv().await {
                frames.push(f);
            }
            frames
        });
        let result = run.await;
        let frames = collector.await.unwrap();

        // The decisive assertion: reasoning-only damage must have fired the gate
        // and asked the client to roll back the garbled thinking block. Without
        // `reasoning_buf` this finds nothing and the test fails.
        assert!(
            frames
                .iter()
                .any(|f| f.frame_type == "retry"
                    && f.extra["discardPartial"] == serde_json::json!(true)),
            "corruption confined to the thinking block must still fire the gate; got {:?}",
            frames
                .iter()
                .map(|f| f.frame_type.as_str())
                .collect::<Vec<_>>()
        );
        // The retry must have been *taken* and produced the clean attempt, not
        // merely offered — otherwise the discardPartial frame above could come
        // from an unrelated path.
        assert_eq!(
            result.stop_reason,
            StopReason::Completed,
            "the clean retry must complete the run; final={:?}",
            result.final_answer
        );
        assert!(
            result.final_answer.contains("recovered answer"),
            "the final answer must come from the clean retry, not the damaged \
             attempt; got {:?}",
            result.final_answer
        );
    }

    /// Shared config for the corruption integration tests: a real workspace
    /// (temp dir), full access, generous turn budget — the budget assertions
    /// are made on `MAX_CORRUPTION_RETRIES`, not `max_turns`.
    fn corruption_itest_config(port: u16, id: &str, max_turns: u32) -> ReActConfig {
        ReActConfig {
            access_override: None,
            session_id: id.into(),
            workspace: std::env::temp_dir(),
            session_dir: None,
            model: crate::config::ModelConfig {
                name: "mock".into(),
                standard: "openai".into(),
                api_url: format!("http://127.0.0.1:{}", port),
                api_key: "k".into(),
                model: "mock".into(),
                ..Default::default()
            },
            settings: crate::config::Settings::default(),
            access_mode: "full".into(),
            max_turns,
            run_id: format!("run-{}", id),
            start_seq: 0,
            hitl_approved: true,
            gate: None,
            change_ledger: None,
            context_length: 0,
            turn_start_ms: 0,
            usage_seed: Default::default(),
            force_compact: false,
            compact_focus: None,
            resume_calibration: false,
            subagent_depth: 0,
            root_session_id: id.into(),
            thinking: None,
        }
    }

    // ─── forced /compact actually fires from inside the loop ───────────────
    //
    // The code review found the forced-compress condition was `turns == 0`,
    // unreachable because `turns += 1` runs first — the pure-function tests in
    // compress.rs all call `compress()` directly and stayed green, so the
    // wiring gap was invisible. This integration test drives the REAL loop
    // (mock LLM over a real TCP socket) and asserts the focus turn the model
    // actually received. A regression to any unreachable condition fails here
    // even if every compress.rs test passes.

    #[tokio::test]
    async fn forced_compact_with_focus_reaches_the_model_through_the_loop() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // Capture the request body the loop sends, so the assertion is about
        // what the model actually received — not what `messages` held before.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (seen_tx, mut seen_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        tokio::spawn(async move {
            loop {
                if let Ok((mut sock, _)) = listener.accept().await {
                    let mut req = Vec::new();
                    let mut buf = [0u8; 8192];
                    // Read until the body ends (Content-Length exhausted or
                    // connection close). One generous read burst suffices: the
                    // request is small and the client sends it in one write.
                    for _ in 0..32 {
                        match tokio::time::timeout(
                            std::time::Duration::from_millis(300),
                            sock.read(&mut buf),
                        )
                        .await
                        {
                            Ok(Ok(0)) | Err(_) => break,
                            Ok(Ok(n)) => req.extend_from_slice(&buf[..n]),
                            _ => break,
                        }
                    }
                    let _ = seen_tx.send(req.clone());
                    // Now respond on the same socket with the SSE answer.
                    let body = concat!(
                        "HTTP/1.1 200 OK\r\n",
                        "Content-Type: text/event-stream\r\n",
                        "Connection: close\r\n\r\n",
                        "data: {\"choices\":[{\"delta\":{\"content\":\"done\"}}]}\n\n",
                        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                        "data: [DONE]\n\n",
                    );
                    let _ = sock.write_all(body.as_bytes()).await;
                    let _ = sock.shutdown().await;
                }
            }
        });

        // A history big enough that compression would visibly change it, driven
        // under the default 256K window: same shape as compress.rs's
        // `big_history`, but only the forced pass can compress it at turn 1
        // because the trigger threshold (223K) is not yet reached… so the
        // assertion must rely on the FOCUS turn, which is injected only by a
        // forced pass on a below-trigger history. Any reachable-condition
        // regression (e.g. back to `turns == 0`) drops the focus turn and fails.
        let mut history = vec![
            crate::llm::types::ChatMessage::system("sys"),
            crate::llm::types::ChatMessage::user("original task"),
        ];
        for i in 0..40 {
            let call_id = format!("c{i}");
            history.push(assistant_calling(&[(call_id.as_str(), "read")]));
            history.push(crate::llm::types::ChatMessage::tool_result(
                &call_id, "payload",
            ));
            history.push(crate::llm::types::ChatMessage::assistant(format!(
                "thought {i}"
            )));
        }

        let model = crate::config::ModelConfig {
            name: "mock".into(),
            standard: "openai".into(),
            api_url: format!("http://127.0.0.1:{}", port),
            api_key: "k".into(),
            model: "mock".into(),
            ..Default::default()
        };

        let config = ReActConfig {
            access_override: None,
            session_id: "work-itest".into(),
            workspace: std::env::temp_dir(),
            session_dir: None,
            model,
            settings: crate::config::Settings::default(),
            access_mode: "full".into(),
            max_turns: 5,
            run_id: "run-itest".into(),
            start_seq: 0,
            hitl_approved: true,
            gate: None,
            change_ledger: None,
            context_length: 0,
            turn_start_ms: 0,
            usage_seed: Default::default(),
            force_compact: true,
            compact_focus: Some("prioritise rust-remediation notes".into()),
            resume_calibration: false,
            subagent_depth: 0,
            root_session_id: "work-itest".into(),
            thinking: None,
        };

        let registry = std::sync::Arc::new(crate::tools::ToolRegistry::default_registry());
        let agent = ReActAgent::new(registry);
        let (frame_tx, _frame_rx) = tokio::sync::mpsc::unbounded_channel();
        let cancel = tokio_util::sync::CancellationToken::new();

        let result = agent.run(&config, history, frame_tx, cancel).await;
        assert_eq!(
            result.stop_reason,
            StopReason::Completed,
            "mock must complete, got {:?}",
            result.stop_reason
        );

        // The request the mock received must contain the focus turn: the forced
        // pass ran inside the loop and the compressed history carried the focus.
        let req = seen_rx
            .recv()
            .await
            .expect("the loop must have called the mock");
        let req_text = String::from_utf8_lossy(&req);
        assert!(
            req_text.contains("prioritise rust-remediation notes"),
            "the focus instruction must reach the model through the real loop; \
             request was {} bytes",
            req.len()
        );
        assert!(
            req_text.contains("压缩聚焦"),
            "the focus turn must be labelled as a directive in the request body"
        );
    }

    // ─── 【2026-11 用户报障】403 排队不重试 / 重试计数串线 / 静默重试 ───────
    //
    // 用户症状：后台 modelRetries=10，网关返回
    // `403 RESOURCE_LIMIT_EXCEEDED ... request is queued ... retry after ...`
    // 时第 1 次失败就放弃（旧 is_non_retryable 把 403 判成致命）；且前台
    // 「正在重试 n/40」的 40 是 AutoRethink 扩容后的 maxTurns，不是重试预算。
    //
    // 本测试驱动真实 loop + 真实 LlmClient（mock TCP）：
    //   第 1 次请求 → 403 排队（首字节前失败）
    //   第 2 次请求 → 正常完成
    // 断言三件事：重试真的发生且前台可见（retry 帧、无 discardPartial）、
    // 计数 = attempt/modelRetries（1/3，而不是 turns/maxTurns=1/2）、
    // 重试不烧轮次（turns_used == 1）。
    #[tokio::test]
    async fn queued_403_retries_visibly_with_model_retries_budget_and_no_turn_burn() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let mut n = 0u32;
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let mut buf = [0u8; 8192];
                let _ = tokio::time::timeout(
                    std::time::Duration::from_millis(300),
                    sock.read(&mut buf),
                )
                .await;
                n += 1;
                if n == 1 {
                    // 用户截图的真实形状：403 + 排队标记 + retry after。
                    let body = concat!(
                        "HTTP/1.1 403 Forbidden\r\n",
                        "Content-Type: application/json\r\n",
                        "Connection: close\r\n\r\n",
                        "{\"code\":\"RESOURCE_LIMIT_EXCEEDED\",\"message\":\"request is queued, retry after 1s\"}"
                    );
                    let _ = sock.write_all(body.as_bytes()).await;
                } else {
                    let text = serde_json::json!({
                        "choices": [{ "delta": { "content": "done after queue" } }]
                    });
                    let body = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {}\n\ndata: {{\"choices\":[{{\"delta\":{{}},\"finish_reason\":\"stop\"}}]}}\n\ndata: [DONE]\n\n",
                        text
                    );
                    let _ = sock.write_all(body.as_bytes()).await;
                }
                let _ = sock.shutdown().await;
                drop(sock);
                if n >= 2 {
                    break;
                }
            }
        });

        let model = crate::config::ModelConfig {
            name: "mock".into(),
            standard: "openai".into(),
            api_url: format!("http://127.0.0.1:{}", port),
            api_key: "k".into(),
            model: "mock".into(),
            ..Default::default()
        };
        let mut settings = crate::config::Settings::default();
        // 三个旋钮取互不相同的值，任何一个串线都会被下面的断言抓住：
        // modelRetries=3（重试预算）、apiRetries=7（web 工具，不得混入）、
        // maxTurns=2（轮次上限，旧实现把它当重试分母显示成 n/2）。
        settings.general.model_retries = 3;
        settings.general.api_retries = 7;
        settings.general.auto_rethink = false;

        let config = ReActConfig {
            access_override: None,
            session_id: "work-queued-403".into(),
            workspace: std::env::temp_dir(),
            session_dir: None,
            model,
            settings,
            access_mode: "full".into(),
            max_turns: 2,
            run_id: "run-queued-403".into(),
            start_seq: 0,
            hitl_approved: true,
            gate: None,
            change_ledger: None,
            context_length: 0,
            turn_start_ms: 0,
            usage_seed: Default::default(),
            force_compact: false,
            compact_focus: None,
            resume_calibration: false,
            subagent_depth: 0,
            root_session_id: "work-queued-403".into(),
            thinking: None,
        };

        let registry = std::sync::Arc::new(crate::tools::ToolRegistry::default_registry());
        let agent = ReActAgent::new(registry);
        let (frame_tx, mut frame_rx) = tokio::sync::mpsc::unbounded_channel();
        let cancel = tokio_util::sync::CancellationToken::new();
        let history = vec![crate::llm::types::ChatMessage::user("hi")];

        let run = agent.run(&config, history, frame_tx, cancel);
        let collector = tokio::spawn(async move {
            let mut frames = Vec::new();
            while let Some(f) = frame_rx.recv().await {
                frames.push(f);
            }
            frames
        });
        let result = run.await;
        let frames = collector.await.unwrap();

        // 1) 重试真的发生，且首字节前的失败也前台可见：
        //    retry 帧存在、不带 discardPartial（没有任何已渲染内容可丢）。
        let retry_frames: Vec<_> = frames.iter().filter(|f| f.frame_type == "retry").collect();
        assert!(
            !retry_frames.is_empty(),
            "a queued 403 must produce a visible retry frame; got {:?}",
            frames
                .iter()
                .map(|f| f.frame_type.as_str())
                .collect::<Vec<_>>()
        );
        let f = retry_frames[0];
        assert_ne!(
            f.extra["discardPartial"],
            serde_json::json!(true),
            "nothing was delivered before the 403, so no DOM rollback may be requested"
        );

        // 2) 计数 = attempt/modelRetries：1/3。
        //    旧实现这里是 turns/maxTurns = 1/2（线上被 AutoRethink 扩成 n/40）。
        assert_eq!(
            f.extra["attempt"],
            serde_json::json!(1),
            "first retry of this call"
        );
        assert_eq!(
            f.extra["max"],
            serde_json::json!(3),
            "the denominator must be settings.modelRetries (3), not maxTurns (2) \
             or apiRetries (7)"
        );
        assert!(
            f.text.as_deref().unwrap_or("").contains("1/3"),
            "the banner text must show the same budget: {:?}",
            f.text
        );

        // 3) 重试不烧轮次：一次调用 + 一次传输层重试，turns_used 仍为 1。
        assert_eq!(
            result.turns_used, 1,
            "a retry of the same call must not consume a turn"
        );
        assert_eq!(
            result.stop_reason,
            StopReason::Completed,
            "the retried request must succeed; final_answer={:?}",
            result.final_answer
        );
    }

    // ─── 契约 §4.2：complete_task 直通 / 批尾 / 与 ask_user 互斥 ──────────────

    /// 纯函数：complete_task 排到批尾，其余保持相对顺序，原始流式索引保留。
    #[test]
    fn order_complete_task_last_moves_it_to_the_tail() {
        let mk = |id: &str, name: &str| ToolCall {
            id: id.into(),
            call_type: "function".into(),
            function: crate::llm::types::FunctionCall {
                name: name.into(),
                arguments: "{}".into(),
            },
        };
        // complete_task 在中间 → 移到末尾，read/grep 相对顺序不变。
        let ordered = order_complete_task_last(vec![
            mk("c1", "read"),
            mk("c2", "complete_task"),
            mk("c3", "grep"),
        ]);
        let names: Vec<&str> = ordered
            .iter()
            .map(|(_, tc)| tc.function.name.as_str())
            .collect();
        assert_eq!(names, vec!["read", "grep", "complete_task"]);
        // 原始流式索引保留（args_progress 按它记账）。
        assert_eq!(
            ordered[2].0, 1,
            "complete_task keeps its original stream index"
        );
        // 无 complete_task → 原样。
        let plain = order_complete_task_last(vec![mk("a", "read"), mk("b", "grep")]);
        assert_eq!(
            plain.iter().map(|(i, _)| *i).collect::<Vec<_>>(),
            vec![0, 1]
        );
    }

    /// 生命周期帧抑制名单：ask_user 与 complete_task 都在内。
    #[test]
    fn lifecycle_suppression_covers_ask_and_complete() {
        assert!(lifecycle_suppressed("ask_user"));
        assert!(lifecycle_suppressed("complete_task"));
        assert!(!lifecycle_suppressed("read"));
        assert!(!lifecycle_suppressed("bash"));
    }

    /// 构造一个只回放固定 SSE 脚本的 mock provider（每个连接按序取下一段响应）。
    async fn scripted_mock(responses: Vec<String>) -> u16 {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let mut idx = 0usize;
            loop {
                if let Ok((mut sock, _)) = listener.accept().await {
                    let mut buf = [0u8; 16384];
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_millis(300),
                        sock.read(&mut buf),
                    )
                    .await;
                    let body = responses.get(idx).cloned().unwrap_or_else(|| {
                        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: [DONE]\n\n".to_string()
                    });
                    idx += 1;
                    let _ = sock.write_all(body.as_bytes()).await;
                    let _ = sock.shutdown().await;
                }
            }
        });
        port
    }

    fn sse_tool_call(index: u32, id: &str, name: &str, args: &serde_json::Value) -> String {
        format!(
            "data: {}\n\n",
            serde_json::json!({
                "choices": [{ "delta": { "tool_calls": [{
                    "index": index, "id": id,
                    "function": { "name": name, "arguments": args.to_string() }
                }]}}]
            })
        )
    }

    const SSE_HDR: &str =
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n";
    const SSE_FINISH_TOOLS: &str =
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n";
    const SSE_DONE: &str = "data: [DONE]\n\n";

    async fn run_complete_task_scenario(
        responses: Vec<String>,
        id: &str,
    ) -> (ReActResult, Vec<Frame>) {
        let port = scripted_mock(responses).await;
        let config = corruption_itest_config(port, id, 6);
        let registry = std::sync::Arc::new(crate::tools::ToolRegistry::default_registry());
        let agent = ReActAgent::new(registry);
        let (frame_tx, mut frame_rx) = tokio::sync::mpsc::unbounded_channel();
        let cancel = tokio_util::sync::CancellationToken::new();
        let history = vec![ChatMessage::system("sys"), ChatMessage::user("do the work")];
        let run = agent.run(&config, history, frame_tx, cancel);
        let collector = tokio::spawn(async move {
            let mut frames = Vec::new();
            while let Some(f) = frame_rx.recv().await {
                frames.push(f);
            }
            frames
        });
        let result = run.await;
        let frames = collector.await.unwrap();
        (result, frames)
    }

    /// 契约 §4.2：complete_task 成功 → summary 作为 final_answer 直通 END，
    /// 发 text+trace+done，StopReason::Completed，且无 complete_task 工具卡。
    #[tokio::test]
    async fn complete_task_success_streams_summary_and_ends() {
        let summary = "## 完成\n改动已落地，测试全绿。";
        let resp = format!(
            "{SSE_HDR}{}{SSE_FINISH_TOOLS}{SSE_DONE}",
            sse_tool_call(
                0,
                "ct-1",
                "complete_task",
                &serde_json::json!({"summary": summary})
            )
        );
        let (result, frames) = run_complete_task_scenario(vec![resp], "ct-direct").await;
        assert_eq!(result.stop_reason, StopReason::Completed);
        assert_eq!(result.final_answer, summary);
        // text 帧整段呈现 summary（不逐 token）。
        assert!(
            frames
                .iter()
                .any(|f| f.frame_type == "text" && f.text.as_deref() == Some(summary)),
            "summary must be delivered as one text frame: {:?}",
            frames
                .iter()
                .map(|f| f.frame_type.as_str())
                .collect::<Vec<_>>()
        );
        assert!(frames.iter().any(|f| f.frame_type == "trace"));
        assert!(frames.iter().any(|f| f.frame_type == "done"));
        // 生命周期帧抑制：complete_task 不建工具卡。
        assert!(
            !frames
                .iter()
                .any(|f| f.tool_name.as_deref() == Some("complete_task")
                    && (f.frame_type == "action_start"
                        || f.frame_type == "action_end"
                        || f.frame_type == "action_draft")),
            "complete_task must not emit lifecycle cards"
        );
        // 历史配对完整：complete_task 的 tool result（ok(summary)）入史。
        assert!(
            result
                .messages
                .iter()
                .any(|m| m.tool_call_id.as_deref() == Some("ct-1")
                    && m.content_text().contains(summary)),
            "complete_task must have a paired tool result in history"
        );
    }

    /// 自审修复 D1：批次声明只统计可见成员。read + complete_task 同批时，
    /// complete_task 无生命周期卡，若把它算进 batchSize，前端 doneCount 永远
    /// 到不了分母、批次头部 loading 永不收口。过滤后可见成员 <2 → 整帧不发。
    #[tokio::test]
    async fn batch_declaration_excludes_lifecycle_suppressed_tools() {
        let summary = "收尾。";
        let resp = format!(
            "{SSE_HDR}{}{}{SSE_FINISH_TOOLS}{SSE_DONE}",
            sse_tool_call(
                0,
                "rd-1",
                "read",
                &serde_json::json!({"file_path":"Cargo.toml"})
            ),
            sse_tool_call(
                1,
                "ct-b",
                "complete_task",
                &serde_json::json!({"summary": summary})
            )
        );
        let (result, frames) = run_complete_task_scenario(vec![resp], "ct-batch").await;
        assert_eq!(result.stop_reason, StopReason::Completed);
        // 可见成员只剩 read（1 个）→ 不发批次声明帧。
        assert!(
            !frames.iter().any(|f| f.frame_type == "action_batch"),
            "a batch with only one visible member must not declare a batch: {:?}",
            frames
                .iter()
                .map(|f| f.frame_type.as_str())
                .collect::<Vec<_>>()
        );
    }

    /// 自审修复 D1（对照）：两个可见工具 + complete_task → 批次声明 batchSize=2，
    /// 成员不含 complete_task（分母与真实卡片数一致，进度可收口）。
    #[tokio::test]
    async fn batch_declaration_counts_only_visible_members() {
        let resp = format!(
            "{SSE_HDR}{}{}{}{SSE_FINISH_TOOLS}{SSE_DONE}",
            sse_tool_call(
                0,
                "rd-2",
                "read",
                &serde_json::json!({"file_path":"Cargo.toml"})
            ),
            sse_tool_call(
                1,
                "ct-c",
                "complete_task",
                &serde_json::json!({"summary":"收尾。"})
            ),
            sse_tool_call(2, "ls-1", "ls", &serde_json::json!({}))
        );
        let (result, frames) = run_complete_task_scenario(vec![resp], "ct-batch2").await;
        assert_eq!(result.stop_reason, StopReason::Completed);
        let batch = frames
            .iter()
            .find(|f| f.frame_type == "action_batch")
            .expect("two visible members must declare a batch");
        assert_eq!(
            batch.extra.get("batchSize").and_then(|v| v.as_u64()),
            Some(2)
        );
        let members = batch
            .extra
            .get("batchMembers")
            .and_then(|v| v.as_array())
            .unwrap();
        assert!(
            members
                .iter()
                .all(|m| m.get("toolName").and_then(|v| v.as_str()) != Some("complete_task")),
            "suppressed tools must not be batch members: {members:?}"
        );
    }

    /// 自审修复 D2（契约 §4.2「若 summary 未曾流式输出」）：模型先把总结作为
    /// 正文流式输出、再调 complete_task 提交同一段文字 → 不得整段补发第二份。
    #[tokio::test]
    async fn complete_task_summary_identical_to_streamed_text_is_not_resent() {
        let summary = "## 完成\n改动已落地，测试全绿。";
        // 正文先逐段流式输出同一段总结（含首尾空白差异，判重按 trim 口径）
        let text_delta = |t: &str| {
            format!(
                "data: {}\n\n",
                serde_json::json!({"choices":[{"delta":{"content":t}}]})
            )
        };
        let resp = format!(
            "{SSE_HDR}{}{}{}{SSE_FINISH_TOOLS}{SSE_DONE}",
            text_delta("## 完成\n"),
            text_delta("改动已落地，测试全绿。"),
            sse_tool_call(
                0,
                "ct-dup",
                "complete_task",
                &serde_json::json!({"summary": summary})
            )
        );
        let (result, frames) = run_complete_task_scenario(vec![resp], "ct-dup").await;
        assert_eq!(result.stop_reason, StopReason::Completed);
        assert_eq!(result.final_answer, summary);
        // 整段 summary 的 text 帧不得出现（正文已逐 token 流式交付）。
        assert!(
            !frames
                .iter()
                .any(|f| f.frame_type == "text" && f.text.as_deref() == Some(summary)),
            "summary identical to streamed content must not be re-emitted as a whole text frame"
        );
        assert!(frames.iter().any(|f| f.frame_type == "done"));
    }

    /// 自审修复 D2（对照）：summary 与已流式正文不同（扩写）→ 仍整段补发，
    /// 宁可多一段也不丢模型钦定的最终交付。
    #[tokio::test]
    async fn complete_task_summary_different_from_streamed_text_is_emitted() {
        let streamed = "改完了。";
        let summary = "## 完成\n改动已落地，测试全绿，另有遗留事项见下。";
        let text_delta = format!(
            "data: {}\n\n",
            serde_json::json!({"choices":[{"delta":{"content":streamed}}]})
        );
        let resp = format!(
            "{SSE_HDR}{text_delta}{}{SSE_FINISH_TOOLS}{SSE_DONE}",
            sse_tool_call(
                0,
                "ct-diff",
                "complete_task",
                &serde_json::json!({"summary": summary})
            )
        );
        let (result, frames) = run_complete_task_scenario(vec![resp], "ct-diff").await;
        assert_eq!(result.stop_reason, StopReason::Completed);
        assert!(
            frames
                .iter()
                .any(|f| f.frame_type == "text" && f.text.as_deref() == Some(summary)),
            "a summary that extends the streamed text must still be delivered"
        );
    }

    /// 自审修复（HITL 互斥回执）：同批 bash 触发 HITL 审批挂起 + complete_task 时，
    /// complete_task 不执行但必须补互斥错误回执入史——否则恢复回放把孤儿调用填成
    /// INTERRUPTED_MARKER（「任务中断…请勿重复执行」），模型收到的语义错位。
    #[tokio::test]
    async fn complete_task_gets_conflict_receipt_when_batch_hitl_suspends() {
        let resp = format!(
            "{SSE_HDR}{}{}{SSE_FINISH_TOOLS}{SSE_DONE}",
            sse_tool_call(
                0,
                "bash-hitl",
                "bash",
                &serde_json::json!({"command":"rm -rf node_modules"})
            ),
            sse_tool_call(
                1,
                "ct-hitl",
                "complete_task",
                &serde_json::json!({"summary":"收尾。"})
            )
        );
        let port = scripted_mock(vec![resp]).await;
        let mut config = corruption_itest_config(port, "ct-hitl", 6);
        config.access_mode = "default".into(); // 触发 bash HITL 审批
        config.hitl_approved = false;
        let registry = std::sync::Arc::new(crate::tools::ToolRegistry::default_registry());
        let agent = ReActAgent::new(registry);
        let (frame_tx, mut frame_rx) = tokio::sync::mpsc::unbounded_channel();
        let cancel = tokio_util::sync::CancellationToken::new();
        let history = vec![ChatMessage::system("sys"), ChatMessage::user("do the work")];
        let run = agent.run(&config, history, frame_tx, cancel);
        let collector = tokio::spawn(async move {
            let mut frames = Vec::new();
            while let Some(f) = frame_rx.recv().await {
                frames.push(f);
            }
            frames
        });
        let result = run.await;
        let _frames = collector.await.unwrap();
        assert_eq!(
            result.stop_reason,
            StopReason::SuspendedHitl,
            "bash 必须触发 HITL 挂起"
        );
        let receipt = result
            .messages
            .iter()
            .find(|m| m.tool_call_id.as_deref() == Some("ct-hitl"));
        let receipt =
            receipt.expect("complete_task 必须有配对回执（否则恢复后孤儿调用 400/被填中断标记）");
        assert_eq!(
            receipt.content_text(),
            COMPLETE_TASK_WITH_ASK_ERROR,
            "回执必须是互斥错误文案，而非 INTERRUPTED_MARKER"
        );
    }

    /// 契约 §4.2：同批含 ask_user 时 complete_task 返回错误、不结束；ask_user 照常挂起。
    #[tokio::test]
    async fn complete_task_with_ask_user_in_batch_errors_and_suspends() {
        // complete_task 排在 index 0，ask_user 排在 index 1：验证批尾重排后
        // ask_user 先执行、complete_task 被互斥拒绝。
        let resp = format!(
            "{SSE_HDR}{}{}{SSE_FINISH_TOOLS}{SSE_DONE}",
            sse_tool_call(
                0,
                "ct-x",
                "complete_task",
                &serde_json::json!({"summary":"done"})
            ),
            sse_tool_call(
                1,
                "ask-x",
                "ask_user",
                &serde_json::json!({"questions":[{"header":"选哪个？","options":[{"label":"A"}]}]})
            )
        );
        let (result, frames) = run_complete_task_scenario(vec![resp], "ct-ask").await;
        // ask_user 挂起 → 整个 run 以 SuspendedQuestion 结束，而非 Completed。
        assert_eq!(result.stop_reason, StopReason::SuspendedQuestion);
        assert_ne!(
            result.final_answer, "done",
            "complete_task must NOT end the run"
        );
        // complete_task 的互斥错误回执入史（配对完整）。
        assert!(
            result
                .messages
                .iter()
                .any(|m| m.tool_call_id.as_deref() == Some("ct-x")
                    && m.content_text().contains("不能同时提交完成")),
            "complete_task must get the mutual-exclusion error result"
        );
        // ask_user 的 question 帧照常发。
        assert!(frames.iter().any(|f| f.frame_type == "question"));
    }

    /// 契约 §4.2：同批 read + complete_task → complete_task 批尾执行，read 结果先入史。
    #[tokio::test]
    async fn complete_task_runs_last_in_a_mixed_batch() {
        let tmp = std::env::temp_dir().join(format!("gwork-ct-batch-{}.txt", std::process::id()));
        std::fs::write(&tmp, b"hello").unwrap();
        let resp = format!(
            "{SSE_HDR}{}{}{SSE_FINISH_TOOLS}{SSE_DONE}",
            sse_tool_call(
                0,
                "ct-b",
                "complete_task",
                &serde_json::json!({"summary":"收尾"})
            ),
            sse_tool_call(
                1,
                "rd-b",
                "read",
                &serde_json::json!({"file_path": tmp.to_string_lossy()})
            )
        );
        let (result, _frames) = run_complete_task_scenario(vec![resp], "ct-batch").await;
        assert_eq!(result.stop_reason, StopReason::Completed);
        assert_eq!(result.final_answer, "收尾");
        // read 与 complete_task 的 tool result 都入史（配对完整）。
        assert!(result
            .messages
            .iter()
            .any(|m| m.tool_call_id.as_deref() == Some("rd-b")));
        assert!(result
            .messages
            .iter()
            .any(|m| m.tool_call_id.as_deref() == Some("ct-b")));
        let _ = std::fs::remove_file(&tmp);
    }
}

/// A persisted suspension point, allowing the run to resume after user input.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SuspensionPoint {
    pub session_id: String,
    pub run_id: String,
    pub kind: String, // "question" | "hitl"
    pub next_seq: i64,
    pub access_mode: String,
    pub model_name: String,
    /// The pending command for HITL.
    pub pending_command: Option<String>,
    /// The timeout the model requested for the pending HITL command. `None` on
    /// suspensions written by older kernels (serde default) → approval falls
    /// back to the historical ceiling.
    #[serde(default)]
    pub pending_timeout_ms: Option<u64>,
    /// Whether the pending HITL command was requested in background. Defaults to
    /// false for older suspensions, preserving their synchronous approval path.
    #[serde(default)]
    pub pending_background: bool,
    /// The tool call id that triggered the suspension.
    pub action_id: Option<String>,
    /// The tool_call_id needing a `tool` role response on resume.
    #[serde(default)]
    pub pending_tool_call_id: Option<String>,
    /// Serialized message history (JSON array of ChatMessage).
    pub messages_json: String,
    pub created_at: i64,
}
