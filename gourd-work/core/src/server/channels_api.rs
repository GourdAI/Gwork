//! IM channel HTTP endpoints (wechat/feishu/dingtalk + /chat/channel/*).
//!
//! v1 implements the binding/status contract and credential persistence.
//! Live transports (WeChat polling, Feishu/DingTalk WS streams) are started
//! by the channel runner tasks when credentials are present.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::{Form, Json};

use super::AppState;
use crate::channels::{CredentialStore, RoutingTable};

#[derive(serde::Deserialize, Default)]
pub struct ChannelSessionQuery {
    #[serde(rename = "sessionId", default)]
    pub session_id: String,
}

fn valid_session(id: &str) -> bool {
    !id.is_empty() && !id.contains("..") && !id.contains('/') && !id.contains('\\')
}

// ─── WeChat ───────────────────────────────────────────────────────────────────

/// GET /web/chat/wechat/qrcode — start QR binding (returns a QR url).
pub async fn wechat_qrcode(Query(q): Query<ChannelSessionQuery>) -> Json<serde_json::Value> {
    if !valid_session(&q.session_id) {
        return Json(serde_json::json!({"code": 400, "description": "sessionId is required"}));
    }
    // v1: return a placeholder QR endpoint. Real binding requires the ilinkai
    // service; the runner performs the actual handshake when reachable.
    let qrcode = format!("gwork-wechat-{}", uuid::Uuid::new_v4());
    Json(serde_json::json!({
        "code": 200,
        "data": {
            "qrcode": qrcode,
            "qrcode_img_content": "",
            "sessionId": q.session_id,
        }
    }))
}

/// GET /web/chat/wechat/qrcode/status — poll QR binding status.
pub async fn wechat_qrcode_status(Query(q): Query<WechatStatusQuery>) -> Json<serde_json::Value> {
    let store = CredentialStore::new("wechat-bindings.json");
    let bound = store.get(&q.session_id).is_some();
    Json(serde_json::json!({
        "code": 200,
        "data": {
            "status": if bound { "confirmed" } else { "waiting" },
            "sessionId": q.session_id,
        }
    }))
}

#[derive(serde::Deserialize, Default)]
pub struct WechatStatusQuery {
    #[serde(rename = "sessionId", default)]
    pub session_id: String,
    #[serde(default)]
    pub qrcode: String,
}

/// POST /web/chat/wechat/unbind
pub async fn wechat_unbind(Form(form): Form<ChannelSessionQuery>) -> Json<serde_json::Value> {
    let store = CredentialStore::new("wechat-bindings.json");
    store.remove(&form.session_id);
    let mut routing = RoutingTable::load();
    routing.remove_channel("wechat");
    Json(serde_json::json!({"code": 200}))
}

/// GET /web/chat/wechat/status
pub async fn wechat_status(Query(q): Query<ChannelSessionQuery>) -> Json<serde_json::Value> {
    let store = CredentialStore::new("wechat-bindings.json");
    let bound = store.get(&q.session_id).is_some();
    Json(serde_json::json!({"code": 200, "data": {"bound": bound}}))
}

// ─── Feishu ───────────────────────────────────────────────────────────────────

#[derive(serde::Deserialize, Default)]
pub struct FeishuBindForm {
    #[serde(rename = "sessionId", default)]
    pub session_id: String,
    #[serde(rename = "appId", default)]
    pub app_id: String,
    #[serde(rename = "appSecret", default)]
    pub app_secret: String,
}

/// POST /web/chat/feishu/bind
pub async fn feishu_bind(Form(form): Form<FeishuBindForm>) -> Json<serde_json::Value> {
    if !valid_session(&form.session_id) {
        return Json(serde_json::json!({"code": 400, "description": "sessionId is required"}));
    }
    if form.app_id.is_empty() || form.app_secret.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "appId and appSecret are required"}));
    }
    let store = CredentialStore::new("feishu-bindings.json");
    store.set(&form.session_id, serde_json::json!({
        "appId": form.app_id,
        "appSecret": form.app_secret,
        "openId": "",
    }));
    Json(serde_json::json!({"code": 200, "data": {"bound": true}}))
}

/// POST /web/chat/feishu/unbind
pub async fn feishu_unbind(Form(form): Form<ChannelSessionQuery>) -> Json<serde_json::Value> {
    let store = CredentialStore::new("feishu-bindings.json");
    store.remove(&form.session_id);
    Json(serde_json::json!({"code": 200}))
}

/// GET /web/chat/feishu/status
pub async fn feishu_status(Query(q): Query<ChannelSessionQuery>) -> Json<serde_json::Value> {
    let store = CredentialStore::new("feishu-bindings.json");
    let binding = store.get(&q.session_id);
    let bound = binding.as_ref().map(|b| !b["openId"].as_str().unwrap_or("").is_empty()).unwrap_or(false);
    let stream_started = binding.is_some();
    Json(serde_json::json!({
        "code": 200,
        "data": {
            "bound": bound,
            "streamStarted": stream_started,
            "pending": stream_started && !bound,
        }
    }))
}

// ─── DingTalk ─────────────────────────────────────────────────────────────────

#[derive(serde::Deserialize, Default)]
pub struct DingtalkBindForm {
    #[serde(rename = "sessionId", default)]
    pub session_id: String,
    #[serde(rename = "appKey", default)]
    pub app_key: String,
    #[serde(rename = "appSecret", default)]
    pub app_secret: String,
}

/// POST /web/chat/dingtalk/bind
pub async fn dingtalk_bind(Form(form): Form<DingtalkBindForm>) -> Json<serde_json::Value> {
    if !valid_session(&form.session_id) {
        return Json(serde_json::json!({"code": 400, "description": "sessionId is required"}));
    }
    if form.app_key.is_empty() || form.app_secret.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "appKey and appSecret are required"}));
    }
    let store = CredentialStore::new("dingtalk-bindings.json");
    store.set(&form.session_id, serde_json::json!({
        "appKey": form.app_key,
        "appSecret": form.app_secret,
        "userId": "",
        "robotCode": form.app_key,
    }));
    Json(serde_json::json!({"code": 200, "data": {"bound": true}}))
}

/// POST /web/chat/dingtalk/unbind
pub async fn dingtalk_unbind(Form(form): Form<ChannelSessionQuery>) -> Json<serde_json::Value> {
    let store = CredentialStore::new("dingtalk-bindings.json");
    store.remove(&form.session_id);
    Json(serde_json::json!({"code": 200}))
}

/// GET /web/chat/dingtalk/status
pub async fn dingtalk_status(Query(q): Query<ChannelSessionQuery>) -> Json<serde_json::Value> {
    let store = CredentialStore::new("dingtalk-bindings.json");
    let binding = store.get(&q.session_id);
    let bound = binding.as_ref().map(|b| !b["userId"].as_str().unwrap_or("").is_empty()).unwrap_or(false);
    let stream_started = binding.is_some();
    Json(serde_json::json!({
        "code": 200,
        "data": {
            "bound": bound,
            "streamStarted": stream_started,
            "pending": stream_started && !bound,
        }
    }))
}

// ─── Global channel status / routing / sessions ──────────────────────────────

/// GET /chat/channel/status
pub async fn channel_status() -> Json<serde_json::Value> {
    let routing = RoutingTable::load();
    let mut data = serde_json::Map::new();
    for channel in ["wechat", "feishu", "dingtalk"] {
        let route = routing.get_active_route(channel);
        data.insert(channel.to_string(), serde_json::json!({
            "connected": route.is_some(),
            "activeSessionId": route.map(|r| r.active_session_id.clone()),
            "activeProjectRoot": route.and_then(|r| r.project_root.clone()),
        }));
    }
    Json(serde_json::json!({"code": 200, "data": data}))
}

/// GET /chat/channel/sessions — list selectable sessions.
pub async fn channel_sessions(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let sessions = state.session_store.list_sessions();
    let items: Vec<serde_json::Value> = sessions
        .iter()
        .map(|s| {
            serde_json::json!({
                "sessionId": s.id,
                "label": s.title,
            })
        })
        .collect();
    Json(serde_json::json!({"code": 200, "data": items}))
}

#[derive(serde::Deserialize, Default)]
pub struct RoutingForm {
    #[serde(default)]
    pub channel: String,
    #[serde(rename = "sessionId", default)]
    pub session_id: String,
    #[serde(rename = "projectRoot", default)]
    pub project_root: Option<String>,
}

/// POST /chat/channel/routing — switch a channel's active session.
pub async fn channel_routing(Form(form): Form<RoutingForm>) -> Json<serde_json::Value> {
    if form.channel.is_empty() || form.session_id.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "channel and sessionId are required"}));
    }
    let mut routing = RoutingTable::load();
    routing.set_active_session(&form.channel, &form.session_id, form.project_root);
    Json(serde_json::json!({"code": 200}))
}
