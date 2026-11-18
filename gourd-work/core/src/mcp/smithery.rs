//! `mcp::smithery` — Smithery 注册表适配器（连接器目录源之三，境外源）。
//!
//! 来源：SolonCode v2026.11.16 连接器市场的备选源（`SmitheryMcpMarket.java`），
//! 本模块按同一份上游契约用 Rust 实现，输出与 `mcp::market`（魔搭）同形状。
//!
//! 上游契约（实测，匿名 GET）：
//! * `GET https://registry.smithery.ai/servers?page=&pageSize=`（pageSize≤100，
//!   按热度排序，2 万+条）→ `{servers:[...], pagination:{totalPages,totalCount}}`。
//! * `GET .../servers/{qualifiedName}`（`owner/name` 的斜杠**不得**编码成 %2F）
//!   → `{qualifiedName, connections[], configSchema, tools[]}`；不存在返回 `{"error":...}`。
//!
//! 关键事实（与 SolonCode 同源结论）：
//! * **没有服务端搜索**：`?q=` 返回 500。关键词检索 = 抓热度前 5 页×100 条建
//!   本地索引（TTL 10 分钟）过滤，分页对索引切片。
//!   2026-11 codereview 性能加固：5 页**并行**抓取（重建 ≈ 单页 RTT 而非
//!   5×RTT）；并发搜索**单飞**共享同一次重建（Notify 等待，不各自抓网）；
//!   重建失败进入 30s 退避（境外源不可达时每次搜索不再撞满 5 页超时）。
//! * 托管连接（`*.run.tools` / `*.smithery.run`）需 `Authorization: Bearer <key>`。
//!   这里转成 `auth:{authType:"token"}` 声明（默认 header/prefix 恰为
//!   Authorization/Bearer），凭据走 CredentialVault，settings.json 不落密钥、
//!   URL 不拼 api_key（防网关日志/复制粘贴泄露）。
//! * 非 http 的 connection 是 `.mcpb` bundle，需下载执行，本内核不支持 →
//!   跳过该 connection（全部是 bundle 时 server_config 为空，install 明确报错）。
//! * configSchema 的参数属于平台侧配置（托管连接以 config 包体下发），
//!   env/headers 承载不了 → 不进 env_schema（否则索要了却无处保存）。

use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Notify};

use super::market::ServerQuery;
use super::market_http;

pub const BASE_URL: &str = "https://registry.smithery.ai";
pub const PAGE_SIZE_MAX: i64 = 100;
/// 本地搜索索引：热度前 5 页 × 100 条，TTL 10 分钟（SolonCode 同参数）。
const SEARCH_SCAN_PAGES: i64 = 5;
const SEARCH_INDEX_TTL: Duration = Duration::from_secs(600);
/// 索引构建失败后的重试退避。没有它，境外上游不可达时**每次搜索**都会串行
/// 撞满 5 页 × 10s 超时（最坏 ~50s/次），且前端防抖下的连续击键会排队放大。
const SEARCH_FAIL_BACKOFF: Duration = Duration::from_secs(30);

/// Smithery 无分类维度：只有「全部」一项（前端分类栏退化为单 chip）。
pub fn categories() -> Value {
    json!([{"key": "", "nameZh": "全部", "name": "All"}])
}

#[async_trait::async_trait]
pub trait SmitheryHttp: Send + Sync {
    async fn get_json(&self, url: &str) -> Result<(u16, Value), String>;
}

pub struct ReqwestSmitheryHttp;

#[async_trait::async_trait]
impl SmitheryHttp for ReqwestSmitheryHttp {
    async fn get_json(&self, url: &str) -> Result<(u16, Value), String> {
        market_http::get_json(url, market_http::USER_AGENT, "Smithery 注册表").await
    }
}

/// qualifiedName 路径编码：保留 `/`（owner/name），其余按路径段编码。
pub fn detail_url(id: &str) -> String {
    let encoded: String = id
        .trim()
        .split('/')
        .map(super::market::encode_path_segment)
        .collect::<Vec<_>>()
        .join("/");
    format!("{}/servers/{}", BASE_URL, encoded)
}

pub fn list_url(page: i64, size: i64) -> String {
    format!("{}/servers?page={}&pageSize={}", BASE_URL, page.max(1), size.clamp(1, PAGE_SIZE_MAX))
}

/// 列表条目 → 魔搭同形状（id 带 `smithery:` 前缀）。
pub fn to_item(node: &Value) -> Option<Value> {
    let qn = node.get("qualifiedName").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())?;
    let short = qn.rsplit('/').next().unwrap_or(qn);
    let display = node
        .get("displayName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(short);
    Some(json!({
        "id": format!("smithery:{}", qn),
        "name": display,
        "chinese_name": "",
        "description": node.get("description").and_then(Value::as_str).unwrap_or(""),
        "logo_url": node.get("iconUrl").and_then(Value::as_str).unwrap_or(""),
        "view_count": node.get("useCount").cloned().unwrap_or(json!(0)),
        "is_verified": node.get("verified").and_then(Value::as_bool).unwrap_or(false),
        "publisher": node.get("namespace").and_then(Value::as_str).unwrap_or(""),
        "homepage": node.get("homepage").and_then(Value::as_str).unwrap_or(""),
        "categories": [],
        "auth_kind": if is_hosted_url(node.get("deploymentUrl").and_then(Value::as_str).unwrap_or("")) { "token" } else { "" },
    }))
}

/// 托管域名判定：*.run.tools / *.smithery.run 必须 Bearer 鉴权。
pub fn is_hosted_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else { return false };
    let Some(host) = parsed.host_str() else { return false };
    let h = host.to_ascii_lowercase();
    h == "run.tools" || h.ends_with(".run.tools") || h == "smithery.run" || h.ends_with(".smithery.run")
}

/// 落盘服务名：qualifiedName 尾段合法化（[a-z0-9_-]≤48）。
pub fn server_key(qn: &str) -> String {
    super::tencent::sanitize_name(qn.rsplit('/').next().unwrap_or(qn))
}

struct SearchIndex {
    built_at: Instant,
    /// (item, haystack)
    rows: Vec<(Value, String)>,
}

/// 索引缓存态。`Arc` 让搜索路径把索引快照带出锁外切片（不持锁做 CPU 工作）；
/// `failed` 是失败退避窗口；`building` + `Notify` 组成单飞：TTL 到期后并发
/// 搜索只有一个重建者，其余等待复用，而不是各自再抓 5 页上游。
#[derive(Default)]
struct IndexCache {
    index: Option<Arc<SearchIndex>>,
    failed: Option<(Instant, String)>,
    building: bool,
}

pub struct SmitheryMcpMarket<H: SmitheryHttp> {
    http: H,
    cache: Mutex<IndexCache>,
    built: Notify,
}

impl<H: SmitheryHttp> SmitheryMcpMarket<H> {
    pub fn new(http: H) -> Self {
        Self { http, cache: Mutex::new(IndexCache::default()), built: Notify::new() }
    }

    fn unpack(status: u16, body: Value) -> Result<Value, String> {
        if !(200..300).contains(&status) {
            return Err(format!("Smithery 注册表返回 HTTP {}", status));
        }
        if let Some(e) = body.get("error").and_then(Value::as_str) {
            return Err(format!("Smithery 注册表返回错误: {}", e));
        }
        Ok(body)
    }

    /// 列表/搜索 → 魔搭同形状。浏览 = 上游页码直传；搜索 = 本地索引切片
    /// （page 语义对索引同样成立：offset=(page-1)*size）。
    pub async fn servers(&self, q: &ServerQuery) -> Result<Value, String> {
        let page = q.page.max(1);
        let size = q.page_size.clamp(1, PAGE_SIZE_MAX);
        let kw = q.search.trim().to_ascii_lowercase();
        if !kw.is_empty() {
            return self.search_local(&kw, page, size).await;
        }
        let (status, raw) = self.http.get_json(&list_url(page, size)).await?;
        let data = Self::unpack(status, raw)?;
        let items: Vec<Value> = data
            .get("servers")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(to_item).collect())
            .unwrap_or_default();
        let total = data
            .get("pagination")
            .and_then(|p| p.get("totalCount"))
            .and_then(Value::as_i64)
            .unwrap_or(items.len() as i64);
        Ok(json!({
            "total_count": total,
            "mcp_server_list": items,
            "page_number": page,
            "page_size": size,
        }))
    }

    async fn search_local(&self, kw: &str, page: i64, size: i64) -> Result<Value, String> {
        let idx = self.ensure_index().await?;
        // 切片在锁外做：Arc 快照不阻塞并发的索引重建/其他搜索。
        let tokens: Vec<&str> = kw.split_whitespace().filter(|t| !t.is_empty()).collect();
        let matched: Vec<&Value> = idx
            .rows
            .iter()
            .filter(|(_, hay)| tokens.iter().all(|t| hay.contains(t)))
            .map(|(item, _)| item)
            .collect();
        let offset = ((page - 1) * size) as usize;
        let items: Vec<Value> = matched.iter().skip(offset).take(size as usize).map(|v| (*v).clone()).collect();
        Ok(json!({
            "total_count": matched.len(),
            "mcp_server_list": items,
            "page_number": page,
            "page_size": size,
        }))
    }

    /// 索引获取的统一入口：新鲜命中直接复用；失败退避窗口内直接报错（不触网）；
    /// 需要重建时单飞 —— 只有第一个请求真正抓上游，并发请求等 `Notify` 复用结果。
    ///
    /// 性能背景（2026-11 codereview）：Smithery 是境外源，旧实现 TTL 到期后每个
    /// 并发搜索都各自**串行**抓 5 页，最坏 5×10s；连续击键（前端 300ms 防抖）会把
    /// 重建排队放大成几十次上游抓取。现在：重建一次 ≈ 单页 RTT（并行抓页），
    /// 并发共享，失败 30s 内不再重试。
    async fn ensure_index(&self) -> Result<Arc<SearchIndex>, String> {
        loop {
            let mut cache = self.cache.lock().await;
            if let Some(idx) = &cache.index {
                if idx.built_at.elapsed() < SEARCH_INDEX_TTL {
                    return Ok(idx.clone());
                }
            }
            if let Some((at, err)) = &cache.failed {
                if at.elapsed() < SEARCH_FAIL_BACKOFF {
                    return Err(err.clone());
                }
            }
            if cache.building {
                // 别的请求正在重建：等它完成再回到循环顶部取结果（防丢通知：
                // 先注册 notified 再放锁）。
                let notified = self.built.notified();
                drop(cache);
                notified.await;
                continue;
            }
            cache.building = true;
            drop(cache);
            let result = self.build_index().await;
            let mut cache = self.cache.lock().await;
            cache.building = false;
            match &result {
                Ok(idx) => {
                    cache.index = Some(idx.clone());
                    cache.failed = None;
                }
                Err(e) => cache.failed = Some((Instant::now(), e.clone())),
            }
            drop(cache);
            self.built.notify_waiters();
            return result;
        }
    }

    /// 抓热度前 5 页建索引：**并行**发出（同 host 连接池复用），按页序合并保持
    /// 热度排序；遇到不满页即截断其后所有页（上游已到末尾）。
    async fn build_index(&self) -> Result<Arc<SearchIndex>, String> {
        let pages = (1..=SEARCH_SCAN_PAGES).map(|p| async move {
            let (status, raw) = self.http.get_json(&list_url(p, 100)).await?;
            let data = Self::unpack(status, raw)?;
            Ok::<Vec<Value>, String>(
                data.get("servers").and_then(Value::as_array).cloned().unwrap_or_default(),
            )
        });
        let fetched = futures_util::future::join_all(pages).await;
        let mut rows = Vec::new();
        for page in fetched {
            let servers = page?;
            let full = servers.len() as i64 == 100;
            for node in servers {
                if let Some(item) = to_item(&node) {
                    let haystack = format!(
                        "{} {} {} {}",
                        item["id"].as_str().unwrap_or(""),
                        item["name"].as_str().unwrap_or(""),
                        item["description"].as_str().unwrap_or(""),
                        item["publisher"].as_str().unwrap_or(""),
                    )
                    .to_ascii_lowercase();
                    rows.push((item, haystack));
                }
            }
            if !full {
                break;
            }
        }
        Ok(Arc::new(SearchIndex { built_at: Instant::now(), rows }))
    }

    /// 详情 → 魔搭同形状。connections 里取**第一个 http 家族**接入方式；
    /// bundle-only → server_config 空数组（install 明确报错，不猜配置）。
    pub async fn detail(&self, id: &str) -> Result<Value, String> {
        let qn = id.trim().trim_start_matches("smithery:");
        if qn.is_empty() {
            return Err("id is required".into());
        }
        let (status, raw) = self.http.get_json(&detail_url(qn)).await?;
        let node = Self::unpack(status, raw)?;
        if node.get("qualifiedName").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).is_none() {
            return Err(format!("连接器不存在: {}", id));
        }
        let mut item = to_item(&node).ok_or_else(|| format!("连接器不存在: {}", id))?;
        item["id"] = json!(format!("smithery:{}", qn));
        // Smithery 无 readme 正文；用 description + 工具清单拼一份可读文档。
        item["readme"] = json!(build_readme(&node));
        item["locales"] = json!({});
        item["detail_page"] = json!(format!("https://smithery.ai/servers?q={}", qn));

        let conn = node
            .get("connections")
            .and_then(Value::as_array)
            .and_then(|a| {
                a.iter().find(|c| {
                    let url = c.get("deploymentUrl").and_then(Value::as_str).unwrap_or("");
                    !url.is_empty()
                })
            });
        match conn {
            Some(c) => {
                let url = c.get("deploymentUrl").and_then(Value::as_str).unwrap_or("").to_string();
                let raw_type = c.get("type").and_then(Value::as_str).unwrap_or("");
                let kind = crate::mcp::standardize(raw_type).unwrap_or_default();
                let kind = if crate::mcp::is_http_type(&kind) { kind } else { crate::mcp::TYPE_STREAMABLE.to_string() };
                let mut cfg = json!({"type": kind, "url": url, "headers": {}});
                let hosted = is_hosted_url(&url);
                if hosted {
                    // 默认 tokenHeader=Authorization / tokenPrefix=Bearer 恰好是
                    // AuthSpec 缺省，无需显式声明这两个字段。
                    cfg["auth"] = json!({
                        "authType": "token",
                        "tokenLabel": "Smithery API Key",
                        "tokenHelpUrl": "https://smithery.ai/account/api-keys",
                    });
                    item["auth_kind"] = json!("token");
                }
                // configSchema 参数属于平台侧配置，env/headers 承载不了：
                // 不进 env_schema，只在 readme 里说明（build_readme 已包含）。
                item["server_config"] = json!([{"mcpServers": {server_key(qn): cfg}}]);
                item["env_schema"] = Value::Null;
            }
            None => {
                item["server_config"] = json!([]);
                item["env_schema"] = Value::Null;
            }
        }
        Ok(item)
    }

    pub fn categories(&self) -> Value {
        categories()
    }
}

/// description + 工具清单 + 平台参数说明 → 轻量 Markdown（详情弹窗可读）。
fn build_readme(node: &Value) -> String {
    let mut out = String::new();
    if let Some(d) = node.get("description").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        out.push_str(d);
        out.push_str("\n\n");
    }
    if let Some(tools) = node.get("tools").and_then(Value::as_array) {
        if !tools.is_empty() {
            out.push_str("## Tools\n\n");
            for t in tools.iter().take(30) {
                let name = t.get("name").and_then(Value::as_str).unwrap_or("");
                let desc = t.get("description").and_then(Value::as_str).unwrap_or("");
                if name.is_empty() {
                    continue;
                }
                out.push_str(&format!("- `{}`", name));
                if !desc.is_empty() {
                    let short: String = desc.chars().take(160).collect();
                    out.push_str(&format!(" — {}", short.replace('\n', " ")));
                }
                out.push('\n');
            }
            out.push('\n');
        }
    }
    // 平台侧参数提示：configSchema 声明的必填项无法由本地 env/headers 承载。
    let platform: Vec<String> = node
        .get("connections")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|c| c.get("configSchema"))
                .filter_map(|s| s.get("required").and_then(Value::as_array).cloned())
                .flat_map(|r| r.into_iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>())
                .collect()
        })
        .unwrap_or_default();
    if !platform.is_empty() {
        out.push_str(&format!(
            "> 平台侧配置参数（{}）需在 smithery.ai 的服务配置页填写，本地表单无法承载。\n",
            platform.join(", ")
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockHttp {
        responses: std::sync::Mutex<Vec<(u16, Value)>>,
        calls: std::sync::Mutex<Vec<String>>,
        /// 每次响应的模拟延迟（并发单飞测试用：让重建窗口足够宽）。
        delay: Duration,
    }
    impl MockHttp {
        fn new(responses: Vec<(u16, Value)>) -> Self {
            Self {
                responses: std::sync::Mutex::new(responses),
                calls: std::sync::Mutex::new(Vec::new()),
                delay: Duration::ZERO,
            }
        }
        fn with_delay(mut self, d: Duration) -> Self {
            self.delay = d;
            self
        }
    }
    #[async_trait::async_trait]
    impl SmitheryHttp for MockHttp {
        async fn get_json(&self, url: &str) -> Result<(u16, Value), String> {
            // 锁内只做同步取数，绝不持 std 锁跨 await。
            let next = {
                self.calls.lock().unwrap().push(url.to_string());
                let mut r = self.responses.lock().unwrap();
                if r.is_empty() { Err("mock exhausted".to_string()) } else { Ok(r.remove(0)) }
            };
            if !self.delay.is_zero() {
                tokio::time::sleep(self.delay).await;
            }
            next
        }
    }

    fn q(search: &str, page: i64, size: i64) -> ServerQuery {
        ServerQuery { search: search.into(), page, page_size: size, category: String::new(), hosted: false }
    }

    #[test]
    fn urls_keep_slash_and_clamp_page_size() {
        assert_eq!(detail_url("owner/name"), "https://registry.smithery.ai/servers/owner/name");
        assert_eq!(detail_url("brave"), "https://registry.smithery.ai/servers/brave");
        assert_eq!(list_url(2, 500), "https://registry.smithery.ai/servers?page=2&pageSize=100");
        assert_eq!(list_url(0, 0), "https://registry.smithery.ai/servers?page=1&pageSize=1");
    }

    #[test]
    fn hosted_url_gate() {
        assert!(is_hosted_url("https://brave.run.tools"));
        assert!(is_hosted_url("https://x.smithery.run/mcp"));
        assert!(!is_hosted_url("https://api.example.com/mcp"));
        assert!(!is_hosted_url("https://run.tools.evil.com"));
        assert!(!is_hosted_url("not a url"));
    }

    #[tokio::test]
    async fn browse_maps_pagination_and_shape() {
        let mock = MockHttp::new(vec![(200, json!({
            "servers": [{"qualifiedName": "brave", "displayName": "Brave Search", "description": "d",
                "iconUrl": "https://api.smithery.ai/servers/brave/icon", "useCount": 87579, "verified": true,
                "namespace": "brave", "deploymentUrl": "https://brave.run.tools"}],
            "pagination": {"totalCount": 20747, "totalPages": 250}
        }))]);
        let m = SmitheryMcpMarket::new(mock);
        let data = m.servers(&q("", 1, 20)).await.unwrap();
        assert_eq!(data["total_count"], json!(20747));
        let it = &data["mcp_server_list"][0];
        assert_eq!(it["id"], json!("smithery:brave"));
        assert_eq!(it["name"], json!("Brave Search"));
        assert_eq!(it["auth_kind"], json!("token"));
    }

    #[tokio::test]
    async fn search_builds_local_index_once_and_slices() {
        // 一次重建 = 至多 5 个**并行**页请求（页 1 有数据、其余耗尽报错不影响：
        // 按页序合并遇不满页即截断）。两次搜索共享同一份索引，总请求数不变。
        let page = json!({"servers": [
            {"qualifiedName": "brave", "displayName": "Brave Search", "description": "web search"},
            {"qualifiedName": "o/gmail", "displayName": "Gmail", "description": "mail tools"}
        ], "pagination": {"totalCount": 2}});
        let mock = MockHttp::new(vec![(200, page)]);
        let m = SmitheryMcpMarket::new(mock);
        let d1 = m.servers(&q("search", 1, 20)).await.unwrap();
        assert_eq!(d1["total_count"], json!(1));
        assert_eq!(d1["mcp_server_list"][0]["id"], json!("smithery:brave"));
        let after_first = m.http.calls.lock().unwrap().len();
        assert!((1..=5).contains(&after_first), "单轮重建至多 5 页: {}", after_first);
        let d2 = m.servers(&q("gmail", 1, 20)).await.unwrap();
        assert_eq!(d2["mcp_server_list"][0]["id"], json!("smithery:o/gmail"));
        assert_eq!(m.http.calls.lock().unwrap().len(), after_first, "TTL 内不得重复抓索引");
    }

    #[tokio::test]
    async fn detail_hosted_connection_gets_token_auth_and_no_env_schema() {
        let mock = MockHttp::new(vec![(200, json!({
            "qualifiedName": "brave", "displayName": "Brave Search", "description": "d",
            "connections": [{"type": "http", "deploymentUrl": "https://brave.run.tools",
                "configSchema": {"type": "object", "required": ["braveApiKey"],
                    "properties": {"braveApiKey": {"type": "string", "title": "Brave API Key"}}}}],
            "tools": [{"name": "brave_web_search", "description": "search"}]
        }))]);
        let m = SmitheryMcpMarket::new(mock);
        let d = m.detail("smithery:brave").await.unwrap();
        let cfg = &d["server_config"][0]["mcpServers"]["brave"];
        assert_eq!(cfg["type"], json!("streamable"));
        assert_eq!(cfg["url"], json!("https://brave.run.tools"));
        assert_eq!(cfg["auth"]["authType"], json!("token"));
        assert!(d["env_schema"].is_null(), "平台参数不得进 env_schema（无处保存）");
        assert!(d["readme"].as_str().unwrap().contains("braveApiKey"), "平台参数须在 readme 说明");
        assert!(d["readme"].as_str().unwrap().contains("brave_web_search"));
        assert_eq!(d["auth_kind"], json!("token"));
    }

    #[tokio::test]
    async fn detail_bundle_only_keeps_empty_server_config() {
        let mock = MockHttp::new(vec![(200, json!({
            "qualifiedName": "o/local", "connections": [{"type": "stdio", "bundleUrl": "https://x/b.mcpb"}]
        }))]);
        let m = SmitheryMcpMarket::new(mock);
        let d = m.detail("o/local").await.unwrap();
        assert_eq!(d["server_config"], json!([]), "bundle 不支持，绝不猜配置");
    }

    #[tokio::test]
    async fn detail_error_envelope_is_failure() {
        let mock = MockHttp::new(vec![(200, json!({"error": "not found"}))]);
        let m = SmitheryMcpMarket::new(mock);
        assert!(m.detail("ghost").await.is_err());
    }

    #[test]
    fn categories_single_all() {
        assert_eq!(categories().as_array().unwrap().len(), 1);
    }

    // ─── 2026-11 codereview 性能轮：索引单飞 / 失败退避 ──────────────────────

    #[tokio::test]
    async fn concurrent_searches_share_one_index_build() {
        // 上游只有 1 页数据 + 50ms 延迟：两个并发搜索若各自重建，第二轮的
        // 页 1 会撞 "mock exhausted" 报错。单飞下二者共享同一次抓取（≤5 页）。
        let page = json!({"servers": [
            {"qualifiedName": "brave", "displayName": "Brave Search", "description": "web search"}
        ], "pagination": {"totalCount": 1}});
        let mock = MockHttp::new(vec![(200, page)]).with_delay(Duration::from_millis(50));
        let m = SmitheryMcpMarket::new(mock);
        let query = q("brave", 1, 20);
        let (a, b) = tokio::join!(m.servers(&query), m.servers(&query));
        assert!(a.is_ok(), "并发搜索 A 失败: {:?}", a.err());
        assert!(b.is_ok(), "并发搜索 B 失败（重复重建撞 mock exhausted = 单飞失效）: {:?}", b.err());
        let calls = m.http.calls.lock().unwrap().len();
        assert!((1..=5).contains(&calls), "并发重建必须合并为单轮抓取（≤5 页）: {}", calls);
    }

    #[tokio::test]
    async fn failed_build_backs_off_instead_of_refetching_every_search() {
        // 上游不可达（mock 直接耗尽报错）：第一次搜索失败后，退避窗口内的
        // 后续搜索必须直接报错且**不再触网** —— 境外源挂掉时每次搜索都撞
        // 5 页超时是最坏 ~50s/次 的性能坑。
        let mock = MockHttp::new(vec![]);
        let m = SmitheryMcpMarket::new(mock);
        assert!(m.servers(&q("x", 1, 20)).await.is_err());
        // 一次失败重建 = 至多 5 个并行页请求（境外源单轮上限）；
        // 退避窗口内的第二次搜索必须直接报错、一个请求都不再发。
        let after_first = m.http.calls.lock().unwrap().len();
        assert!((1..=5).contains(&after_first), "首轮抓取应至多 5 页: {}", after_first);
        assert!(m.servers(&q("y", 1, 20)).await.is_err());
        assert_eq!(m.http.calls.lock().unwrap().len(), after_first, "退避窗口内不得重复抓上游");
    }

    #[tokio::test]
    async fn stale_index_is_rebuilt_on_next_search() {
        // TTL 判定行为测试：直接把索引时间戳拨回过期（等效 10 分钟流逝），
        // 不用 tokio 暂停时钟 —— 单线程 runtime 下 time::advance 对
        // Instant::elapsed 的推进时机不稳定，测的是运行时而不是本模块。
        let page = json!({"servers": [
            {"qualifiedName": "brave", "displayName": "Brave Search", "description": "web search"}
        ], "pagination": {"totalCount": 1}});
        // 两轮重建各发 5 个并行页请求：每轮页 1 有数据、其余耗尽（按页序
        // 合并遇不满页即截断，后续页错误不影响结果）。只备 2 条会让第二轮
        // 的页 1 撞上第一轮剩下的页数据、页 2 反而耗尽报错 —— 备满 10 条。
        let mock = MockHttp::new(std::iter::repeat((200, page)).take(10).collect());
        let m = SmitheryMcpMarket::new(mock);
        assert!(m.servers(&q("brave", 1, 20)).await.is_ok());
        let after_first = m.http.calls.lock().unwrap().len();
        {
            let mut cache = m.cache.lock().await;
            let idx = cache.index.as_ref().expect("首次搜索后应有索引");
            cache.index = Some(Arc::new(SearchIndex {
                built_at: idx.built_at - SEARCH_INDEX_TTL - Duration::from_secs(1),
                rows: idx.rows.clone(),
            }));
        }
        assert!(m.servers(&q("brave", 1, 20)).await.is_ok());
        assert!(m.http.calls.lock().unwrap().len() > after_first, "过期索引必须触发重建");
    }
}