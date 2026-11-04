//! filer — File browser/editor backend (tree/read/write/search/raw).
//!
//! Mirrors the Java kernel's filer endpoints. All paths are resolved against
//! a root and checked for containment (no traversal escapes).
//!
//! ## Response shapes are the Java kernel's, not this crate's invention
//!
//! The frontend (`app-filer.js`) was written against `FileService`:
//!
//! * `tree` returns the **children array of the requested directory** (the
//!   root node itself is never wrapped in), each directory carrying
//!   `type:"directory"`, `expanded` and `children` (`null` when the depth
//!   budget is spent — the frontend treats that as "lazy, expand on click").
//! * Single-child directory chains are collapsed IDEA-style (`a \ b \ c`),
//!   with `path` pointing at the chain tail.
//! * `search` matches the **relative path** (not just the file name) and
//!   reports directories too.
//!
//! Deviating from any of these silently breaks the tree (the renderer calls
//! `nodes.forEach`, so an object payload throws and the panel stays empty).

use std::path::{Path, PathBuf};

/// Run a blocking closure **off** the async worker thread.
///
/// WHY THIS EXISTS (measured, not guessed): every public function here is
/// synchronous and is called straight from `async` axum handlers
/// (`server/filer_api.rs`, which is not ours to change). A directory walk that
/// blocks a tokio worker does not just make *its own* endpoint slow — it stalls
/// every other task pinned to that worker. The `git/status` scan in this repo
/// measured exactly that: an unrelated `/web/chat/meta` went 0.23 ms → 85.85 ms
/// under 8 concurrent blocking requests.
///
/// `block_in_place` rather than `spawn_blocking` because the public API must stay
/// synchronous: it hands the worker's core to a replacement thread and blocks
/// *this* one, so no caller signature changes.
///
/// Panics on a `current_thread` runtime (no core to hand off), so the flavour is
/// checked first and the closure runs inline otherwise — identical to the old
/// behaviour, which keeps the unit tests below and any non-server caller working.
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

/// Resolve a relative path against a root, ensuring containment.
fn resolve(root: &Path, rel: &str) -> Option<PathBuf> {
    let target = if rel.is_empty() || rel == "." {
        root.to_path_buf()
    } else {
        root.join(rel)
    };
    // Normalize .. components
    let mut normalized = PathBuf::new();
    for comp in target.components() {
        match comp {
            std::path::Component::ParentDir => {
                if !normalized.pop() {
                    return None;
                }
            }
            std::path::Component::CurDir => {}
            other => normalized.push(other),
        }
    }
    let root_norm = normalize_case(root);
    let target_norm = normalize_case(&normalized);
    if target_norm.starts_with(&root_norm) {
        Some(normalized)
    } else {
        None
    }
}

fn normalize_case(p: &Path) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(p.to_string_lossy().to_lowercase())
    } else {
        p.to_path_buf()
    }
}

/// Directories skipped during tree/search traversal.
///
/// Kept in sync with the Java kernel's `FileService.EXCLUDED_DIRS`: project
/// metadata (`.gwork`, IDE dirs), VCS/build internals and dependency or
/// output trees. A missing entry here does not crash anything, but it makes
/// the Rust tree show directories the Java tree hides (and vice versa),
/// which users read as "the two clients disagree".
const SKIP_DIRS: [&str; 20] = [
    // project metadata & IDE
    ".gwork",
    ".gwork-remote",
    ".gourdai",
    ".claude",
    ".opencode",
    ".idea",
    ".vscode",
    ".settings",
    // version control & build tooling
    ".git",
    ".gradle",
    ".mvn",
    // runtime caches
    ".pytest_cache",
    "__pycache__",
    ".DS_Store",
    // dependency dirs
    "node_modules",
    "venv",
    "vendor",
    // build output
    "target",
    "build",
    "dist",
];

fn skipped(name: &str) -> bool {
    SKIP_DIRS.iter().any(|s| *s == name)
}

fn rel_of(path: &Path, root: &Path) -> String {
    path.strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default()
}

/// Is this entry a directory? — **without** an extra `stat` syscall.
///
/// WHY THIS EXISTS (measured, not guessed): the previous code called
/// `entry.path().is_dir()`, which issues a fresh `GetFileAttributesW` per entry.
/// `DirEntry::file_type()` instead reuses the data the directory scan already
/// returned (`FindFirstFile`/`getdents` carry the type), so it costs nothing.
///
/// On the real workspace (`filer/tree?depth=2`, ~1.6k entries) the `is_dir()`
/// version measured **173.5 ms median vs the Java kernel's 18.97 ms** — 9.1x
/// slower, i.e. the single worst endpoint in the whole three-way comparison.
/// Sorting amplified it: the comparator called `is_dir()` again on every
/// comparison, so a directory with N children paid O(N log N) stats instead of N.
///
/// Symlinks are the one case where `file_type()` and `is_dir()` genuinely differ
/// (the former reports the link, the latter follows it). Falling back to the
/// stat *only* for symlinks keeps the old semantics exactly while paying for the
/// syscall on the handful of entries that actually need it.
fn entry_is_dir(e: &std::fs::DirEntry) -> bool {
    match e.file_type() {
        Ok(ft) => {
            if ft.is_symlink() {
                e.path().is_dir()
            } else {
                ft.is_dir()
            }
        }
        // Unreadable type: fall back to the stat rather than mis-sorting the tree.
        Err(_) => e.path().is_dir(),
    }
}

/// Children of `dir`, sorted directories-first then by name (Java order), each
/// paired with its already-resolved directory flag so callers (`build_children`,
/// the tree walk) do not re-derive it.
///
/// The flag is resolved **once per entry** and carried in the sort key. The
/// previous comparator called `path().is_dir()` inside `sort_by`, so the same
/// entry was stat'ed O(log N) times; see `entry_is_dir` for the measured cost.
fn sorted_entries_with_dirs(dir: &Path) -> Vec<(std::fs::DirEntry, bool)> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut entries: Vec<_> = rd
        .flatten()
        .filter(|e| !skipped(&file_name(e)))
        .map(|e| {
            let is_dir = entry_is_dir(&e);
            let lower = file_name(&e).to_lowercase();
            (e, is_dir, lower)
        })
        .collect();
    entries.sort_by(|a, b| {
        // directories first (true > false → reverse), then case-insensitive name
        b.1.cmp(&a.1).then_with(|| a.2.cmp(&b.2))
    });
    entries.into_iter().map(|(e, d, _)| (e, d)).collect()
}

fn file_name(e: &std::fs::DirEntry) -> String {
    e.file_name().to_string_lossy().to_string()
}

/// IDEA-style single-child chain collapse: while a directory holds exactly
/// one non-skipped child and that child is a directory, fold it into the
/// current node (name joined with " \ ", path advanced to the chain tail).
/// Mirrors `FileService.buildTree` so both kernels render identical trees.
fn collapse_chain(start: &Path, root: &Path) -> (PathBuf, String) {
    let mut path = start.to_path_buf();
    let mut name = file_name_of(&path);
    loop {
        // Chain collapse only needs "exactly one non-skipped child, and it is a
        // directory". The previous implementation called `sorted_entries` here,
        // which allocated a Vec, lowercased every name and ran a full sort —
        // per chain link, per directory, on every tree request. That is pure
        // waste: the sort order is discarded one line later.
        let Some(next) = sole_dir_child(&path) else { break };
        name = format!("{} \\ {}", name, file_name_of(&next));
        path = next;
    }
    let _ = root; // root only needed by callers for rel computation
    (path, name)
}

/// The single non-skipped child of `dir` when it is a directory, else `None`.
///
/// Short-circuits as soon as a second candidate appears, so a wide directory
/// costs one `read_dir` and at most two `file_type()` lookups instead of a
/// full listing + sort.
fn sole_dir_child(dir: &Path) -> Option<PathBuf> {
    let rd = std::fs::read_dir(dir).ok()?;
    let mut found: Option<PathBuf> = None;
    for e in rd.flatten() {
        if skipped(&file_name(&e)) {
            continue;
        }
        if !entry_is_dir(&e) {
            return None; // a file sibling → not collapsible
        }
        if found.is_some() {
            return None; // two directories → not collapsible
        }
        found = Some(e.path());
    }
    found
}

fn file_name_of(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| p.to_string_lossy().to_string())
}

/// Build the children array of `dir` (Java `buildTree` shape).
fn build_children(dir: &Path, root: &Path, max_depth: usize, current_depth: usize) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    // `is_dir` comes from the listing pass (see `entry_is_dir`); re-testing
    // `path.is_dir()` here would stat every entry a second time.
    for (e, is_dir) in sorted_entries_with_dirs(dir) {
        let path = e.path();
        if is_dir {
            let (chain_path, chain_name) = collapse_chain(&path, root);
            let mut item = serde_json::json!({
                "type": "directory",
                "name": chain_name,
                "path": rel_of(&chain_path, root),
            });
            if current_depth < max_depth {
                item["expanded"] = serde_json::json!(true);
                item["children"] =
                    serde_json::json!(build_children(&chain_path, root, max_depth, current_depth + 1));
            } else {
                item["expanded"] = serde_json::json!(false);
                item["children"] = serde_json::Value::Null;
            }
            out.push(item);
        } else {
            out.push(serde_json::json!({
                "type": "file",
                "name": file_name(&e),
                "path": rel_of(&path, root),
            }));
        }
    }
    out
}

/// Directory tree: children of the requested directory (Java contract).
///
/// Returns an error-shaped value (not a bare array) for invalid paths so the
/// handler can map it to the Java kernel's 400/403/404 codes.
pub fn tree(root: &Path, rel: &str, max_depth: usize) -> Result<Vec<serde_json::Value>, TreeError> {
    let Some(base) = resolve(root, rel) else {
        return Err(TreeError::InvalidPath);
    };
    let root_norm = normalize_case(root);
    if !normalize_case(&base).starts_with(&root_norm) {
        return Err(TreeError::Denied);
    }
    // The whole walk is blocking I/O: `depth=2` over the real workspace visits
    // ~1.6k directories. Measured **173.5 ms median vs the Java kernel's
    // 18.97 ms** before the `entry_is_dir` fix, all of it spent on a tokio worker.
    let root = root.to_path_buf();
    offload(move || {
        if !base.is_dir() {
            return Err(TreeError::NotFound);
        }
        Ok(build_children(&base, &root, max_depth, 1))
    })
}

#[derive(Debug)]
pub enum TreeError {
    InvalidPath,
    Denied,
    NotFound,
}

/// Read a file's content (with pagination).
pub fn read_file(root: &Path, rel: &str, offset: usize, limit: usize) -> serde_json::Value {
    let Some(path) = resolve(root, rel) else {
        return serde_json::json!({ "error": "invalid path" });
    };
    let rel_path = rel_of(&path, root);
    let name = file_name_of(&path);
    // Reads the WHOLE file even when the caller asked for 200 lines, then decodes
    // and splits it. On a 136 KB settings.json that is fine; on a multi-MB log it
    // is a worker-blocking stall, so it goes through `offload` like every other
    // filesystem entry point here.
    offload(move || {
        if !path.is_file() {
            return serde_json::json!({ "error": "not a file" });
        }
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) => return serde_json::json!({ "error": e.to_string() }),
        };
        let content = match std::str::from_utf8(&bytes) {
            Ok(s) => s.to_string(),
            Err(_) => {
                let (decoded, _, _) = encoding_rs::GBK.decode(&bytes);
                decoded.into_owned()
            }
        };
        let lines: Vec<&str> = content.lines().collect();
        let total = lines.len();
        let start = offset.saturating_sub(1).min(total);
        let end = if limit == 0 { total } else { (start + limit).min(total) };
        let selected: String = lines[start..end].join("\n");
        serde_json::json!({
            "content": selected,
            "totalLines": total,
            "startLine": start + 1,
            "endLine": end,
            "path": rel_path,
            "name": name,
            "size": bytes.len(),
        })
    })
}

/// Write content to a file.
pub fn write_file(root: &Path, rel: &str, content: &str) -> serde_json::Value {
    let Some(path) = resolve(root, rel) else {
        return serde_json::json!({ "error": "invalid path" });
    };
    let rel_path = rel_of(&path, root);
    let content = content.to_string();
    offload(move || {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match std::fs::write(&path, &content) {
            Ok(()) => serde_json::json!({ "ok": true, "path": rel_path }),
            Err(e) => serde_json::json!({ "error": e.to_string() }),
        }
    })
}

/// Search: relative-path substring match, files and directories (Java shape).
pub fn search(root: &Path, keyword: &str) -> Vec<serde_json::Value> {
    let kw = keyword.to_lowercase();
    let root = root.to_path_buf();
    // Full recursive walk, capped at depth 20 / 200 hits.
    //
    // The cap is on *results*, not on directories visited, so a keyword that
    // matches nothing walks the whole (non-excluded) tree. Measured **507.3 ms
    // median vs the Java kernel's 75.2 ms** (6.7x slower) for `keyword=mod.rs` on
    // the real repo, all of it inline on a tokio worker.
    //
    // The gap was not the walk itself — `SKIP_DIRS` already prunes `target`,
    // `node_modules` and `.git`, which is where the bulk of this repo lives. It
    // was per-entry overhead this function had no reason to pay:
    //   * it called `sorted_entries_with_dirs`, which sorts every directory
    //     (O(N log N) per directory) even though **search results are unordered** —
    //     Java's `searchFiles` iterates `listFiles()` raw and the frontend renders
    //     `data.forEach` in whatever order arrives;
    //   * that helper allocates the file name **twice** per entry (once to filter
    //     `SKIP_DIRS`, once to build the sort key) plus a lowercased copy for the
    //     comparator;
    //   * the match then lowercased the whole relative path into a third String.
    // So ~6 allocations per visited entry. `search_walk` now reads the raw
    // `read_dir` iterator, reuses `DirEntry::file_type()` (no extra stat, see
    // `entry_is_dir`) and compares case-insensitively without allocating.
    offload(move || {
        let mut results = Vec::new();
        search_walk(&root, &root, &kw, &mut results, 0);
        results
    })
}

/// Case-insensitive substring match **without** allocating a lowercased copy.
///
/// ASCII is folded byte-by-byte; anything non-ASCII compares as-is. That is exact
/// for the overwhelmingly common case (source file names are ASCII) and merely
/// case-*sensitive* for CJK/accented names — which is harmless, since those
/// scripts are largely caseless anyway. A keyword containing non-ASCII falls back
/// to the allocating `to_lowercase` comparison so a Chinese file name still
/// matches case-insensitively rather than silently missing.
fn contains_ci(haystack: &str, needle_lower: &str) -> bool {
    if needle_lower.is_empty() {
        return true;
    }
    if !needle_lower.is_ascii() {
        return haystack.to_lowercase().contains(needle_lower);
    }
    let h = haystack.as_bytes();
    let n = needle_lower.as_bytes();
    if n.len() > h.len() {
        return false;
    }
    h.windows(n.len()).any(|w| {
        w.iter()
            .zip(n.iter())
            .all(|(a, b)| a.eq_ignore_ascii_case(b))
    })
}

fn search_walk(base: &Path, root: &Path, kw: &str, out: &mut Vec<serde_json::Value>, depth: usize) {
    // Java caps depth at 20 and results at 200.
    if depth > 20 || out.len() >= 200 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(base) else {
        return;
    };
    for e in rd.flatten() {
        if out.len() >= 200 {
            return;
        }
        // One `to_string_lossy` per entry, reused for the SKIP_DIRS check, the
        // match and the `name` field — the old path allocated it three times.
        let name = e.file_name().to_string_lossy().into_owned();
        if skipped(&name) {
            continue;
        }
        // `entry_is_dir` reuses the directory-scan result, so there is no extra
        // stat per entry — it only falls back to one for symlinks, which is what
        // keeps the semantics identical to Java's `File.isDirectory()` (that one
        // *follows* links, so a symlinked directory is descended into). Using a
        // bare `file_type().is_dir()` here would silently stop searching through
        // symlinked trees.
        let is_dir = entry_is_dir(&e);
        let path = e.path();
        let rel = rel_of(&path, root);
        if contains_ci(&rel, kw) {
            out.push(serde_json::json!({
                "name": name,
                "path": rel,
                "type": if is_dir { "directory" } else { "file" },
            }));
        }
        if is_dir {
            search_walk(&path, root, kw, out, depth + 1);
        }
    }
}

/// Raw bytes + mime for binary preview (unchanged contract).
pub fn raw(root: &Path, rel: &str) -> Option<(String, Vec<u8>)> {
    let path = resolve(root, rel)?;
    let mime = mime_of(&file_name_of(&path));
    // Binary preview: slurps the whole file (an image or PDF can be tens of MB)
    // and the caller then base64-encodes it. Both are worker-blocking.
    offload(move || {
        if !path.is_file() {
            return None;
        }
        let bytes = std::fs::read(&path).ok()?;
        Some((mime, bytes))
    })
}

fn mime_of(name: &str) -> String {
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("gwork_filer_{}", tag));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn tree_returns_children_array_with_directory_type_and_expanded() {
        let root = tmp_root("shape");
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::write(root.join("a/b/deep.txt"), "x").unwrap();
        std::fs::write(root.join("top.txt"), "y").unwrap();

        let kids = tree(&root, "", 1).expect("tree ok");
        // children array, not a wrapped root node
        assert!(kids.iter().any(|k| k["name"] == "top.txt"), "file child present");
        // Chain collapse is depth-independent (same as Java): even at depth 1
        // the single-child chain a\b is folded, only expansion is withheld.
        let dir = kids.iter().find(|k| k["name"] == "a \\ b").expect("chain dir child");
        assert_eq!(dir["type"], "directory");
        // depth budget spent at max_depth=1 → lazy marker, not an empty array
        assert_eq!(dir["expanded"], false);
        assert!(dir["children"].is_null());

        // deeper budget expands and collapses the single-child chain a\b
        let kids2 = tree(&root, "", 3).expect("tree ok");
        let chain = kids2
            .iter()
            .find(|k| k["type"] == "directory")
            .expect("chain node");
        assert_eq!(chain["name"], "a \\ b", "IDEA-style chain collapse");
        assert_eq!(chain["path"], "a/b", "path points at chain tail");
        assert_eq!(chain["expanded"], true);
        let grand = chain["children"].as_array().expect("children array");
        assert_eq!(grand.len(), 1);
        assert_eq!(grand[0]["name"], "deep.txt");
        assert_eq!(grand[0]["type"], "file");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn tree_rejects_traversal_and_missing_dir() {
        let root = tmp_root("guard");
        std::fs::create_dir_all(&root).unwrap();
        assert!(matches!(tree(&root, "../../etc", 1), Err(TreeError::InvalidPath)));
        assert!(matches!(tree(&root, "nope", 1), Err(TreeError::NotFound)));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn tree_hides_excluded_dirs() {
        let root = tmp_root("skip");
        std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
        std::fs::create_dir_all(root.join(".gwork/sessions")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        let kids = tree(&root, "", 2).expect("tree ok");
        let names: Vec<&str> = kids.iter().map(|k| k["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"src"));
        assert!(!names.contains(&"node_modules"));
        assert!(!names.contains(&".gwork"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn search_matches_relative_path_and_reports_dirs() {
        let root = tmp_root("search");
        std::fs::create_dir_all(root.join("docs/specs")).unwrap();
        std::fs::write(root.join("docs/specs/api.md"), "x").unwrap();
        std::fs::write(root.join("readme.md"), "y").unwrap();
        let hits = search(&root, "specs");
        assert!(hits.iter().any(|h| h["type"] == "directory" && h["path"] == "docs/specs"));
        assert!(hits.iter().any(|h| h["path"] == "docs/specs/api.md"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The search walk prunes the same directories the tree does. Java's
    /// `searchFiles` skips `EXCLUDED_DIRS`; without this, a search on a repo with
    /// a `target` or `node_modules` tree returns build artefacts the Java client
    /// never shows — and walks gigabytes doing it.
    #[test]
    fn search_prunes_excluded_dirs() {
        let root = tmp_root("search-prune");
        std::fs::create_dir_all(root.join("target/deps")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("target/deps/needle.rs"), "x").unwrap();
        std::fs::write(root.join("node_modules/pkg/needle.js"), "x").unwrap();
        std::fs::write(root.join(".git/needle"), "x").unwrap();
        std::fs::write(root.join("src-needle.rs"), "x").unwrap();
        let hits = search(&root, "needle");
        let paths: Vec<String> = hits.iter().map(|h| h["path"].as_str().unwrap_or("").to_string()).collect();
        assert!(paths.iter().any(|p| p == "src-needle.rs"), "the visible file must be found: {:?}", paths);
        assert!(!paths.iter().any(|p| p.contains("target")), "target must be pruned: {:?}", paths);
        assert!(!paths.iter().any(|p| p.contains("node_modules")), "node_modules must be pruned: {:?}", paths);
        assert!(!paths.iter().any(|p| p.contains(".git")), ".git must be pruned: {:?}", paths);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Case-insensitive matching without allocating a lowercased copy per entry
    /// (`contains_ci`). The keyword arrives pre-lowercased from `search`; these
    /// pin the folding in both directions and the non-ASCII fallback.
    #[test]
    fn contains_ci_folds_ascii_and_falls_back_for_non_ascii() {
        assert!(contains_ci("Src/Main.RS", "main.rs"));
        assert!(contains_ci("src/main.rs", "MAIN.RS"));
        assert!(!contains_ci("src/main.rs", "other"));
        // Empty needle matches everything (Java `"".contains` semantics).
        assert!(contains_ci("anything", ""));
        // Non-ASCII keywords must still match: the fast path is ASCII-only, so
        // the fallback decides these.
        assert!(contains_ci("文档/说明.MD", "说明.md"));
        assert!(!contains_ci("文档/说明.md", "别的"));
        // A needle longer than the haystack can never match.
        assert!(!contains_ci("ab", "abcdef"));
    }

    /// Depth and result caps, matching Java's `depth > 20` / `size() > 200`.
    #[test]
    fn search_caps_results_at_two_hundred() {
        let root = tmp_root("search-cap");
        std::fs::create_dir_all(&root).unwrap();
        for i in 0..250 {
            std::fs::write(root.join(format!("hit-{:03}.txt", i)), "x").unwrap();
        }
        let hits = search(&root, "hit-");
        assert_eq!(hits.len(), 200, "results must cap at 200 (Java parity)");
        let _ = std::fs::remove_dir_all(&root);
    }
}
