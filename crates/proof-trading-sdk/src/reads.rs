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
