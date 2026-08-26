'use strict';

/**
 * main/index.js - Electron 主进程入口
 *
 * 启动流程（UI 已从后端解耦，界面外壳「秒开」）：
 * 1. app ready 后立即起本地 UI 服务器（http://localhost:{uiPort}）
 * 2. 主窗口导航到该 localhost 地址 —— 无需等待后端（秒开）
 * 3. 并行随机分配端口并启动 gourd-ai-agent.jar 子进程（serve 模式）
 * 4. 轮询 /web/chat/meta 等待后端就绪，就绪后放行 UI 服务器代理的 /web/** 请求
 * 5. 通过 IPC 通知渲染层 backend-ready（前端据此重连 WebSocket / 刷新数据）
 * 6. 应用退出时 kill 子进程 + 关闭 UI 服务器
 *
 * 关键点：UI（HTML/JS/CSS）由本地 HTTP 服务器从磁盘直接提供，仅 /web/**、
 * /chat/channel/** 与 WebSocket 反向代理到本地 jar。页面 origin 为
 * http://localhost:{uiPort}，是浏览器特判的可信来源，故摄像头 getUserMedia、
 * 语音识别、剪贴板等能力可用（自定义协议 app:// 会禁用这些）。详见 ui-server.js。
 */

const { app, BrowserWindow, screen, Menu, Tray, ipcMain, nativeImage, session, shell } = require('electron');
const path = require('path');
const {
  findAvailablePort,
  startBackend,
  waitForBackend,
  stopBackend,
} = require('./backend');
const uiServer = require('./ui-server');
const { provisionCli } = require('./cli-provision');
const updater = require('./updater');

// 单实例锁：防止多开
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;
let tray = null;
let backendPort = 0;
let uiOrigin = '';        // 本地 UI 服务器 origin：http://localhost:{uiPort}
let uiServerHandle = null;
let isQuitting = false;

// ─── 后端就绪状态（供 UI 服务器代理判断是否放行 /web/** 请求）─────────────
// backendReadyState: 'pending' | 'ready' | 'failed'
let backendReadyState = 'pending';
const backendReadyWaiters = [];

/**
 * 标记后端就绪结果，唤醒所有等待者，并通知渲染层。
 * @param {boolean} ok
 */
function settleBackendReady(ok) {
  if (backendReadyState !== 'pending') return;
  backendReadyState = ok ? 'ready' : 'failed';
  const waiters = backendReadyWaiters.splice(0);
  for (const w of waiters) w(ok);

  if (ok) {
    // 通知渲染层：后端已就绪（前端据此重连 WebSocket / 触发数据刷新 / 放行启动请求）。
    // 广播到主窗口；页面可能尚未加载完成，
    // sendToWindow 内部用 did-finish-load 兜底，避免事件丢失导致前端一直等待。
    broadcastToRenderer('backend-ready', { port: backendPort });
  }
}

/**
 * 向指定窗口发送 IPC 消息；页面仍在加载时等 did-finish-load 后再发，避免消息丢失。
 * @param {BrowserWindow|null} win
 * @param {string} channel
 * @param {object} payload
 */
function sendToWindow(win, channel, payload) {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  const push = () => {
    if (win && !win.isDestroyed()) wc.send(channel, payload);
  };
  if (wc.isLoading()) {
    wc.once('did-finish-load', push);
  } else {
    push();
  }
}

/** 广播到主窗口，供 backend-ready/failed 等全局事件使用。 */
function broadcastToRenderer(channel, payload) {
  sendToWindow(mainWindow, channel, payload);
}


/**
 * 等待后端就绪。已定局立即返回；否则挂起直至 settle 或超时。
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} ready→true，failed/超时→false
 */
function awaitBackendReady(timeoutMs) {
  if (backendReadyState === 'ready') return Promise.resolve(true);
  if (backendReadyState === 'failed') return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    const once = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    backendReadyWaiters.push(once);
    setTimeout(() => once(false), timeoutMs);
  });
}

/**
 * 外链交给系统浏览器打开：仅放行 http(s) 协议，防止 javascript:/file: 等注入。
 * @param {string} url
 */
function openExternalSafe(url) {
  if (!/^https?:\/\//i.test(url)) return;
  Promise.resolve(shell.openExternal(url)).catch((e) => {
    console.warn('[gourd-ai-desktop] 打开外链失败:', url, e && e.message);
  });
}

/**
 * 创建主窗口
 */
function createMainWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    title: 'GWork',
    width: Math.min(1440, width),
    height: Math.min(900, height),
    minWidth: 960,
    minHeight: 600,
    show: false,
    icon: getIconPath(),
    titleBarStyle: 'hidden',
    titleBarOverlay: THEME_COLORS.dark,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 流式渲染依赖 rAF/定时器；默认 true 会在窗口隐藏/被遮挡时节流，
      // 表现为"思考不流式、工具卡结尾批量出现"。保持后台全速运行。
      backgroundThrottling: false,
    },
  });

  // 禁止页面 <title> 覆盖窗口标题
  mainWindow.on('page-title-updated', (e) => e.preventDefault());

  // 外链（target="_blank" / window.open）一律交给系统浏览器。
  // Electron 默认会在应用内弹裸新窗口（多一个渲染进程、无导航栏体验差），这里拦截改外部打开。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });

  // 防主窗口本体被裸链接（如 markdown 渲染、未带 target=_blank 的 <a>）导航到外站。
  // will-navigate 只由渲染层/用户点击触发，loadURL 等编程式导航不经过，不影响本地 UI 首载。
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (uiOrigin && url.startsWith(uiOrigin)) return;
    e.preventDefault();
    openExternalSafe(url);
  });

  // 加载本地 UI 服务器（http://localhost:{uiPort}，秒开，无需等待后端）。
  // 界面里的 /web/** 接口请求与 WebSocket 由该服务器同源反向代理到本地 jar，
  // 后端就绪前这些请求会挂起等待（见 ui-server.js），外壳与静态资源不受影响。
  mainWindow.loadURL(uiOrigin);
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 关闭窗口时隐藏到托盘，不退出程序
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

/**
 * 显示主窗口。
 */
function showAllWindows() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

/**
 * 隐藏主窗口，应用仍驻留托盘。
 */
function hideAllWindows() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
}

/**
 * 创建系统托盘
 */
function createTray() {
  // 图标资源缺失时（如 mac 包未打包 icons 目录）createFromPath 得到空图，
  // new Tray 会直接抛异常并中断后续后端引导，这里降级跳过托盘。
  let icon = nativeImage.createFromPath(getIconPath());
  if (!icon || icon.isEmpty()) {
    console.warn('[gourd-ai-desktop] 托盘图标缺失，跳过托盘创建:', getIconPath());
    return;
  }
  // macOS 状态栏项按图片原始点尺寸渲染，不会像 Windows 托盘那样自动缩放：
  // 820×820 的应用图标会被菜单栏高度裁成一条横贯菜单条的黑白色带。
  // 交给 Tray 前缩放到菜单栏标准高度（约 18pt）。
  if (process.platform === 'darwin') {
    icon = icon.resize({ width: 18, height: 18 });
  }
  let trayInstance;
  try {
    trayInstance = new Tray(icon);
  } catch (e) {
    console.warn('[gourd-ai-desktop] 托盘创建失败，跳过:', e && e.message);
    return;
  }
  tray = trayInstance;
  tray.setToolTip('GWork');

  const menu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        showAllWindows();
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);

  // 单击托盘图标显示/隐藏窗口
  tray.on('click', () => {
    if (mainWindow && mainWindow.isVisible()) {
      hideAllWindows();
    } else {
      showAllWindows();
    }
  });
}

/**
 * 获取应用图标路径
 */
function getIconPath() {
  const ext = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'icons', ext);
  }
  return path.join(__dirname, '..', 'resources', 'icons', ext);
}

/**
 * 引导后端启动。窗口与本地 UI 已由 createMainWindow 立即加载，
 * 此处只负责启动 jar 子进程并在就绪后放行 app:// 代理的接口请求。
 */
let bootstrapStarted = false;
async function bootstrap() {
  // 幂等：macOS activate 等场景可能重复触发，避免重复分配端口/重启后端
  if (bootstrapStarted) return;
  bootstrapStarted = true;
  try {
    // 1. 分配后端 jar 端口
    if (!backendPort) {
      backendPort = await findAvailablePort();
      console.log(`[gourd-ai-desktop] 后端端口: ${backendPort}`);
    }

    // 2. 启动 Java 子进程
    const { pid } = await startBackend(backendPort);
    console.log(`[gourd-ai-desktop] 后端已启动, PID=${pid}`);

    // 3. 等待就绪（此期间界面外壳已可见，仅 /web/** 接口请求在 UI 服务器挂起等待）
    console.log('[gourd-ai-desktop] 等待后端就绪...');
    await waitForBackend(backendPort, 60000);
    console.log('[gourd-ai-desktop] 后端就绪');

    // 4. 放行代理请求并通知渲染层刷新
    settleBackendReady(true);
  } catch (err) {
    console.error('[gourd-ai-desktop] 启动失败:', err.message);
    // 让挂起中的 /web/** 代理请求尽快得到 503，而不是一直等到超时
    settleBackendReady(false);
    // 通知渲染层展示错误横幅（外壳已加载，直接注入提示即可）
    const errMsg = String(err.message || err).replace(/`/g, '\\`');
    broadcastToRenderer('backend-failed', { message: errMsg });
  }
}

// ─── Electron 生命周期 ──────────────────────────────────────────────────────

// 主题色映射，与 web 端 theme.css 的 --bg-main 保持一致。
// 注意：color 必须用不透明的实际标题栏背景色，而不能用透明色——
// Windows 按 color 的亮度推导窗口按钮的 hover 底色：透明黑会被判为深色背景，
// hover 给白色高亮，在亮色（白底）下白上白完全不可见。
const THEME_COLORS = {
  light: { color: '#ffffff', symbolColor: '#1a1a2e', height: 36 },
  dark:  { color: '#1a1b1e', symbolColor: '#dcdde1', height: 36 },
};

ipcMain.on('theme-changed', (event, theme) => {
  // 同步发送方窗口的标题栏颜色
  const sender = event && event.sender;
  const win = sender && !sender.isDestroyed() ? BrowserWindow.fromWebContents(sender) : mainWindow;
  // setTitleBarOverlay 仅 Windows 支持；macOS 上该方法不存在，
  // 直接调用会抛 TypeError 导致主进程未捕获异常（连带后端引导中断）。
  if (win && !win.isDestroyed() && typeof win.setTitleBarOverlay === 'function') {
    const colors = THEME_COLORS[theme] || THEME_COLORS.dark;
    win.setTitleBarOverlay(colors);
  }
});


// 渲染层定制窗口标题（如显示当前项目名；Electron 禁用了页面 title 覆盖）
ipcMain.on('window-title-update', (event, title) => {
  const sender = event && event.sender;
  const win = sender && !sender.isDestroyed() ? BrowserWindow.fromWebContents(sender) : null;
  if (win) win.setTitle(String(title || 'GWork'));
});

// 渲染层主动查询后端就绪状态（'pending' | 'ready' | 'failed'）。
// 与 backend-ready/backend-failed 事件互补，消除“事件早于监听器注册”的启动竞态。
ipcMain.handle('get-backend-state', () => backendReadyState);

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null); // 去掉原生菜单栏

  // 放行媒体权限（摄像头/麦克风）——Electron 默认拒绝，即使 localhost 也需显式允许。
  // 仅放行本地 UI origin 的 media 请求，其余照常。
  const allowMedia = (perm) => perm === 'media' || perm === 'mediaKeySystem'
      || perm === 'audioCapture' || perm === 'videoCapture';
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => {
    cb(allowMedia(perm));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => allowMedia(perm));

  // 起本地 UI 服务器（http://localhost:{uiPort}）——立即可提供静态外壳（秒开），
  // /web/** 与 WebSocket 反向代理到后端 jar（就绪前挂起等待）。
  try {
    uiServerHandle = await uiServer.start({
      getBackendPort: () => backendPort,
      awaitBackend: awaitBackendReady,
    });
    uiOrigin = uiServerHandle.origin;
    console.log(`[gourd-ai-desktop] UI 服务器: ${uiOrigin}`);
  } catch (e) {
    console.error('[gourd-ai-desktop] UI 服务器启动失败:', e && e.message);
  }

  createMainWindow();
  createTray();
  bootstrap();

  // 自动更新：注册 IPC、启动延迟首检与周期复检（仅打包态生效，见 updater.js）。
  // 状态变化经 updater-state 广播到所有窗口，设置页"关于与更新"实时展示。
  updater.on('state', (state) => broadcastToRenderer('updater-state', state));
  updater.init();

  // 注册终端命令 `gwork`（写启动器到安装目录的 .gwork/bin 并加入 PATH，指向自带 JRE）。
  // 非阻塞、幂等、自愈；失败只告警不影响 App。仅打包版执行（dev 态无自带 JRE），
  // 可用 GWORK_PROVISION_CLI=1（兼容旧名 GOURDAI_PROVISION_CLI）在开发时强制启用以便调试。
  if (app.isPackaged || process.env.GWORK_PROVISION_CLI === '1' || process.env.GOURDAI_PROVISION_CLI === '1') {
    provisionCli().catch((e) => console.warn('[gourd-ai-desktop] 终端命令注册异常:', e && e.message));
  }
});

// macOS 点击 dock 图标恢复窗口
app.on('activate', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
  } else {
    // 窗口被销毁后重建：重新加载本地 UI 服务器地址（服务器仍在运行）。
    // 后端若已就绪，bootstrap() 因幂等直接返回，UI 服务器照常代理接口。
    createMainWindow();
    bootstrap();
  }
});

// 窗口全部关闭时不退出（托盘仍在运行）
app.on('window-all-closed', () => {
  // do nothing — 通过托盘菜单"退出"才真正退出
});

// 退出前清理后端进程。
// 注意：清理完成后必须重新 app.quit() 走正常退出序列（而不是 app.exit(0)）——
// app.exit() 不会发出 'quit' 事件，而 electron-updater 恰在 'quit' 事件里
// 静默安装已下载的更新，绕过会导致"退出时自动安装更新"失效。
let quitCleanupStarted = false;
app.on('before-quit', (event) => {
  if (quitCleanupStarted) return; // 清理已做完，放行正常退出序列（will-quit → quit）
  event.preventDefault();
  isQuitting = true;
  quitCleanupStarted = true;

  // 兜底：清理卡死时强制退出（unref 使其不阻塞正常退出后的进程终止）
  const guard = setTimeout(() => app.exit(0), 10000);
  if (typeof guard.unref === 'function') guard.unref();

  (async () => {
    if (uiServerHandle) {
      try { uiServerHandle.close(); } catch (e) { /* ignore */ }
    }
    try { await stopBackend(); } catch (e) { /* ignore */ }
    app.quit();
  })();
});

// 第二个实例启动时显示已有窗口
app.on('second-instance', () => {
  showAllWindows();
});
