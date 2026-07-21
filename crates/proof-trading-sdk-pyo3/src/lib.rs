extern crate proof_trading_sdk as core_sdk;

use core_sdk::codec;
use core_sdk::crypto;
use core_sdk::types::ExecError;

use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict, PyList};

#[cfg(feature = "pkcs11")]
mod pkcs11;

fn map_err(e: ExecError) -> PyErr {
    PyValueError::new_err(format!("{e:?}"))
}

/// Map a signing-backend failure to a Python exception, without leaking any
/// key material into the message.
fn map_signer_err(e: core_sdk::SignerError) -> PyErr {
    PyValueError::new_err(e.to_string())
}

/// Opaque signing handle returned to Python. Exposes the public key, derived
/// owner, and a sign-and-encode operation — but **never** the secret bytes.
///
/// Holds a boxed [`core_sdk::Signer`] so every custody backend shares one type:
/// a [`core_sdk::LocalSigner`] (key in Rust memory, zeroized on drop) or an
/// HSM-backed signer (key stays on the device). Either way the secret never
/// crosses into Python's heap — the point of the FD/HSM design.
#[pyclass(name = "SigningHandle", module = "proof_trading_sdk._native", frozen)]
struct SigningHandle {
    signer: Box<dyn core_sdk::Signer>,
}

#[pymethods]
impl SigningHandle {
    /// The 32-byte Ed25519 public key (safe to expose).
    #[getter]
    fn public_key<'py>(&self, py: Python<'py>) -> Bound<'py, PyBytes> {
        PyBytes::new(py, &self.signer.public_key())
    }

    /// The 20-byte owner address derived from the public key.
    #[getter]
    fn owner<'py>(&self, py: Python<'py>) -> Bound<'py, PyBytes> {
        let owner = crypto::pubkey_to_owner(&self.signer.public_key());
        PyBytes::new(py, &owner)
    }

    /// Sign an action payload and encode it as a wire-ready envelope.
    ///
    /// The signature is produced inside the signer (Rust for a local key, the
    /// device for an HSM); the key never reaches Python. Equivalent in output
    /// to the free `sign_and_encode`, but with no secret-key argument.
    fn sign_and_encode<'py>(
        &self,
        py: Python<'py>,
        chain_id: &[u8],
        action_type: u8,
        action_payload: &[u8],
        seq: u64,
    ) -> PyResult<Bound<'py, PyBytes>> {
        let chain_id_arr: [u8; 32] = chain_id
            .try_into()
            .map_err(|_| PyValueError::new_err("chain_id must be exactly 32 bytes"))?;
        let msg = crypto::signing_message(&chain_id_arr, action_type, seq, action_payload);
        let signature = self.signer.try_sign(&msg).map_err(map_signer_err)?;
        let pubkey = self.signer.public_key();
        let encoded =
            codec::encode_signed_tx_raw(action_type, action_payload, seq, &pubkey, &signature)
                .map_err(map_err)?;
        Ok(PyBytes::new(py, &encoded))
    }

    /// Redacted repr — never leak key material via `str()`/logging.
    fn __repr__(&self) -> String {
        let mut pk = String::with_capacity(64);
        for b in self.signer.public_key() {
            pk.push_str(&format!("{b:02x}"));
        }
        format!("SigningHandle(public_key=0x{pk}, secret=<redacted>)")
    }
}

/// Sign an action and encode it as a wire-ready MessagePack envelope.
#[pyfunction]
fn sign_and_encode<'py>(
    py: Python<'py>,
    chain_id: &[u8],
    action_type: u8,
    action_payload: &[u8],
    seq: u64,
    secret_key: &[u8],
) -> PyResult<Bound<'py, PyBytes>> {
    let chain_id_arr: [u8; 32] = chain_id
        .try_into()
        .map_err(|_| PyValueError::new_err("chain_id must be exactly 32 bytes"))?;
    let sk_bytes: [u8; 32] = secret_key
        .try_into()
        .map_err(|_| PyValueError::new_err("secret_key must be exactly 32 bytes"))?;
    let signing_key = ed25519_dalek::SigningKey::from_bytes(&sk_bytes);

    let encoded = codec::sign_and_encode_payload(
        &chain_id_arr,
        action_type,
        action_payload,
        seq,
        &signing_key,
    )
    .map_err(map_err)?;

    Ok(PyBytes::new(py, &encoded))
}

/// Encode a pre-signed action into a wire envelope.
#[pyfunction]
fn encode_signed_tx<'py>(
    py: Python<'py>,
    action_type: u8,
    action_payload: &[u8],
    seq: u64,
    pubkey: &[u8],
    signature: &[u8],
) -> PyResult<Bound<'py, PyBytes>> {
    let pk: [u8; 32] = pubkey
        .try_into()
        .map_err(|_| PyValueError::new_err("pubkey must be exactly 32 bytes"))?;
    let sig: [u8; 64] = signature
        .try_into()
        .map_err(|_| PyValueError::new_err("signature must be exactly 64 bytes"))?;

    let encoded = codec::encode_signed_tx_raw(action_type, action_payload, seq, &pk, &sig)
        .map_err(map_err)?;

    Ok(PyBytes::new(py, &encoded))
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
fn encode_action<'py>(
    py: Python<'py>,
    action_type: u8,
    fields: &Bound<'py, PyAny>,
) -> PyResult<Bound<'py, PyBytes>> {
    let mut de = pythonize::Depythonizer::from_object(fields);
    let payload = codec::encode_payload_dyn(action_type, &mut de).map_err(map_err)?;
    Ok(PyBytes::new(py, &payload))
}

/// Decode raw MessagePack action-payload bytes into a native Python object
/// (a dict keyed by the action's field names), the inverse of
/// [`encode_action`]. The payload is parsed into the typed struct for
/// `action_type` and re-serialized through `pythonize`.
#[pyfunction]
fn decode_action<'py>(
    py: Python<'py>,
    action_type: u8,
    payload: &[u8],
) -> PyResult<Bound<'py, PyAny>> {
    let pythonizer = pythonize::Pythonizer::new(py);
    codec::decode_payload_dyn(action_type, payload, pythonizer).map_err(map_err)
}

/// Decode a wire envelope into its components.
#[pyfunction]
fn decode_tx<'py>(py: Python<'py>, tx_bytes: &[u8]) -> PyResult<Bound<'py, PyDict>> {
    let decoded = codec::decode_tx_raw(tx_bytes).map_err(map_err)?;

    let dict = PyDict::new(py);
    dict.set_item("version", decoded.version)?;
    dict.set_item("action_type", decoded.action_type)?;
    dict.set_item("seq", decoded.seq)?;
    dict.set_item("payload", PyBytes::new(py, &decoded.payload))?;
    dict.set_item("pubkey", PyBytes::new(py, &decoded.pubkey))?;
    dict.set_item("signature", PyBytes::new(py, &decoded.signature))?;
    Ok(dict)
}

/// Derive a 20-byte owner address from a 32-byte Ed25519 public key.
#[pyfunction]
fn pubkey_to_owner<'py>(py: Python<'py>, pubkey: &[u8]) -> PyResult<Bound<'py, PyBytes>> {
    let pk: [u8; 32] = pubkey
        .try_into()
        .map_err(|_| PyValueError::new_err("pubkey must be exactly 32 bytes"))?;
    let owner = crypto::pubkey_to_owner(&pk);
    Ok(PyBytes::new(py, &owner))
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
fn chain_id_from_string<'py>(py: Python<'py>, chain_id: &str) -> PyResult<Bound<'py, PyBytes>> {
    let result = crypto::chain_id_from_string(chain_id);
    Ok(PyBytes::new(py, &result))
}

/// Generate a new Ed25519 keypair, optionally from a 32-byte seed.
#[pyfunction]
#[pyo3(signature = (seed=None))]
fn generate_keypair<'py>(py: Python<'py>, seed: Option<&[u8]>) -> PyResult<Bound<'py, PyDict>> {
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

    let dict = PyDict::new(py);
    dict.set_item("secret_key", PyBytes::new(py, signing_key.as_bytes()))?;
    dict.set_item("public_key", PyBytes::new(py, &vk.to_bytes()))?;
    Ok(dict)
}

/// Load a signing key from a file descriptor into an opaque [`SigningHandle`].
///
/// Reads exactly 32 key bytes from `fd`, builds the in-process signing key, and
/// **immediately zeroizes the read buffer**. The key is sealed inside the
/// returned handle (a Rust-owned, zeroize-on-drop `SigningKey`) and is *never*
/// copied onto Python's heap — callers sign through `handle.sign_and_encode(…)`
/// and can read only the public key / owner. This is the FD-isolation design
/// the spec requires; returning the raw `secret_key` to Python would defeat it.
#[pyfunction]
fn load_key_from_fd(fd: i32) -> PyResult<SigningHandle> {
    use std::io::Read;
    use std::os::fd::{FromRawFd, OwnedFd};

    let owned = unsafe { OwnedFd::from_raw_fd(fd) };
    let mut buf = [0u8; 32];
    let mut file = std::fs::File::from(owned);
    file.read_exact(&mut buf)
        .map_err(|e| PyValueError::new_err(format!("failed to read key from fd: {e}")))?;

    let signer = core_sdk::LocalSigner::from_bytes(&buf);
    zeroize::Zeroize::zeroize(&mut buf);

    Ok(SigningHandle {
        signer: Box::new(signer),
    })
}

/// Bind to an Ed25519 signing key resident in a PKCS#11 token (HSM) and return
/// an opaque [`SigningHandle`].
///
/// The key never leaves the device: signing is performed inside the HSM. This
/// references a key that already exists in the token (by `key_label`); it does
/// not import or generate keys. `pin` is used only to log in and is not
/// retained by the handle.
///
/// Requires the crate's `pkcs11` feature (enabled by default). `module` is the
/// path to the vendor's PKCS#11 `.so`, loaded at runtime.
#[cfg(feature = "pkcs11")]
#[pyfunction]
fn load_key_from_pkcs11(
    module: &str,
    slot_id: u64,
    pin: &str,
    key_label: &str,
) -> PyResult<SigningHandle> {
    let signer = pkcs11::Pkcs11Signer::open(module, slot_id, pin, key_label)
        .map_err(PyValueError::new_err)?;
    Ok(SigningHandle {
        signer: Box::new(signer),
    })
}

/// Return all action-type name → code mappings from the Rust core.
/// Generated from the codec so bindings never drift.
#[pyfunction]
fn get_action_types<'py>(py: Python<'py>) -> PyResult<Bound<'py, PyList>> {
    let list = PyList::empty(py);
    for (name, code) in codec::get_action_types() {
        let d = PyDict::new(py);
        d.set_item("name", name)?;
        d.set_item("code", code)?;
        list.append(d)?;
    }
    Ok(list)
}

/// Return the error-code manifest — a list of {code, name, meaning} dicts.
/// One entry per ErrorKind variant. Generated from the Rust core so bindings
/// never drift.
#[pyfunction]
fn get_error_code_table<'py>(py: Python<'py>) -> PyResult<Bound<'py, PyList>> {
    let list = PyList::empty(py);
    for kind in core_sdk::types::error_code_manifest() {
        let d = PyDict::new(py);
        d.set_item("code", kind.code())?;
        d.set_item("name", kind.name())?;
        d.set_item("meaning", kind.meaning())?;
        list.append(d)?;
    }
    Ok(list)
}

/// Classify an engine result using its canonical DeliverTx log. This remains
/// separate from the numeric manifest because legacy engines may emit code 50
/// for open interest while upgraded engines use 50 for slippage and 51 for
/// open interest during a rolling upgrade.
#[pyfunction]
#[pyo3(signature = (code, log=None))]
fn classify_error_name(code: u32, log: Option<&str>) -> Option<&'static str> {
    core_sdk::types::decode_exec_error_kind(code, log).map(|kind| kind.name())
}

/// Native Python extension module for proof-trading-sdk (internal name: _native).
#[pymodule]
fn _native(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<SigningHandle>()?;
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
    #[cfg(feature = "pkcs11")]
    m.add_function(wrap_pyfunction!(load_key_from_pkcs11, m)?)?;
    m.add_function(wrap_pyfunction!(get_action_types, m)?)?;
    m.add_function(wrap_pyfunction!(get_error_code_table, m)?)?;
    m.add_function(wrap_pyfunction!(classify_error_name, m)?)?;
    Ok(())
}
