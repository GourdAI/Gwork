//! dialect — per-protocol request building and stream parsing.
//!
//! The kernel speaks one internal representation ([`ChatMessage`] in,
//! [`StreamEvent`] out) and this module translates at the edges. That split is
//! what makes multiple wire protocols affordable: `react/mod.rs` never learns
//! which provider it is talking to, so adding a dialect cannot change agent
//! behaviour.
//!
//! # Why this existed as a single hard-coded protocol
//!
//! `ModelConfig` has always carried a `standard` field, and the settings UI has
//! always offered five choices (`app-model-settings.js` `STANDARD_OPTIONS`:
//! openai / openai-responses / anthropic / gemini / ollama). But `LlmClient`
//! built a `ChatCompletionRequest` unconditionally and derived the URL with
//! `completions_url()`, which appends `/v1/chat/completions` no matter what.
//! `standard` was read only for *display* (the model list, and
//! `reasoning::selectable_codes`). So a user who picked "Anthropic (Messages)"
//! got a request POSTed to `/v1/chat/completions` with an OpenAI body and a
//! `Bearer` header — a guaranteed 404 or 400, with nothing in the UI explaining
//! that the choice was decorative.
//!
//! Java routes through `ChatDialectManager` over `ChatDialects` constants; the
//! dialect names and wire shapes below are taken from those implementations.

use serde_json::{json, Value};

use super::types::*;
use crate::config::ModelConfig;

/// Which wire protocol a model speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    /// OpenAI `/v1/chat/completions` — also the shape most proxies speak.
    OpenAiChat,
    /// OpenAI `/v1/responses`.
    OpenAiResponses,
    /// Anthropic `/v1/messages`.
    AnthropicMessages,
    /// Google `:generateContent` / `:streamGenerateContent`.
    GeminiGenerate,
    /// Ollama `/api/chat` (newline-delimited JSON, **not** SSE).
    OllamaChat,
}

impl Dialect {
    /// Resolve the dialect for a model configuration.
    ///
    /// Mirrors the `supports()` predicates in Java's dialect classes, including
    /// their URL-based fallbacks: a user who leaves `standard` blank but points
    /// `apiUrl` at `…/v1/messages` or `…/api/chat` still gets the right protocol.
    /// Guessing from the URL is what makes the "decorative dropdown" failure mode
    /// recoverable rather than fatal.
    pub fn resolve(model: &ModelConfig) -> Self {
        let std = model.standard_or_provider().to_ascii_lowercase();
        let url = normalise_url(&model.api_url);
        let m = model.model.to_ascii_lowercase();

        // Explicit standard wins.
        if std.contains("openai-responses") || std.contains("responses") {
            return Dialect::OpenAiResponses;
        }
        if std.contains("anthropic") || std.contains("claude") || std.contains("messages") {
            return Dialect::AnthropicMessages;
        }
        if std.contains("gemini") || std.contains("google") || std.contains("interactions") {
            return Dialect::GeminiGenerate;
        }
        if std.contains("ollama") {
            return Dialect::OllamaChat;
        }

        // URL-based fallbacks (Java applies the same, e.g.
        // `GeminiChatDialect`: `apiUrl.contains(":generateContent")`).
        if url.contains(":generatecontent") || url.contains(":streamgeneratecontent") {
            return Dialect::GeminiGenerate;
        }
        if url.ends_with("/v1/messages") || url.contains("/v1/messages") {
            return Dialect::AnthropicMessages;
        }
        if url.ends_with("/responses") || url.contains("/v1/responses") {
            return Dialect::OpenAiResponses;
        }
        if url.ends_with("/api/chat") || url.contains("/api/chat") {
            return Dialect::OllamaChat;
        }

        // Model-name heuristic, last resort. Java's `AbstractChatDialect` does the
        // same for Gemini (`containsAny(model, "gemini")`).
        if m.contains("gemini") {
            return Dialect::GeminiGenerate;
        }
        if m.starts_with("claude") || m.contains("claude-") {
            return Dialect::AnthropicMessages;
        }

        Dialect::OpenAiChat
    }

    /// The URL to POST to.
    ///
    /// Respects an `apiUrl` that already names the endpoint — users routinely paste
    /// a full URL, and appending a path to it produces a 404 that looks like a
    /// provider outage.
    pub fn endpoint(&self, model: &ModelConfig, stream: bool) -> String {
        let base = model.api_url.trim().trim_end_matches('/').to_string();
        let lower = base.to_ascii_lowercase();

        match self {
            Dialect::OpenAiChat => {
                if lower.ends_with("/chat/completions") {
                    base
                } else if lower.ends_with("/v1") {
                    format!("{}/chat/completions", base)
                } else if lower.contains("/chat/completions") {
                    base
                } else {
                    format!("{}/v1/chat/completions", base)
                }
            }
            Dialect::OpenAiResponses => {
                if lower.ends_with("/responses") {
                    base
                } else if lower.ends_with("/v1") {
                    format!("{}/responses", base)
                } else {
                    format!("{}/v1/responses", base)
                }
            }
            Dialect::AnthropicMessages => {
                if lower.ends_with("/messages") {
                    base
                } else if lower.ends_with("/v1") {
                    format!("{}/messages", base)
                } else {
                    // Java: `path.endsWith("/") ? path + "v1/messages" : path + "/v1/messages"`
                    format!("{}/v1/messages", base)
                }
            }
            Dialect::GeminiGenerate => {
                let model_id = &model.model;
                // Already a full endpoint: just flip the streaming verb.
                if lower.contains(":streamgeneratecontent") || lower.contains(":generatecontent") {
                    let normalised = base
                        .replace(":streamGenerateContent", ":generateContent")
                        .replace(":generatecontent", ":generateContent");
                    let verb = if stream { ":streamGenerateContent" } else { ":generateContent" };
                    let swapped = normalised.replace(":generateContent", verb);
                    return if stream { with_sse_flag(&swapped) } else { swapped };
                }
                let root = if lower.ends_with("/v1beta") || lower.ends_with("/v1") {
                    base.clone()
                } else {
                    format!("{}/v1beta", base)
                };
                let url = format!("{}/models/{}:{}", root, model_id,
                    if stream { "streamGenerateContent" } else { "generateContent" });
                if stream { with_sse_flag(&url) } else { url }
            }
            Dialect::OllamaChat => {
                if lower.ends_with("/api/chat") {
                    base
                } else {
                    format!("{}/api/chat", base)
                }
            }
        }
    }

    /// Auth headers for this protocol.
    ///
    /// Each provider authenticates differently, and getting this wrong is the
    /// single most common cause of a 401 that looks like a bad key:
    /// - Anthropic wants `x-api-key` and a pinned `anthropic-version`;
    /// - Gemini wants `x-goog-api-key`;
    /// - Ollama wants no auth at all (and rejects nothing, but a stray Bearer is
    ///   harmless);
    /// - OpenAI (both) wants `Authorization: Bearer`.
    pub fn auth_headers(&self, model: &ModelConfig) -> Vec<(String, String)> {
        let mut out = Vec::new();
        let key = model.api_key.trim();
        match self {
            Dialect::AnthropicMessages => {
                if !key.is_empty() {
                    out.push(("x-api-key".into(), key.to_string()));
                }
                // Java pins this literal; without it the API rejects the request.
                out.push(("anthropic-version".into(), "2023-06-01".into()));
            }
            Dialect::GeminiGenerate => {
                if !key.is_empty() {
                    out.push(("x-goog-api-key".into(), key.to_string()));
                }
            }
            Dialect::OllamaChat => {
                // Local server; a key is unusual but honour it if configured.
                if !key.is_empty() {
                    out.push(("Authorization".into(), format!("Bearer {}", key)));
                }
            }
            Dialect::OpenAiChat | Dialect::OpenAiResponses => {
                if !key.is_empty() {
                    out.push(("Authorization".into(), format!("Bearer {}", key)));
                }
            }
        }
        out
    }

    /// Build the request body.
    pub fn request_body(&self, req: &DialectRequest) -> Value {
        match self {
            Dialect::OpenAiChat => openai_chat_body(req),
            Dialect::OpenAiResponses => openai_responses_body(req),
            Dialect::AnthropicMessages => anthropic_body(req),
            Dialect::GeminiGenerate => gemini_body(req),
            Dialect::OllamaChat => ollama_body(req),
        }
    }

    /// A fresh stream parser for one request.
    pub fn parser(&self) -> Box<dyn StreamParser> {
        match self {
            Dialect::OpenAiChat => Box::new(OpenAiChatParser::default()),
            Dialect::OpenAiResponses => Box::new(ResponsesParser::default()),
            Dialect::AnthropicMessages => Box::new(AnthropicParser::default()),
            Dialect::GeminiGenerate => Box::new(GeminiParser::default()),
            Dialect::OllamaChat => Box::new(OllamaParser::default()),
        }
    }

    /// Whether this dialect's stream is SSE (`data:` framed) or bare NDJSON.
    ///
    /// Ollama is the odd one out: `/api/chat` streams newline-delimited JSON with
    /// no `data:` prefix. Treating it as SSE silently yields zero events and the
    /// run ends with an empty answer.
    pub fn is_sse(&self) -> bool {
        !matches!(self, Dialect::OllamaChat)
    }
}

/// Strip a trailing slash and lowercase-host normalise for `endsWith` checks.
///
/// Java's `OpenaiDialectSupport.normalizeApiUrl` exists for the same reason: a
/// user pasting `https://host/v1/responses/?x=1` must still match.
fn normalise_url(url: &str) -> String {
    let u = url.trim().trim_end_matches('/');
    // Drop query/fragment for suffix matching.
    let u = u.split(['?', '#']).next().unwrap_or(u);
    u.to_ascii_lowercase()
}

/// Append `?alt=sse` so Gemini streams Server-Sent Events rather than a JSON array.
fn with_sse_flag(url: &str) -> String {
    if url.contains("alt=sse") {
        return url.to_string();
    }
    if url.contains('?') {
        format!("{}&alt=sse", url)
    } else {
        format!("{}?alt=sse", url)
    }
}

// ─── Request ──────────────────────────────────────────────────────────────────

/// Everything a dialect needs to build one request.
#[derive(Debug, Clone, Default)]
pub struct DialectRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolDefinition>,
    pub stream: bool,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    /// Thinking/reasoning level (`reasoning::selectable_codes` vocabulary), or
    /// `None` to let the provider default.
    pub thinking: Option<String>,
}

/// Anthropic requires `max_tokens`; there is no "unlimited". This is the value
/// Java's builder falls back to when the caller did not set one
/// (`AnthropicRequestBuilder` line 255 and `resolveMaxTokens` line 1228 both use
/// 32000).
///
/// This was 8192, which is a hard divergence from Java and an independent cause
/// of "Model output was truncated mid tool-call arguments": a single large
/// `write`/`edit` (its `old_str`/`new_str` inlined as JSON) can exceed 8192
/// output tokens, so Anthropic ends the stream with `finish_reason=max_tokens`
/// (→ `length`) *mid-argument*. The accumulated JSON is then incomplete, the
/// react loop's `broken_argument_calls` rejects it, and the turn aborts blaming
/// the model for a cap we imposed. Java never hits this because it asks for 4×
/// the budget.
const ANTHROPIC_DEFAULT_MAX_TOKENS: u32 = 32000;

/// Map a thinking level onto Anthropic's `budget_tokens`.
///
/// Anthropic expresses reasoning as a token budget, not a level, so the mapping
/// has to invent one. These are deliberately conservative: too large a budget
/// makes the model spend its whole `max_tokens` on thinking and return nothing.
fn anthropic_thinking_budget(level: &str) -> u32 {
    match level.to_ascii_lowercase().as_str() {
        "minimal" => 1024,
        "low" => 2048,
        "medium" => 4096,
        "high" => 8192,
        "xhigh" => 16384,
        _ => 4096,
    }
}

/// Map a thinking level onto Gemini's numeric `thinkingBudget`.
fn gemini_thinking_budget(level: &str) -> i64 {
    match level.to_ascii_lowercase().as_str() {
        "minimal" => 128,
        "low" => 1024,
        "medium" => 4096,
        "high" => 16384,
        "xhigh" => 32768,
        // -1 = let the model decide (Gemini's "dynamic" mode).
        _ => -1,
    }
}

// ─── OpenAI chat completions ──────────────────────────────────────────────────

fn openai_chat_body(req: &DialectRequest) -> Value {
    let mut body = json!({
        "model": req.model,
        "messages": req.messages,
        "stream": req.stream,
    });
    let obj = body.as_object_mut().unwrap();
    if !req.tools.is_empty() {
        obj.insert("tools".into(), json!(req.tools));
    }
    if let Some(t) = req.temperature {
        obj.insert("temperature".into(), json!(t));
    }
    if let Some(m) = req.max_tokens {
        obj.insert("max_tokens".into(), json!(m));
    }
    // Reasoning effort. Sent only when the user picked a level: an explicit
    // `reasoning_effort` on a non-reasoning model is a 400 on most providers,
    // and `reasoning::selectable_codes` already returns an empty list for models
    // that have no levels to pick.
    if let Some(level) = openai_reasoning_effort(req.thinking.as_deref()) {
        obj.insert("reasoning_effort".into(), json!(level));
    }
    if req.stream {
        // Without this the final chunk carries no usage, so the context meter and
        // the compression calibrator would never see real token counts.
        obj.insert("stream_options".into(), json!({ "include_usage": true }));
    }
    body
}

/// OpenAI accepts `minimal|low|medium|high`; `xhigh` is a GWork-level concept that
/// only some models understand, so it is clamped rather than forwarded verbatim.
fn openai_reasoning_effort(level: Option<&str>) -> Option<&'static str> {
    match level?.to_ascii_lowercase().as_str() {
        "minimal" => Some("minimal"),
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" | "xhigh" => Some("high"),
        // "auto"/"" mean "provider default" — omit the field entirely.
        _ => None,
    }
}

// ─── OpenAI Responses ─────────────────────────────────────────────────────────

/// Responses uses a flat tool shape (`{type,name,description,parameters}`) rather
/// than chat completions' `{type,function:{…}}` nesting.
fn responses_tool(def: &ToolDefinition) -> Value {
    json!({
        "type": "function",
        "name": def.function.name,
        "description": def.function.description,
        "parameters": def.function.parameters,
    })
}

fn openai_responses_body(req: &DialectRequest) -> Value {
    // The system prompt becomes `instructions`, not an input item.
    let mut instructions = String::new();
    let mut input: Vec<Value> = Vec::new();

    for m in &req.messages {
        match m.role {
            Role::System => {
                if !instructions.is_empty() {
                    instructions.push('\n');
                }
                instructions.push_str(&m.content_text());
            }
            Role::User => input.push(responses_user_item(m)),
            Role::Assistant => {
                if let Some(calls) = &m.tool_calls {
                    for c in calls {
                        // `arguments` is a JSON *string* on the wire; Responses
                        // wants the parsed object, and an unparseable string must
                        // not abort the request.
                        let args: Value = serde_json::from_str(&c.function.arguments)
                            .unwrap_or_else(|_| json!({}));
                        input.push(json!({
                            "type": "function_call",
                            "call_id": c.id,
                            "name": c.function.name,
                            "arguments": args,
                        }));
                    }
                }
                let text = m.content_text();
                if !text.is_empty() {
                    input.push(json!({
                        "role": "assistant",
                        "type": "message",
                        "content": [{ "type": "output_text", "text": text }],
                    }));
                }
            }
            Role::Tool => {
                // 视觉通道：工具消息携带图片（read 磁盘图片）时，Responses
                // 的 function_call_output.output 允许 content parts 数组，
                // 图片以 input_image 形式携带。纯文本消息行为不变。
                let output: Value = match m.content.as_ref() {
                    Some(MessageContent::Parts(parts)) if parts.iter().any(|p| matches!(p, ContentPart::ImageUrl { .. })) => {
                        let items: Vec<Value> = parts
                            .iter()
                            .filter_map(|p| match p {
                                ContentPart::Text { text } => {
                                    if text.is_empty() { None } else {
                                        Some(json!({ "type": "input_text", "text": text }))
                                    }
                                }
                                ContentPart::ImageUrl { image_url } => {
                                    Some(json!({ "type": "input_image", "image_url": image_url.url }))
                                }
                            })
                            .collect();
                        Value::Array(items)
                    }
                    _ => {
                        let args: Value = serde_json::from_str(&m.content_text())
                            .unwrap_or_else(|_| json!(m.content_text()));
                        args
                    }
                };
                input.push(json!({
                    "type": "function_call_output",
                    "call_id": m.tool_call_id.clone().unwrap_or_default(),
                    "output": output,
                }));
            }
        }
    }

    let mut body = json!({
        "model": req.model,
        "input": input,
        "stream": req.stream,
    });
    let obj = body.as_object_mut().unwrap();
    if !instructions.is_empty() {
        obj.insert("instructions".into(), json!(instructions));
    }
    if !req.tools.is_empty() {
        obj.insert(
            "tools".into(),
            json!(req.tools.iter().map(responses_tool).collect::<Vec<_>>()),
        );
    }
    if let Some(t) = req.temperature {
        obj.insert("temperature".into(), json!(t));
    }
    if let Some(m) = req.max_tokens {
        obj.insert("max_output_tokens".into(), json!(m));
    }
    if let Some(level) = openai_reasoning_effort(req.thinking.as_deref()) {
        obj.insert("reasoning".into(), json!({ "effort": level }));
    }
    body
}

/// A user turn as a Responses input item.
///
/// Content parts must be `input_text` / `input_image`, **not** the `output_text`
/// the server returns: Java's `OpenaiResponsesRequestBuilder` documents that
/// sending `output_text` back out is a hard 400.
fn responses_user_item(m: &ChatMessage) -> Value {
    match &m.content {
        Some(MessageContent::Parts(parts)) => {
            let content: Vec<Value> = parts
                .iter()
                .map(|p| match p {
                    ContentPart::Text { text } => json!({ "type": "input_text", "text": text }),
                    ContentPart::ImageUrl { image_url } => {
                        json!({ "type": "input_image", "image_url": image_url.url })
                    }
                })
                .collect();
            json!({ "role": "user", "type": "message", "content": content })
        }
        _ => json!({
            "role": "user",
            "type": "message",
            "content": [{ "type": "input_text", "text": m.content_text() }],
        }),
    }
}

// ─── Anthropic Messages ───────────────────────────────────────────────────────

fn anthropic_tool(def: &ToolDefinition) -> Value {
    json!({
        "name": def.function.name,
        "description": def.function.description,
        "input_schema": def.function.parameters,
    })
}

/// Normalise an Anthropic `content` value into a block array.
///
/// `content` is either a bare string (plain text) or an array of blocks, and a
/// merge needs both in the same shape. Keeping the *unmerged* path emitting the
/// original shape is deliberate: it means the wire bytes for an ordinary
/// alternating conversation are unchanged, and only the previously-broken
/// sequence is reformatted.
fn anthropic_blocks(content: &Value) -> Vec<Value> {
    match content {
        Value::Array(items) => items.clone(),
        Value::String(text) => vec![json!({ "type": "text", "text": text })],
        other => vec![json!({ "type": "text", "text": other.to_string() })],
    }
}

/// Append `content` as a `role` turn, folding it into the previous turn when that
/// one already carries the same role.
///
/// WHY THIS EXISTS: nothing in this kernel guarantees the history alternates.
/// Plain `ChatMessage::user(...)` messages are pushed by TODO resume calibration
/// (server/mod.rs), by drained interjections/steer and by the auto-rethink and
/// loop reminders (react/mod.rs), and a user turn can also follow a *tool* turn
/// (tool results are themselves a user turn here). Anthropic answers two
/// consecutive same-role turns with
/// `400 messages: roles must alternate between "user" and "assistant"`, and
/// Gemini rejects the equivalent `contents` sequence — so the merge belongs at
/// the protocol boundary, where every injection path is covered, rather than at
/// each call site.
///
/// The order inside a merged turn is not cosmetic: `tool_result` blocks must come
/// first, because they pair with the `tool_use` in the assistant turn above. A
/// text turn merged *after* a tool result keeps the result first; a text turn
/// merged *before* one gets reordered. A stable partition expresses both.
fn push_turn(messages: &mut Vec<Value>, role: &str, content: Value) {
    if let Some(last) = messages.last_mut() {
        if last.get("role").and_then(|r| r.as_str()) == Some(role) {
            let existing = anthropic_blocks(last.get("content").unwrap_or(&Value::Null));
            let mut blocks: Vec<Value> = existing
                .into_iter()
                .chain(anthropic_blocks(&content))
                .collect();
            let (mut results, mut rest): (Vec<Value>, Vec<Value>) = blocks
                .iter()
                .cloned()
                .partition(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"));
            blocks.clear();
            blocks.append(&mut results);
            blocks.append(&mut rest);
            last["content"] = Value::Array(blocks);
            return;
        }
    }
    messages.push(json!({ "role": role, "content": content }));
}

/// Anthropic content block for a message.
fn anthropic_content(m: &ChatMessage) -> Value {
    match &m.content {
        Some(MessageContent::Parts(parts)) => {
            let blocks: Vec<Value> = parts
                .iter()
                .map(|p| match p {
                    ContentPart::Text { text } => json!({ "type": "text", "text": text }),
                    ContentPart::ImageUrl { image_url } => anthropic_image(&image_url.url),
                })
                .collect();
            json!(blocks)
        }
        _ => json!(m.content_text()),
    }
}

/// Split a `data:<mime>;base64,<payload>` URL into Anthropic's source object.
///
/// Anthropic does not accept data URLs; it wants the media type and the raw
/// base64 separately. A remote URL goes through the `url` source type instead.
fn anthropic_image(url: &str) -> Value {
    if let Some(rest) = url.strip_prefix("data:") {
        let (meta, payload) = rest.split_once(',').unwrap_or((rest, ""));
        let media_type = meta.split(';').next().unwrap_or("image/png");
        return json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": media_type,
                "data": payload,
            }
        });
    }
    json!({ "type": "image", "source": { "type": "url", "url": url } })
}

fn anthropic_body(req: &DialectRequest) -> Value {
    let mut system_parts: Vec<String> = Vec::new();
    let mut messages: Vec<Value> = Vec::new();

    for m in &req.messages {
        match m.role {
            // Anthropic has no system *role*: it is a top-level string.
            Role::System => system_parts.push(m.content_text()),
            Role::User => push_turn(&mut messages, "user", anthropic_content(m)),
            Role::Assistant => {
                let mut blocks: Vec<Value> = Vec::new();
                let text = m.content_text();
                if !text.is_empty() {
                    blocks.push(json!({ "type": "text", "text": text }));
                }
                if let Some(calls) = &m.tool_calls {
                    for c in calls {
                        let input: Value = serde_json::from_str(&c.function.arguments)
                            .unwrap_or_else(|_| json!({}));
                        blocks.push(json!({
                            "type": "tool_use",
                            "id": c.id,
                            "name": c.function.name,
                            "input": input,
                        }));
                    }
                }
                // An assistant turn with neither text nor tool use is invalid;
                // Anthropic rejects an empty content array.
                if blocks.is_empty() {
                    blocks.push(json!({ "type": "text", "text": "" }));
                }
                push_turn(&mut messages, "assistant", Value::Array(blocks));
            }
            Role::Tool => {
                // Tool results are a *user* turn carrying `tool_result` blocks.
                // Consecutive tool results must be merged into one user message:
                // Anthropic rejects two user turns in a row.
                //
                // Vision: when the tool message carries image parts (read on a
                // disk image), Anthropic accepts them as first-class
                // `tool_result.content` image blocks.
                let tool_content: Value = match m.content.as_ref() {
                    Some(MessageContent::Parts(parts)) => {
                        let items: Vec<Value> = parts
                            .iter()
                            .filter_map(|p| match p {
                                ContentPart::Text { text } => {
                                    if text.is_empty() { None } else {
                                        Some(json!({ "type": "text", "text": text }))
                                    }
                                }
                                ContentPart::ImageUrl { image_url } => Some({
                                    let src = anthropic_image(&image_url.url)["source"].clone();
                                    json!({ "type": "image", "source": src })
                                }),
                            })
                            .collect();
                        if items.is_empty() { json!(m.content_text()) } else { Value::Array(items) }
                    }
                    _ => json!(m.content_text()),
                };
                let block = json!({
                    "type": "tool_result",
                    "tool_use_id": m.tool_call_id.clone().unwrap_or_default(),
                    "content": tool_content,
                });
                // Tool results are a user turn, so they go through the same merge.
                // The hand-rolled version this replaces appended to the end of an
                // existing block array (putting a `tool_result` *after* text, which
                // breaks the pairing contract) and silently gave up when the previous
                // turn held a bare string rather than an array — which is exactly how
                // two consecutive user turns survived to the wire.
                push_turn(&mut messages, "user", json!([block]));
            }
        }
    }

    let max_tokens = req.max_tokens.unwrap_or(ANTHROPIC_DEFAULT_MAX_TOKENS);
    let mut body = json!({
        "model": req.model,
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": req.stream,
    });
    let obj = body.as_object_mut().unwrap();
    let system = system_parts.join("\n\n");
    if !system.trim().is_empty() {
        obj.insert("system".into(), json!(system));
    }
    if !req.tools.is_empty() {
        obj.insert(
            "tools".into(),
            json!(req.tools.iter().map(anthropic_tool).collect::<Vec<_>>()),
        );
    }
    if let Some(t) = req.temperature {
        // Anthropic rejects `temperature` together with extended thinking.
        if req.thinking.is_none() {
            obj.insert("temperature".into(), json!(t));
        }
    }
    if let Some(level) = &req.thinking {
        let budget = anthropic_thinking_budget(level);
        // The budget must fit inside max_tokens or the request is rejected.
        let budget = budget.min(max_tokens.saturating_sub(1).max(1024));
        obj.insert("thinking".into(), json!({ "type": "enabled", "budget_tokens": budget }));
    }
    body
}

// ─── Gemini ───────────────────────────────────────────────────────────────────

/// Append a Gemini `contents` entry, folding it into the previous entry when
/// that one already carries the same role.
///
/// Same contract as `push_turn` for Anthropic: Gemini rejects consecutive
/// same-role entries (`Please ensure that multiturn requests alternate between
/// user and model`), and this kernel does push adjacent user turns — calibration
/// and interjection text follow the user's own message, and a `functionResponse`
/// entry is itself emitted with role `user`. Parts are concatenated, which keeps
/// every text and every function response, so merging loses nothing.
fn push_gemini_turn(contents: &mut Vec<Value>, role: &str, parts: Vec<Value>) {
    if let Some(last) = contents.last_mut() {
        if last.get("role").and_then(|r| r.as_str()) == Some(role) {
            if let Some(arr) = last.get_mut("parts").and_then(|p| p.as_array_mut()) {
                arr.extend(parts);
                return;
            }
        }
    }
    contents.push(json!({ "role": role, "parts": parts }));
}

fn gemini_body(req: &DialectRequest) -> Value {
    let mut system_parts: Vec<Value> = Vec::new();
    let mut contents: Vec<Value> = Vec::new();

    for m in &req.messages {
        match m.role {
            Role::System => system_parts.push(json!({ "text": m.content_text() })),
            Role::User => push_gemini_turn(&mut contents, "user", gemini_parts(m)),
            Role::Assistant => {
                let mut parts: Vec<Value> = Vec::new();
                let text = m.content_text();
                if !text.is_empty() {
                    parts.push(json!({ "text": text }));
                }
                if let Some(calls) = &m.tool_calls {
                    for c in calls {
                        let args: Value = serde_json::from_str(&c.function.arguments)
                            .unwrap_or_else(|_| json!({}));
                        parts.push(json!({
                            "functionCall": { "name": c.function.name, "args": args }
                        }));
                    }
                }
                if parts.is_empty() {
                    parts.push(json!({ "text": "" }));
                }
                push_gemini_turn(&mut contents, "model", parts);
            }
            Role::Tool => {
                // Gemini keys a function response by *name*, not by call id, so the
                // tool message's `name` is what matters here.
                //
                // 视觉通道：工具消息携带图片时（read 磁盘图片），Gemini 的
                // functionResponse 允许 parts 混合 text 与 inlineData（官方
                // “function calling with images”模式）。纯文本行为不变。
                let has_images = m.content.as_ref().map(|c| c.has_images()).unwrap_or(false);                let response: Value = if has_images {
                    if let Some(MessageContent::Parts(parts)) = m.content.as_ref() {
                        let mut out = serde_json::Map::new();
                        let texts: Vec<String> = parts
                            .iter()
                            .filter_map(|p| match p {
                                ContentPart::Text { text } if !text.is_empty() => Some(text.clone()),
                                _ => None,
                            })
                            .collect();
                        if !texts.is_empty() {
                            out.insert("result".into(), json!(texts.join("\n")));
                        }
                        // 多图时不能用同一个 key 反复 insert（会互相覆盖只剩最后一张）。
                        // 单图保持既有已验证的对象形状；多图退化为数组，由消费方自行展开。
                        let mut images: Vec<Value> = Vec::new();
                        for p in parts {
                            if let ContentPart::ImageUrl { image_url } = p {
                                images.push(gemini_image(&image_url.url)["inlineData"].clone());
                            }
                        }
                        match images.len() {
                            0 => {}
                            1 => { out.insert("inlineData".into(), images.pop().unwrap()); }
                            _ => { out.insert("inlineData".into(), Value::Array(images)); }
                        }
                        Value::Object(out)
                    } else {
                        json!({ "result": m.content_text() })
                    }
                } else {
                    serde_json::from_str(&m.content_text())
                        .unwrap_or_else(|_| json!({ "result": m.content_text() }))
                };
                push_gemini_turn(
                    &mut contents,
                    "user",
                    vec![json!({
                        "functionResponse": {
                            "name": m.name.clone().unwrap_or_default(),
                            "response": response,
                        }
                    })],
                );
            }
        }
    }

    let mut body = json!({ "contents": contents });
    let obj = body.as_object_mut().unwrap();
    if !system_parts.is_empty() {
        obj.insert("systemInstruction".into(), json!({ "parts": system_parts }));
    }
    if !req.tools.is_empty() {
        let decls: Vec<Value> = req
            .tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.function.name,
                    "description": t.function.description,
                    "parameters": t.function.parameters,
                })
            })
            .collect();
        obj.insert("tools".into(), json!([{ "functionDeclarations": decls }]));
    }

    let mut gen = json!({});
    if let Some(t) = req.temperature {
        gen["temperature"] = json!(t);
    }
    if let Some(m) = req.max_tokens {
        gen["maxOutputTokens"] = json!(m);
    }
    if let Some(level) = &req.thinking {
        gen["thinkingConfig"] = json!({ "thinkingBudget": gemini_thinking_budget(level) });
    }
    if gen.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
        obj.insert("generationConfig".into(), gen);
    }
    body
}

fn gemini_parts(m: &ChatMessage) -> Vec<Value> {
    match &m.content {
        Some(MessageContent::Parts(parts)) => parts
            .iter()
            .map(|p| match p {
                ContentPart::Text { text } => json!({ "text": text }),
                ContentPart::ImageUrl { image_url } => gemini_image(&image_url.url),
            })
            .collect(),
        _ => vec![json!({ "text": m.content_text() })],
    }
}

fn gemini_image(url: &str) -> Value {
    if let Some(rest) = url.strip_prefix("data:") {
        let (meta, payload) = rest.split_once(',').unwrap_or((rest, ""));
        let mime = meta.split(';').next().unwrap_or("image/png");
        return json!({ "inlineData": { "mimeType": mime, "data": payload } });
    }
    json!({ "fileData": { "fileUri": url } })
}

// ─── Ollama ───────────────────────────────────────────────────────────────────

fn ollama_body(req: &DialectRequest) -> Value {
    // Ollama speaks the OpenAI message shape, so `messages` serialises directly.
    let mut body = json!({
        "model": req.model,
        "messages": req.messages,
        "stream": req.stream,
    });
    let obj = body.as_object_mut().unwrap();
    if !req.tools.is_empty() {
        obj.insert("tools".into(), json!(req.tools));
    }
    if let Some(level) = &req.thinking {
        // Ollama's `think` is a boolean, not a level. "auto"/empty mean "provider
        // default" — omit the key rather than forcing thinking on.
        let on = !matches!(
            level.to_ascii_lowercase().as_str(),
            "minimal" | "none" | "off" | "auto" | ""
        );
        if on {
            obj.insert("think".into(), json!(true));
        }
    }
    if req.temperature.is_some() || req.max_tokens.is_some() {
        let mut options = json!({});
        if let Some(t) = req.temperature {
            options["temperature"] = json!(t);
        }
        if let Some(m) = req.max_tokens {
            options["num_predict"] = json!(m);
        }
        obj.insert("options".into(), options);
    }
    body
}

// ─── Stream parsing ───────────────────────────────────────────────────────────

/// Translates one provider's stream into [`StreamEvent`]s.
///
/// Stateful: every protocol splits a tool call's arguments across many frames and
/// some (Anthropic) announce the tool name in a different frame from its id.
pub trait StreamParser: Send {
    /// Feed one line of the raw stream (already split on `\n`, `\r` trimmed).
    ///
    /// The line is passed **unstripped**: SSE dialects remove their own `data:`
    /// prefix, while Ollama parses the line as JSON directly.
    fn feed_line(&mut self, line: &str) -> Vec<StreamEvent>;
    /// The transport ended. Must yield a terminal `Done` if none was seen.
    fn finish(&mut self) -> Vec<StreamEvent>;
}

/// Shared bookkeeping for parsers that accumulate tool calls by index.
#[derive(Debug, Default)]
struct ToolAccumulator {
    /// index → (id, name)
    calls: Vec<(String, String)>,
    usage: Option<UsageInfo>,
    finish_reason: Option<String>,
    done: bool,
}

impl ToolAccumulator {
    fn slot(&mut self, index: u32) -> usize {
        let i = index as usize;
        while self.calls.len() <= i {
            self.calls.push((String::new(), String::new()));
        }
        i
    }
    fn terminal(&mut self) -> Vec<StreamEvent> {
        if self.done {
            return Vec::new();
        }
        self.done = true;
        vec![StreamEvent::Done {
            finish_reason: self.finish_reason.clone().unwrap_or_else(|| "stop".into()),
            usage: self.usage.take(),
        }]
    }
}

/// Read usage from a provider's own field names.
///
/// This must be explicit per dialect rather than a `serde_json::from_value` into
/// [`UsageInfo`]: Anthropic and OpenAI Responses both report `input_tokens` /
/// `output_tokens`, while `UsageInfo` is named after OpenAI's `prompt_tokens` /
/// `completion_tokens`. Deserialising those payloads succeeds — every field is
/// `#[serde(default)]` — and yields **all zeros**. The consequence is invisible
/// and total: the context meter reads 0%, the usage ledger records nothing, and
/// the compression calibrator never gets a real token count to anchor to, so the
/// trigger fires on a guess forever.
fn usage_from(v: &Value, input_keys: &[&str], output_keys: &[&str], total_keys: &[&str], cache_keys: &[&str]) -> Option<UsageInfo> {
    let pick = |keys: &[&str]| -> u64 {
        keys.iter()
            .find_map(|k| v.get(*k).and_then(|n| n.as_u64()))
            .unwrap_or(0)
    };
    let mut u = UsageInfo::default();
    u.prompt_tokens = pick(input_keys);
    u.completion_tokens = pick(output_keys);
    u.total_tokens = pick(total_keys);
    u.cache_read_tokens = pick(cache_keys);
    // A payload with none of these keys is not a usage object at all.
    if u.prompt_tokens == 0 && u.completion_tokens == 0 && u.total_tokens == 0 && u.cache_read_tokens == 0 {
        return None;
    }
    // Providers that omit `total` still expect the ledger to add up.
    if u.total_tokens == 0 {
        u.total_tokens = u.normalized_input().saturating_add(u.completion_tokens);
    }
    Some(u)
}

/// OpenAI-compatible naming (chat completions).
fn usage_openai(v: &Value) -> Option<UsageInfo> {
    let mut u = usage_from(
        v,
        &["prompt_tokens"],
        &["completion_tokens"],
        &["total_tokens"],
        &["cache_read_input_tokens"],
    )?;
    // OpenAI nests cache reads under `prompt_tokens_details.cached_tokens`, and
    // there they are a *subset* of prompt_tokens (unlike Anthropic's siblings).
    if u.cache_read_tokens == 0 {
        if let Some(d) = v.get("prompt_tokens_details") {
            let cached = d.get("cached_tokens").and_then(|n| n.as_u64()).unwrap_or(0);
            if cached > 0 {
                u.prompt_tokens_details = Some(PromptTokensDetails { cached_tokens: cached });
            }
        }
    }
    Some(u)
}

/// Anthropic / Responses naming: `input_tokens` + `output_tokens`, with cache
/// counters as **siblings** of the input (not included in it).
fn usage_tokens_style(v: &Value) -> Option<UsageInfo> {
    usage_from(
        v,
        &["input_tokens"],
        &["output_tokens"],
        &["total_tokens"],
        &["cache_read_input_tokens"],
    )
    .map(|mut u| {
        // `cache_creation_input_tokens` is Anthropic-only.
        if let Some(c) = v.get("cache_creation_input_tokens").and_then(|n| n.as_u64()) {
            u.cache_creation_tokens = c;
        }
        u
    })
}

// ── OpenAI chat completions ───────────────────────────────────────────────────

#[derive(Default)]
pub struct OpenAiChatParser {
    acc: ToolAccumulator,
}

impl StreamParser for OpenAiChatParser {
    fn feed_line(&mut self, line: &str) -> Vec<StreamEvent> {
        let Some(data) = strip_sse(line) else { return Vec::new() };
        if data == "[DONE]" {
            return self.acc.terminal();
        }
        let Ok(v) = serde_json::from_str::<Value>(data) else {
            return Vec::new();
        };
        let mut out = Vec::new();

        // An error payload arrives with HTTP 200 on some proxies.
        if let Some(err) = v.get("error") {
            let msg = err
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("provider returned an error")
                .to_string();
            out.push(StreamEvent::Error(msg));
            self.acc.done = true;
            return out;
        }

        if let Some(u) = v.get("usage") {
            if let Some(parsed) = usage_openai(u) {
                self.acc.usage = Some(parsed);
            }
        }

        for choice in v.get("choices").and_then(|c| c.as_array()).cloned().unwrap_or_default() {
            if let Some(reason) = choice.get("finish_reason").and_then(|r| r.as_str()) {
                self.acc.finish_reason = Some(reason.to_string());
            }
            let Some(delta) = choice.get("delta") else { continue };
            if let Some(text) = delta.get("content").and_then(|c| c.as_str()) {
                if !text.is_empty() {
                    out.push(StreamEvent::ContentDelta(text.to_string()));
                }
            }
            // DeepSeek and some proxies use `reasoning_content`; OpenAI's own
            // reasoning models surface summaries here too.
            for key in ["reasoning_content", "reasoning"] {
                if let Some(r) = delta.get(key).and_then(|c| c.as_str()) {
                    if !r.is_empty() {
                        out.push(StreamEvent::ReasoningDelta(r.to_string()));
                    }
                }
            }
            if let Some(tcs) = delta.get("tool_calls").and_then(|t| t.as_array()) {
                for tc in tcs {
                    let idx = tc.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as u32;
                    let slot = self.acc.slot(idx);
                    if let Some(id) = tc.get("id").and_then(|i| i.as_str()) {
                        if !id.is_empty() {
                            self.acc.calls[slot].0 = id.to_string();
                        }
                    }
                    if let Some(f) = tc.get("function") {
                        if let Some(name) = f.get("name").and_then(|n| n.as_str()) {
                            if !name.is_empty() {
                                self.acc.calls[slot].1 = name.to_string();
                                out.push(StreamEvent::ToolCallStart {
                                    index: idx,
                                    id: self.acc.calls[slot].0.clone(),
                                    name: name.to_string(),
                                });
                            }
                        }
                        if let Some(args) = f.get("arguments").and_then(|a| a.as_str()) {
                            if !args.is_empty() {
                                out.push(StreamEvent::ToolCallArgsDelta {
                                    index: idx,
                                    args: args.to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }
        out
    }

    fn finish(&mut self) -> Vec<StreamEvent> {
        self.acc.terminal()
    }
}

/// Strip an SSE `data:` prefix. Returns `None` for blank lines, comments and
/// non-data fields (`event:`, `id:`), which carry no payload here.
fn strip_sse(line: &str) -> Option<&str> {
    let t = line.trim();
    if t.is_empty() || t.starts_with(':') {
        return None;
    }
    let data = t.strip_prefix("data:")?;
    Some(data.trim())
}

// ── OpenAI Responses ──────────────────────────────────────────────────────────

#[derive(Default)]
pub struct ResponsesParser {
    acc: ToolAccumulator,
    /// call_id → index, because Responses identifies tool calls by `call_id`
    /// rather than by a positional index.
    ids: std::collections::HashMap<String, u32>,
    next_index: u32,
}

impl ResponsesParser {
    fn index_for(&mut self, call_id: &str) -> u32 {
        if let Some(i) = self.ids.get(call_id) {
            return *i;
        }
        let i = self.next_index;
        self.next_index += 1;
        self.ids.insert(call_id.to_string(), i);
        i
    }
}

impl StreamParser for ResponsesParser {
    fn feed_line(&mut self, line: &str) -> Vec<StreamEvent> {
        let Some(data) = strip_sse(line) else { return Vec::new() };
        if data == "[DONE]" {
            return self.acc.terminal();
        }
        let Ok(v) = serde_json::from_str::<Value>(data) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        let event_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");

        match event_type {
            "response.output_text.delta" => {
                if let Some(d) = v.get("delta").and_then(|d| d.as_str()) {
                    if !d.is_empty() {
                        out.push(StreamEvent::ContentDelta(d.to_string()));
                    }
                }
            }
            // Reasoning summaries are the Responses equivalent of a thinking stream.
            "response.reasoning_text.delta" | "response.reasoning_summary_text.delta" => {
                if let Some(d) = v.get("delta").and_then(|d| d.as_str()) {
                    if !d.is_empty() {
                        out.push(StreamEvent::ReasoningDelta(d.to_string()));
                    }
                }
            }
            "response.output_item.added" => {
                // A function_call item announces id + name up front.
                if let Some(item) = v.get("item") {
                    if item.get("type").and_then(|t| t.as_str()) == Some("function_call") {
                        let call_id = item
                            .get("call_id")
                            .and_then(|c| c.as_str())
                            .or_else(|| item.get("id").and_then(|c| c.as_str()))
                            .unwrap_or("")
                            .to_string();
                        let name = item.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                        let idx = self.index_for(&call_id);
                        let slot = self.acc.slot(idx);
                        self.acc.calls[slot].0 = call_id;
                        self.acc.calls[slot].1 = name.clone();
                        if !name.is_empty() {
                            out.push(StreamEvent::ToolCallStart { index: idx, id: self.acc.calls[slot].0.clone(), name });
                        }
                    }
                }
            }
            "response.function_call_arguments.delta" => {
                let call_id = v.get("call_id").and_then(|c| c.as_str()).unwrap_or("");
                let idx = self.index_for(call_id);
                if let Some(d) = v.get("delta").and_then(|d| d.as_str()) {
                    if !d.is_empty() {
                        out.push(StreamEvent::ToolCallArgsDelta { index: idx, args: d.to_string() });
                    }
                }
            }
            "response.completed" | "response.incomplete" | "response.failed" => {
                if event_type != "response.completed" {
                    // Surface the provider's reason rather than a bare "stop".
                    self.acc.finish_reason = Some(event_type.trim_start_matches("response.").to_string());
                }
                if let Some(resp) = v.get("response") {
                    if let Some(u) = resp.get("usage") {
                        // Responses uses the Anthropic-style `input_tokens` /
                        // `output_tokens` naming, NOT OpenAI's, despite being an
                        // OpenAI endpoint.
                        if let Some(parsed) = usage_tokens_style(u) {
                            self.acc.usage = Some(parsed);
                        }
                    }
                    if let Some(status) = resp.get("status").and_then(|s| s.as_str()) {
                        if self.acc.finish_reason.is_none() {
                            self.acc.finish_reason = Some(status.to_string());
                        }
                    }
                }
                out.extend(self.acc.terminal());
            }
            "error" => {
                let msg = v
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("Responses stream error")
                    .to_string();
                out.push(StreamEvent::Error(msg));
                self.acc.done = true;
            }
            _ => {}
        }
        out
    }

    fn finish(&mut self) -> Vec<StreamEvent> {
        self.acc.terminal()
    }
}

// ── Anthropic Messages ────────────────────────────────────────────────────────

#[derive(Default)]
pub struct AnthropicParser {
    acc: ToolAccumulator,
    /// content-block index → tool call index. Anthropic numbers *blocks*, and a
    /// block may be text, thinking or tool_use; only tool_use blocks consume a
    /// tool-call slot.
    block_to_tool: std::collections::HashMap<u32, u32>,
    next_tool_index: u32,
}

impl StreamParser for AnthropicParser {
    fn feed_line(&mut self, line: &str) -> Vec<StreamEvent> {
        let Some(data) = strip_sse(line) else { return Vec::new() };
        let Ok(v) = serde_json::from_str::<Value>(data) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        let event_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");

        match event_type {
            "message_start" => {
                if let Some(u) = v.get("message").and_then(|m| m.get("usage")) {
                    if let Some(parsed) = usage_tokens_style(u) {
                        self.acc.usage = Some(parsed);
                    }
                }
            }
            "content_block_start" => {
                let index = v.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as u32;
                if let Some(block) = v.get("content_block") {
                    if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                        let tool_index = self.next_tool_index;
                        self.next_tool_index += 1;
                        self.block_to_tool.insert(index, tool_index);
                        let slot = self.acc.slot(tool_index);
                        let id = block.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
                        let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                        self.acc.calls[slot].0 = id.clone();
                        self.acc.calls[slot].1 = name.clone();
                        out.push(StreamEvent::ToolCallStart { index: tool_index, id, name });
                    }
                }
            }
            "content_block_delta" => {
                let index = v.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as u32;
                if let Some(delta) = v.get("delta") {
                    match delta.get("type").and_then(|t| t.as_str()) {
                        Some("text_delta") => {
                            if let Some(t) = delta.get("text").and_then(|t| t.as_str()) {
                                if !t.is_empty() {
                                    out.push(StreamEvent::ContentDelta(t.to_string()));
                                }
                            }
                        }
                        Some("thinking_delta") => {
                            if let Some(t) = delta.get("thinking").and_then(|t| t.as_str()) {
                                if !t.is_empty() {
                                    out.push(StreamEvent::ReasoningDelta(t.to_string()));
                                }
                            }
                        }
                        Some("input_json_delta") => {
                            // Arguments arrive as partial JSON text, exactly like
                            // OpenAI's `arguments` deltas.
                            if let Some(p) = delta.get("partial_json").and_then(|p| p.as_str()) {
                                if !p.is_empty() {
                                    if let Some(tool_index) = self.block_to_tool.get(&index).copied() {
                                        out.push(StreamEvent::ToolCallArgsDelta {
                                            index: tool_index,
                                            args: p.to_string(),
                                        });
                                    }
                                }
                            }
                        }
                        // `signature_delta` carries the thinking signature; it is
                        // protocol replay state with no user-visible content.
                        _ => {}
                    }
                }
            }
            "message_delta" => {
                if let Some(d) = v.get("delta") {
                    if let Some(reason) = d.get("stop_reason").and_then(|r| r.as_str()) {
                        // Normalise Anthropic's vocabulary onto OpenAI's so the
                        // ReAct loop's `tool_calls`/`stop` branching is unchanged.
                        self.acc.finish_reason = Some(match reason {
                            "tool_use" => "tool_calls".to_string(),
                            "end_turn" | "stop_sequence" => "stop".to_string(),
                            "max_tokens" => "length".to_string(),
                            other => other.to_string(),
                        });
                    }
                }
                // message_delta carries the *output* token count; message_start
                // carried the input. Merge rather than replace, or the input
                // tokens are lost and `normalized_input()` under-reports.
                if let Some(u) = v.get("usage") {
                    if let Some(parsed) = usage_tokens_style(u) {
                        match &mut self.acc.usage {
                            Some(existing) => {
                                if parsed.completion_tokens > 0 {
                                    existing.completion_tokens = parsed.completion_tokens;
                                }
                                if parsed.total_tokens > 0 {
                                    existing.total_tokens = parsed.total_tokens;
                                }
                            }
                            None => self.acc.usage = Some(parsed),
                        }
                    }
                }
            }
            "message_stop" => {
                out.extend(self.acc.terminal());
            }
            "error" => {
                let msg = v
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("Anthropic stream error")
                    .to_string();
                out.push(StreamEvent::Error(msg));
                self.acc.done = true;
            }
            // `ping` and `content_block_stop` carry nothing we need.
            _ => {}
        }
        out
    }

    fn finish(&mut self) -> Vec<StreamEvent> {
        self.acc.terminal()
    }
}

// ── Gemini ────────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct GeminiParser {
    acc: ToolAccumulator,
    next_tool_index: u32,
}

impl StreamParser for GeminiParser {
    fn feed_line(&mut self, line: &str) -> Vec<StreamEvent> {
        let Some(data) = strip_sse(line) else { return Vec::new() };
        let Ok(v) = serde_json::from_str::<Value>(data) else {
            return Vec::new();
        };
        let mut out = Vec::new();

        if let Some(err) = v.get("error") {
            let msg = err
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("Gemini returned an error")
                .to_string();
            out.push(StreamEvent::Error(msg));
            self.acc.done = true;
            return out;
        }

        if let Some(u) = v.get("usageMetadata") {
            // Gemini's field names differ from OpenAI's; map them explicitly.
            let mut usage = UsageInfo::default();
            usage.prompt_tokens =
                u.get("promptTokenCount").and_then(|n| n.as_u64()).unwrap_or(0);
            usage.completion_tokens =
                u.get("candidatesTokenCount").and_then(|n| n.as_u64()).unwrap_or(0);
            usage.total_tokens = u.get("totalTokenCount").and_then(|n| n.as_u64()).unwrap_or(0);
            usage.cache_read_tokens =
                u.get("cachedContentTokenCount").and_then(|n| n.as_u64()).unwrap_or(0);
            self.acc.usage = Some(usage);
        }

        for cand in v.get("candidates").and_then(|c| c.as_array()).cloned().unwrap_or_default() {
            if let Some(reason) = cand.get("finishReason").and_then(|r| r.as_str()) {
                self.acc.finish_reason = Some(match reason {
                    // Gemini's vocabulary → OpenAI's, so the loop is unchanged.
                    "STOP" => "stop".to_string(),
                    "MAX_TOKENS" => "length".to_string(),
                    other => other.to_ascii_lowercase(),
                });
            }
            let Some(parts) = cand.get("content").and_then(|c| c.get("parts")).and_then(|p| p.as_array())
            else {
                continue;
            };
            for part in parts {
                // `thought: true` marks a reasoning part; it must not be rendered
                // as answer text.
                let is_thought = part.get("thought").and_then(|t| t.as_bool()).unwrap_or(false);
                if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                    if !text.is_empty() {
                        out.push(if is_thought {
                            StreamEvent::ReasoningDelta(text.to_string())
                        } else {
                            StreamEvent::ContentDelta(text.to_string())
                        });
                    }
                }
                if let Some(fc) = part.get("functionCall") {
                    // Gemini delivers a function call **whole** (name + args in one
                    // part), so start and args are emitted together.
                    let name = fc.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                    let args = fc.get("args").cloned().unwrap_or_else(|| json!({}));
                    let idx = self.next_tool_index;
                    self.next_tool_index += 1;
                    let slot = self.acc.slot(idx);
                    // Gemini gives no call id; synthesise a stable one so the
                    // tool-result pairing in the next request has something to key on.
                    let id = format!("gemini-call-{}", idx);
                    self.acc.calls[slot].0 = id.clone();
                    self.acc.calls[slot].1 = name.clone();
                    if !name.is_empty() {
                        out.push(StreamEvent::ToolCallStart { index: idx, id, name });
                        let args_str = args.to_string();
                        out.push(StreamEvent::ToolCallArgsDelta { index: idx, args: args_str });
                    }
                }
            }
        }
        out
    }

    fn finish(&mut self) -> Vec<StreamEvent> {
        self.acc.terminal()
    }
}

// ── Ollama ────────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct OllamaParser {
    acc: ToolAccumulator,
    next_tool_index: u32,
}

impl StreamParser for OllamaParser {
    fn feed_line(&mut self, line: &str) -> Vec<StreamEvent> {
        let t = line.trim();
        if t.is_empty() {
            return Vec::new();
        }
        // Ollama streams bare NDJSON. Tolerate an SSE wrapper anyway: some
        // proxies in front of Ollama add one, and refusing to parse would turn a
        // working setup into a silent empty answer.
        let payload = strip_sse(t).unwrap_or(t);
        if payload == "[DONE]" {
            return self.acc.terminal();
        }
        let Ok(v) = serde_json::from_str::<Value>(payload) else {
            return Vec::new();
        };
        let mut out = Vec::new();

        if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
            out.push(StreamEvent::Error(err.to_string()));
            self.acc.done = true;
            return out;
        }

        if let Some(msg) = v.get("message") {
            if let Some(text) = msg.get("content").and_then(|c| c.as_str()) {
                if !text.is_empty() {
                    out.push(StreamEvent::ContentDelta(text.to_string()));
                }
            }
            // Ollama carries thinking in its own field (qwen3 with `think:true`);
            // dropping it here lost the reasoning channel entirely.
            if let Some(th) = msg.get("thinking").and_then(|c| c.as_str()) {
                if !th.is_empty() {
                    out.push(StreamEvent::ReasoningDelta(th.to_string()));
                }
            }
            // Ollama delivers tool calls whole, like Gemini.
            if let Some(tcs) = msg.get("tool_calls").and_then(|t| t.as_array()) {
                for tc in tcs {
                    let Some(f) = tc.get("function") else { continue };
                    let name = f.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                    if name.is_empty() {
                        continue;
                    }
                    let args = f.get("arguments").cloned().unwrap_or_else(|| json!({}));
                    let idx = self.next_tool_index;
                    self.next_tool_index += 1;
                    let slot = self.acc.slot(idx);
                    let id = format!("ollama-call-{}", idx);
                    self.acc.calls[slot].0 = id.clone();
                    self.acc.calls[slot].1 = name.clone();
                    out.push(StreamEvent::ToolCallStart { index: idx, id, name });
                    out.push(StreamEvent::ToolCallArgsDelta { index: idx, args: args.to_string() });
                }
            }
        }

        if let Some(u) = v.get("prompt_eval_count").and_then(|n| n.as_u64()) {
            let usage = self.acc.usage.get_or_insert_with(UsageInfo::default);
            usage.prompt_tokens = u;
        }
        if let Some(u) = v.get("eval_count").and_then(|n| n.as_u64()) {
            let usage = self.acc.usage.get_or_insert_with(UsageInfo::default);
            usage.completion_tokens = u;
        }

        // `done: true` is Ollama's terminator.
        if v.get("done").and_then(|d| d.as_bool()).unwrap_or(false) {
            if let Some(reason) = v.get("done_reason").and_then(|r| r.as_str()) {
                self.acc.finish_reason = Some(match reason {
                    "length" => "length".to_string(),
                    _ => "stop".to_string(),
                });
            }
            out.extend(self.acc.terminal());
        }
        out
    }

    fn finish(&mut self) -> Vec<StreamEvent> {
        self.acc.terminal()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(standard: &str, api_url: &str, model_id: &str) -> ModelConfig {
        ModelConfig {
            name: model_id.into(),
            standard: standard.into(),
            api_url: api_url.into(),
            api_key: "sk-test".into(),
            model: model_id.into(),
            ..Default::default()
        }
    }

    // ── Resolution ────────────────────────────────────────────────────────────

    /// Every value the settings UI offers must resolve to a real dialect. This is
    /// the regression that made the dropdown decorative: four of the five options
    /// silently produced an OpenAI request.
    #[test]
    fn every_ui_standard_option_resolves() {
        assert_eq!(
            Dialect::resolve(&model("openai", "https://api.openai.com/v1", "gpt-4o")),
            Dialect::OpenAiChat
        );
        assert_eq!(
            Dialect::resolve(&model("openai-responses", "https://api.openai.com/v1", "gpt-5")),
            Dialect::OpenAiResponses
        );
        assert_eq!(
            Dialect::resolve(&model("anthropic", "https://api.anthropic.com", "claude-sonnet-4")),
            Dialect::AnthropicMessages
        );
        assert_eq!(
            Dialect::resolve(&model("gemini", "https://generativelanguage.googleapis.com", "gemini-2.5-pro")),
            Dialect::GeminiGenerate
        );
        assert_eq!(
            Dialect::resolve(&model("ollama", "http://localhost:11434", "llama3")),
            Dialect::OllamaChat
        );
    }

    /// `anthropic-messages` is the constant Java uses; it must resolve too.
    #[test]
    fn java_dialect_constants_resolve() {
        for s in ["anthropic", "anthropic-messages"] {
            assert_eq!(
                Dialect::resolve(&model(s, "https://x", "m")),
                Dialect::AnthropicMessages,
                "{}",
                s
            );
        }
        assert_eq!(
            Dialect::resolve(&model("openai-completions", "https://x/v1", "m")),
            Dialect::OpenAiChat
        );
    }

    /// A blank `standard` must still work when the URL names the endpoint. Users
    /// paste full URLs constantly, and `standard` defaults to `"openai"` in the
    /// config deserialiser — so without this, a pasted Anthropic URL would be
    /// treated as OpenAI.
    #[test]
    fn url_fallback_recovers_a_missing_standard() {
        assert_eq!(
            Dialect::resolve(&model("", "https://api.anthropic.com/v1/messages", "claude-x")),
            Dialect::AnthropicMessages
        );
        assert_eq!(
            Dialect::resolve(&model("", "http://localhost:11434/api/chat", "llama3")),
            Dialect::OllamaChat
        );
        assert_eq!(
            Dialect::resolve(&model("", "https://x/v1/responses", "gpt-5")),
            Dialect::OpenAiResponses
        );
        assert_eq!(
            Dialect::resolve(&model("", "https://x/v1beta/models/gemini-2.5-pro:generateContent", "gemini-2.5-pro")),
            Dialect::GeminiGenerate
        );
    }

    /// Model-name heuristic is the last resort.
    #[test]
    fn model_name_is_the_last_resort() {
        assert_eq!(
            Dialect::resolve(&model("", "https://proxy.example.com", "gemini-2.5-flash")),
            Dialect::GeminiGenerate
        );
        assert_eq!(
            Dialect::resolve(&model("", "https://proxy.example.com", "claude-3-5-sonnet")),
            Dialect::AnthropicMessages
        );
        // Unknown → OpenAI chat, the widest-compatible default.
        assert_eq!(
            Dialect::resolve(&model("", "https://proxy.example.com", "some-model")),
            Dialect::OpenAiChat
        );
    }

    /// `provider` is the fallback for `standard` (`standard_or_provider`), and
    /// Java's `OpenaiResponsesDialect` documents `provider: "openai-responses"` as
    /// the way to select it.
    #[test]
    fn provider_field_is_honoured_when_standard_is_blank() {
        let mut m = model("", "https://api.openai.com/v1", "gpt-5");
        m.provider = "openai-responses".into();
        assert_eq!(Dialect::resolve(&m), Dialect::OpenAiResponses);
    }

    // ── Endpoints ─────────────────────────────────────────────────────────────

    #[test]
    fn endpoints_match_each_provider() {
        assert_eq!(
            Dialect::OpenAiChat.endpoint(&model("openai", "https://api.openai.com/v1", "m"), true),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            Dialect::OpenAiResponses.endpoint(&model("openai-responses", "https://api.openai.com/v1", "m"), true),
            "https://api.openai.com/v1/responses"
        );
        assert_eq!(
            Dialect::AnthropicMessages.endpoint(&model("anthropic", "https://api.anthropic.com", "m"), true),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            Dialect::OllamaChat.endpoint(&model("ollama", "http://localhost:11434", "m"), true),
            "http://localhost:11434/api/chat"
        );
    }

    /// Gemini's URL embeds the model id and flips verb with streaming, and must
    /// carry `?alt=sse` or the response is a JSON array rather than a stream.
    #[test]
    fn gemini_endpoint_embeds_model_and_sse_flag() {
        let m = model("gemini", "https://generativelanguage.googleapis.com", "gemini-2.5-pro");
        let stream = Dialect::GeminiGenerate.endpoint(&m, true);
        assert!(stream.contains("/models/gemini-2.5-pro:streamGenerateContent"), "{}", stream);
        assert!(stream.contains("alt=sse"), "missing alt=sse: {}", stream);
        let plain = Dialect::GeminiGenerate.endpoint(&m, false);
        assert!(plain.contains(":generateContent"), "{}", plain);
        assert!(!plain.contains("streamGenerateContent"), "{}", plain);
        assert!(!plain.contains("alt=sse"), "{}", plain);
    }

    /// A user who pasted the full endpoint must not get a path appended.
    #[test]
    fn a_full_endpoint_url_is_not_extended() {
        let m = model("anthropic", "https://api.anthropic.com/v1/messages", "claude-x");
        assert_eq!(
            Dialect::AnthropicMessages.endpoint(&m, true),
            "https://api.anthropic.com/v1/messages"
        );
        let m2 = model("ollama", "http://localhost:11434/api/chat", "llama3");
        assert_eq!(Dialect::OllamaChat.endpoint(&m2, true), "http://localhost:11434/api/chat");
        let m3 = model("openai", "https://x/v1/chat/completions", "g");
        assert_eq!(Dialect::OpenAiChat.endpoint(&m3, true), "https://x/v1/chat/completions");
    }

    /// Trailing slashes must not produce `//v1/messages`.
    #[test]
    fn trailing_slash_is_normalised() {
        let m = model("anthropic", "https://api.anthropic.com/", "claude-x");
        assert_eq!(
            Dialect::AnthropicMessages.endpoint(&m, true),
            "https://api.anthropic.com/v1/messages"
        );
    }

    // ── Auth headers ──────────────────────────────────────────────────────────

    /// Each provider's auth scheme. A `Bearer` token sent to Anthropic is a 401
    /// that reads like a bad key, which is why this is tested per dialect.
    #[test]
    fn auth_headers_follow_the_provider() {
        let m = model("x", "https://h", "m");
        let anthropic: std::collections::HashMap<_, _> =
            Dialect::AnthropicMessages.auth_headers(&m).into_iter().collect();
        assert_eq!(anthropic.get("x-api-key").map(|s| s.as_str()), Some("sk-test"));
        assert_eq!(anthropic.get("anthropic-version").map(|s| s.as_str()), Some("2023-06-01"));
        assert!(!anthropic.contains_key("Authorization"), "Anthropic must not get a Bearer header");

        let gemini: std::collections::HashMap<_, _> =
            Dialect::GeminiGenerate.auth_headers(&m).into_iter().collect();
        assert_eq!(gemini.get("x-goog-api-key").map(|s| s.as_str()), Some("sk-test"));
        assert!(!gemini.contains_key("Authorization"));

        for d in [Dialect::OpenAiChat, Dialect::OpenAiResponses] {
            let h: std::collections::HashMap<_, _> = d.auth_headers(&m).into_iter().collect();
            assert_eq!(h.get("Authorization").map(|s| s.as_str()), Some("Bearer sk-test"));
        }
    }

    /// No key configured → no auth header at all (Ollama and local proxies).
    #[test]
    fn a_missing_key_produces_no_auth_header() {
        let mut m = model("ollama", "http://localhost:11434", "llama3");
        m.api_key = String::new();
        assert!(Dialect::OllamaChat.auth_headers(&m).is_empty());
        // Anthropic still needs its version header.
        let h: std::collections::HashMap<_, _> =
            Dialect::AnthropicMessages.auth_headers(&m).into_iter().collect();
        assert!(!h.contains_key("x-api-key"));
        assert!(h.contains_key("anthropic-version"));
    }

    // ── Request bodies ────────────────────────────────────────────────────────

    fn tool_def() -> ToolDefinition {
        ToolDefinition::new("read", "Read a file", json!({"type":"object","properties":{}}))
    }

    #[test]
    fn openai_chat_body_keeps_the_existing_shape() {
        let req = DialectRequest {
            model: "gpt-4o".into(),
            messages: vec![ChatMessage::system("sys"), ChatMessage::user("hi")],
            tools: vec![tool_def()],
            stream: true,
            ..Default::default()
        };
        let b = Dialect::OpenAiChat.request_body(&req);
        assert_eq!(b["model"], "gpt-4o");
        assert_eq!(b["stream"], true);
        assert_eq!(b["messages"][0]["role"], "system");
        assert_eq!(b["messages"][1]["content"], "hi");
        // Chat completions nests tools under `function`.
        assert_eq!(b["tools"][0]["function"]["name"], "read");
        // Usage must be requested or the meter never sees real counts.
        assert_eq!(b["stream_options"]["include_usage"], true);
        // No thinking level → no reasoning_effort (sending it to a non-reasoning
        // model is a 400).
        assert!(b.get("reasoning_effort").is_none());
    }

    /// The thinking level the user picked must actually reach the wire. Before
    /// this, `/web/chat/thinking/select` persisted a value nothing ever read.
    #[test]
    fn thinking_level_reaches_each_protocol() {
        let req = DialectRequest {
            model: "m".into(),
            messages: vec![ChatMessage::user("hi")],
            stream: true,
            thinking: Some("high".into()),
            ..Default::default()
        };
        assert_eq!(Dialect::OpenAiChat.request_body(&req)["reasoning_effort"], "high");
        assert_eq!(
            Dialect::OpenAiResponses.request_body(&req)["reasoning"]["effort"],
            "high"
        );
        let a = Dialect::AnthropicMessages.request_body(&req);
        assert_eq!(a["thinking"]["type"], "enabled");
        assert!(a["thinking"]["budget_tokens"].as_u64().unwrap() > 0);
        let g = Dialect::GeminiGenerate.request_body(&req);
        assert!(g["generationConfig"]["thinkingConfig"]["thinkingBudget"].as_i64().unwrap() > 0);
        assert_eq!(Dialect::OllamaChat.request_body(&req)["think"], true);
    }

    /// `xhigh` is a GWork-level concept OpenAI does not accept; it must be clamped
    /// rather than forwarded and rejected.
    #[test]
    fn xhigh_is_clamped_for_openai() {
        let req = DialectRequest {
            model: "m".into(),
            messages: vec![ChatMessage::user("hi")],
            thinking: Some("xhigh".into()),
            ..Default::default()
        };
        assert_eq!(Dialect::OpenAiChat.request_body(&req)["reasoning_effort"], "high");
    }

    /// "auto" means provider default: the field must be absent, not `"auto"`.
    #[test]
    fn auto_thinking_omits_the_field() {
        let req = DialectRequest {
            model: "m".into(),
            messages: vec![ChatMessage::user("hi")],
            thinking: Some("auto".into()),
            ..Default::default()
        };
        assert!(Dialect::OpenAiChat.request_body(&req).get("reasoning_effort").is_none());
        assert!(Dialect::OllamaChat.request_body(&req).get("think").is_none());
    }

    /// Anthropic's thinking budget must fit inside `max_tokens`, or the API
    /// rejects the request outright.
    #[test]
    fn anthropic_thinking_budget_fits_inside_max_tokens() {
        let req = DialectRequest {
            model: "claude".into(),
            messages: vec![ChatMessage::user("hi")],
            max_tokens: Some(2000),
            thinking: Some("xhigh".into()),
            ..Default::default()
        };
        let b = Dialect::AnthropicMessages.request_body(&req);
        let budget = b["thinking"]["budget_tokens"].as_u64().unwrap();
        let max = b["max_tokens"].as_u64().unwrap();
        assert!(budget < max, "budget {} must be < max_tokens {}", budget, max);
    }

    #[test]
    fn anthropic_body_uses_its_own_shapes() {
        let req = DialectRequest {
            model: "claude-sonnet-4".into(),
            messages: vec![
                ChatMessage::system("you are helpful"),
                ChatMessage::user("hi"),
                ChatMessage::assistant_with_tools(vec![ToolCall {
                    id: "call_1".into(),
                    call_type: "function".into(),
                    function: FunctionCall {
                        name: "read".into(),
                        arguments: "{\"file_path\":\"a.rs\"}".into(),
                    },
                }]),
                ChatMessage::tool_result("call_1", "contents"),
            ],
            tools: vec![tool_def()],
            stream: true,
            ..Default::default()
        };
        let b = Dialect::AnthropicMessages.request_body(&req);
        // System is a top-level string, not a message.
        assert_eq!(b["system"], "you are helpful");
        assert!(b["messages"].as_array().unwrap().iter().all(|m| m["role"] != "system"));
        // max_tokens is mandatory for Anthropic.
        assert!(b["max_tokens"].as_u64().unwrap() > 0);
        // Tools use `input_schema`, not `parameters`.
        assert_eq!(b["tools"][0]["name"], "read");
        assert!(b["tools"][0].get("input_schema").is_some());
        assert!(b["tools"][0].get("parameters").is_none());
        // Assistant tool call → `tool_use` block with parsed input.
        let assistant = &b["messages"][1];
        assert_eq!(assistant["role"], "assistant");
        assert_eq!(assistant["content"][0]["type"], "tool_use");
        assert_eq!(assistant["content"][0]["id"], "call_1");
        assert_eq!(assistant["content"][0]["input"]["file_path"], "a.rs");
        // Tool result → a *user* turn with a `tool_result` block.
        let tool_msg = &b["messages"][2];
        assert_eq!(tool_msg["role"], "user");
        assert_eq!(tool_msg["content"][0]["type"], "tool_result");
        assert_eq!(tool_msg["content"][0]["tool_use_id"], "call_1");
    }

    /// Parallel tool results must merge into ONE user turn: Anthropic rejects two
    /// consecutive user messages, and a parallel batch produces exactly that.
    #[test]
    fn anthropic_merges_consecutive_tool_results() {
        let req = DialectRequest {
            model: "claude".into(),
            messages: vec![
                ChatMessage::user("go"),
                ChatMessage::assistant_with_tools(vec![
                    ToolCall {
                        id: "c1".into(),
                        call_type: "function".into(),
                        function: FunctionCall { name: "read".into(), arguments: "{}".into() },
                    },
                    ToolCall {
                        id: "c2".into(),
                        call_type: "function".into(),
                        function: FunctionCall { name: "grep".into(), arguments: "{}".into() },
                    },
                ]),
                ChatMessage::tool_result("c1", "one"),
                ChatMessage::tool_result("c2", "two"),
            ],
            ..Default::default()
        };
        let b = Dialect::AnthropicMessages.request_body(&req);
        let msgs = b["messages"].as_array().unwrap();
        let last = msgs.last().unwrap();
        assert_eq!(last["role"], "user");
        let blocks = last["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 2, "both results must share one user turn: {}", last);
        assert_eq!(blocks[0]["tool_use_id"], "c1");
        assert_eq!(blocks[1]["tool_use_id"], "c2");
        // No two user turns in a row anywhere.
        for w in msgs.windows(2) {
            assert!(
                !(w[0]["role"] == "user" && w[1]["role"] == "user"),
                "consecutive user turns: {}",
                b["messages"]
            );
        }
    }

    /// Regression guard for the TODO resume calibration, and for every other
    /// plain `ChatMessage::user` injection (interjections, auto-rethink, loop
    /// reminders): the kernel appends a user turn directly after the user's own
    /// message, and Anthropic answers that with
    /// `400 messages: roles must alternate between "user" and "assistant"` —
    /// which would make the resume feature break the very turn it adds. The two
    /// strict-alternation dialects must fold adjacent same-role turns instead of
    /// forwarding them.
    #[test]
    fn strict_dialects_fold_consecutive_user_turns() {
        let req = DialectRequest {
            model: "m".into(),
            messages: vec![
                ChatMessage::user("continue"),
                ChatMessage::user("[TODO] resume calibration snapshot"),
            ],
            ..Default::default()
        };
        for (label, dialect, key) in [
            ("anthropic", Dialect::AnthropicMessages, "messages"),
            ("gemini", Dialect::GeminiGenerate, "contents"),
        ] {
            let body = dialect.request_body(&req);
            let turns = body[key].as_array().unwrap();
            assert_eq!(1, turns.len(), "{label} forwarded two user turns in a row: {turns:?}");
            // Folding must keep both texts, not drop one.
            let flat = serde_json::to_string(&turns[0]).unwrap();
            assert!(flat.contains("continue"), "{label} lost the first turn: {flat}");
            assert!(flat.contains("calibration"), "{label} lost the second turn: {flat}");
        }
    }

    /// A tool result is itself a user turn here, so calibration text arriving
    /// after one merges into the *same* turn. `tool_result` must still lead: it
    /// pairs with the `tool_use` block in the assistant turn above, and a text
    /// block ahead of it breaks that pairing contract.
    #[test]
    fn merged_user_turn_keeps_tool_result_before_text() {
        let req = DialectRequest {
            model: "claude".into(),
            messages: vec![
                ChatMessage::user("go"),
                ChatMessage::assistant_with_tools(vec![ToolCall {
                    id: "c1".into(),
                    call_type: "function".into(),
                    function: FunctionCall { name: "read".into(), arguments: "{}".into() },
                }]),
                ChatMessage::tool_result("c1", "file body"),
                ChatMessage::user("[TODO] resume calibration"),
            ],
            ..Default::default()
        };
        let body = Dialect::AnthropicMessages.request_body(&req);
        let turns = body["messages"].as_array().unwrap();
        assert_eq!(3, turns.len(), "user/assistant/merged-user: {turns:?}");
        let blocks = turns[2]["content"].as_array().unwrap();
        assert_eq!(2, blocks.len(), "{blocks:?}");
        assert_eq!("tool_result", blocks[0]["type"], "tool_result must lead: {blocks:?}");
        assert_eq!("text", blocks[1]["type"], "{blocks:?}");
        assert_eq!("c1", blocks[0]["tool_use_id"]);
    }

    /// The fold must be inert on an ordinary alternating history: a lone text
    /// turn keeps Anthropic's bare-string `content`, so requests that already
    /// worked go out byte-for-byte as before. Without this the merge would be a
    /// silent wire-format change for every normal chat turn.
    #[test]
    fn an_alternating_history_keeps_its_wire_shape() {
        let req = DialectRequest {
            model: "claude".into(),
            messages: vec![ChatMessage::user("hi"), ChatMessage::assistant("yo")],
            ..Default::default()
        };
        let body = Dialect::AnthropicMessages.request_body(&req);
        let turns = body["messages"].as_array().unwrap();
        assert_eq!(2, turns.len());
        assert!(
            turns[0]["content"].is_string(),
            "plain text must stay a string, not become a block array: {}",
            turns[0]
        );
        assert_eq!("hi", turns[0]["content"].as_str().unwrap());
    }

    /// The case the hand-rolled merge gave up on: a tool result folding into a
    /// user turn whose content is still a bare string. The old code required an
    /// array and otherwise emitted two consecutive user turns — and once merged,
    /// the `tool_result` has to be reordered ahead of the text.
    #[test]
    fn tool_result_merged_into_a_text_turn_is_reordered_ahead() {
        let req = DialectRequest {
            model: "claude".into(),
            messages: vec![
                ChatMessage::user("interjected note"),
                ChatMessage::tool_result("c9", "tool body"),
            ],
            ..Default::default()
        };
        let body = Dialect::AnthropicMessages.request_body(&req);
        let turns = body["messages"].as_array().unwrap();
        assert_eq!(1, turns.len(), "string content blocked the merge: {turns:?}");
        let blocks = turns[0]["content"].as_array().unwrap();
        assert_eq!(2, blocks.len(), "{blocks:?}");
        assert_eq!("tool_result", blocks[0]["type"], "result must lead: {blocks:?}");
        assert_eq!("text", blocks[1]["type"], "{blocks:?}");
    }

    /// Anthropic rejects `temperature` alongside extended thinking.
    #[test]
    fn anthropic_drops_temperature_when_thinking() {
        let req = DialectRequest {
            model: "claude".into(),
            messages: vec![ChatMessage::user("hi")],
            temperature: Some(0.7),
            thinking: Some("high".into()),
            ..Default::default()
        };
        let b = Dialect::AnthropicMessages.request_body(&req);
        assert!(b.get("temperature").is_none(), "{}", b);
        assert!(b.get("thinking").is_some());

        let req2 = DialectRequest { thinking: None, ..req };
        let t = Dialect::AnthropicMessages.request_body(&req2)["temperature"].as_f64().unwrap();
        assert!((t - 0.7).abs() < 1e-6, "temperature {}", t);
    }

    /// Anthropic rejects an empty content array on an assistant turn.
    #[test]
    fn anthropic_never_emits_an_empty_content_array() {
        let req = DialectRequest {
            model: "claude".into(),
            messages: vec![
                ChatMessage::user("hi"),
                ChatMessage { role: Role::Assistant, content: None, tool_calls: None, tool_call_id: None, name: None },
            ],
            ..Default::default()
        };
        let b = Dialect::AnthropicMessages.request_body(&req);
        let assistant = &b["messages"][1];
        assert!(!assistant["content"].as_array().unwrap().is_empty(), "{}", assistant);
    }

    /// Data URLs must be split: Anthropic does not accept `data:` URLs.
    #[test]
    fn anthropic_splits_data_url_images() {
        let req = DialectRequest {
            model: "claude".into(),
            messages: vec![ChatMessage::user_with_images(
                "look",
                vec!["data:image/png;base64,AAAA".to_string()],
            )],
            ..Default::default()
        };
        let b = Dialect::AnthropicMessages.request_body(&req);
        let img = &b["messages"][0]["content"][1];
        assert_eq!(img["type"], "image");
        assert_eq!(img["source"]["type"], "base64");
        assert_eq!(img["source"]["media_type"], "image/png");
        assert_eq!(img["source"]["data"], "AAAA");
    }

    #[test]
    fn responses_body_uses_input_and_instructions() {
        let req = DialectRequest {
            model: "gpt-5".into(),
            messages: vec![ChatMessage::system("sys"), ChatMessage::user("hi")],
            tools: vec![tool_def()],
            stream: true,
            ..Default::default()
        };
        let b = Dialect::OpenAiResponses.request_body(&req);
        assert_eq!(b["instructions"], "sys");
        assert_eq!(b["input"][0]["role"], "user");
        assert_eq!(b["input"][0]["content"][0]["type"], "input_text");
        // Responses tools are FLAT, not nested under `function`.
        assert_eq!(b["tools"][0]["name"], "read");
        assert!(b["tools"][0].get("function").is_none(), "{}", b["tools"][0]);
        assert!(b.get("messages").is_none(), "Responses has no `messages` key");
    }

    /// Sending `output_text` back out is a hard 400 (Java's builder documents
    /// this); user content must be `input_text`.
    #[test]
    fn responses_never_sends_output_text_as_input() {
        let req = DialectRequest {
            model: "gpt-5".into(),
            messages: vec![
                ChatMessage::user("q"),
                ChatMessage::assistant("a"),
                ChatMessage::tool_result("c1", "result"),
            ],
            ..Default::default()
        };
        let b = Dialect::OpenAiResponses.request_body(&req);
        let s = b.to_string();
        // output_text may only appear on an assistant message item, never on input.
        let user_item = &b["input"][0];
        assert_eq!(user_item["content"][0]["type"], "input_text");
        assert!(s.contains("function_call_output"), "{}", s);
        assert_eq!(b["input"][2]["call_id"], "c1");
    }

    // ─── 视觉通道：read 磁盘图片随 tool 消息出站 ──────────────────────

    /// 各方言必须把工具消息携带的图片送进模型视觉通道，不得静默丢弃。
    /// 这是 read 磁盘图片能力的出站半边（入站半边见 builtin read 测试）。
    #[test]
    fn openai_tool_message_with_image_serialises_natively() {
        // OpenAI 兼容通道直接 serde 序列化 messages：Parts 即 content 数组。
        let req = DialectRequest {
            model: "gpt".into(),
            messages: vec![ChatMessage::tool_result_with_images(
                "c1",
                "saw it",
                vec!["data:image/png;base64,AAAA".into()],
            )],
            ..Default::default()
        };
        let b = Dialect::OpenAiChat.request_body(&req);
        let m = &b["messages"][0];
        assert_eq!(m["role"], "tool");
        assert_eq!(m["tool_call_id"], "c1");
        assert_eq!(m["content"][0]["type"], "text");
        assert_eq!(m["content"][1]["type"], "image_url");
        assert_eq!(m["content"][1]["image_url"]["url"], "data:image/png;base64,AAAA");
    }

    #[test]
    fn anthropic_tool_result_carries_image_block() {
        let req = DialectRequest {
            model: "claude".into(),
            messages: vec![
                ChatMessage::assistant_with_tools(vec![ToolCall {
                    id: "c1".into(),
                    call_type: "function".into(),
                    function: FunctionCall { name: "read".into(), arguments: "{}".into() },
                }]),
                ChatMessage::tool_result_with_images(
                    "c1",
                    "saw it",
                    vec!["data:image/png;base64,AAAA".into()],
                ),
            ],
            ..Default::default()
        };
        let b = Dialect::AnthropicMessages.request_body(&req);
        let tool_turn = &b["messages"][1];
        assert_eq!(tool_turn["role"], "user");
        assert_eq!(tool_turn["content"][0]["type"], "tool_result");
        let inner = &tool_turn["content"][0]["content"];
        assert_eq!(inner[0]["type"], "text");
        assert_eq!(inner[1]["type"], "image");
        assert_eq!(inner[1]["source"]["media_type"], "image/png");
        assert_eq!(inner[1]["source"]["data"], "AAAA");
    }

    #[test]
    fn responses_tool_output_carries_image_part() {
        let req = DialectRequest {
            model: "gpt".into(),
            messages: vec![ChatMessage::tool_result_with_images(
                "c1",
                "saw it",
                vec!["data:image/png;base64,AAAA".into()],
            )],
            ..Default::default()
        };
        let b = Dialect::OpenAiResponses.request_body(&req);
        let out = &b["input"][0];
        assert_eq!(out["type"], "function_call_output");
        assert_eq!(out["output"][0]["type"], "input_text");
        assert_eq!(out["output"][1]["type"], "input_image");
        assert_eq!(out["output"][1]["image_url"], "data:image/png;base64,AAAA");
    }

    #[test]
    fn gemini_function_response_carries_inline_data() {
        let req = DialectRequest {
            model: "gemini".into(),
            messages: vec![
                ChatMessage::tool_result_with_images(
                    "c1",
                    "saw it",
                    vec!["data:image/png;base64,AAAA".into()],
                ),
            ],
            ..Default::default()
        };
        let b = Dialect::GeminiGenerate.request_body(&req);
        let resp = &b["contents"][0]["parts"][0]["functionResponse"]["response"];
        assert_eq!(resp["result"], "saw it");
        assert_eq!(resp["inlineData"]["mimeType"], "image/png");
        assert_eq!(resp["inlineData"]["data"], "AAAA");
    }

    /// 多图时 Gemini inlineData 不互相覆盖（只剩最后一张是旧 bug）。
    #[test]
    fn gemini_function_response_multi_image_keeps_all() {
        let req = DialectRequest {
            model: "gemini".into(),
            messages: vec![
                ChatMessage::tool_result_with_images(
                    "c1",
                    "two pics",
                    vec![
                        "data:image/png;base64,AAAA".into(),
                        "data:image/jpeg;base64,BBBB".into(),
                    ],
                ),
            ],
            ..Default::default()
        };
        let b = Dialect::GeminiGenerate.request_body(&req);
        let resp = &b["contents"][0]["parts"][0]["functionResponse"]["response"];
        let arr = resp["inlineData"].as_array().expect("多图应为数组");
        assert_eq!(arr.len(), 2, "两张图都不能丢");
        assert_eq!(arr[0]["mimeType"], "image/png");
        assert_eq!(arr[1]["mimeType"], "image/jpeg");
    }

    /// 无图工具消息行为不变（回归锚）。
    #[test]
    fn plain_tool_message_unchanged_across_dialects() {
        for (dialect, _key) in [
            (Dialect::AnthropicMessages, "messages"),
            (Dialect::GeminiGenerate, "contents"),
        ] {
            let req = DialectRequest {
                model: "m".into(),
                messages: vec![
                    ChatMessage::assistant_with_tools(vec![ToolCall {
                        id: "c1".into(),
                        call_type: "function".into(),
                        function: FunctionCall { name: "read".into(), arguments: "{}".into() },
                    }]),
                    ChatMessage::tool_result("c1", "file body"),
                ],
                ..Default::default()
            };
            let b = dialect.request_body(&req);
            let s = b.to_string();
            assert!(!s.contains("image"), "plain tool result must not grow image parts: {s}");
            assert!(!s.contains("inlineData"), "{s}");
        }
    }

    #[test]
    fn gemini_body_uses_contents_and_system_instruction() {
        let req = DialectRequest {
            model: "gemini-2.5-pro".into(),
            messages: vec![
                ChatMessage::system("sys"),
                ChatMessage::user("hi"),
                ChatMessage::assistant_with_tools(vec![ToolCall {
                    id: "c1".into(),
                    call_type: "function".into(),
                    function: FunctionCall { name: "read".into(), arguments: "{}".into() },
                }]),
            ],
            tools: vec![tool_def()],
            ..Default::default()
        };
        let b = Dialect::GeminiGenerate.request_body(&req);
        assert_eq!(b["systemInstruction"]["parts"][0]["text"], "sys");
        assert_eq!(b["contents"][0]["role"], "user");
        // Assistant is `model` in Gemini's vocabulary.
        assert_eq!(b["contents"][1]["role"], "model");
        assert_eq!(b["contents"][1]["parts"][0]["functionCall"]["name"], "read");
        assert!(b["tools"][0]["functionDeclarations"][0]["name"] == "read");
        assert!(b.get("messages").is_none());
    }

    #[test]
    fn ollama_body_uses_openai_message_shape() {
        let req = DialectRequest {
            model: "llama3".into(),
            messages: vec![ChatMessage::system("sys"), ChatMessage::user("hi")],
            tools: vec![tool_def()],
            stream: true,
            temperature: Some(0.5),
            max_tokens: Some(100),
            ..Default::default()
        };
        let b = Dialect::OllamaChat.request_body(&req);
        assert_eq!(b["model"], "llama3");
        assert_eq!(b["messages"][0]["role"], "system");
        assert_eq!(b["tools"][0]["function"]["name"], "read");
        // Ollama nests tuning under `options`.
        assert_eq!(b["options"]["temperature"], 0.5);
        assert_eq!(b["options"]["num_predict"], 100);
    }

    /// No tools → the key must be absent. An empty `tools: []` makes some
    /// providers reject the request or force tool use.
    #[test]
    fn empty_tool_list_is_omitted() {
        let req = DialectRequest {
            model: "m".into(),
            messages: vec![ChatMessage::user("hi")],
            ..Default::default()
        };
        for d in [
            Dialect::OpenAiChat,
            Dialect::OpenAiResponses,
            Dialect::AnthropicMessages,
            Dialect::GeminiGenerate,
            Dialect::OllamaChat,
        ] {
            let b = d.request_body(&req);
            assert!(b.get("tools").is_none(), "{:?} emitted an empty tools array: {}", d, b);
        }
    }

    // ── Stream parsing ────────────────────────────────────────────────────────

    fn collect(parser: &mut dyn StreamParser, lines: &[&str]) -> Vec<StreamEvent> {
        let mut out = Vec::new();
        for l in lines {
            out.extend(parser.feed_line(l));
        }
        out.extend(parser.finish());
        out
    }

    fn texts(events: &[StreamEvent]) -> String {
        events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::ContentDelta(s) => Some(s.as_str()),
                _ => None,
            })
            .collect()
    }

    fn reasonings(events: &[StreamEvent]) -> String {
        events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::ReasoningDelta(s) => Some(s.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn openai_chat_stream_parses_text_tools_and_usage() {
        let mut p = Dialect::OpenAiChat.parser();
        let events = collect(
            p.as_mut(),
            &[
                "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}",
                "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}",
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"read\",\"arguments\":\"{\\\"a\\\"\"}}]}}]}",
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\":1}\"}}]}}]}",
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}",
                "data: [DONE]",
            ],
        );
        assert_eq!(texts(&events), "Hello");
        assert!(matches!(&events[2], StreamEvent::ToolCallStart { name, id, .. } if name == "read" && id == "c1"));
        let args: String = events
            .iter()
            .filter_map(|e| match e { StreamEvent::ToolCallArgsDelta { args, .. } => Some(args.as_str()), _ => None })
            .collect();
        assert_eq!(args, "{\"a\":1}");
        match events.last().unwrap() {
            StreamEvent::Done { finish_reason, usage } => {
                assert_eq!(finish_reason, "tool_calls");
                assert_eq!(usage.as_ref().unwrap().prompt_tokens, 10);
            }
            other => panic!("expected Done, got {:?}", other),
        }
    }

    /// Reasoning content must not leak into the answer text.
    #[test]
    fn openai_chat_separates_reasoning_from_content() {
        let mut p = Dialect::OpenAiChat.parser();
        let events = collect(
            p.as_mut(),
            &[
                "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking…\"}}]}",
                "data: {\"choices\":[{\"delta\":{\"content\":\"answer\"}}]}",
                "data: [DONE]",
            ],
        );
        assert_eq!(texts(&events), "answer");
        let reasoning: String = events
            .iter()
            .filter_map(|e| match e { StreamEvent::ReasoningDelta(s) => Some(s.as_str()), _ => None })
            .collect();
        assert_eq!(reasoning, "thinking…");
    }

    /// A provider error delivered with HTTP 200 must surface as `Error`, not as a
    /// silent empty answer.
    #[test]
    fn openai_chat_surfaces_inline_errors() {
        let mut p = Dialect::OpenAiChat.parser();
        let events = collect(
            p.as_mut(),
            &["data: {\"error\":{\"message\":\"model not found\"}}"],
        );
        assert!(
            matches!(&events[0], StreamEvent::Error(m) if m.contains("model not found")),
            "{:?}",
            events
        );
    }

    #[test]
    fn anthropic_stream_parses_the_full_event_sequence() {
        let mut p = Dialect::AnthropicMessages.parser();
        let events = collect(
            p.as_mut(),
            &[
                "event: message_start",
                "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":20}}}",
                "event: content_block_start",
                "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\"}}",
                "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}",
                "data: {\"type\":\"content_block_stop\",\"index\":0}",
                "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tu_1\",\"name\":\"read\"}}",
                "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"p\\\":\"}}",
                "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"1}\"}}",
                "data: {\"type\":\"content_block_stop\",\"index\":1}",
                "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":7}}",
                "data: {\"type\":\"message_stop\"}",
            ],
        );
        assert_eq!(texts(&events), "Hi");
        // The tool call must carry Anthropic's id and name. One content delta came
        // first, so the ToolCallStart is events[1] (not [2] as in the OpenAI test,
        // which had two text deltas before its tool call).
        assert!(
            matches!(&events[1], StreamEvent::ToolCallStart { id, name, .. } if id == "tu_1" && name == "read"),
            "{:?}",
            events[1]
        );
        let args: String = events
            .iter()
            .filter_map(|e| match e { StreamEvent::ToolCallArgsDelta { args, .. } => Some(args.as_str()), _ => None })
            .collect();
        assert_eq!(args, "{\"p\":1}");
        match events.last().unwrap() {
            StreamEvent::Done { finish_reason, usage } => {
                // `tool_use` must be normalised to `tool_calls` or the ReAct loop
                // would treat a tool request as a final answer.
                assert_eq!(finish_reason, "tool_calls");
                let u = usage.as_ref().unwrap();
                assert_eq!(u.prompt_tokens, 20, "input from message_start");
                assert_eq!(u.completion_tokens, 7, "output from message_delta");
            }
            other => panic!("expected Done, got {:?}", other),
        }
    }

    /// Anthropic's thinking deltas must map to reasoning, not answer text.
    #[test]
    fn anthropic_thinking_maps_to_reasoning() {
        let mut p = Dialect::AnthropicMessages.parser();
        let events = collect(
            p.as_mut(),
            &[
                "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"hmm\"}}",
                "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}",
                "data: {\"type\":\"message_stop\"}",
            ],
        );
        assert_eq!(texts(&events), "ok");
        assert!(matches!(&events[0], StreamEvent::ReasoningDelta(s) if s == "hmm"));
    }

    /// `end_turn` → `stop`, `max_tokens` → `length`.
    #[test]
    fn anthropic_stop_reasons_are_normalised() {
        for (anthropic, expected) in [("end_turn", "stop"), ("stop_sequence", "stop"), ("max_tokens", "length")] {
            let mut p = Dialect::AnthropicMessages.parser();
            let events = collect(
                p.as_mut(),
                &[
                    &format!("data: {{\"type\":\"message_delta\",\"delta\":{{\"stop_reason\":\"{}\"}}}}", anthropic),
                    "data: {\"type\":\"message_stop\"}",
                ],
            );
            match events.last().unwrap() {
                StreamEvent::Done { finish_reason, .. } => assert_eq!(finish_reason, expected, "{}", anthropic),
                other => panic!("{:?}", other),
            }
        }
    }

    #[test]
    fn responses_stream_parses_text_and_function_calls() {
        let mut p = Dialect::OpenAiResponses.parser();
        let events = collect(
            p.as_mut(),
            &[
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hel\"}",
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"lo\"}",
                "data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"call_id\":\"fc_1\",\"name\":\"read\"}}",
                "data: {\"type\":\"response.function_call_arguments.delta\",\"call_id\":\"fc_1\",\"delta\":\"{\\\"a\\\":1}\"}",
                "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":3,\"output_tokens\":4}}}",
            ],
        );
        assert_eq!(texts(&events), "Hello");
        assert!(
            matches!(&events[2], StreamEvent::ToolCallStart { id, name, .. } if id == "fc_1" && name == "read"),
            "{:?}",
            events[2]
        );
        match events.last().unwrap() {
            StreamEvent::Done { usage, .. } => {
                let u = usage.as_ref().unwrap();
                assert_eq!(u.prompt_tokens, 3);
                assert_eq!(u.completion_tokens, 4);
            }
            other => panic!("{:?}", other),
        }
    }

    /// Reasoning deltas live in dedicated events, never in output text.
    #[test]
    fn responses_reasoning_deltas_map_to_reasoning() {
        let mut p = Dialect::OpenAiResponses.parser();
        let events = collect(
            p.as_mut(),
            &[
                "data: {\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"hmm\"}",
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}",
                "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}",
            ],
        );
        assert_eq!(texts(&events), "ok");
        assert_eq!(reasonings(&events), "hmm");
    }

    /// Responses identifies tool calls by `call_id`, not by index. Two calls
    /// arriving interleaved must not have their arguments cross-wired.
    #[test]
    fn responses_keeps_interleaved_call_ids_apart() {
        let mut p = Dialect::OpenAiResponses.parser();
        let events = collect(
            p.as_mut(),
            &[
                "data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"call_id\":\"A\",\"name\":\"read\"}}",
                "data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"call_id\":\"B\",\"name\":\"grep\"}}",
                "data: {\"type\":\"response.function_call_arguments.delta\",\"call_id\":\"B\",\"delta\":\"B-args\"}",
                "data: {\"type\":\"response.function_call_arguments.delta\",\"call_id\":\"A\",\"delta\":\"A-args\"}",
                "data: {\"type\":\"response.completed\",\"response\":{}}",
            ],
        );
        let a_idx = events.iter().find_map(|e| match e {
            StreamEvent::ToolCallStart { index, id, .. } if id == "A" => Some(*index),
            _ => None,
        }).unwrap();
        let b_idx = events.iter().find_map(|e| match e {
            StreamEvent::ToolCallStart { index, id, .. } if id == "B" => Some(*index),
            _ => None,
        }).unwrap();
        assert_ne!(a_idx, b_idx);
        for e in &events {
            if let StreamEvent::ToolCallArgsDelta { index, args } = e {
                if args.contains("A-args") {
                    assert_eq!(*index, a_idx, "A's args went to the wrong call");
                }
                if args.contains("B-args") {
                    assert_eq!(*index, b_idx, "B's args went to the wrong call");
                }
            }
        }
    }

    #[test]
    fn gemini_stream_parses_parts_and_function_calls() {
        let mut p = Dialect::GeminiGenerate.parser();
        let events = collect(
            p.as_mut(),
            &[
                "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Hi\"}]}}],\"usageMetadata\":{\"promptTokenCount\":11,\"candidatesTokenCount\":2,\"totalTokenCount\":13}}",
                "data: {\"candidates\":[{\"content\":{\"parts\":[{\"thought\":true,\"text\":\"pondering\"}]}}]}",
                "data: {\"candidates\":[{\"content\":{\"parts\":[{\"functionCall\":{\"name\":\"read\",\"args\":{\"p\":1}}}]},\"finishReason\":\"STOP\"}]}",
            ],
        );
        // A `thought` part must not become answer text.
        assert_eq!(texts(&events), "Hi");
        assert!(matches!(&events[1], StreamEvent::ReasoningDelta(s) if s == "pondering"));
        assert!(matches!(&events[2], StreamEvent::ToolCallStart { name, .. } if name == "read"));
        // Gemini sends args whole, so they must still arrive as a delta.
        let args: String = events
            .iter()
            .filter_map(|e| match e { StreamEvent::ToolCallArgsDelta { args, .. } => Some(args.as_str()), _ => None })
            .collect();
        assert!(args.contains("\"p\":1"), "{}", args);
        match events.last().unwrap() {
            StreamEvent::Done { finish_reason, usage } => {
                assert_eq!(finish_reason, "stop", "STOP must normalise to stop");
                let u = usage.as_ref().unwrap();
                assert_eq!(u.prompt_tokens, 11);
                assert_eq!(u.completion_tokens, 2);
            }
            other => panic!("{:?}", other),
        }
    }

    /// Gemini has no call ids; a synthesised one must be stable and non-empty or
    /// the tool result cannot be paired in the next request.
    #[test]
    fn gemini_synthesises_a_tool_call_id() {
        let mut p = Dialect::GeminiGenerate.parser();
        let events = collect(
            p.as_mut(),
            &["data: {\"candidates\":[{\"content\":{\"parts\":[{\"functionCall\":{\"name\":\"read\",\"args\":{}}}]}}]}"],
        );
        match &events[0] {
            StreamEvent::ToolCallStart { id, .. } => assert!(!id.is_empty(), "id must be synthesised"),
            other => panic!("{:?}", other),
        }
    }

    /// Ollama streams bare NDJSON — no `data:` prefix. Parsing it as SSE yields
    /// nothing, which presents as an empty answer with no error.
    #[test]
    fn ollama_parses_bare_ndjson() {
        assert!(!Dialect::OllamaChat.is_sse());
        let mut p = Dialect::OllamaChat.parser();
        let events = collect(
            p.as_mut(),
            &[
                "{\"message\":{\"role\":\"assistant\",\"content\":\"Hi\"},\"done\":false}",
                "{\"message\":{\"role\":\"assistant\",\"content\":\" there\"},\"done\":false,\"prompt_eval_count\":9,\"eval_count\":3}",
                "{\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,\"done_reason\":\"stop\"}",
            ],
        );
        assert_eq!(texts(&events), "Hi there");
        match events.last().unwrap() {
            StreamEvent::Done { usage, .. } => {
                let u = usage.as_ref().unwrap();
                assert_eq!(u.prompt_tokens, 9);
                assert_eq!(u.completion_tokens, 3);
            }
            other => panic!("{:?}", other),
        }
    }

    #[test]
    fn ollama_parses_tool_calls() {
        let mut p = Dialect::OllamaChat.parser();
        let events = collect(
            p.as_mut(),
            &["{\"message\":{\"role\":\"assistant\",\"tool_calls\":[{\"function\":{\"name\":\"read\",\"arguments\":{\"p\":1}}}]},\"done\":true}"],
        );
        assert!(matches!(&events[0], StreamEvent::ToolCallStart { name, .. } if name == "read"));
        let args: String = events
            .iter()
            .filter_map(|e| match e { StreamEvent::ToolCallArgsDelta { args, .. } => Some(args.as_str()), _ => None })
            .collect();
        assert!(args.contains("\"p\":1"), "{}", args);
    }

    /// An Ollama error field must surface rather than being read as content.
    #[test]
    fn ollama_surfaces_errors() {
        let mut p = Dialect::OllamaChat.parser();
        let events = collect(p.as_mut(), &["{\"error\":\"model 'x' not found\"}"]);
        assert!(matches!(&events[0], StreamEvent::Error(m) if m.contains("not found")), "{:?}", events);
    }

    /// Ollama's `message.thinking` (qwen3 with think enabled) is the reasoning
    /// channel; dropping it lost the thinking block entirely.
    #[test]
    fn ollama_thinking_maps_to_reasoning() {
        let mut p = Dialect::OllamaChat.parser();
        let events = collect(
            p.as_mut(),
            &[
                "{\"message\":{\"role\":\"assistant\",\"thinking\":\"hmm\",\"content\":\"\"},\"done\":false}",
                "{\"message\":{\"role\":\"assistant\",\"content\":\"ok\"},\"done\":true,\"done_reason\":\"stop\"}",
            ],
        );
        assert_eq!(texts(&events), "ok");
        assert_eq!(reasonings(&events), "hmm");
    }

    // ── Robustness ────────────────────────────────────────────────────────────

    /// Every parser must terminate with exactly one `Done`, even on a truncated
    /// stream. Without it the ReAct loop waits forever on a channel that closed.
    #[test]
    fn every_parser_terminates_on_a_truncated_stream() {
        for d in [
            Dialect::OpenAiChat,
            Dialect::OpenAiResponses,
            Dialect::AnthropicMessages,
            Dialect::GeminiGenerate,
            Dialect::OllamaChat,
        ] {
            let mut p = d.parser();
            let events = collect(p.as_mut(), &["data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}"]);
            let dones = events.iter().filter(|e| matches!(e, StreamEvent::Done { .. })).count();
            assert_eq!(dones, 1, "{:?} must emit exactly one Done", d);
        }
    }

    /// A second terminator must not produce a second `Done`: the loop treats the
    /// first as end-of-turn and a duplicate would corrupt accounting.
    #[test]
    fn done_is_emitted_only_once() {
        let mut p = Dialect::OpenAiChat.parser();
        let events = collect(p.as_mut(), &["data: [DONE]", "data: [DONE]"]);
        assert_eq!(events.iter().filter(|e| matches!(e, StreamEvent::Done { .. })).count(), 1);
    }

    /// Malformed JSON, blank lines, SSE comments and unknown event types must all
    /// be ignored rather than panicking or ending the stream.
    #[test]
    fn malformed_input_is_ignored() {
        for d in [
            Dialect::OpenAiChat,
            Dialect::OpenAiResponses,
            Dialect::AnthropicMessages,
            Dialect::GeminiGenerate,
            Dialect::OllamaChat,
        ] {
            let mut p = d.parser();
            let events = collect(
                p.as_mut(),
                &[
                    "",
                    ": keep-alive comment",
                    "event: something",
                    "data: {not json at all",
                    "data: {\"type\":\"totally.unknown.event\"}",
                    "data: {}",
                    "{\"garbage\":true}",
                ],
            );
            assert_eq!(
                events.iter().filter(|e| matches!(e, StreamEvent::Done { .. })).count(),
                1,
                "{:?} must still terminate cleanly",
                d
            );
            assert!(
                !events.iter().any(|e| matches!(e, StreamEvent::Error(_))),
                "{:?} turned noise into an error: {:?}",
                d,
                events
            );
        }
    }

    /// A CJK delta split across frames must not be mangled. The byte-level
    /// decoding is the client's job (`StreamDecoder`), but the parser must not
    /// re-encode through a lossy path.
    #[test]
    fn cjk_content_survives_parsing() {
        let mut p = Dialect::OpenAiChat.parser();
        let events = collect(
            p.as_mut(),
            &[
                "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}",
                "data: {\"choices\":[{\"delta\":{\"content\":\"世界\"}}]}",
                "data: [DONE]",
            ],
        );
        assert_eq!(texts(&events), "你好世界");
    }

    /// Parallel tool calls in one OpenAI frame must keep distinct indices.
    #[test]
    fn parallel_tool_calls_keep_distinct_indices() {
        let mut p = Dialect::OpenAiChat.parser();
        let events = collect(
            p.as_mut(),
            &[
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"a\",\"function\":{\"name\":\"read\",\"arguments\":\"{}\"}},{\"index\":1,\"id\":\"b\",\"function\":{\"name\":\"grep\",\"arguments\":\"{}\"}}]}}]}",
                "data: [DONE]",
            ],
        );
        let starts: Vec<(u32, String)> = events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::ToolCallStart { index, name, .. } => Some((*index, name.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(starts, vec![(0, "read".to_string()), (1, "grep".to_string())]);
    }
}
