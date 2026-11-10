use super::*;
use rmpv::Value;

fn encoded(v: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    rmpv::encode::write_value(&mut out, v).unwrap();
    out
}
fn authorities(address: Value) -> Value {
    Value::Array(vec![Value::Array(vec![address]); 6])
}
#[test]
fn addresses_are_exact_with_both_wire_encodings() {
    for address in [
        Value::Binary(vec![171; 20]),
        Value::Array(vec![Value::from(171); 20]),
    ] {
        let decoded = decode_authorities(&encoded(&authorities(address))).unwrap();
        assert_eq!(decoded.relayer[0].0, [171; 20]);
        assert_eq!(decoded.scheduled_ops[0].0, [171; 20]);
    }
    for address in [
        Value::Binary(vec![171; 21]),
        Value::Binary(vec![171; 19]),
        Value::Array(vec![Value::from(171); 21]),
        Value::Array(vec![Value::from(true); 20]),
        Value::Array(vec![Value::from(256); 20]),
    ] {
        assert!(decode_authorities(&encoded(&authorities(address))).is_err());
    }
}
#[test]
fn authority_shapes_and_bounds_are_enforced() {
    assert!(decode_authorities(&encoded(&Value::Array(vec![]))).is_err());
    let list = Value::Array(vec![Value::Binary(vec![0; 20]); 4096]);
    assert!(decode_authorities(&encoded(&Value::Array(vec![list; 6]))).is_ok());
    let list = Value::Array(vec![Value::Binary(vec![0; 20]); 4097]);
    assert!(decode_authorities(&encoded(&Value::Array(vec![list; 6]))).is_err());
    assert!(decode_authorities(&vec![0; MAX_GOVERNANCE_READ_BYTES + 1]).is_err());
    let mut bytes = encoded(&Value::Array(vec![Value::Array(vec![]); 6]));
    bytes.push(0);
    assert!(decode_authorities(&bytes).is_err());
}
#[test]
fn liquidation_uses_wire_default_and_exact_ranges_shapes() {
    let mut config = vec![
        Value::from(u32::MAX),
        Value::Array(vec![0.into(), 0.into()]),
        0.into(),
        0.into(),
        0.into(),
    ];
    let pair = |c| Value::Array(vec![Value::from(u64::MAX), Value::Array(c)]);
    let (sequence, value) = decode_liquidation_config(&encoded(&pair(config.clone()))).unwrap();
    assert_eq!(sequence.0, u64::MAX);
    assert_eq!(value.takeover_discount_bps.0, 50);
    config.push(75.into());
    assert_eq!(
        decode_liquidation_config(&encoded(&pair(config.clone())))
            .unwrap()
            .1
            .takeover_discount_bps
            .0,
        75
    );
    config.push(0.into());
    assert!(decode_liquidation_config(&encoded(&pair(config.clone()))).is_err());
    config.pop();
    config[0] = Value::from(u64::from(u32::MAX) + 1);
    assert!(decode_liquidation_config(&encoded(&pair(config))).is_err());
    assert!(decode_liquidation_config(&[0x92, 0xcb, 0, 0, 0, 0, 0, 0, 0, 0, 0x90]).is_err());
}

#[test]
fn engine_array_address_sets_obey_entry_and_total_byte_limits() {
    let address = Value::Array(vec![Value::from(171); 20]);
    let mut sets = vec![Value::Array(vec![]); 6];
    sets[0] = Value::Array(vec![address.clone(); MAX_AUTHORITY_SET_ENTRIES]);
    let decoded = decode_authorities(&encoded(&Value::Array(sets.clone()))).unwrap();
    assert_eq!(decoded.relayer.len(), MAX_AUTHORITY_SET_ENTRIES);
    assert_eq!(decoded.relayer.last().unwrap().0, [171; 20]);

    sets[0] = Value::Array(vec![address.clone(); MAX_AUTHORITY_SET_ENTRIES + 1]);
    assert!(decode_authorities(&encoded(&Value::Array(sets))).is_err());

    let full = Value::Array(vec![
        Value::Array(vec![address; MAX_AUTHORITY_SET_ENTRIES]);
        6
    ]);
    let bytes = encoded(&full);
    assert!(bytes.len() > MAX_GOVERNANCE_READ_BYTES);
    assert!(decode_authorities(&bytes).is_err());
}
