//! Async trading client for the Proof Exchange.
//!
//! A thin, tokio-based layer over the [`proof_trading_sdk`] core. The core does
//! the wire codec and signing, byte-identical to the engine. This crate adds
//! what a trading loop needs on top:
//!
//! - [`ExchangeClient`]: timestamp-nonce allocation, signing through any
//!   [`Signer`], one-shot submission, receipt waiting, and helpers for
//!   orders (place and cancel, one or a list of up to 100, amend,
//!   cancel-replace, market, close, No on a binary book), position triggers,
//!   agents, sub-accounts, withdrawals and baskets.
//! - [`actions`]: the same actions as plain values, for callers that sign and
//!   send them themselves.
//! - [`InfoClient`]: typed reads for markets, events, the order book, an
//!   account, its open orders, the recent trade tape, recent nonces, funding,
//!   position triggers, sub-accounts, withdrawals, agents and the indexed
//!   history.
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
//!     println!("{:?} error {:?}", placed.receipt().map(|r| &r.events), placed.error());
//!     client.cancel_order_by_client_id(7).await?;
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
pub mod actions;
mod address;
mod error;
mod event;
mod exchange;
mod history;
mod ids;
mod info;
mod nonce;
mod state;
#[cfg(feature = "ws")]
mod ws;

#[cfg(feature = "ws")]
pub use account_event::AccountEvent;
pub use address::Address;
pub use error::{Error, Result};
pub use event::{
    CancelReason, ConditionMet, ConditionNotMet, ConversionFallbackReason, Deposited, Event,
    EventResolved, Fill, FundingSettled, MarketOrderProcessed, OrderAmended, OrderCancellation,
    OrderCancelled, OrderPlaced, OrderPlacement, OrderRejected, OrdersCancelled, OrdersPlaced,
    PlacementOutcome, PositionClosed, PositionTriggersInvalidated, PositionUpdated,
    PredictionSettled, TriggerInvalidation, UnfilledReason,
};
pub use exchange::{
    CloseOutcome, EngineError, ExchangeClient, Receipt, RefusalReason, SignedTx, Submitted,
    TxStatus,
};
pub use history::{
    AccountEventsQuery, BboCandle, Candle, CandlePage, CandleQuery, CandleResolution, CandleUnit,
    Conversion, Decimal, FundingPayment, HistoryEvent, HistoryFill, HistoryInterval, HistoryPage,
    HistoryQuery, IntervalUnit, OrderHistoryQuery, PositionSnapshot, Resolution, ResolutionOutcome,
    ResolutionsQuery, SnapshotPosition, SortOrder, TriggerHistoryEvent,
};
pub use ids::{IndexerEventId, SubAccountId, TriggerGroupId, TriggerLimbId};
pub use info::{
    AccountState, ChainStatus, ClientConfig, InfoClient, Level, Orderbook, Trade, DEVNET_CHAIN_ID,
    DEVNET_GATEWAY_URL,
};
pub use nonce::{NonceAllocator, MAX_CLOCK_LEAD_MS};
pub use state::{
    AuthorizedAgents, Funding, PositionTriggers, SubAccount, TriggerAvailability,
    TriggerEvaluation, TriggerLimbState, TriggerLimbStatus, TriggerOutcomeReason, Withdrawal,
};
#[cfg(feature = "ws")]
pub use ws::{
    AccountAuth, Subscription, WsAccount, WsClient, WsConfig, WsMessage, WsReceiver, WsTrade,
};

/// The core crate, re-exported so callers need one dependency.
pub use proof_trading_sdk as core;
pub use proof_trading_sdk::bridge::WithdrawalId;
pub use proof_trading_sdk::gateway::{TxAttribute, TxEvent, TxHash};
pub use proof_trading_sdk::query::{AccountInfo, PositionBrief};
pub use proof_trading_sdk::types::{
    Action, AtomicBasketLeg, CancelClientOrders, CancelOrders, CancelReplaceOrder, CancelTarget,
    ClientTriggerGroupId, ClientTriggerId, EventId, EventInfo, FundingRate, MarketConfig, MarketId,
    Order, OrderEntry, OrderId, OrderKind, Outcome, PlaceOrder, PlaceOrders, Position,
    PositionEpoch, Side, TimeInForce, TriggerLimb, TriggerSlippageBps, WithdrawalStatus,
};

/// Most orders one batch (`PlaceOrders`, `CancelOrders`,
/// `CancelClientOrders`) carries; the wire refuses 0 or more than this.
pub const MAX_ORDERS_PER_BATCH: usize = proof_trading_sdk::types::MAX_LIST_ENTRIES;
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
