//! server.rs - 本地 UI 服务器 + 反向代理（Rust 版，对应 Electron 版 main/ui-server.js）
//!
//! 设计目标：把 UI（HTML/JS/CSS）从后端 jar 中解耦，由 Tauri 进程起一个轻量 HTTP
//! 服务立即提供，使界面外壳「秒开」，不必等待后端 JVM 启动。
//!
//! 路由规则（页面加载于 http://127.0.0.1:{uiPort}/）：
//!   - /web/**、/chat/channel/**  → 反向代理到 http://127.0.0.1:{backendPort}（jar）
//!   - WebSocket 升级（/web/gate）→ 先与后端完成真实握手，把后端的 101（含
//!     Sec-WebSocket-Accept）原样回给页面，再接管 socket 做双向字节透传
//!   - 其它路径                    → 从本地 UI 目录读取静态文件（路径穿越防护 + index.html 回退）
//!
//! 后端未就绪时代理请求仅宽限 PROXY_GRACE_MS（1.5s），随后快速 503，绝不长时间占用连接。

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;
use futures_util::StreamExt;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tower::Service;
use tower_http::services::ServeDir;
use tracing::{debug, warn};

use crate::AppState;

/// 后端未就绪时，代理请求的最长宽限等待（毫秒）。
/// 只为兜住“就绪前一瞬间抵达”的请求；超过即快速 503，绝不长时间占用浏览器连接。
const PROXY_GRACE_MS: u64 = 1500;

// ─── 远程工作区路由（REMOTE_ROUTE）───────────────────────────────────────────────
//
// 远程工作区方案 A 的数据面。两种粒度共存（用户 2026-10-06 拍板「按工作区分流」）：
//   · 激活 scope（active）：无 cwd 归属信息的请求（列表/元信息/设置）走它；
//     语义与旧的进程级单值覆盖一致，因此不连远端时行为与改造前完全相同。
//   · 工作区级 scope（by_cwd）：带 `X-Session-Cwd` 的请求按路径命中绑定，
//     本地目录回本地、远端目录回对应隧道——于是本地与远程工作区可并存。
//
// 为什么代理层分流而不是前端改写地址（P1 原方案，已废弃）：
// 1. 页面源是 http://127.0.0.1:{uiPort}，改写后的目标是 http://127.0.0.1:{tunnelPort}
//    ——跨源（端口不同）。带 Authorization 头的跨源请求必须先过 CORS 预检
//    （OPTIONS），而远端 jar 不回 Access-Control-Allow-* 头，WebView2/WKWebView
//    严格执行预检 → 所有请求全灭。
// 2. 浏览器 WebSocket API 无法携带自定义 Authorization 头，远端
//    WebAuthFilter 会把 /web/gate 升级请求全部 401。
// 同源直连本地 UI 服务器 + 服务端切换上游，两个问题同时消失，前端零地址感知。
//
// 【分流键为何不需要前端改造】会话类 HTTP 请求已普遍携带 X-Session-Cwd（落盘定位
// 用），WS 里 terminal 已拼 ?cwd=；仅 gate 需补一个 cwd 参数。因此不引入 fetch/ajax
// 包装层（全站 174 个请求出口无统一收口，靠注入层分流容易一处漏就整链坏）。
#[derive(Default)]
struct RemoteRoute {
    /// 激活上游：无归属信息请求的默认去处（None = 全程本地）
    active: Option<(u16, String)>,
    /// connectionId → 上游（前端显式指定 `?__scope=id:<connectionId>` 时用，
    /// 也是 by_cwd 的写入来源）
    by_id: HashMap<String, (u16, String)>,
    /// 归一后的工作区绝对路径 → 上游（命中即按工作区分流）
    by_cwd: HashMap<String, (u16, String)>,
}

/// 路径归一：去首尾空白与尾部分隔符；Windows 风格路径（盘符或 UNC）额外统一
/// 分隔符并转小写（NTFS 大小写不敏感，`D:\Work` 与 `d:/work` 是同一目录）。
///
/// 【POSIX 必须保留大小写】不能一律 lowercase：macOS/Linux 桌面 + Linux 远端都是
/// 大小写敏感文件系统，`/home/u/Proj`（本地）与 `/home/u/proj`（远端）是两个真
/// 实存在的目录。若归一时合并，用户选中本地那个就会被误路由到远端——跳机读写，
/// 正是分流最不能出的错。
fn scope_key(cwd: &str) -> String {
    let t = cwd.trim().trim_end_matches(['/', '\\']).to_string();
    if t.is_empty() {
        return String::new();
    }
    // 盘符形式 a:\ 或 a:/；或 UNC \\host\share
    let bs = t.as_bytes();
    let is_drive = bs.len() >= 3 && bs[1] == b':' && (bs[2] == b'\\' || bs[2] == b'/');
    let is_unc = t.starts_with("\\\\");
    if is_drive || is_unc {
        t.replace('\\', "/").to_ascii_lowercase()
    } else {
        t
    }
}

// 路由表用 lazy_static：`HashMap::new()` 不是 const fn（RandomState 走非常量路径），
// 写在 `static` 初始化里直接编译失败；crate 已有 lazy_static 依赖（remote/mod.rs 同法）。
lazy_static::lazy_static! {
    static ref REMOTE_ROUTE: std::sync::RwLock<RemoteRoute> =
        std::sync::RwLock::new(RemoteRoute::default());
}

/// 【已删除两个旁路激活入口（旧版 set / clear 便捷接口）】它们与对应的读取函数
/// 一起构成 P0 的复发温床：任何调用点绕开 `bind_scope` 直写 active，就等于
/// 「一连远端就整机切走」（用户投诉的根因）。
/// 架构不变量：active 的唯一置位路径是 `bind_scope`，唯一回落路径是
/// `unregister_remote_connection` / `reset_remote_route`——不保留「便捷」旁路。
/// （函数名不在此重写完整形态：源码契约测试用全文件子串包含做判据，注释里的
/// 完整名字会被当成「该接口仍存在」的证据误命中——踩过两次。）

/// 带 connectionId 的登记（远程工作区分流主路径）：只写 by_id，**不置激活 scope**。
///
/// 【连接 ≠ 切换环境（ZCode 语义，用户 2026-10-07 拍板）】激活 scope 的唯一置位
/// 路径是 `bind_scope`——用户在下拉/侧栏**选中**某个远端工作区的那一刻，本地默认
/// 环境才让位。若连接一建立就抢 active，用户没选任何远端目录时全部无归属请求
/// （项目列表/全局会话/设置）都会灌进远端：本地会话从侧栏消失、界面像被远端
/// 「接管」——正是用户投诉「远程工作区怎么会覆盖本地工作区」的根因。
pub fn register_remote_connection(connection_id: &str, port: u16, auth_header: String) {
    if let Ok(mut g) = REMOTE_ROUTE.write() {
        g.by_id
            .insert(connection_id.to_string(), (port, auth_header));
        tracing::info!(
            "[ui-server] 远程连接 {} 已登记（未激活；选中其工作区时经 bind_scope 激活）",
            connection_id
        );
    }
}

/// 把某个工作区目录绑到指定连接（前端选中工作区时调用），并把激活 scope 一并
/// 切到该环境——「选择即环境」：用户选中本地目录 → active 清空（无归属请求回
/// 本地后端）；选中远端目录 → active 指向该连接（远端项目的会话列表等无归属
/// 请求跟随）。这是激活 scope 的**唯一**置位路径（register 不再自动激活，见
/// register_remote_connection 注释）。
///
/// `connection_id` 为 None / 空串 / "local" 表示「明确属于本地」：即使激活 scope
/// 指向远端，这个目录的请求也必须回本地后端（远程期间继续用本地工作区的关键语义）。
/// 返回 false = 连接未登记（不建悬空绑定，前端据此回退）。
pub fn bind_scope(cwd: &str, connection_id: Option<&str>) -> bool {
    let key = scope_key(cwd);
    if key.is_empty() {
        return false;
    }
    let mut g = match REMOTE_ROUTE.write() {
        Ok(g) => g,
        Err(_) => return false,
    };
    let is_local = match connection_id {
        None => true,
        Some(id) => id.trim().is_empty() || id == "local",
    };
    if is_local {
        // 本地绑定 = 不写条目（未命中即回本地，见 route_for 第 5 步），并清掉旧的远端
        // 绑定；激活 scope 同时回落本地（选择即环境：选中本地目录 = 环境回本地）。
        g.by_cwd.remove(&key);
        g.active = None;
        return true;
    }
    // 先 clone 再插：`match g.by_id.get(id) { Some(up) => g.by_cwd.insert(...) }` 会在
    // 不可变借用 g.by_id 的同一区域内可变借用 g.by_cwd——字段级拆分借用对
    // `HashMap.get` 的返回值不成立（借的是整个 g），直接 E0502。
    let bound = g.by_id.get(connection_id.unwrap_or("")).cloned();
    match bound {
        Some(up) => {
            g.active = Some(up.clone());
            g.by_cwd.insert(key, up);
            true
        }
        None => false, // 连接未登记：不建悬空绑定（前端会收到 false 并回退）
    }
}

/// 注销一条连接：摘掉 by_id 与所有指向它的 by_cwd；若激活 scope 正是它则清空。
///
/// 【不提供「只清激活、保留绑定」的中间函数】曾有一个只置 active=None、留着
/// by_cwd 的便捷接口：那条半死形态正是 P0-4 孤儿连接的源头——探活失败只清激活值，
/// 绑在 by_cwd 上的远端工作区仍把请求灌进已死的隧道 → 全 502 且无提示。
/// 摘除必须整条连干（含绑定），所以下面这个函数是运行期唯一的回落入口。
///
/// 不能写 `g.by_cwd.retain(|_, v| g.by_id.iter()…)`：retain 对 by_cwd 取可变借用，
/// 而闭包里又读同一结构的另一个字段（整个 g）——借用检查必报错。正确写法是
/// 先把存活侧的反查表算出来（一次只借一个字段），再用它做 retain。
pub fn unregister_remote_connection(connection_id: &str) {
    if let Ok(mut g) = REMOTE_ROUTE.write() {
        let gone = g.by_id.remove(connection_id);
        if let Some((port, _)) = &gone {
            if g.active.as_ref().map(|a| a.0) == Some(*port) {
                g.active = None;
            }
        }
        // 存活连接的 port → connectionId 反查表：by_cwd 的值只有 (port, auth)，不带
        // id，而「这条绑定属于谁」只能经端口反查（改 by_cwd 值结构影响面太大，
        // 包括 route_for/upstream_for 的全部字面断言）。
        //
        // 【值必须是 owned String】写成 `HashMap<u16, &str>` 会让反查表借用整个 g，
        // 下面的 retain 又要对 g.by_cwd 取可变借用 → E0502（与上方「不能内联
        // g.by_id.iter()」是同一个借用陷阱，只是换了个位置踩）。clone 一份 id 即可解开：
        // 这里最多几十条（连接数上限远小于此），开销可忽略。
        //
        // 【为何不用端口集合（方案B 前的旧判定）】旧写法是「端口仍被任何存活连接
        // 持有则保留」，与反查表在常规情形等价；真正的差别在于判定语义：新写法把它
        // 显式化为「绑定的归属连接是否存在」，不再依赖「一个端口 == 一条连接」这个在
        // WSL Direct 形态下并不成立的隐含前提（两条 WSL 连接的 localPort 就是同一个），
        // 也让「端口无人认领 = 孤儿绑定」这条分支有了明确落点（见下）。
        let owner_by_port: HashMap<u16, String> = g
            .by_id
            .iter()
            .map(|(id, up)| (up.0, id.clone()))
            .collect();
        // 只保留「归属连接仍存活」的工作区绑定：
        // · 端口仍有存活归属 → 保留。WSL Direct 端口碰撞时两个 id 共享同一端口，
        //   摘 A 后 B 仍持有该端口 → A 的绑定也保留：这正是期望语义（碰撞时宁可
        //   多留不可误删——两连接本就指向同一个可连端口，误删会把活着的远端工作区
        //   打回本地后端，那是跳机读写；多留只是多一条指向可用上游的绑定）；
        // · 端口无人认领（不应发生：by_cwd 只能由 bind_scope 从 by_id 复制而来）
        //   → 删除：悬空绑定没有任何可连目标，留着就是把请求灌进不存在的上游。
        g.by_cwd.retain(|_, v| owner_by_port.contains_key(&v.0));
        tracing::info!("[ui-server] 远程连接 {} 已注销（含其工作区绑定）", connection_id);
    }
}

/// 彻底重置（应用退出清理用）：连接、绑定、激活一起清。
pub fn reset_remote_route() {
    if let Ok(mut g) = REMOTE_ROUTE.write() {
        g.active = None;
        g.by_id.clear();
        g.by_cwd.clear();
    }
}

/// 分流决策（每个请求一次）：
/// 1. `?__scope=local` → 强制本地（前端拉「本地那份列表」用，合并展示的数据来源）；
/// 2. `?__scope=id:<connectionId>` → 指定连接（值需 urlpercent_decode：前端拼 URL 时
///    经 encodeURIComponent，冒号会变 %3A，不解码查表必失配 → 静默回落，表现为
///    「远端列表拉不到、合并列表永远只有本地」）；
/// 3. `/web/settings/**` → 强制本地（设置的权威源在本地后端；远端的同款配置由
///    mirror.rs 经隧道直连推送，不走代理面——否则连着远端改语言/外观/模型，
///    写进去的是远端内存态，本地权威配置被绕过）；
/// 4. 归属 cwd（头 `x-session-cwd` 或 query `cwd=`）命中 by_cwd → 该连接；
/// 5. 归属 cwd 存在但未命中 → 本地（本地目录就该走本地，不能因连着远端而串写）；
/// 6. 无归属信息 → 激活 scope（选中远端工作区后跟随；未选中/已断开 = 本地）。
fn route_for(path_and_query: &str, session_cwd: Option<&str>) -> RouteDecision {
    let g = match REMOTE_ROUTE.read() {
        Ok(g) => g,
        Err(_) => return RouteDecision::Local,
    };
    // 3：设置面强制本地（见 doc 第 3 条）。放在显式 scope 之前：设置是全局权威面，
    // 不得被任何 scope 参数改道。
    let path_only = path_and_query.split('?').next().unwrap_or("");
    if path_only.starts_with("/web/settings/") || path_only == "/web/settings" {
        return RouteDecision::Local;
    }
    // 1/2：显式 scope 参数（只在路由表非空时才有意义，先短路）
    if let Some(q) = path_and_query.split_once('?').map(|x| x.1) {
        for pair in q.split('&') {
            let (k, v) = match pair.split_once('=') {
                Some(kv) => kv,
                None => continue,
            };
            if k != "__scope" {
                continue;
            }
            if v == "local" {
                return RouteDecision::Local;
            }
            let decoded = urlpercent_decode(v);
            if let Some(id) = decoded.strip_prefix("id:") {
                if let Some(up) = g.by_id.get(id) {
                    return RouteDecision::Remote(up.clone());
                }
            }
        }
    }
    // 4/5：按工作区归属分流
    let cwd = session_cwd
        .map(str::to_string)
        .or_else(|| extract_cwd_from_query(path_and_query))
        .filter(|c| !c.trim().is_empty());
    if let Some(c) = &cwd {
        let key = scope_key(c);
        if !key.is_empty() {
            if let Some(up) = g.by_cwd.get(&key) {
                return RouteDecision::Remote(up.clone());
            }
            // 带明确归属信息却没绑定过 = 本地工作区（绝不落进激活的远端）
            return RouteDecision::Local;
        }
    }
    // 6：兜底激活 scope（选中远端工作区后跟随；未选中 = 本地）
    match &g.active {
        Some(up) => RouteDecision::Remote(up.clone()),
        None => RouteDecision::Local,
    }
}

/// 从 query 里取 cwd（WS 升级与部分 GET 用；header 优先，故仅在 header 缺失时兜底）。
fn extract_cwd_from_query(path_and_query: &str) -> Option<String> {
    let q = path_and_query.split_once('?')?.1;
    for pair in q.split('&') {
        // 无 `=` 的裸段（如 `?debug&cwd=/x`）必须跳过继续扫，不能整个放弃。
        // 用 `?` 会在遇到任一裸段时立刻返回 None，后面的 cwd 永远取不到——
        // WS 分流静默降级为本地（「HTTP 打到远端、事件流回本地」的断链）。
        // 口径与 route_for 的同名解析一致（None => continue）。
        let (k, v) = match pair.split_once('=') {
            Some(kv) => kv,
            None => continue,
        };
        if k == "cwd" || k == "root" {
            return Some(urlpercent_decode(v));
        }
    }
    None
}

/// 手写百分号解码（不为此引入新依赖；WS/代理只用到 UTF-8 路径）。
/// 注意这是 **query 语义**：'+' 解析为空格（表单编码约定）。
fn urlpercent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(v) => {
                        out.push(v);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 【中文路径修复】component 语义的百分号解码：与 JS `encodeURIComponent` 严格互逆，
/// '+' 是字面量而非空格（与上面 urlpercent_decode 的表单语义区分）。
/// 用于解码 X-Session-Cwd 头：前端经 encodeSessionCwdHeader 编码后携带，纯 ASCII
/// 路径不含 '%' 时与原串逐字节一致（零行为变化）。
fn percent_decode_component(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(v) => {
                        out.push(v);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RouteDecision {
    /// 走本地后端 jar（无凭据注入）
    Local,
    /// 走远端数据面（端口 + 需注入的 Authorization 头值）
    Remote((u16, String)),
}

impl RouteDecision {
    /// 转成代理可用的（端口, 待注入凭据）；本地时回 None，交由唯一决策入口
    /// `upstream_for` 落回本地后端端口（未就绪时调用方宽限等一次再重算）。
    fn as_remote(&self) -> Option<(u16, Option<String>)> {
        match self {
            RouteDecision::Remote((p, a)) => Some((*p, Some(a.clone()))),
            RouteDecision::Local => None,
        }
    }
}

/// 代理连接/请求超时保护。
const PROXY_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const PROXY_REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

/// 共享给各 handler 的上下文。
#[derive(Clone)]
struct UiCtx {
    /// 后端就绪 watch（来自 AppState.backend_ready 的订阅）
    ready_rx: watch::Receiver<bool>,
    /// 后端端口的唯一共享状态，直接指向 AppState.backend_port。
    /// 不允许复制后再用定时器同步，否则 ready 广播后首批请求可能读到旧端口 0。
    backend_port: Arc<std::sync::Mutex<u16>>,
    /// UI 静态目录（绝对路径，已 canonicalize）
    ui_dir: PathBuf,
    /// 反代 HTTP client
    client: reqwest::Client,
}

impl UiCtx {
    fn backend_port(&self) -> u16 {
        self.backend_port.lock().map(|p| *p).unwrap_or(0)
    }

    /// 等待后端就绪：ready→true，failed/超时→false。
    async fn await_backend(&self, timeout: Duration) -> bool {
        if *self.ready_rx.borrow() {
            return true;
        }
        let mut rx = self.ready_rx.clone();
        let wait = async move {
            loop {
                if rx.changed().await.is_err() {
                    return *rx.borrow();
                }
                if *rx.borrow() {
                    return true;
                }
                // false 可能是重启中转态；继续等待，由外层 timeout 收敛
            }
        };
        match tokio::time::timeout(timeout, wait).await {
            Ok(v) => v,
            Err(_) => false,
        }
    }
}

/// 需要转发到后端 jar 的路径前缀（其余按本地静态文件处理）。
fn is_backend_path(pathname: &str) -> bool {
    pathname.starts_with("/web/")
        || pathname == "/web"
        || pathname.starts_with("/chat/channel/")
}

/// 本地 UI 目录：
/// - 打包后：<resource_dir>/ui（tauri bundle resources）
/// - 开发环境：指向 gourd-ai-agent 的静态资源源目录，改 UI 无需重新构建
pub fn get_ui_dir(app: &AppHandle) -> PathBuf {
    if !cfg!(debug_assertions) {
        if let Ok(res) = app.path().resource_dir() {
            let ui = res.join("ui");
            if ui.join("index.html").exists() {
                return ui;
            }
            let alt = res.join("extraResources").join("ui");
            if alt.join("index.html").exists() {
                return alt;
            }
            return ui;
        }
    }

    // 开发版：从可执行文件向上回溯仓库根，定位 gourd-ai-agent/src/main/resources/static
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    let mut dir: Option<&Path> = Some(exe_dir.as_path());
    while let Some(d) = dir {
        let candidate = d
            .join("gourd-ai-agent")
            .join("src")
            .join("main")
            .join("resources")
            .join("static");
        if candidate.join("index.html").exists() {
            return candidate;
        }
        dir = d.parent();
    }
    exe_dir
        .join("..")
        .join("gourd-ai-agent")
        .join("src")
        .join("main")
        .join("resources")
        .join("static")
}

/// 过滤逐跳头（hop-by-hop headers）。
fn is_hop_by_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn service_unavailable() -> Response {
    let mut resp = (StatusCode::SERVICE_UNAVAILABLE, "后端启动中，请稍候…").into_response();
    let h = resp.headers_mut();
    h.insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    resp
}

/// 上游决策的唯一真值函数：分流（`route_for`）+ 本地端口 → 最终（端口, 待注入凭据）。
/// 返回 None = 本地后端还没起来（调用方据此决定要不要 await 就绪再重试一次）。
///
/// 【P0 修复：为什么必须去掉旧的「覆盖优先」】原先本地分支会调 `resolve_upstream`，
/// 而它的第一件事就是读 active 覆盖并直接返回远端端口——于是 route_for 那三条
/// 「必须回本地」的安全栏被下游一票否决：
///   · `?__scope=local`（双拉合并里的「本地那份列表」）→ 实际打到远端；
///   · `/web/settings/**`（设置权威源在本地）→ 连着远端且选中远端工作区时改设置，
///     写进的是远端内存态，本地配置被静默绕过；
///   · 带 cwd 但未绑定（本地工作区）→ 打到远端，本地目录发生跳机读写。
/// 表现正是用户投诉的「远程工作区覆盖了本地工作区」——选中本地目录后，本地列表
/// 依然被远端内容顶掉。分流结论只能有一个来源，故覆盖的读取收敛进 `route_for`
/// 第 6 级（唯一入口）。
///
/// 抽成纯函数的目的：让「选着远端工作区时强制本地的那三类请求到底落哪」成为
/// **可直接断言的行为**，而不是靠源码字符串扫描——两处代理入口（HTTP/WS）共用
/// 同一个决策函数，也就不可能再出现「一面修好、另一面回读覆盖」的漂移。
fn upstream_for(
    path_and_query: &str,
    session_cwd: Option<&str>,
    local_port: u16,
) -> Option<(u16, Option<String>)> {
    match route_for(path_and_query, session_cwd).as_remote() {
        Some(up) => Some(up),
        // 判为本地：绝不回读 active 覆盖（P0 根因），本地端口未就绪才回 None
        None => (local_port != 0).then_some((local_port, None)),
    }
}

/// 反向代理普通 HTTP 请求到后端 jar（axum handler）。
async fn proxy_http(
    axum::extract::State(ctx): axum::extract::State<Arc<UiCtx>>,
    req: Request,
) -> Response {
    // 先取请求行与归属信息，再分流（上游选择依赖二者，因此 into_parts 必须前置）
    let (parts, body) = req.into_parts();
    let method = parts.method.clone();
    let path_q = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let session_cwd = parts
        .headers
        .get("x-session-cwd")
        .and_then(|v| v.to_str().ok())
        // 【中文路径修复】前端（app-base.js 的 encodeSessionCwdHeader）对该头统一
        // encodeURIComponent：HTTP 头值只允许 ISO-8859-1，原始中文会让浏览器在
        // setRequestHeader/Headers 构造时直接抛异常，请求发不出去（用户表现为
        // 「消息发送失败」）。读侧必须同步还原，否则 scope_key 拿到 %XX 串永远
        // 匹配不上 bind_scope 登记的原始路径 → 分流判为「未绑定 = 本地」。
        // 用 component 语义（'+' 是字面量）：encodeURIComponent 输出不含裸 '+'，
        // 但旧客户端/ASCII 路径可能含（如 D:\C++proj），若用 query 语义
        // （urlpercent_decode 的 '+'→空格）会把这类路径静默破坏。
        .map(percent_decode_component);

    // 按工作区分流（唯一决策入口 upstream_for）：命中远端则不需要本地后端就绪；
    // 判为本地且本地端口还没拿到，才宽限 await 一次再重算。
    let mut upstream = upstream_for(&path_q, session_cwd.as_deref(), ctx.backend_port());
    if upstream.is_none() && ctx.backend_port() == 0 {
        if ctx.await_backend(Duration::from_millis(PROXY_GRACE_MS)).await {
            upstream = upstream_for(&path_q, session_cwd.as_deref(), ctx.backend_port());
        }
    }
    let (backend_port, auth_inject) = match upstream {
        Some(v) => v,
        None => return service_unavailable(),
    };
    let url = format!("http://127.0.0.1:{}{}", backend_port, path_q);

    // 过滤逐跳头，重建 host
    let mut out_headers = HeaderMap::new();
    for (k, v) in parts.headers.iter() {
        if is_hop_by_header(k.as_str()) || k.as_str().eq_ignore_ascii_case("host") {
            continue;
        }
        // 远程覆盖：客户端自带的 Authorization 一律作废（可能属于本地后端），
        // 由代理统一注入远端凭据（见下方 auth_inject）。
        if auth_inject.is_some() && k.as_str().eq_ignore_ascii_case("authorization") {
            continue;
        }
        out_headers.insert(k, v.clone());
    }
    if let Some(auth) = &auth_inject {
        if let Ok(v) = HeaderValue::from_str(auth) {
            out_headers.insert(header::AUTHORIZATION, v);
        }
    }

    // 请求体**流式**转发，绝不整体缓冲。
    //
    // 这里曾经是 `to_bytes(body, usize::MAX)`：把整个请求体读进内存再转发。
    // 附件上传（WebGate.chat_input 收 UploadedFile[]）走的正是这条路，于是
    //   - 传 N 字节文件 = N 字节堆内存尖峰，上限 usize::MAX 等于没有上限；
    //   - 后端必须等浏览器把最后一个字节发完才能看到第一个字节，白等一整个上传时长。
    // Electron 版 (`main/ui-server.js` 的 `req.pipe(upstream)`) 一直是流式的，
    // 只有 Tauri 版退化成缓冲，此处对齐。
    //
    // 关于分帧：`content-length` 不属于逐跳头，会被原样转发；hyper 在请求头已带
    // Content-Length 时走定长编码而非 chunked（proto/h1/role.rs 的 existing_con_len
    // 分支），故后端 multipart 解析看到的分帧与改造前完全一致。客户端若用 chunked
    // （无 Content-Length），转发后 hyper 会重新加上 chunked，同样等价。
    let body_stream = body.into_data_stream();

    let upstream = match ctx
        .client
        .request(method, &url)
        .headers(out_headers)
        .header(header::HOST, format!("127.0.0.1:{}", backend_port))
        .body(reqwest::Body::wrap_stream(body_stream))
        .timeout(PROXY_REQUEST_TIMEOUT)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            warn!("代理后端失败: {}", e);
            return (
                StatusCode::BAD_GATEWAY,
                format!("代理后端失败: {}", e),
            )
                .into_response();
        }
    };

    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut builder = Response::builder().status(status);
    {
        let headers = builder.headers_mut().expect("response builder headers");
        for (k, v) in upstream.headers().iter() {
            if is_hop_by_header(k.as_str()) {
                continue;
            }
            headers.insert(k, v.clone());
        }
    }

    let stream = upstream.bytes_stream();
    let body = Body::from_stream(
        stream.map(|c| c.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))),
    );
    match builder.body(body) {
        Ok(r) => r,
        Err(e) => {
            warn!("构造代理响应失败: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "proxy error").into_response()
        }
    }
}

/// 构建 axum Router：后端路径走 proxy_http，其余走静态文件服务。
fn build_router(ctx: Arc<UiCtx>) -> Router {
    let serve_dir = ServeDir::new(&ctx.ui_dir)
        .append_index_html_on_directories(true)
        .precompressed_gzip()
        .precompressed_br();

    Router::new()
        .route("/web", axum::routing::any(proxy_http))
        .route("/web/*path", axum::routing::any(proxy_http))
        .route("/chat/channel/*path", axum::routing::any(proxy_http))
        .fallback_service(serve_dir)
        .with_state(ctx)
}

/// 判断是否为 WebSocket 升级请求。
fn is_ws_upgrade(headers: &HeaderMap) -> bool {
    let upgrade = headers
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false);
    let connection = headers
        .get(header::CONNECTION)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_ascii_lowercase().contains("upgrade"))
        .unwrap_or(false);
    upgrade && connection
}

/// 读取上游 HTTP 响应头（直到 CRLFCRLF）。
///
/// 返回 (响应头字节, 头之后已经预读到的残留字节)。残留字节是后端在 101 之后
/// 紧接着发出的 WS 帧——它们已经落在我们的读缓冲里，**必须**在透传开始前
/// 补写给客户端，否则首帧（往往就是会话的第一个流式 chunk）会凭空丢失。
async fn read_upstream_head(stream: &mut TcpStream) -> Result<(Vec<u8>, Vec<u8>), String> {
    /// 握手响应头上限，防止异常上游把内存吃穿。
    const MAX_HEAD: usize = 64 * 1024;
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let n = stream
            .read(&mut chunk)
            .await
            .map_err(|e| format!("读取后端握手响应失败: {}", e))?;
        if n == 0 {
            return Err("后端在完成 WS 握手前关闭了连接".to_string());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let rest = buf.split_off(pos + 4);
            return Ok((buf, rest));
        }
        if buf.len() > MAX_HEAD {
            return Err("后端握手响应头过大".to_string());
        }
    }
}

/// 把上游响应头字节解析为 (状态码, 头列表)。
fn parse_head(head: &[u8]) -> Option<(u16, Vec<(String, String)>)> {
    let text = String::from_utf8_lossy(head);
    let mut lines = text.split("\r\n");
    let status = lines
        .next()?
        .split_whitespace()
        .nth(1)?
        .parse::<u16>()
        .ok()?;
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    Some((status, headers))
}

/// WebSocket 升级代理（对应 Electron 版 proxyUpgrade）。
///
/// ## 为什么必须先跟后端握完手再回 101
///
/// 曾经这里是「立刻自造一个 101 返回，再在 upgrade 回调里连后端」。那是错的，
/// 而且是 Tauri 版**唯一**无法对话/暂停/插话的根因：
///
/// 1. 自造的 101 没有 `Sec-WebSocket-Accept`。RFC 6455 要求客户端校验
///    `base64(SHA1(Sec-WebSocket-Key + GUID))`，缺失/不匹配一律判握手失败——
///    WebView2 与 WKWebView 都严格执行，于是 `/web/gate` 秒断、无限重连。
/// 2. 就算客户端放过，后端真正的 `HTTP/1.1 101 ...` 响应头随后会被
///    `copy_bidirectional` 当作数据原样灌进客户端，落在 WS 帧解析器眼里是垃圾字节。
///
/// Electron 走 `server.on('upgrade')` 直接拿到裸 socket，把后端的真 101 原样 pipe
/// 回去，天然不存在这个问题；浏览器直连模式压根不经过代理。故只有 Tauri 挂。
///
/// 现在的顺序与 Electron 语义一致：连后端 → 转发握手 → 读回后端的真实响应头 →
/// 把该响应（含 `Sec-WebSocket-Accept`）交给 hyper 回给页面 → upgrade 完成后透传。
async fn proxy_ws_raw(
    ctx: Arc<UiCtx>,
    mut req: hyper::Request<Incoming>,
) -> Result<hyper::Response<Body>, std::convert::Infallible> {
    // 先取请求行与头（归属信息在 query：WS 无法带自定义头，terminal/gate 用 ?cwd= 传
    // 工作区），再按与 proxy_http **同一套** route_for 分流。两面必须同构，
    // 否则会出现「会话 HTTP 打到远端、它的 WS 仍连本地」的跳机聊。
    let method = req.method().to_string();
    let path_q = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let headers = req.headers().clone();
    // 与 proxy_http 同一决策函数（两面必须同构，否则「会话 HTTP 打远端、它的 WS
    // 连本地」的跳机聊）；WS 无自定义头，归属只从 query 的 ?cwd= 取。
    let mut upstream = upstream_for(&path_q, None, ctx.backend_port());
    if upstream.is_none() && ctx.backend_port() == 0 {
        if ctx.await_backend(Duration::from_millis(PROXY_GRACE_MS)).await {
            upstream = upstream_for(&path_q, None, ctx.backend_port());
        }
    }
    let (backend_port, auth_inject) = match upstream {
        Some(v) => v,
        None => return Ok(service_unavailable()),
    };

    // ── 1. 先连后端并完成握手 ──────────────────────────────────────────────
    let mut upstream = match tokio::time::timeout(
        PROXY_CONNECT_TIMEOUT,
        TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, backend_port)),
    )
    .await
    {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            warn!("连接后端 WS 失败: {}", e);
            return Ok(service_unavailable());
        }
        Err(_) => {
            warn!("连接后端 WS 超时");
            return Ok(service_unavailable());
        }
    };
    let _ = upstream.set_nodelay(true);

    // 重建升级请求行 + 头转发给后端。Sec-WebSocket-Key 等头**原样透传**，
    // 后端据此算出的 Accept 才能与浏览器本地的期望值对上。
    let mut raw = format!("{} {} HTTP/1.1\r\n", method, path_q);
    raw.push_str(&format!("Host: 127.0.0.1:{}\r\n", backend_port));
    let mut has_connection = false;
    let mut has_upgrade = false;
    for (k, v) in headers.iter() {
        if k.as_str().eq_ignore_ascii_case("host") {
            continue;
        }
        // 远程覆盖：客户端自带 Authorization 作废（可能属于本地后端），
        // 由代理统一注入远端凭据——浏览器 WebSocket API 无法携带自定义头，
        // 远端 WebAuthFilter 的 401 曾使全部 /web/gate 升级失败（P0 修复）。
        if auth_inject.is_some() && k.as_str().eq_ignore_ascii_case("authorization") {
            continue;
        }
        if k.as_str().eq_ignore_ascii_case("connection") {
            has_connection = true;
        }
        if k.as_str().eq_ignore_ascii_case("upgrade") {
            has_upgrade = true;
        }
        if let Ok(vs) = v.to_str() {
            raw.push_str(&format!("{}: {}\r\n", k.as_str(), vs));
        }
    }
    if !has_connection {
        raw.push_str("Connection: Upgrade\r\n");
    }
    if !has_upgrade {
        raw.push_str("Upgrade: websocket\r\n");
    }
    if let Some(auth) = &auth_inject {
        // 远程覆盖：无论客户端是否自带 Authorization，代理统一覆盖为远端凭据
        raw.push_str(&format!("Authorization: {}\r\n", auth));
    }
    raw.push_str("\r\n");

    if let Err(e) = upstream.write_all(raw.as_bytes()).await {
        warn!("转发 WS 握手失败: {}", e);
        return Ok(service_unavailable());
    }

    // ── 2. 读回后端的真实握手响应 ────────────────────────────────────────
    let (head, leftover) = match tokio::time::timeout(
        PROXY_CONNECT_TIMEOUT,
        read_upstream_head(&mut upstream),
    )
    .await
    {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            warn!("WS 握手失败: {}", e);
            return Ok(service_unavailable());
        }
        Err(_) => {
            warn!("等待后端 WS 握手响应超时");
            return Ok(service_unavailable());
        }
    };

    let (status, up_headers) = match parse_head(&head) {
        Some(v) => v,
        None => {
            warn!("无法解析后端握手响应");
            return Ok(service_unavailable());
        }
    };

    // 后端拒绝升级（401/404/503…）：把状态码如实回给页面，不要伪装成 101。
    if status != 101 {
        warn!("后端拒绝 WS 升级: {}", status);
        let mut resp = hyper::Response::new(Body::empty());
        *resp.status_mut() =
            StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
        return Ok(resp);
    }

    // ── 3. 把后端的 101 原样回给页面（关键：带上 Sec-WebSocket-Accept）──
    let mut resp = hyper::Response::new(Body::empty());
    *resp.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
    {
        let h = resp.headers_mut();
        for (k, v) in &up_headers {
            // 101 不应带实体长度头；其余（Connection/Upgrade/Sec-WebSocket-Accept/
            // Sec-WebSocket-Protocol/Extensions）必须原样保留。
            if k.eq_ignore_ascii_case("content-length")
                || k.eq_ignore_ascii_case("transfer-encoding")
            {
                continue;
            }
            if let (Ok(name), Ok(val)) = (
                header::HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(v),
            ) {
                h.insert(name, val);
            }
        }
        // hyper 依赖这两个头判定「这是一次升级」，后端若没给就补齐。
        if !h.contains_key(header::CONNECTION) {
            h.insert(header::CONNECTION, HeaderValue::from_static("Upgrade"));
        }
        if !h.contains_key(header::UPGRADE) {
            h.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
        }
    }

    // ── 4. 101 发出后接管 socket，双向透传 ────────────────────────────────
    let on_upgrade = hyper::upgrade::on(&mut req);
    tauri::async_runtime::spawn(async move {
        let upgraded = match on_upgrade.await {
            Ok(u) => u,
            Err(e) => {
                warn!("WS upgrade 失败: {}", e);
                return;
            }
        };
        let mut client_io = TokioIo::new(upgraded);

        // 与 101 同批到达的帧先补写，避免首帧丢失
        if !leftover.is_empty() {
            if let Err(e) = client_io.write_all(&leftover).await {
                warn!("回写 WS 预读帧失败: {}", e);
                return;
            }
        }

        if let Err(e) = tokio::io::copy_bidirectional(&mut client_io, &mut upstream).await {
            debug!("WS 透传结束: {}", e);
        }
    });

    Ok(resp)
}

/// 启动本地 UI 服务器，绑定 127.0.0.1:0（自动分配端口），返回监听端口。
///
/// 架构说明：
/// - 普通 HTTP 请求由 axum Router 处理（静态文件 / reqwest 反代）。
/// - 带 `Upgrade: websocket` 且命中后端路径的请求在 hyper service_fn 层分流，
///   通过 hyper upgrade 接管 socket 后做裸 TCP 透传，避免 axum ws 的帧级 API
///   与 tungstenite 版本耦合，语义与 Electron 版 net.connect 完全等价。
pub async fn start_ui_server(app: AppHandle) -> Result<u16> {
    let state = app.state::<AppState>();
    let ready_rx = state.backend_ready.subscribe();
    // 直接共享 AppState 中的端口锁。后端在广播 ready 前写入该锁，
    // 这样代理看到 ready 时必然也能读到新端口，不再存在 500ms 轮询窗口。
    let backend_port = state.backend_port.clone();

    let ui_dir = get_ui_dir(&app);
    let ui_dir = ui_dir
        .canonicalize()
        .with_context(|| format!("UI 目录不存在: {}", ui_dir.display()))?;

    let client = reqwest::Client::builder()
        // 必须显式 no_proxy：本反代只打 127.0.0.1:{backend_port}，绝不能穿系统代理。
        // reqwest 默认 auto_sys_proxy 会读 Windows 注册表，而 IE 的 ProxyOverride 对回环无效
        // （hyper-util matcher 对 IP 形 host 只查 ips 桶，`127.*` 却被归入 domains 桶）。
        // 漏掉此项时每个 /web/** 请求都会发往代理，代理不可达则挂到 300s 请求超时，
        // 界面表现为「模型列表永远加载中」等全面卡死。
        .no_proxy()
        .connect_timeout(PROXY_CONNECT_TIMEOUT)
        .pool_max_idle_per_host(32)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .context("构建 reqwest client 失败")?;

    let ctx = Arc::new(UiCtx {
        ready_rx,
        backend_port,
        ui_dir: ui_dir.clone(),
        client,
    });

    let router = build_router(ctx.clone());
    let mut make_service = router.into_make_service();

    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0u16))
        .await
        .context("绑定 127.0.0.1:0 失败")?;
    let port = listener.local_addr().context("获取监听端口失败")?.port();

    // accept 循环：WS 升级且命中后端路径 → 裸 TCP 透传；其余交给 axum。
    tauri::async_runtime::spawn(async move {
        loop {
            let (stream, _addr) = match listener.accept().await {
                Ok(v) => v,
                Err(e) => {
                    warn!("accept 失败: {}", e);
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    continue;
                }
            };
            let _ = stream.set_nodelay(true);

            let ctx = ctx.clone();
            // 为每条连接克隆一个 tower service（axum Router）
            let tower_svc = match make_service.call(()).await {
                Ok(s) => s,
                Err(e) => match e {}, // Infallible
            };

            tauri::async_runtime::spawn(async move {
                let svc = service_fn(move |req: hyper::Request<Incoming>| {
                    let ctx = ctx.clone();
                    let mut tower_svc = tower_svc.clone();
                    async move {
                        let path = req.uri().path().to_string();
                        if is_ws_upgrade(req.headers()) && is_backend_path(&path) {
                            // 裸 TCP 透传，不进 axum
                            return proxy_ws_raw(ctx, req).await;
                        }
                        // 普通请求交给 axum Router
                        let req = req.map(Body::new);
                        match tower_svc.call(req).await {
                            Ok(resp) => Ok::<_, std::convert::Infallible>(resp),
                            Err(e) => match e {},
                        }
                    }
                });

                let io = TokioIo::new(stream);
                // 注意：此处 `svc` 由 `hyper::service::service_fn` 构造，
                // 本身已实现 `hyper::service::Service`，**不可**再用
                // `TowerToHyperService` 包装（那是给 tower::Service 用的适配器，
                // 包装后反而不满足 serve_connection 的 trait 约束）。
                if let Err(e) = http1::Builder::new()
                    .serve_connection(io, svc)
                    .with_upgrades()
                    .await
                {
                    debug!("连接处理结束: {}", e);
                }
            });
        }
    });

    Ok(port)
}

// ─── 静态文件工具（保留给测试/回退使用） ──────────────────────────────────────

/// 扩展名 → Content-Type（覆盖 UI 目录出现的全部资源类型）。
#[allow(dead_code)]
pub fn mime_for(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "eot" => "application/vnd.ms-fontobject",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// 安全拼接 UI 相对路径（防路径穿越）。
#[allow(dead_code)]
fn safe_join(ui_dir: &Path, rel: &str) -> Option<PathBuf> {
    let mut out = ui_dir.to_path_buf();
    for seg in Path::new(rel).components() {
        match seg {
            Component::Normal(s) => out.push(s),
            Component::CurDir => {}
            _ => return None,
        }
    }
    let canon = out.canonicalize().ok()?;
    if canon.starts_with(ui_dir) {
        Some(canon)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归护栏（核心）：后端 101 的 `Sec-WebSocket-Accept` 必须被解析出来并回传。
    ///
    /// 这条链路曾经是 Tauri 版「完全无法对话」的根因：代理自造一个不含 Accept 的
    /// 101，WebView2/WKWebView 按 RFC 6455 判定握手失败 → /web/gate 秒断 → 流式
    /// 输出、暂停、插话、队列全部失效。Electron 走裸 socket pipe，浏览器直连不过
    /// 代理，故只有 Tauri 复现。
    #[test]
    fn upstream_accept_header_is_parsed() {
        let head = b"HTTP/1.1 101 Switching Protocols\r\n\
                     Upgrade: websocket\r\n\
                     Connection: Upgrade\r\n\
                     Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\
                     \r\n";
        let (status, headers) = parse_head(head).expect("应能解析后端握手响应");
        assert_eq!(status, 101);

        let accept = headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("sec-websocket-accept"))
            .map(|(_, v)| v.as_str());
        assert_eq!(
            accept,
            Some("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="),
            "Accept 头必须原样保留，缺失会让浏览器直接判握手失败"
        );
    }

    /// 后端拒绝升级时要如实回传状态码，不得伪装成 101。
    /// 伪装会让页面以为连上了，然后卡在永不到达的帧上。
    #[test]
    fn non_101_status_is_detected() {
        let head = b"HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\n\r\n";
        let (status, _) = parse_head(head).expect("应能解析非 101 响应");
        assert_ne!(status, 101);
        assert_eq!(status, 503);
    }

    /// 畸形响应必须返回 None 交由调用方降级，不能 panic（panic=abort 会直接崩进程）。
    #[test]
    fn malformed_head_returns_none() {
        assert!(parse_head(b"").is_none());
        assert!(parse_head(b"garbage\r\n\r\n").is_none());
        assert!(parse_head(b"HTTP/1.1\r\n\r\n").is_none());
    }

    /// `/web/**` 与 `/chat/channel/**` 走后端，其余留给本地静态资源。
    #[test]
    fn backend_paths_are_routed_to_jar() {
        assert!(is_backend_path("/web/gate"));
        assert!(is_backend_path("/web/chat/interrupt"));
        assert!(is_backend_path("/web/chat/steer"));
        assert!(is_backend_path("/chat/channel/abc"));
        assert!(!is_backend_path("/index.html"));
        assert!(!is_backend_path("/js/app-streaming.js"));
    }

    /// 激活 scope 生命周期：只能由绑定置位、整条摘除回落（P0 修复后的架构不变量）。
    /// 旧版用例测的是 set/clear/read 三个便捷接口本身——它们已被删除（旁路入口
    /// 正是「一连远端就整机切走」的复发温床），本用例改为锁住真实写链。
    ///
    /// 【必须持锁】路由表是全局 static，而 cargo test 默认多线程跑用例：两个用例
    /// 交错绑定/摘除/reset 会得到随机失败（CI 上最难查的那类假失败）。
    #[test]
    fn active_scope_lifecycle_is_bound_only() {
        let _g = route_test_guard();
        reset_remote_route();
        // 初始态：无任何激活
        assert_eq!(route_for("/web/chat/projects", None), RouteDecision::Local);

        // 登记不激活（连接 ≠ 切环境）
        register_remote_connection("rc-a", 43121, "Basic Z3dvcms6cGFzcw==".to_string());
        assert_eq!(route_for("/web/chat/projects", None), RouteDecision::Local);

        // 绑定置位：无归属请求跟随激活 scope，凭据正确携带
        assert!(bind_scope("/home/u/remote-proj", Some("rc-a")));
        assert_eq!(
            route_for("/web/chat/projects", None),
            RouteDecision::Remote((43121, "Basic Z3dvcms6cGFzcw==".to_string()))
        );

        // 选中本地工作区 = 激活回落本地（选择即环境）
        assert!(bind_scope("D:\\work\\local-proj", Some("local")));
        assert_eq!(route_for("/web/chat/projects", None), RouteDecision::Local);

        // 整条摘除：连同绑定一起清，不留半死形态（绑着一个已死的隧道）
        assert!(bind_scope("/home/u/remote-proj", Some("rc-a")));
        unregister_remote_connection("rc-a");
        assert_eq!(route_for("/web/chat/projects", None), RouteDecision::Local);
        assert_eq!(
            route_for("/web/chat/send", Some("/home/u/remote-proj")),
            RouteDecision::Local,
            "连接摘除后其工作区绑定必须同时失效"
        );
        reset_remote_route();
    }

    /// 碰全局路由表的用例共用这把锁（cargo test 多线程，不串行就是随机失败）。
    /// 用例 panic 会把锁打成 poisoned：取回内部值继续跑（每个用例开头都 reset，
    /// 全局表不会被破坏性改写），否则一个失败会连带挂掉其余全部。
    fn route_test_guard() -> std::sync::MutexGuard<'static, ()> {
        static GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());
        match GUARD.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// 按工作区分流（用户 2026-10-06 拍板）：本地与远程工作区并存的路由语义。
    /// 逐条锁住五级优先级，尤其第 4 级「带 cwd 但未绑定 = 本地」——这条写错就会
    /// 把本地目录的请求串到远端（跨机串写，最危险的失效形态）。
    #[test]
    fn route_for_splits_by_workspace_scope() {
        let _g = route_test_guard();
        reset_remote_route();
        // 空路由表：一律本地（零回归，与改造前行为一致）
        assert_eq!(route_for("/web/chat/projects", None), RouteDecision::Local);
        assert_eq!(route_for("/web/chat/send", Some("/home/u/proj")), RouteDecision::Local);

        register_remote_connection("rc-a", 41001, "Basic AAA".to_string());
        let remote_a = RouteDecision::Remote((41001, "Basic AAA".to_string()));
        // 【连接 ≠ 切换环境】register 只登记不激活：无归属请求必须仍走本地
        assert_eq!(route_for("/web/chat/projects", None), RouteDecision::Local);

        // 绑定一个远端工作区 + 一个本地工作区（本地 = 不写条目）。
        // 测试内的绑定顺序模拟「用户先选远端，后选本地」：
        // 先选本地（active 保持空）→ 再选远端（active 跟随 rc-a）。
        assert!(bind_scope("D:\\work\\local-proj", Some("local")));
        assert!(bind_scope("/home/u/remote-proj/", Some("rc-a")));
        // 命中远端绑定（尾分隔符/首尾空白必须不影响命中：scope_key 已归一）
        assert_eq!(route_for("/web/chat/send", Some("/home/u/remote-proj")), remote_a);
        assert_eq!(route_for("/web/chat/send", Some("  /home/u/remote-proj/ ")), remote_a);
        // 选中远端工作区后，激活 scope 跟随到该连接（选择即环境）
        assert_eq!(route_for("/web/chat/projects", None), remote_a);
        // 第 4 级：本地目录即使连着远端且激活指向它，也必须回本地
        assert_eq!(route_for("/web/chat/send", Some("D:\\work\\local-proj")), RouteDecision::Local);
        // 选回本地：激活 scope 清空（无归属请求回本地）
        assert!(bind_scope("D:\\work\\local-proj", Some("local")));
        assert_eq!(route_for("/web/chat/projects", None), RouteDecision::Local);
        // 远端目录的 by_cwd 绑定被本地选择覆写前仍命中（本地选择只改 active，
        // 不动远端目录的绑定）：其实 bind(local) 只 remove 同 key，远端绑定仍在。
        assert_eq!(route_for("/web/chat/send", Some("/home/u/remote-proj")), remote_a);
        /* query 混有裸段（无 `=`）时后续 cwd 仍必须能取到。
           【断言必须在这写】此刻 active=None（上一步选了本地）：旧代码 `split_once('=')?`
           在首个裸段处整体放弃 → extract 返 None → 回落 active=None → Local，与修复后的
           remote_a 分叉可辨。放在激活态指向 rc-a 的位置会经 active 兜底得到相同结果，
           变异存活（实测踩过）。 */
        assert_eq!(
            route_for("/web/terminal?debug&cwd=%2Fhome%2Fu%2Fremote-proj", None),
            remote_a,
            "裸段不得阻断后续 cwd 解析（否则 WS 事件流静默落回本地，与 HTTP 分属两端）"
        );
        assert_eq!(
            route_for("/web/gate?replay=1&cwd=%2Fhome%2Fu%2Fremote-proj", None),
            remote_a
        );
        // 再选回远端（后续断言依赖激活态）
        assert!(bind_scope("/home/u/remote-proj", Some("rc-a")));
        // 未绑定的陌生 cwd → 本地（宁可不分流，不可串机）
        assert_eq!(route_for("/web/chat/send", Some("/tmp/unknown")), RouteDecision::Local);
        // WS 面：无法带自定义头，靠 query 的 cwd 分流（terminal 已在拼 ?cwd=）
        assert_eq!(
            route_for("/web/terminal?cwd=%2Fhome%2Fu%2Fremote-proj", None),
            remote_a
        );
        assert_eq!(
            route_for("/web/terminal?cwd=D%3A%5Cwork%5Clocal-proj", None),
            RouteDecision::Local
        );

        // 显式 scope 参数：前端要「本地那份列表」或指定连接时用
        assert_eq!(route_for("/web/chat/projects?__scope=local", None), RouteDecision::Local);
        assert_eq!(
            route_for("/web/chat/projects?__scope=id:rc-a", None),
            remote_a
        );
        // connectionId 含特殊字符经 encodeURIComponent 编码后必须仍能命中
        // （rc-a 形态简单不编码，这里验证编码后的 rc-a 也能命中；未登记 id 编码后
        // 回落常规解析——激活此刻指向 rc-a，所以结果应为 remote_a）
        assert_eq!(
            route_for("/web/chat/projects?__scope=id%3Arc-a", None),
            remote_a
        );
        assert_eq!(
            route_for("/web/chat/projects?__scope=id%3Arc-192.168.1.8%3A22%3Au", None),
            remote_a // 未登记 → 回落常规解析（此刻激活=rc-a）
        );
        // 未知 connectionId 的显式 scope → 回落常规解析（不猜）
        assert_eq!(route_for("/web/chat/projects?__scope=id:nope", None), remote_a);

        // 注销：该连接的绑定一并摘除，激活 scope 清空 → 全本地
        unregister_remote_connection("rc-a");
        assert_eq!(route_for("/web/chat/projects", None), RouteDecision::Local);
        assert_eq!(route_for("/web/chat/send", Some("/home/u/remote-proj")), RouteDecision::Local);
        reset_remote_route();
    }

    /// 【设置面强制本地】连着远端且激活态指向它时，/web/settings/** 也必须回本地：
    /// 设置的权威源在本地（模型镜像经隧道直连推送，不走代理面）。
    #[test]
    fn route_for_settings_always_local() {
        let _g = route_test_guard();
        reset_remote_route();
        register_remote_connection("rc-a", 41001, "Basic AAA".to_string());
        assert!(bind_scope("/home/u/remote-proj", Some("rc-a")));
        let remote_a = RouteDecision::Remote((41001, "Basic AAA".to_string()));
        // 归属/激活都是远端，但设置面必须本地
        assert_eq!(route_for("/web/settings/general", None), RouteDecision::Local);
        assert_eq!(route_for("/web/settings/general/save", None), RouteDecision::Local);
        assert_eq!(route_for("/web/settings/providers", None), RouteDecision::Local);
        // 连显式 scope 也改不了设置面（权威面不得被 scope 参数改道）
        assert_eq!(route_for("/web/settings/general?__scope=id:rc-a", None), RouteDecision::Local);
        // 对比：同条件下非设置面仍走远端（证明不是全量回退）
        assert_eq!(route_for("/web/chat/projects", None), remote_a);
        assert_eq!(route_for("/web/chat/send", Some("/home/u/remote-proj")), remote_a);
        // settings 前缀但非设置接口的兄弟路径不受影响（/web/settingsxxx 不在守卫内）
        assert_eq!(route_for("/web/settingsfoo/x", None), remote_a);
        reset_remote_route();
    }

    /// 多连接并存：两条远端各带各的工作区，互不串线；摘一条不影响另一条。
    #[test]
    fn route_for_supports_multiple_connections() {
        let _g = route_test_guard();
        reset_remote_route();
        register_remote_connection("rc-a", 41001, "Basic AAA".to_string());
        register_remote_connection("rc-b", 41002, "Basic BBB".to_string());
        assert!(bind_scope("/srv/a/work", Some("rc-a")));
        assert!(bind_scope("/srv/b/work", Some("rc-b")));
        assert_eq!(
            route_for("/web/chat/send", Some("/srv/a/work")),
            RouteDecision::Remote((41001, "Basic AAA".to_string()))
        );
        assert_eq!(
            route_for("/web/chat/send", Some("/srv/b/work")),
            RouteDecision::Remote((41002, "Basic BBB".to_string()))
        );
        // 激活 scope 跟随最后一次 bind（这里最后绑的是 rc-b；register 不激活）
        assert_eq!(
            route_for("/web/chat/projects", None),
            RouteDecision::Remote((41002, "Basic BBB".to_string()))
        );

        // 摘除 B：其绑定消失，激活 scope 若指向它则清空，A 的绑定必须存活
        unregister_remote_connection("rc-b");
        assert_eq!(route_for("/web/chat/projects", None), RouteDecision::Local);
        assert_eq!(
            route_for("/web/chat/send", Some("/srv/a/work")),
            RouteDecision::Remote((41001, "Basic AAA".to_string()))
        );
        assert_eq!(route_for("/web/chat/send", Some("/srv/b/work")), RouteDecision::Local);
        reset_remote_route();
    }

    /// 直接播种路由表（仅测试用）：写 by_id 两条 + 按 id 复制出 by_cwd 绑定。
    ///
    /// 为何不走 register/bind_scope：本用例要构造 **WSL Direct 形态两连接共享同一
    /// localPort** 的表（WSL2 localhostForwarding 是 local==remote 同端口，两个发行版
    /// 里的后端挑到同一端口完全可能）。生产路径上那需要两次真实 connect（且端口由
    /// 远端自选），单测里没有会话可用，只能直接写表模拟。
    /// active 置 None：本组用例只测 by_cwd 存活判定，不涉激活语义。
    fn seed_route(conns: &[(&str, u16, &str)], bindings: &[(&str, &str)]) {
        let mut g = REMOTE_ROUTE.write().expect("路由表写锁可用");
        g.active = None;
        g.by_id.clear();
        g.by_cwd.clear();
        for (id, port, auth) in conns {
            g.by_id.insert((*id).to_string(), (*port, (*auth).to_string()));
        }
        for (cwd, id) in bindings {
            let up = g
                .by_id
                .get(*id)
                .cloned()
                .expect("播种的绑定必须指向已播种的连接");
            g.by_cwd.insert(scope_key(cwd), up);
        }
    }

    /// 【方案B / 契约 §1.4】by_cwd 存活判定改按 connectionId 反查（不再是端口集合）。
    ///
    /// 三个场景各钉一条不变量：
    /// ① 常规：两连接各带一个工作区绑定，摘 A 后 A 的绑定删、B 的存活
    ///    （误删 B = 活着的远端工作区被打回本地后端 → 跳机读写）；
    /// ② WSL Direct 端口碰撞：两连接 localPort 相同，摘 A 后该端口仍被 B 持有，
    ///    A 的绑定**也保留**——碰撞时宁可多留不可误删（两连接本就指向同一个可连端口）；
    /// ③ 最后一条也摘掉：端口再无人认领 → 绑定全清（悬空绑定没有任何可连目标，
    ///    留着就是把请求灌进不存在的上游 = 全 502 且无提示）。
    #[test]
    fn unregister_keeps_cwd_bindings_by_connection_id_not_port() {
        let _g = route_test_guard();
        reset_remote_route();

        // ① 常规双连接（不同端口）
        seed_route(
            &[("rc-a", 41001, "Basic AAA"), ("rc-b", 41002, "Basic BBB")],
            &[("/srv/a/work", "rc-a"), ("/srv/b/work", "rc-b")],
        );
        unregister_remote_connection("rc-a");
        assert_eq!(
            route_for("/web/chat/send", Some("/srv/a/work")),
            RouteDecision::Local,
            "被摘连接的工作区绑定必须同时失效（不留半死形态）"
        );
        assert_eq!(
            route_for("/web/chat/send", Some("/srv/b/work")),
            RouteDecision::Remote((41002, "Basic BBB".to_string())),
            "另一条存活连接的绑定必须原样保留（凭据也不能被换成别人的）"
        );
        // 播种时 active 置空，摘除后不得自行置位（register 不激活的不变量）
        assert_eq!(route_for("/web/chat/projects", None), RouteDecision::Local);

        // ② WSL Direct：两连接同一 localPort
        reset_remote_route();
        seed_route(
            &[("rc-wsl-a", 37201, "Basic WA"), ("rc-wsl-b", 37201, "Basic WB")],
            &[("/home/a/wsl", "rc-wsl-a"), ("/home/b/wsl", "rc-wsl-b")],
        );
        unregister_remote_connection("rc-wsl-a");
        assert_eq!(
            route_for("/web/chat/send", Some("/home/b/wsl")),
            RouteDecision::Remote((37201, "Basic WB".to_string())),
            "同端口碰撞时存活连接 B 的绑定必须保留"
        );
        assert_eq!(
            route_for("/web/chat/send", Some("/home/a/wsl")),
            RouteDecision::Remote((37201, "Basic WA".to_string())),
            "同端口碰撞时 A 的绑定宁可多留（端口仍可连，误删会把它打回本地后端）"
        );

        // ③ 最后一条摘除：端口无人认领 → 绑定全清
        unregister_remote_connection("rc-wsl-b");
        assert_eq!(route_for("/web/chat/send", Some("/home/a/wsl")), RouteDecision::Local);
        assert_eq!(route_for("/web/chat/send", Some("/home/b/wsl")), RouteDecision::Local);
        reset_remote_route();
    }

    /// 绑定必须是显式的：未登记的 connectionId 不得建立悬空绑定（返回 false）。
    #[test]
    fn bind_scope_rejects_unknown_connection() {
        let _g = route_test_guard();
        reset_remote_route();
        assert!(!bind_scope("/srv/x/work", Some("rc-nope")), "未登记连接必须拒绑定");
        assert!(!bind_scope("   ", Some("rc-nope")), "空路径必须拒绑定");
        assert!(bind_scope("/srv/x/work", Some("local")), "本地解绑总是幂等成功");
        reset_remote_route();
    }

    /// 【中文路径修复】X-Session-Cwd 头读侧解码：component 语义。
    /// 头值经前端 encodeURIComponent 编码（HTTP 头只允许 ISO-8859-1，原始中文会让
    /// 浏览器直接抛异常、请求发不出去）。错用表单语义（'+'→空格）会破坏 D:\C++proj
    /// 这类路径——两个解码函数的语义差异在此锁死。
    #[test]
    fn percent_decode_component_matches_js_encodeuricomponent() {
        // 中文路径：与 encodeURIComponent 输出严格互逆
        let cjk = "D:\\工作\\项目A";
        let encoded = "D%3A%5C%E5%B7%A5%E4%BD%9C%5C%E9%A1%B9%E7%9B%AEA";
        assert_eq!(percent_decode_component(encoded), cjk);
        // '+' 是字面量（component 语义），不能变成空格
        assert_eq!(percent_decode_component("D%3A%5CC%2B%2Bproj"), "D:\\C++proj");
        assert_eq!(percent_decode_component("D:\\C++proj"), "D:\\C++proj");
        // 对照：表单语义必须仍把 '+' 解成空格（query 通道的既有约定，不得被本次改动破坏）
        assert_eq!(urlpercent_decode("D%3A%5Ca+b"), "D:\\a b");
        assert_eq!(percent_decode_component("D%3A%5Ca+b"), "D:\\a+b");
        // 纯 ASCII 无 '%'：零行为变化
        assert_eq!(percent_decode_component("/home/u/proj"), "/home/u/proj");
        // 目录名本身含 %3A 字样：encodeURIComponent 会二次转义（%3A→%253A），
        // 解码一次还原为 %3A——幂等，不会二次解码
        assert_eq!(percent_decode_component("a%253Ab"), "a%3Ab");
    }

    /// 【中文路径修复】端到端：编码后的头值经解码后必须命中 bind_scope 登记的
    /// 原始中文路径（分流不断链）。这断言的是「解码→归一→查表」整链，而不是
    /// 单函数——错在哪一环都会在这里暴露。
    #[test]
    fn route_for_decodes_percent_encoded_cwd_header_value() {
        let _g = route_test_guard();
        reset_remote_route();
        register_remote_connection("rc-a", 51001, "Bearer t".to_string());
        // 登记的是原始中文路径（bind_scope 走 Tauri IPC，不经 HTTP 头，无编码）
        assert!(bind_scope("D:\\工作\\项目A", Some("rc-a")));
        let remote_a = RouteDecision::Remote((51001, "Bearer t".to_string()));
        // 头值是 encodeURIComponent 后的形态（代理读侧负责还原）
        let encoded = percent_decode_component("D%3A%5C%E5%B7%A5%E4%BD%9C%5C%E9%A1%B9%E7%9B%AEA");
        assert_eq!(route_for("/web/chat/input", Some(encoded.as_str())), remote_a);
        // 纯 ASCII 本地路径不受影响
        assert_eq!(
            route_for("/web/chat/input", Some("D:\\work\\local-proj")),
            RouteDecision::Local
        );
        reset_remote_route();
    }

    /// scope_key 归一口径：尾分隔符、首尾空白、Windows 大小写不敏感、UNC。
    /// 错一位就会「绑定命中不上→静默回本地」，远程工作区看起来像没生效。
    ///
    /// 【特别锁定 POSIX 大小写敏感】桌面与远端同为 Linux 时，`/home/u/Proj` 与
    /// `/home/u/proj` 是两个真实目录；一旦归一合并，选本地会误路由到远端（跳机读写）。
    #[test]
    fn scope_key_normalizes_separators_case_and_trailing() {
        assert_eq!(scope_key("/home/u/proj/"), "/home/u/proj");
        assert_eq!(scope_key("  /home/u/proj  "), "/home/u/proj");
        assert_eq!(scope_key(""), "");
        assert_eq!(scope_key("/"), "");
        // Windows：分隔符统一为正斜杠 + 小写（NTFS 大小写不敏感）
        assert_eq!(scope_key("D:\\Work\\A\\"), "d:/work/a");
        assert_eq!(scope_key("d:/work/a"), "d:/work/a");
        assert_eq!(scope_key("\\\\fs\\share\\p"), "//fs/share/p");
        // POSIX：保留大小写（两个不存在的目录，不得归一到同一个键）
        assert_ne!(scope_key("/home/u/Proj"), scope_key("/home/u/proj"));
        // 本地 Windows 路径与远端 POSIX 路径不得碰撞
        assert_ne!(scope_key("D:\\work\\a"), scope_key("/work/a"));
    }

    /// 分流端到端：同一台 Linux 桌面上，只差大小的本地/远端目录必须各自归位。
    /// （直接测 bind+route_for，而不是只测 scope_key：归一逻辑与查表逻辑得一起对）
    #[test]
    fn route_for_keeps_posix_case_distinct() {
        let _g = route_test_guard();
        reset_remote_route();
        register_remote_connection("rc-a", 41001, "Basic AAA".to_string());
        assert!(bind_scope("/home/u/proj", Some("rc-a")));
        let remote_a = RouteDecision::Remote((41001, "Basic AAA".to_string()));
        assert_eq!(route_for("/web/chat/send", Some("/home/u/proj")), remote_a);
        // 只差一个字母大小写的本地同名目录：必须回本地，不能被误绑到远端
        assert_eq!(route_for("/web/chat/send", Some("/home/u/Proj")), RouteDecision::Local);
        reset_remote_route();
    }

    /// 【P0 回归】激活 scope 指向远端时，三类「必须回本地」的请求仍必须落本地端口。
    /// 这条测的是 route_for 与本地端口解析**串起来之后**的最终上游，而不是分流结论
    /// 本身——上一轮的缺陷恰恰是「route_for 判对了 Local，resolve_upstream 又把
    /// 它拽回远端」，所以只测 route_for 的既有用例全绿也拦不住（绿色假象）。
    #[test]
    fn upstream_for_never_leaks_local_decisions_into_active_remote() {
        let _g = route_test_guard();
        reset_remote_route();
        const LOCAL: u16 = 45123;

        register_remote_connection("rc-a", 41001, "Basic AAA".to_string());
        // 选中远端工作区 → active 指向该连接（bind_scope 是唯一置位路径）
        assert!(bind_scope("/home/u/remote-proj", Some("rc-a")));
        let remote_a = Some((41001u16, Some("Basic AAA".to_string())));

        // ① 归属远端目录 → 远端（正向，保证这条链路本身是通的）
        assert_eq!(
            upstream_for("/web/chat/send", Some("/home/u/remote-proj"), LOCAL),
            remote_a
        );
        // ② 无归属请求跟随激活 scope（远端）——这是设计如此，不是泄漏
        assert_eq!(upstream_for("/web/chat/projects", None, LOCAL), remote_a);

        // ③ 显式强制本地：双拉合并里「本地那份列表」全靠它，回读覆盖会让本地
        //    项目从下拉里消失（= 用户投诉的「远程覆盖本地」）
        assert_eq!(
            upstream_for("/web/chat/projects?__scope=local", None, LOCAL),
            Some((LOCAL, None))
        );
        // ④ 设置面恒本地：否则连着远端改设置写进远端内存，本地权威配置被绕过
        assert_eq!(
            upstream_for("/web/settings/general", None, LOCAL),
            Some((LOCAL, None))
        );
        assert_eq!(
            upstream_for("/web/settings/llm/models/default", None, LOCAL),
            Some((LOCAL, None))
        );
        // ⑤ 带明确归属但未绑定 = 本地目录（跳机读写方向）
        assert_eq!(
            upstream_for("/web/chat/send", Some("D:\\work\\local-proj"), LOCAL),
            Some((LOCAL, None))
        );
        // ⑥ 本地端口未就绪 + 判本地 → None（走 503/宽限重试，绝不回落远端）
        assert_eq!(upstream_for("/web/chat/projects?__scope=local", None, 0), None);
        // ⑦ 判远端时不依赖本地端口（本地后端未起也能用远端）
        assert_eq!(upstream_for("/web/chat/send", Some("/home/u/remote-proj"), 0), remote_a);

        reset_remote_route();
        // 空路由表：一律本地，且本地端口 0 时 None（与改造前一致）
        assert_eq!(upstream_for("/web/chat/projects", None, LOCAL), Some((LOCAL, None)));
        assert_eq!(upstream_for("/web/chat/projects", None, 0), None);
    }

    /// 源码契约（变异验证补口）：proxy_http / proxy_ws_raw 必须把远端凭据注入
    /// 上游请求。变异抽验发现只测读写函数本身会漏——删掉注入代码它照样绿
    /// （SURVIVED）——所以锁源码结构。
    /// 断言陷阱（变异验实证砸两轮）：include_str 会把本测试自己的字面量也计入；
    /// 连注释里的代码示例都会被 contains 命中。故锚点全部拼接构造，且注释中
    /// 不得出现目标子串的完整形态。
    #[test]
    fn proxy_functions_inject_authorization_from_override() {
        let src = include_str!("server.rs");
        // HTTP 面：注入（拼接锚点避免自匹配）
        let http_inject_anchor = [
            "out_headers.",
            "insert(header::AUTH",
            "ORIZATION, v)",
        ]
        .concat();
        assert!(src.contains(&http_inject_anchor),
            "proxy_http 必须把覆盖凭据写入上游 Authorization");
        // HTTP/WS 两面：客户端自带 Authorization 剔除（防旧凭据残留）
        assert!(src.matches("eq_ignore_ascii_case(\"authorization\")").count() >= 2,
            "proxy_http 与 proxy_ws_raw 都必须剔除客户端自带 Authorization");
        // WS 面：注入（同样拼接）
        let ws_inject_anchor = [
            "raw.push_str(&format!(\"Autho",
            "rization: {}\\r\\n\", auth))",
        ].concat();
        assert!(src.contains(&ws_inject_anchor),
            "proxy_ws_raw 必须把覆盖凭据写进重建的升级请求头");
        // 两处代理入口必须走同一个上游决策入口（按工作区分流）。
        // 两面必须同构：否则会出现「会话 HTTP 打到远端、它的 WS 仍连本地」的跳机聊。
        // 锚点取函数体特征行而非裸函数名：include_str 会把本测试自己的断言文本也计入
        // 子串计数（首轮断言 count==2 实得 3，把自己数进去了——变异验证同款坑）。
        //
        // 【契约随架构升级（P0 修复）】上一版契约强制 proxy_http/proxy_ws_raw 自己直调
        // route_for，并把「本地解析函数必须优先读激活覆盖」也写成硬断言——两条合起来
        // 恰好把缺陷锁死：route_for 判出 Local 后，下一跳又被覆盖读回远端。现在收敛为
        // 单一决策函数（upstream_for），两面共用，不可能再一面修好、另一面漂移。
        let decision_anchor = ["upstream_", "for("].concat();
        let proxy_http_seg = src
            .split("async fn proxy_http")
            .nth(1)
            .and_then(|s| s.split("async fn ").next())
            .expect("proxy_http 函数体必须存在");
        let proxy_ws_seg = src
            .split("async fn proxy_ws_raw")
            .nth(1)
            .and_then(|s| s.split("async fn ").next())
            .expect("proxy_ws_raw 函数体必须存在");
        for (name, seg) in [("proxy_http", proxy_http_seg), ("proxy_ws_raw", proxy_ws_seg)] {
            assert!(seg.contains(&decision_anchor),
                "{} 必须经唯一决策入口取上游（两面同构分流）", name);
            // 代理体内不得自己探覆盖值/自己分流，否则又出现第二个真相源
            let own_override_anchor = ["remote_", "override("].concat();
            assert!(!seg.contains(&own_override_anchor),
                "{} 不得自己读激活覆盖（覆盖只能由 route_for 第 6 级消费）", name);
            // 【变异验证发现的盲区】只禁上面那种写法不够：直接读路由表同样能造出
            // 第二个真相源（实测该变异存活），而表名与函数名不同形。路由表只能由
            // route_for / bind / register / unregister 这几处读写。
            let table_anchor = ["REMOTE_", "ROUTE"].concat();
            assert!(!seg.contains(&table_anchor),
                "{} 不得直接碰路由表（分流结论唯一入口是决策函数，否则又一处真相源）", name);
        }
        // route_for 必须兜底读激活 scope（无归属信息的列表类请求依此工作）
        let route_seg = src
            .split("fn route_for")
            .nth(1)
            .and_then(|s| s.split("/// 从 query 里取 cwd").next())
            .expect("route_for 函数体必须存在");
        assert!(route_seg.contains("g.active"), "route_for 必须兜底激活 scope");
        assert!(route_seg.contains("by_cwd"), "route_for 必须按工作区绑定分流");
        // 【反向硬断言】决策函数的本地分支绝不得回读覆盖——这是 P0 的根因
        // （route_for 判出 Local 后又被覆盖拽回远端）。旧契约在此写的正是相反的
        // 期望（强制本地端口解析函数必须优先读覆盖），等于把缺陷锁死，故同步翻转。
        let forbidden = ["remote_", "override"].concat();
        let decision_seg = src
            .split("fn upstream_for(")
            .nth(1)
            .and_then(|s| s.split("\n}\n").next())
            .expect("唯一决策函数必须存在");
        assert!(
            decision_seg.contains("route_for("),
            "决策函数必须以 route_for 为分流结论"
        );
        assert!(
            !decision_seg.contains(&forbidden),
            "决策函数的本地分支不得回读激活覆盖"
        );
        // 旁路激活入口必须真的从源码里消失（不只是「没人调」）：否则下一个调用点
        // 又能绕开 bind_scope 直写 active，重演「一连远端就整机切走」。
        // 锚点拼接构造，避开本测试自身字面量与已删除说明注释的自匹配。
        let bypass_set = ["pub fn set_", "remote_override(", "port: {}"]
            .concat()
            .replace("port: {}", "");
        assert!(
            !src.contains(&bypass_set),
            "不得保留绕开绑定的便捷激活入口"
        );
    }

    /// 代理入口必须把**实时**本地端口当作参数交给唯一决策入口（而不是缓存一份旧端口，
    /// 更不是自己先读本地后端再分流——两种写反都会把远端工作区的请求串到本地）。
    /// 旧版的独立本地端口解析函数已内进 `upstream_for`，因此这里只锁调用点结构。
    #[test]
    fn proxy_entries_pass_live_local_port_into_decision() {
        let src = include_str!("server.rs");
        let getter = ["ctx.", "backend_port()"].concat();
        let call = ["upstream_for(", "&path_q"].concat();
        for name in ["proxy_http", "proxy_ws_raw"] {
            let seg = src
                .split(&format!("async fn {}", name))
                .nth(1)
                .and_then(|s| s.split("async fn ").next())
                .unwrap_or("");
            let ci = match seg.find(&call) {
                Some(i) => i,
                None => panic!("{} 必须调唯一决策入口", name),
            };
            // 取该调用语句本身（到行尾）：本地端口必须就在这个语句里作为实参出现
            let stmt_end = seg[ci..].find('\n').map(|n| ci + n).unwrap_or(seg.len());
            let stmt = &seg[ci..stmt_end];
            assert!(
                stmt.contains(&getter),
                "{} 必须把实时本地端口（而非缓存值）作为实参传给决策入口，实参行：{}",
                name,
                stmt.trim()
            );
        }
    }

    /// 升级请求识别：大小写与 `Connection: keep-alive, Upgrade` 复合值都要覆盖。
    #[test]
    fn ws_upgrade_detection_is_case_insensitive() {
        let mut h = HeaderMap::new();
        h.insert(header::UPGRADE, HeaderValue::from_static("WebSocket"));
        h.insert(
            header::CONNECTION,
            HeaderValue::from_static("keep-alive, Upgrade"),
        );
        assert!(is_ws_upgrade(&h));

        let mut plain = HeaderMap::new();
        plain.insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
        assert!(!is_ws_upgrade(&plain));
    }

    /// 握手响应头之后的残留字节必须被切出来（后端常把 101 与首帧一起发出）。
    /// 丢了它 = 会话第一个 chunk 永久消失。
    #[tokio::test]
    async fn leftover_frames_after_head_are_preserved() {
        use tokio::io::AsyncWriteExt as _;

        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            s.write_all(
                b"HTTP/1.1 101 Switching Protocols\r\n\
                  Upgrade: websocket\r\n\
                  Sec-WebSocket-Accept: abc=\r\n\
                  \r\nFIRSTFRAME",
            )
            .await
            .unwrap();
        });

        let mut client = TcpStream::connect(addr).await.unwrap();
        let (head, leftover) = read_upstream_head(&mut client).await.unwrap();

        let (status, _) = parse_head(&head).unwrap();
        assert_eq!(status, 101);
        assert_eq!(
            leftover, b"FIRSTFRAME",
            "101 之后同批到达的帧必须保留并补写给页面"
        );
    }

    /// 回归护栏：请求体必须**流式**转发，不得整体缓冲。
    ///
    /// 曾经这里是 `to_bytes(body, usize::MAX)`，附件上传（WebGate.chat_input 收
    /// UploadedFile[]）会把整个文件读进内存才转发：N 字节文件 = N 字节堆尖峰，
    /// 且后端要等上传全部结束才看到第一个字节。Electron 版 `req.pipe(upstream)`
    /// 一直是流式的，只有 Tauri 版退化过。
    ///
    /// 测试手法：客户端只发一半 body 就停住，若代理仍在缓冲，后端永远拿不到字节，
    /// 此处 5s 超时失败；只有真正流式，后端才能在客户端发完前收到数据。
    /// 顺带断言分帧未被改写成 chunked——后端 multipart 解析依赖定长编码。
    #[tokio::test]
    async fn request_body_is_streamed_not_buffered() {
        use std::net::Ipv4Addr;
        use tokio::io::AsyncWriteExt as _;

        // ── 伪后端：模拟 jar，边收边报告 ──────────────────────────────────
        let backend = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let backend_port = backend.local_addr().unwrap().port();

        let (first_tx, first_rx) = tokio::sync::oneshot::channel::<Vec<u8>>();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<(usize, bool)>();

        tokio::spawn(async move {
            let (mut s, _) = backend.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 8192];

            // 读完请求头
            let head_end = loop {
                let n = s.read(&mut chunk).await.unwrap();
                if n == 0 {
                    return;
                }
                buf.extend_from_slice(&chunk[..n]);
                if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break p + 4;
                }
            };
            let head = String::from_utf8_lossy(&buf[..head_end]).to_ascii_lowercase();
            let is_chunked = head.contains("transfer-encoding: chunked");
            let content_len = head
                .split("\r\n")
                .find_map(|l| l.strip_prefix("content-length:"))
                .and_then(|v| v.trim().parse::<usize>().ok())
                .unwrap_or(0);

            // 攒够第一批 body 字节就立刻上报（缓冲实现下这一步永远等不到）
            let mut body = buf[head_end..].to_vec();
            while body.is_empty() {
                let n = s.read(&mut chunk).await.unwrap();
                if n == 0 {
                    return;
                }
                body.extend_from_slice(&chunk[..n]);
            }
            let _ = first_tx.send(body.clone());

            while body.len() < content_len {
                let n = s.read(&mut chunk).await.unwrap();
                if n == 0 {
                    break;
                }
                body.extend_from_slice(&chunk[..n]);
            }
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                .await
                .unwrap();
            let _ = done_tx.send((body.len(), !is_chunked));
        });

        // ── 被测代理 ────────────────────────────────────────────────────
        let (_ready_tx, ready_rx) = watch::channel(true);
        let ctx = Arc::new(UiCtx {
            ready_rx,
            backend_port: Arc::new(std::sync::Mutex::new(backend_port)),
            ui_dir: std::env::temp_dir(),
            client: reqwest::Client::new(),
        });
        let proxy = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let proxy_port = proxy.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = axum::serve(proxy, build_router(ctx).into_make_service()).await;
        });

        // ── 客户端：先发一半，故意停住 ──────────────────────────────────
        const HALF: usize = 32 * 1024;
        let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, proxy_port))
            .await
            .unwrap();
        client
            .write_all(
                format!(
                    "POST /web/chat/input HTTP/1.1\r\nHost: x\r\n\
                     Content-Type: application/octet-stream\r\n\
                     Content-Length: {}\r\n\r\n",
                    HALF * 2
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        client.write_all(&vec![b'A'; HALF]).await.unwrap();

        let first = tokio::time::timeout(Duration::from_secs(5), first_rx)
            .await
            .expect("后端在客户端发完前没收到任何字节 —— 请求体又被整体缓冲了")
            .unwrap();
        assert!(
            first.iter().all(|b| *b == b'A'),
            "先到的必须是首批字节"
        );

        // 补发后一半，验证完整性
        client.write_all(&vec![b'B'; HALF]).await.unwrap();
        let (received, definite_length) = tokio::time::timeout(Duration::from_secs(5), done_rx)
            .await
            .expect("后端未能收齐请求体")
            .unwrap();
        assert_eq!(received, HALF * 2, "请求体必须完整抵达后端");
        assert!(
            definite_length,
            "Content-Length 必须原样转发，改写成 chunked 会打断后端 multipart 解析"
        );
    }

    /// 后端握手前断开时返回 Err 而非挂死，调用方据此回 503。
    #[tokio::test]
    async fn upstream_closing_before_handshake_errors() {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            let (s, _) = listener.accept().await.unwrap();
            drop(s);
        });

        let mut client = TcpStream::connect(addr).await.unwrap();
        assert!(read_upstream_head(&mut client).await.is_err());
    }
}
