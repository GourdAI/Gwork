//! MANUAL probe: detect + install a stdio runtime (uv/Node) for real, then
//! optionally connect a stdio MCP server through it.
//! Usage: cargo run -p gourd-work-core --example mcp_runtime_live -- <runtime> [command] [args...]
//!   e.g. ... -- uv uvx blender-mcp
//! Installs into ~/.gwork/runtimes/<id>/ exactly like the UI-confirmed flow.

use std::sync::Arc;

use gourd_work_core::mcp::runtime::{RuntimeId, RuntimeInstaller};
use gourd_work_core::mcp::{McpManager, McpServerConfig};

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let rt = args.next().expect("usage: mcp_runtime_live <uv|node> [command] [args...]");
    let id = RuntimeId::parse(&rt).expect("runtime must be uv|node");

    let command = args.next();
    if let Some(cmd) = &command {
        let check = RuntimeInstaller::check(cmd);
        println!("== check {}", serde_json::to_string_pretty(&check).unwrap());
    }

    let mgr = Arc::new(RuntimeInstaller::new());
    println!("== install {}", id.as_str());
    mgr.start(id).await.expect("start failed");
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        let st = mgr.status(id).await;
        println!("phase={} received={} total={} err={}", st.phase, st.received, st.total, st.error);
        if st.phase == "done" || st.phase == "error" {
            assert_eq!(st.phase, "done", "install failed: {}", st.error);
            break;
        }
    }

    if let Some(cmd) = command {
        let rest: Vec<String> = args.collect();
        println!("== connect {} {:?}", cmd, rest);
        let cfg = McpServerConfig {
            kind: "stdio".into(),
            enabled: true,
            command: cmd.clone(),
            args: rest,
            timeout: "120s".into(),
            ..Default::default()
        };
        let mcp = McpManager::new();
        match mcp.probe("live", &cfg).await {
            Ok(tools) => {
                println!("OK: {} tools", tools.len());
                for t in tools.iter().take(12) {
                    println!("  - {}", t.name);
                }
            }
            Err(e) => println!("ERR: {:#}", e),
        }
        mcp.shutdown().await;
    }
}