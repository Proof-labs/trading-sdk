use core::fmt;

use crate::state::StateError;
use exchange_derive::AbciEvent;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

pub type OrderId = u64;
pub type MarketId = u32;
pub type FillId = u64;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum Side {
    Buy = 1,
    Sell = 2,
}

impl fmt::Display for Side {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Side::Buy => f.write_str("buy"),
            Side::Sell => f.write_str("sell"),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Order {
    pub id: OrderId,
    pub market: MarketId,
    pub owner: [u8; 20],
    pub side: Side,
    pub price: u64,
    pub quantity: u64,
}

/// Deterministic execution context. Constructed exclusively by the FFI boundary
/// from CometBFT's RequestFinalizeBlock fields.
pub struct TxContext {
    pub height: u64,
    pub tx_index: u32,
    pub block_time_ms: u64,
}

// ---------------------------------------------------------------------------
// Position & margin types
// ---------------------------------------------------------------------------

/// Persistent position state per owner per market.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Position {
    pub owner: [u8; 20],
    pub market: MarketId,
    pub side: Side,
    /// Weighted-average entry price (in quote units, same scale as order prices).
    pub entry_price: u64,
    /// Absolute size (always > 0 while position exists).
    pub size: u64,
}

/// Per-market risk parameters. Stored on-chain via `CreateMarket` admin action.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MarketConfig {
    pub market: MarketId,
    /// Initial margin ratio in basis points (e.g. 1000 = 10% → 10x leverage).
    pub im_bps: u32,
    /// Maintenance margin ratio in basis points (e.g. 500 = 5%).
    pub mm_bps: u32,
}

// ---------------------------------------------------------------------------
// Actions (wire types — field order is the MessagePack wire layout)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Action {
    PlaceOrder(PlaceOrder),
    CancelOrder(CancelOrder),
    OracleUpdate(OracleUpdate),
    MarketOrder(MarketOrder),
    Deposit(Deposit),
    Withdraw(Withdraw),
    CreateMarket(CreateMarket),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MarketOrder {
    pub market: MarketId,
    pub owner: [u8; 20],
    pub side: Side,
    pub quantity: u64,
    pub client_order_id: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlaceOrder {
    pub market: MarketId,
    pub owner: [u8; 20],
    pub side: Side,
    pub price: u64,
    pub quantity: u64,
    pub client_order_id: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CancelOrder {
    pub order_id: OrderId,
    pub owner: [u8; 20],
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OracleUpdate {
    pub market: MarketId,
    pub price: u64,
    pub signer: [u8; 20],
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Deposit {
    pub owner: [u8; 20],
    pub amount: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Withdraw {
    pub owner: [u8; 20],
    pub amount: u64,
}

/// Admin action to register a market with its risk parameters.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CreateMarket {
    pub market: MarketId,
    pub im_bps: u32,
    pub mm_bps: u32,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum CancelReason {
    UserRequested,
    Expired,
    AdminForce,
    Liquidation,
}

impl fmt::Display for CancelReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CancelReason::UserRequested => f.write_str("user_requested"),
            CancelReason::Expired => f.write_str("expired"),
            CancelReason::AdminForce => f.write_str("admin_force"),
            CancelReason::Liquidation => f.write_str("liquidation"),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, AbciEvent)]
pub enum Event {
    OrderPlaced {
        order_id: OrderId,
        market: MarketId,
        owner: [u8; 20],
        side: Side,
        price: u64,
        quantity: u64,
    },
    OrderCancelled {
        order_id: OrderId,
        market: MarketId,
        owner: [u8; 20],
        reason: CancelReason,
    },
    PriceUpdated {
        market: MarketId,
        price: u64,
    },
    TradeExecuted {
        fill_id: FillId,
        market: MarketId,
        price: u64,
        quantity: u64,
        maker_order_id: OrderId,
        maker_owner: [u8; 20],
        maker_side: Side,
        taker_owner: [u8; 20],
    },
    Deposited {
        owner: [u8; 20],
        amount: u64,
        new_balance: u64,
    },
    Withdrawn {
        owner: [u8; 20],
        amount: u64,
        new_balance: u64,
    },
    PositionUpdated {
        owner: [u8; 20],
        market: MarketId,
        side: Side,
        entry_price: u64,
        size: u64,
    },
    PositionClosed {
        owner: [u8; 20],
        market: MarketId,
        realized_pnl: i64,
    },
    MarketCreated {
        market: MarketId,
        im_bps: u32,
        mm_bps: u32,
    },
    AccountLiquidated {
        owner: [u8; 20],
        market: MarketId,
        side: Side,
        size: u64,
        mark_price: u64,
        realized_pnl: i64,
    },
    InsuranceFundUpdated {
        balance: i64,
        delta: i64,
    },
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum ExecError {
    DecodeError(String),
    OrderNotFound(OrderId),
    NotOwner(OrderId),
    UnauthorizedOracle,
    Overflow,
    InvalidPrice,
    InvalidQuantity,
    InvalidSide,
    UnknownMarket(MarketId),
    InsufficientBalance,
    InsufficientMargin,
    StateCorruption(String),
    InternalError(String),
}

impl ExecError {
    pub fn code(&self) -> u32 {
        match self {
            ExecError::DecodeError(_) => 1,
            ExecError::OrderNotFound(_) => 2,
            ExecError::NotOwner(_) => 3,
            ExecError::UnauthorizedOracle => 4,
            ExecError::Overflow => 5,
            ExecError::InvalidPrice => 6,
            ExecError::InvalidQuantity => 7,
            ExecError::InvalidSide => 8,
            ExecError::UnknownMarket(_) => 9,
            ExecError::InsufficientBalance => 11,
            ExecError::InsufficientMargin => 12,
            ExecError::StateCorruption(_) => 10,
            ExecError::InternalError(_) => 255,
        }
    }
}

impl fmt::Display for ExecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ExecError::DecodeError(msg) => write!(f, "decode error: {msg}"),
            ExecError::OrderNotFound(id) => write!(f, "order not found: {id}"),
            ExecError::NotOwner(id) => write!(f, "not owner of order: {id}"),
            ExecError::UnauthorizedOracle => write!(f, "unauthorized oracle signer"),
            ExecError::Overflow => write!(f, "arithmetic overflow"),
            ExecError::InvalidPrice => write!(f, "invalid price"),
            ExecError::InvalidQuantity => write!(f, "invalid quantity"),
            ExecError::InvalidSide => write!(f, "invalid side"),
            ExecError::UnknownMarket(id) => write!(f, "unknown market: {id}"),
            ExecError::InsufficientBalance => write!(f, "insufficient balance"),
            ExecError::InsufficientMargin => write!(f, "insufficient margin"),
            ExecError::StateCorruption(msg) => write!(f, "state corruption: {msg}"),
            ExecError::InternalError(msg) => write!(f, "internal error: {msg}"),
        }
    }
}

impl From<StateError> for ExecError {
    fn from(value: StateError) -> Self {
        match value {
            StateError::ArithmeticInvariantViolation { .. } => ExecError::Overflow,
            other => ExecError::StateCorruption(other.to_string()),
        }
    }
}
