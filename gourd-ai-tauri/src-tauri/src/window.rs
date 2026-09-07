//! 主窗口管理。
//!
//! 对齐原 Electron 版行为：
//! - 隐藏系统标题栏，由前端自定义标题栏并接管拖动区域。
//!   具体策略见 `titlebar_ui.rs` 模块文档：Windows/Linux 走 `decorations(false)`
//!   + 自绘控件，macOS 走 `TitleBarStyle::Overlay` + 原生红绿灯。
//! - `visible = false` 先建窗口，待页面 ready-to-show 后再显示，避免白屏闪烁。
//! - 加载本地 UI 服务器地址 `http://localhost:{ui_port}`。
//! - 拦截外链（`target=_blank` / `window.open`）交给系统浏览器，拦截主窗口导航到外部地址。
//! - 锁定窗口标题为 "GWork"，防止页面 `document.title` 覆盖窗口标题。

use std::sync::atomic::Ordering;

use tauri::{
    webview::{NewWindowResponse, PageLoadEvent},
    AppHandle, Manager, WebviewUrl, WebviewWindow,
};
use tracing::{info, warn};
use url::Url;

use crate::AppState;

/// 主窗口标签
pub const MAIN_WINDOW_LABEL: &str = "main";
/// 窗口固定标题（页面标题变更不得覆盖）
pub const MAIN_WINDOW_TITLE: &str = "GWork";

/// 默认窗口尺寸（逻辑像素）。
///
/// 比 Electron 版的 1440x900 收窄一档：那个尺寸在 1080p 屏上占掉近八成宽度，
/// 初见过于压迫。实际生效值还会再经 [`initial_inner_size`] 按工作区收敛。
const DEFAULT_WIDTH: f64 = 1200.0;
const DEFAULT_HEIGHT: f64 = 780.0;

/// 最小窗口尺寸，同时作为工作区钳制的下限（低于此值布局会塌）。
const MIN_WIDTH: f64 = 960.0;
const MIN_HEIGHT: f64 = 600.0;

/// 初始窗口相对屏幕工作区的最大占比。
///
/// 留出边距，让用户一眼看出这是窗口而不是全屏应用；也避免在 1366x768 这类
/// 小屏上一开就贴满工作区（此时 780 的高度本身已经超过 768 的可用高度）。
const MAX_WORK_AREA_RATIO: f64 = 0.88;

/// 计算初始窗口内尺寸（逻辑像素）。
///
/// 对齐 Electron 版 `Math.min(1440, workAreaSize.width)` 的钳制语义——
/// 缺了这一步，小屏或缩放 150% 的高分屏上窗口会超出可用工作区，标题栏被推到
/// 屏幕外。两处差异：基准尺寸更小，且按占比而非硬上限收敛。
///
/// 取不到显示器信息时（多显示器热插拔、远程桌面会话初始化中）退回默认值，
/// 由 `min_inner_size` 与 `center()` 兜底。
fn initial_inner_size(app: &AppHandle) -> (f64, f64) {
    // work_area 是物理像素，必须按 scale_factor 折算回逻辑像素再参与计算
    // ——builder 的 inner_size 收的是逻辑像素。
    let work_area = app.primary_monitor().ok().flatten().map(|m| {
        let area = m.work_area().size.to_logical::<f64>(m.scale_factor());
        (area.width, area.height)
    });
    clamp_to_work_area(work_area)
}

/// [`initial_inner_size`] 的纯计算部分（抽出来以便单测；真实显示器在 CI 无法构造）。
///
/// `work_area` 为工作区的逻辑宽高；`None` 表示取不到显示器信息。
fn clamp_to_work_area(work_area: Option<(f64, f64)>) -> (f64, f64) {
    let (mut w, mut h) = (DEFAULT_WIDTH, DEFAULT_HEIGHT);

    if let Some((aw, ah)) = work_area {
        if aw > 0.0 && ah > 0.0 {
            w = w.min(aw * MAX_WORK_AREA_RATIO);
            h = h.min(ah * MAX_WORK_AREA_RATIO);
        }
    }

    // 钳制结果不得低于最小尺寸，否则与 min_inner_size 冲突（系统会强行拉回，
    // 反而在极小屏上溢出工作区）。
    (w.max(MIN_WIDTH), h.max(MIN_HEIGHT))
}

/// 判断 URL 是否为本应用内部地址（本地 UI 服务器 / Tauri 自定义协议）。
fn is_internal_url(url: &Url) -> bool {
    match url.scheme() {
        // Tauri 生产环境自定义协议与本地资源
        "tauri" | "asset" | "ipc" => true,
        "http" | "https" => {
            let host = url.host_str().unwrap_or_default();
            let is_loopback = host == "localhost"
                || host == "127.0.0.1"
                || host == "::1"
                || host == "[::1]";
            if !is_loopback {
                return false;
            }
            // 仅放行本地 UI 端口，避免误入后端调试页等其它本地服务
            match url.port() {
                Some(port) => port == current_ui_port(),
                // devUrl / 未显式端口时按内部处理
                None => true,
            }
        }
        // about:blank / data: 等页面内部导航
        "about" | "data" | "blob" => true,
        _ => false,
    }
}

/// 当前 UI 端口（从全局状态读取，读取失败回退 0 表示不限制）。
fn current_ui_port() -> u16 {
    // 该函数在事件回调中使用，无法直接拿到 AppHandle，
    // 因此通过原子变量缓存端口，创建窗口时写入。
    UI_PORT_CACHE.load(Ordering::Relaxed)
}

/// UI 端口缓存。
///
/// 使用 `AtomicU16` 而非 `OnceLock`：服务器首次启动失败时会写入 0，
/// `OnceLock::set` 只在首次生效，会导致后续重试永远无法更新端口，
/// 进而使 `is_internal_url` 把所有本地地址误判为外部、全部抛给系统浏览器。
static UI_PORT_CACHE: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);

/// 用系统浏览器打开外部链接。
fn open_external(url: &Url) {
    let s = url.to_string();
    // 优先使用 opener 插件未配置时的系统默认方式
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // rundll32 为控制台子系统程序，需 CREATE_NO_WINDOW 避免开外链时闪黑窗
        let _ = std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &s])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(&s).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("xdg-open").arg(&s).spawn();
    }
}

/// 创建主窗口。
///
/// 调用时机：`setup` 钩子内、本地 UI 服务器启动成功并写入 `AppState.ui_port` 之后。
pub fn create_main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    // 读取 UI 端口并缓存，供导航/新窗口拦截闭包使用
    let ui_port = {
        let state = app.state::<AppState>();
        state.ui_port.lock().map(|p| *p).unwrap_or(0)
    };
    let _ = UI_PORT_CACHE.store(ui_port, Ordering::Relaxed);

    // 目标 URL：本地 UI 服务器；端口为 0（服务器启动失败）时回退 Tauri 默认前端
    let url = if ui_port > 0 {
        WebviewUrl::External(
            format!("http://localhost:{}", ui_port)
                .parse()
                .expect("invalid ui url"),
        )
    } else {
        warn!("UI 端口未就绪，回退到内置前端资源");
        WebviewUrl::App("index.html".into())
    };

    let (win_w, win_h) = initial_inner_size(app);

    #[allow(unused_mut)]
    let mut builder = tauri::WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, url)
        // 注入 window.__GOURD_IPC__ 桥接层（document-start 时机）。
        // 前端 5 个文件 26 处依赖该对象，缺失则后端就绪门闸、窗口标题、
        // 自动更新面板、主题与遮罩联动全部退化。
        .initialization_script(&crate::ipc_bridge::init_script())
        // 注入自绘标题栏（窗口控件层）。必须排在桥接层之后：
        // 标题栏脚本依赖 __TAURI_INTERNALS__ 与桥接层约定的事件通道。
        .initialization_script(&crate::titlebar_ui::init_script())
        .title(MAIN_WINDOW_TITLE)
        .inner_size(win_w, win_h)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .visible(false)
        .center()
        .resizable(true)
        .maximizable(true)
        .minimizable(true)
        .closable(true)
        .fullscreen(false);

    // ── 窗口装饰策略（详见 titlebar_ui.rs 模块文档）──
    //
    // Windows / Linux：彻底关掉系统装饰，控件由前端自绘。
    //   tao 没有 Windows 的 WCO（Window Controls Overlay）等价能力，若保留
    //   decorations 就会「原生标题栏 + 前端 36px 拖拽条」上下并存。
    //
    //   shadow(true) 的取舍：tauri#12285 / #13134 记录了 decorations=false + shadow=true
    //   时 Windows 下左右下边缘各有 1px 边框、顶部没有的不对称问题。但关掉阴影会让窗口
    //   在浅色桌面上完全失去边界感（尤其 light 主题白底），两害相权取其轻——保留阴影。
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.decorations(false).shadow(true);
    }

    // macOS：保留系统装饰，只把标题栏变成透明叠加层，红绿灯继续由 AppKit 绘制。
    //   等价于 Electron 的 `titleBarStyle: 'hidden'`，迁移零观感回归。
    //   注意：Tauri v2 的 TitleBarStyle 只有 Visible / Transparent / Overlay 三个值，
    //   **没有 Hidden**（此处曾误写为 Hidden，macOS 编译必然 E0599）。
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .decorations(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }

    let app_handle = app.clone();

    let window = builder
        // 外链拦截：target=_blank / window.open → 系统浏览器，不在应用内开新窗
        .on_new_window(|url, _features| {
            if is_internal_url(&url) {
                NewWindowResponse::Allow
            } else {
                info!("外链交给系统浏览器: {}", url);
                open_external(&url);
                NewWindowResponse::Deny
            }
        })
        // 主窗口导航拦截：跳转到外部地址时取消并交给系统浏览器
        .on_navigation(|url| {
            if is_internal_url(url) {
                true
            } else {
                info!("拦截主窗口外部导航: {}", url);
                open_external(url);
                false
            }
        })
        // 页面标题变化时锁定窗口标题，防止 document.title 覆盖
        // （前端主动调 set_window_title 后，以其设定值为准）
        .on_document_title_changed(move |_webview, _title| {
            if let Some(win) = app_handle.get_webview_window(MAIN_WINDOW_LABEL) {
                let want = expected_title();
                if let Ok(current) = win.title() {
                    if current != want {
                        let _ = win.set_title(&want);
                    }
                }
            }
        })
        // 页面加载事件：
        // - Started ：对齐 Electron 的 did-start-loading——页面重载后渲染层遮罩探测状态归零，
        //             主进程必须同步复位，否则 mac 红绿灯一直隐藏、Win 按钮区一直发暗。
        // - Finished：对齐 Electron 的 ready-to-show——加载完成再显示窗口，避免白屏闪烁。
        //
        // 注意：`on_page_load` 是 **builder 的链式方法**，必须在 `.build()` 之前调用；
        // `WebviewWindow` 实例上没有这个方法。
        .on_page_load(|win, payload| match payload.event() {
            PageLoadEvent::Started => {
                crate::titlebar::reset_window_scrim(&win);
            }
            PageLoadEvent::Finished => {
                let _ = win.show();
                let _ = win.set_focus();
                // 补推一次后端状态：启动瞬间就失败的场合（如内置 JRE 缺失），
                // backend-failed 会早于 document-start 而被 eval 静默丢弃，
                // 这里按当前真实状态再发一次，前端才能拿到完整错误原因。
                crate::backend::push_state_to_window(&win.app_handle());
            }
        })
        .build()?;

    // 登记初始装饰状态（对应 Electron 版 initWindowChrome）。
    // 初值取 dark：前端 app.js 在 DOMContentLoaded 后会按用户偏好回推真实主题
    // （ipc_bridge 的 syncTheme → set_window_theme），此处只保证状态表有基线。
    crate::titlebar::init_window_chrome(&window, "dark");

    // 兜底：若页面从未触发 page_load（极少见），后端 ready 后也显示窗口
    let app_for_fallback = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app_for_fallback.state::<AppState>();
        let mut rx = state.backend_ready.subscribe();
        // 最多等 15s，避免后端异常时窗口永远不显示
        let timeout = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            let _ = rx.changed().await;
        });
        let _ = timeout.await;
        if let Some(win) = app_for_fallback.get_webview_window(MAIN_WINDOW_LABEL) {
            if !win.is_visible().unwrap_or(true) {
                let _ = win.show();
            }
        }
        // 引用 is_quitting 以避免未使用告警（状态一致性检查）
        let _ = state.is_quitting.load(Ordering::Relaxed);
    });

    info!(
        "主窗口创建完成 ({}x{}, min {}x{}, ui_port={})",
        win_w, win_h, MIN_WIDTH, MIN_HEIGHT, ui_port
    );

    Ok(window)
}

/// 设置窗口标题（等价 Electron 的 `window-title-update` 通道）。
///
/// Code 模式据此显示当前项目名。注意与 `on_document_title_changed` 的锁定逻辑
/// 区分：那里拦截的是页面 `document.title` 的自动覆盖，此处是前端主动设置。
#[tauri::command]
pub fn set_window_title(app: AppHandle, title: String) {
    if let Some(win) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let t = title.trim();
        let target = if t.is_empty() { MAIN_WINDOW_TITLE } else { t };
        let _ = win.set_title(target);
        // 允许前端设定的标题生效，同步放开锁定基准
        let _ = ALLOW_TITLE.set(());
        if let Ok(mut guard) = CUSTOM_TITLE.lock() {
            *guard = Some(target.to_string());
        }
    }
}

/// 前端是否已主动设置过标题（设置后不再强制回写 "GWork"）
static ALLOW_TITLE: std::sync::OnceLock<()> = std::sync::OnceLock::new();
/// 前端设定的当前标题
static CUSTOM_TITLE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// 期望的窗口标题：前端设过则用它，否则锁定为 "GWork"。
fn expected_title() -> String {
    if ALLOW_TITLE.get().is_some() {
        if let Ok(guard) = CUSTOM_TITLE.lock() {
            if let Some(t) = guard.as_ref() {
                return t.clone();
            }
        }
    }
    MAIN_WINDOW_TITLE.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 大屏：工作区宽裕时直接用默认尺寸，不被占比拉大。
    #[test]
    fn uses_default_on_large_screen() {
        // 2560x1440 工作区：0.88 占比远大于默认值，min 取默认
        assert_eq!(
            clamp_to_work_area(Some((2560.0, 1400.0))),
            (DEFAULT_WIDTH, DEFAULT_HEIGHT)
        );
    }

    /// 小屏：必须按工作区收敛，不得溢出（这正是 Electron 版 Math.min 的语义）。
    ///
    /// 1366x768 是典型舍弃场景：默认高 780 > 可用高 728，不钳制就会把标题栏顶出屏外。
    #[test]
    fn clamps_on_small_screen() {
        let (w, h) = clamp_to_work_area(Some((1366.0, 728.0)));
        assert!(w <= 1366.0 * MAX_WORK_AREA_RATIO + f64::EPSILON, "w={}", w);
        assert!(h < DEFAULT_HEIGHT, "小屏高度未被收敛: {}", h);
        assert!(h <= 728.0, "窗口高度溢出工作区: {}", h);
    }

    /// 钳制不得穿透最小尺寸，否则与 min_inner_size 相互打架。
    #[test]
    fn never_below_minimum() {
        let (w, h) = clamp_to_work_area(Some((800.0, 500.0)));
        assert_eq!((w, h), (MIN_WIDTH, MIN_HEIGHT));
    }

    /// 取不到显示器信息时退回默认值（不 panic、不取 0）。
    #[test]
    fn falls_back_without_monitor() {
        assert_eq!(clamp_to_work_area(None), (DEFAULT_WIDTH, DEFAULT_HEIGHT));
        // 异常尺寸（远程桌面会话初始化中可能报 0）同样走默认
        assert_eq!(clamp_to_work_area(Some((0.0, 0.0))), (DEFAULT_WIDTH, DEFAULT_HEIGHT));
    }
}
