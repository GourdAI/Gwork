//! Shared retry / client utilities for the outbound web tools.
//!
//! # Why this module exists
//!
//! The Java kernel wraps every network Talent in `RetryTask.callWithRetry`
//! (`gourdai-java/.../util/RetryTask.java:161-260`): 3 attempts by default,
//! exponential delay with Full Jitter, a fast-fail gate for deterministic HTTP
//! errors and an optional wall-clock budget. The Rust tools had **none** of
//! that — each `execute` performed exactly one request, so a transient 429 or
//! a TCP reset was reported to the model as a hard failure.
//!
//! This is a deliberate port of the Java *semantics*, not of its bugs:
//!
//! * Java's `McpClientProvider.executeWithRetry` (`:376-394`) re-issues a
//!   transport failure **immediately with no backoff**, underneath the outer
//!   3-attempt loop. Worst case that is 6 requests for one call, which makes
//!   rate limiting worse. Here there is exactly one retry loop.
//! * Java has no `Retry-After` handling. HTTP 429 responses carry it (Jina
//!   Reader returns seconds or an HTTP-date), and honouring it is the single
//!   most effective thing a client can do under a rate limit, so it takes
//!   precedence over the computed jitter.
//! * Java's fast-fail gate is `LlmRetryPolicy.isNonRetryable`; the identical
//!   classification already exists in this kernel as
//!   [`crate::llm::client::is_non_retryable`] and is reused rather than
//!   duplicated.
//!
//! All delays are computed as pure values so they can be unit-tested without
//! sleeping (Windows `tokio::time::sleep` granularity is ~15 ms, which makes
//! elapsed-time assertions unreliable here — see `channels::runner::Backoff`).

use std::future::Future;
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

/// Default attempt count, matching Java `RetryTask.DEFAULT_MAX_RETRIES`.
pub const DEFAULT_MAX_ATTEMPTS: u32 = 3;
/// Java `RetryTask.DEFAULT_INITIAL_DELAY_MS`.
pub const DEFAULT_BASE_DELAY: Duration = Duration::from_secs(1);
/// Java `RetryTask.DEFAULT_MAX_DELAY_MS`.
pub const DEFAULT_MAX_DELAY: Duration = Duration::from_secs(30);
/// Java `WebfetchTalent.MAX_TIMEOUT_MS`, used as the default retry budget.
pub const DEFAULT_BUDGET: Duration = Duration::from_secs(120);

/// What a single attempt decided about the outcome.
///
/// An attempt can fail with an HTTP status (so the loop can inspect
/// `Retry-After` and classify 4xx) or with a transport/other error string.
#[derive(Debug, Clone)]
pub enum AttemptError {
    /// An HTTP response was received but was not acceptable.
    Http {
        status: reqwest::StatusCode,
        /// Value of the `Retry-After` header, when present.
        retry_after: Option<String>,
        detail: String,
    },
    /// No usable response: DNS/TCP/timeout/body-read/MCP failure.
    Transport(String),
}

impl AttemptError {
    pub fn http(status: reqwest::StatusCode, retry_after: Option<String>, detail: impl Into<String>) -> Self {
        Self::Http { status, retry_after, detail: detail.into() }
    }

    pub fn transport(detail: impl Into<String>) -> Self {
        Self::Transport(detail.into())
    }

    /// Human-readable text returned to the model when the retries are over.
    pub fn message(&self) -> String {
        match self {
            Self::Http { status, detail, .. } => {
                if detail.is_empty() {
                    format!("HTTP {}", status)
                } else {
                    format!("HTTP {}: {}", status, detail)
                }
            }
            Self::Transport(detail) => detail.clone(),
        }
    }

    /// Whether re-issuing this exact request could ever succeed.
    ///
    /// Java `RetryTask.java:202-210` uses `LlmRetryPolicy.isNonRetryable` for
    /// this, and its documented contract (`:103`) keeps 429 / 408 / 409 / all
    /// 5xx / network errors retryable. That is exactly
    /// `crate::llm::client::is_non_retryable`, which also understands the
    /// gateway-wrapped business errors some providers return with HTTP 500.
    pub fn is_deterministic(&self) -> bool {
        match self {
            Self::Http { status, .. } => {
                // Classify on the status code **only**. `is_non_retryable` also
                // scans free-form text for LLM-provider fatal markers and parses
                // `{"code":"403"}` out of JSON bodies; feeding it a remote
                // error page (or any future `detail` that carries one) would let
                // third-party content flip a transient 429/5xx into a fast-fail,
                // or mislabel a website's wording as a revoked API key. Here the
                // status is already authoritative, so a canonical "HTTP <code>"
                // string is both sufficient and injection-proof.
                crate::llm::client::is_non_retryable(&format!("HTTP {}", status.as_u16()))
            }
            // No response → no status → conservative "retryable", matching the
            // Java policy for network exceptions and timeouts.
            Self::Transport(_) => false,
        }
    }

    /// Server-requested pause. Only meaningful for 429 / 503.
    pub fn retry_after(&self) -> Option<Duration> {
        match self {
            Self::Http { retry_after: Some(raw), .. } => parse_retry_after(raw),
            _ => None,
        }
    }
}

/// Parse `Retry-After`: either delta-seconds or an HTTP-date (RFC 7231 §7.1.3).
///
/// An unparseable value yields `None` so the caller falls back to jitter rather
/// than waiting forever. Negative/huge second counts are clamped.
pub fn parse_retry_after(raw: &str) -> Option<Duration> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(secs) = raw.parse::<u64>() {
        // A malicious or broken endpoint must not be able to pin a tool for a
        // day; the budget check in `run_with_retry` is the second line of
        // defence.
        return Some(Duration::from_secs(secs.min(600)));
    }
    // HTTP-date, e.g. `Wed, 21 Oct 2015 07:28:00 GMT`. `chrono` is already a
    // workspace dependency and `DateTime::parse_from_rfc2822` speaks exactly
    // the IMF-fixdate / RFC 850 / asctime forms the header allows.
    let date = chrono::DateTime::parse_from_rfc2822(raw).ok()?;
    let delta = date.signed_duration_since(chrono::Utc::now());
    let secs = delta.num_seconds();
    if secs <= 0 {
        Some(Duration::ZERO)
    } else {
        Some(Duration::from_secs((secs as u64).min(600)))
    }
}

/// Configuration for one tool call. Constructed from `Settings` by the caller.
#[derive(Debug, Clone, Copy)]
pub struct RetryPolicy {
    /// Total attempts, including the first one. Clamped to at least 1.
    pub max_attempts: u32,
    pub base_delay: Duration,
    pub max_delay: Duration,
    /// Wall-clock cap covering attempts *and* backoff waits. `ZERO` disables it.
    pub budget: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: DEFAULT_MAX_ATTEMPTS,
            base_delay: DEFAULT_BASE_DELAY,
            max_delay: DEFAULT_MAX_DELAY,
            budget: DEFAULT_BUDGET,
        }
    }
}

/// Hard ceiling on configured attempts. A settings.json typo (or a model
/// writing `999999`) must not turn one tool call into an unbounded request
/// storm: every attempt costs a real HTTP request against a keyless endpoint
/// that is already rate limiting us. Java has no clamp, but Java's settings
/// come from a human-edited form, not from a tool-calling model.
pub const MAX_ATTEMPTS_CEILING: u32 = 10;

impl RetryPolicy {
    /// Build from the two Java-derived settings keys.
    ///
    /// `attempts == 0` is a valid "no retry" request but a nonsensical one from
    /// a settings file, so it is normalised to 1 (always at least one attempt).
    /// Oversized values are clamped, not rejected: a bad config should degrade
    /// to a safe retry count rather than breaking every web tool.
    pub fn from_settings(api_or_mcp_retries: u32, budget_secs: u32) -> Self {
        Self {
            max_attempts: api_or_mcp_retries.clamp(1, MAX_ATTEMPTS_CEILING),
            budget: if budget_secs == 0 {
                Duration::ZERO
            } else {
                Duration::from_secs(budget_secs as u64)
            },
            ..Self::default()
        }
    }
}

/// Java `RetryTask.java:218-226`: `initialDelay * 2^i`, capped, then Full
/// Jitter (`rand(0, capped]`). Deterministic `jitter` argument keeps it
/// testable: pass a value in `0.0..=1.0`; production passes `rand::random()`.
pub fn backoff_delay(policy: &RetryPolicy, attempt_index: u32, jitter: f64) -> Duration {
    let exp = attempt_index.min(16);
    let grown = policy.base_delay.saturating_mul(1u32 << exp);
    let capped = grown.min(policy.max_delay);
    let jitter = jitter.clamp(0.0, 1.0);
    let millis = capped.as_millis() as f64 * jitter;
    Duration::from_millis(millis as u64)
}

/// Why a retry loop should stop — or how long to wait before continuing.
///
/// Keeping the reason in the return value (rather than recomputing it at the
/// call site) is what guarantees the reported `budget_exhausted` matches the
/// delay that was actually considered. The old shape used a second, different
/// jitter value to guess the reason afterwards and could disagree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryDecision {
    /// Sleep for this long, then attempt again.
    Wait(Duration),
    /// The error is deterministic (bad request / auth); no retry can help.
    FastFail,
    /// The attempt budget is used up.
    AttemptsExhausted,
    /// The wall-clock budget cannot accommodate the wait.
    BudgetExhausted,
}

/// Decide what to do after a failed attempt.
///
/// Java has two budget decision points (`RetryTask.java:173-179` before the
/// next attempt and `:233-239` before the backoff wait); both are folded into
/// this one pure function so "budget exhausted" and "attempts exhausted"
/// cannot disagree with each other.
pub fn decide_after_failure(
    policy: &RetryPolicy,
    err: &AttemptError,
    attempt_index: u32,
    elapsed: Duration,
    jitter: f64,
) -> RetryDecision {
    if err.is_deterministic() {
        return RetryDecision::FastFail;
    }
    if attempt_index.saturating_add(1) >= policy.max_attempts {
        return RetryDecision::AttemptsExhausted;
    }
    // A rate-limited server telling us when to come back outranks our own
    // exponential schedule: retrying earlier just earns another 429.
    let delay = err.retry_after().unwrap_or_else(|| backoff_delay(policy, attempt_index, jitter));
    // Java `RetryTask.java:233-239` aborts when `remaining < delay`, i.e.
    // `elapsed + delay > budget` — a wait that fits *exactly* is allowed. Using
    // `>=` here would drop the last legitimate retry on a round-number budget.
    if !policy.budget.is_zero() && elapsed.saturating_add(delay) > policy.budget {
        return RetryDecision::BudgetExhausted;
    }
    RetryDecision::Wait(delay)
}

/// Test/back-compat helper: `None` means "stop", `Some` is the wait duration.
pub fn delay_before_next_attempt(
    policy: &RetryPolicy,
    err: &AttemptError,
    attempt_index: u32,
    elapsed: Duration,
    jitter: f64,
) -> Option<Duration> {
    match decide_after_failure(policy, err, attempt_index, elapsed, jitter) {
        RetryDecision::Wait(d) => Some(d),
        _ => None,
    }
}

/// Outcome of [`run_with_retry`].
#[derive(Debug)]
pub struct RetryOutcome<T> {
    pub value: Option<T>,
    /// The last error, when every attempt failed (or retries were skipped).
    pub last_error: Option<AttemptError>,
    /// Total attempts actually made.
    pub attempts: u32,
    /// True when the loop stopped because of a deterministic error.
    pub fast_failed: bool,
    /// True when the loop stopped because the wall-clock budget was exhausted.
    pub budget_exhausted: bool,
    /// True when the cancellation token fired during a backoff wait.
    pub cancelled: bool,
}

/// Run an async attempt under the Java-equivalent retry policy.
///
/// `make_attempt` receives the zero-based attempt index and returns either the
/// successful value or an [`AttemptError`]. Each attempt rebuilds its own state,
/// so a partially-consumed response can never leak into the next attempt.
///
/// Cancellation is checked before each attempt and honoured during backoff
/// waits, so pressing Stop cannot be blocked by a 30 s sleep.
pub async fn run_with_retry<T, F, Fut>(
    policy: &RetryPolicy,
    cancel: &CancellationToken,
    mut make_attempt: F,
) -> RetryOutcome<T>
where
    F: FnMut(u32) -> Fut,
    Fut: Future<Output = Result<T, AttemptError>>,
{
    let start = Instant::now();
    let mut last_error: Option<AttemptError> = None;
    let mut attempts = 0u32;

    for i in 0..policy.max_attempts {
        if cancel.is_cancelled() {
            return RetryOutcome {
                value: None,
                last_error,
                attempts,
                fast_failed: false,
                budget_exhausted: false,
                cancelled: true,
            };
        }
        // Budget decision point ①: before starting a *retry* (never blocks the
        // first attempt — Java `RetryTask.java:173-179` has the same `i > 0`).
        if i > 0 && !policy.budget.is_zero() && start.elapsed() >= policy.budget {
            return RetryOutcome {
                value: None,
                last_error,
                attempts,
                fast_failed: false,
                budget_exhausted: true,
                cancelled: false,
            };
        }
        attempts += 1;
        match make_attempt(i).await {
            Ok(value) => {
                return RetryOutcome {
                    value: Some(value),
                    last_error: None,
                    attempts,
                    fast_failed: false,
                    budget_exhausted: false,
                    cancelled: false,
                };
            }
            Err(e) => {
                let deterministic = e.is_deterministic();
                tracing::warn!(
                    attempt = attempts,
                    error = %e.message(),
                    deterministic,
                    "web tool attempt failed"
                );
                // One decision, computed from the *same* jitter value the wait
                // will use. Recomputing the reason afterwards could disagree.
                let decision = decide_after_failure(
                    policy, &e, i, start.elapsed(), rand::random(),
                );
                last_error = Some(e);
                let delay = match decision {
                    RetryDecision::FastFail => {
                        return RetryOutcome {
                            value: None, last_error, attempts,
                            fast_failed: true, budget_exhausted: false, cancelled: false,
                        };
                    }
                    RetryDecision::AttemptsExhausted => {
                        return RetryOutcome {
                            value: None, last_error, attempts,
                            fast_failed: false, budget_exhausted: false, cancelled: false,
                        };
                    }
                    RetryDecision::BudgetExhausted => {
                        return RetryOutcome {
                            value: None, last_error, attempts,
                            fast_failed: false, budget_exhausted: true, cancelled: false,
                        };
                    }
                    RetryDecision::Wait(d) => d,
                };
                if !delay.is_zero() {
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => {
                            return RetryOutcome {
                                value: None,
                                last_error,
                                attempts,
                                fast_failed: false,
                                budget_exhausted: false,
                                cancelled: true,
                            };
                        }
                        _ = tokio::time::sleep(delay) => {}
                    }
                }
            }
        }
    }

    RetryOutcome {
        value: None,
        last_error,
        attempts,
        fast_failed: false,
        budget_exhausted: false,
        cancelled: false,
    }
}

// ─── Shared HTTP client ────────────────────────────────────────────────────────

/// Build a pooled `reqwest::Client`.
///
/// Deliberately **no total request timeout** at the client level: callers apply
/// `.timeout(..)` per `RequestBuilder`. `webfetch` accepts a model-supplied
/// `timeoutMs` (1..120000); keying a process-wide client cache on that value
/// would create an unbounded number of clients (each with its own TLS/HTTP2
/// pool) for distinct timeouts. `RequestBuilder::timeout` covers that one
/// request including its body stream, so the observable behaviour is identical.
/// This is `pub(crate)` so tests can point it at a local mock server.
pub fn build_client(proxy: &str) -> reqwest::Client {
    build_client_with_ua(proxy, "Mozilla/5.0 (compatible; GWork/0.3)")
}

/// Same as [`build_client`] with an explicit User-Agent (`crawl_url` needs the
/// browser-shaped one Jina expects).
///
/// When `proxy` is empty we leave reqwest's `auto_sys_proxy` enabled: it reads
/// `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` with the correct
/// scheme matching. Calling `Proxy::all` for an env-derived value disables that
/// (`reqwest` client.rs:1416) and sets `no_proxy: None` (proxy.rs:261), which
/// would force localhost/intranet requests through the proxy and ignore
/// `NO_PROXY` entirely.
pub fn build_client_with_ua(proxy: &str, user_agent: &str) -> reqwest::Client {
    let mut b = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .user_agent(user_agent);
    let chosen = configured_proxy(proxy);
    if !chosen.is_empty() {
        match reqwest::Proxy::all(&chosen) {
            Ok(p) => {
                // Even an explicit override must respect NO_PROXY, otherwise
                // local endpoints (and the test mock server) get tunnelled too.
                b = b.proxy(p.no_proxy(reqwest::NoProxy::from_env()));
            }
            Err(e) => {
                // A typo in settings.json must not make every web tool fail
                // with a cryptic builder error; go direct and say why.
                tracing::warn!(proxy = %chosen, error = %e, "invalid web proxy; continuing direct");
            }
        }
    }
    b.build().unwrap_or_else(|e| {
        tracing::warn!(error = %e, "failed to build web client; falling back to default");
        reqwest::Client::new()
    })
}

/// The proxy explicitly configured in settings.json (trimmed). Empty means
/// "use the process environment / system proxy", which reqwest resolves itself
/// **once, when the client is built** (`client.rs:419-421`).
///
/// The environment is treated as a process-startup constant, exactly like
/// Java's config.yml / AgentProperties. Nothing in this process calls
/// `std::env::set_var`, so there is no reason to re-read eight variables and
/// allocate nine strings on every tool call — that would be pure overhead the
/// Java kernel does not pay. The cached client therefore snapshots the egress
/// path on first use and reuses it for the rest of the process.
pub fn configured_proxy(configured: &str) -> String {
    configured.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err(status: u16, after: Option<&str>) -> AttemptError {
        AttemptError::http(
            reqwest::StatusCode::from_u16(status).unwrap(),
            after.map(|s| s.to_string()),
            "",
        )
    }

    #[test]
    fn full_jitter_is_bounded_by_the_capped_exponential() {
        let p = RetryPolicy::default();
        // Java: initialDelay * 2^i, capped at 30s, then rand(0, capped].
        assert_eq!(backoff_delay(&p, 0, 1.0), Duration::from_secs(1));
        assert_eq!(backoff_delay(&p, 1, 1.0), Duration::from_secs(2));
        assert_eq!(backoff_delay(&p, 2, 1.0), Duration::from_secs(4));
        assert_eq!(backoff_delay(&p, 20, 1.0), Duration::from_secs(30));
        assert_eq!(backoff_delay(&p, 0, 0.0), Duration::ZERO);
        assert!(backoff_delay(&p, 0, 0.5) <= Duration::from_secs(1));
        // Out-of-range jitter is clamped rather than producing a longer wait.
        assert_eq!(backoff_delay(&p, 0, 9.0), Duration::from_secs(1));
    }

    #[test]
    fn deterministic_4xx_never_retries_but_429_and_5xx_do() {
        let p = RetryPolicy::default();
        for code in [400, 401, 403, 404, 405, 413, 414, 422] {
            assert!(
                delay_before_next_attempt(&p, &err(code, None), 0, Duration::ZERO, 1.0).is_none(),
                "{code} must fast-fail like Java LlmRetryPolicy"
            );
        }
        for code in [408, 409, 429, 500, 502, 503] {
            assert!(
                delay_before_next_attempt(&p, &err(code, None), 0, Duration::ZERO, 1.0).is_some(),
                "{code} must stay retryable"
            );
        }
        assert!(delay_before_next_attempt(
            &p,
            &AttemptError::transport("connection reset by peer"),
            0,
            Duration::ZERO,
            1.0
        )
        .is_some());
    }

    #[test]
    fn decision_reports_the_reason_not_just_none() {
        use RetryDecision::*;
        let p = RetryPolicy::default();
        assert_eq!(
            decide_after_failure(&p, &err(400, None), 0, Duration::ZERO, 1.0),
            FastFail
        );
        assert_eq!(
            decide_after_failure(&p, &err(429, None), 2, Duration::ZERO, 1.0),
            AttemptsExhausted
        );
        let tight = RetryPolicy { budget: Duration::from_secs(5), ..p };
        assert_eq!(
            decide_after_failure(&tight, &err(429, Some("30")), 0, Duration::ZERO, 1.0),
            BudgetExhausted
        );
        assert_eq!(
            decide_after_failure(&p, &err(429, Some("7")), 0, Duration::ZERO, 1.0),
            Wait(Duration::from_secs(7))
        );
    }

    #[test]
    fn remote_content_cannot_turn_a_transient_error_into_a_fast_fail() {
        // A 429/5xx page is attacker-controlled text. Feeding it to the LLM
        // error classifier would let `{"code":"403"}` or "invalid api key"
        // inside the body flip a retryable status into a deterministic one.
        let e = AttemptError::http(
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            None,
            r#"{"code":"403","msg":"invalid api key / model_not_found"}"#,
        );
        assert!(!e.is_deterministic(), "status alone decides, not the body");
        assert!(delay_before_next_attempt(&RetryPolicy::default(), &e, 0, Duration::ZERO, 1.0).is_some());
        // A genuine 403 is still a fast fail.
        assert!(err(403, None).is_deterministic());
    }

    #[test]
    fn retry_after_seconds_overrides_jitter() {
        let p = RetryPolicy::default();
        let got = delay_before_next_attempt(&p, &err(429, Some("7")), 0, Duration::ZERO, 1.0);
        assert_eq!(got, Some(Duration::from_secs(7)), "server hint must win over our 1s schedule");
        // Clamped so a broken endpoint cannot pin the tool for a day.
        assert_eq!(parse_retry_after("999999"), Some(Duration::from_secs(600)));
        assert_eq!(parse_retry_after("0"), Some(Duration::ZERO));
        assert_eq!(parse_retry_after("garbage"), None);
        assert_eq!(parse_retry_after(""), None);
    }

    #[test]
    fn retry_after_http_date_becomes_a_relative_delay() {
        let future = chrono::Utc::now() + chrono::Duration::seconds(12);
        let raw = future.to_rfc2822();
        let got = parse_retry_after(&raw).expect("IMF-fixdate must parse");
        assert!(got >= Duration::from_secs(10) && got <= Duration::from_secs(12), "got {:?}", got);
        // A date already in the past means "retry now", not a negative wait.
        let past = (chrono::Utc::now() - chrono::Duration::seconds(60)).to_rfc2822();
        assert_eq!(parse_retry_after(&past), Some(Duration::ZERO));
    }

    #[test]
    fn budget_stops_a_retry_that_would_wait_past_the_deadline() {
        let p = RetryPolicy { budget: Duration::from_secs(10), ..RetryPolicy::default() };
        assert!(
            delay_before_next_attempt(&p, &err(429, Some("30")), 0, Duration::from_secs(1), 1.0)
                .is_none(),
            "a 30s server hint cannot fit in a 10s budget"
        );
        // Zero budget = unlimited, matching Java "<=0 means not configured".
        let unlimited = RetryPolicy { budget: Duration::ZERO, ..RetryPolicy::default() };
        assert!(delay_before_next_attempt(
            &unlimited,
            &err(429, Some("30")),
            0,
            Duration::from_secs(1),
            1.0
        )
        .is_some());
    }

    #[test]
    fn last_attempt_never_waits() {
        let p = RetryPolicy::default();
        assert!(delay_before_next_attempt(&p, &err(429, None), 2, Duration::ZERO, 1.0).is_none());
    }

    #[test]
    fn policy_normalises_settings_values() {
        let p = RetryPolicy::from_settings(5, 45);
        assert_eq!(p.max_attempts, 5);
        assert_eq!(p.budget, Duration::from_secs(45));
        let zero = RetryPolicy::from_settings(0, 0);
        assert_eq!(zero.max_attempts, 1, "zero retries still means one attempt");
        assert_eq!(zero.budget, Duration::ZERO, "zero budget disables the cap");
        // A model-written settings value must not become a request storm.
        assert_eq!(RetryPolicy::from_settings(u32::MAX, 0).max_attempts, MAX_ATTEMPTS_CEILING);
    }

    #[test]
    fn configured_proxy_wins_and_environment_is_left_to_reqwest() {
        assert_eq!(configured_proxy("  http://127.0.0.1:7890  "), "http://127.0.0.1:7890");
        assert!(configured_proxy("   ").is_empty(), "empty = let reqwest read NO_PROXY etc.");
    }

    // ── The loop itself ───────────────────────────────────────────────────────

    #[tokio::test]
    async fn retries_a_transient_error_and_returns_the_success() {
        let p = RetryPolicy {
            base_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(2),
            ..RetryPolicy::default()
        };
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let c = calls.clone();
        let out = run_with_retry(&p, &CancellationToken::new(), |_| {
            let c = c.clone();
            async move {
                if c.fetch_add(1, std::sync::atomic::Ordering::SeqCst) < 2 {
                    Err(AttemptError::transport("connection reset"))
                } else {
                    Ok("ok")
                }
            }
        })
        .await;
        assert_eq!(out.value, Some("ok"));
        assert_eq!(out.attempts, 3);
        assert!(!out.fast_failed && !out.budget_exhausted && !out.cancelled);
    }

    #[tokio::test]
    async fn deterministic_error_makes_exactly_one_request() {
        let p = RetryPolicy::default();
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let c = calls.clone();
        let out = run_with_retry::<(), _, _>(&p, &CancellationToken::new(), |_| {
            let c = c.clone();
            async move {
                c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Err(AttemptError::http(reqwest::StatusCode::BAD_REQUEST, None, "bad query"))
            }
        })
        .await;
        assert!(out.fast_failed);
        assert_eq!(out.attempts, 1, "must not burn the retry budget on a 400");
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cancellation_during_backoff_stops_immediately() {
        let p = RetryPolicy {
            base_delay: Duration::from_secs(30),
            max_delay: Duration::from_secs(30),
            ..RetryPolicy::default()
        };
        let token = CancellationToken::new();
        let t = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            t.cancel();
        });
        let out = run_with_retry::<(), _, _>(&p, &token, |_| async {
            Err(AttemptError::transport("timeout"))
        })
        .await;
        assert!(out.cancelled);
        assert_eq!(out.attempts, 1, "must not start a second attempt after Stop");
    }

    #[tokio::test]
    async fn exhausted_budget_is_reported_distinctly() {
        // 1ms budget: the first attempt fails, the next attempt is refused at
        // decision point ① before any backoff sleep can be scheduled.
        let p = RetryPolicy {
            budget: Duration::from_millis(1),
            base_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(1),
            ..RetryPolicy::default()
        };
        let out = run_with_retry::<(), _, _>(&p, &CancellationToken::new(), |_| async {
            tokio::time::sleep(Duration::from_millis(10)).await;
            Err(AttemptError::transport("slow"))
        })
        .await;
        assert_eq!(out.attempts, 1);
        assert!(out.budget_exhausted, "got {:?}", out);
    }
}
