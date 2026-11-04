//! tray.rs —— 系统托盘（应用常驻的唯一入口）。
//!
//! ## 为什么这个文件必须存在
//!
//! 本壳的内核是**进程内**的（`lib.rs` 的 `tauri::async_runtime::spawn(serve(...))`），
//! 所以「进程活着」与「任务还在跑」是同一件事。Tauri 的默认行为是最后一个窗口销毁
//! 即退出应用 —— 用户点一下关闭按钮，正在跑的 ReAct 任务、后台 bash、远端 SSH 会话
//! 全部随进程蒸发。托盘 + `CloseRequested` 拦截把「关窗口」降级为「藏窗口」，
//! 进程与内核因此得以存活。
//!
//! 移植自 gourd-ai-tauri（Java 壳）的同名模块，行为逐项对齐：
//! - 托盘图标：打包后从 `<resource_dir>/icons/icon.ico | icon.png` 加载，
//!   开发期回退内嵌默认图标，最终兜底 1x1 透明 PNG（保证托盘一定建得出来）。
//! - 菜单：显示窗口 / 退出。
//! - 左键单击托盘图标切换主窗口显隐（菜单走右键）。
//! - 「退出」置位 `AppState.is_quitting = true` 再 `app.exit(0)`，
//!   使 `lib.rs` 的 `CloseRequested` / `ExitRequested` 不再拦截、真正退出。
//!
//! ## is_quitting 是这套机制的承重墙
//!
//! 没有它，`prevent_close()` 会把「退出」也一并拦掉 —— 应用将**永远关不掉**，
//! 用户只能在任务管理器里强杀（而强杀会跳过 `RunEvent::Exit` 的
//! `remote::shutdown_all()`，把远端 java 进程留成孤儿）。所以「退出」的唯一
//! 正确路径是：先置位，再 exit。任何新增的退出入口都必须走 `request_quit()`。
//!
//! ## 菜单文案未做 i18n（与 Java 壳同口径）
//!
//! 原生托盘菜单在 Rust 侧构建，拿不到前端的 12 语言包；`titlebar_ui.rs` 的
//! `labels()` 之所以能双语，是因为它跑在页面里、能读 `navigator.language`。
//! 这里保持与 Java 壳一致的中文硬编码，不引入第二套语言探测逻辑。

use std::sync::atomic::Ordering;

use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};
use tracing::{info, warn};

use crate::ipc_bridge::{MAIN_WINDOW_LABEL, MAIN_WINDOW_TITLE};
use crate::AppState;

/// 托盘图标 ID。固定值，便于将来用 `app.tray_by_id()` 取回并更新 tooltip。
const TRAY_ID: &str = "gwork-tray";

/// 菜单项 ID：显示窗口
const MENU_SHOW: &str = "tray-show";
/// 菜单项 ID：退出
const MENU_QUIT: &str = "tray-quit";

/// 请求真正退出应用。
///
/// **所有退出入口都必须走这里**，不能直接 `app.exit(0)`：`lib.rs` 的
/// `ExitRequested` 分支靠 `is_quitting` 判断该不该拦，漏了置位就会被自己
/// 的拦截逻辑挡住，表现为「点退出没反应」。
pub fn request_quit(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state.is_quitting.store(true, Ordering::SeqCst);
    } else {
        // 状态未注册（理论上只在 setup 之前发生）：仍然尝试退出，
        // 但此时 ExitRequested 会因读不到 is_quitting 而被拦，故记警告。
        warn!("AppState 未注册，退出请求可能被 ExitRequested 拦截");
    }
    app.exit(0);
}

/// 显示并聚焦主窗口。
fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        // 顺序有意义：先 unminimize 再 show。窗口若处于「最小化 + 隐藏」
        // 双状态（用户先最小化、再从托盘藏起来），只 show 会得到一个
        // 仍在任务栏里缩着的窗口，看起来像「点了没反应」。
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// 切换主窗口显隐（左键单击托盘图标）。
fn toggle_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        // is_visible() 失败时按「不可见」处理：宁可多显示一次，
        // 也不能让用户点了图标却什么都看不到。
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
/// - 找不到或开发期：回退应用默认窗口图标 / 内嵌字节，保证托盘一定能建出来。
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
                        // （Cargo.toml 的 image-png + image-ico 两个 feature 就是为此开的）
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
///
/// 在 `lib.rs` 的 setup 中调用。失败只记日志、不中断启动：没有托盘时应用退化为
/// 「关窗口即退出」（即修复前的行为），仍可用；反之若因托盘建不出来就拒绝启动，
/// 会把一个纯装饰性故障升级成完全打不开。
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

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip(MAIN_WINDOW_TITLE)
        // 左键交给下面的点击事件做「切换显隐」，不弹菜单（菜单走右键）
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            MENU_SHOW => show_main_window(app),
            MENU_QUIT => {
                info!("托盘菜单退出");
                request_quit(app);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 单击左键松开时切换窗口显隐。
            // 取 Up 而非 Down：与 Windows 原生托盘一致，按下后拖出图标区
            // 再松手不应触发（Down 会误触）。
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

#[cfg(test)]
mod tests {
    //! 源码级契约护栏。
    //!
    //! 托盘与退出拦截的行为都发生在 GUI 事件循环里，单元测试无法真正建窗口/点图标，
    //! 所以这里钉的是**源码结构**：这套机制由四处协同构成（托盘模块、CloseRequested
    //! 拦截、ExitRequested 拦截、is_quitting 标志），历史上正是「只移植了注释、
    //! 没移植实现」导致整块缺失（titlebar_ui.rs 曾长期留着一段指向不存在的
    //! main.rs 托盘语义的假注释）。任何一处被回退，本测试即变红。

    use super::*;

    /// 读取 src-tauri/src 下的源文件。
    fn src(name: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join(name);
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("读取 {} 失败: {}", path.display(), e))
    }

    /// 去掉行注释后再断言，避免「注释里提到就算通过」的假绿灯。
    /// 这正是本缺陷的成因形态：注释声称有托盘语义，实现却不存在。
    fn code_only(source: &str) -> String {
        source
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// 截取两个标记之间的源码区段（含 start，不含 end）。
    ///
    /// 为什么需要它：全文 `contains` / `count` 无法回答「某个词是不是出现在
    /// 正确的那个分支里」。变异验证实测过这个漏洞：把 ExitRequested 分支的
    /// is_quitting 门控整个拆掉后，全文 is_quitting 仍出现 3 次（字段声明 +
    /// 初始化 + CloseRequested 判定），计数断言照样绿 —— 而行为已经错成
    /// 「应用永远关不掉」。区段断言把检查范围钉死在目标 match 臂内，
    /// 拆门控即变红。
    fn arm<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
        let s = source
            .find(start)
            .unwrap_or_else(|| panic!("未找到区段起点标记: {}", start));
        let rest = &source[s..];
        let e = rest
            .find(end)
            .unwrap_or_else(|| panic!("未找到区段终点标记: {}（起点 {} 之后）", end, start));
        &rest[..e]
    }

    #[test]
    fn tray_module_is_declared_and_built() {
        let lib = code_only(&src("lib.rs"));
        assert!(
            lib.contains("mod tray;"),
            "lib.rs 必须声明 mod tray;，否则托盘模块根本不参与编译"
        );
        assert!(
            lib.contains("tray::create_tray"),
            "lib.rs 的 setup 必须调用 tray::create_tray，否则托盘不会被创建"
        );
    }

    #[test]
    fn close_requested_hides_instead_of_closing() {
        let lib = code_only(&src("lib.rs"));
        assert!(
            lib.contains("WindowEvent::CloseRequested"),
            "lib.rs 必须处理 CloseRequested：缺了它，点关闭会直接销毁窗口并退出应用"
        );
        assert!(
            lib.contains("prevent_close()"),
            "CloseRequested 分支必须调用 api.prevent_close()，否则窗口仍会被销毁"
        );
        assert!(
            lib.contains(".hide()"),
            "CloseRequested 分支必须 hide() 窗口，实现「关窗口=收进托盘」"
        );
    }

    #[test]
    fn exit_requested_is_intercepted() {
        let lib = code_only(&src("lib.rs"));
        assert!(
            lib.contains("RunEvent::ExitRequested"),
            "lib.rs 的 run 回调必须处理 ExitRequested（第二道防线：macOS 红绿灯、\
             以及窗口全部销毁后的默认退出都走这条路）"
        );
        assert!(
            lib.contains("prevent_exit()"),
            "ExitRequested 分支必须调用 api.prevent_exit()，否则拦截无效"
        );
    }

    #[test]
    fn both_intercepts_are_gated_by_is_quitting() {
        let lib = code_only(&src("lib.rs"));
        // 两处拦截都必须**在自己的分支内**读 is_quitting：不读就等于「永远拦」，
        // 托盘菜单的「退出」会失效，应用再也关不掉。
        //
        // 用区段断言而非全文计数：计数无法区分「is_quitting 出现在哪个分支」，
        // 拆掉 ExitRequested 的门控后全文仍有 3 次（字段声明 + 初始化 +
        // CloseRequested 判定），计数照样绿 —— 变异验证 M5 实测过这个漏洞。
        let close_arm = arm(&lib, "WindowEvent::CloseRequested", "WindowEvent::Resized");
        assert!(
            close_arm.contains("is_quitting"),
            "CloseRequested 分支内必须读 is_quitting，否则用户点托盘「退出」后\
             关窗口仍被拦，窗口销毁不掉"
        );
        assert!(
            close_arm.contains("prevent_close()") && close_arm.contains(".hide()"),
            "CloseRequested 分支内必须同时 prevent_close() + hide()"
        );

        // ExitRequested 臂：起点 ExitRequested，终点用带箭头的 `RunEvent::Exit =>`
        // （不会误匹配 ExitRequested 自身，因其后跟的是 `Requested` 而非 ` =>`）。
        let exit_arm = arm(&lib, "RunEvent::ExitRequested", "RunEvent::Exit =>");
        assert!(
            exit_arm.contains("is_quitting"),
            "ExitRequested 分支内必须读 is_quitting：不读就等于无条件 prevent_exit，\
             托盘「退出」置了标志也照样被拦，应用永远关不掉（变异 M5 守的就是这条）"
        );
        assert!(
            exit_arm.contains("prevent_exit()"),
            "ExitRequested 分支内必须调用 prevent_exit()"
        );
    }

    #[test]
    fn app_state_declares_is_quitting() {
        let lib = code_only(&src("lib.rs"));
        assert!(
            lib.contains("pub is_quitting:"),
            "AppState 必须声明 pub is_quitting 字段，托盘与两处拦截靠它区分\
             「关窗口」与「真退出」"
        );
    }

    #[test]
    fn quit_path_sets_flag_before_exiting() {
        let tray = code_only(&src("tray.rs"));
        let store_at = tray
            .find("is_quitting.store(true")
            .expect("tray.rs 必须置位 is_quitting");
        let exit_at = tray.find("app.exit(0)").expect("tray.rs 必须调用 app.exit(0)");
        assert!(
            store_at < exit_at,
            "必须先置位 is_quitting 再 app.exit(0)：顺序颠倒会让 ExitRequested \
             读到 false 而拦下退出，表现为「点退出没反应」"
        );
    }

    #[test]
    fn tray_menu_offers_show_and_quit() {
        let tray = code_only(&src("tray.rs"));
        // 断言**字面量**而非常量：用 `tray.contains(MENU_QUIT)` 时，若常量值被
        // 改空，`contains("")` 恒真，断言会跟着失效（变异 M8 实测过）。
        // 直接钉死常量定义行的字面量值 + with_id 引用，改空即变红。
        assert!(
            tray.contains("const MENU_SHOW: &str = \"tray-show\";"),
            "MENU_SHOW 常量必须定义为 \"tray-show\"（不得为空，否则菜单项 ID 失效）"
        );
        assert!(
            tray.contains("const MENU_QUIT: &str = \"tray-quit\";"),
            "MENU_QUIT 常量必须定义为 \"tray-quit\"（不得为空，否则「退出」项失效）"
        );
        // 两个 ID 都必须真正被 with_id 用于构建菜单项，而不只是定义了常量。
        assert!(
            tray.contains("MenuItemBuilder::with_id(MENU_SHOW"),
            "「显示窗口」必须经 MenuItemBuilder::with_id(MENU_SHOW) 构建"
        );
        assert!(
            tray.contains("MenuItemBuilder::with_id(MENU_QUIT"),
            "「退出」必须经 MenuItemBuilder::with_id(MENU_QUIT) 构建"
        );
        assert!(
            tray.contains("show_menu_on_left_click(false)"),
            "左键必须留给「切换显隐」，菜单走右键；不设 false 会与 \
             on_tray_icon_event 的左键处理互相打架"
        );
    }

    #[test]
    fn single_instance_is_registered() {
        // 托盘常驻后，用户会以为「应用关了」而再点一次桌面图标。没有单实例锁就会
        // 起第二个进程：find_available_port() 给它一个新端口，于是两个内核同时
        // 读写同一个 ~/.gwork（settings.json / 会话文件）→ 数据竞争 + 两个托盘图标。
        let lib = code_only(&src("lib.rs"));
        assert!(
            lib.contains("tauri_plugin_single_instance::init"),
            "lib.rs 必须注册 single_instance 插件，否则托盘常驻后重复启动会产生\
             第二个内核实例"
        );
        let manifest = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"),
        )
        .expect("读取 Cargo.toml 失败");
        assert!(
            manifest.contains("tauri-plugin-single-instance"),
            "Cargo.toml 必须声明 tauri-plugin-single-instance 依赖"
        );
    }

    #[test]
    fn tray_icon_feature_is_enabled() {
        let manifest = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"),
        )
        .expect("读取 Cargo.toml 失败");
        // 三个 feature 缺一不可：tray-icon 提供 API，image-png/image-ico 让
        // Image::from_bytes 能解码兜底图标（否则运行期 panic 在 expect 上）。
        for f in ["tray-icon", "image-png", "image-ico"] {
            assert!(
                manifest.contains(&format!("\"{}\"", f)),
                "Cargo.toml 的 tauri features 必须包含 {}，托盘图标解码依赖它",
                f
            );
        }
    }

    #[test]
    fn window_title_has_single_source_of_truth() {
        // 托盘 tooltip、窗口标题、set_window_title 兜底三处共用一个常量。
        // 曾是三个独立的 "GWork" 字面量，改产品名会漏掉托盘。
        assert_eq!(MAIN_WINDOW_TITLE, "GWork");
        let bridge = src("ipc_bridge.rs");
        assert!(
            bridge.contains("pub const MAIN_WINDOW_TITLE"),
            "MAIN_WINDOW_TITLE 必须定义在 ipc_bridge.rs（与 MAIN_WINDOW_LABEL 同处）"
        );
        let commands = code_only(&src("commands.rs"));
        assert!(
            commands.contains("MAIN_WINDOW_TITLE"),
            "commands.rs 的 set_window_title 兜底必须用常量而非字面量"
        );
    }

    #[test]
    fn titlebar_comment_does_not_claim_nonexistent_semantics() {
        // 回归护栏：titlebar_ui.rs 曾长期留着一段假注释，声称 window_close 走
        // close() 是为了「复用 main.rs 中 CloseRequested 的既有语义（隐藏到托盘）」，
        // 而本壳的 main.rs 只有 6 行、根本没有该语义 —— 注释把缺失的功能描述成
        // 已存在，直接误导排查。现在语义确实落在 lib.rs，注释必须指向 lib.rs。
        //
        // 断言故意比「不得声称不存在的语义」更严：本壳的 main.rs 与窗口语义
        // 完全无关（只调 run()），所以 titlebar_ui.rs 里出现 "main.rs" 本身就是
        // 漂移信号 —— 连「复述错误原文」也不允许，否则护栏会被自己的教训注释触发。
        let titlebar = src("titlebar_ui.rs");
        assert!(
            !titlebar.contains("main.rs"),
            "titlebar_ui.rs 不得引用 main.rs：本壳 main.rs 只调用 run()，与窗口语义\
             无关；CloseRequested 拦截在 lib.rs（连复述错误原文也不允许）"
        );
        assert!(
            titlebar.contains("lib.rs"),
            "titlebar_ui.rs 的 window_close 注释必须指向 lib.rs（拦截逻辑真实所在）"
        );
    }
}
