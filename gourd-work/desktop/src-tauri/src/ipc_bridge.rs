//! ipc_bridge.rs — `window.__GOURD_IPC__` bridge for the Rust-native shell.
//!
//! The frontend was written against the Electron/Java shell and probes this
//! object in 37 places across 9 files. Every call site is guarded with
//! `if (!ipc || typeof ipc.X !== 'function')`, so **omitting a method is safe and
//! degrades gracefully**, while inventing one that returns a fake success is not.
//! That is the rule this module follows:
//!
//! | Implemented here | Why |
//! |---|---|
//! | `isDesktop`, `getBackendState`, `getBackendDetail` | boot gate; without them every startup request waits out the 65 s fallback |
//! | `onBackendReady` / `onBackendFailed` / `onInstallMismatch` | event channels the boot gate subscribes to |
//! | `setWindowTitle`, `pickDirectory`, `pickFile`, `getAppVersion` | backed by real Tauri APIs |
//!
//! | `remote*` (9 methods + 3 event channels) | the remote-control channel subsystem
//!   (`src/remote/`) ported from the old shell: SSH/WSL sessions, versioned deploy
//!   roots, tunnels, and the in-memory model mirror. See `remote/mod.rs`. |
//! | `updater*` (5 methods + event) | auto-update via `src/updater.rs`: reads the
//!   admin-uploaded, unauthenticated `latest.json`. Exposing these activates the
//!   already-written About/badge state machine instead of its "unsupported" fallback. |
//!
//! | Deliberately **absent** | Why |
//! |---|---|
//! | `restartBackend` | the kernel is in-process, there is no subprocess to restart; the UI then shows "this version does not support in-app retry" instead of pretending |
//!
//! Also injected here, because the frontend's desktop-only CSS keys off them:
//!   - `body.is-electron` — activates `.titlebar-drag-region` (app.css) and the
//!     titlebar action buttons' right offset (app-titlebar-actions.js). The class
//!     name is kept for compatibility even though this is Tauri, not Electron.
//!   - `body.is-mac` — macOS traffic-light insets.
//!
//! ES5 only: this runs at document-start, before any other script, and the rest
//! of the frontend is ES5.

use serde_json::Value;
use tauri::{AppHandle, Manager};
use tracing::debug;

/// Main window label.
pub const MAIN_WINDOW_LABEL: &str = "main";

/// Default window title.
///
/// Single source of truth for the three places that need it: the window builder
/// (`lib.rs`), the `set_window_title` fallback (`commands.rs`), and the tray
/// tooltip (`tray.rs`). They were previously three separate `"GWork"` literals —
/// renaming the product would have left the tray tooltip behind, which is exactly
/// the kind of drift that only shows up in a screenshot months later.
pub const MAIN_WINDOW_TITLE: &str = "GWork";

/// Platform tag matching Electron's `process.platform` (`win32`/`darwin`/`linux`),
/// which is what the frontend's platform checks expect.
pub fn platform_tag() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "win32"
    }
    #[cfg(target_os = "macos")]
    {
        "darwin"
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        "linux"
    }
}

/// Push an event to the page (equivalent of Electron's `webContents.send`).
///
/// Calls `__GOURD_BRIDGE_EMIT__` via `eval`. Failing is acceptable: the bridge
/// keeps a last-payload replay for late subscribers, and the frontend also polls
/// `getBackendState()` to cover the cold-start race.
pub fn emit<P: serde::Serialize + ?Sized>(app: &AppHandle, event: &str, payload: &P) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        debug!("[ipc-bridge] main window missing, skipping event: {}", event);
        return;
    };
    // serde_json's string output is itself a valid JS literal, safe to embed.
    let name_lit = Value::String(event.to_string()).to_string();
    let payload_lit = match serde_json::to_string(payload) {
        Ok(s) => s,
        Err(e) => {
            debug!("[ipc-bridge] payload serialization failed {}: {}", event, e);
            return;
        }
    };
    let script = format!(
        "if(window.__GOURD_BRIDGE_EMIT__){{window.__GOURD_BRIDGE_EMIT__({},{});}}",
        name_lit, payload_lit
    );
    if let Err(e) = window.eval(&script) {
        debug!("[ipc-bridge] event dispatch failed {}: {}", event, e);
    }
}

/// Build the injected initialization script.
///
/// `kernel_origin` is the in-process kernel's absolute origin
/// (`http://127.0.0.1:<port>`); see `kernel_bridge` for why the page needs it.
pub fn init_script(kernel_origin: &str) -> String {
    BRIDGE_JS
        .replace("__GOURD_PLATFORM__", platform_tag())
        .replace("__GOURD_WINDOW_LABEL__", MAIN_WINDOW_LABEL)
        .replace("__GOURD_KERNEL_ORIGIN__", kernel_origin)
}

/// Bridge JS source.
const BRIDGE_JS: &str = r#"
(function () {
  'use strict';
  if (window.__GOURD_IPC__) return;

  var PLATFORM = '__GOURD_PLATFORM__';
  var WINDOW_LABEL = '__GOURD_WINDOW_LABEL__';

  /* ───────── Basic IPC ───────── */

  function invoke(cmd, args) {
    var it = window.__TAURI_INTERNALS__;
    if (!it || typeof it.invoke !== 'function') {
      return Promise.reject(new Error('Tauri IPC not ready: ' + cmd));
    }
    try {
      return Promise.resolve(it.invoke(cmd, args || {}));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /* Fire-and-forget: swallow errors so a failed window call never breaks a
     business flow (e.g. a title update must not abort a project switch). */
  function send(cmd, args) {
    invoke(cmd, args)['catch'](function (e) {
      console.warn('[gourd-ipc] ' + cmd + ' failed', e);
    });
  }

  /* ───────── Event dispatch ─────────
     Rust calls __GOURD_BRIDGE_EMIT__ through webview.eval.
     last-payload replay: when a listener registers after the event already
     arrived (cold-start race), fire it once immediately. */

  var listeners = {};
  var lastPayload = {};
  var REPLAY = { 'backend-ready': 1, 'backend-failed': 1, 'window-chrome': 1,
                 'updater-state': 1 };

  function on(name, cb) {
    if (typeof cb !== 'function') return;
    if (!listeners[name]) listeners[name] = [];
    listeners[name].push(cb);
    if (REPLAY[name] && Object.prototype.hasOwnProperty.call(lastPayload, name)) {
      var p = lastPayload[name];
      setTimeout(function () {
        try { cb(p); } catch (e) { console.error('[gourd-ipc] replay error ' + name, e); }
      }, 0);
    }
  }

  window.__GOURD_BRIDGE_EMIT__ = function (name, payload) {
    lastPayload[name] = payload;

    /* Window chrome state goes straight to the custom titlebar layer via its own
       channel, so a business listener cannot accidentally swallow it. */
    if (name === 'window-chrome' && window.__GOURD_TITLEBAR__) {
      try { window.__GOURD_TITLEBAR__.apply(payload); }
      catch (e) { console.error('[gourd-ipc] titlebar sync error', e); }
    }

    var arr = listeners[name];
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) {
      try { arr[i](payload); } catch (e) {
        console.error('[gourd-ipc] listener error ' + name, e);
      }
    }
  };

  /* ───────── Public contract ─────────
     Only methods this kernel can actually honour are exposed. Everything else is
     left undefined on purpose: every call site checks `typeof ipc.X === 'function'`
     and degrades, whereas a stub returning a fake success would make the UI claim
     an action worked when nothing happened. */

  window.__GOURD_IPC__ = {
    isDesktop: true,
    platform: PLATFORM,

    onBackendReady: function (cb) { on('backend-ready', cb); },
    onBackendFailed: function (cb) { on('backend-failed', cb); },
    onInstallMismatch: function (cb) { on('install-mismatch', cb); },

    /* The kernel runs in-process and is started before the window is created, so
       by the time this script executes it is either up or the app is not running
       at all. Returning 'ready' releases the boot gate immediately; returning
       anything else would make every startup request wait out the 65 s fallback. */
    getBackendState: function () { return Promise.resolve('ready'); },
    getBackendDetail: function () {
      return Promise.resolve({
        running: true,
        embedded: true,
        lastError: null,
        logPath: null
      });
    },

    setWindowTitle: function (title) {
      send('set_window_title', { title: String(title || '') });
    },

    /* Native folder picker. The desktop must use this: the web fallback
       (webkitdirectory) shows a "upload N files to this site?" confirmation bar,
       which is unacceptable in an installed app. */
    pickDirectory: function () { return invoke('pick_directory'); },
    /* Native file picker (private-key browse etc.). A file is not a directory,
        so this cannot reuse pickDirectory. */
    pickFile: function () { return invoke('pick_file'); },

    /* ───────── Remote-control channel ─────────
       Ported verbatim from the old shell's bridge so app-remote.js /
       app-workspace.js / app-code.js need zero changes. A connection may take
       tens of seconds (first deploy uploads the runtime), so progress arrives
       through the remote-connect-progress event: register onRemoteProgress
       BEFORE calling remoteConnect.
       channel: "ssh" (default) | "wsl" (Windows hosts only) | "preinstalled". */
    remoteConnect: function (cfg) {
      return invoke('remote_connect', {
        channel: (cfg && cfg.channel) ? String(cfg.channel) : null,
        host: String(cfg && cfg.host || ''),
        port: cfg && cfg.port ? Number(cfg.port) : null,
        user: String(cfg && cfg.user || ''),
        authType: String(cfg && cfg.authType || 'password'),
        password: (cfg && cfg.password) ? String(cfg.password) : null,
        keyPath: (cfg && cfg.keyPath) ? String(cfg.keyPath) : null,
        passphrase: (cfg && cfg.passphrase) ? String(cfg.passphrase) : null,
        rememberSecret: !!(cfg && cfg.rememberSecret),
        jumpHost: (cfg && cfg.jumpHost) ? String(cfg.jumpHost) : null,
        jumpPort: (cfg && cfg.jumpPort) ? Number(cfg.jumpPort) : null,
        jumpUser: (cfg && cfg.jumpUser) ? String(cfg.jumpUser) : null,
        jumpPassword: (cfg && cfg.jumpPassword) ? String(cfg.jumpPassword) : null,
        jumpKeyPath: (cfg && cfg.jumpKeyPath) ? String(cfg.jumpKeyPath) : null,
        jumpPassphrase: (cfg && cfg.jumpPassphrase) ? String(cfg.jumpPassphrase) : null
        /* 【已删除 runtimePkgPath】它曾是「离线运行时包」：无 Java 的气隙远端优先
           上传该 tar.gz 补 JRE（解析链 L3b）。内核改为 musl 静态二进制后远端零
           依赖，该链整体删除；保留这个参数会让 Tauri command 签名与前端对不上。 */
      });
    },
    remoteDisconnect: function (connectionId, releaseAll) {
      return invoke('remote_disconnect', {
        connectionId: String(connectionId || ''),
        releaseAll: releaseAll === true
      });
    },
    remoteState: function (connectionId) {
      return invoke('remote_state', { connectionId: String(connectionId || '') });
    },
    /* Enumerate every live connection. Element shape = remoteState minus
       authHeader (the enumeration surface is deliberately credential-free: it
       feeds badges / the grouping tree / fan-out fetches). The startup-restore
       chain crosses this against the ids persisted in localStorage. Errors and
       non-arrays both degrade to []: an empty list means "no live connections"
       and must never break startup. */
    remoteList: function () {
      return invoke('remote_list').then(function (v) {
        return Array.isArray(v) ? v : [];
      }, function () {
        return [];
      });
    },
    /* WSL distro list (Windows hosts only; empty when WSL is absent, which makes
       the frontend hide the WSL channel). */
    remoteWslList: function () {
      return invoke('remote_wsl_list').then(function (v) {
        return Array.isArray(v) ? v : [];
      }, function () {
        return [];
      });
    },
    /* Manually re-push the model mirror (in-memory on the remote; no reconnect
       needed after a local config change). Returns { connectionId, synced, lines };
       progress lines also flow through remote-connect-progress. */
    remoteMirrorSync: function (connectionId) {
      return invoke('remote_mirror_sync', { connectionId: String(connectionId || '') });
    },
    /* Reconnect reusing the previous parameters. Backoff is driven by this layer
       (see app-remote.js), never by Rust. connectionId is optional: pass it to
       reconnect a specific connection (so concurrent sessions cannot reconnect
       the wrong target), omit it for "the most recent one". */
    remoteReconnect: function (connectionId) {
      return invoke('remote_reconnect', {
        connectionId: (connectionId === undefined || connectionId === null || connectionId === '')
          ? null
          : String(connectionId)
      });
    },
    /* "Forget this host" after a fingerprint rejection: clears every host-key
       record for host:port and returns { removed }. Used once the server's key
       change is confirmed (reinstall etc.); the next connect then goes through
       the first-connect trust flow again. */
    remoteForgetHost: function (host, port) {
      return invoke('remote_forget_host', {
        host: String(host || ''),
        port: (port === undefined || port === null || port === '') ? null : Number(port)
      });
    },
    /* Per-workspace routing: declare which environment a workspace belongs to
       when it is selected. Bind to whatever backend the cwd came from — during
       a remote session a LOCAL directory must pass null (otherwise it gets bound
       to the remote = cross-machine reads/writes), and a REMOTE directory must
       pass that connection's id (otherwise it falls back to local, which has no
       such path). */
    remoteBindScope: function (cwd, connectionId) {
      return invoke('remote_bind_scope', {
        cwd: String(cwd || ''),
        connectionId: connectionId ? String(connectionId) : null
      });
    },
    onRemoteProgress: function (cb) { on('remote-connect-progress', cb); },
    onRemoteState: function (cb) { on('remote-connection-state', cb); },
    /* Mirror progress / terminal state, on its own channel: the push happens
       after the wizard has closed, when remote-connect-progress no longer has a
       consumer, so a degradation would otherwise be invisible. */
    onRemoteMirror: function (cb) { on('remote-mirror-state', cb); },
  
    getAppVersion: function () { return invoke('get_app_version'); },

    /* ───────── Auto-update ─────────
       清单由 admin 后台「上传更新检测文件」提供，公开免登录；Rust 侧
       updater.rs 负责检查/下载/安装并广播 updater-state 事件。前端
       app-settings-about.js 与 app-update-badge.js 早已写好完整状态机，
       这五个方法一暴露，「检查更新」卡片与侧栏更新按钮就自动激活
       （hasUpdaterBridge() 要求 updaterGetState + updaterCheck 同时存在）。 */
    updaterGetVersion: function () { return invoke('updater_get_version'); },
    updaterGetState: function () { return invoke('updater_get_state'); },
    updaterCheck: function () { return invoke('updater_check'); },
    updaterDownload: function () { return invoke('updater_download'); },
    updaterInstall: function () { return invoke('updater_install'); },
    onUpdaterState: function (cb) { on('updater-state', cb); },

    /* ───────── Account / login session ─────────
       桌面端不退出就一直保持登录：Rust 侧负责 refresh 与 keyring 持久化，
       这里只是把 6 个 command 暴露给 app-account.js。密码只在 invoke 参数里
       短暂出现，绝不落 localStorage / settings.json。 */
    authStatus: function () { return invoke('auth_status'); },
    authLogin: function (username, password) {
      return invoke('auth_login', { username: String(username || ''), password: String(password || '') });
    },
    authRegister: function (username, password, email, verificationCode) {
      return invoke('auth_register', {
        username: String(username || ''),
        password: String(password || ''),
        email: String(email || ''),
        verificationCode: String(verificationCode || '')
      });
    },
    authSendCode: function (email) {
      return invoke('auth_send_code', { email: String(email || '') });
    },
    authConfig: function () { return invoke('auth_config'); },
    authLogout: function () { return invoke('auth_logout'); },
    authRefresh: function () { return invoke('auth_refresh'); },
    authSelf: function () { return invoke('auth_self'); }
  };

  /* ───────── Drag region ─────────
     With decorations off, dragging the window is our job. The frontend already
     renders `.titlebar-drag-region` (36px, activated by body.is-electron); this
     wires mouse events on it to the Tauri window APIs. */

  function dragSelectors() {
    return ['.titlebar-drag-region'];
  }

  function closestMatch(el, sel) {
    var node = el;
    while (node && node !== document) {
      try {
        if (node.matches && node.matches(sel)) return true;
      } catch (e) { return false; }
      node = node.parentNode;
    }
    return false;
  }

  function isDragTarget(el) {
    if (!el || el.nodeType !== 1) return false;
    /* Never hijack interactive controls that happen to sit in the drag strip. */
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'a') {
      return false;
    }
    /* [role="button"] 与 Java 壳 NO_DRAG_SELECTOR 同口径（gourd-ai-tauri ipc_bridge.rs）：
       拖拽条内的可点击展示件（如标题栏当前任务名 chip）用通用 role 表达交互性，
       不枚举业务类名——枚举类名的历史教训见 gourd-ai-desktop/main/preload.js。 */
    if (el.closest && el.closest('button, input, select, textarea, a, .titlebar-actions, [role="button"]')) {
      return false;
    }
    var sels = dragSelectors();
    for (var i = 0; i < sels.length; i++) {
      if (closestMatch(el, sels[i])) return true;
    }
    return false;
  }

  function installDragRegion() {
    /* No text selection in the drag strip, matching native titlebar feel. */
    var style = document.createElement('style');
    var sels = dragSelectors();
    var rules = [];
    for (var i = 0; i < sels.length; i++) {
      rules.push('body.is-electron ' + sels[i] + '{-webkit-user-select:none;user-select:none;cursor:default;}');
    }
    style.textContent = rules.join('\n');
    document.head.appendChild(style);

    document.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      if (!isDragTarget(e.target)) return;
      e.preventDefault();
      if (e.detail === 2) {
        send('window_toggle_maximize');
      } else {
        send('plugin:window|start_dragging', { label: WINDOW_LABEL });
      }
    }, true);
  }

  /* ───────── Init ───────── */

  function onReady() {
    /* Reuse the web build's existing desktop-only styles (css/app.css and
       css/code.css both key off these class names), hence `is-electron` rather
       than a new name — renaming would silently disable all of them. */
    document.body.classList.add('is-electron');
    if (PLATFORM === 'darwin') document.body.classList.add('is-mac');

    installDragRegion();
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
})();
"#;
