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

const LEVEL_SUMMARY: Shape = Shape::Record {
    width: 3,
    nested: &[],
};
/// `query::OrderbookSnapshot`; fields 0 and 1 are `bids` and `asks`.
pub const ORDERBOOK: Shape = Shape::Record {
    width: 2,
    nested: &[
        (0, Shape::List(&LEVEL_SUMMARY)),
        (1, Shape::List(&LEVEL_SUMMARY)),
    ],
};
const POSITION: Shape = Shape::Record {
    width: 7,
    nested: &[],
};
/// `query::AccountStateInfo`; field 3 is `positions`.
pub const ACCOUNT_STATE: Shape = Shape::Record {
    width: 4,
    nested: &[(3, Shape::List(&POSITION))],
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
        let valid = raw_owner.is_some_and(valid_owner);
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

pub const ORDER_STATUS_ID_MISMATCH: &str = "order status answered another order";

/// The most bytes one order-status reply may hold: one order row.
pub const MAX_ORDER_STATUS_BYTES: usize = 4 * 1024;

/// Decode one order looked up by id (`/info` `orderStatus`) using the canonical
/// wire type: `None` when the engine answers nil (it holds no such order),
/// else the order as it rests, bound to the requested `order_id` (an answer
/// naming another order is refused). Legacy trailing fields use the wire's
/// serde defaults; appended future fields are ignored. The order's owner is
/// validated as 20 bytes but bound to no one: the request names an order id,
/// not an owner, so the caller checks whose order it is.
pub fn decode_order_status(
    bytes: &[u8],
    order_id: u64,
) -> Result<Option<crate::types::Order>, &'static str> {
    if bytes.len() > MAX_ORDER_STATUS_BYTES {
        return Err("order status payload is too large");
    }
    crate::msgpack::reject_floats(bytes).map_err(|_| "invalid order status payload")?;
    let raw = rmpv::decode::read_value(&mut Cursor::new(bytes))
        .map_err(|_| "invalid order status payload")?;
    if raw.is_nil() {
        return Ok(None);
    }
    let raw_owner = raw.as_array().and_then(|fields| fields.get(2));
    if !raw_owner.is_some_and(valid_owner) {
        return Err("invalid order status owner bytes");
    }
    let order: crate::types::Order =
        decode(bytes, &ORDER).map_err(|_| "invalid order status payload")?;
    if order.id != order_id {
        return Err(ORDER_STATUS_ID_MISMATCH);
    }
    Ok(Some(order))
}

/// A row of the market listing the decoder refused.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefusedMarketRow {
    /// Position of the row in the listing.
    pub index: u32,
    /// The row's market id, when its first field is one.
    pub market: Option<u32>,
    /// Fields in the row (0 when the row is not an array).
    pub field_count: u32,
    /// Why the row was refused.
    pub error: String,
}

/// The market listing decoded row by row (`GET /v1/markets`).
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketListingRows {
    /// The rows that decode as the pinned `MarketConfig`, in listing order.
    pub markets: Vec<crate::types::MarketConfig>,
    /// Fields in each decoded row, one per entry of `markets`.
    pub row_field_counts: Vec<u32>,
    /// The rows that do not decode, in listing order.
    pub refused_rows: Vec<RefusedMarketRow>,
}

/// Decode the market listing one row at a time, as `decode` reads each
/// row (appended fields ignored, missing trailing fields defaulted). A row
/// that does not decode (a market kind or mark-source mode this wire does not
/// know, a value out of range) is reported in `refused_rows` instead of
/// refusing the whole listing. A payload that is not a list, or that fails the
/// strict MessagePack preflight anywhere (including in appended fields), is
/// refused whole.
pub fn decode_market_listing(bytes: &[u8]) -> Result<MarketListingRows, &'static str> {
    // The strict preflight every read takes (floats, extensions, duplicate
    // keys, nesting depth, trailing bytes) runs on the whole payload before
    // any row is cut, so a malformed value in a field the cut drops is still
    // refused.
    crate::msgpack::reject_floats(bytes).map_err(|_| "invalid market listing payload")?;
    let raw =
        rmpv::decode::read_value_with_max_depth(&mut Cursor::new(bytes), crate::msgpack::MAX_DEPTH)
            .map_err(|_| "invalid market listing payload")?;
    let Value::Array(rows) = raw else {
        return Err("market listing is not a list");
    };
    let mut listing = MarketListingRows {
        markets: Vec::with_capacity(rows.len()),
        row_field_counts: Vec::with_capacity(rows.len()),
        refused_rows: Vec::new(),
    };
    for (index, mut row) in rows.into_iter().enumerate() {
        let field_count = row.as_array().map_or(0, Vec::len);
        let field_count = u32::try_from(field_count).unwrap_or(u32::MAX);
        let market = row
            .as_array()
            .and_then(|fields| fields.first())
            .and_then(Value::as_u64)
            .and_then(|id| u32::try_from(id).ok());
        let decoded = if row.is_array() {
            cut(&mut row, &MARKET_CONFIG);
            let mut row_bytes = Vec::new();
            rmpv::encode::write_value(&mut row_bytes, &row)
                .map_err(|e| e.to_string())
                .and_then(|()| {
                    rmp_serde::from_slice::<crate::types::MarketConfig>(&row_bytes)
                        .map_err(|e| e.to_string())
                })
        } else {
            Err("row is not an array".to_owned())
        };
        match decoded {
            Ok(config) => {
                listing.markets.push(config);
                listing.row_field_counts.push(field_count);
            }
            Err(error) => listing.refused_rows.push(RefusedMarketRow {
                index: u32::try_from(index).unwrap_or(u32::MAX),
                market,
                field_count,
                error,
            }),
        }
    }
    Ok(listing)
}

/// Whether a raw owner is exactly 20 bytes, as bin or byte array.
pub(crate) fn valid_owner(value: &Value) -> bool {
    match value {
        Value::Binary(bytes) => bytes.len() == 20,
        Value::Array(bytes) => {
            bytes.len() == 20
                && bytes
                    .iter()
                    .all(|value| value.as_u64().is_some_and(|byte| byte <= 255))
        }
        _ => false,
    }
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
