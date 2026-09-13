// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod cli_provision;
mod ipc_bridge;
mod logging;
mod migration;
mod paths;
mod server;
mod titlebar;
mod titlebar_ui;
mod tray;
mod updater;
mod window;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Manager, RunEvent, WindowEvent};
use tracing::{error, info, warn};

/// tauri.conf.json 中 未替换的 pubkey 占位符。真实公钥由 `tauri signer generate` 产出，
/// 私钥只存 CI Secret（TAURI_SIGNING_PRIVATE_KEY），绝不入库。
const PUBKEY_PLACEHOLDER: &str = "REPLACE_WITH_TAURI_PUBLIC_KEY";

/// 公钥是否可用 —— 决定是否注册 tauri-plugin-updater。
///
/// 抽成独立函数仅为可测：它控制着一条曾导致安装版闪退的路径
/// （插件未注册 → updater_builder() 内部 state::<UpdaterState>() panic → abort），
/// 必须有回归护栏钉死“占位符/空值一律不注册”。
fn updater_pubkey_usable(pubkey: &str) -> bool {
    let k = pubkey.trim();
    !k.is_empty() && k != PUBKEY_PLACEHOLDER
}

/// 全局应用状态
pub struct AppState {
    pub backend_ready: tokio::sync::watch::Sender<bool>,
    /// 后端端口的唯一运行时状态。UI 代理必须直接共享此锁，不能复制后再轮询同步，
    /// 否则 backend-ready 广播与代理端口更新之间会出现首批请求打到 0 端口的竞态。
    pub backend_port: std::sync::Arc<std::sync::Mutex<u16>>,
    pub ui_port: std::sync::Mutex<u16>,
    pub is_quitting: AtomicBool,
}

impl AppState {
    fn new() -> Self {
        let (tx, _rx) = tokio::sync::watch::channel(false);
        Self {
            backend_ready: tx,
            backend_port: std::sync::Arc::new(std::sync::Mutex::new(0)),
            ui_port: std::sync::Mutex::new(0),
            is_quitting: AtomicBool::new(false),
        }
    }
}

fn main() {
    // 初始化日志：必须同时写文件。release 版是 GUI 子系统程序（见本文件顶部
    // `windows_subsystem = "windows"`），**没有控制台**，只 fmt 到 stdout 等于
    // 所有诊断输出（端口、java/jar 探测明细、探针状态码、子进程退出码）在用户
    // 机器上 100% 蒸发——这正是 2026-09-06 「覆盖安装后接口不通」查不动的直接原因。
    let log_path = logging::init();
        
    info!("GWork Desktop (Tauri) starting...");
    match &log_path {
        Some(p) => info!("主进程日志: {}", p.display()),
        None => warn!("主进程日志落盘失败，已降级为仅 stdout（排障请从终端启动本程序）"),
    }

    let state = AppState::new();

    // 注意：`generate_context!()` 会把图标、前端资源等全部内嵌进二进制，
    // 必须全程只展开一次并复用（调两次 = 资源双份嵌入，白白胀大包体）。
    let context = tauri::generate_context!();

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    // tauri-plugin-updater 需要 tauri.conf.json 的 plugins.updater 配置（endpoints + pubkey）。
    // 关键：插件未注册时，`app.updater_builder()` 内部的 `state::<UpdaterState>()` 会
    // 直接 panic（"state() called before manage()"）；又因 release profile 配了
    // `panic = "abort"`，进程会带 0xC0000409 直接崩掉。故此处与 updater.rs 的
    // PLUGIN_REGISTERED 严格配对：只有真注册了才置位，否则 updater 一律跑 Mode::None。
    // 除了"配置存在"，还要求 pubkey 是真实密钥：仓库里默认写的是占位符
    // REPLACE_WITH_TAURI_PUBLIC_KEY（真私钥不入库，只在 CI Secret 里）。占位符状态下
    // 任何更新包都无法通过签名校验，与其让用户反复撞"签名无效"错误，不如直接
    // 降级为 Mode::None（界面显示"当前版本不支持自动更新"）。
    let updater_pubkey = context
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("pubkey"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if updater_pubkey_usable(updater_pubkey) {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
        updater::PLUGIN_REGISTERED.store(true, Ordering::SeqCst);
    } else {
        warn!("plugins.updater.pubkey 未配置或仍为占位符，自动更新已禁用（需先 `tauri signer generate` 并写入真实公钥）");
    }

    builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 第二个实例启动时显示已有窗口
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            backend::get_backend_state,
            backend::get_backend_detail,
            backend::restart_backend,
            updater::updater_get_version,
            updater::updater_get_state,
            updater::updater_check,
            updater::updater_download,
            updater::updater_install,
            titlebar::set_window_theme,
            titlebar::set_window_scrim,
            titlebar_ui::window_minimize,
            titlebar_ui::window_toggle_maximize,
            titlebar_ui::window_close,
            titlebar_ui::window_get_chrome,
            window::set_window_title,
        ])
        // log_path 要被 setup 闭包持有（闭包要求 'static），故用 move 转移所有权
        .setup(move |app| {
            let app_handle = app.handle().clone();

            // 初始化路径与迁移
            if let Err(e) = paths::init() {
                error!("路径初始化失败: {}", e);
            }
            if let Err(e) = migration::migrate_global_data() {
                warn!("全局数据迁移失败（不影响启动）: {}", e);
            }

            // 把 UI 代理实际订阅的 watch 交给 backend 模块，使其状态迁移能广播到代理。
            // 必须早于 start_ui_server / bootstrap，否则起步阶段的失败广播会丢失。
            backend::bind_app_ready_tx(app_handle.state::<AppState>().backend_ready.clone());

            // 启动现场进日志：排障时先看到「本次到底在看哪份资源」，而不是事后猜
            info!(
                "启动环境: version={} resourcesDir={} runtimeHome={} mainLog={}",
                app_handle.package_info().version,
                paths::resources_dir().display(),
                paths::runtime_home_dir().display(),
                log_path
                    .as_ref()
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|| "<仅 stdout>".to_string()),
            );


            // 启动本地 UI 服务器（秒开，无需等待后端）
            let ui_state = app_handle.state::<AppState>();
            let ui_port = tauri::async_runtime::block_on(async {
                server::start_ui_server(app_handle.clone()).await
            });
            match ui_port {
                Ok(port) => {
                    info!("UI 服务器: http://localhost:{}", port);
                    *ui_state.ui_port.lock().unwrap() = port;
                }
                Err(e) => {
                    error!("UI 服务器启动失败: {}", e);
                }
            }

            // 引导后端启动（异步，不阻塞窗口显示）
            //
            // 必须**先于**窗口创建派发。create_main_window() 内部的
            // `WebviewWindowBuilder::build()` 是同步创建 WebView2（实测 Windows 冷态 0.7~3.4s，
            // macOS/Linux 的 WKWebView/WebKitGTK 同样是阻塞式建窗），若排在它后面，jar 的整个
            // 启动过程会被这段建窗时间串行挡住 —— 冷启动白等数秒，且与 jar 本身快慢无关。
            //
            // 调整为「先 spawn 后端（立刻开始跑 JVM），再在主线程建窗口」后两者并行，
            // 恢复到 Electron 版天然具备的时序（那边的 createMainWindow 只构造 BrowserWindow
            // + loadURL，不等页面，因此 bootstrap 紧跟着就跑了）。
            //
            // 事件时序：窗口未创建期间发出的 backend-ready / backend-failed 会被丢弃，但
            // create_main_window 的 on_page_load(Finished) 会调 push_state_to_window()
            // 按当前真实状态补推一次，渲染层的 __whenBackendReady 门闸不会失联。
            let backend_handle = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = backend::bootstrap(backend_handle).await {
                    error!("后端引导失败: {}", e);
                }
            });

            // 创建主窗口
            if let Err(e) = window::create_main_window(&app_handle) {
                error!("主窗口创建失败: {}", e);
            }

            // 创建托盘
            if let Err(e) = tray::create_tray(&app_handle) {
                error!("托盘创建失败: {}", e);
            }

            // CLI provision（仅打包版）
            if !cfg!(debug_assertions) {
                tauri::async_runtime::spawn(async {
                    if let Err(e) = cli_provision::provision_cli().await {
                        warn!("终端命令注册失败: {}", e);
                    }
                });
            }

            // 自动更新初始化
            let updater_handle = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = updater::init(updater_handle).await {
                    warn!("自动更新初始化失败: {}", e);
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        let app = window.app_handle();
                        let state = app.state::<AppState>();
                        if !state.is_quitting.load(Ordering::SeqCst) {
                            // 隐藏到托盘，不退出
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
                    WindowEvent::Destroyed => {
                        // 窗口销毁时清出 chrome 状态表，防止按 label 泄漏。
                        // 注意：此处 `window` 是 `&Window` 而非 `&WebviewWindow`，
                        // 无法直接调用需要 WebviewWindow 的 scrim 复位，故只按 label 清理。
                        titlebar::on_window_destroyed(window.label());
                    }
                    _ => {}
                }
            }
        })
        .build(context)
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match event {
                RunEvent::ExitRequested { api, .. } => {
                    let state = app_handle.state::<AppState>();
                    if !state.is_quitting.load(Ordering::SeqCst) {
                        // 阻止退出，保持托盘运行
                        api.prevent_exit();
                    }
                }
                RunEvent::Exit => {
                    // 退出前清理
                    let app_handle = app_handle.clone();
                    tauri::async_runtime::block_on(async move {
                        backend::stop_backend().await;
                    });
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归护栏：占位符公钥绝不能启用 updater 插件。
    ///
    /// 这条链路是安装版闪退的上游开关：一旦这里误判为"可用"，插件其实仍会
    /// 因签名校验失败而不可用，但 PLUGIN_REGISTERED 被置位后 updater 会进入
    /// Auto/Notify 模式并发起真实检查 —— 若配置再有偏差就会走回 panic 路径。
    #[test]
    fn placeholder_pubkey_is_rejected() {
        assert!(!updater_pubkey_usable(PUBKEY_PLACEHOLDER));
        // 带空白的占位符同样要拒绝（JSON 里手滑多打空格是常见情形）
        assert!(!updater_pubkey_usable("  REPLACE_WITH_TAURI_PUBLIC_KEY  "));
    }

    /// 空值 / 缺失配置一律拒绝。
    #[test]
    fn empty_pubkey_is_rejected() {
        assert!(!updater_pubkey_usable(""));
        assert!(!updater_pubkey_usable("   "));
    }

    /// 真实公钥（minisign base64）才放行。
    #[test]
    fn real_pubkey_is_accepted() {
        assert!(updater_pubkey_usable(
            "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkK"
        ));
    }
}
