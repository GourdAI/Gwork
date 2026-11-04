//! session — Session management and ndjson persistence.
//!
//! Compatible with the Java kernel's session storage format:
//! `~/.gwork/sessions/<sessionId>/<sessionId>.messages.ndjson`
//! Each line is a JSON message with role/content/createdAt/metadata.
//!
//! Additionally, streaming frames are persisted to:
//! `~/.gwork/sessions/<sessionId>/<sessionId>.stream.ndjson`
//! enabling replay (the frontend's /web/chat/replay endpoint reads these).

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::config::Settings;
use crate::llm::{ChatMessage, Role};
use crate::protocol::Frame;

/// Run a blocking closure **off** the async worker thread.
///
/// WHY THIS EXISTS (measured failure mode, not a guess): every method in this
/// module is synchronous and is called directly from `async` axum handlers.
/// `list_sessions_in` reads *every* session's ndjson (383 files / 95 MB on the
/// benchmark home); `load_stream_frames` slurps a single file that reaches
/// **84 MB**. Blocking a tokio worker stalls every other task pinned to it — the
/// measured shape of that failure elsewhere in this repo is `/web/chat/meta`
/// going 1 ms → 2178 ms while `usage/stats` scanned 179 MB, and 0.23 ms →
/// 85.85 ms under 8 concurrent blocking git calls.
///
/// This module was the last one without the helper: `gitops`, `filer`, `changes`,
/// `memory`, `skills` and `projects` all have their own copy, and it backs seven
/// endpoints (`sessions`, `messages`, `replay`, `replay/full`, `tool-usage`,
/// `channel/sessions`, `rewind`).
///
/// `block_in_place` rather than `spawn_blocking` so the public API stays
/// synchronous (no caller signature changes, no `'static` bound on the closure).
/// It panics on a `current_thread` runtime, hence the flavour check; outside a
/// multi-thread runtime the closure runs inline, exactly as before — which keeps
/// the unit tests below and the CLI path working.
fn offload<F, R>(f: F) -> R
where
    F: FnOnce() -> R,
{
    let multi_thread = tokio::runtime::Handle::try_current()
        .map(|h| h.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread)
        .unwrap_or(false);
    if multi_thread {
        tokio::task::block_in_place(f)
    } else {
        f()
    }
}

/// Unified session directory prefix, identical to the Java kernel's
/// `SessionLocator.PREFIX_WORK`. Session folders are the only `work-`
/// prefixed entries under a sessions root; anything else (loop task files,
/// tool scratch dirs) must never be listed as a session.
pub const PREFIX_WORK: &str = "work-";

/// Per-session task-checklist file name (Java's `TodoTalent.TODO_FILE_NAME`).
///
/// Lives **inside the session directory**, next to `<sid>.messages.ndjson` —
/// not in the workspace. Keeping the name in one place is what stops the
/// `todowrite` tool and the `/web/chat/todos` endpoint from drifting apart
/// again (see `ToolContext::todo_file`).
pub const TODO_FILE_NAME: &str = "TODO.md";

/// A stored message in ndjson format (compatible with Java kernel).
///
/// ## Two body fields, on purpose
///
/// The Java kernel persists the two roles with *different* field names:
/// `AssistantMessage` writes its body under `text` (its `getText()` falls back
/// to `content` only when `text` is absent), while `UserMessage` writes both a
/// `blocks` array and a flat `content` string. A reader that only knows
/// `content` therefore sees every historical assistant line as empty — which
/// is exactly the defect that made reopened sessions show user bubbles with
/// blank assistant replies.
///
/// So: **read** `text` first, fall back to `content`; **write** both fields
/// (Java's `getText()` prefers `text`, its messages endpoint reads `content`,
/// so dual-writing keeps both kernels' readers satisfied in both directions).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredMessage {
    pub role: String,
    #[serde(default)]
    pub content: String,
    /// Java `AssistantMessage` body field. Absent on lines written by this
    /// kernel before the dual-write fix and on `UserMessage` lines.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Java `UserMessage` content blocks. Written so the Java kernel's
    /// polymorphic `ChatMessage.fromJson` can rebuild user messages from
    /// lines this kernel appended (it deserializes `blocks`, not `content`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Vec<serde_json::Value>>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

impl StoredMessage {
    /// Effective message body: Java's `text` field wins, `content` is the
    /// fallback (mirrors `AssistantMessage.getText()`'s own precedence).
    pub fn body(&self) -> &str {
        match self.text.as_deref() {
            Some(t) if !t.is_empty() => t,
            _ => &self.content,
        }
    }

    /// True for suspension placeholders ("waiting for user answer" lines the
    /// Java kernel persists when a run suspends). They must stay visible in
    /// the message list (they are the history anchor of question cards) but
    /// must never enter the LLM working memory — see Java
    /// `PendingNoticeFilter` for the same rule.
    pub fn is_pending_notice(&self) -> bool {
        if self.role != "ASSISTANT" {
            return false;
        }
        let flagged = self
            .metadata
            .as_ref()
            .and_then(|m| m.get("_pendingNotice"))
            .map(|v| v.as_i64().unwrap_or(0) != 0)
            .unwrap_or(false);
        if flagged {
            return true;
        }
        let body = self.body().trim();
        body == "等待用户回答" || body == "敏感操作，需要人工介入确认"
    }
}

/// Session metadata (list entry).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub id: String,
    pub title: String,
    #[serde(rename = "lastActivity")]
    pub last_activity: i64,
}

/// Session manager handling persistence.
#[derive(Clone)]
pub struct SessionStore {
    base_dir: PathBuf,
}

impl SessionStore {
    pub fn new() -> Self {
        Self { base_dir: Settings::sessions_dir() }
    }

    pub fn with_base(base: PathBuf) -> Self {
        Self { base_dir: base }
    }

    /// Validate a session ID (no path traversal).
    pub fn is_valid_id(id: &str) -> bool {
        !id.is_empty()
            && !id.contains("..")
            && !id.contains('/')
            && !id.contains('\\')
            && id.len() <= 128
    }

    /// Resolve a session's directory, **guaranteed to stay inside `base_dir`**.
    ///
    /// This is the single funnel every path in this module goes through
    /// (`messages_file`, `stream_file`, `context_file`, `session_dir_pub`, ...),
    /// so sanitizing here is what makes traversal impossible regardless of which
    /// HTTP handler forgot to validate. Handlers still validate up front — the
    /// Java kernel answers 400 for a bad `sessionId` and the frontend depends on
    /// that — but a missed check degrades to "writes into a flattened, harmless
    /// directory name" instead of "writes outside the sessions root".
    ///
    /// Confirmed exploitable before this guard: `POST /web/chat/context/select`
    /// with `sessionId=..\traversal-probe` created
    /// `~/.gwork/traversal-probe/context.json`. The attachment endpoints were
    /// worse, since they write user-supplied file bytes under the same path.
    fn session_dir(&self, id: &str) -> PathBuf {
        self.base_dir.join(sanitize_id(id))
    }

    /// Public accessor for the session directory (used by attachment/change APIs).
    pub fn session_dir_pub(&self, id: &str) -> PathBuf {
        self.session_dir(id)
    }

    fn messages_file(&self, id: &str) -> PathBuf {
        // The id is interpolated into the *file name* too, so it must be
        // sanitized here as well — a `..\x` id would otherwise escape through
        // the file-name segment even with a sanitized directory.
        let safe = sanitize_id(id);
        self.session_dir(id).join(format!("{}.messages.ndjson", safe))
    }

    fn stream_file(&self, id: &str) -> PathBuf {
        let safe = sanitize_id(id);
        self.session_dir(id).join(format!("{}.stream.ndjson", safe))
    }

    /// List all sessions, sorted by last activity (newest first).
    ///
    /// Only `work-` prefixed directories are sessions: the Java kernel scans
    /// with the same `PREFIX_WORK` filter, and the sessions directory also
    /// holds non-session entries (`loop-tasks.json`, stray tool dirs) that
    /// would otherwise surface as phantom sessions in the sidebar.
    pub fn list_sessions(&self) -> Vec<SessionMeta> {
        self.list_sessions_in(&self.base_dir)
    }

    /// List sessions under an explicit directory (project-scoped listing).
    ///
    /// ## One read per session, not three
    ///
    /// The previous body did, for **every** session directory:
    ///   1. `read_to_string(msg_file)` purely to count non-blank lines;
    ///   2. `read_title_in` → `label.txt` / `title.txt` probes;
    ///   3. when neither existed, `load_messages_from_dir` read the **same**
    ///      ndjson a second time and `serde_json`-parsed **every** line just to
    ///      find the first `USER` message.
    ///
    /// On the benchmark home (383 sessions, 95 MB) that is two full reads plus a
    /// complete JSON parse of the whole corpus per `/web/chat/sessions` request —
    /// and the sidebar fires that request on every load, concurrently with a dozen
    /// project-scoped variants. It is the same defect class as `usage/stats`
    /// (which took `/web/chat/meta` from 1 ms to 2178 ms), just smaller.
    ///
    /// Now the file is read **once** and both the line count and the auto-title are
    /// derived from that single buffer, with the title scan stopping at the first
    /// `USER` line instead of parsing the entire history.
    pub fn list_sessions_in(&self, dir: &std::path::Path) -> Vec<SessionMeta> {
        // One `read_dir` plus one full ndjson read **per session**: the heaviest
        // request in the kernel, and the sidebar fires it on every load
        // concurrently with a dozen project-scoped variants. Off the worker.
        offload(move || self.list_sessions_in_blocking(dir))
    }

    fn list_sessions_in_blocking(&self, dir: &std::path::Path) -> Vec<SessionMeta> {
        let mut sessions = Vec::new();
        let Ok(entries) = std::fs::read_dir(dir) else {
            return sessions;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() { continue; }
            let id = entry.file_name().to_string_lossy().to_string();
            if !id.starts_with(PREFIX_WORK) { continue; }
            if !Self::is_valid_id(&id) { continue; }
            // Title resolution no longer reads the whole ndjson. `title_from_dir`
            // tries `label.txt`/`title.txt` first (tiny files) and only falls back
            // to a **streaming** scan that stops at the first `USER` line — the
            // Java kernel's `collectSessions` + `extractFirstUserMessage` shape.
            // A renamed session therefore costs zero ndjson reads, and an
            // auto-titled one costs a couple of lines instead of the full history.
            //
            // `None` means "empty shell" (no messages file, or one with no user
            // message): skipped, exactly as Java skips it, so the sidebar never
            // shows "New Session" ghosts.
            let Some(title) = self.title_from_dir(&path, &id) else { continue };
            let last_activity = last_activity_of(&path, &id);
            sessions.push(SessionMeta { id, title, last_activity });
        }
        sessions.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));
        sessions
    }

    /// Resolve a session's display title, reading as little as possible.
    ///
    /// Precedence is unchanged (`label.txt` > `title.txt` > first user message >
    /// "New Session"), but the ndjson fallback is now **streaming**: it opens the
    /// file and stops at the first parsable `USER` line instead of slurping the
    /// whole history into a `String`. On the benchmark home (383 sessions, 95 MB)
    /// the old form read all 95 MB per `/web/chat/sessions` request — and the
    /// sidebar fires that request on every load, concurrently with a dozen
    /// project-scoped variants.
    ///
    /// Returns `None` for an empty shell (no messages file, or a file with no
    /// parsable content), which the caller skips.
    fn title_from_dir(&self, dir: &std::path::Path, id: &str) -> Option<String> {
        // 1. Custom label wins, and costs no ndjson read at all.
        for name in ["label.txt", "title.txt"] {
            let f = dir.join(name);
            if let Ok(custom) = std::fs::read_to_string(&f) {
                let t = custom.lines().next().unwrap_or("").trim().to_string();
                if !t.is_empty() {
                    return Some(truncate_label(&t));
                }
            }
        }
        // 2. Stream the ndjson, stopping at the first USER message.
        let msg_file = dir.join(format!("{}.messages.ndjson", id));
        let file = std::fs::File::open(&msg_file).ok()?;
        let reader = std::io::BufReader::new(file);
        let mut saw_content = false;
        for line in reader.lines() {
            let Ok(line) = line else { continue };
            if line.trim().is_empty() {
                continue;
            }
            saw_content = true;
            // Unparsable lines are skipped exactly as `load_messages_from_dir`
            // skips them, so the chosen message is the same one it would find.
            let Ok(m) = serde_json::from_str::<StoredMessage>(&line) else { continue };
            if m.role == "USER" {
                return Some(truncate_label(&m.body().chars().take(50).collect::<String>()));
            }
        }
        // A non-empty file with no USER message keeps the historical placeholder
        // rather than vanishing from the list; a truly empty file is a shell.
        if saw_content {
            Some("New Session".into())
        } else {
            None
        }
    }

    /// Read session title (label.txt > title.txt > first user message).
    ///
    /// `label.txt` is the Java kernel's rename target and takes priority;
    /// `title.txt` is this kernel's historical rename target, kept readable
    /// so renames made by older builds survive.
    ///
    /// Resolves through [`Self::session_dir`], so it is the store-relative
    /// counterpart of [`Self::read_title_in`] (used by the listing, which already
    /// holds the directory). Covered by `read_title_resolves_through_session_dir`.
    ///
    /// Kept even though no production endpoint calls it yet: it is the natural
    /// entry point for a future single-session title lookup, and the Java kernel
    /// exposes the same precedence rule. `#[allow(dead_code)]` because the lib
    /// build (unlike the test build) sees no caller.
    #[allow(dead_code)]
    fn read_title(&self, id: &str) -> String {
        self.read_title_in(&self.session_dir(id), id)
    }

    fn read_title_in(&self, dir: &std::path::Path, id: &str) -> String {
        for name in ["label.txt", "title.txt"] {
            let f = dir.join(name);
            if let Ok(custom) = std::fs::read_to_string(&f) {
                let t = custom.lines().next().unwrap_or("").trim().to_string();
                if !t.is_empty() {
                    return truncate_label(&t);
                }
            }
        }
        // `dir` IS the session directory: both callers pass `sessions_root/<id>`
        // (`list_sessions_in` hands over `entry.path()`, `read_title` hands over
        // `session_dir(id)`). Routing through `load_messages_in` here would join
        // `id` a *second* time and look for `<dir>/<id>/<id>.messages.ndjson`,
        // which never exists — so every auto-title silently degraded to
        // "New Session" while renamed sessions (label.txt branch, which joins
        // correctly) still looked fine. Read the file straight from `dir`.
        let msgs = load_messages_from_dir(dir, id);
        msgs.iter()
            .find(|m| m.role == "USER")
            .map(|m| truncate_label(&m.body().chars().take(50).collect::<String>()))
            .unwrap_or_else(|| "New Session".into())
    }

    /// Load all messages for a session.
    pub fn load_messages(&self, id: &str) -> Vec<StoredMessage> {
        let path = self.messages_file(id);
        offload(move || load_messages_from_path(&path))
    }

    /// Load all messages of a session stored under an explicit **sessions root**.
    ///
    /// `dir` is the parent of the session directory (i.e. `<dir>/<id>/` holds the
    /// ndjson files). Callers that already hold the session directory itself must
    /// use [`load_messages_from_dir`] instead — mixing the two doubles the `<id>`
    /// path segment and silently yields an empty list.
    pub fn load_messages_in(&self, dir: &std::path::Path, id: &str) -> Vec<StoredMessage> {
        let session_dir = dir.join(id);
        let id = id.to_string();
        offload(move || load_messages_from_dir(&session_dir, &id))
    }

    /// Append a message to the session's ndjson file.
    pub fn append_message(&self, id: &str, msg: &StoredMessage) -> std::io::Result<()> {
        let dir = self.session_dir(id);
        let path = self.messages_file(id);
        let line = serde_json::to_string(msg).unwrap_or_default();
        offload(move || {
            std::fs::create_dir_all(&dir)?;
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)?;
            writeln!(file, "{}", line)?;
            Ok(())
        })
    }

    /// Rename a session (stores the custom label in `label.txt`, the file
    /// the Java kernel's rename endpoint writes and reads).
    pub fn rename_session(&self, id: &str, title: &str) {
        let dir = self.session_dir(id);
        let title = title.to_string();
        offload(move || {
            let meta_file = dir.join("label.txt");
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(&meta_file, title);
        })
    }

    /// Convert stored messages to LLM ChatMessages (for feeding into ReAct).
    pub fn to_chat_messages(&self, id: &str, window: usize) -> Vec<ChatMessage> {
        let stored = self.load_messages(id);
        let start = stored.len().saturating_sub(window);
        stored[start..]
            .iter()
            .filter_map(|m| {
                let role = match m.role.as_str() {
                    "USER" => Role::User,
                    "ASSISTANT" => Role::Assistant,
                    "SYSTEM" => Role::System,
                    _ => return None,
                };
                // Suspension placeholders must not reach the provider: an
                // assistant-terminated message array is rejected by some
                // gateways (400 prefill) and pollutes the model's view of the
                // conversation. Same rule as Java PendingNoticeFilter.
                if m.is_pending_notice() { return None; }
                let body = m.body();
                if body.is_empty() { return None; }
                Some(ChatMessage {
                    role,
                    content: Some(crate::llm::MessageContent::Text(body.to_string())),
                    tool_calls: None,
                    tool_call_id: None,
                    name: None,
                })
            })
            .collect()
    }

    /// Delete a session.
    /// Delete a session directory.
    ///
    /// Returns whether a directory was actually removed, so the caller can tell
    /// "deleted" from "there was nothing there" — the HTTP layer reports 404 for
    /// the latter instead of claiming success.
    pub fn delete_session(&self, id: &str) -> std::io::Result<bool> {
        let dir = self.session_dir(id);
        offload(move || {
            if dir.exists() {
                std::fs::remove_dir_all(&dir)?;
                Ok(true)
            } else {
                Ok(false)
            }
        })
    }

    /// Rewind: remove the last `count` messages from the session's ndjson file.
    /// Returns the number of messages actually removed.
    pub fn rewind(&self, id: &str, count: usize) -> usize {
        let path = self.messages_file(id);
        offload(move || {
            let msgs = load_messages_from_path(&path);
            if msgs.is_empty() {
                return 0;
            }
            let keep = msgs.len().saturating_sub(count);
            let removed = msgs.len() - keep;
            if removed > 0 {
                let kept: Vec<StoredMessage> = msgs.into_iter().take(keep).collect();
                let lines: Vec<String> = kept
                    .iter()
                    .map(|m| serde_json::to_string(m).unwrap_or_default())
                    .collect();
                let _ = std::fs::write(&path, lines.join("\n") + "\n");
            }
            removed
        })
    }

    /// Remove every stored message of a session (`/clear`).
    ///
    /// Written as an empty file rather than a file containing one blank line:
    /// `rewind(id, usize::MAX)` would go through the `lines.join("\n") + "\n"`
    /// path and leave a lone newline behind, which every reader then has to
    /// tolerate. Truncating is unambiguous.
    ///
    /// Returns how many messages were dropped, so the caller can report it.
    pub fn clear_messages(&self, id: &str) -> usize {
        let path = self.messages_file(id);
        let existing = load_messages_from_path(&path);
        if existing.is_empty() {
            return 0;
        }
        // Best effort: a failure to truncate leaves the history intact, which is
        // the safe direction — reporting "cleared" while the messages survived
        // would desync the UI from the store.
        if std::fs::write(&path, "").is_err() {
            return 0;
        }
        existing.len()
    }

    /// Create a new session ID.
    pub fn new_session_id() -> String {
        format!("work-{}", &uuid::Uuid::new_v4().to_string()[..8])
    }

    // ─── Stream persistence (for replay) ─────────────────────────────────

    /// Append a frame to the session's stream ndjson file.
    pub fn append_stream_frame(&self, id: &str, frame: &Frame) {
        // Ephemeral frames (progress-only) are not persisted.
        //
        // `action_draft` belongs here for the same reason Java's `ofActionDraft`
        // documents ("不落盘"): it is a skeleton placeholder whose only job is to
        // fill the argument-streaming gap in a *live* stream. On replay the card
        // is rebuilt in full from `action_start` + `action_end`, so persisting
        // the draft would only add a redundant frame per tool call to files that
        // already reach tens of megabytes — and the frontend explicitly notes its
        // replay path "theoretically never sees" this type.
        if matches!(
            frame.frame_type.as_str(),
            "action_args" | "action_draft" | "agent_progress" | "reason_start"
        ) {
            return;
        }
        let dir = self.session_dir(id);
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        let path = self.stream_file(id);
        let line = frame.to_json();
        use std::io::Write;
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = writeln!(file, "{}", line);
        }
    }

    /// Load all persisted stream frames for replay.
    ///
    /// Streamed line-by-line through a `BufReader` rather than `read_to_string`:
    /// a single stream file reaches **84 MB** on a long session, and slurping it
    /// into a `String` *and then* building a `Vec<Value>` holds two full copies at
    /// once (the parsed `Value` tree is 2-4x the raw JSON). Reading line-by-line
    /// keeps only the growing `Vec` — the raw `String` peak is gone. Off the
    /// worker via [`offload`]; see that helper for the measured stall this avoids.
    ///
    /// NOTE: this still returns every frame, so `chat_replay` on an 84 MB session
    /// still holds the full parsed tree. The Java kernel caps that with a ring
    /// window (`SessionStreamStore.loadWithMeta`); porting the window is a
    /// separate change to `chat_replay`'s seq/hasMore contract. The two callers
    /// that do *not* need every frame — `replay/full` and `tool-usage` — use the
    /// dedicated streaming methods below and never build the full Vec at all.
    pub fn load_stream_frames(&self, id: &str) -> Vec<serde_json::Value> {
        let path = self.stream_file(id);
        offload(move || {
            let Ok(file) = std::fs::File::open(&path) else {
                return Vec::new();
            };
            let reader = BufReader::new(file);
            reader
                .lines()
                .filter_map(|l| l.ok())
                .filter(|l| !l.trim().is_empty())
                .filter_map(|line| serde_json::from_str::<serde_json::Value>(&line).ok())
                .collect()
        })
    }

    /// Stream frames whose `eventSeq >= seq`, for `/web/chat/replay/full`.
    ///
    /// The endpoint only ever returns a *tail* of the stream (everything from the
    /// client's last-seen seq onward), yet the naive form parsed all ~450k lines
    /// of an 84 MB file to keep a handful. This scans line-by-line and parses only
    /// the lines that survive the seq filter, so peak memory is O(returned frames)
    /// rather than O(file). Mirrors the Java kernel's `loadFull`, which likewise
    /// skips lines below the target seq without parsing them.
    ///
    /// `eventSeq` is read with a cheap substring probe before the full parse: the
    /// overwhelming majority of lines are text/reasoning deltas that carry a seq
    /// far below the resume point, and rejecting them without a JSON parse is the
    /// bulk of the saving.
    pub fn load_stream_frames_from_seq(&self, id: &str, seq: i64) -> Vec<serde_json::Value> {
        let path = self.stream_file(id);
        offload(move || {
            let Ok(file) = std::fs::File::open(&path) else {
                return Vec::new();
            };
            let reader = BufReader::new(file);
            let mut out = Vec::new();
            for line in reader.lines().filter_map(|l| l.ok()) {
                if line.trim().is_empty() || !line.contains("\"eventSeq\"") {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    if v.get("eventSeq").and_then(|s| s.as_i64()).unwrap_or(i64::MAX) >= seq {
                        out.push(v);
                    }
                }
            }
            out
        })
    }

    /// The highest `eventSeq` currently persisted in the session's stream file,
    /// or -1 when the file is absent or carries no sequenced frame.
    ///
    /// This is the kernel's own resume watermark. The frontend rebuilds its
    /// dedupe cursor (`lastEventSeq`) from this same file on every replay
    /// (app-history.js), and the live gate silently drops any frame whose
    /// `eventSeq` is at or below that cursor (app-streaming.js
    /// `applySequencedGateChunk`). A counter that restarts at zero after a
    /// kernel reboot therefore emits frames the UI discards without a trace:
    /// the run executes, tools update, and the main area spins on "waiting
    /// for response" until the run ends and history replay finally shows it.
    /// New sessions are unaffected: an absent or empty stream file reads as
    /// -1, so the seeded counter still starts at exactly 0 — which is the
    /// reported split between fresh and old conversations.
    ///
    /// Scanning is line-wise with a substring probe, mirroring
    /// `load_stream_frames_from_seq`, so an 84 MB session costs a sequential
    /// read rather than a full JSON parse of every line.
    pub fn max_stream_seq(&self, id: &str) -> i64 {
        let path = self.stream_file(id);
        offload(move || {
            let Ok(file) = std::fs::File::open(&path) else {
                return -1;
            };
            let mut max_seq = -1i64;
            for line in BufReader::new(file).lines().filter_map(|l| l.ok()) {
                if line.trim().is_empty() || !line.contains("\"eventSeq\"") {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    if let Some(s) = v.get("eventSeq").and_then(|s| s.as_i64()) {
                        max_seq = max_seq.max(s);
                    }
                }
            }
            max_seq
        })
    }

    fn issued_seq_file(&self, id: &str) -> PathBuf {
        let safe = sanitize_id(id);
        self.session_dir(id).join(format!("{}.issued-seq", safe))
    }

    /// The highest `eventSeq` this kernel process lineage has *handed out* for
    /// the session, or -1 when never recorded.
    ///
    /// Companion to [`Self::max_stream_seq`]: the stream file only carries
    /// persisted frames, but transient frames (`action_args`, `action_draft`,
    /// `agent_progress`, `reason_start` — see `append_stream_frame`) and
    /// slash-command frames are broadcast with a seq and never written there.
    /// The frontend cursor advances on every frame it sees, so after a kernel
    /// restart *without a page reload* the in-memory cursor sits above the
    /// persisted watermark and the live gate silently drops the next run's
    /// opening frames. Recording the issued high-water mark closes that gap;
    /// `seq_for` seeds from `max(persisted, issued)`.
    ///
    /// A corrupt or missing file reads as -1 (never as a high value): the
    /// seed then falls back to the persisted watermark, the safe direction —
    /// an over-high issued value would push the seed past frames the frontend
    /// has not seen yet and leave a visible hole instead of a silent drop.
    pub fn read_issued_seq(&self, id: &str) -> i64 {
        let path = self.issued_seq_file(id);
        offload(move || {
            let Ok(text) = std::fs::read_to_string(&path) else {
                return -1;
            };
            text.trim().parse::<i64>().unwrap_or(-1)
        })
    }

    /// Persist the issued high-water mark. Monotonic by construction: a lower
    /// value than what is already on disk is ignored, so an out-of-order or
    /// stale flush can never regress the resume seed.
    pub fn write_issued_seq(&self, id: &str, seq: i64) {
        let path = self.issued_seq_file(id);
        offload(move || {
            let current = std::fs::read_to_string(&path)
                .ok()
                .and_then(|t| t.trim().parse::<i64>().ok())
                .unwrap_or(-1);
            if seq <= current {
                return;
            }
            // The session directory may not exist yet (first frame of a fresh
            // session): without this the write fails silently and the resume
            // seed falls back to the persisted watermark.
            if std::fs::create_dir_all(path.parent().unwrap_or(path.as_path())).is_err() {
                return;
            }
            let _ = std::fs::write(&path, seq.to_string());
        })
    }

    /// Per-tool `action_start` counts for `/web/chat/session/tool-usage`.
    ///
    /// The endpoint needs only the `toolName` of `action_start` frames — a tiny
    /// fraction of the stream — so it must never materialise the frames. This
    /// walks the file line-by-line, substring-filters for `"action_start"` (the
    /// same trick `usage_ledger` uses), and parses only the survivors, keeping
    /// peak memory at O(distinct tools). An 84 MB session and an 8 KB one cost
    /// the same resident memory.
    pub fn tool_usage_counts(&self, id: &str) -> std::collections::HashMap<String, u64> {
        let path = self.stream_file(id);
        offload(move || {
            let mut counts = std::collections::HashMap::new();
            let Ok(file) = std::fs::File::open(&path) else {
                return counts;
            };
            let reader = BufReader::new(file);
            for line in reader.lines().filter_map(|l| l.ok()) {
                if !line.contains("\"action_start\"") {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    if v.get("type").and_then(|t| t.as_str()) == Some("action_start") {
                        if let Some(tool) = v.get("toolName").and_then(|t| t.as_str()) {
                            *counts.entry(tool.to_string()).or_insert(0) += 1;
                        }
                    }
                }
            }
            counts
        })
    }
}

impl Default for SessionStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Sessions root for a workspace root: `<root>/.gwork/sessions/`.
///
/// Identical layout to the Java kernel (`SessionLocator.doSessionsRoot`), so
/// both kernels see the same session directories for a given project.
pub fn sessions_root_for(root: &str) -> PathBuf {
    PathBuf::from(root).join(".gwork").join("sessions")
}

/// Global sessions root (`~/.gwork/sessions/`).
pub fn global_sessions_root() -> PathBuf {
    Settings::sessions_dir()
}

/// Per-session UI context (selected model / thinking depth / context window /
/// access mode). The Java kernel keeps these in the session snapshot; this
/// kernel persists them next to the session so a restart restores the same
/// values the picker shows.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SessionContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_length: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_mode: Option<String>,
    /// One-shot "compress on the next turn regardless of the threshold" flag,
    /// set by `/compact` (Java `HarnessEngine.requestCompact`).
    ///
    /// Automatic compression only fires at the trigger threshold, but the user
    /// often knows earlier that the exploration so far is dead weight. Persisted
    /// here rather than held in memory so the request survives a kernel restart
    /// between the command and the next turn.
    ///
    /// Consumed (cleared) by the run that acts on it, so it cannot silently
    /// re-compress every subsequent turn.
    #[serde(rename = "forceCompact", default, skip_serializing_if = "Option::is_none")]
    pub force_compact: Option<bool>,
    /// Optional focus instruction for that compression (Java `setCompactFocus`).
    ///
    /// `/compact only keep the migration conclusions` should make the compression
    /// prefer that material. Java feeds this to an LLM summariser that can
    /// semantically choose what to keep; this kernel's compressor is the zero-cost
    /// path (sweep + trim), which cannot make that semantic choice. What it *can*
    /// do — and now does — is inject the focus into the retained window as an
    /// explicit focus turn (see `compress::compress` and `ReActConfig::compact_focus`),
    /// so the model steers the next turn by it. It is consumed with the same
    /// first-turn-only lifetime as `forceCompact`.
    #[serde(rename = "compactFocus", default, skip_serializing_if = "Option::is_none")]
    pub compact_focus: Option<String>,
    /// Set when a run ends abnormally (cancelled / max-turns / error) and
    /// consumed by the very next turn, which injects the TODO resume calibration
    /// (Java keeps this on `ReActTrace` as `abnormal` / `userInterrupted`; this
    /// kernel has no cross-turn trace object, so the flag rides in the same
    /// persisted context that already carries `forceCompact`).
    ///
    /// Consumed rather than left set, mirroring `force_compact`: an unrelated
    /// later turn must not see a stale snapshot and start "correcting" work it
    /// never did.
    #[serde(rename = "interrupted", default, skip_serializing_if = "Option::is_none")]
    pub interrupted: Option<bool>,
}

/// Serialises `context.json` read-modify-write across the whole process.
///
/// WHY THIS EXISTS (measured, not hypothetical): the four `/web/chat/*/select`
/// handlers each did `let mut ctx = read_context(); ctx.field = ...; write_context()`.
/// `inheritSelectionToSession` on the welcome page fires model + thinking +
/// context selects **concurrently**; all three read an empty/absent file, each
/// writes back a whole `SessionContext` carrying only its own field, and the last
/// rename wins. A 30-round live probe against the real kernel produced 0/30
/// sessions with all three fields (14 lost model, 13 lost context, 2 lost all),
/// so the picker fell back to `auto` + 256K right after sending. The Java kernel
/// stores the same state in an in-memory `Map.put(key, value)`, which merges per
/// field and can never lose a sibling write — this lock restores that property
/// for the file-backed Rust kernel.
///
/// Global rather than per-`SessionStore`: handlers create a fresh `SessionStore`
/// per request (`bind_session_cwd` / `store_for`), so a lock held on one instance
/// would not exclude another. The critical section is a few microsecond file IO;
/// a single process-wide mutex is both correct and cheaper than keying by path.
fn context_write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

impl SessionStore {
    fn context_file(&self, id: &str) -> PathBuf {
        self.session_dir(id).join("context.json")
    }

    /// Read the persisted per-session UI context (missing/corrupt → default).
    pub fn read_context(&self, id: &str) -> SessionContext {
        let _guard = context_write_lock().lock().unwrap_or_else(|e| e.into_inner());
        self.read_context_unlocked(id)
    }

    /// Unlocked read. Only for use **inside** [`SessionStore::update_context`]
    /// while the caller already holds the lock.
    fn read_context_unlocked(&self, id: &str) -> SessionContext {
        let Ok(raw) = std::fs::read_to_string(self.context_file(id)) else {
            return SessionContext::default();
        };
        serde_json::from_str::<SessionContext>(&raw).unwrap_or_default()
    }

    /// Atomically read, mutate and persist the per-session UI context.
    ///
    /// Every caller that changes one field must go through this instead of
    /// `read_context` + `write_context`: the earlier split let concurrent
    /// requests overwrite each other's fields wholesale. The closure runs under
    /// the process-wide lock, so it always sees the latest committed document.
    ///
    /// Returns the resulting context so callers that need the value (e.g. the
    /// run path reading `thinking` / `context_length`) can use it directly.
    pub fn update_context<F>(&self, id: &str, mutate: F) -> SessionContext
    where
        F: FnOnce(&mut SessionContext),
    {
        let _guard = context_write_lock().lock().unwrap_or_else(|e| e.into_inner());
        let mut ctx = self.read_context_unlocked(id);
        mutate(&mut ctx);
        self.write_context_unlocked(id, &ctx);
        ctx
    }

    /// Persist the per-session UI context (best effort).
    ///
    /// Atomic temp+rename, the same discipline as `persist_suspension`. A bare
    /// `fs::write` here was observable on a real home as a truncated file —
    /// `{ "model": ..., "thinking": "high" }00000\n}` — because two pickers can
    /// be saved back-to-back (model + thinking on one click path) and the second
    /// write can interleave with the first. A truncated `context.json` then
    /// parses as "no context", and `read_context` silently returns default:
    /// the user's chosen thinking level / context window vanishes with no error.
    ///
    /// Prefer [`SessionStore::update_context`] when only some fields change;
    /// a direct whole-document write is only safe for callers that already own
    /// the complete state (tests, migrations).
    pub fn write_context(&self, id: &str, ctx: &SessionContext) {
        let _guard = context_write_lock().lock().unwrap_or_else(|e| e.into_inner());
        self.write_context_unlocked(id, ctx);
    }

    /// Unlocked write. Only for use while the caller already holds the lock.
    fn write_context_unlocked(&self, id: &str, ctx: &SessionContext) {
        let path = self.context_file(id);
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(ctx) {
            let tmp = path.with_extension("json.tmp");
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            }
        }
    }
}

/// Parse a session's `<id>.messages.ndjson` from an explicit **session directory**.
///
/// Shared by [`SessionStore::load_messages_in`] (which owns the sessions root and
/// joins `<id>` itself) and [`SessionStore::read_title_in`] (which is already
/// handed the session directory). Keeping the join in exactly one place is what
/// prevents the doubled-path bug that made every auto-title "New Session".
fn load_messages_from_dir(session_dir: &std::path::Path, id: &str) -> Vec<StoredMessage> {
    let path = session_dir.join(format!("{}.messages.ndjson", sanitize_id(id)));
    load_messages_from_path(&path)
}

/// Read and parse one ndjson messages file. Unparsable lines are skipped, not
/// fatal: a single corrupt line must not blank the whole history (Java parity).
fn load_messages_from_path(path: &std::path::Path) -> Vec<StoredMessage> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<StoredMessage>(line).ok())
        .collect()
}

/// Flatten a session id into a single, safe path segment.
///
/// Defence in depth behind [`SessionStore::is_valid_id`]: HTTP handlers reject a
/// malformed id with 400 (Java parity), but this module is also reachable from
/// internal callers, and one unchecked path is enough to write outside the
/// sessions root. Rather than failing, the id is *flattened* — separators and
/// traversal sequences are replaced — so the worst case is a harmless
/// oddly-named directory inside the root.
///
/// A single `.` is preserved on purpose: it cannot traverse, and rewriting it
/// would remap an otherwise-legal id to a different directory. Only the `..`
/// sequence and path separators are neutralized.
///
/// Length is capped for the same reason `is_valid_id` caps it: an unbounded id
/// would produce a path the filesystem refuses, turning a bad request into an
/// opaque I/O error.
pub fn sanitize_id(id: &str) -> String {
    const MAX_LEN: usize = 128;
    // Neutralize separators and Windows-reserved characters first, then collapse
    // any `..` the replacements may have produced (e.g. `.\.` → `._.` is fine,
    // but `..` must not survive). Looping handles overlapping cases like `...`.
    let mut flat: String = id
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    while flat.contains("..") {
        flat = flat.replace("..", "_");
    }
    let flat: String = flat.chars().take(MAX_LEN).collect();
    if flat.is_empty() {
        "_invalid_".to_string()
    } else {
        flat
    }
}

/// Truncate a sidebar label the way the Java kernel does (>30 chars → 30 + "...").
fn truncate_label(label: &str) -> String {
    let chars: Vec<char> = label.chars().collect();
    if chars.len() > 30 {
        let head: String = chars[..30].iter().collect();
        format!("{}...", head)
    } else {
        label.to_string()
    }
}

/// Last-activity timestamp: max mtime over the session's data files
/// (messages / snapshot / stream / usage), falling back to the directory
/// mtime. Same file set as the Java kernel's `lastActivityOf`; directory
/// mtime alone would go stale on appends and refresh on unrelated writes.
fn last_activity_of(dir: &std::path::Path, id: &str) -> i64 {
    let suffixes = [".messages.ndjson", ".snapshot.json", ".stream.ndjson", ".usage.ndjson"];
    let mut latest: i64 = 0;
    for s in suffixes {
        let f = dir.join(format!("{}{}", id, s));
        if let Ok(md) = f.metadata() {
            if let Ok(t) = md.modified() {
                if let Ok(d) = t.duration_since(std::time::UNIX_EPOCH) {
                    latest = latest.max(d.as_millis() as i64);
                }
            }
        }
    }
    if latest > 0 {
        return latest;
    }
    dir.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// sessionId → workspace root registry, shared with the Java kernel through
/// `~/.gwork/session-roots.json`.
///
/// The frontend declares a session's owning project via the `X-Session-Cwd`
/// header on `/web/chat/input`; the Java kernel records that binding here and
/// uses it to split the global session list from per-project lists. Without
/// the same registry this kernel would list every session (including project
/// ones) under the global view and show empty project groups.
#[derive(Debug)]
pub struct SessionRoots {
    inner: std::sync::Mutex<std::collections::HashMap<String, String>>,
    /// Where the registry is persisted. Injectable so tests never write to a
    /// real installation's `~/.gwork/session-roots.json` — that file holds every
    /// session→project binding the user has accumulated, and a test that
    /// silently replaced it would orphan all of their project sessions.
    index: PathBuf,
}

impl Default for SessionRoots {
    fn default() -> Self {
        Self {
            inner: std::sync::Mutex::new(std::collections::HashMap::new()),
            index: Self::default_index_file(),
        }
    }
}

impl SessionRoots {
    fn default_index_file() -> PathBuf {
        Settings::gwork_home().join("session-roots.json")
    }

    /// Load the registry from disk (corrupt/missing file → empty, never fatal).
    pub fn load() -> Self {
        Self::load_from(Self::default_index_file())
    }

    /// Load from an explicit index file (tests point this at a scratch path).
    pub fn load_from(index: PathBuf) -> Self {
        let mut map = std::collections::HashMap::new();
        if let Ok(raw) = std::fs::read_to_string(&index) {
            if let Ok(obj) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(obj) = obj.as_object() {
                    for (k, v) in obj {
                        if let Some(s) = v.as_str() {
                            if !s.is_empty() {
                                map.insert(k.clone(), s.to_string());
                            }
                        }
                    }
                }
            }
        }
        Self { inner: std::sync::Mutex::new(map), index }
    }

    /// Owning root of a session, if bound.
    pub fn bound_root(&self, session_id: &str) -> Option<String> {
        self.inner.lock().unwrap().get(session_id).cloned()
    }

    /// Record a binding (first binding wins, mirroring the Java kernel's
    /// "already bound → ignore rebind" rule) and persist.
    pub fn bind(&self, session_id: &str, root: &str) {
        if session_id.is_empty() || root.is_empty() {
            return;
        }
        let mut map = self.inner.lock().unwrap();
        if map.contains_key(session_id) {
            return;
        }
        map.insert(session_id.to_string(), root.to_string());
        drop(map);
        self.save();
    }

    /// Drop a binding (used when a session is deleted, so a later session that
    /// reuses the id is not routed to a stale root) and persist.
    pub fn unbind(&self, session_id: &str) {
        if session_id.is_empty() {
            return;
        }
        let removed = self.inner.lock().unwrap().remove(session_id).is_some();
        if removed {
            self.save();
        }
    }

    /// Every distinct root that has at least one bound session.
    ///
    /// Mirrors Java's `SessionLocator.registeredRoots()`
    /// (`new LinkedHashSet<>(boundRoots.values())`). Sorted rather than
    /// insertion-ordered because the backing map is a `HashMap`; callers use it
    /// as a set of directories to scan, where order is irrelevant (the usage
    /// ledger dedups by session id, not by root).
    ///
    /// **This is not the same as the project list.** `projects.json` holds only
    /// the projects the user explicitly registered (12 on the developer
    /// machine), while this registry holds every root a session was ever bound
    /// to (22 distinct roots across 556 bindings). Scanning only the project
    /// list silently under-reports usage — measured 4.53 B tokens vs the Java
    /// kernel's 4.64 B, 171 sessions vs 180.
    pub fn registered_roots(&self) -> Vec<String> {
        let map = self.inner.lock().unwrap();
        let mut roots: Vec<String> = map.values().cloned().collect();
        roots.sort();
        roots.dedup();
        roots
    }

    /// Number of bound sessions (diagnostics / tests).
    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().len()
    }

    /// Whether no session is bound.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn save(&self) {
        let map = self.inner.lock().unwrap();
        let value = serde_json::to_value(&*map).unwrap_or_default();
        if let Some(parent) = self.index.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string(&value) {
            let _ = std::fs::write(&self.index, json);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Scratch sessions root, unique per test (no tempfile dev-dependency here).
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "gwork-session-test-{}-{}",
                tag,
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        /// Create `<root>/<id>/<id>.messages.ndjson` with the given ndjson lines.
        fn session(&self, id: &str, lines: &[&str]) -> PathBuf {
            let dir = self.0.join(id);
            std::fs::create_dir_all(&dir).unwrap();
            let body = lines.join("\n") + "\n";
            std::fs::write(dir.join(format!("{}.messages.ndjson", id)), body).unwrap();
            dir
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn user_line(text: &str) -> String {
        serde_json::json!({
            "role": "USER",
            "content": text,
            "createdAt": 1_700_000_000_000_i64
        })
        .to_string()
    }

    fn assistant_line(text: &str) -> String {
        serde_json::json!({
            "role": "ASSISTANT",
            "text": text,
            "content": text,
            "createdAt": 1_700_000_000_001_i64
        })
        .to_string()
    }

    /// Regression guard for the doubled-path bug: `read_title_in` is handed the
    /// session directory itself, so routing it through `load_messages_in` (which
    /// joins `<id>` again) looked for `<dir>/<id>/<id>.messages.ndjson` and every
    /// auto-title silently degraded to "New Session".
    #[test]
    fn auto_title_is_the_first_user_message_not_new_session() {
        let s = Scratch::new("auto-title");
        s.session("work-a1", &[&user_line("请只回复四个字：验证通过")]);

        let store = SessionStore::with_base(s.0.clone());
        let list = store.list_sessions_in(&s.0);

        assert_eq!(list.len(), 1);
        assert_eq!(
            list[0].title, "请只回复四个字：验证通过",
            "auto-title must come from the first USER message"
        );
        assert_ne!(list[0].title, "New Session");
    }

    /// `label.txt` (the Java kernel's rename target) outranks the auto-title.
    #[test]
    fn label_txt_outranks_first_user_message() {
        let s = Scratch::new("label-wins");
        let dir = s.session("work-b1", &[&user_line("原始首条消息")]);
        std::fs::write(dir.join("label.txt"), "我改过的名字").unwrap();

        let store = SessionStore::with_base(s.0.clone());
        let list = store.list_sessions_in(&s.0);

        assert_eq!(list[0].title, "我改过的名字");
    }

    /// Long auto-titles are truncated the way the Java kernel does (>30 → 30 + "...").
    #[test]
    fn long_auto_title_is_truncated_to_30_chars() {
        let s = Scratch::new("truncate");
        let long: String = "字".repeat(45);
        s.session("work-c1", &[&user_line(&long)]);

        let store = SessionStore::with_base(s.0.clone());
        let list = store.list_sessions_in(&s.0);

        let expected: String = "字".repeat(30) + "...";
        assert_eq!(list[0].title, expected);
        assert_eq!(list[0].title.chars().count(), 33);
    }

    /// The assistant body lives under `text` in Java-written lines; a title
    /// fallback must not mistake it for a user message.
    #[test]
    fn assistant_only_session_falls_back_to_new_session() {
        let s = Scratch::new("assistant-only");
        s.session("work-d1", &[&assistant_line("只有助手消息")]);

        let store = SessionStore::with_base(s.0.clone());
        let list = store.list_sessions_in(&s.0);

        assert_eq!(list[0].title, "New Session");
    }

    /// Contract lock on the two loaders: `load_messages_in` takes the **sessions
    /// root** (it joins `<id>` itself), `load_messages_from_dir` takes the
    /// **session directory**. Swapping them yields an empty list, not an error.
    #[test]
    fn the_two_message_loaders_take_different_base_dirs() {
        let s = Scratch::new("loaders");
        let dir = s.session("work-e1", &[&user_line("hello"), &assistant_line("hi")]);

        let store = SessionStore::with_base(s.0.clone());
        assert_eq!(store.load_messages_in(&s.0, "work-e1").len(), 2, "root-based loader");
        assert_eq!(load_messages_from_dir(&dir, "work-e1").len(), 2, "dir-based loader");

        // Cross-wiring must come back empty (this is exactly the bug shape).
        assert!(store.load_messages_in(&dir, "work-e1").is_empty());
        assert!(load_messages_from_dir(&s.0, "work-e1").is_empty());
    }

    /// Empty-shell directories (no messages file) are not listed as sessions.
    #[test]
    fn session_dir_without_messages_file_is_skipped() {
        let s = Scratch::new("shell");
        std::fs::create_dir_all(s.0.join("work-f1")).unwrap();
        s.session("work-f2", &[&user_line("real")]);

        let store = SessionStore::with_base(s.0.clone());
        let list = store.list_sessions_in(&s.0);

        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "work-f2");
    }

    // ── Path-traversal defence ────────────────────────────────────────────

    #[test]
    fn sanitize_neutralizes_separators_and_traversal() {
        // `..\escape` → the separator becomes `_`, then the surviving `..`
        // collapses to `_`, giving `__escape`. What matters is that no separator
        // and no `..` sequence survives — the exact spelling is an artifact.
        for evil in ["..\\escape", "../escape", "..", "a/../../b", "....\\....\\x"] {
            let flat = sanitize_id(evil);
            assert!(!flat.contains('\\'), "{:?} kept a backslash: {}", evil, flat);
            assert!(!flat.contains('/'), "{:?} kept a slash: {}", evil, flat);
            assert!(!flat.contains(".."), "{:?} kept a traversal sequence: {}", evil, flat);
            assert!(!flat.is_empty());
        }
        // Windows-reserved characters cannot appear in a file name.
        assert_eq!(sanitize_id("a:b*c?d"), "a_b_c_d");
        // Control characters are flattened too.
        assert_eq!(sanitize_id("a\u{0}b"), "a_b");
    }

    /// A single dot is legal in a file name and must survive: rewriting it
    /// would remap an otherwise-valid id to a different directory.
    #[test]
    fn sanitize_preserves_a_single_dot() {
        assert_eq!(sanitize_id("work-v1.2"), "work-v1.2");
        assert_eq!(sanitize_id("plain"), "plain");
    }

    #[test]
    fn sanitize_caps_length_and_never_returns_empty() {
        let long = "a".repeat(400);
        assert_eq!(sanitize_id(&long).len(), 128);
        assert_eq!(sanitize_id(""), "_invalid_");
        assert_eq!(sanitize_id("///"), "___");
    }

    /// The exploit that was confirmed live before the guard: a traversal id
    /// must not produce a path outside the sessions root.
    ///
    /// Asserted structurally rather than via `canonicalize`, because on Windows
    /// `canonicalize` returns a `\\?\` verbatim prefix that a plain path does
    /// not carry, so comparing the two always fails even when the path is fine.
    #[test]
    fn session_dir_cannot_escape_the_sessions_root() {
        let s = Scratch::new("traversal");
        let store = SessionStore::with_base(s.0.clone());

        for evil in ["..\\escape", "../escape", "..", "a/../../b", "....\\....\\x", ".."] {
            let dir = store.session_dir_pub(evil);
            assert!(
                dir.starts_with(&s.0),
                "id {:?} escaped the root: {}",
                evil,
                dir.display()
            );
            assert!(
                !dir.components().any(|c| matches!(c, std::path::Component::ParentDir)),
                "id {:?} produced a path containing `..`: {}",
                evil,
                dir.display()
            );
            // Exactly one segment below the root: a sanitized id can never
            // introduce a separator, so it cannot nest either.
            assert_eq!(
                dir.strip_prefix(&s.0).unwrap().components().count(),
                1,
                "id {:?} nested below the root: {}",
                evil,
                dir.display()
            );
        }
    }

    /// Writing through a traversal id must land inside the root, not beside it.
    #[test]
    fn write_context_with_a_traversal_id_stays_inside_the_root() {
        let s = Scratch::new("traversal-write");
        let store = SessionStore::with_base(s.0.clone());

        store.write_context("..\\pwned", &SessionContext::default());

        // Nothing may appear as a sibling of the sessions root.
        let sibling = s.0.parent().unwrap().join("pwned");
        assert!(!sibling.exists(), "traversal wrote outside the root: {}", sibling.display());

        // The flattened directory is inside the root instead.
        let inside = store.session_dir_pub("..\\pwned");
        assert!(inside.starts_with(&s.0), "flattened dir {} is outside the root", inside.display());
        assert!(inside.join("context.json").exists(), "expected context.json at {}", inside.display());
    }

    /// `write_context` must be atomic (temp + rename), not a bare `fs::write`.
    ///
    /// Why this is a test and not a comment: a real user's home contained a
    /// literally corrupt context.json —
    ///   { "model": "...", "thinking": "high" }00000
    ///   }
    /// i.e. a valid document followed by a stale tail. `read_context` cannot parse
    /// that, falls back to `SessionContext::default()` **silently**, and the user
    /// sees their chosen thinking level and context window reset to "default" +
    /// 256K. The write path is reachable twice in quick succession (model + level
    /// saved on one click path), so a torn write is not hypothetical.
    ///
    /// Locked here: after writing, no temp file may linger, and the result must
    /// round-trip through `read_context`.
    #[test]
    fn context_write_is_atomic_and_leaves_no_temp_file() {
        let s = Scratch::new("context-atomic");
        let store = SessionStore::with_base(s.0.clone());
        let id = "work-atomic-probe";

        let ctx = SessionContext {
            model: Some("GourdWork-test".into()),
            thinking: Some("high".into()),
            context_length: Some(1_000_000),
            ..Default::default()
        };
        store.write_context(id, &ctx);

        let dir = store.session_dir_pub(id);
        let final_path = dir.join("context.json");
        assert!(final_path.exists(), "context.json missing at {}", final_path.display());

        // No sidecar may survive a successful write: a leftover *.json.tmp is the
        // signature of a non-atomic path (or of a rename that silently failed).
        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp file(s) left behind after write_context: {:?}",
            leftovers
        );

        // The bytes on disk must be exactly one parseable document — the old bug
        // produced a file that started as valid JSON and then carried a tail.
        let raw = std::fs::read_to_string(&final_path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("context.json is not valid JSON: {e}\n{raw}"));
        assert_eq!(parsed["thinking"], "high");
        // Field name is the raw snake_case on purpose: SessionContext carries no
        // #[serde(rename)] on context_length (only forceCompact/compactFocus do),
        // which is exactly what the files on disk show — "context_length": 256000.
        assert_eq!(parsed["context_length"], 1_000_000);

        let back = store.read_context(id);
        assert_eq!(back.thinking.as_deref(), Some("high"));
        assert_eq!(back.context_length, Some(1_000_000));

        // Rewriting (a second pick on the same session) must replace, not append.
        let ctx2 = SessionContext {
            thinking: Some("low".into()),
            ..Default::default()
        };
        store.write_context(id, &ctx2);
        let back2 = store.read_context(id);
        assert_eq!(back2.thinking.as_deref(), Some("low"), "second write must not corrupt");

        let _ = std::fs::remove_dir_all(&s.0);
    }

    /// Concurrent field-level picker writes must merge, not overwrite each
    /// other's fields.
    ///
    /// Regression for the "切到新增任务页后发送，思考等级与上下文长度全变默认"
    /// defect: `inheritSelectionToSession` fires model/thinking/context selects
    /// in parallel. With the old `read_context()` + `write_context()` split each
    /// request read an empty document and wrote back only its own field, so the
    /// last rename silently erased the other two (measured 0/30 sessions with
    /// all three fields on the real kernel). Java's in-memory `Map.put` merges
    /// per field and never had this failure mode.
    #[test]
    fn concurrent_context_updates_preserve_every_field() {
        let s = Scratch::new("context-concurrent");
        let id = "work-concurrent-probe";

        // Each thread owns a fresh SessionStore, exactly like an axum handler
        // constructing one via `bind_session_cwd` / `store_for`. A per-store
        // lock would not exclude them — this asserts the lock is process-wide.
        let writers: Vec<std::thread::JoinHandle<()>> = vec![
            std::thread::spawn({
                let base = s.0.clone();
                move || {
                    SessionStore::with_base(base).update_context(id, |ctx| {
                        ctx.model = Some("GourdWork-test".into());
                    });
                }
            }),
            std::thread::spawn({
                let base = s.0.clone();
                move || {
                    SessionStore::with_base(base).update_context(id, |ctx| {
                        ctx.thinking = Some("high".into());
                    });
                }
            }),
            std::thread::spawn({
                let base = s.0.clone();
                move || {
                    SessionStore::with_base(base).update_context(id, |ctx| {
                        ctx.context_length = Some(1_000_000);
                    });
                }
            }),
        ];
        for w in writers {
            w.join().expect("context writer panicked");
        }

        let ctx = SessionStore::with_base(s.0.clone()).read_context(id);
        assert_eq!(ctx.model.as_deref(), Some("GourdWork-test"), "model lost");
        assert_eq!(ctx.thinking.as_deref(), Some("high"), "thinking lost");
        assert_eq!(ctx.context_length, Some(1_000_000), "context_length lost");

        // Also lock down the field-level semantics: a later single-field update
        // must leave its siblings untouched.
        SessionStore::with_base(s.0.clone())
            .update_context(id, |ctx| ctx.interrupted = Some(true));
        let ctx = SessionStore::with_base(s.0.clone()).read_context(id);
        assert_eq!(ctx.interrupted, Some(true));
        assert_eq!(ctx.thinking.as_deref(), Some("high"));
        assert_eq!(ctx.context_length, Some(1_000_000));

        let _ = std::fs::remove_dir_all(&s.0);
    }

    /// The message file name is built from the id as well, so it needs the same
    /// treatment — a sanitized directory with an unsanitized file name would
    /// still escape.
    #[test]
    fn messages_file_name_is_sanitized_too() {
        let s = Scratch::new("traversal-filename");
        let store = SessionStore::with_base(s.0.clone());

        let msg = StoredMessage {
            role: "USER".into(),
            content: "x".into(),
            text: None,
            blocks: None,
            created_at: 1,
            metadata: None,
        };
        store.append_message("..\\..\\escaped", &msg).unwrap();

        // The two-levels-up target must not exist.
        let grandparent = s.0.parent().unwrap().parent().unwrap().to_path_buf();
        assert!(
            !grandparent.join("escaped.messages.ndjson").exists(),
            "message file escaped two levels up"
        );
        assert!(
            !s.0.parent().unwrap().join("escaped.messages.ndjson").exists(),
            "message file escaped one level up"
        );

        // And the message must be readable back through the same (flattened) id,
        // proving it landed inside the root rather than being discarded.
        let back = store.load_messages("..\\..\\escaped");
        assert_eq!(back.len(), 1, "message did not round-trip inside the root");
        assert_eq!(back[0].content, "x");
    }

    /// `read_title` is the store-relative accessor (it joins `session_dir`
    /// itself), while `read_title_in` is handed the directory. Both must agree,
    /// and both must honour the label.txt > title.txt > first-message order.
    #[test]
    fn read_title_resolves_through_session_dir() {
        let s = Scratch::new("read-title");
        let dir = s.session("work-t1", &[&user_line("首条消息内容")]);
        let store = SessionStore::with_base(s.0.clone());

        // No label file: falls back to the first user message.
        assert_eq!(store.read_title("work-t1"), "首条消息内容");
        assert_eq!(store.read_title_in(&dir, "work-t1"), store.read_title("work-t1"));

        // This kernel's historical rename target.
        std::fs::write(dir.join("title.txt"), "旧版标题").unwrap();
        assert_eq!(store.read_title("work-t1"), "旧版标题");

        // The Java kernel's rename target outranks it.
        std::fs::write(dir.join("label.txt"), "新版标题").unwrap();
        assert_eq!(store.read_title("work-t1"), "新版标题");

        // An empty label file must not blank the title out.
        std::fs::write(dir.join("label.txt"), "   \n").unwrap();
        assert_eq!(store.read_title("work-t1"), "旧版标题");
    }

    /// A session id that cannot resolve must not panic and must not read
    /// outside the root.
    #[test]
    fn read_title_on_unknown_session_is_new_session() {
        let s = Scratch::new("read-title-unknown");
        let store = SessionStore::with_base(s.0.clone());
        assert_eq!(store.read_title("work-does-not-exist"), "New Session");
        assert_eq!(store.read_title("..\\escape"), "New Session");
    }

    /// `delete_session` must distinguish "removed something" from "nothing was
    /// there": the HTTP layer answers 200 vs 404 based on this, and reporting
    /// success for a missing directory is what made a failed delete look fine.
    #[test]
    fn delete_session_reports_whether_it_removed_anything() {
        let s = Scratch::new("delete");
        s.session("work-del1", &[&user_line("hello")]);
        let store = SessionStore::with_base(s.0.clone());

        assert!(store.delete_session("work-del1").unwrap(), "first delete removes the dir");
        assert!(!s.0.join("work-del1").exists());
        assert!(!store.delete_session("work-del1").unwrap(), "second delete finds nothing");
        assert!(!store.delete_session("work-never-existed").unwrap());
    }

    /// Deleting through a traversal id must not touch anything outside the root.
    #[test]
    fn delete_session_cannot_escape_the_root() {
        let s = Scratch::new("delete-traversal");
        let store = SessionStore::with_base(s.0.clone());
        // A sibling directory that must survive.
        let sibling = s.0.parent().unwrap().join("gwork-must-survive");
        std::fs::create_dir_all(&sibling).unwrap();

        let _ = store.delete_session("..\\gwork-must-survive");
        assert!(sibling.exists(), "traversal delete escaped the sessions root");
        let _ = std::fs::remove_dir_all(&sibling);
    }

    /// `unbind` drops a binding and persists, so a re-created session with the
    /// same id is not routed to a stale root.
    ///
    /// Uses `load_from` with a scratch index: `bind`/`unbind` persist on every
    /// call, and the default index is the real `~/.gwork/session-roots.json`,
    /// which holds every binding the user has accumulated. A test writing there
    /// would orphan all of their project sessions.
    #[test]
    fn session_roots_bind_and_unbind_round_trip() {
        let s = Scratch::new("roots");
        let index = s.0.join("session-roots.json");
        let roots = SessionRoots::load_from(index.clone());

        roots.bind("work-x", "D:\\proj-a");
        assert_eq!(roots.bound_root("work-x").as_deref(), Some("D:\\proj-a"));
        assert!(index.exists(), "bind must persist");

        // First binding wins (Java parity): a rebind must not move the session.
        roots.bind("work-x", "D:\\proj-b");
        assert_eq!(roots.bound_root("work-x").as_deref(), Some("D:\\proj-a"));

        roots.unbind("work-x");
        assert_eq!(roots.bound_root("work-x"), None);

        // After unbind a fresh binding to a different root is accepted.
        roots.bind("work-x", "D:\\proj-b");
        assert_eq!(roots.bound_root("work-x").as_deref(), Some("D:\\proj-b"));

        // Unbinding an unknown/empty id is a no-op, not a panic.
        roots.unbind("work-never-bound");
        roots.unbind("");

        // A reload sees the persisted state.
        let reloaded = SessionRoots::load_from(index);
        assert_eq!(reloaded.bound_root("work-x").as_deref(), Some("D:\\proj-b"));
    }

    /// Empty/invalid inputs must not create a binding.
    #[test]
    fn session_roots_ignores_empty_inputs() {
        let s = Scratch::new("roots-empty");
        let roots = SessionRoots::load_from(s.0.join("session-roots.json"));
        roots.bind("", "D:\\proj");
        roots.bind("work-y", "");
        assert_eq!(roots.bound_root(""), None);
        assert_eq!(roots.bound_root("work-y"), None);
    }

    // ─── Transient (progress-only) frames are not persisted ────────────────
    //
    // The skip list in `append_stream_frame` is a silent-failure surface: adding
    // a frame type to it makes that frame vanish from history replay with no
    // error anywhere, and *removing* one bloats stream files that already reach
    // tens of megabytes. Both directions are pinned here.

    /// Read back the persisted frame types for a session.
    fn persisted_types(store: &SessionStore, id: &str) -> Vec<String> {
        let path = store.stream_file(id);
        if !path.exists() {
            return Vec::new();
        }
        std::fs::read_to_string(&path)
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .filter_map(|v| v.get("type").and_then(|t| t.as_str()).map(String::from))
            .collect()
    }

    #[test]
    fn progress_only_frames_are_not_written_to_the_stream_file() {
        let s = Scratch::new("transient");
        let store = SessionStore::with_base(s.0.clone());
        let id = "work-transient";

        // One of each transient type, plus two frames that MUST survive so the
        // test cannot pass by simply writing nothing.
        store.append_stream_frame(id, &Frame::action_draft(id, "write", "c1"));
        store.append_stream_frame(id, &Frame::action_args(id, "c1", 128));
        store.append_stream_frame(id, &Frame::agent_progress(id, "explore", "d", "i1", "read"));
        store.append_stream_frame(id, &Frame::reason_start(id, 0));
        store.append_stream_frame(id, &Frame::action_start(id, "write", "c1", serde_json::json!({})));
        store.append_stream_frame(id, &Frame::done(id));

        let types = persisted_types(&store, id);
        for transient in ["action_draft", "action_args", "agent_progress", "reason_start"] {
            assert!(
                !types.contains(&transient.to_string()),
                "{} is progress-only and must not be persisted; got {:?}",
                transient,
                types
            );
        }
        // The non-transient frames must still be there — otherwise the assertions
        // above would pass vacuously on an empty file.
        assert!(types.contains(&"action_start".to_string()), "got {:?}", types);
        assert!(types.contains(&"done".to_string()), "got {:?}", types);
        assert_eq!(types.len(), 2, "exactly the two durable frames: {:?}", types);
    }

    /// `action_draft` specifically: it is a skeleton placeholder whose only job
    /// is to fill the argument-streaming gap in a *live* stream. On replay the
    /// card is rebuilt from `action_start` + `action_end`, and the frontend notes
    /// its replay path "theoretically never sees" this type. Java's
    /// `ofActionDraft` documents the same ("不落盘").
    #[test]
    fn action_draft_is_transient_but_action_start_is_durable() {
        let s = Scratch::new("draft-transient");
        let store = SessionStore::with_base(s.0.clone());
        let id = "work-draft";

        // The real lifecycle: draft → args progress → start → end.
        store.append_stream_frame(id, &Frame::action_draft(id, "write", "c1"));
        store.append_stream_frame(id, &Frame::action_args(id, "c1", 64));
        store.append_stream_frame(id, &Frame::action_start(id, "write", "c1", serde_json::json!({})));
        store.append_stream_frame(id, &Frame::action_end(id, "write", "c1", "ok"));

        let types = persisted_types(&store, id);
        assert_eq!(
            types,
            vec!["action_start".to_string(), "action_end".to_string()],
            "replay must rebuild the card from start+end only"
        );
    }

    // ─── stream seq watermark (kernel-restart resume) ─────────────────────
    //
    // The frontend rebuilds its dedupe cursor from this file and the live gate
    // drops every frame at or below that cursor, so the kernel's own counter
    // must never fall behind what is already persisted.

    /// The watermark is the highest persisted `eventSeq`, not the line count
    /// and not the last line's seq: unsequenced frames, corrupt tails and
    /// out-of-order appends must not lower it.
    #[test]
    fn max_stream_seq_is_the_highest_persisted_event_seq() {
        let s = Scratch::new("max-seq");
        let store = SessionStore::with_base(s.0.clone());
        assert_eq!(store.max_stream_seq("work-seq"), -1, "absent file");
        let dir = s.0.join("work-seq");
        std::fs::create_dir_all(&dir).unwrap();
        let lines = [
            serde_json::json!({"type":"text","text":"a","eventSeq":7}).to_string(),
            "not json at all".to_string(),
            serde_json::json!({"type":"text","text":"b","eventSeq":42}).to_string(),
            serde_json::json!({"type":"text","text":"c"}).to_string(),
            serde_json::json!({"type":"text","text":"d","eventSeq":19}).to_string(),
        ];
        std::fs::write(dir.join("work-seq.stream.ndjson"), lines.join("\n") + "\n").unwrap();
        assert_eq!(store.max_stream_seq("work-seq"), 42);
    }

    /// An empty stream file (session created, nothing streamed yet) must read
    /// as -1 so the seeded counter starts at exactly zero — the
    /// fresh-conversation behaviour must not move.
    #[test]
    fn max_stream_seq_of_an_empty_stream_is_minus_one() {
        let s = Scratch::new("max-seq-empty");
        let store = SessionStore::with_base(s.0.clone());
        let dir = s.0.join("work-empty");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("work-empty.stream.ndjson"), "").unwrap();
        assert_eq!(store.max_stream_seq("work-empty"), -1);
    }

    /// The issued mark records what was *handed out*, which runs ahead of the
    /// persisted watermark because transient and slash frames never reach the
    /// stream file.
    #[test]
    fn issued_seq_round_trips_and_absent_reads_minus_one() {
        let s = Scratch::new("issued-seq");
        let store = SessionStore::with_base(s.0.clone());
        assert_eq!(store.read_issued_seq("work-iss"), -1, "never recorded");
        store.write_issued_seq("work-iss", 57);
        assert_eq!(store.read_issued_seq("work-iss"), 57);
    }

    /// Monotonic by construction: a stale flush must never lower the resume
    /// seed, or the next run would replay seqs the frontend already consumed.
    #[test]
    fn issued_seq_never_regresses_on_a_stale_flush() {
        let s = Scratch::new("issued-seq-mono");
        let store = SessionStore::with_base(s.0.clone());
        store.write_issued_seq("work-issm", 90);
        store.write_issued_seq("work-issm", 12);
        assert_eq!(store.read_issued_seq("work-issm"), 90);
    }

    /// A corrupt file degrades to the persisted-watermark fallback (-1), never
    /// to a high value that would punch a visible hole in the next run.
    #[test]
    fn issued_seq_of_a_corrupt_file_reads_minus_one() {
        let s = Scratch::new("issued-seq-corrupt");
        let store = SessionStore::with_base(s.0.clone());
        let dir = s.0.join("work-issc");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("work-issc.issued-seq"), "not a number\n").unwrap();
        assert_eq!(store.read_issued_seq("work-issc"), -1);
    }

    // ─── /clear ────────────────────────────────────────────────────────────
    //
    // Destructive and irreversible: it deletes the user's conversation history.
    // Covered end-to-end as well, but the store-level contract belongs here so a
    // regression is caught without standing up a kernel.

    fn stored(id: &str, n: usize) -> Vec<StoredMessage> {
        (0..n)
            .map(|i| StoredMessage {
                role: if i % 2 == 0 { "USER".into() } else { "ASSISTANT".into() },
                content: format!("m{}", i),
                text: None,
                blocks: None,
                created_at: 1_700_000_000_000 + i as i64,
                metadata: None,
            })
            .collect()
    }

    #[test]
    fn clear_messages_empties_the_history_and_reports_the_count() {
        let s = Scratch::new("clear");
        let store = SessionStore::with_base(s.0.clone());
        let id = "work-clear";
        for m in stored(id, 4) {
            store.append_message(id, &m).unwrap();
        }
        assert_eq!(store.load_messages(id).len(), 4, "fixture must be seeded");

        assert_eq!(store.clear_messages(id), 4, "must report how many were dropped");
        assert!(store.load_messages(id).is_empty(), "history must actually be gone");
    }

    #[test]
    fn clear_messages_leaves_no_stray_blank_line() {
        // Written as an empty file, not as `lines.join("\n") + "\n"` over an empty
        // vec — that path would leave a lone newline every reader has to tolerate,
        // and a subsequent append would start on line 2.
        let s = Scratch::new("clear-blank");
        let store = SessionStore::with_base(s.0.clone());
        let id = "work-clear-blank";
        for m in stored(id, 2) {
            store.append_message(id, &m).unwrap();
        }
        store.clear_messages(id);

        let path = store.messages_file(id);
        let raw = std::fs::read_to_string(&path).unwrap();
        assert_eq!(raw, "", "file must be truly empty, got {:?}", raw);

        // And a later append must produce exactly one line, not a leading blank.
        store.append_message(id, &stored(id, 1)[0]).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert_eq!(raw.lines().count(), 1, "got {:?}", raw);
        assert_eq!(store.load_messages(id).len(), 1);
    }

    #[test]
    fn clear_messages_on_an_empty_session_is_a_noop() {
        // Must not create the file as a side effect: a session that never existed
        // should still not exist afterwards, or `/clear` on a fresh session would
        // materialise an empty one in the sidebar.
        let s = Scratch::new("clear-empty");
        let store = SessionStore::with_base(s.0.clone());
        let id = "work-never-used";

        assert_eq!(store.clear_messages(id), 0);
        assert!(!store.messages_file(id).exists(), "must not create the file");
    }

    #[test]
    fn clear_messages_does_not_touch_other_sessions() {
        // The id is interpolated into both the directory and the file name, so a
        // sanitisation slip here would clear the wrong conversation.
        let s = Scratch::new("clear-scope");
        let store = SessionStore::with_base(s.0.clone());
        for m in stored("work-a", 3) {
            store.append_message("work-a", &m).unwrap();
        }
        for m in stored("work-b", 2) {
            store.append_message("work-b", &m).unwrap();
        }

        assert_eq!(store.clear_messages("work-a"), 3);
        assert!(store.load_messages("work-a").is_empty());
        assert_eq!(store.load_messages("work-b").len(), 2, "other session must survive");
    }

    #[test]
    fn clear_messages_cannot_escape_the_sessions_root() {
        // Same traversal guard the rest of the store relies on: a hostile id must
        // not reach outside the root and delete something else.
        let s = Scratch::new("clear-traversal");
        let store = SessionStore::with_base(s.0.clone());
        let outside = s.0.parent().unwrap().join("clear-escape-victim.ndjson");
        std::fs::write(&outside, "precious").unwrap();

        let _ = store.clear_messages("../../clear-escape-victim");
        assert!(outside.exists(), "a traversal id must not delete files outside the root");
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "precious");
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn a_failed_clear_reports_zero_rather_than_claiming_success() {
        // The failure branch is the reason `clear_messages` returns a count at
        // all: if the truncate fails the history is still there, and reporting
        // "cleared N" would desync the UI (which removes its rows on the frame)
        // from the store (which kept them). A reload would then show messages the
        // user was told were gone.
        //
        // Forced by making the file read-only: the read still succeeds, so the
        // early `is_empty` return is not taken, and only the write fails.
        let s = Scratch::new("clear-readonly");
        let store = SessionStore::with_base(s.0.clone());
        let id = "work-clear-ro";
        for m in stored(id, 3) {
            store.append_message(id, &m).unwrap();
        }
        let path = store.messages_file(id);

        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&path, perms).unwrap();

        let reported = store.clear_messages(id);

        // Restore write permission before asserting, so the Scratch cleanup can
        // delete the file on every platform.
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_readonly(false);
        std::fs::set_permissions(&path, perms).unwrap();

        let survived = store.load_messages(id).len();
        if survived == 3 {
            // The write genuinely failed: the count must not claim success.
            assert_eq!(reported, 0, "a failed clear must report 0, not {}", survived);
        } else {
            // Some filesystems ignore the read-only bit (or the test runs as a
            // user who can override it). Then the clear legitimately succeeded
            // and must report the real count — assert that instead of passing
            // vacuously.
            assert_eq!(survived, 0, "partial clear is not acceptable");
            assert_eq!(reported, 3, "a successful clear must report the count");
        }
    }

    /// Backward compatibility for the `interrupted` flag.
    ///
    /// Every `context.json` written before this field existed lacks the key. The
    /// struct derives `Deserialize` with `#[serde(default)]` at the container
    /// level, so a missing key is tolerated — but `read_context` swallows a
    /// deserialisation failure into `SessionContext::default()`, so a mistake in
    /// the attribute (a missing `default`, a renamed key) would not fail loudly:
    /// it would silently discard the user's selected model, thinking depth and
    /// access mode, and the resume calibration would never fire because the flag
    /// read back as `None`. Assert the two directions explicitly.
    #[test]
    fn context_without_the_interrupted_key_still_loads() {
        let s = Scratch::new("context-legacy-interrupted");
        let store = SessionStore::with_base(s.0.clone());
        let id = "work-legacy-ctx";

        // Exactly what the previous kernel version writes.
        // snake_case keys, exactly as SessionContext serialises them (no
        // container-level rename): this is the byte-for-byte shape the previous
        // kernel version leaves on disk.
        let legacy = r#"{"model":"GourdWork-test","thinking":"high","access_mode":"full"}"#;
        std::fs::create_dir_all(store.session_dir_pub(id)).unwrap();
        std::fs::write(store.session_dir_pub(id).join("context.json"), legacy).unwrap();

        let ctx = store.read_context(id);
        assert_eq!(ctx.model.as_deref(), Some("GourdWork-test"), "legacy fields lost");
        assert_eq!(ctx.thinking.as_deref(), Some("high"));
        assert_eq!(ctx.access_mode.as_deref(), Some("full"));
        assert_eq!(ctx.interrupted, None, "absent key must read as None");
    }

    /// The flag must survive a write/read round-trip, or an abnormal exit that
    /// crosses a kernel restart never produces a calibration.
    #[test]
    fn interrupted_flag_round_trips_and_is_omitted_when_unset() {
        let s = Scratch::new("context-interrupted-roundtrip");
        let store = SessionStore::with_base(s.0.clone());
        let id = "work-interrupted-ctx";

        // Unset writes nothing: no key may leak into the stored file for sessions
        // that never aborted (the same skip_serializing_if discipline the other
        // optional fields use).
        store.write_context(id, &SessionContext::default());
        let raw = std::fs::read_to_string(store.session_dir_pub(id).join("context.json")).unwrap();
        assert!(!raw.contains("interrupted"), "unset flag serialised: {raw}");

        let ctx = SessionContext {
            interrupted: Some(true),
            ..Default::default()
        };
        store.write_context(id, &ctx);
        let back = store.read_context(id);
        assert_eq!(back.interrupted, Some(true), "flag lost in round-trip");
    }

}
