//! 系统托盘。
//!
//! 对齐原 Electron 版行为：
//! - 托盘图标（打包后从 `<resource_dir>/icons/icon.ico | icon.png` 加载，开发期回退内嵌默认图标）。
//! - 菜单：显示窗口 / 退出。
//! - 单击托盘图标（左键）切换主窗口显隐。
//! - 退出时置位 `AppState.is_quitting = true` 并 `app.exit(0)`，
//!   使 `main.rs` 的 `CloseRequested` / `ExitRequested` 不再拦截、真正退出。

use std::sync::atomic::Ordering;

use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};
use tracing::{info, warn};

use crate::window::{MAIN_WINDOW_LABEL, MAIN_WINDOW_TITLE};
use crate::AppState;

/// 菜单项 ID：显示窗口
const MENU_SHOW: &str = "tray-show";
/// 菜单项 ID：退出
const MENU_QUIT: &str = "tray-quit";

/// 显示并聚焦主窗口。
fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// 切换主窗口显隐。
fn toggle_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let visible = win.is_visible().unwrap_or(false);
        if visible {
            let _ = win.hide();
        } else {
            show_main_window(app);
        }
    }
}

/// 加载托盘图标：
/// - 打包后：优先 `<resource_dir>/icons/icon.ico`（Windows）/ `icon.png`；
/// - 找不到或开发期：回退到应用默认窗口图标 / 内嵌字节，保证托盘一定能建出来。
fn load_tray_icon(app: &AppHandle) -> Option<Image<'static>> {
    // 1) 打包资源目录下的图标文件
    if let Ok(res) = app.path().resource_dir() {
        let candidates = [
            res.join("icons").join("icon.ico"),
            res.join("icons").join("icon.png"),
        ];
        for path in &candidates {
            if path.exists() {
                match std::fs::read(path) {
                    Ok(bytes) => {
                        // Image::from_bytes 自动识别 PNG / ICO
                        return Some(Image::from_bytes(&bytes).unwrap_or_else(|e| {
                            warn!("托盘图标解析失败 {}: {}", path.display(), e);
                            default_icon(app)
                        }));
                    }
                    Err(e) => warn!("读取托盘图标失败 {}: {}", path.display(), e),
                }
            }
        }
    }
    // 2) 应用默认图标（tauri.conf.json bundle.icon 生成的运行时图标）
    Some(default_icon(app))
}

/// 回退图标：应用默认窗口图标，仍不可得时返回一个 1x1 透明 PNG，保证托盘创建成功。
fn default_icon(app: &AppHandle) -> Image<'static> {
    if let Some(icon) = app.default_window_icon() {
        // `default_window_icon()` 借用自 app，生命周期非 'static；
        // `to_owned()` 复制底层像素数据，得到独立于 app 的 Image<'static>。
        return icon.clone().to_owned();
    }
    // 1x1 透明 PNG，最终兜底，避免 create_tray 失败（运行期解码，无需在编译期嵌入文件）
    const BLANK_PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x62, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    Image::from_bytes(BLANK_PNG).expect("fallback tray icon")
}

/// 创建系统托盘。
pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    // 菜单：显示窗口 / 退出
    let show_item = MenuItemBuilder::with_id(MENU_SHOW, "显示窗口").build(app)?;
    let quit_item = MenuItemBuilder::with_id(MENU_QUIT, "退出").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&show_item)
        .separator()
        .item(&quit_item)
        .build()?;

    let icon = load_tray_icon(app);

    let mut builder = TrayIconBuilder::with_id("gwork-tray")
        .menu(&menu)
        .tooltip(MAIN_WINDOW_TITLE)
        // 左键交给我们的点击事件做「切换显隐」，不弹菜单（菜单走右键）
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            MENU_SHOW => show_main_window(app),
            MENU_QUIT => {
                info!("托盘菜单退出");
                let state = app.state::<AppState>();
                state.is_quitting.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 单击左键松开时切换窗口显隐
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = icon {
        builder = builder.icon(icon);
    }

    builder.build(app)?;

    info!("系统托盘创建完成");
    Ok(())
}
