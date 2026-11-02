#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::arithmetic_side_effects
)]

use serde::de::{self, Deserializer, Visitor};

use super::*;
use crate::query::{AccountInfo, BindingScenario, PositionBrief};
use crate::types::{AttachedConditional, EventInfo, FeeTier, MarketConfig};

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
    assert_shape::<MarketConfig>(&MARKET_CONFIG, &["fee_tiers"]);
    assert_shape::<FeeTier>(inner(&MARKET_CONFIG, 0), &[]);
    assert_shape::<EventInfo>(&EVENT_INFO, &["attached_conditionals"]);
    assert_shape::<AttachedConditional>(inner(&EVENT_INFO, 0), &[]);
    assert_shape::<AccountInfo>(&ACCOUNT_INFO, &["positions", "binding_scenario"]);
    assert_shape::<PositionBrief>(inner(&ACCOUNT_INFO, 0), &[]);
    assert_shape::<BindingScenario>(inner(&ACCOUNT_INFO, 1), &[]);
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
