//! Loop task HTTP endpoints (list/get/add/update/remove/toggle/trigger).

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::{Form, Json};

use super::AppState;
use crate::loop_task::LoopTask;

#[derive(serde::Deserialize, Default)]
pub struct LoopQuery {
    #[serde(rename = "sessionId", default)]
    pub session_id: String,
    #[serde(rename = "taskId", default)]
    pub task_id: String,
}

fn invalid_session() -> Json<serde_json::Value> {
    Json(serde_json::json!({"code": 400, "description": "Invalid sessionId"}))
}

fn valid_session(id: &str) -> bool {
    !id.is_empty() && !id.contains("..") && !id.contains('/') && !id.contains('\\')
}

/// GET /web/chat/loop/list
pub async fn list(
    State(state): State<Arc<AppState>>,
    Query(q): Query<LoopQuery>,
) -> Json<serde_json::Value> {
    if !valid_session(&q.session_id) {
        return invalid_session();
    }
    let tasks = state.loop_scheduler.list_all(&q.session_id).await;
    let data: Vec<serde_json::Value> = tasks.iter().map(|t| t.to_json()).collect();
    Json(serde_json::json!({"code": 200, "data": data}))
}

/// GET /web/chat/loop/get
pub async fn get(
    State(state): State<Arc<AppState>>,
    Query(q): Query<LoopQuery>,
) -> Json<serde_json::Value> {
    if !valid_session(&q.session_id) {
        return invalid_session();
    }
    if q.task_id.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "taskId is required"}));
    }
    match state.loop_scheduler.get(&q.task_id).await {
        Some(t) => Json(serde_json::json!({"code": 200, "data": t.to_json()})),
        None => Json(serde_json::json!({"code": 404, "description": "Task not found"})),
    }
}

#[derive(serde::Deserialize, Default)]
pub struct LoopAddForm {
    #[serde(rename = "sessionId", default)]
    pub session_id: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(rename = "intervalMinutes", default)]
    pub interval_minutes: Option<u32>,
    #[serde(default)]
    pub cron: Option<String>,
    #[serde(rename = "goalCondition", default)]
    pub goal_condition: Option<String>,
    #[serde(rename = "maxIterations", default)]
    pub max_iterations: Option<u32>,
    #[serde(rename = "runNow", default)]
    pub run_now: Option<bool>,
    #[serde(rename = "taskWorkspace", default)]
    pub task_workspace: Option<String>,
    #[serde(rename = "modelName", default)]
    pub model_name: Option<String>,
    #[serde(rename = "thinkingDepth", default)]
    pub thinking_depth: Option<String>,
    #[serde(rename = "contextLength", default)]
    pub context_length: Option<i64>,
    #[serde(rename = "accessMode", default)]
    pub access_mode: Option<String>,
    #[serde(rename = "channelNotify", default)]
    pub channel_notify: Option<String>,
    #[serde(rename = "boundSessionId", default)]
    pub bound_session_id: Option<String>,
}

/// POST /web/chat/loop/add
pub async fn add(
    State(state): State<Arc<AppState>>,
    Form(form): Form<LoopAddForm>,
) -> Json<serde_json::Value> {
    if !valid_session(&form.session_id) {
        return invalid_session();
    }
    if form.prompt.trim().is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "prompt is required"}));
    }
    let mut task = LoopTask::default();
    task.prompt = form.prompt;
    task.name = form.name;
    task.interval_minutes = form.interval_minutes.unwrap_or(5);
    task.cron = form.cron;
    task.goal_condition = form.goal_condition;
    task.max_iterations = form.max_iterations;
    task.run_now = form.run_now;
    task.workspace = form.task_workspace;
    task.model_name = form.model_name;
    task.thinking_depth = form.thinking_depth;
    task.context_length = form.context_length;
    task.access_mode = form.access_mode;
    task.channel_notify = form.channel_notify;
    task.bound_session_id = form.bound_session_id;

    match state.loop_scheduler.add(task).await {
        Ok(id) => Json(serde_json::json!({"code": 200, "data": id})),
        Err(e) => Json(serde_json::json!({"code": 400, "description": e})),
    }
}

#[derive(serde::Deserialize, Default)]
pub struct LoopUpdateForm {
    #[serde(rename = "sessionId", default)]
    pub session_id: String,
    #[serde(rename = "taskId", default)]
    pub task_id: String,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(rename = "intervalMinutes", default)]
    pub interval_minutes: Option<u32>,
    #[serde(default)]
    pub cron: Option<String>,
    #[serde(rename = "goalCondition", default)]
    pub goal_condition: Option<String>,
    #[serde(rename = "maxIterations", default)]
    pub max_iterations: Option<u32>,
    #[serde(rename = "runNow", default)]
    pub run_now: Option<bool>,
    #[serde(rename = "modelName", default)]
    pub model_name: Option<String>,
    #[serde(rename = "thinkingDepth", default)]
    pub thinking_depth: Option<String>,
    #[serde(rename = "accessMode", default)]
    pub access_mode: Option<String>,
    #[serde(rename = "channelNotify", default)]
    pub channel_notify: Option<String>,
    #[serde(rename = "boundSessionId", default)]
    pub bound_session_id: Option<String>,
}

/// POST /web/chat/loop/update
pub async fn update(
    State(state): State<Arc<AppState>>,
    Form(form): Form<LoopUpdateForm>,
) -> Json<serde_json::Value> {
    if !valid_session(&form.session_id) {
        return invalid_session();
    }
    let mut patch = serde_json::Map::new();
    if let Some(v) = form.prompt { patch.insert("prompt".into(), serde_json::json!(v)); }
    if let Some(v) = form.name { patch.insert("name".into(), serde_json::json!(v)); }
    if let Some(v) = form.interval_minutes { patch.insert("intervalMinutes".into(), serde_json::json!(v)); }
    if let Some(v) = form.cron { patch.insert("cron".into(), serde_json::json!(v)); }
    if let Some(v) = form.goal_condition { patch.insert("goalCondition".into(), serde_json::json!(v)); }
    if let Some(v) = form.max_iterations { patch.insert("maxIterations".into(), serde_json::json!(v)); }
    if let Some(v) = form.run_now { patch.insert("runNow".into(), serde_json::json!(v)); }
    if let Some(v) = form.model_name { patch.insert("modelName".into(), serde_json::json!(v)); }
    if let Some(v) = form.thinking_depth { patch.insert("thinkingDepth".into(), serde_json::json!(v)); }
    if let Some(v) = form.access_mode { patch.insert("accessMode".into(), serde_json::json!(v)); }
    if let Some(v) = form.channel_notify { patch.insert("channelNotify".into(), serde_json::json!(v)); }
    if let Some(v) = form.bound_session_id { patch.insert("boundSessionId".into(), serde_json::json!(v)); }

    if state.loop_scheduler.update(&form.task_id, serde_json::Value::Object(patch)).await {
        Json(serde_json::json!({"code": 200}))
    } else {
        Json(serde_json::json!({"code": 404, "description": "Task not found"}))
    }
}

/// POST /web/chat/loop/remove
pub async fn remove(
    State(state): State<Arc<AppState>>,
    Form(form): Form<LoopQuery>,
) -> Json<serde_json::Value> {
    if !valid_session(&form.session_id) {
        return invalid_session();
    }
    state.loop_scheduler.remove(&form.task_id).await;
    Json(serde_json::json!({"code": 200}))
}

/// POST /web/chat/loop/toggle
pub async fn toggle(
    State(state): State<Arc<AppState>>,
    Form(form): Form<LoopQuery>,
) -> Json<serde_json::Value> {
    if !valid_session(&form.session_id) {
        return invalid_session();
    }
    match state.loop_scheduler.toggle(&form.task_id).await {
        Some(enabled) => Json(serde_json::json!({"code": 200, "data": {"enabled": enabled}})),
        None => Json(serde_json::json!({"code": 404, "description": "Task not found"})),
    }
}

/// POST /web/chat/loop/trigger — immediately run a task once.
pub async fn trigger(
    State(state): State<Arc<AppState>>,
    Form(form): Form<LoopQuery>,
) -> Json<serde_json::Value> {
    if !valid_session(&form.session_id) {
        return invalid_session();
    }
    let task = match state.loop_scheduler.get(&form.task_id).await {
        Some(t) => t,
        None => return Json(serde_json::json!({"code": 404, "description": "Task not found"})),
    };
    // Spawn an async run
    let state_clone = state.clone();
    let task_id = form.task_id.clone();
    tokio::spawn(async move {
        super::loop_runner::execute_loop_task(state_clone, task_id, task).await;
    });
    Json(serde_json::json!({"code": 200}))
}
