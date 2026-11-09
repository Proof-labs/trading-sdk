//! Admin-multisig governance actions — re-exported from `exchange-wire`.
//!
//! These were formerly mirrored here field-for-field against the engine; they
//! now come from the single shared wire crate, so they cannot drift. The
//! admin-proposal content hash the SDK recomputes to verify approvals is the
//! engine's own `codec::admin_proposal_content_hash`.
//!
//! (These are privileged/admin actions; a future public-surface pass may hide
//! them behind the `exchange-wire` visibility classifier.)

pub use proof_wire::codec::{
    admin_proposal_content_hash, canonical_admin_action_bytes, ADMIN_PROPOSAL_HASH_DOMAIN,
};
pub use proof_wire::liquidation_config::{LiquidationConfig, SetLiquidationConfig};
pub use proof_wire::types::{
    AdminAction, AdminActionType, AdminBatchItem, ApproveAdminAction, CancelUpgrade,
    ConfigureOraclePolicy, EmergencyAction, EmergencyActionType, EmergencyAdminAction,
    FundInsuranceFund, InsuranceFundAllocation, InsuranceFundingId, InsurancePoolId,
    InsuranceWithdrawalId, ProposalId, ProposeAdminAction, RegistryVersion, RejectAdminAction,
    ScheduleUpgrade, SetOracleGuards, SettleEvent, SignatureThreshold, SignerAddress,
    UpdateAdminSignerRegistry, VoidEvent, WithdrawInsuranceFund,
};

#[cfg(test)]
mod insurance_tag_tests {
    use super::AdminActionType;

    #[test]
    fn insurance_tags_preserve_existing_governance_allocations() {
        assert_eq!(AdminActionType::SetLiquidationConfig as u8, 17);
        assert_eq!(AdminActionType::FundInsuranceFund as u8, 18);
        assert_eq!(AdminActionType::SetOperatorReceiptRegistry as u8, 20);
        assert_eq!(AdminActionType::WithdrawInsuranceFund as u8, 25);
        assert_eq!(AdminActionType::VoidEvent as u8, 29);
        assert_eq!(AdminActionType::SettleEvent as u8, 30);
    }
}
