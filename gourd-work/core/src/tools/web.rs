//! Web tools: websearch and webfetch.

use async_trait::async_trait;
use once_cell::sync::Lazy;
use serde_json::json;

use super::registry::{Tool, ToolContext, ToolOutput};

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
    async fn execute(&self, args: serde_json::Value, _ctx: &ToolContext) -> ToolOutput {
        let query = args["query"].as_str().unwrap_or_default();
        if query.is_empty() {
            return ToolOutput::err("Empty query");
        }
        let num = args["numResults"].as_u64().unwrap_or(8).min(20) as usize;

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .user_agent("Mozilla/5.0 (compatible; GWork/0.3)")
            .build()
            .unwrap();

        // DuckDuckGo HTML search (no key needed)
        let url = format!(
            "https://html.duckduckgo.com/html/?q={}",
            url::form_urlencoded::byte_serialize(query.as_bytes()).collect::<String>()
        );
        match client.get(&url).send().await {
            Ok(resp) => {
                let status = resp.status();
                let html = read_body_capped(resp, 1_048_576).await;
                if !status.is_success() {
                    return ToolOutput::err(format!(
                        "Search request failed: HTTP {} for query {:?}",
                        status, query
                    ));
                }
                let results = parse_ddg_results(&html, num);
                if results.is_empty() {
                    // Zero parsed results is almost never a genuine "the web has
                    // nothing on this": it means the endpoint served a soft block
                    // (a 2xx anomaly page, which `is_success` cannot catch) or
                    // changed its markup. The old code answered
                    // `ok("No results found.")`, so the model read a failure as a
                    // legitimate empty result and stopped looking — a silent
                    // failure wearing a success flag.
                    let hint = if looks_like_bot_block(&html) {
                        "the endpoint returned an anti-bot / anomaly page"
                    } else {
                        "no result anchors matched, so the page markup may have changed"
                    };
                    return ToolOutput::err(format!(
                        "Search returned no parseable results ({}; HTTP {}, {} bytes). \
                         Treat this as a search failure, not as evidence that nothing exists.",
                        hint,
                        status,
                        html.len()
                    ));
                }
                ToolOutput::ok(results.join("\n\n"))
            }
            Err(e) => ToolOutput::err(format!("Search request failed: {}", e)),
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
/// *result*, never the *read*. This reads the stream and stops at `max_bytes`,n/// keeping whatever arrived so the caller can still report/truncate it.
/// Mirrors `skills/market.rs`'s MAX_API_BODY_BYTES pattern.
async fn read_body_capped(mut resp: reqwest::Response, max_bytes: u64) -> String {
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
            Err(_) => break,
        }
    }
    crate::textcodec::decode_bytes(&body)
}

/// Fetch a web page and return its content as text/markdown.
pub struct WebFetchTool;

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
                "format": {"type": "string", "description": "Output format: text (default) or html"}
            },
            "required": ["url"]
        })
    }
    async fn execute(&self, args: serde_json::Value, _ctx: &ToolContext) -> ToolOutput {
        let url = args["url"].as_str().unwrap_or_default();
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return ToolOutput::err("URL must start with http:// or https://");
        }
        let format = args["format"].as_str().unwrap_or("text");

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .user_agent("Mozilla/5.0 (compatible; GWork/0.3)")
            .build()
            .unwrap();

        match client.get(url).send().await {
            Ok(resp) => {
                let status = resp.status();
                if !status.is_success() {
                    return ToolOutput::err(format!("HTTP {}", status));
                }
                let body = read_body_capped(resp, 1_048_576).await;
                if format == "html" {
                    let truncated: String = body.chars().take(100_000).collect();
                    ToolOutput::ok(truncated)
                } else {
                    // Strip HTML to text
                    let text = html_to_text(&body);
                    let truncated: String = text.chars().take(80_000).collect();
                    ToolOutput::ok(truncated)
                }
            }
            Err(e) => ToolOutput::err(format!("Fetch failed: {}", e)),
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
    async fn execute(&self, args: serde_json::Value, _ctx: &ToolContext) -> ToolOutput {
        let query = args["query"].as_str().unwrap_or_default().trim();
        if query.is_empty() {
            return ToolOutput::err("Empty query");
        }
        let tokens = clamp_tokens(args["tokensNum"].as_u64());

        // A throwaway manager: codesearch talks to one fixed external endpoint and
        // must not touch the user's configured MCP servers or the shared registry.
        let config = crate::mcp::McpServerConfig {
            kind: crate::mcp::TYPE_STREAMABLE.to_string(),
            url: EXA_CODESEARCH_URL.to_string(),
            timeout: "30s".to_string(),
            ..Default::default()
        };
        let mgr = crate::mcp::McpManager::new();
        let name = "exa-codesearch";
        if let Err(e) = mgr.connect_one(name, &config).await {
            return ToolOutput::err(format!("Code search connection failed: {}", e));
        }
        let result = mgr
            .call_tool(name, EXA_CODESEARCH_TOOL, json!({"query": query, "tokensNum": tokens}))
            .await;
        // Always tear down: the connection is per-call, and leaving it would leak
        // the socket (and, for SSE, the reader task).
        mgr.disconnect_one(name).await;

        match result {
            Ok(text) if !text.trim().is_empty() => ToolOutput::ok(text),
            Ok(_) => ToolOutput::ok(
                "未找到相关的代码片段或文档。请尝试更换查询词，明确具体的库或编程概念，并检查框架名称拼写是否正确。",
            ),
            Err(e) => ToolOutput::err(format!("Code search failed: {}", e)),
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
    async fn execute(&self, args: serde_json::Value, _ctx: &ToolContext) -> ToolOutput {
        let url = args["url"].as_str().unwrap_or_default().trim();
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return ToolOutput::err("错误：URL 无效（必须以 http:// 或 https:// 开头）。");
        }

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36")
            .build()
            .unwrap();

        let req = client
            .get(format!("{}{}", JINA_READER_PREFIX, url))
            .header("Accept", "text/plain")
            // Ask Jina for Markdown and to bypass its cache, matching Java's driver.
            .header("X-Return-Format", "markdown")
            .header("X-No-Cache", "true");

        match req.send().await {
            Ok(resp) => {
                let status = resp.status();
                // Rate limiting is surfaced by Jina as an HTTP status (429 in
                // practice), not by a marker in the body — a marker check here
                // would never fire and rate-limit pages would be returned to the
                // model as if they were page content. Report the status honestly
                // and name the likely cause for the retryable ones.
                if status.as_u16() == 429 {
                    return ToolOutput::err(
                        "抓取失败：Jina Reader 限流（HTTP 429）。请稍后重试或降低抓取频率。",
                    );
                }
                if !status.is_success() {
                    return ToolOutput::err(format!("抓取失败：HTTP {}", status));
                }
                // Bounded read, NOT `resp.text()`: a malicious or misbehaving
                // endpoint could otherwise feed an arbitrarily large body into
                // memory before the truncation below ever runs.
                let mut body: Vec<u8> = Vec::new();
                {
                    use futures_util::StreamExt;
                    const MAX_CRAWL_BYTES: u64 = 1_048_576; // 1 MiB read cap
                    let mut stream = resp.bytes_stream();
                    while let Some(chunk) = stream.next().await {
                        match chunk {
                            Ok(b) => {
                                if body.len() as u64 + b.len() as u64 > MAX_CRAWL_BYTES {
                                    break; // keep what we have; enough for the cap below
                                }
                                body.extend_from_slice(&b);
                            }
                            Err(_) => break,
                        }
                    }
                }
                let body = crate::textcodec::decode_bytes(&body);
                if body.trim().is_empty() {
                    return ToolOutput::err("抓取失败：目标页面返回空内容。");
                }
                // Bound the payload like webfetch does: a huge page must not
                // overflow the model context in one tool result.
                let truncated: String = body.chars().take(80_000).collect();
                ToolOutput::ok(truncated)
            }
            Err(e) => ToolOutput::err(format!("抓取失败：{}", e)),
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
}
