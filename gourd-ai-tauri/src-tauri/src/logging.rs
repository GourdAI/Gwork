//! logging.rs —— Tauri 主进程日志落盘（对应 Electron 版 main/desktop-log.js）
//!
//! 为什么必须有：`release` 版在 `main.rs` 顶部带
//! `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` —— 它是
//! GUI 子系统程序，**没有控制台**。而原先 tracing 只 `fmt` 到 stdout，等于所有
//! 诊断输出（后端端口、java/jar 探测明细、探针状态码、子进程退出码）在用户机器上
//! 100% 蒸发。叠加后端 jar 侧 `-Dsolon.logging.appender.file.level=ERROR`，
//! 一次「接口全不通」的故障在磁盘上留不下任何线索（2026-09-06 排查即卡在此处）。
//!
//! 设计约束：
//! - **不新增 crate 依赖**：本机/CI 离线时 `tracing-appender` 拉不下来会直接
//!   打断构建，故手工实现 `MakeWriter`（约 60 行，无 unsafe）。
//! - **绝不阻断启动**：日志文件打不开时降级回 stdout-only 初始化，
//!   日志是排障工具，不能变成新的故障源。
//! - 与后端 jar 的 `gourd-ai-server.log`（子进程 stdout/stderr）分开存放。
//! - 体积自律：超过 `MAX_BYTES` 就地截断重写（保留最新内容）。
//!   主进程日志量本就极低，截断只为兜住异常刷屏。

use std::fs::{File, OpenOptions};
use std::io::{self, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::EnvFilter;

/// 单份日志上限（5MB），超限就地截断重写。
const MAX_BYTES: u64 = 5 * 1024 * 1024;

/// 主进程日志文件名。与后端日志（`gourd-ai-server.log`）区分开。
pub const MAIN_LOG_NAME: &str = "gwork-desktop-main.log";

/// 主进程日志路径：`<基目录>/.gwork/logs/gwork-desktop-main.log`
/// 基目录语义见 [`crate::paths::runtime_home_dir`]（不含 `.gwork`）。
pub fn main_log_path() -> PathBuf {
    crate::paths::runtime_home_dir()
        .join(".gwork")
        .join("logs")
        .join(MAIN_LOG_NAME)
}

struct Sink {
    file: Mutex<File>,
    written: AtomicU64,
}

/// 可克隆的 tracing writer：每个事件写一行，内部共享同一个文件句柄。
#[derive(Clone)]
struct FileMakeWriter(Arc<Sink>);

/// 单次写入的句柄。同时向 stdout 复制一份，保证开发态终端输出与改动前一致。
struct SinkWriter {
    sink: Arc<Sink>,
}

impl Write for SinkWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // 锁中毒（前一次写入 panic）时仍继续：用 into_inner 取回句柄，绝不因日志拖垮主流程
        let mut guard = match self.sink.file.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        // 阈值判定必须在写入**之前**：若先写后截，刚递来的这一行会被立刻擦掉，
        // 极端情况下「最新一条现场」永远落不进文件，而这正是排障最需要的那一条。
        if self.sink.written.load(Ordering::Relaxed) >= MAX_BYTES {
            self.sink.written.store(0, Ordering::Relaxed);
            let _ = guard.flush();
            truncate_in_place(&mut guard);
        }

        let n = guard.write(buf)?;
        self.sink.written.fetch_add(n as u64, Ordering::Relaxed);
        drop(guard);

        // 再走一份到 stdout（调试器/`npm run tauri dev` 可见）
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

/// 就地截断并回到文件头。相比 rename + reopen，这条路不会与
/// 「另一个进程正持有同一文件句柄」竞争，也不需要在写路径上重新 open。
fn truncate_in_place(file: &mut File) {
    if file.seek(SeekFrom::Start(0)).is_ok() {
        let _ = file.set_len(0);
        let _ = file.write_all(b"# log size limit reached; truncated to keep newest entries\n");
    }
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
    EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("gourd_ai_tauri=info,warn"))
}

/// 初始化日志：优先「文件 + stdout」，文件不可写时降级为「仅 stdout」。
/// 返回最终使用的日志路径（None 表示落盘失败，已降级）。
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
            // 与改造前完全一致的 stdout 初始化，保证「日志出问题时应用照常起」
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

/// 打开（必要时创建）日志文件。父目录一并建；任何一步失败都返回 None。
fn open_sink(path: &Path) -> Option<FileMakeWriter> {
    if let Some(dir) = path.parent() {
        if std::fs::create_dir_all(dir).is_err() {
            return None;
        }
    }
    let file = OpenOptions::new().create(true).append(true).open(path).ok()?;
    let written = file.metadata().map(|m| m.len()).unwrap_or(0);
    Some(FileMakeWriter(Arc::new(Sink {
        file: Mutex::new(file),
        written: AtomicU64::new(written),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 日志名必须与后端 jar 日志区分，否则两份日志互相覆盖、排障反而更难。
    #[test]
    fn main_log_name_differs_from_server_log() {
        assert_eq!(MAIN_LOG_NAME, "gwork-desktop-main.log");
        assert!(!MAIN_LOG_NAME.contains("server"));
    }

    /// 落盘 writer 的核心不变量：写入的内容确实进了文件。
    /// 这条测试把「日志看起来初始化成功但其实没落盘」钉死。
    #[test]
    fn sink_writer_persists_bytes() {
        let dir = std::env::temp_dir().join(format!("gourd-log-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.log");

        let sink = open_sink(&path).expect("临时目录应可写日志");
        {
            let mut w = sink.make_writer();
            w.write_all(b"hello backend diagnostics\n").unwrap();
            w.flush().unwrap();
        }

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(
            content.contains("hello backend diagnostics"),
            "日志必须真实落盘，实际内容: {content:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 阈值判定必须在写入之前：超阈值时先截断再写，最旧内容被丢、**最新一条必须留住**。
    #[test]
    fn overflow_truncates_but_keeps_newest_entry() {
        let dir = std::env::temp_dir().join(format!("gourd-log-rot-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.log");

        let sink = open_sink(&path).unwrap();
        // 直接把计数器顶到阈值，避免真写 5MB
        sink.0.written.store(MAX_BYTES, Ordering::Relaxed);
        {
            let mut w = sink.make_writer();
            w.write_all(b"after-rotate\n").unwrap();
            w.flush().unwrap();
        }

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(
            content.len() < 200,
            "超阈值后应已截断，实际长度 {}",
            content.len()
        );
        assert!(
            content.contains("after-rotate"),
            "截断发生在写入之前，最新一条不得被擦掉；实际内容: {content:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 父目录不可创建时必须返回 None（由调用方降级为 stdout），不能 panic。
    #[test]
    fn unopenable_path_returns_none() {
        // 指向一个「以文件作为父目录」的路径，create_dir_all 必然失败
        let dir = std::env::temp_dir().join(format!("gourd-log-bad-{}", std::process::id()));
        std::fs::write(&dir, b"i am a file").unwrap();
        let bad = dir.join("nested").join("t.log");
        assert!(open_sink(&bad).is_none());
        let _ = std::fs::remove_file(&dir);
    }
}
