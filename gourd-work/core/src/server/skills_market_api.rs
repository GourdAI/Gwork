//! `skills_market_api` — axum handlers for the five skill-marketplace endpoints
//! the Rust kernel was missing.
//!
//! | Method | Path                              | Java source |
//! |--------|-----------------------------------|-------------|
//! | GET    | `/web/settings/skills/proxy`      | `WebSettingsController.skillsProxy` (line 2497) |
//! | GET    | `/web/settings/skills/detail`     | `WebSettingsController.skillsDetail` (line 2713) |
//! | GET    | `/web/settings/skills/categories` | `WebSettingsController.skillsCategories` (line 2727) |
//! | POST   | `/web/settings/skills/install`    | `WebSettingsController.skillsInstall` (line 2544) |
//! | GET    | `/web/settings/skills/icon`       | `WebSettingsController.skillsIcon` (line 2793) |
//!
//! All business logic lives in `crate::skills::market`; this file only maps HTTP
//! shapes onto it.
//!
//! ## Extractor choice is part of the contract
//!
//! The frontend (`desktop/ui/js/app-skills.js`, `installSkill`) calls `$.ajax`
//! with a `data` object and **no** `contentType`, so jQuery sends
//! `application/x-www-form-urlencoded`. `install` therefore takes `Form<..>`;
//! `Json<..>` would answer 415 and the install button would look dead. The four
//! GET endpoints take `Query<..>`.
//!
//! ## Response envelope
//!
//! `{code, description, data}` with `description: ""` on success — Solon's
//! `Result.succeed` sets the empty string, not `"succeed"`. Failures use
//! `code: 400` and carry the upstream's own message; nothing here fabricates a
//! success.

use std::sync::Arc;

use axum::extract::Query;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Form, Json};
use serde::Deserialize;
use serde_json::Value;

use crate::config::Settings;
use crate::skills::market::{self, MarketHttp, ProxyQuery};

// ─── Query / form shapes ─────────────────────────────────────────────────────

/// `GET /web/settings/skills/proxy` parameters.
///
/// Defaults mirror the Java `@Param(defaultValue = ...)` annotations exactly, so
/// a request that omits a field behaves the same against either kernel.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct ProxyParams {
    #[serde(default = "default_action")]
    pub action: String,
    #[serde(default)]
    pub q: String,
    #[serde(default)]
    pub cursor: String,
    #[serde(default = "default_limit")]
    pub limit: i64,
    #[serde(rename = "marketName", default)]
    pub market_name: String,
    #[serde(default)]
    pub category: String,
}

fn default_action() -> String {
    "trending".into()
}

fn default_limit() -> i64 {
    20
}

impl ProxyParams {
    fn into_query(self) -> ProxyQuery {
        ProxyQuery {
            action: self.action,
            q: self.q,
            cursor: self.cursor,
            limit: self.limit,
            market_name: self.market_name,
            category: self.category,
        }
    }
}

/// `GET /web/settings/skills/detail` parameters.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct DetailParams {
    #[serde(default)]
    pub slug: String,
    #[serde(rename = "marketName", default)]
    pub market_name: String,
}

/// `GET /web/settings/skills/categories` parameters.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct CategoriesParams {
    #[serde(rename = "marketName", default)]
    pub market_name: String,
}

/// `POST /web/settings/skills/install` body (form-encoded).
///
/// `scope` is accepted and deliberately ignored: Java's `skillsInstall`
/// documents that installs always land in the global scope and the parameter
/// survives only for older frontends.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct InstallForm {
    #[serde(default)]
    pub slug: String,
    #[serde(rename = "marketName", default)]
    pub market_name: String,
    #[serde(default)]
    pub scope: String,
}

/// `GET /web/settings/skills/icon` parameters.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct IconParams {
    #[serde(default)]
    pub url: String,
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/// `GET /web/settings/skills/proxy` — trending list or search, cursor-paged.
pub async fn skills_proxy(Query(params): Query<ProxyParams>) -> Json<Value> {
    let mgr = market::global_manager();
    Json(market::proxy(&mgr, &params.into_query()).await)
}

/// `GET /web/settings/skills/detail` — detail-dialog payload.
pub async fn skills_detail(Query(params): Query<DetailParams>) -> Json<Value> {
    let mgr = market::global_manager();
    Json(market::detail(&mgr, &params.slug, &params.market_name).await)
}

/// `GET /web/settings/skills/markets` — the market tabs.
///
/// Delegates to `MarketManager::infos`, so the tab list is exactly the set of
/// registered adapters and cannot drift from the adapters that actually serve
/// `proxy` / `detail` / `install`. (A hardcoded stub used to answer this route
/// with skillhub alone, which made clawhub and modelscope disappear from the
/// UI even though both adapters were registered and working.)
pub async fn skills_markets() -> Json<Value> {
    let mgr = market::global_manager();
    Json(market::markets(&mgr))
}

/// `GET /web/settings/skills/categories` — filter chips.
///
/// A market with no category support yields an empty list, which makes the
/// frontend hide the bar. That is the intended degradation, not an error.
pub async fn skills_categories(Query(params): Query<CategoriesParams>) -> Json<Value> {
    let mgr = market::global_manager();
    Json(market::categories(&mgr, &params.market_name).await)
}

/// `POST /web/settings/skills/install` — download, unpack, register.
///
/// Always installs into the **global** skills directory (`~/.gwork/skills`),
/// matching Java: skills are agent-global and discovered at runtime.
pub async fn skills_install(Form(form): Form<InstallForm>) -> Json<Value> {
    if form.slug.trim().is_empty() {
        return Json(market::failure("slug is required"));
    }
    let mgr = market::global_manager();
    let market = mgr.by_name(&form.market_name);
    let skills_dir = install_skills_dir();

    match market.install(&form.slug, &skills_dir).await {
        // Java returns `Result.succeed(displayName)`: `data` is the display-name
        // string, which the frontend prints in the success toast.
        Ok(display_name) => Json(market::succeed(Value::String(display_name))),
        Err(e) => Json(market::failure(e)),
    }
}

/// `GET /web/settings/skills/icon` — server-side icon proxy.
///
/// Answers raw bytes with an `image/*` content type, or HTTP 404 with an empty
/// body when the URL is refused or the fetch fails (Java parity). The frontend's
/// `<img onerror="this.remove()">` then reveals the letter placeholder, so a 404
/// here degrades gracefully instead of showing a broken image.
pub async fn skills_icon(Query(params): Query<IconParams>) -> Response {
    match icon_cached(&params.url).await {
        None => (StatusCode::NOT_FOUND, "").into_response(),
        Some(fetch) => {
            let ct = market::icon_content_type(&fetch);
            (
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, ct.as_str()),
                    // Same browser-side cache the Java kernel sets.
                    (header::CACHE_CONTROL, "public, max-age=86400"),
                ],
                fetch.bytes.clone(),
            )
                .into_response()
        }
    }
}

// ─── Icon cache（2026-11 codereview 性能轮） ─────────────────────────────────
//
// 背景：连接器目录图标改走本代理后（腾讯 CDN 防盗链 / Smithery 境外域名，
// <img> 直连 403），列表每次 render()/追加/切源/语言切换都重建 innerHTML，
// 同一批 <img> 会对同一 URL 重复发请求。浏览器 Cache-Control 只在响应正常
// 返回后生效；缓存未命中窗口内（首屏并发、慢境外源）每个重复请求都要再做
// 一轮 DNS 解析 + TLS 握手 + 上游抓取（icon 超时 15s）。这里加进程级缓存：
//
// * 成功缓存 TTL 1h（图标几乎不变；浏览器侧仍是 24h，两层不一致无害——
//   内核层过期只会多抓一次上游，不会给用户旧图超过 1h）。
// * 失败负缓存 60s：防盗链 403 / 境外超时是常态路径，没有负缓存时每次翻页
//   都把这些必败请求原样重放（每个最坏 15s 占着连接）。
// * 同 URL 单飞：首屏 20 张卡并发 + innerHTML 重建的重复请求合并为一次抓取。
// * 容量护栏：成功 ≤128 条、负缓存 ≤256 条、在飞 ≤32；超限驱逐最旧条目。
//   在飞超限的请求**绕过缓存直连**（正确性不变，只是失去合并优化），
//   绝不无界排队 —— 上游整体挂掉时不能让 32 个 15s 慢请求把后续全部拖死。
//
// 与 `skills::market` 头部的「目录端点不做服务端缓存」不冲突：那条红线的
// 理由是列表缓存会让新装技能在“已安装”里消失；图标是不可变的展示字节，
// 缓存不影响任何业务判定。SSRF 门禁仍在 fetch_icon 内逐跳执行，缓存只存
// 已通过门禁的结果。

struct IconCacheEntry {
    at: std::time::Instant,
    result: Option<Arc<market::IconFetch>>,
}

static ICON_CACHE: once_cell::sync::Lazy<tokio::sync::Mutex<std::collections::HashMap<String, IconCacheEntry>>> =
    once_cell::sync::Lazy::new(|| tokio::sync::Mutex::new(std::collections::HashMap::new()));
static ICON_INFLIGHT: once_cell::sync::Lazy<
    tokio::sync::Mutex<std::collections::HashMap<String, Arc<tokio::sync::Notify>>>,
> = once_cell::sync::Lazy::new(|| tokio::sync::Mutex::new(std::collections::HashMap::new()));

const ICON_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(3600);
const ICON_NEG_TTL: std::time::Duration = std::time::Duration::from_secs(60);
const ICON_CACHE_MAX: usize = 128;
const ICON_NEG_MAX: usize = 256;
const ICON_INFLIGHT_MAX: usize = 32;

/// 带缓存/单飞的图标获取。缓存判定与登记在短临界区内完成，抓网在锁外。
async fn icon_cached(url: &str) -> Option<Arc<market::IconFetch>> {
    if url.trim().is_empty() {
        return None;
    }
    // 快路径：新鲜命中（含负缓存）直接返回。
    {
        let mut cache = ICON_CACHE.lock().await;
        if let Some(entry) = cache.get(url) {
            let ttl = if entry.result.is_some() { ICON_CACHE_TTL } else { ICON_NEG_TTL };
            if entry.at.elapsed() < ttl {
                return entry.result.clone();
            }
            cache.remove(url);
        }
    }
    // 单飞登记：已有同 URL 在飞则等它；在飞超限则绕过缓存直连（不排队）。
    let (notify, leader) = {
        let mut inflight = ICON_INFLIGHT.lock().await;
        match inflight.get(url) {
            Some(n) => (n.clone(), false),
            None => {
                if inflight.len() >= ICON_INFLIGHT_MAX {
                    drop(inflight);
                    let http = market::ReqwestMarketHttp::new();
                    return market::fetch_icon(&http, url).await.map(Arc::new);
                }
                let n = Arc::new(tokio::sync::Notify::new());
                inflight.insert(url.to_string(), n.clone());
                (n, true)
            }
        }
    };
    if !leader {
        // 先注册再放等待，防丢通知；醒来后读缓存（leader 已写入结果或负缓存）。
        let notified = notify.notified();
        notified.await;
        let cache = ICON_CACHE.lock().await;
        return cache.get(url).and_then(|e| e.result.clone());
    }
    let http = market::ReqwestMarketHttp::new();
    let result = market::fetch_icon(&http, url).await.map(Arc::new);
    {
        let mut cache = ICON_CACHE.lock().await;
        evict_icon_cache(&mut cache);
        cache.insert(url.to_string(), IconCacheEntry { at: std::time::Instant::now(), result: result.clone() });
    }
    ICON_INFLIGHT.lock().await.remove(url);
    notify.notify_waiters();
    result
}

/// 容量护栏：超限时按时间驱逐最旧条目（先清过期，再清最旧）。条目数 ≤384，
/// O(n) 扫描代价可忽略，不引入 LRU 依赖。
fn evict_icon_cache(cache: &mut std::collections::HashMap<String, IconCacheEntry>) {
    cache.retain(|_, e| {
        let ttl = if e.result.is_some() { ICON_CACHE_TTL } else { ICON_NEG_TTL };
        e.at.elapsed() < ttl
    });
    loop {
        let (ok, neg) = cache.values().fold((0usize, 0usize), |(o, n), e| {
            if e.result.is_some() { (o + 1, n) } else { (o, n + 1) }
        });
        if ok <= ICON_CACHE_MAX && neg <= ICON_NEG_MAX {
            return;
        }
        // 驱逐超配额类别里最旧的一条。
        let victim = cache
            .iter()
            .filter(|(_, e)| if ok > ICON_CACHE_MAX { e.result.is_some() } else { e.result.is_none() })
            .min_by_key(|(_, e)| e.at)
            .map(|(k, _)| k.clone());
        match victim {
            Some(k) => { cache.remove(&k); }
            None => return,
        }
    }
}

// ─── Seams used by tests ─────────────────────────────────────────────────────

/// Build a manager over an injected transport. Handlers use
/// `market::global_manager()`; tests use this so no request ever reaches
/// `api.skillhub.cn`.
pub fn manager_with(http: Arc<dyn MarketHttp>) -> market::MarketManager {
    market::MarketManager::new(http)
}

/// The directory an install lands in. One definition, so the "installs are
/// always global" rule cannot drift between the handler and its test.
pub fn install_skills_dir() -> std::path::PathBuf {
    Settings::gwork_home().join("skills")
}

/// Fake a successful upstream JSON response (test helper).
pub fn http_json(status: u16, body: &str) -> market::HttpResult {
    market::HttpResult {
        status,
        body: body.as_bytes().to_vec(),
        content_type: Some("application/json".into()),
        location: None,
        error: None,
    }
}

/// Fake a transport failure (test helper).
pub fn http_error(msg: &str) -> market::HttpResult {
    market::HttpResult::transport_error(msg)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `/web/settings/skills/markets` must list **every** registered adapter.
    ///
    /// This route was once wired to a hardcoded stub in `settings_api` that
    /// answered with skillhub alone, so the clawhub and modelscope tabs
    /// vanished from the UI while both adapters were registered and fully
    /// functional — the list endpoint and the endpoints it feeds (`proxy`,
    /// `detail`, `install`) had drifted apart. Asserting through the handler
    /// keeps the tab list bound to the same `MarketManager` the other four
    /// endpoints resolve through.
    #[tokio::test]
    async fn markets_lists_every_registered_adapter() {
        let v = skills_markets().await.0;
        assert_eq!(v["code"], serde_json::json!(200));
        let names: Vec<String> = v["data"]
            .as_array()
            .expect("data must be an array")
            .iter()
            .map(|m| m["name"].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(names, vec!["skillhub.cn", "clawhub.ai", "modelscope.cn"]);
    }

    /// The handler must agree with the manager it delegates to: same count,
    /// same order, same descriptions. A future adapter registered in
    /// `MarketManager::new` therefore shows up in the UI with no extra wiring.
    #[tokio::test]
    async fn markets_matches_the_manager_infos() {
        let v = skills_markets().await.0;
        let infos = market::global_manager().infos();
        let data = v["data"].as_array().expect("data must be an array");
        assert_eq!(data.len(), infos.len());
        for (item, info) in data.iter().zip(infos.iter()) {
            assert_eq!(item["name"].as_str(), Some(info.name.as_str()));
            assert_eq!(item["description"].as_str(), Some(info.description.as_str()));
        }
    }

    /// Wiring guard: the router must point this path at the marketplace module.
    ///
    /// Comments are stripped before matching — an assertion that also hits the
    /// explanatory comment would stay green after the route was repointed at a
    /// stub (this repo has been bitten by exactly that shape of false green).
    #[test]
    fn router_wires_markets_to_the_marketplace_module() {
        let src = include_str!("mod.rs");
        let code: String = src
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        let line = code
            .lines()
            .find(|l| l.contains("\"/web/settings/skills/markets\""))
            .expect("the markets route must exist");
        assert!(
            line.contains("skills_market_api::skills_markets"),
            "markets must be served by the marketplace module, got: {}",
            line.trim()
        );
        assert!(
            !line.contains("settings_api::skills_markets"),
            "markets must not be served by a settings_api stub, got: {}",
            line.trim()
        );
        // The stub itself must stay deleted, or it can be wired back by accident.
        let settings_src = include_str!("settings_api.rs");
        assert!(
            !settings_src.contains("pub async fn skills_markets"),
            "the hardcoded single-market stub must not come back"
        );
    }

    // ─── 2026-11 codereview 性能轮：图标缓存 ────────────────────────────────
    //
    // icon_cached 的抓取走真实 ReqwestMarketHttp，测试用本机回环地址：
    // fetch_icon 的 SSRF 门禁会拒绝 loopback → 稳定得到 None，不触外网。
    // 这恰好覆盖负缓存路径；成功路径由「预置缓存条目后必须零网络命中」覆盖。

    #[tokio::test]
    async fn icon_cache_hit_never_touches_network() {
        // 预置一条新鲜成功条目：命中必须原样返回（URL 指向不可达地址，
        // 若实现绕过缓存去抓网必然失败/超时，测试即红）。
        let url = "https://icon-cache-hit.test.invalid/x.png";
        let entry = Arc::new(market::IconFetch {
            bytes: b"cached-png".to_vec(),
            content_type: Some("image/png".into()),
        });
        ICON_CACHE.lock().await.insert(
            url.to_string(),
            IconCacheEntry { at: std::time::Instant::now(), result: Some(entry.clone()) },
        );
        let got = icon_cached(url).await.expect("新鲜缓存必须命中");
        assert_eq!(got.bytes, b"cached-png");
        ICON_CACHE.lock().await.remove(url);
    }

    #[tokio::test]
    async fn icon_failure_is_negatively_cached() {
        // loopback 被 SSRF 门禁拒绝 → None；第二次调用必须命中负缓存
        // （结果仍为 None，且缓存表里有该键的失败条目）。
        let url = "http://127.0.0.1:1/blocked.png";
        ICON_CACHE.lock().await.remove(url);
        assert!(icon_cached(url).await.is_none());
        {
            let cache = ICON_CACHE.lock().await;
            let e = cache.get(url).expect("失败必须写入负缓存");
            assert!(e.result.is_none(), "失败条目不得伪装成成功");
        }
        assert!(icon_cached(url).await.is_none(), "负缓存窗口内结果一致");
        ICON_CACHE.lock().await.remove(url);
    }

    #[test]
    fn icon_cache_eviction_respects_quotas() {
        let mut cache = std::collections::HashMap::new();
        let now = std::time::Instant::now();
        for i in 0..(ICON_CACHE_MAX + 10) {
            cache.insert(
                format!("ok-{}", i),
                IconCacheEntry {
                    at: now - std::time::Duration::from_secs(i as u64),
                    result: Some(Arc::new(market::IconFetch { bytes: vec![1], content_type: None })),
                },
            );
        }
        for i in 0..(ICON_NEG_MAX + 10) {
            cache.insert(format!("neg-{}", i), IconCacheEntry { at: now, result: None });
        }
        evict_icon_cache(&mut cache);
        let ok = cache.values().filter(|e| e.result.is_some()).count();
        let neg = cache.values().filter(|e| e.result.is_none()).count();
        assert!(ok <= ICON_CACHE_MAX, "成功条目超配额: {}", ok);
        assert!(neg <= ICON_NEG_MAX, "负缓存超配额: {}", neg);
        // 驱逐的必须是最旧的成功条目（ok-137 最旧，ok-0 最新必须保留）。
        assert!(cache.contains_key("ok-0"), "最新条目不得被驱逐");
    }
}
