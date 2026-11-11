//! Node read-model (response) DTOs — re-exported from the shared `proof-wire`
//! crate so the SDK and the engine share one definition (no positional-wire
//! drift). Client representation that needs it wraps these.

pub use proof_wire::query::{
    AccountInfo, AccountStateInfo, BindingScenario, LevelSummary, OrderbookSnapshot, PositionBrief,
};
pub use proof_wire::query_v2::{AuthorizedAgents, AUTHORIZED_AGENTS_LIMIT};
pub use proof_wire::query_v2::{InsuranceFundDirectory, InsuranceFundLedger, InsuranceFundState};

/// Validate the canonical account binding using the wire's sole address derivation.
pub fn insurance_fund_owner_matches(fund: &InsuranceFundLedger) -> bool {
    use proof_wire::crypto::{derive_vault, Vault};
    fund.owner.0 == *derive_vault(Vault::Insurance(fund.pool_id)).as_bytes()
}
