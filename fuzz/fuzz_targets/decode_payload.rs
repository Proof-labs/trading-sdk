#![no_main]
//! Fuzz the per-action payload decoder against arbitrary (action_type, payload)
//! pairs.
//!
//! `decode_payload_dyn` selects a typed struct by `action_type` and decodes the
//! MessagePack `payload` into it — the path every binding hits with attacker-
//! controlled bytes. The first input byte is the action type; the rest is the
//! payload. Must never panic for any byte string.

use libfuzzer_sys::fuzz_target;
use proof_trading_sdk::codec;

fuzz_target!(|data: &[u8]| {
    if let Some((&action_type, payload)) = data.split_first() {
        // serde_json's Serializer is a convenient no-side-effect sink.
        let _ = codec::decode_payload_dyn(action_type, payload, serde_json::value::Serializer);
    }
});
