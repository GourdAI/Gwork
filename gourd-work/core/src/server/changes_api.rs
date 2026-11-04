//! File-change HTTP endpoints (run/diff/session/undo/reapply).

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;

use super::AppState;

#[derive(serde::Deserialize, Default)]
pub struct ChangesQuery {
    #[serde(rename = "sessionId", default)]
    pub session_id: String,
    #[serde(rename = "runId", default)]
    pub run_id: String,
    #[serde(default)]
    pub path: String,
}

fn valid_session(id: &str) -> bool {
    !id.is_empty() && !id.contains("..") && !id.contains('/') && !id.contains('\\')
}

/// GET /web/chat/changes/run
pub async fn run(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ChangesQuery>,
) -> Json<serde_json::Value> {
    if !valid_session(&q.session_id) {
        return Json(serde_json::json!({"code": 400, "description": "Invalid sessionId"}));
    }
    let result = state.change_ledger.get_run(&q.session_id, &q.run_id);
    Json(serde_json::json!({"code": 200, "data": result}))
}

/// GET /web/chat/changes/diff
pub async fn diff(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ChangesQuery>,
) -> Json<serde_json::Value> {
    if !valid_session(&q.session_id) {
        return Json(serde_json::json!({"code": 400, "description": "Invalid sessionId"}));
    }
    let result = state.change_ledger.diff(&q.session_id, &q.run_id, &q.path);
    Json(serde_json::json!({"code": 200, "data": result}))
}

/// GET /web/chat/changes/session
pub async fn session(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ChangesQuery>,
) -> Json<serde_json::Value> {
    if !valid_session(&q.session_id) {
        return Json(serde_json::json!({"code": 400, "description": "Invalid sessionId"}));
    }
    let result = state.change_ledger.list_session(&q.session_id);
    Json(serde_json::json!({"code": 200, "data": result}))
}

#[derive(serde::Deserialize, Default)]
pub struct ChangesUndoBody {
    #[serde(rename = "sessionId", default)]
    pub session_id: String,
    #[serde(rename = "runId", default)]
    pub run_id: String,
    #[serde(default)]
    pub path: String,
    #[serde(rename = "operationId", default)]
    pub operation_id: String,
}

/// POST /web/chat/changes/undo/file
pub async fn undo_file(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ChangesUndoBody>,
) -> Json<serde_json::Value> {
    if !valid_session(&body.session_id) {
        return Json(serde_json::json!({"code": 400, "description": "Invalid sessionId"}));
    }
    let result = state.change_ledger.undo_file(&body.session_id, &body.run_id, &body.path);
    let mut resp = serde_json::json!({"code": 200, "data": result});
    if !body.operation_id.is_empty() {
        resp["data"]["operationId"] = serde_json::json!(body.operation_id);
    }
    Json(resp)
}

/// POST /web/chat/changes/undo/run
pub async fn undo_run(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ChangesUndoBody>,
) -> Json<serde_json::Value> {
    if !valid_session(&body.session_id) {
        return Json(serde_json::json!({"code": 400, "description": "Invalid sessionId"}));
    }
    let result = state.change_ledger.undo_run(&body.session_id, &body.run_id);
    Json(serde_json::json!({"code": 200, "data": result}))
}

/// POST /web/chat/changes/reapply/run
pub async fn reapply_run(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ChangesUndoBody>,
) -> Json<serde_json::Value> {
    if !valid_session(&body.session_id) {
        return Json(serde_json::json!({"code": 400, "description": "Invalid sessionId"}));
    }
    let result = state.change_ledger.reapply_run(&body.session_id, &body.run_id);
    Json(serde_json::json!({"code": 200, "data": result}))
}
