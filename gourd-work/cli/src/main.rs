//! gourd-work-cli — Terminal front-end for the Rust-native agent kernel.
//!
//! Usage (the authoritative list lives in `help_text()`, printed by `--help`):
//!   gwork              → interactive REPL in current directory
//!   gwork "do X"       → one-shot task
//!   gwork acp          → ACP agent over stdio (spawned by editors)
//!   gwork --serve 8080 → start HTTP/WS server (for web UI)
//!   gwork --home <dir> → redirect the global area to <dir>/.gwork
//!                        (equivalent to Java's -Dgwork.home / GWORK_HOME)
//!   gwork --version    → print version;   gwork --help → print usage

use std::io::Write;
use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Result;
use gourd_work_core::config::Settings;
use gourd_work_core::llm::ChatMessage;
use gourd_work_core::protocol::Frame;
use gourd_work_core::react::prompt::{build_agent_roster, build_system_prompt};
use gourd_work_core::react::{ReActAgent, ReActConfig};
use gourd_work_core::tools::ToolRegistry;

/// Build the log filter.
///
/// `RUST_LOG` wins outright when set. The previous code chained
/// `from_default_env().add_directive("gourd_work_core=info")`, and because a
/// later directive overrides an earlier one for the same target, that silently
/// pinned the kernel to `info` — `RUST_LOG=gourd_work_core=debug` had no
/// effect, which makes debug-only diagnostics (e.g. the usage ledger's archive
/// breakdown) impossible to enable without a rebuild. Now the default is only
/// applied when the user has not asked for anything.
fn env_filter() -> Result<tracing_subscriber::EnvFilter> {
    if std::env::var_os("RUST_LOG").is_some_and(|v| !v.is_empty()) {
        Ok(tracing_subscriber::EnvFilter::from_default_env())
    } else {
        Ok(tracing_subscriber::EnvFilter::new("gourd_work_core=info"))
    }
}

/// What `--help` / `--version` print, decided before any I/O so the choice is
/// testable (a binary's argument handling otherwise cannot be unit-tested).
#[derive(Debug, PartialEq, Eq)]
enum EarlyExit {
    Version,
    Help,
}

/// Recognise `--help` / `--version` and their short forms.
///
/// Must run before `Settings::load_default()`: both flags are pure — they read
/// no configuration and start no kernel. Previously the CLI recognised no flags
/// at all, so every unrecognised argument fell through to the model check and
/// `gwork --version` printed "No model configured…" with exit code 1. On a
/// fresh install the user could not even ask which version they had.
///
/// The first matching flag wins, matching the usual convention. `None` means
/// "not a help/version request — start normally", so `--serve`, `acp` and the
/// one-shot form are untouched.
fn early_exit(args: &[String]) -> Option<EarlyExit> {
    // args[0] is the program name.
    let flag = args
        .iter()
        .skip(1)
        .find(|a| matches!(a.as_str(), "--help" | "-h" | "--version" | "-V"))?;
    Some(match flag.as_str() {
        "--help" | "-h" => EarlyExit::Help,
        _ => EarlyExit::Version,
    })
}

/// `--version` output.
///
/// The number comes from the workspace package (`version.workspace = true` in
/// cli/Cargo.toml → `[workspace.package].version`), never a literal — the same
/// rule core's `/web/chat/meta` and `acp.rs` follow.
fn version_text() -> String {
    format!("gwork {}", env!("CARGO_PKG_VERSION"))
}

/// What `gwork web` / `gwork --serve` resolved to, decided before any I/O so the
/// argument handling can be unit-tested (a binary's `main` otherwise cannot be).
#[derive(Debug, PartialEq, Eq)]
struct ServeMode {
    port: u16,
    static_dir: Option<std::path::PathBuf>,
}

/// Recognise server mode and parse its options.
///
/// Two spellings, one behaviour:
///   * `gwork web [PORT]` — the form the remote deployment chain launches
///     (`gwork web 18080`), matching the Java kernel's `web` subcommand so the
///     shell's start command does not have to differ per kernel.
///   * `gwork --serve [PORT]` — the original spelling, kept because existing
///     scripts and the desktop shell's local launch use it.
///
/// `web` is matched as a bare word at position 1 only: a one-shot task whose text
/// happens to start with "web" (`gwork "web scraping help"`) must still reach the
/// model, and a later occurrence of the word inside a task string must not hijack
/// the run. `--serve` is matched anywhere, as before.
///
/// A port that does not parse falls back to 8080 rather than erroring: the Java
/// kernel's `web` subcommand does the same, and a typo'd port should not turn a
/// server launch into a crash the shell then reports as "backend never came up".
fn serve_mode(args: &[String]) -> Option<ServeMode> {
    let pos = args
        .iter()
        .position(|a| a == "--serve")
        .or_else(|| (args.get(1).map(|a| a.as_str()) == Some("web")).then_some(1))?;
    let port: u16 = args.get(pos + 1).and_then(|p| p.parse().ok()).unwrap_or(8080);
    let static_dir = args
        .iter()
        .position(|a| a == "--static")
        .and_then(|i| args.get(i + 1))
        .map(std::path::PathBuf::from);
    Some(ServeMode { port, static_dir })
}

/* Help body. Deliberately flush-left: a `\`-continued literal would swallow the
   indentation of every line, and re-indenting the output at runtime is how help
   text acquires stray leading spaces. `help_text()` prepends the version line. */
const HELP_BODY: &str = "\
USAGE:
    gwork                       interactive REPL in the current directory
    gwork \"do X\"                run one task, print the answer, then exit
    gwork acp                   run as an ACP agent over stdio (for editors)
    gwork web [PORT]            start the HTTP/WS server (default port 8080)
    gwork web [PORT] --static DIR
                                also serve the UI in DIR from that server
    gwork --serve [PORT]        alias of `gwork web` (kept for compatibility)
    gwork --serve [PORT] --static DIR
                                also serve the UI in DIR from that server

OPTIONS:
    -h, --help                  print this help and exit
    -V, --version               print the version and exit
    --home DIR                  put the global area in DIR/.gwork instead of
                                ~/.gwork (same slot as GWORK_HOME; --home wins)
    --remote-deployed           mark this kernel as remote-deployed: accept the
                                desktop shell's model mirror over
                                /web/settings/overlay and refuse to persist it
                                (same slot as GWORK_REMOTE_DEPLOYED)

ENVIRONMENT:
    GWORK_HOME                  global area override (legacy name GOURDAI_HOME)
    GWORK_REMOTE_DEPLOYED       remote-deployed marker (see --remote-deployed)
    GWORK_WEB_AUTH              Basic Auth credentials as user:pass (remote mode)
    RUST_LOG                    tracing filter (default gourd_work_core=info)
";

/// `--help` output.
fn help_text() -> String {
    format!(
        "gwork {} — GWork agent kernel (Rust)\n\n{}",
        env!("CARGO_PKG_VERSION"),
        HELP_BODY
    )
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(env_filter()?)
        .with_target(false)
        .init();

    let args: Vec<String> = std::env::args().collect();
    let workspace = std::env::current_dir()?;

    // --help / --version are answered before anything reads configuration, so
    // they work on a fresh install that has no model configured yet.
    if let Some(kind) = early_exit(&args) {
        match kind {
            EarlyExit::Version => println!("{}", version_text()),
            EarlyExit::Help => print!("{}", help_text()),
        }
        return Ok(());
    }

    // --home <dir>: redirect the global area (sessions/settings/skills/...).
    // Must be applied before anything resolves a global-area path, so it is
    // parsed first — ahead of the acp/serve branches below.
    if let Some(i) = args.iter().position(|a| a == "--home") {
        if let Some(dir) = args.get(i + 1) {
            gourd_work_core::config::set_harness_base(Some(std::path::PathBuf::from(dir)));
        }
    }

    // --remote-deployed: this kernel is the one the desktop shell deployed on a
    // remote host. Set before `serve_*` so the overlay endpoint can answer from
    // the first request. The env var is the equivalent slot (the shell injects
    // that one, because a command-line flag is visible in `ps` on the remote
    // host); `serve_with_static` reads it, so only the flag needs handling here.
    if args.iter().any(|a| a == "--remote-deployed") {
        gourd_work_core::remote::mirror::set_remote_deployed(true);
    }

    // `acp` subcommand: run as an ACP agent over stdio (spawned by editors).
    // Note it is a bare word, not `--acp` — the check below is what defines it.
    if args.iter().any(|a| a == "acp") {
        return gourd_work_core::acp::run_acp().await;
    }

    // Server mode (`gwork web [PORT]` / `gwork --serve [PORT]`). Parsing lives in
    // `serve_mode` so it is unit-testable; see its doc comment for the two
    // spellings and why `web` is position-1 only.
    if let Some(mode) = serve_mode(&args) {
        let addr = SocketAddr::from(([127, 0, 0, 1], mode.port));
        println!("GWork Rust kernel serving on http://{}", addr);
        return gourd_work_core::server::serve_with_static(addr, workspace, mode.static_dir).await;
    }

    // Load settings
    let settings = match Settings::load_default() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Warning: could not load settings: {}", e);
            Settings::default()
        }
    };

    let model = match settings.default_model_config() {
        Some(m) => m.clone(),
        None => {
            eprintln!("No model configured. Please add a model to ~/.gwork/settings.json");
            std::process::exit(1);
        }
    };

    println!("GWork CLI (Rust kernel) — model: {}", model.name);
    println!("Workspace: {}", workspace.display());
    println!("Type your task, or 'exit' to quit.\n");

    let registry = Arc::new(ToolRegistry::default_registry());
    let session_id = format!("cli-{}", &uuid::Uuid::new_v4().to_string()[..8]);
    // The sub-agent roster must be appended here too. The CLI registers `task` /
    // `multitask` like every other front-end, so without the roster the model has
    // no way to learn which agents exist and picks names from the tool
    // description's examples — then gets an "unknown agent" result and burns a
    // turn. Found by the end-to-end probe: the server, ACP and loop paths all had
    // this and the CLI was the one that did not.
    let mut history: Vec<ChatMessage> = vec![ChatMessage::system(
        build_system_prompt(&settings, &workspace.to_string_lossy())
            + &build_agent_roster(&workspace, &settings.permission),
    )];

    // One-shot mode
    let mut one_shot: Option<String> = args.get(1).filter(|a| !a.starts_with('-')).cloned();

    loop {
        let input = if let Some(task) = one_shot.take() {
            task
        } else {
            print!("> ");
            std::io::stdout().flush()?;
            let mut line = String::new();
            if std::io::stdin().read_line(&mut line)? == 0 {
                break;
            }
            let trimmed = line.trim().to_string();
            if trimmed.is_empty() { continue; }
            if trimmed == "exit" || trimmed == "quit" { break; }
            trimmed
        };

        history.push(ChatMessage::user(&input));

        // Frame printer channel
        let (frame_tx, mut frame_rx) = tokio::sync::mpsc::unbounded_channel::<Frame>();
        let print_handle = tokio::spawn(async move {
            while let Some(frame) = frame_rx.recv().await {
                match frame.frame_type.as_str() {
                    "text" => {
                        if let Some(t) = &frame.text {
                            print!("{}", t);
                            let _ = std::io::stdout().flush();
                        }
                    }
                    "action_start" => {
                        eprintln!("\n  ⚙ [{}]", frame.tool_name.unwrap_or_default());
                    }
                    "action_end" => {
                        let preview: String = frame.text.unwrap_or_default().chars().take(200).collect();
                        eprintln!("  ✓ {}\n", preview.replace('\n', " "));
                    }
                    "error" => {
                        eprintln!("\n  ✗ Error: {}", frame.text.unwrap_or_default());
                    }
                    "done" => {
                        println!();
                    }
                    _ => {}
                }
            }
        });

        let config = ReActConfig {
            session_id: session_id.clone(),
            workspace: workspace.clone(),
            // The CLI keeps no session storage, so there is no session directory
            // to point per-session artefacts at; `todowrite` falls back to the
            // workspace path (see `ToolContext::todo_file`).
            session_dir: None,
            model: model.clone(),
            settings: settings.clone(),
            access_mode: "full".into(),
            max_turns: settings.general.max_turns,
            run_id: format!("cli-run-{}", &uuid::Uuid::new_v4().to_string()[..8]),
            start_seq: 0,
            hitl_approved: true,
            // No caller-supplied whitelist: the CLI derives its gate from
            // `settings.permission` inside the loop.
            gate: None,
            change_ledger: None,
            // A CLI one-shot is a top-level run: nothing delegated it, and its own
            // session id is the conversation the frames belong to.
            subagent_depth: 0,
            root_session_id: session_id.clone(),
            // The CLI has no thinking-depth picker; let the provider default.
            thinking: None,
            // CLI one-shots have no session storage: the meter denominator comes
            // from the global setting and the cumulative ledger stays empty.
            context_length: settings.general.context_length,
            turn_start_ms: chrono::Utc::now().timestamp_millis(),
            usage_seed: gourd_work_core::session_usage::SessionUsageSum::default(),
            // The CLI one-shot path has no `/compact` entry point.
            force_compact: false,
            compact_focus: None,
        };

        let agent = ReActAgent::new(registry.clone());
        let cancel = tokio_util::sync::CancellationToken::new();
        let result = agent.run(&config, history.clone(), frame_tx, cancel).await;

        // Append assistant reply to history
        if !result.final_answer.is_empty() {
            history.push(ChatMessage::assistant(&result.final_answer));
        }

        drop(print_handle);

        if one_shot.is_none() && result.interrupted() {
            eprintln!("[run interrupted]");
        }

        // In one-shot mode, exit after the task
        if args.len() > 1 && !args[1].starts_with('-') {
            break;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build an argv exactly as `std::env::args()` yields it: element 0 is the
    /// program name, never a flag.
    fn argv(parts: &[&str]) -> Vec<String> {
        let mut v = vec!["gwork".to_string()];
        v.extend(parts.iter().map(|s| s.to_string()));
        v
    }

    #[test]
    fn help_flags_are_recognised_in_both_forms() {
        for a in ["--help", "-h"] {
            assert_eq!(early_exit(&argv(&[a])), Some(EarlyExit::Help), "{a}");
        }
    }

    #[test]
    fn version_flags_are_recognised_in_both_forms() {
        for a in ["--version", "-V"] {
            assert_eq!(early_exit(&argv(&[a])), Some(EarlyExit::Version), "{a}");
        }
    }

    #[test]
    fn the_program_name_itself_is_never_treated_as_a_flag() {
        // args[0] is the executable path. Skipping it is what keeps a binary
        // that happens to be named "--help" from printing help.
        assert_eq!(early_exit(&["--help".to_string()]), None);
        assert_eq!(early_exit(&["--version".to_string()]), None);
    }

    #[test]
    fn real_work_modes_are_not_hijacked() {
        // The inverse of the original bug. Before these flags existed every
        // unrecognised argument fell through to the model check; matching too
        // eagerly would instead swallow the modes that actually do work.
        for args in [
            argv(&[]),
            argv(&["--serve"]),
            argv(&["--serve", "8080"]),
            argv(&["--serve", "8080", "--static", "ui"]),
            argv(&["web"]),
            argv(&["web", "18080"]),
            argv(&["acp"]),
            argv(&["--home", "/tmp/x"]),
            argv(&["do X"]),
        ] {
            assert_eq!(early_exit(&args), None, "{args:?} must start normally");
        }
    }

    // ─── serve_mode ───────────────────────────────────────────────────────
    //
    // `gwork web PORT` is what the remote deployment chain launches, so a parse
    // regression here does not show up as a CLI typo — it shows up as "the remote
    // backend never became ready" 180 s into an SSH connection, with the real
    // cause (the kernel started a REPL instead of a server) invisible.

    #[test]
    fn web_subcommand_parses_port_and_static_dir() {
        assert_eq!(
            serve_mode(&argv(&["web", "18080"])),
            Some(ServeMode { port: 18080, static_dir: None })
        );
        assert_eq!(
            serve_mode(&argv(&["web", "18080", "--static", "/opt/ui"])),
            Some(ServeMode {
                port: 18080,
                static_dir: Some(std::path::PathBuf::from("/opt/ui"))
            })
        );
        // Bare `web` keeps the documented default port.
        assert_eq!(
            serve_mode(&argv(&["web"])),
            Some(ServeMode { port: 8080, static_dir: None })
        );
    }

    #[test]
    fn serve_flag_still_works_and_wins_over_a_later_web_word() {
        assert_eq!(
            serve_mode(&argv(&["--serve", "9090"])),
            Some(ServeMode { port: 9090, static_dir: None })
        );
        // `--serve` is matched anywhere (existing behaviour); the port is read
        // from the token after whichever spelling matched.
        assert_eq!(
            serve_mode(&argv(&["--home", "/tmp/x", "--serve", "9091"])),
            Some(ServeMode { port: 9091, static_dir: None })
        );
    }

    #[test]
    fn an_unparseable_port_falls_back_instead_of_crashing() {
        // A typo'd port must not turn a server launch into a crash the shell
        // reports as "backend never came up".
        assert_eq!(
            serve_mode(&argv(&["web", "not-a-port"])),
            Some(ServeMode { port: 8080, static_dir: None })
        );
    }

    #[test]
    fn a_task_that_mentions_web_is_not_server_mode() {
        // `web` is position-1 only. Both of these are one-shot tasks and must
        // reach the model; hijacking them would silently start a server instead
        // of answering.
        assert_eq!(serve_mode(&argv(&["web scraping help"])), None);
        assert_eq!(serve_mode(&argv(&["explain", "web", "sockets"])), None);
        assert_eq!(serve_mode(&argv(&["do X"])), None);
        assert_eq!(serve_mode(&argv(&[])), None);
    }

    #[test]
    fn remote_deployed_flag_is_documented_and_recognised() {
        // The flag is the CLI-side twin of GWORK_REMOTE_DEPLOYED. Help that does
        // not mention it leaves the remote deployment chain's only documented
        // switch undiscoverable.
        assert!(help_text().contains("--remote-deployed"));
        assert!(help_text().contains("GWORK_REMOTE_DEPLOYED"));
        assert!(help_text().contains("gwork web"));
        // It must not be mistaken for help/version, nor for server mode on its own.
        assert_eq!(early_exit(&argv(&["--remote-deployed"])), None);
        assert_eq!(serve_mode(&argv(&["--remote-deployed"])), None);
        // Combined with `web` it is the exact shape the deployment chain launches.
        assert_eq!(
            serve_mode(&argv(&["web", "18080", "--remote-deployed"])),
            Some(ServeMode { port: 18080, static_dir: None })
        );
    }

    #[test]
    fn the_first_matching_flag_wins() {
        assert_eq!(early_exit(&argv(&["--version", "--help"])), Some(EarlyExit::Version));
        assert_eq!(early_exit(&argv(&["--help", "--version"])), Some(EarlyExit::Help));
        // A flag after a real mode still wins: `--serve 8080 --help` should
        // explain itself rather than bind a port and block.
        assert_eq!(early_exit(&argv(&["--serve", "8080", "--help"])), Some(EarlyExit::Help));
    }

    #[test]
    fn version_text_reports_the_workspace_version_with_no_suffix() {
        // cli/Cargo.toml sets `version.workspace = true`, so CARGO_PKG_VERSION
        // *is* [workspace.package].version — the single source of truth.
        let v = env!("CARGO_PKG_VERSION");
        assert_eq!(version_text(), format!("gwork {v}"));
        // The value this replaced was a hardcoded "0.4.0-rust": a suffix the
        // installer filename never carried, which is exactly how the two
        // drifted apart. Assert the shape, not a specific number.
        assert!(v.chars().all(|c| c.is_ascii_digit() || c == '.'), "not plain semver: {v}");
        assert_eq!(v.split('.').count(), 3, "expected major.minor.patch, got {v}");
    }

    #[test]
    fn help_documents_every_mode_the_parser_recognises() {
        // Help that lies is worse than no help: a user who reads it and types
        // what it says must reach a real code path.
        let h = help_text();
        for needle in [
            "--serve", "--static", "--home", "acp", "web", "--help", "--version",
            "GWORK_HOME", "RUST_LOG",
        ] {
            assert!(h.contains(needle), "--help must document {needle}");
        }
        assert!(h.contains(env!("CARGO_PKG_VERSION")), "--help must carry the version");
    }

    #[test]
    fn help_and_version_agree_on_the_version() {
        let v = env!("CARGO_PKG_VERSION");
        assert!(help_text().starts_with(&format!("gwork {v}")), "{}", help_text());
        assert_eq!(version_text(), format!("gwork {v}"));
    }

    #[test]
    fn help_body_is_flush_left_with_headers_at_column_zero() {
        // The literal is deliberately flush-left: a `\`-continued string that
        // kept the source indentation would print every line indented, and
        // re-indenting at runtime is how help text acquires stray spaces.
        assert!(HELP_BODY.starts_with("USAGE:"), "must not open with a blank/indented line");
        for header in ["USAGE:", "OPTIONS:", "ENVIRONMENT:"] {
            assert!(
                HELP_BODY.lines().any(|l| l == header),
                "{header} must sit at column 0 on its own line"
            );
        }
        assert!(!HELP_BODY.contains('\t'), "no tabs: they render at unpredictable widths");
        for line in HELP_BODY.lines() {
            assert_eq!(line, line.trim_end(), "trailing whitespace in help: {line:?}");
        }
    }
}
