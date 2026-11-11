//! Bounded finalized orderbook tuples, using the canonical wire read model.
use proof_wire::query::OrderbookSnapshot;
use std::fmt;
use std::io::Cursor;

pub const MAX_BOOK_BYTES: usize = 512 * 1024;

/// Typed refusal for a finalized orderbook payload. Each cause keeps its own
/// variant so callers classify by kind, never by message text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OrderbookError {
    /// Requested depth is not one of the served depths (1, 20, 100).
    InvalidDepth(usize),
    /// Payload exceeds `MAX_BOOK_BYTES`.
    Oversize(usize),
    /// Not strict MessagePack (floats, extensions, trailing bytes, ...).
    MessagePack(String),
    /// Top level is not a `[bids, asks]` pair.
    InvalidTuple,
    /// A side is not an array.
    SideNotArray,
    /// A side holds more levels than the requested depth.
    DepthExceeded { depth: usize, levels: usize },
    /// A level is not a `[price, total_quantity, order_count]` triple.
    InvalidLevelTuple,
    /// A level field is out of range for the canonical wire type.
    InvalidFields(String),
    /// Bids are not strictly descending or asks not strictly ascending.
    InvalidOrdering,
}

/// Coarse class of an [`OrderbookError`], matching the SDK read-error kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrderbookErrorKind {
    /// A bound was exceeded (byte size).
    Limit,
    /// The payload or request is not a valid finalized orderbook.
    Malformed,
}

impl OrderbookError {
    pub fn kind(&self) -> OrderbookErrorKind {
        match self {
            Self::Oversize(_) => OrderbookErrorKind::Limit,
            _ => OrderbookErrorKind::Malformed,
        }
    }
}

impl fmt::Display for OrderbookError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDepth(depth) => write!(f, "invalid orderbook depth {depth}"),
            Self::Oversize(len) => {
                write!(
                    f,
                    "orderbook payload of {len} bytes exceeds {MAX_BOOK_BYTES}"
                )
            }
            Self::MessagePack(cause) => write!(f, "invalid orderbook MessagePack: {cause}"),
            Self::InvalidTuple => f.write_str("invalid orderbook tuple"),
            Self::SideNotArray => f.write_str("orderbook side is not an array"),
            Self::DepthExceeded { depth, levels } => {
                write!(f, "orderbook depth exceeded: {levels} levels > {depth}")
            }
            Self::InvalidLevelTuple => f.write_str("invalid orderbook level tuple"),
            Self::InvalidFields(cause) => write!(f, "invalid orderbook fields: {cause}"),
            Self::InvalidOrdering => f.write_str("invalid orderbook level ordering"),
        }
    }
}

impl std::error::Error for OrderbookError {}

pub fn decode(bytes: &[u8], depth: usize) -> Result<OrderbookSnapshot, OrderbookError> {
    if ![1, 20, 100].contains(&depth) {
        return Err(OrderbookError::InvalidDepth(depth));
    }
    if bytes.len() > MAX_BOOK_BYTES {
        return Err(OrderbookError::Oversize(bytes.len()));
    }
    crate::msgpack::reject_floats(bytes).map_err(|e| OrderbookError::MessagePack(e.to_string()))?;
    let value = rmpv::decode::read_value(&mut Cursor::new(bytes))
        .map_err(|e| OrderbookError::MessagePack(e.to_string()))?;
    let sides = value
        .as_array()
        .filter(|v| v.len() == 2)
        .ok_or(OrderbookError::InvalidTuple)?;
    for side in sides {
        let rows = side.as_array().ok_or(OrderbookError::SideNotArray)?;
        if rows.len() > depth {
            return Err(OrderbookError::DepthExceeded {
                depth,
                levels: rows.len(),
            });
        }
        for row in rows {
            if row.as_array().is_none_or(|v| v.len() != 3) {
                return Err(OrderbookError::InvalidLevelTuple);
            }
        }
    }
    let book: OrderbookSnapshot =
        rmp_serde::from_slice(bytes).map_err(|e| OrderbookError::InvalidFields(e.to_string()))?;
    if book.bids.windows(2).any(|v| v[0].price <= v[1].price)
        || book.asks.windows(2).any(|v| v[0].price >= v[1].price)
    {
        return Err(OrderbookError::InvalidOrdering);
    }
    Ok(book)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_tuple_keeps_exact_ranges_and_zero_facts() {
        let bytes = rmp_serde::to_vec(&(
            vec![(u64::MAX, u64::MAX, u32::MAX)],
            vec![(0u64, 0u64, 0u32)],
        ))
        .unwrap();
        let book = decode(&bytes, 1).unwrap();
        assert_eq!(book.bids[0].price, u64::MAX);
        assert_eq!(book.bids[0].order_count, u32::MAX);
        assert_eq!(book.asks[0].total_quantity, 0);
    }
    #[test]
    fn shape_order_depth_and_framing_fail_closed() {
        for rows in [
            vec![(1u64, 1u64, 1u32), (1, 1, 1)],
            vec![(1, 1, 1), (2, 1, 1)],
        ] {
            let bytes = rmp_serde::to_vec(&(rows, Vec::<(u64, u64, u32)>::new())).unwrap();
            assert!(decode(&bytes, 20).is_err());
        }
        let bytes = rmp_serde::to_vec(&(
            vec![(2u64, 1u64, 1u32), (1, 1, 1)],
            Vec::<(u64, u64, u32)>::new(),
        ))
        .unwrap();
        assert!(decode(&bytes, 1).is_err());
        let equal_asks = rmp_serde::to_vec(&(
            Vec::<(u64, u64, u32)>::new(),
            vec![(1u64, 1u64, 1u32), (1, 2, 1)],
        ))
        .unwrap();
        assert_eq!(
            decode(&equal_asks, 20).err().expect("equal asks must fail"),
            OrderbookError::InvalidOrdering
        );
        let mut bad = bytes.clone();
        bad.push(0);
        assert!(decode(&bad, 20).is_err());
        let oversize = decode(&vec![0; MAX_BOOK_BYTES + 1], 20).err().unwrap();
        assert_eq!(oversize, OrderbookError::Oversize(MAX_BOOK_BYTES + 1));
        assert_eq!(oversize.kind(), OrderbookErrorKind::Limit);
        assert!(decode(
            &rmp_serde::to_vec(&(vec![(1, 2, 3, 4)], Vec::<u64>::new())).unwrap(),
            20
        )
        .is_err());
    }

    #[test]
    fn causes_keep_distinct_variants() {
        assert_eq!(
            decode(&[0x90], 2).err(),
            Some(OrderbookError::InvalidDepth(2))
        );
        let side_not_array = rmp_serde::to_vec(&(1u8, Vec::<u64>::new())).unwrap();
        assert_eq!(
            decode(&side_not_array, 20).err(),
            Some(OrderbookError::SideNotArray)
        );
        let deep = rmp_serde::to_vec(&(
            vec![(2u64, 1u64, 1u32), (1, 1, 1)],
            Vec::<(u64, u64, u32)>::new(),
        ))
        .unwrap();
        assert_eq!(
            decode(&deep, 1).err(),
            Some(OrderbookError::DepthExceeded {
                depth: 1,
                levels: 2
            })
        );
        let float = rmp_serde::to_vec(&(vec![(1.5f64, 1u64, 1u32)], Vec::<u64>::new())).unwrap();
        let err = decode(&float, 20).err().unwrap();
        assert!(matches!(err, OrderbookError::MessagePack(ref cause) if !cause.is_empty()));
        assert_eq!(err.kind(), OrderbookErrorKind::Malformed);
        let negative = rmp_serde::to_vec(&(vec![(-1i64, 1u64, 1u32)], Vec::<u64>::new())).unwrap();
        assert!(matches!(
            decode(&negative, 20).err(),
            Some(OrderbookError::InvalidFields(_))
        ));
    }
}
