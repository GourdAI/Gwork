//! MANUAL probe: protocol version negotiation + MCP-Protocol-Version header.
//! Usage: cargo run -p gourd-work-core --example mcp_verify_proto -- <url> [forced-server-version]

use std::path::PathBuf;
use std::sync::Arc;

use gourd_work_core::config::{ModelConfig, PermissionSettings, Settings};
use gourd_work_core::mcp::{McpManager, McpServerConfig, PROTOCOL_VERSION};
use gourd_work_core::tools::registry::{ToolContext, ToolRegistry};
use serde_json::json;
use tokio_util::sync::CancellationToken;

static mut PASS: u32 = 0;
static mut FAIL: u32 = 0;

fn ctx() -> ToolContext {
    ToolContext {
        workspace: PathBuf::from("."), session_dir: None, session_id: "p".into(),
        tool_call_id: "c".into(), run_id: "r".into(), frame_tx: None,
        access_mode: "full".into(), cancel: CancellationToken::new(), hitl_approved: false,
        change_ledger: None, gate: None, subagent_depth: 0, root_session_id: "p".into(),
        thinking: None, model: Arc::new(ModelConfig::default()),
        settings: Arc::new(Settings::default()), bash_exempt_dirs: Vec::new(),
    }
}

fn check(label: &str, ok: bool, detail: String) {
    unsafe { if ok { PASS += 1 } else { FAIL += 1 } }
    println!("[{}] {:<46} {}", if ok { "PASS" } else { "FAIL" }, label, detail);
}

fn http_cfg(url: &str) -> McpServerConfig {
    McpServerConfig { kind: "streamable".into(), enabled: true, url: url.to_string(), ..Default::default() }
}

#[tokio::main]
async fn main() {
    let url = std::env::args().nth(1).expect("usage: mcp_verify_proto <url>");
    let mcp = Arc::new(McpManager::new());
    let reg = Arc::new(ToolRegistry::default_registry().with_mcp(mcp.clone()));
    let perm = PermissionSettings::default();

    check("#7 declared version is the stateful one", PROTOCOL_VERSION == "2025-11-25",
        format!("PROTOCOL_VERSION={}", PROTOCOL_VERSION));

    // ── connect against a server that echoes our requested version ─────────
    mcp.connect_one("h", &http_cfg(&url)).await.expect("connect must succeed");
    let out = reg.execute("mcp__h__http_report", json!({}), &ctx()).await;
    let seen: Vec<serde_json::Value> = serde_json::from_str(&out.text).unwrap_or_default();
    check("connect + call works over HTTP", !seen.is_empty(), format!("{} requests observed", seen.len()));

    // The initialize POST must NOT carry the header (nothing negotiated yet);
    // every request AFTER it MUST.
    let first = &seen[0];
    let rest = &seen[1..];
    check("#7 header absent on initialize itself", first["protocol"].is_null(),
        format!("initialize carried protocol={:?}", first["protocol"]));
    let all_have = rest.iter().all(|r| r["protocol"] == json!(PROTOCOL_VERSION));
    check("#7 header on ALL subsequent requests", all_have && !rest.is_empty(),
        format!("{} later requests, versions={:?}", rest.len(),
            rest.iter().map(|r| r["protocol"].clone()).collect::<Vec<_>>()));

    let sid_ok = rest.iter().all(|r| r["session"] == json!("sess-fixed-1"));
    check("#7 session id still echoed", sid_ok,
        format!("sessions={:?}", rest.iter().map(|r| r["session"].clone()).collect::<Vec<_>>()));

    // ── server downgrades to an older supported version ────────────────────
    let mut cfg = http_cfg(&url);
    cfg.headers.insert("X-Note".into(), "downgrade".into());
    // The mock forces its answer via MOCK_PROTO; here we only assert our client
    // accepts an older version it supports (unit-tested separately).
    check("#7 older supported version accepted",
        gourd_work_core::mcp::negotiate_protocol_version("2024-11-05").as_deref() == Some("2024-11-05"),
        "2024-11-05 is in our supported list".into());
    check("#7 unsupported version rejected",
        gourd_work_core::mcp::negotiate_protocol_version("2026-07-28").is_none(),
        "stateless era must be refused, not silently used".into());
    check("#7 unstated version falls back to ours",
        gourd_work_core::mcp::negotiate_protocol_version("").as_deref() == Some(PROTOCOL_VERSION),
        "empty -> own version".into());

    // ── common-version selection from a server's `supported` list ──────────
    let common = gourd_work_core::mcp::pick_common_version(&[
        "2026-07-28".to_string(), "2025-03-26".to_string(), "2024-11-05".to_string(),
    ]);
    check("#7 picks newest common version", common.as_deref() == Some("2025-03-26"),
        format!("server offered [2026-07-28, 2025-03-26, 2024-11-05] -> {:?}", common));
    check("#7 no common version -> None",
        gourd_work_core::mcp::pick_common_version(&["2026-07-28".into()]).is_none(),
        "stateless-only server must not be used".into());

    // ── a tool call still returns correct data ────────────────────────────
    let out = reg.execute("mcp__h__http_echo", json!({"message":"proto"}), &ctx()).await;
    check("#7 tool payload intact after negotiation", out.text.contains("http echo: proto"),
        format!("{:?}", out.text));

    let _ = &cfg;
    mcp.shutdown().await;
    let (p, f) = unsafe { (PASS, FAIL) };
    println!("\n=== {} passed, {} failed ===", p, f);
    std::process::exit(if f == 0 { 0 } else { 1 });
}
