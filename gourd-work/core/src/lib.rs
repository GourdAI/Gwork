//! gourd-work-core — GWork Rust-native agent kernel.
//!
//! Modules:
//! - `config`   : settings.json compatible configuration loading
//! - `llm`      : OpenAI-compatible streaming LLM client
//! - `protocol` : WebSocket streaming frame protocol (frontend-compatible)
//! - `tools`    : Tool registry and built-in tool implementations
//! - `react`    : ReAct (Reason+Act) agent loop
//! - `session`  : Session management and ndjson persistence
//! - `memory`   : Long/short-term memory system
//! - `skills`   : Skill marketplace integration
//! - `mcp`      : Model Context Protocol client
//! - `team`     : Multi-agent team orchestration
//! - `agents`   : Sub-agent definitions (built-ins + user directories)
//! - `server`   : HTTP + WebSocket server (/web/chat/* + /web/gate)

pub mod config;
pub mod llm;
pub mod protocol;
pub mod tools;
pub mod react;
pub mod session;
pub mod session_usage;
pub mod memory;
pub mod skills;
pub mod mcp;
pub mod team;
pub mod agents;
pub mod server;

// ── Phase modules (post-v1 feature parity with the Java kernel) ──────────────
pub mod attachments;
pub mod changes;
pub mod compress;
pub mod ephemeral;
pub mod loop_task;
pub mod channels;
pub mod acp;
pub mod projects;
pub mod filer;
pub mod gitops;
pub mod hitl;
pub mod queue;
pub mod reasoning;
pub mod remote;
pub mod terminal;
pub mod textcodec;
pub mod todo;
pub mod usage;
pub mod usage_ledger;
pub mod watcher;
