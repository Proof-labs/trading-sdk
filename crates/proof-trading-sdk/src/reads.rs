//! Node read responses decoded as their wire types, tolerating fields an
//! engine appends to a record after the pinned wire.
//!
//! The engine extends a stored record by appending a `#[serde(default)]`
//! field. `rmp_serde` refuses a record array longer than its struct, so each
//! record is cut to the pinned width before the typed decode. A record
//! shorter than its struct is left for serde (missing defaults fill in).

use std::collections::HashSet;
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

/// A row of the market listing the decoder refused, named by its market id.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefusedMarketRow {
    /// Position of the row in the listing.
    pub index: u32,
    /// The market the row names (its first field): non-zero, and named by no
    /// other row of the listing.
    pub market: u32,
    /// Fields in the row.
    pub field_count: u32,
    /// Why the row was refused (the wire decoder's message).
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
/// know, a value out of range) is reported in `refused_rows`, but only when
/// the market it belongs to is certain: the row is an array whose first field
/// is a non-zero market id that no other row names. Anything else refuses the
/// whole listing, as does a payload that is not a list or that fails the
/// strict MessagePack preflight anywhere (including in appended fields): a
/// caller can then never lose a market without knowing which one.
pub fn decode_market_listing(bytes: &[u8]) -> Result<MarketListingRows, ListingError> {
    let rows = decode_rows::<crate::types::MarketConfig>(
        bytes,
        &MARKET_CONFIG,
        Listing::Markets,
        |config| config.market,
    )?;
    Ok(MarketListingRows {
        markets: rows.decoded,
        row_field_counts: rows.field_counts,
        refused_rows: rows
            .refused
            .into_iter()
            .map(|row| RefusedMarketRow {
                index: row.index,
                market: row.id,
                field_count: row.field_count,
                error: row.error,
            })
            .collect(),
    })
}

/// Which listing a [`ListingError`] refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Listing {
    /// The market listing (`GET /v1/markets`).
    Markets,
    /// The events listing (`GET /v1/events`).
    Events,
}

impl Listing {
    fn name(self) -> &'static str {
        match self {
            Self::Markets => "market listing",
            Self::Events => "events listing",
        }
    }

    fn entity(self) -> &'static str {
        match self {
            Self::Markets => "market",
            Self::Events => "event",
        }
    }
}

/// Why a whole listing was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ListingFault {
    /// The payload failed the strict MessagePack preflight.
    Payload(crate::msgpack::MsgpackError),
    /// The payload is not a list.
    NotAList,
    /// Row `index` is not an array.
    RowNotArray { index: u32 },
    /// Row `index` does not decode and its first field is no non-zero id.
    NoId { index: u32 },
    /// Row `index` does not decode and names `id`, which another row names.
    DuplicateId { index: u32, id: u32 },
}

/// A listing refused whole: which listing, and why.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ListingError {
    pub listing: Listing,
    pub fault: ListingFault,
}

impl std::fmt::Display for ListingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (name, entity) = (self.listing.name(), self.listing.entity());
        match self.fault {
            ListingFault::Payload(error) => write!(f, "invalid {name} payload: {error}"),
            ListingFault::NotAList => write!(f, "{name} is not a list"),
            ListingFault::RowNotArray { index } => write!(f, "{name} row {index} is not an array"),
            ListingFault::NoId { index } => write!(f, "{name} row {index} names no {entity}"),
            ListingFault::DuplicateId { index, id } => write!(
                f,
                "{name} row {index} names {entity} {id}, which another row also names"
            ),
        }
    }
}

impl std::error::Error for ListingError {}

/// A row of the events listing the decoder refused, named by its event id.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefusedEventRow {
    /// Position of the row in the listing.
    pub index: u32,
    /// The event the row names (its first field): non-zero, and named by no
    /// other row of the listing.
    pub event_id: u32,
    /// Fields in the row.
    pub field_count: u32,
    /// Why the row was refused (the wire decoder's message).
    pub error: String,
}

/// The events listing decoded row by row (`GET /v1/events`).
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventListingRows {
    /// The rows that decode as the pinned `EventInfo`, in listing order.
    pub events: Vec<crate::types::EventInfo>,
    /// The rows that do not decode, in listing order.
    pub refused_rows: Vec<RefusedEventRow>,
}

/// Decode the events listing one row at a time, as `decode` reads each row
/// (appended fields ignored, missing trailing fields defaulted). A row that
/// does not decode (an oracle source kind or event status this wire does not
/// know, a value out of range) is reported in `refused_rows`, but only when
/// the event it belongs to is certain: the row is an array whose first field
/// is a non-zero event id that no other row names. Anything else refuses the
/// whole listing, as does a payload that is not a list or that fails the
/// strict MessagePack preflight anywhere.
pub fn decode_event_listing(bytes: &[u8]) -> Result<EventListingRows, ListingError> {
    let rows =
        decode_rows::<crate::types::EventInfo>(bytes, &EVENT_INFO, Listing::Events, |event| {
            event.event_id.0
        })?;
    Ok(EventListingRows {
        events: rows.decoded,
        refused_rows: rows
            .refused
            .into_iter()
            .map(|row| RefusedEventRow {
                index: row.index,
                event_id: row.id,
                field_count: row.field_count,
                error: row.error,
            })
            .collect(),
    })
}

/// A refused row: its index, the id in its first field, its field count, why.
struct RefusedRow {
    index: u32,
    id: u32,
    field_count: u32,
    error: String,
}

/// A listing decoded row by row.
struct ListingRows<T> {
    decoded: Vec<T>,
    field_counts: Vec<u32>,
    refused: Vec<RefusedRow>,
}

/// Decode a list of `shape` records one row at a time. The strict preflight
/// every read takes (floats, extensions, duplicate keys, nesting depth,
/// trailing bytes) runs on the whole payload before any row is cut, so a
/// malformed value in a field the cut drops is still refused. A row that does
/// not decode is kept only when its first field is a non-zero `u32` id that
/// no decoded row (`id_of`) and no other refused row has; otherwise the whole
/// listing is refused; the error names `listing` and the fault.
fn decode_rows<T: DeserializeOwned>(
    bytes: &[u8],
    shape: &Shape,
    listing: Listing,
    id_of: impl Fn(&T) -> u32,
) -> Result<ListingRows<T>, ListingError> {
    let refuse = |fault| ListingError { listing, fault };
    crate::msgpack::reject_floats(bytes).map_err(|e| refuse(ListingFault::Payload(e)))?;
    let raw =
        rmpv::decode::read_value_with_max_depth(&mut Cursor::new(bytes), crate::msgpack::MAX_DEPTH)
            .map_err(|_| {
                refuse(ListingFault::Payload(
                    crate::msgpack::MsgpackError::Malformed,
                ))
            })?;
    let Value::Array(rows) = raw else {
        return Err(refuse(ListingFault::NotAList));
    };
    let mut listing_rows = ListingRows {
        decoded: Vec::with_capacity(rows.len()),
        field_counts: Vec::with_capacity(rows.len()),
        refused: Vec::new(),
    };
    for (index, row) in rows.into_iter().enumerate() {
        let index = u32::try_from(index).unwrap_or(u32::MAX);
        let Value::Array(fields) = &row else {
            return Err(refuse(ListingFault::RowNotArray { index }));
        };
        let field_count = u32::try_from(fields.len()).unwrap_or(u32::MAX);
        let id = fields
            .first()
            .and_then(Value::as_u64)
            .and_then(|id| u32::try_from(id).ok())
            .filter(|id| *id != 0);
        match decode_value::<T>(row, shape) {
            Ok(value) => {
                listing_rows.decoded.push(value);
                listing_rows.field_counts.push(field_count);
            }
            Err(error) => {
                let Some(id) = id else {
                    return Err(refuse(ListingFault::NoId { index }));
                };
                listing_rows.refused.push(RefusedRow {
                    index,
                    id,
                    field_count,
                    error: error.to_string(),
                });
            }
        }
    }
    let decoded_ids: HashSet<u32> = listing_rows.decoded.iter().map(&id_of).collect();
    let mut refused_ids = HashSet::new();
    for row in &listing_rows.refused {
        if decoded_ids.contains(&row.id) || !refused_ids.insert(row.id) {
            return Err(refuse(ListingFault::DuplicateId {
                index: row.index,
                id: row.id,
            }));
        }
    }
    Ok(listing_rows)
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
    let value = rmpv::decode::read_value(&mut Cursor::new(bytes))
        .map_err(|e| rmp_serde::decode::Error::Uncategorized(e.to_string()))?;
    decode_value(value, shape)
}

/// Decode one MessagePack `value` as `T`, first cutting every record `shape`
/// names to its pinned width (`decode` for a value already read).
fn decode_value<T: DeserializeOwned>(
    mut value: Value,
    shape: &Shape,
) -> Result<T, rmp_serde::decode::Error> {
    cut(&mut value, shape);
    let mut cut_bytes = Vec::new();
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
