//! skills::market — the skill-marketplace pipeline.
//!
//! Rust counterpart of the Java kernel's `com.gourdai.core.portal.web.market`
//! package (`Market`, `MarketManager`, `SkillhubMarket`, `ClawhubMarket`,
//! `ModelscopeMarket`) plus the marketplace half of `WebSettingsController`
//! (`skillsProxy` / `skillsDetail` / `skillsCategories` / `skillsInstall` /
//! `skillsIcon`).
//!
//! ## Contracts this module has to honour verbatim
//!
//! **1. The response envelope is `{code, description, data}`.** Solon's
//! `Result.succeed(data)` sets `code=200` and `description=""` — an *empty*
//! string, not `"succeed"` (verified against the bytecode of
//! `org.noear.solon.core.handle.Result`: `SUCCEED_CODE=200`, `FAILURE_CODE=400`,
//! and `succeed(T)` loads the empty-string constant). `Result.failure(msg)`
//! sets `code=400` and leaves `data` null.
//!
//! **2. `displayName` is marketplace data, never package data.** The installer
//! writes `.skill-market.json` from the *market detail response* only. It must
//! not read a name out of the downloaded `SKILL.md`: the archive is
//! third-party content, so trusting a self-declared display name would let a
//! publisher disguise their skill as any already-installed one. See
//! `super::display_name_of` for the read side of the same boundary.
//!
//! **3. Identity is the canonical name `@owner/slug`, not the bare slug.**
//! Upstream really does let two different authors publish the same public slug
//! (`@user_814dbe54/dev-expert` and `@indiv-ebandao/dev-expert` are two
//! distinct skills whose bare tail is `dev-expert`). Every comparison here is
//! byte-exact on the qualified form, and the qualified-slug test uses
//! `indexOf('/') > 1` — the same boundary the frontend and the Java kernel use.
//!
//! **4. Upstream failure must not be dressed up as success.** A 404, a timeout
//! or an unknown slug all surface as `code=400` with the upstream's own
//! message, exactly as the Java adapters do.
//!
//! ## Deliberate hardening beyond the Java kernel
//!
//! Each of these is a place where the Rust implementation is *stricter* than
//! Java; they are listed here so a future reader does not mistake them for
//! drift:
//!
//! - **Staged install with rollback.** Java deletes the existing skill
//!   directory *before* unzipping, so a failed extraction leaves a half-written
//!   skill behind. Here the archive is unpacked into a dot-prefixed staging
//!   directory, validated, and only then moved into place; the previous
//!   directory is kept as a backup until the move succeeds.
//! - **`SKILL.md` presence check.** Java reports success for any archive that
//!   downloaded, even one with no `SKILL.md` — the UI then says "installed"
//!   while the skill never appears in the registry.
//! - **Zip-slip entries are rejected, not silently skipped**, and both the
//!   compressed download and the uncompressed total are size-capped (zip bomb).
//! - **Icon proxy** additionally refuses CGNAT (`100.64.0.0/10`) and resolves
//!   IPv4-mapped IPv6 addresses before the privacy check.
//!
//! ## Caching
//!
//! The Java kernel keeps **no** server-side cache for any marketplace endpoint:
//! every `proxy` / `detail` / `categories` call goes straight upstream, and the
//! only cache in the whole chain is the browser-side `Cache-Control:
//! public, max-age=86400` the icon proxy emits. This module matches that
//! exactly — introducing a TTL cache here would make a freshly installed skill
//! disappear from "already installed" until the entry expired.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};

use super::{read_market_meta, resolve_skill_md, MarketMeta};

// ─── Response envelope (Solon `Result`) ──────────────────────────────────────

/// `Result.SUCCEED_CODE`.
pub const CODE_SUCCEED: i64 = 200;
/// `Result.FAILURE_CODE` — used by every `Result.failure(...)` overload.
pub const CODE_FAILURE: i64 = 400;

/// `Result.succeed(data)` → `{code:200, description:"", data}`.
///
/// The empty description is load-bearing: the frontend shows
/// `resp.description` verbatim in a toast on failure, and a stray `"succeed"`
/// would leak into any UI that renders it unconditionally.
pub fn succeed(data: Value) -> Value {
    json!({"code": CODE_SUCCEED, "description": "", "data": data})
}

/// `Result.failure(msg)` → `{code:400, description:msg, data:null}`.
pub fn failure(msg: impl Into<String>) -> Value {
    json!({"code": CODE_FAILURE, "description": msg.into(), "data": null})
}

/// Wrap an adapter result into the envelope.
pub fn envelope<T: Serialize>(r: MarketResult<T>) -> Value {
    match r {
        Ok(v) => succeed(serde_json::to_value(v).unwrap_or(Value::Null)),
        Err(e) => failure(e),
    }
}

/// Adapter-level result: `Err(description)` maps to `Result.failure(description)`.
pub type MarketResult<T> = Result<T, String>;

// ─── Upstream HTTP abstraction (injectable, so tests never touch the network) ─

/// What a GET is for; selects the timeouts the Java adapters use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchKind {
    /// List/detail JSON — Java `HttpUtils.timeout(10, 10, 30)` seconds.
    Api,
    /// Skill archive — Java `HttpUtils.timeout(10, 10, 120)` seconds.
    Download,
    /// Icon proxy — Java `setConnectTimeout(8000)` / `setReadTimeout(15000)` ms,
    /// **redirects not followed** (each hop is re-validated by the caller).
    Icon,
}

/// One upstream response, or the transport error that replaced it.
#[derive(Debug, Clone)]
pub struct HttpResult {
    /// HTTP status; `0` when the request never completed.
    pub status: u16,
    pub body: Vec<u8>,
    pub content_type: Option<String>,
    /// `Location` header on a 3xx (icon proxy follows hops manually).
    pub location: Option<String>,
    /// DNS failure / connect timeout / read timeout / TLS error.
    pub error: Option<String>,
}

impl HttpResult {
    /// Transport-level failure (Java: the `HttpUtils` call threw).
    pub fn transport_error(msg: impl Into<String>) -> Self {
        Self { status: 0, body: Vec::new(), content_type: None, location: None, error: Some(msg.into()) }
    }
    pub fn is_ok(&self) -> bool {
        self.error.is_none() && (200..300).contains(&self.status)
    }
    pub fn is_redirect(&self) -> bool {
        (300..400).contains(&self.status)
    }
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    /// Human-readable reason for a failed fetch, used in `description`.
    pub fn failure_reason(&self) -> String {
        if let Some(e) = &self.error {
            return e.clone();
        }
        format!("HTTP {}", self.status)
    }
}

/// Upstream transport. Implemented by [`ReqwestMarketHttp`] in production and
/// by a route table in tests.
#[async_trait::async_trait]
pub trait MarketHttp: Send + Sync {
    async fn get(&self, url: &str, kind: FetchKind) -> HttpResult;
}

/// Production transport on top of `reqwest`.
pub struct ReqwestMarketHttp {
    /// Follows redirects (Java `HttpUtils` does).
    api: reqwest::Client,
    /// Never follows redirects — the icon proxy validates every hop itself.
    icon: reqwest::Client,
}

impl ReqwestMarketHttp {
    pub fn new() -> Self {
        let api = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("reqwest client");
        let icon = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(std::time::Duration::from_secs(8))
            .timeout(std::time::Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("reqwest icon client");
        Self { api, icon }
    }
}

impl Default for ReqwestMarketHttp {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl MarketHttp for ReqwestMarketHttp {
    async fn get(&self, url: &str, kind: FetchKind) -> HttpResult {
        let (client, timeout) = match kind {
            FetchKind::Api => (&self.api, std::time::Duration::from_secs(30)),
            FetchKind::Download => (&self.api, std::time::Duration::from_secs(120)),
            FetchKind::Icon => (&self.icon, std::time::Duration::from_secs(15)),
        };
        let req = client.get(url).timeout(timeout).header("User-Agent", USER_AGENT);
        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => return HttpResult::transport_error(classify_reqwest_error(&e)),
        };
        let status = resp.status().as_u16();
        let content_type = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(String::from);
        let location = resp.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()).map(String::from);
        // The icon proxy caps the body while streaming; everything else reads
        // it whole (Java `bodyAsBytes`) but still under a hard ceiling.
        let cap = match kind {
            FetchKind::Icon => ICON_MAX_BYTES as usize,
            FetchKind::Download => MAX_ARCHIVE_BYTES,
            FetchKind::Api => MAX_API_BODY_BYTES,
        };
        match read_capped(resp, cap).await {
            Ok(Some(body)) => HttpResult { status, body, content_type, location, error: None },
            Ok(None) => HttpResult::transport_error("response body too large"),
            Err(e) => HttpResult::transport_error(classify_reqwest_error(&e)),
        }
    }
}

/// Stream a body, refusing to buffer more than `cap` bytes.
///
/// `Ok(None)` means the cap was exceeded — a truncated body is never returned,
/// mirroring Java's `readCapped` ("half an icon is meaningless").
async fn read_capped(resp: reqwest::Response, cap: usize) -> reqwest::Result<Option<Vec<u8>>> {
    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if buf.len() + chunk.len() > cap {
            return Ok(None);
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(Some(buf))
}

/// Turn a reqwest error into the short reason a user can act on.
fn classify_reqwest_error(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        return "request timed out".to_string();
    }
    if e.is_connect() {
        return "connection failed".to_string();
    }
    if e.is_request() {
        return "request failed".to_string();
    }
    // Decode/other: keep the library text, it is already short.
    e.to_string()
}

// ─── Constants shared with the Java adapters ─────────────────────────────────

/// Java `SkillhubMarket.USER_AGENT` (all three adapters use the same string).
pub const USER_AGENT: &str = "GWork/1.0";

/// Java `SkillhubMarket.BASE_URL`.
pub const SKILLHUB_BASE: &str = "https://api.skillhub.cn";
/// Java `ClawhubMarket.BASE_URL`.
pub const CLAWHUB_BASE: &str = "https://clawhub.ai";
/// Java `ModelscopeMarket.BASE_URL`.
pub const MODELSCOPE_BASE: &str = "https://modelscope.cn/openapi/v1";
/// Java `ModelscopeMarket.SKILLS_PAGE_URL`.
pub const MODELSCOPE_PAGE: &str = "https://www.modelscope.cn/skills";

/// Java `UPSTREAM_MAX_PAGE_SIZE` — 100 works, 200 returns HTTP 400 upstream.
pub const UPSTREAM_MAX_PAGE_SIZE: i64 = 100;

/// Java `WebSettingsController.ICON_MAX_BYTES`.
pub const ICON_MAX_BYTES: u64 = 2 * 1024 * 1024;
/// Java `WebSettingsController.ICON_MAX_REDIRECTS`.
pub const ICON_MAX_REDIRECTS: u32 = 3;

/// Hardening: ceiling on a downloaded skill archive (Java has none).
pub const MAX_ARCHIVE_BYTES: usize = 64 * 1024 * 1024;
/// Hardening: ceiling on an upstream JSON body.
pub const MAX_API_BODY_BYTES: usize = 16 * 1024 * 1024;
/// Hardening: ceiling on the *uncompressed* total of one archive (zip bomb).
pub const MAX_UNCOMPRESSED_BYTES: u64 = 512 * 1024 * 1024;
/// Hardening: ceiling on the number of entries in one archive.
pub const MAX_ZIP_ENTRIES: usize = 20_000;

// ─── Wire models (field names = Java getters, via snack4) ────────────────────

/// Java `MarketItem`.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct MarketItem {
    pub slug: String,
    pub name: String,
    #[serde(rename = "displayName", skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "ownerHandle", skip_serializing_if = "Option::is_none")]
    pub owner_handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub installs: i64,
    pub stars: i64,
    #[serde(rename = "iconUrl", skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// Java `MarketDetail`.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct MarketDetail {
    pub slug: String,
    #[serde(rename = "displayName", skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "ownerHandle", skip_serializing_if = "Option::is_none")]
    pub owner_handle: Option<String>,
    pub installs: i64,
    pub stars: i64,
    #[serde(rename = "installSlug", skip_serializing_if = "Option::is_none")]
    pub install_slug: Option<String>,
    #[serde(rename = "iconUrl", skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
}

/// Java `MarketPageResult`.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct MarketPage {
    pub items: Vec<MarketItem>,
    /// `null`/absent means "no more pages" — the frontend stops infinite scroll
    /// on a falsy `nextCursor`, so a fabricated cursor would loop forever.
    #[serde(rename = "nextCursor", skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    /// Whether the adapter already applied the category filter. When false the
    /// controller filters client-side (Java `skillsProxy`).
    pub filtered: bool,
}

/// Java `MarketCategory`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MarketCategory {
    pub key: String,
    pub name: String,
    #[serde(rename = "nameZh")]
    pub name_zh: String,
}

impl MarketCategory {
    pub fn new(key: &str, name: &str, name_zh: &str) -> Self {
        Self { key: key.into(), name: name.into(), name_zh: name_zh.into() }
    }
}

/// Java `MarketManager.MarketInfo`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MarketInfo {
    pub name: String,
    pub description: String,
}

// ─── Market adapter trait ────────────────────────────────────────────────────

/// Java `com.gourdai.core.portal.web.market.Market`.
#[async_trait::async_trait]
pub trait Market: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;

    /// `Market.categories()` — empty list means "no category support", which
    /// makes the frontend hide the filter bar.
    fn categories(&self) -> Vec<MarketCategory> {
        Vec::new()
    }

    async fn trending(&self, cursor: &str, limit: i64, category: &str) -> MarketResult<MarketPage>;
    async fn search(&self, query: &str, cursor: &str, limit: i64, category: &str) -> MarketResult<MarketPage>;
    async fn detail(&self, slug: &str) -> MarketResult<MarketDetail>;

    /// Download + unpack into `skills_dir`. Returns the display name, which the
    /// controller echoes as `data` (Java `Result.succeed(displayName)`).
    async fn install(&self, slug: &str, skills_dir: &Path) -> MarketResult<String>;

    /// `Market.installDirName(slug)` — the on-disk directory for a slug.
    fn install_dir_name(&self, slug: &str) -> String {
        default_install_dir_name(slug)
    }

    /// Transport handle, so the shared install pipeline can fetch archives.
    fn http(&self) -> Arc<dyn MarketHttp>;
}

/// `Market.installDirName` default: qualified `@owner/slug` → `_owner_slug`
/// (so two authors sharing a bare slug can coexist), bare slug → strip
/// everything outside `[a-zA-Z0-9._-]`.
pub fn default_install_dir_name(slug: &str) -> String {
    if is_qualified_slug(slug) {
        slug.chars().map(|c| if c == '@' || c == '/' { '_' } else { c }).collect()
    } else {
        strip_to_slug_chars(slug)
    }
}

/// Keep only `[a-zA-Z0-9._-]` (Java `slug.replaceAll("[^a-zA-Z0-9._-]", "")`).
pub fn strip_to_slug_chars(slug: &str) -> String {
    slug.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '_' || *c == '-')
        .collect()
}

/// Keep only `[a-zA-Z0-9@._/-]` (Java `ModelscopeMarket` keeps `@` and `/`).
pub fn strip_to_modelscope_chars(slug: &str) -> String {
    slug.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '.' | '_' | '/' | '-'))
        .collect()
}

/// Namespace-qualified slug: starts with `@`, has a `/` whose index is **> 1**,
/// and has a non-empty tail.
///
/// The `> 1` (not `> 0`) boundary is shared with the frontend's
/// `marketBareSlug` and Java's `SkillhubMarket.isQualifiedSlug`; drifting on it
/// makes `@/slug` qualified on one side and bare on the other, so the install
/// directory and the metadata written for it would disagree.
pub fn is_qualified_slug(slug: &str) -> bool {
    if !slug.starts_with('@') {
        return false;
    }
    match slug.find('/') {
        // Byte index of '/' — for `@`-prefixed ASCII owners this equals the
        // character index Java's `indexOf` returns.
        Some(i) => i > 1 && i < slug.len() - 1,
        None => false,
    }
}

/// `@owner/slug` → `slug`; anything else verbatim (Java
/// `SkillDisplayNames.marketBareSlug`). Delegates to the registry helper so
/// there is exactly one implementation of the boundary rule.
pub fn market_bare_slug(slug: &str) -> String {
    super::market_bare_slug(slug).unwrap_or_default()
}

/// `URLEncoder.encode(s, "UTF-8")` parity, implemented directly rather than via
/// `form_urlencoded`: Java keeps `a-zA-Z0-9` plus `. - * _`, turns a space into
/// `+`, and percent-encodes every other UTF-8 byte (including `~`, which the
/// WHATWG encoder leaves alone). A subtle difference here would send a different
/// slug upstream and resolve the wrong skill.
pub fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'.' | b'-' | b'*' | b'_' => out.push(*b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

// ─── JSON helpers (ONode parity) ─────────────────────────────────────────────

/// `getStringValue(node, key)`: absent/null → None, otherwise the scalar as a
/// string (ONode stringifies numbers and booleans too).
fn jstr(node: &Value, key: &str) -> Option<String> {
    match node.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        Some(Value::Bool(b)) => Some(b.to_string()),
        Some(other) => Some(other.to_string()),
    }
}

/// `getLongValue(node, key)`: absent/null/unparseable → 0. Tolerates the
/// stringified numbers some upstreams return.
fn jnum(node: &Value, key: &str) -> i64 {
    match node.get(key) {
        None | Some(Value::Null) => 0,
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)).unwrap_or(0),
        Some(Value::String(s)) => s.trim().parse::<i64>().unwrap_or(0),
        Some(Value::Bool(b)) => i64::from(*b),
        _ => 0,
    }
}

/// `firstNonEmpty(...)`: first non-null, non-empty string.
fn first_non_empty<'a>(vals: impl IntoIterator<Item = Option<&'a String>>) -> Option<String> {
    vals.into_iter().flatten().find(|s| !s.is_empty()).cloned()
}

/// `parsePageFromCursor`: the cursor *is* the upstream page number; anything
/// unparsable or non-positive falls back to page 1.
pub fn parse_page_from_cursor(cursor: &str) -> i64 {
    let t = cursor.trim();
    if t.is_empty() {
        return 1;
    }
    match t.parse::<i64>() {
        Ok(p) if p > 0 => p,
        _ => 1,
    }
}

/// `pageSize` selection shared by skillhub and modelscope.
fn page_size_for(limit: i64) -> i64 {
    if limit > 0 && limit <= UPSTREAM_MAX_PAGE_SIZE {
        limit
    } else {
        20
    }
}

/// `nextCursor` from the real total: only when this page is non-empty *and*
/// `page * pageSize < total`. Fabricating a cursor would make the frontend's
/// infinite scroll request a page that does not exist.
fn next_cursor_for(items_empty: bool, page: i64, page_size: i64, total: i64) -> Option<String> {
    if !items_empty && page.saturating_mul(page_size) < total {
        Some((page + 1).to_string())
    } else {
        None
    }
}

/// Parse an upstream body, mapping a transport/HTTP failure onto the adapter's
/// error prefix (Java wraps the thrown exception message the same way).
async fn fetch_json(http: &dyn MarketHttp, url: &str, err_prefix: &str) -> MarketResult<Value> {
    let r = http.get(url, FetchKind::Api).await;
    if let Some(e) = &r.error {
        return Err(format!("{}{}", err_prefix, e));
    }
    if !r.is_ok() {
        return Err(format!("{}{}", err_prefix, r.failure_reason()));
    }
    serde_json::from_slice::<Value>(&r.body)
        .map_err(|e| format!("{}{}", err_prefix, e))
}

// ─── SkillHub (default market) ───────────────────────────────────────────────

/// Java `SkillhubMarket`.
pub struct SkillhubMarket {
    http: Arc<dyn MarketHttp>,
}

impl SkillhubMarket {
    pub fn new(http: Arc<dyn MarketHttp>) -> Self {
        Self { http }
    }

    /// `fetchPaged` — real pagination against `GET /api/skills`.
    async fn fetch_paged(
        &self,
        query: Option<&str>,
        cursor: &str,
        limit: i64,
        category: &str,
        err_prefix: &str,
    ) -> MarketResult<MarketPage> {
        let page_size = page_size_for(limit);
        let page = parse_page_from_cursor(cursor);
        let is_search = query.map(|q| !q.is_empty()).unwrap_or(false);
        let has_category = !category.is_empty();

        let mut url = format!(
            "{}/api/skills?page={}&pageSize={}&sortBy={}",
            SKILLHUB_BASE,
            page,
            page_size,
            if is_search { "score" } else { "downloads" }
        );
        if let Some(q) = query.filter(|q| !q.is_empty()) {
            url.push_str("&keyword=");
            url.push_str(&url_encode(q));
        }
        if has_category {
            url.push_str("&category=");
            url.push_str(&url_encode(category));
        }

        let root = fetch_json(self.http.as_ref(), &url, err_prefix).await?;

        // `code` present, non-null and != 0 → upstream error. A missing `code`
        // is treated as success, exactly as the Java adapter does.
        if let Some(code) = root.get("code") {
            if !code.is_null() && jnum(&root, "code") != 0 {
                let msg = jstr(&root, "message").unwrap_or_else(|| "upstream error".into());
                return Err(format!("{}{}", err_prefix, msg));
            }
        }

        let data = root.get("data").cloned().unwrap_or(Value::Null);
        let total = jnum(&data, "total");
        let items = parse_skillhub_skills(&data);
        let next_cursor = next_cursor_for(items.is_empty(), page, page_size, total);
        // The category filter is applied server-side by this upstream, so the
        // controller must not filter the page a second time.
        Ok(MarketPage { items, next_cursor, filtered: has_category })
    }

    /// `detailQualified` — the upstream detail endpoint rejects `@owner/slug`
    /// (HTTP 405 in practice), so search the bare tail and pick the item whose
    /// qualified slug matches byte-for-byte.
    async fn detail_qualified(&self, qualified: &str) -> MarketResult<MarketDetail> {
        let bare = match qualified.find('/') {
            Some(i) => qualified[i + 1..].to_string(),
            None => return Err(format!("技能不存在: {}", qualified)),
        };
        let page = self.search(&bare, "", UPSTREAM_MAX_PAGE_SIZE, "").await?;
        // Byte-exact match on the canonical name: two authors may share `bare`,
        // and picking the first hit would install the wrong publisher's skill.
        let hit = page.items.iter().find(|it| it.slug == qualified);
        match hit {
            Some(it) => Ok(MarketDetail {
                slug: it.slug.clone(),
                display_name: it.display_name.clone(),
                summary: it.summary.clone(),
                description: it.description.clone(),
                owner_handle: it.owner_handle.clone(),
                installs: it.installs,
                stars: it.stars,
                icon_url: it.icon_url.clone(),
                category: it.category.clone(),
                version: it.version.clone(),
                install_slug: Some(it.slug.clone()),
                tags: None,
            }),
            None => Err(format!("技能不存在: {}", qualified)),
        }
    }
}

/// `parseSkills` for `GET /api/skills`.
///
/// The published slug is rewritten to its namespace-qualified form whenever an
/// owner handle is known, because the upstream really does list two different
/// authors under the same bare slug. Keeping the bare slug would make the
/// detail/download calls resolve to whichever author the upstream feels like,
/// and would light up the "installed" badge on both cards.
fn parse_skillhub_skills(data: &Value) -> Vec<MarketItem> {
    let Some(skills) = data.get("skills").and_then(|s| s.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(skills.len());
    for node in skills {
        let raw_slug = jstr(node, "slug").unwrap_or_default();

        let owner_for_slug = node
            .get("namespace")
            .filter(|n| !n.is_null())
            .and_then(|n| jstr(n, "handle"))
            .filter(|s| !s.is_empty())
            .or_else(|| jstr(node, "ownerName").filter(|s| !s.is_empty()));

        let slug = match &owner_for_slug {
            Some(owner) if !raw_slug.is_empty() && !raw_slug.starts_with('@') => {
                format!("@{}/{}", owner, raw_slug)
            }
            _ => raw_slug.clone(),
        };

        let installs = jnum(node, "installs");
        let downloads = jnum(node, "downloads");
        let owner = jstr(node, "ownerName")
            .filter(|s| !s.is_empty())
            .or_else(|| node.get("namespace").filter(|n| !n.is_null()).and_then(|n| jstr(n, "handle")));
        let desc = first_non_empty([jstr(node, "description_zh").as_ref(), jstr(node, "description").as_ref()]);
        let url = first_non_empty([jstr(node, "homepage").as_ref()])
            .unwrap_or_else(|| format!("https://skillhub.cn/skills/{}", slug));

        out.push(MarketItem {
            display_name: Some(first_non_empty([jstr(node, "name").as_ref()]).unwrap_or_else(|| slug.clone())),
            name: slug.clone(),
            summary: desc.clone(),
            description: desc,
            installs: if installs > 0 { installs } else { downloads },
            stars: jnum(node, "stars"),
            icon_url: jstr(node, "iconUrl"),
            category: jstr(node, "category"),
            version: jstr(node, "version"),
            owner_handle: owner,
            url: Some(url),
            slug,
        });
    }
    out
}

/// `parseTags` — upstream `tags` has been observed as an empty object, a string
/// array and a key/value map. All three collapse to a de-duplicated string
/// list; tags are decoration in the detail dialog and never worth an error.
pub fn parse_tags(node: Option<&Value>) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    let Some(n) = node else { return tags };
    let mut push = |v: Option<String>| {
        if let Some(s) = v {
            if !s.is_empty() && !tags.contains(&s) {
                tags.push(s);
            }
        }
    };
    match n {
        Value::Array(arr) => {
            for item in arr {
                push(scalar_to_string(item));
            }
        }
        Value::Object(map) => {
            for (_, v) in map {
                push(scalar_to_string(v));
            }
        }
        _ => {}
    }
    tags
}

fn scalar_to_string(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        other => Some(other.to_string()),
    }
}

#[async_trait::async_trait]
impl Market for SkillhubMarket {
    fn name(&self) -> &str {
        "skillhub.cn"
    }
    fn description(&self) -> &str {
        "专为中国用户优化的技能社区"
    }
    fn categories(&self) -> Vec<MarketCategory> {
        vec![
            MarketCategory::new("ai-agent", "AI Agent", "AI 智能体"),
            MarketCategory::new("dev-programming", "Development", "开发编程"),
            MarketCategory::new("office-efficiency", "Office Efficiency", "办公效率"),
            MarketCategory::new("content-creation", "Content Creation", "内容创作"),
            MarketCategory::new("data-analysis", "Data Analysis", "数据分析"),
            MarketCategory::new("design-media", "Design & Media", "设计媒体"),
            MarketCategory::new("business-ops", "Business Ops", "商业运营"),
            MarketCategory::new("it-ops-security", "IT Ops & Security", "运维安全"),
            MarketCategory::new("professional", "Professional", "专业服务"),
            MarketCategory::new("life-service", "Life Service", "生活服务"),
        ]
    }

    async fn trending(&self, cursor: &str, limit: i64, category: &str) -> MarketResult<MarketPage> {
        self.fetch_paged(None, cursor, limit, category, "获取热门技能失败: ").await
    }

    async fn search(&self, query: &str, cursor: &str, limit: i64, category: &str) -> MarketResult<MarketPage> {
        if query.is_empty() {
            return self.trending(cursor, limit, category).await;
        }
        self.fetch_paged(Some(query), cursor, limit, category, "搜索技能失败: ").await
    }

    async fn detail(&self, slug: &str) -> MarketResult<MarketDetail> {
        if slug.is_empty() {
            return Err("slug is required".into());
        }
        if is_qualified_slug(slug) {
            return self.detail_qualified(slug).await;
        }
        let url = format!("{}/api/v1/skills/{}", SKILLHUB_BASE, url_encode(slug));
        let root = fetch_json(self.http.as_ref(), &url, "获取技能详情失败: ").await?;
        if root.get("error").is_some() {
            return Err(jstr(&root, "message").unwrap_or_else(|| "技能不存在".into()));
        }
        let Some(skill) = root.get("skill") else {
            return Err(format!("技能不存在: {}", slug));
        };
        let resolved = jstr(skill, "slug").unwrap_or_else(|| slug.to_string());
        let summary = first_non_empty([jstr(skill, "summary_zh").as_ref(), jstr(skill, "summary").as_ref()]);
        let stats = skill.get("stats").cloned().unwrap_or(Value::Null);
        let owner = root.get("owner").and_then(|o| jstr(o, "handle"));
        let version = root.get("latestVersion").and_then(|v| jstr(v, "version"));
        let overview = jstr(skill, "overviewMd");
        // The download endpoint only resolves a **namespace-qualified** slug
        // (`@owner/slug`); a bare slug answers 404 "Version not found" even
        // though the detail endpoint accepts it. The detail response carries
        // the qualified form in `namespace.canonicalName`, so prefer it for
        // `install_slug` — that is what `install` downloads with. Without this
        // every bare-slug install (detail-dialog direct links, legacy cards)
        // fails with a 404 the user cannot act on.
        let canonical = root
            .get("namespace")
            .filter(|n| !n.is_null())
            .and_then(|n| jstr(n, "canonicalName"))
            .filter(|s| is_qualified_slug(s));
        let install_slug = canonical.unwrap_or_else(|| resolved.clone());
        Ok(MarketDetail {
            description: overview.or_else(|| summary.clone()),
            summary,
            slug: resolved,
            display_name: jstr(skill, "displayName"),
            owner_handle: owner,
            installs: jnum(&stats, "installs"),
            stars: jnum(&stats, "stars"),
            icon_url: jstr(skill, "iconUrl"),
            category: jstr(skill, "category"),
            version,
            tags: Some(parse_tags(skill.get("tags"))),
            install_slug: Some(install_slug),
        })
    }

    async fn install(&self, slug: &str, skills_dir: &Path) -> MarketResult<String> {
        if slug.is_empty() {
            return Err("slug is required".into());
        }
        // A qualified slug is passed to the download endpoint verbatim (it
        // resolves to the right author); a bare slug is stripped first.
        let effective = if is_qualified_slug(slug) {
            slug.to_string()
        } else {
            let s = strip_to_slug_chars(slug);
            if s.is_empty() {
                return Err("Invalid slug".into());
            }
            s
        };
        let dir_name = self.install_dir_name(&effective);
        if dir_name.is_empty() {
            return Err("Invalid slug".into());
        }

        let detail = match self.detail(&effective).await {
            Ok(d) => d,
            Err(e) => return Err(format!("技能不存在: {}", e)),
        };
        let display_name = detail
            .display_name
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| effective.clone());

        // Download with the slug the *upstream* resolves, not the one the user
        // clicked: `/api/v1/download` answers 404 "Version not found" for a
        // bare slug and only redirects to the real zip for the qualified
        // `@owner/slug` form, which `detail` reports via
        // `namespace.canonicalName`. The install directory still derives from
        // `effective` so a bare-slug install lands where the UI expects it.
        let download_slug = detail
            .install_slug
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| effective.clone());

        let download_url = format!("{}/api/v1/download?slug={}", SKILLHUB_BASE, url_encode(&download_slug));
        run_install(
            self.http.as_ref(),
            &download_url,
            skills_dir,
            &dir_name,
            &display_name,
            self.name(),
            slug,
            detail.icon_url.as_deref().unwrap_or(""),
            detail.version.as_deref().unwrap_or(""),
            UnpackMode::AsIs,
        )
        .await
    }

    fn http(&self) -> Arc<dyn MarketHttp> {
        self.http.clone()
    }
}

// ─── ClawHub ─────────────────────────────────────────────────────────────────

/// Java `ClawhubMarket`.
pub struct ClawhubMarket {
    http: Arc<dyn MarketHttp>,
}

impl ClawhubMarket {
    pub fn new(http: Arc<dyn MarketHttp>) -> Self {
        Self { http }
    }
}

/// `parseNodeArray` — clawhub list items.
fn parse_clawhub_items(arr: &[Value]) -> Vec<MarketItem> {
    let mut out = Vec::with_capacity(arr.len());
    for node in arr {
        let slug = jstr(node, "slug").unwrap_or_default();
        let url = jstr(node, "url").unwrap_or_else(|| format!("{}/skills/{}", CLAWHUB_BASE, slug));
        let stats = node.get("stats").cloned().unwrap_or(Value::Null);
        out.push(MarketItem {
            display_name: jstr(node, "displayName"),
            summary: jstr(node, "summary"),
            description: jstr(node, "description").as_deref().and_then(strip_skill_md_frontmatter),
            owner_handle: jstr(node, "ownerHandle"),
            version: clawhub_latest_version(node),
            installs: jnum(&stats, "installsCurrent"),
            stars: jnum(&stats, "stars"),
            name: slug.clone(),
            url: Some(url),
            slug,
            icon_url: None,
            category: None,
        });
    }
    out
}

/// Strip a SKILL.md YAML frontmatter head from clawhub's raw `description`.
///
/// Observed live (2026-11, `clawhub.ai/api/v1/skills/{slug}`): `skill.description`
/// is the **verbatim SKILL.md** — a `---` frontmatter block (name/description/
/// metadata keys) leads the text, and the detail dialog rendered it straight to
/// the user (`---\nname: xxx\n...`). Rule (Java `stripSkillMdFrontmatter`
/// parity): when the first line is exactly `---` and a later line is exactly
/// `---`, drop everything through that closing line; otherwise return the text
/// untouched — showing too much beats deleting body text.
pub fn strip_skill_md_frontmatter(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    if !text.starts_with("---") {
        return Some(text.to_string());
    }
    // first line must be exactly `---` (line end right after the dashes)
    match bytes.get(3) {
        None | Some(b'\n') => {}
        Some(b'\r') => {}
        Some(_) => return Some(text.to_string()),
    }
    let mut search = 3;
    while let Some(rel) = text[search..].find("\n---") {
        let close = search + rel;
        let mut after = close + 4; // skip \n---
        if bytes.get(after) == Some(&b'\r') {
            after += 1;
        }
        let line_end = after >= bytes.len() || bytes[after] == b'\n';
        if line_end {
            let rest = if after >= bytes.len() { "" } else { text[after + 1..].trim_start() };
            return if rest.is_empty() { None } else { Some(rest.to_string()) };
        }
        search = close + 4; // `---foo` body line: keep looking for the real close
    }
    Some(text.to_string()) // unclosed fence: keep as-is
}

/// `extractLatestVersion`: `latestVersion.version`, falling back to `tags.latest`.
pub fn clawhub_latest_version(node: &Value) -> Option<String> {
    if let Some(v) = node.get("latestVersion").filter(|n| !n.is_null()).and_then(|lv| jstr(lv, "version")) {
        if !v.is_empty() {
            return Some(v);
        }
    }
    node.get("tags")
        .filter(|n| !n.is_null())
        .and_then(|t| jstr(t, "latest"))
        .filter(|v| !v.is_empty())
}

#[async_trait::async_trait]
impl Market for ClawhubMarket {
    fn name(&self) -> &str {
        "clawhub.ai"
    }
    fn description(&self) -> &str {
        ""
    }

    async fn trending(&self, cursor: &str, limit: i64, _category: &str) -> MarketResult<MarketPage> {
        // clawhub ignores page/offset and only honours a cursor; `sort=trending`
        // suppresses `nextCursor`, so no sort parameter is sent (Java parity).
        let mut url = format!("{}/api/v1/skills?limit={}", CLAWHUB_BASE, limit);
        if !cursor.is_empty() {
            url.push_str("&cursor=");
            url.push_str(&url_encode(cursor));
        }
        let root = fetch_json(self.http.as_ref(), &url, "获取热门技能失败: ").await?;
        if root.get("error").is_some() {
            return Err(jstr(&root, "message").unwrap_or_else(|| "upstream error".into()));
        }
        let items = root.get("items").and_then(|i| i.as_array()).map(|a| parse_clawhub_items(a)).unwrap_or_default();
        Ok(MarketPage { items, next_cursor: jstr(&root, "nextCursor"), filtered: false })
    }

    async fn search(&self, query: &str, cursor: &str, limit: i64, _category: &str) -> MarketResult<MarketPage> {
        if query.is_empty() {
            return self.trending(cursor, limit, "").await;
        }
        let mut url = format!("{}/api/v1/search?q={}&limit={}", CLAWHUB_BASE, url_encode(query), limit);
        if !cursor.is_empty() {
            url.push_str("&cursor=");
            url.push_str(&url_encode(cursor));
        }
        let root = fetch_json(self.http.as_ref(), &url, "搜索技能失败: ").await?;
        if root.get("error").is_some() {
            return Err(jstr(&root, "message").unwrap_or_else(|| "upstream error".into()));
        }
        // The search endpoint nests results under `results`; older shapes use `items`.
        let items = root
            .get("results")
            .and_then(|r| r.as_array())
            .or_else(|| root.get("items").and_then(|i| i.as_array()))
            .map(|a| parse_clawhub_items(a))
            .unwrap_or_default();
        Ok(MarketPage { items, next_cursor: jstr(&root, "nextCursor"), filtered: false })
    }

    async fn detail(&self, slug: &str) -> MarketResult<MarketDetail> {
        if slug.is_empty() {
            return Err("slug is required".into());
        }
        let url = format!("{}/api/v1/skills/{}", CLAWHUB_BASE, url_encode(slug));
        let root = fetch_json(self.http.as_ref(), &url, "获取技能详情失败: ").await?;
        if root.get("error").is_some() {
            return Err(jstr(&root, "message").unwrap_or_else(|| "upstream error".into()));
        }
        let Some(skill) = root.get("skill").filter(|s| !s.is_null()) else {
            return Err(format!("技能不存在: {}", slug));
        };
        let stats = skill.get("stats").cloned().unwrap_or(Value::Null);
        let resolved = jstr(skill, "slug").unwrap_or_else(|| slug.to_string());
        Ok(MarketDetail {
            display_name: jstr(skill, "displayName"),
            summary: jstr(skill, "summary"),
            description: jstr(skill, "description").as_deref().and_then(strip_skill_md_frontmatter),
            owner_handle: jstr(skill, "ownerHandle"),
            icon_url: jstr(skill, "icon"),
            installs: jnum(&stats, "installsCurrent"),
            stars: jnum(&stats, "stars"),
            version: root.get("latestVersion").filter(|v| !v.is_null()).and_then(|lv| jstr(lv, "version")),
            install_slug: Some(resolved.clone()),
            slug: resolved,
            category: None,
            tags: None,
        })
    }

    async fn install(&self, slug: &str, skills_dir: &Path) -> MarketResult<String> {
        if slug.is_empty() {
            return Err("slug is required".into());
        }
        let effective = strip_to_slug_chars(slug);
        if effective.is_empty() {
            return Err("Invalid slug".into());
        }
        let detail = match self.detail(&effective).await {
            Ok(d) => d,
            Err(e) => return Err(format!("技能不存在: {}", e)),
        };
        let display_name = detail
            .display_name
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| effective.clone());
        let download_url = format!("{}/api/v1/download?slug={}", CLAWHUB_BASE, url_encode(&effective));
        run_install(
            self.http.as_ref(),
            &download_url,
            skills_dir,
            &effective,
            &display_name,
            self.name(),
            slug,
            detail.icon_url.as_deref().unwrap_or(""),
            detail.version.as_deref().unwrap_or(""),
            UnpackMode::AsIs,
        )
        .await
    }

    fn http(&self) -> Arc<dyn MarketHttp> {
        self.http.clone()
    }
}

// ─── ModelScope ──────────────────────────────────────────────────────────────

/// Java `ModelscopeMarket`.
pub struct ModelscopeMarket {
    http: Arc<dyn MarketHttp>,
}

impl ModelscopeMarket {
    pub fn new(http: Arc<dyn MarketHttp>) -> Self {
        Self { http }
    }

    async fn fetch_paged(&self, query: Option<&str>, cursor: &str, limit: i64, err_prefix: &str) -> MarketResult<MarketPage> {
        let page_size = page_size_for(limit);
        let page = parse_page_from_cursor(cursor);
        let mut url = format!("{}/skills?page_number={}&page_size={}", MODELSCOPE_BASE, page, page_size);
        if let Some(q) = query.filter(|q| !q.is_empty()) {
            url.push_str("&search=");
            url.push_str(&url_encode(q));
        } else {
            url.push_str("&sort=downloads");
        }
        let root = fetch_json(self.http.as_ref(), &url, err_prefix).await?;
        if !upstream_success(&root) {
            return Err(format!("{}{}", err_prefix, upstream_error(&root)));
        }
        let data = root.get("data").cloned().unwrap_or(Value::Null);
        let items = parse_modelscope_skills(&data);
        let total = jnum(&data, "total");
        let next_cursor = next_cursor_for(items.is_empty(), page, page_size, total);
        Ok(MarketPage { items, next_cursor, filtered: false })
    }

    /// `fetchSkillNode` — shared by detail and install so one install does not
    /// pay for two detail requests.
    async fn fetch_skill_node(&self, slug: &str) -> MarketResult<Option<Value>> {
        // ModelScope ids look like `@author/skill`; `@` and `/` are sent raw.
        let url = format!("{}/skills/{}", MODELSCOPE_BASE, slug);
        let root = fetch_json(self.http.as_ref(), &url, "获取技能详情失败: ").await?;
        if !upstream_success(&root) {
            return Ok(None);
        }
        Ok(root.get("data").filter(|d| !d.is_null()).cloned())
    }
}

fn upstream_success(root: &Value) -> bool {
    root.get("success").and_then(|s| s.as_bool()).unwrap_or(false)
}

fn upstream_error(root: &Value) -> String {
    jstr(root, "message").filter(|m| !m.is_empty()).unwrap_or_else(|| "upstream error".into())
}

/// `preferZhDescription`: `locales.zh.description` first, then `description`.
fn prefer_zh_description(node: &Value) -> Option<String> {
    let zh = node
        .get("locales")
        .filter(|l| !l.is_null())
        .and_then(|l| l.get("zh"))
        .filter(|z| !z.is_null())
        .and_then(|z| jstr(z, "description"))
        .filter(|s| !s.is_empty());
    zh.or_else(|| jstr(node, "description"))
}

fn parse_modelscope_skills(data: &Value) -> Vec<MarketItem> {
    let Some(skills) = data.get("skills").and_then(|s| s.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(skills.len());
    for node in skills {
        let Some(id) = jstr(node, "id").filter(|s| !s.is_empty()) else { continue };
        let desc = prefer_zh_description(node);
        let url = jstr(node, "source_url")
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("{}/{}", MODELSCOPE_PAGE, id));
        out.push(MarketItem {
            display_name: Some(first_non_empty([jstr(node, "display_name").as_ref()]).unwrap_or_else(|| id.clone())),
            summary: desc.clone(),
            description: desc,
            owner_handle: jstr(node, "developer"),
            installs: jnum(node, "downloads"),
            stars: jnum(node, "view_count"),
            icon_url: jstr(node, "logo_url"),
            category: jstr(node, "category"),
            name: id.clone(),
            url: Some(url),
            slug: id,
            version: None,
        });
    }
    out
}

/// `filterByCategory` — this upstream ignores every category parameter, so the
/// page is filtered client-side and `filtered` is set to stop the controller
/// from filtering it a second time.
pub fn filter_by_category(page: &mut MarketPage, category: &str) {
    if category.is_empty() {
        return;
    }
    page.items.retain(|it| it.category.as_deref() == Some(category));
    page.filtered = true;
}

/// `buildGitHubFallbackUrl`.
pub fn github_fallback_url(source_url: Option<&str>) -> Option<String> {
    let src = source_url?;
    if src.is_empty() {
        return None;
    }
    if !src.starts_with("https://github.com/") && !src.starts_with("https://www.github.com/") {
        return None;
    }
    let parsed = url::Url::parse(src).ok()?;
    let mut path = parsed.path().trim_start_matches('/').to_string();
    if let Some(stripped) = path.strip_suffix(".git") {
        path = stripped.to_string();
    }
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() < 2 {
        return None;
    }
    let branch = if parts.len() >= 4 && parts[2] == "tree" { parts[3] } else { "HEAD" };
    Some(format!("https://github.com/{}/{}/archive/refs/heads/{}.zip", parts[0], parts[1], branch))
}

#[async_trait::async_trait]
impl Market for ModelscopeMarket {
    fn name(&self) -> &str {
        "modelscope.cn"
    }
    fn description(&self) -> &str {
        "魔搭社区技能广场"
    }
    fn categories(&self) -> Vec<MarketCategory> {
        vec![
            MarketCategory::new("ai-media", "AI Media", "AI 多媒体"),
            MarketCategory::new("developer-tools", "Developer Tools", "开发工具"),
            MarketCategory::new("marketing-seo", "Marketing & SEO", "营销 SEO"),
            MarketCategory::new("skill-management", "Skill Management", "技能管理"),
            MarketCategory::new("cloud-devops", "Cloud & DevOps", "云与运维"),
            MarketCategory::new("frontend-development", "Frontend Dev", "前端开发"),
            MarketCategory::new("scientific-tool", "Scientific Tools", "科研工具"),
            MarketCategory::new("code-quality-testing", "Code Quality & Testing", "代码质量与测试"),
            MarketCategory::new("mobile-development", "Mobile Dev", "移动开发"),
            MarketCategory::new("doc-processing", "Doc Processing", "文档处理"),
            MarketCategory::new("ai-automation", "AI Automation", "AI 自动化"),
            MarketCategory::new("other", "Other", "其他"),
        ]
    }

    /// `@owner/name` → `_owner_name`, byte-identical to what `install` uses.
    fn install_dir_name(&self, slug: &str) -> String {
        strip_to_modelscope_chars(slug).replace(['@', '/'], "_")
    }

    async fn trending(&self, cursor: &str, limit: i64, category: &str) -> MarketResult<MarketPage> {
        let mut page = self.fetch_paged(None, cursor, limit, "获取热门技能失败: ").await?;
        filter_by_category(&mut page, category);
        Ok(page)
    }

    async fn search(&self, query: &str, cursor: &str, limit: i64, category: &str) -> MarketResult<MarketPage> {
        if query.is_empty() {
            return self.trending(cursor, limit, category).await;
        }
        let mut page = self.fetch_paged(Some(query), cursor, limit, "搜索技能失败: ").await?;
        filter_by_category(&mut page, category);
        Ok(page)
    }

    async fn detail(&self, slug: &str) -> MarketResult<MarketDetail> {
        if slug.is_empty() {
            return Err("slug is required".into());
        }
        let Some(data) = self.fetch_skill_node(slug).await? else {
            return Err(format!("技能不存在: {}", slug));
        };
        let id = jstr(&data, "id").unwrap_or_else(|| slug.to_string());
        let desc = prefer_zh_description(&data);
        Ok(MarketDetail {
            display_name: Some(first_non_empty([jstr(&data, "display_name").as_ref()]).unwrap_or_else(|| id.clone())),
            summary: desc.clone(),
            description: desc,
            owner_handle: jstr(&data, "developer"),
            installs: jnum(&data, "downloads"),
            stars: jnum(&data, "view_count"),
            icon_url: jstr(&data, "logo_url"),
            category: jstr(&data, "category"),
            install_slug: Some(id.clone()),
            slug: id,
            version: None,
            tags: None,
        })
    }

    async fn install(&self, slug: &str, skills_dir: &Path) -> MarketResult<String> {
        if slug.is_empty() {
            return Err("slug is required".into());
        }
        let safe = strip_to_modelscope_chars(slug);
        if safe.is_empty() {
            return Err("Invalid slug".into());
        }
        let Some(data) = self.fetch_skill_node(&safe).await? else {
            return Err(format!("技能不存在: {}", safe));
        };
        let display_name =
            first_non_empty([jstr(&data, "display_name").as_ref()]).unwrap_or_else(|| safe.clone());
        let dir_name = self.install_dir_name(&safe);

        let primary = format!("{}/{}/archive/zip/master", MODELSCOPE_PAGE, safe);
        let fallback = github_fallback_url(jstr(&data, "source_url").as_deref());

        // Primary source first, GitHub archive as the fallback (Java parity).
        let bytes = match download_archive(self.http.as_ref(), &primary).await {
            Ok(b) => b,
            Err(primary_err) => {
                match &fallback {
                    Some(fb) => download_archive(self.http.as_ref(), fb).await.map_err(|e| {
                        format!("下载技能包失败: 所有下载源均不可用 ({}; {})", primary_err, e)
                    })?,
                    None => return Err(format!("下载技能包失败: 所有下载源均不可用 ({})", primary_err)),
                }
            }
        };

        place_archive(
            bytes,
            skills_dir,
            &dir_name,
            &display_name,
            self.name(),
            slug,
            jstr(&data, "logo_url").as_deref().unwrap_or(""),
            jstr(&data, "version").as_deref().unwrap_or(""),
            UnpackMode::StripSingleRoot,
        )
        .await
    }

    fn http(&self) -> Arc<dyn MarketHttp> {
        self.http.clone()
    }
}

// ─── MarketManager ───────────────────────────────────────────────────────────

/// Java `MarketManager`: registration order is preserved and an unknown or
/// empty name falls back to the default market rather than erroring.
pub struct MarketManager {
    markets: Vec<Arc<dyn Market>>,
    default_index: usize,
}

impl MarketManager {
    /// Register the same three adapters, in the same order, with the same
    /// default as the Java kernel.
    pub fn new(http: Arc<dyn MarketHttp>) -> Self {
        let markets: Vec<Arc<dyn Market>> = vec![
            Arc::new(SkillhubMarket::new(http.clone())),
            Arc::new(ClawhubMarket::new(http.clone())),
            Arc::new(ModelscopeMarket::new(http)),
        ];
        Self { markets, default_index: 0 }
    }

    pub fn register(&mut self, market: Arc<dyn Market>) {
        self.markets.push(market);
    }

    /// `getMarketByName` — unknown/empty names fall back to the default.
    pub fn by_name(&self, name: &str) -> Arc<dyn Market> {
        if name.is_empty() {
            return self.markets[self.default_index].clone();
        }
        self.markets
            .iter()
            .find(|m| m.name() == name)
            .cloned()
            .unwrap_or_else(|| self.markets[self.default_index].clone())
    }

    /// `getMarketInfos`.
    pub fn infos(&self) -> Vec<MarketInfo> {
        self.markets.iter().map(|m| MarketInfo { name: m.name().into(), description: m.description().into() }).collect()
    }

    pub fn names(&self) -> Vec<String> {
        self.markets.iter().map(|m| m.name().to_string()).collect()
    }
}

/// Process-wide manager bound to the real transport. Handlers use this because
/// `AppState` is not theirs to extend; tests build their own with a mock.
pub fn global_manager() -> Arc<MarketManager> {
    static MANAGER: once_cell::sync::Lazy<Arc<MarketManager>> =
        once_cell::sync::Lazy::new(|| Arc::new(MarketManager::new(Arc::new(ReqwestMarketHttp::new()))));
    MANAGER.clone()
}

// ─── Proxy endpoint logic (Java `skillsProxy`) ───────────────────────────────

/// Query parameters of `GET /web/settings/skills/proxy`.
#[derive(Debug, Clone, Default)]
pub struct ProxyQuery {
    pub action: String,
    pub q: String,
    pub cursor: String,
    pub limit: i64,
    pub market_name: String,
    pub category: String,
}

/// Run the proxy request against a manager and return the response envelope.
pub async fn proxy(mgr: &MarketManager, q: &ProxyQuery) -> Value {
    // Java clamps before dispatch: <1 → 20, >100 → 100.
    let mut limit = q.limit;
    if limit < 1 {
        limit = 20;
    }
    if limit > 100 {
        limit = 100;
    }
    let market = mgr.by_name(&q.market_name);
    let has_category = !q.category.is_empty();

    let result = if q.action == "search" && !q.q.is_empty() {
        market.search(&q.q, &q.cursor, limit, &q.category).await
    } else {
        market.trending(&q.cursor, limit, &q.category).await
    };

    match result {
        Ok(mut page) => {
            // Generic client-side fallback: only when the adapter did *not*
            // filter already, otherwise a compensated page gets cut twice.
            if has_category && !page.filtered {
                page.items.retain(|it| it.category.as_deref() == Some(q.category.as_str()));
                page.filtered = true;
            }
            succeed(serde_json::to_value(page).unwrap_or(Value::Null))
        }
        Err(e) => failure(e),
    }
}

/// `GET /web/settings/skills/detail`.
pub async fn detail(mgr: &MarketManager, slug: &str, market_name: &str) -> Value {
    if slug.is_empty() {
        return failure("slug is required");
    }
    envelope(mgr.by_name(market_name).detail(slug).await)
}

/// `GET /web/settings/skills/categories` — any adapter failure degrades to an
/// empty list, which simply hides the filter bar (Java parity).
pub async fn categories(mgr: &MarketManager, market_name: &str) -> Value {
    succeed(serde_json::to_value(mgr.by_name(market_name).categories()).unwrap_or_else(|_| json!([])))
}

/// `GET /web/settings/skills/markets`.
pub fn markets(mgr: &MarketManager) -> Value {
    succeed(serde_json::to_value(mgr.infos()).unwrap_or_else(|_| json!([])))
}

// ─── Install pipeline ────────────────────────────────────────────────────────

/// How an archive's entries map onto the skill directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnpackMode {
    /// Entries land verbatim (skillhub / clawhub packages put `SKILL.md` at the
    /// archive root).
    AsIs,
    /// Strip a single common top-level directory (GitHub-archive style, which
    /// is what ModelScope serves) so `SKILL.md` ends up at the skill root.
    StripSingleRoot,
}

/// Download an archive, rejecting an empty or oversized body.
async fn download_archive(http: &dyn MarketHttp, url: &str) -> MarketResult<Vec<u8>> {
    let r = http.get(url, FetchKind::Download).await;
    if let Some(e) = &r.error {
        return Err(format!("下载技能包失败: {}", e));
    }
    if !r.is_ok() {
        return Err(format!("下载技能包失败: {}", r.failure_reason()));
    }
    if r.body.is_empty() {
        return Err("下载技能包失败: 返回内容为空".into());
    }
    Ok(r.body)
}

/// Shared tail of `SkillhubMarket.install` / `ClawhubMarket.install`.
#[allow(clippy::too_many_arguments)]
async fn run_install(
    http: &dyn MarketHttp,
    download_url: &str,
    skills_dir: &Path,
    dir_name: &str,
    display_name: &str,
    market_name: &str,
    requested_slug: &str,
    icon_url: &str,
    version: &str,
    mode: UnpackMode,
) -> MarketResult<String> {
    let bytes = download_archive(http, download_url).await?;
    place_archive(bytes, skills_dir, dir_name, display_name, market_name, requested_slug, icon_url, version, mode).await
}

/// Unpack, validate and move into place; returns the display name on success.
///
/// Runs the blocking filesystem work on a worker thread — unzipping a large
/// archive inline would stall every other request on this runtime.
#[allow(clippy::too_many_arguments)]
async fn place_archive(
    bytes: Vec<u8>,
    skills_dir: &Path,
    dir_name: &str,
    display_name: &str,
    market_name: &str,
    requested_slug: &str,
    icon_url: &str,
    version: &str,
    mode: UnpackMode,
) -> MarketResult<String> {
    // `spawn_blocking` needs 'static data, so the small string arguments are
    // cloned here rather than threaded through as owned values.
    let skills_dir = skills_dir.to_path_buf();
    let dir_name = dir_name.to_string();
    let display_name = display_name.to_string();
    let market_name = market_name.to_string();
    let requested_slug = requested_slug.to_string();
    let icon_url = icon_url.to_string();
    let version = version.to_string();
    tokio::task::spawn_blocking(move || {
        install_sync(
            &bytes,
            &skills_dir,
            &dir_name,
            &display_name,
            &market_name,
            &requested_slug,
            &icon_url,
            &version,
            mode,
        )
    })
    .await
    .map_err(|e| format!("安装失败: {}", e))?
}

/// The synchronous half of an install.
///
/// Order matters: unpack into a staging directory, validate, *then* swap. Java
/// deletes the target first and unzips in place, so any extraction error leaves
/// a broken skill directory behind and the UI still reports success.
#[allow(clippy::too_many_arguments)]
pub fn install_sync(
    zip: &[u8],
    skills_dir: &Path,
    dir_name: &str,
    display_name: &str,
    market_name: &str,
    requested_slug: &str,
    icon_url: &str,
    version: &str,
    mode: UnpackMode,
) -> MarketResult<String> {
    // The directory name is derived from the slug, but it still ends up in a
    // path: refuse anything that could escape the skills root.
    if dir_name.is_empty() || dir_name.contains("..") || dir_name.contains('/') || dir_name.contains('\\') {
        return Err("Invalid slug".into());
    }
    if let Err(e) = std::fs::create_dir_all(skills_dir) {
        return Err(format!("安装失败: {}", e));
    }
    let target = skills_dir.join(dir_name);

    let stamp = uuid::Uuid::new_v4().simple().to_string();
    // Dot-prefixed so a half-finished install is never picked up by the skill
    // scanner (`scan_dir` skips dot-directories).
    let staging = skills_dir.join(format!(".install-staging-{}", stamp));
    let backup = skills_dir.join(format!(".install-backup-{}", stamp));

    let unpacked = unpack_zip(zip, &staging, mode);
    if let Err(e) = unpacked {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!("安装失败: {}", e));
    }

    // Hardening: an archive without SKILL.md is not a skill. Java reports
    // success here, the UI shows "installed", and the skill never appears.
    if resolve_skill_md(&staging).is_none() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err("安装失败: 技能包缺少 SKILL.md".into());
    }

    if target.exists() {
        if let Err(e) = std::fs::rename(&target, &backup) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(format!("安装失败: {}", e));
        }
    }
    if let Err(e) = std::fs::rename(&staging, &target) {
        // Roll back: put the previous version where it was.
        if backup.exists() {
            let _ = std::fs::rename(&backup, &target);
        }
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!("安装失败: {}", e));
    }
    let _ = std::fs::remove_dir_all(&backup);

    // Metadata failure must not fail the install (Java `writeMarketMeta` only
    // logs): it is display-only, and rolling back a good install over a bad
    // sidecar file would be worse.
    if let Err(e) = write_market_meta(&target, market_name, requested_slug, display_name, icon_url, version) {
        tracing::warn!("[Skills] failed to write market meta for {}: {}", dir_name, e);
    }

    // A new skill directory now exists. The parsed-skill cache is keyed by
    // directory fingerprint, and while the fingerprint would usually catch this,
    // invalidating explicitly keeps correctness independent of filesystem
    // timestamp granularity — the same reasoning as in `set_enabled`.
    super::invalidate_cache();

    Ok(display_name.to_string())
}

/// Write `.skill-market.json`.
///
/// Field set = what `super::MarketMeta` reads (`market`, `slug`, `iconUrl`,
/// `displayName`) plus two forward-compatible fields (`canonicalName`,
/// `version`) that both this kernel's deserializer and Java's `ONode` reader
/// ignore. `displayName` comes from the **market detail response** passed in by
/// the caller — never from the unpacked package.
pub fn write_market_meta(
    skill_dir: &Path,
    market_name: &str,
    slug: &str,
    display_name: &str,
    icon_url: &str,
    version: &str,
) -> std::io::Result<()> {
    let mut meta = serde_json::Map::new();
    meta.insert("market".into(), json!(market_name));
    meta.insert("slug".into(), json!(slug));
    if !icon_url.is_empty() {
        meta.insert("iconUrl".into(), json!(icon_url));
    }
    let trimmed = display_name.trim();
    if !trimmed.is_empty() {
        meta.insert("displayName".into(), json!(trimmed));
    }
    // Canonical identity, kept separate from the display name so a future
    // reader can tell two same-slug skills apart without re-querying upstream.
    meta.insert("canonicalName".into(), json!(slug));
    if !version.is_empty() {
        meta.insert("version".into(), json!(version));
    }
    std::fs::write(skill_dir.join(".skill-market.json"), serde_json::to_vec(&Value::Object(meta))?)
}

// ─── ZIP handling ────────────────────────────────────────────────────────────

/// One central-directory record.
#[derive(Debug, Clone)]
struct ZipRecord {
    name: String,
    method: u16,
    flags: u16,
    crc32: u32,
    compressed_size: u64,
    uncompressed_size: u64,
    local_offset: u64,
    dir: bool,
}

fn rd_u16(b: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([b[i], b[i + 1]])
}
fn rd_u32(b: &[u8], i: usize) -> u32 {
    u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
}

/// Locate the End Of Central Directory record by scanning backwards.
fn find_eocd(zip: &[u8]) -> Option<usize> {
    const SIG: [u8; 4] = [0x50, 0x4b, 0x05, 0x06];
    if zip.len() < 22 {
        return None;
    }
    // The comment can be up to 65535 bytes, so the EOCD may sit that far back.
    let max_back = 22 + 65535;
    let start = zip.len().saturating_sub(max_back);
    let mut i = zip.len() - 22;
    loop {
        if i >= start && zip[i..i + 4] == SIG {
            return Some(i);
        }
        if i == start || i == 0 {
            return None;
        }
        i -= 1;
    }
}

/// Read the central directory. Returns `Err` for shapes this parser refuses
/// (zip64, truncated) rather than guessing.
fn central_directory(zip: &[u8]) -> Result<Vec<ZipRecord>, String> {
    let eocd = find_eocd(zip).ok_or("not a zip archive (EOCD not found)")?;
    let total = rd_u16(zip, eocd + 10) as usize;
    let cd_size = rd_u32(zip, eocd + 12) as usize;
    let cd_offset = rd_u32(zip, eocd + 16) as usize;
    if total == 0xFFFF || cd_offset == 0xFFFF_FFFF || cd_size == 0xFFFF_FFFF {
        return Err("zip64 archives are not supported".into());
    }
    if cd_offset + cd_size > zip.len() {
        return Err("zip central directory is truncated".into());
    }
    let mut out = Vec::with_capacity(total);
    let mut p = cd_offset;
    let end = cd_offset + cd_size;
    while p + 46 <= end {
        if rd_u32(zip, p) != 0x0201_4b50 {
            break;
        }
        let method = rd_u16(zip, p + 10);
        let flags = rd_u16(zip, p + 8);
        let crc32 = rd_u32(zip, p + 16);
        let csize = rd_u32(zip, p + 20) as u64;
        let usize_ = rd_u32(zip, p + 24) as u64;
        let name_len = rd_u16(zip, p + 28) as usize;
        let extra_len = rd_u16(zip, p + 30) as usize;
        let comment_len = rd_u16(zip, p + 32) as usize;
        let local_offset = rd_u32(zip, p + 42) as u64;
        let name_start = p + 46;
        if name_start + name_len > end {
            return Err("zip central directory entry is truncated".into());
        }
        let name = String::from_utf8_lossy(&zip[name_start..name_start + name_len]).into_owned();
        let dir = name.ends_with('/') || (rd_u32(zip, p + 38) & 0x10) != 0;
        out.push(ZipRecord { name, method, flags, crc32, compressed_size: csize, uncompressed_size: usize_, local_offset, dir });
        p = name_start + name_len + extra_len + comment_len;
        if out.len() > MAX_ZIP_ENTRIES {
            return Err(format!("zip has more than {} entries", MAX_ZIP_ENTRIES));
        }
    }
    Ok(out)
}

/// Data offset of an entry, read from its **local** header (the local name and
/// extra lengths can differ from the central directory's).
fn local_data_offset(zip: &[u8], rec: &ZipRecord) -> Result<usize, String> {
    let o = rec.local_offset as usize;
    if o + 30 > zip.len() {
        return Err(format!("zip local header out of bounds: {}", rec.name));
    }
    if rd_u32(zip, o) != 0x0403_4b50 {
        return Err(format!("bad zip local header signature: {}", rec.name));
    }
    let name_len = rd_u16(zip, o + 26) as usize;
    let extra_len = rd_u16(zip, o + 28) as usize;
    let start = o + 30 + name_len + extra_len;
    if start + rec.compressed_size as usize > zip.len() {
        return Err(format!("zip entry data out of bounds: {}", rec.name));
    }
    Ok(start)
}

/// Normalize an entry name to forward slashes and drop Windows drive letters.
fn normalize_entry_name(raw: &str) -> String {
    raw.replace('\\', "/")
}

/// Decide whether a single common top-level directory should be stripped
/// (Java `ModelscopeMarket.unzipStrippingRoot`, first pass).
fn detect_root_prefix(names: &[String]) -> Option<String> {
    let mut prefix: Option<String> = None;
    for name in names {
        if name.starts_with("__MACOSX") || name.contains("/__MACOSX") {
            continue;
        }
        let Some(slash) = name.find('/') else {
            // A file at the archive root: not an archive-style layout.
            return None;
        };
        let top = &name[..slash];
        if top == "." || top.is_empty() {
            return None;
        }
        match &prefix {
            None => prefix = Some(top.to_string()),
            Some(p) if p == top => {}
            Some(_) => return None,
        }
    }
    prefix
}

/// Zip-slip guard: reject absolute paths, drive letters and any `..` component.
///
/// Java silently `continue`s past such entries; refusing the whole archive is
/// stricter on purpose — a package that tries to write outside its directory is
/// not a package this kernel should install at all.
fn is_unsafe_entry(name: &str) -> bool {
    if name.is_empty() {
        return true;
    }
    if name.starts_with('/') || name.starts_with('\\') {
        return true;
    }
    // `C:/...` style drive letter.
    let b = name.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        return true;
    }
    name.split('/').any(|seg| seg == "..")
}

/// Unpack `zip` into `dest`, applying `mode`.
pub fn unpack_zip(zip: &[u8], dest: &Path, mode: UnpackMode) -> Result<usize, String> {
    let records = central_directory(zip)?;
    if records.is_empty() {
        return Err("zip archive is empty".into());
    }
    let names: Vec<String> = records.iter().map(|r| normalize_entry_name(&r.name)).collect();
    let strip_prefix = match mode {
        UnpackMode::StripSingleRoot => detect_root_prefix(&names),
        UnpackMode::AsIs => None,
    };

    std::fs::create_dir_all(dest).map_err(|e| format!("cannot create staging dir: {}", e))?;
    let dest_abs = dest.canonicalize().unwrap_or_else(|_| dest.to_path_buf());

    let mut written = 0usize;
    let mut total_uncompressed: u64 = 0;
    for (rec, raw_name) in records.iter().zip(names.iter()) {
        if raw_name.starts_with("__MACOSX") || raw_name.contains("/__MACOSX") {
            continue;
        }
        let mut name = raw_name.clone();
        if let Some(prefix) = &strip_prefix {
            if name == format!("{}/", prefix) {
                continue;
            }
            let with_slash = format!("{}/", prefix);
            if let Some(rest) = name.strip_prefix(with_slash.as_str()) {
                name = rest.to_string();
            } else {
                continue;
            }
        }
        if name.is_empty() {
            continue;
        }
        if is_unsafe_entry(&name) {
            let _ = std::fs::remove_dir_all(dest);
            return Err(format!("拒绝不安全的压缩包条目: {}", raw_name));
        }

        let out = dest_abs.join(&name);
        // Belt and braces: the resolved path must still be inside the staging
        // directory even if the lexical check above were ever weakened.
        if !out.starts_with(&dest_abs) {
            let _ = std::fs::remove_dir_all(dest);
            return Err(format!("拒绝越界的压缩包条目: {}", raw_name));
        }

        if rec.dir {
            std::fs::create_dir_all(&out).map_err(|e| format!("cannot create dir {}: {}", name, e))?;
            continue;
        }

        total_uncompressed += rec.uncompressed_size;
        if total_uncompressed > MAX_UNCOMPRESSED_BYTES {
            let _ = std::fs::remove_dir_all(dest);
            return Err("压缩包解压后体积超过上限".into());
        }

        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("cannot create dir: {}", e))?;
        }
        let start = local_data_offset(zip, rec)?;
        let data = &zip[start..start + rec.compressed_size as usize];
        let bytes = match rec.method {
            0 => data.to_vec(),
            8 => inflate(data, rec.uncompressed_size)
                .map_err(|e| format!("解压失败 ({}): {}", name, e))?,
            other => {
                let _ = std::fs::remove_dir_all(dest);
                return Err(format!("不支持的压缩算法 {} (条目 {})", other, name));
            }
        };
        // Hardening: verify the checksum so a truncated download cannot be
        // installed as a good skill. Entries written with a data descriptor
        // (general-purpose bit 3) carry their real CRC after the data, so the
        // central-directory value is 0 and cannot be checked — those are skipped,
        // exactly as a streaming unzipper would.
        if rec.flags & 0x08 == 0 && crc32(&bytes) != rec.crc32 {
            let _ = std::fs::remove_dir_all(dest);
            return Err(format!("压缩包条目校验失败: {}", name));
        }
        std::fs::write(&out, &bytes).map_err(|e| format!("写入失败 ({}): {}", name, e))?;
        written += 1;
    }
    if written == 0 {
        let _ = std::fs::remove_dir_all(dest);
        return Err("压缩包内没有可写入的文件".into());
    }
    Ok(written)
}

/// CRC-32 (IEEE, as used by ZIP). Table-free bitwise version: archives are
/// small and this keeps the dependency surface at zero.
pub fn crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

/// Raw-deflate inflate with a hard output ceiling.
fn inflate(data: &[u8], expected: u64) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut dec = flate2::read::DeflateDecoder::new(data);
    let mut out = Vec::with_capacity(expected.min(1 << 20) as usize);
    // Read in bounded chunks so a lying `expected` cannot preallocate gigabytes.
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let n = dec.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        out.extend_from_slice(&chunk[..n]);
        if out.len() as u64 > MAX_UNCOMPRESSED_BYTES {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "entry too large"));
        }
    }
    Ok(out)
}

// ─── Icon proxy (Java `skillsIcon` / `fetchIcon`) ────────────────────────────

/// A fetched icon, or the reason it was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IconFetch {
    pub bytes: Vec<u8>,
    pub content_type: Option<String>,
}

/// Fetch an icon: validate scheme + host on **every** hop, follow at most
/// `ICON_MAX_REDIRECTS` redirects manually, cap the body at `ICON_MAX_BYTES`.
///
/// This endpoint is a server-side fetch of a user-supplied URL, i.e. an SSRF
/// surface; the manual redirect loop exists precisely so each hop can be
/// re-validated (an HTTP client that follows redirects automatically cannot).
pub async fn fetch_icon(http: &dyn MarketHttp, url: &str) -> Option<IconFetch> {
    let mut current = url.to_string();
    for _hop in 0..=ICON_MAX_REDIRECTS {
        if current.is_empty() {
            return None;
        }
        if !host_is_proxyable(&current).await {
            return None;
        }
        let r = http.get(&current, FetchKind::Icon).await;
        if r.error.is_some() {
            return None;
        }
        if r.is_redirect() {
            let loc = r.location?;
            // Resolve relative Location against the current URL (Java
            // `uri.resolve(location)`).
            current = match url::Url::parse(&current) {
                Ok(base) => base.join(&loc).ok()?.to_string(),
                Err(_) => return None,
            };
            continue;
        }
        if !r.is_ok() {
            return None;
        }
        if r.body.len() as u64 > ICON_MAX_BYTES {
            return None;
        }
        return Some(IconFetch { bytes: r.body, content_type: r.content_type });
    }
    None
}

/// Content type to serve: only `image/*` passes through, everything else
/// becomes `image/png` (Java parity — an upstream `text/html` error page must
/// not be served as this endpoint's response).
pub fn icon_content_type(fetch: &IconFetch) -> String {
    match &fetch.content_type {
        Some(ct) if ct.starts_with("image/") => ct.clone(),
        _ => "image/png".into(),
    }
}

/// Scheme + host gate for one URL. Resolution happens on a worker thread
/// because `to_socket_addrs` blocks.
async fn host_is_proxyable(raw: &str) -> bool {
    let parsed = match url::Url::parse(raw) {
        Ok(u) => u,
        Err(_) => return false,
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = parsed.host_str().map(String::from) else { return false };
    let port = parsed.port_or_known_default().unwrap_or(80);
    // A literal IP needs no resolution; anything else goes through DNS.
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return !is_private_ip(&ip);
    }
    let target = format!("{}:{}", host, port);
    tokio::task::spawn_blocking(move || {
        use std::net::ToSocketAddrs;
        match target.to_socket_addrs() {
            // Unresolvable → refuse: a name that does not resolve should never
            // be connected to (Java treats UnknownHostException as private).
            Err(_) => false,
            Ok(addrs) => {
                let mut any = false;
                for a in addrs {
                    any = true;
                    if is_private_ip(&a.ip()) {
                        return false;
                    }
                }
                any
            }
        }
    })
    .await
    .unwrap_or(false)
}

/// Loopback / private / link-local / any / multicast / IPv6 ULA — plus, as
/// hardening, CGNAT and IPv4-mapped IPv6 (which Java's `InetAddress` checks
/// do not cover).
pub fn is_private_ip(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => is_private_v4(v4),
        std::net::IpAddr::V6(v6) => {
            if v6.is_loopback() || v6.is_multicast() || v6.is_unspecified() {
                return true;
            }
            // IPv4-mapped (::ffff:10.0.0.1) must be judged as the v4 it wraps.
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_private_v4(&v4);
            }
            let seg0 = v6.segments()[0];
            // ULA fc00::/7. Java checks the first byte for 0xfc/0xfd; the
            // segment form is the same test.
            if (seg0 & 0xfe00) == 0xfc00 {
                return true;
            }
            // Link-local fe80::/10.
            if (seg0 & 0xffc0) == 0xfe80 {
                return true;
            }
            // Deprecated site-local fec0::/10 (what JDK's isSiteLocalAddress tests).
            if (seg0 & 0xffc0) == 0xfec0 {
                return true;
            }
            false
        }
    }
}

fn is_private_v4(v4: &std::net::Ipv4Addr) -> bool {
    if v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified() || v4.is_multicast() {
        return true;
    }
    let o = v4.octets();
    // Limited broadcast 255.255.255.255. `Ipv4Addr::is_broadcast` is still
    // unstable, so it is tested by hand — without this the icon proxy would
    // happily fetch a broadcast address, which on some stacks reaches every host
    // on the local link.
    if o == [255, 255, 255, 255] {
        return true;
    }
    // Hardening: CGNAT 100.64.0.0/10 (carrier-grade NAT is not public either).
    if o[0] == 100 && (64..=127).contains(&o[1]) {
        return true;
    }
    // Hardening: 192.0.0.0/24 (IETF protocol assignments) is not routable.
    if o[0] == 192 && o[1] == 0 && o[2] == 0 {
        return true;
    }
    // Hardening: 198.18.0.0/15 (benchmarking) is not routable.
    if o[0] == 198 && (18..=19).contains(&o[1]) {
        return true;
    }
    // Hardening: 240.0.0.0/4 is reserved for future use (and 255.255.255.255 is
    // already covered above).
    if (240..=255).contains(&o[0]) {
        return true;
    }
    false
}

// ─── Installed-skill lookup shared with the registry ─────────────────────────

/// Read the market metadata of an installed skill directory (re-exported so the
/// API layer has one import path).
pub fn installed_meta(skill_dir: &Path) -> Option<MarketMeta> {
    read_market_meta(skill_dir)
}

/// Build the `market:<name>|<slug>` keys the frontend's installed index uses,
/// so the badge logic has a server-side equivalent for tests.
pub fn installed_index_keys(meta: &MarketMeta) -> Vec<String> {
    let mut keys = Vec::new();
    if !meta.market.is_empty() && !meta.slug.is_empty() {
        keys.push(format!("market:{}|{}", meta.market, meta.slug));
    }
    keys
}

/// Count bare-slug occurrences in a page — the frontend only claims a legacy
/// bare-slug install when the bare slug is unique on screen.
pub fn count_bare_slugs(items: &[MarketItem]) -> HashMap<String, usize> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for it in items {
        let bare = market_bare_slug(&it.slug);
        if !bare.is_empty() {
            *counts.entry(bare).or_insert(0) += 1;
        }
    }
    counts
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::{display_name_of, set_enabled, SkillRegistry};
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::Mutex;

    // ── scratch dirs (never the real C:/Users/LUZW/.gwork) ──────────────────────────────

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "gwork-market-{}-{}-{}",
                tag,
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // ── injectable upstream (no test ever reaches api.skillhub.cn) ──────────

    struct MockHttp {
        /// Behind a Mutex because the builder methods take `self: Arc<Self>` and
        /// return the same `Arc` — a plain `Vec` cannot be mutated through a
        /// shared `Arc`, and the builder reads better than a from-scratch
        /// constructor at each of the ~30 call sites.
        routes: Mutex<Vec<(String, HttpResult)>>,
        calls: Mutex<Vec<String>>,
    }

    impl MockHttp {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                routes: Mutex::new(Vec::new()),
                calls: Mutex::new(Vec::new()),
            })
        }
        fn route(self: &Arc<Self>, pattern: &str, resp: HttpResult) -> Arc<Self> {
            self.routes.lock().unwrap().push((pattern.to_string(), resp));
            self.clone()
        }
        fn json(self: Arc<Self>, pattern: &str, body: Value) -> Arc<Self> {
            self.route(pattern, HttpResult {
                status: 200,
                body: serde_json::to_vec(&body).unwrap(),
                content_type: Some("application/json".into()),
                location: None,
                error: None,
            })
        }
        fn bytes(self: Arc<Self>, pattern: &str, body: Vec<u8>) -> Arc<Self> {
            self.route(pattern, HttpResult {
                status: 200,
                body,
                content_type: Some("application/zip".into()),
                location: None,
                error: None,
            })
        }
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait::async_trait]
    impl MarketHttp for MockHttp {
        async fn get(&self, url: &str, _kind: FetchKind) -> HttpResult {
            self.calls.lock().unwrap().push(url.to_string());
            // Clone the match out before returning: holding the guard across the
            // return would keep `routes` locked for the caller's lifetime.
            let hit = self
                .routes
                .lock()
                .unwrap()
                .iter()
                .find(|(pattern, _)| url.contains(pattern.as_str()))
                .map(|(_, resp)| resp.clone());
            match hit {
                Some(resp) => resp,
                None => HttpResult::transport_error(format!("no mock route for {}", url)),
            }
        }
    }

    // ── minimal ZIP writer (stored + deflate), with correct CRC-32 ──────────

    struct Spec {
        name: String,
        data: Vec<u8>,
        deflate: bool,
        bad_crc: bool,
    }

    impl Spec {
        fn file(name: &str, data: &str) -> Self {
            Self { name: name.into(), data: data.as_bytes().to_vec(), deflate: false, bad_crc: false }
        }
        fn deflated(name: &str, data: &str) -> Self {
            Self { name: name.into(), data: data.as_bytes().to_vec(), deflate: true, bad_crc: false }
        }
        fn dir(name: &str) -> Self {
            let n = if name.ends_with('/') { name.to_string() } else { format!("{}/", name) };
            Self { name: n, data: Vec::new(), deflate: false, bad_crc: false }
        }
        fn corrupt_crc(mut self) -> Self {
            self.bad_crc = true;
            self
        }
    }

    fn deflate_raw(data: &[u8]) -> Vec<u8> {
        let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(data).unwrap();
        enc.finish().unwrap()
    }

    fn build_zip(specs: &[Spec]) -> Vec<u8> {
        let mut out: Vec<u8> = Vec::new();
        let mut central: Vec<Vec<u8>> = Vec::new();
        for s in specs {
            let offset = out.len() as u32;
            let crc = if s.bad_crc { crc32(&s.data) ^ 0xFF } else { crc32(&s.data) };
            let stored = if s.deflate { deflate_raw(&s.data) } else { s.data.clone() };
            let method: u16 = if s.deflate { 8 } else { 0 };
            let name = s.name.as_bytes();
            let is_dir = s.name.ends_with('/');

            out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            out.extend_from_slice(&20u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes()); // flags: no data descriptor
            out.extend_from_slice(&method.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&crc.to_le_bytes());
            out.extend_from_slice(&(stored.len() as u32).to_le_bytes());
            out.extend_from_slice(&(s.data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(name);
            out.extend_from_slice(&stored);

            let mut c = Vec::new();
            c.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            c.extend_from_slice(&20u16.to_le_bytes());
            c.extend_from_slice(&20u16.to_le_bytes());
            c.extend_from_slice(&0u16.to_le_bytes());
            c.extend_from_slice(&method.to_le_bytes());
            c.extend_from_slice(&0u16.to_le_bytes());
            c.extend_from_slice(&0u16.to_le_bytes());
            c.extend_from_slice(&crc.to_le_bytes());
            c.extend_from_slice(&(stored.len() as u32).to_le_bytes());
            c.extend_from_slice(&(s.data.len() as u32).to_le_bytes());
            c.extend_from_slice(&(name.len() as u16).to_le_bytes());
            c.extend_from_slice(&0u16.to_le_bytes());
            c.extend_from_slice(&0u16.to_le_bytes());
            c.extend_from_slice(&0u16.to_le_bytes());
            c.extend_from_slice(&0u16.to_le_bytes());
            let ext: u32 = if is_dir { 0x10 } else { 0 };
            c.extend_from_slice(&ext.to_le_bytes());
            c.extend_from_slice(&offset.to_le_bytes());
            c.extend_from_slice(name);
            central.push(c);
        }

        let cd_offset = out.len() as u32;
        let mut cd_size = 0u32;
        for c in &central {
            out.extend_from_slice(c);
            cd_size += c.len() as u32;
        }
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(central.len() as u16).to_le_bytes());
        out.extend_from_slice(&(central.len() as u16).to_le_bytes());
        out.extend_from_slice(&cd_size.to_le_bytes());
        out.extend_from_slice(&cd_offset.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }

    /// A realistic skill package whose SKILL.md **lies** about its display name.
    fn impersonating_zip() -> Vec<u8> {
        build_zip(&[Spec::file(
            "SKILL.md",
            "---\nname: dev-expert\ndisplayName: \"Agent Browser\"\ndescription: fake\n---\n\n# Fake\n",
        )])
    }

    fn good_zip() -> Vec<u8> {
        build_zip(&[
            Spec::file("SKILL.md", "---\nname: real\ndescription: real skill\n---\n\n# Real\n"),
            Spec::dir("scripts"),
            Spec::deflated("scripts/run.py", "print('hi')\n"),
        ])
    }

    // ── envelope ────────────────────────────────────────────────────────────

    /// Solon `Result.succeed` sets description to the EMPTY string (verified in
    /// the bytecode: `ldc ""`), not "succeed". The frontend prints
    /// `resp.description` in a toast, so a stray word would leak into the UI.
    #[test]
    fn succeed_envelope_has_an_empty_description() {
        let v = succeed(json!([1, 2]));
        assert_eq!(v["code"], json!(200));
        assert_eq!(v["description"], json!(""));
        assert_eq!(v["data"], json!([1, 2]));
    }

    #[test]
    fn failure_envelope_uses_code_400_and_null_data() {
        let v = failure("技能不存在: x");
        assert_eq!(v["code"], json!(400));
        assert_eq!(v["description"], json!("技能不存在: x"));
        assert!(v["data"].is_null());
    }

    // ── slug identity ───────────────────────────────────────────────────────

    /// The `> 1` boundary is shared with the frontend and the Java kernel.
    #[test]
    fn qualified_slug_uses_the_greater_than_one_boundary() {
        assert!(is_qualified_slug("@owner/slug"));
        assert!(!is_qualified_slug("@/slug"), "@/slug is malformed and must stay bare");
        assert!(!is_qualified_slug("@owner/"), "empty tail is not qualified");
        assert!(!is_qualified_slug("owner/slug"), "missing @ is not qualified");
        assert!(!is_qualified_slug("plain"));
        assert!(!is_qualified_slug(""));
    }

    #[test]
    fn bare_slug_matches_the_registry_helper() {
        assert_eq!(market_bare_slug("@user_814dbe54/dev-expert"), "dev-expert");
        assert_eq!(market_bare_slug("@/slug"), "@/slug");
        assert_eq!(market_bare_slug("plain"), "plain");
    }

    /// Two different authors really do share the bare slug `dev-expert`; the
    /// directory name must keep them apart or the second install overwrites the
    /// first and the UI lights up both cards.
    #[test]
    fn same_bare_slug_different_owners_get_different_dirs() {
        assert_eq!(default_install_dir_name("@user_814dbe54/dev-expert"), "_user_814dbe54_dev-expert");
        assert_eq!(default_install_dir_name("@indiv-ebandao/dev-expert"), "_indiv-ebandao_dev-expert");
        assert_ne!(
            default_install_dir_name("@user_814dbe54/dev-expert"),
            default_install_dir_name("@indiv-ebandao/dev-expert")
        );
        // Bare slugs keep the historical stripping rule.
        assert_eq!(default_install_dir_name("dev expert!"), "devexpert");
    }

    #[test]
    fn modelscope_dir_name_keeps_the_owner_prefix() {
        let m = ModelscopeMarket::new(MockHttp::new());
        assert_eq!(m.install_dir_name("@anthropics/pdf"), "_anthropics_pdf");
        // Java `ModelscopeMarket.installDirName`: strip to `[a-zA-Z0-9@._/-]`
        // (so `@` survives), then map `[@/]` → `_`. For `@a/b@c` that is
        // `_a_b_c` — the interior `@` is in the allowed set and becomes `_`, it
        // is not dropped. An earlier expectation of `_a_bc` wrongly assumed the
        // second `@` was stripped.
        assert_eq!(m.install_dir_name("@a/b@c"), "_a_b_c");
    }

    /// Java `URLEncoder.encode`: space becomes `+`, `~` becomes `%7E`, and
    /// `* . - _` survive. A drift here sends a different slug upstream.
    #[test]
    fn url_encode_matches_java_urlencoder() {
        assert_eq!(url_encode("@user_814dbe54/dev-expert"), "%40user_814dbe54%2Fdev-expert");
        assert_eq!(url_encode("a b"), "a+b");
        assert_eq!(url_encode("a~b"), "a%7Eb");
        assert_eq!(url_encode("a*b._-c"), "a*b._-c");
        assert_eq!(url_encode("中文"), "%E4%B8%AD%E6%96%87");
    }

    // ── cursor / pagination ─────────────────────────────────────────────────

    #[test]
    fn cursor_is_the_upstream_page_number() {
        assert_eq!(parse_page_from_cursor(""), 1);
        assert_eq!(parse_page_from_cursor("  7 "), 7);
        assert_eq!(parse_page_from_cursor("abc"), 1);
        assert_eq!(parse_page_from_cursor("0"), 1);
        assert_eq!(parse_page_from_cursor("-3"), 1);
    }

    /// A fabricated cursor would make the frontend's infinite scroll request a
    /// page that does not exist, forever.
    #[test]
    fn next_cursor_is_only_emitted_when_the_total_says_so() {
        assert_eq!(next_cursor_for(false, 1, 20, 100).as_deref(), Some("2"));
        assert_eq!(next_cursor_for(false, 5, 20, 100), None, "last page must not advertise more");
        assert_eq!(next_cursor_for(true, 1, 20, 100), None, "an empty page must stop the scroll");
        assert_eq!(next_cursor_for(false, 1, 20, 0), None);
    }

    #[test]
    fn page_size_falls_back_to_twenty_outside_the_upstream_range() {
        assert_eq!(page_size_for(20), 20);
        assert_eq!(page_size_for(100), 100);
        assert_eq!(page_size_for(0), 20);
        assert_eq!(page_size_for(200), 20, "upstream returns 400 above 100");
    }

    // ── upstream parsing ────────────────────────────────────────────────────

    /// The published slug must be namespace-qualified whenever an owner is
    /// known, otherwise detail/download resolve to whichever author upstream
    /// picks and both same-slug cards show "installed".
    #[test]
    fn skillhub_list_qualifies_slugs_with_the_namespace_handle() {
        let data = json!({
            "total": 2,
            "skills": [
                {"slug": "dev-expert", "name": "编程专家.Skill", "namespace": {"handle": "user_814dbe54"},
                 "ownerName": "user_814dbe54", "downloads": 1200, "installs": 0, "stars": 3,
                 "description_zh": "中文描述", "description": "english", "category": "dev-programming",
                 "version": "1.0.0", "iconUrl": "https://cdn/i.png"},
                {"slug": "dev-expert", "name": "Other Dev Expert", "namespace": {"handle": "indiv-ebandao"},
                 "ownerName": "indiv-ebandao", "downloads": 7, "category": "dev-programming"}
            ]
        });
        let items = parse_skillhub_skills(&data);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].slug, "@user_814dbe54/dev-expert");
        assert_eq!(items[1].slug, "@indiv-ebandao/dev-expert");
        assert_ne!(items[0].slug, items[1].slug, "identity must differ per author");
        assert_eq!(items[0].display_name.as_deref(), Some("编程专家.Skill"));
        // installs falls back to downloads when installs is 0.
        assert_eq!(items[0].installs, 1200);
        assert_eq!(items[1].installs, 7);
        // zh description wins.
        assert_eq!(items[0].summary.as_deref(), Some("中文描述"));
        assert_eq!(items[0].url.as_deref(), Some("https://skillhub.cn/skills/@user_814dbe54/dev-expert"));
    }

    #[test]
    fn skillhub_list_keeps_a_bare_slug_when_no_owner_is_known() {
        let data = json!({"total": 1, "skills": [{"slug": "solo", "name": "Solo"}]});
        let items = parse_skillhub_skills(&data);
        assert_eq!(items[0].slug, "solo");
    }

    #[test]
    fn skillhub_list_does_not_double_qualify() {
        let data = json!({"total": 1, "skills": [{"slug": "@a/b", "namespace": {"handle": "a"}}]});
        assert_eq!(parse_skillhub_skills(&data)[0].slug, "@a/b");
    }

    /// Upstream `tags` has been seen as an array, a map and an empty object.
    #[test]
    fn tags_collapse_from_every_upstream_shape() {
        assert_eq!(parse_tags(Some(&json!(["a", "b", "a"]))), vec!["a".to_string(), "b".to_string()]);
        assert_eq!(parse_tags(Some(&json!({"k1": "x", "k2": "y"}))), vec!["x".to_string(), "y".to_string()]);
        assert!(parse_tags(Some(&json!({}))).is_empty());
        assert!(parse_tags(None).is_empty());
        assert!(parse_tags(Some(&Value::Null)).is_empty());
    }

    #[test]
    fn clawhub_version_prefers_latest_version_then_tags_latest() {
        assert_eq!(clawhub_latest_version(&json!({"latestVersion": {"version": "1.1.2"}})).as_deref(), Some("1.1.2"));
        assert_eq!(clawhub_latest_version(&json!({"tags": {"latest": "0.9"}})).as_deref(), Some("0.9"));
        assert_eq!(clawhub_latest_version(&json!({"latestVersion": {"version": ""}, "tags": {"latest": "0.9"}})).as_deref(), Some("0.9"));
        assert!(clawhub_latest_version(&json!({})).is_none());
    }

    /// Java `ClawhubFrontmatterStripTest` parity — same cases, same rules.
    #[test]
    fn clawhub_description_strips_the_skill_md_frontmatter_head() {
        let raw = "---\nname: innerwarden-security\ndescription: Install, verify and run\n\
                   user-invocable: true\nmetadata: {\"a\":1}\n---\n\n# InnerWarden, from inside\n\nbody.";
        let out = strip_skill_md_frontmatter(raw).unwrap();
        assert!(out.starts_with("# InnerWarden"), "{out}");
        assert!(!out.contains("name: innerwarden-security"), "{out}");

        // plain text untouched; empty stays empty
        assert_eq!(strip_skill_md_frontmatter("Just a description.").as_deref(), Some("Just a description."));
        assert_eq!(strip_skill_md_frontmatter("").as_deref(), Some(""));

        // unclosed fence: keep as-is (showing too much beats deleting body text)
        let raw = "---\nname: x\ndescription: y\nbody mentions --- divider";
        assert_eq!(strip_skill_md_frontmatter(raw).as_deref(), Some(raw));

        // first line must be exactly `---`
        assert_eq!(strip_skill_md_frontmatter("----\nbody").as_deref(), Some("----\nbody"));
        assert_eq!(strip_skill_md_frontmatter("---foo\n---\nbody").as_deref(), Some("---foo\n---\nbody"));

        // `---foo` body lines are not the closing fence; the real one wins
        let raw = "---\nname: x\n---\nbody\n---not-a-fence\nmore";
        assert_eq!(strip_skill_md_frontmatter(raw).as_deref(), Some("body\n---not-a-fence\nmore"));

        // CRLF and EOF-closing forms
        assert_eq!(strip_skill_md_frontmatter("---\r\nname: x\r\n---\r\nbody").as_deref(), Some("body"));
        assert!(strip_skill_md_frontmatter("---\nname: x\n---").is_none());
    }

    #[test]
    fn github_fallback_covers_the_documented_source_url_shapes() {
        assert_eq!(
            github_fallback_url(Some("https://github.com/o/r")).as_deref(),
            Some("https://github.com/o/r/archive/refs/heads/HEAD.zip")
        );
        assert_eq!(
            github_fallback_url(Some("https://github.com/o/r.git")).as_deref(),
            Some("https://github.com/o/r/archive/refs/heads/HEAD.zip")
        );
        assert_eq!(
            github_fallback_url(Some("https://github.com/o/r/tree/dev")).as_deref(),
            Some("https://github.com/o/r/archive/refs/heads/dev.zip")
        );
        assert!(github_fallback_url(Some("https://gitlab.com/o/r")).is_none());
        assert!(github_fallback_url(None).is_none());
        assert!(github_fallback_url(Some("")).is_none());
    }

    #[test]
    fn modelscope_category_filter_is_client_side_and_marks_the_page() {
        let mut page = MarketPage {
            items: vec![
                MarketItem { slug: "a".into(), category: Some("other".into()), ..Default::default() },
                MarketItem { slug: "b".into(), category: Some("ai-media".into()), ..Default::default() },
            ],
            next_cursor: None,
            filtered: false,
        };
        filter_by_category(&mut page, "ai-media");
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].slug, "b");
        assert!(page.filtered, "the controller must not filter a second time");
        // An empty category leaves the page alone.
        let mut p2 = MarketPage { items: page.items.clone(), next_cursor: None, filtered: false };
        filter_by_category(&mut p2, "");
        assert_eq!(p2.items.len(), 1);
        assert!(!p2.filtered);
    }

    // ── manager ─────────────────────────────────────────────────────────────

    #[test]
    fn manager_registers_the_same_three_markets_in_java_order() {
        let mgr = MarketManager::new(MockHttp::new());
        assert_eq!(mgr.names(), vec!["skillhub.cn", "clawhub.ai", "modelscope.cn"]);
        let infos = mgr.infos();
        assert_eq!(infos[0].description, "专为中国用户优化的技能社区");
        assert_eq!(infos[1].description, "");
        assert_eq!(infos[2].description, "魔搭社区技能广场");
    }

    /// An unknown or empty market name falls back to the default rather than
    /// erroring (Java `getMarketByName`).
    #[test]
    fn unknown_market_name_falls_back_to_the_default() {
        let mgr = MarketManager::new(MockHttp::new());
        assert_eq!(mgr.by_name("").name(), "skillhub.cn");
        assert_eq!(mgr.by_name("nope.example").name(), "skillhub.cn");
        assert_eq!(mgr.by_name("clawhub.ai").name(), "clawhub.ai");
    }

    // ── proxy endpoint ──────────────────────────────────────────────────────

    fn skillhub_page(total: i64, slugs: &[&str]) -> Value {
        json!({
            "code": 0,
            "data": {
                "total": total,
                "skills": slugs.iter().map(|s| json!({
                    "slug": s, "name": s, "namespace": {"handle": "o"}, "downloads": 1
                })).collect::<Vec<_>>()
            }
        })
    }

    #[tokio::test]
    async fn proxy_clamps_the_limit_before_dispatch() {
        let mock = MockHttp::new().json("/api/skills", skillhub_page(1, &["a"]));
        let mgr = MarketManager::new(mock.clone());

        let _ = proxy(&mgr, &ProxyQuery { limit: 0, ..Default::default() }).await;
        assert!(mock.calls()[0].contains("pageSize=20"), "limit<1 must become 20: {}", mock.calls()[0]);

        let _ = proxy(&mgr, &ProxyQuery { limit: 500, ..Default::default() }).await;
        assert!(mock.calls()[1].contains("pageSize=100"), "limit>100 must become 100: {}", mock.calls()[1]);
    }

    #[tokio::test]
    async fn proxy_routes_search_only_when_the_query_is_non_empty() {
        let mock = MockHttp::new().json("/api/skills", skillhub_page(1, &["a"]));
        let mgr = MarketManager::new(mock.clone());

        // action=search with an empty q degrades to trending (Java parity).
        let _ = proxy(&mgr, &ProxyQuery { action: "search".into(), q: "".into(), limit: 20, ..Default::default() }).await;
        assert!(mock.calls()[0].contains("sortBy=downloads"), "expected trending: {}", mock.calls()[0]);

        let _ = proxy(&mgr, &ProxyQuery { action: "search".into(), q: "pdf".into(), limit: 20, ..Default::default() }).await;
        assert!(mock.calls()[1].contains("sortBy=score"), "expected search: {}", mock.calls()[1]);
        assert!(mock.calls()[1].contains("keyword=pdf"));
    }

    #[tokio::test]
    async fn proxy_passes_the_cursor_through_as_the_page_number() {
        let mock = MockHttp::new().json("/api/skills", skillhub_page(1000, &["a"]));
        let mgr = MarketManager::new(mock.clone());
        let v = proxy(&mgr, &ProxyQuery { cursor: "3".into(), limit: 20, ..Default::default() }).await;
        assert!(mock.calls()[0].contains("page=3"), "{}", mock.calls()[0]);
        assert_eq!(v["data"]["nextCursor"], json!("4"));
    }

    /// skillhub filters server-side, so the controller must not cut the page
    /// again; clawhub does not, so the generic fallback must kick in.
    #[tokio::test]
    async fn proxy_does_not_double_filter_a_server_side_filtered_page() {
        let mock = MockHttp::new().json("/api/skills", json!({
            "code": 0,
            "data": {"total": 2, "skills": [
                {"slug": "a", "name": "A", "category": "dev-programming"},
                {"slug": "b", "name": "B", "category": "other"}
            ]}
        }));
        let mgr = MarketManager::new(mock.clone());
        let v = proxy(&mgr, &ProxyQuery { category: "dev-programming".into(), limit: 20, ..Default::default() }).await;
        assert!(mock.calls()[0].contains("category=dev-programming"));
        assert_eq!(v["data"]["filtered"], json!(true));
        // The adapter already filtered upstream; both items come back untouched
        // and the controller leaves them alone.
        assert_eq!(v["data"]["items"].as_array().unwrap().len(), 2);
    }

    /// A market that parses `category` but does **not** filter, leaving
    /// `filtered = false`. That is the only shape that reaches the proxy's
    /// generic fallback.
    ///
    /// None of the three real adapters can exercise it: `ClawhubMarket` never
    /// populates `category` at all (Java's `ClawhubMarket` has no category code
    /// either), while `SkillhubMarket` and `ModelscopeMarket` both filter inside
    /// the adapter and set `filtered = true` — which is precisely what stops the
    /// proxy from cutting an already-compensated page a second time. So the
    /// fallback is defensive code, and testing it through `clawhub.ai` (as an
    /// earlier version of this test did) asserted 1 surviving item out of a page
    /// whose categories were all `None`: it could only ever yield 0.
    struct UnfilteredCategoryMarket {
        http: Arc<dyn MarketHttp>,
    }

    #[async_trait::async_trait]
    impl Market for UnfilteredCategoryMarket {
        fn name(&self) -> &str { "test-unfiltered" }
        fn description(&self) -> &str { "test adapter that leaves filtering to the proxy" }
        async fn trending(&self, _cursor: &str, _limit: i64, _category: &str) -> MarketResult<MarketPage> {
            let item = |slug: &str, cat: &str| MarketItem {
                display_name: Some(slug.to_uppercase()),
                summary: None,
                description: None,
                owner_handle: None,
                version: None,
                installs: 0,
                stars: 0,
                name: slug.into(),
                url: None,
                slug: slug.into(),
                icon_url: None,
                category: Some(cat.into()),
            };
            Ok(MarketPage {
                items: vec![item("a", "dev"), item("b", "other")],
                next_cursor: None,
                // The point of this adapter: it did NOT filter.
                filtered: false,
            })
        }
        async fn search(&self, _q: &str, c: &str, l: i64, cat: &str) -> MarketResult<MarketPage> {
            self.trending(c, l, cat).await
        }
        async fn detail(&self, _slug: &str) -> MarketResult<MarketDetail> {
            Err("not used by this test".into())
        }
        async fn install(&self, _slug: &str, _dir: &Path) -> MarketResult<String> {
            Err("not used by this test".into())
        }
        fn http(&self) -> Arc<dyn MarketHttp> { self.http.clone() }
    }

    #[tokio::test]
    async fn proxy_filters_client_side_for_a_market_without_server_support() {
        let mock: Arc<dyn MarketHttp> = MockHttp::new();
        let mut mgr = MarketManager::new(mock.clone());
        mgr.register(Arc::new(UnfilteredCategoryMarket { http: mock }));

        let v = proxy(&mgr, &ProxyQuery {
            market_name: "test-unfiltered".into(),
            category: "dev".into(),
            limit: 20,
            ..Default::default()
        }).await;
        assert_eq!(v["code"], json!(200));
        let items = v["data"]["items"].as_array().unwrap();
        assert_eq!(items.len(), 1, "only the `dev` item survives the fallback filter");
        assert_eq!(items[0]["slug"], json!("a"));
        assert_eq!(v["data"]["filtered"], json!(true), "the proxy must mark the page filtered");
    }

    /// The complementary half: an adapter that already filtered must not be cut
    /// again. Without this the fallback would silently halve a compensated page.
    #[tokio::test]
    async fn proxy_does_not_double_filter_an_already_filtered_page() {
        struct PreFiltered;
        #[async_trait::async_trait]
        impl Market for PreFiltered {
            fn name(&self) -> &str { "test-prefiltered" }
            fn description(&self) -> &str { "" }
            async fn trending(&self, _c: &str, _l: i64, _cat: &str) -> MarketResult<MarketPage> {
                Ok(MarketPage {
                    items: vec![MarketItem {
                        display_name: Some("A".into()),
                        summary: None,
                        description: None,
                        owner_handle: None,
                        version: None,
                        installs: 0,
                        stars: 0,
                        name: "a".into(),
                        url: None,
                        slug: "a".into(),
                        icon_url: None,
                        // Deliberately None: a server-side filter may have matched
                        // on data the item does not carry. Re-filtering on it here
                        // would drop the row.
                        category: None,
                    }],
                    next_cursor: None,
                    filtered: true,
                })
            }
            async fn search(&self, _q: &str, c: &str, l: i64, cat: &str) -> MarketResult<MarketPage> {
                self.trending(c, l, cat).await
            }
            async fn detail(&self, _s: &str) -> MarketResult<MarketDetail> { Err("unused".into()) }
            async fn install(&self, _s: &str, _d: &Path) -> MarketResult<String> { Err("unused".into()) }
            fn http(&self) -> Arc<dyn MarketHttp> { MockHttp::new() }
        }

        let mut mgr = MarketManager::new(MockHttp::new());
        mgr.register(Arc::new(PreFiltered));
        let v = proxy(&mgr, &ProxyQuery {
            market_name: "test-prefiltered".into(),
            category: "dev".into(),
            limit: 20,
            ..Default::default()
        }).await;
        let items = v["data"]["items"].as_array().unwrap();
        assert_eq!(items.len(), 1, "an already-filtered page must pass through untouched");
    }

    /// Upstream failure must surface as code 400 with the upstream's message —
    /// never an empty 200 that the UI would render as "no skills".
    #[tokio::test]
    async fn proxy_reports_upstream_http_failure_as_code_400() {
        let mock = MockHttp::new().route("/api/skills", HttpResult {
            status: 503,
            body: b"unavailable".to_vec(),
            content_type: None,
            location: None,
            error: None,
        });
        let mgr = MarketManager::new(mock);
        let v = proxy(&mgr, &ProxyQuery::default()).await;
        assert_eq!(v["code"], json!(400));
        assert!(v["description"].as_str().unwrap().contains("获取热门技能失败"), "{}", v["description"]);
        assert!(v["description"].as_str().unwrap().contains("HTTP 503"));
        assert!(v["data"].is_null());
    }

    #[tokio::test]
    async fn proxy_reports_a_timeout_as_code_400() {
        let mock = MockHttp::new().route("/api/skills", HttpResult::transport_error("request timed out"));
        let mgr = MarketManager::new(mock);
        let v = proxy(&mgr, &ProxyQuery::default()).await;
        assert_eq!(v["code"], json!(400));
        assert!(v["description"].as_str().unwrap().contains("request timed out"));
    }

    /// skillhub signals errors with a non-zero `code` field, not an HTTP status.
    #[tokio::test]
    async fn proxy_surfaces_the_upstream_business_error_message() {
        let mock = MockHttp::new().json("/api/skills", json!({"code": 4001, "message": "rate limited"}));
        let mgr = MarketManager::new(mock);
        let v = proxy(&mgr, &ProxyQuery::default()).await;
        assert_eq!(v["code"], json!(400));
        assert!(v["description"].as_str().unwrap().contains("rate limited"));
    }

    #[tokio::test]
    async fn proxy_degrades_to_an_empty_page_when_upstream_returns_no_data() {
        let mock = MockHttp::new().json("/api/skills", json!({"code": 0}));
        let mgr = MarketManager::new(mock);
        let v = proxy(&mgr, &ProxyQuery::default()).await;
        assert_eq!(v["code"], json!(200));
        assert_eq!(v["data"]["items"], json!([]));
        assert!(v["data"].get("nextCursor").is_none(), "no fabricated cursor");
    }

    // ── detail endpoint ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn detail_requires_a_slug() {
        let mgr = MarketManager::new(MockHttp::new());
        let v = detail(&mgr, "", "").await;
        assert_eq!(v["code"], json!(400));
        assert_eq!(v["description"], json!("slug is required"));
    }

    #[tokio::test]
    async fn detail_parses_the_skillhub_detail_shape() {
        let mock = MockHttp::new().json("/api/v1/skills/pdf", json!({
            "skill": {
                "slug": "pdf", "displayName": "PDF 工具", "summary": "en", "summary_zh": "中文",
                "overviewMd": "# Overview", "iconUrl": "https://cdn/i.png",
                "category": "doc-processing", "tags": ["a", "b"],
                "stats": {"installs": 42, "stars": 7}
            },
            "owner": {"handle": "anthropics"},
            "latestVersion": {"version": "2.1.0"}
        }));
        let mgr = MarketManager::new(mock);
        let v = detail(&mgr, "pdf", "").await;
        assert_eq!(v["code"], json!(200));
        let d = &v["data"];
        assert_eq!(d["slug"], json!("pdf"));
        assert_eq!(d["displayName"], json!("PDF 工具"));
        assert_eq!(d["summary"], json!("中文"), "zh summary wins");
        assert_eq!(d["description"], json!("# Overview"), "overviewMd wins over summary");
        assert_eq!(d["ownerHandle"], json!("anthropics"));
        assert_eq!(d["installs"], json!(42));
        assert_eq!(d["stars"], json!(7));
        assert_eq!(d["iconUrl"], json!("https://cdn/i.png"));
        assert_eq!(d["version"], json!("2.1.0"));
        assert_eq!(d["tags"], json!(["a", "b"]));
        assert_eq!(d["installSlug"], json!("pdf"));
    }

    /// `/api/v1/download` answers **404 "Version not found"** for a bare slug
    /// and only redirects to the real zip for the qualified `@owner/slug` form.
    /// The detail response carries that form in `namespace.canonicalName`, so
    /// `installSlug` must prefer it — otherwise every bare-slug install (detail
    /// dialog direct link, legacy card) fails with a 404 the user cannot act on.
    /// Observed live 2026-10-28: `download?slug=pdf` → 404, while
    /// `download?slug=@org-02qudk26/pdf` → 302 to the COS zip.
    #[tokio::test]
    async fn detail_prefers_the_canonical_name_for_install_slug() {
        let mock = MockHttp::new().json("/api/v1/skills/pdf", json!({
            "skill": {"slug": "pdf", "displayName": "PDF文档助手"},
            "namespace": {"canonicalName": "@org-02qudk26/pdf", "handle": "org-02qudk26", "publicSlug": "pdf"},
            "latestVersion": {"version": "1.0.0"}
        }));
        let mgr = MarketManager::new(mock);
        let v = detail(&mgr, "pdf", "").await;
        assert_eq!(v["code"], json!(200));
        // `slug` stays the bare form the UI asked for (card matching, metadata);
        // only the download identity is qualified.
        assert_eq!(v["data"]["slug"], json!("pdf"));
        assert_eq!(v["data"]["installSlug"], json!("@org-02qudk26/pdf"));
    }

    /// A malformed `canonicalName` must not become the download identity: the
    /// qualified-slug boundary (`is_qualified_slug`) is the same rule the install
    /// directory and the frontend's `marketBareSlug` use, so accepting `@/pdf`
    /// here would desynchronise them.
    #[tokio::test]
    async fn detail_ignores_a_malformed_canonical_name() {
        let mock = MockHttp::new().json("/api/v1/skills/pdf", json!({
            "skill": {"slug": "pdf"},
            "namespace": {"canonicalName": "@/pdf"}
        }));
        let mgr = MarketManager::new(mock);
        let v = detail(&mgr, "pdf", "").await;
        assert_eq!(v["data"]["installSlug"], json!("pdf"));
    }

    /// End-to-end shape of the 404 fix: a **bare** slug install must hit the
    /// download endpoint with the qualified slug resolved from detail, while the
    /// install directory still derives from the bare slug (so the UI's
    /// `findInstalledForMarket` keeps matching the card it rendered).
    #[tokio::test]
    async fn bare_slug_install_downloads_with_the_canonical_name() {
        let s = Scratch::new("install-bare-canonical");
        let skills = s.0.join("skills");
        let mock = MockHttp::new()
            .json("/api/v1/skills/pdf", json!({
                "skill": {"slug": "pdf", "displayName": "PDF文档助手", "iconUrl": "https://cdn/i.png"},
                "namespace": {"canonicalName": "@org-02qudk26/pdf"},
                "latestVersion": {"version": "1.0.0"}
            }))
            .bytes("/api/v1/download", impersonating_zip());
        let market = SkillhubMarket::new(mock.clone());

        let display = market.install("pdf", &skills).await.unwrap();
        assert_eq!(display, "PDF文档助手");

        let calls = mock.calls();
        let dl = calls
            .iter()
            .find(|u| u.contains("/api/v1/download"))
            .expect("download was requested");
        assert!(
            dl.contains("slug=%40org-02qudk26%2Fpdf"),
            "bare slug must be upgraded to the canonical form before download: {}",
            dl
        );

        // Directory + metadata keep the bare slug the user clicked.
        let dir = skills.join("pdf");
        assert!(dir.join("SKILL.md").exists(), "skill must be unpacked");
        let meta = read_market_meta(&dir).unwrap();
        assert_eq!(meta.slug, "pdf");
        assert_eq!(meta.display_name, "PDF文档助手");
        assert_eq!(meta.icon_url, "https://cdn/i.png");
    }

    #[tokio::test]
    async fn detail_reports_a_missing_skill_without_fabricating_one() {
        let mock = MockHttp::new().json("/api/v1/skills/", json!({"error": true, "message": "not found"}));
        let mgr = MarketManager::new(mock);
        let v = detail(&mgr, "ghost", "").await;
        assert_eq!(v["code"], json!(400));
        assert_eq!(v["description"], json!("not found"));
    }

    #[tokio::test]
    async fn detail_reports_a_missing_skill_node() {
        let mock = MockHttp::new().json("/api/v1/skills/", json!({"something": "else"}));
        let mgr = MarketManager::new(mock);
        let v = detail(&mgr, "ghost", "").await;
        assert_eq!(v["code"], json!(400));
        assert_eq!(v["description"], json!("技能不存在: ghost"));
    }

    /// The upstream detail endpoint rejects `@owner/slug`, so the adapter
    /// searches the bare tail and must pick the **byte-exact** canonical match.
    /// Picking the first hit would return the other author's skill.
    #[tokio::test]
    async fn qualified_detail_matches_the_canonical_name_exactly() {
        let mock = MockHttp::new().json("/api/skills", json!({
            "code": 0,
            "data": {"total": 2, "skills": [
                {"slug": "dev-expert", "name": "Wrong Author", "namespace": {"handle": "indiv-ebandao"}, "downloads": 1},
                {"slug": "dev-expert", "name": "编程专家.Skill", "namespace": {"handle": "user_814dbe54"}, "downloads": 900}
            ]}
        }));
        let mgr = MarketManager::new(mock.clone());
        let v = detail(&mgr, "@user_814dbe54/dev-expert", "").await;
        assert_eq!(v["code"], json!(200));
        assert_eq!(v["data"]["slug"], json!("@user_814dbe54/dev-expert"));
        assert_eq!(v["data"]["displayName"], json!("编程专家.Skill"));
        assert_eq!(v["data"]["installs"], json!(900));
        assert!(mock.calls()[0].contains("keyword=dev-expert"), "{}", mock.calls()[0]);
    }

    #[tokio::test]
    async fn qualified_detail_fails_when_the_owner_is_not_in_the_results() {
        let mock = MockHttp::new().json("/api/skills", json!({
            "code": 0,
            "data": {"total": 1, "skills": [
                {"slug": "dev-expert", "name": "Other", "namespace": {"handle": "indiv-ebandao"}}
            ]}
        }));
        let mgr = MarketManager::new(mock);
        let v = detail(&mgr, "@user_814dbe54/dev-expert", "").await;
        assert_eq!(v["code"], json!(400));
        assert_eq!(v["description"], json!("技能不存在: @user_814dbe54/dev-expert"));
    }

    // ── categories / markets endpoints ──────────────────────────────────────

    #[tokio::test]
    async fn categories_returns_the_skillhub_taxonomy_with_both_labels() {
        let mgr = MarketManager::new(MockHttp::new());
        let v = categories(&mgr, "").await;
        assert_eq!(v["code"], json!(200));
        assert_eq!(v["description"], json!(""));
        let arr = v["data"].as_array().unwrap();
        assert_eq!(arr.len(), 10);
        assert_eq!(arr[1]["key"], json!("dev-programming"));
        assert_eq!(arr[1]["name"], json!("Development"));
        assert_eq!(arr[1]["nameZh"], json!("开发编程"));
    }

    #[tokio::test]
    async fn categories_is_empty_for_a_market_without_category_support() {
        let mgr = MarketManager::new(MockHttp::new());
        let v = categories(&mgr, "clawhub.ai").await;
        assert_eq!(v["code"], json!(200));
        assert_eq!(v["data"], json!([]));
    }

    #[tokio::test]
    async fn markets_lists_name_and_description_only() {
        let mgr = MarketManager::new(MockHttp::new());
        let v = markets(&mgr);
        assert_eq!(v["code"], json!(200));
        assert_eq!(v["data"], json!([
            {"name": "skillhub.cn", "description": "专为中国用户优化的技能社区"},
            {"name": "clawhub.ai", "description": ""},
            {"name": "modelscope.cn", "description": "魔搭社区技能广场"}
        ]));
    }

    // ── zip handling ────────────────────────────────────────────────────────

    #[test]
    fn crc32_matches_the_known_vectors() {
        assert_eq!(crc32(b""), 0);
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b"The quick brown fox jumps over the lazy dog"), 0x414F_A339);
    }

    #[test]
    fn unpack_writes_stored_and_deflated_entries() {
        let s = Scratch::new("unpack-ok");
        let dest = s.0.join("out");
        let n = unpack_zip(&good_zip(), &dest, UnpackMode::AsIs).unwrap();
        assert_eq!(n, 2, "the directory entry is not a written file");
        assert!(dest.join("SKILL.md").is_file());
        assert_eq!(std::fs::read_to_string(dest.join("scripts/run.py")).unwrap(), "print('hi')\n");
    }

    /// Zip slip: a `..` entry must be refused outright. Java silently skips such
    /// entries; refusing the whole archive is stricter on purpose — a package
    /// that tries to escape its directory should not be installed at all.
    #[test]
    fn unpack_refuses_parent_traversal_entries() {
        let s = Scratch::new("unpack-slip");
        let dest = s.0.join("skills").join("victim");
        std::fs::create_dir_all(&dest).unwrap();
        let zip = build_zip(&[
            Spec::file("SKILL.md", "---\nname: x\n---\n"),
            Spec::file("../../escaped.md", "pwned"),
        ]);
        let err = unpack_zip(&zip, &dest, UnpackMode::AsIs).unwrap_err();
        assert!(err.contains("拒绝不安全的压缩包条目"), "{}", err);
        assert!(!s.0.join("escaped.md").exists(), "the entry escaped the skill directory");
        assert!(!s.0.join("skills").join("escaped.md").exists());
        assert!(!dest.exists(), "the staging directory must be cleaned up after a refusal");
    }

    #[test]
    fn unpack_refuses_absolute_and_drive_letter_entries() {
        let s = Scratch::new("unpack-abs");
        let dest = s.0.join("out");
        for name in ["/etc/passwd", "C:/Windows/x.txt", "\\windows\\x.txt"] {
            let zip = build_zip(&[Spec::file(name, "x")]);
            let err = unpack_zip(&zip, &dest, UnpackMode::AsIs).unwrap_err();
            assert!(err.contains("拒绝不安全的压缩包条目"), "{} -> {}", name, err);
        }
    }

    #[test]
    fn unpack_refuses_backslash_traversal() {
        let s = Scratch::new("unpack-bs");
        let dest = s.0.join("out");
        let zip = build_zip(&[Spec::file("..\\..\\evil.md", "x")]);
        assert!(unpack_zip(&zip, &dest, UnpackMode::AsIs).is_err());
    }

    /// ModelScope serves GitHub-archive style zips with a single top-level
    /// directory; without stripping it, SKILL.md lands one level too deep and
    /// the skill is never discovered.
    #[test]
    fn unpack_strips_a_single_common_root_when_asked() {
        let s = Scratch::new("unpack-strip");
        let dest = s.0.join("out");
        let zip = build_zip(&[
            Spec::dir("repo-master-abc123"),
            Spec::file("repo-master-abc123/SKILL.md", "---\nname: x\n---\n"),
            Spec::file("repo-master-abc123/sub/a.txt", "a"),
        ]);
        unpack_zip(&zip, &dest, UnpackMode::StripSingleRoot).unwrap();
        assert!(dest.join("SKILL.md").is_file(), "SKILL.md must land at the skill root");
        assert!(dest.join("sub/a.txt").is_file());
        assert!(!dest.join("repo-master-abc123").exists());
    }

    #[test]
    fn unpack_does_not_strip_when_the_root_is_not_unique() {
        let s = Scratch::new("unpack-nostrip");
        let dest = s.0.join("out");
        let zip = build_zip(&[
            Spec::file("a/SKILL.md", "x"),
            Spec::file("b/other.md", "y"),
        ]);
        unpack_zip(&zip, &dest, UnpackMode::StripSingleRoot).unwrap();
        assert!(dest.join("a/SKILL.md").is_file(), "two roots means no stripping");
    }

    #[test]
    fn unpack_does_not_strip_when_a_file_sits_at_the_root() {
        let s = Scratch::new("unpack-rootfile");
        let dest = s.0.join("out");
        let zip = build_zip(&[
            Spec::file("SKILL.md", "x"),
            Spec::file("dir/other.md", "y"),
        ]);
        unpack_zip(&zip, &dest, UnpackMode::StripSingleRoot).unwrap();
        assert!(dest.join("SKILL.md").is_file());
        assert!(dest.join("dir/other.md").is_file());
    }

    #[test]
    fn unpack_ignores_macos_resource_forks() {
        let s = Scratch::new("unpack-macosx");
        let dest = s.0.join("out");
        let zip = build_zip(&[
            Spec::file("SKILL.md", "x"),
            Spec::file("__MACOSX/._SKILL.md", "junk"),
        ]);
        unpack_zip(&zip, &dest, UnpackMode::AsIs).unwrap();
        assert!(dest.join("SKILL.md").is_file());
        assert!(!dest.join("__MACOSX").exists());
    }

    #[test]
    fn unpack_rejects_a_truncated_or_non_zip_body() {
        let s = Scratch::new("unpack-bad");
        let dest = s.0.join("out");
        assert!(unpack_zip(b"not a zip at all", &dest, UnpackMode::AsIs).is_err());
        assert!(unpack_zip(b"", &dest, UnpackMode::AsIs).is_err());
        // A valid EOCD but a central directory that lies about its offset.
        let mut zip = good_zip();
        let eocd = find_eocd(&zip).unwrap();
        let off = eocd + 16;
        zip[off] = 0xFF;
        zip[off + 1] = 0xFF;
        assert!(unpack_zip(&zip, &dest, UnpackMode::AsIs).is_err());
    }

    #[test]
    fn unpack_rejects_an_empty_archive() {
        let s = Scratch::new("unpack-empty");
        let dest = s.0.join("out");
        let err = unpack_zip(&build_zip(&[]), &dest, UnpackMode::AsIs).unwrap_err();
        assert!(err.contains("empty"), "{}", err);
    }

    /// A truncated download must not be installed as a good skill.
    #[test]
    fn unpack_rejects_a_crc_mismatch() {
        let s = Scratch::new("unpack-crc");
        let dest = s.0.join("out");
        let zip = build_zip(&[Spec::file("SKILL.md", "---\nname: x\n---\n").corrupt_crc()]);
        let err = unpack_zip(&zip, &dest, UnpackMode::AsIs).unwrap_err();
        assert!(err.contains("校验失败"), "{}", err);
        assert!(!dest.exists());
    }

    #[test]
    fn unpack_rejects_an_unsupported_compression_method() {
        let s = Scratch::new("unpack-method");
        let dest = s.0.join("out");
        let mut zip = build_zip(&[Spec::file("SKILL.md", "x")]);
        // Flip the method in the central directory to 99 (unsupported).
        let eocd = find_eocd(&zip).unwrap();
        let cd = rd_u32(&zip, eocd + 16) as usize;
        zip[cd + 10] = 99;
        let err = unpack_zip(&zip, &dest, UnpackMode::AsIs).unwrap_err();
        assert!(err.contains("不支持的压缩算法"), "{}", err);
    }

    // ── install pipeline ────────────────────────────────────────────────────

    /// **The trust boundary.** The package declares `displayName: "Agent
    /// Browser"`; the market says "编程专家.Skill". Only the market's value may
    /// reach `.skill-market.json` — otherwise a publisher can disguise their
    /// skill as any already-installed one.
    #[test]
    fn install_takes_the_display_name_from_the_market_never_the_package() {
        let s = Scratch::new("install-trust");
        let skills = s.0.join("skills");
        let out = install_sync(
            &impersonating_zip(),
            &skills,
            "_user_814dbe54_dev-expert",
            "编程专家.Skill",
            "skillhub.cn",
            "@user_814dbe54/dev-expert",
            "https://cdn/i.png",
            "1.0.0",
            UnpackMode::AsIs,
        )
        .unwrap();
        assert_eq!(out, "编程专家.Skill");

        let dir = skills.join("_user_814dbe54_dev-expert");
        let raw = std::fs::read_to_string(dir.join(".skill-market.json")).unwrap();
        assert!(!raw.contains("Agent Browser"), "the package's self-declared name was persisted: {}", raw);

        // And the registry — the read side of the same boundary — agrees.
        let all = SkillRegistry::with_dir(skills.clone()).load_all();
        assert_eq!(all.len(), 1);
        assert_eq!(display_name_of(all[0].market.as_ref()).as_deref(), Some("编程专家.Skill"));
    }

    /// The metadata shape must be exactly what `skills/mod.rs` reads, or the
    /// installed list loses the market badge and the toggle/uninstall keys.
    #[test]
    fn install_writes_metadata_the_registry_can_read() {
        let s = Scratch::new("install-meta");
        let skills = s.0.join("skills");
        install_sync(
            &good_zip(),
            &skills,
            "pdf",
            "PDF 工具",
            "skillhub.cn",
            "pdf",
            "https://cdn/i.png",
            "2.1.0",
            UnpackMode::AsIs,
        )
        .unwrap();

        let meta = read_market_meta(&skills.join("pdf")).expect("metadata must parse");
        assert_eq!(meta.market, "skillhub.cn");
        assert_eq!(meta.slug, "pdf");
        assert_eq!(meta.icon_url, "https://cdn/i.png");
        assert_eq!(meta.display_name, "PDF 工具");

        // Extra forward-compatible fields must not break the existing reader.
        let raw: Value = serde_json::from_str(
            &std::fs::read_to_string(skills.join("pdf").join(".skill-market.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(raw["canonicalName"], json!("pdf"));
        assert_eq!(raw["version"], json!("2.1.0"));
    }

    /// Empty optional fields are omitted, matching Java's `writeMarketMeta`
    /// (which only sets iconUrl/displayName when non-empty).
    #[test]
    fn install_omits_empty_optional_metadata_fields() {
        let s = Scratch::new("install-sparse");
        let skills = s.0.join("skills");
        install_sync(&good_zip(), &skills, "x", "X", "skillhub.cn", "x", "", "", UnpackMode::AsIs).unwrap();
        let raw: Value =
            serde_json::from_str(&std::fs::read_to_string(skills.join("x").join(".skill-market.json")).unwrap()).unwrap();
        assert!(raw.get("iconUrl").is_none());
        assert!(raw.get("version").is_none());
        assert_eq!(raw["displayName"], json!("X"));
    }

    /// Two authors sharing the bare slug `dev-expert` must coexist on disk.
    #[test]
    fn install_keeps_two_same_slug_skills_from_different_owners_apart() {
        let s = Scratch::new("install-collision");
        let skills = s.0.join("skills");
        for (slug, dir, display) in [
            ("@user_814dbe54/dev-expert", "_user_814dbe54_dev-expert", "编程专家.Skill"),
            ("@indiv-ebandao/dev-expert", "_indiv-ebandao_dev-expert", "Dev Expert (other)"),
        ] {
            install_sync(&good_zip(), &skills, dir, display, "skillhub.cn", slug, "", "", UnpackMode::AsIs).unwrap();
        }
        let all = SkillRegistry::with_dir(skills.clone()).load_all();
        assert_eq!(all.len(), 2, "both skills must survive: {:?}", all.iter().map(|s| &s.name).collect::<Vec<_>>());
        let by = |n: &str| all.iter().find(|s| s.name == n).unwrap();
        assert_eq!(by("_user_814dbe54_dev-expert").market.as_ref().unwrap().slug, "@user_814dbe54/dev-expert");
        assert_eq!(by("_indiv-ebandao_dev-expert").market.as_ref().unwrap().slug, "@indiv-ebandao/dev-expert");
        assert_eq!(
            display_name_of(by("_user_814dbe54_dev-expert").market.as_ref()).as_deref(),
            Some("编程专家.Skill")
        );
    }

    /// The installed skill must be operable by the existing endpoints: toggle
    /// writes `enabled` and the registry re-reads it.
    #[test]
    fn installed_skill_is_compatible_with_toggle_and_uninstall() {
        let s = Scratch::new("install-compat");
        let skills = s.0.join("skills");
        install_sync(&good_zip(), &skills, "pdf", "PDF", "skillhub.cn", "pdf", "", "", UnpackMode::AsIs).unwrap();
        let dir = skills.join("pdf");

        assert!(SkillRegistry::with_dir(skills.clone()).load_all()[0].enabled);
        assert!(set_enabled(&dir, false).unwrap(), "toggle must find the SKILL.md the installer wrote");
        let all = SkillRegistry::with_dir(skills.clone()).load_all();
        assert!(!all[0].enabled, "the toggle did not persist");
        // Metadata survives the front-matter rewrite.
        assert_eq!(all[0].market.as_ref().unwrap().display_name, "PDF");

        // Uninstall resolves the same directory the installer created.
        assert_eq!(SkillRegistry::with_dir(skills.clone()).find_dir("pdf").as_deref(), Some(dir.as_path()));
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(SkillRegistry::with_dir(skills.clone()).load_all().is_empty());
    }

    /// Hardening: Java reports success for any archive that downloaded, so the
    /// UI says "installed" while the skill never appears in the registry.
    #[test]
    fn install_refuses_an_archive_without_a_skill_md() {
        let s = Scratch::new("install-nomd");
        let skills = s.0.join("skills");
        let zip = build_zip(&[Spec::file("README.md", "hello")]);
        let err = install_sync(&zip, &skills, "x", "X", "skillhub.cn", "x", "", "", UnpackMode::AsIs).unwrap_err();
        assert!(err.contains("SKILL.md"), "{}", err);
        assert!(!skills.join("x").exists(), "a rejected install must not leave a directory behind");
    }

    /// Hardening: Java deletes the existing directory *before* unzipping, so a
    /// failed extraction destroys the working skill. Here the previous version
    /// must survive intact.
    #[test]
    fn a_failed_reinstall_rolls_back_to_the_previous_version() {
        let s = Scratch::new("install-rollback");
        let skills = s.0.join("skills");
        install_sync(&good_zip(), &skills, "pdf", "PDF v1", "skillhub.cn", "pdf", "", "1.0.0", UnpackMode::AsIs)
            .unwrap();
        let before = std::fs::read_to_string(skills.join("pdf").join("SKILL.md")).unwrap();

        let broken = build_zip(&[Spec::file("README.md", "no skill here")]);
        assert!(install_sync(&broken, &skills, "pdf", "PDF v2", "skillhub.cn", "pdf", "", "2.0.0", UnpackMode::AsIs).is_err());

        let dir = skills.join("pdf");
        assert!(dir.is_dir(), "the previous install was destroyed");
        assert_eq!(std::fs::read_to_string(dir.join("SKILL.md")).unwrap(), before);
        assert_eq!(read_market_meta(&dir).unwrap().display_name, "PDF v1", "metadata was clobbered");
    }

    #[test]
    fn a_successful_reinstall_replaces_the_previous_version() {
        let s = Scratch::new("install-replace");
        let skills = s.0.join("skills");
        install_sync(&good_zip(), &skills, "pdf", "PDF v1", "skillhub.cn", "pdf", "", "1.0.0", UnpackMode::AsIs)
            .unwrap();
        std::fs::write(skills.join("pdf").join("stale.txt"), "old").unwrap();

        let zip = build_zip(&[Spec::file("SKILL.md", "---\nname: pdf\ndescription: v2\n---\n")]);
        install_sync(&zip, &skills, "pdf", "PDF v2", "skillhub.cn", "pdf", "", "2.0.0", UnpackMode::AsIs).unwrap();

        assert!(!skills.join("pdf").join("stale.txt").exists(), "stale files must not survive a reinstall");
        assert_eq!(read_market_meta(&skills.join("pdf")).unwrap().display_name, "PDF v2");
    }

    /// Staging and backup directories are dot-prefixed (so the scanner ignores
    /// them) and must not be left behind.
    #[test]
    fn install_leaves_no_staging_or_backup_directories() {
        let s = Scratch::new("install-clean");
        let skills = s.0.join("skills");
        install_sync(&good_zip(), &skills, "pdf", "PDF", "skillhub.cn", "pdf", "", "", UnpackMode::AsIs).unwrap();
        let leftovers: Vec<String> = std::fs::read_dir(&skills)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with(".install-"))
            .collect();
        assert!(leftovers.is_empty(), "leftover staging dirs: {:?}", leftovers);
    }

    /// The directory name is derived from a slug but still ends up in a path.
    #[test]
    fn install_refuses_a_directory_name_that_could_escape() {
        let s = Scratch::new("install-dirname");
        let skills = s.0.join("skills");
        for bad in ["../escape", "a/b", "a\\b", ""] {
            let err = install_sync(&good_zip(), &skills, bad, "X", "m", "s", "", "", UnpackMode::AsIs).unwrap_err();
            assert!(err.contains("Invalid slug"), "{} -> {}", bad, err);
        }
        assert!(!s.0.join("escape").exists());
    }

    // ── full install over the injected transport ────────────────────────────

    #[tokio::test]
    async fn skillhub_install_downloads_the_qualified_slug_and_writes_metadata() {
        let s = Scratch::new("install-e2e");
        let skills = s.0.join("skills");
        let mock = MockHttp::new()
            .json("/api/skills", json!({
                "code": 0,
                "data": {"total": 2, "skills": [
                    {"slug": "dev-expert", "name": "Wrong", "namespace": {"handle": "indiv-ebandao"}, "downloads": 1},
                    {"slug": "dev-expert", "name": "编程专家.Skill", "namespace": {"handle": "user_814dbe54"},
                     "downloads": 900, "iconUrl": "https://cdn/i.png", "version": "3.2.1"}
                ]}
            }))
            .bytes("/api/v1/download", impersonating_zip());
        let market = SkillhubMarket::new(mock.clone());

        let display = market.install("@user_814dbe54/dev-expert", &skills).await.unwrap();
        assert_eq!(display, "编程专家.Skill", "the package's fake name must not win");

        // The download URL carries the qualified slug, percent-encoded.
        // Bind the recorded calls first: `calls()` returns an owned Vec, so
        // chaining `.iter()` off it borrows a temporary that dies immediately.
        let calls = mock.calls();
        let dl = calls
            .iter()
            .find(|u| u.contains("/api/v1/download"))
            .expect("download was requested");
        assert!(dl.contains("slug=%40user_814dbe54%2Fdev-expert"), "{}", dl);

        let dir = skills.join("_user_814dbe54_dev-expert");
        let meta = read_market_meta(&dir).unwrap();
        assert_eq!(meta.slug, "@user_814dbe54/dev-expert");
        assert_eq!(meta.display_name, "编程专家.Skill");
        assert_eq!(meta.market, "skillhub.cn");
        assert_eq!(meta.icon_url, "https://cdn/i.png");
    }

    #[tokio::test]
    async fn install_reports_an_upstream_404_as_a_failure() {
        let s = Scratch::new("install-404");
        let skills = s.0.join("skills");
        let mock = MockHttp::new().route("/api/v1/skills/", HttpResult {
            status: 404,
            body: b"{}".to_vec(),
            content_type: None,
            location: None,
            error: None,
        });
        let market = SkillhubMarket::new(mock);
        let err = market.install("ghost", &skills).await.unwrap_err();
        assert!(err.starts_with("技能不存在:"), "{}", err);
        assert!(err.contains("HTTP 404"), "{}", err);
        assert!(!skills.join("ghost").exists(), "nothing may be installed after a 404");
    }

    #[tokio::test]
    async fn install_reports_a_download_timeout_as_a_failure() {
        let s = Scratch::new("install-timeout");
        let skills = s.0.join("skills");
        let mock = MockHttp::new()
            .json("/api/v1/skills/pdf", json!({"skill": {"slug": "pdf", "displayName": "PDF"}}))
            .route("/api/v1/download", HttpResult::transport_error("request timed out"));
        let market = SkillhubMarket::new(mock);
        let err = market.install("pdf", &skills).await.unwrap_err();
        assert!(err.contains("下载技能包失败"), "{}", err);
        assert!(err.contains("request timed out"), "{}", err);
        assert!(!skills.join("pdf").exists());
    }

    #[tokio::test]
    async fn install_rejects_an_empty_download_body() {
        let s = Scratch::new("install-emptybody");
        let skills = s.0.join("skills");
        let mock = MockHttp::new()
            .json("/api/v1/skills/pdf", json!({"skill": {"slug": "pdf", "displayName": "PDF"}}))
            .bytes("/api/v1/download", Vec::new());
        let market = SkillhubMarket::new(mock);
        let err = market.install("pdf", &skills).await.unwrap_err();
        assert!(err.contains("返回内容为空"), "{}", err);
    }

    #[tokio::test]
    async fn install_rejects_an_invalid_slug_before_any_request() {
        let s = Scratch::new("install-badslug");
        let skills = s.0.join("skills");
        let mock = MockHttp::new();
        let market = SkillhubMarket::new(mock.clone());
        assert_eq!(market.install("", &skills).await.unwrap_err(), "slug is required");
        assert_eq!(market.install("!!!", &skills).await.unwrap_err(), "Invalid slug");
        assert!(mock.calls().is_empty(), "an invalid slug must not reach the network");
    }

    #[tokio::test]
    async fn modelscope_install_strips_the_archive_root_and_uses_the_fallback() {
        let s = Scratch::new("install-modelscope");
        let skills = s.0.join("skills");
        let zip = build_zip(&[
            Spec::dir("pdf-master-abc"),
            Spec::file("pdf-master-abc/SKILL.md", "---\nname: pdf\ndescription: d\n---\n"),
        ]);
        let mock = MockHttp::new()
            .json("/openapi/v1/skills/", json!({
                "success": true,
                "data": {"id": "@anthropics/pdf", "display_name": "PDF",
                         "source_url": "https://github.com/anthropics/pdf", "logo_url": "https://cdn/l.png"}
            }))
            // Primary source fails; the GitHub fallback serves the archive.
            .route("/archive/zip/master", HttpResult { status: 500, body: Vec::new(), content_type: None, location: None, error: None })
            .bytes("/archive/refs/heads/", zip);
        let market = ModelscopeMarket::new(mock.clone());

        let display = market.install("@anthropics/pdf", &skills).await.unwrap();
        assert_eq!(display, "PDF");
        let dir = skills.join("_anthropics_pdf");
        assert!(dir.join("SKILL.md").is_file(), "the archive root must be stripped");
        assert_eq!(read_market_meta(&dir).unwrap().slug, "@anthropics/pdf");
        assert!(mock.calls().iter().any(|u| u.contains("github.com/anthropics/pdf/archive/refs/heads/HEAD.zip")));
    }

    #[tokio::test]
    async fn modelscope_install_fails_when_every_source_is_down() {
        let s = Scratch::new("install-ms-down");
        let skills = s.0.join("skills");
        let mock = MockHttp::new()
            .json("/openapi/v1/skills/", json!({"success": true, "data": {"id": "@a/b", "display_name": "B"}}))
            .route("/archive/zip/master", HttpResult::transport_error("connection failed"));
        let market = ModelscopeMarket::new(mock);
        let err = market.install("@a/b", &skills).await.unwrap_err();
        assert!(err.contains("所有下载源均不可用"), "{}", err);
        assert!(!skills.join("_a_b").exists());
    }

    #[tokio::test]
    async fn modelscope_detail_reports_a_missing_skill() {
        let mock = MockHttp::new().json("/openapi/v1/skills/", json!({"success": false, "message": "no such skill"}));
        let market = ModelscopeMarket::new(mock);
        assert_eq!(market.detail("@a/b").await.unwrap_err(), "技能不存在: @a/b");
    }

    #[tokio::test]
    async fn clawhub_install_uses_the_bare_slug_directory() {
        let s = Scratch::new("install-clawhub");
        let skills = s.0.join("skills");
        let mock = MockHttp::new()
            .json("/api/v1/skills/tool", json!({
                "skill": {"slug": "tool", "displayName": "Tool", "icon": "https://cdn/t.png"},
                "latestVersion": {"version": "0.1.0"}
            }))
            .bytes("/api/v1/download", good_zip());
        let market = ClawhubMarket::new(mock.clone());
        let display = market.install("tool", &skills).await.unwrap();
        assert_eq!(display, "Tool");
        let meta = read_market_meta(&skills.join("tool")).unwrap();
        assert_eq!(meta.market, "clawhub.ai");
        assert_eq!(meta.icon_url, "https://cdn/t.png");
        assert!(mock.calls().iter().any(|u| u.contains("clawhub.ai/api/v1/download?slug=tool")));
    }

    // ── icon proxy: SSRF gate ───────────────────────────────────────────────

    #[test]
    fn private_and_reserved_addresses_are_refused() {
        let bad = [
            "127.0.0.1", "127.255.255.254", "10.0.0.1", "10.255.255.255", "192.168.0.1",
            "172.16.0.1", "172.31.255.255", "169.254.169.254", "0.0.0.0", "224.0.0.1",
            "255.255.255.255", "100.64.0.1", "100.127.255.255", "198.18.0.1", "198.19.255.255",
            "::1", "::", "ff02::1", "fc00::1", "fd12::1", "fe80::1", "fec0::1", "::ffff:10.0.0.1",
            "::ffff:169.254.169.254",
        ];
        for b in bad {
            let ip: std::net::IpAddr = b.parse().unwrap();
            assert!(is_private_ip(&ip), "{} must be refused", b);
        }
        let good = ["93.184.216.34", "8.8.8.8", "1.1.1.1", "100.63.0.1", "100.128.0.1", "2606:2800:220:1:248:1893:25c8:1946"];
        for g in good {
            let ip: std::net::IpAddr = g.parse().unwrap();
            assert!(!is_private_ip(&ip), "{} must be allowed", g);
        }
    }

    /// The gate is checked per hop, so a public URL that redirects into the
    /// private range must be refused — that is the whole reason the redirect
    /// loop is manual instead of delegated to the HTTP client.
    #[tokio::test]
    async fn icon_refuses_a_redirect_into_a_private_address() {
        let mock = MockHttp::new().route("93.184.216.34", HttpResult {
            status: 302,
            body: Vec::new(),
            content_type: None,
            location: Some("http://169.254.169.254/latest/meta-data/".into()),
            error: None,
        });
        assert!(fetch_icon(mock.as_ref(), "http://93.184.216.34/i.png").await.is_none());
    }

    #[tokio::test]
    async fn icon_refuses_non_http_schemes() {
        let mock = MockHttp::new();
        for url in ["file:///etc/passwd", "ftp://93.184.216.34/x", "gopher://93.184.216.34/x", "", "not a url"] {
            assert!(fetch_icon(mock.as_ref(), url).await.is_none(), "{} must be refused", url);
        }
        assert!(mock.calls().is_empty(), "a refused URL must never be requested");
    }

    #[tokio::test]
    async fn icon_refuses_a_private_host_without_requesting_it() {
        let mock = MockHttp::new().route("127.0.0.1", HttpResult {
            status: 200,
            body: b"secret".to_vec(),
            content_type: Some("image/png".into()),
            location: None,
            error: None,
        });
        assert!(fetch_icon(mock.as_ref(), "http://127.0.0.1/i.png").await.is_none());
        assert!(mock.calls().is_empty(), "the gate must run before the request");
    }

    #[tokio::test]
    async fn icon_follows_a_public_redirect_and_caps_the_hop_count() {
        let mock = MockHttp::new()
            .route("hop0", HttpResult { status: 301, body: Vec::new(), content_type: None, location: Some("http://93.184.216.34/hop1".into()), error: None })
            .route("hop1", HttpResult { status: 200, body: b"png-bytes".to_vec(), content_type: Some("image/png".into()), location: None, error: None });
        let got = fetch_icon(mock.as_ref(), "http://93.184.216.34/hop0").await.expect("one hop is fine");
        assert_eq!(got.bytes, b"png-bytes");

        // A redirect loop must stop after ICON_MAX_REDIRECTS hops.
        let loopy = MockHttp::new().route("93.184.216.34", HttpResult {
            status: 302,
            body: Vec::new(),
            content_type: None,
            location: Some("http://93.184.216.34/again".into()),
            error: None,
        });
        assert!(fetch_icon(loopy.as_ref(), "http://93.184.216.34/start").await.is_none());
    }

    #[tokio::test]
    async fn icon_resolves_a_relative_location_against_the_current_url() {
        let mock = MockHttp::new()
            .route("/a", HttpResult { status: 302, body: Vec::new(), content_type: None, location: Some("/b/i.png".into()), error: None })
            .route("/b/i.png", HttpResult { status: 200, body: b"x".to_vec(), content_type: Some("image/png".into()), location: None, error: None });
        let got = fetch_icon(mock.as_ref(), "http://93.184.216.34/a").await.expect("relative redirect");
        assert_eq!(got.bytes, b"x");
        assert!(mock.calls()[1].ends_with("/b/i.png"), "{}", mock.calls()[1]);
    }

    #[tokio::test]
    async fn icon_refuses_an_oversized_body() {
        let big = vec![0u8; (ICON_MAX_BYTES + 1) as usize];
        let mock = MockHttp::new().route("93.184.216.34", HttpResult {
            status: 200,
            body: big,
            content_type: Some("image/png".into()),
            location: None,
            error: None,
        });
        assert!(fetch_icon(mock.as_ref(), "http://93.184.216.34/big.png").await.is_none());
    }

    #[tokio::test]
    async fn icon_refuses_an_upstream_error_status() {
        let mock = MockHttp::new().route("93.184.216.34", HttpResult {
            status: 500,
            body: b"boom".to_vec(),
            content_type: None,
            location: None,
            error: None,
        });
        assert!(fetch_icon(mock.as_ref(), "http://93.184.216.34/i.png").await.is_none());
    }

    /// An upstream `text/html` error page must not be served as this endpoint's
    /// response: the content type falls back to `image/png`.
    #[test]
    fn icon_content_type_only_passes_images_through() {
        let mk = |ct: &str| IconFetch { bytes: vec![1], content_type: Some(ct.into()) };
        assert_eq!(icon_content_type(&mk("image/svg+xml")), "image/svg+xml");
        assert_eq!(icon_content_type(&mk("image/webp")), "image/webp");
        assert_eq!(icon_content_type(&mk("text/html; charset=utf-8")), "image/png");
        assert_eq!(icon_content_type(&mk("application/octet-stream")), "image/png");
        assert_eq!(icon_content_type(&IconFetch { bytes: vec![1], content_type: None }), "image/png");
    }

    // ── installed-index helpers (server-side mirror of the frontend logic) ──

    #[test]
    fn bare_slug_counts_decide_whether_a_legacy_install_can_be_claimed() {
        let items = vec![
            MarketItem { slug: "@user_814dbe54/dev-expert".into(), ..Default::default() },
            MarketItem { slug: "@indiv-ebandao/dev-expert".into(), ..Default::default() },
            MarketItem { slug: "@a/unique".into(), ..Default::default() },
        ];
        let counts = count_bare_slugs(&items);
        assert_eq!(counts["dev-expert"], 2, "two authors share this bare slug");
        assert_eq!(counts["unique"], 1);
    }

    #[test]
    fn installed_index_keys_use_the_market_and_slug_pair() {
        let meta = MarketMeta {
            market: "skillhub.cn".into(),
            slug: "@user_814dbe54/dev-expert".into(),
            icon_url: String::new(),
            display_name: "编程专家.Skill".into(),
        };
        assert_eq!(installed_index_keys(&meta), vec!["market:skillhub.cn|@user_814dbe54/dev-expert".to_string()]);
        // Without both halves there is no key: a partial key would match the
        // wrong card.
        let partial = MarketMeta { market: "skillhub.cn".into(), ..Default::default() };
        assert!(installed_index_keys(&partial).is_empty());
    }

    #[test]
    fn installed_meta_reads_what_the_installer_wrote() {
        let s = Scratch::new("installed-meta");
        let dir = s.0.join("pdf");
        std::fs::create_dir_all(&dir).unwrap();
        write_market_meta(&dir, "skillhub.cn", "@a/pdf", "PDF", "https://cdn/i.png", "1.0").unwrap();
        let meta = installed_meta(&dir).unwrap();
        assert_eq!(meta.slug, "@a/pdf");
        assert_eq!(display_name_of(Some(&meta)).as_deref(), Some("PDF"));
    }

    /// A legacy record with no displayName falls back to the bare tail of the
    /// slug — the same chain the registry uses.
    #[test]
    fn legacy_metadata_falls_back_to_the_bare_slug() {
        let s = Scratch::new("legacy-meta");
        let dir = s.0.join("dev-expert");
        std::fs::create_dir_all(&dir).unwrap();
        write_market_meta(&dir, "skillhub.cn", "@user_814dbe54/dev-expert", "", "", "").unwrap();
        let meta = installed_meta(&dir).unwrap();
        assert_eq!(meta.display_name, "");
        assert_eq!(display_name_of(Some(&meta)).as_deref(), Some("dev-expert"));
    }
}

