//! backend.rs - gourd-ai-agent JAR 子进程管理（Rust 版，对应 Electron 版 main/backend.js）
//!
//! 职责：
//! 1. find_available_port()  - 在 127.0.0.1 随机分配可用端口
//! 2. find_java()            - 按优先级查找 java 可执行文件（内置 JRE → JAVA_EXEC → JAVA_HOME → PATH → 常见目录）
//! 3. find_jar()             - 定位内置 gourd-ai-agent.jar
//! 4. start_backend(port)    - 启动 Java 子进程（带 JVM 内存优化参数，与 Electron 版一致）
//! 5. wait_for_backend(port) - 轮询 GET /web/chat/meta 等待就绪
//! 6. stop_backend()         - 清理进程树（Windows taskkill /T，Unix 进程组 SIGTERM→SIGKILL）
//! 7. get_server_log_path()  - 日志路径
//! 8. Tauri commands: get_backend_state() / restart_backend()
//!
//! 对外暴露 `backend_ready` watch channel，供 UI 服务器挂起/放行 /web/** 代理请求。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;

use anyhow::{anyhow, Context, Result};
use lazy_static::lazy_static;
use tauri::{AppHandle, Manager, State};
use tokio::process::Command;
use tokio::sync::watch;
use tracing::{error, info, warn};

use crate::paths;
use crate::AppState;

// ─── 全局进程状态 ─────────────────────────────────────────────────────────────

/// 后端就绪状态（与 Electron 版 backendReadyState 一致：pending | ready | failed）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReadyState {
    Pending,
    Ready,
    Failed,
}

impl ReadyState {
    fn as_str(self) -> &'static str {
        match self {
            ReadyState::Pending => "pending",
            ReadyState::Ready => "ready",
            ReadyState::Failed => "failed",
        }
    }
}

struct BackendProcess {
    child: tokio::process::Child,
    pid: u32,
}

struct BackendManager {
    /// 当前存活的后端子进程
    process: Option<BackendProcess>,
    /// 就绪状态机（pending → ready / failed）
    ready_state: ReadyState,
    /// 最近一次启动失败的完整原因（供页面加载完成后重放，否则前端只能看到 'failed' 却无原因）
    last_error: Option<String>,
    /// bootstrap 幂等锁：防止 macOS activate 等场景重复分配端口/重启后端
    bootstrap_started: bool,
    /// 供 UI 服务器判断后端是否就绪的 watch channel。
    ///
    /// 【2026-09-06 修正】生产路径上 UI 服务器订阅的其实是 `AppState.backend_ready`
    /// （见 server.rs::start_ui_server），本 channel 只有单测在订阅。此前
    /// `settle_backend_ready` 只写这里，导致「退出监听/自动重启把状态置 failed」
    /// 对代理毫无影响：代理照旧放行 /web/**，每个请求 502。
    /// 现在两条 channel 由 [`mirror_tx`] 保持同步，任何一处 settle 都会同时广播。
    ready_tx: watch::Sender<bool>,
    /// `AppState.backend_ready` 的镜像发送端（setup 阶段由 [`bind_app_ready_tx`] 注入）。
    /// 为 None 时退化为仅广播内部 channel（单测环境）。
    mirror_tx: Option<watch::Sender<bool>>,
    /// 最近一次健康检查探针结果（状态码/错误码）——旧实现只认 200，
    /// 非 200 一律静默重试到超时，最后只剩一句「启动超时」，完全看不出是
    /// 404（jar 与 UI 跳代）还是连不上（进程已死）。
    last_probe: Option<ProbeInfo>,
    /// 子进程代际：每次成功 spawn 递增。退出监听任务据此判断自己是否已被接管。
    generation: u64,
}

/// 单次健康检查探针结果。
#[derive(Debug, Clone)]
struct ProbeInfo {
    /// HTTP 状态码；0 表示没拿到响应（连接失败/超时）
    status: u16,
    /// 连接失败时的错误描述（状态码为 0 时有值）
    error: String,
}

lazy_static! {
    static ref BACKEND: Mutex<BackendManager> = Mutex::new(BackendManager {
        process: None,
        ready_state: ReadyState::Pending,
        last_error: None,
        bootstrap_started: false,
        last_probe: None,
        generation: 0,
        mirror_tx: None,
        ready_tx: {
            let (tx, _rx) = watch::channel(false);
            tx
        },
    });
}

/// 自动重启退避表（毫秒），与 Electron 版 index.js 的 AUTO_RESTART_DELAYS 一致。
const AUTO_RESTART_DELAYS_MS: [u64; 5] = [1000, 3000, 10000, 30000, 60000];
/// 当前退避进度（成功就绪后清零）
static AUTO_RESTART_ATTEMPT: AtomicUsize = AtomicUsize::new(0);
/// 重启串行锁：并发 restart（自动 + 手动）只允许一个在跑
static RESTARTING: AtomicBool = AtomicBool::new(false);
/// 失败纪元：每次 settle(false) 自增 1。自动重启任务在排期时捕获当前纪元，
/// 醒来后发现纪元已变（说明有新失败接管了重试链）或状态已不再是 Failed
/// （手动重试/另一次重启已把后端救活或正在救），就放弃本次重启，
/// 避免把用户刚重试成功的健康后端再杀一次。
static FAILURE_EPOCH: AtomicU64 = AtomicU64::new(0);

/// 订阅后端就绪状态（UI 服务器在代理 /web/** 前 `wait_for(true)`）。
pub fn backend_ready_rx() -> watch::Receiver<bool> {
    BACKEND.lock().unwrap().ready_tx.subscribe()
}

/// 绑定 `AppState.backend_ready` 作为镜像广播端（`main.rs` setup 阶段调用一次）。
///
/// 没有它，[`settle_backend_ready`] 的广播就到不了真正决定代理放行的那条 channel，
/// 「后端挂了→代理应当拦截」这条链路会整条失效（表现为接口 502 而非 503）。
pub fn bind_app_ready_tx(tx: watch::Sender<bool>) {
    BACKEND.lock().unwrap().mirror_tx = Some(tx);
}

/// 记下最近一次探针结果。
fn note_probe(status: u16, error: &str) {
    let mut mgr = BACKEND.lock().unwrap();
    mgr.last_probe = Some(ProbeInfo { status, error: error.to_string() });
}

/// 后端子进程是否存活（无进程或已退出都算不存活）。
fn is_backend_alive() -> bool {
    let mut mgr = BACKEND.lock().unwrap();
    match mgr.process.as_mut() {
        Some(p) => !matches!(p.child.try_wait(), Ok(Some(_))),
        None => false,
    }
}

/// 页面加载完成后主动补推一次后端状态。
///
/// 为何必需：`ipc_bridge::emit` 走 `webview.eval`，而注入脚本里的守卫是
/// `if (window.__GOURD_BRIDGE_EMIT__)`。若后端在**启动瞬间就失败**（如 find_java
/// 全链路落空，几乎零耗时），emit 发生在文档开始导航之前：`eval` 本身不会报错，
/// 但语句因 `__GOURD_BRIDGE_EMIT__` 尚未存在而被静默丢弃 —— Rust 侧无法感知这次丢失，
/// 桥接层的 last-payload 重放也帮不上（缓存发生在 JS 侧）。
/// 以前这个洞被 65s 兜底超时 + 全屏遮罩掩盖；遮罩按用户要求移除后，必须把
/// 事件补齐，否则错误原因只能去日志里找。
pub fn push_state_to_window(app: &AppHandle) {
    let (state, port, err) = {
        let mgr = BACKEND.lock().unwrap();
        (
            mgr.ready_state,
            app.state::<AppState>()
                .backend_port
                .lock()
                .map(|p| *p)
                .unwrap_or(0),
            mgr.last_error.clone(),
        )
    };
    match state {
        ReadyState::Ready => {
            crate::ipc_bridge::emit(app, "backend-ready", &serde_json::json!({ "port": port }));
        }
        ReadyState::Failed => {
            crate::ipc_bridge::emit(
                app,
                "backend-failed",
                &serde_json::json!({ "message": err.unwrap_or_else(|| "后端启动失败".to_string()) }),
            );
        }
        // pending：尚无需补推，就绪/失败时会由 bootstrap 正常发出
        ReadyState::Pending => {}
    }
}

/// 置就绪状态并广播。
///
/// 【2026-09-06 修正】旧实现开头是 `if mgr.ready_state != Pending { return; }`
/// —— 单向闩锁：一旦引导失败就永久锁在 Failed，UI 服务器对每个 /web/** 固定
/// 回 503「启动中」，即使后来后端已恢复也不放行；叠加 `bootstrap_started`
/// 幂等锁使重探无从发起，表现为「覆盖安装后接口永远不通」。
/// 现在状态可双向迁移；幂等由 `bootstrap_started` 与 [`RESTARTING`] 串行锁保障。
///
/// 原因与状态在同一次加锁内写入：不存在“看到 Failed 却拿不到原因”的窗口
/// （旧实现靠调用点先 remember_error 后 settle 的“顺序敏感”勉强兼顾，很脆）。
fn settle_backend_ready(ok: bool, reason: Option<&str>) {
    let mut mgr = BACKEND.lock().unwrap();
    let prev = mgr.ready_state;
    mgr.ready_state = if ok { ReadyState::Ready } else { ReadyState::Failed };
    if ok {
        mgr.last_error = None;
    } else {
        if let Some(r) = reason {
            mgr.last_error = Some(r.to_string());
        }
        // 失败纪元自增：在途的自动重启任务据此判断自己触发的失败是否已被新失败取代
        FAILURE_EPOCH.fetch_add(1, Ordering::SeqCst);
    }
    let _ = mgr.ready_tx.send(ok);
    // 同步 AppState.backend_ready —— UI 服务器实际据此决定是否放行 /web/** 代理。
    // 漏掉它等于「状态机自己知道失败了，但代理不知道」。
    if let Some(mirror) = mgr.mirror_tx.as_ref() {
        let _ = mirror.send(ok);
    }
    info!(
        "后端状态迁移: {} -> {}{}",
        prev.as_str(),
        mgr.ready_state.as_str(),
        if ok { String::new() } else { format!(": {}", reason.unwrap_or("未携带原因")) }
    );
}

// ─── 资源与路径 ───────────────────────────────────────────────────────────────
//
// extraResources 的路径解析**不在本文件**：统一由 crate::paths::resources_dir() 负责。
// 本文件曾持有一份独立实现，且候选优先级与 cli_provision.rs 相反、判据仅为
// 「目录存在」，直接导致 2026-09-04 安装版后端不启动（详见 paths.rs 顶部说明）。
// 任何新增的资源路径需求都应扩展 paths.rs，禁止在此重新拼接。

/// 服务端日志路径：<gwork.home>/.gwork/logs/gourd-ai-server.log
pub fn get_server_log_path() -> PathBuf {
    paths::runtime_home_dir()
        .join(".gwork")
        .join("logs")
        .join("gourd-ai-server.log")
}

// ─── Java 查找 ────────────────────────────────────────────────────────────────

/// 验证 java 可执行文件能否在当前机器运行（macOS 架构不匹配时 exec 会 EBADEXEC）。
fn can_execute_java(java_path: &Path) -> bool {
    let mut cmd = std::process::Command::new(java_path);
    cmd.arg("-version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

/// 定位 Java 可执行文件。查找顺序与 Electron 版完全一致：
/// 1. 内置 JRE（extraResources/jre/bin/javaw.exe，由 paths 以「java 实存」为判据选定目录）
/// 2. JAVA_EXEC 环境变量（直接指定路径）
/// 3. JAVA_HOME/bin/java
/// 4. 系统 PATH
/// 5. 常见回退位置（~/.jdks、系统 JDK 安装目录）
///
/// 全部落空时返回 None，并把**每一个探测过的位置**写进日志 —— 2026-09-04 的故障
/// 排查之所以耗时，正是因为失败时只留了一句「内置 JRE 不可用」，无法判断是路径
/// 解析选错了目录、还是 jre 真的没打进去。
fn find_java() -> Option<PathBuf> {
    // Windows 用 javaw.exe（无控制台窗口），其他平台用 java；javaw 缺失时回退 java.exe
    let java_name: &str = if cfg!(windows) { "javaw.exe" } else { "java" };
    let java_console: &str = if cfg!(windows) { "java.exe" } else { "java" };

    let java_in_home = |home: &Path| -> Option<PathBuf> {
        let a = home.join("bin").join(java_name);
        if a.exists() {
            return Some(a);
        }
        let b = home.join("bin").join(java_console);
        if b.exists() {
            return Some(b);
        }
        None
    };

    // 探测痕迹：失败时一次性输出，避免「只报一个路径」把排查引向错误方向
    let mut tried: Vec<String> = Vec::new();

    // 1. 内置 JRE（打包首选）。目录由 paths 统一选定（判据 = java 可执行文件实存），
    //    带完整 JRE 的候选永远优先于「只有 jar」的历史残留目录。
    let bundled = paths::bundled_java_exe(true);
    if let Some(ref path) = bundled {
        tried.push(format!("内置 JRE: {} [命中]", path.display()));
        // macOS 双架构包 vs 单架构 jlink 产物：先验证可执行性，架构不符回退系统 Java
        if !cfg!(target_os = "macos") || can_execute_java(path) {
            return Some(path.clone());
        }
        warn!("内置 JRE 无法在当前机器运行（架构不匹配？），回退系统 Java…");
    } else {
        tried.push(format!(
            "内置 JRE: {} [缺 bin/{}]",
            paths::resources_dir().join("jre").join("bin").display(),
            java_name
        ));
        warn!("内置 JRE 不可用（缺 bin/java），尝试系统 Java…");
    }

    // 2. JAVA_EXEC 环境变量
    match std::env::var("JAVA_EXEC") {
        Ok(exec) if !exec.is_empty() => {
            let p = PathBuf::from(&exec);
            if p.exists() {
                return Some(p);
            }
            tried.push(format!("JAVA_EXEC: {} [路径不存在]", exec));
        }
        _ => tried.push("JAVA_EXEC: [未设置]".to_string()),
    }

    // 3. JAVA_HOME/bin/java
    match std::env::var("JAVA_HOME") {
        Ok(home) if !home.is_empty() => {
            if let Some(p) = java_in_home(Path::new(&home)) {
                return Some(p);
            }
            tried.push(format!("JAVA_HOME: {} [缺 bin/java]", home));
        }
        _ => tried.push("JAVA_HOME: [未设置]".to_string()),
    }

    // 4. 系统 PATH 搜索
    let mut path_hits = 0usize;
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(java_name);
            if candidate.exists() {
                return Some(candidate);
            }
            let candidate2 = dir.join(java_console);
            if candidate2.exists() {
                return Some(candidate2);
            }
            path_hits += 1;
        }
    }
    tried.push(format!("系统 PATH: 扫描 {} 个目录，未见 {}", path_hits, java_name));

    // 5. 常见回退位置（含 IntelliJ 下载的 JDK/JBR）
    let mut search_roots: Vec<PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        search_roots.push(home.join(".jdks")); // IntelliJ
    }
    #[cfg(target_os = "windows")]
    {
        search_roots.push(PathBuf::from(r"C:\Program Files\Eclipse Adoptium"));
        search_roots.push(PathBuf::from(r"C:\Program Files\Java"));
        search_roots.push(PathBuf::from(r"C:\Program Files\Microsoft"));
        search_roots.push(PathBuf::from(r"C:\Program Files\Zulu"));
        search_roots.push(PathBuf::from(r"C:\Program Files\Amazon Corretto"));
    }
    #[cfg(target_os = "macos")]
    {
        search_roots.push(PathBuf::from("/Library/Java/JavaVirtualMachines"));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        search_roots.push(PathBuf::from("/usr/lib/jvm"));
    }

    for root in &search_roots {
        if !root.exists() {
            tried.push(format!("回退目录: {} [不存在]", root.display()));
            continue;
        }
        let mut entries: Vec<PathBuf> = match std::fs::read_dir(root) {
            Ok(rd) => rd.filter_map(|e| e.ok().map(|e| e.path())).collect(),
            Err(e) => {
                tried.push(format!("回退目录: {} [读取失败 {}]", root.display(), e));
                continue;
            }
        };
        // 高版本优先（按名称倒序）
        entries.sort();
        entries.reverse();
        for home in &entries {
            // macOS 的 .jdk 常见结构：<home>/Contents/Home/bin/java
            let found = java_in_home(home)
                .or_else(|| java_in_home(&home.join("Contents").join("Home")));
            if let Some(path) = found {
                info!("使用系统 Java: {}", path.display());
                return Some(path);
            }
        }
        tried.push(format!(
            "回退目录: {} [{} 个子项均无 bin/java]",
            root.display(),
            entries.len()
        ));
    }

    // 全链路落空：把探测痕迹与 extraResources 候选报告一并写进日志。
    // 这是安装版「后端静默不启动」唯一的自证入口，务必详尽。
    warn!(
        "未找到任何可用 Java 运行时。探测明细：\n{}\nextraResources 解析报告：\n{}",
        tried.join("\n"),
        paths::resources_dir_diagnostics()
    );
    None
}

/// 定位内置 gourd-ai-agent.jar（目录由 paths 统一解析）
fn find_jar() -> Option<PathBuf> {
    let jar = paths::resources_dir().join("gourd-ai-agent.jar");
    if jar.exists() {
        Some(jar)
    } else {
        None
    }
}

// ─── 端口分配 ─────────────────────────────────────────────────────────────────

/// 在 127.0.0.1 随机分配一个可用端口（绑定 :0 后立即释放）。
async fn find_available_port() -> Result<u16> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .context("分配随机端口失败")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

// ─── 健康检查 ─────────────────────────────────────────────────────────────────

/// 轮询 GET /web/chat/meta 等待后端 HTTP 服务就绪。
/// 单次请求超时 500ms，轮询间隔 300ms，与 Electron 版一致。
///
/// 两处关键修正（均为「覆盖安装后接口不通」查不动的直接原因）：
/// 1. 非 200 不再是静默重试——每次结果都记入 `last_probe`，超时报错携带状态码；
///    404 能直接指向「jar 与 UI 跳代（部分覆盖）」，而不是模糊的“启动超时”。
/// 2. 子进程已退出时立即失败，不再对着死端口白等满 60 秒（期间界面接口固定 503）。
pub async fn wait_for_backend(port: u16, timeout_ms: u64) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(500))
        .build()
        .context("构建健康检查 HTTP 客户端失败")?;
    let url = format!("http://127.0.0.1:{}/web/chat/meta", port);
    let started = std::time::Instant::now();
    let deadline = started + std::time::Duration::from_millis(timeout_ms);
    let mut attempts: u32 = 0;
    let mut last = String::from("未探测");

    loop {
        if !is_backend_alive() {
            return Err(anyhow!(
                "后端进程未存活（启动后已退出）。最后探针结果: {}；详见日志 {}",
                last,
                get_server_log_path().display()
            ));
        }

        attempts += 1;
        match client.get(&url).send().await {
            Ok(resp) => {
                let status = resp.status().as_u16();
                note_probe(status, "");
                last = format!("HTTP {}", status);
                if status == 200 {
                    info!("健康检查通过: {}（轮询 {} 次，耗时 {:?}）", last, attempts, started.elapsed());
                    return Ok(());
                }
            }
            Err(e) => {
                note_probe(0, &format!("{}", e));
                last = format!("连接失败 {}", e);
            }
        }

        if std::time::Instant::now() > deadline {
            return Err(anyhow!(
                "后端启动超时（{} 秒，轮询 {} 次）。最后结果: {}；端口: 127.0.0.1:{}；{}",
                timeout_ms / 1000,
                attempts,
                last,
                port,
                if last.starts_with("HTTP 404") {
                    "【诊断】探针返回 404：jar 与前端 UI 版本不一致，典型原因是覆盖安装时旧 jar 被占用未能替换，请卸载后重装。"
                } else {
                    "详见后端日志"
                }
            ));
        }

        // 每 ~3 秒留一行进度，事后从日志能看出卡在哪个状态码
        if attempts % 10 == 1 {
            info!("等待后端就绪… {}（第 {} 次）", last, attempts);
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
}

// ─── 启动 / 停止 ─────────────────────────────────────────────────────────────

/// 启动 gourd-ai-agent JAR 子进程。若已有存活进程则直接复用其 PID。
async fn start_backend(port: u16) -> Result<u32> {
    // 若已有存活进程，直接复用
    {
        let mut mgr = BACKEND.lock().unwrap();
        if let Some(proc) = mgr.process.as_mut() {
            if proc.child.try_wait().ok().flatten().is_none() {
                return Ok(proc.pid);
            }
            // 已退出的句柄清掉，继续走启动流程
            mgr.process = None;
        }
    }

    // 修正历史嵌套全局区 / 品牌升级旧目录（须在 Java 子进程启动前完成，避免新旧目录并发读写）
    if let Err(e) = crate::migration::migrate_global_data() {
        warn!("全局目录迁移失败（保留 staging，不影响启动）: {}", e);
    }

    // find_java 内部已把逐条探测明细写进日志；这里再把 extraResources 候选报告
    // 附进错误文本，让它能一路透传到前端错误横幅，用户截图即可定位。
    let java = find_java().ok_or_else(|| {
        anyhow!(
            "未找到可用的 Java 运行时（内置 JRE / JAVA_EXEC / JAVA_HOME / 系统 PATH / 常见安装目录全部落空）\n\nextraResources 解析报告：\n{}\n\n请重新运行构建脚本生成内置 JRE，或在系统安装 Java 17+ 并加入 PATH",
            paths::resources_dir_diagnostics()
        )
    })?;
    let jar = find_jar().ok_or_else(|| {
        anyhow!(
            "未找到 gourd-ai-agent.jar\n请先运行构建脚本复制 JAR 文件。\n\nextraResources 解析报告：\n{}",
            paths::resources_dir_diagnostics()
        )
    })?;

    // 文件日志级别：打包版仅输出 ERROR；开发版保持 app.yml 的 DEBUG 默认值；
    // GWORK_LOG_LEVEL 可临时覆盖（-D 系统属性优先级高于 app.yml，Solon 配置覆盖规则）。
    let file_log_level: Option<String> = std::env::var("GWORK_LOG_LEVEL")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            if cfg!(debug_assertions) {
                None
            } else {
                Some("ERROR".to_string())
            }
        });

    // JVM 内存参数与 Electron 版严格一致：SerialGC + FreeRatio，GC 后按比例收缩并归还 OS。
    // 注意：仅设 -Xms/-Xmx 而不配 MinHeapFreeRatio/MaxHeapFreeRatio 是负优化。
    let runtime_home = paths::runtime_home_dir();
    let mut args: Vec<String> = vec![
        "-Xms48m".into(),
        "-Xmx512m".into(),
        "-Xss512k".into(),
        "-XX:+UseSerialGC".into(),
        "-XX:MinHeapFreeRatio=10".into(),
        "-XX:MaxHeapFreeRatio=25".into(),
        "-XX:MaxMetaspaceSize=192m".into(),
        "-XX:CompressedClassSpaceSize=64m".into(),
        "-XX:ReservedCodeCacheSize=96m".into(),
        "-XX:InitialCodeCacheSize=4m".into(),
        "-XX:-UsePerfData".into(),
        "-Dfile.encoding=UTF-8".into(),
        "-Dsolon.boot.openBrowser=false".into(), // 禁止自动打开浏览器
        // 全局配置区根（与 ACP 子进程一致，保证读同一份全局配置）；不含 .gwork 子目录
        format!("-Dgwork.home={}", runtime_home.display()),
    ];
    if let Some(level) = file_log_level {
        args.push(format!("-Dsolon.logging.appender.file.level={}", level));
    }
    if let Ok(endpoint) = std::env::var("GWORK_USAGE_ENDPOINT") {
        if !endpoint.is_empty() {
            args.push(format!("-Dgwork.usage.endpoint={}", endpoint));
        }
    }
    if let Ok(token) = std::env::var("GWORK_USAGE_CLIENT_TOKEN") {
        if !token.is_empty() {
            args.push(format!("-Dgwork.usage.client-token={}", token));
        }
    }
    args.push("-jar".into());
    args.push(jar.to_string_lossy().into_owned());
    args.push("web".into());
    args.push(port.to_string());

    // 日志文件：<基目录>/.gwork/logs/gourd-ai-server.log；确保目录存在（spawn cwd 不存在会 ENOENT）
    let log_path = get_server_log_path();
    std::fs::create_dir_all(&runtime_home).context("创建运行时基目录失败")?;
    if let Some(dir) = log_path.parent() {
        std::fs::create_dir_all(dir).context("创建日志目录失败")?;
    }
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .with_context(|| format!("打开日志文件失败: {}", log_path.display()))?;
    let log_stderr = log_file.try_clone().context("复制日志句柄失败")?;

    // 日志里脱敏 client-token
    let safe_args: Vec<String> = args
        .iter()
        .map(|arg| {
            if let Ok(token) = std::env::var("GWORK_USAGE_CLIENT_TOKEN") {
                if !token.is_empty() && *arg == format!("-Dgwork.usage.client-token={}", token) {
                    return "-Dgwork.usage.client-token=<redacted>".to_string();
                }
            }
            arg.clone()
        })
        .collect();
    info!("启动后端: {} {}", java.display(), safe_args.join(" "));

    // 显式清除可能影响 JVM classloader 的环境变量
    let mut cmd = Command::new(&java);
    cmd.args(&args)
        .current_dir(&runtime_home)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(log_file))
        .stderr(std::process::Stdio::from(log_stderr))
        .env_remove("JAVA_TOOL_OPTIONS")
        .kill_on_drop(false); // 句柄存全局；退出清理由 stop_backend 负责

    // Unix：独立进程组，stop 时对整个进程组发信号（等价 tree-kill）
    #[cfg(unix)]
    {
        #[allow(unused_imports)]
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    // Windows：隐藏控制台窗口（javaw 本身无窗口，双保险）
    #[cfg(target_os = "windows")]
    {
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd
        .spawn()
        .with_context(|| format!("后端进程启动失败 ({})", java.display()))?;
    let pid = child.id().unwrap_or(0);
    info!("后端进程 PID={}", pid);

    {
        let mut mgr = BACKEND.lock().unwrap();
        mgr.process = Some(BackendProcess { child, pid });
        // 代际递增：退出监听任务据此判断自己是否已被新的启动/重启接管
        mgr.generation += 1;
    }

    // spawn 错误（EACCES/EBADEXEC/ENOENT 等）快速失败：300ms 内进程退出视为启动失败，
    // 把真实原因（JRE 架构不符、权限丢失等）直接抛给引导层展示，不等 60 秒健康检查超时。
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    {
        let mut mgr = BACKEND.lock().unwrap();
        if let Some(proc) = mgr.process.as_mut() {
            if let Some(status) = proc.child.try_wait().ok().flatten() {
                let dead_pid = proc.pid;
                mgr.process = None;
                return Err(anyhow!(
                    "后端进程启动后立即退出 (PID={}, {})，详见日志 {}",
                    dead_pid,
                    status,
                    log_path.display()
                ));
            }
        }
    }

    Ok(pid)
}

/// 停止后端进程（清理整个进程树）。等待进程真正退出后再返回，避免重启时资源冲突。
pub async fn stop_backend() {
    let (pid, child) = {
        let mut mgr = BACKEND.lock().unwrap();
        match mgr.process.take() {
            Some(p) => (p.pid, p.child),
            None => return,
        }
    };
    if pid == 0 {
        return;
    }
    info!("停止后端进程 PID={}", pid);
    kill_process_tree(pid);

    // 等待进程真正退出，最多 3 秒
    let mut child = child;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(3), child.wait()).await;
}

/// 按平台清理进程树：
/// - Windows: taskkill /T（杀整棵树）/F
/// - Unix: 进程组 SIGTERM → 3 秒后 SIGKILL（子进程启动时已 setsid 独立成组）
fn kill_process_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // taskkill 同为控制台程序，不加 CREATE_NO_WINDOW 会在退出时闪窗
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(unix)]
    {
        let pgid = pid as i32;
        unsafe {
            // 负 PID = 整个进程组；先 TERM 让 JVM 优雅关闭
            libc::kill(-pgid, libc::SIGTERM);
        }
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(3));
            unsafe {
                libc::kill(-pgid, libc::SIGKILL);
            }
        });
    }
}

// ─── 引导 ────────────────────────────────────────────────────────────────────

/// 引导后端启动。窗口与本地 UI 已先行加载，此处只负责启动 jar 子进程，
/// 并在就绪后置位 backend_ready（UI 服务器据此放行 /web/** 代理请求）。
/// 幂等：重复触发（macOS activate 等）不会重复分配端口/重启后端。
pub async fn bootstrap(app: AppHandle) -> Result<()> {
    {
        let mut mgr = BACKEND.lock().unwrap();
        if mgr.bootstrap_started {
            return Ok(());
        }
        mgr.bootstrap_started = true;
    }

    let result = bootstrap_inner(&app).await;

    match &result {
        Ok(port) => {
            info!("后端就绪，端口 {}", port);
            let state: State<'_, AppState> = app.state::<AppState>();
            if let Ok(mut p) = state.backend_port.lock() {
                *p = *port;
            }
            AUTO_RESTART_ATTEMPT.store(0, Ordering::SeqCst);
            settle_backend_ready(true, None);
            let _ = state.backend_ready.send(true);
            // 通知渲染层放行启动门闸（app-bootstrap.js 的 __whenBackendReady 队列）。
            // 缺失时前端只能等 65s 兜底超时，冷启动体验会严重退化。
            crate::ipc_bridge::emit(&app, "backend-ready", &serde_json::json!({ "port": *port }));
            // 挂上退出监听：后端运行中途挂掉时必须把状态从 ready 拉回 failed，
            // 否则代理仍放行请求→每个接口 502，用户只看到“接口神秘不通”。
            spawn_exit_watcher(app.clone());

            // 安装一致性自检（异步、不拖慢 ready 事件）：把「旧 jar 未被替换」显式化
            let verify_handle = app.clone();
            let verify_port = *port;
            tauri::async_runtime::spawn(async move {
                let v = verify_build_identity(verify_port).await;
                if v.get("ok").and_then(|b| b.as_bool()).unwrap_or(true) {
                    match v.get("skipped").and_then(|s| s.as_str()) {
                        Some(s) => warn!("跳过安装一致性自检: {}", s),
                        None => info!("安装一致性自检通过 buildId={}",
                            v.get("actual").and_then(|s| s.as_str()).unwrap_or("-")),
                    }
                    return;
                }
                error!(
                    "安装一致性告警: 期望 {} / 实际 {} — {}",
                    v.get("expected").and_then(|s| s.as_str()).unwrap_or("-"),
                    v.get("actual").and_then(|s| s.as_str()).unwrap_or("<无 buildId>"),
                    v.get("reason").and_then(|s| s.as_str()).unwrap_or(""),
                );
                crate::ipc_bridge::emit(&verify_handle, "install-mismatch", &v);
            });
        }
        Err(e) => {
            let msg = format!("{:#}", e);
            error!("后端启动失败: {}", msg);
            // 原因与状态在同一次加锁内写入，不存在“看到 Failed 却拿不到原因”的窗口
            settle_backend_ready(false, Some(&msg));
            emit_failed(&app, &msg);
            // 让挂起中的 /web/** 代理请求尽快得到 503（带真实原因），并排期自动重试
            schedule_auto_restart(app.clone(), msg);
        }
    }
    result.map(|_| ())
}

/// 本壳期望的后端构建指纹（编译期由 build.rs::emit_jar_build_id 注入）。
/// 拿不到或为 `unknown` 时返回 None —— 宁可不比对，也不拿占位值去误报用户。
fn expected_build_id() -> Option<&'static str> {
    let id = option_env!("GWORK_JAR_BUILD_ID").unwrap_or("").trim();
    if id.is_empty() || id.eq_ignore_ascii_case("unknown") {
        None
    } else {
        Some(id)
    }
}

/// 安装一致性自检：把「jar 自报的 buildId」与「装包快照」对一下。
///
/// 为什么能抓到部分覆盖：覆盖安装时旧 javaw.exe 若持有 jre 映像，NSIS 删不掉旧 jar，
/// 升级「成功」但 jar 还是上一个代，表现为若干无法解释的接口异常。
/// 字段名与 Electron 版 `verifyBuildIdentity` 逐一对齐（两壳共用一份前端提示条）。
/// 刻意只报不阅：自检失败时后端其实可用，不能因此把状态置为 failed。
async fn verify_build_identity(port: u16) -> serde_json::Value {
    let expected = match expected_build_id() {
        Some(id) => id.to_string(),
        None => return serde_json::json!({ "ok": true, "skipped": "no-build-id" }),
    };

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
    {
        Ok(c) => c,
        Err(e) => return serde_json::json!({ "ok": true, "skipped": format!("client-build: {e}") }),
    };
    let url = format!("http://127.0.0.1:{}/web/chat/meta", port);
    let body: serde_json::Value = match client.get(&url).send().await {
        Ok(resp) => match resp.json::<serde_json::Value>().await {
            Ok(b) => b,
            Err(e) => return serde_json::json!({ "ok": true, "skipped": format!("meta-parse: {e}") }),
        },
        Err(e) => return serde_json::json!({ "ok": true, "skipped": format!("meta-unreachable: {e}") }),
    };

    let data = body.get("data").cloned().unwrap_or_else(|| body.clone());
    let actual = data.get("buildId").and_then(|s| s.as_str()).unwrap_or("").to_string();

    if actual.is_empty() {
        return serde_json::json!({
            "ok": false,
            "expected": expected,
            "actual": "",
            "reason": "运行中的后端 jar 不携带 buildId（早于构建指纹机制），说明它不是本安装包里的 jar。",
        });
    }
    if actual != expected {
        return serde_json::json!({
            "ok": false,
            "expected": expected,
            "actual": actual,
            "reason": "运行中的后端与本安装包记录的构建指纹不一致，典型原因是覆盖安装时旧 jar 被占用未能替换。",
        });
    }
    serde_json::json!({ "ok": true, "expected": expected, "actual": actual })
}

/// 统一构造并广播 backend-failed 负载（字段名与 Electron 版 backendFailedPayload 对齐，
/// 两壳共用一份 app-bootstrap.js 错误条，不必写两套解析）。
fn emit_failed(app: &AppHandle, reason: &str) {
    let (status, probe_error, auto_retry_attempt, auto_retry_max, retrying, server_log) = {
        let mgr = BACKEND.lock().unwrap();
        (
            mgr.last_probe.as_ref().map(|p| p.status).unwrap_or(0),
            mgr.last_probe.as_ref().map(|p| p.error.clone()).unwrap_or_default(),
            AUTO_RESTART_ATTEMPT.load(Ordering::SeqCst),
            AUTO_RESTART_DELAYS_MS.len(),
            RESTARTING.load(Ordering::SeqCst),
            get_server_log_path().display().to_string(),
        )
    };
    crate::ipc_bridge::emit(
        app,
        "backend-failed",
        &serde_json::json!({
            "message": reason,
            "status": status,
            "probeError": probe_error,
            "logPath": crate::logging::main_log_path().display().to_string(),
            "serverLogPath": server_log,
            "autoRetryAttempt": auto_retry_attempt,
            "autoRetryMax": auto_retry_max,
            "retrying": retrying,
        }),
    );
}

/// 自动重启任务醒来后是否仍应执行（纯函数，便于单测）：
/// - 状态不再是 Failed（Ready=已被手动重试/另一次重启救活；Pending=有新重启正在进行）→ 放弃
/// - 失败纪元已变（新失败已排期新任务接管重试链）→ 旧任务放弃
fn auto_restart_still_needed(current_state: ReadyState, current_epoch: u64, captured_epoch: u64) -> bool {
    current_state == ReadyState::Failed && current_epoch == captured_epoch
}

/// 安排一次指数退避的自动重启；次数耗尽后停止重试并保留错误状态。
fn schedule_auto_restart(app: AppHandle, reason: String) {
    if app.state::<AppState>().is_quitting.load(Ordering::SeqCst) {
        return;
    }
    let attempt = AUTO_RESTART_ATTEMPT.load(Ordering::SeqCst);
    if attempt >= AUTO_RESTART_DELAYS_MS.len() {
        error!(
            "自动重启已达上限（{} 次），停止重试。若为覆盖安装后出现此故障，多半是安装目录未能完全替换（旧 jar/jre 被占用），请卸载后重装。原因: {}",
            AUTO_RESTART_DELAYS_MS.len(),
            reason
        );
        return;
    }
    let delay = AUTO_RESTART_DELAYS_MS[attempt];
    AUTO_RESTART_ATTEMPT.store(attempt + 1, Ordering::SeqCst);
    // 捕获当前失败纪元：调用方均先 settle(false)（纪元已自增）再排期，故本值即「本次失败」的纪元
    let epoch = FAILURE_EPOCH.load(Ordering::SeqCst);
    warn!("{}ms 后发起第 {} 次自动重启，原因: {}", delay, attempt + 1, reason);

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        if handle.state::<AppState>().is_quitting.load(Ordering::SeqCst) {
            return;
        }
        // 醒来先校验触发本任务的失败是否仍然成立：
        // 退避窗口内用户手动重试成功（Ready）或另有重启在进行（Pending）时，
        // 盲目重启会把刚恢复的健康后端再杀一次（端口变化、WS 断开、进行中请求中断）。
        {
            let mgr = BACKEND.lock().unwrap();
            let now_epoch = FAILURE_EPOCH.load(Ordering::SeqCst);
            if !auto_restart_still_needed(mgr.ready_state, now_epoch, epoch) {
                info!(
                    "自动重启任务放弃执行：后端当前状态={}，失败纪元 {}→{}",
                    mgr.ready_state.as_str(),
                    epoch,
                    now_epoch
                );
                return;
            }
        }
        let ready_tx = handle.state::<AppState>().backend_ready.clone();
        match restart_backend_inner(&handle, &ready_tx).await {
            Ok(port) => info!("自动重启成功，端口 {}", port),
            Err(e) => {
                let msg = format!("{:#}", e);
                // 与并发重启（手动/自动）撞车：不消耗退避次数、不接续重试链，
                // 由正在进行的那次重启自身的结果链决定后续重试；本任务让位退出。
                if msg.contains("重启已在进行中") {
                    warn!("自动重启让位给并发重启，本重试链退出: {}", msg);
                    return;
                }
                // inner 已置 failed 并广播（纪元已自增）；这里接着排下一次退避
                schedule_auto_restart(handle.clone(), msg);
            }
        }
    });
}

/// 监视后端子进程意外退出（每 1s 轮询 try_wait）。
///
/// 为何用轮询而非 `child.wait()`：`Child` 句柄被全局 `BACKEND` 锁持有，
/// `wait()` 需要所有权，把它移交给监听任务会让 `stop_backend`/`restart` 无法再取回。
/// 1s 轮询对这个场景足够（后端崩溃是秒级事件），且避开了一整类所有权/死锁问题。
///
/// 主动停止不会误报：`stop_backend` 先 `take()` 走 process，监听任务下一轮看到
/// `None` 就静默退出（而非当成故障），因此退出应用不会被当作意外退回去反复拉起后端。
fn spawn_exit_watcher(app: AppHandle) {
    let (pid, gen) = {
        let mgr = BACKEND.lock().unwrap();
        (
            mgr.process.as_ref().map(|p| p.pid).unwrap_or(0),
            mgr.generation,
        )
    };
    if pid == 0 {
        return;
    }

    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(1000)).await;

            let dead: Option<String> = {
                let mut mgr = BACKEND.lock().unwrap();
                // 已被新的启动/重启接管，或进程句柄被主动收走 → 本任务结束
                if mgr.generation != gen {
                    return;
                }
                match mgr.process.as_mut() {
                    None => return,
                    Some(p) => {
                        if p.pid != pid {
                            return;
                        }
                        match p.child.try_wait() {
                            Ok(Some(status)) => {
                                mgr.process = None;
                                Some(format!("后端进程意外退出 (PID={}, {})", pid, status))
                            }
                            Ok(None) => None,
                            Err(e) => {
                                mgr.process = None;
                                Some(format!("检查后端进程状态失败 (PID={}): {}", pid, e))
                            }
                        }
                    }
                }
            };

            let reason = match dead {
                Some(r) => r,
                None => continue,
            };
            error!("{}", reason);
            settle_backend_ready(false, Some(&reason));
            emit_failed(&app, &reason);
            schedule_auto_restart(app.clone(), reason);
            return;
        }
    });
}

async fn bootstrap_inner(_app: &AppHandle) -> Result<u16> {
    // 1. 分配后端 jar 端口
    let port = find_available_port().await?;
    info!("后端端口: {}", port);

    // 2. 启动 Java 子进程
    let pid = start_backend(port).await?;
    info!("后端已启动, PID={}", pid);

    // 3. 等待就绪（此期间界面外壳已可见，仅 /web/** 接口请求在 UI 服务器挂起等待）
    info!("等待后端就绪...");
    wait_for_backend(port, 60_000).await?;

    Ok(port)
}

// ─── Tauri Commands ───────────────────────────────────────────────────────────

/// 渲染层主动查询后端就绪状态（'pending' | 'ready' | 'failed'）。
/// 与 backend-ready/backend-failed 事件互补，消除“事件早于监听器注册”的启动竞态。
#[tauri::command]
pub fn get_backend_state() -> String {
    BACKEND.lock().unwrap().ready_state.as_str().to_string()
}

/// 后端状态详情：端口、PID、存活、最近探针、失败原因、两份日志路径与资源目录。
///
/// 前端错误条靠它“一句话说清”，用户截图即可定位，不必再开 devtools 猜。
/// 字段名与 Electron 版 `get-backend-detail` 逐项一致。
#[tauri::command]
pub fn get_backend_detail(app: AppHandle) -> serde_json::Value {
    let (state, pid, alive, last_error, probe, auto_retry_attempt, restarting, resources_dir, server_log) = {
        let mut mgr = BACKEND.lock().unwrap();
        // try_wait 需要 &mut Child，故先用 as_mut 算存活，再取只读字段
        let alive = match mgr.process.as_mut() {
            Some(p) => !matches!(p.child.try_wait(), Ok(Some(_))),
            None => false,
        };
        let pid = mgr.process.as_ref().map(|p| p.pid).unwrap_or(0);
        (
            mgr.ready_state.as_str(),
            pid,
            alive,
            mgr.last_error.clone().unwrap_or_default(),
            mgr.last_probe.as_ref().map(|p| serde_json::json!({ "status": p.status, "error": p.error })),
            AUTO_RESTART_ATTEMPT.load(Ordering::SeqCst),
            RESTARTING.load(Ordering::SeqCst),
            paths::resources_dir().display().to_string(),
            get_server_log_path().display().to_string(),
        )
    };
    let st: State<'_, AppState> = app.state::<AppState>();
    let port = st.backend_port.lock().map(|p| *p).unwrap_or(0);
    let ui_port = st.ui_port.lock().map(|p| *p).unwrap_or(0);

    serde_json::json!({
        "state": state,
        "port": port,
        "uiPort": ui_port,
        "pid": pid,
        "alive": alive,
        "lastError": last_error,
        "lastProbe": probe,
        "restarting": restarting,
        "autoRetryAttempt": auto_retry_attempt,
        "autoRetryMax": AUTO_RESTART_DELAYS_MS.len(),
        "logPath": crate::logging::main_log_path().display().to_string(),
        "serverLogPath": server_log,
        "resourcesDir": resources_dir,
        "runtimeHomeDir": paths::runtime_home_dir().display().to_string(),
        "appVersion": app.package_info().version.to_string(),
    })
}

/// 重启后端：停止旧进程树 → 重新分配端口 → 启动 → 等待就绪 → 恢复 ready 状态。
/// 成功后渲染层应重连 WebSocket / 刷新数据；失败则置 failed 并返回错误描述。
#[tauri::command]
pub async fn restart_backend(app: AppHandle) -> Result<(), String> {
    let state: State<'_, AppState> = app.state::<AppState>();
    let ready_tx = state.backend_ready.clone();
    restart_backend_inner(&app, &ready_tx)
        .await
        // inner 返回新端口供内部流程使用；命令侧只需成功/失败语义
        .map(|_port| ())
        .map_err(|e| format!("{:#}", e))
}

async fn restart_backend_inner(
    app: &AppHandle,
    app_ready_tx: &watch::Sender<bool>,
) -> Result<u16> {
    // 串行化：自动重启与手动重试可能同时抵达，只允许一个在跑
    if RESTARTING.swap(true, Ordering::SeqCst) {
        return Err(anyhow!("重启已在进行中"));
    }
    let result = restart_backend_serialized(app, app_ready_tx).await;
    RESTARTING.store(false, Ordering::SeqCst);
    result
}

async fn restart_backend_serialized(
    app: &AppHandle,
    app_ready_tx: &watch::Sender<bool>,
) -> Result<u16> {
    // 重置状态机并暂停代理放行（去闩锁后不再需要“允许再次迁移”的特殊处理）
    {
        let mut mgr = BACKEND.lock().unwrap();
        mgr.ready_state = ReadyState::Pending;
        mgr.last_error = None;
        let _ = mgr.ready_tx.send(false);
    }
    let _ = app_ready_tx.send(false);

    // 1. 停止旧进程
    stop_backend().await;

    // 2. 重新分配端口并启动
    let result = async {
        let port = find_available_port().await?;
        start_backend(port).await?;
        wait_for_backend(port, 60_000).await?;
        Ok(port)
    }
    .await;

    match result {
        Ok(port) => {
            info!("后端重启完成，端口 {}", port);
            if let Ok(mut p) = app.state::<AppState>().backend_port.lock() {
                *p = port;
            }
            AUTO_RESTART_ATTEMPT.store(0, Ordering::SeqCst);
            settle_backend_ready(true, None);
            let _ = app_ready_tx.send(true);
            crate::ipc_bridge::emit(&app, "backend-ready", &serde_json::json!({ "port": port }));
            spawn_exit_watcher(app.clone());
            Ok(port)
        }
        Err(e) => {
            let msg = format!("{:#}", e);
            error!("后端重启失败: {}", msg);
            settle_backend_ready(false, Some(&msg));
            emit_failed(&app, &msg);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_state_str() {
        assert_eq!(ReadyState::Pending.as_str(), "pending");
        assert_eq!(ReadyState::Ready.as_str(), "ready");
        assert_eq!(ReadyState::Failed.as_str(), "failed");
    }

    /// 回归护栏：settle 必须同时广播到镜像 channel（即 `AppState.backend_ready`）。
    ///
    /// 为什么值得专门钉住：生产路径上 UI 代理订阅的是 `AppState.backend_ready`
    /// （server.rs::start_ui_server），而不是模块内部的 `ready_tx`。若 settle 只写内部
    /// channel，则「后端挂了→代理拦截」整条链路静默失效：状态显示 failed，代理却照旧
    /// 放行请求，用户看到的是每个接口 502 而非可读的 503。这类错误不会报错，只能靠测试抦住。
    #[test]
    fn settle_mirrors_to_app_ready_channel() {
        let (tx, rx) = watch::channel(false);
        bind_app_ready_tx(tx);

        settle_backend_ready(true, None);
        assert!(*rx.borrow(), "settle(true) 必须广播到 UI 代理订阅的 channel");

        settle_backend_ready(false, Some("模拟后端死亡"));
        assert!(!*rx.borrow(), "settle(false) 必须让代理停止放行，否则接口会直接 502");

        // 原因与状态同一次加锁写入，不存在「看到 Failed 却拿不到原因」的窗口
        let mgr = BACKEND.lock().unwrap();
        assert_eq!(mgr.ready_state, ReadyState::Failed);
        assert_eq!(mgr.last_error.as_deref(), Some("模拟后端死亡"));
        drop(mgr);

        // 恢复现场，避免全局状态污染同进程内的其它用例
        let mut mgr = BACKEND.lock().unwrap();
        mgr.ready_state = ReadyState::Pending;
        mgr.last_error = None;
        mgr.mirror_tx = None;
    }

    /// 回归护栏：自动重启任务醒来后，触发它的失败若已被解决/取代，必须放弃执行。
    ///
    /// 为什么值得钉住：退避窗口（1s/3s/10s…）内用户点「重试」并成功后，
    /// 在途的自动重启任务若照常执行，会把刚恢复的健康后端再杀一次——
    /// 端口变化、WS 断开、进行中的请求/工具调用全部中断，且无任何报错提示。
    #[test]
    fn auto_restart_skips_when_failure_resolved_or_superseded() {
        // 手动重试已把后端救活（Ready）→ 放弃
        assert!(!auto_restart_still_needed(ReadyState::Ready, 3, 3));
        // 另有重启正在进行（Pending）→ 放弃，由其结果链决定后续
        assert!(!auto_restart_still_needed(ReadyState::Pending, 3, 3));
        // 新失败已接管重试链（纪元自增）→ 旧任务放弃，避免双重重启
        assert!(!auto_restart_still_needed(ReadyState::Failed, 4, 3));
        // 失败仍然成立且无新失败 → 执行
        assert!(auto_restart_still_needed(ReadyState::Failed, 3, 3));
    }

    /// 初始状态为 pending，ready_tx 广播 false
    #[test]
    fn initial_state_is_pending() {
        let rx = backend_ready_rx();
        assert!(!*rx.borrow());
    }

    /// PATH 搜索逻辑：在临时目录放入假 java，应能被 find_java 步骤 4 命中。
    /// 注：修改进程级 PATH 有并发风险，单线程测试环境可接受。
    #[test]
    fn find_java_searches_path() {
        let dir = std::env::temp_dir().join(format!("gourd-test-jdk-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let java_name = if cfg!(windows) { "javaw.exe" } else { "java" };
        let fake = dir.join(java_name);
        std::fs::write(&fake, b"fake").unwrap();

        let old_path = std::env::var_os("PATH").unwrap_or_default();
        let mut new_path = std::ffi::OsString::from(&dir);
        new_path.push(";");
        new_path.push(&old_path);
        std::env::set_var("PATH", &new_path);

        // 内置 JRE/JAVA_EXEC/JAVA_HOME 均缺失时，PATH 应命中
        std::env::remove_var("JAVA_EXEC");
        std::env::remove_var("JAVA_HOME");
        let found = find_java();

        std::env::set_var("PATH", old_path);
        let _ = std::fs::remove_dir_all(&dir);

        if paths::bundled_java_exe(true).is_some() {
            // 开发机装了内置 JRE 时跳过断言
            return;
        }
        assert!(found.is_some(), "find_java 应从 PATH 找到假 java");
    }

    /// find_jar 必须走 paths 的统一解析：目录选定后 jar 路径就是它下面的固定文件名。
    /// 这条护栏防止有人再把本地 resources_dir() 加回来（9/04 故障的根源）。
    #[test]
    fn find_jar_follows_paths_resolution() {
        let expected = paths::resources_dir().join("gourd-ai-agent.jar");
        match find_jar() {
            Some(p) => assert_eq!(p, expected),
            None => assert!(!expected.exists(), "jar 不存在时 find_jar 应返回 None"),
        }
    }

    /// 本模块不得再出现私有的 resources_dir 实现。用不变量钉死：
    /// `resources_dir()` 的缓存值必须等于现场重算的结果。一旦哪个模块又自己拼路径，
    /// 多布局并存的机器上两者就会分叉（即 9/04 故障的成因）。
    #[test]
    fn no_divergent_resources_dir() {
        let fresh = paths::pick_resources_dir(&paths::resources_dir_candidates());
        assert_eq!(
            paths::resources_dir(),
            fresh,
            "缓存解析结果与现场重算不一致：说明存在第二份路径解析逻辑"
        );
    }
}
