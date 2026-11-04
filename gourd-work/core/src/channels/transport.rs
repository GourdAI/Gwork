//! transport — injectable HTTP / WebSocket clients for the IM channel runners.
//!
//! Every channel (WeChat / Feishu / DingTalk) talks to its upstream over plain
//! HTTP+JSON or a WebSocket. Both capabilities are abstracted behind
//! [`HttpTransport`] and [`WsTransport`] so that:
//!
//! * production uses [`ReqwestHttp`] / [`TungsteniteWs`];
//! * unit tests inject scripted fakes.
//!
//! **No test in this crate may reach the network.** A test whose outcome depends
//! on `ilinkai.weixin.qq.com` being reachable is a test that goes red on a plane
//! and green on a laptop, which is worse than no test at all: it trains people
//! to ignore red. The traits below exist to make that structurally impossible.
//!
//! The shapes deliberately mirror the Java kernel's `HttpUtils` usage: a request
//! carries its own timeout (WeChat's `getupdates` long-poll needs 45s while
//! everything else is fine with 15s), and a non-2xx response is an *error*
//! rather than a body — Java returns `null` in that case and every caller treats
//! `null` as "upstream unreachable".

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};

/// Default request timeout. Java: `HttpUtils.timeout(10, 10, 15)`.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);
/// Long-poll timeout for WeChat `getupdates`. Java: `timeout(10, 10, 45)`.
pub const LONG_POLL_TIMEOUT: Duration = Duration::from_secs(45);
/// WebSocket handshake timeout. Java: `connectBlocking(30, TimeUnit.SECONDS)`.
pub const WS_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// HTTP verbs the channel clients actually use. Nothing else is needed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

/// One HTTP request description.
#[derive(Debug, Clone)]
pub struct HttpReq {
    pub method: Method,
    pub url: String,
    /// JSON request body, already serialized. `None` for GET.
    pub body: Option<String>,
    pub headers: Vec<(String, String)>,
    pub timeout: Duration,
}

impl HttpReq {
    pub fn get(url: impl Into<String>) -> Self {
        Self {
            method: Method::Get,
            url: url.into(),
            body: None,
            headers: Vec::new(),
            timeout: DEFAULT_TIMEOUT,
        }
    }

    pub fn post(url: impl Into<String>, body: impl Into<String>) -> Self {
        Self {
            method: Method::Post,
            url: url.into(),
            body: Some(body.into()),
            headers: Vec::new(),
            timeout: DEFAULT_TIMEOUT,
        }
    }

    pub fn header(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((key.into(), value.into()));
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
}

/// An HTTP client. Implementations must treat a non-2xx status as an error.
#[async_trait]
pub trait HttpTransport: Send + Sync {
    async fn send(&self, req: HttpReq) -> anyhow::Result<String>;
}

/// Production HTTP transport backed by `reqwest` (rustls, no native TLS).
pub struct ReqwestHttp {
    client: reqwest::Client,
}

impl ReqwestHttp {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            // The channel runners are background tasks; a hung upstream must not
            // pin a worker thread forever. Per-request timeouts below are the
            // real limit, this is the ceiling for the whole exchange.
            .timeout(Duration::from_secs(120))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { client }
    }
}

impl Default for ReqwestHttp {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl HttpTransport for ReqwestHttp {
    async fn send(&self, req: HttpReq) -> anyhow::Result<String> {
        let mut builder = match req.method {
            Method::Get => self.client.get(&req.url),
            Method::Post => self.client.post(&req.url),
        };
        for (k, v) in &req.headers {
            // A malformed header must not abort the request: the Java client
            // would have thrown, but dropping one optional header degrades more
            // gracefully than failing the whole bind.
            if let (Ok(name), Ok(value)) = (
                reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                reqwest::header::HeaderValue::from_str(v),
            ) {
                builder = builder.header(name, value);
            } else {
                tracing::debug!(header = %k, "dropping invalid HTTP header");
            }
        }
        if let Some(body) = req.body {
            builder = builder.body(body);
        }
        builder = builder.timeout(req.timeout);

        let resp = builder.send().await?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            anyhow::bail!("HTTP {} for {}: {}", status.as_u16(), req.url, truncate(&text, 300));
        }
        Ok(text)
    }
}

/// A WebSocket message, reduced to the three cases the channels care about.
///
/// `Ping`/`Pong` are intentionally absent: tungstenite answers protocol-level
/// pings on its own, and both Feishu and DingTalk implement their *application*
/// level heartbeat as a normal data frame (a protobuf CONTROL frame for Feishu,
/// a `{"type":"SYSTEM","headers":{"topic":"ping"}}` JSON frame for DingTalk).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WsMsg {
    Text(String),
    Binary(Vec<u8>),
    Close,
}

/// The write half of a WebSocket connection.
#[async_trait]
pub trait WsSink: Send {
    async fn send(&mut self, msg: WsMsg) -> anyhow::Result<()>;
}

/// The read half of a WebSocket connection. `None` means "stream ended".
#[async_trait]
pub trait WsSource: Send {
    async fn next_msg(&mut self) -> Option<anyhow::Result<WsMsg>>;
}

/// A connected WebSocket, split so the runner loop can `select!` over incoming
/// frames, a heartbeat timer and a cancellation token without borrow conflicts.
pub struct WsPair {
    pub sink: Box<dyn WsSink>,
    pub source: Box<dyn WsSource>,
}

/// Opens WebSocket connections.
#[async_trait]
pub trait WsTransport: Send + Sync {
    async fn connect(&self, url: &str) -> anyhow::Result<WsPair>;
}

/// Production WebSocket transport backed by `tokio-tungstenite`.
#[derive(Debug, Clone, Copy, Default)]
pub struct TungsteniteWs;

#[async_trait]
impl WsTransport for TungsteniteWs {
    async fn connect(&self, url: &str) -> anyhow::Result<WsPair> {
        let connect = tokio_tungstenite::connect_async(url);
        let (stream, _response) = tokio::time::timeout(WS_CONNECT_TIMEOUT, connect)
            .await
            .map_err(|_| anyhow::anyhow!("WebSocket handshake timed out after 30s: {}", url))?
            .map_err(|e| anyhow::anyhow!("WebSocket handshake failed for {}: {}", url, e))?;

        let (sink, source) = stream.split();
        Ok(WsPair {
            sink: Box::new(TtSink(sink)),
            source: Box::new(TtSource(source)),
        })
    }
}

type TtStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

struct TtSink(futures_util::stream::SplitSink<TtStream, tokio_tungstenite::tungstenite::Message>);

#[async_trait]
impl WsSink for TtSink {
    async fn send(&mut self, msg: WsMsg) -> anyhow::Result<()> {
        use tokio_tungstenite::tungstenite::Message;
        let m = match msg {
            WsMsg::Text(t) => Message::Text(t.into()),
            WsMsg::Binary(b) => Message::Binary(b.into()),
            WsMsg::Close => Message::Close(None),
        };
        self.0.send(m).await?;
        Ok(())
    }
}

struct TtSource(futures_util::stream::SplitStream<TtStream>);

#[async_trait]
impl WsSource for TtSource {
    async fn next_msg(&mut self) -> Option<anyhow::Result<WsMsg>> {
        use tokio_tungstenite::tungstenite::Message;
        loop {
            match self.0.next().await {
                None => return Some(Ok(WsMsg::Close)),
                Some(Err(e)) => return Some(Err(anyhow::anyhow!(e.to_string()))),
                Some(Ok(Message::Text(t))) => return Some(Ok(WsMsg::Text(t.to_string()))),
                Some(Ok(Message::Binary(b))) => return Some(Ok(WsMsg::Binary(b.to_vec()))),
                Some(Ok(Message::Close(_))) => return Some(Ok(WsMsg::Close)),
                // Protocol-level ping/pong are handled inside tungstenite; the
                // `Frame` variant never surfaces while reading messages.
                Some(Ok(_)) => continue,
            }
        }
    }
}

/// Convenience alias used across the channel modules.
pub type SharedHttp = Arc<dyn HttpTransport>;
/// Convenience alias used across the channel modules.
pub type SharedWs = Arc<dyn WsTransport>;

pub(crate) fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect::<String>() + "…"
    }
}

#[cfg(test)]
pub mod testing {
    //! Scripted fakes. Kept `pub` under `cfg(test)` so every channel module's
    //! tests can share one implementation instead of growing three near-copies.

    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    /// A canned HTTP responder: matches on a URL substring, returns a body.
    pub struct FakeHttp {
        routes: Mutex<Vec<(String, Result<String, String>)>>,
        pub calls: AtomicUsize,
        pub last_url: Mutex<Option<String>>,
        pub last_body: Mutex<Option<String>>,
        pub last_headers: Mutex<Vec<(String, String)>>,
    }

    impl FakeHttp {
        pub fn new() -> Arc<Self> {
            Arc::new(Self {
                routes: Mutex::new(Vec::new()),
                calls: AtomicUsize::new(0),
                last_url: Mutex::new(None),
                last_body: Mutex::new(None),
                last_headers: Mutex::new(Vec::new()),
            })
        }

        /// Respond with `body` for any URL containing `needle`.
        pub fn on(self: &Arc<Self>, needle: &str, body: impl Into<String>) -> Arc<Self> {
            self.routes.lock().unwrap().push((needle.to_string(), Ok(body.into())));
            self.clone()
        }

        /// Fail (as a transport error) for any URL containing `needle`.
        pub fn fail(self: &Arc<Self>, needle: &str, err: &str) -> Arc<Self> {
            self.routes
                .lock()
                .unwrap()
                .push((needle.to_string(), Err(err.to_string())));
            self.clone()
        }

        pub fn call_count(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl Default for FakeHttp {
        fn default() -> Self {
            Self {
                routes: Mutex::new(Vec::new()),
                calls: AtomicUsize::new(0),
                last_url: Mutex::new(None),
                last_body: Mutex::new(None),
                last_headers: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl HttpTransport for FakeHttp {
        async fn send(&self, req: HttpReq) -> anyhow::Result<String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            *self.last_url.lock().unwrap() = Some(req.url.clone());
            *self.last_body.lock().unwrap() = req.body.clone();
            *self.last_headers.lock().unwrap() = req.headers.clone();

            let routes = self.routes.lock().unwrap();
            for (needle, outcome) in routes.iter() {
                if req.url.contains(needle) {
                    return match outcome {
                        Ok(b) => Ok(b.clone()),
                        Err(e) => anyhow::bail!("{}", e),
                    };
                }
            }
            anyhow::bail!("FakeHttp: no route for {}", req.url)
        }
    }

    /// A WebSocket whose incoming frames are a fixed script.
    pub struct ScriptedSource {
        frames: VecDeque<anyhow::Result<WsMsg>>,
        /// When the script runs out: `true` yields `Close`, `false` parks forever
        /// (so a test can assert "still running" without racing a timer).
        pub close_when_empty: bool,
        parked: tokio::sync::Notify,
    }

    impl ScriptedSource {
        pub fn new(frames: Vec<WsMsg>, close_when_empty: bool) -> Self {
            Self {
                frames: frames.into_iter().map(Ok).collect(),
                close_when_empty,
                parked: tokio::sync::Notify::new(),
            }
        }
    }

    #[async_trait]
    impl WsSource for ScriptedSource {
        async fn next_msg(&mut self) -> Option<anyhow::Result<WsMsg>> {
            if let Some(f) = self.frames.pop_front() {
                return Some(f);
            }
            if self.close_when_empty {
                return Some(Ok(WsMsg::Close));
            }
            // Park until the test drops the connection via cancellation.
            self.parked.notified().await;
            None
        }
    }

    /// Records everything written to it.
    #[derive(Default)]
    pub struct RecordingSink {
        pub sent: Arc<Mutex<Vec<WsMsg>>>,
    }

    impl RecordingSink {
        pub fn new() -> (Self, Arc<Mutex<Vec<WsMsg>>>) {
            let shared = Arc::new(Mutex::new(Vec::new()));
            (Self { sent: shared.clone() }, shared)
        }
    }

    #[async_trait]
    impl WsSink for RecordingSink {
        async fn send(&mut self, msg: WsMsg) -> anyhow::Result<()> {
            self.sent.lock().unwrap().push(msg);
            Ok(())
        }
    }

    /// A `WsTransport` that hands out scripted connections and counts attempts.
    pub struct FakeWs {
        pub attempts: AtomicUsize,
        /// Number of leading attempts that fail with a transport error.
        pub fail_first: AtomicUsize,
        script: Mutex<Vec<Vec<WsMsg>>>,
        pub sinks: Mutex<Vec<Arc<Mutex<Vec<WsMsg>>>>>,
        pub last_url: Mutex<Option<String>>,
    }

    impl FakeWs {
        /// `scripts[i]` is the incoming frame list for connection attempt `i`;
        /// attempts beyond the list reuse the last script.
        pub fn new(scripts: Vec<Vec<WsMsg>>) -> Arc<Self> {
            Arc::new(Self {
                attempts: AtomicUsize::new(0),
                fail_first: AtomicUsize::new(0),
                script: Mutex::new(scripts),
                sinks: Mutex::new(Vec::new()),
                last_url: Mutex::new(None),
            })
        }

        pub fn failing_first(n: usize, scripts: Vec<Vec<WsMsg>>) -> Arc<Self> {
            let ws = Self::new(scripts);
            ws.fail_first.store(n, Ordering::SeqCst);
            ws
        }

        pub fn attempt_count(&self) -> usize {
            self.attempts.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl WsTransport for FakeWs {
        async fn connect(&self, url: &str) -> anyhow::Result<WsPair> {
            let n = self.attempts.fetch_add(1, Ordering::SeqCst);
            *self.last_url.lock().unwrap() = Some(url.to_string());
            if n < self.fail_first.load(Ordering::SeqCst) {
                anyhow::bail!("FakeWs: scripted connection failure #{}", n + 1);
            }
            let frames = {
                let scripts = self.script.lock().unwrap();
                if scripts.is_empty() {
                    Vec::new()
                } else {
                    scripts[n.min(scripts.len() - 1)].clone()
                }
            };
            let (sink, shared) = RecordingSink::new();
            self.sinks.lock().unwrap().push(shared);
            Ok(WsPair {
                sink: Box::new(sink),
                source: Box::new(ScriptedSource::new(frames, true)),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_req_builders_carry_method_body_and_timeout() {
        let g = HttpReq::get("https://example.com/a").header("X", "1");
        assert_eq!(g.method, Method::Get);
        assert!(g.body.is_none());
        assert_eq!(g.timeout, DEFAULT_TIMEOUT);
        assert_eq!(g.headers, vec![("X".to_string(), "1".to_string())]);

        let p = HttpReq::post("https://example.com/b", "{\"a\":1}")
            .with_timeout(LONG_POLL_TIMEOUT);
        assert_eq!(p.method, Method::Post);
        assert_eq!(p.body.as_deref(), Some("{\"a\":1}"));
        assert_eq!(p.timeout, LONG_POLL_TIMEOUT);
    }

    #[test]
    fn truncate_shortens_by_chars_not_bytes() {
        // Chinese text: 3 chars = 9 bytes. A byte-based truncate would panic
        // or produce mojibake on a multi-byte boundary.
        assert_eq!(truncate("你好世界", 2), "你好…");
        assert_eq!(truncate("ab", 5), "ab");
    }

    #[tokio::test]
    async fn fake_http_routes_by_substring_and_records_the_call() {
        let http = testing::FakeHttp::new();
        http.on("endpoint", "{\"code\":0}");
        let out = http
            .send(HttpReq::post("https://open.feishu.cn/callback/ws/endpoint", "{}"))
            .await
            .unwrap();
        assert_eq!(out, "{\"code\":0}");
        assert_eq!(http.call_count(), 1);
        assert_eq!(
            http.last_url.lock().unwrap().as_deref(),
            Some("https://open.feishu.cn/callback/ws/endpoint")
        );
    }

    #[tokio::test]
    async fn fake_http_unrouted_url_is_an_error_not_a_silent_empty_body() {
        let http = testing::FakeHttp::new();
        let err = http.send(HttpReq::get("https://nope/")).await.unwrap_err();
        assert!(err.to_string().contains("no route"), "{}", err);
    }

    #[tokio::test]
    async fn fake_ws_counts_attempts_and_hands_out_scripts() {
        let ws = testing::FakeWs::new(vec![vec![WsMsg::Text("hi".into())]]);
        let mut pair = ws.connect("ws://x").await.unwrap();
        assert_eq!(ws.attempt_count(), 1);
        // `anyhow::Error` is not `PartialEq`, so the nested Option<Result<..>>
        // cannot be compared with assert_eq directly.
        match pair.source.next_msg().await {
            Some(Ok(m)) => assert_eq!(m, WsMsg::Text("hi".into())),
            Some(Err(e)) => panic!("expected a scripted frame, got error: {}", e),
            None => panic!("expected a scripted frame, got end of stream"),
        }
        pair.sink.send(WsMsg::Binary(vec![1, 2])).await.unwrap();
        let sent = ws.sinks.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].lock().unwrap()[0], WsMsg::Binary(vec![1, 2]));
    }

    #[tokio::test]
    async fn fake_ws_can_script_leading_failures() {
        let ws = testing::FakeWs::failing_first(2, vec![vec![]]);
        assert!(ws.connect("ws://x").await.is_err());
        assert!(ws.connect("ws://x").await.is_err());
        assert!(ws.connect("ws://x").await.is_ok());
        assert_eq!(ws.attempt_count(), 3);
    }
}
