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
//! 102x36 的区域会被压暗两次（0.5 叠 0.5 等效 0.75），在整片遮罩里显出一块
//! 明显更深的补丁。真正没被压暗的只有按钮图标本身（它在遮罩之上），
//! 所以只需要压暗图标，背景交还给业务遮罩，整屏才是同一个色。
//!
//! ## 按钮形态：与前端标题栏动作组同款 chip
//!
//! 30x26 / 圆角 6 / hover 走主题令牌 `--bg-hover` / 图标 15px，与
//! `css/task-monitor.css` 的 `.titlebar-action-btn`（终端/监控钮）逐项一致；
//! 图标同用 24 网格 + `stroke-width="2"`：两侧图标在同一标题栏并排，
//! 外框尺寸与线宽任一不同都会露出「大小不一致」。
//! 控件条总宽 = 3×30 + 2×2(gap) + 2×4(padding) = 102px。
//! 唯一例外：关闭钮 hover 保留 Win11 标准红底白叉（破坏性操作警示）。
//!
//! macOS 仍走原生红绿灯显隐（titlebar.rs），因为那里确实没有 DOM 可用。

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::window::MAIN_WINDOW_LABEL;

/// 标题栏高度（px）。与前端 `css/app.css` 的
/// `body.is-electron .titlebar-drag-region { height: 36px }` 严格对齐——
/// 改这里必须同步改那里，否则控件层会与内容区错位。
pub const TITLEBAR_HEIGHT: u32 = 36;

/// 单个窗口按钮命中块宽度（px）。与前端 `.titlebar-action-btn`
/// （task-monitor.css）的 30px 逐字对齐：用户要求窗口按钮与左侧
/// 终端/监控钮「同款 chip」，观感统一优先于 Win11 原生 46px 肌肉记忆。
const BUTTON_WIDTH: u32 = 30;

/// 单个窗口按钮命中块高度（px）。同 `.titlebar-action-btn` 的 26px；
/// 在 36px 控件条内垂直居中，四周留 5px 呼吸位形成圆角 chip。
const BUTTON_HEIGHT: u32 = 26;

/// 相邻窗口按钮间距（px）。同 `.titlebar-actions` 的 gap: 2px。
const BUTTON_GAP: u32 = 2;

/// 控件层左右内边距（px）。同 `.titlebar-actions` 的 padding: 0 4px。
const STRIP_PAD_X: u32 = 4;

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
        .replace("__BTN_HEIGHT__", &BUTTON_HEIGHT.to_string())
        .replace("__BTN_GAP__", &BUTTON_GAP.to_string())
        .replace("__PAD_X__", &STRIP_PAD_X.to_string())
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
  var BTN_H = __BTN_HEIGHT__;
  var BTN_GAP = __BTN_GAP__;
  var PAD_X = __PAD_X__;
  var MAC_INSET = __MAC_INSET__;
  /* 控件条总宽（px）：3 按钮 + 2 间距 + 2 内边距。前端 app-titlebar-actions.js
     的左组右偏移必须与此同值（+6px 视觉间距），改尺寸时四处同改。 */
  var STRIP_W = BTN_W * 3 + BTN_GAP * 2 + PAD_X * 2;

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

  /* ───────── 图标（Windows 11 Fluent 线性风格，24x24 视口，15px 渲染）─────────
     【与左侧同规格，勿再退 12px/10 视口】窗控图标必须与 .titlebar-action-btn 的
     终端/监控图标逐项同源：15px 外框 + 24 网格 + stroke-width 2，两者在同一标题栏里
     并排，任何一项不同都会露出一眼可见的大小差。
     历史：本组曾用「10x10 视口 / 12px / stroke 1」，注释以「窗控符号笔画更简，
     12px 即等效」自证——实测该假设不成立：12px 渲染下墨迹只有 12px、
     左侧按 24 网格 15px 渲染为 12.5px（描边缩放后 1.25px），五个按钮并排时
     右侧三枚明显偏小，即用户报障「图标大小都不一致」。
     现在两侧共用一套渲染契约：改尺寸请同时改 index.html 里 .titlebar-action-btn
     的 svg 属性与本处，契约测试会校验两边数字一致。 */

  var ICONS = {
    /* 墨迹口径（四枚统一 20 单位 / 24 网格 ≠ 每枚都画满 24 网格）：
       描边以路径为中心线向两侧各外扩 stroke-width/2 = 1 单位，故取线心 3..21 → 墨迹 2..22。
       20 单位 × (15px/24) = 12.5px，与左组 18x18 rect@(3,3) 的墨迹完全同大。
       圆角统一 rx=2，与 index.html 左组 rect 的 rx="2" 逐项一致——半径不同会在同尺寸下仍显"不一样"。 */
    minimize: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
            + ' stroke-width="2" stroke-linecap="round" aria-hidden="true">'
            + '<path d="M3 12h18"/></svg>',
    maximize: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
            + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            + '<rect x="3" y="3" width="18" height="18" rx="2"/></svg>',
    /* 还原：右上偏移框 + 左下整框，与 Win11 一致。
       【端点必须锚在前框边上】后框是被前框"咬断"的，两个断口各落在前框的两条边上：
       起始点 (8,8) 压在前框上边缘 y=8，终点 x=16 压在前框右边缘 x=3+13。
       写成 M8 6 / h-1 会让两端各自悬空 2 单位，15px 下是一根脱节的短笔（bbox 测不出来）。 */
    restore:  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
            + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            + '<path d="M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3"/>'
            + '<rect x="3" y="8" width="13" height="13" rx="2"/></svg>',
    close:    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
            + ' stroke-width="2" stroke-linecap="round" aria-hidden="true">'
            + '<path d="M3 3 L21 21 M21 3 L3 21"/></svg>'
  };

  /* ───────── 样式 ─────────
     z-index 取 2147483000（略低于 int32 上限，规避个别引擎对极值的怪异处理）：
     必须高于业务遮罩（最高 10000），保证弹窗打开时窗口按钮仍可点击。 */

  var CSS = [
    '#' + ROOT_ID + '{',
    '  position:fixed;top:0;right:0;height:' + TB_H + 'px;',
    '  z-index:2147483000;display:flex;align-items:center;',
    /* gap/padding 与 .titlebar-actions 逐字一致：chip 间距 2px、两侧 4px，
       五钮（终端/监控 + 最小化/最大化/关闭）排布节奏统一。 */
    '  gap:' + BTN_GAP + 'px;padding:0 ' + PAD_X + 'px;',
    '  pointer-events:none;', /* 容器不吃事件，只有按钮吃，避免遮挡右上角业务控件 */
    '  -webkit-user-select:none;user-select:none;',
    '  font-family:system-ui,"Segoe UI",sans-serif;',
    '}',
    '#' + ROOT_ID + '.is-hidden{display:none;}',

    /* 按钮本体：与 .titlebar-action-btn 同款 chip（30x26 / 圆角6 / 居中）。
       高度不再 100% 撑满控件条，改为定高 + 垂直居中，hover 底色才是圆角小块
       而非整条色带（用户反馈「与左侧两钮不一致」的根因）。 */
    '#' + ROOT_ID + ' .__gourd_tb_btn{',
    '  pointer-events:auto;width:' + BTN_W + 'px;height:' + BTN_H + 'px;',
    '  display:flex;align-items:center;justify-content:center;',
    '  border:0;padding:0;margin:0;background:transparent;cursor:default;',
    '  border-radius:6px;',
    '  color:var(--titlebar-icon-fg,var(--gourd-tb-fg,#1a1a2e));',
    '  opacity:var(--gourd-tb-dim,1);',
    '  transition:background-color .15s,color .15s,opacity .15s ease;',
    '  -webkit-app-region:no-drag;', /* 对可能存在的 Chromium 内核无害 */
    '}',
    '#' + ROOT_ID + ' .__gourd_tb_btn svg{display:block;pointer-events:none;}',
    /* 失焦时按钮变淡（对齐 Windows 原生）。与遮罩压暗相乘，二者可叠加生效 */
    '#' + ROOT_ID + '.is-blurred .__gourd_tb_btn{opacity:calc(var(--gourd-tb-dim,1) * .55);}',

    /* hover/active 底色优先吃主题令牌 --bg-hover，与 .titlebar-action-btn 完全同源；
       令牌缺失（注入早于 theme.css 解析的极端时序）才退回 rgba 兜底值。 */
    '#' + ROOT_ID + ' .__gourd_tb_btn:hover{background:var(--bg-hover,var(--gourd-tb-hover,rgba(0,0,0,.06)));color:var(--text-primary,var(--gourd-tb-fg,#1a1a2e));}',
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
       让位宽 = 控件条总宽 STRIP_W（3 按钮 + gap + padding），与前端
       app-titlebar-actions.js 的左组偏移同源；改按钮尺寸时自动跟随。
       仅 Win/Linux 需要；mac 的红绿灯在窗口左上角，那里是 .sidebar 而非 .main-area，
       已由前端 app.css 的 .sidebar-header{padding-top:40px} 与
       code.css 的 .filer-topbar{padding-top:44px} 处理，此处无需再加横向让位。 */
    'body.__gourd_has_controls .titlebar-drag-region{',
    '  padding-right:' + STRIP_W + 'px;',
    '}'
  ].join('\n');

  /* 控件条总宽对外暴露为唯一真源：前端 app-titlebar-actions.js 的左组右偏移
     直接消费它（+6px 视觉间距），避免两处硬编码宽度漂移。
     仅 Win/Linux 自绘时非 0；mac 无自绘控件，前端据此退回不让位。 */
  window.__GOURD_TITLEBAR_STRIP_W__ = USE_CUSTOM_CONTROLS ? STRIP_W : 0;
  /* 首帧兜底：本脚本 document-start 注入、早于业务脚本，先把偏移变量写好，
     避免 app-titlebar-actions.js 执行前的空窗里左组按 CSS 缺省 144px 站位、
     随后跳变 36px。documentElement 在极早期可能缺失，try/catch 兜住。 */
  try {
    if (document.documentElement && document.documentElement.style) {
      document.documentElement.style.setProperty(
        '--titlebar-actions-right',
        (USE_CUSTOM_CONTROLS ? STRIP_W + 6 : 6) + 'px');
    }
  } catch (e) { /* 首帧兜底失败不致命：业务脚本随后会覆写 */ }

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
