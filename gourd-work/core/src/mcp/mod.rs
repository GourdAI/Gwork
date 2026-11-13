//! mcp — Model Context Protocol client.
//!
//! Supports stdio and HTTP (SSE/streamable) transports. MCP servers registered
//! in settings expose additional tools to the agent.
//!
//! `market` is the single built-in connector catalog adapter (ModelScope MCP 广场).
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

pub mod auth;
pub mod market;
pub mod oauth;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, Notify};
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

/// The version this client asks for in **Legacy** mode: the newest revision that
/// still defines the stateful `initialize` / `notifications/initialized`
/// handshake and the `Mcp-Session-Id` header.
///
/// `2026-07-28` is a breaking stateless redesign (SEP-2567 / SEP-2575): it removes
/// that handshake and moves capabilities into per-request `_meta`. This kernel is
/// built on the stateful handshake, so Legacy deliberately does not claim it.
/// That is no longer a *permanent* refusal — see [`McpProtocolMode`]: a server
/// that only speaks the stateless era can now be reached in `Auto` / `Stateless`
/// mode, with the negotiation outcome recorded for observation before any default
/// is changed.
pub const PROTOCOL_VERSION: &str = "2025-11-25";

/// The stateless-era revision. Kept as a named constant rather than a literal so
/// every mode check, capability projection and telemetry field agrees on it.
pub const STATELESS_PROTOCOL_VERSION: &str = "2026-07-28";

/// Versions this client can actually **speak** (stateful handshake), newest first.
/// In `Legacy` mode this is the complete accepted set; `Auto`/`Stateless` widen it
/// with [`STATELESS_PROTOCOL_VERSION`] for *negotiation* only — widening the
/// accepted set never claims the stateless wire format is implemented.
pub const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &[
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
];

/// Versions `Auto` / `Stateless` will accept from a server during negotiation.
pub const AUTO_ACCEPTED_VERSIONS: &[&str] = &[
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2026-07-28",
];

/// How this server's protocol version is negotiated.
///
/// Three states, deliberately conservative in their default: copying Codex's
/// `McpProtocolMode` shape so the rollout is observable and reversible rather
/// than a flag-day switch.
///
/// | Mode | Accepts `2026-07-28` from server | Version sent on later requests |
/// |------|----------------------------------|-------------------------------|
/// | [`Legacy`](Self::Legacy) (default) | no — fails the connect | n/a |
/// | [`Auto`](Self::Auto) | yes | **falls back** to [`PROTOCOL_VERSION`] (compat first) |
/// | [`Stateless`](Self::Stateless) (per-server opt-in) | yes | echoes `2026-07-28` (observation first) |
///
/// `Auto` and `Stateless` do **not** implement the stateless handshake. They let
/// the connection proceed so real servers can be observed, and every negotiation
/// emits a structured `mcp.protocol` telemetry record with the mode, the version
/// the server reported and whether a fallback was used. The point of this first
/// step is to measure how often the stateless era is actually encountered before
/// deciding whether to move the default — not to silently pretend compatibility.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum McpProtocolMode {
    /// Stateful handshake only. The pre-existing behaviour, kept as the default
    /// so enabling this feature changes nothing for existing configurations.
    #[default]
    Legacy,
    /// Accept a stateless-era server but transact on our stateful version.
    Auto,
    /// Explicit per-server opt-in: echo the stateless version back.
    Stateless,
}

impl McpProtocolMode {
    /// Parse a config spelling. Unknown / empty values resolve to `Legacy`: a
    /// typo must never silently opt a server into the experimental stateless
    /// path, and must never make the whole `mcpServers` entry fail to parse.
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "auto" => Self::Auto,
            "stateless" | "2026-07-28" | "modern" => Self::Stateless,
            _ => Self::Legacy,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Legacy => "legacy",
            Self::Auto => "auto",
            Self::Stateless => "stateless",
        }
    }

    /// Versions this mode will accept as a server's negotiated answer.
    pub fn accepted_versions(self) -> &'static [&'static str] {
        match self {
            Self::Legacy => SUPPORTED_PROTOCOL_VERSIONS,
            Self::Auto | Self::Stateless => AUTO_ACCEPTED_VERSIONS,
        }
    }

    /// Whether a stateless-era server is reachable at all in this mode.
    pub fn accepts_stateless(self) -> bool {
        !matches!(self, Self::Legacy)
    }
}

/// The observable outcome of one version negotiation.
///
/// Returned by [`negotiation_record`] and emitted as a structured log by
/// [`McpManager::accept_negotiated_version_for`]. Keeping it a value (rather
/// than only a `tracing!` side effect) is what makes the telemetry testable:
/// a test can assert the fallback decision without installing a subscriber.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NegotiationRecord {
    pub mode: McpProtocolMode,
    /// Version this handshake asked for.
    pub requested: String,
    /// Version the server reported (empty when it said nothing).
    pub reported: String,
    /// Version used for `MCP-Protocol-Version` on subsequent requests.
    pub chosen: String,
    /// Machine-readable outcome for dashboards / histograms.
    pub outcome: &'static str,
    /// True when a stateless-era answer was deliberately walked back.
    pub used_fallback: bool,
}

impl NegotiationRecord {
    /// Emit the structured telemetry event. One record per handshake, with a
    /// stable message so log aggregators can count the real version distribution.
    pub fn emit(&self, server: &str) {
        tracing::info!(
            target: "mcp.protocol",
            mode = self.mode.as_str(),
            server = %server,
            requested = %self.requested,
            reported = %self.reported,
            chosen = %self.chosen,
            outcome = self.outcome,
            used_fallback = self.used_fallback,
            "mcp.protocol_negotiated"
        );
    }
}

/// Decide what one `initialize` reply means, without failing the connection.
///
/// `Err` is reserved for the one case that is genuinely unusable: a Legacy-mode
/// server reporting a revision we cannot speak. Everything else produces a
/// record the caller can emit and act on.
pub fn negotiation_record(
    mode: McpProtocolMode,
    requested: &str,
    reported: &str,
) -> anyhow::Result<NegotiationRecord> {
    let reported = reported.trim();
    let mk = |chosen: &str, outcome: &'static str, used_fallback: bool| NegotiationRecord {
        mode,
        requested: requested.to_string(),
        reported: reported.to_string(),
        chosen: chosen.to_string(),
        outcome,
        used_fallback,
    };
    if reported.is_empty() {
        // Common in the wild; "no answer" means keep our own version.
        return Ok(mk(PROTOCOL_VERSION, "unspecified", false));
    }
    if reported == STATELESS_PROTOCOL_VERSION {
        return match mode {
            McpProtocolMode::Legacy => anyhow::bail!(
                "MCP server negotiated unsupported protocol version {:?} in Legacy mode \
                 (client supports {:?}); set \"protocolMode\": \"auto\" on this server to \
                 opt into stateless-era negotiation, or \"stateless\" to echo it back",
                reported,
                SUPPORTED_PROTOCOL_VERSIONS
            ),
            // Compat first: the server says stateless, but we transact on the
            // stateful version we actually implement. The mismatch is recorded,
            // not hidden.
            McpProtocolMode::Auto => Ok(mk(PROTOCOL_VERSION, "auto_fallback", true)),
            // Observation first: echo the version so a real stateless server's
            // behaviour becomes visible in traces. Still not a stateless
            // handshake implementation — see the mode's docs.
            McpProtocolMode::Stateless => Ok(mk(STATELESS_PROTOCOL_VERSION, "stateless_opt_in", false)),
        };
    }
    if mode.accepted_versions().contains(&reported) {
        let downgraded = reported != requested;
        return Ok(mk(
            reported,
            if downgraded { "downgraded" } else { "exact" },
            false,
        ));
    }
    anyhow::bail!(
        "MCP server negotiated unsupported protocol version {:?} (mode {}, accepts {:?})",
        reported,
        mode.as_str(),
        mode.accepted_versions()
    )
}

/// Pick the version to speak given what a server reported, in **Legacy** mode.
///
/// Thin wrapper kept for existing callers and tests; mode-aware callers use
/// [`negotiate_protocol_version_for`].
pub fn negotiate_protocol_version(server_version: &str) -> Option<String> {
    negotiate_protocol_version_for(McpProtocolMode::Legacy, server_version)
}

/// Mode-aware version selection. An empty `server_version` is treated as the
/// server not stating one at all, which falls back to our own version.
pub fn negotiate_protocol_version_for(mode: McpProtocolMode, server_version: &str) -> Option<String> {
    negotiation_record(mode, PROTOCOL_VERSION, server_version)
        .ok()
        .map(|r| r.chosen)
}

/// From a server's advertised `supported` list (the `-32602` "Unsupported
/// protocol version" error payload), pick the newest version both sides speak.
pub fn pick_common_version(supported: &[String]) -> Option<String> {
    pick_common_version_for(McpProtocolMode::Legacy, supported)
}

/// Mode-aware `-32602` recovery. `Stateless` opt-in prefers the stateless
/// revision when the server advertises it; `Auto` and `Legacy` deliberately
/// prefer a stateful common version instead (fallback over experimentation on
/// the retry path).
pub fn pick_common_version_for(mode: McpProtocolMode, supported: &[String]) -> Option<String> {
    if mode == McpProtocolMode::Stateless
        && supported.iter().any(|s| s == STATELESS_PROTOCOL_VERSION)
    {
        return Some(STATELESS_PROTOCOL_VERSION.to_string());
    }
    for ours in SUPPORTED_PROTOCOL_VERSIONS {
        if supported.iter().any(|s| s == ours) {
            return Some((*ours).to_string());
        }
    }
    None
}

/// A server rejected our protocol version but told us which ones it speaks.
///
/// Kept as a typed error rather than folded into the generic `MCP error: {...}`
/// string: `-32602` carrying a `supported` list is the one rejection the client
/// can *act* on (retry the handshake on a common version), and recovering from a
/// formatted string would mean pattern-matching JSON out of an error message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsupportedProtocolVersion {
    /// Versions the server advertised, newest-first as the spec recommends.
    pub supported: Vec<String>,
}

impl std::fmt::Display for UnsupportedProtocolVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "server rejected protocol version {} (supports {})",
            PROTOCOL_VERSION,
            self.supported.join(", ")
        )
    }
}

impl std::error::Error for UnsupportedProtocolVersion {}

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
    /// Per-server tool **allowlist**. Empty = no restriction (the default and the
    /// Java kernel's behaviour). When non-empty, a discovered tool whose raw name
    /// is not in this list is disabled — the exact mirror of `disallowedTools`,
    /// which lets a user expose only a few tools from a very large server instead
    /// of having to enumerate everything they want to hide.
    ///
    /// `disallowedTools` always wins over this list: a name in both is disabled.
    #[serde(rename = "allowedTools", default)]
    pub allowed_tools: Vec<String>,
    /// Comma-free per-tool output ceilings, keyed by the tool's **raw** name,
    /// e.g. `{ "search": 8000 }`. Values are characters, not bytes: the cap is
    /// applied on `chars()` so a UTF-8 reply is never cut mid-codepoint.
    ///
    /// An absent tool falls back to [`DEFAULT_TOOL_OUTPUT_LIMIT`]. This is what
    /// stops one verbose MCP tool from consuming the entire context window while
    /// still letting a deliberately verbose tool opt into more.
    #[serde(rename = "toolOutputLimits", default)]
    pub tool_output_limits: HashMap<String, usize>,
    /// Protocol-version negotiation mode. Absent / unknown = [`McpProtocolMode::Legacy`],
    /// i.e. exactly the pre-existing behaviour. See the enum's docs for why the
    /// stateless era is opt-in rather than a default switch.
    #[serde(rename = "protocolMode", default)]
    pub protocol_mode: String,
    /// Number of characters above which an MCP `tools/call` text result is
    /// truncated with a visible marker. Zero/absent uses
    /// [`DEFAULT_TOOL_OUTPUT_LIMIT`].
    #[serde(rename = "maxToolOutputChars", default)]
    pub max_tool_output_chars: usize,
    /// Timeout for the **first** connection/handshake, e.g. `"30s"`. Empty means
    /// use `timeout`. Keeping it separate lets a slow cold-start (`npx` on an
    /// empty cache) not dictate the budget for every later tool call.
    #[serde(rename = "connectTimeout", default)]
    pub connect_timeout: String,
    /// Timeout for discovery requests (`tools/list`), e.g. `"30s"`. Empty means
    /// use `timeout`.
    #[serde(rename = "discoveryTimeout", default)]
    pub discovery_timeout: String,
    /// Timeout for OAuth / authentication round trips, e.g. `"20s"`. Empty means
    /// use the OAuth module's own default.
    #[serde(rename = "authTimeout", default)]
    pub auth_timeout: String,
    /// Whether this server may issue `elicitation/create` requests. Off by
    /// default: an untrusted remote server must not be able to prompt the user.
    #[serde(rename = "allowElicitation", default)]
    pub allow_elicitation: bool,
    /// Non-secret authentication declaration (`authType`: none/token/oauth and
    /// the token-dialog metadata). Secrets live in `mcp::auth::CredentialVault`,
    /// never in this struct or in settings.json.
    #[serde(default)]
    pub auth: serde_json::Value,
    /// Legacy flat spelling, still honoured by `AuthSpec::from_entry`.
    #[serde(rename = "authType", default)]
    pub auth_type: String,
}

/// Default ceiling for one MCP tool's text output, in characters.
///
/// Chosen to be well under a typical context budget while still leaving room for
/// a real result. Truncation is always visible (a marker is appended), so a
/// truncated answer is never mistaken for the tool having returned little data.
pub const DEFAULT_TOOL_OUTPUT_LIMIT: usize = 30_000;

impl McpServerConfig {
    /// Resolve the protocol mode from its config spelling (unknown → Legacy).
    pub fn protocol_mode(&self) -> McpProtocolMode {
        McpProtocolMode::parse(&self.protocol_mode)
    }

    /// Effective per-tool output ceiling. A per-tool entry overrides the
    /// server-wide ceiling; zero/negative can never disable the cap silently.
    pub fn output_limit_for(&self, tool_name: &str) -> usize {
        let v = self
            .tool_output_limits
            .get(tool_name)
            .copied()
            .unwrap_or(if self.max_tool_output_chars > 0 {
                self.max_tool_output_chars
            } else {
                DEFAULT_TOOL_OUTPUT_LIMIT
            });
        if v == 0 { DEFAULT_TOOL_OUTPUT_LIMIT } else { v }
    }

    /// Timeout budget for one phase. An empty phase-specific value falls back to
    /// the server's general `timeout`, and an unparseable one falls back to 60s
    /// through [`parse_timeout`].
    pub fn timeout_for(&self, phase: TimeoutPhase) -> std::time::Duration {
        let raw = match phase {
            TimeoutPhase::Connect => &self.connect_timeout,
            TimeoutPhase::Discovery => &self.discovery_timeout,
            TimeoutPhase::Auth => &self.auth_timeout,
            TimeoutPhase::Call => &self.timeout,
        };
        if raw.trim().is_empty() {
            return parse_timeout(&self.timeout);
        }
        parse_timeout(raw)
    }
}

/// The distinct timeout budgets an MCP round-trip can have.
///
/// A single knob was the root of two opposite complaints: a cold `npx` start
/// needed minutes, while a hung tool call must fail in seconds. Splitting them
/// keeps the first-connect budget from becoming a permanent hang budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeoutPhase {
    Connect,
    Discovery,
    Auth,
    Call,
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
            // New in the P0–P2 pass. Every one of these defaults to "off", so a
            // settings.json written by an older build (or by the Java kernel,
            // which shares this file) behaves exactly as it did before. That is
            // the whole point of `#[serde(default)]` on the struct plus explicit
            // values here: adding a knob must never silently change an existing
            // server's protocol mode, output cap or timeout budget.
            allowed_tools: Vec::new(),
            tool_output_limits: HashMap::new(),
            protocol_mode: String::new(),
            max_tool_output_chars: 0,
            connect_timeout: String::new(),
            discovery_timeout: String::new(),
            auth_timeout: String::new(),
            allow_elicitation: false,
            // Absent auth = "none": every existing settings.json entry keeps
            // exactly its old behaviour (static headers/env only).
            auth: serde_json::Value::Null,
            auth_type: String::new(),
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
    /// False when the user unchecked this tool in the MCP tools panel
    /// (per-server `disallowedTools`). A disabled tool is hidden from the model
    /// and refused by `execute`, but it stays in `all_tools`/`tools_of` so the
    /// panel can still list it and re-enable it. Filtering it out at discovery
    /// time instead would make "re-check the box" impossible — the panel would
    /// never see the tool again.
    pub enabled: bool,
}

impl McpTool {
    /// The name this tool is advertised to the LLM under.
    ///
    /// Namespaced as `mcp__<server>__<tool>` (the convention Claude Code, Codex
    /// and ZCode all use) for two reasons:
    ///   * **Collision safety** — two servers exposing `search`, or a server
    ///     exposing `read`, would otherwise produce duplicate entries in the
    ///     `tools[]` array (most model APIs reject that outright) or silently
    ///     shadow a built-in. The namespace makes every MCP name unique and
    ///     keeps it clear of built-in names.
    ///   * **Attribution** — the model (and the user reading a trace) can see
    ///     which server a tool came from.
    ///
    /// Non `[A-Za-z0-9_-]` characters are replaced with `_` because provider
    /// function-name schemas reject them. `execute` resolves a call by scanning
    /// `all_tools()` for a matching `llm_name()` rather than splitting the
    /// string back apart, so sanitisation never loses the server/tool mapping.
    pub fn llm_name(&self) -> String {
        fn sanitize(s: &str) -> String {
            s.chars()
                .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
                .collect()
        }
        format!("mcp__{}__{}", sanitize(&self.server_name), sanitize(&self.name))
    }
}

/// Structured result of an MCP `tools/call`.
///
/// `call_tool` used to return a bare `String`, which forced two losses: the
/// server's `isError` flag was dropped (a tool that reported failure looked
/// like success to the model) and every non-text content block was discarded
/// (an image-only reply became an empty string). This carries both through.
#[derive(Debug, Clone)]
pub struct McpCallResult {
    /// Concatenated `text` content blocks (plus placeholders for content types
    /// this client cannot render, so a reply is never silently empty).
    pub text: String,
    /// The server's `result.isError`. Distinct from a transport error: the call
    /// reached the server and the *tool itself* failed.
    pub is_error: bool,
    /// `image` content blocks as data URLs, for the model's vision channel.
    pub images: Vec<String>,
}

/// Active MCP connection (stdio child process).
struct StdioConnection {
    child: Child,
    stdin: tokio::process::ChildStdin,
    stdout_lines: BufReader<tokio::process::ChildStdout>,
    next_id: u64,
    /// Per-server request timeout from `config.timeout`, resolved once at
    /// connect. Was hardcoded (30s deadline / 10s per read) which made the
    /// knob a no-op for stdio: a `timeout: "3s"` server still waited 10s.
    /// General per-RPC budget for calls after the handshake.
    timeout: std::time::Duration,
    /// Budget for the `initialize` round-trip only. See [`TimeoutPhase`]: a
    /// cold `npx` start needs minutes, a hung tool call needs seconds.
    connect_timeout: std::time::Duration,
    /// Set when a reply timed out. The server's late answer is still sitting in
    /// the pipe, so the **next** call would read it and return it as its own
    /// result (observed live: call 2 returned call 1's payload). The caller
    /// discards a poisoned connection rather than reusing it.
    poisoned: bool,
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
    /// The protocol version negotiated during initialize, sent as the
    /// `MCP-Protocol-Version` header on every subsequent request. The spec
    /// (2025-11-25 Transports) makes that header a MUST for HTTP clients; a
    /// server that omits it falls back to assuming `2025-03-26`, which can
    /// change how it interprets our messages.
    protocol_version: String,
    next_id: u64,
    /// Legacy SSE only: responses arrive on the GET stream, not on the POST
    /// reply, so they are read from here.
    sse_rx: Option<tokio::sync::mpsc::UnboundedReceiver<SseEvent>>,
    /// Keeps the GET stream alive. Dropping the handle does not abort the task,
    /// so `disconnect_one` aborts it explicitly.
    sse_task: Option<tokio::task::JoinHandle<()>>,
    /// Credentials resolved from `mcp::auth::CredentialVault` at connect time.
    ///
    /// Kept separate from `client`'s `default_headers` because OAuth tokens can
    /// be refreshed mid-session: `http_post_body` re-resolves from the vault on
    /// each request and overlays this map, so a token that expires during a long
    /// session does not require reconnecting the whole server. Static tokens are
    /// resolved once and simply live here.
    auth_headers: std::collections::HashMap<String, String>,
}

/// A live connection, whichever transport produced it.
enum Connection {
    Stdio(StdioConnection),
    Http(HttpConnection),
}

/// One server's connection behind its own lock.
///
/// Held by `Arc` in the manager's map so a caller can clone the handle, release
/// the manager-level lock, and only *then* await the RPC. That split is the whole
/// point: the manager used to hold one mutex across the network round-trip, so a
/// single slow or hung server stalled every MCP call in the process — including
/// calls to unrelated healthy servers and `connect_one` from the settings UI,
/// which is why the UI could freeze on an edit while one server was timing out.
///
/// Calls to the *same* server stay serialized, and that is required rather than
/// incidental: a stdio pipe matches replies positionally, so two concurrent
/// `tools/call`s on one connection would cross-deliver each other's answers.
struct ConnectionSlot {
    conn: Mutex<Connection>,
}

/// Live connection state for one server, as surfaced to the settings UI.
///
/// The panel used to infer health from "does this server have any tools", which
/// is wrong in both directions: a server that connected fine but exposes zero
/// tools looked broken, and one whose child process had died kept reporting
/// *connected* because its tools were still in the registry (they are only
/// dropped on explicit disconnect). This struct is the single source of truth.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServerHealth {
    /// `"connected"` | `"reconnecting"` | `"disconnected"` | `"failed"`.
    pub state: String,
    /// Human-readable reason for the last failure; empty while healthy.
    #[serde(default)]
    pub last_error: String,
    /// Number of tools discovered from this server.
    #[serde(default)]
    pub tools: usize,
    /// Consecutive failed rebuild attempts since the last success. Drives the
    /// reconnect backoff and lets the UI show "flapping".
    #[serde(default)]
    pub reconnect_attempts: u32,
    /// Total successful automatic rebuilds since process start.
    #[serde(default)]
    pub reconnects: u32,
    /// When the last rebuild was attempted. Internal only (not reported to the
    /// UI); used to bound how often a permanently-broken server gets respawned.
    #[serde(skip)]
    last_attempt: Option<std::time::Instant>,
}

impl ServerHealth {
    fn connected(tools: usize) -> Self {
        Self { state: "connected".into(), tools, ..Default::default() }
    }
    pub fn is_connected(&self) -> bool {
        self.state == "connected"
    }
}

/// Maximum backoff between automatic reconnect attempts.
const RECONNECT_BACKOFF_CAP_MS: u64 = 4_000;
/// Base delay for the first reconnect after a failure.
const RECONNECT_BACKOFF_BASE_MS: u64 = 250;

/// Exponential backoff for automatic reconnects: 250ms, 500ms, 1s, 2s, 4s.
///
/// Deliberately capped and *short*: this delay is paid inside a tool call, so a
/// long backoff would read as the agent hanging. The cap also bounds how often
/// a permanently-broken server gets its process respawned (see
/// [`McpManager::reconnect_if_cooled`]).
pub fn reconnect_backoff(attempts: u32) -> std::time::Duration {
    let shift = attempts.min(4);
    let ms = RECONNECT_BACKOFF_BASE_MS.saturating_mul(1u64 << shift);
    std::time::Duration::from_millis(ms.min(RECONNECT_BACKOFF_CAP_MS))
}

/// Turn a raw connect/handshake error into a message a user can act on.
///
/// Lives here rather than in `settings_api` because connection health is owned by
/// this module: the same wording must reach both the settings panel (which
/// renders `last_error`) and any future CLI/log consumer. Duplicating it would
/// let the two drift into describing the same failure differently.
pub fn humanize_connect_error(raw: &str, kind: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("not implemented") {
        return format!("不支持检测的类型: {}", kind);
    }
    if lower.contains("timed out") || lower.contains("timeout") {
        return "连接超时，请检查地址是否可达".into();
    }
    if lower.contains("connection refused") || lower.contains("actively refused") {
        return "连接被拒绝，请检查地址和端口是否正确".into();
    }
    if lower.contains("os error 2") || lower.contains("no such file") {
        return format!("命令无法执行（未找到可执行文件）: {}", raw);
    }
    if lower.contains("closed stdout") {
        return "服务器已启动但未响应 MCP 握手（请检查命令与参数）".into();
    }
    format!("检测失败: {}", raw)
}

/// A connection-level failure, i.e. one worth rebuilding the transport for.
///
/// Kept as a typed error rather than sniffed out of message text: deciding
/// "should I reconnect?" by matching substrings like "closed stdout" breaks the
/// moment someone rewords a message, and it fails in the dangerous direction —
/// silently never reconnecting. Everything that is *not* this error (an MCP
/// protocol error such as `-32601 method not found`, or a tool's own `isError`)
/// is a business-level failure where reconnecting cannot help and would only
/// cost a process respawn plus a backoff delay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportDead {
    pub reason: String,
}

impl std::fmt::Display for TransportDead {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.reason)
    }
}

impl std::error::Error for TransportDead {}

/// True when an error means "the transport is gone", so the caller may rebuild it.
pub fn is_transport_dead(e: &anyhow::Error) -> bool {
    e.downcast_ref::<TransportDead>().is_some()
}

/// MCP client manager.
pub struct McpManager {
    /// Server name → connection slot. The map lock guards only the (cheap)
    /// lookup/insert/remove; never hold it across an `await` that can block.
    connections: Mutex<HashMap<String, Arc<ConnectionSlot>>>,
    tools: Mutex<Vec<McpTool>>,
    /// Config for every server we were asked to connect, retained so a lost
    /// connection can be rebuilt by the manager itself. Without this a dead
    /// stdio child was terminal: only the settings UI (which still had the
    /// config) could bring it back, so a crash mid-session silently removed
    /// those tools from every later turn.
    configs: Mutex<HashMap<String, McpServerConfig>>,
    /// Health per server, kept even when no connection exists — "why is this
    /// server red" must survive the connection being dropped.
    health: Mutex<HashMap<String, ServerHealth>>,
    /// Per-server reconnect gate: name → mutex serialising that server's rebuilds.
    ///
    /// A gate rather than a "someone is already reconnecting" flag: when a stdio
    /// child dies, the agent typically has several tool calls queued for that
    /// server and every one of them observes the dead transport. With a flag they
    /// would each bail out (losing calls that could have succeeded); with a
    /// per-name mutex they queue, the first one respawns the process, and the
    /// rest find a healthy connection and proceed. Crucially the gate is
    /// *per server*, so a slow rebuild of one server cannot block another's —
    /// that isolation is the same property `ConnectionSlot` gives RPCs (#10).
    reconnect_gates: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Whether the startup connection pass has settled.
    ///
    /// **Defaults to `true`.** Only [`begin_startup`] flips it to `false`, and the
    /// kernel calls that exactly once, immediately before spawning the background
    /// `connect_all`. Getting the default wrong here would be a startup stall for
    /// every user with no MCP servers configured — they would never call
    /// `mark_startup_complete`, so any run awaiting startup would burn its full
    /// timeout before sending the first model request.
    startup_settled: AtomicBool,
    /// Wakes runs that started while MCP servers were still handshaking.
    startup_notify: Notify,
}

impl McpManager {
    pub fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            tools: Mutex::new(Vec::new()),
            configs: Mutex::new(HashMap::new()),
            health: Mutex::new(HashMap::new()),
            reconnect_gates: Mutex::new(HashMap::new()),
            startup_settled: AtomicBool::new(true),
            startup_notify: Notify::new(),
        }
    }

    /// Mark that a background startup connection pass is now running.
    ///
    /// Must be called *before* spawning `connect_all`, not after: a run could
    /// start in between, observe `settled == true`, and proceed without the MCP
    /// tools that are about to arrive. The window this closes is exactly the
    /// defect it exists for.
    pub fn begin_startup(&self) {
        self.startup_settled.store(false, Ordering::SeqCst);
    }

    /// Record that the startup pass finished (successfully or not).
    ///
    /// Wakes every run that parked on [`wait_for_startup`]. Called unconditionally
    /// at the end of `connect_all`, including when every server failed — a run
    /// must not wait for tools that are never coming.
    pub async fn mark_startup_complete(&self) {
        self.startup_settled.store(true, Ordering::SeqCst);
        self.startup_notify.notify_waiters();
    }

    /// Block until the startup connection pass has settled, or `timeout` elapses.
    ///
    /// Returns `true` when startup settled within the budget, `false` on timeout.
    ///
    /// This is what closes the cold-start race: a run that begins while servers
    /// are still handshaking used to snapshot the (empty) tool list and never see
    /// MCP tools again for the rest of that run, even if they connected a second
    /// later. Now it waits a bounded moment for them to appear.
    ///
    /// The timeout is a ceiling, not a target: the common case returns as soon as
    /// `mark_startup_complete` fires. When nothing was ever configured, the flag
    /// is still at its `true` default and this returns immediately.
    pub async fn wait_for_startup(&self, timeout: std::time::Duration) -> bool {
        if self.startup_settled.load(Ordering::SeqCst) {
            return true;
        }
        // Check-then-wait, with a re-check inside the timeout branch: a
        // completion that lands between the load above and registering the
        // waiter would otherwise be missed, and `notify_waiters` (unlike
        // `notify_one`) does not store a permit for late arrivals.
        match tokio::time::timeout(timeout, self.startup_notify.notified()).await {
            Ok(()) => true,
            Err(_) => self.startup_settled.load(Ordering::SeqCst),
        }
    }

    /// Get (creating on first use) the reconnect gate for one server.
    ///
    /// Gates are never removed: they are one tiny mutex per configured server,
    /// and removing them would reopen the race this exists to close (two callers
    /// could each create a fresh gate and both proceed to respawn).
    async fn reconnect_gate(&self, name: &str) -> Arc<Mutex<()>> {
        let mut gates = self.reconnect_gates.lock().await;
        gates.entry(name.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// Look up a server's slot without holding the map lock afterwards.
    ///
    /// Returns the `Arc` clone, so the caller can await the RPC on the slot while
    /// other servers keep working. `None` means not connected.
    async fn slot_for(&self, name: &str) -> Option<Arc<ConnectionSlot>> {
        self.connections.lock().await.get(name).cloned()
    }

    /// Release a slot's OS resources: kill the stdio child / abort the SSE task.
    ///
    /// Waits for any in-flight call on this slot to finish first (bounded by that
    /// call's own timeout). That is deliberate — yanking the child or the stream
    /// task out from under a running RPC would leave the caller awaiting a reply
    /// that can never arrive.
    async fn drop_slot(slot: Arc<ConnectionSlot>) {
        let mut conn = slot.conn.lock().await;
        Self::kill_connection(&mut conn).await;
    }

    /// Kill/abort the resources behind a connection, in place.
    async fn kill_connection(conn: &mut Connection) {
        match conn {
            Connection::Stdio(c) => Self::shutdown_stdio(c).await,
            Connection::Http(c) => {
                // Dropping the receiver closes the channel, which ends the reader
                // task; abort as well so a blocked network read does not linger.
                if let Some(task) = c.sse_task.take() {
                    task.abort();
                }
            }
        }
    }

    /// Connect to all configured MCP servers and discover their tools.
    pub async fn connect_all(&self, servers: &HashMap<String, McpServerConfig>) {
        // Bounded concurrency rather than the previous serial `for` loop.
        //
        // Each handshake is an `initialize` + `tools/list` round-trip with a
        // per-RPC budget of 30 s. Serially, one hung `npx`/`uvx` server (cold npm
        // cache, missing binary, corporate proxy prompt) stalled every server
        // *behind* it — with 5 servers the last one could wait two minutes before
        // its handshake even started. Since `definitions_async` snapshots the tool
        // list once per run, that delay directly became "the model does not have
        // those tools in this conversation".
        //
        // The bound matters too: unbounded would spawn every configured `npx` at
        // once, and cold npm caches are I/O- and CPU-heavy, so 20 servers would
        // thrash the machine during startup.
        const CONNECT_CONCURRENCY: usize = 4;
        use futures_util::stream::{self, StreamExt};

        // Owned entries, not borrowed ones: an async block that captures `&String`
        // from the stream item cannot satisfy the higher-ranked lifetime the
        // combinator demands (and, one level up, `tokio::spawn`'s `'static`).
        // Cloning configs here is cheap — a handful of small structs at startup —
        // and it removes the borrow entirely.
        let entries: Vec<(String, McpServerConfig)> = servers
            .iter()
            .filter(|(_, c)| c.enabled)
            .map(|(name, config)| (name.clone(), config.clone()))
            .collect();
        let total = entries.len();

        let connected = stream::iter(entries)
            .map(|(name, config)| async move {
                match self.connect_one(&name, &config).await {
                    Ok(n) => {
                        info!(server = %name, tools = n, "MCP server connected");
                        true
                    }
                    Err(e) => {
                        // One server failing must not affect the others: that was
                        // already true serially, and concurrency must not regress it.
                        warn!(server = %name, error = %e, "MCP connection failed");
                        false
                    }
                }
            })
            .buffer_unordered(CONNECT_CONCURRENCY)
            .fold(0usize, |acc, ok| async move { acc + ok as usize })
            .await;

        // Publish "startup handshakes have settled" so a run that began during
        // startup stops waiting for tools that are never coming.
        self.mark_startup_complete().await;
        if total > 0 {
            info!(servers = total, connected, "MCP startup connection pass finished");
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
        // Snapshot this server's previously discovered tools before the
        // teardown below clears them. A **refresh** (reconnect, settings save,
        // auto-rebuild after a crash) that fails must not destroy capabilities
        // we already advertised: the run's prompt was built from that list, and
        // wiping it turns a transient blip into "all these tools vanished" for
        // the rest of the session. On failure we restore the snapshot.
        let previous_tools: Vec<McpTool> = self
            .tools
            .lock()
            .await
            .iter()
            .filter(|t| t.server_name == name)
            .cloned()
            .collect();
        self.disconnect_one(name).await;
        if !config.enabled {
            // Still remember the config: a later toggle-on is an update, and
            // dropping it here would leave `reconnect_if_needed` unable to help.
            self.configs.lock().await.insert(name.to_string(), config.clone());
            self.set_health(name, ServerHealth {
                state: "disconnected".into(),
                last_error: String::new(),
                ..Default::default()
            }).await;
            return Ok(0);
        }
        // Retain the config before connecting so an automatic rebuild has what it
        // needs even if this very connect attempt fails.
        self.configs.lock().await.insert(name.to_string(), config.clone());
        match config.resolved_type().as_str() {
            TYPE_STDIO | TYPE_STREAMABLE | TYPE_STREAMABLE_STATELESS | TYPE_SSE => {
                match self.connect_and_register(name, config).await {
                    Ok(n) => Ok(n),
                    Err(e) => {
                        if !previous_tools.is_empty() {
                            let mut all = self.tools.lock().await;
                            all.retain(|t| t.server_name != name);
                            all.extend(previous_tools);
                            tracing::warn!(
                                server = %name,
                                retained = all.iter().filter(|t| t.server_name == name).count(),
                                error = %e,
                                "MCP reconnect failed; retaining the previously discovered tool list"
                            );
                        }
                        Err(e)
                    }
                }
            }
            other => anyhow::bail!("unsupported MCP transport '{}'", other),
        }
    }

    /// Record health for a server, preserving the reconnect counters.
    ///
    /// Counters live across a state change deliberately: if a server flaps
    /// connected → failed → connected, wiping `reconnects` on success would hide
    /// exactly the pattern the UI is meant to show.
    async fn set_health(&self, name: &str, mut h: ServerHealth) {
        let mut map = self.health.lock().await;
        if let Some(prev) = map.get(name) {
            h.reconnect_attempts = prev.reconnect_attempts;
            h.reconnects = prev.reconnects;
        }
        map.insert(name.to_string(), h);
    }

    /// Rebuild a lost connection for one server, honouring backoff and the
    /// per-server gate. Returns the fresh slot on success.
    ///
    /// Called by `call_tool` when an RPC fails with [`TransportDead`] (the child
    /// exited, the pipe broke, the server closed stdout). Before this existed a
    /// dead stdio server was terminal for the session: `call_tool` deleted the
    /// connection and every later call failed with "not connected", so the agent
    /// silently lost that server's tools until the user opened settings and hit
    /// save. That is the failure mode this closes.
    ///
    /// Design constraints, each one earned:
    ///   * **Gate per server** — concurrent calls collapse into one respawn
    ///     instead of N leaked children; other servers are unaffected.
    ///   * **Double-check after taking the gate** — whoever queued behind the
    ///     winner must reuse the new connection rather than rebuild again.
    ///   * **Bounded backoff** — a server that crashes on every start must not be
    ///     respawned in a tight loop; the delay grows to a 4s cap and the streak
    ///     is reported through `health`.
    ///   * **Never silently succeed** — if we cannot rebuild, the caller gets the
    ///     *original* transport error, not "not connected", so the model sees why.
    async fn reconnect_if_needed(
        &self,
        name: &str,
        cause: &anyhow::Error,
    ) -> anyhow::Result<Arc<ConnectionSlot>> {
        let gate = self.reconnect_gate(name).await;
        // Held for the whole rebuild: this is the "only one respawn per server"
        // guarantee, and the work is short (spawn + handshake + tools/list).
        let _guard = gate.lock().await;

        // Someone queued ahead of us may have already rebuilt it.
        if let Some(slot) = self.slot_for(name).await {
            if !Self::slot_is_dead(&slot).await {
                return Ok(slot);
            }
        }

        let config = match self.configs.lock().await.get(name).cloned() {
            Some(c) => c,
            // No retained config means we were never asked to connect this
            // server (e.g. a `probe` name). Nothing to rebuild from.
            None => return Err(TransportDead { reason: cause.to_string() }.into()),
        };
        if !config.enabled {
            return Err(TransportDead { reason: cause.to_string() }.into());
        }

        // Backoff keyed on the consecutive-failure streak, and measured before
        // the attempt so two callers a millisecond apart cannot both skip it.
        let (attempts, wait) = {
            let h = self.health_of(name).await;
            let wait = reconnect_backoff(h.reconnect_attempts);
            // Only sleep when an attempt was made recently; otherwise this is a
            // fresh failure and paying the full delay would just add latency to
            // the first (usually successful) rebuild.
            let recent = h.last_attempt
                .map(|t| t.elapsed() < wait * 2)
                .unwrap_or(false);
            (h.reconnect_attempts, if recent { Some(wait) } else { None })
        };
        if let Some(w) = wait {
            tracing::debug!(server = %name, backoff = ?w, "MCP reconnect backing off");
            tokio::time::sleep(w).await;
        }
        self.health.lock().await.entry(name.to_string())
            .and_modify(|h| {
                h.state = "reconnecting".into();
                h.reconnect_attempts = attempts + 1;
                h.last_attempt = Some(std::time::Instant::now());
            })
            .or_insert_with(|| ServerHealth {
                state: "reconnecting".into(),
                reconnect_attempts: attempts + 1,
                last_attempt: Some(std::time::Instant::now()),
                ..Default::default()
            });

        // Clear the stale connection first: connect_and_register inserts into the
        // map, and leaving the dead slot in place would let a queued caller pick
        // it up between here and the insert.
        if let Some(dead) = self.connections.lock().await.remove(name) {
            Self::drop_slot(dead).await;
        }

        match self.connect_and_register(name, &config).await {
            Ok(n) => {
                warn!(server = %name, tools = n, attempt = attempts + 1, "MCP server auto-reconnected");
                let mut map = self.health.lock().await;
                if let Some(h) = map.get_mut(name) {
                    h.state = "connected".into();
                    h.last_error = String::new();
                    h.reconnects = h.reconnects.saturating_add(1);
                    // Reset the streak so the next failure starts at the base
                    // delay again instead of inheriting a 4s backoff.
                    h.reconnect_attempts = 0;
                }
                self.slot_for(name).await.ok_or_else(|| {
                    anyhow::anyhow!("MCP server {} reconnected but has no connection", name)
                })
            }
            Err(e) => {
                warn!(server = %name, error = %e, "MCP auto-reconnect failed");
                let mut map = self.health.lock().await;
                if let Some(h) = map.get_mut(name) {
                    h.state = "failed".into();
                    h.last_error = humanize_connect_error(&e.to_string(), &config.resolved_type());
                }
                // Report the rebuild failure but keep the original cause visible:
                // the user needs to know both what broke and that recovery failed.
                Err(anyhow::anyhow!("{} (reconnect failed: {})", cause, e))
            }
        }
    }

    /// Gracefully stop a stdio child: close its stdin first (EOF is the
    /// spec's "client is done" signal), give it a bounded window to exit, then
    /// hard-kill only if it ignored that.
    ///
    /// `child.kill()` alone was a `SIGKILL`-equivalent with no chance for the
    /// server to flush files, close sockets or release locks. Cross-platform
    /// there is no portable SIGINT→SIGTERM ladder for a child process, so EOF
    /// on stdin is the graceful step that works on every OS (and is exactly how
    /// MCP stdio servers are told to shut down). The grace period is bounded so
    /// a hung server can never wedge `shutdown()` or a reconnect.
    async fn shutdown_stdio(c: &mut StdioConnection) {
        use tokio::io::AsyncWriteExt;
        const GRACE: std::time::Duration = std::time::Duration::from_millis(750);

        // Step 1: graceful. Errors here are expected (the child may already be
        // gone) and must not skip the wait/kill steps below.
        let _ = c.stdin.shutdown().await;
        match tokio::time::timeout(GRACE, c.child.wait()).await {
            Ok(_) => return,
            Err(_) => {}
        }
        // Step 2: hard kill, then reap so no zombie is left behind.
        let _ = c.child.kill().await;
        let _ = c.child.wait().await;
    }

    /// Is this slot's connection unusable (poisoned stdio)?
    async fn slot_is_dead(slot: &Arc<ConnectionSlot>) -> bool {
        matches!(&*slot.conn.lock().await, Connection::Stdio(sc) if sc.poisoned)
    }
    /// Health snapshot for one server, or a synthesised "disconnected" entry when
    /// nothing has been recorded (e.g. a server the UI knows from settings.json
    /// but we were never asked to connect).
    pub async fn health_of(&self, name: &str) -> ServerHealth {
        if let Some(h) = self.health.lock().await.get(name) {
            return h.clone();
        }
        ServerHealth { state: "disconnected".into(), ..Default::default() }
    }

    /// Health for every server we know a config for, plus any live connection.
    ///
    /// Union of the two because they diverge in both directions: a server can be
    /// configured but never connected, and (during teardown) briefly connected
    /// while its config entry is gone.
    pub async fn health_all(&self) -> Vec<(String, ServerHealth)> {
        let mut names: Vec<String> = self.configs.lock().await.keys().cloned().collect();
        for n in self.connections.lock().await.keys() {
            if !names.iter().any(|x| x == n) {
                names.push(n.clone());
            }
        }
        names.sort();
        let mut out = Vec::with_capacity(names.len());
        for n in names {
            out.push((n.clone(), self.health_of(&n).await));
        }
        out
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

    /// Fully forget a server: tear it down **and** drop its retained config.
    ///
    /// Distinct from [`disconnect_one`], which is also used as the "clean up
    /// before reconnecting" half of `connect_one` and must therefore keep the
    /// config. This is the removal path: remove / toggle-off / rename. Without
    /// it, `call_tool`'s auto-rebuild (which keys off the retained config) would
    /// resurrect a server the user had just disabled — turning "I turned this
    /// off" into "it came back on the next tool call".
    pub async fn forget_server(&self, name: &str) {
        self.disconnect_one(name).await;
        self.configs.lock().await.remove(name);
        let mut health = self.health.lock().await;
        match health.get_mut(name) {
            // Keep the entry so the UI can still explain a recent failure, but it
            // must not claim to be connected.
            Some(h) => {
                h.state = "disconnected".into();
                h.tools = 0;
            }
            None => {}
        }
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
        let slot = self.connections.lock().await.remove(name);
        // Health must follow the registry: the panel reads `tools` from here, and
        // a stale non-zero count after teardown is exactly the "says connected but
        // is dead" lie this struct was introduced to remove.
        if let Some(h) = self.health.lock().await.get_mut(name) {
            h.state = "disconnected".into();
            h.tools = 0;
        }
        if let Some(slot) = slot {
            Self::drop_slot(slot).await;
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
        let mut conn = match self.open_connection(config).await {
            Ok(c) => c,
            Err(e) => {
                // Record why: the UI otherwise shows a bare "not connected" with
                // no hint that the command is missing, the URL 401s, or the
                // binary is not on PATH.
                self.record_failure(name, &e, config).await;
                return Err(e);
            }
        };
        let listed = Self::rpc(&mut conn, "tools/list", serde_json::json!({})).await;
        let tools = match listed {
            Ok(result) => parse_tools(name, config, &result),
            Err(e) => {
                Self::drop_connection(conn).await;
                self.record_failure(name, &e, config).await;
                // A failed **refresh** must not destroy capabilities that were
                // successfully discovered earlier. The model's prompt was built
                // from the previous tool list; wiping it here would make every
                // one of those tools vanish on a transient AS/network blip and
                // leave the agent calling names that no longer resolve. Only a
                // first-ever connect has nothing to preserve.
                let had_previous = self
                    .tools
                    .lock()
                    .await
                    .iter()
                    .any(|t| t.server_name == name);
                if had_previous {
                    tracing::warn!(
                        server = %name,
                        error = %e,
                        "MCP tools/list refresh failed; keeping the previously discovered tool list"
                    );
                }
                return Err(e);
            }
        };
        let count = tools.len();
        {
            let mut all = self.tools.lock().await;
            all.retain(|t| t.server_name != name);
            all.extend(tools);
        }
        self.connections.lock().await.insert(
            name.to_string(),
            Arc::new(ConnectionSlot { conn: Mutex::new(conn) }),
        );
        // A successful connect is the one place that resets the failure streak:
        // the backoff must start over from the base delay next time it breaks.
        {
            let mut map = self.health.lock().await;
            let mut h = ServerHealth::connected(count);
            if let Some(prev) = map.get(name) {
                h.reconnects = prev.reconnects;
            }
            map.insert(name.to_string(), h);
        }
        Ok(count)
    }

    /// Record a connect/handshake failure into the health map.
    ///
    /// Shared by both failure paths of `connect_and_register` (open failed vs
    /// `tools/list` failed) so the two cannot drift into reporting the same
    /// problem differently. Preserves the reconnect counters: a failure streak is
    /// what drives the backoff, and wiping it here would reset the backoff on
    /// every attempt and let a permanently-broken server be respawned at the base
    /// delay forever.
    async fn record_failure(&self, name: &str, e: &anyhow::Error, config: &McpServerConfig) {
        let reason = humanize_connect_error(&e.to_string(), &config.resolved_type());
        let mut map = self.health.lock().await;
        match map.get_mut(name) {
            Some(h) => {
                h.state = "failed".into();
                h.last_error = reason;
                h.tools = 0;
            }
            None => {
                map.insert(name.to_string(), ServerHealth {
                    state: "failed".into(),
                    last_error: reason,
                    ..Default::default()
                });
            }
        }
    }

    /// Release a connection's OS resources without touching the registry.
    ///
    /// Thin wrapper over [`kill_connection`] for owned connections (a handshake
    /// that failed before the connection was ever registered). Keeping one
    /// implementation for both shapes means a transport-specific cleanup step
    /// cannot be added to one and forgotten in the other.
    async fn drop_connection(mut conn: Connection) {
        Self::kill_connection(&mut conn).await;
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

        let mut conn = StdioConnection {
            child,
            stdin,
            stdout_lines,
            next_id: 1,
            // Phase split: the handshake is a *connect* operation and may need
            // a cold `npx`/`uvx` spawn, so it gets its own (potentially longer)
            // budget. Every later RPC falls back to the general `timeout`.
            connect_timeout: config.timeout_for(TimeoutPhase::Connect),
            timeout: parse_timeout(&config.timeout),
            poisoned: false,
        };

        // Handshake with protocol-version negotiation, identical in spirit to the
        // HTTP path: request our newest supported version; if the server answers
        // `-32602` and advertises a `supported` list, retry once pinned to the
        // newest common version. Stdio is the dominant transport in production, so
        // this path must be as complete as HTTP, not a stub.
        //
        // The retry reuses the same child process on a fresh RPC id: a rejected
        // `initialize` does not kill the server, so we do not pay spawn cost twice.
        // Three-state protocol mode (see [`McpProtocolMode`]): Legacy keeps the
        // exact old behaviour; Auto/Stateless widen what a server may report.
        // Resolved once from the per-server config so all three handshake paths
        // in this function agree on the mode.
        let mode = config.protocol_mode();
        match Self::rpc_stdio(&mut conn, "initialize", Self::initialize_params_for(config)).await {
            Ok(init_result) => {
                if let Err(e) = Self::accept_negotiated_version_for(&config.command, mode, PROTOCOL_VERSION, &init_result) {
                    return Err(Self::kill_stdio(conn, e).await);
                }
            }
            Err(e) => {
                // Only a version rejection is retryable, and only once.
                let common = e
                    .downcast_ref::<UnsupportedProtocolVersion>()
                    .cloned()
                    .and_then(|r| pick_common_version_for(mode, &r.supported));
                match common {
                    Some(common) => {
                        tracing::info!(
                            command = %config.command,
                            requested = PROTOCOL_VERSION,
                            retrying_with = %common,
                            "MCP handshake rejected our protocol version, retrying on a common one"
                        );
                        match Self::rpc_stdio(&mut conn, "initialize", Self::initialize_params_pinned(config, &common)).await {
                            Ok(init_result) => {
                                if let Err(e2) =
                                    Self::accept_negotiated_version_for(&config.command, mode, &common, &init_result)
                                {
                                    return Err(Self::kill_stdio(conn, e2).await);
                                }
                            }
                            // Report the original rejection too: it is the reason
                            // the retry happened at all, and alone the retry error
                            // would look like a random failure.
                            Err(e2) => {
                                let both = anyhow::anyhow!("{} (retry on {} also failed: {})", e, common, e2);
                                return Err(Self::kill_stdio(conn, both).await);
                            }
                        }
                    }
                    None => return Err(Self::kill_stdio(conn, e).await),
                }
            }
        }
        Self::notify_stdio(&mut conn, "notifications/initialized").await?;
        Ok(conn)
    }

    /// Kill a child whose handshake failed, then return the original error.
    ///
    /// An abandoned `initialize` must not leave a live server process behind: the
    /// caller only sees an error, so nothing else will ever reap it.
    async fn kill_stdio(mut conn: StdioConnection, err: anyhow::Error) -> anyhow::Error {
        Self::shutdown_stdio(&mut conn).await;
        err
    }

    /// The `initialize` params with no per-server capability projection.
    ///
    /// Kept as a test seam: production has used [`Self::initialize_params_for`]
    /// since capabilities became per-server, but the regression tests assert
    /// the *default* handshake shape (version + clientInfo) independently of
    /// any config, which is exactly what this wrapper isolates.
    #[allow(dead_code)]
    fn initialize_params() -> serde_json::Value {
        Self::initialize_params_at(PROTOCOL_VERSION)
    }

    /// The `initialize` params, projecting only the capabilities this server
    /// was explicitly granted. Used by all three transports so a trusted local
    /// server and an untrusted remote one cannot drift into different surfaces.
    fn initialize_params_for(config: &McpServerConfig) -> serde_json::Value {
        let mut p = Self::initialize_params_at(PROTOCOL_VERSION);
        p["capabilities"] = ProjectedCapabilities::for_config(config).as_json();
        p
    }

    /// Pinned-version variant that also projects capabilities, used by the
    /// `-32602` downgrade retry: the second `initialize` must not silently
    /// regress to a different capability surface than the first.
    fn initialize_params_pinned(config: &McpServerConfig, version: &str) -> serde_json::Value {
        let mut p = Self::initialize_params_at(version);
        p["capabilities"] = ProjectedCapabilities::for_config(config).as_json();
        p
    }

    /// `initialize` params pinned to a specific protocol version.
    ///
    /// Used by the downgrade retry: after a `-32602`, the second handshake must
    /// request a version the server actually advertised, not our preference.
    fn initialize_params_at(version: &str) -> serde_json::Value {
        serde_json::json!({
            "protocolVersion": version,
            "capabilities": {},
            // Version comes from the workspace package, not a literal: a stale
            // number here is invisible (servers only log it) yet misleading.
            "clientInfo": { "name": "gwork", "version": env!("CARGO_PKG_VERSION") }
        })
    }

    /// Validate the protocol version a server negotiated and log the outcome.
    ///
    /// Legacy-mode entry point kept as a test seam so the pre-existing
    /// "unsupported version fails the connect" contract stays explicitly
    /// pinned. Mode-aware connects use [`Self::accept_negotiated_version_for`].
    #[allow(dead_code)]
    fn accept_negotiated_version(
        server: &str,
        requested: &str,
        init_result: &serde_json::Value,
    ) -> anyhow::Result<String> {
        Self::accept_negotiated_version_for(server, McpProtocolMode::Legacy, requested, init_result)
    }

    /// Mode-aware negotiation: the single place where a handshake's answer is
    /// interpreted, validated, **recorded** and turned into the version header.
    ///
    /// The `tracing` record is not decoration. The whole point of the three-mode
    /// rollout is to observe how often real servers answer `2026-07-28` before
    /// deciding whether to move the default; without a per-handshake structured
    /// event that decision would be made on anecdotes. `record.emit` carries the
    /// mode, requested/reported/chosen versions, the outcome bucket and whether
    /// a fallback was used, so a log query is enough to measure the distribution.
    fn accept_negotiated_version_for(
        server: &str,
        mode: McpProtocolMode,
        requested: &str,
        init_result: &serde_json::Value,
    ) -> anyhow::Result<String> {
        let reported = init_result["protocolVersion"].as_str().unwrap_or("");
        let record = negotiation_record(mode, requested, reported)?;
        record.emit(server);
        if record.outcome == "downgraded" {
            tracing::info!(
                requested = requested,
                negotiated = %record.chosen,
                server = %server,
                "MCP protocol version downgraded by server"
            );
        }
        Ok(record.chosen)
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
        // A write error means the child is gone (broken pipe). Classify it as a
        // dead transport so the caller can rebuild instead of surfacing an opaque
        // io error — that is the difference between "this tool is broken for the
        // rest of the session" and "one call failed, next one works".
        if let Err(e) = conn.stdin.write_all(line.as_bytes()).await {
            conn.poisoned = true;
            return Err(TransportDead { reason: format!("MCP stdio write failed: {}", e) }.into());
        }
        if let Err(e) = conn.stdin.flush().await {
            conn.poisoned = true;
            return Err(TransportDead { reason: format!("MCP stdio flush failed: {}", e) }.into());
        }

        // Read lines until we get our response. The overall deadline is the
        // server's configured timeout (not a hardcoded 30s); the per-read cap is
        // the same value so a silent server fails within one timeout window.
        // One read path, three budgets. `initialize` is the cold-start window,
        // `tools/list` is discovery, everything else is a normal call. Picking
        // here (rather than in `open_stdio`) means a `-32602` retry handshake
        // also gets the connect budget, which is exactly when it is needed.
        let read_timeout = match method {
            "initialize" => conn.connect_timeout,
            "tools/list" => conn.timeout,
            _ => conn.timeout,
        };
        let deadline = tokio::time::Instant::now() + read_timeout;
        let mut buf = String::new();
        loop {
            if tokio::time::Instant::now() > deadline {
                // The reply may still arrive later and sit in the pipe; mark the
                // connection poisoned so the next call does not mistake it for
                // its own answer.
                conn.poisoned = true;
                return Err(TransportDead {
                    reason: format!("MCP RPC timeout for method {} (after {:?})", method, read_timeout),
                }.into());
            }
            buf.clear();
            let n = match tokio::time::timeout(
                read_timeout,
                conn.stdout_lines.read_line(&mut buf),
            ).await {
                Ok(Ok(n)) => n,
                Ok(Err(e)) => {
                    conn.poisoned = true;
                    return Err(TransportDead { reason: format!("MCP stdio read failed: {}", e) }.into());
                }
                Err(_) => {
                    conn.poisoned = true;
                    return Err(TransportDead {
                        reason: format!("MCP RPC timeout for method {} (after {:?})", method, read_timeout),
                    }.into());
                }
            };
            if n == 0 {
                // EOF: the server closed stdout, i.e. the process exited. This is
                // the common "stdio server died" case and the one automatic
                // reconnect exists for.
                conn.poisoned = true;
                return Err(TransportDead { reason: "MCP server closed stdout".to_string() }.into());
            }
            let trimmed = buf.trim();
            if trimmed.is_empty() { continue; }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
                if v["id"] == serde_json::json!(id) {
                    // Route through the shared checker so stdio and HTTP classify
                    // errors identically. Bailing with a formatted string here
                    // (the old behavior) silently disabled the `-32602`
                    // protocol-version retry for stdio: that retry downcasts to
                    // `UnsupportedProtocolVersion`, which only `check_rpc_error`
                    // ever produces — so it could never fire on this transport,
                    // which is the one most servers actually use.
                    return check_rpc_error(v);
                }
            }
        }
    }

    /// Call a tool on an MCP server, returning the structured result.
    ///
    /// Returns [`McpCallResult`] rather than a bare string so neither the
    /// server's `isError` flag nor non-text content is lost:
    ///   * `result.isError` is propagated — a tool that reports failure must not
    ///     look like success to the model (the old code joined the text and
    ///     returned `Ok`, discarding the flag).
    ///   * `image` blocks become data URLs for the vision channel; `audio`,
    ///     `resource` and `resource_link` blocks become a typed placeholder so a
    ///     reply that carries only those is never silently empty.
    pub async fn call_tool(
        &self,
        server_name: &str,
        tool_name: &str,
        args: serde_json::Value,
    ) -> anyhow::Result<McpCallResult> {
        let params = || serde_json::json!({ "name": tool_name, "arguments": args.clone() });
        // Resolve the output ceiling once, before the call: it belongs to the
        // server config (retained for reconnects), not to the connection slot,
        // so a rebuild mid-call cannot change it under us.
        let output_limit = self
            .configs
            .lock()
            .await
            .get(server_name)
            .map(|c| c.output_limit_for(tool_name))
            .unwrap_or(DEFAULT_TOOL_OUTPUT_LIMIT);

        // ── Path A: no live connection at all ────────────────────────────────
        // Used to be a hard "MCP server not connected" bail. But we now retain
        // every config we were asked to connect, so a dropped connection is
        // recoverable in-process: rebuild it rather than telling the model the
        // tool does not exist for the rest of the session.
        let slot = match self.slot_for(server_name).await {
            Some(s) => s,
            None => {
                if self.configs.lock().await.contains_key(server_name) {
                    let cause = anyhow::anyhow!(
                        "MCP server {} has no live connection",
                        server_name
                    );
                    self.reconnect_if_needed(server_name, &cause).await?
                } else {
                    return Err(anyhow::anyhow!("MCP server not connected: {}", server_name));
                }
            }
        };

        // ── Path B: connection poisoned by an earlier failure ────────────────
        // A stdio connection poisoned by a previous timeout still has the late
        // reply buffered in its pipe; reusing it would return that stale answer
        // as THIS call's result (observed live: call 2 returned call 1's
        // payload). Rebuild instead of failing, and certainly instead of reading.
        if Self::slot_is_dead(&slot).await {
            let cause = anyhow::anyhow!(
                "MCP server {} connection was lost (a previous call timed out)",
                server_name
            );
            let fresh = self.reconnect_if_needed(server_name, &cause).await?;
            // Safe to execute after this rebuild: the request was never sent, so
            // no server-side effect can have happened.
            let mut r = self.call_on_slot(server_name, &fresh, params()).await?;
            r.text = bound_tool_output(r.text, output_limit);
            return Ok(r);
        }

        // ── Path C: healthy-looking connection, RPC may still die mid-call ───
        let mut r = self.call_on_slot(server_name, &slot, params()).await?;
        r.text = bound_tool_output(r.text, output_limit);
        Ok(r)
    }

    /// Run one `tools/call` on a slot.
    ///
    /// **If the transport dies mid-call we rebuild the connection but deliberately
    /// do NOT re-send the request.** MCP makes no idempotency guarantee for
    /// `tools/call`, and a transport failure is ambiguous about whether the
    /// server did the work: a child that crashed, or a call that timed out while
    /// the server kept going, may both have already had side effects — a file
    /// written, an issue created, a message sent. Silently retrying would
    /// double-execute them, which is worse than reporting one failure, and the
    /// caller here is an LLM agent that is far better placed to judge whether a
    /// retry is safe.
    ///
    /// So the caller gets the original transport error *plus* the fact that the
    /// connection has been re-established. That is the actual regression being
    /// fixed: previously the connection was simply dropped and every later call
    /// failed with "not connected" until the user reopened settings and saved.
    /// Now the next call works on its own.
    async fn call_on_slot(
        &self,
        server_name: &str,
        slot: &Arc<ConnectionSlot>,
        params: serde_json::Value,
    ) -> anyhow::Result<McpCallResult> {
        let result = {
            let mut conn = slot.conn.lock().await;
            Self::rpc(&mut conn, "tools/call", params).await
        };

        match result {
            Ok(r) => Ok(parse_call_result(&r)),
            Err(e) => {
                // Only a dead transport is worth rebuilding. An MCP protocol
                // error (`-32601 method not found`, a tool's own `isError`, bad
                // arguments) means the connection is fine: respawning would cost
                // a process spawn plus a backoff delay while guaranteeing the
                // same failure.
                if !is_transport_dead(&e) {
                    return Err(e);
                }
                warn!(server = %server_name, error = %e, "MCP transport died mid-call; rebuilding connection, call NOT retried");
                match self.reconnect_if_needed(server_name, &e).await {
                    Ok(_) => Err(anyhow::anyhow!(
                        "{} — the MCP server connection was lost and has been re-established; \
                         this call was NOT retried because the server may already have executed it, \
                         so retry only if the tool is safe to run twice",
                        e
                    )),
                    // Recovery failed too; report both so the model knows the
                    // call is unsafe to repeat *and* that the server is down.
                    Err(re) => Err(anyhow::anyhow!("{} (reconnect failed: {})", e, re)),
                }
            }
        }
    }

    /// Convenience wrapper returning just the text, for callers that have no
    /// vision channel and treat a tool error as a hard failure (the built-in
    /// `codesearch` path). Keeping this thin wrapper means those call sites do
    /// not each re-derive the text/error mapping.
    pub async fn call_tool_text(
        &self,
        server_name: &str,
        tool_name: &str,
        args: serde_json::Value,
    ) -> anyhow::Result<String> {
        let r = self.call_tool(server_name, tool_name, args).await?;
        if r.is_error {
            anyhow::bail!("{}", if r.text.trim().is_empty() { "MCP tool returned isError".to_string() } else { r.text });
        }
        Ok(r.text)
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

    /// Resolve the authentication headers a connector needs right now.
    ///
    /// `authType: token` → the typed static token from the local vault.
    /// `authType: oauth` → `oauth::bearer_header_for`, which refreshes an
    /// expiring credential inline and never returns a credential scoped to a
    /// different resource. `none` → empty (the pre-existing behaviour).
    ///
    /// Credentials are NEVER read from `settings.json`: that file is shared
    /// with the Java kernel and routinely exported. The vault is a separate,
    /// local-only file.
    async fn resolve_auth_headers(config: &McpServerConfig) -> std::collections::HashMap<String, String> {
        let mut out = std::collections::HashMap::new();
        let spec = auth::AuthSpec::from_config(config);
        let url = config.url.trim();
        if url.is_empty() { return out; }
        let vault = auth::CredentialVault::at_home();
        match spec.kind() {
            auth::AuthKind::Token => {
                if let Some(t) = vault.get_static(url).await {
                    out.insert(t.header, format!("{}{}", t.prefix, t.value));
                }
            }
            auth::AuthKind::Oauth => {
                if let Some(value) = oauth::bearer_header_for(url, &vault).await {
                    out.insert("Authorization".to_string(), value);
                }
            }
            auth::AuthKind::None => {}
        }
        out
    }

    /// Build a reqwest client honouring the server's custom headers and timeout.
    fn http_client(config: &McpServerConfig) -> anyhow::Result<reqwest::Client> {
        let headers = Self::build_default_headers(config)?;
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
        // Same validation as `http_client`: this builder serves the SSE GET, a
        // separate code path that would otherwise bypass the reserved-header
        // check entirely and hand the server a user-forged session id.
        let headers = Self::build_default_headers(config)?;
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
        let auth_headers = Self::resolve_auth_headers(config).await;
        let mut conn = HttpConnection {
            client,
            post_url: config.url.clone(),
            session_id: None,
            // Empty until `initialize` returns: the header describes the
            // *negotiated* version, which does not exist yet during the
            // handshake itself, so sending it on `initialize` would advertise
            // an agreement nobody has made.
            protocol_version: String::new(),
            next_id: 1,
            sse_rx: None,
            sse_task: None,
            auth_headers,
        };
        // The session id arrives as a response header on initialize and must be
        // echoed on every later request, so it is captured before parsing the body.
        let mode = config.protocol_mode();
        let (init_result, requested) = {
            let resp = Self::http_post_raw(&conn, "initialize", 1, Self::initialize_params_for(config)).await?;
            conn.session_id = resp
                .headers()
                .get("mcp-session-id")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            match Self::read_rpc_body(resp, 1).await {
                Ok(r) => (r, PROTOCOL_VERSION.to_string()),
                // `-32602` carrying a `supported` list is the one handshake failure
                // worth retrying: pick the newest common version and redo the
                // handshake once, pinned to it. Claude Code does the same; without
                // it an older server simply reports "connect failed".
                Err(e) => {
                    let rejected = e.downcast_ref::<UnsupportedProtocolVersion>().cloned();
                    match rejected.and_then(|r| pick_common_version_for(mode, &r.supported)) {
                        Some(common) => {
                            tracing::info!(
                                url = %config.url,
                                requested = PROTOCOL_VERSION,
                                retrying_with = %common,
                                "MCP handshake rejected our protocol version, retrying on a common one"
                            );
                            let resp = Self::http_post_raw(
                                &conn,
                                "initialize",
                                2,
                                Self::initialize_params_pinned(config, &common),
                            )
                            .await?;
                            conn.session_id = resp
                                .headers()
                                .get("mcp-session-id")
                                .and_then(|v| v.to_str().ok())
                                .map(|s| s.to_string());
                            (Self::read_rpc_body(resp, 2).await.map_err(|e| {
                                Self::abort_conn(&mut conn);
                                e
                            })?, common)
                        }
                        None => {
                            Self::abort_conn(&mut conn);
                            return Err(e);
                        }
                    }
                }
            }
        };
        conn.protocol_version = Self::accept_negotiated_version_for(&config.url, mode, &requested, &init_result)
            .map_err(|e| {
                Self::abort_conn(&mut conn);
                e
            })?;
        Self::http_notify(&conn, "notifications/initialized").await?;
        Ok(conn)
    }

    /// Abort a half-built HTTP connection's stream task.
    ///
    /// Dropping the `JoinHandle` does not abort the task, so every early-exit
    /// path in the HTTP openers must call this or leak a task + socket per
    /// failed connect.
    fn abort_conn(conn: &mut HttpConnection) {
        if let Some(t) = conn.sse_task.take() {
            t.abort();
        }
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
        let auth_headers = Self::resolve_auth_headers(config).await;
        let mut sse_req = client
            .get(&config.url)
            .header(reqwest::header::ACCEPT, "text/event-stream");
        for (k, v) in &auth_headers {
            sse_req = sse_req.header(k.as_str(), v.as_str());
        }
        let resp = sse_req.send().await?;
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
            // See open_streamable: unset until negotiation completes.
            protocol_version: String::new(),
            next_id: 1,
            sse_rx: Some(rx),
            sse_task: Some(task),
            auth_headers,
        };
        // Handshake failures must abort the pump too — the `?` below used to
        // return with the task still running.
        let init_result = match Self::rpc_http(&mut conn, "initialize", Self::initialize_params_for(config)).await {
            Ok(r) => r,
            Err(e) => {
                Self::abort_conn(&mut conn);
                return Err(e);
            }
        };
        // Negotiated version governs the MCP-Protocol-Version header on the
        // `notifications/initialized` POST and every later request, so it must be
        // resolved before that notification is sent.
        match Self::accept_negotiated_version_for(&config.url, config.protocol_mode(), PROTOCOL_VERSION, &init_result) {
            Ok(v) => conn.protocol_version = v,
            Err(e) => {
                Self::abort_conn(&mut conn);
                return Err(e);
            }
        }
        if let Err(e) = Self::http_notify(&conn, "notifications/initialized").await {
            Self::abort_conn(&mut conn);
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

    /// Header names a user may not set through `headers`.
///
/// These are protocol-owned: the client derives them from the negotiated
/// session. Letting config pin them is not a cosmetic risk — a forged
/// `mcp-session-id` on `initialize` can attach this client to someone else's
/// session, and a stale `mcp-protocol-version` changes how the server parses
/// every message we send.
///
/// The gap is real and was measured on the wire, not assumed: during
/// `initialize` the client deliberately omits both headers (nothing has been
/// negotiated yet), so their slots are vacant and `reqwest`'s `default_headers`
/// fill them from user config ("insert default headers ... without overwriting
/// already appended headers"). Later requests do override them, which is exactly
/// why this went unnoticed — the handshake, the one place it matters most, was
/// the unprotected one.
///
/// Rejected rather than silently stripped: a user who wrote these believes they
/// take effect, and silently ignoring a header is how auth debugging goes wrong.
/// Zcode's client fail-closes on the same list.
pub const RESERVED_PROTOCOL_HEADERS: &[&str] = &[
    "mcp-protocol-version",
    "mcp-session-id",
];

/// Find reserved protocol headers in a user-supplied header map.
///
/// Case-insensitive (HTTP header names are), and returns the user's own spelling
/// so the error message names what they actually wrote.
pub fn reserved_header_conflicts(headers: &HashMap<String, String>) -> Vec<String> {
    headers
        .keys()
        .filter(|k| {
            let lower = k.trim().to_lowercase();
            Self::RESERVED_PROTOCOL_HEADERS.iter().any(|r| *r == lower)
        })
        .cloned()
        .collect()
}

/// Build the default header map for a server, rejecting reserved protocol headers.
///
/// Shared by both HTTP client builders (total-timeout and streaming) so the
/// validation cannot be added to one and forgotten in the other — the streaming
/// one is used for the SSE GET, which is a separate code path that would
/// otherwise bypass the check entirely.
fn build_default_headers(config: &McpServerConfig) -> anyhow::Result<reqwest::header::HeaderMap> {
    let conflicts = Self::reserved_header_conflicts(&config.headers);
    if !conflicts.is_empty() {
        anyhow::bail!(
            "headers {:?} are reserved for the MCP protocol and are set automatically \
             (session id and negotiated protocol version); remove them from the server's \
             `headers` config — other headers such as Authorization are unaffected",
            conflicts
        );
    }
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
    Ok(headers)
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
        // Spec (2025-11-25 Transports, "Protocol Version Header"): an HTTP client
        // MUST send the negotiated version on all *subsequent* requests. It is
        // omitted while still empty (i.e. during the handshake), because there is
        // no negotiated version yet and an empty header would advertise one.
        if !conn.protocol_version.is_empty() {
            req = req.header("MCP-Protocol-Version", conn.protocol_version.as_str());
        }
        if let Some(sid) = &conn.session_id {
            req = req.header("mcp-session-id", sid);
        }
        // Credentials resolved from the local vault. These override any static
        // `headers` of the same name: a stale API key typed into settings.json
        // must not beat a freshly authorised (or refreshed) OAuth token.
        for (k, v) in &conn.auth_headers {
            req = req.header(k.as_str(), v.as_str());
        }
        let resp = req.send().await?;
        let status = resp.status();
        if !status.is_success() {
            // Let the OAuth module interpret a 401 before flattening it into a
            // generic "MCP HTTP 401". A Bearer challenge with
            // `resource_metadata` is not an error to the OAuth client — it is
            // step one of discovery — and the operator needs an actionable
            // message instead of a bare status code. Static credentials (a bad
            // API key in `headers`) still get the plain "check your key" text.
            let www = resp
                .headers()
                .get(reqwest::header::WWW_AUTHENTICATE)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            let text = resp.text().await.unwrap_or_default();
            if status == reqwest::StatusCode::UNAUTHORIZED {
                let challenge = oauth::classify_401(www.as_deref());
                if challenge.should_authorize() {
                    tracing::info!(
                        target: "mcp.oauth",
                        resource_metadata = %challenge.resource_metadata.clone().unwrap_or_default(),
                        "MCP server requested OAuth authorization (401 + Bearer challenge)"
                    );
                    anyhow::bail!(
                        "MCP server requires authorization (HTTP 401 Bearer challenge). \
                         Open this connector's settings and click 连接/重新连接 to complete \
                         browser authorization (or enter a static token). The full OAuth 2.1 flow \
                         (discovery / dynamic registration / PKCE / loopback callback / token refresh) \
                         is implemented in mcp::auth + mcp::oauth and wired into the request path; \
                         a pre-issued bearer token in `headers` also still works. {}",
                        truncate(&text, 200)
                    );
                }
                if challenge.token_rejected() {
                    anyhow::bail!(
                        "MCP server rejected the supplied token (HTTP 401 invalid_token). \
                         For authType=token, clear the saved token and enter a fresh one; for \
                         authType=oauth, click 重新连接 to re-authorize (expiring tokens are \
                         refreshed automatically by mcp::auth::CredentialVault). {}",
                        truncate(&text, 200)
                    );
                }
            }
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
        let result = listed.map(|r| parse_tools(name, config, &r));
        Self::drop_connection(conn).await;
        result
    }

    /// Disconnect all servers.
    pub async fn shutdown(&self) {
        // Drain under the map lock, but tear down after releasing it: each
        // `drop_slot` may await an in-flight call on that slot, and doing that
        // while holding the map guard would block every other lookup.
        let slots: Vec<_> = {
            let mut conns = self.connections.lock().await;
            conns.drain().map(|(_, s)| s).collect()
        };
        for slot in slots {
            Self::drop_slot(slot).await;
        }
    }
}

impl Default for McpManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Parse a `tools/list` result into `McpTool`s, marking each tool enabled or
/// not per the server's `disallowedTools` denylist **and** `allowedTools`
/// allowlist.
///
/// Both filters are applied here — on the single path every discovery goes
/// through — rather than at the call sites, so a tool the user unchecked (or
/// excluded from the allowlist) is disabled whether it was found by a live
/// connect or a one-shot probe. It sets a flag instead of dropping the tool:
/// the panel still needs to list disabled tools so they can be re-enabled.
///
/// Precedence: `disallowedTools` always wins. A name present in both lists is
/// disabled, which is the only safe reading of a contradictory configuration.
/// An empty allowlist means "no restriction", preserving every existing config.
fn parse_tools(server_name: &str, config: &McpServerConfig, tools_result: &serde_json::Value) -> Vec<McpTool> {
    let deny: std::collections::HashSet<&str> =
        config.disallowed_tools.iter().map(|s| s.as_str()).collect();
    let allow: std::collections::HashSet<&str> =
        config.allowed_tools.iter().map(|s| s.as_str()).collect();
    tools_result["tools"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|t| {
                    let name = t["name"].as_str()?.to_string();
                    let permitted = !deny.contains(name.as_str())
                        && (allow.is_empty() || allow.contains(name.as_str()));
                    Some(McpTool {
                        enabled: permitted,
                        server_name: server_name.to_string(),
                        name,
                        description: t["description"].as_str().unwrap_or("").to_string(),
                        input_schema: t["inputSchema"].clone(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Bound one MCP tool's textual result to the server's configured ceiling.
///
/// Applied to the final `text` (including any typed placeholders for content
/// the client cannot render), **after** `isError` and images are extracted, so
/// truncation can never hide a failure flag or a returned screenshot. The
/// marker is deliberately explicit: a silently cut answer makes the model
/// believe the tool returned little data and it will not ask for a narrower
/// query. The marker tells it exactly what happened and what to do next.
fn bound_tool_output(text: String, limit: usize) -> String {
    let n = text.chars().count();
    if n <= limit {
        return text;
    }
    let kept: String = text.chars().take(limit).collect();
    format!(
        "{}\n\n[truncated MCP tool output: {} of {} characters shown; configure \
         `toolOutputLimits` or `maxToolOutputChars` for this server, or request a \
         smaller result]",
        kept, limit, n
    )
}

/// Maximum image data URL size accepted from an MCP tool (4 MB), matching the
/// cap the built-in `read` tool applies to disk images so an oversized payload
/// never silently enters the model's context.
const MAX_MCP_IMAGE_BYTES: usize = 4 * 1024 * 1024;

/// Turn a `tools/call` result into an [`McpCallResult`].
///
/// Walks every content block by type instead of only collecting text:
///   * `text` → appended verbatim.
///   * `image` → a `data:<mime>;base64,…` URL for the vision channel (skipped,
///     with a placeholder, when the base64 is absent or over [`MAX_MCP_IMAGE_BYTES`]).
///   * `audio` / `resource` / `resource_link` / unknown → a typed placeholder, so
///     a reply carrying only those is never an empty string the model reads as
///     "the tool returned nothing".
///
/// `isError` is read from the result object and propagated. When `content` is
/// absent entirely the raw result is serialised, preserving the previous
/// fallback for servers that answer with `structuredContent` and no content array.
fn parse_call_result(result: &serde_json::Value) -> McpCallResult {
    let is_error = result["isError"].as_bool().unwrap_or(false);
    let mut images = Vec::new();

    // No content array: fall back to the raw result so structuredContent-only
    // replies are not turned into an empty string.
    let text = match result["content"].as_array() {
        Some(arr) => {
            let mut parts: Vec<String> = Vec::new();
            for c in arr {
                match c["type"].as_str().unwrap_or("") {
                    "text" => {
                        if let Some(t) = c["text"].as_str() {
                            parts.push(t.to_string());
                        }
                    }
                    "image" => {
                        let mime = c["mimeType"].as_str().unwrap_or("image/png");
                        match c["data"].as_str() {
                            Some(b64) if !b64.is_empty() && b64.len() <= MAX_MCP_IMAGE_BYTES => {
                                images.push(format!("data:{};base64,{}", mime, b64));
                            }
                            _ => parts.push(format!(
                                "[image content omitted: missing or oversized {} data]",
                                mime
                            )),
                        }
                    }
                    other => {
                        let kind = if other.is_empty() { "unknown" } else { other };
                        parts.push(format!("[{} content not rendered]", kind));
                    }
                }
            }
            parts.join("\n")
        }
        None => serde_json::to_string(result).unwrap_or_default(),
    };

    McpCallResult { text, is_error, images }
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
            // `-32602` with a `supported` list is recoverable: the caller can redo
            // the handshake on a version both sides speak. Surface it as a typed
            // error so that stays possible instead of pattern-matching a string.
            if err["code"] == serde_json::json!(-32602) {
                if let Some(arr) = err["data"]["supported"].as_array() {
                    let supported: Vec<String> = arr
                        .iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect();
                    if !supported.is_empty() {
                        return Err(UnsupportedProtocolVersion { supported }.into());
                    }
                }
            }
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

/// Capabilities advertised to a server during `initialize`.
///
/// Projection, not a fixed object: Codex's rule is that a server only gets to
/// see the capabilities it is trusted to use. `elicitation` is the sensitive
/// one — it lets a remote MCP server pop a form at the user, so it is included
/// **only** when the operator explicitly set `allowElicitation` on that server.
/// Everything else stays empty (the pre-existing `{}`), which keeps the surface
/// area unchanged for all existing configurations.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub struct ProjectedCapabilities {
    #[serde(skip_serializing_if = "is_false", default)]
    pub elicitation: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

impl ProjectedCapabilities {
    pub fn for_config(config: &McpServerConfig) -> Self {
        Self { elicitation: config.allow_elicitation }
    }

    /// The `capabilities` member of an `initialize` request.
    pub fn as_json(&self) -> serde_json::Value {
        if self.elicitation {
            serde_json::json!({ "elicitation": {} })
        } else {
            serde_json::json!({})
        }
    }
}

/// A server→client `elicitation/create` request that this kernel will NOT
/// satisfy when the receiving server was not granted the capability.
///
/// Returned as an explicit error rather than silently ignored: a server that
/// sends an elicitation it was never offered deserves a JSON-RPC error it can
/// act on, not a timeout. Kept as a typed value so the guard is unit-testable
/// without spinning up a transport.
pub fn reject_unrequested_elicitation(
    config: &McpServerConfig,
    request: &serde_json::Value,
) -> Option<serde_json::Value> {
    if config.allow_elicitation {
        return None;
    }
    let id = request.get("id").cloned().unwrap_or(serde_json::Value::Null);
    Some(serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": -32601,
            "message": "elicitation is not enabled for this MCP server; \
                        set \"allowElicitation\": true on the server entry to permit it"
        }
    }))
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

    // ─── Batch-1 MCP fix regressions ───────────────────────────────────────
    //
    // These lock the five defects found by live probing: per-server denylist
    // (#1), isError swallowing (#2), non-text content loss (#3), name collision
    // (#4). Each asserts the *wiring* (parse_tools / parse_call_result / llm_name
    // are the single paths every connect and call flows through), not a detached
    // helper, so deleting the fix breaks the test.

    fn tools_result(names: &[&str]) -> serde_json::Value {
        let tools: Vec<serde_json::Value> = names
            .iter()
            .map(|n| serde_json::json!({"name": n, "description": "d", "inputSchema": {"type":"object"}}))
            .collect();
        serde_json::json!({ "tools": tools })
    }

    #[test]
    fn parse_tools_flags_denied_but_keeps_them() {
        // #1: an unchecked tool must be marked disabled, NOT dropped — dropping it
        // would make "re-enable" impossible because the panel lists all_tools().
        let mut cfg = McpServerConfig::default();
        cfg.disallowed_tools = vec!["banned".to_string()];
        let tools = parse_tools("srv", &cfg, &tools_result(&["ok", "banned"]));
        assert_eq!(tools.len(), 2, "a denied tool must still be listed");
        assert!(tools.iter().find(|t| t.name == "ok").unwrap().enabled);
        assert!(!tools.iter().find(|t| t.name == "banned").unwrap().enabled);
    }

    #[test]
    fn parse_tools_enables_all_when_no_denylist() {
        // The inverse: a server with no denylist must enable everything, so the
        // fix does not over-block (the #1 guard must not become a blanket deny).
        let cfg = McpServerConfig::default();
        let tools = parse_tools("srv", &cfg, &tools_result(&["a", "b"]));
        assert!(tools.iter().all(|t| t.enabled));
    }

    #[test]
    fn llm_name_is_namespaced_and_sanitized() {
        // #4: `mcp__<server>__<tool>`, with provider-illegal chars replaced.
        let t = McpTool {
            server_name: "my server!".into(),
            name: "do.thing".into(),
            description: String::new(),
            input_schema: serde_json::json!({}),
            enabled: true,
        };
        assert_eq!(t.llm_name(), "mcp__my_server___do_thing");
        // Two servers exposing `search` must not collide.
        let a = McpTool { server_name: "a".into(), name: "search".into(), ..t.clone() };
        let b = McpTool { server_name: "b".into(), name: "search".into(), ..t.clone() };
        assert_ne!(a.llm_name(), b.llm_name());
        // And no MCP name can equal a bare built-in name.
        assert!(!a.llm_name().starts_with("search"));
    }

    #[test]
    fn call_result_propagates_is_error() {
        // #2: server-reported tool failure must survive as is_error.
        let v = serde_json::json!({
            "content": [{"type":"text","text":"boom"}],
            "isError": true
        });
        let r = parse_call_result(&v);
        assert!(r.is_error);
        assert_eq!(r.text, "boom");
        // Absent isError defaults to success.
        let ok = parse_call_result(&serde_json::json!({"content":[{"type":"text","text":"fine"}]}));
        assert!(!ok.is_error);
    }

    #[test]
    fn call_result_extracts_images_as_data_urls() {
        // #3: an image block becomes a data URL for the vision channel.
        let v = serde_json::json!({
            "content": [{"type":"image","data":"AAAA","mimeType":"image/png"}]
        });
        let r = parse_call_result(&v);
        assert_eq!(r.images, vec!["data:image/png;base64,AAAA".to_string()]);
    }

    #[test]
    fn call_result_placeholders_for_unrenderable_content() {
        // #3: audio/resource/unknown blocks become a typed placeholder so an
        // image/audio-only reply is never a silent empty string.
        let v = serde_json::json!({"content":[{"type":"audio","data":"AAAA"}]});
        let r = parse_call_result(&v);
        assert!(r.images.is_empty());
        assert!(r.text.contains("audio"), "text was {:?}", r.text);
        assert!(!r.text.trim().is_empty());
    }

    #[test]
    fn call_result_rejects_oversized_image() {
        // #3 guard: an image over MAX_MCP_IMAGE_BYTES is placeholdered, not
        // silently pushed into the model context.
        let big = "A".repeat(MAX_MCP_IMAGE_BYTES + 1);
        let v = serde_json::json!({"content":[{"type":"image","data":big,"mimeType":"image/png"}]});
        let r = parse_call_result(&v);
        assert!(r.images.is_empty(), "oversized image must not enter the vision channel");
        assert!(r.text.contains("oversized"), "text was {:?}", r.text);
    }

    #[test]
    fn call_result_falls_back_to_raw_when_no_content_array() {
        // #3: a structuredContent-only reply (no content[]) must not become "".
        let v = serde_json::json!({"structuredContent":{"answer":42}});
        let r = parse_call_result(&v);
        assert!(!r.text.trim().is_empty());
        assert!(r.text.contains("42"), "text was {:?}", r.text);
    }

    #[test]
    fn stdio_timeout_comes_from_config() {
        // #5: the per-server `timeout` knob must reach the stdio connection
        // (was hardcoded 30s/10s, making the setting a no-op).
        let mut cfg = McpServerConfig::default();
        cfg.timeout = "3s".into();
        assert_eq!(parse_timeout(&cfg.timeout), std::time::Duration::from_secs(3));
    }

    // ─── #7 protocol version negotiation ──────────────────────────────────

    #[test]
    fn declared_version_is_the_stateful_one() {
        // Legacy remains the default and still does not *claim* the stateless
        // revision. The difference from the old permanent-refusal behaviour is
        // that this is now a per-mode property, not a hard-coded global one.
        assert_eq!(PROTOCOL_VERSION, "2025-11-25");
        assert!(SUPPORTED_PROTOCOL_VERSIONS.contains(&PROTOCOL_VERSION));
        assert!(!SUPPORTED_PROTOCOL_VERSIONS.contains(&STATELESS_PROTOCOL_VERSION));
        assert_eq!(McpProtocolMode::default(), McpProtocolMode::Legacy);
        assert!(!McpProtocolMode::Legacy.accepts_stateless());
    }

    #[test]
    fn three_state_mode_negotiation_and_fallback() {
        // Decision A, recommended shape: default Legacy + per-server opt-in +
        // fallback + telemetry. Legacy still refuses; Auto accepts but walks
        // back to the stateful version; Stateless echoes the stateless one.
        let legacy = negotiation_record(McpProtocolMode::Legacy, PROTOCOL_VERSION, "2026-07-28");
        assert!(legacy.is_err(), "Legacy must stay the safe default");
        assert!(legacy.unwrap_err().to_string().contains("protocolMode"));

        let auto = negotiation_record(McpProtocolMode::Auto, PROTOCOL_VERSION, "2026-07-28").unwrap();
        assert_eq!(auto.chosen, PROTOCOL_VERSION, "Auto must fall back to a version we implement");
        assert_eq!(auto.outcome, "auto_fallback");
        assert!(auto.used_fallback);
        assert_eq!(negotiate_protocol_version_for(McpProtocolMode::Auto, "2026-07-28"), Some(PROTOCOL_VERSION.to_string()));

        let stateless = negotiation_record(McpProtocolMode::Stateless, PROTOCOL_VERSION, "2026-07-28").unwrap();
        assert_eq!(stateless.chosen, STATELESS_PROTOCOL_VERSION);
        assert_eq!(stateless.outcome, "stateless_opt_in");
        assert!(!stateless.used_fallback);

        // Empty answer is "server said nothing" → keep ours, in every mode.
        for m in [McpProtocolMode::Legacy, McpProtocolMode::Auto, McpProtocolMode::Stateless] {
            let r = negotiation_record(m, PROTOCOL_VERSION, "").unwrap();
            assert_eq!(r.chosen, PROTOCOL_VERSION);
            assert_eq!(r.outcome, "unspecified");
        }
        // An unknown version is still rejected in every mode, telemetry or not.
        assert!(negotiation_record(McpProtocolMode::Auto, PROTOCOL_VERSION, "1999-01-01").is_err());
    }

    #[test]
    fn protocol_mode_parsing_is_fail_closed() {
        assert_eq!(McpProtocolMode::parse(""), McpProtocolMode::Legacy);
        assert_eq!(McpProtocolMode::parse("typo"), McpProtocolMode::Legacy);
        assert_eq!(McpProtocolMode::parse(" AUTO "), McpProtocolMode::Auto);
        assert_eq!(McpProtocolMode::parse("stateless"), McpProtocolMode::Stateless);
        assert_eq!(McpProtocolMode::parse("2026-07-28"), McpProtocolMode::Stateless);
        assert_eq!(McpProtocolMode::parse("auto").accepted_versions().len(), AUTO_ACCEPTED_VERSIONS.len());
        assert_eq!(McpProtocolMode::Legacy.accepted_versions().len(), SUPPORTED_PROTOCOL_VERSIONS.len());
    }

    #[test]
    fn stateless_retry_prefers_a_stateful_common_version_in_auto() {
        // On the -32602 retry path only an explicit Stateless opt-in should
        // select 2026-07-28; Auto must prefer a version we actually implement.
        let advertised = vec!["2026-07-28".to_string(), "2025-03-26".to_string()];
        assert_eq!(pick_common_version_for(McpProtocolMode::Auto, &advertised).as_deref(), Some("2025-03-26"));
        assert_eq!(pick_common_version_for(McpProtocolMode::Legacy, &advertised).as_deref(), Some("2025-03-26"));
        assert_eq!(pick_common_version_for(McpProtocolMode::Stateless, &advertised).as_deref(), Some("2026-07-28"));
        assert_eq!(pick_common_version(&["2026-07-28".into()]), None);
    }

    #[test]
    fn negotiation_accepts_only_versions_we_implement_in_legacy() {
        // An echo of our own version, and any older revision, is usable.
        for v in SUPPORTED_PROTOCOL_VERSIONS {
            assert_eq!(negotiate_protocol_version(v).as_deref(), Some(*v), "should accept {}", v);
        }
        // In Legacy a server on the stateless era cannot be spoken to.
        assert_eq!(negotiate_protocol_version("2026-07-28"), None);
        assert_eq!(negotiate_protocol_version("1999-01-01"), None);
        assert_eq!(negotiate_protocol_version(""), Some(PROTOCOL_VERSION.to_string()));
        // ...but Auto does accept it, via fallback.
        assert_eq!(negotiate_protocol_version_for(McpProtocolMode::Auto, "2026-07-28"), Some(PROTOCOL_VERSION.to_string()));
    }

    #[test]
    fn common_version_picks_newest_mutual_and_rejects_disjoint() {
        // Newest-first per our own list, not the order the server happened to send.
        assert_eq!(
            pick_common_version(&["2024-11-05".into(), "2025-03-26".into(), "2026-07-28".into()]).as_deref(),
            Some("2025-03-26")
        );
        // Only a version we do not implement (and Legacy mode): nothing to fall
        // back to. Auto/Stateless can still reach such a server.
        assert_eq!(pick_common_version(&["2026-07-28".into()]), None);
        assert_eq!(pick_common_version_for(McpProtocolMode::Stateless, &["2026-07-28".into()]).as_deref(), Some("2026-07-28"));
        assert_eq!(pick_common_version(&[]), None);
    }

    #[test]
    fn version_rejection_is_recognised_only_with_a_supported_list() {
        // `-32602` *with* a `supported` list is the one rejection the client can
        // act on (retry on a common version), so it must arrive as a typed error.
        let v = serde_json::json!({"jsonrpc":"2.0","id":1,"error":{
            "code":-32602,"message":"Unsupported protocol version",
            "data":{"supported":["2025-03-26","2024-11-05"]}}});
        let e = check_rpc_error(v).unwrap_err();
        let rej = e.downcast_ref::<UnsupportedProtocolVersion>().expect("typed rejection");
        assert_eq!(rej.supported, vec!["2025-03-26".to_string(), "2024-11-05".to_string()]);
        assert_eq!(pick_common_version(&rej.supported).as_deref(), Some("2025-03-26"));

        // `-32602` *without* a list is unrecoverable — must NOT be typed as a
        // version rejection, or the caller would retry forever on nothing.
        let v2 = serde_json::json!({"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"bad params"}});
        let e2 = check_rpc_error(v2).unwrap_err();
        assert!(e2.downcast_ref::<UnsupportedProtocolVersion>().is_none());

        // An unrelated protocol error must stay a plain error.
        let v3 = serde_json::json!({"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"method not found"}});
        assert!(check_rpc_error(v3).unwrap_err().downcast_ref::<UnsupportedProtocolVersion>().is_none());
    }

    #[test]
    fn negotiated_version_is_validated_at_connect() {
        let ok = serde_json::json!({"protocolVersion":"2024-11-05"});
        let got = McpManager::accept_negotiated_version("srv", PROTOCOL_VERSION, &ok).unwrap();
        assert_eq!(got, "2024-11-05", "must adopt the server's older version");

        // A stateless-era answer fails a Legacy connect loudly, naming both the
        // version and the opt-in knob. In Auto the same reply connects with a
        // recorded fallback, which is the whole point of Decision A.
        let bad = serde_json::json!({"protocolVersion":"2026-07-28"});
        let err = McpManager::accept_negotiated_version("srv", PROTOCOL_VERSION, &bad).unwrap_err();
        assert!(err.to_string().contains("2026-07-28"), "{}", err);
        assert!(err.to_string().contains("protocolMode"), "{}", err);
        let auto = McpManager::accept_negotiated_version_for("srv", McpProtocolMode::Auto, PROTOCOL_VERSION, &bad).unwrap();
        assert_eq!(auto, PROTOCOL_VERSION, "Auto must fall back, not echo the stateless version");

        // A server that states no version at all falls back to ours rather than
        // failing — plenty of real servers omit it.
        let silent = serde_json::json!({});
        assert_eq!(
            McpManager::accept_negotiated_version("srv", PROTOCOL_VERSION, &silent).unwrap(),
            PROTOCOL_VERSION
        );
    }

    #[test]
    fn initialize_params_advertise_the_declared_version() {
        // Guards the wiring, not just the constant: a refactor could reintroduce
        // a hardcoded older string here while leaving PROTOCOL_VERSION correct.
        let p = McpManager::initialize_params();
        assert_eq!(p["protocolVersion"], serde_json::json!(PROTOCOL_VERSION));
        assert_eq!(p["clientInfo"]["name"], serde_json::json!("gwork"));
        // The pinned variant is what the `-32602` retry sends.
        let p2 = McpManager::initialize_params_at("2024-11-05");
        assert_eq!(p2["protocolVersion"], serde_json::json!("2024-11-05"));
    }

    // ─── P1 / P2: allowlist, output ceiling, timeout phases, capability projection ──

    #[test]
    fn allowed_tools_whitelist_and_denylist_precedence() {
        let mut cfg = McpServerConfig::default();
        let result = serde_json::json!({"tools": [
            {"name": "keep", "description": "a", "inputSchema": {"type": "object"}},
            {"name": "hidden", "description": "b", "inputSchema": {"type": "object"}}
        ]});
        // Empty allowlist = no restriction (backwards compatible).
        let all = parse_tools("s", &cfg, &result);
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|t| t.enabled));

        cfg.allowed_tools = vec!["keep".into()];
        let filtered = parse_tools("s", &cfg, &result);
        assert_eq!(filtered.len(), 2, "disabled tools must stay listed for the panel");
        assert!(filtered.iter().find(|t| t.name == "keep").unwrap().enabled);
        assert!(!filtered.iter().find(|t| t.name == "hidden").unwrap().enabled);

        // disallowedTools wins over an allowlist that also contains the name.
        cfg.disallowed_tools = vec!["keep".into()];
        let denied = parse_tools("s", &cfg, &result);
        assert!(denied.iter().all(|t| !t.enabled));
    }

    #[test]
    fn per_tool_output_limit_is_configurable_and_char_safe() {
        let mut cfg = McpServerConfig::default();
        assert_eq!(cfg.output_limit_for("any"), DEFAULT_TOOL_OUTPUT_LIMIT);
        cfg.max_tool_output_chars = 100;
        assert_eq!(cfg.output_limit_for("any"), 100);
        cfg.tool_output_limits.insert("verbose".into(), 10);
        assert_eq!(cfg.output_limit_for("verbose"), 10);
        cfg.tool_output_limits.insert("zero".into(), 0);
        assert_eq!(cfg.output_limit_for("zero"), DEFAULT_TOOL_OUTPUT_LIMIT, "0 must not disable the cap");
        // Multi-byte characters must not be split.
        let text = "你好世界".repeat(10);
        let bounded = bound_tool_output(text.clone(), 5);
        assert!(bounded.starts_with("你好世界你"));
        assert!(bounded.contains("[truncated MCP tool output"));
        assert!(bounded.contains("of 40 characters"), "must report the real char count: {}", bounded);
        // Under the limit the text is returned byte-for-byte unchanged.
        assert_eq!(bound_tool_output("short".into(), 100), "short");
    }

    #[test]
    fn timeout_phases_have_independent_budgets() {
        let mut cfg = McpServerConfig::default();
        cfg.timeout = "7s".into();
        assert_eq!(cfg.timeout_for(TimeoutPhase::Call), std::time::Duration::from_secs(7));
        assert_eq!(cfg.timeout_for(TimeoutPhase::Connect), std::time::Duration::from_secs(7), "empty phase falls back");
        cfg.connect_timeout = "90s".into();
        cfg.discovery_timeout = "1500ms".into();
        cfg.auth_timeout = "20s".into();
        assert_eq!(cfg.timeout_for(TimeoutPhase::Connect), std::time::Duration::from_secs(90));
        assert_eq!(cfg.timeout_for(TimeoutPhase::Discovery), std::time::Duration::from_millis(1500));
        assert_eq!(cfg.timeout_for(TimeoutPhase::Auth), std::time::Duration::from_secs(20));
        assert_eq!(cfg.timeout_for(TimeoutPhase::Call), std::time::Duration::from_secs(7), "call unchanged");
    }

    #[test]
    fn capabilities_are_projected_per_server_not_global() {
        let mut cfg = McpServerConfig::default();
        assert_eq!(ProjectedCapabilities::for_config(&cfg).as_json(), serde_json::json!({}));
        assert_eq!(McpManager::initialize_params_for(&cfg)["capabilities"], serde_json::json!({}));
        cfg.allow_elicitation = true;
        assert_eq!(ProjectedCapabilities::for_config(&cfg).as_json(), serde_json::json!({"elicitation": {}}));
        assert_eq!(McpManager::initialize_params_for(&cfg)["capabilities"], serde_json::json!({"elicitation": {}}));
        // The pinned retry variant must not regress the capability surface.
        assert_eq!(McpManager::initialize_params_pinned(&cfg, "2024-11-05")["capabilities"], serde_json::json!({"elicitation": {}}));
    }

    #[test]
    fn ungranted_elicitation_is_rejected_with_a_jsonrpc_error() {
        let cfg = McpServerConfig::default();
        let req = serde_json::json!({"jsonrpc":"2.0","id":7,"method":"elicitation/create","params":{}});
        let err = reject_unrequested_elicitation(&cfg, &req).expect("must be rejected by default");
        assert_eq!(err["id"], serde_json::json!(7));
        assert_eq!(err["error"]["code"], serde_json::json!(-32601));
        assert!(err["error"]["message"].as_str().unwrap().contains("allowElicitation"));
        // An explicitly trusted server is allowed through (the caller handles it).
        let mut trusted = cfg;
        trusted.allow_elicitation = true;
        assert!(reject_unrequested_elicitation(&trusted, &req).is_none());
    }

    /// Scope note (codereview 2026-11-13): this pins the **classifier**, not the
    /// full wiring. `McpManager::http_post_body` does call `oauth::classify_401`
    /// on a 401 and bails with an actionable message, but discovery → dynamic
    /// registration → redirect → token exchange → refresh / credential store
    /// are implemented in `oauth.rs` and are **not** composed into the request
    /// path yet. The old name claimed "wired into 401 handling" while asserting
    /// only a pure function — the same false confidence as a tautological guard.
    /// Renamed to state exactly what is and is not covered; see WORK.md.
    #[test]
    fn oauth_401_challenge_classification_is_actionable() {
        // A Bearer challenge is not a static-credential failure: the 401 branch
        // must route it through oauth::classify_401 and tell the operator to
        // authorize, rather than flattening it into "MCP HTTP 401".
        let bearer = oauth::classify_401(Some(
            "Bearer realm=\"mcp\", resource_metadata=\"https://as.example/.well-known/oauth-protected-resource\"",
        ));
        assert!(bearer.should_authorize());
        assert!(bearer.resource_metadata.as_deref().unwrap_or("").contains("oauth-protected-resource"));
        assert!(!bearer.token_rejected());

        let rejected = oauth::classify_401(Some("Bearer error=\"invalid_token\""));
        assert!(rejected.token_rejected(), "expired/revoked token must be distinguishable from a first-time 401");

        // No challenge at all: a plain 401 stays a plain 401 (bad static key).
        let none = oauth::classify_401(None);
        assert!(!none.should_authorize());
        assert!(!none.token_rejected());
        // A Basic challenge must NOT trigger the OAuth flow.
        assert!(!oauth::classify_401(Some("Basic realm=\"proxy\"")).should_authorize());
    }

    #[test]
    fn new_config_fields_default_to_off_and_round_trip() {
        // A settings.json written by an older build / the Java kernel has none
        // of the new keys; it must parse with everything off.
        let cfg: McpServerConfig = serde_json::from_value(serde_json::json!({"type":"stdio","command":"npx"})).unwrap();
        assert_eq!(cfg.protocol_mode(), McpProtocolMode::Legacy);
        assert!(cfg.allowed_tools.is_empty());
        assert!(cfg.tool_output_limits.is_empty());
        assert_eq!(cfg.max_tool_output_chars, 0);
        assert!(!cfg.allow_elicitation);
        // Explicit opt-in survives a serialize/deserialize round trip.
        let mut opted = cfg;
        opted.protocol_mode = "auto".into();
        opted.allowed_tools = vec!["search".into()];
        opted.tool_output_limits.insert("search".into(), 42);
        opted.allow_elicitation = true;
        let v = serde_json::to_value(&opted).unwrap();
        assert_eq!(v["protocolMode"], serde_json::json!("auto"));
        assert_eq!(v["allowedTools"], serde_json::json!(["search"]));
        let back: McpServerConfig = serde_json::from_value(v).unwrap();
        assert_eq!(back.protocol_mode(), McpProtocolMode::Auto);
        assert_eq!(back.output_limit_for("search"), 42);
        assert!(back.allow_elicitation);
    }

    // ─── #8 health + reconnect accounting ─────────────────────────────────

    #[test]
    fn backoff_grows_then_caps() {
        // 250ms base, doubling, capped at 4s. A permanently-broken server must
        // not be respawned at the base delay forever.
        let d = |n| reconnect_backoff(n).as_millis() as u64;
        assert_eq!(d(0), 250);
        assert_eq!(d(1), 500);
        assert_eq!(d(2), 1000);
        assert_eq!(d(3), 2000);
        assert_eq!(d(4), 4000);
        // Beyond the cap it must stay capped, not overflow or wrap.
        assert_eq!(d(5), 4000);
        assert_eq!(d(50), 4000);
        assert_eq!(d(u32::MAX), 4000);
    }

    #[tokio::test]
    async fn health_defaults_to_disconnected_for_unknown_server() {
        let m = McpManager::new();
        let h = m.health_of("nope").await;
        assert!(!h.is_connected());
        assert_eq!(h.state, "disconnected");
        assert_eq!(h.tools, 0);
        // `health_all` must not invent servers that were never configured.
        assert!(m.health_all().await.is_empty());
    }

    #[tokio::test]
    async fn health_reports_failed_with_a_reason_when_connect_cannot_work() {
        // A stdio config pointing at a nonexistent binary: connect must fail, and
        // the failure must be recorded — not left as a bare "not connected" that
        // gives the user nothing to act on.
        let m = McpManager::new();
        let cfg = McpServerConfig {
            kind: "stdio".into(),
            enabled: true,
            command: "definitely-not-a-real-binary-xyz".into(),
            ..Default::default()
        };
        assert!(m.connect_one("broken", &cfg).await.is_err());
        let h = m.health_of("broken").await;
        assert_eq!(h.state, "failed", "health was {:?}", h);
        assert!(!h.last_error.is_empty(), "must explain the failure");
        assert!(!h.is_connected());
        // The config is retained (so it can be rebuilt later), which is why it
        // shows up in health_all at all.
        assert!(m.health_all().await.iter().any(|(n, _)| n == "broken"));
    }

    #[tokio::test]
    async fn transport_dead_is_only_set_for_connection_level_failures() {
        // Reconnect must be driven by a typed error, never by sniffing message
        // text: a reworded string would silently disable recovery.
        let dead: anyhow::Error = TransportDead { reason: "MCP server closed stdout".into() }.into();
        assert!(is_transport_dead(&dead));

        // A protocol error means the transport is fine; respawning would cost a
        // process and guarantee the same failure.
        let proto = check_rpc_error(serde_json::json!({
            "jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"method not found"}
        })).unwrap_err();
        assert!(!is_transport_dead(&proto));
        assert!(!is_transport_dead(&anyhow::anyhow!("some other failure")));
    }

    #[tokio::test]
    async fn forget_server_prevents_auto_resurrection() {
        // The user removed/disabled the server; a queued or later call must NOT
        // bring it back. This is the boundary that makes auto-reconnect safe.
        let m = McpManager::new();
        let cfg = McpServerConfig { kind: "stdio".into(), enabled: true, command: "nope-xyz".into(), ..Default::default() };
        let _ = m.connect_one("s", &cfg).await; // fails, but retains the config
        assert!(m.configs.lock().await.contains_key("s"));

        m.forget_server("s").await;
        assert!(!m.configs.lock().await.contains_key("s"), "config must be dropped");
        let h = m.health_of("s").await;
        assert!(!h.is_connected() && h.tools == 0, "health was {:?}", h);
        // Without a retained config there is nothing to rebuild from.
        let err = m.call_tool("s", "t", serde_json::json!({})).await.unwrap_err();
        assert!(err.to_string().contains("not connected"), "{}", err);
    }

    #[tokio::test]
    async fn disconnect_one_keeps_config_but_resets_health() {
        // `disconnect_one` doubles as "clean up before reconnecting", so unlike
        // `forget_server` it must retain the config — but it must not leave the
        // panel claiming a connection that no longer exists.
        let m = McpManager::new();
        let cfg = McpServerConfig { kind: "stdio".into(), enabled: true, command: "nope-xyz".into(), ..Default::default() };
        let _ = m.connect_one("s", &cfg).await;
        m.disconnect_one("s").await;
        assert!(m.configs.lock().await.contains_key("s"), "config must survive a disconnect");
        let h = m.health_of("s").await;
        assert_eq!(h.state, "disconnected");
        assert_eq!(h.tools, 0);
    }

    #[tokio::test]
    async fn reconnect_gate_is_per_server_and_stable() {
        // Two callers must get the SAME gate (otherwise both could respawn), and
        // different servers must get different gates (otherwise one server's slow
        // rebuild blocks another's — the #10 isolation property, applied here).
        let m = McpManager::new();
        let a1 = m.reconnect_gate("a").await;
        let a2 = m.reconnect_gate("a").await;
        let b1 = m.reconnect_gate("b").await;
        assert!(Arc::ptr_eq(&a1, &a2), "same server must share one gate");
        assert!(!Arc::ptr_eq(&a1, &b1), "different servers must not share a gate");
    }

    #[test]
    fn humanized_errors_are_actionable_not_raw() {
        // Lives in the mcp module so the settings panel and the manager's own
        // `last_error` cannot describe the same failure differently.
        let kind = "stdio";
        assert!(humanize_connect_error("connection timed out after 30s", kind).contains("超时"));
        assert!(humanize_connect_error("Connection refused (os error 10061)", kind).contains("拒绝"));
        assert!(humanize_connect_error("program not found: No such file or directory", kind).contains("未找到"));
        assert!(humanize_connect_error("MCP server closed stdout", kind).contains("握手"));
        // Unknown errors still surface the raw text rather than being blanked.
        assert!(humanize_connect_error("weird thing happened", kind).contains("weird thing happened"));
    }

    // ─── cold-start latch (runs must not miss tools that arrive late) ─────

    #[tokio::test]
    async fn startup_is_settled_by_default_so_idle_kernels_never_wait() {
        // The single most damaging mistake available here: defaulting the latch to
        // "not settled". A user with NO MCP servers never calls connect_all, so
        // nothing would ever mark it complete, and every single run would burn the
        // full wait timeout before sending its first model request.
        let m = McpManager::new();
        let started = std::time::Instant::now();
        assert!(m.wait_for_startup(std::time::Duration::from_secs(30)).await);
        assert!(started.elapsed() < std::time::Duration::from_millis(200),
            "an idle manager must return immediately, took {:?}", started.elapsed());
    }

    #[tokio::test]
    async fn begin_startup_parks_runners_until_marked_complete() {
        let m = Arc::new(McpManager::new());
        m.begin_startup();

        // While connecting, a runner must NOT proceed: it would snapshot an empty
        // tool list and never see the tools again for the whole run.
        assert!(!m.wait_for_startup(std::time::Duration::from_millis(60)).await,
            "must report not-settled while startup is in flight");

        // Completion wakes it.
        let waiter = {
            let m = m.clone();
            tokio::spawn(async move { m.wait_for_startup(std::time::Duration::from_secs(10)).await })
        };
        // Yield so the waiter is registered before we notify.
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        m.mark_startup_complete().await;
        assert!(waiter.await.expect("waiter panicked"), "waiter must be woken by completion");

        // And afterwards it is settled for everyone, without waiting.
        assert!(m.wait_for_startup(std::time::Duration::from_millis(50)).await);
    }

    #[tokio::test]
    async fn connect_all_settles_even_when_every_server_fails() {
        // A run must not wait for tools that are never coming. If a completion
        // signal were only published on success, a machine with one broken MCP
        // server would stall every run for the full timeout.
        let m = McpManager::new();
        let mut servers = HashMap::new();
        servers.insert("broken".to_string(), McpServerConfig {
            kind: "stdio".into(), enabled: true,
            command: "definitely-not-a-real-binary-xyz".into(), ..Default::default()
        });
        servers.insert("off".to_string(), McpServerConfig {
            kind: "stdio".into(), enabled: false,
            command: "whatever".into(), ..Default::default()
        });

        m.begin_startup();
        m.connect_all(&servers).await;
        assert!(m.wait_for_startup(std::time::Duration::from_millis(100)).await,
            "startup must settle even when all servers failed");
        // The broken one is reported, the disabled one is merely remembered.
        assert_eq!(m.health_of("broken").await.state, "failed");
    }

    #[tokio::test]
    async fn connect_all_on_empty_config_settles_immediately() {
        let m = McpManager::new();
        m.begin_startup();
        let started = std::time::Instant::now();
        m.connect_all(&HashMap::new()).await;
        assert!(m.wait_for_startup(std::time::Duration::from_secs(5)).await);
        assert!(started.elapsed() < std::time::Duration::from_millis(500),
            "an empty connect pass must not block, took {:?}", started.elapsed());
    }

    #[test]
    fn the_react_loop_waits_for_mcp_before_snapshotting_tools() {
        // Source-level guard for the wiring: the wait must sit BEFORE the snapshot
        // line, and the kernel must flip the latch BEFORE spawning connect_all.
        // Both orderings are exactly what makes the fix work, and both would
        // silently no-op if inverted (a `#[tokio::test]` could not catch the
        // server-side ordering at all, since that path needs a live HTTP server).
        let react = include_str!("../react/mod.rs");
        let wait_at = react.find("wait_for_startup(MCP_STARTUP_WAIT)")
            .expect("the loop must wait for MCP startup");
        let snap_at = react.find("let tool_defs = self.registry.definitions_async(")
            .expect("the snapshot line must still exist");
        assert!(wait_at < snap_at,
            "waiting AFTER snapshotting would leave the race wide open");
        // A timeout must not abort the run: it proceeds with what connected.
        assert!(react.contains("if !mcp.wait_for_startup(MCP_STARTUP_WAIT).await {"),
            "a timeout must degrade to a warning, not an error");

        // Normalise line endings first: this file is checked out as CRLF on
        // Windows, so a multi-line pattern containing `\n` never matches and the
        // assertion fails for a reason that has nothing to do with the code.
        let server = include_str!("../server/mod.rs").replace("\r\n", "\n");
        let begin = server.find("mcp.begin_startup();")
            .expect("the kernel must arm the latch");
        let spawn = server.find("tokio::spawn(async move {\n            mcp_bg.connect_all(")
            .expect("the kernel must spawn connect_all");
        assert!(begin < spawn,
            "arming the latch after spawning would miss a run accepted in between");
    }

    /// Protocol headers must win over user-configured `headers`.
    ///
    /// Zcode documents the *opposite* hazard on its own stack: it blacklists
    /// `mcp-session-id` and `mcp-protocol-version` from user config because there
    /// `requestInit.headers` overrides the protocol headers. Ours is inverted —
    /// user headers go through reqwest's `default_headers`, which only fills
    /// *vacant* slots (`client.rs`: "insert default headers in the request headers
    /// without overwriting already appended headers"), while the protocol headers
    /// are set per-request. So the same blacklist would be pointless here.
    ///
    /// Asserted against what actually goes on the wire rather than inferred from
    /// that vendor code: a reqwest upgrade could change the merge order, and the
    /// consequence would be silent (a server reading a stale protocol version).
    #[tokio::test]
    async fn protocol_headers_override_user_configured_headers() {
        use tokio::io::AsyncReadExt;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{}/mcp", addr);

        // Collected into shared state rather than returned from the task: an
        // `accept` loop never terminates, so awaiting the task would hang the test
        // forever. The recorder runs until the process ends; we read what it has
        // seen after the handshake settles.
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let rec = seen.clone();
        tokio::spawn(async move {
            loop {
                let (mut sock, _) = match listener.accept().await {
                    Ok(s) => s,
                    Err(_) => break,
                };
                let mut buf = vec![0u8; 8192];
                let mut acc = String::new();
                loop {
                    match tokio::time::timeout(
                        std::time::Duration::from_secs(2),
                        sock.read(&mut buf),
                    ).await {
                        Ok(Ok(0)) => break,
                        Ok(Ok(n)) => {
                            acc.push_str(&String::from_utf8_lossy(&buf[..n]));
                            if acc.contains("\r\n\r\n") { break; }
                        }
                        _ => break,
                    }
                }
                rec.lock().await.push(acc.to_lowercase());
                // Minimal valid JSON-RPC so the client does not error out and
                // stop the handshake before we can observe it.
                let body = format!(
                    "{{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{{\
                     \"protocolVersion\":\"{}\",\"capabilities\":{{}},\
                     \"serverInfo\":{{\"name\":\"hdr\",\"version\":\"1\"}}}}}}",
                    PROTOCOL_VERSION
                );
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                     Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(), body
                );
                let _ = tokio::io::AsyncWriteExt::write_all(&mut sock, resp.as_bytes()).await;
                let _ = tokio::io::AsyncWriteExt::flush(&mut sock).await;
            }
        });

        let mut cfg = McpServerConfig {
            kind: "streamable".into(), enabled: true, url: url.clone(),
            timeout: "5s".into(), ..Default::default()
        };
        // A user (or a malicious/copy-pasted config) tries to pin these. They must
        // not reach the wire: a forged session id would hijack another session and
        // a stale protocol version changes how the server parses our messages.
        cfg.headers.insert("MCP-Protocol-Version".into(), "1999-01-01".into());
        cfg.headers.insert("mcp-session-id".into(), "forged-session".into());
        cfg.headers.insert("X-Custom".into(), "kept".into());

        // The connect must be rejected before any request goes out, so the
        // assertion below expects an error AND an empty capture list.
        let m = McpManager::new();
        let m_err = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            m.connect_one("hdr", &cfg),
        ).await.expect("connect must not hang").err();
        m.shutdown().await;

        // Bounded: give the recorder a moment to flush the last request, then
        // snapshot. Never await the task itself.
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        let observed = seen.lock().await.clone();
        let joined = observed.join("\n----\n");

        // Fail-closed: the connect must be REFUSED, naming both offending headers
        // in the user's own spelling, rather than silently proceeding. Silently
        // stripping them is how auth debugging goes wrong — the user would believe
        // their pinned values took effect.
        let err = m_err.expect("a config pinning reserved headers must fail to connect");
        let msg = err.to_string();
        assert!(msg.contains("MCP-Protocol-Version"), "error must name the user's spelling: {}", msg);
        assert!(msg.contains("mcp-session-id"), "error must name both headers: {}", msg);
        assert!(msg.contains("reserved"), "error must explain why: {}", msg);

        // And nothing must have gone out at all: refusing before any request is
        // stronger than sending one with the forged values removed.
        assert!(observed.is_empty(),
            "no request should be sent for a rejected config, but saw:\n{}", joined);
    }

    /// Legitimate headers (auth etc.) must still reach the wire untouched.
    ///
    /// Companion to the test above: a blacklist that rejects everything would also
    /// "pass" it, so this pins the other half — Authorization and custom headers
    /// are unaffected.
    #[tokio::test]
    async fn legitimate_custom_headers_still_reach_the_wire() {
        use tokio::io::AsyncReadExt;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{}/mcp", addr);

        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let rec = seen.clone();
        tokio::spawn(async move {
            loop {
                let (mut sock, _) = match listener.accept().await {
                    Ok(s) => s,
                    Err(_) => break,
                };
                let mut buf = vec![0u8; 8192];
                let mut acc = String::new();
                loop {
                    match tokio::time::timeout(
                        std::time::Duration::from_secs(2),
                        sock.read(&mut buf),
                    ).await {
                        Ok(Ok(0)) => break,
                        Ok(Ok(n)) => {
                            acc.push_str(&String::from_utf8_lossy(&buf[..n]));
                            if acc.contains("\r\n\r\n") { break; }
                        }
                        _ => break,
                    }
                }
                rec.lock().await.push(acc.to_lowercase());
                let body = format!(
                    "{{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{{\
                     \"protocolVersion\":\"{}\",\"capabilities\":{{}},\
                     \"serverInfo\":{{\"name\":\"hdr\",\"version\":\"1\"}}}}}}",
                    PROTOCOL_VERSION
                );
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                     Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(), body
                );
                let _ = tokio::io::AsyncWriteExt::write_all(&mut sock, resp.as_bytes()).await;
                let _ = tokio::io::AsyncWriteExt::flush(&mut sock).await;
            }
        });

        let mut cfg = McpServerConfig {
            kind: "streamable".into(), enabled: true, url: url.clone(),
            timeout: "5s".into(), ..Default::default()
        };
        cfg.headers.insert("Authorization".into(), "Bearer real-token".into());
        cfg.headers.insert("X-Custom".into(), "kept".into());

        let m = McpManager::new();
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            m.connect_one("hdr", &cfg),
        ).await;
        m.shutdown().await;
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;

        let observed = seen.lock().await.clone();
        assert!(!observed.is_empty(), "a valid config must connect");
        let joined = observed.join("\n----\n");
        assert!(joined.contains("authorization: bearer real-token"),
            "auth header must pass through:\n{}", joined);
        assert!(joined.contains("x-custom: kept"),
            "custom header must pass through:\n{}", joined);
        // Once negotiated, the protocol version on later requests must be
        // exactly ours. codereview 2026-11-13: the previous
        // `|| contains("mcp-protocol-version")` fallback was tautological —
        // ANY value (stale, forged, empty) passed as long as the header NAME
        // appeared. Pin the exact negotiated value so a regression that emits
        // the wrong version is actually caught by this wire-level test.
        assert!(joined.contains(&format!("mcp-protocol-version: {}", PROTOCOL_VERSION.to_lowercase())),
            "the negotiated protocol version must be sent on later requests:\n{}", joined);
        assert!(!joined.contains("1999-01-01"), "no forged version present");
    }
}
