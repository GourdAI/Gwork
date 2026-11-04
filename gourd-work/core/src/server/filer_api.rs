//! Filer (file browser/editor) HTTP endpoints.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;

use super::AppState;
use crate::filer;

#[derive(serde::Deserialize, Default)]
pub struct FilerQuery {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub depth: usize,
    #[serde(default)]
    pub keyword: String,
    #[serde(default)]
    pub offset: usize,
    #[serde(default)]
    pub limit: usize,
    /// Optional explicit project root (Code mode). The Java kernel's
    /// `FileService.resolveRoot` honours it; ignoring it made the Rust kernel
    /// always browse its own workspace no matter which project was open.
    #[serde(default)]
    pub root: String,
}

fn root(state: &AppState) -> std::path::PathBuf {
    state.workspace.clone()
}

/// Effective root: explicit absolute `root` param wins, else kernel workspace.
fn effective_root(state: &AppState, q: &FilerQuery) -> std::path::PathBuf {
    let trimmed = q.root.trim();
    if !trimmed.is_empty() && std::path::Path::new(trimmed).is_absolute() {
        std::path::PathBuf::from(trimmed)
    } else {
        root(state)
    }
}

/// GET /web/chat/filer/tree
pub async fn tree(State(state): State<Arc<AppState>>, Query(q): Query<FilerQuery>) -> Json<serde_json::Value> {
    let depth = if q.depth == 0 { 1 } else { q.depth.min(6) };
    let base = effective_root(&state, &q);
    match filer::tree(&base, &q.path, depth) {
        Ok(children) => Json(serde_json::json!({"code": 200, "data": children})),
        Err(filer::TreeError::InvalidPath) => {
            Json(serde_json::json!({"code": 400, "description": "Invalid path"}))
        }
        Err(filer::TreeError::Denied) => {
            Json(serde_json::json!({"code": 403, "description": "Access denied"}))
        }
        Err(filer::TreeError::NotFound) => {
            Json(serde_json::json!({"code": 404, "description": "Directory not found"}))
        }
    }
}

/// GET /web/chat/filer/read
pub async fn read(State(state): State<Arc<AppState>>, Query(q): Query<FilerQuery>) -> Json<serde_json::Value> {
    let base = effective_root(&state, &q);
    let result = filer::read_file(&base, &q.path, q.offset, q.limit);
    if result.get("error").is_some() {
        let desc = result["error"].as_str().unwrap_or("Error");
        let code = if desc == "invalid path" { 400 } else { 404 };
        return Json(serde_json::json!({"code": code, "description": desc}));
    }
    Json(serde_json::json!({"code": 200, "data": result}))
}

/// Body of `POST /web/chat/filer/write`.
///
/// JSON, not form-encoded: the editor's save path sends
/// `contentType: 'application/json'` (app-code.js `saveActive`). A `Form<...>`
/// extractor here makes axum answer HTTP 415 and the save silently fails.
#[derive(serde::Deserialize, Default)]
#[serde(default)]
pub struct FilerWriteBody {
    pub path: String,
    pub content: String,
    /// Optional explicit root. The frontend sends the project root so that a
    /// remote-scoped save cannot be redirected by the session workspace; when
    /// absent we fall back to the session workspace root.
    pub root: String,
}

/// POST /web/chat/filer/write
pub async fn write(State(state): State<Arc<AppState>>, Json(body): Json<FilerWriteBody>) -> Json<serde_json::Value> {
    // An explicit root wins, but only when absolute — a relative or empty value
    // must not be able to relocate the write outside the intended tree.
    let base = if !body.root.trim().is_empty() && std::path::Path::new(body.root.trim()).is_absolute() {
        std::path::PathBuf::from(body.root.trim())
    } else {
        root(&state)
    };
    let result = filer::write_file(&base, &body.path, &body.content);
    Json(serde_json::json!({"code": 200, "data": result}))
}

/// GET /web/chat/filer/search
pub async fn search(State(state): State<Arc<AppState>>, Query(q): Query<FilerQuery>) -> Json<serde_json::Value> {
    if q.keyword.trim().is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "Keyword is required"}));
    }
    if q.keyword.contains("..") {
        return Json(serde_json::json!({"code": 400, "description": "Invalid keyword"}));
    }
    let base = effective_root(&state, &q);
    let results = filer::search(&base, &q.keyword);
    Json(serde_json::json!({"code": 200, "data": results}))
}

/// GET /web/chat/filer/raw — return raw bytes as base64 dataUrl.
pub async fn raw(State(state): State<Arc<AppState>>, Query(q): Query<FilerQuery>) -> Json<serde_json::Value> {
    let base = effective_root(&state, &q);
    match filer::raw(&base, &q.path) {
        Some((mime, bytes)) => {
            let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
            Json(serde_json::json!({
                "code": 200,
                "data": {
                    "mime": mime,
                    "dataUrl": format!("data:{};base64,{}", mime, b64),
                    "size": bytes.len(),
                }
            }))
        }
        None => Json(serde_json::json!({"code": 404, "description": "File not found"})),
    }
}

/// Body of `POST /web/chat/filer/watch`.
#[derive(serde::Deserialize, Default)]
#[serde(default)]
pub struct FilerWatchBody {
    /// Absolute directory to watch for external modifications.
    pub root: String,
}

/// POST /web/chat/filer/watch — register a directory for external-change notification.
///
/// The editor calls this whenever the active project root changes so that files
/// modified outside the app can be reloaded (clean files silently, dirty files
/// via a "changed on disk" marker). Changes are broadcast over the gate WS as
/// `filer_change` events.
///
/// An empty/relative root is rejected rather than silently accepted: the caller
/// would otherwise believe its tree is being watched while nothing is.
pub async fn watch(
    State(state): State<Arc<AppState>>,
    Json(body): Json<FilerWatchBody>,
) -> Json<serde_json::Value> {
    let trimmed = body.root.trim();
    if trimmed.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "root is required"}));
    }
    let path = std::path::Path::new(trimmed);
    if !path.is_absolute() {
        return Json(serde_json::json!({"code": 400, "description": "root must be absolute"}));
    }
    if !path.is_dir() {
        return Json(serde_json::json!({"code": 404, "description": "Directory not found"}));
    }

    match state.watcher.add_root(path).await {
        Ok(watching) => Json(serde_json::json!({"code": 200, "data": {"watching": watching, "root": trimmed}})),
        Err(e) => Json(serde_json::json!({"code": 500, "description": e})),
    }
}
