//! Node read-model (response) DTOs — re-exported from the shared `exchange-wire`
//! crate so the SDK and the engine share one definition (no positional-wire
//! drift). Client representation that needs it wraps these.

pub use proof_wire::query::{AccountInfo, BindingScenario, PositionBrief};

/// Per-position liquidation price surface (µUSDC). Pairs with the exchange
/// `PositionBrief.liquidation_price` wire field; `None` for conditional-perp,
/// binary, or ambiguous cross-margin positions. WIP: returns `None` until the
/// wire bump lands and the engine populates it.
pub fn position_liquidation_price(_pos: &PositionBrief) -> Option<u64> {
    None
}
