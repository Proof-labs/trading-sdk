//! Rust core for the Proof trading SDK.
//!
//! Extracted from `exchange-core` (codec, signing, and wire types) so the same
//! audited encoding/signing logic backs every binding. Engine-side modules
//! (matching, margin, state store) were intentionally left behind.

mod abci_event;
pub mod codec;
pub mod crypto;
pub mod governance;
pub mod signer;
mod state;
pub mod types;
pub mod wire;

pub use signer::{LocalSigner, Signer, SignerError};
