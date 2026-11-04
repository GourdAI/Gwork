//! Sub-agent tools: task, multitask, await_tasks.
//!
//! These tools let the main agent delegate work to specialized sub-agents.
//! Background tasks return a token immediately; results are collected via
//! await_tasks. Foreground tasks block until completion.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use once_cell::sync::Lazy;
use serde_json::json;
use tokio::sync::{mpsc, Mutex};

use super::registry::{Tool, ToolContext, ToolOutput};
use crate::config::Settings;
use crate::protocol::Frame;
use crate::team::{SubAgentTask, TeamOrchestrator};
use crate::tools::ToolRegistry;

/// Global background task registry: token → completed result text.
static BG_RESULTS: Lazy<Mutex<HashMap<String, String>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Global team orchestrator (lazily initialized with the default registry).
static ORCHESTRATOR: Lazy<Arc<TeamOrchestrator>> = Lazy::new(|| {
    Arc::new(TeamOrchestrator::new(Arc::new(ToolRegistry::default_registry())))
});

/// What a sub-agent runs on: the delegating run's own model and settings.
///
/// This replaces a `resolve_model()` that read `Settings::default_model_config()`
/// and a `Settings::load_default().unwrap_or_default()` beside it. Both ignored
/// the parent run entirely, so delegating from a conversation using model X
/// produced a sub-agent on the *global default* instead — the "sub-agent used the
/// default model, not the one I selected" defect. See [`ToolContext::model`] for
/// the full account, including the identical bug Java already fixed and warned
/// about on `TaskTalent.resolveModelOverride`.
///
/// The inheritance rule itself lives in
/// [`crate::team::resolve_subagent_model`] — a definition may name its own
/// model, otherwise it takes the delegating run's. This helper's only job is to
/// hand that function the parent's values rather than re-derived ones; feeding
/// it a global default was the whole defect, since the rule downstream was
/// already correct.
fn inherited_model_and_settings(ctx: &ToolContext) -> (crate::config::ModelConfig, Settings) {
    ((*ctx.model).clone(), (*ctx.settings).clone())
}

/// What a delegated sub-agent inherits from the run that delegated it.
///
/// Every spawn site needs the same three values, and getting one wrong is silent:
/// passing `ctx.session_id` instead of `ctx.root_session_id` would stamp frames
/// with a `sub-*` id, and the frontend — which picks the conversation to render
/// into from `chunk.sessionId` — would build the card in a session that is never
/// displayed. One helper means one place to get it right.
fn parent_run(ctx: &ToolContext) -> crate::team::ParentRun {
    crate::team::ParentRun {
        session_id: ctx.root_session_id.clone(),
        cancel: ctx.cancel.clone(),
        thinking: ctx.thinking.clone(),
    }
}

// ─── task ─────────────────────────────────────────────────────────────────────

pub struct TaskTool;

#[async_trait]
impl Tool for TaskTool {
    fn name(&self) -> &str { "task" }
    fn description(&self) -> &str {
        "Delegate a single task to a specialized sub-agent. For long tasks set background=true \
         to get a token immediately; collect results later with await_tasks."
    }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "agent_name": {"type": "string", "description": "Sub-agent name (e.g. 'general', 'explore', 'bash')"},
                "prompt": {"type": "string", "description": "Detailed instructions for the sub-agent"},
                "description": {"type": "string", "description": "Short label for the task"},
                "background": {"type": "boolean", "description": "Run in background (default false)"}
            },
            "required": ["agent_name", "prompt", "description"]
        })
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolOutput {
        let agent_name = args["agent_name"].as_str().unwrap_or("general");
        let prompt = args["prompt"].as_str().unwrap_or_default();
        let description = args["description"].as_str().unwrap_or_default();
        let background = args["background"].as_bool().unwrap_or(false);

        if prompt.is_empty() {
            return ToolOutput::err("prompt is required");
        }

        let (model, settings) = inherited_model_and_settings(ctx);
        let task_id = uuid::Uuid::new_v4().to_string()[..8].to_string();

        // Validate the agent name before spawning anything. Without this the
        // failure surfaces only after a full sub-agent run has been stood up, and
        // a `background: true` task would burn a spawn to report an unknown name.
        if crate::team::resolve_definition(&ctx.workspace, agent_name).is_none() {
            return ToolOutput::ok(
                crate::agents::AgentManager::load(Some(&ctx.workspace))
                    .unknown_agent_message(agent_name),
            );
        }

        let task = SubAgentTask {
            id: task_id.clone(),
            agent_name: agent_name.to_string(),
            description: description.to_string(),
            prompt: prompt.to_string(),
            background,
            depth: ctx.subagent_depth,
        };

        if background {
            // Spawn in background, return token immediately
            let orch = ORCHESTRATOR.clone();
            let ws = ctx.workspace.clone();
            let frame_tx = ctx.frame_tx.clone();
            let token = format!("task-{}", task_id);
            let token_clone = token.clone();
            // P3: register as running before the spawn (the task can finish
            // inside the yield window; a post-hoc register would leave a
            // phantom entry keeping the owner's gate armed forever).
            crate::react::bg_gate::register_running(&ctx.session_id, &token).await;
            // A background sub-agent outlives this tool call, so everything it
            // inherits must be owned by the spawned task: Stop on the parent
            // session still has to reach it, and its frames still have to be
            // stamped with the real conversation id.
            let parent = parent_run(ctx);
            let notice_ctx = (
                ctx.session_id.clone(),
                agent_name.to_string(),
                description.to_string(),
            );

            tokio::spawn(async move {
                let (tx, _rx) = mpsc::unbounded_channel::<Frame>();
                // Use the provided frame_tx if available, else a dummy
                let sender = frame_tx.unwrap_or(tx);
                let result = orch
                    .execute_task(task, model, settings, ws, sender, parent)
                    .await;
                let output = if result.success {
                    result.output
                } else {
                    format!("ERROR: sub-agent failed: {}", result.output)
                };
                BG_RESULTS.lock().await.insert(token_clone.clone(), output.clone());
                // P3: completion notice + gate release. The summary is capped:
                // the notice is re-sent with the history every turn.
                let (owner, name, desc) = notice_ctx;
                let summary: String = output.chars().take(600).collect();
                let notice = crate::react::bg_gate::render_subagent_notice(
                    &token_clone, None, &name, &desc, result.success, &summary,
                );
                crate::react::bg_gate::publish(&owner, notice).await;
                crate::react::bg_gate::unregister_running(&token_clone).await;
            });

            ToolOutput::ok(format!(
                "<task_submitted background=\"true\">\n<token>{}</token>\n<description>{}</description>\n\
                 You will receive a notification when it completes, or use await_tasks to collect.\n</task_submitted>",
                token, description
            ))
        } else {
            // Foreground: block until done.
            //
            // The delegation runs on its **own task**, not inline in this future, so
            // abandoning *this* future cannot abandon the sub-agent. That distinction
            // is what makes an immediate Stop compatible with an honest sub-agent card:
            //
            //   - `react` races cancellation against the whole tool call, so a Stop
            //     during a tool abandons this future at once rather than waiting for
            //     the tool's own timeout (8 s measured, and 7.8 s of it was this call).
            //   - The sub-agent inherits the parent token via `child_token()`, so it
            //     sees the cancellation within milliseconds, exits its loop and still
            //     emits its own `agent_end` carrying `success=false` plus a summary.
            //
            // Awaiting `execute_task` inline instead lets that abort land *inside the
            // parent's* future: the sub-agent's run is cut off before it can report
            // itself, so `agent_end` never fires. Two consequences, both real:
            //   1. the work it was doing is discarded without ever being recorded;
            //   2. the card's cleanup sweep (`app-streaming.js:1112`, which turns a
            //      leftover `.agent-status-icon.loading` into **`done`**) then marks the
            //      interrupted sub-agent with a green success tick — the UI *lies* about
            //      a stopped task, with no result summary to contradict it. Same class of
            //      defect as reporting a max-turns apology as `success=true`.
            //
            // Dropping a `JoinHandle` does **not** cancel the task (tokio detaches it),
            // which is precisely the behaviour wanted here — and is why `multitask`,
            // which already spawns, needed no change.
            //
            // The frame sender is moved in, so sub-agent frames keep flowing to the UI
            // after this tool call returns.
            let (tx, _rx) = mpsc::unbounded_channel::<Frame>();
            let sender = ctx.frame_tx.clone().unwrap_or(tx);
            let orch = ORCHESTRATOR.clone();
            let ws = ctx.workspace.clone();
            let parent = parent_run(ctx);
            let handle = tokio::spawn(async move {
                orch.execute_task(task, model, settings, ws, sender, parent).await
            });
            let result = tokio::select! {
                biased;
                r = handle => match r {
                    Ok(res) => res,
                    // A panicked sub-agent reports failure the same way the batch form
                    // does, rather than taking the run down with it.
                    Err(e) => return ToolOutput::ok(format!(
                        "<task_result>\n<result_status>failure</result_status>\n\
                         ERROR: sub-agent task panicked: {e}\n</task_result>"
                    )),
                },
                _ = ctx.cancel.cancelled() => {
                    // Return now; the spawned sub-agent is left running and will
                    // settle itself (see above). No result to report — the run is over.
                    return ToolOutput::err("Cancelled by user");
                }
            };
            let status = if result.success { "success" } else { "failure" };
            ToolOutput::ok(format!(
                "<task_result>\n<result_status>{}</result_status>\n{}\n</task_result>",
                status, result.output
            ))
        }
    }
}

// ─── multitask ────────────────────────────────────────────────────────────────

pub struct MultitaskTool;

#[async_trait]
impl Tool for MultitaskTool {
    fn name(&self) -> &str { "multitask" }
    fn description(&self) -> &str {
        "Execute multiple independent sub-agent tasks in parallel. Tasks must not depend on each other."
    }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "tasks": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "index": {"type": "integer"},
                            "agent_name": {"type": "string"},
                            "prompt": {"type": "string"},
                            "description": {"type": "string"},
                            "background": {"type": "boolean"}
                        },
                        "required": ["index", "agent_name", "prompt", "description"]
                    }
                }
            },
            "required": ["tasks"]
        })
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolOutput {
        let tasks = args["tasks"].as_array().cloned().unwrap_or_default();
        if tasks.is_empty() {
            return ToolOutput::err("tasks array is empty");
        }

        let (model, settings) = inherited_model_and_settings(ctx);

        let mut bg_tokens: Vec<(usize, String, String)> = Vec::new(); // (index, token, description)
        // Foreground tasks run **concurrently**: the tool's own description says
        // "in parallel", and the whole point of multitask over calling `task`
        // repeatedly is to overlap independent sub-agents. The previous code
        // awaited each one inside the loop, so N tasks took the sum of their
        // durations instead of the max — serial execution wearing a parallel
        // tool's name.
        //
        // Each spawned task carries its `index` so results can be re-sorted into
        // submission order afterwards: concurrent completion must not reorder the
        // response, which the model reads positionally.
        let mut fg_handles: Vec<tokio::task::JoinHandle<(usize, String, String)>> = Vec::new();

        for t in &tasks {
            let index = t["index"].as_u64().unwrap_or(0) as usize;
            let agent_name = t["agent_name"].as_str().unwrap_or("general");
            let prompt = t["prompt"].as_str().unwrap_or_default();
            let description = t["description"].as_str().unwrap_or_default();
            let background = t["background"].as_bool().unwrap_or(false);

            let task_id = uuid::Uuid::new_v4().to_string()[..8].to_string();
            let task = SubAgentTask {
                id: task_id.clone(),
                agent_name: agent_name.to_string(),
                description: description.to_string(),
                prompt: prompt.to_string(),
                background,
                depth: ctx.subagent_depth,
            };

            if background {
                let orch = ORCHESTRATOR.clone();
                let ws = ctx.workspace.clone();
                let frame_tx = ctx.frame_tx.clone();
                let token = format!("task-{}", task_id);
                let token_clone = token.clone();
                let m = model.clone();
                let s = settings.clone();
                let parent = parent_run(ctx);
                // P3: register before spawn (same ordering rule as `task`).
                crate::react::bg_gate::register_running(&ctx.session_id, &token).await;
                let notice_ctx = (
                    ctx.session_id.clone(),
                    agent_name.to_string(),
                    description.to_string(),
                    index,
                );

                tokio::spawn(async move {
                    let (tx, _rx) = mpsc::unbounded_channel::<Frame>();
                    let sender = frame_tx.unwrap_or(tx);
                    let result = orch
                        .execute_task(task, m, s, ws, sender, parent)
                        .await;
                    let output = if result.success {
                        result.output
                    } else {
                        format!("ERROR: sub-agent failed: {}", result.output)
                    };
                    BG_RESULTS.lock().await.insert(token_clone.clone(), output.clone());
                    // P3: notice + gate release (same pairing as `task`).
                    let (owner, name, desc, idx) = notice_ctx;
                    let summary: String = output.chars().take(600).collect();
                    let notice = crate::react::bg_gate::render_subagent_notice(
                        &token_clone, Some(idx), &name, &desc, result.success, &summary,
                    );
                    crate::react::bg_gate::publish(&owner, notice).await;
                    crate::react::bg_gate::unregister_running(&token_clone).await;
                });
                bg_tokens.push((index, token, description.to_string()));
            } else {
                let orch = ORCHESTRATOR.clone();
                let ws = ctx.workspace.clone();
                let frame_tx = ctx.frame_tx.clone();
                let m = model.clone();
                let s = settings.clone();
                let parent = parent_run(ctx);
                let desc = description.to_string();

                fg_handles.push(tokio::spawn(async move {
                    let (tx, _rx) = mpsc::unbounded_channel::<Frame>();
                    let sender = frame_tx.unwrap_or(tx);
                    let result = orch
                        .execute_task(task, m, s, ws, sender, parent)
                        .await;
                    (index, desc, result.output)
                }));
            }
        }

        // Await all foreground tasks, then restore submission order. A panicked
        // sub-agent becomes an error result rather than failing the whole batch.
        let mut results: Vec<(usize, String, String)> = Vec::with_capacity(fg_handles.len());
        for handle in fg_handles {
            match handle.await {
                Ok(triple) => results.push(triple),
                Err(e) => results.push((usize::MAX, String::new(), format!("ERROR: sub-agent task panicked: {}", e))),
            }
        }
        results.sort_by_key(|(index, _, _)| *index);

        // Build response
        let mut out = String::new();
        if !results.is_empty() {
            out.push_str("<multitask_results>\n");
            for (index, desc, output) in &results {
                out.push_str(&format!(
                    "<result index=\"{}\" description=\"{}\">\n{}\n</result>\n",
                    index, desc, output
                ));
            }
            out.push_str("</multitask_results>");
        }
        if !bg_tokens.is_empty() {
            out.push_str("\n<multitask_background>\n");
            for (index, token, desc) in &bg_tokens {
                out.push_str(&format!(
                    "<submitted index=\"{}\"><token>{}</token><description>{}</description></submitted>\n",
                    index, token, desc
                ));
            }
            out.push_str("</multitask_background>");
        }
        ToolOutput::ok(out)
    }
}

// ─── await_tasks ──────────────────────────────────────────────────────────────

pub struct AwaitTasksTool;

#[async_trait]
impl Tool for AwaitTasksTool {
    fn name(&self) -> &str { "await_tasks" }
    fn description(&self) -> &str {
        "Wait for background sub-agent tasks to complete and return their results. \
         Pass the tokens returned by task/multitask with background=true."
    }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "tokens": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "List of background task tokens to wait for"
                },
                "timeout_seconds": {"type": "integer", "description": "Max wait (default 300)"}
            },
            "required": ["tokens"]
        })
    }
    async fn execute(&self, args: serde_json::Value, _ctx: &ToolContext) -> ToolOutput {
        let tokens: Vec<String> = args["tokens"]
            .as_array()
            .map(|arr| arr.iter().filter_map(|t| t.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let timeout_secs = args["timeout_seconds"].as_u64().unwrap_or(300);

        if tokens.is_empty() {
            return ToolOutput::err("tokens array is empty");
        }

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
        let mut out = String::from("<await_results>\n");

        for token in &tokens {
            // Poll for completion
            let mut result: Option<String> = None;
            loop {
                {
                    let results = BG_RESULTS.lock().await;
                    if let Some(r) = results.get(token) {
                        result = Some(r.clone());
                        break;
                    }
                }
                if tokio::time::Instant::now() > deadline {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            match result {
                Some(r) => {
                    // Remove from registry after collection
                    BG_RESULTS.lock().await.remove(token);
                    out.push_str(&format!("<result token=\"{}\" status=\"completed\">\n{}\n</result>\n", token, r));
                }
                None => {
                    out.push_str(&format!(
                        "<result token=\"{}\" status=\"timeout\">Task did not complete within {}s</result>\n",
                        token, timeout_secs
                    ));
                }
            }
        }
        out.push_str("</await_results>");
        ToolOutput::ok(out)
    }
}

// ─── generate ───────────────────────────────────────────────────────────

pub struct GenerateTool;

/// Win32 reserved device names. Writing `NUL.md` is silently discarded yet still
/// reports success, and `COM1.md` can block — and this product ships a Windows
/// desktop client. Mirrors Java `GenerateTalent.WIN_RESERVED_NAME`.
fn is_win_reserved_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    matches!(
        n.as_str(),
        "con" | "prn" | "aux" | "nul"
            | "com1" | "com2" | "com3" | "com4" | "com5" | "com6" | "com7" | "com8" | "com9"
            | "lpt1" | "lpt2" | "lpt3" | "lpt4" | "lpt5" | "lpt6" | "lpt7" | "lpt8" | "lpt9"
    )
}

/// Quote a scalar for the YAML front matter so `agents::split_front_matter` +
/// `unquote` read it back verbatim. Escapes `\` and `"`; newlines are folded to
/// spaces because a front-matter value must stay on one line.
fn front_matter_quote(raw: &str) -> String {
    let flat: String = raw
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    let escaped = flat.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{}\"", escaped)
}

/// Render an agent definition as a markdown file with YAML front matter, in the
/// exact shape `agents::from_markdown` parses (see `definitions/explore.md`).
///
/// `tools` is written as a JSON array — `parse_tool_list` has a dedicated
/// `serde_json::from_str` branch for that, so the value round-trips without
/// depending on quoting rules. `skills` is written for cross-kernel file
/// compatibility (the Java `AgentDefinition` carries it); this kernel's loader
/// does not currently consume it, so it is data-at-rest rather than behaviour.
fn render_agent_markdown(
    name: &str,
    description: &str,
    system_prompt: &str,
    tools: &[String],
    skills: &[String],
) -> String {
    let tools_json = serde_json::to_string(tools).unwrap_or_else(|_| "[]".to_string());
    let mut fm = String::from("---\n");
    fm.push_str(&format!("name: {}\n", front_matter_quote(name)));
    fm.push_str(&format!("description: {}\n", front_matter_quote(description)));
    fm.push_str(&format!("tools: {}\n", tools_json));
    if !skills.is_empty() {
        let skills_json = serde_json::to_string(skills).unwrap_or_else(|_| "[]".to_string());
        fm.push_str(&format!("skills: {}\n", skills_json));
    }
    fm.push_str("---\n\n");
    let body = system_prompt.trim();
    if body.is_empty() {
        fm.push_str(&format!("You are the `{}` sub-agent.\n", name));
    } else {
        fm.push_str(body);
        fm.push('\n');
    }
    fm
}

#[async_trait]
impl Tool for GenerateTool {
    fn name(&self) -> &str { "generate" }
    fn description(&self) -> &str {
        "动态构建一个具备特定专家知识和工具权限的子代理。用于将复杂大任务拆解给垂直领域的'虚拟专家'执行。\n- 只有当'当前可用代理列表'中无匹配项时，才允许调用此工具。\n- 创建前应查阅相关知识库和技能，以确保 systemPrompt 的专业性。"
    }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "子代理的唯一英文标识符（如 code_reviewer）"},
                "description": {"type": "string", "description": "对该代理职能的精炼描述，便于主代理后续识别和调用"},
                "systemPrompt": {"type": "string", "description": "核心指令集。需包含角色身份、技能范畴、输出格式规范及负面约束（避免废话）"},
                "tools": {"type": "array", "items": {"type": "string"}, "description": "赋予子代理的工具权限（严禁全选，仅勾选任务相关项）。从给定列表中选择：read/write/edit/glob/grep/list/bash/skill/code/todo/webfetch/websearch/codesearch/pi/task/*"},
                "skills": {"type": "array", "items": {"type": "string"}, "description": "子代理具备的特定专家能力标识列表"},
                "saveToFile": {"type": "boolean", "description": "是否持久化为可跨项目复用的全局代理。true=全局（~/.gwork/agents，所有项目可见）；false=项目局部（<workspace>/.gwork/agents）。默认 false。"}
            },
            "required": ["name", "description", "systemPrompt"]
        })
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolOutput {
        // Normalize: the on-disk key and the in-memory name must correspond 1:1.
        // Windows/NTFS is case-insensitive, so letting `General` and `general`
        // coexist would make a later save silently overwrite the other's file.
        let name = args["name"].as_str().unwrap_or_default().trim().to_ascii_lowercase();
        if name.is_empty() {
            return ToolOutput::err("ERROR: name 不能为空。");
        }
        if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') || name.len() > 64 {
            return ToolOutput::err(
                "ERROR: name 标识符不合法，仅允许英文字符、数字、下划线或中划线，且长度不超过 64。",
            );
        }
        if is_win_reserved_name(&name) {
            return ToolOutput::err("ERROR: name 使用了系统保留名称，请改用其它标识符。");
        }

        let description = args["description"].as_str().unwrap_or_default().trim().to_string();
        let system_prompt = args["systemPrompt"].as_str().unwrap_or_default().to_string();

        let tools: Vec<String> = args["tools"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        // An agent with no tools can do nothing; Java rejects this too
        // (`AgentFactory` gates the whole tool-assembly block on a non-empty list).
        if tools.is_empty() {
            return ToolOutput::err(
                "ERROR: 必须至少指定一个工具（tools），否则子代理没有任何执行能力。",
            );
        }
        let skills: Vec<String> = args["skills"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();

        // Never overwrite an existing agent (built-in, or one scanned from either
        // agents dir). A new definition would otherwise replace the target's tool
        // whitelist with a model-authored one — privilege erasure and identity
        // hijack in one step.
        if crate::team::resolve_definition(&ctx.workspace, &name).is_some() {
            return ToolOutput::err(format!(
                "ERROR: 子代理 '{}' 已存在，不可覆盖，请改用其它标识符。",
                name
            ));
        }

        // This kernel has no in-memory agent registry: `AgentManager::load`
        // rescans the agents directories on every delegation. So "registering" an
        // agent *is* writing its file — there is no memory-only mode. `saveToFile`
        // therefore selects the scope, not whether it persists:
        //   true  → global  (~/.gwork/agents)         reusable across projects
        //   false → workspace (<ws>/.gwork/agents)    this project only
        let save_global = args["saveToFile"].as_bool().unwrap_or(false);
        let dir = if save_global {
            crate::config::Settings::gwork_home().join("agents")
        } else {
            ctx.workspace.join(".gwork").join("agents")
        };
        let path = dir.join(format!("{}.md", name));

        let markdown = render_agent_markdown(&name, &description, &system_prompt, &tools, &skills);
        if let Err(e) = std::fs::create_dir_all(&dir) {
            return ToolOutput::err(format!(
                "ERROR: 创建子代理失败（无法创建目录），详情见服务端日志。{}",
                e
            ));
        }
        if let Err(e) = std::fs::write(&path, &markdown) {
            return ToolOutput::err(format!(
                "ERROR: 创建子代理失败（无法写入定义文件），详情见服务端日志。{}",
                e
            ));
        }

        let scope_label = if save_global { "全局" } else { "项目局部" };
        ToolOutput::ok(format!(
            "[OK] 子代理创建成功（{}作用域）！\n\n**标识**: {}\n**描述**: {}\n\n现在可以使用 `task(agent_name=\"{}\", description=\"...\", prompt=\"...\")` 来调用。",
            scope_label, name, description, name
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ModelConfig;

    /// A context whose model is **not** the one `settings.defaultModel` names.
    ///
    /// The fixture has to discriminate between the two sources, otherwise these
    /// tests pass no matter which one the code reads. `assert_fixture_discriminates`
    /// below proves it does.
    fn ctx_with(model_name: &str, default_model_name: &str) -> ToolContext {
        let mut settings = Settings::default();
        settings.default_model = default_model_name.to_string();
        for n in [model_name, default_model_name] {
            settings.models.insert(
                n.to_string(),
                ModelConfig { name: n.to_string(), ..Default::default() },
            );
        }
        ToolContext {
            workspace: std::path::PathBuf::from("/kernel/workspace"),
            session_dir: None,
            session_id: "work-parent".into(),
            tool_call_id: "call-1".into(),
            run_id: "run-1".into(),
            frame_tx: None,
            access_mode: "default".into(),
            cancel: tokio_util::sync::CancellationToken::new(),
            hitl_approved: false,
            change_ledger: None,
            gate: None,
            subagent_depth: 0,
            root_session_id: "work-parent".into(),
            thinking: None,
            model: Arc::new(ModelConfig {
                name: model_name.to_string(),
                ..Default::default()
            }),
            settings: Arc::new(settings),
            bash_exempt_dirs: Vec::new(),
        }
    }

    /// Guards the fixture itself: the global-default path must resolve to a
    /// *different* model than the parent run's, or the assertions below would
    /// hold for the buggy code too.
    #[test]
    fn assert_fixture_discriminates() {
        let ctx = ctx_with("picked-by-user", "cheap-fallback");
        let global_default = ctx.settings.default_model_config().cloned();
        assert_eq!(
            global_default.map(|m| m.name).as_deref(),
            Some("cheap-fallback"),
            "fixture must expose a global default distinct from the run's model"
        );
    }

    /// The reported defect, stated as an assertion.
    ///
    /// A conversation running on `picked-by-user` delegated to a sub-agent and the
    /// sub-agent answered on `cheap-fallback`, because the old `resolve_model()`
    /// read `settings.default_model_config()` and never looked at the parent run.
    #[test]
    fn inherited_model_is_the_parent_runs_selection_not_the_global_default() {
        let ctx = ctx_with("picked-by-user", "cheap-fallback");
        let (model, _) = inherited_model_and_settings(&ctx);
        assert_eq!(
            model.name, "picked-by-user",
            "a sub-agent must run on the model the conversation selected"
        );
        assert_ne!(
            model.name, ctx.settings.default_model,
            "falling back to settings.defaultModel is the bug being fixed"
        );
    }

    /// Settings must be the run's own snapshot, not a fresh disk read.
    ///
    /// The old code called `Settings::load_default().unwrap_or_default()`. A disk
    /// re-read is a different point in time than the snapshot the parent is
    /// executing against, and when the file cannot be read at all it degrades to
    /// an empty model registry — so every delegation reported "no model
    /// configured" while the parent kept running. See
    /// [`ToolContext::settings`] for the full account.
    ///
    /// The distinctive value is derived from the real default rather than
    /// hardcoded, so the test cannot silently become vacuous if that default
    /// changes to match it.
    #[test]
    fn inherited_settings_are_the_parents_live_copy_not_a_disk_reload() {
        let baseline = Settings::default().general.max_turns;
        let distinctive = baseline.wrapping_add(13);
        let mut ctx = ctx_with("picked-by-user", "cheap-fallback");
        let mut live = (*ctx.settings).clone();
        live.general.max_turns = distinctive;
        ctx.settings = Arc::new(live);

        let (_, settings) = inherited_model_and_settings(&ctx);
        assert_eq!(
            settings.general.max_turns, distinctive,
            "sub-agents must see the parent run's settings, not a re-read of disk"
        );
        assert_ne!(distinctive, baseline, "fixture must differ from the default");
    }

    /// This file's production source: everything before the test module, with
    /// comment lines dropped.
    ///
    /// Both filters are load-bearing. Without the `#[cfg(test)]` cut the
    /// assertions below would match their own needles; without the comment filter
    /// they would match the doc comment that records the old behaviour by name.
    ///
    /// `include_str!` rather than a runtime path: it resolves at compile time
    /// relative to this file, so the guard cannot degrade into a silent pass
    /// because a path was computed wrong under a different working directory.
    fn production_src() -> String {
        const SRC: &str = include_str!("agent.rs");
        let cut = SRC.find("#[cfg(test)]").unwrap_or(SRC.len());
        SRC[..cut]
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Delegation must have exactly one source of model and settings: the parent
    /// run. Reaching for a global default anywhere in this file reintroduces the
    /// defect, and it is invisible at runtime — the delegation still succeeds, it
    /// is merely answered by the wrong model.
    #[test]
    fn delegation_never_reaches_for_a_global_default() {
        let src = production_src();
        for needle in ["default_model_config", "load_default"] {
            assert!(
                !src.contains(needle),
                "`{needle}` is back in tools/agent.rs: sub-agents would silently \
                 run on the global default instead of the conversation's model"
            );
        }
    }

    /// Both spawn sites must go through the one helper. When `task` and
    /// `multitask` resolved their model separately, fixing one left the other
    /// broken — which is why there is a single function rather than two inline
    /// lookups.
    #[test]
    fn both_spawn_sites_inherit_through_the_same_helper() {
        let src = production_src();
        // Per tool, not a total count. A count of two also holds when one tool
        // gained a second inheriting path while the other lost its only one —
        // precisely the "fixed one, left the other broken" shape this guards.
        for tool in ["TaskTool", "MultitaskTool"] {
            let body = src
                .split_once(&format!("impl Tool for {tool}"))
                .unwrap_or_else(|| panic!("{tool} impl present"))
                .1;
            // Stop at the next impl block so one tool cannot satisfy the other.
            let body = body.split("impl Tool for").next().unwrap_or(body);
            assert!(
                body.contains("inherited_model_and_settings(ctx)"),
                "{tool} does not inherit the run's model: its sub-agents would \
                 answer on the global default"
            );
        }
    }

    // ─── generate ────────────────────────────────────────────────────

    fn scratch_ws(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "gwork-generate-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The load-bearing property: a definition this tool writes must parse back
    /// through `agents::from_markdown` into the same name/description/prompt and
    /// an equivalent tool set. If the front matter it emits drifted from what the
    /// loader expects, `generate` would report success and then `task` could never
    /// resolve the agent — a silent dead end.
    #[test]
    fn generated_markdown_round_trips_through_from_markdown() {
        let md = render_agent_markdown(
            "code_reviewer",
            "Reviews diffs for defects",
            "You are a meticulous reviewer.\nFlag real bugs only.",
            &["read".to_string(), "grep".to_string()],
            &["rust".to_string()],
        );
        let def = crate::agents::AgentDefinition::from_markdown(&md, "code_reviewer", crate::agents::AgentScope::Workspace);
        assert_eq!(def.name, "code_reviewer");
        assert_eq!(def.description, "Reviews diffs for defects");
        assert!(def.enabled, "a generated agent must be enabled by default");
        assert!(def.system_prompt.contains("meticulous reviewer"), "got: {:?}", def.system_prompt);
        assert!(def.tools.contains(&"read".to_string()), "{:?}", def.tools);
        assert!(def.tools.contains(&"grep".to_string()), "{:?}", def.tools);
    }

    /// Descriptions and prompts arrive from the model and routinely contain
    /// quotes, colons and newlines. A description with a `:` must not be parsed as
    /// an extra front-matter key, and embedded quotes must survive.
    #[test]
    fn front_matter_survives_quotes_colons_and_newlines() {
        let md = render_agent_markdown(
            "sql_helper",
            "writes SQL: queries, \"quoted\" bits",
            "line one\nline two",
            &["read".to_string()],
            &[],
        );
        let def = crate::agents::AgentDefinition::from_markdown(&md, "sql_helper", crate::agents::AgentScope::Workspace);
        assert_eq!(def.name, "sql_helper");
        assert_eq!(def.description, "writes SQL: queries, \"quoted\" bits", "got: {:?}", def.description);
        // The newline in the prompt is body content, preserved (not folded, which
        // only applies to the single-line front-matter values).
        assert!(def.system_prompt.contains("line one\nline two"), "got: {:?}", def.system_prompt);
    }

    #[test]
    fn win_reserved_names_are_rejected() {
        // Case-insensitive, and independent of the .md extension.
        for bad in ["NUL", "con", "COM1", "lpt9", "aux"] {
            assert!(is_win_reserved_name(bad), "{} must be rejected", bad);
        }
        for ok in ["console", "general", "nulx", "my-com1"] {
            assert!(!is_win_reserved_name(ok), "{} is a legal name", ok);
        }
    }

    #[tokio::test]
    async fn generate_lowercases_the_name_before_writing() {
        // Windows/NTFS is case-insensitive, so `Helper.md` and `helper.md` are the
        // same file; letting a mixed-case name through would let a later save
        // silently overwrite a differently-cased agent, and the in-memory name the
        // model must pass to `task` would not match what's on disk.
        let ws = scratch_ws("lowercase");
        let mut ctx = ctx_with("m", "m");
        ctx.workspace = ws.clone();
        let out = GenerateTool
            .execute(
                serde_json::json!({"name": "MyHelper", "description": "d", "systemPrompt": "p", "tools": ["read"]}),
                &ctx,
            )
            .await;
        assert!(!out.is_error, "{}", out.text);
        // The file is named with the lowercased id, and the message tells the model
        // to call it by that same lowercased name. (No assertion that a mixed-case
        // file is absent: on Windows/NTFS `MyHelper.md` and `myhelper.md` are the
        // same file, so `.exists()` on the former is true by case-insensitivity and
        // would be a meaningless check.)
        assert!(ws.join(".gwork").join("agents").join("myhelper.md").exists(), "must write lowercased filename");
        assert!(out.text.contains("myhelper"), "the callable name must be lowercased: {}", out.text);
        // The front matter itself carries the lowercased name, so a later rescan
        // resolves the agent under exactly the id the model was told to use.
        let body = std::fs::read_to_string(ws.join(".gwork").join("agents").join("myhelper.md")).unwrap();
        assert!(body.contains("name: \"myhelper\""), "front matter name must be lowercased: {}", body);
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn generate_description_that_is_itself_quoted_round_trips_verbatim() {
        // This is the input that distinguishes proper front-matter quoting from a
        // bare value: `unquote` strips ONE layer of matching outer quotes, so a
        // description whose own text begins and ends with `"` must be escaped on the
        // way out or the loader eats the real quotes. A description with quotes only
        // in the middle does not exercise this, which is why the earlier test missed
        // it.
        let md = render_agent_markdown(
            "quoter",
            "\"fully quoted\"",
            "body",
            &["read".to_string()],
            &[],
        );
        let def = crate::agents::AgentDefinition::from_markdown(&md, "quoter", crate::agents::AgentScope::Workspace);
        assert_eq!(def.description, "\"fully quoted\"", "the literal quotes must survive: got {:?}", def.description);
    }

    #[tokio::test]
    async fn generate_writes_to_workspace_scope_by_default() {
        let ws = scratch_ws("default-scope");
        let mut ctx = ctx_with("m", "m");
        ctx.workspace = ws.clone();

        let out = GenerateTool
            .execute(
                serde_json::json!({
                    "name": "helper", "description": "d",
                    "systemPrompt": "be helpful", "tools": ["read"]
                }),
                &ctx,
            )
            .await;
        assert!(!out.is_error, "{}", out.text);
        assert!(out.text.contains("项目局部"), "{}", out.text);
        // Default scope is workspace, not global.
        assert!(ws.join(".gwork").join("agents").join("helper.md").exists());
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn generate_refuses_empty_tools_and_bad_names() {
        let ws = scratch_ws("validation");
        let mut ctx = ctx_with("m", "m");
        ctx.workspace = ws.clone();

        // No tools → a zero-capability agent, refused.
        let out = GenerateTool
            .execute(
                serde_json::json!({"name": "a", "description": "d", "systemPrompt": "p", "tools": []}),
                &ctx,
            )
            .await;
        assert!(out.is_error && out.text.contains("至少指定一个工具"), "{}", out.text);

        // Illegal characters.
        let out = GenerateTool
            .execute(
                serde_json::json!({"name": "bad name!", "description": "d", "systemPrompt": "p", "tools": ["read"]}),
                &ctx,
            )
            .await;
        assert!(out.is_error && out.text.contains("不合法"), "{}", out.text);
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn generate_refuses_to_overwrite_an_existing_agent() {
        let ws = scratch_ws("no-overwrite");
        let mut ctx = ctx_with("m", "m");
        ctx.workspace = ws.clone();
        // `explore` is a built-in; generating over it must be refused. This is the
        // privilege-erasure guard: a model must not replace a shipped agent's tool
        // whitelist with one it authored.
        let out = GenerateTool
            .execute(
                serde_json::json!({"name": "explore", "description": "d", "systemPrompt": "p", "tools": ["read"]}),
                &ctx,
            )
            .await;
        assert!(out.is_error && out.text.contains("已存在"), "{}", out.text);
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn a_generated_agent_is_immediately_resolvable_by_task() {
        // End-to-end intent: after generate writes the file, the same rescan the
        // task path performs must find it. This is the property that makes
        // "no in-memory registry, write-the-file-is-registration" actually work.
        let ws = scratch_ws("resolvable");
        let mut ctx = ctx_with("m", "m");
        ctx.workspace = ws.clone();
        let out = GenerateTool
            .execute(
                serde_json::json!({"name": "fresh_agent", "description": "d", "systemPrompt": "p", "tools": ["read", "grep"]}),
                &ctx,
            )
            .await;
        assert!(!out.is_error, "{}", out.text);
        assert!(
            crate::team::resolve_definition(&ws, "fresh_agent").is_some(),
            "a just-generated agent must be resolvable without a restart"
        );
        let _ = std::fs::remove_dir_all(&ws);
    }
}
