//! 原生窗口装饰与网页全屏遮罩（scrim）的联动。
//!
//! ## 现状（三平台自绘标题栏改造后）
//!
//! 本模块原本是为「系统绘制的窗口按钮压在 web 内容之上、遮罩盖不住」这个顽疾
//! 而存在的。改造后该问题在各平台的性质已经分化：
//!
//! - **Windows / Linux**：窗口已改为 `decorations(false)`，窗口按钮由
//!   `titlebar_ui.rs` 注入的 DOM 绘制。DOM 天然可被遮罩覆盖，压暗逻辑改由前端
//!   的同色蒙版承担（见 titlebar_ui.rs 模块文档）。**本模块的 DWM 着色对无边框
//!   窗口不再产生视觉效果**，保留调用只为：① 万一将来恢复系统装饰可直接复用；
//!   ② 调用本身对无边框窗口无副作用（DwmSetWindowAttribute 返回成功但不渲染）。
//!
//! - **macOS**：仍是 `TitleBarStyle::Overlay` + 原生红绿灯——那里确实没有 DOM
//!   可盖，因此下面的「遮罩期间隐藏红绿灯、遮罩关闭即恢复」仍是**唯一可行解**，
//!   也是本模块当前真正生效的部分。
//!
//! ## macOS 实现要点（沿用 Electron 版踩坑结论）
//!
//! 红绿灯没有着色 API，只能显隐（`standardWindowButton` + `setHidden`）。
//! 注意：不要改用 `setClosable`/`setMiniaturizable`/`setMaximizable` 来"置灰"
//! 红绿灯——在 hidden titleBarStyle 下切换 styleMask 会踩到 electron#38289
//! 类问题（还原后绿色缩放按钮无法正常显示）。
//!
//! 主题色映射与 web 端 theme.css 的 --bg-main 保持一致。
//! 注意：color 必须用不透明的实际标题栏背景色，而不能用透明色——
//! Windows 按 color 的亮度推导窗口按钮的 hover 底色：透明黑会被判为深色背景，
//! hover 给白色高亮，在亮色（白底）下白上白完全不可见。

use std::sync::{LazyLock, Mutex};

use tauri::{AppHandle, Manager, WebviewWindow};

/// 主题标题栏色板。字段：(标题栏底色, 按钮符号色)。
/// light: #ffffff / #1a1a2e；dark: #1a1b1e / #dcdde1。
const THEME_COLOR_LIGHT: (&str, &str) = ("#ffffff", "#1a1a2e");
const THEME_COLOR_DARK: (&str, &str) = ("#1a1b1e", "#dcdde1");

/// 渲染层没给出可解析颜色时的兜底遮罩色（应用内所有遮罩当前都是这个值）。
const DEFAULT_SCRIM: &str = "rgba(0, 0, 0, 0.5)";

/// 标题栏最多按该 alpha 变暗。图片灯箱一类遮罩是 rgba(0,0,0,0.85)，
/// 若等比压暗，窗口按钮会黑到看不见——按钮辨识度优先于像素级一致。
const MAX_SCRIM_ALPHA: f64 = 0.6;

/// 混色后按钮符号与底色的最小亮度差，低于此值改用黑/白强制拉开对比。
const MIN_SYMBOL_GAP: f64 = 0.2;

/// RGBA 颜色（r/g/b 为 0~255，a 为 0~1）。
#[derive(Debug, Clone, Copy, PartialEq)]
struct Color {
    r: f64,
    g: f64,
    b: f64,
    a: f64,
}

fn clamp(n: f64, min: f64, max: f64) -> f64 {
    if !n.is_finite() {
        return min;
    }
    if n < min {
        min
    } else if n > max {
        max
    } else {
        n
    }
}

/// 解析 CSS 颜色（仅支持 #rgb/#rgba/#rrggbb/#rrggbbaa 与 rgb()/rgba()，
/// 覆盖 getComputedStyle 的实际返回格式与本项目主题色写法）。
fn parse_color(input: &str) -> Option<Color> {
    let s = input.trim().to_lowercase();
    if s.is_empty() || s.len() > 64 {
        return None;
    }
    if s == "transparent" {
        return Some(Color { r: 0.0, g: 0.0, b: 0.0, a: 0.0 });
    }

    if let Some(h) = s.strip_prefix('#') {
        if !h.is_ascii() || !(h.len() == 3 || h.len() == 4 || h.len() == 6 || h.len() == 8) {
            return None;
        }
        let b = h.as_bytes();
        if !b.iter().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        let dup = |i: usize| -> Option<f64> {
            let t = core::str::from_utf8(&b[i..=i]).ok()?;
            let v = u8::from_str_radix(&t.repeat(2), 16).ok()?;
            Some(v as f64)
        };
        let pair = |i: usize| -> Option<f64> {
            let t = core::str::from_utf8(&b[i..i + 2]).ok()?;
            Some(u8::from_str_radix(t, 16).ok()? as f64)
        };
        if h.len() <= 4 {
            return Some(Color {
                r: dup(0)?,
                g: dup(1)?,
                b: dup(2)?,
                a: if h.len() == 4 { dup(3)? / 255.0 } else { 1.0 },
            });
        }
        return Some(Color {
            r: pair(0)?,
            g: pair(2)?,
            b: pair(4)?,
            a: if h.len() == 8 { pair(6)? / 255.0 } else { 1.0 },
        });
    }

    // rgb() / rgba()：允许以空白、逗号、斜杠分隔；分量支持百分数；alpha 支持百分数。
    let is_rgb_fn = s.starts_with("rgb(") || s.starts_with("rgba(");
    if is_rgb_fn && s.ends_with(')') {
        let open = s.find('(')?;
        let inner = &s[open + 1..s.len() - 1];
        let parts: Vec<&str> = inner
            .split(|c: char| c.is_whitespace() || c == ',' || c == '/')
            .filter(|p| !p.is_empty())
            .collect();
        if parts.len() < 3 {
            return None;
        }
        let num = |v: &str| -> Option<f64> {
            let f: f64 = v.trim_end_matches('%').parse().ok()?;
            if v.ends_with('%') {
                Some(f * 255.0 / 100.0)
            } else {
                Some(f)
            }
        };
        let r = num(parts[0])?;
        let g = num(parts[1])?;
        let b = num(parts[2])?;
        if !(r.is_finite() && g.is_finite() && b.is_finite()) {
            return None;
        }
        let mut a = 1.0_f64;
        if parts.len() >= 4 {
            let av: f64 = parts[3].trim_end_matches('%').parse().ok()?;
            if !av.is_finite() {
                return None;
            }
            a = if parts[3].ends_with('%') { av / 100.0 } else { av };
        }
        return Some(Color {
            r: clamp(r.round(), 0.0, 255.0),
            g: clamp(g.round(), 0.0, 255.0),
            b: clamp(b.round(), 0.0, 255.0),
            a: clamp(a, 0.0, 1.0),
        });
    }
    None
}

/// 感知亮度（0~1），用于兜底判断符号色与底色是否糊在一起。
fn luminance(c: Color) -> f64 {
    (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255.0
}

/// 把 base 压在 scrim 之下做 alpha 合成（source-over）。
fn blend_over(base: Color, scrim: Color, alpha: f64) -> Color {
    let a = clamp(alpha, 0.0, 1.0);
    Color {
        r: base.r * (1.0 - a) + scrim.r * a,
        g: base.g * (1.0 - a) + scrim.g * a,
        b: base.b * (1.0 - a) + scrim.b * a,
        a: 1.0,
    }
}

/// 归一化遮罩色：不可解析 / 全透明按"无遮罩"处理，其余截断到 MAX_SCRIM_ALPHA。
fn normalize_scrim(scrim: Option<&str>) -> Option<Color> {
    let raw = scrim?;
    let c = parse_color(raw).or_else(|| parse_color(DEFAULT_SCRIM))?;
    if c.a <= 0.02 {
        return None;
    }
    Some(Color { r: c.r, g: c.g, b: c.b, a: clamp(c.a, 0.0, MAX_SCRIM_ALPHA) })
}

fn normalize_theme(theme: &str) -> &str {
    match theme {
        "light" => "light",
        _ => "dark",
    }
}

fn theme_palette(theme: &str) -> (&'static str, &'static str) {
    match theme {
        "light" => THEME_COLOR_LIGHT,
        _ => THEME_COLOR_DARK,
    }
}

/// 窗口装饰最终应呈现的颜色对（底色 + 符号色）。
#[derive(Debug, Clone, Copy, PartialEq)]
struct OverlayColors {
    color: Color,
    symbol: Color,
}

/// 计算标题栏应该用的颜色：无遮罩→主题原色；有遮罩→与遮罩混合后的暗色。
fn resolve_overlay_colors(theme: &str, scrim: Option<Color>) -> OverlayColors {
    let (base_color, base_symbol) = theme_palette(theme);
    let base_color =
        parse_color(base_color).unwrap_or(Color { r: 26.0, g: 27.0, b: 30.0, a: 1.0 });
    let base_symbol =
        parse_color(base_symbol).unwrap_or(Color { r: 220.0, g: 221.0, b: 225.0, a: 1.0 });

    let s = match scrim {
        Some(s) => s,
        None => return OverlayColors { color: base_color, symbol: base_symbol },
    };

    let bg = blend_over(base_color, s, s.a);
    let mut symbol = blend_over(base_symbol, s, s.a);
    // 兜底：遮罩很深或主题对比本就不足时，符号会糊进底色，强制拉回可辨识
    if (luminance(symbol) - luminance(bg)).abs() < MIN_SYMBOL_GAP {
        symbol = if luminance(bg) > 0.5 {
            Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 }
        } else {
            Color { r: 255.0, g: 255.0, b: 255.0, a: 1.0 }
        };
    }
    OverlayColors { color: bg, symbol }
}

/// 每个窗口的装饰状态。对应 Electron 版 chromeState（WeakMap<win, state>）：
/// 窗口销毁时由 `reset_window_scrim` 负责清出，避免泄漏。
#[derive(Debug, Clone, PartialEq)]
struct ChromeState {
    theme: String,
    scrim: Option<Color>,
    /// 已实际应用到原生层的颜色对（用于跳过重复设置）。
    applied: Option<OverlayColors>,
    /// macOS：红绿灯当前是否处于隐藏态。
    buttons_hidden: bool,
}

impl Default for ChromeState {
    fn default() -> Self {
        Self {
            theme: "dark".to_string(),
            scrim: None,
            applied: None,
            buttons_hidden: false,
        }
    }
}

static CHROME_STATES: LazyLock<Mutex<std::collections::HashMap<String, ChromeState>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

fn read_state(label: &str) -> ChromeState {
    CHROME_STATES
        .lock()
        .map(|m| m.get(label).cloned().unwrap_or_default())
        .unwrap_or_default()
}

fn write_state(label: &str, state: ChromeState) {
    if let Ok(mut m) = CHROME_STATES.lock() {
        m.insert(label.to_string(), state);
    }
}

fn remove_state(label: &str) {
    if let Ok(mut m) = CHROME_STATES.lock() {
        m.remove(label);
    }
}

/// Windows：通过 DWM 设置标题栏胶囊区底色 / 文字（符号）色。
/// 等价 Electron 的 `win.setTitleBarOverlay({ color, symbolColor })`。
/// DWMWA_CAPTION_COLOR / DWMWA_TEXT_COLOR 需要 Windows 11 (Build 22000+)；
/// 旧系统返回 E_INVALIDARG，静默忽略（装饰是纯观感，不允许中断调用方）。
#[cfg(target_os = "windows")]
fn apply_caption_colors(window: &WebviewWindow, colors: OverlayColors) {
    use windows::Win32::Foundation::{COLORREF, HWND};
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
    };

    let hwnd = match window.hwnd() {
        Ok(h) => HWND(h.0 as *mut _),
        Err(_) => return,
    };

    // COLORREF 为 0x00bbggrr（低字节红、高字节蓝）。
    let to_colorref = |c: Color| -> COLORREF {
        let r = clamp(c.r.round(), 0.0, 255.0) as u32;
        let g = clamp(c.g.round(), 0.0, 255.0) as u32;
        let b = clamp(c.b.round(), 0.0, 255.0) as u32;
        COLORREF(r | (g << 8) | (b << 16))
    };

    let caption = to_colorref(colors.color);
    let text = to_colorref(colors.symbol);

    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_CAPTION_COLOR,
            &caption as *const COLORREF as *const core::ffi::c_void,
            core::mem::size_of::<COLORREF>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_TEXT_COLOR,
            &text as *const COLORREF as *const core::ffi::c_void,
            core::mem::size_of::<COLORREF>() as u32,
        );
    }
}

/// macOS：显隐红绿灯按钮（关闭/最小化/缩放）。
/// 等价 Electron 的 `win.setWindowButtonVisibility(visible)`。
/// NSWindow 不是线程安全的，实际调用前由 `apply_window_chrome` 保证已在主线程。
#[cfg(target_os = "macos")]
fn set_traffic_lights_visible(window: &WebviewWindow, visible: bool) {
    let ptr = match window.ns_window() {
        Ok(p) if !p.is_null() => p,
        _ => return,
    };
    unsafe {
        let ns_window: &objc2_app_kit::NSWindow = &*(ptr as *const objc2_app_kit::NSWindow);
        for button in [
            objc2_app_kit::NSWindowButton::CloseButton,
            objc2_app_kit::NSWindowButton::MiniaturizeButton,
            objc2_app_kit::NSWindowButton::ZoomButton,
        ] {
            if let Some(b) = ns_window.standardWindowButton(button) {
                b.setHidden(!visible);
            }
        }
    }
}

/// 按当前状态应用原生装饰。macOS 部分会切到主线程执行（AppKit 要求）。
/// 全程只做观感调整，任何平台 API 失败都只告警、不向上抛错
/// （历史教训：Electron 版曾因 mac 上不存在 setTitleBarOverlay 抛 TypeError
/// 连带中断了后端引导）。
fn apply_window_chrome(window: &WebviewWindow) {
    let label = window.label().to_string();
    let state = read_state(&label);

    #[cfg(target_os = "macos")]
    {
        let hidden = state.scrim.is_some();
        if hidden == state.buttons_hidden {
            return;
        }
        let win = window.clone();
        let run = move || {
            set_traffic_lights_visible(&win, !hidden);
            let label = win.label().to_string();
            let mut next = read_state(&label);
            next.buttons_hidden = hidden;
            write_state(&label, next);
        };
        // AppKit 对象只允许在主线程操作；已处于主线程时直接执行，避免不必要的派发。
        if std::thread::current().name() == Some("main") {
            run();
        } else if let Err(e) = window.app_handle().run_on_main_thread(run) {
            // 全限定路径：本模块没有也不需要 `use tracing::warn`（那会在
            // 非 macOS 平台变成 unused import）。曾因漏写导致 macOS 编译 E0433。
            tracing::warn!("同步窗口装饰失败(派发主线程): {}", e);
        }
    }

    #[cfg(target_os = "windows")]
    {
        let colors = resolve_overlay_colors(&state.theme, state.scrim);
        if state.applied == Some(colors) {
            return;
        }
        apply_caption_colors(window, colors);
        let mut next = state;
        next.applied = Some(colors);
        write_state(&label, next);
    }

    // Linux 及其它平台：无原生装饰可联动（空实现）。
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = window;
        let _ = state;
    }
}

/// 登记窗口初始装饰状态并应用一次。
/// 对应 Electron 版 `initWindowChrome`（构造窗口时按主题设初值）。
pub fn init_window_chrome(window: &WebviewWindow, theme: &str) {
    let label = window.label().to_string();
    let state = ChromeState {
        theme: normalize_theme(theme).to_string(),
        ..Default::default()
    };
    write_state(&label, state);
    apply_window_chrome(window);
}

/// 主题切换（渲染层 body[data-theme] 变化）。
/// 对应 Electron 版 `setWindowTheme`。
pub fn set_window_theme_impl(window: &WebviewWindow, theme: &str) {
    let label = window.label().to_string();
    let mut state = read_state(&label);
    state.theme = normalize_theme(theme).to_string();
    write_state(&label, state);
    apply_window_chrome(window);
}

/// 全屏遮罩状态变化（渲染层探测）。
/// 对应 Electron 版 `setWindowScrim`；`None`/空串表示遮罩已关闭。
pub fn set_window_scrim_impl(window: &WebviewWindow, scrim: Option<&str>) {
    let label = window.label().to_string();
    let mut state = read_state(&label);
    state.scrim = normalize_scrim(scrim);
    write_state(&label, state);
    apply_window_chrome(window);
}

/// 复位遮罩联动。页面重载 / 渲染进程崩溃后渲染层的探测状态归零，
/// 主进程必须同步复位，否则 mac 红绿灯会一直隐藏、Windows 按钮区一直发暗。
/// 对应 Electron 版 `resetWindowScrim`（由 page_load Started 时机触发）。
pub fn reset_window_scrim(window: &WebviewWindow) {
    set_window_scrim_impl(window, None);
}

/// 窗口销毁时清出 chrome 状态表，防止按 label 泄漏。
///
/// 独立成函数的原因：`WindowEvent::Destroyed` 回调拿到的是 `&Window`，
/// 而非 `&WebviewWindow`，且窗口已销毁，任何 native 调用都无意义，
/// 因此只按 label 做状态表清理。主窗口常驻（关窗只隐藏到托盘），状态保留。
pub fn on_window_destroyed(label: &str) {
    if label != crate::window::MAIN_WINDOW_LABEL {
        remove_state(label);
    }
}

/// Tauri command：主题切换。
/// 参数 `theme` 为 "light" | "dark"，非法值按 "dark" 兜底。
#[tauri::command]
pub fn set_window_theme(app: AppHandle, theme: String) {
    if let Some(window) = app.get_webview_window(crate::window::MAIN_WINDOW_LABEL) {
        set_window_theme_impl(&window, &theme);
    }
}

/// Tauri command：全屏遮罩状态变化。
/// `scrim` 为 CSS 颜色字符串（hex/rgb/rgba），`None` 表示遮罩已关闭。
#[tauri::command]
pub fn set_window_scrim(app: AppHandle, scrim: Option<String>) {
    if let Some(window) = app.get_webview_window(crate::window::MAIN_WINDOW_LABEL) {
        set_window_scrim_impl(&window, scrim.as_deref());
    }
}
