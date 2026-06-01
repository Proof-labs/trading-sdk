extern crate proof_trading_sdk as core_sdk;

use core_sdk::codec;
use core_sdk::crypto;
use core_sdk::types::ExecError;

use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict, PyList};

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

/// Encode a structured action payload into wire MessagePack bytes via the
/// shared Rust codec.
///
/// `fields` is a native Python object (a dict keyed by the action's
/// snake_case field names, or any object `pythonize` can deserialize). It is
/// deserialized into the typed payload struct selected by `action_type`, then
/// encoded by the *same* `rmp-serde` path the engine uses — so field order,
/// enum-as-string, byte-array, and integer-width encoding are authoritative
/// and identical across every binding. Byte fields accept Python `bytes`
/// directly (the `wire` newtypes handle both `bytes` and seq-of-u8).
///
/// The returned bytes are the `action_payload` argument for
/// [`sign_and_encode`].
#[pyfunction]
fn encode_action(
    py: Python<'_>,
    action_type: u8,
    fields: &Bound<'_, PyAny>,
) -> PyResult<PyObject> {
    let mut de = pythonize::Depythonizer::from_object(fields);
    let payload = codec::encode_payload_dyn(action_type, &mut de).map_err(map_err)?;
    Ok(PyBytes::new_bound(py, &payload).into())
}

/// Decode raw MessagePack action-payload bytes into a native Python object
/// (a dict keyed by the action's field names), the inverse of
/// [`encode_action`]. The payload is parsed into the typed struct for
/// `action_type` and re-serialized through `pythonize`.
#[pyfunction]
fn decode_action(py: Python<'_>, action_type: u8, payload: &[u8]) -> PyResult<PyObject> {
    let pythonizer = pythonize::Pythonizer::new(py);
    let obj = codec::decode_payload_dyn(action_type, payload, pythonizer).map_err(map_err)?;
    Ok(obj.into())
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

/// Return all action-type name → code mappings from the Rust core.
/// Generated from the codec so bindings never drift.
#[pyfunction]
fn get_action_types(py: Python<'_>) -> PyObject {
    let entries = codec::get_action_types();
    let list = PyList::empty_bound(py);
    for (name, code) in entries {
        let d = make_dict(py, &[("name", name.into_py(py)), ("code", code.into_py(py))]);
        list.append(d).ok();
    }
    list.into()
}

/// Return the error-code manifest — a list of {code, name, meaning} dicts.
/// One entry per ErrorKind variant. Generated from the Rust core so bindings
/// never drift.
#[pyfunction]
fn get_error_code_table(py: Python<'_>) -> PyObject {
    let entries = core_sdk::types::error_code_manifest();
    let list = PyList::empty_bound(py);
    for kind in entries {
        let d = make_dict(
            py,
            &[
                ("code", kind.code().into_py(py)),
                ("name", kind.name().into_py(py)),
                ("meaning", kind.meaning().into_py(py)),
            ],
        );
        list.append(d).ok();
    }
    list.into()
}

/// Native Python extension module for proof-trading-sdk (internal name: _native).
#[pymodule]
fn _native(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(sign_and_encode, m)?)?;
    m.add_function(wrap_pyfunction!(encode_signed_tx, m)?)?;
    m.add_function(wrap_pyfunction!(encode_action, m)?)?;
    m.add_function(wrap_pyfunction!(decode_action, m)?)?;
    m.add_function(wrap_pyfunction!(decode_tx, m)?)?;
    m.add_function(wrap_pyfunction!(pubkey_to_owner, m)?)?;
    m.add_function(wrap_pyfunction!(verify_signature, m)?)?;
    m.add_function(wrap_pyfunction!(chain_id_from_string, m)?)?;
    m.add_function(wrap_pyfunction!(generate_keypair, m)?)?;
    m.add_function(wrap_pyfunction!(load_key_from_fd, m)?)?;
    m.add_function(wrap_pyfunction!(get_action_types, m)?)?;
    m.add_function(wrap_pyfunction!(get_error_code_table, m)?)?;
    Ok(())
}
