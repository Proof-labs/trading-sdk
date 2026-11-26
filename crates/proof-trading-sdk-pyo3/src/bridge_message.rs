//! Bridge-operator messages from Python: the fields arrive as a dict tagged by
//! `kind`, byte fields must be `bytes`, an unknown key is refused, every byte
//! field is length-checked, and the preimage is the core's
//! [`BridgeMessage::preimage`], the wire contract's bytes.

use core_sdk::bridge::{
    DeploymentId, MicroUsdc, ProofOwner, RegistryEpoch, SolanaPubkey, TxSignature, WithdrawalId,
};
use core_sdk::bridge_votes::{
    strict_bytes, BridgeBinding, BridgeMessage, DepositObservation, PayoutIdentity,
};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LocatorInput {
    top_index: u16,
    #[serde(default)]
    inner_index: Option<u16>,
}

/// One message, with the snake_case field names of the Python dataclasses.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum BridgeMessageInput {
    WithdrawalPaid {
        withdrawal_id: u64,
        #[serde(deserialize_with = "strict_bytes::deserialize")]
        vault: Vec<u8>,
        squads_transaction_index: u32,
        #[serde(deserialize_with = "strict_bytes::deserialize")]
        deployment_id: Vec<u8>,
        #[serde(deserialize_with = "strict_bytes::deserialize")]
        chain_id: Vec<u8>,
        registry_epoch: u64,
        signed_at_ms: u64,
    },
    WithdrawalPayoutDead {
        withdrawal_id: u64,
        #[serde(deserialize_with = "strict_bytes::deserialize")]
        vault: Vec<u8>,
        squads_transaction_index: u32,
        #[serde(deserialize_with = "strict_bytes::deserialize")]
        deployment_id: Vec<u8>,
        #[serde(deserialize_with = "strict_bytes::deserialize")]
        chain_id: Vec<u8>,
        registry_epoch: u64,
        signed_at_ms: u64,
    },
    PayoutRecord {
        withdrawal_id: u64,
        #[serde(deserialize_with = "strict_bytes::deserialize")]
        vault: Vec<u8>,
        squads_transaction_index: u32,
        #[serde(deserialize_with = "strict_bytes::deserialize")]
        deployment_id: Vec<u8>,
        #[serde(deserialize_with = "strict_bytes::deserialize")]
        chain_id: Vec<u8>,
        registry_epoch: u64,
        signed_at_ms: u64,
    },
    Deposit {
        #[serde(deserialize_with = "strict_bytes::deserialize")]
        owner: Vec<u8>,
        amount_micro_usdc: u64,
        #[serde(deserialize_with = "strict_bytes::deserialize")]
        solana_tx_sig: Vec<u8>,
        #[serde(default)]
        locator: Option<LocatorInput>,
        #[serde(deserialize_with = "strict_bytes::deserialize")]
        deployment_id: Vec<u8>,
        #[serde(deserialize_with = "strict_bytes::deserialize")]
        chain_id: Vec<u8>,
        registry_epoch: u64,
        signed_at_ms: u64,
    },
    PauseBridge {
        #[serde(deserialize_with = "strict_bytes::deserialize")]
        deployment_id: Vec<u8>,
        #[serde(deserialize_with = "strict_bytes::deserialize")]
        chain_id: Vec<u8>,
        registry_epoch: u64,
        signed_at_ms: u64,
    },
}

fn exact<const N: usize>(bytes: &[u8], name: &str) -> PyResult<[u8; N]> {
    bytes
        .try_into()
        .map_err(|_| PyValueError::new_err(format!("{name} must be exactly {N} bytes")))
}

fn binding(
    deployment_id: &[u8],
    chain_id: &[u8],
    registry_epoch: u64,
    signed_at_ms: u64,
) -> PyResult<BridgeBinding> {
    Ok(BridgeBinding {
        deployment_id: DeploymentId::new(exact(deployment_id, "deployment_id")?),
        chain_id: exact(chain_id, "chain_id")?,
        registry_epoch: RegistryEpoch::new(registry_epoch),
        signed_at_ms,
    })
}

fn payout(
    withdrawal_id: u64,
    vault: &[u8],
    squads_transaction_index: u32,
) -> PyResult<PayoutIdentity> {
    Ok(PayoutIdentity {
        withdrawal_id: WithdrawalId::new(withdrawal_id),
        vault: SolanaPubkey::new(exact(vault, "vault")?),
        squads_transaction_index,
    })
}

/// Parse and check a Python dict into the core's message.
pub(crate) fn from_py(fields: &Bound<'_, PyAny>) -> PyResult<BridgeMessage> {
    let input: BridgeMessageInput = pythonize::depythonize(fields)
        .map_err(|e| PyValueError::new_err(format!("bridge message: {e}")))?;
    Ok(match input {
        BridgeMessageInput::WithdrawalPaid {
            withdrawal_id,
            vault,
            squads_transaction_index,
            deployment_id,
            chain_id,
            registry_epoch,
            signed_at_ms,
        } => BridgeMessage::WithdrawalPaid {
            payout: payout(withdrawal_id, &vault, squads_transaction_index)?,
            binding: binding(&deployment_id, &chain_id, registry_epoch, signed_at_ms)?,
        },
        BridgeMessageInput::WithdrawalPayoutDead {
            withdrawal_id,
            vault,
            squads_transaction_index,
            deployment_id,
            chain_id,
            registry_epoch,
            signed_at_ms,
        } => BridgeMessage::WithdrawalPayoutDead {
            payout: payout(withdrawal_id, &vault, squads_transaction_index)?,
            binding: binding(&deployment_id, &chain_id, registry_epoch, signed_at_ms)?,
        },
        BridgeMessageInput::PayoutRecord {
            withdrawal_id,
            vault,
            squads_transaction_index,
            deployment_id,
            chain_id,
            registry_epoch,
            signed_at_ms,
        } => BridgeMessage::PayoutRecord {
            payout: payout(withdrawal_id, &vault, squads_transaction_index)?,
            binding: binding(&deployment_id, &chain_id, registry_epoch, signed_at_ms)?,
        },
        BridgeMessageInput::Deposit {
            owner,
            amount_micro_usdc,
            solana_tx_sig,
            locator,
            deployment_id,
            chain_id,
            registry_epoch,
            signed_at_ms,
        } => BridgeMessage::Deposit {
            deposit: DepositObservation {
                owner: ProofOwner::new(exact(&owner, "owner")?),
                amount: MicroUsdc::new(amount_micro_usdc),
                solana_tx_sig: TxSignature::new(exact(&solana_tx_sig, "solana_tx_sig")?),
                locator: locator
                    .map(|l| DepositObservation::checked_locator(l.top_index, l.inner_index))
                    .transpose()
                    .map_err(PyValueError::new_err)?,
            },
            binding: binding(&deployment_id, &chain_id, registry_epoch, signed_at_ms)?,
        },
        BridgeMessageInput::PauseBridge {
            deployment_id,
            chain_id,
            registry_epoch,
            signed_at_ms,
        } => BridgeMessage::PauseBridge {
            binding: binding(&deployment_id, &chain_id, registry_epoch, signed_at_ms)?,
        },
    })
}
