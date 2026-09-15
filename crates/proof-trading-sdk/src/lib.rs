//! Rust core for the Proof trading SDK.
//!
//! The wire contract (MessagePack codec, Ed25519 signing preimage, action +
//! wire types, the admin content hash) lives in the shared `exchange-wire`
//! crate and is re-exported here, so the SDK uses the *same* codec as the
//! engine and cannot drift from it. The SDK owns only client representation:
//! the `signer` seam and the `errors` result-code decode, plus the `wire`
//! byte newtypes and `governance` re-exports.

pub use proof_wire::{abci_event, codec, crypto, triggers, types};

pub mod errors;
pub mod governance;
pub mod market_snapshot;
pub mod query;
pub mod signer;
pub mod wire;

pub use errors::{decode_exec_error_kind, error_code_manifest, DecodedExecErrorKind, ErrorKind};
pub use signer::{LocalSigner, Signer, SignerError};
