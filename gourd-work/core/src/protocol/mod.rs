//! protocol — WebSocket streaming frame protocol.
//!
//! Frame types are compatible with the existing frontend (app-streaming.js / WebChunk):
//! reason_start, reason, text, action_start, action_args, action_batch, action_end,
//! hitl, hitl_released, question, question_answered, agent_start, agent_progress,
//! agent_end, context_size, context_compacted, tps_progress, trace, retry, user_input, steer_applied/cancelled/dropped,
//! file_changes, done, error.
//!
//! Every frame carries:
//! - `runId`    : identifies one task run (one input → one run)
//! - `eventSeq` : session-scoped monotonically increasing sequence number, used by the
//!                frontend to dedupe on reconnect (realtime WS and replay share it)
//! - `phase`    : lifecycle phase after this frame (waiting/thinking/text/tool/hitl/
//!                question/retry/done) so the frontend shows the right indicator.

use serde::{Deserialize, Serialize};

/// Lifecycle phase constants (mirror Java WebChunk PHASE_*).
pub mod phase {
    pub const WAITING: &str = "waiting";
    pub const THINKING: &str = "thinking";
    pub const TEXT: &str = "text";
    pub const TOOL: &str = "tool";
    pub const HITL: &str = "hitl";
    pub const QUESTION: &str = "question";
    pub const RETRY: &str = "retry";
    pub const DONE: &str = "done";
}

/// A streaming frame pushed to the frontend via WebSocket.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Frame {
    /// Frame type discriminator.
    #[serde(rename = "type")]
    pub frame_type: String,
    /// Session this frame belongs to.
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Run identifier (one task run = one runId).
    #[serde(rename = "runId", skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// Session-scoped monotonic event sequence (for reconnect dedupe).
    #[serde(rename = "eventSeq", skip_serializing_if = "Option::is_none")]
    pub event_seq: Option<i64>,
    /// Lifecycle phase after this frame.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    /// Text payload (content delta, error message, etc.).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Tool name (for action_* frames).
    #[serde(rename = "toolName", skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    /// Tool display title (may include agent prefix).
    #[serde(rename = "toolTitle", skip_serializing_if = "Option::is_none")]
    pub tool_title: Option<String>,
    /// Tool call ID.
    #[serde(rename = "actionId", skip_serializing_if = "Option::is_none")]
    pub action_id: Option<String>,
    /// Whether this done-frame is a suspension wrap-up (ask_user/HITL), not a real end.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suspended: Option<bool>,
    /// Creation timestamp (epoch millis).
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    /// Extra fields (tool args, batch info, etc.).
    #[serde(flatten)]
    pub extra: serde_json::Value,
}

/// Payload for [`Frame::context_size`]; see that constructor for the wire
/// contract each field feeds.
#[derive(Debug, Clone, Default)]
pub struct ContextSizePayload {
    /// Normalised input of this single model call (cache included).
    pub input_tokens: u64,
    /// Completion tokens of this single model call.
    pub output_tokens: u64,
    /// Prompt-cache reads of this call (effective across dialects).
    pub cache_read: u64,
    /// Prompt-cache writes of this call.
    pub cache_creation: u64,
    /// Cache hit rate percentage (0..=100) over the normalised input.
    pub cache_rate: f64,
    /// Messages currently in the context window (compression-aware).
    pub message_count: u64,
    /// Session-selected context window (ring denominator); 0 = unknown.
    pub context_length: i64,
    /// Run subscription moment (wall clock ms) for live elapsed time.
    pub turn_start_ms: i64,
    /// Session-cumulative ledger (confirmed runs + in-flight calls).
    pub total_input: u64,
    pub total_output: u64,
    pub total_cache_creation: u64,
    pub total_cache_read: u64,
    pub total_messages: u64,
    /// Cumulative decode time (ms) across this run's completed model calls.
    /// Paired with 'generated_tokens' for output TPS; 0 = no timed segment yet.
    pub generation_ms: u64,
    /// Completion tokens produced in those same timed decode segments.
    pub generated_tokens: u64,
    /// Time to first token (ms): elapsed from the run's start to the first
    /// visible model output (Java `TurnTimer.finish` / `onVisibleOutput`).
    /// `None` = the run never produced a visible delta; the wire key is then
    /// omitted entirely rather than fabricating a 0 ms latency.
    pub ttft_ms: Option<u64>,
}

impl Frame {
    fn now() -> i64 {
        chrono::Utc::now().timestamp_millis()
    }

    pub fn new(frame_type: &str) -> Self {
        Self {
            frame_type: frame_type.into(),
            session_id: None,
            run_id: None,
            event_seq: None,
            phase: None,
            text: None,
            tool_name: None,
            tool_title: None,
            action_id: None,
            suspended: None,
            created_at: Self::now(),
            extra: serde_json::json!({}),
        }
    }

    pub fn session(mut self, id: &str) -> Self {
        self.session_id = Some(id.into());
        self
    }

    pub fn run(mut self, id: &str) -> Self {
        self.run_id = Some(id.into());
        self
    }

    pub fn seq(mut self, seq: i64) -> Self {
        self.event_seq = Some(seq);
        self
    }

    pub fn with_phase(mut self, phase: &str) -> Self {
        self.phase = Some(phase.into());
        self
    }

    pub fn text(mut self, t: impl Into<String>) -> Self {
        self.text = Some(t.into());
        self
    }

    pub fn tool(mut self, name: &str) -> Self {
        self.tool_name = Some(name.into());
        self.tool_title = Some(name.into());
        self
    }

    pub fn action(mut self, id: &str) -> Self {
        self.action_id = Some(id.into());
        self
    }

    pub fn extra(mut self, key: &str, value: serde_json::Value) -> Self {
        if let Some(obj) = self.extra.as_object_mut() {
            obj.insert(key.into(), value);
        }
        self
    }

    // ─── Convenience constructors ─────────────────────────────────────────

    /// Reasoning/thinking started (pure phase signal, no content).
    ///
    /// Carries `args.turnStartMs` (the run's subscription moment, wall clock) so
    /// the frontend can invalidate the previous turn's settled elapsed time the
    /// moment a new turn starts — otherwise the meter's elapsed row stays frozen
    /// on the last trace value until the first `context_size` of the new turn
    /// arrives (Java `WebStreamBuilder.onReasonStartEvent`).
    pub fn reason_start(session: &str, turn_start_ms: i64) -> Self {
        let mut f = Self::new("reason_start")
            .session(session)
            .with_phase(phase::THINKING);
        if turn_start_ms > 0 {
            f = f.extra(
                "args",
                serde_json::json!({ "turnStartMs": turn_start_ms }),
            );
        }
        f
    }

    /// Reasoning content delta.
    pub fn reason(session: &str, text: &str) -> Self {
        Self::new("reason").session(session).text(text).with_phase(phase::THINKING)
    }

    /// Final answer text delta.
    pub fn text_delta(session: &str, text: &str) -> Self {
        Self::new("text").session(session).text(text).with_phase(phase::TEXT)
    }

    /// Tool call started (with full args once known).
    pub fn action_start(session: &str, tool_name: &str, action_id: &str, args: serde_json::Value) -> Self {
        Self::new("action_start")
            .session(session)
            .tool(tool_name)
            .action(action_id)
            .extra("args", args)
            .with_phase(phase::TOOL)
    }

    /// Tool call arguments progress (cumulative byte count only).
    pub fn action_args(session: &str, action_id: &str, args_bytes: u64) -> Self {
        Self::new("action_args")
            .session(session)
            .action(action_id)
            .extra("argsBytes", serde_json::json!(args_bytes))
            .with_phase(phase::TOOL)
    }

    /// Tool-card skeleton: the model has just named the function and its
    /// arguments are still streaming (Java `WebChunk.ofActionDraft`).
    ///
    /// ## Why this frame exists
    ///
    /// `action_args` is a **pure progress** frame — the frontend's handler calls
    /// `updateToolCardArgsProgress`, which only updates a card that already
    /// exists. Without a draft frame nothing creates that card until
    /// `action_start`, which is emitted only once the arguments are complete.
    /// For a tool with a large payload (`write` of a whole Markdown file) that
    /// window runs to **80+ seconds** of a completely blank screen, and the
    /// bottom indicator keeps saying "outputting". `app-message.js` documents
    /// this as the exact behaviour the draft frame was introduced to remove.
    ///
    /// Only `action_draft` and `action_start` call `finishThinkingBlock`, so
    /// without this frame the thinking block also stays open through the whole
    /// argument-generation phase.
    ///
    /// The three frames share one `actionId`, so the frontend builds the skeleton
    /// once and `action_start` converts it in place — one DOM card for the whole
    /// lifecycle, never two.
    ///
    /// **Transient**: like `action_args`, it is not persisted. History replay
    /// rebuilds the card from `action_start` + `action_end`, which is why the
    /// frontend notes replay "theoretically never sees" this frame.
    ///
    /// Carries no arguments: at this moment they do not exist yet. The frontend
    /// passes an empty string to the shared card template for exactly this case.
    pub fn action_draft(session: &str, tool_name: &str, action_id: &str) -> Self {
        Self::new("action_draft")
            .session(session)
            .tool(tool_name)
            .action(action_id)
            .with_phase(phase::TOOL)
    }

    /// Batch declaration before a parallel tool batch executes.
    pub fn action_batch(session: &str, batch_id: &str, members: Vec<serde_json::Value>) -> Self {
        let size = members.len();
        Self::new("action_batch")
            .session(session)
            .extra("batchId", serde_json::json!(batch_id))
            .extra("batchSize", serde_json::json!(size))
            .extra("batchMembers", serde_json::json!(members))
            .with_phase(phase::TOOL)
    }

    /// Tool call completed with result.
    pub fn action_end(session: &str, tool_name: &str, action_id: &str, result: &str) -> Self {
        Self::new("action_end")
            .session(session)
            .tool(tool_name)
            .action(action_id)
            .text(result)
            .with_phase(phase::WAITING)
    }

    /// Tool call completed but failed.
    pub fn action_end_failed(session: &str, tool_name: &str, action_id: &str, result: &str) -> Self {
        Self::new("action_end")
            .session(session)
            .tool(tool_name)
            .action(action_id)
            .text(result)
            .extra("failed", serde_json::json!(true))
            .with_phase(phase::WAITING)
    }

    /// HITL approval required.
    pub fn hitl(session: &str, tool_name: &str, command: &str, action_id: &str) -> Self {
        Self::new("hitl")
            .session(session)
            .tool(tool_name)
            .action(action_id)
            .extra("command", serde_json::json!(command))
            .with_phase(phase::HITL)
    }

    /// A pending HITL card has been released (e.g. switched to full access).
    pub fn hitl_released(session: &str, action_id: Option<&str>) -> Self {
        let mut f = Self::new("hitl_released").session(session);
        if let Some(id) = action_id {
            f = f.action(id);
        }
        f
    }

    /// Question card for the user (ask_user tool).
    pub fn question(session: &str, action_id: &str, payload: serde_json::Value) -> Self {
        Self::new("question")
            .session(session)
            .tool("ask_user")
            .action(action_id)
            .extra("args", payload)
            .with_phase(phase::QUESTION)
    }

    /// User answered the question; carries answers for rendering the answered state.
    pub fn question_answered(session: &str, action_id: &str, answers: serde_json::Value) -> Self {
        Self::new("question_answered")
            .session(session)
            .tool("ask_user")
            .action(action_id)
            .extra("args", serde_json::json!({ "answers": answers }))
            .with_phase(phase::WAITING)
    }

    /// Sub-agent started.
    ///
    /// `invocation_id` pairs this frame with its later `agent_progress` /
    /// `agent_end`. The frontend keys its card map on it
    /// (`resolveAgentState`: `invocationId || agentName + ':' + description`),
    /// so without it two parallel sub-agents that share a name *and* a
    /// description collapse onto one card — and `multitask` makes that easy to
    /// hit, since a batch of similar tasks often gets near-identical labels.
    pub fn agent_start(
        session: &str,
        agent_name: &str,
        description: &str,
        invocation_id: &str,
        background: bool,
    ) -> Self {
        let mut f = Self::new("agent_start")
            .session(session)
            .tool(agent_name)
            .text(description)
            .extra("args", serde_json::json!({
                "agentName": agent_name,
                "description": description,
                "invocationId": invocation_id,
            }))
            .with_phase(phase::TOOL);
        if background {
            f = f.extra("background", serde_json::json!(true));
        }
        f
    }

    /// Sub-agent progress heartbeat (background only; carries current tool name).
    ///
    /// Deliberately carries **no phase**. Java's `ofAgentProgress` documents why:
    /// a background frame can arrive in the idle window after this turn's `done`
    /// and before the next turn starts, and a phase on it would rewrite the main
    /// session's phase state machine — corrupting the indicator text of a
    /// conversation the user is looking at. The frontend also special-cases this
    /// type to skip `scrollToBottom`, so a heartbeat cannot yank the viewport.
    pub fn agent_progress(
        session: &str,
        agent_name: &str,
        description: &str,
        invocation_id: &str,
        tool_name: &str,
    ) -> Self {
        Self::new("agent_progress")
            .session(session)
            .tool(agent_name)
            .text(description)
            .extra("args", serde_json::json!({
                "agentName": agent_name,
                "description": description,
                "toolName": tool_name,
                "invocationId": invocation_id,
                "background": true,
            }))
    }

    /// Sub-agent finished.
    pub fn agent_end(
        session: &str,
        agent_name: &str,
        description: &str,
        invocation_id: &str,
        success: bool,
        result: &str,
        background: bool,
    ) -> Self {
        let mut f = Self::new("agent_end")
            .session(session)
            .tool(agent_name)
            .text(description)
            .extra("args", serde_json::json!({
                "agentName": agent_name,
                "description": description,
                "success": success,
                "resultSummary": result,
                "invocationId": invocation_id,
            }))
            .with_phase(phase::WAITING);
        if background {
            f = f.extra("background", serde_json::json!(true));
        }
        f
    }

    /// Retry notification.
    pub fn retry(session: &str, attempt: u32, max: u32, reason: &str) -> Self {
        let text = if reason.is_empty() {
            format!("模型调用失败，正在重试 {}/{}", attempt, max)
        } else {
            format!("模型调用失败，正在重试 {}/{}：{}", attempt, max, reason)
        };
        Self::new("retry")
            .session(session)
            .text(text)
            .extra("attempt", serde_json::json!(attempt))
            .extra("max", serde_json::json!(max))
            .with_phase(phase::RETRY)
    }

    /// Retry after the *transport* re-issued a stream that had already emitted
    /// deltas (see [`crate::llm::StreamEvent::Retry`]).
    ///
    /// Carries `discardPartial: true` so the client can drop what the aborted
    /// attempt already rendered — the bubble text, the skeleton tool cards and
    /// the thinking block. Without that the reconnect shows the answer twice
    /// and leaves orphan cards whose arguments never complete. The engine-side
    /// accumulators are cleared in the same breath (`react/mod.rs`), so DOM and
    /// state agree on "this attempt never happened".
    pub fn stream_retry(session: &str, attempt: u32, max: u32, reason: &str) -> Self {
        let text = if reason.is_empty() {
            format!("模型响应中断，正在重新请求 {}/{}", attempt, max)
        } else {
            format!("模型响应中断，正在重新请求 {}/{}：{}", attempt, max, reason)
        };
        Self::new("retry")
            .session(session)
            .text(text)
            .extra("attempt", serde_json::json!(attempt))
            .extra("max", serde_json::json!(max))
            .extra("discardPartial", serde_json::json!(true))
            .with_phase(phase::RETRY)
    }

    /// Context usage indicator (after each model call).
    ///
    /// Wire contract mirrors Java `WebStreamBuilder.onContextUsageEvent` plus the
    /// session-cumulative fields `WebGate.emitToClient` injects before publish;
    /// the frontend meter (`app-context.js`) reads every one of them:
    ///
    /// - `totalTokens`        : ring numerator (input incl. cache + output);
    /// - `cacheReadTokens` / `cacheCreationTokens` / `cacheRate` : cache rows;
    /// - `text`               : message count of the current context window;
    /// - `args.contextLength` : ring denominator (session-selected window);
    /// - `args.turnStartMs`   : live elapsed-time anchor;
    /// - `args.total*`        : session-cumulative ledger (falls back to the
    ///                          per-turn rows on old frames that lack them).
    ///
    /// The previous two-field shape (`inputTokens`/`outputTokens` only) made the
    /// Rust kernel render an empty ring (`totalTokens` undefined → 0), no cache
    /// rows, no denominator and no cumulative rows at all.
    pub fn context_size(session: &str, p: &ContextSizePayload) -> Self {
        let total = p.input_tokens.saturating_add(p.output_tokens);
        let f = Self::new("context_size")
            .session(session)
            .extra("totalTokens", serde_json::json!(total))
            .extra("inputTokens", serde_json::json!(p.input_tokens))
            .extra("outputTokens", serde_json::json!(p.output_tokens))
            .extra("cacheReadTokens", serde_json::json!(p.cache_read))
            .extra("cacheCreationTokens", serde_json::json!(p.cache_creation))
            .extra("cacheRate", serde_json::json!(p.cache_rate))
            .text(p.message_count.to_string());
        let mut args = serde_json::Map::new();
        if p.context_length > 0 {
            args.insert("contextLength".into(), serde_json::json!(p.context_length));
        }
        if p.turn_start_ms > 0 {
            args.insert("turnStartMs".into(), serde_json::json!(p.turn_start_ms));
        }
        // Cumulative ledger: injected only when non-zero, exactly like Java's
        // gate (a zero sum means "no data", and the frontend then falls back to
        // the per-turn rows instead of showing a wall of zeros).
        if p.total_input > 0 || p.total_output > 0 {
            args.insert("totalInputTokens".into(), serde_json::json!(p.total_input));
            args.insert("totalOutputTokens".into(), serde_json::json!(p.total_output));
            if p.total_cache_creation > 0 {
                args.insert(
                    "totalCacheCreation".into(),
                    serde_json::json!(p.total_cache_creation),
                );
            }
            if p.total_cache_read > 0 {
                args.insert("totalCacheRead".into(), serde_json::json!(p.total_cache_read));
            }
            if p.total_messages > 0 {
                args.insert("totalMessages".into(), serde_json::json!(p.total_messages));
            }
        }
        // Decode-speed pair (Java TurnTimer parity). Only injected when a timed
        // segment exists: a zero denominator would fabricate an infinite TPS.
        // Riding in 'args' means history replay + the frontend's monotonic
        // createdAt gate already apply, with no extra per-session state.
        if p.generation_ms > 0 && p.generated_tokens > 0 {
            args.insert("generationMs".into(), serde_json::json!(p.generation_ms));
            args.insert("generatedTokens".into(), serde_json::json!(p.generated_tokens));
        }
        // Time to first token (Java TurnTimer.finish). Rides in `args` alongside the
        // decode-speed pair so it inherits history replay + the frontend's monotonic
        // createdAt gate with no extra per-session state. `None` (no visible output
        // this run) omits the key instead of reporting a fake 0 ms.
        if let Some(ttft) = p.ttft_ms {
            args.insert("ttftMs".into(), serde_json::json!(ttft));
        }
        f.extra("args", serde_json::Value::Object(args))
    }

    /// Context was compressed before this turn's request (Java
    /// `ContextSizeEvent(compressed=true)` → `context_compacted`).
    ///
    /// A passive metadata frame: no phase (same contract as `tps_progress`),
    /// so it cannot rewrite the conversation's phase state machine. It IS
    /// persisted (unlike `tps_progress`) because the divider it draws is part
    /// of the conversation's history shape — replay must show it where the
    /// compression happened, between the pre-compression tool groups and the
    /// post-compression ones.
    ///
    /// The before/after counts ride in `args` for the divider's detail text
    /// ("N 条 → M 条"); the frontend degrades to a bare label when absent.
    pub fn context_compacted(
        session: &str,
        before_messages: usize,
        after_messages: usize,
        before_tokens: i64,
        after_tokens: i64,
    ) -> Self {
        Self::new("context_compacted")
            .session(session)
            .extra(
                "args",
                serde_json::json!({
                    "beforeMessages": before_messages,
                    "afterMessages": after_messages,
                    "beforeTokens": before_tokens,
                    "afterTokens": after_tokens,
                }),
            )
    }

    /// Live decode-speed + first-token-latency progress (transient, not persisted).
    ///
    /// This frame is emitted **while the model is still streaming**, at most
    /// `TPS_PROGRESS_INTERVAL_MS` apart. `generatedTokens` / `generationMs` are
    /// the real tokens observed and real monotonic time elapsed in that one
    /// measurement window — the frontend's existing `ctxTpsText` computes
    /// `generatedTokens / generationMs` from them unchanged. Unlike
    /// [`Frame::context_size`] (the settlement snapshot), these two values are
    /// a sliding window, so the readout reacts immediately to a slowdown.
    /// `ttftMs` is latched at the very first visible delta and therefore also
    /// reaches the UI while the answer is still being typed.
    ///
    /// Deliberately carries **no phase**: it is a passive metadata frame, and
    /// a phase on it would rewrite the main conversation's phase state machine
    /// (same contract as `agent_progress`). It is transient — added to the
    /// session store's skip list — so history replay is driven solely by the
    /// authoritative `context_size` frame and never replays progress frames.
    ///
    /// `live: true` tells the frontend this is a running measurement; the
    /// settling `context_size` frame simply omits it.
    pub fn tps_progress(
        session: &str,
        generation_ms: u64,
        generated_tokens: u64,
        ttft_ms: Option<u64>,
    ) -> Self {
        let mut f = Self::new("tps_progress")
            .session(session)
            .extra("generationMs", serde_json::json!(generation_ms))
            .extra("generatedTokens", serde_json::json!(generated_tokens))
            .extra("live", serde_json::json!(true));
        if let Some(ttft) = ttft_ms {
            f = f.extra("ttftMs", serde_json::json!(ttft));
        }
        f
    }

    /// Run completed successfully.
    pub fn done(session: &str) -> Self {
        Self::new("done").session(session).with_phase(phase::DONE)
    }

    /// File-change ledger snapshot for one run (Java `WebChunk.ofFileChanges`).
    ///
    /// `args` carries the **complete** lightweight summary for that revision —
    /// `files[]`, `fileCount`, `additions`, `deletions`, `runApplyState`,
    /// `possiblyIncomplete` — because the frontend replaces its card wholesale
    /// from this payload (`app-file-changes.js:onFileChangesChunk` bails unless
    /// `summary.files` is an array). Sending a delta would leave the card showing
    /// a stale file list.
    ///
    /// Deliberately carries **no phase**, for the same reason as
    /// [`Frame::agent_progress`]: this is a passive run-level snapshot that can
    /// arrive after the turn's `done`, and a phase on it would rewrite the main
    /// conversation's phase state machine. The frontend documents the same
    /// contract ("元数据类帧（context_size / file_changes / …）不改变相位") and
    /// short-circuits this type before its generic streaming branch, so it must
    /// not look like the start of a new stream.
    pub fn file_changes(session: &str, run_id: &str, summary: serde_json::Value) -> Self {
        Self::new("file_changes")
            .session(session)
            .run(run_id)
            .extra("args", summary)
    }

    /// Suspension wrap-up done (ask_user/HITL): stream ends but the run is not finished.
    pub fn done_suspended(session: &str) -> Self {
        let mut f = Self::done(session);
        f.suspended = Some(true);
        f
    }

    /// Run failed with error.
    pub fn error(session: &str, message: &str) -> Self {
        Self::new("error").session(session).text(message).with_phase(phase::DONE)
    }

    /// Run failed with error, **and the partial output of the failed attempt
    /// must be rolled back** on the client (`discardPartial: true`).
    ///
    /// Used by the corruption gate's terminal path (`react/mod.rs`): when a
    /// stream is corrupt and its clean-retry allowance is exhausted, the damaged
    /// deltas of the *last* attempt are already on screen — a garbled bubble and
    /// orphan skeleton tool cards — and nothing else will clear them, because the
    /// per-attempt `stream_retry(discardPartial)` only fires *before* a retry,
    /// never after the final failure. Emitting the error with this flag lets the
    /// client drop exactly those uncommitted blocks (`discardPartialRetryDom`)
    /// and show a clean error in their place.
    ///
    /// Deliberately NOT used on the user-Stop / cancel path: there the partial
    /// output is genuine work the user chose to halt, and discarding it would
    /// destroy content they asked to keep. Corruption is the only case where the
    /// rendered bytes are known-bad.
    pub fn error_discarding(session: &str, message: &str) -> Self {
        Self::new("error")
            .session(session)
            .text(message)
            .extra("discardPartial", serde_json::json!(true))
            .with_phase(phase::DONE)
    }

    /// Trace/usage badge (final summary of the run).
    ///
    /// Takes the accumulated [`UsageInfo`](crate::llm::types::UsageInfo) rather
    /// than separate counters so the cache fields cannot be forgotten at the
    /// call site — the usage ledger derives per-model cache-hit rate from
    /// `cacheReadTokens`, and a trace frame without it makes every Rust-produced
    /// session report 0% cache hit.
    ///
    /// `inputTokens` is the **normalised** input (cache included), matching
    /// Java's `WebChunk.ofTrace`; `totalTokens` is recomputed from it so the
    /// three stay self-consistent.
    pub fn trace(
        session: &str,
        model: &str,
        usage: &crate::llm::types::UsageInfo,
        elapsed_ms: u64,
        final_answer: &str,
        generation_ms: u64,
        generated_tokens: u64,
    ) -> Self {
        let input = usage.normalized_input();
        let output = usage.completion_tokens;
        Self::new("trace")
            .session(session)
            .extra("model", serde_json::json!(model))
            .extra("inputTokens", serde_json::json!(input))
            .extra("outputTokens", serde_json::json!(output))
            .extra("totalTokens", serde_json::json!(input.saturating_add(output)))
            .extra("cacheReadTokens", serde_json::json!(usage.effective_cache_read()))
            .extra(
                "cacheCreationTokens",
                serde_json::json!(usage.cache_creation_tokens),
            )
            .extra(
                "cacheRate",
                serde_json::json!(crate::llm::types::cache_hit_rate(
                    input,
                    usage.effective_cache_read()
                )),
            )
            .extra("elapsedSeconds", serde_json::json!(elapsed_ms / 1000))
            .extra("elapsedMs", serde_json::json!(elapsed_ms))
            .extra("finalAnswer", serde_json::json!(final_answer))
            .extra("generationMs", serde_json::json!(generation_ms))
            .extra("generatedTokens", serde_json::json!(generated_tokens))
            .with_phase(phase::DONE)
    }

    /// User input pushed by automation (Loop tasks) — renders the user-side bubble.
    pub fn user_input(session: &str, text: &str, source: &str) -> Self {
        Self::new("user_input")
            .session(session)
            .text(text)
            .tool(source)
    }

    /// Interjections injected into the **live** run at a reasoning step boundary.
    ///
    /// Wire contract, identical to Java `WebChunk.ofSteerApplied` +
    /// `buildSteerArgs`:
    /// `args = {count, items:[{steerId, text, runId, createdAt, imagePaths, filePaths}]}`
    ///
    /// This frame is the *only* thing that makes an interjection visible on screen.
    /// The frontend reaches `appendSteerNote` exclusively from the `steer_applied`
    /// branch of `onWebChunk` (live) and of `replayChunk` (after a refresh) — there
    /// is no other path. Injecting the text into the model's working memory without
    /// emitting this frame leaves the user's interjection in the context but nowhere
    /// in the UI, and the caller's pending chip never leaves `accepted`.
    ///
    /// `items[].text` must be the **raw** interjection: the frontend turns
    /// `imagePaths`/`filePaths` into real tiles itself (via
    /// `/web/chat/attachment/meta`), so the LLM-facing `[用户附带图片: …]` suffix must
    /// not be echoed here or the bubble shows a tile *and* a machine-ish path line.
    ///
    /// `emitter` must include this frame in `stream.ndjson` — replay restores the
    /// same bubbles after a reload, which is why the frame carries the full item
    /// list rather than relying on live in-memory state.
    pub fn steer_applied(session: &str, args: serde_json::Value) -> Self {
        Self::new("steer_applied")
            .session(session)
            .extra("args", args)
    }

    /// Interjections still pending when the user pressed **Stop** — dropped for
    /// good, never re-queued.
    ///
    /// Same `args` shape as [`steer_applied`] (Java's `buildSteerArgs` is shared by
    /// all three events, so the frontend reads `args.items[].steerId` identically).
    ///
    /// Must be emitted **before** the `done` frame for that run. On `done` the
    /// frontend runs `finishStream` → `processMessageQueue`, and it also clears its
    /// idempotency set there; a resolution arriving afterwards is either ordered
    /// against an already-dispatched queue or rendered as a late surprise. Java is
    /// explicit about the same ordering: `WebGate` publishes
    /// `ofSteerCancelled` / `ofSteerDropped` and only then `ofDone`.
    ///
    /// Without this frame the interjection leaves the mailbox silently: the chip
    /// stays `accepted` forever on screen, and after a reload the item is simply
    /// gone from `queue.json` with nothing to explain it.
    ///
    /// [`steer_applied`]: Frame::steer_applied
    pub fn steer_cancelled(session: &str, args: serde_json::Value) -> Self {
        Self::new("steer_cancelled")
            .session(session)
            .extra("args", args)
    }

    /// Interjections the run finished without injecting, re-queued durably to
    /// `queue.json` for the frontend to dispatch on the next turn.
    ///
    /// The re-queue happens in the kernel (not the UI) and is idempotent by
    /// `originSteerId`, which is why a retry of this frame cannot duplicate the
    /// message. Same emit-ordering constraint as [`steer_cancelled`]: the frontend
    /// refreshes its queue badge from this frame, so the file must already show the
    /// item when the frame lands.
    ///
    /// [`steer_cancelled`]: Frame::steer_cancelled
    pub fn steer_dropped(session: &str, args: serde_json::Value) -> Self {
        Self::new("steer_dropped")
            .session(session)
            .extra("args", args)
    }

    /// Serialize to JSON string for WebSocket transmission.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

/// Incoming WebSocket message from the frontend.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum IncomingMessage {
    /// Ping/heartbeat.
    Ping,
    /// Subscribe to a session's frames.
    Subscribe {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Wire contract of `steer_applied` — the frame the interjection bubble is
    /// built from. Mirrors Java `WebChunk.ofSteerApplied` + `buildSteerArgs`.
    ///
    /// This is the whole reason the feature is visible at all: `appendSteerNote`
    /// is reached *only* from the `steer_applied` branch of `onWebChunk` (live)
    /// and `replayChunk` (after a reload), and both look up the list under
    /// `args.items` and skip any row without `steerId`. Regressing any key name
    /// therefore makes interjections silently invisible again — the exact bug
    /// this contract test exists to prevent.
    #[test]
    fn steer_applied_frame_matches_the_interjection_bubble_contract() {
        let item = serde_json::json!({
            "steerId": "steer-abc",
            "text": "改成用表格输出",
            "runId": "run-1",
            "createdAt": 1_700_000_000_000i64,
            "imagePaths": ["uploads/a.png"],
            "filePaths": ["uploads/b.txt"],
        });
        let v: serde_json::Value = serde_json::from_str(
            &Frame::steer_applied(
                "work-x",
                serde_json::json!({ "count": 1, "items": [item] }),
            )
            .run("run-1")
            .seq(7)
            .to_json(),
        )
        .unwrap();

        assert_eq!(v["type"], "steer_applied");
        assert_eq!(v["sessionId"], "work-x");
        // `emit!` is what stamps runId/eventSeq; both must survive to the wire —
        // replay dedupes on the sequence and the frontend pairs the bubble to a run.
        assert_eq!(v["runId"], "run-1");
        assert_eq!(v["eventSeq"], 7);

        // Everything the renderer reads lives under `args`, never at top level.
        let items = v["args"]["items"]
            .as_array()
            .expect("args.items must be an array");
        assert_eq!(items.len(), 1);
        assert_eq!(v["args"]["count"], 1);

        let row = &items[0];
        assert_eq!(row["steerId"], "steer-abc", "missing steerId drops the row");
        assert_eq!(row["text"], "改成用表格输出");
        assert_eq!(row["runId"], "run-1");
        assert_eq!(row["createdAt"], 1_700_000_000_000i64);
        assert_eq!(row["imagePaths"][0], "uploads/a.png");
        assert_eq!(row["filePaths"][0], "uploads/b.txt");

        // The frame carries paths, never attachment *content* — the frontend
        // upgrades them to tiles through /web/chat/attachment/meta.
        assert!(
            !v.to_string().contains("data:image"),
            "a steer frame must not inline base64 attachments"
        );
    }

    /// Wire contract for the tool-card skeleton (`app-message.js`).
    ///
    /// `appendActionDraftChunk` bails immediately without an `actionId`, because
    /// that id is what lets `action_start` take over the same card instead of
    /// building a second one. A draft frame missing any of these three fields
    /// therefore produces either no card or a duplicate card stuck in `loading`
    /// forever — both silent.
    #[test]
    fn action_draft_frame_carries_the_skeleton_contract() {
        let v: serde_json::Value =
            serde_json::from_str(&Frame::action_draft("work-x", "write", "call_1").to_json()).unwrap();
        assert_eq!(v["type"], "action_draft");
        assert_eq!(v["sessionId"], "work-x");
        assert_eq!(v["toolName"], "write", "the skeleton shows the tool name");
        assert_eq!(v["actionId"], "call_1", "pairs with action_start for in-place takeover");
        // The skeleton is built before any argument byte exists, so the frame must
        // not carry args: the frontend passes an empty string to the shared card
        // template for exactly this case.
        assert!(v.get("args").is_none(), "a draft must not carry arguments");
        assert!(v.get("argsBytes").is_none());
    }

    /// The draft must advance the phase to `tool`.
    ///
    /// Unlike `file_changes`/`agent_progress`, this frame *does* represent the
    /// conversation moving into tool execution, and the frontend maps it to
    /// `PHASE_TOOL` (`app-streaming.js:752`). Without a phase the indicator would
    /// keep saying "waiting" through the whole argument-generation window — the
    /// same blank-screen symptom the frame exists to remove.
    #[test]
    fn action_draft_frame_advances_the_phase_to_tool() {
        let v: serde_json::Value =
            serde_json::from_str(&Frame::action_draft("work-x", "write", "call_1").to_json()).unwrap();
        assert_eq!(v["phase"], phase::TOOL);
    }

    /// Draft, args-progress and start must share one `actionId`.
    ///
    /// That shared id is the entire mechanism by which the three frames drive a
    /// single DOM card. If any of them stamped a different id the frontend would
    /// build a second card and leave the skeleton spinning forever.
    #[test]
    fn the_three_tool_card_frames_share_one_action_id() {
        let id = "call_shared";
        let draft: serde_json::Value =
            serde_json::from_str(&Frame::action_draft("s", "write", id).to_json()).unwrap();
        let args: serde_json::Value =
            serde_json::from_str(&Frame::action_args("s", id, 128).to_json()).unwrap();
        let start: serde_json::Value = serde_json::from_str(
            &Frame::action_start("s", "write", id, serde_json::json!({"file_path": "a.txt"})).to_json(),
        )
        .unwrap();
        assert_eq!(draft["actionId"], args["actionId"]);
        assert_eq!(args["actionId"], start["actionId"]);
        assert_eq!(draft["actionId"], serde_json::json!(id));
        // The progress frame carries the cumulative byte count the header renders.
        assert_eq!(args["argsBytes"], serde_json::json!(128));
    }

    /// Wire-contract guard for the file-change card (`app-file-changes.js`).
    ///
    /// `onFileChangesChunk` reads exactly two things and bails on either being
    /// wrong: `chunk.runId` and `chunk.args`, and it additionally requires
    /// `args.files` to be an **Array**. A frame missing any of those renders no
    /// card at all — silently, with no console error — so the shape is pinned here.
    #[test]
    fn file_changes_frame_carries_the_card_contract() {
        let summary = serde_json::json!({
            "status": "OK",
            "files": [{"path": "a.txt", "changeType": "ADDED", "additions": 1, "deletions": 0}],
            "fileCount": 1,
            "additions": 1,
            "deletions": 0,
            "possiblyIncomplete": false,
        });
        let v: serde_json::Value =
            serde_json::from_str(&Frame::file_changes("work-x", "run-1", summary).to_json()).unwrap();

        assert_eq!(v["type"], "file_changes");
        assert_eq!(v["runId"], "run-1", "the card is keyed by runId");
        assert_eq!(v["sessionId"], "work-x");
        // The summary must ride in `args`, not be flattened onto the frame.
        assert!(v["args"]["files"].is_array(), "args.files must be an array");
        assert_eq!(v["args"]["fileCount"], 1);
        assert_eq!(v["args"]["files"][0]["path"], "a.txt");
    }

    /// The frame must carry **no phase**.
    ///
    /// It can arrive after this turn's `done`, and a phase on it would rewrite the
    /// main conversation's phase state machine — corrupting the indicator text of
    /// a conversation the user is looking at. Same reasoning as `agent_progress`,
    /// and the frontend documents `file_changes` as a phase-neutral metadata frame.
    #[test]
    fn file_changes_frame_carries_no_phase() {
        let v: serde_json::Value = serde_json::from_str(
            &Frame::file_changes("work-x", "run-1", serde_json::json!({"files": []})).to_json(),
        )
        .unwrap();
        assert!(
            v.get("phase").is_none(),
            "file_changes must not advance the phase state machine: {}",
            v
        );
    }

    /// An empty file list must still serialise as an array, not null.
    ///
    /// `Array.isArray(null)` is false, so a null `files` would make the handler
    /// bail and drop the card even though the frame is valid.
    #[test]
    fn file_changes_summary_with_no_files_keeps_files_an_array() {
        let v: serde_json::Value = serde_json::from_str(
            &Frame::file_changes("work-x", "run-1", serde_json::json!({"files": [], "fileCount": 0}))
                .to_json(),
        )
        .unwrap();
        assert!(v["args"]["files"].is_array());
        assert_eq!(v["args"]["files"].as_array().unwrap().len(), 0);
    }

    /// Wire-contract guard for the frontend meter (`app-context.js`):
    /// every field it reads must be present on a fully-populated frame.
    #[test]
    fn context_size_frame_carries_full_meter_contract() {
        let p = ContextSizePayload {
            input_tokens: 300,
            output_tokens: 20,
            cache_read: 250,
            cache_creation: 10,
            cache_rate: 83.33,
            message_count: 7,
            context_length: 256_000,
            turn_start_ms: 1_700_000_000_000,
            total_input: 42_000_000,
            total_output: 198_000,
            total_cache_creation: 1_000,
            total_cache_read: 41_100_000,
            total_messages: 7,
            generation_ms: 4_000,
            generated_tokens: 320,
            ttft_ms: Some(1_690),
        };
        let v: serde_json::Value = serde_json::from_str(&Frame::context_size("work-x", &p).to_json()).unwrap();
        assert_eq!(v["type"], "context_size");
        // ring numerator = input + output
        assert_eq!(v["totalTokens"], 320);
        assert_eq!(v["inputTokens"], 300);
        assert_eq!(v["outputTokens"], 20);
        assert_eq!(v["cacheReadTokens"], 250);
        assert_eq!(v["cacheCreationTokens"], 10);
        assert_eq!(v["cacheRate"], 83.33);
        // message count rides in text (Java parity)
        assert_eq!(v["text"], "7");
        let args = &v["args"];
        assert_eq!(args["contextLength"], 256_000);
        assert_eq!(args["turnStartMs"], 1_700_000_000_000i64);
        assert_eq!(args["totalInputTokens"], 42_000_000);
        assert_eq!(args["totalOutputTokens"], 198_000);
        assert_eq!(args["totalCacheCreation"], 1_000);
        assert_eq!(args["totalCacheRead"], 41_100_000);
        assert_eq!(args["totalMessages"], 7);
        assert_eq!(args["generationMs"], 4_000);
        assert_eq!(args["generatedTokens"], 320);
        assert_eq!(args["ttftMs"], 1_690);
    }

    /// Zero-ledger frames must omit the cumulative keys so the frontend falls
    /// back to per-turn rows instead of rendering a wall of zeros.
    #[test]
    fn context_size_zero_ledger_omits_cumulative_keys() {
        let p = ContextSizePayload {
            input_tokens: 5,
            output_tokens: 6,
            ..Default::default()
        };
        let v: serde_json::Value = serde_json::from_str(&Frame::context_size("work-x", &p).to_json()).unwrap();
        assert_eq!(v["totalTokens"], 11);
        let args = v["args"].as_object().unwrap();
        assert!(!args.contains_key("totalInputTokens"));
        assert!(!args.contains_key("totalMessages"));
        assert!(!args.contains_key("contextLength"));
        assert!(!args.contains_key("turnStartMs"));
        assert!(!args.contains_key("generationMs"));
        assert!(!args.contains_key("generatedTokens"));
        assert!(!args.contains_key("ttftMs"));
    }

    /// A run with no visible output must not report a fabricated 0 ms TTFT, while
    /// a real first-token delay is carried verbatim (Java `TurnTimer.finish`).
    #[test]
    fn context_size_ttft_only_when_a_visible_delta_existed() {
        let none_frame: serde_json::Value = serde_json::from_str(
            &Frame::context_size("work-x", &ContextSizePayload { ttft_ms: None, ..Default::default() }).to_json(),
        )
        .unwrap();
        assert!(!none_frame["args"].as_object().unwrap().contains_key("ttftMs"));

        let some_frame: serde_json::Value = serde_json::from_str(
            &Frame::context_size(
                "work-x",
                &ContextSizePayload { ttft_ms: Some(0), ..Default::default() },
            )
            .to_json(),
        )
        .unwrap();
        // An instant first token is a legitimate 0 ms, distinct from "no data".
        assert_eq!(some_frame["args"]["ttftMs"], 0);
    }

    /// Wire-contract guard: the trace frame must carry the decode-speed pair
    /// that 'app-message.js:traceTpsText' and the context meter both read.
    #[test]
    fn trace_frame_carries_decode_speed_pair() {
        let u = crate::llm::types::UsageInfo::default();
        let v: serde_json::Value = serde_json::from_str(
            &Frame::trace("work-x", "m", &u, 12_000, "ok", 4_000, 320).to_json(),
        )
        .unwrap();
        assert_eq!(v["type"], "trace");
        assert_eq!(v["elapsedMs"], 12_000);
        assert_eq!(v["generationMs"], 4_000);
        assert_eq!(v["generatedTokens"], 320);
    }

    /// Live TPS progress must carry the measured pair + latched TTFT, and
    /// deliberately carry **no phase** (a phase would rewrite the main
    /// conversation's phase state machine on every 500 ms heartbeat).
    #[test]
    fn tps_progress_frame_carries_the_live_meter_contract() {
        let v: serde_json::Value =
            serde_json::from_str(&Frame::tps_progress("work-x", 1_000, 42, Some(1_690)).to_json())
                .unwrap();
        assert_eq!(v["type"], "tps_progress");
        assert_eq!(v["sessionId"], "work-x");
        assert_eq!(v["generationMs"], 1_000);
        assert_eq!(v["generatedTokens"], 42);
        assert_eq!(v["ttftMs"], 1_690);
        assert_eq!(v["live"], true);
        assert!(v.get("phase").is_none(), "progress frames must not advance the phase");

        // The first-visible-delta frame has no speed yet: 0/0 must be sent as
        // real zeros (not omitted), so the frontend knows TTFT is latched.
        let first: serde_json::Value =
            serde_json::from_str(&Frame::tps_progress("work-x", 0, 0, Some(860)).to_json()).unwrap();
        assert_eq!(first["generationMs"], 0);
        assert_eq!(first["generatedTokens"], 0);
        assert_eq!(first["ttftMs"], 860);
        // No visible output ⇒ no fabricated 0 ms latency, same as context_size.
        let none: serde_json::Value =
            serde_json::from_str(&Frame::tps_progress("work-x", 0, 0, None).to_json()).unwrap();
        assert!(none.get("ttftMs").is_none());
    }

    /// The compression divider frame must carry the before/after counts inside
    /// `args` (which `#[serde(flatten)]` lifts to top-level keys on the wire) and
    /// must deliberately carry **no phase**: a phase would rewrite the main
    /// conversation's phase state machine from a purely passive marker frame.
    #[test]
    fn context_compacted_frame_carries_the_divider_contract() {
        let v: serde_json::Value =
            serde_json::from_str(&Frame::context_compacted("work-x", 40, 12, 90_000, 30_000).to_json())
                .unwrap();
        assert_eq!(v["type"], "context_compacted");
        assert_eq!(v["sessionId"], "work-x");
        assert!(v.get("phase").is_none(), "a passive marker must not advance the phase");
        // The frontend reads these four through `chunk.args.*`.
        assert_eq!(v["args"]["beforeMessages"], 40);
        assert_eq!(v["args"]["afterMessages"], 12);
        assert_eq!(v["args"]["beforeTokens"], 90_000);
        assert_eq!(v["args"]["afterTokens"], 30_000);
    }

    /// Reason start carries the per-turn anchor that lets the frontend
    /// invalidate the previous turn's settled elapsed time immediately.
    #[test]
    fn reason_start_carries_turn_anchor() {
        let v: serde_json::Value =
            serde_json::from_str(&Frame::reason_start("work-x", 1234).to_json()).unwrap();
        assert_eq!(v["type"], "reason_start");
        assert_eq!(v["args"]["turnStartMs"], 1234);
        // unknown anchor must not fabricate a zero args map
        let v2: serde_json::Value =
            serde_json::from_str(&Frame::reason_start("work-x", 0).to_json()).unwrap();
        assert!(v2.get("args").is_none());
    }

    /// Locks the tool-card contract: `appendActionEndChunk` reads only
    /// `chunk.failed === true` (a **top-level** flag). If `action_end_failed`
    /// stopped emitting `failed`, or buried it inside an `extra` object so
    /// `#[serde(flatten)]` did not lift it to the top level, every failed tool
    /// call would be rendered with a green success dot — no error, no red card.
    #[test]
    fn action_end_failed_carries_top_level_failed_flag() {
        let result = "Error: command exited with status 1";
        let v: serde_json::Value = serde_json::from_str(
            &Frame::action_end_failed("work-x", "bash", "call_failed", result).to_json(),
        )
        .unwrap();

        // Must be the top-level key the frontend reads, never `extra.failed`.
        assert_eq!(v["failed"], true, "顶层 failed 缺失会让工具失败显示绿点");
        assert!(v.get("extra").is_none(), "failed 不得被塞进 extra 嵌套对象");
        assert_eq!(v["type"], "action_end");
        assert_eq!(v["text"], result);
        assert_eq!(v["phase"], phase::WAITING);
    }

    /// Locks the tool-card contract: `appendActionEndChunk` reads only
    /// `chunk.failed === true`. A success frame must therefore omit `failed`
    /// **entirely** — not emit `failed: false`, and certainly not leak a
    /// stale truthy value. `v.get("failed").is_none()` is deliberate: an
    /// explicit `false` would also evaluate green today, but it would blur the
    /// "absent means success" wire contract the structured flag was built on.
    #[test]
    fn action_end_success_has_no_failed_flag() {
        let v: serde_json::Value = serde_json::from_str(
            &Frame::action_end("work-x", "bash", "call_ok", "done").to_json(),
        )
        .unwrap();

        assert!(v.get("failed").is_none(), "成功帧不得带 failed 字段（连 false 也不应有）");
        assert_eq!(v["type"], "action_end");
    }

    /// Locks the tool-card contract: `appendActionEndChunk` reads only
    /// `chunk.failed === true`, and replay (`load_stream_frames` → `to_json`
    /// lines → `serde_json::from_str::<Value>`) must preserve that flag. This
    /// simulates a whole-line JSON round trip: serialize the frame, parse the
    /// line back into a generic `Value`, write it out again, parse once more.
    /// If either hop dropped `failed` — or nested it under an `extra` object —
    /// every failed tool on a reloaded conversation would show a green dot.
    /// The success frame is checked on the same path to prove no false flag is
    /// invented by the round trip.
    #[test]
    fn failed_flag_survives_json_round_trip() {
        let failed_line = Frame::action_end_failed("work-x", "bash", "call_failed", "boom").to_json();
        let failed_once: serde_json::Value = serde_json::from_str(&failed_line).unwrap();
        let failed_rewritten = serde_json::to_string(&failed_once).unwrap();
        let failed_twice: serde_json::Value = serde_json::from_str(&failed_rewritten).unwrap();
        assert_eq!(failed_once["failed"], true, "第一次解析必须保留顶层 failed");
        assert_eq!(failed_twice["failed"], true, "整行往返后 failed 不得丢失或下沉到 extra");
        assert!(failed_twice.get("extra").is_none());

        let ok_line = Frame::action_end("work-x", "bash", "call_ok", "ok").to_json();
        let ok_once: serde_json::Value = serde_json::from_str(&ok_line).unwrap();
        let ok_rewritten = serde_json::to_string(&ok_once).unwrap();
        let ok_twice: serde_json::Value = serde_json::from_str(&ok_rewritten).unwrap();
        assert!(ok_once.get("failed").is_none());
        assert!(ok_twice.get("failed").is_none(), "成功帧往返后不得凭空出现 failed 字段");
    }
}
