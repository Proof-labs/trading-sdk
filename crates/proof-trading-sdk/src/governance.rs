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
pub use proof_wire::margin_offsets::{
    ConditionalMarket, MarginOffsetPair, MarginOffsetPairCount, MarginOffsetPairs,
    MarginOffsetPolicy, MarginOffsetSequence, OffsetPairIndex, OffsetResolutionTreatment,
    PartialOffsetBps, PerpetualMarket, SetMarginOffsetPolicy, SettlementReferenceMarket,
    MAX_MARGIN_OFFSET_PAIRS,
};
pub use proof_wire::types::{
    AdminAction, AdminActionType, AdminBatchItem, ApproveAdminAction, CancelUpgrade,
    ConfigureOraclePolicy, EmergencyAction, EmergencyActionType, EmergencyAdminAction,
    FundInsuranceFund, InsuranceFundAllocation, InsuranceFundingId, InsurancePoolId,
    InsuranceWithdrawalId, ProposalId, ProposeAdminAction, RegistryVersion, RejectAdminAction,
    ScheduleUpgrade, SetOracleGuards, SignatureThreshold, SignerAddress, UpdateAdminSignerRegistry,
    WithdrawInsuranceFund,
};

#[cfg(test)]
mod insurance_tag_tests {
    use super::AdminActionType;

    #[test]
    fn insurance_tags_preserve_existing_governance_allocations() {
        assert_eq!(AdminActionType::SetLiquidationConfig as u8, 17);
        assert_eq!(AdminActionType::FundInsuranceFund as u8, 18);
        assert_eq!(AdminActionType::SetOperatorReceiptRegistry as u8, 20);
        assert_eq!(AdminActionType::EnableSubAccounts as u8, 21);
        assert_eq!(AdminActionType::WithdrawInsuranceFund as u8, 25);
    }
}

#[cfg(test)]
mod margin_offset_tag_tests {
    use super::{
        admin_proposal_content_hash, canonical_admin_action_bytes, AdminAction, AdminActionType,
        ConditionalMarket, MarginOffsetPairs, OffsetResolutionTreatment, PartialOffsetBps,
        PerpetualMarket, ProposalId, RegistryVersion, SetMarginOffsetPolicy,
        SettlementReferenceMarket, SignatureThreshold, SignerAddress, MAX_MARGIN_OFFSET_PAIRS,
    };

    #[test]
    fn margin_offset_tag_preserves_the_wire_allocation() {
        assert_eq!(AdminActionType::SetMarginOffsetPolicy as u8, 27);
        let action = AdminAction::SetMarginOffsetPolicy(SetMarginOffsetPolicy {
            predecessor: None,
            pairs: MarginOffsetPairs::default(),
        });
        assert_eq!(action.action_tag(), 27);
    }

    #[test]
    fn margin_offset_capacity_matches_the_published_client_constant() {
        // `src/margin-offsets.ts` repeats this number for its own bound; a
        // wire change must break here before the copies can drift.
        assert_eq!(MAX_MARGIN_OFFSET_PAIRS, 52);
    }

    #[test]
    fn set_margin_offset_action_matches_the_frozen_wire_bytes() {
        let action = AdminAction::SetMarginOffsetPolicy(SetMarginOffsetPolicy {
            predecessor: None,
            pairs: MarginOffsetPairs::try_from(vec![partial_pair()]).expect("one canonical pair"),
        });
        assert_eq!(
            hex::encode(canonical_admin_action_bytes(&action).expect("action encodes")),
            "81b55365744d617267696e4f6666736574506f6c69637992c09195010201cd1388b252656d6f76654f6e5265736f6c7574696f6e"
        );
    }

    #[test]
    fn set_margin_offset_action_matches_the_frozen_content_hash() {
        // The TypeScript and Python suites pin this same constant, so an
        // approving client recomputes the hash the engine commits.
        let hash = admin_proposal_content_hash(
            &[0x11; 32],
            ProposalId(42),
            RegistryVersion(3),
            SignatureThreshold(2),
            &SignerAddress([0x22; 20]),
            7,
            1_000,
            259_201_000,
            &AdminAction::SetMarginOffsetPolicy(SetMarginOffsetPolicy {
                predecessor: None,
                pairs: MarginOffsetPairs::try_from(vec![partial_pair()]).expect("canonical pair"),
            }),
        )
        .expect("content hash");
        assert_eq!(
            hex::encode(hash),
            "40627a24b87270a4cb4e75a5396a5b9508ceac315d64872dac923087972a90b1"
        );
    }

    #[test]
    fn margin_offset_reexports_stay_wire_transparent() {
        // A newtype losing its transparent serde would change signed bytes.
        let bytes = rmp_serde::to_vec(&partial_pair()).expect("pair encodes");
        assert_eq!(
            hex::encode(&bytes),
            "95010201cd1388b252656d6f76654f6e5265736f6c7574696f6e"
        );
    }

    fn partial_pair() -> proof_wire::margin_offsets::MarginOffsetPair {
        proof_wire::margin_offsets::MarginOffsetPair {
            perpetual: PerpetualMarket(1),
            conditional: ConditionalMarket(2),
            settlement_reference: SettlementReferenceMarket(1),
            rate: PartialOffsetBps::try_from(5_000_u16).expect("5000 bps is a partial rate"),
            resolution: OffsetResolutionTreatment::RemoveOnResolution,
        }
    }
}
