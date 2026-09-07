//! updater.rs — GWork 桌面端自动更新模块（tauri-plugin-updater 2.x，对应 Electron 版 main/updater.js）
//!
//! 平台策略（与 Electron 版一致）：
//! - Windows NSIS → mode='auto'：检查 → 后台下载 → 用户点击"安装并重启"（NSIS /UPDATE，装完自动拉起）。
//! - Linux AppImage（运行时存在 APPIMAGE 环境变量）→ mode='auto'：同上，安装后 restart 生效。
//! - macOS（未代码签名无法静默安装）/ Linux deb 等其他包 → mode='notify'：仅检测，
//!   发现新版后由渲染层提示，updater_download/updater_install 引导浏览器打开下载页。
//! - 开发态（debug_assertions）→ mode='none'：完全不启用。
//!
//! 更新源：https://www.gourdwork.com/downloads/（静态 latest.json，见 tauri.conf.json plugins.updater），
//! 可用环境变量 GWORK_UPDATE_URL 覆盖（换源/内网灰度无需改代码）。
//!
//! 状态机 status: idle | checking | available | not-available | downloading | downloaded | error
//!
//! IPC 约定（渲染层）：
//!   command updater_get_version → 桌面端版本号
//!   command updater_get_state   → 当前状态快照（serde_json::Value）
//!   command updater_check       → 手动检查更新
//!   command updater_download    → 重试下载（auto 模式）/ 打开下载页（notify 模式）
//!   command updater_install     → 安装并重启（auto 模式）/ 打开下载页（notify 模式）
//!   event   "updater-state"     → 主进程 → 所有窗口广播，payload 同状态快照

use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use lazy_static::lazy_static;
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};
use tracing::{info, warn};

const DEFAULT_FEED_URL: &str = "https://www.gourdwork.com/downloads/";
const HOMEPAGE_URL: &str = "https://www.gourdwork.com/";
/// 启动后延迟首检（避免与后端启动抢带宽），之后周期性复检
const STARTUP_CHECK_DELAY: Duration = Duration::from_secs(15);
const RECHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// 单次更新检查/下载的网络超时
const UPDATER_TIMEOUT: Duration = Duration::from_secs(60);

// ─── 状态快照 ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Auto,
    Notify,
    None,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Mode::Auto => "auto",
            Mode::Notify => "notify",
            Mode::None => "none",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Status {
    Idle,
    Checking,
    Available,
    NotAvailable,
    Downloading,
    Downloaded,
    Error,
}

impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Status::Idle => "idle",
            Status::Checking => "checking",
            Status::Available => "available",
            Status::NotAvailable => "not-available",
            Status::Downloading => "downloading",
            Status::Downloaded => "downloaded",
            Status::Error => "error",
        }
    }
}

/// 下载进度（与 Electron 版 download-progress 载荷一致）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub percent: f64,
    pub bytes_per_second: u64,
    pub transferred: u64,
    pub total: u64,
}

/// 渲染层可见的完整状态快照（字段名与 Electron 版 getState() 一致）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateSnapshot {
    pub mode: String,
    pub status: String,
    pub version: Option<String>,
    pub current_version: String,
    pub release_notes: String,
    pub download_url: String,
    pub progress: Option<Progress>,
    pub error: String,
    pub feed_url: String,
    pub last_check_manual: bool,
}

/// 下载完成的安装包缓存（auto 模式，供 updater_install 使用）。
struct DownloadedPkg {
    update: Update,
    bytes: Vec<u8>,
}

/// DesktopUpdater —— 自动更新状态机（对应 Electron 版 DesktopUpdater 类）。
pub struct DesktopUpdater {
    /// 更新源基址（目录形式，以 '/' 结尾）
    feed_url: String,
    /// 'auto' | 'notify' | 'none'
    mode: Mode,
    /// 状态机主状态
    status: Status,
    /// 检测到的新版本号
    version: Option<String>,
    /// 更新日志（latest.json 的 notes 字段）
    release_notes: String,
    /// notify 模式引导下载用（auto 模式也填充，备用）
    download_url: String,
    /// 下载进度
    progress: Option<Progress>,
    /// 最近一次错误描述
    error: String,
    /// 最近一次检查是否由用户手动触发
    last_check_manual: bool,
    /// 已检测到、等待下载/安装的更新对象
    pending_update: Option<Update>,
    /// 已下载完成的安装包（auto 模式，install 时直接落盘）
    downloaded: Option<DownloadedPkg>,
    /// 下载进度内部计时（bytesPerSecond 估算 + 广播节流）
    downloaded_bytes: u64,
    download_started: Option<Instant>,
    last_broadcast: Option<Instant>,
    /// 幂等启动标记
    started: bool,
}

impl DesktopUpdater {
    fn new() -> Self {
        Self {
            feed_url: normalize_feed_url(std::env::var("GWORK_UPDATE_URL").ok().as_deref()),
            mode: Mode::None,
            status: Status::Idle,
            version: None,
            release_notes: String::new(),
            download_url: String::new(),
            progress: None,
            error: String::new(),
            last_check_manual: false,
            pending_update: None,
            downloaded: None,
            downloaded_bytes: 0,
            download_started: None,
            last_broadcast: None,
            started: false,
        }
    }

    fn snapshot(&self, app: &AppHandle) -> StateSnapshot {
        StateSnapshot {
            mode: self.mode.as_str().to_string(),
            status: self.status.as_str().to_string(),
            version: self.version.clone(),
            current_version: app.package_info().version.to_string(),
            release_notes: self.release_notes.clone(),
            download_url: self.download_url.clone(),
            progress: self.progress.clone(),
            error: self.error.clone(),
            feed_url: self.feed_url.clone(),
            last_check_manual: self.last_check_manual,
        }
    }

    /// 平台能力判定：哪些平台能"下载+静默安装"，哪些只能"检测+引导下载"。
    ///
    /// `plugin_ready` 表示 tauri-plugin-updater 是否已注册（见 `is_plugin_registered`）。
    /// 未注册时**必须**退回 None：本模块所有联网路径最终都会走 `app.updater_builder()`，
    /// 而它内部是 `state::<UpdaterState>()`——该状态仅由插件 setup 注册，缺失时 Tauri
    /// 直接 panic（"state() called before manage()"）。release profile 配了
    /// `panic = "abort"`，于是 panic 不会被 catch，整个进程带 0xC0000409 崩掉。
    fn resolve_mode(plugin_ready: bool) -> Mode {
        // 开发态（对应 Electron 版 app.isPackaged === false）
        if cfg!(debug_assertions) {
            return Mode::None;
        }
        // 插件未注册（缺 plugins.updater 配置/未生成签名密钥对）→ 彻底关闭自动更新
        if !plugin_ready {
            return Mode::None;
        }
        // Windows NSIS：全自动
        if cfg!(target_os = "windows") {
            return Mode::Auto;
        }
        // macOS 自动安装依赖代码签名+公证，当前包未签名，降级为通知引导
        if cfg!(target_os = "macos") {
            return Mode::Notify;
        }
        // Linux：仅 AppImage 运行时支持自更新；deb 等包管理器安装降级为通知
        if cfg!(target_os = "linux") && std::env::var_os("APPIMAGE").is_some() {
            return Mode::Auto;
        }
        Mode::Notify
    }
}

lazy_static! {
    static ref UPDATER: Mutex<DesktopUpdater> = Mutex::new(DesktopUpdater::new());
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

fn normalize_feed_url(url: Option<&str>) -> String {
    let mut u = url.unwrap_or("").trim().to_string();
    if u.is_empty() {
        u = DEFAULT_FEED_URL.to_string();
    }
    if !u.to_ascii_lowercase().starts_with("http://") && !u.to_ascii_lowercase().starts_with("https://") {
        u = format!("https://{}", u);
    }
    if !u.ends_with('/') {
        u.push('/');
    }
    u
}

fn lock() -> std::sync::MutexGuard<'static, DesktopUpdater> {
    UPDATER.lock().unwrap_or_else(|e| e.into_inner())
}

fn snapshot_with(app: &AppHandle) -> StateSnapshot {
    lock().snapshot(app)
}

/// 向所有窗口广播 updater-state 事件，payload 为当前状态快照。
///
/// 走 ipc_bridge 而非 Tauri 事件系统：页面由本地 HTTP 服务器提供，属远程源，
/// 前端通过 __GOURD_IPC__.onUpdaterState 订阅（对齐 Electron 版契约）。
fn broadcast(app: &AppHandle) {
    let snap = snapshot_with(app);
    crate::ipc_bridge::emit(app, "updater-state", &snap);
}

fn broadcast_throttled(app: &AppHandle) {
    {
        let mut inner = lock();
        let now = Instant::now();
        if let Some(last) = inner.last_broadcast {
            if now.duration_since(last) < Duration::from_millis(100) {
                return;
            }
        }
        inner.last_broadcast = Some(now);
    }
    broadcast(app);
}

fn set_error(app: &AppHandle, msg: impl Into<String>) {
    {
        let mut inner = lock();
        // 已下载完成后的缓存校验类错误不应回退状态（安装包仍在，随时可装）
        if inner.status == Status::Downloaded {
            return;
        }
        inner.status = Status::Error;
        inner.error = msg.into();
        inner.progress = None;
    }
    broadcast(app);
}

// ─── 核心流程 ─────────────────────────────────────────────────────────────────

/// 检查更新。manual=true 表示用户手动触发（影响错误提示策略）。
async fn do_check(app: AppHandle, manual: bool) -> Result<()> {
    {
        let mut inner = lock();
        inner.last_check_manual = manual;
        if inner.mode == Mode::None {
            drop(inner);
            broadcast(&app);
            return Ok(());
        }
        // checking-for-update
        inner.status = Status::Checking;
        inner.error.clear();
        inner.progress = None;
    }
    broadcast(&app);

    let feed_url = lock().feed_url.clone();
    let endpoint = format!("{}latest.json", feed_url.trim_end_matches('/'));

    // 早期错误（地址非法 / 更新器构建失败）也必须走 set_error。
    // 此处 status 已置 Checking、前端按钮已 disabled，若直接用 `?` 把错误抛给调用方，
    // 状态会永久停在 checking —— 页面死锁，用户再也点不动"检查更新"。
    let built = (|| -> Result<tauri_plugin_updater::Updater> {
        let endpoint_url = endpoint
            .parse()
            .map_err(|e| anyhow!("更新源地址无效 {}: {}", endpoint, e))?;
        app.updater_builder()
            .endpoints(vec![endpoint_url])
            .map_err(|e| anyhow!("配置更新源失败: {}", e))?
            .timeout(UPDATER_TIMEOUT)
            .build()
            .map_err(|e| anyhow!("构建更新器失败: {}", e))
    })();

    let updater = match built {
        Ok(u) => u,
        Err(e) => {
            let msg = format!("{:#}", e);
            warn!("[updater] 初始化更新器失败: {}", msg);
            set_error(&app, msg);
            return Ok(());
        }
    };

    let result = updater.check().await;

    match result {
        Ok(Some(update)) => {
            // update-available
            let version = update.version.clone();
            let notes = update.body.clone().unwrap_or_default();
            let download_url = update.download_url.to_string();
            info!("[updater] 发现新版本: {}", version);
            {
                let mut inner = lock();
                inner.status = Status::Available;
                inner.version = Some(version);
                inner.release_notes = notes;
                inner.download_url = download_url;
                inner.pending_update = Some(update);
            }
            broadcast(&app);
        }
        Ok(None) => {
            // update-not-available
            {
                let mut inner = lock();
                inner.status = Status::NotAvailable;
                // 已下载完成的安装包依然有效，不清版本号；否则回退到"无新版本"
                if inner.downloaded.is_none() {
                    inner.version = None;
                }
                inner.release_notes.clear();
                inner.progress = None;
                inner.pending_update = None;
            }
            broadcast(&app);
        }
        Err(e) => {
            let msg = e.to_string();
            warn!("[updater] 检查更新失败: {}", msg);
            set_error(&app, msg);
        }
    }
    Ok(())
}

/// auto 模式下检测到新版本后立即后台下载（对应 electron-updater autoDownload=true）。
///
/// 必须在**每一条** check 路径之后调用（首检 / 周期复检 / 手动检查）：
/// 前端 auto 模式在 status='available' 时渲染的是 disabled 的"正在自动下载"按钮，
/// 没有任何可点入口。若只挂在周期循环里，用户手动检查到新版后界面会显示
/// "正在下载"却实际静止，最长要等 RECHECK_INTERVAL（6h）才真正开始。
async fn auto_download_if_needed(app: &AppHandle) {
    let should_download = {
        let inner = lock();
        inner.mode == Mode::Auto && inner.status == Status::Available
    };
    if should_download {
        if let Err(e) = do_download(app.clone()).await {
            warn!("[updater] 自动下载更新失败: {}", e);
        }
    }
}

/// 下载安装包（auto 模式）。重复调用时若已在下载中或已下载完成则直接返回。
async fn do_download(app: AppHandle) -> Result<()> {
    let update = {
        let mut inner = lock();
        match inner.status {
            Status::Downloading | Status::Downloaded => return Ok(()),
            _ => {}
        }
        match inner.pending_update.clone() {
            Some(u) => {
                inner.status = Status::Downloading;
                inner.error.clear();
                inner.downloaded_bytes = 0;
                inner.download_started = Some(Instant::now());
                inner.progress = Some(Progress {
                    percent: 0.0,
                    bytes_per_second: 0,
                    transferred: 0,
                    total: 0,
                });
                u
            }
            None => {
                inner.error = "没有可下载的更新".to_string();
                drop(inner);
                broadcast(&app);
                return Err(anyhow!("没有可下载的更新"));
            }
        }
    };
    broadcast(&app);

    // download-progress（克隆 AppHandle 进回调，分块进度实时广播，100ms 节流）
    let progress_app = app.clone();
    let finish_app = app.clone();
    let result = update
        .download(
            move |chunk_length, content_length| {
                let mut inner = lock();
                inner.downloaded_bytes += chunk_length as u64;
                let transferred = inner.downloaded_bytes;
                let total = content_length.unwrap_or(0);
                let percent = if total > 0 {
                    let p = transferred as f64 * 100.0 / total as f64;
                    (p * 10.0).round() / 10.0
                } else {
                    0.0
                };
                let bytes_per_second = inner
                    .download_started
                    .map(|t| {
                        let secs = t.elapsed().as_secs_f64();
                        if secs > 0.0 {
                            (transferred as f64 / secs) as u64
                        } else {
                            0
                        }
                    })
                    .unwrap_or(0);
                inner.status = Status::Downloading;
                inner.progress = Some(Progress {
                    percent,
                    bytes_per_second,
                    transferred,
                    total,
                });
                drop(inner);
                broadcast_throttled(&progress_app);
            },
            move || {
                let mut inner = lock();
                if let Some(p) = inner.progress.as_mut() {
                    p.percent = 100.0;
                    if p.total == 0 {
                        p.total = p.transferred;
                    }
                }
                drop(inner);
                broadcast(&finish_app);
            },
        )
        .await;

    match result {
        Ok(bytes) => {
            // update-downloaded
            info!("[updater] 更新包下载完成 ({} bytes)", bytes.len());
            {
                let mut inner = lock();
                inner.status = Status::Downloaded;
                inner.progress = None;
                inner.downloaded = Some(DownloadedPkg {
                    update: inner
                        .pending_update
                        .clone()
                        .unwrap_or_else(|| update.clone()),
                    bytes,
                });
            }
            broadcast(&app);
            Ok(())
        }
        Err(e) => {
            let msg = e.to_string();
            warn!("[updater] 下载更新失败: {}", msg);
            set_error(&app, msg.clone());
            Err(anyhow!(msg))
        }
    }
}

/// 安装已下载的更新并重启（auto 模式）。
/// Windows：NSIS 启动安装器后进程立即退出，安装器完成升级并按 restart_after_install 拉起新版；
/// Linux AppImage：就地替换二进制后 restart 生效。
async fn do_install(app: AppHandle) -> Result<()> {
    let pkg = {
        let mut inner = lock();
        if inner.status != Status::Downloaded {
            return Err(anyhow!("更新尚未下载完成"));
        }
        inner
            .downloaded
            .take()
            .ok_or_else(|| anyhow!("没有已下载的更新包"))?
    };

    info!("[updater] 开始安装更新...");
    // install 成功后进程即退出（Windows）或需要 restart（Linux），失败时回填错误。
    if let Err(e) = pkg.update.install(&pkg.bytes) {
        let msg = e.to_string();
        warn!("[updater] 安装更新失败: {}", msg);
        let mut inner = lock();
        inner.status = Status::Error;
        inner.error = msg.clone();
        drop(inner);
        broadcast(&app);
        return Err(anyhow!(msg));
    }

    // macOS / Linux：安装完成后需重启进程进入新版。
    // `restart()` 返回 `!`（永不返回），作为尾表达式可满足 `Result<()>` 的返回类型。
    app.restart()
}

/// notify 模式：打开浏览器引导用户手动下载安装包。
fn open_download_page(app: &AppHandle) {
    let url = {
        let inner = lock();
        if inner.download_url.is_empty() {
            HOMEPAGE_URL.to_string()
        } else {
            inner.download_url.clone()
        }
    };
    info!("[updater] 打开下载页: {}", url);
    // 注意：`opener()`/`open_url()` 属 tauri-plugin-opener 的 API，本项目未引入该插件；
    // tauri-plugin-shell 2.x 的等价方法是 `shell().open(path, with)`，权限为 shell:allow-open。
    if let Err(e) = tauri_plugin_shell::ShellExt::shell(app).open(&url, None) {
        warn!("[updater] 打开下载页失败: {}", e);
    }
}

// ─── 初始化与调度 ─────────────────────────────────────────────────────────────

/// tauri-plugin-updater 是否已注册。
///
/// 判据是插件注册时 `app.manage` 的 `UpdaterState` 能否取到：用 `try_state`（返回 Option）
/// 而非 `state`（缺失即 panic）。插件类型对外不可见，故以 `updater_builder()` 之外的方式
/// 无法直接探测——这里改用「插件名」判断，等价且零 panic 风险。
fn is_plugin_registered(app: &AppHandle) -> bool {
    // Tauri 在 setup 完成后才填充插件表；updater 的所有命令都以 "updater" 为插件名注册。
    app.config()
        .plugins
        .0
        .contains_key("updater")
        && PLUGIN_REGISTERED.load(std::sync::atomic::Ordering::SeqCst)
}

/// 由 main.rs 在成功注册 tauri-plugin-updater 后置位。
/// 默认 false —— 「没显式说注册过」就一律当作未注册，宁可不更新也不崩溃。
pub static PLUGIN_REGISTERED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// 解析平台模式、注册周期复检调度并广播初始状态。幂等。
/// 延迟首检（15s）+ 周期复检（6h）：应用常驻托盘，复检保证长跑进程也能收到新版本。
pub async fn init(app: AppHandle) -> Result<()> {
    let plugin_ready = is_plugin_registered(&app);
    if !plugin_ready {
        warn!("[updater] tauri-plugin-updater 未注册（缺 plugins.updater 配置），自动更新已禁用");
    }
    {
        let mut inner = lock();
        if inner.started {
            return Ok(());
        }
        inner.started = true;
        inner.mode = DesktopUpdater::resolve_mode(plugin_ready);
    }

    let mode = lock().mode;
    info!(
        "[updater] 初始化完成: mode={}, feed={}",
        mode.as_str(),
        lock().feed_url
    );
    broadcast(&app);

    if mode == Mode::None {
        return Ok(());
    }

    // 延迟首检
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(STARTUP_CHECK_DELAY).await;
            if let Err(e) = do_check(app.clone(), false).await {
                warn!("[updater] 首次检查更新失败: {}", e);
            }
            auto_download_if_needed(&app).await;
        });
    }

    // 周期复检
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut ticker = tokio::time::interval(RECHECK_INTERVAL);
            // interval 首次立即触发，跳过（首检由上方延迟任务负责）
            ticker.tick().await;
            loop {
                ticker.tick().await;
                if let Err(e) = do_check(app.clone(), false).await {
                    warn!("[updater] 周期检查更新失败: {}", e);
                }
                auto_download_if_needed(&app).await;
            }
        });
    }

    Ok(())
}

// ─── Tauri Commands ───────────────────────────────────────────────────────────

/// 桌面端版本号（对应 Electron 版 updater-get-version）。
#[tauri::command]
pub fn updater_get_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// 当前状态快照（对应 Electron 版 updater-get-state）。
#[tauri::command]
pub fn updater_get_state(app: AppHandle) -> serde_json::Value {
    serde_json::to_value(snapshot_with(&app)).unwrap_or_else(|_| serde_json::Value::Null)
}

/// 手动检查更新（对应 Electron 版 updater-check），返回最新状态快照。
#[tauri::command]
pub async fn updater_check(app: AppHandle) -> Result<serde_json::Value, String> {
    let _ = do_check(app.clone(), true)
        .await
        .map_err(|e| format!("{:#}", e));
    // auto 模式下手动检到新版后立即开下载（前端此时无可点入口）。
    // 不阻塞本命令返回：下载可能持续数分钟，而前端等的是一个即时的状态快照；
    // 进度由 updater-state 事件持续推送。
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            auto_download_if_needed(&app).await;
        });
    }
    Ok(updater_get_state(app))
}

/// 重试下载（auto 模式）；notify 模式直接打开下载页（对应 Electron 版 updater-download）。
#[tauri::command]
pub async fn updater_download(app: AppHandle) -> Result<serde_json::Value, String> {
    let mode = lock().mode;
    if mode == Mode::Notify || mode == Mode::None {
        open_download_page(&app);
        return Ok(updater_get_state(app));
    }
    if let Err(e) = do_download(app.clone()).await {
        return Err(format!("{:#}", e));
    }
    Ok(updater_get_state(app))
}

/// 安装并重启（auto 模式）；notify 模式打开下载页（对应 Electron 版 updater-install）。
#[tauri::command]
pub async fn updater_install(app: AppHandle) -> Result<serde_json::Value, String> {
    let mode = lock().mode;
    if mode != Mode::Auto {
        open_download_page(&app);
        return Ok(updater_get_state(app));
    }
    if let Err(e) = do_install(app.clone()).await {
        return Err(format!("{:#}", e));
    }
    Ok(updater_get_state(app))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归护栏：插件未注册时必须是 Mode::None。
    ///
    /// 这正是安装版启动约 15s 后 0xC0000409 闪退的根因：mode 非 None 时会发起首检，
    /// 走到 `app.updater_builder()` → `state::<UpdaterState>()` → panic → abort。
    /// 只要本断言成立，该崩溃路径就不可达。
    #[test]
    fn mode_is_none_when_plugin_missing() {
        assert_eq!(DesktopUpdater::resolve_mode(false), Mode::None);
    }

    /// 插件已注册时保持原有平台策略（仅打包态生效；debug 下恒为 None）。
    #[test]
    fn mode_follows_platform_when_plugin_ready() {
        let mode = DesktopUpdater::resolve_mode(true);
        if cfg!(debug_assertions) {
            assert_eq!(mode, Mode::None);
        } else if cfg!(target_os = "windows") {
            assert_eq!(mode, Mode::Auto);
        } else {
            assert_ne!(mode, Mode::None);
        }
    }

    /// 默认态（未经 main.rs 显式置位）必须是「未注册」，保证 fail-safe 方向正确。
    #[test]
    fn plugin_registered_defaults_to_false() {
        assert!(!PLUGIN_REGISTERED.load(std::sync::atomic::Ordering::SeqCst));
    }
}
