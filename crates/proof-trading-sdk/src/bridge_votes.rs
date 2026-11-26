//! Bridge-operator message construction and signing.
//!
//! A bridge operator's only identity is its registry key ([`OperatorKey`]).
//! It signs five messages, each submitted on its own; the engine counts the
//! distinct operators whose signature verifies against the named epoch's
//! roster:
//!
//! - [`VoteWithdrawalPaid`] (0x30): settle a withdrawal `Paid` at the
//!   roster's threshold;
//! - [`RecordWithdrawalPayout`] (0x31): record the Squads payout the
//!   operator proposed, which fills the withdrawal's payout slot;
//! - [`VoteDeposit`] (0x32): credit one observed deposit at the threshold;
//! - [`VotePauseBridge`] (0x33): pause the bridge at the threshold;
//! - [`VoteWithdrawalPayoutDead`] (0x34): clear a rejected payout's slot at
//!   the threshold.
//!
//! The signature is the message's authority, not the envelope's: any
//! envelope signer may submit a signed message, and the engine verifies the
//! message's own `signature`.
//!
//! The canonical preimages live in the wire contract (`vote_message` /
//! `record_message`, `PROOF_BRIDGE_VOTE_V1 || kind || …`), the same
//! definitions the engine verifies, so the SDK signs exactly the bytes the
//! engine checks. These helpers build the payload and fill its `signature`
//! through the custody-neutral [`Signer`] seam; the returned actions then
//! ride the ordinary encode and submit path
//! (`codec::sign_and_encode_with_chain`, [`crate::sign_action`]).

use crate::bridge::{
    DeploymentId, MicroUsdc, OperatorSignature, ProofOwner, RegistryEpoch, SolanaPubkey,
    TxSignature, WithdrawalId,
};
use crate::signer::{Signer, SignerError};
use crate::types::{
    DepositLocator, RecordWithdrawalPayout, VoteDeposit, VotePauseBridge, VoteWithdrawalPaid,
    VoteWithdrawalPayoutDead,
};

#[cfg(doc)]
use crate::bridge::OperatorKey;

/// The binding every bridge-operator message carries: the deployment and
/// chain it cannot replay across, and the registry epoch whose roster
/// judges its signature.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BridgeBinding {
    pub deployment_id: DeploymentId,
    pub chain_id: [u8; 32],
    pub registry_epoch: RegistryEpoch,
}

/// One recorded Squads payout of one withdrawal: what a payout record
/// records and what the Paid and Dead votes attest.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PayoutIdentity {
    pub withdrawal_id: WithdrawalId,
    /// The governed Squads vault the payout pays from.
    pub vault: SolanaPubkey,
    /// The Squads vault-transaction index of the payout proposal.
    pub squads_transaction_index: u32,
}

/// One observed Solana deposit: the credit a deposit vote attests.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DepositObservation {
    /// The receiving engine account.
    pub owner: ProofOwner,
    pub amount: MicroUsdc,
    pub solana_tx_sig: TxSignature,
    /// `None` is the LEGACY reading (top-level instruction 0, no inner
    /// index), the same default the wire applies to an absent
    /// `ConfirmDeposit.locator`.
    pub locator: Option<DepositLocator>,
}

/// One bridge-operator message's signed fields: what [`BridgeMessage::preimage`]
/// turns into the bytes an operator signs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BridgeMessage {
    WithdrawalPaid {
        payout: PayoutIdentity,
        binding: BridgeBinding,
    },
    WithdrawalPayoutDead {
        payout: PayoutIdentity,
        binding: BridgeBinding,
    },
    PayoutRecord {
        payout: PayoutIdentity,
        binding: BridgeBinding,
    },
    Deposit {
        deposit: DepositObservation,
        binding: BridgeBinding,
    },
    PauseBridge {
        /// The Unix time in milliseconds the operator signs at.
        signed_at_ms: u64,
        binding: BridgeBinding,
    },
}

impl BridgeMessage {
    /// The canonical bytes the operator signs: the wire contract's
    /// `vote_message` / `record_message` for this message.
    #[must_use]
    pub fn preimage(&self) -> Vec<u8> {
        match *self {
            Self::WithdrawalPaid { payout, binding } => {
                paid_vote(payout, binding, UNSIGNED).vote_message()
            }
            Self::WithdrawalPayoutDead { payout, binding } => {
                dead_vote(payout, binding, UNSIGNED).vote_message()
            }
            Self::PayoutRecord { payout, binding } => {
                payout_record(payout, binding, UNSIGNED).record_message()
            }
            Self::Deposit { deposit, binding } => {
                deposit_vote(deposit, binding, UNSIGNED).vote_message()
            }
            Self::PauseBridge {
                signed_at_ms,
                binding,
            } => pause_vote(signed_at_ms, binding, UNSIGNED).vote_message(),
        }
    }
}

fn paid_vote(
    payout: PayoutIdentity,
    binding: BridgeBinding,
    signature: OperatorSignature,
) -> VoteWithdrawalPaid {
    VoteWithdrawalPaid {
        withdrawal_id: payout.withdrawal_id,
        vault: payout.vault,
        squads_transaction_index: payout.squads_transaction_index,
        deployment_id: binding.deployment_id,
        chain_id: binding.chain_id,
        registry_epoch: binding.registry_epoch,
        signature,
    }
}

fn dead_vote(
    payout: PayoutIdentity,
    binding: BridgeBinding,
    signature: OperatorSignature,
) -> VoteWithdrawalPayoutDead {
    VoteWithdrawalPayoutDead {
        withdrawal_id: payout.withdrawal_id,
        vault: payout.vault,
        squads_transaction_index: payout.squads_transaction_index,
        deployment_id: binding.deployment_id,
        chain_id: binding.chain_id,
        registry_epoch: binding.registry_epoch,
        signature,
    }
}

fn payout_record(
    payout: PayoutIdentity,
    binding: BridgeBinding,
    signature: OperatorSignature,
) -> RecordWithdrawalPayout {
    RecordWithdrawalPayout {
        withdrawal_id: payout.withdrawal_id,
        vault: payout.vault,
        squads_transaction_index: payout.squads_transaction_index,
        deployment_id: binding.deployment_id,
        chain_id: binding.chain_id,
        registry_epoch: binding.registry_epoch,
        signature,
    }
}

fn deposit_vote(
    deposit: DepositObservation,
    binding: BridgeBinding,
    signature: OperatorSignature,
) -> VoteDeposit {
    VoteDeposit {
        owner: *deposit.owner.as_bytes(),
        amount_micro_usdc: deposit.amount,
        solana_tx_sig: deposit.solana_tx_sig,
        locator: deposit.locator,
        deployment_id: binding.deployment_id,
        chain_id: binding.chain_id,
        registry_epoch: binding.registry_epoch,
        signature,
    }
}

fn pause_vote(
    signed_at_ms: u64,
    binding: BridgeBinding,
    signature: OperatorSignature,
) -> VotePauseBridge {
    VotePauseBridge {
        signed_at_ms,
        deployment_id: binding.deployment_id,
        chain_id: binding.chain_id,
        registry_epoch: binding.registry_epoch,
        signature,
    }
}

impl DepositObservation {
    /// The locator an operator may sign: an inner index of `0xFFFF` is the
    /// wire's absent-index sentinel, so it would sign the same bytes as no
    /// inner index and is refused.
    ///
    /// # Errors
    ///
    /// The refusal text when `inner_index` is `0xFFFF`.
    pub fn checked_locator(
        top_index: u16,
        inner_index: Option<u16>,
    ) -> Result<DepositLocator, &'static str> {
        if inner_index == Some(u16::MAX) {
            return Err("inner_index 65535 is the absent-index sentinel; pass no inner index");
        }
        Ok(DepositLocator {
            top_index,
            inner_index,
        })
    }
}

/// Deserialize a byte string and nothing else: no text, no number list. The
/// WASM and Python bindings read message fields with it, so a string or an
/// integer can never become the bytes an operator signs.
pub mod strict_bytes {
    use serde::de::{Deserializer, Error, Visitor};

    /// Read one byte string.
    ///
    /// # Errors
    ///
    /// When the value is not a byte string.
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        struct ByteString;
        impl Visitor<'_> for ByteString {
            type Value = Vec<u8>;
            fn expecting(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
                f.write_str("a byte string")
            }
            fn visit_bytes<E: Error>(self, bytes: &[u8]) -> Result<Vec<u8>, E> {
                Ok(bytes.to_vec())
            }
            fn visit_byte_buf<E: Error>(self, bytes: Vec<u8>) -> Result<Vec<u8>, E> {
                Ok(bytes)
            }
        }
        deserializer.deserialize_bytes(ByteString)
    }
}

/// The placeholder a message carries while its preimage is built. Every
/// preimage reads only the identity fields, so it never feeds the bytes
/// signed.
const UNSIGNED: OperatorSignature = OperatorSignature::new([0; 64]);

fn sign(signer: &dyn Signer, message: &[u8]) -> Result<OperatorSignature, SignerError> {
    signer.try_sign(message).map(OperatorSignature::new)
}

/// Sign one operator's vote to settle a withdrawal `Paid`, over
/// [`VoteWithdrawalPaid::vote_message`].
///
/// # Errors
///
/// [`SignerError`] if the signing backend fails.
pub fn sign_vote_withdrawal_paid(
    signer: &dyn Signer,
    payout: PayoutIdentity,
    binding: BridgeBinding,
) -> Result<VoteWithdrawalPaid, SignerError> {
    let signature = sign(
        signer,
        &BridgeMessage::WithdrawalPaid { payout, binding }.preimage(),
    )?;
    Ok(paid_vote(payout, binding, signature))
}

/// Sign one operator's record of the Squads payout it proposed, over
/// [`RecordWithdrawalPayout::record_message`]. `binding.registry_epoch` is
/// the epoch the proposal was made under.
///
/// # Errors
///
/// [`SignerError`] if the signing backend fails.
pub fn sign_record_withdrawal_payout(
    signer: &dyn Signer,
    payout: PayoutIdentity,
    binding: BridgeBinding,
) -> Result<RecordWithdrawalPayout, SignerError> {
    let signature = sign(
        signer,
        &BridgeMessage::PayoutRecord { payout, binding }.preimage(),
    )?;
    Ok(payout_record(payout, binding, signature))
}

/// Sign one operator's vote that a recorded payout was rejected, so its
/// slot can be cleared, over [`VoteWithdrawalPayoutDead::vote_message`].
///
/// # Errors
///
/// [`SignerError`] if the signing backend fails.
pub fn sign_vote_withdrawal_payout_dead(
    signer: &dyn Signer,
    payout: PayoutIdentity,
    binding: BridgeBinding,
) -> Result<VoteWithdrawalPayoutDead, SignerError> {
    let signature = sign(
        signer,
        &BridgeMessage::WithdrawalPayoutDead { payout, binding }.preimage(),
    )?;
    Ok(dead_vote(payout, binding, signature))
}

/// Sign one operator's vote to credit one observed deposit, over
/// [`VoteDeposit::vote_message`]. Two operators voting on the same
/// observation sign identical bytes.
///
/// # Errors
///
/// [`SignerError`] if the signing backend fails.
pub fn sign_vote_deposit(
    signer: &dyn Signer,
    deposit: DepositObservation,
    binding: BridgeBinding,
) -> Result<VoteDeposit, SignerError> {
    let signature = sign(
        signer,
        &BridgeMessage::Deposit { deposit, binding }.preimage(),
    )?;
    Ok(deposit_vote(deposit, binding, signature))
}

/// Sign one operator's vote to pause the bridge, over
/// [`VotePauseBridge::vote_message`]. `signed_at_ms` is the Unix time in
/// milliseconds the operator signs at: the engine refuses a vote signed
/// before the bridge's last unpause or after the executing block.
///
/// # Errors
///
/// [`SignerError`] if the signing backend fails.
pub fn sign_vote_pause_bridge(
    signer: &dyn Signer,
    signed_at_ms: u64,
    binding: BridgeBinding,
) -> Result<VotePauseBridge, SignerError> {
    let signature = sign(
        signer,
        &BridgeMessage::PauseBridge {
            signed_at_ms,
            binding,
        }
        .preimage(),
    )?;
    Ok(pause_vote(signed_at_ms, binding, signature))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec;
    use crate::crypto;
    use crate::signer::LocalSigner;
    use ed25519_dalek::Verifier as _;

    const DEPLOYMENT: [u8; 32] = [0xA1; 32];
    const CHAIN: [u8; 32] = [0xC7; 32];
    const VAULT: [u8; 32] = [0xB2; 32];
    const DOMAIN: &[u8] = b"PROOF_BRIDGE_VOTE_V1";

    fn binding(epoch: u64) -> BridgeBinding {
        BridgeBinding {
            deployment_id: DeploymentId::new(DEPLOYMENT),
            chain_id: CHAIN,
            registry_epoch: RegistryEpoch::new(epoch),
        }
    }

    fn payout(withdrawal_id: u64, index: u32) -> PayoutIdentity {
        PayoutIdentity {
            withdrawal_id: WithdrawalId::new(withdrawal_id),
            vault: SolanaPubkey::new(VAULT),
            squads_transaction_index: index,
        }
    }

    fn deposit(locator: Option<DepositLocator>) -> DepositObservation {
        DepositObservation {
            owner: ProofOwner::new([0x11; 20]),
            amount: MicroUsdc::new(1_000_000),
            solana_tx_sig: TxSignature::new([0x22; 64]),
            locator,
        }
    }

    /// The documented payout layout: domain || kind || withdrawal id ||
    /// vault || transaction index || deployment || chain || epoch.
    fn payout_preimage(kind: u8, withdrawal_id: u64, index: u32, epoch: u64) -> Vec<u8> {
        let mut expected = DOMAIN.to_vec();
        expected.push(kind);
        expected.extend_from_slice(&withdrawal_id.to_be_bytes());
        expected.extend_from_slice(&VAULT);
        expected.extend_from_slice(&index.to_be_bytes());
        expected.extend_from_slice(&DEPLOYMENT);
        expected.extend_from_slice(&CHAIN);
        expected.extend_from_slice(&epoch.to_be_bytes());
        expected
    }

    fn verifies(seed: [u8; 32], message: &[u8], signature: &OperatorSignature) -> bool {
        ed25519_dalek::SigningKey::from_bytes(&seed)
            .verifying_key()
            .verify(
                message,
                &ed25519_dalek::Signature::from_bytes(signature.as_bytes()),
            )
            .is_ok()
    }

    #[test]
    fn the_payout_messages_sign_their_documented_preimages() {
        let seed = [0x42u8; 32];
        let signer = LocalSigner::from_bytes(&seed);

        let paid = sign_vote_withdrawal_paid(&signer, payout(777, 11), binding(3))
            .expect("sign the paid vote");
        assert_eq!(paid.vote_message(), payout_preimage(1, 777, 11, 3));
        assert!(verifies(seed, &paid.vote_message(), &paid.signature));

        let dead = sign_vote_withdrawal_payout_dead(&signer, payout(8, 13), binding(4))
            .expect("sign the dead vote");
        assert_eq!(dead.vote_message(), payout_preimage(4, 8, 13, 4));
        assert!(verifies(seed, &dead.vote_message(), &dead.signature));

        let record = sign_record_withdrawal_payout(&signer, payout(8, 13), binding(4))
            .expect("sign the payout record");
        assert_eq!(record.record_message(), payout_preimage(5, 8, 13, 4));
        assert!(verifies(seed, &record.record_message(), &record.signature));
        // The record and the dead vote name the same payout but are different
        // messages, so neither signature stands in for the other.
        assert_ne!(record.signature, dead.signature);
    }

    #[test]
    fn the_pause_vote_signs_its_signing_time() {
        let seed = [0x05u8; 32];
        let vote = sign_vote_pause_bridge(
            &LocalSigner::from_bytes(&seed),
            1_700_000_000_123,
            binding(2),
        )
        .expect("sign the pause vote");
        let mut expected = DOMAIN.to_vec();
        expected.push(6);
        expected.extend_from_slice(&1_700_000_000_123u64.to_be_bytes());
        expected.extend_from_slice(&DEPLOYMENT);
        expected.extend_from_slice(&CHAIN);
        expected.extend_from_slice(&2u64.to_be_bytes());
        assert_eq!(vote.vote_message(), expected);
        assert!(verifies(seed, &expected, &vote.signature));
    }

    #[test]
    fn deposit_vote_signature_verifies_and_the_locator_suffix_is_pinned() {
        let seed = [0x07u8; 32];
        let vote = sign_vote_deposit(
            &LocalSigner::from_bytes(&seed),
            deposit(Some(DepositLocator {
                top_index: 2,
                inner_index: Some(5),
            })),
            binding(9),
        )
        .expect("sign the deposit vote");
        // domain || kind(0x02) || owner(20) || amount(8 BE) || tx_sig(64) ||
        // locator(4: top BE, inner BE) || deployment || chain || epoch.
        let mut expected = DOMAIN.to_vec();
        expected.push(2);
        expected.extend_from_slice(&[0x11; 20]);
        expected.extend_from_slice(&1_000_000u64.to_be_bytes());
        expected.extend_from_slice(&[0x22; 64]);
        expected.extend_from_slice(&2u16.to_be_bytes());
        expected.extend_from_slice(&5u16.to_be_bytes());
        expected.extend_from_slice(&DEPLOYMENT);
        expected.extend_from_slice(&CHAIN);
        expected.extend_from_slice(&9u64.to_be_bytes());
        assert_eq!(vote.vote_message(), expected);
        assert!(verifies(seed, &expected, &vote.signature));
    }

    #[test]
    fn an_absent_locator_signs_the_legacy_suffix() {
        let signer = LocalSigner::from_bytes(&[0x09u8; 32]);
        let absent =
            sign_vote_deposit(&signer, deposit(None), binding(1)).expect("sign with no locator");
        let legacy = sign_vote_deposit(&signer, deposit(Some(DepositLocator::LEGACY)), binding(1))
            .expect("sign with the legacy locator");
        // None and the LEGACY locator are the same reading: identical
        // preimages, identical signatures.
        assert_eq!(absent.vote_message(), legacy.vote_message());
        assert_eq!(absent.signature, legacy.signature);
        let suffix_at = DOMAIN.len() + 1 + 20 + 8 + 64;
        assert_eq!(
            &legacy.vote_message()[suffix_at..suffix_at + 4],
            &[0, 0, 0xFF, 0xFF]
        );
    }

    #[test]
    fn signed_messages_round_trip_through_the_envelope_and_differ_per_item() {
        let seed = [0x33u8; 32];
        let signer = LocalSigner::from_bytes(&seed);
        let signing_key = ed25519_dalek::SigningKey::from_bytes(&seed);
        // `Action` carries no `PartialEq`; equal canonical bytes are the same
        // action field for field.
        let canonical =
            |a: &crate::types::Action| rmp_serde::to_vec(a).expect("an action always encodes");
        let round_trip = |action: crate::types::Action| {
            let wire = codec::sign_and_encode_with_chain(&CHAIN, &action, 1, &signing_key)
                .expect("a signed message encodes");
            let decoded = codec::decode_tx(&wire).expect("a signed message decodes");
            assert_eq!(canonical(&decoded.action), canonical(&action));
        };

        let paid =
            sign_vote_withdrawal_paid(&signer, payout(u64::MAX, u32::MAX), binding(u64::MAX))
                .expect("sign the paid vote");
        round_trip(crate::types::Action::VoteWithdrawalPaid(paid.clone()));
        round_trip(crate::types::Action::RecordWithdrawalPayout(
            sign_record_withdrawal_payout(&signer, payout(1, 2), binding(3))
                .expect("sign the payout record"),
        ));
        round_trip(crate::types::Action::VotePauseBridge(
            sign_vote_pause_bridge(&signer, u64::MAX, binding(3)).expect("sign the pause vote"),
        ));
        round_trip(crate::types::Action::VoteDeposit(
            sign_vote_deposit(
                &signer,
                DepositObservation {
                    amount: MicroUsdc::new(u64::MAX),
                    locator: Some(DepositLocator {
                        top_index: u16::MAX,
                        inner_index: None,
                    }),
                    ..deposit(None)
                },
                binding(u64::MAX),
            )
            .expect("sign the deposit vote"),
        ));

        // Deterministic: the same key and item sign identical bytes, and a
        // different withdrawal id cannot reuse them.
        let again =
            sign_vote_withdrawal_paid(&signer, payout(u64::MAX, u32::MAX), binding(u64::MAX))
                .expect("sign the paid vote again");
        assert_eq!(again.signature, paid.signature);
        let other = sign_vote_withdrawal_paid(&signer, payout(1, u32::MAX), binding(u64::MAX))
            .expect("sign another withdrawal's vote");
        assert_ne!(other.signature, paid.signature);
    }

    /// A vote's own signature never verifies as an envelope signature over
    /// the same payload: the domain separator keeps the two signature
    /// spaces disjoint.
    #[test]
    fn a_vote_signature_is_not_an_envelope_signature() {
        let seed = [0x42u8; 32];
        let signing_key = ed25519_dalek::SigningKey::from_bytes(&seed);
        let vote =
            sign_vote_withdrawal_paid(&LocalSigner::from_bytes(&seed), payout(1, 11), binding(1))
                .expect("sign the paid vote");
        let wire = codec::sign_and_encode_with_chain(
            &CHAIN,
            &crate::types::Action::VoteWithdrawalPaid(vote.clone()),
            1,
            &signing_key,
        )
        .expect("the vote encodes");
        let raw = codec::decode_tx_raw(&wire).expect("the envelope decodes");
        // The envelope path signs DOMAIN || chain || type || seq || payload;
        // the vote signature is over the bare vote preimage, so swapping the
        // conventions must fail closed.
        assert!(crypto::verify_signature(
            &CHAIN,
            &raw.pubkey,
            vote.signature.as_bytes(),
            raw.action_type,
            1,
            &raw.payload,
        )
        .is_err());
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
