//! Strict governance read tuples using the canonical public wire types.

use std::io::Cursor;

use proof_wire::liquidation_config::{LiquidationConfig, LiquidationConfigSequence};
pub use proof_wire::query::AuthoritiesSnapshot;

pub const MAX_GOVERNANCE_READ_BYTES: usize = 1024 * 1024;
pub const MAX_AUTHORITY_SET_ENTRIES: usize = 4096;

fn raw(bytes: &[u8]) -> Result<rmpv::Value, &'static str> {
    if bytes.len() > MAX_GOVERNANCE_READ_BYTES {
        return Err("governance read exceeds byte limit");
    }
    crate::msgpack::reject_floats(bytes).map_err(|_| "invalid governance MessagePack")?;
    rmpv::decode::read_value(&mut Cursor::new(bytes)).map_err(|_| "invalid governance MessagePack")
}

fn tuple(value: &rmpv::Value, len: usize) -> Result<&[rmpv::Value], &'static str> {
    value
        .as_array()
        .filter(|v| v.len() == len)
        .map(Vec::as_slice)
        .ok_or("invalid governance record shape")
}

fn valid_address(value: &rmpv::Value) -> bool {
    match value {
        rmpv::Value::Binary(v) => v.len() == 20,
        rmpv::Value::Array(v) => {
            v.len() == 20 && v.iter().all(|b| b.as_u64().is_some_and(|n| n <= 255))
        }
        _ => false,
    }
}

/// Six authority sets; an empty set is a real decoded fact, never an error fallback.
pub fn decode_authorities(bytes: &[u8]) -> Result<AuthoritiesSnapshot, &'static str> {
    let value = raw(bytes)?;
    for set in tuple(&value, 6)? {
        let entries = set
            .as_array()
            .filter(|v| v.len() <= MAX_AUTHORITY_SET_ENTRIES)
            .ok_or("invalid authority set")?;
        if !entries.iter().all(valid_address) {
            return Err("invalid authority address");
        }
    }
    rmp_serde::from_slice(bytes).map_err(|_| "invalid authority fields")
}

/// The engine's stored pair wraps canonical sequence/config types. Legacy
/// five-field configs default the takeover discount through proof-wire serde.
/// Numeric facts are decoded without applying action-admission policy.
pub fn decode_liquidation_config(
    bytes: &[u8],
) -> Result<(LiquidationConfigSequence, LiquidationConfig), &'static str> {
    let value = raw(bytes)?;
    let fields = tuple(&value, 2)?;
    let config = fields[1]
        .as_array()
        .filter(|v| (5..=6).contains(&v.len()))
        .ok_or("invalid liquidation configuration shape")?;
    tuple(&config[1], 2)?;
    rmp_serde::from_slice(bytes).map_err(|_| "invalid liquidation configuration fields")
}

#[cfg(test)]
mod tests;
