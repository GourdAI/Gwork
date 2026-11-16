//! Task-checklist (TODO.md) primitives — the single place where a checklist is
//! understood, and the Rust counterpart of Java `TodoTalent`.
//!
//! ## Why this module exists
//!
//! `todowrite` used to `fs::write` the model's `todos` argument verbatim. When
//! the model emits the tool-call envelope instead of raw Markdown — a JSON array
//! of `{"content": ..., "status": ...}` objects, or a list whose newlines
//! collapsed into the two-character sequence `\n` — the file became one long
//! line. Every line-anchored consumer downstream (the progress footer,
//! `/web/chat/todos`, the task panel, resume calibration) then parsed **zero**
//! tasks. Users saw the task chip blink out; the model saw `[进度] total: 0`.
//!
//! That is not hypothetical: of 405 `TODO.md` files on disk across real
//! sessions, 26 are JSON envelopes rather than Markdown.
//!
//! Worse, the old footer derived its push from `pending == 0 && in_progress == 0
//! && total > 0`. With `total == 0` that guard is false, so the tool answered a
//! checklist it could not read with `[继续] 还有未完成事项，请继续推进` — an
//! unsatisfiable instruction. The run kept working until `max_turns` and then
//! terminated as "task may be incomplete". [`FORMAT_WARN`] plus the `total == 0`
//! short-circuit below replace that with the truth: nothing parsed, fix your
//! input.
//!
//! ## The two counting rules, kept separate on purpose
//!
//! [`is_checkbox_line`] (strict five-byte prefix form) drives the tool-side
//! footer, matching Java `TodoTalent.isCheckboxLine`. `/web/chat/todos` parses
//! with an anchored regex that requires whitespace and text after `]`, matching
//! Java `WebController.todos`. Java keeps the two apart and so does this kernel —
//! the frontend contract depends on the regex form. The divergence is pinned by
//! `strict_rule_accepts_a_missing_space_before_the_text` so a future change to
//! either side fails a test instead of silently desynchronising the panel from
//! the tool.

/// Parse a checkbox line into `(status, task text)`, or `None` when it is not
/// one. Status is `'x'` (done, either case), `'/'` (in progress) or `' '`
/// (pending).
///
/// The prefix is inspected **by byte** against ASCII literals, so a line whose
/// status slot holds a multi-byte character simply fails to match instead of
/// being reinterpreted.
fn checkbox_of(trimmed: &str) -> Option<(char, &str)> {
    let b = trimmed.as_bytes();
    if b.len() < 5 || &b[0..3] != b"- [" || b[4] != b']' {
        return None;
    }
    let status = match b[3] {
        b'x' | b'X' => 'x',
        b'/' => '/',
        b' ' => ' ',
        _ => return None,
    };
    // Safe: the first five bytes are ASCII, so index 5 is a char boundary.
    Some((status, trimmed[5..].trim()))
}

/// Whether a line is a task row: `- [ ]`, `[/]`, `[x]` or `[X]`.
pub fn is_checkbox_line(trimmed: &str) -> bool {
    checkbox_of(trimmed).is_some()
}

/// Number of recognisable task lines. Splitting follows Java: split on `\n` and
/// trim each line, so a CRLF document still counts correctly.
pub fn count_checkbox_lines(content: &str) -> usize {
    if content.is_empty() {
        return 0;
    }
    content
        .split('\n')
        .filter(|line| is_checkbox_line(line.trim()))
        .count()
}

/// Normalise the `todos` argument before it reaches the disk.
///
/// Models occasionally send the tool-call envelope instead of Markdown, and
/// occasionally collapse real newlines into the literal two characters `\n`.
/// Either way the file ends up on one line and every line-anchored reader sees
/// nothing.
///
/// The repair is **best-of-candidate, tie goes to the original**: the raw text,
/// the unwrapped `todos` field, and the newline-restored variant are each scored
/// by [`count_checkbox_lines`] and the winner is kept. That conservatism is what
/// makes this safe to call unconditionally — an already-correct checklist,
/// including one whose task text legitimately contains a literal `\n`, comes back
/// unchanged, and no input can end up with fewer recognisable tasks than it
/// started with.
///
/// Short-circuiting on "the raw text already parses" would be wrong: a collapsed
/// list often hits one item on its first line, and a JSON envelope carrying real
/// newlines hits one on its last. Both have a better candidate waiting, hence
/// scoring rather than probing.
pub fn sanitize_todo_markdown(raw: &str) -> String {
    let mut text = raw.trim().to_string();
    if text.is_empty() {
        return text;
    }
    // Bounded fixed-point iteration. A *double* envelope (a model that
    // stringified its argument twice) needs two unwraps, and the first unwrap's
    // gain is not a better task count — both shells' tail lines score 1 — but
    // exposing the inner shell so the next pass can reach the tasks. Judging
    // each unwrap on immediate count improvement therefore stops one layer
    // short and silently garbles the list. Iterating to a fixed point fixes
    // that and, as a by-product, makes `sanitize` idempotent: a model that
    // retries by echoing its previous argument can never get a different file.
    // Four passes cover triple envelopes; anything deeper stops here without
    // looping (the guard is a constant, not input-derived).
    for _ in 0..4 {
        let next = sanitize_once(&text);
        if next == text {
            break;
        }
        text = next;
    }
    text
}

/// One normalisation pass: envelope unwrap, JSON-item salvage, newline
/// restoration, best-of-candidate with ties going to the input.
fn sanitize_once(input: &str) -> String {
    let mut text = input.to_string();
    let mut best = count_checkbox_lines(&text);

    // ① The argument carries a JSON envelope: take the `todos` string value
    // (escapes inside it are restored along the way).
    if let Some(unwrapped) = extract_todos_field(&text) {
        let value = unwrapped.trim().to_string();
        let count = count_checkbox_lines(&value);
        // A JSON container (`[` / `{` after trim) is *wholly* an envelope, so
        // decoding its `todos` string can never discard non-envelope content:
        // adopt on a count tie too. Without this a double envelope stalls here
        // (both shells score 0 tasks) and pass ③ then rewrites the still-encoded
        // escapes, corrupting the payload beyond any later decode.
        let container = text.trim_start().starts_with('[') || text.trim_start().starts_with('{');
        if count > best || (container && value != text) {
            if count > best {
                best = count;
            }
            text = value;
        }
    }

    // ② A JSON array of item objects. `extract_todos_field` cannot reach this
    // shape: the checklist lives in the array itself rather than in one string.
    // Without it the model's own structured output still parses to 0 tasks —
    // which is what was actually sitting on disk.
    //
    // Ordered BEFORE the newline restoration on purpose. A literal `\n` inside a
    // JSON string is a valid escape that the parser turns into a real newline;
    // rewriting the raw bytes first would put an actual newline inside a JSON
    // string literal, which is invalid, and the array would then never parse.
    // Restoring newlines is only the fallback for text that is *not* valid JSON.
    if let Some(converted) = convert_json_items(&text) {
        let count = count_checkbox_lines(&converted);
        if count > best {
            best = count;
            text = converted;
        } else if best == 0 && !converted.is_empty() && converted != text {
            // Zero-task salvage (a progress note whose items degenerated into
            // placeholders): nothing in the raw text parses either, so keeping
            // the readable salvage cannot make the checklist worse — and it is
            // what lets `heal_content` replace a JSON envelope with prose the
            // model can actually rebuild from.
            text = converted;
        }
    }

    // ③ Literal newline sequences become real ones — covers both "envelope and
    // collapsed" and "no envelope but collapsed".
    //
    // Gated off while the text is still a JSON container: a literal `\n` inside
    // an encoded string is a *double* escape, and rewriting it here corrupts the
    // payload beyond any later decode (the corruption that kept a double
    // envelope garbled). The decode paths ①/② restore escapes correctly; ③ is
    // only the fallback for collapsed text that is not JSON at all.
    let still_container = text.trim_start().starts_with('[') || text.trim_start().starts_with('{');
    if !still_container {
        let unescaped = unescape_literal_newlines(&text);
        if count_checkbox_lines(&unescaped) > best {
            text = unescaped;
        }
    }

    text
}

/// Read-side self-healing for a checklist already on disk.
///
/// `sanitize_todo_markdown` guards the write path; files written **before**
/// that guard existed (or by a kernel that lacked it) still sit on disk as JSON
/// envelopes, and every line-anchored reader sees zero tasks in them — the
/// "task list format abnormal" panel state users keep hitting on old sessions.
///
/// Returns the repaired Markdown when — and only when — the stored content
/// parses to **no** task line yet normalises to something different from what
/// is stored. A file that already carries tasks is never touched (the write
/// path owns it), and prose that normalises to itself is left alone so a
/// reader can never rewrite a human's notes.
pub fn heal_content(raw: &str) -> Option<String> {
    if count_checkbox_lines(raw) > 0 {
        return None;
    }
    let healed = sanitize_todo_markdown(raw);
    let trimmed = raw.trim();
    if healed.is_empty() || healed == trimmed {
        return None;
    }
    Some(healed)
}

/// Salvage a checklist the model wrote as a **JSON array of item objects** — the
/// shape found in 26 of the 405 real `TODO.md` files on this machine.
///
/// Field naming varies by model, so recognition uses a table built from those
/// files: text `content` / `task` / `title` / `description` / `detail` / `text`,
/// state `status` / `state`, boolean `checked` / `done`, grouping `header` /
/// `group` / `section`, progress notes `todos_note` / `note` / `notes` /
/// `summary`. An unrecognised state becomes pending — the conservative
/// direction, since guessing "done" would let a run stop early.
///
/// An item's text is emitted line by line, and a line already carrying a marker
/// is copied verbatim, so an item whose `content` is itself a Markdown list does
/// not end up with two markers. Progress notes are prose rather than tasks and
/// are copied verbatim; placeholder texts (`"content": "placeholder"`) are
/// dropped instead of being promoted into invented task rows.
///
/// Returns `None` when the input is not such an array or no item carries usable
/// text, so the caller keeps the original bytes instead of a guess.
pub fn convert_json_items(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    convert_json_value(value)
}

/// The worker behind [`convert_json_items`]; takes an already-parsed value so
/// nested arrays recurse without a string round-trip.
fn convert_json_value(value: serde_json::Value) -> Option<String> {
    let items = match value {
        serde_json::Value::Array(v) => v,
        serde_json::Value::Object(o) => vec![serde_json::Value::Object(o)],
        _ => return None,
    };

    const TEXT_KEYS: [&str; 6] = [
        "content",
        "task",
        "title",
        "description",
        "detail",
        "text",
    ];
    const GROUP_KEYS: [&str; 3] = ["header", "group", "section"];
    /// Free-form progress prose a model stores next to (or instead of) its
    /// items. Seen in the wild as `todos_note` on a degenerate envelope whose
    /// only real information was this note.
    const NOTE_KEYS: [&str; 4] = ["todos_note", "note", "notes", "summary"];

    let mut out = String::new();
    let mut converted = 0usize;
    let mut last_group = String::new();

    for item in &items {
        // A model also emits the checklist as an array of *strings*, each one
        // already a Markdown line (`["## 组", "- [x] done", "- [ ] todo"]`).
        // Such a line passes through verbatim — it is real content and must not
        // be discarded just because the container holds no objects.
        //
        // Restricted to lines that already look like Markdown (`- ` list item or
        // `#` heading): a bare `["junk"]` array would otherwise be promoted into
        // a fabricated task, which is the one thing normalisation may never do.
        if let Some(s) = item.as_str() {
            let mut emitted = false;
            for line in s.split('\n') {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                if !(line.starts_with("- ") || line.starts_with("#")) {
                    continue;
                }
                out.push_str(line);
                out.push('\n');
                emitted = true;
            }
            if emitted {
                converted += 1;
            }
            continue;
        }

        // A non-object element is skipped, not fatal: one stray value in the
        // array must not discard the whole checklist.
        let Some(obj) = item.as_object() else {
            continue;
        };

        // Section heading first, so the note/task lines that follow land under
        // the group they belong to.
        if let Some(g) = GROUP_KEYS.iter().find_map(|k| string_field(obj, k)) {
            if g != last_group {
                out.push_str(&format!("## {}\n", g));
                last_group = g;
            }
        }

        let mut emitted = false;

        // Progress notes are prose, not tasks: copied verbatim so a checklist
        // whose items degenerated into placeholders still keeps the one piece
        // of real information the model wrote.
        if let Some(note) = NOTE_KEYS.iter().find_map(|k| string_field(obj, k)) {
            emitted |= push_lines(&mut out, &note);
        }

        // A nested checklist array (`{"todos": [ ... ]}`): the envelope shape
        // whose list lives one level deeper than `extract_todos_field` can
        // reach — that helper only understands string values.
        if let Some(arr) = obj.get("todos").and_then(|v| v.as_array()) {
            let nested = convert_json_value(serde_json::Value::Array(arr.clone()));
            if let Some(nested) = nested {
                emitted |= push_lines(&mut out, &nested);
            }
        }

        if let Some(text) = TEXT_KEYS.iter().find_map(|k| string_field(obj, k)) {
            // Placeholder payloads are noise a model emits when it gives up on
            // the list; promoting them into task rows would invent work that
            // does not exist.
            if !is_placeholder(&text) {
                let marker = status_of(obj).unwrap_or(' ');
                for line in text.split('\n') {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    if is_checkbox_line(line) {
                        out.push_str(line);
                    } else {
                        out.push_str(&format!("- [{}] {}", marker, line));
                    }
                    out.push('\n');
                }
                emitted = true;
            }
        }

        if emitted {
            converted += 1;
        }
    }

    if converted == 0 {
        return None;
    }
    let salvaged = out.trim_end().to_string();
    if salvaged.is_empty() {
        return None;
    }
    Some(salvaged)
}

/// Append every non-empty trimmed line of `text` to `out`, verbatim. Returns
/// whether anything was appended.
fn push_lines(out: &mut String, text: &str) -> bool {
    let mut emitted = false;
    for line in text.split('\n') {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        out.push_str(line);
        out.push('\n');
        emitted = true;
    }
    emitted
}

/// Task texts that carry no work: payloads models emit when they abandon the
/// list (`"content": "placeholder"`, `"id": "x"`). Recognised so salvage never
/// promotes them into task rows.
const PLACEHOLDER_TEXTS: &[&str] = &[
    "placeholder", "place holder", "todo", "todos", "task", "tasks", "item", "items",
    "x", "xx", "xxx", "-", "--", ".", "..", "...", "n/a", "na", "null", "none", "tbd",
];

fn is_placeholder(text: &str) -> bool {
    let t = text.trim().to_lowercase();
    PLACEHOLDER_TEXTS.contains(&t.as_str())
}

/// A non-empty string field, ignoring numbers, booleans and blanks.
fn string_field(map: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<String> {
    map.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Map an item's state onto a checkbox marker. `None` means no recognised state.
fn status_of(map: &serde_json::Map<String, serde_json::Value>) -> Option<char> {
    for key in ["checked", "done"] {
        if let Some(b) = map.get(key).and_then(|v| v.as_bool()) {
            return Some(if b { 'x' } else { ' ' });
        }
    }
    let raw = ["status", "state"].iter().find_map(|k| string_field(map, k))?;
    // Case, spaces and underscores all appear across models: `Done`, `done`,
    // `DONE`, `in_progress`, `in progress`.
    let norm: String = raw
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    match norm.as_str() {
        "x" | "done" | "completed" | "complete" | "finished" => Some('x'),
        "inprogress" | "doing" | "active" | "ongoing" | "started" => Some('/'),
        "pending" | "todo" | "open" | "notstarted" | "incomplete" => Some(' '),
        _ => None,
    }
}

/// Locate the `"todos"` key and return its string literal value, escapes
/// restored. `None` when the value is not a string literal or the quote never
/// closes — the caller then falls through to the remaining candidates.
fn extract_todos_field(text: &str) -> Option<String> {
    let key = text.find("\"todos\"")?;
    let bytes = text.as_bytes();
    let mut i = key + "\"todos\"".len();
    while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b':') {
        i += 1;
    }
    if i >= bytes.len() || bytes[i] != b'"' {
        return None;
    }
    let start = i + 1;
    let mut p = start;
    while p < bytes.len() {
        match bytes[p] {
            // A backslash escapes the next byte. JSON escapes are ASCII and a
            // UTF-8 continuation byte is >= 0x80, so stepping by byte cannot
            // land mid-character on the slice returned below.
            b'\\' => p += 2,
            b'"' => return Some(unescape_json_string(&text[start..p])),
            _ => p += 1,
        }
    }
    None
}

/// Restore JSON string escapes (`\n` `\r` `\t` `\"` `\\` `\/` `\b` `\f`
/// `\uXXXX`). An unrecognised escape is kept verbatim — never guess, never
/// destroy.
fn unescape_json_string(s: &str) -> String {
    if !s.contains('\\') {
        return s.to_string();
    }
    let c: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0usize;
    while i < c.len() {
        if c[i] != '\\' || i + 1 >= c.len() {
            out.push(c[i]);
            i += 1;
            continue;
        }
        let next = c[i + 1];
        i += 2;
        match next {
            'n' => out.push('\n'),
            'r' => out.push('\r'),
            't' => out.push('\t'),
            'b' => out.push('\u{0008}'),
            'f' => out.push('\u{000C}'),
            '"' => out.push('"'),
            '\\' => out.push('\\'),
            '/' => out.push('/'),
            'u' => {
                if i + 4 <= c.len() {
                    let hex: String = c[i..i + 4].iter().collect();
                    match u32::from_str_radix(&hex, 16)
                        .ok()
                        .and_then(char::from_u32)
                    {
                        Some(ch) => {
                            out.push(ch);
                            i += 4;
                        }
                        // A bad code point stays exactly as the model wrote it.
                        None => out.push_str("\\u"),
                    }
                } else {
                    out.push_str("\\u");
                }
            }
            other => {
                out.push('\\');
                out.push(other);
            }
        }
    }
    out
}

/// Turn literally-written newlines (backslash + `n`) into real ones and
/// normalise line endings to LF.
fn unescape_literal_newlines(s: &str) -> String {
    if !s.contains("\\n") && !s.contains("\\r") {
        return s.to_string();
    }
    s.replace("\\r\\n", "\n")
        .replace("\\n", "\n")
        .replace("\\r", "\n")
        .replace("\r\n", "\n")
}

/// Checklist tally plus the first item still open.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct TodoProgress {
    pub total: usize,
    pub done: usize,
    pub in_progress: usize,
    pub pending: usize,
    /// Text of the earliest `[ ]` or `[/]` line. Both the panel and the model
    /// need "what is next", not only "how many are left".
    pub first_unfinished: Option<String>,
}

/// Count a checklist with the strict rule ([`is_checkbox_line`]).
pub fn measure(content: &str) -> TodoProgress {
    let mut p = TodoProgress::default();
    for line in content.split('\n') {
        let Some((status, text)) = checkbox_of(line.trim()) else {
            continue;
        };
        p.total += 1;
        match status {
            'x' => p.done += 1,
            '/' => {
                p.in_progress += 1;
                if p.first_unfinished.is_none() {
                    p.first_unfinished = Some(text.to_string());
                }
            }
            _ => {
                p.pending += 1;
                if p.first_unfinished.is_none() {
                    p.first_unfinished = Some(text.to_string());
                }
            }
        }
    }
    p
}

/// Whether anything is still open (`[ ]` or `[/]`).
pub fn has_unfinished_items(content: &str) -> bool {
    let p = measure(content);
    p.pending > 0 || p.in_progress > 0
}

/// Turn-based staleness nudge, ported from Qoder CLI `todo_reminder`.
///
/// Injected by the ReAct loop when the checklist has gone many turns without a
/// `todowrite`. Unlike [`progress_footer`] — which only reaches a model that
/// already calls `todowrite`/`todoread` — this is independent of the model's own
/// todo discipline, and it carries the current rows so the model can update the
/// exact stale item rather than guess.
///
/// Must never order a final answer or a summary: that phrasing is what turned
/// transitional intent declarations into premature ENDs (the loop reminder's
/// red line). It only asks the model to record status, then keep going.
pub fn stale_reminder(raw: &str) -> String {
    let chars: Vec<char> = raw.trim().chars().collect();
    // 契约 §3.2：截断收紧到 800 字符并加 …[truncated] 标记（原 1500 只加 …）。
    // 提醒是温和 nudge，不是清单全文回放；超长清单挤占上下文得不偿失。
    let list = if chars.len() > 800 {
        format!("{}…[truncated]", chars[..800].iter().collect::<String>())
    } else {
        chars.into_iter().collect()
    };
    format!(
        "[进度提醒] 任务清单已多轮未更新。若刚才的工作使某项状态发生变化，请先用 todowrite 落盘（开始做置 [/]、拿到结果置 [x]），再继续后续动作；清单已与实际不符则清理或重构。仅在与当前工作相关时使用，这是一条温和提醒，忽略它若不合时宜。\n\n当前清单：\n{}",
        list
    )
}

/// Reply to an empty `todos` argument: nothing is written, and the model is told
/// why. `FORMAT_WARN` is appended by the caller.
pub const NOT_SAVED_EMPTY: &str = "TODO not saved: todos 参数为空（未改动已有清单）。";

/// `todoread` answer when the session has no checklist yet.
pub const EMPTY_LIST: &str =
    "[] (当前任务清单为空。若任务复杂，请使用 `todowrite` 初始化计划。)";

/// The `todos` parameter description, mirroring Java `TodoTalent.todoWrite`.
///
/// This is the fix for the **upstream** cause of the 26 malformed files: the old
/// description said only "Full Markdown checklist content", which never told the
/// model the line syntax. A model that has not been given the shape reproduces
/// the JSON object it has seen in a hundred tool schemas, and the panel then
/// shows nothing. Spelling out the three checkbox states and explicitly forbidding
/// a JSON envelope and plain list items is what stops the drift at the source.
pub const PARAM_TODOS_DESC: &str = "Task checklist. Preferred shape: a JSON array of objects - {\"content\": task text (required), \"status\": \"pending\" | \"in_progress\" | \"done\", optional \"header\"/\"group\" for a section}. Also accepted: a raw Markdown string with `##` group headings and one checkbox line per task: `- [ ]` pending, `- [/]` in progress, `- [x]` done, separated by real newlines. Plain list items without a state marker are not tracked. Never literal backslash-n, never placeholders like `placeholder`.";

// English planning guide for `build_en`; the Chinese twin below is for `build_cn`.
// Both exist because the kernel ships two system prompts and the format contract
// has to reach the model whichever one is active.
// 契约 §3.1 重写（EN 语义等价，CN 见下）：从 7 条 ~904 tokens 精简到 5 条；
// 原第 4 条「下一轮首个动作必须 todowrite」放宽为「随做随记」（可同轮并行）。
pub const PLANNING_GUIDE_EN: &str = "## Task Planning Guide
1. **Format**: prefer a JSON array for todos, each item {content, status: pending|in_progress|done}, optional header/group for grouping; Markdown is also accepted (one `- [ ]`/`- [/]`/`- [x]` + text per line, real newlines). No literal backslash-n, no placeholders, no unmarked list items.
2. **When to use**: build a checklist for complex/multi-stage/multi-deliverable tasks; not for simple Q&A or single-step operations. Keep it short, outcome-oriented and verifiable — not one entry per file or command. Rewrite it wholesale when the goal changes materially.
3. **Status discipline**: at most one in_progress; set [/] before starting, [x] as soon as the result lands, record as you go without batching; merge items finished together into one todowrite. Update the matching item immediately after delegation results return.
4. **Resume calibration**: after an interrupt/compression, or when the user says \"continue\", call todoread first and cross-check prior execution evidence before acting; mark genuinely finished items [x] directly — never blindly redo them.
5. **Finish criteria**: the [进度]/[继续]/[完成] footer returned by the tool is authoritative; keep working while unfinished items remain, and stop only on a genuine blocker or when a submitted plan awaits the user's decision. Do not restate the whole checklist in prose.
";

/// Task-planning guide injected into the system prompt (Java
/// `TodoTalent.getInstruction`).
///
/// 契约 §3.1 重写（CN 目标 ~450 tokens，原文 ~904）：五条规则覆盖格式、何时建
/// 清单、状态纪律、恢复校准与收尾判据。原第 4 条「下一轮首个动作必须 todowrite」
/// 放宽为「随做随记」，允许同轮并行更新。
pub const PLANNING_GUIDE: &str = "## 任务规划指南 (Task Planning Guide)
1. **格式**：todos 优先传 JSON 数组，每项 {content, status: pending|in_progress|done}，可选 header/group 分组；也接受 Markdown（每行 `- [ ]`/`- [/]`/`- [x]` + 文本，真实换行）。禁止字面反斜杠 n、占位符、无状态列表项。
2. **何时用**：复杂/多阶段/多产出任务建清单；简单问答与单步操作不建。清单短小、面向结果、可验证，不要一文件一命令一条目。目标重大变化时整体重写。
3. **状态纪律**：至多一项 in_progress；开始前置 [/]，结果落地即置 [x]，随做随记不攒批；多项同时完成合并为一次 todowrite。委派结果返回后立即更新对应项。
4. **恢复校准**：中断恢复/压缩后/用户说「继续」时，先 todoread 对照历史执行证据再行动，确已完成的直接置 [x]，禁止盲目重做。
5. **收尾判据**：以工具返回的 [进度]/[继续]/[完成] footer 为准；仍有未完成项就继续做，仅在真实阻塞或已提交方案等待用户拍板时停下。不要在正文复述整份清单。
";

/// `todoread` reply: the stored list plus the same footer `todowrite` returns
/// (Java `todoRead` → `content + buildProgressFooter(content)`). The model judges
/// "may I stop?" from that footer alone, so both tools must speak with one voice.
pub fn read_reply(raw: &str, resume_hint: bool) -> String {
    format!("{}{}", raw, progress_footer(&measure(raw), resume_hint))
}

/// Progress footer appended to every `todowrite` / `todoread` result.
///
/// This is the model's only signal about whether it may stop, so the branches
/// matter:
/// * `total == 0` → the tally alone. Adding `[继续]` here is what produced the
///   endless-run bug: nothing parsed, yet the text insisted work remained.
/// * unfinished items → `[继续]` plus `[待办首项]`, and a note that `[/]` rows
///   may be leftovers from an interrupted run.
/// * everything `[x]` → `[完成]`.
///
/// Wording matches Java `TodoTalent.buildProgressFooter`.
///
/// 契约 §3.3：`resume_hint` 门控 [提示] 行——常规 run 传 false（`[/]` 就是模型
/// 自己刚标的进行中项，「可能是上次中断遗留」的提醒是噪声），仅 abnormal-exit
/// 恢复校准路径的首个 run 传 true（那时清单状态确实可能滞后于实际进度）。
pub fn progress_footer(p: &TodoProgress, resume_hint: bool) -> String {
    let mut footer = format!(
        "\n[进度] total: {}, done: {}, in-progress: {}, pending: {}.",
        p.total, p.done, p.in_progress, p.pending
    );

    let unfinished = p.in_progress + p.pending;
    if p.total == 0 {
        return footer;
    }

    if unfinished > 0 {
        footer.push_str(&format!(
            "\n[继续] 还有 {} 项未完成，任务尚未结束。禁止现在收尾或输出总结，请继续推进未完成事项。",
            unfinished
        ));
        if let Some(first) = p.first_unfinished.as_deref() {
            if !first.is_empty() {
                let chars: Vec<char> = first.chars().collect();
                let next = if chars.len() > 80 {
                    format!("{}...", chars[..80].iter().collect::<String>())
                } else {
                    first.to_string()
                };
                footer.push_str(&format!("\n[待办首项] {}", next));
            }
        }
        if p.in_progress > 0 && resume_hint {
            footer.push_str(&format!(
                "\n[提示] 存在 {} 个 `[/]` 进行中项：若当前是中断后的恢复执行，它们可能是上次异常中断的遗留项，实际或许已经完成。请先核对历史 Observation 中是否已有对应执行结果，确已完成的直接用 todowrite 置 [x] 确认，不要盲目重做。",
                p.in_progress
            ));
        }
    } else {
        footer.push_str("\n[完成] 所有事项均已 [x]，可以收尾并向用户汇报结果。");
    }

    footer
}

/// Appended when nothing in the input parses as a task line. It tells the model
/// to fix its argument instead of leaving it with a bare `total: 0`.
///
/// Deliberately contains no dash + bracket-state sequence: the panel's fallback
/// counter would otherwise read the warning itself as a task row and invent a
/// phantom item.
pub const FORMAT_WARN: &str = "\n[格式警告] 未能从入参中识别出任何任务行，进度统计为 0、任务面板无法展示。\
     请传入 JSON 数组（元素为含 content 与 status 的对象），或 Markdown 原文：每条任务独占一行、以短横线开头并带方括号状态标记；\
     使用真实换行分隔，不要把换行写成字面反斜杠 n，也不要传 placeholder 之类的占位符。";

/// 「恢复校准」message for a run resuming after an abnormal stop.
///
/// TODO.md can lag reality: the model may not have had a chance to call
/// `todowrite` when it was interrupted, so rows still marked `[ ]` / `[/]` may in
/// fact be finished. Without this the agent re-executes completed steps — the
/// failure mode behind "it started the whole task over after I pressed continue".
///
/// `None` means nothing is open, so no calibration is needed.
pub fn build_resume_calibration(content: &str) -> Option<String> {
    if !has_unfinished_items(content) {
        return None;
    }
    Some(format!(
        "[TODO 恢复校准] 上一次任务异常中断，现在是恢复执行。下方清单是 TODO.md 落盘的当前真实状态，它可能滞后于实际执行进度（中断时刻可能未及时调用 todowrite），部分标记为 `[ ]` 或 `[/]` 的项实际可能已经完成：\n\n\
         <todo_snapshot>\n{}\n</todo_snapshot>\n\n\
         要求：行动前必须逐项核对每个未完成项——检查历史 Observation 中是否已包含该项对应的执行结果/证据。确已完成的，直接用 todowrite 将其置为 `[x]` 确认状态即可，不要重新执行；只对确实未完成的部分继续推进。严禁盲目重复执行已完成的步骤。",
        content.trim()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Production shape seen in the wild: JSON array envelope + literal `\n`.
    const DIRTY_ENVELOPE: &str = "[{\"todos\": \"- [x] 现场取证\\n- [ ] 代码取证\"}]";
    const CLEAN_TWO_ITEMS: &str = "- [x] 现场取证\n- [ ] 代码取证";

    // ── stale_reminder (Qoder todo_reminder port) ───────────────────────────

    #[test]
    fn stale_reminder_carries_nudge_and_current_list() {
        let r = stale_reminder(CLEAN_TWO_ITEMS);
        assert!(r.contains("[进度提醒]"), "must carry the nudge: {r}");
        assert!(r.contains("todowrite"), "must name the tool to update: {r}");
        assert!(r.contains("- [ ] 代码取证"), "must list the current rows: {r}");
        assert!(r.contains("- [x] 现场取证"), "must list the current rows: {r}");
    }

    /// Same red line as the loop reminder: a staleness nudge must never order a
    /// final answer or summary — that phrasing turns a transitional intent into
    /// a premature END.
    #[test]
    fn stale_reminder_never_orders_a_final_answer() {
        let r = stale_reminder(CLEAN_TWO_ITEMS);
        for forbidden in ["收尾", "总结", "Final Answer", "最终答案"] {
            assert!(!r.contains(forbidden), "must not order convergence ({forbidden}): {r}");
        }
    }

    #[test]
    fn stale_reminder_caps_a_long_list() {
        let long = "- [ ] 任务\n".repeat(2000);
        let r = stale_reminder(&long);
        // 契约 §3.2：截断收紧到 800 字符并加 …[truncated] 标记。
        assert!(r.contains("…[truncated]"), "an over-long list must carry the truncation marker: len={}", r.chars().count());
        assert!(r.chars().count() < 1000, "nudge + 800-char capped list must stay bounded: {}", r.chars().count());
    }

    /// 契约 §3.2：恰好 800 字符不截断（边界闭区间），801 才截。
    #[test]
    fn stale_reminder_truncation_boundary() {
        let exact = "甲".repeat(800);
        let r = stale_reminder(&exact);
        assert!(!r.contains("[truncated]"), "800 chars must not be truncated");
        let over = "甲".repeat(801);
        let r2 = stale_reminder(&over);
        assert!(r2.contains("…[truncated]"), "801 chars must be truncated");
    }

    #[test]
    fn stale_reminder_trims_surrounding_whitespace() {
        let r = stale_reminder("\n\n- [ ] A\n\n");
        assert!(r.contains("- [ ] A"), "{r}");
        assert!(!r.contains("\n\n\n"), "leading/trailing blank runs must be trimmed: {r}");
    }

    // ── dirty input gets repaired ────────────────────────────────────────────

    #[test]
    fn repairs_envelope_with_literal_newlines() {
        assert_eq!(0, count_checkbox_lines(DIRTY_ENVELOPE));
        assert_eq!(CLEAN_TWO_ITEMS, sanitize_todo_markdown(DIRTY_ENVELOPE));
    }

    #[test]
    fn repairs_envelope_with_real_newlines() {
        let dirty = "[{\"todos\": \"- [x] A\n- [ ] B\"}]";
        assert_eq!(1, count_checkbox_lines(dirty), "only the tail line matches");
        assert_eq!("- [x] A\n- [ ] B", sanitize_todo_markdown(dirty));
    }

    #[test]
    fn repairs_object_envelope() {
        let dirty = "{\"todos\": \"## 分组\\n- [/] 进行中\\n- [x] 已完成\"}";
        let result = sanitize_todo_markdown(dirty);
        assert_eq!(2, count_checkbox_lines(&result));
        assert!(result.starts_with("## 分组"), "{result}");
        assert!(!result.contains("todos"), "envelope left behind: {result}");
    }

    #[test]
    fn repairs_bare_collapsed_list() {
        let dirty = "- [x] A\\n- [ ] B";
        assert_eq!(1, count_checkbox_lines(dirty));
        assert_eq!("- [x] A\n- [ ] B", sanitize_todo_markdown(dirty));
    }

    #[test]
    fn repairs_unicode_escapes() {
        let dirty = "[{\"todos\": \"- [x] \\u4e2d\\u6587\\n- [ ] \\u4f60\\u597d\"}]";
        assert_eq!("- [x] 中文\n- [ ] 你好", sanitize_todo_markdown(dirty));
    }

    #[test]
    fn repaired_list_has_unfinished_items() {
        assert!(has_unfinished_items(&sanitize_todo_markdown(
            DIRTY_ENVELOPE
        )));
    }

    /// The shape in the 26 real files: a JSON array of item objects with no
    /// `todos` key. This is now salvaged rather than left as a one-line file the
    /// panel reads as 0 tasks — the state the kernel was actually producing.
    #[test]
    fn json_object_array_is_salvaged() {
        let dirty =
            "[{\"content\": \"读取源码\", \"status\": \"done\"}, {\"content\": \"补测试\", \"status\": \"pending\"}]";
        let out = sanitize_todo_markdown(dirty);
        assert_eq!("- [x] 读取源码\n- [ ] 补测试", out, "{out}");
        assert_eq!(2, count_checkbox_lines(&out));
    }

    /// Every spelling variant observed on disk, mapped from the real files.
    #[test]
    fn json_conversion_handles_the_field_names_found_on_disk() {
        let cases = [
            // status: completed / done / in_progress / pending / "[x]"
            (r#"[{"content":"A","status":"completed"}]"#, "- [x] A"),
            (r#"[{"content":"A","status":"in_progress"}]"#, "- [/] A"),
            (r#"[{"content":"A","status":"pending"}]"#, "- [ ] A"),
            (r#"[{"content":"A","status":"[x]"}]"#, "- [x] A"),
            (r#"[{"content":"A","state":"DONE"}]"#, "- [x] A"),
            (r#"[{"content":"A","checked":true,"state":"done"}]"#, "- [x] A"),
            (r#"[{"content":"A","done":false}]"#, "- [ ] A"),
            // task / title as the text key; grouping header becomes a section
            (r#"[{"task":"A"}]"#, "- [ ] A"),
            (
                "[{\"content\":\"- [x] 已带标记\\n- [ ] 未带\",\"header\":\"组\"}]",
                "## 组\n- [x] 已带标记\n- [ ] 未带",
            ),
            // Unknown state is conservative: pending, never done.
            (r#"[{"content":"A","status":"weird"}]"#, "- [ ] A"),
        ];
        for (input, expected) in cases {
            assert_eq!(expected, sanitize_todo_markdown(input), "input: {input}");
        }
    }

    /// The degenerate envelope seen in the wild: items collapsed into
    /// placeholders while the only real information sat in `todos_note`.
    /// Salvage must keep the note and drop the placeholder instead of
    /// promoting it into an invented task row.
    #[test]
    fn placeholder_items_are_dropped_and_the_note_is_kept() {
        let dirty = r#"[{"todos_note": "承接自审：已完成 6 项，继续剩余 5 项", "content": "placeholder", "id": "x"}]"#;
        let out = sanitize_todo_markdown(dirty);
        assert!(out.contains("承接自审"), "{out}");
        assert!(!out.to_lowercase().contains("placeholder"), "{out}");
        assert_eq!(
            0,
            count_checkbox_lines(&out),
            "a progress note is prose, not a task: {out}"
        );
    }

    /// A model that stringified its argument twice produces an envelope whose
    /// `todos` value is itself an envelope. The first unwrap's gain is not a
    /// better task count (both shells' tail lines score 1) but exposing the
    /// inner shell — so the normaliser iterates to a fixed point instead of
    /// judging each unwrap on immediate improvement. Stopping one layer short
    /// garbles the tail line and silently drops the first task.
    #[test]
    fn double_envelope_is_fully_unwrapped() {
        let dirty = "[{\"todos\": \"[{\\\"todos\\\": \\\"- [x] A\\\\n- [ ] B\\\"}]\"}]";
        let out = sanitize_todo_markdown(dirty);
        assert_eq!("- [x] A\n- [ ] B", out, "double envelope not fully unwrapped: {out}");
        assert_eq!(2, count_checkbox_lines(&out));
    }

    /// A nested checklist array one level inside an object envelope — the shape
    /// `extract_todos_field` cannot reach because it only reads string values.
    #[test]
    fn nested_todos_array_is_salvaged() {
        let dirty = r#"[{"todos": [{"content": "A", "status": "done"}, {"content": "B", "status": "pending"}]}]"#;
        let out = sanitize_todo_markdown(dirty);
        assert_eq!("- [x] A\n- [ ] B", out, "{out}");
    }

    // ── read-side self-healing ────────────────────────────────────────────

    /// A stored JSON envelope with real items heals into the Markdown the
    /// panel can parse.
    #[test]
    fn heal_repairs_a_stored_json_envelope() {
        let dirty = r#"[{"content": "读取源码", "status": "done"}, {"content": "补测试", "status": "pending"}]"#;
        let healed = heal_content(dirty).expect("envelope must heal");
        assert_eq!(2, count_checkbox_lines(&healed), "{healed}");
    }

    /// A checklist that already parses is owned by the write path: a reader
    /// must never rewrite it.
    #[test]
    fn heal_leaves_a_parseable_checklist_untouched() {
        assert_eq!(None, heal_content("- [x] A\n- [ ] B"));
        assert_eq!(None, heal_content(""));
        assert_eq!(None, heal_content("纯散文，不是清单也不是 JSON"));
        // Single-task-line boundary: the guard is `> 0`, not `> 1`. A reader
        // that rewrote a one-line checklist would fight the write path on
        // every poll of a perfectly valid file.
        assert_eq!(None, heal_content("- [ ] 唯一一项"));
        assert_eq!(None, heal_content("- [x] 唯一一项"));
    }

    /// Garbage must not become a fabricated checklist.
    #[test]
    fn json_conversion_refuses_to_invent_tasks() {
        // Not an array of objects at all.
        assert_eq!(None, convert_json_items("not json"));
        assert_eq!(None, convert_json_items("[1,2,3]"));
        // Objects with no usable text field.
        assert_eq!(None, convert_json_items(r#"[{"id":"1"},{"id":"2"}]"#));
        // Text fields that are numbers/booleans, not strings.
        assert_eq!(None, convert_json_items(r#"[{"content":42,"done":true}]"#));
        // An empty array.
        assert_eq!(None, convert_json_items("[]"));
        // Bare prose strings are NOT promoted into tasks. A model that emits
        // ["junk"] must not get a fabricated checklist line out of it.
        assert_eq!(None, convert_json_items(r#"["junk"]"#));
        assert_eq!(None, convert_json_items(r#"["just prose","more prose"]"#));
        // Nor a number element.
        assert_eq!(None, convert_json_items("[42]"));
    }

    /// A string-array checklist whose lines are already Markdown is kept as-is —
    /// the real `work-mtojtak3` shape, whose file was a JSON array of Markdown
    /// lines and parsed to 0 tasks before this branch existed.
    #[test]
    fn json_string_array_of_markdown_lines_is_kept() {
        // Plain escaped string rather than a raw one: the payload contains
        // `["## `, and that `"##` sequence closes an r##"..."## raw string.
        let input = "[\"## 组\", \"- [x] done one\", \"- [ ] todo two\"]";
        assert_eq!(
            "## 组\n- [x] done one\n- [ ] todo two",
            convert_json_items(input).unwrap()
        );
        assert_eq!(2, count_checkbox_lines(&sanitize_todo_markdown(input)));
    }

    /// One stray non-object element must not discard the rest of the list.
    #[test]
    fn json_conversion_skips_stray_elements() {
        let out = convert_json_items(r#"[{"content":"A"},"junk",{"content":"B"}]"#).unwrap();
        assert_eq!("- [ ] A\n- [ ] B", out);
    }

    // ── conservatism: good input survives untouched ──────────────────────────

    #[test]
    fn keeps_normal_list_untouched() {
        let ok = "## 方案C 修复\n- [x] 已完成\n- [/] 进行中\n- [ ] 待办\n";
        assert_eq!(ok.trim(), sanitize_todo_markdown(ok));
    }

    #[test]
    fn keeps_literal_newline_inside_task_text() {
        let ok = "## 组\n- [ ] 说明字面 \\n 的用法\n- [x] 完成";
        assert_eq!(ok, sanitize_todo_markdown(ok));
    }

    #[test]
    fn keeps_unrepairable_text_as_is() {
        let junk = "这完全不是一份任务清单";
        assert_eq!(junk, sanitize_todo_markdown(junk));
    }

    #[test]
    fn handles_blank_input() {
        assert_eq!("", sanitize_todo_markdown(""));
        assert_eq!("", sanitize_todo_markdown("   \n  "));
    }

    #[test]
    fn checkbox_rule_is_strict() {
        assert_eq!(0, count_checkbox_lines("- [z] 非法状态符"));
        assert_eq!(0, count_checkbox_lines("-[] 缺少空格"));
        assert_eq!(0, count_checkbox_lines("普通列表项 - [x] 不在行首"));
        assert_eq!(
            4,
            count_checkbox_lines("- [x] a\n- [X] b\n- [/] c\n- [ ] d")
        );
    }

    /// Pins the documented divergence from the `/web/chat/todos` regex, which
    /// requires whitespace and text after `]` and therefore sees 0 here.
    #[test]
    fn strict_rule_accepts_a_missing_space_before_the_text() {
        assert_eq!(1, count_checkbox_lines("- [x]A"));
    }

    // ── footer branches: the run-length bug lives here ───────────────────────

    #[test]
    fn empty_tally_does_not_instruct_the_model_to_continue() {
        let f = progress_footer(&measure("完全不是清单"), false);
        assert!(f.contains("total: 0"), "{f}");
        assert!(!f.contains("[继续]"), "unsatisfiable push: {f}");
        assert!(!f.contains("[完成]"), "nothing was finished either: {f}");
    }

    #[test]
    fn footer_names_the_first_unfinished_item() {
        let f = progress_footer(&measure("- [x] A\n- [ ] 修复缺陷\n- [ ] B"), false);
        assert!(f.contains("[待办首项] 修复缺陷"), "{f}");
        assert!(f.contains("[继续] 还有 2 项未完成"), "{f}");
    }

    #[test]
    fn footer_truncates_a_long_task_text() {
        let long = "x".repeat(120);
        let f = progress_footer(&measure(&format!("- [ ] {}", long)), false);
        assert!(f.contains(&"x".repeat(80)), "{f}");
        assert!(f.contains("..."), "{f}");
        assert!(!f.contains(&"x".repeat(81)), "{f}");
    }

    #[test]
    fn footer_warns_about_in_progress_leftovers() {
        // 契约 §3.3：恢复语境（resume_hint=true）才注入 [提示] 行。
        let f = progress_footer(&measure("- [/] A"), true);
        assert!(f.contains("[提示] 存在 1 个"), "{f}");
    }

    /// 契约 §3.3：常规 run（resume_hint=false）的 footer 不带恢复 [提示] 行——
    /// `[/]` 是模型自己刚标的进行中项，「可能是上次中断遗留」是噪声。
    #[test]
    fn footer_omits_resume_hint_on_normal_runs() {
        let f = progress_footer(&measure("- [/] A\n- [ ] B"), false);
        assert!(!f.contains("[提示]"), "normal run must not nag about leftovers: {f}");
        // 其余 footer 行不受影响。
        assert!(f.contains("[进度]"), "{f}");
        assert!(f.contains("[继续]"), "{f}");
        assert!(f.contains("[待办首项]"), "{f}");
    }

    /// 契约 §3.3 源码级守护：恢复标记必须真的从 run_react_session 的
    /// abnormal-exit 校准分支传到 ToolContext（纯函数测试全绿但调用点漏接
    /// 是本仓库踩过的坑）。
    #[test]
    fn resume_hint_is_wired_from_the_calibration_branch() {
        let server_src = include_str!("server/mod.rs");
        let norm: String = server_src.split_whitespace().collect();
        assert!(
            norm.contains("letresume_calibration=session_ctx.interrupted.unwrap_or(false)"),
            "run_react_session must capture the interrupted flag as resume_calibration"
        );
        let react_src = include_str!("react/mod.rs");
        let norm2: String = react_src.split_whitespace().collect();
        assert!(
            norm2.contains("resume_calibration:config.resume_calibration"),
            "the loop must thread resume_calibration into ToolContext"
        );
    }

    #[test]
    fn all_done_grants_permission_to_wrap_up() {
        let f = progress_footer(&measure("- [x] A\n- [X] B"), false);
        assert!(f.contains("[完成] 所有事项均已 [x]"), "{f}");
        assert!(!f.contains("[继续]"), "{f}");
    }

    #[test]
    fn format_warning_is_never_mistaken_for_a_task_line() {
        for line in FORMAT_WARN.split('\n') {
            assert_eq!(0, count_checkbox_lines(line), "warning read as a task: {line}");
        }
    }

    // ── resume calibration ───────────────────────────────────────────────────

    #[test]
    fn calibration_is_skipped_when_nothing_is_open() {
        assert!(build_resume_calibration("- [x] A\n- [x] B").is_none());
        assert!(build_resume_calibration("").is_none());
    }

    #[test]
    fn calibration_carries_the_snapshot_and_forbids_redoing() {
        let c = build_resume_calibration("- [x] A\n- [ ] B").unwrap();
        assert!(c.contains("<todo_snapshot>"), "{c}");
        assert!(c.contains("- [ ] B"), "{c}");
        assert!(c.contains("严禁盲目重复执行"), "{c}");
    }

    // ── line parsing ─────────────────────────────────────────────────────────

    #[test]
    fn checkbox_of_strips_only_the_marker() {
        assert_eq!(Some(('x', "修复缺陷J")), checkbox_of("- [x]   修复缺陷J"));
        assert_eq!(Some((' ', "A")), checkbox_of("- [ ] A"));
        assert_eq!(Some(('/', "B")), checkbox_of("- [/] B"));
        assert_eq!(Some(('x', "C")), checkbox_of("- [X] C"));
        assert_eq!(None, checkbox_of("- [z] bad status char"));
        assert_eq!(None, checkbox_of("- [] A"));
        assert_eq!(None, checkbox_of("* [ ] A"));
        // A non-breaking space in the status slot: Java rejects it in its
        // switch, Rust because byte 4 is no longer ']'. Different route, same
        // verdict — recorded so a future attempt to unify the two parsers does
        // not read it as a divergence.
        assert_eq!(None, checkbox_of("- [\u{00A0}] A"));
        assert!(!is_checkbox_line("\u{1F600}"));
    }

    #[test]
    fn measure_reports_each_state_and_the_first_open_item() {
        let p = measure("- [ ] a\n- [/] b\n- [x] c\n- [X] d\n## 组\nrandom prose");
        assert_eq!(4, p.total);
        assert_eq!(1, p.pending);
        assert_eq!(1, p.in_progress);
        assert_eq!(2, p.done);
        assert_eq!(Some("a".to_string()), p.first_unfinished);
    }

    // ── JSON escape handling ─────────────────────────────────────────────────

    // ── planning guide: the contract's only channel to the model ─────────────

    /// The guides state the checkbox contract, so their own numbering has to be
    /// correct: a skipped or repeated number reads as a deliberate omission and
    /// the model starts treating the rules as interchangeable. `PLANNING_GUIDE`
    /// shipped as `1,2,3,4,5,7,7`, and nothing failed — that gap is the reason
    /// this is asserted rather than eyeballed.
    #[test]
    fn planning_guides_are_numbered_consecutively_and_agree_in_count() {
        fn numbers(guide: &str) -> Vec<usize> {
            guide
                .lines()
                .filter_map(|line| {
                    let t = line.trim_start();
                    // Leading ASCII digits only, so the byte slice below cannot
                    // split a multi-byte character.
                    let digits: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
                    if digits.is_empty() || !t[digits.len()..].starts_with(". ") {
                        return None;
                    }
                    digits.parse().ok()
                })
                .collect()
        }
        for (name, guide) in [("cn", PLANNING_GUIDE), ("en", PLANNING_GUIDE_EN)] {
            let got = numbers(guide);
            let want: Vec<usize> = (1..=got.len()).collect();
            assert_eq!(want, got, "{name} guide numbering is not consecutive");
            assert!(got.len() >= 5, "{name} guide lost rules: {got:?}");
        }
        assert_eq!(
            numbers(PLANNING_GUIDE).len(),
            numbers(PLANNING_GUIDE_EN).len(),
            "the two guides diverge in rule count: one prompt language is under-instructed"
        );
    }

    /// Both guides must carry the three things the defect actually needed: the
    /// checkbox syntax, the ban on a JSON envelope, and the instruction to read
    /// the list before resuming. Asserted by content because a rewrite that
    /// silently drops one of them restores the original bug while keeping
    /// plausible prose.
    #[test]
    fn both_guides_carry_the_rules_that_were_being_broken() {
        for (name, guide) in [("cn", PLANNING_GUIDE), ("en", PLANNING_GUIDE_EN)] {
            assert!(guide.contains("[/]"), "{name} lost the in-progress marker");
            assert!(guide.contains("[ ]"), "{name} lost the pending marker");
            assert!(guide.contains("[x]"), "{name} lost the done marker");
            assert!(
                guide.contains("JSON") || guide.contains("json"),
                "{name} no longer forbids the envelope form"
            );
            assert!(
                guide.contains("todoread"),
                "{name} no longer tells the model to read before acting"
            );
            // 契约 §3.1 重写后不再单列 [格式警告] 规则（格式契约并入第 1 条），
            // 改为守护「禁止占位符/字面换行」这一格式纪律仍在。
            assert!(
                guide.contains("占位符") || guide.contains("placeholder"),
                "{name} no longer forbids placeholder items"
            );
        }
    }

    /// 契约 §3.1 / §7：CN 指南长度上限 <1400 字符（原 ~904 tokens 的精简目标）。
    /// 超长指南挤占每轮上下文，且规则越多模型越容易挑着执行。
    #[test]
    fn planning_guide_cn_is_within_the_length_budget() {
        let len = PLANNING_GUIDE.chars().count();
        assert!(len < 1400, "CN planning guide too long: {len} chars");
        // 五条规则齐全（重写不能丢规则）。
        assert!(PLANNING_GUIDE.contains("随做随记"), "lost the record-as-you-go rule");
        assert!(PLANNING_GUIDE.contains("恢复校准"), "lost the resume-calibration rule");
        assert!(PLANNING_GUIDE.contains("收尾判据"), "lost the finish-criteria rule");
    }

    #[test]
    fn unescape_keeps_unknown_escapes_verbatim() {
        assert_eq!("\\q", unescape_json_string("\\q"));
        assert_eq!("\\", unescape_json_string("\\"), "trailing backslash kept");
        assert_eq!("\\uZZZZ", unescape_json_string("\\uZZZZ"));
        assert_eq!("\\u4e2", unescape_json_string("\\u4e2"), "short \\u kept");
        assert_eq!("a\nb\t\"c\\d/e", unescape_json_string("a\\nb\\t\\\"c\\\\d\\/e"));
    }

    // ── dead-loop adversarial corpus ────────────────────────────────────────
    //
    // The todo chain sits on the agent loop's spine: every reader that heals,
    // every writer that normalises, and every poll that writes back must be a
    // *contraction* — apply it twice and the second application is a no-op — or
    // a session can oscillate between two representations forever (panel heals
    // → model rewrites → panel heals again). These cases pin the contraction.

    /// Shapes a real session can hold on disk or receive as an argument.
    fn adversarial_corpus() -> Vec<&'static str> {
        vec![
            // the screenshot envelope: note + placeholder item
            r#"[{"todos_note": "承接自审：已完成 6 项，继续剩余 5 项", "content": "placeholder", "id": "x"}]"#,
            // real items in an array envelope
            r#"[{"content": "读取源码", "status": "done"}, {"content": "补测试", "status": "pending"}]"#,
            // string envelope with literal newlines
            "[{\"todos\": \"- [x] 现场取证\\n- [ ] 代码取证\"}]",
            // string envelope with real newlines
            "[{\"todos\": \"- [x] A\n- [ ] B\"}]",
            // bare collapsed list, no envelope
            "- [x] A\\n- [ ] B",
            // prose a human wrote (must never be rewritten)
            "纯散文，不是清单也不是 JSON",
            // empty and whitespace
            "",
            "   \n  ",
            // CRLF checklist
            "- [x] A\r\n- [ ] B\r\n",
            // tasks hidden inside the note with literal newlines
            r#"[{"todos_note": "- [ ] 真任务一\\n- [ ] 真任务二", "content": "placeholder"}]"#,
            // nested checklist array
            r#"[{"todos": [{"content": "A", "status": "done"}]}]"#,
            // garbage that must not become tasks
            r#"["junk", "more junk"]"#,
            "[1,2,3]",
        ]
    }

    /// The panel heals on every poll and `todoread` heals on every read: the
    /// healed bytes must be a fixed point of `heal_content`, otherwise each poll
    /// rewrites the file again and the panel/model/disk never agree.
    #[test]
    fn heal_is_a_contraction_on_the_adversarial_corpus() {
        for raw in adversarial_corpus() {
            let Some(healed) = heal_content(raw) else {
                continue;
            };
            // The endpoint/todoread write `healed + "\n"`; the next poll reads
            // exactly that. A second heal must be a no-op.
            let body = format!("{}\n", healed);
            assert_eq!(
                None,
                heal_content(&body),
                "heal not idempotent (poll would rewrite forever): {raw}"
            );
            assert_eq!(
                None,
                heal_content(&healed),
                "heal not idempotent without trailing newline: {raw}"
            );
        }
    }

    /// Cross-writer oscillation guard: the model may feed a healed checklist
    /// back through `todowrite` verbatim (the calibration snapshot invites
    /// exactly that). `sanitize` must then be the identity, or the file would
    /// flip between two representations on every write/read cycle.
    #[test]
    fn sanitize_is_the_identity_on_every_healed_output() {
        for raw in adversarial_corpus() {
            let Some(healed) = heal_content(raw) else {
                continue;
            };
            assert_eq!(
                healed,
                sanitize_todo_markdown(&healed),
                "sanitize moves a healed checklist (write/read oscillation): {raw}"
            );
        }
    }

    /// `sanitize` itself must be a fixed point: the tool result the model sees
    /// is `sanitize(arg)`, and a model that echoes its own previous argument
    /// back (a common retry behaviour) must not get a different file each time.
    #[test]
    fn sanitize_is_idempotent_on_the_adversarial_corpus() {
        for raw in adversarial_corpus() {
            let once = sanitize_todo_markdown(raw);
            let twice = sanitize_todo_markdown(&once);
            assert_eq!(once, twice, "sanitize not idempotent: {raw}");
        }
    }

    /// A model can emit arbitrarily deep JSON. The parser must terminate
    /// (serde caps recursion) instead of blowing the stack inside a tool call.
    /// Array nesting grows linearly; string-escaping nesting would double the
    /// payload per level and is not what models emit.
    #[test]
    fn deeply_nested_envelopes_terminate() {
        // Deeper than serde_json's recursion limit: parsing must fail cleanly.
        let mut deep = String::from("[{\"content\": \"A\"}]");
        for _ in 0..300 {
            deep = format!("[{{\"todos\": {}}}]", deep);
        }
        // Must return, whatever the verdict; a hang or panic here is a DoS on
        // the agent loop.
        let _ = sanitize_todo_markdown(&deep);
        let _ = heal_content(&deep);

        // Under serde_json's recursion limit (128; each wrapper level costs an
        // array AND an object level, so 50 wrappers = 100): the nested-array
        // recursion in `convert_json_value` runs for real and must terminate
        // with the innermost task kept.
        let mut shallow = String::from("[{\"content\": \"A\", \"status\": \"done\"}]");
        for _ in 0..50 {
            shallow = format!("[{{\"todos\": {}}}]", shallow);
        }
        let out = sanitize_todo_markdown(&shallow);
        assert!(out.contains("- [x] A"), "{out}");

        // Past the limit serde_json refuses the document outright; salvage then
        // degrades to the original bytes. That is a graceful stop, not a hang —
        // and `heal_content` must agree (healed == trimmed → None) so no reader
        // rewrites the file on every poll.
        assert_eq!(None, heal_content(&deep), "over-limit input must not oscillate");
    }

    /// An unclosed quote after `"todos":` must not spin the byte scanner: the
    /// scan is a single forward pass and returns None at end of input.
    #[test]
    fn unclosed_quote_after_todos_key_terminates() {
        let pathological = format!("{{\"todos\": \"{}", "x".repeat(200_000));
        assert_eq!(None, extract_todos_field(&pathological));
        assert_eq!(pathological, sanitize_todo_markdown(&pathological));
    }

    #[test]
    fn extract_todos_field_needs_a_string_value() {
        assert_eq!(None, extract_todos_field("[{\"status\": \"done\"}]"));
        assert_eq!(None, extract_todos_field("{\"todos\": 123}"));
        assert_eq!(None, extract_todos_field("{\"todos\": \"never closed"));
        assert_eq!(
            Some("abc".to_string()),
            extract_todos_field("{\"todos\":\"abc\"}")
        );
    }
}
