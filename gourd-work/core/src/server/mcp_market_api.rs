//! server::mcp_market_api — 连接器广场的 4 个 axum handler（三个内置目录源）。
//!
//! | Method | Path                                      | 用途 |
//! |--------|-------------------------------------------|------|
//! | GET    | `/web/settings/mcp/market/servers?source=` | 列表 / 搜索 / 分类 |
//! | GET    | `/web/settings/mcp/market/detail?id=`     | 详情（server_config / env_schema / readme）|
//! | GET    | `/web/settings/mcp/market/categories?source=` | 各源内置静态分类表 |
//! | POST   | `/web/settings/mcp/market/install`        | 归一化 + 复用 mcp_server_add 落盘 |
//!
//! 目录源（2026-11 集成 SolonCode v2026.11 连接器市场后）：
//! * `modelscope`（默认，缺省 source）→ `mcp::market`
//! * `tencent`   → `mcp::tencent`（腾讯云 MCP 广场，SolonCode 默认源）
//! * `smithery`  → `mcp::smithery`（Smithery 注册表，境外源）
//!
//! 三源输出同一套列表/详情形状，归一化/预检/落盘链路**零分叉**复用。
//! detail/install 的源由 **id 前缀**分流（`tencent:` / `smithery:`，无前缀=魔搭），
//! 与 SolonCode 的 marketName 参数不同——id 前缀让「详情弹窗/安装」不必额外携带
//! source 参数，深链与缓存 key 天然跨源不撞。
//!
//! ⚠ 已删除且不得复活的概念：自建官方连接器仓库（`mcp::registry` / `mcp::featured` /
//! `mcp::cli` / CLI 连接器 / 内置 Node 运行时）、`official:`/`featured:` id 前缀、
//! admin 远程目录拉取、`registry_error` 软失败态。本轮的 `source` 参数只在上述
//! 三个**公开目录源**之间切换，与已删除的自建官方源无关。
//!
//! 响应统一 `{code:200,description:"",data:{...}}`；上游失败 → `{code:400,description:"..."}`,
//! 不伪造成功。install 不自己写 settings.json：它把 `server_config[0].mcpServers`
//! 归一化成 `settings_api::McpBody`，逐个调用 `settings_api::mcp_server_add`，从而与手动
//! 添加 MCP 共用同一份校验 / 去重 / 持久化 / 热插拔逻辑。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use super::settings_api::{build_entry, mcp_server_add, read_settings_key, sanitize_auth_decl, McpBody};
use super::AppState;
use crate::mcp::market::{
    self, ModelscopeMcpMarket, ReqwestMcpMarketHttp, ServerQuery,
};
use crate::mcp::smithery::{ReqwestSmitheryHttp, SmitheryMcpMarket};
use crate::mcp::tencent::{ReqwestTencentHttp, TencentMcpMarket};

fn market() -> ModelscopeMcpMarket<ReqwestMcpMarketHttp> {
    ModelscopeMcpMarket::new(ReqwestMcpMarketHttp::new())
}

/// Smithery 适配器进程级单例：本地搜索索引（热度前 5 页，TTL 10 分钟）必须
/// 跨请求存活，每请求新建实例会让每次搜索都重抓 5 页上游。
fn smithery_market() -> &'static SmitheryMcpMarket<ReqwestSmitheryHttp> {
    static INSTANCE: once_cell::sync::Lazy<SmitheryMcpMarket<ReqwestSmitheryHttp>> =
        once_cell::sync::Lazy::new(|| SmitheryMcpMarket::new(ReqwestSmitheryHttp));
    &INSTANCE
}

/// 内置目录源白名单。未知值一律回落魔搭（旧客户端不带 source 参数，行为不变）。
pub const SOURCE_MODELSCOPE: &str = "modelscope";
pub const SOURCE_TENCENT: &str = "tencent";
pub const SOURCE_SMITHERY: &str = "smithery";

pub fn normalize_source(raw: Option<&str>) -> &'static str {
    match raw.map(str::trim).unwrap_or("") {
        SOURCE_TENCENT => SOURCE_TENCENT,
        SOURCE_SMITHERY => SOURCE_SMITHERY,
        _ => SOURCE_MODELSCOPE,
    }
}

/// detail/install 的源分流：id 前缀是唯一口径（列表条目 id 由各适配器加前缀）。
pub fn source_of_id(id: &str) -> &'static str {
    let t = id.trim();
    if t.starts_with("tencent:") {
        SOURCE_TENCENT
    } else if t.starts_with("smithery:") {
        SOURCE_SMITHERY
    } else {
        SOURCE_MODELSCOPE
    }
}

/// 统一详情入口：按 id 前缀分流到对应适配器。返回形状三源一致。
async fn detail_by_id(id: &str) -> Result<Value, String> {
    match source_of_id(id) {
        SOURCE_TENCENT => TencentMcpMarket::new(ReqwestTencentHttp).detail(id).await,
        SOURCE_SMITHERY => smithery_market().detail(id).await,
        _ => market().detail(id).await,
    }
}

/// 缺失或非法数字都给默认值，避免 axum Query 直接 400 绕过统一信封。
fn parse_i64(raw: Option<String>, default: i64) -> i64 {
    raw.and_then(|s| s.trim().parse::<i64>().ok()).unwrap_or(default)
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
    /// 目录源：modelscope（默认）/ tencent / smithery。未知值回落魔搭。
    /// 仅列表/分类用；detail/install 由 id 前缀分流（见 source_of_id）。
    #[serde(default)]
    pub source: Option<String>,
    // 曾有 `hosted: Option<String>`（旧「已托管」筛选勾选）。2026-11 官方源下线轮
    // 一并退役：UI 两处 query 构造都不再发它，语言包 `hosted` 键也已删。
    // 之所以不是「保留透传兼容旧调用」——hosted=true 返回的 4806 条条目，其连接
    // URL 需要 Bearer Token（`mcp::market` 头部「明确不做」项），用户装上必然连不上。
    // 留一个旧书签/旧客户端能触发的必败路径，比删掉更糟。见下方 `HOSTED_FILTER`。
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
//
// 全部直接打魔搭上游（`mcp::market::ModelscopeMcpMarket`），无本地目录、无预热、
// 无退避。上游失败一律走 `market::failure` 返回 400 信封，不伪造成功。

/// 上游 `filter.is_hosted` 的**唯一**取值。
///
/// 键本身必须存在（`mcp::market::list_body` 实测：上游靠它区分 7993 / 4806 条），
/// 但当前只能是 `false`：hosted 条目的连接 URL 需要 Bearer Token，属 deploy /
/// operational 范畴，`mcp::market` 头部已列为「明确不做」。把它写成常量而不是
/// 从 query 解析，是为了让「为什么永远是 false」这件事在代码里可见——
/// 而不是埋在一个 UI 永不传、默认 false 的参数里，让后人误以为传 true 就能用。
const HOSTED_FILTER: bool = false;

pub async fn mcp_market_servers(Query(p): Query<ServersParams>) -> Json<Value> {
    let q = ServerQuery {
        search: p.search.unwrap_or_default(),
        page: parse_i64(p.page, 1),
        page_size: parse_i64(p.page_size, 20),
        category: p.category.unwrap_or_default(),
        hosted: HOSTED_FILTER,
    };
    let result = match normalize_source(p.source.as_deref()) {
        SOURCE_TENCENT => TencentMcpMarket::new(ReqwestTencentHttp).servers(&q).await,
        SOURCE_SMITHERY => smithery_market().servers(&q).await,
        _ => market().servers(&q).await,
    };
    Json(match result {
        Ok(data) => market::succeed(data),
        Err(e) => market::failure(e),
    })
}

pub async fn mcp_market_detail(Query(p): Query<DetailParams>) -> Json<Value> {
    if p.id.trim().is_empty() {
        return Json(market::failure("id is required"));
    }
    Json(match detail_by_id(&p.id).await {
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

/// 分类表：各源内置静态表（`?source=`，缺省魔搭）。
///
/// 计数一律取列表响应里的 `total_count`，**绝不逐类发请求凑计数**；分类只作为
/// 筛选条件传给上游。魔搭表里的 key 全部经上游实测确认非零，死 key 黑名单见
/// `mcp::market::DEAD_CATEGORY_KEYS`；腾讯是 2026-11-17 快照；Smithery 无分类维度。
pub async fn mcp_market_categories(Query(p): Query<ServersParams>) -> Json<Value> {
    let cats = match normalize_source(p.source.as_deref()) {
        SOURCE_TENCENT => crate::mcp::tencent::categories(),
        SOURCE_SMITHERY => crate::mcp::smithery::categories(),
        _ => market().categories(),
    };
    Json(market::succeed(cats))
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
    // 空数组与缺键同语义：腾讯/Smithery 解析不出启动配置时 detail 返回
    // server_config:[]（详情可看、安装明确报错）。给出「手动添加」出口，绝不猜配置。
    let catalog = data.get("id").and_then(Value::as_str).map(source_of_id).unwrap_or(SOURCE_MODELSCOPE);
    let no_config_msg = || match catalog {
        SOURCE_TENCENT | SOURCE_SMITHERY => {
            let page = data.get("detail_page").and_then(Value::as_str).unwrap_or("");
            format!(
                "该连接器未提供可直接导入的启动配置，请使用顶栏「添加服务器」按项目文档手动添加{}",
                if page.is_empty() { String::new() } else { format!("（参考: {}）", page) }
            )
        }
        _ => "魔搭 MCP 服务缺少 server_config，无法安装".to_string(),
    };
    let first = data
        .get("server_config")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .ok_or_else(no_config_msg)?;
    let servers = first
        .get("mcpServers")
        .and_then(Value::as_object)
        .ok_or_else(|| "MCP 服务缺少 mcpServers 配置".to_string())?;
    if servers.is_empty() {
        return Err("MCP 服务的 mcpServers 为空".into());
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

// ─── 展示元数据（已安装卡片的图片与名字） ─────────────────────────────────────

/// 上游条目的展示名：`chinese_name` 优先（中文产品），缺省回退 `name`。
/// 与前端 `app-mcp-market.js` 的 `pickText(item,'name')` 中文分支同口径。
fn catalog_display_name(data: &Value) -> String {
    for key in ["chinese_name", "name"] {
        if let Some(s) = data.get(key).and_then(Value::as_str).map(str::trim) {
            if !s.is_empty() {
                return s.to_string();
            }
        }
    }
    String::new()
}

fn catalog_str(data: &Value, key: &str) -> String {
    data.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("")
        .to_string()
}

/// 把目录展示元数据（展示名 / logo / 描述）附到归一化产出的每个 `McpBody` 上。
///
/// 背景（用户报障）：「连接器·已安装」与「技能·已安装」显示不一致——技能卡有
/// 图片和展示名，连接器卡只有目录 key + 字母占位。根因是安装链路只落
/// command/url 等运行字段，目录的 `name/chinese_name/logo_url/description`
/// 在 normalize 时被整体丢弃。这里在 install 的必经之路上补齐，落盘经
/// `build_entry`、回传经 `mcp_servers`，前端已安装卡即可与技能卡同款渲染。
///
/// 全部是非密钥展示字段；空值不写（前端回退目录名 + 首字母底）。
///
/// `market_id`：目录来源 id（install 请求体的 `id`，如 `@amap/amap-maps`）。
/// 广场卡片「已安装」态的**唯一可靠匹配口径**——落盘名来自 server_config 的
/// mcpServers keys（多为 fetch/time 等通用名），且重名时会自动加 -2 后缀，
/// 按名字匹配必然误判。marketId 经 build_entry 落盘、mcp_servers 透传，
/// 前端用 `marketId === 市场条目 id` 精确匹配。
pub fn attach_catalog_meta(data: &Value, market_id: &str, entries: &mut [(String, McpBody)]) {
    let display = catalog_display_name(data);
    let icon = catalog_str(data, "logo_url");
    let desc = catalog_str(data, "description");
    let mid = market_id.trim();
    for (_name, body) in entries.iter_mut() {
        if !display.is_empty() {
            body.display_name = Some(display.clone());
        }
        if !icon.is_empty() {
            body.icon_url = Some(icon.clone());
        }
        if !desc.is_empty() {
            body.description = Some(desc.clone());
        }
        if !mid.is_empty() {
            body.market_id = Some(mid.to_string());
        }
    }
}

/// 多 server 条目的**落盘前预检**：任一条目 build_entry 失败立即整体报错，
/// 一个都不落盘。
///
/// 背景：install 循环逐个调 mcp_server_add，第 N 个失败时前 N-1 个已经写进
/// settings.json —— 「部分安装」既不是成功也不是失败，用户重试还会撞上前
/// N-1 个的重名。预检必须用与 mcp_server_add **同一个** build_entry（判据
/// 同源），而不是在归一化层另抄一份校验。
pub fn preflight_entries(entries: &[(String, McpBody)]) -> Result<(), String> {
    for (name, body) in entries {
        if let Err(e) = build_entry(body, None) {
            return Err(format!("安装 {} 失败: {}", name, e));
        }
    }
    Ok(())
}

/// 重名自动加后缀：`fetch` 已存在 → `fetch-2`、`fetch-3`…直到不冲突。
///
/// 魔搭条目的 mcpServers key 多为 `fetch` / `time` 等通用名，不同目录条目
/// 撞名是**常态**；市场安装必须幂等可重复（重复安装装成 name-2 是可接受行为，
/// 撞名报 400 则把「再装一个同类服务」这条正常路径堵死）。因此只在市场
/// install 路径加后缀；手动添加 `mcp_server_add` 的重名 400 保持不变——
/// 那是用户显式命名，报错合理。
///
/// `taken` 初始为 settings.json 已有的 mcpServers keys；每分配一个名字就
/// 把它加进集合，**同一批 entries 内部也不会互撞**（上游偶发两个 server
/// 同名、或后缀恰好撞上批内后续条目的原名）。
pub fn assign_unique_names(entries: &mut [(String, McpBody)], taken: &mut HashSet<String>) {
    for (name, body) in entries.iter_mut() {
        let base = name.trim().to_string();
        let mut candidate = base.clone();
        let mut n = 2u32;
        while taken.contains(&candidate) {
            candidate = format!("{}-{}", base, n);
            n += 1;
        }
        taken.insert(candidate.clone());
        *name = candidate.clone();
        body.name = candidate;
    }
}

/// 从 mcp_server_add 的响应里提取连接失败原因。
///
/// `mcp_saved`（settings_api）在「已落盘但连不上」时返回
/// `{code:200, saved:true, connected:false, connectError:"..."}` —— code 仍是
/// 200（配置确实保存了）。install 旧代码只判 `code != 200`，把连不上的服务
/// 照样计入 installed、前端弹绿色「已安装」，这是**假成功**。这里把
/// connected:false 的原因收集出来随响应透传（connectErrors），由前端弹
/// warning。installed 语义保持「已落盘名单」不变。
pub fn collect_connect_error(name: &str, resp: &Value) -> Option<Value> {
    if resp.get("connected").and_then(Value::as_bool) != Some(false) {
        return None;
    }
    let reason = resp
        .get("connectError")
        .or_else(|| resp.get("message"))
        .or_else(|| resp.get("description"))
        .and_then(Value::as_str)
        .unwrap_or("连接失败");
    let mut out = json!({"name": name, "error": reason});
    // 缺运行时的失败带上结构化字段：前端据此弹「安装运行环境」引导框，
    // 而不是让用户对着 warning toast 里的文字自己想办法。判据与 spawn 侧
    // MissingProgram 同源（runtime_for_command），不嗅探报错文案。
    if let Some(cmd) = resp.get("missingCommand").and_then(Value::as_str) {
        if let Some(id) = crate::mcp::runtime::runtime_for_command(cmd) {
            out["missingCommand"] = json!(cmd);
            out["runtime"] = json!(id.as_str());
            out["runtimeInstallable"] = json!(crate::mcp::runtime::recipe_for(id).is_ok());
        }
    }
    Some(out)
}

/// POST /web/settings/mcp/market/install — 拉详情 → 校验 env → 复用 mcp_server_add。
pub async fn mcp_market_install(
    State(state): State<Arc<AppState>>,
    Json(body): Json<InstallBody>,
) -> Json<Value> {
    if body.id.trim().is_empty() {
        return Json(market::failure("id is required"));
    }
    let data = match detail_by_id(&body.id).await {
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
    let mut entries = match normalize_server_config(&data, Some(&env)) {
        Ok(e) => e,
        Err(e) => return Json(market::failure(e)),
    };
    // 目录展示元数据 + marketId（目录来源 id，非密钥）随配置一起落盘：
    // 已安装卡片据此显示图片与展示名（与技能卡同款），广场卡片据 marketId
    // 判定「已安装」态（落盘名可能带 -2 后缀，按名匹配不可靠）。
    attach_catalog_meta(&data, &body.id, &mut entries);
    // 修3：落盘前对整批条目预检（与 mcp_server_add 同一个 build_entry），
    // 任一失败立即 400 且不落盘任何条目，杜绝「部分安装」。
    if let Err(e) = preflight_entries(&entries) {
        return Json(market::failure(e));
    }
    // 修2：重名自动加后缀（fetch → fetch-2…）。必须在预检**之后**、用同一份
    // 名单做：预检名单与落盘名单一致，且同批 entries 内部也防互撞。
    let mut taken: HashSet<String> = read_settings_key("mcpServers")
        .as_object()
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    assign_unique_names(&mut entries, &mut taken);
    let mut installed: Vec<String> = Vec::new();
    // 修1：收集「已落盘但连不上」的原因（mcp_saved 的 connected:false +
    // connectError），随成功响应透传，前端据此弹 warning 而非绿色假成功。
    let mut connect_errors: Vec<Value> = Vec::new();
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
        if let Some(err) = collect_connect_error(&name, &resp) {
            connect_errors.push(err);
        }
        installed.push(name);
    }
    // installed 语义保持「已落盘名单」；connectErrors 全部连接成功时为空数组。
    // 缺运行时的条目附带 runtime/missingCommand（collect_connect_error），
    // 前端据此弹「正在下载运行环境」进度弹窗并自动代装（零确认点击）。
    Json(market::succeed(json!({"installed": installed, "connectErrors": connect_errors})))
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

    // ─── 2026-11 SolonCode 集成轮：三源分流 ─────────────────────────────────

    #[test]
    fn source_whitelist_normalizes_unknown_to_modelscope() {
        assert_eq!(normalize_source(None), SOURCE_MODELSCOPE);
        assert_eq!(normalize_source(Some("")), SOURCE_MODELSCOPE);
        assert_eq!(normalize_source(Some("official")), SOURCE_MODELSCOPE, "自建官方源已删除，不得复活");
        assert_eq!(normalize_source(Some("tencent")), SOURCE_TENCENT);
        assert_eq!(normalize_source(Some(" smithery ")), SOURCE_SMITHERY);
    }

    #[test]
    fn id_prefix_routes_detail_and_install_to_the_right_source() {
        assert_eq!(source_of_id("@amap/amap-maps"), SOURCE_MODELSCOPE);
        assert_eq!(source_of_id("tencent:10039"), SOURCE_TENCENT);
        assert_eq!(source_of_id("smithery:brave"), SOURCE_SMITHERY);
        assert_eq!(source_of_id("smithery:owner/name"), SOURCE_SMITHERY);
        // 官方源前缀已删除：不得被识别成任何特殊源（回落魔搭后按普通 id 处理）。
        assert_eq!(source_of_id("official:x"), SOURCE_MODELSCOPE);
        assert_eq!(source_of_id("featured:x"), SOURCE_MODELSCOPE);
    }

    #[test]
    fn tencent_token_auth_declaration_survives_normalize_and_preflight() {
        // 腾讯 http 型单头参数 → token 声明：必须原样穿过归一化 + build_entry
        // 白名单（tokenHeader/tokenPrefix/tokenLabel/tokenHelpUrl 都在 12 键内），
        // 否则「后端要授权、连接器 401 且无从下手」。
        let detail = json!({
            "id": "tencent:10039",
            "server_config": [{"mcpServers": {"maps": {
                "type": "streamable", "url": "https://m.example/mcp",
                "headers": {},
                "auth": {"authType": "token", "tokenHeader": "Authorization",
                          "tokenPrefix": "Bearer", "tokenLabel": "密钥", "tokenHelpUrl": "https://home"}
            }}}],
            "env_schema": Value::Null,
        });
        let entries = normalize_server_config(&detail, None).unwrap();
        assert_eq!(entries.len(), 1);
        let auth = entries[0].1.auth.as_ref().unwrap();
        assert_eq!(auth["tokenHeader"], json!("Authorization"));
        assert_eq!(auth["tokenPrefix"], json!("Bearer"));
        preflight_entries(&entries).expect("token 声明必须能通过 build_entry 白名单");
    }

    #[test]
    fn empty_server_config_from_new_sources_reports_manual_add_hint() {
        // 腾讯/Smithery 解析不出启动配置 → server_config:[]：install 必须明确
        // 报错并给「添加服务器」出口，绝不伪造成功、绝不猜配置。
        for id in ["tencent:9", "smithery:o/local"] {
            let detail = json!({"id": id, "server_config": [], "detail_page": "https://doc"});
            let err = match normalize_server_config(&detail, None) {
                Ok(_) => panic!("{}: 空 server_config 必须报错，不得伪造成功", id),
                Err(e) => e,
            };
            assert!(err.contains("添加服务器"), "{}: 错误必须引导手动添加: {}", id, err);
            assert!(err.contains("https://doc"), "{}: 错误须带文档链接: {}", id, err);
        }
        // 魔搭缺 server_config 的旧文案保持不变（历史契约）。
        let ms = json!({"id": "@a/b"});
        let err = match normalize_server_config(&ms, None) {
            Ok(_) => panic!("魔搭缺 server_config 必须报错"),
            Err(e) => e,
        };
        assert!(err.contains("魔搭"), "{}", err);
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

    /// 行为级回归：广场安装必须把目录展示元数据带进每一个 McpBody。
    ///
    /// 用户报障「连接器·已安装没有图片和名字，与技能·已安装显示不一致」的根因
    /// 就是 normalize 丢弃了 name/chinese_name/logo_url/description。这里真跑
    /// normalize + attach_catalog_meta 并逐字段断言，接线点被删会立刻红。
    #[test]
    fn mcp_market_install_carries_catalog_display_metadata() {
        let detail = json!({
            "name": "amap-maps",
            "chinese_name": "高德地图",
            "logo_url": "https://cdn.example.com/amap.png",
            "description": "高德地图 MCP 服务",
            "server_config": [{"mcpServers": {
                "amap": {"type": "sse", "url": "https://mcp.amap.com/sse"},
                "amap-local": {"command": "uvx", "args": ["amap-mcp"]}
            }}],
        });
        let mut entries = normalize_server_config(&detail, None).expect("合法详情应能归一化");
        attach_catalog_meta(&detail, "@amap/amap-maps", &mut entries);
        assert_eq!(entries.len(), 2, "多 server 条目每个都要带元数据");
        for (_name, body) in &entries {
            assert_eq!(body.display_name.as_deref(), Some("高德地图"), "chinese_name 优先");
            assert_eq!(body.icon_url.as_deref(), Some("https://cdn.example.com/amap.png"));
            assert_eq!(body.description.as_deref(), Some("高德地图 MCP 服务"));
            assert_eq!(body.market_id.as_deref(), Some("@amap/amap-maps"),
                "marketId 必须随每个条目落盘（广场卡片已安装态的唯一匹配口径）");
        }
        // 落盘层必须真的写进 settings 条目（build_entry 是 install 的必经之路）。
        let entry = crate::server::settings_api::build_entry_for_test(&entries[0].1, None)
            .expect("带元数据的 body 应能落盘");
        assert_eq!(entry["displayName"], json!("高德地图"));
        assert_eq!(entry["iconUrl"], json!("https://cdn.example.com/amap.png"));
        assert_eq!(entry["description"], json!("高德地图 MCP 服务"));
        assert_eq!(entry["marketId"], json!("@amap/amap-maps"),
            "build_entry 不透传 marketId 的话，广场已安装态永远匹配不上");
    }

    /// 元数据缺失/空白时不得写空串字段：前端回退目录名 + 首字母底，
    /// 空串会让「有字段但没内容」的卡片画出一张空白图。
    #[test]
    fn mcp_market_catalog_meta_absent_stays_none() {
        let detail = json!({
            "name": "  ",
            "logo_url": "",
            "server_config": [{"mcpServers": {"s": {"command": "uvx", "args": []}}}],
        });
        let mut entries = normalize_server_config(&detail, None).unwrap();
        attach_catalog_meta(&detail, "", &mut entries);
        let body = &entries[0].1;
        assert!(body.display_name.is_none());
        assert!(body.icon_url.is_none());
        assert!(body.description.is_none());
        assert!(body.market_id.is_none(), "空 marketId 不写空串字段");
        // 只有英文名时回退英文名，不能因为 chinese_name 缺失就整个不写。
        let en = json!({
            "name": "fetch",
            "server_config": [{"mcpServers": {"s": {"command": "uvx", "args": []}}}],
        });
        let mut e2 = normalize_server_config(&en, None).unwrap();
        attach_catalog_meta(&en, "", &mut e2);
        assert_eq!(e2[0].1.display_name.as_deref(), Some("fetch"));
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

    /// `hosted` 退役后的双重护栏：
    /// ① 上游 `filter.is_hosted` 键必须**始终存在**且恒为 `HOSTED_FILTER`
    ///    （键缺失会让上游改判语义；值非 false 会捞出 4806 条连不上的 hosted 条目）。
    /// ② `ServersParams` 不得再有 `hosted` 字段——旧书签/旧客户端传 `?hosted=true`
    ///    必须被静默忽略（serde 未知字段），而不是重新打开那条必败路径。
    #[test]
    fn hosted_filter_is_pinned_false_and_not_client_controllable() {
        assert!(!HOSTED_FILTER, "hosted 条目的连接 URL 需要 Bearer Token（未实现），只能是 false");
        let b = market::list_body("", 1, 20, "", HOSTED_FILTER);
        assert_eq!(b["filter"]["is_hosted"], json!(false),
            "上游靠 is_hosted 区分 7993/4806 条，键必须存在");

        // ②：带 hosted 的 query 反序列化后不得产生任何效果。
        let p: ServersParams = serde_json::from_value(json!({
            "search": "map", "hosted": "true", "page": "1"
        })).expect("未知字段必须被容忍，不能 400");
        assert_eq!(p.search.as_deref(), Some("map"));
        assert_eq!(p.page.as_deref(), Some("1"));
        let q = ServerQuery {
            search: p.search.unwrap_or_default(),
            page: parse_i64(p.page, 1),
            page_size: parse_i64(p.page_size, 20),
            category: p.category.unwrap_or_default(),
            hosted: HOSTED_FILTER,
        };
        assert!(!q.hosted, "?hosted=true 必须被忽略，不得变成 hosted 查询");
    }

    // ─── 修1/2/3/4 的纯函数级回归护栏 ────────────────────────────────────────
    //
    // mcp_server_add 依赖完整 AppState（engine 连接、settings 落盘），单测难以
    // 构造；因此后缀分配 / 预检 / connectErrors 收集都提取成了纯函数，这里
    // 直接钉行为。install 里的接线（先预检 → 再分配 → 循环收集）由预检必须
    // 使用 build_entry 同源判据 + 下方响应形状断言共同兜住。

    /// 修2：重名自动加后缀。魔搭条目 key 多为 fetch/time 等通用名，撞名是
    /// 常态：已存在 fetch → fetch-2；fetch-2 也存在 → fetch-3；同一批内部
    /// 两个 fetch 也不得互撞。name（tuple）与 body.name 必须同步改，否则
    /// installed 返回的名字与实际落盘名分叉，前端 auth 弹窗按错名字查询。
    #[test]
    fn mcp_market_assign_unique_names_suffixes_and_batch_dedup() {
        let detail = json!({"server_config": [{"mcpServers": {
            "fetch": {"command": "uvx", "args": ["mcp-server-fetch"]},
            "time": {"command": "uvx", "args": ["mcp-server-time"]}
        }}]});
        let mut entries = normalize_server_config(&detail, None).unwrap();
        // normalize 按 map 遍历，顺序不定；按名字排序稳定化后断言。
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        let mut taken: HashSet<String> =
            ["fetch".to_string(), "fetch-2".to_string(), "other".to_string()]
                .into_iter().collect();
        assign_unique_names(&mut entries, &mut taken);
        let fetch = entries.iter().find(|(n, _)| n.starts_with("fetch")).unwrap();
        assert_eq!(fetch.0, "fetch-3", "fetch 与 fetch-2 都被占，必须落到 fetch-3");
        assert_eq!(fetch.1.name, "fetch-3", "body.name 必须与落盘名同步");
        let time = entries.iter().find(|(n, _)| n.starts_with("time")).unwrap();
        assert_eq!(time.0, "time", "不冲突的名字不得被改名");
        assert_eq!(time.1.name, "time");
        assert!(taken.contains("fetch-3") && taken.contains("time"));

        // 同一批内部互撞：两个条目原名都叫 fetch（构造上上游 map 不可能同 key，
        // 但后缀可能撞上批内后续条目的原名——用「fetch 与 fetch-2」模拟）。
        let d2 = json!({"server_config": [{"mcpServers": {
            "fetch": {"command": "uvx", "args": []},
            "fetch-2": {"command": "uvx", "args": []}
        }}]});
        let mut e2 = normalize_server_config(&d2, None).unwrap();
        e2.sort_by(|a, b| a.0.cmp(&b.0));
        let mut taken2: HashSet<String> = ["fetch".to_string()].into_iter().collect();
        assign_unique_names(&mut e2, &mut taken2);
        let names: Vec<&str> = e2.iter().map(|(n, _)| n.as_str()).collect();
        // 规则是「冲突者基于**自己的原名**加后缀」：fetch → fetch-2；批内原名
        // fetch-2 的条目撞上已分配名 → fetch-2-2。名字唯一即可，installed
        // 返回真实落盘名，前端按返回名工作。
        assert_eq!(names, vec!["fetch-2", "fetch-2-2"],
            "批内互撞必须被消解（同名落盘会覆盖前一条目）");
        let uniq: HashSet<&str> = names.iter().copied().collect();
        assert_eq!(uniq.len(), names.len(), "落盘名必须两两不同");
        for (n, b) in &e2 {
            assert_eq!(n, &b.name);
        }
    }

    /// 修3：多条目预检。任一失败必须整体 Err（install 据此 400、零落盘），
    /// 且报错要指名是哪个条目。判据必须与 mcp_server_add 同源（build_entry），
    /// 不是归一化层另抄的校验。
    #[test]
    fn mcp_market_preflight_rejects_whole_batch_before_any_write() {
        // 全合法批：放行。
        let good = json!({"server_config": [{"mcpServers": {
            "a": {"command": "uvx", "args": []},
            "b": {"type": "sse", "url": "https://x/sse"}
        }}]});
        let entries = normalize_server_config(&good, None).unwrap();
        assert!(preflight_entries(&entries).is_ok());

        // 第二条 url 为空：normalize 不拦（url 空串合法归一化），build_entry
        // 会拒（URL 不能为空）。预检必须在这条上失败并指名 b —— 旧代码会先
        // 把 a 写盘、到 b 才失败，留下「部分安装」。
        let mixed = json!({"server_config": [{"mcpServers": {
            "a": {"command": "uvx", "args": []},
            "b": {"type": "sse", "url": ""}
        }}]});
        let entries = normalize_server_config(&mixed, None).unwrap();
        let err = match preflight_entries(&entries) {
            Err(e) => e,
            Ok(()) => panic!("含非法条目的批必须整体拒绝，否则 a 已落盘 = 部分安装"),
        };
        assert!(err.contains('b'), "报错要指名失败的条目: {}", err);
        // 与真正落盘判据同源的证明：同一条目直接过 build_entry 也必须失败。
        let bad = entries.iter().find(|(n, _)| n == "b").unwrap();
        assert!(crate::server::settings_api::build_entry_for_test(&bad.1, None).is_err());
    }

    /// 修1：connectErrors 收集。mcp_saved 的「已落盘但连不上」响应
    /// （code 200 + connected:false + connectError）必须被提取成
    /// {name, error}；连接成功 / 字段缺失不得误报。
    #[test]
    fn mcp_market_collect_connect_error_shapes() {
        // settings_api::mcp_saved 的真实失败形状。
        let failed = json!({
            "code": 200, "saved": true, "connected": false,
            "connectError": "spawn uvx ENOENT", "message": "spawn uvx ENOENT",
            "description": "spawn uvx ENOENT"
        });
        let e = collect_connect_error("fetch", &failed).expect("connected:false 必须被收集");
        assert_eq!(e["name"], json!("fetch"));
        assert_eq!(e["error"], json!("spawn uvx ENOENT"));

        // 连接成功：不收集。
        let ok = json!({"code": 200, "saved": true, "connected": true});
        assert!(collect_connect_error("fetch", &ok).is_none());
        // connected 字段缺失（旧内核/其他路径）：不当作失败。
        assert!(collect_connect_error("fetch", &json!({"code": 200})).is_none());
        // connected:false 但无 connectError：回退 message，再回退兜底文案，
        // 绝不静默丢弃（否则又是假成功）。
        let bare = json!({"code": 200, "connected": false, "message": "boom"});
        assert_eq!(collect_connect_error("t", &bare).unwrap()["error"], json!("boom"));
        let naked = json!({"code": 200, "connected": false});
        assert!(!collect_connect_error("t", &naked).unwrap()["error"]
            .as_str().unwrap().is_empty());
        // 缺运行时：missingCommand 必须转成结构化 runtime 字段（前端弹代装
        // 引导框的唯一依据）；不可代装的命令（blender）不得虚报 runtime。
        let missing_uv = json!({
            "code": 200, "connected": false,
            "connectError": "未找到命令 uvx：它由 uv (astral) 提供…",
            "missingCommand": "uvx"
        });
        let e = collect_connect_error("blender", &missing_uv).unwrap();
        assert_eq!(e["missingCommand"], json!("uvx"));
        assert_eq!(e["runtime"], json!("uv"));
        assert!(e["runtimeInstallable"].is_boolean());
        let missing_other = json!({
            "code": 200, "connected": false, "connectError": "x", "missingCommand": "blender"
        });
        let e2 = collect_connect_error("b", &missing_other).unwrap();
        assert!(e2.get("runtime").is_none(), "不可代装的命令不得虚报 runtime: {:?}", e2);
    }

    /// 修4：marketId 必须走「attach_catalog_meta → build_entry」全链路落盘，
    /// 且 update 语义保留（编辑表单不提交 marketId，不保留就每编辑一次丢一次
    /// 已安装标记）。
    #[test]
    fn mcp_market_market_id_survives_build_entry_and_update() {
        let detail = json!({
            "name": "fetch",
            "server_config": [{"mcpServers": {"fetch": {"command": "uvx", "args": []}}}],
        });
        let mut entries = normalize_server_config(&detail, None).unwrap();
        attach_catalog_meta(&detail, "@modelscope/fetch", &mut entries);
        let entry = crate::server::settings_api::build_entry_for_test(&entries[0].1, None).unwrap();
        assert_eq!(entry["marketId"], json!("@modelscope/fetch"));
        // update（不带 marketId 的部分提交）必须保留已存的 marketId。
        let partial = McpBody {
            name: "fetch".into(),
            kind: "stdio".into(),
            command: Some("uvx".into()),
            ..McpBody::default()
        };
        let updated = crate::server::settings_api::build_entry_for_test(&partial, Some(&entry)).unwrap();
        assert_eq!(updated["marketId"], json!("@modelscope/fetch"),
            "编辑一次就丢 marketId 的话，广场已安装态会随每次编辑消失");
        // 手动添加（无 marketId、无 existing）不得凭空造出该字段。
        let manual = crate::server::settings_api::build_entry_for_test(&partial, None).unwrap();
        assert!(manual.get("marketId").is_none());
    }
}
