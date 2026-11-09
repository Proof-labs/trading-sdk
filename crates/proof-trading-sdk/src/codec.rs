//! SDK action creation policy over the authoritative proof-wire codec.
//!
//! Decode/verify APIs and wire types remain available for stored history.
//! Wire types retain their original serialization methods; use the functions
//! below for SDK-supported payload/envelope creation and signing.

pub use proof_wire::codec::*;
use proof_wire::types::ExecError;

/// Reject actions that this SDK does not support creating or signing.
pub fn ensure_supported_action(action_type: u8) -> Result<(), ExecError> {
    if action_type == 0x16 {
        return Err(ExecError::DecodeError(
            "SetUserMarketLeverage (0x16) is not supported by this SDK".into(),
        ));
    }
    Ok(())
}

fn ensure_supported_typed_action(action: &Action) -> Result<(), ExecError> {
    if matches!(action, Action::SetUserMarketLeverage(_)) {
        ensure_supported_action(0x16)?;
    }
    Ok(())
}

/// Supported action names and their authoritative wire discriminants.
pub fn get_action_types() -> Vec<(&'static str, u8)> {
    proof_wire::codec::get_action_types()
        .into_iter()
        .filter(|(_, byte)| *byte != 0x16)
        .collect()
}

/// Encode fields through proof-wire after checking SDK action support.
pub fn encode_payload_dyn<'de, D: serde::Deserializer<'de>>(
    action_type: u8,
    de: D,
) -> Result<Vec<u8>, ExecError> {
    ensure_supported_action(action_type)?;
    proof_wire::codec::encode_payload_dyn(action_type, de)
}

/// Encode a supported action with a precomputed signature.
pub fn encode_signed_tx(
    action: &Action,
    seq: u64,
    pubkey: &[u8; 32],
    signature: &[u8; 64],
) -> Result<Vec<u8>, ExecError> {
    ensure_supported_typed_action(action)?;
    proof_wire::codec::encode_signed_tx(action, seq, pubkey, signature)
}

/// Sign and encode a supported typed action with its chain binding.
pub fn sign_and_encode_with_chain(
    chain_id: &[u8; 32],
    action: &Action,
    seq: u64,
    signing_key: &ed25519_dalek::SigningKey,
) -> Result<Vec<u8>, ExecError> {
    ensure_supported_typed_action(action)?;
    proof_wire::codec::sign_and_encode_with_chain(chain_id, action, seq, signing_key)
}

/// Sign an already-encoded payload after checking SDK action support.
pub fn sign_and_encode_payload(
    chain_id: &[u8; 32],
    action_type: u8,
    payload: &[u8],
    seq: u64,
    signing_key: &ed25519_dalek::SigningKey,
) -> Result<Vec<u8>, ExecError> {
    ensure_supported_action(action_type)?;
    proof_wire::codec::sign_and_encode_payload(chain_id, action_type, payload, seq, signing_key)
}

/// Assemble a signed envelope after checking SDK action support.
pub fn encode_signed_tx_raw(
    action_type: u8,
    payload: &[u8],
    seq: u64,
    pubkey: &[u8; 32],
    signature: &[u8; 64],
) -> Result<Vec<u8>, ExecError> {
    ensure_supported_action(action_type)?;
    proof_wire::codec::encode_signed_tx_raw(action_type, payload, seq, pubkey, signature)
}
