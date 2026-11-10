//! Bounded finalized orderbook tuples, using the canonical wire read model.
use proof_wire::query::OrderbookSnapshot;
use std::io::Cursor;

pub const MAX_BOOK_BYTES: usize = 512 * 1024;

pub fn decode(bytes: &[u8], depth: usize) -> Result<OrderbookSnapshot, &'static str> {
    if ![1, 20, 100].contains(&depth) || bytes.len() > MAX_BOOK_BYTES {
        return Err("invalid orderbook depth or byte limit");
    }
    crate::msgpack::reject_floats(bytes).map_err(|_| "invalid orderbook MessagePack")?;
    let value = rmpv::decode::read_value(&mut Cursor::new(bytes))
        .map_err(|_| "invalid orderbook MessagePack")?;
    let sides = value
        .as_array()
        .filter(|v| v.len() == 2)
        .ok_or("invalid orderbook tuple")?;
    for side in sides {
        let rows = side
            .as_array()
            .filter(|v| v.len() <= depth)
            .ok_or("orderbook depth exceeded")?;
        for row in rows {
            if row.as_array().is_none_or(|v| v.len() != 3) {
                return Err("invalid orderbook level tuple");
            }
        }
    }
    let book: OrderbookSnapshot =
        rmp_serde::from_slice(bytes).map_err(|_| "invalid orderbook fields")?;
    if book.bids.windows(2).any(|v| v[0].price <= v[1].price)
        || book.asks.windows(2).any(|v| v[0].price >= v[1].price)
    {
        return Err("invalid orderbook level ordering");
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
            "invalid orderbook level ordering"
        );
        let mut bad = bytes.clone();
        bad.push(0);
        assert!(decode(&bad, 20).is_err());
        assert!(decode(&vec![0; MAX_BOOK_BYTES + 1], 20).is_err());
        assert!(decode(
            &rmp_serde::to_vec(&(vec![(1, 2, 3, 4)], Vec::<u64>::new())).unwrap(),
            20
        )
        .is_err());
    }
}
