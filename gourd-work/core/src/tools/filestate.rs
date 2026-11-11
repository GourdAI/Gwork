//! filestate — per-session read/write state behind the read-before-edit guard.
//!
//! `edit` must not rewrite a file the model has never seen, nor one that
//! changed on disk since it was last read (external editor, git checkout,
//! another agent). State is a content hash per (root session, path), not
//! mtime: timestamp granularity differs across platforms and filesystems,
//! and a hash also catches same-second rewrites. Subagents share the root
//! session id, so a read in the parent legitimises an edit in the child.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use sha2::{Digest, Sha256};

/// Entries are two strings each; the cap only exists so a long-lived process
/// serving many sessions cannot grow the map without bound. On overflow we
/// keep the current session's entries and drop the rest — losing another
/// session's state merely forces one extra read there.
const MAX_ENTRIES: usize = 16_384;

static STATES: Lazy<Mutex<HashMap<String, String>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn key(session: &str, path: &Path) -> String {
    let canon = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    format!("{}\u{0}{}", session, canon.display())
}

fn hash(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

/// Record the exact bytes the model just saw (`read`) or just wrote
/// (`write`/`edit`), so a follow-up edit does not need a redundant read.
pub fn record(session: &str, path: &Path, bytes: &[u8]) {
    let k = key(session, path);
    let v = hash(bytes);
    let mut map = STATES.lock().unwrap();
    if map.len() >= MAX_ENTRIES {
        let prefix = format!("{}\u{0}", session);
        map.retain(|other, _| other.starts_with(&prefix));
    }
    map.insert(k, v);
}

/// Guard for `edit`: the file must have been read or written in this session,
/// and its on-disk content must still match what was recorded.
pub fn guard(session: &str, path: &Path) -> Result<(), String> {
    let k = key(session, path);
    let recorded = STATES.lock().unwrap().get(&k).cloned();
    let Some(recorded) = recorded else {
        return Err(format!(
            "File has not been read yet: {}. Read it first so the edit is based on current content.",
            path.display()
        ));
    };
    let current = match std::fs::read(path) {
        Ok(b) => hash(&b),
        Err(e) => return Err(format!("Read failed: {}", e)),
    };
    if current != recorded {
        return Err(format!(
            "File has been modified since last read: {}. Re-read it before editing.",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "gwork-filestate-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn unread_file_is_rejected() {
        let dir = scratch("unread");
        let f = dir.join("a.txt");
        std::fs::write(&f, "hello").unwrap();
        let err = guard("s-unread", &f).unwrap_err();
        assert!(err.contains("not been read"), "got: {}", err);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_then_guard_passes_and_stale_change_is_caught() {
        let dir = scratch("stale");
        let f = dir.join("a.txt");
        std::fs::write(&f, "v1").unwrap();
        record("s-stale", &f, b"v1");
        assert!(guard("s-stale", &f).is_ok());

        // External modification (same size, so mtime-only guards could miss it
        // on coarse-grained filesystems).
        std::fs::write(&f, "v2").unwrap();
        let err = guard("s-stale", &f).unwrap_err();
        assert!(err.contains("modified since last read"), "got: {}", err);

        // Re-reading refreshes the state.
        record("s-stale", &f, b"v2");
        assert!(guard("s-stale", &f).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sessions_are_isolated() {
        let dir = scratch("isolation");
        let f = dir.join("a.txt");
        std::fs::write(&f, "x").unwrap();
        record("s-a", &f, b"x");
        assert!(guard("s-a", &f).is_ok());
        assert!(guard("s-b", &f).is_err(), "another session must not inherit the read");
        let _ = std::fs::remove_dir_all(&dir);
    }
}