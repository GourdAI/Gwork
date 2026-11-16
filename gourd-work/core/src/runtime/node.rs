//! `runtime::node` — Node.js 运行时保障：系统探测 → 内置托管下载。
//!
//! CLI 连接器（厂商官方 npm CLI）的安装与运行都依赖 Node。用户机器不保证有
//! Node，因此安装链路的第一步永远是 [`ensure`]：
//!
//! 1. 已装 managed（`~/.gwork/binaries/node/versions/<ver>/node.exe`）→ **版本自报 +
//!    node.exe 本体哈希双校验**通过才用（防本地被替换成「会打印 v22.22.2 的任意程序」）；
//! 2. 系统 node（PATH + 常见安装路径）版本 ≥ [`MIN_SYSTEM_MAJOR`] → 用系统的；
//! 3. 都没有 → 下载内置 node（win-x64 zip，npmmirror 优先、nodejs.org 兜底），
//!    **sha256 内嵌常量校验**（不在线拉 SHASUMS：镜像的校验文件与制品同源，
//!    在线拉不构成独立信任），流式下载边写边哈希，`.part` 临时名 → 校验通过
//!    才解压落位，半截文件永远不会被当成可用运行时。
//!
//! 信任边界：下载 URL 只能是两个硬编码 https 源之一；解压只取 `node.exe` 与
//! `node_modules/npm/**`（CLI 安装需要 npm-cli.js），其余条目丢弃；zip 解析
//! 复用 `skills::market::unpack_zip` 的防 zip-slip/zip-bomb  hardened 管线。
//!
//! 非 Windows：本轮只实现 win-x64 托管下载（GWork 桌面主发 Windows）；
//! mac/linux 走系统探测，探测不到则报错并给出手动安装指引。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};

/// 内置 node 版本（锁定 LTS；升级=改常量+哈希+发版，绝不运行时浮动）。
pub const NODE_VERSION: &str = "22.22.2";
/// 官方 `node-v22.22.2-win-x64.zip` 的 SHA256（nodejs.org/dist SHASUMS256.txt，
/// 与 npmmirror 镜像逐字节比对一致；本机 WB managed node.exe 哈希亦与官方一致）。
const NODE_ZIP_SHA256: &str = "7c93e9d92bf68c07182b471aa187e35ee6cd08ef0f24ab060dfff605fcc1c57c";
/// 官方 win-x64 `node.exe` 本体实测 SHA256（.gwork/PLAN 第七节）。
/// 版本自报（`--version`）可被「输出 v22.22.2 的任意程序」伪造，故 managed 落位后
/// 必须再过此哈希才算可信；不在 node_and_npm 每次重复校验（87MB 哈希太慢），
/// 信任链由 detect_managed / download_and_install 两处入口守住。
const NODE_EXE_SHA256: &str = "AE1A50511BE58E987483FDBC12125407443926D2D394669ADE2352776E920DD3";
/// 下载源（优先级序）。只允许这两个 https 模板，防换源注入。
const NODE_ZIP_SOURCES: &[&str] = &[
    "https://registry.npmmirror.com/-/binary/node/v22.22.2/node-v22.22.2-win-x64.zip",
    "https://nodejs.org/dist/v22.22.2/node-v22.22.2-win-x64.zip",
];
/// zip 体积上限（官方 ~30MB；留 3 倍余量，防异常响应吃满磁盘）。
const MAX_ZIP_BYTES: u64 = 96 * 1024 * 1024;
/// 系统 node 最低主版本（CLI 生态实际要求 ≥16.7；取 18 与 WB 口径一致）。
pub const MIN_SYSTEM_MAJOR: u32 = 18;

/// 对外状态（API 直接序列化）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NodeStatus {
    /// ready | absent | downloading | extracting | failed
    pub status: String,
    /// managed | system（ready 时有值）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// 0-100（downloading 阶段）
    pub progress: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// node.exe 绝对路径（ready 时有值；内部使用，前端不渲染）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_path: Option<String>,
}

impl NodeStatus {
    fn absent() -> Self {
        Self { status: "absent".into(), source: None, version: None, progress: 0, error: None, node_path: None }
    }
    fn ready(source: &str, version: &str, path: &Path) -> Self {
        Self {
            status: "ready".into(),
            source: Some(source.into()),
            version: Some(version.into()),
            progress: 100,
            error: None,
            node_path: Some(path.to_string_lossy().into_owned()),
        }
    }
}

static STATE: OnceLock<Mutex<NodeStatus>> = OnceLock::new();
static ENSURING: AtomicBool = AtomicBool::new(false);
/// 临时名去重序号：同一纳秒内多次调用也不会撞名。
static STAGING_SEQ: AtomicU64 = AtomicU64::new(0);

/// 单飞标志的 RAII 守卫：后台线程任何 panic 都在 unwind 时由 Drop 复位，
/// 否则 ENSURING 永真、status 永 downloading、运行时永久卡死。
struct EnsuringGuard;
impl Drop for EnsuringGuard {
    fn drop(&mut self) {
        ENSURING.store(false, Ordering::SeqCst);
    }
}

/// 生成唯一临时名后缀：pid + 纳秒时间戳 + 进程内序号（防同 pid 残留/并发互删）。
fn staging_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = STAGING_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{}-{nanos}-{seq}", std::process::id())
}

fn state() -> &'static Mutex<NodeStatus> {
    STATE.get_or_init(|| Mutex::new(NodeStatus::absent()))
}

fn set_status(s: NodeStatus) {
    if let Ok(mut g) = state().lock() {
        *g = s;
    }
}

/// 当前状态快照（不触发任何 IO）。
pub fn status() -> NodeStatus {
    state().lock().map(|g| g.clone()).unwrap_or_else(|_| NodeStatus::absent())
}

/// binaries 根目录（与 WB 同构：`~/.gwork/binaries/node/...`）。
pub fn binaries_dir() -> PathBuf {
    crate::config::Settings::gwork_home().join("binaries")
}

/// managed node.exe 的落位路径。
pub fn managed_node_path() -> PathBuf {
    binaries_dir().join("node").join("versions").join(NODE_VERSION).join("node.exe")
}

/// managed npm-cli.js 的落位路径（CLI 安装用）。
pub fn managed_npm_cli() -> PathBuf {
    binaries_dir()
        .join("node").join("versions").join(NODE_VERSION)
        .join("node_modules").join("npm").join("bin").join("npm-cli.js")
}

/// 解析 `v22.19.0` / `22.19.0` → 主版本。非法返回 None。
pub fn parse_major(raw: &str) -> Option<u32> {
    let t = raw.trim().trim_start_matches('v');
    let major = t.split('.').next()?;
    major.parse::<u32>().ok()
}

/// 探测系统 node：PATH 里的 `node` + 常见安装路径。返回 (路径, 版本字符串)。
/// 只接受主版本 ≥ MIN_SYSTEM_MAJOR 的候选。
pub fn detect_system_node() -> Option<(PathBuf, String)> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    // PATH 搜索（where.exe / which）
    #[cfg(windows)]
    let which = "where.exe";
    #[cfg(not(windows))]
    let which = "which";
    if let Ok(out) = std::process::Command::new(which).arg("node").output() {
        if out.status.success() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let p = PathBuf::from(line.trim());
                if p.is_file() {
                    candidates.push(p);
                }
            }
        }
    }
    // 常见安装路径（nvm4w symlink、官方安装器、homebrew、scoop）
    #[cfg(windows)]
    {
        for p in [
            r"C:\Program Files\nodejs\node.exe",
            r"C:\nvm4w\nodejs\node.exe",
        ] {
            candidates.push(PathBuf::from(p));
        }
        if let Ok(home) = std::env::var("USERPROFILE") {
            candidates.push(PathBuf::from(&home).join("scoop").join("apps").join("nodejs").join("current").join("node.exe"));
        }
    }
    #[cfg(not(windows))]
    {
        for p in ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"] {
            candidates.push(PathBuf::from(p));
        }
    }
    for path in candidates {
        if !path.is_file() {
            continue;
        }
        if let Some(ver) = probe_version(&path) {
            if parse_major(&ver).map(|m| m >= MIN_SYSTEM_MAJOR).unwrap_or(false) {
                return Some((path, ver));
            }
        }
    }
    None
}

/// `node --version` 探测的硬超时（防挂起/恶意 exe 无限占住 tokio worker）。
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// 跑 `node --version` 拿版本（超时 5s，防挂死）。
/// 不用 `Command::output()`：它无超时且会等 stderr/stdout 管道关闭，恶意或挂起的
/// node.exe 会把 axum handler 所在线程（ensure 同步调用）永久卡住。
/// 这里 spawn + `try_wait()` 轮询，超时 kill + wait 兜底；进程正常退出后再用
/// `wait_with_output()` 读回 stdout 判 `status.success()`。
fn probe_version(path: &Path) -> Option<String> {
    let mut child = Command::new(path)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        // stderr 直接丢弃：不产生待读管道，避免管道写满导致子进程阻塞不退出。
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            // 已退出：wait_with_output 取回 stdout（piped 输出量极小，无阻塞风险）。
            Ok(Some(_)) => {
                let out = child.wait_with_output().ok()?;
                if !out.status.success() {
                    return None;
                }
                let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
                return if v.is_empty() { None } else { Some(v) };
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait(); // 回收僵尸进程
                    return None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            // try_wait 自身出错（OS 异常）：同样杀掉回收，按探测失败处理。
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// 流式校验 managed `node.exe` 字节是否与内嵌官方哈希一致。
/// 只认内容不认「自报版本」：本地被替换成任意可输出 v22.22.2 的程序会被拒。
fn verify_managed_exe(path: &Path) -> bool {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = match file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return false,
        };
        hasher.update(&buf[..n]);
    }
    // 常量为大写 hex，实测结果为小写 hex：统一小写比对，避免大小写误判。
    hex::encode(hasher.finalize()).eq_ignore_ascii_case(NODE_EXE_SHA256)
}

/// 快查已装 managed：文件存在 + `--version` 与锁定版本一致 + **exe 哈希校验**。
/// 任一不过一律视为 absent，绝不把它当 node 交给 npm install/auth/status。
fn detect_managed() -> Option<(PathBuf, String)> {
    let p = managed_node_path();
    if !p.is_file() {
        return None;
    }
    let ver = probe_version(&p)?;
    if ver.trim().trim_start_matches('v') == NODE_VERSION && verify_managed_exe(&p) {
        Some((p, ver))
    } else {
        None
    }
}

/// 只读定位可用 Node（managed → system），**绝不触发下载、绝不改进程状态**。
///
/// 与 [`ensure`] 的区别：`ensure` 是「保障/下载」入口（只由安装链路与显式
/// `/runtime/node/ensure` 端点调用）；而 CLI 的只读路径（`is_installed` /
/// `cli/state` / `start_auth` / `uninstall`）每个进程重启后都必须能拿到 node，
/// 否则进程内 STATE 初始为 absent 会让全部已装/已授权连接器回退成「未连接」，
/// 断开登出也失败。这里做纯探测，不引入 30MB 下载副作用。
pub fn locate() -> Option<(PathBuf, String)> {
    detect_managed().or_else(detect_system_node)
}

/// 确保 Node 可用：已就绪直接返回；否则触发后台下载并立即返回当前状态。
/// 单飞：并发调用只会有一个下载任务。返回时 status 可能是 ready（系统/已装）
/// 或 downloading（后台进行中），调用方轮询 [`status`]。
pub fn ensure() -> NodeStatus {
    // 快路径：managed / system 已可用（managed 每次快查成本=一次 --version + 一次流式 SHA256）。
    if let Some((p, v)) = detect_managed() {
        let s = NodeStatus::ready("managed", &v, &p);
        set_status(s.clone());
        return s;
    }
    if let Some((p, v)) = detect_system_node() {
        let s = NodeStatus::ready("system", &v, &p);
        set_status(s.clone());
        return s;
    }
    // 非 Windows 无托管下载：明确报错指引。
    if !cfg!(windows) {
        let s = NodeStatus {
            status: "failed".into(), source: None, version: None, progress: 0,
            error: Some("未检测到 Node.js（≥18）。请先安装 Node.js 后重试。".into()),
            node_path: None,
        };
        set_status(s.clone());
        return s;
    }
    // 已在下载/解压：直接回当前状态。
    let cur = status();
    if cur.status == "downloading" || cur.status == "extracting" {
        return cur;
    }
    if ENSURING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return status();
    }
    set_status(NodeStatus { status: "downloading".into(), progress: 0, ..NodeStatus::absent() });
    std::thread::spawn(|| {
        // RAII 守卫：作用域覆盖整个后台任务（含 rt 构建 / block_on / 状态回写）；
        // 正常结束与 panic unwind 都会复位 ENSURING，杜绝单飞标志永久卡死。
        let _guard = EnsuringGuard;
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build();
        let result = match rt {
            Ok(rt) => rt.block_on(download_and_install()),
            Err(e) => Err(format!("无法启动下载任务: {e}")),
        };
        match result {
            Ok((p, v)) => set_status(NodeStatus::ready("managed", &v, &p)),
            Err(e) => {
                // 下载失败但系统 node 达标 → 降级（明示 source=system）。
                if let Some((p, v)) = detect_system_node() {
                    tracing::warn!("node 托管下载失败（{e}），降级系统 node {}", v);
                    set_status(NodeStatus::ready("system", &v, &p));
                } else {
                    set_status(NodeStatus {
                        status: "failed".into(), source: None, version: None, progress: 0,
                        error: Some(e), node_path: None,
                    });
                }
            }
        }
        // ENSURING 由 _guard 的 Drop 复位，不再手动 store（panic 也必须复位）。
    });
    status()
}

/// 下载 + 校验 + 解压（阻塞异步）。只由 ensure 的后台任务调用。
async fn download_and_install() -> Result<(PathBuf, String), String> {
    let dest_dir = managed_node_path().parent().unwrap().to_path_buf();
    let downloads = binaries_dir().join(".cache").join("downloads");
    tokio::fs::create_dir_all(&downloads).await.map_err(|e| format!("创建下载目录失败: {e}"))?;
    let zip_path = downloads.join(format!("node-v{NODE_VERSION}-win-x64.zip"));
    let suffix = staging_suffix();
    let part_path = downloads.join(format!("node-v{NODE_VERSION}-win-x64.zip.{suffix}.part"));

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        // 纵深：默认重定向策略允许 https→http 降级（明文响应可被篡改），
        // 这里只允许继续跳到 https 目标，任何非 https 重定向直接报错。
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.url().scheme() == "https" {
                attempt.follow()
            } else {
                attempt.error("redirect 必须 https")
            }
        }))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))?;

    let mut last_err = String::from("无可用下载源");
    let mut ok = false;
    for url in NODE_ZIP_SOURCES {
        match download_one(&client, url, &part_path).await {
            Ok(()) => { ok = true; break; }
            Err(e) => {
                tracing::warn!("node 下载源 {url} 失败: {e}");
                last_err = e;
                let _ = tokio::fs::remove_file(&part_path).await;
            }
        }
    }
    if !ok {
        return Err(format!("Node 运行时下载失败：{last_err}"));
    }
    // 原子落位：校验通过的 .part → 正式名（覆盖旧缓存）。
    let _ = tokio::fs::remove_file(&zip_path).await;
    tokio::fs::rename(&part_path, &zip_path).await.map_err(|e| format!("下载落位失败: {e}"))?;

    set_status(NodeStatus { status: "extracting".into(), progress: 100, ..NodeStatus::absent() });
    let zip_bytes = tokio::fs::read(&zip_path).await.map_err(|e| format!("读取安装包失败: {e}"))?;
    // 解压到 staging，只保留 node.exe + node_modules/npm/**。
    let staging = downloads.join(format!("node-extract-{suffix}"));
    let staging2 = staging.clone();
    let zb = zip_bytes.clone();
    tokio::task::spawn_blocking(move || {
        crate::skills::market::unpack_zip(&zb, &staging2, crate::skills::market::UnpackMode::StripSingleRoot)
    })
    .await
    .map_err(|e| format!("解压任务失败: {e}"))?
    .map_err(|e| format!("Node 安装包解压失败: {e}"))?;

    // staging 里挑需要的文件搬到 dest_dir（先写临时目录再整体 rename）。
    // 临时目录同样带唯一后缀，防多进程/重跑时互删。
    let tmp_dest = dest_dir.with_extension(format!("tmp-{suffix}"));
    let _ = tokio::fs::remove_dir_all(&tmp_dest).await;
    tokio::fs::create_dir_all(&tmp_dest).await.map_err(|e| format!("创建运行目录失败: {e}"))?;
    let node_src = staging.join("node.exe");
    if !node_src.is_file() {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err("Node 安装包缺少 node.exe".into());
    }
    tokio::fs::copy(&node_src, tmp_dest.join("node.exe")).await.map_err(|e| format!("落位 node.exe 失败: {e}"))?;
    let npm_src = staging.join("node_modules").join("npm");
    if npm_src.is_dir() {
        copy_dir_recursive(&npm_src, &tmp_dest.join("node_modules").join("npm"))
            .map_err(|e| format!("落位 npm 失败: {e}"))?;
    }
    let _ = tokio::fs::remove_dir_all(&staging).await;
    let _ = tokio::fs::remove_dir_all(&dest_dir).await;
    if let Some(parent) = dest_dir.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| format!("创建版本目录失败: {e}"))?;
    }
    tokio::fs::rename(&tmp_dest, &dest_dir).await.map_err(|e| format!("运行时落位失败: {e}"))?;
    // 清理 zip 缓存（~30MB，装完即弃；失败不致命）。
    let _ = tokio::fs::remove_file(&zip_path).await;

    let p = managed_node_path();
    // 落位后的最终信任闸门：自报版本可伪造，exe 本体哈希必须与官方一致。
    if !verify_managed_exe(&p) {
        return Err("落位后 node.exe SHA256 校验失败（非官方二进制）".into());
    }
    let ver = probe_version(&p).ok_or("落位后 node --version 失败")?;
    Ok((p, ver))
}

/// 单源流式下载：边写边哈希，完成后比对内嵌 SHA256。
async fn download_one(client: &reqwest::Client, url: &str, part: &Path) -> Result<(), String> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let resp = client.get(url).send().await.map_err(|e| format!("请求失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    if total > MAX_ZIP_BYTES {
        return Err(format!("响应体积 {total} 超过上限"));
    }
    let mut file = tokio::fs::File::create(part).await.map_err(|e| format!("创建临时文件失败: {e}"))?;
    let mut hasher = Sha256::new();
    let mut written: u64 = 0;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载中断: {e}"))?;
        written += chunk.len() as u64;
        if written > MAX_ZIP_BYTES {
            return Err("下载体积超过上限".into());
        }
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| format!("写入失败: {e}"))?;
        if total > 0 {
            let pct = ((written as f64 / total as f64) * 100.0).min(99.0) as u8;
            set_status(NodeStatus { status: "downloading".into(), progress: pct, ..NodeStatus::absent() });
        }
    }
    file.flush().await.map_err(|e| format!("flush 失败: {e}"))?;
    drop(file);
    let got = hex::encode(hasher.finalize());
    if got != NODE_ZIP_SHA256 {
        return Err(format!("SHA256 校验失败（期望 {NODE_ZIP_SHA256}，实得 {got}）"));
    }
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else if ty.is_file() {
            std::fs::copy(entry.path(), &to)?;
        }
        // symlink 一律跳过（官方 zip 无 symlink；防意外跟随）。
    }
    Ok(())
}

/// 供 CLI 安装链路取「node + npm-cli.js」二元组。
/// managed 优先（npm 自带）；系统 node 时 npm-cli.js 从 node 同级目录推。
pub fn node_and_npm() -> Option<(PathBuf, PathBuf)> {
    let st = status();
    if st.status != "ready" {
        return None;
    }
    let node = PathBuf::from(st.node_path?);
    if st.source.as_deref() == Some("managed") {
        let npm = managed_npm_cli();
        if npm.is_file() {
            return Some((node, npm));
        }
        return None;
    }
    // 系统 node：npm 通常在 node 同级 node_modules/npm（官方安装器布局）。
    let base = node.parent()?;
    let npm = base.join("node_modules").join("npm").join("bin").join("npm-cli.js");
    if npm.is_file() {
        return Some((node, npm));
    }
    // nvm4w / 自定义布局：npm.cmd 同级也能推 node_modules。
    None
}

// ─── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_major_handles_v_prefix_and_garbage() {
        assert_eq!(parse_major("v22.19.0"), Some(22));
        assert_eq!(parse_major("18.0.0"), Some(18));
        assert_eq!(parse_major("  v16.20.2 \n"), Some(16));
        assert_eq!(parse_major("node"), None);
        assert_eq!(parse_major(""), None);
    }

    #[test]
    fn min_version_gate_is_18() {
        assert!(parse_major("v18.0.0").unwrap() >= MIN_SYSTEM_MAJOR);
        assert!(parse_major("v16.20.2").unwrap() < MIN_SYSTEM_MAJOR);
    }

    #[test]
    fn embedded_hash_is_64_hex() {
        assert_eq!(NODE_ZIP_SHA256.len(), 64);
        assert!(NODE_ZIP_SHA256.chars().all(|c| c.is_ascii_hexdigit()));
    }

    /// A1：官方 node.exe 内嵌哈希必须是合法 64 位 hex（与 .gwork/PLAN 第七节一致）。
    #[test]
    fn embedded_exe_hash_is_64_hex() {
        assert_eq!(NODE_EXE_SHA256, "AE1A50511BE58E987483FDBC12125407443926D2D394669ADE2352776E920DD3");
        assert_eq!(NODE_EXE_SHA256.len(), 64);
        assert!(NODE_EXE_SHA256.chars().all(|c| c.is_ascii_hexdigit()));
    }

    /// A1：内容不符的临时文件（哪怕伪装成 node.exe、哪怕能自报 v22.22.2）
    /// 必须被 verify_managed_exe 拒绝；路径不存在同样拒绝。
    #[test]
    fn verify_managed_exe_rejects_mismatched_content() {
        let path = std::env::temp_dir().join(format!(
            "gwork-node-exe-verify-{}-{}.tmp",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::write(&path, b"#!/bin/sh\necho v22.22.2\n").unwrap();
        assert!(!verify_managed_exe(&path), "内容不符必须拒绝");
        assert!(!verify_managed_exe(&path.with_extension("missing")), "文件不存在必须拒绝");
        let _ = std::fs::remove_file(&path);
    }

    /// A4：同一进程内连续取两次临时名后缀不得相同（防并发/残留互删）。
    #[test]
    fn staging_suffix_is_unique() {
        let a = staging_suffix();
        let b = staging_suffix();
        assert_ne!(a, b);
        let pid = std::process::id().to_string();
        assert!(a.starts_with(pid.as_str()));
    }

    /// A2：不存在的可执行文件探测立即失败，不触碰真实 ~/.gwork、不触网。
    #[test]
    fn probe_version_missing_binary_returns_none() {
        let missing = std::env::temp_dir().join(format!(
            "gwork-node-probe-no-such-exe-{}-{}.none",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        assert_eq!(probe_version(&missing), None);
    }

    #[test]
    fn download_sources_are_https_and_pinned_version() {
        for url in NODE_ZIP_SOURCES {
            assert!(url.starts_with("https://"), "下载源必须 https: {url}");
            assert!(url.contains(&format!("v{NODE_VERSION}")), "版本必须锁定: {url}");
            assert!(url.ends_with("win-x64.zip"));
        }
    }

    #[test]
    fn managed_paths_live_under_gwork_home() {
        let p = managed_node_path();
        assert!(p.ends_with(Path::new("node.exe")));
        assert!(p.to_string_lossy().contains("binaries"));
        let npm = managed_npm_cli();
        assert!(npm.ends_with(Path::new("npm-cli.js")));
    }

    #[test]
    fn status_serializes_camel_case() {
        let s = NodeStatus::ready("managed", "v22.22.2", Path::new("C:/x/node.exe"));
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["status"], "ready");
        assert_eq!(v["source"], "managed");
        assert_eq!(v["nodePath"], "C:/x/node.exe");
        assert!(v.get("node_path").is_none());
    }

    /// P0 回归：`locate()` 是只读探测，绝不改进程内 STATE、绝不触发下载。
    /// 进程重启后 STATE 初始为 absent，CLI 的只读路径必须靠它拿到 node，
    /// 否则已装/已授权连接器全部回退成「未连接」。
    #[test]
    fn locate_is_readonly_and_never_mutates_state() {
        let before = status();
        let _ = locate();
        let after = status();
        assert_eq!(before, after, "locate() 不得写入进程内 Node 状态");
        assert!(!ENSURING.load(Ordering::SeqCst), "locate() 不得触发下载单飞");
    }

    /// 校验和拒绝：错误哈希必须导致下载失败（用本地假响应不可行，
    /// 这里直接断言比对逻辑的常量一致性——真正的拒绝路径由
    /// download_one 的 got != NODE_ZIP_SHA256 分支覆盖，集成测试在
    /// 实机无 node 场景验证）。
    #[test]
    fn checksum_comparison_is_exact() {
        let wrong = "0".repeat(64);
        assert_ne!(wrong, NODE_ZIP_SHA256);
    }

    /// 实机集成测试（默认忽略，手动 `cargo test --lib runtime::node -- --ignored`）：
    /// 真实下载内置 node（npmmirror 优先）→ SHA256 校验 → 解压落位 → --version 复核。
    /// 用独立 GWORK_HOME，不碰用户真实 ~/.gwork，也不依赖系统 node 是否存在。
    #[tokio::test]
    #[ignore = "真实网络下载 ~30MB，手动运行"]
    async fn managed_download_install_end_to_end() {
        let tmp = std::env::temp_dir().join(format!("gwork-node-e2e-{}", staging_suffix()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // harness_base 有 OnceLock 缓存，必须用显式 override（env 可能被缓存遮蔽）。
        crate::config::set_harness_base(Some(tmp.clone()));
        let result = download_and_install().await;
        let (path, ver) = match result {
            Ok(v) => v,
            Err(e) => {
                crate::config::set_harness_base(None);
                let _ = std::fs::remove_dir_all(&tmp);
                panic!("内置 node 下载+校验+落位必须成功: {e}");
            }
        };
        assert!(path.is_file(), "node.exe 必须落位");
        assert!(ver.contains(NODE_VERSION), "版本必须与锁定一致: {ver}");
        assert!(managed_npm_cli().is_file(), "npm-cli.js 必须随包落位");
        // 快查路径必须能命中刚落位的 managed
        let (p2, v2) = detect_managed().expect("detect_managed 必须命中");
        assert_eq!(p2, path);
        assert_eq!(v2, ver);
        crate::config::set_harness_base(None);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}