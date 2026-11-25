//! device_link — 设备中转：登录后经 WSS 常连官方后台，把同账号手机的请求
//! 转发给本地内核，并把内核响应与流帧回传（契约：.gwork/mobile-link/PROTOCOL.md）。
//!
//! ## 拓扑
//! ```text
//! 手机 ──WS──> 官方后台 ──WS(/api/gwork/device/link)──> 本模块 ──HTTP──> 127.0.0.1:<kernel_port>
//!                │                                        └──WS(/web/gate?sessionId=)──> 内核流帧
//!                └─ frame 信封广播给同账号同设备的所有移动连接
//! ```
//!
//! ## 关键纪律
//! - 后台是无状态转发器：本模块只做「信封 ⇄ 内核 HTTP/WS」的机械翻译，
//!   不理解业务帧；path 白名单由后台强制（§2.1），设备侧再校验一次纵深防御。
//! - 转发一律打 `127.0.0.1:<port>`，带内核 Basic Auth（若配置）；不透传
//!   移动端任何头（除 percent-encode 后的 `X-Session-Cwd`，§5）。
//! - token 只走 query（§0/§5）；日志绝不打印 token / 含 token 的 URL。
//! - 连接循环复用 core 的 `Backoff`（纯状态机、可单测）；401 先强制 refresh
//!   再重试；会话终结错误停止（auth keeper 也会兜底 stop）。
//! - 每 25s 应用层 `{"type":"ping"}`，60s 无帧判死重连（§2.4）；协议层
//!   Ping 由 tungstenite 自动回 Pong，这里也显式处理以防库行为差异。
//! - gate 订阅按 sessionId 一条内核 WS，`done`/`error` 帧后保留 60s 再关
//!   （迟续帧，§2.3）；后台重连后清空订阅表，移动端靠 replay 补帧。
//!
//! ## 生命周期
//! `start(app)` 幂等（进程级 OnceLock<Mutex<Option<Handle>>>）：
//! auth_login / auth_register 命令尾部、restore() 成功后调用；
//! `stop()`：auth_logout、keeper 判定会话终结、本模块自身拿到终结错误。
//! - 启动任务先等 `AppState.kernel_ready`（内核健康探针通过才转发）；
//!   backend_ready watch 只作快速唤醒，atomic 轮询兜底，避免广播丢失时卡死。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use gourd_work_core::channels::runner::Backoff;
use gourd_work_core::channels::transport::{WsMsg, WsPair, WsTransport};

// ─── 常量（契约值）───────────────────────────────────────────────────────────

/// §2.4：设备每 25s 发应用层 ping。
const PING_INTERVAL: Duration = Duration::from_secs(25);
/// §2.4：60s 未收到任何帧判死重连。
const FRAME_DEAD_TIMEOUT: Duration = Duration::from_secs(60);
/// §2.2：内核请求 30s 超时回 502 信封。
const KERNEL_REQ_TIMEOUT: Duration = Duration::from_secs(30);
/// §2.3：done/error 帧后保留 gate 订阅 60s（迟续帧）。
const GATE_LINGER: Duration = Duration::from_secs(60);
/// WS 握手超时（与 core transport 同口径）。
const WS_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// gate 断线后的重连间隔（订阅存续期内）。
const GATE_RETRY_INTERVAL: Duration = Duration::from_secs(2);
/// 重连退避：1s 起 ×2 封顶 60s。
const BACKOFF_BASE: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(60);

/// §2.1 path 白名单（后台强制校验；设备侧再校验一次，防旧版/被改写的后台）。
const ALLOWED_PATHS: &[&str] = &[
    "/web/chat/meta",
    "/web/chat/sessions",
    "/web/chat/messages",
    "/web/chat/replay",
    "/web/chat/input",
    "/web/chat/interrupt",
    "/web/chat/models",
    "/web/chat/models/select",
    "/web/chat/thinking/select",
    "/web/chat/context/select",
    "/web/chat/access/select",
    "/web/chat/todos",
    "/web/chat/pendingQuestion",
    "/web/chat/sessions/delete",
    "/web/chat/sessions/rename",
    "/web/chat/projects",
    // v1.1：技能/连接器选择器与附件缩略图回显。刻意不含 attachment/upload——
    // multipart 过不了字符串信封，移动端附件走 /web/chat/input 内联 base64。
    "/web/chat/mcp/select",
    "/web/chat/attachment/meta",
    // v1.2：会话产物流（移动端「全部产物」弹层与桌面任务监控「产出」区同源）。
    // changes/session 是只读的跨 run 合并清单；filer/read 用于产物文本详情预览。
    // 刻意不含 changes/undo/*、changes/reapply/*、filer/write：移动端不提供任何
    // 改写产物的入口；也刻意不含 filer/raw——它是字节流端点（Java `ctx.output(bytes)`，
    // 二进制过不了字符串信封），且 `resolveForRaw` 允许 50MB，放行只有流量与内存风险，
    // 而移动端详情对图片走「请在桌面端查看」（见 app-artifact-sheet.openDetail）。
    // filer/read 另受 ROOT_SCOPED_PATHS 的 root 闸门约束（见 query_root_of/root_scope_allowed）。
    "/web/chat/changes/session",
    "/web/chat/filer/read",
    "/web/settings/skills/installed",
    "/web/settings/mcp/servers",
];

/// 需要额外校验 `root` 查询参数的路径（在 ALLOWED_PATHS 之外的第二道闸门）。
///
/// **Why this exists**：内核 `filer/read` 的契约是「`path` 必须落在 `root` 之内」，
/// 而 `root` 本身**由调用方任意给出**（`FileService.resolveRoot` 只做
/// `toAbsolutePath().normalize()`，不做注册校验；Rust `effective_root` 只要求绝对路径）。
/// 也就是说 `root=C:\Users\me&path=.ssh/id_rsa` 能读到任意文件。桌面端可以直接这样做
/// 是因为请求就发在用户自己的本机环回口上；但一旦这条路径进了设备链路白名单，
/// 任何持有效移动端 token 的调用方（或被改写的后台）就获得了**远程任意文件读取**。
/// 设备侧因此要求：`root` 要么为空（→ 内核自身 workspace），要么等于
/// `projects.json` 里注册过的项目根——与移动端 UI 的唯一来源（/web/chat/projects）同口径。
const ROOT_SCOPED_PATHS: &[&str] = &[
    "/web/chat/filer/read",
    "/web/chat/filer/raw",
    "/web/chat/changes/session",
];

/// 从 query 串里取 `root` 参数（percent-decode 后 trim）。无该键返回 None。
///
/// 注意 `root=`（空值）与「没有 root 键」都表示「用内核自身 workspace」，两者都放行；
/// 只有非空值才进注册校验。
pub(crate) fn query_root_of(query: &str) -> Option<String> {
    for pair in query.trim_start_matches('?').split('&') {
        let mut kv = pair.splitn(2, '=');
        if kv.next() == Some("root") {
            let raw = kv.next().unwrap_or("");
            return Some(percent_decode(raw).trim().to_string());
        }
    }
    None
}

/// 路径归一化比较（`normalize_path` 消掉 `.`/`..`/相对前缀，Windows 再忽略大小写与尾分隔符）。
fn same_root_path(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        let n = gourd_work_core::projects::normalize_path(std::path::Path::new(s));
        let n = n.to_string_lossy().trim_end_matches(['/', '\\']).to_string();
        if cfg!(windows) { n.to_lowercase() } else { n }
    };
    norm(a) == norm(b)
}

/// root 闸门：空 → 放行（内核 workspace）；非空 → 必须是 `projects.json` 注册的项目根。
///
/// **性能取舍**：`load_projects()` 每次都读一遍 `projects.json`（几 KB 的小文件）。
/// 这里刻意不缓存：注册表随时会被桌面端增删项目，缓存就得处理失效，而这条路径
/// 只由用户主动点产物卡片/打开弹层触发（不是轮询、不是每帧），一次小文件同步读
/// 的代价远小于「用了过期白名单把合法根拒掉」或「放过已移除的根」的风险。
/// 若将来这里被改成高频调用，再引入带 mtime 校验的缓存。
pub(crate) fn root_scope_allowed(root: &str) -> bool {
    let trimmed = root.trim();
    if trimmed.is_empty() {
        return true;
    }
    gourd_work_core::projects::load_projects()
        .iter()
        .any(|p| !p.path.trim().is_empty() && same_root_path(&p.path, trimmed))
}

// ─── 信封（§2）───────────────────────────────────────────────────────────────

/// 后台 → 设备的请求信封（§2.1）。`from` 只作路由标识，设备侧不回传。
#[derive(Debug, Clone, serde::Deserialize)]
pub(crate) struct ReqEnvelope {
    #[serde(rename = "reqId", default)]
    pub req_id: String,
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub body: String,
    #[serde(rename = "contentType", default)]
    pub content_type: String,
}

/// 设备 → 后台的 HTTP 响应信封（§2.2）。
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub(crate) struct ResEnvelope {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "reqId")]
    pub req_id: String,
    pub status: u16,
    pub body: String,
}

impl ResEnvelope {
    pub fn new(req_id: impl Into<String>, status: u16, body: impl Into<String>) -> Self {
        Self { kind: "res".into(), req_id: req_id.into(), status, body: body.into() }
    }
}

/// §2.2：内核不可达/超时的固定 502 信封。
pub(crate) fn kernel_unreachable_res(req_id: &str) -> ResEnvelope {
    ResEnvelope::new(
        req_id,
        502,
        r#"{"code":502,"description":"kernel unreachable"}"#,
    )
}

/// §2.1 白名单外的请求直接拒（res status=403），不转发（§5）。
fn forbidden_res(req_id: &str) -> ResEnvelope {
    ResEnvelope::new(
        req_id,
        403,
        r#"{"code":403,"description":"path not allowed"}"#,
    )
}

/// 后台 → 设备的入站信封分类。未知类型忽略（向前兼容）。
#[derive(Debug)]
pub(crate) enum Incoming {
    Req(ReqEnvelope),
    Ping,
    Pong,
    Other,
}

pub(crate) fn parse_incoming(text: &str) -> Incoming {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return Incoming::Other;
    };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("req") => match serde_json::from_value::<ReqEnvelope>(v) {
            // reqId/path 缺失的畸形 req 不受理（无法回 res / 无法路由）。
            Ok(r) if !r.req_id.is_empty() && !r.path.is_empty() => Incoming::Req(r),
            _ => Incoming::Other,
        },
        Some("ping") => Incoming::Ping,
        Some("pong") => Incoming::Pong,
        _ => Incoming::Other,
    }
}

/// §2.3：把内核 gate 的每一帧原文包进 frame 信封。
pub(crate) fn frame_envelope(session_id: &str, payload: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "type": "frame", "sessionId": session_id, "payload": payload })
}

/// §4：`POST /web/chat/input` 成功响应 `data:{sessionId}`；忙时 `data:"busy"`
/// （字符串，不订阅）。请求自带 sessionId 时由调用方另行 ensure。
pub(crate) fn input_session_from_res(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    if v.get("code").and_then(|c| c.as_u64()) != Some(200) {
        return None;
    }
    let sid = v.get("data")?.get("sessionId")?.as_str()?.trim();
    if sid.is_empty() || !valid_session_id(sid) {
        return None;
    }
    Some(sid.to_string())
}

/// query 串里的 sessionId（percent-decode 后 trim）。无该键返回 None。
///
/// 【为什么 GET 也要取 · 2026-11-24 用户报障「移动端看运行中任务一直卡住不动」】
/// 移动端打开会话走 `GET /web/chat/replay?sessionId=…`（body 恒空），旧实现只认
/// POST body 里的 sessionId → 手机查看他端（PC）发起的运行中任务时，gate 订阅
/// 从未建立，内核流帧（含 done/error）一帧都到不了手机：占位永久「思考中」。
/// 白名单内的会话级 GET（replay/messages/pendingQuestion 等）同样要 ensure。
pub(crate) fn query_session_of(query: &str) -> Option<String> {
    for pair in query.trim_start_matches('?').split('&') {
        let mut kv = pair.splitn(2, '=');
        if kv.next() == Some("sessionId") {
            let raw = kv.next().unwrap_or("");
            let sid = percent_decode(raw).trim().to_string();
            if !sid.is_empty() && valid_session_id(&sid) {
                return Some(sid);
            }
            return None;
        }
    }
    None
}

/// 请求体里自带的 sessionId（续聊场景：input/interrupt 等都带）。
fn session_from_req_body(req: &ReqEnvelope) -> Option<String> {
    if req.content_type.contains("json") {
        let v: serde_json::Value = serde_json::from_str(&req.body).ok()?;
        let sid = v.get("sessionId")?.as_str()?.trim();
        if !sid.is_empty() && valid_session_id(sid) {
            return Some(sid.to_string());
        }
        return None;
    }
    // form：sessionId=...&runId=...
    for pair in req.body.split('&') {
        let mut kv = pair.splitn(2, '=');
        if kv.next() == Some("sessionId") {
            let raw = kv.next().unwrap_or("");
            let sid = percent_decode(raw).trim().to_string();
            if !sid.is_empty() && valid_session_id(&sid) {
                return Some(sid);
            }
        }
    }
    None
}

/// sessionId 合法性（与内核 SessionStore::is_valid_id 同口径的保守子集）。
fn valid_session_id(sid: &str) -> bool {
    !sid.is_empty()
        && sid.len() <= 128
        && !sid.contains("..")
        && !sid.contains('/')
        && !sid.contains('\\')
        && !sid.chars().any(|c| c.is_control() || c.is_whitespace())
}

// ─── percent 编解码（手写 UTF-8，与内核 server/mod.rs::percent_decode 互逆）───

/// RFC 3986 unreserved 之外全部按 UTF-8 字节百分号编码。
/// `X-Session-Cwd` 契约：percent-encoded 绝对路径原文上桥（内核侧解码一次）。
pub(crate) fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// 与内核一致的宽松解码：非法转义原样透传，'+' 还原为空格（form 兼容）。
pub(crate) fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(h), Some(l)) = (hi, lo) {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

// ─── 设备身份（§1.1）─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub(crate) struct DeviceIdentity {
    #[serde(rename = "deviceId")]
    pub device_id: String,
}

/// 读或建 `<home>/device.json`。写入失败（只读 home 等）仍返回内存 id：
/// 本次连接可用，下次启动会重新生成 —— 可接受的降级，不值得为此拒绝登录。
pub(crate) fn load_or_create_identity_at(path: &std::path::Path) -> DeviceIdentity {
    if let Ok(raw) = std::fs::read_to_string(path) {
        if let Ok(id) = serde_json::from_str::<DeviceIdentity>(&raw) {
            if id.device_id.starts_with("dev-") && id.device_id.len() > 4 {
                return id;
            }
        }
    }
    let uuid8: String = uuid::Uuid::new_v4()
        .simple()
        .to_string()
        .chars()
        .take(8)
        .collect();
    let id = DeviceIdentity { device_id: format!("dev-{}", uuid8) };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(&id) {
        if let Err(e) = std::fs::write(path, json) {
            warn!(error = %e, "device.json write failed; identity is volatile this run");
        }
    }
    id
}

fn load_or_create_identity() -> DeviceIdentity {
    load_or_create_identity_at(
        &gourd_work_core::config::Settings::gwork_home().join("device.json"),
    )
}

/// 主机名：env COMPUTERNAME（Windows）/ HOSTNAME（Unix）+ fallback。
/// 不引 hostname crate（任务约束：别引新 crate）。
pub(crate) fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "GWork Desktop".to_string())
}

/// §1.1：platform = windows|macos|linux。
pub(crate) fn device_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        _ => "linux",
    }
}

pub(crate) fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// 判断 `http://` 之后的 `host[:port][/path]` 是否指向本机回环。
///
/// 明文 `ws://` 只在开发态（内核/后台都在 127.0.0.1）成立；对外部主机必须用
/// https，否则 query 里的会话 token 会在网络上明文传输（见 `link_url`）。
pub(crate) fn is_loopback_host(host_and_rest: &str) -> bool {
    let authority = host_and_rest.split('/').next().unwrap_or("");
    // Strip the port, keeping IPv6 brackets intact: `[::1]:3000` → `[::1]`.
    let host = if let Some(rest) = authority.strip_prefix('[') {
        match rest.split_once(']') {
            Some((inner, _)) => inner,
            None => return false,
        }
    } else {
        authority.split(':').next().unwrap_or("")
    };
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

/// §2：`{base}/api/gwork/device/link?token=..&deviceId=..&name=..&platform=..&appVersion=..`
/// host http→ws / https→wss。
///
/// **明文 `ws://` 只允许回环**：token 走 query（H5 无法设 WS header），若把
/// `http://` 基址无条件下折成 `ws://`，任何自建或经环境变量改成 http 的部署都会
/// 把会话凭据明文发到网络上。开发态 loopback 基址（127.0.0.1/localhost/[::1]）
/// 仍然映射成 `ws://`，其余一律拒绝并要求 https。
pub(crate) fn link_url(
    base: &str,
    token: &str,
    id: &DeviceIdentity,
    name: &str,
    platform: &str,
    version: &str,
) -> Result<String, String> {
    let base = base.trim_end_matches('/');
    let ws_base = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{}", rest)
    } else if let Some(rest) = base.strip_prefix("http://") {
        if !is_loopback_host(rest) {
            return Err(format!(
                "refusing plaintext ws:// for non-loopback account base (use https): {}",
                base
            ));
        }
        format!("ws://{}", rest)
    } else {
        return Err(format!("account base has no http(s) scheme: {}", base));
    };
    Ok(format!(
        "{}/api/gwork/device/link?token={}&deviceId={}&name={}&platform={}&appVersion={}",
        ws_base,
        percent_encode(token),
        percent_encode(&id.device_id),
        percent_encode(name),
        percent_encode(platform),
        percent_encode(version),
    ))
}

// ─── 内核 Basic Auth（guard.rs 契约：env 注入优先，其次 settings.json）────────

/// 读本地 settings.json 拿 webAuthUser/webAuthPass（桌面与内核同机同 home）。
/// 解析失败视为无鉴权（与内核「半配置=未启用」口径一致，绝不因此拒绝转发）。
/// `GWORK_WEB_AUTH` 注入优先（远程部署路径，与 guard.rs::BasicAuth::from_env 同源）。
pub(crate) fn kernel_basic_auth() -> Option<(String, String)> {
    if let Ok(raw) = std::env::var("GWORK_WEB_AUTH") {
        if let Some(idx) = raw.trim().find(':') {
            let raw = raw.trim();
            let (u, p) = (&raw[..idx], &raw[idx + 1..]);
            if !u.is_empty() && !p.is_empty() {
                return Some((u.to_string(), p.to_string()));
            }
        }
    }
    let settings = gourd_work_core::config::Settings::load_default().ok()?;
    let user = settings.general.web_auth_user.unwrap_or_default();
    let pass = settings.general.web_auth_pass.unwrap_or_default();
    if user.trim().is_empty() || pass.trim().is_empty() {
        return None;
    }
    Some((user, pass))
}

fn basic_auth_header(auth: &Option<(String, String)>) -> Option<String> {
    use base64::Engine as _;
    auth.as_ref().map(|(u, p)| {
        format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", u, p))
        )
    })
}

// ─── req → 内核请求构造与执行（§2.1/§2.2/§4）─────────────────────────────────

/// 纯函数：目标 URL。path 已由调用方做白名单校验；query 原样拼接
/// （后台/移动端发来的就是内核要的编码形态，不再二次编码）。
pub(crate) fn kernel_url(origin: &str, req: &ReqEnvelope) -> String {
    let mut url = format!("{}{}", origin.trim_end_matches('/'), req.path);
    if !req.query.is_empty() {
        url.push('?');
        url.push_str(req.query.trim_start_matches('?'));
    }
    url
}

/// 组装并发送一条内核请求，返回 res 信封。30s 超时/不可达 → 502（§2.2）。
/// 抽成独立函数供单测用本地假内核直接击杀（path/query/cwd 头/Basic Auth/超时）。
pub(crate) async fn forward_to_kernel(
    client: &reqwest::Client,
    origin: &str,
    auth: &Option<(String, String)>,
    req: &ReqEnvelope,
) -> ResEnvelope {
    forward_to_kernel_with_timeout(client, origin, auth, req, KERNEL_REQ_TIMEOUT).await
}

/// 同上，超时参数化（单测用短超时验证「超时 → 502」真实路径，不必等 30s）。
pub(crate) async fn forward_to_kernel_with_timeout(
    client: &reqwest::Client,
    origin: &str,
    auth: &Option<(String, String)>,
    req: &ReqEnvelope,
    timeout: Duration,
) -> ResEnvelope {
    if !ALLOWED_PATHS.contains(&req.path.as_str()) {
        return forbidden_res(&req.req_id);
    }
    // 第二道闸门：根目录类端点必须指向已注册项目根（否则等于远程任意文件读取）。
    // query 的 `root` 与 `cwd`（→ X-Session-Cwd 头）都能决定内核的解析根，两者都要过闸；
    // Java 的 resolveChangeRoot 虽然自己对 headerCwd 也做注册校验，但设备侧不能依赖
    // 「另一侧恰好也校验了」——旧版/异构内核未必有那层。
    if ROOT_SCOPED_PATHS.contains(&req.path.as_str()) {
        if let Some(root) = query_root_of(&req.query) {
            if !root_scope_allowed(&root) {
                return forbidden_res(&req.req_id);
            }
        }
        if !root_scope_allowed(&req.cwd) {
            return forbidden_res(&req.req_id);
        }
    }
    let method = match req.method.to_ascii_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        // §2.1：method 只有 GET/POST。其它一律拒，不猜语义。
        _ => {
            return ResEnvelope::new(
                &req.req_id,
                403,
                r#"{"code":403,"description":"method not allowed"}"#,
            )
        }
    };
    let is_post = method == reqwest::Method::POST;
    let mut builder = client
        .request(method, kernel_url(origin, req))
        .timeout(timeout);
    if !req.cwd.trim().is_empty() {
        // §2.1：cwd 非空 → X-Session-Cwd（percent-encode 后原文上桥）。
        // 不透传移动端任何其它头（§5）。
        builder = builder.header("X-Session-Cwd", percent_encode(req.cwd.trim()));
    }
    if let Some(h) = basic_auth_header(auth) {
        builder = builder.header(reqwest::header::AUTHORIZATION, h);
    }
    if is_post {
        let ct = if req.content_type.trim().is_empty() {
            "application/json"
        } else {
            req.content_type.trim()
        };
        builder = builder
            .header(reqwest::header::CONTENT_TYPE, ct)
            .body(req.body.clone());
    }
    match builder.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            ResEnvelope::new(&req.req_id, status, body)
        }
        Err(e) => {
            warn!(error = %e, path = %req.path, "kernel request failed; replying 502");
            kernel_unreachable_res(&req.req_id)
        }
    }
}

/// 转发用的 HTTP client：loopback 直连（系统代理会吞 127.0.0.1）、禁重定向
/// （内核 API 无 3xx，跟随只会把 Basic Auth 带去别处）、超时按请求给。
fn kernel_client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

// ─── gate 订阅表（§2.3）──────────────────────────────────────────────────────

/// 每条后台连接一份订阅表；连接结束（重连/登出）整表 abort ——
/// 「设备重连后无需恢复订阅，移动端靠 replay 补」（§2.3）。
pub(crate) struct GateSubs {
    map: HashMap<String, tokio::task::JoinHandle<()>>,
}

impl GateSubs {
    fn new() -> Self {
        Self { map: HashMap::new() }
    }

    /// 确保 sessionId 的 gate 订阅存在（幂等：已有活跃订阅则不动）。
    fn ensure(
        &mut self,
        session_id: &str,
        kernel_origin: &str,
        auth: &Option<(String, String)>,
        out: &tokio::sync::mpsc::UnboundedSender<String>,
        cancel: &CancellationToken,
    ) {
        if !valid_session_id(session_id) {
            return;
        }
        if let Some(h) = self.map.get(session_id) {
            if !h.is_finished() {
                return;
            }
            self.map.remove(session_id);
        }
        let url = format!(
            "{}/web/gate?sessionId={}",
            kernel_origin.trim_end_matches('/').replace("http://", "ws://").replace("https://", "wss://"),
            percent_encode(session_id)
        );
        let sid = session_id.to_string();
        let auth = auth.clone();
        let out = out.clone();
        let cancel = cancel.clone();
        let handle = tokio::spawn(async move {
            gate_subscription(url, sid, auth, out, cancel).await;
        });
        self.map.insert(session_id.to_string(), handle);
    }

    fn abort_all(&mut self) {
        for (_, h) in self.map.drain() {
            h.abort();
        }
    }
}

impl Drop for GateSubs {
    fn drop(&mut self) {
        self.abort_all();
    }
}

/// 单会话的 gate 订阅循环：连内核 WS，每帧包 frame 信封经共享 sink 发后台；
/// done/error 后保留 60s 再关；期间再来 input 会被 ensure 幂等命中（不重开）。
/// 内核侧断线（如内核重启）在订阅存续期内按 2s 重试。
async fn gate_subscription(
    url: String,
    session_id: String,
    auth: Option<(String, String)>,
    out: tokio::sync::mpsc::UnboundedSender<String>,
    cancel: CancellationToken,
) {
    let transport = gourd_work_core::channels::transport::TungsteniteWs;
    // 内核 Basic Auth 经握手请求头带上（axum 的 guard 对 WS upgrade 同样校验）。
    let auth_header = basic_auth_header(&auth);
    let mut linger_deadline: Option<tokio::time::Instant> = None;
    loop {
        if cancel.is_cancelled() {
            return;
        }
        if let Some(dl) = linger_deadline {
            if tokio::time::Instant::now() >= dl {
                debug!(session = %session_id, "gate subscription linger expired; closing");
                return;
            }
        }
        let connect = async {
            match &auth_header {
                Some(h) => {
                    // 带 Authorization 头的握手：先用 IntoClientRequest 生成
                    // 完整 WS 握手请求（Host/Upgrade/Sec-WebSocket-Key 等），
                    // 再插入 Basic Auth —— 内核 guard 对 WS upgrade 同样校验。
                    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
                    let mut req = url
                        .as_str()
                        .into_client_request()
                        .map_err(|e| anyhow::anyhow!("gate request: {}", e))?;
                    let value = tokio_tungstenite::tungstenite::http::HeaderValue::from_str(h)
                        .map_err(|e| anyhow::anyhow!("gate auth header: {}", e))?;
                    req.headers_mut().insert("Authorization", value);
                    let (stream, _resp) = tokio_tungstenite::connect_async(req).await
                        .map_err(|e| anyhow::anyhow!("gate connect: {}", e))?;
                    let (sink, source) = stream.split();
                    Ok(WsPair {
                        sink: Box::new(CoreSink(sink)),
                        source: Box::new(CoreSource(source)),
                    })
                }
                None => transport.connect(&url).await,
            }
        };
        let pair = match tokio::time::timeout(WS_CONNECT_TIMEOUT, connect).await {
            Ok(Ok(p)) => p,
            Ok(Err(e)) => {
                debug!(session = %session_id, error = %e, "gate connect failed; retrying");
                tokio::select! {
                    _ = cancel.cancelled() => return,
                    _ = tokio::time::sleep(GATE_RETRY_INTERVAL) => continue,
                }
            }
            Err(_) => {
                tokio::select! {
                    _ = cancel.cancelled() => return,
                    _ = tokio::time::sleep(GATE_RETRY_INTERVAL) => continue,
                }
            }
        };
        let mut source = pair.source;
        // sink 半闲置（内核 gate 只下行），保活由内核/OS 层负责；持有防 half-close。
        let _sink_keepalive = pair.sink;
        loop {
            let wait = match linger_deadline {
                Some(dl) => dl.saturating_duration_since(tokio::time::Instant::now()),
                None => Duration::from_secs(3600),
            };
            let msg = tokio::select! {
                _ = cancel.cancelled() => return,
                m = source.next_msg() => m,
                _ = tokio::time::sleep(wait), if linger_deadline.is_some() => {
                    debug!(session = %session_id, "gate linger expired; closing");
                    return;
                }
            };
            match msg {
                Some(Ok(WsMsg::Text(text))) => {
                    let Ok(payload) = serde_json::from_str::<serde_json::Value>(&text) else {
                        continue; // 内核 gate 每帧一条 JSON 文本；非 JSON 丢弃
                    };
                    let is_terminal_frame = matches!(
                        payload.get("type").and_then(|t| t.as_str()),
                        Some("done") | Some("error")
                    );
                    let envelope = frame_envelope(&session_id, payload);
                    if out.send(envelope.to_string()).is_err() {
                        return; // 后台连接已死，写任务已退出
                    }
                    if is_terminal_frame {
                        // §2.3：done/error 后保留 60s（迟续帧），再关。
                        linger_deadline = Some(tokio::time::Instant::now() + GATE_LINGER);
                    } else if linger_deadline.is_some() {
                        // 迟续帧期间又来新活动（如续聊）：取消关闭倒计时。
                        linger_deadline = None;
                    }
                }
                Some(Ok(WsMsg::Close)) | None => break,
                Some(Ok(WsMsg::Binary(_))) => continue,
                Some(Err(e)) => {
                    debug!(session = %session_id, error = %e, "gate stream error; reconnecting");
                    break;
                }
            }
        }
        if let Some(dl) = linger_deadline {
            if tokio::time::Instant::now() >= dl {
                return;
            }
        }
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = tokio::time::sleep(GATE_RETRY_INTERVAL) => {}
        }
    }
}

// 复用 core transport 的 tungstenite 适配（带自定义握手头时 core 的
// TungsteniteWs::connect 不收 headers，这里薄包一层同构实现）。
type CoreStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

struct CoreSink(futures_util::stream::SplitSink<CoreStream, tokio_tungstenite::tungstenite::Message>);

#[async_trait::async_trait]
impl gourd_work_core::channels::transport::WsSink for CoreSink {
    async fn send(&mut self, msg: WsMsg) -> anyhow::Result<()> {
        use tokio_tungstenite::tungstenite::Message;
        let m = match msg {
            WsMsg::Text(t) => Message::Text(t.into()),
            WsMsg::Binary(b) => Message::Binary(b.into()),
            WsMsg::Close => Message::Close(None),
        };
        self.0.send(m).await?;
        Ok(())
    }
}

struct CoreSource(futures_util::stream::SplitStream<CoreStream>);

#[async_trait::async_trait]
impl gourd_work_core::channels::transport::WsSource for CoreSource {
    async fn next_msg(&mut self) -> Option<anyhow::Result<WsMsg>> {
        use tokio_tungstenite::tungstenite::Message;
        loop {
            match self.0.next().await {
                None => return Some(Ok(WsMsg::Close)),
                Some(Err(e)) => return Some(Err(anyhow::anyhow!(e.to_string()))),
                Some(Ok(Message::Text(t))) => return Some(Ok(WsMsg::Text(t.to_string()))),
                Some(Ok(Message::Binary(b))) => return Some(Ok(WsMsg::Binary(b.to_vec()))),
                Some(Ok(Message::Close(_))) => return Some(Ok(WsMsg::Close)),
                Some(Ok(_)) => continue,
            }
        }
    }
}

// ─── 后台连接循环 ────────────────────────────────────────────────────────────

/// 连接失败的分类：决定「退避重试 / 先 refresh 再重试 / 彻底停止」。
enum LinkError {
    /// 网络/握手/心跳超时等：指数退避后重试。
    Transient(String),
    /// upgrade 被后台判 401：先强制 refresh 拿新 token 再重试（§2）。
    Unauthorized,
    /// 会话已不可恢复：停止整个中转（等下次登录再 start）。
    Terminal(String),
}

/// 一次连接从建立到断开的完整服务。返回 Err 交给外层退避。
///
/// 并发模型：
/// - 读：本循环独占 source；
/// - 写：单写任务独占 sink，所有出站文本经 unbounded mpsc 串行化
///   （tungstenite 不允许并发写 SplitSink）；
/// - req：每条 spawn 一个转发任务（30s 超时互不阻塞）；
/// - gate 订阅表：Arc<Mutex<GateSubs>>，由转发任务在拿到 sessionId 后 ensure。
async fn serve_connection(
    pair: WsPair,
    kernel_origin: &str,
    kernel_auth: &Option<(String, String)>,
    client: &reqwest::Client,
    cancel: &CancellationToken,
) -> Result<(), LinkError> {
    let WsPair { mut sink, mut source } = pair;
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let writer_cancel = cancel.clone();
    let writer = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = writer_cancel.cancelled() => break,
                msg = out_rx.recv() => match msg {
                    Some(text) => {
                        if sink.send(WsMsg::Text(text)).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                },
            }
        }
        let _ = sink.send(WsMsg::Close).await;
    });

    let subs = Arc::new(Mutex::new(GateSubs::new()));
    let mut ping_tick = tokio::time::interval(PING_INTERVAL);
    ping_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ping_tick.tick().await; // 立即完成第一拍，之后每 25s
    let mut last_frame = tokio::time::Instant::now();
    let result: Result<(), LinkError> = loop {
        tokio::select! {
            _ = cancel.cancelled() => break Ok(()),
            _ = ping_tick.tick() => {
                if last_frame.elapsed() > FRAME_DEAD_TIMEOUT {
                    break Err(LinkError::Transient("no frame from backend for 60s".into()));
                }
                if out_tx.send(r#"{"type":"ping"}"#.to_string()).is_err() {
                    break Err(LinkError::Transient("writer closed".into()));
                }
            }
            msg = source.next_msg() => {
                match msg {
                    Some(Ok(WsMsg::Text(text))) => {
                        last_frame = tokio::time::Instant::now();
                        match parse_incoming(&text) {
                            Incoming::Ping => {
                                let _ = out_tx.send(r#"{"type":"pong"}"#.to_string());
                            }
                            Incoming::Pong | Incoming::Other => {}
                            Incoming::Req(req) => {
                                let client = client.clone();
                                let origin = kernel_origin.to_string();
                                let kauth = kernel_auth.clone();
                                let out = out_tx.clone();
                                let subs = subs.clone();
                                let cancel2 = cancel.clone();
                                tokio::spawn(async move {
                                    let is_input = req.path == "/web/chat/input";
                                    // 请求自带 sessionId（续聊 POST body / 会话级
                                    // GET query）：先确保订阅，内核开始跑时帧才
                                    // 不会漏（§2.3）。GET replay 也 ensure——移动端
                                    // 打开他端运行中的会话全靠这条路径建 gate 订阅
                                    // （ensure 幂等，重复 GET 不会叠连接）。
                                    let sid = session_from_req_body(&req)
                                        .or_else(|| query_session_of(&req.query));
                                    if let Some(sid) = sid {
                                        if let Ok(mut g) = subs.lock() {
                                            g.ensure(&sid, &origin, &kauth, &out, &cancel2);
                                        }
                                    }
                                    let res = forward_to_kernel(&client, &origin, &kauth, &req).await;
                                    // 新任务：input 成功响应的 data.sessionId
                                    // 才是权威 id（请求可能没带）。
                                    if is_input && res.status == 200 {
                                        if let Some(sid) = input_session_from_res(&res.body) {
                                            if let Ok(mut g) = subs.lock() {
                                                g.ensure(&sid, &origin, &kauth, &out, &cancel2);
                                            }
                                        }
                                    }
                                    let _ = out.send(serde_json::to_string(&res).unwrap_or_default());
                                });
                            }
                        }
                    }
                    Some(Ok(WsMsg::Close)) | None => {
                        break Err(LinkError::Transient("backend closed connection".into()));
                    }
                    Some(Ok(WsMsg::Binary(_))) => { last_frame = tokio::time::Instant::now(); }
                    Some(Err(e)) => break Err(LinkError::Transient(e.to_string())),
                }
            }
        }
    };
    // 连接结束：整表 abort（重连后移动端靠 replay 补帧，§2.3）。
    if let Ok(mut g) = subs.lock() {
        g.abort_all();
    }
    writer.abort();
    result
}

/// 就绪闸门的纯判定，供 link_loop 轮询使用（不依赖 watch 通知）。
///
/// 优先级：已就绪 > 启动失败 > 继续等。`ready` 为真时即便 `kernel_error`
/// 也被置过（就绪后转发失败是另一回事，会回 502 信封），仍应放行。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KernelGate {
    Ready,
    Failed,
    Wait,
}

fn kernel_gate(ready: bool, failed: bool) -> KernelGate {
    if ready {
        KernelGate::Ready
    } else if failed {
        KernelGate::Failed
    } else {
        KernelGate::Wait
    }
}

/// 外层监督循环：等内核就绪 → ensure_host → 取 token → 连 WSS → 服务 → 退避。
async fn link_loop(
    app: tauri::AppHandle,
    auth: Arc<crate::auth::AuthState>,
    cancel: CancellationToken,
) {
    use tauri::Manager;
    // 等内核就绪。以 AppState.kernel_ready 这个 atomic 为**唯一真值源**，
    // backend_ready watch 只当「快速唤醒」信号，绝不能当唯一判据：
    //
    // tokio::sync::watch::Sender::send(true) 在没有任何 receiver 时返回 Err
    // 且**不写入新值**（1.54.1 源码：receiver_count()==0 直接 return Err）。
    // 内核健康探针通常 ~100ms 就完成，而 auth::install 的 restore 要先跨公网
    // 竞速选站再决定拉起 device_link —— 几乎必然晚于那次就绪广播。于是广播
    // 被静默丢弃，随后 subscribe() 只看到 false，旧实现就永远等一次不会再来
    // 的 changed()：一次 WSS 都不发，后台 gwork_devices 表始终为空；更糟的是
    // 任务 alive 仍为 true，keeper 的幂等 start() 也不会重启它（生产事故）。
    //
    // 修复：启动广播改用 send_replace（见 lib.rs），本闸门再加 250ms 轮询兜底
    // 读 atomic；即使广播彻底丢失，循环第一次迭代就能读到 ready=true 直接放行。
    // 内核启动失败的判定放进同一循环，避免失败时永久占着单例槽。
    //
    // 就绪闸门本身**有界**：最多等 120s，超时视为内核探测挂起（wait_for_kernel
    // 没有任何超时保护），主动放弃并释放单例槽，让 keeper 下次保活还能 start()
    // 重试 —— 无限等待会在这种异常启动下把 device_link 永久堵死（review 发现）。
    let Some(state) = app.try_state::<crate::AppState>() else {
        warn!("device_link: AppState missing; not starting");
        return;
    };
    let kernel_origin = state.kernel_origin.clone();
    let mut ready_rx = state.backend_ready.subscribe();
    drop(state);
    let mut watch_alive = true;
    let gate_deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    loop {
        let (ready, failed) = app
            .try_state::<crate::AppState>()
            .map(|st| {
                (
                    st.kernel_ready
                        .load(std::sync::atomic::Ordering::SeqCst),
                    st.kernel_error.lock().map(|e| e.is_some()).unwrap_or(false),
                )
            })
            .unwrap_or((false, false));
        match kernel_gate(ready, failed) {
            KernelGate::Ready => break,
            KernelGate::Failed => {
                warn!("device_link: kernel failed to start; not linking");
                return;
            }
            KernelGate::Wait => {}
        }
        if tokio::time::Instant::now() >= gate_deadline {
            warn!("device_link: kernel readiness wait timed out; giving up this attempt");
            return;
        }
        tokio::select! {
            _ = cancel.cancelled() => return,
            r = ready_rx.changed(), if watch_alive => {
                // channel 关闭后禁用该分支，否则 changed() 立刻返回 Err 会让
                // select 空转成 busy loop；此时只靠 250ms 轮询即可。
                if r.is_err() {
                    watch_alive = false;
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(250)) => {}
        }
    }
    info!("device link: kernel ready; entering connect loop");

    let identity = load_or_create_identity();
    let name = device_name();
    let platform = device_platform().to_string();
    let version = app_version().to_string();
    let client = kernel_client();
    let transport = gourd_work_core::channels::transport::TungsteniteWs;
    let mut backoff = Backoff::new(BACKOFF_BASE, BACKOFF_MAX);
    // 连续失败计数：debug 级不落盘会让「一直连不上」在日志里完全隐形
    // （生产事故教训）。第 3 次起升 warn，此后每 10 次再报一次，避免刷屏。
    let mut consecutive_failures: u32 = 0;
    info!(device = %identity.device_id, "device link starting");

    loop {
        if cancel.is_cancelled() {
            return;
        }
        // 未登录（登出竞态/会话被清）：不重试打后台，直接结束任务。
        if !auth.is_signed_in() {
            info!("device link: signed out; stopping");
            return;
        }
        let attempt = async {
            let base = auth.ensure_host().await;
            let token = auth
                .fresh_access_token(false)
                .await
                .map_err(|e| classify_auth_error(&e))?;
            let url = link_url(&base, &token, &identity, &name, &platform, &version)
                .map_err(LinkError::Transient)?;
            // 日志绝不带 token（§5）：只打 host 部分。
            debug!(base = %base, "device link connecting");
            let pair = tokio::time::timeout(WS_CONNECT_TIMEOUT, transport.connect(&url))
                .await
                .map_err(|_| LinkError::Transient("ws handshake timeout".into()))?
                .map_err(|e| classify_ws_error(&e))?;
            Ok::<WsPair, LinkError>(pair)
        };
        match attempt.await {
            Ok(pair) => {
                backoff.reset();
                consecutive_failures = 0;
                info!(base = %auth.host(), "device link connected");
                let kernel_auth = kernel_basic_auth();
                match serve_connection(
                    pair,
                    &kernel_origin,
                    &kernel_auth,
                    &client,
                    &cancel,
                )
                .await
                {
                    Ok(()) => return, // cancel
                    Err(LinkError::Terminal(e)) => {
                        warn!(error = %e, "device link: session terminal; stopping");
                        return;
                    }
                    Err(LinkError::Unauthorized) => {
                        // 连接期间被后台踢（token 失效/同 deviceId 重连踢旧）：
                        // 强制 refresh 后走退避重试。
                        if let Err(e) = auth.fresh_access_token(true).await {
                            if crate::auth::AuthState::session_error_is_terminal(&e) {
                                warn!(error = %e, "device link: refresh terminal; stopping");
                                return;
                            }
                        }
                    }
                    Err(LinkError::Transient(e)) => {
                        consecutive_failures += 1;
                        if consecutive_failures == 3 || consecutive_failures % 10 == 0 {
                            warn!(error = %e, fails = consecutive_failures, "device link dropped repeatedly; reconnecting");
                        } else {
                            debug!(error = %e, "device link dropped; reconnecting");
                        }
                    }
                }
            }
            Err(LinkError::Terminal(e)) => {
                warn!(error = %e, "device link: session terminal; stopping");
                return;
            }
            Err(LinkError::Unauthorized) => {
                // upgrade 401：先强制 refresh 再重试（§2「重连必须用新 token」）。
                if let Err(e) = auth.fresh_access_token(true).await {
                    if crate::auth::AuthState::session_error_is_terminal(&e) {
                        warn!(error = %e, "device link: refresh terminal; stopping");
                        return;
                    }
                }
            }
            Err(LinkError::Transient(e)) => {
                consecutive_failures += 1;
                if consecutive_failures == 3 || consecutive_failures % 10 == 0 {
                    warn!(error = %e, fails = consecutive_failures, "device link connect failing repeatedly; backing off");
                } else {
                    debug!(error = %e, "device link connect failed; backing off");
                }
            }
        }
        if cancel.is_cancelled() {
            return;
        }
        let delay = backoff.next_delay();
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = tokio::time::sleep(delay) => {}
        }
    }
}

/// reqwest/anyhow 错误 → 连接错误分类。tungstenite 的 Http(401) 单独识别。
/// 匹配带上下文的 "401"（HTTP error: 401 / status code 401），避免 URL 端口号
/// 之类裸数字误判；宁可漏判成 Transient（退避后仍会带新 token 重连）。
fn classify_ws_error(e: &anyhow::Error) -> LinkError {
    let s = e.to_string();
    if s.contains("HTTP error: 401") || s.contains("status code 401") || s.contains("401 Unauthorized") {
        LinkError::Unauthorized
    } else {
        LinkError::Transient(s)
    }
}

fn classify_auth_error(e: &str) -> LinkError {
    if crate::auth::AuthState::session_error_is_terminal(e) {
        LinkError::Terminal(e.to_string())
    } else if e.contains("尚未登录") {
        LinkError::Terminal(e.to_string())
    } else {
        LinkError::Transient(e.to_string())
    }
}

// ─── 生命周期（进程级单例）───────────────────────────────────────────────────

struct LinkHandle {
    cancel: CancellationToken,
    task: tauri::async_runtime::JoinHandle<()>,
    /// link_loop 退出时置位（tauri 的 JoinHandle 是枚举，无 is_finished；
    /// 用共享标志判断任务是否仍活跃，避免给 enum 做模式匹配）。
    alive: Arc<std::sync::atomic::AtomicBool>,
}

static LINK: OnceLock<Mutex<Option<LinkHandle>>> = OnceLock::new();

fn link_slot() -> &'static Mutex<Option<LinkHandle>> {
    LINK.get_or_init(|| Mutex::new(None))
}

/// 幂等启动。登录成功（auth_login/auth_register/restore）后调用。
/// 用 tauri::async_runtime::spawn：setup 阶段可能尚未进入 tokio reactor。
pub fn start(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(auth) = app
        .try_state::<Arc<crate::auth::AuthState>>()
        .map(|s| s.inner().clone())
    else {
        return;
    };
    if !auth.is_signed_in() {
        return; // 未登录不启动
    }
    let Ok(mut slot) = link_slot().lock() else { return };
    if let Some(h) = slot.as_ref() {
        if h.alive.load(std::sync::atomic::Ordering::SeqCst) {
            return; // 已在跑
        }
    }
    let cancel = CancellationToken::new();
    let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let app2 = app.clone();
    let cancel2 = cancel.clone();
    let alive2 = alive.clone();
    let task = tauri::async_runtime::spawn(async move {
        link_loop(app2, auth, cancel2).await;
        alive2.store(false, std::sync::atomic::Ordering::SeqCst);
    });
    *slot = Some(LinkHandle { cancel, task, alive });
}

/// 停止并清理（登出/会话终结/进程退出）。幂等。
pub fn stop() {
    let Ok(mut slot) = link_slot().lock() else { return };
    if let Some(h) = slot.take() {
        h.cancel.cancel();
        h.task.abort();
    }
}

/// 当前是否有一条活跃的中转任务（不保证此刻 WS 已连上，v1 展示口径）。
fn is_running() -> bool {
    link_slot()
        .lock()
        .ok()
        .and_then(|g| {
            g.as_ref()
                .map(|h| h.alive.load(std::sync::atomic::Ordering::SeqCst))
        })
        .unwrap_or(false)
}

// ─── Tauri command（§3 状态查询；v1 无 UI，只注册命令）────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct DeviceLinkStatus {
    pub connected: bool,
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(rename = "deviceName")]
    pub device_name: String,
}

#[tauri::command]
pub async fn device_link_status() -> Result<DeviceLinkStatus, String> {
    let identity = load_or_create_identity();
    Ok(DeviceLinkStatus {
        connected: is_running(),
        device_id: identity.device_id,
        device_name: device_name(),
    })
}

// ─── 单测 ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── 信封编解码 ──

    #[test]
    fn req_envelope_roundtrip_and_defaults() {
        let raw = r#"{"type":"req","reqId":"r-1","from":"mob-abc","method":"GET",
            "path":"/web/chat/sessions","query":"root=","cwd":"C:\\proj",
            "body":"","contentType":"application/json"}"#;
        match parse_incoming(raw) {
            Incoming::Req(r) => {
                assert_eq!(r.req_id, "r-1");
                assert_eq!(r.method, "GET");
                assert_eq!(r.path, "/web/chat/sessions");
                assert_eq!(r.query, "root=");
                assert_eq!(r.cwd, "C:\\proj");
            }
            other => panic!("expected req, got {:?}", other),
        }
        // 缺省字段全部可空（后台可能省略）。
        match parse_incoming(r#"{"type":"req","reqId":"r-2","path":"/web/chat/meta"}"#) {
            Incoming::Req(r) => {
                assert_eq!(r.req_id, "r-2");
                assert!(r.body.is_empty() && r.cwd.is_empty() && r.query.is_empty());
            }
            other => panic!("expected req, got {:?}", other),
        }
    }

    #[test]
    fn ping_pong_and_unknown_types_are_classified() {
        assert!(matches!(parse_incoming(r#"{"type":"ping"}"#), Incoming::Ping));
        assert!(matches!(parse_incoming(r#"{"type":"pong"}"#), Incoming::Pong));
        assert!(matches!(parse_incoming(r#"{"type":"device_offline"}"#), Incoming::Other));
        assert!(matches!(parse_incoming("not json"), Incoming::Other));
        assert!(matches!(parse_incoming(r#"{"type":"req"}"#), Incoming::Other));
    }

    #[test]
    fn res_envelope_matches_protocol_wire_names() {
        let res = kernel_unreachable_res("r-9");
        let v: serde_json::Value = serde_json::from_str(&serde_json::to_string(&res).unwrap()).unwrap();
        assert_eq!(v["type"], "res");
        assert_eq!(v["reqId"], "r-9");
        assert_eq!(v["status"], 502);
        assert_eq!(v["body"], r#"{"code":502,"description":"kernel unreachable"}"#);
    }

    #[test]
    fn frame_envelope_wraps_payload_verbatim() {
        let payload = serde_json::json!({"type":"text","sessionId":"work-1","eventSeq":3,"text":"hi"});
        let env = frame_envelope("work-1", payload.clone());
        assert_eq!(env["type"], "frame");
        assert_eq!(env["sessionId"], "work-1");
        assert_eq!(env["payload"], payload);
    }

    #[test]
    fn input_session_extraction_handles_busy_and_errors() {
        assert_eq!(
            input_session_from_res(r#"{"code":200,"data":{"sessionId":"work-ab12cd34"}}"#),
            Some("work-ab12cd34".into())
        );
        assert_eq!(input_session_from_res(r#"{"code":200,"data":"busy"}"#), None);
        assert_eq!(input_session_from_res(r#"{"code":500,"description":"x"}"#), None);
        assert_eq!(input_session_from_res("not json"), None);
        // 非法 sessionId 不订阅（防路径注入）。
        assert_eq!(
            input_session_from_res(r#"{"code":200,"data":{"sessionId":"../evil"}}"#),
            None
        );
    }

    #[test]
    fn query_session_of_reads_and_decodes_the_session_param() {
        // 移动端打开会话的真实形态：GET replay，sessionId 在 query，body 恒空。
        // 旧实现只认 POST body → 手机看他端运行中任务永远收不到 gate 帧（卡死真因）。
        assert_eq!(
            query_session_of("sessionId=work-ab12cd34&rounds=10"),
            Some("work-ab12cd34".into())
        );
        assert_eq!(
            query_session_of("?sessionId=work-1&afterSeq=42&limit=500"),
            Some("work-1".into())
        );
        assert_eq!(query_session_of("root="), None);
        assert_eq!(query_session_of("sessionId="), None);
        // 非法 id 不建订阅（与 body 路径同口径防注入）。
        assert_eq!(query_session_of("sessionId=..%2Fevil"), None);
        assert_eq!(query_session_of("sessionId=work%2F1"), None);
    }

    #[test]
    fn query_session_of_edge_forms_and_injection_guards() {
        // review 补充边界（2026-11-24 二轮）：
        // 键位置无关：sessionId 在中间/末尾同样命中。
        assert_eq!(
            query_session_of("rounds=10&sessionId=work-mid&beforeSeq=99"),
            Some("work-mid".into())
        );
        assert_eq!(query_session_of("root=x&sessionId=work-tail"), Some("work-tail".into()));
        // 首个 sessionId 非法即拒绝，绝不回退扫描后续重复键（防「合法键掩护注入键」）。
        assert_eq!(query_session_of("sessionId=..%2Fevil&sessionId=work-ok"), None);
        // 反斜杠 / 控制字符 / 空白（percent 编码后）同样拒绝。
        assert_eq!(query_session_of("sessionId=work%5C1"), None);
        assert_eq!(query_session_of("sessionId=work%0A1"), None);
        assert_eq!(query_session_of("sessionId=work%201"), None);
        // 超长 id（>128）拒绝：防订阅表被恶意撑爆。
        let long = "a".repeat(129);
        assert_eq!(query_session_of(&format!("sessionId={}", long)), None);
        // 空 query / 无键 / 只有 '?'。
        assert_eq!(query_session_of(""), None);
        assert_eq!(query_session_of("?"), None);
        // 相似键不误命中（xsessionId / sessionId2）。
        assert_eq!(query_session_of("xsessionId=work-1"), None);
        assert_eq!(query_session_of("sessionId2=work-1"), None);
    }

    #[test]
    fn session_from_req_body_json_and_form() {
        let mut req = ReqEnvelope {
            req_id: "r".into(), method: "POST".into(), path: "/web/chat/input".into(),
            query: String::new(), cwd: String::new(),
            body: r#"{"sessionId":"work-1","input":"hi"}"#.into(),
            content_type: "application/json".into(),
        };
        assert_eq!(session_from_req_body(&req), Some("work-1".into()));
        req.content_type = "application/x-www-form-urlencoded".into();
        req.body = "sessionId=work-2&runId=r1".into();
        assert_eq!(session_from_req_body(&req), Some("work-2".into()));
        req.body = "input=hi".into();
        assert_eq!(session_from_req_body(&req), None);
    }

    // ── percent 编解码 ──

    #[test]
    fn percent_encode_utf8_and_roundtrip() {
        assert_eq!(percent_encode("C:\\proj a\\中文"), "C%3A%5Cproj%20a%5C%E4%B8%AD%E6%96%87");
        assert_eq!(percent_decode(&percent_encode("C:\\proj a\\中文")), "C:\\proj a\\中文");
        assert_eq!(percent_encode("a-b_c.d~e"), "a-b_c.d~e");
        // 非法转义原样透传（与内核 percent_decode 同口径）。
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    // ── 设备身份 ──

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "gwork-devlink-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn device_identity_is_persisted_and_idempotent() {
        let dir = scratch("identity");
        let path = dir.join("device.json");
        let a = load_or_create_identity_at(&path);
        assert!(a.device_id.starts_with("dev-"));
        assert_eq!(a.device_id.len(), 4 + 8);
        assert!(path.exists());
        let b = load_or_create_identity_at(&path);
        assert_eq!(a.device_id, b.device_id, "second load must reuse the persisted id");
        // 损坏文件 → 重新生成并落盘，不 panic。
        std::fs::write(&path, "{corrupt").unwrap();
        let c = load_or_create_identity_at(&path);
        assert!(c.device_id.starts_with("dev-"));
        let d = load_or_create_identity_at(&path);
        assert_eq!(c.device_id, d.device_id);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn platform_and_name_are_sane() {
        assert!(["windows", "macos", "linux"].contains(&device_platform()));
        assert!(!device_name().is_empty());
        assert!(!app_version().is_empty());
    }

    // ── URL 构造 ──

    #[test]
    fn link_url_maps_scheme_and_encodes_query() {
        let id = DeviceIdentity { device_id: "dev-ab12cd34".into() };
        let u = link_url("https://www.gourdwork.com", "jwt.tok+en/x", &id, "MY PC", "windows", "0.3.0").unwrap();
        assert!(u.starts_with("wss://www.gourdwork.com/api/gwork/device/link?"));
        assert!(u.contains("token=jwt.tok%2Ben%2Fx"));
        assert!(u.contains("deviceId=dev-ab12cd34"));
        assert!(u.contains("name=MY%20PC"));
        assert!(u.contains("platform=windows"));
        assert!(u.contains("appVersion=0.3.0"));
        // 开发态 loopback http → ws。
        let d = link_url("http://127.0.0.1:3000/", "t", &id, "n", "windows", "0.3.0").unwrap();
        assert!(d.starts_with("ws://127.0.0.1:3000/api/gwork/device/link?"));
        assert!(link_url("ftp://x", "t", &id, "n", "windows", "0").is_err());
    }

    #[test]
    fn plaintext_ws_is_refused_outside_loopback() {
        // The session token rides in the query (H5 cannot set WS headers), so a
        // non-loopback http base would put a live credential on the wire in the
        // clear. Only 127.0.0.1 / localhost / [::1] may degrade to ws://.
        let id = DeviceIdentity { device_id: "dev-ab12cd34".into() };
        for base in [
            "http://example.com",
            "http://192.168.1.10:3000",
            "http://10.0.0.5",
            "http://127.0.0.1.evil.com",
        ] {
            let err = link_url(base, "t", &id, "n", "windows", "0").unwrap_err();
            assert!(err.contains("refusing plaintext ws://"), "{} → {}", base, err);
        }
        for base in ["http://localhost:3000", "http://[::1]:3000", "http://127.0.0.1"] {
            assert!(
                link_url(base, "t", &id, "n", "windows", "0").unwrap().starts_with("ws://"),
                "{} must stay reachable for local dev",
                base
            );
        }
    }

    #[test]
    fn kernel_url_joins_path_and_query_verbatim() {
        let req = ReqEnvelope {
            req_id: "r".into(), method: "GET".into(), path: "/web/chat/sessions".into(),
            query: "root=C%3A%5Cproj".into(), cwd: String::new(), body: String::new(),
            content_type: String::new(),
        };
        assert_eq!(
            kernel_url("http://127.0.0.1:9/", &req),
            "http://127.0.0.1:9/web/chat/sessions?root=C%3A%5Cproj"
        );
    }

    // ── 退避序列（复用 core Backoff，契约 1s×2 封顶 60s）──

    #[test]
    fn backoff_sequence_doubles_and_caps_at_60s() {
        let mut b = Backoff::new(BACKOFF_BASE, BACKOFF_MAX);
        let seq: Vec<u64> = (0..9).map(|_| b.next_delay().as_secs()).collect();
        assert_eq!(seq, vec![1, 2, 4, 8, 16, 32, 60, 60, 60]);
        b.reset();
        assert_eq!(b.next_delay().as_secs(), 1);
    }

    // ── req → 内核转发（本地假内核，不出外网）──

    /// 起一个临时 axum 假内核：回显 method/path/query/关键头/body。
    async fn fake_kernel(
        delay: Duration,
    ) -> (String, tokio::task::JoinHandle<()>) {
        use axum::extract::Request;
        use axum::routing::any;
        let app = axum::Router::new().fallback(any(move |req: Request| async move {
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            let headers = req.headers();
            let echo = serde_json::json!({
                "method": req.method().as_str(),
                "path": req.uri().path(),
                "query": req.uri().query().unwrap_or(""),
                "cwd": headers.get("x-session-cwd").and_then(|v| v.to_str().ok()).unwrap_or(""),
                "auth": headers.get("authorization").and_then(|v| v.to_str().ok()).unwrap_or(""),
                "contentType": headers.get("content-type").and_then(|v| v.to_str().ok()).unwrap_or(""),
                "body": String::from_utf8_lossy(
                    &axum::body::to_bytes(req.into_body(), 1024 * 1024).await.unwrap_or_default()
                ),
            });
            axum::Json(echo)
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (origin, task)
    }

    fn req(path: &str) -> ReqEnvelope {
        ReqEnvelope {
            req_id: "r-1".into(), method: "GET".into(), path: path.into(),
            query: String::new(), cwd: String::new(), body: String::new(),
            content_type: String::new(),
        }
    }

    #[tokio::test]
    async fn forward_get_carries_path_query_cwd_and_basic_auth() {
        let (origin, server) = fake_kernel(Duration::ZERO).await;
        let client = kernel_client();
        let mut r = req("/web/chat/sessions");
        r.query = "root=".into();
        r.cwd = "C:\\proj 中文".into();
        let auth = Some(("admin".to_string(), "s3cret".to_string()));
        let res = forward_to_kernel(&client, &origin, &auth, &r).await;
        assert_eq!(res.status, 200);
        let echo: serde_json::Value = serde_json::from_str(&res.body).unwrap();
        assert_eq!(echo["method"], "GET");
        assert_eq!(echo["path"], "/web/chat/sessions");
        assert_eq!(echo["query"], "root=");
        assert_eq!(echo["cwd"], percent_encode("C:\\proj 中文"));
        assert_eq!(echo["auth"], basic_auth_header(&auth).unwrap());
        server.abort();
    }

    #[tokio::test]
    async fn forward_post_passes_body_and_content_type_verbatim() {
        let (origin, server) = fake_kernel(Duration::ZERO).await;
        let client = kernel_client();
        let mut r = req("/web/chat/input");
        r.method = "POST".into();
        r.body = r#"{"sessionId":"work-1","input":"你好"}"#.into();
        r.content_type = "application/json".into();
        let res = forward_to_kernel(&client, &origin, &None, &r).await;
        assert_eq!(res.status, 200);
        let echo: serde_json::Value = serde_json::from_str(&res.body).unwrap();
        assert_eq!(echo["method"], "POST");
        assert_eq!(echo["body"], r.body);
        assert_eq!(echo["contentType"], "application/json");
        // 未配置 Basic Auth / cwd 时不得出现对应头。
        assert_eq!(echo["auth"], "");
        assert_eq!(echo["cwd"], "");
        // form 路径同样原样透传。
        r.path = "/web/chat/interrupt".into();
        r.body = "sessionId=work-1&runId=r1".into();
        r.content_type = "application/x-www-form-urlencoded".into();
        let res = forward_to_kernel(&client, &origin, &None, &r).await;
        let echo: serde_json::Value = serde_json::from_str(&res.body).unwrap();
        assert_eq!(echo["contentType"], "application/x-www-form-urlencoded");
        assert_eq!(echo["body"], "sessionId=work-1&runId=r1");
        server.abort();
    }

    #[tokio::test]
    async fn forward_rejects_non_whitelisted_path_and_method() {
        let (origin, server) = fake_kernel(Duration::ZERO).await;
        let client = kernel_client();
        let res = forward_to_kernel(&client, &origin, &None, &req("/web/terminal")).await;
        assert_eq!(res.status, 403);
        let mut r = req("/web/chat/meta");
        r.method = "DELETE".into();
        let res = forward_to_kernel(&client, &origin, &None, &r).await;
        assert_eq!(res.status, 403);
        server.abort();
    }

    // ── 根目录闸门（防远程任意文件读取）──

    #[test]
    fn query_root_of_reads_and_decodes_the_root_param() {
        assert_eq!(query_root_of("root="), Some(String::new()));
        assert_eq!(query_root_of("root"), Some(String::new()));
        assert_eq!(query_root_of("sessionId=work-1"), None);
        assert_eq!(
            query_root_of("sessionId=w&root=C%3A%5Cproj%20x"),
            Some("C:\\proj x".to_string())
        );
        // 前导 ? 与参数顺序都不影响
        assert_eq!(
            query_root_of("?a=1&root=D%3A%2Fwork&b=2"),
            Some("D:/work".to_string())
        );
    }

    #[tokio::test]
    async fn root_scoped_paths_reject_unregistered_roots() {
        // 空 root / 无 root 键 = 用内核自身 workspace，放行
        assert!(root_scope_allowed(""));
        assert!(root_scope_allowed("   "));
        // 未注册的绝对路径必须被拒——这正是「远程任意文件读取」的入口形态
        assert!(!root_scope_allowed("C:\\Windows\\System32"));
        assert!(!root_scope_allowed("/etc"));

        let (origin, server) = fake_kernel(Duration::ZERO).await;
        let client = kernel_client();
        // query root 越权 → 403，且不得打到内核
        let mut r = req("/web/chat/filer/read");
        r.query = "path=.ssh%2Fid_rsa&root=C%3A%5CWindows".into();
        assert_eq!(forward_to_kernel(&client, &origin, &None, &r).await.status, 403);
        // cwd 头同样能改解析根，也要拦
        let mut r2 = req("/web/chat/filer/read");
        r2.query = "path=.ssh%2Fid_rsa".into();
        r2.cwd = "C:\\Windows".into();
        assert_eq!(forward_to_kernel(&client, &origin, &None, &r2).await.status, 403);
        // 空 root 的合法请求照常转发
        let mut ok = req("/web/chat/filer/read");
        ok.query = "path=README.md&root=".into();
        let res = forward_to_kernel(&client, &origin, &None, &ok).await;
        assert_eq!(res.status, 200);
        server.abort();
    }

    #[test]
    fn filer_raw_is_not_allowlisted() {
        // 字节流端点过不了字符串信封，且上限 50MB；移动端从不调用它。
        assert!(!ALLOWED_PATHS.contains(&"/web/chat/filer/raw"));
        assert!(!ALLOWED_PATHS.contains(&"/web/chat/filer/write"));
        assert!(!ALLOWED_PATHS.contains(&"/web/chat/changes/undo/file"));
    }

    #[tokio::test]
    async fn forward_unreachable_kernel_is_502_envelope() {
        // 绑定后立即释放端口：几乎必然无人监听（loopback 拒绝连接）。
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let client = kernel_client();
        let res = forward_to_kernel(&client, &origin, &None, &req("/web/chat/meta")).await;
        assert_eq!(res.status, 502);
        assert_eq!(res.body, r#"{"code":502,"description":"kernel unreachable"}"#);
        assert_eq!(res.req_id, "r-1");
    }

    #[tokio::test]
    async fn forward_timeout_is_502() {
        // 生产契约：30s（常量断言防漂移）。真实超时路径用参数化超时击杀：
        // 假内核睡 5s，请求超时 300ms → 必须走 Err 分支回 502 信封。
        assert_eq!(KERNEL_REQ_TIMEOUT, Duration::from_secs(30));
        let (origin, server) = fake_kernel(Duration::from_secs(5)).await;
        let client = kernel_client();
        let res = forward_to_kernel_with_timeout(
            &client,
            &origin,
            &None,
            &req("/web/chat/meta"),
            Duration::from_millis(300),
        )
        .await;
        assert_eq!(res.status, 502);
        assert_eq!(res.body, r#"{"code":502,"description":"kernel unreachable"}"#);
        assert_eq!(res.req_id, "r-1");
        server.abort();
    }

    // ── gate 订阅表 ──

    /// 起一个假 gate WS：升级后推两帧（text + done），随后保持连接。
    async fn fake_gate() -> (String, tokio::task::JoinHandle<()>) {
        use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
        use axum::routing::get;
        let app = axum::Router::new().route(
            "/web/gate",
            get(|ws: WebSocketUpgrade| async move {
                ws.on_upgrade(|mut socket: WebSocket| async move {
                    let _ = socket
                        .send(Message::Text(
                            r#"{"type":"text","sessionId":"work-1","eventSeq":1,"text":"hi"}"#.into(),
                        ))
                        .await;
                    let _ = socket
                        .send(Message::Text(
                            r#"{"type":"done","sessionId":"work-1","phase":"done"}"#.into(),
                        ))
                        .await;
                    // 保持连接直到对端关闭（linger 语义由订阅侧负责）。
                    while let Some(Ok(_)) = socket.recv().await {}
                })
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (origin, task)
    }

    #[tokio::test]
    async fn gate_subscription_forwards_frames_in_envelopes() {
        let (origin, server) = fake_gate().await;
        let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let cancel = CancellationToken::new();
        let mut subs = GateSubs::new();
        subs.ensure("work-1", &origin, &None, &out_tx, &cancel);
        let first = tokio::time::timeout(Duration::from_secs(5), out_rx.recv())
            .await
            .expect("frame timeout")
            .expect("channel closed");
        let v: serde_json::Value = serde_json::from_str(&first).unwrap();
        assert_eq!(v["type"], "frame");
        assert_eq!(v["sessionId"], "work-1");
        assert_eq!(v["payload"]["type"], "text");
        assert_eq!(v["payload"]["text"], "hi");
        let second = tokio::time::timeout(Duration::from_secs(5), out_rx.recv())
            .await
            .expect("done frame timeout")
            .expect("channel closed");
        let v: serde_json::Value = serde_json::from_str(&second).unwrap();
        assert_eq!(v["payload"]["type"], "done");
        // done 后订阅仍在（60s linger），ensure 幂等命中不重开。
        assert_eq!(subs.map.len(), 1);
        subs.abort_all();
        cancel.cancel();
        server.abort();
    }

    #[tokio::test]
    async fn gate_subs_are_idempotent_and_abort_all_clears() {
        let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let cancel = CancellationToken::new();
        let mut subs = GateSubs::new();
        // 指向一个不存在的内核端口：订阅任务会进入重试循环但不 panic。
        subs.ensure("work-1", "http://127.0.0.1:1", &None, &out_tx, &cancel);
        assert_eq!(subs.map.len(), 1);
        subs.ensure("work-1", "http://127.0.0.1:1", &None, &out_tx, &cancel);
        assert_eq!(subs.map.len(), 1, "ensure must be idempotent");
        // 非法 sessionId 不建订阅。
        subs.ensure("../evil", "http://127.0.0.1:1", &None, &out_tx, &cancel);
        assert_eq!(subs.map.len(), 1);
        subs.abort_all();
        assert!(subs.map.is_empty());
        cancel.cancel();
        drop(out_tx);
        assert!(out_rx.recv().await.is_none());
    }

    // ── 错误分类 ──

    // ── 启动就绪闸门（生产事故回归）──
    //
    // 事故：backend_ready 用 send(true) 广播，device_link 晚于广播 subscribe，
    // 通知被 tokio watch 静默丢弃，link_loop 永久卡在闸门 → 设备表始终为空。

    #[test]
    fn kernel_gate_truth_table() {
        assert_eq!(kernel_gate(true, false), KernelGate::Ready);
        // 就绪后转发失败属于另一回事（回 502），优先级必须高于 failed。
        assert_eq!(kernel_gate(true, true), KernelGate::Ready);
        assert_eq!(kernel_gate(false, true), KernelGate::Failed);
        assert_eq!(kernel_gate(false, false), KernelGate::Wait);
    }

    #[test]
    fn watch_send_without_receiver_drops_value_but_send_replace_keeps_it() {
        // 复刻 lib.rs 修复前的竞速：广播时还没有任何订阅者。
        let (tx, _rx) = tokio::sync::watch::channel(false);
        // 把初始 receiver 丢掉，模拟 device_link 尚未被拉起。
        drop(_rx);
        assert!(tx.send(true).is_err(), "send() must fail with zero receivers");
        assert!(!*tx.borrow(), "failed send() must NOT update the watched value");
        // 晚到的订阅者只看到 false —— 这正是旧实现永久卡死的根因。
        let late = tx.subscribe();
        assert!(!*late.borrow());

        // 修复口径：send_replace 无论有无 receiver 都写入，晚到订阅者立刻见 true。
        let (tx2, rx2) = tokio::sync::watch::channel(false);
        drop(rx2);
        tx2.send_replace(true);
        let late2 = tx2.subscribe();
        assert!(*late2.borrow(), "late subscriber must see the ready broadcast");
    }

    #[test]
    fn auth_errors_are_classified_for_the_link_loop() {
        assert!(matches!(
            classify_auth_error("Unauthorized [AUTH_SESSION_REVOKED]"),
            LinkError::Terminal(_)
        ));
        assert!(matches!(classify_auth_error("尚未登录"), LinkError::Terminal(_)));
        assert!(matches!(
            classify_auth_error("无法连接后台: timeout"),
            LinkError::Transient(_)
        ));
        let e = anyhow::anyhow!("WebSocket handshake failed: HTTP error: 401 Unauthorized");
        assert!(matches!(classify_ws_error(&e), LinkError::Unauthorized));
        let e = anyhow::anyhow!("connection reset");
        assert!(matches!(classify_ws_error(&e), LinkError::Transient(_)));
    }
}
