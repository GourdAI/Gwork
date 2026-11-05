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
use crate::tools::{ToolContext, ToolRegistry};

/// Wall clock in epoch milliseconds.
fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Minimum gap between two `action_args` progress frames for one tool call
/// (Java `ReasonTask.ARGS_PROGRESS_INTERVAL_MS`).
pub const ARGS_PROGRESS_INTERVAL_MS: i64 = 200;

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
        Self { bytes: 0, last_emit_bytes: 0, last_emit_at: now }
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
}

/// Time to first token (ms) from the run's start to the first visible model output.
///
/// **Pure** so the whole timing contract is table-testable without a wall clock.
/// `None` means the run never produced a visible content/reasoning delta, which is
/// deliberately different from a real 0 ms first token (Java `TurnTimer.finish`:
/// `ttftMs` stays null when `firstVisibleNanos == null`). `saturating_duration_since`
/// guards against an implausible out-of-order pair instead of panicking/underflowing.
fn ttft_ms_since(started_at: std::time::Instant, first_visible: Option<std::time::Instant>) -> Option<u64> {
    let first = first_visible?;
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
        let mut result = self.run_inner(config, history, frame_tx.clone(), cancel).await;

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
            StopReason::SuspendedQuestion | StopReason::SuspendedHitl => result
                .pending_tool_call_id
                .clone()
                .into_iter()
                .collect(),
            _ => Vec::new(),
        };
        // Scope the exemption to the LAST assistant(tool_calls) group: Gemini /
        // Ollama synthesise call ids like `gemini-call-0` per stream, so an older
        // orphan can reuse the exact id of the current pending call. Matching by
        // string across the whole history would exempt that older orphan too and
        // leave the resumed request with an unpaired tool_call (HTTP 400).
        let repaired = repair_tool_pairing_except_in_last_group(
            &mut result.messages,
            &suspended_call,
        );
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
        let client = crate::llm::LlmClient::with_retries(config.model.clone(), config.settings.general.api_retries);
        // One gate for the whole run: the caller's (a sub-agent whitelist) when
        // given, otherwise the user's global `disallowedTools`. Resolved once here
        // so the definitions sent to the model and the `execute` check cannot
        // disagree about what this run may call.
        let gate: Arc<crate::tools::ToolGate> = config.gate.clone().unwrap_or_else(|| {
            Arc::new(crate::tools::ToolGate::from_permission(&config.settings.permission))
        });
        // What a delegated sub-agent inherits from this run. Hoisted beside the
        // gate for the same reason: both are fixed for the whole run, while a
        // `ToolContext` is rebuilt for every tool call. Sharing one `Arc` keeps
        // that per-call cost at a refcount bump instead of deep-copying the
        // model credentials and the entire model registry each time.
        let run_model = Arc::new(config.model.clone());
        let run_settings = Arc::new(config.settings.clone());
        let tool_defs = self.registry.definitions_async(&config.settings.permission, Some(&gate)).await;
        // Fixed per-request overheads. Both count against the context window and
        // must be included in the compression budget, or the trigger fires late
        // (tool definitions alone run to thousands of tokens).
        let tools_tokens = crate::compress::estimate_tools_tokens(&tool_defs);
        let tools = if tool_defs.is_empty() { None } else { Some(tool_defs) };

        let mut messages = history;
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
        // Run-level latch for the FIRST visible output (Java TurnTimer.firstVisibleNanos).
        // This is deliberately SEPARATE from the per-attempt `first_content_at` below:
        // that one times a decode segment and is reset on a transport retry, whereas
        // TTFT is "how long the user waited to see the first character" and must not be
        // rewritten by a retry (the aborted attempt's deltas already reached the screen).
        let mut first_visible_at: Option<std::time::Instant> = None;

        // ── P2: retry/latency budget (Java's four caps, aligned 2026-10-31) ──
        // Java production incident work-mua28gy6: 34 retries burned 5 tiers of
        // backoff over 67.6 minutes with zero visible progress. Root cause:
        // timeout ≠ rejection — upstream already accepted the request and is
        // generating (and billing); retrying re-sends the full context, and a
        // larger context times out *more* easily: a positive feedback loop.
        // So timeout-class failures get their own ≤2-per-round allowance, and
        // the run's total retry time is capped regardless of failure class.
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
        // Cap 3: run-level retry deadline (Java `REASON_RETRY_TOTAL_DEADLINE =
        // 45min` on `RetryTask.totalDeadline`). Bounded with `Instant` so a
        // clock jump cannot extend or fake-expire it (same reason the D-1
        // await_tasks fix used nanoTime on the Java side).
        let retry_deadline = std::time::Instant::now()
            + std::time::Duration::from_secs(RUN_RETRY_DEADLINE_SECS);
        // Timeout-bucket counter, reset every round (Java counts per turn).
        let mut timeout_retries = 0u32;
        // Mutable: AutoRethink extends the ceiling as the run progresses
        // (Java `ReActOptions.addMaxTurns`). `initial` is kept for the extension
        // step size, which Java derives from it.
        let initial_max_turns = config.max_turns.max(1);
        let mut max_turns = initial_max_turns;
        let mut seq = config.start_seq;
        let started_at = std::time::Instant::now();
        // Loop detection (Java `StopLoopInterceptor`, aligned 2026-10-31).
        //
        // The old form compared only the *previous* fingerprint byte-for-byte,
        // so it required four consecutive byte-identical rounds to fire —
        // measured on real long runs: 0 triggers in 7h21m of logs. Real model
        // arguments drift every round (different file, longer todo list), so a
        // strict-equality detector is structurally blind. The windowed form
        // below catches A-B-A-B alternation and, with canonicalised arguments,
        // key-order/whitespace-only differences.
        let mut loop_window: std::collections::VecDeque<String> =
            std::collections::VecDeque::with_capacity(LOOP_WINDOW as usize);
        let mut loop_reminders = 0u32;
        // Turns of genuinely varied work since the last loop reminder. Used to
        // forgive `loop_reminders` once the model has demonstrably broken out.
        let mut productive_turns = 0u32;

        // P1: consecutive turns where the model returned neither text nor tool
        // calls. An empty round can never be progress; silently treating it as
        // "completed" ended runs with an empty final answer and no explanation
        // (the other half of the "long task ends wrong" symptom).
        let mut empty_rounds = 0u32;

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
        // effectively never fires. The loop cap is forgiven after
        // `PRODUCTIVE_TURNS_TO_FORGIVE` varied turns. A model doing varied but
        // useless work therefore extends indefinitely and only the user's Stop
        // ends it. That is the deliberate trade, and it matches Java: the
        // attempt to bound this by output volume is exactly what killed healthy
        // runs, and a wrong bound costs more than no bound.

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
        let compress_cfg = crate::compress::CompressionConfig::from_settings(&config.settings.general);
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
            turns += 1;

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
                    if context_exhausted || loop_reminders >= MAX_LOOP_REMINDERS {
                        let reason = if context_exhausted {
                            "context window exhausted"
                        } else {
                            "repeated unproductive tool calls"
                        };
                        let msg = format!(
                            "Stopped after {} turns ({}); the task may be incomplete. \
                             Starting a new session, or lowering the retained history, will give it room to continue.",
                            turns.saturating_sub(1), reason
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
                let msg = format!("Reached maximum turns ({}). Task may be incomplete.", max_turns);
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
            emit!(Frame::reason_start(&config.session_id, config.turn_start_ms));

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
                    pending_tool_call_id: None,
                    };
                }
            };

            // Accumulate the response
            let mut content_buf = String::new();
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
            // Start of the first visible model output in this stream; the decode
            // segment is [first_content_at, usage settlement]. None until a real
            // content/reasoning delta arrives (Java TurnTimer.onVisibleOutput).
            let mut first_content_at: Option<std::time::Instant> = None;
            let mut idle_expired = false;
            let mut total_expired = false;
            // Per-tool-call argument-progress throttle state, keyed by stream
            // index (Java keys by `toolCallKey`, which is the same index).
            let mut args_progress: HashMap<u32, ArgsProgress> = HashMap::new();
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
                            pending_command: None,
                            pending_tool_call_id: None,
                        };
                    }
                };
                match event {
                    StreamEvent::ContentDelta(delta) => {
                        content_buf.push_str(&delta);
                        let now = std::time::Instant::now();
                        if first_content_at.is_none() {
                            first_content_at = Some(now);
                        }
                        // Only visible text/thinking arms TTFT (Java onVisibleOutput).
                        // Tool-call frames are NOT visible characters and must not latch it.
                        if first_visible_at.is_none() {
                            first_visible_at = Some(now);
                        }
                        emit!(Frame::text_delta(&config.session_id, &delta));
                    }
                    StreamEvent::ReasoningDelta(delta) => {
                        emit!(Frame::reason(&config.session_id, &delta));
                        let now = std::time::Instant::now();
                        if first_content_at.is_none() {
                            first_content_at = Some(now);
                        }
                        if first_visible_at.is_none() {
                            first_visible_at = Some(now);
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
                        if !id.is_empty() && !name.is_empty() {
                            args_progress.insert(
                                index,
                                ArgsProgress::new(now_ms()),
                            );
                            emit!(Frame::action_draft(&config.session_id, &name, &id));
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
                            if let Some(p) = args_progress.get_mut(&index) {
                                p.bytes = bytes;
                                if p.should_emit(now_ms()) {
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
                    StreamEvent::Retry { attempt, max, reason } => {
                        // The transport gave up on a stream that had *already*
                        // delivered deltas and is re-issuing the same request.
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
                        tool_calls.clear();
                        // A transport retry discards the partial deltas: the timed
                        // decode segment of the aborted attempt must start over too.
                        first_content_at = None;
                        args_progress.clear();
                        // The retry restarts the round's clock: the new attempt
                        // is a fresh stream, and measuring the idle/total caps
                        // against the aborted one would trip them immediately.
                        last_chunk_at = std::time::Instant::now();
                        emit!(Frame::stream_retry(&config.session_id, attempt, max, &reason));
                    }
                    StreamEvent::Done { finish_reason: fr, usage } => {
                        finish_reason = fr;
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
                                    ttft_ms: ttft_ms_since(started_at, first_visible_at),
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
                    // Deterministic errors (de-listed model, bad key, 4xx)
                    // must surface immediately: the client already refused to
                    // retry them internally, and looping here would only burn
                    // max_turns × 2s showing a spinner that can never succeed.
                    let fatal = crate::llm::client::is_non_retryable(&err);
                    let timeout_class = crate::llm::client::is_timeout_class(&err);
                    // P2 cap 4: timeout-class failures ≤2 per round (Java:
                    // “连续两次都超时说明是系统性原因，第三次同样会超时”).
                    // AutoRethink keeps `turns < max_turns` permanently true,
                    // so without this bucket an upstream outage retries forever
                    // — the work-mua28gy6 shape.
                    //
                    // Cap 3: the run's whole retry budget. Any failure class.
                    // `Instant`-based, so a wall-clock jump cannot fake-extend it.
                    let timeout_out = timeout_class && timeout_retries >= MAX_TIMEOUT_RETRIES_PER_TURN;
                    let deadline_out = std::time::Instant::now() > retry_deadline;
                    if !fatal && !timeout_out && !deadline_out && turns < max_turns {
                        if timeout_class {
                            timeout_retries += 1;
                        }
                        emit!(Frame::retry(&config.session_id, turns, max_turns, &err));
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
                                "{}\nThe run's retry budget of {} minutes is exhausted; stopping \
                                 instead of retrying. Resend the message to start a fresh budget.",
                                err, RUN_RETRY_DEADLINE_SECS / 60
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
                    let fatal = crate::llm::client::is_non_retryable(&err);
                    let timeout_class = crate::llm::client::is_timeout_class(&err);
                    let timeout_out =
                        timeout_class && timeout_retries >= MAX_TIMEOUT_RETRIES_PER_TURN;
                    let deadline_out = std::time::Instant::now() > retry_deadline;
                    if !fatal && !timeout_out && !deadline_out && turns < max_turns {
                        if timeout_class {
                            timeout_retries += 1;
                        }
                        // Discard before signalling, so the retry frame is the
                        // only thing left on screen from this attempt.
                        content_buf.clear();
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
                            turns,
                            max_turns,
                            &err
                        ));
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
                if converge_pending && converge_deferred < MAX_CONVERGE_DEFERRALS && !answer.is_empty() {
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
                    messages.push(ChatMessage::user(completion_check_prompt(converge_deferred)));
                    // Stays armed: the next text-only reply is gated too, until
                    // the cap is reached.
                    continue;
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
                    pending_tool_call_id: None,
                };
            }

            // Loop detection (Java `StopLoopInterceptor`, aligned 2026-10-31):
            // windowed frequency over canonicalised fingerprints, not strict
            // equality with the previous round. See the state declaration above
            // for why the old form was structurally blind.
            let fingerprint = loop_fingerprint(&tool_calls, &content_buf);
            if let Some(fp) = fingerprint.as_deref() {
                loop_window.push_back(fp.to_string());
                while loop_window.len() > LOOP_WINDOW as usize {
                    loop_window.pop_front();
                }
                let repeats_in_window =
                    loop_window.iter().filter(|f| f.as_str() == fp).count() as u32;
                if repeats_in_window >= LOOP_REMINDER_THRESHOLD {
                    // Soft reminder, not a hard stop (Java `StopLoopInterceptor`).
                    //
                    // This used to abort the run with an error frame. A repeated
                    // call is evidence of a bad strategy, not of a broken agent:
                    // killing the run discards everything it had accomplished and
                    // leaves the user with nothing. Java injects a self-correction
                    // prompt and lets the model break out on its own.
                    //
                    // The wording must not say "output your Final Answer now".
                    // That phrasing is precisely what made the model treat a
                    // transitional intent declaration as the final answer
                    // (work-mupc5nd0). It suggests a different angle and leaves
                    // convergence to the model plus the gate armed below.
                    loop_reminders += 1;
                    warn!(
                        session = %config.session_id,
                        repeats = repeats_in_window,
                        reminders = loop_reminders,
                        "loop detected, injecting self-correction prompt"
                    );
                    messages.push(ChatMessage::user(loop_detected_prompt(repeats_in_window)));
                    converge_pending = true;
                    // Clear the window so the injected message is not itself
                    // counted as another repeat (Java `history.clear()`).
                    loop_window.clear();
                    productive_turns = 0;
                } else {
                    productive_turns += 1;
                    // Forgive past reminders once the model has clearly moved on.
                    //
                    // Without this, `loop_reminders` only ever grows, so a long task
                    // that hits three *separate* dead ends across fifty turns —
                    // ordinary trial-and-error while debugging — gets stopped even
                    // though the model recovered every time. That would replace the
                    // old "dies at turn 20" failure with a new "dies after the third
                    // stumble" one. Java's interceptor clears its window after each
                    // reminder for the same reason: a reminder is a fresh start, not
                    // a strike.
                    //
                    // The threshold keeps the safety net real: a model that ignores
                    // the reminder and immediately repeats never accumulates enough
                    // productive turns to reset, so it still stops at the cap.
                    if productive_turns >= PRODUCTIVE_TURNS_TO_FORGIVE && loop_reminders > 0 {
                        info!(
                            session = %config.session_id,
                            reminders_forgiven = loop_reminders,
                            "model broke out of the loop; resetting loop-reminder budget"
                        );
                        loop_reminders = 0;
                        productive_turns = 0;
                    }
                }
            } else {
                // Fingerprint unavailable (unparseable arguments): this round
                // participates in neither detection nor forgiveness, matching
                // Java's "宁漏匆误判" policy.
                productive_turns += 1;
            }

            // Add the assistant message with tool_calls to history
            let assistant_msg = ChatMessage {
                role: Role::Assistant,
                content: if content_buf.is_empty() { None } else { Some(crate::llm::MessageContent::Text(content_buf.clone())) },
                tool_calls: Some(tool_calls.clone()),
                tool_call_id: None,
                name: None,
            };
            messages.push(assistant_msg);

            // If multiple tool calls, emit a batch declaration
            if tool_calls.len() > 1 {
                let batch_id = format!("batch-{}", &config.run_id);
                let members: Vec<serde_json::Value> = tool_calls
                    .iter()
                    .enumerate()
                    .map(|(i, tc)| {
                        serde_json::json!({
                            "actionId": tc.id,
                            "index": i,
                            "toolName": tc.function.name,
                        })
                    })
                    .collect();
                emit!(Frame::action_batch(&config.session_id, &batch_id, members));
            }

            // Execute each tool call
            for (tc_index, tc) in tool_calls.iter().enumerate() {
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
                        pending_tool_call_id: None,
                    };
                }

                let args: serde_json::Value = serde_json::from_str(&tc.function.arguments)
                    .unwrap_or(serde_json::json!({}));

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
                if let Some(p) = args_progress.remove(&(tc_index as u32)) {
                    if p.bytes > p.last_emit_bytes {
                        emit!(Frame::action_args(&config.session_id, &tc.id, p.bytes));
                    }
                }

                // Emit action_start with full args
                emit!(Frame::action_start(
                    &config.session_id,
                    &tc.function.name,
                    &tc.id,
                    args.clone()
                ));

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
                    cancel: cancel.clone(),
                    hitl_approved: config.hitl_approved,
                    change_ledger: config.change_ledger.clone(),
                    // Raw configured literals, resolved at judgement time so `~`
                    // and environment variables follow runtime changes (Java
                    // `HitlStrategy.java:492`).
                    bash_exempt_dirs: config.settings.permission.bash_exempt_dirs.clone(),
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
                        emit!(Frame::action_end_failed(
                            &config.session_id,
                            &tc.function.name,
                            &tc.id,
                            "Cancelled by user",
                        ));
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
                            pending_tool_call_id: None,
                        };
                    }
                    output = self.registry.execute(&tc.function.name, args, &tool_ctx) => output,
                };
                let _duration_ms = started.elapsed().as_millis() as u64;

                // Check for suspension
                if let Some(suspend) = &output.suspend {
                    match suspend.kind {
                        crate::tools::SuspendKind::Question => {
                            // Question frame already emitted by the tool.
                            emit!(Frame::done_suspended(&config.session_id));
                            return ReActResult {
                                final_answer: String::new(),
                                turns_used: turns,
                                usage: total_usage,
                                stop_reason: StopReason::SuspendedQuestion,
                                next_seq: seq,
                                messages,
                                pending_command: None,
                                pending_tool_call_id: Some(tc.id.clone()),
                            };
                        }
                        crate::tools::SuspendKind::Hitl => {
                            emit!(Frame::done_suspended(&config.session_id));
                            return ReActResult {
                                final_answer: String::new(),
                                turns_used: turns,
                                usage: total_usage,
                                stop_reason: StopReason::SuspendedHitl,
                                next_seq: seq,
                                messages,
                                pending_command: suspend.command.clone(),
                                pending_tool_call_id: Some(tc.id.clone()),
                            };
                        }
                    }
                }

                // Emit action_end frame (with result preview for the stream)
                let result_preview: String = output.text.chars().take(2000).collect();
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
                let observation = crate::compress::sanitise_observation(&output.text, observation_cap);
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

/// How many rounds back the loop-detection window reaches (Java
/// `StopLoopInterceptor` default `windowSize = 8`). The window, not strict
/// equality with the previous round, is what catches A-B-A-B alternation.
const LOOP_WINDOW: usize = 8;

/// How many identical fingerprints inside [`LOOP_WINDOW`] trigger a loop
/// reminder (Java `maxRepeatCount = 3`). Not necessarily consecutive.
const LOOP_REMINDER_THRESHOLD: u32 = 3;

/// Cap on loop reminders per run.
///
/// A reminder that does not change the model's behaviour will not change it the
/// fourth time either; past this the run is genuinely stuck and the turn-budget
/// branch stops it with an honest message instead of burning tokens forever.
///
/// Counted *since the last forgiveness* (see `PRODUCTIVE_TURNS_TO_FORGIVE`), not
/// over the whole run, so ordinary trial-and-error in a long task does not add up
/// to a stop.
const MAX_LOOP_REMINDERS: u32 = 3;

/// How many consecutive turns of varied tool calls prove the model has broken out
/// of a loop, earning a reset of the reminder budget.
///
/// Three matches `LOOP_REMINDER_THRESHOLD`: it takes as much sustained varied
/// work to earn forgiveness as it took repeated work to trigger the reminder.
const PRODUCTIVE_TURNS_TO_FORGIVE: u32 = 3;

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

/// P2: timeout-class failures allowed per round before the run stops
/// honestly. Java `ReasonTask` timeout bucket: “连续两次都超时说明是系统性
/// 原因，第三次同样会超时” — production evidence work-mua28gy6 (34 retries,
/// 67.6 minutes, zero progress).
const MAX_TIMEOUT_RETRIES_PER_TURN: u32 = 2;

/// P2: run-level retry budget in seconds. Java `REASON_RETRY_TOTAL_DEADLINE =
/// 45min`: the total wall-clock time a run may spend in retry/failure loops,
/// regardless of failure class. Bounded so no failure class can spin forever
/// under AutoRethink's ever-rising `turns < max_turns`.
const RUN_RETRY_DEADLINE_SECS: u64 = 45 * 60;

/// Loop fingerprint for one round, Java `StopLoopInterceptor` semantics:
/// canonicalised tool name + arguments (except NAME_ONLY_TOOLS, whose args
/// change every round by design), or a hash of the text prefix for a
/// text-only round.
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
            sb.push_str(&canonical_args(&tc.function.arguments)?);
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

/// Canonical argument string for fingerprinting: parse the JSON, sort keys,
/// truncate values to 120 chars. Key order and whitespace differences must
/// not produce different fingerprints; different `file_path` / `command`
/// values must (Java `canonicalArgsOf`).
fn canonical_args(raw: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let obj = match v {
        serde_json::Value::Object(m) => m,
        serde_json::Value::Null => return Some(String::new()),
        // Non-object payloads (string, number) still fingerprint by value.
        other => return Some(other.to_string()),
    };
    let mut keys: Vec<&String> = obj.keys().collect();
    keys.sort();
    let mut sb = String::new();
    for k in keys {
        if !sb.is_empty() {
            sb.push('|');
        }
        let val = match obj.get(k) {
            Some(serde_json::Value::Null) => "".to_string(),
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(other) => other.to_string(),
            None => String::new(),
        };
        let val: String = val.chars().take(120).collect();
        sb.push_str(k);
        sb.push('=');
        sb.push_str(&val);
    }
    Some(sb)
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

/// Completion-check prompt injected when the convergence gate defers an implicit
/// end (Java `completionCheckPromptFor`, wording kept identical).
///
/// Must offer **both** exits — continue if unfinished, full summary if finished.
/// An absolute "output your Final Answer now" is what caused the original bug:
/// the model complied literally with a one-line intent declaration and the run
/// ended with the work undone.
fn completion_check_prompt(deferred: u32) -> String {
    format!(
        "【系统提示：任务完成校验 (Completion Check)】\n\
         检测到您输出了不含任何工具调用的纯文本回复，但这可能只是过渡性意图声明而非最终回答。请核验：\n\
         1. **任务清单状态**：若仍有未完成事项（TODO / 计划未全部完成），请继续执行它们，不要停止；\n\
         2. **若确已全部完成**：请重新输出面向用户的完整总结报告（已完成内容、验证结果与遗留事项）作为最终回答，不要只写一句意图声明。\n\
         （第 {deferred}/{MAX_CONVERGE_DEFERRALS} 次校验，之后将按普通最终回答处理）"
    )
}

/// Loop-detected reminder (Java `StopLoopInterceptor`, wording kept identical).
///
/// Suggests a different angle only. It must not instruct the model to end the
/// task: that phrasing made the model emit a transitional intent declaration as
/// its final answer, so a Loop terminated "normally" with 0/10 TODOs done.
fn loop_detected_prompt(count: u32) -> String {
    format!(
        "【系统提示：检测到潜在循环 (Loop Detected)】\n\
         系统检测到您最近 {count} 次（连续 {count} 次相同）执行了高度相似的操作，可能存在\"原地打转\"的情况。\n\n\
         请立即暂停当前操作思路，审视历史 Observation 并执行以下步骤：\n\
         1. **有效性评估**：如果最近的尝试没有带来有效新线索，说明当前策略已失效，请必须更换思路或换个角度切入。\n\
         2. **避免重复**：不要重复执行已经执行过且未产生新信息的操作。\n\
         3. **任务完成校验**：若确认任务已全部完成，请给出面向用户的完整总结报告作为最终回答；若尚未完成，请继续执行未完成事项。"
    )
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
        text.push_str(&format!("\n[用户附带图片: {}]", item.image_paths.join(", ")));
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
            if tc.id.is_empty()
                || skip.iter().any(|id| id == &tc.id)
                || have.contains(&tc.id)
            {
                continue;
            }
            messages.insert(insert_at, ChatMessage::tool_result(&tc.id, INTERRUPTED_MARKER));
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::{FunctionCall, ToolCall};

    // ─── TTFT (time to first token) ─────────────────────────────────────────

    /// Java `TurnTimer.finish` parity: TTFT is "run start → first visible output",
    /// null when no visible output ever arrived (never a fabricated 0), and the
    /// FIRST latch wins — a later delta must not rewrite it.
    #[test]
    fn ttft_is_first_visible_delta_from_run_start() {
        let t0 = std::time::Instant::now();
        let at = |ms| t0 + std::time::Duration::from_millis(ms);
        assert_eq!(ttft_ms_since(t0, None), None, "no visible output ⇒ no TTFT");
        assert_eq!(ttft_ms_since(t0, Some(at(0))), Some(0), "instant first token is a real 0");
        assert_eq!(ttft_ms_since(t0, Some(at(1_690))), Some(1_690));
        assert_eq!(ttft_ms_since(t0, Some(at(5))), Some(5), "sub-10ms must not be rounded away");
        // Clock anomaly (first before start) must not underflow to a huge u64.
        assert_eq!(ttft_ms_since(at(9_000), Some(t0)), Some(0), "out-of-order pair clamps to 0");
    }

    /// The latch must be armed by ContentDelta AND ReasoningDelta only, and never
    /// reset by a transport retry (unlike `first_content_at`, whose decode segment
    /// legitimately restarts). A source-level pin: a pure-function test cannot see
    /// which event arm writes the run-level variable.
    #[test]
    fn ttft_latch_is_armed_only_by_visible_deltas_and_survives_retry() {
        let src = include_str!("mod.rs");
        let norm = src.replace("\r\n", "\n");
        // Only inspect PRODUCT code. The test module below quotes the very same
        // strings these assertions look for; searching the whole file would let a
        // test literal "prove" a wire that was removed from production (a source
        // guard that can never go red). Truncate at the first test module.
        let product = norm.split("#[cfg(test)]").next().unwrap_or("");
        // Both visible arms set the run-level latch (two occurrences).
        assert_eq!(
            product.matches("if first_visible_at.is_none() {\n                            first_visible_at = Some(now);").count(),
            2,
            "ContentDelta and ReasoningDelta must BOTH arm the TTFT latch"
        );
        // The retry branch resets the per-attempt decode segment but NOT the run latch.
        let retry = product.split("StreamEvent::Retry { attempt, max, reason } =>")
            .nth(1).unwrap_or("")
            .split("emit!(Frame::stream_retry").next().unwrap_or("");
        assert!(retry.contains("first_content_at = None;"), "retry must drop the aborted decode segment");
        assert!(!retry.contains("first_visible_at = None"),
            "retry must NOT reset TTFT: those deltas were already shown to the user");
        // Wire it into the meter frame.
        assert!(product.contains("ttft_ms: ttft_ms_since(started_at, first_visible_at)"),
            "context_size payload must carry the run-level TTFT");
    }

    fn call(id: &str, name: &str) -> ToolCall {
        ToolCall {
            id: id.to_string(),
            call_type: "function".into(),
            function: FunctionCall { name: name.into(), arguments: "{}".into() },
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
            run.contains("if matches!(result.stop_reason, StopReason::Error | StopReason::MaxTurns)"),
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
            done_in_inner == 5,
            "only the 4 cancel paths + completion should own a done; got {done_in_inner}"
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
        // Gemini / Ollama synthesise `gemini-call-0` per stream, so the very
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
        assert_eq!(repair_tool_pairing(&mut msgs), 0, "healthy history needs no repair");
        assert_eq!(msgs.len(), before.len());
        assert_eq!(msgs[3].content_text(), "ok", "existing results must not be touched");
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
        let ids: Vec<Option<String>> = msgs.iter().filter(|m| m.role == Role::Tool)
            .map(|m| m.tool_call_id.clone()).collect();
        assert_eq!(
            ids,
            vec![Some("b".into()), Some("a".into()), Some("c".into())],
            "existing result stays first, missing ones appended in declaration order"
        );
        assert_eq!(msgs[1].content_text(), "middle result", "real result must survive");
    }

    #[test]
    fn repair_is_idempotent() {
        let mut msgs = vec![assistant_calling(&[("c1", "bash")])];
        assert_eq!(repair_tool_pairing(&mut msgs), 1);
        assert_eq!(repair_tool_pairing(&mut msgs), 0, "second pass must be a no-op");
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
            let n = msgs.iter().filter(|m| m.tool_call_id.as_deref() == Some(id)).count();
            assert_eq!(n, 1, "{id} must have exactly one tool result");
        }
        // The c2 placeholder must sit before the following user message, keeping
        // the group contiguous.
        let c2 = msgs.iter().position(|m| m.tool_call_id.as_deref() == Some("c2")).unwrap();
        let user = msgs.iter().position(|m| m.content_text() == "next").unwrap();
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
            msgs.iter().filter(|m| m.tool_call_id.as_deref() == Some("c-ask")).count(),
            0,
            "suspended call must stay unrepaired so spawn_resume can inject the real answer"
        );
        assert_eq!(
            msgs.iter().filter(|m| m.tool_call_id.as_deref() == Some("c-dead")).count(),
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
        assert!(!p.contains("直接输出 Final Answer"), "must not force convergence");
        // It must still offer both exits, so a genuinely finished task can end.
        assert!(p.contains("若确认任务已全部完成"));
        assert!(p.contains("若尚未完成"));
    }

    #[test]
    fn completion_check_offers_both_exits() {
        let p = completion_check_prompt(1);
        assert!(p.contains("Completion Check"));
        assert!(p.contains("请继续执行它们"), "must allow continuing");
        assert!(p.contains("完整总结报告"), "must allow a real final answer");
        assert!(p.contains("1/2"), "must show the deferral counter");
        assert!(!p.contains("直接输出 Final Answer"));
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
        assert_eq!(MAX_LOOP_REMINDERS, 3);
        assert_eq!(LOOP_REMINDER_THRESHOLD, 3);
        assert_eq!(LOOP_WINDOW, 8, "Java StopLoopInterceptor windowSize");
        assert_eq!(MAX_EMPTY_ROUNDS, 3, "Java emptyRetryCounter cap");
    }

    // ─── P0: windowed loop fingerprint ─────────────────────────────────────

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
        // stagnat finds nothing. Keep this kernel aligned: the only things
        // allowed to bound AutoRethink are an exhausted context window and
        // the loop-reminder cap.
        let src = include_str!("mod.rs");
        // Scope to the loop body: the comment block explaining *why* these
        // names are gone, and this test itself, both mention them by design.
        let body = src
            .split("async fn run_inner")
            .nth(1)
            .and_then(|s| s.split("mod tests").next())
            .expect("run_inner body must be locatable");
        for banned in [
            "DIMINISHING_DELTA_TOKENS",
            "DIMINISHING_MIN_TURNS",
            "DIMINISHING_STOP_ROUNDS",
            "NO_PROGRESS_STOP_ROUNDS",
            "diminishing_rounds",
            "no_progress_rounds",
        ] {
            assert!(
                !body.contains(banned),
                "`{banned}` is back in the loop body: output volume must not \
                 gate the turn budget (killed healthy runs at turn 19)"
            );
        }
        assert!(
            body.contains("if context_exhausted || loop_reminders >= MAX_LOOP_REMINDERS"),
            "the extension point must gate on context exhaustion and the loop \
             cap only"
        );
        assert!(
            !body.contains("no observable progress"),
            "the stop reason that killed healthy runs must not come back"
        );
    }

    /// Name-based bans are not enough: the defect can be reintroduced under
    /// any identifier (mutation N1 added a bare `|| turns >= 10` and survived
    /// the ban list). Pin the *shape* instead — the extension-point condition
    /// must be exactly the two allowed terms, so any extra disjunct fails
    /// regardless of how it is spelled.
    #[test]
    fn extension_point_condition_has_exactly_two_allowed_terms() {
        let src = include_str!("mod.rs");
        let marker = "let threshold = (max_turns - 1).max((max_turns as f64 * 0.8) as u32);";
        let after = src
            .split(marker)
            .nth(1)
            .expect("AutoRethink threshold computation must exist");
        let cond = after
            .split_once("if turns >= threshold {")
            .and_then(|(_, rest)| rest.split_once('{'))
            .map(|(head, _)| head.trim().to_string())
            .expect("the extension point must guard on `turns >= threshold`");
        assert_eq!(
            cond, "if context_exhausted || loop_reminders >= MAX_LOOP_REMINDERS",
            "the early-stop condition at the AutoRethink extension point must \
             stay exactly these two terms. Java extends unconditionally here \
             (`ReasonTask.java:500-528`); every extra disjunct added to this \
             line so far has stopped healthy runs."
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
    /// round's timeout counter, and whether the run deadline is past, decide
    /// retry vs stop. Mirrors the loop body's `!fatal && !timeout_out &&
    /// !deadline_out && turns < max_turns` exactly — the lesson from the D-1
    /// round: Windows timer granularity makes wall-clock tests flaky, so the
    /// decision logic is table-driven and the loop only threads state in.
    fn retry_gate(fatal: bool, timeout_class: bool, timeout_retries: u32, deadline_out: bool) -> bool {
        let timeout_out = timeout_class && timeout_retries >= MAX_TIMEOUT_RETRIES_PER_TURN;
        !fatal && !timeout_out && !deadline_out
    }

    #[test]
    fn p2_retry_gate_lets_transient_failures_retry() {
        assert!(retry_gate(false, false, 0, false), "generic transient: retry");
        assert!(retry_gate(false, true, 0, false), "first timeout: retry");
        assert!(retry_gate(false, true, 1, false), "second timeout: retry");
    }

    #[test]
    fn p2_retry_gate_stops_deterministic_immediately() {
        assert!(!retry_gate(true, false, 0, false), "fatal never retries");
        assert!(!retry_gate(true, true, 2, true), "fatal overrides everything");
    }

    #[test]
    fn p2_retry_gate_buckets_timeouts_at_two() {
        // work-mua28gy6: the third identical timeout is guaranteed to fail the
        // same way — the bucket must cut the loop exactly at the cap.
        assert!(!retry_gate(false, true, 2, false), "third timeout-class: stop");
        assert!(!retry_gate(false, true, 5, false), "way past cap: stop");
        // The bucket is *timeout-only*: a round of generic 5xx retries must not
        // consume the timeout allowance.
        assert!(retry_gate(false, false, 5, false), "generic retries don't touch the timeout bucket");
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
        let body = src.split("P2: if the stream expired idle/total").nth(1).unwrap_or("");
        let body = body.split("// Filter out empty tool calls").next().unwrap_or(body);
        let norm = body.replace("\r\n", "\n");
        assert!(
            norm.contains("let timeout_out = timeout_class && timeout_retries >= MAX_TIMEOUT_RETRIES_PER_TURN;"),
            "timeout bucket must gate the retry (M-pin: bucket removed → infinite timeout retries)"
        );
        assert!(
            norm.contains("let deadline_out = std::time::Instant::now() > retry_deadline;"),
            "run deadline must gate the retry (M-pin: deadline removed → any-class infinite retry)"
        );
        assert!(
            norm.contains("if !fatal && !timeout_out && !deadline_out && turns < max_turns"),
            "all three gates must gate together (M-pin: dropped conjunct)"
        );
        assert!(
            norm.contains("Timeout-class failures happened"),
            "the honest stop message must explain the timeout bucket"
        );
        assert!(
            norm.contains("retry budget of {} minutes is exhausted"),
            "the honest stop message must explain the run deadline"
        );
    }

    #[test]
    fn p2_timeout_bucket_resets_after_a_healthy_round() {
        let src = include_str!("mod.rs");
        let body = src.split("A round that reached the model").nth(1).unwrap_or("");
        let body = body.split("// Filter out empty tool calls").next().unwrap_or(body);
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
        let body = body.split("let elapsed = started_at.elapsed()").next().unwrap_or(body);
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
            norm.trim_end().ends_with("continue;") || norm.contains("));\n                    continue;"),
            "the gate must `continue` the loop, never fall through to done (M8-class pin)"
        );
    }

    /// P3: notices must be drained at the top of every reasoning turn, as user
    /// messages, arming the converge gate (a notice can change what "done" means).
    #[test]
    fn p3_notices_drain_at_the_top_of_each_turn() {
        let src = include_str!("mod.rs");
        let body = src.split("P3: background completion notices").nth(1).unwrap_or("");
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
        let body = src.split("P2: measure idle against the last").nth(1).unwrap_or("");
        let body = body.split("StreamEvent::ContentDelta").next().unwrap_or(body);
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
        let recv = src.split("ev = rx.recv() => match ev {").nth(1).unwrap_or("");
        let recv = recv.split("None => break,").next().unwrap_or(recv);
        assert!(
            recv.contains("last_chunk_at = std::time::Instant::now();"),
            "receiving ANY event must reset the idle clock (M-pin: removed → long thinking times out)"
        );
        // ...and must NOT be duplicated back into a single variant arm: a reset
        // only on ContentDelta would leave reasoning/tool-args streams unwatched.
        let cd = src.split("StreamEvent::ContentDelta(delta) => {").nth(1).unwrap_or("");
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
            body.replace("\r\n", "\n").contains("stop_reason: StopReason::Error"),
            "past MAX_EMPTY_ROUNDS the run must stop with Error, never Completed"
        );
    }

    /// The windowed detector must catch A-B-A-B alternation — the shape the
    /// old compare-with-previous-round form was structurally blind to.
    #[test]
    fn windowed_detector_catches_abab() {
        let fa = loop_fingerprint(&[tc("read", r#"{"path":"a.rs"}"#)], "").unwrap();
        let fb = loop_fingerprint(&[tc("read", r#"{"path":"b.rs"}"#)], "").unwrap();
        let mut window: std::collections::VecDeque<String> =
            std::collections::VecDeque::with_capacity(LOOP_WINDOW);
        let mut fired = 0;
        for fp in [fa.clone(), fb.clone(), fa.clone(), fb.clone(), fa.clone(), fb.clone()] {
            window.push_back(fp.clone());
            while window.len() > LOOP_WINDOW {
                window.pop_front();
            }
            if window.iter().filter(|f| **f == fp).count() as u32 >= LOOP_REMINDER_THRESHOLD {
                fired += 1;
                window.clear();
            }
        }
        assert!(fired >= 1, "A-B-A-B alternation must trigger the reminder");
    }

    // ─── P1: empty response prompt ─────────────────────────────────────────

    #[test]
    fn empty_response_prompt_offers_both_exits_and_counts() {
        let p = empty_response_prompt(12, 2);
        assert!(p.contains("空响应"));
        assert!(p.contains("2/3"), "must show the retry counter");
        assert!(p.contains("回溯任务目标"), "reflection body (Java :712-719)");
        assert!(p.contains("工具调用"), "must ask for an action OR an answer");
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
        assert!(!raw.contains("uploads/"), "paths belong in their own fields");
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
        assert_eq!(rest.len(), 1, "a cancelled steer must not survive in the queue");
        assert_eq!(rest[0].content, "typed earlier");

        // …and the plain item is untouched either way: it is the frontend's to send.
        std::fs::remove_dir_all(&dir).ok();

        let dir = std::env::temp_dir().join(format!("gwork-settle2-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let qm = crate::queue::QueueManager::new();
        qm.add(&dir, "late steer".into(), vec!["u/i.png".into()], vec![], Some("s-2".into()));
        qm.add(&dir, "plain".into(), vec![], vec![], None);

        // requeue = true (normal end): the frame must not arrive before the item is
        // back on disk, because the frontend refreshes its badge from this frame.
        let back = settle_steers(&qm, &dir, "run-2", true);
        assert_eq!(back.len(), 1);
        let after = qm.list(&dir);
        assert_eq!(after.len(), 2, "the dropped steer must be durably re-queued");
        let requeued = after.iter().find(|m| m.origin_steer_id.as_deref() == Some("s-2")).unwrap();
        assert_eq!(requeued.content, "late steer", "content must survive the hand-back");
        assert_eq!(requeued.image_paths, vec!["u/i.png".to_string()], "attachments too");

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
        let mut done_seen = 0usize;
        for (i, line) in body.lines().enumerate() {
            if line.contains("emit!(Frame::done(") {
                done_seen += 1;
                let window: String = body.lines().skip(i.saturating_sub(3)).take(3).collect::<Vec<_>>().join("\n");
                assert!(
                    window.contains("steer_exit!("),
                    "`done` at react line ~{i} has no steer settlement before it"
                );
            }
        }
        assert_eq!(
            done_seen, 5,
            "3 boundary cancel paths + the in-flight-tool cancel + completion emit `done`"
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
            assert!(threshold <= max_turns, "initial={initial} threshold={threshold}");
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
            body.contains("output = self.registry.execute(&tc.function.name, args, &tool_ctx) => output"),
            "the tool call must be one arm of the select that races cancellation"
        );
        // Deterministic winner when both arms are ready.
        assert!(body.contains("biased;"), "cancel must win the race deterministically");
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
        assert!(!p.should_emit(1_199), "one ms short of the interval must not emit");
        assert!(p.should_emit(1_200), "exactly one interval must emit");
    }

    #[test]
    fn the_time_threshold_fires_on_a_slow_trickle() {
        // A model dribbling bytes must still show movement, or the card looks
        // frozen even though the run is alive.
        let mut p = ArgsProgress::new(0);
        p.bytes = 10;
        assert!(!p.should_emit(100), "under both thresholds");
        assert!(p.should_emit(200), "time threshold reached with only 10 bytes");
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
        assert!(p.should_emit(1), "byte threshold fires well inside the interval");
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
        assert!(emitted > 10, "progress must still be visible, got {}", emitted);
    }

    #[test]
    fn saturating_arithmetic_survives_a_backwards_clock() {
        // A skewed or non-monotonic clock must not panic in debug builds or wrap
        // into a huge interval that silently stops all progress reporting.
        let mut p = ArgsProgress::new(1_000);
        p.bytes = 10;
        assert!(!p.should_emit(500), "clock went backwards: no emit, no panic");
        // Bytes below the last emit (a reset) must not underflow either.
        p.mark_emitted(5_000, 1_000);
        p.bytes = 100;
        assert!(!p.should_emit(1_000), "bytes < last_emit_bytes must not underflow");
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
                            let body =
                                format!("{}Connection: close\r\n\r\n", HDR)
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
        settings.general.api_retries = 3;

        let config = ReActConfig {
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
        let retry_frame = frames
            .iter()
            .find(|f| f.frame_type == "retry" && f.extra["discardPartial"] == serde_json::json!(true));
        assert!(
            retry_frame.is_some(),
            "a mid-stream transport retry must emit a discardPartial retry frame; got frames {:?}",
            frames.iter().map(|f| f.frame_type.as_str()).collect::<Vec<_>>()
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
            history.push(crate::llm::types::ChatMessage::tool_result(&call_id, "payload"));
            history.push(crate::llm::types::ChatMessage::assistant(format!("thought {i}")));
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
            subagent_depth: 0,
            root_session_id: "work-itest".into(),
            thinking: None,
        };

        let registry = std::sync::Arc::new(crate::tools::ToolRegistry::default_registry());
        let agent = ReActAgent::new(registry);
        let (frame_tx, _frame_rx) = tokio::sync::mpsc::unbounded_channel();
        let cancel = tokio_util::sync::CancellationToken::new();

        let result = agent
            .run(&config, history, frame_tx, cancel)
            .await;
        assert_eq!(result.stop_reason, StopReason::Completed, "mock must complete, got {:?}", result.stop_reason);

        // The request the mock received must contain the focus turn: the forced
        // pass ran inside the loop and the compressed history carried the focus.
        let req = seen_rx.recv().await.expect("the loop must have called the mock");
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
    /// The tool call id that triggered the suspension.
    pub action_id: Option<String>,
    /// The tool_call_id needing a `tool` role response on resume.
    #[serde(default)]
    pub pending_tool_call_id: Option<String>,
    /// Serialized message history (JSON array of ChatMessage).
    pub messages_json: String,
    pub created_at: i64,
}
