//! Rust core for the Proof trading SDK: the MessagePack wire codec, Ed25519
//! signing and the action and read types, byte-identical to the exchange
//! engine.
//!
//! The wire contract (codec, signing preimage, `Action` and every payload, the
//! admin content hash) lives in the shared [`proof-wire`] crate and is
//! re-exported here as [`types`], [`codec`] and [`crypto`], so the SDK encodes
//! with the *same* code as the engine and cannot drift from it. This crate owns
//! only the client side: the [`signer`] seam, the result-code decode in
//! [`errors`], read decoding in [`reads`], and helpers such as [`binary`] and
//! [`ticker`].
//!
//! The default build has no network, async runtime or I/O, and it compiles to
//! `wasm32-unknown-unknown`. The TypeScript (WASM) and Python (PyO3) SDKs are
//! bindings over it. The opt-in `gateway` feature adds a bounded native
//! transport, `gateway::GatewayClient`.
//!
//! # Sign an order
//!
//! ```
//! use ed25519_dalek::SigningKey;
//! use proof_trading_sdk::{codec, crypto, types::{Action, PlaceOrder, Side}};
//!
//! let key = SigningKey::from_bytes(&[7u8; 32]);
//! let owner = crypto::pubkey_to_owner(&key.verifying_key().to_bytes());
//! let chain_id = crypto::chain_id_from_string("exchange-devnet-1");
//!
//! let action = Action::PlaceOrder(PlaceOrder {
//!     market: 1,
//!     owner,
//!     side: Side::Buy,
//!     price: 66_750_000_000, // micro-USDC: $66,750
//!     quantity: 1,           // 1 unit = 10^-sz_decimals of the base asset
//!     post_only: true,
//!     ..Default::default()
//! });
//!
//! // `seq` is a wall-clock-millisecond timestamp nonce, one per signature.
//! // `ExecError` is `Display`, not `std::error::Error`.
//! let wire = codec::sign_and_encode_with_chain(&chain_id, &action, 1_762_000_000_000, &key)
//!     .map_err(|e| e.to_string())?;
//! let decoded = codec::decode_tx(&wire).map_err(|e| e.to_string())?;
//! assert_eq!(decoded.seq, 1_762_000_000_000);
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
//!
//! # Units
//!
//! Money is integer micro-USDC (6 dp, `1_000_000` = $1): `u64` for prices and
//! deposits, `i64` where it can be negative (fee amounts, equity, funding
//! index). `quantity` is an integer count of `10^-sz_decimals` base units (see
//! `MarketConfig::sz_decimals`), a multiple of `lot_size`; `price` is a
//! multiple of `tick_size`. Fee and margin rates are basis points. Nothing on
//! the wire is a float.

//!
//! [`proof-wire`]: https://github.com/Proof-labs/wire

pub use proof_wire::{
    abci_event, bridge, codec, crypto, liquidation_config, liquidation_progress,
    liquidation_report, triggers, types,
};

pub mod binary;
pub mod errors;
#[cfg(feature = "gateway")]
pub mod gateway;
pub mod governance;
pub mod governance_reads;
pub mod market_snapshot;
pub mod msgpack;
pub mod query;
pub mod reads;
pub mod signer;
pub mod ticker;
pub mod wire;

pub use errors::{decode_exec_error_kind, error_code_manifest, DecodedExecErrorKind, ErrorKind};
pub use signer::{LocalSigner, Signer, SignerError};
