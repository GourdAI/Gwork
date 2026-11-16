//! LLM client — streaming completions over HTTP, across several wire protocols.
//!
//! Protocol differences are confined to [`super::dialect`]: this file owns the
//! transport (POST, SSE/NDJSON line splitting, retries, the event channel) and
//! never inspects a provider-specific field. That is what keeps `react/mod.rs`
//! provider-agnostic.

use std::time::Duration;

use futures_util::StreamExt;
use tokio::sync::mpsc;
use tracing::{debug, warn};

use crate::config::ModelConfig;
use crate::textcodec::StreamDecoder;
use super::dialect::{Dialect, DialectRequest, StreamParser};
use super::types::*;

/// Streaming LLM client bound to a single model configuration.
pub struct LlmClient {
    model: ModelConfig,
    http: reqwest::Client,
    /// Max retry attempts for failed model calls (from settings.general.model_retries).
    api_retries: u32,
    /// Wire protocol this model speaks, resolved once at construction.
    dialect: Dialect,
}

impl LlmClient {
    pub fn new(model: ModelConfig) -> anyhow::Result<Self> {
        Self::with_retries(model, 3)
    }

    /// 构造绑定到单个模型配置的客户端。
    ///
    /// `model.official == true` 时（契约 D 节）：clone 配置并把 `api_key`
    /// 替换为进程内存里缓存的用户普通模型 key；未登录则直接返回明确错误，
    /// 绝不把配置文件里可能残留的旧 key 发到官方 relay。`api_url` 为空时
    /// 固定填官方地址。注入后的 key 只进入 `reqwest` 请求头，不写日志、
    /// 不落盘、不进 HTTP 响应体。
    pub fn with_retries(model: ModelConfig, api_retries: u32) -> anyhow::Result<Self> {
        let mut model = model;
        if model.official {
            // 统一用 sk-<key> 形态：与 relay、/v1/models 探测和后台令牌列表
            // 一致，脱敏/审计才有单一基准。（内存里存的是裸 key，admin 的
            // GetFullKey() 也只是 `return token.Key`，前缀在这里补。）
            let key = crate::official::bearer_key()
                .ok_or_else(|| anyhow::anyhow!("请先登录官方账号"))?;
            model.api_key = key;
            // 无条件固定官方 relay 到「竞速探测选中的那个站点」：settings.json
            // 里若残留/被写入了别的 apiUrl，绝不能让进程内存里的用户 key 被
            // 发到第三方 host。官方源不是可配置自定义地址（契约 C/D 节）。
            // base 自带 /v1，Dialect::OpenAiChat 据此拼 /v1/chat/completions。
            model.api_url = crate::official::base_url();
            // 【安全】官方 relay 只说 OpenAI chat-completions，固定协议，
            // 绝不走 Dialect::resolve：settings.json 里若被塞 anthropic/gemini，
            // 或模型名含 claude/gemini，resolve 会选中 x-api-key /
            // x-goog-api-key 这类「reqwest 重定向不剥离」的自定义凭据头，
            // 一旦遇到开放重定向就会把官方 key 原样带到第三方。
            model.standard = "openai".to_string();
            // 用户自定义头在 build_headers 里是「最后写入、可覆盖」的，
            // 官方源一律清空，防止在 settings.json 里塞 Authorization /
            // x-api-key 与官方 key 一起外发或覆盖之。
            model.headers.clear();
        }
        // A panic here means the process cannot make model calls at all, so
        // failing loudly at construction is correct.
        //
        // DELIBERATELY no `.timeout()` on this client. reqwest's `.timeout()`
        // is a *whole-request* cap measured from send until the response body
        // is fully consumed — for a streaming completion that includes the
        // entire SSE/NDJSON body. Leaving it on the shared client treats every
        // stream as if it were a non-streaming call and kills a healthy,
        // chunk-by-chunk answer at `model.timeout_secs()` (default 120s),
        // regardless of how recently a frame arrived. Reasoning models think
        // for minutes, so this alone produced "stream timed out" on active
        // streams. `connect_timeout` still bounds the TCP/TLS handshake.
        //
        // Streaming liveness is enforced in the react receive loop as a
        // chunk-to-chunk idle cap plus a per-stream total cap (see
        // `react/mod.rs`), which is what an idle timeout must mean for a
        // stream. Non-streaming `complete()` opts back into a total cap
        // per-request below. This mirrors `mcp::http_client_no_total_timeout`.
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            // 【安全】模型请求头里带着凭据（官方源是进程内存里的用户 key，
            // 自定义源是配置里的 apiKey），绝不跟随 3xx。reqwest 0.12 默认
            // 会跟 10 跳：跨 host 才剥内置 Authorization（自定义 x-api-key
            // 等头根本不在剥离名单里），且 0.12.28 的 https→http 同端口
            // 降级重定向不剥 Authorization。固定端点不需要重定向，3xx 一律
            // 当失败处理，彻底断掉「开放重定向把 key 重放出去」这条链。
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("failed to build http client");
        // Resolved once: the model config cannot change for the lifetime of a run,
        // and resolving per request would repeat the same string matching.
        // 【安全】官方 relay 只说 OpenAI chat-completions，直接钉死 dialect：
        // Dialect::resolve 除了 standard 还会看 URL 与**模型名**（含 claude /
        // gemini 就切到 x-api-key / x-goog-api-key），而 reqwest 重定向不剥离
        // 这类自定义凭据头。只把 standard 改成 openai 挡不住模型名启发式。
        let dialect = if model.official {
            Dialect::OpenAiChat
        } else {
            Dialect::resolve(&model)
        };
        debug!(model = %model.name_or_model(), ?dialect, "LLM client protocol");
        // Bound the retry budget at the ONE place every caller funnels through.
        //
        // The settings save handler clamps `modelRetries` too, but that is only
        // the wire path: a hand-edited (or Java-written) settings.json is loaded
        // straight into `GeneralSettings` and reaches here unclamped. Without a
        // ceiling at the consumption point a typo like `4000000000` turns one
        // flaky provider into an effectively unbounded retry storm.
        //
        // This also removes a latent panic: the backoff below computes
        // `500 * 2u64.pow(attempt)`, which overflows in debug builds once
        // `attempt` reaches 64.
        //
        // Same ceiling as the web tools, deliberately sourced from the same
        // constant so the two knobs cannot drift apart.
        let api_retries = api_retries.clamp(1, crate::tools::web_retry::MAX_ATTEMPTS_CEILING);
        Ok(Self { model, http, api_retries, dialect })
    }

    pub fn model_name(&self) -> &str {
        &self.model.name
    }

    /// The wire protocol in use. Exposed so the retry/error path can name it — a
    /// 404 from an Anthropic endpoint and a 404 from an OpenAI one have different
    /// causes, and the user needs to know which protocol was attempted.
    pub fn dialect(&self) -> Dialect {
        self.dialect
    }

    /// Build the request headers: protocol auth + any user-configured headers.
    ///
    /// User headers are applied **last** so an explicit `Authorization` in the
    /// model config still wins — some proxies need a custom scheme and the user
    /// who configured it knows better than the dialect default.
    fn build_headers(&self) -> reqwest::header::HeaderMap {
        build_headers_for(&self.model, self.dialect)
    }

    /// Send a streaming completion request. Returns a receiver of StreamEvents.
    ///
    /// The request is dispatched on a background task; the caller reads events
    /// from the returned channel until it closes (Done/Error emitted last).
    ///
    /// `thinking` is the user-selected reasoning level (see
    /// [`crate::reasoning::selectable_codes`]). It is threaded all the way to the
    /// wire here: `/web/chat/thinking/select` persisted a value that nothing ever
    /// read, so picking "high" changed only the UI.
    pub async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        tools: Option<Vec<ToolDefinition>>,
        thinking: Option<&str>,
    ) -> anyhow::Result<mpsc::Receiver<StreamEvent>> {
        let (tx, rx) = mpsc::channel(256);

        let request = DialectRequest {
            model: self.model.model.clone(),
            messages,
            tools: tools.unwrap_or_default(),
            stream: true,
            temperature: None,
            max_tokens: None,
            thinking: normalise_thinking(thinking),
        };
        let body = self.dialect.request_body(&request);

        let url = self.dialect.endpoint(&self.model, true);
        let model_cfg = self.model.clone();
        let http = self.http.clone();
        let api_retries = self.api_retries;
        let dialect = self.dialect;
        let is_official = self.model.official;

        tokio::spawn(async move {
            let mut attempt = 0u32;
            loop {
                attempt += 1;
                // 官方模型每次物理尝试都重读进程内存里的 key：401 触发重取后
                // 下一次 attempt 就用上新 key；登出清空内存后不再带 Authorization。
                let headers = build_headers_for(&model_cfg, dialect);
                match do_stream(&http, &url, &headers, &body, dialect, &tx).await {
                    Ok(_) => break,
                    Err(e) => {
                        let msg = e.to_string();
                        let delivered = e.downcast_ref::<StreamFailure>()
                            .map(|f| f.delivered)
                            .unwrap_or(false);
                        warn!(attempt, delivered, error = %msg, ?dialect, "LLM stream attempt failed");
                        // 官方 key 失效闭环：401/403 上报 → 壳异步强制重取 → 下一次
                        // attempt 重建 headers 时自动拿到新 key（当前 run 内自愈）。
                        if is_official && is_official_auth_error(&msg) {
                            crate::official::report_auth_failure();
                        }
                        // 【2026-11 用户决策】非 200 一律重试：确定性错误
                        // （401 坏 key、404 模型下架、403 排队 RESOURCE_LIMIT…）
                        // 也按用户设置的 modelRetries 次数退避重试，不再快速失败。
                        // 旧 `is_non_retryable` 门控把网关 403 排队判成致命，
                        // 第 1 次失败就放弃，设置的 10 次完全没用上。
                        // 预算与退避仍在：次数 = settings.general.modelRetries
                        // （with_retries 处 clamp 1..=10），不会无限重试。
                        if attempt > api_retries {
                            let _ = tx.send(StreamEvent::Error(msg)).await;
                            break;
                        }
                        // The failed attempt already pushed deltas downstream.
                        // The react loop has appended them into its
                        // accumulators, and re-issuing the same request would
                        // append the *whole* answer a second time — visibly
                        // duplicated text, and for tool calls a concatenation
                        // of two argument streams, i.e. invalid JSON reported
                        // as "the model truncated its arguments".
                        //
                        // Signal the retry so the consumer discards the partial
                        // turn first. Java gets this for free: its accumulators
                        // are locals inside the `callWithRetry` lambda, so each
                        // physical attempt rebuilds them (`ReasonTask.java`:
                        // `streamedReasoningBuf` / `argsProgresses`). Here the
                        // retry loop sits *below* the accumulators, so the
                        // reset has to be an explicit event.
                        //
                        // 【2026-11 用户决策】首字节前的失败也发 Retry 事件
                        // （delivered=false）：旧实现静默重试，用户看到的就是
                        // 「报错了但根本没重试」。现在每次重试前台都可见
                        // （正在重试 n/modelRetries）；delivered 位告诉消费端
                        // 是否需要丢弃已渲染的半成品。
                        let _ = tx
                            .send(StreamEvent::Retry {
                                attempt,
                                max: api_retries,
                                reason: msg.clone(),
                                delivered,
                            })
                            .await;
                        // Exponential backoff: 1s, 2s, 4s
                        let delay = Duration::from_millis(500 * 2u64.pow(attempt));
                        tokio::time::sleep(delay).await;
                    }
                }
            }
        });

        Ok(rx)
    }

    /// Non-streaming completion (used for simple one-shot calls like drafting a
    /// commit message).
    pub async fn complete(
        &self,
        messages: Vec<ChatMessage>,
    ) -> anyhow::Result<String> {
        let request = DialectRequest {
            model: self.model.model.clone(),
            messages,
            tools: Vec::new(),
            stream: false,
            temperature: Some(0.3),
            max_tokens: None,
            thinking: None,
        };
        let body = self.dialect.request_body(&request);
        let url = self.dialect.endpoint(&self.model, false);
        let headers = self.build_headers();
        // Non-streaming: the whole body arrives at once, so a total wall-clock
        // cap is the correct semantics here (unlike the streaming path, where
        // the same cap silently truncates a long live answer). The client no
        // longer carries a `.timeout()`, so opt back in **per request** with
        // exactly the configured value — preserving the original non-streaming
        // behaviour byte-for-byte while leaving streams unbounded at this layer.
        let resp = self.http.post(&url).headers(headers).json(&body)
            .timeout(Duration::from_secs(self.model.timeout_secs()))
            .send().await?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            // Same "HTTP <code> <reason>: <body>" shape the streaming path uses,
            // so `is_timeout_class` (and any future classifier) reads both alike.
            let msg = format!("HTTP {}: {}", status, snippet(&text));
            if self.model.official && is_official_auth_error(&msg) {
                crate::official::report_auth_failure();
            }
            anyhow::bail!("{}", msg);
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            anyhow::bail!("provider returned non-JSON body: {}", snippet(&text));
        };
        Ok(extract_completion_text(&v, self.dialect))
    }
}

/// Construct headers for a single physical attempt.
///
/// 官方模型（`official == true`）**每次尝试都实时读进程内存里的 key**，而不是
/// 复用 `with_retries` 构造时注入的快照。这带来两个闭环效果：
/// - 401 触发 [`crate::official::report_auth_failure`] → 壳异步重取 → 下一次
///   attempt 自动用上新 key，当前 run 内即可自愈，无需重建 `LlmClient`；
/// - 登出/会话撤销清空内存后，`crate::official::key()` 返回 `None` → 不带
///   Authorization，绝不会把构造时的旧 key 继续发到 relay。
///
/// 普通模型完全不受影响：直接用配置里的 `api_key`。
fn build_headers_for(model: &ModelConfig, dialect: Dialect) -> reqwest::header::HeaderMap {
    let mut effective = model.clone();
    if model.official {
        effective.api_key = crate::official::bearer_key().unwrap_or_default();
    }
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::CONTENT_TYPE,
        "application/json".parse().unwrap(),
    );
    for (k, v) in dialect.auth_headers(&effective) {
        if let (Ok(name), Ok(val)) = (
            reqwest::header::HeaderName::from_bytes(k.as_bytes()),
            v.parse(),
        ) {
            headers.insert(name, val);
        }
    }
    for (k, v) in &effective.headers {
        if let (Ok(name), Ok(val)) = (
            reqwest::header::HeaderName::from_bytes(k.as_bytes()),
            v.parse(),
        ) {
            headers.insert(name, val);
        }
    }
    headers
}

/// 是否是「官方 key 可能已失效」的响应。命中后触发失效上报。
///
/// 只认 relay 明确返回的 401/403 与常见的 token 失效文案；网关 5xx、
/// 超时、429 限流都不算（那些不是 key 失效，重取也解决不了）。
fn is_official_auth_error(msg: &str) -> bool {
    let m = msg.trim_start();
    let lower = m.to_ascii_lowercase();
    // 401 一律视为凭据问题；403 在官方 relay 上更常见于「排队 / 资源限制」
    // （用户决策：这类确定性错误也按 modelRetries 重试，不该触发重取），
    // 因此只有响应体里带明确 token 失效文案时才判定为 key 失效。
    if m.starts_with("HTTP 401") {
        return true;
    }
    let token_revoked = lower.contains("invalid_api_key")
        || lower.contains("invalid token")
        || lower.contains("token is disabled")
        || lower.contains("token_not_found")
        || lower.contains("token_not_exists")
        || lower.contains("该令牌")
        || lower.contains("令牌已")
        || lower.contains("key is disabled");
    token_revoked && (m.starts_with("HTTP 403") || !m.starts_with("HTTP "))
}

/// First N characters of a body, for error messages.
///
/// 【安全】relay/网关在 4xx/5xx 里回显请求头片段或 token 前缀是常见行为。
/// `snippet()` 的结果会同时进 `warn!` 日志和 `StreamEvent::Retry/Error`
/// （进而推到 WebView），所以必须先把当前所有已知凭据形态替换掉：进程内存
/// 里的官方裸 key、`sk-<key>`、`Bearer <key>`，以及通用 `Bearer xxx` 形态。
/// 不知道 key 时（未登录）仍抹掉 Bearer 值，避免自定义源的 key 被回显带出。
fn snippet(s: &str) -> String {
    let mut out: String = s.chars().take(500).collect();
    if let Some(key) = crate::official::key() {
        for secret in [
            format!("sk-{}", key),
            key.clone(),
            format!("Bearer sk-{}", key),
            format!("Bearer {}", key),
        ] {
            if !secret.is_empty() {
                out = out.replace(&secret, "[REDACTED]");
            }
        }
    }
    // 兜底：任意 `Bearer <非空白>`（含自定义源回显、被截断的 sk- 前缀）。
    // 手写一个小型状态机，避免引入新依赖。
    let lower = out.to_ascii_lowercase();
    let mut pieces: Vec<String> = Vec::new();
    let mut cursor = 0usize;
    while let Some(rel) = lower[cursor..].find("bearer ") {
        let start = cursor + rel;
        let value_start = start + "bearer ".len();
        let rest = &out[value_start..];
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '"' || c == ',' || c == '}' || c == '<')
            .unwrap_or(rest.len());
        if end > 0 {
            pieces.push(out[cursor..value_start].to_string());
            pieces.push("[REDACTED]".to_string());
            cursor = value_start + end;
        } else {
            pieces.push(out[cursor..value_start].to_string());
            cursor = value_start;
            break;
        }
    }
    pieces.push(out[cursor..].to_string());
    pieces.concat()
}

/// Extract the assistant's text from a non-streaming response.
///
/// Each protocol puts it somewhere different, and reading the wrong path yields an
/// empty string — which for a commit-message draft silently produces a blank
/// subject line rather than an error.
fn extract_completion_text(v: &serde_json::Value, dialect: Dialect) -> String {
    match dialect {
        Dialect::OpenAiChat | Dialect::OllamaChat => v["choices"][0]["message"]["content"]
            .as_str()
            .or_else(|| v["message"]["content"].as_str())
            .unwrap_or_default()
            .to_string(),
        Dialect::OpenAiResponses => {
            // `output` is an array of items; concatenate the text parts.
            let mut out = String::new();
            if let Some(items) = v["output"].as_array() {
                for item in items {
                    if let Some(parts) = item["content"].as_array() {
                        for p in parts {
                            if let Some(t) = p["text"].as_str() {
                                out.push_str(t);
                            }
                        }
                    }
                }
            }
            if out.is_empty() {
                if let Some(t) = v["output_text"].as_str() {
                    out.push_str(t);
                }
            }
            out
        }
        Dialect::AnthropicMessages => {
            // `content` is an array of blocks; only `text` blocks are the answer
            // (`thinking` blocks must not be returned as the draft).
            let mut out = String::new();
            if let Some(blocks) = v["content"].as_array() {
                for b in blocks {
                    if b["type"].as_str() == Some("text") {
                        if let Some(t) = b["text"].as_str() {
                            out.push_str(t);
                        }
                    }
                }
            }
            out
        }
        Dialect::GeminiGenerate => {
            let mut out = String::new();
            if let Some(parts) = v["candidates"][0]["content"]["parts"].as_array() {
                for p in parts {
                    // Skip reasoning parts, same rule as the streaming parser.
                    let thought = p["thought"].as_bool().unwrap_or(false);
                    if !thought {
                        if let Some(t) = p["text"].as_str() {
                            out.push_str(t);
                        }
                    }
                }
            }
            out
        }
    }
}

/// Normalise the user-selected thinking level.
///
/// "auto" and blank both mean "let the provider decide", which each dialect
/// expresses by *omitting* its field — so they collapse to `None` here rather than
/// being forwarded as a literal the provider would reject.
fn normalise_thinking(level: Option<&str>) -> Option<String> {
    let l = level?.trim();
    if l.is_empty() || l.eq_ignore_ascii_case("auto") {
        return None;
    }
    Some(l.to_string())
}

/// Perform a single streaming request, pushing events into `tx`.
///
/// Line splitting is shared across dialects; only the *interpretation* of a line
/// differs, which is what [`StreamParser`] abstracts. Ollama is the reason this
/// cannot assume SSE: it streams bare NDJSON, and looking for a `data:` prefix
/// there yields zero events — an empty answer with no error to explain it.
///
/// The returned error carries [`StreamFailure::delivered`], which tells the
/// caller whether anything had already been pushed downstream. That bit is the
/// difference between an invisible retry and a duplicated answer: see
/// [`StreamEvent::Retry`].
async fn do_stream(
    http: &reqwest::Client,
    url: &str,
    headers: &reqwest::header::HeaderMap,
    body: &serde_json::Value,
    dialect: Dialect,
    tx: &mpsc::Sender<StreamEvent>,
) -> anyhow::Result<()> {
    let resp = http
        .post(url)
        .headers(headers.clone())
        .json(body)
        .send()
        .await
        .map_err(|e| StreamFailure::new(e.to_string(), false))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        // Nothing was delivered: the body was consumed as an error, not as a
        // stream. Retrying this is invisible to the consumer.
        return Err(StreamFailure::new(
            format!("HTTP {}: {}", status, snippet(&text)),
            false,
        )
        .into());
    }

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    // Chunk boundaries cut multi-byte CJK characters apart; decoding each
    // chunk lossily turned the halves into U+FFFD (the intermittent ``
    // garbling in streamed replies). The incremental decoder holds a
    // truncated trailing sequence until the next chunk completes it.
    //
    // STRICT UTF-8 here, never the GBK-fallback decoder. An SSE/JSON body is
    // UTF-8 by contract (RFC 8259 / the SSE spec), so a non-UTF-8 byte means
    // the *upstream* is broken, not that the provider switched encodings. The
    // GBK decoder latches permanently on the first bad byte and then re-reads
    // every following byte pair as one CJK character — UTF-8 CJK is 3 bytes,
    // so it silently eats ~1.5 characters per one. That is the corruption seen
    // on session work-mw8wizyz: `wx-ai`→`w-ai`, `org.dromara`→`org.d/org/grom`,
    // a Chinese clause turned into the Latin word `wants`, and — worst — the
    // garbling reached tool-call *arguments*, which stayed valid JSON and so
    // sailed past `broken_argument_calls` into a real `read` of a nonsense
    // path ("File not found" card, then the model chasing its own garbage).
    //
    // Strict mode emits exactly one U+FFFD per bad sequence and keeps the rest
    // of the stream intact, which (a) stops the text loss and (b) leaves a
    // detectable signature for the react loop to reject and cleanly retry.
    let mut decoder = StreamDecoder::strict_utf8();
    let mut parser: Box<dyn StreamParser> = dialect.parser();
    let mut saw_done = false;
    // Whether any event has crossed the channel. Once true, a retry is
    // observable: the consumer already holds the partial turn.
    let mut delivered = false;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| StreamFailure::new(e.to_string(), delivered))?;
        buffer.push_str(&decoder.push(&chunk));

        // Frames are newline-separated in every dialect we speak.
        while let Some(pos) = buffer.find('\n') {
            let line: String = buffer[..pos].trim_end_matches('\r').to_string();
            buffer = buffer[pos + 1..].to_string();

            for event in parser.feed_line(&line) {
                if matches!(event, StreamEvent::Done { .. }) {
                    saw_done = true;
                }
                let is_terminal = matches!(event, StreamEvent::Done { .. } | StreamEvent::Error(_));
                let _ = tx.send(event).await;
                delivered = true;
                if is_terminal {
                    return Ok(());
                }
            }
        }
    }

    // Flush a trailing line that had no final newline — Ollama's last JSON object
    // often arrives that way, and dropping it loses the usage counters.
    let tail = decoder.finish();
    if !tail.is_empty() {
        buffer.push_str(&tail);
    }
    let remainder = buffer.trim_end_matches(['\r', '\n']).to_string();
    if !remainder.is_empty() {
        for event in parser.feed_line(&remainder) {
            if matches!(event, StreamEvent::Done { .. }) {
                saw_done = true;
            }
            // No `delivered` update here: this tail-flush runs after every `?`
            // error path, and the function only returns `Ok` from here on — the
            // flag is consumed solely when a chunk read fails mid-stream
            // (inside the loop above), so setting it here would be dead.
            let _ = tx.send(event).await;
        }
    }

    if !saw_done {
        // Stream ended without a terminator (gateway timeout, proxy reset,
        // provider crash mid-answer). Flush whatever non-terminal events the
        // parser still holds, then report the truncation honestly.
        //
        // The old code synthesised a normal `Done(finish_reason="stop")` here
        // so the caller's receive loop would finish instead of hanging. That
        // made a mid-stream disconnect indistinguishable from a completed
        // answer: the react loop then treated whatever had accumulated —
        // possibly nothing at all — as the model's final reply, closed the run
        // with `stop=Completed` and emitted no error frame. On the UI that is
        // exactly "the task ended unfinished and nothing explained why".
        //
        // An `Error` event instead routes through the react loop's existing
        // retry-then-fail path, which is both honest and self-healing for
        // transient disconnects. The receive loop still finishes, because the
        // sender drops when this function returns.
        //
        // Deliberately *terminal* here rather than an `Err` fed to the
        // transport retry loop: the react loop re-creates its accumulators on
        // every `continue`, so its own retry is already clean, and an EOF
        // without a terminator usually means the upstream gave up on this
        // request — re-sending the identical (large) context just repeats it.
        for event in parser.finish() {
            if !matches!(event, StreamEvent::Done { .. }) {
                let _ = tx.send(event).await;
            }
        }
        let _ = tx
            .send(StreamEvent::Error(
                "LLM stream ended without a completion terminator (connection closed early); the response may be truncated".into(),
            ))
            .await;
    }
    Ok(())
}

/// A failed streaming attempt, carrying whether it had already delivered
/// events downstream.
///
/// Kept as a distinct type (rather than a second return value) so `do_stream`
/// stays `anyhow::Result<()>` and every early `?` inside it is accounted for:
/// an untracked error would silently be treated as "nothing delivered" and
/// re-run the request on top of a partial turn.
#[derive(Debug)]
struct StreamFailure {
    msg: String,
    delivered: bool,
}

impl StreamFailure {
    fn new(msg: String, delivered: bool) -> Self {
        Self { msg, delivered }
    }
}

impl std::fmt::Display for StreamFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.msg)
    }
}

impl std::error::Error for StreamFailure {}

/// Extract an HTTP-ish status code from an error message.
///
/// `do_stream` formats its failures as `"HTTP <code> <reason>: <body>"`, but the
/// streaming error path also surfaces *bare bodies* with no prefix at all —
/// observed in real logs: `{"code":"403","message":"..."}` and
/// `{"code":"504","message":"First Token Timeout..."}`. Classifying only on the
/// `HTTP ` prefix left those permanently retryable, which is how a gateway
/// outage turned into an infinite retry loop: identical payload, identical
/// failure, `turns < max_turns` forever true under AutoRethink.
fn status_code_of(msg: &str) -> Option<u16> {
    if let Some(rest) = msg.strip_prefix("HTTP ") {
        if let Some(code) = rest.split_whitespace().next().and_then(|c| c.parse().ok()) {
            return Some(code);
        }
    }
    // Bare JSON body (with or without a leading prefix that failed to parse as
    // a code): gateways put the status in `code` or `status`, as string or
    // number.
    let body = msg.strip_prefix("HTTP ").unwrap_or(msg);
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        let c = v.get("code").or_else(|| v.get("status"))?;
        if let Some(n) = c.as_u64() {
            return u16::try_from(n).ok();
        }
        if let Some(s) = c.as_str() {
            return s.trim().parse().ok();
        }
    }
    None
}

/// Whether an error is a *timeout-class* failure: connection-level timeouts,
/// 408/504, or a message that says so in words. Java buckets these separately
/// from generic 429/5xx (`ReasonTask` retry policy) on the production-evidenced
/// insight that timeouts are usually *systemic* — the upstream already accepted
/// the request and is billing for it, and re-sending the same (large) context
/// just times out again, each attempt more expensive than the last. So they get
/// their own, much smaller retry allowance at the react layer.
pub fn is_timeout_class(msg: &str) -> bool {
    let lower = msg.to_lowercase();
    if lower.contains("timed out") || lower.contains("timeout") {
        return true;
    }
    matches!(status_code_of(msg), Some(408) | Some(504))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 【2026-11 用户决策】非 200 一律按 modelRetries 重试，LLM 流不再有
    /// 「确定性错误快速失败」分类（旧 is_non_retryable 已删除：它把网关
    /// 403 RESOURCE_LIMIT 排队判成致命，第 1 次失败就放弃）。这里只保留
    /// 超时类分桶（react 层对系统性慢上游每轮 ≤2 次的护栏仍需要它）。
    #[test]
    fn timeout_classification() {
        assert!(is_timeout_class("HTTP 408 Request Timeout: x"));
        assert!(is_timeout_class("HTTP 504 Gateway Timeout: upstream slow"));
        assert!(is_timeout_class("request timed out"));
        assert!(is_timeout_class("LLM stream timed out: no data received for 150s"));
        assert!(!is_timeout_class("HTTP 401 Unauthorized: bad key"));
        assert!(!is_timeout_class("connection reset by peer"));
        // 裸 JSON 错误体（无 HTTP 前缀）也要能识别超时类。
        assert!(is_timeout_class(
            "{\"code\":\"504\",\"message\":\"First Token Timeout or Upstream Timeout\"}"
        ));
        // 排队类 403 不是超时类：它走普通重试预算，不吃每轮 ≤2 的超时桶。
        assert!(!is_timeout_class(
            "HTTP 403 Forbidden: {\"code\":\"RESOURCE_LIMIT_EXCEEDED\",\"message\":\"request is queued, retry after 3s\"}"
        ));
    }

    /// 源钉：LLM 流的重试门控只允许剩「预算」一项。任何人把按错误类别
    /// 快速失败的判定加回 stream_chat 循环（例如重新引入 is_non_retryable），
    /// 都会让网关 403 排队/401 等错误第 1 次就放弃，用户的 modelRetries
    /// 形同虚设——正是本次报障的形状。
    #[test]
    fn stream_retry_gate_is_budget_only() {
        let src = include_str!("client.rs");
        let production = &src[..src.find("#[cfg(test)]").unwrap_or(src.len())];
        let stream = production
            .split("pub async fn stream_chat")
            .nth(1)
            .and_then(|s| s.split("pub async fn complete").next())
            .expect("stream_chat body must be locatable");
        let code: String = stream
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            code.contains("if attempt > api_retries {"),
            "the only retry gate must be the attempt budget"
        );
        assert!(
            !code.contains("is_non_retryable"),
            "no error-class fast-fail may gate LLM stream retries (user decision: \
             every non-200 retries up to modelRetries)"
        );
    }

    /// The shared reqwest client must NOT carry a whole-request `.timeout()`:
    /// it covers the streaming body and would cut a live long answer at the
    /// non-streaming timeout. Only the non-streaming `complete()` opts back in,
    /// per request. (M-pin: re-adding it to the builder regresses
    /// `active_stream_is_not_cut_off_at_the_model_timeout`.)
    #[test]
    fn streaming_client_has_no_whole_request_timeout() {
        let src = include_str!("client.rs");
        let body = src.split("pub fn with_retries(").nth(1).unwrap_or("");
        let body = body.split("pub fn model_name").next().unwrap_or(body);
        // Strip comments so the explanatory prose above (which legitimately
        // mentions `.timeout()`) cannot mask a real builder call.
        let code: String = body.lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !code.contains(".timeout("),
            "client-level .timeout() kills long live streams; keep it per-request on complete() only"
        );
        assert!(
            code.contains(".connect_timeout("),
            "the handshake must still be bounded"
        );
        // 【安全】带凭据的 HTTP 客户端必须显式禁重定向。reqwest 0.12 默认
        // 跟 10 跳：跨 host 才剥内置 Authorization，x-api-key 等自定义头
        // 根本不剥，且 https→http 同端口降级也不剥。删掉这行会让官方
        // key 可被开放重定向重放到第三方。
        assert!(
            code.contains(".redirect(reqwest::redirect::Policy::none())"),
            "credential-bearing client must disable redirects"
        );
    }

    fn client(standard: &str, url: &str, model: &str) -> LlmClient {
        LlmClient::new(ModelConfig {
            name: model.into(),
            standard: standard.into(),
            api_url: url.into(),
            api_key: "k".into(),
            model: model.into(),
            ..Default::default()
        })
        .expect("test client must build")
    }

    fn official_fixture(key: &'static str) -> crate::official::OfficialCredential {
        crate::official::OfficialCredential {
            key: key.to_string(),
            base_url: crate::official::OFFICIAL_BASE_URL.to_string(),
            user_id: 1,
            username: "tester".to_string(),
            models: vec![],
        }
    }

    fn official_model_cfg(api_url: &str) -> ModelConfig {
        ModelConfig {
            name: "official".into(),
            standard: "openai".into(),
            api_url: api_url.into(),
            api_key: "stale-on-disk-value".into(),
            model: "gwork-x".into(),
            official: true,
            ..Default::default()
        }
    }

    /// P2-7：官方源不是可配置自定义地址。settings.json 里被写入/篡改的
    /// apiUrl 必须被无条件覆盖，否则进程内存里的用户 key 会被发到第三方 host。
    #[test]
    fn official_model_never_sends_key_to_a_custom_host() {
        let _guard = crate::official::test_lock();
        crate::official::set(official_fixture("OFFICIAL-IN-MEMORY-KEY"));
        let c = LlmClient::with_retries(
            official_model_cfg("https://attacker.example/v1"), 1)
            .expect("official model must build");
        assert_eq!(c.model.api_url, crate::official::base_url());
        assert!(!c.model.api_url.contains("attacker.example"));
        crate::official::clear();
    }

    /// 失效闭环：同一 LlmClient 不重建，只要内存里的 key 被换掉（壳重取
    /// 成功），下一次 build_headers 就必须用新 key；登出清空内存后不能
    /// 再残留构造时的旧 key。这正是「401 自愈 + 会话撤销不留僵尸凭据」。
    #[test]
    fn official_headers_reread_memory_key_per_attempt() {
        let _guard = crate::official::test_lock();
        crate::official::set(official_fixture("OLD-REVOKED-KEY"));
        let c = LlmClient::with_retries(official_model_cfg(""), 1).expect("build");
        assert_eq!(
            c.build_headers().get(reqwest::header::AUTHORIZATION).unwrap().to_str().unwrap(),
            "Bearer sk-OLD-REVOKED-KEY"
        );

        // 壳重取成功 → set 换上新 key，当前 run 的下一次 attempt 自动生效。
        crate::official::set(official_fixture("ROTATED-KEY"));
        assert_eq!(
            c.build_headers().get(reqwest::header::AUTHORIZATION).unwrap().to_str().unwrap(),
            "Bearer sk-ROTATED-KEY",
            "re-fetched key must be picked up without rebuilding the client"
        );

        // 登出 / 会话撤销：内存清空后不再带任何 Authorization。
        crate::official::clear();
        assert!(
            c.build_headers().get(reqwest::header::AUTHORIZATION).is_none(),
            "cleared credential must not leave a stale key in request headers"
        );
    }

    /// 安全：relay 回显 key 时，snippet 不得把它带进日志或 WebView 事件。
    #[test]
    fn snippet_redacts_echoed_credentials() {
        let _guard = crate::official::test_lock();
        crate::official::set(official_fixture("SECRET-KEY-0123456789"));
        let echo = r#"{"error":"invalid key sk-SECRET-KEY-0123456789 / Bearer sk-SECRET-KEY-0123456789 / Bearer custom-provider-token"}"#;
        let out = snippet(echo);
        assert!(!out.contains("SECRET-KEY-0123456789"), "key leaked: {out}");
        assert!(!out.contains("custom-provider-token"), "bearer value leaked: {out}");
        assert!(out.contains("[REDACTED]"));
        crate::official::clear();
    }

    /// 安全：settings.json 里被篡改成 anthropic/gemini 或塞自定义凭据头，
    /// 官方模型必须强制固定为 OpenAI + 清头，绝不走 reqwest 重定向不剥离的
    /// x-api-key / x-goog-api-key 分支。
    #[test]
    fn official_model_pins_protocol_and_strips_custom_headers() {
        let _guard = crate::official::test_lock();
        crate::official::set(official_fixture("SECRET-KEY"));
        let mut m = official_model_cfg("https://attacker.example/v1");
        m.standard = "anthropic".into();
        m.model = "claude-3".into();
        m.headers.insert("x-api-key".into(), "injected".into());
        m.headers.insert("Authorization".into(), "CustomScheme x".into());
        let c = LlmClient::with_retries(m, 1).expect("build");
        assert_eq!(c.model.standard, "openai");
        assert!(c.model.headers.is_empty());
        assert_eq!(c.dialect, Dialect::OpenAiChat);
        assert_eq!(
            c.dialect.endpoint(&c.model, true),
            format!("{}/v1/chat/completions", crate::official::host()),
            "official chat endpoint must be host/v1/chat/completions — no /v1/v1"
        );
        let h = c.build_headers();
        assert_eq!(
            h.get(reqwest::header::AUTHORIZATION).unwrap().to_str().unwrap(),
            "Bearer sk-SECRET-KEY"
        );
        assert!(h.get("x-api-key").is_none());
        crate::official::clear();
    }

    #[test]
    fn only_auth_failures_trigger_official_refetch() {
        assert!(is_official_auth_error("HTTP 401 Unauthorized: bad key"));
        assert!(is_official_auth_error("HTTP 403 Forbidden: token is disabled"));
        assert!(is_official_auth_error("invalid_api_key"));
        // 网关排队/限流/服务不可用不是 key 失效，重取解决不了，不能误触发。
        assert!(!is_official_auth_error("HTTP 429 Too Many Requests"));
        assert!(!is_official_auth_error("HTTP 500 Internal Server Error"));
        assert!(!is_official_auth_error("HTTP 403 Forbidden: RESOURCE_LIMIT queue"));
    }

    #[test]
    fn official_model_injects_the_in_memory_key_and_fixed_url() {
        let _guard = crate::official::test_lock();
        crate::official::set(official_fixture("OFFICIAL-IN-MEMORY-KEY"));
        let m = ModelConfig {
            name: "official".into(),
            standard: "openai".into(),
            api_url: String::new(),
            api_key: "stale-on-disk-value".into(),
            model: "gwork-x".into(),
            official: true,
            ..Default::default()
        };
        let c = LlmClient::with_retries(m, 1).expect("logged-in official model must build");
        assert_eq!(c.model.api_key, "sk-OFFICIAL-IN-MEMORY-KEY");
        assert_eq!(c.model.api_url, crate::official::base_url());
        assert_eq!(
            c.build_headers().get(reqwest::header::AUTHORIZATION).unwrap().to_str().unwrap(),
            "Bearer sk-OFFICIAL-IN-MEMORY-KEY"
        );
        crate::official::clear();
    }

    #[test]
    fn official_model_without_credential_returns_a_clear_error() {
        let _guard = crate::official::test_lock();
        crate::official::clear();
        let m = ModelConfig {
            name: "official".into(),
            api_key: "must-not-be-used".into(),
            official: true,
            ..Default::default()
        };
        let err = LlmClient::with_retries(m, 1)
            .err()
            .expect("unset official credential must be an error");
        let msg = err.to_string();
        assert!(msg.contains("请先登录"), "error must name the login requirement: {msg}");
        assert!(!msg.contains("must-not-be-used"), "error must never echo a key");
    }

    #[test]
    fn ordinary_models_do_not_read_the_official_credential() {
        let _guard = crate::official::test_lock();
        crate::official::clear();
        let m = ModelConfig {
            name: "custom".into(),
            api_url: "https://custom.example/v1".into(),
            api_key: "custom-key".into(),
            ..Default::default()
        };
        let c = LlmClient::with_retries(m, 1).expect("ordinary model must not require login");
        assert_eq!(c.model.api_key, "custom-key");
    }

    /// The LLM stream decoder must be constructed in STRICT UTF-8 mode.
    ///
    /// `StreamDecoder::new()` latches into GBK on the first non-UTF-8 byte and
    /// then silently deletes ~1.5 characters per CJK character for the rest of
    /// the stream — the exact corruption reported on session work-mw8wizyz
    /// (`wx-ai`→`w-ai`, `org.dromara`→`org.d/org/grom`). A pure-function test on
    /// `textcodec` cannot see WHICH constructor this call site uses, so a future
    /// "simplification" back to `new()` would regress the fix with every unit
    /// test still green. Source pin, same pattern as the timeout guard above.
    #[test]
    fn llm_stream_decoder_is_strict_utf8() {
        let src = include_str!("client.rs");
        // Only the production code (before the test module), comments stripped
        // so the explanatory prose — which legitimately names `StreamDecoder::new()`
        // while forbidding it — cannot satisfy or mask the assertions.
        let production = &src[..src.find("#[cfg(test)]").unwrap_or(src.len())];
        let code: String = production
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            code.contains("StreamDecoder::strict_utf8()"),
            "the LLM SSE stream must decode in strict UTF-8 mode"
        );
        assert!(
            !code.contains("StreamDecoder::new()"),
            "StreamDecoder::new() latches into GBK and silently eats CJK text; \
             the LLM stream must use strict_utf8()"
        );
    }

    /// The client must pick the protocol from the model config. Before this, every
    /// model was spoken to in OpenAI chat-completions regardless of `standard`.
    #[test]
    fn client_resolves_the_dialect_from_the_model() {
        assert_eq!(
            client("anthropic", "https://api.anthropic.com", "claude-x").dialect(),
            Dialect::AnthropicMessages
        );
        assert_eq!(
            client("ollama", "http://localhost:11434", "llama3").dialect(),
            Dialect::OllamaChat
        );
        assert_eq!(
            client("openai", "https://api.openai.com/v1", "gpt-4o").dialect(),
            Dialect::OpenAiChat
        );
    }

    /// Each dialect must post to its own endpoint with its own auth header. A
    /// Bearer token sent to Anthropic is a 401 that reads like a bad key.
    #[test]
    fn headers_follow_the_resolved_dialect() {
        let a = client("anthropic", "https://api.anthropic.com", "claude-x");
        let h = a.build_headers();
        assert!(h.contains_key("x-api-key"), "{:?}", h);
        assert!(h.contains_key("anthropic-version"));
        assert!(!h.contains_key(reqwest::header::AUTHORIZATION));

        let o = client("openai", "https://api.openai.com/v1", "gpt-4o");
        let h2 = o.build_headers();
        assert!(h2.contains_key(reqwest::header::AUTHORIZATION));
        assert!(!h2.contains_key("x-api-key"));
    }

    /// A user-configured header must still win over the dialect default: some
    /// proxies need a custom auth scheme and the user who set it knows best.
    #[test]
    fn user_headers_override_the_dialect_default() {
        let mut m = ModelConfig {
            name: "m".into(),
            standard: "openai".into(),
            api_url: "https://x/v1".into(),
            api_key: "k".into(),
            model: "m".into(),
            ..Default::default()
        };
        m.headers.insert("Authorization".into(), "CustomScheme abc".into());
        let c = LlmClient::new(m).expect("test client must build");
        let h = c.build_headers();
        assert_eq!(
            h.get(reqwest::header::AUTHORIZATION).unwrap().to_str().unwrap(),
            "CustomScheme abc"
        );
    }

    /// "auto" and blank must become `None`, not a literal the provider rejects.
    #[test]
    fn thinking_normalisation_drops_auto_and_blank() {
        assert_eq!(normalise_thinking(Some("auto")), None);
        assert_eq!(normalise_thinking(Some("AUTO")), None);
        assert_eq!(normalise_thinking(Some("  ")), None);
        assert_eq!(normalise_thinking(None), None);
        assert_eq!(normalise_thinking(Some(" high ")).as_deref(), Some("high"));
    }

    // ── Non-streaming text extraction ─────────────────────────────────────────
    //
    // Reading the wrong path returns "" rather than an error, so a blank
    // commit-message subject is the user-visible symptom.

    #[test]
    fn complete_text_extraction_per_dialect() {
        let openai = serde_json::json!({"choices":[{"message":{"content":"draft"}}]});
        assert_eq!(extract_completion_text(&openai, Dialect::OpenAiChat), "draft");
        assert_eq!(extract_completion_text(&openai, Dialect::OllamaChat), "draft");

        // Ollama's non-streaming shape nests under `message`, not `choices`.
        let ollama = serde_json::json!({"message":{"role":"assistant","content":"ollama draft"}});
        assert_eq!(extract_completion_text(&ollama, Dialect::OllamaChat), "ollama draft");

        let responses = serde_json::json!({
            "output": [{"type":"message","content":[{"type":"output_text","text":"resp "}]}],
            "output_text": ""
        });
        assert_eq!(extract_completion_text(&responses, Dialect::OpenAiResponses), "resp ");

        let anthropic = serde_json::json!({
            "content": [
                {"type":"thinking","thinking":"private reasoning"},
                {"type":"text","text":"anth draft"}
            ]
        });
        // The thinking block must NOT leak into the returned draft.
        assert_eq!(extract_completion_text(&anthropic, Dialect::AnthropicMessages), "anth draft");

        let gemini = serde_json::json!({
            "candidates": [{"content":{"parts":[
                {"text":"thought","thought":true},
                {"text":"gem draft"}
            ]}}]
        });
        assert_eq!(extract_completion_text(&gemini, Dialect::GeminiGenerate), "gem draft");
    }

    /// A missing or malformed path must yield "" rather than panic.
    #[test]
    fn complete_text_extraction_tolerates_absent_fields() {
        let empty = serde_json::json!({});
        for d in [
            Dialect::OpenAiChat,
            Dialect::OpenAiResponses,
            Dialect::AnthropicMessages,
            Dialect::GeminiGenerate,
            Dialect::OllamaChat,
        ] {
            assert_eq!(extract_completion_text(&empty, d), "", "{:?}", d);
        }
    }

    // ── stream truncation honesty ────────────────────────────────────────

    /// A gateway that dies mid-answer (timeout, proxy reset) closes the SSE
    /// stream without a terminator. The client must report that as an Error,
    /// not synthesise a normal Done: the react loop treats Done as "the model
    /// finished", which turned every mid-stream disconnect into a silently
    /// truncated "final answer" and a run that ends with the task unfinished.
    #[tokio::test]
    async fn stream_ending_without_terminator_reports_error_not_done() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            // Drain the request so the client sees a well-formed exchange.
            let mut buf = [0u8; 4096];
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                sock.read(&mut buf),
            )
            .await;
            let body = concat!(
                "HTTP/1.1 200 OK\r\n",
                "Content-Type: text/event-stream\r\n",
                "Connection: close\r\n\r\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"half an ans\"}}]}\n\n",
                // ...and the connection dies here. No [DONE], no finish_reason.
            );
            let _ = sock.write_all(body.as_bytes()).await;
            let _ = sock.shutdown().await;
        });

        let c = client("openai", &format!("http://127.0.0.1:{}", port), "m");
        let mut rx = c
            .stream_chat(vec![ChatMessage::user("hi")], None, None)
            .await
            .unwrap();

        let mut saw_content = false;
        let mut saw_done = false;
        let mut saw_error = None;
        while let Some(ev) = rx.recv().await {
            match ev {
                StreamEvent::ContentDelta(_) => saw_content = true,
                StreamEvent::Done { .. } => saw_done = true,
                StreamEvent::Error(m) => saw_error = Some(m),
                _ => {}
            }
        }

        assert!(saw_content, "partial content must still be delivered");
        assert!(
            saw_error.is_some(),
            "a terminator-less stream must surface an Error event"
        );
        assert!(
            !saw_done,
            "a truncated stream must NOT be reported as a normal completion"
        );
        assert!(
            saw_error.unwrap().contains("without a completion terminator"),
            "error must name the truncation"
        );
    }

    /// The well-formed path must be untouched: a stream that ends with the
    /// dialect's terminator still yields exactly one Done and no Error.
    #[tokio::test]
    async fn well_formed_stream_still_ends_with_done_and_no_error() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                sock.read(&mut buf),
            )
            .await;
            let body = concat!(
                "HTTP/1.1 200 OK\r\n",
                "Content-Type: text/event-stream\r\n",
                "Connection: close\r\n\r\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                "data: [DONE]\n\n",
            );
            let _ = sock.write_all(body.as_bytes()).await;
            let _ = sock.shutdown().await;
        });

        let c = client("openai", &format!("http://127.0.0.1:{}", port), "m");
        let mut rx = c
            .stream_chat(vec![ChatMessage::user("hi")], None, None)
            .await
            .unwrap();

        let mut dones = 0;
        let mut errors = 0;
        while let Some(ev) = rx.recv().await {
            match ev {
                StreamEvent::Done { .. } => dones += 1,
                StreamEvent::Error(_) => errors += 1,
                _ => {}
            }
        }
        assert_eq!(dones, 1, "exactly one Done for a terminated stream");
        assert_eq!(errors, 0, "no Error for a well-formed stream");
    }

    /// A streaming response that stays active LONGER than the configured model
    /// timeout must NOT be cut off. The shared reqwest client used to carry
    /// `.timeout(model.timeout_secs())` — a *whole-request* cap that also covers
    /// the streaming body — so any answer longer than the non-streaming timeout
    /// was severed at that mark no matter how recently a frame arrived. Reasoning
    /// models think for minutes; that is the "stream timed out on a live stream"
    /// half of the incident. With the cap moved off the client, a stream that
    /// keeps emitting frames well past the timeout completes normally.
    #[tokio::test]
    async fn active_stream_is_not_cut_off_at_the_model_timeout() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                sock.read(&mut buf),
            )
            .await;
            let header = concat!(
                "HTTP/1.1 200 OK\r\n",
                "Content-Type: text/event-stream\r\n",
                "Connection: close\r\n\r\n",
            );
            let _ = sock.write_all(header.as_bytes()).await;
            // 6 frames 250ms apart = 1.5s of *active* streaming, deliberately
            // longer than the 1s model timeout configured below. The old
            // client-level `.timeout(1s)` would sever the body at ~1s → no
            // terminator → Error (and a retry).
            for _ in 0..6 {
                let frame = "data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n";
                let _ = sock.write_all(frame.as_bytes()).await;
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
            let tail = concat!(
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                "data: [DONE]\n\n",
            );
            let _ = sock.write_all(tail.as_bytes()).await;
            let _ = sock.shutdown().await;
        });

        let mut m = ModelConfig {
            name: "m".into(),
            standard: "openai".into(),
            api_url: format!("http://127.0.0.1:{}", port),
            api_key: "k".into(),
            model: "m".into(),
            ..Default::default()
        };
        m.timeout = "1s".into(); // shorter than the stream's 1.5s on purpose
        let c = LlmClient::with_retries(m, 1).expect("test client must build");

        let mut rx = c
            .stream_chat(vec![ChatMessage::user("hi")], None, None)
            .await
            .unwrap();
        let mut content_frames = 0;
        let mut dones = 0;
        let mut errors: Vec<String> = Vec::new();
        while let Some(ev) = rx.recv().await {
            match ev {
                StreamEvent::ContentDelta(_) => content_frames += 1,
                StreamEvent::Done { .. } => dones += 1,
                StreamEvent::Error(e) => errors.push(e),
                _ => {}
            }
        }
        assert!(
            content_frames >= 6,
            "all frames past the timeout must arrive, got {}",
            content_frames
        );
        assert_eq!(dones, 1, "the live stream must end with a normal Done");
        assert!(
            errors.is_empty(),
            "a live stream must not surface a timeout error: {:?}",
            errors
        );
    }

    // ─── retry budget is bounded at the consumption point ────────────────────
    //
    // The settings save handler clamps `modelRetries`, but a hand-edited or
    // Java-written settings.json reaches `with_retries` straight from
    // `GeneralSettings` and bypasses that handler entirely. This is the only
    // choke point left, so the bound has to be asserted here.

    fn probe_budget(requested: u32) -> u32 {
        let m = ModelConfig {
            name: "m".into(),
            standard: "openai".into(),
            api_url: "http://127.0.0.1:1".into(),
            api_key: "k".into(),
            model: "m".into(),
            ..Default::default()
        };
        LlmClient::with_retries(m, requested)
            .expect("budget probe must build")
            .api_retries
    }

    #[test]
    fn an_absurd_retry_budget_from_the_config_file_is_capped() {
        // Without this cap a `modelRetries: 4000000000` typo in settings.json
        // turns one flaky provider into an effectively unbounded retry storm —
        // and, because the backoff computes `500 * 2u64.pow(attempt)`, panics
        // on overflow once `attempt` reaches 64.
        assert_eq!(probe_budget(u32::MAX), 10);
        assert_eq!(probe_budget(4_000_000_000), 10);
        assert_eq!(
            probe_budget(u32::MAX),
            crate::tools::web_retry::MAX_ATTEMPTS_CEILING,
            "must reuse the web tools' ceiling, not a second hard-coded 10"
        );
    }

    #[test]
    fn a_zero_retry_budget_still_makes_one_attempt() {
        // `0` is a legitimate "no retry" request, but a stream that is never
        // issued at all would hang the turn, so it is floored to 1.
        assert_eq!(probe_budget(0), 1);
        assert_eq!(probe_budget(1), 1);
        assert_eq!(probe_budget(3), 3, "in-range values pass through untouched");
        assert_eq!(probe_budget(10), 10, "the ceiling itself is allowed");
    }
}
