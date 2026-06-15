use core::fmt;

use serde::de::DeserializeOwned;
use serde::Serialize;

/// Generic key-value state store. Object-safe — only raw byte operations.
/// Implemented by MemoryStore and Overlay.
///
/// Sorted by key bytes — enables prefix scanning on ordered backends
/// (BTreeMap in-memory, RocksDB on disk).
pub trait StateStore {
    fn get_raw(&self, key: &[u8]) -> Option<Vec<u8>>;
    fn put_raw(&mut self, key: &[u8], value: Vec<u8>);
    fn delete(&mut self, key: &[u8]);

    /// Return all key-value pairs whose key starts with `prefix`, sorted by key.
    /// Used for composite-key collections (e.g., all orders at a price level).
    fn scan_prefix(&self, prefix: &[u8]) -> Vec<(Vec<u8>, Vec<u8>)>;

    /// Return only keys matching a prefix. Implementations should prefer this
    /// when callers do not need values.
    fn scan_prefix_keys(&self, prefix: &[u8]) -> Vec<Vec<u8>> {
        self.scan_prefix(prefix)
            .into_iter()
            .map(|(key, _)| key)
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StateError {
    DecodeFailure {
        key: Vec<u8>,
        type_name: &'static str,
        message: String,
    },
    EncodeFailure {
        key: Vec<u8>,
        type_name: &'static str,
        message: String,
    },
    MissingRequiredKey {
        key: Vec<u8>,
        name: &'static str,
    },
    InvalidKeyLayout {
        key: Vec<u8>,
        message: String,
    },
    ArithmeticInvariantViolation {
        name: &'static str,
        message: String,
    },
}

impl fmt::Display for StateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StateError::DecodeFailure {
                key,
                type_name,
                message,
            } => write!(
                f,
                "failed to decode {type_name} at key 0x{}: {message}",
                format_key(key)
            ),
            StateError::EncodeFailure {
                key,
                type_name,
                message,
            } => write!(
                f,
                "failed to encode {type_name} at key 0x{}: {message}",
                format_key(key)
            ),
            StateError::MissingRequiredKey { key, name } => write!(
                f,
                "missing required state {name} at key 0x{}",
                format_key(key)
            ),
            StateError::InvalidKeyLayout { key, message } => {
                write!(f, "invalid key layout at 0x{}: {message}", format_key(key))
            }
            StateError::ArithmeticInvariantViolation { name, message } => {
                write!(f, "arithmetic invariant violated for {name}: {message}")
            }
        }
    }
}

impl std::error::Error for StateError {}

pub fn encode_value<T: Serialize>(key: &[u8], value: &T) -> Result<Vec<u8>, StateError> {
    rmp_serde::to_vec(value).map_err(|err| StateError::EncodeFailure {
        key: key.to_vec(),
        type_name: core::any::type_name::<T>(),
        message: err.to_string(),
    })
}

/// Typed convenience methods, blanket-implemented for all StateStore types.
pub trait StateStoreExt: StateStore {
    fn get_decoded<T: DeserializeOwned>(&self, key: &[u8]) -> Result<Option<T>, StateError> {
        let bytes = match self.get_raw(key) {
            Some(bytes) => bytes,
            None => return Ok(None),
        };

        rmp_serde::from_slice(&bytes)
            .map(Some)
            .map_err(|err| StateError::DecodeFailure {
                key: key.to_vec(),
                type_name: core::any::type_name::<T>(),
                message: err.to_string(),
            })
    }

    fn get_required<T: DeserializeOwned>(
        &self,
        key: &[u8],
        name: &'static str,
    ) -> Result<T, StateError> {
        self.get_decoded(key)?
            .ok_or_else(|| StateError::MissingRequiredKey {
                key: key.to_vec(),
                name,
            })
    }

    fn put_encoded<T: Serialize>(&mut self, key: &[u8], value: &T) -> Result<(), StateError> {
        let bytes = encode_value(key, value)?;
        self.put_raw(key, bytes);
        Ok(())
    }

    fn exists(&self, key: &[u8]) -> bool {
        self.get_raw(key).is_some()
    }

    fn mark_present(&mut self, key: &[u8]) {
        self.put_raw(key, vec![]);
    }

    fn count_prefix(&self, prefix: &[u8]) -> usize {
        self.scan_prefix_keys(prefix).len()
    }
}

impl<T: StateStore + ?Sized> StateStoreExt for T {}

fn format_key(key: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";

    let mut out = String::with_capacity(key.len().saturating_mul(2));
    for byte in key {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}
