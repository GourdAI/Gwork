//! `mcp::cli` — CLI 连接器生命周期：安装 / 扫码登录 / 状态 / 登出。
//!
//! 钉钉/飞书/企微/腾讯会议等厂商官方连接器不是 MCP 服务，而是「npm CLI +
//! 官方技能包」：授权走 CLI 自己的扫码/浏览器流程，凭据由 CLI 自管
//! （Keychain/本地配置），GWork 全程不接触 token 明文。本模块是声明式编排器：
//!
//! * **安装**：ensureNode → `node npm-cli.js install --prefix … <pkg>@<ver>`
//!   （npmmirror 优先、官方 registry 兜底）→ 技能包从目录条目 `skills_zip`
//!   解包落 `~/.gwork/skills/`（复用 skills::market 的 hardened 解包管线）。
//! * **登录**：spawn CLI auth argv → 逐行读 stdout，按 `urlDomain` 白名单提取
//!   https 授权 URL（企微另有 `--output-qrcode` PNG）→ 会话状态机
//!   pending → granted/failed/expired；`waitForExit` 的 CLI 以进程退出+status
//!   复核为准。多步授权（飞书 config init → auth login）按 authSteps 顺序推进。
//! * **信任边界**：cli_spec 只来自编译期内嵌的官方目录快照（`registry.json.gz`，
//!   `mcp::registry` 结构校验护栏），发版时已审过——本模块拿到的 argv 永远是
//!   固定命令，绝不拼接用户输入进 shell。快照随客户端发版更新，无远程增量。
//!
//! 所有子进程 CREATE_NO_WINDOW（GUI 宿主不闪黑框）；per-id 单飞防连点。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{watch, Mutex as AsyncMutex};

// ─── cli_spec 形态（与 gourd-connectors 数据契约对齐） ──────────────────────

#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CliSpec {
    pub package: String,
    pub version: String,
    /// 包内可执行相对路径（js 用 node 直跑；原生 exe 配 runtime:"native"）。
    pub bin_path: String,
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub npm_env: HashMap<String, String>,
    #[serde(default)]
    pub auth: Option<CliAuthStep>,
    /// 多步授权（飞书）。与 auth 二选一；都缺则报错。
    #[serde(default)]
    pub auth_steps: Vec<CliAuthStep>,
    pub status: CliStatusCmd,
    #[serde(default)]
    pub unauth: Option<CliUnauth>,
}

/// skipIf 兼容两种历史形态：字符串数组 `["config","show"]`（新契约）与
/// 对象 `{"argv":["config","show"]}`（首版数据，曾导致 serde 整体解析失败 →
/// 飞书 100% 不可用）。旧快照可能仍躺在用户磁盘缓存里，必须双向兼容。
fn de_skip_if<'de, D>(d: D) -> Result<Option<Vec<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Shape {
        Args(Vec<String>),
        Wrapped { argv: Vec<String> },
    }
    Ok(match Option::<Shape>::deserialize(d)? {
        None => None,
        Some(Shape::Args(v)) => Some(v),
        Some(Shape::Wrapped { argv }) => Some(argv),
    })
}

#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CliAuthStep {
    pub argv: Vec<String>,
    pub url_domain: String,
    #[serde(default)]
    pub wait_for_exit: bool,
    /// 企微：`--output-qrcode` 的参数占位（spec 里写 "{qr}"，运行时替换为临时 PNG 路径）。
    #[serde(default)]
    pub qr_png_arg: Option<String>,
    /// 飞书第一步：skipIf 命令成功则跳过本步（兼容数组/对象两种形态）。
    #[serde(default, deserialize_with = "de_skip_if")]
    pub skip_if: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CliStatusCmd {
    pub argv: Vec<String>,
    #[serde(default)]
    pub match_json: HashMap<String, String>,
    #[serde(default)]
    pub match_regex: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CliUnauth {
    #[serde(default)]
    pub argv: Vec<String>,
}

impl CliSpec {
    pub fn from_entry(entry: &Value) -> Option<Self> {
        let spec = entry.get("cli_spec")?;
        serde_json::from_value(spec.clone()).ok()
    }
    /// 授权步骤序列（auth 单步 → 1 元素；authSteps → 原序）。
    pub fn steps(&self) -> Vec<CliAuthStep> {
        if !self.auth_steps.is_empty() {
            return self.auth_steps.clone();
        }
        self.auth.clone().into_iter().collect()
    }
}

// ─── 目录布局 ────────────────────────────────────────────────────────────────

fn cli_prefix() -> PathBuf {
    crate::runtime::node::binaries_dir().join("node").join("cli-packages")
}
fn cli_cache() -> PathBuf {
    crate::runtime::node::binaries_dir().join("node").join("cli-cache")
}
fn skills_dir() -> PathBuf {
    crate::config::Settings::gwork_home().join("skills")
}

/// 包安装目录（npm --prefix 布局：node_modules/<package>）。
fn pkg_dir(package: &str) -> PathBuf {
    cli_prefix().join("node_modules").join(package)
}

/// 已安装判定：binPath 存在。
pub fn is_installed(spec: &CliSpec) -> bool {
    resolve_bin(spec).map(|(_, rel)| rel.is_file()).unwrap_or(false)
}

/// 解析可执行：native → 直接 exe；否则 node.exe + 包内 js。
///
/// 只读定位（绝不触发下载）：进程重启后 `node::status()` 的进程内 STATE 为
/// absent，若依赖它，所有已装/已授权 CLI 在 `cli/state` / `start_auth` /
/// `uninstall` 里都会解析失败，卡片回退为「未连接」、断开登出也失效。
/// 下载只在 `run_install` 的 `ensure()` 里发生。
fn resolve_bin(spec: &CliSpec) -> Option<(PathBuf, PathBuf)> {
    let rel = pkg_dir(&spec.package).join(&spec.bin_path);
    if spec.runtime.as_deref() == Some("native") {
        return Some((rel.clone(), rel));
    }
    let (node, _) = crate::runtime::node::locate()?;
    Some((node, rel))
}

// ─── 安装状态机 ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstallState {
    /// idle | node | npm | skills | done | failed
    pub phase: String,
    pub node_progress: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

static INSTALLS: OnceLock<Mutex<HashMap<String, InstallState>>> = OnceLock::new();
static INSTALL_GATES: OnceLock<AsyncMutex<()>> = OnceLock::new();
/// per-id 在途集合：判相位与置相位必须原子，否则并发 cli_install 会双 spawn。
static INFLIGHT: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();

fn inflight() -> &'static Mutex<std::collections::HashSet<String>> {
    INFLIGHT.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

fn installs() -> &'static Mutex<HashMap<String, InstallState>> {
    INSTALLS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn install_state(id: &str) -> InstallState {
    installs().lock().ok()
        .and_then(|g| g.get(id).cloned())
        .unwrap_or_default()
}

fn set_install(id: &str, s: InstallState) {
    if let Ok(mut g) = installs().lock() {
        g.insert(id.to_string(), s);
    }
}

/// 触发安装（后台任务）。per-id 单飞用 INFLIGHT 原子占位，杜绝并发双 spawn。
pub fn start_install(id: &str) -> InstallState {
    // 原子占位：insert 返回 false 说明同 id 已有任务在途。
    // **占位后立即写入有效态**：并发命中者不能读到尚未初始化的空相位
    // （全量测试并行时实测过 phase="" 的竞态窗口）。
    {
        let mut g = inflight().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if !g.insert(id.to_string()) {
            let mut cur = install_state(id);
            if cur.phase.is_empty() {
                cur = InstallState { phase: "node".into(), ..Default::default() };
            }
            return cur;
        }
    }
    set_install(id, InstallState { phase: "node".into(), ..Default::default() });
    let Some(entry) = crate::mcp::registry::detail(id) else {
        inflight().lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(id);
        let s = InstallState { phase: "failed".into(), error: Some("连接器不存在或已下架".into()), ..Default::default() };
        set_install(id, s.clone());
        return s;
    };
    let Some(spec) = CliSpec::from_entry(&entry) else {
        inflight().lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(id);
        let s = InstallState { phase: "failed".into(), error: Some("条目缺少 cli_spec".into()), ..Default::default() };
        set_install(id, s.clone());
        return s;
    };
    set_install(id, InstallState { phase: "node".into(), ..Default::default() });
    let id_owned = id.to_string();
    tokio::spawn(async move {
        let gate = INSTALL_GATES.get_or_init(|| AsyncMutex::new(()));
        let _guard = gate.lock().await; // npm 全局缓存并发写保护
        let result = run_install(&id_owned, &spec, &entry).await;
        match result {
            Ok(()) => set_install(&id_owned, InstallState { phase: "done".into(), node_progress: 100, error: None }),
            Err(e) => set_install(&id_owned, InstallState { phase: "failed".into(), error: Some(e), ..Default::default() }),
        }
        inflight().lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&id_owned);
    });
    install_state(id)
}

async fn run_install(id: &str, spec: &CliSpec, entry: &Value) -> Result<(), String> {
    // 1. Node 保障（下载进度透传到安装状态）。
    let mut st = crate::runtime::node::ensure();
    loop {
        match st.status.as_str() {
            "ready" => break,
            "failed" => return Err(st.error.unwrap_or_else(|| "Node 运行时准备失败".into())),
            _ => {
                set_install(id, InstallState { phase: "node".into(), node_progress: st.progress, error: None });
                tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                st = crate::runtime::node::status();
            }
        }
    }
    let (node, npm) = crate::runtime::node::node_and_npm()
        .ok_or("Node 已就绪但找不到 npm-cli.js（系统 Node 布局异常，请安装官方 Node.js）")?;

    // 2. 磁盘护栏（dws 解包 ~400MB；不足明确报错）。
    check_disk_space(600 * 1024 * 1024)?;

    // 3. npm install（npmmirror 优先，官方兜底）。
    set_install(id, InstallState { phase: "npm".into(), node_progress: 100, error: None });
    let pkg_spec = format!("{}@{}", spec.package, spec.version);
    let prefix = cli_prefix();
    let cache = cli_cache();
    tokio::fs::create_dir_all(&prefix).await.map_err(|e| format!("创建安装目录失败: {e}"))?;
    tokio::fs::create_dir_all(&cache).await.map_err(|e| format!("创建缓存目录失败: {e}"))?;
    let registries = ["https://registry.npmmirror.com", "https://registry.npmjs.org"];
    let mut last_err = String::from("npm 安装失败");
    let mut installed = false;
    for registry in registries {
        let mut cmd = Command::new(&node);
        cmd.arg(&npm)
            .arg("install")
            .arg("--prefix").arg(&prefix)
            .arg("--cache").arg(&cache)
            .arg("--registry").arg(registry)
            .arg("--no-audit").arg("--no-fund")
            .arg("--loglevel=error")
            .arg(&pkg_spec);
        for (k, v) in &spec.npm_env {
            cmd.env(k, v);
        }
        no_window(&mut cmd);
        match cmd.output().await {
            Ok(out) if out.status.success() => { installed = true; break; }
            Ok(out) => {
                last_err = format!("npm 安装失败（{registry}）: {}", String::from_utf8_lossy(&out.stderr).trim());
            }
            Err(e) => last_err = format!("npm 启动失败: {e}"),
        }
    }
    if !installed {
        return Err(last_err);
    }
    if !is_installed(spec) {
        return Err(format!("npm 安装完成但 {} 未落位", spec.bin_path));
    }

    // 4. 技能包落位（条目内嵌 skills_zip，base64 → hardened 解包）。
    set_install(id, InstallState { phase: "skills".into(), node_progress: 100, error: None });
    if let Some(b64) = entry.get("skills_zip").and_then(Value::as_str) {
        if !b64.trim().is_empty() {
            install_skills_zip(b64, entry)?;
        }
    }
    Ok(())
}

/// 技能 zip 落位：zip 内每个顶层目录 = 一个技能，落 ~/.gwork/skills/<dir>/。
/// 复用 skills::market::unpack_zip（防 zip-slip/bomb/CRC），先解到 staging 再搬。
fn install_skills_zip(b64: &str, entry: &Value) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("技能包 base64 解码失败: {e}"))?;
    let staging = crate::runtime::node::binaries_dir().join(".cache")
        .join(format!("cli-skills-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    crate::skills::market::unpack_zip(&bytes, &staging, crate::skills::market::UnpackMode::AsIs)
        .map_err(|e| format!("技能包解包失败: {e}"))?;
    // 条目 skills 清单决定落哪些目录（白名单，防 zip 里夹带额外目录）。
    // dir 契约 = zip 内相对路径（如 "skills/wecomcli-calendar"）；落盘名取末段
    // （~/.gwork/skills/wecomcli-calendar）。允许单层子目录前缀，拒绝穿越。
    let allowed: Vec<String> = entry.get("skills").and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|s| s.get("dir").and_then(Value::as_str).map(String::from)).collect())
        .unwrap_or_default();
    let dest_root = skills_dir();
    std::fs::create_dir_all(&dest_root).map_err(|e| format!("创建技能目录失败: {e}"))?;
    for dir in &allowed {
        let norm = dir.replace('\\', "/");
        if norm.split('/').any(|seg| seg == ".." || seg.is_empty()) || norm.starts_with('/') || norm.contains(':') {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(format!("非法技能目录名: {dir}"));
        }
        let leaf = norm.rsplit('/').next().unwrap_or("");
        if leaf.is_empty() {
            continue;
        }
        let src = staging.join(&norm);
        if !src.is_dir() {
            continue; // 清单里有但 zip 里没有：跳过（数据层已保证一致）
        }
        let dst = dest_root.join(leaf);
        let _ = std::fs::remove_dir_all(&dst);
        std::fs::rename(&src, &dst).map_err(|e| format!("技能落位失败 {dir}: {e}"))?;
    }
    let _ = std::fs::remove_dir_all(&staging);
    crate::skills::invalidate_cache();
    Ok(())
}

#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}
#[cfg(not(windows))]
fn no_window(_cmd: &mut Command) {}

/// 磁盘可用空间检查（Windows GetDiskFreeSpaceExW；其他平台跳过）。
fn check_disk_space(need: u64) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let dir = crate::runtime::node::binaries_dir();
        let root = dir.ancestors().find(|p| p.parent().is_none()).unwrap_or(Path::new("C:\\"));
        let wide: Vec<u16> = root.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let mut free: u64 = 0;
        extern "system" {
            fn GetDiskFreeSpaceExW(lpDirectoryName: *const u16, lpFreeBytesAvailableToCaller: *mut u64, lpTotalNumberOfBytes: *mut u64, lpTotalNumberOfFreeBytes: *mut u64) -> i32;
        }
        let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) };
        if ok != 0 && free < need {
            return Err(format!("磁盘空间不足（需约 {}MB，可用 {}MB）", need / 1024 / 1024, free / 1024 / 1024));
        }
    }
    #[cfg(not(windows))]
    { let _ = need; }
    Ok(())
}

// ─── 授权会话状态机 ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuthState {
    /// idle | pending | waiting_url | granted | failed | expired
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authorization_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qr_png: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct AuthSession {
    state: AuthState,
    /// 代际：旧 run_auth 任务不得改写新会话（换码/重试时真实发生过串码）。
    gen: u64,
    cancel: Arc<AtomicBool>,
    /// 取消通知：让「等待 stdout 行」的循环立即被唤醒，而不是等 600s deadline。
    cancel_tx: watch::Sender<bool>,
    child_pid: Option<u32>,
}

static AUTHS: OnceLock<Mutex<HashMap<String, AuthSession>>> = OnceLock::new();
static AUTH_GEN: AtomicU64 = AtomicU64::new(0);
fn auths() -> &'static Mutex<HashMap<String, AuthSession>> {
    AUTHS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn auth_state(id: &str) -> AuthState {
    auths().lock().unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(id).map(|s| s.state.clone()).unwrap_or_default()
}

/// 只有同代、未取消的会话才能被后台任务改写。
fn set_auth(id: &str, gen: u64, st: AuthState) {
    let mut g = auths().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(s) = g.get_mut(id) {
        if s.gen == gen && !s.cancel.load(Ordering::SeqCst) {
            s.state = st;
        }
    }
}

/// 登记子进程 pid（同代才登记，防旧任务把新会话的 pid 覆盖成僵尸 id）。
fn register_child(id: &str, gen: u64, pid: u32) {
    let mut g = auths().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(s) = g.get_mut(id) {
        if s.gen == gen && !s.cancel.load(Ordering::SeqCst) {
            s.child_pid = Some(pid);
        }
    }
}

/// 从 CLI stdout 行里提取授权 URL：https + 域名白名单（精确或子域）。
/// 拒绝 userinfo（`https://evil@legit.com`）、非 443 端口与行尾标点残留，
/// 避免把 CLI 输出里的钓鱼/跟踪链接或非标地址当成授权 URL 交给前端。
pub fn extract_auth_url(line: &str, domain: &str) -> Option<String> {
    for token in line.split_whitespace() {
        let t = token.trim_matches(|c: char| matches!(c, '"' | '\'' | '(' | ')' | '<' | '>' | ',' | ';' | '.'));
        if !t.starts_with("https://") {
            continue;
        }
        if let Ok(u) = url::Url::parse(t) {
            let host_ok = u.host_str().map(|h| h == domain || h.ends_with(&format!(".{domain}"))).unwrap_or(false);
            let safe = u.username().is_empty()
                && u.password().is_none()
                && u.port_or_known_default() == Some(443);
            if host_ok && safe {
                return Some(t.to_string());
            }
        }
    }
    None
}

/// 启动扫码/浏览器授权。per-id 单飞；旧会话先取消，会话带代际号防串码。
pub fn start_auth(id: &str) -> AuthState {
    let Some(entry) = crate::mcp::registry::detail(id) else {
        return AuthState { state: "failed".into(), error: Some("连接器不存在或已下架".into()), ..Default::default() };
    };
    let Some(spec) = CliSpec::from_entry(&entry) else {
        return AuthState { state: "failed".into(), error: Some("条目缺少 cli_spec".into()), ..Default::default() };
    };
    if !is_installed(&spec) {
        return AuthState { state: "failed".into(), error: Some("连接器尚未安装".into()), ..Default::default() };
    }
    cancel_auth(id);
    let gen = AUTH_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let cancel = Arc::new(AtomicBool::new(false));
    let (cancel_tx, cancel_rx) = watch::channel(false);
    {
        let mut g = auths().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        g.insert(id.to_string(), AuthSession {
            state: AuthState { state: "pending".into(), ..Default::default() },
            gen,
            cancel: cancel.clone(),
            cancel_tx,
            child_pid: None,
        });
    }
    let id_owned = id.to_string();
    tokio::spawn(async move {
        let result = run_auth(&id_owned, gen, &spec, cancel, cancel_rx).await;
        match result {
            Ok(()) => set_auth(&id_owned, gen, AuthState { state: "granted".into(), ..Default::default() }),
            Err(e) => {
                let cur = auth_state(&id_owned);
                if cur.state != "expired" {
                    set_auth(&id_owned, gen, AuthState { state: "failed".into(), error: Some(e), ..Default::default() });
                }
            }
        }
    });
    auth_state(id)
}

async fn run_auth(
    id: &str,
    gen: u64,
    spec: &CliSpec,
    cancel: Arc<AtomicBool>,
    mut cancel_rx: watch::Receiver<bool>,
) -> Result<(), String> {
    let steps = spec.steps();
    if steps.is_empty() {
        return Err("条目未声明授权命令".into());
    }
    let (node, bin) = resolve_bin(spec).ok_or("无法解析 CLI 可执行路径")?;
    // 二维码临时文件带代际，避免旧会话读到新会话的码（或反之）。
    let qr_path = crate::runtime::node::binaries_dir().join(".cache")
        .join(format!("cli-qr-{}-{}.png", std::process::id(), gen));

    for (idx, step) in steps.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err("已取消".into());
        }
        // skipIf：成功即跳过本步（飞书 config 已存在时不重复初始化）。
        // 带超时且受取消保护，避免取消后子进程仍长期存活。
        if let Some(skip_argv) = &step.skip_if {
            let mut sc = Command::new(&node);
            if spec.runtime.as_deref() != Some("native") { sc.arg(&bin); }
            sc.args(skip_argv);
            no_window(&mut sc);
            if let Ok(Ok(out)) = tokio::time::timeout(std::time::Duration::from_secs(30), sc.output())
                .await
            {
                if out.status.success() {
                    continue;
                }
            }
            if cancel.load(Ordering::SeqCst) { return Err("已取消".into()); }
        }
        let mut cmd = Command::new(&node);
        if spec.runtime.as_deref() != Some("native") { cmd.arg(&bin); }
        for a in &step.argv {
            if a == "{qr}" {
                cmd.arg(&qr_path);
            } else {
                cmd.arg(a);
            }
        }
        // stderr 必须排空：厂商 CLI 写满管道即阻塞、stdout 停产，旧实现
        // piped 却不读，会挂到 600s deadline。丢弃内容（不写日志，防凭据泄露）。
        cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
        cmd.kill_on_drop(true);
        no_window(&mut cmd);
        let mut child = cmd.spawn().map_err(|e| format!("启动授权命令失败: {e}"))?;
        if let Some(pid) = child.id() { register_child(id, gen, pid); }
        // spawn 后二次检查：取消恰好发生在 spawn 前也不能留下活进程。
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill().await;
            return Err("已取消".into());
        }
        let stdout = child.stdout.take().ok_or("无法读取授权输出")?;
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut r = BufReader::new(stderr);
                let mut sink = [0u8; 4096];
                loop {
                    match r.read(&mut sink).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => continue, // 丢弃，绝不离日志
                    }
                }
            });
        }
        let mut lines = BufReader::new(stdout).lines();
        let mut found_url = false;
        let mut found_qr = false;
        // 读输出直到进程退出或超时（10 分钟）；URL/QR 一旦出现即更新会话。
        // 取消用 watch 即时唤醒，不再等下一行/600s deadline。
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(600);
        loop {
            if cancel.load(Ordering::SeqCst) {
                let _ = child.kill().await;
                return Err("已取消".into());
            }
            let line = tokio::select! {
                _ = cancel_rx.changed() => {
                    let _ = child.kill().await;
                    return Err("已取消".into());
                }
                r = tokio::time::timeout_at(deadline, lines.next_line()) => r,
            };
            match line {
                Ok(Ok(Some(l))) => {
                    if !found_url {
                        if let Some(u) = extract_auth_url(&l, &step.url_domain) {
                            found_url = true;
                            set_auth(id, gen, AuthState { state: "pending".into(), authorization_url: Some(u), ..Default::default() });
                        }
                    }
                    if step.qr_png_arg.is_some() && !found_qr && qr_path.is_file() {
                        if let Ok(bytes) = std::fs::read(&qr_path) {
                            if !bytes.is_empty() {
                                use base64::Engine;
                                let data_url = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes));
                                found_qr = true;
                                let cur = auth_state(id);
                                set_auth(id, gen, AuthState { state: "pending".into(), qr_png: Some(data_url), authorization_url: cur.authorization_url, error: None });
                            }
                        }
                    }
                }
                Ok(Ok(None)) => break, // stdout 关闭
                Ok(Err(e)) => return Err(format!("读取授权输出失败: {e}")),
                Err(_) => {
                    let _ = child.kill().await;
                    set_auth(id, gen, AuthState { state: "expired".into(), error: Some("授权超时，请重试".into()), ..Default::default() });
                    return Err("授权超时".into());
                }
            }
        }
        let status = child.wait().await.map_err(|e| format!("等待授权进程失败: {e}"))?;
        let _ = std::fs::remove_file(&qr_path);
        // 多步：非最后一步退出即推进（waiting_url 让前端换码）；最后一步以 status 复核。
        if idx + 1 < steps.len() {
            if !status.success() {
                // 飞书第二步 exit 3 = 已授权（WB cli.json 同款语义）；其余失败报错。
                if status.code() != Some(3) {
                    return Err(format!("授权第 {} 步失败（exit {:?}）", idx + 1, status.code()));
                }
            }
            set_auth(id, gen, AuthState { state: "waiting_url".into(), ..Default::default() });
            continue;
        }
        if !status.success() && status.code() != Some(3) {
            return Err(format!("授权失败（exit {:?}）", status.code()));
        }
    }
    // 最终复核：status 命令必须报已授权（防 CLI 假成功）。
    verify_authorized(spec).await
}

/// status 命令复核（matchJson 全键相等 / matchRegex 命中）。
pub async fn verify_authorized(spec: &CliSpec) -> Result<(), String> {
    let authorized = query_authorized(spec).await?;
    if authorized { Ok(()) } else { Err("授权未完成（CLI 状态仍为未登录）".into()) }
}

/// 查询授权态（不抛错版：命令失败/非零退出=未授权）。
///
/// 非零退出必须判未授权：部分厂商 CLI 未登录时把「请先登录」提示打印到
/// stdout 并以非零码退出，只看 stdout 正则会把提示文本误判成「已连接」。
pub async fn query_authorized(spec: &CliSpec) -> Result<bool, String> {
    let (node, bin) = resolve_bin(spec).ok_or("无法解析 CLI 可执行路径")?;
    let mut cmd = Command::new(&node);
    if spec.runtime.as_deref() != Some("native") { cmd.arg(&bin); }
    cmd.args(&spec.status.argv);
    no_window(&mut cmd);
    let out = tokio::time::timeout(std::time::Duration::from_secs(30), cmd.output())
        .await
        .map_err(|_| "状态查询超时".to_string())?
        .map_err(|e| format!("状态查询失败: {e}"))?;
    if !out.status.success() {
        return Ok(false);
    }
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    Ok(status_matches(&text, &spec.status))
}

/// 状态输出匹配（纯函数，可单测）。
/// `matchJson` 的键支持点路径（如 `credential.valid`）取嵌套字段；
/// 全键相等才算命中，JSON 解析失败不回落正则（防误判）。
pub fn status_matches(text: &str, st: &CliStatusCmd) -> bool {
    if !st.match_json.is_empty() {
        if let Ok(v) = serde_json::from_str::<Value>(text.trim()) {
            let all = st.match_json.iter().all(|(k, want)| {
                let got = k.split('.').try_fold(&v, |cur, seg| cur.get(seg));
                got.map(|g| g.as_str().map(|s| s == want).unwrap_or_else(|| g.to_string().trim_matches('"') == *want)).unwrap_or(false)
            });
            if all { return true; }
        }
        // JSON 解析失败时不回落正则（防误判）——除非显式给了 matchRegex。
        if st.match_regex.is_none() {
            return false;
        }
    }
    if let Some(re) = &st.match_regex {
        if let Ok(rx) = regex::Regex::new(re) {
            return rx.is_match(text);
        }
    }
    false
}

/// 取消授权会话（杀子进程 + 置 failed）。同代会话内的后台写会被 set_auth 拦截；
/// watch 通知让等待 stdout 的循环立即唤醒并 kill，不再等 600s deadline。
pub fn cancel_auth(id: &str) {
    let pid = {
        let mut g = auths().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        match g.get_mut(id) {
            Some(s) => {
                s.cancel.store(true, Ordering::SeqCst);
                let _ = s.cancel_tx.send(true);
                s.state = AuthState { state: "failed".into(), error: Some("已取消".into()), ..Default::default() };
                s.child_pid.take()
            }
            None => return,
        }
    };
    if let Some(pid) = pid {
        kill_pid(pid);
    }
}

#[cfg(windows)]
fn kill_pid(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(0x0800_0000)
        .output();
}
#[cfg(not(windows))]
fn kill_pid(pid: u32) {
    let _ = std::process::Command::new("kill").args(["-9", &pid.to_string()]).output();
}

// ─── 综合状态 / 卸载 ─────────────────────────────────────────────────────────

/// 卡片/详情用综合状态。
/// `nodeReady` 用只读探测（不能用进程内 `status()`：重启后初始 absent 会
/// 让所有已装连接器显示「Node 未就绪」，与实际可用状态不符）。
pub async fn cli_state(id: &str) -> Value {
    let entry = crate::mcp::registry::detail(id);
    let spec = entry.as_ref().and_then(CliSpec::from_entry);
    let node_ready = crate::runtime::node::locate().is_some();
    let installed = spec.as_ref().map(is_installed).unwrap_or(false);
    let authorized = if installed {
        match spec.as_ref() {
            Some(s) => query_authorized(s).await.unwrap_or(false),
            None => false,
        }
    } else { false };
    json!({ "installed": installed, "authorized": authorized, "nodeReady": node_ready })
}

/// 卸载：登出 + 移除技能目录。npm 包缓存保留（下次安装秒装）。
/// 返回 structured Value：登出失败/超时必须如实回报 loggedOut=false，
/// 不能像旧实现那样吞掉错误仍报「已卸载」——否则厂商 CLI 本地凭据还在，
/// 用户以为断开其实没断（P1 假成功）。
pub async fn uninstall(id: &str) -> Result<Value, String> {
    let entry = crate::mcp::registry::detail(id).ok_or("连接器不存在或已下架")?;
    let spec = CliSpec::from_entry(&entry).ok_or("条目缺少 cli_spec")?;
    let mut logged_out = true;
    let mut warning: Option<String> = None;
    if let Some(un) = &spec.unauth {
        if !un.argv.is_empty() {
            let result = match resolve_bin(&spec) {
                None => Err("无法解析 CLI 可执行路径".to_string()),
                Some((node, bin)) => {
                    let mut cmd = Command::new(&node);
                    if spec.runtime.as_deref() != Some("native") { cmd.arg(&bin); }
                    cmd.args(&un.argv);
                    no_window(&mut cmd);
                    match tokio::time::timeout(std::time::Duration::from_secs(30), cmd.output()).await {
                        Err(_) => Err("登出命令超时".to_string()),
                        Ok(Err(e)) => Err(format!("登出命令启动失败: {e}")),
                        Ok(Ok(out)) if !out.status.success() =>
                            Err(format!("登出命令失败（exit {:?}）", out.status.code())),
                        Ok(Ok(_)) => Ok(()),
                    }
                }
            };
            if let Err(e) = result {
                logged_out = false;
                warning = Some(format!("技能已移除，但未能完成厂商侧登出：{e}。凭据可能仍在本机 CLI 配置中。"));
            }
        }
    }
    if let Some(skills) = entry.get("skills").and_then(Value::as_array) {
        for s in skills {
            if let Some(dir) = s.get("dir").and_then(Value::as_str) {
                let norm = dir.replace('\\', "/");
                if norm.split('/').any(|seg| seg == ".." || seg.is_empty()) || norm.starts_with('/') || norm.contains(':') { continue; }
                let leaf = norm.rsplit('/').next().unwrap_or("");
                if leaf.is_empty() { continue; }
                let _ = std::fs::remove_dir_all(skills_dir().join(leaf));
            }
        }
    }
    crate::skills::invalidate_cache();
    let mut out = json!({ "uninstalled": true, "loggedOut": logged_out });
    if let Some(w) = warning { out["warning"] = Value::String(w); }
    Ok(out)
}

// ─── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn spec_json() -> Value {
        json!({
            "package": "dingtalk-workspace-cli", "version": "1.0.68",
            "binPath": "bin/dws.js",
            "npmEnv": {"DWS_NO_SKILLS": "1"},
            "auth": {"argv": ["auth","login","-y","--no-browser"], "urlDomain": "login.dingtalk.com", "waitForExit": true},
            "status": {"argv": ["auth","status"], "matchJson": {"authenticated": "true"}},
            "unauth": {"argv": ["auth","reset"]}
        })
    }

    #[test]
    fn cli_spec_parses_camel_case() {
        let s: CliSpec = serde_json::from_value(spec_json()).unwrap();
        assert_eq!(s.package, "dingtalk-workspace-cli");
        assert_eq!(s.bin_path, "bin/dws.js");
        assert_eq!(s.steps().len(), 1);
        assert_eq!(s.npm_env.get("DWS_NO_SKILLS").map(String::as_str), Some("1"));
    }

    #[test]
    fn auth_steps_win_over_single_auth() {
        let mut v = spec_json();
        v["authSteps"] = json!([
            {"argv": ["config","init"], "urlDomain": "open.feishu.cn"},
            {"argv": ["auth","login"], "urlDomain": "accounts.feishu.cn"}
        ]);
        let s: CliSpec = serde_json::from_value(v).unwrap();
        assert_eq!(s.steps().len(), 2);
        assert_eq!(s.steps()[1].url_domain, "accounts.feishu.cn");
    }

    #[test]
    fn url_extraction_requires_https_and_domain_whitelist() {
        let line = "请手动访问: https://login.dingtalk.com/oauth2/auth?caller=dws&client_id=x";
        assert_eq!(extract_auth_url(line, "login.dingtalk.com").as_deref(),
            Some("https://login.dingtalk.com/oauth2/auth?caller=dws&client_id=x"));
        // 子域允许
        assert!(extract_auth_url("open https://a.login.dingtalk.com/x", "login.dingtalk.com").is_some());
        // 域外拒绝（防 CLI 输出里的钓鱼/跟踪链接被当成授权 URL）
        assert!(extract_auth_url("https://evil.com/login.dingtalk.com", "login.dingtalk.com").is_none());
        assert!(extract_auth_url("https://login.dingtalk.com.evil.com/x", "login.dingtalk.com").is_none());
        // http 拒绝
        assert!(extract_auth_url("http://login.dingtalk.com/x", "login.dingtalk.com").is_none());
        // 无关行
        assert!(extract_auth_url("等待授权中...", "login.dingtalk.com").is_none());
        // userinfo / 非标端口 / 行尾标点
        assert!(extract_auth_url("https://evil@login.dingtalk.com/x", "login.dingtalk.com").is_none());
        assert!(extract_auth_url("https://login.dingtalk.com:8443/x", "login.dingtalk.com").is_none());
        // 行尾逗号必须被去掉而不是拼进 URL
        assert_eq!(extract_auth_url("open https://login.dingtalk.com/x,", "login.dingtalk.com").as_deref(),
            Some("https://login.dingtalk.com/x"));
    }

    /// P0 回归：skipIf 兼容新数组形态与首版对象形态（旧磁盘缓存不能让飞书再挂）。
    #[test]
    fn skip_if_accepts_both_shapes() {
        let arr = json!({"package":"p","version":"1","binPath":"b.js",
            "auth":{"argv":["a"],"urlDomain":"x.com","skipIf":["config","show"]},
            "status":{"argv":["s"]}});
        let obj = json!({"package":"p","version":"1","binPath":"b.js",
            "auth":{"argv":["a"],"urlDomain":"x.com","skipIf":{"argv":["config","show"]}},
            "status":{"argv":["s"]}});
        let want = Some(vec!["config".to_string(), "show".to_string()]);
        assert_eq!(serde_json::from_value::<CliSpec>(arr).unwrap().steps()[0].skip_if, want);
        assert_eq!(serde_json::from_value::<CliSpec>(obj).unwrap().steps()[0].skip_if, want);
    }

    #[test]
    fn status_match_json_exact() {
        let st = CliStatusCmd { argv: vec![], match_json: [("authenticated".into(), "true".into())].into_iter().collect(), match_regex: None };
        assert!(status_matches(r#"{"authenticated": true, "message": "ok"}"#, &st));
        assert!(!status_matches(r#"{"authenticated": false}"#, &st));
        assert!(!status_matches("not json", &st));
        // 布尔 true 与字符串 "true" 都算命中（CLI 输出形态不一）
        assert!(status_matches(r#"{"authenticated": "true"}"#, &st));
    }

    /// P0 回归（gaoding）：包装器打印的 `GD_AUTHENTICATED` 不是 CLI 原生输出。
    /// 直跑 `gd-cli auth status --json` 得到嵌套 JSON，必须支持点路径匹配；
    /// 且旧的整段锚定正则对真实 JSON 输出永不命中。
    #[test]
    fn status_match_json_supports_nested_dot_path() {
        let st = CliStatusCmd {
            argv: vec!["auth".into(), "status".into(), "--json".into()],
            match_json: [("logged_in".into(), "true".into()), ("credential.valid".into(), "true".into())].into_iter().collect(),
            match_regex: None,
        };
        assert!(status_matches(r#"{"logged_in":true,"credential":{"valid":true}}"#, &st));
        assert!(!status_matches(r#"{"logged_in":true,"credential":{"valid":false}}"#, &st), "credential 失效不得算已授权");
        assert!(!status_matches(r#"{"logged_in":false}"#, &st));
        let old = CliStatusCmd {
            argv: vec![], match_json: HashMap::new(),
            match_regex: Some(r"^GD_AUTHENTICATED(?:\r?\n)?$".into()),
        };
        assert!(!status_matches(r#"{"logged_in":true,"credential":{"valid":true}}"#, &old),
            "旧版照搬包装器标记串正则会判未授权（P0 缺陷复现）");
    }

    #[test]
    fn status_match_regex_wecom() {
        let st = CliStatusCmd { argv: vec![], match_json: HashMap::new(), match_regex: Some(r"\bauthorized\b".into()) };
        assert!(status_matches("Status: authorized", &st));
        assert!(!status_matches("Status: unauthorized", &st));
    }

    #[test]
    fn status_json_failure_does_not_fall_through_silently() {
        // 只有 matchJson 时，非 JSON 输出必须判未授权（防误报已连接）。
        let st = CliStatusCmd { argv: vec![], match_json: [("identity".into(), "user".into())].into_iter().collect(), match_regex: None };
        assert!(!status_matches("garbage output", &st));
    }

    #[test]
    fn qr_placeholder_is_recognized() {
        let step = CliAuthStep { argv: vec!["auth".into(), "init".into(), "{qr}".into()], url_domain: "work.weixin.qq.com".into(), wait_for_exit: true, qr_png_arg: Some("--output-qrcode".into()), skip_if: None };
        assert!(step.argv.iter().any(|a| a == "{qr}"));
    }

    #[test]
    fn spec_from_entry_requires_cli_spec() {
        assert!(CliSpec::from_entry(&json!({"id": "official:x"})).is_none());
        let e = json!({"id": "official:dingtalk", "cli_spec": spec_json()});
        assert!(CliSpec::from_entry(&e).is_some());
    }

    /// 技能目录契约：dir = zip 内相对路径（"skills/<name>"），落盘取末段。
    /// 穿越/绝对路径/盘符一律拒绝；合法多层前缀放行。
    #[test]
    fn skill_dir_normalization_and_traversal_guard() {
        let norm = |d: &str| -> Result<String, ()> {
            let n = d.replace('\\', "/");
            if n.split('/').any(|s| s == ".." || s.is_empty()) || n.starts_with('/') || n.contains(':') {
                return Err(());
            }
            Ok(n.rsplit('/').next().unwrap_or("").to_string())
        };
        assert_eq!(norm("skills/wecomcli-calendar").unwrap(), "wecomcli-calendar");
        assert_eq!(norm("dws").unwrap(), "dws");
        assert!(norm("skills/../../evil").is_err());
        assert!(norm("/etc/passwd").is_err());
        assert!(norm("C:\\evil").is_err());
        assert!(norm("skills//x").is_err());
        assert!(norm("skills\\..\\evil").is_err());
    }

    /// P0 回归：内置快照里全部 CLI 条目的 cli_spec 必须能被 Rust CliSpec 解析。
    /// 飞书曾因 skipIf 写成对象 {argv:[...]} 与 Option<Vec<String>> 不匹配，
    /// 导致 serde 整体解析失败 → 连接器 100% 不可用（E2E 只测企微未暴露）。
    /// 2026-11 目录扩到 28 条（4 已实测 + 24 公开可连候选），不再硬编码 4。
    #[test]
    fn builtin_cli_specs_all_parse() {
        let raw = include_str!("registry.json");
        let v: Value = serde_json::from_str(raw).unwrap();
        let cli: Vec<&Value> = v["entries"].as_array().unwrap().iter()
            .filter(|e| e.get("kind").and_then(Value::as_str) == Some("cli")).collect();
        assert!(cli.len() >= 28, "内置快照必须含 28 条 cli（实得 {}）", cli.len());
        for e in &cli {
            let id = e["id"].as_str().unwrap();
            assert!(CliSpec::from_entry(e).is_some(), "内置 cli_spec 必须可解析: {id}");
        }
        let feishu = cli.iter().find(|e| e["id"] == "official:feishu").unwrap();
        let spec = CliSpec::from_entry(feishu).unwrap();
        assert_eq!(spec.steps().len(), 2, "飞书两步授权");
        assert_eq!(spec.steps()[0].skip_if, Some(vec!["config".to_string(), "show".to_string()]),
            "第一步 skipIf 必须是字符串数组（不是对象形态）");
    }
}