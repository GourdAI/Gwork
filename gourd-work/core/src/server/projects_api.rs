//! Project registry HTTP endpoints.
//!
//! Request/response contract mirrors the Java kernel's `ProjectService` exactly —
//! see `crate::projects` for why each shape matters. Every POST here takes a
//! **JSON body** (`Json<...>`), because that is what the frontend sends:
//! `$.ajax({ contentType: 'application/json', data: JSON.stringify(...) })`.
//! Using `Form<...>` instead makes axum reject the request with HTTP 415
//! ("Form requests must have Content-Type: application/x-www-form-urlencoded"),
//! which surfaces in the UI as a silent failure.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;

use super::AppState;
use crate::projects::{self, ApiError};

/// GET /web/chat/projects
pub async fn list(State(_state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let items = projects::projects_json(&projects::load_projects());
    Json(serde_json::json!({"code": 200, "data": items}))
}

/// Body for `add` / `remove` / `rename` / `create` / `mkdir`.
///
/// One struct covers the whole family because the Java kernel reads the same
/// handful of keys off a raw JSON object per endpoint; keeping them together
/// avoids five near-identical types. Unused keys are simply ignored.
#[derive(serde::Deserialize, Default)]
#[serde(default)]
pub struct ProjectBody {
    /// Absolute directory path (`add`, `remove`, `rename`).
    pub path: String,
    /// Display name (`add`, `rename`) or new directory name (`create`, `mkdir`).
    pub name: String,
    /// Parent directory (`create`, `mkdir`).
    pub parent: String,
    /// First-level subdirectory names used as a location fingerprint (`locate`).
    pub children: Vec<String>,
}

/// POST /web/chat/projects/add — register an existing directory (upsert + front).
pub async fn add(Json(body): Json<ProjectBody>) -> Json<serde_json::Value> {
    respond(projects::add_project(&body.path, &body.name))
}

/// POST /web/chat/projects/create — create a directory and register it.
pub async fn create(Json(body): Json<ProjectBody>) -> Json<serde_json::Value> {
    respond(projects::create_project(&body.parent, &body.name))
}

/// POST /web/chat/projects/mkdir — create a directory **without** registering it.
///
/// Deliberately not `create`: the directory browser's "new folder" is a
/// navigation action, and registering every intermediate directory would litter
/// the workspace dropdown with junk entries.
pub async fn mkdir(Json(body): Json<ProjectBody>) -> Json<serde_json::Value> {
    match projects::mkdir(&body.parent, &body.name) {
        Ok((path, name)) => Json(serde_json::json!({"code": 200, "data": {"path": path, "name": name}})),
        Err(e) => Json(e.to_json()),
    }
}

#[derive(serde::Deserialize, Default)]
pub struct BrowseQuery {
    #[serde(default)]
    pub path: String,
}

/// GET /web/chat/projects/browse
///
/// `data` 是 `{current, parent, separator, dirs}` 对象（Java `ProjectService.browse`
/// 的同款形状），不是子目录数组——前端目录选择器靠 `data.current` 判断「已进入目录」，
/// 返回数组会让「新建文件夹/选定此目录」永远被 `please_enter_dir` 拦下。
pub async fn browse(Query(q): Query<BrowseQuery>) -> Json<serde_json::Value> {
    match projects::browse(&q.path) {
        Ok(data) => Json(serde_json::json!({"code": 200, "data": data})),
        Err(e) => Json(e.to_json()),
    }
}

/// POST /web/chat/projects/remove — unregister (does not delete files).
pub async fn remove(Json(body): Json<ProjectBody>) -> Json<serde_json::Value> {
    respond(projects::remove_project(&body.path))
}

/// POST /web/chat/projects/rename — change the display name in place.
pub async fn rename(Json(body): Json<ProjectBody>) -> Json<serde_json::Value> {
    respond(projects::rename_project(&body.path, &body.name))
}

/// POST /web/chat/projects/locate — resolve a browser-picked folder to a path.
///
/// Response is `{candidates: [absPath...], scanned: n}`; the frontend reads
/// `resp.data.candidates` and treats "exactly one" as auto-select.
pub async fn locate(Json(body): Json<ProjectBody>) -> Json<serde_json::Value> {
    match projects::locate(&body.name, &body.children) {
        Ok(r) => Json(serde_json::json!({
            "code": 200,
            "data": {"candidates": r.candidates, "scanned": r.scanned}
        })),
        Err(e) => Json(e.to_json()),
    }
}

/// Shared success/error rendering for the list-returning endpoints.
fn respond(r: Result<Vec<projects::Project>, ApiError>) -> Json<serde_json::Value> {
    match r {
        Ok(list) => Json(serde_json::json!({"code": 200, "data": projects::projects_json(&list)})),
        Err(e) => Json(e.to_json()),
    }
}
