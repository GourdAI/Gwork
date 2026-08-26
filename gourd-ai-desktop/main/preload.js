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
});
