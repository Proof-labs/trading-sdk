//! Strict, type-preserving MessagePack preflight shared by both language
//! spokes.
//!
//! `@msgpack/msgpack` (TypeScript) and `msgpack` (Python) both decode the float
//! families — `0xca` (float 32) and `0xcb` (float 64) — into a language number,
//! so a client that then asks "is this an integer?" cannot tell an integral
//! float (`1.0`) from a wire integer (`1`). The Python decoder is
//! type-preserving on the wire, but several of its coercions go through
//! `int(...)`, which silently truncates a float — so the two SDKs disagree about
//! which bytes are malformed.
//!
//! No engine or gateway read DTO carries a float field: every value is an
//! integer, byte string, UTF-8 string, boolean, array, map or option. Rejecting
//! every float tag is therefore exact, not a heuristic. Rather than maintain a
//! walk per module and per language, the walk lives here in the authoritative
//! core and is exposed to both spokes — `reject_floats` in the WASM crate (for
//! TypeScript) and in the PyO3 crate (for Python).
//!
//! The walk is deliberately stricter than "no floats": it also rejects
//! extensions, non-UTF-8 strings, duplicate map keys, over-deep nesting and
//! trailing bytes. Those are the shapes `market_snapshot` and the financial
//! state read already refuse in-language, and no read DTO uses any of them.

use std::collections::BTreeSet;
use std::fmt;
use std::io::Cursor;

use rmpv::Value;

/// Nesting bound, matching the in-language walks this replaces
/// (`market_snapshot::MAX_DEPTH`, the TypeScript preflight's depth cap).
pub const MAX_DEPTH: usize = 32;

/// Why a payload was refused. Deliberately coarse: the caller's wire model, not
/// this walk, owns the field-level meaning of a malformed value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MsgpackError {
    /// Not well-formed MessagePack, or bytes remain after the first value.
    Malformed,
    /// A float-family value (`f32`/`f64`) where the wire model has an integer.
    Float,
    /// Nesting deeper than [`MAX_DEPTH`].
    TooDeep,
    /// An extension value, which no read DTO carries.
    Extension,
    /// A string that is not valid UTF-8.
    InvalidString,
    /// The same map key appears more than once.
    DuplicateKey,
}

impl fmt::Display for MsgpackError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::Malformed => "malformed MessagePack",
            Self::Float => "msgpack float where the wire model has an integer",
            Self::TooDeep => "MessagePack nesting exceeds the depth bound",
            Self::Extension => "msgpack extension where the wire model has none",
            Self::InvalidString => "msgpack string is not valid UTF-8",
            Self::DuplicateKey => "duplicate msgpack map key",
        };
        f.write_str(message)
    }
}

impl std::error::Error for MsgpackError {}

/// Refuse payloads no integer-based read DTO may contain. `Ok(())` means the
/// bytes are safe for a language decoder to coerce as integers.
pub fn reject_floats(bytes: &[u8]) -> Result<(), MsgpackError> {
    let mut cursor = Cursor::new(bytes);
    let value =
        rmpv::decode::read_value_with_max_depth(&mut cursor, MAX_DEPTH).map_err(read_error)?;
    if usize::try_from(cursor.position()).ok() != Some(bytes.len()) {
        return Err(MsgpackError::Malformed);
    }
    validate(&value)
}

fn read_error(error: rmpv::decode::Error) -> MsgpackError {
    match error {
        rmpv::decode::Error::DepthLimitExceeded => MsgpackError::TooDeep,
        _ => MsgpackError::Malformed,
    }
}

fn validate(value: &Value) -> Result<(), MsgpackError> {
    match value {
        Value::F32(_) | Value::F64(_) => Err(MsgpackError::Float),
        Value::Ext(_, _) => Err(MsgpackError::Extension),
        Value::String(text) if text.as_str().is_none() => Err(MsgpackError::InvalidString),
        Value::Array(values) => values.iter().try_for_each(validate),
        Value::Map(entries) => {
            let mut keys = BTreeSet::new();
            for (key, value) in entries {
                let key = key.as_str().ok_or(MsgpackError::InvalidString)?;
                if !keys.insert(key) {
                    return Err(MsgpackError::DuplicateKey);
                }
                validate(value)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use rmpv::Value;

    fn encoded(value: &Value) -> Vec<u8> {
        let mut bytes = Vec::new();
        rmpv::encode::write_value(&mut bytes, value).unwrap();
        bytes
    }

    #[test]
    fn accepts_integers_bytes_strings_maps_and_arrays() {
        let value = Value::Array(vec![
            Value::from(1u64),
            Value::from(-1i64),
            Value::Binary(vec![0, 255]),
            Value::String("ok".into()),
            Value::Map(vec![(Value::String("k".into()), Value::from(2u64))]),
            Value::Boolean(true),
            Value::Nil,
        ]);
        assert_eq!(reject_floats(&encoded(&value)), Ok(()));
    }

    #[test]
    fn rejects_both_float_widths() {
        assert_eq!(
            reject_floats(&encoded(&Value::F32(1.0))),
            Err(MsgpackError::Float)
        );
        assert_eq!(
            reject_floats(&encoded(&Value::F64(1.0))),
            Err(MsgpackError::Float)
        );
    }

    #[test]
    fn rejects_a_float_nested_in_a_row() {
        let value = Value::Array(vec![Value::Array(vec![Value::from(1u64), Value::F64(2.0)])]);
        assert_eq!(reject_floats(&encoded(&value)), Err(MsgpackError::Float));
    }

    #[test]
    fn rejects_extensions_and_duplicate_keys() {
        assert_eq!(
            reject_floats(&encoded(&Value::Ext(1, vec![0]))),
            Err(MsgpackError::Extension)
        );
        let duplicate = Value::Map(vec![
            (Value::String("k".into()), Value::from(1u64)),
            (Value::String("k".into()), Value::from(2u64)),
        ]);
        assert_eq!(
            reject_floats(&encoded(&duplicate)),
            Err(MsgpackError::DuplicateKey)
        );
    }

    #[test]
    fn rejects_trailing_bytes_and_truncation() {
        let mut trailing = encoded(&Value::from(1u64));
        trailing.push(0x01);
        assert_eq!(reject_floats(&trailing), Err(MsgpackError::Malformed));
        assert_eq!(reject_floats(&[0xcc]), Err(MsgpackError::Malformed));
    }

    #[test]
    fn rejects_over_deep_nesting() {
        // MAX_DEPTH nested arrays then a scalar: one level past the bound.
        let mut value = Value::from(1u64);
        for _ in 0..=MAX_DEPTH {
            value = Value::Array(vec![value]);
        }
        assert_eq!(reject_floats(&encoded(&value)), Err(MsgpackError::TooDeep));
    }

    #[test]
    fn rejects_non_utf8_strings() {
        // str8 with one byte 0xff: valid msgpack, invalid UTF-8.
        assert_eq!(
            reject_floats(&[0xd9, 0x01, 0xff]),
            Err(MsgpackError::InvalidString)
        );
    }
}
