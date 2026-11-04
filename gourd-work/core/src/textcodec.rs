//! textcodec — unified byte→text decoding for every surface that renders bytes.
//!
//! ## Why this module exists
//!
//! `String::from_utf8_lossy` replaces each byte of an incomplete or non-UTF-8
//! sequence with U+FFFD. Two real-world sources produce such bytes:
//!
//! 1. **Chunk boundaries.** HTTP/TCP/pipe reads split a stream at arbitrary
//!    byte offsets; a 3-byte CJK character cut in half then decodes to
//!    replacement characters on both sides — the intermittent `` garbling
//!    reported in streamed replies (2026-10, Rust kernel only; the Java
//!    kernel decodes with a charset-aware reader and never shows it).
//! 2. **Legacy code pages.** Windows consoles and older tools still emit GBK
//!    (code page 936); those bytes are never valid UTF-8.
//!
//! Both are fixed here: [`StreamDecoder`] carries a truncated trailing
//! sequence across chunk boundaries, and both it and [`decode_bytes`] fall
//! back to GBK once the bytes are proven non-UTF-8 — the same policy the read
//! tool and the file tree already applied ad hoc, now in one place.
//!
//! Surfaces that must stay strict UTF-8 (JSON request bodies, binary protocol
//! frames) deliberately do NOT use this module.

/// Decode a complete byte buffer: strict UTF-8 first, GBK fallback.
///
/// GBK (superset of GB2312) covers legacy Simplified-Chinese Windows output;
/// other code pages still degrade to replacement characters, which is
/// acceptable because the surrounding template text is Rust-side UTF-8.
pub fn decode_bytes(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => {
            let (decoded, _, _) = encoding_rs::GBK.decode(bytes);
            decoded.into_owned()
        }
    }
}

/// Incremental decoder for byte streams whose chunking is arbitrary.
///
/// Valid bytes are emitted immediately (a shell prompt must reach the UI
/// without waiting for a newline); only a *truncated* multi-byte sequence at
/// the very end of a chunk is held back until the next chunk completes it.
pub struct StreamDecoder {
    /// Incomplete UTF-8 sequence held from the previous chunk (≤ 3 bytes).
    pending: Vec<u8>,
    /// Set once the stream is proven non-UTF-8; the remainder is GBK.
    gbk: bool,
    /// Lone GBK lead byte held from the previous chunk (0 or 1 byte).
    gbk_pending: Vec<u8>,
}

impl Default for StreamDecoder {
    fn default() -> Self {
        Self::new()
    }
}

/// Split a GBK buffer at the last complete character boundary.
///
/// GBK characters are at most two bytes (lead 0x81..=0xFE + trail), so the
/// only cross-chunk hazard is a lone lead byte at the very end. Walking from
/// a known boundary keeps the remainder exactly that one byte.
fn split_gbk_complete(buf: &[u8]) -> (&[u8], &[u8]) {
    let mut i = 0;
    let mut complete = 0;
    while i < buf.len() {
        let b = buf[i];
        if b <= 0x80 {
            i += 1; // ASCII (and 0x80) are single-byte in GBK
        } else if b <= 0xFE {
            if i + 1 < buf.len() {
                i += 2; // lead + trail
            } else {
                break; // lone lead at the tail: hold for the next chunk
            }
        } else {
            i += 1; // 0xFF: invalid single byte, decode() replaces it
        }
        complete = i;
    }
    (&buf[..complete], &buf[complete..])
}

/// Strip ANSI/VT100 escape sequences from command output before it reaches
/// the UI.
///
/// ## Why
/// Tool output is shown verbatim in a `<pre>` (see `_toolRenderers.bash` in
/// app-message.js, which only HTML-escapes the text). Child processes still
/// believe they are talking to a terminal, so they emit colour codes:
/// PowerShell 5.1 wraps redirected native-command stderr in `\x1b[31m…\x1b[0m`,
/// and git / npm / cargo all colourise when `TERM` looks capable.
///
/// The ESC byte itself is invisible in HTML, so what the user sees is the
/// leftover body: `[31m` and `[0m` printed literally, spliced into the middle
/// of the error text. On the real report the message read
/// `remote: [31m[session-…] 404 not found![0m` — the user reasonably read that
/// as "the command output is broken/red".
///
/// ## Scope
/// Only command *result* text goes through here. Model replies, file contents
/// and anything that is already user-visible text must NOT be touched: a
/// legitimate `[0m` in a stack trace or a regex example would be silently
/// corrupted, and that is worse than the cosmetic noise being fixed.
///
/// ## What is stripped
/// CSI (`ESC [ … final`), OSC (`ESC ] … BEL|ST`), and the two-byte `ESC x`
/// escapes. A lone ESC with nothing decodable after it is dropped too — it
/// renders as nothing anyway, and keeping it makes the output look non-empty.
pub fn strip_ansi(s: &str) -> String {
    if !s.contains('\u{1b}') {
        return s.to_string(); // fast path: 99% of output has no escapes
    }
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.next() {
            // CSI: ESC [ <params 0x30-0x3F> <intermediates 0x20-0x2F> <final 0x40-0x7E>
            Some('[') => {
                while let Some(&p) = chars.peek() {
                    chars.next();
                    if ('\u{40}'..='\u{7e}').contains(&p) {
                        break;
                    }
                }
            }
            // OSC: ESC ] … terminated by BEL or ST (ESC \\)
            Some(']') => {
                while let Some(p) = chars.next() {
                    if p == '\u{7}' {
                        break;
                    }
                    if p == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            // Two-byte escape (e.g. ESC ( B charset select): drop the payload too
            Some(p) if ('\u{20}'..='\u{2f}').contains(&p) => {
                if let Some(&q) = chars.peek() {
                    if ('\u{30}'..='\u{7e}').contains(&q) {
                        chars.next();
                    }
                }
            }
            // ESC + single final byte, or trailing ESC: nothing left to keep
            Some(_) | None => {}
        }
    }
    out
}

impl StreamDecoder {
    pub fn new() -> Self {
        Self { pending: Vec::new(), gbk: false, gbk_pending: Vec::new() }
    }

    /// Feed one chunk; returns whatever text is decodable so far.
    pub fn push(&mut self, chunk: &[u8]) -> String {
        if chunk.is_empty() {
            return String::new();
        }

        if self.gbk {
            let mut buf = std::mem::take(&mut self.gbk_pending);
            buf.extend_from_slice(chunk);
            let (complete, rest) = split_gbk_complete(&buf);
            self.gbk_pending = rest.to_vec();
            let (decoded, _, _) = encoding_rs::GBK.decode(complete);
            return decoded.into_owned();
        }

        let mut buf: Vec<u8> = Vec::with_capacity(self.pending.len() + chunk.len());
        buf.extend_from_slice(&self.pending);
        buf.extend_from_slice(chunk);
        self.pending.clear();

        match std::str::from_utf8(&buf) {
            Ok(s) => s.to_string(),
            Err(e) => {
                let valid_up_to = e.valid_up_to();
                if e.error_len().is_some() {
                    // Genuinely invalid bytes: the stream is not UTF-8. Keep
                    // the verified prefix as UTF-8 (ASCII is identical in both
                    // encodings) and decode the remainder as GBK from here.
                    let (complete, rest) = buf.split_at(valid_up_to);
                    let mut out = String::from_utf8_lossy(complete).into_owned();
                    self.gbk = true;
                    let (c2, r2) = split_gbk_complete(rest);
                    self.gbk_pending = r2.to_vec();
                    let (decoded, _, _) = encoding_rs::GBK.decode(c2);
                    out.push_str(&decoded);
                    out
                } else {
                    // Truncated sequence at the tail: hold it for next chunk.
                    let (complete, tail) = buf.split_at(valid_up_to);
                    let mut out = String::from_utf8_lossy(complete).into_owned();
                    if tail.len() > 3 {
                        // Longer than any UTF-8 continuation run: not a real
                        // prefix, flush instead of holding it forever.
                        out.push_str(&String::from_utf8_lossy(tail));
                    } else {
                        self.pending.extend_from_slice(tail);
                    }
                    out
                }
            }
        }
    }

    /// Flush at end of stream; returns text for any held-back bytes.
    pub fn finish(&mut self) -> String {
        if self.gbk {
            let leftover = std::mem::take(&mut self.gbk_pending);
            if leftover.is_empty() {
                return String::new();
            }
            let (decoded, _, _) = encoding_rs::GBK.decode(&leftover);
            return decoded.into_owned();
        }
        if self.pending.is_empty() {
            return String::new();
        }
        let leftover = std::mem::take(&mut self.pending);
        String::from_utf8_lossy(&leftover).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_passes_through() {
        assert_eq!(decode_bytes("你好 world".as_bytes()), "你好 world");
    }

    #[test]
    fn strip_ansi_removes_powershell_colour_codes() {
        // 现场形态：PowerShell 5.1 把 native command 的 stderr 包成红色
        let raw = "git : remote: \u{1b}[31m[session-c442] 404 not found!\u{1b}[0m\n";
        assert_eq!(strip_ansi(raw), "git : remote: [session-c442] 404 not found!\n");
    }

    #[test]
    fn strip_ansi_handles_multiple_and_nested_sequences() {
        assert_eq!(strip_ansi("\u{1b}[1m\u{1b}[31mbold red\u{1b}[0m done"), "bold red done");
        // 带参 CSI（光标、清屏）
        assert_eq!(strip_ansi("a\u{1b}[2K\u{1b}[1;1Hb"), "ab");
        // OSC 标题序列（BEL 与 ST 两种终结）
        assert_eq!(strip_ansi("\u{1b}]0;title\u{7}body"), "body");
        assert_eq!(strip_ansi("\u{1b}]8;;http://x\u{1b}\\link"), "link");
    }

    #[test]
    fn strip_ansi_keeps_text_that_only_looks_like_a_code() {
        // 关键回归护栏：未被 ESC 引导的「[31m」是用户真实文本（正则/栈帧/日志）
        let text = "match r'\\[0m' and arr[31] here";
        assert_eq!(strip_ansi(text), text, "无 ESC 前缀的方括号文本绝不能被动");
    }

    #[test]
    fn strip_ansi_drops_bare_escape_and_preserves_unicode() {
        assert_eq!(strip_ansi("中文\u{1b}"), "中文");
        assert_eq!(strip_ansi("思考完成：proxy 404 → 列表全空"), "思考完成：proxy 404 → 列表全空");
    }

    #[test]
    fn gbk_falls_back() {
        let (bytes, _, _) = encoding_rs::GBK.encode("中文测试");
        assert_eq!(decode_bytes(&bytes), "中文测试");
    }

    /// The reported bug: a multi-byte char split across two reads must not
    /// produce U+FFFD. Every split point is exercised.
    #[test]
    fn split_multibyte_char_across_chunks_has_no_replacement() {
        let s = "思考完成：proxy 404 → 列表全空";
        let bytes = s.as_bytes();
        for split in 1..bytes.len() {
            let mut d = StreamDecoder::new();
            let mut out = String::new();
            out.push_str(&d.push(&bytes[..split]));
            out.push_str(&d.push(&bytes[split..]));
            out.push_str(&d.finish());
            assert!(!out.contains('\u{FFFD}'), "split {} produced {:?}", split, out);
            assert_eq!(out, s, "split at {} mismatched", split);
        }
    }

    #[test]
    fn gbk_stream_split_mid_char() {
        let text = "旧内核缺 5 个市场端点";
        let (bytes, _, _) = encoding_rs::GBK.encode(text);
        for split in 1..bytes.len() {
            let mut d = StreamDecoder::new();
            let mut out = String::new();
            out.push_str(&d.push(&bytes[..split]));
            out.push_str(&d.push(&bytes[split..]));
            out.push_str(&d.finish());
            assert_eq!(out, text, "split {} mismatched", split);
        }
    }

    /// SSE-shaped stream: small fixed-size chunks cutting CJK chars apart.
    #[test]
    fn sse_style_chunks_reassemble() {
        let line = "data: {\"text\":\"标签页只剩 skillhub 和 clawhub\"}\n\n";
        let bytes = line.as_bytes();
        let mut d = StreamDecoder::new();
        let mut out = String::new();
        for chunk in bytes.chunks(7) {
            out.push_str(&d.push(chunk));
        }
        out.push_str(&d.finish());
        assert_eq!(out, line);
    }

    /// Valid bytes must be emitted on the same push (prompt visibility).
    #[test]
    fn ascii_is_emitted_immediately() {
        let mut d = StreamDecoder::new();
        assert_eq!(d.push(b"PS D:\\work> "), "PS D:\\work> ");
    }

    #[test]
    fn gbk_split_holds_only_a_lone_trailing_lead() {
        let (bytes, _, _) = encoding_rs::GBK.encode("旧AB");
        let (complete, rest) = split_gbk_complete(&bytes[..1]);
        assert!(complete.is_empty() && rest.len() == 1);
        let (complete, rest) = split_gbk_complete(&bytes);
        assert_eq!(rest.len(), 0);
        assert_eq!(complete, &bytes[..]);
        // ASCII tail stays complete; a trailing lead is held.
        let (bytes2, _, _) = encoding_rs::GBK.encode("A旧");
        let (complete, rest) = split_gbk_complete(&bytes2[..2]);
        assert_eq!(complete, &bytes2[..1]);
        assert_eq!(rest, &bytes2[1..2]);
    }

    #[test]
    fn truncated_tail_flushes_at_finish() {
        let bytes = "好".as_bytes(); // 3 bytes: E5 A5 BD
        let mut d = StreamDecoder::new();
        assert_eq!(d.push(&bytes[..2]), "", "incomplete char must be held");
        let tail = d.finish();
        assert!(tail.contains('\u{FFFD}'), "dangling bytes must not vanish: {:?}", tail);
    }
}
