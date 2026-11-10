//! Node read responses decoded as their wire types, tolerating fields an
//! engine appends to a record after the pinned wire.
//!
//! The engine extends a stored record by appending a `#[serde(default)]`
//! field. `rmp_serde` refuses a record array longer than its struct, so each
//! record is cut to the pinned width before the typed decode. A record
//! shorter than its struct is left for serde (missing defaults fill in).

use std::io::Cursor;

use rmpv::Value;
use serde::de::DeserializeOwned;

/// Where a read's records sit in the MessagePack value.
#[derive(Clone, Copy, Debug)]
pub enum Shape {
    /// A struct encoded as an array of `width` fields; `nested` names the
    /// fields that hold records themselves.
    Record {
        width: usize,
        nested: &'static [(usize, Shape)],
    },
    /// A `Vec` of the inner shape.
    List(&'static Shape),
    /// An `Option` of the inner shape (nil when absent).
    Optional(&'static Shape),
}

const FEE_TIER: Shape = Shape::Record {
    width: 3,
    nested: &[],
};
/// `MarketConfig`; field 13 is `fee_tiers`.
pub const MARKET_CONFIG: Shape = Shape::Record {
    width: 24,
    nested: &[(13, Shape::List(&FEE_TIER))],
};
const ATTACHED_CONDITIONAL: Shape = Shape::Record {
    width: 3,
    nested: &[],
};
/// `EventInfo`; field 9 is `attached_conditionals`.
pub const EVENT_INFO: Shape = Shape::Record {
    width: 10,
    nested: &[(9, Shape::List(&ATTACHED_CONDITIONAL))],
};
const POSITION_BRIEF: Shape = Shape::Record {
    width: 14,
    nested: &[],
};
const BINDING_SCENARIO: Shape = Shape::Record {
    width: 2,
    nested: &[],
};
/// `AccountInfo`; field 1 is `positions`, field 6 `binding_scenario`.
pub const ACCOUNT_INFO: Shape = Shape::Record {
    width: 10,
    nested: &[
        (1, Shape::List(&POSITION_BRIEF)),
        (6, Shape::List(&BINDING_SCENARIO)),
    ],
};

/// `proof_wire::types::Order`, including client id and resting-order metadata.
pub const ORDER: Shape = Shape::Record {
    width: 14,
    nested: &[],
};

pub const MAX_OPEN_ORDERS_BYTES: usize = 1024 * 1024;
pub const OPEN_ORDERS_OWNER_MISMATCH: &str = "open orders owner does not match request";

/// Decode the owner's resting orders using the canonical wire type. Legacy
/// trailing fields use its serde defaults; appended future fields are ignored.
/// This validates the response's owner but does not verify a finalized witness
/// or prove that the server returned every order.
pub fn decode_open_orders(
    bytes: &[u8],
    owner: &[u8; 20],
) -> Result<Vec<crate::types::Order>, &'static str> {
    if bytes.len() > MAX_OPEN_ORDERS_BYTES {
        return Err("open orders payload is too large");
    }
    crate::msgpack::reject_floats(bytes).map_err(|_| "invalid open orders payload")?;
    let raw = rmpv::decode::read_value(&mut Cursor::new(bytes))
        .map_err(|_| "invalid open orders payload")?;
    let rows = raw.as_array().ok_or("invalid open orders payload")?;
    for row in rows {
        let raw_owner = row.as_array().and_then(|fields| fields.get(2));
        // wire_bytes' tuple visitor may accept a longer bin and consume only
        // its first 20 bytes. Validate the raw owner before typed decoding.
        let valid = match raw_owner {
            Some(Value::Binary(bytes)) => bytes.len() == 20,
            Some(Value::Array(bytes)) => {
                bytes.len() == 20
                    && bytes
                        .iter()
                        .all(|value| value.as_u64().is_some_and(|b| b <= 255))
            }
            _ => false,
        };
        if !valid {
            return Err("invalid open orders owner bytes");
        }
    }
    let orders: Vec<crate::types::Order> =
        decode(bytes, &Shape::List(&ORDER)).map_err(|_| "invalid open orders payload")?;
    let mut previous = None;
    for order in &orders {
        if &order.owner != owner {
            return Err(OPEN_ORDERS_OWNER_MISMATCH);
        }
        if previous.is_some_and(|id| order.id <= id) {
            return Err("open orders are not strictly ordered by id");
        }
        if order.quantity == 0 {
            return Err("open orders contains an empty order");
        }
        previous = Some(order.id);
    }
    Ok(orders)
}

/// Decode `bytes` as `T`, first cutting every record `shape` names to its
/// pinned width. A value that does not have the shape is passed on unchanged
/// for the typed decode to refuse.
pub fn decode<T: DeserializeOwned>(
    bytes: &[u8],
    shape: &Shape,
) -> Result<T, rmp_serde::decode::Error> {
    let mut value = rmpv::decode::read_value(&mut Cursor::new(bytes))
        .map_err(|e| rmp_serde::decode::Error::Uncategorized(e.to_string()))?;
    cut(&mut value, shape);
    let mut cut_bytes = Vec::with_capacity(bytes.len());
    rmpv::encode::write_value(&mut cut_bytes, &value)
        .map_err(|e| rmp_serde::decode::Error::Uncategorized(e.to_string()))?;
    rmp_serde::from_slice(&cut_bytes)
}

fn cut(value: &mut Value, shape: &Shape) {
    match (shape, value) {
        (Shape::Record { width, nested }, Value::Array(fields)) => {
            fields.truncate(*width);
            for (index, inner) in *nested {
                if let Some(field) = fields.get_mut(*index) {
                    cut(field, inner);
                }
            }
        }
        (Shape::List(inner), Value::Array(items)) => {
            for item in items {
                cut(item, inner);
            }
        }
        (Shape::Optional(_), Value::Nil) => {}
        (Shape::Optional(inner), value) => cut(value, inner),
        _ => {}
    }
}

#[cfg(test)]
mod tests;
