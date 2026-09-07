'use strict';

/**
 * Windows packaged startup migrates legacy/resource data before the backend and
 * CLI are started; development and macOS path behavior remain unchanged.
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

// 主进程日志落盘必须最先安装：backend.js 里的端口分配 / java 探测明细 /
// 探针状态码全靠 console，晚一步安装就丢一段关键现场。
const desktopLog = require('./desktop-log');
desktopLog.install();

const {
  findAvailablePort,
  startBackend,
  waitForBackend,
  stopBackend,
  getServerLogPath,
  getResourcesDir,
  getRuntimeHomeDir,
  getBackendPid,
  isBackendAlive,
  getLastProbe,
  onBackendExit,
  verifyBuildIdentity,
} = require('./backend');
const uiServer = require('./ui-server');
const { provisionCli } = require('./cli-provision');
const updater = require('./updater');
const titlebar = require('./titlebar');

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

// ─── 自动重启 / 状态详情（新增于 2026-09-06）────────────────────────────────
/** 最近一次失败原因（透传给前端横幅与状态详情 IPC） */
let backendLastError = '';
/** 自动重启退避表（毫秒）。耗尽后不再重试，等用户手动重试或重启应用。 */
const AUTO_RESTART_DELAYS = [1000, 3000, 10000, 30000, 60000];
let autoRestartAttempt = 0;
let autoRestartTimer = null;
/** 重启串行锁：并发 restart（自动 + 手动 + 退出监听）只允许一个在跑 */
let backendRestarting = false;

function safeCall(fn) {
  try {
    return fn();
  } catch (e) {
    return `<不可用: ${e && e.message}>`;
  }
}

/**
 * 标记后端就绪结果，唤醒所有等待者，并通知渲染层。
 *
 * 【2026-09-06 修正】旧实现开头是 `if (backendReadyState !== 'pending') return;`
 * —— 单向闩锁。一旦引导失败就永久锁在 'failed'，UI 代理对每个 /web/** 请求
 * 固定返回 503「后端启动中，请稍候…」，即使后来后端已恢复也不会放行；
 * 叠加 bootstrap() 的幂等锁使重探无从发起，表现为「覆盖安装后接口永远不通」。
 * 现在状态可双向迁移；幂等靠 bootstrap 锁与 backendRestarting 串行锁保障，
 * 而不是靠状态机自己拒绝迁移。
 *
 * @param {boolean} ok
 * @param {string} [reason] 失败原因（ok=false 时携带）
 */
function settleBackendReady(ok, reason) {
  const prev = backendReadyState;
  if (ok) {
    backendReadyState = 'ready';
    backendLastError = '';
  } else {
    backendReadyState = 'failed';
    if (reason) backendLastError = String(reason);
  }

  const waiters = backendReadyWaiters.splice(0);
  for (const w of waiters) w(ok);

  if (ok) {
    // 通知渲染层：后端已就绪（前端据此重连 WebSocket / 触发数据刷新 / 放行启动请求）。
    // 页面可能尚未加载完成，sendToWindow 内部用 did-finish-load 兜底，避免事件丢失。
    if (prev !== 'ready') {
      console.log(`[gourd-ai-desktop] 后端状态迁移: ${prev} -> ready (port=${backendPort})`);
    }
    broadcastToRenderer('backend-ready', { port: backendPort });
  } else {
    console.error(`[gourd-ai-desktop] 后端状态迁移: ${prev} -> failed: ${backendLastError}`);
    broadcastToRenderer('backend-failed', backendFailedPayload());
  }
}

/** 统一的失败负载：除原因外还带上探针状态码、下一次自动重试与日志路径，前端直接可展示。 */
function backendFailedPayload() {
  const probe = getLastProbe();
  return {
    message: backendLastError || '后端启动失败',
    status: probe ? probe.status : 0,
    probeError: probe ? probe.error : '',
    logPath: desktopLog.currentLogPath(),
    serverLogPath: getServerLogPath(),
    autoRetryAttempt: autoRestartAttempt,
    autoRetryMax: AUTO_RESTART_DELAYS.length,
    retrying: backendRestarting,
  };
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
 * 等待后端就绪。ready 立即 true；failed 立即 false；pending 挂起直至 settle 或超时。
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

/** 后端状态快照（供 get-backend-detail IPC）。 */
function backendDetail() {
  return {
    state: backendReadyState,
    port: backendPort,
    uiPort: uiServerHandle ? uiServerHandle.port : 0,
    pid: getBackendPid(),
    alive: isBackendAlive(),
    lastError: backendLastError,
    lastProbe: getLastProbe(),
    restarting: backendRestarting,
    autoRetryAttempt: autoRestartAttempt,
    autoRetryMax: AUTO_RESTART_DELAYS.length,
    logPath: desktopLog.currentLogPath(),
    serverLogPath: getServerLogPath(),
    resourcesDir: safeCall(getResourcesDir),
    runtimeHomeDir: safeCall(getRuntimeHomeDir),
    logInstallError: desktopLog.getInstallError(),
    appVersion: safeCall(() => app.getVersion()),
  };
}

/**
 * 重启后端：停旧进程 → 确保端口 → 启动 → 等就绪 → 恢复 ready。
 * 并发安全（同一时刻只跑一个），失败时重新置 failed 并广播。
 * @param {string} trigger 'auto'（退出监听/引导失败）| 'manual'（用户点重试）
 * @returns {Promise<{ok:boolean, skipped?:boolean, error?:string}>}
 */
async function restartBackend(trigger) {
  if (backendRestarting) {
    return { ok: false, skipped: true, error: '重启已在进行中' };
  }
  if (isQuitting || quitCleanupStarted) {
    return { ok: false, skipped: true, error: '应用正在退出' };
  }
  backendRestarting = true;
  // 重置为 pending：让代理请求走短暂宽限后快速 503，而不是一直拿旧 failed 结论
  backendReadyState = 'pending';
  backendLastError = '';
  const waiters = backendReadyWaiters.splice(0);
  for (const w of waiters) w(false);

  console.log(`[gourd-ai-desktop] 重启后端（trigger=${trigger}，第 ${autoRestartAttempt + 1} 次尝试）`);
  try {
    await stopBackend();
    if (!backendPort) {
      backendPort = await findAvailablePort();
    }
    await startBackend(backendPort);
    await waitForBackend(backendPort, 60000);
    // 成功：清零退避计数，下次意外退出仍从最快间隔重新开始
    autoRestartAttempt = 0;
    settleBackendReady(true);
    return { ok: true };
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    settleBackendReady(false, msg);
    // 【顺序敏感】必须先解锁再排期：scheduleAutoRestart 开头有 `if (backendRestarting) return`，
    // 而此刻仍在 try/catch 内（finally 尚未执行），锁还是 true——在这里直接排期会被自己挡掉，
    // 退避链只跑 1 次就断，5 级退避形同虚设（已用最小复现验证）。
    backendRestarting = false;
    if (trigger === 'auto') scheduleAutoRestart(msg);
    return { ok: false, error: msg };
  } finally {
    // 成功路径与异常路径的兜底解锁；catch 分支已提前置 false，这里重复赋值无副作用
    backendRestarting = false;
  }
}

/**
 * 安排一次指数退避的自动重启；达上限后不再重试，等用户手动重试。
 * @param {string} reason
 */
function scheduleAutoRestart(reason) {
  if (isQuitting || quitCleanupStarted) return;
  if (backendRestarting) return;
  if (autoRestartTimer) return; // 已排期

  if (autoRestartAttempt >= AUTO_RESTART_DELAYS.length) {
    console.error('[gourd-ai-desktop] 自动重启已达上限（' + AUTO_RESTART_DELAYS.length
      + ' 次），停止重试。若为覆盖安装后出现此故障，多半是安装目录未能完全替换（旧 jar/jre 被占用），请卸载后重装。原因: ' + reason);
    broadcastToRenderer('backend-failed', backendFailedPayload());
    return;
  }

  const delay = AUTO_RESTART_DELAYS[autoRestartAttempt];
  autoRestartAttempt += 1;
  console.warn(`[gourd-ai-desktop] ${delay}ms 后发起第 ${autoRestartAttempt} 次自动重启，原因: ${reason}`);
  broadcastToRenderer('backend-failed', backendFailedPayload());
  autoRestartTimer = setTimeout(() => {
    autoRestartTimer = null;
    restartBackend('auto').catch(() => { /* 失败已在 restartBackend 内处理并排期下一次 */ });
  }, delay);
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
    titleBarOverlay: titlebar.THEME_COLORS.dark,
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

  // 登记原生装饰初始状态（构造函数已按 dark 应用过一次，此处只记状态）
  titlebar.initWindowChrome(mainWindow, 'dark');

  // 页面重载 / 渲染进程崩溃后，渲染层的遮罩探测状态归零，主进程必须同步复位，
  // 否则 mac 红绿灯会一直隐藏、Win/Linux 按钮区一直发暗。
  mainWindow.webContents.on('did-start-loading', () => titlebar.resetWindowScrim(mainWindow));
  mainWindow.webContents.on('render-process-gone', () => titlebar.resetWindowScrim(mainWindow));

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
    // 0. 启动现场进日志：排障时先看到「本次到底在看哪份资源」，而不是事后猜
    desktopLog.report('启动环境', [
      `appVersion=${safeCall(() => app.getVersion())} packaged=${app.isPackaged}`,
      `resourcesDir=${safeCall(getResourcesDir)}`,
      `runtimeHome=${safeCall(getRuntimeHomeDir)}`,
      `mainLog=${desktopLog.currentLogPath()}`,
      `serverLog=${safeCall(getServerLogPath)}`,
    ]);

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
    const probeInfo = await waitForBackend(backendPort, 60000);
    console.log(`[gourd-ai-desktop] 后端就绪（轮询 ${probeInfo && probeInfo.attempts} 次）`);

    // 4. 放行代理请求并通知渲染层刷新（广播已收敛在 settleBackendReady 内）
    autoRestartAttempt = 0;
    settleBackendReady(true);

    // 5. 安装一致性自检（失败不阻断使用）：把「jar 没被真正替换」从隐性变成一句明确提示
    try {
      const identity = await verifyBuildIdentity(backendPort);
      if (identity.ok) {
        if (identity.skipped) {
          console.warn(`[gourd-ai-desktop] 跳过安装一致性自检: ${identity.skipped}`);
        } else {
          console.log(`[gourd-ai-desktop] 安装一致性自检通过 buildId=${identity.actual}`);
        }
      } else {
        desktopLog.report('安装一致性告警', [
          `清单记录(期望): ${identity.expected}`,
          `运行中后端(实际): ${identity.actual || '<无 buildId，疑为旧 jar>'}`,
          `原因: ${identity.reason}`,
          `resourcesDir=${safeCall(getResourcesDir)}`,
        ]);
        broadcastToRenderer('install-mismatch', identity);
      }
    } catch (e) {
      console.warn('[gourd-ai-desktop] 安装一致性自检异常:', e && e.message);
    }
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    console.error('[gourd-ai-desktop] 启动失败:', msg);
    // 让挂起中的 /web/** 代理请求尽快得到 503（带真实原因），并排期自动重试
    settleBackendReady(false, msg);
    scheduleAutoRestart(msg);
  }
}

// 后端子进程意外退出 → 状态复位 + 自动重启。
// 旧实现只在 console 打一行（而主进程 console 根本不落盘），界面毫无反应：
// 状态仍是 'ready'，代理照放行，但每个 /web/** 都是 502，用户只看到“接口神秘不通”。
onBackendExit((info) => {
  if (info.expected) return; // stopBackend 主动停止（重启流程/退出应用）不触发
  const detail = `后端进程意外退出 (PID=${info.pid}, code=${info.code}, signal=${info.signal}`
    + `${info.error ? ', error=' + info.error : ''})`;
  console.error(`[gourd-ai-desktop] ${detail}`);
  settleBackendReady(false, detail);
  scheduleAutoRestart(detail);
});

// ─── Electron 生命周期 ──────────────────────────────────────────────────────

/** 取发送方窗口（已销毁则退回主窗口）。 */
function senderWindow(event) {
  const sender = event && event.sender;
  const win = sender && !sender.isDestroyed() ? BrowserWindow.fromWebContents(sender) : null;
  return win || mainWindow;
}

// 主题切换：同步发送方窗口的标题栏颜色（主题色表、平台差异、遮罩叠加均见 main/titlebar.js）
ipcMain.on('theme-changed', (event, theme) => {
  titlebar.setWindowTheme(senderWindow(event), theme);
});

// 全屏遮罩开关：原生窗口按钮由系统框架层绘制，DOM 遮罩盖不住（WCO 规范），
// 改由主进程把按钮区跟着一起压暗（探测与上报见 main/preload.js）。
ipcMain.on('ui-scrim-changed', (event, color) => {
  titlebar.setWindowScrim(senderWindow(event), typeof color === 'string' ? color : null);
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

// 完整状态详情：端口、PID、存活、最近探针结果、失败原因、两份日志路径、资源目录。
// 前端错误条与排障都靠它“一句话说清”，不必再让用户开 devtools 猜。
ipcMain.handle('get-backend-detail', () => backendDetail());

// 手动重试（错误条上的「重试」按钮）：重置退避计数，给用户一个从头再来的确定性。
ipcMain.handle('restart-backend', async () => {
  autoRestartAttempt = 0;
  if (autoRestartTimer) {
    clearTimeout(autoRestartTimer);
    autoRestartTimer = null;
  }
  return restartBackend('manual');
});

/**
 * macOS 全局菜单栏不允许移除：Electron 内部实现中 darwin 分支对 null 直接 return，
 * 不会清掉已安装的菜单（后果是始终残留默认的 File/Edit/View/Window/Help）。
 * 因此 macOS 安装一个精简菜单替代默认菜单；Windows/Linux 置 null 整体隐藏。
 * 保留 Edit/Cmd+C/Cmd+V 等系统编辑快捷键，避免 null 菜单导致复制粘贴失效。
 */
function installAppMenu() {
  if (process.platform === 'darwin') {
    const template = [
      {
        label: app.name,
        submenu: [{ role: 'quit' }],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'Window',
        submenu: [{ role: 'minimize' }, { role: 'close' }],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  } else {
    Menu.setApplicationMenu(null); // 非 mac 平台去掉原生菜单栏
  }
}

app.whenReady().then(async () => {
  installAppMenu();

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
      // 让 503 能区分「启动中」与「已判定失败」并携带真实原因（见 ui-server.js buildReject）
      getBackendDetail: backendDetail,
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

  // 注册终端命令 `gwork`（写启动器到用户主目录 ~/.gwork/bin 并加入 PATH，指向自带 JRE）。
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

  // 取消未到期/周期性的自动重启，避免退出过程中又被拉起一个新后端
  if (autoRestartTimer) {
    clearTimeout(autoRestartTimer);
    autoRestartTimer = null;
  }

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
