//! loop_task — Loop (scheduled/recurring) task system.
//!
//! Mirrors the Java kernel's LoopScheduler/LoopTask/LoopStateManager.
//! - Tasks persist to `<workspace>/.gwork/sessions/global-loop-tasks.json`.
//! - Per-task state lives in `<workspace>/.gwork/loops/<taskId>/` with history.json
//!   and attachments/.
//! - Three trigger modes: interval (fixedDelay minutes), cron, and goal
//!   (goalCondition + [GOAL_ACHIEVED] detection).
//! - Tasks expire after 7 days (EXPIRE_DAYS).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

const EXPIRE_DAYS: i64 = 7;
const MAX_TASKS: usize = 100;
const TASKS_FILE: &str = "global-loop-tasks.json";

/// A loop task definition (serializable, persisted).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct LoopTask {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub prompt: String,
    #[serde(rename = "intervalMinutes")]
    pub interval_minutes: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cron: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "expireAt")]
    pub expire_at: String,
    pub cancelled: bool,
    pub enabled: bool,
    #[serde(rename = "lastResult", skip_serializing_if = "Option::is_none")]
    pub last_result: Option<String>,
    #[serde(rename = "lastExecutedAt", skip_serializing_if = "Option::is_none")]
    pub last_executed_at: Option<String>,
    #[serde(rename = "currentIteration")]
    pub current_iteration: u32,
    #[serde(rename = "runtimeSessionId", skip_serializing_if = "Option::is_none")]
    pub runtime_session_id: Option<String>,
    #[serde(rename = "goalCondition", skip_serializing_if = "Option::is_none")]
    pub goal_condition: Option<String>,
    #[serde(rename = "maxIterations", skip_serializing_if = "Option::is_none")]
    pub max_iterations: Option<u32>,
    #[serde(rename = "runNow", skip_serializing_if = "Option::is_none")]
    pub run_now: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(rename = "modelName", skip_serializing_if = "Option::is_none")]
    pub model_name: Option<String>,
    #[serde(rename = "thinkingDepth", skip_serializing_if = "Option::is_none")]
    pub thinking_depth: Option<String>,
    #[serde(rename = "contextLength", skip_serializing_if = "Option::is_none")]
    pub context_length: Option<i64>,
    #[serde(rename = "accessMode", skip_serializing_if = "Option::is_none")]
    pub access_mode: Option<String>,
    #[serde(rename = "channelNotify", skip_serializing_if = "Option::is_none")]
    pub channel_notify: Option<String>,
    #[serde(rename = "boundSessionId", skip_serializing_if = "Option::is_none")]
    pub bound_session_id: Option<String>,
    #[serde(rename = "attachmentPaths", skip_serializing_if = "Option::is_none")]
    pub attachment_paths: Option<Vec<String>>,
    #[serde(rename = "attachmentTypes", skip_serializing_if = "Option::is_none")]
    pub attachment_types: Option<Vec<String>>,
    /// Transient: whether a run is currently in progress (not persisted meaningfully).
    #[serde(default, skip_serializing)]
    pub running: bool,
}

impl Default for LoopTask {
    fn default() -> Self {
        let now = chrono::Utc::now();
        Self {
            id: uuid::Uuid::new_v4().to_string()[..8].to_string(),
            name: None,
            prompt: String::new(),
            interval_minutes: 5,
            cron: None,
            created_at: now.to_rfc3339(),
            expire_at: (now + chrono::Duration::days(EXPIRE_DAYS)).to_rfc3339(),
            cancelled: false,
            enabled: true,
            last_result: None,
            last_executed_at: None,
            current_iteration: 0,
            runtime_session_id: None,
            goal_condition: None,
            max_iterations: None,
            run_now: None,
            workspace: None,
            model_name: None,
            thinking_depth: None,
            context_length: None,
            access_mode: None,
            channel_notify: None,
            bound_session_id: None,
            attachment_paths: None,
            attachment_types: None,
            running: false,
        }
    }
}

impl LoopTask {
    pub fn is_expired(&self) -> bool {
        chrono::DateTime::parse_from_rfc3339(&self.expire_at)
            .map(|t| chrono::Utc::now() > t.with_timezone(&chrono::Utc))
            .unwrap_or(false)
    }

    pub fn is_active(&self) -> bool {
        !self.cancelled && !self.is_expired()
    }

    pub fn is_max_iterations_reached(&self) -> bool {
        self.max_iterations
            .map(|m| m > 0 && self.current_iteration >= m)
            .unwrap_or(false)
    }

    /// Serialize to the frontend-facing JSON map (loop/list shape).
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

/// Loop scheduler: owns the task list and drives execution.
pub struct LoopScheduler {
    workspace: PathBuf,
    tasks: Arc<Mutex<Vec<LoopTask>>>,
}

impl LoopScheduler {
    pub fn new(workspace: PathBuf) -> Self {
        let sched = Self {
            workspace,
            tasks: Arc::new(Mutex::new(Vec::new())),
        };
        sched
    }

    fn tasks_file(&self) -> PathBuf {
        self.workspace.join(".gwork").join("sessions").join(TASKS_FILE)
    }

    fn loop_dir(&self, task_id: &str) -> PathBuf {
        self.workspace.join(".gwork").join("loops").join(task_id)
    }

    /// Load tasks from disk (called on startup).
    pub async fn restore(&self) {
        let path = self.tasks_file();
        let Ok(content) = std::fs::read_to_string(&path) else { return };
        let Ok(list) = serde_json::from_str::<Vec<LoopTask>>(&content) else { return };
        let mut tasks = self.tasks.lock().await;
        // Filter expired/cancelled, dedupe by id, keep only enabled for scheduling
        let mut seen = std::collections::HashSet::new();
        for t in list {
            if t.is_expired() || t.cancelled {
                continue;
            }
            if seen.insert(t.id.clone()) {
                tasks.push(t);
            }
        }
    }

    fn persist_blocking(&self, tasks: &[LoopTask]) {
        let path = self.tasks_file();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(tasks) {
            let tmp = path.with_extension("json.tmp");
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            }
        }
    }

    pub async fn persist(&self) {
        let tasks = self.tasks.lock().await.clone();
        self.persist_blocking(&tasks);
    }

    /// List all tasks regardless of session binding (for the scheduler driver).
    pub async fn list_all_global(&self) -> Vec<LoopTask> {
        self.tasks.lock().await.clone()
    }

    /// List all tasks (including disabled), optionally filtered by bound session.
    pub async fn list_all(&self, session_id: &str) -> Vec<LoopTask> {
        let tasks = self.tasks.lock().await;
        tasks
            .iter()
            .filter(|t| {
                // Tasks belong to a session if boundSessionId matches, or if they
                // have no binding (global) and the requesting session is the runtime.
                t.bound_session_id.as_deref() == Some(session_id)
                    || t.runtime_session_id.as_deref() == Some(session_id)
                    || (t.bound_session_id.is_none() && t.runtime_session_id.is_none())
            })
            .cloned()
            .collect()
    }

    pub async fn get(&self, task_id: &str) -> Option<LoopTask> {
        self.tasks.lock().await.iter().find(|t| t.id == task_id).cloned()
    }

    /// Add a new task. Returns the task id or an error message.
    pub async fn add(&self, task: LoopTask) -> Result<String, String> {
        let mut tasks = self.tasks.lock().await;
        if tasks.len() >= MAX_TASKS {
            return Err(format!("Loop task limit reached ({})", MAX_TASKS));
        }
        // Initialize state dir + history.json
        let state_dir = self.loop_dir(&task.id);
        let _ = std::fs::create_dir_all(&state_dir);
        let history = state_dir.join("history.json");
        if !history.exists() {
            let _ = std::fs::write(&history, "[]");
        }
        let id = task.id.clone();
        tasks.push(task);
        let snapshot = tasks.clone();
        drop(tasks);
        self.persist_blocking(&snapshot);
        Ok(id)
    }

    /// Update an existing task's mutable fields.
    pub async fn update(&self, task_id: &str, patch: serde_json::Value) -> bool {
        let mut tasks = self.tasks.lock().await;
        let Some(task) = tasks.iter_mut().find(|t| t.id == task_id) else {
            return false;
        };
        if let Some(v) = patch.get("prompt").and_then(|v| v.as_str()) { task.prompt = v.to_string(); }
        if let Some(v) = patch.get("name").and_then(|v| v.as_str()) { task.name = Some(v.to_string()); }
        if let Some(v) = patch.get("intervalMinutes").and_then(|v| v.as_u64()) { task.interval_minutes = v as u32; }
        if let Some(v) = patch.get("cron").and_then(|v| v.as_str()) { task.cron = Some(v.to_string()); }
        if let Some(v) = patch.get("goalCondition").and_then(|v| v.as_str()) { task.goal_condition = Some(v.to_string()); }
        if let Some(v) = patch.get("maxIterations").and_then(|v| v.as_u64()) { task.max_iterations = Some(v as u32); }
        if let Some(v) = patch.get("runNow").and_then(|v| v.as_bool()) { task.run_now = Some(v); }
        if let Some(v) = patch.get("modelName").and_then(|v| v.as_str()) { task.model_name = Some(v.to_string()); }
        if let Some(v) = patch.get("thinkingDepth").and_then(|v| v.as_str()) { task.thinking_depth = Some(v.to_string()); }
        if let Some(v) = patch.get("accessMode").and_then(|v| v.as_str()) { task.access_mode = Some(v.to_string()); }
        if let Some(v) = patch.get("channelNotify").and_then(|v| v.as_str()) { task.channel_notify = Some(v.to_string()); }
        if let Some(v) = patch.get("boundSessionId").and_then(|v| v.as_str()) { task.bound_session_id = Some(v.to_string()); }
        let snapshot = tasks.clone();
        drop(tasks);
        self.persist_blocking(&snapshot);
        true
    }

    /// Remove (cancel) a task and clean its state dir + attachments.
    pub async fn remove(&self, task_id: &str) -> bool {
        let mut tasks = self.tasks.lock().await;
        let before = tasks.len();
        tasks.retain(|t| t.id != task_id);
        let removed = tasks.len() < before;
        let snapshot = tasks.clone();
        drop(tasks);
        if removed {
            self.persist_blocking(&snapshot);
            let _ = std::fs::remove_dir_all(self.loop_dir(task_id));
        }
        removed
    }

    /// Toggle enabled state.
    pub async fn toggle(&self, task_id: &str) -> Option<bool> {
        let mut tasks = self.tasks.lock().await;
        let task = tasks.iter_mut().find(|t| t.id == task_id)?;
        task.enabled = !task.enabled;
        let new_state = task.enabled;
        let snapshot = tasks.clone();
        drop(tasks);
        self.persist_blocking(&snapshot);
        Some(new_state)
    }

    /// Record a run result into history.json and update task counters.
    pub async fn record_result(&self, task_id: &str, result: &str, goal_achieved: bool) {
        let mut tasks = self.tasks.lock().await;
        if let Some(task) = tasks.iter_mut().find(|t| t.id == task_id) {
            task.current_iteration += 1;
            task.last_result = Some(result.chars().take(500).collect());
            task.last_executed_at = Some(chrono::Utc::now().to_rfc3339());
            task.running = false;
        }
        let snapshot = tasks.clone();
        drop(tasks);
        self.persist_blocking(&snapshot);

        // Append to history.json
        let history_path = self.loop_dir(task_id).join("history.json");
        let mut history: Vec<serde_json::Value> = std::fs::read_to_string(&history_path)
            .ok()
            .and_then(|c| serde_json::from_str(&c).ok())
            .unwrap_or_default();
        let iteration = snapshot
            .iter()
            .find(|t| t.id == task_id)
            .map(|t| t.current_iteration)
            .unwrap_or(0);
        let stop_reason = if goal_achieved { "GOAL_ACHIEVED" } else { "NONE" };
        history.push(serde_json::json!({
            "iteration": iteration,
            "time": chrono::Utc::now().to_rfc3339(),
            "result": result,
            "completed": true,
            "goalAchieved": goal_achieved,
            "stopReason": stop_reason,
        }));
        let _ = std::fs::write(&history_path, serde_json::to_string_pretty(&history).unwrap_or_default());

        // If goal achieved or max iterations reached, auto-remove
        let should_remove = goal_achieved
            || snapshot.iter().find(|t| t.id == task_id).map(|t| t.is_max_iterations_reached()).unwrap_or(false);
        if should_remove {
            self.remove(task_id).await;
        }
    }

    /// Mark a task as running (returns false if already running).
    pub async fn try_start(&self, task_id: &str) -> bool {
        let mut tasks = self.tasks.lock().await;
        let Some(task) = tasks.iter_mut().find(|t| t.id == task_id) else {
            return false;
        };
        if task.running {
            return false;
        }
        task.running = true;
        true
    }

    /// Get the runtime session id for a task (creating one if needed).
    pub async fn runtime_session_id(&self, task_id: &str) -> Option<String> {
        let mut tasks = self.tasks.lock().await;
        let task = tasks.iter_mut().find(|t| t.id == task_id)?;
        if task.runtime_session_id.is_none() {
            task.runtime_session_id = Some(format!("work-{}", &uuid::Uuid::new_v4().to_string()[..8]));
        }
        let sid = task.runtime_session_id.clone();
        let snapshot = tasks.clone();
        drop(tasks);
        self.persist_blocking(&snapshot);
        sid
    }

    /// Build the effective prompt for a run (injects goal context if goal mode).
    pub fn build_effective_prompt(task: &LoopTask) -> String {
        let Some(goal) = &task.goal_condition else {
            return task.prompt.clone();
        };
        let max = task.max_iterations.map(|m| m.to_string()).unwrap_or_else(|| "∞".into());
        format!(
            "{}\n\n--- 目标（持久目标） ---\n<objective>{}</objective>\n进度：第 {}/{} 次迭代\n如果目标已达成，请回复 [GOAL_ACHIEVED]。",
            task.prompt,
            goal,
            task.current_iteration + 1,
            max
        )
    }

    /// Compute the next-run delay for a task (for the scheduler tick).
    pub fn next_delay(task: &LoopTask) -> std::time::Duration {
        if let Some(cron_expr) = &task.cron {
            // Cron mode: compute next occurrence
            if let Ok(schedule) = cron_expr.parse::<cron::Schedule>() {
                if let Some(next) = schedule.upcoming(chrono::Utc).next() {
                    let now = chrono::Utc::now();
                    let delta = next.signed_duration_since(now);
                    if delta.num_milliseconds() > 0 {
                        return std::time::Duration::from_millis(delta.num_milliseconds() as u64);
                    }
                }
            }
            // Fallback: treat as interval
        }
        std::time::Duration::from_secs((task.interval_minutes.max(1) as u64) * 60)
    }

    pub fn workspace(&self) -> &Path {
        &self.workspace
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_task_defaults_and_expiry() {
        let t = LoopTask::default();
        assert!(!t.is_expired());
        assert!(t.is_active());
        assert!(!t.is_max_iterations_reached());
        assert_eq!(t.interval_minutes, 5);
    }

    #[test]
    fn test_max_iterations() {
        let mut t = LoopTask::default();
        t.max_iterations = Some(3);
        t.current_iteration = 3;
        assert!(t.is_max_iterations_reached());
        t.current_iteration = 2;
        assert!(!t.is_max_iterations_reached());
    }

    #[test]
    fn test_effective_prompt_goal() {
        let mut t = LoopTask::default();
        t.prompt = "check status".into();
        t.goal_condition = Some("all tests pass".into());
        let p = LoopScheduler::build_effective_prompt(&t);
        assert!(p.contains("[GOAL_ACHIEVED]"));
        assert!(p.contains("all tests pass"));
    }

    #[test]
    fn test_next_delay_interval() {
        let mut t = LoopTask::default();
        t.interval_minutes = 10;
        assert_eq!(LoopScheduler::next_delay(&t), std::time::Duration::from_secs(600));
    }
}
