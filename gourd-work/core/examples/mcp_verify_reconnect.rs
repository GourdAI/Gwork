//! MANUAL probe: stdio auto-reconnect after the server process dies.
//!
//! Usage:
//!   cargo run -p gourd-work-core --example mcp_verify_reconnect -- <node> <mock.js> <spawn-log>
//!
//! Ground truth is the spawn log line count (how many child processes the kernel
//! actually started), not the tool reply text: a reply alone cannot distinguish
//! "we rebuilt the connection" from "the old one somehow still worked".

use std::path::PathBuf;
use std::sync::Arc;

use gourd_work_core::config::{ModelConfig, PermissionSettings, Settings};
use gourd_work_core::mcp::{McpManager, McpServerConfig};
use serde_json::json;
use tokio_util::sync::CancellationToken;

static mut PASS: u32 = 0;
static mut FAIL: u32 = 0;

fn ctx() -> gourd_work_core::tools::registry::ToolContext {
    gourd_work_core::tools::registry::ToolContext {
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
    println!("[{}] {:<48} {}", if ok { "PASS" } else { "FAIL" }, label, detail);
}

/// How many child processes the kernel has spawned for this mock.
fn spawns(log: &str) -> usize {
    std::fs::read_to_string(log).map(|s| s.lines().filter(|l| l.contains("spawn")).count()).unwrap_or(0)
}

fn stdio_cfg(node: &str, mock: &str, spawn_log: &str, extra_env: &[(&str, &str)]) -> McpServerConfig {
    let mut env = std::collections::HashMap::new();
    // The mock only records spawns when it is TOLD where to log. Forgetting this
    // makes every spawn-count assertion read an empty file and pass vacuously,
    // which is how a broken harness looks identical to a working fix.
    env.insert("MOCK_SPAWN_LOG".to_string(), spawn_log.to_string());
    for (k, v) in extra_env { env.insert(k.to_string(), v.to_string()); }
    McpServerConfig {
        kind: "stdio".into(), enabled: true, command: node.to_string(),
        args: vec![mock.to_string()], env, timeout: "8s".into(), ..Default::default()
    }
}

#[tokio::main]
async fn main() {
    let node = std::env::args().nth(1).expect("node path");
    let mock = std::env::args().nth(2).expect("mock js path");
    let spawn_log = std::env::args().nth(3).expect("spawn log path");
    let _ = ctx();
    let _ = PermissionSettings::default();

    let _ = std::fs::remove_file(&spawn_log);
    let mcp = Arc::new(McpManager::new());

    // ── 1. connect and confirm the baseline works ──────────────────────────
    mcp.connect_one("r", &stdio_cfg(&node, &mock, &spawn_log, &[("MOCK_NAME", "r")])).await
        .expect("initial connect must succeed");
    check("#8 connect succeeded", spawns(&spawn_log) == 1, format!("spawns={}", spawns(&spawn_log)));

    let r = mcp.call_tool("r", "echo_ok", json!({"message":"before"})).await;
    let r_text = r.as_ref().map(|x| x.text.clone()).unwrap_or_else(|e| format!("<err {}>", e));
    check("#8 call works before the crash", r_text.contains("echo: before"),
        format!("{:?}", r_text));
    check("#8 reply identifies the live process", r_text.contains("#1"),
        format!("text mentions #1 => {:?}", r_text));

    let h = mcp.health_of("r").await;
    check("#8 health says connected", h.is_connected() && h.tools == 3,
        format!("state={} tools={} reconnects={}", h.state, h.tools, h.reconnects));

    // ── 2. kill the server process (no reply, EOF on stdout) ───────────────
    let dead = mcp.call_tool("r", "kill_self", json!({})).await;
    println!("    kill_self result: {:?}", dead.as_ref().map(|x| x.text.clone()).map_err(|e| e.to_string()));
    // The mid-call death must NOT be auto-retried: `tools/call` has no
    // idempotency guarantee, so re-sending could double-execute a side effect.
    check("#8 mid-call death is reported, not silently retried", dead.is_err(),
        format!("err={:?}", dead.as_ref().err().map(|e| e.to_string())));
    check("#8 error says the connection was rebuilt",
        dead.as_ref().err().map(|e| e.to_string().contains("re-established")).unwrap_or(false),
        "message must tell the caller the session is healthy again".to_string());
    check("#8 error warns against blind retry",
        dead.as_ref().err().map(|e| e.to_string().contains("NOT retried")).unwrap_or(false),
        "message must state the call was not retried".to_string());
    // Rebuilding the connection is what makes the next call work, so a respawn
    // must have happened.
    check("#8 crash triggered a respawn", spawns(&spawn_log) >= 2,
        format!("spawns={} after kill_self", spawns(&spawn_log)));

    // ── 3. the next call must self-heal, not fail forever ──────────────────
    // This is the actual regression being fixed: before auto-reconnect the
    // connection was dropped and every later call failed with "not connected"
    // for the rest of the session.
    let after = mcp.call_tool("r", "echo_ok", json!({"message":"after"})).await;
    let after_text = after.as_ref().map(|x| x.text.clone()).unwrap_or_else(|e| format!("<err {}>", e));
    check("#8 call recovers after crash", after_text.contains("echo: after"),
        format!("{:?}", after_text));

    let h = mcp.health_of("r").await;
    check("#8 health records the reconnect", h.is_connected() && h.reconnects >= 1,
        format!("state={} reconnects={} attempts={}", h.state, h.reconnects, h.reconnect_attempts));

    let which = mcp.call_tool("r", "which_spawn", json!({})).await;
    let gen = which.map(|x| x.text.trim().to_string()).unwrap_or_default();
    check("#8 running in a NEW process, not the old one",
        gen.parse::<usize>().unwrap_or(1) >= 2,
        format!("current process spawn index = {:?}", gen));

    // ── 4. repeated crashes must not grow without bound ────────────────────
    let before = spawns(&spawn_log);
    for _ in 0..3 {
        let _ = mcp.call_tool("r", "kill_self", json!({})).await;
    }
    let growth = spawns(&spawn_log).saturating_sub(before);
    check("#8 each crash costs bounded respawns", growth <= 8,
        format!("3 crashes caused {} extra spawns (cap 8; unbounded loop would be far more)", growth));

    // ── 5. forget_server must prevent resurrection ─────────────────────────
    // The user disabled/removed the server; a queued call must not bring it back.
    mcp.forget_server("r").await;
    let h = mcp.health_of("r").await;
    check("#8 forget clears health to disconnected", !h.is_connected() && h.tools == 0,
        format!("state={} tools={}", h.state, h.tools));
    let gone = mcp.call_tool("r", "echo_ok", json!({"message":"x"})).await;
    check("#8 forgotten server is NOT resurrected", gone.is_err(),
        format!("{:?}", gone.map(|x| x.text)));
    check("#8 no respawn after forget", spawns(&spawn_log) == before + growth,
        format!("spawns still {}", spawns(&spawn_log)));

    // ── 6. a permanently-broken server reports a usable reason ─────────────
    // Separate spawn log: MAX_SPAWNS counts lines in the log the mock is given,
    // so sharing the main log (already full of "r" spawns) would make even the
    // first "bad" spawn exceed the limit and fail for the wrong reason.
    let bad_log = format!("{}.bad", spawn_log);
    let _ = std::fs::remove_file(&bad_log);
    let bad = mcp.connect_one("bad", &stdio_cfg(&node, &mock, &bad_log, &[("MOCK_NAME", "bad"), ("MOCK_MAX_SPAWNS", "1")])).await;
    // Spawn #1 is allowed (index <= MAX_SPAWNS), so this connects. Killing it
    // forces a respawn; spawn #2 exits(1) immediately, so the rebuild fails and
    // health must record a reason rather than silently looking connected.
    check("#8 broken server connects on first spawn", bad.is_ok(),
        format!("bad={:?}", bad));
    if bad.is_ok() {
        let _ = mcp.call_tool("bad", "kill_self", json!({})).await;
        // This call triggers a rebuild attempt, which must fail (spawn #2 dies).
        let rec = mcp.call_tool("bad", "echo_ok", json!({"message":"y"})).await;
        println!("    bad echo after kill: {:?}", rec.as_ref().err().map(|e| e.to_string()));
    }
    let hb = mcp.health_of("bad").await;
    println!("    bad server health: {:?}", hb);
    check("#8 broken server surfaces a failure reason",
        hb.state == "failed" && !hb.last_error.is_empty(),
        format!("state={} last_error={:?}", hb.state, hb.last_error));

    mcp.shutdown().await;
    let (p, f) = unsafe { (PASS, FAIL) };
    println!("\n=== {} passed, {} failed ===", p, f);
    std::process::exit(if f == 0 { 0 } else { 1 });
}
