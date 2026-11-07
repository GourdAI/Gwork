//! skills — Skill discovery, loading, and system-prompt injection.
//!
//! Skills are Markdown capability packages (`SKILL.md`) installed under
//! `~/.gwork/skills/` (global) or `<project>/.gwork/skills/` (workspace).
//!
//! ## Three contracts this module has to honour
//!
//! **1. `SKILL.md` metadata lives in YAML front matter.** An earlier version
//! scanned the first 20 lines for `description:` regardless of position, so the
//! very first front-matter line it did not recognize became the description —
//! every card in the UI showed `name: agent-browser` instead of the real
//! trigger text. The parser below only reads keys *inside* the fence.
//!
//! **2. `enabled` is stored in that front matter**, not in a sidecar and not in
//! settings.json (Java `SkillMdFrontmatter`). Absent means enabled. Writing it
//! anywhere else would make the UI switch lie: it would report success and the
//! next scan would still see the old state.
//!
//! **3. `displayName` comes only from `.skill-market.json`** — the file the
//! marketplace installer writes. It must **never** be read from the skill's own
//! `SKILL.md`: that file is third-party content, so trusting a self-declared
//! display name lets a publisher disguise their skill as an existing one. The
//! resolution order mirrors Java `SkillDisplayNames.ofMeta`:
//!   1. meta `displayName` → verbatim;
//!   2. else meta `slug` → its bare tail (`@owner/slug` → `slug`);
//!   3. no meta at all → `None`, and callers fall back to the directory name.
//!
//! Both scopes are scanned, workspace overriding global on name collision
//! (Java `TalentRegistry.scanSkills` runs global then workspace). Scanning only
//! the global directory made project-local skills invisible everywhere.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::config::Settings;

/// Run a blocking closure **off** the async worker thread.
///
/// WHY THIS EXISTS (measured pattern, not guessed): `load_all` walks both skill
/// scopes and does a `read_to_string` + front-matter parse of **every** `SKILL.md`
/// it finds. It is called from `SkillRegistry::prompt_summary`, which
/// `server::run_react_session` invokes inline while building the system prompt —
/// i.e. on the hot path of *every single chat turn*, on a tokio worker.
///
/// Blocking a worker does not only slow the caller down; it stalls every other
/// task scheduled on that worker. The measured shape of that failure elsewhere in
/// this repo: `/web/chat/meta` going 0.23 ms → 85.85 ms under 8 concurrent
/// blocking requests, and 1 ms → 2178 ms while a `usage/stats` scan was in flight.
///
/// `block_in_place` rather than `spawn_blocking` because this module's API is
/// synchronous and its callers are not ours to change. It panics on a
/// `current_thread` runtime, so the flavour is checked first and the closure runs
/// inline otherwise — identical to the previous behaviour for tests and the CLI.
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

/// Marketplace pipeline: upstream adapters, install/unpack, icon proxy.
pub mod market;

/// Market metadata file written by the installer (Java `SkillDisplayNames.META_FILE`).
const MARKET_META_FILE: &str = ".skill-market.json";

/// Front matter fence.
const FENCE: &str = "---";

/// A discovered skill.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    /// Unique path identifier (directory name, `/`-joined for nested skills).
    pub name: String,
    /// Human-readable title from `SKILL.md` (the first `#` heading).
    pub title: String,
    /// Trigger description (when to use) from front matter.
    pub description: String,
    /// Whether the skill is enabled (front matter `enabled`, default true).
    pub enabled: bool,
    /// Version from front matter, if declared.
    pub version: Option<String>,
    /// Which registry it came from.
    pub scope: SkillScope,
    /// Absolute directory (needed to resolve market metadata and to toggle).
    pub dir: PathBuf,
    /// Market metadata, when the skill was installed from a marketplace.
    pub market: Option<MarketMeta>,
}

/// Registry scope (Java `TalentScope`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillScope {
    Global,
    Workspace,
}

impl SkillScope {
    /// Wire value the frontend expects (`skill.scope`).
    pub fn code(self) -> &'static str {
        match self {
            SkillScope::Global => "global",
            SkillScope::Workspace => "workspace",
        }
    }
}

/// Contents of `.skill-market.json`.
///
/// Only marketplace-sourced fields; deliberately does **not** include a display
/// name read from the package itself (see the module docs on the trust boundary).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct MarketMeta {
    pub market: String,
    pub slug: String,
    #[serde(rename = "iconUrl")]
    pub icon_url: String,
    /// Present only for skills installed after the marketplace started returning
    /// a display name.
    #[serde(rename = "displayName")]
    pub display_name: String,
}

/// Skill registry that scans one or both scope directories.
pub struct SkillRegistry {
    global_dir: PathBuf,
    workspace_dir: Option<PathBuf>,
}

impl SkillRegistry {
    /// Global-only registry (`~/.gwork/skills`).
    pub fn new() -> Self {
        Self {
            global_dir: Settings::gwork_home().join("skills"),
            workspace_dir: None,
        }
    }

    /// Registry covering both the global and a project's workspace skills.
    pub fn with_workspace(workspace: &Path) -> Self {
        Self {
            global_dir: Settings::gwork_home().join("skills"),
            workspace_dir: Some(workspace.join(".gwork").join("skills")),
        }
    }

    /// Single-directory registry (used by tests and by callers that already
    /// resolved the directory they want).
    pub fn with_dir(dir: PathBuf) -> Self {
        Self { global_dir: dir, workspace_dir: None }
    }

    /// Scan and load all skills, workspace overriding global on name collision.
    ///
    /// Offloaded: see `offload` for the measured cost of running this scan on an
    /// async worker (it is on the hot path of every chat turn via
    /// `prompt_summary`).
    pub fn load_all(&self) -> Vec<Skill> {
        let global_dir = self.global_dir.clone();
        let workspace_dir = self.workspace_dir.clone();
        offload(move || {
            // Fast path: a fingerprint of the on-disk state (directory listing +
            // each SKILL.md / .skill-market.json's mtime and size). When it is
            // unchanged the previously parsed skills are reused, so the 230 KB of
            // front matter is not re-read and re-parsed on every call.
            //
            // This is on two hot paths: `skills_installed` (the settings panel)
            // and `prompt_summary` (**every chat turn**). Measured against the
            // Java kernel — which keeps a pool built once at startup — the
            // uncached rescan made `skills_installed` 1.8x slower (2.08 ms vs
            // 1.13 ms). The fingerprint costs ~23 `stat` calls instead.
            let fp = fingerprint(&global_dir, workspace_dir.as_deref());
            if let Some(hit) = cache_get(&global_dir, workspace_dir.as_deref(), &fp) {
                return hit;
            }

            let mut by_name: HashMap<String, Skill> = HashMap::new();

            // Global first, then workspace: a project-local skill of the same name
            // shadows the global one (Java scans in the same order into a map).
            scan_dir(&global_dir, SkillScope::Global, &mut by_name);
            if let Some(ws) = &workspace_dir {
                scan_dir(ws, SkillScope::Workspace, &mut by_name);
            }

            let mut skills: Vec<Skill> = by_name.into_values().collect();
            skills.sort_by(|a, b| a.name.cmp(&b.name));
            cache_put(&global_dir, workspace_dir.as_deref(), fp, skills.clone());
            skills
        })
    }

    /// Scan and load **only enabled** skills — the single source of truth for
    /// every surface that exposes skills to the user or the model.
    ///
    /// Mirrors Java `TalentRegistry#getSkills()` (disabled skills are filtered
    /// out) vs `getSkillsAll()` (management view only). `load_all()` deliberately
    /// keeps disabled entries so the settings page can show and re-enable them,
    /// but a consumer that forgets to filter them leaks disabled skills into
    /// the `/` completion panel, `skillread`, `skillrefresh` and the model's
    /// context. Centralising the filter here means a new consumer cannot
    /// accidentally reintroduce that bug by calling `load_all()` directly.
    ///
    /// Every model/user-facing consumer goes through this method — there is no
    /// second hand-written `enabled` check downstream:
    /// `server::skill_hint_rows` (via `build_hints`), `prompt_summary*`,
    /// `SkillReadTool`, `SkillRefreshTool`, `SkillSearchTool`. `skills_installed`
    /// (settings) is the one caller that legitimately needs `load_all()`.
    pub fn load_enabled(&self) -> Vec<Skill> {
        self.load_all().into_iter().filter(|s| s.enabled).collect()
    }

    /// Locate one skill's directory by name (for toggle/uninstall).
    pub fn find_dir(&self, name: &str) -> Option<PathBuf> {
        // Workspace wins, matching `load_all`'s shadowing rule.
        if let Some(ws) = &self.workspace_dir {
            let p = ws.join(name);
            if has_skill_md(&p) {
                return Some(p);
            }
        }
        let p = self.global_dir.join(name);
        if has_skill_md(&p) {
            return Some(p);
        }
        None
    }

    /// Build the skill summary block for the system prompt.
    ///
    /// `context_length` is the session's context window in tokens; the listing is
    /// budgeted at [`DEFAULT_LISTING_BUDGET_FRACTION`]% of it (Java
    /// `SkillListingPolicy.budgetChars`). Pass `None` to use the default window.
    pub fn prompt_summary(&self) -> String {
        self.prompt_summary_with_budget(None, DEFAULT_LISTING_BUDGET_FRACTION, DESCRIPTION_MAX_CHARS)
    }

    /// Budgeted variant of [`prompt_summary`].
    ///
    /// Two limits, both mirroring the Java kernel so a skill behaves the same on
    /// either kernel:
    ///
    /// * **per entry** — the description is clipped to [`DESCRIPTION_MAX_CHARS`]
    ///   (the Agent Skills spec's own cap, 1024). Without it a single 10 000-char
    ///   description added 30 173 chars to the prompt, measured.
    /// * **total** — the listing is budgeted at `fraction`% of the context window.
    ///   When it overflows, descriptions are dropped **longest first** until it
    ///   fits; names are always kept, because a skill the model cannot see is a
    ///   skill that does not exist.
    ///
    /// Dropping longest-first rather than least-recently-used is deliberate: this
    /// kernel has no cross-session skill usage counter (Java's
    /// `SessionToolUsageService` is per-session only), and longest-first keeps the
    /// most skills routable for the same budget.
    pub fn prompt_summary_with_budget(
        &self,
        context_length: Option<i64>,
        fraction: u32,
        max_desc_chars: usize,
    ) -> String {
        // `load_enabled` is the single filtering point (Java `getSkills()`);
        // keeping the filter here too would let the two drift apart.
        let enabled = self.load_enabled();
        if enabled.is_empty() {
            return String::new();
        }

        // Normalize once here so every downstream consumer (clip, entry_len, the
        // budget walk) measures against the same cap. Threading the raw setting
        // through instead would let a 0 from settings.json clip every description
        // down to a bare ellipsis while the budget math still assumed the default.
        let max_desc = normalize_max_desc_chars(max_desc_chars);

        let budget = listing_budget_chars(context_length, fraction);
        let refs: Vec<&Skill> = enabled.iter().collect();
        let dropped = select_dropped_by_budget(&refs, budget, max_desc);

        let mut out = String::from("\n## Available Skills\n");
        out.push_str(
            "The following skills are installed. Use `skillread` to load full instructions before executing a matching task.\n",
        );
        for s in &enabled {
            // Description is the trigger text; a single line keeps the prompt compact.
            if dropped.contains(&s.name) {
                out.push_str(&format!("- **{}**\n", s.name));
            } else {
                let desc = clip_description(&first_line(&s.description), max_desc);
                out.push_str(&format!("- **{}**: {}\n", s.name, desc));
            }
        }
        if !dropped.is_empty() {
            // Tell the model these are still usable, or it will read the bare names
            // as "nothing to see here" and never invoke them.
            out.push_str(
                "- (Some descriptions were omitted to fit the listing budget; those skills are still available via `skillread`.)\n",
            );
            tracing::warn!(
                budget_chars = budget,
                dropped = dropped.len(),
                "skill listing exceeds budget, dropped descriptions (names still listed)"
            );
        }
        out
    }
}

/// Per-entry description cap for the system-prompt listing.
///
/// The Agent Skills spec's own limit (`MAX_DESCRIPTION_LENGTH = 1024` in
/// skills-ref/validator.py); ZCode uses the same value. Claude Code's 1536 is the
/// *combined* description + when_to_use cap, not a per-field one, so it is not
/// used here. Java `SkillTalent.DESCRIPTION_MAX_CHARS` must stay in step.
pub const DESCRIPTION_MAX_CHARS: usize = 1024;

/// Listing budget as a percentage of the context window.
///
/// Matches Claude Code's `skillListingBudgetFraction` default (1%) and Java
/// `SkillListingPolicy.DEFAULT_BUDGET_FRACTION`.
pub const DEFAULT_LISTING_BUDGET_FRACTION: u32 = 1;

/// Clamp a configured budget fraction; out-of-range falls back to the default.
///
/// Same tolerance as Java `SkillListingPolicy.normalizeFraction`: settings.json is
/// user-editable, and a typo must not make the whole skill library vanish.
pub fn normalize_budget_fraction(raw: Option<u32>) -> u32 {
    match raw {
        Some(v) if (1..=10).contains(&v) => v,
        _ => DEFAULT_LISTING_BUDGET_FRACTION,
    }
}

/// Character budget for the skill listing: `window * fraction / 100`, floor 1.
///
/// The window is in tokens and the budget in characters — different units, but
/// this deliberately follows Claude Code's convention (its budget is also "1% of
/// the window" expressed in characters), since that value is proven in production
/// to neither starve nor bloat the listing.
pub fn listing_budget_chars(context_length: Option<i64>, fraction: u32) -> usize {
    let window = context_length
        .filter(|v| *v > 0)
        .unwrap_or(crate::usage::DEFAULT_CONTEXT_LENGTH) as u64;
    let pct = normalize_budget_fraction(Some(fraction)) as u64;
    let budget = window.saturating_mul(pct) / 100;
    budget.max(1) as usize
}

/// Clamp a configured per-entry description cap.
///
/// `0` would clip every description down to a bare ellipsis and a huge value would
/// defeat the cap entirely, so both ends fall back to the spec default. Mirrors the
/// Java side's handling of `general.skillListingMaxDescChars`.
pub fn normalize_max_desc_chars(raw: usize) -> usize {
    if raw < 16 || raw > 8192 {
        DESCRIPTION_MAX_CHARS
    } else {
        raw
    }
}

/// Clip a description to `max_chars`, appending an ellipsis.
///
/// Truncating rather than dropping the whole skill (ZCode drops it) is deliberate:
/// dropping makes an installed skill silently vanish, truncation at least keeps it
/// invocable. Java `SkillTalent.clipDescription` must stay in step.
fn clip_description(raw: &str, max_chars: usize) -> String {
    let text = raw.trim();
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max_chars - 1).collect();
    out.push('…');
    out
}

/// Length of one rendered listing entry.
///
/// Kept next to the renderer's format string on purpose: a separate formula would
/// drift from the actual output and the budget would then be computed against a
/// listing that does not exist.
fn entry_len(skill: &Skill, with_description: bool, max_desc: usize) -> usize {
    if with_description {
        // "- **name**: desc\n"
        4 + skill.name.chars().count()
            + 2
            + clip_description(&first_line(&skill.description), max_desc)
                .chars()
                .count()
            + 1
    } else {
        // "- **name**\n"
        4 + skill.name.chars().count() + 1
    }
}

/// Names whose description must be dropped to fit `budget`.
///
/// Longest description first, so the same budget keeps the most skills routable.
fn select_dropped_by_budget(enabled: &[&Skill], budget: usize, max_desc: usize) -> Vec<String> {
    let mut total: usize = enabled.iter().map(|s| entry_len(s, true, max_desc)).sum();
    if total <= budget {
        return Vec::new();
    }

    let mut by_len: Vec<&Skill> = enabled.to_vec();
    by_len.sort_by(|a, b| {
        b.description
            .chars()
            .count()
            .cmp(&a.description.chars().count())
    });

    let mut dropped = Vec::new();
    for s in by_len {
        if total <= budget {
            break;
        }
        total = total.saturating_sub(entry_len(s, true, max_desc) - entry_len(s, false, max_desc));
        dropped.push(s.name.clone());
    }
    dropped
}

impl Default for SkillRegistry {
    fn default() -> Self {
        Self::new()
    }
}

fn has_skill_md(dir: &Path) -> bool {
    resolve_skill_md(dir).is_some()
}

/// Locate `SKILL.md` (both spellings accepted, Java `resolveSkillMd`).
pub fn resolve_skill_md(dir: &Path) -> Option<PathBuf> {
    for name in ["SKILL.md", "skill.md"] {
        let p = dir.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Read a skill's full `SKILL.md` body on demand.
///
/// This is the replacement for the removed `Skill.content` field. The body is
/// third-party Markdown that only one caller ever wanted — the `skillread` tool,
/// invoked right before the model executes a matching task — so holding it in the
/// parsed-skill cache for the life of the process was pure resident-memory waste
/// (~230 KB across the developer machine's 7 skills, growing with every install).
/// Reading it here instead costs one small file read at the moment it is actually
/// needed, and the cache stays metadata-only like the Java kernel's
/// `TalentRegistry.skillMap`.
///
/// Returns `None` when the skill directory has no readable `SKILL.md`.
pub fn read_skill_content(dir: &Path) -> Option<String> {
    let md = resolve_skill_md(dir)?;
    std::fs::read_to_string(&md).ok()
}

// ─── Parsed-skill cache ───────────────────────────────────────────────────────
//
// `load_all` is called on every chat turn (via `prompt_summary`) and by the
// settings panel. Each call used to re-read every `SKILL.md` — 230 KB across 7
// skills on the developer machine — and re-parse its front matter, which made
// `skills_installed` 1.8x slower than the Java kernel's equivalent (the Java
// engine keeps a pool built once at startup).
//
// The cache is keyed by the (global, workspace) directory pair and validated by
// a fingerprint of the on-disk state. Two independent invalidation paths, because
// neither alone is sufficient:
//
//   * **fingerprint** — directory listing plus each `SKILL.md` /
//     `.skill-market.json`'s (mtime, size). Catches edits made outside the kernel
//     (a user hand-editing a skill, a `git pull` in the workspace).
//   * **explicit invalidation** — [`invalidate_cache`] is called by every mutation
//     this kernel performs (toggle / install / uninstall). This is what makes
//     correctness independent of filesystem timestamp granularity: an in-place
//     rewrite that lands inside the same mtime tick *and* preserves the byte
//     length would otherwise be missed, and `set_enabled` rewriting a front-matter
//     line is exactly that shape.
//
// A poisoned lock must not wedge every later request, so both accessors recover
// the guard rather than unwrapping.

static SKILL_CACHE: once_cell::sync::Lazy<
    std::sync::Mutex<HashMap<(PathBuf, Option<PathBuf>), (Vec<String>, Vec<Skill>)>>,
> = once_cell::sync::Lazy::new(|| std::sync::Mutex::new(HashMap::new()));

fn cache_lock(
) -> std::sync::MutexGuard<'static, HashMap<(PathBuf, Option<PathBuf>), (Vec<String>, Vec<Skill>)>> {
    match SKILL_CACHE.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    }
}

/// Fingerprint every file `scan_dir` would read, without reading any of them.
///
/// Cost is one `read_dir` per root plus ~3 `stat` calls per skill directory,
/// against ~230 KB of reads and parsing on a miss.
fn fingerprint(global_dir: &Path, workspace_dir: Option<&Path>) -> Vec<String> {
    let mut fp = Vec::new();
    for root in [Some(global_dir), workspace_dir] {
        let Some(root) = root else { continue };
        fp.push(format!("root={}", root.display()));
        let Ok(rd) = std::fs::read_dir(root) else { continue };
        // Sorted so the fingerprint is stable across directory enumeration order,
        // which the filesystem does not guarantee.
        let mut names: Vec<String> = rd
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        for name in names {
            if name.starts_with('.') {
                continue;
            }
            let dir = root.join(&name);
            if !dir.is_dir() {
                continue;
            }
            fp.push(format!("dir={}", name));
            for f in ["SKILL.md", "skill.md", MARKET_META_FILE] {
                let p = dir.join(f);
                match std::fs::metadata(&p) {
                    Ok(md) => fp.push(format!(
                        "{}:{}:{}:{}",
                        name,
                        f,
                        md.len(),
                        md.modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_nanos())
                            .unwrap_or(0)
                    )),
                    // Absent file: record that, so creating it later is a change.
                    Err(_) => fp.push(format!("{}:{}:absent", name, f)),
                }
            }
        }
    }
    fp
}

fn cache_key(global_dir: &Path, workspace_dir: Option<&Path>) -> (PathBuf, Option<PathBuf>) {
    (global_dir.to_path_buf(), workspace_dir.map(Path::to_path_buf))
}

fn cache_get(global_dir: &Path, workspace_dir: Option<&Path>, fp: &[String]) -> Option<Vec<Skill>> {
    let cache = cache_lock();
    let (cached_fp, skills) = cache.get(&cache_key(global_dir, workspace_dir))?;
    if cached_fp.as_slice() == fp {
        Some(skills.clone())
    } else {
        None
    }
}

fn cache_put(
    global_dir: &Path,
    workspace_dir: Option<&Path>,
    fp: Vec<String>,
    skills: Vec<Skill>,
) {
    cache_lock().insert(cache_key(global_dir, workspace_dir), (fp, skills));
}

/// Drop every cached parse, forcing the next `load_all` to rescan.
///
/// Called by each mutation path (toggle / install / uninstall). See the module
/// comment for why the fingerprint alone is not enough.
pub fn invalidate_cache() {
    cache_lock().clear();
}

/// Scan a scope directory (one level of skill folders) into `out`.
fn scan_dir(root: &Path, scope: SkillScope, out: &mut HashMap<String, Skill>) {
    let Ok(rd) = std::fs::read_dir(root) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        // Dot-directories are metadata/tooling, not skills.
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let Some(md) = resolve_skill_md(&p) else { continue };
        // The file is still read — the front matter and the first heading are the
        // metadata every consumer needs — but its **body is no longer retained**.
        // See `read_skill_content`: the only caller that wanted the full text
        // (`skillread`) now reads it on demand, so the cache stops holding ~230 KB
        // of third-party Markdown per skill for the life of the process. The Java
        // kernel's `TalentRegistry.skillMap` likewise stores only `SkillDir`
        // metadata, never the body.
        let Ok(content) = std::fs::read_to_string(&md) else { continue };
        let meta = parse_front_matter(&content);
        let title = meta
            .get("title")
            .filter(|t| !t.trim().is_empty())
            .cloned()
            .or_else(|| first_heading(&content))
            .unwrap_or_else(|| name.clone());
        let description = meta.get("description").cloned().unwrap_or_default();
        let description = if description.trim().is_empty() {
            title.clone()
        } else {
            description
        };
        let enabled = meta
            .get("enabled")
            .map(|v| !matches!(v.trim().to_lowercase().as_str(), "false" | "0" | "no" | "off"))
            .unwrap_or(true);

        out.insert(
            name.clone(),
            Skill {
                name,
                title,
                description,
                enabled,
                version: meta.get("version").filter(|v| !v.trim().is_empty()).cloned(),
                scope,
                dir: p,
                market: read_market_meta(&md.parent().unwrap_or(Path::new("."))),
            },
        );
    }
}

/// Parse the YAML front matter block at the head of a Markdown file.
///
/// Only lines **inside** the first fence pair are treated as metadata. Returns an
/// empty map when the file has no front matter, so callers fall back to headings
/// rather than mistaking body prose for a description.
pub fn parse_front_matter(content: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut lines = content.lines();
    let Some(first) = lines.next() else { return map };
    if first.trim() != FENCE {
        return map;
    }
    for line in lines {
        let trimmed = line.trim_end_matches('\r');
        if trimmed.trim() == FENCE {
            break;
        }
        if let Some((k, v)) = split_yaml_line(trimmed) {
            map.insert(k, v);
        }
    }
    map
}

/// Parse one **top-level** `key: value` front-matter line.
///
/// The key must be a simple identifier, which keeps URLs (`http://…`) and nested
/// list items from being read as keys (Java `frontmatterKey` applies the same rule).
///
/// An indented line is nested content and is rejected **before** trimming. This
/// ordering matters: trimming first made `metadata:`'s child `  version: "42"`
/// parse as a top-level `version`, silently shadowing the skill's real one — the
/// same class of bug the module docs record for `description`. Real skills hit
/// this shape (`rea-reverse-engineering` nests `version` under `metadata`,
/// `dev-expert` lists `allowed-tools` items). Java's `MarkdownUtil.salvageFrontmatter`
/// applies the identical rule, so both kernels agree on the same file.
fn split_yaml_line(line: &str) -> Option<(String, String)> {
    if line.starts_with(' ') || line.starts_with('\t') {
        return None;
    }
    let t = line.trim();
    if t.is_empty() || t.starts_with('#') || t.starts_with('-') {
        return None;
    }
    let (k, v) = t.split_once(':')?;
    let k = k.trim();
    if k.is_empty() || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return None;
    }
    Some((k.to_string(), unquote(v.trim())))
}

/// Strip surrounding quotes and unescape `\\` / `\"`.
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

/// Read `.skill-market.json` from a skill directory (None when absent/corrupt).
pub fn read_market_meta(skill_dir: &Path) -> Option<MarketMeta> {
    let raw = std::fs::read_to_string(skill_dir.join(MARKET_META_FILE)).ok()?;
    serde_json::from_str::<MarketMeta>(&raw).ok()
}

/// Resolve the display name from market metadata (Java `SkillDisplayNames.ofMeta`).
///
/// Returns `None` when there is no metadata, so the caller falls back to the
/// directory name. Never consults the package's own `SKILL.md`.
pub fn display_name_of(meta: Option<&MarketMeta>) -> Option<String> {
    let meta = meta?;
    let dn = meta.display_name.trim();
    if !dn.is_empty() {
        return Some(dn.to_string());
    }
    market_bare_slug(&meta.slug).filter(|s| !s.is_empty())
}

/// Bare tail of a marketplace slug: `@owner/slug` → `slug`.
///
/// The separator index must be `> 1`, exactly as the frontend and the Java kernel
/// do it: with `> 0` a malformed `@/slug` would be stripped by one side and
/// returned verbatim by the other, so the same skill would show two names.
pub fn market_bare_slug(slug: &str) -> Option<String> {
    if slug.is_empty() {
        return None;
    }
    if slug.starts_with('@') {
        if let Some(i) = slug.find('/') {
            if i > 1 {
                return Some(slug[i + 1..].to_string());
            }
        }
        return Some(slug.to_string());
    }
    Some(slug.to_string())
}

/// First `# heading` in the body (used as the title when front matter omits one).
fn first_heading(content: &str) -> Option<String> {
    let mut in_front = false;
    let mut seen_fence = false;
    for line in content.lines() {
        let t = line.trim();
        if t == FENCE {
            if !seen_fence {
                seen_fence = true;
                in_front = true;
                continue;
            } else if in_front {
                in_front = false;
                continue;
            }
        }
        if in_front {
            continue;
        }
        if let Some(rest) = t.strip_prefix("# ") {
            let title = rest.trim();
            if !title.is_empty() {
                return Some(title.to_string());
            }
        }
    }
    None
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or("").trim().to_string()
}

/// Set the `enabled` flag in a skill's front matter, preserving everything else.
///
/// Minimal line-level rewrite (Java `SkillMdFrontmatter.setEnabled`): an existing
/// `enabled` key is replaced in place, otherwise the key is inserted before the
/// closing fence, otherwise a fence block is prepended. The file's dominant line
/// ending is preserved and a leading BOM is kept at the very start — rewriting the
/// whole file with normalized endings would show up as a full-file diff in git and
/// can corrupt a BOM that ends up mid-file.
pub fn set_enabled(skill_dir: &Path, enabled: bool) -> std::io::Result<bool> {
    let Some(md) = resolve_skill_md(skill_dir) else {
        return Ok(false);
    };
    let raw = std::fs::read_to_string(&md)?;

    let had_bom = raw.starts_with('\u{feff}');
    let text = if had_bom { &raw[3..] } else { raw.as_str() };

    let eol = detect_eol(text);
    // Normalize CRLF → LF before splitting: otherwise each line keeps a trailing
    // \r and re-joining with \r\n produces \r\r\n throughout the file. The
    // normalized text must outlive `lines`, which borrows from it.
    let normalized = text.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();

    let value_line = format!("enabled: {}", enabled);

    let fence_end = if lines.first().map(|l| l.trim()) == Some(FENCE) {
        (1..lines.len()).find(|&i| lines[i].trim() == FENCE)
    } else {
        None
    };

    let out: Vec<String> = match fence_end {
        Some(end) => {
            let key_line = (1..end).find(|&i| split_yaml_line(lines[i]).map(|(k, _)| k) == Some("enabled".to_string()));
            let mut v: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
            match key_line {
                Some(i) => v[i] = value_line,
                None => v.insert(end, value_line),
            }
            v
        }
        None => {
            let mut v = vec![FENCE.to_string(), value_line, FENCE.to_string()];
            v.extend(lines.iter().map(|s| s.to_string()));
            v
        }
    };

    let mut joined = out.join("\n");
    if eol != "\n" {
        joined = joined.replace('\n', eol);
    }
    if had_bom {
        joined = format!("\u{feff}{}", joined);
    }
    std::fs::write(&md, joined)?;
    // The rewrite is in place and often the same byte length (only `true`/`false`
    // differs, and both are 4-5 chars), so it can land inside one mtime tick.
    // The fingerprint would then miss it — invalidate explicitly.
    invalidate_cache();
    Ok(true)
}

/// Dominant line ending: CRLF when CRLF lines are at least as numerous (Java parity).
fn detect_eol(text: &str) -> &'static str {
    let bytes = text.as_bytes();
    let mut crlf = 0usize;
    let mut lf = 0usize;
    for i in 0..bytes.len() {
        if bytes[i] == b'\n' {
            if i > 0 && bytes[i - 1] == b'\r' {
                crlf += 1;
            } else {
                lf += 1;
            }
        }
    }
    if crlf >= lf && crlf > 0 {
        "\r\n"
    } else {
        "\n"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("gwork-skills-{}-{}", tag, std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn skill(&self, name: &str, md: &str) -> PathBuf {
            let d = self.0.join(name);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("SKILL.md"), md).unwrap();
            d
        }
        fn meta(&self, name: &str, json: &str) {
            std::fs::write(self.0.join(name).join(MARKET_META_FILE), json).unwrap();
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // ── parsed-skill cache ────────────────────────────────────────────────────
    //
    // The cache trades a rescan for a fingerprint comparison. Both halves need
    // locking: a cache that never hits is just overhead, and one that survives a
    // mutation serves stale data — which for `enabled` means the agent keeps
    // loading a skill the user just turned off.

    /// `load_enabled` is the single model/user-visible source of truth: it must
    /// drop `enabled: false` while `load_all` keeps it for the settings view.
    /// This is the Rust counterpart of Java `TalentRegistry.getSkills()` vs
    /// `getSkillsAll()`; a leak here shows up as disabled skills in the `/`
    /// completion panel and in the model's context.
    #[test]
    fn load_enabled_excludes_disabled_skills_but_load_all_keeps_them() {
        invalidate_cache();
        let s = Scratch::new("load-enabled");
        s.skill("on-skill", "---\nname: on-skill\ndescription: enabled one\n---\n\n# On\n");
        s.skill(
            "off-skill",
            "---\nname: off-skill\ndescription: disabled one\nenabled: false\n---\n\n# Off\n",
        );
        let reg = SkillRegistry::with_dir(s.0.clone());

        let all = reg.load_all();
        assert_eq!(all.len(), 2, "management view must still see disabled skills");
        assert!(all.iter().any(|x| x.name == "off-skill"));

        let enabled = reg.load_enabled();
        assert_eq!(enabled.len(), 1, "only the enabled skill may be visible");
        assert_eq!(enabled[0].name, "on-skill");
        assert!(!enabled.iter().any(|x| x.name == "off-skill"));
    }

    /// Re-enabling must become visible without a restart (the toggle path calls
    /// `invalidate_cache`, and `load_enabled` is derived from `load_all`).
    #[test]
    fn load_enabled_follows_a_toggle_immediately() {
        invalidate_cache();
        let s = Scratch::new("load-enabled-toggle");
        let dir = s.skill("a", "---\nname: a\ndescription: d\nenabled: true\n---\n\n# A\n");
        let reg = SkillRegistry::with_dir(s.0.clone());
        assert_eq!(reg.load_enabled().len(), 1);

        set_enabled(&dir, false).unwrap();
        assert!(reg.load_enabled().is_empty(), "disabling must hide it from the visible set");

        set_enabled(&dir, true).unwrap();
        assert_eq!(reg.load_enabled().len(), 1, "re-enabling must restore it");
    }

    /// The fingerprint must be **stable** across repeated reads of an unchanged
    /// tree — that is what makes a cache hit possible at all.
    ///
    /// Deliberately not proven by rewriting a file and restoring its mtime: on
    /// Windows the restored timestamp does not reliably compare equal to the
    /// original (NTFS stores 100 ns ticks while `set_modified` goes through a
    /// coarser path), so such a test measures the filesystem instead of the
    /// cache — it failed here for exactly that reason while the cache itself was
    /// correct. Testing the fingerprint function directly is deterministic.
    #[test]
    fn fingerprint_is_stable_while_the_tree_is_unchanged() {
        let s = Scratch::new("fp-stable");
        s.skill("a", "---\nname: a\ndescription: d\n---\n\n# A\n");
        s.meta("a", r#"{"market":"m","slug":"s","displayName":"D"}"#);

        let f1 = fingerprint(&s.0, None);
        let f2 = fingerprint(&s.0, None);
        assert_eq!(f1, f2, "an unchanged tree must fingerprint identically");
        assert!(
            f1.iter().any(|e| e.starts_with("a:SKILL.md:")),
            "SKILL.md must be in the fingerprint or content edits are invisible"
        );
        assert!(
            f1.iter().any(|e| e.starts_with(&format!("a:{}:", MARKET_META_FILE))),
            "market metadata must be in the fingerprint, or a displayName edit is invisible"
        );
    }

    /// The complementary half: everything `scan_dir` reads must change the
    /// fingerprint, otherwise the cache serves stale data indefinitely.
    #[test]
    fn fingerprint_changes_when_anything_scan_reads_changes() {
        let s = Scratch::new("fp-sensitive");
        s.skill("a", "---\nname: a\ndescription: d\n---\n\n# A\n");
        let base = fingerprint(&s.0, None);

        // Content edit that changes the byte length.
        s.skill("a", "---\nname: a\ndescription: much longer text\n---\n\n# A\n");
        assert_ne!(fingerprint(&s.0, None), base, "a SKILL.md edit must change the fingerprint");

        // Metadata-only edit.
        let after_content = fingerprint(&s.0, None);
        s.meta("a", r#"{"market":"m","slug":"s","displayName":"Other"}"#);
        assert_ne!(fingerprint(&s.0, None), after_content, "a metadata edit must change the fingerprint");

        // New skill directory.
        let after_meta = fingerprint(&s.0, None);
        s.skill("b", "---\nname: b\ndescription: d\n---\n\n# B\n");
        assert_ne!(fingerprint(&s.0, None), after_meta, "a new skill must change the fingerprint");

        // Removed skill directory.
        let after_add = fingerprint(&s.0, None);
        std::fs::remove_dir_all(s.0.join("b")).unwrap();
        assert_ne!(fingerprint(&s.0, None), after_add, "a removed skill must change the fingerprint");
    }

    /// A workspace root is part of the key, so one global directory paired with
    /// different workspaces must not collide.
    #[test]
    fn fingerprint_distinguishes_the_workspace_root() {
        let g = Scratch::new("fp-global");
        let w1 = Scratch::new("fp-ws1");
        let w2 = Scratch::new("fp-ws2");
        g.skill("a", "---\nname: a\ndescription: d\n---\n\n# A\n");
        w1.skill("only1", "---\nname: o\ndescription: d\n---\n\n# O\n");

        let f_none = fingerprint(&g.0, None);
        let f_w1 = fingerprint(&g.0, Some(&w1.0));
        let f_w2 = fingerprint(&g.0, Some(&w2.0));
        assert_ne!(f_none, f_w1, "adding a workspace root must change the fingerprint");
        assert_ne!(f_w1, f_w2, "two different workspaces must not share a fingerprint");
    }

    /// The cache contract itself, with no filesystem involvement: same
    /// fingerprint → hit, different → miss, different root → miss.
    #[test]
    fn cache_returns_the_entry_only_when_the_fingerprint_matches() {
        invalidate_cache();
        let dir = PathBuf::from("/definitely/not/a/real/path");
        let skill = Skill {
            name: "a".into(),
            title: "A".into(),
            description: "d".into(),
            enabled: true,
            version: None,
            scope: SkillScope::Global,
            dir: dir.join("a"),
            market: None,
        };
        let fp_a = vec!["x:1".to_string()];
        let fp_b = vec!["x:2".to_string()];

        cache_put(&dir, None, fp_a.clone(), vec![skill.clone()]);
        assert!(cache_get(&dir, None, &fp_a).is_some(), "matching fingerprint must hit");
        assert!(cache_get(&dir, None, &fp_b).is_none(), "a changed fingerprint must miss");
        assert!(
            cache_get(&PathBuf::from("/another/root"), None, &fp_a).is_none(),
            "the cache must be keyed by directory"
        );
        // The cached entry carries the metadata (the body is read on demand now,
        // not stored — see `read_skill_content`).
        assert_eq!(cache_get(&dir, None, &fp_a).unwrap()[0].title, "A");

        invalidate_cache();
        assert!(cache_get(&dir, None, &fp_a).is_none(), "invalidate_cache must clear everything");
    }

    /// The mutation path that matters most: `set_enabled` rewrites one front-matter
    /// line, usually at the **same byte length** (`true`/`fals` differ by one char
    /// at most) and often inside a single mtime tick. Without explicit
    /// invalidation the toggle would appear to do nothing.
    #[test]
    fn toggling_enabled_is_visible_immediately_despite_the_cache() {
        invalidate_cache();
        let s = Scratch::new("cache-toggle");
        let dir = s.skill("a", "---\nname: a\ndescription: d\nenabled: true\n---\n\n# A\n");
        let reg = SkillRegistry::with_dir(s.0.clone());

        assert!(reg.load_all()[0].enabled, "starts enabled");
        assert!(set_enabled(&dir, false).unwrap());
        assert!(
            !reg.load_all()[0].enabled,
            "the toggle must be visible on the very next load_all"
        );
        assert!(set_enabled(&dir, true).unwrap());
        assert!(reg.load_all()[0].enabled, "and back again");
        invalidate_cache();
    }

    /// A newly created skill directory must be picked up: the fingerprint includes
    /// the directory listing, not just the files it already knew about.
    #[test]
    fn a_newly_added_skill_is_picked_up_without_explicit_invalidation() {
        invalidate_cache();
        let s = Scratch::new("cache-add");
        s.skill("a", "---\nname: a\ndescription: d\n---\n\n# A\n");
        let reg = SkillRegistry::with_dir(s.0.clone());
        assert_eq!(reg.load_all().len(), 1);

        s.skill("b", "---\nname: b\ndescription: d\n---\n\n# B\n");
        let all = reg.load_all();
        assert_eq!(all.len(), 2, "a new skill directory must invalidate by fingerprint");
        assert!(all.iter().any(|k| k.name == "b"));
        invalidate_cache();
    }

    /// Removing a skill directory must drop it from the result too.
    #[test]
    fn a_removed_skill_disappears_without_explicit_invalidation() {
        invalidate_cache();
        let s = Scratch::new("cache-remove");
        s.skill("a", "---\nname: a\ndescription: d\n---\n\n# A\n");
        s.skill("b", "---\nname: b\ndescription: d\n---\n\n# B\n");
        let reg = SkillRegistry::with_dir(s.0.clone());
        assert_eq!(reg.load_all().len(), 2);

        std::fs::remove_dir_all(s.0.join("b")).unwrap();
        let all = reg.load_all();
        assert_eq!(all.len(), 1, "a deleted skill must not linger in the cache");
        assert_eq!(all[0].name, "a");
        invalidate_cache();
    }

    /// The cache is keyed by directory pair, so two registries over different
    /// roots must not serve each other's skills.
    #[test]
    fn cache_is_keyed_per_directory_and_does_not_cross_contaminate() {
        invalidate_cache();
        let a = Scratch::new("cache-key-a");
        let b = Scratch::new("cache-key-b");
        a.skill("only-in-a", "---\nname: x\ndescription: d\n---\n\n# X\n");
        b.skill("only-in-b", "---\nname: y\ndescription: d\n---\n\n# Y\n");

        let ra = SkillRegistry::with_dir(a.0.clone());
        let rb = SkillRegistry::with_dir(b.0.clone());
        // Interleave the calls so a shared/global key would show up.
        let _ = ra.load_all();
        let _ = rb.load_all();
        let na: Vec<String> = ra.load_all().iter().map(|s| s.name.clone()).collect();
        let nb: Vec<String> = rb.load_all().iter().map(|s| s.name.clone()).collect();
        assert_eq!(na, vec!["only-in-a".to_string()]);
        assert_eq!(nb, vec!["only-in-b".to_string()]);
        invalidate_cache();
    }

    /// Editing `.skill-market.json` alone must invalidate: the display name comes
    /// from it, and it is part of the fingerprint for exactly that reason.
    #[test]
    fn editing_market_metadata_alone_invalidates_the_cache() {
        invalidate_cache();
        let s = Scratch::new("cache-meta");
        s.skill("a", "---\nname: a\ndescription: d\n---\n\n# A\n");
        s.meta("a", r#"{"market":"m","slug":"s","displayName":"First"}"#);
        let reg = SkillRegistry::with_dir(s.0.clone());
        assert_eq!(
            display_name_of(reg.load_all()[0].market.as_ref()).as_deref(),
            Some("First")
        );

        s.meta("a", r#"{"market":"m","slug":"s","displayName":"Second"}"#);
        assert_eq!(
            display_name_of(reg.load_all()[0].market.as_ref()).as_deref(),
            Some("Second"),
            "a metadata-only edit must not be served from a stale cache entry"
        );
        invalidate_cache();
    }

    /// The exact shape real installed skills use. The previous parser returned
    /// "name: agent-browser" as the description because it scanned front matter
    /// lines as if they were body prose.
    #[test]
    fn parses_real_world_skill_front_matter() {
        let md = "---\nname: agent-browser\nslug: agent-browser\ndisplayName: \"Agent Browser\"\nversion: 1.0.0\ndescription: \"Browser automation CLI for AI agents.\"\nlicense: MIT\n---\n\n# Browser Automation with agent-browser\n\nBody text.\n";
        let fm = parse_front_matter(md);
        assert_eq!(fm.get("name").map(String::as_str), Some("agent-browser"));
        assert_eq!(fm.get("description").map(String::as_str), Some("Browser automation CLI for AI agents."));
        assert_eq!(fm.get("version").map(String::as_str), Some("1.0.0"));
        assert_eq!(first_heading(md).as_deref(), Some("Browser Automation with agent-browser"));
    }

    /// A `description:` line in the *body* must not be mistaken for metadata.
    #[test]
    fn body_lines_are_not_front_matter() {
        let md = "# Title\n\ndescription: this is prose, not metadata\n";
        let fm = parse_front_matter(md);
        assert!(fm.is_empty(), "no fence means no metadata, got {:?}", fm);
    }

    /// A `---` horizontal rule in the body must not close the front matter early
    /// nor leak body keys into the metadata map.
    #[test]
    fn body_rule_does_not_extend_front_matter() {
        let md = "---\nname: s\ndescription: real\n---\n\nintro\n\n---\n\ninjected: nope\n";
        let fm = parse_front_matter(md);
        assert_eq!(fm.get("description").map(String::as_str), Some("real"));
        assert!(!fm.contains_key("injected"), "body content leaked into metadata: {:?}", fm);
    }

    /// Which lines count as metadata keys (Java `frontmatterKey` parity).
    #[test]
    fn front_matter_key_rules() {
        let md = "---\nname: s\n# comment\n- list item\n\nno-colon line\n: orphan value\nfoo.bar: x\nok_key: yes\n---\n";
        let fm = parse_front_matter(md);
        // Comments, list items, blanks, colon-less lines, empty keys and
        // non-identifier keys are all skipped.
        for bad in ["#", "-", "no-colon line", "foo.bar"] {
            assert!(!fm.contains_key(bad), "{:?} should not be a key, got {:?}", bad, fm);
        }
        assert_eq!(fm.get("name").map(String::as_str), Some("s"));
        assert_eq!(fm.get("ok_key").map(String::as_str), Some("yes"));
        assert_eq!(fm.len(), 2, "got {:?}", fm);
    }

    /// A value containing colons keeps everything after the **first** one —
    /// that is what makes `url: https://host/x` parse correctly.
    #[test]
    fn values_may_contain_colons() {
        let md = "---\nname: s\nurl: https://api.example.com:8443/v1\n---\n";
        let fm = parse_front_matter(md);
        assert_eq!(fm.get("url").map(String::as_str), Some("https://api.example.com:8443/v1"));
    }

    #[test]
    fn absent_enabled_means_enabled() {
        let s = Scratch::new("enabled-default");
        s.skill("a", "---\nname: a\ndescription: d\n---\n\n# A\n");
        let all = SkillRegistry::with_dir(s.0.clone()).load_all();
        assert_eq!(all.len(), 1);
        assert!(all[0].enabled, "a skill with no enabled key must be enabled");
    }

    #[test]
    fn enabled_false_is_honoured() {
        let s = Scratch::new("enabled-false");
        s.skill("a", "---\nname: a\ndescription: d\nenabled: false\n---\n\n# A\n");
        let all = SkillRegistry::with_dir(s.0.clone()).load_all();
        assert!(!all[0].enabled);
    }

    /// Disabled skills must still be listed — otherwise the UI has no way to
    /// re-enable them (Java uses `getSkillsAll` for exactly this reason).
    #[test]
    fn disabled_skills_are_still_listed_but_excluded_from_the_prompt() {
        let s = Scratch::new("prompt-filter");
        s.skill("on", "---\nname: on\ndescription: usable\n---\n\n# On\n");
        s.skill("off", "---\nname: off\ndescription: disabled one\nenabled: false\n---\n\n# Off\n");
        let reg = SkillRegistry::with_dir(s.0.clone());
        assert_eq!(reg.load_all().len(), 2, "both must be listed");
        let prompt = reg.prompt_summary();
        assert!(prompt.contains("usable"));
        assert!(!prompt.contains("disabled one"), "disabled skill leaked into the system prompt");
    }

    /// The switch must survive a reload — the defect that made it a no-op.
    #[test]
    fn set_enabled_round_trips_through_a_reload() {
        let s = Scratch::new("toggle");
        let dir = s.skill("a", "---\nname: a\ndescription: d\nversion: 1.2.3\n---\n\n# A\n\nbody\n");
        assert!(set_enabled(&dir, false).unwrap());

        let all = SkillRegistry::with_dir(s.0.clone()).load_all();
        assert_eq!(all.len(), 1);
        assert!(!all[0].enabled, "the toggle did not persist");
        assert_eq!(all[0].version.as_deref(), Some("1.2.3"), "unrelated front matter was lost");

        let content = std::fs::read_to_string(dir.join("SKILL.md")).unwrap();
        assert!(content.contains("# A"), "body was lost");
        assert!(content.contains("body"), "body was lost");

        // Toggling again replaces the line rather than appending a second one.
        assert!(set_enabled(&dir, true).unwrap());
        let content2 = std::fs::read_to_string(dir.join("SKILL.md")).unwrap();
        assert_eq!(content2.matches("enabled:").count(), 1, "duplicate enabled key: {}", content2);
        assert!(SkillRegistry::with_dir(s.0.clone()).load_all()[0].enabled);
    }

    /// No front matter at all: a block is prepended and the body is untouched.
    #[test]
    fn set_enabled_prepends_a_block_when_there_is_no_front_matter() {
        let s = Scratch::new("toggle-nofm");
        let dir = s.skill("a", "# Plain skill\n\nsome prose\n");
        assert!(set_enabled(&dir, false).unwrap());
        let content = std::fs::read_to_string(dir.join("SKILL.md")).unwrap();
        assert!(content.starts_with("---\nenabled: false\n---\n"), "got: {}", content);
        assert!(content.contains("# Plain skill"));
        assert!(!SkillRegistry::with_dir(s.0.clone()).load_all()[0].enabled);
    }

    /// CRLF files must stay CRLF: normalizing them rewrites every line and shows
    /// up as a whole-file git diff.
    #[test]
    fn set_enabled_preserves_crlf_line_endings() {
        let s = Scratch::new("toggle-crlf");
        let dir = s.skill("a", "---\r\nname: a\r\ndescription: d\r\n---\r\n\r\n# A\r\n");
        assert!(set_enabled(&dir, false).unwrap());
        let bytes = std::fs::read(dir.join("SKILL.md")).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(!text.contains("\r\r\n"), "double CR introduced");
        let crlf = text.matches("\r\n").count();
        let lf = text.matches('\n').count();
        assert_eq!(crlf, lf, "mixed line endings: {} CRLF vs {} LF", crlf, lf);
        assert!(text.contains("enabled: false"));
    }

    /// A leading BOM must stay at byte 0 — inserting a line above it would put
    /// the BOM mid-file, where it renders as a stray character.
    #[test]
    fn set_enabled_keeps_a_bom_at_the_start() {
        let s = Scratch::new("toggle-bom");
        let dir = s.skill("a", "\u{feff}# Plain\n\nprose\n");
        assert!(set_enabled(&dir, false).unwrap());
        let text = std::fs::read_to_string(dir.join("SKILL.md")).unwrap();
        assert!(text.starts_with('\u{feff}'), "BOM lost or moved: {:?}", &text[..20.min(text.len())]);
        assert_eq!(text.matches('\u{feff}').count(), 1);
    }

    #[test]
    fn set_enabled_reports_failure_without_a_skill_md() {
        let s = Scratch::new("toggle-missing");
        let d = s.0.join("empty");
        std::fs::create_dir_all(&d).unwrap();
        assert!(!set_enabled(&d, false).unwrap(), "no SKILL.md must not report success");
    }

    // ── displayName trust boundary ────────────────────────────────────────

    #[test]
    fn display_name_prefers_market_metadata() {
        let meta = MarketMeta {
            market: "skillhub.cn".into(),
            slug: "@user_814dbe54/dev-expert".into(),
            icon_url: "https://x/i.png".into(),
            display_name: "编程专家.Skill".into(),
        };
        assert_eq!(display_name_of(Some(&meta)).as_deref(), Some("编程专家.Skill"));
    }

    /// Legacy installs recorded only market/slug/icon: fall back to the bare tail
    /// of the slug, which is readable and matches the marketplace card.
    #[test]
    fn display_name_falls_back_to_the_bare_slug() {
        let meta = MarketMeta {
            market: "skillhub.cn".into(),
            slug: "@user_814dbe54/dev-expert".into(),
            icon_url: String::new(),
            display_name: String::new(),
        };
        assert_eq!(display_name_of(Some(&meta)).as_deref(), Some("dev-expert"));
    }

    #[test]
    fn display_name_is_none_without_metadata() {
        assert_eq!(display_name_of(None), None);
    }

    /// `@/slug` is malformed. Both ends must agree, which requires `> 1`: with
    /// `> 0` the frontend would strip it and the kernel would not, so the same
    /// skill shows two different names.
    #[test]
    fn bare_slug_matches_the_frontend_boundary_rule() {
        assert_eq!(market_bare_slug("@/slug").as_deref(), Some("@/slug"));
        assert_eq!(market_bare_slug("@a/b").as_deref(), Some("b"));
        assert_eq!(market_bare_slug("plain").as_deref(), Some("plain"));
        assert_eq!(market_bare_slug("").is_none(), true);
    }

    /// The package's own `displayName` must NOT be used: SKILL.md is third-party
    /// content, so trusting it lets a publisher impersonate another skill.
    #[test]
    fn skill_md_display_name_is_not_trusted() {
        let s = Scratch::new("trust");
        // SKILL.md declares displayName "Agent Browser", but there is no market
        // metadata, so nothing may surface that self-declared name.
        s.skill("impersonator", "---\nname: impersonator\ndisplayName: \"Agent Browser\"\ndescription: d\n---\n\n# X\n");
        let all = SkillRegistry::with_dir(s.0.clone()).load_all();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].market, None);
        assert_eq!(display_name_of(all[0].market.as_ref()), None, "self-declared displayName was trusted");
    }

    // ── scanning ──────────────────────────────────────────────────────────

    #[test]
    fn reads_market_metadata_from_the_skill_dir() {
        let s = Scratch::new("meta");
        s.skill("a", "---\nname: a\ndescription: d\n---\n\n# A\n");
        s.meta("a", r#"{"market":"skillhub.cn","slug":"a","iconUrl":"https://x/i.png"}"#);
        let all = SkillRegistry::with_dir(s.0.clone()).load_all();
        let m = all[0].market.as_ref().expect("market metadata should be read");
        assert_eq!(m.market, "skillhub.cn");
        assert_eq!(m.icon_url, "https://x/i.png");
    }

    #[test]
    fn corrupt_market_metadata_degrades_to_none() {
        let s = Scratch::new("meta-bad");
        s.skill("a", "---\nname: a\ndescription: d\n---\n\n# A\n");
        s.meta("a", "{not json");
        let all = SkillRegistry::with_dir(s.0.clone()).load_all();
        assert_eq!(all.len(), 1, "a bad meta file must not drop the skill");
        assert!(all[0].market.is_none());
    }

    /// Dot-directories and folders without a SKILL.md are not skills.
    #[test]
    fn non_skill_entries_are_skipped() {
        let s = Scratch::new("skip");
        s.skill("real", "---\nname: real\ndescription: d\n---\n\n# R\n");
        std::fs::create_dir_all(s.0.join(".cache")).unwrap();
        std::fs::create_dir_all(s.0.join("no-md")).unwrap();
        std::fs::write(s.0.join("loose-file.md"), "x").unwrap();
        let all = SkillRegistry::with_dir(s.0.clone()).load_all();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "real");
    }

    /// `skill.md` (lowercase) is accepted, matching the Java resolver.
    #[test]
    fn lowercase_skill_md_is_accepted() {
        let s = Scratch::new("lowercase");
        let d = s.0.join("a");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("skill.md"), "---\nname: a\ndescription: d\n---\n\n# A\n").unwrap();
        let all = SkillRegistry::with_dir(s.0.clone()).load_all();
        assert_eq!(all.len(), 1);
    }

    /// A project-local skill shadows a global one of the same name.
    #[test]
    fn workspace_scope_shadows_global() {
        let g = Scratch::new("scope-global");
        let w = Scratch::new("scope-ws");
        std::fs::create_dir_all(w.0.join(".gwork").join("skills")).unwrap();
        let ws_skills = w.0.join(".gwork").join("skills");

        std::fs::create_dir_all(g.0.join("dup")).unwrap();
        std::fs::write(g.0.join("dup").join("SKILL.md"), "---\nname: dup\ndescription: from global\n---\n\n# G\n").unwrap();
        std::fs::create_dir_all(ws_skills.join("dup")).unwrap();
        std::fs::write(ws_skills.join("dup").join("SKILL.md"), "---\nname: dup\ndescription: from workspace\n---\n\n# W\n").unwrap();
        std::fs::create_dir_all(ws_skills.join("only-ws")).unwrap();
        std::fs::write(ws_skills.join("only-ws").join("SKILL.md"), "---\nname: only-ws\ndescription: ws only\n---\n\n# O\n").unwrap();

        let reg = SkillRegistry { global_dir: g.0.clone(), workspace_dir: Some(ws_skills.clone()) };
        let all = reg.load_all();
        assert_eq!(all.len(), 2, "expected dup + only-ws, got {:?}", all.iter().map(|s| &s.name).collect::<Vec<_>>());
        let dup = all.iter().find(|s| s.name == "dup").unwrap();
        assert_eq!(dup.description, "from workspace", "workspace must shadow global");
        assert_eq!(dup.scope, SkillScope::Workspace);
    }

    #[test]
    fn find_dir_prefers_the_workspace_copy() {
        let g = Scratch::new("find-global");
        let w = Scratch::new("find-ws");
        let ws_skills = w.0.join(".gwork").join("skills");
        std::fs::create_dir_all(g.0.join("dup")).unwrap();
        std::fs::write(g.0.join("dup").join("SKILL.md"), "# g").unwrap();
        std::fs::create_dir_all(ws_skills.join("dup")).unwrap();
        std::fs::write(ws_skills.join("dup").join("SKILL.md"), "# w").unwrap();

        let reg = SkillRegistry { global_dir: g.0.clone(), workspace_dir: Some(ws_skills.clone()) };
        assert_eq!(reg.find_dir("dup").unwrap(), ws_skills.join("dup"));
        assert!(reg.find_dir("missing").is_none());
    }

    /// Titles fall back to the first heading, then to the directory name.
    #[test]
    fn title_fallback_chain() {
        let s = Scratch::new("title");
        s.skill("with-heading", "---\nname: a\ndescription: d\n---\n\n# Real Title\n");
        s.skill("no-heading", "---\nname: b\ndescription: d\n---\n\njust prose\n");
        let all = SkillRegistry::with_dir(s.0.clone()).load_all();
        let by = |n: &str| all.iter().find(|s| s.name == n).unwrap().title.clone();
        assert_eq!(by("with-heading"), "Real Title");
        assert_eq!(by("no-heading"), "no-heading", "must fall back to the directory name");
    }

    #[test]
    fn description_falls_back_to_the_title_when_absent() {
        let s = Scratch::new("desc-fallback");
        s.skill("a", "---\nname: a\n---\n\n# Only Title\n");
        let all = SkillRegistry::with_dir(s.0.clone()).load_all();
        assert_eq!(all[0].description, "Only Title");
    }

    #[test]
    fn empty_registry_yields_no_prompt_block() {
        let s = Scratch::new("empty");
        assert_eq!(SkillRegistry::with_dir(s.0.clone()).prompt_summary(), "");
    }

    // ── listing budget & per-entry cap ──────────────────────────────────────
    //
    // The listing is injected into the system prompt on **every turn** and its
    // descriptions come from third-party SKILL.md files, so both the per-entry and
    // the total size must be bounded. Measured before these limits existed: one
    // 10 000-char description produced a 30 173-char prompt block.
    //
    // These mirror the Java kernel's `SkillListingPolicy` / `SkillTalent` contracts
    // so a skill behaves the same on either kernel.

    #[test]
    fn budget_is_one_percent_of_the_context_window() {
        // Claude Code's `skillListingBudgetFraction` default is 1%.
        assert_eq!(listing_budget_chars(Some(128_000), 1), 1280);
        assert_eq!(listing_budget_chars(Some(256_000), 1), 2560);
        assert_eq!(listing_budget_chars(Some(512_000), 1), 5120);
        assert_eq!(listing_budget_chars(Some(1_000_000), 1), 10_000);
        // The fraction is configurable.
        assert_eq!(listing_budget_chars(Some(256_000), 2), 5120);
    }

    #[test]
    fn budget_falls_back_safely_on_bad_input() {
        // Missing / non-positive window → the default 256K window.
        assert_eq!(listing_budget_chars(None, 1), 2560);
        assert_eq!(listing_budget_chars(Some(0), 1), 2560);
        assert_eq!(listing_budget_chars(Some(-1), 1), 2560);
        // Out-of-range fraction → the default 1%, never 0 (an empty listing would
        // mean "no skills exist" to the model).
        assert_eq!(listing_budget_chars(Some(256_000), 0), 2560);
        assert_eq!(listing_budget_chars(Some(256_000), 99), 2560);
        assert!(listing_budget_chars(Some(1), 1) >= 1, "budget must never be 0");
    }

    #[test]
    fn settings_are_normalized_not_clamped() {
        // A 0 or a 99 here is a config mistake; clamping would silently accept a
        // budget the user never asked for (0 would empty the listing entirely).
        assert_eq!(normalize_budget_fraction(None), DEFAULT_LISTING_BUDGET_FRACTION);
        assert_eq!(normalize_budget_fraction(Some(0)), DEFAULT_LISTING_BUDGET_FRACTION);
        assert_eq!(normalize_budget_fraction(Some(99)), DEFAULT_LISTING_BUDGET_FRACTION);
        assert_eq!(normalize_budget_fraction(Some(5)), 5);
        assert_eq!(normalize_budget_fraction(Some(10)), 10);

        assert_eq!(normalize_max_desc_chars(0), DESCRIPTION_MAX_CHARS);
        assert_eq!(normalize_max_desc_chars(999_999), DESCRIPTION_MAX_CHARS);
        assert_eq!(normalize_max_desc_chars(256), 256);
        assert_eq!(normalize_max_desc_chars(8192), 8192);
    }

    #[test]
    fn overlong_description_is_truncated_with_an_ellipsis() {
        let huge = "长".repeat(10_000);
        let clipped = clip_description(&huge, DESCRIPTION_MAX_CHARS);
        assert_eq!(clipped.chars().count(), DESCRIPTION_MAX_CHARS);
        assert!(clipped.ends_with('…'), "must be marked as truncated");
        // A description within the cap is untouched.
        assert_eq!(clip_description("short", DESCRIPTION_MAX_CHARS), "short");
    }

    #[test]
    fn the_per_entry_cap_setting_actually_takes_effect() {
        // Regression guard against a settings field that is stored but never read:
        // a knob the user can turn without any effect is worse than no knob.
        let s = Scratch::new("cap-setting");
        s.skill("a", &format!("---\nname: a\ndescription: {}\n---\n\n# A\n", "x".repeat(500)));
        let reg = SkillRegistry::with_dir(s.0.clone());

        let tight = reg.prompt_summary_with_budget(Some(1_000_000), 1, 64);
        let loose = reg.prompt_summary_with_budget(Some(1_000_000), 1, 1024);

        assert!(tight.contains(&"x".repeat(63)), "tight cap not applied: {}", tight);
        assert!(tight.contains('…'));
        assert!(loose.contains(&"x".repeat(500)), "loose cap should keep all 500 chars");
        assert!(tight.len() < loose.len(), "a tighter cap must produce a shorter listing");
    }

    #[test]
    fn within_budget_keeps_every_description() {
        let s = Scratch::new("budget-ok");
        s.skill("alpha", "---\nname: alpha\ndescription: short A\n---\n\n# A\n");
        s.skill("beta", "---\nname: beta\ndescription: short B\n---\n\n# B\n");
        let out = SkillRegistry::with_dir(s.0.clone())
            .prompt_summary_with_budget(Some(256_000), 1, DESCRIPTION_MAX_CHARS);

        assert!(out.contains("short A"), "description dropped without cause: {}", out);
        assert!(out.contains("short B"), "description dropped without cause: {}", out);
        assert!(!out.contains("omitted"), "no degradation notice expected within budget");
    }

    #[test]
    fn over_budget_drops_the_longest_descriptions_but_keeps_every_name() {
        let s = Scratch::new("budget-over");
        s.skill("short-one", &format!("---\nname: short-one\ndescription: {}\n---\n\n# S\n", "短".repeat(20)));
        s.skill("long-one", &format!("---\nname: long-one\ndescription: {}\n---\n\n# L\n", "长".repeat(2000)));
        s.skill("mid-one", &format!("---\nname: mid-one\ndescription: {}\n---\n\n# M\n", "中".repeat(500)));

        // 128K window → 1280 chars. The three entries render to ~1589 chars
        // (long-one is itself clipped to the 1024 cap first), so the budget bites.
        let out = SkillRegistry::with_dir(s.0.clone())
            .prompt_summary_with_budget(Some(128_000), 1, DESCRIPTION_MAX_CHARS);

        // Names are always kept: a skill the model cannot see does not exist.
        for n in ["short-one", "long-one", "mid-one"] {
            assert!(out.contains(&format!("**{}**", n)), "name dropped: {}", out);
        }
        // Longest first: long-one is the only one dropped, mid-one still fits.
        assert!(!out.contains("long-one**:"), "the longest description survived: {}", out);
        assert!(out.contains(&"中".repeat(500)), "mid-one should not have been dropped");
        assert!(out.contains(&"短".repeat(20)), "the shortest description should have been kept");
        // The model must be told the bare names are still usable.
        assert!(out.contains("skillread"), "no hint that omitted skills are still loadable");
    }

    #[test]
    fn a_larger_window_keeps_descriptions_that_a_smaller_one_drops() {
        let s = Scratch::new("budget-window");
        for n in ["a", "b", "c"] {
            s.skill(n, &format!("---\nname: {}\ndescription: {}\n---\n\n# X\n", n, "x".repeat(600)));
        }
        let reg = SkillRegistry::with_dir(s.0.clone());

        let small = reg.prompt_summary_with_budget(Some(128_000), 1, DESCRIPTION_MAX_CHARS);
        let large = reg.prompt_summary_with_budget(Some(1_000_000), 1, DESCRIPTION_MAX_CHARS);

        assert!(small.contains("omitted"), "1280-char budget should have degraded: {}", small);
        assert!(!large.contains("omitted"), "10 000-char budget should not degrade");
        assert_eq!(large.matches(&"x".repeat(600)).count(), 3, "all three descriptions should fit");
    }

    /// The lenient line parser must not read nested keys as top-level ones —
    /// otherwise `metadata.version` or an `allowed-tools` list item would shadow a
    /// real field. Java's salvage path has the same rule.
    #[test]
    fn lenient_parser_ignores_nested_and_list_lines() {
        let md = "---\nname: dev-expert\ndescription: d\nallowed-tools:\n  - Read\nmetadata:\n  version: \"42\"\n---\n\n# B\n";
        let fm = parse_front_matter(md);
        assert_eq!(fm.get("name").map(String::as_str), Some("dev-expert"));
        assert!(!fm.contains_key("Read"), "a list item was read as a key: {:?}", fm);
        assert_eq!(
            fm.get("version").map(String::as_str),
            None,
            "a nested metadata.version must not shadow a top-level field: {:?}",
            fm
        );
    }

    /// `enabled` must survive the lenient parse, or the UI toggle is a no-op —
    /// the exact defect the Java kernel had when SnakeYAML rejected the file.
    #[test]
    fn enabled_false_survives_the_broken_yaml_shape() {
        let s = Scratch::new("enabled-broken-yaml");
        // description embeds bare quotes inside a quoted scalar: invalid YAML,
        // but the line parser still reads every top-level key.
        s.skill(
            "bad-yaml",
            "---\nname: bad-yaml\ndescription: \"Do things. Triggers include \"open a website\", \"click\".\"\nenabled: false\n---\n\n# B\n",
        );
        let reg = SkillRegistry::with_dir(s.0.clone());
        let all = reg.load_all();
        assert_eq!(all.len(), 1);
        assert!(!all[0].enabled, "enabled: false was lost");
        assert!(
            all[0].description.contains("open a website"),
            "description was lost: {:?}",
            all[0].description
        );
        // A disabled skill must not reach the prompt at all.
        assert_eq!(reg.prompt_summary(), "", "a disabled skill leaked into the prompt");
    }

    /// The UI toggle must round-trip on the broken-YAML shape too.
    #[test]
    fn toggling_a_broken_yaml_skill_is_visible_immediately() {
        invalidate_cache();
        let s = Scratch::new("toggle-broken-yaml");
        let dir = s.skill(
            "bad-yaml",
            "---\nname: bad-yaml\ndescription: \"Triggers include \"open a website\".\"\n---\n\n# B\n",
        );
        let reg = SkillRegistry::with_dir(s.0.clone());
        assert!(reg.load_all()[0].enabled, "starts enabled");

        assert!(set_enabled(&dir, false).unwrap());
        assert!(!reg.load_all()[0].enabled, "the toggle did not take effect");
        assert_eq!(reg.prompt_summary(), "", "still injected after being disabled");

        assert!(set_enabled(&dir, true).unwrap());
        assert!(reg.load_all()[0].enabled, "re-enabling failed");
        assert!(reg.prompt_summary().contains("bad-yaml"));
        invalidate_cache();
    }
}
