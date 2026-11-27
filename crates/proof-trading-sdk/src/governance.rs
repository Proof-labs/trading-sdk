//! Admin-multisig governance actions — re-exported from `proof-wire`.
//!
//! These were formerly mirrored here field-for-field against the engine; they
//! now come from the single shared wire crate, so they cannot drift. The
//! admin-proposal content hash the SDK recomputes to verify approvals is the
//! engine's own `codec::admin_proposal_content_hash`.
//!
//! (These are privileged/admin actions; a future public-surface pass may hide
//! them behind the `proof-wire` visibility classifier.)

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
pub use proof_wire::market_settings::{
    MarketSettingsChange, MarketSettingsSequence, QuorumUpdateMarketFees,
};
pub use proof_wire::types::{
    AccountFeeOverrideChange, AdminAction, AdminActionType, AdminBatchItem, ApproveAdminAction,
    CancelUpgrade, ConfigureOraclePolicy, EmergencyAction, EmergencyActionType,
    EmergencyAdminAction, FundInsuranceFund, InsuranceFundAllocation, InsuranceFundingId,
    InsurancePoolId, InsuranceWithdrawalId, MarketStatus, ProposalId, ProposeAdminAction,
    RegistryVersion, RejectAdminAction, ScheduleUpgrade, SetMarketStatus, SetOracleGuards,
    SettleEvent, SignatureThreshold, SignerAddress, UpdateAdminSignerRegistry, VoidEvent,
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
        assert_eq!(AdminActionType::WithdrawInsuranceFund as u8, 25);
        assert_eq!(AdminActionType::VoidEvent as u8, 29);
        assert_eq!(AdminActionType::SettleEvent as u8, 30);
        assert_eq!(AdminActionType::SetMarketStatus as u8, 31);
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

#[cfg(test)]
mod update_market_fees_tests {
    use super::{
        AdminAction, AdminActionType, MarketSettingsChange, MarketSettingsSequence,
        ProposeAdminAction, QuorumUpdateMarketFees, RegistryVersion, SignerAddress,
    };
    use crate::signer::{sign_action, LocalSigner};
    use crate::types::Action;
    use crate::{codec, crypto};

    /// proof-wire's frozen `vectors/propose_update_market_fees.hex`, copied
    /// byte for byte: DevNet BTC (market 1) raises its open-interest cap to
    /// 35,000 at settings sequence 0, every other setting left as it is,
    /// proposed by `[0xA1; 20]` under registry version 1. Key `[0x42; 32]`
    /// signs it on the unbound chain at seq 400.
    const FROZEN: &str = include_str!("../../spec/golden-vectors/propose_update_market_fees.hex");

    fn change() -> MarketSettingsChange {
        MarketSettingsChange {
            market: 1,
            max_open_interest: Some(35_000),
            ..Default::default()
        }
    }

    fn proposal() -> ProposeAdminAction {
        ProposeAdminAction {
            proposer: SignerAddress([0xA1; 20]),
            registry_version: RegistryVersion(1),
            action: AdminAction::UpdateMarketFees(QuorumUpdateMarketFees {
                predecessor: MarketSettingsSequence(0),
                change: change(),
            }),
        }
    }

    #[test]
    fn update_market_fees_tag_preserves_the_wire_allocation() {
        assert_eq!(AdminActionType::UpdateMarketFees as u8, 35);
        assert_eq!(proposal().action.action_tag(), 35);
    }

    #[test]
    fn the_sdk_signs_the_frozen_proposal_byte_for_byte() {
        let wire = sign_action(
            &LocalSigner::from_bytes(&[0x42; 32]),
            &crypto::UNBOUND_CHAIN_ID,
            &Action::ProposeAdminAction(proposal()),
            400,
        )
        .expect("the proposal signs");
        assert_eq!(hex::encode(wire), FROZEN.trim());
    }

    #[test]
    fn the_frozen_proposal_decodes_to_its_inputs() {
        let bytes = hex::decode(FROZEN.trim()).expect("the vector is hex");
        assert_eq!(
            codec::peek_action_type(&bytes),
            Some(codec::ActionType::ProposeAdminAction as u8)
        );
        let decoded = codec::decode_tx(&bytes).expect("the frozen proposal decodes");
        assert_eq!(decoded.seq, 400);
        let Action::ProposeAdminAction(propose) = decoded.action else {
            panic!("expected a ProposeAdminAction, got {:?}", decoded.action);
        };
        assert_eq!(propose.proposer, SignerAddress([0xA1; 20]));
        assert_eq!(propose.registry_version, RegistryVersion(1));
        let AdminAction::UpdateMarketFees(quorum) = propose.action else {
            panic!("expected UpdateMarketFees, got {:?}", propose.action);
        };
        assert_eq!(quorum.predecessor, MarketSettingsSequence(0));
        assert_eq!(quorum.change, change());
    }
}

#[cfg(test)]
mod set_account_fee_override_tests {
    use super::{
        AccountFeeOverrideChange, AdminAction, AdminActionType, ProposeAdminAction,
        RegistryVersion, SignerAddress,
    };
    use crate::signer::{sign_action, LocalSigner};
    use crate::types::Action;
    use crate::{codec, crypto};

    /// proof-wire's frozen `vectors/propose_set_account_fee_override.hex`,
    /// copied byte for byte: account `[0xDD; 20]` gets a taker fee of 3 and a
    /// maker fee of 0 basis points, its first override (`seq` 1), proposed by
    /// `[0xA1; 20]` under registry version 1. Key `[0x42; 32]` signs it on the
    /// unbound chain at seq 500.
    const FROZEN: &str =
        include_str!("../../spec/golden-vectors/propose_set_account_fee_override.hex");

    fn change() -> AccountFeeOverrideChange {
        AccountFeeOverrideChange {
            account: [0xDD; 20],
            taker_fee_bps: 3,
            maker_fee_bps: 0,
            seq: 1,
        }
    }

    fn proposal() -> ProposeAdminAction {
        ProposeAdminAction {
            proposer: SignerAddress([0xA1; 20]),
            registry_version: RegistryVersion(1),
            action: AdminAction::SetAccountFeeOverride(change()),
        }
    }

    #[test]
    fn set_account_fee_override_tag_preserves_the_wire_allocation() {
        assert_eq!(AdminActionType::SetAccountFeeOverride as u8, 36);
        assert_eq!(proposal().action.action_tag(), 36);
    }

    #[test]
    fn the_sdk_signs_the_frozen_proposal_byte_for_byte() {
        let wire = sign_action(
            &LocalSigner::from_bytes(&[0x42; 32]),
            &crypto::UNBOUND_CHAIN_ID,
            &Action::ProposeAdminAction(proposal()),
            500,
        )
        .expect("the proposal signs");
        assert_eq!(hex::encode(wire), FROZEN.trim());
    }

    #[test]
    fn the_frozen_proposal_decodes_to_its_inputs() {
        let bytes = hex::decode(FROZEN.trim()).expect("the vector is hex");
        let decoded = codec::decode_tx(&bytes).expect("the frozen proposal decodes");
        assert_eq!(decoded.seq, 500);
        let Action::ProposeAdminAction(propose) = decoded.action else {
            panic!("expected a ProposeAdminAction, got {:?}", decoded.action);
        };
        assert_eq!(propose.proposer, SignerAddress([0xA1; 20]));
        assert_eq!(propose.registry_version, RegistryVersion(1));
        let AdminAction::SetAccountFeeOverride(decoded_change) = propose.action else {
            panic!("expected SetAccountFeeOverride, got {:?}", propose.action);
        };
        assert_eq!(decoded_change, change());
    }
}

#[cfg(test)]
mod set_liquidation_config_tests {
    use super::{
        admin_proposal_content_hash, canonical_admin_action_bytes, AdminAction, LiquidationConfig,
        ProposalId, RegistryVersion, SetLiquidationConfig, SignatureThreshold, SignerAddress,
    };
    use proof_wire::liquidation_config::{
        FullCloseThreshold, FundLimits, LiquidationConfigSequence, LiquidationPenaltyBps,
        LiquidationWorkCount, TakeoverDiscountBps, TargetRatioBps,
    };

    /// The configuration exchange-wire freezes in its own vector.
    fn update() -> AdminAction {
        AdminAction::SetLiquidationConfig(SetLiquidationConfig {
            predecessor: LiquidationConfigSequence(1),
            sequence: LiquidationConfigSequence(2),
            config: LiquidationConfig {
                target_ratio_bps: TargetRatioBps(10_500),
                full_close_threshold: FullCloseThreshold {
                    numerator: 2,
                    denominator: 3,
                },
                partial_penalty_bps: LiquidationPenaltyBps(100),
                max_book_orders: LiquidationWorkCount(20),
                max_committed_fills: LiquidationWorkCount(10),
                takeover_discount_bps: TakeoverDiscountBps::INITIAL,
                fund_limits: FundLimits::INITIAL,
            },
        })
    }

    #[test]
    fn set_liquidation_config_matches_the_frozen_wire_bytes() {
        // exchange-wire's `set_liquidation_config_bytes_are_positional_and_canonical`.
        assert_eq!(
            hex::encode(canonical_admin_action_bytes(&update()).expect("action encodes")),
            concat!(
                "81b45365744c69717569646174696f6e436f6e666967",
                "930102",
                "97cd29049202036414",
                "0a32",
                "92cd2710cd1388",
            )
        );
    }

    #[test]
    fn set_liquidation_config_matches_the_frozen_content_hash() {
        // The TypeScript and Python suites pin this same constant.
        let hash = admin_proposal_content_hash(
            &[0x11; 32],
            ProposalId(42),
            RegistryVersion(3),
            SignatureThreshold(2),
            &SignerAddress([0x22; 20]),
            7,
            1_000,
            259_201_000,
            &update(),
        )
        .expect("content hash");
        assert_eq!(
            hex::encode(hash),
            "9267b43a18d3eb0b50049821f466217f5b445a90309562e5037f4d3173a969ca"
        );
    }
}
