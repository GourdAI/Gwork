//! Live end-to-end check for `webfetch` and `crawl_url` (manual only).

use std::path::PathBuf;
use std::sync::Arc;

use gourd_work_core::tools::registry::{Tool, ToolContext};
use gourd_work_core::tools::web::{CrawlUrlTool, WebFetchTool};
use serde_json::json;
use tokio_util::sync::CancellationToken;

fn ctx() -> ToolContext {
    ToolContext {
        workspace: PathBuf::from("."),
        session_dir: None,
        session_id: "fetch-live".into(),
        tool_call_id: "call-live".into(),
        run_id: "run-live".into(),
        frame_tx: None,
        access_mode: "full".into(),
        cancel: CancellationToken::new(),
        hitl_approved: false,
        change_ledger: None,
        gate: None,
        subagent_depth: 0,
        root_session_id: "fetch-live".into(),
        thinking: None,
        model: Default::default(),
        settings: Arc::new(gourd_work_core::config::Settings::default()),
        bash_exempt_dirs: Vec::new(),
    }
}

#[tokio::main]
async fn main() {
    let url = std::env::args().nth(1).unwrap_or_else(|| "https://www.rust-lang.org/".into());
    let c = ctx();
    let t = std::time::Instant::now();
    let out = WebFetchTool.execute(json!({"url": url}), &c).await;
    println!("── webfetch {:?} | is_error={} ──", t.elapsed(), out.is_error);
    println!("{}", out.text.chars().take(300).collect::<String>());

    let t = std::time::Instant::now();
    let out = CrawlUrlTool.execute(json!({"url": url}), &c).await;
    println!("── crawl_url #1 {:?} | is_error={} ──", t.elapsed(), out.is_error);
    println!("{}", out.text.chars().take(200).collect::<String>());

    // Second call in the same process: the Jina circuit breaker must now be
    // open, so this skips the dead Jina route entirely and is much faster.
    let t = std::time::Instant::now();
    let out = CrawlUrlTool.execute(json!({"url": url}), &c).await;
    println!("── crawl_url #2 (breaker open) {:?} | is_error={} ──", t.elapsed(), out.is_error);
    println!("{}", out.text.chars().take(200).collect::<String>());
}
