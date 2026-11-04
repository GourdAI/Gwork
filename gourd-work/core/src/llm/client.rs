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
    /// Max retry attempts for failed model calls (from settings.general.api_retries).
    api_retries: u32,
    /// Wire protocol this model speaks, resolved once at construction.
    dialect: Dialect,
}

impl LlmClient {
    pub fn new(model: ModelConfig) -> Self {
        Self::with_retries(model, 3)
    }

    pub fn with_retries(model: ModelConfig, api_retries: u32) -> Self {
        // A panic here means the process cannot make model calls at all, so
        // failing loudly at construction is correct.
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(model.timeout_secs()))
            .connect_timeout(Duration::from_secs(30))
            .build()
            .expect("failed to build http client");
        // Resolved once: the model config cannot change for the lifetime of a run,
        // and resolving per request would repeat the same string matching.
        let dialect = Dialect::resolve(&model);
        debug!(model = %model.name_or_model(), ?dialect, "LLM client protocol");
        Self { model, http, api_retries: api_retries.max(1), dialect }
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
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            "application/json".parse().unwrap(),
        );
        for (k, v) in self.dialect.auth_headers(&self.model) {
            if let (Ok(name), Ok(val)) = (
                reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                v.parse(),
            ) {
                headers.insert(name, val);
            }
        }
        for (k, v) in &self.model.headers {
            if let (Ok(name), Ok(val)) = (
                reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                v.parse(),
            ) {
                headers.insert(name, val);
            }
        }
        headers
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
        let headers = self.build_headers();
        let http = self.http.clone();
        let api_retries = self.api_retries;
        let dialect = self.dialect;

        tokio::spawn(async move {
            let mut attempt = 0u32;
            loop {
                attempt += 1;
                match do_stream(&http, &url, &headers, &body, dialect, &tx).await {
                    Ok(_) => break,
                    Err(e) => {
                        let msg = e.to_string();
                        let delivered = e.downcast_ref::<StreamFailure>()
                            .map(|f| f.delivered)
                            .unwrap_or(false);
                        warn!(attempt, delivered, error = %msg, ?dialect, "LLM stream attempt failed");
                        // Deterministic client/config errors must fail fast:
                        // retrying a de-listed model, a bad key or a malformed
                        // request 20 times only burns ~3 minutes of the user's
                        // time showing "thinking 0s" with no chance of success.
                        // Transient classes (408/409/429/5xx/network) keep the
                        // backoff loop.
                        if is_non_retryable(&msg) || attempt > api_retries {
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
                        // A failure before the first byte stays silent: there
                        // is nothing to discard and no visible seam.
                        if delivered {
                            let _ = tx
                                .send(StreamEvent::Retry {
                                    attempt,
                                    max: api_retries,
                                    reason: msg.clone(),
                                })
                                .await;
                        }
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
        let resp = self.http.post(&url).headers(headers).json(&body).send().await?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            // Same "HTTP <code> <reason>: <body>" shape the streaming path uses, so
            // `is_non_retryable` classifies both identically.
            anyhow::bail!("HTTP {}: {}", status, snippet(&text));
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            anyhow::bail!("provider returned non-JSON body: {}", snippet(&text));
        };
        Ok(extract_completion_text(&v, self.dialect))
    }
}

/// First N characters of a body, for error messages.
fn snippet(s: &str) -> String {
    s.chars().take(500).collect()
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
    let mut decoder = StreamDecoder::new();
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

/// Whether an error message denotes a deterministic failure that no retry can
/// fix: any 4xx except the transient trio (408 timeout, 409 conflict,
/// 429 rate-limit), plus gateway-wrapped business errors (a de-listed model
/// arrives as HTTP 500 with a business message). A de-listed model, a revoked
/// key or a bad request will fail identically on attempt 20 — retrying them
/// only delays the inevitable error bubble.
pub fn is_non_retryable(msg: &str) -> bool {
    // Business-level deterministic errors: some gateways wrap them in HTTP 500
    // (observed: `{"code":500,"msg":"模型已下架"}`), so status alone cannot
    // classify them. These never succeed on retry.
    const FATAL_MARKERS: &[&str] = &[
        "模型已下架",
        "模型不存在",
        "模型未找到",
        "invalid api key",
        "incorrect api key",
        "api key not valid",
        "model_not_found",
        "model_deprecated",
        // Anthropic and Gemini report auth problems with their own vocabulary; a
        // revoked key there is just as unrecoverable.
        "invalid x-api-key",
        "authentication_error",
        "permission_denied",
        "api key not valid",
        "unauthenticated",
    ];
    let lower = msg.to_lowercase();
    if FATAL_MARKERS.iter().any(|m| lower.contains(&m.to_lowercase())) {
        return true;
    }
    let Some(code) = status_code_of(msg) else {
        return false;
    };
    (400..500).contains(&code) && !matches!(code, 408 | 409 | 429)
}

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

    #[test]
    fn non_retryable_classification() {
        // deterministic: fail fast
        assert!(is_non_retryable("HTTP 401 Unauthorized: bad key"));
        assert!(is_non_retryable("HTTP 404 Not Found: model gone"));
        assert!(is_non_retryable("HTTP 400 Bad Request: {\"msg\":\"模型已下架\"}"));
        assert!(is_non_retryable("HTTP 403 Forbidden: x"));
        // business errors wrapped in 500 by gateways: fail fast
        assert!(is_non_retryable("HTTP 500 Internal Server Error: {\"code\":500,\"msg\":\"模型已下架\",\"data\":null}"));
        assert!(is_non_retryable("HTTP 500 Internal Server Error: {\"msg\":\"模型不存在\"}"));
        assert!(is_non_retryable("HTTP 401 Unauthorized: Invalid API key"));
        // transient: keep retrying
        assert!(!is_non_retryable("HTTP 429 Too Many Requests: slow down"));
        assert!(!is_non_retryable("HTTP 408 Request Timeout: x"));
        assert!(!is_non_retryable("HTTP 409 Conflict: x"));
        assert!(!is_non_retryable("HTTP 500 Internal Server Error: upstream boom"));
        assert!(!is_non_retryable("HTTP 502 Bad Gateway: x"));
        // non-HTTP errors (network/parse): keep retrying
        assert!(!is_non_retryable("connection reset by peer"));
        assert!(!is_non_retryable(""));
        // P2: bare JSON error bodies with no `HTTP ` prefix — observed shapes.
        // `403` inside the JSON body is deterministic and must fail fast;
        // `504` is transient at this layer (the react loop's timeout bucket
        // decides how many times to try it).
        assert!(is_non_retryable(
            "{\"code\":\"403\",\"message\":\"your balance is not enough\"}"
        ));
        assert!(!is_non_retryable(
            "{\"code\":\"504\",\"message\":\"First Token Timeout or Upstream Timeout\"}"
        ));
        assert!(!is_non_retryable("{\"code\":\"429\",\"message\":\"slow down\"}"));
        // Timeout classification (P2 bucket)
        assert!(is_timeout_class("HTTP 408 Request Timeout: x"));
        assert!(is_timeout_class("HTTP 504 Gateway Timeout: upstream slow"));
        assert!(is_timeout_class("request timed out"));
        assert!(is_timeout_class("LLM stream timed out: no data received for 150s"));
        assert!(!is_timeout_class("HTTP 401 Unauthorized: bad key"));
        assert!(!is_timeout_class("connection reset by peer"));
    }

    /// Anthropic and Gemini report auth failures without an HTTP code in the
    /// message body; a revoked key must still fail fast rather than burn three
    /// minutes of retries.
    #[test]
    fn provider_specific_auth_errors_fail_fast() {
        assert!(is_non_retryable("HTTP 500 Internal Server Error: {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"}}"));
        assert!(is_non_retryable("HTTP 500 x: {\"error\":{\"status\":\"PERMISSION_DENIED\"}}"));
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
        let c = LlmClient::new(m);
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
}
