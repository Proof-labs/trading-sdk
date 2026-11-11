//! Node read-model (response) DTOs — re-exported from the shared `proof-wire`
//! crate so the SDK and the engine share one definition (no positional-wire
//! drift). Client representation that needs it wraps these.

pub use proof_wire::query::{
    AccountInfo, AccountStateInfo, BindingScenario, LevelSummary, OrderbookSnapshot, PositionBrief,
};
