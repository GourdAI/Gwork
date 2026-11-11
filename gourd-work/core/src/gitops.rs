//! gitops — Git operations via the `git` CLI.
//!
//! Mirrors the Java kernel's `GitService` **response shapes**, not just its
//! behaviour: the frontend was written against those shapes, so a differently
//! named field is indistinguishable from a missing one.
//!
//! ## Field-shape parity is the contract
//!
//! An earlier version of this module returned `{ok, entries, count}` from
//! `status` and `{ok, remotes}` from `remote`. The frontend reads
//! `data.gitAvailable`, `data.initialized`, `data.branch`, `data.files` and
//! (for the remote panel) `data.hasRemote` — every one of those was
//! `undefined`, so the Git panel rendered "git unavailable" on a perfectly
//! healthy repository. Renaming the fields back is the fix; see each function
//! for the Java field list it reproduces.
//!
//! ## Why every spawn hides its console window
//!
//! `git.exe` is a console-subsystem binary. This kernel runs as a GUI process
//! (no console attached), so every spawn without `CREATE_NO_WINDOW` makes
//! Windows allocate a **visible black console window** for the child — and
//! the frontend polls `git/status` + `git/remote` on a timer, so users saw a
//! black window flash on top of the app every few seconds. The Java kernel
//! never had this problem because the JVM is itself a console-attached host
//! for `Runtime.exec`; a GUI host must opt out explicitly.
//!
//! `GIT_TERMINAL_PROMPT=0` is injected for the same reason the Java kernel
//! injects it: without it a remote operation on a repository whose credentials
//! are unavailable blocks waiting for a username nobody can type.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// Run a blocking closure **off** the async worker thread.
///
/// WHY THIS EXISTS (measured, not guessed): every function in this module is
/// synchronous and is called directly from `async` axum handlers
/// (`server/git_api.rs`). `Command::output()` blocks the calling thread for the
/// whole lifetime of the child — and on Windows a bare `git --version` costs
/// **74.8 ms median** (measured with `execFileSync`, 15 samples), `git status
/// --porcelain` **97.5 ms**. Blocking a tokio worker for that long starves every
/// other task scheduled on it.
///
/// Measured consequence before this offload existed: with 8 concurrent
/// `git/status` requests in flight, the completely unrelated `/web/chat/meta`
/// endpoint went from **0.23 ms to 85.85 ms** — a 373x degradation of an
/// endpoint that does no I/O at all. That is the same failure mode the
/// `usage/stats` scan had (1 ms → 2178 ms), and it is why this is a P0 rather
/// than a local slowness.
///
/// `block_in_place` is used instead of `spawn_blocking` because the public API of
/// this module is synchronous and its callers (`git_api.rs`) are not ours to
/// change: `block_in_place` hands the worker's core to a replacement thread and
/// then blocks *this* thread, so no signature has to become `async`.
///
/// It panics on a `current_thread` runtime (there is no core to hand off), so the
/// flavour is checked first and the closure runs inline otherwise — which is
/// exactly the pre-existing behaviour, i.e. unit tests and the CLI's non-server
/// paths are unaffected.
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

/// Process-wide memo of `git --version` succeeding.
///
/// WHY: `git_available()` is the first call of both `status()` and `remote()`,
/// and the frontend polls those two on a timer. The answer cannot change during
/// the life of the process (the `git` binary on `PATH` is fixed at spawn time),
/// yet each probe costs a full **74.8 ms** process creation on Windows — the most
/// expensive single call in the module, spent on a question whose answer is a
/// constant. Caching it removes one spawn per poll from both endpoints.
///
/// Only the positive result is cached: a machine where git is installed *after*
/// the kernel started must still start working without a restart.
static GIT_AVAILABLE: AtomicBool = AtomicBool::new(false);

/// Hide the console window for child processes on Windows (same value as
/// `terminal.rs`).
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Java's `REV_COUNT_UNKNOWN`: ahead/behind use `-1` rather than null so the
/// field is always present and the frontend never has to test `undefined`.
const REV_COUNT_UNKNOWN: i64 = -1;

/// One git invocation: stdout, stderr and exit code (Java's `ProcessResult`).
pub struct GitOut {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl GitOut {
    pub fn ok(&self) -> bool {
        self.code == 0
    }
    /// stderr, falling back to stdout when stderr is empty — the Java kernel
    /// does the same when reporting a failed commit, because some git versions
    /// write the useful diagnostic to stdout.
    pub fn message(&self) -> String {
        let e = self.stderr.trim();
        if !e.is_empty() {
            return e.to_string();
        }
        self.stdout.trim().to_string()
    }
}

/// Run a git command in the given repo root.
///
/// A spawn failure is reported as exit code `-1` (matching Java's timeout
/// sentinel) rather than propagated, so every caller can use the same
/// `if !out.ok()` degrade path instead of handling `Result` and panics
/// separately.
pub fn git(repo: &Path, args: &[&str]) -> GitOut {
    // `repo` and `args` are borrowed, so they have to be copied into the closure:
    // `block_in_place` runs it on this same thread, but the `'static`-free
    // signature still needs owned data for the `FnOnce`.
    let repo = repo.to_path_buf();
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    offload(move || {
        let mut cmd = Command::new("git");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        // Never let a child block on a credential prompt (Java parity).
        cmd.env("GIT_TERMINAL_PROMPT", "0");

        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        match cmd.args(&refs).current_dir(&repo).output() {
            Ok(o) => GitOut {
                code: o.status.code().unwrap_or(-1),
                // git on a legacy Chinese Windows install prints GBK messages
                // (e.g. 「致命错误」); lossy UTF-8 rendered them as blocks.
                //
                // ANSI too: git colourises when it thinks a terminal is attached
                // and the repo has `color.ui = always`. `message()` feeds these
                // strings straight into JSON error payloads the UI renders, so a
                // colour code would show up as literal `[31m` text.
                stdout: crate::textcodec::strip_ansi(&crate::textcodec::decode_bytes(&o.stdout)),
                stderr: crate::textcodec::strip_ansi(&crate::textcodec::decode_bytes(&o.stderr)),
            },
            Err(e) => GitOut {
                code: -1,
                stdout: String::new(),
                stderr: format!("git spawn failed: {}", e),
            },
        }
    })
}

/// Whether the git binary itself is available (Java: `git --version`).
///
/// Memoized process-wide — see `GIT_AVAILABLE` for the measured cost this saves.
pub fn git_available(repo: &Path) -> bool {
    if GIT_AVAILABLE.load(Ordering::Relaxed) {
        return true;
    }
    let ok = git(repo, &["--version"]).ok();
    if ok {
        GIT_AVAILABLE.store(true, Ordering::Relaxed);
    }
    ok
}

/// Branch + upstream + ahead/behind + working-tree state from **one** git call.
///
/// WHY THIS EXISTS (measured): `status()` used to spawn git four times in series
/// (`--version`, `rev-parse --is-inside-work-tree`, `branch --show-current`,
/// `status --porcelain=v1`) and `remote()` five times. On Windows each spawn costs
/// 62–97 ms of pure process-creation overhead, so the endpoints measured
/// **913.4 ms** (`git/status`) and **1024.6 ms** (`git/remote`) against the Java
/// kernel's 432.2 ms and 478.8 ms — the Rust kernel was roughly 2x *slower*,
/// which is the opposite of the reason to port it.
///
/// `git status --porcelain=v1 --branch` returns all of it in one shot: a leading
/// `## <branch>...<upstream> [ahead N, behind M]` header followed by the ordinary
/// porcelain rows. Verified against the four shapes git actually emits:
///   * `## main...origin/main`            — normal branch with upstream
///   * `## HEAD (no branch)`              — detached HEAD
///   * `## No commits yet on main`        — freshly initialized repository
///   * exit code 128, no `##` line        — not a repository at all
///
/// Merging the calls is what brings the endpoint under the Java baseline; the
/// `offload` in `git()` is what stops it from taking the rest of the server down
/// while it does so.
struct BranchStatus {
    /// git exited non-zero → the directory is not a work tree.
    is_repo: bool,
    /// Branch name, or `None` when detached / unborn.
    branch: Option<String>,
    /// Upstream ref (`origin/main`), when configured.
    upstream: Option<String>,
    ahead: i64,
    behind: i64,
    /// Porcelain rows with the `##` header already stripped.
    porcelain: String,
}

fn branch_status(repo: &Path) -> BranchStatus {
    let out = git(repo, &["status", "--porcelain=v1", "--branch"]);
    if !out.ok() {
        return BranchStatus {
            is_repo: false,
            branch: None,
            upstream: None,
            ahead: REV_COUNT_UNKNOWN,
            behind: REV_COUNT_UNKNOWN,
            porcelain: String::new(),
        };
    }
    let mut branch = None;
    let mut upstream = None;
    let mut ahead = REV_COUNT_UNKNOWN;
    let mut behind = REV_COUNT_UNKNOWN;
    let mut body: Vec<&str> = Vec::new();

    for (i, line) in out.stdout.lines().enumerate() {
        if i == 0 && line.starts_with("## ") {
            let (b, u, a, bh) = parse_branch_header(line);
            branch = b;
            upstream = u;
            ahead = a;
            behind = bh;
            continue;
        }
        body.push(line);
    }
    BranchStatus {
        is_repo: true,
        branch,
        upstream,
        ahead,
        behind,
        porcelain: body.join("\n"),
    }
}

/// Parse the `## ` header line of `git status --porcelain=v1 --branch`.
///
/// Pure function so every observed shape is unit-testable without a repository.
/// Returns `(branch, upstream, ahead, behind)`; counts stay `REV_COUNT_UNKNOWN`
/// unless git actually reported them, matching the old `rev-list` path.
fn parse_branch_header(line: &str) -> (Option<String>, Option<String>, i64, i64) {
    let head = line.trim_start_matches('#').trim_start_matches('#').trim();

    // Split off the "[ahead 1, behind 2]" trailer first.
    let (refs_part, counts_part) = match head.find('[') {
        Some(i) if head.ends_with(']') => (&head[..i], Some(&head[i + 1..head.len() - 1])),
        _ => (head, None),
    };

    let (branch, upstream) = match refs_part.split_once("...") {
        Some((b, u)) => {
            let b = b.trim();
            let u = u.trim();
            (
                if b.is_empty() || b == "HEAD" { None } else { Some(b.to_string()) },
                if u.is_empty() { None } else { Some(u.to_string()) },
            )
        }
        None => {
            // "No commits yet on main" / "HEAD (no branch)" / bare "main"
            let b = refs_part.trim();
            let b = b.strip_prefix("No commits yet on ").unwrap_or(b);
            let b = b.trim();
            if b.is_empty() || b == "HEAD" || b.starts_with("(no branch)") || b.contains("(no branch)") {
                (None, None)
            } else {
                (Some(b.to_string()), None)
            }
        }
    };

    let mut ahead = REV_COUNT_UNKNOWN;
    let mut behind = REV_COUNT_UNKNOWN;
    if let Some(c) = counts_part {
        // git prints "ahead 1", "behind 2" or "ahead 1, behind 2".
        ahead = 0;
        behind = 0;
        for part in c.split(',') {
            let mut it = part.trim().split_whitespace();
            match (it.next(), it.next().and_then(|n| n.parse::<i64>().ok())) {
                (Some("ahead"), Some(n)) => ahead = n,
                (Some("behind"), Some(n)) => behind = n,
                _ => {}
            }
        }
    }
    (branch, upstream, ahead, behind)
}

/// Whether the directory is inside a git work tree.
///
/// Memoized per repository, positive results only. `stage`, `unstage` and
/// `commit` each call this as a pre-check, and on Windows the `git rev-parse`
/// spawn costs 62–97 ms of pure process creation — a delay the user feels
/// directly on the "stage" / "commit" click. A directory that *is* a repository
/// stays one for the life of the process, so the positive answer is safe to cache.
///
/// The negative answer is deliberately **not** cached: `git init` turns a
/// non-repository into one without a restart, and [`init`] also clears this cache
/// explicitly. Caching only the positive mirrors [`GIT_AVAILABLE`]'s reasoning.
static REPO_CACHE: once_cell::sync::Lazy<Mutex<HashMap<PathBuf, bool>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));

pub fn is_repo(repo: &Path) -> bool {
    let key = repo.to_path_buf();
    if let Ok(cache) = REPO_CACHE.lock() {
        if let Some(&hit) = cache.get(&key) {
            return hit;
        }
    }
    let result = git(repo, &["rev-parse", "--is-inside-work-tree"])
        .stdout
        .trim()
        == "true";
    if result {
        if let Ok(mut cache) = REPO_CACHE.lock() {
            cache.insert(key, true);
        }
    }
    result
}

/// Drop a repository from the [`is_repo`] memo. Called after [`init`] succeeds so
/// a freshly created repository is seen without a restart.
fn invalidate_repo_cache(repo: &Path) {
    if let Ok(mut cache) = REPO_CACHE.lock() {
        cache.remove(repo);
    }
}

/// Current branch name, or `"master"` when detached/empty (Java parity).
pub fn branch(repo: &Path) -> String {
    let b = git(repo, &["branch", "--show-current"]).stdout.trim().to_string();
    if b.is_empty() {
        "master".into()
    } else {
        b
    }
}

/// One per-file entry of `git status --porcelain` (Java's `fileEntry`).
///
/// `status` is the *bucket* that decides which action button the row gets
/// (`S` = staged → offer "unstage", `M` = working-tree only → offer "stage",
/// `?` = untracked → offer "add to git"); `type` is the *change kind* that
/// decides the row icon (`A`dded / `D`eleted / `M`odified / `U`ntracked).
/// Conflating the two was the reason an earlier shape could not drive the UI.
#[derive(Debug, PartialEq)]
pub struct FileEntry {
    pub path: String,
    pub status: String,
    pub entry_type: String,
}

/// Parse `git status --porcelain=v1` output into Java's four buckets.
///
/// Returns `(changed, staged, untracked, files)`. Pure function so it can be
/// unit-tested against recorded porcelain output without touching a repo.
pub fn parse_porcelain(out: &str) -> (Vec<String>, Vec<String>, Vec<String>, Vec<FileEntry>) {
    let mut changed = Vec::new();
    let mut staged = Vec::new();
    let mut untracked = Vec::new();
    let mut files = Vec::new();

    for raw in out.lines() {
        // Porcelain v1 columns: `XY path` (XY is 2 chars, then one space).
        if raw.len() < 4 {
            continue;
        }
        let chars: Vec<char> = raw.chars().collect();
        let x = chars[0].to_string();
        let y = chars[1].to_string();
        let mut path: String = chars[3..].iter().collect();
        // Directories are reported with a trailing slash; the frontend keys its
        // rows by path, so normalize before bucketing.
        if path.ends_with('/') {
            path.pop();
        }

        if x == "?" && y == "?" {
            untracked.push(path.clone());
            files.push(FileEntry { path, status: "?".into(), entry_type: "U".into() });
            continue;
        }

        let x_set = x != " " && x != "?";
        let y_set = y != " " && y != "?";
        if x_set {
            staged.push(path.clone());
        }
        if y_set {
            changed.push(path.clone());
        }

        // Change kind: A(dded) / D(eleted) win over everything else (including
        // R(enamed) and T(ypechange), which the UI renders as modified).
        let entry_type = if x == "A" || y == "A" {
            "A"
        } else if x == "D" || y == "D" {
            "D"
        } else {
            "M"
        };
        // Bucket: staged changes are actionable as "unstage", otherwise "stage".
        let status = if x_set { "S" } else { "M" };
        files.push(FileEntry { path, status: status.into(), entry_type: entry_type.into() });
    }
    (changed, staged, untracked, files)
}

/// Git status detection.
///
/// Returns Java's field set inside the standard envelope:
/// `{code:200, data:{gitAvailable, initialized, branch, changed, staged,
/// untracked, files}}`, plus `workspacePath` when the directory is not a
/// repository (the frontend shows an "initialize repository" affordance there).
///
/// **Degrades rather than errors**: no git binary and "not a repository" both
/// answer `code:200` with `gitAvailable`/`initialized` false, because that is a
/// normal state of the world the panel renders — not a failure. Only the
/// caller's path validation produces a 4xx.
pub fn status(repo: &Path) -> serde_json::Value {
    let mut data = serde_json::Map::new();

    // 1. git availability (memoized — see `GIT_AVAILABLE`)
    if !git_available(repo) {
        data.insert("gitAvailable".into(), serde_json::json!(false));
        data.insert("initialized".into(), serde_json::json!(false));
        return serde_json::json!({ "code": 200, "data": data });
    }
    data.insert("gitAvailable".into(), serde_json::json!(true));

    // 2–4 in ONE spawn: repository check, branch and porcelain rows all come from
    // `status --porcelain=v1 --branch`. This replaced three separate git calls
    // (`rev-parse --is-inside-work-tree`, `branch --show-current`,
    // `status --porcelain=v1`); see `branch_status` for the measured cost.
    let bs = branch_status(repo);
    if !bs.is_repo {
        data.insert("initialized".into(), serde_json::json!(false));
        data.insert(
            "workspacePath".into(),
            serde_json::json!(repo.display().to_string()),
        );
        return serde_json::json!({ "code": 200, "data": data });
    }
    data.insert("initialized".into(), serde_json::json!(true));

    // `branch()` fell back to "master" for a detached/unborn HEAD; keep that exact
    // wire value so the panel does not start rendering an empty branch chip.
    data.insert(
        "branch".into(),
        serde_json::json!(bs.branch.clone().unwrap_or_else(|| "master".into())),
    );

    let (changed, staged, untracked, files) = parse_porcelain(&bs.porcelain);
    data.insert("changed".into(), serde_json::json!(changed));
    data.insert("staged".into(), serde_json::json!(staged));
    data.insert("untracked".into(), serde_json::json!(untracked));
    data.insert(
        "files".into(),
        serde_json::json!(files
            .iter()
            .map(|f| serde_json::json!({
                "path": f.path,
                "status": f.status,
                "type": f.entry_type,
            }))
            .collect::<Vec<_>>()),
    );

    // Line-level insertions/deletions (`git diff HEAD --numstat`): the monitor
    // panel's env row renders a coloured "+N -M" per the reference design. The
    // porcelain buckets only carry file counts, so the line totals need their
    // own aggregation. `HEAD` covers staged + unstaged (baseline = last commit);
    // untracked files are outside the HEAD comparison and git emits no line
    // counts for them — same scope as PR/review statistics. Degradation matches
    // `remote()`: any failure WARNs and yields 0 rather than failing the call.
    let (additions, deletions) = line_stats(repo);
    data.insert("additions".into(), serde_json::json!(additions));
    data.insert("deletions".into(), serde_json::json!(deletions));

    serde_json::json!({ "code": 200, "data": data })
}

/// Aggregate `git diff HEAD --numstat` into `(additions, deletions)`.
///
/// Degradation mirrors Java's `GitService.lineStats()`: a failed spawn or a
/// non-zero exit only yields `(0, 0)` — the read-only panel simply omits the
/// "+/-" figures instead of turning the whole section into an error.
fn line_stats(repo: &Path) -> (i64, i64) {
    let out = git(repo, &["diff", "HEAD", "--numstat"]);
    if !out.ok() {
        return (0, 0);
    }
    parse_numstat(&out.stdout)
}

/// Parse `git diff HEAD --numstat` output into `(additions, deletions)`.
///
/// Pure function so every observed shape is unit-testable without a repository
/// (same discipline as [`parse_porcelain`]). Each line is `<add>\t<del>\t<path>`;
/// binary files print `-\t-\t<path>` and count as 0 (GitHub's convention for
/// binaries). Rename rows carry tabs inside the path segment, but only the
/// first two columns are read, so they are unaffected.
pub fn parse_numstat(out: &str) -> (i64, i64) {
    let mut additions = 0i64;
    let mut deletions = 0i64;
    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut it = line.split('\t');
        let add = it.next();
        let del = it.next();
        // Fewer than two columns is not a numstat row at all (Java skips
        // `parts.length < 2` the same way); counting it would inflate totals.
        if del.is_none() {
            continue;
        }
        additions += numstat_count(add);
        deletions += numstat_count(del);
    }
    (additions, deletions)
}

/// One numstat count column: `-` (binary) and malformed values count as 0;
/// negatives cannot occur and are clamped for the same reason.
fn numstat_count(token: Option<&str>) -> i64 {
    match token.map(str::trim) {
        None => 0,
        Some(t) if t.is_empty() || t == "-" => 0,
        Some(t) => t.parse::<i64>().map(|v| v.max(0)).unwrap_or(0),
    }
}

/// Remote / upstream sync state (read-only; never fetches).
///
/// Returns Java's field set: `{gitAvailable, hasRemote, remoteUrl, upstream,
/// ahead, behind, degraded}`. `degraded=true` means "this payload may be
/// incomplete" (no upstream, or unparsable counts) — the panel then says
/// "not initialized" instead of "no remote", which is a different situation.
pub fn remote(repo: &Path) -> serde_json::Value {
    let mut data = serde_json::Map::new();
    data.insert("gitAvailable".into(), serde_json::json!(false));
    data.insert("hasRemote".into(), serde_json::json!(false));
    data.insert("remoteUrl".into(), serde_json::Value::Null);
    data.insert("upstream".into(), serde_json::Value::Null);
    data.insert("ahead".into(), serde_json::json!(REV_COUNT_UNKNOWN));
    data.insert("behind".into(), serde_json::json!(REV_COUNT_UNKNOWN));
    data.insert("degraded".into(), serde_json::json!(false));

    if !git_available(repo) {
        return serde_json::json!({ "code": 200, "data": data });
    }
    data.insert("gitAvailable".into(), serde_json::json!(true));

    // ONE spawn yields repo-check + upstream + ahead/behind. This replaced
    // `rev-parse --is-inside-work-tree`, `rev-parse --abbrev-ref @{u}` and
    // `rev-list --left-right --count @{u}...HEAD`; only `remote -v` (the URL,
    // which porcelain does not report) is still a separate call. 5 spawns → 2.
    let bs = branch_status(repo);
    if !bs.is_repo {
        data.insert("degraded".into(), serde_json::json!(true));
        return serde_json::json!({ "code": 200, "data": data });
    }
    // No upstream (detached HEAD, or a branch that never tracked anything) is the
    // same "payload may be incomplete" state the old `rev-parse @{u}` failure
    // produced, so it keeps setting `degraded`.
    let mut degraded = bs.upstream.is_none();

    // Remote URL. "No remote configured" is a normal state, not an error.
    let url = parse_remote_url(&git(repo, &["remote", "-v"]).stdout);
    data.insert("hasRemote".into(), serde_json::json!(url.is_some()));
    data.insert(
        "remoteUrl".into(),
        url.as_ref().map(|u| serde_json::json!(u)).unwrap_or(serde_json::Value::Null),
    );

    data.insert(
        "upstream".into(),
        bs.upstream.as_ref().map(|u| serde_json::json!(u)).unwrap_or(serde_json::Value::Null),
    );

    // Ahead/behind only mean something once there is an upstream.
    if bs.upstream.is_some() {
        if bs.ahead != REV_COUNT_UNKNOWN && bs.behind != REV_COUNT_UNKNOWN {
            data.insert("behind".into(), serde_json::json!(bs.behind));
            data.insert("ahead".into(), serde_json::json!(bs.ahead));
        } else {
            degraded = true;
        }
    }

    data.insert("degraded".into(), serde_json::json!(degraded));
    serde_json::json!({ "code": 200, "data": data })
}

/// Pick the fetch URL out of `git remote -v` output (Java's `parseRemoteUrl`).
///
/// Lines look like `origin<TAB>https://… (fetch)`. The `(fetch)` line wins;
/// the first parseable line is kept as a fallback so a remote configured with
/// only a push URL still shows up.
pub fn parse_remote_url(out: &str) -> Option<String> {
    let mut fallback: Option<String> = None;
    for raw in out.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let url = remote_url_of_line(line)?;
        if fallback.is_none() {
            fallback = Some(url.clone());
        }
        if line.ends_with("(fetch)") {
            return Some(url);
        }
    }
    fallback
}

/// Extract the URL from a single `git remote -v` line, or None if malformed.
fn remote_url_of_line(line: &str) -> Option<String> {
    // Strip the trailing "(fetch)" / "(push)" marker.
    let body = match line.rfind('(') {
        Some(paren) if paren > 0 && line.ends_with(')') => line[..paren].trim(),
        _ => line,
    };
    // Preferred separator is a tab; some git versions/configurations use spaces.
    let rest: String = if let Some(tab) = body.find('\t') {
        body[tab + 1..].trim().to_string()
    } else {
        // "name url [marker]" → drop the first whitespace-delimited token.
        let mut it = body.split_whitespace();
        it.next();
        it.collect::<Vec<_>>().join(" ")
    };
    let rest = rest.trim();
    if rest.is_empty() {
        None
    } else {
        Some(rest.to_string())
    }
}

/// Parse `git rev-list --left-right --count` output: `"<behind>\t<ahead>"`.
///
/// Left of `...` is the upstream side, so the first number is how many commits
/// we are **behind**. Returns None when the output is not two integers.
pub fn parse_ahead_behind(out: &str) -> Option<(i64, i64)> {
    let parts: Vec<&str> = out.trim().split_whitespace().collect();
    if parts.len() < 2 {
        return None;
    }
    let behind = parts[0].parse::<i64>().ok()?;
    let ahead = parts[1].parse::<i64>().ok()?;
    Some((behind, ahead))
}

/// Reject paths that could escape the repository (Java's guard).
fn is_safe_path(path: &str) -> bool {
    !path.trim().is_empty() && !path.contains("..") && !path.starts_with('/')
}

/// Stage one path (`git add -- path`).
///
/// Returns Java's `{code, data:{path}}` / `{code, description}` shape rather
/// than a bare `{ok}` so the frontend's `res.data.message` error path and its
/// row refresh both work.
pub fn stage(repo: &Path, path: &str) -> serde_json::Value {
    if !is_repo(repo) {
        return failure(400, "Not a git repository");
    }
    if !is_safe_path(path) {
        return failure(400, "Invalid path");
    }
    let out = git(repo, &["add", "--", path]);
    if !out.ok() {
        return failure(500, &format!("git add failed: {}", out.message()));
    }
    serde_json::json!({ "code": 200, "data": { "path": path } })
}

/// Unstage one path.
///
/// Uses `git reset HEAD -- path`, the Java kernel's choice. `git restore
/// --staged` is the modern spelling but is absent from git < 2.23, and this
/// kernel must work on whatever git the user has.
pub fn unstage(repo: &Path, path: &str) -> serde_json::Value {
    if !is_repo(repo) {
        return failure(400, "Not a git repository");
    }
    if !is_safe_path(path) {
        return failure(400, "Invalid path");
    }
    let out = git(repo, &["reset", "HEAD", "--", path]);
    if !out.ok() {
        return failure(500, &format!("git reset failed: {}", out.message()));
    }
    serde_json::json!({ "code": 200, "data": { "path": path } })
}

/// Commit. When `files` is non-empty the index is reset first so that
/// previously-staged but unselected files are **not** swept into the commit
/// (Java does the same; silently committing extra files is worse than the extra
/// `git reset`).
pub fn commit(repo: &Path, message: &str, files: &[String]) -> serde_json::Value {
    if !is_repo(repo) {
        return failure(400, "Not a git repository");
    }
    if message.trim().is_empty() {
        return failure(400, "Commit message is required");
    }

    let add = if files.is_empty() {
        git(repo, &["add", "-A"])
    } else {
        // Clear the index, then stage exactly the selected paths.
        let _ = git(repo, &["reset", "HEAD", "--"]);
        let mut args: Vec<String> = vec!["add".into(), "--".into()];
        args.extend(files.iter().cloned());
        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        git(repo, &refs)
    };
    if !add.ok() {
        return failure(500, &format!("git add failed: {}", add.message()));
    }

    // Identity is supplied per-invocation: the kernel must not depend on a
    // global git config the user may never have set (Java parity).
    let out = git(
        repo,
        &[
            "-c",
            "user.name=GWork",
            "-c",
            "user.email=gourdai@noear.org",
            "commit",
            "-m",
            message.trim(),
        ],
    );
    if !out.ok() {
        return failure(500, &format!("git commit failed: {}", out.message()));
    }
    serde_json::json!({ "code": 200, "data": { "stdout": out.stdout.trim() } })
}

/// `git diff` (optionally staged, optionally for a path).
pub fn diff(repo: &Path, staged: bool, path: Option<&str>) -> serde_json::Value {
    let mut args: Vec<String> = vec!["diff".into()];
    if staged {
        args.push("--cached".into());
    }
    if let Some(p) = path {
        args.push("--".into());
        args.push(p.to_string());
    }
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let out = git(repo, &refs);
    serde_json::json!({
        "code": 200,
        "data": { "diff": out.stdout, "ok": out.ok(), "error": out.message() }
    })
}

/// `git log` history (last N commits).
///
/// Kept for the history view. **Not** the `/web/chat/git/summary` endpoint —
/// that one asks an LLM to write a commit message and lives in `server::git_api`.
pub fn log(repo: &Path, limit: usize) -> serde_json::Value {
    let n = format!("-{}", limit.max(1));
    let out = git(repo, &["log", &n, "--pretty=format:%H%x09%an%x09%ad%x09%s", "--date=iso"]);
    if !out.ok() {
        return serde_json::json!({ "code": 200, "data": { "ok": false, "error": out.message(), "commits": [] } });
    }
    let commits: Vec<serde_json::Value> = out
        .stdout
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 4 {
                Some(serde_json::json!({
                    "hash": parts[0],
                    "author": parts[1],
                    "date": parts[2],
                    "message": parts[3..].join("\t"),
                }))
            } else {
                None
            }
        })
        .collect();
    serde_json::json!({ "code": 200, "data": { "ok": true, "commits": commits } })
}

/// Initialize a repository (optionally with an initial commit).
pub fn init(repo: &Path, initial_commit: bool) -> serde_json::Value {
    let out = git(repo, &["init"]);
    if !out.ok() {
        return failure(500, &format!("git init failed: {}", out.message()));
    }
    // The directory just became a repository; drop any stale negative memo so the
    // next `is_repo` sees it without a restart.
    invalidate_repo_cache(repo);
    if initial_commit {
        let _ = git(repo, &["add", "-A"]);
        let _ = git(
            repo,
            &[
                "-c",
                "user.name=GWork",
                "-c",
                "user.email=gourdai@noear.org",
                "commit",
                "-m",
                "Initial commit",
                "--allow-empty",
            ],
        );
    }
    serde_json::json!({ "code": 200, "data": { "initialized": true } })
}

/// Read a file's content at a given ref (`git show ref:path`).
pub fn file_content(repo: &Path, path: &str, git_ref: &str) -> serde_json::Value {
    if !is_safe_path(path) {
        return failure(400, "Invalid path");
    }
    let git_ref = if git_ref.trim().is_empty() { "HEAD" } else { git_ref };
    let spec = format!("{}:{}", git_ref, path);
    let out = git(repo, &["show", &spec]);
    if !out.ok() {
        return failure(404, &format!("File not found: {}", out.message()));
    }
    serde_json::json!({ "code": 200, "data": { "content": out.stdout } })
}

/// Collect the combined diff for a set of files, with Java's truncation rules:
/// at most 15 files, 500 lines each, 20 000 characters total.
///
/// Returns `(combined_diff, stat_info)`. The caps exist because this text is
/// fed to an LLM to write a commit message — an uncapped diff would blow the
/// context window on a large refactor and cost real money for no better summary.
///
/// The cap is applied **before** the path-safety filter, exactly as the Java
/// kernel does (`subList(0, 15)` then `continue` on unsafe entries inside the
/// loop). That ordering is what keeps the "（仅前 15 个）" note honest: it means
/// "the selection was truncated by the cap", never "some paths were dropped as
/// unsafe". Filtering first would make the note fire on a 3-file selection that
/// merely contained one traversal attempt.
pub fn collect_diff_for_summary(repo: &Path, files: &[String]) -> (String, String) {
    const MAX_FILES: usize = 15;
    const MAX_DIFF_LINES: usize = 500;
    const MAX_TOTAL_CHARS: usize = 20_000;

    let target: Vec<&String> = files.iter().take(MAX_FILES).collect();
    let mut combined = String::new();

    for path in &target {
        // Unsafe paths contribute no diff but still count toward the reported
        // selection size (Java parity — see the note above).
        if !is_safe_path(path) {
            continue;
        }
        let work = git(repo, &["diff", "--", path]).stdout;
        let cached = git(repo, &["diff", "--cached", "--", path]).stdout;
        let mut diff = work;
        if !cached.trim().is_empty() {
            diff.push('\n');
            diff.push_str(&cached);
        }
        if diff.trim().is_empty() {
            diff = "(无差异内容)".into();
        }
        let lines: Vec<&str> = diff.lines().collect();
        let diff = if lines.len() > MAX_DIFF_LINES {
            format!("{}\n... (已截断)", lines[..MAX_DIFF_LINES].join("\n"))
        } else {
            diff
        };
        combined.push_str(&format!("\n\n=== {} ===\n{}", path, diff));
    }

    // Character cap: operate on char boundaries, never slice a UTF-8 string at
    // a byte offset (Chinese diff content would panic).
    if combined.chars().count() > MAX_TOTAL_CHARS {
        let head: String = combined.chars().take(MAX_TOTAL_CHARS).collect();
        combined = head + "\n\n... (总差异过大，已截断)";
    }

    let stat = format!(
        "{} 个文件{}",
        target.len(),
        if target.len() < files.len() { "（仅前 15 个）" } else { "" }
    );
    (combined, stat)
}

/// Strip the Markdown decoration an LLM tends to wrap a commit message in
/// (Java does the same post-processing before handing the text to the input box).
pub fn clean_summary(raw: &str) -> String {
    let mut s = raw.replace("**", "").replace('*', "").replace('`', "");
    // Drop a leading Markdown heading marker ("# ", "## ", ...).
    let trimmed = s.trim_start();
    if let Some(rest) = trimmed.strip_prefix('#') {
        let rest = rest.trim_start_matches('#');
        s = rest.trim_start().to_string();
    }
    s.trim().to_string()
}

/// Error envelope matching the Java kernel's `Result.failure(code, msg)`.
fn failure(code: i64, msg: &str) -> serde_json::Value {
    serde_json::json!({ "code": code, "description": msg })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_untracked_goes_to_its_own_bucket() {
        let (changed, staged, untracked, files) = parse_porcelain("?? new-file.rs\n");
        assert_eq!(untracked, vec!["new-file.rs"]);
        assert!(changed.is_empty());
        assert!(staged.is_empty());
        assert_eq!(files[0].status, "?");
        assert_eq!(files[0].entry_type, "U");
    }

    #[test]
    fn porcelain_staged_and_worktree_changes_are_bucketed_separately() {
        // `M ` = staged modification only; ` M` = worktree modification only.
        let (changed, staged, _, files) = parse_porcelain("M  staged.rs\n M dirty.rs\n");
        assert_eq!(staged, vec!["staged.rs"]);
        assert_eq!(changed, vec!["dirty.rs"]);
        assert_eq!(files[0].status, "S", "staged row offers 'unstage'");
        assert_eq!(files[1].status, "M", "worktree row offers 'stage'");
    }

    #[test]
    fn porcelain_both_sides_changed_appears_in_both_buckets() {
        let (changed, staged, _, _) = parse_porcelain("MM both.rs\n");
        assert_eq!(staged, vec!["both.rs"]);
        assert_eq!(changed, vec!["both.rs"]);
    }

    #[test]
    fn porcelain_change_type_prefers_added_and_deleted() {
        let (_, _, _, files) = parse_porcelain("A  added.rs\nD  gone.rs\nR  renamed.rs\n");
        assert_eq!(files[0].entry_type, "A");
        assert_eq!(files[1].entry_type, "D");
        assert_eq!(files[2].entry_type, "M", "renamed renders as modified");
    }

    #[test]
    fn porcelain_directory_trailing_slash_is_normalized() {
        let (_, _, untracked, files) = parse_porcelain("?? newdir/\n");
        assert_eq!(untracked, vec!["newdir"]);
        assert_eq!(files[0].path, "newdir");
    }

    #[test]
    fn porcelain_ignores_short_and_blank_lines() {
        let (_, _, _, files) = parse_porcelain("\nab\n");
        assert!(files.is_empty());
    }

    #[test]
    fn numstat_sums_additions_and_deletions() {
        let out = "3\t1\tsrc/a.rs\n10\t20\tsrc/b.rs\n";
        assert_eq!(parse_numstat(out), (13, 21));
    }

    #[test]
    fn numstat_binary_dash_counts_as_zero() {
        // Binary files print "-\t-\t<path>"; GitHub shows no line counts for them.
        let out = "-\t-\tassets/logo.png\n4\t0\tsrc/c.rs\n";
        assert_eq!(parse_numstat(out), (4, 0));
    }

    #[test]
    fn numstat_rename_row_with_tabs_in_path_only_reads_first_two_columns() {
        let out = "2\t2\told.rs => new.rs\n";
        assert_eq!(parse_numstat(out), (2, 2));
    }

    #[test]
    fn numstat_ignores_blank_and_malformed_lines() {
        let out = "\ngarbage\n7\n5\t6\tsrc/d.rs\n";
        assert_eq!(parse_numstat(out), (5, 6));
    }

    #[test]
    fn numstat_empty_output_is_zero_zero() {
        assert_eq!(parse_numstat(""), (0, 0));
    }

    #[test]
    fn remote_url_prefers_the_fetch_line() {
        let out = "origin\thttps://example.com/repo.git (push)\norigin\thttps://example.com/repo.git (fetch)\n";
        assert_eq!(
            parse_remote_url(out),
            Some("https://example.com/repo.git".to_string())
        );
    }

    #[test]
    fn remote_url_falls_back_when_only_push_exists() {
        let out = "origin\tgit@github.com:a/b.git (push)\n";
        assert_eq!(parse_remote_url(out), Some("git@github.com:a/b.git".to_string()));
    }

    #[test]
    fn remote_url_space_separated_variant_is_parsed() {
        let out = "origin https://example.com/r.git (fetch)\n";
        assert_eq!(parse_remote_url(out), Some("https://example.com/r.git".to_string()));
    }

    #[test]
    fn remote_url_absent_yields_none() {
        assert_eq!(parse_remote_url(""), None);
        assert_eq!(parse_remote_url("\n  \n"), None);
    }

    #[test]
    fn ahead_behind_parses_left_right_count() {
        // `rev-list --left-right --count @{u}...HEAD` prints "<behind>\t<ahead>".
        assert_eq!(parse_ahead_behind("3\t5\n"), Some((3, 5)));
        assert_eq!(parse_ahead_behind("0 0"), Some((0, 0)));
        assert_eq!(parse_ahead_behind("garbage"), None);
        assert_eq!(parse_ahead_behind(""), None);
    }

    #[test]
    fn path_guard_rejects_traversal_absolute_and_empty() {
        assert!(!is_safe_path(""));
        assert!(!is_safe_path("   "));
        assert!(!is_safe_path("../etc/passwd"));
        assert!(!is_safe_path("a/../b"));
        assert!(!is_safe_path("/abs/path"));
        assert!(is_safe_path("src/main.rs"));
    }

    /// Build a throwaway git repository so the guards that sit *behind* the
    /// `is_repo` check can actually be reached. Without this, every assertion
    /// about commit/stage validation would silently pass on the earlier
    /// "Not a git repository" branch and prove nothing.
    fn temp_repo(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("gwork-gitops-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let init = git(&dir, &["init"]);
        assert!(init.ok(), "git init failed: {}", init.message());
        dir
    }

    #[test]
    fn commit_requires_a_message() {
        let dir = temp_repo("commit-msg");
        let v = commit(&dir, "   ", &[]);
        assert_eq!(v["code"], 400, "got {}", v);
        assert_eq!(v["description"], "Commit message is required");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stage_rejects_path_traversal_inside_a_real_repo() {
        let dir = temp_repo("stage-traversal");
        let v = stage(&dir, "../escape.rs");
        assert_eq!(v["code"], 400, "got {}", v);
        assert_eq!(v["description"], "Invalid path");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unstage_rejects_path_traversal_inside_a_real_repo() {
        let dir = temp_repo("unstage-traversal");
        let v = unstage(&dir, "/abs.rs");
        assert_eq!(v["code"], 400, "got {}", v);
        assert_eq!(v["description"], "Invalid path");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// End-to-end on a real repo: stage a file, see it move to the staged
    /// bucket, then unstage it. This is the only test that proves the porcelain
    /// buckets and the stage/unstage commands agree with each other.
    #[test]
    fn stage_then_unstage_moves_a_file_between_buckets() {
        let dir = temp_repo("stage-cycle");
        std::fs::write(dir.join("probe.txt"), "hello").unwrap();

        let before = status(&dir);
        assert_eq!(before["data"]["gitAvailable"], true);
        assert_eq!(before["data"]["initialized"], true);
        assert_eq!(before["data"]["untracked"], serde_json::json!(["probe.txt"]));

        let staged = stage(&dir, "probe.txt");
        assert_eq!(staged["code"], 200, "got {}", staged);
        assert_eq!(staged["data"]["path"], "probe.txt");

        let mid = status(&dir);
        assert_eq!(mid["data"]["staged"], serde_json::json!(["probe.txt"]));
        assert!(mid["data"]["untracked"].as_array().unwrap().is_empty());
        let files = mid["data"]["files"].as_array().unwrap();
        assert_eq!(files[0]["status"], "S", "staged row must offer 'unstage'");
        assert_eq!(files[0]["type"], "A", "a new file is an addition");

        let unstaged = unstage(&dir, "probe.txt");
        assert_eq!(unstaged["code"], 200, "got {}", unstaged);

        let after = status(&dir);
        assert_eq!(after["data"]["untracked"], serde_json::json!(["probe.txt"]));
        assert!(after["data"]["staged"].as_array().unwrap().is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `status` on a real repo must carry every field the frontend reads; a
    /// missing key renders as `undefined` and the panel claims git is absent.
    #[test]
    fn status_payload_carries_every_field_the_frontend_reads() {
        let dir = temp_repo("status-shape");
        let v = status(&dir);
        assert_eq!(v["code"], 200);
        let d = &v["data"];
        for key in ["gitAvailable", "initialized", "branch", "changed", "staged", "untracked", "files"] {
            assert!(!d.get(key).is_none(), "missing field {}", key);
        }
        assert_eq!(d["gitAvailable"], true);
        assert_eq!(d["initialized"], true);
        assert!(!d["branch"].as_str().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A directory that is not a repository must degrade to `initialized:false`
    /// with `code:200` — the panel renders an "initialize" affordance there.
    #[test]
    fn status_on_a_non_repo_degrades_instead_of_erroring() {
        let dir = std::env::temp_dir().join(format!("gwork-gitops-nonrepo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let v = status(&dir);
        assert_eq!(v["code"], 200, "got {}", v);
        assert_eq!(v["data"]["gitAvailable"], true);
        assert_eq!(v["data"]["initialized"], false);
        assert_eq!(v["data"]["workspacePath"], serde_json::json!(dir.display().to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `remote` on a repo with no remote configured is a normal state:
    /// `hasRemote:false`, ahead/behind at the `-1` sentinel, never an error.
    #[test]
    fn remote_without_a_configured_remote_is_a_normal_state() {
        let dir = temp_repo("remote-none");
        let v = remote(&dir);
        assert_eq!(v["code"], 200);
        let d = &v["data"];
        assert_eq!(d["gitAvailable"], true);
        assert_eq!(d["hasRemote"], false);
        assert!(d["remoteUrl"].is_null());
        assert_eq!(d["ahead"], -1, "sentinel keeps the field present");
        assert_eq!(d["behind"], -1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stage_rejects_a_non_repo_dir_with_a_400_not_a_500() {
        // A temp dir is not a repository; the guard must fire before git runs.
        let tmp = std::env::temp_dir().join("gwork-gitops-not-a-repo");
        let _ = std::fs::create_dir_all(&tmp);
        let v = stage(&tmp, "some/file.rs");
        assert_eq!(v["code"], 400, "got {}", v);
        assert_eq!(v["description"], "Not a git repository");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn clean_summary_strips_markdown_decoration() {
        assert_eq!(clean_summary("**fix**: thing"), "fix: thing");
        assert_eq!(clean_summary("# Title\n\nbody"), "Title\n\nbody");
        assert_eq!(clean_summary("  spaced  "), "spaced");
        assert_eq!(clean_summary("`code`"), "code");
        // Interior asterisks used for emphasis are removed too (Java parity).
        assert_eq!(clean_summary("a *b* c"), "a b c");
    }

    #[test]
    fn collect_diff_caps_the_file_count_in_its_stat_line() {
        let files: Vec<String> = (0..20).map(|i| format!("f{}.rs", i)).collect();
        // A temp dir is not a repo, so every diff is empty; what matters here is
        // that the stat line reports the capped count and says so.
        let tmp = std::env::temp_dir();
        let (_, stat) = collect_diff_for_summary(&tmp, &files);
        assert!(stat.starts_with("15 个文件"), "got {}", stat);
        assert!(stat.contains("仅前 15 个"));
    }

    #[test]
    fn collect_diff_stat_omits_the_cap_note_when_under_the_limit() {
        let files: Vec<String> = vec!["a.rs".into(), "b.rs".into()];
        let tmp = std::env::temp_dir();
        let (_, stat) = collect_diff_for_summary(&tmp, &files);
        assert_eq!(stat, "2 个文件");
    }

    #[test]
    fn collect_diff_skips_unsafe_paths_but_still_counts_them() {
        // Java parity: the 15-file cap is applied before the safety filter, so
        // an unsafe path is dropped from the diff text yet still counted in the
        // reported selection size. The "（仅前 15 个）" note must NOT fire here
        // (3 files < 15) — it only ever means "truncated by the cap".
        let files: Vec<String> = vec!["../escape.rs".into(), "/abs.rs".into(), "ok.rs".into()];
        let tmp = std::env::temp_dir();
        let (combined, stat) = collect_diff_for_summary(&tmp, &files);
        assert_eq!(stat, "3 个文件");
        assert!(combined.contains("ok.rs"));
        assert!(!combined.contains("escape.rs"));
        assert!(!combined.contains("abs.rs"));
    }
}
