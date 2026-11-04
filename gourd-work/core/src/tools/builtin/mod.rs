//! Built-in tools: read, write, edit, bash, glob, grep, ls, todo, ask_user, memory, skills, etc.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;
use tokio::process::Command;
use tokio::sync::Mutex;

use super::registry::{Tool, ToolContext, ToolOutput};

// ─── Blocking-pool helper ─────────────────────────────────────────────────────

/// Run a synchronous, potentially long file-system operation on tokio's
/// dedicated blocking pool instead of the async worker that is currently
/// executing the tool.
///
/// Tools are invoked from the ReAct loop with `.await` on a tokio worker. A
/// synchronous directory walk or a multi-megabyte read performed inline there
/// blocks that worker for its whole duration, and since the worker also serves
/// HTTP requests, **every unrelated endpoint stalls with it**. That is exactly
/// how the usage endpoint once turned a 1 ms `/web/chat/meta` into a 2178 ms
/// one. The blocking pool exists for this and has its own threads, so async
/// handlers keep making progress.
///
/// A panic inside the closure is converted into a tool error rather than
/// propagated: `JoinError` from a panicked task would otherwise surface as an
/// opaque failure, and a tool that crashes should degrade to a message the
/// model can react to.
async fn run_blocking<F>(f: F) -> ToolOutput
where
    F: FnOnce() -> ToolOutput + Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(out) => out,
        Err(e) => ToolOutput::err(format!("operation failed: {}", e)),
    }
}

// ─── Path safety ──────────────────────────────────────────────────────────────

/// Resolve a (possibly relative) path against the workspace root.
/// Returns None if the resolved path escapes the workspace.
fn resolve_safe(workspace: &Path, raw: &str) -> Option<PathBuf> {
    resolve_safe_with(workspace, &[], raw)
}

/// [`resolve_safe`] plus extra **read-only** roots that are allowed to sit outside
/// the workspace.
///
/// Why this exists: session attachments live in `<sessionDir>/uploads/`, and the
/// session directory is in the harness home (`~/.gwork/sessions/<sid>`) — never
/// inside the workspace. The chat input hands the model a session-relative
/// reference (`[附件: uploads/report.pdf]`, Java `WebGate.java:747`), so a
/// workspace-only resolver can never reach those bytes. Measured before this
/// change: `read("uploads/x.txt")` and `read("x.txt")` both answered
/// `File not found`, i.e. every file attachment was unreachable in principle.
///
/// This mirrors Java's `TalentRegistry.trustedReadRoots` +
/// `TerminalSupport.resolveSafePath:799` (`trustedRead = !writeMode &&
/// isTrustedReadPath(realTarget)`): an explicit allow-list of roots outside the
/// sandbox boundary. Same discipline here — **read-only**, so `write`/`edit`
/// pass an empty list and cannot be talked into writing outside the workspace.
fn resolve_safe_with(workspace: &Path, extra_read_roots: &[PathBuf], raw: &str) -> Option<PathBuf> {
    let p = Path::new(raw);
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        // A session-relative reference (`uploads/x.png`) resolves against the
        // session directory, not the workspace; everything else keeps the
        // workspace as its base.
        match session_relative_root(extra_read_roots, raw) {
            Some(base) => base.join(p),
            None => workspace.join(p),
        }
    };
    // Normalize: reject any component that would escape via ".."
    let mut normalized = PathBuf::new();
    for comp in abs.components() {
        match comp {
            std::path::Component::ParentDir => {
                if !normalized.pop() {
                    return None;
                }
            }
            std::path::Component::CurDir => {}
            other => normalized.push(other),
        }
    }
    // Workspace containment check (case-insensitive on Windows)
    let ws = normalize_case(workspace);
    let target = normalize_case(&normalized);
    if target.starts_with(&ws) {
        return Some(normalized);
    }
    // Fall back to the extra read-only roots. Compared case-insensitively on
    // Windows, exactly like the workspace check above, or `C:\Users\...` vs
    // `c:\users\...` would spuriously fail containment.
    for root in extra_read_roots {
        let r = normalize_case(root);
        if target.starts_with(&r) {
            return Some(normalized);
        }
    }
    None
}

/// The base directory a **session-relative** path should resolve against.
///
/// Only the `uploads/` prefix qualifies: that is the single legal shape for an
/// attachment reference (`attachments::resolve_attachment_path` enforces the same
/// rule), so this never widens access to arbitrary absolute-looking paths.
fn session_relative_root(extra_read_roots: &[PathBuf], raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim_start_matches("./");
    let prefix = format!("{}/", crate::attachments::UPLOADS_DIR);
    if !trimmed.starts_with(&prefix) {
        return None;
    }
    // extra_read_roots holds `<sessionDir>/uploads`; the reference is relative to
    // `<sessionDir>`, so hand back its parent.
    extra_read_roots
        .first()
        .and_then(|uploads| uploads.parent())
        .map(|p| p.to_path_buf())
}

fn normalize_case(p: &Path) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(p.to_string_lossy().to_lowercase())
    } else {
        p.to_path_buf()
    }
}

/// Read-only roots outside the workspace that this invocation may reach.
///
/// Currently just the session's `uploads/` directory, so a file attachment the
/// user dropped in (`[附件: uploads/x.pdf]`) is actually readable by the model.
/// **Only read-only tools may pass this** — `write`/`edit` keep the strict
/// workspace boundary, matching Java where `trustedRead` is gated on
/// `!writeMode` (`TerminalSupport.resolveSafePath:799`).
fn readonly_extra_roots(ctx: &ToolContext) -> Vec<PathBuf> {
    ctx.session_dir
        .as_ref()
        .map(|dir| vec![crate::attachments::uploads_dir(dir)])
        .unwrap_or_default()
}

/// Read a file with encoding fallback (UTF-8 → GBK for legacy Windows files).
fn read_file_lossy(path: &Path) -> std::io::Result<String> {
    let bytes = std::fs::read(path)?;
    match std::str::from_utf8(&bytes) {
        Ok(s) => Ok(s.to_string()),
        Err(_) => {
            let (decoded, _, _) = encoding_rs::GBK.decode(&bytes);
            Ok(decoded.into_owned())
        }
    }
}

/// Detect the dominant line ending of a file's content.
fn detect_eol(content: &str) -> &'static str {
    if content.contains("\r\n") { "\r\n" } else { "\n" }
}

// ─── read ─────────────────────────────────────────────────────────────────────

/// read 单张图片内联上限（字节）。base64 后约膨胀 4/3 倍进入模型上下文，
/// 4MB 原图 ≈ 5.3MB base64；超限明确报错引导压缩或改走附件通道，
/// 而不是静默丢弃图片让模型以为"看到了"。与 Java 内核 MAX_IMAGE_READ_BYTES 同值。
pub(crate) const MAX_IMAGE_READ_BYTES: u64 = 4 * 1024 * 1024;

/// 视觉模型可读的图片扩展名（不含 svg：主流视觉模型不接受矢量格式）。
/// 与附件通道支持的图片集合对齐。
fn image_mime_of(path: &std::path::Path) -> Option<&'static str> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_lowercase();
    if name.ends_with(".png") {
        Some("image/png")
    } else if name.ends_with(".jpg") || name.ends_with(".jpeg") {
        Some("image/jpeg")
    } else if name.ends_with(".gif") {
        Some("image/gif")
    } else if name.ends_with(".webp") {
        Some("image/webp")
    } else if name.ends_with(".bmp") {
        Some("image/bmp")
    } else {
        None
    }
}

/// 读图片为 data URL（视觉通道）。None = 超上限，由调用方决定降级文案。
fn read_image_data_url(path: &std::path::Path) -> Result<Option<String>, std::io::Error> {
    use base64::Engine;
    let len = std::fs::metadata(path)?.len();
    if len > MAX_IMAGE_READ_BYTES {
        return Ok(None);
    }
    let bytes = std::fs::read(path)?;
    let mime = image_mime_of(path).unwrap_or("image/png");
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(Some(format!("data:{};base64,{}", mime, b64)))
}

pub struct ReadTool;

#[async_trait]
impl Tool for ReadTool {
    fn name(&self) -> &str { "read" }
    fn description(&self) -> &str {
        "Read file content. Supports offset/limit for pagination. Use before editing to confirm current content. For image files (png/jpg/jpeg/gif/webp/bmp) returns the visual content the model can see."
    }
    fn readonly(&self) -> bool { true }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "Relative path from workspace root ('.' = root)"},
                "offset": {"type": "integer", "description": "Start line (1-based), default 1"},
                "limit": {"type": "integer", "description": "Max lines to read"}
            },
            "required": ["file_path"]
        })
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolOutput {
        let raw = args["file_path"].as_str().unwrap_or_default();
        let Some(path) = resolve_safe_with(&ctx.workspace, &readonly_extra_roots(ctx), raw) else {
            return ToolOutput::err(format!("Path escapes workspace: {}", raw));
        };
        if !path.exists() {
            return ToolOutput::err(format!("File not found: {}", raw));
        }
        if path.is_dir() {
            return ToolOutput::err(format!("Is a directory: {}", raw));
        }
        // 视觉通道：图片不是文本，但模型能"看"——返回图片内容随观测一起入站。
        // 必须放在文本读取之前（读字节对图片文件无意义）。
        if let Some(mime) = image_mime_of(&path) {
            return match read_image_data_url(&path) {
                Ok(Some(data_url)) => ToolOutput::ok_with_images(
                    format!(
                        "--- Image: {} (Size: {:.2} KB, MIME: {}) ---\n该图片内容已作为视觉块随本结果附上，请直接依据图像内容分析与回答。",
                        raw,
                        std::fs::metadata(&path).map(|m| m.len() as f64 / 1024.0).unwrap_or(0.0),
                        mime
                    ),
                    vec![data_url],
                ),
                Ok(None) => ToolOutput::err(format!(
                    "错误：图片超过单次读取上限 {}MB。请先压缩或改走附件通道，不要对同一文件重试 read。",
                    MAX_IMAGE_READ_BYTES / 1024 / 1024
                )),
                Err(e) => ToolOutput::err(format!("Read failed: {}", e)),
            };
        }
        let content = match read_file_lossy(&path) {
            Ok(c) => c,
            Err(e) => return ToolOutput::err(format!("Read failed: {}", e)),
        };
        let offset = args["offset"].as_u64().unwrap_or(1).max(1) as usize;
        let limit = args["limit"].as_u64().unwrap_or(0) as usize;
        let lines: Vec<&str> = content.lines().collect();
        let total = lines.len();
        if total == 0 {
            return ToolOutput::ok(format!("--- {} (empty file) ---", raw));
        }
        let start = (offset - 1).min(total);
        let end = if limit == 0 { total } else { (start + limit).min(total) };
        let selected: Vec<String> = lines[start..end]
            .iter()
            .enumerate()
            .map(|(i, l)| format!("{:>5} | {}", start + i + 1, l))
            .collect();
        let header = format!("--- {} (Lines {}-{} of {}) ---\n", raw, start + 1, end, total);
        ToolOutput::ok(format!("{}{}", header, selected.join("\n")))
    }
}

// ─── write ────────────────────────────────────────────────────────────────────

pub struct WriteTool;

#[async_trait]
impl Tool for WriteTool {
    fn name(&self) -> &str { "write" }
    fn description(&self) -> &str {
        "Create a new file or overwrite an existing file with the given content."
    }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "file_path": {"type": "string"},
                "content": {"type": "string"}
            },
            "required": ["file_path", "content"]
        })
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolOutput {
        let raw = args["file_path"].as_str().unwrap_or_default();
        let content = args["content"].as_str().unwrap_or_default();
        let Some(path) = resolve_safe(&ctx.workspace, raw) else {
            return ToolOutput::err(format!("Path escapes workspace: {}", raw));
        };
        // Capture "before" state for the change ledger
        let before = ctx.change_ledger.as_ref().and_then(|ledger| {
            ledger.before(&ctx.session_id, &ctx.run_id, raw)
        });
        if let Some(parent) = path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return ToolOutput::err(format!("mkdir failed: {}", e));
            }
        }
        match std::fs::write(&path, content) {
            Ok(()) => {
                // Record the change (after state) in the ledger
                if let (Some(ledger), Some(before_state)) = (&ctx.change_ledger, before) {
                    let _ = ledger.record(&ctx.session_id, &ctx.run_id, raw, before_state);
                }
                ToolOutput::ok(format!("File written: {} ({} bytes)", raw, content.len()))
            }
            Err(e) => ToolOutput::err(format!("Write failed: {}", e)),
        }
    }
}

// ─── edit ─────────────────────────────────────────────────────────────────────

pub struct EditTool;

#[async_trait]
impl Tool for EditTool {
    fn name(&self) -> &str { "edit" }
    fn description(&self) -> &str {
        "Edit a file by replacing an exact text block. old_str must match uniquely (whitespace-trimmed line comparison). Preserves the file's original line endings."
    }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "file_path": {"type": "string"},
                "old_str": {"type": "string", "description": "Exact text to replace"},
                "new_str": {"type": "string", "description": "Replacement text"},
                "replace_all": {"type": "boolean", "description": "Replace all occurrences (default false)"}
            },
            "required": ["file_path", "old_str", "new_str"]
        })
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolOutput {
        let raw = args["file_path"].as_str().unwrap_or_default();
        let old_str = args["old_str"].as_str().unwrap_or_default();
        let new_str = args["new_str"].as_str().unwrap_or_default();
        let replace_all = args["replace_all"].as_bool().unwrap_or(false);
        let Some(path) = resolve_safe(&ctx.workspace, raw) else {
            return ToolOutput::err(format!("Path escapes workspace: {}", raw));
        };
        // Capture "before" state for the change ledger
        let before = ctx.change_ledger.as_ref().and_then(|ledger| {
            ledger.before(&ctx.session_id, &ctx.run_id, raw)
        });
        let content = match read_file_lossy(&path) {
            Ok(c) => c,
            Err(e) => return ToolOutput::err(format!("Read failed: {}", e)),
        };
        // Preserve the file's original line ending style.
        let eol = detect_eol(&content);
        // Whitespace-tolerant matching: compare trimmed lines
        let old_lines: Vec<&str> = old_str.lines().collect();
        let content_lines: Vec<&str> = content.lines().collect();
        if old_lines.is_empty() {
            return ToolOutput::err("old_str is empty");
        }
        let mut matches: Vec<usize> = Vec::new();
        if content_lines.len() >= old_lines.len() {
            for i in 0..=content_lines.len() - old_lines.len() {
                let window = &content_lines[i..i + old_lines.len()];
                if window.iter().zip(old_lines.iter()).all(|(a, b)| a.trim() == b.trim()) {
                    matches.push(i);
                }
            }
        }
        if matches.is_empty() {
            return ToolOutput::err("old_str not found in file");
        }
        if matches.len() > 1 && !replace_all {
            return ToolOutput::err(format!(
                "old_str matches {} locations; provide more context or set replace_all=true",
                matches.len()
            ));
        }
        // Rebuild content (apply replacements from bottom to top to keep indices valid)
        let new_lines: Vec<&str> = new_str.lines().collect();
        let mut result_lines: Vec<String> = content_lines.iter().map(|s| s.to_string()).collect();
        for &start in matches.iter().rev() {
            let end = start + old_lines.len();
            let mut replacement: Vec<String> = new_lines.iter().map(|s| s.to_string()).collect();
            result_lines.splice(start..end, replacement.drain(..));
        }
        let mut new_content = result_lines.join(eol);
        // Preserve trailing newline if original had one
        if content.ends_with('\n') && !new_content.ends_with('\n') {
            new_content.push_str(eol);
        }
        match std::fs::write(&path, &new_content) {
            Ok(()) => {
                if let (Some(ledger), Some(before_state)) = (&ctx.change_ledger, before) {
                    let _ = ledger.record(&ctx.session_id, &ctx.run_id, raw, before_state);
                }
                ToolOutput::ok(format!(
                    "Edited {} ({} replacement(s) at line {})",
                    raw,
                    matches.len(),
                    matches[0] + 1
                ))
            }
            Err(e) => ToolOutput::err(format!("Write failed: {}", e)),
        }
    }
}

// ─── bash ─────────────────────────────────────────────────────────────────────

/// Background bash session registry (for bash_output).
static BG_SESSIONS: once_cell::sync::Lazy<Mutex<HashMap<String, BgSession>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));

struct BgSession {
    output: Arc<Mutex<String>>,
    #[allow(dead_code)]
    done: Arc<tokio::sync::Notify>,
    finished: Arc<std::sync::atomic::AtomicBool>,
}

/// Commands/patterns considered dangerous and requiring HITL approval in default mode.
///
/// **Superseded by [`crate::hitl`].** This was a 20-entry substring blacklist
/// (`rm -rf`, `format `, `dd if=`, …) and it is kept only as a regression record:
/// it missed GNU long options (`rm --recursive`), reordered flags (`rm -v -r`),
/// xargs forms (`find … | xargs rm -rf`), command substitution
/// (`echo $(sudo rm -rf /)`), multi-line scripts and **every prefixed wrapper**
/// (`nohup rm -rf …`, `sudo rm -rf …` — `sudo` was not even in the list). It also
/// had no path axis at all, so `Set-Content D:\other-project\f.txt x` was silently
/// released. It false-positived too: `"format "` matched `git log --format=…`.
///
/// The gate below now calls [`crate::hitl::shape::evaluate`], which runs the Java
/// kernel's nine shape rules and then the workspace-boundary axis.
#[allow(dead_code)]
fn is_dangerous_command(cmd: &str) -> bool {
    let c = cmd.to_lowercase();
    let patterns = [
        "rm -rf", "rm -fr", "rmdir /s", "del /s", "del /q", "format ",
        "mkfs", "dd if=", "> /dev/", "shutdown", "reboot", "mkdisk",
        "remove-item -recurse", "remove-item -r ", "rd /s", "erase /s",
        "diskpart", "clear-disk", "reset-computer", "remove-adobject",
    ];
    patterns.iter().any(|p| c.contains(p))
}


// ─── PowerShell transport layer (Windows) ─────────────────────────────────────

/// PowerShell launch preamble: normalizes **output, input and file I/O**
/// encodings to UTF-8 for the whole execution.
///
/// Ported verbatim from Java `ShellCommandFactory.POWERSHELL_PREAMBLE`. Why not
/// just set `[Console]::OutputEncoding`: Windows PowerShell 5.1 makes at least
/// four independent encoding decisions, and fixing only one removes only part of
/// the garbling:
/// - engine output stream (`$OutputEncoding` / `[Console]::OutputEncoding`):
///   otherwise ANSI code page, and we decode as UTF-8.
/// - engine input stream (`[Console]::InputEncoding`): background sessions write
///   UTF-8, so a non-ASCII answer (e.g. Chinese confirmation) would be mangled.
/// - file **reads** (`Get-Content` / `Select-String` / `Import-Csv` default
///   `-Encoding`): 5.1's default is the ANSI code page, **not** UTF-8. This is
///   the hardest class — the corruption happens *inside* PowerShell, so the
///   bytes it hands us are perfectly valid UTF-8 and no decoder can fix them.
/// - file **writes** (`Set-Content` / `Add-Content` / `Out-File`, plus the
///   `>` / `>>` redirects): default is ANSI (drops emoji/CJK), while `>`
///   alone defaults to UTF-16LE. `Out-File:Encoding` also governs redirection.
///
/// A whitelist is used instead of `'*:Encoding'` because the wildcard hits every
/// cmdlet with an `-Encoding` parameter, some of which (e.g. Send-MailMessage)
/// take a `System.Text.Encoding` object and reject the string 'UTF8'.
///
/// Known trade-offs: `-Encoding UTF8` writes a BOM under 5.1 (accepted — a
/// removable prefix beats irreversible character loss), and reading defaults to
/// UTF-8, so genuine GBK files need an explicit `-Encoding Default`.
///
/// Robustness: `UTF8Encoding $false` rather than `[Text.Encoding]::UTF8` — the
/// latter carries a preamble and would emit a leading `\u{FEFF}`. Every
/// assignment is wrapped in try/catch: without a console handle these setters
/// throw IOException, and a first-line error must not leak into the stream.
const POWERSHELL_PREAMBLE: &str = "$OutputEncoding = New-Object System.Text.UTF8Encoding $false\r\n\
try { [Console]::OutputEncoding = $OutputEncoding } catch { }\r\n\
try { [Console]::InputEncoding = $OutputEncoding } catch { }\r\n\
try {\r\n\
  if ($null -eq $PSDefaultParameterValues) { $PSDefaultParameterValues = @{} }\r\n\
  foreach ($c in 'Get-Content','Set-Content','Add-Content','Out-File','Select-String','Import-Csv','Export-Csv') {\r\n\
    $PSDefaultParameterValues[($c + ':Encoding')] = 'UTF8'\r\n\
  }\r\n\
} catch { }\r\n";

/// Java `MAX_ENCODED_COMMAND_CHARS`: above this the base64 no longer fits the
/// command line reliably, so fall back to a script file.
const MAX_ENCODED_COMMAND_CHARS: usize = 24_000;

/// A ready-to-spawn PowerShell invocation: full argv plus the temp script to
/// clean up afterwards (`None` for the `-EncodedCommand` path).
pub(crate) struct PreparedPs {
    pub(crate) argv: Vec<std::ffi::OsString>,
    pub(crate) temp_script: Option<std::path::PathBuf>,
}

/// Build the PowerShell argv for `command`.
///
/// Mirrors Java `ShellCommandFactory::preparePowerShell` (`interactive == false`,
/// which is this kernel's situation: a resident service never lets the terminal
/// read stdin).
///
/// Prefer `-EncodedCommand` (Base64 of UTF-16LE): it bypasses code-page
/// translation, touches no file, is not subject to ExecutionPolicy, and keeps
/// exactly the same exit-code semantics as `-Command`. Only when the command is
/// too long for the command line does it fall back to a UTF-8-with-BOM `.ps1`
/// (`-File` needs policy approval and a command-line `-ExecutionPolicy Bypass`
/// can be overridden by GPO, so this is strictly the last resort).
///
/// Compared with the previous `-Command <raw>` this removes: outer early
/// evaluation of `$var`/backticks, dropped non-ASCII characters, failures on
/// over-long commands, and `Get-Content` mis-decoding UTF-8 sources.
///
/// Deliberately **not** `cfg!(windows)`-gated: it is a pure builder, so the
/// logic is unit-testable on any platform.
pub(crate) fn prepare_powershell(command: &str) -> std::io::Result<PreparedPs> {
    use base64::Engine;
    use std::ffi::OsString;

    let full = format!("{}{}", POWERSHELL_PREAMBLE, command);

    // UTF-16LE then Base64 — the byte sequence -EncodedCommand expects.
    let utf16: Vec<u8> = full.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(&utf16);

    if encoded.len() <= MAX_ENCODED_COMMAND_CHARS {
        return Ok(PreparedPs {
            argv: vec![
                OsString::from("powershell"),
                OsString::from("-NoProfile"),
                OsString::from("-NonInteractive"),
                OsString::from("-EncodedCommand"),
                OsString::from(encoded),
            ],
            temp_script: None,
        });
    }

    // Over-long fallback: write a .ps1. Windows PowerShell 5.1 relies on the BOM
    // to recognise UTF-8, so it must be written explicitly.
    let script = std::env::temp_dir().join(format!("gwork-script-{}.ps1", uuid::Uuid::new_v4()));
    let mut bytes = vec![0xEFu8, 0xBB, 0xBF];
    bytes.extend_from_slice(full.as_bytes());
    if let Err(e) = std::fs::write(&script, &bytes) {
        // Java deletes the file in its catch block before rethrowing; do the same
        // so a partial file cannot linger.
        let _ = std::fs::remove_file(&script);
        return Err(e);
    }

    Ok(PreparedPs {
        argv: vec![
            OsString::from("powershell"),
            OsString::from("-NoProfile"),
            OsString::from("-NonInteractive"),
            OsString::from("-ExecutionPolicy"),
            OsString::from("Bypass"),
            OsString::from("-File"),
            OsString::from(&script),
        ],
        temp_script: Some(script),
    })
}

/// Delete the temp script on scope exit.
///
/// Java hands `PreparedCommand` to a caller that must invoke `cleanup()`, which
/// is idempotent. Rust cannot enforce "the caller remembered", so the same intent
/// becomes a Drop guard: every early return in `execute` (cancel, timeout, spawn
/// failure, wait failure) then releases the file without repeating itself.
pub(crate) struct TempScriptGuard(Option<std::path::PathBuf>);

impl TempScriptGuard {
    /// Construct from an optional temp script produced by
    /// [`prepare_powershell`]. `None` (the `-EncodedCommand` path) makes the
    /// guard a no-op. Exposed crate-wide so `server::execute_approved_command`
    /// can reuse the exact same cleanup semantics as `BashTool::execute`.
    pub(crate) fn new(temp_script: Option<std::path::PathBuf>) -> Self {
        TempScriptGuard(temp_script)
    }
}

impl Drop for TempScriptGuard {
    fn drop(&mut self) {
        if let Some(p) = self.0.take() {
            let _ = std::fs::remove_file(p);
        }
    }
}

pub struct BashTool;

#[async_trait]
impl Tool for BashTool {
    fn name(&self) -> &str { "bash" }
    fn description(&self) -> &str {
        // Windows wording mirrors the system prompt's dialect block: the tool
        // name `bash` is itself a strong POSIX prior, so say plainly that this
        // is PowerShell 5.1 and that POSIX commands / `&&` do not exist here.
        // Both literals are &'static, so picking one at (const) compile time via
        // `if cfg!` keeps the signature a plain &str.
        if cfg!(windows) {
            "Execute a shell command in the workspace. The shell is Windows PowerShell 5.1, \
             NOT bash/sh: POSIX commands and syntax (including `&&`/`||`) are unavailable \
             — follow the shell dialect rules in the system prompt. \
             Set run_in_background=true for long tasks; use bash_output to check progress."
        } else {
            "Execute a shell command in the workspace. Uses sh on Unix. \
             Set run_in_background=true for long tasks; use bash_output to check progress."
        }
    }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "The command to execute"},
                "timeout": {"type": "integer", "description": "Timeout in milliseconds (default 120000)"},
                "run_in_background": {"type": "boolean", "description": "Run in background; returns a session_id"}
            },
            "required": ["command"]
        })
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolOutput {
        let command = args["command"].as_str().unwrap_or_default();
        if command.is_empty() {
            return ToolOutput::err("Empty command");
        }
        let timeout_ms = args["timeout"].as_u64().unwrap_or(120_000);
        let background = args["run_in_background"].as_bool().unwrap_or(false);

        // HITL approval gate: the shape axis (nine rules ported from Java
        // `HitlStrategy`) runs first and short-circuits; the workspace-boundary
        // axis (`BashPathGuard`) is the last gate. Java adjudicates in exactly
        // this order — irreversibility is more urgent than boundary crossing.
        //
        // `ctx.workspace` is the boundary. Java resolves it from the tool
        // context's `__cwd` (`HitlStrategy.java:465-487`); here it is a struct
        // field, which additionally means **the model cannot widen the boundary
        // through tool arguments** (Java locks this with
        // `modelSuppliedCwdCannotWidenBoundary`).
        if ctx.approval_required() && !ctx.hitl_approved {
            let exempt = crate::hitl::path_guard::resolve_exempt_dirs(&ctx.bash_exempt_dirs);
            if let Some(reason) =
                crate::hitl::shape::evaluate(command, Some(&ctx.workspace), &exempt)
            {
                // The reason is the approval card's body text in Java
                // (`HITLInterceptor.java:147-150`). `Frame::hitl` has no reason
                // field, so it is logged rather than dropped: extending the frame
                // would touch the WS protocol and two frontend files, which is a
                // separate change.
                tracing::warn!(target: "hitl", session = %ctx.session_id, reason = %reason, "bash gated");
                if let Some(tx) = &ctx.frame_tx {
                    // actionId must be this invocation's tool_call_id: the frontend
                    // stores it on the card and later matches the `hitl_released`
                    // frame against it. The literal "pending" this used to send never
                    // matched anything, so switching to full access left the approval
                    // card stuck in its clickable pending state.
                    let frame = crate::protocol::Frame::hitl(
                        &ctx.session_id,
                        "bash",
                        command,
                        ctx.action_id(),
                    );
                    let _ = tx.send(frame);
                }
                return ToolOutput::suspend_hitl(command);
            }
        }

        // Cooperative cancellation check before starting.
        if ctx.cancel.is_cancelled() {
            return ToolOutput::err("Cancelled");
        }

        // Build the command with correctly-split shell arguments.
        //
        // Windows goes through `prepare_powershell` (`-EncodedCommand`, or a
        // `.ps1` fallback when over-long), which eliminates `$var`/backtick
        // pre-evaluation by the outer shell, dropped non-ASCII characters,
        // over-long-command failures, and `Get-Content` mis-decoding UTF-8.
        // Unix keeps the direct `sh -c`.
        //
        // The HITL gate above adjudicates the **raw** command — encoding happens
        // only here, after approval, and never feeds back into a shape check.
        let mut temp_script: Option<std::path::PathBuf> = None;
        let mut cmd = if cfg!(windows) {
            let prepared = match prepare_powershell(command) {
                Ok(p) => p,
                Err(e) => return ToolOutput::err(format!("Failed to prepare PowerShell command: {}", e)),
            };
            temp_script = prepared.temp_script;
            let mut c = Command::new(&prepared.argv[0]);
            c.args(&prepared.argv[1..]);
            // GUI host: every agent bash call would otherwise flash a black
            // console window (console-subsystem child, no console parent).
            //
            // Attribute block, not a bare statement: `creation_flags` is behind
            // tokio's `cfg_windows!`, i.e. the method does not exist at all on a
            // non-Windows target. Inside `if cfg!(windows)` (a runtime `if`) both
            // arms are still type-checked, so an inline call breaks the
            // ubuntu-latest CI gate even though it never runs there. The attribute
            // is stripped before type checking — the same form `mcp/mod.rs` and
            // `gitops.rs` already use.
            #[cfg(windows)]
            {
                c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            }
            c
        } else {
            let mut c = Command::new("sh");
            c.arg("-c");
            c.arg(command);
            c
        };
        cmd.current_dir(&ctx.workspace);

        if background {
            // The task outlives `execute` (which returns a session id at once),
            // so ownership of the temp script moves to the background reader,
            // which deletes it after the child has exited. A guard here would
            // unlink the script before PowerShell ever loads it.
            return run_background(cmd, ctx, temp_script, command.to_string()).await;
        }
        // Synchronous path: every remaining return path is covered by Drop.
        let _guard = TempScriptGuard(temp_script);

        // Spawn by hand instead of `cmd.output()` so the child can be killed.
        //
        // `output()` returns no process handle, so the only way to abandon it was
        // to drop the future — and tokio's default `kill_on_drop(false)` then
        // leaves the process running as an orphan. The user-visible symptom was
        // "Stop does nothing": the run kept burning CPU and kept writing into the
        // workspace after the interrupt, and the timeout branch had the same hole.
        cmd.kill_on_drop(true);
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return ToolOutput::err(format!("Command spawn failed: {}", e)),
        };

        // Drain the pipes concurrently with the wait. Reading only after exit
        // deadlocks as soon as the child fills the OS pipe buffer and blocks on
        // write; `cmd.output()` did this internally, so spawning by hand has to
        // preserve it or long-output commands (cargo, mvn) would hang forever.
        let mut so = child.stdout.take();
        let mut se = child.stderr.take();
        let pipes = tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut out: Vec<u8> = Vec::new();
            let mut err: Vec<u8> = Vec::new();
            if let Some(s) = so.as_mut() {
                let _ = s.read_to_end(&mut out).await;
            }
            if let Some(s) = se.as_mut() {
                let _ = s.read_to_end(&mut err).await;
            }
            (out, err)
        });

        let status = tokio::select! {
            r = child.wait() => r,
            _ = ctx.cancel.cancelled() => {
                // Returning drops `child`; `kill_on_drop` reaps the process.
                return ToolOutput::err("Cancelled by user");
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(timeout_ms)) => {
                return ToolOutput::err(format!("Command timed out after {}ms", timeout_ms));
            }
        };

        let status = match status {
            Ok(s) => s,
            Err(e) => return ToolOutput::err(format!("Command wait failed: {}", e)),
        };
        let (stdout, stderr) = pipes.await.unwrap_or_else(|_| (Vec::new(), Vec::new()));
        // Rebuild `Output` so the existing truncation/exit-code formatting is
        // reused verbatim rather than duplicated here.
        format_output(&std::process::Output { status, stdout, stderr })
    }
}

fn format_output(output: &std::process::Output) -> ToolOutput {
    // Legacy Windows consoles emit GBK; lossy UTF-8 turned that into
    // replacement blocks in tool results (same defect class as the stream).
    let stdout = crate::textcodec::decode_bytes(&output.stdout);
    let stderr = crate::textcodec::decode_bytes(&output.stderr);
    // Strip ANSI colour codes **after** decoding, not on the bytes: the escape
    // introducer is 0x1B (ASCII), so it survives every encoding, but a CSI
    // sequence can sit between two halves of a multi-byte character's neighbours
    // and stripping on raw bytes would leave the SGR params behind as text.
    // See `textcodec::strip_ansi` for the real-world report this fixes.
    let stdout = crate::textcodec::strip_ansi(&stdout);
    let stderr = crate::textcodec::strip_ansi(&stderr);
    let mut text = String::new();
    if !stdout.is_empty() {
        text.push_str(&stdout);
    }
    if !stderr.is_empty() {
        if !text.is_empty() { text.push('\n'); }
        text.push_str("[stderr]\n");
        text.push_str(&stderr);
    }
    let code = output.status.code().unwrap_or(-1);
    if text.is_empty() {
        text = format!("[exit code: {}]", code);
    } else {
        text.push_str(&format!("\n[exit code: {}]", code));
    }
    // Truncate very long output (keep head + tail)
    if text.chars().count() > 64_000 {
        let head: String = text.chars().take(32_000).collect();
        let tail: String = text.chars().rev().take(16_000).collect::<Vec<_>>().into_iter().rev().collect();
        text = format!("{}\n... [truncated] ...\n{}", head, tail);
    }
    if output.status.success() {
        ToolOutput::ok(text)
    } else {
        ToolOutput::err(text)
    }
}

async fn run_background(
    mut cmd: Command,
    ctx: &ToolContext,
    temp_script: Option<std::path::PathBuf>,
    command_line: String,
) -> ToolOutput {
    let session_id = format!("bg-{}", &uuid::Uuid::new_v4().to_string()[..8]);
    // P3: register as running BEFORE the spawn can complete (the task can
    // finish inside the yield window; registering after would leave a phantom
    // "running" that keeps the owner's gate armed forever). Keyed by the
    // session id, unregistered by the same key in the reader task below.
    crate::react::bg_gate::register_running(&ctx.session_id, &session_id).await;
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            if let Some(p) = temp_script {
                let _ = std::fs::remove_file(p);
            }
            return ToolOutput::err(format!("Background spawn failed: {}", e));
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let buf = Arc::new(Mutex::new(String::new()));
    let done = Arc::new(tokio::sync::Notify::new());
    let finished = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let buf2 = buf.clone();
    let done2 = done.clone();
    let fin2 = finished.clone();
    // P3: the completion notice is published from this same reader task, so
    // registration and unregistration are structurally paired — whichever
    // path the process exit takes, this task is the one that observed it.
    let owner_for_notice = ctx.session_id.clone();
    let sid_for_notice = session_id.clone();
    let cmd_for_notice = command_line;
    // Ownership of the temp script moves into the reader task itself, whose
    // guard is dropped only after `child.wait().await` below — deleting it any
    // earlier could race with PowerShell still loading the file. (The outer
    // future returns the instant the session is registered, so a guard declared
    // there would unlink the script before the child started.)
    let script_guard = TempScriptGuard(temp_script);
    tokio::spawn(async move {
        let _script_guard = script_guard;
        use tokio::io::AsyncReadExt;
        let mut combined = String::new();
        if let Some(mut so) = stdout {
            let mut s = String::new();
            let _ = so.read_to_string(&mut s).await;
            combined.push_str(&s);
        }
        if let Some(mut se) = stderr {
            let mut s = String::new();
            let _ = se.read_to_string(&mut s).await;
            if !s.is_empty() {
                combined.push_str("\n[stderr]\n");
                combined.push_str(&s);
            }
        }
        // 后台任务同 format_output：ANSI 颜色码在 UI 里只会变成字面量 `[31m`。
        // 这里是 read_to_string（非 decode_bytes），但 ESC 是 ASCII，不影响其后的
        // 多字节字符，直接对字符串处理即可。
        let mut combined = crate::textcodec::strip_ansi(&combined);
        let status = child.wait().await;
        let code = status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
        combined.push_str(&format!("\n[exit code: {}]", code));
        *buf2.lock().await = combined;
        fin2.store(true, std::sync::atomic::Ordering::SeqCst);
        done2.notify_waiters();
        // P3: completion notice + gate release. The tail is capped because the
        // notice is re-sent with the history on every subsequent turn (Java
        // renders the same way for the same reason).
        let tail: String = buf2.lock().await.chars().rev().take(800).collect::<Vec<_>>().into_iter().rev().collect();
        let notice = crate::react::bg_gate::render_bash_notice(
            &sid_for_notice,
            &cmd_for_notice,
            code,
            &tail,
        );
        crate::react::bg_gate::publish(&owner_for_notice, notice).await;
        crate::react::bg_gate::unregister_running(&sid_for_notice).await;
    });

    BG_SESSIONS.lock().await.insert(session_id.clone(), BgSession {
        output: buf,
        done,
        finished,
    });

    ToolOutput::ok(format!(
        "Background task started. session_id={}\nUse bash_output to check progress.",
        session_id
    ))
}

// ─── bash_output ──────────────────────────────────────────────────────────────

pub struct BashOutputTool;

#[async_trait]
impl Tool for BashOutputTool {
    fn name(&self) -> &str { "bash_output" }
    fn description(&self) -> &str {
        "Check the output/status of a background bash task started with run_in_background=true."
    }
    fn readonly(&self) -> bool { true }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "session_id": {"type": "string", "description": "The session_id returned by bash"}
            },
            "required": ["session_id"]
        })
    }
    async fn execute(&self, args: serde_json::Value, _ctx: &ToolContext) -> ToolOutput {
        let sid = args["session_id"].as_str().unwrap_or_default();
        let sessions = BG_SESSIONS.lock().await;
        let Some(sess) = sessions.get(sid) else {
            return ToolOutput::err(format!("Unknown background session: {}", sid));
        };
        let finished = sess.finished.load(std::sync::atomic::Ordering::SeqCst);
        let output = sess.output.lock().await.clone();
        if finished {
            ToolOutput::ok(format!("[finished]\n{}", output))
        } else if output.is_empty() {
            ToolOutput::ok("[running] (no output yet)")
        } else {
            ToolOutput::ok(format!("[running]\n{}", output))
        }
    }
}

// ─── glob ─────────────────────────────────────────────────────────────────────

pub struct GlobTool;

#[async_trait]
impl Tool for GlobTool {
    fn name(&self) -> &str { "glob" }
    fn description(&self) -> &str {
        "Find files by glob pattern (e.g. **/*.rs). Returns matching file paths."
    }
    fn readonly(&self) -> bool { true }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Glob pattern like **/*.java"},
                "path": {"type": "string", "description": "Directory to search in (default: workspace root)"}
            },
            "required": ["pattern"]
        })
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolOutput {
        let pattern = args["pattern"].as_str().unwrap_or_default().to_string();
        let base = args["path"].as_str().unwrap_or(".").to_string();
        let base_path = match resolve_safe_with(&ctx.workspace, &readonly_extra_roots(ctx), &base) {
            Some(p) => p,
            None => return ToolOutput::err("Invalid path"),
        };
        let workspace = ctx.workspace.clone();
        // The walk is unbounded synchronous I/O. Running it inline on a tokio
        // worker starves every other request on that worker — the same failure
        // mode the usage endpoint had. Hand it to the blocking pool instead.
        run_blocking(move || glob_sync(&pattern, &base_path, &workspace)).await
    }
}

/// Synchronous body of the `glob` tool (runs on the blocking pool).
fn glob_sync(pattern: &str, base_path: &std::path::Path, workspace: &std::path::Path) -> ToolOutput {
    let full_pattern = base_path.join(pattern).to_string_lossy().replace('\\', "/");
    let mut matches: Vec<String> = Vec::new();
    for entry in glob::glob(&full_pattern).into_iter().flatten().flatten() {
        if let Ok(rel) = entry.strip_prefix(workspace) {
            matches.push(rel.to_string_lossy().replace('\\', "/"));
        } else {
            matches.push(entry.to_string_lossy().replace('\\', "/"));
        }
        if matches.len() >= 500 {
            matches.push("... (truncated at 500)".into());
            break;
        }
    }
    if matches.is_empty() {
        ToolOutput::ok("No files matched the pattern.")
    } else {
        ToolOutput::ok(matches.join("\n"))
    }
}

// ─── grep ─────────────────────────────────────────────────────────────────────

pub struct GrepTool;

#[async_trait]
impl Tool for GrepTool {
    fn name(&self) -> &str { "grep" }
    fn description(&self) -> &str {
        "Search file contents by regex. Returns 'path:line:content' matches."
    }
    fn readonly(&self) -> bool { true }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Regex pattern to search"},
                "path": {"type": "string", "description": "Directory to search (default: workspace root)"},
                "include": {"type": "string", "description": "File filter like *.rs"}
            },
            "required": ["pattern"]
        })
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolOutput {
        let pattern = args["pattern"].as_str().unwrap_or_default();
        let base = args["path"].as_str().unwrap_or(".").to_string();
        let include = args["include"].as_str().unwrap_or("").to_string();
        let re = match regex::Regex::new(pattern) {
            Ok(r) => r,
            Err(e) => return ToolOutput::err(format!("Invalid regex: {}", e)),
        };
        let base_path = match resolve_safe_with(&ctx.workspace, &readonly_extra_roots(ctx), &base) {
            Some(p) => p,
            None => return ToolOutput::err("Invalid path"),
        };
        let workspace = ctx.workspace.clone();
        // Unbounded synchronous walk + file reads. Inline on a tokio worker this
        // starves every concurrent request; on the blocking pool it is merely
        // slow. See `grep_sync` for the visit cap that keeps it bounded.
        run_blocking(move || grep_sync(re, &base_path, &include, &workspace)).await
    }
}

/// Hard cap on directory entries visited by one `grep` call.
///
/// The 200-match cap below only fires **when matches are found**. A pattern that
/// matches nothing — the common case for a typo, or for probing whether a symbol
/// exists — walked the entire tree and read every file under 1 MB before
/// returning "No matches found.". On a large workspace that is minutes of I/O
/// per call, and since the agent may retry, it is effectively unbounded work.
/// Moving to the blocking pool contains the damage but does not bound it: the
/// pool has a finite number of threads and a queue, so enough concurrent greps
/// would still stall every other blocking task (session deletion, usage
/// archiving, settings reads).
const GREP_MAX_VISITED: usize = 20_000;

/// Synchronous body of the `grep` tool (runs on the blocking pool).
fn grep_sync(
    re: regex::Regex,
    base_path: &std::path::Path,
    include: &str,
    workspace: &std::path::Path,
) -> ToolOutput {
    grep_sync_capped(re, base_path, include, workspace, GREP_MAX_VISITED)
}

/// `grep_sync` with an explicit visit cap. Split out so the cap can be tested
/// with a handful of files instead of twenty thousand.
fn grep_sync_capped(
    re: regex::Regex,
    base_path: &std::path::Path,
    include: &str,
    workspace: &std::path::Path,
    max_visited: usize,
) -> ToolOutput {
    let mut results: Vec<String> = Vec::new();
    let include_glob = if include.is_empty() { None } else { glob::Pattern::new(include).ok() };
    let mut visited = 0usize;
    let mut truncated_by_cap = false;

    for entry in walkdir::WalkDir::new(base_path)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        visited += 1;
        if visited > max_visited {
            truncated_by_cap = true;
            break;
        }
        if !entry.file_type().is_file() { continue; }
        let path = entry.path();
        // Skip hidden dirs and common build/dependency dirs
        if path.components().any(|c| {
            let s = c.as_os_str().to_string_lossy();
            s.starts_with('.') || s == "node_modules" || s == "target"
        }) { continue; }
        if let Some(ref g) = include_glob {
            let fname = path.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
            if !g.matches(&fname) { continue; }
        }
        // Size limit: skip files > 1MB
        if entry.metadata().map(|m| m.len() > 1_048_576).unwrap_or(true) { continue; }
        let content = match read_file_lossy(path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        for (i, line) in content.lines().enumerate() {
            if re.is_match(line) {
                let rel = path.strip_prefix(workspace)
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_else(|_| path.to_string_lossy().to_string());
                results.push(format!("{}:{}:{}", rel, i + 1, line.trim()));
                if results.len() >= 200 {
                    results.push("... (truncated at 200)".into());
                    return ToolOutput::ok(results.join("\n"));
                }
            }
        }
    }

    if truncated_by_cap {
        // Say so explicitly: a silent partial scan reads as "the symbol does not
        // exist", which sends the agent down the wrong path.
        results.push(format!(
            "... (search stopped after visiting {} entries; narrow `path` or add `include` to search deeper)",
            max_visited
        ));
    }
    if results.is_empty() {
        ToolOutput::ok("No matches found.")
    } else {
        ToolOutput::ok(results.join("\n"))
    }
}

// ─── ls ───────────────────────────────────────────────────────────────────────

pub struct LsTool;

#[async_trait]
impl Tool for LsTool {
    fn name(&self) -> &str { "ls" }
    fn description(&self) -> &str {
        "List directory contents. Supports recursive tree view."
    }
    fn readonly(&self) -> bool { true }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Directory path (default: workspace root)"},
                "recursive": {"type": "boolean", "description": "Show tree structure"},
                "show_hidden": {"type": "boolean", "description": "Include hidden files"}
            },
            "required": []
        })
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolOutput {
        let base = args["path"].as_str().unwrap_or(".");
        let recursive = args["recursive"].as_bool().unwrap_or(false);
        let show_hidden = args["show_hidden"].as_bool().unwrap_or(false);
        let base_path = match resolve_safe_with(&ctx.workspace, &readonly_extra_roots(ctx), base) {
            Some(p) => p,
            None => return ToolOutput::err("Invalid path"),
        };
        if !base_path.is_dir() {
            return ToolOutput::err(format!("Not a directory: {}", base));
        }
        let mut output = Vec::new();
        if recursive {
            Self::tree(&base_path, "", &mut output, 0, 5, show_hidden);
        } else {
            let mut entries: Vec<_> = std::fs::read_dir(&base_path)
                .into_iter().flatten().flatten()
                .collect();
            entries.sort_by_key(|e| e.file_name());
            for e in entries {
                let name = e.file_name().to_string_lossy().to_string();
                if !show_hidden && name.starts_with('.') { continue; }
                let suffix = if e.path().is_dir() { "/" } else { "" };
                output.push(format!("[{}] {}{}", if e.path().is_dir() { "DIR" } else { "FILE" }, name, suffix));
            }
        }
        if output.is_empty() {
            ToolOutput::ok("(empty directory)")
        } else {
            ToolOutput::ok(output.join("\n"))
        }
    }
}

impl LsTool {
    fn tree(dir: &Path, prefix: &str, out: &mut Vec<String>, depth: usize, max_depth: usize, show_hidden: bool) {
        if depth >= max_depth { return; }
        let mut entries: Vec<_> = std::fs::read_dir(dir)
            .into_iter().flatten().flatten()
            .filter(|e| show_hidden || !e.file_name().to_string_lossy().starts_with('.'))
            .collect();
        entries.sort_by_key(|e| (e.path().is_file(), e.file_name()));
        for (i, e) in entries.iter().enumerate() {
            let is_last = i == entries.len() - 1;
            let connector = if is_last { "└── " } else { "├── " };
            let name = e.file_name().to_string_lossy().to_string();
            let suffix = if e.path().is_dir() { "/" } else { "" };
            out.push(format!("{}{}{}{}", prefix, connector, name, suffix));
            if e.path().is_dir() {
                let new_prefix = format!("{}{}", prefix, if is_last { "    " } else { "│   " });
                Self::tree(&e.path(), &new_prefix, out, depth + 1, max_depth, show_hidden);
            }
        }
    }
}

// ─── todowrite / todoread ─────────────────────────────────────────────────────

pub struct TodoWriteTool;

#[async_trait]
impl Tool for TodoWriteTool {
    fn name(&self) -> &str { "todowrite" }
    fn description(&self) -> &str {
        "Write/replace the task checklist (Markdown with checkboxes). Use for multi-step complex tasks."
    }
    fn parameters_schema(&self) -> serde_json::Value {
        // `anyOf` rather than a bare `string`: the structured array is the
        // primary contract now. A string-only schema is what taught models to
        // stringify their natural object-array output into envelopes, and the
        // envelope is the defect this whole module exists to repair.
        json!({
            "type": "object",
            "properties": {
                "todos": {
                    "description": crate::todo::PARAM_TODOS_DESC,
                    "anyOf": [
                        {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "content": {"type": "string", "description": "Task text."},
                                    "status": {"type": "string", "enum": ["pending", "in_progress", "done"]},
                                    "header": {"type": "string", "description": "Optional section heading this task belongs to."},
                                    "group": {"type": "string", "description": "Alias of header."}
                                },
                                "required": ["content"]
                            }
                        },
                        {"type": "string"}
                    ]
                }
            },
            "required": ["todos"]
        })
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolOutput {
        // Resolve through the shared helper so the write lands wherever
        // `/web/chat/todos` will read it back (session dir when available).
        let todo_file = ctx.todo_file();

        // Accept both contract shapes: a JSON array of item objects (primary)
        // and a raw Markdown string (legacy, still produced by older prompts
        // and by models that stringify). Anything else is stringified the way
        // the model wrote it and left to the normaliser below.
        let raw_arg = match args.get("todos") {
            Some(v) if v.is_array() => v.to_string(),
            Some(v) if v.is_string() => v.as_str().unwrap_or_default().to_string(),
            Some(v) => v.to_string(),
            None => String::new(),
        };

        // Normalise before judging emptiness or writing: an argument that is a
        // JSON envelope, or a list whose newlines collapsed to literal `\n`,
        // repairs into a multi-line checklist here. See `crate::todo`.
        let content = crate::todo::sanitize_todo_markdown(&raw_arg);

        // 【空入参不得落盘·勿删】Writing an empty `content` as normal would
        // truncate the existing TODO.md to nothing; and because `content` is
        // empty, both the format warning and the continue/finish push get
        // skipped, so the model receives a cheerful "TODO saved." with total: 0 —
        // list destroyed, progress zeroed, success reported. That is the worst
        // combination available, and it is reachable from one malformed call.
        // An empty argument is therefore an invalid input: leave the disk alone
        // and return the format requirement to the model.
        if content.is_empty() {
            return ToolOutput::err(format!(
                "{}{}",
                crate::todo::NOT_SAVED_EMPTY,
                crate::todo::FORMAT_WARN
            ));
        }

        if let Some(parent) = todo_file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        // Trailing newline so a single-line checklist still ends its last line;
        // `/web/chat/todos` splits on `\n` and a unterminated tail is dropped.
        let body = if content.ends_with('\n') {
            content.clone()
        } else {
            format!("{}\n", content)
        };
        match std::fs::write(&todo_file, &body) {
            Ok(()) => {
                // Counted with the kernel's single strict rule, so the figure the
                // model reads here and the figure `/web/chat/todos` reports to the
                // panel can no longer disagree about the same file.
                let progress = crate::todo::measure(&body);
                let mut out = String::from("TODO saved.");
                out.push_str(&crate::todo::progress_footer(&progress));
                // The bug this guards against: `total == 0` used to fall through to
                // "[继续] 还有未完成事项" — an unsatisfiable command that ran the
                // session to max_turns. Report the real problem instead.
                if progress.total == 0 {
                    out.push_str(crate::todo::FORMAT_WARN);
                }
                ToolOutput::ok(out)
            }
            Err(e) => ToolOutput::err(format!("Failed to write TODO: {}", e)),
        }
    }
}

pub struct TodoReadTool;

#[async_trait]
impl Tool for TodoReadTool {
    fn name(&self) -> &str { "todoread" }
    fn description(&self) -> &str { "读取任务清单。用于同步执行进度，确认下一步操作。" }
    fn readonly(&self) -> bool { true }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({"type": "object", "properties": {}, "required": []})
    }
    async fn execute(&self, _args: serde_json::Value, ctx: &ToolContext) -> ToolOutput {
        let todo_file = ctx.todo_file();
        match std::fs::read_to_string(&todo_file) {
            // Same footer as `todowrite`: the model decides whether it may stop
            // from that footer alone, so both tools must state it identically.
            Ok(content) => {
                // Read-side self-healing: a checklist stored as a JSON envelope
                // by an older kernel parses to zero tasks, so the model would
                // read "[] empty" and rebuild from scratch, losing the stored
                // state. Heal once, on the spot, and answer with the repaired
                // list — the same bytes the panel will see from now on.
                let content = match crate::todo::heal_content(&content) {
                    Some(healed) => {
                        let body = if healed.ends_with('\n') {
                            healed.clone()
                        } else {
                            format!("{}\n", healed)
                        };
                        if std::fs::write(&todo_file, &body).is_ok() {
                            body
                        } else {
                            healed
                        }
                    }
                    None => content,
                };
                ToolOutput::ok(crate::todo::read_reply(&content))
            }
            Err(_) => ToolOutput::ok(crate::todo::EMPTY_LIST),
        }
    }
}

pub struct AskUserTool;

#[async_trait]
impl Tool for AskUserTool {
    fn name(&self) -> &str { "ask_user" }
    fn description(&self) -> &str {
        "Ask the user a structured question with options. Task suspends until answered."
    }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "questions": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "header": {"type": "string"},
                            "detail": {"type": "string"},
                            "options": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "label": {"type": "string"},
                                        "description": {"type": "string"},
                                        "recommended": {"type": "boolean"}
                                    },
                                    "required": ["label"]
                                }
                            }
                        },
                        "required": ["header"]
                    }
                }
            },
            "required": ["questions"]
        })
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolOutput {
        // Emit a question frame; the ReAct loop detects the suspend and halts.
        if let Some(tx) = &ctx.frame_tx {
            // actionId is this tool call's id, same as the Java kernel: the
            // frontend uses it to recognize a re-delivered question frame as the
            // *same* round (keeping any answers already typed) rather than a new
            // one, and `question_answered` is paired against it on resume.
            let frame = crate::protocol::Frame::question(
                &ctx.session_id,
                ctx.action_id(),
                args.clone(),
            );
            let _ = tx.send(frame);
        }
        ToolOutput::suspend_question()
    }
}

// ─── now ──────────────────────────────────────────────────────────────────────

pub struct NowTool;

#[async_trait]
impl Tool for NowTool {
    fn name(&self) -> &str { "now" }
    fn description(&self) -> &str {
        "Get the current system date, time, weekday and timezone."
    }
    fn readonly(&self) -> bool { true }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({"type": "object", "properties": {}, "required": []})
    }
    async fn execute(&self, _args: serde_json::Value, _ctx: &ToolContext) -> ToolOutput {
        let now = chrono::Local::now();
        ToolOutput::ok(now.format("%Y-%m-%d %H:%M:%S %A").to_string())
    }
}

// ─── memory tools ─────────────────────────────────────────────────────────────

pub struct MemoryExtractTool;

#[async_trait]
impl Tool for MemoryExtractTool {
    fn name(&self) -> &str { "memory_extract" }
    fn description(&self) -> &str {
        "Store a fact, preference, or lesson into long-term memory. Same key overwrites."
    }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "key": {"type": "string"},
                "title": {"type": "string", "description": "Natural-language short title (8-30 chars)"},
                "fact": {"type": "string"},
                "importance": {"type": "integer", "minimum": 1, "maximum": 10}
            },
            "required": ["key", "title", "fact", "importance"]
        })
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolOutput {
        let key = args["key"].as_str().unwrap_or_default();
        let title = args["title"].as_str().unwrap_or_default();
        let fact = args["fact"].as_str().unwrap_or_default();
        let importance = args["importance"].as_u64().unwrap_or(5).clamp(1, 10) as i64;
        if key.is_empty() {
            return ToolOutput::err("key is required");
        }
        // Workspace-scoped so the memory page reads back what this writes.
        let store = ctx.memory_store();
        let entry = crate::memory::MemoryEntry {
            key: key.to_string(),
            title: title.to_string(),
            content: fact.to_string(),
            importance,
            time: crate::memory::now_string(),
            ttl: -1, // agent-saved memories are permanent until deleted
            ttl_known: true,
            expires_at_epoch_ms: None,
        };
        match store.store(&entry) {
            Ok(()) => ToolOutput::ok(format!("Memory saved: [{}] {}", key, title)),
            Err(e) => ToolOutput::err(format!("Failed to save memory: {}", e)),
        }
    }
}

pub struct MemorySearchTool;

#[async_trait]
impl Tool for MemorySearchTool {
    fn name(&self) -> &str { "memory_search" }
    fn description(&self) -> &str {
        "Semantic search over long-term memory. Pass '*' to list all entries."
    }
    fn readonly(&self) -> bool { true }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "topK": {"type": "integer", "default": 5}
            },
            "required": ["query"]
        })
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolOutput {
        let query = args["query"].as_str().unwrap_or_default();
        let top_k = args["topK"].as_u64().unwrap_or(5) as usize;
        let store = ctx.memory_store();
        let results = store.search(query, top_k);
        if results.is_empty() {
            return ToolOutput::ok("No matching memories found.");
        }
        let mut out: Vec<String> = Vec::new();
        for e in &results {
            let preview: String = e.content.chars().take(200).collect();
            out.push(format!("- [{}] {} (Imp:{})\n  {}", e.key, e.title, e.importance, preview));
        }
        ToolOutput::ok(out.join("\n"))
    }
}

pub struct MemoryRecallTool;

#[async_trait]
impl Tool for MemoryRecallTool {
    fn name(&self) -> &str { "memory_recall" }
    fn description(&self) -> &str {
        "Recall the full content of a memory entry by its exact key."
    }
    fn readonly(&self) -> bool { true }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "key": {"type": "string"}
            },
            "required": ["key"]
        })
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolOutput {
        let key = args["key"].as_str().unwrap_or_default();
        let store = ctx.memory_store();
        let results = store.search(key, 100);
        match results.iter().find(|e| e.key == key) {
            Some(e) => ToolOutput::ok(format!(
                "[{}] {} (Imp:{}, {})\n\n{}",
                e.key, e.title, e.importance, e.time, e.content
            )),
            None => ToolOutput::err(format!("Memory not found: {}", key)),
        }
    }
}

pub struct MemoryPruneTool;

#[async_trait]
impl Tool for MemoryPruneTool {
    fn name(&self) -> &str { "memory_prune" }
    fn description(&self) -> &str {
        "Delete an outdated, wrong, or duplicate memory entry by key."
    }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "key": {"type": "string"}
            },
            "required": ["key"]
        })
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolOutput {
        let key = args["key"].as_str().unwrap_or_default();
        // Project-scoped, like `memory_extract` / `memory_search` / `memory_recall`
        // right above this. It used to call `MemoryStore::global()`, which made
        // prune the odd one out in the family: deleting a memory the agent had
        // just written in this project reported "Memory not found" (it was looking
        // in the wrong store), and a key that happened to exist globally was
        // deleted from the global store instead — cross-project data loss from a
        // tool the model believed was scoped to its workspace.
        //
        // `ToolContext::memory_store` documents this exact failure class.
        let store = ctx.memory_store();
        if store.delete(key) {
            ToolOutput::ok(format!("Memory deleted: {}", key))
        } else {
            ToolOutput::err(format!("Memory not found: {}", key))
        }
    }
}

pub struct MemoryConsolidateTool;

#[async_trait]
impl Tool for MemoryConsolidateTool {
    fn name(&self) -> &str { "memory_consolidate" }
    fn description(&self) -> &str {
        "认知升维：将多个低层事实碎片整合为高层偏好模型，并清理冗余碎片。new_title 必须是自然语言短标题，不得复制 Key 或使用 snake_case。"
    }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "keys_to_merge": {"type": "array", "items": {"type": "string"}, "description": "要合并的旧碎片 Key 列表"},
                "new_key": {"type": "string", "description": "整合后的新 Key"},
                "new_title": {"type": "string", "description": "整合后洞察的自然语言可读标题，建议 8-30 字"},
                "evolved_insight": {"type": "string", "description": "升维后的高层洞察正文"}
            },
            "required": ["keys_to_merge", "new_key", "new_title", "evolved_insight"]
        })
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolOutput {
        let new_key = args["new_key"].as_str().unwrap_or_default().trim().to_string();
        let new_title = args["new_title"].as_str().unwrap_or_default().to_string();
        let insight = args["evolved_insight"].as_str().unwrap_or_default().to_string();

        // Validation order mirrors Java `MemoryTalent.consolidate` exactly: every
        // rejection leaves the old fragments untouched, so a bad call can never
        // half-apply. The wording matches Java too, but these are marked
        // `is_error: true` here (unlike Java, whose tool framework has no error
        // flag at all): with `ok` the model read 【合并异常】 as a success and
        // never retried or reconsidered — the failure signal existed only as
        // text the model was free to ignore.
        if new_key.is_empty() {
            return ToolOutput::err("【合并异常】new_key 不能为空，旧碎片保留。");
        }
        // De-dup while preserving order (Java uses a LinkedHashSet).
        let mut keys_to_merge: Vec<String> = Vec::new();
        let raw = args["keys_to_merge"].as_array().cloned().unwrap_or_default();
        if raw.is_empty() {
            return ToolOutput::err("【合并异常】keys_to_merge 不能为空，旧碎片保留。");
        }
        for v in &raw {
            let k = v.as_str().unwrap_or_default().trim().to_string();
            if k.is_empty() {
                continue;
            }
            if k == new_key {
                return ToolOutput::err("【合并异常】keys_to_merge 不得包含 new_key，旧碎片保留。");
            }
            if !keys_to_merge.contains(&k) {
                keys_to_merge.push(k);
            }
        }
        if keys_to_merge.is_empty() {
            return ToolOutput::err("【合并异常】keys_to_merge 不得只包含空值，旧碎片保留。");
        }

        let store = ctx.memory_store();

        // Step 1: write the evolved insight FIRST. If this fails, abort before
        // touching the old fragments — deleting them and then failing to persist
        // the merge would lose data with nothing to show for it. Importance 10 and
        // the `[Evolved Insight]` marker match Java so the two kernels agree on a
        // shared memory store.
        let entry = crate::memory::MemoryEntry {
            key: new_key.clone(),
            title: new_title,
            content: format!("[Evolved Insight] {}", insight),
            importance: 10,
            time: crate::memory::now_string(),
            ttl: -1,
            ttl_known: true,
            expires_at_epoch_ms: None,
        };
        if let Err(e) = store.store(&entry) {
            // Same rule: the write failed, nothing was merged, this is an error.
            return ToolOutput::err(format!("【合并异常】新洞察写入失败，旧碎片保留：{}", e));
        }

        // Step 2: prune each old fragment. One failure does not stop the rest.
        let mut failed: Vec<String> = Vec::new();
        for k in &keys_to_merge {
            if !store.delete(k) {
                failed.push(k.clone());
            }
        }

        if failed.is_empty() {
            ToolOutput::ok(format!(
                "【心智进化成功】已将碎片认知升维为核心洞察，删除了{}条冗余记录。",
                keys_to_merge.len()
            ))
        } else {
            // Partial success is still a SUCCESS for the merge itself: the new
            // insight is persisted, only the optional cleanup is incomplete, and
            // the message tells the model exactly how to finish it. Marking this
            // `err` would make the model retry the whole merge and write a SECOND
            // copy of the new insight — worse than the dangling fragments it
            // already knows how to prune. So: `ok`, with the actionable detail.
            ToolOutput::ok(format!(
                "【心智进化部分成功】新洞察已写入，但以下碎片清理失败：{:?}。可再次调用 memory_prune 清理。",
                failed
            ))
        }
    }
}

// ─── recall_history ───────────────────────────────────────────────────────────

pub struct RecallHistoryTool;

#[async_trait]
impl Tool for RecallHistoryTool {
    fn name(&self) -> &str { "recall_history" }
    fn description(&self) -> &str {
        "回溯本会话中早前的历史细节、事实或长消息。当需要找回早前对话里出现过的具体信息、ID 或数据时使用。"
    }
    fn readonly(&self) -> bool { true }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "检索关键词或核心短语"},
                "limit": {"type": "integer", "description": "返回记忆片段的数量", "default": 3}
            },
            "required": ["query"]
        })
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolOutput {
        let query = args["query"].as_str().unwrap_or_default().trim().to_string();
        if query.is_empty() {
            return ToolOutput::ok("请提供具体的关键词以进行历史回溯。");
        }
        let limit = args["limit"].as_u64().unwrap_or(3).clamp(1, 50) as usize;

        // The session's persisted ndjson holds its **full** history, including
        // messages that have since scrolled out of the context window — exactly
        // the "earlier details" this tool is for. `session_dir` is the session
        // folder itself; `load_messages_in` wants its parent (the sessions root)
        // plus the id, so passing the dir directly would double the `<id>`
        // segment and silently return nothing.
        let (root, session_id) = match (ctx.session_dir.as_ref(), ctx.session_dir.as_ref().and_then(|d| d.parent())) {
            (Some(_), Some(parent)) => (parent.to_path_buf(), ctx.session_id.clone()),
            _ => {
                return ToolOutput::ok("当前会话没有可回溯的持久化历史。");
            }
        };

        // `load_messages_in` offloads internally (block_in_place on the async
        // worker), so this must NOT be wrapped in `run_blocking` — that would
        // call block_in_place on a spawn_blocking thread and panic.
        let store = crate::session::SessionStore::new();
        let messages = store.load_messages_in(&root, &session_id);
        let matches = search_history(&messages, &query, limit);
        if matches.is_empty() {
            return ToolOutput::ok(format!(
                "记忆库中暂未找到关于 '{}' 的相关记录。可能是该话题未被归档，或关键词不匹配。",
                query
            ));
        }
        ToolOutput::ok(format_history_matches(&matches))
    }
}

/// Keyword search over a session's persisted messages, newest match first.
///
/// Java's `recall_history` searches a vector store populated by its
/// compression-archival strategy. This kernel's compressor is the zero-cost path
/// and archives nothing, so there is no vector store to search; the honest
/// equivalent is a keyword scan of the session's own ndjson history, which holds
/// every earlier message. The mechanism differs from Java's but the user-facing
/// purpose — recovering an earlier fact that left the context window — is the
/// same. Kept as a free function so the matching rule is testable without a
/// session on disk.
fn search_history<'a>(
    messages: &'a [crate::session::StoredMessage],
    query: &str,
    limit: usize,
) -> Vec<&'a crate::session::StoredMessage> {
    let keys: Vec<String> = query
        .to_lowercase()
        .split_whitespace()
        .map(|k| k.to_string())
        .filter(|k| !k.is_empty())
        .collect();
    if keys.is_empty() {
        return Vec::new();
    }
    messages
        .iter()
        .filter(|m| !m.is_pending_notice())
        .filter(|m| {
            let body = m.body().to_lowercase();
            !body.trim().is_empty() && keys.iter().any(|k| body.contains(k))
        })
        // Newest first: the most recent mention of a fact is usually the relevant
        // one, and it bounds the scan to the tail.
        .rev()
        .take(limit)
        .collect()
}

/// Render matched messages the way Java's recall does: `[timestamp] body`,
/// separated by a horizontal rule.
fn format_history_matches(matches: &[&crate::session::StoredMessage]) -> String {
    matches
        .iter()
        .map(|m| {
            let ts = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(m.created_at)
                .map(|d| d.format("%Y-%m-%d %H:%M:%S").to_string());
            let prefix = ts.map(|t| format!("[{}] ", t)).unwrap_or_default();
            format!("{}{}", prefix, m.body())
        })
        .collect::<Vec<_>>()
        .join("\n\n---\n\n")
}

// ─── skill tools ──────────────────────────────────────────────────────────────

pub struct SkillReadTool;

#[async_trait]
impl Tool for SkillReadTool {
    fn name(&self) -> &str { "skillread" }
    fn description(&self) -> &str {
        "Read the full SKILL.md instructions of an installed skill by name. Call before executing a matching task."
    }
    fn readonly(&self) -> bool { true }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "The skill's unique path identifier"}
            },
            "required": ["name"]
        })
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolOutput {
        let name = args["name"].as_str().unwrap_or_default().to_string();
        // Project skills included: scanning only the global dir made a skill the
        // settings page lists unresolvable by name here.
        let registry = ctx.skill_registry();
        // The body is read on demand (off the worker) rather than carried in the
        // parsed-skill cache: `Skill` no longer stores `content`, so the ~230 KB of
        // third-party Markdown is not held resident for the life of the process.
        // `load_all` is itself offloaded; the extra `read_skill_content` is one
        // small file read, kept on the blocking pool for the same reason.
        run_blocking(move || {
            let skills = registry.load_all();
            match skills.iter().find(|s| s.name == name) {
                Some(s) => match crate::skills::read_skill_content(&s.dir) {
                    Some(body) => ToolOutput::ok(format!("# {}\n\n{}", s.title, body)),
                    None => ToolOutput::err(format!(
                        "Skill '{}' has no readable SKILL.md",
                        name
                    )),
                },
                None => ToolOutput::err(format!("Skill not found: {}", name)),
            }
        })
        .await
    }
}

pub struct SkillRefreshTool;

#[async_trait]
impl Tool for SkillRefreshTool {
    fn name(&self) -> &str { "skillrefresh" }
    fn description(&self) -> &str {
        "Rescan the skills directory and return the updated skill list."
    }
    fn readonly(&self) -> bool { true }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({"type": "object", "properties": {}, "required": []})
    }
    async fn execute(&self, _args: serde_json::Value, ctx: &ToolContext) -> ToolOutput {
        let registry = ctx.skill_registry();
        let skills = registry.load_all();
        if skills.is_empty() {
            return ToolOutput::ok("No skills installed.");
        }
        let mut out = String::from("Installed skills:\n");
        for s in &skills {
            out.push_str(&format!("- {}: {}\n", s.name, s.description));
        }
        ToolOutput::ok(out)
    }
}

pub struct SkillSearchTool;

#[async_trait]
impl Tool for SkillSearchTool {
    fn name(&self) -> &str { "skillsearch" }
    fn description(&self) -> &str {
        "在本地技能库中搜索关键字。支持空格分隔多个词。"
    }
    fn readonly(&self) -> bool { true }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "搜索关键字，空格分隔多个词"}
            },
            "required": ["query"]
        })
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolOutput {
        let query = args["query"].as_str().unwrap_or_default().to_string();
        let registry = ctx.skill_registry();
        run_blocking(move || {
            let skills = registry.load_all();
            let matches = search_skills(&skills, &query);
            if matches.is_empty() {
                return ToolOutput::ok("未找到匹配技能。");
            }
            let mut out = String::from("<skill_list>\n");
            for s in &matches {
                out.push_str(&format!("- {}: {}\n", s.name, s.description));
            }
            out.push_str("</skill_list>");
            ToolOutput::ok(out)
        })
        .await
    }
}

/// Keyword search over skills, mirroring Java `RegistrySkillProvider.searchSkill`.
///
/// The query is lower-cased and split on whitespace; a skill matches when **any**
/// token is a substring of its name, title or description. Disabled skills are
/// excluded (they must not reach the model, same rule as `skillread`), and the
/// result is capped at 15 like Java. Kept as a free function so the matching rule
/// is unit-testable without a registry on disk.
fn search_skills<'a>(skills: &'a [crate::skills::Skill], query: &str) -> Vec<&'a crate::skills::Skill> {
    let keys: Vec<String> = query
        .to_lowercase()
        .split_whitespace()
        .map(|k| k.to_string())
        .filter(|k| !k.is_empty())
        .collect();
    if keys.is_empty() {
        return Vec::new();
    }
    skills
        .iter()
        .filter(|s| s.enabled)
        .filter(|s| {
            let name = s.name.to_lowercase();
            let title = s.title.to_lowercase();
            let desc = s.description.to_lowercase();
            keys.iter().any(|k| name.contains(k) || title.contains(k) || desc.contains(k))
        })
        .take(15)
        .collect()
}

// ─── add_model ────────────────────────────────────────────────────────────────

pub struct AddModelTool;

#[async_trait]
impl Tool for AddModelTool {
    fn name(&self) -> &str { "add_model" }
    fn description(&self) -> &str {
        "Add an LLM model configuration. Persists to settings.json immediately."
    }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "apiUrl": {"type": "string", "description": "API base URL (e.g. https://api.openai.com/v1)"},
                "apiKey": {"type": "string"},
                "model": {"type": "string", "description": "Model ID (e.g. gpt-4o)"},
                "name": {"type": "string", "description": "Display name (defaults to model)"},
                "standard": {"type": "string", "description": "openai | anthropic | ollama"},
                "timeout": {"type": "string", "description": "Timeout seconds, default 120"}
            },
            "required": ["apiUrl", "apiKey", "model"]
        })
    }
    async fn execute(&self, args: serde_json::Value, _ctx: &ToolContext) -> ToolOutput {
        let api_url = args["apiUrl"].as_str().unwrap_or_default();
        let api_key = args["apiKey"].as_str().unwrap_or_default();
        let model = args["model"].as_str().unwrap_or_default();
        if api_url.is_empty() || model.is_empty() {
            return ToolOutput::err("apiUrl and model are required");
        }
        let name = args["name"].as_str().filter(|s| !s.is_empty()).unwrap_or(model);
        let standard = args["standard"].as_str().unwrap_or("openai");
        let timeout = args["timeout"].as_str().unwrap_or("120");

        // Load, mutate, save settings.json.
        //
        // The load goes through the same three-state guard as every writer in
        // `server/settings_api` (`read_settings_for_update`), NOT a private
        // `unwrap_or_else(json!({}))`. This tool used to carry its own fallback,
        // so a settings.json that failed to parse (BOM, truncation, corruption)
        // became an empty object and the write-back erased `providers`,
        // `mcpServers`, `permission` and every other section — the exact defect
        // the guard exists for, reintroduced on a path the HTTP layer does not
        // cover. A tool call must not be able to wipe the config file.
        let home = crate::config::Settings::gwork_home();
        let path = home.join("settings.json");
        let mut settings = match crate::server::settings_api::read_settings_for_update(&path) {
            crate::server::settings_api::SettingsRead::Usable(obj) => {
                serde_json::Value::Object(obj)
            }
            crate::server::settings_api::SettingsRead::Unreadable => {
                return ToolOutput::err(format!(
                    "Refused to write: {}",
                    crate::server::settings_api::settings_unreadable_message()
                ));
            }
        };
        let new_model = json!({
            "name": name,
            "enabled": true,
            "visibled": true,
            "scope": "user",
            "apiUrl": api_url,
            "apiKey": api_key,
            "standard": standard,
            "model": model,
            "timeout": timeout
        });
        // models may be a map or array; normalize to map.
        if let Some(obj) = settings.as_object_mut() {
            let models = obj.entry("models").or_insert(json!({}));
            if let Some(map) = models.as_object_mut() {
                map.insert(name.to_string(), new_model);
            } else {
                // Was an array — convert
                let arr = models.as_array().cloned().unwrap_or_default();
                let mut new_map = serde_json::Map::new();
                for m in arr {
                    if let Some(n) = m.get("name").and_then(|n| n.as_str()) {
                        new_map.insert(n.to_string(), m);
                    }
                }
                new_map.insert(name.to_string(), new_model);
                *models = serde_json::Value::Object(new_map);
            }
        }
        let _ = std::fs::create_dir_all(&home);
        match std::fs::write(&path, serde_json::to_string_pretty(&settings).unwrap_or_default()) {
            Ok(()) => ToolOutput::ok(format!("Model added: {} ({})", name, model)),
            Err(e) => ToolOutput::err(format!("Failed to save settings: {}", e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Scratch workspace, unique per test.
    ///
    /// These tests exercise the synchronous bodies (`grep_sync` / `glob_sync`)
    /// directly rather than through `Tool::execute`, so they need no tokio
    /// runtime and no `ToolContext` — only a directory to walk.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "gwork-builtin-{}-{}-{}",
                tag,
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.subsec_nanos())
                    .unwrap_or(0)
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn write(&self, rel: &str, body: &str) {
            let p = self.0.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn re(p: &str) -> regex::Regex {
        regex::Regex::new(p).unwrap()
    }

    // ─── grep ────────────────────────────────────────────────────────────────

    #[test]
    fn grep_finds_matches_with_path_line_content() {
        let s = Scratch::new("grep-basic");
        s.write("src/a.rs", "fn alpha() {}\nfn beta() {}\n");
        s.write("src/b.rs", "nothing here\n");

        let out = grep_sync(re("beta"), &s.0, "", &s.0);
        assert!(!out.is_error);
        assert!(out.text.contains("src/a.rs:2:"), "got: {}", out.text);
        assert!(out.text.contains("fn beta()"), "got: {}", out.text);
        assert!(!out.text.contains("alpha"), "must not match other lines");
    }

    #[test]
    fn grep_honours_include_filter() {
        let s = Scratch::new("grep-include");
        s.write("a.rs", "needle\n");
        s.write("a.txt", "needle\n");

        let out = grep_sync(re("needle"), &s.0, "*.rs", &s.0);
        assert!(out.text.contains("a.rs"), "got: {}", out.text);
        assert!(!out.text.contains("a.txt"), "include filter must exclude .txt: {}", out.text);
    }

    /// Hidden and build directories are skipped: searching them is both slow and
    /// almost never what the caller wants.
    #[test]
    fn grep_skips_hidden_node_modules_and_target() {
        let s = Scratch::new("grep-skip");
        s.write(".git/config", "needle\n");
        s.write("node_modules/pkg/index.js", "needle\n");
        s.write("target/debug/out.txt", "needle\n");
        s.write("src/real.rs", "needle\n");

        let out = grep_sync(re("needle"), &s.0, "", &s.0);
        assert!(out.text.contains("src/real.rs"), "got: {}", out.text);
        for skipped in [".git", "node_modules", "target"] {
            assert!(!out.text.contains(skipped), "{} must be skipped: {}", skipped, out.text);
        }
    }

    #[test]
    fn grep_reports_no_matches_rather_than_empty() {
        let s = Scratch::new("grep-none");
        s.write("a.rs", "alpha\n");
        let out = grep_sync(re("zzz-not-present"), &s.0, "", &s.0);
        assert!(!out.is_error);
        assert_eq!(out.text, "No matches found.");
    }

    /// **The defect the visit cap fixes.** A pattern that matches nothing used to
    /// walk the whole tree; the 200-match cap never fired because there were no
    /// matches. The cap must stop the walk and *say so* — a silent partial scan
    /// reads as "the symbol does not exist" and sends the agent down the wrong
    /// path.
    #[test]
    fn grep_visit_cap_stops_the_walk_and_says_so() {
        let s = Scratch::new("grep-cap");
        // 6 files, none matching. Cap of 3 entries must trip.
        for i in 0..6 {
            s.write(&format!("f{}.txt", i), "alpha\n");
        }

        let out = grep_sync_capped(re("zzz-not-present"), &s.0, "", &s.0, 3);
        assert!(!out.is_error);
        assert!(
            out.text.contains("search stopped after visiting 3 entries"),
            "cap must be reported explicitly, got: {}",
            out.text
        );
        assert!(
            out.text.contains("narrow `path`"),
            "must tell the caller how to search deeper, got: {}",
            out.text
        );
    }

    /// The complementary direction: a cap that is not reached must not warn.
    #[test]
    fn grep_below_cap_does_not_warn() {
        let s = Scratch::new("grep-nocap");
        s.write("a.txt", "alpha\n");
        let out = grep_sync_capped(re("alpha"), &s.0, "", &s.0, 1000);
        assert!(out.text.contains("a.txt:1:alpha"));
        assert!(!out.text.contains("search stopped"), "no cap warning expected: {}", out.text);
    }

    /// Matches still truncate at 200, and that path returns early (before the
    /// visit cap message could be appended).
    #[test]
    fn grep_truncates_at_200_matches() {
        let s = Scratch::new("grep-200");
        let body = (0..250).map(|i| format!("hit-{}", i)).collect::<Vec<_>>().join("\n");
        s.write("big.txt", &body);

        let out = grep_sync(re("hit-"), &s.0, "", &s.0);
        let lines: Vec<&str> = out.text.lines().collect();
        assert_eq!(lines.len(), 201, "200 matches + truncation notice");
        assert!(lines.last().unwrap().contains("truncated at 200"));
    }

    #[test]
    fn grep_skips_files_over_1mb() {
        let s = Scratch::new("grep-big");
        let huge = "x".repeat(1_100_000) + "\nneedle\n";
        s.write("huge.txt", &huge);
        s.write("small.txt", "needle\n");

        let out = grep_sync(re("needle"), &s.0, "", &s.0);
        assert!(out.text.contains("small.txt"), "got: {}", out.text);
        assert!(!out.text.contains("huge.txt"), ">1MB file must be skipped: {}", out.text);
    }

    // ─── glob ────────────────────────────────────────────────────────────────

    #[test]
    fn glob_returns_relative_forward_slash_paths() {
        let s = Scratch::new("glob-basic");
        s.write("src/a.rs", "");
        s.write("src/deep/b.rs", "");
        s.write("readme.md", "");

        let out = glob_sync("**/*.rs", &s.0, &s.0);
        assert!(!out.is_error);
        assert!(out.text.contains("src/a.rs"), "got: {}", out.text);
        assert!(out.text.contains("src/deep/b.rs"), "got: {}", out.text);
        assert!(!out.text.contains("readme.md"), "got: {}", out.text);
        assert!(!out.text.contains('\\'), "paths must use forward slashes: {}", out.text);
    }

    #[test]
    fn glob_reports_no_match_rather_than_empty() {
        let s = Scratch::new("glob-none");
        s.write("a.rs", "");
        let out = glob_sync("**/*.zzz", &s.0, &s.0);
        assert_eq!(out.text, "No files matched the pattern.");
    }

    #[test]
    fn glob_truncates_at_500() {
        let s = Scratch::new("glob-500");
        for i in 0..520 {
            s.write(&format!("f{:04}.txt", i), "");
        }
        let out = glob_sync("*.txt", &s.0, &s.0);
        let lines: Vec<&str> = out.text.lines().collect();
        assert_eq!(lines.len(), 501, "500 matches + truncation notice");
        assert!(lines.last().unwrap().contains("truncated at 500"));
    }

    // ─── run_blocking ────────────────────────────────────────────────────────

    /// The whole point of the helper: the closure must run and its result come
    /// back, so tools keep working after the move off the async worker.
    #[tokio::test]
    async fn run_blocking_returns_the_closure_result() {
        let out = run_blocking(|| ToolOutput::ok("from blocking pool")).await;
        assert!(!out.is_error);
        assert_eq!(out.text, "from blocking pool");
    }

    /// A panic inside the closure must degrade to a tool error, not take down
    /// the request or surface as an opaque JoinError.
    #[tokio::test]
    async fn run_blocking_converts_panic_into_tool_error() {
        let out = run_blocking(|| -> ToolOutput { panic!("boom") }).await;
        assert!(out.is_error, "panic must become an error result");
        assert!(out.text.contains("operation failed"), "got: {}", out.text);
    }

    /// End-to-end through the real tool entry point, proving the refactor did not
    /// change observable behaviour for a normal call.
    #[tokio::test]
    async fn grep_tool_execute_still_works_after_refactor() {
        let s = Scratch::new("grep-e2e");
        s.write("src/x.rs", "fn target_fn() {}\n");

        let ctx = ToolContext {
            workspace: s.0.clone(),
            session_dir: None,
            session_id: "work-test".into(),
            tool_call_id: "call-1".into(),
            run_id: "run-1".into(),
            frame_tx: None,
            access_mode: "full".into(),
            cancel: tokio_util::sync::CancellationToken::new(),
            hitl_approved: true,
            change_ledger: None,
            gate: None,
            subagent_depth: 0,
            root_session_id: "work-test".into(),
            thinking: None,
            model: Default::default(),
            settings: Default::default(),
            bash_exempt_dirs: Vec::new(),
        };

        let out = GrepTool
            .execute(
                serde_json::json!({ "pattern": "target_fn", "path": "." }),
                &ctx,
            )
            .await;
        assert!(!out.is_error);
        assert!(out.text.contains("src/x.rs:1:"), "got: {}", out.text);
    }

    /// Path escape must still be rejected after the refactor (the `resolve_safe`
    /// call moved relative to the blocking hand-off).
    #[tokio::test]    async fn grep_tool_rejects_path_escaping_workspace() {
        let s = Scratch::new("grep-escape");
        let ctx = ToolContext {
            workspace: s.0.clone(),
            session_dir: None,
            session_id: "work-test".into(),
            tool_call_id: "call-1".into(),
            run_id: "run-1".into(),
            frame_tx: None,
            access_mode: "full".into(),
            cancel: tokio_util::sync::CancellationToken::new(),
            hitl_approved: true,
            change_ledger: None,
            gate: None,
            subagent_depth: 0,
            root_session_id: "work-test".into(),
            thinking: None,
            model: Default::default(),
            settings: Default::default(),
            bash_exempt_dirs: Vec::new(),
        };

        let out = GrepTool
            .execute(
                serde_json::json!({ "pattern": "x", "path": "../../etc" }),
                &ctx,
            )
            .await;
        assert!(out.is_error, "escaping path must be rejected");
        assert_eq!(out.text, "Invalid path");
    }

    // ─── P0 regression: blocking tools must not starve the async worker ──────
    //
    // The defect: `grep` / `glob` walked the filesystem **inline** inside an
    // `async fn`. Tools are awaited from the ReAct loop on a tokio worker, and
    // that same worker serves HTTP requests — so one grep with no matches (which
    // walks the entire tree, because the 200-match cap only fires on hits) froze
    // every unrelated endpoint for its whole duration. The fix hands the walk to
    // `run_blocking`.
    //
    // These tests prove the fix **deterministically**, not by timing. Timing was
    // tried first and is unusable here: on Windows a tokio `sleep` has ~15 ms
    // granularity (system clock resolution), so a ticker cannot sample anything
    // shorter. Measured: a 120 ms blocking op produced only 8 ticks at a 1 ms
    // interval, and `glob`'s walk (~6 ms warm over 16000 files — it only lists
    // directories, never reads them) is shorter than a single tick, so inline and
    // offloaded are literally indistinguishable by timing. Worse, the inline
    // "control" passed *because glob was fast*, not because it starved — a green
    // light that proved nothing. Thread identity and call shape have no such floor.

    /// `run_blocking` executes its closure on the blocking pool, not on the
    /// async worker. Thread identity is deterministic: there is no duration floor
    /// below which the check stops working.
    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn run_blocking_executes_off_the_async_worker() {
        let worker_id = format!("{:?}", std::thread::current().id());
        let seen = Arc::new(std::sync::Mutex::new(String::new()));
        let s2 = seen.clone();

        let out = run_blocking(move || {
            *s2.lock().unwrap() = format!("{:?}", std::thread::current().id());
            ToolOutput::ok("done")
        })
        .await;
        assert!(!out.is_error);

        let blocking_id = seen.lock().unwrap().clone();
        assert!(!blocking_id.is_empty(), "closure never ran");
        assert_ne!(
            worker_id, blocking_id,
            "run_blocking must execute on the blocking pool, not on the async worker"
        );
    }

    /// Structural guard for the two walk-heavy tools.
    ///
    /// `glob` cannot be covered by a behavioural timing test (see above), so its
    /// offload is pinned by call shape instead. This is the assertion that fails
    /// if someone reverts `GlobTool::execute` / `GrepTool::execute` to call the
    /// `*_sync` body inline.
    ///
    /// Comment lines are excluded before matching: an assertion that also matched
    /// text inside a comment would keep passing after the call was commented out,
    /// locking the reverted shape in as "correct" — a defect class this repo has
    /// already shipped once.
    #[test]
    fn walk_heavy_tools_route_through_run_blocking() {
        // include_str! is relative to *this* file, so there is no path to get
        // wrong and the test cannot silently read a stale copy.
        let src = include_str!("mod.rs");

        for tool in ["impl Tool for GlobTool", "impl Tool for GrepTool"] {
            let start = src
                .find(tool)
                .unwrap_or_else(|| panic!("{} not found in source", tool));
            let rest = &src[start..];
            let exec = rest
                .find("async fn execute")
                .unwrap_or_else(|| panic!("{} has no execute fn", tool));
            // The execute body ends at the next top-level item; 2500 chars is
            // comfortably past it for both tools and well short of the next impl.
            let body = &rest[exec..(exec + 2500).min(rest.len())];

            let has_call = body.lines().any(|line| {
                let t = line.trim_start();
                !t.starts_with("//") && line.contains("run_blocking(")
            });
            assert!(
                has_call,
                "{}::execute must offload its walk via run_blocking (comment lines do not count)",
                tool
            );
        }
    }

    // ─── resolve_safe_with: session uploads as a read-only extra root ────────
    //
    // Attachments live in `<sessionDir>/uploads/`, which is in the harness home
    // and therefore **outside** the workspace. Measured before this existed:
    // `read("uploads/x.txt")` and `read("x.txt")` both answered `File not found`,
    // so every file attachment was unreachable no matter what the prompt said.

    /// A fake session dir holding `uploads/<name>`, plus a separate workspace.
    struct UploadsFixture {
        workspace: PathBuf,
        session_dir: PathBuf,
    }

    impl UploadsFixture {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "gwork-uploads-{}-{}-{}",
                tag,
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.subsec_nanos())
                    .unwrap_or(0)
            ));
            let _ = std::fs::remove_dir_all(&root);
            let workspace = root.join("ws");
            let session_dir = root.join("home").join("sessions").join("work-fixture");
            std::fs::create_dir_all(&workspace).unwrap();
            std::fs::create_dir_all(crate::attachments::uploads_dir(&session_dir)).unwrap();
            std::fs::write(workspace.join("in-ws.txt"), "workspace file").unwrap();
            std::fs::write(
                crate::attachments::uploads_dir(&session_dir).join("report.txt"),
                "attachment body",
            )
            .unwrap();
            Self { workspace, session_dir }
        }

        fn uploads(&self) -> PathBuf {
            crate::attachments::uploads_dir(&self.session_dir)
        }

        fn roots(&self) -> Vec<PathBuf> {
            vec![self.uploads()]
        }
    }

    impl Drop for UploadsFixture {
        fn drop(&mut self) {
            // Both live under one temp root; removing the workspace's grandparent
            // is not safe, so remove each tree we created.
            if let Some(home) = self.session_dir.parent().and_then(|p| p.parent()) {
                let _ = std::fs::remove_dir_all(home);
            }
            let _ = std::fs::remove_dir_all(&self.workspace);
        }
    }

    #[test]
    fn uploads_relative_reference_resolves_against_the_session_dir() {
        let f = UploadsFixture::new("rel");
        let got = resolve_safe_with(&f.workspace, &f.roots(), "uploads/report.txt").unwrap();
        assert_eq!(got, f.uploads().join("report.txt"));
        assert!(got.is_file(), "resolved path must be the real attachment");
    }

    #[test]
    fn uploads_absolute_path_is_allowed_for_readonly_tools() {
        let f = UploadsFixture::new("abs");
        let abs = f.uploads().join("report.txt");
        let got = resolve_safe_with(&f.workspace, &f.roots(), &abs.to_string_lossy()).unwrap();
        assert_eq!(got, abs);
    }

    #[test]
    fn workspace_paths_still_resolve_without_extra_roots() {
        let f = UploadsFixture::new("ws");
        // No extra roots at all: the plain workspace behaviour must be unchanged.
        let got = resolve_safe(&f.workspace, "in-ws.txt").unwrap();
        assert_eq!(got, f.workspace.join("in-ws.txt"));
        // And with roots supplied, workspace paths keep working too.
        let got2 = resolve_safe_with(&f.workspace, &f.roots(), "in-ws.txt").unwrap();
        assert_eq!(got2, f.workspace.join("in-ws.txt"));
    }

    #[test]
    fn without_extra_roots_the_session_uploads_stay_out_of_reach() {
        let f = UploadsFixture::new("deny");
        // write/edit pass an empty list, so the attachment's real location is
        // never handed out. Java gates `trustedRead` on `!writeMode`
        // (TerminalSupport:799) for the same reason.
        //
        // Note what "rejected" means for a *relative* reference: with no session
        // base to resolve against, `uploads/report.txt` is an ordinary
        // workspace-relative path, so it resolves to `<ws>/uploads/report.txt` —
        // which does not exist. The security property is that it must **not**
        // land on the real attachment under the session dir.
        let got = resolve_safe_with(&f.workspace, &[], "uploads/report.txt").unwrap();
        assert_eq!(got, f.workspace.join("uploads").join("report.txt"));
        assert_ne!(got, f.uploads().join("report.txt"), "must not reach the real attachment");
        assert!(!got.exists(), "the workspace has no uploads dir, so read answers File not found");

        // An absolute path pointing at the session uploads is refused outright:
        // it is inside no allowed root.
        let abs = f.uploads().join("report.txt");
        assert!(resolve_safe_with(&f.workspace, &[], &abs.to_string_lossy()).is_none());
    }

    #[test]
    fn traversal_out_of_uploads_is_rejected() {
        let f = UploadsFixture::new("trav");
        // Escaping the uploads dir must not be laundered by the extra root:
        // `uploads/../secret.txt` normalizes to `<sessionDir>/secret.txt`, which
        // is inside no allowed root.
        assert!(resolve_safe_with(&f.workspace, &f.roots(), "uploads/../secret.txt").is_none());
        assert!(resolve_safe_with(&f.workspace, &f.roots(), "uploads/../../etc/passwd").is_none());
        // An absolute path outside every allowed root is still refused.
        assert!(resolve_safe_with(&f.workspace, &f.roots(), "C:\\Windows\\win.ini").is_none());
    }

    // ─── 视觉通道：read 磁盘图片 ─────────────────────────────────────

    /// 1×1 透明 PNG 的合法字节（与 attachments.rs 测试夹具同源）。
    fn tiny_png_bytes() -> Vec<u8> {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
            .unwrap()
    }

    /// 图片文件（含 uploads 附件）read 后返回 data URL，模型可看。
    #[tokio::test]
    async fn read_returns_image_data_url() {
        let f = UploadsFixture::new("img");
        std::fs::write(f.workspace.join("shot.png"), tiny_png_bytes()).unwrap();

        let ctx = ToolContext {
            workspace: f.workspace.clone(),
            session_dir: Some(f.session_dir.clone()),
            session_id: "work-test".into(),
            tool_call_id: "c1".into(),
            run_id: "r1".into(),
            frame_tx: None,
            access_mode: "full".into(),
            cancel: tokio_util::sync::CancellationToken::new(),
            hitl_approved: true,
            change_ledger: None,
            gate: None,
            subagent_depth: 0,
            root_session_id: "work-test".into(),
            thinking: None,
            model: Default::default(),
            settings: Default::default(),
            bash_exempt_dirs: Vec::new(),
        };
        let out = ReadTool
            .execute(json!({ "file_path": "shot.png" }), &ctx)
            .await;
        assert!(!out.is_error);
        assert_eq!(1, out.image_urls.len(), "read(png) must carry the image");
        let url = &out.image_urls[0];
        assert!(url.starts_with("data:image/png;base64,"), "{}", url);
        assert!(url.contains("iVBORw0KGgo"), "payload must be the real bytes");
        assert!(out.text.contains("shot.png"), "text must name the path");
        assert!(out.text.contains("image/png"), "text must state the mime");
    }

    /// jpg 大写扩展名同样命中，mime 正确。
    #[tokio::test]
    async fn read_image_maps_uppercase_extension() {
        let f = UploadsFixture::new("img2");
        std::fs::write(f.workspace.join("photo.JPG"), tiny_png_bytes()).unwrap();

        let ctx = ToolContext {
            workspace: f.workspace.clone(),
            session_dir: Some(f.session_dir.clone()),
            session_id: "work-test".into(),
            tool_call_id: "c1".into(),
            run_id: "r1".into(),
            frame_tx: None,
            access_mode: "full".into(),
            cancel: tokio_util::sync::CancellationToken::new(),
            hitl_approved: true,
            change_ledger: None,
            gate: None,
            subagent_depth: 0,
            root_session_id: "work-test".into(),
            thinking: None,
            model: Default::default(),
            settings: Default::default(),
            bash_exempt_dirs: Vec::new(),
        };
        let out = ReadTool
            .execute(json!({ "file_path": "photo.JPG" }), &ctx)
            .await;
        assert!(!out.is_error);
        assert!(out.image_urls[0].starts_with("data:image/jpeg;base64,"));
    }

    /// 超过 4MB 上限的图片：明确报错，不得截断后偷偷内联。
    #[tokio::test]
    async fn read_oversize_image_errors_explicitly() {
        let f = UploadsFixture::new("big");
        let big = f.workspace.join("huge.png");
        let mut v = vec![0u8; (MAX_IMAGE_READ_BYTES + 1) as usize];
        v[..8].copy_from_slice(&tiny_png_bytes()[..8]);
        std::fs::write(&big, v).unwrap();

        let ctx = ToolContext {
            workspace: f.workspace.clone(),
            session_dir: Some(f.session_dir.clone()),
            session_id: "work-test".into(),
            tool_call_id: "c1".into(),
            run_id: "r1".into(),
            frame_tx: None,
            access_mode: "full".into(),
            cancel: tokio_util::sync::CancellationToken::new(),
            hitl_approved: true,
            change_ledger: None,
            gate: None,
            subagent_depth: 0,
            root_session_id: "work-test".into(),
            thinking: None,
            model: Default::default(),
            settings: Default::default(),
            bash_exempt_dirs: Vec::new(),
        };
        let out = ReadTool
            .execute(json!({ "file_path": "huge.png" }), &ctx)
            .await;
        assert!(out.is_error, "oversize must be an error, not a silent drop");
        assert!(out.image_urls.is_empty());
        assert!(out.text.contains("上限"), "must explain the cap: {}", out.text);
        assert!(out.text.contains("附件"), "must point at the attachment channel: {}", out.text);
    }

    /// 非图片二进制与文本文件行为不变（回归锚）。
    #[tokio::test]
    async fn read_non_image_and_text_unchanged() {
        let f = UploadsFixture::new("mix");
        std::fs::write(f.workspace.join("blob.bin"), [0u8, 1, 2, 3]).unwrap();
        std::fs::write(f.workspace.join("note.txt"), "hello").unwrap();

        let ctx = ToolContext {
            workspace: f.workspace.clone(),
            session_dir: Some(f.session_dir.clone()),
            session_id: "work-test".into(),
            tool_call_id: "c1".into(),
            run_id: "r1".into(),
            frame_tx: None,
            access_mode: "full".into(),
            cancel: tokio_util::sync::CancellationToken::new(),
            hitl_approved: true,
            change_ledger: None,
            gate: None,
            subagent_depth: 0,
            root_session_id: "work-test".into(),
            thinking: None,
            model: Default::default(),
            settings: Default::default(),
            bash_exempt_dirs: Vec::new(),
        };
        // .bin 不在图片扩展名里 → 走文本路径（lossy 解码），无视觉块
        let bin = ReadTool
            .execute(json!({ "file_path": "blob.bin" }), &ctx)
            .await;
        assert!(bin.image_urls.is_empty());

        let txt = ReadTool
            .execute(json!({ "file_path": "note.txt" }), &ctx)
            .await;
        assert!(!txt.is_error);
        assert!(txt.image_urls.is_empty());
        assert!(txt.text.contains("hello"));
    }

    #[test]
    fn only_the_uploads_prefix_uses_the_session_base() {
        let f = UploadsFixture::new("prefix");
        // A sibling directory of uploads must NOT inherit the session base, or
        // `<sessionDir>/messages/<sid>.messages.ndjson` would become readable
        // through this door. It resolves against the workspace instead.
        let sibling = resolve_safe_with(&f.workspace, &f.roots(), "messages/x.ndjson").unwrap();
        assert_eq!(sibling, f.workspace.join("messages").join("x.ndjson"));
        assert_ne!(
            sibling,
            f.session_dir.join("messages").join("x.ndjson"),
            "session-relative base must apply to uploads/ only"
        );
        // `./uploads/...` is the same reference with a leading `./`.
        let got = resolve_safe_with(&f.workspace, &f.roots(), "./uploads/report.txt").unwrap();
        assert_eq!(got, f.uploads().join("report.txt"));
    }

    #[test]
    fn readonly_tools_pass_extra_roots_but_write_tools_do_not() {
        // Source-level guard: the four read-only tools must route through
        // `resolve_safe_with(..., &readonly_extra_roots(ctx), ...)`, while
        // write/edit must keep the strict `resolve_safe`. A future edit that
        // hands write the extra roots would silently let the model write into
        // the harness home.
        let src = include_str!("mod.rs");

        fn execute_body(src: &str, tool: &str) -> String {
            let start = src.find(tool).unwrap_or_else(|| panic!("{} not found", tool));
            let rest = &src[start..];
            let exec = rest
                .find("async fn execute")
                .unwrap_or_else(|| panic!("{} has no execute", tool));
            // The execute body ends at the next top-level item; 2500 chars is
            // comfortably past it and well short of the next impl.
            rest[exec..(exec + 2500).min(rest.len())]
                .lines()
                .filter(|l| !l.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n")
        }

        for tool in [
            "impl Tool for ReadTool",
            "impl Tool for GlobTool",
            "impl Tool for GrepTool",
            "impl Tool for LsTool",
        ] {
            let body = execute_body(src, tool);
            let calls: Vec<&str> = body.lines().filter(|l| l.contains("resolve_safe")).collect();
            assert!(!calls.is_empty(), "{} never resolves a path", tool);
            assert!(
                calls.iter().all(|l| l.contains("resolve_safe_with") && l.contains("readonly_extra_roots")),
                "{} must resolve via resolve_safe_with + readonly_extra_roots, got {:?}",
                tool,
                calls
            );
        }

        for tool in ["impl Tool for WriteTool", "impl Tool for EditTool"] {
            let body = execute_body(src, tool);
            assert!(
                !body.contains("readonly_extra_roots"),
                "{} must NOT be given the extra read roots (write stays workspace-bound)",
                tool
            );
            assert!(
                body.contains("resolve_safe("),
                "{} must keep the strict workspace-bound resolve_safe",
                tool
            );
        }
    }

    // ─── memory_prune scoping ────────────────────────────────────────────────

    /// Build a context whose `session_dir` implies a project root, so
    /// `memory_store()` resolves to the **workspace** store rather than global.
    ///
    /// Layout mirrors the real one: `<root>/.gwork/sessions/<sid>` — `project_root`
    /// walks up three levels from `session_dir`.
    fn project_ctx(root: &Path, sid: &str) -> ToolContext {
        ToolContext {
            workspace: root.to_path_buf(),
            session_dir: Some(root.join(".gwork").join("sessions").join(sid)),
            session_id: sid.into(),
            tool_call_id: "call-1".into(),
            run_id: "run-1".into(),
            frame_tx: None,
            access_mode: "full".into(),
            cancel: tokio_util::sync::CancellationToken::new(),
            hitl_approved: true,
            change_ledger: None,
            gate: None,
            subagent_depth: 0,
            root_session_id: sid.into(),
            thinking: None,
            model: Default::default(),
            settings: Default::default(),
            bash_exempt_dirs: Vec::new(),
        }
    }

    fn entry(key: &str) -> crate::memory::MemoryEntry {
        crate::memory::MemoryEntry {
            key: key.to_string(),
            title: format!("title of {}", key),
            content: format!("body of {}", key),
            importance: 5,
            time: crate::memory::now_string(),
            ttl: -1,
            ttl_known: false,
            expires_at_epoch_ms: None,
        }
    }

    /// `memory_prune` must delete from the **project** store, the same one
    /// `memory_extract` writes to.
    ///
    /// It used to call `MemoryStore::global()`, which made it the odd one out in
    /// the family. The user-visible failure was two-sided: pruning a memory the
    /// agent had just written in this project reported "Memory not found" (wrong
    /// store), and a key that happened to exist globally was deleted from the
    /// global store — cross-project data loss from a tool the model believed was
    /// workspace-scoped.
    #[tokio::test]
    async fn memory_prune_deletes_from_the_project_store() {
        let s = Scratch::new("mem-prune-scope");
        let root = s.0.clone();
        let project = crate::memory::MemoryStore::workspace(&root);
        project.store(&entry("proj_key")).expect("write project memory");
        assert_eq!(project.count(), 1, "fixture must have written the entry");

        let ctx = project_ctx(&root, "work-mem");
        // Sanity: the context really does resolve to the project store. If this
        // ever fails the test below would pass for the wrong reason.
        assert_eq!(ctx.memory_store().dir(), project.dir());

        let out = MemoryPruneTool
            .execute(serde_json::json!({ "key": "proj_key" }), &ctx)
            .await;

        assert!(!out.is_error, "prune must find the project memory: {}", out.text);
        assert!(out.text.contains("proj_key"), "{}", out.text);
        assert_eq!(project.count(), 0, "the project entry must be gone");
    }

    // ─── memory_consolidate ─────────────────────────────────────────────────
    //
    // The load-bearing property is atomicity: the evolved insight is written
    // BEFORE any old fragment is deleted, and every validation rejection leaves
    // the fragments untouched. A half-applied merge would lose data with nothing
    // to show for it.

    #[tokio::test]
    async fn consolidate_merges_fragments_into_one_evolved_insight() {
        let s = Scratch::new("mem-consolidate-ok");
        let root = s.0.clone();
        let store = crate::memory::MemoryStore::workspace(&root);
        for k in ["frag_a", "frag_b"] {
            store.store(&entry(k)).expect("seed fragment");
        }
        assert_eq!(store.count(), 2);

        let ctx = project_ctx(&root, "work-cons");
        let out = MemoryConsolidateTool
            .execute(
                serde_json::json!({
                    "keys_to_merge": ["frag_a", "frag_b"],
                    "new_key": "evolved",
                    "new_title": "Evolved preference model",
                    "evolved_insight": "the user prefers X over Y"
                }),
                &ctx,
            )
            .await;

        assert!(!out.is_error, "{}", out.text);
        assert!(out.text.contains("心智进化成功"), "{}", out.text);
        // Two fragments gone, one insight written.
        assert_eq!(store.count(), 1, "fragments must be pruned, insight kept");
        let merged = store.search("evolved", 10);
        assert_eq!(merged.len(), 1);
        // Importance 10 and the marker match Java so both kernels agree on a
        // shared store.
        assert_eq!(merged[0].importance, 10);
        assert!(merged[0].content.starts_with("[Evolved Insight] "), "{}", merged[0].content);
        assert!(merged[0].content.contains("prefers X over Y"));
    }

    #[tokio::test]
    async fn consolidate_rejects_empty_new_key_and_keeps_fragments() {
        let s = Scratch::new("mem-consolidate-nokey");
        let root = s.0.clone();
        let store = crate::memory::MemoryStore::workspace(&root);
        store.store(&entry("frag_a")).unwrap();

        let ctx = project_ctx(&root, "work-cons");
        let out = MemoryConsolidateTool
            .execute(
                serde_json::json!({
                    "keys_to_merge": ["frag_a"], "new_key": "  ",
                    "new_title": "t", "evolved_insight": "i"
                }),
                &ctx,
            )
            .await;
        assert!(out.text.contains("new_key 不能为空"), "{}", out.text);
        assert!(
            out.is_error,
            "a rejected merge must carry is_error=true — with ok the model read \
             the 【合并异常】 wording as success and never reconsidered (review P2)"
        );
        assert_eq!(store.count(), 1, "a rejected merge must not touch the fragments");
    }

    #[tokio::test]
    async fn consolidate_rejects_when_new_key_is_in_the_merge_set() {
        let s = Scratch::new("mem-consolidate-selfref");
        let root = s.0.clone();
        let store = crate::memory::MemoryStore::workspace(&root);
        store.store(&entry("frag_a")).unwrap();

        let ctx = project_ctx(&root, "work-cons");
        let out = MemoryConsolidateTool
            .execute(
                serde_json::json!({
                    "keys_to_merge": ["frag_a", "evolved"], "new_key": "evolved",
                    "new_title": "t", "evolved_insight": "i"
                }),
                &ctx,
            )
            .await;
        assert!(out.text.contains("不得包含 new_key"), "{}", out.text);
        assert!(out.is_error, "self-referential merge is a rejection, hence an error");
        assert_eq!(store.count(), 1, "self-referential merge must be refused whole");
    }

    #[tokio::test]
    async fn consolidate_rejects_empty_merge_list() {
        let s = Scratch::new("mem-consolidate-empty");
        let root = s.0.clone();
        let store = crate::memory::MemoryStore::workspace(&root);
        store.store(&entry("frag_a")).unwrap();

        let ctx = project_ctx(&root, "work-cons");
        // Empty array.
        let out = MemoryConsolidateTool
            .execute(
                serde_json::json!({
                    "keys_to_merge": [], "new_key": "evolved",
                    "new_title": "t", "evolved_insight": "i"
                }),
                &ctx,
            )
            .await;
        assert!(out.text.contains("keys_to_merge 不能为空"), "{}", out.text);
        assert!(out.is_error, "empty merge list is a rejection, hence an error");
        // Only-blank values.
        let out2 = MemoryConsolidateTool
            .execute(
                serde_json::json!({
                    "keys_to_merge": ["", "   "], "new_key": "evolved",
                    "new_title": "t", "evolved_insight": "i"
                }),
                &ctx,
            )
            .await;
        assert!(out2.text.contains("不得只包含空值"), "{}", out2.text);
        assert_eq!(store.count(), 1, "no insight written on a rejected merge");
    }

    #[tokio::test]
    async fn consolidate_reports_partial_success_when_a_fragment_is_missing() {
        let s = Scratch::new("mem-consolidate-partial");
        let root = s.0.clone();
        let store = crate::memory::MemoryStore::workspace(&root);
        store.store(&entry("frag_a")).unwrap();
        // frag_b is deliberately absent.

        let ctx = project_ctx(&root, "work-cons");
        let out = MemoryConsolidateTool
            .execute(
                serde_json::json!({
                    "keys_to_merge": ["frag_a", "frag_b"], "new_key": "evolved",
                    "new_title": "t", "evolved_insight": "i"
                }),
                &ctx,
            )
            .await;
        assert!(out.text.contains("部分成功"), "{}", out.text);
        // Deliberately NOT is_error: the insight IS persisted; an error flag would
        // make the model re-run the whole merge and write a second copy.
        assert!(!out.is_error, "partial success must stay ok — retry would double-write the insight");
        assert!(out.text.contains("frag_b"), "the missing key must be named: {}", out.text);
        // frag_a pruned, evolved written, frag_b never existed → 1 entry.
        assert_eq!(store.count(), 1);
    }

    #[tokio::test]
    async fn consolidate_dedupes_repeated_keys() {
        let s = Scratch::new("mem-consolidate-dedup");
        let root = s.0.clone();
        let store = crate::memory::MemoryStore::workspace(&root);
        store.store(&entry("frag_a")).unwrap();

        let ctx = project_ctx(&root, "work-cons");
        let out = MemoryConsolidateTool
            .execute(
                serde_json::json!({
                    "keys_to_merge": ["frag_a", "frag_a", "frag_a"], "new_key": "evolved",
                    "new_title": "t", "evolved_insight": "i"
                }),
                &ctx,
            )
            .await;
        // The success message counts the de-duplicated set (1), not the raw 3.
        assert!(out.text.contains("删除了1条"), "{}", out.text);
    }

    #[tokio::test]
    async fn consolidate_reports_failure_and_keeps_fragments_when_the_write_cannot_land() {
        // The load-bearing half of the atomicity contract: when writing the evolved
        // insight fails, the tool must say so AND leave the old fragments untouched.
        // A "success" here would be the worst outcome — the fragments would be
        // pruned against an insight that never persisted, losing data with nothing
        // to show for it.
        let s = Scratch::new("mem-consolidate-iofail");
        let root = s.0.clone();
        let store = crate::memory::MemoryStore::workspace(&root);
        store.store(&entry("frag_a")).unwrap();
        assert_eq!(store.count(), 1, "fixture must have seeded one fragment");

        // Fault injection: make ONLY the evolved insight's destination
        // (`shared__evolved.md`) unwritable, by putting a non-empty directory there.
        // `MemoryStore::store` writes a `.tmp` then `fs::rename`s it onto the target;
        // renaming a file onto a non-empty directory fails on every platform, so
        // `store()` returns Err deterministically. frag_a sits beside it as an
        // ordinary file and is never touched — which is exactly what the assertion
        // below needs, since the whole point is that a failed write leaves the
        // fragments intact. (An earlier version blocked the memory dir itself, but
        // that also removed frag_a, so the test proved nothing about preservation.)
        let mem_dir = root.join(".gwork").join("memory");
        let evolved_target = mem_dir.join("shared__evolved.md");
        std::fs::create_dir_all(evolved_target.join("blocker")).unwrap();
        // Sanity: the fixture is what we think — frag_a is present as a file.
        assert!(mem_dir.join("shared__frag_a.md").is_file(), "fixture must have frag_a on disk");

        let ctx = project_ctx(&root, "work-cons");
        let out = MemoryConsolidateTool
            .execute(
                serde_json::json!({
                    "keys_to_merge": ["frag_a"], "new_key": "evolved",
                    "new_title": "t", "evolved_insight": "i"
                }),
                &ctx,
            )
            .await;
        assert!(out.text.contains("写入失败"), "a failed write must be reported: {}", out.text);
        assert!(!out.text.contains("心智进化成功"), "must not claim success: {}", out.text);

        // The fragment must survive untouched: the failed write aborted BEFORE any
        // prune. Read it straight off disk (the store dir now holds a bogus
        // subdirectory, so go through the file, not load_all).
        let store2 = crate::memory::MemoryStore::workspace(&root);
        assert!(
            store2.search("frag_a", 10).iter().any(|e| e.key == "frag_a"),
            "the fragment must be untouched after a failed consolidate"
        );
    }

    /// All four memory tools must resolve the **same** store.
    ///
    /// This is the invariant whose violation was the bug, pinned as a source-level
    /// guard rather than a behavioural test on purpose: `MemoryStore::global()`
    /// points at the developer's real `~/.gwork/memory` and cannot be redirected,
    /// so a behavioural test of the global path would write into (and could leave
    /// residue in) the user's actual data if an assertion failed mid-test.
    ///
    /// The guard reads this file via `include_str!`, so there is no path to get
    /// wrong and it cannot silently check a stale copy.
    #[test]
    fn every_memory_tool_resolves_the_project_store() {
        let src = include_str!("mod.rs");

        /// The `execute` body of one tool impl, with comments stripped.
        ///
        /// Two details make this correct rather than accidentally passing:
        ///
        /// 1. The window ends at the **next** `impl Tool for`, not after a fixed
        ///    character count. A fixed window bleeds into the following tool, so
        ///    the assertion would be testing two tools at once and attributing
        ///    one's code to the other.
        /// 2. Comments are stripped before matching. The fix for this very bug
        ///    carries a comment naming `MemoryStore::global()` to explain what
        ///    changed — without stripping, that explanatory text trips the
        ///    negative assertion and the test fails while the code is correct.
        ///    (Stripping also prevents the opposite error: a call that exists
        ///    only inside a comment would satisfy a positive assertion.)
        fn execute_body(src: &str, tool: &str) -> String {
            let start = src
                .find(tool)
                .unwrap_or_else(|| panic!("{} not found in source", tool));
            let rest = &src[start + tool.len()..];
            // Bound at the next tool impl so the window is this tool alone.
            let end = rest.find("impl Tool for").unwrap_or(rest.len());
            let body = &rest[..end];
            strip_line_comments(body)
        }

        /// Remove `//` line comments, respecting string literals so a `"//"`
        /// inside a string does not swallow the rest of the file.
        fn strip_line_comments(src: &str) -> String {
            let mut out = String::with_capacity(src.len());
            let mut in_string = false;
            let mut escaped = false;
            let mut chars = src.chars().peekable();
            while let Some(c) = chars.next() {
                if in_string {
                    out.push(c);
                    if escaped {
                        escaped = false;
                    } else if c == '\\' {
                        escaped = true;
                    } else if c == '"' {
                        in_string = false;
                    }
                    continue;
                }
                match c {
                    '"' => {
                        in_string = true;
                        out.push(c);
                    }
                    '/' if chars.peek() == Some(&'/') => {
                        // Skip to end of line.
                        while let Some(n) = chars.next() {
                            if n == '\n' {
                                out.push(n);
                                break;
                            }
                        }
                    }
                    _ => out.push(c),
                }
            }
            out
        }

        for tool in [
            "impl Tool for MemoryExtractTool",
            "impl Tool for MemorySearchTool",
            "impl Tool for MemoryRecallTool",
            "impl Tool for MemoryPruneTool",
            "impl Tool for MemoryConsolidateTool",
        ] {
            let body = execute_body(src, tool);
            assert!(
                body.contains("ctx.memory_store()"),
                "{} must resolve the project-scoped store via ctx.memory_store(); body was: {}",
                tool,
                &body[..body.len().min(400)]
            );
            assert!(
                !body.contains("MemoryStore::global()"),
                "{} must not reach for the global store directly — that is the \
                 cross-project deletion bug",
                tool
            );
        }
    }

    /// The guard's window must actually cover the tool's body. Without this the
    /// assertions above could pass vacuously on an empty slice.
    ///
    /// Note the `marker.len()` offset: `rest` *begins* with `"impl Tool for"`, so
    /// searching for the next occurrence without skipping the marker finds it at
    /// offset 0 and yields an empty window — every `contains` then fails and every
    /// `!contains` silently passes.
    #[test]
    fn comment_stripping_keeps_code_and_respects_strings() {
        let src = include_str!("mod.rs");
        let marker = "impl Tool for MemoryPruneTool";
        let start = src.find(marker).unwrap();
        let rest = &src[start + marker.len()..];
        let end = rest.find("impl Tool for").unwrap_or(rest.len());
        let body = &rest[..end];

        assert!(!body.is_empty(), "the window must cover the tool body");
        // The raw window really does contain the explanatory comment, so stripping
        // is doing real work rather than being a no-op.
        assert!(
            body.contains("MemoryStore::global()"),
            "expected the fix's explanatory comment to mention the old call"
        );
        assert!(body.contains("ctx.memory_store()"), "expected the fixed call");
    }


    // ─── PowerShell transport (prepare_powershell) ───────────────────────────

    /// Decode the base64 payload of an `-EncodedCommand` argv back into the
    /// UTF-16LE string PowerShell will actually run.
    fn decode_encoded_command(argv: &[std::ffi::OsString]) -> String {
        use base64::Engine;
        let i = argv
            .iter()
            .position(|a| a == "-EncodedCommand")
            .expect("no -EncodedCommand in argv");
        let b64 = argv[i + 1].to_str().unwrap();
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
        let u16s: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16(&u16s).unwrap()
    }

    /// A short command must go the `-EncodedCommand` route: no file, no
    /// ExecutionPolicy dependency, exact `-Command` exit-code semantics.
    #[test]
    fn prepare_powershell_short_uses_encoded_command() {
        let command = "Get-Location";
        let p = prepare_powershell(command).unwrap();
        let argv_str: Vec<String> = p.argv.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(argv_str[0], "powershell");
        assert!(argv_str.contains(&"-NoProfile".to_string()), "{:?}", argv_str);
        assert!(argv_str.contains(&"-NonInteractive".to_string()), "{:?}", argv_str);
        assert!(!argv_str.contains(&"-Command".to_string()), "must not use -Command: {:?}", argv_str);
        assert!(p.temp_script.is_none(), "encoded path must not touch the disk");

        let full = decode_encoded_command(&p.argv);
        assert!(full.starts_with(POWERSHELL_PREAMBLE), "preamble missing: {:?}", &full[..40]);
        assert!(full.ends_with(command), "command not appended verbatim: {:?}", full);
    }

    /// Over-long commands fall back to a BOM-prefixed .ps1 with policy bypass.
    #[test]
    fn prepare_powershell_long_falls_back_to_ps1() {
        // Each char is 2 UTF-16 bytes -> base64 grows ~2.7x per char, so 40k
        // chars is far past MAX_ENCODED_COMMAND_CHARS.
        let command = "a".repeat(40_000);
        let p = prepare_powershell(&command).unwrap();
        let argv_str: Vec<String> = p.argv.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(argv_str.iter().any(|a| a == "-File"), "{:?}", &argv_str[..4]);
        assert!(argv_str.iter().any(|a| a == "-ExecutionPolicy"), "{:?}", argv_str);
        assert!(argv_str.iter().any(|a| a == "Bypass"), "{:?}", argv_str);
        assert!(!argv_str.iter().any(|a| a == "-EncodedCommand"), "{:?}", argv_str);

        let script = p.temp_script.clone().expect("long path must write a script");
        assert!(script.exists(), "script not written: {:?}", script);
        let bytes = std::fs::read(&script).unwrap();
        assert_eq!(&bytes[..3], &[0xEF, 0xBB, 0xBF], "PS 5.1 needs the UTF-8 BOM");
        assert!(String::from_utf8_lossy(&bytes[3..]).ends_with(&command));
        // Java's createTempScript path is absolute; -File resolves against the
        // child's cwd, so an absolute path is a hard requirement.
        assert!(script.is_absolute(), "{:?}", script);

        let _ = std::fs::remove_file(&script);
        assert!(!script.exists());
    }

    /// The preamble is what normalizes encoding; it must prefix every payload.
    #[test]
    fn prepare_powershell_preamble_is_prepended() {
        let p = prepare_powershell("Write-Output $env:TEMP").unwrap();
        let full = decode_encoded_command(&p.argv);
        assert!(full.starts_with(POWERSHELL_PREAMBLE));
        // Sanity on the preamble itself: these are the four decision points the
        // Java javadoc enumerates, any of them missing reintroduces a class of
        // garbling that no decoder downstream can repair.
        for want in [
            "$OutputEncoding = New-Object System.Text.UTF8Encoding $false",
            "[Console]::OutputEncoding",
            "[Console]::InputEncoding",
            "$PSDefaultParameterValues",
            "Get-Content",
            "Out-File",
        ] {
            assert!(POWERSHELL_PREAMBLE.contains(want), "preamble missing {want}");
        }
    }

    /// Non-ASCII must survive the round trip: this is one of the two defects the
    /// transport change exists to fix (the old path lost characters).
    #[test]
    fn prepare_powershell_preserves_non_ascii() {
        let command = "Write-Output \"中文 — émoji 😀\"";
        let p = prepare_powershell(command).unwrap();
        let full = decode_encoded_command(&p.argv);
        assert!(full.ends_with(command), "got: {:?}", full);
    }

    /// The guard must delete the script exactly once and tolerate an empty one
    /// (the -EncodedCommand path has no file to clean).
    #[test]
    fn temp_script_guard_removes_the_file() {
        let dir = std::env::temp_dir().join(format!("gwork-guard-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("dropped.ps1");
        std::fs::write(&f, "x").unwrap();
        {
            let _g = TempScriptGuard(Some(f.clone()));
            assert!(f.exists(), "guard must not delete eagerly");
        }
        assert!(!f.exists(), "guard did not delete");
        drop(TempScriptGuard(None)); // no-op, must not panic
        drop(TempScriptGuard(Some(dir.join("never-existed.ps1")))); // tolerate
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// TempScriptGuard::new is the constructor server::execute_approved_command
    /// uses (the tuple field stays private). It must behave identically to the
    /// in-module tuple constructor: None is a silent no-op, Some(path)
    /// deletes exactly on drop, and a missing path is tolerated.
    #[test]
    fn temp_script_guard_new_ctor_removes_on_drop() {
        let dir = std::env::temp_dir().join(format!("gwork-guard-new-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("dropped.ps1");
        std::fs::write(&f, "x").unwrap();
        {
            let _g = TempScriptGuard::new(Some(f.clone()));
            assert!(f.exists(), "new() must not delete eagerly");
        }
        assert!(!f.exists(), "new() guard did not delete on drop");
        drop(TempScriptGuard::new(None)); // must not panic
        drop(TempScriptGuard::new(Some(dir.join("missing.ps1")))); // tolerated
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The items the server reuses must be crate-visible, otherwise
    /// execute_approved_command could not build the same transport.
    #[test]
    fn prepared_ps_fields_are_reachable_from_server() {
        let p = prepare_powershell("Get-Date").unwrap();
        let _argv: &[std::ffi::OsString] = &p.argv;
        let _temp: Option<std::path::PathBuf> = p.temp_script;
        let _g = TempScriptGuard::new(_temp);
    }

// ─── todowrite / todoread contract tests ─────────────────────────────────────
//
// End-to-end guards for the checklist defect these tools used to ship: a
// JSON-envelope argument was written verbatim, so TODO.md became one long line;
// `/web/chat/todos` then parsed 0 items, the panel's task chip blinked out, and
// the tool answered "[继续] 还有未完成事项" — an instruction the model could never
// satisfy, so the run worked until it hit max_turns.
//
// These exercise the real tool bodies rather than only `crate::todo`: every one
// of those failures lived in the wiring, not in the parser.

    /// Scratch session directory. `ToolContext::todo_file()` resolves into it,
    /// matching how the kernel routes TODO.md per session.
    struct TodoScratch(ToolContext, PathBuf);

    impl TodoScratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().format_todo_dir(tag);
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let ctx = ToolContext {
                workspace: dir.clone(),
                session_dir: Some(dir.clone()),
                session_id: "work-todo-test".into(),
                tool_call_id: "call-test".into(),
                run_id: "run-test".into(),
                frame_tx: None,
                access_mode: "full".into(),
                cancel: tokio_util::sync::CancellationToken::new(),
                hitl_approved: true,
                change_ledger: None,
                gate: None,
                subagent_depth: 0,
                root_session_id: "work-todo-test".into(),
                thinking: None,
                model: Default::default(),
                settings: Default::default(),
                bash_exempt_dirs: Vec::new(),
            };
            Self(ctx, dir)
        }

        fn todo_path(&self) -> PathBuf {
            // Through the same helper the tools use, so a change to where the
            // checklist lives cannot silently split writer and reader again.
            self.0.todo_file()
        }

        fn saved(&self) -> String {
            std::fs::read_to_string(self.todo_path()).unwrap_or_default()
        }
    }

    impl Drop for TodoScratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.1);
        }
    }

    trait TempDirExt {
        fn format_todo_dir(&self, tag: &str) -> PathBuf;
    }
    impl TempDirExt for PathBuf {
        fn format_todo_dir(&self, tag: &str) -> PathBuf {
            self.join(format!(
                "gwork-todo-{}-{}-{}",
                tag,
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.subsec_nanos())
                    .unwrap_or(0)
            ))
        }
    }

    async fn write_todos(s: &TodoScratch, todos: serde_json::Value) -> String {
        TodoWriteTool
            .execute(json!({ "todos": todos }), &s.0)
            .await
            .text
    }

    /// The JSON envelope found in 26 of 405 real TODO.md files: repaired before
    /// it reaches disk, so the panel and the footer see the true item count.
    #[tokio::test]
    async fn todowrite_repairs_a_json_envelope_before_writing() {
        let s = TodoScratch::new("envelope");
        let dirty = "[{\"todos\": \"- [x] 现场取证\\n- [ ] 代码取证\"}]";
        let result = write_todos(&s, serde_json::json!(dirty)).await;

        let saved = s.saved();
        assert_eq!(2, crate::todo::count_checkbox_lines(&saved), "{saved}");
        assert!(saved.contains('\n'), "still one line: {saved}");
        assert!(!saved.contains("\"todos\""), "envelope left behind: {saved}");
        assert!(result.contains("total: 2"), "{result}");
        assert!(!result.contains("[格式警告]"), "{result}");
    }

    /// The exact defect: an argument with no recognisable task line must not be
    /// answered with "[继续]", which the old code did anyway.
    #[tokio::test]
    async fn todowrite_reports_a_format_warning_instead_of_a_false_continue() {
        let s = TodoScratch::new("warn");
        let result = write_todos(&s, serde_json::json!("随便一句话，没有任务行")).await;

        assert!(result.contains("[格式警告]"), "{result}");
        assert!(result.contains("total: 0"), "{result}");
        assert!(!result.contains("[继续]"), "unsatisfiable push is back: {result}");
        assert!(!result.contains("[完成]"), "{result}");
    }

    /// An empty argument used to truncate TODO.md and still report success:
    /// list destroyed, progress zeroed, no warning. The file must be untouched.
    #[tokio::test]
    async fn todowrite_refuses_to_destroy_the_list_with_an_empty_argument() {
        let s = TodoScratch::new("empty");
        let keep = "- [ ] 原有任务\n";
        std::fs::write(s.todo_path(), keep).unwrap();

        for blank in ["", "   \n  "] {
            let result = write_todos(&s, serde_json::json!(blank)).await;
            assert!(result.contains("TODO not saved"), "{result}");
            assert!(result.contains("[格式警告]"), "{result}");
            assert_eq!(keep, s.saved(), "list clobbered by {:?}", blank);
        }
    }

    /// A missing `todos` key took the `unwrap_or_default()` path, so an argument
    /// glitch alone could erase a checklist.
    #[tokio::test]
    async fn todowrite_treats_a_missing_argument_as_empty() {
        let s = TodoScratch::new("missing");
        std::fs::write(s.todo_path(), "- [ ] 保留\n").unwrap();

        let out = TodoWriteTool.execute(json!({}), &s.0).await;
        assert!(out.text.contains("TODO not saved"), "{}", out.text);
        assert!(out.is_error, "an invalid argument must not read as success");
        assert_eq!("- [ ] 保留\n", s.saved());
    }

    /// Normalisation must never rewrite work that is already correct.
    #[tokio::test]
    async fn todowrite_leaves_a_correct_checklist_untouched() {
        let s = TodoScratch::new("clean");
        let ok = "## 阶段\n- [x] 已完成\n- [/] 进行中\n- [ ] 待办\n";
        let result = write_todos(&s, serde_json::json!(ok)).await;

        assert_eq!(ok, s.saved());
        assert!(result.contains("total: 3"), "{result}");
        assert!(result.contains("[继续] 还有 2 项未完成"), "{result}");
        assert!(result.contains("[待办首项] 进行中"), "{result}");
    }

    /// Literal `\r\n` sequences collapse into real lines the panel can read.
    #[tokio::test]
    async fn todowrite_repairs_literal_crlf_sequences() {
        let s = TodoScratch::new("crlf");
        let result = write_todos(&s, serde_json::json!("- [x] A\\r\\n- [ ] B")).await;

        let saved = s.saved();
        assert!(!saved.contains("\\n"), "literal newline survived: {saved}");
        assert_eq!(2, crate::todo::count_checkbox_lines(&saved), "{saved}");
        assert!(result.contains("total: 2"), "{result}");
    }

    /// The primary contract: a JSON array of item objects writes straight
    /// through to Markdown, statuses mapped, groups emitted as headings.
    #[tokio::test]
    async fn todowrite_accepts_a_json_array_argument() {
        let s = TodoScratch::new("array");
        let result = write_todos(
            &s,
            json!([
                {"content": "现场取证", "status": "done"},
                {"content": "代码取证", "status": "in_progress", "header": "取证"},
                {"content": "补测试", "status": "pending"}
            ]),
        )
        .await;

        let saved = s.saved();
        assert_eq!(3, crate::todo::count_checkbox_lines(&saved), "{saved}");
        assert!(saved.contains("## 取证"), "{saved}");
        assert!(saved.contains("- [x] 现场取证"), "{saved}");
        assert!(saved.contains("- [/] 代码取证"), "{saved}");
        assert!(result.contains("total: 3"), "{result}");
        assert!(!result.contains("[格式警告]"), "{result}");
    }

    /// The screenshot defect end to end: a degenerate envelope whose items are
    /// placeholders must not yield an invented task row, and the progress note
    /// it carries must survive.
    #[tokio::test]
    async fn todowrite_drops_placeholder_items_and_keeps_the_note() {
        let s = TodoScratch::new("placeholder");
        let result = write_todos(
            &s,
            json!([{"todos_note": "承接自审：已完成 6 项，继续剩余 5 项", "content": "placeholder", "id": "x"}]),
        )
        .await;

        let saved = s.saved();
        assert!(saved.contains("承接自审"), "{saved}");
        assert!(!saved.to_lowercase().contains("placeholder"), "{saved}");
        assert!(result.contains("total: 0"), "{result}");
    }

    /// Read-side self-healing: a checklist stored as a JSON envelope by an
    /// older kernel is repaired in place, so the model and the panel see the
    /// same real list instead of "empty".
    #[tokio::test]
    async fn todoread_heals_a_stored_json_envelope_in_place() {
        let s = TodoScratch::new("heal");
        std::fs::write(
            s.todo_path(),
            r#"[{"content": "读取源码", "status": "done"}, {"content": "补测试", "status": "pending"}]"#,
        )
        .unwrap();

        let out = TodoReadTool.execute(json!({}), &s.0).await;
        assert!(out.text.contains("[进度] total: 2"), "{}", out.text);
        assert!(out.text.contains("- [x] 读取源码"), "{}", out.text);
        let saved = s.saved();
        assert_eq!(2, crate::todo::count_checkbox_lines(&saved), "{saved}");
    }

    /// `todoread` carries the same footer as `todowrite`: the model decides
    /// whether it may stop from that footer, so the two must not disagree.
    #[tokio::test]
    async fn todoread_appends_the_progress_footer() {
        let s = TodoScratch::new("read");
        std::fs::write(s.todo_path(), "- [x] A\n- [ ] B\n").unwrap();

        let out = TodoReadTool.execute(json!({}), &s.0).await;
        assert!(out.text.contains("[进度] total: 2"), "{}", out.text);
        assert!(out.text.contains("[继续]"), "{}", out.text);
        assert!(out.text.contains("- [ ] B"), "{}", out.text);
    }

    /// No checklist yet is a normal state, not a failure.
    #[tokio::test]
    async fn todoread_on_a_missing_file_is_not_an_error() {
        let s = TodoScratch::new("noread");
        let out = TodoReadTool.execute(json!({}), &s.0).await;
        assert!(!out.is_error);
        assert!(out.text.contains("todowrite"), "{}", out.text);
    }

    /// Upstream cause of the malformed files: a model never told the line syntax
    /// reproduces the JSON shape it has seen everywhere else.
    #[test]
    fn todowrite_parameter_description_states_the_format_contract() {
        let desc = TodoWriteTool.parameters_schema()["properties"]["todos"]["description"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        assert!(desc.contains("[ ]") && desc.contains("[x]"), "{desc}");
        assert!(desc.to_lowercase().contains("markdown"), "{desc}");
        assert!(desc.contains("JSON"), "envelope not discouraged: {desc}");
    }

    /// Both system prompts must carry the guide; a model running the other
    /// locale would otherwise never see the rules.
    #[test]
    fn system_prompts_carry_the_planning_guide() {
        let en = crate::react::prompt::build_system_prompt(
            &crate::config::Settings::default(),
            "/tmp/ws",
        );
        let mut cn_settings = crate::config::Settings::default();
        cn_settings.general.locale = "zh-CN".into();
        let cn = crate::react::prompt::build_system_prompt(&cn_settings, "/tmp/ws");

        assert!(en.contains("Task Planning Guide"), "EN guide missing");
        assert!(cn.contains("任务规划指南"), "CN guide missing");
        // The format contract is the whole point.
        assert!(en.contains("[ ]") && cn.contains("[ ]"));
    }

    // ─── skillsearch matching ───────────────────────────────────────────────

    fn skill(name: &str, title: &str, desc: &str, enabled: bool) -> crate::skills::Skill {
        crate::skills::Skill {
            name: name.to_string(),
            title: title.to_string(),
            description: desc.to_string(),
            enabled,
            version: None,
            scope: crate::skills::SkillScope::Global,
            dir: PathBuf::from("/tmp/x"),
            market: None,
        }
    }

    #[test]
    fn skillsearch_matches_any_token_across_name_title_description() {
        let skills = vec![
            skill("deep-research", "Deep Research", "multi-step web investigation", true),
            skill("pdf-tools", "PDF", "extract text from documents", true),
        ];
        // Matches on name.
        assert_eq!(search_skills(&skills, "research").len(), 1);
        // Matches on description.
        assert_eq!(search_skills(&skills, "documents").len(), 1);
        // Matches on title.
        assert_eq!(search_skills(&skills, "pdf").len(), 1);
    }

    #[test]
    fn skillsearch_is_case_insensitive_and_space_separated() {
        let skills = vec![skill("deep-research", "Deep Research", "web investigation", true)];
        assert_eq!(search_skills(&skills, "RESEARCH").len(), 1);
        // Any token matching is enough (Java: anyMatch).
        assert_eq!(search_skills(&skills, "zzz research").len(), 1);
        assert_eq!(search_skills(&skills, "zzz yyy").len(), 0);
    }

    #[test]
    fn skillsearch_excludes_disabled_skills() {
        // A disabled skill must not reach the model, same rule as skillread.
        let skills = vec![skill("secret", "Secret", "hidden capability", false)];
        assert!(search_skills(&skills, "secret").is_empty());
    }

    #[test]
    fn skillsearch_caps_at_fifteen() {
        let skills: Vec<_> = (0..30)
            .map(|i| skill(&format!("tool-{i}"), "t", "common keyword", true))
            .collect();
        assert_eq!(search_skills(&skills, "keyword").len(), 15);
    }

    #[test]
    fn skillsearch_empty_query_matches_nothing() {
        let skills = vec![skill("a", "A", "desc", true)];
        assert!(search_skills(&skills, "").is_empty());
        assert!(search_skills(&skills, "   ").is_empty());
    }

    // ─── recall_history matching ────────────────────────────────────────────

    fn msg(role: &str, body: &str, created_at: i64) -> crate::session::StoredMessage {
        crate::session::StoredMessage {
            role: role.to_string(),
            content: body.to_string(),
            text: None,
            blocks: None,
            created_at,
            metadata: None,
        }
    }

    #[test]
    fn recall_history_matches_keyword_case_insensitively() {
        let msgs = vec![
            msg("USER", "deploy the Kubernetes cluster", 1),
            msg("ASSISTANT", "unrelated reply", 2),
        ];
        let hits = search_history(&msgs, "kubernetes", 3);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].body().contains("Kubernetes"));
    }

    #[test]
    fn recall_history_returns_newest_first_and_respects_limit() {
        // Stored oldest→newest; the tool must surface the most recent mentions
        // first and cap at `limit`.
        let msgs = vec![
            msg("USER", "token A first", 1000),
            msg("ASSISTANT", "token A second", 2000),
            msg("USER", "token A third", 3000),
        ];
        let hits = search_history(&msgs, "token", 2);
        assert_eq!(hits.len(), 2);
        assert!(hits[0].body().contains("third"), "newest must come first");
        assert!(hits[1].body().contains("second"));
    }

    #[test]
    fn recall_history_skips_pending_notices_and_empty_bodies() {
        // `is_pending_notice` is an EXACT match on the suspension placeholder text
        // ("等待用户回答" / "敏感操作，需要人工介入确认"), not a substring test. So the
        // query must be a substring of that exact text for the placeholder to be a
        // candidate at all — which is precisely why it needs filtering: without it,
        // searching "等待" would surface a UI placeholder as if it were content.
        let msgs = vec![
            msg("ASSISTANT", "等待用户回答", 1), // exact pending notice
            msg("USER", "", 2),                  // empty body
            msg("USER", "等待真正的历史细节", 3), // real content containing the keyword
        ];
        let hits = search_history(&msgs, "等待", 10);
        assert_eq!(hits.len(), 1, "pending notice and empty body must be excluded");
        assert!(hits[0].body().contains("真正的历史细节"), "got: {}", hits[0].body());
    }

    #[test]
    fn recall_history_empty_query_matches_nothing() {
        let msgs = vec![msg("USER", "anything", 1)];
        assert!(search_history(&msgs, "", 3).is_empty());
        assert!(search_history(&msgs, "   ", 3).is_empty());
    }

    #[test]
    fn recall_history_renders_timestamp_prefix_and_separator() {
        // 1_700_000_000_000 ms == 2023-11-14 22:13:20 UTC.
        let m1 = msg("USER", "first fact", 1_700_000_000_000);
        let m2 = msg("USER", "second fact", 1_700_000_060_000);
        let out = format_history_matches(&[&m2, &m1]);
        assert!(out.contains("[2023-11-14 22:13:20] first fact"), "got: {}", out);
        assert!(out.contains("[2023-11-14 22:14:20] second fact"), "got: {}", out);
        assert!(out.contains("\n\n---\n\n"), "matches must be rule-separated: {}", out);
    }

    // ─── add_model: the tool must not be able to wipe settings.json ──────
    //
    // The code review found this tool carried a private `unwrap_or_else(json!({}))`
    // fallback — the exact original defect the three-state guard in
    // `server/settings_api` exists to prevent, reintroduced on a path the HTTP
    // layer does not cover. These tests are behaviour tests against a real
    // isolated home directory: they assert on bytes on disk, not on the guard's
    // source shape.

    /// Point `gwork_home()` at an isolated scratch dir for one test.
    ///
    /// `set_harness_base` mutates a process-global static; tests that use it
    /// must not run in parallel with anything else that resolves the base.
    /// Serialized with a shared mutex to keep that true.
    struct IsolatedHome;

    static HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    impl IsolatedHome {
        fn new(dir: &Path) -> std::sync::MutexGuard<'static, ()> {
            let guard = HOME_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            std::fs::create_dir_all(dir).unwrap();
            crate::config::set_harness_base(Some(dir.to_path_buf()));
            guard
        }
    }

    impl Drop for IsolatedHome {
        fn drop(&mut self) {
            crate::config::set_harness_base(None);
        }
    }

    fn tool_ctx_for(dir: &Path) -> ToolContext {
        ToolContext {
            workspace: dir.to_path_buf(),
            session_dir: None,
            session_id: "work-t".into(),
            tool_call_id: "c1".into(),
            run_id: "r".into(),
            frame_tx: None,
            access_mode: "full".into(),
            cancel: tokio_util::sync::CancellationToken::new(),
            hitl_approved: true,
            change_ledger: None,
            gate: None,
            subagent_depth: 0,
            root_session_id: "work-t".into(),
            thinking: None,
            model: Default::default(),
            settings: Default::default(),
            bash_exempt_dirs: Vec::new(),
        }
    }

    fn add_model_args() -> serde_json::Value {
        json!({
            "apiUrl": "https://api.example.com/v1",
            "apiKey": "sk-test",
            "model": "test-model",
            "name": "test-model"
        })
    }

    #[tokio::test]
    async fn add_model_refuses_to_write_when_settings_json_is_corrupt() {
        let dir = std::env::temp_dir().join(format!("gwork-addmodel-{}", uuid::Uuid::new_v4()));
        let _home = IsolatedHome::new(&dir);
        std::fs::create_dir_all(dir.join(".gwork")).unwrap();
        // Truncated JSON: parses as nothing, but holds real config a write would destroy.
        std::fs::write(
            dir.join(".gwork/settings.json"),
            "{\"providers\":{\"p1\":{\"apiKey\":\"sk-KEEP\"}}", // <- no closing brace
        )
        .unwrap();

        let out = AddModelTool.execute(add_model_args(), &tool_ctx_for(&dir)).await;

        assert!(out.is_error, "a corrupt settings.json must refuse the write, got: {}", out.text);
        assert!(out.text.contains("无法解析"), "the refusal must name the reason: {}", out.text);
        let on_disk = std::fs::read_to_string(dir.join(".gwork/settings.json")).unwrap();
        assert!(
            on_disk.contains("sk-KEEP"),
            "the corrupt-but-real config must survive byte-for-byte; disk now: {}",
            on_disk
        );
        assert!(
            !on_disk.contains("test-model"),
            "no part of the refused write may land on disk"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn add_model_still_adds_on_a_valid_file() {
        let dir = std::env::temp_dir().join(format!("gwork-addmodel2-{}", uuid::Uuid::new_v4()));
        let _home = IsolatedHome::new(&dir);
        std::fs::create_dir_all(dir.join(".gwork")).unwrap();
        std::fs::write(
            dir.join(".gwork/settings.json"),
            "{\"providers\":{\"p1\":{\"apiKey\":\"sk-KEEP\"}},\"mcpServers\":{\"m\":{\"command\":\"x\"}}}",
        )
        .unwrap();

        let out = AddModelTool.execute(add_model_args(), &tool_ctx_for(&dir)).await;

        assert!(!out.is_error, "a valid settings.json must accept the write: {}", out.text);
        let on_disk = std::fs::read_to_string(dir.join(".gwork/settings.json")).unwrap();
        assert!(on_disk.contains("test-model"), "the new model must land on disk");
        assert!(
            on_disk.contains("sk-KEEP") && on_disk.contains("\"mcpServers\""),
            "sections the tool does not own must survive: {}",
            on_disk
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn add_model_strips_a_bom_instead_of_refusing_forever() {
        // A BOM must not wedge the tool into permanent refusal: the guard strips
        // it before parsing, so a Notepad-saved file still works.
        let dir = std::env::temp_dir().join(format!("gwork-addmodel3-{}", uuid::Uuid::new_v4()));
        let _home = IsolatedHome::new(&dir);
        std::fs::create_dir_all(dir.join(".gwork")).unwrap();
        let mut bytes: Vec<u8> = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"{\"providers\":{\"p1\":{\"apiKey\":\"sk-KEEP\"}}}");
        std::fs::write(dir.join(".gwork/settings.json"), &bytes).unwrap();

        let out = AddModelTool.execute(add_model_args(), &tool_ctx_for(&dir)).await;

        assert!(!out.is_error, "a BOM alone must not refuse the write: {}", out.text);
        let on_disk = std::fs::read_to_string(dir.join(".gwork/settings.json")).unwrap();
        assert!(on_disk.contains("test-model"), "the new model must land despite the BOM");
        assert!(on_disk.contains("sk-KEEP"), "other sections must survive");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
