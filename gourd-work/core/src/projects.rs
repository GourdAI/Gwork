//! projects — Project (workspace) registry.
//!
//! Mirrors the Java kernel's `ProjectService` **contract-for-contract**: the same
//! request fields, the same response shapes and the same error codes, so the
//! existing frontend (which was written against the Java kernel) works unchanged.
//!
//! Three contract points that are easy to get wrong and are therefore called out:
//!
//! 1. `add`/`create`/`remove`/`rename` all return the **whole updated list**, not
//!    the single touched item. The frontend deliberately ignores `resp.data` for
//!    these (see app-code.js `addProject`) and re-pulls, but other callers do read
//!    the list, and returning a single object silently breaks them.
//! 2. `add` is **upsert + move-to-front**, not "reject if already registered".
//!    Re-picking a directory you already opened is the most common action there is;
//!    erroring on it makes the picker look broken.
//! 3. `mkdir` takes `(parent, name)` — *not* `(base, rel)`. The frontend sends
//!    `{parent, name}`; a `rel`-shaped signature silently creates the wrong path.
//!
//! Paths are normalized **lexically** (absolute + collapse `.`/`..`), matching
//! Java's `Paths.get(x).toAbsolutePath().normalize()`. We deliberately do *not*
//! use `std::fs::canonicalize`: on Windows it returns `\\?\D:\...` verbatim UNC
//! form, which leaks into the UI and breaks string comparison against the
//! registry.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::config::Settings;

/// Run a blocking closure **off** the async worker thread.
///
/// WHY THIS EXISTS (measured, not guessed): these functions are synchronous and
/// are called directly from `async` axum handlers (`server/projects_api.rs`, not
/// ours to change). `locate` in particular is a bounded BFS over up to
/// `LOCATE_MAX_VISITED` = 30 000 directories, seeded from every filesystem root —
/// on this machine that is minutes of `read_dir` syscalls, and every millisecond
/// of it would be spent on a tokio worker, stalling unrelated endpoints. The
/// measured shape of that failure elsewhere in this repo: `/web/chat/meta` going
/// 0.23 ms → 85.85 ms under 8 concurrent blocking requests.
///
/// `block_in_place` rather than `spawn_blocking` so the public API stays
/// synchronous. It panics on a `current_thread` runtime, hence the flavour check;
/// outside a runtime (unit tests, CLI one-shots) the closure simply runs inline,
/// which is the pre-existing behaviour.
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

/// Maximum number of registered projects (Java: `MAX_PROJECTS`).
const MAX_PROJECTS: usize = 50;

/// Maximum BFS depth for `locate` (Java: `LOCATE_MAX_DEPTH`).
const LOCATE_MAX_DEPTH: usize = 4;

/// Maximum number of directories visited by `locate` (Java: `LOCATE_MAX_VISITED`).
const LOCATE_MAX_VISITED: usize = 30_000;

/// Directory names skipped while scanning: build output, dependency caches and OS
/// directories. None of them can be a user project root, and all of them are deep
/// enough to burn the whole visit budget on their own (Java: `SCAN_EXCLUDED`).
const SCAN_EXCLUDED: &[&str] = &[
    "node_modules",
    "target",
    "build",
    "venv",
    "vendor",
    ".git",
    ".idea",
    ".vscode",
    "Windows",
    "Program Files",
    "Program Files (x86)",
    "ProgramData",
    "$Recycle.Bin",
    "AppData",
    "System Volume Information",
    "Recovery",
];

/// A registered project.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Project {
    pub path: String,
    pub name: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}

impl Default for Project {
    fn default() -> Self {
        Self {
            path: String::new(),
            name: String::new(),
            created_at: chrono::Utc::now().timestamp_millis(),
        }
    }
}

/// An API-level failure carrying the HTTP-ish business code the frontend expects.
///
/// The Java kernel returns `Result.failure(400|404|500, msg)`; the frontend reads
/// `resp.code` / `resp.description`. Keeping the code here (instead of flattening
/// everything to 400) preserves "directory not found" vs "invalid name" semantics.
#[derive(Debug, Clone)]
pub struct ApiError {
    pub code: u16,
    pub message: String,
}

impl ApiError {
    pub fn new(code: u16, msg: impl Into<String>) -> Self {
        Self {
            code,
            message: msg.into(),
        }
    }
    /// Render as the JSON body shape used across this kernel.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({"code": self.code, "description": self.message})
    }
}

/// The project registry file path.
fn projects_file() -> PathBuf {
    Settings::gwork_home().join("projects.json")
}

/// Load all registered projects.
pub fn load_projects() -> Vec<Project> {
    let Ok(content) = std::fs::read_to_string(projects_file()) else {
        return Vec::new();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

/// Save the project list.
fn save_projects(projects: &[Project]) {
    let home = Settings::gwork_home();
    let _ = std::fs::create_dir_all(&home);
    if let Ok(json) = serde_json::to_string_pretty(projects) {
        let _ = std::fs::write(projects_file(), json);
    }
}

/// Serialize a project list into the response `data` payload.
///
/// Field order matches Java's `LinkedHashMap` (`name` then `path`) so response
/// bodies are byte-comparable across the two kernels.
pub fn projects_json(projects: &[Project]) -> Vec<serde_json::Value> {
    projects
        .iter()
        .map(|p| {
            serde_json::json!({
                "name": p.name,
                "path": p.path,
                "createdAt": p.created_at,
            })
        })
        .collect()
}

/// Lexical path normalization: make absolute, then collapse `.`/`..`.
///
/// Equivalent to Java's `Paths.get(x).toAbsolutePath().normalize()`. Does **not**
/// touch the filesystem (so it works for not-yet-created paths) and does **not**
/// produce Windows `\\?\` prefixes.
pub fn normalize_path(p: &Path) -> PathBuf {
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(p)
    };

    let mut out = PathBuf::new();
    for comp in abs.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                // Only pop when the last component is a real directory name;
                // popping a prefix/root would corrupt the path.
                if out.components().next_back().map_or(false, |c| {
                    matches!(c, Component::Normal(_))
                }) {
                    out.pop();
                } else {
                    out.push(comp);
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Strip a trailing separator so `D:\proj\` and `D:\proj` compare equal.
fn trim_sep(s: &str) -> &str {
    s.trim_end_matches(['/', '\\'])
}

/// Case-insensitive path comparison (Windows-safe).
fn paths_equal(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        trim_sep(a).to_lowercase() == trim_sep(b).to_lowercase()
    } else {
        trim_sep(a) == trim_sep(b)
    }
}

/// Display name for a path: the last component, falling back to the whole path.
fn display_name_of(abs: &Path) -> String {
    abs.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| abs.to_string_lossy().to_string())
}

/// Register an existing directory as a project (upsert + move-to-front).
///
/// Returns the **whole updated list**. Mirrors Java `ProjectService.add`.
pub fn add_project(path: &str, name: &str) -> Result<Vec<Project>, ApiError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(ApiError::new(400, "Path is required"));
    }
    if trimmed.contains("..") {
        return Err(ApiError::new(400, "Invalid path"));
    }

    let dir = normalize_path(Path::new(trimmed));
    if !dir.is_dir() {
        return Err(ApiError::new(404, "Directory not found"));
    }

    let abs_path = dir.to_string_lossy().to_string();
    let display = if name.trim().is_empty() {
        display_name_of(&dir)
    } else {
        name.trim().to_string()
    };

    let mut projects = load_projects();
    // Upsert: drop any entry for the same path, then re-insert at the front
    // (front == most recently used).
    projects.retain(|p| !paths_equal(&p.path, &abs_path));
    projects.insert(
        0,
        Project {
            path: abs_path,
            name: display,
            created_at: chrono::Utc::now().timestamp_millis(),
        },
    );
    while projects.len() > MAX_PROJECTS {
        projects.pop();
    }

    save_projects(&projects);
    Ok(projects)
}

/// Create a new directory under `parent` and register it as a project.
///
/// Returns the whole updated list. Mirrors Java `ProjectService.create`.
pub fn create_project(parent: &str, name: &str) -> Result<Vec<Project>, ApiError> {
    let clean = name.trim();
    if clean.is_empty() {
        return Err(ApiError::new(400, "项目名不能为空"));
    }
    if is_bad_dir_name(clean) {
        return Err(ApiError::new(400, "项目名包含非法字符"));
    }

    let parent_path = if parent.trim().is_empty() {
        home_dir_string()
    } else {
        parent.trim().to_string()
    };
    if parent_path.contains("..") {
        return Err(ApiError::new(400, "父目录路径非法"));
    }

    let parent_dir = normalize_path(Path::new(&parent_path));
    if !parent_dir.is_dir() {
        return Err(ApiError::new(404, "父目录不存在"));
    }

    let target = normalize_path(&parent_dir.join(clean));
    if !target.starts_with(&parent_dir) {
        return Err(ApiError::new(400, "项目名包含非法字符"));
    }
    if target.exists() {
        return Err(ApiError::new(400, "目录已存在"));
    }
    std::fs::create_dir_all(&target)
        .map_err(|e| ApiError::new(500, format!("创建目录失败：{}", e)))?;

    // Reuse add() so dedup / move-to-front / persistence stay in one place.
    add_project(&target.to_string_lossy(), clean)
}

/// Create a subdirectory **without** registering it as a project.
///
/// Takes `(parent, name)` — the frontend's directory browser sends exactly these
/// two fields. Returns `{path, name}`. Mirrors Java `ProjectService.mkdir`.
pub fn mkdir(parent: &str, name: &str) -> Result<(String, String), ApiError> {
    let clean = name.trim();
    if clean.is_empty() {
        return Err(ApiError::new(400, "目录名不能为空"));
    }
    if is_bad_dir_name(clean) {
        return Err(ApiError::new(400, "目录名包含非法字符"));
    }

    let parent_path = if parent.trim().is_empty() {
        home_dir_string()
    } else {
        parent.trim().to_string()
    };
    if parent_path.contains("..") {
        return Err(ApiError::new(400, "父目录路径非法"));
    }

    let parent_dir = normalize_path(Path::new(&parent_path));
    if !parent_dir.is_dir() {
        return Err(ApiError::new(404, "父目录不存在"));
    }

    let target = normalize_path(&parent_dir.join(clean));
    // Second containment check: defends against a name that normalizes its way out.
    if !target.starts_with(&parent_dir) {
        return Err(ApiError::new(400, "目录名包含非法字符"));
    }
    if target.exists() {
        // Never succeed silently here: the user would believe the folder was
        // created and then navigate into somebody else's directory (or a file).
        return Err(ApiError::new(400, "目录已存在"));
    }
    std::fs::create_dir_all(&target)
        .map_err(|e| ApiError::new(500, format!("创建目录失败：{}", e)))?;

    Ok((target.to_string_lossy().to_string(), clean.to_string()))
}

/// Directory-name safety check shared by `create` and `mkdir`.
///
/// Rejects traversal and separators on every platform, plus `:` (Windows drive /
/// NTFS alternate data streams). Same rule set as the Java kernel.
fn is_bad_dir_name(name: &str) -> bool {
    name.contains("..") || name.contains('/') || name.contains('\\') || name.contains(':')
}

fn home_dir_string() -> String {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .to_string_lossy()
        .to_string()
}

/// Browse a directory: list subdirectories for the directory picker.
pub fn browse(path: &str) -> Vec<serde_json::Value> {
    let p = if path.is_empty() {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
    } else {
        PathBuf::from(path)
    };
    // One `read_dir` plus an `is_dir()` stat per entry. Cheap for a project
    // folder, but the picker is pointed at arbitrary user directories (a drive
    // root with thousands of entries is a normal pick), and it is called from an
    // async handler — so it goes through `offload` like the rest of this module.
    offload(move || {
        let mut items = Vec::new();
        let Ok(rd) = std::fs::read_dir(&p) else {
            return items;
        };
        for e in rd.flatten() {
            let path = e.path();
            if !path.is_dir() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            items.push(serde_json::json!({
                "name": name,
                "path": path.to_string_lossy(),
            }));
        }
        items.sort_by(|a, b| {
            a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or(""))
        });
        items
    })
}

/// Remove a project from the registry (does not delete files).
///
/// Returns the whole updated list. Mirrors Java `ProjectService.remove`.
pub fn remove_project(path: &str) -> Result<Vec<Project>, ApiError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(ApiError::new(400, "Path is required"));
    }
    let abs = normalize_path(Path::new(trimmed)).to_string_lossy().to_string();

    let mut projects = load_projects();
    projects.retain(|p| !paths_equal(&p.path, &abs));
    save_projects(&projects);
    Ok(projects)
}

/// Rename a project's display name **in place** (order preserved).
///
/// Unlike `add`, renaming must not reorder the list: the front position means
/// "most recently used", and a rename is not a use. Returns the whole list.
/// Mirrors Java `ProjectService.rename`.
pub fn rename_project(path: &str, name: &str) -> Result<Vec<Project>, ApiError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(ApiError::new(400, "Path is required"));
    }
    if trimmed.contains("..") {
        return Err(ApiError::new(400, "Invalid path"));
    }
    let dir = normalize_path(Path::new(trimmed));
    let abs = dir.to_string_lossy().to_string();

    let mut projects = load_projects();
    let Some(target) = projects.iter_mut().find(|p| paths_equal(&p.path, &abs)) else {
        return Err(ApiError::new(404, "Project not found"));
    };

    // Empty name restores the directory name; cap at 50 chars (session-label parity).
    let mut display = if name.trim().is_empty() {
        display_name_of(&dir)
    } else {
        name.trim().to_string()
    };
    if display.chars().count() > 50 {
        display = display.chars().take(50).collect();
    }
    target.name = display;

    save_projects(&projects);
    Ok(projects)
}

/// Result of a `locate` scan.
#[derive(Debug, Clone, Default)]
pub struct LocateResult {
    /// Absolute paths of matching directories (at most 2).
    pub candidates: Vec<String>,
    /// How many directories were visited.
    pub scanned: usize,
}

/// Resolve a browser-picked folder back to an absolute path on this machine.
///
/// The File System Access API deliberately cannot expose absolute paths — it only
/// gives the directory's own name plus its first-level subdirectory names. Since
/// the kernel runs on the same machine, a **bounded scan** can turn that
/// fingerprint back into a path.
///
/// Two phases (mirrors Java `ProjectService.locate`):
///   1. Compare against the registry only — O(registered) `read_dir` calls, no
///      scanning. Re-picking an already-registered directory is the most common
///      case, and a pure BFS on a deep tree burns the whole budget before finding it.
///   2. Bounded BFS over `home` + each registered project's parent + filesystem
///      roots, depth ≤ 4, visits ≤ 30000, skipping build/dependency/OS dirs.
///      Stops early at 2 candidates (the frontend only needs "auto-select the
///      unique hit / let the user disambiguate").
///
/// Fingerprint matching is **subset** semantics (`want ⊆ actual`): the
/// `webkitdirectory` fallback path cannot see empty subdirectories, so exact
/// equality would systematically miss.
pub fn locate(name: &str, children: &[String]) -> Result<LocateResult, ApiError> {
    let clean = name.trim();
    if clean.is_empty() {
        return Err(ApiError::new(400, "Invalid name"));
    }
    if is_bad_dir_name(clean) {
        return Err(ApiError::new(400, "Invalid name"));
    }

    let clean = clean.to_string();
    let children: Vec<String> = children.to_vec();
    // The heaviest operation in this module: phase 2 is a BFS over up to 30 000
    // directories seeded from every drive root, and `is_match` does a further
    // `read_dir` per visited directory. Running that inline on a tokio worker
    // would freeze the whole server for its duration — the same class of defect
    // that made `usage/stats` take `/web/chat/meta` from 1 ms to 2178 ms.
    offload(move || {
        let want = normalize_fingerprint(&children);
        let projects = load_projects();
        let mut out = LocateResult::default();

        // Phase 1: registry only.
        for p in &projects {
            let dir = Path::new(&p.path);
            if is_match(dir, &clean, &want) {
                let hit = normalize_path(dir).to_string_lossy().to_string();
                if !out.candidates.contains(&hit) {
                    out.candidates.push(hit);
                }
            }
        }
        out.candidates.truncate(2);

        // Phase 2: bounded BFS, only if phase 1 was inconclusive.
        if out.candidates.len() < 2 {
            out.scanned = scan_file_system(&projects, &clean, &want, &mut out.candidates);
        }

        Ok(out)
    })
}

/// Normalize a subdirectory-name fingerprint: drop empties and dot-dirs, sort
/// case-insensitively. Mirrors Java `normalizeFingerprint`.
fn normalize_fingerprint(raw: &[String]) -> Vec<String> {
    let mut v: Vec<String> = raw
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && !s.starts_with('.'))
        .collect();
    v.sort_by_key(|s| s.to_lowercase());
    v.dedup_by_key(|s| s.to_lowercase());
    v
}

/// List a directory's first-level subdirectory names (dot-dirs excluded).
fn child_dir_names(dir: &Path) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names = Vec::new();
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if !ft.is_dir() {
            continue;
        }
        let n = e.file_name().to_string_lossy().to_string();
        if n.starts_with('.') {
            continue;
        }
        names.push(n);
    }
    names
}

/// Does `dir` match the expected name + fingerprint? Mirrors Java `isMatch`.
fn is_match(dir: &Path, name: &str, want: &[String]) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let dir_name = match dir.file_name() {
        Some(n) => n.to_string_lossy().to_string(),
        None => return false,
    };
    let name_ok = if cfg!(windows) {
        dir_name.eq_ignore_ascii_case(name) || dir_name.to_lowercase() == name.to_lowercase()
    } else {
        dir_name == name
    };
    if !name_ok {
        return false;
    }

    let actual = normalize_fingerprint(&child_dir_names(dir));
    // Subset semantics: every expected child must be present.
    want.iter().all(|w| {
        actual
            .iter()
            .any(|a| a.eq_ignore_ascii_case(w) || a.to_lowercase() == w.to_lowercase())
    })
}

/// Filesystem roots to seed the BFS with.
fn fs_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if cfg!(windows) {
        // No std API for this; probe drive letters.
        for c in b'A'..=b'Z' {
            let p = PathBuf::from(format!("{}:\\", c as char));
            if p.is_dir() {
                roots.push(p);
            }
        }
    } else {
        roots.push(PathBuf::from("/"));
    }
    roots
}

/// Phase-2 bounded BFS. Returns the number of directories visited.
fn scan_file_system(
    projects: &[Project],
    clean_name: &str,
    want: &[String],
    candidates: &mut Vec<String>,
) -> usize {
    let home = dirs::home_dir().map(|h| normalize_path(&h));

    // Seed roots: home, each registered project's parent (a newly created sibling
    // directory is the second most common pick), then filesystem roots.
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(h) = &home {
        roots.push(h.clone());
    }
    for p in projects {
        let abs = normalize_path(Path::new(&p.path));
        if let Some(parent) = abs.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    roots.extend(fs_roots());

    let mut queue: std::collections::VecDeque<(PathBuf, usize)> =
        roots.into_iter().map(|r| (r, 0)).collect();
    let mut visited: HashSet<PathBuf> = HashSet::new();
    let mut scanned = 0usize;

    while let Some((path, depth)) = queue.pop_front() {
        if !visited.insert(path.clone()) {
            continue;
        }
        if scanned >= LOCATE_MAX_VISITED {
            break;
        }
        scanned += 1;

        // Every visited directory (including roots at depth 0) is tested.
        if is_match(&path, clean_name, want) {
            let hit = path.to_string_lossy().to_string();
            if !candidates.contains(&hit) {
                candidates.push(hit.clone());
                if candidates.len() >= 2 {
                    break; // Early stop: two candidates are enough for the UI.
                }
            }
        }

        if depth >= LOCATE_MAX_DEPTH {
            continue;
        }

        let Ok(rd) = std::fs::read_dir(&path) else {
            continue;
        };
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            if !ft.is_dir() {
                continue;
            }
            let child_name = e.file_name().to_string_lossy().to_string();
            if child_name.starts_with('.') {
                continue;
            }
            if SCAN_EXCLUDED.contains(&child_name.as_str()) {
                continue;
            }
            let child_path = normalize_path(&e.path());
            // Skip home when reached from a drive root: the home subtree is
            // already covered by the home root itself.
            if let Some(h) = &home {
                if &child_path == h {
                    continue;
                }
            }
            queue.push_back((child_path, depth + 1));
        }
    }
    scanned
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_paths_equal() {
        assert!(paths_equal("D:/proj", "D:/proj/"));
        assert!(paths_equal("D:/Proj", "d:/proj"));
        assert!(!paths_equal("D:/proj", "D:/other"));
    }

    #[test]
    fn normalize_collapses_dot_segments() {
        let n = normalize_path(Path::new("D:/a/b/../c"));
        assert_eq!(n.to_string_lossy().replace('\\', "/"), "D:/a/c");
    }

    #[test]
    fn normalize_never_emits_windows_unc_prefix() {
        // canonicalize() would give \\?\D:\... on Windows; normalize must not.
        let n = normalize_path(Path::new("D:/work"));
        let s = n.to_string_lossy().to_string();
        assert!(!s.starts_with(r"\\?\"), "got {}", s);
    }

    #[test]
    fn bad_dir_names_are_rejected() {
        assert!(is_bad_dir_name(".."));
        assert!(is_bad_dir_name("a/b"));
        assert!(is_bad_dir_name("a\\b"));
        assert!(is_bad_dir_name("C:x"));
        assert!(!is_bad_dir_name("plain-name"));
    }

    #[test]
    fn fingerprint_normalization_drops_dots_and_sorts() {
        let raw: Vec<String> = vec!["zeta".into(), ".git".into(), "  ".into(), "Alpha".into()];
        let n = normalize_fingerprint(&raw);
        assert_eq!(n, vec!["Alpha".to_string(), "zeta".to_string()]);
    }

    #[test]
    fn fingerprint_match_is_subset_semantics() {
        // want ⊆ actual must match; a missing entry must not.
        let dir = std::env::temp_dir().join(format!("gwork-locate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join("docs")).unwrap();

        let name = dir.file_name().unwrap().to_string_lossy().to_string();
        assert!(is_match(&dir, &name, &normalize_fingerprint(&["src".to_string()])));
        assert!(is_match(
            &dir,
            &name,
            &normalize_fingerprint(&["src".to_string(), "docs".to_string()])
        ));
        assert!(!is_match(
            &dir,
            &name,
            &normalize_fingerprint(&["src".to_string(), "missing".to_string()])
        ));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn locate_rejects_traversal_names() {
        assert!(locate("..", &[]).is_err());
        assert!(locate("a/b", &[]).is_err());
        assert!(locate("", &[]).is_err());
    }
}
