//! team — Multi-agent team orchestration.
//!
//! Supports spawning sub-agents (background tasks) that run concurrently.
//! Mirrors the Java kernel's TaskTalent: main agent delegates tasks to
//! specialized sub-agents via `task` and `multitask` tools.
//!
//! # What "specialized" means here
//!
//! Each sub-agent runs under an [`AgentDefinition`](crate::agents::AgentDefinition):
//! its own role prompt, its own tool whitelist and optionally its own model.
//! Before this, `agent_name` was folded into one sentence
//! (`"You are a specialized sub-agent named 'X'"`) and every sub-agent got the
//! full registry, so `explore` and `bash` were the same agent wearing different
//! labels — and `explore`, whose description promises the model it has no write
//! access, in fact had it.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;
use tracing::info;

use crate::agents::{AgentDefinition, AgentManager};
use crate::config::{ModelConfig, Settings};
use crate::llm::{ChatMessage, UsageInfo};
use crate::protocol::Frame;
use crate::react::{ReActAgent, ReActConfig};
use crate::tools::{ToolGate, ToolRegistry};

/// How deep nested delegation may go.
///
/// A deliberate deviation from Java, which places no limit. `general` declares
/// `tools: ["*"]`, which includes `task`, so a sub-agent can delegate — and each
/// level is a full ReAct loop with its own turn budget. Unbounded depth turns one
/// pathological prompt into exponential fan-out that no cancellation token can
/// unwind fast enough. Four levels is far more than any real orchestration needs
/// (orchestrator → specialist → its own researcher → …) and converts a resource
/// hazard into a clear, reportable error.
pub const MAX_SUBAGENT_DEPTH: u32 = 4;

/// A sub-agent task definition.
#[derive(Debug, Clone)]
pub struct SubAgentTask {
    pub id: String,
    pub agent_name: String,
    pub description: String,
    pub prompt: String,
    pub background: bool,
    /// Nesting level of the run that delegated this task. 0 = the main agent.
    pub depth: u32,
}

/// What a delegated run inherits from the run that delegated it.
///
/// Bundled rather than passed as separate parameters because the set keeps
/// growing: session id (for frame attribution), cancellation (so Stop reaches the
/// child) and reasoning level (Java `TaskTalent.resolveThinkingDepth`). Each one
/// is "context of the parent", and a ninth positional parameter would make the
/// call sites in `tools/agent.rs` unreadable and easy to transpose.
#[derive(Debug, Clone)]
pub struct ParentRun {
    /// The **real** session the user is looking at — never a `sub-*` id.
    pub session_id: String,
    /// Parent's cancellation token; the sub-agent runs on a child of it.
    pub cancel: CancellationToken,
    /// Reasoning level in effect for the conversation.
    pub thinking: Option<String>,
}

/// Result from a sub-agent execution.
#[derive(Debug, Clone)]
pub struct SubAgentResult {
    pub task_id: String,
    pub success: bool,
    pub output: String,
    pub usage: UsageInfo,
}

/// Team orchestrator managing sub-agent lifecycle.
pub struct TeamOrchestrator {
    registry: Arc<ToolRegistry>,
    results: Arc<Mutex<HashMap<String, SubAgentResult>>>,
}

/// Which model a sub-agent runs on: its own if the definition names one,
/// otherwise the model of the run that delegated it.
///
/// This is the line that implements inheritance, so it is a free function with
/// its own tests rather than a `match` buried in `execute_task` — that method
/// needs a live provider to reach, which is why the rule went untested long
/// enough for its *callers* to start feeding it a global default (see
/// [`crate::tools::registry::ToolContext::model`]). Mutation testing confirmed
/// the gap: replacing `None => session_model` with a `defaultModel` lookup
/// reproduced the reported defect in full while every test stayed green.
///
/// A named-but-missing model is an `Err`, never a silent fall back to the
/// session model: the user configured a specific model for this agent, and
/// quietly substituting another is the same class of defect one level down.
/// The error carries just the offending name so the caller owns the wording.
fn resolve_subagent_model(
    def: &AgentDefinition,
    settings: &Settings,
    session_model: ModelConfig,
) -> Result<ModelConfig, String> {
    match &def.model {
        Some(name) => match settings.get_model(name) {
            Some(m) => Ok(m.clone()),
            None => Err(name.clone()),
        },
        None => Ok(session_model),
    }
}

impl TeamOrchestrator {
    pub fn new(registry: Arc<ToolRegistry>) -> Self {
        Self {
            registry,
            results: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Execute a sub-agent task synchronously.
    ///
    /// See [`ParentRun`] for what the sub-agent inherits. It runs on a **child**
    /// cancellation token, so stopping the parent session also stops its
    /// sub-agents.
    ///
    /// `session_model` is the model the delegating run is using. A definition may
    /// override it via its `model` key; otherwise the sub-agent inherits this one
    /// (Java `AgentFactory.create`: `isEmpty(getModel()) ? sessionModel : getModel()`).
    pub async fn execute_task(
        &self,
        task: SubAgentTask,
        session_model: ModelConfig,
        settings: Settings,
        workspace: std::path::PathBuf,
        frame_tx: mpsc::UnboundedSender<Frame>,
        parent: ParentRun,
    ) -> SubAgentResult {
        info!(task_id = %task.id, agent = %task.agent_name, depth = task.depth, "spawning sub-agent");

        // ── Resolve the definition first ─────────────────────────────────────
        //
        // An unknown name must come back as a readable tool *result*, not as an
        // error and not as a run that starts with no role. Java's comment on the
        // same branch records the trap: an exception thrown here gets classified
        // upstream as a parameter-schema error, so the model keeps "fixing" its
        // arguments instead of renaming the agent — an infinite correction loop
        // that burns the parent's turn budget.
        if task.depth >= MAX_SUBAGENT_DEPTH {
            return self.finish(
                &task,
                SubAgentResult {
                    task_id: task.id.clone(),
                    success: false,
                    output: format!(
                        "ERROR: 子代理嵌套层级已达上限（{} 层），无法继续委派。请自行完成该子任务。",
                        MAX_SUBAGENT_DEPTH
                    ),
                    usage: UsageInfo::default(),
                },
            ).await;
        }

        let manager = AgentManager::load(Some(&workspace));
        let Some(def) = manager.get(&task.agent_name).map(|d| d.clone()) else {
            return self.finish(
                &task,
                SubAgentResult {
                    task_id: task.id.clone(),
                    success: false,
                    output: manager.unknown_agent_message(&task.agent_name),
                    usage: UsageInfo::default(),
                },
            ).await;
        };

        // ── Model isolation ──────────────────────────────────────────────────
        let model = match resolve_subagent_model(&def, &settings, session_model) {
            Ok(m) => m,
            Err(missing) => {
                return self
                    .finish(
                        &task,
                        SubAgentResult {
                            task_id: task.id.clone(),
                            success: false,
                            output: format!(
                                "ERROR: 子代理 '{}' 指定的模型 '{}' 不存在或未启用，请检查代理定义或模型设置。",
                                def.name, missing
                            ),
                            usage: UsageInfo::default(),
                        },
                    )
                    .await;
            }
        };

        // ── Tool whitelist ───────────────────────────────────────────────────
        //
        // The definition's whitelist, intersected with the user's global
        // `disallowedTools`. The global list must win: it is the operator's
        // setting, and an agent definition file living in a project directory
        // should not be able to re-grant a tool the user banned.
        let gate: Arc<ToolGate> = Arc::new(
            def.tool_gate()
                .with_extra_disallowed(settings.permission.disallowed_tools.iter().cloned()),
        );

        let run_id = format!("sub-{}", task.id);
        // Read before `settings` is moved into the struct literal below.
        //
        // The budget is the user's own `maxTurns`, not a hardcoded number: it used
        // to be 15, which silently capped delegated work below what the operator
        // had configured (Java passes `engine.getMaxTurns()` through for the same
        // reason). AutoRethink still applies on top of it inside the loop.
        let max_turns = settings.general.max_turns;
        let next_depth = task.depth + 1;
        let config = ReActConfig {
            session_id: format!("sub-{}", task.id),
            workspace,
            // Sub-agents get synthetic `sub-*` ids that are not real sessions and
            // have no storage directory. They must not write into the parent
            // session's directory either: a sub-agent's scratch checklist would
            // otherwise overwrite the orchestrator's own TODO.md.
            session_dir: None,
            model,
            settings,
            access_mode: "full".into(),
            max_turns,
            run_id: run_id.clone(),
            start_seq: 0,
            hitl_approved: true, // sub-agents run without approval gates
            gate: Some(gate),
            change_ledger: None, // sub-agents don't capture file changes
            // Sub-agents have no session storage and no meter of their own:
            // their context_size frames are not forwarded to the parent UI
            // (Java TaskTalent forwards only a subset), so the ledger fields
            // stay empty and the denominator unknown.
            context_length: 0,
            turn_start_ms: chrono::Utc::now().timestamp_millis(),
            usage_seed: crate::session_usage::SessionUsageSum::default(),
            // Sub-agents have no `/compact` entry point.
            force_compact: false,
            compact_focus: None,
            subagent_depth: next_depth,
            // The real conversation stays the root even at depth ≥ 2, so a nested
            // sub-agent's frames are attributed to the session the user sees.
            root_session_id: parent.session_id.clone(),
            // Inherit the conversation's reasoning level: the user picked it for
            // this task, and a sub-agent doing part of that task should think at
            // the same depth rather than silently dropping to the provider default.
            thinking: parent.thinking.clone(),
        };

        let agent = ReActAgent::new(self.registry.clone());
        // The role prompt is used **verbatim** — no wrapper sentence concatenated
        // around it. Java does the same (`builder.systemPrompt(r -> getSystemPrompt())`).
        //
        // Note what is deliberately *not* appended: the main agent's system prompt
        // gets the skills roster and the memory preview bolted on, but a sub-agent
        // gets neither. It is scoped to one delegated task, and `skillread` is in
        // the whitelist of the agents that need skills, so the roster would be
        // duplicated context the sub-agent did not ask for.
        let history = vec![
            ChatMessage::system(def.system_prompt.clone()),
            ChatMessage::user(&task.prompt),
        ];

        // Emit agent_start frame.
        //
        // `invocation_id` is the task id: unique per delegation, so two parallel
        // sub-agents with the same name and description still get separate cards.
        // The frontend keys its card map on it (`resolveAgentState`).
        let invocation_id = task.id.clone();
        let _ = frame_tx.send(Frame::agent_start(
            &parent.session_id,
            &def.name,
            &task.description,
            &invocation_id,
            task.background,
        ));

        // Derive a child token from the parent run so that a Stop on the parent
        // session propagates here.
        //
        // This used to be a fresh `CancellationToken::new()` that nothing ever
        // cancelled. The consequence was not merely wasted tokens: sub-agents run
        // with `access_mode: "full"` and `hitl_approved: true` (no approval gate),
        // so an unstoppable sub-agent kept executing writes and bash commands
        // after the user had explicitly asked the task to stop — and a
        // `background: true` sub-agent outlives the delegating tool call entirely,
        // so there was no other handle left to interrupt it with.
        let cancel = parent.cancel.child_token();
        if cancel.is_cancelled() {
            // Parent already stopped before we got going: report it rather than
            // starting a run that would be cancelled on its first turn check.
            let _ = frame_tx.send(Frame::agent_end(
                &parent.session_id,
                &def.name,
                &task.description,
                &invocation_id,
                false,
                "cancelled before start",
                task.background,
            ));
            return self.finish(
                &task,
                SubAgentResult {
                    task_id: task.id.clone(),
                    success: false,
                    output: "Cancelled before start.".to_string(),
                    usage: UsageInfo::default(),
                },
            ).await;
        }

        // The sub-agent runs on its own channel so its frames can be re-stamped
        // and filtered before they reach the user's session. Handing it `frame_tx`
        // directly would put frames carrying `sessionId: "sub-<id>"` on the wire,
        // and the frontend resolves which conversation to render into from that
        // field (`getOrCreateSession(chunk.sessionId)`) — so every card would land
        // in a phantom session that is never displayed.
        let (sub_tx, sub_rx) = mpsc::unbounded_channel::<Frame>();
        let fwd_tx = frame_tx.clone();
        let fwd_session = parent.session_id.clone();
        let fwd_agent = def.name.clone();
        let fwd_desc = task.description.clone();
        let fwd_invocation = invocation_id.clone();
        let fwd_background = task.background;
        let forwarder = tokio::spawn(forward_subagent_frames(
            sub_rx,
            fwd_tx,
            fwd_session,
            fwd_agent,
            fwd_desc,
            fwd_invocation,
            fwd_background,
        ));

        let result = agent.run(&config, history, sub_tx, cancel).await;
        // Dropping `sub_tx` above closed the channel, so the forwarder drains and
        // exits on its own; awaiting it keeps the last frames from racing the
        // `agent_end` we are about to send.
        let _ = forwarder.await;

        // `interrupted()` is "stopped for any reason other than Completed", which
        // covers cancellation, max-turns and unrecoverable errors alike. All three
        // must report failure: Java's `resultOk` exists precisely because reporting
        // a max-turns apology as `success=true` let the parent fold "I could not
        // finish" into its own summary as though it were a finding (three failed
        // sub-agents all reported success in the incident that added that check).
        let success = !result.interrupted();
        let output = result.final_answer.clone();

        // Emit agent_end frame
        let summary: String = output.chars().take(500).collect();
        let _ = frame_tx.send(Frame::agent_end(
            &parent.session_id,
            &def.name,
            &task.description,
            &invocation_id,
            success,
            &summary,
            task.background,
        ));

        self.finish(
            &task,
            SubAgentResult {
                task_id: task.id.clone(),
                success,
                output,
                usage: result.usage,
            },
        ).await
    }

    /// Record a result and return it. Single exit point so every early return
    /// above is also retrievable by `get_result` / `await_tasks`.
    async fn finish(&self, task: &SubAgentTask, result: SubAgentResult) -> SubAgentResult {
        self.results.lock().await.insert(task.id.clone(), result.clone());
        result
    }

    /// Get a completed task result.
    pub async fn get_result(&self, task_id: &str) -> Option<SubAgentResult> {
        self.results.lock().await.get(task_id).cloned()
    }
}

/// Resolve an agent definition without running it — used by the tool layer to
/// validate `agent_name` before spawning anything.
pub fn resolve_definition(workspace: &std::path::Path, name: &str) -> Option<AgentDefinition> {
    AgentManager::load(Some(workspace)).get(name).cloned()
}

/// Relay a sub-agent's frames into the user's session, re-stamped and filtered.
///
/// # Why re-stamping is load-bearing
///
/// A sub-agent runs with `session_id = "sub-<task_id>"`, and every frame it emits
/// carries that id. The frontend decides *which conversation to render into* from
/// `chunk.sessionId` (`applySequencedGateChunk(gateSess || getOrCreateSession(
/// chunk.sessionId), chunk)`), so frames stamped with a synthetic id create a
/// phantom session: the card is built, appended to a container that is never
/// displayed, and the user sees nothing at all. Java avoids this by emitting
/// through `emitToClient(sessionId, …)` with the **parent's** id.
///
/// Persistence has the same requirement: the parent's forwarding loop writes every
/// frame it receives into the parent's `.stream.ndjson`, so a `sub-*` id would also
/// make replay reconstruct the frames into a session that does not exist.
///
/// # Why filtering is load-bearing
///
/// A sub-agent's run-level frames describe *its* run, not the user's. Forwarding
/// them corrupts the parent's state machine:
///
/// - `done` — the frontend leaves streaming state on `done` for the active run.
///   A sub-agent finishing would end the **parent's** stream mid-answer, drop the
///   stop button and freeze the thinking bubble.
/// - `context_size` / `trace` — would overwrite the parent's context meter and
///   usage rows with the sub-agent's numbers.
/// - `error` / `retry` — would render a red error block or a "model call failed,
///   retrying" notice in the main conversation, attributed to nobody. The
///   sub-agent's failure is already reported through `agent_end`'s `success` flag
///   and result summary.
/// - `reason_start` — a phase signal that would reset the parent's thinking block.
/// - `hitl` / `question` — sub-agents run with `hitl_approved: true` and have no
///   session storage, so a suspension card could never be answered or resumed.
///
/// # Foreground vs background
///
/// Foreground sub-agents forward their content in full, so their reasoning and tool
/// cards nest inside the agent card (the frontend resolves the owning card from
/// `args.invocationId`).
///
/// Background ones forward **only** `agent_progress` heartbeats. Java's
/// `ofAgentProgress` documents the reason: a background task may run for many
/// minutes, and forwarding full deltas would make frame volume and history size
/// grow with every tool call it makes. A heartbeat carrying just the current tool
/// name is enough to distinguish "working" from "hung" — which is the entire
/// problem the frame exists to solve.
pub async fn forward_subagent_frames(
    mut rx: mpsc::UnboundedReceiver<Frame>,
    tx: mpsc::UnboundedSender<Frame>,
    parent_session: String,
    agent_name: String,
    description: String,
    invocation_id: String,
    background: bool,
) {
    while let Some(mut frame) = rx.recv().await {
        let kind = frame.frame_type.as_str();

        // Run-level frames: never forwarded (see the function docs).
        if matches!(
            kind,
            "done"
                | "done_suspended"
                | "error"
                | "retry"
                | "trace"
                | "context_size"
                | "reason_start"
                | "hitl"
                | "hitl_released"
                | "question"
                | "question_answered"
                | "user_input"
                | "steer_applied"
                | "steer_dropped"
                | "steer_cancelled"
                | "file_changes"
        ) {
            continue;
        }

        // A nested delegation (this sub-agent delegating further) already carries
        // its own agent identity in `args`; only the session id needs fixing.
        let is_nested_agent_frame =
            matches!(kind, "agent_start" | "agent_end" | "agent_progress");

        if background && !is_nested_agent_frame {
            // Background: collapse everything except tool starts into a heartbeat.
            if kind != "action_start" {
                continue;
            }
            let tool_name = frame.tool_name.clone().unwrap_or_default();
            let mut hb = Frame::agent_progress(
                &parent_session,
                &agent_name,
                &description,
                &invocation_id,
                &tool_name,
            );
            // Preserve the parent run id so the frontend's run-scoped batch keys
            // and its "is this frame for the active run" checks still line up.
            hb.run_id = frame.run_id.clone();
            let _ = tx.send(hb);
            continue;
        }

        // Foreground content frames: re-stamp the session and attribute them to
        // this agent's card.
        frame.session_id = Some(parent_session.clone());
        if !is_nested_agent_frame {
            stamp_agent_attribution(
                &mut frame,
                &agent_name,
                &description,
                &invocation_id,
                background,
            );
        }
        let _ = tx.send(frame);
    }
}

/// Inject the agent identity into a frame's `args`, which is what the frontend
/// reads to decide whether the frame belongs inside an agent card
/// (`resolveAgentState`: `invocationId || agentName + ':' + description`).
///
/// Without this, a forwarded `text` frame would render into the **main**
/// conversation bubble instead of the sub-agent's card — the sub-agent's answer
/// appearing as though the main agent had said it.
fn stamp_agent_attribution(
    frame: &mut Frame,
    agent_name: &str,
    description: &str,
    invocation_id: &str,
    background: bool,
) {
    let args = frame
        .extra
        .as_object_mut()
        .map(|m| m.entry("args").or_insert_with(|| serde_json::json!({})))
        .and_then(|v| v.as_object_mut());
    let Some(args) = args else { return };
    // Do not clobber an existing `args` payload (tool arguments live there);
    // only add the attribution keys, and never overwrite a key already present.
    args.entry("agentName")
        .or_insert_with(|| serde_json::json!(agent_name));
    args.entry("description")
        .or_insert_with(|| serde_json::json!(description));
    args.entry("invocationId")
        .or_insert_with(|| serde_json::json!(invocation_id));
    if background {
        args.entry("background").or_insert_with(|| serde_json::json!(true));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The orchestrator must reject an unknown agent name with the readable
    /// roster message rather than starting a role-less run. Verified through the
    /// manager because `execute_task` needs a live model to reach the LLM.
    #[test]
    fn unknown_agent_name_yields_the_roster_message() {
        let m = AgentManager::builtin();
        assert!(!m.has("code-reviewer"));
        let msg = m.unknown_agent_message("code-reviewer");
        assert!(msg.starts_with("ERROR"), "{}", msg);
        assert!(msg.contains("explore"), "{}", msg);
    }

    /// A known name resolves to a definition carrying a real prompt and gate.
    #[test]
    fn resolve_definition_finds_builtins() {
        let ws = std::env::temp_dir().join(format!("gwork-team-{}", std::process::id()));
        std::fs::create_dir_all(&ws).unwrap();
        let d = resolve_definition(&ws, "explore").expect("explore must resolve");
        assert!(!d.system_prompt.is_empty());
        assert!(!d.tool_gate().allows("write", false));
        std::fs::remove_dir_all(&ws).ok();
    }

    /// Depth cap must be a positive, small number: 0 would block all delegation,
    /// and a large one would not bound anything.
    #[test]
    fn depth_cap_is_small_and_positive() {
        assert!(MAX_SUBAGENT_DEPTH > 0);
        assert!(MAX_SUBAGENT_DEPTH <= 8, "{} is not a bound", MAX_SUBAGENT_DEPTH);
    }

    /// Build a definition, optionally naming its own model.
    fn def_with_model(model: Option<&str>) -> AgentDefinition {
        let front = match model {
            Some(m) => format!("model: {}\n", m),
            None => String::new(),
        };
        AgentDefinition::from_markdown(
            &format!("---\nname: w\ndescription: d\n{}tools: [\"read\"]\n---\nbody", front),
            "w",
            crate::agents::AgentScope::Global,
        )
    }

    /// Settings whose `defaultModel` is deliberately **not** the session model,
    /// so these tests can tell the two sources apart. Without this the
    /// assertions would hold for the buggy code too.
    fn settings_with_default(default_model: &str, also: &[&str]) -> Settings {
        let mut s = Settings::default();
        s.default_model = default_model.to_string();
        for n in std::iter::once(&default_model).chain(also.iter()) {
            s.models.insert(
                n.to_string(),
                ModelConfig { name: n.to_string(), enabled: true, ..Default::default() },
            );
        }
        s
    }

    fn session_model(name: &str) -> ModelConfig {
        ModelConfig { name: name.to_string(), enabled: true, ..Default::default() }
    }

    /// The reported defect, at the line that decides it.
    ///
    /// A definition naming no model must inherit the **delegating run's**
    /// model. Reaching for `settings.defaultModel` here is what made a
    /// sub-agent answer on the global default after the user had picked
    /// something else in the conversation.
    #[test]
    fn a_definition_without_a_model_inherits_the_delegating_runs_model() {
        let settings = settings_with_default("cheap-fallback", &["picked-by-user"]);
        let resolved = resolve_subagent_model(
            &def_with_model(None),
            &settings,
            session_model("picked-by-user"),
        );
        assert_eq!(resolved.as_ref().map(|m| m.name.as_str()), Ok("picked-by-user"));
        assert_ne!(
            resolved.unwrap().name,
            settings.default_model,
            "falling back to settings.defaultModel is the bug being guarded"
        );
    }

    /// A definition naming its own model keeps it: the point of the `model`
    /// key is to let one agent run somewhere cheaper than the conversation.
    #[test]
    fn a_definition_with_its_own_model_overrides_the_inherited_one() {
        let settings = settings_with_default("cheap-fallback", &["bulk-cheap", "picked-by-user"]);
        let resolved = resolve_subagent_model(
            &def_with_model(Some("bulk-cheap")),
            &settings,
            session_model("picked-by-user"),
        );
        assert_eq!(resolved.map(|m| m.name), Ok("bulk-cheap".to_string()));
    }

    /// A named model that does not exist must fail loudly. Falling back to the
    /// session model would hand the user a different model than the one they
    /// configured for this agent, with nothing on screen to say so.
    #[test]
    fn a_named_model_that_is_missing_fails_instead_of_substituting_another() {
        let settings = settings_with_default("cheap-fallback", &["picked-by-user"]);
        let resolved = resolve_subagent_model(
            &def_with_model(Some("typo-model")),
            &settings,
            session_model("picked-by-user"),
        );
        assert_eq!(resolved.err().as_deref(), Some("typo-model"));
    }

    /// The gate given to a sub-agent must fold in the user's global
    /// `disallowedTools`: an agent definition living in a project directory may
    /// not re-grant a tool the operator banned.
    #[test]
    fn global_disallowed_tools_win_over_the_definition() {
        let d = AgentManager::builtin().get("general").unwrap().clone();
        assert!(d.tool_gate().allows("bash", false), "general normally has bash");
        let gated = d.tool_gate().with_extra_disallowed(["bash".to_string()]);
        assert!(!gated.allows("bash", false), "operator ban must override the definition");
        assert!(gated.allows("read", false), "other tools unaffected");
    }

    // ── Frame forwarding ──────────────────────────────────────────────────────
    //
    // These cover the reason sub-agent cards were invisible: frames carried
    // `sessionId: "sub-<task_id>"`, and the frontend picks which conversation to
    // render into from that field. Every assertion below is about what actually
    // reaches the parent's channel.

    /// Run the forwarder to completion and collect what it emitted.
    async fn forward(frames: Vec<Frame>, background: bool) -> Vec<Frame> {
        let (sub_tx, sub_rx) = mpsc::unbounded_channel::<Frame>();
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Frame>();
        for f in frames {
            sub_tx.send(f).unwrap();
        }
        drop(sub_tx); // closes the channel so the forwarder exits
        let h = tokio::spawn(forward_subagent_frames(
            sub_rx,
            out_tx,
            "work-parent".into(),
            "explore".into(),
            "find things".into(),
            "task-abc".into(),
            background,
        ));
        h.await.unwrap();
        let mut out = Vec::new();
        while let Ok(f) = out_rx.try_recv() {
            out.push(f);
        }
        out
    }

    /// A foreground sub-agent's content must arrive stamped with the **parent**
    /// session id. This is the fix for invisible cards: with `sub-*` on the wire
    /// the frontend builds the card in a session container that is never shown.
    #[tokio::test]
    async fn foreground_frames_are_restamped_to_the_parent_session() {
        let out = forward(
            vec![Frame::text_delta("sub-task-abc", "hello")],
            false,
        )
        .await;
        assert_eq!(out.len(), 1);
        assert_eq!(
            out[0].session_id.as_deref(),
            Some("work-parent"),
            "must be re-stamped, not left as sub-*"
        );
        assert_eq!(out[0].text.as_deref(), Some("hello"), "content must survive");
    }

    /// Forwarded content must carry the agent attribution, or the frontend renders
    /// it into the **main** conversation bubble — the sub-agent's answer appearing
    /// as though the main agent had said it.
    #[tokio::test]
    async fn foreground_frames_carry_agent_attribution() {
        let out = forward(vec![Frame::text_delta("sub-x", "body")], false).await;
        let args = &out[0].extra["args"];
        assert_eq!(args["agentName"], "explore");
        assert_eq!(args["invocationId"], "task-abc");
        assert_eq!(args["description"], "find things");
        assert!(
            args.get("background").is_none(),
            "a foreground frame must not claim to be background: {}",
            args
        );
    }

    /// Tool arguments live in `args` too. Attribution must be **additive** —
    /// overwriting `args` would destroy the arguments the tool card renders.
    #[tokio::test]
    async fn attribution_does_not_clobber_tool_arguments() {
        let f = Frame::action_start("sub-x", "read", "call-1", serde_json::json!({
            "file_path": "src/main.rs"
        }));
        let out = forward(vec![f], false).await;
        let args = &out[0].extra["args"];
        assert_eq!(args["file_path"], "src/main.rs", "tool args must survive");
        assert_eq!(args["agentName"], "explore", "attribution must be added");
    }

    /// A sub-agent's `done` must never reach the parent. The frontend leaves
    /// streaming state on `done` for the active run, so forwarding one would end
    /// the **parent's** stream mid-answer and freeze its thinking bubble.
    #[tokio::test]
    async fn run_level_frames_are_never_forwarded() {
        let out = forward(
            vec![
                Frame::done("sub-x"),
                Frame::error("sub-x", "boom"),
                Frame::context_size("sub-x", &crate::protocol::ContextSizePayload::default()),
                Frame::retry("sub-x", 1, 3, "slow"),
                Frame::reason_start("sub-x", 0),
                Frame::text_delta("sub-x", "kept"),
            ],
            false,
        )
        .await;
        let kinds: Vec<&str> = out.iter().map(|f| f.frame_type.as_str()).collect();
        assert_eq!(kinds, vec!["text"], "only content survives: {:?}", kinds);
    }

    /// Suspension frames must not be forwarded: a sub-agent runs with
    /// `hitl_approved: true` and has no session storage, so a card it raised could
    /// never be answered or resumed — it would hang the parent forever.
    #[tokio::test]
    async fn suspension_frames_are_never_forwarded() {
        let out = forward(
            vec![
                Frame::hitl("sub-x", "bash", "rm -rf /", "call-1"),
                Frame::question("sub-x", "call-2", serde_json::json!({})),
                Frame::done_suspended("sub-x"),
            ],
            false,
        )
        .await;
        assert!(out.is_empty(), "nothing may be forwarded: {:?}", out.iter().map(|f| &f.frame_type).collect::<Vec<_>>());
    }

    /// Background sub-agents forward **only** heartbeats. Java's `ofAgentProgress`
    /// documents why: a background task may run for many minutes, and forwarding
    /// full deltas makes frame volume and history size grow with every tool call.
    #[tokio::test]
    async fn background_collapses_content_into_heartbeats() {
        let out = forward(
            vec![
                Frame::action_start("sub-x", "grep", "call-1", serde_json::json!({})),
                Frame::text_delta("sub-x", "a long answer that must not be forwarded"),
                Frame::reason("sub-x", "thinking"),
                Frame::action_start("sub-x", "read", "call-2", serde_json::json!({})),
            ],
            true,
        )
        .await;
        let kinds: Vec<&str> = out.iter().map(|f| f.frame_type.as_str()).collect();
        assert_eq!(
            kinds,
            vec!["agent_progress", "agent_progress"],
            "one heartbeat per tool start, no content: {:?}",
            kinds
        );
        let tools: Vec<&str> = out
            .iter()
            .map(|f| f.extra["args"]["toolName"].as_str().unwrap())
            .collect();
        assert_eq!(tools, vec!["grep", "read"], "heartbeat must name the current tool");
    }

    /// The heartbeat must carry the parent session and the invocation id, or the
    /// frontend cannot find the card to update.
    #[tokio::test]
    async fn background_heartbeat_is_attributed_to_the_parent_card() {
        let out = forward(
            vec![Frame::action_start("sub-x", "bash", "call-1", serde_json::json!({}))],
            true,
        )
        .await;
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].session_id.as_deref(), Some("work-parent"));
        assert_eq!(out[0].extra["args"]["invocationId"], "task-abc");
        assert_eq!(out[0].extra["args"]["background"], true);
        // No phase: a background frame can land in the idle window after the
        // parent's `done`, and a phase would rewrite the main conversation's
        // indicator text.
        assert!(out[0].phase.is_none(), "heartbeat must not carry a phase");
    }

    /// A nested delegation's own lifecycle frames must pass through with their
    /// identity intact — re-stamping `agentName` would mislabel the inner card as
    /// the outer agent.
    #[tokio::test]
    async fn nested_agent_frames_keep_their_own_identity() {
        let inner = Frame::agent_start("sub-inner", "bash", "inner task", "task-inner", true);
        let out = forward(vec![inner], true).await;
        assert_eq!(out.len(), 1, "nested lifecycle frames are forwarded even in background");
        assert_eq!(out[0].session_id.as_deref(), Some("work-parent"), "session still re-stamped");
        assert_eq!(out[0].extra["args"]["agentName"], "bash", "inner identity preserved");
        assert_eq!(out[0].extra["args"]["invocationId"], "task-inner");
    }

    /// The run id must survive on a heartbeat: the frontend's batch keys are
    /// run-scoped, and losing it would break grouping.
    #[tokio::test]
    async fn heartbeat_preserves_the_run_id() {
        let f = Frame::action_start("sub-x", "ls", "call-1", serde_json::json!({}))
            .run("run-parent-1");
        let out = forward(vec![f], true).await;
        assert_eq!(out[0].run_id.as_deref(), Some("run-parent-1"));
    }

    /// An empty stream must produce nothing rather than hanging.
    #[tokio::test]
    async fn empty_stream_forwards_nothing() {
        assert!(forward(vec![], false).await.is_empty());
        assert!(forward(vec![], true).await.is_empty());
    }
}
