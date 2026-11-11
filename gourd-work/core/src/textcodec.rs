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
///
/// Two encoding policies, and picking the wrong one is a corruption source:
///
/// - [`StreamDecoder::new`] — GBK fallback. Right for shell/pipe/file output
///   from legacy Windows programs, which genuinely emit code page 936.
/// - [`StreamDecoder::strict_utf8`] — never switches to GBK. Required for any
///   stream that is UTF-8 **by contract** (HTTP/SSE JSON, LLM deltas, WebSocket
///   text frames). See the `gbk` field for the concrete damage the fallback
///   caused when it was wired to the LLM stream.
pub struct StreamDecoder {
    /// Incomplete UTF-8 sequence held from the previous chunk (≤ 3 bytes).
    pending: Vec<u8>,
    /// Set once the stream is proven non-UTF-8; the remainder is GBK.
    /// Stays `false` forever in strict mode.
    gbk: bool,
    /// Lone GBK lead byte held from the previous chunk (0 or 1 byte).
    gbk_pending: Vec<u8>,
    /// Strict mode: a non-UTF-8 byte is a *corruption*, not an encoding hint.
    ///
    /// The GBK switch is sticky and lossy by construction: once one bad byte
    /// flips it, **every following byte pair** is decoded as one GBK character.
    /// UTF-8 CJK is 3 bytes per character, so GBK eats 1.5 characters per one,
    /// silently deleting text — observed on LLM session work-mw8wizyz as
    /// `wx-ai`→`w-ai`, `org.dromara`→`org.d/org/grom`, and a whole Chinese
    /// clause rendered as the Latin word `wants`. Because the switch is
    /// permanent for the rest of the stream, one bad byte garbles the entire
    /// remainder of the turn, and the garbled bytes then land in tool-call
    /// arguments, so the kernel executes a nonsense path.
    ///
    /// For a stream that is UTF-8 by contract the fallback can only ever be
    /// wrong, so strict mode decodes the bad byte as U+FFFD (a detectable
    /// corruption signature, see `react::corruption_signatures`) and keeps the
    /// rest of the stream intact.
    strict: bool,
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
        Self { pending: Vec::new(), gbk: false, gbk_pending: Vec::new(), strict: false }
    }

    /// Decoder for a stream that is UTF-8 **by contract**: HTTP/SSE JSON,
    /// LLM token deltas, WebSocket text frames.
    ///
    /// A byte that is not valid UTF-8 on such a stream is upstream corruption
    /// (truncated frame, broken proxy, provider crash) — never an encoding hint.
    /// The lossy decoder turns it into exactly one U+FFFD and continues in
    /// UTF-8, so the consumer can *detect* the damage (see
    /// `react::corruption_signatures`) instead of inheriting a silently
    /// rewritten stream.
    pub fn strict_utf8() -> Self {
        Self { pending: Vec::new(), gbk: false, gbk_pending: Vec::new(), strict: true }
    }

    /// Feed one chunk; returns whatever text is decodable so far.
    pub fn push(&mut self, chunk: &[u8]) -> String {
        if chunk.is_empty() {
            return String::new();
        }

        // Strict mode first, and unconditionally: `self.gbk` can never be set
        // here, but an explicit branch documents that a contract-UTF-8 stream
        // must never enter the GBK state machine (its sticky latch would garble
        // every remaining byte pair of the stream).
        //
        // Iterative rather than recursive: one upstream hiccup can inject
        // several bad bytes into a single chunk, and a recursion per bad byte
        // is both wasteful and stack-risky on a large chunk.
        if self.strict {
            let mut buf: Vec<u8> = Vec::with_capacity(self.pending.len() + chunk.len());
            buf.extend_from_slice(&self.pending);
            buf.extend_from_slice(chunk);
            self.pending.clear();

            let mut out = String::with_capacity(buf.len());
            let mut rest: &[u8] = &buf;
            loop {
                match std::str::from_utf8(rest) {
                    Ok(s) => {
                        out.push_str(s);
                        break;
                    }
                    Err(e) => {
                        let valid_up_to = e.valid_up_to();
                        // `valid_up_to` is always a char boundary, so both
                        // slices are valid UTF-8 (the prefix) and raw bytes
                        // (the tail).
                        out.push_str(&String::from_utf8_lossy(&rest[..valid_up_to]));
                        rest = &rest[valid_up_to..];
                        match e.error_len() {
                            Some(n) => {
                                // A genuinely invalid byte sequence: emit one
                                // replacement for it and keep decoding UTF-8.
                                // One U+FFFD per *sequence* (not per byte) is
                                // what `from_utf8_lossy` does, and it keeps the
                                // corruption signature countable.
                                out.push('\u{FFFD}');
                                rest = &rest[n.min(rest.len())..];
                                if rest.is_empty() {
                                    break;
                                }
                            }
                            None => {
                                // Truncated multi-byte sequence at the chunk
                                // boundary: hold it for the next chunk (the
                                // CJK-split fix). A real UTF-8 prefix is ≤ 3
                                // bytes; anything longer is not a prefix, so
                                // flush it instead of holding garbage forever.
                                if rest.len() > 3 {
                                    out.push_str(&String::from_utf8_lossy(rest));
                                    break;
                                }
                                self.pending.extend_from_slice(rest);
                                break;
                            }
                        }
                    }
                }
            }
            return out;
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

/// A detected byte-order mark: the encoding it signals and the BOM's byte length.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bom {
    pub encoding: &'static str,
    pub len: usize,
}

/// Detect a leading BOM (UTF-8/16/32, both endiannesses).
///
/// Windows tooling routinely emits UTF-16LE (PowerShell `>` redirection,
/// `Out-File`) and editors save UTF-8-with-BOM; reading those bytes as UTF-8
/// yields a leading `\u{FEFF}` (UTF-8) or wholesale NUL-interleaved garbage
/// (UTF-16/32). The read tool strips the BOM and decodes the real encoding so
/// the model sees clean text. Order matters: UTF-32LE starts with the UTF-16LE
/// BOM (`FF FE 00 00`), so the 4-byte forms are tested first.
pub fn detect_bom(bytes: &[u8]) -> Option<Bom> {
    if bytes.len() >= 4 {
        if bytes[..4] == [0xFF, 0xFE, 0x00, 0x00] {
            return Some(Bom { encoding: "utf-32le", len: 4 });
        }
        if bytes[..4] == [0x00, 0x00, 0xFE, 0xFF] {
            return Some(Bom { encoding: "utf-32be", len: 4 });
        }
    }
    if bytes.len() >= 3 && bytes[..3] == [0xEF, 0xBB, 0xBF] {
        return Some(Bom { encoding: "utf-8", len: 3 });
    }
    if bytes.len() >= 2 {
        if bytes[..2] == [0xFF, 0xFE] {
            return Some(Bom { encoding: "utf-16le", len: 2 });
        }
        if bytes[..2] == [0xFE, 0xFF] {
            return Some(Bom { encoding: "utf-16be", len: 2 });
        }
    }
    None
}

/// Decode a complete buffer, honouring a leading BOM before the UTF-8→GBK path.
///
/// This is the file-read counterpart of [`decode_bytes`]: a BOM is an explicit
/// encoding declaration and always wins over the heuristic fallback. Without a
/// BOM it delegates to [`decode_bytes`] (strict UTF-8, then GBK), so legacy
/// code-page files keep working exactly as before.
pub fn decode_with_bom(bytes: &[u8]) -> String {
    let Some(bom) = detect_bom(bytes) else {
        return decode_bytes(bytes);
    };
    let body = &bytes[bom.len..];
    match bom.encoding {
        "utf-8" => decode_bytes(body),
        "utf-16le" => encoding_rs::UTF_16LE.decode(body).0.into_owned(),
        "utf-16be" => encoding_rs::UTF_16BE.decode(body).0.into_owned(),
        "utf-32le" => decode_utf32(body, true),
        "utf-32be" => decode_utf32(body, false),
        _ => decode_bytes(body),
    }
}

/// Decode UTF-32 (encoding_rs has no UTF-32 codec). Invalid code points become
/// U+FFFD, matching the lossy contract of the other decoders. A trailing partial
/// unit (length not a multiple of 4) is dropped — it cannot form a character.
fn decode_utf32(bytes: &[u8], little_endian: bool) -> String {
    let mut out = String::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        let cp = if little_endian {
            u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
        } else {
            u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
        };
        out.push(char::from_u32(cp).unwrap_or('\u{FFFD}'));
    }
    out
}

/// Heuristic binary detection: a NUL byte in the leading sample means the file
/// is not text (the same signal git and ripgrep use). Reading such a file as
/// text — especially through the GBK fallback — produces pages of mojibake that
/// pollute the model context, so the read tool refuses it up front.
pub fn looks_binary(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(8192)];
    sample.contains(&0)
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

    // ─── strict_utf8 (LLM/SSE contract streams) ────────────────────────────
    //
    // The bug these pin down is the one seen on session work-mw8wizyz: the LLM
    // stream used the GBK-fallback decoder, one bad byte from the upstream
    // latched it into GBK permanently, and every following UTF-8 CJK character
    // (3 bytes) was re-read as 1.5 GBK characters — i.e. the decoder *deleted*
    // text. Observed damage: `wx-ai`→`w-ai`, `org.dromara`→`org.d/org/grom`,
    // and a Chinese clause rendered as `wants`.

    /// A single invalid byte must cost exactly one U+FFFD, and the text after
    /// it must survive byte-for-byte. This is the exact shape the lossy decoder
    /// got wrong: it lost the *whole remainder* of the stream, not one byte.
    #[test]
    fn strict_recovers_after_one_bad_byte() {
        let tail = "抓紧排查下 wx-ai/wx-ai-agent/src/main/java/org/dromara/ai/models";
        let mut bad = Vec::new();
        bad.extend_from_slice("prefix ".as_bytes());
        bad.push(0xFF); // never valid UTF-8, not a valid GBK lead either
        bad.extend_from_slice(tail.as_bytes());

        let mut d = StreamDecoder::strict_utf8();
        let out = d.push(&bad) + &d.finish();

        assert!(out.starts_with("prefix "), "good prefix lost: {:?}", out);
        assert!(
            out.contains(tail),
            "text after the bad byte must be intact (this is what GBK latching destroyed): {:?}",
            out
        );
        assert_eq!(
            out.matches('\u{FFFD}').count(),
            1,
            "one bad byte ⇒ exactly one replacement, not a garbled tail: {:?}",
            out
        );
    }

    /// The lossy decoder must NOT be usable as a drop-in replacement for the
    /// strict one: this asserts the *difference*, so a future "simplification"
    /// that routes the LLM stream back through `new()` fails here.
    ///
    /// The tail is deliberately CJK. GBK is byte-compatible with ASCII, so a
    /// pure-ASCII tail survives the latch unharmed and the test would prove
    /// nothing — that is exactly why the reported damage clustered around
    /// Chinese text. Under the latch a 3-byte UTF-8 CJK character is re-read as
    /// 1.5 GBK characters, and because GBK lead bytes (0x81–0xFE) swallow the
    /// *next* byte unconditionally, following ASCII bytes get eaten as trail
    /// bytes too. The misalignment is self-perpetuating, so one bad byte
    /// garbles the whole remainder of the stream.
    #[test]
    fn lossy_decoder_loses_the_tail_but_strict_does_not() {
        let tail = "抓紧排查下渠道亲和 wx-ai/wx-ai-agent org.dromara.ai";
        let mut bytes = Vec::new();
        bytes.push(0xFF);
        bytes.extend_from_slice(tail.as_bytes());

        let mut lossy = StreamDecoder::new();
        let lossy_out = lossy.push(&bytes) + &lossy.finish();

        let mut strict = StreamDecoder::strict_utf8();
        let strict_out = strict.push(&bytes) + &strict.finish();

        assert!(
            strict_out.contains(tail),
            "strict must preserve the tail: {:?}",
            strict_out
        );
        assert!(
            !lossy_out.contains(tail),
            "the GBK latch is expected to mangle the tail — if this passes the \
             assertion above no longer proves anything: {:?}",
            lossy_out
        );
        assert!(
            !lossy_out.contains("渠道亲和"),
            "the reported symptom is CJK text vanishing under the latch: {:?}",
            lossy_out
        );
    }

    /// Several bad bytes in one chunk: iterative loop must not recurse, must
    /// not drop the text between them, and must not hang.
    #[test]
    fn strict_handles_multiple_bad_bytes_in_one_chunk() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice("aa".as_bytes());
        bytes.push(0xFF);
        bytes.extend_from_slice("中文".as_bytes());
        bytes.push(0x80); // a bare continuation byte
        bytes.extend_from_slice("bb".as_bytes());

        let mut d = StreamDecoder::strict_utf8();
        let out = d.push(&bytes) + &d.finish();

        assert!(out.starts_with("aa"), "{:?}", out);
        assert!(out.contains("中文"), "CJK between bad bytes must survive: {:?}", out);
        assert!(out.ends_with("bb"), "{:?}", out);
        assert_eq!(out.matches('\u{FFFD}').count(), 2, "{:?}", out);
    }

    /// Strict mode must still hold a CJK character split across chunks — that
    /// was the original reason the decoder exists, and it must not regress.
    #[test]
    fn strict_still_reassembles_split_multibyte_chars() {
        let s = "data: {\"text\":\"标签页只剩 skillhub 和 clawhub\"}\n\n";
        let bytes = s.as_bytes();
        for split in 1..bytes.len() {
            let mut d = StreamDecoder::strict_utf8();
            let mut out = String::new();
            out.push_str(&d.push(&bytes[..split]));
            out.push_str(&d.push(&bytes[split..]));
            out.push_str(&d.finish());
            assert!(!out.contains('\u{FFFD}'), "split {} produced {:?}", split, out);
            assert_eq!(out, s, "split at {} mismatched", split);
        }
    }

    /// Every split point of the reported failure shape (a bad byte followed by
    /// CJK and a path) must lose only the bad byte — a chunk boundary must
    /// never *add* corruption on top of it.
    #[test]
    fn strict_is_split_independent_with_one_bad_byte() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice("思考 ".as_bytes());
        bytes.push(0xFF);
        bytes.extend_from_slice(" org.dromara.ai".as_bytes());

        for split in 1..bytes.len() {
            let mut d = StreamDecoder::strict_utf8();
            let mut out = String::new();
            out.push_str(&d.push(&bytes[..split]));
            out.push_str(&d.push(&bytes[split..]));
            out.push_str(&d.finish());
            assert!(
                out.contains("思考") && out.contains("org.dromara.ai"),
                "split {} lost real text: {:?}",
                split,
                out
            );
            assert_eq!(
                out.matches('\u{FFFD}').count(),
                1,
                "split {} produced {:?} (expected exactly one replacement)",
                split,
                out
            );
        }
    }

    /// Strict mode must never latch into GBK: feeding genuine GBK bytes yields
    /// replacements, not a silent re-encoding. (A shell that really speaks GBK
    /// must use `new()`; routing it through strict is a bug in the *caller*,
    /// and this documents the intended behaviour.)
    #[test]
    fn strict_never_decodes_gbk() {
        let (bytes, _, _) = encoding_rs::GBK.encode("中文测试");
        let mut d = StreamDecoder::strict_utf8();
        let out = d.push(&bytes) + &d.finish();
        assert_ne!(out, "中文测试", "strict must not silently switch encodings");
        assert!(out.contains('\u{FFFD}'), "{:?}", out);
    }

    // ─── BOM detection / decode_with_bom / looks_binary ─────────────────────

    #[test]
    fn bom_detects_every_encoding() {
        assert_eq!(detect_bom(&[0xEF, 0xBB, 0xBF, b'a']).unwrap().encoding, "utf-8");
        assert_eq!(detect_bom(&[0xFF, 0xFE, b'a', 0]).unwrap().encoding, "utf-16le");
        assert_eq!(detect_bom(&[0xFE, 0xFF, 0, b'a']).unwrap().encoding, "utf-16be");
        // UTF-32LE shares the UTF-16LE prefix; the 4-byte form must win.
        assert_eq!(detect_bom(&[0xFF, 0xFE, 0x00, 0x00]).unwrap().encoding, "utf-32le");
        assert_eq!(detect_bom(&[0x00, 0x00, 0xFE, 0xFF]).unwrap().encoding, "utf-32be");
        assert!(detect_bom(b"plain ascii").is_none());
        assert!(detect_bom(&[]).is_none());
    }

    #[test]
    fn decode_with_bom_strips_and_decodes() {
        // UTF-8 BOM
        let mut v = vec![0xEF, 0xBB, 0xBF];
        v.extend_from_slice("你好".as_bytes());
        assert_eq!(decode_with_bom(&v), "你好");
        // UTF-16LE "Hi"
        assert_eq!(decode_with_bom(&[0xFF, 0xFE, b'H', 0, b'i', 0]), "Hi");
        // UTF-16BE "Hi"
        assert_eq!(decode_with_bom(&[0xFE, 0xFF, 0, b'H', 0, b'i']), "Hi");
        // UTF-32LE "A"
        assert_eq!(decode_with_bom(&[0xFF, 0xFE, 0, 0, b'A', 0, 0, 0]), "A");
        // No BOM → existing UTF-8 path
        assert_eq!(decode_with_bom("plain".as_bytes()), "plain");
        // No BOM, GBK bytes → existing fallback
        let (gbk, _, _) = encoding_rs::GBK.encode("中文");
        assert_eq!(decode_with_bom(&gbk), "中文");
    }

    #[test]
    fn looks_binary_flags_nul_bytes() {
        assert!(looks_binary(b"abc\0def"));
        assert!(looks_binary(&[0xFF, 0xFE, 0x00, 0x00]));
        assert!(!looks_binary("你好 world".as_bytes()));
        assert!(!looks_binary(b""));
        // NUL beyond the 8 KiB sample is not inspected (text with a late NUL
        // is rare; the sample bounds the cost).
        let mut late = vec![b'a'; 8192];
        late.push(0);
        assert!(!looks_binary(&late));
    }
}
