//! CLI 连接器 + Node 运行时的 HTTP 端点（契约见 .gwork/PLAN-connector-registry.md 第七节）。
//!
//! 信封与 mcp_market_api 同口径（code:200 / description / data）。
//! 所有带 id 的 handler 先过 `canonical_id` 规范化（旧 `featured:` 别名并入官方
//! id），否则同一连接器会生成两个 map key，绕过 mcp::cli 的 per-id 单飞；
//! 写操作单飞由 mcp::cli / runtime::node 内部保证，Node 状态不下发绝对路径。

use axum::extract::Query;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

fn succeed(data: Value) -> Value {
    json!({"code": 200, "description": "", "data": data})
}
fn failure(msg: impl Into<String>) -> Value {
    json!({"code": 400, "description": msg.into(), "data": Value::Null})
}

/// 统一规范化 id：`featured:X` → `official:X`，其余原样（含 trim）。
fn norm_id(raw: &str) -> String {
    crate::mcp::registry::canonical_id(raw.trim())
}

/// Node 状态信封：脱敏掉内部绝对路径 `nodePath`（前端不渲染，也不该下发）。
fn node_envelope(s: crate::runtime::node::NodeStatus) -> Json<Value> {
    let mut data = serde_json::to_value(s).unwrap_or(Value::Null);
    let _ = data.as_object_mut().map(|o| o.remove("nodePath"));
    Json(succeed(data))
}

#[derive(Deserialize)]
pub struct IdParams {
    #[serde(default)]
    pub id: String,
}

// ─── Node 运行时 ─────────────────────────────────────────────────────────────

/// GET /web/settings/runtime/node — 当前状态（不触发 IO）。
pub async fn node_status() -> Json<Value> {
    node_envelope(crate::runtime::node::status())
}

/// POST /web/settings/runtime/node/ensure — 触发探测/下载，立即返回当前状态。
pub async fn node_ensure() -> Json<Value> {
    node_envelope(crate::runtime::node::ensure())
}

// ─── CLI 连接器 ──────────────────────────────────────────────────────────────

/// POST /web/settings/mcp/cli/install {id}
pub async fn cli_install(Json(p): Json<IdParams>) -> Json<Value> {
    let id = norm_id(&p.id);
    if id.is_empty() {
        return Json(failure("id is required"));
    }
    if !crate::mcp::registry::is_official_id(&id) {
        return Json(failure("仅官方目录支持 CLI 连接器"));
    }
    let st = crate::mcp::cli::start_install(&id);
    Json(succeed(serde_json::to_value(st).unwrap_or(Value::Null)))
}

/// GET /web/settings/mcp/cli/install/status?id=
pub async fn cli_install_status(Query(p): Query<IdParams>) -> Json<Value> {
    let id = norm_id(&p.id);
    if id.is_empty() {
        return Json(failure("id is required"));
    }
    Json(succeed(serde_json::to_value(crate::mcp::cli::install_state(&id)).unwrap_or(Value::Null)))
}

/// GET /web/settings/mcp/cli/state?id= — installed/authorized/nodeReady。
pub async fn cli_state(Query(p): Query<IdParams>) -> Json<Value> {
    let id = norm_id(&p.id);
    if id.is_empty() {
        return Json(failure("id is required"));
    }
    Json(succeed(crate::mcp::cli::cli_state(&id).await))
}

/// POST /web/settings/mcp/cli/auth/start {id}
pub async fn cli_auth_start(Json(p): Json<IdParams>) -> Json<Value> {
    let id = norm_id(&p.id);
    if id.is_empty() {
        return Json(failure("id is required"));
    }
    let st = crate::mcp::cli::start_auth(&id);
    Json(succeed(serde_json::to_value(st).unwrap_or(Value::Null)))
}

/// GET /web/settings/mcp/cli/auth/status?id=
pub async fn cli_auth_status(Query(p): Query<IdParams>) -> Json<Value> {
    let id = norm_id(&p.id);
    if id.is_empty() {
        return Json(failure("id is required"));
    }
    Json(succeed(serde_json::to_value(crate::mcp::cli::auth_state(&id)).unwrap_or(Value::Null)))
}

/// POST /web/settings/mcp/cli/auth/cancel {id}
pub async fn cli_auth_cancel(Json(p): Json<IdParams>) -> Json<Value> {
    let id = norm_id(&p.id);
    if id.is_empty() {
        return Json(failure("id is required"));
    }
    crate::mcp::cli::cancel_auth(&id);
    Json(succeed(json!({"cancelled": true})))
}

/// POST /web/settings/mcp/cli/uninstall {id} — 登出 + 移除技能（包缓存保留）。
pub async fn cli_uninstall(Json(p): Json<IdParams>) -> Json<Value> {
    let id = norm_id(&p.id);
    if id.is_empty() {
        return Json(failure("id is required"));
    }
    match crate::mcp::cli::uninstall(&id).await {
        // 约定：cli::uninstall 返回 Result<Value, String>，成功值带
        // uninstalled / loggedOut / 可选 warning，这里原样透传，不自行拼装。
        Ok(data) => Json(succeed(data)),
        Err(e) => Json(failure(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn empty_id_rejected_on_all_endpoints() {
        let p = IdParams { id: "  ".into() };
        assert_eq!(cli_install(Json(p)).await.0["code"], 400);
        let q = IdParams { id: String::new() };
        assert_eq!(cli_install_status(Query(q)).await.0["code"], 400);
        let q2 = IdParams { id: String::new() };
        assert_eq!(cli_state(Query(q2)).await.0["code"], 400);
        let p2 = IdParams { id: String::new() };
        assert_eq!(cli_auth_start(Json(p2)).await.0["code"], 400);
        let q3 = IdParams { id: String::new() };
        assert_eq!(cli_auth_status(Query(q3)).await.0["code"], 400);
        let p3 = IdParams { id: String::new() };
        assert_eq!(cli_auth_cancel(Json(p3)).await.0["code"], 400);
        let p4 = IdParams { id: String::new() };
        assert_eq!(cli_uninstall(Json(p4)).await.0["code"], 400);
    }

    #[tokio::test]
    async fn non_official_id_rejected_for_install() {
        let p = IdParams { id: "@some/mcp".into() };
        let r = cli_install(Json(p)).await.0;
        assert_eq!(r["code"], 400);
    }

    #[tokio::test]
    async fn node_status_envelope_shape() {
        let r = node_status().await.0;
        assert_eq!(r["code"], 200);
        assert!(r["data"]["status"].is_string());
        assert!(r["data"]["progress"].is_number());
    }

    /// C1：旧 featured: 别名与 official: 必须归一到同一 key（否则绕过 per-id 单飞）。
    #[test]
    fn norm_id_maps_legacy_featured_alias() {
        assert_eq!(norm_id("  featured:tencent-docs  "), "official:tencent-docs");
        assert_eq!(norm_id("official:tencent-docs"), "official:tencent-docs");
        assert_eq!(norm_id("  @some/mcp  "), "@some/mcp");
    }

    /// C1：规范化发生在「空 id 校验之后、调用 mcp::cli 之前」——
    /// 用未知 id 走 cli_install 的失败分支实证（无网络、无真实 ~/.gwork 写入）。
    /// 用**独立 id**：全局 INFLIGHT 是 per-id 单飞真源，若与其他测试的
    /// 未知 id 撞 key，并行跑会读到在途态 node 而非 failed（实测过）。
    #[tokio::test]
    async fn legacy_alias_reaches_official_install_path() {
        let p = IdParams { id: "featured:no-such-cli-alias-case".into() };
        let r = cli_install(Json(p)).await.0;
        assert_eq!(r["code"], 200);
        assert_eq!(r["data"]["phase"], "failed");
    }

    /// C2：Node 状态信封绝不携带 node.exe 绝对路径；status 等字段仍在。
    #[tokio::test]
    async fn node_envelope_strips_absolute_node_path() {
        // 直接构造结构体（NodeStatus::ready 是 runtime::node 的私有构造函数，
        // 但字段均为 pub；不改动任何 pub 签名）。
        let s = crate::runtime::node::NodeStatus {
            status: "ready".into(),
            source: Some("managed".into()),
            version: Some("v22.22.2".into()),
            progress: 100,
            error: None,
            node_path: Some("C:/Users/secret/.gwork/binaries/node/versions/22.22.2/node.exe".into()),
        };
        let r = node_envelope(s).0;
        assert_eq!(r["code"], 200);
        assert!(r["data"].get("nodePath").is_none(), "nodePath 必须脱敏");
        assert!(r["data"].get("node_path").is_none(), "下划线形态也不得出现");
        assert_eq!(r["data"]["status"], "ready");
        assert_eq!(r["data"]["source"], "managed");
        assert_eq!(r["data"]["version"], "v22.22.2");
        assert_eq!(r["data"]["progress"], 100);
        // 真实 status 端点同样脱敏（不触发任何 IO）。
        let live = node_status().await.0;
        assert!(live["data"].get("nodePath").is_none());
        assert!(live["data"]["status"].is_string());
    }

    #[tokio::test]
    async fn unknown_official_id_install_fails_cleanly() {
        let p = IdParams { id: "official:no-such-cli".into() };
        let r = cli_install(Json(p)).await.0;
        // 条目不存在时 start_install 同步置 failed（无后台任务）。
        assert_eq!(r["code"], 200);
        assert_eq!(r["data"]["phase"], "failed");
    }
}