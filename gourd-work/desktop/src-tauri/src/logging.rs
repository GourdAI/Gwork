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

pub const MAIN_LOG_NAME: &str = "gwork-desktop.log";

/// `<home>/.gwork/logs/gwork-desktop.log`
pub fn main_log_path() -> PathBuf {
    crate::paths::gwork_home().join("logs").join(MAIN_LOG_NAME)
}

struct Sink {
    file: Mutex<File>,
    written: AtomicU64,
    path: PathBuf,
}

#[derive(Clone)]
struct FileMakeWriter(Arc<Sink>);

struct SinkWriter {
    sink: Arc<Sink>,
}

impl Write for SinkWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // A poisoned lock (previous writer panicked) must not stop logging:
        // recover the handle and keep going.
        let mut guard = match self.sink.file.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        // Threshold check before writing: checking after would erase the
        // very line that crossed the limit, and that line is usually the
        // freshest piece of evidence.
        if self.sink.written.load(Ordering::Relaxed) >= MAX_BYTES {
            self.sink.written.store(0, Ordering::Relaxed);
            let _ = guard.flush();
            truncate_in_place(&mut guard, &self.sink.path);
        }

        let n = guard.write(buf)?;
        self.sink.written.fetch_add(n as u64, Ordering::Relaxed);
        drop(guard);

        // Mirror to stdout so `tauri dev` terminals behave as before.
        let _ = io::stdout().write_all(buf);
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        let mut guard = match self.sink.file.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
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
}
