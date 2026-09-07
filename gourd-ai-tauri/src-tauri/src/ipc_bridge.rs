//! ipc_bridge.rs —— `window.__GOURD_IPC__` 桥接层。
//!
//! 对齐 Electron 版 `main/preload.js` 的全部对外契约。前端（
//! `gourd-ai-agent/src/main/resources/static/js/`）共 5 个文件 26 处依赖
//! `window.__GOURD_IPC__`，且全部做了 `if (!ipc)` 防御以兼容浏览器直连模式——
//! 因此只要这里注入同名同形的对象，**前端业务代码可零修改**。
//!
//! ## 与 Electron 的三处实现差异
//!
//! 1. **JS → Rust**：Electron 用 `ipcRenderer.invoke/send`；这里用
//!    `window.__TAURI_INTERNALS__.invoke(cmd, args)`。
//!    注意页面由本地 HTTP 服务器提供（`http://localhost:{port}`），对 Tauri 而言
//!    属**远程源**，必须在 `capabilities/default.json` 中经 `remote.urls` 授权，
//!    并在 `build.rs` 的 `AppManifest::commands` 登记命令，否则被 ACL 静默拒绝。
//!
//! 2. **Rust → JS**：不走 Tauri 事件系统，改用 `webview.eval()` 直接调用
//!    `window.__GOURD_BRIDGE_EMIT__(name, payload)`。
//!    这样避免了远程源下 `core:event` 的额外授权与序列化开销，也让「事件重放」
//!    （见下）实现得更直接。
//!
//! 3. **窗口拖拽**：Electron 依赖 Chromium 私有的 `-webkit-app-region: drag`；
//!    **WebView2 / WKWebView 均不支持该属性**。这里改为监听 mousedown，命中拖拽区
//!    时调用 `plugin:window|start_dragging`（双击则 `toggle_maximize`），
//!    选择器与 preload.js 保持一致：一律用通用元素选择器做 no-drag 白名单，
//!    绝不枚举业务类名（preload.js 注释记录过枚举类名导致 mac 全部按钮失效的事故）。

use serde_json::Value;
use tauri::{AppHandle, Manager};
use tracing::debug;

/// 当前平台标识，与 Electron 的 `process.platform` 取值保持一致
/// （`win32` / `darwin` / `linux`），前端 `electronAPI.platform` 依赖此格式。
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

/// 向前端推送事件（等价 Electron 的 `webContents.send`）。
///
/// 通过 `eval` 调用注入脚本里的 `__GOURD_BRIDGE_EMIT__`。若窗口尚未创建或页面
/// 尚未加载，调用会失败——这是可接受的：桥接层内部保留了 last-payload 重放，
/// 且前端 `app-bootstrap.js` 会主动 `getBackendState()` 兜底竞态。
///
/// 泛型于 `Serialize`：调用方既可传 `serde_json::json!({...})`（backend.rs），
/// 也可直接传业务结构体（updater.rs 的 `StateSnapshot`），无需先手工转 `Value`。
pub fn emit<P: serde::Serialize + ?Sized>(app: &AppHandle, event: &str, payload: &P) {
    let Some(window) = app.get_webview_window(crate::window::MAIN_WINDOW_LABEL) else {
        debug!("[ipc-bridge] 主窗口不存在，跳过事件: {}", event);
        return;
    };
    // serde_json 的字符串输出本身就是合法 JS 字面量，可安全嵌入 eval
    let name_lit = Value::String(event.to_string()).to_string();
    let payload_lit = match serde_json::to_string(payload) {
        Ok(s) => s,
        Err(e) => {
            debug!("[ipc-bridge] 事件负载序列化失败 {}: {}", event, e);
            return;
        }
    };
    let script = format!(
        "if(window.__GOURD_BRIDGE_EMIT__){{window.__GOURD_BRIDGE_EMIT__({},{});}}",
        name_lit, payload_lit
    );
    if let Err(e) = window.eval(&script) {
        debug!("[ipc-bridge] 事件下发失败 {}: {}", event, e);
    }
}

/// 生成注入到页面的初始化脚本（document-start 时机执行）。
pub fn init_script() -> String {
    BRIDGE_JS
        .replace("__GOURD_PLATFORM__", platform_tag())
        .replace("__GOURD_WINDOW_LABEL__", crate::window::MAIN_WINDOW_LABEL)
}

/// 桥接层 JS 源码。
///
/// 保持 ES5 语法：前端其余脚本均为 ES5，且该脚本在 document-start 注入，
/// 需要在最老的 WebView 内核上也能解析。
const BRIDGE_JS: &str = r#"
(function () {
  'use strict';
  if (window.__GOURD_IPC__) return;

  var PLATFORM = '__GOURD_PLATFORM__';
  var WINDOW_LABEL = '__GOURD_WINDOW_LABEL__';

  /* ───────── 基础 IPC ───────── */

  function invoke(cmd, args) {
    var it = window.__TAURI_INTERNALS__;
    if (!it || typeof it.invoke !== 'function') {
      return Promise.reject(new Error('Tauri IPC 未就绪: ' + cmd));
    }
    try {
      return Promise.resolve(it.invoke(cmd, args || {}));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /* 单向调用（等价 ipcRenderer.send）：吞掉异常，不打断业务流 */
  function send(cmd, args) {
    invoke(cmd, args)['catch'](function (e) {
      console.warn('[gourd-ipc] ' + cmd + ' 调用失败', e);
    });
  }

  /* ───────── 事件分发 ─────────
     Rust 侧经 webview.eval 调用 __GOURD_BRIDGE_EMIT__。
     保留 last-payload：监听器注册晚于事件到达时（冷启动竞态）自动补发一次，
     语义与 Electron 版 + app-bootstrap.js 的 getBackendState() 兜底一致。 */

  var listeners = {};
  var lastPayload = {};
  var REPLAY = { 'backend-ready': 1, 'backend-failed': 1, 'updater-state': 1, 'install-mismatch': 1 };

  function on(name, cb) {
    if (typeof cb !== 'function') return;
    if (!listeners[name]) listeners[name] = [];
    listeners[name].push(cb);
    if (REPLAY[name] && Object.prototype.hasOwnProperty.call(lastPayload, name)) {
      var p = lastPayload[name];
      setTimeout(function () {
        try { cb(p); } catch (e) { console.error('[gourd-ipc] 事件重放异常 ' + name, e); }
      }, 0);
    }
  }

  window.__GOURD_BRIDGE_EMIT__ = function (name, payload) {
    lastPayload[name] = payload;

    /* 窗口装饰状态直通自绘标题栏层（最大化图标/失焦淡化/全屏隐藏）。
       走独立通道而非 listeners，避免业务侧误注册后吞掉事件。 */
    if (name === 'window-chrome' && window.__GOURD_TITLEBAR__) {
      try { window.__GOURD_TITLEBAR__.apply(payload); }
      catch (e) { console.error('[gourd-ipc] 标题栏状态同步异常', e); }
    }

    var arr = listeners[name];
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) {
      try { arr[i](payload); } catch (e) {
        console.error('[gourd-ipc] 事件回调异常 ' + name, e);
      }
    }
  };

  /* ───────── 对外契约（逐项对齐 preload.js）───────── */

  window.__GOURD_IPC__ = {
    isDesktop: true,
    onBackendReady: function (cb) { on('backend-ready', cb); },
    onBackendFailed: function (cb) { on('backend-failed', cb); },
    /* 安装一致性告警：jar 自报 buildId 与打包快照不符（覆盖安装未完全替换）。
       该事件由后台自检异步发出，常晚于页面监听器注册，故已列入 REPLAY 白名单。 */
    onInstallMismatch: function (cb) { on('install-mismatch', cb); },
    getBackendState: function () { return invoke('get_backend_state'); },
    getBackendDetail: function () { return invoke('get_backend_detail'); },
    /* 手动重试后端：把 Rust 侧 Result<(), String> 翻译成与 Electron 版
       { ok, skipped, error } 同一形状，让 app-bootstrap.js 的错误条代码
       在两壳下走完全相同的分支（否则得为每个壳写一套结果解析）。*/
    restartBackend: function () {
      return invoke('restart_backend').then(function () {
        return { ok: true };
      })['catch'](function (e) {
        var msg = (e && e.message) ? String(e.message) : String(e);
        return { ok: false, error: msg, skipped: msg.indexOf('已在进行中') >= 0 };
      });
    },
    setWindowTitle: function (title) {
      send('set_window_title', { title: String(title || '') });
    },
    getAppVersion: function () { return invoke('updater_get_version'); },
    updaterGetState: function () { return invoke('updater_get_state'); },
    updaterCheck: function () { return invoke('updater_check'); },
    updaterDownload: function () { return invoke('updater_download'); },
    updaterInstall: function () { return invoke('updater_install'); },
    onUpdaterState: function (cb) { on('updater-state', cb); }
  };

  /* preload.js 同样暴露了 electronAPI.platform。前端当前无调用点，
     但保留以维持契约一致（第三方脚本/未来代码可能探测）。 */
  window.electronAPI = { platform: PLATFORM };

  /* ───────── 全屏遮罩探测（移植自 preload.js，逻辑逐行对齐）─────────
     窗口按钮由系统框架层绘制，永远压在 web 内容之上；弹窗打开时那一块会
     突兀地保持高亮。这里探测「当前是否有全屏半透明遮罩」并上报，由 Rust 侧
     titlebar 模块同步原生装饰。
     用 elementFromPoint 命中而非枚举业务类名——遮罩散落多处，枚举法必然漏。 */

  var SCRIM_MIN_COVERAGE = 0.9;
  var SCRIM_MAX_HOPS = 4;
  var SCRIM_RECHECK_MS = 320;

  function scrimColorOf(el) {
    if (!el || el.nodeType !== 1) return null;
    var cs = window.getComputedStyle(el);
    if (!cs || cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') return null;
    var bg = cs.backgroundColor;
    var m = /^rgba?\(([^)]+)\)$/.exec(bg);
    var a = 1;
    if (m) {
      var parts = m[1].split(/[\s,/]+/).filter(function (p) { return p !== ''; });
      a = parts.length >= 4 ? parseFloat(parts[3]) : 1;
    } else if (bg === 'transparent') {
      a = 0;
    }
    if (!isFinite(a) || !(a > 0.02 && a < 1)) return null;
    var rect = el.getBoundingClientRect();
    if (rect.top > 1 || rect.left > 1) return null;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    if (!(vw > 0 && vh > 0)) return null;
    if (rect.width * rect.height < vw * vh * SCRIM_MIN_COVERAGE) return null;
    return bg;
  }

  function probeScrim() {
    var vw = window.innerWidth;
    if (!document.body || !(vw > 20)) return null;
    var points = [[6, 6], [Math.round(vw / 2), 6], [vw - 6, 6]];
    for (var i = 0; i < points.length; i++) {
      var el = document.elementFromPoint(points[i][0], points[i][1]);
      for (var hop = 0; el && hop < SCRIM_MAX_HOPS; hop++) {
        if (el === document.body || el === document.documentElement) break;
        var color = scrimColorOf(el);
        if (color) return color;
        el = el.parentElement;
      }
    }
    return null;
  }

  function installScrimWatcher() {
    var reported = null;
    var pending = false;

    function runDetect() {
      var color = null;
      try { color = probeScrim(); } catch (e) { color = null; }
      if (color === reported) return;
      reported = color;

      /* 自绘标题栏（Win/Linux）：按钮层 z-index 高于任何业务遮罩以保证始终可点，
         因此需要主动叠一张同色蒙版，视觉上与遮罩融为一体。
         这一步是纯前端的，无需等 Rust 往返，先做以免出现闪烁。 */
      if (window.__GOURD_TITLEBAR_SCRIM__) {
        try { window.__GOURD_TITLEBAR_SCRIM__(color); } catch (e) {}
      }

      /* macOS 仍需 Rust 侧显隐原生红绿灯（那里没有 DOM 可盖）；
         Win/Linux 下该命令是空转，保留是为了三平台走同一条链路。 */
      send('set_window_scrim', { scrim: color });
    }
    function schedule() {
      if (pending) return;
      pending = true;
      var run = function () { pending = false; runDetect(); };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
      else setTimeout(run, 16);
    }
    function scheduleWithRecheck() {
      schedule();
      setTimeout(runDetect, SCRIM_RECHECK_MS);
    }

    /* 只观察 body 直下子节点，不开 subtree：否则流式输出时每次 DOM 改动都要过一遍 */
    var attrObserver = new MutationObserver(schedule);
    function bindAttrTargets() {
      attrObserver.disconnect();
      var opts = { attributes: true, attributeFilter: ['style', 'class'] };
      attrObserver.observe(document.body, opts);
      var kids = document.body.children;
      for (var i = 0; i < kids.length; i++) attrObserver.observe(kids[i], opts);
    }
    new MutationObserver(function () { bindAttrTargets(); schedule(); })
      .observe(document.body, { childList: true });
    bindAttrTargets();

    window.addEventListener('click', scheduleWithRecheck, true);
    window.addEventListener('keydown', scheduleWithRecheck, true);
    window.addEventListener('resize', schedule);

    schedule();
  }

  /* ───────── 窗口拖拽区 ─────────
     WebView2 / WKWebView 不支持 -webkit-app-region，改用 start_dragging 命令。
     no-drag 白名单一律用通用元素选择器，不得枚举业务类名。 */

  var NO_DRAG_SELECTOR = 'button, input, a, select, textarea, label, [contenteditable="true"], [role="button"]';

  function dragSelectors() {
    /* .titlebar-drag-region 是右侧内容区顶部的 36px 条（css/app.css:11 定义，
       index.html:157 挂在 .main-area 下）。原 Electron 版靠 -webkit-app-region:drag
       生效，WebView2/WKWebView 不支持该属性，必须显式纳入拖拽选择器，
       否则关掉系统装饰后主内容区顶部完全无法拖动窗口。 */
    var list = ['.titlebar-drag-region', '.sidebar-header-top'];
    if (PLATFORM === 'darwin') {
      list.push('.sidebar-header');
      list.push('.filer-topbar');
    }
    return list;
  }

  function closestMatch(el, selector) {
    if (!el || typeof el.closest !== 'function') return null;
    try { return el.closest(selector); } catch (e) { return null; }
  }

  function isDragTarget(el) {
    if (!el || el.nodeType !== 1) return false;
    if (closestMatch(el, NO_DRAG_SELECTOR)) return false;
    var sels = dragSelectors();
    for (var i = 0; i < sels.length; i++) {
      if (closestMatch(el, sels[i])) return true;
    }
    return false;
  }

  function installDragRegion() {
    /* 拖拽区禁止文本选中，手感对齐原生标题栏 */
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
        send('plugin:window|toggle_maximize', { label: WINDOW_LABEL });
      } else {
        send('plugin:window|start_dragging', { label: WINDOW_LABEL });
      }
    }, true);
  }

  /* ───────── DOM 就绪后的初始化 ───────── */

  function onReady() {
    /* 复用 web 端既有的 Electron 专属样式（css/app.css、css/code.css 依赖这两个类名），
       故沿用 is-electron 而不改名，避免样式全线失效。 */
    document.body.classList.add('is-electron');
    if (PLATFORM === 'darwin') document.body.classList.add('is-mac');

    function syncTheme() {
      var theme = document.body.getAttribute('data-theme') || 'dark';
      send('set_window_theme', { theme: theme });
    }
    syncTheme();
    new MutationObserver(syncTheme).observe(document.body, {
      attributes: true,
      attributeFilter: ['data-theme']
    });

    installDragRegion();
    installScrimWatcher();
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
})();
"#;
