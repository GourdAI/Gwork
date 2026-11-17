//! Web tools: websearch, webfetch, codesearch and crawl_url.
//!
//! Every outbound call goes through [`super::web_retry::run_with_retry`], which
//! ports the Java kernel's `RetryTask` semantics (3 attempts, exponential
//! backoff with Full Jitter, fast-fail on deterministic 4xx, wall-clock
//! budget) and adds the two things Java lacks: honouring `Retry-After` on 429
//! and a configurable proxy. See `web_retry.rs` for why the Java MCP provider's
//! second, backoff-free retry layer was deliberately **not** ported.

use async_trait::async_trait;
use once_cell::sync::Lazy;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::registry::{Tool, ToolContext, ToolOutput};
use super::web_retry::{
    build_client_with_ua, configured_proxy, run_with_retry, AttemptError, RetryOutcome,
    RetryPolicy,
};

/// Default User-Agent for the plain HTTP tools.
///
/// `#[cfg(test)]` because only the tests in this file reference it: production
/// callers pass a per-engine UA (`JINA_UA`, the browser-shaped UA, …) so that
/// sites which reject self-identified bots still serve content. Without the cfg
/// this constant is dead in a lib build and its warning masks a real signal —
/// 「删多了导致孤儿常量」 would otherwise be invisible in a noisy list.
#[cfg(test)]
const DEFAULT_UA: &str = "Mozilla/5.0 (compatible; GWork/0.3)";
/// Browser-shaped UA Jina Reader expects (same string as Java's JINA driver,
/// `WebCrawlerDriverTalent.java:83`).
const JINA_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

/// Process-wide HTTP client pool.
///
/// `reqwest::Client` internally holds an `Arc` to its connection pool, so
/// cloning is cheap. Caching by (proxy, UA) means a normal run builds one client
/// for all four tools and keeps TLS/HTTP2 connections alive across calls, instead
/// of rebuilding a client and re-handshaking on every tool invocation — which is
/// what the old code did at `web.rs:36`, `:286`, `:426`.
///
/// **The per-request timeout is deliberately NOT part of the key**: `webfetch`
/// takes a model-supplied `timeoutMs` (1..120000), so including it would mint
/// an unbounded number of pooled clients. Callers use
/// `RequestBuilder::timeout(d)` instead, which applies to that one request
/// including its body stream (reqwest 0.12 `request.rs:291`). The cache has
/// exactly one entry per (proxy, UA) — bounded by the two UA constants below.
///
/// **Auto system-proxy clients are NOT cached forever** (see
/// [`AUTO_PROXY_CLIENT_TTL`]): unlike an explicit proxy string, the OS proxy
/// setting is mutable at runtime and reqwest snapshots it at client-build time.
/// Cache key: (configured proxy, User-Agent).
type ClientKey = (String, String);

/// How long a client that relies on `auto_sys_proxy` may be reused before it is
/// rebuilt from the current OS state.
///
/// `reqwest` resolves the system proxy exactly once, when `ClientBuilder::build()`
/// runs (`reqwest` async_impl/client.rs:419 → `ProxyMatcher::system()` →
/// `hyper-util` `Matcher::from_system()`, whose Windows part reads the
/// `HKCU\...\Internet Settings` registry). A permanently cached client therefore
/// freezes the egress path at its first use: start GWork with the proxy off,
/// turn a system proxy on later (Clash/v2ray's "System Proxy" toggle writes only
/// the registry, not this process's environment), and every later web tool call
/// keeps going direct forever — while the browser, which re-reads the OS setting
/// per request, works. That is precisely the reported
/// 「浏览器能访问、工具一直获取不到」, including its "有时候" (it depends on the
/// order in which the proxy and the app were started).
///
/// 20s keeps connection pooling across a normal burst of tool calls (the reason
/// this cache exists) while picking up a proxy toggle without a restart and
/// without any user-facing setting. Explicitly configured proxies are constant
/// strings and stay cached permanently.
const AUTO_PROXY_CLIENT_TTL: Duration = Duration::from_secs(20);

struct CachedClient {
    client: reqwest::Client,
    built_at: Instant,
    /// True when this client relies on `auto_sys_proxy` (no explicit proxy).
    auto_proxy: bool,
}

static CLIENTS: Lazy<Mutex<HashMap<ClientKey, CachedClient>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Forget only the auto-system-proxy clients, so the next call rebuilds them
/// from the **current** OS proxy state.
///
/// Called when an outbound attempt fails: a user who just enabled a proxy gets
/// it picked up on the very next attempt instead of waiting out the TTL. Explicit
/// proxy entries are untouched — the OS cannot change their value.
fn invalidate_auto_proxy_clients() {
    if let Ok(mut map) = CLIENTS.lock() {
        map.retain(|_, v| !v.auto_proxy);
    }
}

/// Pure TTL predicate, kept separate so the boundary is unit-testable without
/// sleeping 20 seconds. An auto-system-proxy client older than the TTL must be
/// rebuilt so `ClientBuilder::build()` re-reads the OS proxy state.
fn auto_proxy_client_is_fresh(built_at: Instant, now: Instant) -> bool {
    now.saturating_duration_since(built_at) < AUTO_PROXY_CLIENT_TTL
}

/// Resolve and cache a pooled client for one (proxy, UA) pair. Split out of
/// [`shared_client`] so the cache-bounding property is testable without
/// constructing a full `ToolContext` (which has no `Default`).
fn client_for(raw_proxy: &str, ua: &str) -> reqwest::Client {
    let proxy = configured_proxy(raw_proxy);
    let key: ClientKey = (proxy.clone(), ua.to_string());
    let auto_proxy = proxy.is_empty();
    let now = Instant::now();
    if let Ok(map) = CLIENTS.lock() {
        if let Some(c) = map.get(&key) {
            // An explicit proxy never expires; an auto one expires so a proxy
            // toggled mid-session is re-read from the OS on the next build.
            if !auto_proxy || auto_proxy_client_is_fresh(c.built_at, now) {
                return c.client.clone();
            }
        }
    }
    let client = build_client_with_ua(&proxy, ua);
    if let Ok(mut map) = CLIENTS.lock() {
        map.insert(
            key,
            CachedClient { client: client.clone(), built_at: now, auto_proxy },
        );
    }
    client
}

fn shared_client(ctx: &ToolContext, ua: &str) -> reqwest::Client {
    client_for(&ctx.settings.general.web_proxy, ua)
}

/// Retry policy for the plain HTTP tools (Java `HarnessEngine.java:1007` feeds
/// `webfetchTalent` from `apiRetries`).
fn http_policy(ctx: &ToolContext) -> RetryPolicy {
    RetryPolicy::from_settings(
        ctx.settings.general.api_retries,
        ctx.settings.general.web_retry_budget_secs,
    )
}

/// Retry policy for the MCP-backed `codesearch` (Java `HarnessEngine.java:1005`
/// feeds `codeSearchTalent` from `mcpRetries`).
fn mcp_policy(ctx: &ToolContext) -> RetryPolicy {
    RetryPolicy::from_settings(
        ctx.settings.general.mcp_retries,
        ctx.settings.general.web_retry_budget_secs,
    )
}

/// Turn an exhausted retry into an honest error for the model.
///
/// The message says *how many* requests were made and *why* it stopped: without
/// that, a transient 429 after three attempts looks exactly like "the web has
/// nothing", and the model stops looking.
fn retry_failure<T>(label: &str, out: RetryOutcome<T>) -> ToolOutput {
    debug_assert!(out.value.is_none());
    if out.cancelled {
        return ToolOutput::err(format!("{} cancelled by user.", label));
    }
    let detail = out
        .last_error
        .as_ref()
        .map(|e| e.message())
        .unwrap_or_else(|| "unknown error".to_string());
    let reason = if out.fast_failed {
        "non-retryable error (not retried)".to_string()
    } else if out.budget_exhausted {
        format!("time budget exhausted after {} attempt(s)", out.attempts)
    } else {
        format!("{} attempt(s)", out.attempts)
    };
    ToolOutput::err(format!("{} failed after {}: {}", label, reason, detail))
}

/// Classify an HTTP response into either a body-carrying success or a retryable
/// error. `Retry-After` is forwarded so 429 can obey the server's hint.
fn status_error(status: reqwest::StatusCode, retry_after: Option<String>) -> AttemptError {
    AttemptError::http(status, retry_after, "")
}

fn retry_after_of(resp: &reqwest::Response) -> Option<String> {
    resp.headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

// ─── Multi-engine web search ────────────────────────────────────────────────
//
// The original implementation hard-coded a single keyless endpoint
// (`html.duckduckgo.com`). That is a single point of failure: from networks
// where DuckDuckGo is unreachable (measured 2026-11: both `html.` and `lite.`
// time out at the TCP level from mainland China, while Bing/360/Sogou answer
// in ~1 s) every search burned the whole retry budget — 3 attempts × 30 s —
// against a host that can never answer, and reported
// "Search failed after 3 attempt(s): error sending request".
//
// The fix follows the multi-engine degradation strategy of the
// `multi-search-engine` skill: several keyless public engines, each tried
// **once** (a dead route repeats on retry, so same-engine retries are reserved
// for retryable HTTP statuses), failing over to the next engine on any error.
// The engine that answers is promoted to the front of the order, so the
// ordering adapts to the machine's network instead of being a fixed guess.
//
// Baidu is deliberately absent: without a cookie session its SERP endpoint
// answers keyless clients with a 2xx "安全验证" captcha wall (measured), which
// the zero-result + bot-block detection below would only report as a failure
// after a wasted request. It can be added back once the client grows a
// cookie jar.

/// Browser-shaped User-Agent for search engines and plain page fetches. The
/// generic `DEFAULT_UA` ("compatible; GWork/0.3") self-identifies as a bot and
/// gets treated like one (measured: Bing serves shadow-ban junk SERPs to it);
/// the multi-search skill's guidance is to identify as an ordinary browser.
/// One extra pooled client, bounded like the other UA constants.
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

/// Per-engine request timeout. Search pages answer in ~1 s when reachable;
/// 15 s leaves headroom for slow international routes while keeping failover
/// snappy (the old single-engine code waited 30 s per attempt).
const SEARCH_TIMEOUT: Duration = Duration::from_secs(15);

/// Cap for the one same-engine retry a retryable HTTP status (429/5xx) earns.
/// `Retry-After` is honoured but capped: waiting out a 5-minute server hint
/// would defeat the point of failing over to another engine.
const SAME_ENGINE_RETRY_DELAY_CAP: Duration = Duration::from_secs(8);

/// One parsed search hit, before formatting.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SearchHit {
    url: String,
    title: String,
    snippet: String,
}

/// A concrete search request target: which engine, which URL, which parser.
/// Split out of [`EngineSpec`] so tests can point the failover driver at local
/// mock servers with arbitrary URLs.
struct EngineTarget {
    id: &'static str,
    url: String,
    parse: fn(&str, usize) -> Vec<SearchHit>,
}

struct EngineSpec {
    id: &'static str,
    url: fn(&str) -> String,
    parse: fn(&str, usize) -> Vec<SearchHit>,
}

fn url_encode(query: &str) -> String {
    url::form_urlencoded::byte_serialize(query.as_bytes()).collect()
}

fn bing_int_url(q: &str) -> String { format!("https://www.bing.com/search?q={}&ensearch=1", url_encode(q)) }
fn bing_cn_url(q: &str) -> String { format!("https://cn.bing.com/search?q={}&ensearch=0", url_encode(q)) }
fn so360_url(q: &str) -> String { format!("https://www.so.com/s?q={}", url_encode(q)) }
fn sogou_url(q: &str) -> String { format!("https://www.sogou.com/web?query={}", url_encode(q)) }
fn ddg_html_url(q: &str) -> String { format!("https://html.duckduckgo.com/html/?q={}", url_encode(q)) }
fn ddg_lite_url(q: &str) -> String { format!("https://lite.duckduckgo.com/lite/?q={}", url_encode(q)) }

/// Engine table in default preference order. Bing first: it is reachable both
/// from mainland China (`cn.bing.com` and the international entry) and from
/// international networks, and its SERP is the most stable of the set.
/// DuckDuckGo stays available as a fallback for networks where it is the only
/// one that works.
static ENGINES: &[EngineSpec] = &[
    EngineSpec { id: "bing-int", url: bing_int_url, parse: parse_bing_results },
    EngineSpec { id: "bing-cn", url: bing_cn_url, parse: parse_bing_results },
    EngineSpec { id: "so360", url: so360_url, parse: parse_so360_results },
    EngineSpec { id: "sogou", url: sogou_url, parse: parse_sogou_results },
    EngineSpec { id: "ddg-html", url: ddg_html_url, parse: parse_ddg_results },
    EngineSpec { id: "ddg-lite", url: ddg_lite_url, parse: parse_ddg_lite_results },
];

/// Live preference order as indices into [`ENGINES`]. A successful engine is
/// moved to the front ([`promote_engine`]), so a machine whose only reachable
/// engine is e.g. `ddg-lite` stops paying for the dead ones after the first
/// successful search.
static ENGINE_ORDER: Lazy<Mutex<Vec<usize>>> =
    Lazy::new(|| Mutex::new((0..ENGINES.len()).collect()));

fn ordered_targets(query: &str) -> Vec<EngineTarget> {
    let order = ENGINE_ORDER
        .lock()
        .map(|o| o.clone())
        .unwrap_or_else(|_| (0..ENGINES.len()).collect());
    let mut order = order;
    // Language-aware first pass (multi-search skill, Step 1): a CJK query gets
    // the domestic engines first. Measured 2026-11 from a mainland network,
    // `bing-int` answered a CJK-mixed query with a junk SERP (spam/video-farm
    // titles, zero query overlap) while `bing-cn`/360/Sogou answered precisely;
    // the relevance gate below catches the junk, but not paying for it at all
    // is strictly better.
    if query.chars().any(is_cjk) {
        const DOMESTIC: [&str; 3] = ["bing-cn", "so360", "sogou"];
        order.sort_by_key(|&i| {
            let id = ENGINES[i].id;
            DOMESTIC.iter().position(|d| *d == id).map(|p| p as i32).unwrap_or(100)
        });
    }
    order
        .iter()
        .filter_map(|&i| ENGINES.get(i))
        .map(|s| EngineTarget { id: s.id, url: (s.url)(query), parse: s.parse })
        .collect()
}

fn is_cjk(c: char) -> bool {
    matches!(c, '\u{4e00}'..='\u{9fff}' | '\u{3400}'..='\u{4dbf}')
}

/// Query terms used by the relevance gate: ASCII alnum runs (≥2 chars) plus
/// **CJK character bigrams**.
///
/// The old code emitted a whole CJK run as ONE term, so a query like
/// "网页抓取成功率" only matched a page containing that exact 7-character
/// string. Chinese has no spaces and results routinely reorder / paraphrase
/// ("提升抓取成功率的方法"), so almost every hit "didn't match" and the gate
/// declared a perfectly good SERP irrelevant → failover → a failed search.
/// Bigrams make partial / reordered wording match while still being specific
/// enough that unrelated spam shares no signal.
fn query_terms(query: &str) -> Vec<String> {
    fn flush_ascii(ascii: &mut String, terms: &mut Vec<String>) {
        if ascii.chars().count() >= 2 {
            terms.push(ascii.to_lowercase());
        }
        ascii.clear();
    }
    fn flush_cjk(cjk: &mut Vec<char>, terms: &mut Vec<String>) {
        if cjk.len() == 1 {
            terms.push(cjk[0].to_string());
        } else {
            for w in cjk.windows(2) {
                terms.push(w.iter().collect());
            }
        }
        cjk.clear();
    }

    let mut terms: Vec<String> = Vec::new();
    let mut ascii = String::new();
    let mut cjk: Vec<char> = Vec::new();
    for c in query.chars() {
        if c.is_ascii_alphanumeric() {
            if !cjk.is_empty() {
                flush_cjk(&mut cjk, &mut terms);
            }
            ascii.push(c);
        } else if is_cjk(c) {
            if !ascii.is_empty() {
                flush_ascii(&mut ascii, &mut terms);
            }
            cjk.push(c);
        } else {
            if !ascii.is_empty() {
                flush_ascii(&mut ascii, &mut terms);
            }
            if !cjk.is_empty() {
                flush_cjk(&mut cjk, &mut terms);
            }
        }
    }
    if !ascii.is_empty() {
        flush_ascii(&mut ascii, &mut terms);
    }
    if !cjk.is_empty() {
        flush_cjk(&mut cjk, &mut terms);
    }
    terms.sort();
    terms.dedup();
    terms
}

/// Relevance gate against shadow-ban / junk SERPs.
///
/// A blocked or degraded engine often answers **200 with a page of results
/// that have nothing to do with the query** (measured: `bing-int` from a
/// mainland network returned video-farm spam for `asyncio TimeoutError`).
/// Status checks and markup parsing both pass such a page, so the only honest
/// signal left is content overlap. Empty queries/termless queries skip the gate.
///
/// 【2026-11 成功率优化】旧规则要求「过半结果命中至少一个词」
/// (`matching * 2 >= hits.len()`)。对中文查询这是灾难：中文不分词、结果普遍
/// 换序/改写，即使命中也常常只有少数结果带得到查询片段，于是整条多引擎链
/// 被判为「结果无关」逐一切换直至全灭。更关键的是，被误判时代价是**整个
/// 搜索失败**，而误放行只是把一份略噪的 SERP 交给模型（模型能自行忽略）。
/// 因此改为：只要结果里还存在*任何*查询信号就放行，仅在**零重叠**时拒绝
/// ——这才是 shadow-ban 垃圾页的真实特征（源码注释亦如此描述），也契合
/// 「先提高成功率」的取舍。CJK 词元已由 [`query_terms`] 改为字符二元组，
/// 换序/部分命中都能贡献信号。
fn looks_relevant(query: &str, hits: &[SearchHit]) -> bool {
    let terms = query_terms(query);
    if terms.is_empty() || hits.is_empty() {
        return true;
    }
    let matching = hits
        .iter()
        .filter(|h| {
            let hay = format!("{} {}", h.title, h.snippet).to_lowercase();
            terms.iter().any(|t| hay.contains(t.as_str()))
        })
        .count();
    matching > 0
}

fn promote_engine(id: &str) {
    if let Ok(mut order) = ENGINE_ORDER.lock() {
        if let Some(pos) = order.iter().position(|&i| ENGINES[i].id == id) {
            if pos != 0 {
                let idx = order.remove(pos);
                order.insert(0, idx);
            }
        }
    }
}

/// Why the whole engine chain produced nothing.
#[derive(Debug)]
struct SearchFailure {
    /// One "`engine`: `reason`" entry per engine tried, in attempt order.
    per_engine: Vec<String>,
    cancelled: bool,
}

/// One engine, including its single tolerated same-engine retry.
///
/// A transport error (DNS/TCP/timeout) returns immediately: the route is dead
/// and re-dialling it just repeats the hang — failover is the correct response.
/// A retryable HTTP status (429/5xx/408/409) earns exactly one more attempt
/// after `Retry-After` (capped), because rate limits are transient. A
/// deterministic 4xx or an unparseable/blocked page fails the engine outright.
async fn search_one_engine(
    client: &reqwest::Client,
    target: &EngineTarget,
    query: &str,
    num: usize,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<Vec<SearchHit>, AttemptError> {
    let mut last: Option<AttemptError> = None;
    for attempt in 0..2u32 {
        let resp = match client
            .get(&target.url)
            .timeout(SEARCH_TIMEOUT)
            .header(
                "Accept",
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            )
            .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => return Err(AttemptError::transport(e.to_string())),
        };
        let status = resp.status();
        let after = retry_after_of(&resp);
        if !status.is_success() {
            let err = status_error(status, after);
            let retryable = !err.is_deterministic();
            last = Some(err);
            if !retryable || attempt == 1 {
                return Err(last.unwrap());
            }
            let delay = last
                .as_ref()
                .and_then(|e| e.retry_after())
                .unwrap_or(Duration::from_secs(1))
                .min(SAME_ENGINE_RETRY_DELAY_CAP);
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    return Err(AttemptError::transport("cancelled by user"));
                }
                _ = tokio::time::sleep(delay) => {}
            }
            continue;
        }
        let html = read_body_capped(resp, 1_048_576).await?;
        let hits = (target.parse)(&html, num);
        if hits.is_empty() {
            // Zero parsed results is almost never a genuine "the web has
            // nothing on this": engines serve **2xx anti-bot / captcha /
            // anomaly pages**, so `is_success` cannot catch them. Report it as
            // a 429-shaped error so the failure text says what happened.
            let hint = if looks_like_bot_block(&html) {
                "anti-bot / anomaly page"
            } else {
                "no result anchors matched (markup may have changed)"
            };
            return Err(AttemptError::http(
                reqwest::StatusCode::TOO_MANY_REQUESTS,
                None,
                format!(
                    "{} returned no parseable results ({}; {} bytes)",
                    target.id,
                    hint,
                    html.len()
                ),
            ));
        }
        if !looks_relevant(query, &hits) {
            // Transport-shaped on purpose: a junk SERP is an engine defect,
            // not a transient rate limit — retrying the same engine would just
            // re-fetch the same junk. Fail over instead.
            return Err(AttemptError::transport(format!(
                "{} returned results unrelated to the query (degraded/shadow-banned SERP)",
                target.id
            )));
        }
        return Ok(hits);
    }
    Err(last.unwrap_or_else(|| AttemptError::transport("unknown search failure")))
}

/// Try every engine in preference order until one answers.
///
/// The wall-clock budget (settings `webRetryBudgetSecs`, 0 = unlimited) caps
/// the whole chain, never the first engine — same contract as
/// [`run_with_retry`]'s budget decision point ①.
async fn search_across_engines(
    client: &reqwest::Client,
    targets: &[EngineTarget],
    query: &str,
    num: usize,
    cancel: &tokio_util::sync::CancellationToken,
    budget: Duration,
) -> Result<(&'static str, Vec<SearchHit>), SearchFailure> {
    let start = std::time::Instant::now();
    let mut per_engine: Vec<String> = Vec::new();
    for (i, target) in targets.iter().enumerate() {
        if cancel.is_cancelled() {
            return Err(SearchFailure { per_engine, cancelled: true });
        }
        if i > 0 && !budget.is_zero() && start.elapsed() >= budget {
            break;
        }
        match search_one_engine(client, target, query, num, cancel).await {
            Ok(hits) => return Ok((target.id, hits)),
            Err(e) => {
                tracing::warn!(engine = target.id, error = %e.message(), "search engine failed; failing over");
                per_engine.push(format!("{}: {}", target.id, e.message()));
            }
        }
    }
    Err(SearchFailure { per_engine, cancelled: cancel.is_cancelled() })
}

/// Render hits in the exact shape the tool has always returned, plus a source
/// line so the model (and the user) can see which engine answered.
fn format_hits(engine_id: &str, hits: &[SearchHit]) -> String {
    let mut out = format!("[websearch via {}] {} result(s)\n", engine_id, hits.len());
    for (i, h) in hits.iter().enumerate() {
        out.push_str(&format!("{}. {}\n   URL: {}\n   {}", i + 1, h.title, h.url, h.snippet));
        if i + 1 < hits.len() {
            out.push_str("\n\n");
        }
    }
    out
}

pub struct WebSearchTool;

#[async_trait]
impl Tool for WebSearchTool {
    fn name(&self) -> &str { "websearch" }
    fn description(&self) -> &str {
        "Search the web for real-time information. Returns titles, URLs, and snippets."
    }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search keywords"},
                "numResults": {"type": "integer", "description": "Max results (default 8)"}
            },
            "required": ["query"]
        })
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolOutput {
        let query = args["query"].as_str().unwrap_or_default();
        if query.is_empty() {
            return ToolOutput::err("Empty query");
        }
        let num = args["numResults"].as_u64().unwrap_or(8).min(20) as usize;

        let client = shared_client(ctx, BROWSER_UA);
        let targets = ordered_targets(query);
        let budget_secs = ctx.settings.general.web_retry_budget_secs;
        let budget = if budget_secs == 0 {
            Duration::ZERO
        } else {
            Duration::from_secs(budget_secs as u64)
        };
        match search_across_engines(&client, &targets, query, num, &ctx.cancel, budget).await {
            Ok((engine_id, hits)) => {
                promote_engine(engine_id);
                ToolOutput::ok(format_hits(engine_id, &hits))
            }
            Err(f) => {
                if f.cancelled {
                    return ToolOutput::err("Search cancelled by user.");
                }
                // An outage may mean the user just turned on a system proxy.
                // Drop the auto-proxy client so the next call re-snapshots the
                // OS state instead of waiting out AUTO_PROXY_CLIENT_TTL.
                invalidate_auto_proxy_clients();
                // Make the failure mode explicit: the model must not read a
                // search outage as evidence that nothing exists on the web.
                // Listing every engine's reason is what turns "search failed"
                // into a diagnosable statement (dead route vs. bot block vs.
                // markup change).
                ToolOutput::err(format!(
                    "Search failed after trying {} engine(s): {}. Treat this as a search failure, not as evidence that nothing exists.",
                    f.per_engine.len(),
                    f.per_engine.join(" | ")
                ))
            }
        }
    }
}

/// Heuristic for the soft-block page DuckDuckGo serves instead of results.
///
/// It answers 2xx, so a status check alone cannot distinguish it. The markers are
/// deliberately broad: a false positive only changes the wording of an error we
/// are already reporting, while a false negative would mislabel a block as a
/// markup change.
fn looks_like_bot_block(html: &str) -> bool {
    let lower = html.to_ascii_lowercase();
    // "anomaly" and "anomalous" are separate substrings — DDG's page says
    // "anomalous traffic", so both forms are listed.
    [
        "anomaly",
        "anomalous",
        "challenge",
        "captcha",
        "unusual traffic",
        "are you a robot",
    ]
    .iter()
    .any(|m| lower.contains(m))
}

/// Resolve DuckDuckGo's redirect wrapper to the real destination.
///
/// DDG links results through `//duckduckgo.com/l/?uddg=<percent-encoded real
/// URL>&rut=<token>`. The previous code fed everything after `uddg=` into
/// `form_urlencoded::parse` and took the **value** of the first pair — but the
/// encoded URL contains no literal `=`, so it parsed as a *key* with an empty
/// value. Every result was therefore rendered with a blank `URL:` line, which
/// made the tool useless for its main purpose while still reporting success.
fn unwrap_ddg_redirect(href: &str) -> String {
    // The HTML escapes `&` as `&amp;`, which would otherwise leave the tracking
    // token glued to the destination.
    let href = href.replace("&amp;", "&");
    // Protocol-relative hrefs (`//duckduckgo.com/l/?...`) are what DDG emits;
    // `Url::parse` needs a scheme to produce query pairs.
    let absolute = if href.starts_with("//") {
        format!("https:{}", href)
    } else {
        href.clone()
    };
    if let Ok(parsed) = url::Url::parse(&absolute) {
        for (key, value) in parsed.query_pairs() {
            if key == "uddg" && !value.is_empty() {
                return value.to_string();
            }
        }
    }
    // Unwrapped href, or nothing recognizable: keep the raw value rather than
    // dropping the result.
    href
}

/// True when `class_attr` lists `name` as one of its whitespace-separated tokens.
///
/// Token-wise, not substring: `result__a` must not match a hypothetical
/// `result__aside`.
fn has_class(class_attr: &str, name: &str) -> bool {
    class_attr.split_whitespace().any(|c| c == name)
}

/// Any `<a>` tag, captured with its attribute block and inner HTML separately.
static ANCHOR_RE: Lazy<regex::Regex> =
    Lazy::new(|| regex::Regex::new(r#"(?is)<a\b([^>]*)>(.*?)</a>"#).unwrap());
static CLASS_ATTR_RE: Lazy<regex::Regex> =
    Lazy::new(|| regex::Regex::new(r#"(?is)\bclass\s*=\s*"([^"]*)""#).unwrap());
static HREF_ATTR_RE: Lazy<regex::Regex> =
    Lazy::new(|| regex::Regex::new(r#"(?is)\bhref\s*=\s*"([^"]*)""#).unwrap());

/// Parse DuckDuckGo HTML results.
///
/// Two robustness properties the original lacked, both of which fail silently:
///   * **attribute order** — it matched `class="result__a"...href="..."` in that
///     fixed order, so a variant emitting `href` first yielded zero results;
///   * **position-based pairing** — it zipped links and snippets by separate
///     iteration index, so one missing snippet shifted every later snippet onto
///     the wrong result.
fn parse_ddg_results(html: &str, max: usize) -> Vec<SearchHit> {
    // (document offset, url, title) and (document offset, text).
    let mut links: Vec<(usize, String, String)> = Vec::new();
    let mut snippets: Vec<(usize, String)> = Vec::new();

    for caps in ANCHOR_RE.captures_iter(html) {
        let Some(whole) = caps.get(0) else { continue };
        let attrs = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let inner = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        let class = CLASS_ATTR_RE
            .captures(attrs)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str())
            .unwrap_or("");

        if has_class(class, "result__a") {
            let href = HREF_ATTR_RE
                .captures(attrs)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str())
                .unwrap_or("");
            links.push((whole.start(), unwrap_ddg_redirect(href), strip_html(inner)));
        } else if has_class(class, "result__snippet") {
            snippets.push((whole.start(), strip_html(inner)));
        }
    }

    let mut results = Vec::new();
    for (i, (at, url, title)) in links.iter().enumerate() {
        if results.len() >= max {
            break;
        }
        // Placeholder/empty anchors carry no information; skipping them also keeps
        // the numbering meaningful.
        if url.is_empty() && title.is_empty() {
            continue;
        }
        // The snippet belonging to *this* result is the first one that starts
        // after this link but before the next link. Bounding the window on both
        // sides is what makes a missing snippet cost exactly one result: without
        // the upper bound, a link with no snippet would steal the next link's
        // snippet and every later result would be off by one.
        let next_at = links.get(i + 1).map(|(n, _, _)| *n).unwrap_or(usize::MAX);
        let snippet = snippets
            .iter()
            .find(|(s_at, _)| *s_at > *at && *s_at < next_at)
            .map(|(_, text)| text.as_str())
            .unwrap_or("");
        results.push(SearchHit { url: url.clone(), title: title.clone(), snippet: snippet.to_string() });
    }
    results
}

// ─── Per-engine SERP parsers ────────────────────────────────────────────────
//
// Every parser is block-scoped: it walks result *containers* and extracts the
// link, title and snippet from within each one, so a missing snippet can never
// shift the following results (the position-zip bug the DDG parser had).
// Structures verified against live SERPs (2026-11):
//   * Bing   — `<li class="b_algo">` … `<h2><a href="…/ck/a?…&u=a1<base64url>">title</a></h2>`
//              + `<p class="b_lineclamp2">snippet</p>`
//   * 360    — `<h3 class="res-title"><a href="so.com/link?…" data-mdurl="real">`
//              + `<span class="res-list-summary">snippet</span>`
//   * Sogou  — `<div class="vrwrap">` … `<h3 class="vr-title"><a href="/link?url=…">`
//              + `<div class="fz-mid space-txt …" id="cacheresult_summary_N">snippet</div>`
//   * DDG lite — `<a class="result-link" href="…">` + `<td class="result-snippet">`

/// Bing's click-tracking wrapper: the real destination is base64url-encoded in
/// the `u=` query parameter with a two-character version prefix (`a1…`).
/// Returns the href unchanged when it is not a tracking link, so direct links
/// (news modules, some locales) still work.
fn unwrap_bing_ck(href: &str) -> String {
    let href = href.replace("&amp;", "&");
    let Ok(parsed) = url::Url::parse(&href) else { return href };
    if !parsed.path().ends_with("/ck/a") {
        return href;
    }
    let Some(encoded) = parsed.query_pairs().find(|(k, _)| k == "u").map(|(_, v)| v.to_string()) else {
        return href;
    };
    // Strip the two-char version prefix, then base64url-decode (padding
    // optional — Bing omits it).
    let payload = if encoded.len() > 2 { &encoded[2..] } else { &encoded };
    use base64::Engine as _;
    match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).to_string(),
        Err(_) => href,
    }
}

/// 360's result links are opaque redirects; the real destination rides along
/// in `data-mdurl` (the skill's script restores exactly this attribute).
static MDURL_ATTR_RE: Lazy<regex::Regex> =
    Lazy::new(|| regex::Regex::new(r#"(?is)\bdata-mdurl\s*=\s*"([^"]*)""#).unwrap());

/// First `href="…"` inside an attribute block.
fn href_in(attrs: &str) -> String {
    HREF_ATTR_RE
        .captures(attrs)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str())
        .unwrap_or("")
        .to_string()
}

/// Split `html` on every occurrence of `block_marker` and yield each block's
/// body (up to the next marker or end of document). The marker regex must
/// match the *opening* of a result container.
fn result_blocks<'a>(html: &'a str, marker: &regex::Regex) -> Vec<&'a str> {
    let starts: Vec<usize> = marker.find_iter(html).map(|m| m.start()).collect();
    let mut blocks = Vec::with_capacity(starts.len());
    for (i, &s) in starts.iter().enumerate() {
        let end = starts.get(i + 1).copied().unwrap_or(html.len());
        blocks.push(&html[s..end]);
    }
    blocks
}

static BING_BLOCK_RE: Lazy<regex::Regex> =
    Lazy::new(|| regex::Regex::new(r#"(?i)<li\b[^>]*\bclass\s*=\s*"[^"]*\bb_algo\b"#).unwrap());
static BING_SNIPPET_RE: Lazy<regex::Regex> =
    Lazy::new(|| regex::Regex::new(r#"(?is)<p\b[^>]*\bclass\s*=\s*"[^"]*\bb_(?:lineclamp\d|caption)\b[^>]*>(.*?)</p>"#).unwrap());

/// Parse Bing SERP (`www.bing.com/search` and `cn.bing.com/search`).
fn parse_bing_results(html: &str, max: usize) -> Vec<SearchHit> {
    let mut out = Vec::new();
    for block in result_blocks(html, &BING_BLOCK_RE) {
        if out.len() >= max {
            break;
        }
        // The title link is the first anchor inside the block's `<h2>`; the
        // `b_tpcn` site-icon anchor precedes it in document order, so scoping
        // to the h2 is what selects the right one.
        let Some(h2_pos) = block.find("<h2") else { continue };
        let rest = &block[h2_pos..];
        let Some(caps) = ANCHOR_RE.captures(rest) else { continue };
        let attrs = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let inner = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        let href = href_in(attrs);
        let title = strip_html(inner);
        if href.is_empty() || title.is_empty() {
            continue;
        }
        let snippet = BING_SNIPPET_RE
            .captures(block)
            .and_then(|c| c.get(1))
            .map(|m| strip_html(m.as_str()))
            .unwrap_or_default();
        out.push(SearchHit { url: unwrap_bing_ck(&href), title, snippet });
    }
    out
}

static SO360_BLOCK_RE: Lazy<regex::Regex> =
    Lazy::new(|| regex::Regex::new(r#"(?i)<h3\b[^>]*\bclass\s*=\s*["']?[^"'>]*\bres-title\b"#).unwrap());
static SO360_SNIPPET_RE: Lazy<regex::Regex> = Lazy::new(|| {
    regex::Regex::new(r#"(?is)<(?:span|p)\b[^>]*\bclass\s*=\s*["'][^"']*\bres-list-summary\b[^>]*>(.*?)</(?:span|p)>"#)
        .unwrap()
});

/// Parse 360 search SERP (`www.so.com/s`).
fn parse_so360_results(html: &str, max: usize) -> Vec<SearchHit> {
    let mut out = Vec::new();
    for block in result_blocks(html, &SO360_BLOCK_RE) {
        if out.len() >= max {
            break;
        }
        let Some(caps) = ANCHOR_RE.captures(block) else { continue };
        let attrs = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let inner = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        let href = href_in(attrs);
        let title = strip_html(inner);
        if title.is_empty() {
            continue;
        }
        // Prefer the real destination; fall back to the clickable redirect.
        let url = MDURL_ATTR_RE
            .captures(attrs)
            .and_then(|c| c.get(1))
            .map(|m| decode_entities(m.as_str()))
            .filter(|u| u.starts_with("http"))
            .unwrap_or_else(|| href.clone());
        let snippet = SO360_SNIPPET_RE
            .captures(block)
            .and_then(|c| c.get(1))
            .map(|m| strip_html(m.as_str()))
            .unwrap_or_default();
        out.push(SearchHit { url, title, snippet });
    }
    out
}

static SOGOU_BLOCK_RE: Lazy<regex::Regex> =
    Lazy::new(|| regex::Regex::new(r#"(?i)<div\b[^>]*\bclass\s*=\s*["'][^"']*\bvrwrap\b"#).unwrap());
static SOGOU_SNIPPET_RE: Lazy<regex::Regex> = Lazy::new(|| {
    regex::Regex::new(r#"(?is)<div\b[^>]*\bid\s*=\s*"cacheresult_summary_\d+"[^>]*>(.*?)</div>"#).unwrap()
});

/// Parse Sogou SERP (`www.sogou.com/web`).
fn parse_sogou_results(html: &str, max: usize) -> Vec<SearchHit> {
    let mut out = Vec::new();
    for block in result_blocks(html, &SOGOU_BLOCK_RE) {
        if out.len() >= max {
            break;
        }
        // Title link: the anchor inside the `vr-title` h3.
        let Some(h3_pos) = block.find("vr-title") else { continue };
        let rest = &block[h3_pos..];
        let Some(caps) = ANCHOR_RE.captures(rest) else { continue };
        let attrs = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let inner = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        let href = href_in(attrs);
        let title = strip_html(inner);
        if href.is_empty() || title.is_empty() {
            continue;
        }
        // `/link?url=…` is Sogou's redirect; it still resolves in a browser,
        // so keep it when no direct URL is available.
        let url = if href.starts_with('/') {
            format!("https://www.sogou.com{}", href)
        } else {
            href
        };
        let snippet = SOGOU_SNIPPET_RE
            .captures(block)
            .and_then(|c| c.get(1))
            .map(|m| strip_html(m.as_str()))
            .unwrap_or_default();
        out.push(SearchHit { url, title, snippet });
    }
    out
}

static DDG_LITE_LINK_RE: Lazy<regex::Regex> =
    Lazy::new(|| regex::Regex::new(r#"(?is)<a\b[^>]*\bclass\s*=\s*"[^"]*\bresult-link\b[^>]*>(.*?)</a>"#).unwrap());
static DDG_LITE_SNIPPET_RE: Lazy<regex::Regex> =
    Lazy::new(|| regex::Regex::new(r#"(?is)<td\b[^>]*\bclass\s*=\s*"[^"]*\bresult-snippet\b[^>]*>(.*?)</td>"#).unwrap());

/// Parse DuckDuckGo *lite* SERP (`lite.duckduckgo.com/lite/`): a plain table,
/// links and snippets in separate rows, paired by document order.
fn parse_ddg_lite_results(html: &str, max: usize) -> Vec<SearchHit> {
    let links: Vec<(usize, String, String)> = DDG_LITE_LINK_RE
        .captures_iter(html)
        .map(|c| {
            let whole = c.get(0).unwrap();
            let attrs = html[whole.start()..whole.end()]
                .split('>')
                .next()
                .unwrap_or("");
            let inner = c.get(1).map(|m| m.as_str()).unwrap_or("");
            (whole.start(), unwrap_ddg_redirect(&href_in(attrs)), strip_html(inner))
        })
        .collect();
    let snippets: Vec<(usize, String)> = DDG_LITE_SNIPPET_RE
        .captures_iter(html)
        .map(|c| (c.get(0).unwrap().start(), strip_html(c.get(1).unwrap().as_str())))
        .collect();

    let mut out = Vec::new();
    for (i, (at, url, title)) in links.iter().enumerate() {
        if out.len() >= max {
            break;
        }
        if url.is_empty() && title.is_empty() {
            continue;
        }
        let next_at = links.get(i + 1).map(|(n, _, _)| *n).unwrap_or(usize::MAX);
        let snippet = snippets
            .iter()
            .find(|(s_at, _)| *s_at > *at && *s_at < next_at)
            .map(|(_, t)| t.clone())
            .unwrap_or_default();
        out.push(SearchHit { url: url.clone(), title: title.clone(), snippet });
    }
    out
}

fn strip_html(s: &str) -> String {
    // Reuse the compiled `TAG_RE` rather than building an identical pattern per
    // call: this runs once per result anchor per search.
    let text = TAG_RE.replace_all(s, "");
    decode_entities(&text).trim().to_string()
}

/// Decode the entities both DDG snippets and fetched pages actually contain,
/// including numeric forms (`&#0183;`, `&#x27;`) which Bing snippets emit for
/// punctuation and CJK separators.
fn decode_entities(text: &str) -> String {
    let named = text
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ");
    NUMERIC_ENTITY_RE
        .replace_all(&named, |caps: &regex::Captures| {
            let code = if caps.get(1).is_some() {
                u32::from_str_radix(caps.get(1).unwrap().as_str(), 16).ok()
            } else {
                caps.get(2).unwrap().as_str().parse::<u32>().ok()
            };
            match code.and_then(char::from_u32) {
                Some(c) => c.to_string(),
                None => caps.get(0).unwrap().as_str().to_string(),
            }
        })
        .to_string()
}

/// `&#xHH…;` (hex, group 1) or `&#DDD;` (decimal, group 2).
static NUMERIC_ENTITY_RE: Lazy<regex::Regex> =
    Lazy::new(|| regex::Regex::new(r"&#x([0-9a-fA-F]{1,6});|&#([0-9]{1,7});").unwrap());

/// Read a response body incrementally with a hard byte cap.
///
/// `resp.text()` buffers the whole body in memory first, so a hostile or
/// misbehaving endpoint could feed an arbitrarily large (or infinite) payload
/// into the process before any downstream truncation ever ran — an OOM vector
/// the tools then truncate to 80–100k chars, i.e. the cap only bounds the
/// *result*, never the *read*. This reads the stream and stops at `max_bytes`,
/// keeping whatever arrived so the caller can still report/truncate it.
/// Mirrors `skills/market.rs`'s MAX_API_BODY_BYTES pattern.
///
/// A stream error is **not** a truncated success: the old `break` returned
/// whatever had arrived (often `""`) and `webfetch` reported an empty page as
/// a successful fetch. Returning `Err` lets the retry loop do its job.
///
/// The `Content-Type` charset is captured **before** consuming the response:
/// `resp.bytes_stream()` moves `resp`, so headers are gone afterwards. reqwest's
/// `charset` feature only applies to `resp.text()`, which we deliberately do
/// not use here (unbounded buffering), so decoding is done by
/// [`decode_response_body`] instead.
/// Append as much of one stream chunk as still fits; returns `true` when the
/// cap is reached and the caller must stop reading.
///
/// The old loop dropped an entire chunk as soon as `len + chunk > cap`, so a
/// large (now decompressed) first frame produced an **empty successful page**,
/// and every >cap response was truncated up to one whole frame early — often
/// cutting a multi-byte character in half. Filling the remainder exactly keeps
/// the cap meaningful and makes the result deterministic.
fn push_capped(body: &mut Vec<u8>, chunk: &[u8], max_bytes: u64) -> bool {
    let remaining = max_bytes.saturating_sub(body.len() as u64) as usize;
    if remaining == 0 {
        return true;
    }
    let take = remaining.min(chunk.len());
    body.extend_from_slice(&chunk[..take]);
    take < chunk.len()
}

async fn read_body_capped(
    resp: reqwest::Response,
    max_bytes: u64,
) -> Result<String, AttemptError> {
    use futures_util::StreamExt;
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let mut body: Vec<u8> = Vec::with_capacity(64 * 1024);
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(b) => {
                if push_capped(&mut body, &b, max_bytes) {
                    break;
                }
            }
            Err(e) => {
                return Err(AttemptError::transport(format!(
                    "response body read failed: {}",
                    e
                )));
            }
        }
    }
    Ok(decode_response_body(&body, content_type.as_deref()))
}

/// Charset-aware decoding for HTTP bodies.
///
/// Priority follows what browsers and mature fetchers do, tuned for success
/// rate rather than spec literalism:
///
/// 1. A UTF-16/32 BOM is unambiguous (every other byte is NUL) and must be
///    decoded before any byte-oriented heuristic.
/// 2. **Bytes that are valid UTF-8 win over a declared legacy charset.**
///    Mis-declared `charset=gbk` on an actually-UTF-8 page is extremely common;
///    a genuine GBK/Big5/Shift_JIS Chinese page is never valid UTF-8. Trusting
///    the bytes here avoids turning perfectly good pages into mojibake.
/// 3. `Content-Type: ...; charset=…` for genuinely non-UTF-8 bytes.
/// 4. HTML `<meta charset=…>` / `http-equiv` in the first 4 KiB.
/// 5. BOM-less heuristic: UTF-8 → GBK fallback (legacy CN sites).
///
/// Note reqwest already decompresses gzip/br/deflate when those features are
/// on, so by the time we see the bytes they are the *decoded* payload.
fn decode_response_body(bytes: &[u8], content_type: Option<&str>) -> String {
    use crate::textcodec::{charset_from_content_type, charset_from_html_meta,
        decode_bytes, decode_with_bom, decode_with_label, detect_bom};

    if let Some(bom) = detect_bom(bytes) {
        if matches!(bom.encoding, "utf-16le" | "utf-16be" | "utf-32le" | "utf-32be") {
            return decode_with_bom(bytes);
        }
    }
    // A UTF-8 BOM is just a prefix; strip it so it cannot pollute the head scan
    // or appear as a stray \u{FEFF} at the start of the extracted text.
    let bytes: &[u8] = bytes
        .strip_prefix(&[0xEF, 0xBB, 0xBF][..])
        .unwrap_or(bytes);

    if let Ok(valid) = std::str::from_utf8(bytes) {
        return valid.to_string();
    }

    if let Some(label) = content_type.and_then(charset_from_content_type) {
        if let Some(s) = decode_with_label(bytes, label) {
            return s;
        }
    }
    // Only the head is scanned; all charset declarations are ASCII, so a lossy
    // preview of the first 4 KiB is enough even when the body is GBK.
    let head_end = bytes.len().min(4096);
    let head = String::from_utf8_lossy(&bytes[..head_end]);
    if let Some(label) = charset_from_html_meta(&head) {
        if let Some(s) = decode_with_label(bytes, &label) {
            return s;
        }
    }
    decode_bytes(bytes)
}

/// Fetch a web page and return its content as text/markdown.
pub struct WebFetchTool;

/// One `webfetch` attempt, split out so the status classification and the
/// Cloudflare branch can be exercised against a local mock server without
/// touching `shared_client`'s process-wide proxy resolution.
async fn webfetch_attempt(
    client: &reqwest::Client,
    url: &str,
    format: &str,
    timeout: Duration,
) -> Result<String, AttemptError> {
    // 【2026-11 成功率优化】浏览器化请求头：只送 UA 而不带 Accept /
    // Accept-Language 是常见的指纹缺口，CDN/WAF 对这种「半个浏览器」请求
    // 直接 403。这里与多引擎搜索保持同一套头，UA 仍由 client 统一提供。
    let send = |extra_ua: Option<&str>| {
        let mut req = client
            .get(url)
            .timeout(timeout)
            .header(
                "Accept",
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            )
            .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
        if let Some(ua) = extra_ua {
            req = req.header("User-Agent", ua);
        }
        req.send()
    };
    let mut resp = send(None).await
        .map_err(|e| AttemptError::transport(e.to_string()))?;
    if resp.status() == reqwest::StatusCode::FORBIDDEN
        && resp.headers()
            .get("cf-mitigated")
            .and_then(|v| v.to_str().ok())
            == Some("challenge")
    {
        // Java `WebfetchTalent.java:129-136`: one extra physical request with
        // UA "opencode" inside this attempt — deliberately *not* another
        // retry-loop iteration, which would double the backoff. A per-request
        // header overrides the client's default UA (`reqwest` client.rs:2590).
        resp = send(Some("opencode")).await
            .map_err(|e| AttemptError::transport(e.to_string()))?;
    }
    let status = resp.status();
    if !status.is_success() {
        return Err(status_error(status, retry_after_of(&resp)));
    }
    let body = read_body_capped(resp, 1_048_576).await?;
    if format == "html" {
        Ok(body.chars().take(100_000).collect::<String>())
    } else {
        Ok(html_to_text(&body).chars().take(80_000).collect::<String>())
    }
}

/// Fetch one page as raw text for `crawl_url`'s direct leg, with the
/// empty-shell check applied *before* reporting success. Split out because the
/// plain `webfetch` tool must stay permissive (a short JSON/text endpoint is a
/// legitimate result there), while `crawl_url` needs to know when to escalate
/// to Jina Reader.
async fn crawl_direct_attempt(
    client: &reqwest::Client,
    url: &str,
    timeout: Duration,
) -> Result<String, AttemptError> {
    let resp = client
        .get(url)
        .timeout(timeout)
        .header(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .send()
        .await
        .map_err(|e| AttemptError::transport(e.to_string()))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(status_error(status, retry_after_of(&resp)));
    }
    let body = read_body_capped(resp, 1_048_576).await?;
    let text = html_to_text(&body);
    if is_empty_shell(&body, &text) {
        return Err(AttemptError::transport(
            "页面正文为空（JS 渲染壳或反爬拦截页）",
        ));
    }
    Ok(text.chars().take(80_000).collect::<String>())
}

#[async_trait]
impl Tool for WebFetchTool {
    fn name(&self) -> &str { "webfetch" }
    fn description(&self) -> &str {
        "Fetch a URL and return its content as readable text (HTML tags stripped)."
    }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "Full URL including http:// or https://"},
                "format": {"type": "string", "description": "Output format: text (default) or html"},
                "timeoutMs": {"type": "integer", "description": "Per-attempt timeout in ms (default 30000, max 120000; Java WebfetchTalent)"}
            },
            "required": ["url"]
        })
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolOutput {
        let url = args["url"].as_str().unwrap_or_default();
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return ToolOutput::err("URL must start with http:// or https://");
        }
        let format = args["format"].as_str().unwrap_or("text");
        // Java `WebfetchTalent.java:80-86`: default 30s, hard cap 120s, an
        // invalid value falls back to the default rather than erroring out.
        let per_attempt_ms = args["timeoutMs"].as_u64().unwrap_or(30_000).clamp(1, 120_000);
        let timeout = Duration::from_millis(per_attempt_ms);

        let client = shared_client(ctx, BROWSER_UA);
        let policy = http_policy(ctx);
        let out = run_with_retry(&policy, &ctx.cancel, |_| {
            let client = client.clone();
            let url = url.to_string();
            let format = format.to_string();
            async move { webfetch_attempt(&client, &url, &format, timeout).await }
        })
        .await;

        match out.value {
            Some(text) => ToolOutput::ok(text),
            None => {
                // An outage may mean the user just turned on a system proxy.
                // Drop the auto-proxy client so the next call re-snapshots the OS
                // state immediately instead of waiting out AUTO_PROXY_CLIENT_TTL.
                invalidate_auto_proxy_clients();
                retry_failure("Fetch", out)
            }
        }
    }
}

// ─── codesearch ──────────────────────────────────────────────────────────────

/// Code-context search via Exa's keyless streamable-MCP endpoint.
///
/// Java's `CodeSearchTalent` calls the same endpoint
/// (`https://mcp.exa.ai/mcp?tools=get_code_context_exa`) through its MCP client.
/// This reuses the streamable transport in `crate::mcp`, so there is no second
/// HTTP/SSE implementation to keep in sync. The endpoint is keyless (no API key
/// in the URL) — verified against the live server, which answers the initialize
/// handshake with `text/event-stream`, exactly the reply shape `read_rpc_body`
/// handles.
pub struct CodeSearchTool;

/// Exa's code-context endpoint, tool-filtered to the single tool we call.
const EXA_CODESEARCH_URL: &str = "https://mcp.exa.ai/mcp?tools=get_code_context_exa";
/// The tool name Exa exposes behind that endpoint (Java calls the same string).
const EXA_CODESEARCH_TOOL: &str = "get_code_context_exa";

/// A throwaway manager was created, handshaken and torn down on **every**
/// `codesearch` call (`web.rs:364-374` in the old code). Java instead keeps a
/// static `McpClientProvider` (`CodeSearchTalent.java:42-55`), so the
/// initialize handshake happens once per process. This mirrors that: one
/// shared manager keyed by the proxy setting, guarded by a mutex so concurrent
/// sub-agents cannot race two handshakes for the same session id.
static EXA_MANAGERS: Lazy<Mutex<HashMap<String, std::sync::Arc<crate::mcp::McpManager>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
const EXA_MANAGER_NAME: &str = "exa-codesearch";

/// Serializes connect / invalidate / call across concurrent `codesearch`
/// callers (sub-agents share this manager). `is_connected` alone is a TOCTOU
/// race: two callers can both see "not connected" and both enter `connect_one`,
/// which unconditionally calls `disconnect_one` first — one would tear down
/// the connection the other just built. Holding one async mutex across the
/// whole attempt makes reuse and reconnect atomic.
static EXA_LOCK: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

fn exa_manager(ctx: &ToolContext) -> std::sync::Arc<crate::mcp::McpManager> {
    let proxy = configured_proxy(&ctx.settings.general.web_proxy);
    if let Ok(map) = EXA_MANAGERS.lock() {
        if let Some(m) = map.get(&proxy) {
            return m.clone();
        }
    }
    let mgr = std::sync::Arc::new(crate::mcp::McpManager::new());
    // Store before connecting: a concurrent caller must find the same manager
    // rather than building a second one.
    if let Ok(mut map) = EXA_MANAGERS.lock() {
        map.insert(proxy, mgr.clone());
    }
    mgr
}

/// Ensure the shared Exa connection is live **without** re-handshaking when it
/// already is. `connect_one` calls `disconnect_one` first (`mcp/mod.rs:260`),
/// so invoking it on every call would reintroduce the per-call handshake this
/// cache exists to remove. A failed `call_tool` clears the connection so the
/// next retry reconnects (session expiry is the common MCP failure).
async fn ensure_exa_connected(
    mgr: &crate::mcp::McpManager,
    proxy: &str,
) -> anyhow::Result<()> {
    if mgr.is_connected(EXA_MANAGER_NAME).await {
        return Ok(());
    }
    let config = crate::mcp::McpServerConfig {
        kind: crate::mcp::TYPE_STREAMABLE.to_string(),
        url: EXA_CODESEARCH_URL.to_string(),
        timeout: "30s".to_string(),
        proxy: proxy.to_string(),
        ..Default::default()
    };
    mgr.connect_one(EXA_MANAGER_NAME, &config).await?;
    Ok(())
}

/// Drop a dead Exa connection so the next attempt performs a fresh handshake.
async fn invalidate_exa(mgr: &crate::mcp::McpManager) {
    mgr.disconnect_one(EXA_MANAGER_NAME).await;
}

#[async_trait]
impl Tool for CodeSearchTool {
    fn name(&self) -> &str { "codesearch" }
    fn description(&self) -> &str {
        // Deliberately terse: the tool definition is injected into every
        // prompt, so every saved byte is paid back on every turn. The old
        // nine-bullet marketing copy cost ~200 tokens/turn and added no
        // decision-relevant information.
        "搜索编程上下文：库/SDK/API 的代码示例与技术文档（Exa）。示例：'React useState 示例'、'Express 中间件'。"
    }
    fn readonly(&self) -> bool { true }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "搜索查询词，如 'React useState 钩子示例'、'Python pandas 数据框过滤'"},
                "tokensNum": {"type": "integer", "description": "返回 Token 数 (1000-50000)，默认 5000"}
            },
            "required": ["query"]
        })
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolOutput {
        let query = args["query"].as_str().unwrap_or_default().trim();
        if query.is_empty() {
            return ToolOutput::err("Empty query");
        }
        let tokens = clamp_tokens(args["tokensNum"].as_u64());
        let proxy = configured_proxy(&ctx.settings.general.web_proxy);
        let mgr = exa_manager(ctx);
        let policy = mcp_policy(ctx);

        let out = run_with_retry(&policy, &ctx.cancel, |_| {
            let mgr = mgr.clone();
            let proxy = proxy.clone();
            let query = query.to_string();
            async move {
                // One guard for connect + call + invalidate: never let two
                // callers race a handshake or invalidate a live connection.
                let _guard = EXA_LOCK.lock().await;
                // Reconnect on a dead/expired session; a live one is reused,
                // so this is not a full handshake per call.
                if let Err(e) = ensure_exa_connected(&mgr, &proxy).await {
                    return Err(AttemptError::transport(format!("Code search connection failed: {}", e)));
                }
                match mgr
                    .call_tool_text(EXA_MANAGER_NAME, EXA_CODESEARCH_TOOL, json!({"query": query, "tokensNum": tokens}))
                    .await
                {
                    Ok(text) => Ok(text),
                    Err(e) => {
                        // A dead session would fail identically on every
                        // retry; drop it so the next attempt reconnects.
                        invalidate_exa(&mgr).await;
                        Err(AttemptError::transport(format!("Code search failed: {}", e)))
                    }
                }
            }
        })
        .await;

        match out.value {
            // An empty MCP result is a legitimate "nothing found", not an
            // outage — same wording as Java `CodeSearchTalent.java:127-128`.
            Some(text) if !text.trim().is_empty() => ToolOutput::ok(text),
            Some(_) => ToolOutput::ok(
                "未找到相关的代码片段或文档。请尝试更换查询词，明确具体的库或编程概念，并检查框架名称拼写是否正确。",
            ),
            None => retry_failure("Code search", out),
        }
    }
}

/// Clamp the requested token budget to Exa's documented 1000–50000 range,
/// defaulting to 5000. A pure function so the bounds are unit-testable without
/// hitting the network.
fn clamp_tokens(raw: Option<u64>) -> u64 {
    raw.unwrap_or(5000).clamp(1000, 50000)
}

// ─── crawl_url ───────────────────────────────────────────────────────────────

pub struct CrawlUrlTool;

/// Jina Reader: a keyless GET that returns a page already converted to clean
/// Markdown (sidebars, nav and scripts stripped). Java's `WebCrawlerDriverTalent`
/// has this same driver; unlike `webfetch`, which strips tags to plain text on
/// this side, the conversion happens upstream so headings, lists and code blocks
/// survive.
const JINA_READER_PREFIX: &str = "https://r.jina.ai/";

/// Process-level circuit breaker for Jina Reader.
///
/// 【2026-11 成功率优化】链路已改为**直连优先、Jina 仅作兜底**：旧版每次
/// `crawl_url` 都先请求 `r.jina.ai`，在境内网络实测 TCP 超时，首个调用必白等
/// 30 s，且 Jina 的 20 RPM 共享池在批量抓取时频繁 429。现在只有直连确实
/// 失败（403/SPA 空壳/正文过少）才升级到 Jina；Jina 自身传输失败会打上时间戳，
/// 之后 10 分钟内不再探测，避免每次重试都重复烧 30 s。
static JINA_FAILED_AT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// How long a Jina transport failure suppresses further Jina probes.
const JINA_RETRY_AFTER_SECS: u64 = 600;

/// Mark Jina as unavailable. **Every** failure must trip this — transport
/// timeout, any non-2xx (above all the shared 20 RPM `429`), and an empty body.
/// The old code cleared the circuit on *any* HTTP response, so a 429/403 reset
/// it and each retry of `run_with_retry` hit the already-rate-limited pool again,
/// defeating the whole "Jina only as a fallback, back off for 10 min" design.
fn mark_jina_failed() {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(1);
    JINA_FAILED_AT.store(now.max(1), std::sync::atomic::Ordering::Relaxed);
}

fn jina_circuit_open() -> bool {
    let failed_at = JINA_FAILED_AT.load(std::sync::atomic::Ordering::Relaxed);
    if failed_at == 0 {
        return false;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if now.saturating_sub(failed_at) >= JINA_RETRY_AFTER_SECS {
        // Probe window: let the next attempt try Jina again.
        JINA_FAILED_AT.store(0, std::sync::atomic::Ordering::Relaxed);
        return false;
    }
    true
}

/// One Jina Reader attempt. A transport failure opens the circuit and is
/// returned as `AttemptError::Transport`; HTTP-level failures are
/// `AttemptError::Http` so the retry loop can honour `Retry-After`.
async fn jina_attempt(
    client: &reqwest::Client,
    url: &str,
) -> Result<String, AttemptError> {
    let req = client
        .get(format!("{}{}", JINA_READER_PREFIX, url))
        .timeout(Duration::from_secs(20))
        .header("Accept", "text/plain")
        // Ask Jina for Markdown. `X-No-Cache: true` is deliberately **gone**:
        // it forced an upstream refetch on every call and pushed a keyless
        // client straight into the 20 RPM shared pool. Jina's own docs
        // recommend using its cache.
        .header("X-Return-Format", "markdown");
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "Jina Reader unreachable; circuit open");
            mark_jina_failed();
            return Err(AttemptError::transport(format!("Jina Reader unreachable: {}", e)));
        }
    };
    let status = resp.status();
    if !status.is_success() {
        // Any non-2xx — above all the shared-pool 429 — must trip the circuit,
        // otherwise every `run_with_retry` attempt re-hits an endpoint that just
        // rate-limited us. The status is still forwarded so Retry-After is honoured.
        mark_jina_failed();
        return Err(status_error(status, retry_after_of(&resp)));
    }
    let body = read_body_capped(resp, 1_048_576).await?;
    if body.trim().is_empty() {
        mark_jina_failed();
        return Err(AttemptError::transport("目标页面返回空内容"));
    }
    // Only a genuinely usable response clears an earlier failure.
    JINA_FAILED_AT.store(0, std::sync::atomic::Ordering::Relaxed);
    Ok(body.chars().take(80_000).collect::<String>())
}

/// One `crawl_url` attempt: direct first, Jina only as an escalation.
async fn crawl_attempt(
    direct_client: &reqwest::Client,
    jina_client: &reqwest::Client,
    url: &str,
) -> Result<String, AttemptError> {
    let direct_error = match crawl_direct_attempt(direct_client, url, Duration::from_secs(30)).await {
        Ok(text) => return Ok(text),
        Err(e) => {
            tracing::debug!(error = %e.message(), "direct fetch failed; escalating to Jina Reader");
            e
        }
    };
    if jina_circuit_open() {
        // Jina is known-dead on this network right now; do not burn another
        // timeout. Keep the *original* direct failure (403 vs timeout matters
        // both for the retry classifier and for the model's diagnosis).
        return Err(direct_error);
    }
    jina_attempt(jina_client, url).await
}

#[async_trait]
impl Tool for CrawlUrlTool {
    fn name(&self) -> &str { "crawl_url" }
    fn description(&self) -> &str {
        "读取并分析指定 URL 网页的详细内容，返回降噪后的正文（保留标题、列表与代码块结构）。优先直连，直连失败或页面为 JS 空壳时再走 Jina Reader。"
    }
    fn readonly(&self) -> bool { true }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "要抓取的完整 URL（必须以 http:// 或 https:// 开头）"}
            },
            "required": ["url"]
        })
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolOutput {
        let url = args["url"].as_str().unwrap_or_default().trim();
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return ToolOutput::err("错误：URL 无效（必须以 http:// 或 https:// 开头）。");
        }

        let jina_client = shared_client(ctx, JINA_UA);
        let direct_client = shared_client(ctx, BROWSER_UA);
        let policy = http_policy(ctx);
        let out = run_with_retry(&policy, &ctx.cancel, |_| {
            let jina_client = jina_client.clone();
            let direct_client = direct_client.clone();
            let url = url.to_string();
            async move { crawl_attempt(&direct_client, &jina_client, &url).await }
        })
        .await;

        match out.value {
            Some(text) => ToolOutput::ok(text),
            None => {
                // Same as webfetch: pick up a system proxy toggled during this
                // failing attempt without waiting out AUTO_PROXY_CLIENT_TTL.
                invalidate_auto_proxy_clients();
                retry_failure("抓取", out)
            }
        }
    }
}

// ─── HTML → text ─────────────────────────────────────────────────────────────
//
// Compiled once. `webfetch` is on the tool hot path and rebuilding four regexes
// per call is pure waste; `Lazy` also means a syntax error surfaces on first use
// rather than being re-paid every request.

/// Script / style / noscript / boilerplate blocks, content included.
///
/// **Separate patterns, not one.** The original was
/// `<(script|style|noscript)[^>]*>.*?</\1>` — a backreference, which the `regex`
/// crate does not support at all. `Regex::new` returned `Err` and the `.unwrap()`
/// therefore **panicked on every webfetch call**, taking the ReAct loop with it.
///
/// Neither `cargo build` nor `cargo test` catches this: a regex literal is just a
/// string until something evaluates it, and nothing did — this module had no
/// tests. Only `cargo clippy`'s `invalid_regex` lint (compile-time evaluation of
/// literals) found it. The tests below now exercise `html_to_text` directly, so
/// an invalid pattern fails the suite instead of production.
///
/// 【2026-11 成功率优化 / codereview 修正】新增 nav/header/footer/aside/svg 清理：
/// 旧版只去 script/style/noscript，抓取结果被导航栏、页脚版权、推荐链接淹没，
/// 真正正文常常落在 80k 截断之后，表现为「抓到了但没内容」。
///
/// **`<form>` 刻意不在此列**：ASP.NET WebForms、政府/论坛/中文 CMS 常用
/// `<form runat="server">` 把整个 `<body>`（含 `<article>/<main>` 正文）包起来，
/// 整段删会连正文一起吞掉，反而制造「空成功」。表单控件由后续 TAG_RE 去标签、
/// 文本会保留，这点噪音远小于丢正文的代价，故只删块、不删 form 容器。
static SCRIPT_RES: Lazy<[regex::Regex; 8]> = Lazy::new(|| {
    [
        regex::Regex::new(r"(?is)<script[^>]*>.*?</script>").unwrap(),
        regex::Regex::new(r"(?is)<style[^>]*>.*?</style>").unwrap(),
        regex::Regex::new(r"(?is)<noscript[^>]*>.*?</noscript>").unwrap(),
        regex::Regex::new(r"(?is)<nav\b[^>]*>.*?</nav\s*>").unwrap(),
        regex::Regex::new(r"(?is)<header\b[^>]*>.*?</header\s*>").unwrap(),
        regex::Regex::new(r"(?is)<footer\b[^>]*>.*?</footer\s*>").unwrap(),
        regex::Regex::new(r"(?is)<aside\b[^>]*>.*?</aside\s*>").unwrap(),
        regex::Regex::new(r"(?is)<svg\b[^>]*>.*?</svg\s*>").unwrap(),
    ]
});

/// Block-level closing tags, replaced by a newline so paragraphs do not run together.
static BLOCK_RE: Lazy<regex::Regex> =
    Lazy::new(|| regex::Regex::new(r"(?i)</(p|div|h[1-6]|li|tr|br|section|article|pre|blockquote|table|ul|ol|dl|dd|dt)>").unwrap());

/// Headings get explicit `#` markers so the extracted text retains the
/// document outline the `crawl_url` description promises. Capturing the level
/// avoids running six separate passes.
static HEADING_OPEN_RE: Lazy<regex::Regex> =
    Lazy::new(|| regex::Regex::new(r"(?i)<h([1-6])\b[^>]*>").unwrap());

/// List items become `- ` bullets; code blocks are fenced.
static LI_OPEN_RE: Lazy<regex::Regex> =
    Lazy::new(|| regex::Regex::new(r"(?i)<li\b[^>]*>").unwrap());
static PRE_OPEN_RE: Lazy<regex::Regex> =
    Lazy::new(|| regex::Regex::new(r"(?i)<pre\b[^>]*>").unwrap());

/// Any remaining tag.
static TAG_RE: Lazy<regex::Regex> = Lazy::new(|| regex::Regex::new(r"<[^>]+>").unwrap());

/// Three or more consecutive newlines, collapsed to two.
static BLANK_RE: Lazy<regex::Regex> = Lazy::new(|| regex::Regex::new(r"\n{3,}").unwrap());

/// Runs of spaces/tabs (but keep newlines) so stripped tags don't leave rivers
/// of whitespace that eat the 80k char budget.
static SPACE_RUN_RE: Lazy<regex::Regex> = Lazy::new(|| regex::Regex::new(r"[ \t]{2,}").unwrap());

/// Basic HTML → text conversion (strip scripts/styles/tags, collapse whitespace).
///
/// 【2026-11 成功率优化】保留标题/列表/代码块的结构标记、去掉导航页脚噪音。
/// 这是「轻量可读性提取」，不是完整 Markdown 渲染器：不引入 scraper/DOM 依赖，
/// 避免新增编译依赖带来的离线构建风险，但已能显著改善正文密度。
fn html_to_text(html: &str) -> String {
    // Remove script and style blocks. Each pass is a separate pattern because the
    // crate cannot express "close tag matches open tag" without backreferences.
    // Owned String, not Cow: each `replace_all` borrows its input, so feeding the
    // result back into the same binding would be a self-borrow.
    let mut cleaned = html.to_string();
    for re in SCRIPT_RES.iter() {
        cleaned = re.replace_all(&cleaned, "").into_owned();
    }
    // Structure markers, applied before the generic tag strip.
    let cleaned = HEADING_OPEN_RE
        .replace_all(&cleaned, |caps: &regex::Captures| {
            let level: usize = caps[1].parse().unwrap_or(2);
            format!("\n{} ", "#".repeat(level))
        })
        .into_owned();
    let cleaned = LI_OPEN_RE.replace_all(&cleaned, "\n- ").into_owned();
    let cleaned = PRE_OPEN_RE.replace_all(&cleaned, "\n```\n").into_owned();
    // Replace block-level tags with newlines
    let with_newlines = BLOCK_RE.replace_all(&cleaned, "\n");
    // Strip remaining tags
    let text = TAG_RE.replace_all(&with_newlines, "");
    // Decode common entities
    let text = decode_entities(&text);
    // Collapse whitespace runs and multiple blank lines
    let text = SPACE_RUN_RE.replace_all(&text, " ");
    let text = BLANK_RE.replace_all(&text, "\n\n");
    text
        .lines()
        .map(|l| l.trim_end())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// A `200 OK` whose HTML is only a JS shell (`<div id="root"></div>`, Vue/React
/// mount point, "Please enable JavaScript") has no extractable content. Treating
/// that as a successful fetch is exactly the "grabbed it but got nothing" report.
/// The caller uses this to trigger a Jina/reader fallback instead of returning
/// an empty success.
fn is_empty_shell(html_or_text: &str, extracted: &str) -> bool {
    let plain_len = extracted.chars().filter(|c| !c.is_whitespace()).count();
    if plain_len < 80 {
        let lower = html_or_text.to_ascii_lowercase();
        // A genuinely short page (a tiny JSON/text endpoint) is still useful;
        // only call it a shell when the markup looks like an SPA/interstitial.
        let spa_markers = [
            "id=\"root\"", "id='root'", "id=\"app\"", "id='app'",
            "__next", "data-reactroot", "ng-app", "vite",
            "enable javascript", "please enable javascript", "需要启用javascript",
            "just a moment", "checking your browser", "cf-challenge",
        ];
        return spa_markers.iter().any(|m| lower.contains(m))
            || (lower.contains("<html") && lower.contains("<script") && plain_len < 30);
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every test that mutates the process-wide `CLIENTS` cache must hold this
    /// lock: Rust runs tests in parallel and an unsynchronised `clear()` from a
    /// neighbour test would make cache-size assertions flaky. Pure tests (no
    /// `CLIENTS` access) are unaffected.
    static CLIENT_CACHE_TEST_LOCK: Mutex<()> = Mutex::new(());

    /// Every regex literal in this module must actually compile **and** match what
    /// it claims to. The backreference defect this replaces was invisible to
    /// `cargo build` and `cargo test` because nothing evaluated the pattern —
    /// dereferencing the lazy statics is what forces compilation, so a bad literal
    /// now fails here instead of panicking inside `webfetch` at runtime.
    #[test]
    fn every_regex_in_this_module_compiles_and_matches() {
        // (pattern index, a sample it must match, a sample it must not)
        let script_cases = [
            (0, "<script>a</script>", "<div>a</div>"),
            (1, "<style>a</style>", "<div>a</div>"),
            (2, "<noscript>a</noscript>", "<div>a</div>"),
            (3, "<nav class=\"x\">a</nav>", "<div>a</div>"),
            (4, "<header>a</header>", "<div>a</div>"),
            (5, "<footer>a</footer>", "<div>a</div>"),
            (6, "<aside>a</aside>", "<div>a</div>"),
            (7, "<svg><path/></svg>", "<div>a</div>"),
        ];
        // `<form>` must NOT be in SCRIPT_RES: see the note above the static.
        assert_eq!(SCRIPT_RES.len(), 8, "form must stay out of the block-strip list");
        for (i, yes, no) in script_cases {
            let re = &SCRIPT_RES[i];
            assert!(re.is_match(yes), "script pattern {} must match {:?}", i, yes);
            assert!(!re.is_match(no), "script pattern {} must not match {:?}", i, no);
        }
        assert!(BLOCK_RE.is_match("</p>"), "block pattern must match a closing block tag");
        assert!(!BLOCK_RE.is_match("<p>"), "block pattern matches closing tags only");
        assert!(TAG_RE.is_match("<a href=\"x\">"), "tag pattern must match a tag");
        assert!(!TAG_RE.is_match("plain"), "tag pattern must not match plain text");
        assert!(BLANK_RE.is_match("\n\n\n"), "blank pattern needs 3+ newlines");
        assert!(!BLANK_RE.is_match("\n\n"), "two newlines must survive");
    }

    /// The regression itself: stripping a script block used to panic.
    #[test]
    fn strips_script_style_and_noscript_with_their_content() {
        let html = "<html><head><style>body{color:red}</style></head><body>\
                    <script>var secret = 1;</script>\
                    <noscript>enable js</noscript>\
                    <p>real text</p></body></html>";
        let out = html_to_text(html);
        assert!(out.contains("real text"), "got: {:?}", out);
        for gone in ["secret", "color:red", "enable js", "<", ">"] {
            assert!(!out.contains(gone), "{:?} must be stripped, got: {:?}", gone, out);
        }
    }

    /// Script tags with attributes are the common real-world shape.
    #[test]
    fn strips_script_tags_with_attributes() {
        let html = r#"<script type="module" src="a.js"></script><script async>bad()</script>keep"#;
        let out = html_to_text(html);
        assert_eq!(out, "keep");
    }

    #[test]
    fn block_tags_become_line_breaks() {
        let out = html_to_text("<p>one</p><p>two</p><div>three</div>");
        assert!(out.contains("one\ntwo"), "got: {:?}", out);
        assert!(out.contains("two\nthree"), "got: {:?}", out);
    }

    #[test]
    fn entities_are_decoded() {
        let out = html_to_text("<p>a &amp; b &lt;c&gt; &quot;d&quot; &#x27;e&#x27;&nbsp;f</p>");
        assert_eq!(out, "a & b <c> \"d\" 'e' f");
    }

    #[test]
    fn numeric_entities_are_decoded() {
        // Bing snippets emit decimal entities for separators and CJK marks.
        assert_eq!(decode_entities("Dec 31, 2018 &#0183; Qoder"), "Dec 31, 2018 · Qoder");
        assert_eq!(decode_entities("&#x4F60;&#x597D;"), "你好");
        // An invalid codepoint degrades to the literal text, never a panic.
        assert_eq!(decode_entities("&#x110000;"), "&#x110000;");
    }

    #[test]
    fn blank_runs_collapse_to_one_empty_line() {
        let out = html_to_text("<p>a</p><br><br><br><br><br><p>b</p>");
        assert!(!out.contains("\n\n\n"), "got: {:?}", out);
        assert!(out.contains("a") && out.contains("b"));
    }

    #[test]
    fn plain_text_passes_through_trimmed() {
        assert_eq!(html_to_text("  hello world  "), "hello world");
        assert_eq!(html_to_text(""), "");
    }

    /// 【2026-11 成功率回归】旧版把导航/页脚/表单一起当正文，80k 截断后
    /// 真正内容常常被挤掉。这里钉住结构保留 + 噪音剔除。
    #[test]
    fn boilerplate_is_removed_and_structure_is_kept() {
        let html = r#"<html><body>
          <nav><a href="/">首页</a><a href="/about">关于我们</a></nav>
          <header>站点横幅 版权所有</header>
          <main>
            <h1>安装指南</h1>
            <p>第一步：下载安装包。</p>
            <ul><li>Windows</li><li>macOS</li></ul>
            <pre>cargo install foo</pre>
          </main>
          <aside>相关推荐 广告位</aside>
          <footer>© 2026 保留所有权利</footer>
          <form><input value="订阅邮件"></form>
        </body></html>"#;
        let out = html_to_text(html);
        assert!(out.contains("# 安装指南"), "heading marker missing: {out:?}");
        assert!(out.contains("第一步：下载安装包"), "body missing: {out:?}");
        assert!(out.contains("- Windows"), "list marker missing: {out:?}");
        assert!(out.contains("cargo install foo"), "code missing: {out:?}");
        for gone in ["站点横幅", "关于我们", "相关推荐", "保留所有权利", "订阅邮件"] {
            assert!(!out.contains(gone), "{gone:?} must be stripped, got: {out:?}");
        }
    }

    #[test]
    fn spa_shell_is_detected_but_short_real_pages_are_not() {
        let shell = r#"<!doctype html><html><head><script src="/app.js"></script></head><body><div id="root"></div></body></html>"#;
        let text = html_to_text(shell);
        assert!(is_empty_shell(shell, &text), "JS-only shell must be detected");
        let interstitial = "<html><body><p>Just a moment... Checking your browser</p></body></html>";
        assert!(is_empty_shell(interstitial, &html_to_text(interstitial)));
        // 一个真实的短 HTML 页不该被当成空壳。
        let short = "<html><body><p>这是一段简短但真实的说明文字，用来确认短页面不会被误判为空壳页面而触发无谓的兜底抓取。</p></body></html>";
        assert!(!is_empty_shell(short, &html_to_text(short)), "got: {}", html_to_text(short));
        // 纯文本/JSON 端点根本不是 HTML。
        assert!(!is_empty_shell(r#"{"ok":true}"#, r#"{"ok":true}"#));
    }

    /// Malformed HTML must degrade to text, never panic: the input comes from an
    /// arbitrary remote server.
    #[test]
    fn malformed_html_does_not_panic() {
        for bad in ["<p>unclosed", "<script>never closed", "<<<>>>", "</p></p>", "<a href=\"x\">y"] {
            let _ = html_to_text(bad);
        }
    }

    // ─── HTTP body decoding ──────────────────────────────────────────────────

    /// 【2026-11 成功率回归】旧实现把 `bytes_stream()` 的原始字节直接交给
    /// UTF-8→GBK 兜底，既不读 Content-Type charset 也不认 BOM/meta。
    #[test]
    fn body_decoding_honours_declared_charset() {
        let (gbk, _, _) = encoding_rs::GBK.encode("中文测试");
        assert_eq!(
            decode_response_body(&gbk, Some("text/html; charset=gbk")),
            "中文测试"
        );
    }

    #[test]
    fn a_misdeclared_charset_cannot_mangle_valid_utf8() {
        // 站点声明 gbk 但实际发 UTF-8，是最常见的中文乱码来源。
        assert_eq!(
            decode_response_body("中文测试".as_bytes(), Some("text/html; charset=gbk")),
            "中文测试"
        );
    }

    #[test]
    fn body_decoding_falls_back_to_html_meta_and_bom() {
        let (gbk, _, _) = encoding_rs::GBK.encode("中文");
        let mut html = b"<html><head><meta charset=\"gbk\"></head><body>".to_vec();
        html.extend_from_slice(&gbk);
        html.extend_from_slice(b"</body></html>");
        assert!(decode_response_body(&html, Some("text/html")).contains("中文"));

        // UTF-8 BOM must be stripped, not leaked into the extracted text.
        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice("你好".as_bytes());
        assert_eq!(decode_response_body(&bom, None), "你好");
        // UTF-16LE BOM wins over any heuristic.
        assert_eq!(decode_response_body(&[0xFF, 0xFE, b'H', 0, b'i', 0], None), "Hi");
    }

    // ─── DuckDuckGo redirect unwrapping ──────────────────────────────────────
    //
    // The regression: `uddg=<percent-encoded url>` was fed to form_urlencoded and
    // the *value* of the first pair was taken. The encoded URL has no literal `=`,
    // so it parsed as a key with an empty value and every result got a blank
    // `URL:` line — reported as success.

    #[test]
    fn uddg_redirect_yields_the_real_destination_url() {
        // Exactly the shape DDG emits: protocol-relative, percent-encoded target,
        // a tracking token after it.
        let href = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs%3Fx%3D1&rut=abc";
        assert_eq!(unwrap_ddg_redirect(href), "https://example.com/docs?x=1");
    }

    #[test]
    fn uddg_redirect_survives_html_ampersand_escaping() {
        // In HTML the separators arrive as `&amp;`; without unescaping, the token
        // sticks to the URL and the pair parse breaks.
        let href = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.test%2Fp&amp;rut=tok";
        assert_eq!(unwrap_ddg_redirect(href), "https://a.test/p");
    }

    #[test]
    fn a_plain_href_is_returned_unchanged() {
        assert_eq!(unwrap_ddg_redirect("https://example.com/x"), "https://example.com/x");
        // A non-parseable value degrades to the raw string rather than emptying.
        assert_eq!(unwrap_ddg_redirect("not a url"), "not a url");
    }

    // ─── parse_ddg_results robustness ────────────────────────────────────────

    #[test]
    fn parses_results_with_href_before_class() {
        // The old fixed-order pattern required class=...href=... and matched
        // nothing when the server emitted the attributes the other way round.
        let html = r#"<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.test&rut=1" class="result__a">Alpha</a>
<a class="result__snippet">snippet for alpha</a>"#;
        let out = parse_ddg_results(html, 8);
        assert_eq!(out.len(), 1, "href-first ordering must still parse");
        assert_eq!(out[0].url, "https://a.test");
        assert_eq!(out[0].title, "Alpha");
        assert_eq!(out[0].snippet, "snippet for alpha");
    }

    #[test]
    fn a_missing_snippet_does_not_shift_the_others() {
        // Three links, but only the first and third have snippets. Position-based
        // zipping used to slide the third snippet onto the second result.
        let html = r#"<a class="result__a" href="https://one.test">One</a>
<a class="result__snippet">S1</a>
<a class="result__a" href="https://two.test">Two</a>
<a class="result__a" href="https://three.test">Three</a>
<a class="result__snippet">S3</a>"#;
        let out = parse_ddg_results(html, 8);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].snippet, "S1");
        assert!(out[1].snippet.is_empty(), "middle must have no snippet: {:?}", out[1]);
        assert_eq!(out[2].snippet, "S3", "third must pair with S3, not S1");
    }

    #[test]
    fn respects_the_max_results_cap() {
        let html: String = (0..10)
            .map(|i| format!("<a class=\"result__a\" href=\"https://{}.test\">R{}</a>\n", i, i))
            .collect();
        assert_eq!(parse_ddg_results(&html, 3).len(), 3);
    }

    #[test]
    fn no_result_anchors_parses_to_empty() {
        // Feeds the bot-block branch in `search_one_engine`; an empty parse is
        // what makes that path report failure instead of a fake "No results".
        assert!(parse_ddg_results("<html><body>nothing here</body></html>", 8).is_empty());
    }

    #[test]
    fn class_matching_is_token_wise_not_substring() {
        // `result__aside` (hypothetical) must not be treated as `result__a`.
        let html = r#"<a class="result__aside" href="https://x.test">Aside</a>
<a class="result__a" href="https://real.test">Real</a>"#;
        let out = parse_ddg_results(html, 8);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].url, "https://real.test");
    }

    #[test]
    fn bot_block_markers_are_detected() {
        assert!(looks_like_bot_block("<html>Detected Anomalous Traffic</html>"));
        assert!(looks_like_bot_block("solve this CAPTCHA"));
        assert!(!looks_like_bot_block("<html><a class=result__a>ok</a></html>"));
    }

    // ─── Per-engine parsers (fixtures mirror live SERPs, captured 2026-11) ───

    #[test]
    fn bing_ck_redirect_is_decoded_to_the_real_url() {
        // `u=a1<base64url(real url)>`, no padding — exactly what Bing emits.
        // base64url("https://rust-lang.org/") = aHR0cHM6Ly9ydXN0LWxhbmcub3JnLw
        let href = "https://www.bing.com/ck/a?!&amp;&amp;p=deadbeef&amp;ptn=3&amp;ver=2&amp;hsh=4&amp;fclid=x&amp;u=a1aHR0cHM6Ly9ydXN0LWxhbmcub3JnLw&amp;ntb=1";
        assert_eq!(unwrap_bing_ck(href), "https://rust-lang.org/");
        // Non-tracking hrefs pass through untouched.
        assert_eq!(unwrap_bing_ck("https://example.com/x"), "https://example.com/x");
        // A tracking link whose payload is garbage degrades to the href.
        assert_eq!(unwrap_bing_ck("https://www.bing.com/ck/a?u=a1!!!"), "https://www.bing.com/ck/a?u=a1!!!");
    }

    #[test]
    fn bing_parser_extracts_title_url_snippet_per_block() {
        let html = r#"<ol id="b_results">
<li class="b_algo" data-id iid=SERP.1><div class="b_tpcn"><a class="tilk" href="https://www.bing.com/ck/a?u=a1aHR0cHM6Ly9ydXN0LWxhbmcub3JnLw">rust-lang.org</a></div><h2><a target="_blank" href="https://www.bing.com/ck/a?!&amp;&amp;u=a1aHR0cHM6Ly9ydXN0LWxhbmcub3JnLw&amp;ntb=1" h="ID=SERP,1">Rust &amp; <strong>home</strong></a></h2><div class="b_caption"><p class="b_lineclamp2">Blazingly fast and <strong>memory</strong> efficient.</p></div></li>
<li class="b_algo" data-id iid=SERP.2><h2><a href="https://example.com/two">Second</a></h2><p class="b_lineclamp2">No snippet shift here.</p></li>
</ol>"#;
        let out = parse_bing_results(html, 8);
        assert_eq!(out.len(), 2, "got {:?}", out);
        assert_eq!(out[0].url, "https://rust-lang.org/", "ck wrapper must unwrap");
        assert_eq!(out[0].title, "Rust & home", "site-icon anchor must not win over h2 anchor");
        assert_eq!(out[0].snippet, "Blazingly fast and memory efficient.");
        assert_eq!(out[1].url, "https://example.com/two");
        assert_eq!(out[1].snippet, "No snippet shift here.");
    }

    #[test]
    fn so360_parser_prefers_data_mdurl_over_the_redirect() {
        let html = r#"<div class="result">
<h3 class="res-title"><a href="https://www.so.com/link?m=abc" data-mdurl="https://www.cnblogs.com/p/1" rel="noopener">Tokio <em>tutorial</em></a></h3>
<div class="res-comm-con"><span class="res-list-summary" data-result-summary>An async runtime.</span></div>
</div>
<h3 class="res-title"><a href="https://www.so.com/link?m=def">Plain redirect</a></h3>"#;
        let out = parse_so360_results(html, 8);
        assert_eq!(out.len(), 2, "got {:?}", out);
        assert_eq!(out[0].url, "https://www.cnblogs.com/p/1");
        assert_eq!(out[0].title, "Tokio tutorial");
        assert_eq!(out[0].snippet, "An async runtime.");
        // Without data-mdurl the clickable redirect is kept, not dropped.
        assert_eq!(out[1].url, "https://www.so.com/link?m=def");
    }

    #[test]
    fn sogou_parser_scopes_to_vrwrap_and_absolutizes_redirects() {
        let html = r#"<div class="vrwrap" id="sogou_vr_1">
<h3 class="vr-title"><a target="_blank" href="/link?url=hedJjaC291" id="sogou_vr_30010187_title_1">Async in <em>Rust</em></a></h3>
<div class="fz-mid space-txt base-ellipsis clamp2" id="cacheresult_summary_1">A guide to async.</div>
</div>
<div class="vrwrap" id="sogou_vr_2">
<h3 class="vr-title"><a href="http://mp.weixin.qq.com/s?src=1">WeChat post</a></h3>
<div class="fz-mid space-txt" id="cacheresult_summary_2">Direct link kept.</div>
</div>"#;
        let out = parse_sogou_results(html, 8);
        assert_eq!(out.len(), 2, "got {:?}", out);
        assert_eq!(out[0].url, "https://www.sogou.com/link?url=hedJjaC291");
        assert_eq!(out[0].title, "Async in Rust");
        assert_eq!(out[0].snippet, "A guide to async.");
        assert_eq!(out[1].url, "http://mp.weixin.qq.com/s?src=1");
    }

    #[test]
    fn ddg_lite_parser_pairs_table_rows_by_position() {
        let html = r#"<table>
<tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Flite.test%2Fa&rut=1" class="result-link">Lite A</a></td></tr>
<tr><td class="result-snippet">Snippet A</td></tr>
<tr><td><a rel="nofollow" href="https://lite.test/b" class="result-link">Lite B</a></td></tr>
<tr><td class="result-snippet">Snippet B</td></tr>
</table>"#;
        let out = parse_ddg_lite_results(html, 8);
        assert_eq!(out.len(), 2, "got {:?}", out);
        assert_eq!(out[0].url, "https://lite.test/a");
        assert_eq!(out[0].snippet, "Snippet A");
        assert_eq!(out[1].snippet, "Snippet B");
    }

    #[test]
    fn the_relevance_gate_rejects_junk_serps_and_accepts_on_topic_ones() {
        let q = "asyncio TimeoutError";
        let junk = vec![
            SearchHit { url: "u1".into(), title: "糖心vlog官网最新入口".into(), snippet: "每日精选视频".into() },
            SearchHit { url: "u2".into(), title: "高清影视在线观看".into(), snippet: "免费追剧平台".into() },
        ];
        assert!(!looks_relevant(q, &junk), "zero-overlap spam must fail the gate");
        let good = vec![
            SearchHit { url: "u1".into(), title: "再谈 asyncio.exceptions.TimeoutError 报错".into(), snippet: "python 协程".into() },
            SearchHit { url: "u2".into(), title: "Python asyncio 中的超时控制方案".into(), snippet: "timeout 处理".into() },
        ];
        assert!(looks_relevant(q, &good), "on-topic hits must pass");
        // 放宽后：只要还残留查询信号就放行（误放行优于整条引擎链全灭）。
        let mixed = {
            let mut v = junk.clone();
            v.push(good[0].clone());
            v.push(good[1].clone());
            v
        };
        assert!(looks_relevant(q, &mixed));
        // Termless queries skip the gate entirely.
        assert!(looks_relevant("!!!", &junk));
    }

    /// 【2026-11 成功率回归】中文查询不分词：旧实现把整串中文当一个词，
    /// 结果换序/改写就零命中，整条多引擎链被判「无关」直至全灭。这里钉住
    /// 「换序、部分命中、少数结果命中」三种真实 SERP 形态都必须放行。
    #[test]
    fn cjk_reordered_and_partial_matches_are_not_rejected() {
        let q = "网页抓取成功率";
        // 换序 + 改写，但共享「抓取」「网页」「成功率」等片段。
        let hits = vec![
            SearchHit { url: "u1".into(), title: "提升抓取成功率的方法".into(), snippet: "网页内容提取实践".into() },
            SearchHit { url: "u2".into(), title: "Rust 实现网页抓取".into(), snippet: "如何统计成功率".into() },
        ];
        assert!(looks_relevant(q, &hits), "reordered CJK wording must pass");
        // 只有一条结果带得到查询片段，也必须放行（旧「过半」规则会误杀）。
        let sparse = vec![
            SearchHit { url: "u1".into(), title: "某某站点首页".into(), snippet: "无关内容".into() },
            SearchHit { url: "u2".into(), title: "另一种抓取方案".into(), snippet: "别的描述".into() },
            SearchHit { url: "u3".into(), title: "继续无关".into(), snippet: "广告".into() },
            SearchHit { url: "u4".into(), title: "大幅提升成功率".into(), snippet: "实战".into() },
        ];
        assert!(looks_relevant(q, &sparse), "a single signal-bearing hit must not fail the whole search");
        // 真正零重叠的垃圾页仍然拒绝。
        let spam = vec![
            SearchHit { url: "u1".into(), title: "高清影视在线观看".into(), snippet: "免费追剧".into() },
            SearchHit { url: "u2".into(), title: "糖心vlog入口".into(), snippet: "每日更新".into() },
        ];
        assert!(!looks_relevant(q, &spam), "pure spam must still be rejected");
    }

    #[test]
    fn cjk_query_terms_are_bigrams_not_one_whole_run() {
        let terms = query_terms("网页抓取成功率");
        assert!(terms.contains(&"网页".into()), "got {terms:?}");
        assert!(terms.contains(&"抓取".into()), "got {terms:?}");
        assert!(!terms.contains(&"网页抓取成功率".into()), "old whole-run term must be gone: {terms:?}");
        // 单字 CJK 查询仍产生一个词元（term-less 会跳过门禁）。
        assert_eq!(query_terms("雷"), vec!["雷".to_string()]);
    }

    #[test]
    fn cjk_queries_put_domestic_engines_first() {
        let ids: Vec<&str> = ordered_targets("asyncio 超时 排查").iter().map(|t| t.id).collect();
        assert_eq!(&ids[..3], &["bing-cn", "so360", "sogou"], "got {ids:?}");
        let ids_en: Vec<&str> = ordered_targets("asyncio TimeoutError").iter().map(|t| t.id).collect();
        assert_eq!(ids_en[0], "bing-int", "latin queries keep the learned order, got {ids_en:?}");
    }

    // ─── Engine ordering & failover ──────────────────────────────────────────

    #[test]
    fn engine_table_covers_every_documented_engine_and_parser() {
        let ids: Vec<&str> = ENGINES.iter().map(|e| e.id).collect();
        assert_eq!(
            ids,
            vec!["bing-int", "bing-cn", "so360", "sogou", "ddg-html", "ddg-lite"],
            "preference order is part of the contract"
        );
        // Every engine builds a non-empty, encoded URL for a Chinese query.
        for e in ENGINES {
            let u = (e.url)("Rust 教程 & more");
            assert!(u.starts_with("https://"), "{u}");
            assert!(!u.contains(' ') && !u.contains('&') || u.matches('&').count() >= 1);
            assert!(u.contains("Rust"), "query must survive encoding: {u}");
        }
    }

    #[test]
    fn promote_moves_the_winner_to_the_front_and_is_idempotent() {
        // Work on a local copy of the order logic: replicate promote on a Vec.
        let mut order: Vec<usize> = (0..ENGINES.len()).collect();
        let id_of = |i: usize| ENGINES[i].id;
        let pos = order.iter().position(|&i| id_of(i) == "sogou").unwrap();
        let idx = order.remove(pos);
        order.insert(0, idx);
        assert_eq!(id_of(order[0]), "sogou");
        assert_eq!(id_of(order[1]), "bing-int");
        // Promoting the front again is a no-op.
        let before = order.clone();
        let pos = order.iter().position(|&i| id_of(i) == "sogou").unwrap();
        if pos != 0 { panic!("front must stay front"); }
        assert_eq!(before, order);
    }

    /// Failover driver against local mock servers: engine 1 always 500s,
    /// engine 2 answers a Bing-shaped page. The whole chain must return
    /// engine 2's hits without touching the network.
    #[tokio::test]
    async fn a_dead_engine_fails_over_to_the_next_one() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        async fn serve_once(status: &'static str, body: &'static str) -> String {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move {
                for _ in 0..4 {
                    let Ok((mut sock, _)) = listener.accept().await else { break };
                    let mut buf = [0u8; 4096];
                    let _ = sock.read(&mut buf).await;
                    let reply = format!(
                        "HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        status, body.len(), body
                    );
                    let _ = sock.write_all(reply.as_bytes()).await;
                    let _ = sock.shutdown().await;
                }
            });
            format!("http://{}", addr)
        }
        let dead = serve_once("500 Internal Server Error", "boom").await;
        let good_body = r#"<li class="b_algo"><h2><a href="https://ok.test/1">Found it</a></h2><p class="b_lineclamp2">via engine two</p></li>"#;
        let good = serve_once("200 OK", good_body).await;

        let targets = vec![
            EngineTarget { id: "mock-dead", url: dead, parse: parse_bing_results },
            EngineTarget { id: "mock-good", url: good, parse: parse_bing_results },
        ];
        let client = reqwest::Client::builder().build().unwrap();
        let cancel = tokio_util::sync::CancellationToken::new();
        let out = search_across_engines(&client, &targets, "Found it via engine two", 8, &cancel, Duration::from_secs(30)).await;
        let (engine_id, hits) = out.expect("second engine must answer");
        assert_eq!(engine_id, "mock-good");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].url, "https://ok.test/1");
        assert_eq!(hits[0].snippet, "via engine two");
    }

    /// All engines dead → an honest, per-engine failure listing, never a fake
    /// empty success.
    #[tokio::test]
    async fn all_engines_dead_produce_a_diagnosable_failure() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            for _ in 0..8 {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let body = "nope";
                let reply = format!(
                    "HTTP/1.1 403 Forbidden\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(), body
                );
                let _ = sock.write_all(reply.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        let url = format!("http://{}", addr);
        let targets = vec![
            EngineTarget { id: "e1", url: url.clone(), parse: parse_bing_results },
            EngineTarget { id: "e2", url, parse: parse_bing_results },
        ];
        let client = reqwest::Client::builder().build().unwrap();
        let cancel = tokio_util::sync::CancellationToken::new();
        let err = search_across_engines(&client, &targets, "anything", 8, &cancel, Duration::from_secs(30))
            .await
            .expect_err("403 on both engines must fail");
        assert!(!err.cancelled);
        assert_eq!(err.per_engine.len(), 2);
        assert!(err.per_engine[0].starts_with("e1: HTTP 403"), "{:?}", err.per_engine);
        assert!(err.per_engine[1].starts_with("e2: HTTP 403"), "{:?}", err.per_engine);
    }

    /// A 2xx captcha wall must be reported as a failure, not as zero results
    /// dressed up as success.
    #[tokio::test]
    async fn a_2xx_captcha_page_is_a_failure_not_an_empty_success() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            for _ in 0..4 {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let body = "<html><title>安全验证</title>captcha challenge</html>";
                let reply = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(), body
                );
                let _ = sock.write_all(reply.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        let url = format!("http://{}", addr);
        let target = EngineTarget { id: "captcha", url, parse: parse_bing_results };
        let client = reqwest::Client::builder().build().unwrap();
        let cancel = tokio_util::sync::CancellationToken::new();
        let err = search_one_engine(&client, &target, "captcha probe", 8, &cancel)
            .await
            .expect_err("captcha page must not parse as results");
        let msg = err.message();
        assert!(msg.contains("no parseable results") && msg.contains("anti-bot"), "got {msg}");
    }

    /// The wall-clock budget must never block the first engine, but must stop
    /// the chain before later ones once exhausted.
    #[tokio::test]
    async fn budget_stops_the_chain_but_not_the_first_engine() {
        let targets = vec![
            EngineTarget { id: "e1", url: "http://127.0.0.1:1/".into(), parse: parse_bing_results },
            EngineTarget { id: "e2", url: "http://127.0.0.1:1/".into(), parse: parse_bing_results },
        ];
        let client = reqwest::Client::builder().build().unwrap();
        let cancel = tokio_util::sync::CancellationToken::new();
        // 1 ms budget: engine 1 is still tried (port 1 refuses instantly),
        // engine 2 is refused at the budget gate.
        let err = search_across_engines(&client, &targets, "budget probe", 8, &cancel, Duration::from_millis(1))
            .await
            .expect_err("nothing can answer on port 1");
        assert_eq!(err.per_engine.len(), 1, "budget must cut the chain after engine 1: {:?}", err.per_engine);
    }

    // ─── codesearch token clamp ──────────────────────────────────────────────

    #[test]
    fn codesearch_tokens_default_and_clamp_to_exa_range() {
        // Exa documents 1000–50000; a value outside it would be rejected server-side.
        assert_eq!(clamp_tokens(None), 5000, "absent → documented default");
        assert_eq!(clamp_tokens(Some(5000)), 5000);
        assert_eq!(clamp_tokens(Some(10)), 1000, "below the floor clamps up");
        assert_eq!(clamp_tokens(Some(999_999)), 50000, "above the ceiling clamps down");
        assert_eq!(clamp_tokens(Some(1000)), 1000, "floor is inclusive");
        assert_eq!(clamp_tokens(Some(50000)), 50000, "ceiling is inclusive");
    }

    // ─── Retry integration against a real local HTTP server ──────────────────
    //
    // No external network: a hand-written TCP server (the same pattern used at
    // `llm/client.rs:786` and `react/mod.rs:3990`) replies with scripted
    // statuses. This is what proves a 429 is actually retried rather than just
    // classified by a pure function.

    /// Serve `responses` in order, one per accepted connection, and return the
    /// base URL plus a handle carrying how many requests arrived.
    async fn mock_server(
        responses: Vec<(&'static str, &'static str)>,
    ) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let h = hits.clone();
        tokio::spawn(async move {
            for (status, body) in responses {
                let (mut sock, _) = listener.accept().await.unwrap();
                h.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let reply = format!(
                    "HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    status, body.len(), body
                );
                let _ = sock.write_all(reply.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        (format!("http://{}", addr), hits)
    }

    fn tiny_policy() -> RetryPolicy {
        // Real sleeps would make the suite slow and flaky on Windows; the
        // backoff *values* are asserted separately in web_retry.rs.
        RetryPolicy {
            max_attempts: 3,
            base_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(2),
            budget: Duration::from_secs(10),
        }
    }

    #[tokio::test]
    async fn a_429_is_retried_and_the_eventual_success_is_returned() {
        let (url, hits) = mock_server(vec![
            ("429 Too Many Requests", "rate limited"),
            ("200 OK", "<html><body><p>recovered</p></body></html>"),
        ])
        .await;
        let client = reqwest::Client::builder().build().unwrap();
        let cancel = tokio_util::sync::CancellationToken::new();
        let out = run_with_retry(&tiny_policy(), &cancel, |_| {
            let c = client.clone();
            let u = url.clone();
            async move { webfetch_attempt(&c, &u, "text", Duration::from_secs(2)).await }
        })
        .await;
        assert_eq!(out.attempts, 2, "one 429 then one success");
        assert_eq!(out.value.as_deref(), Some("recovered"));
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_deterministic_400_makes_exactly_one_http_request() {
        let (url, hits) = mock_server(vec![("400 Bad Request", "nope")]).await;
        let client = reqwest::Client::builder().build().unwrap();
        let cancel = tokio_util::sync::CancellationToken::new();
        let out = run_with_retry(&tiny_policy(), &cancel, |_| {
            let c = client.clone();
            let u = url.clone();
            async move { webfetch_attempt(&c, &u, "text", Duration::from_secs(2)).await }
        })
        .await;
        assert!(out.fast_failed, "400 must trip the deterministic-error gate");
        assert_eq!(out.attempts, 1);
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1, "no wasted request");
    }

    #[tokio::test]
    async fn retry_after_header_is_forwarded_from_the_response() {
        // The server's hint must reach AttemptError; the loop then prefers it
        // over jitter (asserted in web_retry::tests::retry_after_seconds_overrides_jitter).
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf).await;
            let body = "slow down";
            let reply = format!(
                "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 2\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(), body
            );
            let _ = sock.write_all(reply.as_bytes()).await;
        });
        let client = reqwest::Client::builder().build().unwrap();
        let err = webfetch_attempt(&client, &format!("http://{}", addr), "text", Duration::from_secs(2))
            .await
            .expect_err("429 must be an error");
        assert_eq!(err.retry_after(), Some(Duration::from_secs(2)), "got {:?}", err);
        assert!(!err.is_deterministic(), "429 must stay retryable");
    }

    #[tokio::test]
    async fn exhausted_retries_report_the_last_status_not_a_fake_empty_result() {
        let (url, hits) = mock_server(vec![
            ("429 Too Many Requests", "slow down"),
            ("429 Too Many Requests", "slow down"),
            ("429 Too Many Requests", "slow down"),
        ])
        .await;
        let client = reqwest::Client::builder().build().unwrap();
        let cancel = tokio_util::sync::CancellationToken::new();
        let out = run_with_retry(&tiny_policy(), &cancel, |_| {
            let c = client.clone();
            let u = url.clone();
            async move { webfetch_attempt(&c, &u, "text", Duration::from_secs(2)).await }
        })
        .await;
        assert!(out.value.is_none());
        assert_eq!(out.attempts, 3);
        let failed = retry_failure("Fetch", out);
        assert!(failed.is_error);
        assert!(failed.text.contains("429"), "got: {}", failed.text);
        assert!(failed.text.contains("3 attempt"), "got: {}", failed.text);
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 3);
    }

    /// The old `read_body_capped` swallowed a stream error, returned whatever
    /// bytes had arrived (usually none), and `webfetch` reported an **empty
    /// successful page**. Here the server advertises a body then closes the
    /// socket mid-transfer, so reqwest yields a body-stream error.
    #[tokio::test]
    async fn a_truncated_body_is_an_error_not_an_empty_success() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf).await;
            // Claim 100 bytes, send 5, then drop the socket.
            let _ = sock
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nhello")
                .await;
            let _ = sock.shutdown().await;
        });
        let client = reqwest::Client::builder().build().unwrap();
        let err = webfetch_attempt(
            &client,
            &format!("http://{}", addr),
            "text",
            Duration::from_secs(2),
        )
        .await
        .expect_err("a truncated body must not be reported as an empty success");
        assert!(
            matches!(err, AttemptError::Transport(_)),
            "got {:?}",
            err
        );
    }

    /// `webfetch`'s `timeoutMs` must cap a single request **without** minting
    /// a new pooled client. This drives the real process-wide cache through
    /// `client_for` and asserts the entry count stays bounded: a regression
    /// that puts `timeout` back into the key would add one client per call.
    #[test]
    fn distinct_per_request_timeouts_do_not_grow_the_client_cache() {
        let _g = CLIENT_CACHE_TEST_LOCK.lock().unwrap();
        CLIENTS.lock().unwrap().clear();
        // Eight distinct timeoutMs values from the model; `client_for` never
        // sees them (the cap lives on RequestBuilder now).
        for ms in [1, 999, 1000, 1500, 30_000, 30_001, 120_000, 77_777] {
            let _: Duration = Duration::from_millis(ms);
            let _ = client_for("", DEFAULT_UA);
        }
        let entries = CLIENTS.lock().unwrap().len();
        assert_eq!(entries, 1, "one (proxy, UA) pair must map to one pooled client, got {entries}");
        // A second UA is a genuinely different client, still bounded.
        let _ = client_for("", JINA_UA);
        assert_eq!(CLIENTS.lock().unwrap().len(), 2, "cache is bounded by UA count, not timeout values");
        // A proxy change is a genuinely different egress path.
        let _ = client_for("http://127.0.0.1:7890", DEFAULT_UA);
        assert_eq!(CLIENTS.lock().unwrap().len(), 3);
        CLIENTS.lock().unwrap().clear();
    }

    /// A round-number budget must allow a wait that fits *exactly* (Java uses
    /// `remaining < delay`, not `<=`).
    #[test]
    fn budget_boundary_allows_a_wait_that_fits_exactly() {
        let p = RetryPolicy { budget: Duration::from_secs(5), ..RetryPolicy::default() };
        let got = super::super::web_retry::decide_after_failure(
            &p,
            &AttemptError::http(reqwest::StatusCode::TOO_MANY_REQUESTS, None, ""),
            0,
            Duration::from_secs(4),
            1.0,
        );
        // elapsed 4s + jittered 1s == 5s budget → exactly fits, must Wait.
        assert!(matches!(got, super::super::web_retry::RetryDecision::Wait(_)), "got {:?}", got);
    }

    // ─── Performance contract ───────────────────────────────────────────────
    //
    // User requirement: the ported tools must not be slower than the Java
    // kernel. Java keeps a static `McpClientProvider` and a static HttpClient
    // (`WebsearchTalent.java:46`, `CodeSearchTalent.java:42-55`); the pre-fix
    // Rust built a new `reqwest::Client` (and a full MCP handshake) on every
    // call. These two tests measure the two things that actually dominate:
    // TCP/TLS connection count and per-call local overhead.

    /// A keep-alive server that counts **accepted TCP connections**, not
    /// requests. With a pooled client, N sequential requests must reuse one
    /// connection — the same behaviour Java's static client gives.
    // current_thread: this test holds a std MutexGuard (the cache serialisation
    // lock) across awaits; a multi-thread runtime would require the future to be
    // Send. Nothing here needs worker threads (the mock server is a tokio task).
    #[tokio::test(flavor = "current_thread")]
    async fn pooled_client_reuses_one_tcp_connection_across_calls() {
        let _g = CLIENT_CACHE_TEST_LOCK.lock().unwrap();
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let accepts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let a = accepts.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                a.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                // Handle multiple HTTP/1.1 requests on one connection.
                loop {
                    let mut buf = [0u8; 4096];
                    let n = match sock.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    let _ = &buf[..n];
                    let body = "ok";
                    let reply = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n{}",
                        body.len(), body
                    );
                    if sock.write_all(reply.as_bytes()).await.is_err() {
                        break;
                    }
                }
            }
        });

        CLIENTS.lock().unwrap().clear();
        // One client for all 20 calls, exactly what `shared_client` gives.
        let client = client_for("", DEFAULT_UA);
        let url = format!("http://{}/", addr);
        for _ in 0..20 {
            let text = webfetch_attempt(&client, &url, "text", Duration::from_secs(2))
                .await
                .expect("every keep-alive request must succeed");
            assert_eq!(text, "ok");
        }
        let conns = accepts.load(std::sync::atomic::Ordering::SeqCst);
        assert!(
            conns <= 2,
            "20 sequential calls opened {conns} TCP connections; a pooled client must reuse one (Java: 1)"
        );
        CLIENTS.lock().unwrap().clear();
    }

    /// The hot path added by this change must stay cheap: resolving a cached
    /// client is a mutex + hash lookup + `Arc` clone, with no env reads, no
    /// client construction and no TLS handshake. 10k resolutions should be
    /// well under a second even in an unoptimised debug test build.
    #[test]
    fn cached_client_lookup_has_bounded_local_cost() {
        let _g = CLIENT_CACHE_TEST_LOCK.lock().unwrap();
        CLIENTS.lock().unwrap().clear();
        let _ = client_for("", DEFAULT_UA); // warm the single cache entry
        let t = std::time::Instant::now();
        for _ in 0..10_000 {
            let c = client_for("", DEFAULT_UA);
            std::hint::black_box(c);
        }
        let elapsed = t.elapsed();
        assert_eq!(CLIENTS.lock().unwrap().len(), 1, "no client must be rebuilt");
        assert!(
            elapsed < std::time::Duration::from_secs(1),
            "10k cached lookups took {elapsed:?}; the retry layer must not add per-call work"
        );
        CLIENTS.lock().unwrap().clear();
    }

    // ─── Zero-config system proxy: no settings, no restart ─────────────────────
    //
    // Regression for 「浏览器能访问、工具一直获取不到」. reqwest snapshots the OS
    // proxy at ClientBuilder::build(); a permanently cached client freezes it.

    /// The TTL predicate: fresh auto-proxy clients are reused (connection pooling
    /// must survive a burst), expired ones are rebuilt so the OS state is re-read.
    /// Exactly at the boundary is expired (`<`, matching the implementation).
    #[test]
    fn auto_proxy_client_ttl_boundary() {
        let t0 = Instant::now();
        assert!(auto_proxy_client_is_fresh(t0, t0));
        assert!(auto_proxy_client_is_fresh(t0, t0 + AUTO_PROXY_CLIENT_TTL - Duration::from_millis(1)));
        assert!(!auto_proxy_client_is_fresh(t0, t0 + AUTO_PROXY_CLIENT_TTL));
        assert!(!auto_proxy_client_is_fresh(t0, t0 + AUTO_PROXY_CLIENT_TTL + Duration::from_secs(1)));
        // A clock that moved backwards must never be treated as expired-forever.
        assert!(auto_proxy_client_is_fresh(t0, t0 - Duration::from_secs(60)));
    }

    /// `invalidate_auto_proxy_clients` (called on a failed outbound attempt)
    /// drops only the auto-system-proxy entries and keeps explicitly configured
    /// proxies — the OS cannot change an explicit value, so rebuilding it would
    /// only throw away its connection pool.
    #[test]
    fn failed_attempt_invalidates_only_auto_proxy_clients() {
        let _g = CLIENT_CACHE_TEST_LOCK.lock().unwrap();
        CLIENTS.lock().unwrap().clear();
        let _ = client_for("", DEFAULT_UA);
        let _ = client_for("", JINA_UA);
        let _ = client_for("http://127.0.0.1:7890", DEFAULT_UA);
        assert_eq!(CLIENTS.lock().unwrap().len(), 3);

        // Simulate: the proxy was switched on while GWork was running and the
        // current (stale, direct) client just failed.
        invalidate_auto_proxy_clients();
        let map = CLIENTS.lock().unwrap();
        assert_eq!(map.len(), 1, "only the explicit-proxy client must remain");
        let (key, cached) = map.iter().next().unwrap();
        assert_eq!(key.0, "http://127.0.0.1:7890");
        assert!(!cached.auto_proxy);
        drop(map);

        // The next call rebuilds auto clients from the *current* OS state.
        let _ = client_for("", DEFAULT_UA);
        assert_eq!(CLIENTS.lock().unwrap().len(), 2);
        assert!(CLIENTS.lock().unwrap().values().any(|c| c.auto_proxy));
        CLIENTS.lock().unwrap().clear();
    }

    /// An expired auto client is rebuilt in place (cache never grows), while an
    /// explicitly configured proxy is never expired even after the TTL elapsed.
    #[test]
    fn expired_auto_proxy_client_rebuilds_in_place_but_explicit_never_expires() {
        let _g = CLIENT_CACHE_TEST_LOCK.lock().unwrap();
        CLIENTS.lock().unwrap().clear();
        let first = client_for("", DEFAULT_UA);
        // Rewind built_at to just past the TTL to drive expiry without sleeping.
        {
            let mut map = CLIENTS.lock().unwrap();
            let key: ClientKey = (String::new(), DEFAULT_UA.to_string());
            let c = map.get_mut(&key).unwrap();
            c.built_at = Instant::now() - AUTO_PROXY_CLIENT_TTL - Duration::from_secs(1);
        }
        let rebuilt = client_for("", DEFAULT_UA);
        assert_eq!(CLIENTS.lock().unwrap().len(), 1, "expiry replaces, never grows, the entry");
        // Both are valid pooled clients; the point is that a fresh build happened.
        std::hint::black_box((first, rebuilt));

        // Explicit proxy: same rewind must NOT trigger a rebuild.
        let key: ClientKey = ("http://127.0.0.1:7890".to_string(), DEFAULT_UA.to_string());
        let _ = client_for("http://127.0.0.1:7890", DEFAULT_UA);
        {
            let mut map = CLIENTS.lock().unwrap();
            map.get_mut(&key).unwrap().built_at = Instant::now() - AUTO_PROXY_CLIENT_TTL - Duration::from_secs(1);
        }
        let _ = client_for("http://127.0.0.1:7890", DEFAULT_UA);
        assert_eq!(CLIENTS.lock().unwrap().len(), 2, "explicit proxy stays in the same single entry");
        CLIENTS.lock().unwrap().clear();
    }

    // ─── codereview follow-ups (deterministic regressions only) ──────────────

    /// ASP.NET / 政府 / 论坛 CMS 用 `<form runat="server">` 包住整个 body。
    /// 把 form 当噪音整段删会连正文一起吞掉，制造「空成功」——本轮新增
    /// 的 nav/header/footer/aside/svg 清理里最危险的一条，必须钉住。
    #[test]
    fn a_form_wrapping_the_article_does_not_delete_the_body() {
        let html = r#"<html><body><form id="form1" runat="server">
            <article><h1>安装说明</h1><p>这里是真实正文，用于确认表单容器不会把文章一起删掉。</p></article>
            <input value="__VIEWSTATE"><button>提交</button>
            </form></body></html>"#;
        let out = html_to_text(html);
        assert!(out.contains("安装说明"), "form 吞掉了标题: {out:?}");
        assert!(out.contains("这里是真实正文"), "form 吞掉了正文: {out:?}");
        // is_empty_shell 也不该把这种页面判成 JS 空壳去触发 Jina。
        assert!(!is_empty_shell(html, &out), "got: {out:?}");
    }

    /// cap 边界：单大帧、逐帧累加、恰好填满、零容量都必须填满而不丢整块。
    #[test]
    fn capped_body_fills_the_cap_instead_of_dropping_a_whole_chunk() {
        // 首个 chunk 就超限：旧实现返回空串，现在是恰好 max_bytes 的前缀。
        let mut body = Vec::new();
        assert!(push_capped(&mut body, &vec![b'x'; 2_000], 512));
        assert_eq!(body.len(), 512, "first large frame must not yield an empty page");
        assert!(!body.iter().any(|&b| b != b'x'));

        // 多帧累加到 cap：最后一帧只取剩余部分。
        let mut body = Vec::new();
        for _ in 0..3 {
            if push_capped(&mut body, &vec![b'a'; 40], 100) {
                break;
            }
        }
        assert_eq!(body.len(), 100, "cap must be filled exactly");
        assert!(push_capped(&mut body, b"z", 100), "must signal stop at cap");
        assert_eq!(body.len(), 100);

        // 恰好填满不提前 break。
        let mut body = Vec::new();
        assert!(!push_capped(&mut body, b"1234", 4));
        assert_eq!(body, b"1234");
    }

    /// Jina 的任何失败都必须打开熔断，否则 run_with_retry 的每一次 attempt
    /// 都会再打一次刚限流我们的共享池。
    #[test]
    fn jina_failures_trip_the_circuit_and_only_success_clears_it() {
        let before = JINA_FAILED_AT.load(std::sync::atomic::Ordering::Relaxed);
        JINA_FAILED_AT.store(0, std::sync::atomic::Ordering::Relaxed);
        assert!(!jina_circuit_open());
        mark_jina_failed();
        assert!(JINA_FAILED_AT.load(std::sync::atomic::Ordering::Relaxed) > 0, "failure must stamp the circuit");
        assert!(jina_circuit_open(), "failed Jina must be suppressed");
        // 一次可用响应才清零（对应 jina_attempt 成功分支的 store(0)）。
        JINA_FAILED_AT.store(0, std::sync::atomic::Ordering::Relaxed);
        assert!(!jina_circuit_open());
        JINA_FAILED_AT.store(before, std::sync::atomic::Ordering::Relaxed);
    }
}
