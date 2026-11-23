#![allow(clippy::expect_used)]

use proof_trading_sdk::query::decode_account_view;
use serde_json::{json, Value};

fn fixture() -> Vec<u8> {
    hex::decode(include_str!("../../../conformance/account-v2.hex").trim())
        .expect("engine account v2 fixture must be valid hex")
}

fn value() -> Value {
    rmp_serde::from_slice(&fixture()).expect("engine fixture must be a map")
}

fn decode(value: &Value) -> Result<proof_trading_sdk::query::AccountView, String> {
    decode_account_view(&rmp_serde::to_vec_named(value).expect("test map must encode"))
}

#[test]
fn engine_vector_preserves_exact_valuation_fields() {
    let view = decode_account_view(&fixture()).expect("engine v2 vector must decode");
    assert_eq!(view.cashout_equity, 1_000_090);
    let position = &view.positions[0];
    assert_eq!(position.settle_price, Some(55));
    assert_eq!(position.book_restricted, Some(true));
    assert_eq!(position.upnl_now, Some(150));
}

#[test]
fn older_maps_unknown_fields_and_nullable_values_remain_distinct() {
    let mut raw = value();
    let p = raw["positions"][0]
        .as_object_mut()
        .expect("position must be a map");
    p.remove("settle_price");
    p.remove("book_restricted");
    p.insert("future_field".into(), json!(123));
    p.insert("upnl_now".into(), Value::Null);
    raw["margin_ratio_bps"] = Value::Null;
    let view = decode(&raw).expect("older map must decode");
    assert_eq!(view.positions[0].settle_price, None);
    assert_eq!(view.positions[0].book_restricted, None);
    assert_eq!(view.positions[0].upnl_now, None);
    assert_eq!(view.margin_ratio_bps, None);
    raw["positions"][0]["settle_price"] = json!(0);
    raw["positions"][0]["book_restricted"] = json!(false);
    let view = decode(&raw).expect("zero and false must decode");
    assert_eq!(view.positions[0].settle_price, Some(0));
    assert_eq!(view.positions[0].book_restricted, Some(false));
    raw["positions"][0]["settle_price"] = json!(u64::MAX);
    raw["positions"][0]["pnl_if_dies"] = json!(i64::MIN);
    let view = decode(&raw).expect("full width integers must decode");
    assert_eq!(view.positions[0].settle_price, Some(u64::MAX));
    assert_eq!(view.positions[0].pnl_if_dies, i64::MIN);
    raw["positions"] = json!([]);
    assert!(decode(&raw)
        .expect("empty account must decode")
        .positions
        .is_empty());
}

#[test]
fn malformed_fields_and_v1_arrays_are_never_silently_accepted() {
    for (field, bad) in [
        ("settle_price", json!(-1)),
        ("settle_price", json!("55")),
        ("settle_price", json!(1.5)),
        ("book_restricted", json!(0)),
    ] {
        let mut raw = value();
        raw["positions"][0][field] = bad;
        assert!(decode(&raw).is_err(), "malformed {field} must fail");
    }
    let view = decode_account_view(&fixture()).expect("fixture must decode");
    let positional = rmp_serde::to_vec(&view).expect("positional account must encode");
    assert!(decode_account_view(&positional).is_err());
    let mut trailing = fixture();
    trailing.push(0xc0);
    assert!(decode_account_view(&trailing).is_err());
    assert!(decode_account_view(&[]).is_err());
}
