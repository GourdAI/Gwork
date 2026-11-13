//! `mcp::auth` — product-level connector authentication.
//!
//! `mcp::oauth` is a *protocol* library: it implements RFC 9728 / 8414 / 7636 /
//! 7591 / 6749 / 8252 / 8707 as independent hops and deliberately refuses to
//! compose them (see its module docs: "the browser is the caller's problem").
//! This module is that caller. It owns the three things the product actually
//! needs:
//!
//! 1. **An auth declaration on each connector** (`AuthSpec`): `none`, `token`
//!    (user types a static Bearer/API key into a dialog), or `oauth` (browser
//!    login). Stored in `settings.json` — it is configuration, not a secret.
//! 2. **A local-only credential file** (`<home>/.gwork/mcp-credentials.json`).
//!    Secrets never go into `settings.json`: that file is shared with the Java
//!    kernel, is frequently copied/exported, and is pretty-printed. OAuth
//!    tokens live here as `StoredCredentials`; static tokens live here as a
//!    separate map. The file is only ever written by this process.
//! 3. **An authorization session** (`AuthManager::start`): discovery →
//!    PKCE → dynamic client registration → build the authorization URL → wait
//!    on the loopback callback → exchange the code → persist the credential.
//!    The HTTP API returns the URL to the UI, which opens it in the system
//!    browser via the shell's existing `window.open` → `on_new_window` hook.
//!    `status` polls; `cancel` aborts the background task.
//!
//! ## Why the browser URL is returned, not opened here
//!
//! The kernel is a headless HTTP server. It may be driving a Tauri window, a
//! terminal, a remote browser, or CI. Opening a browser from inside the kernel
//! would break the remote/deployed case and bypass the shell's
//! `external_link::is_external_openable` http(s) guard. The UI is the only
//! component that knows how to present a URL, so it owns that step.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use super::oauth::{self, CredentialStore, StoredCredentials};
use super::McpServerConfig;

/// How a connector obtains its credential.
///
/// Stored in `settings.json` under `authType`. Absent / unknown = `None`, i.e.
/// exactly the pre-existing behaviour (static `headers`/`env` only).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AuthKind {
    /// No special handling. The old behaviour: headers/env carry whatever they carry.
    #[default]
    None,
    /// User types a static token into a password dialog; we persist it locally
    /// and inject it as `Authorization` (or a configured header) on requests.
    Token,
    /// OAuth 2.1 authorization-code + PKCE with a browser redirect.
    Oauth,
}

impl AuthKind {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "token" | "static" | "apikey" | "api_key" => AuthKind::Token,
            "oauth" | "oauth2" | "browser" | "login" => AuthKind::Oauth,
            _ => AuthKind::None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            AuthKind::None => "none",
            AuthKind::Token => "token",
            AuthKind::Oauth => "oauth",
        }
    }
}

/// Non-secret metadata describing how to render the "connect" UI for a server.
///
/// All fields are metadata, never credentials. They come from the connector
/// catalog (or are typed by the user in the manual-add form).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuthSpec {
    /// `none` | `token` | `oauth`.
    ///
    /// camelCase on the wire: settings.json uses `authType` (and the connector
    /// catalog uses the same spelling), while the Rust field stays snake_case.
    #[serde(rename = "authType", alias = "auth_type", default)]
    pub auth_type: String,
    /// Human label for the token field, e.g. `D&B Access Token`.
    #[serde(default)]
    pub token_label: String,
    /// Where the user obtains a token (a URL shown as a link in the dialog).
    #[serde(default)]
    pub token_help_url: String,
    /// Explanatory sentence under the input, e.g. "仅存储在本机，不会上传云端".
    #[serde(default)]
    pub token_help_text: String,
    /// Header to inject the static token into. Default `Authorization`.
    #[serde(default)]
    pub token_header: String,
    /// Prefix for the static header value. Default `Bearer `.
    #[serde(default)]
    pub token_prefix: String,
    /// Pre-registered OAuth client id (avoids DCR). Empty = try DCR.
    #[serde(default)]
    pub client_id: String,
    /// Explicit scopes, overriding metadata negotiation.
    #[serde(default)]
    pub scopes: Vec<String>,
    /// RFC 8628 Device Authorization Grant. When `true`, `/auth/device/start`
    /// is used instead of opening a browser: the UI shows `user_code` +
    /// `verification_uri` and polls the token endpoint itself.
    #[serde(default)]
    pub auth_device_flow: bool,
    /// WorkBuddy-compatible `authQrModal`: instead of opening the system
    /// browser, render the authorization URL in an in-app iframe modal (the
    /// URL itself is the third-party QR-code page, e.g. WeCom QR login).
    /// Only honoured for the browser OAuth kind, and only over https.
    #[serde(default)]
    pub auth_qr_modal: bool,
    /// Explicit `device_authorization_endpoint` override. Empty = read it from
    /// RFC 8414 metadata (`device_authorization_endpoint`).
    #[serde(default)]
    pub device_authorization_endpoint: String,
    /// Polling interval in seconds for the Device Flow (RFC 8628 §3.5).
    ///
    /// Clamped to `[1, 60]`, then combined with the AS's own `interval` using
    /// `max` — a local override may only make polling **slower** than the server
    /// demands, never faster. See `start_device` for why that matters when this
    /// value is remotely supplied via the connector catalog.
    #[serde(default)]
    pub device_poll_interval_secs: u64,
}

impl AuthSpec {
    pub fn kind(&self) -> AuthKind {
        AuthKind::parse(&self.auth_type)
    }

    /// Read an auth declaration from a settings.json entry.
    ///
    /// Tolerates both the nested `auth` object (preferred) and the flat legacy
    /// `authType` spelling, so a config written by an older build still works.
    pub fn from_entry(entry: &serde_json::Value) -> Self {
        let nested = entry.get("auth").filter(|v| v.is_object());
        let source = nested.unwrap_or(entry);
        let mut spec: AuthSpec = serde_json::from_value(source.clone()).unwrap_or_default();
        if spec.auth_type.trim().is_empty() {
            spec.auth_type = entry
                .get("authType")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
        }
        spec
    }

    /// Read the declaration from a deserialized [`McpServerConfig`].
    ///
    /// `auth` is kept as a raw `Value` on the config so an unknown catalog
    /// field survives a settings round-trip instead of being dropped.
    pub fn from_config(config: &McpServerConfig) -> Self {
        let nested = config.auth.is_object().then(|| config.auth.clone());
        let entry = nested.unwrap_or_else(|| {
            serde_json::json!({ "authType": config.auth_type })
        });
        let mut spec = Self::from_entry(&entry);
        if spec.auth_type.trim().is_empty() {
            spec.auth_type = config.auth_type.clone();
        }
        spec
    }

    pub fn header_name(&self) -> String {
        let h = self.token_header.trim();
        if h.is_empty() { "Authorization".to_string() } else { h.to_string() }
    }

    pub fn prefix(&self) -> String {
        // An explicitly empty string is a legitimate "no prefix" choice, but
        // serde cannot distinguish "absent" from "empty" here, so we use the
        // sentinel `none` for that and default everything else to `Bearer `.
        match self.token_prefix.trim().to_ascii_lowercase().as_str() {
            "none" | "raw" => String::new(),
            "" => "Bearer ".to_string(),
            _ => format!("{} ", self.token_prefix.trim_matches(|c: char| c.is_whitespace())),
        }
    }
}

/// One static token, as stored in the credential file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StaticToken {
    /// The value the user typed. Never returned to the UI after saving.
    pub value: String,
    /// Which header it is injected into.
    pub header: String,
    /// Prefix used when injecting.
    pub prefix: String,
    #[serde(default)]
    pub stored_at: i64,
}

/// On-disk shape of `<home>/.gwork/mcp-credentials.json`.
///
/// One file for both kinds so "list authorized servers" is a single read and
/// the UI can show one state per connector. Keys are canonical server URLs via
/// [`oauth::credential_key`].
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct CredentialFile {
    /// OAuth credentials (access/refresh tokens, endpoints, client identity).
    #[serde(default)]
    oauth: HashMap<String, StoredCredentials>,
    /// Static tokens typed by the user.
    #[serde(default)]
    static_tokens: HashMap<String, StaticToken>,
}

/// Read/modify/write the credential file under an async lock.
///
/// The file lives outside `settings.json` on purpose: settings is shared with
/// the Java kernel and is routinely exported/copied, while this file contains
/// live credentials. Writes are atomic (temp + rename) so a crash cannot leave
/// a truncated file that logs every connector out at once.
#[derive(Debug, Clone)]
pub struct CredentialVault {
    path: PathBuf,
    lock: Arc<Mutex<()>>,
}

impl CredentialVault {
    /// The single production instance, rooted at the harness base so
    /// `GWORK_HOME` / `--home` overrides are honoured (same root as settings).
    pub fn at_home() -> Self {
        Self::new(crate::config::Settings::gwork_home().join("mcp-credentials.json"))
    }

    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into(), lock: Arc::new(Mutex::new(())) }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Read the whole document.
    ///
    /// A **corrupt** file is an error, never an empty vault. Falling back to
    /// `CredentialFile::default()` on a parse failure was a silent data-loss bug:
    /// the read path reported "no credentials" (every connector looks logged
    /// out), and then the next `set_static` / `save` did read → insert → write
    /// over an empty base, so one damaged byte erased *every other connector's*
    /// access and refresh tokens. `oauth::FileCredentialStore` documents the
    /// same rule for the same reason; this vault is the store production
    /// actually uses, so it must hold it too.
    async fn read(&self) -> anyhow::Result<CredentialFile> {
        let text = match tokio::fs::read_to_string(&self.path).await {
            Ok(s) => s,
            // Not-present is the normal first-run state, not an error.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(CredentialFile::default()),
            Err(e) => return Err(anyhow::anyhow!("cannot read {}: {}", self.path.display(), e)),
        };
        if text.trim().is_empty() {
            return Ok(CredentialFile::default());
        }
        serde_json::from_str(&text).map_err(|e| {
            // Logged loudly here rather than only returned: the read path
            // (`get_static`) degrades to `None`, so without this the user would
            // see connectors silently logged out with nothing in the log
            // pointing at a damaged credential file.
            tracing::error!(
                path = %self.path.display(),
                error = %e,
                "MCP credential file is corrupt; refusing to treat it as empty. \
                 All connectors will read as unauthorized until it is repaired or removed."
            );
            anyhow::anyhow!(
                "凭据文件 {} 已损坏，已拒绝将其视为空文件（避免静默清空其它连接器的凭据）：{}",
                self.path.display(),
                e
            )
        })
    }

    async fn write(&self, file: &CredentialFile) -> anyhow::Result<()> {
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent).await?;
            restrict_directory(parent);
        }
        let text = serde_json::to_string_pretty(file)?;
        let tmp = self.path.with_extension("json.tmp");
        tokio::fs::write(&tmp, text).await?;
        // Tighten permissions *before* the file holds anything readable by
        // others, then move it into place.
        restrict_file(&tmp);
        // Plain `rename` overwrites an existing target on Windows too: Rust's
        // `std`/`tokio` use `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`
        // (verified on Windows 11 — `tokio::fs::rename` onto an existing file
        // returns `Ok`). Deleting the destination first was not only
        // unnecessary, it opened a real data-loss window: a crash between
        // `remove_file` and `rename` left *no* credential file at all, wiping
        // every connector. One atomic move, matching `oauth::FileCredentialStore`.
        tokio::fs::rename(&tmp, &self.path).await.map_err(|e| {
            // Clean up so a failed rename does not leave a stray copy of the
            // tokens next to the real file.
            let _ = std::fs::remove_file(&tmp);
            anyhow::anyhow!("cannot install credential file {}: {}", self.path.display(), e)
        })?;
        restrict_file(&self.path);
        Ok(())
    }

    pub async fn get_static(&self, server_url: &str) -> Option<StaticToken> {
        let key = oauth::credential_key(server_url);
        let _g = self.lock.lock().await;
        self.read().await.ok()?.static_tokens.get(&key).cloned()
    }

    pub async fn set_static(&self, server_url: &str, token: StaticToken) -> anyhow::Result<()> {
        let key = oauth::credential_key(server_url);
        let _g = self.lock.lock().await;
        let mut file = self.read().await?;
        file.static_tokens.insert(key, token);
        self.write(&file).await
    }

    pub async fn clear_static(&self, server_url: &str) -> anyhow::Result<()> {
        let key = oauth::credential_key(server_url);
        let _g = self.lock.lock().await;
        let mut file = self.read().await?;
        file.static_tokens.remove(&key);
        self.write(&file).await
    }

    pub async fn has_oauth(&self, server_url: &str) -> bool {
        let key = oauth::credential_key(server_url);
        let _g = self.lock.lock().await;
        self.read().await.ok().and_then(|f| f.oauth.get(&key).cloned()).is_some()
    }

    /// Clear every credential for one server (used by "disconnect"/logout).
    pub async fn clear_all(&self, server_url: &str) -> anyhow::Result<()> {
        let key = oauth::credential_key(server_url);
        let _g = self.lock.lock().await;
        let mut file = self.read().await?;
        file.oauth.remove(&key);
        file.static_tokens.remove(&key);
        self.write(&file).await
    }

    pub async fn list_keys(&self) -> Vec<String> {
        let _g = self.lock.lock().await;
        let Ok(file) = self.read().await else { return Vec::new() };
        let mut keys: Vec<String> = file.oauth.keys().chain(file.static_tokens.keys()).cloned().collect();
        keys.sort();
        keys.dedup();
        keys
    }
}

/// The vault is also the `CredentialStore` used by `oauth::bearer_header_for`.
///
/// This is deliberately implemented *here* rather than reusing
/// `oauth::FileCredentialStore`: that class writes a bare
/// `HashMap<String, StoredCredentials>` to whatever path it is given, which
/// would overwrite the `static_tokens` half of the same file. One owner, one
/// format, one lock — otherwise a token-typed credential could be silently
/// erased by an OAuth refresh.
#[async_trait::async_trait]
impl CredentialStore for CredentialVault {
    async fn load(&self, server_url: &str) -> anyhow::Result<Option<StoredCredentials>> {
        let key = oauth::credential_key(server_url);
        let _g = self.lock.lock().await;
        Ok(self.read().await?.oauth.get(&key).cloned())
    }

    async fn save(&self, server_url: &str, credentials: &StoredCredentials) -> anyhow::Result<()> {
        let key = oauth::credential_key(server_url);
        let _g = self.lock.lock().await;
        let mut file = self.read().await?;
        file.oauth.insert(key, credentials.clone());
        self.write(&file).await
    }

    async fn clear(&self, server_url: &str) -> anyhow::Result<()> {
        let key = oauth::credential_key(server_url);
        let _g = self.lock.lock().await;
        let mut file = self.read().await?;
        file.oauth.remove(&key);
        self.write(&file).await
    }

    async fn list(&self) -> anyhow::Result<Vec<String>> {
        let _g = self.lock.lock().await;
        let mut keys: Vec<String> = self.read().await?.oauth.keys().cloned().collect();
        keys.sort();
        Ok(keys)
    }
}

/// Unix: credentials must not be world-readable. Windows inherits the
/// `%USERPROFILE%\.gwork` ACL; see the note in `oauth.rs` about DACLs.
#[cfg(unix)]
fn restrict_file(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}
#[cfg(not(unix))]
fn restrict_file(_path: &Path) {}

#[cfg(unix)]
fn restrict_directory(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
}
#[cfg(not(unix))]
fn restrict_directory(_path: &Path) {}

/* ───────────────────────── Authorization sessions ───────────────────────── */

/// What the UI polls for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthPhase {
    /// Discovery / registration in progress; no URL yet.
    Preparing,
    /// `authorization_url` is ready — open it in the system browser.
    WaitingForBrowser,
    /// Callback arrived, exchanging the code for tokens.
    Exchanging,
    /// Credential saved; the caller can now reconnect the MCP server.
    Done,
    /// User denied, timed out, or a protocol error occurred.
    Failed,
    /// `cancel` was called.
    Cancelled,
}

impl AuthPhase {
    pub fn is_terminal(self) -> bool {
        matches!(self, AuthPhase::Done | AuthPhase::Failed | AuthPhase::Cancelled)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthStatus {
    pub phase: AuthPhase,
    /// Present once `WaitingForBrowser`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authorization_url: Option<String>,
    /// Human-readable reason for `Failed`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// RFC 8628 Device Flow: the code the user must confirm on a second device.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_code: Option<String>,
    /// RFC 8628 `verification_uri` (or `verification_uri_complete` when present).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_uri: Option<String>,
    /// Seconds remaining before the device code expires (best-effort, for UI).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_in: Option<u64>,
    /// Server name this session belongs to.
    pub name: String,
    /// Epoch seconds when the session was created (for stale-session sweep).
    pub started_at: i64,
}

struct Session {
    status: AuthStatus,
    handle: Option<tokio::task::JoinHandle<()>>,
}

/// Owns in-flight authorization flows, keyed by connector name.
///
/// Held on `AppState` so the HTTP API can start/poll/cancel across requests.
/// One session per name: starting again aborts the previous one, which both
/// releases its loopback port and prevents two browsers racing on one state.
pub struct AuthManager {
    sessions: Mutex<HashMap<String, Session>>,
    vault: CredentialVault,
}

impl AuthManager {
    pub fn new(vault: CredentialVault) -> Self {
        Self { sessions: Mutex::new(HashMap::new()), vault }
    }

    pub fn vault(&self) -> &CredentialVault {
        &self.vault
    }

    /// Build the authorization URL and start waiting for the callback.
    ///
    /// Returns the URL synchronously (before returning from the HTTP handler)
    /// so the UI can open the browser immediately; the code exchange and token
    /// persistence continue in the spawned task.
    pub async fn start(
        self: &Arc<Self>,
        name: &str,
        config: &McpServerConfig,
        spec: &AuthSpec,
    ) -> anyhow::Result<String> {
        let server_url = config.url.trim().to_string();
        if server_url.is_empty() {
            anyhow::bail!("this connector has no URL; OAuth authorization only applies to HTTP-family MCP servers");
        }

        // Abort a previous attempt for the same connector first.
        self.abort(name).await;

        let client = oauth::OAuthClient::new(config)?;
        let challenge = oauth::classify_401(None);
        let resource = oauth::resource_indicator(&server_url).unwrap_or_else(|| server_url.clone());

        // RFC 9728 → RFC 8414. Both hops go through the clean OAuth client,
        // never the MCP client carrying the user's static headers.
        let prm = oauth::fetch_protected_resource_metadata(&client, &server_url, &resource, &challenge).await?;
        let issuer = oauth::primary_authorization_server(&prm, &server_url)
            .ok_or_else(|| anyhow::anyhow!("the protected-resource metadata names no authorization server"))?;
        let meta = oauth::fetch_authorization_server_metadata(&client, &issuer).await?;
        let missing = meta.missing_required_endpoints();
        if !missing.is_empty() {
            anyhow::bail!("authorization server metadata is missing: {}", missing.join(", "));
        }
        // Refuse an AS that cannot do S256 rather than silently downgrading.
        oauth::select_pkce_method(&meta.code_challenge_methods_supported)?;

        let scopes = oauth::negotiate_scopes(&prm.scopes_supported, &meta.scopes_supported, &spec.scopes);
        let pkce = oauth::PkcePair::generate();
        let listener = oauth::RedirectListener::bind()?;
        let redirect_uri = listener.redirect_uri();

        // RFC 7591 dynamic registration, unless the connector ships a client id.
        let registration = if spec.client_id.trim().is_empty() {
            oauth::register_client(&client, &meta, &[redirect_uri.clone()], &scopes, name).await?
        } else {
            oauth::ClientRegistration {
                client_id: spec.client_id.trim().to_string(),
                client_secret: None,
                token_endpoint_auth_method: "none".to_string(),
                redirect_uris: vec![redirect_uri.clone()],
                registration_access_token: None,
                registration_client_uri: None,
                scope: scopes.clone(),
                source: oauth::ClientSource::Configured,
            }
        };

        let authorization_url = build_authorization_url(
            meta.authorization_endpoint.as_deref().unwrap_or(""),
            &registration.client_id,
            &redirect_uri,
            &pkce,
            &scopes,
            Some(resource.as_str()),
        )?;

        let now = oauth::Clock::system().now();
        let status = AuthStatus {
            phase: AuthPhase::WaitingForBrowser,
            authorization_url: Some(authorization_url.clone()),
            error: None,
            user_code: None,
            verification_uri: None,
            expires_in: None,
            name: name.to_string(),
            started_at: now,
        };

        let store: Arc<dyn CredentialStore> = Arc::new(self.vault.clone());
        let name_owned = name.to_string();
        let mgr = Arc::clone(self);
        let phase_mgr = Arc::clone(&mgr);
        let phase_name = name_owned.clone();
        // Resolve the budget before spawning: the task must own every value it
        // uses, so it cannot borrow `config` (or any other caller stack frame).
        let timeout = Duration::from_secs(
            config.timeout_for(super::TimeoutPhase::Auth).as_secs().max(60).min(600),
        );
        let handle = tokio::spawn(async move {
            let outcome = complete_flow(
                &client,
                listener,
                &pkce,
                &registration,
                &redirect_uri,
                meta.token_endpoint.as_deref().unwrap_or(""),
                Some(resource.as_str()),
                &server_url,
                &issuer,
                &meta,
                store.as_ref(),
                timeout,
                move || {
                    // `try_lock`: the mutex is held only microseconds by status
                    // polls, and a missed phase update is cosmetic — `finish`
                    // still sets Done/Failed, so correctness never depends on it.
                    if let Ok(mut sessions) = phase_mgr.sessions.try_lock() {
                        if let Some(s) = sessions.get_mut(&phase_name) {
                            s.status.phase = AuthPhase::Exchanging;
                        }
                    }
                },
            )
            .await;
            mgr.finish(&name_owned, outcome).await;
        });

        let mut sessions = self.sessions.lock().await;
        sessions.insert(name.to_string(), Session { status, handle: Some(handle) });
        Ok(authorization_url)
    }

    /// Start an RFC 8628 Device Authorization Grant.
    ///
    /// Unlike [`Self::start`], no browser is opened and no loopback listener is
    /// bound: the UI shows `user_code` + `verification_uri` (often rendered as a
    /// QR code) and the background task polls the token endpoint itself. Both
    /// flows share the same session table, so `status` / `cancel` work unchanged.
    /// `transient_budget` is how many consecutive transient poll failures to
    /// tolerate before giving up. It comes from the user's **「MCP 重试次数」**
    /// setting (`settings.general.mcp_retries`, default 3, clamped `[1,10]`) so
    /// the connector-authorisation path honours the same knob the rest of the
    /// MCP retry logic does — hardcoding a second number here would silently
    /// diverge from a setting the user can see and change.
    pub async fn start_device(
        self: &Arc<Self>,
        name: &str,
        config: &McpServerConfig,
        spec: &AuthSpec,
        transient_budget: u32,
    ) -> anyhow::Result<AuthStatus> {
        let server_url = config.url.trim().to_string();
        if server_url.is_empty() {
            anyhow::bail!("this connector has no URL; Device Flow authorization only applies to HTTP-family MCP servers");
        }
        self.abort(name).await;

        let client = oauth::OAuthClient::new(config)?;
        let challenge = oauth::classify_401(None);
        let resource = oauth::resource_indicator(&server_url).unwrap_or_else(|| server_url.clone());
        let prm = oauth::fetch_protected_resource_metadata(&client, &server_url, &resource, &challenge).await?;
        let issuer = oauth::primary_authorization_server(&prm, &server_url)
            .ok_or_else(|| anyhow::anyhow!("the protected-resource metadata names no authorization server"))?;
        let meta = oauth::fetch_authorization_server_metadata(&client, &issuer).await?;

        // Device Flow needs a device endpoint + token endpoint, but NOT an
        // authorization_endpoint (that is what this grant exists to avoid).
        let device_endpoint = if spec.device_authorization_endpoint.trim().is_empty() {
            meta.device_authorization_endpoint.clone().unwrap_or_default()
        } else {
            spec.device_authorization_endpoint.trim().to_string()
        };
        if device_endpoint.trim().is_empty() {
            anyhow::bail!("the authorization server does not publish a `device_authorization_endpoint`");
        }
        let token_endpoint = meta.token_endpoint.clone().unwrap_or_default();
        if token_endpoint.trim().is_empty() {
            anyhow::bail!("the authorization server does not publish a `token_endpoint`");
        }
        if !device_endpoint_is_allowed(&device_endpoint) {
            anyhow::bail!(
                "device_authorization_endpoint must be https (or http to a loopback host); got {:?}",
                device_endpoint
            );
        }

        let scopes = oauth::negotiate_scopes(&prm.scopes_supported, &meta.scopes_supported, &spec.scopes);
        let registration = if spec.client_id.trim().is_empty() {
            oauth::register_device_client(&client, &meta, &scopes, name).await?
        } else {
            oauth::ClientRegistration {
                client_id: spec.client_id.trim().to_string(),
                client_secret: None,
                token_endpoint_auth_method: "none".to_string(),
                redirect_uris: Vec::new(),
                registration_access_token: None,
                registration_client_uri: None,
                scope: scopes.clone(),
                source: oauth::ClientSource::Configured,
            }
        };

        let device = oauth::request_device_code(&client, &device_endpoint, &registration, &scopes).await?;
        let now = oauth::Clock::system().now();
        let status = AuthStatus {
            phase: AuthPhase::WaitingForBrowser,
            authorization_url: None,
            error: None,
            user_code: Some(device.user_code.clone()),
            verification_uri: Some(if device.verification_uri_complete.trim().is_empty() {
                device.verification_uri.clone()
            } else {
                device.verification_uri_complete.clone()
            }),
            expires_in: Some(device.expires_in_secs()),
            name: name.to_string(),
            started_at: now,
        };

        let store: Arc<dyn CredentialStore> = Arc::new(self.vault.clone());
        let name_owned = name.to_string();
        let mgr = Arc::clone(self);
        // RFC 8628 §3.2: the AS's `interval` is the *minimum* poll interval it
        // demands — a server-side rate constraint. A local override may make
        // polling **slower** than that but never faster, so the two are combined
        // with `max` rather than the local value simply winning.
        //
        // This matters beyond politeness: `devicePollIntervalSecs` is part of the
        // auth declaration that `mcp_market_api::normalize_server_config` passes
        // through from the connector catalog, i.e. it is **remotely supplied**.
        // Letting it override the server meant a hostile (or merely misconfigured)
        // catalog entry could pin `"devicePollIntervalSecs": 1` and turn this app
        // into a 1 RPS hammer against a third-party authorization server that
        // asked for 30s — for the full `expires_in`, up to an hour.
        //
        // The previous code did the opposite of what this field's own doc comment
        // promised ("the server's own `interval` wins when present").
        let poll_base = oauth::resolve_poll_interval(
            spec.device_poll_interval_secs,
            device.poll_interval_secs(),
        );
        let handle = tokio::spawn(async move {
            let outcome = complete_device_flow(
                &client, &token_endpoint, &registration, &device,
                &server_url, &issuer, &meta, store.as_ref(), poll_base, transient_budget,
            ).await;
            mgr.finish(&name_owned, outcome).await;
        });

        let mut sessions = self.sessions.lock().await;
        sessions.insert(name.to_string(), Session { status: status.clone(), handle: Some(handle) });
        Ok(status)
    }

    /// Current status for a connector. Terminal states are kept until polled
    /// once (the UI shows the result), then removed on the next poll.
    pub async fn status(&self, name: &str) -> Option<AuthStatus> {
        let mut sessions = self.sessions.lock().await;
        let s = sessions.get(name)?;
        let out = s.status.clone();
        if out.phase.is_terminal() {
            sessions.remove(name);
        }
        Some(out)
    }

    /// Cancel an in-flight flow. Aborting the task drops `RedirectListener`,
    /// which closes the loopback socket immediately.
    pub async fn cancel(&self, name: &str) -> bool {
        let mut sessions = self.sessions.lock().await;
        let Some(mut s) = sessions.remove(name) else { return false };
        if let Some(h) = s.handle.take() {
            h.abort();
        }
        s.status.phase = AuthPhase::Cancelled;
        true
    }

    async fn abort(&self, name: &str) {
        let mut sessions = self.sessions.lock().await;
        if let Some(mut s) = sessions.remove(name) {
            if let Some(h) = s.handle.take() { h.abort(); }
        }
    }

    async fn finish(&self, name: &str, outcome: Result<(), String>) {
        let mut sessions = self.sessions.lock().await;
        // A cancelled session was already removed; do not resurrect it.
        let Some(s) = sessions.get_mut(name) else { return };
        match outcome {
            Ok(()) => {
                s.status.phase = AuthPhase::Done;
                s.status.error = None;
            }
            Err(reason) => {
                s.status.phase = AuthPhase::Failed;
                s.status.error = Some(reason);
            }
        }
        s.handle = None;
    }
}

/// May we send the device-authorization request to this endpoint?
///
/// Thin alias over [`oauth::device_uri_is_allowed`], the single source of truth
/// shared with the parsing of `verification_uri` / `verification_uri_complete`.
/// Keeping one implementation means the endpoint we POST to and the URI we hand
/// to a human can never drift apart — an earlier revision had a private copy
/// here and left `verification_uri_complete` unvalidated entirely.
///
/// That helper's doc explains the actual rule: plain `https` always, `http`
/// only to a real loopback host (for local development), resolved via
/// `url::Url::parse` rather than a `starts_with("http://localhost")` prefix
/// check that `http://localhost.evil.example/` and `http://localhost@evil…`
/// both slip past.
pub fn device_endpoint_is_allowed(endpoint: &str) -> bool {
    oauth::device_uri_is_allowed(endpoint)
}

/// Compose the RFC 6749 §4.1.1 authorization request.
///
/// Kept as a standalone pure function (rather than inline in `start`) so the
/// exact query string — including PKCE, `state` and the RFC 8707 `resource`
/// indicator — is unit-testable without a live AS or a bound socket.
pub fn build_authorization_url(
    endpoint: &str,
    client_id: &str,
    redirect_uri: &str,
    pkce: &oauth::PkcePair,
    scopes: &[String],
    resource: Option<&str>,
) -> anyhow::Result<String> {
    let mut url = url::Url::parse(endpoint.trim())
        .map_err(|e| anyhow::anyhow!("invalid authorization_endpoint {:?}: {}", endpoint, e))?;
    if !matches!(url.scheme(), "http" | "https") {
        anyhow::bail!("authorization_endpoint must be http(s), got {:?}", url.scheme());
    }
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("response_type", "code");
        q.append_pair("client_id", client_id);
        q.append_pair("redirect_uri", redirect_uri);
        q.append_pair("state", &pkce.state);
        q.append_pair("code_challenge", &pkce.code_challenge);
        q.append_pair("code_challenge_method", &pkce.code_challenge_method);
        if !scopes.is_empty() {
            q.append_pair("scope", &scopes.join(" "));
        }
        if let Some(r) = resource.filter(|s| !s.trim().is_empty()) {
            q.append_pair("resource", r);
        }
    }
    Ok(url.to_string())
}

/// The background half of a flow: wait for the browser callback, exchange the
/// code, persist the credential.
#[allow(clippy::too_many_arguments)]
async fn complete_flow(
    client: &oauth::OAuthClient,
    listener: oauth::RedirectListener,
    pkce: &oauth::PkcePair,
    registration: &oauth::ClientRegistration,
    redirect_uri: &str,
    token_endpoint: &str,
    resource: Option<&str>,
    server_url: &str,
    issuer: &str,
    meta: &oauth::AuthorizationServerMetadata,
    store: &dyn CredentialStore,
    timeout: Duration,
    on_code: impl FnOnce(),
) -> Result<(), String> {
    let outcome = listener
        .serve_once(&pkce.state, timeout)
        .await
        .map_err(|e| e.humanize())?;
    let code = match outcome {
        oauth::CallbackOutcome::Code { code, .. } => code,
        oauth::CallbackOutcome::Denied { error, error_description } => {
            return Err(error_description.unwrap_or_else(|| format!("authorization denied: {}", error)));
        }
    };
    // The browser redirect has landed; the remaining hop is a server-to-server
    // token exchange. Surface that as a distinct phase so the UI can stop
    // saying "waiting for browser" while the code is being exchanged.
    on_code();
    let response = oauth::exchange_code(
        client,
        token_endpoint,
        registration,
        &code,
        redirect_uri,
        &pkce.code_verifier,
        resource,
    )
    .await
    .map_err(|e| e.humanize())?;

    let now = oauth::Clock::system().now();
    let cred = StoredCredentials {
        access_token: response.access_token,
        refresh_token: response.refresh_token,
        token_type: response.token_type,
        expires_at: response.expires_in.map(|s| now.saturating_add(s)),
        scope: response.scope,
        stored_at: now,
        resource: server_url.to_string(),
        authorization_server: issuer.to_string(),
        endpoints: oauth::TokenEndpoints {
            token_endpoint: token_endpoint.to_string(),
            authorization_endpoint: meta.authorization_endpoint.clone().unwrap_or_default(),
            registration_endpoint: meta.registration_endpoint.clone(),
            issuer: meta.issuer.clone().unwrap_or_else(|| issuer.to_string()),
        },
        client: registration.clone(),
        capabilities: oauth::DiscoveredCapabilities::default(),
    };
    store.save(server_url, &cred).await.map_err(|e| format!("cannot save credential: {}", e))?;
    Ok(())
}

/// Background half of an RFC 8628 flow: poll the token endpoint until the user
/// approves, then persist the credential into the same vault as browser OAuth
/// so `resolve_auth_headers` / `bearer_header_for` pick it up unchanged.
#[allow(clippy::too_many_arguments)]
async fn complete_device_flow(
    client: &oauth::OAuthClient,
    token_endpoint: &str,
    registration: &oauth::ClientRegistration,
    device: &oauth::DeviceCodeResponse,
    server_url: &str,
    issuer: &str,
    meta: &oauth::AuthorizationServerMetadata,
    store: &dyn CredentialStore,
    poll_base_secs: u64,
    transient_budget: u32,
) -> Result<(), String> {
    use tokio::time::{sleep, Duration as TokioDuration};
    let deadline = std::time::Instant::now() + TokioDuration::from_secs(device.expires_in_secs());
    let mut interval = poll_base_secs;
    // A user mid-scan is holding a `user_code` that stays valid for `expires_in`
    // seconds. A transient blip — AS restarting (5xx), a gateway between us and
    // it failing, a rate limit (429), a dropped TCP connection — must NOT
    // permanently kill that login; it did exactly that before, and surfaced raw
    // upstream HTML as the error. So transient conditions back off and retry
    // against the same deadline, bounded by a consecutive-failure budget so a
    // genuinely dead endpoint still surfaces instead of spinning to expiry.
    // The budget is the user's 「MCP 重试次数」 setting, threaded in from
    // `start_device`; `max(1)` guards against a stored 0.
    let mut consecutive_transient = 0u32;
    let max_transient = transient_budget.max(1);
    loop {
        if std::time::Instant::now() >= deadline {
            return Err("设备码已过期，请重新发起授权".into());
        }
        sleep(TokioDuration::from_secs(interval)).await;
        let poll = oauth::poll_device_token(client, token_endpoint, registration, &device.device_code).await;
        // A transport-level error (connection reset, DNS blip, timeout) never
        // reaches `classify_device_poll`; handle it as transient here unless it
        // is a definite rejection (`StateMismatch`, `PkceUnsupported`, …).
        let outcome = match poll {
            Ok(o) => o,
            Err(e) => {
                if e.is_retryable() || matches!(e, oauth::OAuthError::Local { .. }) {
                    consecutive_transient += 1;
                    if consecutive_transient >= max_transient {
                        return Err(format!(
                            "授权服务暂时不可用，已连续重试 {max_transient} 次：{}；请稍后重新发起扫码授权",
                            e.humanize()
                        ));
                    }
                    tracing::debug!(attempt = consecutive_transient, error = %e, "device poll transport error; backing off");
                    interval = oauth::back_off_poll_interval(interval);
                    continue;
                }
                return Err(e.humanize());
            }
        };
        match outcome {
            oauth::DevicePollOutcome::Granted(response) => {
                let now = oauth::Clock::system().now();
                let cred = StoredCredentials {
                    access_token: response.access_token,
                    refresh_token: response.refresh_token,
                    token_type: response.token_type,
                    expires_at: response.expires_in.map(|s| now.saturating_add(s)),
                    scope: response.scope,
                    stored_at: now,
                    resource: server_url.to_string(),
                    authorization_server: issuer.to_string(),
                    endpoints: oauth::TokenEndpoints {
                        token_endpoint: token_endpoint.to_string(),
                        authorization_endpoint: meta.authorization_endpoint.clone().unwrap_or_default(),
                        registration_endpoint: meta.registration_endpoint.clone(),
                        issuer: meta.issuer.clone().unwrap_or_else(|| issuer.to_string()),
                    },
                    client: registration.clone(),
                    capabilities: oauth::DiscoveredCapabilities::default(),
                };
                store.save(server_url, &cred).await.map_err(|e| format!("cannot save credential: {e}"))?;
                return Ok(());
            }
            oauth::DevicePollOutcome::Pending => { consecutive_transient = 0; }
            // RFC 8628 §3.5: slow_down means add 5 seconds to *every* subsequent poll.
            oauth::DevicePollOutcome::SlowDown => {
                consecutive_transient = 0;
                interval = oauth::back_off_poll_interval(interval);
            }
            oauth::DevicePollOutcome::Transient => {
                consecutive_transient += 1;
                if consecutive_transient >= max_transient {
                    return Err(format!(
                        "授权服务暂时不可用（HTTP 5xx/429），已连续重试 {max_transient} 次，请稍后重新发起扫码授权"
                    ));
                }
                interval = oauth::back_off_poll_interval(interval);
            }
            oauth::DevicePollOutcome::Failed(reason) => return Err(reason),
        }
    }
}

/* ──────────────────────────────── Tests ──────────────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;

    fn pkce() -> oauth::PkcePair {
        oauth::PkcePair::generate()
    }

    #[test]
    fn auth_kind_parsing_is_tolerant_and_defaults_to_none() {
        assert_eq!(AuthKind::parse("oauth"), AuthKind::Oauth);
        assert_eq!(AuthKind::parse("OAuth2"), AuthKind::Oauth);
        assert_eq!(AuthKind::parse("token"), AuthKind::Token);
        assert_eq!(AuthKind::parse("API_KEY"), AuthKind::Token);
        assert_eq!(AuthKind::parse(""), AuthKind::None);
        assert_eq!(AuthKind::parse("nonsense"), AuthKind::None);
        assert_eq!(AuthKind::None.as_str(), "none");
    }

    #[test]
    fn auth_spec_reads_both_nested_and_flat_shapes() {
        let nested = serde_json::json!({
            "type": "streamable",
            "auth": { "authType": "token", "tokenLabel": "D&B Access Token" }
        });
        let a = AuthSpec::from_entry(&nested);
        assert_eq!(a.kind(), AuthKind::Token);
        assert_eq!(a.token_label, "D&B Access Token");

        let flat = serde_json::json!({ "authType": "oauth" });
        assert_eq!(AuthSpec::from_entry(&flat).kind(), AuthKind::Oauth);

        let legacy = serde_json::json!({ "type": "stdio" });
        assert_eq!(AuthSpec::from_entry(&legacy).kind(), AuthKind::None);
    }

    #[test]
    fn token_header_and_prefix_defaults_are_bearer() {
        let spec = AuthSpec::default();
        assert_eq!(spec.header_name(), "Authorization");
        assert_eq!(spec.prefix(), "Bearer ");
        let raw = AuthSpec { token_prefix: "none".into(), ..Default::default() };
        assert_eq!(raw.prefix(), "");
        let custom = AuthSpec { token_header: "X-Api-Key".into(), ..Default::default() };
        assert_eq!(custom.header_name(), "X-Api-Key");
    }

    #[test]
    fn authorization_url_carries_pkce_state_and_resource() {
        let p = pkce();
        let url = build_authorization_url(
            "https://as.example/authorize",
            "client-1",
            "http://127.0.0.1:43210",
            &p,
            &["mcp.read".into(), "mcp.write".into()],
            Some("https://mcp.example/mcp"),
        )
        .unwrap();
        let parsed = url::Url::parse(&url).unwrap();
        let q: HashMap<String, String> = parsed.query_pairs().into_owned().collect();
        assert_eq!(q.get("response_type").unwrap(), "code");
        assert_eq!(q.get("client_id").unwrap(), "client-1");
        assert_eq!(q.get("redirect_uri").unwrap(), "http://127.0.0.1:43210");
        assert_eq!(q.get("state").unwrap(), &p.state);
        assert_eq!(q.get("code_challenge").unwrap(), &p.code_challenge);
        assert_eq!(q.get("code_challenge_method").unwrap(), "S256");
        assert_eq!(q.get("scope").unwrap(), "mcp.read mcp.write");
        assert_eq!(q.get("resource").unwrap(), "https://mcp.example/mcp");
        // The verifier must never appear in a browser URL.
        assert!(!url.contains(&p.code_verifier));
    }

    #[test]
    fn authorization_url_rejects_non_http_endpoints() {
        let p = pkce();
        let err = build_authorization_url("file:///etc/passwd", "c", "http://127.0.0.1:1", &p, &[], None);
        assert!(err.is_err());
    }

    #[test]
    fn existing_query_parameters_are_preserved() {
        let p = pkce();
        let url = build_authorization_url(
            "https://as.example/authorize?tenant=acme",
            "c",
            "http://127.0.0.1:1",
            &p,
            &[],
            None,
        )
        .unwrap();
        let parsed = url::Url::parse(&url).unwrap();
        let q: HashMap<String, String> = parsed.query_pairs().into_owned().collect();
        assert_eq!(q.get("tenant").unwrap(), "acme");
        assert_eq!(q.get("response_type").unwrap(), "code");
    }

    #[tokio::test]
    async fn vault_roundtrips_static_tokens_without_leaking_them_to_settings() {
        let dir = std::env::temp_dir().join(format!("gwork-mcp-auth-{}", std::process::id()));
        let path = dir.join("mcp-credentials.json");
        let _ = tokio::fs::remove_file(&path).await;
        let vault = CredentialVault::new(path.clone());
        assert!(vault.get_static("https://mcp.example/mcp").await.is_none());

        vault.set_static(
            "https://mcp.example/mcp",
            StaticToken {
                value: "s3cr3t".into(),
                header: "Authorization".into(),
                prefix: "Bearer ".into(),
                stored_at: 1,
            },
        )
        .await
        .unwrap();

        // Canonical key: a different spelling of the same URL hits the same record.
        let got = vault.get_static("https://mcp.example:443/mcp/").await.unwrap();
        assert_eq!(got.value, "s3cr3t");
        assert!(vault.list_keys().await.iter().any(|k| k.contains("mcp.example")));

        vault.clear_static("https://mcp.example/mcp").await.unwrap();
        assert!(vault.get_static("https://mcp.example/mcp").await.is_none());
        let _ = tokio::fs::remove_file(&path).await;
        let _ = tokio::fs::remove_dir(&dir).await;
    }

    #[test]
    fn terminal_phases_are_exactly_the_three_final_states() {
        assert!(AuthPhase::Done.is_terminal());
        assert!(AuthPhase::Failed.is_terminal());
        assert!(AuthPhase::Cancelled.is_terminal());
        assert!(!AuthPhase::Preparing.is_terminal());
        assert!(!AuthPhase::WaitingForBrowser.is_terminal());
        assert!(!AuthPhase::Exchanging.is_terminal());
    }

    /// P1 回归护栏：`device_authorization_endpoint` 的校验必须按**解析出的 host**
    /// 判断，不能按字符串前缀。
    ///
    /// 原实现是 `starts_with("http://localhost")`，两种绕过都能把设备授权请求
    /// （携带 client_id，响应里含 user_code）指向攻击者控制的**明文 HTTP 主机**：
    /// `http://localhost.evil.example/device`（域名恰好以 localhost 开头）与
    /// `http://localhost@evil.example/device`（userinfo 写法，真实 host 是
    /// evil.example）。
    #[test]
    fn device_endpoint_rejects_lookalike_localhost_hosts() {
        let ok = super::device_endpoint_is_allowed;
        // 合法：https 一律放行；http 只放行真正的回环 host（本地开发用）。
        assert!(ok("https://as.example.com/device"));
        assert!(ok("https://as.example.com:8443/device"));
        assert!(ok("http://localhost:8080/device"));
        assert!(ok("http://localhost/device"));
        assert!(ok("http://LOCALHOST:8080/device"), "host 大小写不敏感 (RFC 3986 §3.2.2)");
        assert!(ok("http://127.0.0.1:8080/device"));
        assert!(ok("http://[::1]:8080/device"));

        // 绕过用例：域名只是「看起来像」localhost，真实 host 是外部的。
        assert!(!ok("http://localhost.evil.example/device"));
        assert!(!ok("http://localhost@evil.example/device"));
        assert!(!ok("http://evil.example/localhost"));
        // 明文 http 指向非回环主机一律拒绝。
        assert!(!ok("http://as.example.com/device"));
        assert!(!ok("http://10.0.0.5/device"), "私网地址不是回环，http 不放行");
        // 其它 scheme、相对 URL、空值、畸形输入都要 fail-closed。
        assert!(!ok("javascript:alert(1)"));
        assert!(!ok("file:///etc/passwd"));
        assert!(!ok("/device"));
        assert!(!ok(""));
        assert!(!ok("not a url"));
    }

    /// 注意 `oauth::is_loopback_host` **只认 IP 字面量**，它对字符串
    /// "localhost" 返回 false（其文档注释明说如此）。上面的合法用例
    /// `http://localhost:8080` 之所以能过，靠的是这里显式放行 "localhost"
    /// 字面量——所以这条断言是防止后人「简化」成只调 is_loopback_host 而
    /// 把本地开发端点一起误杀。
    #[test]
    fn device_endpoint_allows_localhost_literal_that_is_loopback_host_rejects() {
        assert!(!super::oauth::is_loopback_host("localhost"),
            "前提变了？若 is_loopback_host 开始认 localhost，可简化 device_endpoint_is_allowed");
        assert!(super::device_endpoint_is_allowed("http://localhost:8080/device"));
    }

    /// P0 回归护栏：凭据文件损坏时必须**报错且不覆写**，绝不能当成空文件。
    ///
    /// 原实现 `serde_json::from_str(&s).unwrap_or_default()` 会把损坏静默变成空
    /// vault：读路径报告「没有任何凭据」（所有连接器看起来都掉登录），而写路径
    /// 是 read → insert → write，于是一个坏字节就能抹掉**其它所有连接器**的
    /// access token 与长效 refresh token。用户视角是「莫名全部掉登录」，日志里
    /// 一个字都没有。
    #[tokio::test(flavor = "multi_thread")]
    async fn vault_refuses_to_wipe_other_credentials_when_the_file_is_corrupt() {
        let dir = std::env::temp_dir().join(format!("gwork-mcp-corrupt-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("mcp-credentials.json");

        // 用户已授权 3 个连接器，其中一个含长效 OAuth refresh token。
        let good = r#"{
          "oauth": {
            "https://a.example/mcp": {
              "access_token": "AT", "refresh_token": "RT-LONG-LIVED",
              "token_type": "Bearer", "stored_at": 0, "resource": "https://a.example/mcp",
              "authorization_server": "https://as.a.example",
              "endpoints": { "token_endpoint": "https://as.a.example/token",
                             "authorization_endpoint": "", "registration_endpoint": null,
                             "issuer": "https://as.a.example" },
              "client": { "client_id": "c", "client_secret": null,
                          "token_endpoint_auth_method": "none", "redirect_uris": [],
                          "registration_access_token": null, "registration_client_uri": null,
                          "scope": [], "source": "registered" },
              "capabilities": {}
            }
          },
          "static_tokens": {
            "https://b.example/mcp": { "value": "B-SECRET", "header": "Authorization",
                                       "prefix": "Bearer ", "stored_at": 0 },
            "https://c.example/mcp": { "value": "C-SECRET", "header": "Authorization",
                                       "prefix": "Bearer ", "stored_at": 0 }
          }
        }"#;
        tokio::fs::write(&path, good).await.unwrap();
        let vault = CredentialVault::new(path.clone());
        assert!(vault.get_static("https://b.example/mcp").await.is_some(), "前置：完好文件应能读到 B");
        assert!(vault.has_oauth("https://a.example/mcp").await, "前置：完好文件应能读到 A 的 OAuth");

        // 磁盘抖动 / 杀软扫描 / 断电导致文件尾部损坏。
        let corrupted = format!("{good}}}GARBAGE");
        tokio::fs::write(&path, corrupted.as_bytes()).await.unwrap();

        // 读路径降级为「无凭据」，不 panic；这是可接受的，因为不写就不会丢数据。
        assert!(vault.get_static("https://b.example/mcp").await.is_none());
        assert!(!vault.has_oauth("https://a.example/mcp").await);

        // 关键：此时用户给「第 4 个」连接器填 token，写入必须失败，
        // 而不是拿一个空 vault 当基础把 A/B/C 全部覆写掉。
        let res = vault.set_static(
            "https://d.example/mcp",
            StaticToken {
                value: "D-SECRET".into(),
                header: "Authorization".into(),
                prefix: "Bearer ".into(),
                stored_at: 0,
            },
        )
        .await;
        assert!(res.is_err(), "损坏文件上写入必须失败，绝不能覆写");
        let err = res.unwrap_err().to_string();
        assert!(err.contains("损坏"), "错误信息应说明是凭据文件损坏，便于用户自救: {err}");

        // 其它连接器的凭据仍在盘上（未被抹除），且损坏内容原样保留供排查。
        let after = tokio::fs::read_to_string(&path).await.unwrap();
        assert!(after.contains("B-SECRET"), "B 凭据不得被静默抹除");
        assert!(after.contains("C-SECRET"), "C 凭据不得被静默抹除");
        assert!(after.contains("RT-LONG-LIVED"), "A 的长效 refresh token 不得被静默抹除");
        assert!(!after.contains("D-SECRET"), "写入未发生");
        assert!(after.contains("GARBAGE"), "原文件必须原样保留，便于用户修复或删除");
        // 临时文件也不该留下，否则凭据明文散落在目录里。
        let tmp = path.with_extension("json.tmp");
        assert!(!tmp.exists(), "失败路径不得残留 .tmp 凭据副本");

        // 修复或删掉坏文件后即可恢复正常。
        let _ = tokio::fs::remove_file(&path).await;
        vault.set_static(
            "https://d.example/mcp",
            StaticToken {
                value: "D-SECRET".into(),
                header: "Authorization".into(),
                prefix: "Bearer ".into(),
                stored_at: 0,
            },
        )
        .await
        .unwrap();
        assert_eq!(vault.get_static("https://d.example/mcp").await.unwrap().value, "D-SECRET");

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// P1 回归护栏：`write()` 必须是**纯原子 rename**，不得先删目标。
    ///
    /// 原实现先 `remove_file` 再 `rename`，注释称「Windows 上已存在目标必须先
    /// 删除」。实测并非如此：Rust 的 rename 在 Windows 用
    /// `MoveFileExW` + `MOVEFILE_REPLACE_EXISTING`，可以直接覆盖已存在文件。
    /// 多余的删除制造了真实的丢数据窗口——在 remove 与 rename 之间崩溃，
    /// 凭据文件会彻底消失，所有连接器一起掉登录。
    #[tokio::test(flavor = "multi_thread")]
    async fn vault_overwrites_an_existing_file_without_deleting_it_first() {
        let dir = std::env::temp_dir().join(format!("gwork-mcp-atomic-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("mcp-credentials.json");
        let vault = CredentialVault::new(path.clone());

        vault
            .set_static(
                "https://first.example/mcp",
                StaticToken {
                    value: "FIRST".into(),
                    header: "Authorization".into(),
                    prefix: "Bearer ".into(),
                    stored_at: 0,
                },
            )
            .await
            .unwrap();
        assert!(path.exists());

        // 覆盖写第二个连接器：目标文件已存在，仍必须成功，且旧条目保留。
        vault
            .set_static(
                "https://second.example/mcp",
                StaticToken {
                    value: "SECOND".into(),
                    header: "Authorization".into(),
                    prefix: "Bearer ".into(),
                    stored_at: 0,
                },
            )
            .await
            .unwrap();
        let text = tokio::fs::read_to_string(&path).await.unwrap();
        assert!(text.contains("FIRST"), "覆盖写不得丢掉既有条目");
        assert!(text.contains("SECOND"));
        assert!(!path.with_extension("json.tmp").exists(), "不得残留临时文件");
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// 源码级钉子：`write()` 不得再出现「先删后改」的写法。
    /// 纯文本断言是脆弱的（改排版就红），所以只钉 `remove_file` 与 `rename`
    /// 的**相对顺序**，行为保证由上面两个真跑测试提供。
    #[test]
    fn vault_write_uses_plain_rename_not_remove_then_rename() {
        let src = include_str!("auth.rs");
        let write_fn = src
            .split("async fn write(&self, file: &CredentialFile)")
            .nth(1)
            .expect("CredentialVault::write 必须存在");
        let body = write_fn.split("\n    }").next().unwrap_or(write_fn);
        let rm = body.find("remove_file(&self.path)");
        assert!(rm.is_none(), "write() 不得先删除目标文件：那会在 remove 与 rename 之间崩溃时丢掉整个凭据文件");
        assert!(body.contains("tokio::fs::rename(&tmp, &self.path)"), "必须用 rename 原子安装");
    }
}
