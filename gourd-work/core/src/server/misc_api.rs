//! Message queue + steer + rewind + replay/full + tool-usage endpoints.

use std::sync::Arc;

use axum::extract::{Query, RawForm, State};
use axum::{Form, Json};

use super::{bind_session_cwd, AppState};

#[derive(serde::Deserialize, Default)]
pub struct SessionQuery {
    #[serde(rename = "sessionId", default)]
    pub session_id: String,
}

fn valid_session(id: &str) -> bool {
    !id.is_empty() && !id.contains("..") && !id.contains('/') && !id.contains('\\')
}

/// Resolve the on-disk session directory for the queue file, honouring the
/// `X-Session-Cwd` header exactly like every other session-scoped endpoint.
///
/// The queue lives at `<sessionDir>/queue.json` (Java `QueueFileHelper`), and the
/// session directory depends on the project binding: a project session's queue is
/// under `<projectRoot>/.gwork/sessions/<sid>/`, a global one under
/// `~/.gwork/sessions/<sid>/`. Resolving through `bind_session_cwd` keeps the two
/// kernels reading and writing the *same* file, so a message queued by one is
/// visible to the other (the frontend explicitly supports that cross-instance
/// case). Skipping the header would silently split the queue across two files.
fn queue_dir(state: &AppState, session_id: &str, headers: &axum::http::HeaderMap) -> std::path::PathBuf {
    let cwd = headers
        .get("x-session-cwd")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let store = bind_session_cwd(state, session_id, cwd.as_deref());
    store.session_dir_pub(session_id)
}

/// GET /web/chat/queue
///
/// Returns `{items:[…], size:N}` — the frontend reads `resp.data.items`
/// (`message-queue.js:_fetchQueue`). An earlier port returned the bare array
/// under `data`, so `data.items` was `undefined` and the queue badge stayed at 0
/// no matter how many messages were pending.
pub async fn queue_list(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Query(q): Query<SessionQuery>,
) -> Json<serde_json::Value> {
    if !valid_session(&q.session_id) {
        return Json(serde_json::json!({"code": 400, "description": "Invalid sessionId"}));
    }
    let dir = queue_dir(&state, &q.session_id, &headers);
    let items = state.queue_manager.list(&dir);
    Json(serde_json::json!({
        "code": 200,
        "data": { "items": items, "size": items.len() }
    }))
}

/// Body of `POST /web/chat/queue/add`.
///
/// JSON with **array** attachment fields, matching the Java kernel and the
/// frontend (`message-queue.js` sends `{sessionId, content, imagePaths:[],
/// filePaths:[]}`). Two contract details that a form-shaped port gets wrong:
///   - the text field is `content`, not `text`;
///   - the paths are JSON arrays, not comma-separated strings.
#[derive(serde::Deserialize, Default)]
#[serde(default)]
pub struct QueueAddBody {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub content: String,
    #[serde(rename = "imagePaths")]
    pub image_paths: Vec<String>,
    #[serde(rename = "filePaths")]
    pub file_paths: Vec<String>,
}

/// POST /web/chat/queue/add
///
/// Responds with `data.size` (the new queue length) — the frontend reads exactly
/// that key (`resp.data.size`), so returning `queueLength` here would make the
/// badge silently stay at 0.
pub async fn queue_add(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<QueueAddBody>,
) -> Json<serde_json::Value> {
    if !valid_session(&body.session_id) {
        return Json(serde_json::json!({"code": 400, "description": "Invalid sessionId"}));
    }
    let dir = queue_dir(&state, &body.session_id, &headers);
    let len = state.queue_manager.add(
        &dir,
        body.content,
        clean_list(body.image_paths),
        clean_list(body.file_paths),
        None,
    );
    Json(serde_json::json!({"code": 200, "data": {"size": len}}))
}

/// Trim and drop empty entries from a submitted path list.
fn clean_list(v: Vec<String>) -> Vec<String> {
    v.into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// POST /web/chat/queue/shift
///
/// Returns `{item:{content,imagePaths,filePaths,timestamp}}` or `{item:null}`.
/// The frontend reads `resp.data.item` and then `item.content` verbatim
/// (`message-queue.js:shift`); returning the message directly under `data` (as an
/// earlier port did) made `data.item` undefined, so `processMessageQueue` saw an
/// empty queue and never dispatched a single pending message.
pub async fn queue_shift(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Form(form): Form<SessionQuery>,
) -> Json<serde_json::Value> {
    if !valid_session(&form.session_id) {
        return Json(serde_json::json!({"code": 400, "description": "Invalid sessionId"}));
    }
    let dir = queue_dir(&state, &form.session_id, &headers);
    match state.queue_manager.shift(&dir) {
        Some(msg) => Json(serde_json::json!({"code": 200, "data": {"item": msg}})),
        None => Json(serde_json::json!({"code": 200, "data": {"item": null}})),
    }
}

/// POST /web/chat/queue/clear
pub async fn queue_clear(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Form(form): Form<SessionQuery>,
) -> Json<serde_json::Value> {
    if !valid_session(&form.session_id) {
        return Json(serde_json::json!({"code": 400, "description": "Invalid sessionId"}));
    }
    let dir = queue_dir(&state, &form.session_id, &headers);
    state.queue_manager.clear(&dir);
    Json(serde_json::json!({"code": 200, "data": {"cleared": true}}))
}

/// Steer text-length ceiling, matching Java `SteerInterceptor.MAX_TEXT_LENGTH`.
/// Code-point count, not bytes — the Java side uses `codePointCount`, so a CJK
/// interjection of 4096 characters must be accepted, not rejected for being
/// 12 KB of UTF-8.
const MAX_STEER_TEXT: usize = 4096;

/// POST /web/chat/steer — accept an interjection for a running turn.
///
/// ## Honest scope of this kernel
///
/// The Java kernel injects a steer into the *live* turn's working memory at the
/// next REASON step (`SteerInterceptor` + `SteerRunState.pending`). This kernel
/// reaches the same safe boundary — the top of a reasoning step in
/// `react::run_inner`, the one point where new user input can enter a live turn
/// without breaking tool-call pairing — and drains `queue.json` there.
///
/// Two contract details ride on that drain and are easy to lose:
///
/// 1. The drain **must** emit `Frame::steer_applied` with the drained items. The
///    frontend renders an interjection bubble *only* from that frame
///    (`appendSteerNote` is reached through the `steer_applied` branch of
///    `onWebChunk` / `replayChunk`); injecting the text into the model's context
///    without it makes the user's interjection invisible, which is precisely how
///    this endpoint once read as "steer does nothing".
/// 2. `text` in the frame is the raw interjection, with attachment paths in their
///    own fields — not `queued_message_text`, whose `[用户附带图片: …]` suffix is
///    LLM-facing and would double-render next to the frontend's real tiles.
///
/// An interjection still pending when the run ends is settled explicitly and never
/// left silent, and which frame it gets depends on how the run ended:
///
/// * the run finished, or stopped on its turn budget → `steer_dropped`, and the
///   item **stays** in `queue.json` for `processMessageQueue` to dispatch as the
///   next turn (it takes effect then rather than in the running one);
/// * the user pressed Stop → `steer_cancelled`, and the item is removed, because
///   replaying input the user just abandoned is not "nothing is lost".
///
/// Either frame goes out **before** the run's `done`, since `done` is what makes
/// the frontend read the queue.
///
/// Plain queued messages — an `add` with no `steerId` — are never consumed by the
/// drain (`shift_steer` selects on the id). They belong to the frontend's own send
/// path; swallowing them is what made a typed message reach the model while the
/// screen stayed blank.
///
/// ## Two contract details a naive port gets wrong
///
/// 1. **Attachments.** The frontend posts `imagePaths`/`filePaths` as *repeated
///    urlencoded keys* (`traditional:true` → `imagePaths=a&imagePaths=b`).
///    `serde_urlencoded` cannot build a `Vec` from repeated keys, so a
///    `Form<SteerForm>` port silently drops every attachment — the user's
///    just-uploaded image vanishes. We parse the raw body with
///    `url::form_urlencoded` and collect all values per key instead.
/// 2. **Idempotency.** `steerId` de-duplicates a retried interjection (Java
///    returns `duplicate`); we pass it as the queue item's `originSteerId` so a
///    second POST with the same id does not enqueue a second copy.
pub async fn steer(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    RawForm(body): RawForm,
) -> Json<serde_json::Value> {
    // Collect repeated keys: last-wins for scalars, append-all for the path lists.
    let mut session_id = String::new();
    let mut steer_id = String::new();
    let mut text = String::new();
    let mut image_paths: Vec<String> = Vec::new();
    let mut file_paths: Vec<String> = Vec::new();
    for (k, v) in url::form_urlencoded::parse(body.as_ref()) {
        match k.as_ref() {
            "sessionId" => session_id = v.into_owned(),
            "steerId" => steer_id = v.into_owned(),
            "text" => text = v.into_owned(),
            "imagePaths" => image_paths.push(v.into_owned()),
            "filePaths" => file_paths.push(v.into_owned()),
            _ => {}
        }
    }

    if !valid_session(&session_id) {
        return Json(serde_json::json!({"code": 400, "description": "Invalid sessionId"}));
    }
    let image_paths = clean_list(image_paths);
    let file_paths = clean_list(file_paths);
    let has_attachments = !image_paths.is_empty() || !file_paths.is_empty();
    // A pure-attachment interjection (image, no text) is legal — same rule as the
    // main send path. Reject only when there is nothing at all to deliver.
    if text.trim().is_empty() && !has_attachments {
        return Json(serde_json::json!({"code": 400, "description": "EMPTY_TEXT"}));
    }
    if text.chars().count() > MAX_STEER_TEXT {
        return Json(serde_json::json!({"code": 400, "description": "TEXT_TOO_LONG"}));
    }
    if steer_id.trim().is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "MISSING_STEER_ID"}));
    }

    // Not running → nothing to interject into; tell the frontend so it degrades
    // to its own queue path (Java returns the same `not_running`).
    if !state.is_busy(&session_id).await {
        return Json(serde_json::json!({"code": 200, "data": {"status": "not_running"}}));
    }

    let dir = queue_dir(&state, &session_id, &headers);
    let before = state.queue_manager.list(&dir).len();
    state.queue_manager.add(
        &dir,
        text,
        image_paths,
        file_paths,
        Some(steer_id),
    );
    let after = state.queue_manager.list(&dir).len();
    // Length unchanged ⇒ an item with this steerId was already queued ⇒ duplicate.
    let status = if after == before { "duplicate" } else { "accepted" };
    Json(serde_json::json!({"code": 200, "data": {"status": status}}))
}

#[derive(serde::Deserialize, Default)]
pub struct RewindQuery {
    #[serde(rename = "sessionId", default)]
    pub session_id: String,
    #[serde(default)]
    pub count: usize,
}

/// POST /web/chat/rewind — remove the last N message pairs.
pub async fn rewind(State(state): State<Arc<AppState>>, Form(form): Form<RewindQuery>) -> Json<serde_json::Value> {
    if !valid_session(&form.session_id) {
        return Json(serde_json::json!({"code": 400, "description": "Invalid sessionId"}));
    }
    let removed = super::store_for(&state, &form.session_id).rewind(&form.session_id, form.count.max(1));
    Json(serde_json::json!({"code": 200, "data": {"removed": removed}}))
}

#[derive(serde::Deserialize, Default)]
pub struct ReplayFullQuery {
    #[serde(rename = "sessionId", default)]
    pub session_id: String,
    #[serde(default)]
    pub seq: i64,
}

/// GET /web/chat/replay/full — replay frames from a given seq.
pub async fn replay_full(State(state): State<Arc<AppState>>, Query(q): Query<ReplayFullQuery>) -> Json<serde_json::Value> {
    if !valid_session(&q.session_id) {
        return Json(serde_json::json!({"code": 400, "description": "Invalid sessionId"}));
    }
    // Stream only the tail from `seq` onward — never materialise the whole
    // stream (an 84 MB session would otherwise be fully parsed to keep a few
    // frames). See `SessionStore::load_stream_frames_from_seq`.
    let store = super::store_for(&state, &q.session_id);
    let filtered = store.load_stream_frames_from_seq(&q.session_id, q.seq);
    Json(serde_json::json!({"code": 200, "data": {"frames": filtered}}))
}

/// GET /web/chat/session/tool-usage — memory & skill usage for a session.
///
/// Java kernel contract (`WebController.sessionToolUsage` →
/// `SessionToolUsageService.usage`), which the shared frontend
/// (`app-task-monitor.js` `renderSkills`/`renderMemory`) reads field-by-field:
///
/// ```json
/// { "sessionId": ..., "exists": bool,
///   "memory": {"updated","extractCount","totalCount","names"},
///   "skills": [{"name","toolName","count","displayName"?}],
///   "skillCount": 0, "toolCallCount": 0 }
/// ```
///
/// The previous port returned a bare `[{tool,count}]` array, so `data.skills`
/// and `data.memory` were always `undefined` and the monitor panel showed the
/// empty state even in sessions full of `skillread`/`memory_extract` calls —
/// the reported "技能调用了但右侧没统计". Both kernels share the same frontend,
/// so the shape must match Java's exactly.
///
/// `root` is honoured like every other session-scoped endpoint (the frontend
/// sends the project root; a session bound to a project lives under it):
/// without the binding, a workspace session would be read from the global
/// area and the panel would silently show empty.
#[derive(serde::Deserialize, Default)]
pub struct ToolUsageQuery {
    #[serde(rename = "sessionId", default)]
    pub session_id: String,
    #[serde(default)]
    pub root: String,
}

pub async fn tool_usage(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Query(q): Query<ToolUsageQuery>,
) -> Json<serde_json::Value> {
    if !valid_session(&q.session_id) {
        return Json(serde_json::json!({"code": 400, "description": "Invalid sessionId"}));
    }
    // Route to the session's owning store: the `root` query param is the
    // project root the frontend resolved (same value as `X-Session-Cwd`).
    // Prefer the explicit param, fall back to the header, then the existing
    // binding — mirroring `resolveSessionRoot` in the Java endpoint.
    let root_param = q.root.trim().to_string();
    let header_root = headers
        .get("x-session-cwd")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let cwd = if !root_param.is_empty() {
        Some(root_param)
    } else {
        header_root
    };
    let store = super::bind_session_cwd(&state, &q.session_id, cwd.as_deref());

    let (exists, memory) = store.memory_usage(&q.session_id);
    let skills = store.skill_usage(&q.session_id);

    // Total tool calls (all tools, not just memory/skills): the stream scan
    // for skills also gives us this cheaply — but keep the scans separate and
    // honest: one aggregate pass over action_start rows would be cleaner, yet
    // the two scans are substring-prefiltered and never materialise frames.
    // `toolCallCount` mirrors the total in Java's response; the monitor panel
    // does not display it today but the contract keeps the field.
    let tool_call_count = store.tool_call_total(&q.session_id);

    // Display names: same registry + same resolution as the skills settings
    // page (`settings_api::skills_installed` → `display_name_of`), so the
    // monitor row and the skill card can never show two different names for
    // one skill. Registry scoped to the session's workspace when one is
    // bound, global otherwise.
    let ws_root = state.session_roots.bound_root(&q.session_id);
    let registry = match ws_root.as_deref() {
        Some(root) => crate::skills::SkillRegistry::with_workspace(std::path::Path::new(root)),
        None => crate::skills::SkillRegistry::new(),
    };
    let display_names: std::collections::HashMap<String, String> = registry
        .load_all()
        .iter()
        .filter_map(|s| {
            crate::skills::display_name_of(s.market.as_ref()).map(|dn| (s.name.clone(), dn))
        })
        .collect();

    let rows = skills.sorted_rows();
    let skill_rows: Vec<serde_json::Value> = rows
        .iter()
        .map(|(name, tool, count)| {
            let mut row = serde_json::json!({
                "name": name,
                "toolName": tool,
                "count": count,
            });
            if let Some(dn) = display_names.get(name) {
                if !dn.trim().is_empty() {
                    row["displayName"] = serde_json::json!(dn.trim());
                }
            }
            row
        })
        .collect();
    let skill_count: u64 = rows.iter().map(|(_, _, c)| c).sum();

    Json(serde_json::json!({
        "code": 200,
        "data": {
            "sessionId": q.session_id,
            "exists": exists,
            "memory": {
                "updated": memory.extract_count > 0,
                "extractCount": memory.extract_count,
                "totalCount": memory.total_count,
                "names": memory.names,
            },
            "skills": skill_rows,
            "skillCount": skill_count,
            "toolCallCount": tool_call_count,
        }
    }))
}
