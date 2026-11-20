//! server::mcp_runtime_api — stdio 运行时（uv/Node）检测与代装的 3 个 handler。
//!
//! | Method | Path                                        | 用途 |
//! |--------|---------------------------------------------|------|
//! | GET    | `/web/settings/mcp/runtime/check?command=`  | 命令可解析？缺哪个运行时？可代装？ |
//! | POST   | `/web/settings/mcp/runtime/install`         | 启动代装（幂等，返回会话快照）|
//! | GET    | `/web/settings/mcp/runtime/status?runtime=` | 轮询下载/解压进度与结果 |
//!
//! 交互契约（用户二次拍板「不要提示报错，缺少环境就静默安装，只是交互上
//! 提示用户在下载运行环境，不要再让用户确认点击；运行环境安装完成，整个
//! 连接器才安装完成」）：前端发现缺运行时时弹「正在下载运行环境」进度弹窗，
//! 弹窗挂载即 POST install（零确认点击）；进度条走 status 轮询；done 后
//! 前端自动重连连接器并核实结果，全部成功才报安装完成。交互必须可见，
//! 但安装本身不需要用户确认。
//!
//! 响应统一 `{code:200,description:"",data:{...}}` / `{code:400,description}`，
//! 与 mcp_market_api 同信封。

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use super::AppState;
use crate::mcp::market;
use crate::mcp::runtime::RuntimeId;

#[derive(Debug, Default, Deserialize)]
pub struct CheckParams {
    #[serde(default)]
    pub command: String,
}

/// GET /web/settings/mcp/runtime/check?command=uvx
pub async fn mcp_runtime_check(Query(q): Query<CheckParams>) -> Json<Value> {
    let command = q.command.trim();
    if command.is_empty() {
        return Json(market::failure("command is required"));
    }
    Json(market::succeed(crate::mcp::runtime::RuntimeInstaller::check(command)))
}

#[derive(Debug, Default, Deserialize)]
pub struct InstallBody {
    #[serde(default)]
    pub runtime: String,
}

/// POST /web/settings/mcp/runtime/install {runtime:"uv"|"node"}
pub async fn mcp_runtime_install(
    State(state): State<Arc<AppState>>,
    Json(body): Json<InstallBody>,
) -> Json<Value> {
    let Some(id) = RuntimeId::parse(&body.runtime) else {
        return Json(market::failure(format!(
            "不支持自动安装的运行时: {}（支持 uv / node）",
            body.runtime
        )));
    };
    match state.mcp_runtime.start(id).await {
        Ok(status) => Json(market::succeed(
            serde_json::to_value(status).unwrap_or_else(|_| json!({})),
        )),
        Err(e) => Json(market::failure(e)),
    }
}

#[derive(Debug, Default, Deserialize)]
pub struct StatusParams {
    #[serde(default)]
    pub runtime: String,
}

/// GET /web/settings/mcp/runtime/status?runtime=uv
pub async fn mcp_runtime_status(
    State(state): State<Arc<AppState>>,
    Query(q): Query<StatusParams>,
) -> Json<Value> {
    let Some(id) = RuntimeId::parse(&q.runtime) else {
        return Json(market::failure(format!("未知运行时: {}", q.runtime)));
    };
    let status = state.mcp_runtime.status(id).await;
    Json(market::succeed(
        serde_json::to_value(status).unwrap_or_else(|_| json!({})),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn check_requires_command() {
        let resp = mcp_runtime_check(Query(CheckParams { command: " ".into() })).await.0;
        assert_eq!(resp["code"], json!(400));
    }

    #[tokio::test]
    async fn check_uvx_shape() {
        let resp = mcp_runtime_check(Query(CheckParams { command: "uvx".into() })).await.0;
        assert_eq!(resp["code"], json!(200));
        assert_eq!(resp["data"]["runtime"], json!("uv"));
        assert!(resp["data"]["resolved"].is_boolean());
        assert!(resp["data"]["installable"].is_boolean());
    }

    #[tokio::test]
    async fn install_rejects_unknown_runtime_without_download() {
        // 无 AppState 也能验证拒绝路径：parse 失败在触达 state 之前。
        // （构造完整 AppState 需要 engine/session 等重资源，拒绝路径单测
        //   直接钉 RuntimeId::parse 的白名单行为即可。）
        assert!(RuntimeId::parse("python").is_none());
        assert!(RuntimeId::parse("docker").is_none());
        assert!(RuntimeId::parse("").is_none());
    }
}