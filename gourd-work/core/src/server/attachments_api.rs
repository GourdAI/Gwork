//! Attachment HTTP endpoints (upload/meta/list).

use std::sync::Arc;

use axum::extract::{Multipart, Query, RawQuery, State};
use axum::Json;

use super::AppState;
use crate::attachments;

/// POST /web/chat/attachment/upload
pub async fn upload(
    State(state): State<Arc<AppState>>,
    Query(q): Query<SessionQuery>,
    mut multipart: Multipart,
) -> Json<serde_json::Value> {
    let mut session_id = q.session_id;
    let mut files: Vec<(String, String, Vec<u8>)> = Vec::new(); // (name, type, bytes)
    let mut types: Vec<String> = Vec::new();

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or_default().to_string();
        match name.as_str() {
            "sessionId" => {
                session_id = field.text().await.unwrap_or_default();
            }
            "attachmentTypes" => {
                types.push(field.text().await.unwrap_or_else(|_| "file".into()));
            }
            "attachments" => {
                let file_name = field
                    .file_name()
                    .unwrap_or("attachment")
                    .to_string();
                let bytes = field.bytes().await.unwrap_or_default().to_vec();
                files.push((file_name, String::new(), bytes));
            }
            _ => {}
        }
    }

    if session_id.is_empty() || !crate::session::SessionStore::is_valid_id(&session_id) {
        return Json(serde_json::json!({"code": 400, "description": "sessionId is required"}));
    }
    if files.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "EMPTY_ATTACHMENT"}));
    }

    let session_dir = super::store_for(&state, &session_id).session_dir_pub(&session_id);
    let mut items = Vec::new();
    for (i, (file_name, _, bytes)) in files.iter().enumerate() {
        let declared_type = types.get(i).map(|s| s.as_str()).unwrap_or("file");
        let truncated = attachments::truncate_attachment_name(file_name);
        if let Some(saved) = attachments::save_attachment(&session_dir, &truncated, declared_type, bytes) {
            items.push(serde_json::json!(saved));
        }
    }
    if items.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "INVALID_ATTACHMENT_NAME"}));
    }
    Json(serde_json::json!({"code": 200, "data": {"items": items}}))
}

/// GET /web/chat/attachment/meta
///
/// Parsed from the raw query string on purpose: `paths` arrives either as a
/// single `paths=x` or repeated `paths=a&paths=b`, and axum's `Query<MetaQuery>`
/// rejects the single-value form with a bare HTTP 400 before the handler runs.
/// A 400 here made the frontend retry the batch on every re-render, producing
/// an endless stream of failing requests (and error toasts).
pub async fn meta(
    State(state): State<Arc<AppState>>,
    RawQuery(raw): RawQuery,
) -> Json<serde_json::Value> {
    let (session_id, paths) = parse_meta_query(raw.unwrap_or_default().as_str());
    if session_id.is_empty() || !crate::session::SessionStore::is_valid_id(&session_id) {
        return Json(serde_json::json!({"code": 400, "description": "sessionId is required"}));
    }
    let paths: Vec<String> = paths.iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    if paths.is_empty() {
        return Json(serde_json::json!({"code": 200, "data": {"items": []}}));
    }
    if paths.len() > attachments::ATTACHMENT_META_MAX_PATHS {
        return Json(serde_json::json!({"code": 400, "description": "TOO_MANY_PATHS"}));
    }
    let session_dir = super::store_for(&state, &session_id).session_dir_pub(&session_id);
    // One offload for the whole batch (the 24 MB budget is shared across items);
    // see `attachments::attachment_meta_batch`.
    let items = attachments::attachment_meta_batch(&session_dir, &paths);
    Json(serde_json::json!({"code": 200, "data": {"items": items}}))
}

/// Split a raw query string into (sessionId, paths). Percent-decodes values.
fn parse_meta_query(raw: &str) -> (String, Vec<String>) {
    let mut session_id = String::new();
    let mut paths: Vec<String> = Vec::new();
    for pair in raw.split('&') {
        let mut kv = pair.splitn(2, '=');
        let k = kv.next().unwrap_or_default();
        let v = kv.next().unwrap_or_default();
        let val = percent_decode(v);
        match k {
            "sessionId" => session_id = val,
            "paths" => paths.push(val),
            _ => {}
        }
    }
    (session_id, paths)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// GET /web/chat/attachment/list
pub async fn list(
    State(state): State<Arc<AppState>>,
    Query(q): Query<SessionQuery>,
) -> Json<serde_json::Value> {
    if q.session_id.is_empty() || !crate::session::SessionStore::is_valid_id(&q.session_id) {
        return Json(serde_json::json!({"code": 400, "description": "sessionId is required"}));
    }
    let session_dir = super::store_for(&state, &q.session_id).session_dir_pub(&q.session_id);
    let items = attachments::list_attachments(&session_dir);
    let total = items.len();
    Json(serde_json::json!({
        "code": 200,
        "data": {
            "sessionId": q.session_id,
            "items": items,
            "total": total,
        }
    }))
}

#[derive(serde::Deserialize, Default)]
pub struct SessionQuery {
    #[serde(rename = "sessionId", default)]
    pub session_id: String,
}
