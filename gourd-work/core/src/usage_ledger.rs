//! usage_ledger — on-disk pre-aggregated monthly usage ledger.
//!
//! Ported from the Java kernel's `UsageArchiveService` so both kernels share one
//! set of ledger files (`<harness_base>/.gwork/usage/usage-YYYY-MM.json`) and
//! report identical numbers.
//!
//! # Why a ledger instead of scanning streams
//!
//! Session `.stream.ndjson` files are append-only and grow without bound
//! (measured 179 MB / 383 files on the developer machine). Aggregating them per
//! request — even with an in-memory cache — costs a full rescan after every
//! process restart, which is why the usage page took 342 ms cold next to the
//! Java kernel's 38 ms.
//!
//! The ledger is **durable**: it stores the already-aggregated per-day ×
//! per-model totals plus a per-session watermark `{ts, size}`. Steady-state cost
//! is one `stat` per stream file (unchanged → skipped without opening it) plus
//! parsing ~100 KB of JSON. Only files that actually grew are re-read, and only
//! their new tail lines are parsed.
//!
//! # Invariants that must not be broken
//!
//! 1. **Watermarks live in the current month's shard.** When the calendar month
//!    rolls over the new shard has no watermark for an old session; treating that
//!    as "brand new session" would rescan the whole file and re-add its history
//!    on top of the values already read back from the old shard — doubling it,
//!    and doubling again on every subsequent break in the chain. Hence
//!    [`inherit_watermark`], which searches *all* historical shards (not just the
//!    previous month) and takes the largest `ts`.
//! 2. **An inherited watermark must be written back into the current shard** even
//!    when the file did not grow, otherwise next month the chain breaks again.
//! 3. **Deleted sessions keep their history.** Archiving only ever touches
//!    sessions that still exist; days already in the ledger are left as they are.
//!    This is the point of an archive — the Java kernel behaves the same, and it
//!    is why scanning only live session directories under-reports.
//! 4. **Dedup by sid, not by directory.** A session can have an empty shell
//!    directory in the global root (created before it was bound to a project)
//!    and the real one under `<project>/.gwork/sessions/`. Letting the shell win
//!    would drop the project session's usage entirely, so only non-empty stream
//!    files claim a sid, and the largest one wins.

use std::collections::HashMap;
use std::path::PathBuf;

use chrono::{Datelike, Local, NaiveDate};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::config::Settings;

const USAGE_DIR: &str = "usage";
const LEDGER_PREFIX: &str = "usage-";
const LEDGER_SUFFIX: &str = ".json";
const MONTH_KEY_LEN: usize = 7;

/// Serialises the archive lock; mirrors Java's `synchronized (ARCHIVE_LOCK)`.
static ARCHIVE_LOCK: once_cell::sync::Lazy<std::sync::Mutex<()>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(()));

/// Where a ledger reads sessions from and writes shards to.
///
/// Injected rather than derived from process-global state so tests can run in
/// parallel against scratch directories. Deriving it inside each function would
/// mean calling `set_harness_base`, which is a single process-wide slot: two
/// concurrent tests would redirect each other's ledger, and a stray test could
/// write into the developer's real `~/.gwork/usage`.
#[derive(Debug, Clone)]
pub struct LedgerPaths {
    /// Shard directory (`<harness_base>/.gwork/usage`).
    pub usage_dir: PathBuf,
    /// Session roots to scan: the global root plus every registered project root.
    pub session_roots: Vec<PathBuf>,
}

impl LedgerPaths {
    /// Discover paths from the live configuration.
    ///
    /// Session roots come from **`session-roots.json`** (every root a session was
    /// ever bound to), not from `projects.json` (only the projects the user
    /// explicitly registered). Java's `UsageArchiveService.collectSessionFiles`
    /// uses `sessionLocator.registeredRoots()` for exactly this reason; scanning
    /// the project list instead under-reports usage, because a session bound to a
    /// directory that was never registered as a project still has real stream
    /// files on disk.
    pub fn discover() -> Self {
        let mut session_roots = vec![Settings::sessions_dir()];
        for r in crate::session::SessionRoots::load().registered_roots() {
            session_roots.push(crate::session::sessions_root_for(&r));
        }
        Self { usage_dir: usage_dir(), session_roots }
    }
}

// ─── Ledger schema (wire-compatible with the Java kernel) ────────────────────

/// Per-model totals within one day.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct ModelStat {
    pub tokens: u64,
    /// Normalised input (cache included) — see `UsageInfo::normalized_input`.
    pub input: u64,
    pub output: u64,
    #[serde(rename = "cacheRead")]
    pub cache_read: u64,
    #[serde(rename = "cacheCreation")]
    pub cache_creation: u64,
    /// Number of `trace` frames, i.e. completed runs (not LLM calls).
    pub rounds: u64,
    /// Stable model uid. Omitted when unknown so the file stays byte-compatible
    /// with entries written before the uid mechanism existed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uid: Option<String>,
}

/// One day's aggregated usage.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct LedgerDay {
    pub messages: u64,
    /// Sessions active that day. Insertion-ordered and deduplicated, matching
    /// Java's `LinkedHashSet`.
    pub sessions: Vec<String>,
    pub models: IndexMap<String, ModelStat>,
}

impl LedgerDay {
    fn push_session(&mut self, sid: &str) {
        if !self.sessions.iter().any(|s| s == sid) {
            self.sessions.push(sid.to_string());
        }
    }

    /// Total tokens across all models (derived, never stored).
    pub fn tokens(&self) -> u64 {
        self.models.values().map(|m| m.tokens).sum()
    }

    /// Total rounds across all models (derived, never stored).
    pub fn rounds(&self) -> u64 {
        self.models.values().map(|m| m.rounds).sum()
    }
}

/// How far a session's stream file has already been archived.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct Watermark {
    /// Largest `createdAt` (epoch ms) consumed so far.
    pub ts: i64,
    /// Stream file size in bytes at that moment.
    pub size: u64,
}

/// One monthly shard.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MonthLedger {
    pub month: String,
    pub days: IndexMap<String, LedgerDay>,
    pub watermarks: HashMap<String, Watermark>,
    /// Not persisted: marks "needs writing" within one archive pass.
    #[serde(skip)]
    pub dirty: bool,
}

// ─── Paths ───────────────────────────────────────────────────────────────────

/// Ledger directory: `<harness_base>/.gwork/usage`.
///
/// Always the **global** base, never a project workspace — the ledger is a
/// cross-project aggregate. Java asserts this explicitly
/// (`testDistinctGlobalBaseKeepsUsageOutOfWorkspace`).
pub fn usage_dir() -> PathBuf {
    Settings::gwork_home().join(USAGE_DIR)
}

fn ledger_file(paths: &LedgerPaths, month: &str) -> PathBuf {
    paths.usage_dir.join(format!("{}{}{}", LEDGER_PREFIX, month, LEDGER_SUFFIX))
}

fn month_key(d: NaiveDate) -> String {
    format!("{:04}-{:02}", d.year(), d.month())
}

fn date_key(d: NaiveDate) -> String {
    format!("{:04}-{:02}-{:02}", d.year(), d.month(), d.day())
}

/// List existing shard months, ascending.
///
/// Only `usage-` + exactly 7 chars + `.json` qualifies, so a half-written
/// `usage-2026-08.json.tmp` is naturally excluded.
pub fn list_months(paths: &LedgerPaths) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(&paths.usage_dir) else {
        return Vec::new();
    };
    let mut months: Vec<String> = rd
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| {
            n.starts_with(LEDGER_PREFIX)
                && n.ends_with(LEDGER_SUFFIX)
                && n.len() == LEDGER_PREFIX.len() + MONTH_KEY_LEN + LEDGER_SUFFIX.len()
        })
        .map(|n| {
            n[LEDGER_PREFIX.len()..n.len() - LEDGER_SUFFIX.len()].to_string()
        })
        .collect();
    months.sort();
    months
}

// ─── Read / write ────────────────────────────────────────────────────────────

/// Read one shard. A missing or corrupt file yields an empty ledger rather than
/// an error, so a damaged shard can never take the whole stats page down.
pub fn read_ledger(paths: &LedgerPaths, month: &str) -> MonthLedger {
    let path = ledger_file(paths, month);
    let Ok(bytes) = std::fs::read(&path) else {
        return MonthLedger { month: month.to_string(), ..Default::default() };
    };
    match serde_json::from_slice::<MonthLedger>(&bytes) {
        Ok(mut l) => {
            l.month = month.to_string();
            l.dirty = false;
            l
        }
        Err(e) => {
            tracing::warn!(month, error = %e, "usage ledger shard unreadable; treating as empty");
            MonthLedger { month: month.to_string(), ..Default::default() }
        }
    }
}

/// Atomically write one shard: `<file>.tmp` then rename.
///
/// The rename is what makes a crash mid-write harmless — readers either see the
/// old shard or the new one, never a truncated file. The `.tmp` name is also
/// excluded by [`list_months`].
fn write_ledger(paths: &LedgerPaths, ledger: &MonthLedger) -> bool {
    if std::fs::create_dir_all(&paths.usage_dir).is_err() {
        return false;
    }
    let target = ledger_file(paths, &ledger.month);
    let tmp = target.with_file_name(format!(
        "{}{}",
        target.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default(),
        ".tmp"
    ));
    let Ok(json) = serde_json::to_vec(ledger) else { return false };
    if std::fs::write(&tmp, &json).is_err() {
        return false;
    }
    if std::fs::rename(&tmp, &target).is_ok() {
        return true;
    }
    // Windows refuses to rename onto an existing file in some configurations;
    // fall back to remove+rename before giving up (and losing the shard).
    let _ = std::fs::remove_file(&target);
    if std::fs::rename(&tmp, &target).is_ok() {
        return true;
    }
    let _ = std::fs::remove_file(&tmp);
    false
}

// ─── Session discovery ───────────────────────────────────────────────────────

struct SessionFile {
    sid: String,
    stream: PathBuf,
    size: u64,
}

/// Collect stream files from the global root plus every registered project root.
///
/// Dedup is **by sid**, keeping the largest non-empty stream file. See invariant
/// 4 in the module docs: deduping by directory lets an empty global shell shadow
/// the real project session and silently loses its usage.
fn collect_session_files(paths: &LedgerPaths) -> Vec<SessionFile> {
    let mut picked: IndexMap<String, SessionFile> = IndexMap::new();
    for root in &paths.session_roots {
        let Ok(rd) = std::fs::read_dir(root) else { continue };
        for entry in rd.flatten() {
            // Cheap string test first: it costs nothing and lets us skip the
            // directory-type query for the (common) non-session entries.
            let sid = entry.file_name().to_string_lossy().to_string();
            if !sid.starts_with(crate::session::PREFIX_WORK) {
                continue;
            }
            // `DirEntry::file_type()` is served from the directory listing that
            // `read_dir` already performed (Windows FindNextFile / POSIX d_type),
            // so it costs no syscall. `entry.path().is_dir()` would stat every
            // candidate again — measured as the single largest component of the
            // archive pass (55 ms of an 80 ms request across 484 sessions).
            if entry.file_type().map(|t| !t.is_dir()).unwrap_or(true) {
                continue;
            }
            let stream = entry.path().join(format!("{}.stream.ndjson", sid));
            let Ok(md) = std::fs::metadata(&stream) else { continue };
            if !md.is_file() || md.len() == 0 {
                // Empty shell: must not claim the sid.
                continue;
            }
            match picked.get(&sid) {
                Some(prev) if prev.size >= md.len() => {}
                _ => {
                    picked.insert(
                        sid.clone(),
                        SessionFile { sid, stream, size: md.len() },
                    );
                }
            }
        }
    }
    picked.into_values().collect()
}

// ─── Incremental archive ─────────────────────────────────────────────────────

/// Run one incremental archive pass against the live configuration.
pub fn archive_incremental() {
    archive_incremental_at(&LedgerPaths::discover());
}

/// Run one incremental archive pass. Idempotent: repeated calls only consume
/// events past the watermark. Never panics out — a failure here must not break
/// the stats page or startup.
pub fn archive_incremental_at(paths: &LedgerPaths) {
    // A poisoned lock must not wedge every later request.
    let _guard = match ARCHIVE_LOCK.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    if let Err(e) = do_archive(paths) {
        tracing::warn!(error = %e, "usage ledger incremental archive failed");
    }
}

fn do_archive(paths: &LedgerPaths) -> anyhow::Result<()> {
    let t0 = std::time::Instant::now();
    let targets = collect_session_files(paths);
    let t_collect = t0.elapsed();
    if targets.is_empty() {
        return Ok(());
    }

    let mut ledgers: IndexMap<String, MonthLedger> = IndexMap::new();
    let history_months = list_months(paths);
    let today = Local::now().date_naive();
    let current_month = month_key(today);
    let prev_month = month_key(prev_month_end(today));

    let mut stats = ArchiveStats::default();
    for sf in &targets {
        if let Err(e) = archive_one(
            paths,
            sf,
            &mut ledgers,
            &history_months,
            &current_month,
            &prev_month,
            &mut stats,
        ) {
            tracing::warn!(sid = %sf.sid, error = %e, "usage ledger: archive failed for session");
        }
    }
    let t_scan = t0.elapsed();

    let mut shards_written = 0usize;
    for ledger in ledgers.values() {
        if ledger.dirty {
            write_ledger(paths, ledger);
            shards_written += 1;
        }
    }

    // Steady state must be dominated by `collect` (one directory walk plus one
    // stat per session) with `skipped == sessions` and zero writes. If `read`
    // is non-zero on a request where nothing was written to any session, a
    // watermark is being lost and the whole file is being re-parsed. Debug
    // level: this fires on every usage/stats request, so it must not be info.
    tracing::debug!(
        roots = paths.session_roots.len(),
        sessions = targets.len(),
        skipped = stats.skipped,
        inherited = stats.inherited,
        read = stats.read,
        shards_loaded = ledgers.len(),
        shards_written,
        collect_us = t_collect.as_micros() as u64,
        scan_us = (t_scan - t_collect).as_micros() as u64,
        write_us = (t0.elapsed() - t_scan).as_micros() as u64,
        "usage ledger archive breakdown"
    );
    Ok(())
}

/// Per-pass counters, used to prove the watermark fast path is actually taken.
#[derive(Default)]
struct ArchiveStats {
    /// Sessions skipped without opening the stream file (size == watermark).
    skipped: usize,
    /// Sessions whose watermark had to be inherited from an older shard.
    inherited: usize,
    /// Sessions whose stream file was opened and parsed.
    read: usize,
}

/// Last day of the previous month (used only to derive its month key).
fn prev_month_end(d: NaiveDate) -> NaiveDate {
    let first_of_this = d.with_day(1).unwrap_or(d);
    first_of_this - chrono::Duration::days(1)
}

/// Get-or-load a shard within this pass, so each shard is read from disk at most
/// once no matter how many sessions land in it.
///
/// A month with no shard file simply loads as empty — `read_ledger` already
/// handles the missing-file case — so `history` is not needed to decide.
fn ledger<'a>(
    paths: &LedgerPaths,
    cache: &'a mut IndexMap<String, MonthLedger>,
    month: &str,
) -> &'a mut MonthLedger {
    if !cache.contains_key(month) {
        cache.insert(month.to_string(), read_ledger(paths, month));
    }
    cache.get_mut(month).expect("just inserted")
}

fn archive_one(
    paths: &LedgerPaths,
    sf: &SessionFile,
    ledgers: &mut IndexMap<String, MonthLedger>,
    history_months: &[String],
    current_month: &str,
    prev_month: &str,
    stats: &mut ArchiveStats,
) -> anyhow::Result<()> {
    let file_size = sf.size;
    if file_size == 0 {
        return Ok(());
    }

    // The watermark is carried by the *current* month's shard.
    let wm = {
        let cur = ledger(paths, ledgers, current_month);
        cur.watermarks.get(&sf.sid).cloned()
    };
    let mut inherited = false;
    let wm = match wm {
        Some(w) => Some(w),
        None => {
            let w = inherit_watermark(
                paths,
                ledgers,
                history_months,
                current_month,
                prev_month,
                &sf.sid,
            );
            inherited = w.is_some();
            if inherited {
                stats.inherited += 1;
            }
            w
        }
    };
    let since_ts = wm.as_ref().map(|w| w.ts).unwrap_or(i64::MIN);

    // Unchanged since last archive → skip without opening the file. This is the
    // fast path that makes the steady state cheap.
    if let Some(w) = &wm {
        if file_size == w.size {
            stats.skipped += 1;
            if inherited {
                // Persist the inherited watermark into the current shard, or the
                // chain breaks again next month (invariant 2).
                let cur = ledger(paths, ledgers, current_month);
                cur.watermarks.insert(sf.sid.clone(), w.clone());
                cur.dirty = true;
            }
            return Ok(());
        }
    }

    let mut max_ts = since_ts;
    let mut changed = false;
    stats.read += 1;

    let content = std::fs::read_to_string(&sf.stream)?;
    for line in content.lines() {
        // Cheap substring pre-filter: the vast majority of lines are text and
        // reasoning deltas that must never be JSON-parsed.
        let is_trace = line.contains("\"type\":\"trace\"");
        let is_user =
            line.contains("\"type\":\"user\"") || line.contains("\"type\":\"user_input\"");
        if !is_trace && !is_user {
            continue;
        }
        let Ok(frame) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let created = frame.get("createdAt").and_then(|c| c.as_i64()).unwrap_or(0);
        if created <= 0 {
            continue;
        }
        // Watermark gate: only consume new events, never re-add old ones.
        if created <= since_ts {
            continue;
        }
        if created > max_ts {
            max_ts = created;
        }

        let Some(dt) = chrono::DateTime::from_timestamp_millis(created) else { continue };
        let date = dt.with_timezone(&Local).date_naive();
        let mk = month_key(date);
        let dk = date_key(date);

        let target = ledger(paths, ledgers, &mk);
        let day = target.days.entry(dk).or_default();

        if is_trace {
            let model = frame
                .get("model")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("unknown")
                .to_string();
            let input = u64_of(&frame, "inputTokens");
            let output = u64_of(&frame, "outputTokens");
            let mut total = u64_of(&frame, "totalTokens");
            if total == 0 {
                total = input.saturating_add(output);
            }
            let ms = day.models.entry(model).or_default();
            if let Some(uid) = frame
                .get("modelId")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                ms.uid = Some(uid.to_string());
            }
            ms.tokens = ms.tokens.saturating_add(total);
            ms.input = ms.input.saturating_add(input);
            ms.output = ms.output.saturating_add(output);
            ms.cache_read = ms.cache_read.saturating_add(u64_of(&frame, "cacheReadTokens"));
            ms.cache_creation = ms
                .cache_creation
                .saturating_add(u64_of(&frame, "cacheCreationTokens"));
            ms.rounds = ms.rounds.saturating_add(1);
        } else {
            day.messages = day.messages.saturating_add(1);
        }
        day.push_session(&sf.sid);

        target.dirty = true;
        changed = true;
    }

    // Always refresh the watermark, even with no new events, so the next pass
    // can take the size-equality fast path.
    let nw = Watermark {
        ts: if max_ts == i64::MIN { 0 } else { max_ts },
        size: file_size,
    };
    let cur = ledger(paths, ledgers, current_month);
    cur.watermarks.insert(sf.sid.clone(), nw);
    // Mark dirty when the file **size** moved, not only when new events were
    // consumed. Java's condition is `changed || wm == null || wm.size != fileSize`;
    // dropping the third clause (as an earlier revision of this port did) means a
    // file whose bytes grew without yielding any new event — e.g. only text and
    // reasoning deltas appended after the watermark — never persists its new
    // watermark. The next request sees the same size mismatch and re-reads the
    // whole file, every request, forever. Measured effect: one ~15 MB stream was
    // re-parsed on every single usage/stats call, costing 25-37 ms per request.
    if changed || wm.is_none() || wm.as_ref().map(|w| w.size != file_size).unwrap_or(true) {
        cur.dirty = true;
    }
    Ok(())
}

/// Inherit a session's watermark from historical shards when the current month
/// has none.
///
/// Checks the previous month first (the common rollover case, highest hit rate),
/// then scans the remaining shards taking the **largest `ts`** — defending
/// against non-monotonic timestamps across shards. Only sessions missing from
/// both the current and previous month pay for the extra reads, and shards are
/// cached per pass.
fn inherit_watermark(
    paths: &LedgerPaths,
    ledgers: &mut IndexMap<String, MonthLedger>,
    history_months: &[String],
    current_month: &str,
    prev_month: &str,
    sid: &str,
) -> Option<Watermark> {
    if prev_month != current_month {
        if let Some(w) = ledger(paths, ledgers, prev_month).watermarks.get(sid).cloned() {
            return Some(w);
        }
    }
    let mut best: Option<Watermark> = None;
    for m in history_months {
        if m == current_month || m == prev_month {
            continue;
        }
        if let Some(w) = ledger(paths, ledgers, m).watermarks.get(sid).cloned() {
            if best.as_ref().map(|b| w.ts > b.ts).unwrap_or(true) {
                best = Some(w);
            }
        }
    }
    best
}

fn u64_of(v: &serde_json::Value, key: &str) -> u64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(0).max(0) as u64
}

// ─── Query ───────────────────────────────────────────────────────────────────

/// Read archived days in `[from, to]` (inclusive). Only days actually present in
/// the ledger are returned; the caller zero-fills.
pub fn load(
    paths: &LedgerPaths,
    from: NaiveDate,
    to: NaiveDate,
) -> std::collections::BTreeMap<NaiveDate, LedgerDay> {
    let mut out = std::collections::BTreeMap::new();
    if from > to {
        return out;
    }
    let _guard = match ARCHIVE_LOCK.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    let mut cursor = from.with_day(1).unwrap_or(from);
    let last = to.with_day(1).unwrap_or(to);
    while cursor <= last {
        let ledger = read_ledger(paths, &month_key(cursor));
        for (k, day) in ledger.days {
            if let Some(d) = parse_date(&k) {
                if d >= from && d <= to {
                    out.insert(d, day);
                }
            }
        }
        cursor = next_month(cursor);
    }
    out
}

/// Read **all** history across every shard, for the "all time" view.
///
/// Lists the shards that actually exist rather than walking months from year
/// zero, so cost is proportional to real history length.
pub fn load_all(paths: &LedgerPaths) -> std::collections::BTreeMap<NaiveDate, LedgerDay> {
    let mut out = std::collections::BTreeMap::new();
    let _guard = match ARCHIVE_LOCK.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    for month in list_months(paths) {
        let ledger = read_ledger(paths, &month);
        for (k, day) in ledger.days {
            if let Some(d) = parse_date(&k) {
                out.insert(d, day);
            }
        }
    }
    out
}

fn parse_date(s: &str) -> Option<NaiveDate> {
    let y: i32 = s.get(0..4)?.parse().ok()?;
    let m: u32 = s.get(5..7)?.parse().ok()?;
    let d: u32 = s.get(8..10)?.parse().ok()?;
    NaiveDate::from_ymd_opt(y, m, d)
}

fn next_month(d: NaiveDate) -> NaiveDate {
    let first = d.with_day(1).unwrap_or(d);
    let y = if first.month() == 12 { first.year() + 1 } else { first.year() };
    let m = if first.month() == 12 { 1 } else { first.month() + 1 };
    NaiveDate::from_ymd_opt(y, m, 1).unwrap_or(first)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// Scratch harness with **injected** paths.
    ///
    /// Deliberately does *not* call `set_harness_base`: that is one process-wide
    /// slot, and cargo test runs tests in parallel threads, so two tests would
    /// redirect each other's ledger (and a stray one could write into the
    /// developer's real `~/.gwork/usage`). Every entry point under test takes a
    /// `&LedgerPaths`, so isolation is structural rather than a matter of
    /// remembering to serialise.
    struct Scratch {
        root: PathBuf,
        paths: LedgerPaths,
    }

    impl Scratch {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "gwork-ledger-{}-{}-{}",
                tag,
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.subsec_nanos())
                    .unwrap_or(0)
            ));
            let _ = std::fs::remove_dir_all(&root);
            let sessions = root.join("sessions");
            std::fs::create_dir_all(&sessions).unwrap();
            std::fs::create_dir_all(root.join("usage")).unwrap();
            let paths = LedgerPaths {
                usage_dir: root.join("usage"),
                session_roots: vec![sessions],
            };
            Self { root, paths }
        }

        /// Add a second session root (stands in for a registered project root).
        fn with_extra_root(&mut self, name: &str) -> PathBuf {
            let r = self.root.join(name);
            std::fs::create_dir_all(&r).unwrap();
            self.paths.session_roots.push(r.clone());
            r
        }

        fn sessions_dir(&self) -> PathBuf {
            self.paths.session_roots[0].clone()
        }

        /// Create a session dir with a stream file holding the given frames.
        fn session(&self, sid: &str, frames: &[String]) -> PathBuf {
            self.session_in(&self.sessions_dir(), sid, frames)
        }

        fn session_in(&self, root: &Path, sid: &str, frames: &[String]) -> PathBuf {
            let dir = root.join(sid);
            std::fs::create_dir_all(&dir).unwrap();
            let body = if frames.is_empty() {
                String::new()
            } else {
                frames.join("\n") + "\n"
            };
            let f = dir.join(format!("{}.stream.ndjson", sid));
            std::fs::write(&f, body).unwrap();
            f
        }

        fn trace(&self, model: &str, input: u64, output: u64, created_ms: i64) -> String {
            serde_json::json!({
                "type": "trace",
                "model": model,
                "inputTokens": input,
                "outputTokens": output,
                "totalTokens": input + output,
                "cacheReadTokens": 0u64,
                "createdAt": created_ms,
            })
            .to_string()
        }

        fn archive(&self) {
            archive_incremental_at(&self.paths);
        }

        fn all(&self) -> std::collections::BTreeMap<NaiveDate, LedgerDay> {
            load_all(&self.paths)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// Noon local time on a date, as epoch ms — avoids DST edge cases at 00:00.
    fn ms_for(date: NaiveDate) -> i64 {
        date.and_hms_opt(12, 0, 0)
            .unwrap()
            .and_local_timezone(Local)
            .single()
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(1_792_051_200_000)
    }

    #[test]
    fn archive_creates_shard_and_aggregates() {
        let s = Scratch::new("basic");
        let day = Local::now().date_naive();
        s.session(
            "work-aaa",
            &[
                s.trace("m1", 100, 50, ms_for(day)),
                s.trace("m1", 10, 5, ms_for(day) + 1000),
                s.trace("m2", 7, 3, ms_for(day) + 2000),
            ],
        );

        s.archive();

        let all = s.all();
        let d = all.get(&day).expect("day archived");
        assert_eq!(d.tokens(), 175, "100+50 + 10+5 + 7+3");
        assert_eq!(d.rounds(), 3);
        assert_eq!(d.models.get("m1").unwrap().tokens, 165);
        assert_eq!(d.models.get("m2").unwrap().tokens, 10);
        assert_eq!(d.sessions, vec!["work-aaa".to_string()]);
    }

    #[test]
    fn second_pass_is_idempotent_via_watermark() {
        let s = Scratch::new("idem");
        let day = Local::now().date_naive();
        s.session("work-bbb", &[s.trace("m1", 100, 0, ms_for(day))]);

        s.archive();
        s.archive();
        s.archive();

        let d = s.all().get(&day).cloned().unwrap();
        assert_eq!(d.tokens(), 100, "repeated passes must not double-count");
        assert_eq!(d.rounds(), 1);
    }

    #[test]
    fn appended_tail_is_consumed_without_recounting_old_lines() {
        let s = Scratch::new("append");
        let day = Local::now().date_naive();
        let p = s.session("work-ccc", &[s.trace("m1", 100, 0, ms_for(day))]);
        s.archive();

        // Append a new run — the real write pattern for stream files.
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        std::io::Write::write_all(&mut f, (s.trace("m1", 50, 0, ms_for(day) + 5000) + "\n").as_bytes())
            .unwrap();
        drop(f);
        s.archive();

        let d = s.all().get(&day).cloned().unwrap();
        assert_eq!(d.tokens(), 150, "old 100 + new 50, not 100+100+50");
        assert_eq!(d.rounds(), 2);
    }

    /// An empty shell directory in the global root must not shadow the real
    /// session living under a project root. Deduping by directory name (instead
    /// of by sid, keeping the largest non-empty stream) loses the project
    /// session's usage entirely.
    #[test]
    fn empty_shell_directory_does_not_claim_sid() {
        let mut s = Scratch::new("shell");
        let day = Local::now().date_naive();
        let proj_root = s.with_extra_root("proj-sessions");

        // Global root: empty shell (zero-byte stream).
        let shell = s.sessions_dir().join("work-ddd");
        std::fs::create_dir_all(&shell).unwrap();
        std::fs::write(shell.join("work-ddd.stream.ndjson"), "").unwrap();

        // Project root: the real session.
        s.session_in(&proj_root, "work-ddd", &[s.trace("m1", 200, 0, ms_for(day))]);

        s.archive();

        let d = s.all().get(&day).cloned().unwrap_or_default();
        assert_eq!(d.tokens(), 200, "project session must not be shadowed by the empty shell");
    }

    /// The same sid present in two roots with real content: the larger stream
    /// wins, and its usage is counted exactly once.
    #[test]
    fn duplicate_sid_counts_the_larger_stream_once() {
        let mut s = Scratch::new("dup");
        let day = Local::now().date_naive();
        let proj_root = s.with_extra_root("proj2");

        s.session("work-dup", &[s.trace("m1", 10, 0, ms_for(day))]);
        s.session_in(
            &proj_root,
            "work-dup",
            &[
                s.trace("m1", 10, 0, ms_for(day)),
                s.trace("m1", 90, 0, ms_for(day) + 1000),
            ],
        );

        s.archive();

        let d = s.all().get(&day).cloned().unwrap();
        assert_eq!(d.tokens(), 100, "larger stream wins; not summed across roots");
        assert_eq!(d.sessions, vec!["work-dup".to_string()]);
    }

    #[test]
    fn deleted_session_history_is_preserved() {
        let s = Scratch::new("deleted");
        let day = Local::now().date_naive();
        s.session("work-eee", &[s.trace("m1", 300, 0, ms_for(day))]);
        s.archive();
        assert_eq!(s.all().get(&day).unwrap().tokens(), 300);

        // Delete the session directory, then archive again.
        std::fs::remove_dir_all(s.sessions_dir().join("work-eee")).unwrap();
        s.archive();

        assert_eq!(
            s.all().get(&day).unwrap().tokens(),
            300,
            "archived history must survive session deletion"
        );
    }

    /// The regression Java's `UsageArchiveRolloverTest` locks (1000 → 2000):
    /// watermarks live in the current month's shard, so after a rollover the new
    /// shard has none. Without inheritance the whole file is rescanned and its
    /// history re-added on top of the values read back from the old shard.
    #[test]
    fn watermark_inherits_across_month_rollover_without_doubling() {
        let s = Scratch::new("rollover");
        let day = Local::now().date_naive();
        let prev = prev_month_end(day);
        let prev_m = month_key(prev);

        // Hand-build last month's shard carrying both the day totals and the
        // watermark for a session whose stream file has not grown since.
        let mut lm = MonthLedger { month: prev_m.clone(), ..Default::default() };
        let d = lm.days.entry(date_key(prev)).or_default();
        d.models.entry("m1".into()).or_default().tokens = 1000;
        d.push_session("work-fff");
        let p = s.session("work-fff", &[s.trace("m1", 1000, 0, ms_for(prev))]);
        let size = std::fs::metadata(&p).unwrap().len();
        lm.watermarks
            .insert("work-fff".into(), Watermark { ts: ms_for(prev), size });
        std::fs::write(
            ledger_file(&s.paths, &prev_m),
            serde_json::to_vec(&lm).unwrap(),
        )
        .unwrap();

        // Archive again: the current month has no watermark for work-fff, so it
        // must inherit last month's instead of rescanning from the beginning.
        s.archive();

        let prev_day = s.all().get(&prev).cloned().unwrap_or_default();
        assert_eq!(
            prev_day.tokens(),
            1000,
            "history must not double when the watermark chain crosses a month boundary"
        );
        // The inherited watermark must now be registered in the current shard,
        // otherwise the chain breaks again next month.
        let cur = read_ledger(&s.paths, &month_key(day));
        assert!(
            cur.watermarks.contains_key("work-fff"),
            "inherited watermark must be written back to the current shard"
        );
    }

    /// A dormant session (unchanged bytes) whose inherited watermark was never
    /// written back would break the chain on the *next* rollover too. This is
    /// Java's documented failure path ①.
    #[test]
    fn dormant_session_watermark_survives_two_rollovers() {
        let s = Scratch::new("dormant");
        let day = Local::now().date_naive();
        let prev = prev_month_end(day);
        let prev_m = month_key(prev);

        let mut lm = MonthLedger { month: prev_m.clone(), ..Default::default() };
        lm.days.entry(date_key(prev)).or_default().models
            .entry("m1".into())
            .or_default()
            .tokens = 500;
        let p = s.session("work-ggg", &[s.trace("m1", 500, 0, ms_for(prev))]);
        let size = std::fs::metadata(&p).unwrap().len();
        lm.watermarks
            .insert("work-ggg".into(), Watermark { ts: ms_for(prev), size });
        std::fs::write(ledger_file(&s.paths, &prev_m), serde_json::to_vec(&lm).unwrap()).unwrap();

        // Two passes with no new bytes: the first inherits and must write back,
        // the second must find it in the current shard and still not double.
        s.archive();
        s.archive();

        assert_eq!(s.all().get(&prev).unwrap().tokens(), 500);
        let cur = read_ledger(&s.paths, &month_key(day));
        assert_eq!(cur.watermarks.get("work-ggg").map(|w| w.size), Some(size));
    }

    #[test]
    fn corrupt_shard_is_treated_as_empty_not_fatal() {
        let s = Scratch::new("corrupt");
        let m = month_key(Local::now().date_naive());
        std::fs::write(ledger_file(&s.paths, &m), b"{not json at all").unwrap();

        let l = read_ledger(&s.paths, &m);
        assert!(l.days.is_empty());
        assert!(l.watermarks.is_empty());
        // And a full pass still succeeds rather than propagating the damage.
        s.archive();
    }

    #[test]
    fn tmp_shard_is_not_listed_as_a_month() {
        let s = Scratch::new("tmpfile");
        std::fs::write(s.paths.usage_dir.join("usage-2026-08.json.tmp"), b"{}").unwrap();
        std::fs::write(s.paths.usage_dir.join("usage-2026-09.json"), b"{}").unwrap();
        std::fs::write(s.paths.usage_dir.join("other.json"), b"{}").unwrap();
        std::fs::write(s.paths.usage_dir.join("usage-2026-1.json"), b"{}").unwrap();

        let months = list_months(&s.paths);
        assert_eq!(months, vec!["2026-09".to_string()]);
    }

    #[test]
    fn ledger_is_written_into_the_injected_usage_dir() {
        let s = Scratch::new("globalonly");
        let day = Local::now().date_naive();
        s.session("work-hhh", &[s.trace("m1", 1, 0, ms_for(day))]);
        s.archive();

        assert!(ledger_file(&s.paths, &month_key(day)).exists());
        // Nothing may leak outside the injected dir.
        assert!(!s.root.join("proj").join(".gwork").join("usage").exists());
    }

    #[test]
    fn user_frames_count_messages_not_tokens() {
        let s = Scratch::new("messages");
        let day = Local::now().date_naive();
        let user = serde_json::json!({
            "type": "user", "text": "hi", "createdAt": ms_for(day)
        })
        .to_string();
        s.session(
            "work-iii",
            &[user, s.trace("m1", 10, 2, ms_for(day) + 1000)],
        );
        s.archive();

        let d = s.all().get(&day).cloned().unwrap();
        assert_eq!(d.messages, 1);
        assert_eq!(d.tokens(), 12);
        assert_eq!(d.rounds(), 1);
    }

    #[test]
    fn frames_without_created_at_are_skipped() {
        let s = Scratch::new("nocreated");
        s.session(
            "work-jjj",
            &[r#"{"type":"trace","model":"m","inputTokens":5,"outputTokens":5}"#.to_string()],
        );
        s.archive();
        assert!(s.all().is_empty(), "undated frames must not create a day");
    }

    /// Malformed lines must be skipped, not fatal — a single bad byte in one
    /// session cannot be allowed to lose every other session's usage.
    #[test]
    fn malformed_lines_are_skipped_not_fatal() {
        let s = Scratch::new("malformed");
        let day = Local::now().date_naive();
        s.session(
            "work-kkk",
            &[
                "not json at all".to_string(),
                "{".to_string(),
                s.trace("m1", 3, 4, ms_for(day)),
            ],
        );
        s.archive();
        assert_eq!(s.all().get(&day).unwrap().tokens(), 7);
    }

    /// Cache fields must survive the round trip, because the report's
    /// cacheRanking is computed from them; losing them silently reports 0% hit.
    #[test]
    fn cache_fields_round_trip_through_the_shard() {
        let s = Scratch::new("cache");
        let day = Local::now().date_naive();
        let frame = serde_json::json!({
            "type": "trace",
            "model": "m1",
            "inputTokens": 1000u64,
            "outputTokens": 10u64,
            "totalTokens": 1010u64,
            "cacheReadTokens": 800u64,
            "cacheCreationTokens": 50u64,
            "modelId": "uid-abc",
            "createdAt": ms_for(day),
        })
        .to_string();
        s.session("work-lll", &[frame]);
        s.archive();

        // Read back from disk (not from the in-pass cache) to prove persistence.
        let shard = read_ledger(&s.paths, &month_key(day));
        let m = shard
            .days
            .get(&date_key(day))
            .unwrap()
            .models
            .get("m1")
            .unwrap();
        assert_eq!(m.cache_read, 800);
        assert_eq!(m.cache_creation, 50);
        assert_eq!(m.input, 1000);
        assert_eq!(m.uid.as_deref(), Some("uid-abc"));
    }

    /// `totalTokens` absent or zero must fall back to input+output, matching
    /// Java's `longOf` + fallback so older frames still count.
    #[test]
    fn missing_total_tokens_falls_back_to_input_plus_output() {
        let s = Scratch::new("nototal");
        let day = Local::now().date_naive();
        let frame = serde_json::json!({
            "type": "trace",
            "model": "m1",
            "inputTokens": 60u64,
            "outputTokens": 7u64,
            "createdAt": ms_for(day),
        })
        .to_string();
        s.session("work-mmm", &[frame]);
        s.archive();
        assert_eq!(s.all().get(&day).unwrap().tokens(), 67);
    }

    /// Events must land in the shard of **their own** date, not the current
    /// month's — otherwise backfilling an old session corrupts both months.
    #[test]
    fn events_are_filed_into_their_own_month_shard() {
        let s = Scratch::new("ownmonth");
        let day = Local::now().date_naive();
        let prev = prev_month_end(day);
        s.session(
            "work-nnn",
            &[
                s.trace("m1", 111, 0, ms_for(prev)),
                s.trace("m1", 222, 0, ms_for(day)),
            ],
        );
        s.archive();

        let all = s.all();
        assert_eq!(all.get(&prev).unwrap().tokens(), 111);
        assert_eq!(all.get(&day).unwrap().tokens(), 222);
        // Both shards exist on disk.
        assert!(ledger_file(&s.paths, &month_key(prev)).exists());
        assert!(ledger_file(&s.paths, &month_key(day)).exists());
    }

    #[test]
    fn load_window_filters_to_the_requested_range() {
        let s = Scratch::new("window");
        let day = Local::now().date_naive();
        let prev = prev_month_end(day);
        s.session(
            "work-ooo",
            &[
                s.trace("m1", 5, 0, ms_for(prev)),
                s.trace("m1", 6, 0, ms_for(day)),
            ],
        );
        s.archive();

        let windowed = load(&s.paths, day, day);
        assert_eq!(windowed.len(), 1);
        assert_eq!(windowed.get(&day).unwrap().tokens(), 6);

        // An inverted range yields nothing rather than panicking.
        assert!(load(&s.paths, day, prev).is_empty());
    }

    #[test]
    fn write_is_atomic_via_tmp_then_rename() {
        let s = Scratch::new("atomic");
        let day = Local::now().date_naive();
        s.session("work-ppp", &[s.trace("m1", 1, 0, ms_for(day))]);
        s.archive();

        let target = ledger_file(&s.paths, &month_key(day));
        assert!(target.exists());
        // The temporary file must not be left behind.
        let tmp = target.with_file_name(format!(
            "{}.tmp",
            target.file_name().unwrap().to_string_lossy()
        ));
        assert!(!tmp.exists(), "tmp shard must be renamed away, not left behind");
    }

    #[test]
    fn month_and_date_key_formats() {
        let d = NaiveDate::from_ymd_opt(2026, 3, 7).unwrap();
        assert_eq!(month_key(d), "2026-03");
        assert_eq!(date_key(d), "2026-03-07");
        assert_eq!(parse_date("2026-03-07"), Some(d));
        assert_eq!(parse_date("garbage"), None);
        assert_eq!(parse_date("2026-13-01"), None);
    }

    #[test]
    fn next_month_wraps_the_year() {
        let dec = NaiveDate::from_ymd_opt(2026, 12, 15).unwrap();
        assert_eq!(next_month(dec), NaiveDate::from_ymd_opt(2027, 1, 1).unwrap());
        let mid = NaiveDate::from_ymd_opt(2026, 6, 15).unwrap();
        assert_eq!(next_month(mid), NaiveDate::from_ymd_opt(2026, 7, 1).unwrap());
    }

    #[test]
    fn prev_month_end_wraps_the_year() {
        let jan = NaiveDate::from_ymd_opt(2027, 1, 20).unwrap();
        assert_eq!(prev_month_end(jan), NaiveDate::from_ymd_opt(2026, 12, 31).unwrap());
    }

    /// Sessions are deduplicated within a day even across several frames.
    #[test]
    fn sessions_list_is_deduplicated_and_ordered() {
        let s = Scratch::new("dedup");
        let day = Local::now().date_naive();
        s.session(
            "work-qqq",
            &[
                s.trace("m1", 1, 0, ms_for(day)),
                s.trace("m1", 1, 0, ms_for(day) + 1000),
                s.trace("m1", 1, 0, ms_for(day) + 2000),
            ],
        );
        s.archive();
        let d = s.all().get(&day).cloned().unwrap();
        assert_eq!(d.sessions, vec!["work-qqq".to_string()], "one entry per session");
        assert_eq!(d.rounds(), 3);
    }

    /// **Regression lock for a real defect in this port.**
    ///
    /// When a stream file grows but yields no new archivable event (e.g. only
    /// text/reasoning deltas appended past the watermark, or an event whose
    /// `createdAt` is at or below the watermark), the watermark's `size` must
    /// still be persisted. Java's condition is
    /// `changed || wm == null || wm.size != fileSize`; an earlier revision here
    /// dropped the third clause, so the new size lived only in memory and the
    /// next request saw the same mismatch and re-read the whole file — every
    /// request, forever. Measured cost: one ~15 MB stream re-parsed per call,
    /// 25-37 ms of an ~80 ms request.
    #[test]
    fn watermark_size_persists_when_file_grew_without_new_events() {
        let s = Scratch::new("sizeonly");
        let day = Local::now().date_naive();
        let p = s.session("work-sz1", &[s.trace("m1", 100, 0, ms_for(day))]);
        s.archive();

        let size_before = std::fs::metadata(&p).unwrap().len();
        let wm_before = read_ledger(&s.paths, &month_key(day))
            .watermarks
            .get("work-sz1")
            .cloned()
            .expect("watermark written on first pass");
        assert_eq!(wm_before.size, size_before);

        // Grow the file with content that produces **no** new archivable event:
        // a text delta the archiver filters out before parsing.
        {
            let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
            std::io::Write::write_all(
                &mut f,
                b"{\"type\":\"text\",\"text\":\"padding only\",\"createdAt\":9999999999999}\n",
            )
            .unwrap();
        }
        let size_after = std::fs::metadata(&p).unwrap().len();
        assert!(size_after > size_before, "fixture must actually grow the file");

        s.archive();

        // The persisted watermark must carry the NEW size, so the following pass
        // takes the skip fast path instead of re-reading the file.
        let wm_after = read_ledger(&s.paths, &month_key(day))
            .watermarks
            .get("work-sz1")
            .cloned()
            .expect("watermark still present");
        assert_eq!(
            wm_after.size, size_after,
            "watermark size must be persisted even when no new event was consumed"
        );
        // And the day's totals must be unchanged (no double counting).
        assert_eq!(s.all().get(&day).unwrap().tokens(), 100);
    }

    /// The steady-state fast path: once archived, a second pass must not open
    /// any stream file at all. Proven by making the stream unreadable *after*
    /// the first pass — if the archiver tried to read it, the pass would fail.
    #[test]
    fn steady_state_pass_does_not_open_stream_files() {
        let s = Scratch::new("fastpath");
        let day = Local::now().date_naive();
        s.session("work-fp1", &[s.trace("m1", 42, 0, ms_for(day))]);
        s.archive();
        assert_eq!(s.all().get(&day).unwrap().tokens(), 42);

        // Replacing the file with one of the *same byte length* but different
        // content keeps `size == wm.size`, which is exactly the fast-path key.
        // If the archiver opened it, the new content would be parsed and the
        // totals would change.
        let p = s.sessions_dir().join("work-fp1").join("work-fp1.stream.ndjson");
        let original = std::fs::read_to_string(&p).unwrap();
        let same_len = {
            // Swap the model name for another of identical byte length.
            let swapped = original.replacen("\"m1\"", "\"m2\"", 1);
            assert_eq!(swapped.len(), original.len(), "fixture must preserve byte length");
            swapped
        };
        std::fs::write(&p, same_len).unwrap();

        s.archive();

        let d = s.all().get(&day).cloned().unwrap();
        assert_eq!(
            d.models.get("m1").map(|m| m.tokens),
            Some(42),
            "unchanged size must take the skip fast path, not re-parse"
        );
        assert!(
            d.models.get("m2").is_none(),
            "a re-parse would have attributed tokens to the swapped model name"
        );
    }

    /// Non-`work-` directories are not sessions and must be ignored.
    #[test]
    fn non_work_directories_are_ignored() {
        let s = Scratch::new("nonwork");
        let day = Local::now().date_naive();
        s.session_in(&s.sessions_dir(), "general", &[s.trace("m1", 999, 0, ms_for(day))]);
        s.archive();
        assert!(s.all().is_empty(), "only work-* directories are sessions");
    }

    // ─── Cross-kernel fidelity ────────────────────────────────────────────────
    //
    // Both kernels read AND write the same `~/.gwork/usage/usage-YYYY-MM.json`.
    // If the Rust structs dropped a field Java writes, every Rust archive pass
    // would silently strip it from the shared file — the same class of defect as
    // `persist_settings` rebuilding model objects from a fixed field list.
    //
    // The fixture below is **verbatim from a Java-written shard** (2026-08),
    // trimmed to one day plus two watermarks. It deliberately includes the
    // awkward cases: a model whose counters are all zero, a `uid`, large token
    // counts, and a multi-session day.

    const JAVA_WRITTEN_SHARD: &str = r#"{"month":"2026-08","days":{"2026-08-20":{"messages":59,"sessions":["work-13e584c4","work-mt0u9nha","work-mt0yrk8g"],"models":{"Aionly-qwen3.8-max":{"tokens":36782950,"input":36141446,"output":641504,"cacheRead":33619200,"cacheCreation":0,"rounds":24,"uid":"be463b2d2e01070b"},"Aionly-claude-fable-5":{"tokens":0,"input":0,"output":0,"cacheRead":0,"cacheCreation":0,"rounds":2,"uid":"139f2292b4bb6dd3"}}}},"watermarks":{"work-mt9x10cf":{"ts":1787741600445,"size":792246},"work-mt5l5jjn":{"ts":1787476175712,"size":1529}}}"#;

    #[test]
    fn java_written_shard_parses_without_losing_any_field() {
        let l: MonthLedger = serde_json::from_str(JAVA_WRITTEN_SHARD).expect("must parse");
        assert_eq!(l.month, "2026-08");

        let day = l.days.get("2026-08-20").expect("day present");
        assert_eq!(day.messages, 59);
        assert_eq!(
            day.sessions,
            vec![
                "work-13e584c4".to_string(),
                "work-mt0u9nha".to_string(),
                "work-mt0yrk8g".to_string()
            ],
            "session order must survive (Java uses a LinkedHashSet)"
        );

        let m = day.models.get("Aionly-qwen3.8-max").unwrap();
        assert_eq!(m.tokens, 36_782_950);
        assert_eq!(m.input, 36_141_446);
        assert_eq!(m.output, 641_504);
        assert_eq!(m.cache_read, 33_619_200);
        assert_eq!(m.cache_creation, 0);
        assert_eq!(m.rounds, 24);
        assert_eq!(m.uid.as_deref(), Some("be463b2d2e01070b"));

        // A model that ran but consumed nothing must not be dropped: its
        // `rounds` still counts toward the day's run total.
        let zero = day.models.get("Aionly-claude-fable-5").unwrap();
        assert_eq!(zero.tokens, 0);
        assert_eq!(zero.rounds, 2);
        assert_eq!(day.rounds(), 26, "24 + 2, including the zero-token model");
        assert_eq!(day.tokens(), 36_782_950);

        let w = l.watermarks.get("work-mt9x10cf").unwrap();
        assert_eq!(w.ts, 1_787_741_600_445);
        assert_eq!(w.size, 792_246);
        assert_eq!(l.watermarks.len(), 2);
    }

    /// Parse → re-serialize → parse again must be a fixed point. This is what
    /// guarantees a Rust archive pass cannot erode a Java-written shard.
    #[test]
    fn java_written_shard_round_trips_semantically() {
        let first: MonthLedger = serde_json::from_str(JAVA_WRITTEN_SHARD).unwrap();
        let bytes = serde_json::to_vec(&first).unwrap();
        let second: MonthLedger = serde_json::from_slice(&bytes).unwrap();

        assert_eq!(first.month, second.month);
        assert_eq!(first.days.len(), second.days.len());
        assert_eq!(first.watermarks, second.watermarks);

        let (d1, d2) = (first.days.get("2026-08-20").unwrap(), second.days.get("2026-08-20").unwrap());
        assert_eq!(d1, d2, "day content must be byte-for-byte equivalent after a round trip");
        assert_eq!(d1.models.keys().collect::<Vec<_>>(), d2.models.keys().collect::<Vec<_>>(),
            "model insertion order must survive (IndexMap, not BTreeMap)");
    }

    /// The Rust writer must not emit keys Java does not understand, and must not
    /// rename the ones it does write. Guards the serde renames
    /// (`cacheRead` / `cacheCreation`) against a future refactor.
    #[test]
    fn serialized_shard_uses_the_java_key_names() {
        let l: MonthLedger = serde_json::from_str(JAVA_WRITTEN_SHARD).unwrap();
        let json = serde_json::to_string(&l).unwrap();

        for key in [
            "\"month\"", "\"days\"", "\"watermarks\"", "\"messages\"", "\"sessions\"",
            "\"models\"", "\"tokens\"", "\"input\"", "\"output\"", "\"cacheRead\"",
            "\"cacheCreation\"", "\"rounds\"", "\"uid\"", "\"ts\"", "\"size\"",
        ] {
            assert!(json.contains(key), "missing wire key {key}");
        }
        // Rust-side field names must never leak onto the wire.
        for bad in ["cache_read", "cache_creation", "dirty"] {
            assert!(!json.contains(bad), "internal field {bad} leaked into the shared file");
        }
    }

    /// A shard written by Rust must be readable by the query path and produce
    /// the same totals Java would report for it.
    #[test]
    fn java_shard_is_readable_through_the_query_path() {
        let s = Scratch::new("interop");
        std::fs::write(
            ledger_file(&s.paths, "2026-08"),
            JAVA_WRITTEN_SHARD.as_bytes(),
        )
        .unwrap();

        let from = NaiveDate::from_ymd_opt(2026, 8, 1).unwrap();
        let to = NaiveDate::from_ymd_opt(2026, 8, 31).unwrap();
        let days = load(&s.paths, from, to);

        let d = days.get(&NaiveDate::from_ymd_opt(2026, 8, 20).unwrap()).unwrap();
        assert_eq!(d.tokens(), 36_782_950);
        assert_eq!(d.messages, 59);
        assert_eq!(d.sessions.len(), 3);

        // list_months must see the Java-written shard.
        assert_eq!(list_months(&s.paths), vec!["2026-08".to_string()]);
    }

    /// Archiving over a Java-written shard must preserve its existing days and
    /// watermarks while adding new activity — not replace the file.
    #[test]
    fn archiving_preserves_existing_java_data() {
        let s = Scratch::new("preserve");
        std::fs::write(ledger_file(&s.paths, "2026-08"), JAVA_WRITTEN_SHARD.as_bytes()).unwrap();

        // New activity today, in a different shard.
        let day = Local::now().date_naive();
        s.session("work-new1", &[s.trace("m1", 5, 5, ms_for(day))]);
        s.archive();

        // The Java shard must be untouched.
        let aug = read_ledger(&s.paths, "2026-08");
        assert_eq!(aug.days.get("2026-08-20").unwrap().tokens(), 36_782_950);
        assert_eq!(aug.watermarks.len(), 2, "Java watermarks must survive a Rust archive pass");
        assert_eq!(
            aug.watermarks.get("work-mt5l5jjn").unwrap().size,
            1529,
            "watermark values must not be altered"
        );

        // And the new day is present.
        assert_eq!(s.all().get(&day).unwrap().tokens(), 10);
    }
}
