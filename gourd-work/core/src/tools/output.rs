//! output — lossless persistence of large tool outputs.
//!
//! Truncating an observation at the react hook is lossy: the discarded tail
//! is unreachable unless the tool runs again. Above the threshold we instead
//! write the full text to a session-owned file and hand the model a preview
//! plus the path, so any part stays reachable via `read`/`grep` without
//! re-executing the command (which for `bash` may be slow or non-idempotent).

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// Outputs above this many characters are persisted in full. Chosen well
/// above the tightest observation cap (8K) so persistence only kicks in for
/// outputs that would otherwise lose most of their content.
pub const PERSIST_THRESHOLD_CHARS: usize = 50_000;
/// How much of the head the model sees inline alongside the file pointer.
pub const PREVIEW_CHARS: usize = 2_000;

/// Directory holding persisted outputs. Session-owned storage when available
/// (added to the read-only extra roots so `read` can reach it); otherwise a
/// dot-dir inside the workspace, which is readable by construction.
pub fn store_dir(workspace: &Path, session_dir: Option<&Path>) -> PathBuf {
    match session_dir {
        Some(d) => d.join("tool-outputs"),
        None => workspace.join(".gwork").join("tool-outputs"),
    }
}

/// Persist `text` when it exceeds the threshold; returns the replacement
/// observation (preview + pointer), or `None` when nothing was persisted.
/// IO failure degrades to `None` — the caller then truncates as before, so a
/// full disk can never break tool execution.
pub fn persist_if_large(text: &str, dir: &Path, tool: &str, call_id: &str) -> Option<String> {
    let total = text.chars().count();
    if total <= PERSIST_THRESHOLD_CHARS {
        return None;
    }
    let path = dir.join(file_name(tool, call_id));
    std::fs::create_dir_all(dir).ok()?;
    std::fs::write(&path, text).ok()?;
    let preview: String = text.chars().take(PREVIEW_CHARS).collect();
    Some(format!(
        "{}\n\n[Large output: {} chars total. Full text saved to: {}\nInspect specific parts with read (offset/limit) or grep on that path instead of re-running the tool.]",
        preview,
        total,
        path.display()
    ))
}

/// Tool names and call ids arrive from the model and may contain path
/// separators; keep only filename-safe characters and add a content hash so
/// sanitisation collisions cannot overwrite another call's output.
fn file_name(tool: &str, call_id: &str) -> String {
    let clean: String = tool
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .take(32)
        .collect();
    let mut h = Sha256::new();
    h.update(call_id.as_bytes());
    let digest = hex::encode(h.finalize());
    format!("{}-{}.txt", clean, &digest[..12])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "gwork-output-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn small_output_is_untouched() {
        let dir = scratch("small");
        assert!(persist_if_large("short", &dir, "bash", "c1").is_none());
        assert!(!dir.exists(), "must not create the store for small outputs");
    }

    #[test]
    fn large_output_is_persisted_with_preview_and_pointer() {
        let dir = scratch("large");
        let text = "x".repeat(PERSIST_THRESHOLD_CHARS + 1);
        let out = persist_if_large(&text, &dir, "bash", "call-1").unwrap();
        assert!(out.contains(&format!("{} chars total", text.chars().count())));
        assert!(out.contains("tool-outputs") || out.contains(dir.to_str().unwrap()));
        assert!(out.starts_with(&"x".repeat(PREVIEW_CHARS)));
        assert!(out.len() < text.len(), "replacement must be smaller");

        let stored: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path()).collect();
        assert_eq!(stored.len(), 1);
        assert_eq!(std::fs::read_to_string(&stored[0]).unwrap(), text, "full text must survive");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn io_failure_degrades_to_none() {
        let dir = scratch("iofail");
        std::fs::create_dir_all(&dir).unwrap();
        // A file where the store dir should be → create_dir_all fails.
        let blocker = dir.join("blocker");
        std::fs::write(&blocker, "x").unwrap();
        let text = "x".repeat(PERSIST_THRESHOLD_CHARS + 1);
        assert!(persist_if_large(&text, &blocker, "bash", "c1").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hostile_call_id_cannot_escape_the_store() {
        let dir = scratch("escape");
        let text = "x".repeat(PERSIST_THRESHOLD_CHARS + 1);
        let out = persist_if_large(&text, &dir, "bash", "../../evil").unwrap();
        let entries: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path()).collect();
        assert_eq!(entries.len(), 1, "exactly one file, inside the store");
        assert!(entries[0].starts_with(&dir));
        assert!(!out.contains(".."), "pointer must be a clean path: {}", out);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn store_dir_prefers_session_storage() {
        let ws = Path::new("/ws");
        let sess = Path::new("/sess");
        assert_eq!(store_dir(ws, Some(sess)), sess.join("tool-outputs"));
        assert_eq!(store_dir(ws, None), ws.join(".gwork").join("tool-outputs"));
    }
}