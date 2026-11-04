//! Request-origin guard + HTTP Basic Auth for the kernel's HTTP/WS surface.
//!
//! ## Why this module exists (measured, not theoretical)
//!
//! Before this guard the kernel accepted **every** request on its loopback
//! listener with no authentication and answered `Access-Control-Allow-Origin: *`.
//! Binding to `127.0.0.1` feels like a sandbox but is not one: *any web page in
//! any browser on the machine* can issue requests to `127.0.0.1`. That is the
//! classic localhost-CSRF / DNS-rebinding surface.
//!
//! The full chain was reproduced end-to-end on 2026-10-29 (isolated home +
//! mock LLM). A page at `https://evil.example.com` issued:
//!
//! ```text
//! POST http://127.0.0.1:<port>/web/chat/input
//! Origin: https://evil.example.com
//! Content-Type: application/x-www-form-urlencoded
//! body: sessionId=rce-probe&input=...&accessMode=full
//! ```
//!
//! and the kernel logged `executing tool tool=bash action_id=call_rce_1` →
//! `run completed stop=Completed`, writing the attacker's marker file to disk.
//! The attacker could then `GET /web/chat/replay` and **read the transcript
//! back**, because `ACAO: *` made the response readable cross-origin.
//! `/web/terminal` was worse still: it spawns an interactive shell, and
//! WebSocket handshakes are not covered by CORS preflight at all.
//!
//! ## Why tightening CORS alone does NOT fix it
//!
//! `application/x-www-form-urlencoded` POST is a CORS **simple request**: the
//! browser sends it *without* preflight and the server executes it in full.
//! Restricting `Access-Control-Allow-Origin` only hides the *response* — the
//! command still runs. That turns a readable RCE into a blind RCE, which is
//! still an RCE. The defence therefore has to be a **server-side request
//! check**, which is what [`classify`] implements. CORS is narrowed too, but as
//! defence-in-depth, not as the fix.
//!
//! ## The two properties that make this sound
//!
//! 1. `Origin` and `Host` are **forbidden header names** — JavaScript in a page
//!    cannot set, change, or suppress them. A browser therefore cannot be
//!    coerced into forging an allowed value.
//! 2. Non-browser clients (curl, `reqwest`, the ACP subprocess, the desktop
//!    shell's readiness probe) send **no** `Origin` at all, so they keep working
//!    untouched. Only browsers are constrained, and only browsers are the threat.
//!
//! ## What is allowed
//!
//! * **No `Origin` header** → not a browser → allow. (Auth still applies.)
//! * **Loopback `Origin`** (`127.0.0.1`, `localhost`, `[::1]`, any port) → the
//!   legitimate `gwork --serve N --static ui` browser mode, which is same-origin.
//! * **`tauri.localhost` / `tauri://localhost`** → the desktop shell. Its page
//!   origin is `http://tauri.localhost` while the kernel listens on
//!   `http://127.0.0.1:<random port>` (see `desktop/src-tauri/src/lib.rs`), so
//!   the shell's own requests *are* cross-origin. Omitting this would white-screen
//!   the desktop app — which is precisely why `allow_origin("*")` was there.
//! * **`Host` must be loopback or `tauri.localhost`** when present. This is what
//!   actually stops DNS rebinding: an attacker's domain resolving to 127.0.0.1
//!   still sends `Host: attacker.example`, which is rejected.
//!
//! `Origin: null` is **rejected**. It is what a `file://` page or a sandboxed
//! iframe sends, and both are trivially attacker-creatable.
//!
//! ## Basic Auth
//!
//! Mirrors Java's `WebAuthFilter` (registered at `App.java:192`, ahead of the
//! CORS filter): when `general.webAuthUser`/`webAuthPass` are set, every request
//! must carry `Authorization: Basic base64(user:pass)`. Credentials injected via
//! the `GWORK_WEB_AUTH` environment variable take priority — that is the remote
//! deployment path, where the desktop shell generates a random pair per
//! connection and the remote machine's `settings.json` belongs to the remote
//! user. Malformed injection degrades to "not configured" rather than rejecting
//! everything, matching `AgentFlags.getRemoteWebAuth`.
//!
//! Neither configured → auth is off, exactly like Java. The Origin/Host guard
//! still applies, so the default local install is safe without any setup.

use axum::http::{HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};

/// Outcome of inspecting one request's `Origin` / `Host` / `Authorization`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Let the request through.
    Allow,
    /// Reject: the request came from a browser context we do not trust.
    /// Returned as 403 with a short reason.
    Forbidden(&'static str),
    /// Reject: credentials required or wrong. Returned as 401.
    /// `true` = advertise `WWW-Authenticate` so a browser shows its login prompt.
    Unauthorized(bool),
}

/// Credentials the guard enforces, if any.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BasicAuth {
    pub user: String,
    pub pass: String,
    /// Whether these came from the `GWORK_WEB_AUTH` injection rather than
    /// `settings.json`.
    ///
    /// Drives one behaviour: an injected pair means the client is the desktop
    /// shell's remote-deployment proxy, not a browser, so a 401 must **not**
    /// carry `WWW-Authenticate` — that header makes a browser pop a login dialog
    /// nobody is there to answer, and the connection just hangs. Java's filter
    /// makes exactly this distinction.
    ///
    /// Carried on the struct rather than re-read from the environment inside
    /// [`classify`] so the decision stays a pure function of its arguments and
    /// the tests do not depend on process-global env state.
    pub injected: bool,
}

impl BasicAuth {
    /// Auth is enforced only when **both** halves are non-empty. Java's filter
    /// treats a blank either side as "not configured" (`Utils.isBlank`), and
    /// half-configured credentials would otherwise lock the user out of their
    /// own kernel with no way to reach the settings page that fixes it.
    pub fn is_enforced(&self) -> bool {
        !self.user.trim().is_empty() && !self.pass.trim().is_empty()
    }

    /// Parse the `GWORK_WEB_AUTH` / `-Dgwork.web.auth` injection form `user:pass`.
    ///
    /// Returns `None` on any malformed input — missing colon, empty user, empty
    /// password. Degrading to "not configured" is deliberate: rejecting every
    /// request because of a typo in an env var would make the kernel unreachable
    /// and the cause invisible.
    pub fn from_injection(raw: Option<&str>) -> Option<Self> {
        let raw = raw?.trim();
        if raw.is_empty() {
            return None;
        }
        let idx = raw.find(':')?;
        // `idx == 0` → empty user; `idx == len-1` → empty password.
        if idx == 0 || idx >= raw.len() - 1 {
            return None;
        }
        let (user, pass) = raw.split_at(idx);
        Some(Self {
            user: user.to_string(),
            pass: pass[1..].to_string(),
            injected: true,
        })
    }

    /// Read the injected credentials from the environment.
    ///
    /// Env var first, matching Java's `AgentFlags.getRemoteWebAuth` (the desktop
    /// shell's P1-3 fix moved off the command line because a `-D` argument is
    /// visible to every other process on the remote host via `ps`).
    pub fn from_env() -> Option<Self> {
        Self::from_injection(std::env::var("GWORK_WEB_AUTH").ok().as_deref())
    }

    /// Credentials from `settings.json`, i.e. the non-injected path.
    ///
    /// `None` halves become empty strings, which `is_enforced` then reads as
    /// "not configured" — the same as Java, where a null field fails `isBlank`.
    pub fn from_settings(user: Option<&str>, pass: Option<&str>) -> Self {
        Self {
            user: user.unwrap_or_default().to_string(),
            pass: pass.unwrap_or_default().to_string(),
            injected: false,
        }
    }

    /// Effective credentials: injection wins over settings.
    ///
    /// The remote machine's `settings.json` belongs to the remote user, so the
    /// desktop shell's per-connection random pair must take precedence — Java's
    /// filter checks `getRemoteWebAuth()` first for the same reason.
    pub fn effective(settings_user: Option<&str>, settings_pass: Option<&str>) -> Self {
        Self::from_env().unwrap_or_else(|| Self::from_settings(settings_user, settings_pass))
    }
}

/// Path prefixes served as static assets. Exempt from **Basic Auth** only.
///
/// Java's `WebAuthFilter` whitelists `/css/ /js/ /layui/ /highlight/ /img/` and
/// `/favicon.ico` so the login prompt can render a styled page. This kernel's UI
/// additionally ships `locales/` (i18n JSON, fetched before any auth prompt can
/// be answered) and `monaco/` (the editor's workers).
///
/// The Origin/Host guard still applies to these — they are only exempt from the
/// credential check.
const STATIC_PREFIXES: &[&str] = &[
    "/css/",
    "/js/",
    "/layui/",
    "/highlight/",
    "/img/",
    "/locales/",
    "/monaco/",
];

/// The readiness probe. Exempt from Basic Auth.
///
/// `desktop/src-tauri/src/lib.rs::wait_for_kernel` polls this to decide when the
/// kernel is up, and it sends no credentials. Enforcing auth here would make the
/// desktop shell wait out its whole timeout and report "kernel did not become
/// ready" whenever the user had configured a password — a self-inflicted
/// startup failure. The endpoint reports only version/paths, and it stays behind
/// the Origin/Host guard, so a web page still cannot use it.
const AUTH_EXEMPT_PATHS: &[&str] = &["/web/chat/meta"];

fn is_static_asset(path: &str) -> bool {
    // A path containing a `..` segment is never treated as a static asset.
    //
    // Without this, `/css/../web/chat/input` matches the `/css/` prefix and skips
    // the credential check — an auth bypass by string prefix alone. Whether the
    // router would then dispatch it to the real handler depends on axum's
    // normalisation, which is not a property to build a security boundary on:
    // a proxy in front, or an axum upgrade, could change it. Refusing to exempt
    // any non-canonical path costs nothing (browsers request real asset paths)
    // and removes the question.
    if path.split('/').any(|seg| seg == "..") {
        return false;
    }
    path == "/favicon.ico" || STATIC_PREFIXES.iter().any(|p| path.starts_with(p))
}

/// Hostnames that count as loopback for both `Origin` and `Host`.
fn is_loopback_host(host: &str) -> bool {
    let h = host.trim();
    if h.is_empty() {
        return false;
    }
    // IPv6 literal: `[::1]:8080` or bare `::1`. The bracketed form must be
    // unwrapped *before* any port handling, and the port must not be stripped by
    // splitting on ':' — an IPv6 address is mostly colons, so `split(':').next()`
    // on `::1` yields the empty string and every IPv6 loopback would be rejected.
    if let Some(rest) = h.strip_prefix('[') {
        // Everything after the closing bracket must be either nothing or `:port`.
        // Taking only the text before `]` and ignoring the remainder would accept
        // `[::1].evil.example` as loopback — a suffix-match bypass.
        let (inner, tail) = match rest.split_once(']') {
            Some(pair) => pair,
            // An unterminated bracket is not a valid host; deny rather than guess.
            None => return false,
        };
        if !tail.is_empty() {
            let Some(port) = tail.strip_prefix(':') else { return false };
            // Port must be all digits, so `[::1]:x.evil.example` is denied too.
            if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
                return false;
            }
        }
        return is_loopback_name(inner);
    }
    // Bare IPv6 (two or more colons, no brackets): no port can be present
    // unambiguously, so judge the whole string.
    if h.matches(':').count() >= 2 {
        return is_loopback_name(h);
    }
    // IPv4 / hostname, optionally with `:port`.
    let bare = h.split(':').next().unwrap_or(h);
    is_loopback_name(bare)
}

/// The loopback names themselves, with a trailing dot (FQDN form) tolerated.
fn is_loopback_name(h: &str) -> bool {
    let h = h.trim_end_matches('.');
    matches!(h, "127.0.0.1" | "localhost" | "::1" | "0.0.0.0")
}

/// The Tauri webview's page origin. `http(s)://tauri.localhost` on Windows,
/// `tauri://localhost` on macOS/Linux.
fn is_tauri_origin(origin: &str) -> bool {
    let o = origin.trim().trim_end_matches('/');
    let lower = o.to_ascii_lowercase();
    lower == "http://tauri.localhost"
        || lower == "https://tauri.localhost"
        || lower == "tauri://localhost"
}

/// Extract the host part of an `Origin` value (`scheme://host[:port]`).
fn origin_host(origin: &str) -> Option<&str> {
    let after_scheme = origin.split_once("://").map(|(_, rest)| rest).unwrap_or(origin);
    // An origin has no path, but be defensive: cut at the first '/'.
    let host = after_scheme.split('/').next().unwrap_or(after_scheme);
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

/// Decide whether one request may proceed.
///
/// Pure function of the request's method, path and the two headers that matter,
/// so every rule is unit-testable without standing up a server.
///
/// `origin` / `host` are the raw header values (`None` when absent).
pub fn classify(
    method: &Method,
    path: &str,
    origin: Option<&str>,
    host: Option<&str>,
    authorization: Option<&str>,
    auth: &BasicAuth,
) -> Verdict {
    // ── 1. Host header: blocks DNS rebinding ────────────────────────────────
    // A browser always sends Host and cannot be made to omit or forge it. An
    // attacker's domain pointed at 127.0.0.1 still arrives as
    // `Host: attacker.example`, which fails here even if the Origin check were
    // somehow satisfied.
    if let Some(h) = host {
        let h = h.trim();
        if !h.is_empty() && !is_loopback_host(h) && !is_tauri_origin(h) && !h.eq_ignore_ascii_case("tauri.localhost") {
            return Verdict::Forbidden("host not allowed");
        }
    }

    // ── 2. Origin header: blocks drive-by requests from web pages ───────────
    if let Some(o) = origin {
        let o = o.trim();
        if !o.is_empty() {
            // `Origin: null` = file:// page or sandboxed iframe. Both are
            // attacker-creatable, so this is never a trusted context.
            if o.eq_ignore_ascii_case("null") {
                return Verdict::Forbidden("opaque origin");
            }
            if !is_tauri_origin(o) {
                match origin_host(o) {
                    Some(h) if is_loopback_host(h) => {}
                    _ => return Verdict::Forbidden("origin not allowed"),
                }
            }
        }
    }

    // ── 3. CORS preflight must not be blocked by auth ───────────────────────
    // Java's filter returns early on OPTIONS for the same reason: a preflight
    // carries no credentials by design, and 401-ing it makes every real request
    // from an allowed origin fail with an opaque CORS error.
    if *method == Method::OPTIONS {
        return Verdict::Allow;
    }

    // ── 4. Basic Auth ───────────────────────────────────────────────────────
    if !auth.is_enforced() {
        return Verdict::Allow;
    }
    if AUTH_EXEMPT_PATHS.contains(&path) || is_static_asset(path) {
        return Verdict::Allow;
    }
    if check_basic(authorization, auth) {
        Verdict::Allow
    } else {
        // Advertise the challenge so a browser shows its native login prompt —
        // unless the credentials were injected, in which case the client is the
        // desktop shell and a prompt nobody can answer would just hang.
        Verdict::Unauthorized(!auth.injected)
    }
}

/// Constant-time-ish comparison of `Authorization: Basic base64(user:pass)`.
fn check_basic(authorization: Option<&str>, auth: &BasicAuth) -> bool {
    use base64::Engine;
    let Some(header) = authorization else { return false };
    let Some(b64) = header.strip_prefix("Basic ")
        .or_else(|| header.strip_prefix("basic ")) else { return false };

    let decoded = match base64::engine::general_purpose::STANDARD.decode(b64.trim()) {
        Ok(d) => d,
        Err(_) => return false,
    };
    let Ok(text) = String::from_utf8(decoded) else { return false };
    // Split on the FIRST colon only: a password may contain colons. Java uses
    // `split(":", 2)` for the same reason.
    let Some((user, pass)) = text.split_once(':') else { return false };

    // Compare both halves regardless of the first result, so the timing does not
    // reveal which half was wrong.
    let u = subtle_eq(user.as_bytes(), auth.user.as_bytes());
    let p = subtle_eq(pass.as_bytes(), auth.pass.as_bytes());
    u && p
}

/// Length-independent byte comparison. Not a hardened constant-time primitive
/// (that would need a crypto dependency), but it avoids the early-return that
/// `==` on `&str` gives, which is enough to stop trivial timing oracles on a
/// loopback-only endpoint.
fn subtle_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        // Still walk the shorter length so the cost does not instantly reveal
        // "wrong length" versus "wrong bytes".
        let mut acc = 1u8;
        for (x, y) in a.iter().zip(b.iter()) {
            acc |= x ^ y;
        }
        let _ = acc;
        return false;
    }
    let mut acc = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        acc |= x ^ y;
    }
    acc == 0
}

/// Turn a rejection into an HTTP response.
pub fn reject(verdict: &Verdict) -> Response {
    match verdict {
        Verdict::Forbidden(reason) => (
            StatusCode::FORBIDDEN,
            [(axum::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            format!("403 Forbidden: {}", reason),
        )
            .into_response(),
        Verdict::Unauthorized(advertise) => {
            let mut builder = Response::builder().status(StatusCode::UNAUTHORIZED);
            if *advertise {
                builder = builder.header(
                    axum::http::header::WWW_AUTHENTICATE,
                    HeaderValue::from_static("Basic realm=\"GWork\""),
                );
            }
            builder
                .header(axum::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")
                .body(axum::body::Body::from("401 Unauthorized: 需要访问认证"))
                .unwrap_or_else(|_| StatusCode::UNAUTHORIZED.into_response())
        }
        Verdict::Allow => StatusCode::OK.into_response(),
    }
}

/// Narrowed CORS layer.
///
/// Replaces `allow_origin("*")`. The wildcard is what let the attacker *read
/// responses* cross-origin; with it gone, even a request that somehow slipped
/// past the guard cannot exfiltrate what came back.
///
/// `AllowAnyOrigin` with credentials is refused by tower-http, and echoing an
/// arbitrary origin would recreate the original hole, so this is an explicit
/// predicate over the same set [`classify`] trusts.
pub fn cors_layer() -> tower_http::cors::CorsLayer {
    use tower_http::cors::AllowOrigin;
    tower_http::cors::CorsLayer::new()
        // tower-http 0.5 hands the predicate `&RequestParts`, not `&Method`.
        .allow_origin(AllowOrigin::predicate(|origin: &HeaderValue, _parts: &axum::http::request::Parts| {
            origin_allowed(origin)
        }))
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        // `allow_headers` takes header *names*, not values.
        //
        // Every name here must mirror a header the UI can actually put on a
        // cross-origin request: a missing name fails the preflight and the
        // browser reports an opaque CORS error while the kernel never sees the
        // request at all (reproduced 2026-10-29: every jQuery call in the
        // desktop shell died this way). When adding a `setRequestHeader` /
        // `headers:` entry to the frontend, add it here in the same change.
        .allow_headers([
            axum::http::header::CONTENT_TYPE,
            axum::http::header::AUTHORIZATION,
            // The frontend sends this to declare a project-scoped session; it is
            // a custom header, so it must be listed or every such request would
            // need a preflight that the narrowed policy then has to answer.
            axum::http::header::HeaderName::from_static("x-session-cwd"),
            // message-queue.js `_getHeaders` stamps this on queue add/shift/
            // clear/list so the kernel can route the queue per session. Same
            // failure mode as `x-session-cwd`: omitted here, every queued
            // message dies in preflight inside the desktop shell.
            axum::http::header::HeaderName::from_static("x-session-id"),
            // jQuery stamps `X-Requested-With: XMLHttpRequest` on every request
            // it believes is same-origin. The UI issues relative paths, so
            // jQuery sees same-origin and stamps it; kernel-bridge.js then
            // rewrites the URL inside `XHR.open` to the kernel origin, turning
            // the very same request cross-origin *with the header already
            // set*. Without this entry every `$.ajax`/`$.get`/`$.post` call in
            // the desktop shell fails its preflight — which is exactly the
            // "all backend endpoints error after startup" regression this line
            // fixes. The header carries no secret and no routing meaning; the
            // Origin/Host guard remains the security boundary.
            axum::http::header::HeaderName::from_static("x-requested-with"),
        ])
}

/// Whether an `Origin` header value is one this kernel serves.
///
/// Shared by the CORS predicate and the tests, so the two cannot drift: a CORS
/// policy that is looser than [`classify`] would let a page read responses it
/// should never have been able to elicit.
pub fn origin_allowed(origin: &HeaderValue) -> bool {
    let Ok(s) = origin.to_str() else { return false };
    let s = s.trim();
    if s.is_empty() {
        return false;
    }
    if is_tauri_origin(s) {
        return true;
    }
    // `Origin: null` (file:// page, sandboxed iframe) is attacker-creatable.
    if s.eq_ignore_ascii_case("null") {
        return false;
    }
    origin_host(s).map(is_loopback_host).unwrap_or(false)
}

/// Extract the pieces [`classify`] needs from a request.
///
/// Kept separate so the middleware stays a thin adapter and the decision logic
/// remains testable in isolation.
pub fn parts_from(req: &axum::http::request::Parts) -> (Option<String>, Option<String>, Option<String>) {
    let origin = req
        .headers
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let host = req
        .headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let auth = req
        .headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    (origin, host, auth)
}

/// Path of a request, without query string.
pub fn path_of(uri: &Uri) -> &str {
    uri.path()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_auth() -> BasicAuth {
        BasicAuth::default()
    }

    fn auth() -> BasicAuth {
        BasicAuth { user: "admin".into(), pass: "s3cret".into(), injected: false }
    }

    fn injected_auth() -> BasicAuth {
        BasicAuth { user: "admin".into(), pass: "s3cret".into(), injected: true }
    }

    fn basic(user: &str, pass: &str) -> String {
        use base64::Engine;
        format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", user, pass)))
    }

    // ─── The reproduced attack must be blocked ──────────────────────────────

    #[test]
    fn the_reproduced_driveby_rce_request_is_rejected() {
        // Verbatim shape of the request that wrote PWNED-BY-CROSS-ORIGIN to disk
        // on 2026-10-29: cross-origin simple POST, no credentials, no auth configured.
        let v = classify(
            &Method::POST,
            "/web/chat/input",
            Some("https://evil.example.com"),
            Some("127.0.0.1:18972"),
            None,
            &no_auth(),
        );
        assert_eq!(v, Verdict::Forbidden("origin not allowed"));
    }

    #[test]
    fn the_websocket_terminal_shell_is_rejected_from_a_web_page() {
        // /web/terminal spawns an interactive shell. WS handshakes get no CORS
        // preflight, so the Origin check is the only thing standing between a
        // malicious page and a shell on the user's machine.
        let v = classify(
            &Method::GET,
            "/web/terminal",
            Some("https://evil.example.com"),
            Some("127.0.0.1:8080"),
            None,
            &no_auth(),
        );
        assert_eq!(v, Verdict::Forbidden("origin not allowed"));
    }

    #[test]
    fn reading_back_the_transcript_cross_origin_is_rejected() {
        let v = classify(
            &Method::GET,
            "/web/chat/replay",
            Some("https://evil.example.com"),
            Some("127.0.0.1:8080"),
            None,
            &no_auth(),
        );
        assert!(matches!(v, Verdict::Forbidden(_)));
    }

    // ─── Opaque origins ─────────────────────────────────────────────────────

    #[test]
    fn opaque_origin_is_rejected_not_treated_as_absent() {
        // `Origin: null` comes from file:// pages and sandboxed iframes — both
        // trivially attacker-creatable. Treating it as "no origin" would reopen
        // the hole.
        for m in [Method::POST, Method::GET] {
            let v = classify(&m, "/web/chat/input", Some("null"), Some("127.0.0.1:8080"), None, &no_auth());
            assert_eq!(v, Verdict::Forbidden("opaque origin"), "method {:?}", m);
        }
        // Case-insensitive: header values are not normalised by every client.
        assert_eq!(
            classify(&Method::POST, "/web/chat/input", Some("NULL"), Some("127.0.0.1:8080"), None, &no_auth()),
            Verdict::Forbidden("opaque origin")
        );
    }

    // ─── DNS rebinding ──────────────────────────────────────────────────────

    #[test]
    fn dns_rebinding_is_blocked_by_the_host_check() {
        // attacker.example resolves to 127.0.0.1. The browser sends the real
        // Host, so this fails even though the connection lands on loopback.
        let v = classify(
            &Method::POST,
            "/web/chat/input",
            Some("http://attacker.example"),
            Some("attacker.example:8080"),
            None,
            &no_auth(),
        );
        assert_eq!(v, Verdict::Forbidden("host not allowed"));
    }

    #[test]
    fn host_check_runs_even_when_origin_looks_fine() {
        // Belt and braces: a loopback Origin with a foreign Host is still wrong.
        let v = classify(
            &Method::GET,
            "/web/chat/sessions",
            Some("http://127.0.0.1:8080"),
            Some("attacker.example"),
            None,
            &no_auth(),
        );
        assert_eq!(v, Verdict::Forbidden("host not allowed"));
    }

    #[test]
    fn public_ip_host_is_rejected() {
        let v = classify(&Method::GET, "/web/chat/meta", None, Some("93.184.216.34:8080"), None, &no_auth());
        assert_eq!(v, Verdict::Forbidden("host not allowed"));
    }

    // ─── Legitimate clients must keep working ───────────────────────────────

    #[test]
    fn desktop_shell_origin_is_allowed_on_every_platform_form() {
        // The shell's page origin differs from the kernel's, so its requests are
        // genuinely cross-origin. Blocking these white-screens the app.
        for o in ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"] {
            let v = classify(&Method::POST, "/web/chat/input", Some(o), Some("127.0.0.1:51234"), None, &no_auth());
            assert_eq!(v, Verdict::Allow, "origin {}", o);
        }
    }

    #[test]
    fn browser_mode_same_origin_is_allowed() {
        // `gwork --serve 8080 --static ui` → page and kernel share an origin.
        for o in [
            "http://127.0.0.1:8080",
            "http://localhost:8080",
            "http://[::1]:8080",
        ] {
            let v = classify(&Method::POST, "/web/chat/input", Some(o), Some("127.0.0.1:8080"), None, &no_auth());
            assert_eq!(v, Verdict::Allow, "origin {}", o);
        }
    }

    #[test]
    fn loopback_origin_on_a_different_port_is_allowed() {
        // The dev server (vite on :1420) talks to the kernel on another port.
        let v = classify(
            &Method::POST,
            "/web/chat/input",
            Some("http://localhost:1420"),
            Some("127.0.0.1:8080"),
            None,
            &no_auth(),
        );
        assert_eq!(v, Verdict::Allow);
    }

    #[test]
    fn non_browser_clients_send_no_origin_and_are_allowed() {
        // curl, reqwest, the ACP subprocess, the readiness probe.
        for (m, p) in [
            (Method::GET, "/web/chat/meta"),
            (Method::POST, "/web/chat/input"),
            (Method::GET, "/web/terminal"),
        ] {
            let v = classify(&m, p, None, Some("127.0.0.1:8080"), None, &no_auth());
            assert_eq!(v, Verdict::Allow, "{} {}", m, p);
        }
    }

    #[test]
    fn missing_host_header_is_allowed() {
        // HTTP/1.0 clients and raw sockets omit Host. Browsers never do, so
        // allowing this cannot be used by a web page.
        let v = classify(&Method::POST, "/web/chat/input", None, None, None, &no_auth());
        assert_eq!(v, Verdict::Allow);
    }

    // ─── Basic Auth ─────────────────────────────────────────────────────────

    #[test]
    fn auth_off_means_no_credentials_needed() {
        let v = classify(&Method::POST, "/web/chat/input", None, Some("127.0.0.1:8080"), None, &no_auth());
        assert_eq!(v, Verdict::Allow);
    }

    #[test]
    fn auth_on_rejects_missing_and_wrong_credentials() {
        let a = auth();
        for hdr in [None, Some("Basic "), Some("Basic !!!notbase64!!!"), Some("Bearer abc")] {
            let v = classify(&Method::GET, "/web/chat/sessions", None, Some("127.0.0.1:8080"), hdr, &a);
            assert!(matches!(v, Verdict::Unauthorized(_)), "header {:?} → {:?}", hdr, v);
        }
        let v = classify(
            &Method::GET,
            "/web/chat/sessions",
            None,
            Some("127.0.0.1:8080"),
            Some(&basic("admin", "wrong")),
            &a,
        );
        assert!(matches!(v, Verdict::Unauthorized(_)));
        let v = classify(
            &Method::GET,
            "/web/chat/sessions",
            None,
            Some("127.0.0.1:8080"),
            Some(&basic("root", "s3cret")),
            &a,
        );
        assert!(matches!(v, Verdict::Unauthorized(_)));
    }

    #[test]
    fn auth_on_accepts_correct_credentials() {
        let v = classify(
            &Method::GET,
            "/web/chat/sessions",
            None,
            Some("127.0.0.1:8080"),
            Some(&basic("admin", "s3cret")),
            &auth(),
        );
        assert_eq!(v, Verdict::Allow);
    }

    #[test]
    fn password_may_contain_colons() {
        // Split on the first colon only. Java uses split(":", 2); splitting on
        // every colon would truncate the password and lock the user out.
        let a = BasicAuth { user: "admin".into(), pass: "a:b:c".into(), injected: false };
        let v = classify(&Method::GET, "/web/chat/sessions", None, Some("127.0.0.1:8080"), Some(&basic("admin", "a:b:c")), &a);
        assert_eq!(v, Verdict::Allow);
    }

    #[test]
    fn half_configured_credentials_do_not_lock_the_user_out() {
        // A blank either side means "not configured" (Java's Utils.isBlank).
        // Enforcing a half-set pair would make the kernel unreachable with no
        // way to reach the settings page that repairs it.
        for a in [
            BasicAuth { user: "admin".into(), pass: "".into(), injected: false },
            BasicAuth { user: "".into(), pass: "s3cret".into(), injected: false },
            BasicAuth { user: "  ".into(), pass: "s3cret".into(), injected: false },
        ] {
            assert!(!a.is_enforced(), "{:?}", a);
            let v = classify(&Method::GET, "/web/chat/sessions", None, Some("127.0.0.1:8080"), None, &a);
            assert_eq!(v, Verdict::Allow);
        }
    }

    #[test]
    fn injected_credentials_do_not_advertise_a_browser_challenge() {
        // Remote deployment: the client is the desktop shell's proxy. A
        // WWW-Authenticate header would make a browser pop a dialog nobody can
        // answer, hanging the connection instead of surfacing a readable error.
        let v = classify(&Method::GET, "/web/chat/sessions", None, Some("127.0.0.1:8080"), None, &injected_auth());
        assert_eq!(v, Verdict::Unauthorized(false));
        // Settings-configured credentials DO advertise, so a browser user gets
        // the native login prompt.
        let v = classify(&Method::GET, "/web/chat/sessions", None, Some("127.0.0.1:8080"), None, &auth());
        assert_eq!(v, Verdict::Unauthorized(true));
        // Correct credentials pass either way.
        assert_eq!(
            classify(&Method::GET, "/web/chat/sessions", None, Some("127.0.0.1:8080"), Some(&basic("admin", "s3cret")), &injected_auth()),
            Verdict::Allow
        );
    }

    #[test]
    fn from_settings_treats_missing_halves_as_unconfigured() {
        assert!(!BasicAuth::from_settings(None, None).is_enforced());
        assert!(!BasicAuth::from_settings(Some("admin"), None).is_enforced());
        assert!(!BasicAuth::from_settings(None, Some("s3cret")).is_enforced());
        let a = BasicAuth::from_settings(Some("admin"), Some("s3cret"));
        assert!(a.is_enforced());
        assert!(!a.injected, "settings credentials must advertise the browser challenge");
    }

    #[test]
    fn preflight_is_never_blocked_by_auth() {
        // A preflight carries no credentials by design. 401-ing it makes every
        // real request from an allowed origin fail with an opaque CORS error.
        let v = classify(
            &Method::OPTIONS,
            "/web/chat/input",
            Some("http://tauri.localhost"),
            Some("127.0.0.1:8080"),
            None,
            &auth(),
        );
        assert_eq!(v, Verdict::Allow);
    }

    #[test]
    fn preflight_from_a_foreign_origin_is_still_rejected() {
        // OPTIONS skips *auth*, not the origin check — otherwise a malicious
        // page could probe the API surface via preflight responses.
        let v = classify(
            &Method::OPTIONS,
            "/web/chat/input",
            Some("https://evil.example.com"),
            Some("127.0.0.1:8080"),
            None,
            &auth(),
        );
        assert!(matches!(v, Verdict::Forbidden(_)));
    }

    #[tokio::test]
    async fn preflight_allows_every_header_the_ui_can_send() {
        // Regression guard for the 2026-10-29 "every backend endpoint errors
        // after startup" incident. jQuery stamps `X-Requested-With` on every
        // request it believes is same-origin; the UI issues relative paths,
        // kernel-bridge.js rewrites the URL to the kernel origin *inside
        // XHR.open*, so the header is already set by the time the request is
        // cross-origin. The narrowed `allow_headers` list omitted it, so every
        // `$.ajax`/`$.get`/`$.post` in the desktop shell failed its preflight
        // with an opaque CORS error while the kernel never saw the request —
        // curl-based probes could not catch it because curl does not stamp
        // the header.
        //
        // The assertion runs against the *built layer*, not a hand-maintained
        // mirror list: whatever `cors_layer` answers to a real preflight is
        // what the browser will enforce.
        use tower::{Layer, Service, ServiceExt};

        async fn preflight(requested: &str) -> axum::http::Response<axum::body::Body> {
            let req = axum::http::Request::builder()
                .method(Method::OPTIONS)
                .uri("/web/chat/input")
                .header(axum::http::header::ORIGIN, "http://tauri.localhost")
                .header(axum::http::header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                .header(axum::http::header::ACCESS_CONTROL_REQUEST_HEADERS, requested)
                .body(axum::body::Body::empty())
                .unwrap();
            let inner = tower::service_fn(|_req| async {
                Ok::<_, std::convert::Infallible>(axum::http::Response::new(axum::body::Body::empty()))
            });
            let mut svc = cors_layer().layer(inner);
            svc.ready().await.unwrap().call(req).await.unwrap()
        }

        fn allow_headers_of(resp: &axum::http::Response<axum::body::Body>) -> String {
            resp.headers()
                .get(axum::http::header::ACCESS_CONTROL_ALLOW_HEADERS)
                .expect("preflight must answer access-control-allow-headers")
                .to_str()
                .unwrap()
                .to_ascii_lowercase()
        }

        let resp = preflight("content-type,authorization,x-session-cwd,x-session-id,x-requested-with").await;
        assert_eq!(resp.status(), StatusCode::OK);
        let allow = allow_headers_of(&resp);
        for h in ["content-type", "authorization", "x-session-cwd", "x-session-id", "x-requested-with"] {
            assert!(allow.contains(h), "preflight must allow {h}, got: {allow}");
        }

        // The policy must stay a whitelist: a header nobody sends must NOT be
        // answered. Under `AllowHeaders::Any` tower-http echoes the requested
        // name back, so this catches a regression to the old wildcard policy.
        let resp = preflight("x-evil-probe").await;
        let allow = allow_headers_of(&resp);
        assert!(!allow.contains("x-evil-probe"), "policy must stay a whitelist, got: {allow}");
    }

    #[test]
    fn readiness_probe_and_static_assets_skip_auth_but_not_the_origin_check() {
        let a = auth();
        // The desktop shell's wait_for_kernel sends no credentials.
        assert_eq!(
            classify(&Method::GET, "/web/chat/meta", None, Some("127.0.0.1:8080"), None, &a),
            Verdict::Allow
        );
        for p in ["/css/app.css", "/js/app-streaming.js", "/locales/zh-CN.json", "/monaco/editor.main.js", "/favicon.ico", "/layui/layui.js", "/highlight/highlight.min.js", "/img/logo.png"] {
            assert_eq!(
                classify(&Method::GET, p, None, Some("127.0.0.1:8080"), None, &a),
                Verdict::Allow,
                "static {}", p
            );
        }
        // The page itself is NOT exempt: loading it should prompt for login.
        assert!(matches!(
            classify(&Method::GET, "/index.html", None, Some("127.0.0.1:8080"), None, &a),
            Verdict::Unauthorized(true)
        ));
        // And a foreign origin is rejected even on an exempt path.
        assert!(matches!(
            classify(&Method::GET, "/web/chat/meta", Some("https://evil.example.com"), Some("127.0.0.1:8080"), None, &a),
            Verdict::Forbidden(_)
        ));
    }

    #[test]
    fn static_prefix_is_not_a_path_traversal_bypass() {
        // `/web/chat/input` must not become auth-exempt by pretending to be static.
        let a = auth();
        for p in [
            "/css/../web/chat/input",
            "/js/../../web/chat/sessions",
            "/css/./../web/chat/input",
            "/locales/../web/chat/memory/clear",
        ] {
            assert!(
                matches!(classify(&Method::POST, p, None, Some("127.0.0.1:8080"), None, &a), Verdict::Unauthorized(_)),
                "{} must still require auth", p
            );
        }
        // A query string must not smuggle a static prefix into a real endpoint.
        assert!(matches!(
            classify(&Method::POST, "/web/chat/input?x=/css/", None, Some("127.0.0.1:8080"), None, &a),
            Verdict::Unauthorized(_)
        ));
        // Genuine asset paths stay exempt.
        assert!(is_static_asset("/css/app.css"));
        assert!(is_static_asset("/js/app-streaming.js"));
        assert!(!is_static_asset("/css/../web/chat/input"));
        assert!(!is_static_asset("/web/chat/input"));
    }

    // ─── Credential injection parsing ───────────────────────────────────────

    #[test]
    fn injection_parsing_matches_the_java_contract() {
        assert_eq!(
            BasicAuth::from_injection(Some("admin:s3cret")),
            Some(BasicAuth { user: "admin".into(), pass: "s3cret".into(), injected: true })
        );
        // Password may contain colons; user may not.
        assert_eq!(
            BasicAuth::from_injection(Some("admin:a:b:c")),
            Some(BasicAuth { user: "admin".into(), pass: "a:b:c".into(), injected: true })
        );
        // Surrounding whitespace is trimmed (env vars often carry a stray newline).
        assert_eq!(
            BasicAuth::from_injection(Some("  admin:s3cret\n")),
            Some(BasicAuth { user: "admin".into(), pass: "s3cret".into(), injected: true })
        );
        // Malformed → None, i.e. "not configured". Never a credential that
        // rejects everything.
        for bad in [None, Some(""), Some("   "), Some("nocolon"), Some(":pass"), Some("user:"), Some(":")] {
            assert_eq!(BasicAuth::from_injection(bad), None, "input {:?}", bad);
        }
    }

    // ─── CORS layer ─────────────────────────────────────────────────────────

    #[test]
    fn cors_no_longer_answers_wildcard() {
        // The wildcard is what made the attacker's response readable. Asserted
        // through `origin_allowed`, the very predicate the layer is built from,
        // so the test tracks the shipped policy rather than a copy of it.
        let hv = |s: &str| HeaderValue::from_str(s).unwrap();
        assert!(!origin_allowed(&hv("https://evil.example.com")));
        assert!(!origin_allowed(&hv("http://attacker.example")));
        assert!(!origin_allowed(&hv("null")));
        assert!(!origin_allowed(&hv("NULL")));
        assert!(!origin_allowed(&hv("")));
        // Trusted origins.
        assert!(origin_allowed(&hv("http://tauri.localhost")));
        assert!(origin_allowed(&hv("tauri://localhost")));
        assert!(origin_allowed(&hv("http://127.0.0.1:8080")));
        assert!(origin_allowed(&hv("http://localhost:1420")));
        assert!(origin_allowed(&hv("http://[::1]:8080")));
        // A non-ASCII origin cannot be a HeaderValue at all, and `to_str` fails
        // on anything non-visible-ASCII: both must deny, not panic.
        assert!(!origin_allowed(&HeaderValue::from_bytes(b"http://\xff.example").unwrap()));
    }

    #[test]
    fn cors_predicate_and_classify_agree() {
        // The two must not drift. If CORS were looser than the guard, a page
        // could read responses from a request the guard would have blocked;
        // if it were tighter, a legitimate client would get an opaque CORS error
        // instead of a working call.
        let cases = [
            "https://evil.example.com",
            "http://attacker.example",
            "null",
            "http://tauri.localhost",
            "tauri://localhost",
            "http://127.0.0.1:8080",
            "http://localhost:1420",
        ];
        for o in cases {
            let cors_says = origin_allowed(&HeaderValue::from_str(o).unwrap());
            let guard_says = matches!(
                classify(&Method::GET, "/web/chat/meta", Some(o), Some("127.0.0.1:8080"), None, &no_auth()),
                Verdict::Allow
            );
            assert_eq!(cors_says, guard_says, "CORS and guard disagree on origin {:?}", o);
        }
    }

    #[test]
    fn host_parsing_handles_ipv6_and_trailing_dots() {
        // IPv6 loopback must be accepted in every spelling. A regression here
        // breaks browser mode on an IPv6-only loopback, and the failure looks
        // like "the kernel rejects my own UI".
        assert!(is_loopback_host("[::1]:8080"));
        assert!(is_loopback_host("[::1]"));
        assert!(is_loopback_host("::1"));
        assert!(is_loopback_host("127.0.0.1:8080"));
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("localhost."));
        assert!(is_loopback_host("localhost:1420"));
        // Lookalikes must NOT pass: a suffix or substring match here would let an
        // attacker register `127.0.0.1.evil.example` and walk straight in.
        assert!(!is_loopback_host("127.0.0.1.attacker.example"));
        assert!(!is_loopback_host("notlocalhost"));
        assert!(!is_loopback_host("localhost.evil.example"));
        assert!(!is_loopback_host("192.168.1.5"));
        assert!(!is_loopback_host("93.184.216.34:8080"));
        assert!(!is_loopback_host(""));
        // Trailing garbage after the closing bracket must not be ignored: taking
        // only the text before `]` would accept these as loopback.
        assert!(!is_loopback_host("[::1].evil.example"));
        assert!(!is_loopback_host("[::1]:8080.evil.example"));
        assert!(!is_loopback_host("[::1]:x"));
        assert!(!is_loopback_host("[::1]junk"));
        assert!(!is_loopback_host("[::1"));
        assert!(!is_loopback_host("[evil.example]"));
        // A valid bracketed form with a port still passes.
        assert!(is_loopback_host("[::1]:0"));
        assert!(is_loopback_host("[127.0.0.1]:8080"));
    }

    #[test]
    fn ipv6_loopback_origin_is_allowed_end_to_end() {
        // The full decision, not just the helper: `http://[::1]:8080` is what a
        // browser sends when the page was loaded over IPv6 loopback.
        let v = classify(
            &Method::POST,
            "/web/chat/input",
            Some("http://[::1]:8080"),
            Some("[::1]:8080"),
            None,
            &no_auth(),
        );
        assert_eq!(v, Verdict::Allow);
        assert!(origin_allowed(&HeaderValue::from_static("http://[::1]:8080")));
    }

    #[test]
    fn reject_responses_carry_the_right_status_and_challenge() {
        let r = reject(&Verdict::Forbidden("origin not allowed"));
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        assert!(r.headers().get(axum::http::header::WWW_AUTHENTICATE).is_none());

        let r = reject(&Verdict::Unauthorized(true));
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            r.headers().get(axum::http::header::WWW_AUTHENTICATE).unwrap(),
            "Basic realm=\"GWork\""
        );

        // Remote mode: no challenge, because the client is the desktop shell and
        // a browser prompt nobody can answer would just hang the connection.
        let r = reject(&Verdict::Unauthorized(false));
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
        assert!(r.headers().get(axum::http::header::WWW_AUTHENTICATE).is_none());
    }

    #[test]
    fn subtle_eq_agrees_with_str_eq() {
        for (a, b) in [("x", "x"), ("x", "y"), ("", ""), ("abc", "ab"), ("a:b", "a:b")] {
            assert_eq!(
                subtle_eq(a.as_bytes(), b.as_bytes()),
                a == b,
                "subtle_eq({:?}, {:?})", a, b
            );
        }
    }
}
