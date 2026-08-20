//! Admin-multisig governance actions (mirror of `exchange-core`).
//!
//! These four transaction actions carry the on-chain admin-multisig
//! primitive to first-party clients: `ProposeAdminAction` (0x1E),
//! `ApproveAdminAction` (0x1F), `RejectAdminAction` (0x20), and the
//! single-signer `EmergencyAdminAction` (0x21). The wire format is defined
//! by the engine; every type here mirrors the engine's `types.rs` field for
//! field, including its exact `serde` derives, so `rmp_serde` reproduces the
//! engine's bytes. The `content_hash` an approval commits to is the engine's
//! domain-separated §2.4 digest — reproduced here so the SDK can recompute
//! and verify it rather than trust a server-supplied value. The
//! [`tests::content_hash_matches_engine_golden_vectors`] test pins byte
//! equality against the engine's own golden vectors.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::types::{CreateImpactMarket, CreateMarket, ExecError, MarketId, SetTriggerMarketConfig};

/// Domain separator folded into every admin-proposal content hash.
/// Byte-identical to `exchange-core`'s `ADMIN_PROPOSAL_HASH_DOMAIN`.
pub const ADMIN_PROPOSAL_HASH_DOMAIN: &[u8] = b"PROOF_ADMIN_PROPOSAL_V1";

/// Monotone proposal identifier assigned by the engine.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct ProposalId(pub u64);

/// Monotone, non-reusable admin-signer-registry version.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct RegistryVersion(pub u64);

/// 20-byte admin signer address. Encodes as a bare `[u8; 20]` (a MessagePack
/// array of 20 integers, NOT a `bin`) — matching the engine's plain derive,
/// which is why it is a distinct type from the SDK's `Address`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct SignerAddress(pub [u8; 20]);

/// Number of member approvals required to execute an admin proposal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct SignatureThreshold(pub u32);

/// Replacement signer roster. The engine assigns the next registry version.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UpdateAdminSignerRegistry {
    /// Approvals the replacement roster will require.
    pub new_threshold: SignatureThreshold,
    /// Members of the replacement roster (canonically sorted, duplicate-free
    /// — validated on-chain, not here).
    pub new_members: Vec<SignerAddress>,
}

/// Closed, typed set of operations executable through the multisig.
/// The embedded `CreateMarket.signer` must be zero: governance supplies the
/// authorization, not the embedded address.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum AdminAction {
    /// Create a market under multisig authorization.
    CreateMarket(CreateMarket),
    /// Replace the admin signer roster and threshold.
    UpdateAdminSignerRegistry(UpdateAdminSignerRegistry),
    /// Create an impact-market family (4 child books) under multisig
    /// authorization. Same rule as `CreateMarket`: the embedded signer must
    /// be all-zero. Admitted by the engine from its admin-actions-v2
    /// activation height.
    CreateImpactMarket(CreateImpactMarket),
    /// 2–4 market-creation actions executed sequentially in one child
    /// overlay: the whole batch lands atomically and a later item may
    /// reference state an earlier item created (canonically: a family whose
    /// underlying perp is born in the same proposal). The item type is
    /// deliberately closed and non-recursive — a nested batch or a registry
    /// change inside a batch is undecodable, mirroring the engine.
    Batch(Vec<AdminBatchItem>),
    /// Replace one standalone-perpetual market's trigger policy. The engine
    /// admits this arm only after the trigger-index activation gate.
    SetTriggerMarketConfig(SetTriggerMarketConfig),
}

/// The closed set of actions a `Batch` may carry: market creations only.
/// Mirrors the engine's `AdminBatchItem` byte for byte (externally tagged
/// variant names identical to the corresponding `AdminAction` arms, so
/// valid batch wire bytes are the same under either shape).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum AdminBatchItem {
    /// Same rules as the singleton arm: all-zero inner signer.
    CreateMarket(CreateMarket),
    /// Same rules as the singleton arm: all-zero inner signer.
    CreateImpactMarket(CreateImpactMarket),
}

/// Stable discriminant for [`AdminAction`], committed by the content hash.
/// Distinct from the outer transaction action-type namespace.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdminActionType {
    CreateMarket = 1,
    UpdateAdminSignerRegistry = 2,
    CreateImpactMarket = 3,
    Batch = 4,
    SetTriggerMarketConfig = 5,
}

impl AdminAction {
    /// Engine-owned tag committed by the proposal content hash.
    pub const fn action_type(&self) -> AdminActionType {
        match self {
            AdminAction::CreateMarket(_) => AdminActionType::CreateMarket,
            AdminAction::UpdateAdminSignerRegistry(_) => AdminActionType::UpdateAdminSignerRegistry,
            AdminAction::CreateImpactMarket(_) => AdminActionType::CreateImpactMarket,
            AdminAction::Batch(_) => AdminActionType::Batch,
            AdminAction::SetTriggerMarketConfig(_) => AdminActionType::SetTriggerMarketConfig,
        }
    }

    /// The single-byte tag folded into the content hash.
    pub const fn action_tag(&self) -> u8 {
        self.action_type() as u8
    }
}

/// Closed set of immediate, loss-reducing actions available to one signer.
/// Reverse transitions are intentionally absent and require multisig actions.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum EmergencyAction {
    PauseMarket { market_id: MarketId },
    HaltTrading {},
    SetReduceOnly { market_id: MarketId },
}

/// Stable discriminant for [`EmergencyAction`].
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EmergencyActionType {
    PauseMarket = 1,
    HaltTrading = 2,
    SetReduceOnly = 3,
}

impl EmergencyAction {
    pub const fn action_type(&self) -> EmergencyActionType {
        match self {
            EmergencyAction::PauseMarket { .. } => EmergencyActionType::PauseMarket,
            EmergencyAction::HaltTrading {} => EmergencyActionType::HaltTrading,
            EmergencyAction::SetReduceOnly { .. } => EmergencyActionType::SetReduceOnly,
        }
    }

    pub const fn action_tag(&self) -> u8 {
        self.action_type() as u8
    }
}

/// Signed governance proposal (action 0x1E). The proposer is verified against
/// the envelope signer on-chain.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProposeAdminAction {
    /// Address authorizing the proposal.
    pub proposer: SignerAddress,
    /// Registry version under which the proposal is submitted.
    pub registry_version: RegistryVersion,
    /// Admin operation proposed for multisig execution.
    pub action: AdminAction,
}

/// Signed governance approval (action 0x1F). Carries the complete immutable
/// proposal context so a signer commits to — and can independently render —
/// exactly what they approve, never an id+hash alone.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ApproveAdminAction {
    /// Address authorizing the approval.
    pub approver: SignerAddress,
    /// Identifier of the proposal being approved.
    pub proposal_id: ProposalId,
    /// Registry version captured when the proposal was created.
    pub registry_version: RegistryVersion,
    /// Required approval count captured when the proposal was created.
    pub threshold: SignatureThreshold,
    /// Address that created the proposal.
    pub proposer: SignerAddress,
    /// Block height at which the proposal was created.
    pub created_height: u64,
    /// Block timestamp at which the proposal was created, in milliseconds.
    pub created_ms: u64,
    /// Block timestamp after which the proposal expires, in milliseconds.
    pub expiry_ms: u64,
    /// Typed admin operation being approved.
    pub action: AdminAction,
    /// Domain-separated commitment to the immutable proposal context.
    pub content_hash: [u8; 32],
}

/// Signed governance rejection (action 0x20).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RejectAdminAction {
    /// Address authorizing the rejection.
    pub rejecter: SignerAddress,
    /// Identifier of the proposal being rejected.
    pub proposal_id: ProposalId,
    /// Domain-separated commitment of the proposal being rejected.
    pub content_hash: [u8; 32],
}

/// Signed single-signer emergency action (action 0x21). The signer must be a
/// current registry member; the engine enforces the closed emergency arm set.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EmergencyAdminAction {
    /// Registry member authorizing the action.
    pub signer: SignerAddress,
    /// Immediate loss-reducing operation to execute.
    pub action: EmergencyAction,
}

/// Canonical MessagePack bytes of an admin action — the exact bytes the
/// engine commits inside the content hash. Mirrors
/// `exchange-core::codec::canonical_admin_action_bytes`.
pub fn canonical_admin_action_bytes(action: &AdminAction) -> Result<Vec<u8>, ExecError> {
    rmp_serde::to_vec(action).map_err(|e| ExecError::DecodeError(e.to_string()))
}

/// Domain-separated commitment for an admin proposal — byte-identical to
/// `exchange-core::codec::admin_proposal_content_hash`:
///
/// ```text
/// sha256( "PROOF_ADMIN_PROPOSAL_V1" || chain_id(32) || proposal_id(8 BE) ||
///         registry_version(8 BE) || threshold(4 BE) || proposer(20) ||
///         created_height(8 BE) || created_ms(8 BE) || expiry_ms(8 BE) ||
///         action_tag(1) || canonical_action_len(4 BE) || canonical_action_bytes )
/// ```
#[allow(clippy::too_many_arguments)]
pub fn admin_proposal_content_hash(
    chain_id: &[u8; 32],
    proposal_id: ProposalId,
    registry_version: RegistryVersion,
    threshold: SignatureThreshold,
    proposer: &SignerAddress,
    created_height: u64,
    created_ms: u64,
    expiry_ms: u64,
    action: &AdminAction,
) -> Result<[u8; 32], ExecError> {
    let action_bytes = canonical_admin_action_bytes(action)?;
    let len = u32::try_from(action_bytes.len()).map_err(|_| ExecError::Overflow)?;
    let mut h = Sha256::new();
    h.update(ADMIN_PROPOSAL_HASH_DOMAIN);
    h.update(chain_id);
    h.update(proposal_id.0.to_be_bytes());
    h.update(registry_version.0.to_be_bytes());
    h.update(threshold.0.to_be_bytes());
    h.update(proposer.0);
    h.update(created_height.to_be_bytes());
    h.update(created_ms.to_be_bytes());
    h.update(expiry_ms.to_be_bytes());
    h.update([action.action_tag()]);
    h.update(len.to_be_bytes());
    h.update(&action_bytes);
    Ok(h.finalize().into())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::types::{
        TriggerBracketLimit, TriggerConfigVersion, TriggerFutureSkewMs, TriggerMarkMaxAgeMs,
        TriggerSlippageBps,
    };

    /// Mirrors `exchange-core`'s `impl Default for CreateMarket` exactly — the
    /// same instance the engine's golden-vector test hashes. The non-zero fee /
    /// funding defaults are load-bearing: the content hash commits the full
    /// canonical bytes, so any drift here fails the golden assertion below.
    fn engine_default_create_market() -> CreateMarket {
        CreateMarket {
            market: 0,
            im_bps: 3334,
            mm_bps: 1667,
            taker_fee_bps: 5,
            maker_fee_bps: 2,
            signer: crate::wire::Address([0u8; 20]),
            funding_interval_ms: 60_000,
            max_funding_rate_bps: 3000,
            pool_id: 0,
            sz_decimals: 0,
            ticker: String::new(),
            max_open_interest: 0,
        }
    }

    fn hex_string(b: &[u8]) -> String {
        hex::encode(b)
    }

    /// Byte-for-byte pin against `exchange-core`'s
    /// `admin_proposal_content_hash_golden_vectors`. If the SDK's action
    /// encoding or hash preimage drifts from the engine, these fail.
    #[test]
    fn content_hash_matches_engine_golden_vectors() {
        let create = AdminAction::CreateMarket(engine_default_create_market());

        let h1 = admin_proposal_content_hash(
            &[0x11; 32],
            ProposalId(42),
            RegistryVersion(3),
            SignatureThreshold(2),
            &SignerAddress([0x22; 20]),
            7,
            1_000,
            259_201_000,
            &create,
        )
        .unwrap();
        assert_eq!(
            hex_string(&h1),
            "6cdd8d6843bb4026d396b9e80c9599530b0ac4f14862af0204794219f8f8cbea"
        );

        // One-field sensitivity: registry_version 3 → 4 changes the hash.
        let h2 = admin_proposal_content_hash(
            &[0x11; 32],
            ProposalId(42),
            RegistryVersion(4),
            SignatureThreshold(2),
            &SignerAddress([0x22; 20]),
            7,
            1_000,
            259_201_000,
            &create,
        )
        .unwrap();
        assert_eq!(
            hex_string(&h2),
            "5fe2dd718a4aea63492a5ab95eee27588cc861c504643bf68ce3fdd2c45dab99"
        );
        assert_ne!(h1, h2);
    }

    /// The v2 impact fixture from `exchange-core`'s
    /// `admin_action_v2_wire_vectors_frozen` / `…_v2_golden_vectors` — same
    /// instance, field for field, or the pins below cannot match.
    fn engine_v2_impact() -> CreateImpactMarket {
        CreateImpactMarket {
            impact_market_id: 91,
            underlying_market: 15,
            child_market_base: 9_100,
            question: "does it land?".into(),
            deadline_ms: 1_000_000,
            resolution_window_ms: 1_000,
            im_bps: 3334,
            mm_bps: 1667,
            taker_fee_bps: 5,
            maker_fee_bps: 2,
            funding_interval_ms: 0,
            max_funding_rate_bps: 3000,
            signer: crate::wire::Address([0u8; 20]),
            oracle_source: None,
            description: String::new(),
            rules: String::new(),
        }
    }

    fn engine_v2_batch() -> AdminAction {
        AdminAction::Batch(vec![
            AdminBatchItem::CreateMarket(CreateMarket {
                market: 15,
                ..engine_default_create_market()
            }),
            AdminBatchItem::CreateImpactMarket(engine_v2_impact()),
        ])
    }

    /// Byte-for-byte pins against the engine's admin-actions-v2 vectors:
    /// the canonical wire bytes AND the content hashes for the two new
    /// arms (tags 3 and 4), same proposal context as the vectors above.
    #[test]
    fn v2_arms_match_engine_golden_vectors() {
        let impact = AdminAction::CreateImpactMarket(engine_v2_impact());
        assert_eq!(impact.action_tag(), 3);
        assert_eq!(
            hex_string(&canonical_admin_action_bytes(&impact).unwrap()),
            "81b2437265617465496d706163744d61726b6574dc00105b0fcd238cad646f6573206974206c616e643fce000f4240cd03e8cd0d06cd0683050200cd0bb8dc00140000000000000000000000000000000000000000c0a0a0"
        );

        let batch = engine_v2_batch();
        assert_eq!(batch.action_tag(), 4);
        assert_eq!(
            hex_string(&canonical_admin_action_bytes(&batch).unwrap()),
            "81a542617463689281ac4372656174654d61726b65749c0fcd0d06cd06830502dc00140000000000000000000000000000000000000000cdea60cd0bb80000a00081b2437265617465496d706163744d61726b6574dc00105b0fcd238cad646f6573206974206c616e643fce000f4240cd03e8cd0d06cd0683050200cd0bb8dc00140000000000000000000000000000000000000000c0a0a0"
        );

        for (action, expected) in [
            (
                &impact,
                "d57a7faa3a17aac647a0256c38f125f6bd0913d70013e185aeb322efaab9629e",
            ),
            (
                &batch,
                "f9a9b17a53b52ad72c1703b583a0ed4ac70295244cbf31f74518d5177dd86e36",
            ),
        ] {
            let h = admin_proposal_content_hash(
                &[0x11; 32],
                ProposalId(42),
                RegistryVersion(3),
                SignatureThreshold(2),
                &SignerAddress([0x22; 20]),
                7,
                1_000,
                259_201_000,
                action,
            )
            .unwrap();
            assert_eq!(hex_string(&h), expected);
        }
    }

    /// Literal engine vector for admin-action tag 0x05.
    #[test]
    fn trigger_market_config_matches_engine_golden_vector() {
        let action = AdminAction::SetTriggerMarketConfig(SetTriggerMarketConfig {
            market: 7,
            expected_current_version: Some(TriggerConfigVersion(3)),
            enabled: true,
            max_trigger_slippage_bps: TriggerSlippageBps(250),
            max_mark_age_ms: TriggerMarkMaxAgeMs(5_000),
            max_future_publish_skew_ms: TriggerFutureSkewMs(1_000),
            max_active_brackets: TriggerBracketLimit(32),
        });
        assert_eq!(action.action_tag(), 0x05);
        assert_eq!(
            hex_string(&canonical_admin_action_bytes(&action).unwrap()),
            "81b6536574547269676765724d61726b6574436f6e666967970703c3ccfacd1388cd03e820"
        );
        let hash = admin_proposal_content_hash(
            &[0x11; 32],
            ProposalId(42),
            RegistryVersion(3),
            SignatureThreshold(2),
            &SignerAddress([0x22; 20]),
            7,
            1_000,
            259_201_000,
            &action,
        )
        .unwrap();
        assert_eq!(
            hex_string(&hash),
            "c707537e8d050389a705df1ce0aa2ad1cf873e67d1c45d10a955dde9b50e933c"
        );
    }

    /// Every governance action round-trips through the same wire codec the
    /// engine and gateway use.
    #[test]
    fn governance_actions_round_trip() {
        let propose = ProposeAdminAction {
            proposer: SignerAddress([1u8; 20]),
            registry_version: RegistryVersion(1),
            action: AdminAction::UpdateAdminSignerRegistry(UpdateAdminSignerRegistry {
                new_threshold: SignatureThreshold(2),
                new_members: vec![SignerAddress([0xA1; 20]), SignerAddress([0xA2; 20])],
            }),
        };
        let bytes = rmp_serde::to_vec(&propose).unwrap();
        let back: ProposeAdminAction = rmp_serde::from_slice(&bytes).unwrap();
        assert_eq!(back.registry_version, propose.registry_version);
    }
}
