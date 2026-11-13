//! server::mcp_market_api — 魔搭 ModelScope MCP 广场的 4 个 axum handler。
//!
//! | Method | Path                                      | 用途 |
//! |--------|-------------------------------------------|------|
//! | GET    | `/web/settings/mcp/market/servers`        | 列表 / 搜索 / 分类 / Hosted 筛选 |
//! | GET    | `/web/settings/mcp/market/detail?id=`     | 详情（server_config / env_schema / readme）|
//! | GET    | `/web/settings/mcp/market/categories`     | 内置静态分类表 |
//! | POST   | `/web/settings/mcp/market/install`        | 归一化 + 复用 mcp_server_add 落盘 |
//!
//! 响应统一 `{code:200,description:"",data:{...}}`；上游失败 → `{code:400,description:"..."}`,
//! 不伪造成功。install 不自己写 settings.json：它把上游 `server_config[0].mcpServers`
//! 归一化成 `settings_api::McpBody`，逐个调用 `settings_api::mcp_server_add`，从而与手动
//! 添加 MCP 共用同一份校验 / 去重 / 持久化 / 热插拔逻辑。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use super::settings_api::{mcp_server_add, sanitize_auth_decl, McpBody};
use super::AppState;
use crate::mcp::market::{
    self, ModelscopeMcpMarket, ReqwestMcpMarketHttp, ServerQuery,
};

fn market() -> ModelscopeMcpMarket<ReqwestMcpMarketHttp> {
    ModelscopeMcpMarket::new(ReqwestMcpMarketHttp::new())
}

/// 缺失或非法数字都给默认值，避免 axum Query 直接 400 绕过统一信封。
fn parse_i64(raw: Option<String>, default: i64) -> i64 {
    raw.and_then(|s| s.trim().parse::<i64>().ok()).unwrap_or(default)
}

fn parse_bool(raw: Option<String>) -> bool {
    matches!(raw.as_deref(), Some("1") | Some("true") | Some("yes") | Some("on"))
}

// ─── Query / body shapes ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ServersParams {
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub page: Option<String>,
    #[serde(rename = "pageSize", default)]
    pub page_size: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub hosted: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct DetailParams {
    #[serde(default)]
    pub id: String,
}

/// `env` 由前端详情弹窗按 `env_schema.required` 收集后透传。
#[derive(Debug, Clone, Deserialize, Default)]
pub struct InstallBody {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
}

// ─── Handlers ────────────────────────────────────────────────────────────────

pub async fn mcp_market_servers(Query(p): Query<ServersParams>) -> Json<Value> {
    let q = ServerQuery {
        search: p.search.unwrap_or_default(),
        page: parse_i64(p.page, 1),
        page_size: parse_i64(p.page_size, 20),
        category: p.category.unwrap_or_default(),
        hosted: parse_bool(p.hosted),
    };
    Json(match market().servers(&q).await {
        Ok(data) => market::succeed(data),
        Err(e) => market::failure(e),
    })
}

pub async fn mcp_market_detail(Query(p): Query<DetailParams>) -> Json<Value> {
    if p.id.trim().is_empty() {
        return Json(market::failure("id is required"));
    }
    Json(match market().detail(&p.id).await {
        Ok(mut data) => {
            // 注入 env_supported：告诉前端「这个服务填的环境变量能不能被存下来」。
            // 判据必须由内核给出（见下方 env_supported 的文档），前端只读标志。
            let supported = env_supported(&data);
            data["env_supported"] = Value::Bool(supported);
            market::succeed(data)
        }
        Err(e) => market::failure(e),
    })
}

/// 该服务的环境变量能否被持久化 —— 即「详情弹窗是否应该渲染 env 表单」。
///
/// # 为什么这个判据必须活在内核、而不是前端复刻
///
/// http 家族（`sse` / `streamable` / `streamable_stateless`）在 `build_entry` 里
/// 只落 `url` / `headers`，**没有 `env` 字段**；只有 stdio 存得下 env。
/// 若前端自己判类型，就必须复刻 `mcp::alias_map()` 那 20 多条别名
/// （`remote` / `ssehttp` / `streamablehttp` / `sse-http` …）——**必然漏**，
/// 而且历史上正是这么漏的：归一化曾硬编码过一份别名字符串白名单，漏掉
/// `remote` / `ssehttp` 且大小写敏感，上游写 `"SSE"` 时两个判定源分叉
/// （见 `normalize_server_config` 的同源注释）。所以这里直接调
/// `mcp::is_http_type`，与 install 侧的 `assert_http_has_no_env_schema`、
/// `normalize_server_config` **同一个真源**。
///
/// # 语义
///
/// * 任一 server 配置是 http 家族 → `false`（env 存不下，不该向用户索要）；
/// * 否则（全 stdio / 无 server_config / 无 type 字段）→ `true`。
///
/// 无 `server_config` 时返回 `true` 是有意的：那是上游数据残缺，此时让前端
/// 维持既有形态（按 env_schema 渲染）比一律禁掉表单更安全——
/// install 侧的 `resolve_env` 仍是最终防线，缺必填会明确报错，不会伪造成功。
pub fn env_supported(data: &Value) -> bool {
    let Some(servers) = data
        .get("server_config")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(|first| first.get("mcpServers"))
        .and_then(Value::as_object)
    else {
        return true;
    };
    for (_name, cfg) in servers {
        let raw_kind = cfg.get("type").and_then(Value::as_str).unwrap_or("").trim();
        if !raw_kind.is_empty() && crate::mcp::is_http_type(raw_kind) {
            return false;
        }
    }
    true
}

pub async fn mcp_market_categories() -> Json<Value> {
    Json(market::succeed(market().categories()))
}

/// `type` → 标准 kind，并在此处就校验合法性。
///
/// 不能直接写 `standardize(raw).ok_or_else(...)`：`standardize` 只在**空串**时返回
/// `None`，对未知的非空值**原样返回 `Some`**，所以那句 `ok_or_else` 是永不触发的
/// 死代码，未知 type 会一路传到 `build_entry` 才被英文「Unsupported type」拒绝。
/// 这里显式走 `is_valid`，让错误在归一化层就说清楚。
///
/// 空串按上游惯例视为 stdio（stdio 项通常不写 type，靠 command 兜底识别）。
fn standardize_kind(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    if t.is_empty() {
        return Ok(crate::mcp::TYPE_STDIO.to_string());
    }
    let kind = crate::mcp::standardize(t).unwrap_or_default();
    if !crate::mcp::is_valid(&kind) {
        return Err(format!("不支持的 MCP 类型: {}", t));
    }
    Ok(kind)
}

/// 上游 `server_config[0].mcpServers` → `Vec<(name, McpBody)>`。
///
/// 三种实测形态：
/// * stdio：`{"command":"uvx","args":["mcp-server-fetch"],"env":{...}}`
/// * sse / streamable_http：`{"type":"sse"|"streamable_http","url":"https://...","headers":{...}}`
///
/// 归一化后写入的字段与 `settings_api::build_entry` 产出的 settings.json 条目完全一致
/// （`type` / `scope` / `enabled` / command/args/env 或 url/headers），不另造配置格式。
pub fn normalize_server_config(
    data: &Value,
    supplied_env: Option<&HashMap<String, String>>,
) -> Result<Vec<(String, McpBody)>, String> {
    let first = data
        .get("server_config")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .ok_or_else(|| "魔搭 MCP 服务缺少 server_config，无法安装".to_string())?;
    let servers = first
        .get("mcpServers")
        .and_then(Value::as_object)
        .ok_or_else(|| "魔搭 MCP 服务缺少 mcpServers 配置".to_string())?;
    if servers.is_empty() {
        return Err("魔搭 MCP 服务的 mcpServers 为空".into());
    }
    // http 型配置存不下 env（build_entry 只写 url/headers），必须在**归一化的必经
    // 之路上**拦掉，而不是只依赖 install 里的提前调用：接线点可被误删，这里删不掉。
    assert_http_has_no_env_schema(data)?;

    let mut out = Vec::new();
    for (name, cfg) in servers {
        let mut body = McpBody {
            name: name.clone(),
            enabled: Some(true),
            scope: Some("user".into()),
            ..McpBody::default()
        };
        let raw_kind = cfg.get("type").and_then(Value::as_str).unwrap_or("").trim().to_string();
        // http 判定必须与 `assert_http_has_no_env_schema` **同源**（都走 `mcp::is_http_type`
        // → `standardize`，内含 to_lowercase 与完整 alias_map）。
        // 这里曾硬编码一份别名字符串白名单，漏掉 `remote` / `ssehttp` / `streamablehttp`
        // 且**大小写敏感**：上游写 `"SSE"` 时 guard 认定它是 http（放行、不索要密钥），
        // 归一化却把它当 stdio，于是以「既没有 command」安装失败——两个判定源分叉。
        let is_http = crate::mcp::is_http_type(&raw_kind);
        if is_http {
            body.kind = standardize_kind(&raw_kind)?;
            body.url = Some(cfg.get("url").and_then(Value::as_str).unwrap_or("").to_string());
            body.headers = json_map_to_hashmap(cfg.get("headers"));
            // 认证声明（非密钥）随目录条目一起落盘。没有它，从广场安装的连接器
            // /auth/state 恒为 none，token / OAuth / Device Flow 弹窗全部空转。
            // 这里就复用 build_entry 的同一份白名单：上游目录是远程数据，原样
            // clone 会把恶意条目里的 `token` 凭据值带进内存中的 McpBody，虽然
            // 最终写盘会被过滤，但归一化层不该持有任何密钥。两份判据必须同源。
            if let Some(auth) = cfg.get("auth").filter(|v| v.is_object()) {
                body.auth = Some(sanitize_auth_decl(auth));
            } else if let Some(t) = cfg.get("authType").and_then(Value::as_str) {
                body.auth_type = Some(t.to_string());
            }
            // http 家族在 `build_entry` 里只落 url/headers，**没有 env 字段**，
            // 因此 supplied_env 在此无处可写。冲突由 `assert_http_has_no_env_schema`
            // 在 install 入口就拦掉（早于向用户索要密钥），这里不再重复判断——
            // 注意不能用 supplied_env 判：它由 resolve_env 产出，含 schema 的 default
            // 值，用户一个字没填也会非空，会误报。
        } else {
            // 先校验 type 合法：`standardize` 对未知的非空值**原样返回**，不校验的话
            // 未知 type 会一路传到 `build_entry`，由持久化层用英文「Unsupported type」
            // 拒绝，用户会误以为是写盘出了问题。
            body.kind = standardize_kind(&raw_kind)?;
            // 有 command 才是 stdio；上游 stdio 项通常不写 type，靠 command 兜底识别。
            if cfg.get("command").and_then(Value::as_str).unwrap_or("").trim().is_empty() {
                return Err(format!(
                    "MCP 服务 {} 缺少 command，无法作为本地进程启动（上游 type={:?}）",
                    name, raw_kind
                ));
            }
            body.command = Some(cfg.get("command").and_then(Value::as_str).unwrap_or("").to_string());
            body.args = Some(json_string_array(cfg.get("args")));
            let mut env = json_map_to_hashmap(cfg.get("env")).unwrap_or_default();
            if let Some(extra) = supplied_env {
                for (k, v) in extra {
                    if !v.trim().is_empty() {
                        env.insert(k.clone(), v.clone());
                    }
                }
            }
            body.env = Some(env);
        }
        out.push((name.clone(), body));
    }
    Ok(out)
}

fn json_map_to_hashmap(v: Option<&Value>) -> Option<HashMap<String, String>> {
    let obj = v?.as_object()?;
    let mut map = HashMap::new();
    for (k, val) in obj {
        let s = match val {
            Value::String(s) => s.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        };
        map.insert(k.clone(), s);
    }
    Some(map)
}

fn json_string_array(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().map(|x| match x {
            Value::String(s) => s.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        }).collect())
        .unwrap_or_default()
}

/// `env_schema.properties` 决定允许哪些变量，`required` 决定哪些必须有值。
/// 缺省值来自上游 properties 的 `default`（若提供），其余必须前端表单透传。
pub fn resolve_env(
    data: &Value,
    supplied: Option<&HashMap<String, String>>,
) -> Result<HashMap<String, String>, String> {
    let schema = data.get("env_schema");
    let props = schema
        .and_then(|s| s.get("properties"))
        .and_then(Value::as_object);
    let allowed: HashSet<String> = props
        .map(|p| p.keys().cloned().collect())
        .unwrap_or_default();
    let mut env: HashMap<String, String> = HashMap::new();
    if let Some(p) = props {
        for (k, spec) in p {
            if let Some(d) = spec.get("default").and_then(Value::as_str) {
                env.insert(k.clone(), d.to_string());
            }
        }
    }
    if let Some(input) = supplied {
        for (k, v) in input {
            // 只接受 schema 声明过的键；防止把任意字段塞进进程环境变量。
            if allowed.contains(k) && !v.trim().is_empty() {
                env.insert(k.clone(), v.clone());
            }
        }
    }
    let required: Vec<String> = schema
        .and_then(|s| s.get("required"))
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let missing: Vec<String> = required
        .into_iter()
        .filter(|k| env.get(k).map(|v| v.trim().is_empty()).unwrap_or(true))
        .collect();
    if !missing.is_empty() {
        return Err(format!("请补充必填环境变量: {}", missing.join(", ")));
    }
    Ok(env)
}

/// http 家族（sse / streamable / streamable_stateless）与 env_schema 的冲突检查。
///
/// 背景：`build_entry` 对 http 类型只写 `url` / `headers`，**没有 `env` 字段**
/// （env 是 stdio 专有）。若上游某个服务是 http 型配置、却又声明了需要填值的
/// `env_schema`，那么前端弹窗会向用户索要密钥，用户填完、我们却无处保存 ——
/// 结果是「安装成功」提示 + 密钥被静默丢弃，服务连不上且无从排查。
///
/// 因此在 install 入口**先**做这个检查：冲突就明确报错，绝不走到索要密钥那一步。
/// 2026-11 上游实测 hosted / 非 hosted 样本的 server_config 全为 stdio（http 0 例），
/// 当前走不到；这是上游改形态后的显式护栏，而不是已发生的故障。
///
/// 只在「上游声明了**必填**环境变量」时判定冲突。
///
/// 判据必须是 `env_schema.required` 非空，**不是** `properties` 非空。
///
/// ⚠ 2026-11 codereview 更正：本段旧注释曾断言「前端详情弹窗只在 `required`
/// 非空时才索要密钥」，并以此论证按 `required` 判定不会漏。**那个前提是错的**：
/// 它引用的是 `app-mcp-market.js` 里 `install()` 的直装转弹窗分支，而真正渲染
/// 表单的 `showDetail()` 用的是 `Object.keys(props).length > 0`。于是「http 型 +
/// 只有可选 env 项」会形成一条静默丢密钥的路径：前端摆输入框索要值 → 本 guard
/// 因 `required` 空而放行 → 用户填了 → `normalize_server_config` 的 http 分支
/// 无处写 `supplied_env` → 提示安装成功、密钥丢失、连不上且无从排查。
///
/// 现由 `env_supported()`（内核唯一真源，前端只读 `env_supported` 标志）在
/// **渲染表单之前**就消掉这条路：http 型根本不渲染 env 表单，用户无从填、
/// 也就不存在被丢弃的值。本 guard 仍保留，作为 install 入口的最后防线
/// （绕过前端直调 API 时依然拦得住）。
///
/// 为什么仍不按 `properties` 判定：那会把「有可选/带 default 的 env 项但无必填项」
/// 的 http 服务一并拦死。在 `env_supported` 已让前端不再索要值之后，这种服务
/// install 会正常成功（用户没被要求填任何东西），拦它纯属误报。
pub fn assert_http_has_no_env_schema(data: &Value) -> Result<(), String> {
    let first = data
        .get("server_config")
        .and_then(Value::as_array)
        .and_then(|a| a.first());
    let Some(first) = first else { return Ok(()) };
    let Some(servers) = first.get("mcpServers").and_then(Value::as_object) else {
        return Ok(());
    };
    let schema = data.get("env_schema");
    let required: Vec<String> = schema
        .and_then(|s| s.get("required"))
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if required.is_empty() {
        return Ok(());
    }
    for (name, cfg) in servers {
        let raw_kind = cfg.get("type").and_then(Value::as_str).unwrap_or("").trim();
        let is_http = !raw_kind.is_empty() && crate::mcp::is_http_type(raw_kind);
        if is_http {
            return Err(format!(
                "MCP 服务 {} 是 {} 类型，其配置只能携带 url/headers，无法保存环境变量 {}。\
                 请使用「手动添加 MCP」并把凭据填入请求头（headers）。",
                name,
                raw_kind,
                required.join(", ")
            ));
        }
    }
    Ok(())
}

/// POST /web/settings/mcp/market/install — 拉详情 → 校验 env → 复用 mcp_server_add。
pub async fn mcp_market_install(
    State(state): State<Arc<AppState>>,
    Json(body): Json<InstallBody>,
) -> Json<Value> {
    if body.id.trim().is_empty() {
        return Json(market::failure("id is required"));
    }
    let data = match market().detail(&body.id).await {
        Ok(d) => d,
        Err(e) => return Json(market::failure(e)),
    };
    // 必须先于 resolve_env：http 型配置存不下 env，若先索要密钥再失败，
    // 用户白填一遍，且失败时机滞后到 normalize，排查成本高。
    if let Err(e) = assert_http_has_no_env_schema(&data) {
        return Json(market::failure(e));
    }
    let env = match resolve_env(&data, body.env.as_ref()) {
        Ok(e) => e,
        Err(e) => return Json(market::failure(e)),
    };
    let entries = match normalize_server_config(&data, Some(&env)) {
        Ok(e) => e,
        Err(e) => return Json(market::failure(e)),
    };
    let mut installed: Vec<String> = Vec::new();
    for (name, mcp_body) in entries {
        // 同一个持久化函数：去重、build_entry 校验、patch_settings、sync_engine 全部复用。
        let resp = mcp_server_add(State(state.clone()), Json(mcp_body)).await.0;
        if resp.get("code").and_then(Value::as_i64) != Some(200) {
            let reason = resp
                .get("description")
                .or_else(|| resp.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("写入 settings.json 失败");
            return Json(market::failure(format!("安装 {} 失败: {}", name, reason)));
        }
        installed.push(name);
    }
    Json(market::succeed(json!({"installed": installed})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::market::{McpMarketHttp, LIST_URL};
    use async_trait::async_trait;

    struct MockHttp {
        put_status: u16,
        put_body: Value,
        get_status: u16,
        get_body: Value,
    }

    #[async_trait]
    impl McpMarketHttp for MockHttp {
        async fn put_json(&self, url: &str, body: &Value) -> Result<(u16, Value), String> {
            assert_eq!(url, LIST_URL);
            assert!(body.get("page_number").is_some(), "列表必须带 page_number");
            Ok((self.put_status, self.put_body.clone()))
        }
        async fn get_json(&self, url: &str) -> Result<(u16, Value), String> {
            assert!(url.starts_with(&(LIST_URL.to_string() + "/")), "详情 URL 必须挂在列表 URL 下");
            Ok((self.get_status, self.get_body.clone()))
        }
    }

    fn ok_envelope(data: Value) -> Value {
        json!({"success": true, "data": data})
    }

    fn stdio_detail() -> Value {
        json!({
            "server_config": [{"mcpServers": {"fetch": {
                "command": "uvx",
                "args": ["mcp-server-fetch"],
                "env": {"UV_CACHE_DIR": "/tmp/uv"}
            }}}],
            "env_schema": {"type": "object", "properties": {"API_KEY": {"type": "string"}}, "required": ["API_KEY"]},
            "readme": "# Fetch",
            "is_verified": true,
        })
    }

    /// 行为级回归：广场安装必须把上游的认证声明带进 McpBody。
    ///
    /// 只断言源码里出现 `body.auth` 是恒真式假绿（接线点被删也能过），
    /// 这里真跑 `normalize_server_config` 并检查产出的每一个字段。上游目录
    /// 目前不提供 auth 声明，此测试同时是「一旦上游开始提供，链路必须可用」
    /// 的契约钉子。
    #[test]
    fn mcp_market_normalize_carries_auth_declaration_for_http_servers() {
        let detail = json!({
            "server_config": [{"mcpServers": {"dnb": {
                "type": "streamable_http",
                "url": "https://mcp.example.com/mcp",
                "headers": {"X-App": "gwork"},
                "auth": {
                    "authType": "oauth",
                    "authDeviceFlow": true,
                    "authQrModal": false,
                    "deviceAuthorizationEndpoint": "https://as.example.com/device",
                    "devicePollIntervalSecs": 7,
                    "tokenLabel": "D&B Token",
                    "token": "MUST-NOT-BE-COPIED"
                }
            }}}],
        });
        let entries = normalize_server_config(&detail, None).expect("合法详情应能归一化");
        assert_eq!(entries.len(), 1);
        let (name, body) = &entries[0];
        assert_eq!(name, "dnb");
        assert_eq!(body.url.as_deref(), Some("https://mcp.example.com/mcp"));
        let auth = body.auth.as_ref().expect("http 型必须透传 auth 声明，否则 /auth/state 恒为 none");
        assert_eq!(auth["authType"], json!("oauth"));
        assert_eq!(auth["authDeviceFlow"], json!(true));
        assert_eq!(auth["devicePollIntervalSecs"], json!(7));
        // 凭据值绝不进入 McpBody（真正过滤在 build_entry::sanitize_auth_decl，
        // 这里先钉住归一化层不做任何凭据拷贝）。
        assert!(auth.get("token").is_none());

        // 旧式扁平 authType 也要兼容。
        let legacy = json!({
            "server_config": [{"mcpServers": {"legacy": {
                "type": "sse",
                "url": "https://legacy.example.com/sse",
                "authType": "token"
            }}}],
        });
        let legacy_entries = normalize_server_config(&legacy, None).unwrap();
        assert_eq!(legacy_entries[0].1.auth_type.as_deref(), Some("token"));

        // stdio 不消费 CredentialVault，绝不能带认证声明（避免「存了不注入」）。
        let stdio = json!({
            "server_config": [{"mcpServers": {"local": {
                "command": "uvx", "args": ["mcp-server-fetch"],
                "auth": {"authType": "token"}
            }}}],
        });
        let stdio_entries = normalize_server_config(&stdio, None).unwrap();
        assert!(stdio_entries[0].1.auth.is_none(), "stdio 不得声明 auth");
        assert!(stdio_entries[0].1.auth_type.is_none(), "stdio 不得声明 authType");
    }

    #[test]
    fn mcp_market_normalize_stdio_sse_and_streamable_http() {
        let stdio = json!({"server_config": [{"mcpServers": {"fetch": {
            "command": "uvx", "args": ["mcp-server-fetch"], "env": {"A": "B"}
        }}}]});
        let v = normalize_server_config(&stdio, None).unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].1.kind, "stdio");
        assert_eq!(v[0].1.command.as_deref(), Some("uvx"));
        assert_eq!(v[0].1.args, Some(vec!["mcp-server-fetch".to_string()]));
        assert_eq!(v[0].1.env.as_ref().unwrap().get("A").map(String::as_str), Some("B"));
        assert_eq!(v[0].1.scope.as_deref(), Some("user"));
        assert_eq!(v[0].1.enabled, Some(true));

        let sse = json!({"server_config": [{"mcpServers": {"remote": {
            "type": "sse", "url": "https://mcp.example.com/sse", "headers": {"X-Token": "t"}
        }}}]});
        let v = normalize_server_config(&sse, None).unwrap();
        assert_eq!(v[0].1.kind, "sse");
        assert_eq!(v[0].1.url.as_deref(), Some("https://mcp.example.com/sse"));
        assert_eq!(v[0].1.headers.as_ref().unwrap().get("X-Token").map(String::as_str), Some("t"));
        assert!(v[0].1.command.is_none());

        let http = json!({"server_config": [{"mcpServers": {"stream": {
            "type": "streamable_http", "url": "https://mcp.example.com/mcp"
        }}}]});
        let v = normalize_server_config(&http, None).unwrap();
        assert_eq!(v[0].1.kind, "streamable");
        assert_eq!(v[0].1.url.as_deref(), Some("https://mcp.example.com/mcp"));

        let empty = json!({"server_config": []});
        assert!(normalize_server_config(&empty, None).is_err());
    }

    #[test]
    fn mcp_market_env_required_is_enforced_and_extra_keys_are_dropped() {
        let detail = stdio_detail();
        assert!(resolve_env(&detail, None).is_err(), "缺少 required 必须报错");
        let mut supplied = HashMap::new();
        supplied.insert("API_KEY".into(), "secret".into());
        supplied.insert("NOT_IN_SCHEMA".into(), "evil".into());
        let env = resolve_env(&detail, Some(&supplied)).unwrap();
        assert_eq!(env.get("API_KEY").map(String::as_str), Some("secret"));
        assert!(!env.contains_key("NOT_IN_SCHEMA"));
        let entries = normalize_server_config(&detail, Some(&env)).unwrap();
        assert_eq!(entries[0].1.env.as_ref().unwrap().get("API_KEY").map(String::as_str), Some("secret"));
        assert_eq!(entries[0].1.env.as_ref().unwrap().get("UV_CACHE_DIR").map(String::as_str), Some("/tmp/uv"));
    }

    #[tokio::test]
    async fn mcp_market_servers_and_detail_use_the_single_upstream_adapter() {
        let http = MockHttp {
            put_status: 200,
            put_body: ok_envelope(json!({"total_count": 12799, "mcp_server_list": [{"id": "@a/b", "name": "B"}]})),
            get_status: 200,
            get_body: ok_envelope(stdio_detail()),
        };
        let m = ModelscopeMcpMarket::new(http);
        let page = m.servers(&ServerQuery {
            search: "地图".into(), page: 6, page_size: 20, category: "search".into(), hosted: false,
        }).await.unwrap();
        assert_eq!(page["total_count"], json!(12799));
        assert_eq!(page["page_number"], json!(5)); // 6*20 超窗口 → 钳到 5
        assert_eq!(page["mcp_server_list"][0]["id"], json!("@a/b"));
        let d = m.detail("@a/b").await.unwrap();
        assert_eq!(d["readme"], json!("# Fetch"));
        // 19 = 「全部」+ 18 个经上游实测确认非零的真实分类。
        // 数字变化时必须同步核对 core/src/mcp/market.rs::categories() 的实测注释，
        // 并由 mcp_market_categories_contain_no_dead_keys 拦住死 key 回归。
        assert_eq!(m.categories().as_array().unwrap().len(), 19);
    }

    #[tokio::test]
    async fn mcp_market_upstream_failure_becomes_a_400_envelope() {
        let http = MockHttp {
            put_status: 502,
            put_body: json!({"success": false, "message": "bad gateway"}),
            get_status: 200,
            get_body: ok_envelope(json!({})),
        };
        let m = ModelscopeMcpMarket::new(http);
        let err = m.servers(&ServerQuery::default()).await.unwrap_err();
        let env = market::failure(err);
        assert_eq!(env["code"], json!(400));
        assert!(!env["description"].as_str().unwrap().is_empty());

        let http2 = MockHttp {
            put_status: 200,
            put_body: ok_envelope(json!({})),
            get_status: 200,
            get_body: json!({"success": false, "message": "not found"}),
        };
        let err2 = ModelscopeMcpMarket::new(http2).detail("@x/y").await.unwrap_err();
        assert!(err2.contains("not found"));
        assert_eq!(market::failure(err2)["code"], json!(400));
    }

    #[test]
    fn mcp_market_http_config_with_env_schema_is_rejected_not_silently_dropped() {
        // http 型 + 需要填 env_schema：必须显式报错。
        // build_entry 对 http 只写 url/headers，env 无处落盘；若放行就会出现
        // 「安装成功」提示 + 用户填的密钥被静默丢弃（伪造成功）。
        let conflict = json!({
            "server_config": [{"mcpServers": {"remote": {
                "type": "sse", "url": "https://mcp.example.com/sse"
            }}}],
            "env_schema": {"type": "object",
                "properties": {"API_KEY": {"type": "string"}},
                "required": ["API_KEY"]},
        });
        let err = assert_http_has_no_env_schema(&conflict).unwrap_err();
        assert!(err.contains("remote"), "报错要指名是哪个服务: {}", err);
        assert!(err.contains("API_KEY"), "报错要说明存不下哪个变量: {}", err);
        assert!(err.contains("headers"), "要给出可执行的替代方案: {}", err);

        // 【接线级断言】光测纯函数挡不住「guard 调用被删」：曾实测删掉 install 里
        // 的调用后 11 个测试全绿。所以这里断言 install 必经的 normalize_server_config
        // 自身也返回 Err —— 把 guard 从可删的接线点搬进数据流必经之路。
        // 不用 unwrap_err()：Ok 分支的 McpBody 没实现 Debug。
        let norm_err = match normalize_server_config(&conflict, None) {
            Err(e) => e,
            Ok(_) => panic!("normalize_server_config 必须自己拦住 http+env_schema，不能只靠 install 的提前调用"),
        };
        assert!(norm_err.contains("remote") && norm_err.contains("API_KEY"),
            "拦截原因要指名服务与存不下的变量: {}", norm_err);

        // streamable_http 同样拦（注意：必须有 required，见下）
        let streamable = json!({
            "server_config": [{"mcpServers": {"s": {
                "type": "streamable_http", "url": "https://x/mcp"
            }}}],
            "env_schema": {"properties": {"T": {"type": "string"}}, "required": ["T"]},
        });
        assert!(assert_http_has_no_env_schema(&streamable).is_err());

        // http 型 + **只有可选/带 default 的 env 项、无 required**：必须放行。
        // 前端只在 required 非空时索要密钥，这种服务用户根本不会被要求填任何东西，
        // install 正常成功 —— 按 properties 判定会误伤它（曾是真实缺陷）。
        let optional_only = json!({
            "server_config": [{"mcpServers": {"s": {
                "type": "sse", "url": "https://x/sse"
            }}}],
            "env_schema": {"properties": {"K": {"type": "string", "default": "d"}}},
        });
        assert!(assert_http_has_no_env_schema(&optional_only).is_ok(),
            "无 required 的 http 服务不得被拦（用户没被要求填任何密钥）");
        let empty_required = json!({
            "server_config": [{"mcpServers": {"s": {
                "type": "sse", "url": "https://x/sse"
            }}}],
            "env_schema": {"properties": {"K": {"type": "string"}}, "required": []},
        });
        assert!(assert_http_has_no_env_schema(&empty_required).is_ok(), "required 为空数组也必须放行");

        // http 型但**不需要**任何 env：正常放行，不得误报。
        let plain_http = json!({
            "server_config": [{"mcpServers": {"s": {
                "type": "sse", "url": "https://x/sse"
            }}}],
            "env_schema": {"properties": {}},
        });
        assert!(assert_http_has_no_env_schema(&plain_http).is_ok(), "无 env 需求的 http 服务必须可安装");
        let no_schema = json!({"server_config": [{"mcpServers": {"s": {
            "type": "sse", "url": "https://x/sse"}}}]});
        assert!(assert_http_has_no_env_schema(&no_schema).is_ok(), "完全没有 env_schema 也必须放行");

        // stdio 型 + env_schema：这是绝大多数真实服务（实测 amap / tyc / alipay 全是这种），
        // 必须放行 —— env 走 build_entry 的 stdio 分支正常落盘。
        assert!(assert_http_has_no_env_schema(&stdio_detail()).is_ok(), "stdio + env_schema 是正常形态，不得拦");

        // 上游偶发 server_config 为空数组（实测 ths/thsfazhi-law 就是 0 条），
        // 这里放行，交由 normalize_server_config 给出更贴切的「缺少 server_config」报错。
        assert!(assert_http_has_no_env_schema(&json!({"server_config": []})).is_ok());
    }

    /// 归一化的 http 判定必须与 `assert_http_has_no_env_schema` **同源**。
    ///
    /// 曾在此硬编码一份别名字符串白名单（`"sse" | "sse_http" | ... `），而 guard 用
    /// `mcp::is_http_type`（走 `standardize`，含 `to_lowercase` 与完整 alias_map）。
    /// 两份判定一旦分叉，`standardize` 认识、白名单却没列的拼写就会落到 stdio 分支：
    /// 合法的远程服务因「没有 command」而安装失败，且报错说「不是可识别的 HTTP 类型」
    /// —— 与 `is_http_type(spelling) == true` 自相矛盾，用户无从排查。
    #[test]
    fn mcp_market_http_spelling_variants_are_normalized_as_http_not_stdio() {
        // 覆盖三类分叉：大小写（standardize 会 to_lowercase）、alias_map 里
        // 存在但白名单漏掉的拼写（ssehttp / remote）、混合大小写的多词拼写。
        for spelling in ["SSE", "sse_http", "ssehttp", "remote", "Streamable_HTTP", "HTTP"] {
            assert!(
                crate::mcp::is_http_type(spelling),
                "前提失效：{} 已不被 is_http_type 认定为 http，请重新核对本测试的取值",
                spelling
            );
            let d = json!({"server_config": [{"mcpServers": {"r": {
                "type": spelling, "url": "https://x/mcp", "headers": {"X-T": "1"}
            }}}]});
            let v = normalize_server_config(&d, None).unwrap_or_else(|e| {
                panic!("{} 是 is_http_type 认可的合法 http 拼写，安装不该失败: {}", spelling, e)
            });
            assert_eq!(
                v[0].1.url.as_deref(),
                Some("https://x/mcp"),
                "{} 走了 stdio 分支，url 被丢弃",
                spelling
            );
            assert!(v[0].1.command.is_none(), "{} 不该被当成 stdio", spelling);
            assert_eq!(
                v[0].1.headers.as_ref().and_then(|h| h.get("X-T")).map(String::as_str),
                Some("1"),
                "{} 的 headers 被丢弃",
                spelling
            );
        }
    }

    /// `env_supported` 是「详情弹窗要不要渲染 env 表单」的**唯一判据**，前端只读
    /// 这个布尔、不自己判类型（JS 侧 ⑲ 只断言源码含该字段名，抓不到逻辑改动）。
    ///
    /// 没有本测试时，把它写成恒 `true` 全绿：http 型服务照样摆输入框索要密钥 →
    /// `normalize_server_config` 的 http 分支无处落 env → 提示安装成功、密钥静默
    /// 丢失、服务连不上且无从排查（2026-11 codereview 抓出的 P1 原路径）。
    #[test]
    fn mcp_market_env_supported_is_false_only_for_http_types() {
        // (a) http 家族一律 false —— 与安装侧 is_http_type 同源，不另立别名表
        for spelling in ["sse", "sse_http", "ssehttp", "remote", "streamable_http", "http"] {
            assert!(
                crate::mcp::is_http_type(spelling),
                "前提失效：{} 已不被 is_http_type 认定为 http",
                spelling
            );
            let d = json!({"server_config": [{"mcpServers": {"r": {
                "type": spelling, "url": "https://x/mcp"
            }}}]});
            assert!(
                !env_supported(&d),
                "{} 是 http 型、存不下 env，必须让前端不渲染表单（否则密钥被静默丢弃）",
                spelling
            );
        }

        // (b) P1 的原始触发形态：http 型 + **只有可选** env 项（required 为空）。
        //     install 侧 guard 因 required 空而放行，全靠这里在渲染前就掐掉表单。
        let only_optional = json!({
            "env_schema": {"properties": {"API_TOKEN": {"description": "可选"}}, "required": []},
            "server_config": [{"mcpServers": {"r": {"type": "sse", "url": "https://x/mcp"}}}]
        });
        assert!(
            !env_supported(&only_optional),
            "http 型只有可选 env 项时也必须 false —— 这正是静默丢密钥的那条路径"
        );
        // 同时确认 guard 不误拦：这种服务 install 应成功（用户没被要求填任何东西）
        normalize_server_config(&only_optional, None).unwrap_or_else(|e| {
            panic!("http + 仅可选 env 的安装不该被 guard 拦死: {}", e)
        });

        // (c) stdio 存得下 env → true（否则所有服务都失去 env 表单，比旧形态更糟）
        let stdio = json!({
            "env_schema": {"properties": {"APP_ID": {"description": "应用 ID"}}, "required": ["APP_ID"]},
            "server_config": [{"mcpServers": {"s": {"type": "stdio", "command": "uvx", "args": []}}}]
        });
        assert!(env_supported(&stdio), "stdio 必须为 true，它才存得下 env");

        // (d) 上游数据残缺（无 server_config）→ true，是有意的宽松：让前端维持
        //     既有形态，最终仍由 install 侧 resolve_env 拦缺必填，不会伪造成功。
        assert!(
            env_supported(&json!({"env_schema": {"properties": {"K": {}}, "required": ["K"]}})),
            "缺 server_config 时应宽松返回 true（install 侧 resolve_env 仍是防线）"
        );
        // (e) type 缺失/空串 → 不归为 http，返回 true
        let no_type = json!({"server_config": [{"mcpServers": {"s": {"command": "uvx"}}}]});
        assert!(env_supported(&no_type), "type 缺失不该被误判成 http");
    }

    /// 归一化后 `kind` 必须是四种标准类型之一，否则 `build_entry` 会以
    /// 「Unsupported type」失败。宁可在这里就给出准确的中文错误，也不要让
    /// 用户看到一个来自持久化层的英文报错、还以为是落盘出问题。
    #[test]
    fn mcp_market_unknown_type_is_rejected_with_an_accurate_message() {
        let bogus = json!({"server_config": [{"mcpServers": {"s": {
            "type": "carrier-pigeon", "command": "uvx", "args": []
        }}}]});
        let err = match normalize_server_config(&bogus, None) {
            Err(e) => e,
            Ok(v) => panic!("未知 type 不得通过归一化，实际得到 kind={:?}", v[0].1.kind),
        };
        assert!(err.contains("carrier-pigeon"), "报错要带上原始 type 值: {}", err);
        assert!(crate::mcp::is_valid("carrier-pigeon") == false, "前提失效：is_valid 已接受该值");
    }

    /// `env_schema` 被上游序列化成 JSON 字符串时，解析失败**必须报错**。
    ///
    /// 若照旧保留原字符串，`resolve_env` 的 `.get("properties")` 会拿到 `None` →
    /// `allowed` / `required` 双双为空 → 用户填的密钥被静默丢弃、安装却报成功、
    /// 服务连不上且无从排查。这与 http+env guard 要防的是同一种「伪造成功」。
    #[tokio::test]
    async fn mcp_market_malformed_env_schema_string_fails_instead_of_silently_passing() {
        let http = MockHttp {
            put_status: 200,
            put_body: ok_envelope(json!({})),
            get_status: 200,
            get_body: json!({"success": true, "data": {
                "server_config": [{"mcpServers": {"s": {"command": "uvx", "args": []}}}],
                "env_schema": "{not json at all"
            }}),
        };
        let err = ModelscopeMcpMarket::new(http)
            .detail("@x/y")
            .await
            .unwrap_err();
        assert!(err.contains("env_schema"), "报错要指明是 env_schema 解析失败: {}", err);
    }

    /// 字符串形态但**合法**的 env_schema 必须被解析成对象，且解析结果真的参与
    /// required 校验 —— 否则「支持字符串 env_schema」只是写了没生效。
    #[tokio::test]
    async fn mcp_market_string_env_schema_is_parsed_and_still_enforces_required() {
        let http = MockHttp {
            put_status: 200,
            put_body: ok_envelope(json!({})),
            get_status: 200,
            get_body: json!({"success": true, "data": {
                "server_config": [{"mcpServers": {"s": {"command": "uvx", "args": []}}}],
                "env_schema": "{\"properties\":{\"API_KEY\":{\"type\":\"string\"}},\"required\":[\"API_KEY\"]}"
            }}),
        };
        let m = ModelscopeMcpMarket::new(http);
        let d = m.detail("@x/y").await.unwrap();
        assert!(d["env_schema"].is_object(), "字符串 env_schema 必须被解析成对象");
        assert!(resolve_env(&d, None).is_err(), "解析后 required 校验必须仍然生效");
        let mut supplied = HashMap::new();
        supplied.insert("API_KEY".into(), "secret".into());
        assert_eq!(
            resolve_env(&d, Some(&supplied)).unwrap().get("API_KEY").map(String::as_str),
            Some("secret")
        );
    }

    #[test]
    fn mcp_market_url_construction() {
        assert_eq!(LIST_URL, "https://www.modelscope.cn/openapi/v1/mcp/servers");
        assert_eq!(
            market::detail_url("@amap/amap-maps"),
            LIST_URL.to_string() + "/%40amap%2Famap-maps"
        );
        let b = market::list_body("", 1, 20, "", false);
        assert_eq!(b["filter"]["is_hosted"], json!(false));
        assert_eq!(b["page_size"], json!(20));
    }
}
