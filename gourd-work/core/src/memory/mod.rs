//! memory — Long-term memory store, compatible with the Java kernel's
//! `MemoryMdData` on-disk format.
//!
//! ## Storage format is the contract
//!
//! Entries are **Markdown files with a YAML front matter**, one per entry:
//!
//! ```text
//! <memory dir>/shared__<key>.md
//! ---
//! name: "shared__<key>"
//! title: "…"
//! time: "2026-10-19 18:03:24"
//! importance: 9
//! ttl: 2592000
//! stored_at: "2026-10-19 18:03:24"
//! ---
//!
//! <fact body>
//! ```
//!
//! An earlier version of this module invented its own `<key>.json` format. That
//! compiled, passed its own tests, and returned HTTP 200 — while reading **zero**
//! of the 160 real entries on disk, so the memory page was permanently empty and
//! the agent's long-term memory was silently gone. Both kernels share
//! `~/.gwork/memory` and `<project>/.gwork/memory`, so the format is not a
//! private choice.
//!
//! ## Domains
//!
//! - workspace: `<project root>/.gwork/memory/`
//! - global:    `~/.gwork/memory/`
//!
//! When `general.memoryIsolation` is false the workspace scope is *aliased* to
//! global (Java `memoryList` reports this via `aliased`/`effectiveScope`, and the
//! UI shows a hint instead of a second, contradictory list).
//!
//! ## Keys
//!
//! The Java store namespaces every entry by user; the desktop single-user build
//! always uses `shared`, so the store key is `shared__<key>` and that is also the
//! file stem. The `name` field inside the front matter is authoritative — a file
//! whose `name` disagrees with its path is skipped rather than trusted, matching
//! `MemoryMdData.loadSingleFile`.

use std::path::{Path, PathBuf};

use chrono::NaiveDateTime;

use crate::config::Settings;

/// Run a blocking closure **off** the async worker thread.
///
/// WHY THIS EXISTS (measured pattern, not guessed): `load_all` does a `read_dir`
/// plus a `read_to_string` + front-matter parse of **every** `.md` entry, and it
/// deletes expired ones on sight. It is called from `server::build_memory_preview`
/// inline while building the system prompt — i.e. on the hot path of *every chat
/// turn*, on a tokio worker.
///
/// Blocking a worker stalls every other task pinned to it. The measured shape of
/// that failure elsewhere in this repo: `/web/chat/meta` going 0.23 ms → 85.85 ms
/// under 8 concurrent blocking requests, and 1 ms → 2178 ms during a `usage/stats`
/// scan. The memory directory holds ~160 entries on the developer machine.
///
/// `block_in_place` rather than `spawn_blocking` because this module's API is
/// synchronous. Note `chat_memory_list` already wraps `load_all` in
/// `spawn_blocking`; nesting `block_in_place` inside a blocking-pool thread is
/// safe (verified: it does not panic), so both call sites are covered by this one
/// change. It panics on a `current_thread` runtime, hence the flavour check —
/// outside a multi-thread runtime the closure runs inline, as before.
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

/// Front-matter delimiter (Java `FRONT_MATTER_DELIMITER`).
const DELIMITER: &str = "---";

/// Namespace used by the single-user desktop build.
const USER_SHARED: &str = "shared";

/// Front matter timestamp format (Java `FORMATTER`).
const TIME_FORMAT: &str = "%Y-%m-%d %H:%M:%S";

/// Default TTL in seconds when a file omits it (30 days, Java parity).
const DEFAULT_TTL: i64 = 2_592_000;

/// A single memory entry.
#[derive(Debug, Clone, PartialEq)]
pub struct MemoryEntry {
    /// Key without the `shared__` namespace prefix.
    pub key: String,
    pub title: String,
    /// Fact body (the Markdown after the front matter).
    pub content: String,
    pub importance: i64,
    /// Fact time as written in the front matter (display string).
    pub time: String,
    /// TTL in seconds; negative means "never expires".
    pub ttl: i64,
    /// Whether an expiry could be determined at all (needs a parsable
    /// `stored_at`). The UI renders "unknown" rather than a bogus countdown.
    pub ttl_known: bool,
    /// Absolute expiry in epoch millis, when known and finite.
    pub expires_at_epoch_ms: Option<i64>,
}

/// Memory store bound to one domain directory.
pub struct MemoryStore {
    dir: PathBuf,
}

impl MemoryStore {
    /// Global memory store (`~/.gwork/memory`).
    pub fn global() -> Self {
        Self { dir: Settings::gwork_home().join("memory") }
    }

    /// Workspace-scoped memory store (`<workspace>/.gwork/memory`).
    pub fn workspace(workspace: &Path) -> Self {
        Self { dir: workspace.join(".gwork").join("memory") }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn ensure_dir(&self) {
        let _ = std::fs::create_dir_all(&self.dir);
    }

    /// File path for a key, guaranteed to stay inside the store directory.
    ///
    /// Keys come from HTTP input, so the store key is sanitized before it is
    /// joined; without this, `key=../../x` would write outside the memory dir.
    fn file_for(&self, key: &str) -> Option<PathBuf> {
        let store_key = store_key_of(key)?;
        let path = self.dir.join(format!("{}.md", store_key));
        // Belt and braces: the sanitized key cannot contain a separator, but the
        // containment check keeps the invariant local and testable.
        if path.parent()? != self.dir {
            return None;
        }
        Some(path)
    }

    /// Store or overwrite an entry.
    pub fn store(&self, entry: &MemoryEntry) -> anyhow::Result<()> {
        let Some(path) = self.file_for(&entry.key) else {
            anyhow::bail!("invalid memory key: {:?}", entry.key);
        };
        self.ensure_dir();
        let md = build_md(entry);
        // Write via a temp file then rename, so a crash mid-write cannot leave a
        // truncated entry that later parses as empty (Java does the same).
        let tmp = self.dir.join(format!(".{}.tmp", sanitize_segment(&store_key_of(&entry.key).unwrap_or_default())));
        std::fs::write(&tmp, md)?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    /// Load every non-expired entry, highest importance first.
    ///
    /// Expired entries are deleted on sight, matching the Java loader: leaving
    /// them on disk would make the count shown in the UI disagree with what a
    /// later load returns.
    pub fn load_all(&self) -> Vec<MemoryEntry> {
        let dir = self.dir.clone();
        offload(move || {
            let mut entries = Vec::new();
            let Ok(rd) = std::fs::read_dir(&dir) else { return entries };
            for e in rd.flatten() {
                let p = e.path();
                if !p.is_file() {
                    continue;
                }
                if p.extension().map(|x| x != "md").unwrap_or(true) {
                    continue;
                }
                match load_file(&p) {
                    LoadOutcome::Entry(entry) => entries.push(entry),
                    LoadOutcome::Expired => {
                        let _ = std::fs::remove_file(&p);
                    }
                    LoadOutcome::Skipped => {}
                }
            }
            // Importance desc, then newest first — a stable, useful ordering for the
            // UI list (Java's searcher orders by relevance, which needs the index we
            // do not build; importance is the closest stable proxy).
            entries.sort_by(|a, b| {
                b.importance
                    .cmp(&a.importance)
                    .then_with(|| b.time.cmp(&a.time))
                    .then_with(|| a.key.cmp(&b.key))
            });
            entries
        })
    }

    /// Keyword search across key/title/content. `"*"` lists everything.
    pub fn search(&self, query: &str, top_k: usize) -> Vec<MemoryEntry> {
        let all = self.load_all();
        if query == "*" || query.trim().is_empty() {
            return all.into_iter().take(top_k).collect();
        }
        let q = query.to_lowercase();
        all.into_iter()
            .filter(|e| {
                e.key.to_lowercase().contains(&q)
                    || e.title.to_lowercase().contains(&q)
                    || e.content.to_lowercase().contains(&q)
            })
            .take(top_k)
            .collect()
    }

    /// Delete an entry by key. Returns true when a file was removed.
    pub fn delete(&self, key: &str) -> bool {
        let Some(path) = self.file_for(key) else { return false };
        std::fs::remove_file(&path).is_ok()
    }

    /// Number of entries (used for the `total` field, which counts everything
    /// while `items` may be capped).
    pub fn count(&self) -> usize {
        self.load_all().len()
    }
}

enum LoadOutcome {
    Entry(MemoryEntry),
    Expired,
    Skipped,
}

/// Parse one memory file.
fn load_file(path: &Path) -> LoadOutcome {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return LoadOutcome::Skipped;
    };
    let Some((meta, content)) = split_front_matter(&raw) else {
        return LoadOutcome::Skipped;
    };
    if content.trim().is_empty() {
        return LoadOutcome::Skipped;
    }

    let file_stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();

    // `name` is authoritative; fall back to the file name for legacy files that
    // predate the field (Java logs a warning and does the same).
    let store_key = meta.get("name").cloned().unwrap_or_else(|| file_stem.clone());
    if store_key != file_stem {
        // A file whose declared name disagrees with its path is not ours to
        // serve: Java skips it rather than exposing a key that cannot be
        // re-resolved to this file (delete/update would target the wrong path).
        return LoadOutcome::Skipped;
    }
    let Some(key) = strip_namespace(&store_key) else {
        return LoadOutcome::Skipped;
    };

    let importance = meta.get("importance").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
    let ttl = meta.get("ttl").and_then(|v| v.parse::<i64>().ok()).unwrap_or(DEFAULT_TTL);
    let time = meta.get("time").cloned().unwrap_or_default();

    // stored_at falls back to `time`, then to the file mtime (Java
    // `resolveStoredTime`), so legacy entries still get a usable expiry.
    let stored_at = meta
        .get("stored_at")
        .filter(|s| parse_time(s).is_some())
        .or_else(|| meta.get("time").filter(|s| parse_time(s).is_some()))
        .cloned()
        .or_else(|| mtime_string(path));

    let expires_at_epoch_ms = stored_at.as_deref().and_then(|s| expires_at(ttl, s));
    if let Some(exp) = expires_at_epoch_ms {
        if now_millis() >= exp {
            return LoadOutcome::Expired;
        }
    }

    let title = meta
        .get("title")
        .filter(|t| !t.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| derive_title(&content));

    LoadOutcome::Entry(MemoryEntry {
        key,
        title,
        content: content.trim().to_string(),
        importance,
        time,
        ttl,
        ttl_known: expires_at_epoch_ms.is_some() || ttl < 0,
        expires_at_epoch_ms,
    })
}

/// Split `---\n<yaml>\n---\n\n<body>` into (metadata map, body).
///
/// Only the **first** closing delimiter ends the front matter, and it must appear
/// within the leading block; a `---` inside the body (a Markdown horizontal rule,
/// or a diff separator in a stored fact) must not truncate the entry.
fn split_front_matter(raw: &str) -> Option<(std::collections::HashMap<String, String>, String)> {
    let mut lines = raw.split_inclusive('\n');
    let first = lines.next()?.trim_end_matches(['\r', '\n']);
    if first != DELIMITER {
        return None;
    }

    let mut meta = std::collections::HashMap::new();
    let mut rest = String::new();
    let mut closed = false;
    // Bound the header scan: a file with no closing delimiter is not a memory
    // entry, and scanning megabytes of body text for one would be wasteful.
    for (i, line) in lines.by_ref().enumerate() {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if !closed && trimmed == DELIMITER {
            closed = true;
            continue;
        }
        if !closed {
            if i > 64 {
                return None;
            }
            if let Some((k, v)) = split_yaml_line(trimmed) {
                meta.insert(k, v);
            }
        } else {
            rest.push_str(line);
        }
    }
    if !closed {
        return None;
    }
    // Drop the single blank line that separates the header from the body.
    let body = rest.strip_prefix('\n').unwrap_or(&rest).to_string();
    Some((meta, body))
}

/// Parse one `key: value` front-matter line, undoing the writer's escaping.
fn split_yaml_line(line: &str) -> Option<(String, String)> {
    let (k, v) = line.split_once(':')?;
    let k = k.trim().to_string();
    if k.is_empty() {
        return None;
    }
    Some((k, unquote(v.trim())))
}

/// Strip surrounding quotes and unescape `\\` and `\"` (Java `escapeYaml` inverse).
fn unquote(v: &str) -> String {
    let body = if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
        &v[1..v.len() - 1]
    } else {
        v
    };
    let mut out = String::with_capacity(body.len());
    let mut chars = body.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('\\') => out.push('\\'),
                Some('"') => out.push('"'),
                Some('n') => out.push('\n'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Escape a value for the front matter (Java `escapeYaml`).
fn escape_yaml(v: &str) -> String {
    v.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Build the file text for an entry.
fn build_md(entry: &MemoryEntry) -> String {
    let store_key = store_key_of(&entry.key).unwrap_or_else(|| entry.key.clone());
    let stored_at = entry.time.clone();
    let mut s = String::new();
    s.push_str(DELIMITER);
    s.push('\n');
    s.push_str(&format!("name: \"{}\"\n", escape_yaml(&store_key)));
    s.push_str(&format!("title: \"{}\"\n", escape_yaml(&entry.title)));
    s.push_str(&format!("time: \"{}\"\n", escape_yaml(&entry.time)));
    s.push_str(&format!("importance: {}\n", entry.importance));
    s.push_str(&format!("ttl: {}\n", entry.ttl));
    s.push_str(&format!("stored_at: \"{}\"\n", escape_yaml(&stored_at)));
    s.push_str(DELIMITER);
    s.push_str("\n\n");
    s.push_str(&entry.content);
    s.push('\n');
    s
}

/// `key` → `shared__key`, or None when the key is unusable.
fn store_key_of(key: &str) -> Option<String> {
    let k = key.trim();
    if k.is_empty() {
        return None;
    }
    let safe = sanitize_segment(k);
    if safe.is_empty() {
        return None;
    }
    Some(format!("{}__{}", USER_SHARED, safe))
}

/// `shared__key` → `key`; None when the namespace is absent or malformed.
fn strip_namespace(store_key: &str) -> Option<String> {
    let (user, key) = store_key.split_once("__")?;
    if user.is_empty() || key.is_empty() {
        return None;
    }
    Some(key.to_string())
}

/// Neutralize path separators and traversal so a key can never escape the store
/// directory. Unlike the session-id sanitizer this also maps `:` (keys are
/// namespaced with it in multi-user setups) because Windows forbids it in names.
fn sanitize_segment(key: &str) -> String {
    let mut out: String = key
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => "_".chars().next().unwrap(),
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    while out.contains("..") {
        out = out.replace("..", "_");
    }
    out.chars().take(128).collect()
}

/// First non-empty body line, trimmed — the fallback title (Java
/// `MemoryTitles.resolve`).
fn derive_title(content: &str) -> String {
    content
        .lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .chars()
        .take(60)
        .collect()
}

fn parse_time(s: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(s.trim(), TIME_FORMAT).ok()
}

/// `stored_at + ttl` in epoch millis; None when ttl is negative (never expires)
/// or the timestamp cannot be parsed.
fn expires_at(ttl: i64, stored_at: &str) -> Option<i64> {
    if ttl < 0 {
        return None;
    }
    let dt = parse_time(stored_at)?;
    let millis = dt
        .and_local_timezone(chrono::Local)
        .single()
        .map(|z| z.timestamp_millis())
        .or_else(|| Some(dt.and_utc().timestamp_millis()))?;
    Some(millis + ttl * 1000)
}

fn mtime_string(path: &Path) -> Option<String> {
    let md = std::fs::metadata(path).ok()?;
    let t = md.modified().ok()?;
    let dt: chrono::DateTime<chrono::Local> = t.into();
    Some(dt.format(TIME_FORMAT).to_string())
}

fn now_millis() -> i64 {
    chrono::Local::now().timestamp_millis()
}

/// Format the current time the way the front matter expects.
pub fn now_string() -> String {
    chrono::Local::now().format(TIME_FORMAT).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("gwork-memory-{}-{}", tag, std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn store(&self) -> MemoryStore {
            MemoryStore { dir: self.0.clone() }
        }
        fn write_raw(&self, file_name: &str, body: &str) {
            std::fs::write(self.0.join(file_name), body).unwrap();
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// The exact on-disk shape the Java kernel writes. If this stops parsing, the
    /// memory page goes empty again — the regression this module was rewritten for.
    #[test]
    fn parses_the_java_front_matter_format() {
        let s = Scratch::new("parse");
        s.write_raw(
            "shared__my_key.md",
            "---\nname: \"shared__my_key\"\ntitle: \"墙钟codereview\"\ntime: \"2026-10-19 18:03:24\"\nimportance: 9\nttl: 2592000\nstored_at: \"2026-10-19 18:03:24\"\n---\n\n【正文】第一行\n第二行\n",
        );

        let all = s.store().load_all();
        assert_eq!(all.len(), 1, "the real on-disk entry must be readable");
        let e = &all[0];
        assert_eq!(e.key, "my_key");
        assert_eq!(e.title, "墙钟codereview");
        assert_eq!(e.importance, 9);
        assert_eq!(e.ttl, 2592000);
        assert_eq!(e.time, "2026-10-19 18:03:24");
        assert!(e.content.starts_with("【正文】第一行"), "content={:?}", e.content);
        assert!(e.content.contains("第二行"), "multi-line body must survive");
    }

    /// A `---` inside the body (Markdown rule / diff separator) must not end the
    /// front matter or truncate the fact.
    #[test]
    fn body_delimiter_does_not_truncate_the_entry() {
        let s = Scratch::new("body-delim");
        s.write_raw(
            "shared__k.md",
            "---\nname: \"shared__k\"\ntitle: \"t\"\ntime: \"2026-01-01 00:00:00\"\nimportance: 5\nttl: -1\nstored_at: \"2026-01-01 00:00:00\"\n---\n\nbefore\n\n---\n\nafter\n",
        );
        let all = s.store().load_all();
        assert_eq!(all.len(), 1);
        assert!(all[0].content.contains("before"));
        assert!(all[0].content.contains("after"), "body after a `---` rule was lost: {:?}", all[0].content);
    }

    #[test]
    fn quoted_values_are_unescaped() {
        let s = Scratch::new("unescape");
        s.write_raw(
            "shared__k.md",
            "---\nname: \"shared__k\"\ntitle: \"a \\\"quoted\\\" \\\\ title\"\ntime: \"2026-01-01 00:00:00\"\nimportance: 3\nttl: -1\n---\n\nbody\n",
        );
        let all = s.store().load_all();
        assert_eq!(all[0].title, "a \"quoted\" \\ title");
    }

    /// `ttl: -1` means permanent: known, but with no expiry instant.
    #[test]
    fn negative_ttl_is_permanent_and_known() {
        let s = Scratch::new("ttl-neg");
        s.write_raw(
            "shared__k.md",
            "---\nname: \"shared__k\"\ntitle: \"t\"\ntime: \"2020-01-01 00:00:00\"\nimportance: 1\nttl: -1\nstored_at: \"2020-01-01 00:00:00\"\n---\n\nbody\n",
        );
        let all = s.store().load_all();
        assert_eq!(all.len(), 1, "a permanent entry must never expire");
        assert_eq!(all[0].ttl, -1);
        assert!(all[0].ttl_known);
        assert_eq!(all[0].expires_at_epoch_ms, None);
    }

    /// Expired entries are dropped **and deleted**, matching the Java loader.
    #[test]
    fn expired_entry_is_dropped_and_deleted() {
        let s = Scratch::new("expired");
        s.write_raw(
            "shared__old.md",
            "---\nname: \"shared__old\"\ntitle: \"t\"\ntime: \"2000-01-01 00:00:00\"\nimportance: 1\nttl: 60\nstored_at: \"2000-01-01 00:00:00\"\n---\n\nbody\n",
        );
        assert!(s.0.join("shared__old.md").exists());
        let all = s.store().load_all();
        assert!(all.is_empty(), "expired entry must not be listed");
        assert!(!s.0.join("shared__old.md").exists(), "expired file must be cleaned up");
    }

    /// A live entry with a future expiry reports a usable countdown.
    #[test]
    fn live_entry_reports_expiry() {
        let s = Scratch::new("live");
        let future = (chrono::Local::now() + chrono::Duration::days(10)).format(TIME_FORMAT).to_string();
        s.write_raw(
            "shared__k.md",
            &format!(
                "---\nname: \"shared__k\"\ntitle: \"t\"\ntime: \"{t}\"\nimportance: 1\nttl: 86400\nstored_at: \"{t}\"\n---\n\nbody\n",
                t = future
            ),
        );
        let all = s.store().load_all();
        assert_eq!(all.len(), 1);
        assert!(all[0].ttl_known);
        let exp = all[0].expires_at_epoch_ms.expect("expiry must be known");
        assert!(exp > now_millis(), "expiry should be in the future");
    }

    /// `stored_at` missing → fall back to `time` (legacy files).
    #[test]
    fn stored_at_falls_back_to_time() {
        let s = Scratch::new("fallback");
        s.write_raw(
            "shared__k.md",
            "---\nname: \"shared__k\"\ntitle: \"t\"\ntime: \"2000-01-01 00:00:00\"\nimportance: 1\nttl: 60\n---\n\nbody\n",
        );
        assert!(s.store().load_all().is_empty(), "must expire via the `time` fallback");
    }

    #[test]
    fn files_without_front_matter_are_skipped() {
        let s = Scratch::new("no-fm");
        s.write_raw("shared__k.md", "just prose, no front matter\n");
        s.write_raw("README.md", "# not a memory\n");
        assert!(s.store().load_all().is_empty());
    }

    /// A `name` that disagrees with the file path is skipped: serving it would
    /// expose a key that delete/update cannot resolve back to this file.
    #[test]
    fn mismatched_name_field_is_skipped() {
        let s = Scratch::new("mismatch");
        s.write_raw(
            "shared__real.md",
            "---\nname: \"shared__other\"\ntitle: \"t\"\ntime: \"2026-01-01 00:00:00\"\nimportance: 1\nttl: -1\n---\n\nbody\n",
        );
        assert!(s.store().load_all().is_empty());
    }

    /// Legacy files with no `name` field fall back to the file stem.
    #[test]
    fn legacy_file_without_name_uses_the_file_stem() {
        let s = Scratch::new("legacy");
        s.write_raw(
            "shared__legacy.md",
            "---\ntitle: \"old\"\ntime: \"2026-01-01 00:00:00\"\nimportance: 2\nttl: -1\n---\n\nbody\n",
        );
        let all = s.store().load_all();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].key, "legacy");
    }

    #[test]
    fn empty_content_is_skipped() {
        let s = Scratch::new("empty");
        s.write_raw(
            "shared__k.md",
            "---\nname: \"shared__k\"\ntitle: \"t\"\ntime: \"2026-01-01 00:00:00\"\nimportance: 1\nttl: -1\n---\n\n   \n",
        );
        assert!(s.store().load_all().is_empty());
    }

    #[test]
    fn title_falls_back_to_the_first_body_line() {
        let s = Scratch::new("title-fallback");
        s.write_raw(
            "shared__k.md",
            "---\nname: \"shared__k\"\ntime: \"2026-01-01 00:00:00\"\nimportance: 1\nttl: -1\n---\n\n第一行就是标题\n第二行\n",
        );
        let all = s.store().load_all();
        assert_eq!(all[0].title, "第一行就是标题");
    }

    #[test]
    fn entries_are_ordered_by_importance_desc() {
        let s = Scratch::new("order");
        for (k, imp) in [("a", 3), ("b", 9), ("c", 6)] {
            s.write_raw(
                &format!("shared__{}.md", k),
                &format!(
                    "---\nname: \"shared__{k}\"\ntitle: \"{k}\"\ntime: \"2026-01-01 00:00:00\"\nimportance: {imp}\nttl: -1\n---\n\nbody {k}\n",
                    k = k,
                    imp = imp
                ),
            );
        }
        let all = s.store().load_all();
        let keys: Vec<&str> = all.iter().map(|e| e.key.as_str()).collect();
        assert_eq!(keys, vec!["b", "c", "a"]);
    }

    /// Round-trip through the writer must produce a file the reader (and the Java
    /// kernel) accepts.
    #[test]
    fn store_then_load_round_trips() {
        let s = Scratch::new("roundtrip");
        let entry = MemoryEntry {
            key: "round_trip_key".into(),
            title: "含 \"引号\" 与 \\ 反斜杠".into(),
            content: "第一行\n第二行\n\n---\n\n分隔线之后".into(),
            importance: 7,
            time: now_string(),
            ttl: -1,
            ttl_known: true,
            expires_at_epoch_ms: None,
        };
        s.store().store(&entry).unwrap();

        let all = s.store().load_all();
        assert_eq!(all.len(), 1);
        let got = &all[0];
        assert_eq!(got.key, entry.key);
        assert_eq!(got.title, entry.title, "quotes/backslashes must survive escaping");
        assert_eq!(got.importance, 7);
        assert!(got.content.contains("分隔线之后"), "body after a rule must survive: {:?}", got.content);
    }

    #[test]
    fn delete_removes_the_entry() {
        let s = Scratch::new("delete");
        let entry = MemoryEntry {
            key: "del_me".into(),
            title: "t".into(),
            content: "body".into(),
            importance: 1,
            time: now_string(),
            ttl: -1,
            ttl_known: true,
            expires_at_epoch_ms: None,
        };
        s.store().store(&entry).unwrap();
        assert_eq!(s.store().load_all().len(), 1);
        assert!(s.store().delete("del_me"));
        assert!(s.store().load_all().is_empty());
        assert!(!s.store().delete("del_me"), "second delete finds nothing");
    }

    /// Keys arrive from HTTP; they must never escape the memory directory.
    #[test]
    fn traversal_keys_cannot_escape_the_store_dir() {
        let s = Scratch::new("traversal");
        for evil in ["../../escaped", "..\\..\\escaped", "a/b", "a\\b", "..", ""] {
            let entry = MemoryEntry {
                key: evil.into(),
                title: "t".into(),
                content: "body".into(),
                importance: 1,
                time: now_string(),
                ttl: -1,
                ttl_known: true,
                expires_at_epoch_ms: None,
            };
            // Empty key is rejected outright; the rest must land inside the dir.
            let _ = s.store().store(&entry);
            assert!(!s.0.parent().unwrap().join("escaped.md").exists());
        }
        for f in std::fs::read_dir(&s.0).unwrap().flatten() {
            assert_eq!(f.path().parent().unwrap(), s.0, "file written outside the store: {:?}", f.path());
        }
    }

    #[test]
    fn search_matches_key_title_and_content() {
        let s = Scratch::new("search");
        s.write_raw(
            "shared__alpha.md",
            "---\nname: \"shared__alpha\"\ntitle: \"构建脚本\"\ntime: \"2026-01-01 00:00:00\"\nimportance: 5\nttl: -1\n---\n\nnpm run build 的坑\n",
        );
        s.write_raw(
            "shared__beta.md",
            "---\nname: \"shared__beta\"\ntitle: \"无关\"\ntime: \"2026-01-01 00:00:00\"\nimportance: 5\nttl: -1\n---\n\n完全别的内容\n",
        );
        let store = s.store();
        assert_eq!(store.search("构建", 10).len(), 1, "title match");
        assert_eq!(store.search("npm", 10).len(), 1, "content match");
        assert_eq!(store.search("alpha", 10).len(), 1, "key match");
        assert_eq!(store.search("*", 10).len(), 2, "wildcard lists all");
        assert_eq!(store.search("*", 1).len(), 1, "top_k is honoured");
        assert!(store.search("不存在的词", 10).is_empty());
    }

    #[test]
    fn non_md_files_are_ignored() {
        let s = Scratch::new("non-md");
        s.write_raw("shared__k.json", "{\"key\":\"k\"}");
        s.write_raw("notes.txt", "hello");
        assert!(s.store().load_all().is_empty());
    }
}
