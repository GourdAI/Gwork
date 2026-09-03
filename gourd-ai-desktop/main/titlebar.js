'use strict';

/**
 * 原生窗口装饰（Windows/Linux 的 Window Controls Overlay、macOS 的红绿灯）与
 * 网页全屏遮罩（scrim）的联动。
 *
 * 背景（Bug）：主窗口用 titleBarStyle:'hidden' + titleBarOverlay 保留原生窗口按钮，
 * 这些按钮由系统框架层绘制，永远压在 web 内容之上——按 Window Controls Overlay 规范
 * 「DOM 元素无法使用（覆盖）该区域」。因此设置弹窗等 position:fixed; inset:0 的遮罩
 * 无论 z-index 多大都压不暗右上角按钮区：整屏都变暗了，只有那一块突兀地保持高亮。
 *
 * 处理方式（渲染层探测见 preload.js 的 ui-scrim-changed）：
 *  - win32 / linux：把 WCO 的 color/symbolColor 预先与遮罩色混合后重设，
 *    按钮区随遮罩一起变暗，且按钮仍可点（用户永远能最小化/关闭窗口）；
 *  - darwin：红绿灯没有着色 API，只能显隐（setWindowButtonVisibility），
 *    遮罩期间隐藏、遮罩关闭即恢复。
 *    注意：不要改用 setClosable/setMinimizable/setMaximizable 来"置灰"红绿灯——
 *    在 titleBarStyle:'hidden' + titleBarOverlay 下切换 styleMask 会踩到
 *    electron#38289（还原后绿色缩放按钮无法正常显示）。
 *
 * 主题色映射与 web 端 theme.css 的 --bg-main 保持一致。
 * 注意：color 必须用不透明的实际标题栏背景色，而不能用透明色——
 * Windows 按 color 的亮度推导窗口按钮的 hover 底色：透明黑会被判为深色背景，
 * hover 给白色高亮，在亮色（白底）下白上白完全不可见。
 */

const THEME_COLORS = {
  light: { color: '#ffffff', symbolColor: '#1a1a2e', height: 36 },
  dark: { color: '#1a1b1e', symbolColor: '#dcdde1', height: 36 },
};

/** 渲染层没给出可解析颜色时的兜底遮罩色（应用内所有遮罩当前都是这个值）。 */
const DEFAULT_SCRIM = 'rgba(0, 0, 0, 0.5)';

/**
 * 标题栏最多按该 alpha 变暗。图片灯箱一类遮罩是 rgba(0,0,0,0.85)，
 * 若等比压暗，窗口按钮会黑到看不见——按钮辨识度优先于像素级一致。
 */
const MAX_SCRIM_ALPHA = 0.6;

/** 混色后按钮符号与底色的最小亮度差，低于此值改用黑/白强制拉开对比。 */
const MIN_SYMBOL_GAP = 0.2;

const chromeState = new WeakMap();

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return n < min ? min : (n > max ? max : n);
}

/**
 * 解析 CSS 颜色（仅支持 #rgb/#rgba/#rrggbb/#rrggbbaa 与 rgb()/rgba()，
 * 覆盖 getComputedStyle 的实际返回格式与本项目主题色写法）。
 * @param {string} input
 * @returns {{r:number,g:number,b:number,a:number}|null}
 */
function parseColor(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (!s || s.length > 64) return null;
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    const h = hex[1];
    const dup = (c) => parseInt(c + c, 16);
    const pair = (i) => parseInt(h.slice(i, i + 2), 16);
    if (h.length === 3 || h.length === 4) {
      return {
        r: dup(h[0]), g: dup(h[1]), b: dup(h[2]),
        a: h.length === 4 ? dup(h[3]) / 255 : 1,
      };
    }
    if (h.length === 6 || h.length === 8) {
      return {
        r: pair(0), g: pair(2), b: pair(4),
        a: h.length === 8 ? pair(6) / 255 : 1,
      };
    }
    return null;
  }

  const rgb = /^rgba?\(([^)]+)\)$/.exec(s);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter((p) => p !== '');
    if (parts.length < 3) return null;
    const num = (v) => {
      const f = parseFloat(v);
      return Number.isFinite(f) ? (String(v).endsWith('%') ? (f * 255) / 100 : f) : NaN;
    };
    const r = num(parts[0]);
    const g = num(parts[1]);
    const b = num(parts[2]);
    if (![r, g, b].every(Number.isFinite)) return null;
    let a = 1;
    if (parts.length >= 4) {
      const av = parseFloat(parts[3]);
      if (!Number.isFinite(av)) return null;
      a = String(parts[3]).endsWith('%') ? av / 100 : av;
    }
    return {
      r: clamp(Math.round(r), 0, 255),
      g: clamp(Math.round(g), 0, 255),
      b: clamp(Math.round(b), 0, 255),
      a: clamp(a, 0, 1),
    };
  }
  return null;
}

function toHex(c) {
  const p = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return '#' + p(c.r) + p(c.g) + p(c.b);
}

/** 感知亮度（0~1），用于兜底判断符号色与底色是否糊在一起。 */
function luminance(c) {
  return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
}

/**
 * 把 base 压在 scrim 之下做 alpha 合成（source-over），返回不透明 #rrggbb。
 * @param {{r:number,g:number,b:number}} base
 * @param {{r:number,g:number,b:number}} scrim
 * @param {number} alpha 实际生效的遮罩 alpha
 */
function blendOver(base, scrim, alpha) {
  const a = clamp(alpha, 0, 1);
  return {
    r: base.r * (1 - a) + scrim.r * a,
    g: base.g * (1 - a) + scrim.g * a,
    b: base.b * (1 - a) + scrim.b * a,
  };
}

/**
 * 归一化遮罩色：不可解析 / 全透明按"无遮罩"处理，其余截断到 MAX_SCRIM_ALPHA。
 * @param {string|null|undefined} scrim
 * @returns {{r:number,g:number,b:number,a:number}|null}
 */
function normalizeScrim(scrim) {
  if (!scrim) return null;
  const c = parseColor(scrim) || parseColor(DEFAULT_SCRIM);
  if (!c || c.a <= 0.02) return null;
  return { r: c.r, g: c.g, b: c.b, a: clamp(c.a, 0, MAX_SCRIM_ALPHA) };
}

function normalizeTheme(theme) {
  return THEME_COLORS[theme] ? theme : 'dark';
}

/**
 * 计算 WCO 应该用的颜色：无遮罩→主题原色；有遮罩→与遮罩混合后的暗色。
 * @param {string} theme 'light' | 'dark'
 * @param {string|null} scrim 遮罩色（CSS 颜色字符串），null 表示无遮罩
 * @returns {{color:string,symbolColor:string,height:number}}
 */
function resolveOverlayColors(theme, scrim) {
  const base = THEME_COLORS[normalizeTheme(theme)];
  const s = normalizeScrim(scrim);
  if (!s) return { color: base.color, symbolColor: base.symbolColor, height: base.height };

  const baseColor = parseColor(base.color) || { r: 26, g: 27, b: 30, a: 1 };
  const baseSymbol = parseColor(base.symbolColor) || { r: 220, g: 221, b: 225, a: 1 };
  const bg = blendOver(baseColor, s, s.a);
  let symbol = blendOver(baseSymbol, s, s.a);
  // 兜底：遮罩很深或主题对比本就不足时，符号会糊进底色，强制拉回可辨识
  if (Math.abs(luminance(symbol) - luminance(bg)) < MIN_SYMBOL_GAP) {
    symbol = luminance(bg) > 0.5 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
  }
  return { color: toHex(bg), symbolColor: toHex(symbol), height: base.height };
}

function overlayKey(opts) {
  return opts.color + '|' + opts.symbolColor + '|' + opts.height;
}

function readState(win) {
  let state = chromeState.get(win);
  if (!state) {
    state = { theme: 'dark', scrim: null, appliedKey: null, buttonsHidden: false };
    chromeState.set(win, state);
  }
  return state;
}

/**
 * 按当前 state 应用原生装饰。全程 try/catch：装饰是纯观感，
 * 绝不允许因平台 API 差异抛错而中断调用方（历史教训：mac 上
 * setTitleBarOverlay 不存在，直接调用抛 TypeError 连带中断了后端引导）。
 * @param {import('electron').BrowserWindow} win
 * @param {string} [platform]
 */
function applyWindowChrome(win, platform = process.platform) {
  if (!win || typeof win !== 'object') return;
  if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return;
  const state = readState(win);
  try {
    if (platform === 'darwin') {
      const hidden = !!state.scrim;
      if (hidden === state.buttonsHidden) return;
      if (typeof win.setWindowButtonVisibility !== 'function') return;
      win.setWindowButtonVisibility(!hidden);
      state.buttonsHidden = hidden;
      return;
    }
    if (typeof win.setTitleBarOverlay !== 'function') return;
    const opts = resolveOverlayColors(state.theme, state.scrim);
    const key = overlayKey(opts);
    if (key === state.appliedKey) return;
    win.setTitleBarOverlay(opts);
    state.appliedKey = key;
  } catch (e) {
    console.warn('[gourd-ai-desktop] 同步窗口装饰失败:', e && e.message);
  }
}

/**
 * 登记窗口初始装饰状态。构造函数已经按该主题设过一次，故此处只记状态不再重复调用。
 * @param {import('electron').BrowserWindow} win
 * @param {string} theme
 */
function initWindowChrome(win, theme) {
  const state = {
    theme: normalizeTheme(theme),
    scrim: null,
    appliedKey: null,
    buttonsHidden: false,
  };
  state.appliedKey = overlayKey(resolveOverlayColors(state.theme, null));
  chromeState.set(win, state);
  return state;
}

/**
 * 主题切换（渲染层 body[data-theme] 变化）。
 * @param {import('electron').BrowserWindow} win
 * @param {string} theme
 * @param {string} [platform]
 */
function setWindowTheme(win, theme, platform = process.platform) {
  if (!win) return;
  const state = readState(win);
  state.theme = normalizeTheme(theme);
  applyWindowChrome(win, platform);
}

/**
 * 全屏遮罩状态变化（渲染层探测，见 preload.js）。
 * @param {import('electron').BrowserWindow} win
 * @param {string|null} scrim 遮罩色；null/空 表示遮罩已关闭
 * @param {string} [platform]
 */
function setWindowScrim(win, scrim, platform = process.platform) {
  if (!win) return;
  const state = readState(win);
  const next = normalizeScrim(scrim);
  state.scrim = next ? `rgba(${next.r}, ${next.g}, ${next.b}, ${next.a})` : null;
  applyWindowChrome(win, platform);
}

/**
 * 复位遮罩联动。页面重载 / 渲染进程崩溃后渲染层的探测状态归零，
 * 主进程必须同步复位，否则 mac 红绿灯会一直隐藏、Win/Linux 按钮区一直发暗。
 * @param {import('electron').BrowserWindow} win
 * @param {string} [platform]
 */
function resetWindowScrim(win, platform = process.platform) {
  setWindowScrim(win, null, platform);
}

module.exports = {
  THEME_COLORS,
  DEFAULT_SCRIM,
  MAX_SCRIM_ALPHA,
  MIN_SYMBOL_GAP,
  parseColor,
  resolveOverlayColors,
  applyWindowChrome,
  initWindowChrome,
  setWindowTheme,
  setWindowScrim,
  resetWindowScrim,
};
