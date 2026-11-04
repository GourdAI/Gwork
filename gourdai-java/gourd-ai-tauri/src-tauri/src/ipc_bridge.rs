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
use tauri_plugin_dialog::DialogExt;
use tracing::debug;

/// 系统原生文件夹选择对话框（工作区「打开文件夹」主路径，前端 __GOURD_IPC__.pickDirectory）。
///
/// 必须走主进程原生对话框：网页侧任何 input/showDirectoryPicker 方案在桌面都会带出
/// 「选择要上传的文件夹」「将 N 个文件上传到此网站？」等浏览器语义弹框，与原生应用
/// 体验不符（用户实测回归）。取消或异常一律返回 Ok(None)，前端静默忽略不弹提示。
///
/// 用 blocking API：本命令在 async 命令上下文（非主线程）执行，官方推荐 blocking_*；
/// 内部会自行把对话框调度回主线程，不会冻住事件循环。
#[tauri::command]
pub async fn pick_directory(app: AppHandle) -> Result<Option<String>, String> {
    let folder = app
        .dialog()
        .file()
        .set_title("选择工作区文件夹")
        .blocking_pick_folder();
    Ok(folder
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned()))
}

/// 系统原生**文件**选择对话框（前端 __GOURD_IPC__.pickFile）。
///
/// 为何需要它（远程工作区向导的私钥路径「浏览」）：私钥是文件而非目录，
/// `pick_directory` 选完目录再手填文件名不是可用交互；而原前端里
/// `#remoteKeyBrowse` 按钮干脆零绑定——点了什么都不会发生（死 UI）。
///
/// 起始位置预选 `~/.ssh`（三平台同一约定），并把默认文件名置为 id_ed25519
/// 能少用户两步操作。
///
/// 【API 口径】插件 v2.7 无 `set_path`（那是 rfd 自己/旧版的名），起始目录用
/// `set_directory`、默认文件名用 `set_file_name`——写错直接 E0599 编译失败。
/// 取消或异常一律 Ok(None)，前端静默忽略。
#[tauri::command]
pub async fn pick_file(app: AppHandle) -> Result<Option<String>, String> {
    let mut builder = app
        .dialog()
        .file()
        .set_title("选择私钥文件");
    // 只在目录真实存在时设起始目录：rfd 对不存在的起始路径行为随平台而异
    //（Windows 回“上次位置”、macOS 回“最近使用”），与其依赖那些差异不如不预设。
    if let Some(ssh_dir) = dirs::home_dir().map(|h| h.join(".ssh")) {
        if ssh_dir.is_dir() {
            builder = builder
                .set_directory(ssh_dir)
                .set_file_name("id_ed25519");
        }
    }
    let file = builder.blocking_pick_file();
    Ok(file
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned()))
}

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
    /* 系统原生文件夹选择对话框（工作区「打开文件夹」）：返回所选目录绝对路径，
       取消返回 null（前端静默忽略）。桌面端必须走这里——网页侧 webkitdirectory
       兜底会在桌面弹出「将 N 个文件上传到此网站？」确认条与「选择要上传的文件夹」
       文案，均不可接受（用户实测）。 */
    pickDirectory: function () { return invoke('pick_directory'); },
    /* 原生文件选择对话框（远程向导「私钥路径 · 浏览」）：返回所选文件绝对路径，
       取消返回 null。私钥是文件不是目录，不能复用 pickDirectory。 */
    pickFile: function () { return invoke('pick_file'); },
    /* ───── 远程工作区（P1 SSH / P2 WSL / P3 CLI 预装）─────
       连接/断开/状态由 Rust 侧 remote 模块承载（russh/wsl.exe + 部署链 + 隧道/直连）。
       连接过程可能数十秒（首次上传 jar），进度经 remote-connect-progress 事件推送
       （需先 onRemoteProgress 注册监听，再发起连接）。
       channel："ssh"（默认，P1 老前端兼容）| "wsl"（P2，仅 Windows 宿主）| "preinstalled"（P3） */
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
        jumpPassphrase: (cfg && cfg.jumpPassphrase) ? String(cfg.jumpPassphrase) : null,
        /* 离线运行时包（可选）：内网/气隙远端无 Java 时优先上传该本地 tar.gz */
        runtimePkgPath: (cfg && cfg.runtimePkgPath) ? String(cfg.runtimePkgPath) : null
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
    /* 方案B：枚举全部在线连接（契约 §1.1）。元素形状 = remoteState 减去 authHeader
       （枚举面脱敏，凭据不得散给徽标/分组树/扇出拉取这些读列表的调用点）。
       启动恢复链靠它与本地持久化的 id 列表交叉：桌面进程重启后远端后端已销毁，
       LS 里残留的 id 必须据本列表丢弃。异常/非数组一律降级为空数组（与
       remoteWslList 同口径）：恢复链拿到空数组 = 「无在线连接」，不该把启动弄挂。 */
    remoteList: function () {
      return invoke('remote_list').then(function (v) {
        return Array.isArray(v) ? v : [];
      }, function () {
        return []; // 旧壳未登记该命令 / ACL 拒绝：静默降级，调用方走单 id 回退链
      });
    },
    /* P2：WSL 发行版列表（仅 Windows 宿主；无 WSL 返回空数组，前端隐藏 WSL 通道） */
    remoteWslList: function () {
      return invoke('remote_wsl_list').then(function (v) {
        return Array.isArray(v) ? v : [];
      }, function () {
        return []; // 非 Windows 宿主 / wsl.exe 缺失：静默降级为空列表
      });
    },
    /* P4：手动重推模型镜像（远端方案 A 内存镜像；本地改完配置后无需重连）。
       返回 { connectionId, synced, lines }；进度行同步走 remote-connect-progress 事件 */
    remoteMirrorSync: function (connectionId) {
      return invoke('remote_mirror_sync', { connectionId: String(connectionId || '') });
    },
    /* P4：断线重连（复用上次连接参数；退避重试由本层控制，见 app-remote.js）。
       方案B（契约 §1.2）：可选 connectionId 透传——传了就重连指定连接（多连接并发时
       不会重错目标），不传则为「重连最近一台」（旧调用点行为不变，Rust 侧同语义）。 */
    remoteReconnect: function (connectionId) {
      return invoke('remote_reconnect', {
        connectionId: (connectionId === undefined || connectionId === null || connectionId === '')
          ? null
          : String(connectionId)
      });
    },
    /* 指纹拒绝后「忘记该主机」：清除该 host:port 全部指纹记录，返回 { removed }。
       服务器确认换钥（重装等）后用；清完重连回到首连自动信任流程 */
    remoteForgetHost: function (host, port) {
      return invoke('remote_forget_host', {
        host: String(host || ''),
        port: (port === undefined || port === null || port === '') ? null : Number(port)
      });
    },
    /* 按工作区分流：选中工作区时声明它的归属环境。cwd 来自哪个后端就绑哪个：
       远程期间选中本地目录必须传 null（否则会被误绑到远端 = 跳机读写），
       选中远端目录必须传该连接的 connectionId（否则回本地而后端无此路径）。 */
    remoteBindScope: function (cwd, connectionId) {
      return invoke('remote_bind_scope', {
        cwd: String(cwd || ''),
        connectionId: connectionId ? String(connectionId) : null
      });
    },
    onRemoteProgress: function (cb) { on('remote-connect-progress', cb); },
    onRemoteState: function (cb) { on('remote-connection-state', cb); },
    /* 模型镜像进度/终态（与连接日志分开）：镜像推送发生在向导已关闭之后，
       remote-connect-progress 那时已无消费者，降级必须另走一条事件才能被看见 */
    onRemoteMirror: function (cb) { on('remote-mirror-state', cb); },
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
