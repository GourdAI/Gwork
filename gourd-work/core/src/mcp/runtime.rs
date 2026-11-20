//! `mcp::runtime` — stdio 连接器的本地运行时（uv/uvx、Node/npx）检测与代装。
//!
//! 背景（2026-11 用户报障「blender: 检测失败: program not found」）：目录里大量
//! 条目的启动命令是 `uvx …` / `npx …`，它们不是连接器本身，而是**宿主运行时**的
//! 启动器。机器上没装 uv / Node 时 spawn 直接 NotFound，裸报 "program not found"
//! 既没指名缺什么、也没给出路，用户只能理解为「应用坏了」。
//!
//! 本模块提供三件事（用户拍板「远程拉取运行环境 + 交互告知」）：
//! 1. **检测**：`probe(command)` 判断一个裸命令是否可解析（PATH/PATHEXT + 应用
//!    自管目录 `~/.gwork/runtimes/<id>/`），并映射到可代装的运行时 id。
//! 2. **代装**：`RuntimeInstaller` 从官方发行渠道下载 zip → 校验 → 解压到自管
//!    目录。不执行远程安装脚本、不改系统 PATH、不需要管理员权限；进程内把自管
//!    目录前置到 PATH，stdio spawn 即时可用（无需重启应用）。
//! 3. **可行动报错**：`missing_program_message` 把 NotFound 翻译成
//!    「未找到命令 X：它由运行时 Y 提供…」，由 `humanize_connect_error` 统一出口。
//!
//! 下载源（2026-11 实测可达性，见各常量注释）：
//! * uv：`releases.astral.sh`（astral 官方发行 CDN，github releases 的镜像前缀，
//!   国内直连可达；github.com 本体在部分网络不可达，作为回退源）。
//! * Node：npmmirror（阿里镜像，国内首选）→ nodejs.org（官方，回退）。
//!
//! ⚠ 与被删的「内置 Node 运行时」不是一回事：那是随自建官方目录源分发、
//! 无条件预装的 Node（红线：不得复活）。这里是**安装连接器发现缺运行时时
//! 自动按需拉取**的公共发行版运行时（用户二次拍板「零确认点击，交互上只
//! 提示正在下载」），服务三个公开目录源与手动添加的 stdio 连接器。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::Mutex;

/// 应用自管运行时根目录：`~/.gwork/runtimes/`。与凭据库同根，尊重 GWORK_HOME。
pub fn runtimes_dir() -> PathBuf {
    crate::config::Settings::gwork_home().join("runtimes")
}

/// 一个可代装的运行时。id 同时是自管子目录名与 API 参数，前端按钮 data-runtime
/// 也用它——三处必须同一个字符串，改这里要同步语言包 rt_* 键与前端映射。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeId {
    /// astral uv（含 uv.exe 与 uvx.exe）。覆盖 uvx / uv 两个命令。
    Uv,
    /// Node.js LTS（含 node.exe / npx.cmd / npm.cmd）。覆盖 npx / node / npm。
    Node,
}

impl RuntimeId {
    pub fn as_str(self) -> &'static str {
        match self {
            RuntimeId::Uv => "uv",
            RuntimeId::Node => "node",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "uv" | "uvx" => Some(RuntimeId::Uv),
            "node" | "npx" | "npm" => Some(RuntimeId::Node),
            _ => None,
        }
    }

    /// 展示名（报错文案与 API 响应里的人类可读名）。
    pub fn display(self) -> &'static str {
        match self {
            RuntimeId::Uv => "uv (astral)",
            RuntimeId::Node => "Node.js",
        }
    }

    /// 手动安装指引（无法代装的平台 / 下载失败时给用户的出路）。
    pub fn manual_hint(self) -> &'static str {
        match self {
            RuntimeId::Uv => "https://docs.astral.sh/uv/getting-started/installation/",
            RuntimeId::Node => "https://nodejs.org/en/download",
        }
    }

    /// 该运行时落地后应存在的探针文件（相对自管子目录）。
    fn marker(self) -> &'static str {
        match self {
            RuntimeId::Uv => "uvx.exe",
            RuntimeId::Node => "npx.cmd",
        }
    }
}

/// 裸命令 → 提供它的可代装运行时。未知命令返回 None（报错走通用文案，
/// 不能把用户自己的二进制说成 uv/Node 的问题）。
pub fn runtime_for_command(command: &str) -> Option<RuntimeId> {
    let base = command_basename(command)?;
    RuntimeId::parse(&base)
}

/// 取命令的裸名（去路径、去引号、去 Windows 可执行后缀），小写。
/// `C:\tools\uvx.exe` 与 `uvx.cmd` 都归一成 `uvx`；空串返回 None。
pub fn command_basename(command: &str) -> Option<String> {
    let t = command.trim().trim_matches('"').trim_matches('\'');
    if t.is_empty() {
        return None;
    }
    let name = t.rsplit(['\\', '/']).next().unwrap_or(t);
    let lower = name.to_ascii_lowercase();
    let stem = [".exe", ".cmd", ".bat", ".com"]
        .iter()
        .find_map(|ext| lower.strip_suffix(ext))
        .unwrap_or(&lower);
    if stem.is_empty() {
        None
    } else {
        Some(stem.to_string())
    }
}

/// 自管子目录里是否已有该运行时的探针文件。
pub fn managed_marker(id: RuntimeId) -> Option<PathBuf> {
    let p = runtimes_dir().join(id.as_str()).join(id.marker());
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

/// 把应用自管运行时目录前置到**当前进程**的 PATH（幂等）。
///
/// 只改进程环境，不落注册表 / 不改用户 PATH：代装是应用内务，卸载应用即
/// 全部失效，不应污染系统。stdio spawn（`Command` 继承父进程环境）与
/// `resolve_stdio_program`（读 `std::env::var_os("PATH")`）都会即时看到。
pub fn ensure_managed_on_path() {
    let root = runtimes_dir();
    let dirs: Vec<PathBuf> = [RuntimeId::Uv, RuntimeId::Node]
        .iter()
        .map(|id| root.join(id.as_str()))
        .filter(|d| d.is_dir())
        .collect();
    if dirs.is_empty() {
        return;
    }
    let current = std::env::var_os("PATH").unwrap_or_default();
    let existing: Vec<PathBuf> = std::env::split_paths(&current).collect();
    let mut merged: Vec<PathBuf> = Vec::new();
    for d in dirs {
        if !existing.iter().any(|e| e == &d) {
            merged.push(d);
        }
    }
    if merged.is_empty() {
        return;
    }
    merged.extend(existing);
    if let Ok(joined) = std::env::join_paths(merged) {
        std::env::set_var("PATH", joined);
    }
}

/// 国内可达的 PyPI 镜像（清华 TUNA）。uvx 首跑要从 PyPI 拉连接器包及其依赖，
/// pypi.org 直连在部分网络极慢/不可达——这正是「uvx 装好了但 initialize 超时」
/// 的第二段根因。只影响应用代装的 uv 所派生的 uvx 子进程，不碰用户自装的 uv。
const PYPI_MIRROR: &str = "https://pypi.tuna.tsinghua.edu.cn/simple";

/// 给**应用自管**的 uv/uvx spawn 注入国内镜像默认值（用户显式配置优先）。
/// 判据：解析后的可执行文件必须位于 `~/.gwork/runtimes/uv/` 之下——用户
/// 自装的 uv 保持其行为不变，绝不越权改写。
pub fn apply_managed_env(cmd: &mut tokio::process::Command, resolved_program: &str, raw_command: &str) {
    let base = command_basename(raw_command).unwrap_or_default();
    if base != "uv" && base != "uvx" {
        return;
    }
    let managed = runtimes_dir().join(RuntimeId::Uv.as_str());
    if !Path::new(resolved_program).starts_with(&managed) {
        return;
    }
    if std::env::var_os("UV_DEFAULT_INDEX").is_none() && std::env::var_os("UV_INDEX_URL").is_none() {
        cmd.env("UV_DEFAULT_INDEX", PYPI_MIRROR);
    }
    // uv 托管 Python 的下载同样走 GitHub releases（部分网络不可达）；
    // npmmirror 的 python-build-standalone 镜像与 astral 官方发布同构。
    if std::env::var_os("UV_PYTHON_INSTALL_MIRROR").is_none() {
        cmd.env(
            "UV_PYTHON_INSTALL_MIRROR",
            "https://registry.npmmirror.com/-/binary/python-build-standalone",
        );
    }
}

/// spawn NotFound 的可行动文案。`humanize_connect_error` 在识别出
/// 「命令未找到」形态后委托到这里：能映射到运行时的，指名缺什么、给出路；
/// 不能映射的，至少把命令名说清楚（裸 "program not found" 不含命令名，
/// 这正是本次报障文案毫无信息量的原因）。
pub fn missing_program_message(command: &str) -> String {
    let name = command.trim();
    match runtime_for_command(name) {
        Some(id) => format!(
            "未找到命令 {}：它由 {} 提供，本机尚未安装。安装连接器时会自动下载安装该运行环境；也可手动安装后重试（{}）",
            name,
            id.display(),
            id.manual_hint()
        ),
        None => format!(
            "命令无法执行（未找到可执行文件）: {}。请确认该程序已安装且在 PATH 中",
            if name.is_empty() { "(空命令)" } else { name }
        ),
    }
}

// ─── 下载配方 ────────────────────────────────────────────────────────────────

/// 固定的 Node LTS 版本。与「latest 跟随」相比，固定版本让下载 URL、SHASUMS
/// 校验与回归测试全部可复现；升级是一个显式的代码变更（同步契约测试）。
pub const NODE_VERSION: &str = "v22.14.0";

/// 固定的 uv 版本（2026-11 实测 releases.astral.sh 该版本全平台资产可达）。
pub const UV_VERSION: &str = "0.13.9";

/// 一个平台的下载配方：候选 URL 依次尝试（首选国内可达源），外加入库校验。
#[derive(Debug, Clone)]
pub struct Recipe {
    pub urls: Vec<String>,
    /// zip 内目标文件的完整条目名（只提取需要的文件，不全量解压）。
    pub wanted: Vec<Wanted>,
    /// 可选的 SHASUMS256.txt URL（Node 官方发布签名单；uv 无对应清单）。
    pub shasums: Option<String>,
    /// 压缩包字节上限。
    pub max_archive: usize,
}

#[derive(Debug, Clone)]
pub struct Wanted {
    /// zip 条目名（含目录前缀）。
    pub entry: String,
    /// 落盘文件名（相对自管子目录，允许子目录如 node_modules/…）。
    pub dest: String,
}

/// Windows x64 之外平台的配方。返回 Err 表示该平台暂不支持代装（前端只展示
/// 手动指引，不是错误路径——安装按钮不出现）。
pub fn recipe_for(id: RuntimeId) -> Result<Recipe, String> {
    match id {
        RuntimeId::Uv => {
            let target = uv_target()?;
            let file = format!("uv-{}.zip", target);
            let base = format!("https://releases.astral.sh/github/uv/releases/download/{}", UV_VERSION);
            let gh = format!("https://github.com/astral-sh/uv/releases/download/{}", UV_VERSION);
            Ok(Recipe {
                urls: vec![format!("{}/{}", base, file), format!("{}/{}", gh, file)],
                wanted: vec![
                    Wanted { entry: "uv.exe".into(), dest: "uv.exe".into() },
                    Wanted { entry: "uvx.exe".into(), dest: "uvx.exe".into() },
                    Wanted { entry: "uvw.exe".into(), dest: "uvw.exe".into() },
                ],
                shasums: None,
                max_archive: 64 * 1024 * 1024,
            })
        }
        RuntimeId::Node => {
            let (os, arch, ext) = node_platform()?;
            let dir = format!("node-{}-{}-{}", NODE_VERSION, os, arch);
            let file = format!("{}.{}", dir, ext);
            // npmmirror 首选（国内直连），nodejs.org 官方回退。
            let mirror = format!("https://registry.npmmirror.com/-/binary/node/{}/{}", NODE_VERSION, file);
            let official = format!("https://nodejs.org/dist/{}/{}", NODE_VERSION, file);
            let mut wanted = Vec::new();
            if ext == "zip" {
                // Windows 发行 zip：node.exe 在根，npx/npm 是 .cmd shim +
                // node_modules 下的完整 npm 包。npx.cmd 调用相对路径的
                // node_modules\npm\bin\npx-cli.js，缺一个都跑不起来。
                wanted.push(Wanted { entry: format!("{}/node.exe", dir), dest: "node.exe".into() });
                wanted.push(Wanted { entry: format!("{}/npx.cmd", dir), dest: "npx.cmd".into() });
                wanted.push(Wanted { entry: format!("{}/npx", dir), dest: "npx".into() });
                wanted.push(Wanted { entry: format!("{}/npm.cmd", dir), dest: "npm.cmd".into() });
                wanted.push(Wanted { entry: format!("{}/npm", dir), dest: "npm".into() });
                // node_modules/npm/** 由前缀规则收集（见 extract_wanted）。
            } else {
                wanted.push(Wanted { entry: format!("{}/bin/node", dir), dest: "bin/node".into() });
                wanted.push(Wanted { entry: format!("{}/bin/npx", dir), dest: "bin/npx".into() });
                wanted.push(Wanted { entry: format!("{}/bin/npm", dir), dest: "bin/npm".into() });
            }
            Ok(Recipe {
                urls: vec![mirror, official],
                wanted,
                shasums: Some(format!("https://nodejs.org/dist/{}/SHASUMS256.txt", NODE_VERSION)),
                max_archive: 128 * 1024 * 1024,
            })
        }
    }
}

fn uv_target() -> Result<&'static str, String> {
    #[cfg(all(windows, target_arch = "x86_64"))]
    { Ok("x86_64-pc-windows-msvc") }
    #[cfg(all(windows, target_arch = "aarch64"))]
    { Ok("aarch64-pc-windows-msvc") }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    { Ok("aarch64-apple-darwin") }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    { Ok("x86_64-apple-darwin") }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    { Ok("x86_64-unknown-linux-gnu") }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    { Ok("aarch64-unknown-linux-gnu") }
    #[cfg(not(any(
        all(windows, target_arch = "x86_64"),
        all(windows, target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
    )))]
    { Err("当前平台暂不支持自动安装 uv，请参考官方文档手动安装".to_string()) }
}

fn node_platform() -> Result<(&'static str, &'static str, &'static str), String> {
    #[cfg(all(windows, target_arch = "x86_64"))]
    { Ok(("win", "x64", "zip")) }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    { Ok(("darwin", "arm64", "tar.gz")) }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    { Ok(("darwin", "x64", "tar.gz")) }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    { Ok(("linux", "x64", "tar.gz")) }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    { Ok(("linux", "arm64", "tar.gz")) }
    #[cfg(not(any(
        all(windows, target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
    )))]
    { Err("当前平台暂不支持自动安装 Node.js，请参考官网手动安装".to_string()) }
}

// ─── 安装引擎（跨请求状态机，模式对齐 mcp::auth::AuthManager） ─────────────────

/// 一次安装会话的对外快照（GET status 的 data）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct InstallStatus {
    pub runtime: String,
    /// idle | downloading | extracting | done | error
    pub phase: String,
    pub received: u64,
    pub total: u64,
    pub error: String,
    /// done 后的落地目录（诊断/展示用）。
    pub dir: String,
}

struct Session {
    status: InstallStatus,
    /// 完成时唤醒等待方（install 同步等待用；轮询方只看 status）。
    finished: bool,
}

/// 运行时安装管理器。挂在 `AppState`，跨请求存活；同一运行时同时只有一个
/// 会话（重复 start 幂等返回在途会话，绝不并发写同一目录）。
pub struct RuntimeInstaller {
    sessions: Mutex<HashMap<String, Session>>,
}

impl RuntimeInstaller {
    pub fn new() -> Self {
        Self { sessions: Mutex::new(HashMap::new()) }
    }

    /// 检测入口（GET runtime/check?command=）。`resolved` 表示 PATH/自管目录
    /// 里已可找到该命令；`runtime` 是可代装的运行时 id（未知命令为空）。
    pub fn check(command: &str) -> Value {
        ensure_managed_on_path();
        let base = command_basename(command).unwrap_or_default();
        let runtime = runtime_for_command(command);
        let resolved = if base.is_empty() {
            false
        } else {
            super::McpManager::resolve_stdio_program_public(&base)
                .map(|p| Path::new(&p).is_file())
                .unwrap_or(false)
        };
        let installable = runtime.map(|id| recipe_for(id).is_ok()).unwrap_or(false);
        json!({
            "command": base,
            "resolved": resolved,
            "runtime": runtime.map(|r| r.as_str()).unwrap_or(""),
            "runtimeDisplay": runtime.map(|r| r.display()).unwrap_or(""),
            "installable": installable,
            "manualUrl": runtime.map(|r| r.manual_hint()).unwrap_or(""),
        })
    }

    pub async fn status(&self, id: RuntimeId) -> InstallStatus {
        let key = id.as_str().to_string();
        let map = self.sessions.lock().await;
        match map.get(&key) {
            Some(s) => s.status.clone(),
            None => InstallStatus {
                runtime: key,
                phase: if managed_marker(id).is_some() { "done".into() } else { "idle".into() },
                received: 0,
                total: 0,
                error: String::new(),
                dir: runtimes_dir().join(id.as_str()).to_string_lossy().into_owned(),
            },
        }
    }

    /// 启动（或复用在途）安装会话。立即返回；进度走 status 轮询。
    ///
    /// 幂等判定放在**同一把锁内**：marker 检查、在途复用、新会话插入必须
    /// 原子——否则并发 start 都看到「无会话」而各 spawn 一个下载任务，
    /// 同时写同一目录（解压落位互相踩踏）。
    pub async fn start(self: &Arc<Self>, id: RuntimeId) -> Result<InstallStatus, String> {
        let recipe = recipe_for(id)?;
        let key = id.as_str().to_string();
        {
            let mut map = self.sessions.lock().await;
            // 幂等：探针文件已在（本机装过/上次会话已完成）→ 直接 done，绝不重复
            // 下载。用户修好环境后重开弹窗、或另一条目再次触发同一运行时，都秒回。
            if managed_marker(id).is_some() {
                ensure_managed_on_path();
                let st = InstallStatus {
                    runtime: key.clone(),
                    phase: "done".into(),
                    received: 0,
                    total: 0,
                    error: String::new(),
                    dir: runtimes_dir().join(id.as_str()).to_string_lossy().into_owned(),
                };
                map.insert(key, Session { status: st.clone(), finished: true });
                return Ok(st);
            }
            if let Some(s) = map.get(&key) {
                if s.status.phase == "downloading" || s.status.phase == "extracting" {
                    return Ok(s.status.clone());
                }
            }
            map.insert(key.clone(), Session {
                status: InstallStatus {
                    runtime: key.clone(),
                    phase: "downloading".into(),
                    received: 0,
                    total: 0,
                    error: String::new(),
                    dir: runtimes_dir().join(id.as_str()).to_string_lossy().into_owned(),
                },
                finished: false,
            });
        }
        let me = Arc::clone(self);
        tokio::spawn(async move {
            let result = run_install(id, &recipe, &me).await;
            let mut map = me.sessions.lock().await;
            if let Some(s) = map.get_mut(&key) {
                s.finished = true;
                match result {
                    Ok(()) => {
                        s.status.phase = "done".into();
                        s.status.error = String::new();
                    }
                    Err(e) => {
                        s.status.phase = "error".into();
                        s.status.error = e;
                    }
                }
            }
        });
        Ok(self.status(id).await)
    }

    async fn set_progress(&self, key: &str, phase: &str, received: u64, total: u64) {
        let mut map = self.sessions.lock().await;
        if let Some(s) = map.get_mut(key) {
            s.status.phase = phase.into();
            s.status.received = received;
            s.status.total = total;
        }
    }
}

impl Default for RuntimeInstaller {
    fn default() -> Self {
        Self::new()
    }
}

/// 下载 + 校验 + 提取 + 落位。任何一步失败都清理 staging，不留半成品；
/// 旧版本目录整体替换（安装即升级/修复）。
async fn run_install(id: RuntimeId, recipe: &Recipe, mgr: &Arc<RuntimeInstaller>) -> Result<(), String> {
    let key = id.as_str();
    let (bytes, url) = download_first(&recipe.urls, recipe.max_archive, |received, total| {
        // 进度回调是同步闭包，不能 await 锁；用 try_lock 尽力更新（丢一两帧无妨）。
        if let Ok(mut map) = mgr.sessions.try_lock() {
            if let Some(s) = map.get_mut(key) {
                s.status.received = received;
                s.status.total = total;
            }
        }
    })
    .await?;
    tracing::info!(runtime = key, url = %url, bytes = bytes.len(), "runtime archive downloaded");

    // Node：官方 SHASUMS256 清单校验（清单拿不到时降级为「zip 结构 + CRC 校验」，
    // 不静默跳过——日志明说）。uv 无官方清单，靠 HTTPS + zip CRC。
    if let Some(shasums_url) = &recipe.shasums {
        let file_name = url.rsplit('/').next().unwrap_or("");
        match fetch_text(shasums_url).await {
            Ok(text) => {
                let expected = text.lines().find_map(|l| {
                    let mut it = l.split_whitespace();
                    let hash = it.next()?;
                    let name = it.next()?;
                    (name == file_name).then(|| hash.to_ascii_lowercase())
                });
                match expected {
                    Some(hash) => {
                        use sha2::Digest;
                        let actual = hex::encode(sha2::Sha256::digest(&bytes));
                        if actual != hash {
                            return Err(format!("安装包校验失败（SHA-256 不匹配），已拒绝安装: {}", file_name));
                        }
                    }
                    None => tracing::warn!(file = file_name, "SHASUMS256.txt 未包含该文件，跳过哈希校验"),
                }
            }
            Err(e) => tracing::warn!(error = %e, "SHASUMS256.txt 拉取失败，跳过哈希校验"),
        }
    }

    mgr.set_progress(key, "extracting", bytes.len() as u64, bytes.len() as u64).await;
    let root = runtimes_dir();
    let staging = root.join(format!(".staging-{}-{}", key, uuid::Uuid::new_v4()));
    let dest = root.join(key);
    let is_zip = url.ends_with(".zip");
    let wanted = recipe.wanted.clone();
    let staging_for_extract = staging.clone();
    let extract = tokio::task::spawn_blocking(move || -> Result<(), String> {
        if is_zip {
            extract_wanted_zip(&bytes, &staging_for_extract, &wanted, id)
        } else {
            extract_wanted_targz(&bytes, &staging_for_extract, &wanted, id)
        }
    })
    .await
    .map_err(|e| format!("解压任务失败: {}", e))?;
    if let Err(e) = extract {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    // 落位：旧目录先挪走再删（rename 原子性远高于逐文件覆盖），失败回滚。
    let old = root.join(format!(".old-{}-{}", key, uuid::Uuid::new_v4()));
    if dest.exists() {
        std::fs::rename(&dest, &old).map_err(|e| format!("替换旧运行时失败: {}", e))?;
    }
    if let Err(e) = std::fs::rename(&staging, &dest) {
        if old.exists() {
            let _ = std::fs::rename(&old, &dest);
        }
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!("安装落位失败: {}", e));
    }
    let _ = std::fs::remove_dir_all(&old);
    // Unix：bin/ 下的可执行位（zip/tar 提取器不保留权限的场景兜底）。
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(rd) = std::fs::read_dir(dest.join("bin")) {
            for f in rd.flatten() {
                let _ = std::fs::set_permissions(f.path(), std::fs::Permissions::from_mode(0o755));
            }
        }
    }
    ensure_managed_on_path();
    if managed_marker(id).is_none() {
        return Err(format!("安装完成但未找到 {}，安装包结构可能已变化", id.marker()));
    }
    Ok(())
}

/// 依次尝试候选 URL，返回首个成功的 (字节, 实际 URL)。全部失败时把每个源的
/// 错误都带上（用户网络到底堵在哪一段，一眼可见）。
async fn download_first(
    urls: &[String],
    cap: usize,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<(Vec<u8>, String), String> {
    let client = reqwest::Client::builder()
        .user_agent(super::market_http::USER_AGENT)
        .connect_timeout(std::time::Duration::from_secs(15))
        // 大包慢网：总超时给足 10 分钟（Node zip ~30MB）。
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("HTTP 客户端构建失败: {}", e))?;
    let mut errors: Vec<String> = Vec::new();
    for url in urls {
        match download_one(&client, url, cap, &mut on_progress).await {
            Ok(bytes) => return Ok((bytes, url.clone())),
            Err(e) => {
                tracing::warn!(url = %url, error = %e, "runtime download source failed, trying next");
                errors.push(format!("{}: {}", url, e));
            }
        }
    }
    Err(format!("运行环境下载失败（所有源均不可用）：{}", errors.join("；")))
}

async fn download_one(
    client: &reqwest::Client,
    url: &str,
    cap: usize,
    on_progress: &mut impl FnMut(u64, u64),
) -> Result<Vec<u8>, String> {
    use futures_util::StreamExt;
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        if buf.len() + chunk.len() > cap {
            return Err(format!("安装包超过 {} 字节上限，已拒绝", cap));
        }
        buf.extend_from_slice(&chunk);
        on_progress(buf.len() as u64, total);
    }
    if buf.is_empty() {
        return Err("下载内容为空".into());
    }
    Ok(buf)
}

async fn fetch_text(url: &str) -> Result<String, String> {
    let resp = super::market_http::client()
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    resp.text().await.map_err(|e| e.to_string())
}

/// 从 zip 提取指定文件 + Node 的 node_modules/npm/** 前缀树。
/// 复用 skills 市场的加固 zip 解析（EOCD/中央目录/zip-slip/CRC/体积上限），
/// 但**只落需要的条目**——Node zip 全量 ~110MB，我们只要 node.exe + npm 树。
fn extract_wanted_zip(zip: &[u8], dest: &Path, wanted: &[Wanted], id: RuntimeId) -> Result<(), String> {
    let records = crate::skills::market::zip_records(zip)?;
    std::fs::create_dir_all(dest).map_err(|e| format!("创建安装目录失败: {}", e))?;
    let npm_prefix = match id {
        RuntimeId::Node => Some("/node_modules/npm/".to_string()),
        _ => None,
    };
    let mut got_marker = false;
    for rec in &records {
        let name = rec.name.replace('\\', "/");
        if crate::skills::market::zip_entry_unsafe(&name) {
            let _ = std::fs::remove_dir_all(dest);
            return Err(format!("拒绝不安全的压缩包条目: {}", name));
        }
        let target: Option<String> = wanted
            .iter()
            .find(|w| w.entry == name)
            .map(|w| w.dest.clone())
            .or_else(|| {
                npm_prefix.as_ref().and_then(|p| {
                    name.find(p.as_str()).map(|i| {
                        // dest 侧保持 node_modules/npm/… 相对结构（npx.cmd 按相对路径找）。
                        format!("node_modules/npm/{}", &name[i + p.len()..])
                    })
                })
            });
        let Some(rel) = target else { continue };
        if rec.dir || rel.is_empty() || rel.ends_with('/') {
            continue;
        }
        let out = dest.join(&rel);
        if !out.starts_with(dest) {
            let _ = std::fs::remove_dir_all(dest);
            return Err(format!("拒绝越界的压缩包条目: {}", name));
        }
        let bytes = crate::skills::market::zip_entry_bytes(zip, rec)
            .map_err(|e| format!("解压失败 ({}): {}", name, e))?;
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
        }
        std::fs::write(&out, &bytes).map_err(|e| format!("写入失败 ({}): {}", rel, e))?;
        if rel == id.marker() {
            got_marker = true;
        }
    }
    if !got_marker {
        let _ = std::fs::remove_dir_all(dest);
        return Err(format!("安装包中未找到 {}（上游包结构变化？）", id.marker()));
    }
    Ok(())
}

/// tar.gz 版（macOS/Linux Node 发行包）。同样只提取 wanted + npm 树。
fn extract_wanted_targz(gz: &[u8], dest: &Path, wanted: &[Wanted], id: RuntimeId) -> Result<(), String> {
    use std::io::Read;
    let mut tar_bytes = Vec::new();
    flate2::read::GzDecoder::new(gz)
        .take(crate::skills::market::MAX_UNCOMPRESSED_BYTES)
        .read_to_end(&mut tar_bytes)
        .map_err(|e| format!("gzip 解压失败: {}", e))?;
    std::fs::create_dir_all(dest).map_err(|e| format!("创建安装目录失败: {}", e))?;
    let npm_prefix = match id {
        RuntimeId::Node => Some("/lib/node_modules/npm/".to_string()),
        _ => None,
    };
    let mut pos = 0usize;
    let mut got_marker = false;
    while pos + 512 <= tar_bytes.len() {
        let header = &tar_bytes[pos..pos + 512];
        if header.iter().all(|&b| b == 0) {
            break;
        }
        let name = String::from_utf8_lossy(&header[..100]).trim_end_matches('\0').to_string();
        let size_str = String::from_utf8_lossy(&header[124..136]);
        let size = usize::from_str_radix(size_str.trim().trim_end_matches('\0'), 8).unwrap_or(0);
        let typeflag = header[156];
        let data_start = pos + 512;
        let data_end = data_start + size;
        if data_end > tar_bytes.len() {
            return Err("tar 截断".into());
        }
        if crate::skills::market::zip_entry_unsafe(&name) {
            let _ = std::fs::remove_dir_all(dest);
            return Err(format!("拒绝不安全的压缩包条目: {}", name));
        }
        if typeflag == b'0' || typeflag == 0 {
            let target: Option<String> = wanted
                .iter()
                .find(|w| w.entry == name)
                .map(|w| w.dest.clone())
                .or_else(|| {
                    npm_prefix.as_ref().and_then(|p| {
                        name.find(p.as_str()).map(|i| {
                            // Unix npx/npm 是 ../lib/node_modules/npm/bin/*-cli.js 的符号链接；
                            // 这里直接落真实文件到 bin/（见下方 symlink 处理），npm 树落 lib/。
                            format!("lib/node_modules/npm/{}", &name[i + p.len()..])
                        })
                    })
                });
            if let Some(rel) = target {
                let out = dest.join(&rel);
                if out.starts_with(dest) {
                    if let Some(parent) = out.parent() {
                        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
                    }
                    std::fs::write(&out, &tar_bytes[data_start..data_end])
                        .map_err(|e| format!("写入失败 ({}): {}", rel, e))?;
                    if rel == id.marker() || rel == format!("bin/{}", id.marker()) {
                        got_marker = true;
                    }
                }
            }
        } else if typeflag == b'2' {
            // symlink：Node tar 里 bin/npx → ../lib/node_modules/npm/bin/npx-cli.js。
            // 落成小 shell 包装（exec node 真实 cli），避免依赖文件系统符号链接权限。
            let linkname = String::from_utf8_lossy(&header[157..257]).trim_end_matches('\0').to_string();
            if let Some(w) = wanted.iter().find(|w| w.entry == name) {
                let cli = linkname.rsplit('/').next().unwrap_or("").to_string();
                let out = dest.join(&w.dest);
                if let Some(parent) = out.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
                }
                let script = format!(
                    "#!/bin/sh\nexec \"$(dirname \"$0\")/node\" \"$(dirname \"$0\")/../lib/node_modules/npm/bin/{}\" \"$@\"\n",
                    cli
                );
                std::fs::write(&out, script).map_err(|e| format!("写入失败 ({}): {}", w.dest, e))?;
                if w.dest == format!("bin/{}", id.marker()) {
                    got_marker = true;
                }
            }
        }
        // 512 对齐。
        pos = data_start + ((size + 511) / 512) * 512;
    }
    if !got_marker {
        let _ = std::fs::remove_dir_all(dest);
        return Err(format!("安装包中未找到 {}（上游包结构变化？）", id.marker()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_basename_normalizes_paths_quotes_and_extensions() {
        assert_eq!(command_basename("uvx").as_deref(), Some("uvx"));
        assert_eq!(command_basename("  npx.cmd ").as_deref(), Some("npx"));
        assert_eq!(command_basename("C:\\tools\\uvx.exe").as_deref(), Some("uvx"));
        assert_eq!(command_basename("\"C:\\Program Files\\nodejs\\npx.cmd\"").as_deref(), Some("npx"));
        assert_eq!(command_basename("/usr/local/bin/node").as_deref(), Some("node"));
        assert_eq!(command_basename(""), None);
        assert_eq!(command_basename("   "), None);
    }

    #[test]
    fn runtime_mapping_covers_launchers_not_arbitrary_commands() {
        assert_eq!(runtime_for_command("uvx"), Some(RuntimeId::Uv));
        assert_eq!(runtime_for_command("uv"), Some(RuntimeId::Uv));
        assert_eq!(runtime_for_command("npx"), Some(RuntimeId::Node));
        assert_eq!(runtime_for_command("node"), Some(RuntimeId::Node));
        assert_eq!(runtime_for_command("npm.cmd"), Some(RuntimeId::Node));
        // 用户自己的程序不得被误归因到 uv/Node。
        assert_eq!(runtime_for_command("blender"), None);
        assert_eq!(runtime_for_command("python"), None);
        assert_eq!(runtime_for_command("docker"), None);
    }

    #[test]
    fn missing_message_names_command_and_gives_a_way_out() {
        let msg = missing_program_message("uvx");
        assert!(msg.contains("uvx"), "{}", msg);
        assert!(msg.contains("uv"), "{}", msg);
        assert!(msg.contains("安装"), "{}", msg);
        // 未知命令：至少含命令名与 PATH 提示，不再是裸 program not found。
        let other = missing_program_message("my-tool");
        assert!(other.contains("my-tool"), "{}", other);
        assert!(other.contains("PATH"), "{}", other);
        // 绝不能把未知命令说成 uv/Node 的问题。
        assert!(!other.contains("astral"), "{}", other);
    }

    #[test]
    fn recipes_pin_versions_and_prefer_reachable_sources() {
        // uv：astral CDN 首选（github 本体部分网络不可达，只作回退）。
        let uv = recipe_for(RuntimeId::Uv).expect("本平台应支持 uv 代装");
        assert!(uv.urls[0].starts_with("https://releases.astral.sh/"), "{:?}", uv.urls);
        assert!(uv.urls.iter().all(|u| u.contains(UV_VERSION)), "{:?}", uv.urls);
        assert!(uv.wanted.iter().any(|w| w.dest == "uvx.exe" || w.dest == "uvx"));
        // Node：npmmirror 首选、nodejs.org 回退，版本固定可复现。
        let node = recipe_for(RuntimeId::Node).expect("本平台应支持 Node 代装");
        assert!(node.urls[0].contains("npmmirror.com"), "{:?}", node.urls);
        assert!(node.urls[1].contains("nodejs.org"), "{:?}", node.urls);
        assert!(node.urls.iter().all(|u| u.contains(NODE_VERSION)), "{:?}", node.urls);
        assert!(node.shasums.as_deref().unwrap().contains("SHASUMS256.txt"));
    }

    #[test]
    fn runtime_id_parse_round_trips() {
        for (raw, expect) in [("uv", "uv"), ("uvx", "uv"), ("npx", "node"), ("npm", "node"), ("node", "node")] {
            assert_eq!(RuntimeId::parse(raw).unwrap().as_str(), expect);
        }
        assert!(RuntimeId::parse("python").is_none());
        assert!(RuntimeId::parse("").is_none());
    }

    #[tokio::test]
    async fn installer_status_is_idle_without_session() {
        let mgr = RuntimeInstaller::new();
        let st = mgr.status(RuntimeId::Uv).await;
        // 本机装过（自管目录有 marker）时是 done，否则 idle；两者都合法。
        assert!(st.phase == "idle" || st.phase == "done", "{}", st.phase);
        assert!(st.error.is_empty());
    }

    #[test]
    fn check_reports_unknown_command_without_runtime() {
        let v = RuntimeInstaller::check("definitely-not-real-xyz");
        assert_eq!(v["resolved"], json!(false));
        assert_eq!(v["runtime"], json!(""));
        assert_eq!(v["installable"], json!(false));
    }

    #[test]
    fn managed_env_only_touches_app_installed_uv() {
        // 自装 uv（PATH 上的任意路径）不得被改写环境。
        let mut cmd = tokio::process::Command::new("uvx");
        apply_managed_env(&mut cmd, "C:\\Users\\x\\scoop\\shims\\uvx.exe", "uvx");
        let envs: Vec<_> = cmd.as_std().get_envs().collect();
        assert!(envs.is_empty(), "自装 uv 不得注入镜像: {:?}", envs);
        // 非 uv 命令（node/npx/用户程序）同样不碰。
        let mut cmd2 = tokio::process::Command::new("npx");
        let managed_npx = runtimes_dir().join("uv").join("npx.exe");
        apply_managed_env(&mut cmd2, &managed_npx.to_string_lossy(), "npx");
        assert!(cmd2.as_std().get_envs().next().is_none());
        // 应用自管 uvx：注入 PyPI 镜像（用户显式 UV_DEFAULT_INDEX 优先的分支
        // 依赖进程环境，这里只钉「自管路径 + uvx 命令」触发注入）。
        let mut cmd3 = tokio::process::Command::new("uvx");
        let managed_uvx = runtimes_dir().join("uv").join("uvx.exe");
        apply_managed_env(&mut cmd3, &managed_uvx.to_string_lossy(), "uvx");
        let keys: Vec<String> = cmd3.as_std().get_envs()
            .map(|(k, _)| k.to_string_lossy().into_owned()).collect();
        if std::env::var_os("UV_DEFAULT_INDEX").is_none() && std::env::var_os("UV_INDEX_URL").is_none() {
            assert!(keys.iter().any(|k| k == "UV_DEFAULT_INDEX"), "{:?}", keys);
        }
    }

    #[test]
    fn check_maps_uvx_to_installable_uv() {
        let v = RuntimeInstaller::check("uvx");
        assert_eq!(v["runtime"], json!("uv"));
        // 平台支持时 installable=true；本机已装则 resolved=true。
        assert!(v["installable"].is_boolean());
        assert!(v["resolved"].is_boolean());
    }
}