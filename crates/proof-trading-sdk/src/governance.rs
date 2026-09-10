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
pub use proof_wire::types::{
    AdminAction, AdminActionType, AdminBatchItem, ApproveAdminAction, EmergencyAction,
    EmergencyActionType, EmergencyAdminAction, ProposalId, ProposeAdminAction, RegistryVersion,
    RejectAdminAction, SignatureThreshold, SignerAddress, UpdateAdminSignerRegistry,
};
