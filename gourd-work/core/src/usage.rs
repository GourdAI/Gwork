//! usage — Usage statistics aggregation (tokens, runs, heatmap, trends).
//!
//! Mirrors the Java kernel's `/web/chat/usage/stats` wire shape exactly:
//! the settings "usage" page reads `rangeDays / rangeStart / rangeEnd /
//! allTime / granularity / totalTokens / sessionCount / messageCount /
//! activeDays / currentStreak / topModel / topModelPercent / models /
//! cacheRanking / daily / heatmap / heatmapWeeks`. Any missing key renders
//! as an empty card (the all-grey heatmap the user reported).
//!
//! Data source: the durable monthly ledger maintained by
//! [`crate::usage_ledger`] — the same files the Java kernel writes
//! (`<harness_base>/.gwork/usage/usage-YYYY-MM.json`), so both kernels report
//! identical numbers and a ledger built by either is readable by the other.
//!
//! An earlier revision of this module re-scanned every session's
//! `.stream.ndjson` on each request with only an in-memory cache. That cache
//! died with the process, so every cold start paid a full 179 MB rescan
//! (342 ms measured) next to the Java kernel's 38 ms, and it could only ever
//! see sessions that still exist — under-reporting history from deleted ones.
//! The ledger fixes both: it is durable, incrementally maintained via
//! per-session watermarks, and preserves archived days after a session is
//! deleted.

use std::collections::{HashMap, HashSet};

use chrono::Datelike;

use crate::usage_ledger;

/// Default context window (Java `ContextLengthPolicy.DEFAULT_CONTEXT_LENGTH`).
pub const DEFAULT_CONTEXT_LENGTH: i64 = 256_000;

/// Allowed context window options (Java `CONTEXT_LENGTH_OPTIONS`).
pub const CONTEXT_LENGTH_OPTIONS: [i64; 4] = [128_000, 256_000, 512_000, 1_000_000];

/// Heatmap window: 53 weeks aligned to Sundays (Java `HEATMAP_WEEKS`).
const HEATMAP_WEEKS: i64 = 53;

/// `days` value meaning "all time" (Java `RANGE_ALL`).
const RANGE_ALL: u32 = 0;

const GRANULARITY_DAY_MAX: i64 = 62;
const GRANULARITY_WEEK_MAX: i64 = 400;

/// Aggregated usage statistics in the Java kernel's wire shape.
pub struct UsageReport(pub serde_json::Value);

/// Build the usage report for a range selector value.
///
/// `days`: 0 = all time, 7 = last week (legacy), anything else collapses to 30 —
/// the same rule Java's `UsageStatsService.compute` applies.
///
/// Every aggregation rule below mirrors the Java kernel field-for-field, because
/// both kernels read the same ledger files and the same frontend renders the
/// result. The three that are easiest to get subtly wrong:
///
/// 1. **Models are grouped by stable uid, not by name.** A provider rename or a
///    case change would otherwise split one model into two rows. The display
///    name is the *last* name seen for that uid inside the window.
/// 2. **`cacheRanking` covers only `rangeStart..today`**, not the wider
///    heatmap window. Accumulating over every loaded day inflates the list
///    (measured 49 rows vs Java's 18 for the same data).
/// 3. **Future days in the heatmap are forced to zero**, even if the ledger
///    somehow holds a date ahead of today (a clock skew would otherwise paint a
///    cell the user cannot have produced).
pub fn compute_report(days: u32) -> UsageReport {
    use chrono::NaiveDate;
    use indexmap::IndexMap;
    use usage_ledger::LedgerDay;

    let all_time = days == RANGE_ALL;
    let fixed_range: i64 = if all_time { 0 } else if days == 7 { 7 } else { 30 };

    let today = chrono::Local::now().date_naive();

    // Heatmap window: Sunday-aligned fixed 53 weeks, decoupled from the range
    // selector. Java computes the offset as
    // `dow == SUNDAY ? 0 : dow.getValue()` (Mon=1..Sun=7), which is exactly
    // `num_days_from_sunday()`.
    let offset_to_sunday = today.weekday().num_days_from_sunday() as i64;
    let current_sunday = today - chrono::Duration::days(offset_to_sunday);
    let heatmap_start = current_sunday - chrono::Duration::days((HEATMAP_WEEKS - 1) * 7);
    let heatmap_end = current_sunday + chrono::Duration::days(6);

    // Archive new stream activity, then read the ledger window back.
    let paths = usage_ledger::LedgerPaths::discover();
    usage_ledger::archive_incremental_at(&paths);

    let card_start = if all_time {
        today
    } else {
        today - chrono::Duration::days(fixed_range - 1)
    };

    let buckets: std::collections::BTreeMap<NaiveDate, LedgerDay> = if all_time {
        // All time: list the shards that exist rather than walking months from
        // year zero looking for the earliest day.
        usage_ledger::load_all(&paths)
    } else {
        // Lower bound is the earlier of the two windows (the heatmap usually is).
        let load_start = if heatmap_start < card_start { heatmap_start } else { card_start };
        usage_ledger::load(&paths, load_start, today)
    };

    let (range_start, range_days) = if all_time {
        let earliest = buckets.keys().next().copied().unwrap_or(today);
        // A clock skew could put a "tomorrow" in the ledger; clamp so the day
        // count cannot go negative.
        let start = if earliest > today { today } else { earliest };
        let n = (today - start).num_days() + 1;
        (start, if n < 1 { 1 } else { n })
    } else {
        (card_start, fixed_range)
    };

    let granularity = if range_days <= GRANULARITY_DAY_MAX {
        "day"
    } else if range_days <= GRANULARITY_WEEK_MAX {
        "week"
    } else {
        "month"
    };

    // ── Cards / trend over rangeStart..today ─────────────────────────────────
    // Grouping key: the model's stable uid when the ledger has one, else its
    // name. `uid_names` maps that key to the display name, and because entries
    // are overwritten as the date-ascending walk proceeds, the *last* name seen
    // inside the window wins — matching Java's LinkedHashMap.put.
    let mut uid_names: IndexMap<String, String> = IndexMap::new();
    let mut model_totals: HashMap<String, u64> = HashMap::new();
    let mut model_input: HashMap<String, u64> = HashMap::new();
    let mut model_cache_read: HashMap<String, u64> = HashMap::new();
    let mut active_sessions: HashSet<String> = HashSet::new();
    let mut total_tokens: u64 = 0;
    let mut message_count: u64 = 0;
    let mut active_days: i64 = 0;

    // Trend buckets (zero-filled, oldest → newest). Days with no data still
    // occupy their bucket, so an idle week keeps its slot on the axis instead of
    // shifting everything left.
    let mut series: Vec<(NaiveDate, u64, u64, HashMap<String, u64>)> = Vec::new();

    for i in 0..range_days {
        let d = range_start + chrono::Duration::days(i);
        let bs = bucket_start(d, granularity, range_start);
        match series.last_mut() {
            Some(last) if last.0 == bs => {}
            _ => series.push((bs, 0, 0, HashMap::new())),
        }
        let Some(b) = buckets.get(&d) else { continue };

        let day_tokens = b.tokens();
        let last = series.last_mut().expect("just pushed");
        last.1 += day_tokens;
        last.2 += b.rounds();

        for (name, ms) in &b.models {
            let gk = match &ms.uid {
                Some(u) if !u.is_empty() => u.clone(),
                _ => name.clone(),
            };
            uid_names.insert(gk.clone(), name.clone());
            if ms.tokens > 0 {
                *last.3.entry(gk.clone()).or_insert(0) += ms.tokens;
            }
            *model_totals.entry(gk.clone()).or_insert(0) += ms.tokens;
            *model_input.entry(gk.clone()).or_insert(0) += ms.input;
            *model_cache_read.entry(gk).or_insert(0) += ms.cache_read;
        }

        total_tokens += day_tokens;
        message_count += b.messages;
        active_sessions.extend(b.sessions.iter().cloned());
        // "Active" means tokens were actually consumed, not merely that a run
        // happened: title generation emits a trace with zero usage, and counting
        // it would inflate activeDays / currentStreak.
        if day_tokens > 0 {
            active_days += 1;
        }
    }

    // Current streak: walk back from today over the **per-day** data, stopping at
    // the first day with no tokens. Using the trend buckets instead would report
    // a broken streak as still running, because a bucket's total can be non-zero
    // while its last day is empty.
    let mut streak: i64 = 0;
    {
        let mut d = today;
        while d >= range_start {
            match buckets.get(&d) {
                Some(b) if b.tokens() > 0 => streak += 1,
                _ => break,
            }
            d -= chrono::Duration::days(1);
        }
    }

    // Model distribution: token-descending, zero-usage models hidden.
    let display = |gk: &str| -> String {
        uid_names.get(gk).cloned().unwrap_or_else(|| gk.to_string())
    };

    let mut sorted: Vec<(String, u64)> = model_totals.into_iter().collect();
    sorted.sort_by(|a, b| b.1.cmp(&a.1));
    let models: Vec<serde_json::Value> = sorted
        .iter()
        .filter(|(_, t)| *t > 0)
        .map(|(gk, t)| {
            serde_json::json!({
                "model": display(gk),
                "tokens": t,
                "percent": if total_tokens > 0 {
                    round1(*t as f64 * 100.0 / total_tokens as f64)
                } else {
                    0.0
                },
            })
        })
        .collect();

    let (top_model, top_percent) = match models.first() {
        Some(v) => (
            v.get("model").and_then(|m| m.as_str()).map(String::from),
            v.get("percent").and_then(|p| p.as_f64()).unwrap_or(0.0),
        ),
        None => (None, 0.0),
    };

    // Cache-hit ranking, over the same rangeStart..today window as the cards.
    let mut cache_rows: Vec<(String, u64, u64, f64)> = Vec::new();
    for (gk, input) in &model_input {
        if *input == 0 {
            continue;
        }
        let read = model_cache_read.get(gk).copied().unwrap_or(0);
        let rate = if read > 0 {
            (read as f64 * 100.0 / *input as f64).min(100.0)
        } else {
            0.0
        };
        cache_rows.push((display(gk), read, *input, round1(rate)));
    }
    // Rate descending, ties broken by cache-read volume descending.
    cache_rows.sort_by(|a, b| {
        b.3.partial_cmp(&a.3)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.1.cmp(&a.1))
    });
    let cache_ranking: Vec<serde_json::Value> = cache_rows
        .iter()
        .map(|(m, read, input, rate)| {
            serde_json::json!({
                "model": m,
                "cacheReadTokens": read,
                "inputTokens": input,
                "cacheRate": rate,
            })
        })
        .collect();

    // Daily trend (zero-filled). Bucket keys are grouping keys, so they are
    // re-keyed to display names here and re-merged: two uids that resolve to the
    // same current name must collapse into one entry.
    let daily: Vec<serde_json::Value> = series
        .iter()
        .map(|(start, tokens, rounds, by_gk)| {
            let mut by_name: HashMap<String, u64> = HashMap::new();
            for (gk, t) in by_gk {
                *by_name.entry(display(gk)).or_insert(0) += t;
            }
            let mut bm = serde_json::Map::new();
            let mut names: Vec<&String> = by_name.keys().collect();
            names.sort();
            for n in names {
                bm.insert(n.clone(), serde_json::json!(by_name[n]));
            }
            serde_json::json!({
                "date": start.format("%Y-%m-%d").to_string(),
                "tokens": tokens,
                "rounds": rounds,
                "byModel": bm,
            })
        })
        .collect();

    // Heatmap: fixed Sunday-aligned window, zero-filled, future days forced empty.
    let mut heatmap: Vec<serde_json::Value> = Vec::new();
    {
        let mut d = heatmap_start;
        while d <= heatmap_end {
            if d > today {
                heatmap.push(serde_json::json!({
                    "date": d.format("%Y-%m-%d").to_string(),
                    "future": true,
                    "tokens": 0u64,
                    "rounds": 0u64,
                    "sessions": 0usize,
                }));
            } else {
                let b = buckets.get(&d);
                heatmap.push(serde_json::json!({
                    "date": d.format("%Y-%m-%d").to_string(),
                    "future": false,
                    "tokens": b.map(|x| x.tokens()).unwrap_or(0),
                    "rounds": b.map(|x| x.rounds()).unwrap_or(0),
                    // `sessions` is the number of distinct tasks active that day,
                    // which is not the same measure as `rounds` (inference runs);
                    // the hover card shows both.
                    "sessions": b.map(|x| x.sessions.len()).unwrap_or(0),
                }));
            }
            d += chrono::Duration::days(1);
        }
    }

    let report = serde_json::json!({
        "rangeDays": range_days,
        // The frontend renders "统计区间 … · 共 N 天" from these, so "all time"
        // is not mistaken for literally forever.
        "rangeStart": range_start.format("%Y-%m-%d").to_string(),
        "rangeEnd": today.format("%Y-%m-%d").to_string(),
        "allTime": all_time,
        "granularity": granularity,
        "totalTokens": total_tokens,
        "sessionCount": active_sessions.len(),
        "messageCount": message_count,
        "activeDays": active_days,
        "currentStreak": streak,
        "topModel": top_model,
        "topModelPercent": top_percent,
        "models": models,
        "cacheRanking": cache_ranking,
        "daily": daily,
        "heatmap": heatmap,
        "heatmapWeeks": HEATMAP_WEEKS,
    });
    UsageReport(report)
}

/// Backwards-compatible entry: legacy callers only need the coarse totals.
pub fn compute_stats(days: u32) -> UsageStats {
    let report = compute_report(days);
    let v = report.0;
    UsageStats {
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_runs: v["messageCount"].as_u64().unwrap_or(0),
        session_count: v["sessionCount"].as_u64().unwrap_or(0) as usize,
        heatmap: v["heatmap"].as_array().cloned().unwrap_or_default(),
    }
}

/// Aggregated usage statistics (legacy coarse shape).
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_runs: u64,
    pub session_count: usize,
    pub heatmap: Vec<serde_json::Value>,
}


fn bucket_start(d: chrono::NaiveDate, granularity: &str, range_start: chrono::NaiveDate) -> chrono::NaiveDate {
    let start = match granularity {
        "week" => d - chrono::Duration::days(d.weekday().num_days_from_sunday() as i64),
        "month" => chrono::NaiveDate::from_ymd_opt(d.year(), d.month(), 1).unwrap_or(d),
        _ => d,
    };
    if start < range_start { range_start } else { start }
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_start_clamps_to_the_range_start() {
        let d = chrono::NaiveDate::from_ymd_opt(2026, 10, 27).unwrap();
        let range_start = chrono::NaiveDate::from_ymd_opt(2026, 10, 1).unwrap();
        assert_eq!(bucket_start(d, "day", range_start), d);
        // Week bucket aligns to Sunday.
        let wk = bucket_start(d, "week", range_start);
        assert_eq!(wk.weekday(), chrono::Weekday::Sun);
        assert!(wk <= d);
        // Month bucket aligns to the 1st.
        assert_eq!(bucket_start(d, "month", range_start), chrono::NaiveDate::from_ymd_opt(2026, 10, 1).unwrap());
        // Never earlier than the range start.
        let late_start = chrono::NaiveDate::from_ymd_opt(2026, 10, 20).unwrap();
        assert_eq!(bucket_start(d, "month", late_start), late_start);
    }
}
