//! Strict raw settled account facts, decoded through the canonical wire DTO.
//! No mark, funding accrual, equity, margin or authorization is inferred.

use std::io::Cursor;

use crate::query::AccountStateInfo;
use crate::reads::{self, Shape};

pub const MAX_ACCOUNT_STATE_BYTES: usize = 512 * 1024;
pub const MAX_ACCOUNT_POSITIONS: usize = 2048;

const POSITION: Shape = Shape::Record {
    width: 7,
    nested: &[],
};
/// `AccountStateInfo`; field 3 is `positions`.
const ACCOUNT_STATE: Shape = Shape::Record {
    width: 4,
    nested: &[(3, Shape::List(&POSITION))],
};

/// Decode the account tuple and its positions, ignoring appended engine fields.
pub fn decode(bytes: &[u8], owner: &[u8; 20]) -> Result<AccountStateInfo, &'static str> {
    if bytes.len() > MAX_ACCOUNT_STATE_BYTES {
        return Err("account state payload exceeds byte limit");
    }
    crate::msgpack::reject_floats(bytes).map_err(|_| "invalid account state MessagePack")?;
    let value = rmpv::decode::read_value(&mut Cursor::new(bytes))
        .map_err(|_| "invalid account state MessagePack")?;
    let fields = value
        .as_array()
        .filter(|v| v.len() >= 4)
        .ok_or("account state must have at least four fields")?;
    if !reads::valid_owner(&fields[0]) {
        return Err("invalid account owner bytes");
    }
    let positions = fields[3]
        .as_array()
        .filter(|v| v.len() <= MAX_ACCOUNT_POSITIONS)
        .ok_or("invalid account positions")?;
    for position in positions {
        let fields = position
            .as_array()
            .filter(|v| v.len() >= 6)
            .ok_or("account position must have at least six fields")?;
        if !reads::valid_owner(&fields[0]) {
            return Err("invalid account position owner bytes");
        }
        if !matches!(fields[2].as_str(), Some("Buy" | "Sell")) {
            return Err("invalid account position side");
        }
    }
    let state: AccountStateInfo =
        reads::decode(bytes, &ACCOUNT_STATE).map_err(|_| "invalid account state fields")?;
    if &state.owner.0 != owner {
        return Err("account state owner does not match request");
    }
    let mut previous = None;
    for position in &state.positions {
        if position.owner != state.owner.0 {
            return Err("account position owner mismatch");
        }
        if previous.is_some_and(|market| position.market <= market) {
            return Err("account positions must be strictly ordered by market");
        }
        if position.entry_remainder != 0 && position.entry_remainder >= position.size {
            return Err("invalid account position entry remainder");
        }
        previous = Some(position.market);
    }
    Ok(state)
}

#[cfg(test)]
mod tests;
