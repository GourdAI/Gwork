//! external_link.rs — hand `target="_blank"` / `window.open` / external navigation
//! to the system browser.
//!
//! # Why this module has to exist
//!
//! wry 0.53 ("Disable new window creation by default on Windows to match behavior
//! of other platforms. Use `WebViewBuilder::with_new_window_req_handler` to
//! enable.") made the no-handler case a silent no-op: WebView2 receives
//! `NewWindowRequested`, finds no handler, calls `args.SetHandled(true)` and
//! nothing further happens. We ship wry 0.57.1, so **every `target="_blank"`
//! anchor in the UI is a dead link until a handler is installed** — no new
//! window, no navigation, no error, no console message.
//!
//! The old Tauri shell (`gourd-ai-tauri/src-tauri/src/window.rs`) did install
//! both handlers. Porting the kernel to Rust dropped them, which silently broke
//! all 31 `target="_blank"` sites in `ui/` (`app-settings-about.js`,
//! `app-channel-config.js`, `chat.html`, …).
//!
//! # Deliberate divergence from the old shell
//!
//! The old `is_internal_url` matched the loopback port against a cached UI port,
//! because that shell served the UI over local HTTP and had a *second* local
//! service (the JVM backend) whose debug pages it wanted to keep out of the
//! webview. This shell is different: the UI is `frontendDist` served from the
//! `tauri.localhost` custom protocol, and the only other local service is our
//! own kernel on a random port. So we allow loopback wholesale rather than
//! pinning a port — over-blocking loopback would push our own pages into the
//! system browser, which is worse than the threat the port pin defended against.
//!
//! # Popup policy: never spawn a second app window
//!
//! `on_new_window` (lib.rs) always denies. Allowing would let WebView2 create
//! a brand-new top-level window running this same UI, and because the kernel
//! serves the whole app on a loopback port, any popup whose URL resolves to
//! loopback — an OAuth redirect echo, a vendor CLI login page at
//! `http://localhost:<port>`, a stray relative link — clones the entire app.
//! Each clone re-runs the same boot code, so one such popup on the connector
//! page cascaded into an unbounded pile of windows (2026-11 field report).
//! Deny + focus-main-window for [`is_app_own_url`], deny + system browser for
//! everything else http(s), deny + drop for the rest.
//!
//! Opening goes through `tauri-plugin-shell` (already registered in `lib.rs`,
//! `shell:allow-open` already granted) instead of the old shell's hand-rolled
//! `rundll32` call. Same reasoning as the old `updater.rs`, which also used
//! `shell().open()`.

use tauri::{AppHandle, Url};
use tracing::{info, warn};

/// Is this URL one of our own pages?
///
/// Returning `true` from the navigation handler lets the webview navigate
/// normally; `false` cancels it and we hand the URL to the system browser.
/// Getting this wrong in the strict direction is severe: the very first load of
/// `index.html` arrives here as `tauri://localhost` (macOS/Linux) or
/// `http://tauri.localhost/` (Windows), so misjudging those would leave a blank
/// window with the app's own HTML opened in Chrome.
pub fn is_internal_url(url: &Url) -> bool {
    match url.scheme() {
        // Tauri's own protocols. `tauri`/`asset` serve frontendDist and asset
        // files; `ipc` is the command channel.
        "tauri" | "asset" | "ipc" => true,
        "http" | "https" => {
            let host = url.host_str().unwrap_or_default();
            // `tauri.localhost` is the Windows frontendDist origin (see
            // capabilities/default.json, which scopes the main window to it).
            // Subdomain form `*.tauri.localhost` is matched too because Tauri
            // uses per-webview subdomains on some configurations.
            host == "tauri.localhost"
                || host.ends_with(".tauri.localhost")
                // Our own kernel (random port) and the dev server on 1420.
                // Port-agnostic on purpose, see the module doc.
                || host == "localhost"
                || host == "127.0.0.1"
                || host == "::1"
                || host == "[::1]"
        }
        // In-page navigations: `about:blank` from a form/anchor, `data:`/`blob:`
        // from generated previews (the code preview and image lightbox both use
        // blob URLs). None of these should ever reach the system browser.
        "about" | "data" | "blob" => true,
        _ => false,
    }
}

/// Is this URL one of our own pages, i.e. would loading it in a window show
/// the app UI itself?
///
/// This is the predicate `on_new_window` uses to decide what a page-requested
/// popup (`window.open` / `target="_blank"`) meant. It is deliberately
/// narrower than [`is_internal_url`]: `about:` / `data:` / `blob:` are
/// internal for *navigation* purposes but can never be "the app", so they are
/// excluded here and handed to the system-browser path (which refuses
/// anything that is not http(s), see [`is_external_openable`]).
pub fn is_app_own_url(url: &Url) -> bool {
    match url.scheme() {
        // Tauri's own protocols serve frontendDist; a popup to them is the app.
        "tauri" | "asset" | "ipc" => true,
        "http" | "https" => {
            let host = url.host_str().unwrap_or_default();
            host == "tauri.localhost"
                || host.ends_with(".tauri.localhost")
                // The in-process kernel serves the same UI on a random
                // loopback port (and the dev server on 1420); a popup to any
                // of them is another copy of the app, not a web page.
                || host == "localhost"
                || host == "127.0.0.1"
                || host == "::1"
                || host == "[::1]"
        }
        _ => false,
    }
}

/// May this URL be handed to the OS?
///
/// Only `http(s)`. This guard is load-bearing rather than defensive: anything
/// `is_internal_url` does not recognise — including `file:` — is cancelled and
/// then arrives here. The system opener is not a browser; on Windows it resolves
/// the file association, so a `file:` URL would launch the default handler for
/// that extension (`.xlsx` → Excel, `.exe` → run it).
///
/// That path is reachable by accident, not just by attack: dropping a file
/// outside a drop zone makes the webview navigate to `file://` by default. The
/// UI has a `document`-level `preventDefault` guard for dragged files
/// (`app-ui.js`), but defence in depth belongs here, where the process is
/// actually spawned.
pub fn is_external_openable(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

/// Open an external URL in the system browser, if the scheme guard allows it.
pub fn open_external(app: &AppHandle, url: &Url) {
    if !is_external_openable(url) {
        warn!(
            "[external-link] refusing to hand a non-http(s) URL to the OS: {}",
            url
        );
        return;
    }
    info!("[external-link] opening in system browser: {}", url);
    if let Err(e) = tauri_plugin_shell::ShellExt::shell(app).open(url.as_str(), None) {
        warn!("[external-link] failed to open {}: {}", url, e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).expect("test URL must parse")
    }

    /* The app's own first paint. If any of these were judged external, the
    window would come up blank and the UI would open in Chrome instead. */
    #[test]
    fn the_apps_own_entry_points_are_internal() {
        for s in [
            "tauri://localhost",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/code.html",
            "asset://localhost/x.png",
        ] {
            assert!(is_internal_url(&u(s)), "must be internal: {}", s);
        }
    }

    /* `on_new_window` must never spawn a second app window: every URL that
    would render the app UI itself is "our own", while in-page schemes that
    are merely internal for navigation are not (they carry no app). */
    #[test]
    fn app_own_urls_are_exactly_the_ui_origins() {
        for s in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "http://localhost/",
            "http://localhost:5055/GWork",
            "http://127.0.0.1:49713/index.html",
            "http://[::1]:1420/",
        ] {
            assert!(is_app_own_url(&u(s)), "must be our own UI: {}", s);
        }
        for s in [
            "https://www.gourdwork.com/",
            "https://login.example/oauth",
            "about:blank",
            "data:text/html,<p>x",
            "blob:abc123",
            "file:///C:/x.html",
        ] {
            assert!(!is_app_own_url(&u(s)), "must NOT be our own UI: {}", s);
        }
    }

    /* The kernel binds a random port, so the verdict must not depend on the
    port number. A port-pinned check would send our own pages to the browser
    on every run where the port differed. */
    #[test]
    fn our_own_kernel_is_internal_on_any_port() {
        for s in [
            "http://127.0.0.1:1420/",      // dev server
            "http://127.0.0.1:49713/chat", // kernel, random port
            "http://localhost:8080/",
            "http://[::1]:5173/",
        ] {
            assert!(is_internal_url(&u(s)), "must be internal: {}", s);
        }
    }

    #[test]
    fn in_page_schemes_never_reach_the_browser() {
        for s in ["about:blank", "data:text/html,<p>x", "blob:abc123"] {
            assert!(is_internal_url(&u(s)), "must be internal: {}", s);
        }
    }

    /* The reason this module exists: these are the links that silently did
    nothing. `www.gourdwork.com` is the about page's download entry. */
    #[test]
    fn real_external_links_are_external() {
        for s in [
            "https://www.gourdwork.com/",
            "https://gourdwork.com/downloads",
            "https://github.com/tauri-apps/tauri",
            "http://example.com/",
        ] {
            assert!(!is_internal_url(&u(s)), "must be external: {}", s);
        }
    }

    /* Host suffix matching must not be a substring test: an attacker-controlled
    `tauri.localhost.evil.com` would otherwise load inside the app, inheriting
    the main window's capability grants. */
    #[test]
    fn lookalike_hosts_do_not_pass_as_internal() {
        for s in [
            "https://tauri.localhost.evil.com/",
            "https://nottauri.localhost.evil.com/",
            "https://127.0.0.1.evil.com/",
            "https://localhost.evil.com/",
            "https://evil.com/?q=tauri.localhost",
        ] {
            assert!(!is_internal_url(&u(s)), "must be external: {}", s);
        }
    }

    /* The scheme guard is what keeps a cancelled `file://` navigation from
    launching the file's associated program. */
    #[test]
    fn only_http_schemes_may_be_handed_to_the_os() {
        for s in ["https://www.gourdwork.com/", "http://example.com/"] {
            assert!(is_external_openable(&u(s)), "should be openable: {}", s);
        }
        for s in [
            "file:///C:/Windows/System32/calc.exe",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "vbscript:msgbox(1)",
            "ms-msdt:/id",
            "search-ms:query=x",
            "smb://host/share",
            "mailto:a@b.c",
            "tel:+100",
        ] {
            assert!(!is_external_openable(&u(s)), "must be refused: {}", s);
        }
    }

    /* Anything cancelled as "not internal" lands in `open_external`, so the two
    predicates compose into the actual security property: a scheme that is
    neither internal nor http(s) must be dropped, never spawned. `file:` is the
    case that actually occurs (dropping a file outside a drop zone). */
    #[test]
    fn non_internal_non_http_schemes_are_dropped_not_spawned() {
        for s in [
            "file:///C:/Users/x/secrets.xlsx",
            "javascript:fetch('//evil')",
            "ms-msdt:/id PCWDiagnostic",
        ] {
            let parsed = u(s);
            assert!(!is_internal_url(&parsed), "would not be cancelled: {}", s);
            assert!(
                !is_external_openable(&parsed),
                "cancelled but then spawned: {}",
                s
            );
        }
    }
}
