//! File-backed tracing for the desktop shell **and the in-process kernel**.
//!
//! The kernel runs inside this process (`server::serve` is spawned from the
//! setup hook), so its `info!`/`warn!` events flow through whatever subscriber
//! is installed here. Before this module existed the shell initialised
//! tracing with stdout only — and a GUI process on Windows has no stdout to
//! speak of. The practical effect: every kernel diagnostic (turn starts,
//! stream errors, stop reasons) evaporated the moment it was logged, leaving
//! nothing on disk after an incident. A user report of "the run ended without
//! finishing" could not be investigated at all, because the only record of
//! the run was the session's frame file, which stops at whatever the last
//! emitted frame happened to be.
//!
//! Layout mirrors the old Java shell's convention: one rolling file under
//! `~/.gwork/logs/`, capped by in-place truncation (rename+reopen would race
//! a second handle on the same path), stdout mirrored for `tauri dev`.

use std::fs::{File, OpenOptions};
use std::io::{self, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::EnvFilter;

/// Single-file cap. Truncation keeps the newest entries, which are the ones
/// an incident report needs.
const MAX_BYTES: u64 = 5 * 1024 * 1024;

/// Query / form / JSON keys whose **value** must never reach disk or stdout.
///
/// WHY (measured, not guessed): the device link authenticates with
/// `?token=<session JWT>` in the URL (PROTOCOL.md §0/§5 — H5 cannot set WS
/// headers), and the kernel used to interpolate that URL into its handshake
/// error string. A real, syntactically valid access token was found in this
/// very log file (`grep 'api/gwork' ~/.gwork/logs/gwork-desktop.log`), and it
/// was re-written on **every** reconnect, i.e. the file always held a token
/// that was valid at that moment. Fixing the message at the source
/// (`channels::transport::redact_url`) covers the known site; this filter is
/// the belt-and-braces for any future caller that logs a URL or header.
const SENSITIVE_KEYS: [&str; 12] = [
    "token",
    "access_token",
    "refresh_token",
    "id_token",
    "secret",
    "client_secret",
    "password",
    "password_encrypted",
    "api_key",
    "apikey",
    "signature",
    "cookie",
];

const REDACTION: &str = "[redacted]";

/// Bytes that may legally precede a key: start of line, URL separator, quote,
/// JSON boundary — and any non-ASCII byte, because Chinese prose/punctuation
/// immediately before a key (`…失败：token=…`) is a real separator.
fn is_key_boundary(b: u8) -> bool {
    b >= 0x80
        || matches!(
            b,
            b'?' | b'&' | b' ' | b'"' | b'\'' | b'{' | b',' | b'(' | b';' | b'\\' | b'<' | b'=' | b'/'
        )
}

/// End of an unquoted value. Non-ASCII bytes always terminate: `token=abc设备`
/// must yield `token=[redacted]设备` rather than swallowing the surrounding
/// Chinese text of the log line.
fn is_value_end(b: u8) -> bool {
    b >= 0x80
        || matches!(
            b,
            b'&' | b' ' | b'"' | b'\'' | b'}' | b']' | b',' | b')' | b';' | b'\\' | b'>' | b'<' | b'\r' | b'\n' | b'\t'
        )
}

/// ASCII case-insensitive "does `hay` start with `needle`" over bytes.
fn starts_with_ci(hay: &[u8], needle: &[u8]) -> bool {
    hay.len() >= needle.len() && hay[..needle.len()].eq_ignore_ascii_case(needle)
}

/// Redact credential **values** in one log record. Non-credential text (paths,
/// query keys, sentences) is preserved so diagnostics stay usable.
///
/// Two spellings are handled, because both reach this log:
/// * query/form — `?token=v`, `password=v`
/// * JSON       — `"password":"v"`
pub(crate) fn redact_log_text(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0usize;
    while i < bytes.len() {
        let boundary = i == 0 || is_key_boundary(bytes[i - 1]);
        if boundary {
            let rest = &bytes[i..];
            if let Some(key) = SENSITIVE_KEYS
                .iter()
                // Longest first: `access_token` must win over `token`.
                .filter(|k| starts_with_ci(rest, k.as_bytes()))
                .max_by_key(|k| k.len())
            {
                let key_end = i + key.len();
                // The key must be a whole word: `token_foo`, `tokens` and
                // `apikeys` are not credentials.
                let mut j = key_end;
                let mut quote = b'"';
                if j < bytes.len() && (bytes[j] == b'"' || bytes[j] == b'\'') {
                    quote = bytes[j];
                    j += 1;
                }
                while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
                    j += 1;
                }
                let separator = j < bytes.len() && (bytes[j] == b'=' || bytes[j] == b':');
                if separator {
                    j += 1;
                    while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
                        j += 1;
                    }
                    // Quoted value: ends at the matching quote.
                    let quoted = j < bytes.len() && (bytes[j] == b'"' || bytes[j] == b'\'');
                    if quoted {
                        let open = bytes[j];
                        j += 1;
                        let val_start = j;
                        while j < bytes.len() && bytes[j] != open && bytes[j] != b'\n' {
                            j += 1;
                        }
                        out.push_str(&input[i..val_start]);
                        // Empty and `${..}`/`{{..}}` template values are
                        // diagnostic, not secrets.
                        let value = &bytes[val_start..j];
                        if value.is_empty() || value[0] == b'$' || value[0] == b'{' {
                            out.push_str(&input[val_start..j]);
                        } else {
                            out.push_str(REDACTION);
                        }
                        i = j;
                        continue;
                    }
                    let val_start = j;
                    while j < bytes.len() && !is_value_end(bytes[j]) {
                        j += 1;
                    }
                    out.push_str(&input[i..val_start]);
                    let value = &bytes[val_start..j];
                    if value.is_empty() || value[0] == b'$' || value[0] == b'{' {
                        out.push_str(&input[val_start..j]);
                    } else {
                        out.push_str(REDACTION);
                    }
                    i = j;
                    continue;
                }
                let _ = quote;
            }
            // `Authorization: Bearer <jwt>` reaching the log is the same leak.
            if starts_with_ci(rest, b"bearer ") {
                out.push_str(&input[i..i + 7]);
                i += 7;
                let mut j = i;
                while j < bytes.len() && !is_value_end(bytes[j]) {
                    j += 1;
                }
                if j > i {
                    out.push_str(REDACTION);
                }
                i = j;
                continue;
            }
        }
        // Advance one whole char so multi-byte UTF-8 is never split.
        let step = input[i..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
        out.push_str(&input[i..i + step]);
        i += step;
    }
    out
}

pub const MAIN_LOG_NAME: &str = "gwork-desktop.log";

/// `<home>/.gwork/logs/gwork-desktop.log`
pub fn main_log_path() -> PathBuf {
    crate::paths::gwork_home().join("logs").join(MAIN_LOG_NAME)
}

struct Sink {
    file: Mutex<File>,
    written: AtomicU64,
    path: PathBuf,
    /// Bytes of the record currently being assembled. `tracing` may emit one
    /// log line through several `write` calls, so redaction must run on whole
    /// lines — a `?token=` split across two chunks would otherwise slip past
    /// the key/value scan. Serialised by `file`'s mutex.
    pending: Mutex<Vec<u8>>,
}

#[derive(Clone)]
struct FileMakeWriter(Arc<Sink>);

struct SinkWriter {
    sink: Arc<Sink>,
}

/// Flush leftover partial line (no trailing newline) at `flush` time, and also
/// when a single record grows past this bound so a pathological writer cannot
/// balloon memory.
const PENDING_MAX_BYTES: usize = 256 * 1024;

impl Sink {
    /// Write one already-redacted chunk to the sink and mirror it to stdout.
    fn emit(&self, file: &mut File, bytes: &[u8]) -> io::Result<()> {
        if self.written.load(Ordering::Relaxed) >= MAX_BYTES {
            self.written.store(0, Ordering::Relaxed);
            let _ = file.flush();
            truncate_in_place(file, &self.path);
        }
        file.write_all(bytes)?;
        self.written.fetch_add(bytes.len() as u64, Ordering::Relaxed);
        // Mirror to stdout so `tauri dev` terminals behave as before.
        let _ = io::stdout().write_all(bytes);
        Ok(())
    }
}

impl Write for SinkWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // A poisoned lock (previous writer panicked) must not stop logging:
        // recover the handle and keep going.
        let mut guard = match self.sink.file.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut pending = match self.sink.pending.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        pending.extend_from_slice(buf);
        let mut consumed = 0usize;
        // Redact whole lines only; the tail stays buffered for the next call.
        while let Some(nl) = pending[consumed..].iter().position(|b| *b == b'\n') {
            let end = consumed + nl + 1;
            let line = String::from_utf8_lossy(&pending[consumed..end]).into_owned();
            self.sink.emit(&mut guard, redact_log_text(&line).as_bytes())?;
            consumed = end;
        }
        pending.drain(..consumed);
        if pending.len() > PENDING_MAX_BYTES {
            let line = String::from_utf8_lossy(&pending).into_owned();
            pending.clear();
            // No newline in sight (binary/oversized record): redact what we
            // have and start a fresh buffer so memory stays bounded.
            self.sink.emit(&mut guard, redact_log_text(&line).as_bytes())?;
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        let mut guard = match self.sink.file.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut pending = match self.sink.pending.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if !pending.is_empty() {
            let line = String::from_utf8_lossy(&pending).into_owned();
            pending.clear();
            self.sink.emit(&mut guard, redact_log_text(&line).as_bytes())?;
        }
        guard.flush()
    }
}

/// Shrink the log back to a marker line, keeping the handle usable.
///
/// The truncation runs on a **fresh write-only handle**: the logging handle
/// is opened in append mode, and Windows refuses `set_len` on a handle that
/// carries `FILE_APPEND_DATA` (the call fails with access denied, which a
/// bare `let _ =` swallows — the file then grows past the cap forever). The
/// replacement handle is a plain write handle positioned after the marker;
/// with a single mutex-serialised writer that is equivalent to append.
fn truncate_in_place(file: &mut File, path: &Path) {
    let Ok(mut f) = OpenOptions::new().write(true).open(path) else {
        return;
    };
    if f.set_len(0).is_err() || f.seek(SeekFrom::Start(0)).is_err() {
        return;
    }
    if f.write_all(b"# log size limit reached; truncated to keep newest entries\n")
        .is_err()
    {
        return;
    }
    *file = f;
}

impl<'a> MakeWriter<'a> for FileMakeWriter {
    type Writer = SinkWriter;

    fn make_writer(&'a self) -> Self::Writer {
        SinkWriter {
            sink: self.0.clone(),
        }
    }
}

fn env_filter() -> EnvFilter {
    // RUST_LOG wins outright so debug diagnostics stay reachable without a
    // rebuild; the default covers both the shell crate and the kernel crate.
    EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new("gourd_work=info,gourd_work_core=info,gourd_work_desktop_lib=info,warn")
    })
}

fn open_sink(path: &PathBuf) -> Option<FileMakeWriter> {
    if let Some(dir) = path.parent() {
        if std::fs::create_dir_all(dir).is_err() {
            return None;
        }
    }
    // `.write(true)` is not redundant next to `.append(true)`: an append-only
    // handle carries FILE_APPEND_DATA without FILE_WRITE_DATA, and Windows
    // refuses `set_len` on it — the in-place truncation below would fail
    // silently and the log would grow past the cap forever.
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .append(true)
        .open(path)
        .ok()?;
    let written = file.metadata().map(|m| m.len()).unwrap_or(0);
    Some(FileMakeWriter(Arc::new(Sink {
        file: Mutex::new(file),
        written: AtomicU64::new(written),
        path: path.clone(),
        pending: Mutex::new(Vec::new()),
    })))
}

/// Install the global subscriber. Returns the log path when file logging is
/// active; `None` means the file could not be opened and we degraded to
/// stdout-only (the app must still start — logging must never be fatal).
pub fn init() -> Option<PathBuf> {
    let path = main_log_path();
    match open_sink(&path) {
        Some(sink) => {
            tracing_subscriber::fmt()
                .with_env_filter(env_filter())
                .with_target(false)
                .with_thread_ids(false)
                .with_file(false)
                .with_line_number(false)
                .with_ansi(false)
                .with_writer(sink)
                .init();
            Some(path)
        }
        None => {
            tracing_subscriber::fmt()
                .with_env_filter(env_filter())
                .with_target(false)
                .with_thread_ids(false)
                .with_file(false)
                .with_line_number(false)
                .init();
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_path_lives_under_gwork_logs() {
        let p = main_log_path();
        assert_eq!(p.file_name().unwrap().to_str().unwrap(), MAIN_LOG_NAME);
        let comps: Vec<String> = p
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        let logs_idx = comps.iter().position(|c| c == "logs").expect("logs dir");
        assert_eq!(comps[logs_idx - 1], ".gwork");
    }

    #[test]
    fn sink_truncates_at_cap_and_keeps_newest() {
        let dir = std::env::temp_dir().join(format!("gwork-logtest-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("t.log");
        let _ = std::fs::remove_file(&path);

        // Seed the file past the cap so the very next write triggers truncation.
        {
            use std::io::Write as _;
            let mut f = File::create(&path).unwrap();
            writeln!(f, "{}", "x".repeat(MAX_BYTES as usize)).unwrap();
        }

        let sink = open_sink(&path).expect("sink opens");
        let mut w = sink.make_writer();
        w.write_all(b"NEWEST-LINE\n").unwrap();
        w.flush().unwrap();
        drop(w);

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("NEWEST-LINE"), "newest line must survive");
        assert!(
            content.contains("log size limit reached"),
            "truncation marker expected, got {} bytes",
            content.len()
        );
        assert!(
            content.len() < 1024,
            "file must be truncated, got {} bytes",
            content.len()
        );
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn open_sink_creates_missing_parent_dirs() {
        let dir = std::env::temp_dir().join(format!("gwork-logtest2-{}", std::process::id()));
        let nested = dir.join("a").join("b");
        let path = nested.join("t.log");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(open_sink(&path).is_some(), "must create parents");
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── redaction ────────────────────────────────────────────────────────────

    const LIVE_LOOKING_JWT: &str = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";

    #[test]
    fn redacts_device_link_token_in_a_url() {
        let line = format!(
            "2026-11-23T00:00:00Z WARN device link connect failed: WebSocket handshake failed for \
             wss://www.gourdwork.com/api/gwork/device/link?token={}&deviceId=dev-1a2b3c4d&name=PC\n",
            LIVE_LOOKING_JWT
        );
        let out = redact_log_text(&line);
        assert!(!out.contains(LIVE_LOOKING_JWT), "token must not survive: {}", out);
        assert!(out.contains("token=[redacted]"), "key kept visible: {}", out);
        // Non-secret parameters stay readable — that is what makes the line useful.
        assert!(out.contains("deviceId=dev-1a2b3c4d"), "{}", out);
        assert!(out.contains("name=PC"), "{}", out);
        assert!(out.contains("wss://www.gourdwork.com/api/gwork/device/link"), "{}", out);
        assert!(out.ends_with('\n'), "line terminator must be preserved");
    }

    #[test]
    fn redacts_snake_case_keys_and_bearer_headers() {
        let out = redact_log_text(
            "POST /api/user/login body={\"password\":\"hunter2\",\"api_key\":\"sk-abc\"} \
             header=Authorization: Bearer abc.def query=password=pw&access_token=at123\n",
        );
        assert!(!out.contains("hunter2"), "{}", out);
        assert!(!out.contains("sk-abc"), "{}", out);
        assert!(!out.contains("abc.def"), "{}", out);
        assert!(!out.contains("pw&"), "{}", out);
        assert!(!out.contains("at123"), "{}", out);
        // JSON spelling keeps the key and quotes, only the value is masked.
        assert!(out.contains("\"password\":\"[redacted]\""), "{}", out);
        assert!(out.contains("\"api_key\":\"[redacted]\""), "{}", out);
        // form spelling keeps the key.
        assert!(out.contains("password=[redacted]"), "{}", out);
        assert!(out.contains("access_token=[redacted]"), "{}", out);
        assert!(out.contains("Bearer [redacted]"), "{}", out);
    }

    #[test]
    fn leaves_non_secret_and_placeholder_values_alone() {
        // `max_tokens` / `not_a_token` must not be mistaken for credentials, and
        // an empty or template value carries no secret.
        let line = "usage max_tokens=4096 not_a_token=1 token= token=${TOKEN} refresh_token=ok\n";
        let out = redact_log_text(line);
        assert!(out.contains("max_tokens=4096"), "{}", out);
        assert!(out.contains("not_a_token=1"), "{}", out);
        assert!(out.contains("token="), "{}", out);
        assert!(out.contains("refresh_token=[redacted]"), "{}", out);
    }

    #[test]
    fn redaction_preserves_multibyte_text() {
        let line = "设备链路连接失败：token=abc123（已重试 3 次）\n";
        let out = redact_log_text(line);
        assert!(!out.contains("abc123"), "{}", out);
        assert!(out.contains("设备链路连接失败"), "{}", out);
        assert!(out.contains("（已重试 3 次）"), "{}", out);
    }

    #[test]
    fn sink_writer_redacts_across_split_writes() {
        let dir = std::env::temp_dir().join(format!("gwork-logredact-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("t.log");
        let _ = std::fs::remove_file(&path);

        let sink = open_sink(&path).expect("sink opens");
        let mut w = sink.make_writer();
        // The key itself is split across two `write` calls: a naive per-chunk
        // filter would leak the value, which is exactly the regression this
        // line-buffered writer exists to prevent.
        w.write_all(b"handshake failed for wss://h/api/gwork/device/link?to").unwrap();
        w.write_all(format!("ken={}&deviceId=dev-9\n", LIVE_LOOKING_JWT).as_bytes()).unwrap();
        w.flush().unwrap();
        drop(w);

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(!content.contains(LIVE_LOOKING_JWT), "leaked across chunks: {}", content);
        assert!(content.contains("deviceId=dev-9"), "{}", content);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }
}
