//! mcp — Model Context Protocol client.
//!
//! Supports stdio and HTTP (SSE/streamable) transports. MCP servers registered
//! in settings expose additional tools to the agent.
//!
//! Config format (settings.json → "mcpServers"):
//! ```json
//! { "name": { "type": "stdio", "command": "npx", "args": ["-y", "server"] } }
//! ```
//!
//! ## Compatibility with the Java kernel (same settings.json)
//!
//! Two rules here are load-bearing, and violating either one silently disables
//! *every* MCP server rather than failing loudly:
//!
//! 1. **Every field must have a default.** `load_mcp_servers` deserializes the
//!    whole `mcpServers` map in one call; if a single entry is missing a field
//!    that lacks `#[serde(default)]`, the entire map fails to parse and the
//!    caller's `unwrap_or_default()` yields an empty map. The UI does not write
//!    `transport` at all (it writes `type`), which is exactly how this broke.
//! 2. **The kind key is `type`, with `transport` as a legacy fallback.** The UI
//!    and the Java kernel both write `type`; older hand-written configs may use
//!    `transport`. `resolved_type()` implements the same precedence as Java's
//!    `McpServerParameters.getTypeOrTransport()`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tracing::{info, warn};

/* ─────────────────── Type aliases (ports Java McpTypeResolver) ─────────────────── */

/// Standard kind: local child process over stdio.
pub const TYPE_STDIO: &str = "stdio";
/// Standard kind: Server-Sent Events.
pub const TYPE_SSE: &str = "sse";
/// Standard kind: streamable HTTP.
pub const TYPE_STREAMABLE: &str = "streamable";
/// Standard kind: stateless streamable HTTP.
pub const TYPE_STREAMABLE_STATELESS: &str = "streamable_stateless";

/// External spelling → standard kind. Configs imported from other tools use any
/// of these; converging them here keeps the rest of the kernel free of alias
/// checks. Mirrors `McpTypeResolver.ALIAS_MAP`.
fn alias_map() -> &'static [(&'static str, &'static str)] {
    &[
        ("stdio", TYPE_STDIO),
        ("local", TYPE_STDIO),
        ("sse", TYPE_SSE),
        ("ssehttp", TYPE_SSE),
        ("sse_http", TYPE_SSE),
        ("sse-http", TYPE_SSE),
        ("streamable", TYPE_STREAMABLE),
        ("streamablehttp", TYPE_STREAMABLE),
        ("streamable_http", TYPE_STREAMABLE),
        ("streamable-http", TYPE_STREAMABLE),
        ("http", TYPE_STREAMABLE),
        ("remote", TYPE_STREAMABLE),
        ("streamable_stateless", TYPE_STREAMABLE_STATELESS),
    ]
}

/// Normalize a kind spelling. Empty input yields `None`; an unrecognized value is
/// returned unchanged (tolerant, matching Java) so `is_valid` can reject it with
/// a useful message instead of a confusing "unknown alias".
pub fn standardize(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    let lower = t.to_lowercase();
    for (alias, std) in alias_map() {
        if lower == *alias {
            return Some((*std).to_string());
        }
    }
    Some(t.to_string())
}

/// Is this one of the four standard kinds?
pub fn is_valid(kind: &str) -> bool {
    matches!(
        standardize(kind).as_deref(),
        Some(TYPE_STDIO) | Some(TYPE_SSE) | Some(TYPE_STREAMABLE) | Some(TYPE_STREAMABLE_STATELESS)
    )
}

/// Is this a stdio (local process) server?
pub fn is_stdio(kind: &str) -> bool {
    standardize(kind).as_deref() == Some(TYPE_STDIO)
}

/// Is this an HTTP-family server (sse / streamable / streamable_stateless)?
pub fn is_http_type(kind: &str) -> bool {
    matches!(
        standardize(kind).as_deref(),
        Some(TYPE_SSE) | Some(TYPE_STREAMABLE) | Some(TYPE_STREAMABLE_STATELESS)
    )
}

/// MCP server configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct McpServerConfig {
    /// Kind as written by the UI / Java kernel (`"type"`).
    #[serde(rename = "type")]
    pub kind: String,
    /// Legacy spelling, honoured only when `kind` is empty.
    pub transport: String,
    /// Whether the agent should connect this server.
    pub enabled: bool,
    /// `"user"` | `"workspace"`.
    pub scope: String,
    /// Command to spawn (stdio only).
    pub command: String,
    /// Command arguments (stdio only).
    pub args: Vec<String>,
    /// Environment variables (stdio only).
    pub env: HashMap<String, String>,
    /// URL (http family only).
    pub url: String,
    /// Custom headers (http family only).
    pub headers: HashMap<String, String>,
    /// Optional outbound proxy for this HTTP MCP server, e.g.
    /// `http://127.0.0.1:7890`. Java has the same per-server knob
    /// (`McpClientProperties.httpProxy`). The built-in `codesearch` tool sets
    /// this from `settings.general.webProxy` so the keyless Exa endpoint stays
    /// reachable on networks where a direct connection is blocked.
    pub proxy: String,
    /// Request timeout, e.g. `"120s"`.
    pub timeout: String,
    /// Per-server tool denylist, edited from the MCP tools panel
    /// (`/web/settings/mcp/servers/tools/save`). Persisted with the server entry.
    #[serde(rename = "disallowedTools")]
    pub disallowed_tools: Vec<String>,
}

impl Default for McpServerConfig {
    fn default() -> Self {
        Self {
            kind: String::new(),
            transport: String::new(),
            // Absent means enabled: a server the user configured but never
            // toggled must still connect.
            enabled: true,
            scope: "user".into(),
            command: String::new(),
            args: Vec::new(),
            env: HashMap::new(),
            url: String::new(),
            headers: HashMap::new(),
            proxy: String::new(),
            timeout: String::new(),
            disallowed_tools: Vec::new(),
        }
    }
}

impl McpServerConfig {
    /// Effective kind, with `type` preferred over the legacy `transport`.
    /// Falls back to `stdio` when neither is present — the same default the Java
    /// kernel applies when listing servers.
    pub fn resolved_type(&self) -> String {
        let raw = if !self.kind.trim().is_empty() {
            self.kind.as_str()
        } else {
            self.transport.as_str()
        };
        standardize(raw).unwrap_or_else(|| TYPE_STDIO.to_string())
    }

    pub fn is_stdio(&self) -> bool {
        self.resolved_type() == TYPE_STDIO
    }
}

/// A tool exposed by an MCP server.
#[derive(Debug, Clone)]
pub struct McpTool {
    pub server_name: String,
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

/// Active MCP connection (stdio child process).
struct StdioConnection {
    child: Child,
    stdin: tokio::process::ChildStdin,
    stdout_lines: BufReader<tokio::process::ChildStdout>,
    next_id: u64,
}

/// One parsed Server-Sent Events frame.
#[derive(Debug, Clone, PartialEq)]
struct SseEvent {
    /// Value of the `event:` field; SSE defaults it to "message".
    event: String,
    /// Concatenated `data:` lines, newline-joined per the SSE spec.
    data: String,
}

/// Active MCP connection over HTTP (streamable or legacy SSE).
struct HttpConnection {
    client: reqwest::Client,
    /// Where JSON-RPC requests are POSTed. For `streamable` this is the
    /// configured URL; for `sse` it is the endpoint the server announced over
    /// the GET stream (resolved against the configured URL, since servers may
    /// announce a relative path).
    post_url: String,
    /// `Mcp-Session-Id` from the initialize response, echoed on later requests.
    session_id: Option<String>,
    next_id: u64,
    /// Legacy SSE only: responses arrive on the GET stream, not on the POST
    /// reply, so they are read from here.
    sse_rx: Option<tokio::sync::mpsc::UnboundedReceiver<SseEvent>>,
    /// Keeps the GET stream alive. Dropping the handle does not abort the task,
    /// so `disconnect_one` aborts it explicitly.
    sse_task: Option<tokio::task::JoinHandle<()>>,
}

/// A live connection, whichever transport produced it.
enum Connection {
    Stdio(StdioConnection),
    Http(HttpConnection),
}

/// MCP client manager.
pub struct McpManager {
    connections: Mutex<HashMap<String, Connection>>,
    tools: Mutex<Vec<McpTool>>,
}

impl McpManager {
    pub fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            tools: Mutex::new(Vec::new()),
        }
    }

    /// Connect to all configured MCP servers and discover their tools.
    pub async fn connect_all(&self, servers: &HashMap<String, McpServerConfig>) {
        for (name, config) in servers {
            if !config.enabled {
                continue;
            }
            match self.connect_one(name, config).await {
                Ok(n) => info!(server = %name, tools = n, "MCP server connected"),
                Err(e) => warn!(server = %name, error = %e, "MCP connection failed"),
            }
        }
    }

    /// Connect (or reconnect) a single server and register its tools.
    ///
    /// Called after every settings mutation — add / update / toggle — so a newly
    /// configured server becomes usable without a restart. The Java kernel does
    /// the same via `engine.addMcpServer`. Idempotent: any previous connection
    /// for this name is torn down first.
    ///
    /// Returns the number of tools discovered.
    pub async fn connect_one(&self, name: &str, config: &McpServerConfig) -> anyhow::Result<usize> {
        self.disconnect_one(name).await;
        if !config.enabled {
            return Ok(0);
        }
        match config.resolved_type().as_str() {
            TYPE_STDIO | TYPE_STREAMABLE | TYPE_STREAMABLE_STATELESS | TYPE_SSE => {
                self.connect_and_register(name, config).await
            }
            other => anyhow::bail!("unsupported MCP transport '{}'", other),
        }
    }

    /// Whether a live connection exists for `name`.
    ///
    /// Used by the built-in `codesearch` tool to avoid re-running the MCP
    /// initialize handshake on every call. `connect_one` deliberately tears
    /// down first (`disconnect_one` at `:260`), so callers that want reuse must
    /// gate on this.
    pub async fn is_connected(&self, name: &str) -> bool {
        self.connections.lock().await.contains_key(name)
    }

    /// Tear down one server: kill its child process / abort its stream task and
    /// drop its tools.
    ///
    /// Must be called on remove *and* before reconnect, otherwise the old child
    /// process survives (a leaked `npx`/`node` per edit) and its tools stay
    /// callable under a name the user just deleted.
    pub async fn disconnect_one(&self, name: &str) {
        // Lock order is always tools → connections, and the two are never held at
        // once; disconnect_one follows the same order as connect_stdio.
        self.tools.lock().await.retain(|t| t.server_name != name);
        let conn = self.connections.lock().await.remove(name);
        match conn {
            Some(Connection::Stdio(mut conn)) => {
                let _ = conn.child.kill().await;
                let _ = conn.child.wait().await;
            }
            Some(Connection::Http(conn)) => {
                // Dropping the receiver closes the channel, which ends the reader
                // task; abort as well so a blocked network read does not linger.
                if let Some(task) = conn.sse_task {
                    task.abort();
                }
            }
            None => {}
        }
    }

    /// Open a connection of any transport and complete the MCP handshake.
    ///
    /// The handshake is identical across transports (initialize → initialized
    /// notification), so it lives here once rather than in three copies that
    /// could drift apart.
    async fn open_connection(&self, config: &McpServerConfig) -> anyhow::Result<Connection> {
        match config.resolved_type().as_str() {
            TYPE_STDIO => Ok(Connection::Stdio(Self::open_stdio(config).await?)),
            TYPE_STREAMABLE | TYPE_STREAMABLE_STATELESS => {
                Ok(Connection::Http(Self::open_streamable(config).await?))
            }
            TYPE_SSE => Ok(Connection::Http(Self::open_sse(config).await?)),
            other => anyhow::bail!("unsupported MCP transport '{}'", other),
        }
    }

    /// Handshake, list tools, register. Shared by every transport.
    ///
    /// On any failure the half-open connection is torn down: leaving it in
    /// `self.connections` would make `call_tool` believe a server is reachable
    /// when its handshake never completed.
    async fn connect_and_register(
        &self,
        name: &str,
        config: &McpServerConfig,
    ) -> anyhow::Result<usize> {
        let mut conn = self.open_connection(config).await?;
        let listed = Self::rpc(&mut conn, "tools/list", serde_json::json!({})).await;
        let tools = match listed {
            Ok(result) => parse_tools(name, &result),
            Err(e) => {
                Self::drop_connection(conn).await;
                return Err(e);
            }
        };
        let count = tools.len();
        {
            let mut all = self.tools.lock().await;
            all.retain(|t| t.server_name != name);
            all.extend(tools);
        }
        self.connections.lock().await.insert(name.to_string(), conn);
        Ok(count)
    }

    /// Release a connection's OS resources without touching the registry.
    async fn drop_connection(conn: Connection) {
        match conn {
            Connection::Stdio(mut c) => {
                let _ = c.child.kill().await;
                let _ = c.child.wait().await;
            }
            Connection::Http(c) => {
                if let Some(task) = c.sse_task {
                    task.abort();
                }
            }
        }
    }

    /// Spawn a stdio child and complete the handshake. Returns the tool count.
    async fn open_stdio(config: &McpServerConfig) -> anyhow::Result<StdioConnection> {
        if config.command.trim().is_empty() {
            anyhow::bail!("命令不能为空");
        }
        let mut cmd = Command::new(&config.command);
        cmd.args(&config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // GUI host: MCP servers are often console-subsystem binaries (node
        // shims, uvx, npx); without CREATE_NO_WINDOW each connect flashes a
        // black console window.
        #[cfg(windows)]
        {
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        for (k, v) in &config.env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn()?;
        let stdin = child.stdin.take().ok_or_else(|| anyhow::anyhow!("no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow::anyhow!("no stdout"))?;
        let stdout_lines = BufReader::new(stdout);

        let mut conn = StdioConnection { child, stdin, stdout_lines, next_id: 1 };

        Self::rpc_stdio(&mut conn, "initialize", Self::initialize_params()).await?;
        Self::notify_stdio(&mut conn, "notifications/initialized").await?;
        Ok(conn)
    }

    /// The `initialize` params, identical for every transport.
    fn initialize_params() -> serde_json::Value {
        serde_json::json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            // Version comes from the workspace package, not a literal: a stale
            // number here is invisible (servers only log it) yet misleading.
            "clientInfo": { "name": "gwork", "version": env!("CARGO_PKG_VERSION") }
        })
    }

    /// Send a JSON-RPC request over stdio and wait for the matching response.
    async fn rpc_stdio(conn: &mut StdioConnection, method: &str, params: serde_json::Value) -> anyhow::Result<serde_json::Value> {
        let id = conn.next_id;
        conn.next_id += 1;
        let req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let mut line = serde_json::to_string(&req)?;
        line.push('\n');
        conn.stdin.write_all(line.as_bytes()).await?;
        conn.stdin.flush().await?;

        // Read lines until we get our response
        let mut buf = String::new();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            if tokio::time::Instant::now() > deadline {
                anyhow::bail!("MCP RPC timeout for method {}", method);
            }
            buf.clear();
            let n = tokio::time::timeout(
                std::time::Duration::from_secs(10),
                conn.stdout_lines.read_line(&mut buf),
            ).await??;
            if n == 0 { anyhow::bail!("MCP server closed stdout"); }
            let trimmed = buf.trim();
            if trimmed.is_empty() { continue; }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
                if v["id"] == serde_json::json!(id) {
                    if let Some(err) = v.get("error") {
                        if !err.is_null() {
                            anyhow::bail!("MCP error: {}", err);
                        }
                    }
                    return Ok(v["result"].clone());
                }
            }
        }
    }

    /// Call a tool on an MCP server.
    pub async fn call_tool(&self, server_name: &str, tool_name: &str, args: serde_json::Value) -> anyhow::Result<String> {
        let mut conns = self.connections.lock().await;
        let conn = conns.get_mut(server_name)
            .ok_or_else(|| anyhow::anyhow!("MCP server not connected: {}", server_name))?;
        let result = Self::rpc(conn, "tools/call", serde_json::json!({
            "name": tool_name,
            "arguments": args,
        })).await?;
        // Extract text content
        let content = result["content"].as_array();
        if let Some(arr) = content {
            let texts: Vec<&str> = arr.iter()
                .filter(|c| c["type"] == "text")
                .filter_map(|c| c["text"].as_str())
                .collect();
            return Ok(texts.join("\n"));
        }
        Ok(serde_json::to_string(&result).unwrap_or_default())
    }

    /// Dispatch a JSON-RPC call over whichever transport the connection uses.
    async fn rpc(conn: &mut Connection, method: &str, params: serde_json::Value) -> anyhow::Result<serde_json::Value> {
        match conn {
            Connection::Stdio(c) => Self::rpc_stdio(c, method, params).await,
            Connection::Http(c) => Self::rpc_http(c, method, params).await,
        }
    }

    /// Send a JSON-RPC notification (no id, no reply) over stdio.
    async fn notify_stdio(conn: &mut StdioConnection, method: &str) -> anyhow::Result<()> {
        let notif = serde_json::json!({"jsonrpc": "2.0", "method": method});
        let mut line = serde_json::to_string(&notif)?;
        line.push('\n');
        conn.stdin.write_all(line.as_bytes()).await?;
        conn.stdin.flush().await?;
        Ok(())
    }

    // ─── HTTP transports (streamable + legacy SSE) ───────────────────────────
    //
    // Both speak JSON-RPC 2.0 over HTTP. They differ in where the reply arrives:
    //   * **streamable** — POST a request, the reply is in that POST's body
    //     (either `application/json` or a one-shot `text/event-stream`).
    //   * **legacy SSE** — a long-lived GET stream is opened first; the server
    //     announces a POST endpoint on it via an `endpoint` event, and every
    //     reply comes back over the GET stream, not the POST body.

    /// Build a reqwest client honouring the server's custom headers and timeout.
    fn http_client(config: &McpServerConfig) -> anyhow::Result<reqwest::Client> {
        let mut headers = reqwest::header::HeaderMap::new();
        for (k, v) in &config.headers {
            // Custom headers usually carry auth (Bearer tokens, API keys). One
            // that fails to parse must abort the connect rather than silently
            // drop the credential and surface later as a confusing 401.
            let name = reqwest::header::HeaderName::from_bytes(k.as_bytes())
                .map_err(|e| anyhow::anyhow!("invalid header name {:?}: {}", k, e))?;
            let value = reqwest::header::HeaderValue::from_str(v)
                .map_err(|e| anyhow::anyhow!("invalid header value for {:?}: {}", k, e))?;
            headers.insert(name, value);
        }
        Ok(Self::client_builder(config)?
            .timeout(parse_timeout(&config.timeout))
            .default_headers(headers)
            .build()?)
    }

    /// Apply the per-server proxy. Kept separate from both client builders so
    /// the two cannot drift: an SSE stream and its POSTs must use the same
    /// egress path.
    ///
    /// When no explicit proxy is set we leave reqwest's `auto_sys_proxy`
    /// enabled. It reads `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`
    /// with the correct scheme matching. Resolving the env vars by hand and
    /// calling `Proxy::all` would (a) disable that automatic handling
    /// (`reqwest` client.rs:1416), (b) drop `NO_PROXY` (`proxy.rs:261`), and
    /// (c) apply an HTTP-only proxy to HTTPS targets.
    fn client_builder(config: &McpServerConfig) -> anyhow::Result<reqwest::ClientBuilder> {
        let mut b = reqwest::Client::builder();
        let chosen = config.proxy.trim();
        if !chosen.is_empty() {
            match reqwest::Proxy::all(chosen) {
                Ok(p) => {
                    // Preserve NO_PROXY even for an explicit override, so local
                    // MCP servers are not unexpectedly tunnelled.
                    b = b.proxy(p.no_proxy(reqwest::NoProxy::from_env()));
                }
                Err(e) => {
                    // A typo must not make every tool fail with a cryptic
                    // builder error; log and continue direct.
                    tracing::warn!(proxy = %chosen, error = %e, "invalid MCP proxy; continuing direct");
                }
            }
        }
        Ok(b)
    }

    /// Same as [`Self::http_client`] but with **no whole-request timeout**.
    ///
    /// reqwest's `.timeout()` is a total cap that includes the streaming body,
    /// so a client built with one kills a long-lived SSE GET at the timeout
    /// mark — the legacy-SSE connection then fails every subsequent RPC with
    /// "stream closed" with nothing in the logs pointing at the cause. POSTs
    /// must keep the cap (they are request/response); only the GET stream
    /// needs this variant.
    fn http_client_no_total_timeout(config: &McpServerConfig) -> anyhow::Result<reqwest::Client> {
        let mut headers = reqwest::header::HeaderMap::new();
        for (k, v) in &config.headers {
            let name = reqwest::header::HeaderName::from_bytes(k.as_bytes())
                .map_err(|e| anyhow::anyhow!("invalid header name {:?}: {}", k, e))?;
            let value = reqwest::header::HeaderValue::from_str(v)
                .map_err(|e| anyhow::anyhow!("invalid header value for {:?}: {}", k, e))?;
            headers.insert(name, value);
        }
        // Connect timeout still applies: a server that never accepts the TCP
        // connection must fail in bounded time, same as every other client here.
        Ok(Self::client_builder(config)?
            .connect_timeout(std::time::Duration::from_secs(30))
            .default_headers(headers)
            .build()?)
    }

    /// Open a streamable-HTTP connection: POST initialize, capture the session id.
    async fn open_streamable(config: &McpServerConfig) -> anyhow::Result<HttpConnection> {
        if config.url.trim().is_empty() {
            anyhow::bail!("URL 不能为空");
        }
        let client = Self::http_client(config)?;
        let mut conn = HttpConnection {
            client,
            post_url: config.url.clone(),
            session_id: None,
            next_id: 1,
            sse_rx: None,
            sse_task: None,
        };
        // The session id arrives as a response header on initialize and must be
        // echoed on every later request, so it is captured before parsing the body.
        let resp = Self::http_post_raw(&conn, "initialize", 1, Self::initialize_params()).await?;
        conn.session_id = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        Self::read_rpc_body(resp, 1).await?;
        Self::http_notify(&conn, "notifications/initialized").await?;
        Ok(conn)
    }

    /// Open a legacy-SSE connection: GET the stream, learn the POST endpoint,
    /// then handshake over it.
    async fn open_sse(config: &McpServerConfig) -> anyhow::Result<HttpConnection> {
        if config.url.trim().is_empty() {
            anyhow::bail!("URL 不能为空");
        }
        // The GET stream is a long-lived connection: it must NOT share the
        // client-level whole-request timeout the POSTs use, or the stream is
        // silently killed at `timeout` seconds and every later RPC fails with
        // "stream closed" (reqwest's `.timeout()` covers the streaming body,
        // not just the handshake). Same client, same headers, no total cap —
        // `rpc_http` already enforces its own per-call reply deadline.
        let client = Self::http_client_no_total_timeout(config)?;
        let resp = client
            .get(&config.url)
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("MCP SSE GET returned {} for {}: {}", status, config.url, truncate(&text, 200));
        }
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<SseEvent>();
        let task = tokio::spawn(async move { pump_sse(resp, tx).await });

        // The server announces where to POST via an `endpoint` event. It may be a
        // relative path, so resolve it against the configured URL.
        //
        // Every early-exit path below must abort the pump task: it holds the GET
        // connection open and will otherwise leak a task + socket per failed
        // connect attempt (the POSTs reuse a DIFFERENT client, so dropping the
        // receiver alone does not unblock it until the server closes the stream).
        let post_url = loop {
            let ev = match tokio::time::timeout(std::time::Duration::from_secs(30), rx.recv()).await {
                Err(_) => {
                    task.abort();
                    anyhow::bail!("timed out waiting for the SSE endpoint event")
                }
                Ok(None) => {
                    task.abort();
                    anyhow::bail!("SSE stream closed before announcing an endpoint")
                }
                Ok(Some(ev)) => ev,
            };
            if ev.event == "endpoint" {
                // A malformed endpoint URL must still abort the pump task before
                // propagating — it holds the GET connection open.
                match resolve_url(&config.url, &ev.data) {
                    Ok(u) => break u,
                    Err(e) => {
                        task.abort();
                        return Err(e);
                    }
                }
            }
        };

        let mut conn = HttpConnection {
            client,
            post_url,
            session_id: None,
            next_id: 1,
            sse_rx: Some(rx),
            sse_task: Some(task),
        };
        // Handshake failures must abort the pump too — the `?` below used to
        // return with the task still running.
        if let Err(e) = Self::rpc_http(&mut conn, "initialize", Self::initialize_params()).await {
            if let Some(t) = conn.sse_task.take() {
                t.abort();
            }
            return Err(e);
        }
        if let Err(e) = Self::http_notify(&conn, "notifications/initialized").await {
            if let Some(t) = conn.sse_task.take() {
                t.abort();
            }
            return Err(e);
        }
        Ok(conn)
    }

    /// POST a JSON-RPC message and return the raw response for body parsing.
    async fn http_post_raw(
        conn: &HttpConnection,
        method: &str,
        id: u64,
        params: serde_json::Value,
    ) -> anyhow::Result<reqwest::Response> {
        let body = serde_json::json!({
            "jsonrpc": "2.0", "id": id, "method": method, "params": params,
        });
        Self::http_post_body(conn, body).await
    }

    /// POST an arbitrary JSON-RPC body (request or notification).
    async fn http_post_body(
        conn: &HttpConnection,
        body: serde_json::Value,
    ) -> anyhow::Result<reqwest::Response> {
        let mut req = conn
            .client
            .post(&conn.post_url)
            .header(reqwest::header::ACCEPT, "application/json, text/event-stream")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .json(&body);
        if let Some(sid) = &conn.session_id {
            req = req.header("mcp-session-id", sid);
        }
        let resp = req.send().await?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("MCP HTTP {}: {}", status, truncate(&text, 300));
        }
        Ok(resp)
    }

    /// POST a notification (no id). The reply body is irrelevant; 202 is normal.
    async fn http_notify(conn: &HttpConnection, method: &str) -> anyhow::Result<()> {
        let notif = serde_json::json!({"jsonrpc": "2.0", "method": method});
        let _ = Self::http_post_body(conn, notif).await?;
        Ok(())
    }

    /// Parse a JSON-RPC reply body, which may be plain JSON or a one-shot SSE stream.
    ///
    /// The body is read incrementally with a hard cap rather than `resp.text()`:
    /// a server that answers a POST with an (infinite) SSE stream would otherwise
    /// hold the call until the whole-request timeout — a full minute of silent
    /// hang per RPC that looks identical to a dead server from the outside.
    async fn read_rpc_body(resp: reqwest::Response, want_id: u64) -> anyhow::Result<serde_json::Value> {
        const MAX_RPC_BODY_BYTES: u64 = 8 * 1024 * 1024;
        let ctype = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        // Incremental read with a cap: bounded memory, and a stream-style body
        // errors out as soon as the cap is crossed instead of hanging.
        let mut body = Vec::new();
        {
            use futures_util::StreamExt;
            let mut stream = resp.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk?;
                if body.len() as u64 + chunk.len() as u64 > MAX_RPC_BODY_BYTES {
                    anyhow::bail!(
                        "MCP reply body exceeded {} bytes; the server is likely streaming on a POST",
                        MAX_RPC_BODY_BYTES
                    );
                }
                body.extend_from_slice(&chunk);
                // A one-shot SSE reply is complete once an event carrying the
                // wanted id has arrived — stop reading instead of waiting for the
                // server to close the stream.
                if ctype.contains("text/event-stream") {
                    if let Ok(text) = std::str::from_utf8(&body) {
                        for ev in parse_sse_events(text) {
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&ev.data) {
                                if v["id"] == serde_json::json!(want_id) {
                                    return check_rpc_error(v);
                                }
                            }
                        }
                    }
                }
            }
        }
        let text = crate::textcodec::decode_bytes(&body);
        if ctype.contains("text/event-stream") {
            for ev in parse_sse_events(&text) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&ev.data) {
                    if v["id"] == serde_json::json!(want_id) {
                        return check_rpc_error(v);
                    }
                }
            }
            anyhow::bail!("MCP SSE reply carried no result for id {}", want_id);
        }
        if text.trim().is_empty() {
            anyhow::bail!("MCP reply for id {} was empty", want_id);
        }
        let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
            anyhow::anyhow!("MCP reply was not JSON: {} ({})", e, truncate(&text, 200))
        })?;
        check_rpc_error(v)
    }

    /// JSON-RPC over an HTTP connection, handling both reply routes.
    async fn rpc_http(
        conn: &mut HttpConnection,
        method: &str,
        params: serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        let id = conn.next_id;
        conn.next_id += 1;
        // Decide the reply route before borrowing `sse_rx` mutably, so the POST
        // (an immutable borrow) does not overlap the mutable one.
        let legacy_sse = conn.sse_rx.is_some();
        let resp = Self::http_post_raw(conn, method, id, params).await?;
        if !legacy_sse {
            return Self::read_rpc_body(resp, id).await;
        }
        // Legacy SSE: the POST returns 202 with no useful body; the reply arrives
        // on the GET stream. Drop the POST response and read from the channel.
        drop(resp);
        let rx = conn.sse_rx.as_mut().expect("legacy_sse implies sse_rx is Some");
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(60);
        loop {
            if tokio::time::Instant::now() > deadline {
                anyhow::bail!("MCP SSE timeout waiting for the reply to {}", method);
            }
            let ev = tokio::time::timeout(std::time::Duration::from_secs(30), rx.recv())
                .await?
                .ok_or_else(|| {
                    anyhow::anyhow!("SSE stream closed while awaiting the reply to {}", method)
                })?;
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&ev.data) {
                if v["id"] == serde_json::json!(id) {
                    return check_rpc_error(v);
                }
            }
        }
    }

    /// Get all discovered tools.
    pub async fn all_tools(&self) -> Vec<McpTool> {
        self.tools.lock().await.clone()
    }

    /// Tools already discovered for one server.
    pub async fn tools_of(&self, server_name: &str) -> Vec<McpTool> {
        self.tools
            .lock()
            .await
            .iter()
            .filter(|t| t.server_name == server_name)
            .cloned()
            .collect()
    }

    /// One-shot connection probe: open, handshake, list tools, then tear down.
    ///
    /// Used by `/web/settings/mcp/servers/check` ("test this config before
    /// saving") and `/web/settings/mcp/servers/tools` when the server is not
    /// currently connected. Deliberately does **not** register the connection in
    /// `self.connections`: a probe must not leave a child process or a live SSE
    /// stream behind, and the caller decides separately whether to enable the
    /// server. Works for every transport because it reuses `open_connection`.
    pub async fn probe(&self, name: &str, config: &McpServerConfig) -> anyhow::Result<Vec<McpTool>> {
        let mut conn = self.open_connection(config).await?;
        let listed = Self::rpc(&mut conn, "tools/list", serde_json::json!({})).await;
        // Any failure below must still release the connection, otherwise a
        // mistyped command that happens to stay alive leaks a process (or an SSE
        // task) per probe attempt.
        let result = listed.map(|r| parse_tools(name, &r));
        Self::drop_connection(conn).await;
        result
    }

    /// Disconnect all servers.
    pub async fn shutdown(&self) {
        let mut conns = self.connections.lock().await;
        for (_, conn) in conns.drain() {
            Self::drop_connection(conn).await;
        }
    }
}

impl Default for McpManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Parse a `tools/list` result into `McpTool`s.
fn parse_tools(server_name: &str, tools_result: &serde_json::Value) -> Vec<McpTool> {
    tools_result["tools"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|t| {
                    Some(McpTool {
                        server_name: server_name.to_string(),
                        name: t["name"].as_str()?.to_string(),
                        description: t["description"].as_str().unwrap_or("").to_string(),
                        input_schema: t["inputSchema"].clone(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Parse a JSON-RPC reply, turning an `error` member into an `Err`.
///
/// A reply without `result` is an error too, not `Ok(Null)`: the callers feed
/// `v["result"]` into `parse_tools`/`call_tool`, and a silent Null made a
/// 200-response-with-garbage-body register as "connected, tools=0" — a false
/// success the settings UI then displays as working. Missing `error` + missing
/// `result` means the body was not a JSON-RPC reply at all; say so.
fn check_rpc_error(v: serde_json::Value) -> anyhow::Result<serde_json::Value> {
    if let Some(err) = v.get("error") {
        if !err.is_null() {
            anyhow::bail!("MCP error: {}", err);
        }
    }
    match v.get("result") {
        Some(result) => Ok(result.clone()),
        None => anyhow::bail!(
            "MCP reply had no result member (not a JSON-RPC response): {}",
            truncate(&v.to_string(), 200)
        ),
    }
}

/// Parse a timeout string like `"120s"` / `"500ms"` / `"2m"` into a Duration.
///
/// Falls back to 60s for an empty or unparseable value: a bad timeout must not
/// make the server unreachable, and 60s matches the fetch default elsewhere.
fn parse_timeout(raw: &str) -> std::time::Duration {
    let t = raw.trim();
    if t.is_empty() {
        return std::time::Duration::from_secs(60);
    }
    let (num, unit) = t.split_at(t.find(|c: char| !c.is_ascii_digit() && c != '.').unwrap_or(t.len()));
    let value: f64 = num.parse().unwrap_or(60.0);
    let secs = match unit.trim() {
        "ms" => value / 1000.0,
        "m" | "min" => value * 60.0,
        "h" => value * 3600.0,
        _ => value, // "s", "", or anything else → seconds
    };
    std::time::Duration::from_secs_f64(secs.max(0.001))
}

/// Resolve a possibly-relative URL against a base. Used for the SSE `endpoint`
/// event, which servers may announce as a path like `/messages?sid=1`.
fn resolve_url(base: &str, maybe_relative: &str) -> anyhow::Result<String> {
    let target = maybe_relative.trim();
    if target.starts_with("http://") || target.starts_with("https://") {
        return Ok(target.to_string());
    }
    let base_url = url::Url::parse(base)
        .map_err(|e| anyhow::anyhow!("invalid MCP base URL {:?}: {}", base, e))?;
    base_url
        .join(target)
        .map(|u| u.to_string())
        .map_err(|e| anyhow::anyhow!("cannot resolve {:?} against {:?}: {}", target, base, e))
}

/// Truncate to at most `max` chars for error messages (never split a char).
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{}…", cut)
    }
}

/// Parse a complete SSE document into events.
///
/// Per the SSE spec: events are separated by a blank line; within an event,
/// `field: value` lines accumulate, multiple `data:` lines join with `\n`, and
/// the default event name is `message`. A line starting with `:` is a comment
/// (keep-alive) and is ignored. This is a pure function so it is unit-testable
/// without a network.
fn parse_sse_events(text: &str) -> Vec<SseEvent> {
    let mut events = Vec::new();
    let mut event_name = String::new();
    let mut data_lines: Vec<String> = Vec::new();

    // Normalise CRLF/CR to LF so the blank-line separator works on any server.
    let normalised = text.replace("\r\n", "\n").replace('\r', "\n");
    for line in normalised.split('\n') {
        if line.is_empty() {
            // Blank line dispatches the accumulated event, if any.
            if !data_lines.is_empty() || !event_name.is_empty() {
                events.push(SseEvent {
                    event: if event_name.is_empty() { "message".to_string() } else { event_name.clone() },
                    data: data_lines.join("\n"),
                });
            }
            event_name.clear();
            data_lines.clear();
            continue;
        }
        if line.starts_with(':') {
            continue; // comment / keep-alive
        }
        let (field, value) = match line.find(':') {
            Some(i) => {
                let v = &line[i + 1..];
                // A single leading space after the colon is stripped per spec.
                (&line[..i], v.strip_prefix(' ').unwrap_or(v))
            }
            None => (line, ""),
        };
        match field {
            "event" => event_name = value.to_string(),
            "data" => data_lines.push(value.to_string()),
            _ => {} // id / retry are not needed for request/response correlation
        }
    }
    // A trailing event with no final blank line still counts.
    if !data_lines.is_empty() || !event_name.is_empty() {
        events.push(SseEvent {
            event: if event_name.is_empty() { "message".to_string() } else { event_name },
            data: data_lines.join("\n"),
        });
    }
    events
}

/// Read an SSE response body incrementally, forwarding each complete event.
///
/// Runs on a spawned task for the legacy-SSE GET stream. Ends when the stream
/// closes or the receiver is dropped (which `disconnect_one` does by aborting).
async fn pump_sse(resp: reqwest::Response, tx: tokio::sync::mpsc::UnboundedSender<SseEvent>) {
    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    // Incremental decoder instead of per-chunk `from_utf8_lossy`: a multi-byte
    // CJK character split across a TCP boundary produced U+FFFD halves, and the
    // corrupted event then failed JSON parsing and was silently DROPPED — a
    // tool description (or the endpoint event) arriving mid-boundary simply
    // never reached the consumer. The decoder holds a truncated trailing
    // sequence until the next chunk completes it (same fix as llm/client.rs).
    let mut decoder = crate::textcodec::StreamDecoder::new();
    while let Some(chunk) = stream.next().await {
        let bytes = match chunk {
            Ok(b) => b,
            Err(_) => break,
        };
        buf.push_str(&decoder.push(&bytes));
        // Dispatch every complete event (terminated by a blank line) and keep the
        // remainder buffered for the next chunk.
        while let Some(pos) = find_event_boundary(&buf) {
            let (head, rest) = buf.split_at(pos);
            for ev in parse_sse_events(head) {
                if tx.send(ev).is_err() {
                    return; // receiver dropped → connection torn down
                }
            }
            buf = rest.to_string();
        }
    }
}

/// Byte index just past the first blank-line event boundary, if present.
fn find_event_boundary(buf: &str) -> Option<usize> {
    // Accept both LF and CRLF blank lines. `if let`, not `for`: the loop body
    // only ever returned on the first iteration (clippy never_loop).
    if let Some((i, _)) = buf.match_indices("\n\n").next() {
        return Some(i + 2);
    }
    if let Some((i, _)) = buf.match_indices("\r\n\r\n").next() {
        return Some(i + 4);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The UI writes `type`, never `transport`. A config that only has `type`
    /// must still parse and resolve — this is the exact regression that made
    /// every MCP server silently disappear (the whole map failed to deserialize
    /// because `transport` had no default).
    #[test]
    fn parses_ui_shape_with_type_only() {
        let v = serde_json::json!({"type": "stdio", "command": "npx", "args": ["-y", "srv"]});
        let cfg: McpServerConfig = serde_json::from_value(v).expect("must parse without transport");
        assert_eq!(cfg.resolved_type(), TYPE_STDIO);
        assert!(cfg.is_stdio());
        assert!(cfg.enabled, "absent enabled must default to true");
        assert_eq!(cfg.args, vec!["-y".to_string(), "srv".to_string()]);
    }

    #[test]
    fn empty_object_parses_with_defaults() {
        let cfg: McpServerConfig = serde_json::from_value(serde_json::json!({})).expect("must parse");
        assert_eq!(cfg.resolved_type(), TYPE_STDIO);
        assert!(cfg.enabled);
        assert_eq!(cfg.scope, "user");
    }

    #[test]
    fn whole_map_survives_one_bad_entry() {
        // Regression guard for load_mcp_servers' old unwrap_or_default() path:
        // one malformed entry used to wipe the entire map.
        let v = serde_json::json!({
            "good": {"type": "stdio", "command": "npx"},
            "bad": "not-an-object"
        });
        let mut ok = 0;
        let mut bad = 0;
        for (_name, entry) in v.as_object().unwrap() {
            match serde_json::from_value::<McpServerConfig>(entry.clone()) {
                Ok(_) => ok += 1,
                Err(_) => bad += 1,
            }
        }
        assert_eq!((ok, bad), (1, 1));
    }

    #[test]
    fn legacy_transport_is_honoured() {
        let v = serde_json::json!({"transport": "sse", "url": "http://x"});
        let cfg: McpServerConfig = serde_json::from_value(v).unwrap();
        assert_eq!(cfg.resolved_type(), TYPE_SSE);
        assert!(!cfg.is_stdio());
        assert!(is_http_type(&cfg.resolved_type()));
    }

    #[test]
    fn type_wins_over_transport() {
        // Java's getTypeOrTransport() prefers `type`; matching that keeps the two
        // kernels in agreement on a shared settings.json.
        let v = serde_json::json!({"type": "stdio", "transport": "sse", "command": "npx"});
        let cfg: McpServerConfig = serde_json::from_value(v).unwrap();
        assert_eq!(cfg.resolved_type(), TYPE_STDIO);
    }

    #[test]
    fn aliases_standardize() {
        assert_eq!(standardize("local").as_deref(), Some(TYPE_STDIO));
        assert_eq!(standardize("SSE_HTTP").as_deref(), Some(TYPE_SSE));
        assert_eq!(standardize("remote").as_deref(), Some(TYPE_STREAMABLE));
        assert_eq!(standardize("http").as_deref(), Some(TYPE_STREAMABLE));
        assert_eq!(standardize("").as_deref(), None);
        // Unrecognized values pass through so is_valid can reject them clearly.
        assert_eq!(standardize("bogus").as_deref(), Some("bogus"));
        assert!(!is_valid("bogus"));
        assert!(is_valid("streamable_stateless"));
    }

    // ─── SSE parsing ────────────────────────────────────────────────────────
    //
    // These are the offline-testable core of the HTTP transports. A malformed
    // parse would silently drop every MCP reply, so each rule of the spec that
    // the parser implements is pinned here.

    #[test]
    fn parses_a_single_data_event() {
        let evs = parse_sse_events("data: {\"id\":1}\n\n");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].event, "message", "absent event: defaults to message");
        assert_eq!(evs[0].data, "{\"id\":1}");
    }

    #[test]
    fn parses_a_named_endpoint_event() {
        // The legacy-SSE handshake depends on recognizing `event: endpoint`.
        let evs = parse_sse_events("event: endpoint\ndata: /messages?sid=9\n\n");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].event, "endpoint");
        assert_eq!(evs[0].data, "/messages?sid=9");
    }

    #[test]
    fn multiple_data_lines_join_with_newline() {
        let evs = parse_sse_events("data: line1\ndata: line2\n\n");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].data, "line1\nline2");
    }

    #[test]
    fn comment_and_keepalive_lines_are_ignored() {
        // A leading colon is a comment; servers send these as keep-alives.
        let evs = parse_sse_events(": keep-alive\n\ndata: real\n\n");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].data, "real");
    }

    #[test]
    fn crlf_and_cr_line_endings_are_normalised() {
        let evs = parse_sse_events("data: a\r\n\r\ndata: b\r\r");
        assert_eq!(evs.len(), 2, "got: {:?}", evs);
        assert_eq!(evs[0].data, "a");
        assert_eq!(evs[1].data, "b");
    }

    #[test]
    fn a_trailing_event_without_final_blank_line_still_parses() {
        let evs = parse_sse_events("data: tail");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].data, "tail");
    }

    #[test]
    fn only_one_leading_space_after_colon_is_stripped() {
        // Per spec exactly one space is removed; further spaces are data.
        let evs = parse_sse_events("data:  two-spaces\n\n");
        assert_eq!(evs[0].data, " two-spaces");
    }

    #[test]
    fn empty_input_yields_no_events() {
        assert!(parse_sse_events("").is_empty());
        assert!(parse_sse_events("\n\n\n").is_empty());
    }

    #[test]
    fn event_boundary_detection_handles_both_endings() {
        // Returns the index just past the blank line, which is where `split_at`
        // cuts so `head` keeps the complete event and `rest` starts the next.
        // "data: x\n\nrest": the \n\n sits at 7, so the boundary is 9 ('r').
        assert_eq!(find_event_boundary("data: x\n\nrest"), Some(9));
        // "data: x\r\n\r\nrest": the \r\n\r\n sits at 7, so the boundary is 11.
        assert_eq!(find_event_boundary("data: x\r\n\r\nrest"), Some(11));
        assert_eq!(find_event_boundary("data: x\n"), None, "no blank line yet");
    }

    // ─── timeout parsing ────────────────────────────────────────────────────

    #[test]
    fn timeout_units_are_parsed() {
        assert_eq!(parse_timeout("120s"), std::time::Duration::from_secs(120));
        assert_eq!(parse_timeout("500ms"), std::time::Duration::from_millis(500));
        assert_eq!(parse_timeout("2m"), std::time::Duration::from_secs(120));
        assert_eq!(parse_timeout("1h"), std::time::Duration::from_secs(3600));
    }

    #[test]
    fn timeout_falls_back_to_sixty_seconds() {
        // An empty or garbage timeout must not make the server unreachable.
        assert_eq!(parse_timeout(""), std::time::Duration::from_secs(60));
        assert_eq!(parse_timeout("   "), std::time::Duration::from_secs(60));
        assert_eq!(parse_timeout("abc"), std::time::Duration::from_secs(60));
    }

    // ─── URL resolution ─────────────────────────────────────────────────────

    #[test]
    fn absolute_endpoint_is_used_verbatim() {
        assert_eq!(
            resolve_url("http://base.test/sse", "https://other.test/msg").unwrap(),
            "https://other.test/msg"
        );
    }

    #[test]
    fn relative_endpoint_resolves_against_base() {
        // Servers commonly announce a relative path with a session query.
        let got = resolve_url("http://base.test/sse", "/messages?sid=9").unwrap();
        assert_eq!(got, "http://base.test/messages?sid=9");
    }

    #[test]
    fn an_invalid_base_url_is_an_error_not_a_panic() {
        assert!(resolve_url("not a url", "/x").is_err());
    }

    // ─── RPC error surfacing ────────────────────────────────────────────────

    #[test]
    fn a_jsonrpc_error_member_becomes_an_err() {
        // Without this, a server-side error would be returned as an empty
        // `result` and read as success.
        let v = serde_json::json!({"jsonrpc": "2.0", "id": 1, "error": {"code": -32601, "message": "no such method"}});
        let err = check_rpc_error(v).unwrap_err().to_string();
        assert!(err.contains("no such method"), "got: {}", err);
    }

    #[test]
    fn a_null_error_member_is_not_an_error() {
        let v = serde_json::json!({"jsonrpc": "2.0", "id": 1, "error": null, "result": {"ok": true}});
        let out = check_rpc_error(v).unwrap();
        assert_eq!(out["ok"], true);
    }

    // ─── a 200 with a non-JSON-RPC body must not be a silent success ────────

    #[test]
    fn a_reply_without_a_result_member_is_an_error_not_null() {
        // Review finding: `check_rpc_error` used to return `Ok(Null)` here, so a
        // server answering 200 with an HTML error page (or any garbage) parsed
        // as JSON-null result and registered as "connected, tools=0". The
        // settings UI then showed a working server that never was.
        let v = serde_json::json!({"jsonrpc": "2.0", "id": 1});
        let err = check_rpc_error(v).unwrap_err().to_string();
        assert!(
            err.contains("no result member"),
            "the error must say the reply was not a JSON-RPC response, got: {}",
            err
        );
    }

    #[test]
    fn a_non_object_reply_is_rejected_not_null() {
        // Body was valid JSON but not a JSON-RPC response at all (a bare array,
        // a string). Same silent-Null hazard as above.
        let v = serde_json::json!(["unexpected"]);
        assert!(check_rpc_error(v).is_err());
        let v = serde_json::json!("just a string");
        assert!(check_rpc_error(v).is_err());
    }

    #[test]
    fn truncate_never_splits_a_char() {
        assert_eq!(truncate("hello", 10), "hello");
        assert_eq!(truncate("hello world", 5), "hello…");
        // A multibyte char at the cut point must not panic or corrupt.
        assert_eq!(truncate("你好世界", 2), "你好…");
    }
}
