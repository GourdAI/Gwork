//! `mcp::market` — 魔搭 ModelScope MCP 广场适配器（连接器页的**唯一**内置目录源）。
//!
//! 上游契约（实测，匿名可用，无需 Token）：
//! * 列表/搜索：`PUT https://www.modelscope.cn/openapi/v1/mcp/servers`
//!   body `{"search":"","page_number":1,"page_size":20,"filter":{"category":"","tag":"","is_hosted":false}}`
//!   硬限制 `page_number * page_size <= 100`。
//! * 详情：`GET https://www.modelscope.cn/openapi/v1/mcp/servers/{id}`，`{id}` 含 `@` 与 `/`，
//!   必须把整个 id 当作**单个路径段**做百分号编码（`@amap/amap-maps` → `%40amap%2Famap-maps`）。
//!
//! 明确不做：官方 Registry、自定义源、多源、Hosted 专属连接 URL（那需要 Bearer Token，
//! 属于 deploy / operational 范畴，本轮不实现）。
//!
//! 本模块只负责「上游 HTTP + 纯数据变换」；落盘由 `server::mcp_market_api` 复用
//! `settings_api::mcp_server_add`，不在这里复制写文件逻辑。

use async_trait::async_trait;
use serde_json::{json, Value};

pub const LIST_URL: &str = "https://www.modelscope.cn/openapi/v1/mcp/servers";
pub const USER_AGENT: &str = "GourdWorkDesktop/0.3 (+MCP Market)";
pub const MAX_SCAN: i64 = 100;

/// 详情 URL。id 整体编码为一个路径段，避免 `@scope/name` 里的 `/` 被当成路径分隔。
pub fn detail_url(id: &str) -> String {
    format!("{}/{}", LIST_URL, encode_path_segment(id.trim()))
}

/// RFC 3986 路径段编码：只保留 unreserved 字符，其余（含 `@` `/`）全部 `%XX`。
pub fn encode_path_segment(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() * 2);
    for b in raw.as_bytes() {
        let unreserved = b.is_ascii_alphanumeric()
            || matches!(*b, b'-' | b'_' | b'.' | b'~');
        if unreserved {
            out.push(*b as char);
        } else {
            out.push_str(&format!("%{:02X}", *b));
        }
    }
    out
}

/// 分页钳制：`1 <= page_size <= 100` 且 `page * page_size <= 100`。
/// 上游对越界请求直接报错，因此这里在发请求前就把窗口收进允许范围。
pub fn clamp_paging(page: i64, page_size: i64) -> (i64, i64) {
    let size = if page_size < 1 { 20 } else { page_size.min(MAX_SCAN) };
    let max_page = (MAX_SCAN / size).max(1);
    let p = if page < 1 { 1 } else { page.min(max_page) };
    (p, size)
}

/// 列表请求体。`is_hosted` 是上游 filter 的布尔位；匿名列表不需要任何鉴权头。
///
/// ⚠ 上游契约（2026 实测，与直觉相反，务必保留）：
/// * `filter` 里出现**空串 `category` 键**会让上游直接返回 `total_count = 0`
///   （`{"filter":{}}` → 12799；`{"filter":{"category":""}}` → 0；
///     `{"filter":{"category":"search"}}` → 1538）。
///   因此 category 为空时**必须整键省略**，绝不能发空串，否则「全部」分类永远空白。
/// * `tag: ""` 无害（实测仍 12799），但同样按「空则不发」处理，避免上游将来改语义。
/// * `is_hosted` 语义正常：false → 7993，true → 4806，两者相加 = 12799。
pub fn list_body(search: &str, page: i64, page_size: i64, category: &str, hosted: bool) -> Value {
    let (page, size) = clamp_paging(page, page_size);
    let mut filter = serde_json::Map::new();
    let cat = category.trim();
    if !cat.is_empty() {
        filter.insert("category".into(), json!(cat));
    }
    filter.insert("is_hosted".into(), json!(hosted));
    json!({
        "search": search,
        "page_number": page,
        "page_size": size,
        "filter": Value::Object(filter),
    })
}

/// 内置静态分类表。上游没有聚合接口，**绝不逐类发请求凑计数**：计数直接用列表
/// 响应里的 `total_count`，分类只作为筛选条件传给 `filter.category`。
///
/// ⚠ key 必须是**上游真实存在的 category 取值**，不能凭直觉命名。上游对不认识的
/// `filter.category` 不报错、只静默返回 `total_count = 0`，于是该 chip 变成
/// 「点进去永远空白」的死按钮 —— 这类缺陷在 mock 单测里完全测不出来。
///
/// 下表 18 个 key 全部经 2026-11 上游实测（`is_hosted=false`）逐个确认非零，
/// 并按结果数降序排列；括号内为实测 total_count，仅作维护参考（计数会随上游
/// 收录变化而漂移，不要当断言用）：
///   developer-tools(2644) search(1089) other(542) browser-automation(531)
///   databases(469) knowledge-and-memory(460) research-and-data(424)
///   communication(425) file-systems(359) finance(307) cloud-platforms(289)
///   os-automation(258) entertainment-and-media(229) image-and-video-processing(212)
///   note-taking(206) version-control(191) location-services(163)
///   art-and-culture(90)
/// 曾出现过、现已剔除的死 key（实测 0 或个位数，属上游脏数据）：
///   `data-analytics`(0) `location-and-maps`(0) `ai-and-ml`(0)
///   `productivity`(1) `security`(2) `AIGC`(3) `Knowledge&Memory`(1，大小写变体)
/// 注意「位置与地图」的正确 key 是 `location-services`，不是想当然的 `location-and-maps`。
pub fn categories() -> Value {
    json!([
        {"key": "",                            "nameZh": "全部",           "name": "All"},
        {"key": "developer-tools",             "nameZh": "开发者工具",     "name": "Developer Tools"},
        {"key": "search",                      "nameZh": "搜索工具",       "name": "Search"},
        {"key": "other",                       "nameZh": "其他",           "name": "Other"},
        {"key": "browser-automation",          "nameZh": "浏览器自动化",   "name": "Browser Automation"},
        {"key": "databases",                   "nameZh": "数据库",         "name": "Databases"},
        {"key": "knowledge-and-memory",        "nameZh": "知识管理与记忆", "name": "Knowledge & Memory"},
        {"key": "research-and-data",           "nameZh": "研究与数据",     "name": "Research & Data"},
        {"key": "communication",               "nameZh": "交流协作工具",   "name": "Communication"},
        {"key": "file-systems",                "nameZh": "文件系统",       "name": "File Systems"},
        {"key": "finance",                     "nameZh": "金融",           "name": "Finance"},
        {"key": "cloud-platforms",             "nameZh": "云平台",         "name": "Cloud Platforms"},
        {"key": "os-automation",               "nameZh": "系统自动化",     "name": "OS Automation"},
        {"key": "entertainment-and-media",     "nameZh": "娱乐与多媒体",   "name": "Entertainment & Media"},
        {"key": "image-and-video-processing",  "nameZh": "图像与视频处理", "name": "Image & Video"},
        {"key": "note-taking",                 "nameZh": "笔记",           "name": "Note Taking"},
        {"key": "version-control",             "nameZh": "版本控制",       "name": "Version Control"},
        {"key": "location-services",           "nameZh": "位置与地图",     "name": "Location Services"},
        {"key": "art-and-culture",             "nameZh": "艺术与文化",     "name": "Art & Culture"},
    ])
}

/// 已实测为 0（或个位数脏数据）的分类 key。**禁止**再出现在 `categories()` 里，
/// 否则对应 chip 点进去永远空白。由 `mcp_market_categories_contain_no_dead_keys` 守护。
pub const DEAD_CATEGORY_KEYS: &[&str] = &[
    "data-analytics",
    "location-and-maps",
    "ai-and-ml",
    "productivity",
    "security",
    "AIGC",
    "Knowledge&Memory",
];

/// 统一响应信封：成功 `description` 必须是空串；失败一律 400，不伪造成功。
pub fn succeed(data: Value) -> Value {
    json!({"code": 200, "description": "", "data": data})
}

/// 失败信封。上游失败、解析失败、参数缺失都走这里。
pub fn failure(msg: impl Into<String>) -> Value {
    json!({"code": 400, "description": msg.into()})
}

// ─── 上游传输 ────────────────────────────────────────────────────────────────

/// 上游 JSON 响应体上限，与 `skills::market::MAX_API_BODY_BYTES` 同级加固。
///
/// 详情接口的 `readme` 实测近 5 万字符，正常远不到这个量级；但上游异常或被劫持
/// 镜像返回超大 JSON 时，`resp.json::<Value>()` 会无上限全量解析直至 OOM
/// （`unpack` 里的 `data.clone()` 还会让峰值再翻一倍）。超限一律**报错**，
/// 绝不返回截断体：半个 JSON 无法解析，且会被 `unpack` 误判成上游返回了
/// `success=false`，把一个 DoS 防护伪装成业务失败。
pub const MAX_API_BODY_BYTES: usize = 16 * 1024 * 1024;

/// 流式读取响应体，拒绝缓冲超过 `cap` 的字节。
///
/// `Ok(None)` 表示超限。与 `skills::market::read_capped` 同构（而非直接复用），
/// 因为那个函数是私有的；两处逻辑必须保持一致，改一处要同步另一处。
async fn read_capped(resp: reqwest::Response, cap: usize) -> reqwest::Result<Option<Vec<u8>>> {
    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if buf.len() + chunk.len() > cap {
            return Ok(None);
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(Some(buf))
}

/// 读取带体积上限的 JSON 响应体。
///
/// `what` 只用于拼装与加固前**逐字一致**的中文错误文案，避免前端/测试对
/// 错误串的断言因为这次加固而静默失效。
async fn capped_json(resp: reqwest::Response, cap: usize, what: &str) -> Result<(u16, Value), String> {
    let status = resp.status().as_u16();
    let Some(bytes) = read_capped(resp, cap).await.map_err(|e| format!("解析{what}响应失败: {e}"))?
    else {
        return Err(format!(
            "解析{what}响应失败: 响应体超过 {} 字节上限，已拒绝（疑似上游异常）",
            cap
        ));
    };
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("解析{what}响应失败: {e}"))?;
    Ok((status, value))
}

/// 只声明本模块真正用到的两个动词（PUT 列表 / GET 详情）。
/// 与 `skills::market::MarketHttp` 分开，避免为了 PUT 去改既有 trait 的行为。
#[async_trait]
pub trait McpMarketHttp: Send + Sync {
    async fn put_json(&self, url: &str, body: &Value) -> Result<(u16, Value), String>;
    async fn get_json(&self, url: &str) -> Result<(u16, Value), String>;
}

/// 生产传输：自带最小 reqwest client，10s 超时，UA 标为桌面应用。
pub struct ReqwestMcpMarketHttp {
    client: reqwest::Client,
}

impl ReqwestMcpMarketHttp {
    pub fn new() -> Self {
        // `Client::builder().build()` 只在 TLS 后端初始化失败时出错，且失败是
        // **持久**的（重试也一样）。这里用进程级单例：① 连接池得以复用，翻页/
        // 搜索防抖下不再每次重新 TLS 握手；② `expect` 只在 Lazy 首次解引用时
        // 执行一次，落在常量路径上，不再是「每次请求都可能 panic 整个进程」——
        // 那会绕过本模块 `failure()` 统一信封的契约。
        // 与 `skills::market` 的单例做法保持一致。
        static CLIENT: once_cell::sync::Lazy<reqwest::Client> = once_cell::sync::Lazy::new(|| {
            reqwest::Client::builder()
                .user_agent(USER_AGENT)
                .connect_timeout(std::time::Duration::from_secs(10))
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .expect("reqwest mcp market client")
        });
        Self { client: CLIENT.clone() }
    }
}

impl Default for ReqwestMcpMarketHttp {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl McpMarketHttp for ReqwestMcpMarketHttp {
    async fn put_json(&self, url: &str, body: &Value) -> Result<(u16, Value), String> {
        let resp = self
            .client
            .put(url)
            .header("User-Agent", USER_AGENT)
            .json(body)
            .send()
            .await
            .map_err(|e| format!("请求魔搭 MCP 广场失败: {}", e))?;
        capped_json(resp, MAX_API_BODY_BYTES, "魔搭 MCP 广场").await
    }

    async fn get_json(&self, url: &str) -> Result<(u16, Value), String> {
        let resp = self
            .client
            .get(url)
            .header("User-Agent", USER_AGENT)
            .send()
            .await
            .map_err(|e| format!("请求魔搭 MCP 服务详情失败: {}", e))?;
        capped_json(resp, MAX_API_BODY_BYTES, "魔搭 MCP 服务详情").await
    }
}

/// 列表查询条件（由 handler 从 query string 组装）。
#[derive(Debug, Clone, Default)]
pub struct ServerQuery {
    pub search: String,
    pub page: i64,
    pub page_size: i64,
    pub category: String,
    pub hosted: bool,
}

/// 单一上游适配器。泛型传输便于单测用 mock，不触网。
pub struct ModelscopeMcpMarket<H: McpMarketHttp> {
    http: H,
}

impl<H: McpMarketHttp> ModelscopeMcpMarket<H> {
    pub fn new(http: H) -> Self {
        Self { http }
    }

    /// 校验上游信封。`success:false`、非 2xx、缺 `data` 都是失败，绝不降级成空成功。
    fn unpack(status: u16, body: Value) -> Result<Value, String> {
        if !(200..300).contains(&status) {
            return Err(format!("魔搭 MCP 广场返回 HTTP {}", status));
        }
        if body.get("success").and_then(Value::as_bool) != Some(true) {
            let msg = body
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("魔搭 MCP 广场返回 success=false");
            return Err(msg.to_string());
        }
        match body.get("data") {
            Some(d) if d.is_object() => Ok(d.clone()),
            _ => Err("魔搭 MCP 广场响应缺少 data".into()),
        }
    }

    /// `PUT /openapi/v1/mcp/servers` → `{total_count, mcp_server_list, page_number, page_size}`。
    pub async fn servers(&self, q: &ServerQuery) -> Result<Value, String> {
        let body = list_body(
            &q.search,
            q.page,
            q.page_size,
            &q.category,
            q.hosted,
        );
        let (status, raw) = self.http.put_json(LIST_URL, &body).await?;
        let data = Self::unpack(status, raw)?;
        let (page, size) = clamp_paging(q.page, q.page_size);
        Ok(json!({
            "total_count": data.get("total_count").cloned().unwrap_or(json!(0)),
            "mcp_server_list": data.get("mcp_server_list").cloned().unwrap_or(json!([])),
            "page_number": page,
            "page_size": size,
        }))
    }

    /// `GET /openapi/v1/mcp/servers/{id}` → 上游 `data`（server_config / env_schema / readme …）。
    pub async fn detail(&self, id: &str) -> Result<Value, String> {
        if id.trim().is_empty() {
            return Err("id is required".into());
        }
        let (status, raw) = self.http.get_json(&detail_url(id)).await?;
        let mut data = Self::unpack(status, raw)?;
        // env_schema 可能是 JSON 字符串；统一成对象，前端表单不必分叉。
        // 2026-11 上游实测样本全是对象，字符串分支是防御性的。
        //
        // ⚠ 解析失败**必须报错**，不能静默保留原字符串：那样 `resolve_env` 的
        // `.get("properties")` 拿到 None → allowed/required 双双为空 → 用户填的
        // 密钥被静默丢弃、安装却报成功、服务连不上且无从排查（与 http+env guard
        // 防的是同一种「伪造成功」）。空串视为「无 schema」照常放行，不得误伤无
        // env 的服务。
        if let Some(s) = data.get("env_schema").and_then(Value::as_str) {
            if s.trim().is_empty() {
                data["env_schema"] = Value::Null;
            } else {
                match serde_json::from_str::<Value>(s) {
                    Ok(parsed) => data["env_schema"] = parsed,
                    Err(e) => {
                        return Err(format!("解析魔搭 MCP 服务的 env_schema 失败: {}", e));
                    }
                }
            }
        }
        Ok(data)
    }

    pub fn categories(&self) -> Value {
        categories()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn mcp_market_detail_url_encodes_scope_and_slash_as_one_segment() {
        assert_eq!(
            detail_url("@amap/amap-maps"),
            format!("{}/%40amap%2Famap-maps", LIST_URL)
        );
        assert_eq!(
            encode_path_segment("@modelcontextprotocol/fetch"),
            "%40modelcontextprotocol%2Ffetch"
        );
        assert_eq!(LIST_URL, "https://www.modelscope.cn/openapi/v1/mcp/servers");
    }

    #[test]
    fn mcp_market_paging_is_clamped_below_the_upstream_window() {
        assert_eq!(clamp_paging(1, 20), (1, 20));
        assert_eq!(clamp_paging(6, 20), (5, 20)); // 5*20 = 100
        assert_eq!(clamp_paging(3, 40), (2, 40)); // 2*40 = 80 <= 100
        assert_eq!(clamp_paging(2, 100), (1, 100));
        assert_eq!(clamp_paging(1, 500), (1, 100));
        assert_eq!(clamp_paging(0, 0), (1, 20));
        let body = list_body("地图", 6, 20, "search", true);
        assert_eq!(body["page_number"], json!(5));
        assert_eq!(body["page_size"], json!(20));
        assert_eq!(body["filter"]["category"], json!("search"));
        assert_eq!(body["filter"]["is_hosted"], json!(true));
    }

    /// P0 回归护栏：上游收到空串 `category` 键会返回 `total_count = 0`。
    /// 实测 `{"filter":{}}` → 12799，`{"filter":{"category":""}}` → 0。
    /// 所以「全部」分类必须**整键省略**，否则连接器页首屏永远空白。
    /// 这条断言正是当初缺失的那一道：MockHttp 返回预设值，测不出上游真实语义。
    #[test]
    fn mcp_market_empty_category_must_be_omitted_not_sent_as_empty_string() {
        let all = list_body("", 1, 20, "", false);
        assert!(
            all["filter"].get("category").is_none(),
            "空串 category 会让上游返回 total_count=0，必须省略该键，实际: {}",
            all["filter"]
        );
        assert_eq!(all["filter"]["is_hosted"], json!(false));

        // 纯空白同样视为未选分类
        let blank = list_body("", 1, 20, "   ", false);
        assert!(blank["filter"].get("category").is_none(), "空白 category 也必须省略");

        // 真正选了分类时才发该键，且原值不被 trim 破坏语义。
        // 用 location-services（实测 163 条的真实 key），不要用已剔除的 location-and-maps。
        let picked = list_body("", 1, 20, "location-services", false);
        assert_eq!(picked["filter"]["category"], json!("location-services"));

        // hosted 开关必须始终存在（上游靠它区分 7993 / 4806）
        assert_eq!(list_body("", 1, 20, "", true)["filter"]["is_hosted"], json!(true));
    }

    /// P0 回归护栏：上游对**不认识的** `filter.category` 不报错，只静默返回
    /// `total_count = 0`，于是那个分类 chip 变成「点进去永远空白」的死按钮。
    /// mock 单测测不出这种缺陷（mock 不知道上游真实词表），所以这里把
    /// 2026-11 上游实测结论钉成常量黑名单 + 白名单校验。
    #[test]
    fn mcp_market_categories_contain_no_dead_keys() {
        let cats = categories();
        let arr = cats.as_array().expect("categories 必须是数组");
        // 第一项固定是「全部」（key 为空串，走整键省略路径）
        assert_eq!(arr[0]["key"], json!(""), "首项必须是「全部」且 key 为空");

        let mut seen: HashSet<String> = HashSet::new();
        for c in arr.iter().skip(1) {
            let key = c["key"].as_str().unwrap_or("").to_string();
            assert!(!key.is_empty(), "非首项的 key 不得为空");
            assert!(seen.insert(key.clone()), "分类 key 重复: {}", key);
            assert!(
                !DEAD_CATEGORY_KEYS.contains(&key.as_str()),
                "分类 {} 已被上游实测为死 key（total_count=0/脏数据），会让 chip 点进去永远空白。
                 正确 key 参见 categories() 的文档注释（例如位置与地图是 location-services，
                 不是 location-and-maps；数据分析是 research-and-data，不是 data-analytics）。",
                key
            );
            // 每个分类都必须有中英文名，否则非中文界面会露出空 chip
            assert!(!c["name"].as_str().unwrap_or("").is_empty(), "{} 缺英文名", key);
            assert!(!c["nameZh"].as_str().unwrap_or("").is_empty(), "{} 缺中文名", key);
        }

        // 上游实测存在的真实分类必须都在表里（缺一个就少一个可用筛选维度）
        let real = [
            "developer-tools", "search", "other", "browser-automation", "databases",
            "knowledge-and-memory", "research-and-data", "communication", "file-systems",
            "finance", "cloud-platforms", "os-automation", "entertainment-and-media",
            "image-and-video-processing", "note-taking", "version-control",
            "location-services", "art-and-culture",
        ];
        for k in real {
            assert!(seen.contains(k), "上游实测存在的分类 {} 缺失于 categories()", k);
        }
    }

    #[test]
    fn mcp_market_failure_envelope_never_reports_success() {
        let f = failure("upstream down");
        assert_eq!(f["code"], json!(400));
        assert_eq!(f["description"], json!("upstream down"));
        assert!(f.get("data").is_none());
        let s = succeed(json!({"ok": true}));
        assert_eq!(s["code"], json!(200));
        assert_eq!(s["description"], json!(""));
    }
}
