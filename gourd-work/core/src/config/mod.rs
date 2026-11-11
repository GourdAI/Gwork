//! config — settings.json compatible configuration loading.
//!
//! Reads the same `~/.gwork/settings.json` (or `~/.gourdai/settings.json`) that the
//! Java kernel uses, so the Rust kernel shares model configuration with zero migration.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use indexmap::IndexMap;
use once_cell::sync::Lazy;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

// ─── Harness base resolution ──────────────────────────────────────────────────

/// Process-level override for the harness base directory, set by the CLI's
/// `--home <dir>` flag. `None` means "fall through to env / real home".
///
/// A lock (not a `OnceLock`) because tests need to set and clear it repeatedly.
static BASE_OVERRIDE: Lazy<RwLock<Option<PathBuf>>> = Lazy::new(|| RwLock::new(None));

/// Memoized env/home-derived base. Only consulted when no override is set, so
/// setting an override later still takes effect.
static BASE_FROM_ENV: OnceLock<PathBuf> = OnceLock::new();

/// Environment variables that may redirect the harness base, in priority order.
/// Mirrors Java's `AgentFlags.getHarnessBase()` (`GWORK_HOME` then the legacy
/// `GOURDAI_HOME`). Java's `-Dgwork.home` system property has no Rust analogue;
/// the CLI `--home` flag fills that slot via [`set_harness_base`].
const BASE_ENV_VARS: [&str; 2] = ["GWORK_HOME", "GOURDAI_HOME"];

/// Resolve the harness base directory — the **parent** of `.gwork`.
///
/// Order: explicit override (`--home`) → `GWORK_HOME` → `GOURDAI_HOME` →
/// the real user home. Blank/whitespace-only values are skipped, matching
/// Java's `trimmed()` helper.
///
/// Without this the Rust kernel silently ignored `GWORK_HOME`, so any launcher
/// that redirected the Java kernel to a non-default global area made the Rust
/// kernel look like it had lost all its data.
pub fn harness_base() -> PathBuf {
    if let Ok(guard) = BASE_OVERRIDE.read() {
        if let Some(p) = guard.as_ref() {
            return p.clone();
        }
    }
    BASE_FROM_ENV
        .get_or_init(|| {
            resolve_base(None, |k| std::env::var(k).ok(), dirs::home_dir())
        })
        .clone()
}

/// Set (or clear, with `None`) the process-level harness base override.
///
/// Must be called **before** the kernel touches any global-area path, i.e. at
/// the top of `main()`. Calling it later does not retroactively fix paths that
/// were already resolved and cached by callers.
pub fn set_harness_base(dir: Option<PathBuf>) {
    if let Ok(mut guard) = BASE_OVERRIDE.write() {
        *guard = dir.map(|p| normalize_base(&p));
    }
}

/// Pure resolution logic, split out so it can be tested without mutating
/// process-global state (env vars and the override lock).
fn resolve_base(
    override_dir: Option<&Path>,
    env: impl Fn(&str) -> Option<String>,
    home: Option<PathBuf>,
) -> PathBuf {
    if let Some(p) = override_dir {
        return normalize_base(p);
    }
    for key in BASE_ENV_VARS {
        if let Some(raw) = env(key) {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                return normalize_base(Path::new(trimmed));
            }
        }
    }
    home.map(|h| normalize_base(&h))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Strip a trailing separator so `base.join(".gwork")` never produces a double
/// separator, and collapse an empty path to `.`.
fn normalize_base(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    let trimmed = s.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        PathBuf::from(".")
    } else {
        PathBuf::from(trimmed)
    }
}

/// Top-level settings.json structure (compatible with Java kernel's AgentSettings).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Settings {
    pub general: GeneralSettings,
    pub permission: PermissionSettings,
    #[serde(rename = "defaultModel")]
    pub default_model: String,
    /// Model registry: key = model name, value = model config.
    /// Supports both object-map format (new) and array format (legacy, normalized on load).
    ///
    /// **Insertion-ordered on purpose.** The frontend groups the model picker
    /// by "provider changed vs previous entry" (model-selector.js), so a
    /// scrambled iteration order turns 3 providers into ~96 alternating
    /// group headers. The Java kernel's LinkedHashMap gives config order;
    /// a plain HashMap here silently broke that contract.
    #[serde(deserialize_with = "deserialize_models")]
    pub models: IndexMap<String, ModelConfig>,
}

/// General settings section.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct GeneralSettings {
    #[serde(rename = "historyWindowSize")]
    pub history_window_size: u32,
    #[serde(rename = "apiRetries")]
    pub api_retries: u32,
    /// Retry count for the model (LLM stream) calls themselves (Java
    /// `GeneralGroupDo.modelRetries`, default 3; Java feeds it to
    /// `AgentFactory.builder.retryConfig(...)` / `HarnessEngine.setModelRetries`).
    ///
    /// This kernel was missing the key entirely: the settings page's "model
    /// retries" box posts `modelRetries`, serde dropped it as an unknown field,
    /// and `GET /web/settings/general` returned nothing for it — so the box read
    /// back empty on every revisit while the loop quietly borrowed `apiRetries`
    /// (which in Java drives only the OpenAPI gateway / webfetch tools). The
    /// shared settings.json contract needs both keys under their Java names.
    #[serde(rename = "modelRetries")]
    pub model_retries: u32,
    #[serde(rename = "maxTurns")]
    pub max_turns: u32,
    /// Self-reflection continuation (Java `AgentProperties.autoRethink`, default true).
    ///
    /// When true the turn limit is a **soft** budget: at ~80% of it the loop
    /// injects a self-review prompt and extends the ceiling instead of aborting.
    /// When false the limit is a hard stop.
    ///
    /// This field was missing entirely, so `"autoRethink": true` in settings.json
    /// was silently dropped by serde and every long task died at turn 20 with
    /// "Reached maximum turns (20). Task may be incomplete." — while the Java
    /// kernel, reading the same file, kept going.
    #[serde(rename = "autoRethink")]
    pub auto_rethink: bool,
    /// Context window used for compression budgeting when the session has no
    /// explicit choice (Java `ContextLengthPolicy.DEFAULT_CONTEXT_LENGTH`).
    #[serde(rename = "contextLength")]
    pub context_length: i64,
    /// Compress when the estimated context reaches this percentage of the window
    /// (Java `compressionRatio`, clamped 1..=100; 100 = rely on absolute reserve).
    #[serde(rename = "compressionRatio")]
    pub compression_ratio: u32,
    /// Water level to compress down to, as a percentage of the effective window
    /// (Java `compressionTargetRatio`, clamped 10..=95).
    #[serde(rename = "compressionTargetRatio")]
    pub compression_target_ratio: u32,
    /// Tokens reserved for one turn's model output (Java
    /// `compressionReservedOutputTokens`, floor 1000).
    #[serde(rename = "compressionReservedOutputTokens")]
    pub compression_reserved_output_tokens: u64,
    /// Message-count dimension of the retention window (Java
    /// `HarnessOptions.compressionMaxMessages`).
    #[serde(rename = "compressionMaxMessages")]
    pub compression_max_messages: u32,
    #[serde(rename = "memoryEnabled")]
    pub memory_enabled: bool,
    /// Whether workspace memory is isolated per-project. When false, memory is
    /// shared and stored in the install directory instead of the user home
    /// (Java: `AgentProperties.memoryIsolation`, default true).
    #[serde(rename = "memoryIsolation")]
    pub memory_isolation: bool,
    pub locale: String,
    #[serde(rename = "darkMode")]
    pub dark_mode: bool,
    /// Model used by the ACP (editor integration) subprocess. ACP runs out of
    /// process and shares no session state, so its model is chosen up front on
    /// the settings page. `None` = fall back to `defaultModel`.
    ///
    /// Modelled here (rather than read ad hoc from raw JSON) so that removing a
    /// model can repair a dangling reference — Java's
    /// `AgentSettings.repairRemovedModelReferences` clears `general.acpModel`
    /// when the model it pointed at is deleted.
    #[serde(rename = "acpModel", default, skip_serializing_if = "Option::is_none")]
    pub acp_model: Option<String>,
    /// Thinking depth preset for ACP. `None` = follow the model default.
    #[serde(rename = "acpThinkingDepth", default, skip_serializing_if = "Option::is_none")]
    pub acp_thinking_depth: Option<String>,
    /// Context window preset for ACP. `None` = follow the model default.
    #[serde(rename = "acpContextLength", default, skip_serializing_if = "Option::is_none")]
    pub acp_context_length: Option<u64>,
    /// Skill listing budget as a percentage of the context window (Java
    /// `general.skillListingBudgetFraction`).
    ///
    /// The skill listing is injected into the system prompt on **every turn**, and
    /// its descriptions come from third-party `SKILL.md` files, so the total size
    /// must be bounded. Claude Code budgets 1% of the window
    /// (`skillListingBudgetFraction`); when the listing overflows, descriptions are
    /// dropped longest-first and names are kept. Clamped to 1..=10 by
    /// `skills::normalize_budget_fraction` — a typo in settings.json must not make
    /// the whole skill library disappear from the prompt.
    #[serde(rename = "skillListingBudgetFraction")]
    pub skill_listing_budget_fraction: u32,
    /// Per-skill description cap (chars) for the listing (Java
    /// `general.skillListingMaxDescChars`).
    ///
    /// Defaults to the Agent Skills spec's own 1024. Over-long descriptions are
    /// truncated with an ellipsis rather than dropping the skill, so an installed
    /// skill never silently vanishes.
    #[serde(rename = "skillListingMaxDescChars")]
    pub skill_listing_max_desc_chars: u32,
    /// Display name of the assistant shown in the chat message header
    /// (avatar + name row, WorkBuddy-style). `None` = the built-in default
    /// "GWork"; the frontend falls back itself, so an absent key never
    /// renders as an empty header.
    ///
    /// Purely cosmetic: it is never injected into prompts or logs, so a
    /// third-party value here cannot become a prompt-injection surface the
    /// way skill descriptions can.
    #[serde(rename = "assistantName", default, skip_serializing_if = "Option::is_none")]
    pub assistant_name: Option<String>,
    /// HTTP Basic Auth username for the kernel's web surface (Java
    /// `GeneralGroupDo.webAuthUser`). Empty = auth disabled.
    ///
    /// These two fields were missing entirely, so a `settings.json` that
    /// configured them was silently ignored by this kernel while the Java
    /// kernel — reading the same file — enforced them. See
    /// [`crate::server::guard`] for why that mattered: without any credential
    /// check, and with `Access-Control-Allow-Origin: *`, any web page in any
    /// browser on the machine could drive the agent and execute shell commands.
    ///
    /// Auth is enforced only when **both** halves are non-empty, matching Java's
    /// `Utils.isBlank` test. A half-configured pair must not lock the user out
    /// of the settings page that would repair it.
    #[serde(rename = "webAuthUser", default, skip_serializing_if = "Option::is_none")]
    pub web_auth_user: Option<String>,
    /// HTTP Basic Auth password (Java `GeneralGroupDo.webAuthPass`).
    #[serde(rename = "webAuthPass", default, skip_serializing_if = "Option::is_none")]
    pub web_auth_pass: Option<String>,

    /// Retry count for MCP-backed tools (Java `GeneralGroupDo.mcpRetries`, default 3).
    ///
    /// Java splits its retries at `HarnessEngine.java:1005-1007`:
    /// `codeSearchTalent` / `websearchTalent` take `options.getMcpRetries()` while
    /// `webfetchTalent` takes `options.getApiRetries()`. This kernel previously
    /// modelled only `apiRetries` and borrowed it for LLM streams too, so the
    /// web tools had no retry budget of their own and the settings page's
    /// model-retries box (`modelRetries`, see above) had no field to land in.
    /// The split is kept here so a settings.json shared with the Java kernel
    /// drives both kernels identically: `modelRetries` → LLM streams,
    /// `apiRetries` → HTTP web tools, `mcpRetries` → the Exa MCP `codesearch`
    /// tool.
    #[serde(rename = "mcpRetries")]
    pub mcp_retries: u32,

    /// Explicit outbound HTTP proxy for the web tools, e.g. `http://127.0.0.1:7890`.
    ///
    /// Empty = fall back to the standard `HTTPS_PROXY` / `ALL_PROXY` /
    /// `HTTP_PROXY` environment variables, then to a direct connection. Exists
    /// because the keyless endpoints (`html.duckduckgo.com`, `r.jina.ai`,
    /// `mcp.exa.ai`) are unreachable from some networks while a system proxy is
    /// configured in the OS but not exported to the process environment. Java
    /// has the equivalent per-MCP-server `McpClientProperties.httpProxy`
    /// (`gourdai-java/.../McpClientProperties.java:83`).
    #[serde(rename = "webProxy")]
    pub web_proxy: String,

    /// Wall-clock budget for one web tool call, **including** its retries and
    /// backoff waits (seconds). Java's `WebfetchTalent.java:99-109` derives this
    /// as `min(timeout * 2, 120s)`; that cap is exactly what stops a weak network
    /// turning `maxRetries` into minutes of silence. Default 120s matches Java's
    /// `MAX_TIMEOUT_MS`. A budget of 0 disables the cap.
    #[serde(rename = "webRetryBudgetSecs")]
    pub web_retry_budget_secs: u32,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            history_window_size: 30,
            api_retries: 3,
            model_retries: 3,
            max_turns: 20,
            auto_rethink: true,
            context_length: crate::usage::DEFAULT_CONTEXT_LENGTH,
            compression_ratio: 100,
            compression_target_ratio: 45,
            compression_reserved_output_tokens: 20_000,
            compression_max_messages: 30,
            memory_enabled: true,
            memory_isolation: true,
            locale: "en".into(),
            dark_mode: false,
            acp_model: None,
            acp_thinking_depth: None,
            acp_context_length: None,
            skill_listing_budget_fraction: crate::skills::DEFAULT_LISTING_BUDGET_FRACTION,
            skill_listing_max_desc_chars: crate::skills::DESCRIPTION_MAX_CHARS as u32,
            assistant_name: None,
            // Auth off by default, exactly like Java. The Origin/Host guard in
            // `server::guard` is what makes the default local install safe; these
            // credentials are for the remote/exposed deployment case.
            web_auth_user: None,
            web_auth_pass: None,
            mcp_retries: 3,
            web_proxy: String::new(),
            web_retry_budget_secs: 120,
        }
    }
}

/// Permission settings section.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PermissionSettings {
    /// Allowed tool patterns (glob). `["**"]` = all allowed.
    pub tools: Vec<String>,
    /// Explicitly disallowed tool names.
    #[serde(rename = "disallowedTools")]
    pub disallowed_tools: Vec<String>,
    /// Directories exempt from bash approval.
    #[serde(rename = "bashExemptDirs")]
    pub bash_exempt_dirs: Vec<String>,
}

impl Default for PermissionSettings {
    fn default() -> Self {
        Self {
            tools: vec!["**".into()],
            disallowed_tools: vec![],
            bash_exempt_dirs: vec![],
        }
    }
}

/// Single model configuration (compatible with Java's ModelDo).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ModelConfig {
    pub name: String,
    pub enabled: bool,
    pub visibled: bool,
    pub scope: String,
    #[serde(rename = "apiUrl")]
    pub api_url: String,
    #[serde(rename = "apiKey")]
    pub api_key: String,
    /// Protocol standard: "openai" | "anthropic" | "ollama"
    pub standard: String,
    pub provider: String,
    /// The actual model ID sent to the API (e.g. "gpt-4o-mini").
    pub model: String,
    /// Optional human-facing description (Java's ModelDo.description);
    /// falls back to the model id when absent.
    #[serde(default)]
    pub description: String,
    pub headers: HashMap<String, String>,
    pub timeout: String,
}

impl Default for ModelConfig {
    fn default() -> Self {
        Self {
            name: String::new(),
            enabled: true,
            visibled: true,
            scope: "user".into(),
            api_url: String::new(),
            api_key: String::new(),
            standard: "openai".into(),
            provider: String::new(),
            model: String::new(),
            description: String::new(),
            headers: HashMap::new(),
            timeout: "120s".into(),
        }
    }
}

impl ModelConfig {
    /// Effective display name: configured `name`, else the model id.
    /// Mirrors Java's `ModelDo.getNameOrModel()`.
    pub fn name_or_model(&self) -> String {
        if self.name.trim().is_empty() {
            self.model.clone()
        } else {
            self.name.clone()
        }
    }

    /// Effective protocol standard: `standard`, else `provider`.
    /// Mirrors Java's `ModelDo.getStandardOrProvider()`. Java only falls back
    /// when `standard` is null; a Rust `String` is never null, so an empty
    /// value is the equivalent "unset" signal.
    pub fn standard_or_provider(&self) -> String {
        if self.standard.trim().is_empty() {
            self.provider.clone()
        } else {
            self.standard.clone()
        }
    }

    /// Effective description: configured value, else the model id (same
    /// fallback as Java's `getDescriptionOrModel`).
    pub fn description_or_model(&self) -> String {
        if self.description.trim().is_empty() {
            self.model.clone()
        } else {
            self.description.clone()
        }
    }

    /// Parse timeout string like "500s" or "120" into seconds.
    pub fn timeout_secs(&self) -> u64 {
        let t = self.timeout.trim().trim_end_matches('s');
        t.parse::<u64>().unwrap_or(120)
    }

    /// Effective API endpoint for chat completions.
    pub fn completions_url(&self) -> String {
        let base = self.api_url.trim_end_matches('/');
        if base.ends_with("/chat/completions") {
            base.to_string()
        } else if base.ends_with("/v1") {
            format!("{}/chat/completions", base)
        } else {
            format!("{}/v1/chat/completions", base)
        }
    }
}

/// Custom deserializer: accepts both `{"models": {name: {...}}}` (map) and
/// `{"models": [{...}]}` (legacy array) formats.
fn deserialize_models<'de, D>(deserializer: D) -> Result<IndexMap<String, ModelConfig>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de;

    let raw = serde_json::Value::deserialize(deserializer)?;
    if raw.is_null() {
        return Ok(IndexMap::new());
    }

    // Legacy array format: normalize to a map keyed by name.
    if let Some(arr) = raw.as_array() {
        let mut map = IndexMap::new();
        for item in arr {
            match serde_json::from_value::<ModelConfig>(item.clone()) {
                Ok(m) => {
                    map.insert(m.name.clone(), m);
                }
                Err(e) => {
                    // Skip, never fail the whole list: one bad entry must not
                    // empty the user's model picker (see below).
                    tracing::warn!(error = %e, "skipping malformed model entry (array format)");
                }
            }
        }
        return Ok(map);
    }

    let Some(obj) = raw.as_object() else {
        return Err(de::Error::custom("models must be an object or array"));
    };

    // Parse **per entry**, not as one `HashMap<String, ModelConfig>`.
    //
    // A single malformed entry (a null where a string is expected, a numeric
    // timeout, a headers array, ...) used to fail the whole map, which made
    // `load_default()` return Err and the caller fall back to an *empty*
    // Settings. Any subsequent settings write then persisted that empty model
    // list over the user's real one. Skipping the bad entry keeps the other
    // N-1 models alive and keeps the load succeeding.
    let mut map = IndexMap::new();
    for (name, entry) in obj {
        match serde_json::from_value::<ModelConfig>(entry.clone()) {
            Ok(m) => {
                map.insert(name.clone(), m);
            }
            Err(e) => {
                // Retry once with nulls stripped: the Java kernel writes nulls
                // for unset optional fields, and serde treats null-for-String as
                // an error rather than "absent".
                let cleaned = strip_nulls(entry.clone());
                match serde_json::from_value::<ModelConfig>(cleaned) {
                    Ok(m) => {
                        map.insert(name.clone(), m);
                    }
                    Err(e2) => {
                        tracing::warn!(model = %name, error = %e2, "skipping malformed model entry; first attempt: {}", e);
                    }
                }
            }
        }
    }
    Ok(map)
}

/// Recursively remove JSON nulls so `#[serde(default)]` fields can fall back.
fn strip_nulls(v: serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.into_iter()
                .filter(|(_, val)| !val.is_null())
                .map(|(k, val)| (k, strip_nulls(val)))
                .collect(),
        ),
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.into_iter().map(strip_nulls).collect())
        }
        other => other,
    }
}

/// Strip a UTF-8 byte-order mark if present.
///
/// `serde_json` rejects a leading BOM with the useless "expected value at line 1
/// column 1", and the caller then falls back to **defaults** — silently losing
/// every model, every permission rule and `autoRethink`, which puts the kernel
/// straight back into the hard turn-limit failure. The user sees a working UI
/// with none of their configuration and no clue why.
///
/// BOMs are common on Windows: Notepad writes one, and so does PowerShell 5.1's
/// `Set-Content -Encoding UTF8`. The Java kernel strips BOMs in its own readers
/// (`SkillMdFrontmatter`, `MarkdownUtil`) for the same reason.
pub fn strip_bom(s: &str) -> &str {
    s.strip_prefix('\u{FEFF}').unwrap_or(s)
}

impl Settings {
    /// Load settings from the default location (~/.gwork/settings.json).
    /// Falls back to ~/.gourdai/settings.json for legacy installations.
    pub fn load_default() -> anyhow::Result<Self> {
        let base = harness_base();
        let candidates = [
            base.join(".gwork").join("settings.json"),
            base.join(".gourdai").join("settings.json"),
        ];
        for path in &candidates {
            if path.exists() {
                return Self::load_from(path);
            }
        }
        // No settings file: return defaults (empty model list)
        Ok(Self::default())
    }

    /// Load settings from a specific file path.
    pub fn load_from(path: &Path) -> anyhow::Result<Self> {
        let content = std::fs::read_to_string(path)
            .map_err(|e| anyhow::anyhow!("failed to read {}: {}", path.display(), e))?;
        let settings: Settings = serde_json::from_str(strip_bom(&content))
            .map_err(|e| anyhow::anyhow!("failed to parse {}: {}", path.display(), e))?;
        Ok(settings)
    }

    /// Get the default model config, or the first enabled model if defaultModel is missing.
    pub fn default_model_config(&self) -> Option<&ModelConfig> {
        if !self.default_model.is_empty() {
            if let Some(m) = self.models.get(&self.default_model) {
                if m.enabled {
                    return Some(m);
                }
            }
        }
        self.models.values().find(|m| m.enabled)
    }

    /// Get a model by name.
    pub fn get_model(&self, name: &str) -> Option<&ModelConfig> {
        self.models.get(name).filter(|m| m.enabled)
    }

    /// List all enabled models.
    pub fn enabled_models(&self) -> Vec<&ModelConfig> {
        self.models.values().filter(|m| m.enabled).collect()
    }

    /// Get the GWork home directory (`<harness_base>/.gwork`).
    ///
    /// Honours the `--home` / `GWORK_HOME` override — see [`harness_base`].
    pub fn gwork_home() -> PathBuf {
        harness_base().join(".gwork")
    }

    /// Get the sessions directory.
    pub fn sessions_dir() -> PathBuf {
        Self::gwork_home().join("sessions")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── harness_base resolution ────────────────────────────────────────────
    // These exercise the pure `resolve_base` helper so they never mutate the
    // process-global override lock or the real environment (tests run in
    // parallel threads within one process).

    fn no_env(_k: &str) -> Option<String> {
        None
    }

    fn env_with<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string())
    }

    #[test]
    fn base_override_wins_over_env_and_home() {
        let got = resolve_base(
            Some(Path::new("/opt/gw")),
            env_with(&[("GWORK_HOME", "/from/env")]),
            Some(PathBuf::from("/home/u")),
        );
        assert_eq!(got, PathBuf::from("/opt/gw"));
    }

    #[test]
    fn base_prefers_gwork_home_over_legacy_gourdai_home() {
        let got = resolve_base(
            None,
            env_with(&[("GWORK_HOME", "/new"), ("GOURDAI_HOME", "/legacy")]),
            Some(PathBuf::from("/home/u")),
        );
        assert_eq!(got, PathBuf::from("/new"));
    }

    #[test]
    fn base_falls_back_to_legacy_gourdai_home() {
        let got = resolve_base(
            None,
            env_with(&[("GOURDAI_HOME", "/legacy")]),
            Some(PathBuf::from("/home/u")),
        );
        assert_eq!(got, PathBuf::from("/legacy"));
    }

    #[test]
    fn base_falls_back_to_real_home_when_no_env() {
        let got = resolve_base(None, no_env, Some(PathBuf::from("/home/u")));
        assert_eq!(got, PathBuf::from("/home/u"));
    }

    #[test]
    fn base_skips_blank_and_whitespace_env_values() {
        // Java's trimmed() treats "" and "   " as absent; a blank GWORK_HOME
        // must not win over a populated GOURDAI_HOME.
        let got = resolve_base(
            None,
            env_with(&[("GWORK_HOME", "   "), ("GOURDAI_HOME", "/legacy")]),
            Some(PathBuf::from("/home/u")),
        );
        assert_eq!(got, PathBuf::from("/legacy"));

        let got2 = resolve_base(
            None,
            env_with(&[("GWORK_HOME", "")]),
            Some(PathBuf::from("/home/u")),
        );
        assert_eq!(got2, PathBuf::from("/home/u"));
    }

    #[test]
    fn base_trims_surrounding_whitespace_from_env_value() {
        let got = resolve_base(
            None,
            env_with(&[("GWORK_HOME", "  /padded/dir  ")]),
            Some(PathBuf::from("/home/u")),
        );
        assert_eq!(got, PathBuf::from("/padded/dir"));
    }

    #[test]
    fn base_strips_trailing_separator_so_join_is_clean() {
        for raw in ["/opt/gw/", "C:\\gw\\"] {
            let got = resolve_base(None, env_with(&[("GWORK_HOME", raw)]), None);
            let joined = got.join(".gwork");
            let s = joined.to_string_lossy().replace('\\', "/");
            assert!(!s.contains("//"), "double separator in {s}");
            assert!(s.ends_with("/.gwork"), "unexpected tail: {s}");
        }
    }

    #[test]
    fn base_degrades_to_dot_when_nothing_resolves() {
        let got = resolve_base(None, no_env, None);
        assert_eq!(got, PathBuf::from("."));
    }

    #[test]
    fn gwork_home_appends_dot_gwork_to_base() {
        // Guards the join shape used by every global-area path in the kernel.
        let base = resolve_base(None, env_with(&[("GWORK_HOME", "/opt/gw")]), None);
        assert_eq!(base.join(".gwork"), PathBuf::from("/opt/gw/.gwork"));
    }

    #[test]
    fn bom_prefixed_settings_still_load() {
        // PowerShell 5.1 `Set-Content -Encoding UTF8` and Notepad both write a
        // BOM. Without stripping it, serde_json fails with "expected value at
        // line 1 column 1", the loader falls back to defaults, and the user
        // silently loses every model plus `autoRethink` — landing straight back
        // in the hard turn-limit failure this kernel is being fixed for.
        // Same temp-dir convention as the rest of this crate's tests (no
        // `tempfile` dependency); the pid keeps parallel test runs apart.
        let dir = std::env::temp_dir().join(format!("gwork-cfg-bom-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join("settings.json");
        let body = r#"{"general":{"maxTurns":7,"autoRethink":false},"defaultModel":"m1",
            "models":{"m1":{"name":"m1","enabled":true,"apiUrl":"http://x/v1","apiKey":"k","model":"m1"}}}"#;
        std::fs::write(&path, format!("\u{FEFF}{}", body)).expect("write");

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.starts_with('\u{FEFF}'), "fixture must actually carry a BOM");
        assert!(
            serde_json::from_str::<Settings>(&raw).is_err(),
            "sanity: unstripped BOM must fail to parse, else this test proves nothing"
        );

        let s = Settings::load_from(&path).expect("BOM must be tolerated");
        assert_eq!(s.general.max_turns, 7, "real values must survive, not defaults");
        assert!(!s.general.auto_rethink);
        assert_eq!(s.default_model, "m1");
        assert!(s.models.contains_key("m1"), "models must not be lost");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn strip_bom_is_a_noop_without_bom() {
        assert_eq!(strip_bom("{\"a\":1}"), "{\"a\":1}");
        assert_eq!(strip_bom(""), "");
        // Only a *leading* BOM is a byte-order mark; one in the middle is data.
        assert_eq!(strip_bom("a\u{FEFF}b"), "a\u{FEFF}b");
        assert_eq!(strip_bom("\u{FEFF}{\"a\":1}"), "{\"a\":1}");
    }

    #[test]
    fn auto_rethink_defaults_to_true_like_java() {
        // Java `AgentProperties.autoRethink = true`. Defaulting to false would
        // make a settings.json that omits the key behave like the broken build.
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert!(s.general.auto_rethink);
        assert_eq!(s.general.max_turns, 20);
        assert_eq!(s.general.context_length, 256_000);
        assert_eq!(s.general.compression_ratio, 100);
        assert_eq!(s.general.compression_target_ratio, 45);
        assert_eq!(s.general.compression_reserved_output_tokens, 20_000);
        assert_eq!(s.general.compression_max_messages, 30);
    }

    #[test]
    fn auto_rethink_can_be_turned_off_explicitly() {
        let s: Settings = serde_json::from_str(r#"{"general":{"autoRethink":false}}"#).unwrap();
        assert!(!s.general.auto_rethink, "the hard-stop mode must remain reachable");
    }

    /// The web-tool keys are a shared-file contract with the Java kernel: a
    /// rename here makes a settings.json written by Java read as defaults here.
    #[test]
    fn web_tool_keys_use_java_wire_names_and_safe_defaults() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(s.general.mcp_retries, 3, "Java AgentProperties.mcpRetries = 3");
        assert_eq!(s.general.api_retries, 3, "Java AgentProperties.apiRetries = 3");
        assert_eq!(s.general.model_retries, 3, "Java AgentProperties.modelRetries = 3");
        assert_eq!(s.general.web_retry_budget_secs, 120, "Java WebfetchTalent.MAX_TIMEOUT_MS");
        assert!(s.general.web_proxy.is_empty(), "no proxy by default");

        let s: Settings = serde_json::from_str(
            r#"{"general":{"mcpRetries":5,"modelRetries":7,"webProxy":"http://127.0.0.1:7890","webRetryBudgetSecs":45}}"#,
        )
        .unwrap();
        assert_eq!(s.general.mcp_retries, 5);
        assert_eq!(s.general.model_retries, 7, "the settings page's model-retries box must survive a round trip");
        assert_eq!(s.general.web_proxy, "http://127.0.0.1:7890");
        assert_eq!(s.general.web_retry_budget_secs, 45);

        let back = serde_json::to_string(&s.general).unwrap();
        for key in ["mcpRetries", "webProxy", "webRetryBudgetSecs", "apiRetries", "modelRetries"] {
            assert!(back.contains(key), "{key} must round-trip");
        }
    }

    #[test]
    fn compression_keys_use_java_wire_names() {
        // The keys are a shared-file contract with the Java kernel: a rename here
        // silently reads defaults instead of the user's values.
        let s: Settings = serde_json::from_str(
            r#"{"general":{"contextLength":512000,"compressionRatio":80,
                "compressionTargetRatio":60,"compressionReservedOutputTokens":8000,
                "compressionMaxMessages":12}}"#,
        )
        .unwrap();
        assert_eq!(s.general.context_length, 512_000);
        assert_eq!(s.general.compression_ratio, 80);
        assert_eq!(s.general.compression_target_ratio, 60);
        assert_eq!(s.general.compression_reserved_output_tokens, 8_000);
        assert_eq!(s.general.compression_max_messages, 12);
        // And they must serialize back under the same names.
        let back = serde_json::to_string(&s.general).unwrap();
        for key in [
            "autoRethink", "contextLength", "compressionRatio", "compressionTargetRatio",
            "compressionReservedOutputTokens", "compressionMaxMessages",
        ] {
            assert!(back.contains(key), "{key} must round-trip");
        }
    }

    #[test]
    fn test_parse_settings_json() {
        let json = r#"{
            "general": { "maxTurns": 20, "locale": "en" },
            "permission": { "tools": ["**"], "disallowedTools": [] },
            "defaultModel": "test-model",
            "models": {
                "test-model": {
                    "name": "test-model",
                    "enabled": true,
                    "apiUrl": "https://api.example.com",
                    "apiKey": "sk-test",
                    "standard": "openai",
                    "model": "gpt-4o-mini"
                }
            }
        }"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(s.default_model, "test-model");
        assert_eq!(s.models.len(), 1);
        let m = s.models.get("test-model").unwrap();
        assert_eq!(m.completions_url(), "https://api.example.com/v1/chat/completions");
    }

    #[test]
    fn test_legacy_array_models() {
        let json = r#"{
            "models": [
                { "name": "m1", "enabled": true, "apiUrl": "http://x", "model": "gpt-4" }
            ]
        }"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(s.models.len(), 1);
        assert!(s.models.contains_key("m1"));
    }

    #[test]
    fn test_timeout_parse() {
        let m = ModelConfig { timeout: "500s".into(), ..Default::default() };
        assert_eq!(m.timeout_secs(), 500);
        let m2 = ModelConfig { timeout: "120".into(), ..Default::default() };
        assert_eq!(m2.timeout_secs(), 120);
    }

    /// Regression guard for the 2026-10-26 data-loss incident.
    ///
    /// One malformed entry (here: `apiKey: null`, which the Java kernel writes
    /// for unset optionals) used to fail the whole `models` map, making
    /// `load_default()` return Err; the caller's `unwrap_or_default()` then ran
    /// with an empty model list, and the next settings write persisted that empty
    /// list over the user's real configuration. The contract now is: the bad
    /// entry is skipped, everything else survives, and the load succeeds.
    #[test]
    fn one_bad_model_entry_does_not_empty_the_map() {
        let json = r#"{
            "defaultModel": "good",
            "models": {
                "good": {
                    "name": "good",
                    "enabled": true,
                    "apiUrl": "https://api.example.com",
                    "apiKey": "sk-test",
                    "standard": "openai",
                    "model": "gpt-4o-mini"
                },
                "bad": {
                    "name": "bad",
                    "enabled": true,
                    "apiUrl": "https://api.example.com",
                    "apiKey": null,
                    "standard": "openai",
                    "model": "gpt-4o-mini",
                    "headers": null,
                    "timeout": null
                }
            }
        }"#;
        let s: Settings = serde_json::from_str(json).expect("load must succeed despite one bad entry");
        assert!(s.models.contains_key("good"), "the healthy model must survive");
        assert_eq!(s.models.len(), 2, "nulls are stripped, so 'bad' also parses");
    }

    /// A genuinely unparseable entry (wrong type, not just null) is skipped
    /// rather than poisoning the whole map.
    #[test]
    fn wrong_typed_model_entry_is_skipped_not_fatal() {
        let json = r#"{
            "models": {
                "good": {
                    "name": "good",
                    "enabled": true,
                    "apiUrl": "https://api.example.com",
                    "apiKey": "sk-test",
                    "standard": "openai",
                    "model": "gpt-4o-mini"
                },
                "broken": {
                    "name": "broken",
                    "enabled": "not-a-bool",
                    "apiUrl": 42,
                    "standard": "openai",
                    "model": "x"
                }
            }
        }"#;
        let s: Settings = serde_json::from_str(json).expect("load must succeed");
        assert!(s.models.contains_key("good"));
        assert!(!s.models.contains_key("broken"), "the broken entry is skipped");
        assert_eq!(s.models.len(), 1);
    }

    // ─── Insertion-order preservation ────────────────────────────────────────
    //
    // `serde_json`'s `Map` is a BTreeMap unless the `preserve_order` feature is
    // on, in which case it is an IndexMap. Without it, every settings.json write
    // re-sorts the model table alphabetically. That is not cosmetic: the frontend
    // groups the model picker by "provider changed vs previous entry"
    // (model-selector.js), so a re-sort turns 3 contiguous providers into ~96
    // alternating group headers. The file is shared with the Java kernel, whose
    // LinkedHashMap preserves config order.
    //
    // Nothing else in the test suite would notice the feature being dropped, so
    // these two lock it explicitly.

    /// Keys deliberately out of alphabetical order, with providers grouped the
    /// way a real config looks (all of one provider, then all of the next).
    const ORDERED_MODELS_JSON: &str = r#"{
        "defaultModel": "Zeta-z",
        "models": {
            "Zeta-z":  { "name": "Zeta-z",  "provider": "Zeta",  "model": "z",  "enabled": true },
            "Zeta-a":  { "name": "Zeta-a",  "provider": "Zeta",  "model": "a",  "enabled": true },
            "Alpha-m": { "name": "Alpha-m", "provider": "Alpha", "model": "m",  "enabled": true },
            "Alpha-b": { "name": "Alpha-b", "provider": "Alpha", "model": "b",  "enabled": true }
        }
    }"#;

    #[test]
    fn models_keep_config_order_not_alphabetical() {
        let s: Settings = serde_json::from_str(ORDERED_MODELS_JSON).unwrap();
        let keys: Vec<&String> = s.models.keys().collect();
        assert_eq!(
            keys,
            vec!["Zeta-z", "Zeta-a", "Alpha-m", "Alpha-b"],
            "IndexMap must preserve insertion order; alphabetical would be Alpha-b, Alpha-m, Zeta-a, Zeta-z"
        );
        // The provider blocks must stay contiguous, which is what the picker's
        // grouping depends on.
        let providers: Vec<&str> = s.models.values().map(|m| m.provider.as_str()).collect();
        assert_eq!(providers, vec!["Zeta", "Zeta", "Alpha", "Alpha"]);
    }

    #[test]
    fn serialized_settings_keep_model_order_on_the_wire() {
        // This is the half that actually breaks without `preserve_order`: the
        // in-memory IndexMap is ordered either way, but serde_json's Map is what
        // gets written to disk, and a BTreeMap there re-sorts on every save.
        let s: Settings = serde_json::from_str(ORDERED_MODELS_JSON).unwrap();
        let json = serde_json::to_string(&s).unwrap();

        let positions: Vec<usize> = ["Zeta-z", "Zeta-a", "Alpha-m", "Alpha-b"]
            .iter()
            .map(|k| {
                json.find(&format!("\"{}\"", k))
                    .unwrap_or_else(|| panic!("{} missing from output", k))
            })
            .collect();
        assert!(
            positions.windows(2).all(|w| w[0] < w[1]),
            "model keys must appear in config order in the serialized JSON, got offsets {:?}\n{}",
            positions,
            json
        );
    }

    // Round-tripping is deliberately **not** tested here.
    //
    // It was, and mutation testing showed it had no teeth: with `preserve_order`
    // removed, both sides of the comparison come out alphabetically sorted, so
    // `first == second` still holds and the test stays green while the real
    // defect (config order destroyed on every save) goes undetected. A test that
    // cannot fail when the thing it guards is broken is worse than no test — it
    // reads as coverage. The two assertions above compare against the *literal
    // expected order* instead, which is what makes them fail.
}
