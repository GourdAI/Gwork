//! Live end-to-end check for the Exa-backed `codesearch` tool (manual only).

use std::path::PathBuf;
use std::sync::Arc;

use gourd_work_core::tools::registry::{Tool, ToolContext};
use gourd_work_core::tools::web::CodeSearchTool;
use serde_json::json;
use tokio_util::sync::CancellationToken;

#[tokio::main]
async fn main() {
    let query = std::env::args().nth(1).unwrap_or_else(|| "React useState hook example".into());
    let ctx = ToolContext {
        workspace: PathBuf::from("."),
        session_dir: None,
        session_id: "codesearch-live".into(),
        tool_call_id: "call-live".into(),
        run_id: "run-live".into(),
        frame_tx: None,
        access_mode: "full".into(),
        cancel: CancellationToken::new(),
        hitl_approved: false,
        change_ledger: None,
        gate: None,
        subagent_depth: 0,
        root_session_id: "codesearch-live".into(),
        thinking: None,
        model: Default::default(),
        settings: Arc::new(gourd_work_core::config::Settings::default()),
        bash_exempt_dirs: Vec::new(),
    };
    let started = std::time::Instant::now();
    let out = CodeSearchTool.execute(json!({"query": query, "tokensNum": 2000}), &ctx).await;
    println!("── elapsed {:?} | is_error={} ──", started.elapsed(), out.is_error);
    println!("{}", out.text.chars().take(1500).collect::<String>());
}
