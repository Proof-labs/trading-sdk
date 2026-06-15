use ed25519_dalek::{Signature, VerifyingKey};
use sha3::{Digest, Keccak256};

use crate::types::ExecError;

/// Domain separator for v3 signing messages. Bumped from v2 on
/// 2026-04-23 (audit finding B4) when the envelope gained a 32-byte
/// `chain_id` binding — v2 had no chain ID, which let a tx signed for
/// `dev` be replayed on `testnet` or `prod` (or any post-wipe fresh
/// chain) with the same pubkey. Any v2 signature submitted post-v3
/// will verify against a different message bytes and fail.
const DOMAIN_PREFIX: &[u8] = b"ProofExchange-v3";

/// 32-byte zero chain_id. Used in tests and in engine startup paths
/// before a real `chain_id` has been bound (the monorepo's node
/// replay harness, for example). Treat this as "unbound chain" —
/// a production deployment MUST bind a non-zero chain_id or every
/// tx becomes replayable across deployments. Bindings happen at
/// `engine_new` / snapshot-restore boundaries.
pub const UNBOUND_CHAIN_ID: [u8; 32] = [0u8; 32];

/// Derive a 20-byte internal owner address from a 32-byte Ed25519 public key.
///
/// Uses Keccak-256 and takes the last 20 bytes (same as Ethereum's approach,
/// applied to Solana Ed25519 keys).
pub fn pubkey_to_owner(pubkey: &[u8; 32]) -> [u8; 20] {
    let hash = Keccak256::digest(pubkey);
    let mut owner = [0u8; 20];
    owner.copy_from_slice(&hash[12..32]);
    owner
}

/// Hash a CometBFT chain_id string into the 32-byte form used in the
/// signing envelope. Keccak-256 so every language (Rust, Go, TS) can
/// reproduce the binding without dragging in an extra hash dependency.
/// Called once at genesis / snapshot-load and then cached; callers
/// don't need to re-hash per tx.
pub fn chain_id_from_string(chain_id: &str) -> [u8; 32] {
    let hash = Keccak256::digest(chain_id.as_bytes());
    let mut out = [0u8; 32];
    out.copy_from_slice(&hash);
    out
}

/// Construct the deterministic signing message for a transaction.
///
/// V3 layout: `DOMAIN_PREFIX(16) || chain_id(32) || action_type(1) || seq_be(8) || payload`
///
/// The `chain_id` field binds the signature to a specific chain. Two
/// chains with the same user keys but different chain_ids will produce
/// mutually invalid signatures — closing the cross-chain replay vector
/// that audit B4 identified.
pub fn signing_message(chain_id: &[u8; 32], action_type: u8, seq: u64, payload: &[u8]) -> Vec<u8> {
    // 16 (domain prefix) + 32 (chain_id) + 1 (action_type) + 8 (seq) + payload
    let cap = DOMAIN_PREFIX
        .len()
        .saturating_add(32)
        .saturating_add(9)
        .saturating_add(payload.len());
    let mut msg = Vec::with_capacity(cap);
    msg.extend_from_slice(DOMAIN_PREFIX);
    msg.extend_from_slice(chain_id);
    msg.push(action_type);
    msg.extend_from_slice(&seq.to_be_bytes());
    msg.extend_from_slice(payload);
    msg
}

/// Verify an Ed25519 signature over the canonical v3 signing message.
///
/// Uses `verify_strict` which rejects non-canonical S values and small-order
/// public keys, matching Solana's signature verification behavior.
pub fn verify_signature(
    chain_id: &[u8; 32],
    pubkey: &[u8; 32],
    signature: &[u8; 64],
    action_type: u8,
    seq: u64,
    payload: &[u8],
) -> Result<(), ExecError> {
    let verifying_key =
        VerifyingKey::from_bytes(pubkey).map_err(|_| ExecError::InvalidSignature)?;

    let sig = Signature::from_bytes(signature);

    let msg = signing_message(chain_id, action_type, seq, payload);

    verifying_key
        .verify_strict(&msg, &sig)
        .map_err(|_| ExecError::InvalidSignature)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;

    fn test_keypair() -> SigningKey {
        SigningKey::from_bytes(&[0x42; 32])
    }

    const TEST_CHAIN: [u8; 32] = [0u8; 32];

    fn sign(key: &SigningKey, action_type: u8, seq: u64, payload: &[u8]) -> [u8; 64] {
        use ed25519_dalek::Signer;
        let msg = signing_message(&TEST_CHAIN, action_type, seq, payload);
        let sig = key.sign(&msg);
        sig.to_bytes()
    }

    #[test]
    fn sign_verify_round_trip() {
        let key = test_keypair();
        let pubkey = key.verifying_key().to_bytes();
        let payload = b"test payload";
        let sig = sign(&key, 0x01, 42, payload);
        assert!(verify_signature(&TEST_CHAIN, &pubkey, &sig, 0x01, 42, payload).is_ok());
    }

    #[test]
    fn wrong_key_fails() {
        let key = test_keypair();
        let wrong_key = SigningKey::from_bytes(&[0x43; 32]);
        let wrong_pubkey = wrong_key.verifying_key().to_bytes();
        let payload = b"test payload";
        let sig = sign(&key, 0x01, 42, payload);
        assert!(verify_signature(&TEST_CHAIN, &wrong_pubkey, &sig, 0x01, 42, payload).is_err());
    }

    #[test]
    fn tampered_payload_fails() {
        let key = test_keypair();
        let pubkey = key.verifying_key().to_bytes();
        let payload = b"test payload";
        let sig = sign(&key, 0x01, 42, payload);
        assert!(verify_signature(&TEST_CHAIN, &pubkey, &sig, 0x01, 42, b"tampered").is_err());
    }

    #[test]
    fn tampered_signature_fails() {
        let key = test_keypair();
        let pubkey = key.verifying_key().to_bytes();
        let payload = b"test payload";
        let mut sig = sign(&key, 0x01, 42, payload);
        sig[0] ^= 0xFF;
        assert!(verify_signature(&TEST_CHAIN, &pubkey, &sig, 0x01, 42, payload).is_err());
    }

    #[test]
    fn wrong_action_type_fails() {
        let key = test_keypair();
        let pubkey = key.verifying_key().to_bytes();
        let payload = b"test payload";
        let sig = sign(&key, 0x01, 42, payload);
        assert!(verify_signature(&TEST_CHAIN, &pubkey, &sig, 0x02, 42, payload).is_err());
    }

    #[test]
    fn wrong_seq_fails() {
        let key = test_keypair();
        let pubkey = key.verifying_key().to_bytes();
        let payload = b"test payload";
        let sig = sign(&key, 0x01, 42, payload);
        assert!(verify_signature(&TEST_CHAIN, &pubkey, &sig, 0x01, 43, payload).is_err());
    }

    /// B4 regression test: a signature generated for chain_id A must
    /// NOT verify against chain_id B. Without this binding, any user
    /// key promoted from dev → testnet → prod would have all their
    /// historical txs re-playable. If this test ever passes trivially
    /// again, v3 signing has been silently downgraded.
    #[test]
    fn v3_cross_chain_replay_rejected_b4_regression() {
        let key = test_keypair();
        let pubkey = key.verifying_key().to_bytes();
        let payload = b"mint 1M";
        let chain_a = chain_id_from_string("proof-dev-1");
        let chain_b = chain_id_from_string("proof-prod-1");
        assert_ne!(chain_a, chain_b);

        // Sign for chain A.
        use ed25519_dalek::Signer;
        let sig_a = key
            .sign(&signing_message(&chain_a, 0x01, 7, payload))
            .to_bytes();

        // Must verify against chain A.
        assert!(verify_signature(&chain_a, &pubkey, &sig_a, 0x01, 7, payload).is_ok());
        // Must NOT verify against chain B.
        assert!(verify_signature(&chain_b, &pubkey, &sig_a, 0x01, 7, payload).is_err());
    }

    #[test]
    fn pubkey_to_owner_deterministic() {
        let key = test_keypair();
        let pubkey = key.verifying_key().to_bytes();
        let a = pubkey_to_owner(&pubkey);
        let b = pubkey_to_owner(&pubkey);
        assert_eq!(a, b);
        assert_ne!(a, [0u8; 20]);
    }

    #[test]
    fn pubkey_to_owner_different_keys_different_owners() {
        let k1 = SigningKey::from_bytes(&[0x01; 32]);
        let k2 = SigningKey::from_bytes(&[0x02; 32]);
        let o1 = pubkey_to_owner(&k1.verifying_key().to_bytes());
        let o2 = pubkey_to_owner(&k2.verifying_key().to_bytes());
        assert_ne!(o1, o2);
    }

    #[test]
    fn signing_message_includes_domain_separator() {
        let msg = signing_message(&TEST_CHAIN, 0x01, 1, b"payload");
        assert!(msg.starts_with(DOMAIN_PREFIX));
    }

    #[test]
    fn signing_message_deterministic() {
        let a = signing_message(&TEST_CHAIN, 0x01, 42, b"payload");
        let b = signing_message(&TEST_CHAIN, 0x01, 42, b"payload");
        assert_eq!(a, b);
    }

    // -------------------------------------------------------------------
    // Stress tests
    // -------------------------------------------------------------------

    #[test]
    fn stress_10000_unique_keypairs_sign_verify() {
        for i in 0u32..10_000 {
            let mut seed = [0u8; 32];
            seed[0..4].copy_from_slice(&i.to_le_bytes());
            let key = SigningKey::from_bytes(&seed);
            let pubkey = key.verifying_key().to_bytes();
            let payload = i.to_be_bytes();
            let sig = sign(&key, 0x01, i as u64, &payload);
            assert!(
                verify_signature(&TEST_CHAIN, &pubkey, &sig, 0x01, i as u64, &payload).is_ok(),
                "round-trip failed at i={i}"
            );
        }
    }

    #[test]
    fn stress_10000_keypairs_no_address_collisions() {
        use std::collections::HashSet;
        let mut seen = HashSet::new();
        for i in 0u32..10_000 {
            let mut seed = [0u8; 32];
            seed[0..4].copy_from_slice(&i.to_le_bytes());
            let key = SigningKey::from_bytes(&seed);
            let owner = pubkey_to_owner(&key.verifying_key().to_bytes());
            assert!(seen.insert(owner), "address collision at i={i}");
        }
        assert_eq!(seen.len(), 10_000);
    }

    #[test]
    fn stress_variable_payload_sizes() {
        let key = test_keypair();
        let pubkey = key.verifying_key().to_bytes();

        for size in [
            0, 1, 15, 16, 31, 32, 63, 64, 127, 128, 255, 256, 512, 1024, 4096, 8192,
        ] {
            let payload: Vec<u8> = (0..size).map(|i| (i & 0xFF) as u8).collect();
            let sig = sign(&key, 0x03, 99, &payload);
            assert!(
                verify_signature(&TEST_CHAIN, &pubkey, &sig, 0x03, 99, &payload).is_ok(),
                "failed for payload size {size}"
            );
        }
    }

    #[test]
    fn stress_all_action_types_all_seqs() {
        let key = test_keypair();
        let pubkey = key.verifying_key().to_bytes();
        let payload = b"test";

        // All 15 action types (0x01..=0x0F, including 0x0E CreateImpactMarket + 0x0F ResolveEvent)
        for action_type in 0x01u8..=0x0F {
            // Boundary seq values
            for seq in [0u64, 1, u64::MAX / 2, u64::MAX - 1, u64::MAX] {
                let sig = sign(&key, action_type, seq, payload);
                assert!(
                    verify_signature(&TEST_CHAIN, &pubkey, &sig, action_type, seq, payload).is_ok(),
                    "failed for action={action_type:#x} seq={seq}"
                );
                // Wrong action_type should fail
                let wrong_at = if action_type == 0x0F {
                    0x01
                } else {
                    action_type + 1
                };
                assert!(
                    verify_signature(&TEST_CHAIN, &pubkey, &sig, wrong_at, seq, payload).is_err(),
                    "should fail with wrong action_type at={action_type:#x}"
                );
            }
        }
    }

    #[test]
    fn stress_tamper_every_byte_of_signature() {
        let key = test_keypair();
        let pubkey = key.verifying_key().to_bytes();
        let payload = b"important data";
        let sig = sign(&key, 0x01, 1, payload);

        for byte_idx in 0..64 {
            let mut tampered = sig;
            tampered[byte_idx] ^= 0x01; // flip one bit
            assert!(
                verify_signature(&TEST_CHAIN, &pubkey, &tampered, 0x01, 1, payload).is_err(),
                "tampered byte {byte_idx} should invalidate signature"
            );
        }
    }

    #[test]
    fn stress_tamper_every_byte_of_payload() {
        let key = test_keypair();
        let pubkey = key.verifying_key().to_bytes();
        let payload: Vec<u8> = (0u8..=255).collect();
        let sig = sign(&key, 0x01, 1, &payload);

        for byte_idx in 0..payload.len() {
            let mut tampered = payload.clone();
            tampered[byte_idx] ^= 0xFF;
            assert!(
                verify_signature(&TEST_CHAIN, &pubkey, &sig, 0x01, 1, &tampered).is_err(),
                "tampered payload byte {byte_idx} should fail"
            );
        }
    }

    #[test]
    fn stress_boundary_pubkeys() {
        // All-zeros pubkey should fail (low-order point)
        let zero_pubkey = [0u8; 32];
        let fake_sig = [0u8; 64];
        assert!(verify_signature(&TEST_CHAIN, &zero_pubkey, &fake_sig, 0x01, 1, b"x").is_err());

        // All-ones pubkey should fail (not on curve)
        let ones_pubkey = [0xFF; 32];
        assert!(verify_signature(&TEST_CHAIN, &ones_pubkey, &fake_sig, 0x01, 1, b"x").is_err());
    }
}
