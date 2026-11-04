//! `FlexBody<T>` — a request-body extractor that accepts **all three** wire
//! shapes the frontend actually sends.
//!
//! ## Why this exists
//!
//! The Java kernel binds POST parameters with Solon's `@Param`, which reads a
//! value from the query string, a urlencoded form body, **or** a JSON body
//! without the handler having to declare which one arrived. Ports of those
//! handlers to axum therefore have to pick a single extractor, and picking
//! `Form<T>` is the natural reading of "`@Param`" — but the frontend's
//! `postJson` helper sends `Content-Type: application/json`, and axum's `Form`
//! answers **HTTP 415** ("Form requests must have `Content-Type:
//! application/x-www-form-urlencoded`").
//!
//! That mismatch is invisible in code review and silent at runtime: the jQuery
//! `.fail()` handler only shows a generic "network error" toast, so "set as
//! default model" looked like a connectivity problem rather than a contract
//! bug. Confirmed affected endpoints (2026-10-27):
//! `/web/settings/llm/models/default`, `/web/settings/llm/models/toggle`,
//! `/web/chat/git/{stage,unstage,commit}`.
//!
//! `FlexBody<T>` removes the guesswork: it sniffs the body and accepts
//! `application/json`, `application/x-www-form-urlencoded`, and
//! `multipart/form-data`. Use it for any POST handler whose Java original was
//! `@Param`/`@Body String` rather than a strictly-typed JSON DTO.
//!
//! ## How each transport is decoded
//!
//! - `application/json` (or a body that merely looks like JSON) → `serde_json`.
//! - `application/x-www-form-urlencoded` → `serde_urlencoded`, the very decoder
//!   axum's own `Form` uses. It parses `"true"` into a `bool` field and `"12"`
//!   into an integer field, while a `String` field keeps the literal text — so a
//!   commit message of `true` stays `"true"` instead of becoming a bool.
//! - `multipart/form-data` → text parts are collected and fed through
//!   `serde_urlencoded` as well, so all three transports share one decoding rule.
//!
//! Letting the **target type** drive the parse is the whole point. An earlier
//! version hand-rolled this via a JSON intermediate plus a `coerce` step that
//! turned every `"true"`/`"12"` into a scalar; that broke `String` fields and
//! needed per-field `deserialize_with` helpers to patch over. Delegating to
//! `serde_urlencoded` removes both problems and matches `Form`/`@Param` exactly.

use axum::extract::{Multipart, Request};
use axum::response::{IntoResponse, Response};
use serde::de::DeserializeOwned;

/// Extractor wrapping a body deserialized from JSON, urlencoded form, or
/// multipart form data.
///
/// ```ignore
/// async fn set_default(FlexBody(body): FlexBody<ModelNameForm>) -> Json<Value> { ... }
/// ```
pub struct FlexBody<T>(pub T);

/// Rejection: always HTTP 400 with a plain-text reason.
///
/// Deliberately **not** 415 — the whole point of this extractor is that the
/// media type is not the caller's problem. A 400 here means "the body was read
/// but did not match the expected shape", which is actionable.
#[derive(Debug)]
pub struct FlexBodyRejection(pub String);

impl IntoResponse for FlexBodyRejection {
    fn into_response(self) -> Response {
        (
            axum::http::StatusCode::BAD_REQUEST,
            format!("Invalid request body: {}", self.0),
        )
            .into_response()
    }
}

#[axum::async_trait]
impl<T, S> axum::extract::FromRequest<S> for FlexBody<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = FlexBodyRejection;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let content_type = req
            .headers()
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_lowercase();

        // ── multipart: collect text fields (file parts are skipped; handlers
        //    that need uploads keep using `Multipart` directly) ──────────────
        if content_type.contains("multipart/form-data") {
            let mut pairs: Vec<(String, String)> = Vec::new();
            let mut mp = Multipart::from_request(req, state)
                .await
                .map_err(|e| FlexBodyRejection(format!("multipart parse failed: {}", e)))?;
            while let Ok(Some(field)) = mp.next_field().await {
                if field.file_name().is_some() {
                    continue;
                }
                let name = field.name().unwrap_or_default().to_string();
                if name.is_empty() {
                    continue;
                }
                let value = field.text().await.unwrap_or_default();
                pairs.push((name, value));
            }
            return decode_pairs(&pairs).map(FlexBody);
        }

        // ── everything else: read the raw bytes, then sniff ─────────────────
        let bytes = axum::body::Bytes::from_request(req, state)
            .await
            .map_err(|e| FlexBodyRejection(format!("cannot read body: {}", e)))?;
        let text = String::from_utf8_lossy(&bytes);
        let head = text.trim();

        // An empty body is legitimate for all-default DTOs (the Java handler
        // would simply see null params).
        if head.is_empty() {
            return decode_urlencoded("").map(FlexBody);
        }

        // JSON wins whenever it is declared *or* whenever the payload looks
        // like JSON. The second half matters: a hand-written `fetch` may forget
        // the Content-Type header entirely.
        if content_type.contains("application/json") || head.starts_with('{') || head.starts_with('[')
        {
            return decode_json(&bytes).map(FlexBody);
        }

        if content_type.contains("application/x-www-form-urlencoded") {
            return decode_urlencoded(&text).map(FlexBody);
        }

        // Unknown/absent Content-Type: try urlencoded, then JSON, then give up.
        if let Ok(t) = decode_urlencoded::<T>(&text) {
            return Ok(FlexBody(t));
        }
        decode_json(&bytes).map(FlexBody)
    }
}

/// Decode a urlencoded body. Empty input yields an all-default `T` (every DTO
/// here carries `#[serde(default)]`).
fn decode_urlencoded<T: DeserializeOwned>(text: &str) -> Result<T, FlexBodyRejection> {
    serde_urlencoded::from_str(text)
        .map_err(|e| FlexBodyRejection(format!("invalid form body: {}", e)))
}

/// Decode collected multipart text parts through the same urlencoded decoder,
/// so repeated keys (`files=a&files=b`) and scalar coercion behave identically.
fn decode_pairs<T: DeserializeOwned>(pairs: &[(String, String)]) -> Result<T, FlexBodyRejection> {
    let encoded = serde_urlencoded::to_string(pairs)
        .map_err(|e| FlexBodyRejection(format!("cannot encode form fields: {}", e)))?;
    decode_urlencoded(&encoded)
}

/// Decode a JSON body.
fn decode_json<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, FlexBodyRejection> {
    serde_json::from_slice(bytes)
        .map_err(|e| FlexBodyRejection(format!("invalid JSON body: {}", e)))
}

/// `Vec<String>` field tolerant of every way a list can arrive.
///
/// **This helper is not optional.** `serde_urlencoded` — the decoder axum's own
/// `Form` uses — cannot build a sequence from repeated keys: `files=a&files=b`
/// fails with "invalid type: string, expected a sequence". That is a limitation
/// of the urlencoded format's mapping onto serde, not something a DTO can
/// declare its way around.
///
/// So a list field accepts, in order:
/// 1. a real JSON array (`["a","b"]`) — what `postJson` sends;
/// 2. a JSON-encoded array *string* (`"[\"a\",\"b\"]"`) — what the git summary
///    endpoint receives, because the frontend does
///    `paths=JSON.stringify(files)` into a urlencoded body;
/// 3. a comma-separated string (`"a,b"`) — the conventional urlencoded spelling;
/// 4. a single scalar (`"a"`) — one selected file.
///
/// Repeated keys remain unsupported over urlencoded; callers that need them post
/// JSON instead (which is what the frontend already does for `commit`).
pub fn flex_vec_string<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Wire {
        List(Vec<serde_json::Value>),
        One(serde_json::Value),
    }

    fn scalar_to_string(v: serde_json::Value) -> String {
        match v {
            serde_json::Value::String(s) => s,
            serde_json::Value::Bool(b) => b.to_string(),
            serde_json::Value::Number(n) => n.to_string(),
            serde_json::Value::Null => String::new(),
            other => other.to_string(),
        }
    }

    fn split_comma(s: &str) -> Vec<String> {
        s.split(',')
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect()
    }

    let Some(wire) = Option::<Wire>::deserialize(deserializer)? else {
        return Ok(Vec::new());
    };

    match wire {
        Wire::List(items) => Ok(items
            .into_iter()
            .map(scalar_to_string)
            .filter(|s| !s.trim().is_empty())
            .collect()),
        Wire::One(v) => {
            if v.is_null() {
                return Ok(Vec::new());
            }
            let s = scalar_to_string(v);
            let trimmed = s.trim();
            if trimmed.is_empty() {
                return Ok(Vec::new());
            }
            // A JSON-encoded array arrives as a string over a form transport.
            if trimmed.starts_with('[') {
                if let Ok(parsed) = serde_json::from_str::<Vec<serde_json::Value>>(trimmed) {
                    return Ok(parsed
                        .into_iter()
                        .map(scalar_to_string)
                        .filter(|x| !x.trim().is_empty())
                        .collect());
                }
            }
            if trimmed.contains(',') {
                return Ok(split_comma(trimmed));
            }
            Ok(vec![s])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize, Debug, PartialEq, Default)]
    #[serde(default)]
    struct Toggle {
        name: String,
        enabled: Option<bool>,
    }

    #[derive(serde::Deserialize, Debug, PartialEq, Default)]
    #[serde(default)]
    struct Commit {
        message: String,
        root: String,
        #[serde(default, deserialize_with = "flex_vec_string")]
        files: Vec<String>,
    }

    #[test]
    fn urlencoded_parses_a_bool_field() {
        let t: Toggle = decode_urlencoded("name=x&enabled=true").unwrap();
        assert_eq!(t.name, "x");
        assert_eq!(t.enabled, Some(true));
    }

    /// A falsy value is a value: losing it would flip the toggle back on.
    #[test]
    fn urlencoded_explicit_false_is_not_swallowed() {
        let t: Toggle = decode_urlencoded("name=x&enabled=false").unwrap();
        assert_eq!(t.enabled, Some(false));
    }

    #[test]
    fn urlencoded_absent_bool_stays_none() {
        let t: Toggle = decode_urlencoded("name=x").unwrap();
        assert_eq!(t.enabled, None, "absent must stay None so the handler can flip");
    }

    /// The regression that killed the coerce-based design: a `String` field
    /// whose value merely *looks* like a scalar must stay a string.
    #[test]
    fn scalar_looking_string_field_stays_a_string() {
        let c: Commit = decode_urlencoded("message=true").unwrap();
        assert_eq!(c.message, "true");
        let c2: Commit = decode_urlencoded("message=1234").unwrap();
        assert_eq!(c2.message, "1234");
    }

    /// `serde_urlencoded` cannot build a sequence from repeated keys — that is
    /// a limitation of the format's serde mapping, and the reason
    /// `flex_vec_string` exists. Assert the *supported* spellings instead.
    #[test]
    fn comma_separated_list_becomes_a_vec() {
        let c: Commit = decode_urlencoded("message=m&files=a.rs,b.rs").unwrap();
        assert_eq!(c.files, vec!["a.rs".to_string(), "b.rs".to_string()]);
    }

    #[test]
    fn single_value_becomes_a_one_element_vec() {
        let c: Commit = decode_urlencoded("message=m&files=only.rs").unwrap();
        assert_eq!(c.files, vec!["only.rs".to_string()]);
    }

    /// The git summary endpoint's actual wire shape: a JSON array encoded as a
    /// string inside a urlencoded body.
    #[test]
    fn json_encoded_array_string_becomes_a_vec() {
        let c: Commit = decode_urlencoded("message=m&files=%5B%22a.rs%22%2C%22b.rs%22%5D").unwrap();
        assert_eq!(c.files, vec!["a.rs".to_string(), "b.rs".to_string()]);
    }

    #[test]
    fn json_array_still_works_natively() {
        let c: Commit = decode_json(br#"{"message":"m","files":["a.rs","b.rs"]}"#).unwrap();
        assert_eq!(c.files, vec!["a.rs".to_string(), "b.rs".to_string()]);
    }

    #[test]
    fn absent_or_empty_list_is_empty_not_an_error() {
        assert!(decode_urlencoded::<Commit>("message=m").unwrap().files.is_empty());
        assert!(decode_urlencoded::<Commit>("message=m&files=").unwrap().files.is_empty());
        assert!(decode_json::<Commit>(br#"{"files":null}"#).unwrap().files.is_empty());
        assert!(decode_json::<Commit>(br#"{"files":[]}"#).unwrap().files.is_empty());
    }

    #[test]
    fn json_transport_parses_with_real_types() {
        let t: Toggle = decode_json(br#"{"name":"x","enabled":true}"#).unwrap();
        assert_eq!(t, Toggle { name: "x".into(), enabled: Some(true) });
    }

    #[test]
    fn json_string_field_keeps_scalar_looking_text() {
        let c: Commit = decode_json(br#"{"message":"true"}"#).unwrap();
        assert_eq!(c.message, "true");
    }

    #[test]
    fn multipart_pairs_decode_like_urlencoded() {
        let pairs = vec![
            ("name".to_string(), "x".to_string()),
            ("enabled".to_string(), "true".to_string()),
        ];
        let t: Toggle = decode_pairs(&pairs).unwrap();
        assert_eq!(t, Toggle { name: "x".into(), enabled: Some(true) });
    }

    #[test]
    fn empty_body_yields_defaults() {
        let t: Toggle = decode_urlencoded("").unwrap();
        assert_eq!(t, Toggle::default());
    }

    /// Commit messages are Chinese in practice; percent-encoding must round-trip.
    #[test]
    fn utf8_percent_encoded_round_trips() {
        let c: Commit = decode_urlencoded("message=%E4%BF%AE%E5%A4%8D%E7%BC%BA%E9%99%B7").unwrap();
        assert_eq!(c.message, "修复缺陷");
    }

    /// The contract that matters most: one DTO, three transports, same values.
    /// Lists use the comma spelling over form transports (repeated keys are not
    /// representable — see `flex_vec_string`).
    #[test]
    fn all_three_transports_agree() {
        let from_form: Commit = decode_urlencoded("message=fix&root=D%3A%5Cw&files=a,b").unwrap();
        let from_json: Commit = decode_json(br#"{"message":"fix","root":"D:\\w","files":["a","b"]}"#).unwrap();
        let from_mp: Commit = decode_pairs(&[
            ("message".into(), "fix".into()),
            ("root".into(), "D:\\w".into()),
            ("files".into(), "a,b".into()),
        ])
        .unwrap();
        assert_eq!(from_form, from_json);
        assert_eq!(from_form, from_mp);
        assert_eq!(from_form.files, vec!["a".to_string(), "b".to_string()]);
    }
}
