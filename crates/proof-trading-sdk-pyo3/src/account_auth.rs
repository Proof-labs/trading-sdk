//! The gateway's account-stream authentication, separate from transaction signing.

use ed25519_dalek::{Signature, VerifyingKey};
use pyo3::exceptions::PyValueError;
use pyo3::PyResult;

pub(super) fn sign(
    signer: &dyn core_sdk::Signer,
    chain_id: &[u8],
    timestamp_ms: u64,
) -> PyResult<[u8; 64]> {
    if chain_id.len() != 32 {
        return Err(PyValueError::new_err("chain_id must be exactly 32 bytes"));
    }
    let public_key = signer.public_key();
    let owner = core_sdk::crypto::pubkey_to_owner(&public_key);
    let mut message = b"ProofExchange-account-events-v1".to_vec();
    message.extend_from_slice(chain_id);
    for byte in owner {
        message.extend_from_slice(format!("{byte:02x}").as_bytes());
    }
    // Reconnect recovery uses history reads, not the gateway's legacy cursor.
    message.extend_from_slice(&0i64.to_be_bytes());
    message.extend_from_slice(&timestamp_ms.to_be_bytes());
    let signature = signer.try_sign(&message).map_err(super::map_signer_err)?;
    let key = VerifyingKey::from_bytes(&public_key)
        .map_err(|_| PyValueError::new_err("invalid account-auth public key"))?;
    key.verify_strict(&message, &Signature::from_bytes(&signature))
        .map_err(|_| PyValueError::new_err("invalid account-auth signature"))?;
    Ok(signature)
}
