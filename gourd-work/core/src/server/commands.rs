//! Slash-command dispatch for the web chat input (Java `WsGate.handleCommand` /
//! `WebGate.isCommand` + `harness.command.*`).
//!
//! ## Why this module exists
//!
//! The frontend sends several user actions as **slash commands** through the
//! ordinary `/web/chat/input` endpoint, not through dedicated APIs. Two of them
//! are wired to buttons in the message action row (`app-message.js:560-561`):
//!
//! ```js
//! if (rerunBtn)    $(rerunBtn).on('click',    function() { triggerCommand('/rerun', true); });
//! if (continueBtn) $(continueBtn).on('click', function() { triggerCommand('/continue', false); });
//! ```
//!
//! `triggerCommand` → `sendCommandSilent` → `sendWithFormDataGrouped` posts the
//! literal string `/rerun` as the chat input. With no command interception the
//! kernel treated that as a prompt: the model received the text "/rerun" and
//! answered it conversationally, while the frontend had already deleted the
//! previous reply's DOM rows (`removeRow=true`) and switched into streaming
//! state. The visible result was a button that erased the last answer and
//! produced a nonsense reply.
//!
//! `/rewind` had the mirror problem: `SessionStore::rewind` and the
//! `/web/chat/rewind` endpoint both existed, but nothing ever emitted the
//! `rewind` **frame**, and `handleRewind` is reachable *only* from that frame
//! (`app-streaming.js:848`). So the DOM never removed its rows.
//!
//! ## Contract (Java parity)
//!
//! * Detection: input starts with `/`, and the first whitespace-separated token
//!   (lower-cased) names a registered command.
//! * Parsing is **quote-aware** (`CmdUtil.parseArguments`): `/compact keep "a b"`
//!   yields two arguments, not three.
//! * A bare `/` or `/   ` parses to an empty token list and is **not** a command
//!   — it falls through to normal input. Java added that guard after an
//!   `IndexOutOfBoundsException`; `/web/chat/input` is directly reachable, so the
//!   same guard is needed here.
//! * An **unrecognised** `/name` is not an error. Java falls back to skill
//!   invocation and then to plain streaming input, so a user typing `/foo` gets
//!   an answer rather than a rejection. This module returns `None` and lets the
//!   caller proceed exactly as before.
//! * `cliOnly` commands (`clear`, `model`, `exit`, `loop`) are registered in Java
//!   for both surfaces; the flag only filters the `/web/chat/hints` completion
//!   list. Only `clear` is meaningful over HTTP here, so it is the only one
//!   implemented; the others fall through to the model, which is harmless.
//!
//! ## Frames
//!
//! Non-agent commands must still close the frontend's streaming state. Java
//! sends the command's own frame **and then a `done` frame**
//! (`WsGate.java:1075-1079`); without the `done` the UI stays in "thinking"
//! forever with the stop button showing, because `sendCommandSilent` set
//! `isStreaming = true` before posting.

use crate::protocol::Frame;

/// Maximum arguments parsed from one command line. A guard, not a policy: the
/// values are small strings, but an unbounded split on a megabyte-long input
/// would allocate a vector the command never reads.
const MAX_ARGS: usize = 64;

/// A parsed slash command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCommand {
    /// Lower-cased command name, without the leading `/`.
    pub name: String,
    /// Arguments after the name, quote-aware.
    pub args: Vec<String>,
}

/// Quote-aware argument split (Java `CmdUtil.parseArguments`).
///
/// Whitespace outside quotes separates tokens; a quote character starts a region
/// in which whitespace is literal. Java keeps the quote characters in the token
/// (`current.append(c)` on the opening quote), and `/compact` joins the
/// arguments back together anyway, so the same is done here — stripping them
/// would change what a focus instruction looks like to the summariser.
pub fn parse_arguments(input: &str) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut quote_char = '\0';

    for c in input.chars() {
        if in_quotes {
            current.push(c);
            if c == quote_char {
                in_quotes = false;
            }
            continue;
        }
        if c == '"' || c == '\'' {
            in_quotes = true;
            quote_char = c;
            current.push(c);
        } else if c.is_whitespace() {
            if !current.is_empty() {
                args.push(std::mem::take(&mut current));
                if args.len() >= MAX_ARGS {
                    return args;
                }
            }
        } else {
            current.push(c);
        }
    }
    if !current.is_empty() && args.len() < MAX_ARGS {
        args.push(current);
    }
    args
}

/// Parse a raw chat input into a command, if it is one.
///
/// Returns `None` for anything that is not a dispatchable command, including a
/// bare `/` and an unrecognised name — the caller then treats the input as an
/// ordinary prompt, matching Java's fallback chain.
pub fn parse(input: &str) -> Option<ParsedCommand> {
    let trimmed = input.trim();
    if !trimmed.starts_with('/') {
        return None;
    }
    let mut parts = parse_arguments(&trimmed[1..]);
    if parts.is_empty() {
        return None;
    }
    let name = parts.remove(0).to_lowercase();
    if name.is_empty() {
        return None;
    }
    // Only names this kernel actually implements are dispatched. Everything else
    // falls through to the model, which is what Java does after its registry and
    // skill lookups both miss.
    if !is_supported(&name) {
        return None;
    }
    Some(ParsedCommand { name, args: parts })
}

/// Commands this kernel dispatches rather than forwarding to the model.
///
/// This is the **whole** table, `cli_only` included: the flag decides whether a
/// command is advertised, not whether it runs. `/clear` is the case in point --
/// Java marks it `cliOnly` so it stays out of the panel, yet `WebGate` still
/// dispatches it when typed by hand, and so does [`handle_slash_command`].
///
/// [`handle_slash_command`]: super::handle_slash_command
pub fn is_supported(name: &str) -> bool {
    COMMANDS.iter().any(|(n, _, _)| *n == name)
}

/// Every slash command this kernel dispatches, with the description shown in
/// the completion panel and whether it is CLI-only.
///
/// Java keeps a registry of `Command` objects and derives the panel from
/// `name()` / `description()` while skipping `cliOnly()`. This kernel has no
/// registry object, so the rows live here next to the dispatcher they describe.
///
/// ## Why one table with a flag, and not two lists
///
/// The two sets are genuinely different -- `clear` is dispatched but not
/// advertised -- yet they must never drift apart in the *other* direction:
/// advertising a command the dispatcher ignores sends the literal text to the
/// model, which is the original `/rerun` bug this module exists to prevent. A
/// flag makes "advertised" a strict subset of "dispatched" by construction;
/// two independent lists would make that an invariant someone has to remember.
///
/// ## Java parity of the flag values
///
/// `clear` and `model` are the only `cliOnly` commands in Java
/// (`ClearCommand.java:46`, `ModelCommand.java:53`). `exit` and `loop` return
/// `false` there, so they are *not* excluded by the flag -- they are absent
/// from this table simply because this kernel does not implement them, and so
/// fall through to the model (see `cli_only_commands_that_are_not_implemented
/// _fall_through`). `model` is absent for the same reason.
///
/// Rows are `(name, description, cli_only)`.
const COMMANDS: &[(&str, &str, bool)] = &[
    ("rewind", "回退最近的若干轮对话", false),
    ("rerun", "重跑最后一条用户消息", false),
    ("continue", "基于现有历史继续推理", false),
    ("compact", "压缩上下文，可附加保留重点", false),
    ("clear", "清空当前会话的消息历史", true),
];

/// Entries advertised by `/web/chat/hints`, in table order.
///
/// `cli_only` rows are filtered out, mirroring the `cmd.cliOnly()` skip in
/// Java's `WebController.hints`.
pub fn completable() -> impl Iterator<Item = (&'static str, &'static str)> {
    COMMANDS
        .iter()
        .filter(|(_, _, cli_only)| !*cli_only)
        .map(|(name, description, _)| (*name, *description))
}

/// Whether `name` is dispatched but deliberately kept out of the panel.
///
/// Exposed for the contract test that pins the flag values against Java; the
/// production path only needs [`is_supported`] and [`completable`].
pub fn is_cli_only(name: &str) -> bool {
    COMMANDS
        .iter()
        .any(|(n, _, cli_only)| *n == name && *cli_only)
}

/// Build the frames for `/rewind <n>`.
///
/// `removed` is how many stored messages the ledger actually dropped. The frame
/// carries the count in **both** `text` and `count`:
///
/// * `app-streaming.js:848` reads `parseInt(chunk.text) || 1` — `text` is what
///   drives `handleRewind`, so without it the frontend always removes exactly one
///   row regardless of the argument.
/// * Java's `WsGate` sets `count` (as `rewindCount + 1`). Setting both keeps this
///   kernel compatible with either reader instead of picking a side in a
///   pre-existing Java/frontend disagreement.
pub fn rewind_frames(session_id: &str, removed: usize, seq: &mut i64) -> Vec<Frame> {
    let n = removed.max(1) as i64;
    let mut f = Frame::new("rewind")
        .session(session_id)
        .text(n.to_string())
        .seq(next(seq));
    f = f.extra("count", serde_json::json!(n));
    vec![f, done_frame(session_id, seq)]
}

/// Build the frames for a command that only reports text (`/clear`, `/compact`).
pub fn command_frames(session_id: &str, text: &str, seq: &mut i64) -> Vec<Frame> {
    vec![
        Frame::new("command")
            .session(session_id)
            .text(text)
            .seq(next(seq)),
        done_frame(session_id, seq),
    ]
}

/// The `done` frame that closes the frontend's streaming state.
///
/// Not optional: `sendCommandSilent` sets `isStreaming = true` and shows the
/// thinking indicator *before* posting, so a command that answers without a
/// `done` leaves the UI spinning with a stop button that has nothing to stop.
fn done_frame(session_id: &str, seq: &mut i64) -> Frame {
    Frame::done(session_id).seq(next(seq))
}

fn next(seq: &mut i64) -> i64 {
    let v = *seq;
    *seq += 1;
    v
}

/// Validate the `/rewind` count argument the way Java does.
///
/// Returns `Ok(count)` for a missing or valid argument, `Err(message)` for an
/// explicitly invalid one. Java prints "回退数量必须为正整数" and returns without
/// touching the session; reporting the error is better than silently rewinding
/// one message, because the user asked for something else.
pub fn rewind_count(args: &[String]) -> Result<usize, String> {
    match args.first() {
        None => Ok(1),
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Ok(1);
            }
            match trimmed.parse::<i64>() {
                Ok(n) if n > 0 => Ok(n as usize),
                _ => Err("回退数量必须为正整数".to_string()),
            }
        }
    }
}

/// The `/compact` focus instruction, if one was given.
///
/// Java passes this to its LLM summariser so compression preferentially keeps the
/// relevant material. This kernel's compressor is the zero-cost path (sweep +
/// trim) with no summariser, so it cannot semantically choose *which* messages
/// survive. What the focus does here is narrower but real: it is injected into the
/// retained window as an explicit focus turn (see `compress::compress`), so the
/// model steers the next turn by it. Returning it separately from the message keeps
/// the two concerns apart — the caller reports what was requested, and the
/// compressor is what makes it take effect.
pub fn compact_focus(args: &[String]) -> Option<String> {
    let joined = args.join(" ").trim().to_string();
    if joined.is_empty() {
        None
    } else {
        Some(joined)
    }
}

/// The `/compact` confirmation text (Java `CompactCommand.execute`).
///
/// Both lines go into one `command` frame: the frontend renders that text as the
/// command's whole output, so splitting it across frames would show only one.
pub fn compact_message(focus: Option<&str>) -> String {
    let head = match focus {
        Some(f) => format!("已请求压缩上下文，聚焦：{}", f),
        None => "已请求压缩上下文".to_string(),
    };
    format!("{}\n将在下一轮推理开始时生效", head)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── Parsing (Java CmdUtil parity) ─────────────────────────────────────

    #[test]
    fn parses_a_bare_command() {
        let c = parse("/rerun").expect("/rerun is a command");
        assert_eq!(c.name, "rerun");
        assert!(c.args.is_empty());
    }

    #[test]
    fn parses_a_command_with_arguments() {
        let c = parse("/rewind 3").unwrap();
        assert_eq!(c.name, "rewind");
        assert_eq!(c.args, vec!["3"]);
    }

    #[test]
    fn the_command_name_is_case_insensitive() {
        // Java lower-cases before the registry lookup, so /REWIND and /rewind are
        // the same command.
        assert_eq!(parse("/REWIND 2").unwrap().name, "rewind");
        assert_eq!(parse("/Rewind").unwrap().name, "rewind");
    }

    #[test]
    fn surrounding_whitespace_is_tolerated() {
        // The frontend trims before sending, but /web/chat/input is directly
        // reachable and a pasted command often carries a trailing newline.
        assert_eq!(parse("  /clear  ").unwrap().name, "clear");
        assert_eq!(parse("\t/rewind 1\n").unwrap().name, "rewind");
    }

    #[test]
    fn quotes_keep_whitespace_inside_one_argument() {
        // Java's parseArguments is quote-aware; a naive split_whitespace would
        // turn this focus instruction into three arguments.
        let c = parse("/compact keep \"the database migration\" notes").unwrap();
        assert_eq!(c.name, "compact");
        assert_eq!(c.args, vec!["keep", "\"the database migration\"", "notes"]);
        assert_eq!(
            compact_focus(&c.args).as_deref(),
            Some("keep \"the database migration\" notes")
        );
    }

    #[test]
    fn single_quotes_are_also_honoured() {
        let c = parse("/compact 'a b'").unwrap();
        assert_eq!(c.args, vec!["'a b'"]);
    }

    #[test]
    fn a_bare_slash_is_not_a_command() {
        // Java added this guard after an IndexOutOfBoundsException: parts is
        // empty, so parts.get(0) would throw. `/web/chat/input` is directly
        // reachable, so the same input can arrive here.
        for input in ["/", "/   ", "/\t\n", "  /  "] {
            assert_eq!(parse(input), None, "{:?} must fall through to normal input", input);
        }
    }

    #[test]
    fn ordinary_text_is_not_a_command() {
        for input in ["hello", "fix the bug", "a / b", "C:/path/to/file", ""] {
            assert_eq!(parse(input), None, "{:?} is not a command", input);
        }
    }

    #[test]
    fn a_slash_inside_text_does_not_start_a_command() {
        // Only a *leading* slash dispatches. Otherwise a path or a ratio in a
        // prompt would be swallowed.
        assert_eq!(parse("see /etc/hosts"), None);
        assert_eq!(parse("ratio 1/2"), None);
    }

    #[test]
    fn an_unrecognised_command_falls_through_to_the_model() {
        // Java tries the registry, then skills, then plain streaming input. A
        // user typing /foo must get an answer, not a rejection — and a skill
        // named foo must still be reachable through the same entry point.
        for input in ["/foo", "/foo bar", "/definitely-not-a-command"] {
            assert_eq!(parse(input), None, "{:?} must fall through", input);
        }
    }

    #[test]
    fn cli_only_commands_that_are_not_implemented_fall_through() {
        // Absent from COMMANDS because this kernel has no HTTP implementation for
        // them -- not because of the `cli_only` flag. (`exit` and `loop` are in
        // fact `cliOnly=false` in Java; `model` is `cliOnly=true`. Either way the
        // reason they fall through here is the missing dispatch arm.) Forwarding
        // them to the model is harmless; claiming to have executed them is not.
        for input in ["/model ls", "/exit", "/loop ls"] {
            assert_eq!(parse(input), None, "{:?} must fall through", input);
        }
    }

    #[test]
    fn every_advertised_command_is_dispatchable() {
        // The invariant that matters: the panel must never offer something the
        // dispatcher ignores, or the literal text reaches the model (the original
        // `/rerun` bug). Driven off `completable()` rather than a hard-coded list
        // so a new row is covered the moment it is added.
        let advertised: Vec<&str> = completable().map(|(name, _)| name).collect();
        assert!(!advertised.is_empty(), "an empty panel is not a passing state");

        for name in advertised {
            assert!(is_supported(name), "/{} is advertised but not supported", name);
            assert!(
                parse(&format!("/{}", name)).is_some(),
                "/{} is advertised but does not parse",
                name
            );
        }
    }

    #[test]
    fn a_cli_only_command_is_dispatched_but_never_advertised() {
        // `clear` is the reason the table carries a flag instead of being two
        // lists. Java keeps it out of the panel (`ClearCommand.java:46`) while
        // `WebGate` still runs it when typed, and `handle_slash_command` has a
        // `"clear"` arm. Dropping it from the table to hide it from the panel
        // would silently turn `/clear` into a prompt.
        assert!(is_cli_only("clear"), "clear must stay flagged cli-only");
        assert!(is_supported("clear"), "cli-only must not mean undispatchable");
        assert!(parse("/clear").is_some(), "/clear must still dispatch");
        assert!(
            !completable().any(|(name, _)| name == "clear"),
            "a cli-only command must not reach the completion panel"
        );
    }

    #[test]
    fn the_flag_values_match_java() {
        // Pins the parity claim in the table's doc comment. Java's only two
        // `cliOnly=true` commands are `clear` and `model`; `model` is not
        // implemented here, so `clear` must be the single flagged row.
        let flagged: Vec<&str> = ["rewind", "rerun", "continue", "compact", "clear"]
            .into_iter()
            .filter(|name| is_cli_only(name))
            .collect();
        assert_eq!(flagged, vec!["clear"], "only `clear` is cliOnly in Java");
    }

    #[test]
    fn every_supported_command_is_dispatchable() {
        // Guards the two lists against drifting: `is_supported` is what `parse`
        // consults, so a name added to one and not the other would silently
        // become a no-op.
        for name in ["rewind", "rerun", "continue", "compact", "clear"] {
            assert!(is_supported(name), "{} must be supported", name);
            assert!(parse(&format!("/{}", name)).is_some(), "/{} must parse", name);
        }
    }

    #[test]
    fn argument_count_is_bounded() {
        // A megabyte-long input must not allocate an unbounded vector.
        let input = format!("/compact {}", "x ".repeat(5000));
        let c = parse(&input).unwrap();
        assert!(c.args.len() <= MAX_ARGS, "got {} args", c.args.len());
    }

    // ─── /rewind argument validation ───────────────────────────────────────

    #[test]
    fn rewind_defaults_to_one() {
        assert_eq!(rewind_count(&[]), Ok(1));
        assert_eq!(rewind_count(&["".to_string()]), Ok(1));
        assert_eq!(rewind_count(&["   ".to_string()]), Ok(1));
    }

    #[test]
    fn rewind_accepts_a_positive_integer() {
        assert_eq!(rewind_count(&["1".to_string()]), Ok(1));
        assert_eq!(rewind_count(&["7".to_string()]), Ok(7));
        assert_eq!(rewind_count(&[" 3 ".to_string()]), Ok(3));
    }

    #[test]
    fn rewind_rejects_zero_negative_and_garbage() {
        // Java prints "回退数量必须为正整数" and returns without touching the
        // session. Reporting beats silently rewinding one message, because the
        // user asked for something else.
        for bad in ["0", "-1", "-5", "abc", "1.5", "2x"] {
            let r = rewind_count(&[bad.to_string()]);
            assert!(r.is_err(), "{:?} must be rejected, got {:?}", bad, r);
            assert_eq!(r.unwrap_err(), "回退数量必须为正整数");
        }
    }

    // ─── /compact focus ────────────────────────────────────────────────────

    #[test]
    fn compact_focus_is_none_without_arguments() {
        assert_eq!(compact_focus(&[]), None);
        assert_eq!(compact_focus(&["".to_string()]), None);
        assert_eq!(compact_focus(&["  ".to_string()]), None);
    }

    #[test]
    fn compact_focus_joins_multiple_arguments() {
        // Java's getArgsJoined: the focus is free text, so it may arrive as
        // several whitespace-separated tokens.
        assert_eq!(
            compact_focus(&["keep".to_string(), "the".to_string(), "conclusions".to_string()]).as_deref(),
            Some("keep the conclusions")
        );
    }

    // ─── Frame contracts ───────────────────────────────────────────────────

    fn types(frames: &[Frame]) -> Vec<String> {
        frames
            .iter()
            .map(|f| serde_json::from_str::<serde_json::Value>(&f.to_json()).unwrap()["type"]
                .as_str()
                .unwrap()
                .to_string())
            .collect()
    }

    #[test]
    fn every_command_outcome_ends_with_a_done_frame() {
        // `sendCommandSilent` sets isStreaming=true and shows the thinking
        // indicator before posting. Without a `done` the UI spins forever with a
        // stop button that has nothing to stop. Java sends it for the same reason
        // (WsGate.java:1075-1079).
        let mut seq = 0;
        let frames = rewind_frames("s", 2, &mut seq);
        assert_eq!(types(&frames), vec!["rewind", "done"]);

        let mut seq = 0;
        let frames = command_frames("s", "已清空", &mut seq);
        assert_eq!(types(&frames), vec!["command", "done"]);
    }

    #[test]
    fn the_rewind_frame_carries_the_count_in_text_because_that_is_what_the_frontend_reads() {
        // app-streaming.js:848 does `parseInt(chunk.text) || 1`. A frame without
        // `text` makes the frontend remove exactly one row no matter what the
        // user asked for.
        let mut seq = 0;
        let frames = rewind_frames("s", 4, &mut seq);
        let v: serde_json::Value = serde_json::from_str(&frames[0].to_json()).unwrap();
        assert_eq!(v["text"], "4", "text drives handleRewind");
        assert_eq!(v["sessionId"], "s");
        // Java sets `count` too; carrying both keeps either reader working.
        assert_eq!(v["count"], 4);
    }

    #[test]
    fn a_rewind_that_removed_nothing_still_removes_one_row() {
        // `removed` can be 0 on an empty session. `handleRewind` returns early on
        // count<=0, so emitting 0 would leave the DOM and the store disagreeing
        // about a message the store already dropped. Floor at 1.
        let mut seq = 0;
        let frames = rewind_frames("s", 0, &mut seq);
        let v: serde_json::Value = serde_json::from_str(&frames[0].to_json()).unwrap();
        assert_eq!(v["text"], "1");
    }

    #[test]
    fn frames_carry_monotonic_sequence_numbers() {
        // The frontend dedupes on eventSeq across realtime and replay, so gaps or
        // repeats corrupt the stream.
        let mut seq = 10;
        let frames = rewind_frames("s", 1, &mut seq);
        let seqs: Vec<i64> = frames
            .iter()
            .map(|f| serde_json::from_str::<serde_json::Value>(&f.to_json()).unwrap()["eventSeq"]
                .as_i64()
                .unwrap())
            .collect();
        assert_eq!(seqs, vec![10, 11]);
        assert_eq!(seq, 12, "the caller's counter must advance past every frame");
    }

    #[test]
    fn the_command_frame_carries_its_output_text() {
        let mut seq = 0;
        let frames = command_frames("s", "已回退 2 条记录", &mut seq);
        let v: serde_json::Value = serde_json::from_str(&frames[0].to_json()).unwrap();
        assert_eq!(v["type"], "command");
        assert_eq!(v["text"], "已回退 2 条记录");
        assert_eq!(v["sessionId"], "s");
    }
}
