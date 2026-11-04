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
    pub entries: Vec<ChangeEntry>,
}

/// The change ledger service.
pub struct ChangeLedger {
    workspace: PathBuf,
}

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
        Self { workspace }
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
        // Atomic write: temp file + rename
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    /// Capture the "before" state of a file and store its blob.
    /// Returns a token (path) used to finalize "after" via `after`.
    pub fn before(&self, session_id: &str, _run_id: &str, rel_path: &str) -> Option<FileState> {
        // Skip ephemeral paths entirely
        if ephemeral::is_ephemeral_relative(rel_path, false) {
            return None;
        }
        let abs = self.workspace.join(rel_path);
        let state = self.snapshot(session_id, &abs);
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
        let abs = self.workspace.join(rel_path);
        let after = self.snapshot(session_id, &abs);
        let (additions, deletions) = self.line_stats(session_id, &before, &after);

        let mut manifest = self
            .load_manifest(session_id, run_id)
            .unwrap_or_else(|| Manifest {
                version: "1".into(),
                session_id: session_id.to_string(),
                run_id: run_id.to_string(),
                revision: 0,
                ready: false,
                possibly_incomplete: false,
                incomplete_reasons: Vec::new(),
                last_status: "CAPTURED".into(),
                updated_at: now_ms(),
                entries: Vec::new(),
            });

        // Keep only first-before / last-after per path. Line stats are recomputed
        // against the *stored* first-before whenever a later record changes
        // `after`, so the entry always describes first-before → last-after.
        if let Some(existing) = manifest.entries.iter_mut().find(|e| e.path == rel_path) {
            existing.after = after;
            let (add, del) = self.line_stats(session_id, &existing.before, &existing.after);
            existing.additions = Some(add);
            existing.deletions = Some(del);
        } else {
            manifest.entries.push(ChangeEntry {
                path: rel_path.to_string(),
                before,
                after,
                undone: false,
                additions: Some(additions),
                deletions: Some(deletions),
            });
        }
        manifest.revision += 1;
        manifest.updated_at = now_ms();
        self.save_manifest(session_id, &manifest)
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
        let mut manifest = self.load_manifest(session_id, run_id)?;
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
            Self::add_reason(
                &mut manifest,
                "run terminated abnormally or was stopped; the last writes may not be tracked",
            );
        }
        manifest.updated_at = now_ms();
        if self.save_manifest(session_id, &manifest).is_err() {
            // Do not publish a snapshot we failed to persist: the UI would show a
            // revision that a later read cannot reproduce.
            return None;
        }
        Some(self.summarize(&manifest))
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

    fn summarize(&self, manifest: &Manifest) -> serde_json::Value {
        let mut additions = 0i64;
        let mut deletions = 0i64;
        let files: Vec<serde_json::Value> = manifest
            .entries
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
        for e in &manifest.entries {
            additions += e.additions.unwrap_or(0);
            deletions += e.deletions.unwrap_or(0);
        }
        let all_undone = !manifest.entries.is_empty() && manifest.entries.iter().all(|e| e.undone);
        let any_undone = manifest.entries.iter().any(|e| e.undone);
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
            "fileCount": manifest.entries.len(),
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
            run_summaries.push(serde_json::json!({
                "runId": m.run_id,
                "updatedAt": m.updated_at,
                "fileCount": m.entries.len(),
                "possiblyIncomplete": m.possibly_incomplete,
            }));
            for e in &m.entries {
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
        let Some(entry) = manifest.entries.iter_mut().find(|e| e.path == rel_path) else {
            return serde_json::json!({ "status": "NOT_FOUND" });
        };
        let abs = self.workspace.join(rel_path);
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
        for entry in manifest.entries.iter_mut() {
            if !entry.undone {
                continue;
            }
            let abs = self.workspace.join(&entry.path);
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
