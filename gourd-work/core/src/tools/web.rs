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
use std::time::Duration;

use super::registry::{Tool, ToolContext, ToolOutput};
use super::web_retry::{
    build_client_with_ua, configured_proxy, run_with_retry, AttemptError, RetryOutcome,
    RetryPolicy,
};

/// Default User-Agent for the plain HTTP tools.
const DEFAULT_UA: &str = "Mozilla/5.0 (compatible; GWork/0.3)";
/// Browser-shaped UA Jina Reader expects (same string as Java's JINA driver,
/// `WebCrawlerDriverTalent.java:83`).
const JINA_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

/// Process-wide HTTP client pool.
///
/// `reqwest::Client` internally holds an `Arc` to its connection pool, so
/// cloning is cheap. Caching by (proxy + env fingerprint, UA) means a normal
/// run builds one client for all four tools and keeps TLS/HTTP2 connections
/// alive across calls, instead of rebuilding a client and re-handshaking on
/// every tool invocation — which is what the old code did at `web.rs:36`,
/// `:286`, `:426`.
///
/// **The per-request timeout is deliberately NOT part of the key**: `webfetch`
/// takes a model-supplied `timeoutMs` (1..120000), so including it would mint
/// an unbounded number of pooled clients. Callers use
/// `RequestBuilder::timeout(d)` instead, which applies to that one request
/// including its body stream (reqwest 0.12 `request.rs:291`). The environment
/// is a startup constant (as in Java), so no per-call env read is needed and
/// the cache has exactly one entry per (proxy, UA) — bounded by the two UA
/// constants below.
/// Cache key: (configured proxy, User-Agent).
type ClientKey = (String, String);
static CLIENTS: Lazy<Mutex<HashMap<ClientKey, reqwest::Client>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Resolve and cache a pooled client for one (proxy, UA) pair. Split out of
/// [`shared_client`] so the cache-bounding property is testable without
/// constructing a full `ToolContext` (which has no `Default`).
fn client_for(raw_proxy: &str, ua: &str) -> reqwest::Client {
    let proxy = configured_proxy(raw_proxy);
    let key = (proxy.clone(), ua.to_string());
    if let Ok(map) = CLIENTS.lock() {
        if let Some(c) = map.get(&key) {
            return c.clone();
        }
    }
    let client = build_client_with_ua(&proxy, ua);
    if let Ok(mut map) = CLIENTS.lock() {
        map.insert(key, client.clone());
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

/// Web search via a configurable search API.
/// Default implementation uses DuckDuckGo HTML endpoint (no API key required).
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

        let client = shared_client(ctx, DEFAULT_UA);
        let url = format!(
            "https://html.duckduckgo.com/html/?q={}",
            url::form_urlencoded::byte_serialize(query.as_bytes()).collect::<String>()
        );
        let policy = http_policy(ctx);
        let out = run_with_retry(&policy, &ctx.cancel, |_| {
            let client = client.clone();
            let url = url.clone();
            async move {
                // Per-request timeout: the client is pooled across all tools,
                // so the cap must live on the request, not on the client.
                let resp = client.get(&url).timeout(Duration::from_secs(30)).send().await
                    .map_err(|e| AttemptError::transport(e.to_string()))?;
                let status = resp.status();
                let after = retry_after_of(&resp);
                if !status.is_success() {
                    return Err(status_error(status, after));
                }
                let html = read_body_capped(resp, 1_048_576).await?;
                let results = parse_ddg_results(&html, num);
                if results.is_empty() {
                    // Zero parsed results is almost never a genuine "the web
                    // has nothing on this": DDG serves a **2xx anti-bot /
                    // anomaly page**, so `is_success` cannot catch it. Report
                    // it as a 429-shaped error so the retry loop treats a soft
                    // block as a transient rejection rather than returning
                    // "No results found." as if the search had succeeded.
                    let hint = if looks_like_bot_block(&html) {
                        "anti-bot / anomaly page"
                    } else {
                        "no result anchors matched (markup may have changed)"
                    };
                    return Err(AttemptError::http(
                        reqwest::StatusCode::TOO_MANY_REQUESTS,
                        after,
                        format!("Search returned no parseable results ({}; {} bytes)", hint, html.len()),
                    ));
                }
                Ok(results.join("\n\n"))
            }
        })
        .await;

        match out.value {
            Some(text) => ToolOutput::ok(text),
            None => {
                let mut o = retry_failure("Search", out);
                // Make the failure mode explicit: the model must not read a
                // search outage as evidence that nothing exists on the web.
                o.text.push_str(
                    ". Treat this as a search failure, not as evidence that nothing exists.",
                );
                o
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
fn parse_ddg_results(html: &str, max: usize) -> Vec<String> {
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
        results.push(format!("{}. {}\n   URL: {}\n   {}", i + 1, title, url, snippet));
    }
    results
}

fn strip_html(s: &str) -> String {
    // Reuse the compiled `TAG_RE` rather than building an identical pattern per
    // call: this runs once per result anchor per search.
    let text = TAG_RE.replace_all(s, "");
    decode_entities(&text).trim().to_string()
}

/// Decode the entities both DDG snippets and fetched pages actually contain.
fn decode_entities(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

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
async fn read_body_capped(
    resp: reqwest::Response,
    max_bytes: u64,
) -> Result<String, AttemptError> {
    use futures_util::StreamExt;
    let mut body: Vec<u8> = Vec::with_capacity(64 * 1024);
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(b) => {
                if body.len() as u64 + b.len() as u64 > max_bytes {
                    break;
                }
                body.extend_from_slice(&b);
            }
            Err(e) => {
                return Err(AttemptError::transport(format!(
                    "response body read failed: {}",
                    e
                )));
            }
        }
    }
    Ok(crate::textcodec::decode_bytes(&body))
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
    let send = |extra_ua: Option<&str>| {
        let mut req = client.get(url).timeout(timeout);
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

        let client = shared_client(ctx, DEFAULT_UA);
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
            None => retry_failure("Fetch", out),
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
        "使用 Exa Code API 搜索并获取任何编程任务的相关上下文\n- 为库、SDK 和 API 提供最高质量且最实时的上下文信息\n- 适用于任何与编程相关的疑问或任务\n- 返回详尽的代码示例、技术文档和 API 参考\n- 针对寻找特定编程模式和解决方案进行了优化\n\n使用说明：\n- 可调节 Token 数量 (1000-50000) 以获得精确或详尽的结果\n- 默认 5000 Token 为大多数查询提供均衡的上下文\n- 支持关于框架、库、API 以及编程概念的查询\n- 示例：'React 状态管理'、'Spring Boot 响应式编程'、'Node.js 插件开发'"
    }
    fn readonly(&self) -> bool { true }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "搜索查询词，用于查找 API、库和 SDK 的相关上下文。 例如：'React useState 钩子示例'、'Python pandas 数据框过滤'、'Express.js 中间件'、'Next.js 局部预渲染配置'"},
                "tokensNum": {"type": "integer", "description": "返回的 Token 数量 (1000-50000)。默认为 5000。 根据需要的上下文量进行调整：针对特定问题使用较低值，针对全面文档使用较高值。"}
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
                    .call_tool(EXA_MANAGER_NAME, EXA_CODESEARCH_TOOL, json!({"query": query, "tokensNum": tokens}))
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

#[async_trait]
impl Tool for CrawlUrlTool {
    fn name(&self) -> &str { "crawl_url" }
    fn description(&self) -> &str {
        "读取并分析指定 URL 网页的详细内容，返回降噪后的 Markdown（保留标题、列表与代码块）。适合需要结构化正文而非纯文本的场景。"
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

        let client = shared_client(ctx, JINA_UA);
        let policy = http_policy(ctx);
        let out = run_with_retry(&policy, &ctx.cancel, |_| {
            let client = client.clone();
            let url = url.to_string();
            async move {
                let req = client
                    .get(format!("{}{}", JINA_READER_PREFIX, url))
                    .timeout(Duration::from_secs(30))
                    .header("Accept", "text/plain")
                    // Ask Jina for Markdown. `X-No-Cache: true` is deliberately
                    // **gone**: it forced an upstream refetch on every call and
                    // pushed a keyless client straight into the 20 RPM shared
                    // pool. Jina's own docs recommend using its cache.
                    .header("X-Return-Format", "markdown");
                let resp = req.send().await.map_err(|e| AttemptError::transport(e.to_string()))?;
                let status = resp.status();
                if !status.is_success() {
                    // Rate limiting is an HTTP status (429 in practice), not a
                    // marker in the body. Forwarding it as AttemptError::Http
                    // lets the shared retry loop honour `Retry-After` instead
                    // of returning the rate-limit page as if it were content.
                    return Err(status_error(status, retry_after_of(&resp)));
                }
                let body = read_body_capped(resp, 1_048_576).await?;
                if body.trim().is_empty() {
                    return Err(AttemptError::transport("目标页面返回空内容"));
                }
                Ok(body.chars().take(80_000).collect::<String>())
            }
        })
        .await;

        match out.value {
            Some(text) => ToolOutput::ok(text),
            None => retry_failure("抓取", out),
        }
    }
}

// ─── HTML → text ─────────────────────────────────────────────────────────────
//
// Compiled once. `webfetch` is on the tool hot path and rebuilding four regexes
// per call is pure waste; `Lazy` also means a syntax error surfaces on first use
// rather than being re-paid every request.

/// Script / style / noscript blocks, content included.
///
/// **Three patterns, not one.** The original was
/// `<(script|style|noscript)[^>]*>.*?</\1>` — a backreference, which the `regex`
/// crate does not support at all. `Regex::new` returned `Err` and the `.unwrap()`
/// therefore **panicked on every webfetch call**, taking the ReAct loop with it.
///
/// Neither `cargo build` nor `cargo test` catches this: a regex literal is just a
/// string until something evaluates it, and nothing did — this module had no
/// tests. Only `cargo clippy`'s `invalid_regex` lint (compile-time evaluation of
/// literals) found it. The tests below now exercise `html_to_text` directly, so
/// an invalid pattern fails the suite instead of production.
static SCRIPT_RES: Lazy<[regex::Regex; 3]> = Lazy::new(|| {
    [
        regex::Regex::new(r"(?is)<script[^>]*>.*?</script>").unwrap(),
        regex::Regex::new(r"(?is)<style[^>]*>.*?</style>").unwrap(),
        regex::Regex::new(r"(?is)<noscript[^>]*>.*?</noscript>").unwrap(),
    ]
});

/// Block-level closing tags, replaced by a newline so paragraphs do not run together.
static BLOCK_RE: Lazy<regex::Regex> =
    Lazy::new(|| regex::Regex::new(r"(?i)</(p|div|h[1-6]|li|tr|br|section|article)>").unwrap());

/// Any remaining tag.
static TAG_RE: Lazy<regex::Regex> = Lazy::new(|| regex::Regex::new(r"<[^>]+>").unwrap());

/// Three or more consecutive newlines, collapsed to two.
static BLANK_RE: Lazy<regex::Regex> = Lazy::new(|| regex::Regex::new(r"\n{3,}").unwrap());

/// Basic HTML → text conversion (strip scripts/styles/tags, collapse whitespace).
fn html_to_text(html: &str) -> String {
    // Remove script and style blocks. Each pass is a separate pattern because the
    // crate cannot express "close tag matches open tag" without backreferences.
    // Owned String, not Cow: each `replace_all` borrows its input, so feeding the
    // result back into the same binding would be a self-borrow.
    let mut cleaned = html.to_string();
    for re in SCRIPT_RES.iter() {
        cleaned = re.replace_all(&cleaned, "").into_owned();
    }
    // Replace block-level tags with newlines
    let with_newlines = BLOCK_RE.replace_all(&cleaned, "\n");
    // Strip remaining tags
    let text = TAG_RE.replace_all(&with_newlines, "");
    // Decode common entities
    let text = decode_entities(&text);
    // Collapse multiple blank lines
    let text = BLANK_RE.replace_all(&text, "\n\n");
    text.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

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
        ];
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

    /// Malformed HTML must degrade to text, never panic: the input comes from an
    /// arbitrary remote server.
    #[test]
    fn malformed_html_does_not_panic() {
        for bad in ["<p>unclosed", "<script>never closed", "<<<>>>", "</p></p>", "<a href=\"x\">y"] {
            let _ = html_to_text(bad);
        }
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

    fn result_url(results: &[String], i: usize) -> String {
        results[i]
            .lines()
            .find(|l| l.trim().starts_with("URL:"))
            .map(|l| l.split("URL:").nth(1).unwrap().trim().to_string())
            .unwrap_or_default()
    }

    #[test]
    fn parses_results_with_href_before_class() {
        // The old fixed-order pattern required class=...href=... and matched
        // nothing when the server emitted the attributes the other way round.
        let html = r#"<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.test&rut=1" class="result__a">Alpha</a>
<a class="result__snippet">snippet for alpha</a>"#;
        let out = parse_ddg_results(html, 8);
        assert_eq!(out.len(), 1, "href-first ordering must still parse");
        assert_eq!(result_url(&out, 0), "https://a.test");
        assert!(out[0].contains("Alpha") && out[0].contains("snippet for alpha"));
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
        assert!(out[0].contains("S1"), "got: {:?}", out[0]);
        assert!(!out[1].contains("S1") && !out[1].contains("S3"), "middle must have no snippet: {:?}", out[1]);
        assert!(out[2].contains("S3"), "third must pair with S3, not S1: {:?}", out[2]);
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
        // Feeds the bot-block branch in `execute`; an empty parse is what makes
        // that path report failure instead of a fake "No results found."
        assert!(parse_ddg_results("<html><body>nothing here</body></html>", 8).is_empty());
    }

    #[test]
    fn class_matching_is_token_wise_not_substring() {
        // `result__aside` (hypothetical) must not be treated as `result__a`.
        let html = r#"<a class="result__aside" href="https://x.test">Aside</a>
<a class="result__a" href="https://real.test">Real</a>"#;
        let out = parse_ddg_results(html, 8);
        assert_eq!(out.len(), 1);
        assert_eq!(result_url(&out, 0), "https://real.test");
    }

    #[test]
    fn bot_block_markers_are_detected() {
        assert!(looks_like_bot_block("<html>Detected Anomalous Traffic</html>"));
        assert!(looks_like_bot_block("solve this CAPTCHA"));
        assert!(!looks_like_bot_block("<html><a class=result__a>ok</a></html>"));
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
    #[tokio::test]
    async fn pooled_client_reuses_one_tcp_connection_across_calls() {
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
}
