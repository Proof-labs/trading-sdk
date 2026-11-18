//! The node's version 2 markets snapshot, `GET /v2/markets-snapshot`: one read
//! at one height of the chain id, every market with its governed status, every
//! event and each market's open interest, as proof-wire's `query_v2` view. The
//! read carries no witness.

use std::cmp::Ordering;
use std::collections::BTreeSet;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use proof_wire::query_v2::MarketsSnapshot as MarketsSnapshotView;

use super::{ChainBinding, Envelope, SnapshotError, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_ROWS};

/// Decode a complete `GET /v2/markets-snapshot` response body bound to
/// `expected_chain`. Another chain, an uncommitted height, a market or event
/// named twice, open interest out of market order, an `error` field, floats,
/// repeated map keys and trailing bytes all refuse the whole read. A status,
/// kind or other name this SDK does not know decodes as the view's `Unknown`.
pub fn decode_snapshot_view(
    body: &[u8],
    expected_chain: ChainBinding,
) -> Result<MarketsSnapshotView, SnapshotError> {
    if body.len() > MAX_SNAPSHOT_BYTES {
        return Err(SnapshotError::TooLarge);
    }
    let envelope: Envelope = serde_json::from_slice(body).map_err(|_| SnapshotError::Malformed)?;
    if envelope.error.is_some() {
        return Err(SnapshotError::Malformed);
    }
    let bytes = STANDARD
        .decode(envelope.data)
        .map_err(|_| SnapshotError::Malformed)?;
    crate::msgpack::reject_floats(&bytes).map_err(|_| SnapshotError::Malformed)?;
    // The view is a map keyed by field name, never the positional snapshot.
    if !matches!(bytes.first(), Some(0x80..=0x8f | 0xde | 0xdf)) {
        return Err(SnapshotError::Malformed);
    }
    let snapshot: MarketsSnapshotView =
        rmp_serde::from_slice(&bytes).map_err(|_| SnapshotError::Malformed)?;
    if snapshot.chain_id.0 != expected_chain.bytes() {
        return Err(SnapshotError::WrongChain);
    }
    if snapshot.height == 0 {
        return Err(SnapshotError::Uncommitted);
    }
    if [
        snapshot.markets.len(),
        snapshot.events.len(),
        snapshot.open_interest.len(),
    ]
    .into_iter()
    .any(|rows| rows > MAX_SNAPSHOT_ROWS)
    {
        return Err(SnapshotError::TooLarge);
    }
    let mut markets = BTreeSet::new();
    let mut events = BTreeSet::new();
    if !snapshot.markets.iter().all(|m| markets.insert(m.market))
        || !snapshot.events.iter().all(|e| events.insert(e.event_id))
    {
        return Err(SnapshotError::DuplicateMarket);
    }
    for pair in snapshot.open_interest.windows(2) {
        match pair[0].market.cmp(&pair[1].market) {
            Ordering::Less => {}
            Ordering::Equal => return Err(SnapshotError::DuplicateMarket),
            Ordering::Greater => return Err(SnapshotError::UnorderedOpenInterest),
        }
    }
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::arithmetic_side_effects
    )]

    use super::*;
    use proof_wire::query_v2::{self as view, MarketStatus};

    /// Byte-identical copy of the API gateway's frozen example (api-gateway
    /// `tests/fixtures/v2-markets-snapshot.json`): BTC trading, ETH
    /// reduce-only, TEST delisted and the prediction binary of event 7 halted.
    const GATEWAY_EXAMPLE: &str = include_str!("gateway-v2-markets-snapshot.json");

    fn chain() -> ChainBinding {
        ChainBinding::of_network("gateway-market-status-fixture").expect("the example's chain")
    }

    fn decode(body: &[u8]) -> Result<MarketsSnapshotView, SnapshotError> {
        decode_snapshot_view(body, chain())
    }

    /// The example's decoded snapshot, to change one thing in.
    fn example() -> MarketsSnapshotView {
        decode(GATEWAY_EXAMPLE.as_bytes()).expect("the example decodes")
    }

    /// The gateway's answer for `data`.
    fn body(data: &[u8]) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({ "data": STANDARD.encode(data) })).unwrap()
    }

    fn encoded(snapshot: &MarketsSnapshotView) -> Vec<u8> {
        body(&view::encode(snapshot).unwrap())
    }

    /// The example's MessagePack with the string `from` replaced by `to`, a
    /// name of the same length.
    fn renamed(from: &str, to: &str) -> Vec<u8> {
        assert_eq!(
            from.len(),
            to.len(),
            "a same-length name keeps the map valid"
        );
        let mut data = view::encode(&example()).unwrap();
        let at = data
            .windows(from.len())
            .position(|window| window == from.as_bytes())
            .unwrap_or_else(|| panic!("the example names {from}"));
        data[at..at + to.len()].copy_from_slice(to.as_bytes());
        body(&data)
    }

    #[test]
    fn the_gateway_example_decodes_one_market_in_each_status() {
        let snapshot = example();
        assert_eq!(snapshot.height, 12_816_657);
        assert_eq!(
            snapshot
                .markets
                .iter()
                .map(|m| (m.market, m.status))
                .collect::<Vec<_>>(),
            [
                (1, MarketStatus::Trading),
                (2, MarketStatus::ReduceOnly),
                (3, MarketStatus::Delisted),
                (100, MarketStatus::Halted),
            ]
        );
        assert_eq!(snapshot.events[0].binary_market, 100);
        assert_eq!(
            snapshot
                .open_interest
                .iter()
                .map(|oi| oi.market)
                .collect::<Vec<_>>(),
            [1, 2, 100]
        );
    }

    #[test]
    fn a_name_this_sdk_does_not_know_decodes_as_unknown() {
        let snapshot = decode(&renamed("halted", "paused")).expect("an unknown status decodes");
        assert_eq!(snapshot.markets[3].status, MarketStatus::Unknown);
        let snapshot = decode(&renamed("perpetual", "perpetuum")).expect("an unknown kind decodes");
        assert_eq!(snapshot.markets[0].kind, view::MarketKind::Unknown);
    }

    #[test]
    fn another_chain_or_an_uncommitted_height_is_refused() {
        let other = ChainBinding::of_network("another-chain").unwrap();
        assert_eq!(
            decode_snapshot_view(GATEWAY_EXAMPLE.as_bytes(), other).unwrap_err(),
            SnapshotError::WrongChain
        );
        let mut uncommitted = example();
        uncommitted.height = 0;
        assert_eq!(
            decode(&encoded(&uncommitted)).unwrap_err(),
            SnapshotError::Uncommitted
        );
    }

    #[test]
    fn a_repeated_market_or_event_and_unordered_open_interest_are_refused() {
        let mut market_twice = example();
        market_twice.markets.push(market_twice.markets[0].clone());
        let mut event_twice = example();
        event_twice.events.push(event_twice.events[0].clone());
        let mut open_interest_twice = example();
        open_interest_twice
            .open_interest
            .push(open_interest_twice.open_interest[2]);
        for (name, snapshot) in [
            ("a market twice", market_twice),
            ("an event twice", event_twice),
            ("open interest twice", open_interest_twice),
        ] {
            assert_eq!(
                decode(&encoded(&snapshot)).unwrap_err(),
                SnapshotError::DuplicateMarket,
                "{name}"
            );
        }
        let mut unordered = example();
        unordered.open_interest.swap(0, 1);
        assert_eq!(
            decode(&encoded(&unordered)).unwrap_err(),
            SnapshotError::UnorderedOpenInterest
        );
    }

    #[test]
    fn a_body_that_is_not_the_view_is_refused() {
        let data = view::encode(&example()).unwrap();
        let mut trailing = data.clone();
        trailing.push(0xc0);
        // The version 1 snapshot is positional; the view is a map.
        let positional = rmp_serde::to_vec(&example()).unwrap();
        let with_error = serde_json::to_vec(&serde_json::json!({
            "data": STANDARD.encode(&data),
            "error": "unavailable",
        }))
        .unwrap();
        for (name, body) in [
            ("trailing bytes", body(&trailing)),
            ("a positional snapshot", body(&positional)),
            ("an error field", with_error),
            ("a float height", with_float_height(&data)),
            ("not base64", br#"{"data":"not base64"}"#.to_vec()),
            ("no data", br#"{}"#.to_vec()),
        ] {
            assert_eq!(
                decode(&body).unwrap_err(),
                SnapshotError::Malformed,
                "{name}"
            );
        }
        assert_eq!(
            decode(&vec![b' '; MAX_SNAPSHOT_BYTES + 1]).unwrap_err(),
            SnapshotError::TooLarge
        );
    }

    /// The example with its height, a `u32` the encoder wrote as `0xce` and
    /// four bytes, rewritten as a float 32 of the same width.
    fn with_float_height(data: &[u8]) -> Vec<u8> {
        let key = b"\xa6height\xce";
        let at = data
            .windows(key.len())
            .position(|window| window == key)
            .expect("the example's height is a u32");
        let mut floated = data.to_vec();
        floated[at + key.len() - 1] = 0xca;
        body(&floated)
    }
}
