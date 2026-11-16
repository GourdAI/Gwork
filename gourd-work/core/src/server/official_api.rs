//! `/web/settings/official/*` —— 官方源状态的只读 HTTP 投影。
//!
//! 契约 C 节：前端只能看到「是否登录 / 用户名 / 模型数量 / relay 地址 /
//! 模型 id 与 ownedBy」。内存里的凭据 key **绝不进入响应体**：这里所有
//! 响应都由字段白名单手工构造，不序列化 `official::OfficialCredential`。
//! `refresh` 也不主动发网络请求：壳重新拉取模型后会直接 `official::set`，
//! core 这个端点只返回当前缓存状态。

use axum::Json;
use serde_json::{json, Value};

use crate::official;

/// 统一的 `{code:200,data:...}` 包装，与 settings_api 的现有风格一致。
fn ok(data: Value) -> Json<Value> {
    Json(json!({ "code": 200, "data": data }))
}

fn status_value() -> Value {
    let (signed_in, username, model_count, base_url) = official::status();
    json!({
        "signedIn": signed_in,
        "username": username,
        "modelCount": model_count,
        "baseUrl": base_url,
    })
}

fn models_value() -> Value {
    let list: Vec<Value> = official::models()
        .iter()
        .map(|m| json!({ "id": m.id, "ownedBy": m.owned_by }))
        .collect();
    Value::Array(list)
}

fn refresh_value() -> Value {
    let (signed_in, _username, model_count, _base_url) = official::status();
    json!({
        "signedIn": signed_in,
        "modelCount": model_count,
    })
}

/// GET /web/settings/official/status
pub async fn official_status() -> Json<Value> {
    ok(status_value())
}

/// GET /web/settings/official/models
pub async fn official_models() -> Json<Value> {
    ok(models_value())
}

/// POST /web/settings/official/refresh
///
/// 只回当前缓存：刷新模型列表由壳通过 IPC 触发并 `official::set` 写回，
/// core 不主动访问 `/v1/models`。
pub async fn official_refresh() -> Json<Value> {
    ok(refresh_value())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::official::{OfficialCredential, OfficialModel, OFFICIAL_BASE_URL};

    const SECRET: &str = "OFFICIAL-KEY-MUST-NEVER-LEAK-0123456789abcdefghijkl";

    fn logged_in() -> OfficialCredential {
        OfficialCredential {
            key: SECRET.to_string(),
            base_url: OFFICIAL_BASE_URL.to_string(),
            user_id: 7,
            username: "bob".to_string(),
            models: vec![
                OfficialModel { id: "gwork-a".to_string(), owned_by: "gwork".to_string() },
                OfficialModel { id: "gwork-b".to_string(), owned_by: "openai".to_string() },
            ],
        }
    }

    /// The whole point of these endpoints: no credential field, no credential
    /// value, in ANY of the three response bodies.
    #[test]
    fn official_http_responses_never_contain_the_key() {
        let _guard = crate::official::test_lock();
        crate::official::reset_host_for_test();
        official::set(logged_in());

        let bodies = vec![
            tokio_test::block_on(official_status()).0,
            tokio_test::block_on(official_models()).0,
            tokio_test::block_on(official_refresh()).0,
        ];
        for body in &bodies {
            assert_eq!(body["code"], 200);
            let text = serde_json::to_string(body).unwrap();
            assert!(!text.contains(SECRET), "credential leaked into response: {text}");
            assert!(!text.contains("\"key\""), "a key field leaked into response: {text}");
            assert!(!text.contains("apiKey"), "an apiKey field leaked into response: {text}");
            assert!(body["data"].get("key").is_none());
        }

        let status = &bodies[0]["data"];
        assert_eq!(status["signedIn"], true);
        assert_eq!(status["username"], "bob");
        assert_eq!(status["modelCount"], 2);
        assert_eq!(status["baseUrl"], OFFICIAL_BASE_URL);
        assert_eq!(bodies[1]["data"][0], json!({"id": "gwork-a", "ownedBy": "gwork"}));
        assert_eq!(bodies[2]["data"], json!({"signedIn": true, "modelCount": 2}));

        official::clear();
    }

    #[test]
    fn official_status_reports_signed_out_with_no_credential() {
        let _guard = crate::official::test_lock();
        crate::official::reset_host_for_test();
        official::clear();

        let status = tokio_test::block_on(official_status()).0;
        assert_eq!(status["code"], 200);
        assert_eq!(status["data"]["signedIn"], false);
        assert_eq!(status["data"]["username"], "");
        assert_eq!(status["data"]["modelCount"], 0);
        assert_eq!(status["data"]["baseUrl"], OFFICIAL_BASE_URL);

        let models = tokio_test::block_on(official_models()).0;
        assert_eq!(models["data"], json!([]));
        let refresh = tokio_test::block_on(official_refresh()).0;
        assert_eq!(refresh["data"], json!({"signedIn": false, "modelCount": 0}));
    }
}
