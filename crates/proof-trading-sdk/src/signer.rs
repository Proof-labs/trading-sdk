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
}
