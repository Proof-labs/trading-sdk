//! Canonical messages for external signers; signatures are checked before use.
use ed25519_dalek::{Signature, VerifyingKey};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::PyBytes;

#[pyfunction]
pub(super) fn signing_message<'py>(
    py: Python<'py>,
    chain_id: &[u8],
    action_type: u8,
    seq: u64,
    payload: &[u8],
) -> PyResult<Bound<'py, PyBytes>> {
    let chain: &[u8; 32] = chain_id
        .try_into()
        .map_err(|_| PyValueError::new_err("chain_id must be exactly 32 bytes"))?;
    Ok(PyBytes::new(
        py,
        &core_sdk::crypto::signing_message(chain, action_type, seq, payload),
    ))
}

#[pyfunction]
#[pyo3(signature = (chain_id, public_key, timestamp_ms, after_id=0))]
pub(super) fn account_ws_auth_message<'py>(
    py: Python<'py>,
    chain_id: &[u8],
    public_key: &[u8],
    timestamp_ms: u64,
    after_id: i64,
) -> PyResult<Bound<'py, PyBytes>> {
    let key: &[u8; 32] = public_key
        .try_into()
        .map_err(|_| PyValueError::new_err("public_key must be exactly 32 bytes"))?;
    Ok(PyBytes::new(
        py,
        &super::account_auth::message(chain_id, key, timestamp_ms, after_id)?,
    ))
}

#[pyfunction]
pub(super) fn verify_raw_signature(public_key: &[u8], signature: &[u8], message: &[u8]) -> bool {
    let Ok(key_bytes) = <&[u8; 32]>::try_from(public_key) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(key_bytes) else {
        return false;
    };
    let Ok(signature) = Signature::from_slice(signature) else {
        return false;
    };
    key.verify_strict(message, &signature).is_ok()
}
