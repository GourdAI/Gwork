//! queue — Per-session message queue, persisted to `<sessionDir>/queue.json`.
//!
//! ## Why this is file-backed, not an in-memory map
//!
//! The frontend (`desktop/ui/js/message-queue.js`) documents the contract in its
//! header: "队列数据存储在会话目录下的 queue.json 文件中 … 支持服务重启后恢复".
//! Messages are queued precisely *because* a run is in flight, so they sit there
//! for the whole duration of a long turn — exactly the window in which the kernel
//! may be restarted (desktop shell reload, crash, user quit). An in-memory queue
//! silently drops every pending message in that case, and the user's typed input
//! disappears with no trace.
//!
//! Persistence also makes the queue shared across kernel instances. The frontend
//! explicitly supports that ("跨实例场景（桌面版与 dev 同时在线、共享同一批会话
//! 目录）") and works around stale caches with a 30 s TTL; a per-process map would
//! make the two instances disagree about what is pending.
//!
//! ## On-disk shape (must match the Java kernel byte-for-byte in field names)
//!
//! ```json
//! {"items":[{"content":"…","imagePaths":[],"filePaths":[],"timestamp":1730000000000}]}
//! ```
//!
//! The frontend reads `resp.data.items`, `item.content`, `item.imagePaths`,
//! `item.filePaths` verbatim. An earlier port serialised the text as `text` and
//! the time as `createdAt`, and returned the list *directly* under `data` instead
//! of under `data.items` — so `resp.data.items` was `undefined`, the badge stayed
//! at 0 and `processMessageQueue` never saw a single message. Field names here are
//! therefore part of the wire contract, not an internal detail.
//!
//! ## Who consumes what (this is the part that used to be broken)
//!
//! Two kinds of item share one file, and **only one of them belongs to the kernel**:
//!
//! * **Interjections** (`originSteerId` present, from `POST /web/chat/steer`) are
//!   drained by the kernel at the reasoning-step boundary with [`shift_steer`], so
//!   they reach the live turn. Java keeps its steer mailbox in memory
//!   (`SteerRunState.pending`); this kernel routes it through `queue.json` instead
//!   so a restart mid-run cannot lose it — which means the drain *must* be
//!   identity-selective, not `shift`.
//! * **Plain queued messages** (no `originSteerId`) belong to the **frontend**:
//!   `app-streaming.js` calls `processMessageQueue(sessionId)` when a run finishes,
//!   looping `shift()` → send → repeat until empty. A kernel that `shift()`s these
//!   consumes them into the model's context while the UI is still waiting for them,
//!   so the user's typed message vanishes from the screen *and* never becomes its
//!   own turn. That was the real defect behind "interjections don't show up":
//!   an indiscriminate `while let Some(item) = shift()` drained both kinds.
//!
//! [`shift_steer`]: QueueManager::shift_steer

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// One queued message.
///
/// Field names are the wire contract — see the module docs. `content` (not
/// `text`) and `timestamp` (not `createdAt`) are what both the Java kernel and the
/// frontend use.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct QueuedMessage {
    #[serde(default)]
    pub content: String,
    #[serde(rename = "imagePaths", default)]
    pub image_paths: Vec<String>,
    #[serde(rename = "filePaths", default)]
    pub file_paths: Vec<String>,
    #[serde(default)]
    pub timestamp: i64,
    /// Present only on items re-queued from a dropped steer; makes `add`
    /// idempotent so a retry cannot duplicate the message (Java `originSteerId`).
    #[serde(
        rename = "originSteerId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub origin_steer_id: Option<String>,
}

/// The whole file: `{"items":[…]}`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct QueueFile {
    #[serde(default)]
    pub items: Vec<QueuedMessage>,
}

/// Serialises the read-modify-write cycle on `queue.json` — **process-wide**.
///
/// The lock is a `static`, not a field, mirroring the Java kernel's
/// `static ReentrantLock`. This is load-bearing rather than stylistic: the HTTP
/// handlers reach the queue through the `Arc<QueueManager>` in `AppState` while a
/// run reaches it through an instance built inside `react::run_inner`, so a
/// per-instance mutex left those two paths unsynchronised — and they overlap by
/// design (the kernel's step-boundary drain races the frontend's `shift()` loop
/// and the badge refresh). `shift`/`shift_steer`/`add` are all read-then-write, so
/// without one shared lock two consumers can take the same item, or a write can
/// rebuild the file from a stale snapshot and drop a concurrent append.
///
/// Consequence worth knowing: `QueueManager` is a stateless handle. Cloning or
/// re-creating it is free and changes nothing about mutual exclusion, which is why
/// callers need not thread one instance around.
///
/// The guard is never held across an `.await` (every method here is synchronous),
/// so a `std` mutex is correct and cheaper than a tokio one. Poisoning is
/// recovered rather than propagated: a panicked caller must not permanently
/// disable the chat input.
static QUEUE_LOCK: Mutex<()> = Mutex::new(());

/// A stateless handle onto the persisted per-session queue; see [`QUEUE_LOCK`]
/// for why the serialisation lives outside this type.
#[derive(Default)]
pub struct QueueManager;

impl QueueManager {
    pub fn new() -> Self {
        QueueManager
    }

    fn queue_file(session_dir: &Path) -> PathBuf {
        session_dir.join("queue.json")
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        QUEUE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Read the queue. A missing **or corrupt** file yields an empty list rather
    /// than an error: an unreadable queue must not break the chat input, and
    /// "empty" degrades to "nothing pending", which is the safe direction.
    pub fn read(&self, session_dir: &Path) -> Vec<QueuedMessage> {
        let _g = self.guard();
        Self::read_unlocked(session_dir)
    }

    fn read_unlocked(session_dir: &Path) -> Vec<QueuedMessage> {
        let Ok(text) = std::fs::read_to_string(Self::queue_file(session_dir)) else {
            return Vec::new();
        };
        serde_json::from_str::<QueueFile>(&text)
            .map(|f| f.items)
            .unwrap_or_default()
    }

    /// Append one message; returns the new queue length.
    ///
    /// A non-empty `origin_steer_id` makes the call idempotent on that id, so a
    /// retried steer re-queue cannot duplicate the message.
    pub fn add(
        &self,
        session_dir: &Path,
        content: String,
        image_paths: Vec<String>,
        file_paths: Vec<String>,
        origin_steer_id: Option<String>,
    ) -> usize {
        let _g = self.guard();
        let mut items = Self::read_unlocked(session_dir);
        let steer_id = origin_steer_id.filter(|s| !s.trim().is_empty());
        if let Some(id) = steer_id.as_deref() {
            if items.iter().any(|m| m.origin_steer_id.as_deref() == Some(id)) {
                return items.len();
            }
        }
        items.push(QueuedMessage {
            content,
            image_paths,
            file_paths,
            timestamp: chrono::Utc::now().timestamp_millis(),
            origin_steer_id: steer_id,
        });
        Self::write_unlocked(session_dir, &items);
        items.len()
    }

    /// Pop the head item (atomic read-modify-write).
    ///
    /// Draining the queue **deletes the file** rather than writing an empty
    /// `items` array — the Java kernel does the same, so the file's existence is a
    /// valid "has pending messages" signal for anything inspecting the directory.
    pub fn shift(&self, session_dir: &Path) -> Option<QueuedMessage> {
        let _g = self.guard();
        let mut items = Self::read_unlocked(session_dir);
        if items.is_empty() {
            Self::delete_unlocked(session_dir);
            return None;
        }
        let first = items.remove(0);
        if items.is_empty() {
            Self::delete_unlocked(session_dir);
        } else {
            Self::write_unlocked(session_dir, &items);
        }
        Some(first)
    }

    /// Pop the head **interjection**, leaving plain queued messages untouched.
    ///
    /// The kernel may only take items it was asked to interject. `shift()` takes
    /// the head whatever it is, so a run that used it at a step boundary would also
    /// swallow messages the frontend had queued deliberately — those are supposed
    /// to become their own later turn, and the UI only renders them from the
    /// frontend's own `processMessageQueue` path. Injecting them into the model
    /// without emitting a frame is precisely how a queued message becomes invisible.
    ///
    /// Selection is by a non-blank `originSteerId` (blank ids are not an identity —
    /// see [`add`]), matching how the steer endpoint stamps items.
    ///
    /// [`add`]: QueueManager::add
    pub fn shift_steer(&self, session_dir: &Path) -> Option<QueuedMessage> {
        let _g = self.guard();
        let mut items = Self::read_unlocked(session_dir);
        let idx = items.iter().position(|m| {
            m.origin_steer_id
                .as_deref()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false)
        })?;
        let item = items.remove(idx);
        if items.is_empty() {
            Self::delete_unlocked(session_dir);
        } else {
            Self::write_unlocked(session_dir, &items);
        }
        Some(item)
    }

    /// Remove **every** interjection from the queue at once, preserving order,
    /// and leave plain queued messages exactly where they were.
    ///
    /// This is the run-exit hand-off: whatever the loop never got a chance to
    /// inject must be accounted for explicitly rather than left silently in the
    /// file, because the frontend resolves its pending chip only from a
    /// `steer_dropped` / `steer_cancelled` frame.
    ///
    /// One read-modify-write, not a `shift_steer` loop: N items would otherwise
    /// cost N full rewrites, and between iterations a concurrent `add` could
    /// interleave into the middle of the batch being re-queued.
    pub fn take_steers(&self, session_dir: &Path) -> Vec<QueuedMessage> {
        let _g = self.guard();
        let items = Self::read_unlocked(session_dir);
        let mut taken = Vec::new();
        let mut kept = Vec::new();
        for m in items {
            let is_steer = m
                .origin_steer_id
                .as_deref()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
            if is_steer {
                taken.push(m);
            } else {
                kept.push(m);
            }
        }
        if !taken.is_empty() {
            if kept.is_empty() {
                Self::delete_unlocked(session_dir);
            } else {
                Self::write_unlocked(session_dir, &kept);
            }
        }
        taken
    }

    /// Clear the queue (delete the file).
    pub fn clear(&self, session_dir: &Path) {
        let _g = self.guard();
        Self::delete_unlocked(session_dir);
    }

    /// Alias of [`read`] — the list endpoint's vocabulary.
    pub fn list(&self, session_dir: &Path) -> Vec<QueuedMessage> {
        self.read(session_dir)
    }

    fn write_unlocked(session_dir: &Path, items: &[QueuedMessage]) {
        let path = Self::queue_file(session_dir);
        if let Some(parent) = path.parent() {
            // The session directory may not exist yet when the very first message
            // is queued before any turn has run (Java `mkdirs()` for the same reason).
            let _ = std::fs::create_dir_all(parent);
        }
        let Ok(json) = serde_json::to_string(&QueueFile {
            items: items.to_vec(),
        }) else {
            return;
        };
        // Atomic temp+rename: a crash mid-write must not leave a truncated
        // queue.json, which `read_unlocked` would then parse as "empty" and
        // silently discard every pending message.
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }

    fn delete_unlocked(session_dir: &Path) {
        let _ = std::fs::remove_file(Self::queue_file(session_dir));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gwork-queue-{}-{}", tag, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn fifo_order_is_preserved() {
        let dir = temp_dir("fifo");
        let qm = QueueManager::new();
        assert_eq!(qm.add(&dir, "first".into(), vec![], vec![], None), 1);
        assert_eq!(qm.add(&dir, "second".into(), vec![], vec![], None), 2);
        assert_eq!(qm.shift(&dir).unwrap().content, "first");
        assert_eq!(qm.shift(&dir).unwrap().content, "second");
        assert!(qm.shift(&dir).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn wire_shape_uses_the_contract_field_names() {
        // The frontend reads data.items[].content / .imagePaths / .filePaths /
        // .timestamp verbatim; a rename here silently empties the queue badge.
        let dir = temp_dir("shape");
        let qm = QueueManager::new();
        qm.add(
            &dir,
            "hello".into(),
            vec!["uploads/a.png".into()],
            vec!["uploads/b.pdf".into()],
            None,
        );
        let raw = std::fs::read_to_string(dir.join("queue.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let item = &v["items"][0];
        assert_eq!(item["content"], "hello");
        assert_eq!(item["imagePaths"][0], "uploads/a.png");
        assert_eq!(item["filePaths"][0], "uploads/b.pdf");
        assert!(item["timestamp"].as_i64().unwrap() > 0);
        assert!(item.get("text").is_none(), "must not serialise the old `text` key");
        assert!(
            item.get("createdAt").is_none(),
            "must not serialise the old `createdAt` key"
        );
        assert!(
            item.get("originSteerId").is_none(),
            "absent steer id must be omitted, not written as null"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn queue_survives_a_manager_restart() {
        // The whole point of persisting: a new QueueManager (i.e. a restarted
        // kernel) must see what the previous one queued.
        let dir = temp_dir("restart");
        QueueManager::new().add(&dir, "pending across restart".into(), vec![], vec![], None);
        let revived = QueueManager::new();
        let items = revived.list(&dir);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].content, "pending across restart");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn draining_deletes_the_file() {
        let dir = temp_dir("drain");
        let qm = QueueManager::new();
        qm.add(&dir, "only".into(), vec![], vec![], None);
        assert!(dir.join("queue.json").exists());
        qm.shift(&dir);
        assert!(
            !dir.join("queue.json").exists(),
            "empty queue must remove the file (Java parity: existence == has pending)"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn clear_removes_the_file_and_yields_nothing() {
        let dir = temp_dir("clear");
        let qm = QueueManager::new();
        qm.add(&dir, "a".into(), vec![], vec![], None);
        qm.add(&dir, "b".into(), vec![], vec![], None);
        qm.clear(&dir);
        assert!(!dir.join("queue.json").exists());
        assert!(qm.list(&dir).is_empty());
        assert!(qm.shift(&dir).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn origin_steer_id_makes_add_idempotent() {
        let dir = temp_dir("steer");
        let qm = QueueManager::new();
        assert_eq!(qm.add(&dir, "x".into(), vec![], vec![], Some("s-1".into())), 1);
        // Same steer id → no duplicate, length unchanged.
        assert_eq!(qm.add(&dir, "x".into(), vec![], vec![], Some("s-1".into())), 1);
        // Different id → appended.
        assert_eq!(qm.add(&dir, "y".into(), vec![], vec![], Some("s-2".into())), 2);
        // Blank id is not an identity: it must append every time.
        assert_eq!(qm.add(&dir, "z".into(), vec![], vec![], Some("  ".into())), 3);
        assert_eq!(qm.add(&dir, "w".into(), vec![], vec![], None), 4);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The kernel's drain may only touch interjections. A plain queued message is
    /// the frontend's to dispatch (`processMessageQueue`); when the kernel
    /// `shift()`ed it instead, the text reached the model but never got its own
    /// turn or bubble — the invisibility this whole change is about.
    #[test]
    fn shift_steer_skips_plain_messages_and_takes_the_interjection() {
        let dir = temp_dir("shift_steer");
        let qm = QueueManager::new();
        qm.add(&dir, "plain first".into(), vec![], vec![], None);
        qm.add(&dir, "steer me".into(), vec![], vec![], Some("s-9".into()));
        qm.add(&dir, "plain second".into(), vec![], vec![], None);

        let got = qm.shift_steer(&dir).unwrap();
        assert_eq!(got.content, "steer me", "must select by identity, not by position");
        assert_eq!(got.origin_steer_id.as_deref(), Some("s-9"));

        let rest = qm.list(&dir);
        assert_eq!(
            rest.iter().map(|m| m.content.as_str()).collect::<Vec<_>>(),
            vec!["plain first", "plain second"],
            "plain items must keep both their content and their FIFO order"
        );
        // No further interjection → None, and the plain items are still untouched.
        assert!(qm.shift_steer(&dir).is_none());
        assert_eq!(qm.list(&dir).len(), 2);
        assert!(dir.join("queue.json").exists(), "kept items must not delete the file");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn blank_steer_id_is_not_an_identity() {
        // Mirrors `add`: a whitespace-only id is not an identity, so the kernel
        // must not claim such an item as an interjection.
        let dir = temp_dir("blank_id");
        let qm = QueueManager::new();
        qm.add(&dir, "ambiguous".into(), vec![], vec![], Some("   ".into()));
        assert!(qm.shift_steer(&dir).is_none());
        assert_eq!(qm.list(&dir).len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn take_steers_removes_all_interjections_and_keeps_the_rest_in_order() {
        let dir = temp_dir("take_steers");
        let qm = QueueManager::new();
        qm.add(&dir, "p1".into(), vec![], vec![], None);
        qm.add(&dir, "s1".into(), vec![], vec![], Some("id-1".into()));
        qm.add(&dir, "p2".into(), vec![], vec![], None);
        qm.add(&dir, "s2".into(), vec![], vec![], Some("id-2".into()));

        let taken = qm.take_steers(&dir);
        assert_eq!(
            taken.iter().map(|m| m.content.as_str()).collect::<Vec<_>>(),
            vec!["s1", "s2"],
            "batch take must preserve relative order (it is re-queued as a batch)"
        );
        assert_eq!(
            qm.list(&dir).iter().map(|m| m.content.as_str()).collect::<Vec<_>>(),
            vec!["p1", "p2"]
        );

        // Idempotent: a second call finds nothing and must not disturb the file.
        assert!(qm.take_steers(&dir).is_empty());
        assert_eq!(qm.list(&dir).len(), 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn take_steers_deletes_the_file_only_when_nothing_remains() {
        let dir = temp_dir("take_steers_del");
        let qm = QueueManager::new();
        qm.add(&dir, "only steer".into(), vec![], vec![], Some("z".into()));
        assert_eq!(qm.take_steers(&dir).len(), 1);
        assert!(
            !dir.join("queue.json").exists(),
            "an emptied queue must remove the file (existence == has pending)"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The lock is `static`, not a field: the HTTP handlers use the
    /// `Arc<QueueManager>` in `AppState` while a run builds its own, and those two
    /// paths overlap by design. Per-instance locking let both take the same item —
    /// a duplicate delivery plus a lost message.
    #[test]
    fn distinct_managers_share_one_lock() {
        // Deterministic half of the guarantee: a unit struct has no field that
        // *could* hold a per-instance mutex, so the serialisation must be the
        // `static`. Without this the threaded check below only races into
        // passing, which proves nothing on a fast machine.
        assert_eq!(
            std::mem::size_of::<QueueManager>(),
            0,
            "QueueManager must stay stateless; a per-instance mutex reintroduces \
             the split-brain between AppState's Arc and react's own instance"
        );

        let dir = temp_dir("shared_lock");
        let total = 30usize;
        // Deliberately a *fresh* manager per append, so nothing but the
        // process-wide lock can be what makes this pass.
        for i in 0..total {
            QueueManager::new().add(&dir, format!("m{i}"), vec![], vec![], None);
        }
        let mut handles = Vec::new();
        for _ in 0..6 {
            let dir = dir.clone();
            handles.push(std::thread::spawn(move || {
                // Each thread builds its OWN instance, mirroring the real split
                // (AppState's Arc vs. the one react::run_inner creates).
                let qm = QueueManager::new();
                let mut got = Vec::new();
                loop {
                    match qm.shift(&dir) {
                        Some(m) => got.push(m.content),
                        None => break,
                    }
                }
                got
            }));
        }
        let mut all: Vec<String> = handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .flatten()
            .collect();
        all.sort();
        let mut expected: Vec<String> = (0..total).map(|i| format!("m{i}")).collect();
        expected.sort();
        assert_eq!(all, expected, "each item delivered exactly once across instances");
        assert!(QueueManager::new().list(&dir).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_file_degrades_to_empty_rather_than_erroring() {
        let dir = temp_dir("corrupt");
        std::fs::write(dir.join("queue.json"), "{not json").unwrap();
        let qm = QueueManager::new();
        assert!(qm.list(&dir).is_empty(), "corrupt queue must read as empty");
        assert!(qm.shift(&dir).is_none());
        // …and must be repairable by the next add.
        assert_eq!(qm.add(&dir, "recovered".into(), vec![], vec![], None), 1);
        assert_eq!(qm.shift(&dir).unwrap().content, "recovered");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_directory_is_created_on_first_add() {
        let base = temp_dir("mkdirs");
        let dir = base.join("nested").join("session-dir");
        assert!(!dir.exists());
        let qm = QueueManager::new();
        assert_eq!(qm.add(&dir, "x".into(), vec![], vec![], None), 1);
        assert!(dir.join("queue.json").exists());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn no_temp_file_is_left_behind() {
        let dir = temp_dir("tmp");
        let qm = QueueManager::new();
        qm.add(&dir, "x".into(), vec![], vec![], None);
        qm.shift(&dir);
        qm.add(&dir, "y".into(), vec![], vec![], None);
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "atomic write left temp files: {leftovers:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Concurrency: N threads shifting one queue must hand out each item exactly
    /// once. Without the lock, two threads read the same head and both write back
    /// a list missing only that one item — a duplicate delivery and a lost one.
    #[test]
    fn concurrent_shifts_deliver_each_item_exactly_once() {
        let dir = temp_dir("concurrent");
        let qm = std::sync::Arc::new(QueueManager::new());
        let total = 40usize;
        for i in 0..total {
            qm.add(&dir, format!("m{i}"), vec![], vec![], None);
        }
        let mut handles = Vec::new();
        for _ in 0..6 {
            let qm = qm.clone();
            let dir = dir.clone();
            handles.push(std::thread::spawn(move || {
                let mut got = Vec::new();
                loop {
                    match qm.shift(&dir) {
                        Some(m) => got.push(m.content),
                        None => break,
                    }
                }
                got
            }));
        }
        let mut all: Vec<String> = handles.into_iter().flat_map(|h| h.join().unwrap()).collect();
        all.sort();
        let mut expected: Vec<String> = (0..total).map(|i| format!("m{i}")).collect();
        expected.sort();
        assert_eq!(all, expected, "each item must be delivered exactly once");
        std::fs::remove_dir_all(&dir).ok();
    }
}
