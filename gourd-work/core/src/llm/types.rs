//! LLM message and response types (OpenAI chat completions compatible).

use serde::{Deserialize, Serialize};

/// Chat message role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

/// Message content: either a plain string or an array of typed parts
/// (OpenAI multimodal format). Serializes as string when Text, array when Parts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Parts(Vec<ContentPart>),
}

impl MessageContent {
    /// Extract the plain-text portion (ignores image parts).
    pub fn text(&self) -> String {
        match self {
            MessageContent::Text(s) => s.clone(),
            MessageContent::Parts(parts) => parts
                .iter()
                .filter_map(|p| match p {
                    ContentPart::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join(""),
        }
    }

    pub fn has_images(&self) -> bool {
        matches!(self, MessageContent::Parts(parts) if parts.iter().any(|p| matches!(p, ContentPart::ImageUrl { .. })))
    }
}

/// A single content part in a multimodal message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    Text { text: String },
    ImageUrl { image_url: ImageUrl },
}

/// Image reference (data URL `data:image/png;base64,...` or http URL).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageUrl {
    pub url: String,
}

/// A single chat message in the conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: Role,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<MessageContent>,
    /// Tool calls requested by the assistant.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    /// Tool call ID this message responds to (role=tool only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Optional name (for tool messages in some APIs).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl ChatMessage {
    fn plain(role: Role, content: impl Into<String>) -> Self {
        Self { role, content: Some(MessageContent::Text(content.into())), tool_calls: None, tool_call_id: None, name: None }
    }

    pub fn system(content: impl Into<String>) -> Self {
        Self::plain(Role::System, content)
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self::plain(Role::User, content)
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self::plain(Role::Assistant, content)
    }

    /// User message with text plus image data URLs (multimodal).
    pub fn user_with_images(text: &str, image_urls: Vec<String>) -> Self {
        if image_urls.is_empty() {
            return Self::user(text);
        }
        let mut parts = vec![ContentPart::Text { text: text.to_string() }];
        for url in image_urls {
            parts.push(ContentPart::ImageUrl { image_url: ImageUrl { url } });
        }
        Self {
            role: Role::User,
            content: Some(MessageContent::Parts(parts)),
            tool_calls: None,
            tool_call_id: None,
            name: None,
        }
    }

    /// Tool-result message with text plus image data URLs (multimodal).
    ///
    /// Same shape as [`Self::user_with_images`] but with `role = tool`; the
    /// OpenAI-compatible dialect serializes `MessageContent::Parts` natively
    /// for tool messages, giving the model the vision channel for images a
    /// tool (read) pulled off disk.
    pub fn tool_result_with_images(
        tool_call_id: impl Into<String>,
        text: &str,
        image_urls: Vec<String>,
    ) -> Self {
        if image_urls.is_empty() {
            return Self::tool_result(tool_call_id, text);
        }
        let mut parts = vec![ContentPart::Text { text: text.to_string() }];
        for url in image_urls {
            parts.push(ContentPart::ImageUrl { image_url: ImageUrl { url } });
        }
        Self {
            role: Role::Tool,
            content: Some(MessageContent::Parts(parts)),
            tool_calls: None,
            tool_call_id: Some(tool_call_id.into()),
            name: None,
        }
    }

    pub fn assistant_with_tools(tool_calls: Vec<ToolCall>) -> Self {
        Self { role: Role::Assistant, content: None, tool_calls: Some(tool_calls), tool_call_id: None, name: None }
    }

    pub fn tool_result(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self { role: Role::Tool, content: Some(MessageContent::Text(content.into())), tool_calls: None, tool_call_id: Some(tool_call_id.into()), name: None }
    }

    /// Convenience: text content or empty string.
    pub fn content_text(&self) -> String {
        self.content.as_ref().map(|c| c.text()).unwrap_or_default()
    }
}

/// A tool call requested by the model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: FunctionCall,
}

/// Function call details within a tool call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionCall {
    pub name: String,
    /// JSON-encoded arguments string.
    pub arguments: String,
}

/// Tool definition sent to the model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    #[serde(rename = "type")]
    pub tool_type: String,
    pub function: FunctionDefinition,
}

/// Function schema definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

impl ToolDefinition {
    pub fn new(name: &str, description: &str, parameters: serde_json::Value) -> Self {
        Self {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: name.into(),
                description: description.into(),
                parameters,
            },
        }
    }
}

/// Chat completion request body.
#[derive(Debug, Clone, Serialize)]
pub struct ChatCompletionRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolDefinition>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<String>,
    pub stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
}

/// A single SSE chunk in a streaming response.
#[derive(Debug, Clone, Deserialize)]
pub struct StreamChunk {
    pub id: Option<String>,
    pub choices: Vec<StreamChoice>,
    pub usage: Option<UsageInfo>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StreamChoice {
    pub index: u32,
    pub delta: StreamDelta,
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct StreamDelta {
    pub role: Option<String>,
    pub content: Option<String>,
    /// Reasoning/thinking content (DeepSeek `reasoning_content`, Claude thinking).
    #[serde(default)]
    pub reasoning_content: Option<String>,
    pub tool_calls: Option<Vec<StreamToolCallDelta>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StreamToolCallDelta {
    pub index: u32,
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub call_type: Option<String>,
    pub function: Option<StreamFunctionDelta>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StreamFunctionDelta {
    pub name: Option<String>,
    pub arguments: Option<String>,
}

/// Token usage information.
///
/// Cache fields are captured because the usage ledger reports cache-hit rate
/// per model; without them every Rust-produced session shows 0% cache hit even
/// when the provider served most of the prompt from cache.
///
/// Two wire dialects are accepted, matching what the Java kernel sees:
///   - OpenAI-compatible: `prompt_tokens_details.cached_tokens` (a **subset** of
///     `prompt_tokens`);
///   - Anthropic-native: `cache_read_input_tokens` / `cache_creation_input_tokens`
///     as **siblings** of `input_tokens` (not included in it).
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct UsageInfo {
    #[serde(default)]
    pub prompt_tokens: u64,
    #[serde(default)]
    pub completion_tokens: u64,
    #[serde(default)]
    pub total_tokens: u64,
    /// Anthropic-native: tokens read from prompt cache.
    #[serde(default, alias = "cache_read_input_tokens")]
    pub cache_read_tokens: u64,
    /// Anthropic-native: tokens written into prompt cache.
    #[serde(default, alias = "cache_creation_input_tokens")]
    pub cache_creation_tokens: u64,
    /// OpenAI-compatible: `prompt_tokens_details.cached_tokens`.
    #[serde(default)]
    pub prompt_tokens_details: Option<PromptTokensDetails>,
}

/// OpenAI's nested cache breakdown (`usage.prompt_tokens_details`).
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct PromptTokensDetails {
    #[serde(default, alias = "cachedTokens")]
    pub cached_tokens: u64,
}

impl UsageInfo {
    /// Effective cache-read tokens across both dialects.
    ///
    /// Takes the larger of the two rather than summing: a provider that reports
    /// both would otherwise be double-counted.
    pub fn effective_cache_read(&self) -> u64 {
        self.cache_read_tokens
            .max(self.prompt_tokens_details.as_ref().map(|d| d.cached_tokens).unwrap_or(0))
    }

    /// Input tokens normalised to "everything actually sent to the model,
    /// cache included".
    ///
    /// Ported from Java's `UsageNormalizer.normalizeInputTokens`. The test is
    /// deliberately **numeric self-consistency, not dialect detection**: cache
    /// creation and cache read are both parts of the input, so an already
    /// normalised upstream must satisfy `prompt >= creation + read`. Only when
    /// `prompt < creation + read` is the value a bare delta needing the cache
    /// added on.
    ///
    /// Why not branch on "is this Anthropic": an upstream dialect parser may
    /// start summing the three itself in some version, and unconditionally
    /// adding cache would then **double-count** — inflating Claude input tokens
    /// by nearly 2x, silently. This check is safe for the OpenAI dialect too,
    /// where `cached_tokens` is a subset of `prompt_tokens` and so never enters
    /// the add branch.
    pub fn normalized_input(&self) -> u64 {
        normalize_input_tokens(
            self.prompt_tokens,
            self.cache_creation_tokens,
            self.effective_cache_read(),
        )
    }

    /// Accumulate another response's usage into this one, mirroring Java's
    /// `Metrics.addUsage`.
    ///
    /// `prompt_tokens` accumulates the **normalised** value, so a ReAct run that
    /// spans several LLM calls totals "everything sent to the model, cache
    /// included" rather than a mix of dialects. Cache counters accumulate raw.
    pub fn add(&mut self, other: &UsageInfo) {
        self.prompt_tokens = self
            .prompt_tokens
            .saturating_add(other.normalized_input());
        self.completion_tokens = self.completion_tokens.saturating_add(other.completion_tokens);
        self.total_tokens = self.total_tokens.saturating_add(other.total_tokens);
        self.cache_creation_tokens = self
            .cache_creation_tokens
            .saturating_add(other.cache_creation_tokens);
        self.cache_read_tokens = self.cache_read_tokens.saturating_add(other.effective_cache_read());
        // Drop the nested OpenAI detail once folded into cache_read_tokens, so a
        // later effective_cache_read() cannot count the same tokens twice.
        self.prompt_tokens_details = None;
    }
}

/// Pure form of [`UsageInfo::normalized_input`], exposed for unit tests.
pub fn normalize_input_tokens(prompt_tokens: u64, cache_creation: u64, cache_read: u64) -> u64 {
    let cache_total = cache_creation.saturating_add(cache_read);
    if prompt_tokens < cache_total {
        // Bare delta (Anthropic-native, or an upstream that did not normalise).
        prompt_tokens.saturating_add(cache_total)
    } else {
        // Already includes cache (OpenAI-compatible, or a normalising upstream).
        prompt_tokens
    }
}

/// Cache hit rate as a percentage (0..=100), 2 decimal places.
///
/// The denominator must be the **normalised** input: with a bare Anthropic delta
/// the rate would be overestimated, up to a constant 100%.
pub fn cache_hit_rate(normalized_input: u64, cache_read: u64) -> f64 {
    if normalized_input == 0 || cache_read == 0 {
        return 0.0;
    }
    let rate = (cache_read as f64) * 100.0 / (normalized_input as f64);
    (rate.min(100.0) * 100.0).round() / 100.0
}

/// Events emitted during streaming.
#[derive(Debug, Clone)]
pub enum StreamEvent {
    /// Text content delta.
    ContentDelta(String),
    /// Reasoning/thinking content delta (reasoning_content field, e.g. DeepSeek/Claude thinking).
    ReasoningDelta(String),
    /// Tool call started (id + function name).
    ToolCallStart { index: u32, id: String, name: String },
    /// Tool call arguments delta.
    ToolCallArgsDelta { index: u32, args: String },
    /// Stream finished.
    Done { finish_reason: String, usage: Option<UsageInfo> },
    /// Error during streaming.
    Error(String),
}
