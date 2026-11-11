//! tools — Tool registry and built-in tool implementations.
//!
//! The tool system mirrors the Java kernel's Talent architecture:
//! each tool has a JSON-schema definition (sent to the LLM) and an async executor.

pub mod agent;
pub mod builtin;
pub mod code;
pub mod filestate;
pub mod output;
pub mod registry;
pub mod web;
pub mod web_retry;

pub use registry::{ToolRegistry, ToolSpec, ToolContext, ToolOutput, ToolGate, SuspendKind, SuspendRequest};
