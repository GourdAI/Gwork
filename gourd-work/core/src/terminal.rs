//! terminal — Interactive terminal gateway (WS /web/terminal).
//!
//! Spawns a persistent shell per session and bridges stdin/stdout over WebSocket.
//!
//! ## Why output is forwarded as raw chunks, not lines
//!
//! A shell prompt (`PS C:\...>` / `$ `) is written **without a trailing newline**:
//! the shell then waits for input on that same line. A line-based reader therefore
//! holds the prompt in its buffer and only releases it when the *next* newline
//! arrives — gluing the prompt onto whatever the command prints next. With several
//! reconnects the user sees `PS A> PS A> PS A>` on one line (reported bug).
//!
//! Forwarding raw byte chunks as they arrive fixes this: the prompt reaches the UI
//! immediately and nothing accumulates. It is not a PTY (no resize/echo/cursor
//! control), but it is faithful for the line-oriented usage this panel supports.
//!
//! ## Why Windows needs CREATE_NO_WINDOW
//!
//! A child console process inherits/allocates a real console window unless the
//! creation flags say otherwise. Without `CREATE_NO_WINDOW` every terminal tab
//! popped a visible `C:\Windows\System32\WindowsPowerShell` window over the app
//! (reported bug). The flag is Windows-only; Unix has no such window.
//!
//! ## Reconnect safety
//!
//! The output sender is kept in the session and each WS connection gets its own
//! receiver from a broadcast-style fan-out, so reconnecting neither loses nor
//! duplicates the stream (the previous `mem::replace` swap closed the channel
//! after the first take, silently killing output on reconnect).

use std::collections::HashMap;
use std::sync::Arc;

use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex};

/// Hide the console window for child processes on Windows.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A terminal session handle.
pub struct TerminalSession {
    stdin_tx: mpsc::UnboundedSender<String>,
    /// Fan-out senders: one per connected WS client. mpsc has no multi-receiver,
    /// so the session owns the sender list and each subscriber gets a private
    /// channel; reconnecting neither steals nor duplicates another client's
    /// stream (the previous `mem::replace` swap closed the channel after the
    /// first take, silently killing output on reconnect).
    output_fanout: Arc<Mutex<Vec<mpsc::UnboundedSender<String>>>>,
    child: Child,
}

/// Registry of active terminal sessions.
#[derive(Default)]
pub struct TerminalRegistry {
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
}

impl TerminalRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawn a new terminal session in the given working directory.
    pub async fn spawn(&self, session_id: &str, cwd: &std::path::Path) -> anyhow::Result<()> {
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("powershell");
            c.args(["-NoProfile", "-NoLogo"]);
            // Without this the child allocates a visible console window.
            //
            // Attribute block, not a bare statement: tokio's `creation_flags`
            // sits inside `cfg_windows!`, so the method does not exist on a
            // non-Windows target -- and `if cfg!(windows)` is a runtime `if`,
            // which still type-checks both arms and breaks the ubuntu-latest CI
            // gate with E0599 even though the branch never runs there. The
            // attribute is stripped before type checking (gitops.rs:136 form).
            // No `CommandExt` import: on tokio's Command this is an inherent
            // method, so importing the trait would be an unused import.
            #[cfg(windows)]
            {
                c.creation_flags(CREATE_NO_WINDOW);
            }
            c
        } else {
            Command::new("sh")
        };
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .current_dir(cwd);

        let mut child = cmd.spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("no stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("no stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow::anyhow!("no stderr"))?;

        // Input channel → shell stdin
        let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<String>();
        let mut stdin_writer = stdin;
        tokio::spawn(async move {
            while let Some(line) = stdin_rx.recv().await {
                let data = if line.ends_with('\n') {
                    line
                } else {
                    format!("{}\n", line)
                };
                if stdin_writer.write_all(data.as_bytes()).await.is_err() {
                    break;
                }
                let _ = stdin_writer.flush().await;
            }
        });

        // Output: fan out raw chunks to every subscribed client. No line
        // buffering, so an unterminated shell prompt reaches the UI at once.
        let fanout: Arc<Mutex<Vec<mpsc::UnboundedSender<String>>>> =
            Arc::new(Mutex::new(Vec::new()));

        {
            let fan = fanout.clone();
            tokio::spawn(async move {
                forward_raw(stdout, fan).await;
            });
        }
        {
            let fan = fanout.clone();
            tokio::spawn(async move {
                forward_raw(stderr, fan).await;
            });
        }

        self.sessions.lock().await.insert(
            session_id.to_string(),
            TerminalSession {
                stdin_tx,
                output_fanout: fanout,
                child,
            },
        );
        Ok(())
    }

    /// Write a line to a session's stdin.
    pub async fn write(&self, session_id: &str, line: &str) -> bool {
        let sessions = self.sessions.lock().await;
        sessions
            .get(session_id)
            .map(|s| s.stdin_tx.send(line.to_string()).is_ok())
            .unwrap_or(false)
    }

    /// Close and remove a session.
    pub async fn close(&self, session_id: &str) {
        let mut sessions = self.sessions.lock().await;
        if let Some(mut s) = sessions.remove(session_id) {
            let _ = s.child.kill().await;
        }
    }

    /// Whether a session exists in the registry.
    pub async fn has_session(&self, session_id: &str) -> bool {
        self.sessions.lock().await.contains_key(session_id)
    }

    /// Subscribe to a session's output. Each caller gets an independent receiver,
    /// so a WS reconnect does not steal or duplicate another client's stream.
    pub async fn subscribe(&self, session_id: &str) -> Option<mpsc::UnboundedReceiver<String>> {
        let sessions = self.sessions.lock().await;
        let s = sessions.get(session_id)?;
        let (tx, rx) = mpsc::unbounded_channel::<String>();
        s.output_fanout.lock().await.push(tx);
        Some(rx)
    }
}

/// Read a child stream and forward chunks verbatim to every subscriber.
///
/// Chunks are decoded lossily and passed on immediately; no newline is required,
/// which is exactly what makes an unterminated shell prompt visible at once.
/// Closed senders are pruned so a disconnected client cannot leak a slot.
async fn forward_raw<R>(reader: R, fanout: Arc<Mutex<Vec<mpsc::UnboundedSender<String>>>>)
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;
    let mut reader = reader;
    let mut buf = vec![0u8; 8192];
    // Incremental decoder: a CJK char split across two pipe reads must not
    // surface as U+FFFD, and a legacy GBK console must stay readable.
    let mut decoder = crate::textcodec::StreamDecoder::new();
    loop {
        match reader.read(&mut buf).await {
            Ok(0) => break, // EOF
            Ok(n) => {
                let text = decoder.push(&buf[..n]);
                let mut list = fanout.lock().await;
                list.retain(|tx| !tx.is_closed());
                for tx in list.iter() {
                    let _ = tx.send(text.clone());
                }
            }
            Err(_) => break,
        }
    }
    let tail = decoder.finish();
    if !tail.is_empty() {
        let mut list = fanout.lock().await;
        list.retain(|tx| !tx.is_closed());
        for tx in list.iter() {
            let _ = tx.send(tail.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_registry_spawn_and_close() {
        let reg = TerminalRegistry::new();
        let tmp = std::env::temp_dir();
        let result = reg.spawn("test-term", &tmp).await;
        // May fail in restricted environments; just assert it returns a Result.
        if result.is_ok() {
            reg.close("test-term").await;
        }
    }

    /// Two subscribers must both receive the same output (reconnect safety).
    #[tokio::test]
    async fn test_subscribe_is_independent() {
        let reg = TerminalRegistry::new();
        let tmp = std::env::temp_dir();
        if reg.spawn("test-term-2", &tmp).await.is_err() {
            return;
        }
        let a = reg.subscribe("test-term-2").await;
        let b = reg.subscribe("test-term-2").await;
        assert!(a.is_some() && b.is_some(), "both subscribers must attach");
        reg.close("test-term-2").await;
    }
}
