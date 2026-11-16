//! changes — File-change ledger (non-git change tracking).
//!
//! Mirrors the Java kernel's FileChangeService. Content-addressed storage:
//! `<workspace>/.gwork/sessions/<sessionId>/file-changes/`
//! ├── manifests/<runId>.json   one manifest per run
//! └── blobs/<sha256>           content-addressed, shared within a session
//!
//! For each touched path we keep only the FIRST-before and LAST-after states.
//! Files larger than 8MiB store hash only (contentSkipped=true).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::ephemeral;

/// Run a blocking closure **off** the async worker thread.
///
/// WHY THIS EXISTS (measured pattern, not guessed): every method here is
/// synchronous and is called directly from `async` axum handlers
/// (`server/changes_api.rs`, not ours to change). `list_session` reads and
/// `serde_json`-parses **every** manifest under a session; `diff` slurps whole
/// blobs; `undo_run` rewrites every touched file. All of that is blocking I/O on
/// a tokio worker, and a blocked worker stalls every other task pinned to it —
/// the measured shape of that failure elsewhere in this repo is `/web/chat/meta`
/// going 0.23 ms → 85.85 ms under 8 concurrent blocking requests.
///
/// `block_in_place` rather than `spawn_blocking` so the public API stays
/// synchronous. It panics on a `current_thread` runtime, hence the flavour check;
/// outside a multi-thread runtime the closure runs inline, exactly as before.
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

/// Max file content captured into a blob (8 MiB).
const MAX_CONTENT_BYTES: u64 = 8 * 1024 * 1024;

/// A snapshot of a file at one point in time.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct FileState {
    pub exists: bool,
    pub hash: String,
    pub binary: bool,
    #[serde(rename = "contentSkipped")]
    pub content_skipped: bool,
}

/// One entry in a run manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeEntry {
    pub path: String,
    pub before: FileState,
    pub after: FileState,
    #[serde(default)]
    pub undone: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub additions: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deletions: Option<i64>,
}

/// A run manifest.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Manifest {
    pub version: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "runId")]
    pub run_id: String,
    pub revision: u64,
    pub ready: bool,
    #[serde(rename = "possiblyIncomplete")]
    pub possibly_incomplete: bool,
    /// Human-readable reasons why the ledger may be short (Java
    /// `Manifest.incompleteReasons`).
    ///
    /// `possiblyIncomplete` on its own tells the UI *that* the list may be
    /// incomplete; this tells the user *why*, and `app-file-changes.js` renders it
    /// verbatim through `incompleteText()`. Without it an abnormal run shows a
    /// bare warning with no explanation.
    ///
    /// Always goes through [`ChangeLedger::add_reason`] rather than being pushed
    /// directly: the list rides in every `file_changes` frame, so it needs the
    /// dedup and hard cap Java applies for the same reason.
    ///
    /// `#[serde(default)]` matters — manifests written before this field existed
    /// must still deserialize instead of failing to load and looking like
    /// "no changes recorded".
    #[serde(rename = "incompleteReasons", default)]
    pub incomplete_reasons: Vec<String>,
    #[serde(rename = "lastStatus")]
    pub last_status: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    /// Absolute path of the working tree this run's relative paths belong to.
    ///
    /// The ledger's **data** (manifest/blobs) always lives under the kernel's
    /// global `AppState.workspace` so the outputs panel can read every session
    /// through one `ChangeLedger`. The *working tree* is a different thing: a
    /// session bound to another project runs its tools in `bound_root` (see
    /// `resolve_run_workspace`). Persisting the tool root with the manifest is
    /// what keeps `before/record/undo/reapply/entry_visible` pointing at the
    /// same tree the tools actually wrote — across process restarts, and for
    /// historical manifests. Empty on legacy manifests: callers fall back to
    /// the kernel workspace.
    #[serde(rename = "workspaceRoot", default)]
    pub workspace_root: String,
    pub entries: Vec<ChangeEntry>,
}

/// The change ledger service.
#[derive(Debug)]
pub struct ChangeLedger {
    /// Where the ledger stores manifests and blobs (`<root>/.gwork/sessions/...`).
    workspace: PathBuf,
    /// Per-session working-tree roots, registered by the run spawner / tools.
    /// Shared `Arc` clones (sub-agents, HTTP handlers) all see the same map.
    run_roots: RwLock<HashMap<String, PathBuf>>,
    /// `(child_session, child_run) -> (parent_session, parent_run)`.
    ///
    /// Sub-agents run with synthetic `sub-*` ids (frames must not look like a
    /// new conversation), but their `write`/`edit` results belong to the run
    /// the user is watching. Without this map their changes land in an orphan
    /// manifest that `finish(parent_run)` never publishes — one of the two
    /// reasons "this turn clearly changed files but no card appeared".
    run_aliases: RwLock<HashMap<(String, String), (String, String)>>,
    /// Per-manifest mutation locks. `record`/`note_bash`/`finish`/`reopen`/
    /// `finalize_orphans`/`undo`/`reapply` all do a read-modify-save on one
    /// `<sid,rid>.json`. Parallel sub-agents (multitask) alias to the SAME
    /// parent manifest, so without this lock two writers each load revision R,
    /// push one entry, and the second `save` silently drops the first — the
    /// original "clearly changed files but no card" symptom reappears.
    run_muts: RwLock<HashMap<(String, String), Arc<Mutex<()>>>>,
    /// Process start (ms). `finalize_orphans` may only close manifests that
    /// were last touched BEFORE this process started: those are the remnants of
    /// a killed prior process. Every manifest this process wrote — an active
    /// run, a concurrent loop run, a `reopen`ed resume segment — has
    /// `updatedAt >= process_started_ms` and must NOT be swept. Sweeping one of
    /// those flips `ready` early; the real `finish()` then hits its idempotence
    /// gate and the final frame is silently dropped.
    process_started_ms: i64,
    /// Monotonic counter for unique atomic-write temp names. A fixed
    /// `<run>.json.tmp` collides between concurrent saves of the same run.
    tmp_seq: AtomicU64,
}

/// A bash command may have touched files without going through `write`/`edit`.
/// Java records exactly this sentence in `incompleteReasons`; keep it identical
/// so the two kernels render the same warning through `incompleteText()`.
pub const BASH_INCOMPLETE_REASON: &str =
    "bash was invoked and may have changed untracked files";

/// Cap on [`Manifest::incomplete_reasons`] (Java `MAX_INCOMPLETE_REASONS`).
///
/// The list rides in every `file_changes` frame, so an unbounded append would
/// grow the frame: a long run with dozens of snapshot failures could produce
/// dozens of near-identical reasons and blow out the card. Java caps it for
/// exactly this reason.
pub const MAX_INCOMPLETE_REASONS: usize = 20;

impl ChangeLedger {
    /// Append a reason, deduplicated and capped.
    ///
    /// Never a plain `push`: Java routes every reason through `addReason` so the
    /// broadcast list stays bounded and free of repeats. On overflow the last slot
    /// is replaced with a fixed "further reasons suppressed" marker, which keeps
    /// the list at the cap while still telling the reader that more exists.
    fn add_reason(manifest: &mut Manifest, reason: &str) {
        if manifest.incomplete_reasons.iter().any(|r| r == reason) {
            return;
        }
        if manifest.incomplete_reasons.len() >= MAX_INCOMPLETE_REASONS {
            manifest.incomplete_reasons[MAX_INCOMPLETE_REASONS - 1] =
                "further reasons suppressed (see server log)".to_string();
            return;
        }
        manifest.incomplete_reasons.push(reason.to_string());
    }

    pub fn new(workspace: PathBuf) -> Self {
        Self {
            workspace,
            run_roots: RwLock::new(HashMap::new()),
            run_aliases: RwLock::new(HashMap::new()),
            run_muts: RwLock::new(HashMap::new()),
            process_started_ms: now_ms(),
            tmp_seq: AtomicU64::new(0),
        }
    }

    /// Serialize all read-modify-save operations on one manifest.
    fn run_lock(&self, session_id: &str, run_id: &str) -> Arc<Mutex<()>> {
        let key = (session_id.to_string(), run_id.to_string());
        // Fast path: reuse the existing lock without taking the write lock.
        if let Ok(map) = self.run_muts.read() {
            if let Some(l) = map.get(&key) {
                return l.clone();
            }
        }
        let mut map = match self.run_muts.write() {
            Ok(m) => m,
            Err(p) => p.into_inner(),
        };
        map.entry(key).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
    }

    /// Resolve an alias chain to its root. Nested sub-agents used to inherit a
    /// `sub-*` runId as their parent, so a single lookup left their writes in
    /// an orphan `(real_session, sub-xxx)` manifest.
    fn target(&self, session_id: &str, run_id: &str) -> (String, String) {
        let mut cur = (session_id.to_string(), run_id.to_string());
        // Bounded to break any accidental cycle in the alias map.
        for _ in 0..16 {
            let next = self
                .run_aliases
                .read()
                .ok()
                .and_then(|m| m.get(&cur).cloned());
            match next {
                Some(n) if n != cur => cur = n,
                _ => break,
            }
        }
        cur
    }

    /// Make a sub-agent's ledger writes land in the parent run's manifest.
    pub fn alias_run(
        &self,
        child_session: &str,
        child_run: &str,
        parent_session: &str,
        parent_run: &str,
    ) {
        if let Ok(mut map) = self.run_aliases.write() {
            map.insert(
                (child_session.to_string(), child_run.to_string()),
                (parent_session.to_string(), parent_run.to_string()),
            );
        }
        if let Ok(mut map) = self.run_roots.write() {
            if let Some(root) = map.get(parent_session).cloned() {
                map.insert(child_session.to_string(), root);
            }
        }
    }

    /// Register the working tree a run's tools operate in.
    ///
    /// `ChangeLedger` is a single `Arc` shared by the server, the ReAct loop and
    /// every tool context. Registering here (instead of adding yet another
    /// `ReActConfig`/`ToolContext` field) means sub-agents and the HTTP handlers
    /// resolve the same root as the main run without any extra plumbing. The
    /// root is also persisted into the manifest on the first `record`, so a
    /// restart does not lose it.
    pub fn register_run_root(&self, session_id: &str, root: &Path) {
        if let Ok(mut map) = self.run_roots.write() {
            map.insert(session_id.to_string(), root.to_path_buf());
        }
    }

    /// Working-tree root for a session: the registered run root, else the
    /// kernel workspace. Used for *new* captures; existing manifests carry
    /// their own `workspaceRoot` and go through `tree_root`.
    fn live_root(&self, session_id: &str) -> PathBuf {
        self.run_roots
            .read()
            .ok()
            .and_then(|m| m.get(session_id).cloned())
            .unwrap_or_else(|| self.workspace.clone())
    }

    /// Resolve the tree a path belongs to. Absolute paths are normalised to a
    /// path relative to `root` (a bound project must never be recorded as an
    /// absolute path that the outputs panel cannot re-open); relative paths
    /// are stripped of `./` and drive-letter prefixes left by some shells.
    fn normalize_rel(root: &Path, raw: &str) -> String {
        let raw = raw.replace('\\', "/");
        // Byte-length-preserving normalisation: compare case-insensitively so
        // `c:/work/proj` and `C:\Work\Proj` resolve to the same tree, then
        // slice the ORIGINAL string at the same byte offsets (ASCII lowercase
        // never changes length, so those offsets stay on char boundaries).
        let root_norm = root
            .to_string_lossy()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_ascii_lowercase();
        let raw_norm = raw.to_ascii_lowercase();
        let prefix = format!("{}/", root_norm);

        let rel_str: Option<String> = if raw_norm == root_norm {
            Some(String::new())
        } else if raw_norm.starts_with(&prefix) {
            // Absolute / drive-letter / UNC path INSIDE the working tree.
            Some(raw[root_norm.len() + 1..].to_string())
        } else {
            let p = Path::new(&raw);
            let bytes = raw.as_bytes();
            let win_abs = bytes.len() > 3
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && bytes[2] == b'/';
            if p.is_absolute() || win_abs || raw.starts_with("//") {
                // An absolute path OUTSIDE the tree must be refused, not
                // flattened into a bogus relative path: `undo/reapply` join it
                // with root and would write into the wrong tree (or drive).
                None
            } else {
                Some(raw.clone())
            }
        };
        let Some(rel_str) = rel_str else {
            return String::new();
        };
        let rel = PathBuf::from(&rel_str);
        let mut out = String::new();
        for c in rel.components() {
            match c {
                std::path::Component::Normal(s) => {
                    if !out.is_empty() { out.push('/'); }
                    out.push_str(&s.to_string_lossy());
                }
                std::path::Component::ParentDir => {
                    // `undo/reapply` write to `root.join(&entry.path)`, so a
                    // stored `..` could escape the working tree. The tools
                    // already reject out-of-root paths via `resolve_safe`;
                    // return empty here so `before`/`record` skip the entry
                    // entirely instead of persisting a traversal path.
                    return String::new();
                }
                _ => {}
            }
        }
        out
    }

    /// Pick the working tree for a manifest. A persisted `workspaceRoot` always
    /// wins; otherwise the live registration, then the kernel workspace.
    fn tree_root(&self, session_id: &str, manifest: Option<&Manifest>) -> PathBuf {
        if let Some(m) = manifest {
            if !m.workspace_root.is_empty() {
                return PathBuf::from(&m.workspace_root);
            }
        }
        self.live_root(session_id)
    }

    fn base_dir(&self, session_id: &str) -> PathBuf {
        self.workspace
            .join(".gwork")
            .join("sessions")
            .join(session_id)
            .join("file-changes")
    }

    fn manifest_path(&self, session_id: &str, run_id: &str) -> PathBuf {
        self.base_dir(session_id)
            .join("manifests")
            .join(format!("{}.json", safe_segment(run_id)))
    }

    fn blob_path(&self, session_id: &str, hash: &str) -> PathBuf {
        self.base_dir(session_id).join("blobs").join(hash)
    }

    fn load_manifest(&self, session_id: &str, run_id: &str) -> Option<Manifest> {
        let path = self.manifest_path(session_id, run_id);
        let content = std::fs::read_to_string(&path).ok()?;
        serde_json::from_str(&content).ok()
    }

    fn save_manifest(&self, session_id: &str, manifest: &Manifest) -> anyhow::Result<()> {
        let path = self.manifest_path(session_id, &manifest.run_id);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(manifest)?;
        // UNIQUE temp name. A fixed `<run>.json.tmp` collides when two parallel
        // sub-agents (aliased to the SAME parent manifest) save concurrently:
        // one rename consumes the other's temp file and the second save fails,
        // silently dropping a recorded change. pid + monotonic counter keeps
        // every atomic write independent.
        let n = self.tmp_seq.fetch_add(1, Ordering::Relaxed);
        let tmp = path.with_extension(format!("json.{}.{}.tmp", std::process::id(), n));
        if let Err(e) = std::fs::write(&tmp, json).and_then(|_| std::fs::rename(&tmp, &path)) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.into());
        }
        Ok(())
    }

    /// The working tree a capture for `(session, run)` must use.
    ///
    /// `before()` and `record()` MUST agree on this. Reading `live_root` in one
    /// and `tree_root(manifest)` in the other made them diverge whenever an
    /// alias, a re-registered root, or a persisted `workspaceRoot` was present —
    /// before/after then came from two different trees (the original empty-card
    /// bug). Resolving through `target()` + existing manifest here makes both
    /// ends read the same root.
    fn capture_root(&self, session_id: &str, run_id: &str) -> (String, String, PathBuf) {
        let (sid, rid) = self.target(session_id, run_id);
        let existing = self.load_manifest(&sid, &rid);
        let root = self.tree_root(&sid, existing.as_ref());
        (sid, rid, root)
    }

    /// Capture the "before" state of a file and store its blob.
    /// Returns a token (path) used to finalize "after" via `after`.
    ///
    /// Uses the same root as `record()` (`capture_root`), not a bare
    /// `live_root(original_session)`, so before/after can never be split across
    /// two working trees for aliased or bound projects.
    pub fn before(&self, session_id: &str, run_id: &str, rel_path: &str) -> Option<FileState> {
        // Skip ephemeral paths entirely
        if ephemeral::is_ephemeral_relative(rel_path, false) {
            return None;
        }
        let (sid, _rid, root) = self.capture_root(session_id, run_id);
        let rel = Self::normalize_rel(&root, rel_path);
        if rel.is_empty() || ephemeral::is_ephemeral_relative(&rel, false) {
            return None;
        }
        let abs = root.join(&rel);
        let state = self.snapshot(&sid, &abs);
        Some(state)
    }

    fn snapshot(&self, session_id: &str, abs: &Path) -> FileState {
        if !abs.is_file() {
            return FileState { exists: false, ..Default::default() };
        }
        let Ok(bytes) = std::fs::read(abs) else {
            return FileState { exists: true, ..Default::default() };
        };
        let hash = hex::encode(Sha256::digest(&bytes));
        let binary = looks_binary(&bytes);
        let content_skipped = bytes.len() as u64 > MAX_CONTENT_BYTES;
        if !content_skipped && !binary {
            // Store blob (content-addressed, idempotent)
            let blob = self.blob_path(session_id, &hash);
            if !blob.exists() {
                if let Some(parent) = blob.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(&blob, &bytes);
            }
        }
        FileState { exists: true, hash, binary, content_skipped }
    }

    /// Line additions/deletions between two snapshots. Ported 1:1 from the Java
    /// kernel's `FileChangeService.ensureLineStats` + `lineDelta`.
    ///
    /// - binary or content-skipped (>8 MiB) → (0, 0): no blob was stored, so
    ///   there is nothing to diff.
    /// - file added → additions = line count of `after`.
    /// - file deleted → deletions = line count of `before`.
    /// - modified → trim the common prefix/suffix, then LCS when the diff is
    ///   small enough, else an O(n) multiset delta (the Java `MAX_DIFF_*`
    ///   guard, kept at the same thresholds so the two kernels agree).
    fn line_stats(&self, session_id: &str, before: &FileState, after: &FileState) -> (i64, i64) {
        if before.binary || after.binary || before.content_skipped || after.content_skipped {
            return (0, 0);
        }
        if !before.exists {
            let text = if after.exists { self.read_blob_text(session_id, &after.hash) } else { String::new() };
            return (split_lines(&text).len() as i64, 0);
        }
        if !after.exists {
            let text = self.read_blob_text(session_id, &before.hash);
            return (0, split_lines(&text).len() as i64);
        }
        // Bind the decoded text first: `split_lines` borrows it, and a temporary
        // String would be dropped at the end of the statement (E0716).
        let before_text = self.read_blob_text(session_id, &before.hash);
        let after_text = self.read_blob_text(session_id, &after.hash);
        let b = split_lines(&before_text);
        let a = split_lines(&after_text);
        line_delta(&b, &a)
    }

    /// Record a completed change (before → after) into the run manifest.
    ///
    /// `session_id`/`run_id` may be a sub-agent's synthetic ids: `target()`
    /// redirects the write into the parent run's manifest so the change card
    /// the user sees covers delegated work too.
    pub fn record(
        &self,
        session_id: &str,
        run_id: &str,
        rel_path: &str,
        before: FileState,
    ) -> anyhow::Result<()> {
        if ephemeral::is_ephemeral_relative(rel_path, false) {
            return Ok(());
        }
        let (sid, rid) = self.target(session_id, run_id);
        // Serialize with every other writer on this manifest. Parallel
        // sub-agents alias to the same parent run; without this lock two
        // `record` calls load the same revision, push one entry each, and the
        // last save silently discards the other change.
        let _lock_arc = self.run_lock(&sid, &rid);
        let _guard = _lock_arc.lock().unwrap_or_else(|p| p.into_inner());
        let mut manifest = self.load_manifest(&sid, &rid).unwrap_or_else(|| self.blank_manifest(&sid, &rid));
        let root = self.tree_root(&sid, Some(&manifest));
        let rel = Self::normalize_rel(&root, rel_path);
        if rel.is_empty() || ephemeral::is_ephemeral_relative(&rel, false) {
            return Ok(());
        }
        let abs = root.join(&rel);
        let after = self.snapshot(&sid, &abs);
        let (additions, deletions) = self.line_stats(&sid, &before, &after);

        // Keep only first-before / last-after per path. Line stats are recomputed
        // against the *stored* first-before whenever a later record changes
        // `after`, so the entry always describes first-before → last-after.
        if let Some(existing) = manifest.entries.iter_mut().find(|e| e.path == rel) {
            existing.after = after;
            let (add, del) = self.line_stats(&sid, &existing.before, &existing.after);
            existing.additions = Some(add);
            existing.deletions = Some(del);
        } else {
            manifest.entries.push(ChangeEntry {
                path: rel,
                before,
                after,
                undone: false,
                additions: Some(additions),
                deletions: Some(deletions),
            });
        }
        manifest.revision += 1;
        manifest.updated_at = now_ms();
        self.save_manifest(&sid, &manifest)
    }

    fn blank_manifest(&self, session_id: &str, run_id: &str) -> Manifest {
        Manifest {
            version: "1".into(),
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            revision: 0,
            ready: false,
            possibly_incomplete: false,
            incomplete_reasons: Vec::new(),
            last_status: "CAPTURED".into(),
            updated_at: now_ms(),
            workspace_root: self.live_root(session_id).to_string_lossy().to_string(),
            entries: Vec::new(),
        }
    }

    /// Record that a run used `bash` (or a similarly opaque path) which may have
    /// changed files outside `write`/`edit`. Creates a manifest even when no
    /// tracked file exists, so `finish()` has something to publish: the UI can
    /// then show a "possibly incomplete" card instead of nothing at all.
    /// Java's ledger writes the same `incompleteReasons` sentence.
    pub fn note_bash(&self, session_id: &str, run_id: &str) {
        let (sid, rid, root) = self.capture_root(session_id, run_id);
        let _lock_arc = self.run_lock(&sid, &rid);
        let _guard = _lock_arc.lock().unwrap_or_else(|p| p.into_inner());
        let mut manifest = self.load_manifest(&sid, &rid)
            .unwrap_or_else(|| self.blank_manifest(&sid, &rid));
        let reasons_before = manifest.incomplete_reasons.len();
        let was_incomplete = manifest.possibly_incomplete;
        Self::add_reason(&mut manifest, BASH_INCOMPLETE_REASON);
        manifest.possibly_incomplete = true;
        if manifest.workspace_root.is_empty() {
            manifest.workspace_root = root.to_string_lossy().to_string();
        }
        // Bump on EVERY state change (not just the first one). `finish(false)`
        // can append another reason afterwards, and the frontend's monotonic
        // `revision <= previousRevision` gate must accept that later frame.
        // Rust publishes one terminal frame per run, so repeated bash calls in
        // one run still produce a single warning; the extra bumps are harmless.
        if !was_incomplete || manifest.incomplete_reasons.len() != reasons_before
            || manifest.revision == 0
        {
            manifest.revision += 1;
        }
        manifest.updated_at = now_ms();
        let _ = self.save_manifest(&sid, &manifest);
    }

    /// Mark a run as finished and return the summary snapshot to publish.
    ///
    /// `clean` distinguishes a normal wrap-up from an abnormal one:
    /// * `true`  → `lastStatus = READY`.
    /// * `false` → `lastStatus = INCOMPLETE` **and** `possiblyIncomplete = true`.
    ///   The run was cancelled, hit the turn ceiling, or errored, so the last few
    ///   `write`/`edit` calls may never have been recorded. Undo still works —
    ///   Java's comment on this exact flag is that an abnormal finish "同样解锁
    ///   撤销能力" — but the UI must be able to warn that the list may be short.
    ///
    /// Returns `None` when there is nothing to publish: no manifest for this run
    /// (the run touched no tracked file), or the run was **already** finished.
    /// The idempotence mirrors Java's `if (manifest.ready) return true;` and
    /// matters because several termination paths can race — without it a late
    /// abnormal callback would overwrite a completed run's status and re-publish
    /// a duplicate frame.
    ///
    /// The previous signature took no `clean` flag and returned nothing, so the
    /// caller could not tell "published" from "nothing to do", and an abnormal
    /// termination was recorded as a clean `READY`.
    pub fn finish(&self, session_id: &str, run_id: &str, clean: bool) -> Option<serde_json::Value> {
        let (sid, rid) = self.target(session_id, run_id);
        let _lock_arc = self.run_lock(&sid, &rid);
        let _guard = _lock_arc.lock().unwrap_or_else(|p| p.into_inner());
        let mut manifest = self.load_manifest(&sid, &rid)?;
        if manifest.ready {
            return None;
        }
        manifest.ready = true;
        if clean {
            manifest.last_status = "READY".into();
        } else {
            manifest.last_status = "INCOMPLETE".into();
            manifest.possibly_incomplete = true;
            // Same text Java's `finish` records, so the two kernels explain an
            // abnormal stop identically.
            let before = manifest.incomplete_reasons.len();
            Self::add_reason(
                &mut manifest,
                "run terminated abnormally or was stopped; the last writes may not be tracked",
            );
            if manifest.incomplete_reasons.len() != before {
                manifest.revision += 1;
            }
        }
        manifest.updated_at = now_ms();
        if self.save_manifest(&sid, &manifest).is_err() {
            // Do not publish a snapshot we failed to persist: the UI would show a
            // revision that a later read cannot reproduce.
            return None;
        }
        Some(self.summarize(&manifest))
    }

    /// Re-open a run's ledger when the run resumes from a suspension.
    ///
    /// `finish()` is idempotent on `ready` (a late abnormal callback must not
    /// re-publish a completed run). But a suspended run is NOT completed: the
    /// Rust kernel now resumes it with the **same** `runId` (see
    /// `spawn_resume`), so the writes made after the answer arrive must still be
    /// published in one final `file_changes` frame. Without this, the second
    /// `finish()` would see `ready == true` and return `None`, silently dropping
    /// the resumed segment from the change card.
    ///
    /// `revision` is bumped so the frontend's monotonic `upsert` gate accepts the
    /// new snapshot even when no file happened to change after the resume. The
    /// manifest's `entries` are kept: the card stays a single cumulative view of
    /// the whole task (before + after suspension), with undo covering both halves.
    pub fn reopen(&self, session_id: &str, run_id: &str) {
        let (sid, rid) = self.target(session_id, run_id);
        let _lock_arc = self.run_lock(&sid, &rid);
        let _guard = _lock_arc.lock().unwrap_or_else(|p| p.into_inner());
        let Some(mut manifest) = self.load_manifest(&sid, &rid) else {
            return;
        };
        if !manifest.ready {
            return;
        }
        manifest.ready = false;
        manifest.last_status = "CAPTURED".into();
        manifest.revision += 1;
        manifest.updated_at = now_ms();
        let _ = self.save_manifest(&sid, &manifest);
    }

    /// Get a run summary.
    pub fn get_run(&self, session_id: &str, run_id: &str) -> serde_json::Value {
        let session_id = session_id.to_string();
        let run_id = run_id.to_string();
        // Reads the manifest and (on first access) both blobs per entry to
        // backfill line stats; off the async worker for the same reason as `diff`.
        offload(move || self.summarize_blocking(&session_id, &run_id))
    }

    /// Backfill line stats for entries that predate eager computation (their
    /// `additions`/`deletions` are `None`). Returns `true` if anything was
    /// filled, so the caller knows whether to persist. Mirrors the Java kernel's
    /// `ensureLineStats`, which is likewise invoked lazily at read time.
    fn ensure_line_stats(&self, session_id: &str, manifest: &mut Manifest) -> bool {
        let mut changed = false;
        for entry in manifest.entries.iter_mut() {
            if entry.additions.is_none() || entry.deletions.is_none() {
                let (add, del) = self.line_stats(session_id, &entry.before, &entry.after);
                entry.additions = Some(add);
                entry.deletions = Some(del);
                changed = true;
            }
        }
        changed
    }

    fn summarize_blocking(&self, session_id: &str, run_id: &str) -> serde_json::Value {
        let Some(mut manifest) = self.load_manifest(session_id, run_id) else {
            return serde_json::json!({ "status": "NOT_FOUND" });
        };
        // Backfill line stats for manifests captured before this existed (record
        // now computes them eagerly). Persisted so it is computed once per run.
        if self.ensure_line_stats(session_id, &mut manifest) {
            let _ = self.save_manifest(session_id, &manifest);
        }
        self.summarize(&manifest)
    }

    /// Read-time visibility gate for one manifest entry.
    ///
    /// Three rules, in this order:
    /// 1. **Ephemeral paths never surface.** Mirrors the Java kernel's read-side
    ///    filter (`FileChangeService.load`: `if (isEphemeralRelative(...)) continue`):
    ///    ledgers written *before* the write-side guard existed still carry scratch
    ///    rows, so filtering only at write time would leave every historical
    ///    session noisy forever.
    /// 2. **Undone entries stay visible.** Undo is user-visible state and reapply
    ///    must remain reachable; hiding an undone row would strand it.
    /// 3. **Net-zero scratch is hidden.** An entry whose `before` snapshot says
    ///    "did not exist" and whose file is gone from disk *right now* contributed
    ///    nothing to the working tree (created-then-deleted scratch such as
    ///    `.tmp_add_nav_i18n.js` or `_mut_mcp.cjs`). `changeType` is derived from
    ///    the write-time snapshot, so without this rule such rows render as ADDED
    ///    forever after the file was deleted — exactly what the user saw in the
    ///    outputs panel. Codex's `/diff` cannot show this artifact because it reads
    ///    git's live view: an untracked file that no longer exists simply is not
    ///    there. A real ADDED file that still exists is unaffected, as is a real
    ///    file the user deleted (before.exists=true → shows DELETED).
    fn entry_visible(&self, entry: &ChangeEntry, root: &Path) -> bool {
        if ephemeral::is_ephemeral_relative(&entry.path, false) {
            return false;
        }
        if entry.undone {
            return true;
        }
        if !entry.before.exists && !root.join(&entry.path).exists() {
            return false;
        }
        true
    }

    fn summarize(&self, manifest: &Manifest) -> serde_json::Value {
        // Read-side visibility (see `entry_visible`): the published snapshot and
        // every count below must agree on the SAME filtered set, otherwise the
        // card header count jumps between frames. The tree root comes from the
        // manifest itself — a bound project's ADDED file must be looked up under
        // that project, not under the kernel install directory.
        let root = self.tree_root(&manifest.session_id, Some(manifest));
        let visible: Vec<&ChangeEntry> = manifest
            .entries
            .iter()
            .filter(|e| self.entry_visible(e, &root))
            .collect();
        let mut additions = 0i64;
        let mut deletions = 0i64;
        let files: Vec<serde_json::Value> = visible
            .iter()
            .map(|e| {
                let change_type = if !e.before.exists {
                    "ADDED"
                } else if !e.after.exists {
                    "DELETED"
                } else {
                    "MODIFIED"
                };
                let state = if e.undone { "UNDONE" } else { "APPLIED" };
                serde_json::json!({
                    "path": e.path,
                    "changeType": change_type,
                    "binary": e.after.binary || e.before.binary,
                    "state": state,
                    "additions": e.additions.unwrap_or(0),
                    "deletions": e.deletions.unwrap_or(0),
                })
            })
            .collect();
        for e in &visible {
            additions += e.additions.unwrap_or(0);
            deletions += e.deletions.unwrap_or(0);
        }
        let all_undone = !visible.is_empty() && visible.iter().all(|e| e.undone);
        let any_undone = visible.iter().any(|e| e.undone);
        let run_apply_state = if all_undone {
            "FULLY_UNDONE"
        } else if any_undone {
            "PARTIALLY_UNDONE"
        } else {
            "FULLY_APPLIED"
        };
        serde_json::json!({
            "status": "OK",
            "sessionId": manifest.session_id,
            "runId": manifest.run_id,
            "revision": manifest.revision,
            "ready": manifest.ready,
            "possiblyIncomplete": manifest.possibly_incomplete,
            // The frontend renders these verbatim (`incompleteText` in
            // app-file-changes.js). Java's summary carries the same key, and its
            // absence is what made an abnormal run show a bare "possibly
            // incomplete" warning with no explanation of why.
            "incompleteReasons": manifest.incomplete_reasons,
            "updatedAt": manifest.updated_at,
            "files": files,
            "fileCount": visible.len(),
            "additions": additions,
            "deletions": deletions,
            "runApplyState": run_apply_state,
        })
    }

    /// Get a diff for a single path within a run.
    pub fn diff(&self, session_id: &str, run_id: &str, rel_path: &str) -> serde_json::Value {
        let session_id = session_id.to_string();
        let run_id = run_id.to_string();
        let rel_path = rel_path.to_string();
        // Reads the manifest plus up to two whole blobs (each up to 8 MiB).
        offload(move || self.diff_blocking(&session_id, &run_id, &rel_path))
    }

    fn diff_blocking(&self, session_id: &str, run_id: &str, rel_path: &str) -> serde_json::Value {
        let Some(manifest) = self.load_manifest(session_id, run_id) else {
            return serde_json::json!({ "status": "NOT_FOUND" });
        };
        let Some(entry) = manifest.entries.iter().find(|e| e.path == rel_path) else {
            return serde_json::json!({ "status": "NOT_FOUND" });
        };
        let change_type = if !entry.before.exists {
            "ADDED"
        } else if !entry.after.exists {
            "DELETED"
        } else {
            "MODIFIED"
        };
        let binary = entry.before.binary || entry.after.binary;
        let mut resp = serde_json::json!({
            "status": "OK",
            "path": rel_path,
            "changeType": change_type,
            "binary": binary,
            "revision": manifest.revision,
        });
        if !binary {
            if entry.before.exists {
                resp["before"] = serde_json::json!(self.read_blob_text(session_id, &entry.before.hash));
            }
            if entry.after.exists {
                resp["after"] = serde_json::json!(self.read_blob_text(session_id, &entry.after.hash));
            }
        }
        resp
    }

    fn read_blob_text(&self, session_id: &str, hash: &str) -> String {
        if hash.is_empty() {
            return String::new();
        }
        let blob = self.blob_path(session_id, hash);
        match std::fs::read(&blob) {
            // Blobs mirror the working tree verbatim; a GBK-encoded source
            // file must diff as text, not as replacement blocks.
            Ok(bytes) => crate::textcodec::decode_bytes(&bytes),
            Err(_) => String::new(),
        }
    }

    /// List all runs for a session (merged across runs).
    pub fn list_session(&self, session_id: &str) -> serde_json::Value {
        let session_id = session_id.to_string();
        // Reads + parses every manifest in the session, then merges them. Off the
        // worker: see `offload`.
        offload(move || self.list_session_blocking(&session_id))
    }

    fn list_session_blocking(&self, session_id: &str) -> serde_json::Value {
        let manifests_dir = self.base_dir(session_id).join("manifests");
        let mut runs: Vec<Manifest> = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&manifests_dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.extension().map(|x| x == "json").unwrap_or(false) {
                    if let Ok(c) = std::fs::read_to_string(&p) {
                        if let Ok(m) = serde_json::from_str::<Manifest>(&c) {
                            runs.push(m);
                        }
                    }
                }
            }
        }
        // Ascending by updatedAt: the merge below lets the NEWEST run overwrite the
        // state fields per path (Java `listSessionLocked` iterates ascending with a
        // `>=` check for exactly this reason).
        runs.sort_by(|a, b| a.updated_at.cmp(&b.updated_at));

        // Merge files across runs. Per-path semantics (ported from the Java
        // kernel): state fields (changeType/binary/state/additions/deletions) take
        // the snapshot of the most recent run that touched the path — summing
        // across runs would double-count repeated edits of the same file; runIds
        // accumulate so the panel can drill back into `/changes/diff`.
        let mut merged: HashMap<String, serde_json::Value> = HashMap::new();
        let mut run_summaries = Vec::new();
        for m in &mut runs {
            // Backfill line stats for runs captured before eager computation,
            // persisted so the blob reads happen once per run (Java `maintain`).
            if self.ensure_line_stats(session_id, m) {
                let _ = self.save_manifest(session_id, m);
            }
            let root = self.tree_root(session_id, Some(m));
            run_summaries.push(serde_json::json!({
                "runId": m.run_id,
                "updatedAt": m.updated_at,
                // Count the VISIBLE entries, matching `summarize`'s fileCount:
                // raw `entries.len()` would count scratch rows the panel never
                // shows, making the per-run counts disagree with the file list.
                "fileCount": m.entries.iter().filter(|e| self.entry_visible(e, &root)).count(),
                "possiblyIncomplete": m.possibly_incomplete,
            }));
            for e in m.entries.iter().filter(|e| self.entry_visible(e, &root)) {
                let change_type = if !e.before.exists {
                    "ADDED"
                } else if !e.after.exists {
                    "DELETED"
                } else {
                    "MODIFIED"
                };
                let state = if e.undone { "UNDONE" } else { "APPLIED" };
                let binary = e.before.binary || e.after.binary;
                let additions = e.additions.unwrap_or(0);
                let deletions = e.deletions.unwrap_or(0);
                let acc = merged.entry(e.path.clone()).or_insert_with(|| {
                    serde_json::json!({
                        "path": e.path,
                        "runIds": [],
                        "lastUpdatedAt": -1i64,
                    })
                });
                if let Some(arr) = acc["runIds"].as_array_mut() {
                    if !arr.iter().any(|r| r == &serde_json::json!(m.run_id)) {
                        arr.push(serde_json::json!(m.run_id));
                    }
                }
                // Ascending iteration + `>=`: a newer (or equally new) run
                // overwrites the state fields.
                if m.updated_at >= acc["lastUpdatedAt"].as_i64().unwrap_or(-1) {
                    acc["changeType"] = serde_json::json!(change_type);
                    acc["binary"] = serde_json::json!(binary);
                    acc["state"] = serde_json::json!(state);
                    acc["additions"] = serde_json::json!(additions);
                    acc["deletions"] = serde_json::json!(deletions);
                    acc["lastUpdatedAt"] = serde_json::json!(m.updated_at);
                }
            }
        }
        // Panel shows newest-first, so reverse the ascending run list.
        run_summaries.reverse();
        let mut files: Vec<serde_json::Value> = merged.into_values().collect();
        files.sort_by(|a, b| {
            a["path"].as_str().unwrap_or("").cmp(b["path"].as_str().unwrap_or(""))
        });
        // Session-level totals: sum over the merged (de-duplicated) files, exactly
        // as the Java `sessionLedgerResult` does — NOT over every run entry, which
        // would double-count a file edited in several runs.
        let additions: i64 = files
            .iter()
            .map(|f| f["additions"].as_i64().unwrap_or(0).max(0))
            .sum();
        let deletions: i64 = files
            .iter()
            .map(|f| f["deletions"].as_i64().unwrap_or(0).max(0))
            .sum();
        // `runs` is ascending, so the newest updatedAt is the last element.
        let updated_at = runs.last().map(|r| r.updated_at).unwrap_or(0);
        serde_json::json!({
            "status": "OK",
            "sessionId": session_id,
            "files": files,
            "fileCount": files.len(),
            "additions": additions,
            "deletions": deletions,
            "runs": run_summaries,
            "runCount": runs.len(),
            "updatedAt": updated_at,
            "possiblyIncomplete": runs.iter().any(|r| r.possibly_incomplete),
            "truncated": false,
        })
    }

    /// Undo a single file: restore its "before" blob content.
    pub fn undo_file(
        &self,
        session_id: &str,
        run_id: &str,
        rel_path: &str,
    ) -> serde_json::Value {
        let session_id = session_id.to_string();
        let run_id = run_id.to_string();
        let rel_path = rel_path.to_string();
        // Hashes the current file, reads a blob and rewrites the target.
        offload(move || self.undo_file_blocking(&session_id, &run_id, &rel_path))
    }

    fn undo_file_blocking(
        &self,
        session_id: &str,
        run_id: &str,
        rel_path: &str,
    ) -> serde_json::Value {
        let Some(mut manifest) = self.load_manifest(session_id, run_id) else {
            return serde_json::json!({ "status": "NOT_FOUND" });
        };
        let root = self.tree_root(session_id, Some(&manifest));
        let Some(entry) = manifest.entries.iter_mut().find(|e| e.path == rel_path) else {
            return serde_json::json!({ "status": "NOT_FOUND" });
        };
        let abs = root.join(rel_path);
        // Conflict pre-check: current content must match "after"
        let current = self.snapshot(session_id, &abs);
        if entry.after.exists && current.exists && current.hash != entry.after.hash {
            return serde_json::json!({ "status": "CONFLICT" });
        }
        // Restore
        if entry.before.exists {
            let content = self.read_blob_text(session_id, &entry.before.hash);
            if let Some(parent) = abs.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if std::fs::write(&abs, content).is_err() {
                return serde_json::json!({ "status": "ERROR_PARTIAL" });
            }
        } else {
            let _ = std::fs::remove_file(&abs);
        }
        entry.undone = true;
        manifest.last_status = "UNDONE".into();
        manifest.revision += 1;
        manifest.updated_at = now_ms();
        let _ = self.save_manifest(session_id, &manifest);
        serde_json::json!({ "status": "OK", "summary": self.summarize_blocking(session_id, run_id) })
    }

    /// Undo an entire run.
    pub fn undo_run(&self, session_id: &str, run_id: &str) -> serde_json::Value {
        let session_id = session_id.to_string();
        let run_id = run_id.to_string();
        offload(move || {
            let Some(manifest) = self.load_manifest(&session_id, &run_id) else {
                return serde_json::json!({ "status": "NOT_FOUND" });
            };
            let paths: Vec<String> = manifest.entries.iter().map(|e| e.path.clone()).collect();
            let mut last = serde_json::json!({ "status": "OK" });
            for p in paths {
                // Already inside `offload`; call the blocking body directly so the
                // per-file work is not re-dispatched (and so a CONFLICT still
                // short-circuits the loop exactly as before).
                last = self.undo_file_blocking(&session_id, &run_id, &p);
                if last["status"] == "CONFLICT" {
                    return last;
                }
            }
            last
        })
    }

    /// Reapply a run: restore "after" content for undone entries.
    pub fn reapply_run(&self, session_id: &str, run_id: &str) -> serde_json::Value {
        let session_id = session_id.to_string();
        let run_id = run_id.to_string();
        offload(move || self.reapply_run_blocking(&session_id, &run_id))
    }

    fn reapply_run_blocking(&self, session_id: &str, run_id: &str) -> serde_json::Value {
        let Some(mut manifest) = self.load_manifest(session_id, run_id) else {
            return serde_json::json!({ "status": "NOT_FOUND" });
        };
        let root = self.tree_root(session_id, Some(&manifest));
        for entry in manifest.entries.iter_mut() {
            if !entry.undone {
                continue;
            }
            let abs = root.join(&entry.path);
            if entry.after.exists {
                let content = self.read_blob_text(session_id, &entry.after.hash);
                if let Some(parent) = abs.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(&abs, content);
            } else {
                let _ = std::fs::remove_file(&abs);
            }
            entry.undone = false;
        }
        manifest.last_status = "REAPPLIED".into();
        manifest.revision += 1;
        manifest.updated_at = now_ms();
        let _ = self.save_manifest(session_id, &manifest);
        serde_json::json!({ "status": "OK", "summary": self.summarize_blocking(session_id, run_id) })
    }

    /// Remove all change data for a session.
    pub fn remove_session(&self, session_id: &str) {
        let dir = self.base_dir(session_id);
        let _ = std::fs::remove_dir_all(&dir);
        if let Ok(mut map) = self.run_roots.write() {
            map.remove(session_id);
        }
        if let Ok(mut map) = self.run_aliases.write() {
            // Alias keys are synthetic `sub-*` ids; the session being removed is
            // the PARENT. Drop both halves so a long-lived desktop process with
            // many delegated tasks does not accumulate stale aliases.
            map.retain(|(child, _), (parent, _)| child != session_id && parent != session_id);
        }
    }

    /// Publish a final snapshot for manifests that were captured but never
    /// reached `finish()` (a run killed before wrap-up). Returns one summary per
    /// orphan so the caller can emit the missing `file_changes` frames; the
    /// revision is bumped so the frontend's monotonic `upsert` gate accepts them.
    ///
    /// Real manifests in the field have been observed with `ready=false` after a
    /// process restart, which is why the left outputs panel could show a change
    /// while the per-run card stayed empty (and vice versa).
    ///
    /// ONLY manifests last touched BEFORE this process started are eligible.
    /// A `ready=false` manifest written by THIS process is an active run, a
    /// concurrent loop run, or a just-`reopen`ed resume segment — sweeping it
    /// flips `ready` early and the real `finish()` then drops its final frame.
    pub fn finalize_orphans(&self, session_id: &str) -> Vec<serde_json::Value> {
        let dir = self.base_dir(session_id).join("manifests");
        let Ok(rd) = std::fs::read_dir(&dir) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().map(|x| x == "json").unwrap_or(false) {
                let c = match std::fs::read_to_string(&p) {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                let m0: Manifest = match serde_json::from_str(&c) {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                // `updatedAt == 0` covers legacy manifests without the field.
                if m0.ready || (m0.updated_at != 0 && m0.updated_at >= self.process_started_ms) {
                    continue;
                }
                let _lock_arc = self.run_lock(session_id, &m0.run_id);
                let _guard = _lock_arc.lock().unwrap_or_else(|p| p.into_inner());
                // Re-read under the lock: another wrap-up may have finished it.
                let mut m = match self.load_manifest(session_id, &m0.run_id) {
                    Some(m) => m,
                    None => continue,
                };
                if m.ready || (m.updated_at != 0 && m.updated_at >= self.process_started_ms) {
                    continue;
                }
                m.ready = true;
                m.last_status = "RECOVERED".into();
                m.revision += 1;
                m.updated_at = now_ms();
                if self.save_manifest(session_id, &m).is_ok() {
                    out.push(self.summarize(&m));
                }
            }
        }
        out
    }
}

fn safe_segment(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Heuristic: content is binary if it contains a NUL byte in the first 8KB.
fn looks_binary(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(8192)];
    sample.contains(&0)
}

/// Split text into lines, stripping a trailing `\r` from each `\n`-terminated
/// line. Mirrors the Java kernel's `splitLines` exactly so both kernels count
/// the same way on CRLF files.
fn split_lines(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut from = 0usize;
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'\n' {
            let mut line = &text[from..i];
            if line.ends_with('\r') {
                line = &line[..line.len() - 1];
            }
            out.push(line);
            from = i + 1;
        }
    }
    if from < text.len() {
        out.push(&text[from..]);
    }
    out
}

/// LCS thresholds, identical to the Java kernel's `MAX_DIFF_LINES` /
/// `MAX_DIFF_CELLS`. Above either, `line_delta` degrades to the O(n) multiset
/// delta instead of building an O(n*m) DP table.
const MAX_DIFF_LINES: usize = 20_000;
const MAX_DIFF_CELLS: u64 = 4_000_000;

/// Additions/deletions between two line lists. Ported from the Java kernel's
/// `lineDelta`: trim the common prefix/suffix, then LCS (small) or multiset
/// delta (large). Returns `(additions, deletions)`.
fn line_delta(before: &[&str], after: &[&str]) -> (i64, i64) {
    let mut start = 0usize;
    let mut before_end = before.len();
    let mut after_end = after.len();
    while start < before_end && start < after_end && before[start] == after[start] {
        start += 1;
    }
    while before_end > start && after_end > start && before[before_end - 1] == after[after_end - 1] {
        before_end -= 1;
        after_end -= 1;
    }
    let a = &before[start..before_end];
    let b = &after[start..after_end];
    if a.is_empty() {
        return (b.len() as i64, 0);
    }
    if b.is_empty() {
        return (0, a.len() as i64);
    }
    if a.len() > MAX_DIFF_LINES
        || b.len() > MAX_DIFF_LINES
        || (a.len() as u64) * (b.len() as u64) > MAX_DIFF_CELLS
    {
        return multiset_delta(a, b);
    }
    // Row-wise LCS, O(min) memory.
    let mut prev = vec![0i32; b.len() + 1];
    let mut cur = vec![0i32; b.len() + 1];
    for i in 1..=a.len() {
        let ai = a[i - 1];
        for j in 1..=b.len() {
            cur[j] = if ai == b[j - 1] {
                prev[j - 1] + 1
            } else {
                prev[j].max(cur[j - 1])
            };
        }
        std::mem::swap(&mut prev, &mut cur);
        // Only slot 0 needs resetting; every other `cur[j]` is recomputed from
        // scratch at the top of the next iteration (same as the Java kernel).
        cur[0] = 0;
    }
    let common = prev[b.len()];
    (
        (b.len() as i64) - (common as i64),
        (a.len() as i64) - (common as i64),
    )
}

/// O(n) fallback when the LCS table would be too large: additions = lines in
/// `after` with no unmatched copy in `before`; deletions = the leftover
/// `before` counts. Mirrors the Java kernel's `multisetDelta`.
fn multiset_delta(a: &[&str], b: &[&str]) -> (i64, i64) {
    let mut counts: HashMap<&str, i64> = HashMap::new();
    for line in a {
        *counts.entry(line).or_insert(0) += 1;
    }
    let mut additions = 0i64;
    for line in b {
        match counts.get_mut(line) {
            Some(left) if *left > 0 => *left -= 1,
            _ => additions += 1,
        }
    }
    let deletions: i64 = counts.values().sum();
    (additions, deletions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_looks_binary() {
        assert!(!looks_binary(b"hello world"));
        assert!(looks_binary(b"\x00\x01\x02"));
    }

    #[test]
    fn test_safe_segment() {
        assert_eq!(safe_segment("run-abc/123"), "run-abc_123");
    }

    // ── line stats (ported from Java FileChangeService) ─────────────────────

    #[test]
    fn split_lines_strips_cr_and_handles_missing_final_newline() {
        // Java splitLines: CRLF loses only the \r; a final segment without \n
        // still counts as a line; trailing \n does NOT produce an empty line.
        assert_eq!(split_lines("a\r\nb\r\n"), vec!["a", "b"]);
        assert_eq!(split_lines("a\nb"), vec!["a", "b"]);
        assert_eq!(split_lines(""), Vec::<&str>::new());
        assert_eq!(split_lines("\n"), vec![""]);
    }

    #[test]
    fn line_delta_added_and_deleted_files() {
        // ADDED: everything in `after` is an addition.
        assert_eq!(line_delta(&[], &["a", "b", "c"]), (3, 0));
        // DELETED: everything in `before` is a deletion.
        assert_eq!(line_delta(&["a", "b"], &[]), (0, 2));
        // Identical content: prefix/suffix trimming leaves nothing.
        assert_eq!(line_delta(&["a", "b"], &["a", "b"]), (0, 0));
    }

    #[test]
    fn line_delta_modified_uses_lcs_after_trimming() {
        // Common head/tail are trimmed, then LCS over the middle:
        //   before = a, OLD, b, c, TAIL   after = a, NEW1, NEW2, b, c, TAIL
        // trimmed middles: [OLD] vs [NEW1, NEW2] → +2 / -1
        let before = ["a", "OLD", "b", "c", "TAIL"];
        let after = ["a", "NEW1", "NEW2", "b", "c", "TAIL"];
        assert_eq!(line_delta(&before, &after), (2, 1));
    }

    #[test]
    fn line_delta_reorder_counts_moves_as_add_plus_delete() {
        // LCS([a,b],[b,a]) = 1 → +1/-1 (a moved down = one add and one delete).
        assert_eq!(line_delta(&["a", "b"], &["b", "a"]), (1, 1));
    }

    #[test]
    fn multiset_delta_counts_duplicates() {
        // before has two "x"; after has three "x" and one "y".
        let a = ["x", "x"];
        let b = ["x", "x", "x", "y"];
        assert_eq!(multiset_delta(&a, &b), (2, 0));
        assert_eq!(multiset_delta(&b, &a), (0, 2));
    }

    fn temp_workspace(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gwork-changes-{}-{}", tag, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // ── regressions from the self-review of the file-changes fix ──────────────

    #[test]
    fn parallel_aliased_writers_keep_every_entry() {
        // multitask/background sub-agents alias to the SAME parent manifest.
        // Without the per-manifest lock + unique temp name, two concurrent
        // `record` calls each load revision R and the last save drops the
        // other's entry — the original "changed files never show" symptom.
        let ws = temp_workspace("parallel");
        let ledger = Arc::new(ChangeLedger::new(ws.clone()));
        let sid = "sess-par";
        let rid = "run-par";
        ledger.register_run_root(sid, &ws);
        for i in 0..8 {
            ledger.alias_run(&format!("sub-{i}"), &format!("sub-{i}"), sid, rid);
        }
        let mut handles = Vec::new();
        for i in 0..8u32 {
            let l = ledger.clone();
            let w = ws.clone();
            handles.push(std::thread::spawn(move || {
                let name = format!("f{i}.txt");
                let before = l.before(&format!("sub-{i}"), &format!("sub-{i}"), &name).unwrap();
                std::fs::write(w.join(&name), format!("content {i}\n")).unwrap();
                l.record(&format!("sub-{i}"), &format!("sub-{i}"), &name, before).unwrap();
            }));
        }
        for h in handles { h.join().unwrap(); }
        let summary = ledger.finish(sid, rid, true).expect("parent finish must publish");
        assert_eq!(summary["fileCount"].as_u64(), Some(8), "no entry may be lost: {summary:?}");
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn before_and_record_use_the_persisted_workspace_root_after_restart() {
        // before() used live_root(original_session), record() used
        // tree_root(aliased sid + workspaceRoot). After a restart the live
        // registration is gone; both must still resolve the persisted root.
        let kernel = temp_workspace("restart-kernel");
        let project = temp_workspace("restart-project");
        {
            let ledger = ChangeLedger::new(kernel.clone());
            ledger.register_run_root("s", &project);
            std::fs::write(project.join("a.txt"), "old\n").unwrap();
            let before = ledger.before("s", "r", "a.txt").unwrap();
            std::fs::write(project.join("a.txt"), "new\n").unwrap();
            ledger.record("s", "r", "a.txt", before).unwrap();
        }
        let ledger = ChangeLedger::new(kernel.clone()); // no register_run_root
        let m = ledger.load_manifest("s", "r").unwrap();
        assert_eq!(m.workspace_root, project.to_string_lossy(), "root must be persisted");
        let run = ledger.get_run("s", "r");
        assert_eq!(run["fileCount"].as_u64(), Some(1));
        assert_eq!(run["files"][0]["changeType"], "MODIFIED", "before/after must come from one tree");
        let undone = ledger.undo_file("s", "r", "a.txt");
        assert_eq!(undone["status"], "OK");
        assert_eq!(std::fs::read_to_string(project.join("a.txt")).unwrap(), "old\n");
        assert!(!kernel.join("a.txt").exists(), "undo must not write to the kernel tree");
        std::fs::remove_dir_all(&kernel).ok();
        std::fs::remove_dir_all(&project).ok();
    }

    #[test]
    fn finalize_orphans_never_closes_a_run_from_this_process() {
        let ws = temp_workspace("orphan");
        let ledger = ChangeLedger::new(ws.clone());
        let sid = "sess-orphan";
        // An active run in THIS process (ready=false, updatedAt >= start).
        ledger.note_bash(sid, "active");
        // A genuine orphan from a previous process: backdate updatedAt.
        ledger.note_bash(sid, "old");
        let path = ledger.manifest_path(sid, "old");
        let mut m: Manifest = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        m.updated_at = ledger.process_started_ms - 60_000;
        ledger.save_manifest(sid, &m).unwrap();
        let recovered = ledger.finalize_orphans(sid);
        assert_eq!(recovered.len(), 1, "only the pre-process orphan is recovered: {recovered:?}");
        assert_eq!(recovered[0]["runId"], "old");
        // The active run must still be finishable (sweeping it would have
        // flipped ready and made finish() return None).
        assert!(ledger.finish(sid, "active", true).is_some(),
            "an active run must NOT be swept by finalize_orphans");
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn nested_alias_chain_resolves_to_the_real_run() {
        // A depth-2 sub-agent inherited a `sub-*` runId as its parent; a
        // single-hop target() left its writes in an orphan manifest.
        let ws = temp_workspace("nested");
        let ledger = ChangeLedger::new(ws.clone());
        ledger.register_run_root("s", &ws);
        ledger.alias_run("sub-a", "sub-a", "s", "real-run");
        ledger.alias_run("sub-b", "sub-b", "sub-a", "sub-a");
        let before = ledger.before("sub-b", "sub-b", "delegated.txt").unwrap();
        std::fs::write(ws.join("delegated.txt"), "nested\n").unwrap();
        ledger.record("sub-b", "sub-b", "delegated.txt", before).unwrap();
        let summary = ledger.finish("s", "real-run", true).expect("root finish publishes nested write");
        assert_eq!(summary["fileCount"].as_u64(), Some(1), "{summary:?}");
        assert!(!ledger.manifest_path("s", "sub-a").exists(), "no orphan manifest");
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn normalize_rel_rejects_paths_outside_the_tree() {
        let root = Path::new("C:/Work/Proj");
        assert_eq!(ChangeLedger::normalize_rel(root, "src/a.rs"), "src/a.rs");
        // Case / slash differences must still resolve inside the tree.
        assert_eq!(ChangeLedger::normalize_rel(root, "c:/work/proj/src/a.rs"), "src/a.rs");
        assert_eq!(ChangeLedger::normalize_rel(root, "C:\\Work\\Proj\\src\\a.rs"), "src/a.rs");
        // Outside-tree absolute paths and traversal are refused (empty), so
        // undo/reapply can never write into another tree.
        assert_eq!(ChangeLedger::normalize_rel(root, "D:/other/x.rs"), "");
        assert_eq!(ChangeLedger::normalize_rel(root, "../escape/x.rs"), "");
        assert_eq!(ChangeLedger::normalize_rel(root, "C:/Other/x.rs"), "");
    }

    #[test]
    fn abnormal_finish_bumps_revision_when_it_adds_a_reason() {
        // finish(false) appends an incomplete reason; without a revision bump
        // the frontend's monotonic upsert gate would discard the warning.
        let ws = temp_workspace("revision");
        let ledger = ChangeLedger::new(ws.clone());
        ledger.note_bash("s", "r");
        let rev = ledger.load_manifest("s", "r").unwrap().revision;
        let summary = ledger.finish("s", "r", false).unwrap();
        assert!(summary["revision"].as_u64().unwrap() > rev);
        assert_eq!(summary["possiblyIncomplete"], true);
        std::fs::remove_dir_all(&ws).ok();
    }

    // ── regressions: bound workspace / bash / sub-agents / orphan manifests ────
    //
    // These reproduce the exact four failure shapes behind "this turn clearly
    // changed files, but the outputs panel and the 已修改 card stay empty".

    #[test]
    fn a_bound_workspace_records_real_changes_under_its_own_root() {
        // The ledger's DATA lives under the kernel install dir, but the run's
        // TOOLS write into a bound project. `register_run_root` + persisted
        // `workspaceRoot` must make before/record/read-side agree on that tree.
        let kernel = temp_workspace("bound-kernel");
        let project = temp_workspace("bound-project");
        let ledger = ChangeLedger::new(kernel.clone());
        let sid = "sess-bound";
        let rid = "run-bound";
        ledger.register_run_root(sid, &project);

        let rel = "src/app.rs";
        let before = ledger.before(sid, rid, rel).unwrap();
        std::fs::create_dir_all(project.join("src")).unwrap();
        std::fs::write(project.join(rel), "fn main() {}\n").unwrap();
        ledger.record(sid, rid, rel, before).unwrap();

        // The kernel tree must NOT have the file — that was the old root bug.
        assert!(!kernel.join(rel).exists(), "tools wrote into the bound project, not the kernel dir");
        let run = ledger.get_run(sid, rid);
        assert_eq!(run["fileCount"].as_u64(), Some(1), "ADDED file must be visible: {run:?}");
        assert_eq!(run["files"][0]["path"], rel);
        assert_eq!(run["files"][0]["changeType"], "ADDED");
        assert_eq!(run["files"][0]["additions"], 1);
        let session = ledger.list_session(sid);
        assert_eq!(session["fileCount"].as_u64(), Some(1), "left outputs panel reads the same manifest");
        // Undo must restore against the bound root too.
        let undone = ledger.undo_file(sid, rid, rel);
        assert_eq!(undone["status"], "OK");
        assert!(!project.join(rel).exists(), "undo must delete from the bound project");
        std::fs::remove_dir_all(&kernel).ok();
        std::fs::remove_dir_all(&project).ok();
    }

    #[test]
    fn an_absolute_path_is_normalized_relative_to_the_run_root() {
        // Diagnosed from real manifests: the same session had one run recorded
        // with absolute paths and another with relative ones. Both must land on
        // one stable relative path so the outputs panel can merge them.
        let ws = temp_workspace("abs-path");
        let ledger = ChangeLedger::new(ws.clone());
        let sid = "sess-abs";
        let rid = "run-abs";
        ledger.register_run_root(sid, &ws);
        let abs = ws.join("note.txt").to_string_lossy().to_string();
        let before = ledger.before(sid, rid, &abs).unwrap();
        std::fs::write(ws.join("note.txt"), "hello\n").unwrap();
        ledger.record(sid, rid, &abs, before).unwrap();
        let run = ledger.get_run(sid, rid);
        assert_eq!(run["files"][0]["path"], "note.txt", "absolute path must be normalised: {run:?}");
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn bash_only_run_still_publishes_a_warning_manifest() {
        // A run that only used bash has no write/edit entries. Without
        // `note_bash` there is no manifest at all, so `finish` returns None and
        // NO frame is emitted — the silent card the user reported.
        let ws = temp_workspace("bash-only");
        let ledger = ChangeLedger::new(ws.clone());
        let sid = "sess-bash";
        let rid = "run-bash";
        ledger.note_bash(sid, rid);
        // Idempotent within a run: repeated bash calls must not duplicate the reason.
        ledger.note_bash(sid, rid);
        let summary = ledger.finish(sid, rid, true).expect("bash-only run must publish a warning frame");
        assert_eq!(summary["fileCount"].as_u64(), Some(0));
        assert_eq!(summary["possiblyIncomplete"], true);
        let reasons = summary["incompleteReasons"].as_array().unwrap();
        assert_eq!(reasons.len(), 1, "reason must be deduplicated: {reasons:?}");
        assert_eq!(reasons[0], BASH_INCOMPLETE_REASON);
        // The left panel must also see the warning (session-level merge).
        let session = ledger.list_session(sid);
        assert_eq!(session["possiblyIncomplete"], true);
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn a_sub_agent_write_lands_in_the_parent_run_manifest() {
        // `team/mod.rs` gives sub-agents synthetic `sub-*` ids. Without the
        // alias their writes land in an orphan manifest that finish(parent) never
        // publishes — the second silent-card root cause.
        let ws = temp_workspace("alias");
        let ledger = ChangeLedger::new(ws.clone());
        let sid = "sess-parent";
        let rid = "run-parent";
        ledger.register_run_root(sid, &ws);
        ledger.alias_run("sub-task1", "sub-task1", sid, rid);

        let before = ledger.before("sub-task1", "sub-task1", "delegated.txt").unwrap();
        std::fs::write(ws.join("delegated.txt"), "from sub-agent\n").unwrap();
        ledger.record("sub-task1", "sub-task1", "delegated.txt", before).unwrap();

        let summary = ledger.finish(sid, rid, true).expect("parent finish must publish sub-agent writes");
        assert_eq!(summary["runId"], rid);
        assert_eq!(summary["fileCount"].as_u64(), Some(1));
        assert_eq!(summary["files"][0]["path"], "delegated.txt");
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn record_persists_line_stats_for_new_modified_and_deleted() {
        let ws = temp_workspace("record");
        let ledger = ChangeLedger::new(ws.clone());
        let sid = "sess-line-stats";
        let rid = "run-1";

        // New file: 3 lines added. `before()` snapshots the live disk, so to
        // capture a true ADDED the file must not exist at snapshot time.
        let before_new = ledger.before(sid, rid, "new.txt").unwrap_or_default();
        std::fs::write(ws.join("new.txt"), "l1\nl2\nl3\n").unwrap();
        ledger.record(sid, rid, "new.txt", before_new).unwrap();

        // Modified file: 4 lines, middle two swapped. Prefix/suffix trimming
        // leaves [a,b] vs [b,a], whose LCS is 1 → +1/-1 (a reorder is one add
        // and one delete, not a rewrite of both lines).
        std::fs::write(ws.join("mod.txt"), "h\na\nb\nt\n").unwrap();
        let before_mod = ledger.before(sid, rid, "mod.txt").unwrap();
        std::fs::write(ws.join("mod.txt"), "h\nb\na\nt\n").unwrap();
        ledger.record(sid, rid, "mod.txt", before_mod).unwrap();

        // Deleted file: 2 lines removed.
        std::fs::write(ws.join("gone.txt"), "x\ny\n").unwrap();
        let before_gone = ledger.before(sid, rid, "gone.txt").unwrap();
        std::fs::remove_file(ws.join("gone.txt")).unwrap();
        ledger.record(sid, rid, "gone.txt", before_gone).unwrap();

        let summary = ledger.get_run(sid, rid);
        assert_eq!(summary["status"], "OK");
        // new: +3/-0, mod: +1/-1 (reorder), gone: +0/-2 → totals +4/-3
        assert_eq!(summary["additions"].as_i64(), Some(4));
        assert_eq!(summary["deletions"].as_i64(), Some(3));
        let files = summary["files"].as_array().unwrap();
        let row = |p: &str| files.iter().find(|f| f["path"] == p).unwrap().clone();
        assert_eq!(row("new.txt")["changeType"], "ADDED");
        assert_eq!(row("new.txt")["additions"].as_i64(), Some(3));
        assert_eq!(row("mod.txt")["changeType"], "MODIFIED");
        assert_eq!(row("mod.txt")["additions"].as_i64(), Some(1));
        assert_eq!(row("mod.txt")["deletions"].as_i64(), Some(1));
        assert_eq!(row("gone.txt")["changeType"], "DELETED");
        assert_eq!(row("gone.txt")["deletions"].as_i64(), Some(2));

        // Stats are persisted in the manifest (eager at record time).
        let manifest: Manifest = serde_json::from_str(
            &std::fs::read_to_string(
                ws.join(".gwork/sessions")
                    .join(sid)
                    .join("file-changes/manifests")
                    .join(format!("{}.json", rid)),
            )
            .unwrap(),
        )
        .unwrap();
        assert!(manifest.entries.iter().all(|e| e.additions.is_some() && e.deletions.is_some()));

        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn repeated_record_of_same_path_keeps_first_before_last_after_stats() {
        let ws = temp_workspace("repeated");
        let ledger = ChangeLedger::new(ws.clone());
        let sid = "sess-repeat";
        let rid = "run-1";
        std::fs::write(ws.join("f.txt"), "a\n").unwrap();
        let before = ledger.before(sid, rid, "f.txt").unwrap();
        std::fs::write(ws.join("f.txt"), "a\nb\n").unwrap();
        ledger.record(sid, rid, "f.txt", before.clone()).unwrap();
        std::fs::write(ws.join("f.txt"), "a\nb\nc\n").unwrap();
        ledger.record(sid, rid, "f.txt", before).unwrap();

        let summary = ledger.get_run(sid, rid);
        assert_eq!(summary["fileCount"].as_u64(), Some(1), "path must not duplicate");
        // first-before (1 line) → last-after (3 lines): +2/-0, NOT the sum of
        // both hops (+1 then +1).
        assert_eq!(summary["additions"].as_i64(), Some(2));
        assert_eq!(summary["deletions"].as_i64(), Some(0));
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn legacy_manifest_without_stats_is_backfilled_and_persisted() {
        let ws = temp_workspace("legacy");
        let ledger = ChangeLedger::new(ws.clone());
        let sid = "sess-legacy";
        let rid = "run-legacy";

        // Write file content, capture real blobs via before/record, then scrub
        // the persisted stats back to None to simulate a pre-fix manifest.
        std::fs::write(ws.join("old.txt"), "1\n2\n").unwrap();
        let before = ledger.before(sid, rid, "old.txt").unwrap();
        std::fs::write(ws.join("old.txt"), "1\n2\n3\n").unwrap();
        ledger.record(sid, rid, "old.txt", before).unwrap();
        let mpath = ws
            .join(".gwork/sessions")
            .join(sid)
            .join("file-changes/manifests")
            .join(format!("{}.json", rid));
        let mut m: Manifest = serde_json::from_str(&std::fs::read_to_string(&mpath).unwrap()).unwrap();
        for e in m.entries.iter_mut() {
            e.additions = None;
            e.deletions = None;
        }
        std::fs::write(&mpath, serde_json::to_string_pretty(&m).unwrap()).unwrap();

        // First read backfills: +1 line appended.
        let summary = ledger.get_run(sid, rid);
        assert_eq!(summary["additions"].as_i64(), Some(1));
        assert_eq!(summary["deletions"].as_i64(), Some(0));
        // …and persists, so the blob read happens once (Java ensureLineStats
        // caching semantics).
        let m2: Manifest = serde_json::from_str(&std::fs::read_to_string(&mpath).unwrap()).unwrap();
        assert_eq!(m2.entries[0].additions, Some(1));
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn session_merge_takes_newest_run_stats_and_sums_once_per_path() {
        let ws = temp_workspace("merge");
        let ledger = ChangeLedger::new(ws.clone());
        let sid = "sess-merge";

        // Run 1 (older): f.txt gains 2 lines.
        std::fs::write(ws.join("f.txt"), "a\n").unwrap();
        let b1 = ledger.before(sid, "run-1", "f.txt").unwrap();
        std::fs::write(ws.join("f.txt"), "a\nx\ny\n").unwrap();
        ledger.record(sid, "run-1", "f.txt", b1).unwrap();

        // Run 2 (newer): f.txt loses 1 line. Manifest updatedAt is wall-clock,
        // so force a strictly newer timestamp to make the merge order explicit.
        let b2 = ledger.before(sid, "run-2", "f.txt").unwrap();
        std::fs::write(ws.join("f.txt"), "a\nx\n").unwrap();
        ledger.record(sid, "run-2", "f.txt", b2).unwrap();
        for rid in ["run-1", "run-2"] {
            let mpath = ws
                .join(".gwork/sessions")
                .join(sid)
                .join("file-changes/manifests")
                .join(format!("{}.json", rid));
            let mut m: Manifest =
                serde_json::from_str(&std::fs::read_to_string(&mpath).unwrap()).unwrap();
            m.updated_at = if rid == "run-1" { 1_000 } else { 2_000 };
            std::fs::write(&mpath, serde_json::to_string_pretty(&m).unwrap()).unwrap();
        }

        let session = ledger.list_session(sid);
        assert_eq!(session["status"], "OK");
        let files = session["files"].as_array().unwrap();
        assert_eq!(files.len(), 1, "one path across two runs merges into one row");
        // Java semantics: state fields come from the NEWEST run (+0/-1), NOT the
        // sum of both runs' edits (+2 and -1 would double-count).
        assert_eq!(files[0]["additions"].as_i64(), Some(0));
        assert_eq!(files[0]["deletions"].as_i64(), Some(1));
        assert_eq!(files[0]["runIds"].as_array().unwrap().len(), 2);
        assert_eq!(session["additions"].as_i64(), Some(0));
        assert_eq!(session["deletions"].as_i64(), Some(1));
        assert_eq!(session["updatedAt"].as_i64(), Some(2_000));
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn binary_files_report_zero_line_stats() {
        let ws = temp_workspace("binary");
        let ledger = ChangeLedger::new(ws.clone());
        let sid = "sess-bin";
        std::fs::write(ws.join("b.bin"), [0u8, 1, 2, 3]).unwrap();
        let before = ledger.before(sid, "run-1", "b.bin").unwrap();
        std::fs::write(ws.join("b.bin"), [0u8, 9, 9]).unwrap();
        ledger.record(sid, "run-1", "b.bin", before).unwrap();
        let summary = ledger.get_run(sid, "run-1");
        assert_eq!(summary["additions"].as_i64(), Some(0));
        assert_eq!(summary["deletions"].as_i64(), Some(0));
        std::fs::remove_dir_all(&ws).ok();
    }

    // ── read-side visibility (ephemeral + net-zero scratch) ─────────────────
    //
    // Measured defect: the outputs panel listed `.tmp_add_nav_i18n.js` /
    // `_mut_mcp.cjs` as ADDED long after the files were deleted. Two gaps:
    // ledgers written before the write-side guard existed are never re-filtered
    // (Java filters at read time; Rust did not), and `changeType` comes from the
    // write-time snapshot so a created-then-deleted scratch file renders ADDED
    // forever. Codex's `/diff` cannot show this artifact at all because it reads
    // git's live view.

    #[test]
    fn read_side_hides_scratch_rows_and_keeps_real_changes() {
        let ws = temp_workspace("readside");
        let ledger = ChangeLedger::new(ws.clone());
        let sid = "sess-readside";
        let rid = "run-1";

        // (1) dotted-underscore scratch: hidden by the naming rule alone.
        let b1 = ledger.before(sid, rid, ".tmp_probe_x.js").unwrap_or_default();
        std::fs::write(ws.join(".tmp_probe_x.js"), "x\n").unwrap();
        ledger.record(sid, rid, ".tmp_probe_x.js", b1).unwrap();

        // (2) arbitrarily-named scratch created then deleted: the naming rule
        //     does NOT cover `_mut_*`; only the net-zero rule can hide it.
        let b2 = ledger.before(sid, rid, "_mut_probe.cjs").unwrap_or_default();
        std::fs::write(ws.join("_mut_probe.cjs"), "y\n").unwrap();
        ledger.record(sid, rid, "_mut_probe.cjs", b2).unwrap();

        // (3) real ADDED file that still exists: must stay visible.
        let b3 = ledger.before(sid, rid, "keep.rs").unwrap_or_default();
        std::fs::write(ws.join("keep.rs"), "z\n").unwrap();
        ledger.record(sid, rid, "keep.rs", b3).unwrap();

        // (4) real tracked file the user deleted afterwards: before.exists=true,
        //     so it must surface as DELETED (the net-zero rule must not eat it).
        std::fs::write(ws.join("gone.txt"), "w\n").unwrap();
        let b4 = ledger.before(sid, rid, "gone.txt").unwrap();
        std::fs::remove_file(ws.join("gone.txt")).unwrap();
        ledger.record(sid, rid, "gone.txt", b4).unwrap();

        // Simulate post-run cleanup of the scratch files.
        std::fs::remove_file(ws.join(".tmp_probe_x.js")).ok();
        std::fs::remove_file(ws.join("_mut_probe.cjs")).ok();

        let run = ledger.get_run(sid, rid);
        let paths: Vec<String> = run["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["path"].as_str().unwrap().to_string())
            .collect();
        assert!(
            !paths.iter().any(|p| p == ".tmp_probe_x.js"),
            "ephemeral naming must be filtered at read time: {:?}",
            paths
        );
        assert!(
            !paths.iter().any(|p| p == "_mut_probe.cjs"),
            "deleted net-zero scratch must not render as ADDED: {:?}",
            paths
        );
        assert!(paths.iter().any(|p| p == "keep.rs"), "real ADDED on disk must show: {:?}", paths);
        assert!(paths.iter().any(|p| p == "gone.txt"), "real deletion must show: {:?}", paths);
        let row = |p: &str| {
            run["files"]
                .as_array()
                .unwrap()
                .iter()
                .find(|f| f["path"] == p)
                .unwrap()
                .clone()
        };
        assert_eq!(row("gone.txt")["changeType"], "DELETED");
        assert_eq!(row("keep.rs")["changeType"], "ADDED");
        // Header count must agree with the row list (no jump between frames).
        assert_eq!(run["fileCount"].as_u64(), Some(2));

        // The session-level merge applies the same gate and the same counts.
        let session = ledger.list_session(sid);
        assert_eq!(session["fileCount"].as_u64(), Some(2));
        let spaths: Vec<String> = session["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["path"].as_str().unwrap().to_string())
            .collect();
        assert!(!spaths.iter().any(|p| p == ".tmp_probe_x.js" || p == "_mut_probe.cjs"));
        let runs = session["runs"].as_array().unwrap();
        assert_eq!(runs[0]["fileCount"].as_u64(), Some(2), "per-run count must match visible rows");
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn undone_entries_stay_visible_even_when_net_zero() {
        // Undo is user-visible state: hiding an undone net-zero row would strand
        // its reapply button. The gate must exempt `undone` explicitly.
        let ws = temp_workspace("undone-vis");
        let ledger = ChangeLedger::new(ws.clone());
        let sid = "s";
        let rid = "r";
        let b = ledger.before(sid, rid, "scratch_undo.txt").unwrap_or_default();
        std::fs::write(ws.join("scratch_undo.txt"), "a\n").unwrap();
        ledger.record(sid, rid, "scratch_undo.txt", b).unwrap();
        std::fs::remove_file(ws.join("scratch_undo.txt")).ok();

        let mpath = ws
            .join(".gwork/sessions")
            .join(sid)
            .join("file-changes/manifests")
            .join(format!("{}.json", rid));
        let mut m: Manifest =
            serde_json::from_str(&std::fs::read_to_string(&mpath).unwrap()).unwrap();
        m.entries[0].undone = true;
        std::fs::write(&mpath, serde_json::to_string_pretty(&m).unwrap()).unwrap();

        let run = ledger.get_run(sid, rid);
        assert_eq!(
            run["fileCount"].as_u64(),
            Some(1),
            "undone rows must remain reachable for reapply"
        );
        std::fs::remove_dir_all(&ws).ok();
    }

    // ── finish(): clean flag, idempotence, publish contract ─────────────────
    //
    // `finish` used to take no `clean` flag and return nothing. Two consequences:
    // an abnormal stop was recorded as a clean READY (so the UI could not warn
    // that the last writes may be untracked), and the caller could not tell
    // "published a snapshot" from "nothing to do" — which is what decides whether
    // a `file_changes` frame is emitted at all.

    /// Record one real change so a manifest exists to finish.
    fn ledger_with_one_change(tag: &str, sid: &str, rid: &str) -> (PathBuf, ChangeLedger) {
        let ws = temp_workspace(tag);
        let ledger = ChangeLedger::new(ws.clone());
        std::fs::write(ws.join("f.txt"), "a\n").unwrap();
        let before = ledger.before(sid, rid, "f.txt").unwrap();
        std::fs::write(ws.join("f.txt"), "a\nb\n").unwrap();
        ledger.record(sid, rid, "f.txt", before).unwrap();
        (ws, ledger)
    }

    fn manifest_of(ws: &Path, sid: &str, rid: &str) -> Manifest {
        serde_json::from_str(
            &std::fs::read_to_string(
                ws.join(".gwork/sessions")
                    .join(sid)
                    .join("file-changes/manifests")
                    .join(format!("{}.json", rid)),
            )
            .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn clean_finish_marks_ready_without_the_incomplete_flag() {
        let (ws, ledger) = ledger_with_one_change("fin-clean", "s", "r");
        let summary = ledger.finish("s", "r", true).expect("first finish must publish");

        let m = manifest_of(&ws, "s", "r");
        assert!(m.ready, "finish must set ready (it gates undo in Java)");
        assert_eq!(m.last_status, "READY");
        assert!(!m.possibly_incomplete, "a clean finish must not warn");

        // The published snapshot is the same shape the frontend consumes:
        // `onFileChangesChunk` bails unless `args.files` is an array.
        assert!(summary["files"].is_array(), "summary.files must be an array");
        assert_eq!(summary["fileCount"].as_u64(), Some(1));
        assert_eq!(summary["additions"].as_i64(), Some(1));
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn abnormal_finish_marks_possibly_incomplete_but_still_ready() {
        // The whole point of the `clean` flag: a cancelled or errored run may have
        // left the last writes unrecorded, so the UI must be able to say so —
        // while undo stays available (ready=true).
        let (ws, ledger) = ledger_with_one_change("fin-dirty", "s", "r");
        let summary = ledger.finish("s", "r", false).expect("first finish must publish");

        let m = manifest_of(&ws, "s", "r");
        assert!(m.ready, "abnormal finish must still unlock undo");
        assert_eq!(m.last_status, "INCOMPLETE");
        assert!(m.possibly_incomplete, "abnormal finish must set the warning flag");
        assert_eq!(summary["possiblyIncomplete"], serde_json::json!(true));
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn abnormal_finish_explains_itself_in_incomplete_reasons() {
        // `possiblyIncomplete` alone tells the UI *that* the list may be short;
        // `incompleteReasons` is what `app-file-changes.js:incompleteText()`
        // renders to tell the user *why*. Without it the card shows a bare
        // warning. The text matches Java's so both kernels read the same.
        let (ws, ledger) = ledger_with_one_change("fin-reason", "s", "r");
        let summary = ledger.finish("s", "r", false).expect("publish");

        let reasons = summary["incompleteReasons"].as_array().expect("must be an array");
        assert_eq!(reasons.len(), 1, "exactly one reason: {:?}", reasons);
        assert_eq!(
            reasons[0],
            serde_json::json!("run terminated abnormally or was stopped; the last writes may not be tracked")
        );
        // It must be persisted, not just present in the published snapshot — a
        // later page load reads the manifest, not the frame.
        assert_eq!(manifest_of(&ws, "s", "r").incomplete_reasons.len(), 1);
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn a_clean_finish_reports_no_reasons() {
        // The reasons list must be an empty ARRAY, never null or absent:
        // `incompleteText` does `Array.isArray(reasons) ? reasons : (reasons ? [reasons] : [])`,
        // so a null would degrade gracefully but an omission in the JSON would
        // leave `summary.incompleteReasons` undefined on every normal run.
        let (_ws, ledger) = ledger_with_one_change("fin-noreason", "s", "r");
        let summary = ledger.finish("s", "r", true).expect("publish");
        let reasons = summary["incompleteReasons"].as_array().expect("must be an array");
        assert!(reasons.is_empty(), "a clean finish must not warn: {:?}", reasons);
        std::fs::remove_dir_all(&_ws).ok();
    }

    // ── reopen(): suspend → resume keeps one runId, one manifest, one card ───
    //
    // Reproduce the exact lifecycle from `spawn_resume`: the suspended segment
    // publishes a `file_changes` frame and marks the manifest `ready`; the answer
    // arrives and the resumed segment writes more files under the SAME runId;
    // the final `finish()` must publish a snapshot containing BOTH halves.
    #[test]
    fn reopen_lets_a_resumed_run_publish_a_cumulative_snapshot() {
        let (ws, ledger) = ledger_with_one_change("reopen-cumulative", "s", "r");
        let first = ledger.finish("s", "r", true).expect("suspend must publish");
        assert_eq!(first["fileCount"].as_u64(), Some(1));
        assert!(manifest_of(&ws, "s", "r").ready);
        let revision_before_reopen = manifest_of(&ws, "s", "r").revision;

        // Without reopen, finish() would hit its `ready` idempotence gate and the
        // resumed segment's file never reaches the card.
        ledger.reopen("s", "r");
        let after = manifest_of(&ws, "s", "r");
        assert!(!after.ready, "reopen must un-finish the manifest");
        assert_eq!(
            after.revision,
            revision_before_reopen + 1,
            "revision must advance for the frontend upsert gate"
        );

        std::fs::write(ws.join("g.txt"), "x\n").unwrap();
        let before = ledger.before("s", "r", "g.txt").unwrap();
        std::fs::write(ws.join("g.txt"), "x\ny\n").unwrap();
        ledger.record("s", "r", "g.txt", before).unwrap();

        let second = ledger.finish("s", "r", true).expect("resume finish must publish");
        assert_eq!(second["fileCount"].as_u64(), Some(2), "both halves must be in one card");
        let paths: Vec<&str> = second["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["path"].as_str().unwrap())
            .collect();
        assert!(paths.contains(&"f.txt") && paths.contains(&"g.txt"), "got {paths:?}");
        assert!(
            second["revision"].as_u64().unwrap() > first["revision"].as_u64().unwrap(),
            "frontend upsert drops a snapshot whose revision did not advance"
        );
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn reopen_bumps_revision_even_without_new_writes() {
        // The answer may be rejected / the resumed segment may touch no file, yet
        // the final frame must still be accepted by the frontend's monotonic gate.
        let (ws, ledger) = ledger_with_one_change("reopen-no-write", "s", "r");
        let first = ledger.finish("s", "r", true).unwrap();
        ledger.reopen("s", "r");
        let second = ledger.finish("s", "r", true).expect("reopened finish must publish");
        assert!(second["revision"].as_u64().unwrap() > first["revision"].as_u64().unwrap());
        assert_eq!(second["fileCount"].as_u64(), Some(1));
        // A second resume of the same (now finished) manifest must still publish:
        // ask_user / HITL can suspend more than once within one task.
        ledger.reopen("s", "r");
        assert!(
            ledger.finish("s", "r", true).is_some(),
            "a second suspend→resume cycle must still publish a final snapshot"
        );
        // ...but a plain second finish() with no reopen stays idempotent.
        assert!(ledger.finish("s", "r", true).is_none(), "finish stays idempotent");
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn reopen_without_a_manifest_is_a_no_op() {
        let ws = temp_workspace("reopen-no-manifest");
        let ledger = ChangeLedger::new(ws.clone());
        ledger.reopen("s", "missing"); // must not panic or create an empty manifest
        assert!(ledger.finish("s", "missing", true).is_none());
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn add_reason_deduplicates() {
        // Several termination paths race; without dedup the same sentence would
        // appear repeatedly in the card. Java's addReason returns early on a match.
        let mut m = Manifest {
            version: "1".into(),
            session_id: "s".into(),
            run_id: "r".into(),
            revision: 0,
            ready: false,
            possibly_incomplete: false,
            incomplete_reasons: Vec::new(),
            last_status: "CAPTURED".into(),
            updated_at: 0,
            workspace_root: String::new(),
            entries: Vec::new(),
        };
        ChangeLedger::add_reason(&mut m, "reason A");
        ChangeLedger::add_reason(&mut m, "reason A");
        ChangeLedger::add_reason(&mut m, "reason A");
        assert_eq!(m.incomplete_reasons, vec!["reason A".to_string()]);
        ChangeLedger::add_reason(&mut m, "reason B");
        assert_eq!(m.incomplete_reasons, vec!["reason A".to_string(), "reason B".to_string()]);
    }

    #[test]
    fn add_reason_is_capped_and_reports_the_suppression() {
        // The list rides in every file_changes frame, so it must be bounded:
        // a long run with dozens of snapshot failures would otherwise grow every
        // frame and blow out the card.
        let mut m = Manifest {
            version: "1".into(),
            session_id: "s".into(),
            run_id: "r".into(),
            revision: 0,
            ready: false,
            possibly_incomplete: false,
            incomplete_reasons: Vec::new(),
            last_status: "CAPTURED".into(),
            updated_at: 0,
            workspace_root: String::new(),
            entries: Vec::new(),
        };
        for i in 0..(MAX_INCOMPLETE_REASONS + 25) {
            ChangeLedger::add_reason(&mut m, &format!("reason {}", i));
        }
        assert_eq!(
            m.incomplete_reasons.len(),
            MAX_INCOMPLETE_REASONS,
            "list must not exceed the cap"
        );
        // The last slot is replaced by a fixed marker, so the reader knows more
        // existed rather than silently seeing a truncated list.
        assert_eq!(
            m.incomplete_reasons[MAX_INCOMPLETE_REASONS - 1],
            "further reasons suppressed (see server log)"
        );
        // Adding again must not grow it further.
        ChangeLedger::add_reason(&mut m, "one more");
        assert_eq!(m.incomplete_reasons.len(), MAX_INCOMPLETE_REASONS);
    }

    #[test]
    fn the_cap_matches_the_java_constant() {
        // Pin the value: it is shared semantics with the Java kernel, and a drift
        // here would make the two kernels disagree about how much detail a card
        // shows for the same run.
        assert_eq!(MAX_INCOMPLETE_REASONS, 20);
    }

    #[test]
    fn a_legacy_manifest_without_the_field_still_loads() {
        // Manifests written before `incompleteReasons` existed must deserialize.
        // `#[serde(default)]` is what makes that work; without it, loading an old
        // manifest would fail and read back as "no changes recorded".
        let legacy = r#"{
            "version": "1",
            "sessionId": "s",
            "runId": "r",
            "revision": 1,
            "ready": true,
            "possiblyIncomplete": false,
            "lastStatus": "READY",
            "updatedAt": 1700000000000,
            "entries": []
        }"#;
        let m: Manifest = serde_json::from_str(legacy).expect("legacy manifest must parse");
        assert!(m.incomplete_reasons.is_empty(), "absent field must default to empty");
        assert_eq!(m.last_status, "READY");
    }

    #[test]
    fn finish_is_idempotent_and_publishes_only_once() {
        // Several termination paths can race (Java shares one AtomicBoolean across
        // done/error/finally). Without this guard a late abnormal callback would
        // overwrite a completed run's status and emit a duplicate frame.
        let (ws, ledger) = ledger_with_one_change("fin-idem", "s", "r");
        assert!(ledger.finish("s", "r", true).is_some(), "first finish publishes");
        assert!(ledger.finish("s", "r", false).is_none(), "second finish must not publish");
        assert!(ledger.finish("s", "r", true).is_none(), "third finish must not publish");

        // The first (clean) outcome must survive the later abnormal attempts.
        let m = manifest_of(&ws, "s", "r");
        assert_eq!(m.last_status, "READY", "a completed run must not be downgraded");
        assert!(!m.possibly_incomplete);
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn finish_on_an_unknown_run_publishes_nothing() {
        // A run that touched no tracked file has no manifest. Returning None (not
        // an empty summary) is what keeps the caller from emitting a frame with no
        // files in it.
        let ws = temp_workspace("fin-none");
        let ledger = ChangeLedger::new(ws.clone());
        assert!(ledger.finish("no-such-session", "no-such-run", true).is_none());
        assert!(ledger.finish("no-such-session", "no-such-run", false).is_none());
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn a_run_that_touched_nothing_has_no_manifest_to_finish() {
        // Distinct from the case above: the session exists (a change was recorded
        // under another run) but this run never wrote anything.
        let (ws, ledger) = ledger_with_one_change("fin-other", "s", "run-a");
        assert!(ledger.finish("s", "run-b", true).is_none(), "run-b never recorded a change");
        assert!(ledger.finish("s", "run-a", true).is_some(), "run-a did");
        std::fs::remove_dir_all(&ws).ok();
    }
}
