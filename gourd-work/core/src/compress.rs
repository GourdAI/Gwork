//! compress — semantic-preserving context compression.
//!
//! Port of the Java kernel's `ContextCompressionInterceptor` (1649 lines). The
//! Rust kernel had **no** compression at all: `history_window_size` capped the
//! number of *stored* messages replayed into a run, but a single run's working
//! memory grew without bound, so any long task eventually hit the provider's
//! context limit and failed with a 400 that retrying could never fix.
//!
//! What is implemented here (the zero-cost path — no LLM calls):
//! - per-message hard cap (a single huge tool result cannot blow the window)
//! - absolute-reserve trigger threshold + predictive next-turn check
//! - free-tier sweep of stale, reproducible tool results (keeps message count
//!   and tool_use/tool_result pairing intact, so prompt-cache prefixes survive)
//! - intent chain (all user asks, cheap and high-value against goal drift)
//! - first-chain protection (system prompt + original question never compressed)
//! - dual-dimension retention window (count + tokens) with a floor
//! - tool-use atomic-pair alignment, so an `assistant(tool_calls)` is never
//!   separated from its `tool` results — an orphaned pair is a hard 400 on
//!   OpenAI-compatible APIs
//! - dangling tool-output removal as the final invariant guard
//!
//! Deliberately **not** ported yet: the LLM summarisation strategies
//! (`LLMCompressionStrategy`, hierarchical, vector-store, composite). Java falls
//! back to exactly the zero-cost path implemented here when no strategy is
//! configured, so this is a complete, safe behaviour rather than a stub.

use crate::llm::{ChatMessage, MessageContent, Role};

/// Per-message overhead in tokens (Java `estimateTokens`: `cachedCount + 4`).
const MSG_OVERHEAD: i64 = 4;
/// Reply-level overhead (Java `estimateTokens`: `return totalTokens + 3`).
const REPLY_OVERHEAD: i64 = 3;
/// One turn's tool-result growth estimate (Java `TOOL_RESULT_GROWTH_ESTIMATE`).
const TOOL_RESULT_GROWTH: i64 = 16_000;
/// Placeholder prefix marking an already-swept tool result (Java `META_SWEPT`).
const SWEPT_PREFIX: &str = "[早期工具结果已从上下文中清理";
/// Characters kept per user intent in the chain (Java `INTENT_BRIEF_CHARS`).
const INTENT_BRIEF_CHARS: usize = 150;

/// Tools whose results are **pure reads**: re-running them costs time but does
/// not change the world, so their old output can be replaced by a placeholder.
///
/// `write`/`edit` are excluded on purpose (Java `SWEEPABLE_TOOLS`): they have
/// side effects, a placeholder invites the model to re-run them, and re-running
/// a write overwrites a file a second time. Their results are one line anyway,
/// so sweeping them would save nothing.
const SWEEPABLE_TOOLS: &[&str] = &[
    "read", "bash", "grep", "glob", "list", "ls", "websearch", "webfetch", "codesearch",
];

/// Compression budget configuration (from `settings.general`).
#[derive(Debug, Clone)]
pub struct CompressionConfig {
    /// Context window in tokens.
    pub context_length: i64,
    /// Trigger ratio, clamped to 1..=100 (Java `compressionRatio`).
    pub ratio: u32,
    /// Target water level, clamped to 10..=95 (Java `compressionTargetRatio`).
    pub target_ratio: u32,
    /// Reserved output tokens, floored at 1000 (Java `reservedOutputTokens`).
    pub reserved_output: i64,
    /// Retention window by message count (Java `maxMessages`).
    pub max_messages: usize,
    /// Absolute floor for the retention window (Java `minReservedMessages`).
    pub min_reserved_messages: usize,
}

impl CompressionConfig {
    /// Build from settings, applying the same clamps Java's setters do.
    pub fn from_settings(g: &crate::config::GeneralSettings) -> Self {
        let max_messages = g.compression_max_messages.max(1) as usize;
        Self {
            context_length: g.context_length.max(1),
            ratio: g.compression_ratio.clamp(1, 100),
            target_ratio: g.compression_target_ratio.clamp(10, 95),
            // Java: `Math.max(1_000, reservedOutputTokens)`
            reserved_output: (g.compression_reserved_output_tokens as i64).max(1_000),
            max_messages,
            // Java: `Math.max(3, maxMessages / 3)`
            min_reserved_messages: (max_messages / 3).max(3),
        }
    }

    /// Trigger threshold in tokens (Java `finalTokenThreshold`).
    ///
    /// Uses **absolute** reserves rather than a pure percentage: what one turn
    /// adds (model output + tool results) does not scale with the window, so a
    /// percentage reserve is wrong at both ends — on a 1M window it throws away
    /// 200K usable tokens, and on a 32K window it leaves too little to hold a
    /// single reply.
    pub fn trigger_threshold(&self) -> i64 {
        let ctx = self.context_length;
        // 1. Output reserve; on tiny windows it must not eat everything.
        let reserved = self.reserved_output.min((ctx / 4).max(1));
        let effective = (ctx - reserved).max(1);

        // 2. Turn buffer, also an absolute ladder.
        let mut buffer = if effective >= 800_000 {
            50_000
        } else if effective >= 400_000 {
            30_000
        } else {
            13_000
        };
        buffer = buffer.min((effective / 2).max(1));

        let mut threshold = effective - buffer;

        // 3. Ratio can only pull the trigger *earlier*, never later.
        if self.ratio < 100 {
            let by_ratio = ctx.saturating_mul(self.ratio as i64) / 100;
            threshold = threshold.min(by_ratio);
        }

        // 4. Floor: even a small window keeps half usable, so compression does
        //    not degenerate into running every turn.
        threshold = threshold.max(ctx / 2);
        threshold.max(1)
    }

    /// Target water level after compression (Java `resolveTargetBudget`).
    ///
    /// Decoupled from the trigger on purpose: stopping just below the trigger
    /// frees so little room that one large tool result eats it all, and the
    /// session then compresses every 1-3 turns — each rewrite invalidating the
    /// whole prompt-cache prefix.
    pub fn target_budget(&self, trigger: i64) -> i64 {
        let ctx = self.context_length;
        let reserved = self.reserved_output.min((ctx / 4).max(1));
        let effective = (ctx - reserved).max(1);
        let target = effective * self.target_ratio as i64 / 100;
        // Never above the trigger, or compressing achieves nothing.
        target.min(trigger).max(1)
    }

    /// What one turn is expected to add (Java `estimateMaxTurnGrowth`).
    pub fn max_turn_growth(&self) -> i64 {
        self.reserved_output + TOOL_RESULT_GROWTH
    }
}

/// Result of a compression pass.
#[derive(Debug, Clone)]
pub struct CompressionOutcome {
    /// The (possibly rewritten) message list.
    pub messages: Vec<ChatMessage>,
    /// Estimated tokens before.
    pub before_tokens: i64,
    /// Estimated tokens after.
    pub after_tokens: i64,
    /// Message count before.
    pub before_count: usize,
    /// Message count after.
    pub after_count: usize,
    /// Whether anything actually changed.
    pub compressed: bool,
}

// ─── Token estimation ─────────────────────────────────────────────────────────

/// Estimate the token count of a string.
///
/// Java uses jtokkit (a real BPE). This kernel has no tokenizer dependency, so
/// it approximates: CJK characters cost about one token each, everything else
/// about one token per four characters. The estimate is then **calibrated
/// against the provider's real `prompt_tokens`** (see `Calibration`), which is
/// what actually keeps the trigger honest — the same trick Java uses in
/// `calibrateWithRealUsage`.
pub fn estimate_text_tokens(text: &str) -> i64 {
    let mut cjk = 0i64;
    let mut other = 0i64;
    for ch in text.chars() {
        // CJK unified ideographs + common CJK punctuation/full-width ranges.
        let is_cjk = matches!(ch as u32,
            0x3000..=0x303F | 0x3040..=0x30FF | 0x3400..=0x4DBF
            | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0xFF00..=0xFFEF
            | 0xAC00..=0xD7AF
        );
        if is_cjk {
            cjk += 1;
        } else {
            other += 1;
        }
    }
    // Round up so short strings never estimate as zero.
    cjk + (other + 3) / 4
}

/// Estimate one message's tokens, including its tool-call payload.
///
/// Java adds `countTokens(name + args) + 10` per tool call: the arguments are
/// serialised into the request too, and omitting them systematically
/// under-counts assistant turns that call tools with large arguments (a `write`
/// with a whole file in it).
fn estimate_message(msg: &ChatMessage) -> i64 {
    let mut t = match &msg.content {
        Some(MessageContent::Text(s)) => estimate_text_tokens(s),
        Some(MessageContent::Parts(parts)) => {
            let text: String = parts
                .iter()
                .filter_map(|p| match p {
                    crate::llm::ContentPart::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect();
            // Image parts are not free either; charge a flat estimate each.
            let images = parts
                .iter()
                .filter(|p| !matches!(p, crate::llm::ContentPart::Text { .. }))
                .count() as i64;
            estimate_text_tokens(&text) + images * 1_000
        }
        None => 0,
    };
    if let Some(calls) = &msg.tool_calls {
        for tc in calls {
            t += estimate_text_tokens(&tc.function.name);
            t += estimate_text_tokens(&tc.function.arguments);
            t += 10; // id + JSON structure
        }
    }
    t
}

/// Estimate a whole message list plus the fixed request overhead.
pub fn estimate_tokens(messages: &[ChatMessage], system_tokens: i64, tools_tokens: i64) -> i64 {
    let mut total: i64 = messages.iter().map(|m| estimate_message(m) + MSG_OVERHEAD).sum();
    if system_tokens > 0 {
        total += system_tokens + MSG_OVERHEAD;
    }
    total += tools_tokens + REPLY_OVERHEAD;
    total
}

/// Estimate the tool-definition overhead (Java `estimateToolsTokens`).
pub fn estimate_tools_tokens(defs: &[crate::llm::ToolDefinition]) -> i64 {
    defs.iter()
        .map(|d| {
            estimate_text_tokens(&d.function.name)
                + estimate_text_tokens(&d.function.description)
                + estimate_text_tokens(&serde_json::to_string(&d.function.parameters).unwrap_or_default())
                + 15
        })
        .sum()
}

/// Real-usage calibration anchor (Java `CTX_LAST_REAL_INPUT_TOKENS` +
/// `CTX_LAST_REAL_MESSAGE_COUNT`).
///
/// The local estimator and the provider's billing tokenizer disagree — different
/// vocabularies, plus per-request overhead the estimate cannot see. Feeding back
/// the last real `prompt_tokens` keeps the trigger aligned with reality instead
/// of with a guess.
#[derive(Debug, Clone, Copy, Default)]
pub struct Calibration {
    /// Real input tokens reported by the provider last turn (cache included).
    pub real_tokens: i64,
    /// Message count that estimate corresponded to.
    pub real_message_count: usize,
}

/// Apply the calibration factor, clamped to [0.5, 2.0] (Java
/// `calibrateWithRealUsage`).
///
/// Only trusted when the message count has not *shrunk*: fewer messages means a
/// compression or reset happened in between, so the old anchor describes a
/// different list and would mislead.
pub fn calibrate(
    messages: &[ChatMessage],
    estimated: i64,
    cal: &Calibration,
    system_tokens: i64,
    tools_tokens: i64,
) -> i64 {
    if cal.real_tokens <= 0 || cal.real_message_count == 0 {
        return estimated;
    }
    if messages.len() < cal.real_message_count {
        return estimated;
    }
    // Denominator must use the same scope as the numerator: real input_tokens
    // include the system prompt and tool definitions. Counting only messages
    // here would make the factor systematically too large and pin it at the 2.0
    // clamp, doubling the estimate and triggering compression far too early.
    let then = estimate_tokens(&messages[..cal.real_message_count], system_tokens, tools_tokens);
    if then <= 0 {
        return estimated;
    }
    let factor = (cal.real_tokens as f64 / then as f64).clamp(0.5, 2.0);
    ((estimated as f64) * factor) as i64
}

// ─── Message classification ───────────────────────────────────────────────────

fn is_tool_message(msg: &ChatMessage) -> bool {
    msg.role == Role::Tool
}

fn is_assistant_with_calls(msg: &ChatMessage) -> bool {
    msg.role == Role::Assistant
        && msg
            .tool_calls
            .as_ref()
            .map(|c| !c.is_empty())
            .unwrap_or(false)
}

/// Text-ReAct style observation (Java `isObservation`): a user message whose
/// content starts with `Observation:`.
fn is_observation(msg: &ChatMessage) -> bool {
    is_tool_message(msg)
        || (msg.role == Role::User && msg.content_text().starts_with("Observation:"))
}

/// True when the message content is already a sweep placeholder.
fn is_swept(msg: &ChatMessage) -> bool {
    msg.content_text().starts_with(SWEPT_PREFIX)
}

/// Map `tool_call_id` → tool name.
///
/// Needed because this kernel's `ChatMessage::tool_result` leaves `name` unset,
/// so a tool message alone cannot say which tool produced it. Java reads
/// `ToolMessage.getName()` directly; here the name is recovered from the
/// assistant turn that declared the call.
fn tool_name_index(messages: &[ChatMessage]) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for m in messages {
        if let Some(calls) = &m.tool_calls {
            for tc in calls {
                if !tc.id.is_empty() {
                    map.insert(tc.id.clone(), tc.function.name.clone());
                }
            }
        }
    }
    map
}

fn tool_name_of<'a>(msg: &'a ChatMessage, index: &'a std::collections::HashMap<String, String>) -> &'a str {
    match (&msg.name, &msg.tool_call_id) {
        (Some(n), _) if !n.is_empty() => n.as_str(),
        (_, Some(id)) => index.get(id).map(|s| s.as_str()).unwrap_or(""),
        _ => "",
    }
}

/// Whether a tool result can be safely swept (Java `isSweepable`).
fn is_sweepable(msg: &ChatMessage, names: &std::collections::HashMap<String, String>) -> bool {
    let name = tool_name_of(msg, names).to_lowercase();
    if !SWEEPABLE_TOOLS.contains(&name.as_str()) {
        // Sub-agent returns, MCP tools, todo, bash_output: not reproducible or
        // too valuable to drop.
        return false;
    }
    let content = msg.content_text();
    if content.chars().count() < 200 {
        // Too small to be worth sweeping.
        return false;
    }
    // A background bash handle is one-shot and unreproducible: re-running bash
    // starts a *new* process and the old session_id is lost forever, so the
    // model could never query that task's output again.
    !content.contains("session_id:") && !content.contains("session_id=")
}

/// Start index of the trailing tool-call group (Java `lastToolCallGroupStart`).
///
/// Used as the hard protection boundary for sweeping. Sweeping runs at the start
/// of a reasoning turn, but the previous action turn may have just written a
/// whole *parallel* batch of results (say 8 concurrent reads). Protecting only
/// "the last N messages" would leave the earlier ones outside the boundary —
/// cleared before the model ever read them, so the tool work is wasted and the
/// model re-calls, gets cleared again, and loops.
fn last_tool_call_group_start(messages: &[ChatMessage]) -> usize {
    let n = messages.len();
    if n == 0 || !is_observation(&messages[n - 1]) {
        return n;
    }
    let mut i = n as isize - 1;
    while i >= 0 {
        let msg = &messages[i as usize];
        if is_observation(msg) {
            i -= 1;
            continue;
        }
        if is_assistant_with_calls(msg) {
            return i as usize;
        }
        break;
    }
    ((i + 1).max(0)) as usize
}

// ─── Per-message cap ──────────────────────────────────────────────────────────

/// Truncate any single message that alone exceeds half the budget (Java
/// `enforcePerMessageCap`).
///
/// Message-level compression cannot help when one message is bigger than the
/// whole window — a tool that read a huge file or a binary blob. Deleting
/// everything else still leaves that one message overflowing the request, so it
/// is capped first, establishing the invariant that no single message can own
/// more than its share of the window.
fn enforce_per_message_cap(messages: &mut Vec<ChatMessage>, budget: i64) -> bool {
    let cap = (budget / 2).max(2_000);
    let mut changed = false;
    for msg in messages.iter_mut() {
        // Multimodal messages are skipped: rewriting `Parts` would risk breaking
        // the content-block structure the provider validates.
        let text = match &msg.content {
            Some(MessageContent::Text(s)) => s.clone(),
            _ => continue,
        };
        if estimate_text_tokens(&text) <= cap {
            continue;
        }
        msg.content = Some(MessageContent::Text(truncate_head_tail(&text, cap)));
        changed = true;
    }
    changed
}

/// Keep the head and tail, drop the middle (Java's head/marker/tail truncation).
///
/// Both ends matter: the head says what was asked, the tail carries the exit
/// code, the final error, or the closing lines of a file.
fn truncate_head_tail(text: &str, cap: i64) -> String {
    let chars: Vec<char> = text.chars().collect();
    // ~4 chars per token for the mixed case; CJK-heavy text keeps more, which is
    // the safe direction (under-filling the cap rather than exceeding it).
    let keep = ((cap as usize) * 3).max(200);
    if chars.len() <= keep {
        return text.to_string();
    }
    let head_len = keep * 2 / 3;
    let tail_len = keep - head_len;
    let head: String = chars[..head_len].iter().collect();
    let tail: String = chars[chars.len() - tail_len..].iter().collect();
    format!(
        "{}\n...[内容过长已截断，省略 {} 字符]...\n{}",
        head,
        chars.len() - keep,
        tail
    )
}

// ─── Tool-output budget (Java `ToolSanitizerInterceptor`) ─────────────────────

/// Relaxed cap in **characters** — used while the context has room.
///
/// Matches Java's `CAP_RELAXED`, which is itself aligned with the terminal tool's
/// default output limit so that tightening the budget is the only thing that
/// changes what the model sees.
pub const OBSERVATION_CAP_RELAXED: usize = 64_000;
/// Moderate cap, applied from 60% context pressure.
pub const OBSERVATION_CAP_MODERATE: usize = 24_000;
/// Strict cap, applied from 75% context pressure.
pub const OBSERVATION_CAP_STRICT: usize = 8_000;

/// Head share of the kept window. The **tail is weighted more heavily** because
/// that is where a tool's conclusion lives: `[exit_code=N]`, `BUILD SUCCESS`,
/// `Tests run: x, Failures: y`, a stack trace's `Caused by`.
///
/// This is the whole reason the ratio is not 0.5. Java records the failure mode of
/// a head-only truncation: the model sees a wall of log and no verdict, then
/// either re-runs a build that already succeeded or reports a failure as a pass.
pub const OBSERVATION_HEAD_RATIO: f64 = 0.4;

/// Resolve the observation cap for one turn from context pressure.
///
/// `pressure` is `current_tokens / trigger_threshold` clamped to 1.0, i.e. the
/// same figure the compressor uses to decide whether to fire — so the two
/// mechanisms tighten together instead of fighting: capping output *at the source*
/// is the only lossless saving available, because a tool can be re-run with
/// pagination whereas a summarised-away passage cannot be recovered.
pub fn observation_cap(pressure: f64) -> usize {
    if pressure >= 0.75 {
        OBSERVATION_CAP_STRICT
    } else if pressure >= 0.60 {
        OBSERVATION_CAP_MODERATE
    } else {
        OBSERVATION_CAP_RELAXED
    }
}

/// Context pressure as a 0.0–1.0 fraction of the compression trigger threshold.
///
/// Java: `Math.min(1.0, currentTokens / budget)`. Denominator is the **trigger**
/// threshold, not the raw window: measuring against the window would report 0.4
/// pressure on a run that is one turn away from being compressed.
pub fn context_pressure(current_tokens: i64, config: &CompressionConfig) -> f64 {
    let budget = config.trigger_threshold();
    if budget <= 0 {
        return 0.0;
    }
    let p = current_tokens as f64 / budget as f64;
    p.clamp(0.0, 1.0)
}

/// Truncate a tool observation, keeping head and tail.
///
/// Deliberately **not** [`truncate_head_tail`]: that one is token-denominated and
/// head-weighted (2/3), because it trims a *whole message* during compression
/// where the opening usually carries the intent. This one is char-denominated and
/// tail-weighted, matching Java's `truncateKeepHeadTail`, because a tool
/// observation's verdict is at its end. Reusing the compression helper here would
/// silently flip which half of a build log the model gets to see.
///
/// Slicing is by `char` index, not byte offset: a fixed byte cut through CJK or
/// emoji produces an invalid sequence that serialises to U+FFFD, which is how
/// truncated output used to arrive at the model as garbage.
pub fn truncate_observation(raw: &str, cap: usize) -> String {
    if cap == 0 || raw.chars().count() <= cap {
        return raw.to_string();
    }
    let chars: Vec<char> = raw.chars().collect();
    let head = (cap as f64 * OBSERVATION_HEAD_RATIO) as usize;
    let tail = cap.saturating_sub(head).max(1);
    // `chars.len() > cap = head + tail` is the guard above, so this cannot underflow.
    let tail_start = chars.len() - tail;
    // Head and tail must not overlap after the rounding above.
    let head = head.min(tail_start.saturating_sub(1));
    let omitted = tail_start.saturating_sub(head);
    let head_str: String = chars[..head].iter().collect();
    let tail_str: String = chars[tail_start..].iter().collect();
    format!(
        "{}\n... [{} chars truncated — head and tail preserved. \
         Use pagination/offset to fetch the middle content.] ...\n{}",
        head_str, omitted, tail_str
    )
}

/// Sanitise one tool observation before it enters the context.
///
/// Also normalises an empty result to a visible placeholder: an empty-string
/// observation is indistinguishable from "the tool was never run", and the model
/// tends to re-call it — which for a side-effecting tool means doing the work twice.
pub fn sanitise_observation(text: &str, cap: usize) -> String {
    if text.trim().is_empty() {
        return "[No output from tool]".to_string();
    }
    truncate_observation(text, cap)
}

// ─── Free-tier sweep ──────────────────────────────────────────────────────────

/// Replace stale, reproducible tool results with a neutral placeholder.
///
/// Returns `None` when nothing was swept. **Message count and pairing are
/// preserved by construction** — only content is replaced — so no dangling tool
/// output can appear and the prompt-cache prefix is disturbed as little as
/// possible. This mirrors Anthropic's own `clear_tool_uses_20250919`.
///
/// Tool results are typically 70%+ of a coding agent's context, so most
/// compressions are satisfied here without spending anything.
fn sweep_stale_tool_results(messages: &[ChatMessage], cfg: &CompressionConfig) -> Option<Vec<ChatMessage>> {
    let names = tool_name_index(messages);
    // Protect the recent tail: observations the current task is relying on.
    let protect_from = messages
        .len()
        .saturating_sub(cfg.min_reserved_messages.max(cfg.max_messages / 2));
    // Turn-boundary hard protection (see `last_tool_call_group_start`).
    let protect_from = protect_from.min(last_tool_call_group_start(messages));

    let mut out = Vec::with_capacity(messages.len());
    let mut changed = false;
    for (i, msg) in messages.iter().enumerate() {
        if i >= protect_from || !is_tool_message(msg) || is_swept(msg) {
            out.push(msg.clone());
            continue;
        }
        if !is_sweepable(msg, &names) {
            out.push(msg.clone());
            continue;
        }
        let name = tool_name_of(msg, &names);
        let mut cleared = ChatMessage::tool_result(
            msg.tool_call_id.clone().unwrap_or_default(),
            cleared_placeholder(if name.is_empty() { "unknown" } else { name }),
        );
        cleared.name = msg.name.clone();
        out.push(cleared);
        changed = true;
    }
    if changed { Some(out) } else { None }
}

/// Neutral placeholder for a swept result.
///
/// The wording matters. "Re-run the tool if needed" actively invites the model
/// to re-call it — and re-calling produces another large result, pushing the
/// context back up, so "sweep → re-call → sweep" loops and costs *more* than
/// not sweeping at all. State the fact and leave the decision to the model.
fn cleared_placeholder(tool: &str) -> String {
    format!("{} · tool={}]", SWEPT_PREFIX, tool)
}

// ─── Atomic-pair alignment ────────────────────────────────────────────────────

/// Move a retention-window start index back to the head of its tool-call group
/// (Java `alignStartToToolCallGroup`).
///
/// Landing on a `tool` message would keep a result whose declaring
/// `assistant(tool_calls)` was compressed away — an orphan the provider rejects.
fn align_start_to_tool_call_group(messages: &[ChatMessage], start: usize, min: usize) -> usize {
    if start <= min || start >= messages.len() {
        return start;
    }
    let msg = &messages[start];
    if is_tool_message(msg) {
        let want_id = msg.tool_call_id.clone();
        let mut i = start as isize - 1;
        while i >= min as isize {
            let prev = &messages[i as usize];
            if is_assistant_with_calls(prev) {
                let matches = match &want_id {
                    Some(id) => prev
                        .tool_calls
                        .as_ref()
                        .map(|c| c.iter().any(|tc| &tc.id == id))
                        .unwrap_or(false),
                    None => true,
                };
                if matches {
                    return i as usize;
                }
            }
            if !is_observation(prev) {
                break;
            }
            i -= 1;
        }
    } else if is_observation(msg) {
        let mut i = start as isize - 1;
        while i >= min as isize {
            let prev = &messages[i as usize];
            if is_assistant_with_calls(prev) {
                return i as usize;
            }
            if !is_observation(prev) {
                break;
            }
            i -= 1;
        }
    }
    start
}

/// Drop tool outputs whose declaring assistant turn is missing or incomplete
/// (Java `removeDanglingToolOutputs`).
///
/// The final invariant guard. An `assistant(tool_calls)` is kept only when
/// **every** declared call has a matching result; otherwise the whole group is
/// dropped. Sending a partial group is exactly the "No tool output found for
/// tool call …" 400 that this kernel's history-rebuild path already had to work
/// around, so it must never be produced here.
fn remove_dangling_tool_outputs(messages: &[ChatMessage]) -> Vec<ChatMessage> {
    let mut out: Vec<ChatMessage> = Vec::with_capacity(messages.len());
    let mut i = 0usize;
    while i < messages.len() {
        let msg = &messages[i];
        if is_assistant_with_calls(msg) {
            let required: Vec<String> = msg
                .tool_calls
                .as_ref()
                .map(|c| c.iter().filter(|tc| !tc.id.is_empty()).map(|tc| tc.id.clone()).collect())
                .unwrap_or_default();

            // Collect the contiguous run of tool outputs that follows.
            let mut j = i + 1;
            let mut outputs: Vec<&ChatMessage> = Vec::new();
            while j < messages.len() && is_observation(&messages[j]) {
                outputs.push(&messages[j]);
                j += 1;
            }

            let completed = if required.is_empty() {
                !outputs.is_empty()
            } else {
                required.iter().all(|id| {
                    outputs
                        .iter()
                        .any(|o| o.tool_call_id.as_deref() == Some(id.as_str()))
                })
            };

            if completed {
                out.push(msg.clone());
                for o in outputs {
                    // Keep only results belonging to this assistant turn.
                    let keep = match &o.tool_call_id {
                        Some(id) => required.is_empty() || required.contains(id),
                        None => true,
                    };
                    if keep {
                        out.push((*o).clone());
                    }
                }
            }
            i = j;
            continue;
        }
        if is_observation(msg) {
            // A tool output with no declaring assistant turn: drop it.
            i += 1;
            continue;
        }
        out.push(msg.clone());
        i += 1;
    }
    out
}

/// Zero-cost fallback for an expired segment (Java `captureTailToolGroup`).
///
/// The expired range can end mid-group. Dropping it wholesale would leave the
/// retained window starting with an orphan `tool` message, so the last complete
/// tool-use sequence is carried over instead.
fn capture_tail_tool_group(segment: &[ChatMessage]) -> Vec<ChatMessage> {
    if segment.is_empty() {
        return Vec::new();
    }
    let mut start = segment.len() - 1;
    while start > 0 {
        let msg = &segment[start];
        if is_observation(msg) {
            start -= 1;
            continue;
        }
        if is_assistant_with_calls(msg) {
            return segment[start..].to_vec();
        }
        // Unrelated message (user, or an assistant thought): step back so at
        // least one tool output survives — keeping a slightly odd tail is better
        // than emitting an orphan.
        if start < segment.len() - 1 {
            start += 1;
        }
        return segment[start..].to_vec();
    }
    segment[start..].to_vec()
}

// ─── First chain + intent chain ───────────────────────────────────────────────

/// Index just past the protected "first chain" (Java `META_FIRST`).
///
/// Java tags the system prompt and the user's original question with metadata.
/// This kernel's `ChatMessage` carries no metadata, so the same set is
/// identified positionally: the leading system messages plus the first user
/// message after them. Those are exactly the messages the server prepends and
/// appends when it builds a run's history.
fn first_chain_end(messages: &[ChatMessage]) -> usize {
    let mut i = 0;
    while i < messages.len() && messages[i].role == Role::System {
        i += 1;
    }
    if i < messages.len() && messages[i].role == Role::User {
        i += 1;
    }
    i
}

/// Build the intent chain: every user ask so far, briefly (Java
/// `buildIntentChain`).
///
/// Cheap and high-value. A user message runs 50-200 tokens, so even 30 turns
/// cost 1.5-6K — less than a third of one bash output — while being the only
/// evidence of whether the goal has moved. Without it a long session keeps
/// circling an objective that was finished twenty turns ago.
///
/// Injected system prompts (self-reflection, loop warnings, completion checks)
/// are excluded: they are engine scaffolding, not user intent, and including
/// them would make the chain grow with every injection.
fn build_intent_chain(messages: &[ChatMessage], first_end: usize) -> Option<ChatMessage> {
    let mut lines: Vec<String> = Vec::new();
    for msg in &messages[first_end..] {
        if msg.role != Role::User {
            continue;
        }
        let text = msg.content_text();
        let trimmed = text.trim();
        if trimmed.is_empty() || is_observation(msg) {
            continue;
        }
        if trimmed.starts_with("【系统指令") || trimmed.starts_with("【系统提示") {
            continue;
        }
        let brief: String = trimmed.chars().take(INTENT_BRIEF_CHARS).collect();
        let suffix = if trimmed.chars().count() > INTENT_BRIEF_CHARS { "…" } else { "" };
        lines.push(format!("{}. {}{}", lines.len() + 1, brief, suffix));
    }
    // Fewer than two turns means no drift is possible yet; skip it rather than
    // spend tokens for nothing.
    if lines.len() < 2 {
        return None;
    }
    Some(ChatMessage::user(format!(
        "【会话意图链 (Intent Chain)】\n以下是用户在本会话中先后提出的全部诉求，用于防止目标漂移。请以最后一条为当前焦点，前面的条目若已完成则不必重复处理：\n{}",
        lines.join("\n")
    )))
}

// ─── Main entry ───────────────────────────────────────────────────────────────

/// Run one compression pass over a working-memory snapshot.
///
/// `system_tokens` and `tools_tokens` are the fixed per-request overheads; both
/// count against the window and must be included, or the trigger fires late.
///
/// `force` bypasses the trigger threshold entirely (Java
/// `HarnessEngine.requestCompact`, set by `/compact`). The user asked for a
/// compression now, so "we are still under budget" is not a reason to skip —
/// though there may genuinely be nothing to reclaim, in which case the outcome
/// simply reports `compressed: false`.
pub fn compress(
    mut messages: Vec<ChatMessage>,
    cfg: &CompressionConfig,
    system_tokens: i64,
    tools_tokens: i64,
    cal: &Calibration,
    force: bool,
    focus: Option<&str>,
) -> CompressionOutcome {
    let before_count = messages.len();
    let budget = cfg.trigger_threshold();

    // 0. Per-message cap first: it is the only thing that can fix a single
    //    message larger than the window.
    enforce_per_message_cap(&mut messages, budget);

    let raw = estimate_tokens(&messages, system_tokens, tools_tokens);
    let current = calibrate(&messages, raw, cal, system_tokens, tools_tokens);
    let projected = current + cfg.max_turn_growth();

    // Predictive trigger: ask not only "are we over?" but "will the next turn
    // fit?". Waiting until the request actually overflows means it has already
    // been sent and may already have been rejected.
    //
    // `force` skips this early return: a manual `/compact` must run even when the
    // context is comfortably small, because the point is to reclaim window and
    // refocus, not to avoid an overflow.
    if !force && current <= budget && projected <= budget {
        let after_count = messages.len();
        return CompressionOutcome {
            messages,
            before_tokens: current,
            after_tokens: current,
            before_count,
            after_count,
            compressed: false,
        };
    }

    let target = cfg.target_budget(budget);

    // 0.5 Free tier: try the cheap thing before anything else.
    if let Some(swept) = sweep_stale_tool_results(&messages, cfg) {
        let swept_tokens = estimate_tokens(&swept, system_tokens, tools_tokens);
        if swept_tokens <= target {
            // The sweep-only early return used to skip the focus injection
            // below entirely, silently dropping a `/compact <focus>`
            // instruction. Even when the sweep alone is enough, the user's
            // focus must land in the retained window — same guarantee as the
            // full rebuild path.
            let mut kept = swept;
            if let Some(f) = focus.map(str::trim).filter(|f| !f.is_empty()) {
                kept.push(ChatMessage::user(format!(
                    "【压缩聚焦 (Compact Focus)】\n用户在压缩上下文时指定了聚焦方向：{}\n请在后续推理中优先围绕该焦点推进。",
                    f
                )));
            }
            let swept_after = estimate_tokens(&kept, system_tokens, tools_tokens);
            return CompressionOutcome {
                before_tokens: current,
                after_tokens: swept_after,
                before_count,
                after_count: kept.len(),
                messages: kept,
                compressed: true,
            };
        }
        // Not enough on its own: keep the gains and continue (the focus is
        // injected later on the full rebuild path).
        messages = swept;
    }

    let first_end = first_chain_end(&messages);
    let first_list: Vec<ChatMessage> = messages[..first_end].to_vec();
    let intent_chain = build_intent_chain(&messages, first_end);

    // 2. Fixed, incompressible overhead.
    let mut fixed = system_tokens + MSG_OVERHEAD;
    for m in &first_list {
        fixed += estimate_message(m) + MSG_OVERHEAD;
    }

    // Extreme case: the protected part alone exceeds the budget. Keep the first
    // chain and nothing else — losing history beats failing the request.
    if fixed >= budget {
        let mut kept = first_list.clone();
        if let Some(ic) = intent_chain.clone() {
            kept.push(ic);
        }
        kept = remove_dangling_tool_outputs(&kept);
        let after = estimate_tokens(&kept, system_tokens, tools_tokens);
        return CompressionOutcome {
            before_tokens: current,
            after_tokens: after,
            before_count,
            after_count: kept.len(),
            messages: kept,
            compressed: true,
        };
    }

    // 3. Room left for the retained window, based on the *target* (not the
    //    trigger) so one pass frees enough to last.
    let available = (target - fixed).max(1);
    let summary_reserve = ((available as f64) * 0.1) as i64;
    let summary_reserve = summary_reserve.max(200);
    let intent_tokens = intent_chain
        .as_ref()
        .map(|m| estimate_message(m) + MSG_OVERHEAD)
        .unwrap_or(0);
    let window_budget = (available - summary_reserve - intent_tokens).max(1);

    // 4. Dual-dimension cut point.
    let target_by_count = (first_end).max(messages.len().saturating_sub(cfg.max_messages));

    let mut target_by_tokens = first_end;
    let mut running = 0i64;
    let mut i = messages.len() as isize - 1;
    while i > first_end as isize {
        running += estimate_message(&messages[i as usize]) + MSG_OVERHEAD;
        if running > window_budget {
            target_by_tokens = (i as usize).max(first_end);
            break;
        }
        i -= 1;
    }

    // Absolute floor: however tight the budget, keep at least
    // `min_reserved_messages`. Without it one large file read can eat the whole
    // budget and leave the agent with a single message of history, throwing away
    // everything it had done.
    let min_reserved_idx = (first_end).max(messages.len().saturating_sub(cfg.min_reserved_messages));

    let mut target_idx = target_by_count.max(target_by_tokens.min(min_reserved_idx));
    target_idx = align_start_to_tool_call_group(&messages, target_idx, first_end);

    // 5. Atomic-pair alignment: never start the window on a tool result.
    while target_idx > first_end && target_idx < messages.len() {
        let msg = &messages[target_idx];
        if is_observation(msg) {
            target_idx -= 1;
        } else {
            break;
        }
    }

    // 6. Semantic coherence: if the message just before the cut is a bare
    //    assistant thought, pull it in so the model sees the reasoning that led
    //    to the retained actions.
    if target_idx > first_end {
        let prev = &messages[target_idx - 1];
        if prev.role == Role::Assistant && !is_assistant_with_calls(prev) {
            target_idx -= 1;
        }
    }

    // 7. Rebuild.
    let mut compressed: Vec<ChatMessage> = Vec::with_capacity(messages.len());
    compressed.extend(first_list);
    if let Some(ic) = intent_chain {
        // Intent chain goes right after the first chain: tell the model what the
        // user has asked for and what the current focus is *before* the history.
        compressed.push(ic);
    }

    // A `/compact <focus>` instruction becomes an explicit user turn at the head
    // of the retained window. This is the zero-cost way to honour the focus: the
    // compressor cannot semantically choose *which* messages survive (that needs
    // the LLM-summary strategy Java has and this kernel does not), but it can
    // guarantee the model sees the user's stated focus before the trimmed history,
    // so the next turn steers by it. It sits before the tail/retained history so
    // it never splits a tool group; `remove_dangling_tool_outputs` below is the
    // final pairing guard either way.
    if let Some(f) = focus.map(str::trim).filter(|f| !f.is_empty()) {
        compressed.push(ChatMessage::user(format!(
            "【压缩聚焦 (Compact Focus)】\n用户在压缩上下文时指定了聚焦方向：{}\n请在后续推理中优先围绕该焦点推进。",
            f
        )));
    }

    if target_idx > first_end && target_idx <= messages.len() {
        let expired = &messages[first_end..target_idx];
        // Zero-cost path: carry over the last complete tool group so the retained
        // window never begins with an orphan. An LLM-generated summary would go
        // here; Java falls back to exactly this when no strategy is configured.
        compressed.extend(capture_tail_tool_group(expired));
    }
    compressed.extend_from_slice(&messages[target_idx.min(messages.len())..]);

    // 8. Final invariant guard.
    let before_size = messages.len();
    compressed = remove_dangling_tool_outputs(&compressed);

    let after = estimate_tokens(&compressed, system_tokens, tools_tokens);
    let changed = compressed.len() != before_size || after != current;
    CompressionOutcome {
        before_tokens: current,
        after_tokens: after,
        before_count,
        after_count: compressed.len(),
        messages: if changed { compressed } else { messages },
        compressed: changed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::{FunctionCall, ToolCall};

    fn cfg() -> CompressionConfig {
        CompressionConfig {
            context_length: 256_000,
            ratio: 100,
            target_ratio: 45,
            reserved_output: 20_000,
            max_messages: 30,
            min_reserved_messages: 10,
        }
    }

    fn call(id: &str, name: &str, args: &str) -> ToolCall {
        ToolCall {
            id: id.to_string(),
            call_type: "function".into(),
            function: FunctionCall { name: name.into(), arguments: args.into() },
        }
    }

    // ─── Tool-output budget ──────────────────────────────────────────────────

    /// The three pressure bands must map onto Java's three caps. Getting a
    /// boundary wrong is silent and expensive: too loose and the context blows up
    /// anyway, too strict and the model loses output on runs that had room.
    #[test]
    fn observation_cap_follows_the_pressure_bands() {
        assert_eq!(observation_cap(0.0), OBSERVATION_CAP_RELAXED);
        assert_eq!(observation_cap(0.59), OBSERVATION_CAP_RELAXED);
        // Boundaries are inclusive on the tight side (Java uses `>=`).
        assert_eq!(observation_cap(0.60), OBSERVATION_CAP_MODERATE);
        assert_eq!(observation_cap(0.74), OBSERVATION_CAP_MODERATE);
        assert_eq!(observation_cap(0.75), OBSERVATION_CAP_STRICT);
        assert_eq!(observation_cap(1.0), OBSERVATION_CAP_STRICT);
        // Monotonically non-increasing.
        assert!(OBSERVATION_CAP_RELAXED > OBSERVATION_CAP_MODERATE);
        assert!(OBSERVATION_CAP_MODERATE > OBSERVATION_CAP_STRICT);
    }

    /// Java's relaxed cap matches this kernel's terminal output limit; the numbers
    /// are a contract with the tools, not arbitrary.
    #[test]
    fn observation_caps_match_java() {
        assert_eq!(OBSERVATION_CAP_RELAXED, 64_000);
        assert_eq!(OBSERVATION_CAP_MODERATE, 24_000);
        assert_eq!(OBSERVATION_CAP_STRICT, 8_000);
        assert!((OBSERVATION_HEAD_RATIO - 0.4).abs() < f64::EPSILON);
    }

    /// Pressure is measured against the **trigger threshold**, not the raw window.
    /// With the 256K default config the threshold is 223_000; measuring against
    /// 256_000 instead would report 0.87 as 0.76 and pick the wrong band.
    #[test]
    fn pressure_uses_the_trigger_threshold_as_denominator() {
        let c = cfg();
        let threshold = c.trigger_threshold();
        assert_eq!(threshold, 223_000, "threshold must match the compression trigger");

        assert!((context_pressure(0, &c) - 0.0).abs() < 1e-9);
        assert!((context_pressure(threshold / 2, &c) - 0.5).abs() < 1e-6);
        assert!((context_pressure(threshold, &c) - 1.0).abs() < 1e-9);
        // Clamped: a run that overshot must not report >1.0 and flip the band logic.
        assert!((context_pressure(threshold * 4, &c) - 1.0).abs() < 1e-9);
    }

    /// Pressure and cap must move together — the point of the mechanism is that
    /// the two tighten as one rather than the compressor fighting a fat observation.
    #[test]
    fn pressure_and_cap_tighten_together() {
        let c = cfg();
        let threshold = c.trigger_threshold();
        assert_eq!(observation_cap(context_pressure(0, &c)), OBSERVATION_CAP_RELAXED);
        assert_eq!(
            observation_cap(context_pressure((threshold as f64 * 0.7) as i64, &c)),
            OBSERVATION_CAP_MODERATE
        );
        assert_eq!(
            observation_cap(context_pressure((threshold as f64 * 0.9) as i64, &c)),
            OBSERVATION_CAP_STRICT
        );
    }

    /// A degenerate window must saturate at full pressure rather than divide by
    /// zero or report a comfortable 0.0.
    ///
    /// `trigger_threshold` ends in `.max(1)`, so the denominator is never 0 — and
    /// the honest reading of "10K tokens against a 1-token budget" is *maximum*
    /// pressure, which selects the strict cap. That is the safe direction: a
    /// mis-sized window loses output detail instead of blowing the context.
    #[test]
    fn a_degenerate_window_saturates_at_full_pressure() {
        let mut c = cfg();
        c.context_length = 0;
        // The threshold floors at 1 rather than reaching 0.
        assert_eq!(c.trigger_threshold(), 1);
        assert_eq!(context_pressure(10_000, &c), 1.0);
        assert_eq!(observation_cap(context_pressure(10_000, &c)), OBSERVATION_CAP_STRICT);
        // Even with no tokens the budget is positive, so no division by zero.
        assert_eq!(context_pressure(0, &c), 0.0);
    }

    /// The `budget <= 0` guard in `context_pressure` is unreachable today because
    /// `trigger_threshold` floors at 1. It stays as cheap defence against that
    /// floor being removed; this test pins the invariant that makes it dead code,
    /// so removing the floor without revisiting the guard fails here.
    #[test]
    fn trigger_threshold_is_always_positive() {
        for ctx in [0i64, 1, 10, 1_000, 32_000, 256_000, 1_000_000] {
            let c = CompressionConfig { context_length: ctx, ..cfg() };
            assert!(c.trigger_threshold() >= 1, "ctx {} gave {}", ctx, c.trigger_threshold());
        }
    }

    /// **The load-bearing property.** A tool's verdict lives at the end of its
    /// output — `[exit_code=N]`, `BUILD SUCCESS`, `Tests run: …`. Head-only
    /// truncation leaves the model with a wall of log and no conclusion, and the
    /// observed consequence was re-running builds that had already succeeded.
    #[test]
    fn truncation_preserves_the_tail_where_the_verdict_lives() {
        let head = "line\n".repeat(2_000); // noise
        let tail = "\nBUILD SUCCESS [exit_code=0]";
        let raw = format!("{}{}", head, tail);

        let out = truncate_observation(&raw, 1_000);
        assert!(
            out.contains("BUILD SUCCESS [exit_code=0]"),
            "the verdict must survive truncation: {}",
            &out[out.len().saturating_sub(200)..]
        );
        assert!(out.starts_with("line\n"), "the head must survive too");
    }

    /// The tail must get the larger share. This is what distinguishes the
    /// observation cap from the compression helper's head-weighted 2/3 split;
    /// reusing that helper here would silently flip which half a build log keeps.
    #[test]
    fn tail_share_is_larger_than_head_share() {
        let raw: String = (0..10_000).map(|i| char::from(b'a' + (i % 26) as u8)).collect();
        let cap = 1_000;
        let out = truncate_observation(&raw, cap);

        let marker = out.find("chars truncated").expect("marker present");
        let head_len = out[..marker].chars().count();
        // Everything after the marker line is the tail.
        let after_marker = &out[marker..];
        let tail_len = after_marker[after_marker.rfind(']').unwrap()..].chars().count();

        assert!(
            tail_len > head_len,
            "tail ({}) must outweigh head ({})",
            tail_len,
            head_len
        );
        let ratio = head_len as f64 / (head_len + tail_len) as f64;
        assert!(
            (ratio - OBSERVATION_HEAD_RATIO).abs() < 0.05,
            "head share {} should be ~{}",
            ratio,
            OBSERVATION_HEAD_RATIO
        );
    }

    /// Kept content must respect the cap. The marker itself adds a little overhead
    /// (Java behaves the same way), so the assertion is on the kept text, not on
    /// the whole string — otherwise a longer marker would look like a budget leak.
    #[test]
    fn kept_content_stays_within_the_cap() {
        let raw = "x".repeat(50_000);
        for cap in [OBSERVATION_CAP_STRICT, OBSERVATION_CAP_MODERATE, OBSERVATION_CAP_RELAXED, 100] {
            let out = truncate_observation(&raw, cap);
            let kept = out.chars().count() - marker_len(&out);
            assert!(
                kept <= cap + 2,
                "cap {}: kept {} chars",
                cap,
                kept
            );
        }
    }

    /// Length of the injected marker line, so the cap test above can subtract it.
    fn marker_len(out: &str) -> usize {
        out.lines()
            .find(|l| l.contains("chars truncated"))
            .map(|l| l.chars().count() + 2) // + the two surrounding newlines
            .unwrap_or(0)
    }

    /// Text already under the cap must pass through byte-identical. Adding a
    /// marker to short output would teach the model that every result is partial.
    #[test]
    fn short_output_is_untouched() {
        let raw = "BUILD SUCCESS [exit_code=0]";
        assert_eq!(truncate_observation(raw, 1_000), raw);
        assert!(!truncate_observation(raw, 1_000).contains("truncated"));
        // Exactly at the cap is not over it.
        let exact = "y".repeat(1_000);
        assert_eq!(truncate_observation(&exact, 1_000), exact);
    }

    /// CJK and emoji must survive: a byte-offset cut through a multi-byte sequence
    /// yields U+FFFD, which is how truncated output used to reach the model as
    /// garbage. Slicing by `char` is what prevents it.
    #[test]
    fn multibyte_content_is_never_split() {
        let raw = "中文日志行\n".repeat(3_000) + "构建成功 ✅ [exit_code=0]";
        let out = truncate_observation(&raw, 2_000);
        assert!(
            !out.contains('\u{FFFD}'),
            "truncation produced a replacement character"
        );
        assert!(
            out.contains("构建成功"),
            "the CJK verdict must survive: {}",
            &out[out.len().saturating_sub(120)..]
        );
        // Round-trips as valid UTF-8 through JSON, which is how it reaches the wire.
        let json = serde_json::to_string(&out).expect("must serialise");
        assert!(!json.contains("\\ufffd"), "{}", json);
    }

    /// A cap of 0 must not panic or slice out of range.
    #[test]
    fn degenerate_caps_are_safe() {
        assert_eq!(truncate_observation("abc", 0), "abc");
        assert_eq!(truncate_observation("", 100), "");
        // cap=1: head rounds to 0, tail takes everything kept.
        let out = truncate_observation("abcdefghij", 1);
        assert!(!out.is_empty());
        assert!(out.contains('j'), "tail must survive even at cap=1: {}", out);
    }

    /// An empty observation becomes a visible placeholder. An empty string is
    /// indistinguishable from "the tool never ran", and the model's response is to
    /// call it again — which for a side-effecting tool means doing the work twice.
    #[test]
    fn empty_output_becomes_a_placeholder() {
        assert_eq!(sanitise_observation("", 1_000), "[No output from tool]");
        assert_eq!(sanitise_observation("   \n\t ", 1_000), "[No output from tool]");
        // Real content is untouched.
        assert_eq!(sanitise_observation("ok", 1_000), "ok");
        // Whitespace-padding around real content is preserved, not treated as empty.
        assert_eq!(sanitise_observation("  ok  ", 1_000), "  ok  ");
    }

    /// The marker must point at pagination rather than invite a blind re-run:
    /// re-running a side-effecting tool to "get the full output" can apply its
    /// effects twice.
    #[test]
    fn marker_directs_to_pagination_not_to_a_rerun() {
        let out = truncate_observation(&"z".repeat(5_000), 1_000);
        assert!(out.contains("pagination/offset"), "{}", out);
        assert!(out.contains("head and tail preserved"), "{}", out);
        assert!(
            !out.to_lowercase().contains("re-run"),
            "the marker must not suggest re-running the tool: {}",
            out
        );
        // The omitted count must be real, not zero.
        let omitted: usize = out
            .split('[')
            .nth(1)
            .unwrap()
            .split_whitespace()
            .next()
            .unwrap()
            .parse()
            .unwrap();
        assert!(omitted > 3_000, "omitted {} seems wrong for a 5000-char input", omitted);
    }

    fn assistant_calling(id: &str, name: &str) -> ChatMessage {
        ChatMessage {
            role: Role::Assistant,
            content: None,
            tool_calls: Some(vec![call(id, name, "{}")]),
            tool_call_id: None,
            name: None,
        }
    }

    fn tool_msg(id: &str, body: &str) -> ChatMessage {
        ChatMessage::tool_result(id, body)
    }

    #[test]
    fn threshold_uses_absolute_reserve_not_percentage() {
        // 256K window: reserved 20K → effective 236K; buffer 13K → 223K.
        assert_eq!(cfg().trigger_threshold(), 223_000);
    }

    #[test]
    fn threshold_floor_keeps_half_of_small_window() {
        let mut c = cfg();
        c.context_length = 20_000;
        // reserved = min(20000, 5000) = 5000 → effective 15000; buffer
        // min(13000, 7500) = 7500 → 7500; floor = 10000 wins.
        assert_eq!(c.trigger_threshold(), 10_000);
    }

    #[test]
    fn ratio_can_only_pull_trigger_earlier() {
        let mut c = cfg();
        c.ratio = 50;
        // byRatio = 128000 < 223000 → 128000; floor 128000 → 128000.
        assert_eq!(c.trigger_threshold(), 128_000);
        c.ratio = 99;
        // byRatio = 253440 > 223000 → stays 223000 (never pushed later).
        assert_eq!(c.trigger_threshold(), 223_000);
    }

    #[test]
    fn target_never_exceeds_trigger() {
        let c = cfg();
        let t = c.trigger_threshold();
        assert!(c.target_budget(t) <= t);
        // effective 236K × 45% = 106200
        assert_eq!(c.target_budget(t), 106_200);
    }

    #[test]
    fn healthy_context_is_left_untouched() {
        let msgs = vec![
            ChatMessage::system("sys"),
            ChatMessage::user("do a thing"),
            ChatMessage::assistant("done"),
        ];
        let out = compress(msgs.clone(), &cfg(), 10, 100, &Calibration::default(), false, None);
        assert!(!out.compressed, "small context must not be rewritten");
        assert_eq!(out.messages.len(), 3);
    }

    #[test]
    fn sweep_preserves_message_count_and_pairing() {
        // Build a long history of read calls with big results.
        let mut msgs = vec![ChatMessage::system("sys"), ChatMessage::user("task")];
        for i in 0..40 {
            msgs.push(assistant_calling(&format!("c{i}"), "read"));
            msgs.push(tool_msg(&format!("c{i}"), &"x".repeat(5_000)));
        }
        let before = msgs.len();
        let swept = sweep_stale_tool_results(&msgs, &cfg()).expect("should sweep");
        assert_eq!(swept.len(), before, "sweeping must never change message count");
        // Every assistant(tool_calls) still has its matching tool result.
        let cleaned = remove_dangling_tool_outputs(&swept);
        assert_eq!(cleaned.len(), before, "no pairing may be broken by sweeping");
        assert!(swept.iter().any(|m| is_swept(m)));
    }

    #[test]
    fn sweep_protects_the_trailing_parallel_batch() {
        // One assistant turn declaring 8 parallel reads, all results at the tail.
        let mut msgs = vec![ChatMessage::system("sys"), ChatMessage::user("task")];
        for i in 0..20 {
            msgs.push(assistant_calling(&format!("old{i}"), "read"));
            msgs.push(tool_msg(&format!("old{i}"), &"y".repeat(3_000)));
        }
        let ids: Vec<String> = (0..8).map(|i| format!("cur{i}")).collect();
        msgs.push(ChatMessage {
            role: Role::Assistant,
            content: None,
            tool_calls: Some(ids.iter().map(|id| call(id, "read", "{}")).collect()),
            tool_call_id: None,
            name: None,
        });
        for id in &ids {
            msgs.push(tool_msg(id, &"z".repeat(3_000)));
        }
        let swept = sweep_stale_tool_results(&msgs, &cfg()).expect("old ones should sweep");
        // None of the current batch may be cleared: the model has not read them yet.
        for id in &ids {
            let m = swept.iter().find(|m| m.tool_call_id.as_deref() == Some(id.as_str())).unwrap();
            assert!(!is_swept(m), "trailing batch result {id} must be protected");
        }
    }

    #[test]
    fn write_and_edit_results_are_never_swept() {
        let mut msgs = vec![ChatMessage::system("sys"), ChatMessage::user("task")];
        for i in 0..30 {
            msgs.push(assistant_calling(&format!("w{i}"), "write"));
            msgs.push(tool_msg(&format!("w{i}"), &"q".repeat(5_000)));
        }
        assert!(
            sweep_stale_tool_results(&msgs, &cfg()).is_none(),
            "side-effecting tools must not be swept"
        );
    }

    #[test]
    fn background_session_handle_is_never_swept() {
        let mut msgs = vec![ChatMessage::system("sys"), ChatMessage::user("task")];
        for i in 0..30 {
            msgs.push(assistant_calling(&format!("b{i}"), "bash"));
            let body = if i == 5 {
                format!("Background task started. session_id=bg-abc{}", "p".repeat(5_000))
            } else {
                "r".repeat(5_000)
            };
            msgs.push(tool_msg(&format!("b{i}"), &body));
        }
        let swept = sweep_stale_tool_results(&msgs, &cfg()).unwrap();
        let handle = swept.iter().find(|m| m.tool_call_id.as_deref() == Some("b5")).unwrap();
        assert!(!is_swept(handle), "one-shot background handle must survive");
        assert!(handle.content_text().contains("session_id=bg-abc"));
    }

    /// Assert the pairing invariant on a compressed result: no `tool` message
    /// without a preceding assistant that declared it, and no declared call
    /// without its result. Violating either is a hard 400 from an
    /// OpenAI-compatible provider.
    fn assert_pairing(messages: &[ChatMessage]) {
        let mut declared: std::collections::HashSet<String> = std::collections::HashSet::new();
        for m in messages {
            if let Some(calls) = &m.tool_calls {
                for tc in calls {
                    declared.insert(tc.id.clone());
                }
            }
            if m.role == Role::Tool {
                let id = m.tool_call_id.clone().unwrap_or_default();
                assert!(declared.contains(&id), "orphan tool result for {id}");
            }
        }
        for m in messages {
            if let Some(calls) = &m.tool_calls {
                for tc in calls {
                    assert!(
                        messages.iter().any(|o| o.tool_call_id.as_deref() == Some(tc.id.as_str())),
                        "missing tool output for {}", tc.id
                    );
                }
            }
        }
    }

    /// Build a history big enough to actually cross the trigger.
    ///
    /// 256K window → trigger 223K, and the predictive check adds 36K, so the
    /// history must exceed ~187K estimated tokens. 120 rounds × 9000 chars
    /// (≈2250 tokens each) lands near 270K. A smaller fixture silently tests
    /// nothing: compression never runs and every assertion passes vacuously.
    fn big_history(tool: &str) -> Vec<ChatMessage> {
        let mut msgs = vec![ChatMessage::system("sys"), ChatMessage::user("original task")];
        for i in 0..120 {
            msgs.push(assistant_calling(&format!("c{i}"), tool));
            msgs.push(tool_msg(&format!("c{i}"), &"x".repeat(9_000)));
            msgs.push(ChatMessage::assistant(format!("thought {i}")));
        }
        msgs
    }

    #[test]
    fn trimming_path_never_emits_orphan_tool_results() {
        // `write` is not sweepable, so the free tier cannot help and the real
        // message-removal path runs — the one that can actually orphan a result.
        let msgs = big_history("write");
        let out = compress(msgs.clone(), &cfg(), 500, 2_000, &Calibration::default(), false, None);
        assert!(out.compressed, "270K tokens against a 223K trigger must compress");
        assert!(out.after_count < msgs.len(), "trimming must remove messages");
        assert_pairing(&out.messages);
    }

    #[test]
    fn sweep_path_never_emits_orphan_tool_results() {
        // `read` is sweepable: the free tier handles it without removing anything.
        let msgs = big_history("read");
        let out = compress(msgs.clone(), &cfg(), 500, 2_000, &Calibration::default(), false, None);
        assert!(out.compressed);
        assert_pairing(&out.messages);
    }

    #[test]
    fn compression_actually_reduces_tokens() {
        let msgs = big_history("write");
        let out = compress(msgs, &cfg(), 500, 2_000, &Calibration::default(), false, None);
        assert!(
            out.after_tokens < out.before_tokens,
            "compression must reduce the estimate: {} -> {}", out.before_tokens, out.after_tokens
        );
    }

    #[test]
    fn first_chain_and_system_prompt_survive_compression() {
        let mut msgs = vec![
            ChatMessage::system("SYSTEM PROMPT"),
            ChatMessage::user("THE ORIGINAL QUESTION"),
        ];
        for i in 0..60 {
            msgs.push(assistant_calling(&format!("c{i}"), "read"));
            msgs.push(tool_msg(&format!("c{i}"), &"x".repeat(9_000)));
        }
        let out = compress(msgs, &cfg(), 100, 1_000, &Calibration::default(), false, None);
        assert_eq!(out.messages[0].content_text(), "SYSTEM PROMPT");
        assert_eq!(out.messages[1].content_text(), "THE ORIGINAL QUESTION");
    }

    #[test]
    fn per_message_cap_bounds_a_single_huge_result() {
        let mut msgs = vec![
            ChatMessage::system("sys"),
            ChatMessage::user("task"),
            assistant_calling("c0", "read"),
            tool_msg("c0", &"x".repeat(4_000_000)),
        ];
        let budget = cfg().trigger_threshold();
        assert!(enforce_per_message_cap(&mut msgs, budget));
        let t = estimate_message(&msgs[3]);
        assert!(t <= budget, "capped message {t} must fit in budget {budget}");
    }

    #[test]
    fn cjk_text_costs_more_than_ascii_of_same_length() {
        let ascii = "a".repeat(400);
        let cjk = "中".repeat(400);
        assert!(estimate_text_tokens(&cjk) > estimate_text_tokens(&ascii));
        assert_eq!(estimate_text_tokens(&ascii), 100);
        assert_eq!(estimate_text_tokens(&cjk), 400);
    }

    #[test]
    fn calibration_is_clamped_and_ignores_shrunk_history() {
        let msgs = vec![ChatMessage::system("s"); 10];
        let base = estimate_tokens(&msgs, 0, 0);
        // Wildly high real value → factor clamps at 2.0.
        let hi = calibrate(&msgs, base, &Calibration { real_tokens: base * 100, real_message_count: 10 }, 0, 0);
        assert_eq!(hi, base * 2);
        // Wildly low → clamps at 0.5.
        let lo = calibrate(&msgs, base, &Calibration { real_tokens: 1, real_message_count: 10 }, 0, 0);
        assert_eq!(lo, (base as f64 * 0.5) as i64);
        // Anchor describes more messages than we now have → untrusted.
        let skip = calibrate(&msgs, base, &Calibration { real_tokens: base * 4, real_message_count: 50 }, 0, 0);
        assert_eq!(skip, base);
    }

    #[test]
    fn intent_chain_collects_user_asks_and_skips_injections() {
        // Two *real* asks must follow the first chain: the chain needs at least
        // two turns before goal drift is even possible.
        let msgs = vec![
            ChatMessage::system("sys"),
            ChatMessage::user("first ask"),
            ChatMessage::assistant("ok"),
            ChatMessage::user("【系统指令：自我反思 (Self-Reflection)】blah"),
            ChatMessage::user("second ask"),
            ChatMessage::assistant("ok"),
            ChatMessage::user("【系统提示：检测到潜在循环 (Loop Detected)】blah"),
            ChatMessage::user("third ask"),
        ];
        let chain = build_intent_chain(&msgs, first_chain_end(&msgs)).expect("two real asks");
        let text = chain.content_text();
        assert!(text.contains("second ask"));
        assert!(text.contains("third ask"));
        assert!(!text.contains("自我反思"), "engine injections are not user intent");
        assert!(!text.contains("潜在循环"), "engine injections are not user intent");
        // The first ask belongs to the protected first chain, so it is not
        // repeated here.
        assert!(!text.contains("first ask"));
    }

    #[test]
    fn intent_chain_needs_two_real_asks() {
        // One real ask plus one injection is not enough: no drift is possible yet.
        let msgs = vec![
            ChatMessage::system("sys"),
            ChatMessage::user("first ask"),
            ChatMessage::assistant("ok"),
            ChatMessage::user("【系统指令：自我反思 (Self-Reflection)】blah"),
            ChatMessage::user("second ask"),
        ];
        assert!(build_intent_chain(&msgs, first_chain_end(&msgs)).is_none());
    }

    #[test]
    fn intent_chain_skipped_when_no_drift_possible() {
        let msgs = vec![ChatMessage::system("sys"), ChatMessage::user("only ask")];
        assert!(build_intent_chain(&msgs, first_chain_end(&msgs)).is_none());
    }

    #[test]
    fn dangling_outputs_are_removed() {
        let msgs = vec![
            ChatMessage::system("sys"),
            ChatMessage::user("task"),
            tool_msg("orphan", "result with no declaring assistant"),
            assistant_calling("c1", "read"),
            tool_msg("c1", "ok"),
        ];
        let cleaned = remove_dangling_tool_outputs(&msgs);
        assert!(!cleaned.iter().any(|m| m.tool_call_id.as_deref() == Some("orphan")));
        assert!(cleaned.iter().any(|m| m.tool_call_id.as_deref() == Some("c1")));
    }

    #[test]
    fn incomplete_parallel_group_is_dropped_whole() {
        // Assistant declares two calls but only one result exists.
        let msgs = vec![
            ChatMessage::system("sys"),
            ChatMessage::user("task"),
            ChatMessage {
                role: Role::Assistant,
                content: None,
                tool_calls: Some(vec![call("a", "read", "{}"), call("b", "read", "{}")]),
                tool_call_id: None,
                name: None,
            },
            tool_msg("a", "only one result"),
        ];
        let cleaned = remove_dangling_tool_outputs(&msgs);
        assert!(!cleaned.iter().any(|m| m.role == Role::Tool));
        assert!(!cleaned.iter().any(|m| m.tool_calls.is_some()));
    }

    #[test]
    fn settings_clamps_match_java_setters() {
        let mut g = crate::config::GeneralSettings::default();
        assert!(g.auto_rethink, "autoRethink defaults to true like Java");
        g.compression_ratio = 500;
        g.compression_target_ratio = 1;
        g.compression_reserved_output_tokens = 10;
        g.compression_max_messages = 6;
        let c = CompressionConfig::from_settings(&g);
        assert_eq!(c.ratio, 100);
        assert_eq!(c.target_ratio, 10);
        assert_eq!(c.reserved_output, 1_000);
        assert_eq!(c.max_messages, 6);
        assert_eq!(c.min_reserved_messages, 3); // max(3, 6/3)
    }

    // ─── /compact focus injection ───────────────────────────────────────────
    //
    // The focus used to be accepted, persisted, reported to the user as
    // "聚焦：…", then dropped before reaching the compressor. These pin the
    // wiring so it cannot silently regress to a promise that does nothing.

    #[test]
    fn a_focus_instruction_lands_in_the_retained_window() {
        let msgs = big_history("write");
        let out = compress(
            msgs,
            &cfg(),
            500,
            2_000,
            &Calibration::default(),
            true,
            Some("only keep the migration conclusions"),
        );
        assert!(out.compressed);
        let joined: Vec<String> = out.messages.iter().map(|m| m.content_text()).collect();
        assert!(
            joined.iter().any(|t| t.contains("only keep the migration conclusions")),
            "the focus text must survive into the compressed history"
        );
        assert!(
            joined.iter().any(|t| t.contains("压缩聚焦")),
            "the focus turn must be labelled so the model reads it as a directive"
        );
        // It must not break the tool-call pairing invariant.
        assert_pairing(&out.messages);
    }

    #[test]
    fn no_focus_adds_no_focus_turn() {
        let msgs = big_history("write");
        let out = compress(msgs, &cfg(), 500, 2_000, &Calibration::default(), true, None);
        assert!(out.compressed);
        assert!(
            !out.messages.iter().any(|m| m.content_text().contains("压缩聚焦")),
            "without a focus there must be no focus turn"
        );
    }

    #[test]
    fn a_blank_focus_is_treated_as_absent() {
        // `/compact` with only whitespace args parses to None upstream, but the
        // compressor must not inject an empty directive if one slips through.
        let msgs = big_history("write");
        let out = compress(msgs, &cfg(), 500, 2_000, &Calibration::default(), true, Some("   "));
        assert!(
            !out.messages.iter().any(|m| m.content_text().contains("压缩聚焦")),
            "a whitespace-only focus must not produce a focus turn"
        );
    }

    #[test]
    fn focus_is_injected_even_when_nothing_needed_trimming() {
        // A small history under the trigger still runs when forced; the focus must
        // be injected on that path too, or `/compact <focus>` on a short session
        // would silently do nothing.
        let msgs = vec![
            ChatMessage::system("sys"),
            ChatMessage::user("task"),
            ChatMessage::assistant("answer"),
        ];
        let out = compress(msgs, &cfg(), 10, 100, &Calibration::default(), true, Some("keep X"));
        assert!(
            out.messages.iter().any(|m| m.content_text().contains("keep X")),
            "a forced compact on a small history must still honour the focus"
        );
    }

    #[test]
    fn focus_survives_the_sweep_only_early_return() {
        // Regression pin for the review finding: the sweep tier used to return
        // early without injecting the focus, so a `/compact <focus>` on a
        // history whose stale `read` results alone brought it under target
        // silently dropped the user's instruction. The sweep path must honour
        // the focus the same way the full rebuild path does.
        let msgs = big_history("read");
        let out = compress(
            msgs,
            &cfg(),
            500,
            2_000,
            &Calibration::default(),
            true,
            Some("prioritise the deployment section"),
        );
        assert!(
            out.compressed,
            "the sweep tier must report compression when it fires"
        );
        assert!(
            out.messages
                .iter()
                .any(|m| m.content_text().contains("prioritise the deployment section")),
            "the focus must land in the retained window even when the sweep alone suffices"
        );
        assert!(
            out.messages.iter().any(|m| m.content_text().contains("压缩聚焦")),
            "the focus turn must be labelled as a directive on the sweep path too"
        );
        assert_pairing(&out.messages);
    }
}
