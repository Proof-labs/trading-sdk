//! Pluggable signing backend.
//!
//! A [`Signer`] produces Ed25519 signatures over the *canonical signing
//! message* (see [`crate::crypto::signing_message`]) without ever handing the
//! private key to the caller. This is the seam that lets every binding
//! (PyO3 / WASM / C-ABI) and every key custody model share one signing path:
//!
//! - [`LocalSigner`] holds the key in Rust-owned memory, zeroized on drop.
//! - An HSM, cloud-KMS, or remote signer implements [`Signer`] in its own
//!   crate — the key never enters this process — and drops into the same
//!   handle types unchanged.
//!
//! The trait is intentionally **open**: downstream consumers implement it for
//! their own custody backend against this crate.

use ed25519_dalek::{Signer as _, SigningKey};

/// Failure from a signing backend.
#[derive(Debug, derive_more::Display)]
pub enum SignerError {
    /// The backend (device / HSM / remote service) failed to sign.
    #[display("signing backend error: {_0}")]
    Backend(String),
    /// The backend returned a signature of the wrong length (expected 64).
    #[display("signer returned {_0}-byte signature, expected 64")]
    InvalidSignatureLength(usize),
}

impl std::error::Error for SignerError {}

/// A pluggable signing backend.
///
/// Implementors hold or reference an Ed25519 key and sign the canonical
/// signing message; they never expose the private key. `Send + Sync` so a
/// handle may be shared across threads (a binding can wrap it for FFI);
/// backends that are not internally thread-safe should use interior
/// synchronization (e.g. a `Mutex` around a device session).
pub trait Signer: Send + Sync {
    /// The 32-byte Ed25519 public key for this signer.
    fn public_key(&self) -> [u8; 32];

    /// Sign `msg`, returning the 64-byte detached Ed25519 signature.
    fn try_sign(&self, msg: &[u8]) -> Result<[u8; 64], SignerError>;
}

/// In-process signer: the key lives in Rust-owned memory and is zeroized on
/// drop (`ed25519_dalek::SigningKey` is `ZeroizeOnDrop`).
///
/// Use when the key is loaded from a file descriptor or environment at
/// startup. Prefer an HSM-backed [`Signer`] when the key must never reside in
/// process memory at all.
pub struct LocalSigner {
    key: SigningKey,
}

impl LocalSigner {
    /// Build from raw 32-byte Ed25519 seed bytes.
    ///
    /// The caller's copy of `seed` should be zeroized after this returns; the
    /// bytes are copied into the (zeroize-on-drop) `SigningKey`.
    pub fn from_bytes(seed: &[u8; 32]) -> Self {
        Self {
            key: SigningKey::from_bytes(seed),
        }
    }
}

impl Signer for LocalSigner {
    fn public_key(&self) -> [u8; 32] {
        self.key.verifying_key().to_bytes()
    }

    fn try_sign(&self, msg: &[u8]) -> Result<[u8; 64], SignerError> {
        Ok(self.key.sign(msg).to_bytes())
    }
}

/// Failure from [`sign_action`].
#[derive(Debug, derive_more::Display)]
pub enum SignActionError {
    /// The action did not encode.
    #[display("encode: {_0}")]
    Encode(String),
    /// The signing backend failed.
    #[display("{_0}")]
    Signer(SignerError),
}

impl std::error::Error for SignActionError {}

/// Sign `action` through any [`Signer`] and return the engine-ready envelope.
///
/// This is the custody-backend path: the key stays behind `signer` (HSM, KMS,
/// remote), and the action type and payload come from the same codec the
/// engine uses. `seq` is a wall-clock-millisecond timestamp nonce, unique per
/// signature for this key.
///
/// # Errors
///
/// [`SignActionError::Encode`] if the action does not encode,
/// [`SignActionError::Signer`] if the backend fails.
pub fn sign_action(
    signer: &dyn Signer,
    chain_id: &[u8; 32],
    action: &crate::types::Action,
    seq: u64,
) -> Result<Vec<u8>, SignActionError> {
    use crate::{codec, crypto};
    let encode = |e: crate::types::ExecError| SignActionError::Encode(e.to_string());
    let public_key = signer.public_key();
    // The typed codec only signs with an in-memory key, so take the canonical
    // (action_type, payload) from an unsigned envelope and sign the preimage.
    let unsigned = codec::encode_signed_tx(action, seq, &public_key, &[0; 64]).map_err(encode)?;
    let raw = codec::decode_tx_raw(&unsigned).map_err(encode)?;
    let msg = crypto::signing_message(chain_id, raw.action_type, seq, &raw.payload);
    let signature = signer.try_sign(&msg).map_err(SignActionError::Signer)?;
    codec::encode_signed_tx_raw(raw.action_type, &raw.payload, seq, &public_key, &signature)
        .map_err(encode)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;
    use crate::crypto;

    #[test]
    fn local_signer_matches_dalek_and_verifies() {
        let seed = [0x42u8; 32];
        let signer = LocalSigner::from_bytes(&seed);

        let expected_pk = SigningKey::from_bytes(&seed).verifying_key().to_bytes();
        assert_eq!(signer.public_key(), expected_pk);

        let msg = crypto::signing_message(&crypto::UNBOUND_CHAIN_ID, 0x01, 7, b"payload");
        let sig = signer.try_sign(&msg).unwrap();

        // Round-trips through the core verifier.
        assert!(crypto::verify_signature(
            &crypto::UNBOUND_CHAIN_ID,
            &signer.public_key(),
            &sig,
            0x01,
            7,
            b"payload",
        )
        .is_ok());
    }

    #[test]
    fn sign_action_matches_the_in_memory_codec() {
        let seed = [0x42u8; 32];
        let chain_id = crypto::chain_id_from_string("exchange-devnet-1");
        let action = crate::types::Action::PlaceOrder(crate::types::PlaceOrder {
            market: 1,
            price: 5,
            quantity: 1,
            ..Default::default()
        });
        let via_signer =
            sign_action(&LocalSigner::from_bytes(&seed), &chain_id, &action, 9).unwrap();
        let via_codec = crate::codec::sign_and_encode_with_chain(
            &chain_id,
            &action,
            9,
            &SigningKey::from_bytes(&seed),
        )
        .unwrap();
        assert_eq!(via_signer, via_codec);
    }
}
