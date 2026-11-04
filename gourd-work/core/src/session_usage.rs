//! session_usage — session-cumulative usage ledger for the context meter.
//!
//! Port of Java `SessionStreamStore.sumUsage` / `scanUsage`. The frontend meter
//! (`app-context.js`) shows a "cumulative input / output / cache / messages"
//! block fed by `args.total*` on every `context_size` frame; the Java kernel
//! injects those in `WebGate.emitToClient` by scanning the session's stream
//! file. Without this the Rust kernel can only offer per-call numbers and the
//! cumulative rows silently disappear.
//!
//! ## Accounting rules (identical to Java)
//! - `trace` frames close a run: their usage is the run's **whole** accumulated
//!   usage, so they add into `confirmed` and **reset** the pending counters
//!   (the in-run `context_size` frames they supersede must not double-count).
//! - `context_size` frames after the last `trace` belong to the in-flight run:
//!   they add into `pending`.
//! - `user` / `user_input` frames count user turns; `trace` frames count AI
//!   turns; together they are the conversation message count (compression
//!   never shrinks it).
//!
//! Unlike Java we scan the whole file on every call instead of keeping a byte
//! watermark cache: the scan is invoked once per run start (not per frame), and
//! the cheap substring pre-filter keeps it linear in the number of *relevant*
//! lines. Rewind/rewrite races that could strand a byte watermark are then
//! impossible by construction.

use std::path::Path;

/// Session-cumulative usage snapshot (see module docs for the accounting).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionUsageSum {
    /// Sum of every `trace` frame's input (normalised, cache included).
    pub confirmed_input: u64,
    /// Sum of every `trace` frame's output.
    pub confirmed_output: u64,
    /// Sum of `context_size` frames emitted after the last `trace` (in-flight).
    pub pending_input: u64,
    /// Output counterpart of [`Self::pending_input`].
    pub pending_output: u64,
    pub confirmed_cache_creation: u64,
    pub pending_cache_creation: u64,
    pub confirmed_cache_read: u64,
    pub pending_cache_read: u64,
    /// user/user_input frames + trace frames (conversation turn count).
    pub messages: u64,
}

impl SessionUsageSum {
    /// Public figure: confirmed + in-flight.
    pub fn input_tokens(&self) -> u64 {
        self.confirmed_input.saturating_add(self.pending_input)
    }
    pub fn output_tokens(&self) -> u64 {
        self.confirmed_output.saturating_add(self.pending_output)
    }
    pub fn cache_creation_tokens(&self) -> u64 {
        self.confirmed_cache_creation
            .saturating_add(self.pending_cache_creation)
    }
    pub fn cache_read_tokens(&self) -> u64 {
        self.confirmed_cache_read.saturating_add(self.pending_cache_read)
    }
    pub fn message_count(&self) -> u64 {
        self.messages
    }
}

fn u64_of(v: &serde_json::Value, key: &str) -> u64 {
    v.get(key)
        .and_then(|x| x.as_u64())
        .unwrap_or(0)
}

/// Scan a session stream file and aggregate the cumulative usage ledger.
///
/// Missing/unreadable files yield an all-zero sum: the meter then falls back
/// to per-turn rows, exactly like Java's `EMPTY_SUM` degradation path.
pub fn sum_usage(stream_file: &Path) -> SessionUsageSum {
    let content = match std::fs::read_to_string(stream_file) {
        Ok(c) => c,
        Err(_) => return SessionUsageSum::default(),
    };
    // The owning session id is the file stem (`<sid>.stream.ndjson`); frames of
    // sub-agents (`sub-*`, persisted into the parent file because they share the
    // parent's frame channel) must not enter the parent's ledger — their usage
    // would reset the parent's in-flight pending on every sub-agent trace.
    let sid = stream_file
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .trim_end_matches(".stream")
        .to_string();
    scan_usage(&content, &sid)
}

/// Pure scan over stream-file content (unit-testable without disk).
///
/// `expected_sid` filters out frames belonging to other ids (sub-agents share
/// the parent's stream file); frames without a sessionId count as the owner's.
pub fn scan_usage(content: &str, expected_sid: &str) -> SessionUsageSum {
    let mut sum = SessionUsageSum::default();
    for line in content.lines() {
        // Cheap pre-filter: text/reason deltas dominate the file and must never
        // be JSON-parsed (same optimisation as Java's scanUsage).
        let is_trace = line.contains("\"type\":\"trace\"");
        let is_context = line.contains("\"type\":\"context_size\"");
        let is_user = line.contains("\"type\":\"user\"") || line.contains("\"type\":\"user_input\"");
        if !is_trace && !is_context && !is_user {
            continue;
        }
        let Ok(frame) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        match frame.get("sessionId").and_then(|s| s.as_str()) {
            Some(sid) if sid != expected_sid => continue,
            _ => {}
        }
        if is_user {
            sum.messages = sum.messages.saturating_add(1);
            continue;
        }
        if is_trace {
            let input = u64_of(&frame, "inputTokens");
            let output = u64_of(&frame, "outputTokens");
            sum.confirmed_input = sum.confirmed_input.saturating_add(input);
            sum.confirmed_output = sum.confirmed_output.saturating_add(output);
            sum.confirmed_cache_creation = sum
                .confirmed_cache_creation
                .saturating_add(u64_of(&frame, "cacheCreationTokens"));
            sum.confirmed_cache_read = sum
                .confirmed_cache_read
                .saturating_add(u64_of(&frame, "cacheReadTokens"));
            sum.messages = sum.messages.saturating_add(1);
            // The run's context_size frames are now superseded by this trace:
            // drop them so the same tokens are never counted twice.
            sum.pending_input = 0;
            sum.pending_output = 0;
            sum.pending_cache_creation = 0;
            sum.pending_cache_read = 0;
            continue;
        }
        // context_size: in-flight call of the current (unclosed) run.
        sum.pending_input = sum.pending_input.saturating_add(u64_of(&frame, "inputTokens"));
        sum.pending_output = sum
            .pending_output
            .saturating_add(u64_of(&frame, "outputTokens"));
        sum.pending_cache_creation = sum
            .pending_cache_creation
            .saturating_add(u64_of(&frame, "cacheCreationTokens"));
        sum.pending_cache_read = sum
            .pending_cache_read
            .saturating_add(u64_of(&frame, "cacheReadTokens"));
    }
    sum
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trace(input: u64, output: u64, cr: u64, cc: u64) -> String {
        format!(
            r#"{{"type":"trace","inputTokens":{input},"outputTokens":{output},"cacheReadTokens":{cr},"cacheCreationTokens":{cc}}}"#
        )
    }
    fn ctx(input: u64, output: u64, cr: u64, cc: u64) -> String {
        format!(
            r#"{{"type":"context_size","totalTokens":{t},"inputTokens":{input},"outputTokens":{output},"cacheReadTokens":{cr},"cacheCreationTokens":{cc}}}"#,
            t = input + output
        )
    }

    #[test]
    fn empty_and_missing_yield_zero() {
        assert_eq!(scan_usage("", "work-x"), SessionUsageSum::default());
        assert_eq!(
            sum_usage(Path::new("definitely/missing/stream.ndjson")),
            SessionUsageSum::default()
        );
    }

    #[test]
    fn trace_closes_run_and_resets_pending() {
        let body = [
            r#"{"type":"user","text":"hi"}"#.to_string(),
            ctx(100, 10, 0, 0),
            ctx(120, 12, 0, 0),
            trace(220, 22, 0, 0),
            r#"{"type":"text","text":"delta ignored"}"#.to_string(),
        ]
        .join("\n");
        let s = scan_usage(&body, "work-x");
        // pending was reset by the trace: totals come from confirmed only
        assert_eq!(s.input_tokens(), 220);
        assert_eq!(s.output_tokens(), 22);
        assert_eq!(s.message_count(), 2); // 1 user + 1 trace
    }

    #[test]
    fn pending_after_last_trace_counts_in_flight_run() {
        let body = [
            trace(220, 22, 5, 7),
            r#"{"type":"user_input","text":"steer"}"#.to_string(),
            ctx(300, 30, 10, 0),
            ctx(320, 32, 12, 0),
        ]
        .join("\n");
        let s = scan_usage(&body, "work-x");
        assert_eq!(s.confirmed_input, 220);
        assert_eq!(s.pending_input, 620);
        assert_eq!(s.input_tokens(), 840);
        assert_eq!(s.output_tokens(), 22 + 62);
        assert_eq!(s.cache_read_tokens(), 5 + 22);
        assert_eq!(s.cache_creation_tokens(), 7);
        assert_eq!(s.message_count(), 2); // trace + user_input
    }

    #[test]
    fn malformed_lines_are_skipped_not_fatal() {
        let body = ["{\"type\":\"trace\",broken".to_string(), trace(10, 1, 0, 0)].join("\n");
        let s = scan_usage(&body, "work-x");
        assert_eq!(s.input_tokens(), 10);
    }

    #[test]
    fn sub_agent_frames_do_not_pollute_parent_ledger() {
        let body = [
            ctx(100, 10, 0, 0), // parent in-flight
            r#"{"type":"context_size","sessionId":"sub-1","totalTokens":500,"inputTokens":500,"outputTokens":50}"#.to_string(),
            r#"{"type":"trace","sessionId":"sub-1","inputTokens":500,"outputTokens":50}"#.to_string(),
        ]
        .join("\n");
        let s = scan_usage(&body, "work-x");
        // the sub trace must NOT reset the parent's pending
        assert_eq!(s.pending_input, 100);
        assert_eq!(s.confirmed_input, 0);
        assert_eq!(s.input_tokens(), 100);
    }
}
