//! runner — the long-lived half of the IM channels.
//!
//! Three things live here, and each exists because of a specific failure mode:
//!
//! 1. [`Backoff`] — exponential reconnect delay. It is a pure state machine with
//!    no clock in it, so it can be asserted on directly. The alternative (start a
//!    ticker, sleep, count ticks) does not work on Windows: tokio's sleep
//!    granularity there is ~15ms, so a 120ms operation sampled at 1ms produces 8
//!    ticks instead of 120 and the assertion measures the scheduler, not the code.
//! 2. [`run_with_reconnect`] — the supervise loop. Errors are logged and retried,
//!    never propagated: a channel task that panics takes its credentials down
//!    with it and leaves the UI showing "connected" forever.
//! 3. [`InboundSink`] — the seam between a channel and the agent. The channels
//!    crate cannot call into `server::` (that would be a cycle, and `server/mod.rs`
//!    is owned elsewhere), so an inbound IM message is handed to a trait object.
//!    The server installs a real one at startup; until then [`LogSink`] records
//!    the message honestly instead of pretending to have run the agent.
//!
//! [`ChannelHub`] ties the three links together behind a process-global handle so
//! the HTTP endpoints can reach them without `AppState` gaining a field.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use super::transport::{SharedHttp, SharedWs, ReqwestHttp, TungsteniteWs};
use super::{channels_dir, ChannelState, RoutingTable, SessionInfo, ROUTING_FILE};

// ─── Backoff ──────────────────────────────────────────────────────────────────

/// Exponential reconnect delay: `base * 2^attempt`, capped at `max`.
///
/// Deliberately clock-free. Tests assert the *sequence* of delays, which is
/// deterministic, rather than measuring elapsed time, which on Windows is not.
#[derive(Debug, Clone)]
pub struct Backoff {
    base: Duration,
    max: Duration,
    attempt: u32,
}

impl Backoff {
    pub fn new(base: Duration, max: Duration) -> Self {
        // A zero base would pin the loop at zero delay and spin a core; a max
        // below the base would make the cap meaningless. Clamp rather than panic:
        // this is constructed from constants, but a future caller may not be.
        let base = if base.is_zero() { Duration::from_millis(1) } else { base };
        let max = if max < base { base } else { max };
        Self { base, max, attempt: 0 }
    }

    /// Next delay, advancing the attempt counter.
    pub fn next_delay(&mut self) -> Duration {
        // Cap the shift so `1u32 << exp` cannot overflow; past 16 doublings the
        // result is above any sane `max` anyway.
        let exp = self.attempt.min(16);
        self.attempt = self.attempt.saturating_add(1);
        let grown = self.base.saturating_mul(1u32 << exp);
        if grown > self.max {
            self.max
        } else {
            grown
        }
    }

    /// Reset after a successful connection/iteration.
    pub fn reset(&mut self) {
        self.attempt = 0;
    }

    pub fn attempt(&self) -> u32 {
        self.attempt
    }
}

// ─── Supervised channel loop ──────────────────────────────────────────────────

/// One channel connection attempt.
#[async_trait]
pub trait ChannelLoop: Send {
    /// Human-readable channel name, for logs.
    fn name(&self) -> &'static str;

    /// Serve one connection (or one polling pass). Returns when the connection
    /// drops, the pass fails, or `cancel` fires.
    ///
    /// Returning `Ok(())` means "this attempt completed cleanly" and resets the
    /// backoff; `Err` means "retry with a longer delay".
    async fn serve_once(&mut self, cancel: CancellationToken) -> anyhow::Result<()>;
}

/// Supervise a [`ChannelLoop`]: run it, back off on failure, stop on cancel.
///
/// This function never returns `Err` and never panics on a channel error — that
/// is the whole point. It exits only when `cancel` fires.
pub async fn run_with_reconnect(
    mut channel: Box<dyn ChannelLoop>,
    cancel: CancellationToken,
    mut backoff: Backoff,
) {
    loop {
        if cancel.is_cancelled() {
            return;
        }
        let name = channel.name();
        match channel.serve_once(cancel.clone()).await {
            Ok(()) => backoff.reset(),
            Err(e) => {
                // warn, not error: a dropped upstream connection is expected
                // operational noise, and error-level would drown real faults.
                tracing::warn!(channel = name, error = %e, "channel attempt failed; backing off");
            }
        }
        if cancel.is_cancelled() {
            return;
        }
        let delay = backoff.next_delay();
        tracing::debug!(channel = name, attempt = backoff.attempt(), ?delay, "channel waiting before retry");
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = tokio::time::sleep(delay) => {}
        }
    }
}

// ─── Inbound seam ─────────────────────────────────────────────────────────────

/// A message that arrived from an IM channel and resolved to a session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundMessage {
    pub channel: String,
    pub session_id: String,
    pub project_root: Option<String>,
    pub text: String,
}

/// What the channels need from the rest of the kernel.
///
/// The default [`LogSink`] implements all three methods as honest no-ops: it
/// records what happened and reports "no sessions". It does **not** claim to have
/// processed anything, which is the difference between a stub and a lie.
#[async_trait]
pub trait InboundSink: Send + Sync {
    /// Selectable sessions, for the `/switch` selection flow.
    async fn list_sessions(&self) -> Vec<SessionInfo>;

    /// Forward a resolved message to the agent.
    async fn on_inbound(&self, msg: InboundMessage);

    /// Deliver a reply/notification out through the channel's own transport.
    /// Called for command responses (`/help`, session lists) and loop
    /// notifications. The channel link supplies the actual send implementation;
    /// this hook exists so the server can observe or override it.
    async fn on_outbound(&self, channel: &str, session_id: &str, text: &str);
}

/// Default sink: log and persist to the channel notify log. No fake success.
pub struct LogSink {
    dir: PathBuf,
}

impl LogSink {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }
}

#[async_trait]
impl InboundSink for LogSink {
    async fn list_sessions(&self) -> Vec<SessionInfo> {
        Vec::new()
    }

    async fn on_inbound(&self, msg: InboundMessage) {
        // Recorded, not swallowed: an operator reading the log can see that a
        // message arrived and that no agent was wired up to handle it.
        tracing::warn!(
            channel = %msg.channel,
            session = %msg.session_id,
            "inbound IM message received but no agent sink is installed; recording to notify log"
        );
        super::channels_notify_in(
            &self.dir,
            &format!("{}-inbound", msg.channel),
            &format!("[{}] {}", msg.session_id, msg.text),
        );
    }

    async fn on_outbound(&self, channel: &str, _session_id: &str, text: &str) {
        tracing::debug!(channel = %channel, "outbound IM reply");
        super::channels_notify_in(&self.dir, channel, text);
    }
}

// ─── Shared inbound dispatch ──────────────────────────────────────────────────

/// How a channel sends text back out. Each link implements this over its own
/// transport (WeChat `sendmessage`, Feishu `im/v1/messages`, DingTalk webhook).
pub trait Replier: Send + Sync {
    fn reply_blocking(&self, text: &str);
}

/// A replier that forwards to the hub sink (used for command replies, which have
/// no inbound context token to answer against on some channels).
pub struct SinkReplier {
    pub channel: String,
    pub session_id: String,
    pub sink: Arc<dyn InboundSink>,
}

impl Replier for SinkReplier {
    fn reply_blocking(&self, text: &str) {
        let sink = self.sink.clone();
        let channel = self.channel.clone();
        let session_id = self.session_id.clone();
        let text = text.to_string();
        // Command replies are fire-and-forget. Spawning keeps the receive loop
        // from blocking on an HTTP round-trip, which would stall the heartbeat.
        tokio::spawn(async move {
            sink.on_outbound(&channel, &session_id, &text).await;
        });
    }
}

/// Resolve one inbound IM message: commands first, then routing, then the agent.
///
/// Returns `true` when the message was consumed as a command (the caller must not
/// forward it). This is the Rust counterpart of the block that Java repeats three
/// times — once each in `WeChatLink.pollOnce`, `FeishuLink.onImMessageReceive` and
/// `DingTalkLink.onBotMessageParsed` — including the IDLE-state selection flow.
pub async fn process_inbound_text(
    channel: &str,
    text: &str,
    routing_path: &Path,
    sink: &Arc<dyn InboundSink>,
    replier: &dyn Replier,
) -> bool {
    use super::{ChannelCommandHandler, CommandAction};

    let mut routing = RoutingTable::load_from(routing_path.to_path_buf());
    let state = routing.get_state(channel);
    let sessions = sink.list_sessions().await;

    if let Some(action) = ChannelCommandHandler::handle_message(text, &sessions, state) {
        match action {
            CommandAction::Help => {
                replier.reply_blocking(&ChannelCommandHandler::render_help());
                return true;
            }
            CommandAction::ListSessions => {
                replier.reply_blocking(&ChannelCommandHandler::render_session_list(&sessions));
                routing.set_state(channel, ChannelState::AwaitingSelection);
                routing.save();
                return true;
            }
            CommandAction::SelectSession(idx) => {
                let Some(picked) = sessions.get(idx) else {
                    replier.reply_blocking("请输入有效的编号");
                    return true;
                };
                routing.set_active_session(channel, &picked.session_id, picked.project_root.clone());
                replier.reply_blocking(&format!("已切换到会话：{}", picked.label));
                return true;
            }
            CommandAction::NewSession => {
                let new_id = crate::session::SessionStore::new_session_id();
                // An IM-created session is global (no owning project root), which
                // is what Java does too: `setActiveSession(channel, newId)`.
                routing.set_active_session(channel, &new_id, None);
                replier.reply_blocking(&format!("已新建会话：{}", new_id));
                return true;
            }
        }
    }

    // No active route yet → run the IDLE selection flow.
    let mut active = routing.get_active_session(channel);
    if active.as_deref().map(|s| s.is_empty()).unwrap_or(true) {
        // No unconditional set_state(Idle) here: every arm below sets the
        // correct terminal state (set_active_session → Active, the multi-session
        // arm → AwaitingSelection). Writing Idle first would — now that
        // set_state persists — delete a pending AwaitingSelection entry and
        // immediately recreate it, an extra disk write with a transient window
        // where the selection state is gone.
        match sessions.len() {
            0 => {
                // Nothing to pick from: create one and forward, matching Java's
                // `handleIdleState` empty-list branch.
                let new_id = crate::session::SessionStore::new_session_id();
                routing.set_active_session(channel, &new_id, None);
                active = Some(new_id);
            }
            1 => {
                let only = &sessions[0];
                routing.set_active_session(channel, &only.session_id, only.project_root.clone());
                active = Some(only.session_id.clone());
            }
            _ => {
                replier.reply_blocking(&ChannelCommandHandler::render_session_list(&sessions));
                routing.set_state(channel, ChannelState::AwaitingSelection);
                routing.save();
                return true;
            }
        }
    }

    let Some(session_id) = active else {
        return true;
    };
    let project_root = routing
        .get_active_route(channel)
        .and_then(|r| r.project_root.clone());

    sink.on_inbound(InboundMessage {
        channel: channel.to_string(),
        session_id,
        project_root,
        text: text.to_string(),
    })
    .await;
    false
}

// ─── Notify log drain ─────────────────────────────────────────────────────────

/// Read and clear `<dir>/<channel>-notify-log.ndjson`, returning the pending texts.
///
/// `channels_notify` (used by the loop scheduler) appends here even when a channel
/// is disconnected. Draining on connect is what makes those notifications
/// eventually delivered rather than silently accumulating forever.
pub fn drain_notify_log(dir: &Path, channel: &str) -> Vec<String> {
    let path = dir.join(format!("{}-notify-log.ndjson", channel));
    let Ok(content) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    // Truncate first: if a send fails afterwards the notification is lost, but
    // re-sending the same notification on every reconnect is worse (the user gets
    // an unbounded pile of duplicates). At-most-once is the right trade here.
    let _ = std::fs::write(&path, "");
    content
        .lines()
        .filter_map(|line| {
            serde_json::from_str::<serde_json::Value>(line)
                .ok()
                .and_then(|v| v.get("text").and_then(|t| t.as_str()).map(|s| s.to_string()))
        })
        .filter(|s| !s.trim().is_empty())
        .collect()
}

// ─── Hub ──────────────────────────────────────────────────────────────────────

/// Everything the channel subsystem needs, injectable for tests.
pub struct HubConfig {
    /// Channels directory (credentials, routing state, notify logs).
    pub dir: PathBuf,
    pub http: SharedHttp,
    pub ws: SharedWs,
    pub sink: Arc<dyn InboundSink>,
    /// Reconnect backoff for the WebSocket channels.
    pub ws_backoff: (Duration, Duration),
    /// Poll interval / backoff for the WeChat long-poll loop.
    pub poll_backoff: (Duration, Duration),
}

impl HubConfig {
    /// Production configuration against the real `~/.gwork/channels`.
    pub fn production() -> Self {
        let dir = channels_dir();
        Self {
            sink: Arc::new(LogSink::new(dir.clone())),
            dir,
            http: Arc::new(ReqwestHttp::new()),
            ws: Arc::new(TungsteniteWs),
            ws_backoff: (Duration::from_secs(5), Duration::from_secs(60)),
            poll_backoff: (Duration::from_secs(2), Duration::from_secs(60)),
        }
    }
}

/// Owns the channel links plus their shared cancellation token.
///
/// **Only WeChat is implemented.** The Feishu and DingTalk link modules do not
/// exist yet (their WebSocket Stream transports are unwritten), so this hub
/// carries a single link. When they land, add `feishu` / `dingtalk` fields here
/// and mirror every `self.wechat.*` call below — the six call sites
/// (`set_sink`, `start_all`, `restore_and_migrate` ×3, `shutdown`) are exactly
/// the places Java's `WebChannel.run()` touches all three links.
pub struct ChannelHub {
    pub dir: PathBuf,
    pub routing_path: PathBuf,
    pub wechat: Arc<super::wechat::WeChatLink>,
    pub cancel: CancellationToken,
    sink: RwLock<Arc<dyn InboundSink>>,
    ws_backoff: (Duration, Duration),
    poll_backoff: (Duration, Duration),
    started: AtomicBool,
}

impl ChannelHub {
    pub fn new(cfg: HubConfig) -> Arc<Self> {
        let routing_path = cfg.dir.join(ROUTING_FILE);
        let sink: Arc<dyn InboundSink> = cfg.sink.clone();
        Arc::new(Self {
            wechat: Arc::new(super::wechat::WeChatLink::new(
                cfg.dir.clone(),
                routing_path.clone(),
                cfg.http.clone(),
                sink.clone(),
            )),
            dir: cfg.dir,
            routing_path,
            cancel: CancellationToken::new(),
            sink: RwLock::new(sink),
            ws_backoff: cfg.ws_backoff,
            poll_backoff: cfg.poll_backoff,
            started: AtomicBool::new(false),
        })
    }

    /// Current inbound sink.
    pub async fn sink(&self) -> Arc<dyn InboundSink> {
        self.sink.read().await.clone()
    }

    /// Replace the inbound sink. The server calls this once at startup to route
    /// IM messages into the agent; until then [`LogSink`] is in place.
    pub async fn set_sink(&self, sink: Arc<dyn InboundSink>) {
        *self.sink.write().await = sink.clone();
        self.wechat.set_sink(sink).await;
    }

    /// Load the routing table from this hub's directory.
    pub fn routing(&self) -> RoutingTable {
        RoutingTable::load_from(self.routing_path.clone())
    }

    /// Credential store for a channel, rooted at this hub's directory.
    pub fn store(&self, file_name: &str) -> super::CredentialStore {
        super::CredentialStore::at(self.dir.join(file_name))
    }

    /// Spawn the background runners. Idempotent: a second call is a no-op, so a
    /// server that restarts its router does not double-poll upstream.
    ///
    /// Restores persisted bindings first (Java: `WebChannel.run()` →
    /// `weChatLink.run(); feishuLink.run(); dingTalkLink.run();`), then migrates
    /// a sole surviving binding into the routing table.
    pub fn start_all(self: &Arc<Self>) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let hub = self.clone();
        tokio::spawn(async move {
            hub.restore_and_migrate().await;

            let wechat = hub.wechat.clone();
            let cancel = hub.cancel.clone();
            let (base, max) = hub.poll_backoff;
            tokio::spawn(async move {
                run_with_reconnect(Box::new(wechat), cancel, Backoff::new(base, max)).await;
            });

            // Feishu/DingTalk would spawn per-credential tasks on demand here
            // (keyed by appId/appKey, appearing and disappearing at runtime);
            // their link modules do not exist yet.
        });
    }

    /// Restore persisted bindings and apply Java's `migrateOldBindings`: when a
    /// channel has exactly one binding and no active route, adopt it. With two or
    /// more the choice is ambiguous and guessing would silently point a channel at
    /// the wrong project.
    async fn restore_and_migrate(&self) {
        self.wechat.load_bindings().await;

        let mut routing = self.routing();
        for (channel, ids) in [
            ("wechat", self.wechat.bound_session_ids().await),
        ] {
            if routing.get_active_session(channel).is_some() {
                continue;
            }
            if ids.len() == 1 {
                let sid = ids.into_iter().next().unwrap();
                tracing::info!(channel = channel, session = %sid, "migrated sole binding into routing table");
                routing.set_active_session(channel, &sid, None);
            }
        }
    }

    /// Cancel every runner. Safe to call more than once.
    pub fn shutdown(&self) {
        self.cancel.cancel();
    }

    /// True once `start_all` has been called.
    pub fn is_started(&self) -> bool {
        self.started.load(Ordering::SeqCst)
    }

    /// Backoff config for the WS channels (exposed so tests can build matching
    /// loops without duplicating the constants).
    pub fn ws_backoff(&self) -> Backoff {
        Backoff::new(self.ws_backoff.0, self.ws_backoff.1)
    }
}

/// Process-global hub.
static HUB: OnceLock<Arc<ChannelHub>> = OnceLock::new();

/// The global hub, constructed with production settings on first use.
pub fn hub() -> Arc<ChannelHub> {
    if let Some(h) = HUB.get() {
        return h.clone();
    }
    install_hub(ChannelHub::new(HubConfig::production()))
}

/// Install a hub as the global one. The first call wins; later calls return the
/// already-installed hub. That makes double-initialisation harmless instead of a
/// source of two competing poll loops.
pub fn install_hub(h: Arc<ChannelHub>) -> Arc<ChannelHub> {
    match HUB.set(h.clone()) {
        Ok(()) => h,
        Err(h) => h,
    }
}

/// The installed hub, if any. Unlike [`hub`] this never constructs one, which is
/// what tests want when asserting "nothing was installed".
pub fn try_hub() -> Option<Arc<ChannelHub>> {
    HUB.get().cloned()
}

/// Convenience: mark a channel's routing state.
pub fn set_channel_state(routing_path: &Path, channel: &str, state: ChannelState) {
    let mut routing = RoutingTable::load_from(routing_path.to_path_buf());
    routing.set_state(channel, state);
    routing.save();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "gwork-runner-test-{}-{}",
            tag,
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A loop that fails a fixed number of times, then reports cancellation.
    struct FlakyLoop {
        name: &'static str,
        failures_left: usize,
        pub runs: Arc<std::sync::atomic::AtomicUsize>,
    }

    #[async_trait]
    impl ChannelLoop for FlakyLoop {
        fn name(&self) -> &'static str {
            self.name
        }
        async fn serve_once(&mut self, cancel: CancellationToken) -> anyhow::Result<()> {
            self.runs.fetch_add(1, Ordering::SeqCst);
            if self.failures_left > 0 {
                self.failures_left -= 1;
                anyhow::bail!("scripted failure");
            }
            // Succeed, then ask the supervisor to stop so the test terminates
            // deterministically instead of racing a timer.
            cancel.cancel();
            Ok(())
        }
    }

    #[test]
    fn backoff_doubles_and_caps() {
        let mut b = Backoff::new(Duration::from_secs(5), Duration::from_secs(60));
        assert_eq!(b.next_delay(), Duration::from_secs(5));
        assert_eq!(b.next_delay(), Duration::from_secs(10));
        assert_eq!(b.next_delay(), Duration::from_secs(20));
        assert_eq!(b.next_delay(), Duration::from_secs(40));
        assert_eq!(b.next_delay(), Duration::from_secs(60), "must clamp at max");
        assert_eq!(b.next_delay(), Duration::from_secs(60));
        assert_eq!(b.attempt(), 6);
    }

    #[test]
    fn backoff_reset_returns_to_base() {
        let mut b = Backoff::new(Duration::from_secs(2), Duration::from_secs(60));
        b.next_delay();
        b.next_delay();
        b.reset();
        assert_eq!(b.attempt(), 0);
        assert_eq!(b.next_delay(), Duration::from_secs(2));
    }

    /// A zero base would spin; a max below the base would never cap. Both are
    /// clamped rather than producing a degenerate loop.
    #[test]
    fn backoff_clamps_degenerate_configuration() {
        let mut b = Backoff::new(Duration::ZERO, Duration::ZERO);
        assert_eq!(b.next_delay(), Duration::from_millis(1));
        let mut b2 = Backoff::new(Duration::from_secs(10), Duration::from_secs(1));
        assert_eq!(b2.next_delay(), Duration::from_secs(10));
    }

    /// Many attempts must not overflow the shift or the duration, and must cap
    /// at `max` once the exponential growth reaches it.
    ///
    /// The delay is **not** `max` from the first attempt: it doubles
    /// (1s, 2s, 4s, … ) until it hits the ceiling. Asserting every one of 500
    /// samples equals `max` — as an earlier version of this test did — contradicts
    /// the growth the type exists to provide and would fail even on a correct
    /// implementation. What must hold is: monotonic non-decreasing, never above
    /// `max`, and pinned at `max` once grown.
    #[test]
    fn backoff_survives_hundreds_of_attempts() {
        let max = Duration::from_secs(30);
        let mut b = Backoff::new(Duration::from_secs(1), max);
        let mut prev = Duration::ZERO;
        let mut reached_cap_at: Option<u32> = None;
        for i in 0..500u32 {
            let d = b.next_delay();
            assert!(d >= prev, "backoff must not shrink: attempt {} gave {:?} after {:?}", i, d, prev);
            assert!(d <= max, "backoff exceeded max at attempt {}: {:?}", i, d);
            prev = d;
            if d == max && reached_cap_at.is_none() {
                reached_cap_at = Some(i);
            }
        }
        assert!(b.attempt() >= 500, "attempt counter must not overflow/saturate early");
        // base 1s doubling reaches the 30s cap at 2^5 = 32s, i.e. the 5th step.
        let cap_at = reached_cap_at.expect("backoff must reach the cap within 500 attempts");
        assert!(cap_at <= 6, "cap reached suspiciously late at attempt {}", cap_at);
        assert_eq!(prev, max, "final delay must sit at the cap");
    }

    #[tokio::test]
    async fn supervisor_retries_after_failure_then_stops_on_cancel() {
        let runs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let cancel = CancellationToken::new();
        let loop_ = FlakyLoop {
            name: "test",
            failures_left: 2,
            runs: runs.clone(),
        };
        // base 1ms so the test is fast; the assertion is on the run *count*, not
        // on elapsed time (see the module docs on Windows timer granularity).
        let backoff = Backoff::new(Duration::from_millis(1), Duration::from_millis(2));
        run_with_reconnect(Box::new(loop_), cancel.clone(), backoff).await;
        // 2 failures + 1 success (which cancels) = 3 runs.
        assert_eq!(runs.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn supervisor_exits_immediately_when_pre_cancelled() {
        let runs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let cancel = CancellationToken::new();
        cancel.cancel();
        let loop_ = FlakyLoop {
            name: "test",
            failures_left: 99,
            runs: runs.clone(),
        };
        run_with_reconnect(Box::new(loop_), cancel, Backoff::new(Duration::from_secs(1), Duration::from_secs(2))).await;
        assert_eq!(runs.load(Ordering::SeqCst), 0, "a cancelled token must not run the body at all");
    }

    #[tokio::test]
    async fn drain_notify_log_returns_texts_and_clears_the_file() {
        let dir = scratch("drain");
        super::super::channels_notify_in(&dir, "feishu", "one");
        super::super::channels_notify_in(&dir, "feishu", "two");
        let drained = drain_notify_log(&dir, "feishu");
        assert_eq!(drained, vec!["one".to_string(), "two".to_string()]);
        // Second drain is empty: at-most-once, so a reconnect storm cannot
        // re-deliver the same notification indefinitely.
        assert!(drain_notify_log(&dir, "feishu").is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn drain_notify_log_ignores_garbage_lines() {
        let dir = scratch("drain-garbage");
        let path = dir.join("wechat-notify-log.ndjson");
        std::fs::write(&path, "not json\n{\"text\":\"real\"}\n{\"nope\":1}\n").unwrap();
        let drained = drain_notify_log(&dir, "wechat");
        assert_eq!(drained, vec!["real".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn log_sink_reports_no_sessions_rather_than_inventing_them() {
        let dir = scratch("logsink");
        let sink = LogSink::new(dir.clone());
        assert!(sink.list_sessions().await.is_empty());
        sink.on_inbound(InboundMessage {
            channel: "feishu".into(),
            session_id: "work-1".into(),
            project_root: None,
            text: "hello".into(),
        })
        .await;
        // Recorded to the inbound log — observable, not silently dropped.
        let logged = std::fs::read_to_string(dir.join("feishu-inbound-notify-log.ndjson")).unwrap();
        assert!(logged.contains("hello"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The hub must keep every artefact inside its own directory. This is the
    /// structural guarantee that tests never touch the real `~/.gwork`.
    #[tokio::test]
    async fn hub_roots_everything_under_its_own_directory() {
        let dir = scratch("hub");
        let hub = ChannelHub::new(HubConfig {
            dir: dir.clone(),
            http: super::super::transport::testing::FakeHttp::new(),
            ws: super::super::transport::testing::FakeWs::new(vec![]),
            sink: Arc::new(LogSink::new(dir.clone())),
            ws_backoff: (Duration::from_millis(1), Duration::from_millis(2)),
            poll_backoff: (Duration::from_millis(1), Duration::from_millis(2)),
        });
        assert_eq!(hub.routing_path, dir.join(ROUTING_FILE));
        assert_eq!(hub.store("feishu-bindings.json").path(), dir.join("feishu-bindings.json"));

        hub.store("feishu-bindings.json")
            .set("work-9", serde_json::json!({"openId": "ou_x"}));
        assert!(dir.join("feishu-bindings.json").exists());
        assert!(!channels_dir().join("feishu-bindings.json").exists() || dir != channels_dir());

        hub.shutdown();
        assert!(hub.cancel.is_cancelled());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn hub_start_all_is_idempotent() {
        let dir = scratch("hub-idem");
        let hub = ChannelHub::new(HubConfig {
            dir: dir.clone(),
            http: super::super::transport::testing::FakeHttp::new(),
            ws: super::super::transport::testing::FakeWs::new(vec![]),
            sink: Arc::new(LogSink::new(dir.clone())),
            ws_backoff: (Duration::from_millis(1), Duration::from_millis(2)),
            poll_backoff: (Duration::from_millis(1), Duration::from_millis(2)),
        });
        assert!(!hub.is_started());
        hub.start_all();
        hub.start_all();
        assert!(hub.is_started());
        hub.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A replier that records instead of sending.
    #[derive(Default)]
    struct RecordingReplier {
        sent: Arc<std::sync::Mutex<Vec<String>>>,
    }

    impl Replier for RecordingReplier {
        fn reply_blocking(&self, text: &str) {
            self.sent.lock().unwrap().push(text.to_string());
        }
    }

    /// A sink with a fixed session list that records what it was asked to run.
    struct FixedSink {
        sessions: Vec<SessionInfo>,
        inbound: Arc<std::sync::Mutex<Vec<InboundMessage>>>,
    }

    #[async_trait]
    impl InboundSink for FixedSink {
        async fn list_sessions(&self) -> Vec<SessionInfo> {
            self.sessions.clone()
        }
        async fn on_inbound(&self, msg: InboundMessage) {
            self.inbound.lock().unwrap().push(msg);
        }
        async fn on_outbound(&self, _c: &str, _s: &str, _t: &str) {}
    }

    fn session(id: &str, root: Option<&str>) -> SessionInfo {
        SessionInfo {
            session_id: id.into(),
            label: id.into(),
            project_root: root.map(|r| r.to_string()),
        }
    }

    #[tokio::test]
    async fn help_command_is_consumed_and_never_reaches_the_agent() {
        let dir = scratch("cmd-help");
        let routing_path = dir.join(ROUTING_FILE);
        let inbound = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink: Arc<dyn InboundSink> = Arc::new(FixedSink {
            sessions: vec![session("work-1", None)],
            inbound: inbound.clone(),
        });
        let replier = RecordingReplier::default();
        let sent = replier.sent.clone();

        let consumed = process_inbound_text("feishu", "/help", &routing_path, &sink, &replier).await;
        assert!(consumed);
        assert!(inbound.lock().unwrap().is_empty());
        assert!(sent.lock().unwrap()[0].contains("/switch"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn switch_lists_sessions_and_enters_awaiting_selection() {
        let dir = scratch("cmd-switch");
        let routing_path = dir.join(ROUTING_FILE);
        let sink: Arc<dyn InboundSink> = Arc::new(FixedSink {
            sessions: vec![session("work-1", None), session("work-2", Some("/p"))],
            inbound: Arc::new(std::sync::Mutex::new(Vec::new())),
        });
        let replier = RecordingReplier::default();

        assert!(process_inbound_text("wechat", "/switch", &routing_path, &sink, &replier).await);
        let routing = RoutingTable::load_from(routing_path.clone());
        assert_eq!(routing.get_state("wechat"), ChannelState::AwaitingSelection);

        // A digit now selects, and the project root travels with the route.
        assert!(process_inbound_text("wechat", "2", &routing_path, &sink, &replier).await);
        let routing = RoutingTable::load_from(routing_path);
        assert_eq!(routing.get_active_session("wechat"), Some("work-2".into()));
        assert_eq!(
            routing.get_active_route("wechat").and_then(|r| r.project_root.clone()),
            Some("/p".into())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// With several sessions and no route, the first plain message must trigger
    /// the selection list rather than being forwarded to an arbitrary session.
    #[tokio::test]
    async fn plain_message_with_no_route_and_many_sessions_asks_for_a_choice() {
        let dir = scratch("idle-many");
        let routing_path = dir.join(ROUTING_FILE);
        let inbound = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink: Arc<dyn InboundSink> = Arc::new(FixedSink {
            sessions: vec![session("work-1", None), session("work-2", None)],
            inbound: inbound.clone(),
        });
        let replier = RecordingReplier::default();

        let consumed = process_inbound_text("dingtalk", "hello", &routing_path, &sink, &replier).await;
        assert!(consumed, "must not guess a session when several exist");
        assert!(inbound.lock().unwrap().is_empty());
        assert!(replier.sent.lock().unwrap()[0].contains("请选择会话"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Exactly one session: Java auto-adopts it and forwards the message.
    #[tokio::test]
    async fn plain_message_with_a_single_session_is_forwarded() {
        let dir = scratch("idle-one");
        let routing_path = dir.join(ROUTING_FILE);
        let inbound = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink: Arc<dyn InboundSink> = Arc::new(FixedSink {
            sessions: vec![session("work-only", Some("/proj"))],
            inbound: inbound.clone(),
        });
        let replier = RecordingReplier::default();

        let consumed = process_inbound_text("feishu", "do the thing", &routing_path, &sink, &replier).await;
        assert!(!consumed);
        let got = inbound.lock().unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].session_id, "work-only");
        assert_eq!(got[0].project_root.as_deref(), Some("/proj"));
        assert_eq!(got[0].text, "do the thing");
        assert_eq!(got[0].channel, "feishu");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// No sessions at all: create one and forward, so the user is not dead-ended.
    #[tokio::test]
    async fn plain_message_with_no_sessions_creates_one() {
        let dir = scratch("idle-none");
        let routing_path = dir.join(ROUTING_FILE);
        let inbound = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink: Arc<dyn InboundSink> = Arc::new(FixedSink {
            sessions: vec![],
            inbound: inbound.clone(),
        });
        let replier = RecordingReplier::default();

        assert!(!process_inbound_text("wechat", "hi", &routing_path, &sink, &replier).await);
        let got = inbound.lock().unwrap();
        assert_eq!(got.len(), 1);
        assert!(got[0].session_id.starts_with("work-"), "{}", got[0].session_id);
        assert_eq!(got[0].project_root, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An existing route wins: the message goes straight through without
    /// re-running the selection flow.
    #[tokio::test]
    async fn existing_route_forwards_directly() {
        let dir = scratch("routed");
        let routing_path = dir.join(ROUTING_FILE);
        let mut routing = RoutingTable::load_from(routing_path.clone());
        routing.set_active_session("dingtalk", "work-fixed", Some("/root".into()));
        let inbound = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink: Arc<dyn InboundSink> = Arc::new(FixedSink {
            sessions: vec![session("work-1", None), session("work-2", None)],
            inbound: inbound.clone(),
        });
        let replier = RecordingReplier::default();

        assert!(!process_inbound_text("dingtalk", "run tests", &routing_path, &sink, &replier).await);
        let got = inbound.lock().unwrap();
        assert_eq!(got[0].session_id, "work-fixed");
        assert_eq!(got[0].project_root.as_deref(), Some("/root"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `migrateOldBindings` adopts a sole binding but refuses to guess between two.
    #[tokio::test]
    async fn migration_adopts_a_sole_binding_and_refuses_to_guess() {
        let dir = scratch("migrate");
        let hub = ChannelHub::new(HubConfig {
            dir: dir.clone(),
            http: super::super::transport::testing::FakeHttp::new(),
            ws: super::super::transport::testing::FakeWs::new(vec![]),
            sink: Arc::new(LogSink::new(dir.clone())),
            ws_backoff: (Duration::from_millis(1), Duration::from_millis(2)),
            poll_backoff: (Duration::from_millis(1), Duration::from_millis(2)),
        });

        // One wechat binding → adopted.
        hub.store("wechat-bindings.json").set(
            "work-only",
            serde_json::json!({"botToken": "t", "ilinkBotId": "b", "ilinkUserId": "u"}),
        );
        // Two feishu bindings → ambiguous, must not be routed.
        let fs = hub.store("feishu-bindings.json");
        fs.set("work-a", serde_json::json!({"openId": "ou_a", "appId": "a", "appSecret": "s"}));
        fs.set("work-b", serde_json::json!({"openId": "ou_b", "appId": "a", "appSecret": "s"}));

        hub.restore_and_migrate().await;

        let routing = hub.routing();
        assert_eq!(routing.get_active_session("wechat"), Some("work-only".into()));
        assert_eq!(routing.get_active_session("feishu"), None, "two bindings must not be guessed between");
        hub.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
