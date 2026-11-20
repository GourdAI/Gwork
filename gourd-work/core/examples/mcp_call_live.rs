//! MANUAL probe: full USAGE path — connect, list tools, then CALL tools and
//! verify round-trip state. This is the "装了连接器到底能不能用" test:
//! probe alone only proves handshake; this proves tools actually execute.
//! Usage: cargo run -p gourd-work-core --example mcp_call_live

use gourd_work_core::mcp::{McpManager, McpServerConfig};

#[tokio::main]
async fn main() {
    // The exact config a market install of "Memory" produces on Windows.
    let cfg = McpServerConfig {
        kind: "stdio".into(),
        enabled: true,
        command: "npx".into(),
        args: vec!["-y".into(), "@modelcontextprotocol/server-memory".into()],
        timeout: "60s".into(),
        ..Default::default()
    };
    let mcp = McpManager::new();
    let tools = match mcp.probe("memory", &cfg).await {
        Ok(t) => t,
        Err(e) => { println!("CONNECT ERR: {:#}", e); return; }
    };
    println!("OK connected, {} tools: {}", tools.len(),
        tools.iter().map(|t| t.name.clone()).collect::<Vec<_>>().join(", "));

    // Persistent connection for calls (probe tears down after listing).
    if let Err(e) = mcp.connect_one("memory", &cfg).await {
        println!("CONNECT_ONE ERR: {:#}", e);
        return;
    }

    // 1) write via create_entities
    let write = serde_json::json!({
        "entities": [{
            "name": "gwork_probe_node",
            "entityType": "test",
            "observations": ["connector usage e2e probe", "created by mcp_call_live"]
        }]
    });
    match mcp.call_tool("memory", "create_entities", write).await {
        Ok(r) => println!("CALL create_entities: isError={} text={}", r.is_error,
            r.text.chars().take(200).collect::<String>()),
        Err(e) => println!("CALL create_entities ERR: {:#}", e),
    }

    // 2) read back via read_graph — round-trip proves real execution, not echo
    match mcp.call_tool("memory", "read_graph", serde_json::json!({})).await {
        Ok(r) => {
            let hit = r.text.contains("gwork_probe_node");
            println!("CALL read_graph: isError={} round_trip_hit={}", r.is_error, hit);
            println!("  text: {}", r.text.chars().take(300).collect::<String>());
        }
        Err(e) => println!("CALL read_graph ERR: {:#}", e),
    }

    // 3) search_nodes with args — proves argument passing works
    match mcp.call_tool("memory", "search_nodes", serde_json::json!({"query": "gwork_probe"})).await {
        Ok(r) => println!("CALL search_nodes: isError={} hit={}", r.is_error, r.text.contains("gwork_probe_node")),
        Err(e) => println!("CALL search_nodes ERR: {:#}", e),
    }

    mcp.shutdown().await;
    println!("DONE");
}