//! Tool registry — central catalog of available tools with permission filtering.
//!
//! Tools can request *suspension* (ask_user question / HITL approval). The ReAct
//! loop detects the suspension, persists a resume point, and halts. When the user
//! responds, the server resumes the run from that point.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::config::PermissionSettings;
use crate::llm::ToolDefinition;
use crate::mcp::McpManager;
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
        match &self.session_dir {
            Some(dir) => dir.join(crate::session::TODO_FILE_NAME),
            None => self.workspace.join(".gwork").join(crate::session::TODO_FILE_NAME),
        }
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
    /// gate (plus MCP tools, when the gate allows MCP).
    pub async fn definitions_async(
        &self,
        permission: &PermissionSettings,
        gate: Option<&ToolGate>,
    ) -> Vec<ToolDefinition> {
        let mut defs = self.definitions(permission, gate);
        let mcp_ok = gate.map(|g| g.mcp_allowed).unwrap_or(true);
        if mcp_ok {
            if let Some(mcp) = &self.mcp {
                for t in mcp.all_tools().await {
                    // An MCP tool name can also collide with a built-in name, and
                    // a gate naming that built-in should not silently admit the
                    // remote one. Built-ins already covered above are skipped.
                    if self.tools.contains_key(&t.name) {
                        continue;
                    }
                    if gate.map(|g| g.allows(&t.name, true)).unwrap_or(true) {
                        defs.push(ToolDefinition::new(&t.name, &t.description, t.input_schema.clone()));
                    }
                }
            }
        }
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

        // Route to MCP servers.
        if let Some(mcp) = &self.mcp {
            for t in mcp.all_tools().await {
                if t.name == name {
                    if let Some(gate) = &ctx.gate {
                        if !gate.allows(name, true) {
                            return Self::gated_out(name);
                        }
                    }
                    return match mcp.call_tool(&t.server_name, &t.name, args).await {
                        Ok(text) => ToolOutput::ok(text),
                        Err(e) => ToolOutput::err(format!("MCP tool error: {}", e)),
                    };
                }
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
}
