'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// UI 由本地 HTTP 服务器（http://localhost:{uiPort}）提供，/web/** 与 WebSocket
// 都经该服务器同源反向代理到后端 jar。前端无需知道后端端口，一切同源。
// 仅桥接后端就绪/失败事件给渲染层（前端据此重连 WebSocket、刷新数据、提示错误）。
contextBridge.exposeInMainWorld('__GOURD_IPC__', {
  isDesktop: true,
  onBackendReady: (cb) => {
    if (typeof cb === 'function') {
      ipcRenderer.on('backend-ready', (_e, data) => cb(data));
    }
  },
  onBackendFailed: (cb) => {
    if (typeof cb === 'function') {
      ipcRenderer.on('backend-failed', (_e, data) => cb(data));
    }
  },
  // 主动查询后端就绪状态（'pending' | 'ready' | 'failed'）。
  // 消除“就绪事件早于渲染层注册监听器”的竞态：渲染层可在任意时刻拉取当前状态。
  getBackendState: () => ipcRenderer.invoke('get-backend-state'),
  // 完整状态详情（端口/PID/存活/最近探针/失败原因/两份日志路径），供错误条与设置页展示。
  getBackendDetail: () => ipcRenderer.invoke('get-backend-detail'),
  // 手动重试后端（错误条上的「重试」）：返回 { ok, skipped, error }。
  restartBackend: () => ipcRenderer.invoke('restart-backend'),
  // 安装一致性告警：jar 自报 buildId 与打包快照不符（覆盖安装未完全替换）。
  onInstallMismatch: (cb) => {
    if (typeof cb === 'function') {
      ipcRenderer.on('install-mismatch', (_e, data) => cb(data));
    }
  },
  // 定制窗口标题（如 Code 模式显示当前项目名）。
  setWindowTitle: (title) => ipcRenderer.send('window-title-update', String(title || '')),

  // ─── 自动更新（main/updater.js；仅打包态有效，开发/浏览器环境无事件）──────
  // 桌面端版本号（package.json version，区别于 jar 后端版本）
  getAppVersion: () => ipcRenderer.invoke('updater-get-version'),
  // 当前更新状态快照（mode/status/version/progress/error 等）
  updaterGetState: () => ipcRenderer.invoke('updater-get-state'),
  // 手动检查更新
  updaterCheck: () => ipcRenderer.invoke('updater-check'),
  // 重试下载（auto 模式）/ 打开下载页（notify 模式）
  updaterDownload: () => ipcRenderer.invoke('updater-download'),
  // 安装并重启（auto 模式）/ 打开下载页（notify 模式）
  updaterInstall: () => ipcRenderer.invoke('updater-install'),
  // 订阅更新状态变化广播
  onUpdaterState: (cb) => {
    if (typeof cb === 'function') {
      ipcRenderer.on('updater-state', (_e, data) => cb(data));
    }
  },
});

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
});

// ─── 全屏遮罩 ↔ 原生窗口按钮联动 ───────────────────────────────────────────
// 窗口按钮（Win/Linux 的 WCO、mac 的红绿灯）由系统框架层绘制，永远压在 web 内容
// 之上：网页里 position:fixed; inset:0 的遮罩再高 z-index 也压不暗它们，弹窗打开时
// 那一块会突兀地保持高亮。这里探测「当前是否有全屏半透明遮罩」并把遮罩色报给主进程，
// 由 main/titlebar.js 同步原生装饰。
//
// 探测用 elementFromPoint 命中标题栏条带上的点，而不是枚举业务类名——
// 遮罩有 7 处（设置/模型/记忆/导入/微信/IM/灯箱）且散落在多个 js 文件里，
// 枚举法必然漏；命中法与 DOM 结构、类名、后续新增弹窗全部解耦。
const SCRIM_MIN_COVERAGE = 0.9;   // 遮罩至少覆盖视口面积的比例
const SCRIM_MAX_HOPS = 4;         // 命中点可能落在遮罩的子节点上，向上回溯的层数
const SCRIM_RECHECK_MS = 320;     // 遮罩带 0.2s 淡入动画，交互后延迟补检一次

/**
 * 判断元素本身是否是「盖住整个视口的半透明遮罩」，是则返回其背景色。
 * @param {Element} el
 * @returns {string|null}
 */
function scrimColorOf(el) {
  if (!el || el.nodeType !== 1) return null;
  const cs = window.getComputedStyle(el);
  if (!cs || cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') return null;
  // 只认半透明：全透明不算遮罩，完全不透明的整屏盖层（历史上曾是启动白屏 #appBootLoading，
  // 现已按「打开即展示首页」移除）也不需要联动——那种盖层下面没有可交互内容。
  const bg = cs.backgroundColor;
  const m = /^rgba?\(([^)]+)\)$/.exec(bg);
  let a = 1;
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter((p) => p !== '');
    a = parts.length >= 4 ? parseFloat(parts[3]) : 1;
  } else if (bg === 'transparent') {
    a = 0;
  }
  if (!Number.isFinite(a) || !(a > 0.02 && a < 1)) return null;
  const rect = el.getBoundingClientRect();
  if (rect.top > 1 || rect.left > 1) return null;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!(vw > 0 && vh > 0)) return null;
  if (rect.width * rect.height < vw * vh * SCRIM_MIN_COVERAGE) return null;
  return bg;
}

/**
 * 在标题栏条带上取点命中，返回当前生效的遮罩色（无遮罩返回 null）。
 * @returns {string|null}
 */
function probeScrim() {
  const vw = window.innerWidth;
  if (!document.body || !(vw > 20)) return null;
  const points = [[6, 6], [Math.round(vw / 2), 6], [vw - 6, 6]];
  for (const [x, y] of points) {
    let el = document.elementFromPoint(x, y);
    for (let hop = 0; el && hop < SCRIM_MAX_HOPS; hop++) {
      if (el === document.body || el === document.documentElement) break;
      const color = scrimColorOf(el);
      if (color) return color;
      el = el.parentElement;
    }
  }
  return null;
}

function installScrimWatcher() {
  let reported = null;
  let pending = false;

  const runDetect = () => {
    let color = null;
    try {
      color = probeScrim();
    } catch (e) {
      color = null;
    }
    if (color === reported) return;
    reported = color;
    ipcRenderer.send('ui-scrim-changed', color);
  };

  const schedule = () => {
    if (pending) return;
    pending = true;
    const run = () => { pending = false; runDetect(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  };
  const scheduleWithRecheck = () => {
    schedule();
    setTimeout(runDetect, SCRIM_RECHECK_MS);
  };

  // 遮罩节点全部挂在 body 直下（见 index.html：settings/model-settings/memory 片段与
  // 各弹窗的 $('body').append）。故只观察 body 的子节点增删 + body 及其直接子节点的
  // class/style 变化，不开 subtree——否则流式输出时每次 DOM 改动都要过一遍观察器。
  const attrObserver = new MutationObserver(schedule);
  const bindAttrTargets = () => {
    attrObserver.disconnect();
    const opts = { attributes: true, attributeFilter: ['style', 'class'] };
    attrObserver.observe(document.body, opts);
    const kids = document.body.children;
    for (let i = 0; i < kids.length; i++) attrObserver.observe(kids[i], opts);
  };
  new MutationObserver(() => { bindAttrTargets(); schedule(); })
    .observe(document.body, { childList: true });
  bindAttrTargets();

  // 兜底：任何弹窗都由用户交互触发，交互后补检一次（覆盖异步/动画打开，
  // 以及将来出现的非 body 直下遮罩）；窗口尺寸变化会影响覆盖率判定。
  window.addEventListener('click', scheduleWithRecheck, true);
  window.addEventListener('keydown', scheduleWithRecheck, true);
  window.addEventListener('resize', schedule);

  schedule();
}


window.addEventListener('DOMContentLoaded', () => {
  // 标记当前运行在 Electron 中，激活 web 端的 Electron 专属样式
  document.body.classList.add('is-electron');
  // macOS 专属标记：红绿灯窗口按钮在左上角，web 端据此为侧边栏顶部让位
  if (process.platform === 'darwin') {
    document.body.classList.add('is-mac');
  }

  // 左侧 sidebar logo 行（macOS 上还含红绿灯让位空白区）可拖拽移动窗口，
  // 按钮等交互元素保持可点击。
  // 注意：no-drag 白名单一律用通用元素选择器（button/input/a），不得枚举业务类名——
  // 历史教训：曾枚举 .new-chat-btn / .sidebar-header-actions，UI 重构类名失效后
  // mac 拖拽区吞掉整个主导航导致全部按钮不可点击。
  const style = document.createElement('style');
  style.textContent = `
    body.is-electron .sidebar-header-top {
      -webkit-app-region: drag;
    }
    /* macOS：让位出来的侧边栏顶部空白区也可拖拽窗口 */
    body.is-electron.is-mac .sidebar-header {
      -webkit-app-region: drag;
    }
    /* 拖拽区内交互元素打 no-drag 洞（含按钮内部图标/文字子节点） */
    body.is-electron .sidebar-header button,
    body.is-electron .sidebar-header button *,
    body.is-electron .sidebar-header input,
    body.is-electron .sidebar-header a {
      -webkit-app-region: no-drag;
    }
    /* macOS：专注模式文件树面板顶部的红绿灯让位空白区（padding 区属于元素自身）
       同样可拖拽窗口，与 chat 模式侧边栏手感对齐 */
    body.is-electron.is-mac .filer-topbar {
      -webkit-app-region: drag;
    }
    body.is-electron .filer-topbar button,
    body.is-electron .filer-topbar button * {
      -webkit-app-region: no-drag;
    }
  `;
  document.head.appendChild(style);

  // 监听 body[data-theme] 变化，同步标题栏颜色
  function syncTheme() {
    const theme = document.body.getAttribute('data-theme') || 'dark';
    ipcRenderer.send('theme-changed', theme);
  }

  syncTheme();

  new MutationObserver(syncTheme).observe(document.body, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });

  installScrimWatcher();
});
