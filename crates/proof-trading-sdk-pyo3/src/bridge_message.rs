//! Bridge-operator messages from Python: the fields arrive as a dict tagged by
//! `kind`, every byte field is length-checked, and the preimage is the core's
//! [`BridgeMessage::preimage`], the wire contract's bytes.

use core_sdk::bridge::{
    DeploymentId, MicroUsdc, ProofOwner, RegistryEpoch, SolanaPubkey, TxSignature, WithdrawalId,
};
use core_sdk::bridge_votes::{BridgeBinding, BridgeMessage, DepositObservation, PayoutIdentity};
use core_sdk::types::DepositLocator;
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use serde::Deserialize;

#[derive(Deserialize)]
struct LocatorInput {
    top_index: u16,
    inner_index: Option<u16>,
}

/// One message, with the snake_case field names of the Python dataclasses.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum BridgeMessageInput {
    WithdrawalPaid(PayoutInput),
    WithdrawalPayoutDead(PayoutInput),
    PayoutRecord(PayoutInput),
    Deposit {
        #[serde(with = "serde_bytes")]
        owner: Vec<u8>,
        amount_micro_usdc: u64,
        #[serde(with = "serde_bytes")]
        solana_tx_sig: Vec<u8>,
        locator: Option<LocatorInput>,
        #[serde(flatten)]
        binding: BindingInput,
    },
    PauseBridge {
        signed_at_ms: u64,
        #[serde(flatten)]
        binding: BindingInput,
    },
}

#[derive(Deserialize)]
struct PayoutInput {
    withdrawal_id: u64,
    #[serde(with = "serde_bytes")]
    vault: Vec<u8>,
    squads_transaction_index: u32,
    #[serde(flatten)]
    binding: BindingInput,
}

#[derive(Deserialize)]
struct BindingInput {
    #[serde(with = "serde_bytes")]
    deployment_id: Vec<u8>,
    #[serde(with = "serde_bytes")]
    chain_id: Vec<u8>,
    registry_epoch: u64,
}

fn exact<const N: usize>(bytes: &[u8], name: &str) -> PyResult<[u8; N]> {
    bytes
        .try_into()
        .map_err(|_| PyValueError::new_err(format!("{name} must be exactly {N} bytes")))
}

impl BindingInput {
    fn checked(&self) -> PyResult<BridgeBinding> {
        Ok(BridgeBinding {
            deployment_id: DeploymentId::new(exact(&self.deployment_id, "deployment_id")?),
            chain_id: exact(&self.chain_id, "chain_id")?,
            registry_epoch: RegistryEpoch::new(self.registry_epoch),
        })
    }
}

impl PayoutInput {
    fn checked(&self) -> PyResult<(PayoutIdentity, BridgeBinding)> {
        Ok((
            PayoutIdentity {
                withdrawal_id: WithdrawalId::new(self.withdrawal_id),
                vault: SolanaPubkey::new(exact(&self.vault, "vault")?),
                squads_transaction_index: self.squads_transaction_index,
            },
            self.binding.checked()?,
        ))
    }
}

/// Parse and check a Python dict into the core's message.
pub(crate) fn from_py(fields: &Bound<'_, PyAny>) -> PyResult<BridgeMessage> {
    let input: BridgeMessageInput = pythonize::depythonize(fields)
        .map_err(|e| PyValueError::new_err(format!("bridge message: {e}")))?;
    Ok(match input {
        BridgeMessageInput::WithdrawalPaid(p) => {
            let (payout, binding) = p.checked()?;
            BridgeMessage::WithdrawalPaid(payout, binding)
        }
        BridgeMessageInput::WithdrawalPayoutDead(p) => {
            let (payout, binding) = p.checked()?;
            BridgeMessage::WithdrawalPayoutDead(payout, binding)
        }
        BridgeMessageInput::PayoutRecord(p) => {
            let (payout, binding) = p.checked()?;
            BridgeMessage::PayoutRecord(payout, binding)
        }
        BridgeMessageInput::Deposit {
            owner,
            amount_micro_usdc,
            solana_tx_sig,
            locator,
            binding,
        } => BridgeMessage::Deposit(
            DepositObservation {
                owner: ProofOwner::new(exact(&owner, "owner")?),
                amount: MicroUsdc::new(amount_micro_usdc),
                solana_tx_sig: TxSignature::new(exact(&solana_tx_sig, "solana_tx_sig")?),
                locator: locator.map(|l| DepositLocator {
                    top_index: l.top_index,
                    inner_index: l.inner_index,
                }),
            },
            binding.checked()?,
        ),
        BridgeMessageInput::PauseBridge {
            signed_at_ms,
            binding,
        } => BridgeMessage::PauseBridge(signed_at_ms, binding.checked()?),
    })
}
