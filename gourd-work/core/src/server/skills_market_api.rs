//! `skills_market_api` — axum handlers for the five skill-marketplace endpoints
//! the Rust kernel was missing.
//!
//! | Method | Path                              | Java source |
//! |--------|-----------------------------------|-------------|
//! | GET    | `/web/settings/skills/proxy`      | `WebSettingsController.skillsProxy` (line 2497) |
//! | GET    | `/web/settings/skills/detail`     | `WebSettingsController.skillsDetail` (line 2713) |
//! | GET    | `/web/settings/skills/categories` | `WebSettingsController.skillsCategories` (line 2727) |
//! | POST   | `/web/settings/skills/install`    | `WebSettingsController.skillsInstall` (line 2544) |
//! | GET    | `/web/settings/skills/icon`       | `WebSettingsController.skillsIcon` (line 2793) |
//!
//! All business logic lives in `crate::skills::market`; this file only maps HTTP
//! shapes onto it.
//!
//! ## Extractor choice is part of the contract
//!
//! The frontend (`desktop/ui/js/app-skills.js`, `installSkill`) calls `$.ajax`
//! with a `data` object and **no** `contentType`, so jQuery sends
//! `application/x-www-form-urlencoded`. `install` therefore takes `Form<..>`;
//! `Json<..>` would answer 415 and the install button would look dead. The four
//! GET endpoints take `Query<..>`.
//!
//! ## Response envelope
//!
//! `{code, description, data}` with `description: ""` on success — Solon's
//! `Result.succeed` sets the empty string, not `"succeed"`. Failures use
//! `code: 400` and carry the upstream's own message; nothing here fabricates a
//! success.

use std::sync::Arc;

use axum::extract::Query;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Form, Json};
use serde::Deserialize;
use serde_json::Value;

use crate::config::Settings;
use crate::skills::market::{self, MarketHttp, ProxyQuery};

// ─── Query / form shapes ─────────────────────────────────────────────────────

/// `GET /web/settings/skills/proxy` parameters.
///
/// Defaults mirror the Java `@Param(defaultValue = ...)` annotations exactly, so
/// a request that omits a field behaves the same against either kernel.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct ProxyParams {
    #[serde(default = "default_action")]
    pub action: String,
    #[serde(default)]
    pub q: String,
    #[serde(default)]
    pub cursor: String,
    #[serde(default = "default_limit")]
    pub limit: i64,
    #[serde(rename = "marketName", default)]
    pub market_name: String,
    #[serde(default)]
    pub category: String,
}

fn default_action() -> String {
    "trending".into()
}

fn default_limit() -> i64 {
    20
}

impl ProxyParams {
    fn into_query(self) -> ProxyQuery {
        ProxyQuery {
            action: self.action,
            q: self.q,
            cursor: self.cursor,
            limit: self.limit,
            market_name: self.market_name,
            category: self.category,
        }
    }
}

/// `GET /web/settings/skills/detail` parameters.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct DetailParams {
    #[serde(default)]
    pub slug: String,
    #[serde(rename = "marketName", default)]
    pub market_name: String,
}

/// `GET /web/settings/skills/categories` parameters.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct CategoriesParams {
    #[serde(rename = "marketName", default)]
    pub market_name: String,
}

/// `POST /web/settings/skills/install` body (form-encoded).
///
/// `scope` is accepted and deliberately ignored: Java's `skillsInstall`
/// documents that installs always land in the global scope and the parameter
/// survives only for older frontends.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct InstallForm {
    #[serde(default)]
    pub slug: String,
    #[serde(rename = "marketName", default)]
    pub market_name: String,
    #[serde(default)]
    pub scope: String,
}

/// `GET /web/settings/skills/icon` parameters.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct IconParams {
    #[serde(default)]
    pub url: String,
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/// `GET /web/settings/skills/proxy` — trending list or search, cursor-paged.
pub async fn skills_proxy(Query(params): Query<ProxyParams>) -> Json<Value> {
    let mgr = market::global_manager();
    Json(market::proxy(&mgr, &params.into_query()).await)
}

/// `GET /web/settings/skills/detail` — detail-dialog payload.
pub async fn skills_detail(Query(params): Query<DetailParams>) -> Json<Value> {
    let mgr = market::global_manager();
    Json(market::detail(&mgr, &params.slug, &params.market_name).await)
}

/// `GET /web/settings/skills/markets` — the market tabs.
///
/// Delegates to `MarketManager::infos`, so the tab list is exactly the set of
/// registered adapters and cannot drift from the adapters that actually serve
/// `proxy` / `detail` / `install`. (A hardcoded stub used to answer this route
/// with skillhub alone, which made clawhub and modelscope disappear from the
/// UI even though both adapters were registered and working.)
pub async fn skills_markets() -> Json<Value> {
    let mgr = market::global_manager();
    Json(market::markets(&mgr))
}

/// `GET /web/settings/skills/categories` — filter chips.
///
/// A market with no category support yields an empty list, which makes the
/// frontend hide the bar. That is the intended degradation, not an error.
pub async fn skills_categories(Query(params): Query<CategoriesParams>) -> Json<Value> {
    let mgr = market::global_manager();
    Json(market::categories(&mgr, &params.market_name).await)
}

/// `POST /web/settings/skills/install` — download, unpack, register.
///
/// Always installs into the **global** skills directory (`~/.gwork/skills`),
/// matching Java: skills are agent-global and discovered at runtime.
pub async fn skills_install(Form(form): Form<InstallForm>) -> Json<Value> {
    if form.slug.trim().is_empty() {
        return Json(market::failure("slug is required"));
    }
    let mgr = market::global_manager();
    let market = mgr.by_name(&form.market_name);
    let skills_dir = install_skills_dir();

    match market.install(&form.slug, &skills_dir).await {
        // Java returns `Result.succeed(displayName)`: `data` is the display-name
        // string, which the frontend prints in the success toast.
        Ok(display_name) => Json(market::succeed(Value::String(display_name))),
        Err(e) => Json(market::failure(e)),
    }
}

/// `GET /web/settings/skills/icon` — server-side icon proxy.
///
/// Answers raw bytes with an `image/*` content type, or HTTP 404 with an empty
/// body when the URL is refused or the fetch fails (Java parity). The frontend's
/// `<img onerror="this.remove()">` then reveals the letter placeholder, so a 404
/// here degrades gracefully instead of showing a broken image.
pub async fn skills_icon(Query(params): Query<IconParams>) -> Response {
    let http = market::ReqwestMarketHttp::new();
    match market::fetch_icon(&http, &params.url).await {
        None => (StatusCode::NOT_FOUND, "").into_response(),
        Some(fetch) => {
            let ct = market::icon_content_type(&fetch);
            (
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, ct.as_str()),
                    // Same browser-side cache the Java kernel sets.
                    (header::CACHE_CONTROL, "public, max-age=86400"),
                ],
                fetch.bytes,
            )
                .into_response()
        }
    }
}

// ─── Seams used by tests ─────────────────────────────────────────────────────

/// Build a manager over an injected transport. Handlers use
/// `market::global_manager()`; tests use this so no request ever reaches
/// `api.skillhub.cn`.
pub fn manager_with(http: Arc<dyn MarketHttp>) -> market::MarketManager {
    market::MarketManager::new(http)
}

/// The directory an install lands in. One definition, so the "installs are
/// always global" rule cannot drift between the handler and its test.
pub fn install_skills_dir() -> std::path::PathBuf {
    Settings::gwork_home().join("skills")
}

/// Fake a successful upstream JSON response (test helper).
pub fn http_json(status: u16, body: &str) -> market::HttpResult {
    market::HttpResult {
        status,
        body: body.as_bytes().to_vec(),
        content_type: Some("application/json".into()),
        location: None,
        error: None,
    }
}

/// Fake a transport failure (test helper).
pub fn http_error(msg: &str) -> market::HttpResult {
    market::HttpResult::transport_error(msg)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `/web/settings/skills/markets` must list **every** registered adapter.
    ///
    /// This route was once wired to a hardcoded stub in `settings_api` that
    /// answered with skillhub alone, so the clawhub and modelscope tabs
    /// vanished from the UI while both adapters were registered and fully
    /// functional — the list endpoint and the endpoints it feeds (`proxy`,
    /// `detail`, `install`) had drifted apart. Asserting through the handler
    /// keeps the tab list bound to the same `MarketManager` the other four
    /// endpoints resolve through.
    #[tokio::test]
    async fn markets_lists_every_registered_adapter() {
        let v = skills_markets().await.0;
        assert_eq!(v["code"], serde_json::json!(200));
        let names: Vec<String> = v["data"]
            .as_array()
            .expect("data must be an array")
            .iter()
            .map(|m| m["name"].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(names, vec!["skillhub.cn", "clawhub.ai", "modelscope.cn"]);
    }

    /// The handler must agree with the manager it delegates to: same count,
    /// same order, same descriptions. A future adapter registered in
    /// `MarketManager::new` therefore shows up in the UI with no extra wiring.
    #[tokio::test]
    async fn markets_matches_the_manager_infos() {
        let v = skills_markets().await.0;
        let infos = market::global_manager().infos();
        let data = v["data"].as_array().expect("data must be an array");
        assert_eq!(data.len(), infos.len());
        for (item, info) in data.iter().zip(infos.iter()) {
            assert_eq!(item["name"].as_str(), Some(info.name.as_str()));
            assert_eq!(item["description"].as_str(), Some(info.description.as_str()));
        }
    }

    /// Wiring guard: the router must point this path at the marketplace module.
    ///
    /// Comments are stripped before matching — an assertion that also hits the
    /// explanatory comment would stay green after the route was repointed at a
    /// stub (this repo has been bitten by exactly that shape of false green).
    #[test]
    fn router_wires_markets_to_the_marketplace_module() {
        let src = include_str!("mod.rs");
        let code: String = src
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        let line = code
            .lines()
            .find(|l| l.contains("\"/web/settings/skills/markets\""))
            .expect("the markets route must exist");
        assert!(
            line.contains("skills_market_api::skills_markets"),
            "markets must be served by the marketplace module, got: {}",
            line.trim()
        );
        assert!(
            !line.contains("settings_api::skills_markets"),
            "markets must not be served by a settings_api stub, got: {}",
            line.trim()
        );
        // The stub itself must stay deleted, or it can be wired back by accident.
        let settings_src = include_str!("settings_api.rs");
        assert!(
            !settings_src.contains("pub async fn skills_markets"),
            "the hardcoded single-market stub must not come back"
        );
    }
}
