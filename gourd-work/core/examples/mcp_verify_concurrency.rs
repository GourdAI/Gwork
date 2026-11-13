//! MANUAL probe: does a slow MCP server still block calls to a healthy one?
//! Usage: cargo run -p gourd-work-core --example mcp_verify_concurrency -- <slow-url> <fast-url>

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gourd_work_core::config::{ModelConfig, PermissionSettings, Settings};
use gourd_work_core::mcp::{McpManager, McpServerConfig};
use serde_json::json;
use tokio_util::sync::CancellationToken;

fn ctx() -> (
    gourd_work_core::tools::registry::ToolContext,
    PermissionSettings,
) {
    (
        gourd_work_core::tools::registry::ToolContext {
            workspace: PathBuf::from("."), session_dir: None, session_id: "p".into(),
            tool_call_id: "c".into(), run_id: "r".into(), frame_tx: None,
            access_mode: "full".into(), cancel: CancellationToken::new(), hitl_approved: false,
            change_ledger: None, gate: None, subagent_depth: 0, root_session_id: "p".into(),
            thinking: None, model: Arc::new(ModelConfig::default()),
            settings: Arc::new(Settings::default()), bash_exempt_dirs: Vec::new(),
        },
        PermissionSettings::default(),
    )
}

fn http_cfg(url: &str) -> McpServerConfig {
    McpServerConfig { kind: "streamable".into(), enabled: true, url: url.to_string(), ..Default::default() }
}

#[tokio::main]
async fn main() {
    let slow_url = std::env::args().nth(1).expect("slow url");
    let fast_url = std::env::args().nth(2).expect("fast url");
    let (_c, _p) = ctx();

    let mcp = Arc::new(McpManager::new());
    mcp.connect_one("slow", &http_cfg(&slow_url)).await.expect("slow connect");
    mcp.connect_one("fast", &http_cfg(&fast_url)).await.expect("fast connect");

    // Baseline: how long does a fast call take alone?
    let t0 = Instant::now();
    let r = mcp.call_tool("fast", "echo", json!({"message":"baseline"})).await.expect("fast baseline");
    let baseline = t0.elapsed();
    println!("fast call alone: {:?} -> {:?}", baseline, r.text);

    // Now fire a slow call (the server sleeps ~3s) and, while it is in flight,
    // hammer the healthy server. Under the old single-mutex design every one of
    // these would queue behind the slow call; with per-server slots they must all
    // return in roughly the baseline time.
    let mcp_slow = mcp.clone();
    let slow = tokio::spawn(async move {
        let t = Instant::now();
        let r = mcp_slow.call_tool("slow", "slow_echo", json!({"message":"hi","ms":3000})).await;
        (t.elapsed(), r.map(|x| x.text))
    });

    // Give the slow call time to actually reach the server and be mid-RPC.
    tokio::time::sleep(Duration::from_millis(400)).await;

    let mut concurrent_max = Duration::ZERO;
    let mut ok = 0usize;
    for i in 0..6 {
        let mcp = mcp.clone();
        let t = Instant::now();
        let r = mcp.call_tool("fast", "echo", json!({"message": i.to_string()})).await;
        let d = t.elapsed();
        if d > concurrent_max { concurrent_max = d; }
        if r.is_ok() { ok += 1; }
        println!("  fast call while slow in flight: {:?} ok={}", d, r.is_ok());
    }

    let (slow_elapsed, slow_res) = slow.await.expect("slow task");
    println!("slow call total: {:?} -> {:?}", slow_elapsed, slow_res);

    let passed = ok == 6
        && concurrent_max < Duration::from_millis(2000)
        && slow_elapsed >= Duration::from_millis(2500)
        && slow_res.is_ok();

    println!("\n=== {} ===", if passed { "PASS" } else { "FAIL" });
    println!("fast calls succeeded: {}/6, slowest while blocked: {:?}", ok, concurrent_max);
    println!("slow call respected its own duration: {:?}", slow_elapsed);

    mcp.shutdown().await;
    std::process::exit(if passed { 0 } else { 1 });
}
