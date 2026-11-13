//! MANUAL regression probe for the MCP fixes (batch 1).
//! Run: cargo run -p gourd-work-core --example mcp_verify -- <mock_stdio.js>

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use gourd_work_core::config::{ModelConfig, PermissionSettings, Settings};
use gourd_work_core::mcp::{McpManager, McpServerConfig};
use gourd_work_core::tools::registry::{ToolContext, ToolGate, ToolRegistry};
use serde_json::json;
use tokio_util::sync::CancellationToken;

static mut PASS: u32 = 0;
static mut FAIL: u32 = 0;

fn ctx(gate: Option<Arc<ToolGate>>) -> ToolContext {
    ToolContext {
        workspace: PathBuf::from("."), session_dir: None, session_id: "v".into(),
        tool_call_id: "c".into(), run_id: "r".into(), frame_tx: None,
        access_mode: "full".into(), cancel: CancellationToken::new(), hitl_approved: false,
        change_ledger: None, gate, subagent_depth: 0, root_session_id: "v".into(),
        thinking: None, model: Arc::new(ModelConfig::default()),
        settings: Arc::new(Settings::default()), bash_exempt_dirs: Vec::new(),
    }
}

fn cfg(script: &str, name: &str) -> McpServerConfig {
    let mut env = HashMap::new();
    env.insert("MOCK_NAME".to_string(), name.to_string());
    McpServerConfig { kind: "stdio".into(), enabled: true, command: "node".into(),
        args: vec![script.to_string()], env, ..Default::default() }
}

fn check(label: &str, ok: bool, detail: String) {
    unsafe { if ok { PASS += 1 } else { FAIL += 1 } }
    println!("[{}] {:<44} {}", if ok { "PASS" } else { "FAIL" }, label, detail);
}

#[tokio::main]
async fn main() {
    let raw = std::env::args().nth(1).expect("usage: mcp_verify <mock_stdio.js>");
    let script = if PathBuf::from(&raw).is_absolute() { raw } else {
        std::env::current_dir().unwrap().join(&raw).to_string_lossy().to_string() };

    let mcp = Arc::new(McpManager::new());
    let reg = Arc::new(ToolRegistry::default_registry().with_mcp(mcp.clone()));
    let perm = PermissionSettings::default();

    // ── #4 namespace: names are mcp__<server>__<tool>, unique across servers ──
    let mut a = cfg(&script, "alpha");
    a.env.insert("MOCK_DUP".into(), "1".into());
    let mut b = cfg(&script, "beta");
    b.env.insert("MOCK_DUP".into(), "1".into());
    mcp.connect_one("alpha", &a).await.unwrap();
    mcp.connect_one("beta", &b).await.unwrap();

    let defs = reg.definitions_async(&perm, None).await;
    let names: Vec<String> = defs.iter().map(|d| d.function.name.clone()).collect();
    let has_ns = names.iter().any(|n| n == "mcp__alpha__echo_ok");
    check("#4 namespaced name advertised", has_ns, format!("mcp__alpha__echo_ok present={}", has_ns));

    let dup = names.iter().filter(|n| n.ends_with("dup_marker")).count();
    let unique_total = { let mut v = names.clone(); v.sort(); v.dedup(); v.len() };
    check("#4 no duplicate names in tools[]", dup == 2 && unique_total == names.len(),
        format!("dup_marker x{} (one per server), total {} unique {}", dup, names.len(), unique_total));

    // Collision: `read` exists both as a built-in and as an MCP tool on the mock
    // server. The bare name must remain the built-in (exactly one entry), and the
    // MCP one must appear under its own namespaced id.
    let bare_reads = names.iter().filter(|n| *n == "read").count();
    let mcp_read = names.iter().any(|n| n == "mcp__alpha__read");
    check("#4 builtin `read` not shadowed/duplicated", bare_reads == 1 && mcp_read,
        format!("bare `read` count={} (builtin), mcp__alpha__read present={}", bare_reads, mcp_read));
    // Calling the bare name must hit the built-in (reads a real file), not MCP.
    let o = reg.execute("read", json!({"file_path": "README.md"}), &ctx(None)).await;
    let hit_builtin = !o.text.contains("MCP read shadow");
    check("#4 bare `read` resolves to the built-in", hit_builtin,
        format!("reached MCP shadow={}", !hit_builtin));
    // And the namespaced one reaches the MCP server.
    let o = reg.execute("mcp__alpha__read", json!({}), &ctx(None)).await;
    check("#4 namespaced `mcp__alpha__read` reaches MCP", o.text.contains("MCP read shadow"),
        format!("{:?}", o.text));

    // calling the namespaced name reaches the right server
    let o = reg.execute("mcp__alpha__echo_ok", json!({"message":"ns"}), &ctx(None)).await;
    check("#4 namespaced call routes correctly", o.text.contains("[alpha] echo: ns"), format!("{:?}", o.text));
    let o = reg.execute("mcp__beta__echo_ok", json!({"message":"ns"}), &ctx(None)).await;
    check("#4 second server reachable", o.text.contains("[beta] echo: ns"), format!("{:?}", o.text));
    let o = reg.execute("echo_ok", json!({"message":"raw"}), &ctx(None)).await;
    check("#4 raw-name fallback still works", o.text.contains("echo: raw"), format!("{:?}", o.text));

    // ── #1 per-server disallowedTools ──────────────────────────────────────
    let mut a2 = cfg(&script, "alpha");
    a2.disallowed_tools = vec!["banned_tool".into()];
    mcp.connect_one("alpha", &a2).await.unwrap();
    let defs = reg.definitions_async(&perm, None).await;
    let advertised = defs.iter().any(|d| d.function.name == "mcp__alpha__banned_tool");
    let o = reg.execute("mcp__alpha__banned_tool", json!({}), &ctx(None)).await;
    check("#1 unchecked tool hidden from model", !advertised, format!("advertised={}", advertised));
    check("#1 unchecked tool refused on execute", o.is_error, format!("is_error={} text={:?}", o.is_error, o.text));

    // re-enabling works: the tool comes back (proves it was flagged, not dropped)
    let tools = mcp.tools_of("alpha").await;
    let still_listed = tools.iter().any(|t| t.name == "banned_tool");
    let flagged_off = tools.iter().find(|t| t.name == "banned_tool").map(|t| !t.enabled).unwrap_or(false);
    check("#1 panel can still list disabled tool", still_listed && flagged_off,
        format!("listed={} enabled=false {}", still_listed, flagged_off));

    mcp.connect_one("alpha", &a).await.unwrap(); // restore
    let o = reg.execute("mcp__alpha__banned_tool", json!({}), &ctx(None)).await;
    check("#1 re-enable restores the tool", !o.is_error, format!("{:?}", o.text));

    // ── #2 isError ────────────────────────────────────────────────────────
    let o = reg.execute("mcp__alpha__fail_tool", json!({}), &ctx(None)).await;
    check("#2 isError -> tool failure", o.is_error && o.text.contains("upstream 500"),
        format!("is_error={} text={:?}", o.is_error, o.text));

    // ── #3 non-text content ───────────────────────────────────────────────
    let o = reg.execute("mcp__alpha__image_tool", json!({}), &ctx(None)).await;
    check("#3 image -> vision channel", o.image_urls.len() == 1 && o.image_urls[0].starts_with("data:image/png;base64,"),
        format!("images={} text={:?}", o.image_urls.len(), o.text));
    let o = reg.execute("mcp__alpha__audio_tool", json!({}), &ctx(None)).await;
    check("#3 audio -> typed placeholder, not empty", !o.text.trim().is_empty() && o.text.contains("audio"),
        format!("text={:?}", o.text));

    // ── #5 timeout honoured ───────────────────────────────────────────────
    let mut t = cfg(&script, "slow");
    t.timeout = "2s".into();
    mcp.connect_one("slow", &t).await.unwrap();
    let t0 = Instant::now();
    let o = reg.execute("mcp__slow__slow_tool", json!({"ms": 20000}), &ctx(None)).await;
    let el = t0.elapsed();
    check("#5 timeout:'2s' honoured on stdio", o.is_error && el.as_secs() < 6,
        format!("waited {:?} (was 10s hardcoded) is_error={}", el, o.is_error));

    // ── #5b no cross-call poisoning after a timeout ───────────────────────
    let t1 = Instant::now();
    let o2 = reg.execute("mcp__slow__echo_ok", json!({"message":"after"}), &ctx(None)).await;
    check("#5 stale reply not returned as this call's result",
        !o2.text.contains("slept"), format!("{:?} in {:?}", o2.text, t1.elapsed()));
    // and a reconnect makes it work again
    mcp.connect_one("slow", &t).await.unwrap();
    let o3 = reg.execute("mcp__slow__echo_ok", json!({"message":"fresh"}), &ctx(None)).await;
    check("#5 reconnect restores the server", o3.text.contains("echo: fresh"), format!("{:?}", o3.text));

    // ── #6 global disallowedTools hides MCP tools ─────────────────────────
    let mut p2 = PermissionSettings::default();
    p2.disallowed_tools = vec!["echo_ok".into()];
    let defs = reg.definitions_async(&p2, None).await;
    let hidden = !defs.iter().any(|d| d.function.name == "mcp__alpha__echo_ok");
    let gate = Arc::new(ToolGate::from_permission(&p2));
    let o = reg.execute("mcp__alpha__echo_ok", json!({"message":"x"}), &ctx(Some(gate))).await;
    check("#6 global disallowedTools hides + blocks", hidden && o.is_error,
        format!("hidden={} is_error={}", hidden, o.is_error));
    // other MCP tools unaffected (no over-blocking)
    let still = defs.iter().any(|d| d.function.name == "mcp__alpha__image_tool");
    check("#6 only the named tool is hidden", still, format!("image_tool still advertised={}", still));

    // ── sub-agent gate ────────────────────────────────────────────────────
    let g = Arc::new(ToolGate { allowed: Some(["read".into()].into_iter().collect()),
        disallowed: Default::default(), mcp_allowed: false });
    let defs = reg.definitions_async(&perm, Some(&g)).await;
    let leaked: Vec<&str> = defs.iter().filter(|d| d.function.name.starts_with("mcp__")).map(|d| d.function.name.as_str()).collect();
    let o = reg.execute("mcp__alpha__echo_ok", json!({"message":"x"}), &ctx(Some(g))).await;
    check("sub-agent mcp_allowed=false enforced", leaked.is_empty() && o.is_error,
        format!("leaked={:?} is_error={}", leaked, o.is_error));

    mcp.shutdown().await;
    let (p, f) = unsafe { (PASS, FAIL) };
    println!("\n=== {} passed, {} failed ===", p, f);
    std::process::exit(if f == 0 { 0 } else { 1 });
}
