//! gourd-work-desktop — Tauri app with embedded Rust-native kernel.
//!
//! Unlike the old gourd-ai-tauri (which spawns a JVM subprocess), this binary
//! embeds the agent kernel directly: no Java, no proxy, instant startup.
//!
//! ## How the page reaches the kernel (important)
//!
//! Tauri serves `frontendDist` through its asset protocol, so the page origin is
//! `http://tauri.localhost` — **not** the kernel's origin. The frontend issues
//! every API call as a same-origin relative path (`/web/...`), which under the
//! asset protocol resolves to `tauri.localhost/web/...`: the SPA fallback answers
//! `200` with `index.html` instead of JSON, and `ws://tauri.localhost/web/gate`
//! is refused outright. The UI therefore loads but nothing works.
//!
//! Two ways out were considered:
//!   - serve the UI from the kernel and point the window at `http://127.0.0.1:port`
//!     (what the old shell did, via a separate UI server + reverse proxy);
//!   - keep the asset protocol and give the frontend the kernel's absolute origin.
//!
//! This build takes the second: the kernel origin is injected at document-start as
//! `window.__GWORK_KERNEL_ORIGIN__`, and `js/kernel-bridge.js` rewrites
//! `fetch` / `XMLHttpRequest` / `WebSocket` targets from relative API paths to that
//! origin. Verified against a running build: cross-origin `GET /web/chat/meta`
//! returns JSON, `POST` form bodies return 200, and `ws://127.0.0.1:port/web/gate`
//! opens — the kernel does not check `Origin` and its CORS layer allows any origin.
//!
//! In browser mode (`gwork --serve N --static ui`) the variable is absent, the
//! bridge stays inert, and relative paths keep working unchanged.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tracing::{error, info, warn};

mod commands;
mod auth;
mod external_link;
mod ipc_bridge;
mod logging;
mod titlebar_ui;
mod tray;
mod updater;

// ─── 远控通道子系统（自 gourd-ai-tauri 移植）───────────────────────────────
// paths   : 全局路径解析单一来源（~/.gwork、extraResources 候选排序）
// server  : REMOTE_ROUTE 路由表 —— 远程工作区数据面的分流真值源
//           （register/bind_scope/unregister/reset 四个入口被 remote/ 调用）
// remote  : SSH/WSL 会话、版本化部署根、隧道、模型内存镜像、9 个 remote_* 命令
mod paths;
mod server;
mod remote;

/// Window label; referenced by the injected scripts and the capabilities file.
pub use ipc_bridge::{MAIN_WINDOW_LABEL, MAIN_WINDOW_TITLE};

/// Initial inner size, matching the previous static window config.
const WIN_WIDTH: f64 = 1280.0;
const WIN_HEIGHT: f64 = 860.0;
const MIN_WIDTH: f64 = 900.0;
const MIN_HEIGHT: f64 = 600.0;

/// How long to wait for the in-process kernel to answer before giving up.
const KERNEL_READY_TIMEOUT: Duration = Duration::from_secs(20);

pub struct AppState {
    pub kernel_port: u16,
    pub kernel_origin: String,
    pub workspace: std::path::PathBuf,
    /// Set once the kernel answered its first health probe.
    pub kernel_ready: std::sync::atomic::AtomicBool,
    /// Last kernel startup error, surfaced through `get_backend_detail`.
    pub kernel_error: std::sync::Mutex<Option<String>>,

    /// 用户是否已请求**真正退出**（托盘菜单「退出」）。
    ///
    /// 这是「关窗口收进托盘」机制的承重墙。本壳的内核跑在进程内，进程一死
    /// 正在执行的 ReAct 任务、后台 bash、远端 SSH 会话全部蒸发，所以默认必须
    /// 拦住关闭与退出；而拦住之后就需要这个标志来区分「用户想藏窗口」和
    /// 「用户想关应用」—— 没有它，`prevent_close` / `prevent_exit` 会把退出
    /// 也一并拦掉，应用将永远关不掉，用户只能去任务管理器强杀（而强杀会跳过
    /// `RunEvent::Exit` 的 `remote::shutdown_all()`，把远端 java 进程留成孤儿）。
    ///
    /// 置位的唯一入口是 `tray::request_quit()`。
    pub is_quitting: AtomicBool,

    // ─── 以下两个字段由移植进来的 server.rs 要求 ───────────────────────────
    // server::start_ui_server 的反代需要「后端就绪广播」与「后端端口的唯一共享
    // 状态」。本壳内核在进程内，故二者直接映射到内核自身：端口 = kernel_port，
    // 就绪 = 首次健康探针通过。
    //
    // 端口必须是 Arc<Mutex<u16>> 而不是复制一份再轮询同步：否则 ready 广播与端口
    // 更新之间会出现「首批请求打到 0 端口」的竞态（旧壳踩过）。
    pub backend_ready: tokio::sync::watch::Sender<bool>,
    pub backend_port: std::sync::Arc<std::sync::Mutex<u16>>,
}

/// Pick a free TCP port on loopback.
///
/// Binds `:0`, reads the assigned port, then drops the socket. There is a tiny
/// race before the kernel rebinds it; this is the same approach the previous shell
/// used in production, and a collision shows up as a clear startup error rather
/// than a silent hang.
fn find_available_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

/// Poll the kernel until it answers, so the window is never shown against a
/// server that is not listening yet.
async fn wait_for_kernel(port: u16) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{}/web/chat/meta", port);
    let client = reqwest::Client::builder()
        // Never route loopback probes through a system proxy: a corporate proxy
        // would swallow 127.0.0.1 and the wait would always time out.
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| format!("http client: {}", e))?;

    let deadline = tokio::time::Instant::now() + KERNEL_READY_TIMEOUT;
    let mut last = String::from("no attempt");
    while tokio::time::Instant::now() < deadline {
        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => return Ok(()),
            Ok(resp) => last = format!("HTTP {}", resp.status()),
            Err(e) => last = e.to_string(),
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(format!(
        "kernel did not become ready within {:?} (last: {})",
        KERNEL_READY_TIMEOUT, last
    ))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // File-backed logging: the kernel runs in this process, so its events
    // land in the same file. stdout-only init left GUI runs with zero
    // on-disk diagnostics (see logging.rs module docs).
    if let Some(path) = logging::init() {
        // Subscriber is live now; this first line doubles as a boot marker
        // proving the file is writable from this build.
        info!(log = %path.display(), "desktop shell logging to file");
    } else {
        eprintln!("warning: could not open log file; falling back to stdout");
    }

    tauri::Builder::default()
        // 单实例锁。**必须第一个注册**（Tauri 官方要求：它要在其它插件之前
        // 抢到进程级互斥，否则第二个实例可能已经跑完部分初始化才被劝退）。
        //
        // 托盘常驻后这是高频路径而非边缘情况：用户点了关闭按钮、窗口消失，
        // 很自然地以为应用退了，于是再点一次桌面图标。没有这道锁就会起第二个
        // 进程 —— `find_available_port()` 给它一个新端口，于是**两个内核同时
        // 读写同一个 ~/.gwork**（settings.json、会话 ndjson），互相覆盖，
        // 任务栏里还会多出第二个托盘图标。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 唤回已有窗口。窗口可能尚未创建（本壳要等内核健康探针通过才建窗），
            // 此时静默跳过即可：首实例的建窗流程本来就会把窗口显示出来。
            if let Some(win) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        // 自动更新插件。tauri.conf.json 的 plugins.updater 提供 endpoint + pubkey，
        // 排在单实例锁之后（官方要求它抢到进程级互斥后再注册其它插件）。
        // 显式置位 PLUGIN_REGISTERED：updater.rs 的 do_check 会调
        // app.updater_builder()，插件未注册时其 state::<UpdaterState>() 会 panic，
        // 而 release profile 是 panic="abort"。公钥由发版流水线产出（与旧壳同一把），
        // 本仓库不生成密钥、不产出 .sig。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();

            // Workspace: the kernel's own default location. Kept in sync with
            // `Settings::gwork_home()` semantics so sessions/models resolve the
            // same way as in CLI mode.
            let workspace = dirs::home_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join("GWork");
            let _ = std::fs::create_dir_all(&workspace);

            let port = find_available_port().map_err(|e| format!("no free port: {}", e))?;
            let origin = format!("http://127.0.0.1:{}", port);
            let addr = SocketAddr::from(([127, 0, 0, 1], port));

            let (ready_tx, _ready_rx) = tokio::sync::watch::channel(false);
            // 内核端口在绑定那一刻就已确定（不像旧壳要等 JVM 起来才知道），
            // 故直接预置；就绪位仍等健康探针通过后再广播。
            let backend_port = std::sync::Arc::new(std::sync::Mutex::new(port));

            app.manage(AppState {
                kernel_port: port,
                kernel_origin: origin.clone(),
                workspace: workspace.clone(),
                kernel_ready: AtomicBool::new(false),
                kernel_error: std::sync::Mutex::new(None),
                is_quitting: AtomicBool::new(false),
                backend_ready: ready_tx,
                backend_port,
            });

            // 账号登录态：注册全局 AuthState，从 OS keyring 恢复上次的会话并
            // 启动常驻保活（access token 临近到期自动 refresh）。必须在建窗前
            // 完成，否则前端首个 auth_status() 会拿到「账号模块未初始化」。
            auth::install(&handle);

            // 自动更新：插件已在 Builder 上注册，此处显式置位并启动状态机
            // （延迟首检 + 6h 复检）。必须在建窗之前：窗口创建后前端会立刻
            // 调 updaterGetState() 拉快照，未初始化时只能拿到 mode='none'。
            updater::PLUGIN_REGISTERED.store(true, Ordering::SeqCst);
            {
                let h = handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = updater::init(h).await {
                        error!(error = %e, "updater init failed");
                    }
                });
            }

            // Start the kernel in-process.
            //
            // Must use `tauri::async_runtime::spawn`, NOT `tokio::spawn`: the setup
            // hook runs before any Tokio reactor is entered, so `tokio::spawn`
            // panics with "there is no reactor running" and the process aborts
            // (exit 0xC0000409) before a window is ever created. Tauri's runtime
            // is a Tokio runtime under the hood, so the kernel's own tokio::spawn
            // calls inside `serve` work fine once running on it.
            {
                let ws = workspace.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = gourd_work_core::server::serve(addr, ws).await {
                        error!(error = %e, "kernel server failed");
                    }
                });
            }

            // Wait for readiness, then create the window. Creating it earlier
            // would show a page whose first API calls all fail.
            {
                let h = handle.clone();
                let origin2 = origin.clone();
                tauri::async_runtime::spawn(async move {
                    let result = wait_for_kernel(port).await;
                    let h2 = h.clone();
                    // Window creation must happen on the main thread.
                    let _ = h.run_on_main_thread(move || {
                        if let Err(e) = result {
                            warn!(error = %e, "kernel not ready; opening window anyway");
                            if let Some(st) = h2.try_state::<AppState>() {
                                *st.kernel_error.lock().unwrap() = Some(e);
                            }
                        } else if let Some(st) = h2.try_state::<AppState>() {
                            st.kernel_ready.store(true, Ordering::SeqCst);
                            // 广播就绪：server.rs 的反代据此放行请求（不再宽限等待）。
                            let _ = st.backend_ready.send(true);
                        }
                        if let Err(e) = create_main_window(&h2, &origin2) {
                            error!(error = %e, "failed to create main window");
                        }
                    });
                });
            }

            // 创建系统托盘。放在建窗 spawn 之后、但不等它：托盘不依赖窗口存在
            // （show/toggle 都对 None 做了兜底），而窗口要等内核就绪才建，
            // 串行等待会让托盘图标晚出现数秒。
            //
            // 失败只记日志、不中断启动：没有托盘时应用退化为「关窗口即退出」
            // （即修复前的行为），仍然可用；反之若因托盘建不出来就拒绝启动，
            // 等于把一个装饰性故障升级成「完全打不开」。
            if let Err(e) = tray::create_tray(&handle) {
                error!(error = %e, "系统托盘创建失败：关闭窗口将直接退出应用");
            }

            info!(port, workspace = %workspace.display(), "kernel started");
            Ok(())
        })
        // Forward window chrome changes (maximize/focus/fullscreen) to the custom
        // titlebar layer. Registered on the Builder (not inside setup): in Tauri v2
        // `on_window_event` is a Builder method, and `App` has no such method.
        .on_window_event(|window, event| {
            if window.label() != MAIN_WINDOW_LABEL {
                return;
            }
            match event {
                // 关闭按钮 → 收进托盘，而不是退出应用。
                //
                // 内核跑在本进程内，进程一死正在执行的任务全部蒸发，所以「关窗口」
                // 必须降级为「藏窗口」。两条路径都要拦：
                //   · 系统装饰的关闭钮 / Alt+F4 → 直接触发 CloseRequested；
                //   · 自绘标题栏的关闭钮 → `titlebar_ui::window_close` 调 `close()`，
                //     而 Tauri 的 `close()` 同样先发 CloseRequested，故在此被拦下。
                // 后者是刻意设计：让自绘按钮复用同一条语义，不必在命令里另写一套
                // hide 逻辑（否则两处会各自漂移）。
                //
                // 用户已点过托盘「退出」时 is_quitting 为真，此时放行、真正销毁窗口。
                WindowEvent::CloseRequested { api, .. } => {
                    let app = window.app_handle();
                    let quitting = app
                        .try_state::<AppState>()
                        .map(|s| s.is_quitting.load(Ordering::SeqCst))
                        // 状态读不到时按「不退出」处理：宁可多留一次进程，
                        // 也不能误杀正在跑的任务。
                        .unwrap_or(false);
                    if !quitting {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
                // 自绘标题栏依赖这些事件切换「最大化/还原」图标、
                // 失焦淡化与全屏隐藏。Windows/Linux 关掉了系统装饰，
                // 前端拿不到任何原生状态，只能由这里回推。
                WindowEvent::Resized(_) | WindowEvent::Focused(_) => {
                    titlebar_ui::emit_chrome_state(window.app_handle());
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_kernel_port,
            commands::get_kernel_origin,
            commands::get_workspace,
            commands::get_app_version,
            commands::get_backend_state,
            commands::get_backend_detail,
            commands::set_window_title,
            commands::pick_directory,
            commands::pick_file,
            titlebar_ui::window_minimize,
            titlebar_ui::window_toggle_maximize,
            titlebar_ui::window_close,
            titlebar_ui::window_get_chrome,
            // ─── 远控通道（9 个，与 build.rs 的 COMMANDS 及 capabilities 一一对应）───
            remote::remote_connect,
            remote::remote_disconnect,
            remote::remote_reconnect,
            remote::remote_state,
            remote::remote_list,
            remote::remote_forget_host,
            remote::remote_mirror_sync,
            remote::remote_bind_scope,
            // 仅 Windows 宿主：WSL 通道。非 Windows 下命令不存在，前端
            // remoteWslList() 的 invoke 会 reject 并被桥接层降级为空数组，
            // 于是 WSL 通道自动隐藏（与旧壳同一口径）。
            #[cfg(target_os = "windows")]
            remote::remote_wsl_list,
            // 账号登录态（注册/登录/登出/查询/刷新/取用户资料）
            auth::auth_status,
            auth::auth_login,
            auth::auth_register,
            auth::auth_send_code,
            auth::auth_config,
            auth::auth_logout,
            auth::auth_refresh,
            auth::auth_self,
            // 自动更新状态机（前端 app-settings-about.js / app-update-badge.js
            // 通过 __GOURD_IPC__ 的 updater* 方法订阅，状态机本身已就绪）
            updater::updater_get_version,
            updater::updater_get_state,
            updater::updater_check,
            updater::updater_download,
            updater::updater_install,
        ])
        .build(tauri::generate_context!())
        .expect("error while running GWork desktop")
        .run(|app_handle, event| {
            match event {
                // 第二道退出防线。CloseRequested 只管「点关闭按钮」这一条路，
                // 而 Tauri 在**所有窗口都销毁后**还会自行发起一次退出请求
                // （macOS 点红绿灯、或其它代码路径 destroy 窗口都会走到这里）。
                // 不拦的话，托盘图标还在、进程却已经退了 —— 比不拦更糟的是
                // 用户会看到一个点不动的死图标。
                RunEvent::ExitRequested { api, .. } => {
                    let quitting = app_handle
                        .try_state::<AppState>()
                        .map(|s| s.is_quitting.load(Ordering::SeqCst))
                        .unwrap_or(false);
                    if !quitting {
                        api.prevent_exit();
                    }
                }
                // 退出前销毁远端后端进程。必须在此收尾：否则用户关掉应用后，远端那个
                // 进程会常驻到服务器重启为止（方案 §四「随连接销毁」语义）。
                // 清理不需要 AppHandle，故不 clone 它。
                //
                // 注意这里只在**真退出**时跑：收进托盘不触发 Exit，远端连接因此
                // 得以保留（符合预期 —— 任务还在跑）。
                RunEvent::Exit => {
                    tauri::async_runtime::block_on(async {
                        remote::shutdown_all().await;
                    });
                }
                _ => {}
            }
        });
}

/// Create the main window with the kernel origin and desktop chrome injected.
///
/// The window is built here rather than declared in `tauri.conf.json` because the
/// decoration strategy is platform-specific (see `titlebar_ui` module docs):
/// Windows/Linux drop system decorations and draw their own controls, while macOS
/// keeps native traffic lights via `TitleBarStyle::Overlay`.
fn create_main_window(app: &tauri::AppHandle, kernel_origin: &str) -> tauri::Result<()> {
    // Injection order matters:
    //   1. kernel bridge — must exist before any page script issues a request;
    //   2. IPC bridge — defines __GOURD_IPC__ and adds body.is-electron;
    //   3. titlebar — reads the platform tag the IPC bridge exposes.
    // External-link handlers. Both are required, and neither is optional
    // polish: since wry 0.53 disabled default new-window creation on Windows,
    // a missing `on_new_window` makes every `target="_blank"` anchor in the UI
    // a silent no-op. See external_link.rs for the full reasoning.
    //
    //   on_new_window — `target="_blank"` and `window.open`
    //   on_navigation — same-window jumps to an external address
    //
    // Cancelled navigations are handed to `open_external`, which refuses
    // anything that is not http(s) (a cancelled `file://` would otherwise be
    // opened with its associated program).
    let nav_app = app.clone();
    let win_app = app.clone();
    let mut builder = WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, WebviewUrl::App("index.html".into()))
        .initialization_script(&kernel_bridge_script(kernel_origin))
        .initialization_script(&ipc_bridge::init_script(kernel_origin))
        .initialization_script(&titlebar_ui::init_script())
        .on_new_window(move |url, _features| {
            if external_link::is_internal_url(&url) {
                tauri::webview::NewWindowResponse::Allow
            } else {
                external_link::open_external(&win_app, &url);
                tauri::webview::NewWindowResponse::Deny
            }
        })
        .on_navigation(move |url| {
            if external_link::is_internal_url(url) {
                true
            } else {
                external_link::open_external(&nav_app, url);
                false
            }
        })
        .title(MAIN_WINDOW_TITLE)
        .inner_size(WIN_WIDTH, WIN_HEIGHT)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .resizable(true)
        // Hand the WebView2 drag-drop handler back to the web layer.
        //
        // wry registers an OLE drop target on the WebView2 control, which —
        // because WebView2 is a windowed control — swallows the entire HTML5
        // drag event family: `dragstart` / `dragover` / `drop` never reach the
        // page. Tauri's own docs say disabling this "is required to use HTML5
        // drag and drop APIs on the frontend on Windows"
        // (tauri::webview::WebviewWindowBuilder::disable_drag_drop_handler).
        //
        // Without it every in-page drag looks dead while the CSS `cursor: grab`
        // still shows, so the affordance lies to the user. That was the reported
        // symptom for the sidebar task/project reorder handles, and it equally
        // broke the model-settings provider reorder and the `dataTransfer.files`
        // upload drop zones in app-ui.js.
        //
        // Disabling is safe here: the app never consumes Tauri's native drop
        // events (no `WindowEvent::DragDrop` arm in the window event match, no
        // `onDragDropEvent` listener in the UI). Uploads read the sandboxed
        // `File` objects from the DOM drop event, which is exactly what the
        // browser gives us once this is off.
        //
        // Note: `dragDropEnabled` cannot be set in tauri.conf.json for this
        // window — `app.windows` is empty because the decoration strategy is
        // platform-specific, so the window is built here in code.
        .disable_drag_drop_handler()
        .visible(false);

    #[cfg(target_os = "macos")]
    {
        // Equivalent to Electron's titleBarStyle:'hidden' — native traffic lights
        // overlay the web content. Self-drawn controls would be a cheap imitation
        // and would lose the hover glyphs / Option-click zoom behaviour.
        builder = builder
            .decorations(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay);
    }
    #[cfg(not(target_os = "macos"))]
    {
        // shadow(true) keeps the window drop shadow that decorations(false) would
        // otherwise remove (tauri#12285 / #13134 discuss the trade-off).
        builder = builder.decorations(false).shadow(true);
    }

    let window = builder.build()?;

    // Push the initial chrome state once, so the maximize/restore icon is right
    // before any resize event arrives.
    titlebar_ui::emit_chrome_state(app);
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// Script exposing the kernel origin to the page.
///
/// Kept separate from the IPC bridge so `js/kernel-bridge.js` can rely on a single
/// well-known global without depending on bridge internals.
fn kernel_bridge_script(kernel_origin: &str) -> String {
    format!(
        "window.__GWORK_KERNEL_ORIGIN__ = {};",
        serde_json::Value::String(kernel_origin.to_string())
    )
}
