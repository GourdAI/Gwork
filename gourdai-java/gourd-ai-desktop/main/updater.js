'use strict';

/**
 * main/updater.js — GWork 桌面端自动更新模块（electron-updater，方案A）
 *
 * 平台策略：
 * - Windows NSIS / Linux AppImage → mode='auto'：全自动（检测 → 后台下载（blockmap 差分）
 *   → 退出时静默安装 或 用户点击"安装并重启"）。
 * - macOS（未代码签名无法静默安装）/ Linux deb 等 → mode='notify'：仅检测，
 *   发现新版后提示并引导浏览器下载安装包（downloadUrl 从 latest-*.yml 产物解析）。
 * - 开发态（app.isPackaged === false）→ mode='none'：完全不启用。
 *
 * 更新源：generic provider —— https://www.gourdwork.com/downloads/
 * 与官网下载目录同址，需托管 latest.yml / latest-mac.yml / latest-linux.yml + 安装包 + *.blockmap。
 * 发新版在打包机跑 npm run publish:downloads 后上传 downloads/ 目录即可（官网与更新源一次同步）。
 * 可用环境变量 GWORK_UPDATE_URL 覆盖（换源/内网灰度无需改代码）。
 *
 * 状态机 status: idle | checking | available | not-available | downloading | downloaded | error
 *
 * IPC 约定（渲染层桥见 preload.js）：
 *   invoke  updater-get-version → 桌面端版本号（app.getVersion()）
 *   invoke  updater-get-state   → 当前状态快照
 *   invoke  updater-check       → 手动检查更新
 *   invoke  updater-download    → 重试下载（auto 模式）/ 打开下载页（notify 模式）
 *   invoke  updater-install     → 安装并重启（auto 模式）/ 打开下载页（notify 模式）
 *   event   updater-state       → 主进程 → 渲染层广播，payload 同状态快照
 */

const { app, ipcMain, shell } = require('electron');
const EventEmitter = require('events');

const DEFAULT_FEED_URL = 'https://www.gourdwork.com/downloads/';
const HOMEPAGE_URL = 'https://www.gourdwork.com/';
// 启动后延迟首检（避免与后端启动抢带宽），之后周期性复检
const STARTUP_CHECK_DELAY_MS = 15 * 1000;
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function normalizeFeedUrl(url) {
  let u = String(url || '').trim();
  if (!u) u = DEFAULT_FEED_URL;
  if (!/^[a-z]+:\/\//i.test(u)) u = 'https://' + u;
  if (!/\/$/.test(u)) u += '/';
  return u;
}

/** updateInfo.releaseNotes 可能为字符串或 [{version, note}] 数组，归一化为字符串。 */
function normalizeNotes(notes) {
  if (!notes) return '';
  if (typeof notes === 'string') return notes;
  if (Array.isArray(notes)) {
    return notes
      .map((n) => (n && (n.note || n.text)) || '')
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

class DesktopUpdater extends EventEmitter {
  constructor() {
    super();
    this.feedUrl = normalizeFeedUrl(process.env.GWORK_UPDATE_URL);
    this.mode = 'none';        // 'auto' | 'notify' | 'none'
    this.status = 'idle';
    this.version = null;       // 检测到的新版本号
    this.releaseNotes = '';
    this.downloadUrl = '';     // notify 模式引导下载用（auto 模式也填充，备用）
    this.progress = null;      // { percent, bytesPerSecond, transferred, total }
    this.error = '';
    this.lastCheckManual = false;
    this.autoUpdater = null;
    this.started = false;
  }

  getState() {
    return {
      mode: this.mode,
      status: this.status,
      version: this.version,
      currentVersion: app.getVersion(),
      releaseNotes: this.releaseNotes,
      downloadUrl: this.downloadUrl,
      progress: this.progress,
      error: this.error,
      feedUrl: this.feedUrl,
      lastCheckManual: this.lastCheckManual,
    };
  }

  broadcast() {
    this.emit('state', this.getState());
  }

  /** 平台能力判定：哪些平台能"下载+静默安装"，哪些只能"检测+引导下载"。 */
  resolveMode() {
    if (!app.isPackaged) return 'none';
    if (process.platform === 'win32') return 'auto';
    // macOS 自动安装依赖代码签名+公证，当前包未签名，降级为通知引导
    if (process.platform === 'darwin') return 'notify';
    // Linux：仅 AppImage 运行时支持自更新；deb 等包管理器安装降级为通知
    if (process.platform === 'linux' && process.env.APPIMAGE) return 'auto';
    return 'notify';
  }

  /** 注册 IPC 并启动更新调度。幂等。 */
  init() {
    if (this.started) return;
    this.started = true;

    this.registerIpc();
    this.mode = this.resolveMode();
    if (this.mode === 'none') {
      this.broadcast();
      return;
    }

    let autoUpdater;
    try {
      autoUpdater = require('electron-updater').autoUpdater;
    } catch (e) {
      console.error('[updater] electron-updater 不可用，更新功能禁用:', e && e.message);
      this.mode = 'none';
      this.broadcast();
      return;
    }
    this.autoUpdater = autoUpdater;

    // 日志走主进程 console（随 backend 日志同域可见）
    autoUpdater.logger = console;
    // auto 模式：检测到新版自动后台下载；退出时若已下载完成则静默安装。
    // notify 模式：只检测不下载（下载了也装不上，纯浪费流量）。
    autoUpdater.autoDownload = this.mode === 'auto';
    autoUpdater.autoInstallOnAppQuit = this.mode === 'auto';
    autoUpdater.allowDowngrade = false;
    try {
      autoUpdater.setFeedURL({ provider: 'generic', url: this.feedUrl, channel: 'latest' });
    } catch (e) {
      console.error('[updater] setFeedURL 失败:', e && e.message);
    }

    this.bindEvents(autoUpdater);

    // 延迟首检 + 周期复检（应用常驻托盘，复检保证长跑进程也能收到新版本）
    setTimeout(() => { this.check(false).catch(() => {}); }, STARTUP_CHECK_DELAY_MS);
    setInterval(() => { this.check(false).catch(() => {}); }, RECHECK_INTERVAL_MS);

    this.broadcast();
  }

  bindEvents(au) {
    au.on('checking-for-update', () => {
      this.status = 'checking';
      this.error = '';
      this.progress = null;
      this.broadcast();
    });

    au.on('update-available', (info) => {
      this.status = 'available';
      this.version = (info && info.version) || '';
      this.releaseNotes = normalizeNotes(info && info.releaseNotes);
      this.downloadUrl = this.pickDownloadUrl(info);
      this.broadcast();
    });

    au.on('update-not-available', (info) => {
      this.status = 'not-available';
      this.version = (info && info.version) || null;
      this.releaseNotes = '';
      this.progress = null;
      this.broadcast();
    });

    au.on('download-progress', (p) => {
      this.status = 'downloading';
      this.progress = {
        percent: p && isFinite(p.percent) ? Math.round(p.percent * 10) / 10 : 0,
        bytesPerSecond: (p && p.bytesPerSecond) || 0,
        transferred: (p && p.transferred) || 0,
        total: (p && p.total) || 0,
      };
      this.broadcast();
    });

    au.on('update-downloaded', (info) => {
      this.status = 'downloaded';
      this.version = (info && info.version) || this.version;
      this.progress = null;
      this.broadcast();
    });

    au.on('error', (err) => {
      const msg = String((err && (err.message || err)) || 'unknown error');
      console.error('[updater] error:', msg);
      // 已下载完成后的缓存校验类错误不应回退状态（安装包仍在，随时可装）
      if (this.status === 'downloaded') return;
      this.status = 'error';
      this.error = msg;
      this.progress = null;
      this.broadcast();
    });
  }

  /**
   * 从 updateInfo.files 里挑一个引导下载产物：
   * mac 按当前架构选 dmg；linux 选 AppImage；win 选 exe；相对 URL 拼 feed 基址。
   */
  pickDownloadUrl(info) {
    const files = (info && info.files) || [];
    if (!files.length) return HOMEPAGE_URL;

    let pool = files;
    if (process.platform === 'darwin') {
      const dmgs = files.filter((f) => /\.dmg$/i.test(String(f.url || '')));
      if (dmgs.length) pool = dmgs;
      const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
      const hit = pool.find((f) => String(f.url || '').indexOf(arch) >= 0);
      return this.absUrl((hit || pool[0] || {}).url);
    }
    if (process.platform === 'linux') {
      const appimage = files.find((f) => /\.AppImage$/i.test(String(f.url || '')));
      return this.absUrl(((appimage || files[0]) || {}).url);
    }
    const exe = files.find((f) => /\.exe$/i.test(String(f.url || '')));
    return this.absUrl(((exe || files[0]) || {}).url);
  }

  absUrl(u) {
    const url = String(u || '');
    if (!url) return HOMEPAGE_URL;
    if (/^https?:\/\//i.test(url)) return url;
    return this.feedUrl + url.replace(/^\/+/, '');
  }

  /**
   * 检查更新。
   * @param {boolean} manual 是否用户手动触发（影响错误提示策略）
   */
  async check(manual) {
    this.lastCheckManual = !!manual;
    if (!this.autoUpdater) {
      this.broadcast();
      return this.getState();
    }
    try {
      await this.autoUpdater.checkForUpdates();
    } catch (e) {
      // 通常 error 事件已先行触发；此处兜底确保状态可见
      if (this.status !== 'downloaded') {
        this.status = 'error';
        this.error = String((e && e.message) || e);
        this.broadcast();
      }
    }
    return this.getState();
  }

  /** 重试下载（auto 模式）；notify 模式直接打开下载页。 */
  download() {
    if (this.mode === 'notify') {
      this.openDownloadPage();
      return this.getState();
    }
    if (this.autoUpdater && (this.status === 'available' || this.status === 'error')) {
      this.autoUpdater.downloadUpdate().catch((e) => {
        this.status = 'error';
        this.error = String((e && e.message) || e);
        this.broadcast();
      });
    }
    return this.getState();
  }

  /** 安装并重启（auto 模式）；notify 模式打开下载页。 */
  install() {
    if (this.mode !== 'auto' || !this.autoUpdater) {
      this.openDownloadPage();
      return;
    }
    if (this.status !== 'downloaded') return;
    try {
      // 静默安装 + 安装完成后自动拉起新版（NSIS 参数：--updated /S --force-run）。
      // 内部会走我们的 before-quit 清理流程（停后端），installer.nsh 钩子保证 .gwork 配置不丢。
      this.autoUpdater.quitAndInstall(true, true);
    } catch (e) {
      this.status = 'error';
      this.error = String((e && e.message) || e);
      this.broadcast();
    }
  }

  openDownloadPage() {
    const url = this.downloadUrl || HOMEPAGE_URL;
    Promise.resolve(shell.openExternal(url)).catch(() => {});
  }

  registerIpc() {
    ipcMain.handle('updater-get-version', () => app.getVersion());
    ipcMain.handle('updater-get-state', () => this.getState());
    ipcMain.handle('updater-check', () => this.check(true));
    ipcMain.handle('updater-download', () => this.download());
    ipcMain.handle('updater-install', () => {
      this.install();
      return this.getState();
    });
  }
}

module.exports = new DesktopUpdater();
