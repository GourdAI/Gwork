//! attachments — Session attachment persistence (uploads directory).
//!
//! Mirrors the Java kernel's WebGate.saveAttachments contract:
//! - Files land in `<sessionDir>/uploads/` preserving the original file name.
//! - File names containing `..`, `/`, `\`, NUL or Windows reserved names are rejected.
//! - Image detection = declared type "image" AND extension in the whitelist
//!   (jpg jpeg png gif webp bmp svg) — same rule across upload/meta/list/input.
//! - meta endpoint: images ≤ 8MB are returned as base64 dataUrl; whole-batch
//!   dataUrl budget 24MB; max 32 paths per request.

use std::path::{Path, PathBuf};

use base64::Engine;

/// Run a blocking closure **off** the async worker thread.
///
/// Every public function here does synchronous filesystem I/O — `save_attachment`
/// writes MB-scale uploads and calls `canonicalize` twice; `attachment_meta_item`
/// reads and base64-encodes images against a 24 MB batch budget; `list_attachments`
/// stats every file. They are called directly from `async` axum handlers
/// (`server/attachments_api.rs`), so without this a large upload or a full
/// attachment panel stalls the tokio worker and every other request pinned to it.
/// That is the same failure mode measured elsewhere in this repo (`/web/chat/meta`
/// 1 ms → 2178 ms while `usage/stats` scanned 179 MB).
///
/// `block_in_place` rather than `spawn_blocking` so the public API stays
/// synchronous (no caller signature changes, no `'static` bound). It panics on a
/// `current_thread` runtime, hence the flavour check; outside a multi-thread
/// runtime the closure runs inline, exactly as before — which keeps the unit
/// tests below and the CLI path working.
fn offload<F, R>(f: F) -> R
where
    F: FnOnce() -> R,
{
    let multi_thread = tokio::runtime::Handle::try_current()
        .map(|h| h.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread)
        .unwrap_or(false);
    if multi_thread {
        tokio::task::block_in_place(f)
    } else {
        f()
    }
}

/// Sub-directory name for session attachments.
pub const UPLOADS_DIR: &str = "uploads";

/// Max single image size for dataUrl inlining in meta (8MB).
const META_IMAGE_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// Whole-batch dataUrl budget in meta (24MB).
pub const META_DATAURL_BUDGET_BYTES: u64 = 24 * 1024 * 1024;
/// Max paths per meta request.
pub const ATTACHMENT_META_MAX_PATHS: usize = 32;

/// Image extension whitelist (shared by all attachment code paths).
const IMAGE_EXTENSIONS: [&str; 7] = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"];

/// Windows reserved device names.
const WINDOWS_RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Validate an attachment file name (simple name, no path components).
pub fn is_valid_attachment_name(name: &str) -> bool {
    if name.is_empty() || name.contains('\0') {
        return false;
    }
    if name.contains("..") || name.contains('/') || name.contains('\\') {
        return false;
    }
    if name.starts_with('.') || name == "." || name == ".." {
        return false;
    }
    // Windows reserved names (case-insensitive, with or without extension)
    let stem = name.split('.').next().unwrap_or(name);
    if WINDOWS_RESERVED.iter().any(|r| r.eq_ignore_ascii_case(stem)) {
        return false;
    }
    true
}

/// Truncate over-long file names to 180 chars, preserving the extension.
pub fn truncate_attachment_name(name: &str) -> String {
    const MAX_LEN: usize = 180;
    if name.chars().count() <= MAX_LEN {
        return name.to_string();
    }
    let ext = name.rsplit_once('.').map(|(_, e)| format!(".{}", e)).unwrap_or_default();
    let stem: String = name.chars().take(MAX_LEN.saturating_sub(ext.chars().count())).collect();
    format!("{}{}", stem, ext)
}

/// Extension of a file name (lowercase, no dot).
pub fn ext_of_name(name: &str) -> String {
    name.rsplit('.')
        .next()
        .map(|s| s.to_lowercase())
        .unwrap_or_default()
}

/// Whether an attachment counts as an image: declared type must be "image"
/// AND the extension must be in the whitelist (same rule as Java kernel).
pub fn is_image_attachment(ext: &str, declared_type: &str) -> bool {
    declared_type == "image" && IMAGE_EXTENSIONS.iter().any(|e| *e == ext)
}

/// Resolve the uploads directory for a session.
pub fn uploads_dir(session_dir: &Path) -> PathBuf {
    session_dir.join(UPLOADS_DIR)
}

/// A saved attachment item (returned by upload endpoints).
#[derive(Debug, Clone, serde::Serialize)]
pub struct SavedAttachment {
    /// Relative path within the session: `uploads/<name>`.
    pub path: String,
    /// Effective type: "image" or "file".
    #[serde(rename = "type")]
    pub attach_type: String,
    pub name: String,
    pub size: u64,
}

/// Save one attachment file into the uploads directory.
/// Returns the saved item, or None if the name is invalid / write failed.
pub fn save_attachment(
    session_dir: &Path,
    file_name: &str,
    declared_type: &str,
    bytes: &[u8],
) -> Option<SavedAttachment> {
    if !is_valid_attachment_name(file_name) {
        return None;
    }
    // Owned copies for the blocking closure: `offload` needs `FnOnce` over data it
    // can move, and the caller's `&[u8]` / `&Path` borrows do not outlive the
    // hand-off on a multi-thread runtime.
    let session_dir = session_dir.to_path_buf();
    let file_name = file_name.to_string();
    let declared_type = declared_type.to_string();
    let bytes = bytes.to_vec();
    offload(move || save_attachment_blocking(&session_dir, &file_name, &declared_type, &bytes))
}

fn save_attachment_blocking(
    session_dir: &Path,
    file_name: &str,
    declared_type: &str,
    bytes: &[u8],
) -> Option<SavedAttachment> {
    let dir = uploads_dir(session_dir);
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    let target = dir.join(file_name);
    // Defense in depth: ensure the resolved path stays inside uploads dir.
    let canon_dir = std::fs::canonicalize(&dir).ok()?;
    let canon_target = {
        // canonicalize requires existence; write first then verify
        if std::fs::write(&target, bytes).is_err() {
            return None;
        }
        std::fs::canonicalize(&target).ok()?
    };
    if !canon_target.starts_with(&canon_dir) {
        let _ = std::fs::remove_file(&target);
        return None;
    }
    let ext = ext_of_name(file_name);
    let effective_type = if is_image_attachment(&ext, declared_type) { "image" } else { "file" };
    Some(SavedAttachment {
        path: format!("{}/{}", UPLOADS_DIR, file_name),
        attach_type: effective_type.to_string(),
        name: file_name.to_string(),
        size: bytes.len() as u64,
    })
}

/// Validate a relative attachment path (`uploads/<simple name>`) and resolve it.
pub fn resolve_attachment_path(session_dir: &Path, rel_path: &str) -> Option<PathBuf> {
    let trimmed = rel_path.trim();
    let rest = trimmed.strip_prefix(&format!("{}/", UPLOADS_DIR))?;
    if rest.is_empty() || rest.contains('/') || rest.contains('\\') || rest.contains("..") {
        return None;
    }
    if !is_valid_attachment_name(rest) {
        return None;
    }
    let p = uploads_dir(session_dir).join(rest);
    Some(p)
}

/// Meta results for a whole batch of requested paths.
///
/// The batch is processed inside **one** [`offload`] rather than offloading each
/// item, because the 24 MB dataUrl budget is shared across the batch: it must be
/// threaded through every item in order, and a `&mut u64` cannot cross into a
/// `block_in_place` closure per item without re-borrowing each time. Keeping the
/// loop (and the budget) inside a single blocking region is both simpler and
/// cheaper — one worker hand-off instead of up to 32.
///
/// This is the heaviest attachment path: up to 32 images, each read and
/// base64-encoded, against a 24 MB budget. On the async worker that is an ~88 MB
/// transient peak (raw bytes + base64 + the formatted data URL, three copies) that
/// stalls every other request; here it runs on the blocking pool.
pub fn attachment_meta_batch(session_dir: &Path, rel_paths: &[String]) -> Vec<serde_json::Value> {
    let session_dir = session_dir.to_path_buf();
    let rel_paths: Vec<String> = rel_paths.to_vec();
    offload(move || {
        let mut budget = META_DATAURL_BUDGET_BYTES;
        rel_paths
            .iter()
            .map(|p| attachment_meta_item(&session_dir, p, &mut budget))
            .collect()
    })
}

/// Meta result for one requested path.
pub fn attachment_meta_item(session_dir: &Path, rel_path: &str, budget: &mut u64) -> serde_json::Value {
    let mut item = serde_json::json!({ "path": rel_path });
    let Some(path) = resolve_attachment_path(session_dir, rel_path) else {
        item["error"] = serde_json::json!("invalid");
        return item;
    };
    if !path.is_file() {
        item["error"] = serde_json::json!("missing");
        return item;
    }
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let ext = ext_of_name(&name);
    let is_image = is_image_attachment(&ext, "image");
    item["name"] = serde_json::json!(name);
    item["size"] = serde_json::json!(size);
    item["type"] = serde_json::json!(if is_image { "image" } else { "file" });
    if is_image {
        if size > META_IMAGE_MAX_BYTES {
            item["error"] = serde_json::json!("too_large");
        } else if *budget < size {
            item["error"] = serde_json::json!("budget");
        } else if let Ok(bytes) = std::fs::read(&path) {
            let mime = mime_guess::from_path(&path).first_or_octet_stream().to_string();
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            item["dataUrl"] = serde_json::json!(format!("data:{};base64,{}", mime, b64));
            *budget = budget.saturating_sub(size);
        } else {
            item["error"] = serde_json::json!("missing");
        }
    }
    item
}

/// List all attachments in a session's uploads directory (metadata only, no dataUrl).
pub fn list_attachments(session_dir: &Path) -> Vec<serde_json::Value> {
    let session_dir = session_dir.to_path_buf();
    offload(move || list_attachments_blocking(&session_dir))
}

fn list_attachments_blocking(session_dir: &Path) -> Vec<serde_json::Value> {
    let dir = uploads_dir(session_dir);
    let mut items = Vec::new();
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return items;
    };
    for e in rd.flatten() {
        // One `metadata` call, not two: the previous version stat'd the same file
        // once for `len()` and again for `modified()`. `DirEntry::metadata` also
        // avoids a second path resolution (it does not follow symlinks, matching
        // the `is_file` check that `path.metadata` would otherwise repeat).
        let Ok(md) = e.metadata() else { continue };
        if !md.is_file() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        let size = md.len();
        let updated = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let ext = ext_of_name(&name);
        items.push(serde_json::json!({
            "name": name,
            "path": format!("{}/{}", UPLOADS_DIR, name),
            "size": size,
            "image": is_image_attachment(&ext, "image"),
            "updatedAt": updated,
        }));
    }
    // Newest first
    items.sort_by(|a, b| {
        let av = a["updatedAt"].as_i64().unwrap_or(0);
        let bv = b["updatedAt"].as_i64().unwrap_or(0);
        bv.cmp(&av)
    });
    items
}

/// Java's `ChatMessage.SESSION_INLINE_BASE64_MAX_CHARS` (64 KB).
///
/// Inline base64 longer than this is dropped from the persisted message and
/// replaced by an `storage=external` marker — see [`image_block_json`].
pub const SESSION_INLINE_BASE64_MAX_CHARS: usize = 64 * 1024;

/// Build the `blocks` entry for one image attachment, mirroring Java's
/// `ImageBlock` as written by `ChatMessage.toJson(msg, compactLargeMedia=true)`.
///
/// ## Why this exists
///
/// The persisted user line used to carry a single `TextBlock`. Java rebuilds a
/// `UserMessage` from `blocks` via the polymorphic `ChatMessage.fromJson`, so a
/// Rust-written line lost every image: reopening such a session in the Java
/// kernel showed text only, and the attachment metadata disagreed with the
/// message body.
///
/// ## Why large images are not inlined
///
/// Java's `compactLargeMediaInNode` clears `data` past 64 KB and stamps
/// `metas = {storage: external, data_truncated: true, original_data_length: N}`.
/// The user's own history shows exactly that shape
/// (`"original_data_length":217076`). Copying it keeps two properties that
/// matter here:
///
/// 1. the ndjson stays small — a 200 KB screenshot would otherwise be stored as
///    ~270 KB of base64 **per turn**, forever;
/// 2. history replay never re-sends the image. `to_chat_messages` rebuilds from
///    the text body only, so past turns stay text-only and the prompt does not
///    grow by megabytes on every subsequent call. Only the turn the user
///    actually attached the image to carries it (as a real `image_url` part).
///
/// `data_url` is the `data:<mime>;base64,<payload>` string already built for the
/// model, so no second read or re-encode happens here.
pub fn image_block_json(data_url: &str) -> Option<serde_json::Value> {
    // Split `data:<mime>;base64,<payload>`. Anything else is not a data URL we
    // produced, and guessing a mime would write a block Java cannot use.
    let rest = data_url.strip_prefix("data:")?;
    let (mime, payload) = rest.split_once(";base64,")?;
    if mime.is_empty() || payload.is_empty() {
        return None;
    }

    let mut block = serde_json::json!({
        "@type": "com.gourdai.ai.chat.content.ImageBlock",
        "mimeType": mime,
    });

    if payload.len() > SESSION_INLINE_BASE64_MAX_CHARS {
        // External form: no bytes, just the marker Java writes.
        block["data"] = serde_json::Value::Null;
        block["metas"] = serde_json::json!({
            "storage": "external",
            "data_truncated": true,
            "original_data_length": payload.len(),
        });
    } else {
        block["data"] = serde_json::json!(payload);
    }
    Some(block)
}

/// Read an attachment as a data URL (for multimodal injection). Returns None if not an image.
pub fn read_image_data_url(session_dir: &Path, rel_path: &str) -> Option<String> {
    let session_dir = session_dir.to_path_buf();
    let rel_path = rel_path.to_string();
    offload(move || read_image_data_url_blocking(&session_dir, &rel_path))
}

fn read_image_data_url_blocking(session_dir: &Path, rel_path: &str) -> Option<String> {
    let path = resolve_attachment_path(session_dir, rel_path)?;
    if !path.is_file() {
        return None;
    }
    let name = path.file_name()?.to_string_lossy().to_string();
    let ext = ext_of_name(&name);
    if !is_image_attachment(&ext, "image") {
        return None;
    }
    let size = std::fs::metadata(&path).ok()?.len();
    if size > META_IMAGE_MAX_BYTES {
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    let mime = mime_guess::from_path(&path).first_or_octet_stream().to_string();
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{};base64,{}", mime, b64))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_name_validation() {
        assert!(is_valid_attachment_name("report.pdf"));
        assert!(is_valid_attachment_name("image-a1b2c3.png"));
        assert!(!is_valid_attachment_name("../evil.txt"));
        assert!(!is_valid_attachment_name("a/b.txt"));
        assert!(!is_valid_attachment_name("a\\b.txt"));
        assert!(!is_valid_attachment_name(".hidden"));
        assert!(!is_valid_attachment_name("CON.txt"));
        assert!(!is_valid_attachment_name("NUL"));
        assert!(!is_valid_attachment_name(""));
    }

    #[test]
    fn test_image_detection_requires_declaration() {
        assert!(is_image_attachment("png", "image"));
        assert!(!is_image_attachment("png", "file"));
        assert!(!is_image_attachment("exe", "image"));
        assert!(!is_image_attachment("png", ""));
    }

    #[test]
    fn test_save_and_meta_roundtrip() {
        let dir = std::env::temp_dir().join(format!("gw-attach-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // 1x1 transparent PNG
        let png = base64::engine::general_purpose::STANDARD.decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        ).unwrap();
        let saved = save_attachment(&dir, "test.png", "image", &png).unwrap();
        assert_eq!(saved.path, "uploads/test.png");
        assert_eq!(saved.attach_type, "image");

        let mut budget = META_DATAURL_BUDGET_BYTES;
        let meta = attachment_meta_item(&dir, "uploads/test.png", &mut budget);
        assert_eq!(meta["type"], "image");
        assert!(meta["dataUrl"].as_str().unwrap().starts_with("data:image/png;base64,"));

        // Path traversal rejected
        let mut budget2 = META_DATAURL_BUDGET_BYTES;
        let bad = attachment_meta_item(&dir, "uploads/../evil.png", &mut budget2);
        assert_eq!(bad["error"], "invalid");

        let list = list_attachments(&dir);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["name"], "test.png");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ─── image_block_json: Java ImageBlock parity ────────────────────────────
    //
    // The persisted user line must carry an ImageBlock per image, or the Java
    // kernel (which rebuilds UserMessage from `blocks`) sees a text-only message.

    #[test]
    fn small_image_is_inlined() {
        let url = "data:image/png;base64,iVBORw0KGgo=";
        let block = image_block_json(url).unwrap();
        assert_eq!(block["@type"], "com.gourdai.ai.chat.content.ImageBlock");
        assert_eq!(block["mimeType"], "image/png");
        assert_eq!(block["data"], "iVBORw0KGgo=");
        // Under the threshold there is no external marker at all.
        assert!(block.get("metas").is_none());
    }

    #[test]
    fn large_image_is_externalised_like_java() {
        // One char past the 64 KB threshold.
        let payload = "A".repeat(SESSION_INLINE_BASE64_MAX_CHARS + 1);
        let url = format!("data:image/jpeg;base64,{}", payload);
        let block = image_block_json(&url).unwrap();
        assert_eq!(block["mimeType"], "image/jpeg");
        assert!(block["data"].is_null(), "data must be cleared, not inlined");
        assert_eq!(block["metas"]["storage"], "external");
        assert_eq!(block["metas"]["data_truncated"], true);
        assert_eq!(
            block["metas"]["original_data_length"].as_u64().unwrap(),
            (SESSION_INLINE_BASE64_MAX_CHARS + 1) as u64
        );
    }

    #[test]
    fn exactly_at_the_threshold_stays_inline() {
        // Java's test is `> MAX`, so a payload of exactly MAX chars is kept.
        let payload = "B".repeat(SESSION_INLINE_BASE64_MAX_CHARS);
        let url = format!("data:image/png;base64,{}", payload);
        let block = image_block_json(&url).unwrap();
        assert_eq!(block["data"].as_str().unwrap().len(), SESSION_INLINE_BASE64_MAX_CHARS);
        assert!(block.get("metas").is_none());
    }

    #[test]
    fn malformed_data_urls_are_rejected() {
        // Not a data URL / missing parts / empty payload: returning None keeps a
        // bogus block out of the persisted line instead of writing one Java
        // cannot deserialize.
        assert!(image_block_json("http://example.com/a.png").is_none());
        assert!(image_block_json("data:image/png").is_none());
        assert!(image_block_json("data:;base64,AAAA").is_none());
        assert!(image_block_json("data:image/png;base64,").is_none());
    }

    #[test]
    fn mime_with_parameters_is_preserved_verbatim() {
        let block = image_block_json("data:image/svg+xml;base64,QUJD").unwrap();
        assert_eq!(block["mimeType"], "image/svg+xml");
        assert_eq!(block["data"], "QUJD");
    }
}
