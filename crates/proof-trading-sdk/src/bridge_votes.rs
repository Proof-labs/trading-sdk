//! Bridge vote construction and signing — the wire-12 vote model.
//!
//! The operator registry's members settle withdrawals and deposits by
//! voting: each member signs the vote's canonical bytes with its operator
//! ed25519 key and submits [`VoteWithdrawalPaid`] (0x30) / [`VoteDeposit`]
//! (0x32) on its own — the engine aggregates distinct member signatures and
//! settles at the roster's threshold. A vote carries its own signature and
//! deliberately does **not** use the envelope signing convention: the
//! envelope signer is an untrusted courier, and the engine only counts the
//! votes whose `signature` verifies against the bound epoch's registry.
//!
//! The canonical preimage lives in the wire contract
//! ([`VoteWithdrawalPaid::vote_message`] / [`VoteDeposit::vote_message`],
//! `PROOF_BRIDGE_VOTE_V1 || kind || …`), the same definition the engine
//! verifies, so the SDK signs exactly the bytes the engine checks. These
//! helpers build the payload and fill its `signature` through the
//! custody-neutral [`Signer`] seam; the returned actions then ride the
//! ordinary encode/submit path (`codec::sign_and_encode_with_chain`,
//! [`crate::sign_action`]) like any other action.

use crate::signer::{Signer, SignerError};
use crate::types::{DepositLocator, VoteDeposit, VoteWithdrawalPaid};

/// Build and sign one registry member's vote to settle a withdrawal as
/// `Paid`. The signature is over [`VoteWithdrawalPaid::vote_message`] —
/// domain, kind, withdrawal id, deployment, chain, epoch — and verifies
/// against the `registry_epoch` roster's member key.
///
/// `chain_id` is the 32-byte chain binding the vote replay-protects (the
/// same bytes [`crate::crypto::chain_id_from_string`] produces).
///
/// # Errors
///
/// [`SignerError`] if the signing backend fails.
pub fn sign_vote_withdrawal_paid(
    signer: &dyn Signer,
    withdrawal_id: u64,
    deployment_id: [u8; 32],
    chain_id: [u8; 32],
    registry_epoch: u64,
) -> Result<VoteWithdrawalPaid, SignerError> {
    // The message reads only the identity fields, so the placeholder
    // signature never feeds the preimage.
    let unsigned = VoteWithdrawalPaid {
        withdrawal_id,
        deployment_id,
        chain_id,
        registry_epoch,
        signature: Vec::new(),
    };
    let signature = signer.try_sign(&unsigned.vote_message())?;
    Ok(VoteWithdrawalPaid {
        signature: signature.to_vec(),
        ..unsigned
    })
}

/// Build and sign one registry member's vote to credit one observed Solana
/// deposit. The signature is over [`VoteDeposit::vote_message`] — domain,
/// kind, and the full credit identity (owner, amount, transaction
/// signature, locator, deployment, chain, epoch). Two members voting on the
/// same observation sign identical bytes.
///
/// A `locator` of `None` is the LEGACY reading (top-level instruction 0, no
/// inner index), the same default the wire applies to an absent
/// `ConfirmDeposit.locator`.
///
/// # Errors
///
/// [`SignerError`] if the signing backend fails.
pub fn sign_vote_deposit(
    signer: &dyn Signer,
    owner: [u8; 20],
    amount_micro_usdc: u64,
    solana_tx_sig: [u8; 64],
    locator: Option<DepositLocator>,
    deployment_id: [u8; 32],
    chain_id: [u8; 32],
    registry_epoch: u64,
) -> Result<VoteDeposit, SignerError> {
    let unsigned = VoteDeposit {
        owner,
        amount_micro_usdc,
        solana_tx_sig: solana_tx_sig.to_vec(),
        locator,
        deployment_id,
        chain_id,
        registry_epoch,
        signature: Vec::new(),
    };
    let signature = signer.try_sign(&unsigned.vote_message())?;
    Ok(VoteDeposit {
        signature: signature.to_vec(),
        ..unsigned
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;
    use crate::codec;
    use crate::crypto;
    use crate::signer::LocalSigner;
    use ed25519_dalek::Verifier as _;

    const DEPLOYMENT: [u8; 32] = [0xA1; 32];
    const CHAIN: [u8; 32] = [0xC7; 32];

    #[test]
    fn withdrawal_vote_signature_verifies_over_the_wire_preimage() {
        let seed = [0x42u8; 32];
        let key = ed25519_dalek::SigningKey::from_bytes(&seed);
        let vote = sign_vote_withdrawal_paid(
            &LocalSigner::from_bytes(&seed),
            777,
            DEPLOYMENT,
            CHAIN,
            3,
        )
        .unwrap();

        assert_eq!(vote.signature.len(), 64);
        // The signature verifies against the signer's key over exactly the
        // wire's canonical bytes — the bytes the engine re-derives and
        // checks against the bound roster.
        let message = VoteWithdrawalPaid {
            signature: Vec::new(),
            ..vote.clone()
        }
        .vote_message();
        assert!(key
            .verifying_key()
            .verify(&message, &ed25519_dalek::Signature::from_bytes(
                &vote.signature.try_into().unwrap()
            ))
            .is_ok());

        // The preimage is the documented layout: domain || kind(0x01) ||
        // withdrawal_id(8 BE) || deployment(32) || chain(32) || epoch(8 BE).
        let mut expected = Vec::new();
        expected.extend_from_slice(b"PROOF_BRIDGE_VOTE_V1");
        expected.push(1);
        expected.extend_from_slice(&777u64.to_be_bytes());
        expected.extend_from_slice(&DEPLOYMENT);
        expected.extend_from_slice(&CHAIN);
        expected.extend_from_slice(&3u64.to_be_bytes());
        assert_eq!(message, expected);
    }

    #[test]
    fn deposit_vote_signature_verifies_and_the_locator_suffix_is_pinned() {
        let seed = [0x07u8; 32];
        let key = ed25519_dalek::SigningKey::from_bytes(&seed);
        let locator = DepositLocator {
            top_index: 2,
            inner_index: Some(5),
        };
        let vote = sign_vote_deposit(
            &LocalSigner::from_bytes(&seed),
            [0x11; 20],
            1_000_000,
            [0x22; 64],
            Some(locator),
            DEPLOYMENT,
            CHAIN,
            9,
        )
        .unwrap();

        let unsigned = VoteDeposit {
            signature: Vec::new(),
            ..vote.clone()
        };
        // domain || kind(0x02) || owner(20) || amount(8 BE) || tx_sig(64) ||
        // locator(4: top BE, inner BE) || deployment(32) || chain(32) ||
        // epoch(8 BE).
        let mut expected = Vec::new();
        expected.extend_from_slice(b"PROOF_BRIDGE_VOTE_V1");
        expected.push(2);
        expected.extend_from_slice(&[0x11; 20]);
        expected.extend_from_slice(&1_000_000u64.to_be_bytes());
        expected.extend_from_slice(&[0x22; 64]);
        expected.extend_from_slice(&2u16.to_be_bytes());
        expected.extend_from_slice(&5u16.to_be_bytes());
        expected.extend_from_slice(&DEPLOYMENT);
        expected.extend_from_slice(&CHAIN);
        expected.extend_from_slice(&9u64.to_be_bytes());
        assert_eq!(unsigned.vote_message(), expected);

        assert!(key
            .verifying_key()
            .verify(&expected, &ed25519_dalek::Signature::from_bytes(
                &vote.signature.try_into().unwrap()
            ))
            .is_ok());
    }

    #[test]
    fn an_absent_locator_signs_the_legacy_suffix() {
        let seed = [0x09u8; 32];
        let signer = LocalSigner::from_bytes(&seed);
        let absent = sign_vote_deposit(
            &signer, [0x11; 20], 5, [0x22; 64], None, DEPLOYMENT, CHAIN, 1,
        )
        .unwrap();
        let legacy = sign_vote_deposit(
            &signer,
            [0x11; 20],
            5,
            [0x22; 64],
            Some(DepositLocator::LEGACY),
            DEPLOYMENT,
            CHAIN,
            1,
        )
        .unwrap();
        // None and the LEGACY locator are the same reading: identical
        // preimages, identical signatures.
        assert_eq!(absent.vote_message(), legacy.vote_message());
        let unsigned = VoteDeposit {
            signature: Vec::new(),
            ..legacy.clone()
        };
        let suffix_at = b"PROOF_BRIDGE_VOTE_V1".len() + 1 + 20 + 8 + 64;
        assert_eq!(
            &unsigned.vote_message()[suffix_at..suffix_at + 4],
            &[0, 0, 0xFF, 0xFF]
        );
        assert_eq!(absent.signature, legacy.signature);
    }

    #[test]
    fn votes_round_trip_through_the_signed_envelope_and_differ_per_item() {
        let seed = [0x33u8; 32];
        let signer = LocalSigner::from_bytes(&seed);
        let signing_key = ed25519_dalek::SigningKey::from_bytes(&seed);

        let withdrawal = sign_vote_withdrawal_paid(
            &signer,
            u64::MAX,
            DEPLOYMENT,
            CHAIN,
            u64::MAX,
        )
        .unwrap();
        let wire = codec::sign_and_encode_with_chain(
            &CHAIN,
            &crate::types::Action::VoteWithdrawalPaid(withdrawal.clone()),
            1,
            &signing_key,
        )
        .unwrap();
        let decoded = codec::decode_tx(&wire).unwrap();
        // `Action` carries no `PartialEq`; equal canonical bytes are the
        // same action field for field.
        let canonical = |a: &crate::types::Action| rmp_serde::to_vec(a).unwrap();
        assert_eq!(
            canonical(&decoded.action),
            canonical(&crate::types::Action::VoteWithdrawalPaid(withdrawal.clone()))
        );
        // Deterministic: the same key and item sign identical bytes.
        let again = sign_vote_withdrawal_paid(&signer, u64::MAX, DEPLOYMENT, CHAIN, u64::MAX)
            .unwrap();
        assert_eq!(again.signature, withdrawal.signature);
        // …and a different withdrawal id cannot reuse them.
        let other = sign_vote_withdrawal_paid(&signer, 1, DEPLOYMENT, CHAIN, u64::MAX).unwrap();
        assert_ne!(other.signature, withdrawal.signature);

        let deposit = sign_vote_deposit(
            &signer,
            [0x44; 20],
            u64::MAX,
            [0x55; 64],
            Some(DepositLocator {
                top_index: u16::MAX,
                inner_index: None,
            }),
            DEPLOYMENT,
            CHAIN,
            u64::MAX,
        )
        .unwrap();
        let wire = codec::sign_and_encode_with_chain(
            &CHAIN,
            &crate::types::Action::VoteDeposit(deposit.clone()),
            2,
            &signing_key,
        )
        .unwrap();
        assert_eq!(
            canonical(&codec::decode_tx(&wire).unwrap().action),
            canonical(&crate::types::Action::VoteDeposit(deposit))
        );
    }

    /// A vote's own signature never verifies as an envelope signature over
    /// the same payload: the domain separator keeps the two signature
    /// spaces disjoint.
    #[test]
    fn a_vote_signature_is_not_an_envelope_signature() {
        let seed = [0x42u8; 32];
        let key = LocalSigner::from_bytes(&seed);
        let signing_key = ed25519_dalek::SigningKey::from_bytes(&seed);
        let vote = sign_vote_withdrawal_paid(&key, 1, DEPLOYMENT, CHAIN, 1).unwrap();
        let wire = codec::sign_and_encode_with_chain(
            &CHAIN,
            &crate::types::Action::VoteWithdrawalPaid(vote.clone()),
            1,
            &signing_key,
        )
        .unwrap();
        let raw = codec::decode_tx_raw(&wire).unwrap();
        // The envelope path signs DOMAIN || chain || type || seq || payload;
        // the vote signature is over the bare vote preimage, so swapping
        // the conventions must fail closed.
        assert!(crypto::verify_signature(
            &CHAIN,
            &raw.pubkey,
            &vote.signature.try_into().unwrap(),
            raw.action_type,
            1,
            &raw.payload,
        )
        .is_err());
        // The envelope's own signature still verifies.
        assert!(crypto::verify_signature(
            &CHAIN,
            &raw.pubkey,
            &raw.signature,
            raw.action_type,
            1,
            &raw.payload,
        )
        .is_ok());
    }
}
