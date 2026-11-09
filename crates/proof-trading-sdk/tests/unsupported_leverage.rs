use proof_trading_sdk::{codec, types::ExecError};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../conformance/historical-codec.ndjson")).unwrap()
}

fn assert_unsupported<T: std::fmt::Debug>(result: Result<T, ExecError>) {
    assert!(format!("{:?}", result.unwrap_err())
        .contains("SetUserMarketLeverage (0x16) is not supported"));
}

#[test]
fn leverage_creation_refuses_typed_dynamic_and_raw_entrypoints() {
    let vector = fixture();
    let payload = hex::decode(vector["expect"]["payload_hex"].as_str().unwrap()).unwrap();
    let envelope = hex::decode(vector["expect"]["envelope_hex"].as_str().unwrap()).unwrap();
    let action = codec::decode_tx(&envelope).unwrap().action;
    let key = ed25519_dalek::SigningKey::from_bytes(&[0x42; 32]);
    assert_unsupported(codec::encode_payload_dyn(0x16, &vector["input"]));
    // Refuse by action type even when the payload is malformed.
    assert_unsupported(codec::encode_payload_dyn(0x16, &Value::Null));
    assert_unsupported(codec::encode_signed_tx(&action, 1, &[0; 32], &[0; 64]));
    assert_unsupported(codec::sign_and_encode_with_chain(
        &[0; 32], &action, 1, &key,
    ));
    assert_unsupported(codec::sign_and_encode_payload(
        &[0; 32], 0x16, &payload, 1, &key,
    ));
    assert_unsupported(codec::encode_signed_tx_raw(
        0x16, &payload, 1, &[0; 32], &[0; 64],
    ));
    assert!(!codec::get_action_types()
        .iter()
        .any(|(_, byte)| *byte == 0x16));
}

#[test]
fn frozen_leverage_payload_and_envelope_still_decode() {
    let vector = fixture();
    let payload = hex::decode(vector["expect"]["payload_hex"].as_str().unwrap()).unwrap();
    let fields = codec::decode_payload_dyn(0x16, &payload, serde_json::value::Serializer).unwrap();
    assert_eq!(fields, vector["input"]);
    let envelope = hex::decode(vector["expect"]["envelope_hex"].as_str().unwrap()).unwrap();
    let raw = codec::decode_tx_raw(&envelope).unwrap();
    assert_eq!(raw.action_type, 0x16);
    assert_eq!(raw.payload, payload);
    assert!(matches!(
        codec::decode_tx(&envelope).unwrap().action,
        codec::Action::SetUserMarketLeverage(_)
    ));
}

#[test]
fn supported_signing_is_byte_identical_to_wire() {
    let fields = serde_json::json!({"order_id":42,"owner":vec![1;20]});
    let payload = codec::encode_payload_dyn(2, &fields).unwrap();
    let key = ed25519_dalek::SigningKey::from_bytes(&[0x42; 32]);
    let actual = codec::sign_and_encode_payload(&[0; 32], 2, &payload, 1, &key).unwrap();
    let expected =
        proof_wire::codec::sign_and_encode_payload(&[0; 32], 2, &payload, 1, &key).unwrap();
    assert_eq!(actual, expected);
}
