//! reasoning — per-model selectable thinking levels.
//!
//! Mirrors the Java kernel's `ThinkingDepth.selectableCodes(standard, model,
//! capabilities)`: the model picker must only offer thinking levels the model
//! can actually distinguish. Rendering five levels for a model that maps them
//! all to one vendor value would let users pick options that do nothing.
//!
//! The rule table below is a faithful port of the Java
//! `ReasoningCapabilities` pools (version ranges included). It is deliberately
//! conservative: unknown models fall back to the interface default pool, and
//! non-reasoning interfaces (ollama) report an empty list so the frontend
//! hides the selector entirely.

/// Ordered level ladder (excluding AUTO, which the frontend pins on top).
const LADDER: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// Parse a model version like `gpt-5.6-codex` → (5, 6). Returns None when the
/// family prefix carries no numeric version (e.g. `gpt-oss`, `gpt-chat`).
fn model_version(model: &str) -> Option<(u32, u32)> {
    let lower = model.to_lowercase();
    // Find the first digit run that looks like a version: digits[.digits]
    let bytes = lower.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            let major: u32 = lower[start..i].parse().unwrap_or(0);
            let mut minor: u32 = 0;
            if i + 1 < bytes.len() && bytes[i] == b'.' && bytes[i + 1].is_ascii_digit() {
                i += 1;
                let mstart = i;
                while i < bytes.len() && bytes[i].is_ascii_digit() {
                    i += 1;
                }
                minor = lower[mstart..i].parse().unwrap_or(0);
            }
            return Some((major, minor));
        }
        i += 1;
    }
    None
}

fn ver(major: u32, minor: u32) -> (u32, u32) {
    (major, minor)
}

const VER_MAX: (u32, u32) = (u32::MAX, u32::MAX);

/// Whether `model` matches a pool fragment (substring, case-insensitive).
fn contains(model: &str, frag: &str) -> bool {
    model.to_lowercase().contains(&frag.to_lowercase())
}

/// Exact pool: model contains any fragment → fixed level list.
fn pool_hit(model: &str, frags: &[&str]) -> bool {
    frags.iter().any(|f| contains(model, f))
}

/// Versioned pool: family prefix + version within [min, max] + optional
/// required/forbidden suffix fragments.
fn poolver_hit(model: &str, family: &str, min: (u32, u32), max: (u32, u32), suffix: &str) -> bool {
    let lower = model.to_lowercase();
    if !lower.contains(&family.to_lowercase()) {
        return false;
    }
    if !suffix.is_empty() && !lower.contains(&suffix.to_lowercase()) {
        return false;
    }
    match model_version(&lower) {
        Some(v) => v >= min && v <= max,
        None => false,
    }
}

/// Selectable thinking level codes for a model configuration.
///
/// Returns an empty list when the model has no distinguishable levels
/// (non-reasoning interfaces or toggle-only shapes); the frontend hides the
/// whole selector in that case.
pub fn selectable_codes(standard: &str, model: &str) -> Vec<String> {
    let std = standard.to_lowercase();
    let m = model.to_lowercase();

    // Non-reasoning interfaces: nothing to tune.
    if std.contains("ollama") {
        return Vec::new();
    }

    // ── Exact model exceptions (must precede family ranges) ──
    if contains(&m, "gpt-5-pro") {
        return codes(&["high"]);
    }
    if contains(&m, "gpt-chat-latest") {
        return codes(&["low", "medium", "high"]);
    }
    if contains(&m, "gpt-realtime") {
        return codes(&["minimal", "low", "medium", "high", "xhigh"]);
    }
    if contains(&m, "gpt-5.1-codex-max") {
        return codes(&["low", "medium", "high", "xhigh"]);
    }
    if pool_hit(&m, &["gpt-5-codex", "codex-mini", "gpt-oss"]) {
        return codes(&["low", "medium", "high"]);
    }

    // ── OpenAI family version ranges ──
    if poolver_hit(&m, "gpt", ver(5, 2), VER_MAX, "-pro") {
        return codes(&["medium", "high", "xhigh"]);
    }
    if poolver_hit(&m, "gpt", ver(5, 0), VER_MAX, "-chat") {
        return codes(&["medium"]);
    }
    if poolver_hit(&m, "gpt", ver(5, 0), ver(5, 0), "") {
        return codes(&["minimal", "low", "medium", "high"]);
    }
    if poolver_hit(&m, "gpt", ver(5, 1), ver(5, 1), "") {
        return codes(&["low", "medium", "high"]);
    }
    if poolver_hit(&m, "gpt", ver(5, 2), ver(5, 5), "") {
        return codes(&["low", "medium", "high", "xhigh"]);
    }
    if poolver_hit(&m, "gpt", ver(5, 6), VER_MAX, "") {
        return codes(&["low", "medium", "high", "xhigh", "max"]);
    }
    if m.starts_with("o1") || m.starts_with("o3") || m.starts_with("o4") {
        return codes(&["low", "medium", "high"]);
    }

    // ── Anthropic ──
    if contains(&m, "claude-opus-4-5") {
        return codes(&["low", "medium", "high"]);
    }
    if pool_hit(&m, &["claude-sonnet-4-6", "claude-opus-4-6"]) {
        return codes(&["low", "medium", "high", "max"]);
    }
    if std.contains("anthropic") || contains(&m, "claude") {
        // Family fallback: full five-level ladder.
        return codes(&LADDER);
    }

    // ── Gemini ─
    if pool_hit(&m, &["gemini-3.1-flash-image", "gemini-3.1-flash-lite-image"]) {
        return codes(&["minimal", "high"]);
    }
    if contains(&m, "gemini-3-pro-image") {
        return codes(&["low", "high"]);
    }
    if pool_hit(&m, &["gemini-3.7-flash", "gemini-3.8-flash"]) {
        return codes(&["low", "medium", "high"]);
    }
    if poolver_hit(&m, "gemini", ver(3, 0), VER_MAX, "-pro") {
        return codes(&["low", "medium", "high"]);
    }
    if poolver_hit(&m, "gemini", ver(3, 0), VER_MAX, "") {
        return codes(&["minimal", "low", "medium", "high"]);
    }
    // Gemini 2.5 uses numeric thinking budgets: levels collapse to a
    // continuous scale; the Java kernel keeps distinguishable budget steps.
    if contains(&m, "gemini-2.5") || contains(&m, "gemini-2.0-flash-thinking") {
        return codes(&["low", "medium", "high"]);
    }

    // ── OpenAI-compatible unknown models: three-level default ──
    if std.contains("openai") || std.is_empty() {
        return codes(&["low", "medium", "high"]);
    }

    Vec::new()
}

fn codes(levels: &[&str]) -> Vec<String> {
    levels.iter().map(|s| s.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gpt_4o_has_no_levels_beyond_default_pool() {
        // gpt-4o: no version ≥5.0 → falls to openai default three levels.
        assert_eq!(selectable_codes("openai", "gpt-4o-mini"), codes(&["low", "medium", "high"]));
    }

    #[test]
    fn gpt_5_6_gets_full_ladder() {
        assert_eq!(
            selectable_codes("openai", "gpt-5.6"),
            codes(&["low", "medium", "high", "xhigh", "max"])
        );
    }

    #[test]
    fn claude_family_gets_five_levels() {
        assert_eq!(
            selectable_codes("anthropic", "claude-sonnet-4-5-20250929"),
            codes(&LADDER)
        );
    }

    #[test]
    fn ollama_has_no_levels() {
        assert!(selectable_codes("ollama", "qwen3").is_empty());
    }

    #[test]
    fn gpt_5_pro_single_level() {
        assert_eq!(selectable_codes("openai", "gpt-5-pro"), codes(&["high"]));
    }
}
