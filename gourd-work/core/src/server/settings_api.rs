//! Settings extras: ACP info/save, skills, MCP servers, providers, overlay.
//!
//! These endpoints persist into `<home>/settings.json` under dedicated keys,
//! preserving unknown keys on write (read-modify-write).

use std::sync::Arc;

use axum::extract::{Multipart, Query, State};
use axum::{Form, Json};

use super::AppState;
use crate::config::Settings;
use crate::mcp::{self, McpServerConfig};

fn settings_path() -> std::path::PathBuf {
    Settings::gwork_home().join("settings.json")
}

/// What a read of settings.json yielded, for the read-modify-write cycle.
///
/// Every writer in this file preserves the keys it does not own, so it must be
/// able to tell "there is nothing on disk yet" apart from "there are bytes on
/// disk that did not parse". Collapsing the two into an empty object (what the
/// code here used to do) turns one unparseable byte into total config loss: the
/// write then persists only the key being patched and drops `models`,
/// `providers`, `mcpServers` and every other section.
pub(crate) enum SettingsRead {
    /// Safe to modify and write back. Empty for a missing or blank file.
    Usable(serde_json::Map<String, serde_json::Value>),
    /// There are bytes on disk this code cannot interpret. Writing would
    /// destroy whatever they hold, so writers must refuse.
    Unreadable,
}

/// The message shown to the user (or returned to the model) when a settings
/// write is refused because the on-disk file cannot be interpreted.
pub(crate) fn settings_unreadable_message() -> String {
    "settings.json 无法解析，已拒绝写入以避免覆盖现有配置。请先修复或备份该文件。".to_string()
}

/// Read settings.json for a read-modify-write cycle.
///
/// A leading BOM is stripped before parsing: `serde_json` rejects it with
/// "expected value at line 1 column 1", and BOMs are common on Windows (Notepad
/// and PowerShell 5.1's `Set-Content -Encoding UTF8` both write one). The same
/// strip already guards `Settings::load_from` and `persist_settings` — see
/// `crate::config::strip_bom`. Without it here, a BOM made every read in this
/// file fail, and the old empty-object fallback then wiped the file on save.
///
/// `pub(crate)`: this is the single sanctioned way to read settings.json for a
/// read-modify-write cycle anywhere in the kernel. Two out-of-file call sites
/// proved why — `AddModelTool` and `persist_settings` each carried their own
/// `unwrap_or_else(json!({}))` fallback, so a file that failed to parse here
/// (BOM, truncation, corruption) turned into an empty object and the subsequent
/// write erased every section the caller did not own.
pub(crate) fn read_settings_for_update(path: &std::path::Path) -> SettingsRead {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        // No file yet is the fresh-install case: start from an empty object.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return SettingsRead::Usable(serde_json::Map::new())
        }
        // Any other IO error (permissions, a directory in the way, a locked
        // file) means the current contents are unknown — refuse rather than
        // assume they are empty, because read and write permissions can differ.
        Err(_) => return SettingsRead::Unreadable,
    };
    let trimmed = crate::config::strip_bom(&content).trim_start();
    if trimmed.is_empty() {
        return SettingsRead::Usable(serde_json::Map::new());
    }
    match serde_json::from_str::<serde_json::Value>(trimmed) {
        // Only a top-level object can be merged into. An array/string/number at
        // the root is not something this code wrote, so treat it as opaque data
        // rather than overwriting it.
        Ok(serde_json::Value::Object(map)) => SettingsRead::Usable(map),
        Ok(_) | Err(_) => SettingsRead::Unreadable,
    }
}

/// Read-modify-write a top-level key in settings.json at `path`.
///
/// Returns `false` without touching the file when the existing contents cannot
/// be parsed. That guard mirrors the one in `persist_settings`
/// (`server/mod.rs`), which exists because a single `general/save` once wiped a
/// 24-model setup: the in-memory state was empty *because the load had failed*,
/// not because the user had nothing.
fn patch_settings_at(path: &std::path::Path, key: &str, value: serde_json::Value) -> bool {
    let SettingsRead::Usable(mut obj) = read_settings_for_update(path) else {
        tracing::error!(
            key = key,
            path = %path.display(),
            "settings.json did not parse; refusing to write (would erase the sections this call does not own)"
        );
        return false;
    };
    obj.insert(key.to_string(), value);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let body = match serde_json::to_string_pretty(&serde_json::Value::Object(obj)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    if let Err(e) = std::fs::write(path, body) {
        tracing::error!(key = key, error = %e, "failed to write settings.json");
        return false;
    }
    true
}

/// Read-modify-write a top-level key in the real settings.json.
///
/// `false` means nothing was written — callers must report that rather than
/// answering 200, or the UI shows a saved setting that does not exist on disk.
#[must_use = "a failed settings write must be reported, not silently dropped"]
fn patch_settings(key: &str, value: serde_json::Value) -> bool {
    patch_settings_at(&settings_path(), key, value)
}

fn read_settings_key(key: &str) -> serde_json::Value {
    read_settings_key_at(&settings_path(), key)
}

fn read_settings_key_at(path: &std::path::Path, key: &str) -> serde_json::Value {
    match read_settings_for_update(path) {
        SettingsRead::Usable(obj) => obj.get(key).cloned().unwrap_or(serde_json::Value::Null),
        SettingsRead::Unreadable => serde_json::Value::Null,
    }
}

/// Uniform answer for "the write was refused because settings.json is broken".
///
/// A 200 here would be a false success: the UI would show the new value while
/// disk still holds the old one, and the user would only find out after a
/// restart silently reverted it.
fn settings_write_failed() -> serde_json::Value {
    // `message` mirrors `msg` because the settings pages read `resp.message`
    // (app-settings-mcp.js, app-settings-openapi.js) while other pages read
    // `res.msg` — one key each side missed the other half. Mirroring both (like
    // `mcp_saved` does for connectError) keeps every toast informative.
    let msg = "settings.json 无法解析，已拒绝写入以避免覆盖现有配置。请修复或备份后重试。";
    serde_json::json!({
        "code": 500,
        "msg": msg,
        "message": msg,
    })
}

// ─── ACP ──────────────────────────────────────────────────────────────────────

/// GET /web/settings/acp/info — environment info for editor integration.
///
/// Wire shape mirrors the Java kernel's `WebSettingsController.codingInfo()`
/// field-for-field, because the frontend (`app-settings-acp.js`) reads
/// `info.ready` / `info.command` / `info.args` / `info.models[].thinkingLevels`
/// directly. Two historical Rust bugs are fixed here:
///   * it returned `launcherReady` while the frontend reads `ready` → the
///     readiness banner always showed "not ready";
///   * on Windows it returned the `.bat` path as `command`, but editor ACP
///     clients (Node spawn / Rust subprocess) cannot exec a `.bat` directly —
///     Java wraps it as `cmd /c <bat> acp`.
pub async fn acp_info(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let is_windows = cfg!(windows);
    let os = if is_windows {
        "windows"
    } else if cfg!(target_os = "macos") {
        "mac"
    } else {
        "linux"
    };

    // userHome = the real OS home (Java's AgentFlags.getUserHome()), NOT the
    // harness base: editors show it to the user and prefill config paths.
    let user_home = dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    // Launcher lives in the (possibly overridden) harness base: <base>/.gwork/bin.
    let gwork_home = crate::config::Settings::gwork_home();
    let launcher_name = if is_windows { "gwork.bat" } else { "gwork" };
    let mut launcher = gwork_home.join("bin").join(launcher_name);
    if !launcher.exists() {
        // Transitional fallback: an un-upgraded desktop shell may still have
        // written the legacy .gourdai/bin/gourdai launcher.
        let legacy_name = if is_windows { "gourdai.bat" } else { "gourdai" };
        let legacy = gwork_home
            .parent()
            .map(|b| b.join(".gourdai").join("bin").join(legacy_name))
            .unwrap_or_else(|| gwork_home.join(".gourdai").join("bin").join(legacy_name));
        if legacy.exists() {
            launcher = legacy;
        }
    }
    let ready = launcher.exists();
    let launcher_str = launcher.to_string_lossy().to_string();

    // Windows: wrap in `cmd /c` so editor subprocesses can launch the .bat.
    let (command, args) = if is_windows {
        (
            serde_json::Value::String("cmd".into()),
            serde_json::json!(["/c", launcher_str, "acp"]),
        )
    } else {
        (
            serde_json::Value::String(launcher_str.clone()),
            serde_json::json!(["acp"]),
        )
    };

    let settings = state.settings.read().await;
    let general = read_settings_key("general");

    // models: object rows (not bare strings) so the shared GourdModelSelector
    // can group by provider and render per-model thinking-level chips.
    let models: Vec<serde_json::Value> = settings
        .models
        .values()
        .filter(|m| m.enabled && m.visibled)
        .map(|m| {
            serde_json::json!({
                "name": m.name_or_model(),
                "provider": m.provider,
                "standard": m.standard_or_provider(),
                "thinkingLevels": crate::reasoning::selectable_codes(
                    &m.standard_or_provider(),
                    &m.model,
                ),
            })
        })
        .collect();

    // defaultModel: the *effective* model name (Java's resolveEffectiveModelName),
    // i.e. defaultModel if it still points at a live model, else the first
    // enabled one — so the picker always has a concrete item to highlight.
    let effective_default = settings
        .default_model_config()
        .map(|m| m.name_or_model())
        .unwrap_or_default();

    Json(serde_json::json!({
        "code": 200,
        "data": {
            "os": os,
            "userHome": user_home,
            "command": command,
            "args": args,
            "ready": ready,
            "defaultModel": effective_default,
            "acpModel": general.get("acpModel").cloned().unwrap_or(serde_json::Value::Null),
            "acpThinkingDepth": general.get("acpThinkingDepth").cloned().unwrap_or(serde_json::Value::Null),
            "acpContextLength": general.get("acpContextLength").cloned().unwrap_or(serde_json::Value::Null),
            "models": models,
        }
    }))
}

#[derive(serde::Deserialize, Default)]
pub struct AcpModelForm {
    #[serde(rename = "acpModel", default)]
    pub acp_model: String,
}

/// POST /web/settings/acp/model/save
pub async fn acp_model_save(Form(form): Form<AcpModelForm>) -> Json<serde_json::Value> {
    let mut general = read_settings_key("general");
    if !general.is_object() {
        general = serde_json::json!({});
    }
    general["acpModel"] = serde_json::json!(form.acp_model);
    if !patch_settings("general", general) {
        return Json(settings_write_failed());
    }
    Json(serde_json::json!({"code": 200}))
}

#[derive(serde::Deserialize, Default)]
pub struct AcpThinkingForm {
    #[serde(rename = "acpThinkingDepth", default)]
    pub acp_thinking_depth: String,
}

/// POST /web/settings/acp/thinking/save
pub async fn acp_thinking_save(Form(form): Form<AcpThinkingForm>) -> Json<serde_json::Value> {
    let mut general = read_settings_key("general");
    if !general.is_object() {
        general = serde_json::json!({});
    }
    general["acpThinkingDepth"] = serde_json::json!(form.acp_thinking_depth);
    if !patch_settings("general", general) {
        return Json(settings_write_failed());
    }
    Json(serde_json::json!({"code": 200}))
}

#[derive(serde::Deserialize, Default)]
pub struct AcpContextForm {
    #[serde(rename = "acpContextLength", default)]
    pub acp_context_length: String,
}

/// POST /web/settings/acp/context/save
pub async fn acp_context_save(Form(form): Form<AcpContextForm>) -> Json<serde_json::Value> {
    let mut general = read_settings_key("general");
    if !general.is_object() {
        general = serde_json::json!({});
    }
    general["acpContextLength"] = serde_json::json!(form.acp_context_length);
    if !patch_settings("general", general) {
        return Json(settings_write_failed());
    }
    Json(serde_json::json!({"code": 200}))
}

// ─── Skills ───────────────────────────────────────────────────────────────────

/// GET /web/settings/skills/installed
///
/// Returns the field set the frontend's `renderInstalledList` reads:
/// `name` (the real directory name, used as the delete/toggle key),
/// `displayName` (what the card title shows), plus `description`, `enabled`,
/// `scope`, `version`, `market`, `iconUrl`. An earlier version returned only
/// four fields and — because `parse_skill_header` scanned front matter as body
/// text — set `description` to the literal `name: <slug>` line, so every card
/// showed that string. `displayName` is resolved from market metadata only
/// (see `crate::skills`); the package's own SKILL.md is never trusted for it.
pub async fn skills_installed(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    // Scan both scopes so project-local skills show up (the endpoint previously
    // saw only the global directory).
    let registry = crate::skills::SkillRegistry::with_workspace(&state.workspace);
    // Directory scan + front-matter parse of every skill: keep it off the async
    // worker, same reasoning as `chat_usage_stats`.
    let items = tokio::task::spawn_blocking(move || {
        registry
            .load_all()
            .iter()
            .map(|s| {
                let display_name = crate::skills::display_name_of(s.market.as_ref());
                let mut item = serde_json::json!({
                    "name": s.name,
                    "title": s.title,
                    // Java caps the description at its first line / 120 chars.
                    "description": clamp_description(&s.description),
                    "enabled": s.enabled,
                    "scope": s.scope.code(),
                    "version": s.version,
                });
                if let Some(m) = &s.market {
                    if !m.market.is_empty() {
                        item["market"] = serde_json::json!(m.market);
                    }
                    if !m.slug.is_empty() {
                        item["marketSlug"] = serde_json::json!(m.slug);
                    }
                    if !m.icon_url.is_empty() {
                        item["iconUrl"] = serde_json::json!(m.icon_url);
                    }
                }
                if let Some(dn) = display_name {
                    item["displayName"] = serde_json::json!(dn);
                }
                item
            })
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();
    Json(serde_json::json!({"code": 200, "data": items}))
}

/// First line, capped at 120 chars + ellipsis (Java `skillsInstalled`).
fn clamp_description(desc: &str) -> String {
    let first = desc.lines().next().unwrap_or("").trim();
    let chars: Vec<char> = first.chars().collect();
    if chars.len() > 120 {
        let head: String = chars[..120].iter().collect();
        format!("{}...", head)
    } else {
        first.to_string()
    }
}

// NOTE: `/web/settings/skills/markets` is served by
// `skills_market_api::skills_markets`, which delegates to `MarketManager::infos`.
// A hardcoded single-market stub used to live here and was wired into the
// router by mistake, which silently deleted the clawhub and modelscope tabs
// from the UI even though both adapters were registered and working. Do not
// re-add a stub: the tab list must be exactly the set of registered adapters.

#[derive(serde::Deserialize, Default)]
pub struct SkillNameForm {
    #[serde(rename = "skillName", default)]
    pub skill_name: String,
    #[serde(default)]
    pub name: String,
    /// `global` (default) or `workspace`; selects which skills dir to act on.
    #[serde(default)]
    pub scope: String,
    /// Submitted as the string "true"/"false" by the toggle switch.
    #[serde(default)]
    pub enabled: String,
}

impl SkillNameForm {
    fn skill_name(&self) -> String {
        if !self.skill_name.is_empty() { self.skill_name.clone() } else { self.name.clone() }
    }
    /// Validate the name and resolve the skill directory for the requested scope.
    /// Returns `Err(response)` for the caller to forward verbatim.
    fn resolve_dir(
        &self,
        workspace: &std::path::Path,
    ) -> Result<std::path::PathBuf, Json<serde_json::Value>> {
        let name = self.skill_name();
        if name.is_empty() || name.contains("..") || name.contains('/') || name.contains('\\') {
            return Err(Json(serde_json::json!({"code": 400, "description": "Invalid skill name"})));
        }
        let root = if self.scope == "workspace" {
            workspace.join(".gwork").join("skills")
        } else {
            Settings::gwork_home().join("skills")
        };
        Ok(root.join(name))
    }
}

/// POST /web/settings/skills/uninstall
pub async fn skills_uninstall(
    State(state): State<Arc<AppState>>,
    Form(form): Form<SkillNameForm>,
) -> Json<serde_json::Value> {
    let dir = match form.resolve_dir(&state.workspace) {
        Ok(d) => d,
        Err(r) => return r,
    };
    if dir.is_dir() {
        let _ = std::fs::remove_dir_all(&dir);
        // The parsed-skill cache would otherwise keep serving the removed skill
        // until its fingerprint happened to change.
        crate::skills::invalidate_cache();
        Json(serde_json::json!({"code": 200}))
    } else {
        Json(serde_json::json!({"code": 404, "description": "Skill not found"}))
    }
}

/// POST /web/settings/skills/toggle — flip a skill's `enabled` front-matter flag.
///
/// This used to be a stub that always answered `{enabled:true}` without touching
/// disk, so the switch appeared to work while the next scan still saw the old
/// state (and the agent kept loading "disabled" skills into its prompt). It now
/// writes the flag through `skills::set_enabled`, preserving the file's other
/// front matter, body, line endings and BOM.
pub async fn skills_toggle(
    State(state): State<Arc<AppState>>,
    Form(form): Form<SkillNameForm>,
) -> Json<serde_json::Value> {
    let dir = match form.resolve_dir(&state.workspace) {
        Ok(d) => d,
        Err(r) => return r,
    };
    // The switch always submits an explicit value. An empty one is a caller bug:
    // guessing "flip the current state" would require re-scanning to learn that
    // state and could invert it twice under a double click, so reject instead.
    let enabled = match form.enabled.trim().to_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => true,
        "false" | "0" | "no" | "off" => false,
        other => {
            return Json(serde_json::json!({
                "code": 400,
                "description": format!("invalid enabled value: {:?}", other)
            }))
        }
    };
    match crate::skills::set_enabled(&dir, enabled) {
        Ok(true) => Json(serde_json::json!({"code": 200, "data": {"enabled": enabled}})),
        Ok(false) => Json(serde_json::json!({"code": 404, "description": "Skill not found"})),
        Err(e) => Json(serde_json::json!({"code": 500, "description": format!("toggle failed: {}", e)})),
    }
}

// ─── MCP servers ──────────────────────────────────────────────────────────────

// The whole MCP family takes a **JSON body** and stores entries in the Java
// kernel's own shape, because both kernels share one `~/.gwork/settings.json`:
//
//   { "<name>": { "type": "stdio", "scope": "user", "enabled": true,
//                 "command": "npx", "args": [...], "env": {...},
//                 "disallowedTools": [...] } }
//
// The kind key is `type` (what the UI writes and what Java's McpServerDo
// serializes), never `transport`; see `crate::mcp` for the legacy fallback.

/// Scope values, mirroring `AgentFlags.SCOPE_USER` / `SCOPE_LOCAL`.
const SCOPE_USER: &str = "user";
const SCOPE_WORKSPACE: &str = "workspace";

/// Normalize a submitted scope. Anything other than `workspace` collapses to
/// `user`, matching Java's `if (!SCOPE_LOCAL.equals(scope)) scope = SCOPE_USER`.
fn norm_scope(raw: Option<&str>) -> &'static str {
    match raw.map(|s| s.trim()) {
        Some(SCOPE_WORKSPACE) => SCOPE_WORKSPACE,
        _ => SCOPE_USER,
    }
}

/// Request body shared by add / update / remove / toggle / check / tools-save.
#[derive(serde::Deserialize, Default)]
#[serde(default)]
pub struct McpBody {
    pub name: String,
    /// Previous name, used by `update` when the user renamed the server.
    #[serde(rename = "originalName")]
    pub original_name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub enabled: Option<bool>,
    pub scope: Option<String>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<std::collections::HashMap<String, String>>,
    pub url: Option<String>,
    pub headers: Option<std::collections::HashMap<String, String>>,
    pub timeout: Option<String>,
    /// Tools panel payload (`servers/tools/save`).
    #[serde(rename = "serverName")]
    pub server_name: String,
    #[serde(rename = "disallowedTools")]
    pub disallowed_tools: Option<Vec<String>>,
}

/// GET /web/settings/mcp/servers
///
/// Returns an **array** of entries, not the raw settings object: the UI renders
/// with `list.length` / `list.forEach` and reads `item.name`, so handing it the
/// `{name: {...}}` map made the panel permanently show "no servers".
pub async fn mcp_servers() -> Json<serde_json::Value> {
    let servers = read_settings_key("mcpServers");
    let mut list: Vec<serde_json::Value> = Vec::new();
    if let Some(obj) = servers.as_object() {
        for (name, entry) in obj {
            let cfg: McpServerConfig = serde_json::from_value(entry.clone()).unwrap_or_default();
            let kind = cfg.resolved_type();
            let mut item = serde_json::json!({
                "name": name,
                "type": kind,
                "enabled": cfg.enabled,
                "scope": if cfg.scope == SCOPE_WORKSPACE { SCOPE_WORKSPACE } else { SCOPE_USER },
            });
            // Only emit the fields relevant to the kind, so the form fills the
            // right panel and stale values from a kind switch don't linger.
            if mcp::is_stdio(&kind) {
                item["command"] = serde_json::json!(cfg.command);
                item["args"] = serde_json::json!(cfg.args);
                item["env"] = serde_json::json!(cfg.env);
            } else {
                item["url"] = serde_json::json!(cfg.url);
                item["headers"] = serde_json::json!(cfg.headers);
                if !cfg.timeout.is_empty() {
                    item["timeout"] = serde_json::json!(cfg.timeout);
                }
            }
            list.push(item);
        }
    }
    list.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
    Json(serde_json::json!({"code": 200, "data": list}))
}

/// Build the settings.json entry for a server, validating the kind first.
///
/// `existing` supplies fall-back values for `update` (a partial submission keeps
/// whatever the user didn't touch); pass `None` for `add`.
fn build_entry(
    body: &McpBody,
    existing: Option<&serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let raw_kind = if !body.kind.trim().is_empty() {
        body.kind.clone()
    } else {
        // update without an explicit type: keep the stored one (Java reads
        // existing.getTypeOrTransport() in exactly this case).
        existing
            .and_then(|e| e.get("type").or_else(|| e.get("transport")))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let kind = mcp::standardize(&raw_kind).ok_or_else(|| "name and type are required".to_string())?;
    if !mcp::is_valid(&kind) {
        return Err(format!("Unsupported type: {}", raw_kind));
    }

    let scope = norm_scope(
        body.scope
            .as_deref()
            .or_else(|| existing.and_then(|e| e.get("scope")).and_then(|v| v.as_str())),
    );

    // Submitted value wins; otherwise keep the stored one (update semantics).
    let prev_str = |key: &str, submitted: &Option<String>| -> String {
        match submitted {
            Some(v) => v.clone(),
            None => existing
                .and_then(|e| e.get(key))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        }
    };

    let mut entry = serde_json::json!({
        "type": kind,
        "scope": scope,
        "enabled": body.enabled.unwrap_or(true),
    });

    if mcp::is_stdio(&kind) {
        let command = prev_str("command", &body.command);
        if command.trim().is_empty() && existing.is_none() {
            return Err("命令不能为空".into());
        }
        entry["command"] = serde_json::json!(command);
        entry["args"] = match &body.args {
            Some(a) => serde_json::json!(a),
            None => existing
                .and_then(|e| e.get("args").cloned())
                .unwrap_or_else(|| serde_json::json!([])),
        };
        entry["env"] = match &body.env {
            Some(m) => serde_json::json!(m),
            None => existing
                .and_then(|e| e.get("env").cloned())
                .unwrap_or_else(|| serde_json::json!({})),
        };
    } else if mcp::is_http_type(&kind) {
        let url = prev_str("url", &body.url);
        if url.trim().is_empty() && existing.is_none() {
            return Err("URL 不能为空".into());
        }
        entry["url"] = serde_json::json!(url);
        entry["headers"] = match &body.headers {
            Some(m) => serde_json::json!(m),
            None => existing
                .and_then(|e| e.get("headers").cloned())
                .unwrap_or_else(|| serde_json::json!({})),
        };
        let timeout = prev_str("timeout", &body.timeout);
        if !timeout.is_empty() {
            entry["timeout"] = serde_json::json!(timeout);
        }
    } else {
        return Err(format!("不支持检测的类型: {}", kind));
    }

    // Preserve the tool denylist across an edit: the tools panel writes it, and
    // dropping it here would silently re-enable every tool on each config save.
    if let Some(dt) = existing.and_then(|e| e.get("disallowedTools").cloned()) {
        entry["disallowedTools"] = dt;
    }
    if let Some(dt) = &body.disallowed_tools {
        entry["disallowedTools"] = serde_json::json!(dt);
    }

    Ok(entry)
}

/// Parse one settings entry into a `McpServerConfig` for engine operations.
fn entry_to_config(entry: &serde_json::Value) -> McpServerConfig {
    serde_json::from_value(entry.clone()).unwrap_or_default()
}

/// Apply a config change to the live engine (hot-plug, no restart needed).
/// `entry == None` means "take this server offline".
/// Apply a settings mutation to the live MCP registry.
///
/// `Some(entry)` connects (or reconnects); `None` tears the server down. Returns
/// the humanized connect error, or `None` when the operation succeeded. Callers
/// must surface that error rather than answering a bare success: the old code
/// only logged it, so saving a server that could never connect reported 200 and
/// the UI said "operation success" while no tool became available. The
/// configuration *is* saved in that case, so the response stays 200 — but it now
/// also carries `connected: false` plus the reason.
async fn sync_engine(state: &Arc<AppState>, name: &str, entry: Option<&serde_json::Value>) -> Option<String> {
    match entry {
        Some(e) => {
            let cfg = entry_to_config(e);
            let kind = cfg.resolved_type();
            match state.mcp.connect_one(name, &cfg).await {
                Ok(_) => None,
                Err(err) => {
                    tracing::warn!(server = %name, error = %err, "MCP hot-plug failed");
                    Some(humanize_connect_error(&err.to_string(), &kind))
                }
            }
        }
        None => {
            state.mcp.disconnect_one(name).await;
            None
        }
    }
}

/// Build the success response for an MCP save, carrying the connect outcome.
///
/// `saved: true` is always set on this path — reaching it means the entry is on
/// disk. `connected` distinguishes "saved and live" from "saved but unreachable",
/// which the UI renders as a different toast.
fn mcp_saved(connect_error: Option<String>) -> serde_json::Value {
    match connect_error {
        None => serde_json::json!({"code": 200, "saved": true, "connected": true}),
        Some(reason) => serde_json::json!({
            "code": 200,
            "saved": true,
            "connected": false,
            "connectError": reason,
            // Also mirrored into message/description: the UI's failure branch
            // reads `resp.message`, and any future caller that only checks the
            // code will still find the reason in the payload.
            "message": reason,
            "description": reason,
        }),
    }
}

/// POST /web/settings/mcp/servers/add
pub async fn mcp_server_add(
    State(state): State<Arc<AppState>>,
    Json(body): Json<McpBody>,
) -> Json<serde_json::Value> {
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "name is required"}));
    }

    let mut servers = read_settings_key("mcpServers");
    if !servers.is_object() {
        servers = serde_json::json!({});
    }
    if servers.get(&name).is_some() {
        return Json(serde_json::json!({"code": 400, "description": format!("Server name already exists: {}", name)}));
    }

    let entry = match build_entry(&body, None) {
        Ok(e) => e,
        Err(msg) => return Json(serde_json::json!({"code": 400, "description": msg})),
    };

    let enabled = entry["enabled"].as_bool().unwrap_or(true);
    servers[&name] = entry.clone();
    // Connect only after the entry is safely on disk: starting the child process
    // on a refused write would leave a live server that vanishes on restart.
    if !patch_settings("mcpServers", servers) {
        return Json(settings_write_failed());
    }
    let connect_error = if enabled {
        sync_engine(&state, &name, Some(&entry)).await
    } else {
        None
    };
    Json(mcp_saved(connect_error))
}

/// POST /web/settings/mcp/servers/update
///
/// Supports renaming via `originalName`. Validation runs **before** the old entry
/// is removed, so a rejected update cannot leave the server half-deleted.
pub async fn mcp_server_update(
    State(state): State<Arc<AppState>>,
    Json(body): Json<McpBody>,
) -> Json<serde_json::Value> {
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "name is required"}));
    }
    let lookup = if body.original_name.trim().is_empty() {
        name.clone()
    } else {
        body.original_name.trim().to_string()
    };

    let mut servers = read_settings_key("mcpServers");
    if !servers.is_object() {
        servers = serde_json::json!({});
    }
    let Some(existing) = servers.get(&lookup).cloned() else {
        return Json(serde_json::json!({"code": 400, "description": format!("Server not found: {}", lookup)}));
    };

    let entry = match build_entry(&body, Some(&existing)) {
        Ok(e) => e,
        Err(msg) => return Json(serde_json::json!({"code": 400, "description": msg})),
    };

    let renamed = lookup != name;
    if renamed {
        if let Some(obj) = servers.as_object_mut() {
            obj.remove(&lookup);
        }
    }
    servers[&name] = entry.clone();
    if !patch_settings("mcpServers", servers) {
        return Json(settings_write_failed());
    }

    // Tear down the old identity first, otherwise a rename leaves the previous
    // child process running and its tools callable under a dead name.
    if renamed {
        sync_engine(&state, &lookup, None).await;
    }
    let connect_error = if entry["enabled"].as_bool().unwrap_or(true) {
        sync_engine(&state, &name, Some(&entry)).await
    } else {
        sync_engine(&state, &name, None).await;
        None
    };
    Json(mcp_saved(connect_error))
}

/// POST /web/settings/mcp/servers/remove
pub async fn mcp_server_remove(
    State(state): State<Arc<AppState>>,
    Json(body): Json<McpBody>,
) -> Json<serde_json::Value> {
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "name is required"}));
    }
    let mut servers = read_settings_key("mcpServers");
    if let Some(obj) = servers.as_object_mut() {
        obj.remove(&name);
        // Tear down only if the removal persisted, so a refused write does not
        // kill a server that is still configured on disk.
        if !patch_settings("mcpServers", serde_json::Value::Object(obj.clone())) {
            return Json(settings_write_failed());
        }
    }
    sync_engine(&state, &name, None).await;
    Json(serde_json::json!({"code": 200}))
}

/// POST /web/settings/mcp/servers/toggle
///
/// Sets the **submitted** value rather than flipping the stored one. The UI sends
/// the checkbox's new state; flipping server-side desynchronizes the two as soon
/// as a save fails or the list is stale, and the next click then lands on the
/// wrong side.
pub async fn mcp_server_toggle(
    State(state): State<Arc<AppState>>,
    Json(body): Json<McpBody>,
) -> Json<serde_json::Value> {
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "name is required"}));
    }
    let mut servers = read_settings_key("mcpServers");
    let Some(entry) = servers.get_mut(&name) else {
        return Json(serde_json::json!({"code": 400, "description": format!("Server not found: {}", name)}));
    };
    let enabled = body.enabled.unwrap_or(true);
    entry["enabled"] = serde_json::json!(enabled);
    let snapshot = entry.clone();
    if !patch_settings("mcpServers", servers) {
        return Json(settings_write_failed());
    }

    let connect_error = if enabled {
        sync_engine(&state, &name, Some(&snapshot)).await
    } else {
        sync_engine(&state, &name, None).await;
        None
    };
    Json(mcp_saved(connect_error))
}

/// POST /web/settings/mcp/servers/check — test a config **without saving it**.
///
/// Spawns the server, completes the MCP handshake, lists tools, then kills the
/// child. The reason text is returned in both `description` (the Solon `Result`
/// field, matching the Java kernel) and `message`, because this is the one
/// endpoint whose text the UI renders verbatim into the result badge and it
/// currently reads `resp.message`.
pub async fn mcp_server_check(
    State(state): State<Arc<AppState>>,
    Json(body): Json<McpBody>,
) -> Json<serde_json::Value> {
    let entry = match build_entry(&body, None) {
        Ok(e) => e,
        Err(msg) => return Json(check_fail(&msg)),
    };
    let cfg = entry_to_config(&entry);
    let kind = cfg.resolved_type();

    // A probe must never touch the live registry: the user is testing a config
    // they may well discard, and leaving it connected would make an unsaved
    // server's tools callable by the agent.
    let probe_name = format!("__check__{}", uuid::Uuid::new_v4());
    match state.mcp.probe(&probe_name, &cfg).await {
        Ok(tools) => {
            let msg = format!(
                "连接成功：MCP 初始化握手完成（{}），发现 {} 个工具",
                kind,
                tools.len()
            );
            Json(serde_json::json!({"code": 200, "description": msg, "message": msg,
                                    "data": {"tools": tools.len()}}))
        }
        Err(e) => Json(check_fail(&humanize_connect_error(&e.to_string(), &kind))),
    }
}

fn check_fail(msg: &str) -> serde_json::Value {
    serde_json::json!({"code": 400, "description": msg, "message": msg})
}

/// Map low-level spawn/IO errors onto the messages the Java kernel returns, so
/// the UI badge says something actionable instead of a raw Rust error string.
fn humanize_connect_error(raw: &str, kind: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("not implemented") {
        return format!("不支持检测的类型: {}", kind);
    }
    if lower.contains("timed out") || lower.contains("timeout") {
        return "连接超时，请检查地址是否可达".into();
    }
    if lower.contains("connection refused") || lower.contains("actively refused") {
        return "连接被拒绝，请检查地址和端口是否正确".into();
    }
    if lower.contains("os error 2") || lower.contains("no such file") {
        return format!("命令无法执行（未找到可执行文件）: {}", raw);
    }
    if lower.contains("closed stdout") {
        return "服务器已启动但未响应 MCP 握手（请检查命令与参数）".into();
    }
    format!("检测失败: {}", raw)
}

/// Query for `GET /web/settings/mcp/servers/tools`.
#[derive(serde::Deserialize, Default)]
pub struct McpNameQuery {
    #[serde(default)]
    pub name: String,
}

/// GET /web/settings/mcp/servers/tools — list a server's tools and its denylist.
pub async fn mcp_server_tools(
    State(state): State<Arc<AppState>>,
    Query(q): Query<McpNameQuery>,
) -> Json<serde_json::Value> {
    let name = q.name.trim().to_string();
    if name.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "name is required"}));
    }
    let servers = read_settings_key("mcpServers");
    let Some(entry) = servers.get(&name).cloned() else {
        return Json(serde_json::json!({"code": 400, "description": format!("Server not found: {}", name)}));
    };
    let cfg = entry_to_config(&entry);
    let disallowed = cfg.disallowed_tools.clone();

    // Prefer the live connection; fall back to a one-shot probe so a disabled or
    // not-yet-connected server can still have its tools inspected.
    let mut tools = state.mcp.tools_of(&name).await;
    let mut connected = !tools.is_empty();
    if tools.is_empty() {
        let probe_name = format!("__tools__{}", uuid::Uuid::new_v4());
        match state.mcp.probe(&probe_name, &cfg).await {
            Ok(t) => {
                tools = t;
                connected = true;
            }
            Err(e) => {
                return Json(serde_json::json!({
                    "code": 200,
                    "data": {
                        "serverName": name,
                        "connected": false,
                        "disallowedTools": disallowed,
                        "tools": [],
                        "error": humanize_connect_error(&e.to_string(), &cfg.resolved_type()),
                    }
                }));
            }
        }
    }

    let list: Vec<serde_json::Value> = tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "name": t.name,
                "description": t.description,
                "inputSchema": t.input_schema,
            })
        })
        .collect();

    Json(serde_json::json!({
        "code": 200,
        "data": {
            "serverName": name,
            "connected": connected,
            "disallowedTools": disallowed,
            "tools": list,
        }
    }))
}

/// POST /web/settings/mcp/servers/tools/save — persist a server's tool denylist.
pub async fn mcp_server_tools_save(
    State(state): State<Arc<AppState>>,
    Json(body): Json<McpBody>,
) -> Json<serde_json::Value> {
    let name = body.server_name.trim().to_string();
    if name.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "serverName is required"}));
    }
    let mut servers = read_settings_key("mcpServers");
    let Some(entry) = servers.get_mut(&name) else {
        return Json(serde_json::json!({"code": 400, "description": format!("Server not found: {}", name)}));
    };

    // Full replace, not merge: the panel submits the complete unchecked set, so
    // merging would make "re-enable everything" impossible.
    let list: Vec<String> = body
        .disallowed_tools
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    entry["disallowedTools"] = serde_json::json!(list);
    let snapshot = entry.clone();
    if !patch_settings("mcpServers", servers) {
        return Json(settings_write_failed());
    }

    // Reconnect so the denylist takes effect for the agent immediately. A failed
    // reconnect is not harmless here: it drops the server's previously available
    // tools, so it must be surfaced like the other saves.
    let connect_error = if snapshot["enabled"].as_bool().unwrap_or(true) {
        sync_engine(&state, &name, Some(&snapshot)).await
    } else {
        None
    };
    Json(mcp_saved(connect_error))
}

/// POST /web/settings/mcp/import/parse — parse an uploaded config file.
pub async fn mcp_import_parse(mut multipart: Multipart) -> Json<serde_json::Value> {
    let mut content: Option<String> = None;
    while let Ok(Some(field)) = multipart.next_field().await {
        if field.name().unwrap_or_default() == "file" {
            let bytes = field.bytes().await.unwrap_or_default();
            // Notepad on a legacy Chinese Windows saves ANSI/GBK; lossy UTF-8
            // made such uploads unparseable garbage.
            content = Some(crate::textcodec::decode_bytes(&bytes));
        }
    }
    let Some(text) = content else {
        return Json(serde_json::json!({"code": 400, "description": "请上传文件"}));
    };
    parse_mcp_config_text(&text)
}

/// POST /web/settings/mcp/import/parse/string — parse pasted JSON.
///
/// The UI posts the **raw config text** as the body (`data: jsonStr` with a JSON
/// content type), not a wrapper object, so this takes `String` rather than a
/// deserialized struct.
pub async fn mcp_import_parse_string(body: String) -> Json<serde_json::Value> {
    if body.trim().is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "JSON 字符串不能为空"}));
    }
    parse_mcp_config_text(&body)
}

/// Shared import parser. Detects three shapes and normalizes every server into a
/// body that `/mcp/servers/add` accepts verbatim.
///
///   1. OpenCode   — `$schema` containing `opencode.ai/config` + `mcp` object
///   2. mcpServers — Claude Desktop / Cursor style
///   3. explicit   — `{ "format": "mcp", "servers": {...} }`
fn parse_mcp_config_text(text: &str) -> Json<serde_json::Value> {
    let root: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => {
            return Json(
                serde_json::json!({"code": 400, "description": format!("JSON 解析失败: {}", e)}),
            )
        }
    };
    if !root.is_object() {
        return Json(serde_json::json!({"code": 400, "description": "内容不是有效的 JSON 对象"}));
    }

    let schema = root.get("$schema").and_then(|v| v.as_str()).unwrap_or("");
    let (node, format) = if schema.contains("opencode.ai/config")
        && root.get("mcp").map_or(false, |m| m.is_object())
    {
        (root.get("mcp").unwrap(), "OpenCode")
    } else if root.get("mcpServers").map_or(false, |m| m.is_object()) {
        (root.get("mcpServers").unwrap(), "mcpServers")
    } else if root.get("format").and_then(|v| v.as_str()) == Some("mcp")
        && root.get("servers").map_or(false, |s| s.is_object())
    {
        (root.get("servers").unwrap(), "explicit")
    } else {
        return Json(serde_json::json!({
            "code": 400,
            "description": "无法识别的配置文件格式: 期望 OpenCode 或 mcpServers 格式"
        }));
    };

    let mut out: Vec<serde_json::Value> = Vec::new();
    for (name, cfg) in node.as_object().unwrap_or(&serde_json::Map::new()) {
        if !cfg.is_object() {
            continue;
        }
        out.push(normalize_imported_server(name, cfg));
    }

    Json(serde_json::json!({"code": 200, "data": {"format": format, "servers": out}}))
}

/// Turn one imported entry into an add-ready body. Never panics on odd input:
/// unusable entries carry an `error` field so the preview shows them unchecked
/// instead of the whole import failing.
fn normalize_imported_server(name: &str, cfg: &serde_json::Value) -> serde_json::Value {
    let mut s = serde_json::json!({
        "name": name,
        "enabled": true,
        "scope": SCOPE_USER,
    });

    let declared = cfg
        .get("type")
        .or_else(|| cfg.get("transport"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let kind = if declared.is_empty() {
        // Infer from which key is present, as the Java importer does.
        if cfg.get("command").is_some() {
            mcp::TYPE_STDIO.to_string()
        } else if cfg.get("url").is_some() {
            mcp::TYPE_SSE.to_string()
        } else {
            s["error"] = serde_json::json!("无法识别服务器类型，缺少 command 或 url");
            return s;
        }
    } else {
        mcp::standardize(declared).unwrap_or_else(|| declared.to_string())
    };
    s["type"] = serde_json::json!(kind);

    if mcp::is_stdio(&kind) {
        // `command` may be a string or an argv array; split the array form into
        // command + args so the add endpoint receives what it expects.
        let mut detail = String::new();
        match cfg.get("command") {
            Some(v) if v.is_array() => {
                let parts: Vec<String> = v
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect();
                if let Some(first) = parts.first() {
                    s["command"] = serde_json::json!(first);
                    detail.push_str(first);
                }
                if parts.len() > 1 {
                    s["args"] = serde_json::json!(&parts[1..]);
                    for p in &parts[1..] {
                        detail.push(' ');
                        detail.push_str(p);
                    }
                }
            }
            Some(v) => {
                let c = v.as_str().unwrap_or_default().to_string();
                s["command"] = serde_json::json!(c);
                detail = c;
            }
            None => {}
        }
        if let Some(args) = cfg.get("args").and_then(|a| a.as_array()) {
            let list: Vec<String> = args
                .iter()
            .filter_map(|x| x.as_str().map(String::from))
                .collect();
            s["args"] = serde_json::json!(list);
            detail.clear();
            if let Some(c) = s.get("command").and_then(|v| v.as_str()) {
                detail.push_str(c);
            }
            for a in &list {
                detail.push(' ');
                detail.push_str(a);
            }
        }
        // env spelling varies across exporters.
        for key in ["env", "environment", "envVars", "environmentVariables"] {
            if let Some(m) = cfg.get(key).and_then(|v| v.as_object()) {
                let map: serde_json::Map<String, serde_json::Value> = m
                    .iter()
                    .map(|(k, v)| {
                        (k.clone(), serde_json::json!(v.as_str().unwrap_or_default().to_string()))
                    })
                    .collect();
                if !map.is_empty() {
                    s["env"] = serde_json::Value::Object(map);
                }
                break;
            }
        }
        s["detail"] = serde_json::json!(detail);
    } else if mcp::is_http_type(&kind) {
        let url = cfg.get("url").and_then(|v| v.as_str()).unwrap_or_default();
        s["url"] = serde_json::json!(url);
        s["detail"] = serde_json::json!(url);
        if let Some(h) = cfg.get("headers").and_then(|v| v.as_object()) {
            s["headers"] = serde_json::json!(h);
        }
        if let Some(t) = cfg.get("timeout") {
            s["timeout"] = t.clone();
        }
    } else {
        s["error"] = serde_json::json!(format!("不支持的服务器类型: {}", kind));
    }

    s
}

// ─── Providers ───────────────────────────────────────────────────────────────
//
// A "provider" is a saved LLM connection (apiUrl + apiKey + protocol standard)
// plus the model list discovered from it. `sync-models` materializes those models
// into the top-level `models` map that the chat model picker reads, keyed
// `<provider>-<modelId>`.
//
// Storage shape in settings.json (shared with the Java kernel):
//   "providers": { "<name>": { "standard", "apiUrl", "apiKey", "enabled",
//                              "scope", "timeout", "models": [ModelInfo...] } }
//
// API keys never leave the kernel in plaintext: list/get return a masked value
// plus a `hasKey` boolean, and `update` treats an absent `apiKey` as "keep the
// stored one" (the form deliberately does not prefill secrets).

/// Mask an API key for display: `sk-a****wxyz`. Short keys mask entirely.
///
/// Byte-for-byte the rule in Java's `WebSettingsController.maskApiKey`: empty →
/// `""`, length ≤ 8 → `"****"`, otherwise first 4 + `****` + last 4. Shared with
/// the `llm/models*` handlers in `server/mod.rs` so the two cannot drift — a
/// drift here means one endpoint leaks a plaintext key while the other masks it.
pub(crate) fn mask_api_key(key: &str) -> String {
    if key.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = key.chars().collect();
    if chars.len() <= 8 {
        return "****".to_string();
    }
    format!(
        "{}****{}",
        chars[..4].iter().collect::<String>(),
        chars[chars.len() - 4..].iter().collect::<String>()
    )
}

/// Render one provider entry for the UI, masking the key.
fn provider_item(name: &str, p: &serde_json::Value) -> serde_json::Value {
    let api_key = p.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");
    let mut item = serde_json::json!({
        "name": name,
        "standard": p.get("standard").and_then(|v| v.as_str()).unwrap_or("openai"),
        "apiUrl": p.get("apiUrl").and_then(|v| v.as_str()).unwrap_or(""),
        "apiKey": mask_api_key(api_key),
        "hasKey": !api_key.is_empty(),
        "enabled": p.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true),
        "scope": p.get("scope").and_then(|v| v.as_str()).unwrap_or(SCOPE_USER),
        "models": p.get("models").cloned().unwrap_or_else(|| serde_json::json!([])),
    });
    if let Some(t) = p.get("timeout") {
        item["timeout"] = t.clone();
    }
    item
}

/// Read the providers map, tolerating a missing/invalid key.
fn read_providers() -> serde_json::Map<String, serde_json::Value> {
    read_settings_key("providers")
        .as_object()
        .cloned()
        .unwrap_or_default()
}

/// GET /web/settings/providers
///
/// Returns an **array** sorted by name. The UI does `providers = res.data` then
/// `providers.forEach(...)`, so returning the raw settings map (as this endpoint
/// used to) made the whole model-settings panel render an empty list.
pub async fn providers_list() -> Json<serde_json::Value> {
    let mut list: Vec<serde_json::Value> = read_providers()
        .iter()
        .map(|(name, p)| provider_item(name, p))
        .collect();
    list.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
    Json(serde_json::json!({"code": 200, "data": list}))
}

/// Body for the provider endpoints.
#[derive(serde::Deserialize, Default)]
#[serde(default)]
pub struct ProviderBody {
    pub name: String,
    #[serde(rename = "originalName")]
    pub original_name: String,
    pub standard: Option<String>,
    #[serde(rename = "apiUrl")]
    pub api_url: Option<String>,
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
    pub enabled: Option<bool>,
    pub scope: Option<String>,
    pub timeout: Option<String>,
    pub models: Option<Vec<serde_json::Value>>,
    /// `fetch` / `sync-models` fields.
    #[serde(rename = "providerName")]
    pub provider_name: String,
}

/// Query for `GET /web/settings/providers/get`.
#[derive(serde::Deserialize, Default)]
pub struct NameQuery {
    #[serde(default)]
    pub name: String,
}

/// GET /web/settings/providers/get — one provider's detail (key masked).
pub async fn providers_get(Query(q): Query<NameQuery>) -> Json<serde_json::Value> {
    let name = q.name.trim();
    if name.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "name is required"}));
    }
    let providers = read_providers();
    match providers.get(name) {
        Some(p) => Json(serde_json::json!({"code": 200, "data": provider_item(name, p)})),
        None => Json(serde_json::json!({"code": 400, "description": format!("Provider not found: {}", name)})),
    }
}

/// POST /web/settings/providers/add
pub async fn providers_add(Json(body): Json<ProviderBody>) -> Json<serde_json::Value> {
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "name is required"}));
    }
    let mut providers = read_providers();
    if providers.contains_key(&name) {
        return Json(serde_json::json!({"code": 400, "description": format!("Provider name already exists: {}", name)}));
    }

    let entry = serde_json::json!({
        "name": name,
        "standard": body.standard.clone().unwrap_or_else(|| "openai".into()),
        "apiUrl": body.api_url.clone().unwrap_or_default(),
        "apiKey": body.api_key.clone().unwrap_or_default(),
        "enabled": body.enabled.unwrap_or(true),
        "scope": norm_scope(body.scope.as_deref()),
        "timeout": body.timeout.clone().unwrap_or_default(),
        "models": body.models.clone().unwrap_or_default(),
    });
    providers.insert(name, entry);
    if !patch_settings("providers", serde_json::Value::Object(providers)) {
        return Json(settings_write_failed());
    }
    Json(serde_json::json!({"code": 200}))
}

/// POST /web/settings/providers/update
///
/// Supports renaming via `originalName`. An absent `apiKey` keeps the stored key;
/// an explicit empty string clears it. Renaming also rewrites the `<provider>-`
/// prefix of that provider's materialized models, otherwise they become orphans
/// that no update or sync can ever reach again.
pub async fn providers_update(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ProviderBody>,
) -> Json<serde_json::Value> {
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "name is required"}));
    }
    let lookup = if body.original_name.trim().is_empty() {
        name.clone()
    } else {
        body.original_name.trim().to_string()
    };

    let mut providers = read_providers();
    let Some(existing) = providers.get(&lookup).cloned() else {
        return Json(serde_json::json!({"code": 400, "description": format!("Provider not found: {}", lookup)}));
    };
    let renamed = lookup != name;
    if renamed && providers.contains_key(&name) {
        return Json(serde_json::json!({"code": 400, "description": format!("Provider name already exists: {}", name)}));
    }

    let prev = |key: &str, submitted: &Option<String>| -> String {
        match submitted {
            Some(v) => v.clone(),
            None => existing.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string(),
        }
    };

    let entry = serde_json::json!({
        "name": name,
        "standard": prev("standard", &body.standard),
        "apiUrl": prev("apiUrl", &body.api_url),
        "apiKey": prev("apiKey", &body.api_key),
        "enabled": body.enabled.unwrap_or_else(|| existing.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true)),
        "scope": norm_scope(body.scope.as_deref().or_else(|| existing.get("scope").and_then(|v| v.as_str()))),
        "timeout": prev("timeout", &body.timeout),
        "models": match &body.models {
            Some(m) => serde_json::json!(m),
            None => existing
                .get("models")
                .cloned()
                .unwrap_or_else(|| serde_json::json!([])),
        },
    });

    if renamed {
        providers.remove(&lookup);
    }
    providers.insert(name.clone(), entry);
    // The rename cascade below rewrites model keys on disk. Skip it entirely if
    // the provider entry itself did not persist, or the models would be renamed
    // to match a provider name that was never saved.
    if !patch_settings("providers", serde_json::Value::Object(providers)) {
        return Json(settings_write_failed());
    }

    if renamed {
        rename_provider_models(&lookup, &name);
        // Renaming rewrites the materialized model keys on disk; the in-memory
        // table still holds the old-prefixed names and would write them back.
        super::reload_settings_from_disk(&state).await;
    }
    Json(serde_json::json!({"code": 200}))
}

/// Rewrite materialized model keys/names when a provider is renamed.
///
/// Models are stored as `<provider>-<modelId>`; without this the old-prefixed
/// entries stay in `models` forever, still selectable in the chat picker but no
/// longer reachable by any provider operation.
fn rename_provider_models(old_name: &str, new_name: &str) {
    let path = settings_path();
    let SettingsRead::Usable(obj) = read_settings_for_update(&path) else { return };
    let mut v = serde_json::Value::Object(obj);

    let old_prefix = format!("{}-", old_name);
    let new_prefix = format!("{}-", new_name);

    let Some(models) = v.get_mut("models").and_then(|m| m.as_object_mut()) else { return };
    let mut rebuilt: Vec<(String, serde_json::Value)> = Vec::new();
    for (key, val) in models.iter() {
        if !key.starts_with(&old_prefix) {
            rebuilt.push((key.clone(), val.clone()));
            continue;
        }
        let new_key = format!("{}{}", new_prefix, &key[old_prefix.len()..]);
        let mut nv = val.clone();
        if let Some(obj) = nv.as_object_mut() {
            obj.insert("name".into(), serde_json::json!(new_key));
            obj.insert("provider".into(), serde_json::json!(new_name));
        }
        rebuilt.push((new_key, nv));
    }
    *models = rebuilt.into_iter().collect();

    // The default model may point at a renamed entry.
    if let Some(dm) = v.get("defaultModel").and_then(|d| d.as_str()).map(String::from) {
        if dm.starts_with(&old_prefix) {
            let new_dm = format!("{}{}", new_prefix, &dm[old_prefix.len()..]);
            v["defaultModel"] = serde_json::json!(new_dm);
        }
    }

    let _ = std::fs::write(&path, serde_json::to_string_pretty(&v).unwrap_or_default());
}

/// Body for `providers/remove` and `providers/toggle`.
///
/// These two are **form-encoded**, not JSON: the UI calls them with a plain
/// `data: {...}` object and no `contentType`, so jQuery sends
/// `application/x-www-form-urlencoded`. Using `Json<...>` here would answer 415.
/// (`add`/`update`/`sync-models` do send JSON — see `ProviderBody`.)
#[derive(serde::Deserialize, Default)]
#[serde(default)]
pub struct ProviderNameBody {
    pub name: String,
    /// Form encoding carries booleans as the strings "true"/"false".
    #[serde(deserialize_with = "de_form_bool")]
    pub enabled: Option<bool>,
}

/// Body for `providers/fetch` (form-encoded, see `ProviderNameBody`).
#[derive(serde::Deserialize, Default)]
#[serde(default)]
pub struct ProviderFetchBody {
    #[serde(rename = "apiUrl")]
    pub api_url: String,
    #[serde(rename = "apiKey")]
    pub api_key: String,
    pub standard: String,
    #[serde(rename = "providerName")]
    pub provider_name: String,
}

/// Deserialize a form-encoded boolean. `serde_urlencoded` yields `"true"`/`"false"`
/// as strings, which the default bool deserializer rejects.
fn de_form_bool<'de, D>(d: D) -> Result<Option<bool>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::Deserialize;
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Boolish {
        B(bool),
        S(String),
    }
    match Option::<Boolish>::deserialize(d)? {
        None => Ok(None),
        Some(Boolish::B(b)) => Ok(Some(b)),
        Some(Boolish::S(s)) => match s.trim().to_lowercase().as_str() {
            "" => Ok(None),
            "true" | "1" | "on" | "yes" => Ok(Some(true)),
            "false" | "0" | "off" | "no" => Ok(Some(false)),
            other => Err(serde::de::Error::custom(format!("invalid boolean: {}", other))),
        },
    }
}

/// POST /web/settings/providers/remove
///
/// Cascades: also removes that provider's materialized models. Deleting only the
/// provider entry would leave its models selectable in the chat picker with the
/// provider's API key still baked into each of them.
pub async fn providers_remove(
    State(state): State<Arc<AppState>>,
    Form(body): Form<ProviderNameBody>,
) -> Json<serde_json::Value> {
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "name is required"}));
    }
    let mut providers = read_providers();
    providers.remove(&name);
    // Same ordering rule as the rename path: the model/defaultModel cascade
    // below must not run against a provider list that failed to persist.
    if !patch_settings("providers", serde_json::Value::Object(providers)) {
        return Json(settings_write_failed());
    }

    let removed = remove_provider_models(&name);

    // If the default model belonged to this provider, clear it so the chat picker
    // does not keep pointing at a model that no longer exists.
    clear_default_model_if_prefix(&format!("{}-", name));

    // The cascade above edited `models` / `defaultModel` on disk only. Reload so
    // the in-memory table cannot resurrect the deleted models (and the
    // provider's API key baked into each of them) on the next settings save.
    super::reload_settings_from_disk(&state).await;

    Json(serde_json::json!({"code": 200, "data": {"removedModels": removed}}))
}

/// Drop every materialized model belonging to `provider`. Returns how many went.
fn remove_provider_models(provider: &str) -> usize {
    let path = settings_path();
    let SettingsRead::Usable(obj) = read_settings_for_update(&path) else { return 0 };
    let mut v = serde_json::Value::Object(obj);
    let Some(models) = v.get_mut("models").and_then(|m| m.as_object_mut()) else { return 0 };

    let before = models.len();
    models.retain(|_k, val| {
        // Match on the stored `provider` field, not the key prefix: a user may
        // have renamed a model key, and the field is the authoritative link.
        val.get("provider").and_then(|p| p.as_str()) != Some(provider)
    });
    let removed = before - models.len();
    if removed > 0 {
        let _ = std::fs::write(&path, serde_json::to_string_pretty(&v).unwrap_or_default());
    }
    removed
}

/// Clear `defaultModel` when it starts with `prefix`.
fn clear_default_model_if_prefix(prefix: &str) {
    let path = settings_path();
    let SettingsRead::Usable(obj) = read_settings_for_update(&path) else { return };
    let mut v = serde_json::Value::Object(obj);
    let dominated = v
        .get("defaultModel")
        .and_then(|d| d.as_str())
        .map(|d| d.starts_with(prefix))
        .unwrap_or(false);
    if dominated {
        v["defaultModel"] = serde_json::json!("");
        let _ = std::fs::write(&path, serde_json::to_string_pretty(&v).unwrap_or_default());
    }
}

/// POST /web/settings/providers/toggle
///
/// Sets the submitted value (the UI sends the switch's new state) and mirrors it
/// onto the provider's materialized models' `visibled` flag, ANDed with each
/// model's own `enabled` so a model the user disabled individually stays disabled
/// after the connection is re-enabled.
pub async fn providers_toggle(
    State(state): State<Arc<AppState>>,
    Form(body): Form<ProviderNameBody>,
) -> Json<serde_json::Value> {
    let name = body.name.trim().to_string();
    let Some(enabled) = body.enabled else {
        return Json(serde_json::json!({"code": 400, "description": "name and enabled are required"}));
    };
    if name.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "name is required"}));
    }

    let mut providers = read_providers();
    let Some(entry) = providers.get_mut(&name) else {
        return Json(serde_json::json!({"code": 400, "description": format!("Provider not found: {}", name)}));
    };
    entry["enabled"] = serde_json::json!(enabled);
    // Per-model enabled flags, so re-enabling the connection cannot resurrect a
    // model the user turned off individually.
    let per_model: std::collections::HashMap<String, bool> = entry
        .get("models")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    Some((
                        m.get("id")?.as_str()?.to_string(),
                        m.get("enabled").and_then(|e| e.as_bool()).unwrap_or(true),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    if !patch_settings("providers", serde_json::Value::Object(providers)) {
        return Json(settings_write_failed());
    }

    apply_provider_visibility(&name, enabled, &per_model);
    // `apply_provider_visibility` flips `visibled` on disk; reload so the
    // in-memory copy (which drives the chat picker) agrees with the file.
    super::reload_settings_from_disk(&state).await;
    Json(serde_json::json!({"code": 200}))
}

/// Mirror a provider's enabled state onto its materialized models.
fn apply_provider_visibility(
    provider: &str,
    provider_enabled: bool,
    per_model: &std::collections::HashMap<String, bool>,
) {
    let path = settings_path();
    let SettingsRead::Usable(obj) = read_settings_for_update(&path) else { return };
    let mut v = serde_json::Value::Object(obj);
    let Some(models) = v.get_mut("models").and_then(|m| m.as_object_mut()) else { return };

    let mut changed = false;
    for (_key, val) in models.iter_mut() {
        if val.get("provider").and_then(|p| p.as_str()) != Some(provider) {
            continue;
        }
        let model_id = val.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string();
        let own = per_model.get(&model_id).copied().unwrap_or(true);
        let want = provider_enabled && own;
        if val.get("visibled").and_then(|x| x.as_bool()) != Some(want) {
            val["visibled"] = serde_json::json!(want);
            changed = true;
        }
    }
    if changed {
        let _ = std::fs::write(&path, serde_json::to_string_pretty(&v).unwrap_or_default());
    }
}

/// POST /web/settings/providers/fetch — list models from the provider's API.
///
/// Talks to the protocol-appropriate models endpoint with the matching auth
/// header. When `apiKey` is omitted but `providerName` is given, the stored key
/// is used — and in that case the stored `apiUrl`/`standard` are used **as a
/// set** with it, so a caller cannot make the kernel send a saved secret to an
/// arbitrary host.
///
/// The URL/path rules here mirror the Java `ModelsAdapter`s AND the chat
/// `Dialect` used by this same kernel. Confusing the two was the original bug:
/// chat appends `/v1/...` to a bare host (so chat worked), while the first
/// Rust port appended only `/models`. For proxies such as `api.aionly.com` the
/// bare `/models` is served by the website/gateway and answers **HTTP 200** with
/// `{"code":401,"msg":"token 无效","data":null}`. Silently treating that as
/// "zero models" is exactly the "服务返回空模型列表" report — Java had fixed
/// this with `ModelsFetchReason` (see its javadoc), and the port lost the fix.
pub async fn providers_fetch(Form(body): Form<ProviderFetchBody>) -> Json<serde_json::Value> {
    let mut api_url = body.api_url.clone();
    let mut api_key = body.api_key.clone();
    let mut standard = if body.standard.trim().is_empty() {
        "openai".to_string()
    } else {
        body.standard.clone()
    };

    if api_url.trim().is_empty() {
        return Json(fetch_fail("INVALID_URL", 0, None));
    }
    if api_key.is_empty() && !body.provider_name.trim().is_empty() {
        let providers = read_providers();
        if let Some(stored) = providers.get(body.provider_name.trim()) {
            let stored_key = stored.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");
            if !stored_key.is_empty() {
                api_key = stored_key.to_string();
                api_url = stored.get("apiUrl").and_then(|v| v.as_str()).unwrap_or("").to_string();
                standard = stored
                    .get("standard")
                    .and_then(|v| v.as_str())
                    .unwrap_or("openai")
                    .to_string();
            }
        }
    }

    let std_lower = standard.to_ascii_lowercase();
    let candidates = model_list_urls(&api_url, &std_lower);
    let Some(first) = candidates.first().cloned() else {
        return Json(fetch_fail("INVALID_URL", 0, None));
    };

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
    {
        Ok(c) => c,
        Err(e) => return Json(fetch_fail("UNKNOWN", 0, Some(&e.to_string()))),
    };

    // A bare base URL belongs to the provider's website more often than to its
    // API. Retrying the canonical `/v1/models` is what makes "add provider with
    // the same URL that already works in chat" succeed. Only a response that is
    // *not* a usable model list is retried — a genuine empty `{"data":[]}` from
    // the canonical URL stays an empty list (the UI keeps the old one).
    let mut last_failure: Option<(String, u16)> = None;
    for url in candidates {
        let mut req = client.get(&url);
        match std_lower.as_str() {
            "anthropic" => {
                if !api_key.is_empty() {
                    req = req.header("x-api-key", api_key.clone());
                }
                req = req.header("anthropic-version", "2023-06-01");
            }
            "gemini" => {
                if !api_key.is_empty() {
                    req = req.header("x-goog-api-key", api_key.clone());
                }
            }
            _ => {
                if !api_key.is_empty() {
                    req = req.bearer_auth(api_key.clone());
                }
            }
        }

        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                let reason = if e.is_timeout() {
                    "TIMEOUT"
                } else if e.is_connect() {
                    "CONNECT_REFUSED"
                } else {
                    "NETWORK_ERROR"
                };
                // Transport failures are not worth retrying at a different path:
                // the host itself is unreachable.
                return Json(fetch_fail(reason, 0, Some(&e.to_string())));
            }
        };
        let status = resp.status().as_u16();
        if !resp.status().is_success() {
            last_failure = Some((http_fetch_reason(status).to_string(), status));
            continue;
        }

        let payload: serde_json::Value = match resp.json().await {
            Ok(v) => v,
            Err(e) => {
                last_failure = Some(("INVALID_RESPONSE".to_string(), status));
                tracing::warn!(url = %url, error = %e, "provider /models response is not JSON");
                continue;
            }
        };

        let Some(items) = model_list_items(&payload, &std_lower) else {
            // e.g. `{"code":401,"msg":"token 无效","data":null}` returned with
            // HTTP 200 by the bare path, or an HTML SPA fallback. Never report
            // this as "the provider has no models".
            last_failure = Some(("INVALID_RESPONSE".to_string(), status));
            tracing::warn!(url = %url, "provider /models response has no model array");
            continue;
        };

        let mut out: Vec<serde_json::Value> = Vec::new();
        for it in items {
            let id = it
                .get("id")
                .and_then(|v| v.as_str())
                .or_else(|| it.get("name").and_then(|v| v.as_str()))
                .unwrap_or("")
                .to_string();
            // Gemini's /v1beta/models lists entries as {"name":"models/gemini-x"}.
            // The chat Dialect builds `{root}/models/{model_id}:generateContent`,
            // so an un-stripped prefix would produce `/models/models/gemini-x:...`
            // and every chat call would 404 after a successful fetch.
            let id = id.strip_prefix("models/").map(|s| s.to_string()).unwrap_or(id);
            if id.is_empty() {
                continue;
            }
            // Anthropic/Ollama adapters stamp their own protocol; proxies return
            // `supported_endpoint_types` so the UI can pick the chat dialect.
            let item_standard = infer_model_standard(it, &std_lower);
            out.push(serde_json::json!({
                "id": id,
                "owned_by": it.get("owned_by").cloned().unwrap_or(serde_json::Value::Null),
                "standard": item_standard,
                "supported_endpoint_types": it.get("supported_endpoint_types").cloned().unwrap_or(serde_json::Value::Null),
            }));
        }
        return Json(serde_json::json!({"code": 200, "data": out}));
    }

    // Every candidate failed. Returning `code: 400` is the whole point: the UI
    // shows an actionable reason instead of the "empty model list" toast.
    let (reason, status) = last_failure.unwrap_or(("UNKNOWN".to_string(), 0));
    Json(fetch_fail(&reason, status, Some(&first)))
}

fn fetch_fail(reason: &str, status: u16, detail: Option<&str>) -> serde_json::Value {
    let mut data = serde_json::json!({ "reason": reason, "status": status });
    if let Some(d) = detail {
        data["detail"] = serde_json::Value::String(d.to_string());
    }
    serde_json::json!({
        "code": 400,
        "description": "fetch models failed",
        "message": "fetch models failed",
        "data": data
    })
}

/// Machine-readable reasons consumed by the UI's `FETCH_REASON_KEYS`
/// (`app-model-settings.js`). Keep these names equal to Java's
/// `ModelsFetchReason` — the Rust port once emitted UNAUTHORIZED/NOT_FOUND and
/// the UI silently fell back to the generic "unknown" text.
fn http_fetch_reason(status: u16) -> &'static str {
    match status {
        401 | 403 | 407 => "AUTH_FAILED",
        404 | 405 | 501 => "NOT_SUPPORTED",
        408 | 504 => "TIMEOUT",
        429 => "RATE_LIMITED",
        500..=599 => "UPSTREAM_ERROR",
        _ => "BAD_STATUS",
    }
}

/// Ordered candidate URLs for the models-list request.
///
/// Java's adapters (and this kernel's chat `Dialect`) insert `/v1` for a bare
/// base URL; the Rust settings port did not. Both paths are attempted so a
/// provider that genuinely serves `/models` at the root still works.
fn model_list_urls(base: &str, standard: &str) -> Vec<String> {
    let b = base.trim().trim_end_matches('/');
    if standard == "ollama" {
        return vec![if b.ends_with("/api/tags") {
            b.to_string()
        } else {
            format!("{}/api/tags", b)
        }];
    }
    if b.ends_with("/models") {
        return vec![b.to_string()];
    }
    let canonical = if standard == "gemini" {
        if b.ends_with("/v1beta") || b.ends_with("/v1") {
            format!("{}/models", b)
        } else {
            format!("{}/v1beta/models", b)
        }
    } else if b.ends_with("/v1") || b.ends_with("/v1beta") {
        format!("{}/models", b)
    } else {
        format!("{}/v1/models", b)
    };
    let bare = format!("{}/models", b);
    if canonical == bare {
        vec![canonical]
    } else {
        vec![canonical, bare]
    }
}

/// Extract the model array from a provider response, or `None` when the body is
/// not a model list at all (an error object, an HTML page, `{"data":null}`).
fn model_list_items<'a>(payload: &'a serde_json::Value, standard: &str) -> Option<&'a Vec<serde_json::Value>> {
    // OpenAI/Anthropic: {"data":[{...}]}; Ollama: {"models":[{...}]}.
    let key = if standard == "ollama" { "models" } else { "data" };
    if let Some(arr) = payload.get(key).and_then(|v| v.as_array()) {
        return Some(arr);
    }
    if let Some(arr) = payload.get("models").and_then(|v| v.as_array()) {
        return Some(arr);
    }
    // Some Gemini-compatible proxies return a bare array.
    payload.as_array()
}

/// Per-model chat dialect. Mirrors Java `ModelInfo.inferStandard`, with the
/// protocol-specific adapters' fixed values applied first.
fn infer_model_standard(item: &serde_json::Value, standard: &str) -> String {
    if standard == "anthropic" || standard == "ollama" || standard == "gemini" {
        return standard.to_string();
    }
    if let Some(types) = item.get("supported_endpoint_types").and_then(|v| v.as_array()) {
        for raw in types.iter().filter_map(|v| v.as_str()) {
            let t = raw.trim().to_ascii_lowercase();
            if t.contains("anthropic") || t.contains("claude") {
                return "anthropic".to_string();
            }
            if t.contains("gemini") || t.contains("google") {
                return "gemini".to_string();
            }
            if t.contains("response") {
                return "openai-responses".to_string();
            }
            if t.contains("openai") || t.contains("chat") {
                return "openai".to_string();
            }
        }
    }
    "openai".to_string()
}

/// POST /web/settings/providers/sync-models
///
/// Materializes a provider's model list into the top-level `models` map that the
/// chat picker reads, keyed `<provider>-<modelId>`. Existing entries are updated
/// in place (url/key/standard/scope/visibility); models no longer present in the
/// provider's list are removed, so deleting a model upstream actually takes it out
/// of the picker instead of leaving a stale entry behind.
pub async fn providers_sync_models(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ProviderBody>,
) -> Json<serde_json::Value> {
    let provider_name = body.provider_name.trim().to_string();
    if provider_name.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "providerName is required"}));
    }
    let providers = read_providers();
    let Some(provider) = providers.get(&provider_name).cloned() else {
        return Json(serde_json::json!({"code": 400, "description": format!("Provider not found: {}", provider_name)}));
    };

    // The submitted list wins when present (the UI sends the edited selection);
    // otherwise fall back to the stored one.
    let models: Vec<serde_json::Value> = body
        .models
        .clone()
        .unwrap_or_else(|| provider.get("models").and_then(|m| m.as_array()).cloned().unwrap_or_default());

    let api_url = provider.get("apiUrl").and_then(|v| v.as_str()).unwrap_or("");
    let api_key = provider.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");
    let p_standard = provider.get("standard").and_then(|v| v.as_str()).unwrap_or("openai");
    let scope = provider.get("scope").and_then(|v| v.as_str()).unwrap_or(SCOPE_USER);
    let timeout = provider.get("timeout").and_then(|v| v.as_str()).unwrap_or("");
    let provider_enabled = provider.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);

    let path = settings_path();
    // This writer rewrites the *whole* document, so a parse failure here is the
    // most destructive case in this file: the old empty-object fallback reduced
    // settings.json to nothing but the `models` key, taking providers, MCP
    // servers and every other section with it.
    let SettingsRead::Usable(obj) = read_settings_for_update(&path) else {
        tracing::error!(
            provider = %provider_name,
            "settings.json did not parse; refusing to sync models (would erase the rest of the file)"
        );
        return Json(settings_write_failed());
    };
    let mut v = serde_json::Value::Object(obj);
    if v.get("models").map_or(true, |m| !m.is_object()) {
        v["models"] = serde_json::json!({});
    }

    let prefix = format!("{}-", provider_name);
    let mut synced = 0usize;
    let mut valid_keys: Vec<String> = Vec::new();

    {
        let models_map = v["models"].as_object_mut().unwrap();
        for mi in &models {
            let Some(model_id) = mi.get("id").and_then(|x| x.as_str()) else { continue };
            if model_id.is_empty() {
                continue;
            }
            let key = format!("{}{}", prefix, model_id);
            valid_keys.push(key.clone());

            // Per-model standard overrides the provider's; per-model enabled is
            // ANDed with the connection switch.
            let m_standard = mi
                .get("standard")
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(p_standard);
            let own_enabled = mi.get("enabled").and_then(|x| x.as_bool()).unwrap_or(true);
            let visibled = provider_enabled && own_enabled;

            match models_map.get_mut(&key) {
                Some(existing) => {
                    // Only touch models that really belong to this provider; a
                    // hand-made model that happens to share the key prefix must
                    // not be hijacked.
                    if existing.get("provider").and_then(|p| p.as_str()) != Some(provider_name.as_str()) {
                        continue;
                    }
                    existing["model"] = serde_json::json!(model_id);
                    existing["standard"] = serde_json::json!(m_standard);
                    existing["apiUrl"] = serde_json::json!(api_url);
                    existing["apiKey"] = serde_json::json!(api_key);
                    existing["scope"] = serde_json::json!(scope);
                    existing["visibled"] = serde_json::json!(visibled);
                    if !timeout.is_empty() {
                        existing["timeout"] = serde_json::json!(timeout);
                    }
                    synced += 1;
                }
                None => {
                    let mut entry = serde_json::json!({
                        "name": key,
                        "model": model_id,
                        "standard": m_standard,
                        "apiUrl": api_url,
                        "apiKey": api_key,
                        "scope": scope,
                        "provider": provider_name,
                        "enabled": true,
                        "visibled": visibled,
                        "headers": {},
                    });
                    entry["timeout"] = serde_json::json!(if timeout.is_empty() { "120s" } else { timeout });
                    if let Some(dn) = mi.get("displayName").and_then(|x| x.as_str()) {
                        entry["displayName"] = serde_json::json!(dn);
                    }
                    models_map.insert(key, entry);
                    synced += 1;
                }
            }
        }

        // Remove this provider's models that are no longer in the list.
        let mut removed = 0usize;
        models_map.retain(|k, val| {
            let mine = val.get("provider").and_then(|p| p.as_str()) == Some(provider_name.as_str());
            if mine && !valid_keys.contains(k) {
                removed += 1;
                return false;
            }
            true
        });
        let _ = removed;
    }

    let _ = std::fs::create_dir_all(Settings::gwork_home());
    let body = serde_json::to_string_pretty(&v).unwrap_or_default();
    if body.is_empty() {
        return Json(settings_write_failed());
    }
    if let Err(e) = std::fs::write(&path, body) {
        tracing::error!(error = %e, "failed to write settings.json during model sync");
        return Json(settings_write_failed());
    }

    // Sync materializes / prunes this provider's models on disk only. Reload so
    // the in-memory table (which drives the chat picker and every later
    // `persist_settings`) reflects the new set instead of writing the old one back.
    super::reload_settings_from_disk(&state).await;

    Json(serde_json::json!({"code": 200, "data": {"syncCount": synced}}))
}

// ─── OpenAPI servers ─────────────────────────────────────────────────────────
//
// Config CRUD for external HTTP APIs described by an OpenAPI document.
//
// IMPORTANT — partial capability: this kernel has **no OpenAPI gateway**, so it
// cannot parse a spec into callable tools. Configuration is stored and round-trips
// correctly (so settings survive and the panel works), but `servers/apis` reports
// `connected: false` with an explicit reason instead of inventing a tool list.
// Faking a list here would let the user "enable" tools that can never be called.

/// Body for the OpenAPI server endpoints.
#[derive(serde::Deserialize, Default)]
#[serde(default)]
pub struct OpenApiBody {
    pub name: String,
    #[serde(rename = "originalName")]
    pub original_name: String,
    #[serde(rename = "apiBaseUrl")]
    pub api_base_url: Option<String>,
    #[serde(rename = "docUrl")]
    pub doc_url: Option<String>,
    pub enabled: Option<bool>,
    pub scope: Option<String>,
    pub headers: Option<std::collections::HashMap<String, String>>,
    /// `apis/save` payload.
    #[serde(rename = "serverName")]
    pub server_name: String,
    #[serde(rename = "disallowedTools")]
    pub disallowed_tools: Option<Vec<String>>,
}

fn read_api_servers() -> serde_json::Map<String, serde_json::Value> {
    read_settings_key("apiServers")
        .as_object()
        .cloned()
        .unwrap_or_default()
}

fn api_server_item(name: &str, s: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "name": name,
        "apiBaseUrl": s.get("apiBaseUrl").and_then(|v| v.as_str()).unwrap_or(""),
        "docUrl": s.get("docUrl").and_then(|v| v.as_str()).unwrap_or(""),
        "enabled": s.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true),
        "scope": s.get("scope").and_then(|v| v.as_str()).unwrap_or(SCOPE_USER),
        "headers": s.get("headers").cloned().unwrap_or_else(|| serde_json::json!({})),
    })
}

/// GET /web/settings/openapi/servers — array sorted by name (UI iterates it).
pub async fn openapi_servers() -> Json<serde_json::Value> {
    let mut list: Vec<serde_json::Value> = read_api_servers()
        .iter()
        .map(|(name, s)| api_server_item(name, s))
        .collect();
    list.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
    Json(serde_json::json!({"code": 200, "data": list}))
}

/// Build an apiServers entry, falling back to the stored one for `update`.
fn build_api_server(body: &OpenApiBody, existing: Option<&serde_json::Value>) -> Result<serde_json::Value, String> {
    let prev = |key: &str, submitted: &Option<String>| -> String {
        match submitted {
            Some(v) => v.clone(),
            None => existing.and_then(|e| e.get(key)).and_then(|v| v.as_str()).unwrap_or("").to_string(),
        }
    };
    let base = prev("apiBaseUrl", &body.api_base_url);
    if base.trim().is_empty() {
        return Err("name and apiBaseUrl are required".into());
    }
    Ok(serde_json::json!({
        "apiBaseUrl": base,
        "docUrl": prev("docUrl", &body.doc_url),
        "enabled": body.enabled.unwrap_or(true),
        "scope": norm_scope(body.scope.as_deref().or_else(|| existing.and_then(|e| e.get("scope")).and_then(|v| v.as_str()))),
        "headers": match &body.headers {
            Some(m) => serde_json::json!(m),
            None => existing.and_then(|e| e.get("headers").cloned()).unwrap_or_else(|| serde_json::json!({})),
        },
        "disallowedTools": existing.and_then(|e| e.get("disallowedTools").cloned()).unwrap_or_else(|| serde_json::json!([])),
    }))
}

/// POST /web/settings/openapi/servers/add
pub async fn openapi_server_add(Json(body): Json<OpenApiBody>) -> Json<serde_json::Value> {
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "name is required"}));
    }
    let mut servers = read_api_servers();
    if servers.contains_key(&name) {
        return Json(serde_json::json!({"code": 400, "description": format!("Server name already exists: {}", name)}));
    }
    let entry = match build_api_server(&body, None) {
        Ok(e) => e,
        Err(msg) => return Json(serde_json::json!({"code": 400, "description": msg})),
    };
    servers.insert(name, entry);
    if !patch_settings("apiServers", serde_json::Value::Object(servers)) {
        return Json(settings_write_failed());
    }
    Json(serde_json::json!({"code": 200}))
}

/// POST /web/settings/openapi/servers/update (supports rename via originalName)
pub async fn openapi_server_update(Json(body): Json<OpenApiBody>) -> Json<serde_json::Value> {
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "name is required"}));
    }
    let lookup = if body.original_name.trim().is_empty() {
        name.clone()
    } else {
        body.original_name.trim().to_string()
    };
    let mut servers = read_api_servers();
    let Some(existing) = servers.get(&lookup).cloned() else {
        return Json(serde_json::json!({"code": 400, "description": format!("Server not found: {}", lookup)}));
    };
    let entry = match build_api_server(&body, Some(&existing)) {
        Ok(e) => e,
        Err(msg) => return Json(serde_json::json!({"code": 400, "description": msg})),
    };
    if lookup != name {
        servers.remove(&lookup);
    }
    servers.insert(name, entry);
    if !patch_settings("apiServers", serde_json::Value::Object(servers)) {
        return Json(settings_write_failed());
    }
    Json(serde_json::json!({"code": 200}))
}

/// POST /web/settings/openapi/servers/remove
pub async fn openapi_server_remove(Json(body): Json<OpenApiBody>) -> Json<serde_json::Value> {
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "name is required"}));
    }
    let mut servers = read_api_servers();
    servers.remove(&name);
    if !patch_settings("apiServers", serde_json::Value::Object(servers)) {
        return Json(settings_write_failed());
    }
    Json(serde_json::json!({"code": 200}))
}

/// POST /web/settings/openapi/servers/toggle — sets the submitted value.
pub async fn openapi_server_toggle(Json(body): Json<OpenApiBody>) -> Json<serde_json::Value> {
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "name is required"}));
    }
    let mut servers = read_api_servers();
    let Some(entry) = servers.get_mut(&name) else {
        return Json(serde_json::json!({"code": 400, "description": format!("Server not found: {}", name)}));
    };
    entry["enabled"] = serde_json::json!(body.enabled.unwrap_or(true));
    if !patch_settings("apiServers", serde_json::Value::Object(servers)) {
        return Json(settings_write_failed());
    }
    Json(serde_json::json!({"code": 200}))
}

/// POST /web/settings/openapi/servers/check — reachability test on `docUrl`.
///
/// A real HTTP GET with the configured headers, matching the Java kernel: 2xx/3xx
/// counts as reachable. This validates the document URL only; it does not prove the
/// spec parses (no gateway in this kernel).
pub async fn openapi_server_check(Json(body): Json<OpenApiBody>) -> Json<serde_json::Value> {
    let base = body.api_base_url.clone().unwrap_or_default();
    let doc = body.doc_url.clone().unwrap_or_default();
    if base.trim().is_empty() {
        return Json(check_fail("API 基地址不能为空"));
    }
    if doc.trim().is_empty() {
        return Json(check_fail("API 文档地址不能为空"));
    }

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => return Json(check_fail(&format!("检测失败: {}", e))),
    };
    let mut req = client.get(doc.trim());
    if let Some(headers) = &body.headers {
        for (k, v) in headers {
            req = req.header(k.as_str(), v.as_str());
        }
    }

    match req.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            if (200..400).contains(&status) {
                let msg = format!("连接成功：HTTP {}", status);
                Json(serde_json::json!({"code": 200, "description": msg, "message": msg}))
            } else {
                Json(check_fail(&format!("连接失败：HTTP {}", status)))
            }
        }
        Err(e) => {
            let msg = if e.is_timeout() {
                "连接超时，请检查地址是否可达".to_string()
            } else if e.is_connect() {
                "连接被拒绝，请检查地址和端口是否正确".to_string()
            } else {
                format!("连接失败: {}", e)
            };
            Json(check_fail(&msg))
        }
    }
}

/// GET /web/settings/openapi/servers/apis
///
/// Reports `connected: false` with an explicit reason: this kernel has no OpenAPI
/// gateway, so there is no parsed tool list to show. The UI renders that as a
/// "not connected" empty state, which is truthful. Returning a fabricated list
/// would let users toggle permissions for tools that can never be invoked.
pub async fn openapi_server_apis(Query(q): Query<NameQuery>) -> Json<serde_json::Value> {
    let name = q.name.trim().to_string();
    if name.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "name is required"}));
    }
    let servers = read_api_servers();
    let Some(entry) = servers.get(&name) else {
        return Json(serde_json::json!({"code": 400, "description": format!("Server not found: {}", name)}));
    };
    Json(serde_json::json!({
        "code": 200,
        "data": {
            "serverName": name,
            "connected": false,
            "apis": [],
            "disallowedTools": entry.get("disallowedTools").cloned().unwrap_or_else(|| serde_json::json!([])),
            "reason": "此内核尚未实现 OpenAPI 网关，无法解析接口清单",
        }
    }))
}

/// POST /web/settings/openapi/servers/apis/save — persist the tool denylist.
///
/// Stored even though nothing consumes it yet, so the user's selection survives
/// until the gateway lands rather than being silently discarded.
pub async fn openapi_server_apis_save(Json(body): Json<OpenApiBody>) -> Json<serde_json::Value> {
    let name = body.server_name.trim().to_string();
    if name.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "serverName is required"}));
    }
    let mut servers = read_api_servers();
    let Some(entry) = servers.get_mut(&name) else {
        return Json(serde_json::json!({"code": 400, "description": format!("Server not found: {}", name)}));
    };
    let list: Vec<String> = body
        .disallowed_tools
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    entry["disallowedTools"] = serde_json::json!(list);
    if !patch_settings("apiServers", serde_json::Value::Object(servers)) {
        return Json(settings_write_failed());
    }
    Json(serde_json::json!({"code": 200}))
}

/// POST /web/settings/overlay — 远端部署模式下导入桌面端的模型镜像。
///
/// ## 为什么只有远端模式接受
///
/// 本地内核的 settings 已在进程里，镜像无意义；更糟的是镜像态会**关掉落盘**
/// （见 [`crate::remote::mirror`]），于是一个能访问本地端口的进程可以用一份空
/// 模型表永久覆盖掉用户的配置。故非远端模式直接拒绝（Java 同口径
/// `Result.failure("settings overlay is only available in remote-deployed mode")`）。
///
/// ## 幂等与世代号
///
/// 每次推送都是完整快照（替换语义），重复推送最后生效。成功一次世代号自增，
/// 桌面端据此判断远端内存里的镜像是否仍是自己推上去的那一份（远端进程被重启
/// 后世代归零，而数据面探活照样通过——没有世代号就只能靠「每次复用都盲推」）。
pub async fn overlay(
    State(state): State<Arc<AppState>>,
    body: String,
) -> Json<serde_json::Value> {
    if !crate::remote::mirror::is_remote_deployed() {
        return Json(serde_json::json!({
            "code": 400,
            "description": "settings overlay is only available in remote-deployed mode"
        }));
    }
    if body.trim().is_empty() {
        // Not `body.is_empty()`: a whitespace-only body would otherwise reach
        // the JSON parser and surface as a bare parse error. Answered here (not
        // by `apply_overlay`) so the message distinguishes "you sent nothing"
        // from "you sent something unparseable".
        return Json(serde_json::json!({"code": 400, "description": "empty overlay payload"}));
    }

    // Parsing lives inside `apply_overlay` (not here) on purpose: a malformed
    // payload must take the `Malformed` branch, which bumps no generation. If
    // the handler parsed first and early-returned, that invariant would sit on an
    // untested path — exactly the shape Java's `mirrorGenerationNotBumpedOn…`
    // test exists to prevent.
    let mut settings = state.settings.write().await;
    let outcome = crate::remote::mirror::apply_overlay(&state.mirror, &mut settings, &body);
    match outcome {
        crate::remote::mirror::ApplyOutcome::Applied {
            generation,
            model_count,
        } => {
            // Deliberately NO persist_settings() call. The whole point of the
            // mirror is that the desktop shell's apiKey values never touch the
            // remote machine's disk (Java's `mirrored` flag exists for the same
            // reason). Writing here would leak every credential we were handed.
            tracing::info!(
                generation,
                model_count,
                "remote overlay imported (memory only, never persisted)"
            );
            Json(serde_json::json!({"code": 200, "data": {"generation": generation}}))
        }
        crate::remote::mirror::ApplyOutcome::NotRemoteMode => {
            Json(serde_json::json!({
                "code": 400,
                "description": "settings overlay is only available in remote-deployed mode"
            }))
        }
        crate::remote::mirror::ApplyOutcome::Malformed => {
            Json(serde_json::json!({"code": 400, "description": "invalid overlay payload"}))
        }
    }
}

/// GET /web/settings/mirror-state — 远端镜像状态回告（世代号 + 启用模型数）。
///
/// **非远端模式也正常返回**（`mirrored=false, generation=0`），不拒绝：与 overlay
/// 刻意不同。overlay 是写操作，本地模式下开放它白增攻击面；本端点是只读探针，
/// 本地模式下回告「未镜像」本身就是有效答案（壳据此知道对端不是远端部署，或
/// 远端尚未收到镜像），拒绝反而让壳无法区分「不是远端」与「探测失败」。响应不含
/// 任何凭证（只有布尔、计数与模型个数），无泄漏面。
///
/// `modelCount` 为**启用且可见**的模型数（`enabled && visibled`）——壳侧真正关心
/// 的是「远端此刻有没有可用模型」，而不是配置里躺着多少条禁用项。
pub async fn mirror_state(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let settings = state.settings.read().await;
    Json(serde_json::json!({
        "code": 200,
        "data": {
            "mirrored": state.mirror.is_mirrored(),
            "generation": state.mirror.generation(),
            "modelCount": crate::remote::mirror::enabled_model_count(&settings),
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// These exercise the path-taking inner functions rather than the real
    /// `~/.gwork/settings.json`, so they never touch the user's configuration
    /// and never mutate the process-global harness-base override (tests run in
    /// parallel threads within one process). Same convention as
    /// `config::tests`, which drives `resolve_base` instead of `harness_base`.
    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("gwork-settings-api-{}-{}", tag, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("settings.json")
    }

    /// A settings.json with several sections, only one of which any single
    /// endpoint owns. Used to prove the others survive a patch.
    fn populated() -> String {
        serde_json::to_string_pretty(&serde_json::json!({
            "defaultModel": "openai-gpt-4o",
            "models": {
                "openai-gpt-4o": {"name": "openai-gpt-4o", "provider": "openai"}
            },
            "providers": {"openai": {"apiKey": "sk-secret"}},
            "mcpServers": {"fs": {"enabled": true}},
            "general": {"acpModel": "old"}
        }))
        .unwrap()
    }

    // ─── BOM ────────────────────────────────────────────────────────────────

    #[test]
    fn a_bom_does_not_hide_the_existing_configuration() {
        let path = scratch("bom-read");
        std::fs::write(&path, format!("\u{FEFF}{}", populated())).unwrap();

        // Before the fix this parse failed and the caller fell back to an empty
        // object, so every section looked absent.
        let general = read_settings_key_at(&path, "general");
        assert_eq!(general["acpModel"], "old");
    }

    #[test]
    fn patching_a_bom_prefixed_file_keeps_every_other_section() {
        let path = scratch("bom-write");
        std::fs::write(&path, format!("\u{FEFF}{}", populated())).unwrap();

        assert!(patch_settings_at(
            &path,
            "general",
            serde_json::json!({"acpModel": "new"})
        ));

        let after: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        // The patched key changed...
        assert_eq!(after["general"]["acpModel"], "new");
        // ...and the sections this endpoint does not own are still there. This
        // is the regression that mattered: one BOM byte used to reduce the file
        // to just `{"general": ...}`.
        assert_eq!(after["models"]["openai-gpt-4o"]["provider"], "openai");
        assert_eq!(after["providers"]["openai"]["apiKey"], "sk-secret");
        assert_eq!(after["mcpServers"]["fs"]["enabled"], true);
        assert_eq!(after["defaultModel"], "openai-gpt-4o");
    }

    #[test]
    fn the_bom_is_not_written_back() {
        let path = scratch("bom-stripped");
        std::fs::write(&path, format!("\u{FEFF}{}", populated())).unwrap();
        assert!(patch_settings_at(&path, "general", serde_json::json!({})));

        let bytes = std::fs::read(&path).unwrap();
        assert_ne!(
            &bytes[..3.min(bytes.len())],
            &[0xEF, 0xBB, 0xBF],
            "rewriting should drop the BOM, not preserve it"
        );
    }

    // ─── Destructive-write guard ────────────────────────────────────────────

    #[test]
    fn a_truncated_file_is_never_overwritten() {
        let path = scratch("truncated");
        // What a crash mid-write leaves behind.
        let broken = "{\n  \"models\": {\"a\": {\"provider\": \"openai\"";
        std::fs::write(&path, broken).unwrap();

        assert!(
            !patch_settings_at(&path, "general", serde_json::json!({"x": 1})),
            "an unparseable file must refuse the write, not report success"
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            broken,
            "the bytes on disk must be untouched so the user can still recover them"
        );
    }

    #[test]
    fn a_non_object_root_is_left_alone() {
        let path = scratch("array-root");
        std::fs::write(&path, "[1, 2, 3]").unwrap();

        assert!(!patch_settings_at(&path, "general", serde_json::json!({})));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "[1, 2, 3]");
    }

    #[test]
    fn a_missing_file_is_created_from_scratch() {
        let path = scratch("absent");
        // Fresh install: no file yet. This must still work, otherwise the very
        // first save would be refused.
        assert!(!path.exists());
        assert!(patch_settings_at(
            &path,
            "general",
            serde_json::json!({"acpModel": "first"})
        ));

        let after: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(after["general"]["acpModel"], "first");
    }

    #[test]
    fn a_blank_file_counts_as_empty_not_broken() {
        let path = scratch("blank");
        // An interrupted write can leave a zero-length or whitespace-only file.
        // Refusing here would lock the user out of their own settings panel.
        std::fs::write(&path, "   \r\n").unwrap();
        assert!(patch_settings_at(&path, "general", serde_json::json!({"a": 1})));
        let after: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(after["general"]["a"], 1);
    }

    #[test]
    fn reading_a_key_from_a_broken_file_yields_null_not_a_wrong_value() {
        let path = scratch("broken-read");
        std::fs::write(&path, "{oops").unwrap();
        assert_eq!(read_settings_key_at(&path, "general"), serde_json::Value::Null);
    }

    // ─── Round-trip ─────────────────────────────────────────────────────────

    #[test]
    fn patching_preserves_unknown_sibling_keys() {
        let path = scratch("unknown-keys");
        // Keys this kernel does not model at all. Both kernels share one
        // settings.json, so dropping them would delete configuration made
        // through the Java kernel.
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&serde_json::json!({
                "lspServers": {"rust": {"command": "rust-analyzer"}},
                "intentChainEnabled": true,
                "general": {"acpModel": "old"}
            }))
            .unwrap(),
        )
        .unwrap();

        assert!(patch_settings_at(
            &path,
            "general",
            serde_json::json!({"acpModel": "new"})
        ));

        let after: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(after["lspServers"]["rust"]["command"], "rust-analyzer");
        assert_eq!(after["intentChainEnabled"], true);
        assert_eq!(after["general"]["acpModel"], "new");
    }

    #[test]
    fn the_write_refusal_answer_is_not_a_success_code() {
        // The UI keys off `code`; a 200 here would show "saved" for a write that
        // never happened and the value would silently revert on restart.
        let answer = settings_write_failed();
        assert_eq!(answer["code"], 500);
        assert!(answer["msg"].as_str().is_some_and(|m| !m.is_empty()));
    }

    // ─── Provider model fetch (the "empty model list" regression) ───────────

    /// Chat appends `/v1/...` to a bare host; the settings port appended only
    /// `/models`. Both must be tried, canonical first, so the API URL that
    /// already works in chat also works when adding a provider.
    #[test]
    fn bare_base_url_tries_the_v1_models_endpoint_first() {
        assert_eq!(
            model_list_urls("https://www.gourd-ai.cn", "openai"),
            vec![
                "https://www.gourd-ai.cn/v1/models",
                "https://www.gourd-ai.cn/models"
            ]
        );
    }

    #[test]
    fn a_base_that_already_names_v1_is_not_double_prefixed() {
        assert_eq!(
            model_list_urls("https://www.gourd-ai.cn/v1/", "openai"),
            vec!["https://www.gourd-ai.cn/v1/models"]
        );
    }

    #[test]
    fn a_full_models_url_is_used_verbatim() {
        assert_eq!(
            model_list_urls("https://host/v1/models", "anthropic"),
            vec!["https://host/v1/models"]
        );
    }

    #[test]
    fn ollama_and_gemini_use_their_own_model_endpoints() {
        assert_eq!(
            model_list_urls("http://127.0.0.1:11434", "ollama"),
            vec!["http://127.0.0.1:11434/api/tags"]
        );
        assert_eq!(
            model_list_urls("https://host/v1beta", "gemini"),
            vec!["https://host/v1beta/models"]
        );
    }

    /// The exact payload observed from `https://api.aionly.com/models` when the
    /// Rust kernel hit the bare path: HTTP 200 with an auth error and `data:null`.
    /// Returning "zero models" for it is the reported bug.
    #[test]
    fn an_http_200_error_object_is_not_an_empty_model_list() {
        let payload = serde_json::json!({"code": 401, "msg": "token 无效", "data": null});
        assert!(model_list_items(&payload, "openai").is_none());
    }

    #[test]
    fn a_real_empty_data_array_is_still_an_empty_list() {
        let payload = serde_json::json!({"object": "list", "data": []});
        assert_eq!(model_list_items(&payload, "openai").unwrap().len(), 0);
    }

    #[test]
    fn model_standard_follows_supported_endpoint_types() {
        let item = serde_json::json!({"id": "claude-x", "supported_endpoint_types": ["anthropic"]});
        assert_eq!(infer_model_standard(&item, "openai"), "anthropic");
        let item = serde_json::json!({"id": "gpt-x"});
        assert_eq!(infer_model_standard(&item, "openai"), "openai");
        let item = serde_json::json!({"id": "claude-y"});
        assert_eq!(infer_model_standard(&item, "anthropic"), "anthropic");
    }

    /// Gemini lists models as `{"name":"models/gemini-x"}`. The chat Dialect
    /// builds `{root}/models/{model}:generateContent`, so the fetch result must
    /// strip the prefix or chat hits `/models/models/gemini-x:...` and 404s.
    #[tokio::test]
    async fn gemini_model_ids_are_stripped_of_the_models_prefix() {
        let mut routes = std::collections::HashMap::new();
        routes.insert(
            "/v1beta/models".to_string(),
            (200, r#"{"models":[{"name":"models/gemini-2.5-pro"},{"name":"models/gemini-2.5-flash"}]}"#.to_string()),
        );
        let base = spawn_models_mock(routes).await;

        let mut body = fetch_body(base);
        body.standard = "gemini".to_string();
        let res = providers_fetch(Form(body)).await.0;
        assert_eq!(res["code"], 200, "{}", res);
        assert_eq!(res["data"][0]["id"], "gemini-2.5-pro");
        assert_eq!(res["data"][0]["standard"], "gemini");
        assert_eq!(res["data"][1]["id"], "gemini-2.5-flash");
    }

    /// The UI's `FETCH_REASON_KEYS` only knows Java's enum names. The Rust port
    /// used UNAUTHORIZED/NOT_FOUND/HTTP_ERROR and every failure rendered as the
    /// generic "unknown" toast.
    #[test]
    fn fetch_failure_reasons_match_the_ui_contract() {
        assert_eq!(http_fetch_reason(401), "AUTH_FAILED");
        assert_eq!(http_fetch_reason(404), "NOT_SUPPORTED");
        assert_eq!(http_fetch_reason(429), "RATE_LIMITED");
        assert_eq!(http_fetch_reason(500), "UPSTREAM_ERROR");
        let answer = fetch_fail("AUTH_FAILED", 401, None);
        assert_eq!(answer["code"], 400, "a fetch failure must never be a 200");
        assert_eq!(answer["data"]["reason"], "AUTH_FAILED");
        assert_eq!(answer["data"]["status"], 401);
    }

    /// Minimal HTTP server: path → (status, body). Every response closes the
    /// connection so reqwest opens a fresh one for the next candidate URL.
    async fn spawn_models_mock(
        routes: std::collections::HashMap<String, (u16, String)>,
    ) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let mut buf = [0u8; 4096];
                let n = match tokio::time::timeout(
                    std::time::Duration::from_secs(2),
                    sock.read(&mut buf),
                )
                .await
                {
                    Ok(Ok(n)) => n,
                    _ => 0,
                };
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                let (status, body) = routes
                    .get(&path)
                    .cloned()
                    .unwrap_or((404, "{}".to_string()));
                let label = if status == 200 { "OK" } else { "Error" };
                let resp = format!(
                    "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    status, label, body.len(), body
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        format!("http://127.0.0.1:{}", port)
    }

    fn fetch_body(api_url: String) -> ProviderFetchBody {
        ProviderFetchBody {
            api_url,
            api_key: "sk-test".to_string(),
            standard: "openai".to_string(),
            provider_name: String::new(),
        }
    }

    /// Exact reproduction of the report: the bare `/models` is a website route
    /// that answers 200 with an auth error, while `/v1/models` is the real API.
    /// The Rust port used to hit only the bare path and returned "zero models".
    #[tokio::test]
    async fn fetch_hits_v1_models_instead_of_the_bare_website_route() {
        let mut routes = std::collections::HashMap::new();
        routes.insert(
            "/models".to_string(),
            (200, r#"{"code":401,"msg":"token 无效","data":null}"#.to_string()),
        );
        routes.insert(
            "/v1/models".to_string(),
            (200, r#"{"data":[{"id":"gpt-4o","owned_by":"openai"}]}"#.to_string()),
        );
        let base = spawn_models_mock(routes).await;

        let res = providers_fetch(Form(fetch_body(base))).await.0;
        assert_eq!(res["code"], 200, "{}", res);
        assert_eq!(res["data"][0]["id"], "gpt-4o");
    }

    /// A provider that really serves the list at the root still works: the
    /// canonical path failing must not break it.
    #[tokio::test]
    async fn fetch_falls_back_to_root_models_for_root_only_providers() {
        let mut routes = std::collections::HashMap::new();
        routes.insert("/v1/models".to_string(), (404, "{}".to_string()));
        routes.insert(
            "/models".to_string(),
            (200, r#"{"data":[{"id":"root-model"}]}"#.to_string()),
        );
        let base = spawn_models_mock(routes).await;

        let res = providers_fetch(Form(fetch_body(base))).await.0;
        assert_eq!(res["code"], 200, "{}", res);
        assert_eq!(res["data"][0]["id"], "root-model");
    }

    /// The regression that mattered most: a 200 error body must never be
    /// reported as a successful empty model list.
    #[tokio::test]
    async fn fetch_never_reports_an_error_body_as_an_empty_model_list() {
        let mut routes = std::collections::HashMap::new();
        let bad = r#"{"code":401,"msg":"token 无效","data":null}"#.to_string();
        routes.insert("/models".to_string(), (200, bad.clone()));
        routes.insert("/v1/models".to_string(), (200, bad));
        let base = spawn_models_mock(routes).await;

        let res = providers_fetch(Form(fetch_body(base))).await.0;
        assert_eq!(res["code"], 400, "{}", res);
        assert_eq!(res["data"]["reason"], "INVALID_RESPONSE");
        assert!(res["data"]["detail"].as_str().is_some());
    }

    #[test]
    fn a_failed_write_is_reported_rather_than_claimed_as_saved() {
        // Parsing fine but *writing* impossible is its own failure mode: a
        // read-only file, a full disk, a revoked ACL. Reporting success there is
        // the same false success as the parse case — the panel says "saved"
        // while disk still holds the old value.
        let path = scratch("write-denied");
        std::fs::write(&path, populated()).unwrap();

        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&path, perms).unwrap();

        // Guard against a vacuous assertion: if this platform lets the write
        // through, the test below would prove nothing, so skip instead of
        // passing for the wrong reason.
        let writable_anyway = std::fs::write(&path, "probe").is_ok();
        if !writable_anyway {
            assert!(
                !patch_settings_at(&path, "general", serde_json::json!({"a": 1})),
                "a write that did not land must return false"
            );
        }

        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_readonly(false);
        let _ = std::fs::set_permissions(&path, perms);
    }
}
