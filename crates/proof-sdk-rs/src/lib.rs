//! Async trading client for the Proof Exchange.
//!
//! A thin, tokio-based layer over the [`proof_trading_sdk`] core. The core does
//! the wire codec and signing, byte-identical to the engine. This crate adds
//! what a trading loop needs on top:
//!
//! - [`ExchangeClient`]: timestamp-nonce allocation, signing through any
//!   [`Signer`], one-shot submission, receipt waiting, and order helpers
//!   (place, cancel, amend, cancel-replace, market, close).
//! - [`InfoClient`]: typed reads for markets, events, the order book, an
//!   account, its open orders, the recent trade tape and recent nonces.
//! - `WsClient` (feature `ws`, on by default): the gateway's `/ws` feed of
//!   order books, trades and account events, with heartbeat, reconnect and
//!   signed account subscriptions.
//!
//! Every request goes through the API gateway; there is no direct-node path.
//! The core stays free of tokio and reqwest, so its wasm build is unaffected
//! by this crate.
//!
//! # Example
//!
//! ```no_run
//! use proof_sdk_rs::{ClientConfig, ExchangeClient, LocalSigner, Side};
//!
//! # async fn run() -> Result<(), proof_sdk_rs::Error> {
//! let seed = proof_sdk_rs::random_seed();
//! let client = ExchangeClient::connect(&ClientConfig::devnet(), LocalSigner::from_bytes(&seed)).await?;
//!
//! let book = client.info().orderbook(1).await?;
//! if let Some(bid) = book.best_bid() {
//!     let mut order = client.limit_order(1, Side::Buy, bid.price, 1);
//!     order.post_only = true;
//!     order.client_order_id = Some(7);
//!     let placed = client.place_order(order).await?;
//!     let order_id = placed.receipt().and_then(|r| r.order_id());
//!     println!("order {order_id:?} error {:?}", placed.error());
//!     client.cancel_client_order(7).await?;
//! }
//! # Ok(())
//! # }
//! ```
//!
//! # Units
//!
//! Prices and balances are `u64` micro-USDC (`1_000_000` = $1). Quantities are
//! integer contracts. Nothing is a float.

#[cfg(feature = "ws")]
mod account_event;
mod address;
mod error;
mod exchange;
mod info;
mod nonce;
#[cfg(feature = "ws")]
mod ws;

#[cfg(feature = "ws")]
pub use account_event::{
    AccountEvent, AccountEventKind, Deposited, Fill, FundingSettled, MarketOrderProcessed,
    OrderAmended, OrderCancelled, OrderPlaced, OrderRejected, PositionClosed, PositionUpdated,
};
pub use address::Address;
pub use error::{Error, Result};
pub use exchange::{
    EngineError, ExchangeClient, Receipt, RefusalReason, SignedTx, Submitted, TxStatus,
};
pub use info::{
    ChainStatus, ClientConfig, InfoClient, Level, Orderbook, Trade, DEVNET_CHAIN_ID,
    DEVNET_GATEWAY_URL,
};
pub use nonce::{NonceAllocator, MAX_CLOCK_LEAD_MS};
#[cfg(feature = "ws")]
pub use ws::{
    AccountAuth, Subscription, WsAccount, WsClient, WsConfig, WsMessage, WsReceiver, WsTrade,
};

/// The core crate, re-exported so callers need one dependency.
pub use proof_trading_sdk as core;
pub use proof_trading_sdk::gateway::{TxAttribute, TxEvent, TxHash};
pub use proof_trading_sdk::query::{AccountInfo, PositionBrief};
pub use proof_trading_sdk::types::{
    Action, CancelReplaceOrder, EventId, EventInfo, MarketConfig, MarketId, Order, OrderId,
    PlaceOrder, Side, TimeInForce,
};
pub use proof_trading_sdk::ErrorKind;
pub use proof_trading_sdk::{LocalSigner, Signer, SignerError};

/// 32 random bytes from the OS, for a fresh Ed25519 seed. Store it as
/// carefully as a private key; it is one.
#[must_use]
pub fn random_seed() -> zeroize::Zeroizing<[u8; 32]> {
    use rand_core::RngCore;
    let mut seed = zeroize::Zeroizing::new([0u8; 32]);
    rand_core::OsRng.fill_bytes(seed.as_mut());
    seed
}
