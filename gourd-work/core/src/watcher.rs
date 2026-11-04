//! watcher — filesystem watching for the editor's "changed on disk" reload.
//!
//! Mirrors the Java kernel's `WorkspaceWatcher`: the frontend registers the
//! project root it is editing (`POST /web/chat/filer/watch`), and any change made
//! **outside** the app is broadcast over the gate WebSocket as a `filer_change`
//! frame so open editors can reload (clean files silently, dirty files via a
//! marker — see app-code.js `onCodeFilerChange`).
//!
//! ## Frame shape (must match the Java kernel byte-for-byte in field names)
//!
//! ```json
//! { "type": "filer_change", "changes": ["src/Foo.java"], "createdAt": 1716153600000 }
//! ```
//!
//! `changes` holds paths **relative to the watch root they belong to**, with
//! forward slashes. The frontend resolves them against the current project root
//! (`changeRelToOpenPath`) and deliberately does *not* fall back to matching by
//! file name, so a wrong relative form means the reload silently never happens.
//!
//! ## Decoupling from AppState
//!
//! The watcher lives *inside* `AppState` but must broadcast through it, which
//! would be a cycle. Instead it owns an `mpsc` sender; `server::serve` spawns a
//! task that drains it and calls `broadcast_frame(state, "*", frame)`. `"*"` is
//! the gate's session-less subscription key, which is exactly the audience a
//! system-level broadcast needs.
//!
//! ## Debounce
//!
//! `notify` reports finer-grained events than Java's `WatchService` (a single
//! editor save can produce modify + access + metadata events). Events are
//! accumulated into a set and flushed after a quiet window, so one save yields
//! one frame instead of a burst.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::{mpsc, Mutex};

use crate::protocol::Frame;

/// Run a blocking closure **off** the async worker thread.
///
/// `register_root` does a bounded BFS over up to 20 000 directories
/// ([`collect_dirs`]) and then one `notify` `watch()` syscall per directory — on
/// Windows that is 20 000 `ReadDirectoryChangesW` registrations, seconds of work.
/// The frontend calls it on **every project switch** (`filer_api::watch`), so
/// leaving it on the worker stalls every other request pinned to that core. This
/// is the same failure mode measured elsewhere in the repo (`/web/chat/meta`
/// 1 ms → 2178 ms under a blocking scan).
///
/// `block_in_place` rather than `spawn_blocking`: the closure borrows the
/// `&mut RecommendedWatcher` out of a live `tokio::sync::Mutex` guard, which is
/// not `'static` and so cannot be moved onto the blocking pool. `block_in_place`
/// hands this worker's core to a replacement thread and blocks *this* one, so the
/// borrow stays valid and no caller signature changes. It panics on a
/// `current_thread` runtime, hence the flavour check; outside a multi-thread
/// runtime the closure runs inline, exactly as before.
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

/// Directories never watched nor reported. Same list as the Java kernel:
/// project metadata, VCS, build tooling, runtime caches, dependencies and build
/// output. Watching `node_modules` or `target` alone can produce thousands of
/// events per second during a build.
const EXCLUDED_DIRS: &[&str] = &[
    // project metadata & IDE
    ".gwork",
    ".gwork-remote",
    ".gourdai",
    ".claude",
    ".opencode",
    ".idea",
    ".vscode",
    ".settings",
    // version control & build tools
    ".git",
    ".gradle",
    ".mvn",
    // runtime caches
    ".pytest_cache",
    "__pycache__",
    ".DS_Store",
    // dependencies
    "node_modules",
    "venv",
    "vendor",
    // build output
    "target",
    "build",
];

/// Quiet window before accumulated changes are flushed as one frame.
const DEBOUNCE: Duration = Duration::from_millis(300);

/// Hard cap on paths per frame. A `git checkout` touching thousands of files
/// must not produce an unbounded frame; the frontend reloads on demand anyway.
const MAX_PATHS_PER_FRAME: usize = 500;

/// Shared inner state, so the notify callback thread and the async task can both
/// reach it without lifetimes.
struct Inner {
    /// Registered watch roots (absolute, normalized).
    roots: Vec<PathBuf>,
    /// Accumulated relative paths awaiting flush.
    pending: HashSet<String>,
}

/// Filesystem watcher broadcasting `filer_change` frames.
pub struct WorkspaceWatcher {
    inner: Arc<Mutex<Inner>>,
    /// Kept alive for the watcher's lifetime; dropping it stops all events.
    _watcher: Arc<Mutex<Option<RecommendedWatcher>>>,
}

impl WorkspaceWatcher {
    /// Create a watcher. `out_tx` receives frames ready for WS broadcast.
    ///
    /// `initial_root` is the session workspace, watched from startup so that
    /// external edits are noticed even before the editor registers a project.
    pub fn new(out_tx: mpsc::UnboundedSender<Frame>, initial_root: Option<PathBuf>) -> Self {
        let inner = Arc::new(Mutex::new(Inner {
            roots: Vec::new(),
            pending: HashSet::new(),
        }));

        let cb_tx = out_tx.clone();

        // notify invokes this on its own thread; keep it cheap and non-blocking.
        // Debounce and frame building happen on the tokio task below.
        let (evt_tx, mut evt_rx) = mpsc::unbounded_channel::<PathBuf>();
        let watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                for p in event.paths {
                    let _ = evt_tx.send(p);
                }
            }
        })
        .ok();

        let watcher_arc = Arc::new(Mutex::new(watcher));

        // Debounce/flush task: drains raw paths, relativizes, accumulates, flushes.
        {
            let inner = inner.clone();
            tokio::spawn(async move {
                loop {
                    // Wait for the first event of a batch.
                    let Some(first) = evt_rx.recv().await else {
                        break;
                    };
                    {
                        let mut g = inner.lock().await;
                        if let Some(rel) = relativize(&g.roots, &first) {
                            g.pending.insert(rel);
                        }
                    }
                    // Quiet window: keep absorbing events until none arrive.
                    loop {
                        match tokio::time::timeout(DEBOUNCE, evt_rx.recv()).await {
                            Ok(Some(p)) => {
                                let mut g = inner.lock().await;
                                if let Some(rel) = relativize(&g.roots, &p) {
                                    g.pending.insert(rel);
                                }
                            }
                            Ok(None) => break,   // channel closed
                            Err(_) => break,     // debounce elapsed
                        }
                    }
                    // Flush.
                    let batch: Vec<String> = {
                        let mut g = inner.lock().await;
                        let mut v: Vec<String> = g.pending.drain().collect();
                        v.sort();
                        v.truncate(MAX_PATHS_PER_FRAME);
                        v
                    };
                    if batch.is_empty() {
                        continue;
                    }
                    let frame = Frame {
                        frame_type: "filer_change".into(),
                        session_id: None,
                        run_id: None,
                        event_seq: None,
                        phase: None,
                        text: None,
                        tool_name: None,
                        tool_title: None,
                        action_id: None,
                        suspended: None,
                        created_at: chrono::Utc::now().timestamp_millis(),
                        // `extra` is `#[serde(flatten)]`, so `changes` lands at the
                        // top level of the JSON — exactly where the frontend reads it.
                        extra: serde_json::json!({ "changes": batch }),
                    };
                    let _ = cb_tx.send(frame);
                }
            });
        }

        let w = Self {
            inner,
            _watcher: watcher_arc,
        };

        if let Some(root) = initial_root {
            // Best effort at construction time; failures surface via add_root later.
            tokio::spawn({
                let inner = w.inner.clone();
                let watcher = w._watcher.clone();
                async move {
                    let _ = register_root(&inner, &watcher, &root).await;
                }
            });
        }

        w
    }

    /// Register a directory tree for watching. Returns the number of roots now
    /// active. Idempotent: re-registering the same root is a no-op.
    pub async fn add_root(&self, root: &Path) -> Result<usize, String> {
        register_root(&self.inner, &self._watcher, root).await
    }

    /// Currently registered roots (for diagnostics).
    pub async fn roots(&self) -> Vec<String> {
        self.inner
            .lock()
            .await
            .roots
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect()
    }
}

/// Register `root` recursively, skipping excluded directories.
async fn register_root(
    inner: &Arc<Mutex<Inner>>,
    watcher: &Arc<Mutex<Option<RecommendedWatcher>>>,
    root: &Path,
) -> Result<usize, String> {
    let abs = crate::projects::normalize_path(root);
    if !abs.is_dir() {
        return Err(format!("Directory not found: {}", abs.display()));
    }

    let mut guard = watcher.lock().await;
    let Some(w) = guard.as_mut() else {
        // No filesystem watcher available on this platform/build. Report it
        // rather than pretending the tree is watched.
        return Err("filesystem watcher unavailable".into());
    };

    // Register the root itself plus every non-excluded subdirectory. notify's
    // RecursiveMode::Recursive would be simpler, but then excluded directories
    // (node_modules, target, .git) would still generate events we must filter
    // per-path — and on some platforms they generate enough to starve the queue.
    // Registering non-recursively per directory matches the Java behaviour.
    //
    // Both the BFS and the per-directory `watch()` syscalls run inside one
    // `offload`: together they are the seconds-scale cost this endpoint exists to
    // avoid charging to the async worker. The closure borrows `&mut w` from the
    // live guard above, which is why this is `block_in_place` and not
    // `spawn_blocking` (see the `offload` docs).
    let registered = offload(|| {
        let dirs = collect_dirs(&abs);
        let mut n = 0usize;
        for d in &dirs {
            if w.watch(d, RecursiveMode::NonRecursive).is_ok() {
                n += 1;
            }
        }
        n
    });
    if registered == 0 {
        return Err("no directory could be watched".into());
    }

    let mut g = inner.lock().await;
    if !g.roots.iter().any(|r| r == &abs) {
        g.roots.push(abs);
    }
    Ok(g.roots.len())
}

/// Walk a tree collecting directories, pruning excluded ones (subtree skipped).
fn collect_dirs(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    // Bound the walk: a pathological tree must not hang the request.
    let mut budget = 20_000usize;
    while let Some(dir) = stack.pop() {
        if budget == 0 {
            break;
        }
        budget -= 1;
        out.push(dir.clone());
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            if !ft.is_dir() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if EXCLUDED_DIRS.contains(&name.as_str()) {
                continue; // prune subtree
            }
            stack.push(e.path());
        }
    }
    out
}

/// Make `path` relative to the longest matching watch root, with forward
/// slashes. Returns `None` when the path is outside every root or lands inside
/// an excluded directory.
///
/// Longest-prefix wins: roots can nest (session workspace + a project inside it),
/// and the frontend resolves against the project root, so the *deepest* root is
/// the correct base.
fn relativize(roots: &[PathBuf], path: &Path) -> Option<String> {
    if is_excluded(path) {
        return None;
    }
    let mut best: Option<&PathBuf> = None;
    for r in roots {
        if path.starts_with(r) {
            match best {
                Some(b) if b.components().count() >= r.components().count() => {}
                _ => best = Some(r),
            }
        }
    }
    let base = best?;
    let rel = path.strip_prefix(base).ok()?;
    let s = rel.to_string_lossy().replace('\\', "/");
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// True when any path segment is an excluded directory name.
fn is_excluded(path: &Path) -> bool {
    path.components().any(|c| {
        let n = c.as_os_str().to_string_lossy();
        EXCLUDED_DIRS.contains(&n.as_ref())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots(v: &[&str]) -> Vec<PathBuf> {
        v.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn relativize_uses_forward_slashes() {
        let r = roots(&["/proj"]);
        let got = relativize(&r, Path::new("/proj/src/a/b.rs")).unwrap();
        assert_eq!(got, "src/a/b.rs");
    }

    #[test]
    fn relativize_picks_longest_matching_root() {
        // Nested roots: the deepest one must win, because the frontend resolves
        // the relative path against the project root.
        let r = roots(&["/ws", "/ws/proj"]);
        assert_eq!(relativize(&r, Path::new("/ws/proj/a.rs")).unwrap(), "a.rs");
        assert_eq!(relativize(&r, Path::new("/ws/other.rs")).unwrap(), "other.rs");
    }

    #[test]
    fn relativize_rejects_path_outside_roots() {
        let r = roots(&["/proj"]);
        assert!(relativize(&r, Path::new("/elsewhere/a.rs")).is_none());
    }

    #[test]
    fn relativize_rejects_root_itself() {
        let r = roots(&["/proj"]);
        assert!(relativize(&r, Path::new("/proj")).is_none());
    }

    #[test]
    fn excluded_dirs_are_filtered() {
        let r = roots(&["/proj"]);
        for p in [
            "/proj/node_modules/x/index.js",
            "/proj/target/debug/app",
            "/proj/.git/HEAD",
            "/proj/src/__pycache__/a.pyc",
        ] {
            assert!(relativize(&r, Path::new(p)).is_none(), "{} should be excluded", p);
        }
    }

    #[test]
    fn visible_dot_dirs_are_not_filtered() {
        // .github is a real, user-visible directory: pruning every dot-dir would
        // silently stop reporting workflow edits (the Java kernel made this exact
        // distinction, see its registerTree comment).
        let r = roots(&["/proj"]);
        assert_eq!(
            relativize(&r, Path::new("/proj/.github/workflows/ci.yml")).unwrap(),
            ".github/workflows/ci.yml"
        );
    }

    #[test]
    fn collect_dirs_prunes_excluded_subtrees() {
        let base = std::env::temp_dir().join(format!("gwork-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("src/deep")).unwrap();
        std::fs::create_dir_all(base.join("node_modules/pkg/deeper")).unwrap();
        std::fs::create_dir_all(base.join(".git/objects")).unwrap();

        let dirs = collect_dirs(&base);
        let names: Vec<String> = dirs
            .iter()
            .map(|d| d.strip_prefix(&base).unwrap().to_string_lossy().replace('\\', "/"))
            .collect();

        assert!(names.iter().any(|n| n == "src/deep"), "src/deep must be watched: {:?}", names);
        assert!(!names.iter().any(|n| n.starts_with("node_modules")), "node_modules must be pruned: {:?}", names);
        assert!(!names.iter().any(|n| n.starts_with(".git")), ".git must be pruned: {:?}", names);

        let _ = std::fs::remove_dir_all(&base);
    }
}
