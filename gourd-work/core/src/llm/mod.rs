//! llm — streaming LLM client.
//!
//! Supports:
//! - Streaming completions over SSE (and Ollama's newline-delimited JSON)
//! - Tool/function calling with parallel tool calls
//! - Retry with exponential backoff
//! - Multiple protocol standards: see [`dialect`] for openai chat completions,
//!   openai responses, anthropic messages, gemini generateContent and ollama

pub mod client;
pub mod dialect;
pub mod types;

pub use client::LlmClient;
pub use dialect::{Dialect, DialectRequest, StreamParser};
pub use types::*;
