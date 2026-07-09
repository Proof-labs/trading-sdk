//! WebAssembly bindings for the `proof-trading-sdk` Rust core.
//!
//! This is the JS/WASM spoke of the wheel-and-spokes SDK (the sibling of the
//! PyO3 crate). It exposes the value-bearing codec + signing path through the
//! authoritative Rust core so the TypeScript SDK produces bytes that are
//! **identical to the exchange engine by construction** — see
//! `docs/adr/0001-wasm-core-vs-parallel-types.md`.
//!
//! The `encode_payload` / `decode_payload` bridge uses `serde_wasm_bindgen`
//! exactly where the PyO3 crate uses `pythonize`: it hands the core's
//! `encode_payload_dyn` / `decode_payload_dyn` a serde (de)serializer over a
//! JS value, so there is no per-language field-order reimplementation.

extern crate proof_trading_sdk as core_sdk;

use core_sdk::codec;
use core_sdk::crypto;
use core_sdk::types::ExecError;
use wasm_bindgen::prelude::*;

/// Map a core `ExecError` to a JS exception without leaking key material.
fn to_js(e: ExecError) -> JsError {
    JsError::new(&format!("{e:?}"))
}

fn arr32(bytes: &[u8], what: &str) -> Result<[u8; 32], JsError> {
    bytes
        .try_into()
        .map_err(|_| JsError::new(&format!("{what} must be exactly 32 bytes")))
}

fn arr64(bytes: &[u8], what: &str) -> Result<[u8; 64], JsError> {
    bytes
        .try_into()
        .map_err(|_| JsError::new(&format!("{what} must be exactly 64 bytes")))
}

/// Encode a structured action payload (a JS object with the core's snake_case
/// field names) into authoritative MessagePack wire bytes, via the core's
/// `encode_payload_dyn`. The returned bytes match `rmp-serde` — and therefore
/// the exchange engine — byte-for-byte.
#[wasm_bindgen]
pub fn encode_payload(action_type: u8, fields: JsValue) -> Result<Vec<u8>, JsError> {
    let de = serde_wasm_bindgen::Deserializer::from(fields);
    codec::encode_payload_dyn(action_type, de).map_err(to_js)
}

/// Decode MessagePack payload bytes for `action_type` back into a JS object,
/// via the core's `decode_payload_dyn`. Inverse of [`encode_payload`].
#[wasm_bindgen]
pub fn decode_payload(action_type: u8, payload: &[u8]) -> Result<JsValue, JsError> {
    // Serialize 64-bit ints as JS BigInt so u64 fields past 2^53 (e.g. price /
    // quantity) survive without being rounded to the nearest f64. Smaller ints
    // (u32 market ids, bps) still come back as plain Numbers — matching the TS
    // `types.ts` field types (number vs bigint).
    let ser = serde_wasm_bindgen::Serializer::new().serialize_large_number_types_as_bigints(true);
    codec::decode_payload_dyn(action_type, payload, &ser).map_err(to_js)
}

/// Build the deterministic signing message
/// (`DOMAIN_PREFIX || chain_id || action_type || seq_be || payload`).
#[wasm_bindgen]
pub fn signing_message(
    chain_id: &[u8],
    action_type: u8,
    seq: u64,
    payload: &[u8],
) -> Result<Vec<u8>, JsError> {
    let cid = arr32(chain_id, "chain_id")?;
    Ok(crypto::signing_message(&cid, action_type, seq, payload))
}

/// Assemble a signed wire envelope from a pre-computed pubkey + signature.
#[wasm_bindgen]
pub fn encode_signed_tx(
    action_type: u8,
    payload: &[u8],
    seq: u64,
    pubkey: &[u8],
    signature: &[u8],
) -> Result<Vec<u8>, JsError> {
    let pk = arr32(pubkey, "pubkey")?;
    let sig = arr64(signature, "signature")?;
    codec::encode_signed_tx_raw(action_type, payload, seq, &pk, &sig).map_err(to_js)
}

/// Sign a pre-encoded payload with `secret_key` and assemble the signed wire
/// envelope — the whole value-bearing path in the authoritative core. The key
/// is used to build a deterministic Ed25519 signature and is not retained.
#[wasm_bindgen]
pub fn sign_and_encode(
    chain_id: &[u8],
    action_type: u8,
    payload: &[u8],
    seq: u64,
    secret_key: &[u8],
) -> Result<Vec<u8>, JsError> {
    let cid = arr32(chain_id, "chain_id")?;
    let sk = arr32(secret_key, "secret_key")?;
    let signing_key = ed25519_dalek::SigningKey::from_bytes(&sk);
    codec::sign_and_encode_payload(&cid, action_type, payload, seq, &signing_key).map_err(to_js)
}

/// Derive the 20-byte owner address from a 32-byte Ed25519 public key.
#[wasm_bindgen]
pub fn pubkey_to_owner(pubkey: &[u8]) -> Result<Vec<u8>, JsError> {
    let pk = arr32(pubkey, "pubkey")?;
    Ok(crypto::pubkey_to_owner(&pk).to_vec())
}

/// Hash a CometBFT chain-id string into the 32-byte signing binding.
#[wasm_bindgen]
pub fn chain_id_from_string(chain_id: &str) -> Vec<u8> {
    crypto::chain_id_from_string(chain_id).to_vec()
}
