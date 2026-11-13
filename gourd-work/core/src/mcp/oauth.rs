//! `mcp::oauth` — OAuth 2.1 authorization for HTTP-family MCP servers.
//!
//! ## Why this module exists
//!
//! An HTTP MCP server that requires authorization answers `initialize` with
//! `401`. Before this module the kernel's only reaction was to reword that 401
//! into a human-readable failure (`humanize_connect_error`), which is correct
//! for a *static* credential (a bad API key in `headers`) and useless for an
//! OAuth-protected server: there the 401 is not an error but the first step of a
//! protocol the client is expected to speak. Claude Code, Codex and Qoder all
//! speak it; this is the client side of that conversation.
//!
//! ## Specifications implemented
//!
//! | RFC | Piece |
//! |-----|-------|
//! | [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) | Protected Resource Metadata: read `resource_metadata` out of the 401's `WWW-Authenticate`, else fall back to the well-known path (with the path-insertion variant). |
//! | [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414) | Authorization Server Metadata: locate and parse the AS document, honouring both well-known orderings. |
//! | [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636) | PKCE with `S256` only. |
//! | [RFC 7591](https://www.rfc-editor.org/rfc/rfc7591) | Dynamic Client Registration, used when no `client_id` is configured. |
//! | [RFC 6749](https://www.rfc-editor.org/rfc/rfc6749) / [OAuth 2.1](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1) | Authorization-code grant + refresh. |
//! | [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252) | Native-app guidance: loopback redirect on an ephemeral port, `Host` validation against DNS rebinding. |
//! | [RFC 8707](https://www.rfc-editor.org/rfc/rfc8707) | `resource` indicator, so a token minted for one MCP server is not accepted by another. |
//!
//! ## Design decisions that are easy to get wrong
//!
//! **The authorization server gets a *clean* HTTP client.** Discovery and token
//! requests deliberately do **not** reuse `McpManager::http_client`, because
//! that builder installs the user's `headers` map — which typically carries a
//! `Bearer` token or API key scoped to the *resource* server. Sending it to the
//! AS (frequently a different organization's domain, discovered at runtime from
//! a document the resource server pointed us at) would leak a live credential to
//! a third party. Only the *proxy* setting is carried over, via
//! `McpManager::client_builder`, so egress routing still works on networks that
//! need it.
//!
//! **PKCE never degrades to `plain`.** `plain` sends the verifier itself as the
//! challenge, which removes the entire point of PKCE (binding an intercepted
//! authorization code to the client that started the flow). OAuth 2.1 forbids it.
//! An AS that does not advertise `S256` therefore yields
//! [`OAuthError::PkceUnsupported`] rather than a silently weaker handshake.
//!
//! **A failed refresh must not destroy what already worked.** Refresh failures
//! are usually transient (AS restart, network blip, rate limit) while the
//! *discovered tool list* is expensive to rebuild and is what the agent's prompt
//! is built from. Clearing credentials on the first failed refresh would turn a
//! 30-second AS outage into "every tool from this server vanished", and the
//! model would keep trying to call tools that no longer exist. So the refresh
//! path preserves both the previous tokens and [`StoredCredentials::capabilities`]
//! and reports the failure without mutating the store.
//!
//! ## Public API / caller contract
//!
//! There is no `AuthorizeOutcome`, no `OAuthPrompter`, and no browser-launching
//! orchestrator in this module: the browser is the caller's problem, not ours.
//! A desktop kernel cannot know whether it is driving a Tauri window, a terminal,
//! or a headless CI job, so nothing here calls `open`/`start`. The caller decides
//! how to present the URL it builds: [`classify_401`] identifies an OAuth-capable
//! 401, [`OAuthError::NeedsAuthorization`] is the typed "the user must act" signal,
//! [`RedirectListener`] owns the loopback callback and its `state` check, and
//! [`CallbackOutcome`] reports what that callback delivered. The caller composes
//! these steps — the module exposes each protocol hop, not a one-call prompter.
//!
//! [`bearer_header_for`] is the request-path entry point: it returns an optional
//! `Authorization` header, refreshing inline when a stored cred is near expiry.
//! [`CredentialStore`] (with [`MemoryCredentialStore`] and
//! [`FileCredentialStore`]) decides where tokens live between runs.
//!
//! ## Testability
//!
//! Every network hop goes through [`OAuthClient`], which carries an injectable
//! [`Clock`], so expiry and refresh-skew logic is tested without sleeping. The
//! unit tests in this file cover the pure protocol logic (challenge parsing,
//! well-known URL construction, PKCE, metadata, scopes, credentials, header
//! formatting) without any external network. The loopback listener is a
//! [`RedirectListener`] bound to `127.0.0.1`; it is not exercised by the unit
//! tests here, which are deliberately offline.

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

use super::McpServerConfig;

/* ─────────────────────────── Failure taxonomy ─────────────────────────── */

/// Which discovery hop failed.
///
/// Split out because the three stages have completely different fixes, and a
/// flat "discovery failed" message leaves the user guessing whether the MCP
/// server is misconfigured, whether its authorization server is down, or whether
/// we simply disagree about which endpoints exist.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscoveryStage {
    /// RFC 9728: fetching/parsing `oauth-protected-resource`.
    ProtectedResourceMetadata,
    /// RFC 8414: fetching/parsing `oauth-authorization-server`.
    AuthorizationServerMetadata,
    /// The metadata parsed but is missing an endpoint we cannot do without.
    IncompleteMetadata,
}

impl std::fmt::Display for DiscoveryStage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            DiscoveryStage::ProtectedResourceMetadata => "protected resource metadata (RFC 9728)",
            DiscoveryStage::AuthorizationServerMetadata => "authorization server metadata (RFC 8414)",
            DiscoveryStage::IncompleteMetadata => "authorization server metadata",
        };
        f.write_str(s)
    }
}

/// Everything that can go wrong in an authorization attempt, typed.
///
/// A typed enum rather than `anyhow` strings for the same reason
/// `TransportDead` and `UnsupportedProtocolVersion` are typed in the parent
/// module: the caller has to *branch* on these. `NeedsAuthorization` means
/// "show the user a URL", `TimedOut` means "they walked away, retry is cheap",
/// `PkceUnsupported` means "this server can never work, stop retrying and say
/// why". Recovering a decision like that out of formatted text is exactly the
/// substring-matching trap the parent module documents and avoids.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OAuthError {
    /// No usable token and no way to obtain one silently: the user must approve
    /// in a browser. This is the *normal* outcome for a first connect, not a bug.
    NeedsAuthorization {
        reason: String,
    },
    /// A metadata document could not be fetched or parsed.
    DiscoveryFailed {
        stage: DiscoveryStage,
        /// The URL we tried (for `IncompleteMetadata`, the AS issuer).
        url: String,
        reason: String,
    },
    /// RFC 7591 registration was refused or produced an unusable response.
    RegistrationFailed {
        url: String,
        /// HTTP status when the server answered at all; `None` for a transport failure.
        status: Option<u16>,
        reason: String,
    },
    /// A refresh grant failed. **The stored credentials were left untouched.**
    RefreshFailed {
        reason: String,
    },
    /// The authorization server reported the user declined (`access_denied`).
    UserCancelled {
        error_description: Option<String>,
    },
    /// The browser callback never arrived within the deadline.
    TimedOut {
        after: Duration,
    },
    /// The callback's `state` did not match ours — a CSRF attempt or a stale tab.
    StateMismatch {
        expected_prefix: String,
    },
    /// The AS does not advertise `S256`; see the module docs for why we refuse.
    PkceUnsupported {
        supported: Vec<String>,
    },
    /// The callback arrived but was malformed (no `code`, bad request line, ...).
    InvalidCallback {
        reason: String,
    },
    /// Token endpoint answered with an OAuth error body.
    TokenRequestFailed {
        url: String,
        status: Option<u16>,
        /// RFC 6749 §5.2 `error` code, when the body carried one.
        error_code: Option<String>,
        reason: String,
    },
    /// A local problem on our side: bad URL, no ephemeral port, unwritable store.
    Local {
        reason: String,
    },
}

impl OAuthError {
    /// Does retrying without user involvement have any chance of succeeding?
    ///
    /// Drives whether the MCP manager should back off and retry a reconnect or
    /// surface the failure to the settings panel immediately. Retrying a
    /// `StateMismatch` or `PkceUnsupported` is pure waste; retrying a
    /// `TimedOut` after the user comes back is exactly what should happen.
    pub fn is_retryable(&self) -> bool {
        if let OAuthError::TokenRequestFailed { status: Some(s), .. } = self {
            if *s >= 500 {
                return true;
            }
        }
        matches!(
            self,
            OAuthError::TimedOut { .. }
                | OAuthError::RefreshFailed { .. }
                | OAuthError::DiscoveryFailed { stage: DiscoveryStage::ProtectedResourceMetadata, .. }
                | OAuthError::DiscoveryFailed { stage: DiscoveryStage::AuthorizationServerMetadata, .. }
        )
    }

    /// Is this the "the user must act" case, i.e. should the UI open a dialog?
    pub fn needs_user(&self) -> bool {
        matches!(self, OAuthError::NeedsAuthorization { .. })
    }

    /// User-facing wording, in the same register as `humanize_connect_error`.
    ///
    /// Chinese on purpose: this string reaches the MCP settings panel's
    /// `lastError` cell, and every other message rendered there is Chinese.
    /// Mixing one English sentence into that list looks like a bug even when the
    /// translation is accurate.
    pub fn humanize(&self) -> String {
        match self {
            OAuthError::NeedsAuthorization { reason } => {
                format!("该 MCP 服务器需要授权登录：{}", reason)
            }
            OAuthError::DiscoveryFailed { stage, url, reason } => format!(
                "无法获取 OAuth 发现文档（{}）：{}（{}）",
                stage,
                super::truncate(url, 120),
                reason
            ),
            OAuthError::RegistrationFailed { url, status, reason } => match status {
                Some(s) => format!("动态客户端注册失败（HTTP {}）：{}（{}）", s, super::truncate(url, 120), reason),
                None => format!("动态客户端注册无法连接：{}（{}）", super::truncate(url, 120), reason),
            },
            OAuthError::RefreshFailed { reason } => {
                format!("令牌刷新失败，已保留原凭据：{}", reason)
            }
            OAuthError::UserCancelled { .. } => "用户取消了授权".into(),
            OAuthError::TimedOut { after } => {
                format!("等待浏览器授权超时（{} 秒），请重新发起授权", after.as_secs())
            }
            OAuthError::StateMismatch { .. } => {
                "授权回调校验失败（state 不匹配），已拒绝该请求；请关闭旧标签页后重试".into()
            }
            OAuthError::PkceUnsupported { supported } => format!(
                "该授权服务器不支持 PKCE S256（仅支持 {:?}），出于安全考虑不会降级为 plain",
                supported
            ),
            OAuthError::InvalidCallback { reason } => format!("授权回调无效：{}", reason),
            OAuthError::TokenRequestFailed { status, error_code, reason, .. } => match (status, error_code) {
                (Some(s), Some(code)) => format!("令牌请求被拒绝（HTTP {}，{}）：{}", s, code, reason),
                (Some(s), None) => format!("令牌请求失败（HTTP {}）：{}", s, reason),
                _ => format!("令牌请求失败：{}", reason),
            },
            OAuthError::Local { reason } => format!("本地 OAuth 处理失败：{}", reason),
        }
    }
}

impl std::fmt::Display for OAuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OAuthError::NeedsAuthorization { reason } => write!(f, "authorization required: {}", reason),
            OAuthError::DiscoveryFailed { stage, url, reason } => {
                write!(f, "{} discovery failed for {}: {}", stage, url, reason)
            }
            OAuthError::RegistrationFailed { url, status, reason } => match status {
                Some(s) => write!(f, "dynamic client registration at {} failed (HTTP {}): {}", url, s, reason),
                None => write!(f, "dynamic client registration at {} failed: {}", url, reason),
            },
            OAuthError::RefreshFailed { reason } => write!(f, "token refresh failed: {}", reason),
            OAuthError::UserCancelled { error_description } => match error_description {
                Some(d) => write!(f, "user cancelled authorization: {}", d),
                None => f.write_str("user cancelled authorization"),
            },
            OAuthError::TimedOut { after } => write!(f, "timed out after {:?} waiting for the authorization callback", after),
            OAuthError::StateMismatch { expected_prefix } => {
                write!(f, "callback state did not match (expected {}…)", expected_prefix)
            }
            OAuthError::PkceUnsupported { supported } => {
                write!(f, "authorization server does not support S256 (advertises {:?})", supported)
            }
            OAuthError::InvalidCallback { reason } => write!(f, "invalid authorization callback: {}", reason),
            OAuthError::TokenRequestFailed { url, status, error_code, reason } => match (status, error_code) {
                (Some(s), Some(c)) => write!(f, "token request to {} failed (HTTP {}, {}): {}", url, s, c, reason),
                (Some(s), None) => write!(f, "token request to {} failed (HTTP {}): {}", url, s, reason),
                _ => write!(f, "token request to {} failed: {}", url, reason),
            },
            OAuthError::Local { reason } => write!(f, "{}", reason),
        }
    }
}

impl std::error::Error for OAuthError {}

/* ─────────── 401 classification (RFC 6750 §3 + RFC 9728 §5) ─────────── */

/// A parsed `WWW-Authenticate` challenge from a 401.
///
/// This is the single entry point the parent module's error normalization
/// should use. Parsing it here rather than in `mod.rs` keeps the RFC 7235
/// grammar in one place — the grammar is not trivial (parameter values may be
/// quoted strings containing commas, so splitting the header on `,` corrupts
/// exactly the values we care about, including `resource_metadata`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct UnauthorizedChallenge {
    /// Auth scheme as written by the server, lowercased (`"bearer"`, `"basic"`).
    pub scheme: Option<String>,
    /// `realm` parameter, if present.
    pub realm: Option<String>,
    /// RFC 6750 `error` code: `invalid_request` | `invalid_token` | `insufficient_scope`.
    pub error: Option<String>,
    /// RFC 6750 `error_description`, human text from the server.
    pub error_description: Option<String>,
    /// RFC 6750 `error_uri`.
    pub error_uri: Option<String>,
    /// RFC 9728 §5: where to fetch Protected Resource Metadata. Absent on
    /// servers that predate RFC 9728, which is why the well-known fallback
    /// exists.
    pub resource_metadata: Option<String>,
    /// `scope` parameter, space-split per RFC 6750.
    pub scopes: Vec<String>,
    /// The header verbatim, for logs. Truncated by the caller if needed.
    pub raw: String,
}

impl UnauthorizedChallenge {
    /// An empty result, for a 401 with no `WWW-Authenticate` at all.
    pub fn none() -> Self {
        Self::default()
    }

    /// Is this a Bearer challenge, i.e. could OAuth help?
    ///
    /// `true` even for a bare `WWW-Authenticate: Bearer` with no parameters:
    /// RFC 6750 §3 permits that form, and plenty of MCP servers send exactly
    /// it. Requiring parameters would make those servers look non-OAuth and
    /// strand the user with "connection failed" instead of a login prompt.
    pub fn is_bearer(&self) -> bool {
        self.scheme.as_deref() == Some("bearer")
    }

    /// Should the caller attempt the OAuth flow?
    ///
    /// Deliberately narrower than [`Self::is_bearer`]: a `Basic` challenge means
    /// the server wants a username/password (a reverse proxy in front of the MCP
    /// server, usually), and running OAuth at it would loop forever.
    pub fn should_authorize(&self) -> bool {
        self.is_bearer()
    }

    /// Does the challenge say our token was rejected rather than absent?
    ///
    /// `invalid_token` covers both "expired" and "revoked/malformed". We cannot
    /// tell them apart from the header alone (RFC 6750 puts the detail in free
    /// text `error_description`), and treating both as "try a refresh, then
    /// re-authorize" is correct for either — a refresh succeeds on expiry and
    /// fails on revocation, which then falls through to re-authorization.
    pub fn token_rejected(&self) -> bool {
        self.error.as_deref() == Some("invalid_token")
    }

    /// Does the server say we are authenticated but under-scoped?
    ///
    /// Re-authorizing with the *same* scopes cannot fix this, so the caller
    /// should widen scopes (from `scopes_supported`) instead of silently looping.
    pub fn insufficient_scope(&self) -> bool {
        self.error.as_deref() == Some("insufficient_scope")
    }
}

/// Classify a 401 response's `WWW-Authenticate` header.
///
/// `None` (header absent) yields [`UnauthorizedChallenge::none`], which
/// `should_authorize()` reports as `false` — a 401 with no challenge gives us
/// nothing to act on, and inventing an OAuth flow for it would send the user to
/// a login page for a server that may simply have a misconfigured API key.
///
/// Only the first challenge is returned. RFC 7235 allows a list, but a server
/// offering both `Bearer` and `Basic` wants a choice we cannot make on the
/// user's behalf, and in practice MCP servers send exactly one.
pub fn classify_401(www_authenticate: Option<&str>) -> UnauthorizedChallenge {
    let Some(raw) = www_authenticate else { return UnauthorizedChallenge::none() };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return UnauthorizedChallenge::none();
    }
    let mut out = UnauthorizedChallenge { raw: trimmed.to_string(), ..Default::default() };

    // Split off the scheme: it is a token, so it ends at the first space or at
    // the end of the string (the bare `Bearer` form).
    let (scheme, rest) = match trimmed.find(|c: char| c.is_ascii_whitespace()) {
        Some(i) => (&trimmed[..i], trimmed[i..].trim_start()),
        None => (trimmed, ""),
    };
    out.scheme = Some(scheme.trim().to_lowercase());

    for (key, value) in parse_auth_params(rest) {
        match key.to_lowercase().as_str() {
            "realm" => out.realm = Some(value.clone()),
            "error" => out.error = Some(value.clone()),
            "error_description" => out.error_description = Some(value.clone()),
            "error_uri" => out.error_uri = Some(value.clone()),
            "resource_metadata" => out.resource_metadata = Some(value.clone()),
            "scope" | "scopes" => {
                out.scopes = value.split_ascii_whitespace().map(|s| s.to_string()).collect()
            }
            _ => {}
        }
    }
    out
}

/// Parse the `key=value` parameter list of an auth challenge.
///
/// A hand-rolled scanner rather than a comma split, because a quoted value may
/// legally contain commas (`error_description="too many, too fast"`) and a naive
/// split would truncate it and misalign every parameter after it. Handles
/// backslash escapes inside quoted strings per RFC 7235 / RFC 9110 §5.6.7, and
/// accepts both `quoted-string` and bare `token` values.
fn parse_auth_params(input: &str) -> Vec<(String, String)> {
    let bytes: Vec<char> = input.chars().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        // Skip separators and whitespace between parameters.
        while i < bytes.len() && (bytes[i] == ',' || bytes[i].is_ascii_whitespace()) {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        let key_start = i;
        while i < bytes.len() && bytes[i] != '=' && bytes[i] != ',' {
            i += 1;
        }
        let key: String = bytes[key_start..i].iter().collect::<String>().trim().to_string();
        if i >= bytes.len() || bytes[i] != '=' {
            // A valueless token (some servers send `Bearer error=foo bar`);
            // nothing useful to record, and skipping it keeps the scan aligned.
            if key.is_empty() {
                i += 1;
            }
            continue;
        }
        i += 1; // consume '='
        i = skip_ws(&bytes, i);
        if i >= bytes.len() {
            out.push((key, String::new()));
            break;
        }
        let value = if bytes[i] == '"' {
            i += 1; // opening quote
            let mut v = String::new();
            while i < bytes.len() {
                let c = bytes[i];
                if c == '\\' && i + 1 < bytes.len() {
                    v.push(bytes[i + 1]);
                    i += 2;
                    continue;
                }
                if c == '"' {
                    i += 1;
                    break;
                }
                v.push(c);
                i += 1;
            }
            v
        } else {
            let start = i;
            while i < bytes.len() && bytes[i] != ',' && !bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            bytes[start..i].iter().collect()
        };
        if !key.is_empty() {
            out.push((key, value));
        }
    }
    out
}

/// Advance past ASCII whitespace.
fn skip_ws(chars: &[char], mut i: usize) -> usize {
    while i < chars.len() && chars[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

/* ─────────── Well-known URL construction (RFC 9728 §4 / RFC 8414 §3.1) ─────────── */

/// RFC 9728 well-known path for Protected Resource Metadata.
pub const PRM_WELL_KNOWN: &str = "/.well-known/oauth-protected-resource";
/// RFC 8414 well-known path for Authorization Server Metadata.
pub const AS_WELL_KNOWN: &str = "/.well-known/oauth-authorization-server";
/// OpenID Connect Discovery 1.0 §4 well-known suffix.
pub const OIDC_WELL_KNOWN: &str = "/.well-known/openid-configuration";

/// Build the RFC 9728 metadata URL for a protected resource.
///
/// The path is *inserted before* the resource's own path, not appended:
/// `https://host/a/b` → `https://host/.well-known/oauth-protected-resource/a/b`.
/// That ordering is the whole point of the rule — a resource server that hosts
/// many MCP endpoints under distinct paths can publish one document per path
/// while still serving them all from a single origin, and appending instead
/// would collapse `/a/b` and `/c/d` onto the same document.
///
/// The resource identifier's query and fragment are dropped: RFC 9728 §4
/// defines the metadata URL over scheme + host + port + path only. A resource
/// URL of `https://host/mcp?tenant=7` therefore shares a document with
/// `https://host/mcp`, which is correct — the query is a *request* parameter,
/// not part of the resource's identity for discovery.
///
/// Returns `None` for a URL that is not absolute http(s), because there is no
/// meaningful well-known location to derive from it and guessing would send a
/// request to the wrong host.
pub fn protected_resource_metadata_url(resource_url: &str) -> Option<String> {
    insert_well_known(resource_url, PRM_WELL_KNOWN)
}

/// Build the RFC 8414 metadata URL for an authorization server issuer.
///
/// Same insertion rule as [`protected_resource_metadata_url`], with one
/// difference in how the issuer is normalised: RFC 8414 §3.1 says the issuer
/// MUST NOT include a trailing `/` for the purpose of this construction, so
/// `https://as.example.com/` and `https://as.example.com` produce the same URL.
/// Getting this wrong is invisible in tests against permissive servers and
/// shows up as a 404 against strict ones.
pub fn authorization_server_metadata_url(issuer: &str) -> Option<String> {
    let trimmed = issuer.trim_end_matches('/');
    insert_well_known(trimmed, AS_WELL_KNOWN)
}

/// All metadata URLs to try for an issuer, best-first.
///
/// Both spellings are tried because they are both in active use and a client
/// that picks one will fail against servers that publish the other:
///
/// 1. **RFC 8414 insertion** — `https://host/.well-known/oauth-authorization-server/path`
/// 2. **OIDC Discovery append** — `https://host/path/.well-known/openid-configuration`
///
/// The MCP authorization spec explicitly requires clients to attempt both. The
/// OIDC document is a superset (it contains `authorization_endpoint` and
/// `token_endpoint` plus OIDC-specific fields we ignore), so parsing it with the
/// same struct works without a second deserializer.
pub fn authorization_server_metadata_candidates(issuer: &str) -> Vec<String> {
    let mut out = Vec::new();
    let trimmed = issuer.trim_end_matches('/');
    if let Some(u) = insert_well_known(trimmed, AS_WELL_KNOWN) {
        out.push(u);
    }
    if let Some(u) = append_well_known(trimmed, OIDC_WELL_KNOWN) {
        // Only a distinct second candidate; some issuers make both spellings
        // resolve to the same URL and probing it twice wastes a round trip.
        if !out.iter().any(|e| e == &u) {
            out.push(u);
        }
    }
    out
}

/// Insert `well_known` immediately after the authority component.
///
/// Shared by the resource and AS builders so the two cannot drift — they must
/// implement the same rule, and a divergence here would make one discovery path
/// work while the other 404s against the same server.
fn insert_well_known(raw: &str, well_known: &str) -> Option<String> {
    let url = url::Url::parse(raw.trim()).ok()?;
    if !is_http_family(&url) {
        return None;
    }
    let path = url.path();
    // A root resource (`/`) has no path to preserve; emitting
    // `/.well-known/x/` would be a different (and usually 404ing) URL than
    // `/.well-known/x`, which is what the specs' root examples show.
    let suffix = if path == "/" { "" } else { path.trim_end_matches('/') };
    let mut base = String::new();
    base.push_str(url.scheme());
    base.push_str("://");
    if let Some(host) = url.host_str() {
        // IPv6 literals must be re-bracketed: `Url::host_str` strips the
        // brackets, and `https://::1:port/...` does not parse.
        base.push_str(&bracket_if_v6(host));
    }
    if let Some(port) = url.port() {
        base.push(':');
        base.push_str(&port.to_string());
    }
    base.push_str(well_known);
    base.push_str(suffix);
    url::Url::parse(&base).ok().map(|u| u.to_string())
}

/// Append `well_known` to the end of the path (the OIDC Discovery spelling).
fn append_well_known(raw: &str, well_known: &str) -> Option<String> {
    let url = url::Url::parse(raw.trim()).ok()?;
    if !is_http_family(&url) {
        return None;
    }
    let path = url.path();
    let suffix = if path == "/" { "" } else { path.trim_end_matches('/') };
    let joined = format!("{}{}", suffix, well_known);
    url.join(&joined).ok().map(|u| u.to_string())
}

/// Is this an `http`/`https` URL?
///
/// Checked explicitly rather than relying on `Url::join` to reject odd schemes:
/// a `file:` or `data:` URL parses fine and joins fine, so an unchecked build
/// would happily produce a well-known URL under a scheme nobody can fetch, and
/// the resulting error ("cannot GET file:///...") reads like a bug in the client.
fn is_http_family(url: &url::Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

/// Re-add `[` `]` around an IPv6 host literal, if needed.
fn bracket_if_v6(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{}]", host)
    } else {
        host.to_string()
    }
}

/// Is this host a loopback address?
///
/// RFC 8252 §7.3 permits the loopback redirect **only** for loopback IPs, and
/// explicitly warns against `localhost`: that name resolves to whatever the
/// platform's resolver says, which is not always `127.0.0.1` (it can be `::1`,
/// and on misconfigured hosts it can point elsewhere entirely). Binding the
/// listener to a literal IP removes that ambiguity, and validating the
/// `redirect_uri` against the same literal set keeps the check honest.
///
/// Only IP literals are accepted, never hostnames. A bracketed IPv6 literal
/// (`[::1]`) is accepted too: it is still an IP literal, and callers that pass
/// a `Host` header value (which is bracketed for IPv6) should not have to know
/// that detail. No DNS resolution is performed here.
pub fn is_loopback_host(host: &str) -> bool {
    let literal = host.trim().trim_start_matches('[').trim_end_matches(']');
    match literal.parse::<std::net::IpAddr>() {
        Ok(ip) => ip.is_loopback(),
        // Not an IP literal, so not something we can pin down; `localhost`
        // lands here and is rejected for the reason above.
        Err(_) => false,
    }
}

/// Is this URL acceptable to use for the RFC 8628 Device Authorization Grant —
/// both as the `device_authorization_endpoint` we POST to and as the
/// `verification_uri` / `verification_uri_complete` we hand to a human?
///
/// Plain `https` always; `http` only to a genuine loopback host, for local
/// development against an authorization server running on this machine.
///
/// Deliberately **not** a `starts_with("http://localhost")` prefix check, which
/// was bypassable two ways — both let a hostile catalog entry or a compromised
/// authorization server aim the request (carrying `client_id`, and `user_code`
/// in the response / query) at a plaintext HTTP host it controls:
/// * `http://localhost.evil.example/device` — an attacker-owned domain whose
///   name merely starts with the string `localhost`;
/// * `http://localhost@evil.example/device` — userinfo syntax, where the real
///   host is `evil.example`.
///
/// Nor can it simply delegate to [`is_loopback_host`]: that helper resolves
/// **IP literals only** and rejects the literal hostname `localhost` on purpose
/// (see its doc comment, which is about the stricter RFC 8252 §7.3 requirement
/// for redirect URIs). Using it bare here would break the legitimate
/// `http://localhost:8080` development case. Parsing with `url::Url` means the
/// host is what a real HTTP client would connect to, not a string prefix.
///
/// This is the single source of truth for both `mcp::auth` and device-response
/// parsing, so the endpoint and the human-facing URI cannot drift apart.
/// Pure, so the bypass cases are unit-testable without an AS.
pub fn device_uri_is_allowed(uri: &str) -> bool {
    let Ok(url) = url::Url::parse(uri.trim()) else { return false };
    match url.scheme() {
        "https" => true,
        "http" => match url.host_str().unwrap_or("") {
            // Case-insensitive: RFC 3986 §3.2.2 normalises host to lowercase.
            h if h.eq_ignore_ascii_case("localhost") => true,
            h => is_loopback_host(h),
        },
        _ => false,
    }
}

/// The lowercase host of a URL, or `None` when it does not parse.
///
/// Used to require that `verification_uri_complete` points at the *same site*
/// as the already-validated `verification_uri`: RFC 8628 §3.3.1 defines the
/// former as the latter with the user code included, so a cross-host value is
/// not a legitimate variant even when it is itself a well-formed https URL.
///
/// `url::Url` lowercases the host while parsing, but normalising explicitly
/// keeps the comparison honest if that ever changes. `None` never equals
/// `None` here in practice, because the caller has already validated
/// `verification_uri`, which cannot have a `None` host.
fn uri_host(uri: &str) -> Option<String> {
    url::Url::parse(uri.trim())
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()))
}

/* ──────────────────────────── PKCE (RFC 7636) ──────────────────────────── */

/// The only `code_challenge_method` this client will use.
pub const PKCE_METHOD_S256: &str = "S256";
/// Bytes of entropy behind a `code_verifier`.
///
/// RFC 7636 §4.1 requires 43–128 characters drawn from `[A-Za-z0-9-._~]`, which
/// is a *minimum of 32 octets* of entropy. 48 bytes lands at 64 characters after
/// base64url encoding — comfortably inside the range, and well above the floor,
/// so a verifier is not brute-forceable even against an attacker who has the
/// challenge and unlimited token-endpoint attempts.
const VERIFIER_ENTROPY_BYTES: usize = 48;
/// Bytes of entropy behind a `state` value.
///
/// `state` is a CSRF token, not a secret protecting a challenge, so it needs
/// only to be unpredictable; 32 bytes is 128+ bits of guessing resistance.
const STATE_ENTROPY_BYTES: usize = 32;

/// PKCE challenge method advertised by an authorization server.
///
/// RFC 7636 names `plain` and `S256`; servers also send `null` (a non-standard
/// extension some gateways support). Normalising case here means an AS that
/// advertises `"s256"` still matches — RFC 7636 §4.2 defines the values as
/// case-sensitive, but servers in the wild disagree with the RFC about their own
/// metadata, and failing a login over letter case helps nobody.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PkceMethod {
    S256,
    Plain,
    Other(String),
}

impl PkceMethod {
    /// Parse one advertised method string.
    pub fn parse(raw: &str) -> Self {
        match raw.trim() {
            m if m.eq_ignore_ascii_case(PKCE_METHOD_S256) => PkceMethod::S256,
            m if m.eq_ignore_ascii_case("plain") => PkceMethod::Plain,
            other => PkceMethod::Other(other.to_string()),
        }
    }

    /// The wire spelling. Always the canonical RFC casing, never the server's,
    /// so what we send is what a conformant AS expects.
    pub fn as_str(&self) -> &str {
        match self {
            PkceMethod::S256 => PKCE_METHOD_S256,
            PkceMethod::Plain => "plain",
            PkceMethod::Other(s) => s.as_str(),
        }
    }
}

/// Decide which challenge method to use given what the AS advertises.
///
/// Returns [`OAuthError::PkceUnsupported`] when `S256` is missing rather than
/// falling back to `plain`. This is a hard refusal, not a strictness flourish:
/// `plain` puts the verifier itself in the query string, so anyone who can read
/// the redirect (a malicious app registered for the same custom scheme, a proxy
/// log, browser history sync) can redeem a stolen code. S256 makes the leaked
/// challenge useless. Silently downgrading would be a security regression that
/// no test and no error message would ever surface.
///
/// An **empty or absent** `code_challenge_methods_supported` is treated as
/// `S256` being available. RFC 8414 §2 marks the field optional, and
/// RFC 7636 §3 requires `S256` support from any compliant AS; refusing to log in
/// to every server that omits an optional metadata field would break most real
/// deployments, including several major MCP hosts.
pub fn select_pkce_method(advertised: &[String]) -> Result<PkceMethod, OAuthError> {
    if advertised.is_empty() {
        return Ok(PkceMethod::S256);
    }
    let methods: Vec<PkceMethod> = advertised.iter().map(|s| PkceMethod::parse(s)).collect();
    if methods.iter().any(|m| *m == PkceMethod::S256) {
        return Ok(PkceMethod::S256);
    }
    Err(OAuthError::PkceUnsupported { supported: advertised.to_vec() })
}

/// A freshly generated PKCE pair plus the CSRF `state`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PkcePair {
    /// Sent as `code_verifier` to the token endpoint; never leaves this process
    /// until then, and never appears in the browser URL.
    pub code_verifier: String,
    /// `BASE64URL-UNPADDED(SHA256(code_verifier))`, sent in the authorization URL.
    pub code_challenge: String,
    /// Always `"S256"` — see [`select_pkce_method`].
    pub code_challenge_method: String,
    /// Echoed back on the redirect and compared; see [`RedirectListener`].
    pub state: String,
}

impl PkcePair {
    /// Generate a verifier/challenge/state triple from the OS CSPRNG.
    ///
    /// `rand::thread_rng()` is a ChaCha12 stream seeded and periodically reseeded
    /// from `getrandom` (the OS entropy source), i.e. cryptographically secure —
    /// not the deterministic `StdRng`. This matters: a predictable verifier lets
    /// an attacker precompute the challenge and redeem a code they intercepted,
    /// which is precisely the attack PKCE exists to prevent.
    pub fn generate() -> Self {
        use base64::Engine as _;
        use rand::RngCore as _;
        use sha2::{Digest as _, Sha256};

        let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let mut verifier_bytes = [0u8; VERIFIER_ENTROPY_BYTES];
        rand::thread_rng().fill_bytes(&mut verifier_bytes);
        // base64url of 48 bytes is exactly 64 chars, no padding — inside the
        // RFC's 43–128 window.
        let code_verifier = engine.encode(verifier_bytes);
        // Zero the secret material as soon as it is encoded. Rust cannot
        // guarantee this (the compiler may keep a copy, and the `String` above
        // is a second copy), but it removes the easy case: a core dump or a
        // debugger inspecting this stack frame after return.
        verifier_bytes.iter_mut().for_each(|b| *b = 0);

        let digest = Sha256::digest(code_verifier.as_bytes());
        let code_challenge = engine.encode(digest);

        let mut state_bytes = [0u8; STATE_ENTROPY_BYTES];
        rand::thread_rng().fill_bytes(&mut state_bytes);
        let state = engine.encode(state_bytes);
        state_bytes.iter_mut().for_each(|b| *b = 0);

        Self {
            code_verifier,
            code_challenge,
            code_challenge_method: PKCE_METHOD_S256.to_string(),
            state,
        }
    }
}

/// Compute `BASE64URL-UNPADDED(SHA256(verifier))`.
///
/// Exposed separately from [`PkcePair::generate`] because the RFC 7636 Appendix B
/// test vector is the only way to prove the encoding is right without a live AS:
/// a wrong alphabet or leftover padding produces a challenge the server rejects
/// with `invalid_grant`, an error that reads like an expired code.
pub fn s256_challenge(code_verifier: &str) -> String {
    use base64::Engine as _;
    use sha2::{Digest as _, Sha256};
    let digest = Sha256::digest(code_verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

/* ───────────────────── Metadata documents (RFC 9728 / 8414) ───────────────────── */

/// RFC 9728 Protected Resource Metadata.
///
/// **Every field is optional at the serde level.** The parent module documents
/// this rule for `McpServerConfig` and it applies with even more force here:
/// these documents come from arbitrary third parties, and one unexpected-but-
/// parseable field must not abort an otherwise perfectly good login. Fields we
/// do not implement (`resource_policy_uri`, `tls_client_certificate_bound_*`)
/// are simply not declared — `serde_json` ignores unknown keys by default, which
/// is the behaviour we want for forward compatibility with a future RFC revision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ProtectedResourceMetadata {
    /// The resource this document describes. RFC 9728 §4.2 makes it REQUIRED
    /// and says clients SHOULD verify it matches the resource they are talking
    /// to; `validate_against` implements that check.
    #[serde(default)]
    pub resource: Option<String>,
    /// Candidate authorization servers, in the order the resource recommends
    /// trying them. Usually one entry.
    #[serde(default, deserialize_with = "deserialize_string_or_list")]
    pub authorization_servers: Vec<String>,
    /// Scopes the resource understands, which we intersect with the AS's own
    /// `scopes_supported` before requesting any.
    #[serde(default, deserialize_with = "deserialize_string_or_list")]
    pub scopes_supported: Vec<String>,
    /// RFC 9728 §2: how the resource expects the token presented
    /// (`header` | `body` | `query`). `header` is the only one we send, so a
    /// server listing just `query` is flagged rather than silently mis-served.
    #[serde(default, deserialize_with = "deserialize_string_or_list")]
    pub bearer_methods_supported: Vec<String>,
    /// Human documentation URL, surfaced in error messages so a stuck user has
    /// somewhere to look.
    #[serde(default)]
    pub resource_documentation: Option<String>,
    /// Where this document was fetched from; not part of the wire format, but
    /// needed to build actionable errors ("GET {url} returned 404").
    #[serde(skip)]
    pub source_url: String,
}

impl ProtectedResourceMetadata {
    /// Does this document actually describe `resource_url`?
    ///
    /// RFC 9728 §4.2's validation, implemented as a comparison of *canonical*
    /// identifiers rather than raw strings. The comparison ignores the default
    /// port (`https://h:443/x` ≡ `https://h/x`) and a trailing slash, both of
    /// which are cosmetic differences that would otherwise make us reject a
    /// legitimate document — and rejecting it means refusing to log in to a
    /// working server.
    ///
    /// A missing `resource` field passes. Strictly the RFC requires it, but a
    /// non-trivial number of servers in the wild omit it, and the cost of
    /// accepting is bounded: the AS we then talk to was named by the resource
    /// server we are already connected to over TLS, so there is no new trust
    /// assumption. The cost of rejecting is a server that can never log in.
    pub fn describes(&self, resource_url: &str) -> bool {
        let Some(declared) = self.resource.as_deref() else { return true };
        match (canonical_resource_id(declared), canonical_resource_id(resource_url)) {
            (Some(a), Some(b)) => a == b,
            // An unparseable declared value cannot be compared; treat it as a
            // mismatch so the caller reports it rather than proceeding on a
            // document we could not even identify.
            _ => false,
        }
    }
}

/// RFC 8414 Authorization Server Metadata (a superset-compatible view of the
/// OpenID Connect Discovery document).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct AuthorizationServerMetadata {
    /// The issuer identifier, used to validate the document's origin.
    #[serde(default)]
    pub issuer: Option<String>,
    /// Where the user is sent to approve. Absent means the AS cannot do the
    /// authorization-code grant at all, which we report instead of failing
    /// later with an opaque "cannot build authorization URL".
    #[serde(default)]
    pub authorization_endpoint: Option<String>,
    /// Where codes and refresh tokens are exchanged.
    #[serde(default)]
    pub token_endpoint: Option<String>,
    /// RFC 8628 §3.1 device authorization endpoint. Absent means the AS does
    /// not support the Device Authorization Grant; callers must report that
    /// rather than silently falling back to a browser flow the user did not ask for.
    #[serde(default)]
    pub device_authorization_endpoint: Option<String>,
    /// RFC 7591 registration endpoint. Its absence is *not* an error — it just
    /// means dynamic registration is unavailable, so a missing `client_id` in
    /// config becomes `RegistrationFailed` with that explanation.
    #[serde(default)]
    pub registration_endpoint: Option<String>,
    /// Scopes this AS issues. Intersected with the resource's own list.
    #[serde(default, deserialize_with = "deserialize_string_or_list")]
    pub scopes_supported: Vec<String>,
    /// Response types. We need `code`.
    #[serde(default, deserialize_with = "deserialize_string_or_list")]
    pub response_types_supported: Vec<String>,
    /// Grant types. We need `authorization_code` and, to be able to renew
    /// without bothering the user again, `refresh_token`.
    #[serde(default, deserialize_with = "deserialize_string_or_list")]
    pub grant_types_supported: Vec<String>,
    /// PKCE methods; empty means "unspecified", which [`select_pkce_method`]
    /// treats as `S256` available.
    #[serde(default, deserialize_with = "deserialize_string_or_list")]
    pub code_challenge_methods_supported: Vec<String>,
    /// Client authentication methods the token endpoint accepts. Used to decide
    /// whether to request `none` (public client, the right answer for a native
    /// app per RFC 8252 §2.3) or fall back to a secret the AS hands us.
    #[serde(default, deserialize_with = "deserialize_string_or_list")]
    pub token_endpoint_auth_methods_supported: Vec<String>,
    /// Human docs, surfaced in errors like `resource_documentation`.
    #[serde(default)]
    pub service_documentation: Option<String>,
    /// Which URL this document came from (see `source_url`).
    #[serde(skip)]
    pub source_url: String,
}

impl AuthorizationServerMetadata {
    /// Can this AS complete an authorization-code + PKCE flow?
    ///
    /// Checked once, up front, so a half-published AS produces one clear error
    /// naming what is missing instead of failing at whichever step happens to
    /// need it — the latter reads like a bug in this client.
    pub fn missing_required_endpoints(&self) -> Vec<&'static str> {
        let mut missing = Vec::new();
        if self.authorization_endpoint.as_deref().unwrap_or("").trim().is_empty() {
            missing.push("authorization_endpoint");
        }
        if self.token_endpoint.as_deref().unwrap_or("").trim().is_empty() {
            missing.push("token_endpoint");
        }
        missing
    }

    /// Does the AS accept the public-client (`none`) token auth method?
    ///
    /// An empty list means "unspecified", and RFC 7591 §2 says an AS that does
    /// not state one may assign any; `none` is what RFC 8252 recommends for
    /// native apps, so unspecified is treated as acceptable and the AS's own
    /// registration response is the authority (see [`ClientRegistration::is_public`]).
    pub fn allows_public_client(&self) -> bool {
        self.token_endpoint_auth_methods_supported.is_empty()
            || self
                .token_endpoint_auth_methods_supported
                .iter()
                .any(|m| m.eq_ignore_ascii_case("none"))
    }

    /// Does the AS advertise the refresh-token grant?
    ///
    /// RFC 8414 §2: when `grant_types_supported` is omitted the default is
    /// `authorization_code` and `implicit` — refresh is *not* implied. So an
    /// empty list means "unknown", which we treat as supported (asking for a
    /// refresh token from an AS that does not issue one is harmless: it just
    /// omits `refresh_token` from the response) while an explicit list without
    /// it means tokens will have to be re-authorized on expiry. The caller uses
    /// that to set expectations in the UI rather than to change behaviour.
    pub fn supports_refresh(&self) -> bool {
        self.grant_types_supported.is_empty()
            || self
                .grant_types_supported
                .iter()
                .any(|g| g.eq_ignore_ascii_case("refresh_token"))
    }
}

/// Accept either `"a"` or `["a","b"]` for a metadata list field.
///
/// RFC 8414 §2 types these as arrays, and real servers disagree: several publish
/// `scopes_supported` as a single string, and OpenID Connect's own examples do
/// the same for some fields. Without this, a string value fails deserialization
/// of the *whole document*, so one sloppy field takes down discovery — the exact
/// failure mode the parent module warns about for `McpServerConfig`. Being
/// liberal in what we accept costs nothing here (these are read-only hints) and
/// keeps a working server working.
fn deserialize_string_or_list<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    #[allow(dead_code)] // `Missing`'s payload is intentionally never inspected
    enum OneOrMany {
        One(String),
        Many(Vec<String>),
        Missing(serde_json::Value),
    }
    Ok(match Option::<OneOrMany>::deserialize(deserializer)? {
        None => Vec::new(),
        Some(OneOrMany::One(s)) => s.split_whitespace().map(|p| p.to_string()).collect(),
        Some(OneOrMany::Many(v)) => v.into_iter().filter(|s| !s.is_empty()).collect(),
        // A non-string, non-array value (null, object, number). Ignoring it is
        // right: we cannot use it, and erroring would kill the document.
        Some(OneOrMany::Missing(_)) => Vec::new(),
    })
}

/// Canonical form of a resource identifier for comparison.
///
/// Drops the default port for the scheme and a trailing slash, and lowercases the
/// host (RFC 3986 §6.2.2: scheme and host are case-insensitive, the path is
/// not). Returns `None` for anything that is not an absolute http(s) URL.
fn canonical_resource_id(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw.trim()).ok()?;
    if !is_http_family(&url) {
        return None;
    }
    let host = url.host_str()?.to_lowercase();
    // `url::Url::parse` already normalises an explicitly written *default*
    // port (`:443` on https, `:80` on http) to `None` — see `parse_port` in the
    // url crate, which discards `opt_port == default_port`. So `Url::port()`
    // is exactly the set of ports that are part of the identity: any
    // non-default port. Comparing against `port_or_known_default()` here is
    // wrong: that method returns `self.port` when a port exists, so comparing
    // `Some(p)` with it would always be equal and would silently drop a port
    // such as `:8443`, making `https://h:8443/mcp` compare equal to
    // `https://h/mcp` (an RFC 8707 audience-confusion bug).
    let port = url.port();
    let path = url.path();
    let path = path.trim_end_matches('/');
    Some(match port {
        Some(p) => format!("{}://{}:{}{}", url.scheme(), bracket_if_v6(&host), p, path),
        None => format!("{}://{}{}", url.scheme(), bracket_if_v6(&host), path),
    })
}

/* ─────────────────────── Transport + injectable clock ─────────────────────── */

/// Wall-clock source, injectable so expiry logic is testable without sleeping.
///
/// `expires_in` handling is the easiest part of this module to get subtly wrong
/// and the hardest to notice: a token treated as live 60s past its real expiry
/// produces a 401 on the next MCP call, which reads as "the server rejected us"
/// rather than "our clock math is off". Testing it for real would mean a
/// 10-minute test or a mock AS that issues 1-second tokens; a fake clock does it
/// deterministically in microseconds.
#[derive(Clone)]
pub struct Clock(Arc<dyn Fn() -> i64 + Send + Sync>);

impl Clock {
    /// System clock, seconds since the Unix epoch.
    pub fn system() -> Self {
        Self(Arc::new(|| chrono::Utc::now().timestamp()))
    }

    /// A clock pinned to one instant, for tests.
    pub fn fixed(epoch_seconds: i64) -> Self {
        Self(Arc::new(move || epoch_seconds))
    }

    /// A clock that advances by a fixed step on every read, for tests that need
    /// "time passes" without a real delay.
    pub fn stepping(start: i64, step_seconds: i64) -> Self {
        let current = Arc::new(std::sync::atomic::AtomicI64::new(start));
        let step = Arc::new(std::sync::atomic::AtomicI64::new(step_seconds));
        Self(Arc::new(move || {
            let now = current.load(std::sync::atomic::Ordering::SeqCst);
            current.fetch_add(step.load(std::sync::atomic::Ordering::SeqCst), std::sync::atomic::Ordering::SeqCst);
            now
        }))
    }

    /// Current time in seconds since the epoch.
    pub fn now(&self) -> i64 {
        (self.0)()
    }
}

impl std::fmt::Debug for Clock {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Printing the closure's address is noise; what matters is that the value
        // is readable, and reading it in a Debug impl would advance a stepping
        // test clock. So report the type only.
        f.write_str("Clock(<fn>)")
    }
}

impl Default for Clock {
    fn default() -> Self {
        Self::system()
    }
}

/// HTTP transport for the OAuth protocol exchanges.
///
/// Wraps a `reqwest::Client` rather than taking one per call so the connection
/// pool, proxy configuration and timeouts are set once and cannot differ between
/// the discovery, registration and token steps of a single flow — a per-call
/// client would silently rebuild TLS state every hop.
///
/// The client is built by [`OAuthClient::new`], **not** by
/// `McpManager::http_client`: see the module-level note about leaking the
/// resource server's `Authorization` header to the authorization server.
pub struct OAuthClient {
    http: reqwest::Client,
    clock: Clock,
}

impl OAuthClient {
    /// Build a client for one MCP server's authorization flow.
    ///
    /// `config` is used only for its `proxy` (via `McpManager::client_builder`)
    /// and `timeout`. Its `headers` are deliberately **not** applied — see the
    /// module docs. `timeout` is the *per-request* cap for discovery and token
    /// calls, which are all short request/response exchanges; the browser wait is
    /// timed separately by [`RedirectListener`] because it is legitimately minutes
    /// long.
    pub fn new(config: &McpServerConfig) -> anyhow::Result<Self> {
        Self::with_clock(config, Clock::system())
    }

    /// [`Self::new`] with an explicit clock (tests).
    pub fn with_clock(config: &McpServerConfig, clock: Clock) -> anyhow::Result<Self> {
        // `client_builder` is the shared proxy-applying builder in mod.rs, so an
        // MCP server behind a corporate proxy still reaches its AS. Reusing it
        // rather than copying the proxy logic is what keeps the two from drifting.
        let http = super::McpManager::client_builder(config)?
            .timeout(super::parse_timeout(&config.timeout))
            .build()?;
        Ok(Self { http, clock })
    }

    /// Wrap a pre-built reqwest client (tests, or a caller that must control TLS).
    pub fn from_parts(http: reqwest::Client, clock: Clock) -> Self {
        Self { http, clock }
    }

    /// The clock this client stamps tokens with.
    pub fn clock(&self) -> &Clock {
        &self.clock
    }

    /// GET a metadata document.
    ///
    /// A 404 is returned as `None`, not an error: both RFC 8414 and RFC 9728
    /// define *trying* well-known URLs that do not exist as the normal path, and
    /// [`authorization_server_metadata_candidates`] returns two of them. Treating
    /// a 404 as fatal would make the first candidate's absence abort discovery
    /// before the second is tried.
    async fn get_json(&self, url: &str) -> Result<Option<serde_json::Value>, OAuthError> {
        let resp = self
            .http
            .get(url)
            // Some ASes content-negotiate and answer `*/*` with HTML; asking for
            // JSON explicitly is cheap and avoids a parse error that reads like a
            // broken server.
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|e| OAuthError::Local {
                reason: format!("GET {} failed: {}", super::truncate(url, 160), super::humanize_connect_error(&e.to_string(), "http")),
            })?;
        let status = resp.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(OAuthError::Local {
                reason: format!("GET {} returned HTTP {}: {}", super::truncate(url, 160), status.as_u16(), super::truncate(&text, 200)),
            });
        }
        // An empty 200 body is a real failure, not a `None`: the URL exists and
        // answered, so falling through to the next candidate would hide a
        // misconfigured server behind a confusing "no metadata found".
        if text.trim().is_empty() {
            return Err(OAuthError::Local {
                reason: format!("GET {} returned an empty body", super::truncate(url, 160)),
            });
        }
        serde_json::from_str::<serde_json::Value>(&text)
            .map(Some)
            .map_err(|e| OAuthError::Local {
                reason: format!("{} did not return JSON: {} ({})", super::truncate(url, 160), e, super::truncate(&text, 200)),
            })
    }

    /// POST `application/x-www-form-urlencoded`, as every OAuth token/registration
    /// call requires (RFC 6749 §4.1.3 uses the form encoding; JSON is not
    /// permitted here, and a server that accepts it is not conforming).
    /// Read a response body to text, turning a read failure into an error.
    ///
    /// Previously `unwrap_or_default()`, which made a body that failed to
    /// download (connection reset mid-stream, TLS truncation, timeout while
    /// reading) indistinguishable from an *empty* body. At the token endpoint
    /// that misdiagnosis is actively harmful: the empty string parses to
    /// `Value::Null`, so `TokenResponse::parse` reports "token response carries
    /// no `access_token`" — an error that reads like the AS rejected the
    /// request, when in fact it may well have granted it. That sends the user
    /// re-authorizing instead of retrying a network blip, and sends whoever
    /// debugs it looking at the wrong layer.
    async fn read_body_text(resp: reqwest::Response, url: &str) -> Result<String, OAuthError> {
        resp.text().await.map_err(|e| OAuthError::Local {
            reason: format!(
                "reading the response body from {} failed: {} — the request may have succeeded; \
                 retrying a token request is not safe, so re-authorize if this persists",
                super::truncate(url, 160),
                super::humanize_connect_error(&e.to_string(), "http")
            ),
        })
    }

    async fn post_form(
        &self,
        url: &str,
        form: Vec<(String, String)>,
        basic_auth: Option<(&str, &str)>,
    ) -> Result<(u16, serde_json::Value, String), OAuthError> {
        let mut req = self
            .http
            .post(url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .form(&form);
        if let Some((user, pass)) = basic_auth {
            req = req.basic_auth(user, Some(pass));
        }
        let resp = req.send().await.map_err(|e| OAuthError::Local {
            reason: format!(
                "POST {} failed: {}",
                super::truncate(url, 160),
                super::humanize_connect_error(&e.to_string(), "http")
            ),
        })?;
        let status = resp.status().as_u16();
        let text = Self::read_body_text(resp, url).await?;
        // A body that is not JSON is not an error: several ASes return an HTML
        // error page with a 5xx. Keep the raw text so `oauth_error_message` can
        // quote it, and let the caller classify by status.
        let value: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
        Ok((status, value, text))
    }

    /// POST a JSON body, which is what RFC 7591 registration uses.
    ///
    /// Unlike the token endpoint, RFC 7591 §3 defines registration as a JSON
    /// request, so the two content types in this module are both correct and the
    /// distinction is not a bug.
    async fn post_json(
        &self,
        url: &str,
        body: &serde_json::Value,
    ) -> Result<(u16, serde_json::Value, String), OAuthError> {
        let resp = self
            .http
            .post(url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .json(body)
            .send()
            .await
            .map_err(|e| OAuthError::Local {
                reason: format!(
                    "POST {} failed: {}",
                    super::truncate(url, 160),
                    super::humanize_connect_error(&e.to_string(), "http")
                ),
            })?;
        let status = resp.status().as_u16();
        let text = Self::read_body_text(resp, url).await?;
        let value: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
        Ok((status, value, text))
    }
}

/* ───────────────────────────── Discovery ───────────────────────────── */

/// RFC 9728 §4: fetch Protected Resource Metadata for a server.
///
/// The `challenge` is what the 401 carried. Its `resource_metadata` parameter is
/// used verbatim when present — the resource server is telling us exactly where
/// its document lives, which may be on a different host or a non-well-known path
/// (a shared gateway serving many resources). Only when that parameter is absent
/// do we derive the well-known URL from the resource identifier, which is what
/// pre-RFC-9728 servers need.
///
/// `resource_id` is the identifier the client will send as the RFC 8707
/// `resource` parameter, and it is validated against the document's `resource`
/// field via [`ProtectedResourceMetadata::describes`]. Callers that derived the
/// metadata URL from the resource identifier itself already know the two
/// correspond; this function still performs the check, which passes for a
/// document that declares the same (canonically compared) resource.
pub async fn fetch_protected_resource_metadata(
    client: &OAuthClient,
    server_url: &str,
    resource_id: &str,
    challenge: &UnauthorizedChallenge,
) -> Result<ProtectedResourceMetadata, OAuthError> {
    let metadata_url = match challenge.resource_metadata.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        // An explicitly advertised URL wins, but it must be absolute http(s): a
        // relative or foreign-scheme value would send our discovery request
        // somewhere we did not intend, and this value came off a response header
        // we did not choose.
        Some(advertised) => {
            let parsed = url::Url::parse(advertised).map_err(|e| OAuthError::DiscoveryFailed {
                stage: DiscoveryStage::ProtectedResourceMetadata,
                url: advertised.to_string(),
                reason: format!("`resource_metadata` is not an absolute URL: {}", e),
            })?;
            if !is_http_family(&parsed) {
                return Err(OAuthError::DiscoveryFailed {
                    stage: DiscoveryStage::ProtectedResourceMetadata,
                    url: advertised.to_string(),
                    reason: format!("`resource_metadata` uses unsupported scheme {:?}", parsed.scheme()),
                });
            }
            advertised.to_string()
        }
        None => protected_resource_metadata_url(server_url).ok_or_else(|| OAuthError::DiscoveryFailed {
            stage: DiscoveryStage::ProtectedResourceMetadata,
            url: server_url.to_string(),
            reason: "cannot derive a well-known metadata URL from the server URL (not an absolute http(s) URL?)".into(),
        })?,
    };

    let value = client
        .get_json(&metadata_url)
        .await?
        .ok_or_else(|| OAuthError::DiscoveryFailed {
            stage: DiscoveryStage::ProtectedResourceMetadata,
            url: metadata_url.clone(),
            reason: "no metadata document published (HTTP 404)".into(),
        })?;
    let mut prm: ProtectedResourceMetadata =
        serde_json::from_value(value).map_err(|e| OAuthError::DiscoveryFailed {
            stage: DiscoveryStage::ProtectedResourceMetadata,
            url: metadata_url.clone(),
            reason: format!("document does not match RFC 9728: {}", e),
        })?;
    prm.source_url = metadata_url.clone();

    // RFC 9728 §4.2: a document whose `resource` names something else is either
    // stale or belongs to a different service sharing the host. Proceeding would
    // ask the wrong AS for a token the resource server will reject — a much more
    // confusing failure than this one.
    if !prm.describes(resource_id) {
        return Err(OAuthError::DiscoveryFailed {
            stage: DiscoveryStage::ProtectedResourceMetadata,
            url: metadata_url,
            reason: format!(
                "document declares resource {:?} but we are connecting to {:?}",
                prm.resource.as_deref().unwrap_or(""),
                resource_id
            ),
        });
    }
    if prm.authorization_servers.is_empty() {
        return Err(OAuthError::DiscoveryFailed {
            stage: DiscoveryStage::ProtectedResourceMetadata,
            url: metadata_url,
            reason: "document lists no `authorization_servers`".into(),
        });
    }
    Ok(prm)
}

/// RFC 8414 §5: locate and fetch Authorization Server Metadata for an issuer.
///
/// Tries every URL in [`authorization_server_metadata_candidates`] in order and
/// returns the first that yields a document. Both spellings are attempted (see
/// that function) because servers publish either one and a client that guesses
/// wrong fails against an otherwise healthy AS.
///
/// The collected per-URL reasons are joined into the final error: a bare "not
/// found" after two attempts tells the user nothing about *which* URL to ask
/// their server admin to fix.
pub async fn fetch_authorization_server_metadata(
    client: &OAuthClient,
    issuer: &str,
) -> Result<AuthorizationServerMetadata, OAuthError> {
    let candidates = authorization_server_metadata_candidates(issuer);
    if candidates.is_empty() {
        return Err(OAuthError::DiscoveryFailed {
            stage: DiscoveryStage::AuthorizationServerMetadata,
            url: issuer.to_string(),
            reason: "issuer is not an absolute http(s) URL, so no well-known metadata URL can be derived".into(),
        });
    }
    let mut reasons: Vec<String> = Vec::new();
    for candidate in &candidates {
        match client.get_json(candidate).await {
            Ok(Some(value)) => {
                let mut meta: AuthorizationServerMetadata =
                    serde_json::from_value(value).map_err(|e| OAuthError::DiscoveryFailed {
                        stage: DiscoveryStage::AuthorizationServerMetadata,
                        url: candidate.clone(),
                        reason: format!("document does not match RFC 8414: {}", e),
                    })?;
                meta.source_url = candidate.clone();
                // RFC 8414 §3.3: the `issuer` in the document must match the
                // issuer we asked about. Skipping this lets a compromised or
                // misconfigured mirror redirect our users to *its* login page,
                // which is how credential-phishing flows start. A missing
                // `issuer` cannot be checked, and rejecting on absence would
                // break real servers, so it is accepted.
                if let Some(declared) = meta.issuer.as_deref() {
                    if canonical_resource_id(declared).is_some()
                        && canonical_resource_id(declared) != canonical_resource_id(issuer)
                    {
                        return Err(OAuthError::DiscoveryFailed {
                            stage: DiscoveryStage::AuthorizationServerMetadata,
                            url: candidate.clone(),
                            reason: format!(
                                "document issuer {:?} does not match the expected issuer {:?}",
                                declared, issuer
                            ),
                        });
                    }
                }
                let missing = meta.missing_required_endpoints();
                if !missing.is_empty() {
                    return Err(OAuthError::DiscoveryFailed {
                        stage: DiscoveryStage::IncompleteMetadata,
                        url: candidate.clone(),
                        reason: format!("document is missing {}", missing.join(" and ")),
                    });
                }
                return Ok(meta);
            }
            Ok(None) => reasons.push(format!("{} → not found", candidate)),
            Err(e) => reasons.push(format!("{} → {}", candidate, e)),
        }
    }
    Err(OAuthError::DiscoveryFailed {
        stage: DiscoveryStage::AuthorizationServerMetadata,
        url: issuer.to_string(),
        reason: format!("no usable metadata at: {}", reasons.join("; ")),
    })
}

/// The authorization server to use, from PRM or (as a fallback) the resource
/// host itself.
///
/// RFC 9728 §4.2 allows `authorization_servers` to be empty, meaning "the
/// resource server acts as its own AS". Several MCP hosts do exactly that, so
/// the fallback to the server's own origin is required for those to work — and
/// it is safe, because that origin is the one the user configured and we already
/// connected to over TLS.
pub fn primary_authorization_server(prm: &ProtectedResourceMetadata, server_url: &str) -> Option<String> {
    prm.authorization_servers
        .iter()
        .find(|s| !s.trim().is_empty())
        .cloned()
        .or_else(|| {
            // Derive the origin (`scheme://host[:port]`) rather than reusing
            // `server_url` verbatim: the metadata URL must be built from the
            // issuer root, and passing a path-bearing URL would make
            // `authorization_server_metadata_url` insert our path into the
            // well-known URL.
            let url = url::Url::parse(server_url).ok()?;
            if !is_http_family(&url) {
                return None;
            }
            let host = url.host_str()?;
            match url.port() {
                Some(p) => Some(format!("{}://{}:{}", url.scheme(), bracket_if_v6(host), p)),
                None => Some(format!("{}://{}", url.scheme(), bracket_if_v6(host))),
            }
        })
}

/// The resource identifier sent as RFC 8707 `resource`.
///
/// Canonicalised to scheme + host + port + path with the query dropped: RFC 8707
/// §2 defines the indicator as identifying the *resource server*, and a query
/// string is per-request data (a session id, a tenant hint) that varies between
/// calls to the same server. Including it would bind the token to one request
/// and make every subsequent call fail audience validation.
///
/// Returns `None` when the URL is unparseable, in which case callers omit the
/// parameter entirely — sending an empty `resource` is worse than omitting it,
/// because an AS that validates audience strictly rejects the empty value while
/// one that ignores the parameter accepts the omission.
pub fn resource_indicator(server_url: &str) -> Option<String> {
    canonical_resource_id(server_url)
}

/// Scopes to request, given what the resource understands and what the AS issues.
///
/// Intersection, then the caller's explicit override wins. The reasoning:
/// requesting a scope the AS does not issue is a hard error on strict servers
/// (`invalid_scope`) that fails the whole login, and requesting a scope the
/// resource does not understand is silently useless. The intersection is the only
/// set that is guaranteed to satisfy both.
///
/// An empty result means "ask for the AS default", which is correct — omitting
/// `scope` lets the AS grant its default set (RFC 6749 §3.3), whereas sending
/// `scope=` (empty) is malformed.
pub fn negotiate_scopes(prm_scopes: &[String], as_scopes: &[String], override_scopes: &[String]) -> Vec<String> {
    // An explicit request from config or from a previous `insufficient_scope`
    // 401 outranks both metadata documents: the user or the server has told us
    // what they want, and second-guessing that with an intersection is how a
    // re-authorization loop after a scope error never terminates.
    let requested: Vec<String> = override_scopes
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if !requested.is_empty() {
        return requested;
    }
    if prm_scopes.is_empty() || as_scopes.is_empty() {
        // One side advertises nothing, so there is no meaningful intersection to
        // compute. Returning empty (→ omit the parameter) is right: guessing a
        // scope like `openid` or `mcp` would fail `invalid_scope` on servers
        // that do not define it.
        return Vec::new();
    }
    // Preserve the *resource's* order: it is the party that will consume the
    // scopes, and its advertised order usually reflects importance.
    prm_scopes
        .iter()
        .filter(|s| {
            let t = s.trim();
            !t.is_empty() && as_scopes.iter().any(|a| a.trim() == t)
        })
        .cloned()
        .collect()
}

/* ─────────────── Dynamic Client Registration (RFC 7591) ─────────────── */

/// A registered OAuth client, whether dynamically registered or pre-configured.
///
/// Both cases collapse into this one shape so the token-exchange code does not
/// branch on provenance. That matters for correctness, not tidiness: a
/// pre-configured `client_id` with a `client_secret` is a *confidential* client
/// and must authenticate to the token endpoint differently from a registered
/// public client, and getting the branch wrong produces `invalid_client` — an
/// error that reads like a bad password rather than a wrong auth method.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientRegistration {
    /// The `client_id`.
    pub client_id: String,
    /// The `client_secret`, only for confidential clients. Native apps are
    /// public clients (RFC 8252 §2.3) and should have no secret — one embedded in
    /// a desktop binary is not a secret, and pretending otherwise gives false
    /// assurance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    /// `token_endpoint_auth_method` as the AS assigned it, or `"none"` for a
    /// public client. Kept verbatim from the registration response because that
    /// response is the authority; our request is only a preference.
    #[serde(default)]
    pub token_endpoint_auth_method: String,
    /// The redirect URIs the AS accepted. Must include the loopback URI we
    /// actually use, and we re-check at authorize time: some ASes rewrite
    /// `127.0.0.1:<random port>` registrations to a fixed set.
    #[serde(default)]
    pub redirect_uris: Vec<String>,
    /// RFC 7591 §3.2.1 `registration_access_token`, for later management calls.
    /// We do not currently issue those calls, but dropping the token would make
    /// de-registration impossible without a fresh registration, so it is stored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registration_access_token: Option<String>,
    /// RFC 7591 §3.2.1 `registration_client_uri`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registration_client_uri: Option<String>,
    /// Scopes granted at registration time, if the AS narrowed our request.
    #[serde(default)]
    pub scope: Vec<String>,
    /// Where this client came from. Persisted so a later run can explain to the
    /// user why a `client_id` exists that they never typed.
    #[serde(default)]
    pub source: ClientSource,
}

/// Provenance of a [`ClientRegistration`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ClientSource {
    /// The user put `client_id`/`client_secret` in the server's config.
    Configured,
    /// We registered it via RFC 7591 during a previous authorize run.
    #[default]
    Registered,
}

impl ClientRegistration {
    /// Is this a public client (no secret, `none` auth method)?
    ///
    /// Drives token-endpoint authentication: a public client must **not** send a
    /// `Basic` Authorization header (RFC 6749 §2.3.1 reserves that for clients
    /// with credentials) and instead puts `client_id` in the form body. Sending
    /// `Basic <id>:` with an empty password is a real-world bug — Keycloak and
    /// Okta both reject it with `invalid_client`, and the failure looks identical
    /// to a wrong secret.
    pub fn is_public(&self) -> bool {
        self.client_secret.as_deref().map(|s| s.trim().is_empty()).unwrap_or(true)
            && !self.token_endpoint_auth_method.eq_ignore_ascii_case("client_secret_basic")
            && !self.token_endpoint_auth_method.eq_ignore_ascii_case("client_secret_post")
    }
}

/// The RFC 7591 registration request body.
///
/// Built by [`registration_body`] rather than inline so the field choices are
/// testable without a live AS — and they are choices worth pinning, because an
/// AS validates them strictly and a wrong value yields `invalid_client_metadata`
/// with a message that names the field but not the fix.
pub fn registration_body(
    redirect_uris: &[String],
    scopes: &[String],
    client_name: &str,
) -> serde_json::Value {
    let mut body = serde_json::Map::new();
    // `redirect_uris` is REQUIRED in practice: without it the AS cannot validate
    // the callback, and RFC 8252 §7.3 requires exact-match registration of the
    // loopback URI. The port is random per run (see `RedirectListener`), so the
    // caller registers a set of candidate ports; ASes that accept a wildcard
    // loopback pattern get the full range.
    body.insert("redirect_uris".into(), serde_json::Value::Array(redirect_uris.iter().map(|u| serde_json::Value::String(u.clone())).collect()));
    // `authorization_code` only. Requesting `implicit` or
    // `client_credentials` here would ask an AS to enable flows OAuth 2.1 has
    // removed, and some ASes refuse the whole registration when any requested
    // grant is disallowed by their policy.
    body.insert(
        "grant_types".into(),
        serde_json::json!(["authorization_code", "refresh_token"]),
    );
    // Must match `grant_types`: `code` is the response type of the
    // authorization-code grant. An AS cross-validates these two and rejects a
    // mismatch.
    body.insert("response_types".into(), serde_json::json!(["code"]));
    // `none` = public client. This is the RFC 8252 §2.3 answer for native apps
    // and, crucially, does not put a fake secret in the binary.
    body.insert("token_endpoint_auth_method".into(), serde_json::json!("none"));
    if !scopes.is_empty() {
        // Space-delimited per RFC 6749 §3.3, not a JSON array — RFC 7591 §2
        // follows the core spec here and an array is rejected by strict ASes.
        body.insert("scope".into(), serde_json::json!(scopes.join(" ")));
    }
    let name = client_name.trim();
    if !name.is_empty() {
        // Purely cosmetic on the AS's consent screen, but it is what the user
        // reads when deciding to approve, so a blank name makes the prompt
        // look like an attack.
        body.insert("client_name".into(), serde_json::json!(name));
    }
    // `application_type: native` tells the AS this is an installed app, which
    // some ASes use to allow loopback redirects at all. RFC 7591 §2 defines it
    // by reference to OIDC; harmless where unsupported.
    body.insert("application_type".into(), serde_json::json!("native"));
    serde_json::Value::Object(body)
}

/// Register a client via RFC 7591.
///
/// Every failure returns [`OAuthError::RegistrationFailed`] carrying the HTTP
/// status and the server's own `error_description`. The status is not decoration:
/// `403` means the AS forbids dynamic registration (fix: get a `client_id` from
/// the provider and put it in config), `400` means our metadata was rejected
/// (fix: usually the redirect URI form), and `501` means the endpoint exists in
/// metadata but is not implemented. Each has a different remedy and the user
/// needs to be told which.
pub async fn register_client(
    client: &OAuthClient,
    metadata: &AuthorizationServerMetadata,
    redirect_uris: &[String],
    scopes: &[String],
    client_name: &str,
) -> Result<ClientRegistration, OAuthError> {
    let url = metadata.registration_endpoint.as_deref().unwrap_or("").trim();
    if url.is_empty() {
        return Err(OAuthError::RegistrationFailed {
            url: metadata.source_url.clone(),
            status: None,
            reason: "the authorization server does not publish a `registration_endpoint`, so dynamic \
                     client registration is unavailable — set `client_id` (and `client_secret` if \
                     required) in this MCP server's config instead"
                .into(),
        });
    }
    let body = registration_body(redirect_uris, scopes, client_name);
    let (status, value, text) = client.post_json(url, &body).await?;

    // 2xx with a `client_id` is success. Anything else becomes an error carrying
    // the server's own words, which are almost always more useful than ours.
    let client_id = value.get("client_id").and_then(|v| v.as_str()).unwrap_or("").trim();
    if !(200..=299).contains(&status) || client_id.is_empty() {
        let reason = if client_id.is_empty() && (200..=299).contains(&status) {
            format!(
                "registration succeeded (HTTP {}) but the response carries no `client_id`: {}",
                status,
                super::truncate(&text, 300)
            )
        } else {
            oauth_error_message(&value, &text, status)
        };
        return Err(OAuthError::RegistrationFailed { url: url.to_string(), status: Some(status), reason });
    }

    let secret = value
        .get("client_secret")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty());
    // The AS decides the auth method; we only requested `none`. Honouring its
    // answer is what keeps `is_public()` correct — assuming `none` when the AS
    // assigned `client_secret_post` would omit the secret from the token request.
    let auth_method = value
        .get("token_endpoint_auth_method")
        .and_then(|v| v.as_str())
        .unwrap_or(if secret.is_some() { "client_secret_post" } else { "none" })
        .to_string();
    let redirect_uris = match value.get("redirect_uris") {
        Some(serde_json::Value::Array(a)) => a.iter().filter_map(|v| v.as_str()).map(|s| s.to_string()).collect(),
        // An AS that does not echo them back has accepted ours implicitly.
        _ => redirect_uris.to_vec(),
    };
    let scope = value
        .get("scope")
        .and_then(|v| v.as_str())
        .map(|s| s.split_whitespace().map(|p| p.to_string()).collect())
        .unwrap_or_else(|| scopes.to_vec());

    Ok(ClientRegistration {
        client_id: client_id.to_string(),
        client_secret: secret,
        token_endpoint_auth_method: auth_method,
        redirect_uris,
        registration_access_token: value
            .get("registration_access_token")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        registration_client_uri: value
            .get("registration_client_uri")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        scope,
        source: ClientSource::Registered,
    })
}

/// Extract the most useful message from an OAuth error response.
///
/// Prefers RFC 6749 §5.2's `error_description`, falls back to the `error` code,
/// and finally to a truncated raw body. The raw body is last because it is often
/// an HTML error page from a proxy in front of the AS, which is noise next to a
/// precise `invalid_client`.
fn oauth_error_message(value: &serde_json::Value, raw_body: &str, status: u16) -> String {
    if let Some(desc) = value.get("error_description").and_then(|v| v.as_str()) {
        if !desc.trim().is_empty() {
            let code = value.get("error").and_then(|v| v.as_str()).unwrap_or("");
            return if code.is_empty() { desc.trim().to_string() } else { format!("{} ({})", desc.trim(), code) };
        }
    }
    if let Some(code) = value.get("error").and_then(|v| v.as_str()) {
        if !code.trim().is_empty() {
            return code.trim().to_string();
        }
    }
    if !raw_body.trim().is_empty() {
        return format!("HTTP {} with body: {}", status, super::truncate(raw_body.trim(), 300));
    }
    format!("HTTP {} with an empty body", status)
}

/* ────────────────────────── Credential storage ────────────────────────── */

/// How far before real expiry a token is treated as expired.
///
/// Refreshing *at* expiry guarantees a 401: the request that triggers the check
/// is already in flight, and the token can die between the check and the server's
/// validation. Refreshing half a minute early absorbs clock skew between us and
/// the AS plus request latency. 30s is short enough that a 60-second token still
/// gets most of its useful life and long enough to cover a slow network.
pub const EXPIRY_SKEW_SECONDS: i64 = 30;

/// Endpoints captured at authorize time so a later refresh does not need to redo
/// discovery.
///
/// Persisted alongside the tokens deliberately. The alternative — re-running
/// RFC 9728 + RFC 8414 on every refresh — costs two HTTP round trips per renewal
/// and, worse, fails closed: if the AS's metadata endpoint has a transient outage
/// exactly when a token expires, the user is logged out of a server whose token
/// endpoint would have worked fine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct TokenEndpoints {
    /// RFC 8414 `token_endpoint`, used for both code exchange and refresh.
    #[serde(default)]
    pub token_endpoint: String,
    /// Where the user is sent, if a full re-authorization becomes necessary.
    #[serde(default)]
    pub authorization_endpoint: String,
    /// RFC 8414 `registration_endpoint`, needed if the AS rotates client ids.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registration_endpoint: Option<String>,
    /// The AS issuer, for error messages and for re-discovery if ever needed.
    #[serde(default)]
    pub issuer: String,
}

/// The tool list discovered from an MCP server, kept across token refreshes.
///
/// This is the "do not lose what already worked" requirement, made concrete. The
/// agent's system prompt is built from `tools`, so dropping it on a transient AS
/// failure means the model loses the ability to *call* those tools even though
/// nothing about the MCP server changed. Re-discovery also costs a full
/// `initialize` + `tools/list` handshake against a server that may be rate-limiting.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct DiscoveredCapabilities {
    /// MCP server name these tools belong to (matches `McpTool::server_name`).
    #[serde(default)]
    pub server_name: String,
    /// The `tools/list` result verbatim, so `parse_tools` can be re-run against it
    /// without a network call. Stored as raw JSON rather than `Vec<McpTool>`
    /// because `McpTool` is not `Serialize` and adding derives to a type in
    /// another module is out of scope for this file.
    #[serde(default)]
    pub tools_list_result: Option<serde_json::Value>,
    /// Negotiated protocol version, echoed on reconnect.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<String>,
    /// `Mcp-Session-Id` from the last successful handshake, if the server issued
    /// one. Sessions are usually invalidated by a token change, so this is a hint
    /// rather than a promise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// When the discovery happened, for "stale since" reporting in the UI.
    #[serde(default)]
    pub discovered_at: i64,
}

impl DiscoveredCapabilities {
    /// Is anything actually remembered here?
    pub fn is_empty(&self) -> bool {
        self.tools_list_result.is_none() && self.server_name.is_empty()
    }
}

/// A persisted OAuth credential set for one MCP server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredCredentials {
    /// Current access token.
    pub access_token: String,
    /// Refresh token, absent when the AS did not issue one (common for ASes that
    /// expect re-authorization instead, and for `implicit`-only servers).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// `token_type` from the token response; `Bearer` in practice. Kept from the
    /// response rather than hardcoded because RFC 6749 allows others and a
    /// server that says `DPoP` must not be answered with `Bearer`.
    #[serde(default = "default_token_type")]
    pub token_type: String,
    /// Absolute expiry in epoch seconds, derived from `expires_in` at store time.
    ///
    /// Stored as an absolute instant, **not** as the relative `expires_in` the AS
    /// returned: the relative value is meaningless once the process restarts, and
    /// recomputing it at load would require also persisting the load time.
    /// `None` means the AS gave no expiry — treated as "unknown", so callers must
    /// use the token and handle a 401 rather than pre-emptively refreshing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    /// Scopes actually granted (the AS may narrow what we asked for).
    #[serde(default)]
    pub scope: Vec<String>,
    /// When this credential set was written, for diagnostics.
    #[serde(default)]
    pub stored_at: i64,
    /// The RFC 8707 resource indicator this token was minted for. Verified before
    /// use: a credential written for one server must never be presented to another.
    #[serde(default)]
    pub resource: String,
    /// The AS that issued it.
    #[serde(default)]
    pub authorization_server: String,
    /// Endpoints, so refresh needs no discovery.
    #[serde(default)]
    pub endpoints: TokenEndpoints,
    /// Client identity (public or confidential).
    pub client: ClientRegistration,
    /// Remembered tool list; survives refresh failures.
    #[serde(default)]
    pub capabilities: DiscoveredCapabilities,
}

fn default_token_type() -> String {
    "Bearer".to_string()
}

impl StoredCredentials {
    /// Is the access token still usable at `now`?
    ///
    /// Unknown expiry (`expires_at: None`) counts as usable. The AS did not give
    /// us a deadline, so assuming one would make us refresh (or worse, refuse to
    /// send) a token that is perfectly valid; the correct behaviour is to send it
    /// and let a 401 tell us otherwise.
    pub fn is_valid(&self, now: i64) -> bool {
        match self.expires_at {
            Some(exp) => now < exp.saturating_sub(EXPIRY_SKEW_SECONDS),
            None => !self.access_token.trim().is_empty(),
        }
    }

    /// Is it expired (or expiring within the skew window)?
    pub fn is_expired(&self, now: i64) -> bool {
        !self.is_valid(now)
    }

    /// Can this be renewed without user interaction?
    ///
    /// Needs both a refresh token and a token endpoint. Checked together because
    /// a refresh token without an endpoint is unrenewable, and the caller must
    /// know to go straight to `NeedsAuthorization` instead of failing a request
    /// it could have made.
    pub fn can_refresh(&self) -> bool {
        self.refresh_token.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false)
            && !self.endpoints.token_endpoint.trim().is_empty()
    }

    /// Seconds until expiry, or `None` when unknown.
    pub fn seconds_until_expiry(&self, now: i64) -> Option<i64> {
        self.expires_at.map(|exp| (exp - now).max(0))
    }

    /// Was this credential minted for `resource`?
    ///
    /// Compared canonically so `https://h/mcp` and `https://h:443/mcp/` match.
    /// An empty stored resource passes: older credential files (or an AS that
    /// ignored our `resource` parameter) legitimately have nothing to compare,
    /// and refusing them would log users out after an upgrade.
    pub fn matches_resource(&self, resource: &str) -> bool {
        let stored = self.resource.trim();
        if stored.is_empty() {
            return true;
        }
        match (canonical_resource_id(stored), canonical_resource_id(resource)) {
            (Some(a), Some(b)) => a == b,
            _ => stored == resource.trim(),
        }
    }

    /// Apply a fresh token response onto this credential set.
    ///
    /// `capabilities` is carried over untouched, which is the point of the method
    /// existing rather than constructing a new struct at the call site: a
    /// re-issued token describes the same authorization to the same server, so
    /// the discovered tools are still exactly right, and any construction path
    /// that forgets to copy them silently empties the agent's tool list.
    ///
    /// A `None` refresh token in the response **preserves the existing one**.
    /// RFC 6749 §6 permits an AS to omit `refresh_token` from a refresh response
    /// when it is unchanged, and treating that omission as a revocation would
    /// make the second refresh impossible — the credential would work once more
    /// and then permanently degrade to "needs user authorization".
    pub fn with_tokens(mut self, response: &TokenResponse, now: i64) -> Self {
        self.access_token = response.access_token.clone();
        if let Some(rt) = response.refresh_token.clone().filter(|s| !s.trim().is_empty()) {
            self.refresh_token = Some(rt);
        }
        if !response.token_type.trim().is_empty() {
            self.token_type = response.token_type.clone();
        }
        self.expires_at = response.expires_in.map(|secs| now.saturating_add(secs as i64));
        if !response.scope.is_empty() {
            self.scope = response.scope.clone();
        }
        self.stored_at = now;
        self
    }
}

/// An RFC 6749 §5.1 token endpoint response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// `Bearer`, normally. Deserialized tolerantly: some servers send `bearer`.
    #[serde(default)]
    pub token_type: String,
    /// Lifetime in seconds. Absent means unknown — see `StoredCredentials::expires_at`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_in: Option<i64>,
    /// Granted scopes, space-split.
    #[serde(default)]
    pub scope: Vec<String>,
}

impl TokenResponse {
    /// Parse a token endpoint response body.
    ///
    /// Tolerates three real-world deviations from RFC 6749 §5.1, each of which
    /// would otherwise abort a successful login at the last step:
    ///   * `token_type` absent or lowercased (`bearer`);
    ///   * `expires_in` sent as a JSON string (`"3600"`) — several ASes built on
    ///     dynamic languages do this;
    ///   * `scope` sent as an array instead of a space-delimited string.
    pub fn parse(value: &serde_json::Value) -> Result<Self, OAuthError> {
        let access_token = value
            .get("access_token")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| OAuthError::TokenRequestFailed {
                url: String::new(),
                status: None,
                error_code: None,
                reason: "token response carries no `access_token`".into(),
            })?;
        let refresh_token = value
            .get("refresh_token")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let token_type = value
            .get("token_type")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| match s.to_lowercase().as_str() {
                // Normalised to the RFC's capitalisation: the scheme is
                // case-insensitive on the wire, but a canonical spelling keeps
                // our own logs and headers consistent.
                "bearer" => "Bearer".to_string(),
                _ => s.chars().next().map(|c| c.to_uppercase().to_string()).unwrap_or_default()
                    + &s[1..].to_lowercase(),
            })
            .unwrap_or_else(|| "Bearer".to_string());
        let expires_in = value.get("expires_in").and_then(|v| match v {
            serde_json::Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
            serde_json::Value::String(s) => s.trim().parse::<i64>().ok(),
            _ => None,
        }).filter(|n| *n > 0);
        let scope = match value.get("scope") {
            Some(serde_json::Value::String(s)) => s.split_whitespace().map(|p| p.to_string()).collect(),
            Some(serde_json::Value::Array(a)) => {
                a.iter().filter_map(|v| v.as_str()).map(|s| s.to_string()).collect()
            }
            _ => Vec::new(),
        };
        Ok(Self { access_token, refresh_token, token_type, expires_in, scope })
    }
}

/// Where credentials live between runs.
///
/// A trait, keyed by server URL, because the desktop shell wants the OS keyring
/// (it already depends on the `keyring` crate) while the CLI and the test suite
/// want something simpler. Putting the choice behind a trait keeps that decision
/// out of the flow logic — and, importantly, means the *flow* is testable without
/// touching a real keychain, which would prompt the user.
///
/// `&self` everywhere, so implementations must be internally synchronized; the
/// provided stores use a `Mutex`/atomic write, and a keyring-backed one is
/// naturally so.
#[async_trait::async_trait]
pub trait CredentialStore: Send + Sync {
    /// Load the credential for `server_url`, or `None` if none is stored.
    ///
    /// Implementations should return `Ok(None)` rather than an error when the
    /// record is absent; an absent credential is the normal first-run state, and
    /// reporting it as an error would make the caller treat a fresh install as a
    /// failure.
    async fn load(&self, server_url: &str) -> anyhow::Result<Option<StoredCredentials>>;

    /// Persist credentials for `server_url`, replacing anything already there.
    async fn save(&self, server_url: &str, credentials: &StoredCredentials) -> anyhow::Result<()>;

    /// Remove the credential for `server_url`. Idempotent: clearing an absent
    /// record is `Ok(())`, because "logout" must not fail on a second click.
    async fn clear(&self, server_url: &str) -> anyhow::Result<()>;

    /// Every server URL with a stored credential.
    ///
    /// Used by the settings panel to show which servers are authorized. Returns
    /// keys only, never values, so a caller that just wants a list cannot
    /// accidentally leak tokens into a log.
    async fn list(&self) -> anyhow::Result<Vec<String>> {
        Ok(Vec::new())
    }
}

/// Normalise a server URL to a stable store key.
///
/// Done once, in one place, and used by every store implementation, so two
/// spellings of the same server (`https://h/mcp` vs `https://h:443/mcp/`) cannot
/// end up as two credential records. Two records would mean a refresh writes one
/// while a read loads the other — an intermittent "logged out for no reason"
/// that is nearly impossible to diagnose. Falls back to the trimmed input for a
/// URL that will not parse, so an odd key still round-trips instead of colliding
/// with every other odd key.
pub fn credential_key(server_url: &str) -> String {
    canonical_resource_id(server_url).unwrap_or_else(|| server_url.trim().to_string())
}

/// In-memory credential store.
///
/// For tests and for callers that explicitly want no persistence (a single-shot
/// CLI invocation should not write a token to disk the user did not ask for).
#[derive(Debug, Default)]
pub struct MemoryCredentialStore {
    entries: tokio::sync::Mutex<std::collections::HashMap<String, StoredCredentials>>,
}

impl MemoryCredentialStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait::async_trait]
impl CredentialStore for MemoryCredentialStore {
    async fn load(&self, server_url: &str) -> anyhow::Result<Option<StoredCredentials>> {
        Ok(self.entries.lock().await.get(&credential_key(server_url)).cloned())
    }

    async fn save(&self, server_url: &str, credentials: &StoredCredentials) -> anyhow::Result<()> {
        self.entries.lock().await.insert(credential_key(server_url), credentials.clone());
        Ok(())
    }

    async fn clear(&self, server_url: &str) -> anyhow::Result<()> {
        self.entries.lock().await.remove(&credential_key(server_url));
        Ok(())
    }

    async fn list(&self) -> anyhow::Result<Vec<String>> {
        let mut keys: Vec<String> = self.entries.lock().await.keys().cloned().collect();
        keys.sort();
        Ok(keys)
    }
}

/// A single JSON file holding every server's credentials.
///
/// One file rather than one-per-server: the settings panel needs the full list to
/// render authorized servers, and a directory scan plus N parses on every panel
/// open is worse than one read. The file is rewritten wholesale, which is fine at
/// this scale (a handful of servers, a few KB each) and is atomic via
/// temp-file-and-rename, so a crash mid-write cannot leave a truncated file that
/// then fails to parse — losing *every* server's credentials at once.
pub struct FileCredentialStore {
    /// Absolute path, supplied by the caller. Not derived here on purpose: the
    /// kernel already resolves a harness base (`config::harness_base()`, honouring
    /// `GWORK_HOME`/`--home`) and re-deriving it in this module would ignore an
    /// override the user set, silently writing tokens to a different home.
    path: std::path::PathBuf,
    /// Serializes read-modify-write cycles. Without it, two servers finishing
    /// authorization concurrently would each load the file, add their own entry,
    /// and write back — the second write erasing the first's credential.
    lock: tokio::sync::Mutex<()>,
    clock: Clock,
}

impl FileCredentialStore {
    /// Open a store rooted at `path`. Parent directories are created lazily on
    /// first save, not here, so constructing a store for an unconfigured harness
    /// base has no filesystem side effects.
    pub fn new(path: impl Into<std::path::PathBuf>) -> Self {
        Self { path: path.into(), lock: tokio::sync::Mutex::new(()), clock: Clock::system() }
    }

    /// [`Self::new`] with an explicit clock (tests that assert `stored_at`).
    pub fn with_clock(path: impl Into<std::path::PathBuf>, clock: Clock) -> Self {
        Self { path: path.into(), lock: tokio::sync::Mutex::new(()), clock }
    }

    /// Where this store reads and writes.
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    /// Load the whole document.
    ///
    /// Blocking file I/O is pushed onto the blocking pool: this is called on the
    /// async worker thread from request handlers, and a slow or network-backed
    /// home directory would otherwise stall every other task in the process for
    /// the duration of the read.
    fn read_all(path: std::path::PathBuf) -> anyhow::Result<std::collections::HashMap<String, StoredCredentials>> {
        tokio::task::block_in_place(|| Self::read_all_blocking(path))
    }

    fn read_all_blocking(path: std::path::PathBuf) -> anyhow::Result<std::collections::HashMap<String, StoredCredentials>> {
        match std::fs::read_to_string(&path) {
            Ok(text) => {
                if text.trim().is_empty() {
                    return Ok(std::collections::HashMap::new());
                }
                // A corrupt file is reported, not silently replaced. Wiping it
                // would discard every other server's working credential because
                // one entry went bad, and the user would see "all servers logged
                // out" with no cause in the logs.
                serde_json::from_str::<std::collections::HashMap<String, StoredCredentials>>(&text)
                    .map_err(|e| anyhow::anyhow!("credential file {} is not readable: {}", path.display(), e))
            }
            // Not-present is the normal first run.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(std::collections::HashMap::new()),
            Err(e) => Err(anyhow::anyhow!("cannot read credential file {}: {}", path.display(), e)),
        }
    }

    fn write_all(path: std::path::PathBuf, entries: std::collections::HashMap<String, StoredCredentials>) -> anyhow::Result<()> {
        tokio::task::block_in_place(|| Self::write_all_blocking(path, entries))
    }

    fn write_all_blocking(path: std::path::PathBuf, entries: std::collections::HashMap<String, StoredCredentials>) -> anyhow::Result<()> {
        let text = serde_json::to_string_pretty(&entries)?;
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| anyhow::anyhow!("cannot create credential directory {}: {}", parent.display(), e))?;
                restrict_directory(parent);
            }
        }
        // Write to a sibling temp file, tighten its permissions *before* it holds
        // anything readable by others, then rename. Renaming after the chmod
        // matters: creating the final path first and chmod-ing afterwards leaves
        // a window where a world-readable file contains a live access token.
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, text.as_bytes())
            .map_err(|e| anyhow::anyhow!("cannot write credential file {}: {}", tmp.display(), e))?;
        restrict_file(&tmp);
        std::fs::rename(&tmp, &path).map_err(|e| {
            // Clean up the temp file so a failed rename does not leave a
            // world-readable (on some platforms) copy of the tokens behind.
            let _ = std::fs::remove_file(&tmp);
            anyhow::anyhow!("cannot install credential file {}: {}", path.display(), e)
        })?;
        Ok(())
    }

    /// Drop everything. Used by a "sign out of all servers" action and by tests.
    pub fn delete_file(&self) -> anyhow::Result<()> {
        let _guard = self.lock.blocking_lock();
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(anyhow::anyhow!("cannot delete credential file {}: {}", self.path.display(), e)),
        }
    }
}

/// Tighten a file's permissions, best-effort, with an explicit note on why the
/// Windows branch is empty.
///
/// **POSIX**: mode `0600` — owner read/write only. This file holds live access
/// and refresh tokens; the refresh token in particular is a long-lived credential
/// that is equivalent to the user's password for that MCP server. Any other local
/// user must not be able to read it.
///
/// **Windows**: there is no mode bit, and the equivalent would be setting a DACL
/// via `SetNamedSecurityInfo`. That needs `windows-sys`/`winapi`, which this crate
/// does not depend on, so it is deliberately not done here. Two mitigations apply
/// instead, and both are why the caller's path choice matters: the default
/// location is under the user's profile (`%USERPROFILE%\.gwork\...`), whose
/// inherited ACL already restricts access to the owning user and administrators;
/// and the desktop shell can move to the OS keyring by supplying a different
/// `CredentialStore`, which is the recommended configuration on Windows.
///
/// Never an error: failing the whole save because a chmod was refused (an
/// unusual filesystem, a container with a read-only mount) would leave the user
/// with no credential at all, which is a worse outcome than a token file with
/// inherited permissions.
#[cfg(unix)]
fn restrict_file(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path) {
        let mut perms = meta.permissions();
        perms.set_mode(0o600);
        if let Err(e) = std::fs::set_permissions(path, perms) {
            tracing::debug!(path = %path.display(), error = %e, "could not tighten credential file permissions");
        }
    }
}

#[cfg(not(unix))]
fn restrict_file(_path: &std::path::Path) {
    // See the `#[cfg(unix)]` variant's docs: no mode bits on Windows, and the
    // ACL crate this would need is not a dependency of this crate.
}

/// Tighten a directory's permissions to `0700` on POSIX; no-op elsewhere.
#[cfg(unix)]
fn restrict_directory(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path) {
        let mut perms = meta.permissions();
        perms.set_mode(0o700);
        if let Err(e) = std::fs::set_permissions(path, perms) {
            tracing::debug!(path = %path.display(), error = %e, "could not tighten credential directory permissions");
        }
    }
}

#[cfg(not(unix))]
fn restrict_directory(_path: &std::path::Path) {}

#[async_trait::async_trait]
impl CredentialStore for FileCredentialStore {
    async fn load(&self, server_url: &str) -> anyhow::Result<Option<StoredCredentials>> {
        let _guard = self.lock.lock().await;
        let key = credential_key(server_url);
        Ok(Self::read_all(self.path.clone())?.remove(&key))
    }

    async fn save(&self, server_url: &str, credentials: &StoredCredentials) -> anyhow::Result<()> {
        let _guard = self.lock.lock().await;
        let key = credential_key(server_url);
        let mut entries = Self::read_all(self.path.clone())?;
        let mut stored = credentials.clone();
        // Stamp here rather than at the call site: a caller that forgets would
        // persist `stored_at: 0`, and the settings panel would then report every
        // credential as authorized in 1970 — a cosmetic bug that is very hard to
        // trace back to a missing assignment.
        if stored.stored_at == 0 {
            stored.stored_at = self.clock.now();
        }
        entries.insert(key, stored);
        Self::write_all(self.path.clone(), entries)
    }

    async fn clear(&self, server_url: &str) -> anyhow::Result<()> {
        let _guard = self.lock.lock().await;
        let key = credential_key(server_url);
        let mut entries = Self::read_all(self.path.clone())?;
        // Idempotent: removing an absent key is success, so "sign out" twice is
        // not an error the second time.
        entries.remove(&key);
        Self::write_all(self.path.clone(), entries)
    }

    async fn list(&self) -> anyhow::Result<Vec<String>> {
        let _guard = self.lock.lock().await;
        let mut keys: Vec<String> = Self::read_all(self.path.clone())?.into_keys().collect();
        keys.sort();
        Ok(keys)
    }
}

/// Build the `Authorization` header value for a server, refreshing if needed.
///
/// Returns `None` when there is no usable credential — which the caller should
/// treat as "send no `Authorization` header", **not** as an error. An HTTP MCP
/// server may legitimately be unauthenticated, and failing the connect here would
/// break every plain HTTP server the moment OAuth support is wired in.
///
/// This is the request-path entry point. It performs a refresh inline when the
/// token is within [`EXPIRY_SKEW_SECONDS`] of expiry, because the alternative
/// (a background refresher task) has no natural owner in this kernel: the MCP
/// manager owns connections, not timers, and a token that expires between two
/// tool calls hours apart would be refreshed by nobody. Inline refresh costs one
/// HTTP call on the rare request that happens to straddle expiry.
pub async fn bearer_header_for(
    server_url: &str,
    store: &dyn CredentialStore,
) -> Option<String> {
    bearer_header_for_with(server_url, store, None, Clock::system()).await
}

/// [`bearer_header_for`] with an explicit client and clock (tests, and callers
/// that must reuse a pre-configured proxy/TLS setup).
///
/// On refresh failure the stored credential is returned **unchanged** if its
/// access token is not yet actually expired, and dropped only when it is. That
/// asymmetry is deliberate: sending a just-expired token costs one 401 that the
/// caller's retry logic can handle, while discarding it costs the user a full
/// browser re-authorization.
pub async fn bearer_header_for_with(
    server_url: &str,
    store: &dyn CredentialStore,
    client: Option<&OAuthClient>,
    clock: Clock,
) -> Option<String> {
    let stored = match store.load(server_url).await {
        Ok(Some(s)) => s,
        Ok(None) => return None,
        Err(e) => {
            // A store failure is logged, not propagated: the caller asked for an
            // optional header, and the only thing it can do without one is
            // proceed unauthenticated and let the server's 401 drive the flow.
            tracing::warn!(server = %server_url, error = %e, "cannot load OAuth credentials");
            return None;
        }
    };
    if !stored.matches_resource(server_url) {
        // A credential for a different resource must never be presented here.
        // Audience confusion is what RFC 8707 exists to prevent, and leaking a
        // token across servers is a security bug, not a convenience.
        tracing::warn!(
            server = %server_url,
            issued_for = %stored.resource,
            "stored OAuth credential is scoped to a different resource; ignoring it"
        );
        return None;
    }
    let now = clock.now();
    if stored.is_valid(now) {
        return Some(format_authorization(&stored.token_type, &stored.access_token));
    }
    if !stored.can_refresh() {
        // Nothing to renew with. Leave the credential in place: the settings
        // panel shows it as "authorized but expired", which is more useful than
        // "never authorized", and a later full authorize will overwrite it.
        tracing::debug!(server = %server_url, "stored OAuth credential expired and cannot be refreshed");
        return if stored.access_token.trim().is_empty() {
            None
        } else {
            Some(format_authorization(&stored.token_type, &stored.access_token))
        };
    }
    // Build a client only if the caller did not supply one. Constructing it is
    // cheap-ish but not free, and the common path (token still valid) never
    // reaches here.
    let fallback = if client.is_none() {
        match OAuthClient::with_clock(&default_config_for_refresh(server_url, &stored), clock.clone()) {
            Ok(c) => Some(c),
            Err(e) => {
                tracing::warn!(server = %server_url, error = %e, "cannot build an OAuth HTTP client for refresh");
                return Some(format_authorization(&stored.token_type, &stored.access_token));
            }
        }
    } else {
        None
    };
    let http = client.or(fallback.as_ref())?;
    match refresh_tokens(http, &stored, now).await {
        Ok(renewed) => {
            if let Err(e) = store.save(server_url, &renewed).await {
                // The refresh succeeded but persistence failed. Still usable for
                // this request; the next one will refresh again, which is wasteful
                // but correct. Logged loudly because repeated refreshes can hit
                // AS rate limits.
                tracing::warn!(server = %server_url, error = %e, "refreshed OAuth token could not be persisted");
            }
            Some(format_authorization(&renewed.token_type, &renewed.access_token))
        }
        Err(e) => {
            tracing::warn!(server = %server_url, error = %e, "OAuth token refresh failed; keeping the previous credential");
            if stored.access_token.trim().is_empty() {
                None
            } else {
                Some(format_authorization(&stored.token_type, &stored.access_token))
            }
        }
    }
}

/// A minimal `McpServerConfig` for a refresh that has no config available.
///
/// Only the URL and timeout matter for the refresh POST. This exists so
/// `bearer_header_for` can be called with just a store — the shape the request
/// path wants — without forcing every caller to thread the server config through.
fn default_config_for_refresh(server_url: &str, stored: &StoredCredentials) -> McpServerConfig {
    let mut config = McpServerConfig::default();
    config.url = server_url.to_string();
    // Refresh should be quick and must not inherit a multi-minute MCP timeout:
    // it sits on the request path, and a hung AS would stall the tool call.
    config.timeout = "30s".into();
    let _ = &stored.authorization_server;
    config
}

/// Format an `Authorization` header value.
///
/// The scheme is echoed from the credential rather than hardcoded `Bearer` so a
/// token issued with a non-Bearer type is still presented the way its AS expects.
pub fn format_authorization(token_type: &str, token: &str) -> String {
    let scheme = token_type.trim();
    if scheme.is_empty() {
        format!("Bearer {}", token)
    } else {
        format!("{} {}", scheme, token)
    }
}

/* ─────────────────── Token exchange and refresh (RFC 6749) ─────────────────── */

/// Exchange an authorization code for tokens (RFC 6749 §4.1.3 + RFC 7636 §4.5).
///
/// The request is form-encoded and carries `code_verifier`, which is the moment
/// PKCE actually pays off: the AS hashes it and compares against the challenge
/// from the authorization request, so an intercepted code is worthless without
/// this value. The verifier is sent in the body only and is never logged —
/// [`tracing::debug`] here logs the endpoint and status, never the form.
///
/// `redirect_uri` must be byte-identical to the one used in the authorization
/// request; RFC 6749 §4.1.3 requires the match and ASes enforce it strictly, so
/// it is passed in from the same value that built the authorization URL rather
/// than recomputed (a recomputation that picks a different ephemeral port would
/// fail with `invalid_grant`, which reads like an expired code).
pub async fn exchange_code(
    client: &OAuthClient,
    token_endpoint: &str,
    registration: &ClientRegistration,
    code: &str,
    redirect_uri: &str,
    code_verifier: &str,
    resource: Option<&str>,
) -> Result<TokenResponse, OAuthError> {
    let mut form: Vec<(String, String)> = vec![
        ("grant_type".into(), "authorization_code".into()),
        ("code".into(), code.to_string()),
        ("redirect_uri".into(), redirect_uri.to_string()),
        ("client_id".into(), registration.client_id.clone()),
        // RFC 7636 §4.5: the verifier is sent on the token request, not the
        // authorization request.
        ("code_verifier".into(), code_verifier.to_string()),
    ];
    if let Some(r) = resource.filter(|s| !s.trim().is_empty()) {
        // RFC 8707: binds the token to this resource server. Without it, a token
        // minted for one MCP host is valid at every other host the same AS
        // serves, which is a real audience-confusion vulnerability on shared
        // gateways.
        form.push(("resource".into(), r.to_string()));
    }
    post_token_request(client, token_endpoint, registration, form).await
}

/* ─────────────────── RFC 8628 Device Authorization Grant ─────────────────── */

/// RFC 8628 §3.2 response from the device authorization endpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceCodeResponse {
    pub device_code: String,
    /// The code the user types / confirms on the second device.
    pub user_code: String,
    /// Where the user goes (a page, often a QR-code page).
    pub verification_uri: String,
    /// RFC 8628 §3.2 `verification_uri_complete`: URL with the user_code
    /// pre-filled. Rendered as a QR code by the UI when present.
    #[serde(default)]
    pub verification_uri_complete: String,
    /// Lifetime of `device_code` in seconds.
    #[serde(default)]
    pub expires_in: i64,
    /// Minimum polling interval in seconds (default 5 per RFC 8628 §3.2).
    #[serde(default)]
    pub interval: i64,
}

impl DeviceCodeResponse {
    /// Parse tolerantly: some ASes return `expires_in`/`interval` as JSON
    /// strings, and `verification_uri_complete` is optional.
    pub fn parse(value: &serde_json::Value) -> Result<Self, OAuthError> {
        let bad = |reason: &str| OAuthError::TokenRequestFailed {
            url: String::new(),
            status: None,
            error_code: None,
            reason: reason.to_string(),
        };
        let str_field = |k: &str| -> Option<String> {
            value.get(k).and_then(|v| v.as_str())
                .map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
        };
        let num_field = |k: &str| -> i64 {
            value.get(k).and_then(|v| match v {
                serde_json::Value::Number(n) => n.as_i64(),
                serde_json::Value::String(s) => s.trim().parse::<i64>().ok(),
                _ => None,
            }).unwrap_or(0)
        };
        let device_code = str_field("device_code").ok_or_else(|| bad("device authorization response has no `device_code`"))?;
        let user_code = str_field("user_code").ok_or_else(|| bad("device authorization response has no `user_code`"))?;
        let verification_uri = str_field("verification_uri").ok_or_else(|| bad("device authorization response has no `verification_uri`"))?;
        if !device_uri_is_allowed(&verification_uri) {
            return Err(bad("verification_uri must be https (or http to a loopback host)"));
        }
        // `verification_uri_complete` is the URL actually handed to the human —
        // RFC 8628 §3.3.1 pre-fills it with the user_code, and this app renders it
        // as a clickable link (`auth.rs` prefers it over `verification_uri`).
        // It therefore needs *stricter* checking than the endpoint we talk to, not
        // weaker: it was previously taken with `unwrap_or_default()` and no
        // validation at all.
        //
        // Two conditions, both required:
        // 1. It must be a permitted URI (`device_uri_is_allowed`) — no
        //    `javascript:`, no plaintext http to a non-loopback host, no
        //    `localhost.evil.example` lookalikes.
        // 2. It must be on the **same host** as the already-validated
        //    `verification_uri`. Condition 1 alone is not enough: a hostile or
        //    compromised AS can serve a perfectly valid *https* phishing page
        //    (`https://attacker.example/phish?user_code=WDJB-MJHT`) and harvest
        //    the very code the user was told to type. §3.3.1 defines this field as
        //    the verification URI *with the user code included* — i.e. the same
        //    site — so a cross-host value is not a legitimate variant, and the
        //    `verification_uri` it is derived from has already passed.
        //
        // On failure we **drop it and fall back to `verification_uri`** rather
        // than failing the whole flow: the user can still authorise by typing the
        // code by hand, so this is fail-closed against phishing without being
        // fail-fatal against a merely buggy AS.
        let verification_uri_complete = match str_field("verification_uri_complete") {
            Some(uri) => {
                let permitted = device_uri_is_allowed(&uri);
                let same_host = permitted && uri_host(&uri) == uri_host(&verification_uri);
                if same_host {
                    uri
                } else {
                    tracing::warn!(
                        verification_uri_complete = %super::truncate(&uri, 160),
                        verification_uri = %super::truncate(&verification_uri, 160),
                        "device flow: verification_uri_complete is not a permitted URL or is on a \
                         different host than verification_uri; ignoring it and falling back to \
                         verification_uri (the user can still type the code by hand)"
                    );
                    String::new()
                }
            }
            None => String::new(),
        };
        Ok(Self {
            device_code,
            user_code,
            verification_uri,
            verification_uri_complete,
            expires_in: num_field("expires_in"),
            interval: num_field("interval"),
        })
    }

    /// RFC 8628 §3.2: default interval 5s when omitted. Clamped so a hostile
    /// AS cannot make us spin or stall forever.
    pub fn poll_interval_secs(&self) -> u64 {
        if self.interval <= 0 { 5 } else { (self.interval as u64).clamp(1, 60) }
    }

    pub fn expires_in_secs(&self) -> u64 {
        if self.expires_in <= 0 { 300 } else { (self.expires_in as u64).min(3600) }
    }
}

/// Which outcome one token-endpoint poll produced (RFC 8628 §3.4/§3.5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DevicePollOutcome {
    Granted(TokenResponse),
    /// `authorization_pending` — keep polling.
    Pending,
    /// `slow_down` — keep polling, add 5s to the interval.
    SlowDown,
    /// The token endpoint was reachable but temporarily unable to answer:
    /// HTTP 5xx, `429`, `408`, or an unknown `error` code on those statuses.
    ///
    /// Distinct from [`Self::Failed`] on purpose. A user mid-scan is holding a
    /// `user_code` that stays valid for `expires_in` seconds, and an AS restart,
    /// a gateway hiccup or a rate limit is not a reason to throw it away — the
    /// caller backs off and polls again. Treating these as fatal made a single
    /// transient blip permanently kill a login the user was seconds from
    /// completing, and surfaced raw upstream HTML as the error message.
    ///
    /// Note that `429` belongs here rather than in `Failed`: RFC 8628 §3.5
    /// designed `slow_down` precisely for "you are polling too fast", so an AS
    /// that expresses it as a bare HTTP 429 means the same thing.
    Transient,
    /// `expired_token` / `access_denied` / anything else fatal.
    Failed(String),
}

/// Is this HTTP status a temporary condition rather than a rejection?
///
/// `408` (request timeout), `429` (rate limited) and the `5xx` family (AS
/// restarting, gateway between us and it failing) all mean "ask again later".
/// Everything else — `400`, `401`, `403`, `404` — is the AS telling us
/// something definite about this request, and must stay fatal.
pub fn is_transient_poll_status(status: u16) -> bool {
    status == 408 || status == 429 || (500..=599).contains(&status)
}

/// RFC 8628 §3.5: how much to add to the poll interval after `slow_down`.
///
/// The RFC says "add 5 seconds to *every* subsequent poll" — it is a permanent
/// step change for the rest of the flow, not a one-off delay.
pub const DEVICE_POLL_SLOW_DOWN_STEP_SECS: u64 = 5;

/// Ceiling on the device-flow poll interval.
///
/// Bounded because an unbounded interval can outlive the device code itself:
/// with `expires_in` of 300s, a 120s interval means at most two polls, and the
/// user who approved on their phone would still be told "expired". 60s keeps
/// at least five polls in that worst realistic case.
pub const DEVICE_POLL_INTERVAL_CAP_SECS: u64 = 60;

/// Advance the device-flow poll interval after a `slow_down` or a transient
/// failure. Pure, and used by both branches, so the §3.5 backoff is
/// unit-testable without an authorization server and the two call sites cannot
/// drift apart.
pub fn back_off_poll_interval(current_secs: u64) -> u64 {
    current_secs
        .saturating_add(DEVICE_POLL_SLOW_DOWN_STEP_SECS)
        .min(DEVICE_POLL_INTERVAL_CAP_SECS)
}

/// Resolve the device-flow poll interval from a local override and the
/// authorization server's own `interval`.
///
/// RFC 8628 §3.2 makes the AS's `interval` the **minimum** it demands, so the
/// two are combined with `max`: a local override may make polling slower but
/// never faster. The local value is also clamped to `[1, 60]` first, matching
/// `DeviceCodeResponse::poll_interval_secs`, so a hostile `devicePollIntervalSecs`
/// in a remotely-supplied catalog entry cannot pin the interval below what the
/// server asked for.
///
/// Pure so the precedence (and the "remotely-supplied DoS" case) is testable
/// without an AS.
pub fn resolve_poll_interval(local_override_secs: u64, server_interval_secs: u64) -> u64 {
    local_override_secs.clamp(1, 60).max(server_interval_secs)
}

/// Interpret one token-endpoint response for a Device Flow poll.
///
/// Kept pure so `authorization_pending` / `slow_down` / `expired_token` /
/// `access_denied` handling is unit-testable without an AS. Error bodies are
/// non-2xx with an `error` field per RFC 6749 §5.2.
pub fn classify_device_poll(status: u16, value: &serde_json::Value, text: &str) -> DevicePollOutcome {
    let code = value.get("error").and_then(|v| v.as_str()).unwrap_or("").to_ascii_lowercase();
    if (200..=299).contains(&status) {
        return match TokenResponse::parse(value) {
            Ok(t) => DevicePollOutcome::Granted(t),
            Err(_) => DevicePollOutcome::Pending,
        };
    }
    // An explicit RFC 8628 §3.5 error code wins over the status: an AS that says
    // `expired_token` on a 503 (some gateways rewrite bodies) is still expired.
    match code.as_str() {
        "authorization_pending" => return DevicePollOutcome::Pending,
        "slow_down" => return DevicePollOutcome::SlowDown,
        "expired_token" => return DevicePollOutcome::Failed("设备码已过期，请重新发起授权".into()),
        "access_denied" => return DevicePollOutcome::Failed("用户拒绝了授权".into()),
        _ => {}
    }
    if is_transient_poll_status(status) {
        return DevicePollOutcome::Transient;
    }
    let reason = value.get("error_description").and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            let t = text.trim();
            if t.is_empty() { format!("token endpoint returned HTTP {status}") }
            else { super::truncate(t, 200) }
        });
    DevicePollOutcome::Failed(reason)
}

/// Pure builder for a Device Flow RFC 7591 registration body. Kept separate so
/// the grant types are unit-testable without an AS.
pub fn device_registration_body(scopes: &[String], client_name: &str) -> serde_json::Value {
    let mut body = registration_body(&[], scopes, client_name);
    body["grant_types"] = serde_json::json!(["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"]);
    // RFC 8628 has no redirect and no authorization response type.
    body["response_types"] = serde_json::json!([]);
    body
}

/// RFC 7591 registration for an RFC 8628 Device Flow client.
///
/// `register_client` hardcodes `authorization_code` grant types (correct for the
/// browser flow). A Device Flow client must register
/// `urn:ietf:params:oauth:grant-type:device_code` instead, and has **no**
/// redirect URI — RFC 8628 §3.1 explicitly does not use one. Reusing the normal
/// registration would produce a client the AS refuses at the device endpoint.
pub async fn register_device_client(
    client: &OAuthClient,
    metadata: &AuthorizationServerMetadata,
    scopes: &[String],
    client_name: &str,
) -> Result<ClientRegistration, OAuthError> {
    let url = metadata.registration_endpoint.as_deref().unwrap_or("").trim();
    if url.is_empty() {
        return Err(OAuthError::RegistrationFailed {
            url: metadata.source_url.clone(),
            status: None,
            reason: "the authorization server does not publish a `registration_endpoint`; \
                     a Device Flow connector needs a preconfigured `clientId`".into(),
        });
    }
    let body = device_registration_body(scopes, client_name);
    let (status, value, text) = client.post_json(url, &body).await?;
    let client_id = value.get("client_id").and_then(|v| v.as_str()).unwrap_or("").trim();
    if !(200..=299).contains(&status) || client_id.is_empty() {
        return Err(OAuthError::RegistrationFailed {
            url: url.to_string(), status: Some(status),
            reason: oauth_error_message(&value, &text, status),
        });
    }
    let secret = value.get("client_secret").and_then(|v| v.as_str())
        .map(|s| s.to_string()).filter(|s| !s.trim().is_empty());
    Ok(ClientRegistration {
        client_id: client_id.to_string(),
        client_secret: secret.clone(),
        token_endpoint_auth_method: value.get("token_endpoint_auth_method")
            .and_then(|v| v.as_str()).unwrap_or(if secret.is_some() { "client_secret_post" } else { "none" }).to_string(),
        redirect_uris: Vec::new(),
        registration_access_token: value.get("registration_access_token").and_then(|v| v.as_str()).map(|s| s.to_string()),
        registration_client_uri: value.get("registration_client_uri").and_then(|v| v.as_str()).map(|s| s.to_string()),
        scope: scopes.to_vec(),
        source: ClientSource::Registered,
    })
}

/// RFC 8628 §3.1: ask the AS for a device code / user code pair.
pub async fn request_device_code(
    client: &OAuthClient,
    endpoint: &str,
    registration: &ClientRegistration,
    scopes: &[String],
) -> Result<DeviceCodeResponse, OAuthError> {
    let mut form: Vec<(String, String)> = vec![("client_id".into(), registration.client_id.clone())];
    if !scopes.is_empty() {
        form.push(("scope".into(), scopes.join(" ")));
    }
    let (status, value, text) = client.post_form(endpoint, form, None).await?;
    if !(200..=299).contains(&status) {
        let code = value.get("error").and_then(|v| v.as_str()).unwrap_or("").to_string();
        return Err(OAuthError::TokenRequestFailed {
            url: endpoint.to_string(),
            status: Some(status),
            error_code: Some(code),
            reason: oauth_error_message(&value, &text, status),
        });
    }
    DeviceCodeResponse::parse(&value).map_err(|mut e| {
        if let OAuthError::TokenRequestFailed { url, .. } = &mut e { *url = endpoint.to_string(); }
        e
    })
}

/// RFC 8628 §3.4: one poll of the token endpoint with
/// `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
pub async fn poll_device_token(
    client: &OAuthClient,
    token_endpoint: &str,
    registration: &ClientRegistration,
    device_code: &str,
) -> Result<DevicePollOutcome, OAuthError> {
    let mut form: Vec<(String, String)> = vec![
        ("grant_type".into(), "urn:ietf:params:oauth:grant-type:device_code".into()),
        ("device_code".into(), device_code.to_string()),
        ("client_id".into(), registration.client_id.clone()),
    ];
    if registration.client_secret.is_some() && !registration.is_public() {
        if let Some(s) = registration.client_secret.as_deref() {
            form.push(("client_secret".into(), s.to_string()));
        }
    }
    let (status, value, text) = client.post_form(token_endpoint, form, None).await?;
    Ok(classify_device_poll(status, &value, &text))
}

/// Refresh an access token (RFC 6749 §6).
///
/// Returns the renewed credential set, with `capabilities` carried over by
/// [`StoredCredentials::with_tokens`]. **This function never writes to the
/// store** — persistence is the caller's decision, so a caller that wants
/// "refresh but keep the old credential on failure" can simply not save. That
/// split is what makes the refresh-failure-preserves-tools requirement
/// expressible at all: if refresh saved internally, a failure would have to
/// either overwrite good data or the function would need a save/don't-save flag
/// that every caller has to think about.
pub async fn refresh_tokens(
    client: &OAuthClient,
    stored: &StoredCredentials,
    now: i64,
) -> Result<StoredCredentials, OAuthError> {
    let Some(refresh_token) = stored.refresh_token.clone().filter(|s| !s.trim().is_empty()) else {
        return Err(OAuthError::RefreshFailed {
            reason: "no refresh token was issued with the original authorization; the user must \
                     re-authorize in a browser"
                .into(),
        });
    };
    let endpoint = stored.endpoints.token_endpoint.trim();
    if endpoint.is_empty() {
        return Err(OAuthError::RefreshFailed {
            reason: "no token endpoint is recorded for this credential, so it cannot be renewed \
                     without re-running discovery"
                .into(),
        });
    }
    let mut form: Vec<(String, String)> = vec![
        ("grant_type".into(), "refresh_token".into()),
        ("refresh_token".into(), refresh_token),
        ("client_id".into(), stored.client.client_id.clone()),
    ];
    // Re-send the same `resource` the token was minted for. Omitting it on
    // refresh makes some ASes issue a token with no audience, which the resource
    // server then rejects — a failure that appears only after the first refresh,
    // hours after login worked, and is maddening to diagnose.
    if !stored.resource.trim().is_empty() {
        form.push(("resource".into(), stored.resource.clone()));
    }
    let response = match post_token_request(client, endpoint, &stored.client, form).await {
        Ok(r) => r,
        Err(e) => {
            return Err(OAuthError::RefreshFailed { reason: refresh_failure_reason(&e) });
        }
    };
    Ok(stored.clone().with_tokens(&response, now))
}

/// Turn a token-request error into refresh-failure wording.
///
/// Adds the one piece of context the caller cannot recover from the error alone:
/// whether this looks permanent. `invalid_grant` on a refresh means the refresh
/// token was revoked or rotated and re-authorization is the only fix, so saying
/// so saves the user from retrying forever.
fn refresh_failure_reason(error: &OAuthError) -> String {
    let permanent = match error {
        OAuthError::TokenRequestFailed { error_code: Some(code), .. } => matches!(
            code.as_str(),
            "invalid_grant" | "invalid_client" | "unauthorized_client" | "unsupported_grant_type"
        ),
        _ => false,
    };
    let base = error.to_string();
    if permanent {
        format!(
            "{} — this is permanent; the stored credential is kept so the server's tools stay \
             visible, but re-authorization is required before the next successful call",
            base
        )
    } else {
        base
    }
}

/// POST a form to the token endpoint and parse either a token or an error.
///
/// Authentication follows the client's own type, decided by
/// [`ClientRegistration::is_public`]: confidential clients send HTTP `Basic`
/// (`client_secret_basic`) or a form field (`client_secret_post`), and public
/// clients send only the form `client_id`. The distinction is not cosmetic — see
/// the note on `is_public`.
async fn post_token_request(
    client: &OAuthClient,
    token_endpoint: &str,
    registration: &ClientRegistration,
    form: Vec<(String, String)>,
) -> Result<TokenResponse, OAuthError> {
    let mut form = form;
    let basic_auth = match registration.token_endpoint_auth_method.to_lowercase().as_str() {
        "client_secret_basic" => registration
            .client_secret
            .as_deref()
            .map(|secret| (registration.client_id.as_str(), secret)),
        "client_secret_post" => {
            if let Some(secret) = registration.client_secret.as_deref() {
                if !secret.trim().is_empty() {
                    form.push(("client_secret".into(), secret.to_string()));
                }
            }
            None
        }
        // `none` (public client) and anything unrecognised: no client
        // authentication beyond the form `client_id` already present. Defaulting
        // to "no secret" rather than "guess a method" is right because a public
        // client sending a `Basic` header is rejected outright by strict ASes.
        _ => None,
    };

    let (status, value, text) = client.post_form(token_endpoint, form, basic_auth).await?;
    if !(200..=299).contains(&status) {
        let error_code = value.get("error").and_then(|v| v.as_str()).map(|s| s.to_string());
        return Err(OAuthError::TokenRequestFailed {
            url: token_endpoint.to_string(),
            status: Some(status),
            error_code,
            reason: oauth_error_message(&value, &text, status),
        });
    }
    let response = TokenResponse::parse(&value).map_err(|mut e| {
        // Fill in the endpoint here: `parse` does not know it, and an
        // "no access_token" error that does not say which endpoint answered is
        // useless when several are in play.
        if let OAuthError::TokenRequestFailed { url, .. } = &mut e {
            *url = token_endpoint.to_string();
        }
        e
    })?;
    tracing::debug!(
        token_endpoint = %super::truncate(token_endpoint, 160),
        expires_in = ?response.expires_in,
        issued_refresh_token = response.refresh_token.is_some(),
        "OAuth token response received"
    );
    Ok(response)
}

/* ───────────── Loopback redirect listener (RFC 8252 §7.3) ───────────── */

/// Default time to wait for the browser callback.
///
/// Generous on purpose: the user has to notice the prompt, find their browser,
/// possibly authenticate to the AS (including MFA), and approve. Five minutes is
/// what Claude Code and Codex both use in practice. Too short and a user who
/// stepped away gets a confusing timeout; too long and a forgotten flow holds a
/// listening socket on a local port for an hour.
pub const DEFAULT_REDIRECT_TIMEOUT: Duration = Duration::from_secs(300);

/// Per-connection socket deadline while parsing the callback.
///
/// Short, and unrelated to the overall wait: a peer that connects and sends
/// nothing (a browser prefetch, a port scanner, a health probe) must not consume
/// the user's whole authorization window.
const SOCKET_IDLE_TIMEOUT: Duration = Duration::from_secs(10);

/// What the callback delivered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallbackOutcome {
    /// A usable `code`, with the `state` already verified against ours.
    Code { code: String, state: String },
    /// The AS reported an error (`error=access_denied` and friends).
    Denied { error: String, error_description: Option<String> },
}

/// A temporary HTTP listener on `127.0.0.1:<ephemeral port>` that receives the
/// OAuth redirect.
///
/// ## Why a hand-rolled listener
///
/// The workspace does have `axum`, but using it here would mean standing up a
/// full router plus a `hyper` service stack for one endpoint that answers exactly
/// one request and then shuts down. More importantly the *lifetime* is wrong for
/// a server framework: this listener must be bound **before** the authorization
/// URL is built (the port is part of `redirect_uri`), must accept precisely one
/// meaningful request, and must be gone when the flow ends. `std::net::TcpListener`
/// bound on port 0 gives us the assigned port synchronously, and
/// `tokio::net::TcpStream::from_std` moves it into the async world with no extra
/// dependencies.
///
/// ## Why `127.0.0.1` and not `localhost`
///
/// See [`is_loopback_host`]. Binding the literal address also means the socket is
/// unreachable from other machines — RFC 8252 §7.3 notes the loopback interface
/// is not exposed externally, which is the entire reason the loopback redirect is
/// acceptable for a native app despite not using TLS.
#[derive(Debug)]
pub struct RedirectListener {
    /// The bound socket, kept in non-blocking mode and handed to tokio on accept.
    /// `Option` because `serve_*` consumes it.
    inner: Option<std::net::TcpListener>,
    /// The assigned port.
    port: u16,
}

impl RedirectListener {
    /// Bind an ephemeral loopback port.
    ///
    /// Port 0 asks the OS to choose, which is required: a fixed port would break
    /// whenever anything else holds it, and two concurrent authorizations (two MCP
    /// servers both needing login) could not proceed at all.
    pub fn bind() -> Result<Self, OAuthError> {
        let listener = std::net::TcpListener::bind(std::net::SocketAddrV4::new(
            std::net::Ipv4Addr::LOCALHOST,
            0,
        ))
        .map_err(|e| OAuthError::Local {
            reason: format!(
                "cannot bind a loopback port for the authorization callback: {} — a local firewall \
                 or security policy may be blocking loopback listeners",
                e
            ),
        })?;
        let port = listener.local_addr().map_err(|e| OAuthError::Local {
            reason: format!("cannot determine the bound loopback port: {}", e),
        })?.port();
        // Non-blocking so the async accept does not park a worker thread. The
        // socket stays usable by `from_std`, which requires non-blocking mode and
        // would otherwise return `IncorrectState`.
        listener.set_nonblocking(true).map_err(|e| OAuthError::Local {
            reason: format!("cannot switch the callback listener to non-blocking mode: {}", e),
        })?;
        Ok(Self { inner: Some(listener), port })
    }

    /// Bind to a specific port. Only used by tests that need a deterministic
    /// address; production always uses [`Self::bind`].
    pub fn bind_port(port: u16) -> Result<Self, OAuthError> {
        let listener = std::net::TcpListener::bind(std::net::SocketAddrV4::new(
            std::net::Ipv4Addr::LOCALHOST,
            port,
        ))
        .map_err(|e| OAuthError::Local {
            reason: format!("cannot bind loopback port {} for the authorization callback: {}", port, e),
        })?;
        let bound = listener.local_addr().map_err(|e| OAuthError::Local {
            reason: format!("cannot determine the bound loopback port: {}", e),
        })?.port();
        listener.set_nonblocking(true).map_err(|e| OAuthError::Local {
            reason: format!("cannot switch the callback listener to non-blocking mode: {}", e),
        })?;
        Ok(Self { inner: Some(listener), port: bound })
    }

    /// The assigned port.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// The `redirect_uri` to register and to send in the authorization request.
    ///
    /// `127.0.0.1` is used verbatim rather than `localhost`, matching the bound
    /// address so the AS's exact-match check (RFC 8252 §8.3) succeeds. No path is
    /// appended: RFC 8252 §7.3 recommends the bare loopback URI, and adding `/
    /// callback` would have to be registered identically — extra surface for a
    /// mismatch with no benefit.
    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// Wait for one valid callback, then shut the listener down.
    ///
    /// Requests that are not the callback (favicon fetches, a browser's speculative
    /// preconnect, a stray probe) are answered `404` and the wait continues; only a
    /// request carrying `code` or `error` terminates it. Without that, a single
    /// `/favicon.ico` request from the browser would end the flow with
    /// `InvalidCallback` — a bug that presents as "login randomly fails".
    pub async fn serve_once(
        mut self,
        expected_state: &str,
        overall_timeout: Duration,
    ) -> Result<CallbackOutcome, OAuthError> {
        let std_listener = self.inner.take().ok_or_else(|| OAuthError::Local {
            reason: "the callback listener was already consumed".into(),
        })?;
        let listener = tokio::net::TcpListener::from_std(std_listener).map_err(|e| {
            OAuthError::Local { reason: format!("cannot adopt the callback listener into tokio: {}", e) }
        })?;

        let deadline = tokio::time::sleep(overall_timeout);
        tokio::pin!(deadline);
        loop {
            let (stream, peer) = tokio::select! {
                accepted = listener.accept() => match accepted {
                    Ok(pair) => pair,
                    // ECONNABORTED on a listener is transient; anything else means
                    // the socket is unusable and waiting further would hang until
                    // the overall deadline with no diagnostic.
                    Err(e) => {
                        return Err(OAuthError::Local {
                            reason: format!("the callback listener failed to accept a connection: {}", e),
                        });
                    }
                },
                _ = &mut deadline => {
                    return Err(OAuthError::TimedOut { after: overall_timeout });
                }
            };
            // Remaining budget for this one connection, never exceeding the
            // overall deadline.
            let remaining = deadline
                .as_ref()
                .deadline()
                .saturating_duration_since(tokio::time::Instant::now())
                .min(SOCKET_IDLE_TIMEOUT);
            match tokio::time::timeout(remaining, handle_callback_connection(stream, expected_state)).await {
                Ok(Ok(Some(outcome))) => return Ok(outcome),
                // A non-callback request: already answered 404, keep waiting.
                Ok(Ok(None)) => continue,
                // A malformed or hostile request. Answered 400; keep waiting for
                // the real callback, because giving up here would let any local
                // process abort the user's login by connecting to the port.
                Ok(Err(reason)) => {
                    tracing::debug!(peer = %peer, reason = %reason, "ignoring a non-callback request on the OAuth redirect port");
                    continue;
                }
                Err(_) => {
                    // This connection idled out; the overall deadline still governs.
                    continue;
                }
            }
        }
    }
}

impl Drop for RedirectListener {
    fn drop(&mut self) {
        // Nothing explicit needed: closing the std listener releases the port.
        // The `Drop` impl exists to make that ownership visible — a reader
        // wondering "who closes this socket?" finds the answer here rather than
        // having to trace `serve_once`'s move semantics.
        self.inner = None;
    }
}

/// Handle one connection to the redirect port.
///
/// Returns `Ok(Some(outcome))` for a genuine callback, `Ok(None)` for a request
/// that is clearly not one (so the caller keeps waiting), and `Err(reason)` for a
/// request that tried to be a callback and failed validation.
async fn handle_callback_connection(
    stream: tokio::net::TcpStream,
    expected_state: &str,
) -> Result<Option<CallbackOutcome>, String> {
    use tokio::io::AsyncReadExt;
    let mut stream = stream;
    // Cap the request we will read. An authorization callback's request line and
    // headers are a few hundred bytes; 16 KiB is far beyond any legitimate one
    // and bounds what a hostile local process can make us buffer.
    const MAX_REQUEST_BYTES: usize = 16 * 1024;
    let mut buf = vec![0u8; MAX_REQUEST_BYTES];
    let mut filled = 0usize;
    // Read until the header terminator. A partial read is normal (TCP), so loop
    // rather than assuming one `read` delivers the whole request.
    let request_text = loop {
        if filled >= MAX_REQUEST_BYTES {
            return respond_and_fail(&mut stream, 413, "Payload Too Large", "request too large")
                .await
                .map(|_| None)
                .map_err(|e| e);
        }
        let n = stream.read(&mut buf[filled..]).await.map_err(|e| format!("read error: {}", e))?;
        if n == 0 {
            return Err("peer closed the connection before sending a request".into());
        }
        filled += n;
        if let Some(text) = headers_complete(&buf[..filled]) {
            break text;
        }
    };

    let (method, target) = parse_request_line(&request_text).ok_or("unparseable request line")?;
    // Only GET is meaningful for a redirect. Some browsers (and the AS's own
    // error page) may POST, so a non-GET with a valid `code` in the body would be
    // accepted too — but we do not read bodies, so reject non-GET outright rather
    // than half-support it.
    if method != "GET" {
        let _ = write_response(&mut stream, 405, "Method Not Allowed", "This endpoint only accepts the authorization redirect (GET).").await;
        return Ok(None);
    }
    let (path, query) = split_target(&target);
    // `/favicon.ico`, `/robots.txt` and speculative preconnects are answered and
    // skipped. See `serve_once` for why skipping matters.
    if path != "/" && !query.contains("code=") && !query.contains("error=") {
        let _ = write_response(&mut stream, 404, "Not Found", "Not the authorization callback.").await;
        return Ok(None);
    }
    let params = parse_query(query);
    let host_ok = request_host_is_loopback(&request_text);
    if !host_ok {
        // RFC 8252 §8.3 / DNS-rebinding defence: a `Host` header naming anything
        // other than our loopback literal means the request arrived via a rebinding
        // proxy or a misconfigured browser. Answering it with our page would let a
        // foreign origin read the response.
        let _ = write_response(&mut stream, 421, "Misdirected Request", "This listener only serves loopback requests.").await;
        return Err("the `Host` header did not name a loopback address".into());
    }

    if let Some(error) = params.get("error").filter(|s| !s.is_empty()) {
        let description = params.get("error_description").cloned();
        let state = params.get("state").cloned().unwrap_or_default();
        let _ = write_response(&mut stream, 400, "Bad Request", &denied_page(error, description.as_deref())).await;
        // `state` on an error response still must match: otherwise any local
        // process could forge `?error=access_denied` and cancel the user's login.
        if !constant_time_eq(&state, expected_state) {
            return Err("the error callback carried a mismatched state".into());
        }
        return Ok(Some(CallbackOutcome::Denied {
            error: error.clone(),
            error_description: description,
        }));
    }

    let code = match params.get("code").filter(|s| !s.is_empty()) {
        Some(c) => c.clone(),
        // A GET to `/` with no `code` and no `error` is a human poking at the
        // port in their browser. Tell them what it is and keep waiting.
        None => {
            let _ = write_response(&mut stream, 200, "OK", WAITING_PAGE).await;
            return Ok(None);
        }
    };
    let state = params.get("state").cloned().unwrap_or_default();
    if !constant_time_eq(&state, expected_state) {
        // The CSRF check. A mismatch means either a stale tab from a previous
        // attempt replaying its callback, or something hostile trying to inject a
        // code it obtained elsewhere (which would bind *our* PKCE verifier to
        // *their* authorization). Both must be refused, and the real callback may
        // still arrive afterwards, so this is an `Err` (skip) not a terminal
        // failure.
        let _ = write_response(&mut stream, 400, "Bad Request", STATE_MISMATCH_PAGE).await;
        return Err("the callback state did not match the expected value".into());
    }
    let _ = write_response(&mut stream, 200, "OK", SUCCESS_PAGE).await;
    Ok(Some(CallbackOutcome::Code { code, state }))
}

/// Convenience wrapper used when we need to answer and then report a soft failure.
async fn respond_and_fail(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    reason: &str,
    body: &str,
) -> Result<(), String> {
    let _ = write_response(stream, status, reason, body).await;
    Err(format!("HTTP {} {}", status, reason))
}

/// Have we seen the `\r\n\r\n` (or `\n\n`) header terminator?
///
/// Handles both line endings because HTTP/1.1 mandates CRLF while hand-rolled
/// clients and some test harnesses send bare LF; refusing LF would make our own
/// tests need a bespoke client.
fn headers_complete(buf: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(buf);
    if text.contains("\r\n\r\n") || text.contains("\n\n") {
        Some(text.to_string())
    } else {
        None
    }
}

/// Extract `METHOD` and the request target from the first line.
fn parse_request_line(request: &str) -> Option<(String, String)> {
    let first = request.lines().next()?.trim_end();
    let mut parts = first.split_whitespace();
    let method = parts.next()?.to_ascii_uppercase();
    let target = parts.next()?.to_string();
    Some((method, target))
}

/// Split `/path?query` into its halves.
fn split_target(target: &str) -> (&str, &str) {
    match target.find('?') {
        Some(i) => (&target[..i], &target[i + 1..]),
        None => (target, ""),
    }
}

/// Parse a query string into decoded key/value pairs.
///
/// Percent-decoding is required, not optional: ASes encode the `state` and
/// `error_description` values, and a `+`-containing base64url-free state compared
/// against its encoded form would never match — producing a permanent
/// `StateMismatch` that looks like a CSRF attack.
fn parse_query(query: &str) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = match pair.find('=') {
            Some(i) => (&pair[..i], &pair[i + 1..]),
            None => (pair, ""),
        };
        out.insert(percent_decode(k), percent_decode(v));
    }
    out
}

/// Percent-decode, with `+` treated as a space per the form-encoding convention
/// that every OAuth implementation uses in query strings.
fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                match (hi, lo) {
                    (Some(h), Some(l)) => {
                        out.push((h * 16 + l) as u8);
                        i += 3;
                    }
                    // A malformed escape is passed through literally: rejecting
                    // the whole parameter would turn a server quirk into a failed
                    // login, and the literal `%zz` cannot collide with a real value.
                    _ => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Does the request's `Host` header name a loopback address?
///
/// Accepts `127.0.0.1:<port>`, `[::1]:<port>`, and a bare `127.0.0.1`. Everything
/// else — including `localhost` — is refused. Refusing `localhost` here is
/// stricter than RFC 8252 requires for the *client* side, but this is a server
/// checking who is talking to it, and a rebinding attack works precisely by
/// making the browser send a non-loopback `Host` to a loopback socket. The socket
/// is already bound to `127.0.0.1`, so a legitimate browser redirect will always
/// carry a loopback host.
fn request_host_is_loopback(request: &str) -> bool {
    let Some(host_header) = request.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name.trim().eq_ignore_ascii_case("host") {
            Some(value.trim().to_string())
        } else {
            None
        }
    }) else {
        // HTTP/1.0 without a Host header: we cannot validate, and the socket is
        // loopback-bound anyway, so allow rather than break a conformant-but-old
        // client. This branch is unreachable from any modern browser.
        return true;
    };
    // Strip an optional port and IPv6 brackets.
    let host = match host_header.rsplit_once(':') {
        // Only treat it as host:port when the part after the colon is all digits,
        // so an IPv6 literal (`[::1]`) is not truncated to `[::`.
        Some((h, p)) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => h,
        _ => host_header.as_str(),
    };
    let host = host.trim_matches(|c| c == '[' || c == ']');
    is_loopback_host(host)
}

/// Compare two strings without leaking length/prefix timing.
///
/// A constant-time comparison of a CSRF token is arguably belt-and-braces — the
/// token is not a secret an attacker can iterate against in real time over a
/// loopback socket — but the cost is trivial and the alternative (a plain `==`)
/// invites the next reader to assume timing does not matter anywhere in this file,
/// including for the verifier comparison that happens server-side.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Write a minimal HTTP/1.1 response and close the connection.
///
/// `Connection: close` is deliberate: this listener serves at most one meaningful
/// request and then the socket is dropped, so advertising keep-alive would leave
/// the browser holding a connection that is about to vanish, which some browsers
/// report as a failed page load.
async fn write_response(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    reason: &str,
    html_body: &str,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let body = html_body.as_bytes();
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nConnection: close\r\n\r\n",
        status,
        reason,
        body.len()
    );
    stream.write_all(head.as_bytes()).await.map_err(|e| e.to_string())?;
    stream.write_all(body).await.map_err(|e| e.to_string())?;
    stream.flush().await.map_err(|e| e.to_string())?;
    let _ = stream.shutdown().await;
    Ok(())
}

/// Page shown when the authorization succeeds.
///
/// Tells the user what happened and that they may close the tab. Without it the
/// browser shows a blank page or a connection error, and users reasonably conclude
/// the login failed even though it worked — a support burden with no technical
/// content. `Cache-Control: no-store` (set on every response) keeps the `code`
/// out of browser history and caches.
pub const SUCCESS_PAGE: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
<title>Authorization complete</title></head><body style=\"font-family:system-ui,sans-serif;\
text-align:center;padding:4rem 1rem\"><h1>Authorization complete</h1>\
<p>You can close this tab and return to Gourd Work.</p></body></html>";

/// Page shown while the listener is up but no callback has arrived.
pub const WAITING_PAGE: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
<title>Waiting for authorization</title></head><body style=\"font-family:system-ui,sans-serif;\
text-align:center;padding:4rem 1rem\"><h1>Waiting for authorization</h1>\
<p>This page is listening for an OAuth callback. Complete the sign-in in the tab that opened \
from Gourd Work.</p></body></html>";

/// Page shown when the `state` does not match.
pub const STATE_MISMATCH_PAGE: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
<title>Authorization rejected</title></head><body style=\"font-family:system-ui,sans-serif;\
text-align:center;padding:4rem 1rem\"><h1>Authorization rejected</h1>\
<p>This callback did not match the pending request (a stale tab, or a mismatched session). \
Nothing was changed. Start the authorization again from Gourd Work.</p></body></html>";

/// Page shown when the AS reports the user declined.
///
/// Built per-error rather than a constant because the `error_description` is worth
/// showing: `access_denied` alone does not distinguish "user clicked cancel" from
/// "the AS policy refused this client", and the latter needs the server's own words
/// to be diagnosable.
fn denied_page(error: &str, description: Option<&str>) -> String {
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Authorization \
         failed</title></head><body style=\"font-family:system-ui,sans-serif;text-align:center;\
         padding:4rem 1rem\"><h1>Authorization did not complete</h1><p>Error: <code>{}</code></p>{}\
         <p>You can close this tab.</p></body></html>",
        html_escape(error),
        match description.filter(|d| !d.trim().is_empty()) {
            Some(d) => format!("<p>{}</p>", html_escape(d)),
            None => String::new(),
        }
    )
}

/// Escape the three characters that matter when interpolating into HTML.
///
/// The interpolated values come off a URL we do not control, so this is an XSS
/// guard on a page served from the user's own machine: without it, an AS (or
/// anything that can hit our loopback port) could inject a script that runs with
/// `http://127.0.0.1` as its origin — which is exactly the origin our listener
/// trusts.
fn html_escape(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for c in raw.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/* ─────────────────────────────── Unit tests ─────────────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// A credential set with everything filled in, so individual tests only have
    /// to override the fields whose behaviour they are pinning.
    fn sample_credentials(resource: &str) -> StoredCredentials {
        StoredCredentials {
            access_token: "access-abc".into(),
            refresh_token: Some("refresh-xyz".into()),
            token_type: "Bearer".into(),
            expires_at: Some(1_000),
            scope: vec!["mcp.read".into()],
            stored_at: 900,
            resource: resource.into(),
            authorization_server: "https://as.example.com".into(),
            endpoints: TokenEndpoints {
                token_endpoint: "https://as.example.com/token".into(),
                authorization_endpoint: "https://as.example.com/authorize".into(),
                registration_endpoint: None,
                issuer: "https://as.example.com".into(),
            },
            client: ClientRegistration {
                client_id: "client-1".into(),
                client_secret: None,
                token_endpoint_auth_method: "none".into(),
                redirect_uris: vec!["http://127.0.0.1:0".into()],
                registration_access_token: None,
                registration_client_uri: None,
                scope: vec!["mcp.read".into()],
                source: ClientSource::Configured,
            },
            capabilities: DiscoveredCapabilities {
                server_name: "demo".into(),
                tools_list_result: Some(serde_json::json!({ "tools": [] })),
                protocol_version: Some("2025-03-26".into()),
                session_id: None,
                discovered_at: 895,
            },
        }
    }

    fn s(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    // ── 401 challenge ─────────────────────────────────────────────────────

    #[test]
    fn classify_401_absent_header_is_empty_and_not_actionable() {
        let c = classify_401(None);
        assert_eq!(c, UnauthorizedChallenge::none());
        assert_eq!(c.scheme, None);
        assert!(!c.is_bearer());
        assert!(!c.should_authorize());
        assert!(!c.token_rejected());
        assert!(!c.insufficient_scope());
        assert!(c.resource_metadata.is_none());
        assert!(c.raw.is_empty());

        // An explicitly empty header is the same as an absent one.
        let blank = classify_401(Some("   "));
        assert_eq!(blank, UnauthorizedChallenge::none());
        assert!(!blank.should_authorize());
    }

    #[test]
    fn classify_401_bearer_with_resource_metadata() {
        let c = classify_401(Some(
            "Bearer realm=\"x\", resource_metadata=\"https://resource.example.com/.well-known/oauth-protected-resource/mcp\"",
        ));
        assert_eq!(c.scheme.as_deref(), Some("bearer"));
        assert_eq!(c.realm.as_deref(), Some("x"));
        assert!(c.is_bearer());
        assert!(c.should_authorize());
        assert_eq!(
            c.resource_metadata.as_deref(),
            Some("https://resource.example.com/.well-known/oauth-protected-resource/mcp")
        );
        assert!(!c.token_rejected());
        assert!(!c.insufficient_scope());
        assert!(!c.raw.is_empty());
    }

    #[test]
    fn classify_401_invalid_token_and_insufficient_scope() {
        let rejected = classify_401(Some(
            "Bearer error=\"invalid_token\", error_description=\"expired\", scope=\"mcp.read mcp.write\"",
        ));
        assert!(rejected.is_bearer());
        assert!(rejected.token_rejected());
        assert!(!rejected.insufficient_scope());
        assert_eq!(rejected.error.as_deref(), Some("invalid_token"));
        assert_eq!(rejected.error_description.as_deref(), Some("expired"));
        assert_eq!(rejected.scopes, s(&["mcp.read", "mcp.write"]));

        let scoped = classify_401(Some("Bearer error=\"insufficient_scope\""));
        assert!(scoped.insufficient_scope());
        assert!(!scoped.token_rejected());
        assert!(scoped.should_authorize());
    }

    #[test]
    fn classify_401_is_tolerant_of_case_and_extra_spaces() {
        let c = classify_401(Some(
            "  bEaReR   Realm =  \"mcp\" ,  ERROR =  INVALID_TOKEN ,  resource_metadata = \"https://as.example.com/meta\" , scope = \" a   b \"  ",
        ));
        assert_eq!(c.scheme.as_deref(), Some("bearer"));
        assert_eq!(c.realm.as_deref(), Some("mcp"));
        assert_eq!(c.error.as_deref(), Some("INVALID_TOKEN"));
        assert_eq!(c.resource_metadata.as_deref(), Some("https://as.example.com/meta"));
        assert_eq!(c.scopes, s(&["a", "b"]));
        assert!(c.should_authorize());
        // The implementation compares `error` verbatim; mixed-case error codes
        // are therefore NOT normalised. Pin the real behaviour rather than the
        // ideal one.
        assert!(!c.token_rejected());
    }

    #[test]
    fn classify_401_bare_bearer_and_basic_challenge() {
        let bare = classify_401(Some("Bearer"));
        assert!(bare.is_bearer());
        assert!(bare.should_authorize());

        let basic = classify_401(Some("Basic realm=\"proxy\""));
        assert_eq!(basic.scheme.as_deref(), Some("basic"));
        assert!(!basic.is_bearer());
        assert!(!basic.should_authorize());
    }

    #[test]
    fn parse_auth_params_handles_quoted_commas_and_escapes() {
        // A comma inside a quoted value must not be mistaken for a separator;
        // an escaped quote must not terminate the value early.
        let params = parse_auth_params(
            "error_description=\"too many, too fast\", error_uri=\"https://as.example.com/a?q=1,2\", scope=\"a b\"",
        );
        let map: HashMap<String, String> = params.into_iter().collect();
        assert_eq!(map.get("error_description").map(String::as_str), Some("too many, too fast"));
        assert_eq!(map.get("error_uri").map(String::as_str), Some("https://as.example.com/a?q=1,2"));
        assert_eq!(map.get("scope").map(String::as_str), Some("a b"));

        let escaped = parse_auth_params("d=\"say \\\"hi\\\"\"");
        assert_eq!(escaped, vec![("d".to_string(), "say \"hi\"".to_string())]);
    }

    // ── Well-known URLs ───────────────────────────────────────────────────

    #[test]
    fn protected_resource_metadata_url_inserts_before_path() {
        assert_eq!(
            protected_resource_metadata_url("https://host.example.com/mcp"),
            Some("https://host.example.com/.well-known/oauth-protected-resource/mcp".into())
        );
        assert_eq!(
            protected_resource_metadata_url("https://host.example.com/a/b"),
            Some("https://host.example.com/.well-known/oauth-protected-resource/a/b".into())
        );
        assert_eq!(
            protected_resource_metadata_url("https://host.example.com"),
            Some("https://host.example.com/.well-known/oauth-protected-resource".into())
        );
        // Query and fragment are dropped: they are request data, not identity.
        assert_eq!(
            protected_resource_metadata_url("https://host.example.com/mcp?tenant=7#frag"),
            Some("https://host.example.com/.well-known/oauth-protected-resource/mcp".into())
        );
        // Explicit non-default port is preserved; IPv6 is re-bracketed.
        assert_eq!(
            protected_resource_metadata_url("http://127.0.0.1:8080/mcp/"),
            Some("http://127.0.0.1:8080/.well-known/oauth-protected-resource/mcp".into())
        );
        assert_eq!(
            protected_resource_metadata_url("https://[::1]:8443/mcp"),
            Some("https://[::1]:8443/.well-known/oauth-protected-resource/mcp".into())
        );
        // Not absolute http(s) → no derivable location.
        assert_eq!(protected_resource_metadata_url("/relative/path"), None);
        assert_eq!(protected_resource_metadata_url("ftp://host.example.com/mcp"), None);
    }

    #[test]
    fn authorization_server_metadata_candidates_try_insertion_then_oidc_append() {
        let candidates = authorization_server_metadata_candidates("https://as.example.com/tenant1");
        assert_eq!(candidates.len(), 2);
        assert_eq!(
            candidates[0],
            "https://as.example.com/.well-known/oauth-authorization-server/tenant1"
        );
        assert_eq!(
            candidates[1],
            "https://as.example.com/tenant1/.well-known/openid-configuration"
        );

        // The single-URL helper trims trailing slashes (RFC 8414 §3.1).
        assert_eq!(
            authorization_server_metadata_url("https://as.example.com/tenant1/"),
            Some("https://as.example.com/.well-known/oauth-authorization-server/tenant1".into())
        );
        assert_eq!(
            authorization_server_metadata_url("https://as.example.com"),
            authorization_server_metadata_url("https://as.example.com/")
        );
        assert_eq!(authorization_server_metadata_url("not-a-url"), None);
    }

    #[test]
    fn authorization_server_metadata_root_issuer_candidates() {
        let candidates = authorization_server_metadata_candidates("https://as.example.com/");
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0], "https://as.example.com/.well-known/oauth-authorization-server");
        assert_eq!(candidates[1], "https://as.example.com/.well-known/openid-configuration");
        assert_eq!(authorization_server_metadata_candidates("file:///tmp/x"), Vec::<String>::new());
    }

    // ── Loopback ──────────────────────────────────────────────────────────

    #[test]
    fn is_loopback_host_accepts_only_ip_literals() {
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("127.0.0.53"));
        assert!(is_loopback_host("::1"));
        assert!(is_loopback_host("[::1]"));
        assert!(is_loopback_host("0:0:0:0:0:0:0:1"));
        assert!(!is_loopback_host("example.com"));
        assert!(!is_loopback_host("8.8.8.8"));
        assert!(!is_loopback_host("localhost"));
        assert!(!is_loopback_host("localhost.evil.example.com"));
        assert!(!is_loopback_host("127.0.0.1.evil.example.com"));
        assert!(!is_loopback_host("http://127.0.0.1"));
        assert!(!is_loopback_host("127.0.0.1:8080"));
        assert!(!is_loopback_host(""));
    }

    // ── PKCE ──────────────────────────────────────────────────────────────

    #[test]
    fn select_pkce_method_only_accepts_s256_or_unspecified() {
        assert_eq!(select_pkce_method(&[]), Ok(PkceMethod::S256));
        assert_eq!(select_pkce_method(&s(&["plain", "S256"])), Ok(PkceMethod::S256));
        // Case-insensitive matching of the advertised value.
        assert_eq!(select_pkce_method(&s(&["s256"])), Ok(PkceMethod::S256));
        assert_eq!(
            select_pkce_method(&s(&["plain"])),
            Err(OAuthError::PkceUnsupported { supported: s(&["plain"]) })
        );
        assert_eq!(
            select_pkce_method(&s(&["S512", "plain"])),
            Err(OAuthError::PkceUnsupported { supported: s(&["S512", "plain"]) })
        );
        assert_eq!(PkceMethod::parse(" s256 ").as_str(), "S256");
        assert_eq!(PkceMethod::parse("PLAIN"), PkceMethod::Plain);
        assert_eq!(PkceMethod::parse("S512"), PkceMethod::Other("S512".into()));
    }

    #[test]
    fn s256_challenge_matches_rfc7636_appendix_b_vector() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(s256_challenge(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        // 43 chars, base64url alphabet, no padding.
        let challenge = s256_challenge(verifier);
        assert_eq!(challenge.len(), 43);
        assert!(challenge.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert!(!challenge.contains('='));

        // Pin the encoding explicitly against the same RFC vector.
        use base64::Engine as _;
        use sha2::{Digest as _, Sha256};
        let digest = Sha256::digest(verifier.as_bytes());
        assert_eq!(
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn pkce_pair_generate_is_well_formed() {
        let pair = PkcePair::generate();
        assert_eq!(pair.code_challenge_method, PKCE_METHOD_S256);
        assert_eq!(pair.code_verifier.len(), 64);
        assert!(pair.code_verifier.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_eq!(pair.code_challenge, s256_challenge(&pair.code_verifier));
        assert_eq!(pair.state.len(), 43);
        assert_ne!(PkcePair::generate().code_verifier, pair.code_verifier);
    }

    // ── Metadata ──────────────────────────────────────────────────────────

    #[test]
    fn authorization_server_metadata_required_endpoints() {
        let mut meta = AuthorizationServerMetadata::default();
        assert_eq!(meta.missing_required_endpoints(), vec!["authorization_endpoint", "token_endpoint"]);
        meta.authorization_endpoint = Some("https://as.example.com/authorize".into());
        assert_eq!(meta.missing_required_endpoints(), vec!["token_endpoint"]);
        meta.token_endpoint = Some("  ".into()); // whitespace-only counts as missing
        assert_eq!(meta.missing_required_endpoints(), vec!["token_endpoint"]);
        meta.token_endpoint = Some("https://as.example.com/token".into());
        assert!(meta.missing_required_endpoints().is_empty());
    }

    #[test]
    fn authorization_server_metadata_public_client_and_refresh() {
        let mut meta = AuthorizationServerMetadata::default();
        assert!(meta.allows_public_client()); // empty = unspecified
        assert!(meta.supports_refresh()); // empty = unknown

        meta.token_endpoint_auth_methods_supported = s(&["client_secret_basic", "client_secret_post"]);
        assert!(!meta.allows_public_client());
        meta.token_endpoint_auth_methods_supported = s(&["none"]);
        assert!(meta.allows_public_client());
        meta.token_endpoint_auth_methods_supported = s(&["NONE"]);
        assert!(meta.allows_public_client());

        meta.grant_types_supported = s(&["authorization_code", "implicit"]);
        assert!(!meta.supports_refresh());
        meta.grant_types_supported = s(&["authorization_code", "REFRESH_TOKEN"]);
        assert!(meta.supports_refresh());
    }

    #[test]
    fn metadata_deserializes_string_or_list_and_ignores_unknowns() {
        let prm: ProtectedResourceMetadata = serde_json::from_value(serde_json::json!({
            "resource": "https://host.example.com/mcp",
            "authorization_servers": "https://as.example.com",
            "scopes_supported": "mcp.read mcp.write",
            "bearer_methods_supported": ["header"],
            "some_future_field": { "unexpected": true }
        }))
        .expect("string-valued list fields must not kill the document");
        assert_eq!(prm.authorization_servers, s(&["https://as.example.com"]));
        assert_eq!(prm.scopes_supported, s(&["mcp.read", "mcp.write"]));
        assert_eq!(prm.bearer_methods_supported, s(&["header"]));

        let asm: AuthorizationServerMetadata = serde_json::from_value(serde_json::json!({
            "issuer": "https://as.example.com",
            "authorization_endpoint": "https://as.example.com/authorize",
            "token_endpoint": "https://as.example.com/token",
            "code_challenge_methods_supported": "S256",
            "scopes_supported": 42
        }))
        .expect("a non-string/non-array value is ignored, not fatal");
        assert_eq!(asm.code_challenge_methods_supported, s(&["S256"]));
        assert!(asm.scopes_supported.is_empty());
    }

    #[test]
    fn protected_resource_metadata_describes_canonical_equivalence() {
        let prm = ProtectedResourceMetadata {
            resource: Some("https://HOST.example.com:443/mcp/".into()),
            ..Default::default()
        };
        assert!(prm.describes("https://host.example.com/mcp"));
        assert!(prm.describes("https://host.example.com:443/mcp"));
        assert!(!prm.describes("https://host.example.com/other"));
        assert!(!prm.describes("https://host.example.com:8443/mcp"));
        assert!(!prm.describes("http://host.example.com/mcp"));

        // A missing `resource` passes (documented leniency for real servers).
        let no_resource = ProtectedResourceMetadata::default();
        assert!(no_resource.describes("https://host.example.com/mcp"));
        // An unparseable declared value is a mismatch, not a pass.
        let bad = ProtectedResourceMetadata { resource: Some("::not a url::".into()), ..Default::default() };
        assert!(!bad.describes("https://host.example.com/mcp"));
    }

    // ── Scopes / resource ─────────────────────────────────────────────────

    #[test]
    fn negotiate_scopes_intersection_and_override() {
        let prm = s(&["mcp.read", "mcp.write", "mcp.admin"]);
        let asm = s(&["mcp.write", "mcp.read", "offline_access"]);
        assert_eq!(negotiate_scopes(&prm, &asm, &[]), s(&["mcp.read", "mcp.write"]));

        // Explicit override wins outright, even over scopes nobody advertises.
        assert_eq!(negotiate_scopes(&prm, &asm, &s(&[" mcp.admin ", "", "  "])), s(&["mcp.admin"]));
        // Empty metadata on either side → omit the `scope` parameter.
        assert!(negotiate_scopes(&[], &asm, &[]).is_empty());
        assert!(negotiate_scopes(&prm, &[], &[]).is_empty());
        // No overlap → empty (default scopes), not a guess.
        assert!(negotiate_scopes(&s(&["x"]), &s(&["y"]), &[]).is_empty());
    }

    #[test]
    fn resource_indicator_drops_query_and_normalises() {
        assert_eq!(
            resource_indicator("https://HOST.example.com:443/mcp/?tenant=7"),
            Some("https://host.example.com/mcp".into())
        );
        assert_eq!(
            resource_indicator("https://host.example.com:8443/mcp"),
            Some("https://host.example.com:8443/mcp".into())
        );
        assert_eq!(resource_indicator("ftp://host.example.com/mcp"), None);
        assert_eq!(resource_indicator("not a url"), None);
    }

    #[test]
    fn primary_authorization_server_prefers_prm_then_origin() {
        let server = "https://host.example.com:8443/mcp/sub?x=1";
        let mut prm = ProtectedResourceMetadata::default();
        // Empty PRM list → derive the origin, dropping the path and query.
        assert_eq!(primary_authorization_server(&prm, server), Some("https://host.example.com:8443".into()));

        prm.authorization_servers = s(&["  ", "https://as1.example.com", "https://as2.example.com"]);
        assert_eq!(primary_authorization_server(&prm, server), Some("https://as1.example.com".into()));

        assert_eq!(primary_authorization_server(&prm, "not a url"), Some("https://as1.example.com".into()));
        assert_eq!(
            primary_authorization_server(&ProtectedResourceMetadata::default(), "not a url"),
            None
        );
    }

    #[test]
    fn credential_key_normalises_default_port_and_trailing_slash() {
        assert_eq!(credential_key("https://h.example.com/mcp"), "https://h.example.com/mcp");
        assert_eq!(credential_key("https://h.example.com:443/mcp/"), "https://h.example.com/mcp");
        assert_eq!(credential_key("HTTPS://h.example.com/mcp"), "https://h.example.com/mcp");
        assert_eq!(
            credential_key("https://h.example.com:443/mcp"),
            credential_key(" https://h.example.com/mcp/ ")
        );
        assert_eq!(credential_key("weird key"), "weird key");
    }

    // ── Credentials / tokens ──────────────────────────────────────────────

    #[test]
    fn stored_credentials_expiry_skew_boundary() {
        let c = sample_credentials("https://host.example.com/mcp");
        assert_eq!(EXPIRY_SKEW_SECONDS, 30);
        let threshold = 1_000 - EXPIRY_SKEW_SECONDS; // 970
        assert!(c.is_valid(threshold - 1));
        assert!(!c.is_expired(threshold - 1));
        // `now == exp - skew` is already expired: the check is `now < exp - skew`.
        assert!(!c.is_valid(threshold));
        assert!(c.is_expired(threshold));
        assert!(!c.is_valid(1_000));
        assert!(c.is_valid(0));

        // Unknown expiry is usable iff the access token is non-blank.
        let mut unknown = c.clone();
        unknown.expires_at = None;
        assert!(unknown.is_valid(i64::MAX));
        unknown.access_token = "  ".into();
        assert!(!unknown.is_valid(0));
    }

    #[test]
    fn stored_credentials_can_refresh_and_matches_resource() {
        let c = sample_credentials("https://host.example.com:443/mcp/");
        assert!(c.can_refresh());
        assert!(c.matches_resource("https://host.example.com/mcp"));
        assert!(!c.matches_resource("https://other.example.com/mcp"));
        assert_eq!(c.seconds_until_expiry(900), Some(100));
        assert_eq!(c.seconds_until_expiry(1_500), Some(0));

        let mut no_rt = c.clone();
        no_rt.refresh_token = None;
        assert!(!no_rt.can_refresh());
        let mut no_endpoint = c.clone();
        no_endpoint.endpoints.token_endpoint = "  ".into();
        assert!(!no_endpoint.can_refresh());
        // Legacy credential files with an empty resource pass the audience check.
        let mut legacy = c.clone();
        legacy.resource = String::new();
        assert!(legacy.matches_resource("https://anything.example.com/mcp"));
    }

    #[test]
    fn stored_credentials_with_tokens_preserves_capabilities_and_refresh_token() {
        let c = sample_credentials("https://host.example.com/mcp");
        let response = TokenResponse {
            access_token: "new-access".into(),
            refresh_token: None, // RFC 6749 §6 permits omitting it on refresh
            token_type: "Bearer".into(),
            expires_in: Some(3600),
            scope: vec![],
        };
        let renewed = c.clone().with_tokens(&response, 2_000);
        assert_eq!(renewed.access_token, "new-access");
        assert_eq!(renewed.refresh_token, c.refresh_token);
        assert_eq!(renewed.expires_at, Some(5_600));
        assert_eq!(renewed.stored_at, 2_000);
        assert_eq!(renewed.scope, c.scope);
        assert_eq!(renewed.capabilities, c.capabilities);
        assert_eq!(renewed.endpoints, c.endpoints);
        assert_eq!(renewed.resource, c.resource);
    }

    #[test]
    fn token_response_parse_normal_and_missing_fields() {
        let full = serde_json::json!({
            "access_token": "  tok  ",
            "refresh_token": "rt",
            "token_type": "bearer",
            "expires_in": "3600",
            "scope": "mcp.read mcp.write"
        });
        let parsed = TokenResponse::parse(&full).expect("valid token response");
        assert_eq!(parsed.access_token, "tok");
        assert_eq!(parsed.refresh_token.as_deref(), Some("rt"));
        assert_eq!(parsed.token_type, "Bearer");
        assert_eq!(parsed.expires_in, Some(3600));
        assert_eq!(parsed.scope, s(&["mcp.read", "mcp.write"]));

        // Tolerated deviations: numeric expires_in, array scope, unknown token type.
        let odd = serde_json::json!({
            "access_token": "tok",
            "expires_in": 120,
            "scope": ["a", "b"],
            "token_type": "dPoP"
        });
        assert_eq!(
            TokenResponse::parse(&odd).expect("odd token response"),
            TokenResponse {
                access_token: "tok".into(),
                refresh_token: None,
                token_type: "Dpop".into(),
                expires_in: Some(120),
                scope: s(&["a", "b"]),
            }
        );

        // Minimal response: defaults to Bearer, no expiry, no scope.
        assert_eq!(
            TokenResponse::parse(&serde_json::json!({ "access_token": "only" })).unwrap(),
            TokenResponse { access_token: "only".into(), token_type: "Bearer".into(), ..Default::default() }
        );

        // Missing / blank / wrong-typed access_token is a typed error.
        for bad in [
            serde_json::json!({}),
            serde_json::json!({ "access_token": "  " }),
            serde_json::json!({ "access_token": 123 }),
        ] {
            match TokenResponse::parse(&bad) {
                Err(OAuthError::TokenRequestFailed { reason, .. }) => {
                    assert!(reason.contains("access_token"), "unexpected reason: {}", reason);
                }
                other => panic!("expected a token-request failure, got {:?}", other),
            }
        }
    }

    #[test]
    fn format_authorization_falls_back_to_bearer() {
        assert_eq!(format_authorization("", "tok"), "Bearer tok");
        assert_eq!(format_authorization("   ", "tok"), "Bearer tok");
        assert_eq!(format_authorization("Bearer", "tok"), "Bearer tok");
        assert_eq!(format_authorization(" DPoP ", "tok"), "DPoP tok");
    }

    // ── Stores / request-path header ──────────────────────────────────────

    #[tokio::test]
    async fn memory_credential_store_round_trip() {
        let store = MemoryCredentialStore::new();
        let server = "https://host.example.com/mcp";
        assert!(store.load(server).await.unwrap().is_none());
        assert!(store.list().await.unwrap().is_empty());

        let cred = sample_credentials(server);
        store.save(server, &cred).await.unwrap();
        assert_eq!(store.load(server).await.unwrap(), Some(cred.clone()));
        // A cosmetically different spelling of the same URL hits the same record.
        assert_eq!(store.load("https://host.example.com:443/mcp/").await.unwrap(), Some(cred.clone()));
        assert_eq!(store.list().await.unwrap(), vec![credential_key(server)]);

        let other = sample_credentials("https://second.example.com/mcp");
        store.save("https://second.example.com/mcp", &other).await.unwrap();
        let mut keys = store.list().await.unwrap();
        keys.sort();
        assert_eq!(keys.len(), 2);
        assert!(keys.contains(&credential_key(server)));

        // clear is idempotent.
        store.clear(server).await.unwrap();
        store.clear(server).await.unwrap();
        assert!(store.load(server).await.unwrap().is_none());
        assert_eq!(store.list().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn bearer_header_for_with_no_credentials_returns_none() {
        let store = MemoryCredentialStore::new();
        assert_eq!(
            bearer_header_for_with("https://host.example.com/mcp", &store, None, Clock::fixed(900)).await,
            None
        );
    }

    #[tokio::test]
    async fn bearer_header_for_with_valid_credential_returns_bearer() {
        // expires_at = 1000, now = 900 → inside the skew window's safe side,
        // so no client is constructed and no network call can be attempted.
        let server = "https://host.example.com/mcp";
        let store = MemoryCredentialStore::new();
        store.save(server, &sample_credentials(server)).await.unwrap();
        assert_eq!(
            bearer_header_for_with(server, &store, None, Clock::fixed(900)).await,
            Some("Bearer access-abc".to_string())
        );
    }

    #[tokio::test]
    async fn bearer_header_for_with_rejects_credential_for_another_resource() {
        // RFC 8707: a token minted for server A must not be presented to server B.
        // The credential is valid and cannot trigger a refresh (no client needed),
        // so this path is fully offline.
        let server = "https://other.example.com/mcp";
        let store = MemoryCredentialStore::new();
        store
            .save(server, &sample_credentials("https://host.example.com/mcp"))
            .await
            .unwrap();
        assert_eq!(
            bearer_header_for_with(server, &store, None, Clock::fixed(900)).await,
            None
        );
    }

    #[tokio::test]
    async fn bearer_header_for_with_expired_non_refreshable_keeps_old_header() {
        // Expired, but `can_refresh()` is false, so no OAuthClient is built and
        // no request is made; the old header is still returned per the docs.
        let server = "https://host.example.com/mcp";
        let mut cred = sample_credentials(server);
        cred.refresh_token = None;
        let store = MemoryCredentialStore::new();
        store.save(server, &cred).await.unwrap();
        assert_eq!(
            bearer_header_for_with(server, &store, None, Clock::fixed(2_000)).await,
            Some("Bearer access-abc".to_string())
        );
    }

    // ── Error taxonomy / misc pure helpers ────────────────────────────────

    #[test]
    fn oauth_error_retryable_and_needs_user() {
        use DiscoveryStage::*;
        assert!(OAuthError::TimedOut { after: Duration::from_secs(1) }.is_retryable());
        assert!(OAuthError::RefreshFailed { reason: "x".into() }.is_retryable());
        assert!(!OAuthError::needs_user(&OAuthError::TimedOut { after: Duration::from_secs(1) }));
        assert!(OAuthError::NeedsAuthorization { reason: "login".into() }.needs_user());
        assert!(!OAuthError::NeedsAuthorization { reason: "login".into() }.is_retryable());
        assert!(!OAuthError::PkceUnsupported { supported: s(&["plain"]) }.is_retryable());

        let server_err = |status| OAuthError::TokenRequestFailed {
            url: "https://as.example.com/token".into(),
            status: Some(status),
            error_code: None,
            reason: "oops".into(),
        };
        assert!(server_err(503).is_retryable());
        assert!(!server_err(400).is_retryable());
        // The `status >= 500` guard must not accidentally make the whole family
        // retryable (it used to be an illegal `matches!` binding with a guard).
        assert!(!OAuthError::DiscoveryFailed {
            stage: IncompleteMetadata,
            url: "https://as.example.com".into(),
            reason: "missing endpoints".into()
        }
        .is_retryable());
        assert!(OAuthError::DiscoveryFailed {
            stage: ProtectedResourceMetadata,
            url: "https://r.example.com".into(),
            reason: "404".into()
        }
        .is_retryable());
        assert!(!OAuthError::StateMismatch { expected_prefix: "abc".into() }.is_retryable());
        assert!(OAuthError::PkceUnsupported { supported: s(&["plain"]) }
            .humanize()
            .contains("S256"));
    }

    #[test]
    fn html_escape_covers_all_five_characters() {
        assert_eq!(html_escape("&<>\"'"), "&amp;&lt;&gt;&quot;&#39;");
        assert_eq!(html_escape("<script>alert('x' & \"y\")</script>"),
            "&lt;script&gt;alert(&#39;x&#39; &amp; &quot;y&quot;)&lt;/script&gt;");
        assert_eq!(html_escape("plain text 123"), "plain text 123");
        assert_eq!(html_escape(""), "");
    }

    #[test]
    fn registration_body_and_client_is_public() {
        let body = registration_body(
            &s(&["http://127.0.0.1:12345"]),
            &s(&["mcp.read", "mcp.write"]),
            "  Gourd Work  ",
        );
        assert_eq!(body["redirect_uris"], serde_json::json!(["http://127.0.0.1:12345"]));
        assert_eq!(body["grant_types"], serde_json::json!(["authorization_code", "refresh_token"]));
        assert_eq!(body["response_types"], serde_json::json!(["code"]));
        assert_eq!(body["token_endpoint_auth_method"], serde_json::json!("none"));
        assert_eq!(body["scope"], serde_json::json!("mcp.read mcp.write"));
        assert_eq!(body["client_name"], serde_json::json!("Gourd Work"));
        assert_eq!(body["application_type"], serde_json::json!("native"));
        assert!(registration_body(&[], &[], "  ")["scope"].is_null());
        assert!(registration_body(&[], &[], "  ")["client_name"].is_null());

        let mut c = sample_credentials("https://host.example.com/mcp").client;
        assert!(c.is_public());
        c.client_secret = Some("secret".into());
        assert!(!c.is_public());
        c.client_secret = None;
        c.token_endpoint_auth_method = "CLIENT_SECRET_POST".into();
        assert!(!c.is_public());
    }

    #[test]
    fn callback_query_parsing_and_host_validation() {
        let params = parse_query("code=a%2Bb&state=ab%2Bcd&error_description=too+many%2C+too+fast");
        assert_eq!(params.get("code").map(String::as_str), Some("a+b"));
        assert_eq!(params.get("state").map(String::as_str), Some("ab+cd"));
        assert_eq!(params.get("error_description").map(String::as_str), Some("too many, too fast"));
        assert_eq!(split_target("/cb?code=x"), ("/cb", "code=x"));
        assert_eq!(split_target("/cb"), ("/cb", ""));
        assert_eq!(parse_request_line("GET /?code=x HTTP/1.1"), Some(("GET".into(), "/?code=x".into())));

        assert!(request_host_is_loopback("GET / HTTP/1.1\r\nHost: 127.0.0.1:54321\r\n\r\n"));
        assert!(request_host_is_loopback("GET / HTTP/1.1\r\nHost: [::1]:54321\r\n\r\n"));
        assert!(!request_host_is_loopback("GET / HTTP/1.1\r\nHost: localhost:54321\r\n\r\n"));
        assert!(!request_host_is_loopback("GET / HTTP/1.1\r\nHost: evil.example.com\r\n\r\n"));
        assert!(constant_time_eq("state-1", "state-1"));
        assert!(!constant_time_eq("state-1", "state-2"));
        assert!(!constant_time_eq("a", "aa"));
    }

    #[test]
    fn credentials_serde_round_trip() {
        let cred = sample_credentials("https://host.example.com/mcp");
        let json = serde_json::to_string(&cred).unwrap();
        let back: StoredCredentials = serde_json::from_str(&json).unwrap();
        assert_eq!(back, cred);
        assert!(json.contains("\"access_token\":\"access-abc\""));
        assert!(json.contains("\"tools_list_result\""));
    }

    /* ── RFC 8628 Device Flow (行为级，非字符串凑数) ─────────────────── */

    #[test]
    fn device_code_parse_accepts_realistic_and_string_number_forms() {
        let v = serde_json::json!({
            "device_code": "dev-123",
            "user_code": "WDJB-MJHT",
            "verification_uri": "https://example.com/device",
            "verification_uri_complete": "https://example.com/device?user_code=WDJB-MJHT",
            "expires_in": "600",
            "interval": "5"
        });
        let d = super::DeviceCodeResponse::parse(&v).unwrap();
        assert_eq!(d.device_code, "dev-123");
        assert_eq!(d.user_code, "WDJB-MJHT");
        assert_eq!(d.verification_uri, "https://example.com/device");
        assert_eq!(d.poll_interval_secs(), 5);
        assert_eq!(d.expires_in_secs(), 600);
    }

    #[test]
    fn device_code_parse_rejects_missing_fields_and_non_http_uri() {
        for bad in [
            serde_json::json!({"user_code":"X","verification_uri":"https://a"}),
            serde_json::json!({"device_code":"D","verification_uri":"https://a"}),
            serde_json::json!({"device_code":"D","user_code":"X"}),
            serde_json::json!({"device_code":"D","user_code":"X","verification_uri":"javascript:alert(1)"}),
        ] {
            assert!(super::DeviceCodeResponse::parse(&bad).is_err(), "should reject {bad}");
        }
    }

    #[test]
    fn device_poll_interval_is_clamped_and_defaulted() {
        let base = super::DeviceCodeResponse {
            device_code: "d".into(), user_code: "u".into(),
            verification_uri: "https://a".into(), verification_uri_complete: String::new(),
            expires_in: 1800, interval: 0,
        };
        assert_eq!(base.poll_interval_secs(), 5);          // RFC 8628 §3.2 default
        let mut hostile = base.clone(); hostile.interval = 99999;
        assert_eq!(hostile.poll_interval_secs(), 60);
        hostile.interval = -7;
        assert_eq!(hostile.poll_interval_secs(), 5);
        let mut quick = base.clone(); quick.interval = 1; quick.expires_in = 0;
        assert_eq!(quick.poll_interval_secs(), 1);
        assert_eq!(quick.expires_in_secs(), 300);
    }

    #[test]
    fn device_poll_classifies_all_rfc8628_outcomes() {
        use super::DevicePollOutcome as O;
        let pending = serde_json::json!({"error":"authorization_pending"});
        assert_eq!(super::classify_device_poll(400, &pending, ""), O::Pending);
        let slow = serde_json::json!({"error":"slow_down"});
        assert_eq!(super::classify_device_poll(400, &slow, ""), O::SlowDown);
        let expired = serde_json::json!({"error":"expired_token"});
        assert!(matches!(super::classify_device_poll(400, &expired, ""), O::Failed(_)));
        let denied = serde_json::json!({"error":"access_denied"});
        assert!(matches!(super::classify_device_poll(400, &denied, ""), O::Failed(_)));
        // 2xx with no access_token is a malformed success: keep polling rather than
        // reporting a bogus "connected".
        assert_eq!(super::classify_device_poll(200, &serde_json::json!({}), ""), O::Pending);
        let ok = serde_json::json!({"access_token":"tok","token_type":"Bearer","expires_in":3600});
        assert!(matches!(super::classify_device_poll(200, &ok, ""), O::Granted(_)));
    }

    #[test]
    fn device_metadata_field_survives_serde_round_trip() {
        let mut m = super::AuthorizationServerMetadata::default();
        m.device_authorization_endpoint = Some("https://as.example.com/device".into());
        let s = serde_json::to_string(&m).unwrap();
        let back: super::AuthorizationServerMetadata = serde_json::from_str(&s).unwrap();
        assert_eq!(back.device_authorization_endpoint.as_deref(), Some("https://as.example.com/device"));
        // A metadata document without the field must deserialize to None, not fail.
        let bare: super::AuthorizationServerMetadata = serde_json::from_str("{\"issuer\":\"https://as\"}").unwrap();
        assert!(bare.device_authorization_endpoint.is_none());
    }

    #[test]
    fn device_registration_body_requests_device_grant_not_authorization_code() {
        let body = super::device_registration_body(&["mcp:read".into()], "demo");
        let grants = body["grant_types"].as_array().unwrap()
            .iter().map(|v| v.as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert!(grants.contains(&"urn:ietf:params:oauth:grant-type:device_code".to_string()),
            "Device Flow client must register the device_code grant: {grants:?}");
        assert!(!grants.contains(&"authorization_code".to_string()));
        assert_eq!(body["response_types"], serde_json::json!([]));
        assert_eq!(body["redirect_uris"], serde_json::json!([]));
        assert_eq!(body["token_endpoint_auth_method"], serde_json::json!("none"));
        assert_eq!(body["client_name"], serde_json::json!("demo"));
    }

    /// P0 回归护栏：一次瞬时故障不得永久作废扫码登录。
    ///
    /// 此前 5xx / 429 落进 `classify_device_poll` 的 `_` 分支被判 `Failed`，
    /// 轮询循环随即 `return Err` —— 用户正举着手机等 user_code，一次网络抖动或
    /// AS 重启就把这次登录彻底打死，还把上游 HTML 原文当成错误抛给用户。
    /// 现在这些状态必须是 `Transient`，让轮询退避后重试直到 deadline。
    #[test]
    fn device_poll_treats_transient_statuses_as_retryable_not_fatal() {
        use super::DevicePollOutcome as O;
        let empty = serde_json::json!({});
        // 网关 / AS 重启：无 error 体，甚至是一段 HTML 错误页。
        assert_eq!(super::classify_device_poll(502, &empty, "<html>Bad Gateway</html>"), O::Transient);
        assert_eq!(super::classify_device_poll(503, &empty, ""), O::Transient);
        assert_eq!(super::classify_device_poll(500, &empty, ""), O::Transient);
        assert_eq!(super::classify_device_poll(504, &empty, "Gateway Timeout"), O::Transient);
        // 轮询过快被限流：RFC 8628 用 slow_down 表达同一意图，裸 429 也必须可重试。
        assert_eq!(super::classify_device_poll(429, &empty, ""), O::Transient);
        assert_eq!(super::classify_device_poll(408, &empty, ""), O::Transient);
        // 明确的拒绝仍然是致命的，绝不能被误判成可重试而空转到过期。
        assert!(matches!(super::classify_device_poll(400, &empty, ""), O::Failed(_)));
        assert!(matches!(super::classify_device_poll(401, &empty, ""), O::Failed(_)));
        assert!(matches!(super::classify_device_poll(403, &empty, ""), O::Failed(_)));
        assert!(matches!(super::classify_device_poll(404, &empty, ""), O::Failed(_)));
    }

    /// RFC 8628 §3.5 的显式 error 码优先级高于状态码：AS 若在 503 上说
    /// `expired_token`（某些网关会改写响应体），那它就是过期，不能当瞬时故障
    /// 无限重试。反之 `slow_down` / `authorization_pending` 也必须保持原义。
    #[test]
    fn device_poll_explicit_error_code_wins_over_transient_status() {
        use super::DevicePollOutcome as O;
        let expired = serde_json::json!({"error": "expired_token"});
        assert!(matches!(super::classify_device_poll(503, &expired, ""), O::Failed(_)),
            "503 上带 expired_token 仍应判死，不得无限重试");
        let denied = serde_json::json!({"error": "access_denied"});
        assert!(matches!(super::classify_device_poll(500, &denied, ""), O::Failed(_)));
        let pending = serde_json::json!({"error": "authorization_pending"});
        assert_eq!(super::classify_device_poll(500, &pending, ""), O::Pending);
        let slow = serde_json::json!({"error": "slow_down"});
        assert_eq!(super::classify_device_poll(429, &slow, ""), O::SlowDown);
    }

    #[test]
    fn is_transient_poll_status_boundaries() {
        assert!(!super::is_transient_poll_status(200));
        assert!(!super::is_transient_poll_status(400));
        assert!(!super::is_transient_poll_status(401));
        assert!(!super::is_transient_poll_status(403));
        assert!(!super::is_transient_poll_status(404));
        assert!(super::is_transient_poll_status(408));
        assert!(super::is_transient_poll_status(429));
        assert!(!super::is_transient_poll_status(499));
        assert!(super::is_transient_poll_status(500));
        assert!(super::is_transient_poll_status(599));
        assert!(!super::is_transient_poll_status(600));
    }

    /// slow_down / 瞬时退避的算术：RFC 8628 §3.5 规定每次 +5s，且我们额外封顶
    /// 60s（否则长间隔会活过 device code 本身）。纯函数，两个调用点共用。
    #[test]
    fn back_off_poll_interval_steps_by_five_and_caps_at_sixty() {
        assert_eq!(super::back_off_poll_interval(5), 10);
        assert_eq!(super::back_off_poll_interval(10), 15);
        assert_eq!(super::back_off_poll_interval(55), 60);
        // 封顶后继续调用不再增长（幂等），且不会溢出。
        assert_eq!(super::back_off_poll_interval(60), 60);
        assert_eq!(super::back_off_poll_interval(120), 60);
        assert_eq!(super::back_off_poll_interval(u64::MAX), 60);
        assert_eq!(super::DEVICE_POLL_SLOW_DOWN_STEP_SECS, 5);
        assert_eq!(super::DEVICE_POLL_INTERVAL_CAP_SECS, 60);
    }

    /// P1 回归护栏：`verification_uri` / `verification_uri_complete` 的校验必须与
    /// `device_authorization_endpoint` 用**同一份判据**。
    ///
    /// 此前 `verification_uri` 只做 `starts_with("https://") || starts_with("http://")`
    /// 的前缀匹配（放行任意明文 http），而 `verification_uri_complete` **完全没有
    /// 校验**、却在 UI 上优先于前者被渲染成可点击链接。恶意或受损的 AS 于是可以：
    /// 用合规的 `verification_uri` 过检，同时把 `verification_uri_complete` 设为
    /// 钓鱼页，直接收走用户被要求手输的 user_code。
    #[test]
    fn device_uri_check_is_shared_and_rejects_lookalike_hosts() {
        let ok = super::device_uri_is_allowed;
        assert!(ok("https://as.example.com/device"));
        assert!(ok("https://as.example.com/device?user_code=WDJB-MJHT"));
        assert!(ok("http://localhost:8080/device"));
        assert!(ok("http://127.0.0.1:8080/device"));
        assert!(ok("http://[::1]/device"));

        // 与 endpoint 同源：同样挡住 lookalike / userinfo / 明文外网。
        assert!(!ok("http://localhost.evil.example/device"));
        assert!(!ok("http://localhost@evil.example/device"));
        assert!(!ok("http://evil.example/device?x=http://localhost"));
        assert!(!ok("http://as.example.com/device"));
        assert!(!ok("javascript:alert(1)"));
        assert!(!ok("data:text/html,<script>alert(1)</script>"));
        assert!(!ok("file:///etc/passwd"));
        assert!(!ok(""));
        assert!(!ok("not a url"));

        // 单一真源：auth 侧的别名必须与之完全一致，否则两条路径会漂移。
        assert_eq!(
            crate::mcp::auth::device_endpoint_is_allowed("http://localhost.evil.example/device"),
            ok("http://localhost.evil.example/device"),
            "auth::device_endpoint_is_allowed 与 oauth::device_uri_is_allowed 判据漂移"
        );
        assert_eq!(
            crate::mcp::auth::device_endpoint_is_allowed("https://as.example.com/device"),
            ok("https://as.example.com/device")
        );
    }

    /// P1 回归护栏：恶意 `verification_uri_complete` 必须被丢弃并回退到已校验的
    /// `verification_uri`，而不是原样下发给 UI；同时**不得**让整个登录失败——
    /// 用户仍可手输 user_code 完成授权，只是失去"点一下就填好"的便利。
    #[test]
    fn hostile_verification_uri_complete_is_dropped_and_falls_back() {
        let base = serde_json::json!({
            "device_code": "D",
            "user_code": "WDJB-MJHT",
            "verification_uri": "https://as.example.com/device",
            "expires_in": 600
        });

        // 正例：合规的 complete URI 被保留。
        let mut good = base.clone();
        good["verification_uri_complete"] = serde_json::json!("https://as.example.com/device?user_code=WDJB-MJHT");
        let d = super::DeviceCodeResponse::parse(&good).unwrap();
        assert_eq!(d.verification_uri_complete, "https://as.example.com/device?user_code=WDJB-MJHT");

        // 恶意例：钓鱼域名。解析必须成功（fail-closed 但不 fail-fatal），
        // complete 被清空，UI 因此回退到已校验的 verification_uri。
        for hostile in [
            "https://attacker.example/phish?user_code=WDJB-MJHT",
            "http://as.example.com/device",                    // 明文 http 外网
            "http://localhost.evil.example/device",             // lookalike
            "javascript:alert(1)",
        ] {
            let mut evil = base.clone();
            evil["verification_uri_complete"] = serde_json::json!(hostile);
            let d = super::DeviceCodeResponse::parse(&evil)
                .unwrap_or_else(|e| panic!("{hostile} 应被静默降级而非让整个流程失败: {e}"));
            assert!(
                d.verification_uri_complete.is_empty(),
                "恶意 verification_uri_complete 未被丢弃: {hostile} => {}",
                d.verification_uri_complete
            );
            // 回退目标本身仍然有效。
            assert_eq!(d.verification_uri, "https://as.example.com/device");
            assert_eq!(d.user_code, "WDJB-MJHT", "user_code 不得丢失");
        }

        // 缺失该字段时保持空（既有行为），由 auth.rs 回退到 verification_uri。
        let d = super::DeviceCodeResponse::parse(&base).unwrap();
        assert!(d.verification_uri_complete.is_empty());
    }

    /// `verification_uri` 本身不合规仍必须让解析失败（不能像 complete 那样降级，
    /// 因为它是唯一可信任的回退目标）。同时校验已升级为按 host 判定，
    /// 不再放行任意明文 http。
    #[test]
    fn verification_uri_itself_must_be_permitted_or_parsing_fails() {
        for bad in [
            serde_json::json!({"device_code":"D","user_code":"U","verification_uri":"javascript:alert(1)"}),
            serde_json::json!({"device_code":"D","user_code":"U","verification_uri":"http://evil.example/device"}),
            serde_json::json!({"device_code":"D","user_code":"U","verification_uri":"http://localhost.evil.example/d"}),
            serde_json::json!({"device_code":"D","user_code":"U","verification_uri":"not a url"}),
        ] {
            assert!(super::DeviceCodeResponse::parse(&bad).is_err(), "应拒绝 {bad}");
        }
        // 本地开发的回环端点仍然放行。
        let ok = serde_json::json!({"device_code":"D","user_code":"U",
            "verification_uri":"http://localhost:8080/device"});
        assert!(super::DeviceCodeResponse::parse(&ok).is_ok());
    }

    /// P1 回归护栏：本地 `devicePollIntervalSecs` 只能让轮询**变慢**，
    /// 绝不能压过 AS 在 RFC 8628 §3.2 声明的最低 `interval`。
    ///
    /// 该字段可经连接器市场目录远程投递（`normalize_server_config` 透传），
    /// 修复前一个 `"devicePollIntervalSecs": 1` 就能让本应用以 1 RPS 持续轮询
    /// 一个要求 30s 的第三方 AS 长达 `expires_in`（最多 1 小时，约 3600 次请求），
    /// 成为一个可远程投递的 DoS 原语；同时实现与字段自身文档承诺相反。
    #[test]
    fn local_poll_interval_can_only_slow_down_never_speed_up() {
        let r = super::resolve_poll_interval;
        // 服务器要求 30s：本地任何更快的值都被抬回 30s。
        assert_eq!(r(1, 30), 30, "本地 1s 不得压过服务器的 30s（DoS 原语）");
        assert_eq!(r(0, 30), 30);
        assert_eq!(r(5, 30), 30);
        assert_eq!(r(29, 30), 30);
        assert_eq!(r(30, 30), 30);
        // 本地更慢是允许的（这正是该配置项的正当用途）。
        assert_eq!(r(45, 30), 45);
        assert_eq!(r(60, 30), 60);
        // 服务器没给（默认 5s）时，本地值生效，但仍被钳制在 [1,60]。
        assert_eq!(r(7, 5), 7);
        assert_eq!(r(0, 5), 5);
        assert_eq!(r(9999, 5), 60, "本地上限仍是 60s");
    }
}
