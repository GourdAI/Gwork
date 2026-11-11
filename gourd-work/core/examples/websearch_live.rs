//! Live end-to-end check for the multi-engine `websearch` tool.
//!
//! Not part of the test suite on purpose: it hits the real internet, so it
//! belongs to manual verification (`cargo run -p gourd-work-core --example
//! websearch_live -- "query"`), never to CI.

use std::path::PathBuf;
use std::sync::Arc;

use gourd_work_core::tools::registry::{Tool, ToolContext};
use gourd_work_core::tools::web::WebSearchTool;
use serde_json::json;
use tokio_util::sync::CancellationToken;

#[tokio::main]
async fn main() {
    let query = std::env::args().nth(1).unwrap_or_else(|| "Rust tokio tutorial".into());
    let ctx = ToolContext {
        workspace: PathBuf::from("."),
        session_dir: None,
        session_id: "websearch-live".into(),
        tool_call_id: "call-live".into(),
        run_id: "run-live".into(),
        frame_tx: None,
        access_mode: "full".into(),
        cancel: CancellationToken::new(),
        hitl_approved: false,
        change_ledger: None,
        gate: None,
        subagent_depth: 0,
        root_session_id: "websearch-live".into(),
        thinking: None,
        model: Default::default(),
        settings: Arc::new(gourd_work_core::config::Settings::default()),
        bash_exempt_dirs: Vec::new(),
    };
    let started = std::time::Instant::now();
    let out = WebSearchTool.execute(json!({"query": query, "numResults": 5}), &ctx).await;
    println!("── elapsed {:?} | is_error={} ──", started.elapsed(), out.is_error);
    println!("{}", out.text);
}
