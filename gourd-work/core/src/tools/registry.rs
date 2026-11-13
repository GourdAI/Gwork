//! Tool registry — central catalog of available tools with permission filtering.
//!
//! Tools can request *suspension* (ask_user question / HITL approval). The ReAct
//! loop detects the suspension, persists a resume point, and halts. When the user
//! responds, the server resumes the run from that point.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::config::PermissionSettings;
use crate::llm::ToolDefinition;
use crate::mcp::{McpCallResult, McpManager, McpTool};
use crate::protocol::Frame;

/// Why a tool asked the run to suspend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuspendKind {
    /// ask_user structured question.
    Question,
    /// Human-in-the-loop approval gate (dangerous bash command).
    Hitl,
}

/// Tool execution result.
#[derive(Debug, Clone)]
pub struct ToolOutput {
    /// Textual result fed back to the LLM as observation.
    pub text: String,
    /// Whether execution failed (affects retry logic).
    pub is_error: bool,
    /// If set, the ReAct loop must suspend the run and persist a resume point.
    pub suspend: Option<SuspendRequest>,
    /// Image data URLs (data:image/png;base64,...) the model should *see*
    /// alongside `text`. Populated by the read tool for on-disk images: without
    /// this the model had no path from a disk image to its vision channel and
    /// fell back to OCR. Kept as data URLs (not raw bytes) because the outbound
    /// dialects already speak that form for user-attachment images.
    ///
    /// Cap is enforced at the tool (4 MB per image, see `MAX_IMAGE_READ_BYTES`)
    /// so an oversized image never silently enters the context.
    pub image_urls: Vec<String>,
}

/// A request from a tool to suspend the run.
#[derive(Debug, Clone)]
pub struct SuspendRequest {
    pub kind: SuspendKind,
    /// For HITL: the command awaiting approval (shown to the user).
    pub command: Option<String>,
    /// For HITL: the timeout the model asked for. Carried through the suspension
    /// so the approved command runs with the same ceiling, not a hardcoded one.
    pub timeout_ms: Option<u64>,
    /// For HITL: whether the model asked for background execution. Preserved so
    /// approval does not turn a detached task into a blocking synchronous run.
    pub background: bool,
}

impl ToolOutput {
    pub fn ok(text: impl Into<String>) -> Self {
        Self { text: text.into(), is_error: false, suspend: None, image_urls: Vec::new() }
    }
    pub fn err(text: impl Into<String>) -> Self {
        Self { text: text.into(), is_error: true, suspend: None, image_urls: Vec::new() }
    }
    /// Success result carrying images for the model's vision channel.
    pub fn ok_with_images(text: impl Into<String>, image_urls: Vec<String>) -> Self {
        Self { text: text.into(), is_error: false, suspend: None, image_urls }
    }
    pub fn suspend_question() -> Self {
        Self {
            text: String::new(),
            is_error: false,
            suspend: Some(SuspendRequest { kind: SuspendKind::Question, command: None, timeout_ms: None, background: false }),
            image_urls: Vec::new(),
        }
    }
    pub fn suspend_hitl(command: impl Into<String>, timeout_ms: Option<u64>, background: bool) -> Self {
        Self {
            text: String::new(),
            is_error: false,
            suspend: Some(SuspendRequest {
                kind: SuspendKind::Hitl,
                command: Some(command.into()),
                timeout_ms,
                background,
            }),
            image_urls: Vec::new(),
        }
    }
}

// ── MCP tool-catalog folding ─────────────────────────────────────────────────
//
// Flat `tools[]` entries cost their full description AND JSON schema on every
// request. A server that exposes hundreds of tools can therefore consume the
// whole context before the model reads the user's message. These four stages
// trade schema visibility for catalogue size: FULL/SUMMARY keep tools directly
// callable, LIST replaces the catalogue with one roster tool, and SEARCH hides
// even the roster behind a three-step lookup workflow. The thresholds count
// *visible* tools (after enabled / collision / denylist / gate filters), not
// `all_tools().len()`; otherwise a mostly disabled server would still fold the
// catalogue and hide tools the user explicitly enabled.

/// Below this count every MCP tool keeps its full description and schema.
pub const DYNAMIC_THRESHOLD: usize = 8;
/// At this count a single `list_mcp_tools` roster replaces per-tool schemas.
pub const LIST_THRESHOLD: usize = 40;
/// At this count the roster itself is replaced by search / detail / call tools.
pub const SEARCH_THRESHOLD: usize = 100;

/// Short descriptions are capped by Unicode scalar count, not bytes, so a CJK
/// or emoji description is cut on a valid `char` boundary.
pub const SUMMARY_DESCRIPTION_CHARS: usize = 120;
pub const SEARCH_DEFAULT_LIMIT: usize = 10;
pub const SEARCH_MIN_LIMIT: usize = 1;
pub const SEARCH_MAX_LIMIT: usize = 50;

pub const MCP_LIST_TOOL: &str = "list_mcp_tools";
pub const MCP_SEARCH_TOOL: &str = "search_tools";
pub const MCP_DETAIL_TOOL: &str = "get_tool_detail";
pub const MCP_CALL_TOOL: &str = "call_tool";

/// Whether a model-facing name belongs to the MCP folding gateway.
///
/// These names are intercepted before the generic MCP route. That ordering is
/// what prevents an MCP server from shadowing a gateway tool with the same raw
/// name; it also keeps historical session calls working even in FULL stage,
/// where no gateway definitions are advertised.
pub fn is_mcp_gateway_tool(name: &str) -> bool {
    matches!(name, MCP_LIST_TOOL | MCP_SEARCH_TOOL | MCP_DETAIL_TOOL | MCP_CALL_TOOL)
}

/// How the MCP catalogue is advertised for one run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpFoldStage {
    /// One complete schema per tool; identical to the pre-fold definitions.
    Full,
    /// One compact description and the original schema per tool.
    Summary,
    /// One roster tool; direct `llm_name` calls still work on the execute path.
    List,
    /// Search, inspect one schema, then forward a call through `call_tool`.
    Search,
}

/// Select a folding stage from the number of MCP tools actually visible to
/// this run. Kept pure so callers and tests can reason about threshold
/// boundaries without constructing an `McpManager`.
pub fn mcp_fold_stage(visible_count: usize) -> McpFoldStage {
    if visible_count < DYNAMIC_THRESHOLD {
        McpFoldStage::Full
    } else if visible_count < LIST_THRESHOLD {
        McpFoldStage::Summary
    } else if visible_count < SEARCH_THRESHOLD {
        McpFoldStage::List
    } else {
        McpFoldStage::Search
    }
}

/// First meaningful description line, shortened on a Unicode `char` boundary.
///
/// `…` is appended when truncation happened, so the model can distinguish a
/// deliberately short description from a clipped one. Newlines are removed
/// because rosters and search results are line-oriented.
pub fn mcp_short_description(description: &str) -> String {
    let first_line = description
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    let mut short: String = first_line.chars().take(SUMMARY_DESCRIPTION_CHARS).collect();
    if first_line.chars().count() > SUMMARY_DESCRIPTION_CHARS {
        short.push('…');
    }
    short
}

/// Apply the definition-time MCP filters ONCE, for every fold stage and for
/// gateway lookups, using the run's gate and live `PermissionSettings`.
///
/// `builtin_names` contains the registry's built-in function names. A server
/// must not win a name collision, and duplicate `llm_name()` values would be
/// rejected by provider APIs. `seen` is advanced before the denylist/gate
/// checks deliberately: that is the pre-fold builder's exact semantics, so a
/// duplicate that is filtered out still reserves its model-facing name. The
/// `tools` glob allowlist is intentionally NOT applied — MCP tools were never
/// gated by it, and applying it here would make them vanish under a narrow
/// built-in allowlist.
///
/// `ToolGate::from_permission` copies the user's global `disallowedTools` into
/// `gate.disallowed`, and sub-agent gates stack that blacklist with
/// `with_extra_disallowed`; `execute` passes the same live settings and gate as
/// `definitions_async`, so visibility and forwarding cannot drift.
pub fn visible_mcp_tools(
    all_tools: &[McpTool],
    builtin_names: &HashSet<String>,
    permission: &PermissionSettings,
    gate: Option<&ToolGate>,
) -> Vec<McpTool> {
    if gate.map(|g| !g.mcp_allowed).unwrap_or(false) {
        return Vec::new();
    }
    let mut seen: HashSet<String> = HashSet::new();
    all_tools
        .iter()
        .filter(|t| {
            if !t.enabled {
                return false;
            }
            let llm_name = t.llm_name();
            // Names are advertised under the namespaced id, so only a
            // collision with that model-facing id can shadow a built-in. A
            // server's raw `read` remains reachable as `mcp__server__read`;
            // built-in-first dispatch keeps the bare `read` unambiguous.
            // `seen` is inserted before the later denylist/gate checks to
            // match the pre-fold builder's de-duplication semantics.
            if builtin_names.contains(&llm_name) || !seen.insert(llm_name) {
                return false;
            }
            if permission.disallowed_tools.iter().any(|d| d == &t.name) {
                return false;
            }
            gate.map(|g| g.allows(&t.name, true)).unwrap_or(true)
        })
        .cloned()
        .collect()
}

/// Whether one synthetic gateway function is available to this run.
///
/// The global `disallowedTools` blacklist and the MCP axis of `ToolGate` both
/// apply. Use `ToolGate::allows(name, true)` rather than the built-in name
/// whitelist: MCP and its gateway are governed by `mcp_allowed`, so a sub-agent
/// that permits MCP does not have to enumerate four synthetic names in its
/// static `allowed` set. `ToolGate::disallowed` still wins.
pub fn mcp_gateway_is_allowed(
    name: &str,
    permission: &PermissionSettings,
    gate: Option<&ToolGate>,
) -> bool {
    if permission.disallowed_tools.iter().any(|d| d == name) {
        return false;
    }
    gate.map(|g| g.allows(name, true)).unwrap_or(true)
}

/// Build the MCP portion of `tools[]` for a stage. FULL/SUMMARY add no gateway
/// functions: with fewer than 40 tools the extra indirection costs more context
/// and more model turns than the schemas it would save. Gateway definitions in
/// LIST/SEARCH are filtered by the same permission/gate axes as their execute
/// interception, so an explicitly banned gateway name is never advertised.
pub fn mcp_definitions_for_stage(
    stage: McpFoldStage,
    visible: &[McpTool],
    permission: &PermissionSettings,
    gate: Option<&ToolGate>,
) -> Vec<ToolDefinition> {
    match stage {
        McpFoldStage::Full => visible
            .iter()
            .map(|t| ToolDefinition::new(&t.llm_name(), &t.description, t.input_schema.clone()))
            .collect(),
        McpFoldStage::Summary => visible
            .iter()
            .map(|t| {
                ToolDefinition::new(
                    &t.llm_name(),
                    &mcp_short_description(&t.description),
                    t.input_schema.clone(),
                )
            })
            .collect(),
        McpFoldStage::List => {
            let mut description = format!(
                "List the {} MCP tools visible to this run. Returns each namespaced llm_name and a one-line description. \
                 Call the returned llm_name directly; full schemas are intentionally omitted at this catalogue size.\n\
                 Visible MCP tools:\n",
                visible.len()
            );
            for t in visible {
                description.push_str(&format!(
                    "- {}: {}\n",
                    t.llm_name(),
                    mcp_short_description(&t.description)
                ));
            }
            if !mcp_gateway_is_allowed(MCP_LIST_TOOL, permission, gate) {
                return Vec::new();
            }
            vec![ToolDefinition::new(
                MCP_LIST_TOOL,
                &description,
                serde_json::json!({ "type": "object", "properties": {} }),
            )]
        }
        McpFoldStage::Search => {
            let workflow = format!(
                "{} MCP tools are visible. Workflow: 先 search_tools → get_tool_detail 取 schema → call_tool 执行. \
                 Individual schemas are hidden until get_tool_detail asks for one.",
                visible.len()
            );
            vec![
                ToolDefinition::new(
                    MCP_SEARCH_TOOL,
                    &format!(
                        "{workflow} Search by case-insensitive substring over llm_name, raw name and description; \
                         an empty query returns the first limit tools. Matches are ordered by relevance \
                         (raw-name equality, then llm_name, raw name, description and match position)."
                    ),
                    serde_json::json!({
                        "type": "object",
                        "properties": {
                            "query": {
                                "type": "string",
                                "description": "Case-insensitive substring; use an empty string to list the first tools."
                            },
                            "limit": {
                                "type": "integer",
                                "description": "Maximum number of matches, clamped to 1..50; defaults to 10."
                            }
                        },
                        "required": ["query"]
                    }),
                ),
                ToolDefinition::new(
                    MCP_DETAIL_TOOL,
                    &format!(
                        "{workflow} Resolve an llm_name or raw tool name and return that tool's complete input_schema JSON."
                    ),
                    serde_json::json!({
                        "type": "object",
                        "properties": {
                            "name": {
                                "type": "string",
                                "description": "The llm_name (mcp__server__tool) or raw tool name."
                            }
                        },
                        "required": ["name"]
                    }),
                ),
                ToolDefinition::new(
                    MCP_CALL_TOOL,
                    &format!(
                        "{workflow} Forward arguments to one visible MCP tool after its schema has been inspected."
                    ),
                    serde_json::json!({
                        "type": "object",
                        "properties": {
                            "name": {
                                "type": "string",
                                "description": "The llm_name (mcp__server__tool) or raw tool name to execute."
                            },
                            "arguments": {
                                "type": "object",
                                "description": "Arguments matching the schema returned by get_tool_detail."
                            }
                        },
                        "required": ["name", "arguments"]
                    }),
                ),
            ]
            .into_iter()
            .filter(|d| mcp_gateway_is_allowed(&d.function.name, permission, gate))
            .collect()
        }
    }
}

/// Resolve the `limit` argument with a default and a hard 1..50 clamp.
///
/// A model occasionally emits 0, a negative number, or an enormous integer.
/// Rejecting those would waste a turn; returning an unbounded number of tools
/// would defeat the point of SEARCH.
pub fn mcp_search_limit(value: Option<&serde_json::Value>) -> usize {
    let raw = value
        .and_then(|v| {
            v.as_i64()
                .map(|n| n as i128)
                .or_else(|| v.as_u64().map(|n| n as i128))
        })
        .unwrap_or(SEARCH_DEFAULT_LIMIT as i128);
    raw.clamp(SEARCH_MIN_LIMIT as i128, SEARCH_MAX_LIMIT as i128) as usize
}

fn mcp_search_rank(tool: &McpTool, needle: &str) -> Option<(u8, usize)> {
    let raw = tool.name.to_lowercase();
    if raw == needle {
        return Some((0, 0));
    }
    let fields = [
        (1u8, tool.llm_name().to_lowercase()),
        (2u8, raw),
        (3u8, tool.description.to_lowercase()),
    ];
    let mut best: Option<(u8, usize)> = None;
    for (rank, haystack) in fields {
        if let Some(byte_pos) = haystack.find(needle) {
            let char_pos = haystack[..byte_pos].chars().count();
            let candidate = (rank, char_pos);
            if best.map_or(true, |current| candidate < current) {
                best = Some(candidate);
            }
        }
    }
    best
}

/// Case-insensitive substring search over llm_name, raw name and description.
///
/// Exact raw-name equality wins, then earlier-ranked fields and earlier match
/// positions; the original discovery order breaks ties. An empty (or
/// whitespace-only) query is a bounded listing rather than an error, so the
/// model can page through a large catalogue without guessing a keyword.
pub fn search_mcp_tools<'a>(
    visible: &'a [McpTool],
    query: &str,
    limit: usize,
) -> Vec<&'a McpTool> {
    let limit = limit.clamp(SEARCH_MIN_LIMIT, SEARCH_MAX_LIMIT);
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return visible.iter().take(limit).collect();
    }
    let mut ranked: Vec<(usize, (u8, usize), &'a McpTool)> = visible
        .iter()
        .enumerate()
        .filter_map(|(index, t)| {
            mcp_search_rank(t, &needle).map(|rank| (index, rank, t))
        })
        .collect();
    ranked.sort_by_key(|(index, rank, _)| (*rank, *index));
    ranked
        .into_iter()
        .take(limit)
        .map(|(_, _, t)| t)
        .collect()
}

/// Resolve a gateway `name` parameter: namespaced ids win over raw names,
/// matching the direct MCP route. Called only on already-filtered lists.
pub fn resolve_mcp_tool<'a>(tools: &'a [McpTool], name: &str) -> Option<&'a McpTool> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    tools
        .iter()
        .find(|t| t.llm_name() == name)
        .or_else(|| tools.iter().find(|t| t.name == name))
}

/// Pure helper backing `get_tool_detail`: a full schema or an actionable error.
pub fn mcp_tool_detail_json(visible: &[McpTool], name: &str) -> Result<String, String> {
    let tool = resolve_mcp_tool(visible, name).ok_or_else(|| {
        format!(
            "MCP tool '{}' was not found among visible tools; call list_mcp_tools or search_tools first.",
            name
        )
    })?;
    serde_json::to_string_pretty(&tool.input_schema).map_err(|e| {
        format!(
            "Failed to serialize MCP tool schema for '{}': {}",
            name, e
        )
    })
}

/// The exact MCP result mapping used by both direct calls and `call_tool`.
/// `isError` must reach the model as a failure, image blocks must survive even
/// on that failure, an empty error gets a non-empty fallback naming the tool,
/// and transport errors must not be reported as success. The error type is
/// generic over `Display` so this helper itself needs no error crate; it
/// accepts whatever `McpManager::call_tool` already returns.
pub fn mcp_result_to_output<E: std::fmt::Display>(
    result: Result<McpCallResult, E>,
    tool_name: &str,
) -> ToolOutput {
    match result {
        Ok(r) if r.is_error => ToolOutput {
            text: if r.text.trim().is_empty() {
                format!("MCP tool '{}' failed", tool_name)
            } else {
                r.text
            },
            is_error: true,
            suspend: None,
            image_urls: r.images,
        },
        Ok(r) => ToolOutput {
            text: r.text,
            is_error: false,
            suspend: None,
            image_urls: r.images,
        },
        Err(e) => ToolOutput::err(format!("MCP tool error: {}", e)),
    }
}

/// Exact refusal text for a discovered-but-disabled MCP tool. Kept shared so
/// a `call_tool` forward cannot invent a different message from the direct
/// route (which the model may have learned from an older session).
pub fn mcp_disabled_output(name: &str) -> ToolOutput {
    ToolOutput::err(format!(
        "MCP tool '{}' is disabled by the user's tool settings. Do not retry it.",
        name
    ))
}

/// Resolve a `call_tool` target against the visible catalogue first, then
/// distinguish a discovered-but-disabled tool from a genuinely unknown name.
///
/// The visible list has already applied `enabled`, built-in collision,
/// deduplication, `disallowedTools` and `ToolGate`. Checking disabled tools
/// separately preserves the direct MCP route's stop-retrying message rather
/// than turning a disabled forward into a misleading "not found".
pub fn resolve_mcp_call_target<'a>(
    visible: &'a [McpTool],
    all_tools: &'a [McpTool],
    name: &str,
) -> Result<&'a McpTool, ToolOutput> {
    if let Some(t) = resolve_mcp_tool(visible, name) {
        return Ok(t);
    }
    if all_tools
        .iter()
        .any(|t| t.llm_name() == name || t.name == name)
    {
        return Err(mcp_disabled_output(name));
    }
    Err(ToolOutput::err(format!(
        "MCP tool '{}' was not found among visible tools; call search_tools first, \
         then get_tool_detail to obtain its schema.",
        name
    )))
}

/// Per-run tool whitelist, enforced at **both** ends of the registry.
///
/// `None` on [`ToolContext::gate`] means "no gate": the main agent runs under the
/// user's `permission` settings alone, which is the pre-existing behaviour.
///
/// # Why enforcement cannot stop at `definitions`
///
/// Filtering only the tool *definitions* is cosmetic. `execute` never checked
/// permissions at all — `is_allowed` had exactly one caller, the definitions
/// builder — so a model that emitted a tool name outside its whitelist still had
/// it run. That mattered even before sub-agents existed: a user who set
/// `permission.disallowedTools: ["bash"]` got `bash` hidden from the model but
/// perfectly callable, and any provider that let the model guess a name (or a
/// prompt injection that suggested one) bypassed the setting entirely.
///
/// Sub-agents make it load-bearing. They run with `access_mode: "full"` and
/// `hitl_approved: true`, so the HITL gate that would otherwise catch a dangerous
/// command is off, and the whitelist is the *only* thing separating `explore`
/// (whose own description promises the model "没有文件写权限") from `write`.
#[derive(Debug, Clone)]
pub struct ToolGate {
    /// Whitelist. `None` = everything not explicitly disallowed.
    pub allowed: Option<std::collections::HashSet<String>>,
    /// Blacklist; wins over `allowed` (Java `toolAddDo` checks
    /// `disallowedTools` before adding, at both definition and engine level).
    pub disallowed: std::collections::HashSet<String>,
    /// Whether MCP-provided tools are reachable.
    ///
    /// A separate flag rather than names in `allowed`: this kernel injects MCP
    /// tools flat into the registry alongside built-ins, and their names are
    /// server-defined, so a static whitelist could never enumerate them.
    pub mcp_allowed: bool,
}

impl ToolGate {
    /// No restrictions.
    pub fn open() -> Self {
        Self { allowed: None, disallowed: std::collections::HashSet::new(), mcp_allowed: true }
    }

    /// Gate carrying the user's global `disallowedTools`.
    ///
    /// This is what makes that setting real. Before, `is_allowed` had a single
    /// caller — the definitions builder — so a disallowed tool was hidden from
    /// the model but still executable if the model named it anyway (a hallucinated
    /// name, or a prompt injection suggesting one). Java checks the engine-level
    /// blacklist in `toolAddDo` at assembly time *and* per call.
    ///
    /// The glob `tools` allowlist stays a definitions-level concern: it decides
    /// what the model is offered, and its patterns (`web*`, `**`) are not
    /// expressible as a name set. `disallowedTools` is an exact-name list, so it
    /// can and does become a hard gate.
    pub fn from_permission(permission: &PermissionSettings) -> Self {
        Self {
            allowed: None,
            disallowed: permission.disallowed_tools.iter().cloned().collect(),
            mcp_allowed: true,
        }
    }

    /// This gate plus an extra blacklist — used to fold the user's global
    /// `disallowedTools` into a sub-agent's own whitelist, so a tool the user
    /// banned cannot be re-granted by an agent definition.
    pub fn with_extra_disallowed(mut self, names: impl IntoIterator<Item = String>) -> Self {
        self.disallowed.extend(names);
        self
    }

    /// Whether `name` may be called. `is_mcp` distinguishes MCP-routed tools,
    /// which are only reachable when the gate explicitly allows MCP.
    pub fn allows(&self, name: &str, is_mcp: bool) -> bool {
        if self.disallowed.contains(name) {
            return false;
        }
        if is_mcp {
            return self.mcp_allowed;
        }
        match &self.allowed {
            None => true,
            Some(set) => set.contains(name),
        }
    }
}

impl Default for ToolGate {
    fn default() -> Self {
        Self::open()
    }
}

/// Execution context passed to every tool invocation.
#[derive(Clone)]
pub struct ToolContext {
    /// Workspace root directory (all relative paths resolve against this).
    pub workspace: PathBuf,
    /// The session's own storage directory, when the caller resolved one.
    /// Per-session artefacts (currently `TODO.md`) belong here rather than in
    /// the shared workspace — see `ReActConfig::session_dir`.
    pub session_dir: Option<PathBuf>,
    /// Session ID for frame emission.
    pub session_id: String,
    /// The `tool_call_id` of **this** invocation.
    ///
    /// Suspension frames (`hitl`, `question`) must carry it: the frontend keys
    /// its cards by `actionId` and pairs the later `hitl_released` /
    /// `question_answered` frame against that same id. Emitting the literal
    /// `"pending"` instead — as an earlier version did — left the card with an id
    /// that nothing else ever matched, so switching to full access could not
    /// release a pending approval card and repeated question frames could not be
    /// recognized as the same round.
    ///
    /// Empty for callers that have no tool call (none today); tools then fall
    /// back to the previous placeholder rather than emitting an empty id.
    pub tool_call_id: String,
    /// Run ID (one input → one run); used by the file-change ledger.
    pub run_id: String,
    /// Frame sender — tools can push frames (e.g. HITL prompts) mid-execution.
    pub frame_tx: Option<mpsc::UnboundedSender<Frame>>,
    /// Access mode: "default" requires approval for dangerous ops; "full" skips.
    pub access_mode: String,
    /// Cooperative cancellation — set when the user hits Stop.
    pub cancel: CancellationToken,
    /// True when resuming a run after the user approved a HITL gate. Tools that
    /// gate on approval must skip re-prompting when this is set.
    pub hitl_approved: bool,
    /// Optional file-change ledger for capturing write/edit before/after states.
    pub change_ledger: Option<Arc<crate::changes::ChangeLedger>>,
    /// Per-run tool whitelist. `None` = ungated (the main agent, restricted only
    /// by the user's `permission` settings). See [`ToolGate`] for why this is
    /// enforced in `execute` and not merely in the definitions sent to the model.
    pub gate: Option<Arc<ToolGate>>,
    /// Nesting level of the current run. 0 = the main agent. `task`/`multitask`
    /// read it to refuse delegation past [`crate::team::MAX_SUBAGENT_DEPTH`].
    pub subagent_depth: u32,
    /// The **real** session the user is looking at.
    ///
    /// For a top-level run this equals `session_id`. For a sub-agent, `session_id`
    /// is the synthetic `sub-<task_id>` while this stays the conversation the
    /// frames must render into. `task`/`multitask` pass it down so nested
    /// delegation still attributes cards to the right session.
    pub root_session_id: String,
    /// The run's reasoning level, so a sub-agent inherits what the user picked
    /// for the conversation (Java `TaskTalent.resolveThinkingDepth`).
    pub thinking: Option<String>,
    /// The model **this run** is using, so a delegated sub-agent inherits it
    /// instead of falling back to the global default.
    ///
    /// # Why this has to live on the context
    ///
    /// `task`/`multitask` used to call a local `resolve_model()` that read
    /// `Settings::default_model_config()` and nothing else. The context carried
    /// no model, so the tools were physically unable to know what the
    /// conversation had selected — a user who picked a model in the chat picker
    /// got their sub-agents silently running on the default one. The symptom is
    /// invisible from the parent card: the delegation succeeds, it is merely
    /// answered by the wrong (and differently priced) model.
    ///
    /// `team::execute_task` already took a `session_model` parameter and
    /// documented the inheritance rule (Java `AgentFactory.create`:
    /// `isEmpty(getModel()) ? sessionModel : getModel()`); the contract was
    /// correct and the *caller* fed it the wrong value. Java fixed this same bug
    /// on its side and left a warning on `TaskTalent.resolveModelOverride`:
    /// reading only stale session state makes the sub-agent "silently downgrade",
    /// breaking the requirement that a sub-agent run with the same model and
    /// reasoning level as the run that spawned it.
    ///
    /// `Arc` because a `ToolContext` is rebuilt for **every tool call** while the
    /// model and settings are fixed for the whole run. Holding them by value
    /// would deep-copy the credentials and the entire model registry on every
    /// call; the `Arc` makes that a refcount bump.
    ///
    /// Note this is cheaper than what it replaced, not an added cost: the old
    /// code parsed settings.json from disk on *each* delegation.
    ///
    /// Not an `Option`: an absent model is exactly the silent-fallback shape this
    /// field exists to remove. Every production run resolves one before it starts
    /// (`server::run_react_session` aborts with a visible error when it cannot),
    /// so there is no honest "unknown model" state to represent.
    pub model: Arc<crate::config::ModelConfig>,
    /// The parent run's **live** settings.
    ///
    /// Same defect class as `model`: `task`/`multitask` re-read settings from
    /// disk with `Settings::load_default().unwrap_or_default()`, which discards
    /// the snapshot the run is executing against.
    ///
    /// The parent run takes its settings once, when the turn starts
    /// (`run_react_session` clones out of the `RwLock`). A disk re-read is
    /// therefore *a different point in time*: an edit saved while the run is
    /// mid-turn gives the sub-agent settings its parent is not using. The
    /// endpoints persist immediately after mutating memory, so this is a narrow
    /// window rather than a steady state — but a delegated run is exactly where
    /// turns are long enough for it to open.
    ///
    /// The unconditional failure is the second one: `unwrap_or_default()` turns
    /// an unreadable or absent file into `Settings::default()`, whose model
    /// registry is empty. Every delegation then reports "no model configured"
    /// while the parent — holding a snapshot loaded at startup — keeps running
    /// fine.
    pub settings: Arc<crate::config::Settings>,
    /// Directories exempt from the bash **path axis** boundary (settings.json
    /// `permission.bashExemptDirs`).
    ///
    /// Reads *and* writes are both exempt — Java `BashPathGuard.java:164`/
    /// `:194-196`, locked by `exemptionAlsoAppliesToReads`. Exempting only writes
    /// would make `cat ~/.m2/settings.xml` (an ordinary build-chain read) prompt on
    /// every run, and approval fatigue ends in blind clicking.
    ///
    /// Stored as the raw configured literals, not pre-resolved paths: `~` and
    /// environment variables must be expanded at judgement time so they follow
    /// runtime changes (Java `HitlStrategy.java:492`).
    pub bash_exempt_dirs: Vec<String>,
}

impl ToolContext {
    /// Whether the current access mode requires approval gates.
    pub fn approval_required(&self) -> bool {
        self.access_mode != "full"
    }

    /// Whether the workspace boundary of the file tools is lifted.
    ///
    /// Loosely mirrors the Java kernel's `AccessPolicy.isSpaceIsolated`, but
    /// the folding is **not identical**: Java computes
    /// `isSpaceIsolated(mode) && sandboxEnabled` (`TerminalTalent:173`) and
    /// has no embedder `sandboxEnabled` switch here, so this kernel folds only
    /// the tier. The user's full-access tier releases the workspace containment
    /// of read/write/edit/ls/glob/grep, so an absolute or `../` path into a
    /// sibling project resolves instead of dying with "Invalid path".
    ///
    /// Sub-agents are excluded **by depth**, not by tier, even though they run
    /// with `access_mode: "full"` (team/mod.rs): that value exists only to
    /// switch off their *approval gate*, and the workspace boundary is the only
    /// path containment a delegated run has (`ToolGate` limits which tools it
    /// holds, not where they reach).
    ///
    /// This is a deliberate divergence from Java, not an incomplete port:
    /// `TaskTalent.resolveAccessMode` (Java:506) inherits the parent session's
    /// tier, so a Java sub-agent of a full-access conversation is *also* open.
    /// Rust has no tier-inheritance chain yet, so the depth check keeps every
    /// delegated run contained regardless of the parent's tier. Aligning the
    /// two kernels requires adding tier inheritance to `ParentRun`, not
    /// deleting this check.
    pub fn space_open(&self) -> bool {
        self.access_mode == "full" && self.subagent_depth == 0
    }

    /// Where this session's `TODO.md` lives.
    ///
    /// Session directory when known — matching the Java kernel's
    /// `TodoTalent.getTodoPath`, which resolves `<sessions_root>/<sessionId>/TODO.md`
    /// — otherwise the legacy workspace path, kept so callers with no session
    /// storage (CLI, ACP, sub-agents) still get a working checklist.
    ///
    /// Both `todowrite` and `todoread` must go through this one function: when
    /// they disagreed about the location, a list written by the agent was
    /// invisible to `/web/chat/todos` and the task panel stayed permanently empty.
    pub fn todo_file(&self) -> PathBuf {
        crate::session::todo_path(self.session_dir.as_deref(), &self.workspace)
    }

    /// The `actionId` to stamp on suspension frames (`hitl`, `question`).
    ///
    /// Single source of truth so both tools and any future suspension-capable
    /// tool emit the same identifier the resume path persists as
    /// `pending_tool_call_id`. Falls back to the legacy `"pending"` placeholder
    /// only when no tool call id is available.
    pub fn action_id(&self) -> &str {
        if self.tool_call_id.is_empty() {
            "pending"
        } else {
            &self.tool_call_id
        }
    }

    /// The project root this invocation belongs to, when it can be determined.
    ///
    /// Derived from the session directory (`<root>/.gwork/sessions/<sid>`), which
    /// is ownership-routed by the server and therefore already points at the
    /// right project for sessions bound to one. `workspace` is *not* a valid
    /// substitute: it is the kernel's fixed install-time directory, so using it
    /// made project-scoped artefacts (memory, workspace skills) invisible in
    /// every project except that one.
    pub fn project_root(&self) -> Option<PathBuf> {
        self.session_dir
            .as_ref()
            .and_then(|dir| dir.parent())      // sessions
            .and_then(|p| p.parent())          // .gwork
            .and_then(|p| p.parent())          // <root>
            .map(|p| p.to_path_buf())
    }

    /// The memory store this tool invocation should read/write.
    ///
    /// Memory is workspace-scoped by default (Java's `MemorySolution` resolves
    /// against the session's project root), and the memory page reads
    /// `<project>/.gwork/memory`. Writing tool-saved memories to the *global*
    /// store instead — as an earlier version did — put them where the page never
    /// looks, so `memory_extract` appeared to succeed while the entry never
    /// showed up. Callers with no session storage (CLI, ACP, sub-agents) fall
    /// back to the global store.
    pub fn memory_store(&self) -> crate::memory::MemoryStore {
        match self.project_root() {
            Some(root) => crate::memory::MemoryStore::workspace(&root),
            None => crate::memory::MemoryStore::global(),
        }
    }

    /// Skill registry covering both the global and this project's skills.
    ///
    /// Scanning only the global directory made project-local skills invisible to
    /// `skillread` and to the system prompt, even though the settings page (which
    /// scans both) listed them.
    pub fn skill_registry(&self) -> crate::skills::SkillRegistry {
        match self.project_root() {
            Some(root) => crate::skills::SkillRegistry::with_workspace(&root),
            None => crate::skills::SkillRegistry::new(),
        }
    }
}

/// Trait implemented by every tool.
#[async_trait]
pub trait Tool: Send + Sync {
    /// Tool name (must match the function name sent to the LLM).
    fn name(&self) -> &str;
    /// Human-readable description.
    fn description(&self) -> &str;
    /// JSON Schema for parameters.
    fn parameters_schema(&self) -> serde_json::Value;
    /// Whether this tool is read-only (affects loop-detection fingerprinting).
    fn readonly(&self) -> bool { false }
    /// Execute the tool with parsed arguments.
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolOutput;
}

/// A registered tool with its LLM-facing definition.
pub struct ToolSpec {
    pub tool: Arc<dyn Tool>,
    pub definition: ToolDefinition,
}

/// Central tool registry.
pub struct ToolRegistry {
    tools: HashMap<String, ToolSpec>,
    order: Vec<String>,
    /// Optional MCP manager — unknown tool names are routed here.
    mcp: Option<Arc<McpManager>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self { tools: HashMap::new(), order: Vec::new(), mcp: None }
    }

    /// Attach an MCP manager so MCP-provided tools become callable.
    pub fn with_mcp(mut self, mcp: Arc<McpManager>) -> Self {
        self.mcp = Some(mcp);
        self
    }

    pub fn set_mcp(&mut self, mcp: Arc<McpManager>) {
        self.mcp = Some(mcp);
    }

    /// The attached MCP manager, if any.
    ///
    /// Exposed so the ReAct loop can wait for the startup connection pass to
    /// settle before snapshotting the tool list. Tool discovery still goes through
    /// `definitions_async` alone — this accessor is only for asking the manager
    /// "are servers connected yet?", which is a lifecycle question, not a
    /// second source of truth for what is advertised.
    pub fn mcp(&self) -> Option<&Arc<McpManager>> {
        self.mcp.as_ref()
    }

    /// Register a tool.
    pub fn register(&mut self, tool: Arc<dyn Tool>) {
        let name = tool.name().to_string();
        let definition = ToolDefinition::new(
            &name,
            tool.description(),
            tool.parameters_schema(),
        );
        self.order.push(name.clone());
        self.tools.insert(name, ToolSpec { tool, definition });
    }

    /// Get tool definitions filtered by permission settings **and** the run's
    /// gate, plus MCP tools folded according to the number that survive those
    /// filters. See [`mcp_fold_stage`]: small catalogues keep full schemas,
    /// medium ones shorten descriptions, and large ones advertise a single
    /// roster or a search/detail/call gateway instead of N schemas.
    pub async fn definitions_async(
        &self,
        permission: &PermissionSettings,
        gate: Option<&ToolGate>,
    ) -> Vec<ToolDefinition> {
        let mut defs = self.definitions(permission, gate);
        let Some(mcp) = &self.mcp else { return defs };
        let builtin_names: HashSet<String> = self.tools.keys().cloned().collect();
        let visible = visible_mcp_tools(&mcp.all_tools().await, &builtin_names, permission, gate);
        let stage = mcp_fold_stage(visible.len());
        defs.extend(mcp_definitions_for_stage(stage, &visible, permission, gate));
        defs
    }

    /// Get tool definitions filtered by permission settings and gate (built-in only).
    pub fn definitions(
        &self,
        permission: &PermissionSettings,
        gate: Option<&ToolGate>,
    ) -> Vec<ToolDefinition> {
        if permission.tools.is_empty() {
            tracing::warn!(
                "permission.tools allowlist is empty; treating it as '**' (all tools) so the model can still see and call them"
            );
        }
        self.order
            .iter()
            .filter_map(|name| {
                if self.is_allowed(name, permission) && gate.map(|g| g.allows(name, false)).unwrap_or(true) {
                    self.tools.get(name).map(|s| s.definition.clone())
                } else {
                    None
                }
            })
            .collect()
    }

    /// Check if a tool is allowed by permission config.
    ///
    /// An **empty** `tools` allowlist means "all built-ins", not "none". This is
    /// the Qoder / `PermissionSettings::default()` semantic and it is load-bearing
    /// for model visibility: `definitions()` filters through this method, so a
    /// settings file that loads without a `permission.tools` key (a fresh
    /// workspace, a partial save, a migrate from an older schema) used to filter
    /// OUT EVERY tool — including `skillread`/`skillsearch`/`skillrefresh`,
    /// which the skills summary explicitly tells the model to call. The request
    /// then went out with no `tools` key at all and the model, seeing no callable
    /// tools, answered with a one-line intent declaration that the ReAct loop
    /// faithfully treated as the final answer ("task ended unfinished").
    ///
    /// An explicit non-empty allowlist is still honoured exactly; only "no
    /// allowlist was configured" is fail-open. `disallowedTools` always wins.
    pub fn is_allowed(&self, name: &str, permission: &PermissionSettings) -> bool {
        if permission.disallowed_tools.iter().any(|d| d == name) {
            return false;
        }
        if permission.tools.is_empty() {
            return true;
        }
        permission.tools.iter().any(|pattern| {
            pattern == "**" || pattern == name || Self::glob_match(pattern, name)
        })
    }

    /// Simple glob matching: supports `*` wildcard.
    fn glob_match(pattern: &str, name: &str) -> bool {
        if pattern == "**" || pattern == "*" {
            return true;
        }
        if let Some(prefix) = pattern.strip_suffix('*') {
            return name.starts_with(prefix);
        }
        pattern == name
    }

    /// Execute a tool by name. Unknown names are routed to MCP if available.
    ///
    /// The gate is checked **here**, not only when building definitions. See
    /// [`ToolGate`]: filtering definitions alone left `execute` open to any name
    /// the model emitted, which made both `permission.disallowedTools` and every
    /// sub-agent whitelist advisory rather than enforced.
    ///
    /// Resolution happens *before* the gate check, so the two failure modes stay
    /// distinguishable. Reporting a nonexistent name as "not available to this
    /// agent" would assert that the tool exists and is merely forbidden — and the
    /// model, believing a capability is withheld rather than misnamed, gives up on
    /// it instead of correcting the name (a hallucinated `search_web` should point
    /// back at `websearch`, not at a permission wall).
    pub async fn execute(
        &self,
        name: &str,
        args: serde_json::Value,
        ctx: &ToolContext,
    ) -> ToolOutput {
        // Built-in first: an MCP server must not be able to shadow one, and this
        // also decides which axis of the gate applies.
        if let Some(spec) = self.tools.get(name) {
            if let Some(gate) = &ctx.gate {
                if !gate.allows(name, false) {
                    return Self::gated_out(name);
                }
            }
            return spec.tool.execute(args, ctx).await;
        }

        // MCP folding gateway. These four synthetic functions are the ONLY
        // model-facing tools in LIST/SEARCH stage; without this interception
        // the definitions would advertise names that `execute` reports as
        // "Unknown tool" — the exact dangling-mapping defect this folding
        // implementation exists to fix. They are also accepted unconditionally
        // in FULL/SUMMARY so a name persisted in an older session's history
        // still resolves.
        if is_mcp_gateway_tool(name) {
            let gate = ctx.gate.as_deref();
            // `ToolContext` carries the run's live settings snapshot. Its
            // `permission.disallowedTools` is the same blacklist that produced
            // the definitions; the gate additionally covers sub-agent-specific
            // denials. Avoid `PermissionSettings::default()` here: that would
            // let a globally banned gateway name become callable.
            if !mcp_gateway_is_allowed(name, &ctx.settings.permission, gate) {
                return Self::gated_out(name);
            }
            // A gateway name is useless without an MCP manager; say so instead
            // of returning a bare "Unknown tool".
            let Some(mcp) = &self.mcp else {
                return ToolOutput::err(format!("MCP gateway '{}' is unavailable: no MCP manager is attached", name));
            };
            let all_tools = mcp.all_tools().await;
            let builtin_names: HashSet<String> = self.tools.keys().cloned().collect();
            // The live permission snapshot plus gate reproduces the exact
            // visible set used by `definitions_async`.
            let visible = visible_mcp_tools(
                &all_tools,
                &builtin_names,
                &ctx.settings.permission,
                gate,
            );
            return match name {
                MCP_LIST_TOOL => {
                    let mut out = format!("{} MCP tools are visible:\n", visible.len());
                    for t in &visible {
                        out.push_str(&format!("- {}: {}\n", t.llm_name(), mcp_short_description(&t.description)));
                    }
                    ToolOutput::ok(out)
                }
                MCP_SEARCH_TOOL => {
                    let query = args["query"].as_str().unwrap_or("");
                    let limit = mcp_search_limit(args.get("limit"));
                    let hits = search_mcp_tools(&visible, query, limit);
                    let mut out = format!("{} match(es) for {:?}:\n", hits.len(), query);
                    for t in hits {
                        out.push_str(&format!("- {}: {}\n", t.llm_name(), mcp_short_description(&t.description)));
                    }
                    ToolOutput::ok(out)
                }
                MCP_DETAIL_TOOL => {
                    match mcp_tool_detail_json(&visible, args["name"].as_str().unwrap_or("")) {
                        Ok(schema) => ToolOutput::ok(schema),
                        Err(e) => ToolOutput::err(e),
                    }
                }
                MCP_CALL_TOOL => {
                    let target = args["name"].as_str().unwrap_or("");
                    match resolve_mcp_call_target(&visible, &all_tools, target) {
                        Ok(t) => {
                            let arguments = args.get("arguments").cloned()
                                .unwrap_or_else(|| serde_json::json!({}));
                            mcp_result_to_output(
                                mcp.call_tool(&t.server_name, &t.name, arguments).await,
                                &t.name,
                            )
                        }
                        Err(e) => e,
                    }
                }
                _ => unreachable!("gateway name was matched above"),
            };
        }

        // Route to MCP servers. The model calls the namespaced id
        // `mcp__server__tool`, but resolve by scanning discovered tools rather
        // than splitting the string (a server or tool name may itself contain
        // `__`, and sanitisation is lossy). Also accept the raw name as a
        // fallback so a tool name persisted in an older session's history — or a
        // provider that echoed the pre-namespace name — still resolves.
        if let Some(mcp) = &self.mcp {
            let tools = mcp.all_tools().await;
            let matched = tools
                .iter()
                .find(|t| t.enabled && t.llm_name() == name)
                .or_else(|| tools.iter().find(|t| t.enabled && t.name == name));
            if let Some(t) = matched {
                if let Some(gate) = &ctx.gate {
                    if !gate.allows(&t.name, true) {
                        return Self::gated_out(name);
                    }
                }
                // Definitions hide a globally blacklisted MCP tool; a model
                // that names its hidden `llm_name` anyway must be stopped here.
                // Use the shared disabled-tool message rather than a gate error
                // because `execute` had no permission check at this boundary.
                if ctx.settings.permission.disallowed_tools.iter().any(|d| d == &t.name) {
                    return mcp_disabled_output(name);
                }
                return mcp_result_to_output(
                    mcp.call_tool(&t.server_name, &t.name, args).await,
                    &t.name,
                );
            }
            // The name matches a discovered-but-disabled tool: distinguish "the
            // user turned this off" from "no such tool" so the model stops
            // instead of re-guessing a name that will never be available.
            let disabled = tools
                .iter()
                .any(|t| t.llm_name() == name || t.name == name);
            if disabled {
                return mcp_disabled_output(name);
            }
        }
        ToolOutput::err(format!("Unknown tool: {}", name))
    }

    /// Refusal text for a tool this run may not call.
    ///
    /// Phrased to end the attempt rather than invite a retry: the tool exists, the
    /// whitelist simply excludes it, and no re-phrasing of the arguments changes
    /// that. A model that keeps retrying burns the parent's turn budget.
    fn gated_out(name: &str) -> ToolOutput {
        ToolOutput::err(format!(
            "Tool '{}' is not available to this agent. Do not retry it; \
             accomplish the goal with the tools you do have, or report that \
             you cannot.",
            name
        ))
    }

    /// Get a tool by name.
    pub fn get(&self, name: &str) -> Option<&ToolSpec> {
        self.tools.get(name)
    }

    /// Build the default registry with all built-in tools.
    pub fn default_registry() -> Self {
        let mut reg = Self::new();
        reg.register(Arc::new(builtin::ReadTool));
        reg.register(Arc::new(builtin::WriteTool));
        reg.register(Arc::new(builtin::EditTool));
        reg.register(Arc::new(builtin::BashTool));
        reg.register(Arc::new(builtin::BashOutputTool));
        reg.register(Arc::new(builtin::GlobTool));
        reg.register(Arc::new(builtin::GrepTool));
        reg.register(Arc::new(builtin::LsTool));
        reg.register(Arc::new(builtin::TodoWriteTool));
        reg.register(Arc::new(builtin::TodoReadTool));
        reg.register(Arc::new(builtin::AskUserTool));
        reg.register(Arc::new(builtin::NowTool));
        reg.register(Arc::new(web::WebSearchTool));
        reg.register(Arc::new(web::WebFetchTool));
        reg.register(Arc::new(web::CodeSearchTool));
        reg.register(Arc::new(web::CrawlUrlTool));
        reg.register(Arc::new(super::code::CodeTool));
        reg.register(Arc::new(builtin::MemoryExtractTool));
        reg.register(Arc::new(builtin::MemorySearchTool));
        reg.register(Arc::new(builtin::MemoryRecallTool));
        reg.register(Arc::new(builtin::MemoryPruneTool));
        reg.register(Arc::new(builtin::MemoryConsolidateTool));
        reg.register(Arc::new(builtin::RecallHistoryTool));
        reg.register(Arc::new(builtin::SkillReadTool));
        reg.register(Arc::new(builtin::SkillRefreshTool));
        reg.register(Arc::new(builtin::SkillSearchTool));
        reg.register(Arc::new(builtin::AddModelTool));
        reg.register(Arc::new(agent::TaskTool));
        reg.register(Arc::new(agent::MultitaskTool));
        reg.register(Arc::new(agent::AwaitTasksTool));
        reg.register(Arc::new(agent::GenerateTool));
        reg
    }

    /// List of read-only tool names (for loop-detection fingerprinting).
    pub fn readonly_tools() -> &'static [&'static str] {
        &["read", "grep", "glob", "ls", "todoread", "now", "memory_search", "memory_recall", "recall_history", "skillsearch", "codesearch"]
    }
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self::default_registry()
    }
}

use super::agent;
use super::builtin;
use super::web;

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(session_dir: Option<PathBuf>, tool_call_id: &str) -> ToolContext {
        ToolContext {
            workspace: PathBuf::from("/kernel/workspace"),
            session_dir,
            session_id: "work-test".into(),
            tool_call_id: tool_call_id.into(),
            run_id: "run-test".into(),
            frame_tx: None,
            access_mode: "default".into(),
            cancel: CancellationToken::new(),
            hitl_approved: false,
            change_ledger: None,
            gate: None,
            subagent_depth: 0,
            root_session_id: "work-test".into(),
            thinking: None,
            // Irrelevant to these tests, which exercise path and gate logic. The
            // sub-agent inheritance that `model`/`settings` exist for is locked
            // by the guard tests in `tools/agent.rs`.
            model: Default::default(),
            settings: Default::default(),
            bash_exempt_dirs: Vec::new(),
        }
    }

    /// The actionId stamped on `hitl` / `question` frames must be the real
    /// tool_call_id. The frontend pairs `hitl_released` and
    /// `question_answered` against this value; the old hardcoded "pending"
    /// matched nothing, so a pending approval card could never be released by
    /// switching to full access.
    #[test]
    fn action_id_is_the_real_tool_call_id() {
        let c = ctx(None, "call_04c07f8419424bb8b4cb1acc");
        assert_eq!(c.action_id(), "call_04c07f8419424bb8b4cb1acc");
        assert_ne!(c.action_id(), "pending");
    }

    /// Callers with no tool call still get a non-empty id rather than an empty
    /// attribute the frontend would drop.
    #[test]
    fn action_id_falls_back_to_the_legacy_placeholder() {
        assert_eq!(ctx(None, "").action_id(), "pending");
    }

    /// TODO.md belongs in the session directory (Java `TodoTalent.getTodoPath`).
    /// Writing it to the shared workspace instead made every session's task list
    /// invisible to `/web/chat/todos`.
    #[test]
    fn todo_file_prefers_the_session_dir() {
        let c = ctx(Some(PathBuf::from("/sessions/root/work-abc")), "");
        assert_eq!(
            c.todo_file(),
            PathBuf::from("/sessions/root/work-abc").join(crate::session::TODO_FILE_NAME)
        );
    }

    /// CLI / ACP / sub-agents have no session storage and must keep working.
    #[test]
    fn todo_file_falls_back_to_the_workspace() {
        let c = ctx(None, "");
        assert_eq!(
            c.todo_file(),
            PathBuf::from("/kernel/workspace/.gwork").join(crate::session::TODO_FILE_NAME)
        );
    }

    #[test]
    fn approval_gate_follows_the_access_mode() {
        let mut c = ctx(None, "");
        assert!(c.approval_required(), "default mode must gate");
        c.access_mode = "full".into();
        assert!(!c.approval_required(), "full mode must not gate");
    }

    // ── ToolGate ──────────────────────────────────────────────────────────────

    fn gated(names: &[&str]) -> ToolGate {
        ToolGate {
            allowed: Some(names.iter().map(|s| s.to_string()).collect()),
            disallowed: std::collections::HashSet::new(),
            mcp_allowed: false,
        }
    }

    /// Same whitelist, wrapped for `ToolContext::gate`.
    fn gated_arc(names: &[&str]) -> Arc<ToolGate> {
        Arc::new(gated(names))
    }

    #[test]
    fn open_gate_allows_everything() {
        let g = ToolGate::open();
        assert!(g.allows("bash", false));
        assert!(g.allows("anything", false));
        assert!(g.allows("remote_tool", true), "open gate admits MCP tools");
    }

    #[test]
    fn whitelist_gate_admits_only_listed_names() {
        let g = gated(&["read", "grep"]);
        assert!(g.allows("read", false));
        assert!(g.allows("grep", false));
        assert!(!g.allows("write", false));
        assert!(!g.allows("bash", false));
        assert!(!g.allows("", false));
    }

    /// The blacklist must win over the whitelist. Java checks `disallowedTools`
    /// before adding a tool, at both the definition and the engine level; if the
    /// whitelist won here, an agent definition could re-grant a tool the operator
    /// had banned.
    #[test]
    fn disallowed_beats_allowed() {
        let g = ToolGate {
            allowed: Some(["read".to_string(), "bash".to_string()].into_iter().collect()),
            disallowed: ["bash".to_string()].into_iter().collect(),
            mcp_allowed: true,
        };
        assert!(g.allows("read", false));
        assert!(!g.allows("bash", false), "blacklist must override the whitelist");
    }

    /// MCP tools are gated by their own flag, not by the name whitelist: this
    /// kernel injects them flat into the registry and their names are
    /// server-defined, so no static whitelist could enumerate them.
    #[test]
    fn mcp_tools_follow_their_own_flag() {
        let mut g = gated(&["read"]);
        assert!(!g.allows("exa_search", true), "mcp_allowed defaults false in `gated`");
        g.mcp_allowed = true;
        assert!(g.allows("exa_search", true));
        // A blacklisted MCP name is still refused.
        g.disallowed.insert("exa_search".to_string());
        assert!(!g.allows("exa_search", true));
    }

    /// `from_permission` is what makes the user's `disallowedTools` an actual
    /// constraint. Before the gate existed, `is_allowed` had exactly one caller —
    /// the definitions builder — so a banned tool was hidden from the model but
    /// still executable if the model named it anyway.
    #[test]
    fn permission_gate_enforces_the_global_blacklist() {
        let mut p = PermissionSettings::default();
        assert!(ToolGate::from_permission(&p).allows("bash", false), "default allows all");
        p.disallowed_tools = vec!["bash".to_string()];
        let g = ToolGate::from_permission(&p);
        assert!(!g.allows("bash", false));
        assert!(g.allows("read", false), "only the banned tool is affected");
        assert!(g.allowed.is_none(), "the glob allowlist stays a definitions concern");
    }

    #[test]
    fn with_extra_disallowed_stacks() {
        let g = gated(&["read", "bash"]).with_extra_disallowed(["bash".to_string()]);
        assert!(g.allows("read", false));
        assert!(!g.allows("bash", false));
    }

    // ── Enforcement at the execute boundary ───────────────────────────────────
    //
    // These are the tests that matter. Filtering `definitions` only changes what
    // the model is *offered*; `execute` is what actually runs. A gate that did not
    // reach `execute` would be cosmetic — and sub-agents run with
    // `access_mode: "full"` and `hitl_approved: true`, so the whitelist is the only
    // thing standing between `explore` (which promises the model it cannot write)
    // and a write.

    #[tokio::test]
    async fn execute_refuses_a_tool_outside_the_gate() {
        let reg = ToolRegistry::default_registry();
        let mut c = ctx(None, "call-1");
        c.gate = Some(gated_arc(&["read"]));

        // `now` is registered and side-effect free, so a refusal can only come
        // from the gate — not from the tool failing.
        let out = reg.execute("now", serde_json::json!({}), &c).await;
        assert!(out.is_error, "a gated-out tool must not run");
        assert!(out.text.contains("not available to this agent"), "{}", out.text);
        assert!(
            out.text.contains("Do not retry"),
            "the message must stop the model retrying: {}",
            out.text
        );
    }

    #[tokio::test]
    async fn execute_runs_a_tool_inside_the_gate() {
        let reg = ToolRegistry::default_registry();
        let mut c = ctx(None, "call-1");
        c.gate = Some(gated_arc(&["now"]));

        let out = reg.execute("now", serde_json::json!({}), &c).await;
        assert!(!out.is_error, "an allowed tool must run: {}", out.text);
        assert!(!out.text.is_empty());
    }

    /// No gate = the pre-existing behaviour. Every caller that does not set one
    /// (and every test helper) must keep working exactly as before.
    #[tokio::test]
    async fn execute_is_ungated_when_no_gate_is_set() {
        let reg = ToolRegistry::default_registry();
        let c = ctx(None, "call-1");
        assert!(c.gate.is_none());
        let out = reg.execute("now", serde_json::json!({}), &c).await;
        assert!(!out.is_error, "ungated runs must not be restricted: {}", out.text);
    }

    /// The gate must be checked **before** dispatch, so a gated-out tool never
    /// reaches its implementation. Verified with a tool that would otherwise
    /// error for a different reason: the gate message must be the one returned.
    #[tokio::test]
    async fn gate_is_checked_before_dispatch() {
        let reg = ToolRegistry::default_registry();
        let mut c = ctx(None, "call-1");
        c.gate = Some(gated_arc(&["read"]));
        // `read` with no arguments would fail inside the tool; `write` is gated out.
        let out = reg.execute("write", serde_json::json!({}), &c).await;
        assert!(out.text.contains("not available to this agent"), "{}", out.text);
    }

    /// An unknown tool under a gate must still report "Unknown tool" rather than
    /// the gate message — otherwise a typo'd name would be misreported as a
    /// permission problem and the model would stop trying instead of correcting.
    #[tokio::test]
    async fn unknown_tool_is_not_misreported_as_gated() {
        let reg = ToolRegistry::default_registry();
        let mut c = ctx(None, "call-1");
        c.gate = Some(gated_arc(&["read"]));
        let out = reg.execute("no_such_tool", serde_json::json!({}), &c).await;
        assert!(out.is_error);
        assert!(out.text.contains("Unknown tool"), "{}", out.text);
    }

    // ── Definitions filtering ─────────────────────────────────────────────────

    #[test]
    fn definitions_respect_the_gate() {
        let reg = ToolRegistry::default_registry();
        let p = PermissionSettings::default();

        let all = reg.definitions(&p, None);
        assert!(all.iter().any(|d| d.function.name == "write"));

        let gated_defs = reg.definitions(&p, Some(&gated(&["read", "grep"])));        let names: Vec<&str> = gated_defs.iter().map(|d| d.function.name.as_str()).collect();
        assert_eq!(names, vec!["read", "grep"], "only whitelisted tools are offered");
    }

    /// Definitions and `execute` must agree. If they diverged, the model would be
    /// offered a tool that then refuses to run — a wasted turn on every call.
    #[test]
    fn definitions_and_execute_agree() {
        let reg = ToolRegistry::default_registry();
        let p = PermissionSettings::default();
        let g = gated(&["read", "now"]);
        let offered: Vec<String> = reg
            .definitions(&p, Some(&g))
            .iter()
            .map(|d| d.function.name.clone())
            .collect();
        for name in &offered {
            assert!(g.allows(name, false), "{} is offered but would be refused", name);
        }
        assert!(offered.contains(&"now".to_string()));
        assert!(!offered.contains(&"write".to_string()));
    }

    /// The user's `disallowedTools` must remove a tool from the definitions too,
    /// not merely from `execute`.
    #[test]
    fn definitions_respect_disallowed_tools() {
        let reg = ToolRegistry::default_registry();
        let mut p = PermissionSettings::default();
        p.disallowed_tools = vec!["bash".to_string()];
        let defs = reg.definitions(&p, None);
        assert!(!defs.iter().any(|d| d.function.name == "bash"));
        assert!(defs.iter().any(|d| d.function.name == "read"));
    }

    /// REGRESSION: a settings file with no `permission.tools` key (fresh
    /// workspace, partial save, old schema) must NOT blind the model. The
    /// Qoder/default semantics treat an empty allowlist as "all tools"; the
    /// old `any()` returned false for every tool, `tools` was omitted from the
    /// request, and the model could only answer with a pure-text intent
    /// declaration that the ReAct loop ended the run on.
    #[test]
    fn empty_allowlist_is_fail_open_not_blind() {
        let reg = ToolRegistry::default_registry();
        let mut p = PermissionSettings::default();
        p.tools = vec![];
        let defs = reg.definitions(&p, None);
        assert!(
            defs.len() > 10,
            "an empty allowlist must still offer the built-in toolset, got {}",
            defs.len()
        );
        // The skills summary explicitly tells the model to call `skillread`;
        // the skill tools must never be filtered away while that text is present.
        for skill_tool in ["skillread", "skillsearch", "skillrefresh"] {
            assert!(
                defs.iter().any(|d| d.function.name == skill_tool),
                "{skill_tool} must stay visible or the skills feature is a dead end"
            );
        }
        // An explicit non-empty allowlist is still honoured exactly.
        p.tools = vec!["read".to_string()];
        let narrowed = reg.definitions(&p, None);
        assert_eq!(narrowed.len(), 1);
        assert_eq!(narrowed[0].function.name, "read");
        // ...and `disallowedTools` still wins over the fail-open fallback.
        p.tools = vec![];
        p.disallowed_tools = vec!["bash".to_string()];
        let blocked = reg.definitions(&p, None);
        assert!(blocked.iter().any(|d| d.function.name == "read"));
        assert!(!blocked.iter().any(|d| d.function.name == "bash"));
    }

    /// The skills check must close the loop, not stop at visibility. `execute`
    /// never consulted `permission.tools` (only the `ToolGate` blacklist), so
    /// before the fix the skill tools were callable but invisible — the skills
    /// summary told the model to use `skillread` while no such definition was
    /// offered. After the fix both axes agree even with an empty allowlist.
    #[tokio::test]
    async fn empty_allowlist_keeps_skill_tools_both_visible_and_executable() {
        let reg = ToolRegistry::default_registry();
        let mut p = PermissionSettings::default();
        p.tools = vec![];
        let defs = reg.definitions(&p, None);
        let gate = crate::tools::ToolGate::from_permission(&p);
        let c = ctx(None, "call-1");
        for name in ["skillread", "skillsearch", "skillrefresh"] {
            assert!(defs.iter().any(|d| d.function.name == name), "{name} not offered");
            assert!(gate.allows(name, false), "{name} refused by the gate");
            let out = reg.execute(name, serde_json::json!({}), &c).await;
            assert!(
                !out.text.contains("not available to this agent") && !out.text.contains("Unknown tool"),
                "{name} was visible but not executable: {}",
                out.text
            );
        }
    }

    // ─── MCP four-stage folding ───────────────────────────────────────────
    fn fake_mcp_tools(n: usize) -> Vec<McpTool> {
        (0..n)
            .map(|i| McpTool {
                server_name: "srv".into(),
                name: format!("tool_{i:03}"),
                description: format!("Tool number {i} searches the frobnicator"),
                input_schema: serde_json::json!({"type":"object","properties":{"q":{"type":"string"}}}),
                enabled: true,
            })
            .collect()
    }

    #[test]
    fn fold_stage_threshold_boundaries() {
        assert_eq!(mcp_fold_stage(0), McpFoldStage::Full);
        assert_eq!(mcp_fold_stage(7), McpFoldStage::Full);
        assert_eq!(mcp_fold_stage(DYNAMIC_THRESHOLD), McpFoldStage::Summary);
        assert_eq!(mcp_fold_stage(LIST_THRESHOLD - 1), McpFoldStage::Summary);
        assert_eq!(mcp_fold_stage(LIST_THRESHOLD), McpFoldStage::List);
        assert_eq!(mcp_fold_stage(SEARCH_THRESHOLD - 1), McpFoldStage::List);
        assert_eq!(mcp_fold_stage(SEARCH_THRESHOLD), McpFoldStage::Search);
        assert_eq!(mcp_fold_stage(500), McpFoldStage::Search);
    }

    #[test]
    fn full_stage_keeps_every_schema_and_summary_shortens_only_description() {
        let tools = fake_mcp_tools(5);
        let perm = PermissionSettings::default();
        let defs = mcp_definitions_for_stage(McpFoldStage::Full, &tools, &perm, None);
        assert_eq!(defs.len(), 5);
        assert_eq!(defs[0].function.parameters, tools[0].input_schema);
        assert_eq!(defs[0].function.description, tools[0].description);

        let mut long = fake_mcp_tools(DYNAMIC_THRESHOLD);
        let schema = long[0].input_schema.clone();
        long[0].description = "甲".repeat(SUMMARY_DESCRIPTION_CHARS + 25) + "\nsecond line";
        let summary = mcp_definitions_for_stage(McpFoldStage::Summary, &long, &perm, None);
        assert_eq!(summary.len(), DYNAMIC_THRESHOLD, "SUMMARY still offers every tool");
        let clipped = &summary[0].function.description;
        assert_eq!(clipped.chars().count(), SUMMARY_DESCRIPTION_CHARS + 1);
        assert!(clipped.ends_with('…'));
        assert!(!clipped.contains("second line"));
        for d in &summary {
            assert_eq!(d.function.parameters, schema, "schema must stay callable");
            assert!(d.function.description.chars().count() <= SUMMARY_DESCRIPTION_CHARS + 1);
        }
        let gateway_names = [MCP_LIST_TOOL, MCP_SEARCH_TOOL, MCP_DETAIL_TOOL, MCP_CALL_TOOL];
        for stage in [McpFoldStage::Full, McpFoldStage::Summary] {
            let defs = mcp_definitions_for_stage(stage, &long, &perm, None);
            assert!(
                !defs.iter().any(|d| gateway_names.contains(&d.function.name.as_str())),
                "FULL/SUMMARY must not pollute small catalogues with gateway tools"
            );
        }
    }

    #[test]
    fn list_and_search_stages_expose_only_gateway_functions() {
        let tools = fake_mcp_tools(60);
        let perm = PermissionSettings::default();
        let list = mcp_definitions_for_stage(McpFoldStage::List, &tools, &perm, None);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].function.name, MCP_LIST_TOOL);
        assert!(list[0].function.description.contains("mcp__srv__tool_000"), "roster must name real tools");

        let many = fake_mcp_tools(120);
        let search = mcp_definitions_for_stage(McpFoldStage::Search, &many, &perm, None);
        assert_eq!(search.len(), 3);
        let names: Vec<&str> = search.iter().map(|d| d.function.name.as_str()).collect();
        assert!(names.contains(&MCP_SEARCH_TOOL));
        assert!(names.contains(&MCP_DETAIL_TOOL));
        assert!(names.contains(&MCP_CALL_TOOL));
        assert!(search[0].function.parameters["required"].as_array().unwrap().contains(&serde_json::json!("query")));
        assert_eq!(search[0].function.parameters["properties"]["query"]["type"], "string");
        assert_eq!(search[0].function.parameters["properties"]["limit"]["type"], "integer");
        assert!(search[1].function.parameters["required"].as_array().unwrap().contains(&serde_json::json!("name")));
        assert_eq!(search[1].function.parameters["properties"]["name"]["type"], "string");
        assert!(search[2].function.parameters["required"].as_array().unwrap().contains(&serde_json::json!("name")));
        assert!(search[2].function.parameters["required"].as_array().unwrap().contains(&serde_json::json!("arguments")));
        assert_eq!(search[2].function.parameters["properties"]["name"]["type"], "string");
        assert_eq!(search[2].function.parameters["properties"]["arguments"]["type"], "object");
        for d in &search {
            assert!(d.function.description.contains("search_tools"));
            assert!(d.function.description.contains("get_tool_detail"));
            assert!(d.function.description.contains("call_tool"));
        }
    }

    #[test]
    fn disabled_and_disallowed_tools_are_invisible_in_every_stage() {
        let mut tools = fake_mcp_tools(SEARCH_THRESHOLD + 20);
        tools[3].enabled = false;
        let mut p = PermissionSettings::default();
        p.disallowed_tools = vec!["tool_007".into()];
        let builtins: HashSet<String> = HashSet::new();
        let visible = visible_mcp_tools(&tools, &builtins, &p, None);
        assert_eq!(visible.len(), SEARCH_THRESHOLD + 18, "both filters must apply before stage selection");
        assert!(!visible.iter().any(|t| t.name == "tool_003"));
        assert!(!visible.iter().any(|t| t.name == "tool_007"));
        for stage in [
            McpFoldStage::Full,
            McpFoldStage::Summary,
            McpFoldStage::List,
            McpFoldStage::Search,
        ] {
            let defs = mcp_definitions_for_stage(stage, &visible, &p, None);
            let text = serde_json::to_string(&defs).unwrap();
            assert!(!text.contains("tool_003"), "disabled tool leaked into {stage:?}: {text}");
            assert!(!text.contains("tool_007"), "banned tool leaked into {stage:?}: {text}");
        }
    }

    /// Stage selection must consume the filtered visible count. Disabling or
    /// banning tools must not fold a small usable catalogue into LIST/SEARCH
    /// merely because `all_tools()` is large.
    #[test]
    fn fold_stage_uses_filtered_visible_count_not_discovered_total() {
        let mut discovered = fake_mcp_tools(LIST_THRESHOLD + 20);
        for t in discovered.iter_mut().skip(6) {
            t.enabled = false;
        }
        let builtins: HashSet<String> = HashSet::new();
        let perm = PermissionSettings::default();

        let visible = visible_mcp_tools(&discovered, &builtins, &perm, None);
        assert_eq!(visible.len(), 6);
        assert_eq!(mcp_fold_stage(discovered.len()), McpFoldStage::List);
        assert_eq!(mcp_fold_stage(visible.len()), McpFoldStage::Full);

        let gate = ToolGate { allowed: None, disallowed: HashSet::new(), mcp_allowed: false };
        assert_eq!(visible_mcp_tools(&discovered, &builtins, &perm, Some(&gate)).len(), 0);
        assert_eq!(mcp_fold_stage(0), McpFoldStage::Full);

        let mut selective_gate = ToolGate::open();
        selective_gate.disallowed.insert("tool_002".into());
        selective_gate.disallowed.insert("tool_003".into());
        let gated_visible = visible_mcp_tools(&discovered, &builtins, &perm, Some(&selective_gate));
        assert_eq!(gated_visible.len(), 4, "gate blacklist must be applied before counting");
        assert_eq!(mcp_fold_stage(gated_visible.len()), McpFoldStage::Full);

        let mut perm_with_ban = perm.clone();
        perm_with_ban.disallowed_tools = vec!["tool_000".into(), "tool_001".into()];
        let after_ban = visible_mcp_tools(&discovered, &builtins, &perm_with_ban, None);
        assert_eq!(after_ban.len(), 4);
        assert_eq!(mcp_fold_stage(after_ban.len()), McpFoldStage::Full);
        assert_eq!(mcp_definitions_for_stage(McpFoldStage::Full, &after_ban, &perm_with_ban, None).len(), 4);
    }

    #[test]
    fn search_is_case_insensitive_clamped_and_browseable() {
        let tools = fake_mcp_tools(30);
        let upper = search_mcp_tools(&tools, "FROBNICATOR", 5);
        assert_eq!(upper.len(), 5, "limit must clamp to at most 5");
        let lower = search_mcp_tools(&tools, "frobnicator", 5);
        assert_eq!(lower.len(), upper.len(), "search must be case-insensitive");
        assert!(lower.iter().any(|t| t.name == tools[0].name));
        let exact = search_mcp_tools(&tools, "tool_007", 10);
        assert_eq!(exact[0].name, "tool_007", "exact name match must rank first");
        assert_eq!(mcp_search_limit(Some(&serde_json::json!(0))), SEARCH_MIN_LIMIT);
        assert_eq!(mcp_search_limit(Some(&serde_json::json!(-7))), SEARCH_MIN_LIMIT);
        assert_eq!(mcp_search_limit(Some(&serde_json::json!(9999))), SEARCH_MAX_LIMIT);
        assert_eq!(mcp_search_limit(None), SEARCH_DEFAULT_LIMIT);
        let browse = search_mcp_tools(&tools, "", 3);
        assert_eq!(browse.len(), 3, "empty query is a bounded browse, not an error");
        assert_eq!(browse[0].name, tools[0].name);
        assert_eq!(browse[2].name, tools[2].name);
        assert_eq!(search_mcp_tools(&tools, "   ", 0).len(), SEARCH_MIN_LIMIT);
        assert!(search_mcp_tools(&tools, "no-such-keyword", 10).is_empty());
    }

    #[test]
    fn detail_resolves_and_rejects_unknown_names() {
        let tools = fake_mcp_tools(5);
        let schema = mcp_tool_detail_json(&tools, "mcp__srv__tool_002").unwrap();
        assert!(schema.contains("properties"));
        let err = mcp_tool_detail_json(&tools, "not-a-tool").unwrap_err();
        assert!(err.contains("search_tools"), "error must point back to the workflow: {}", err);
        assert!(resolve_mcp_tool(&tools, "").is_none());
        // Raw names resolve too, for older session histories.
        assert_eq!(resolve_mcp_tool(&tools, "tool_001").unwrap().name, "tool_001");
    }

    /// The mapping is shared by both direct MCP calls and `call_tool`; a
    /// server-side error must not lose its image blocks or become an empty success.
    #[test]
    fn mcp_result_mapping_preserves_is_error_images_and_transport_errors() {
        let ok = mcp_result_to_output(
            Ok::<McpCallResult, &str>(McpCallResult {
                text: "ok".into(),
                is_error: false,
                images: vec!["data:image/png;base64,ok".into()],
            }),
            "tool",
        );
        assert!(!ok.is_error);
        assert_eq!(ok.text, "ok");
        assert_eq!(ok.image_urls, vec!["data:image/png;base64,ok"]);

        let failed = mcp_result_to_output(
            Ok::<McpCallResult, &str>(McpCallResult {
                text: "".into(),
                is_error: true,
                images: vec!["data:image/png;base64,fail".into()],
            }),
            "tool_xyz",
        );
        assert!(failed.is_error);
        assert_eq!(failed.text, "MCP tool 'tool_xyz' failed");
        assert_eq!(failed.image_urls, vec!["data:image/png;base64,fail"]);

        let transport = mcp_result_to_output(
            Err::<McpCallResult, &str>("socket closed"),
            "tool",
        );
        assert!(transport.is_error);
        assert!(transport.text.contains("MCP tool error: socket closed"));
    }

    /// A discovered-but-disabled forward must reproduce the direct route's
    /// exact stop-retrying text; a genuinely unknown name points back to search.
    #[test]
    fn call_tool_target_distinguishes_disabled_from_unknown() {
        let mut all = fake_mcp_tools(3);
        all[1].enabled = false;
        let visible = visible_mcp_tools(&all, &HashSet::new(), &PermissionSettings::default(), None);
        let disabled = resolve_mcp_call_target(&visible, &all, "mcp__srv__tool_001").unwrap_err();
        assert!(disabled.is_error);
        assert_eq!(
            disabled.text,
            "MCP tool 'mcp__srv__tool_001' is disabled by the user's tool settings. Do not retry it."
        );
        let unknown = resolve_mcp_call_target(&visible, &all, "not-a-tool").unwrap_err();
        assert!(unknown.is_error);
        assert!(unknown.text.contains("search_tools"));
    }
}
