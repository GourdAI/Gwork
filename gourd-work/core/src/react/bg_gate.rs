//! Background task notice center and end-of-turn gate (Java `BackgroundNoticeCenter`
//! + `ReasonTask` bgGate, aligned 2026-10-31).
//!
//! Two cooperating halves:
//!
//! 1. **Notices** — background work (bash `run_in_background=true`, sub-agents
//!    submitted with `background=true`) publishes a completion notice to the
//!    session that started it; the react loop drains them into the message
//!    list at the top of the next reasoning turn. This turns "the model must
//!    poll bash_output" into "the kernel tells the model", saving a full LLM
//!    round-trip per poll (Java's original motivation).
//!
//! 2. **The gate** — a text-only END while background tasks are *still running*
//!    is a false promise: once the turn ends there is no executor to consume
//!    the completion notices, so "I'll get notified and continue" can never
//!    happen. The gate defers such an END (≤ [`MAX_BG_GATE_DEFERRALS`]) and
//!    injects a check prompt; the model either verifies on the spot
//!    (`bash_output` / `await_tasks`) or honestly tells the user what is still
//!    running. Java wires this at three model-driven END points (implicit /
//!    explicit Finish / fallback); this kernel has exactly one text-answer END,
//!    so one interception covers the contract.
//!
//! Ownership: the owner key is the session id of the run that *started* the
//! background work. Sub-agent runs have their own session ids, so a
//! sub-agent's background tasks report back to the sub-agent, not to its
//! parent — same isolation as Java's per-run-instance owner keys.
//!
//! Java's TTL/owner-bucket eviction is deliberately not ported: these maps are
//! keyed by session id and cleaned when a session is deleted
//! ([`discard`]); the Rust session store has no LRU reload path that could
//! orphan an owner the way Java's `LruSessionCache` can.

use std::collections::{HashMap, VecDeque};
use tokio::sync::Mutex;

/// How many times the gate may re-judge a text-only END as "keep going"
/// (Java `MAX_BG_GATE_DEFERRALS`).
///
/// One check is enough to correct a "started it, so I'm done" misjudgement;
/// if the model still insists on plain text twice, it has genuinely accounted
/// for its background work (or there is truly nothing actionable) and its
/// reply is respected. Uncapped, the gate becomes its own dead loop — the
/// model wants to stop but never can.
pub const MAX_BG_GATE_DEFERRALS: u32 = 2;

/// Per-owner notice backlog cap (Java `MAX_NOTICES_PER_OWNER`): overflow drops
/// the oldest. A session abandoned with the window closed must not grow this
/// without bound.
const MAX_NOTICES_PER_OWNER: usize = 32;

struct Center {
    /// taskKey (bash bg-xxx session / sub-agent task-N token) → owner session id.
    running: HashMap<String, String>,
    /// owner → pending notices.
    notices: HashMap<String, VecDeque<String>>,
}

static CENTER: once_cell::sync::Lazy<Mutex<Center>> = once_cell::sync::Lazy::new(|| {
    Mutex::new(Center {
        running: HashMap::new(),
        notices: HashMap::new(),
    })
});

/// Register a running background task. Must be called *before* the task can
/// possibly finish (Java documents the same ordering hazard): a task that
/// completes inside the yield window would otherwise unregister first, and
/// this late registration would linger as a phantom "running" entry — and a
/// gate that never opens again.
pub async fn register_running(owner: &str, task_key: &str) {
    if owner.is_empty() || task_key.is_empty() {
        return;
    }
    CENTER.lock().await.running.insert(task_key.to_string(), owner.to_string());
}

/// Unregister a background task (completion callback; idempotent by key).
pub async fn unregister_running(task_key: &str) {
    if !task_key.is_empty() {
        CENTER.lock().await.running.remove(task_key);
    }
}

/// Whether any background task started by this session is still running, and
/// how many (Java `hasRunning` / `runningCount`, fused because the Rust call
/// sites always want both).
pub async fn running_count(owner: &str) -> usize {
    if owner.is_empty() {
        return 0;
    }
    CENTER.lock().await.running.values().filter(|o| *o == owner).count()
}

/// Publish a completion notice (rendered text) to the owner's queue.
pub async fn publish(owner: &str, text: String) {
    if owner.is_empty() || text.is_empty() {
        return;
    }
    let mut c = CENTER.lock().await;
    let q = c.notices.entry(owner.to_string()).or_default();
    q.push_back(text);
    while q.len() > MAX_NOTICES_PER_OWNER {
        q.pop_front();
    }
}

/// Take and clear all pending notices for the owner, in publish order.
pub async fn drain(owner: &str) -> Vec<String> {
    if owner.is_empty() {
        return Vec::new();
    }
    let mut c = CENTER.lock().await;
    match c.notices.remove(owner) {
        Some(q) if !q.is_empty() => q.into_iter().collect(),
        _ => Vec::new(),
    }
}

/// Drop every trace of a session (session deletion path). Notices and running
/// entries alike: after deletion nobody will ever drain them.
pub async fn discard(owner: &str) {
    if owner.is_empty() {
        return;
    }
    let mut c = CENTER.lock().await;
    c.notices.remove(owner);
    c.running.retain(|_, o| *o != owner);
}

/// Gate-check prompt, injected when a text-only END is deferred. Wording kept
/// identical to Java `backgroundGatePromptFor` (this exact text has been seen
/// to change model behaviour; the two-exit structure — verify now, or account
/// honestly and stop — must be preserved verbatim).
pub fn background_gate_prompt(deferred: u32, running_count: usize) -> String {
    format!(
        "【系统提示：后台任务收尾校验 (Background Task Gate)】\n\
         检测到您准备结束回合，但本会话仍有 {} 个运行中的后台任务（bash 后台命令或后台子代理）。\n\
         回合一旦结束就没有执行体能消费它们的完成通知，「结束后会自动收到通知并继续」这类承诺无法兑现。请二选一：\n\
         1. **当场核实**：用 bash_output / await_tasks 查询后台任务状态与结果，拿到结论后再决定是否结束；\n\
         2. **如实交代后结束**：在最终回答中明确告知用户哪些后台任务仍在运行、用户下一步应如何让你继续（如发送「继续」），不得暗示你会自动跟进。\n\
         （第 {}/{} 次校验，之后将按普通最终回答处理）",
        running_count, deferred, MAX_BG_GATE_DEFERRALS
    )
}

/// Render a bash background completion notice (Java `Notice.renderBash`,
/// compact by design: this text is re-sent with the history every turn).
pub fn render_bash_notice(session_id: &str, command: &str, exit_code: i32, tail: &str) -> String {
    let status = if exit_code == -1 { "unknown" } else { "finished" };
    let mut s = format!(
        "[后台任务完成] session_id={} status={} exit_code={}\ncommand: {}\n",
        session_id, status, exit_code, command
    );
    if tail.is_empty() {
        s.push_str("(无输出)\n");
    } else {
        s.push_str("tail output:\n");
        s.push_str(tail);
        if !tail.ends_with('\n') {
            s.push('\n');
        }
    }
    s.push_str("如需完整输出，可用 bash_output 查询该 session_id。");
    s
}

/// Render a sub-agent completion notice (Java `Notice.renderSubagent`).
/// `summary` must already be truncated by the caller.
pub fn render_subagent_notice(
    token: &str,
    index: Option<usize>,
    agent_name: &str,
    description: &str,
    success: bool,
    summary: &str,
) -> String {
    let mut s = format!(
        "[后台子代理完成] token={}{} agent_name={} status={}\n",
        token,
        index.map(|i| format!(" index={}", i)).unwrap_or_default(),
        agent_name,
        if success { "finished" } else { "failed" }
    );
    if !description.is_empty() {
        s.push_str(&format!("description: {}\n", description));
    }
    if summary.is_empty() {
        s.push_str("(无结果内容)\n");
    } else {
        s.push_str("result:\n");
        s.push_str(summary);
        if !summary.ends_with('\n') {
            s.push('\n');
        }
    }
    s.push_str("如需完整结果，可用 await_tasks 传入该 token 收取；无需轮询。");
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner(tag: &str) -> String {
        format!("owner-{}", tag)
    }

    /// Register/unregister must pair idempotently: a duplicate unregister
    /// cannot drive a count negative (or the gate would see a phantom task
    /// forever — Java documents the same hazard for count-based designs).
    #[tokio::test]
    async fn running_registration_pairs_idempotently() {
        let o = owner("pair");
        register_running(&o, "k1").await;
        register_running(&o, "k1").await; // duplicate register: same key, still one task
        assert_eq!(running_count(&o).await, 1);
        unregister_running("k1").await;
        unregister_running("k1").await; // duplicate unregister: no drift
        assert_eq!(running_count(&o).await, 0);
    }

    /// Ownership isolation: session A's tasks must not arm session B's gate.
    #[tokio::test]
    async fn running_count_is_owner_scoped() {
        let a = owner("a");
        let b = owner("b");
        register_running(&a, "ka").await;
        register_running(&b, "kb").await;
        assert_eq!(running_count(&a).await, 1);
        assert_eq!(running_count(&b).await, 1);
        unregister_running("ka").await;
        assert_eq!(running_count(&a).await, 0);
        assert_eq!(running_count(&b).await, 1, "B must be unaffected by A's completion");
        unregister_running("kb").await;
    }

    /// Notices drain in publish order and only once.
    #[tokio::test]
    async fn notices_drain_once_in_order() {
        let o = owner("drain");
        publish(&o, "n1".into()).await;
        publish(&o, "n2".into()).await;
        let got = drain(&o).await;
        assert_eq!(got, vec!["n1".to_string(), "n2".to_string()]);
        assert!(drain(&o).await.is_empty(), "second drain must be empty");
    }

    /// Overflow drops the oldest, keeping the most recent completions.
    #[tokio::test]
    async fn notice_backlog_is_capped() {
        let o = owner("cap");
        for i in 0..(MAX_NOTICES_PER_OWNER + 5) {
            publish(&o, format!("n{}", i)).await;
        }
        let got = drain(&o).await;
        assert_eq!(got.len(), MAX_NOTICES_PER_OWNER);
        assert_eq!(got[0], format!("n{}", 5), "oldest dropped");
        assert_eq!(got[got.len() - 1], format!("n{}", MAX_NOTICES_PER_OWNER + 4));
    }

    /// discard removes both notices and running entries for the session.
    #[tokio::test]
    async fn discard_clears_everything_for_the_owner() {
        let o = owner("discard");
        register_running(&o, "k").await;
        publish(&o, "n".into()).await;
        discard(&o).await;
        assert_eq!(running_count(&o).await, 0);
        assert!(drain(&o).await.is_empty());
    }

    /// The gate prompt must keep the two-exit structure and the counter.
    #[test]
    fn gate_prompt_offers_both_exits_and_counts() {
        let p = background_gate_prompt(1, 2);
        assert!(p.contains("2 个运行中的后台任务"));
        assert!(p.contains("当场核实"));
        assert!(p.contains("如实交代后结束"));
        assert!(p.contains("1/2"), "must show the deferral counter");
    }

    /// Bash/sub-agent notices must point at the right follow-up tool.
    #[test]
    fn notice_renderers_point_at_the_right_tool() {
        let bash = render_bash_notice("bg-1", "cargo test", 0, "ok");
        assert!(bash.contains("session_id=bg-1"));
        assert!(bash.contains("bash_output"));
        let sub = render_subagent_notice("task-1", Some(2), "explore", "scan", true, "found 3");
        assert!(sub.contains("token=task-1"));
        assert!(sub.contains("index=2"));
        assert!(sub.contains("await_tasks"));
    }
}
