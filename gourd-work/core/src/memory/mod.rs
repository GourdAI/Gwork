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

    /// Recall one entry by its exact key — no search, no scoring.
    ///
    /// WHY THIS EXISTS: `memory_recall` used to be implemented as
    /// `search(key, 100).iter().find(|e| e.key == key)`, which stacked two
    /// independent failure modes into one indistinguishable
    /// "Memory not found: <key>" message:
    ///
    /// 1. the candidate list came from a substring search, so an entry whose
    ///    text does not contain the key verbatim never entered it — the lookup
    ///    could not see an entry that demonstrably exists on disk;
    /// 2. the final comparison demanded a byte-exact key, so a key that was
    ///    sanitized on the way in (`a:b` → `a_b`, or truncated at 128 chars)
    ///    never compared equal to what the reader parses back out of the file.
    ///
    /// Java's `MemoryMdData.get` is a map lookup by storeKey: O(1) and wholly
    /// independent of the search index. This is the same contract expressed
    /// against the filesystem — resolve the key to its file and read it.
    ///
    /// Expired entries are deleted on sight, matching `load_all`, so a `get`
    /// never reports a countdown the list would not show.
    pub fn get(&self, key: &str) -> Option<MemoryEntry> {
        let path = self.file_for(key)?;
        // `offload` takes the path by move (the closure may outlive this frame in
        // the `block_in_place` case), so the cleanup below works off a clone.
        let cleanup = path.clone();
        match offload(move || load_file(&path)) {
            LoadOutcome::Entry(entry) => Some(entry),
            LoadOutcome::Expired => {
                let _ = std::fs::remove_file(&cleanup);
                None
            }
            LoadOutcome::Skipped => None,
        }
    }

    /// Keyword search across key/title/content, scored and ranked.
    ///
    /// `"*"` (or a blank query) lists everything, highest importance first.
    ///
    /// WHY THIS IS NOT A SUBSTRING FILTER: the previous implementation
    /// lowercased the whole query and asked whether any one field *contained it
    /// verbatim*. A multi-word query — 「凭证级亲和 retryCodes 429 同渠道重试」 —
    /// then becomes a single substring that no entry can contain, so the tool
    /// answered "No matching memories found." over a library that held the
    /// entry. The model reads that as "I never stored this" and writes a
    /// duplicate, which is how the store grows entries nobody can find again.
    ///
    /// The replacement mirrors the Java kernel's `MemoryMdData`, because both
    /// kernels serve the same directory and must not disagree about what
    /// "found" means — a query that hits in one and misses in the other reads
    /// to the model as memories appearing and disappearing at random:
    ///
    /// * tokenize ([`tokenize`]): English/digit runs as whole words, CJK runs
    ///   as the full run plus every bi-gram, so 「构建」 finds 「构建脚本」 with no
    ///   segmenter and no dictionary;
    /// * score = hit rate × 0.7 + importance/10 × 0.3 — the same shape Java
    ///   uses. Key and title hits earn full credit and content hits 0.6: the
    ///   Java index covered *content only*, which is the "命中不准" half of the
    ///   complaint, since for these entries the identifying signal lives in the
    ///   title and the key;
    /// * a token that matches no field falls back to a plain substring probe at
    ///   0.3 credit, so one odd fragment demotes an entry instead of dropping it;
    /// * an exact key match is pinned above every scored result (2.0, above the
    ///   1.0 maximum): identifier lookups must not be out-ranked by prose that
    ///   happens to share words.
    pub fn search(&self, query: &str, top_k: usize) -> Vec<MemoryEntry> {
        let all = self.load_all();
        let trimmed = query.trim();
        if trimmed == "*" || trimmed.is_empty() {
            return all.into_iter().take(top_k).collect();
        }
        let q = trimmed.to_lowercase();
        let mut tokens = tokenize(&q);
        if tokens.is_empty() {
            // Nothing indexable (a lone ASCII letter, or pure punctuation): Java
            // scores this as zero hits and returns nothing at all. A substring
            // probe is strictly more useful and cannot invent an entry that does
            // not contain the text.
            tokens.insert(q.clone());
        }

        let mut scored: Vec<(f64, MemoryEntry)> = Vec::with_capacity(all.len());
        for entry in all {
            let score = score_entry(&entry, &q, &tokens);
            if score > 0.0 {
                scored.push((score, entry));
            }
        }
        // Score first; the rest is `load_all`'s ordering, so equal scores stay
        // deterministic instead of following directory order.
        scored.sort_by(|a, b| {
            b.0.partial_cmp(&a.0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.1.importance.cmp(&a.1.importance))
                .then_with(|| b.1.time.cmp(&a.1.time))
                .then_with(|| a.1.key.cmp(&b.1.key))
        });
        scored.into_iter().take(top_k).map(|(_, e)| e).collect()
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

/// Field weights for [`score_entry`].
///
/// `key` and `title` outrank `content` because they are written to *identify*
/// an entry, so a word landing there is a far stronger signal than the same word
/// buried in a long fact body. Java's index carried content only, which is why a
/// search for a term that appears solely in a title reported nothing.
const W_KEY: f64 = 1.0;
const W_TITLE: f64 = 1.0;
const W_CONTENT: f64 = 0.6;
/// A substring probe that matched no token. Weaker than any real hit, but it
/// still counts, so a single awkward fragment demotes rather than excludes.
const W_SUBSTRING: f64 = 0.3;
/// An exact key match is pinned to the top of the result list. Above 1.0 so no
/// combination of prose hits can out-rank it.
const SCORE_EXACT_KEY: f64 = 2.0;

/// Split text into matchable tokens, mirroring Java `MemoryMdData.tokenize`.
///
/// * ASCII letters and digits accumulate into runs; a run is kept only when it
///   is longer than one character, matching Java's `buf.length() > 1` rule.
/// * CJK runs yield the whole run *plus* every adjacent pair (bi-gram); a lone
///   CJK character yields itself. This is what makes 「构建」 match 「构建脚本」
///   with no dictionary and no segmenter.
/// * Anything else (spaces, punctuation, full-width marks) flushes both buffers.
///
/// The input must already be lowercase — this function lowercases nothing, so
/// feeding it mixed case would silently break matching.
fn tokenize(text: &str) -> std::collections::HashSet<String> {
    let mut tokens = std::collections::HashSet::new();
    let mut english = String::new();
    let mut cjk = String::new();

    for c in text.chars() {
        if is_cjk(c) {
            flush_english(&mut english, &mut tokens);
            cjk.push(c);
        } else if c.is_alphanumeric() {
            flush_cjk(&mut cjk, &mut tokens);
            english.push(c);
        } else {
            flush_english(&mut english, &mut tokens);
            flush_cjk(&mut cjk, &mut tokens);
        }
    }
    flush_english(&mut english, &mut tokens);
    flush_cjk(&mut cjk, &mut tokens);
    tokens
}

/// CJK Unified Ideographs, the range Java tests (`\u4e00`..=`\u9fff`).
fn is_cjk(c: char) -> bool {
    ('\u{4e00}'..='\u{9fff}').contains(&c)
}

fn flush_english(buf: &mut String, tokens: &mut std::collections::HashSet<String>) {
    // `chars().count()`, not `len()`: a multi-byte run is still one logical word.
    if buf.chars().count() > 1 {
        tokens.insert(std::mem::take(buf));
    } else {
        buf.clear();
    }
}

fn flush_cjk(buf: &mut String, tokens: &mut std::collections::HashSet<String>) {
    let chars: Vec<char> = buf.chars().collect();
    if chars.len() >= 2 {
        // Whole phrase first — it is what lets an exact multi-character query
        // out-score text that merely shares a bi-gram with it.
        tokens.insert(chars.iter().collect());
        for w in chars.windows(2) {
            tokens.insert(w.iter().collect());
        }
    } else if chars.len() == 1 {
        tokens.insert(chars[0].to_string());
    }
    buf.clear();
}

/// The three indexed fields of one entry, pre-tokenized.
///
/// Built per search, not cached on the entry: `MemoryEntry` is reconstructed from
/// disk on every `load_all`, so a cache field would be populated once and thrown
/// away with the struct. At this library size (~200 entries) tokenizing three
/// short strings per entry is far cheaper than the directory read that precedes it.
struct FieldTokens {
    key: std::collections::HashSet<String>,
    title: std::collections::HashSet<String>,
    content: std::collections::HashSet<String>,
}

impl FieldTokens {
    fn of(entry: &MemoryEntry) -> Self {
        Self {
            key: tokenize(&entry.key.to_lowercase()),
            title: tokenize(&entry.title.to_lowercase()),
            content: tokenize(&entry.content.to_lowercase()),
        }
    }
}

/// Score one entry against a tokenized query. See [`MemoryStore::search`] for the
/// reasoning behind each term.
///
/// Two phases, in the same order Java uses them, because they answer genuinely
/// different questions:
///
/// 1. **token equality** against each field's own token set — the precise channel.
///    Weighted by field (key/title beat content) so an identifying word outranks
///    the same word buried in a long fact body.
/// 2. **substring** probe, only for tokens phase 1 missed, at a reduced weight.
///    This is reachable, not vestigial: 「构建脚」 is a substring of 「构建脚本」 but is
///    not one of its bi-grams, so phase 1 cannot see it. Without this pass a
///    slightly-off query fragment would drop the entry to zero instead of demoting
///    it — the "找不到" half of the complaint.
fn score_entry(entry: &MemoryEntry, query_lower: &str, tokens: &std::collections::HashSet<String>) -> f64 {
    // Identifier lookups are pinned above every scored result. Checked before the
    // token math so a key like `a` (too short to tokenize) still resolves.
    if entry.key.eq_ignore_ascii_case(query_lower) {
        return SCORE_EXACT_KEY;
    }
    if tokens.is_empty() {
        return 0.0;
    }

    let fields = FieldTokens::of(entry);
    let key_lower = entry.key.to_lowercase();
    let title_lower = entry.title.to_lowercase();
    let content_lower = entry.content.to_lowercase();

    let mut credit = 0.0f64;
    for token in tokens {
        if fields.key.contains(token) {
            credit += W_KEY;
        } else if fields.title.contains(token) {
            credit += W_TITLE;
        } else if fields.content.contains(token) {
            credit += W_CONTENT;
        } else if key_lower.contains(token.as_str())
            || title_lower.contains(token.as_str())
            || content_lower.contains(token.as_str())
        {
            credit += W_SUBSTRING;
        }
    }
    if credit <= 0.0 {
        return 0.0;
    }

    // Normalised against the best possible outcome (every token hitting `key`),
    // so the rate stays in 0..=1 and the importance term keeps its intended share.
    let hit_rate = credit / (tokens.len() as f64 * W_KEY);
    let imp_weight = entry.importance.clamp(0, 10) as f64 / 10.0;
    hit_rate * 0.7 + imp_weight * 0.3
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
///
/// # This mapping is LOSSY and the two kernels do not agree on it
///
/// `sanitize_segment` below rewrites `:` (among others) to `_` and truncates at
/// 128 characters, so the caller's original key **cannot be recovered** from the
/// entry that comes back. Measured, not inferred:
///
/// ```text
/// store("a:b")            -> file shared__a_b.md
/// get("a:b").unwrap().key == "a_b"        // the `:` is gone for good
/// get("a_b").unwrap().key == "a_b"        // and the sanitized form reads back too
/// store_key_of(&"L".repeat(200))          // -> 136 chars (128 + "shared__")
/// ```
///
/// Java's `MemoryMdData.buildStoreKey` does the opposite: it concatenates
/// `userId + "__" + key` with **no sanitizing and no truncation**, relying on
/// `validateIdentity` to *reject* bad keys instead of rewriting them. That
/// validator does not reject `:`, so the same key maps to two different file
/// names — and on Windows `:` is not legal in a name, so Java throws where this
/// kernel silently renames:
///
/// ```text
/// [System.IO.File]::WriteAllText("shared__a:b.md", ..)
///   -> "The given path's format is not supported."   // measured on this host
/// ```
///
/// Unifying the storage layer would change on-disk file names, so it needs a
/// decision about migrating the existing library rather than a silent edit.
/// For now only the *search* semantics are shared across kernels; key → path is
/// not, and callers must not assume a key round-trips byte-for-byte.
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

    // ─── P0-1: exact-key recall must not depend on search ───────────────────

    /// The regression `get` exists for. A key is sanitized on the way in
    /// (`:` → `_`, because Windows forbids `:` in a file name), so the key read
    /// back out of the file is NOT the key the caller passed. The old recall did
    /// `search(key, 100).find(|e| e.key == key)` and that compare can never
    /// succeed here — the entry exists on disk, yet the tool answered
    /// "Memory not found: a:b".
    #[test]
    fn get_resolves_a_key_that_was_sanitized_on_the_way_in() {
        let s = Scratch::new("get-sanitized");
        let store = s.store();
        store
            .store(&entry_with("a:b", "标题", "正文内容"))
            .expect("write");

        // Proof the on-disk key really did change shape.
        let all = store.load_all();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].key, "a_b", "fixture: `:` must be sanitized to `_`");

        // The old lookup path: exact compare against what search returns.
        let via_search = store.search("a:b", 100).iter().any(|e| e.key == "a:b");
        assert!(!via_search, "old recall path cannot see this entry");

        // The new one.
        let got = store.get("a:b").expect("get must resolve the sanitized key");
        assert_eq!(got.title, "标题");
        assert_eq!(got.content, "正文内容");
    }

    /// Same failure, second trigger: keys longer than the 128-char filename cap
    /// are truncated when written, so the stored key no longer equals the
    /// requested one.
    #[test]
    fn get_resolves_a_key_truncated_by_the_filename_cap() {
        let s = Scratch::new("get-truncated");
        let store = s.store();
        let long_key = "k".repeat(200);
        store.store(&entry_with(&long_key, "t", "body")).expect("write");

        let stored = &store.load_all()[0].key;
        assert!(stored.len() < long_key.len(), "fixture: key must be truncated");

        let got = store.get(&long_key).expect("get must resolve the truncated key");
        assert_eq!(got.content, "body");
    }

    #[test]
    fn get_returns_none_for_absent_and_expired_keys() {
        let s = Scratch::new("get-miss");
        let store = s.store();
        assert!(store.get("never_stored").is_none());

        // An expired entry must not be recalled, and must be cleaned up — the
        // same rule `load_all` applies, so `get` cannot report a countdown the
        // list would not show.
        s.write_raw(
            "shared__old.md",
            "---\nname: \"shared__old\"\ntitle: \"t\"\ntime: \"2000-01-01 00:00:00\"\nimportance: 1\nttl: 60\nstored_at: \"2000-01-01 00:00:00\"\n---\n\nbody\n",
        );
        assert!(store.get("old").is_none(), "expired entry must not be recalled");
        assert!(!s.0.join("shared__old.md").exists(), "expired file must be cleaned up");
    }

    /// `get` must not resurrect an entry whose declared name disagrees with its
    /// path — the same rule `load_all` enforces.
    #[test]
    fn get_skips_a_file_whose_name_field_disagrees() {
        let s = Scratch::new("get-mismatch");
        s.write_raw(
            "shared__real.md",
            "---\nname: \"shared__other\"\ntitle: \"t\"\ntime: \"2026-01-01 00:00:00\"\nimportance: 1\nttl: -1\n---\n\nbody\n",
        );
        assert!(s.store().get("real").is_none());
    }

    // ─── P0-2: multi-word queries must not be one substring ─────────────────

    /// The exact shape of the reported failure: a mixed CJK/ASCII multi-word
    /// query. The old code lowercased the whole query and asked whether any
    /// field *contained it verbatim*, which no entry ever does — so the tool
    /// answered "No matching memories found." over a library holding the entry,
    /// and the model concluded it had never stored it.
    #[test]
    fn multi_word_query_finds_the_entry_the_substring_filter_missed() {
        let s = Scratch::new("multiword");
        s.write_raw(
            "shared__credential_affinity.md",
            "---\nname: \"shared__credential_affinity\"\ntitle: \"凭证级亲和与重试\"\ntime: \"2026-01-01 00:00:00\"\nimportance: 8\nttl: -1\n---\n\nretryCodes 命中 429 与 529 时走同渠道重试。\n",
        );
        let store = s.store();

        let query = "凭证级亲和 retryCodes 429 529 同渠道重试 状态码";
        // The whole query is not a substring of anything — proof the old
        // behaviour was a guaranteed miss, not a ranking accident.
        let e = &store.load_all()[0];
        assert!(!e.content.to_lowercase().contains(&query.to_lowercase()));
        assert!(!e.title.to_lowercase().contains(&query.to_lowercase()));

        let hits = store.search(query, 10);
        assert_eq!(hits.len(), 1, "multi-word query must find the entry");
        assert_eq!(hits[0].key, "credential_affinity");
    }

    /// Every word of a multi-word query contributes: an entry matching more of
    /// them ranks above one matching fewer. Without this, "found something" and
    /// "found the right thing" are the same answer.
    #[test]
    fn more_matching_words_rank_higher() {
        let s = Scratch::new("ranking");
        s.write_raw(
            "shared__one.md",
            "---\nname: \"shared__one\"\ntitle: \"只提到构建\"\ntime: \"2026-01-01 00:00:00\"\nimportance: 5\nttl: -1\n---\n\n构建相关。\n",
        );
        s.write_raw(
            "shared__two.md",
            "---\nname: \"shared__two\"\ntitle: \"构建脚本与缓存\"\ntime: \"2026-01-01 00:00:00\"\nimportance: 5\nttl: -1\n---\n\n构建时清理缓存。\n",
        );
        let hits = s.store().search("构建 缓存", 10);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].key, "two", "the entry matching both words must rank first");
    }

    /// An exact key match is pinned above prose that shares more words. This is
    /// the "identifier lookup" channel: a model recalling a key it was just told
    /// must get that entry, not a thematically similar one.
    #[test]
    fn exact_key_match_outranks_prose_hits() {
        let s = Scratch::new("pin");
        s.write_raw(
            "shared__build_cache.md",
            "---\nname: \"shared__build_cache\"\ntitle: \"无关标题\"\ntime: \"2026-01-01 00:00:00\"\nimportance: 1\nttl: -1\n---\n\n只有一行。\n",
        );
        s.write_raw(
            "shared__other.md",
            "---\nname: \"shared__other\"\ntitle: \"构建缓存构建缓存构建缓存\"\ntime: \"2026-01-01 00:00:00\"\nimportance: 10\nttl: -1\n---\n\n构建缓存构建缓存构建缓存，反复提到构建和缓存。\n",
        );
        let hits = s.store().search("build_cache", 10);
        assert!(!hits.is_empty());
        assert_eq!(hits[0].key, "build_cache", "exact key must win over a higher-scoring prose match");
    }

    /// A word that appears only in the title must be findable. This is the Java
    /// kernel's gap (its index covered content alone) reproduced on the Rust
    /// side, where it was already searchable — kept as a cross-kernel contract
    /// test so the two cannot drift apart again.
    #[test]
    fn title_only_term_is_found() {
        let s = Scratch::new("title-only");
        s.write_raw(
            "shared__k.md",
            "---\nname: \"shared__k\"\ntitle: \"滚动条统一方案\"\ntime: \"2026-01-01 00:00:00\"\nimportance: 6\nttl: -1\n---\n\n正文完全没有提到那个词。\n",
        );
        let hits = s.store().search("滚动条统一", 10);
        assert_eq!(hits.len(), 1, "a title-only term must be findable");
    }

    /// A slightly-off fragment demotes instead of dropping. 「构建脚」 is a
    /// substring of 「构建脚本」 but is not one of its bi-grams, so token matching
    /// alone scores it zero — the substring pass is what keeps it in the list.
    #[test]
    fn partial_fragment_demotes_rather_than_drops() {
        let s = Scratch::new("partial");
        s.write_raw(
            "shared__a.md",
            "---\nname: \"shared__a\"\ntitle: \"构建脚本\"\ntime: \"2026-01-01 00:00:00\"\nimportance: 5\nttl: -1\n---\n\nbody\n",
        );
        s.write_raw(
            "shared__b.md",
            "---\nname: \"shared__b\"\ntitle: \"构建\"\ntime: \"2026-01-01 00:00:00\"\nimportance: 5\nttl: -1\n---\n\nbody\n",
        );
        let hits = s.store().search("构建脚", 10);
        assert!(!hits.is_empty(), "a near-miss fragment must still find the entry");
        assert_eq!(hits[0].key, "a", "the closer match ranks first");
    }

    /// A query with nothing indexable (a lone ASCII letter — Java drops runs of
    /// length 1) must not silently return empty; it falls back to a substring
    /// probe, matching the Rust/Java contract.
    #[test]
    fn single_character_query_falls_back_to_substring() {
        let s = Scratch::new("single-char");
        s.write_raw(
            "shared__k.md",
            "---\nname: \"shared__k\"\ntitle: \"abc\"\ntime: \"2026-01-01 00:00:00\"\nimportance: 5\nttl: -1\n---\n\nbody\n",
        );
        assert_eq!(s.store().search("b", 10).len(), 1);
    }

    /// Equal scores must not follow directory order, or the same query returns a
    /// different ranking on each call and memories appear to shuffle.
    #[test]
    fn equal_scores_are_ordered_deterministically() {
        let s = Scratch::new("determinism");
        for k in ["zzz", "aaa", "mmm"] {
            s.write_raw(
                &format!("shared__{}.md", k),
                &format!(
                    "---\nname: \"shared__{k}\"\ntitle: \"同样的标题\"\ntime: \"2026-01-01 00:00:00\"\nimportance: 5\nttl: -1\n---\n\n同样的正文\n",
                    k = k
                ),
            );
        }
        let store = s.store();
        let first: Vec<String> = store.search("同样", 10).iter().map(|e| e.key.clone()).collect();
        for _ in 0..3 {
            let again: Vec<String> = store.search("同样", 10).iter().map(|e| e.key.clone()).collect();
            assert_eq!(first, again, "ranking must be stable across calls");
        }
        assert_eq!(first, vec!["aaa", "mmm", "zzz"], "ties break on key, ascending");
    }

    /// `search` is case-insensitive; `get` is deliberately NOT.
    ///
    /// The asymmetry is the contract, not an oversight. `search` answers "what is
    /// relevant", where folding case only ever helps. `get` answers "give me this
    /// exact key", and Java's counterpart is a `Map.get(storeKey)` — case-sensitive
    /// by construction. Making `get` fold case here would let the two kernels
    /// disagree about whether a key exists, which is the failure class this whole
    /// change exists to remove. (On Windows the file would even be *found* by a
    /// differently-cased path, then rejected by the name/path agreement check —
    /// so the case-sensitive answer is also the only self-consistent one.)
    #[test]
    fn search_folds_case_but_get_does_not() {
        let s = Scratch::new("case");
        s.write_raw(
            "shared__mixed_case_key.md",
            "---\nname: \"shared__mixed_case_key\"\ntitle: \"Rust Kernel\"\ntime: \"2026-01-01 00:00:00\"\nimportance: 5\nttl: -1\n---\n\nTokio runtime notes.\n",
        );
        let store = s.store();
        assert_eq!(store.search("RUST KERNEL", 10).len(), 1, "search folds case");
        assert_eq!(store.search("tokio", 10).len(), 1);
        assert!(store.get("mixed_case_key").is_some(), "exact key resolves");
        assert!(store.get("MIXED_CASE_KEY").is_none(), "get stays case-sensitive, matching Java");
    }

    fn entry_with(key: &str, title: &str, content: &str) -> MemoryEntry {
        MemoryEntry {
            key: key.to_string(),
            title: title.to_string(),
            content: content.to_string(),
            importance: 5,
            time: now_string(),
            ttl: -1,
            ttl_known: true,
            expires_at_epoch_ms: None,
        }
    }

    #[test]
    fn non_md_files_are_ignored() {
        let s = Scratch::new("non-md");
        s.write_raw("shared__k.json", "{\"key\":\"k\"}");
        s.write_raw("notes.txt", "hello");
        assert!(s.store().load_all().is_empty());
    }
}

/// Real-corpus smoke, mirroring Java's `MemoryRealCorpusSmokeTest` on the **same
/// copied directory** with the **same judgements**.
///
/// Unit-test fixtures are entries I wrote to match the behaviour I expect, so
/// they can only prove "the code matches my assumption" — never that the
/// reported "命中不准 / 找不到" is actually gone. Only the real 190-entry library
/// can answer that.
///
/// Gated on `GWORK_SMOKE_DIR` so a normal `cargo test` is unaffected. **The path
/// must be a copy**: `load_all` deletes expired entries on sight, so pointing
/// this at the live store would silently destroy user data.
///
/// ```powershell
/// Copy-Item "D:\work\gourd\gourdai\.gwork\memory\*.md" $env:TEMP\gwork-smoke-real
/// $env:GWORK_SMOKE_DIR="$env:TEMP\gwork-smoke-real"
/// cargo test -p gourd-work-core --lib memory_real_corpus
/// ```
#[cfg(test)]
mod real_corpus_tests {
    use super::*;

    fn corpus_dir() -> Option<PathBuf> {
        let dir = std::env::var_os("GWORK_SMOKE_DIR")?;
        let p = PathBuf::from(dir);
        if p.is_dir() { Some(p) } else { None }
    }

    /// Open the copied corpus, or bail out of the test when unset.
    fn store() -> Option<MemoryStore> {
        corpus_dir().map(|dir| MemoryStore { dir })
    }

    /// Hand-off file between the two kernels' smokes, written by Java and read
    /// here so that `hit_miss_verdict_agrees_with_the_java_kernel` compares
    /// *measured* verdicts instead of a hard-coded guess at them.
    ///
    /// It lives inside the corpus copy, not in either build tree: both runs already
    /// agree on that directory via `GWORK_SMOKE_DIR`, so no second path convention
    /// has to be kept in sync.
    const VERDICTS_FILE: &str = "kernel-verdicts.txt";

    /// Terms to use as negative examples — but **only after** they are verified
    /// absent from the corpus at run time (see [`absent_term`]).
    ///
    /// This list was originally a hard-coded `ABSENT_TERMS` constant asserted
    /// directly, and that broke: `zzzqqqxxx` had been a made-up sentinel, and a
    /// later `memory_extract` wrote it into this very store as part of a lesson
    /// about the memory work. The term stopped being absent and the precision
    /// guard failed. A live memory store is not a fixture — any constant chosen
    /// as "a word that is not in here" will eventually be written into here.
    const CANDIDATE_ABSENT_TERMS: [&str; 5] =
        ["kubernetes", "terraform", "ansible", "zzqwkxfj", "qmvzbrtl"];

    /// Candidates for the second negative term in a multi-word query.
    const CANDIDATE_SECOND_TERMS: [&str; 4] = ["zzqwkxfj", "qmvzbrtl", "hxpwzndk", "vbqrjtsm"];

    /// Whole corpus, lowercased, for substring-based absence checks.
    fn corpus_text(store: &MemoryStore) -> String {
        let mut hay = String::new();
        for e in store.load_all() {
            hay.push_str(&e.key);
            hay.push('\n');
            hay.push_str(&e.title);
            hay.push('\n');
            hay.push_str(&e.content);
            hay.push('\n');
        }
        hay.to_lowercase()
    }

    /// A term verified to occur nowhere in the corpus, or `None`.
    fn absent_term(hay: &str, exclude: Option<&str>) -> Option<String> {
        CANDIDATE_ABSENT_TERMS
            .iter()
            .chain(CANDIDATE_SECOND_TERMS.iter())
            .find(|t| !hay.contains(**t) && Some(**t) != exclude)
            .map(|s| s.to_string())
    }

    /// An English word that really occurs in the corpus, for the counter-assertion.
    ///
    /// Without this, "returns nothing" could pass because search is broken
    /// outright rather than because precision holds. Mid-frequency is deliberate:
    /// a word in every file has no discriminating power, a word in one file may
    /// be noise.
    fn present_term(store: &MemoryStore) -> Option<String> {
        let mut freq: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for e in store.load_all() {
            for w in e
                .content
                .to_lowercase()
                .split(|c: char| !c.is_ascii_alphabetic())
                .filter(|w| (6..=12).contains(&w.len()))
            {
                *freq.entry(w.to_string()).or_insert(0) += 1;
            }
        }
        let mut hits: Vec<(String, usize)> =
            freq.into_iter().filter(|(_, n)| (10..=200).contains(n)).collect();
        // Sort so the choice is deterministic across runs.
        hits.sort();
        hits.into_iter().next().map(|(w, _)| w)
    }

    /// First run of ≥`min_len` consecutive CJK characters.
    ///
    /// Deliberately not an offset slice: slicing across a word boundary yields a
    /// fragment like `d-wo` from `gourd-work`, which tokenizes down to `wo` — a
    /// token present in 154/190 files, i.e. zero discriminating power.
    fn first_cjk_phrase(title: &str, min_len: usize) -> Option<String> {
        let mut run = String::new();
        for c in title.chars() {
            if is_cjk(c) {
                run.push(c);
            } else {
                if run.chars().count() >= min_len {
                    return Some(run);
                }
                run.clear();
            }
        }
        if run.chars().count() >= min_len { Some(run) } else { None }
    }

    /// First underscore-delimited key segment of at least `min_len` chars.
    fn first_long_key_segment(key: &str, min_len: usize) -> Option<String> {
        key.split('_').find(|p| p.chars().count() >= min_len).map(|s| s.to_string())
    }

    /// Guard: the corpus is real and fully readable. Without this, every "found"
    /// assertion below could pass vacuously against an empty store.
    ///
    /// # Order matters: load first, count after
    ///
    /// `load_all` deletes expired entries on sight. Counting the directory *before*
    /// calling it therefore races the clock: this test failed for real when an
    /// entry whose 30-day TTL lapsed at 16:27:07 was removed between the count and
    /// the load, so the assertion compared 191 against 190 while the code was
    /// correct. Counting after the load settles those deletions first, which makes
    /// the comparison race-free — nothing else deletes files here.
    #[test]
    fn corpus_is_fully_loaded() {
        let Some(store) = store() else { return };
        let dir = store.dir().to_path_buf();

        // Settle expiry deletions before taking the file count (see doc comment).
        let entries = store.load_all();
        let files = std::fs::read_dir(&dir)
            .map(|rd| rd.flatten().filter(|e| e.path().extension().map(|x| x == "md").unwrap_or(false)).count())
            .unwrap_or(0);

        assert!(files > 50, "expected a real corpus (>50 .md files), got {}", files);
        assert_eq!(entries.len(), files,
            "every .md file must load; a gap means entries are being silently skipped");
    }

    /// The reported failure, on real data: a mixed-script multi-word query.
    ///
    /// The old substring filter lowercased the whole query and required one field
    /// to contain it verbatim — impossible for any entry, so the tool answered
    /// "No matching memories found." over a library that held the memory.
    #[test]
    fn multi_word_mixed_script_query_finds_relevant_entries() {
        let Some(store) = store() else { return };
        let query = "codereview 变异测试 护栏 P0 修复";

        // Prove the query really is not a substring of anything, so a non-empty
        // result is attributable to tokenized scoring rather than luck.
        let verbatim = store.load_all().iter().any(|e| {
            let q = query.to_lowercase();
            e.content.to_lowercase().contains(&q) || e.title.to_lowercase().contains(&q)
        });
        assert!(!verbatim, "fixture check: the whole query must not appear verbatim");

        let hits = store.search(query, 10);
        assert!(!hits.is_empty(), "multi-word query must find something: {}", query);

        // Non-empty is not enough — the top hit has to be about the query, or the
        // change merely replaced "nothing" with "noise".
        let top = &hits[0];
        let hay = format!("{} {} {}", top.key, top.title, top.content).to_lowercase();
        assert!(
            hay.contains("codereview") || hay.contains("变异") || hay.contains("护栏"),
            "top1 must relate to the query, got: {} / {}",
            top.key,
            top.title
        );
    }

    /// Terms appearing **only in a title** must be findable. This is the core of
    /// the "命中不准" complaint: the identifying signal lives in the title and
    /// key, not the body.
    #[test]
    fn complete_cjk_title_phrases_recall_their_own_entry() {
        let Some(store) = store() else { return };
        let entries = store.load_all();
        let mut checked = 0;
        for e in &entries {
            let Some(probe) = first_cjk_phrase(&e.title, 3) else { continue };
            let hits = store.search(&probe, 20);
            assert!(
                hits.iter().any(|h| h.key == e.key),
                "CJK title phrase {:?} must recall its own entry: {} / {}",
                probe, e.key, e.title
            );
            checked += 1;
            if checked >= 30 { break; }
        }
        assert!(checked > 0, "expected to check some title phrases");
    }

    /// Key fragments are the strongest identifier signal; the old substring
    /// filter could match them only by accident (the key had to appear verbatim
    /// in some field, and the Java index did not cover keys at all).
    #[test]
    fn complete_key_fragments_recall_their_own_entry() {
        let Some(store) = store() else { return };
        let entries = store.load_all();
        let mut checked = 0;
        for e in &entries {
            let Some(probe) = first_long_key_segment(&e.key, 8) else { continue };
            let hits = store.search(&probe, 20);
            assert!(
                hits.iter().any(|h| h.key == e.key),
                "key fragment {:?} must recall its own entry: {}",
                probe, e.key
            );
            checked += 1;
            if checked >= 30 { break; }
        }
        assert!(checked > 0, "expected to check some key fragments");
    }

    /// The control experiment for the fragment case: a noisy cross-boundary probe
    /// is a *ranking* issue, not a miss. Without this, the two tests above could
    /// be misread as "only complete words work, fragments are lost".
    #[test]
    fn noisy_fragment_probe_is_a_ranking_issue_not_a_miss() {
        let Some(store) = store() else { return };
        let victim = "gourdwork_rust_five_usability_defects_maxturns_steer_stop_subagent_compression";
        if !store.load_all().iter().any(|e| e.key == victim) {
            return; // corpus differs; this sample is illustrative, not universal
        }
        let recalls = |q: &str, k: usize| store.search(q, k).iter().any(|e| e.key == victim);

        // "d-wo" comes from "gourd-work"; it tokenizes to just "wo" (single-char
        // runs and hyphens are not indexed), which occurs in 154/190 files.
        assert!(!recalls("d-wo", 20), "reproduces the first smoke failure at limit 20");
        assert!(recalls("d-wo", 190),
            "widening the limit must recall it — proof the entry was always a candidate");

        // Same entry, complete words, no widened limit needed.
        assert!(recalls("gourd-work", 20), "a complete English word must recall");
        for probe in ["maxturns", "subagent"] {
            assert!(recalls(probe, 20), "complete key segment {:?} must recall", probe);
        }
    }

    /// Precision guard: extending the index to three fields must not turn search
    /// into "matches everything". Recall gains that cost precision are a net loss
    /// here, because injected memories that are noise still consume context.
    #[test]
    fn queries_whose_tokens_are_all_absent_return_nothing() {
        let Some(store) = store() else { return };
        let hay = corpus_text(&store);

        // Derive the negative example at run time. A hard-coded "absent" term is
        // a trap: this store is written to by `memory_extract` during normal work,
        // and the previous sentinel `zzzqqqxxx` was eventually recorded *into* the
        // corpus by exactly that path, flipping this guard from green to red.
        let absent = absent_term(&hay, None).expect("corpus must admit an absent term");
        assert!(store.search(&absent, 20).is_empty(),
            "term verified absent from the corpus must not match: {}", absent);

        let second = absent_term(&hay, Some(&absent)).expect("corpus must admit a second absent term");
        assert!(store.search(&format!("{} {}", absent, second), 20).is_empty(),
            "a multi-word query whose every token is absent must return nothing");

        // Counter-assertion: a term that really occurs must match. Without this,
        // "returns nothing" would also pass if search were broken outright —
        // which is how a guard can report precision while measuring nothing.
        let present = present_term(&store).expect("corpus must admit a present term");
        assert!(!store.search(&present, 20).is_empty(),
            "a term that really exists in the corpus must match: {}", present);
    }

    /// Exact-key recall over the whole real library. The counterpart to the
    /// reported failure: that key genuinely was not in the store, so erroring was
    /// right — but a key that **does** exist must never report not-found.
    #[test]
    fn every_stored_key_is_recallable() {
        let Some(store) = store() else { return };
        let entries = store.load_all();
        assert!(!entries.is_empty());
        for e in &entries {
            let got = store.get(&e.key);
            assert!(got.is_some(), "an existing key must be recallable: {}", e.key);
            assert_eq!(got.unwrap().key, e.key);
        }
    }

    /// Ranking must not drift between calls. With ~190 entries, score ties are
    /// common; if tie order followed `read_dir` sequence the model would see
    /// memories shuffling for an identical query.
    #[test]
    fn ranking_is_stable_across_calls() {
        let Some(store) = store() else { return };
        let query = "rust 内核 修复";
        let first: Vec<String> = store.search(query, 10).iter().map(|e| e.key.clone()).collect();
        for _ in 0..5 {
            let again: Vec<String> = store.search(query, 10).iter().map(|e| e.key.clone()).collect();
            assert_eq!(first, again, "identical query must produce identical ordering");
        }
    }

    /// Cross-kernel agreement on real data. Both kernels serve the same
    /// directory, so a query that hits in one and misses in the other reads to
    /// the model as memories appearing and disappearing at random — the
    /// "时有时无" symptom.
    ///
    /// # This test used to be worthless, and how it was fixed
    ///
    /// Its first form hard-coded the expected verdicts in a `Vec<(&str, bool)>`
    /// labelled "taken from MemoryRealCorpusSmokeTest", then asserted Rust against
    /// that constant. The assertion message even printed `java={}` — filled from the
    /// constant, not from Java. **The Java kernel was never invoked**, so the test
    /// could not fail on a kernel disagreement; it only ever checked Rust against my
    /// own notes about Rust. It reported green while measuring nothing, and I cited it
    /// as evidence that "both kernels agree, row by row".
    ///
    /// It now reads verdicts that the Java smoke *actually wrote* to
    /// `$GWORK_SMOKE_DIR/kernel-verdicts.txt` (see
    /// `MemoryRealCorpusSmokeTest#writesKernelVerdictsForTheRustCounterpart`).
    /// Scores are still not compared — Java caches an index in memory while Rust
    /// re-reads the directory — only the hit/miss decision.
    ///
    /// When the file is missing (Java not run yet), the test **skips loudly**.
    /// Skipping is not passing: a silent `return` here is precisely what let the
    /// hard-coded version look like a cross-kernel guarantee.
    #[test]
    fn hit_miss_verdict_agrees_with_the_java_kernel() {
        let Some(store) = store() else { return };
        let path = corpus_dir().unwrap().join(VERDICTS_FILE);
        let Ok(raw) = std::fs::read_to_string(&path) else {
            eprintln!(
                "SKIPPED (not passed): {} is absent — run the Java smoke first so this \
                 compares real verdicts instead of guessing.\n  \
                 GWORK_SMOKE_DIR={:?}\n  mvn -o -pl gourd-ai-agent test \
                 -Dtest=MemoryRealCorpusSmokeTest",
                VERDICTS_FILE,
                store.dir()
            );
            return;
        };

        let mut compared = 0usize;
        let mut disagreements = Vec::new();
        for line in raw.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            // Format: `<HIT|MISS>\t<query>` — tab-delimited so queries may contain spaces.
            let Some((verdict, query)) = line.split_once('\t') else { continue };
            let expected_hit = match verdict {
                "HIT" => true,
                "MISS" => false,
                other => panic!("unknown verdict {:?} in {}", other, VERDICTS_FILE),
            };
            let rust_hit = !store.search(query, 20).is_empty();
            compared += 1;
            if rust_hit != expected_hit {
                disagreements.push(format!("query={:?} rust={} java={}", query, rust_hit, expected_hit));
            }
        }

        // Guard against vacuous agreement: an empty or unparseable file would make
        // the loop compare nothing and still pass.
        assert!(compared > 0, "{} contained no usable verdict rows", VERDICTS_FILE);
        assert!(
            disagreements.is_empty(),
            "kernel disagreement on {} of {} queries:\n  {}",
            disagreements.len(),
            compared,
            disagreements.join("\n  ")
        );
        eprintln!("cross-kernel verdicts compared: {} (all agree)", compared);
    }
}
