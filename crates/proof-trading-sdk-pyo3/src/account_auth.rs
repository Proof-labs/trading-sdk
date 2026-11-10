//! The gateway's account-stream authentication, separate from transaction signing.

use ed25519_dalek::{Signature, VerifyingKey};
use pyo3::exceptions::PyValueError;
use pyo3::PyResult;

pub(super) fn sign(
    signer: &dyn core_sdk::Signer,
    chain_id: &[u8],
    timestamp_ms: u64,
    after_id: i64,
) -> PyResult<[u8; 64]> {
    let public_key = signer.public_key();
    let message = message(chain_id, &public_key, timestamp_ms, after_id)?;
    let signature = signer.try_sign(&message).map_err(super::map_signer_err)?;
    let key = VerifyingKey::from_bytes(&public_key)
        .map_err(|_| PyValueError::new_err("invalid account-auth public key"))?;
    key.verify_strict(&message, &Signature::from_bytes(&signature))
        .map_err(|_| PyValueError::new_err("invalid account-auth signature"))?;
    Ok(signature)
}

pub(super) fn message(
    chain_id: &[u8],
    public_key: &[u8; 32],
    timestamp_ms: u64,
    after_id: i64,
) -> PyResult<Vec<u8>> {
    if chain_id.len() != 32 {
        return Err(PyValueError::new_err("chain_id must be exactly 32 bytes"));
    }
    // Match the TypeScript accountAuth JSON-safe cursor domain.
    if !(0..=9_007_199_254_740_991).contains(&after_id) {
        return Err(PyValueError::new_err("invalid account auth cursor"));
    }
    let owner = core_sdk::crypto::pubkey_to_owner(public_key);
    let mut message = b"ProofExchange-account-events-v1".to_vec();
    message.extend_from_slice(chain_id);
    for byte in owner {
        message.extend_from_slice(format!("{byte:02x}").as_bytes());
    }
    message.extend_from_slice(&after_id.to_be_bytes());
    message.extend_from_slice(&timestamp_ms.to_be_bytes());
    Ok(message)
}
