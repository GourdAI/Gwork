//! feishu_pb — Lightweight protobuf codec for Feishu WebSocket frames (Pbbp2).
//!
//! Hand-written encoder/decoder (no protobuf dependency), mirroring the Java
//! kernel's FeishuPbCodec. Frame layout:
//!   field 1: seqID (varint, always written — required in proto)
//!   field 2: logID (varint, always written — required in proto)
//!   field 3: service (varint)
//!   field 4: method (varint)  0=CONTROL, 1=DATA
//!   field 5: headers (repeated length-delimited)
//!   field 6: payloadEncoding (string)
//!   field 7: payloadType (string)
//!   field 8: payload (bytes)
//! Header layout: field 1 key (string), field 2 value (string).

const WIRE_VARINT: u8 = 0;
const WIRE_LEN: u8 = 2;

#[derive(Debug, Clone, Default)]
pub struct Header {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Default)]
pub struct Frame {
    pub seq_id: i64,
    pub log_id: i64,
    pub service: i64,
    pub method: i64, // 0=CONTROL, 1=DATA
    pub headers: Vec<Header>,
    pub payload_encoding: String,
    pub payload_type: String,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn get_header(&self, key: &str) -> Option<&str> {
        self.headers.iter().find(|h| h.key == key).map(|h| h.value.as_str())
    }

    pub fn payload_as_string(&self) -> String {
        String::from_utf8_lossy(&self.payload).to_string()
    }

    /// Build a ping/control frame.
    pub fn ping(service: i64, method: i64) -> Self {
        Self { seq_id: 0, log_id: 0, service, method, ..Default::default() }
    }
}

fn write_varint(buf: &mut Vec<u8>, mut v: u64) {
    loop {
        let byte = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            buf.push(byte);
            break;
        }
        buf.push(byte | 0x80);
    }
}

fn write_tag(buf: &mut Vec<u8>, field: u32, wire: u8) {
    write_varint(buf, ((field as u64) << 3) | (wire as u64));
}

fn write_string(buf: &mut Vec<u8>, field: u32, s: &str) {
    let bytes = s.as_bytes();
    write_tag(buf, field, WIRE_LEN);
    write_varint(buf, bytes.len() as u64);
    buf.extend_from_slice(bytes);
}

/// Encode a frame to protobuf bytes.
pub fn encode(frame: &Frame) -> Vec<u8> {
    let mut buf = Vec::new();
    // field 1: seqId — always written (required)
    write_tag(&mut buf, 1, WIRE_VARINT);
    write_varint(&mut buf, frame.seq_id as u64);
    // field 2: logId — always written (required)
    write_tag(&mut buf, 2, WIRE_VARINT);
    write_varint(&mut buf, frame.log_id as u64);
    // field 3: service
    if frame.service != 0 {
        write_tag(&mut buf, 3, WIRE_VARINT);
        write_varint(&mut buf, frame.service as u64);
    }
    // field 4: method — always written
    write_tag(&mut buf, 4, WIRE_VARINT);
    write_varint(&mut buf, frame.method as u64);
    // field 5: headers
    for h in &frame.headers {
        let mut hb = Vec::new();
        if !h.key.is_empty() {
            write_string(&mut hb, 1, &h.key);
        }
        if !h.value.is_empty() {
            write_string(&mut hb, 2, &h.value);
        }
        write_tag(&mut buf, 5, WIRE_LEN);
        write_varint(&mut buf, hb.len() as u64);
        buf.extend_from_slice(&hb);
    }
    // field 6: payloadEncoding
    if !frame.payload_encoding.is_empty() {
        write_string(&mut buf, 6, &frame.payload_encoding);
    }
    // field 7: payloadType
    if !frame.payload_type.is_empty() {
        write_string(&mut buf, 7, &frame.payload_type);
    }
    // field 8: payload
    if !frame.payload.is_empty() {
        write_tag(&mut buf, 8, WIRE_LEN);
        write_varint(&mut buf, frame.payload.len() as u64);
        buf.extend_from_slice(&frame.payload);
    }
    buf
}

fn read_varint(data: &[u8], pos: &mut usize) -> Option<u64> {
    let mut result: u64 = 0;
    let mut shift = 0;
    loop {
        if *pos >= data.len() {
            return None;
        }
        let byte = data[*pos];
        *pos += 1;
        result |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            return Some(result);
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
}

/// Decode a frame from protobuf bytes.
pub fn decode(data: &[u8]) -> Frame {
    let mut frame = Frame::default();
    let mut pos = 0usize;
    while pos < data.len() {
        let Some(tag) = read_varint(data, &mut pos) else { break };
        let field = (tag >> 3) as u32;
        let wire = (tag & 0x7) as u8;
        match wire {
            WIRE_VARINT => {
                let Some(v) = read_varint(data, &mut pos) else { break };
                match field {
                    1 => frame.seq_id = v as i64,
                    2 => frame.log_id = v as i64,
                    3 => frame.service = v as i64,
                    4 => frame.method = v as i64,
                    _ => {}
                }
            }
            WIRE_LEN => {
                let Some(len) = read_varint(data, &mut pos) else { break };
                let len = len as usize;
                if pos + len > data.len() {
                    break;
                }
                let bytes = &data[pos..pos + len];
                pos += len;
                match field {
                    5 => {
                        // Parse header sub-message
                        let mut h = Header::default();
                        let mut hpos = 0usize;
                        while hpos < bytes.len() {
                            let Some(htag) = read_varint(bytes, &mut hpos) else { break };
                            let hfield = (htag >> 3) as u32;
                            let hwire = (htag & 0x7) as u8;
                            if hwire == WIRE_LEN {
                                let Some(hlen) = read_varint(bytes, &mut hpos) else { break };
                                let hlen = hlen as usize;
                                if hpos + hlen > bytes.len() {
                                    break;
                                }
                                let s = String::from_utf8_lossy(&bytes[hpos..hpos + hlen]).to_string();
                                hpos += hlen;
                                match hfield {
                                    1 => h.key = s,
                                    2 => h.value = s,
                                    _ => {}
                                }
                            } else {
                                break;
                            }
                        }
                        frame.headers.push(h);
                    }
                    6 => frame.payload_encoding = String::from_utf8_lossy(bytes).to_string(),
                    7 => frame.payload_type = String::from_utf8_lossy(bytes).to_string(),
                    8 => frame.payload = bytes.to_vec(),
                    _ => {}
                }
            }
            _ => {
                // Unknown wire type — cannot safely skip; stop.
                break;
            }
        }
    }
    frame
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_decode_roundtrip() {
        let frame = Frame {
            seq_id: 42,
            log_id: 7,
            service: 3,
            method: 1,
            headers: vec![Header { key: "type".into(), value: "pong".into() }],
            payload_encoding: "gzip".into(),
            payload_type: "ack".into(),
            payload: b"hello".to_vec(),
        };
        let bytes = encode(&frame);
        let decoded = decode(&bytes);
        assert_eq!(decoded.seq_id, 42);
        assert_eq!(decoded.log_id, 7);
        assert_eq!(decoded.service, 3);
        assert_eq!(decoded.method, 1);
        assert_eq!(decoded.headers.len(), 1);
        assert_eq!(decoded.headers[0].key, "type");
        assert_eq!(decoded.headers[0].value, "pong");
        assert_eq!(decoded.payload_encoding, "gzip");
        assert_eq!(decoded.payload_type, "ack");
        assert_eq!(decoded.payload, b"hello");
    }

    #[test]
    fn test_ping_frame() {
        let ping = Frame::ping(3, 0);
        let bytes = encode(&ping);
        let decoded = decode(&bytes);
        assert_eq!(decoded.method, 0);
        assert_eq!(decoded.service, 3);
    }

    #[test]
    fn test_get_header() {
        let frame = Frame {
            headers: vec![Header { key: "X-Type".into(), value: "event".into() }],
            ..Default::default()
        };
        assert_eq!(frame.get_header("X-Type"), Some("event"));
        assert_eq!(frame.get_header("missing"), None);
    }
}
