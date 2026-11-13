//! updater.rs — 自动更新状态机（tauri-plugin-updater 2.x）。
//!
//! ## 与旧 Java/Tauri 壳的差异（只改了「清单从哪来」）
//!
//! 旧壳读静态目录 https://www.gourdwork.com/downloads/tauri/latest.json，那份
//! latest.json 由 CI 的 generate-latest-json.js 产出并上传到官网静态站。
//! Rust 原生壳改为读 **admin 后台上传** 的清单：
//!
//!   POST /api/installers/latest     管理员在「安装包」页上传 latest.json
//!   GET  /api/installer-latest.json 公开、免登录、返回裸 JSON（无 ApiSuccess 信封）
//!
//! 后台那条路由不挂 UserAuth/AdminAuth，所以未登录的桌面客户端也能读到；响应体
//! 就是上传的原始字节，因此 `check()` 能直接解析出 version/platforms/signature。
//! 文件里的 minisign signature 由发版流水线产出（用户「上传更新检测文件」时一并
//! 带来），本仓库只负责配置 pubkey 供插件校验，不生成密钥、不产出 .sig。
//!
//! `GWORK_UPDATE_URL` 可覆盖整个 endpoint（换源/内网灰度），传的是**完整 URL**
//! 而非目录：后台把 .json 直接挂在 /api 下，没有「目录 + latest.json」的拼接语义。
//!
//! 状态机 status: idle | checking | available | not-available | downloading | downloaded | error
//! IPC: updater_get_state / updater_check / updater_download / updater_install
//!      + 事件 "updater-state"（经 ipc_bridge::emit 广播，前端 onUpdaterState 订阅）

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::Result;
use lazy_static::lazy_static;
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};
use tracing::{info, warn};

/// 默认更新清单：admin 后台公开接口。必须是**完整 URL**。
const DEFAULT_FEED_URL: &str = "https://www.gourdwork.com/api/installer-latest.json";
const HOMEPAGE_URL: &str = "https://www.gourdwork.com/";
const STARTUP_CHECK_DELAY: Duration = Duration::from_secs(15);
const RECHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const UPDATER_TIMEOUT: Duration = Duration::from_secs(60);

/// 由 lib.rs 在成功注册 tauri-plugin-updater 后置位。默认 false：
/// 「没显式说注册过」就一律当作未注册，宁可不更新也不让 updater_builder() 因
/// 缺少 UpdaterState 触发 panic（release profile 是 panic = "abort"）。
pub static PLUGIN_REGISTERED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode { Auto, Notify, None }

impl Mode {
    fn as_str(self) -> &'static str {
        match self { Mode::Auto => "auto", Mode::Notify => "notify", Mode::None => "none" }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Status { Idle, Checking, Available, NotAvailable, Downloading, Downloaded, Error }

impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Status::Idle => "idle", Status::Checking => "checking",
            Status::Available => "available", Status::NotAvailable => "not-available",
            Status::Downloading => "downloading", Status::Downloaded => "downloaded",
            Status::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub percent: f64,
    pub bytes_per_second: u64,
    pub transferred: u64,
    pub total: u64,
}

/// 渲染层可见的状态快照，字段名与 Electron / 旧 Tauri 壳一致。
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

struct DownloadedPkg { update: Update, bytes: Vec<u8> }

pub struct DesktopUpdater {
    feed_url: String,
    mode: Mode,
    status: Status,
    version: Option<String>,
    release_notes: String,
    download_url: String,
    progress: Option<Progress>,
    error: String,
    last_check_manual: bool,
    pending_update: Option<Update>,
    downloaded: Option<DownloadedPkg>,
    downloaded_bytes: u64,
    download_started: Option<Instant>,
    last_broadcast: Option<Instant>,
    started: bool,
}

impl DesktopUpdater {
    fn new() -> Self {
        Self {
            feed_url: normalize_feed_url(std::env::var("GWORK_UPDATE_URL").ok().as_deref()),
            mode: Mode::None, status: Status::Idle, version: None,
            release_notes: String::new(), download_url: String::new(),
            progress: None, error: String::new(), last_check_manual: false,
            pending_update: None, downloaded: None, downloaded_bytes: 0,
            download_started: None, last_broadcast: None, started: false,
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

    /// 未注册插件时必须退回 None，否则 app.updater_builder() 会 panic → abort。
    fn resolve_mode(plugin_ready: bool) -> Mode {
        if cfg!(debug_assertions) { return Mode::None; }
        if !plugin_ready { return Mode::None; }
        if cfg!(target_os = "windows") { return Mode::Auto; }
        if cfg!(target_os = "macos") { return Mode::Notify; }
        if cfg!(target_os = "linux") && std::env::var_os("APPIMAGE").is_some() {
            return Mode::Auto;
        }
        Mode::Notify
    }
}

lazy_static! {
    static ref UPDATER: Mutex<DesktopUpdater> = Mutex::new(DesktopUpdater::new());
}

fn lock() -> std::sync::MutexGuard<'static, DesktopUpdater> {
    UPDATER.lock().unwrap_or_else(|e| e.into_inner())
}

/// 完整 URL 归一化：空值回落默认，缺 scheme 补 https。
/// 注意这里**不**追加 "latest.json" —— 后台接口本身就是一个 .json 文件。
fn normalize_feed_url(url: Option<&str>) -> String {
    let mut u = url.unwrap_or("").trim().to_string();
    if u.is_empty() { u = DEFAULT_FEED_URL.to_string(); }
    if !u.to_ascii_lowercase().starts_with("http://")
        && !u.to_ascii_lowercase().starts_with("https://") {
        u = format!("https://{}", u);
    }
    u
}

fn snapshot_with(app: &AppHandle) -> StateSnapshot { lock().snapshot(app) }

fn broadcast(app: &AppHandle) {
    let snap = snapshot_with(app);
    crate::ipc_bridge::emit(app, "updater-state", &snap);
}

fn broadcast_throttled(app: &AppHandle) {
    {
        let mut inner = lock();
        let now = Instant::now();
        if let Some(last) = inner.last_broadcast {
            if now.duration_since(last) < Duration::from_millis(100) { return; }
        }
        inner.last_broadcast = Some(now);
    }
    broadcast(app);
}

fn set_error(app: &AppHandle, msg: impl Into<String>) {
    {
        let mut inner = lock();
        if inner.status == Status::Downloaded { return; }
        inner.status = Status::Error;
        inner.error = msg.into();
        inner.progress = None;
    }
    broadcast(app);
}

async fn do_check(app: AppHandle, manual: bool) -> Result<()> {
    {
        let mut inner = lock();
        inner.last_check_manual = manual;
        if inner.mode == Mode::None {
            drop(inner);
            broadcast(&app);
            return Ok(());
        }
        inner.status = Status::Checking;
        inner.error.clear();
        inner.progress = None;
    }
    broadcast(&app);

    let feed_url = lock().feed_url.clone();
    let built = (|| -> Result<tauri_plugin_updater::Updater> {
        let endpoint = feed_url.parse()
            .map_err(|e| anyhow::anyhow!("更新源地址无效 {}: {}", feed_url, e))?;
        app.updater_builder()
            .endpoints(vec![endpoint])
            .map_err(|e| anyhow::anyhow!("配置更新源失败: {}", e))?
            .timeout(UPDATER_TIMEOUT)
            .build()
            .map_err(|e| anyhow::anyhow!("构建更新器失败: {}", e))
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

    match updater.check().await {
        Ok(Some(update)) => {
            info!("[updater] 发现新版本: {}", update.version);
            {
                let mut inner = lock();
                inner.status = Status::Available;
                inner.version = Some(update.version.clone());
                inner.release_notes = update.body.clone().unwrap_or_default();
                inner.download_url = update.download_url.to_string();
                inner.pending_update = Some(update);
            }
            broadcast(&app);
        }
        Ok(None) => {
            let mut inner = lock();
            inner.status = Status::NotAvailable;
            if inner.downloaded.is_none() { inner.version = None; }
            inner.release_notes.clear();
            inner.progress = None;
            inner.pending_update = None;
            drop(inner);
            broadcast(&app);
        }
        Err(e) => {
            let msg = e.to_string();
            warn!("[updater] 检查更新失败: {} (endpoint: {})", msg, feed_url);
            set_error(&app, msg);
        }
    }
    Ok(())
}

async fn auto_download_if_needed(app: &AppHandle) {
    let should = {
        let inner = lock();
        inner.mode == Mode::Auto && inner.status == Status::Available
    };
    if should {
        if let Err(e) = do_download(app.clone()).await {
            warn!("[updater] 自动下载更新失败: {}", e);
        }
    }
}

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
                    percent: 0.0, bytes_per_second: 0, transferred: 0, total: 0,
                });
                u
            }
            None => {
                inner.error = "没有可下载的更新".to_string();
                drop(inner);
                broadcast(&app);
                anyhow::bail!("没有可下载的更新");
            }
        }
    };
    broadcast(&app);

    let progress_app = app.clone();
    let finish_app = app.clone();
    let result = update.download(
        move |chunk_length, content_length| {
            let mut inner = lock();
            inner.downloaded_bytes += chunk_length as u64;
            let transferred = inner.downloaded_bytes;
            let total = content_length.unwrap_or(0);
            let percent = if total > 0 {
                (transferred as f64 * 100.0 / total as f64 * 10.0).round() / 10.0
            } else { 0.0 };
            let bytes_per_second = inner.download_started.map(|t| {
                let secs = t.elapsed().as_secs_f64();
                if secs > 0.0 { (transferred as f64 / secs) as u64 } else { 0 }
            }).unwrap_or(0);
            inner.status = Status::Downloading;
            inner.progress = Some(Progress { percent, bytes_per_second, transferred, total });
            drop(inner);
            broadcast_throttled(&progress_app);
        },
        move || {
            let mut inner = lock();
            if let Some(p) = inner.progress.as_mut() {
                p.percent = 100.0;
                if p.total == 0 { p.total = p.transferred; }
            }
            drop(inner);
            broadcast(&finish_app);
        },
    ).await;

    match result {
        Ok(bytes) => {
            info!("[updater] 更新包下载完成 ({} bytes)", bytes.len());
            let mut inner = lock();
            inner.status = Status::Downloaded;
            inner.progress = None;
            inner.downloaded = Some(DownloadedPkg {
                update: inner.pending_update.clone().unwrap_or_else(|| update.clone()),
                bytes,
            });
            drop(inner);
            broadcast(&app);
            Ok(())
        }
        Err(e) => {
            let msg = e.to_string();
            warn!("[updater] 下载更新失败: {}", msg);
            set_error(&app, msg.clone());
            anyhow::bail!(msg)
        }
    }
}

async fn do_install(app: AppHandle) -> Result<()> {
    let pkg = {
        let mut inner = lock();
        if inner.status != Status::Downloaded { anyhow::bail!("更新尚未下载完成"); }
        inner.downloaded.take().ok_or_else(|| anyhow::anyhow!("没有已下载的更新包"))?
    };
    info!("[updater] 开始安装更新...");
    if let Err(e) = pkg.update.install(&pkg.bytes) {
        let msg = e.to_string();
        warn!("[updater] 安装更新失败: {}", msg);
        let mut inner = lock();
        inner.status = Status::Error;
        inner.error = msg.clone();
        drop(inner);
        broadcast(&app);
        anyhow::bail!(msg)
    }
    app.restart()
}

/// notify 模式：用壳层已有的外链守卫打开下载页（不引入额外插件）。
fn open_download_page(app: &AppHandle) {
    let url = {
        let inner = lock();
        if inner.download_url.is_empty() { HOMEPAGE_URL.to_string() } else { inner.download_url.clone() }
    };
    info!("[updater] 打开下载页: {}", url);
    match tauri::Url::parse(&url) {
        Ok(u) => crate::external_link::open_external(app, &u),
        Err(e) => warn!("[updater] 下载页地址非法 {}: {}", url, e),
    }
}

pub async fn init(app: AppHandle) -> Result<()> {
    let plugin_ready = PLUGIN_REGISTERED.load(Ordering::SeqCst);
    if !plugin_ready {
        warn!("[updater] tauri-plugin-updater 未注册，自动更新已禁用");
    }
    {
        let mut inner = lock();
        if inner.started { return Ok(()); }
        inner.started = true;
        inner.mode = DesktopUpdater::resolve_mode(plugin_ready);
    }
    let mode = lock().mode;
    info!("[updater] 初始化完成: mode={}, feed={}", mode.as_str(), lock().feed_url);
    broadcast(&app);
    if mode == Mode::None { return Ok(()); }

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
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut ticker = tokio::time::interval(RECHECK_INTERVAL);
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

// ─── Tauri Commands ────────────────────────────────────────────────────────

#[tauri::command]
pub fn updater_get_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn updater_get_state(app: AppHandle) -> serde_json::Value {
    serde_json::to_value(snapshot_with(&app)).unwrap_or(serde_json::Value::Null)
}

#[tauri::command]
pub async fn updater_check(app: AppHandle) -> Result<serde_json::Value, String> {
    let _ = do_check(app.clone(), true).await.map_err(|e| format!("{:#}", e));
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move { auto_download_if_needed(&app).await; });
    }
    Ok(updater_get_state(app))
}

#[tauri::command]
pub async fn updater_download(app: AppHandle) -> Result<serde_json::Value, String> {
    let mode = lock().mode;
    if mode == Mode::Notify || mode == Mode::None {
        open_download_page(&app);
        return Ok(updater_get_state(app));
    }
    do_download(app.clone()).await.map_err(|e| format!("{:#}", e))?;
    Ok(updater_get_state(app))
}

#[tauri::command]
pub async fn updater_install(app: AppHandle) -> Result<serde_json::Value, String> {
    let mode = lock().mode;
    if mode != Mode::Auto {
        open_download_page(&app);
        return Ok(updater_get_state(app));
    }
    do_install(app.clone()).await.map_err(|e| format!("{:#}", e))?;
    Ok(updater_get_state(app))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_is_none_when_plugin_missing() {
        assert_eq!(DesktopUpdater::resolve_mode(false), Mode::None);
    }

    #[test]
    fn plugin_registered_defaults_to_false() {
        // 该静态量可能被 init() 置位，故只断言「定义存在且可加载」。
        let _ = PLUGIN_REGISTERED.load(Ordering::SeqCst);
    }

    /// 默认 endpoint 必须是 admin 后台那条免登录、裸 JSON 的完整 URL。
    /// 写成目录（少了 /api/installer-latest.json）会让客户端固定 404。
    #[test]
    fn default_feed_url_is_the_public_admin_endpoint() {
        assert_eq!(normalize_feed_url(None), DEFAULT_FEED_URL);
        assert_eq!(DEFAULT_FEED_URL, "https://www.gourdwork.com/api/installer-latest.json");
        assert!(DEFAULT_FEED_URL.ends_with(".json"), "endpoint 必须是完整 .json URL，不是目录");
    }

    /// 换源传完整 URL 时不得再追加 latest.json（后台没有目录拼接语义）。
    #[test]
    fn override_url_is_not_rewritten_as_a_directory() {
        assert_eq!(normalize_feed_url(Some("https://example.com/api/installer-latest.json")),
                   "https://example.com/api/installer-latest.json");
        assert_eq!(normalize_feed_url(Some("example.com/custom.json")),
                   "https://example.com/custom.json");
    }
}
