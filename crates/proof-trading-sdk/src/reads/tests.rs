#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::arithmetic_side_effects
)]

use serde::de::{self, Deserializer, Visitor};

use super::*;
use crate::query::{
    AccountInfo, AccountStateInfo, BindingScenario, LevelSummary, OrderbookSnapshot, PositionBrief,
};
use crate::types::{AttachedConditional, EventInfo, FeeTier, MarketConfig, Position};

/// A deserializer that only records the field list serde derives for a struct.
struct FieldProbe<'a>(&'a mut &'static [&'static str]);

impl<'de> Deserializer<'de> for FieldProbe<'_> {
    type Error = de::value::Error;

    fn deserialize_any<V: Visitor<'de>>(self, _: V) -> Result<V::Value, Self::Error> {
        Err(de::Error::custom("not a struct"))
    }

    fn deserialize_struct<V: Visitor<'de>>(
        self,
        _: &'static str,
        fields: &'static [&'static str],
        _: V,
    ) -> Result<V::Value, Self::Error> {
        *self.0 = fields;
        Err(de::Error::custom("probed"))
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string
        bytes byte_buf option unit unit_struct newtype_struct seq tuple
        tuple_struct map enum identifier ignored_any
    }
}

fn fields_of<T: DeserializeOwned>() -> &'static [&'static str] {
    let mut fields: &'static [&'static str] = &[];
    let _ = T::deserialize(FieldProbe(&mut fields));
    assert!(
        !fields.is_empty(),
        "{} is not a struct",
        std::any::type_name::<T>()
    );
    fields
}

fn assert_shape<T: DeserializeOwned>(shape: &Shape, nested: &[&str]) {
    let Shape::Record { width, nested: at } = shape else {
        panic!("a read record is a struct")
    };
    let fields = fields_of::<T>();
    assert_eq!(*width, fields.len(), "{}", std::any::type_name::<T>());
    let names: Vec<_> = at.iter().map(|(index, _)| fields[*index]).collect();
    assert_eq!(names, nested, "{}", std::any::type_name::<T>());
}

fn inner(shape: &Shape, index: usize) -> &Shape {
    let Shape::Record { nested, .. } = shape else {
        panic!("a read record is a struct")
    };
    match &nested[index].1 {
        Shape::List(inner) | Shape::Optional(inner) => inner,
        record => record,
    }
}

#[test]
fn widths_and_nested_fields_follow_the_pinned_wire_types() {
    assert_shape::<crate::types::Order>(&ORDER, &[]);
    assert_shape::<MarketConfig>(&MARKET_CONFIG, &["fee_tiers"]);
    assert_shape::<FeeTier>(inner(&MARKET_CONFIG, 0), &[]);
    assert_shape::<EventInfo>(&EVENT_INFO, &["attached_conditionals"]);
    assert_shape::<AttachedConditional>(inner(&EVENT_INFO, 0), &[]);
    assert_shape::<AccountInfo>(&ACCOUNT_INFO, &["positions", "binding_scenario"]);
    assert_shape::<PositionBrief>(inner(&ACCOUNT_INFO, 0), &[]);
    assert_shape::<BindingScenario>(inner(&ACCOUNT_INFO, 1), &[]);
    assert_shape::<OrderbookSnapshot>(&ORDERBOOK, &["bids", "asks"]);
    assert_shape::<LevelSummary>(inner(&ORDERBOOK, 0), &[]);
    assert_shape::<AccountStateInfo>(&ACCOUNT_STATE, &["positions"]);
    assert_shape::<Position>(inner(&ACCOUNT_STATE, 0), &[]);
}

fn resting_order() -> crate::types::Order {
    crate::types::Order {
        id: 9_007_199_254_740_993,
        market: 7,
        owner: [0xab; 20],
        side: crate::types::Side::Buy,
        price: u64::MAX,
        quantity: 20,
        client_order_id: Some(u64::MAX),
        original_quantity: 23,
        filled_quantity: 3,
        created_at_ms: 1_794_182_400_000,
        queue_priority: u64::MAX,
        time_in_force: crate::types::TimeInForce::Gtc,
        post_only: true,
        reduce_only: false,
    }
}

#[test]
fn open_orders_preserve_wire_metadata_and_bind_owner() {
    let encoded = rmp_serde::to_vec(&vec![resting_order()]).unwrap();
    let decoded = decode_open_orders(&encoded, &[0xab; 20]).unwrap();
    assert_eq!(decoded[0].client_order_id, Some(u64::MAX));
    assert_eq!(decoded[0].original_quantity, 23);
    assert_eq!(decoded[0].filled_quantity, 3);
    assert_eq!(decoded[0].queue_priority, u64::MAX);
    assert!(decoded[0].post_only);
    assert!(decode_open_orders(&encoded, &[0xcd; 20]).is_err());
}

#[test]
fn open_orders_legacy_rows_use_wire_defaults() {
    let encoded = rmp_serde::to_vec(&resting_order()).unwrap();
    let mut row = rmpv::decode::read_value(&mut Cursor::new(encoded)).unwrap();
    fields(&mut row).truncate(6);
    let decoded = decode_open_orders(&bytes(&Value::Array(vec![row])), &[0xab; 20]).unwrap();
    assert_eq!(decoded[0].client_order_id, None);
    assert_eq!(decoded[0].original_quantity, 0);
    assert_eq!(decoded[0].created_at_ms, 0);
    assert!(!decoded[0].post_only);
}

#[test]
fn open_orders_reject_overlong_or_non_byte_owners_before_wire_decode() {
    let encoded = rmp_serde::to_vec(&resting_order()).unwrap();
    let row = rmpv::decode::read_value(&mut Cursor::new(encoded)).unwrap();
    for owner in [
        Value::Binary(vec![0xab; 21]),
        Value::Array(vec![Value::from(0xab); 21]),
        Value::Array(vec![Value::from(256); 20]),
        Value::Array(vec![Value::Boolean(true); 20]),
    ] {
        for width in [6, 14] {
            let mut malformed = row.clone();
            fields(&mut malformed).truncate(width);
            fields(&mut malformed)[2] = owner.clone();
            assert!(
                decode_open_orders(&bytes(&Value::Array(vec![malformed])), &[0xab; 20]).is_err()
            );
        }
    }
}

#[test]
fn open_orders_reject_duplicate_ids_empty_orders_and_trailing_bytes() {
    let duplicate = rmp_serde::to_vec(&vec![resting_order(), resting_order()]).unwrap();
    assert!(decode_open_orders(&duplicate, &[0xab; 20]).is_err());
    let mut empty = resting_order();
    empty.quantity = 0;
    assert!(decode_open_orders(&rmp_serde::to_vec(&vec![empty]).unwrap(), &[0xab; 20]).is_err());
    let mut trailing = rmp_serde::to_vec(&vec![resting_order()]).unwrap();
    trailing.push(0);
    assert!(decode_open_orders(&trailing, &[0xab; 20]).is_err());
    assert_eq!(
        decode_open_orders(&vec![0; MAX_OPEN_ORDERS_BYTES + 1], &[0xab; 20])
            .expect_err("a payload over the cap is refused"),
        "open orders payload is too large"
    );
}

/// One `MarketConfig` row as `rmp_serde::to_vec` writes it (no fee tiers).
const MARKET: &str = "dc001801cd03e8cd01f40502ce0036ee8064a4506572700000c200cd7530906401c000aa4f7261636c654f6e6c79000005a3425443cfffffffffffffffff";
/// `AccountInfo` with one position and every trailing field.
const ACCOUNT: &str = "9acf0020000000000001919edc0014ccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccab07a453656c6ccf0000000f8a9c2b8003fbd1fc18cd07d0cd0fa0d1fc18000c00cf0020000000000001d0d6cd07d0cd0fa0009192cd02bca24e6ffdcfffffffffffffffff05";

fn value(hex: &str) -> Value {
    rmpv::decode::read_value(&mut Cursor::new(hex::decode(hex).unwrap())).unwrap()
}

fn bytes(value: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    rmpv::encode::write_value(&mut out, value).unwrap();
    out
}

fn fields(value: &mut Value) -> &mut Vec<Value> {
    let Value::Array(fields) = value else {
        panic!("a record is an array")
    };
    fields
}

fn appended(value: &Value) -> Value {
    let mut longer = value.clone();
    fields(&mut longer).push(Value::from(99));
    longer
}

#[test]
fn a_market_list_with_appended_fields_decodes_as_the_pinned_rows() {
    let mut row = value(MARKET);
    fields(&mut row)[13] = Value::Array(vec![Value::Array(vec![
        Value::from(0),
        Value::from(-7),
        Value::from(5),
    ])]);
    let pinned = Value::Array(vec![row.clone()]);

    let mut later = appended(&row);
    let tier = appended(&fields(&mut row)[13].as_array().unwrap()[0]);
    fields(&mut later)[13] = Value::Array(vec![tier]);
    let later = Value::Array(vec![later]);

    let expected: Vec<MarketConfig> = rmp_serde::from_slice(&bytes(&pinned)).unwrap();
    let decoded: Vec<MarketConfig> = decode(&bytes(&later), &Shape::List(&MARKET_CONFIG)).unwrap();
    assert_eq!(
        rmp_serde::to_vec(&decoded).unwrap(),
        rmp_serde::to_vec(&expected).unwrap()
    );
    assert!(rmp_serde::from_slice::<Vec<MarketConfig>>(&bytes(&later)).is_err());
}

#[test]
fn an_account_with_appended_fields_decodes_as_the_pinned_record() {
    let pinned = value(ACCOUNT);
    let mut later = appended(&pinned);
    let account = fields(&mut later);
    let position = appended(&account[1].as_array().unwrap()[0]);
    account[1] = Value::Array(vec![position]);
    let scenario = appended(&account[6].as_array().unwrap()[0]);
    account[6] = Value::Array(vec![scenario]);

    let expected: AccountInfo = rmp_serde::from_slice(&bytes(&pinned)).unwrap();
    let decoded: AccountInfo = decode(&bytes(&later), &ACCOUNT_INFO).unwrap();
    assert_eq!(
        rmp_serde::to_vec(&decoded).unwrap(),
        rmp_serde::to_vec(&expected).unwrap()
    );
}

#[test]
fn an_absent_event_decodes_and_a_wrong_field_type_is_still_refused() {
    let none: Option<EventInfo> = decode(&[0xc0], &Shape::Optional(&EVENT_INFO)).unwrap();
    assert!(none.is_none());
    // A string where the wire has an integer, inside the pinned width.
    let mut row = value(MARKET);
    fields(&mut row)[0] = Value::from("1");
    assert!(decode::<MarketConfig>(&bytes(&row), &MARKET_CONFIG).is_err());
}

#[test]
fn order_status_decodes_an_order_or_nil() {
    let encoded = rmp_serde::to_vec(&resting_order()).unwrap();
    let decoded = decode_order_status(&encoded, 9_007_199_254_740_993)
        .unwrap()
        .expect("an order");
    assert_eq!(decoded.id, 9_007_199_254_740_993);
    assert_eq!(decoded.owner, [0xab; 20]);
    assert_eq!(decoded.filled_quantity, 3);
    assert!(decoded.post_only);
    assert!(decode_order_status(&bytes(&Value::Nil), 1)
        .unwrap()
        .is_none());
    assert_eq!(
        decode_order_status(&encoded, 42).expect_err("another order's answer is refused"),
        ORDER_STATUS_ID_MISMATCH
    );
}

#[test]
fn order_status_legacy_rows_use_wire_defaults() {
    let encoded = rmp_serde::to_vec(&resting_order()).unwrap();
    let mut row = rmpv::decode::read_value(&mut Cursor::new(encoded)).unwrap();
    fields(&mut row).truncate(6);
    let decoded = decode_order_status(&bytes(&row), 9_007_199_254_740_993)
        .unwrap()
        .expect("an order");
    assert_eq!(decoded.client_order_id, None);
    assert_eq!(decoded.created_at_ms, 0);
}

#[test]
fn order_status_rejects_malformed_owner_rows_floats_and_oversize() {
    let encoded = rmp_serde::to_vec(&resting_order()).unwrap();
    let row = rmpv::decode::read_value(&mut Cursor::new(encoded)).unwrap();
    for owner in [
        Value::Binary(vec![0xab; 21]),
        Value::Array(vec![Value::from(256); 20]),
    ] {
        let mut malformed = row.clone();
        fields(&mut malformed)[2] = owner;
        assert!(decode_order_status(&bytes(&malformed), 9_007_199_254_740_993).is_err());
    }
    let mut floated = row.clone();
    fields(&mut floated)[4] = Value::F64(1.5);
    assert!(decode_order_status(&bytes(&floated), 9_007_199_254_740_993).is_err());
    let mut short = row;
    fields(&mut short).truncate(3);
    assert!(decode_order_status(&bytes(&short), 9_007_199_254_740_993).is_err());
    assert!(decode_order_status(&bytes(&Value::Array(vec![])), 9_007_199_254_740_993).is_err());
    assert_eq!(
        decode_order_status(&vec![0; MAX_ORDER_STATUS_BYTES + 1], 1)
            .expect_err("a payload over the cap is refused"),
        "order status payload is too large"
    );
}

#[test]
fn a_market_listing_keeps_the_rows_it_decodes_and_reports_the_rest() {
    let good = value(MARKET);
    let mut unknown_kind = good.clone();
    fields(&mut unknown_kind)[0] = Value::from(7);
    fields(&mut unknown_kind)[7] = Value::from("Spot");
    let mut wrong_type = good.clone();
    fields(&mut wrong_type)[0] = Value::from(8);
    fields(&mut wrong_type)[1] = Value::from("3334");
    let longer = appended(&good);
    let listing = Value::Array(vec![good.clone(), unknown_kind, longer, wrong_type]);

    let decoded = decode_market_listing(&bytes(&listing)).unwrap();
    let expected: MarketConfig = rmp_serde::from_slice(&bytes(&good)).unwrap();
    assert_eq!(decoded.markets.len(), 2);
    for market in &decoded.markets {
        assert_eq!(
            rmp_serde::to_vec(market).unwrap(),
            rmp_serde::to_vec(&expected).unwrap()
        );
    }
    assert_eq!(decoded.row_field_counts, vec![24, 25]);
    let refused: Vec<(u32, u32, u32)> = decoded
        .refused_rows
        .iter()
        .map(|row| (row.index, row.market, row.field_count))
        .collect();
    assert_eq!(refused, vec![(1, 7, 24), (3, 8, 24)]);
    assert!(decoded.refused_rows[0].error.contains("Spot"));
}

#[test]
fn a_market_listing_row_that_names_no_market_or_a_named_one_is_refused_whole() {
    // Each listing pairs a good row (market 1) with a row the decoder refuses
    // that cannot be tied to one market of its own: reporting it would let a
    // caller lose a market without knowing which.
    let good = value(MARKET);
    let refused_with = |first: Value| {
        let mut row = good.clone();
        fields(&mut row)[0] = first;
        fields(&mut row)[7] = Value::from("Spot");
        row
    };
    let cases = [
        ("not an array", Value::from("not a row")),
        (
            "an object row",
            Value::Map(vec![(Value::from("market"), Value::from(9))]),
        ),
        ("market zero", refused_with(Value::from(0))),
        ("a string id", refused_with(Value::from("9"))),
        (
            "an id above u32",
            refused_with(Value::from(u64::from(u32::MAX) + 1)),
        ),
        ("a decoded market's id", refused_with(Value::from(1))),
    ];
    for (label, row) in cases {
        let listing = Value::Array(vec![good.clone(), row]);
        assert!(
            decode_market_listing(&bytes(&listing)).is_err(),
            "{label} must refuse the listing"
        );
    }
    let twice = Value::Array(vec![
        good.clone(),
        refused_with(Value::from(9)),
        refused_with(Value::from(9)),
    ]);
    let error = decode_market_listing(&bytes(&twice))
        .expect_err("two refused rows naming one market refuse the listing");
    assert_eq!(error.fault, ListingFault::DuplicateId { index: 2, id: 9 });
    let named = decode_market_listing(&bytes(&Value::Array(vec![good.clone(), Value::from("x")])))
        .expect_err("a non-array row refuses the listing");
    assert_eq!(named.fault, ListingFault::RowNotArray { index: 1 });
    assert_eq!(named.to_string(), "market listing row 1 is not an array");
    let float = decode_market_listing(&bytes(&Value::Array(vec![Value::F64(1.5)])))
        .expect_err("a float refuses the listing");
    assert_eq!(
        float.fault,
        ListingFault::Payload(crate::msgpack::MsgpackError::Float)
    );
}

#[test]
fn a_market_listing_that_is_not_a_list_is_refused_whole() {
    assert!(decode_market_listing(&bytes(&Value::from(5))).is_err());
    assert!(decode_market_listing(&[0xc1]).is_err());
    let mut trailing = bytes(&Value::Array(vec![value(MARKET)]));
    trailing.push(0xc0);
    assert!(decode_market_listing(&trailing).is_err());
    let empty = decode_market_listing(&bytes(&Value::Array(vec![]))).unwrap();
    assert!(empty.markets.is_empty() && empty.refused_rows.is_empty());
}

#[test]
fn a_market_listing_refuses_malformed_values_even_in_appended_fields() {
    // A float or a duplicate-key map past the pinned width would be cut away
    // by the row decode; the strict preflight refuses the listing first.
    let mut float_row = appended(&value(MARKET));
    fields(&mut float_row).push(Value::F64(1.5));
    assert!(decode_market_listing(&bytes(&Value::Array(vec![float_row]))).is_err());

    let mut tier_row = value(MARKET);
    let tier = vec![
        Value::from(0),
        Value::from(-7),
        Value::from(5),
        Value::F32(0.5),
    ];
    fields(&mut tier_row)[13] = Value::Array(vec![Value::Array(tier)]);
    assert!(decode_market_listing(&bytes(&Value::Array(vec![tier_row]))).is_err());

    let mut map_row = appended(&value(MARKET));
    fields(&mut map_row).push(Value::Map(vec![
        (Value::from("k"), Value::from(1)),
        (Value::from("k"), Value::from(2)),
    ]));
    assert!(decode_market_listing(&bytes(&Value::Array(vec![map_row]))).is_err());

    let mut deep = Value::from(0);
    for _ in 0..=crate::msgpack::MAX_DEPTH {
        deep = Value::Array(vec![deep]);
    }
    let mut deep_row = appended(&value(MARKET));
    fields(&mut deep_row).push(deep);
    assert!(decode_market_listing(&bytes(&Value::Array(vec![deep_row]))).is_err());
}

/// A DevNet `/v1/events` row (2026-11-12): event 4, a resolved one-book event
/// with a `MarketOracle` source and one attached conditional.
const EVENT: &str = "9a04cd0190d97657696c6c204254432062652061626f7665202438332c3433382e3738352028697473204f63746f6265722031322c20323032362c2031313a30302055544320707269636529206174207265736f6c7574696f6e206166746572204f63746f6265722031332c20323032362c2031313a3030205554433fcf000001a134eb5380ce0036ee8081a85265736f6c766564a24e6fcf000001a12fd93886cf000001a134eb579681ac4d61726b65744f7261636c659301cf000000136d56d1e8ab477265617465725468616e919303cd0192cd0193";

#[test]
fn an_events_listing_keeps_the_events_it_decodes_and_reports_the_rest() {
    let good = value(EVENT);
    let mut unknown_oracle = good.clone();
    fields(&mut unknown_oracle)[0] = Value::from(7);
    fields(&mut unknown_oracle)[8] = Value::Map(vec![(
        Value::from("FutureOracle"),
        Value::Array(vec![Value::from(1)]),
    )]);
    let mut unknown_status = good.clone();
    fields(&mut unknown_status)[0] = Value::from(8);
    fields(&mut unknown_status)[5] = Value::from("Paused");
    let listing = Value::Array(vec![
        unknown_oracle,
        good.clone(),
        appended(&good),
        unknown_status,
    ]);

    let decoded = decode_event_listing(&bytes(&listing)).unwrap();
    let expected: EventInfo = rmp_serde::from_slice(&bytes(&good)).unwrap();
    assert_eq!(decoded.events.len(), 2);
    for event in &decoded.events {
        assert_eq!(
            rmp_serde::to_vec(event).unwrap(),
            rmp_serde::to_vec(&expected).unwrap()
        );
    }
    let refused: Vec<(u32, u32, u32)> = decoded
        .refused_rows
        .iter()
        .map(|row| (row.index, row.event_id, row.field_count))
        .collect();
    assert_eq!(refused, vec![(0, 7, 10), (3, 8, 10)]);
    assert!(decoded.refused_rows[0].error.contains("FutureOracle"));
}

#[test]
fn an_events_listing_row_that_names_no_event_or_a_named_one_is_refused_whole() {
    let good = value(EVENT);
    let refused_with = |first: Value| {
        let mut row = good.clone();
        fields(&mut row)[0] = first;
        fields(&mut row)[5] = Value::from("Paused");
        row
    };
    for (label, row) in [
        ("not an array", Value::from(3)),
        ("event zero", refused_with(Value::from(0))),
        ("a string id", refused_with(Value::from("9"))),
        ("a decoded event's id", refused_with(Value::from(4))),
    ] {
        let listing = Value::Array(vec![good.clone(), row]);
        assert!(
            decode_event_listing(&bytes(&listing)).is_err(),
            "{label} must refuse the listing"
        );
    }
    let error = decode_event_listing(&bytes(&Value::Array(vec![good.clone(), Value::from(3)])))
        .unwrap_err();
    assert_eq!(error.to_string(), "events listing row 1 is not an array");
}

#[test]
fn an_events_listing_is_refused_whole_when_malformed_or_not_a_list() {
    assert!(decode_event_listing(&bytes(&Value::from(5))).is_err());
    let mut float_row = appended(&value(EVENT));
    fields(&mut float_row).push(Value::F64(1.5));
    assert!(decode_event_listing(&bytes(&Value::Array(vec![float_row]))).is_err());
    let empty = decode_event_listing(&bytes(&Value::Array(vec![]))).unwrap();
    assert!(empty.events.is_empty() && empty.refused_rows.is_empty());
}
