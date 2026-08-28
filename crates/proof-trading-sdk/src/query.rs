//! Node read-model (response) DTOs — re-exported from the shared `exchange-wire`
//! crate so the SDK and the engine share one definition (no positional-wire
//! drift). Client representation that needs it wraps these.

pub use exchange_wire::query::{AccountInfo, ImpactMarketDisplayInfo, PositionBrief};
