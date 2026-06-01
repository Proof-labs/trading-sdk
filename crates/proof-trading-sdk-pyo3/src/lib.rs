extern crate proof_trading_sdk as core_sdk;

use core_sdk::codec;
use core_sdk::crypto;
use core_sdk::types::ExecError;

use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict};

fn make_dict<'py>(py: Python<'py>, pairs: &[(&str, PyObject)]) -> Bound<'py, PyDict> {
    let dict = PyDict::new_bound(py);
    for (k, v) in pairs {
        dict.set_item(*k, v.clone_ref(py)).ok();
    }
    dict
}

fn map_err(e: ExecError) -> PyErr {
    PyValueError::new_err(format!("{e:?}"))
}

/// Sign an action and encode it as a wire-ready MessagePack envelope.
#[pyfunction]
fn sign_and_encode(
    py: Python<'_>,
    chain_id: &[u8],
    action_type: u8,
    action_payload: &[u8],
    seq: u64,
    secret_key: &[u8],
) -> PyResult<PyObject> {
    let chain_id_arr: [u8; 32] = chain_id
        .try_into()
        .map_err(|_| PyValueError::new_err("chain_id must be exactly 32 bytes"))?;
    let sk_bytes: [u8; 32] = secret_key
        .try_into()
        .map_err(|_| PyValueError::new_err("secret_key must be exactly 32 bytes"))?;
    let signing_key = ed25519_dalek::SigningKey::from_bytes(&sk_bytes);

    let encoded = codec::sign_and_encode_payload(&chain_id_arr, action_type, action_payload, seq, &signing_key)
        .map_err(map_err)?;

    Ok(PyBytes::new_bound(py, &encoded).into())
}

/// Encode a pre-signed action into a wire envelope.
#[pyfunction]
fn encode_signed_tx(
    py: Python<'_>,
    action_type: u8,
    action_payload: &[u8],
    seq: u64,
    pubkey: &[u8],
    signature: &[u8],
) -> PyResult<PyObject> {
    let pk: [u8; 32] = pubkey
        .try_into()
        .map_err(|_| PyValueError::new_err("pubkey must be exactly 32 bytes"))?;
    let sig: [u8; 64] = signature
        .try_into()
        .map_err(|_| PyValueError::new_err("signature must be exactly 64 bytes"))?;

    let encoded = codec::encode_signed_tx_raw(action_type, action_payload, seq, &pk, &sig)
        .map_err(map_err)?;

    Ok(PyBytes::new_bound(py, &encoded).into())
}

/// Decode a wire envelope into its components.
#[pyfunction]
fn decode_tx(py: Python<'_>, tx_bytes: &[u8]) -> PyResult<PyObject> {
    let decoded = codec::decode_tx_raw(tx_bytes).map_err(map_err)?;
    let payload = PyBytes::new_bound(py, &decoded.payload);
    let pk = PyBytes::new_bound(py, &decoded.pubkey);
    let sig = PyBytes::new_bound(py, &decoded.signature);

    let dict = make_dict(
        py,
        &[
            ("version", decoded.version.into_py(py)),
            ("action_type", decoded.action_type.into_py(py)),
            ("seq", decoded.seq.into_py(py)),
            ("payload", payload.into()),
            ("pubkey", pk.into()),
            ("signature", sig.into()),
        ],
    );
    Ok(dict.into())
}

/// Derive a 20-byte owner address from a 32-byte Ed25519 public key.
#[pyfunction]
fn pubkey_to_owner(py: Python<'_>, pubkey: &[u8]) -> PyResult<PyObject> {
    let pk: [u8; 32] = pubkey
        .try_into()
        .map_err(|_| PyValueError::new_err("pubkey must be exactly 32 bytes"))?;
    let owner = crypto::pubkey_to_owner(&pk);
    Ok(PyBytes::new_bound(py, &owner).into())
}

/// Verify an Ed25519 signature over the canonical signing message.
#[pyfunction]
fn verify_signature(
    chain_id: &[u8],
    pubkey: &[u8],
    signature: &[u8],
    action_type: u8,
    seq: u64,
    payload: &[u8],
) -> PyResult<bool> {
    let chain_id_arr: [u8; 32] = chain_id
        .try_into()
        .map_err(|_| PyValueError::new_err("chain_id must be exactly 32 bytes"))?;
    let pk: [u8; 32] = pubkey
        .try_into()
        .map_err(|_| PyValueError::new_err("pubkey must be exactly 32 bytes"))?;
    let sig: [u8; 64] = signature
        .try_into()
        .map_err(|_| PyValueError::new_err("signature must be exactly 64 bytes"))?;

    match crypto::verify_signature(&chain_id_arr, &pk, &sig, action_type, seq, payload) {
        Ok(()) => Ok(true),
        Err(_) => Ok(false),
    }
}

/// Hash a CometBFT chain_id string into 32 bytes (Keccak-256).
#[pyfunction]
fn chain_id_from_string(py: Python<'_>, chain_id: &str) -> PyResult<PyObject> {
    let result = crypto::chain_id_from_string(chain_id);
    Ok(PyBytes::new_bound(py, &result).into())
}

/// Generate a new Ed25519 keypair, optionally from a 32-byte seed.
#[pyfunction]
#[pyo3(signature = (seed=None))]
fn generate_keypair(py: Python<'_>, seed: Option<&[u8]>) -> PyResult<PyObject> {
    let signing_key: ed25519_dalek::SigningKey = match seed {
        Some(s) => {
            let arr: [u8; 32] = s
                .try_into()
                .map_err(|_| PyValueError::new_err("seed must be exactly 32 bytes"))?;
            ed25519_dalek::SigningKey::from_bytes(&arr)
        }
        None => {
            let mut rng = rand_core::OsRng;
            ed25519_dalek::SigningKey::generate(&mut rng)
        }
    };
    let vk = signing_key.verifying_key();
    let dict = make_dict(
        py,
        &[
            ("secret_key", PyBytes::new_bound(py, signing_key.as_bytes()).into()),
            ("public_key", PyBytes::new_bound(py, &vk.to_bytes()).into()),
        ],
    );
    Ok(dict.into())
}

/// Load a signing keypair from a file descriptor.
#[pyfunction]
fn load_key_from_fd(py: Python<'_>, fd: i32) -> PyResult<PyObject> {
    use std::io::Read;
    use std::os::fd::{FromRawFd, OwnedFd};

    let owned = unsafe { OwnedFd::from_raw_fd(fd) };
    let mut buf = [0u8; 32];
    let mut file = std::fs::File::from(owned);
    file.read_exact(&mut buf)
        .map_err(|e| PyValueError::new_err(format!("failed to read key from fd: {e}")))?;

    let signing_key = ed25519_dalek::SigningKey::from_bytes(&buf);
    zeroize::Zeroize::zeroize(&mut buf);

    let vk = signing_key.verifying_key();
    let dict = make_dict(
        py,
        &[
            ("secret_key", PyBytes::new_bound(py, signing_key.as_bytes()).into()),
            ("public_key", PyBytes::new_bound(py, &vk.to_bytes()).into()),
        ],
    );
    Ok(dict.into())
}

/// Native Python extension module for proof-trading-sdk (internal name: _native).
#[pymodule]
fn _native(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(sign_and_encode, m)?)?;
    m.add_function(wrap_pyfunction!(encode_signed_tx, m)?)?;
    m.add_function(wrap_pyfunction!(decode_tx, m)?)?;
    m.add_function(wrap_pyfunction!(pubkey_to_owner, m)?)?;
    m.add_function(wrap_pyfunction!(verify_signature, m)?)?;
    m.add_function(wrap_pyfunction!(chain_id_from_string, m)?)?;
    m.add_function(wrap_pyfunction!(generate_keypair, m)?)?;
    m.add_function(wrap_pyfunction!(load_key_from_fd, m)?)?;
    Ok(())
}
