//! MANUAL probe: connect + list tools against a REAL MCP endpoint.
//! Usage: cargo run -p gourd-work-core --example mcp_probe_live -- <type> <url> [headerK=V ...]
//! type: streamable | sse | auto (tries streamable then sse)

use gourd_work_core::mcp::{McpManager, McpServerConfig};

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let kind = args.next().expect("usage: mcp_probe_live <type> <url> [K=V...]");
    let url = args.next().expect("url required");
    let mut cfg = McpServerConfig {
        kind: kind.clone(),
        enabled: true,
        url: url.clone(),
        timeout: "30s".into(),
        ..Default::default()
    };
    for kv in args {
        if let Some((k, v)) = kv.split_once('=') {
            cfg.headers.insert(k.to_string(), v.to_string());
        }
    }
    let mcp = McpManager::new();
    println!("== probe type={} url={}", kind, url);
    match mcp.probe("live", &cfg).await {
        Ok(tools) => {
            println!("OK: {} tools", tools.len());
            for t in tools.iter().take(10) {
                println!("  - {} : {}", t.name, t.description.chars().take(80).collect::<String>());
            }
        }
        Err(e) => {
            println!("ERR: {:#}", e);
            if kind == "auto" || kind == "streamable" {
                let mut sse_cfg = cfg.clone();
                sse_cfg.kind = "sse".into();
                println!("== retry as sse");
                match mcp.probe("live", &sse_cfg).await {
                    Ok(tools) => println!("SSE OK: {} tools", tools.len()),
                    Err(e2) => println!("SSE ERR: {:#}", e2),
                }
            }
        }
    }
    mcp.shutdown().await;
}