//! The node's version 2 markets snapshot, `GET /v2/markets-snapshot`: one read
//! at one height of the chain id, every market with its governed status, every
//! event and each market's open interest, as proof-wire's `query_v2` view. The
//! read carries no witness.

use std::cmp::Ordering;
use std::collections::BTreeSet;
use std::io::Cursor;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use proof_wire::query_v2::MarketsSnapshot as MarketsSnapshotView;
use rmpv::Value;

use super::{ChainBinding, Envelope, SnapshotError, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_ROWS};

/// Decode a complete `GET /v2/markets-snapshot` response body bound to
/// `expected_chain`. Another chain, an uncommitted height, a market or event
/// named twice, open interest out of market order, an `error` field, floats,
/// repeated map keys, trailing bytes, a record that is not a map keyed by
/// field name and a name that is not a string all refuse the whole read. A
/// status, kind or other name this SDK does not know decodes as the view's
/// `Unknown`.
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
    let raw = rmpv::decode::read_value_with_max_depth(
        &mut Cursor::new(bytes.as_slice()),
        crate::msgpack::MAX_DEPTH,
    )
    .map_err(|_| SnapshotError::Malformed)?;
    check_shape(&raw)?;
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

/// Refuse a view whose records are not all maps keyed by field name, at every
/// level this SDK reads: the snapshot, each market with its kind, mark and fee
/// tiers, each event with its resolution source and attached conditionals, and
/// each open interest row. rmp_serde also reads a record written as an array
/// of its fields, by position, so a producer that wrote one positionally
/// after a field was added or moved would have its fields read from the wrong
/// slots. Refuse, too, a name that is not a string (see [`name`]): a market's
/// status, its kind's type and branch, its mark's source, an event's status
/// and outcome, and its resolution source's type and comparison. Keys this
/// SDK does not know are skipped.
fn check_shape(raw: &Value) -> Result<(), SnapshotError> {
    let view = record(raw)?;
    for market in list(view, "markets")? {
        let market = record(market)?;
        name(field(market, "status"))?;
        if let Some(kind) = field(market, "kind") {
            let kind = record(kind)?;
            name(field(kind, "type"))?;
            name(field(kind, "branch"))?;
        }
        if let Some(mark) = field(market, "mark").filter(|mark| !mark.is_nil()) {
            name(field(record(mark)?, "source"))?;
        }
        for tier in list(market, "fee_tiers")? {
            record(tier)?;
        }
    }
    for event in list(view, "events")? {
        let event = record(event)?;
        name(field(event, "status"))?;
        name(field(event, "outcome").filter(|outcome| !outcome.is_nil()))?;
        if let Some(source) = field(event, "resolution_source") {
            let source = record(source)?;
            name(field(source, "type"))?;
            name(field(source, "comparison"))?;
        }
        for conditional in list(event, "attached_conditionals")? {
            record(conditional)?;
        }
    }
    for row in list(view, "open_interest")? {
        record(row)?;
    }
    Ok(())
}

/// A record's entries. The preflight has refused a key that is not a string
/// and a key named twice, so a field has at most one entry.
type Entries = [(Value, Value)];

/// `value` as a record: a map keyed by field name.
fn record(value: &Value) -> Result<&Entries, SnapshotError> {
    match value {
        Value::Map(entries) => Ok(entries.as_slice()),
        _ => Err(SnapshotError::Malformed),
    }
}

/// The value of `record`'s field `key`, if it has one.
fn field<'a>(record: &'a Entries, key: &str) -> Option<&'a Value> {
    record
        .iter()
        .find(|(name, _)| name.as_str() == Some(key))
        .map(|(_, value)| value)
}

/// The items of `record`'s list `key`. A missing list is left to the typed
/// decode, which refuses it.
fn list<'a>(record: &'a Entries, key: &str) -> Result<&'a [Value], SnapshotError> {
    match field(record, key) {
        None => Ok(&[]),
        Some(Value::Array(items)) => Ok(items.as_slice()),
        Some(_) => Err(SnapshotError::Malformed),
    }
}

/// Refuse a name that is not a string. rmp_serde reads an integer as a
/// variant's index, so a status sent as 0 would read as `trading`, and a
/// one-entry map as the variant it names: neither is a name the view sends,
/// and a value this SDK does not know must read as `Unknown`. A missing name
/// is left to the typed decode, which refuses one the view requires.
fn name(value: Option<&Value>) -> Result<(), SnapshotError> {
    match value {
        None | Some(Value::String(_)) => Ok(()),
        Some(_) => Err(SnapshotError::Malformed),
    }
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
    use proof_wire::market_settings::MarketSettingsSequence;
    use proof_wire::query_v2::{self as view, MarketStatus};
    use serde::Serialize;

    /// Byte-identical copy of the API gateway's frozen example (api-gateway
    /// `tests/fixtures/v2-markets-snapshot.json`): BTC trading, ETH
    /// reduce-only, TEST delisted and the prediction binary of event 7 halted.
    /// ETH is at settings sequence 1, every other market at 0.
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

    /// `snapshot`'s MessagePack as a tree of values, to change one value in.
    fn tree(snapshot: &MarketsSnapshotView) -> Value {
        rmpv::decode::read_value(&mut view::encode(snapshot).unwrap().as_slice()).unwrap()
    }

    /// The gateway's answer for `tree`.
    fn tree_body(tree: &Value) -> Vec<u8> {
        let mut data = Vec::new();
        rmpv::encode::write_value(&mut data, tree).unwrap();
        body(&data)
    }

    /// The value at `path` in `tree`: field names and list positions from the
    /// top, separated by `/`.
    fn at<'a>(mut tree: &'a mut Value, path: &str) -> &'a mut Value {
        for step in path.split('/') {
            tree = match tree {
                Value::Array(items) => &mut items[step.parse::<usize>().unwrap()],
                Value::Map(entries) => {
                    &mut entries
                        .iter_mut()
                        .find(|(key, _)| key.as_str() == Some(step))
                        .unwrap_or_else(|| panic!("the example has no {path}"))
                        .1
                }
                other => panic!("{path} passes through {other}"),
            };
        }
        tree
    }

    /// `record` as rmp_serde writes it by position: an array of its fields.
    fn by_position(record: &impl Serialize) -> Value {
        rmpv::decode::read_value(&mut rmp_serde::to_vec(record).unwrap().as_slice()).unwrap()
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
    fn each_market_reads_its_settings_sequence_and_zero_without_one() {
        let sequences = |snapshot: &MarketsSnapshotView| {
            snapshot
                .markets
                .iter()
                .map(|m| m.settings_sequence)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            sequences(&example()),
            [0, 1, 0, 0].map(MarketSettingsSequence)
        );
        // A node that does not serve the field sends no key: the market reads 0.
        let mut older = tree(&example());
        let Value::Map(eth) = at(&mut older, "markets/1") else {
            panic!("a market is a map");
        };
        eth.retain(|(key, _)| key.as_str() != Some("settings_sequence"));
        let snapshot = decode(&tree_body(&older)).expect("a market without the key decodes");
        assert_eq!(
            sequences(&snapshot),
            [0, 0, 0, 0].map(MarketSettingsSequence)
        );
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
    fn a_name_that_is_not_a_string_is_refused() {
        // rmp_serde reads an integer as a variant's index, and a one-entry map
        // as the variant it names. Inside a kind or a resolution source serde
        // refuses the integer, so those two fields take the map.
        let one_entry = |name: &str| Value::Map(vec![(Value::from(name), Value::Nil)]);
        let named = tree(&example());
        for (path, value, reading) in [
            ("markets/3/status", Value::from(0), "trading"),
            ("markets/3/kind/type", Value::from(0), "perpetual"),
            ("markets/3/kind/branch", one_entry("no"), "no"),
            ("markets/0/mark/source", Value::from(1), "median"),
            ("events/0/status", Value::from(2), "resolved"),
            ("events/0/outcome", Value::from(0), "yes"),
            (
                "events/0/resolution_source/type",
                Value::from(1),
                "quorum_attested",
            ),
            (
                "events/0/resolution_source/comparison",
                one_entry("less_than"),
                "less_than",
            ),
        ] {
            let mut edited = named.clone();
            *at(&mut edited, path) = value;
            assert_eq!(
                decode(&tree_body(&edited)).unwrap_err(),
                SnapshotError::Malformed,
                "{path}, which rmp_serde reads as {reading}"
            );
        }
    }

    #[test]
    fn a_record_written_by_position_is_refused() {
        let mut snapshot = example();
        // A fee tier and an attached conditional, so that every list the view
        // reads holds a record.
        snapshot.markets[0].fee_tiers.push(view::FeeTier {
            min_30d_volume_micro_usdc: 1_000_000_000,
            maker_fee_tenth_bps: -1,
            taker_fee_tenth_bps: 4,
        });
        snapshot.events[0]
            .attached_conditionals
            .push(view::AttachedConditional {
                underlying_market: 1,
                yes_market: 101,
                no_market: 102,
            });
        let named = tree(&snapshot);
        decode(&tree_body(&named)).expect("every record keyed by field name decodes");
        let (market, event) = (&snapshot.markets[0], &snapshot.events[0]);
        for (path, positional) in [
            ("markets/0", by_position(market)),
            ("markets/3/kind", by_position(&snapshot.markets[3].kind)),
            ("markets/0/mark", by_position(&market.mark)),
            ("markets/0/fee_tiers/0", by_position(&market.fee_tiers[0])),
            ("events/0", by_position(event)),
            (
                "events/0/resolution_source",
                by_position(&event.resolution_source),
            ),
            (
                "events/0/attached_conditionals/0",
                by_position(&event.attached_conditionals[0]),
            ),
            ("open_interest/0", by_position(&snapshot.open_interest[0])),
        ] {
            let mut edited = named.clone();
            *at(&mut edited, path) = positional;
            assert_eq!(
                decode(&tree_body(&edited)).unwrap_err(),
                SnapshotError::Malformed,
                "{path} by position"
            );
        }
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
            (
                "a float under a key the view does not have",
                with_unknown(&[("extra", Value::F64(1.5))]),
            ),
            (
                "a key the view does not have, twice",
                with_unknown(&[("extra", Value::from(1)), ("extra", Value::from(2))]),
            ),
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

    /// The example with `entries` added to its top-level map, under keys the
    /// view does not have. rmp_serde skips such a key whatever it holds, so
    /// only the preflight can refuse a float or a repeated key there.
    fn with_unknown(entries: &[(&str, Value)]) -> Vec<u8> {
        let mut snapshot = tree(&example());
        let Value::Map(top) = &mut snapshot else {
            panic!("the view is a map");
        };
        top.extend(
            entries
                .iter()
                .map(|(key, value)| (Value::from(*key), value.clone())),
        );
        tree_body(&snapshot)
    }
}
