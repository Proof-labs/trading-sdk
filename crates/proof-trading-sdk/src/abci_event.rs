/// Writes ABCI events as length-prefixed strings into a byte buffer.
/// Go scans this sequentially into [][]abci.Event — self-describing,
/// no struct sync required across FFI.
///
/// Wire format:
///   per tx:    [event_count: u16 LE]
///   per event: [type_len: u16 LE][type bytes][attr_count: u16 LE]
///   per attr:  [key_len: u16 LE][key bytes][val_len: u16 LE][val bytes]
pub struct AbciEventWriter {
    buf: Vec<u8>,
}

impl Default for AbciEventWriter {
    fn default() -> Self {
        Self::new()
    }
}

// Safety: all arithmetic here operates on in-memory buffer lengths that are
// structurally bounded by individual ABCI event attributes — well within u16/usize
// ranges.  The `write!` calls only fail on allocation failure (infallible with Vec).
#[allow(clippy::arithmetic_side_effects, clippy::unwrap_used)]
impl AbciEventWriter {
    pub fn new() -> Self {
        Self {
            buf: Vec::with_capacity(256),
        }
    }

    pub fn write_tx_header(&mut self, count: u16) {
        self.buf.extend_from_slice(&count.to_le_bytes());
    }

    pub fn begin_event(&mut self, event_type: &str, attr_count: u16) {
        self.write_str(event_type);
        self.buf.extend_from_slice(&attr_count.to_le_bytes());
    }

    pub fn write_attr(&mut self, key: &str, value: &str) {
        self.write_str(key);
        self.write_str(value);
    }

    pub fn write_attr_u64(&mut self, key: &str, value: u64) {
        self.write_str(key);
        // Write decimal string directly, avoiding a String allocation.
        let start = self.buf.len();
        self.buf.extend_from_slice(&[0, 0]); // placeholder for length
        let before = self.buf.len();
        use std::io::Write;
        write!(&mut self.buf, "{value}").unwrap();
        let val_len = (self.buf.len() - before) as u16;
        self.buf[start..start + 2].copy_from_slice(&val_len.to_le_bytes());
    }

    pub fn write_attr_hex(&mut self, key: &str, bytes: &[u8]) {
        self.write_str(key);
        let hex_len = (bytes.len() * 2) as u16;
        self.buf.extend_from_slice(&hex_len.to_le_bytes());
        for b in bytes {
            self.buf.push(HEX_CHARS[(b >> 4) as usize]);
            self.buf.push(HEX_CHARS[(b & 0x0f) as usize]);
        }
    }

    pub fn write_attr_display(&mut self, key: &str, value: &impl core::fmt::Display) {
        self.write_str(key);
        let start = self.buf.len();
        self.buf.extend_from_slice(&[0, 0]);
        let before = self.buf.len();
        use std::io::Write;
        write!(&mut self.buf, "{value}").unwrap();
        let val_len = (self.buf.len() - before) as u16;
        self.buf[start..start + 2].copy_from_slice(&val_len.to_le_bytes());
    }

    fn write_str(&mut self, s: &str) {
        self.buf.extend_from_slice(&(s.len() as u16).to_le_bytes());
        self.buf.extend_from_slice(s.as_bytes());
    }

    pub fn into_vec(self) -> Vec<u8> {
        self.buf
    }
}

const HEX_CHARS: [u8; 16] = *b"0123456789abcdef";
