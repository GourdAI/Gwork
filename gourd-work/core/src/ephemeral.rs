//! ephemeral — Ephemeral/temporary path filtering rules.
//!
//! Mirrors the Java kernel's EphemeralPaths: files/dirs that should not appear
//! in the file-change ledger or file tree. Four rule classes:
//! 1. Whole-segment match at any level (EPHEMERAL_DIRS).
//! 2. Root-level only (ROOT_LEVEL_EPHEMERAL + bare prefixes tmp-/temp-/scratch-).
//! 3. Dotted prefix variants at any level (.tmp-/.temp-/.scratch-).
//! 4. Special file names (.DS_Store) at any level.

/// Ephemeral directory names matched as a whole path segment at ANY level.
pub const EPHEMERAL_DIRS: [&str; 24] = [
    ".gwork", ".gwork-remote", ".gourdai", ".claude", ".opencode",
    ".idea", ".vscode", ".settings", ".git", ".gradle", ".mvn",
    ".pytest_cache", "__pycache__", "node_modules", "venv", "vendor",
    "target", "build", ".tmp", ".temp", ".scratch", ".cache",
    ".next", "dist",
];

/// Ephemeral names matched ONLY at the workspace root level.
pub const ROOT_LEVEL_EPHEMERAL: [&str; 3] = ["tmp", "temp", "scratch"];

/// Bare prefixes matched ONLY at the workspace root level.
pub const ROOT_LEVEL_EPHEMERAL_PREFIXES: [&str; 3] = ["tmp-", "temp-", "scratch-"];

/// Dotted prefixes matched at ANY level.
pub const DOT_EPHEMERAL_DIR_PREFIXES: [&str; 3] = [".tmp-", ".temp-", ".scratch-"];

/// Dotted prefixes matched at ANY level **for files as well as directories**.
///
/// WHY THIS IS A SEPARATE TABLE (measured, not guessed): the agent's own scratch
/// convention is `.tmp_<purpose>.js` / `.tmp_<purpose>.log` (underscore after the
/// dotted prefix, e.g. `.tmp_add_nav_i18n.js`, `.tmp_crlf_fix.js`). Those are
/// FILES, and `DOT_EPHEMERAL_DIR_PREFIXES` deliberately skips the last segment
/// unless it is known to be a directory — otherwise a real file named
/// `.tmp-utils.md` inside `src/` would be silenced. The underscore variant is
/// unambiguously scratch (no project ships `.tmp_*` sources), so it is safe to
/// apply to the file segment too. Dotted-hyphen names stay directory-only to
/// preserve that guard.
pub const DOT_EPHEMERAL_FILE_PREFIXES: [&str; 3] = [".tmp_", ".temp_", ".scratch_"];

/// Special file names matched at any level.
pub const EPHEMERAL_FILES: [&str; 1] = [".DS_Store"];

/// Normalize a relative path: resolve `.` and `..` segments. Returns None if
/// the path escapes the root (too many `..`).
pub fn normalize_segments(rel: &str) -> Option<Vec<String>> {
    let mut stack: Vec<String> = Vec::new();
    for seg in rel.split(['/', '\\']) {
        match seg {
            "" | "." => {}
            ".." => {
                if stack.pop().is_none() {
                    return None; // escapes root
                }
            }
            other => stack.push(other.to_string()),
        }
    }
    Some(stack)
}

/// Whether a workspace-relative path refers to an ephemeral artifact.
/// `is_dir_hint` indicates the path is known to be a directory (trailing slash).
pub fn is_ephemeral_relative(rel: &str, is_dir_hint: bool) -> bool {
    let Some(segs) = normalize_segments(rel) else {
        return false;
    };
    if segs.is_empty() {
        return false;
    }
    for (i, seg) in segs.iter().enumerate() {
        let is_last = i == segs.len() - 1;
        // Directory rules (whole-segment + dotted prefixes) apply to non-last
        // segments, or to the last segment only when it is known to be a dir.
        // A file literally named "build" must NOT be filtered by the dir list.
        let dir_rule_applies = !is_last || is_dir_hint;
        if dir_rule_applies {
            if EPHEMERAL_DIRS.iter().any(|d| d == seg) {
                return true;
            }
            if DOT_EPHEMERAL_DIR_PREFIXES.iter().any(|p| seg.starts_with(p)) {
                return true;
            }
        }
        // Special file names at any level (only when it's a file, i.e. last segment & not dir)
        if is_last && !is_dir_hint && EPHEMERAL_FILES.iter().any(|f| f == seg) {
            return true;
        }
        // Dotted scratch prefixes that are unambiguous for FILES as well
        // (".tmp_add_nav_i18n.js"): apply at every level, last segment included.
        if DOT_EPHEMERAL_FILE_PREFIXES.iter().any(|p| seg.starts_with(p)) {
            return true;
        }
        // Root-level-only rules apply only to the first segment
        if i == 0 {
            if ROOT_LEVEL_EPHEMERAL.iter().any(|d| d == seg) {
                return true;
            }
            if ROOT_LEVEL_EPHEMERAL_PREFIXES.iter().any(|p| seg.starts_with(p)) {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ephemeral_dirs() {
        assert!(is_ephemeral_relative("target/classes/Foo.class", false));
        assert!(is_ephemeral_relative("node_modules/x/y.js", false));
        assert!(is_ephemeral_relative("src/.idea/workspace.xml", false));
        assert!(is_ephemeral_relative(".git/config", false));
        assert!(!is_ephemeral_relative("src/main.rs", false));
        assert!(!is_ephemeral_relative("targeting/foo.rs", false));
    }

    #[test]
    fn test_root_level_only() {
        assert!(is_ephemeral_relative("tmp/probe.js", false));
        assert!(is_ephemeral_relative("temp/x", false));
        assert!(!is_ephemeral_relative("src/tmp/utils.rs", false));
        assert!(is_ephemeral_relative("tmp-cache/x", false));
        assert!(!is_ephemeral_relative("src/tmp-cache/x", false));
    }

    #[test]
    fn test_dotted_prefix_any_level() {
        assert!(is_ephemeral_relative(".tmp-scan/x", false));
        assert!(is_ephemeral_relative("src/.temp-build/x", false));
    }

    #[test]
    fn test_dotted_underscore_scratch_files_any_level() {
        // The agent's scratch convention: dotted prefix + underscore, FILE form.
        // These leaked into the outputs panel as ADDED rows (measured defect).
        assert!(is_ephemeral_relative(".tmp_add_nav_i18n.js", false));
        assert!(is_ephemeral_relative("scripts/.tmp_crlf_fix.js", false));
        assert!(is_ephemeral_relative(".temp_x.log", false));
        assert!(is_ephemeral_relative(".scratch_y.txt", false));
        // Dotted-HYPHEN names must stay directory-only: a real file named
        // ".tmp-utils.md" is not unambiguously scratch (Java codereview guard).
        assert!(!is_ephemeral_relative("src/.tmp-utils.md", false));
        assert!(is_ephemeral_relative("src/.tmp-utils/x.md", false));
    }

    #[test]
    fn test_ds_store() {
        assert!(is_ephemeral_relative(".DS_Store", false));
        assert!(is_ephemeral_relative("src/.DS_Store", false));
    }

    #[test]
    fn test_traversal_escape() {
        // ../tmp/evil escapes root → normalize returns None → not ephemeral here
        // (caller handles out-of-root separately)
        assert!(!is_ephemeral_relative("../tmp/evil.js", false));
        assert!(is_ephemeral_relative("src/../tmp/x", false));
    }

    #[test]
    fn test_last_segment_file_not_dir_rule() {
        // A file literally named "build" should NOT be filtered by dir rule
        assert!(!is_ephemeral_relative("scripts/build", false));
        // But a directory named build should be
        assert!(is_ephemeral_relative("scripts/build", true));
    }
}
