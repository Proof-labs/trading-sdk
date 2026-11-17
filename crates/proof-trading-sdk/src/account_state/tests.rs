use super::*;
use rmpv::Value;

fn position() -> Vec<Value> {
    vec![
        Value::Binary(vec![0xab; 20]),
        Value::from(0),
        Value::from("Buy"),
        Value::from(u64::MAX),
        Value::from(3),
        Value::from(i64::MIN),
    ]
}
fn raw(row: Vec<Value>) -> Vec<Value> {
    vec![
        Value::Binary(vec![0xab; 20]),
        Value::from(9007199254740993_u64),
        Value::from(u64::MAX),
        Value::Array(vec![Value::Array(row)]),
    ]
}
fn encode(fields: Vec<Value>) -> Vec<u8> {
    let mut bytes = Vec::new();
    rmpv::encode::write_value(&mut bytes, &Value::Array(fields)).unwrap();
    bytes
}

#[test]
fn wire_legacy_and_current_positions_preserve_exact_integers() {
    let mut state = decode(&encode(raw(position())), &[0xab; 20]).unwrap();
    assert_eq!(state.balance, u64::MAX);
    assert_eq!(state.finalized_height.0, 9007199254740993);
    assert_eq!(state.positions[0].last_funding_index, i64::MIN);
    assert_eq!(state.positions[0].entry_remainder, 0);
    state.positions[0].entry_remainder = 2;
    let encoded = rmp_serde::to_vec(&state).unwrap();
    let current = decode(&encoded, &[0xab; 20]).unwrap();
    assert_eq!(current.positions[0].entry_remainder, 2);
}

#[test]
fn appended_engine_fields_decode() {
    let mut row = position();
    row.push(Value::from(1));
    row.push(Value::from(2));
    let mut fields = raw(row);
    fields.push(Value::Nil);
    let state = decode(&encode(fields), &[0xab; 20]).unwrap();
    assert_eq!(state.balance, u64::MAX);
    assert_eq!(state.positions[0].size, 3);
    assert_eq!(state.positions[0].entry_remainder, 1);
}

#[test]
fn refuses_owner_mismatch_and_invalid_positions() {
    assert!(decode(&encode(raw(position())), &[0xcd; 20]).is_err());
    let mut row = position();
    row[0] = Value::Binary(vec![0xcd; 20]);
    assert!(decode(&encode(raw(row)), &[0xab; 20]).is_err());
    let mut row = position();
    row.push(Value::from(3));
    assert!(decode(&encode(raw(row)), &[0xab; 20]).is_err());
    let mut fields = raw(position());
    fields[3] = Value::Array(vec![Value::Array(position()); 2]);
    assert!(decode(&encode(fields), &[0xab; 20]).is_err());
}

#[test]
fn bounds_payload_positions_and_runs_strict_preflight() {
    let mut fields = raw(position());
    fields[3] = Value::Array(vec![Value::Array(position()); MAX_ACCOUNT_POSITIONS + 1]);
    assert!(decode(&encode(fields), &[0xab; 20]).is_err());
    assert!(decode(&vec![0; MAX_ACCOUNT_STATE_BYTES + 1], &[0xab; 20]).is_err());
    let mut bytes = encode(raw(position()));
    bytes.push(0);
    assert!(decode(&bytes, &[0xab; 20]).is_err());
    let mut row = position();
    row[3] = Value::F64(1.0);
    assert!(decode(&encode(raw(row)), &[0xab; 20]).is_err());
}

#[test]
fn oversized_owner_arrays_cannot_shift_following_fields() {
    let fields = vec![
        Value::Array(vec![Value::from(0xab); 21]),
        Value::from(100),
        Value::Array(vec![]),
        Value::Array(vec![]),
    ];
    assert!(decode(&encode(fields), &[0xab; 20]).is_err());
    let mut row = position();
    row[0] = Value::Array(vec![Value::from(0xab); 21]);
    assert!(decode(&encode(raw(row)), &[0xab; 20]).is_err());
}

#[test]
fn oversized_owner_bins_are_not_silently_truncated() {
    let mut fields = raw(position());
    fields[0] = Value::Binary(vec![0xab; 21]);
    assert!(decode(&encode(fields), &[0xab; 20]).is_err());
    let mut row = position();
    row[0] = Value::Binary(vec![0xab; 21]);
    assert!(decode(&encode(raw(row)), &[0xab; 20]).is_err());
}
