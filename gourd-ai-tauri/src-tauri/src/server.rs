//! server.rs - 本地 UI 服务器 + 反向代理（Rust 版，对应 Electron 版 main/ui-server.js）
//!
//! 设计目标：把 UI（HTML/JS/CSS）从后端 jar 中解耦，由 Tauri 进程起一个轻量 HTTP
//! 服务立即提供，使界面外壳「秒开」，不必等待 JVM+Solon 启动。
//!
//! 路由规则（页面加载于 http://127.0.0.1:{uiPort}/）：
//!   - /web/**、/chat/channel/**  → 反向代理到 http://127.0.0.1:{backendPort}（jar）
//!   - WebSocket 升级（/web/gate）→ 先与后端完成真实握手，把后端的 101（含
//!     Sec-WebSocket-Accept）原样回给页面，再接管 socket 做双向字节透传
//!   - 其它路径                    → 从本地 UI 目录读取静态文件（路径穿越防护 + index.html 回退）
//!
//! 后端未就绪时代理请求仅宽限 PROXY_GRACE_MS（1.5s），随后快速 503，绝不长时间占用连接。

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

/// 反向代理普通 HTTP 请求到后端 jar（axum handler）。
async fn proxy_http(
    axum::extract::State(ctx): axum::extract::State<Arc<UiCtx>>,
    req: Request,
) -> Response {
    if !ctx.await_backend(Duration::from_millis(PROXY_GRACE_MS)).await {
        return service_unavailable();
    }
    let backend_port = ctx.backend_port();
    if backend_port == 0 {
        return service_unavailable();
    }

    let (parts, body) = req.into_parts();
    let method = parts.method.clone();
    let path_q = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let url = format!("http://127.0.0.1:{}{}", backend_port, path_q);

    // 过滤逐跳头，重建 host
    let mut out_headers = HeaderMap::new();
    for (k, v) in parts.headers.iter() {
        if is_hop_by_header(k.as_str()) || k.as_str().eq_ignore_ascii_case("host") {
            continue;
        }
        out_headers.insert(k, v.clone());
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
    if !ctx.await_backend(Duration::from_millis(PROXY_GRACE_MS)).await {
        return Ok(service_unavailable());
    }
    let backend_port = ctx.backend_port();
    if backend_port == 0 {
        return Ok(service_unavailable());
    }

    let method = req.method().to_string();
    let path_q = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let headers = req.headers().clone();

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
