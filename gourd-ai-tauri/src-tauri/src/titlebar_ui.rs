//! titlebar_ui.rs —— 三平台统一的自绘标题栏（窗口控件层）。
//!
//! ## 为什么必须自绘
//!
//! Electron 版在 Windows 上用的是 WCO（Window Controls Overlay，
//! `titleBarStyle:'hidden'` + `titleBarOverlay`）：系统框架层绘制胶囊按钮并浮在
//! web 内容之上。**Tauri / tao 没有 WCO 的等价能力**——既没有 `setTitleBarOverlay`，
//! 也无法让系统只画按钮不画标题栏。若沿用 `decorations(true)`，就会出现
//! 「原生标题栏 + 前端 36px 拖拽条」上下并存的双标题栏，观感崩坏。
//!
//! 因此 Windows / Linux 一律 `decorations(false)`，窗口控件改由本模块注入的
//! DOM 绘制。
//!
//! ## 平台策略（刻意不做成"三平台像素级统一"）
//!
//! | 平台    | 装饰            | 控件               | 位置 |
//! |---------|-----------------|--------------------|------|
//! | Windows | decorations off | 自绘 Fluent 按钮   | 右侧 |
//! | Linux   | decorations off | 自绘 Fluent 按钮   | 右侧 |
//! | macOS   | TitleBarStyle::Overlay | **原生红绿灯** | 左侧 |
//!
//! macOS 不自绘的三条硬理由：
//!  1. `decorations(false)` 会一并丢掉窗口圆角与系统投影，除非开
//!     `transparent + macOSPrivateApi`，而后者会让 App Store 审核直接拒收；
//!  2. 红绿灯的 hover 符号、Option+点击缩放、全屏进出动画都是 AppKit 私有行为，
//!     自绘只能做出"廉价仿制品"，mac 用户对这个尤其敏感；
//!  3. `TitleBarStyle::Overlay` 本就等价于 Electron 的 `titleBarStyle:'hidden'`，
//!     即当前 Electron 版在 mac 上的既有观感，迁移零回归。
//!
//! 这也是 VS Code / Discord / Figma 等跨平台应用的一致做法：
//! **标题栏布局统一，窗口控件遵循各平台原生习惯。**
//!
//! ## 遮罩（scrim）联动的根本性简化
//!
//! Electron 版有个顽疾：原生窗口按钮永远压在 web 内容之上，弹窗遮罩
//! （`position:fixed; inset:0`）无论 z-index 多大都压不暗那一块，只能靠主进程
//! 反过来调 `setTitleBarOverlay` 把按钮区一起调暗（见 titlebar.rs 模块文档）。
//!
//! 自绘之后 Windows / Linux 上该问题**自然消失**：按钮就是普通 DOM，遮罩天然盖得住。
//! 但直接被盖住会导致「弹窗打开时用户无法关闭窗口」，因此这里的做法是：
//!   - 控件层 z-index 高于任何业务遮罩（始终可点）；
//!   - 遮罩期间只压暗按钮图标，**不在控件层再铺一张蒙版**。
//!
//! 后一条是踩过坑的。业务遮罩是 `position:fixed; inset:0`，本就盖在控件层
//! *之下*、已经把按钮区背景压暗了一次；控件层若再铺一张同色蒙版，那块
//! 138x36 的区域会被压暗两次（0.5 叠 0.5 等效 0.75），在整片遮罩里显出一块
//! 明显更深的补丁。真正没被压暗的只有按钮图标本身（它在遮罩之上），
//! 所以只需要压暗图标，背景交还给业务遮罩，整屏才是同一个色。
//!
//! macOS 仍走原生红绿灯显隐（titlebar.rs），因为那里确实没有 DOM 可用。

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::window::MAIN_WINDOW_LABEL;

/// 标题栏高度（px）。与前端 `css/app.css` 的
/// `body.is-electron .titlebar-drag-region { height: 36px }` 严格对齐——
/// 改这里必须同步改那里，否则控件层会与内容区错位。
pub const TITLEBAR_HEIGHT: u32 = 36;

/// 单个窗口按钮宽度（px）。Windows 11 原生标题栏按钮为 46x32，
/// 这里高度取 36 与前端拖拽条齐平，宽度沿用 46 保持肌肉记忆。
const BUTTON_WIDTH: u32 = 46;

/// macOS 红绿灯需要让出的左侧宽度（px）。
/// 系统红绿灯实际占位约 78px，取 80 留 2px 余量。
const MAC_TRAFFIC_LIGHT_INSET: u32 = 80;

/// 推送给前端的窗口装饰状态。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ChromeState {
    /// 是否处于最大化（控制"最大化/还原"图标切换）
    pub maximized: bool,
    /// 窗口是否聚焦（失焦时按钮变淡，对齐 Windows 原生行为）
    pub focused: bool,
    /// 是否全屏（全屏时隐藏整个控件层）
    pub fullscreen: bool,
}

/// 读取当前窗口装饰状态。
pub fn read_chrome_state(app: &AppHandle) -> ChromeState {
    match app.get_webview_window(MAIN_WINDOW_LABEL) {
        Some(w) => ChromeState {
            maximized: w.is_maximized().unwrap_or(false),
            focused: w.is_focused().unwrap_or(true),
            fullscreen: w.is_fullscreen().unwrap_or(false),
        },
        None => ChromeState {
            maximized: false,
            focused: true,
            fullscreen: false,
        },
    }
}

/// 向前端推送窗口装饰状态（走 ipc_bridge 的 eval 通道，与其它事件同构）。
pub fn emit_chrome_state(app: &AppHandle) {
    let state = read_chrome_state(app);
    crate::ipc_bridge::emit(app, "window-chrome", &state);
}

/* ───────────────────────── Tauri 命令 ───────────────────────── */

/// 最小化窗口。
#[tauri::command]
pub fn window_minimize(app: AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = w.minimize();
    }
}

/// 最大化 / 还原切换。
#[tauri::command]
pub fn window_toggle_maximize(app: AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = if w.is_maximized().unwrap_or(false) {
            w.unmaximize()
        } else {
            w.maximize()
        };
        // 立即回推一次：Resized 事件在部分 WM 下有延迟，先行同步图标避免闪烁
        emit_chrome_state(&app);
    }
}

/// 关闭窗口。
///
/// 走 `close()` 而非 `hide()`，以便复用 `main.rs` 中
/// `WindowEvent::CloseRequested` 的既有语义（未退出时隐藏到托盘）。
#[tauri::command]
pub fn window_close(app: AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = w.close();
    }
}

/// 前端主动拉取一次窗口装饰状态（冷启动兜底，避免错过事件）。
#[tauri::command]
pub fn window_get_chrome(app: AppHandle) -> ChromeState {
    read_chrome_state(&app)
}

/* ───────────────────────── 注入脚本 ───────────────────────── */

/// 生成注入页面的自绘标题栏脚本。
pub fn init_script() -> String {
    TITLEBAR_JS
        .replace("__GOURD_PLATFORM__", crate::ipc_bridge::platform_tag())
        .replace("__TB_HEIGHT__", &TITLEBAR_HEIGHT.to_string())
        .replace("__BTN_WIDTH__", &BUTTON_WIDTH.to_string())
        .replace("__MAC_INSET__", &MAC_TRAFFIC_LIGHT_INSET.to_string())
}

/// 自绘标题栏 JS。
///
/// 保持 ES5 语法：前端其余脚本均为 ES5，且本脚本在 document-start 注入。
/// 所有样式走独立 `<style>` 且类名带 `__gourd_` 前缀，杜绝与业务样式冲突。
const TITLEBAR_JS: &str = r#"
(function () {
  'use strict';
  if (window.__GOURD_TITLEBAR__) return;

  var PLATFORM = '__GOURD_PLATFORM__';
  var TB_H = __TB_HEIGHT__;
  var BTN_W = __BTN_WIDTH__;
  var MAC_INSET = __MAC_INSET__;

  /* macOS 用原生红绿灯（见 Rust 侧模块文档），只需让出左上角空间，不注入按钮 */
  var USE_CUSTOM_CONTROLS = (PLATFORM !== 'darwin');

  var ROOT_ID = '__gourd_window_controls__';
  var STYLE_ID = '__gourd_titlebar_style__';

  function invoke(cmd, args) {
    var it = window.__TAURI_INTERNALS__;
    if (!it || typeof it.invoke !== 'function') return Promise.reject(new Error('IPC 未就绪'));
    try { return Promise.resolve(it.invoke(cmd, args || {})); }
    catch (e) { return Promise.reject(e); }
  }
  function send(cmd, args) {
    invoke(cmd, args)['catch'](function (e) {
      console.warn('[gourd-titlebar] ' + cmd + ' 失败', e);
    });
  }

  /* ───────── 图标（Windows 11 Fluent 线性风格，10x10 视口，1px 描边）───────── */

  var ICONS = {
    minimize: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">'
            + '<rect x="0" y="4.5" width="10" height="1" fill="currentColor"/></svg>',
    maximize: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">'
            + '<rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
    /* 还原：右上角一个偏移方框 + 左下角实框，与 Win11 一致 */
    restore:  '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">'
            + '<path d="M2.5 2.5 V1 A0.5 0.5 0 0 1 3 0.5 H9 A0.5 0.5 0 0 1 9.5 1 V7 A0.5 0.5 0 0 1 9 7.5 H7.5" '
            + 'fill="none" stroke="currentColor" stroke-width="1"/>'
            + '<rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
    close:    '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">'
            + '<path d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5" stroke="currentColor" stroke-width="1.1"/></svg>'
  };

  /* ───────── 样式 ─────────
     z-index 取 2147483000（略低于 int32 上限，规避个别引擎对极值的怪异处理）：
     必须高于业务遮罩（最高 10000），保证弹窗打开时窗口按钮仍可点击。 */

  var CSS = [
    '#' + ROOT_ID + '{',
    '  position:fixed;top:0;right:0;height:' + TB_H + 'px;',
    '  z-index:2147483000;display:flex;align-items:stretch;',
    '  pointer-events:none;', /* 容器不吃事件，只有按钮吃，避免遮挡右上角业务控件 */
    '  -webkit-user-select:none;user-select:none;',
    '  font-family:system-ui,"Segoe UI",sans-serif;',
    '}',
    '#' + ROOT_ID + '.is-hidden{display:none;}',

    /* 按钮本体 */
    '#' + ROOT_ID + ' .__gourd_tb_btn{',
    '  pointer-events:auto;width:' + BTN_W + 'px;height:100%;',
    '  display:flex;align-items:center;justify-content:center;',
    '  border:0;padding:0;margin:0;background:transparent;cursor:default;',
    '  color:var(--gourd-tb-fg,#1a1a2e);',
    '  opacity:var(--gourd-tb-dim,1);',
    '  transition:background-color .12s ease,color .12s ease,opacity .15s ease;',
    '  -webkit-app-region:no-drag;', /* 对可能存在的 Chromium 内核无害 */
    '}',
    '#' + ROOT_ID + ' .__gourd_tb_btn svg{display:block;pointer-events:none;}',
    /* 失焦时按钮变淡（对齐 Windows 原生）。与遮罩压暗相乘，二者可叠加生效 */
    '#' + ROOT_ID + '.is-blurred .__gourd_tb_btn{opacity:calc(var(--gourd-tb-dim,1) * .55);}',

    '#' + ROOT_ID + ' .__gourd_tb_btn:hover{background:var(--gourd-tb-hover,rgba(0,0,0,.06));}',
    '#' + ROOT_ID + ' .__gourd_tb_btn:active{background:var(--gourd-tb-active,rgba(0,0,0,.12));}',
    /* 关闭键：Win11 标准红 #c42b1c，图标转白 */
    '#' + ROOT_ID + ' .__gourd_tb_btn.__gourd_tb_close:hover{background:#c42b1c;color:#fff;opacity:1;}',
    '#' + ROOT_ID + ' .__gourd_tb_btn.__gourd_tb_close:active{background:#b1271b;color:#fff;opacity:1;}',


    /* 暗色主题配色 */
    'body[data-theme="dark"] #' + ROOT_ID + '{',
    '  --gourd-tb-fg:#dcdde1;',
    '  --gourd-tb-hover:rgba(255,255,255,.08);',
    '  --gourd-tb-active:rgba(255,255,255,.14);',
    '}',
    'body[data-theme="light"] #' + ROOT_ID + '{',
    '  --gourd-tb-fg:#1a1a2e;',
    '  --gourd-tb-hover:rgba(0,0,0,.06);',
    '  --gourd-tb-active:rgba(0,0,0,.12);',
    '}',

    /* 右侧内容区顶部拖拽条：为控件让出宽度，避免业务控件被按钮压住。
       仅 Win/Linux 需要；mac 的红绿灯在窗口左上角，那里是 .sidebar 而非 .main-area，
       已由前端 app.css 的 .sidebar-header{padding-top:40px} 与
       code.css 的 .filer-topbar{padding-top:44px} 处理，此处无需再加横向让位。 */
    'body.__gourd_has_controls .titlebar-drag-region{',
    '  padding-right:' + (BTN_W * 3) + 'px;',
    '}'
  ].join('\n');

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  /* ───────── 控件层构建 ───────── */

  var rootEl = null;
  var maxBtn = null;
  var lastState = { maximized: false, focused: true, fullscreen: false };

  function makeBtn(cls, html, title, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = '__gourd_tb_btn ' + cls;
    b.innerHTML = html;
    b.setAttribute('aria-label', title);
    b.title = title;
    /* 用 mousedown 阻断冒泡，避免触发下层的拖拽逻辑；点击仍走 click */
    b.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  /* 标题按语言给出，避免中文环境下出现英文 tooltip */
  function labels() {
    var zh = (navigator.language || '').toLowerCase().indexOf('zh') === 0;
    return zh
      ? { min: '最小化', max: '最大化', restore: '向下还原', close: '关闭' }
      : { min: 'Minimize', max: 'Maximize', restore: 'Restore Down', close: 'Close' };
  }

  function buildControls() {
    if (!USE_CUSTOM_CONTROLS || rootEl) return;
    var L = labels();

    rootEl = document.createElement('div');
    rootEl.id = ROOT_ID;

    rootEl.appendChild(makeBtn('__gourd_tb_min', ICONS.minimize, L.min, function () {
      send('window_minimize');
    }));

    maxBtn = makeBtn('__gourd_tb_max', ICONS.maximize, L.max, function () {
      send('window_toggle_maximize');
    });
    rootEl.appendChild(maxBtn);

    rootEl.appendChild(makeBtn('__gourd_tb_close', ICONS.close, L.close, function () {
      send('window_close');
    }));

    document.body.appendChild(rootEl);
    document.body.classList.add('__gourd_has_controls');
  }

  /* ───────── 状态同步 ───────── */

  function applyState(s) {
    if (!s) return;
    lastState = s;
    if (!rootEl) return;

    /* 全屏时整层隐藏：此时不存在标题栏概念 */
    rootEl.classList.toggle('is-hidden', !!s.fullscreen);
    rootEl.classList.toggle('is-blurred', !s.focused);

    if (maxBtn) {
      var L = labels();
      maxBtn.innerHTML = s.maximized ? ICONS.restore : ICONS.maximize;
      var t = s.maximized ? L.restore : L.max;
      maxBtn.title = t;
      maxBtn.setAttribute('aria-label', t);
    }
  }

  /* ───────── 遮罩联动 ─────────
     由 ipc_bridge 的 scrim 探测复用：那边已经算出「当前是否有全屏半透明遮罩」
     及其颜色，这里直接消费，不重复探测 DOM。
     只取 alpha 用来压暗图标——背景已由业务遮罩自己盖过一次（见模块文档）。 */

  /* 与 Rust 侧 MAX_SCRIM_ALPHA(0.6) 同义：遮罩再深，按钮也不低于该不透明度。
     图片灯箱是 rgba(0,0,0,.85)，等比压暗会让按钮黑到看不见——辨识度优先。 */
  var MIN_BTN_OPACITY = 0.4;

  /* 取值格式固定为 getComputedStyle 的 rgb()/rgba() 返回值 */
  function scrimAlpha(color) {
    if (!color) return 0;
    var m = /^rgba?\(([^)]+)\)$/.exec(String(color).trim().toLowerCase());
    if (!m) return 0;
    var parts = m[1].split(/[\s,/]+/).filter(function (p) { return p !== ''; });
    if (parts.length < 4) return parts.length >= 3 ? 1 : 0;
    var a = parseFloat(parts[3]);
    if (!isFinite(a)) return 0;
    return Math.max(0, Math.min(1, a));
  }

  window.__GOURD_TITLEBAR_SCRIM__ = function (color) {
    if (!rootEl) return;
    var a = scrimAlpha(color);
    var op = a > 0 ? Math.max(MIN_BTN_OPACITY, 1 - a) : 1;
    rootEl.style.setProperty('--gourd-tb-dim', String(op));
  };

  /* ───────── 初始化 ───────── */

  function onReady() {
    injectStyle();

    if (PLATFORM === 'darwin') {
      /* mac 走原生红绿灯，无需构建 DOM 控件；
         红绿灯避让已由前端 app.css / code.css 的 is-mac 规则处理。 */
      void MAC_INSET;
    } else {
      buildControls();
      /* 拉取一次初始状态（冷启动时 Rust 侧事件可能早于脚本执行） */
      invoke('window_get_chrome').then(applyState)['catch'](function () {});
    }
  }

  /* Rust 侧 Resized / Focused / 全屏事件经 ipc_bridge 下发 */
  window.__GOURD_TITLEBAR__ = { apply: applyState };

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
})();
"#;
