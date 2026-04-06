//! Core domain types for the Proof exchange engine.
//!
//! All wire-format structs use MessagePack serialization (field-order dependent).
//! Monetary values are in **micro-USDC** (1 USDC = 1_000_000) unless otherwise noted.
//! Prices are unsigned 64-bit integers in quote-currency micro-units.

use core::fmt;

use crate::state::StateError;
use exchange_derive::AbciEvent;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/// Auto-incrementing order identifier, unique across all markets.
pub type OrderId = u64;
/// Numeric market identifier (e.g., 1 = BTC-USD perp).
pub type MarketId = u32;
/// Auto-incrementing fill identifier, unique across all trades.
pub type FillId = u64;

/// Well-known market ID for the BTC-USD perpetual.
pub const MARKET_BTC_USD_PERP: MarketId = 1;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/// Order/position direction. Discriminant values (1, 2) are part of the wire format.
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

/// A resting limit order on the order book.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Order {
    pub id: OrderId,
    pub market: MarketId,
    /// Keccak-256-derived account address (first 20 bytes of pubkey hash).
    pub owner: [u8; 20],
    pub side: Side,
    /// Limit price in micro-USDC per unit of the base asset.
    pub price: u64,
    /// Remaining quantity in base-asset units.
    pub quantity: u64,
}

/// Deterministic execution context passed to every transaction handler.
///
/// Constructed exclusively by the FFI boundary from CometBFT's `FinalizeBlock` fields.
pub struct TxContext {
    /// 1-based block height.
    pub height: u64,
    /// 0-based index within the block. `u32::MAX` / `u32::MAX - 1` are sentinels
    /// for end-of-block liquidation and funding events respectively.
    pub tx_index: u32,
    /// Block timestamp in milliseconds since Unix epoch.
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
    /// Cumulative funding index at the time the position was last settled.
    pub last_funding_index: i64,
}

/// Per-market risk parameters. Stored on-chain via `CreateMarket` admin action.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MarketConfig {
    pub market: MarketId,
    /// Initial margin ratio in basis points (e.g. 1000 = 10% → 10x leverage).
    pub im_bps: u32,
    /// Maintenance margin ratio in basis points (e.g. 500 = 5%).
    pub mm_bps: u32,
    /// Taker fee in basis points (e.g. 5 = 0.05%).
    pub taker_fee_bps: u32,
    /// Maker fee in basis points (e.g. 2 = 0.02%).
    pub maker_fee_bps: u32,
    /// Funding interval in milliseconds. 0 = funding disabled.
    pub funding_interval_ms: u64,
    /// Maximum absolute funding rate in basis points per interval.
    pub max_funding_rate_bps: u32,
}

// ---------------------------------------------------------------------------
// Actions (wire types — field order is the MessagePack wire layout)
// ---------------------------------------------------------------------------

/// Top-level transaction action enum. MessagePack tag selects the variant.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Action {
    PlaceOrder(PlaceOrder),
    CancelOrder(CancelOrder),
    OracleUpdate(OracleUpdate),
    MarketOrder(MarketOrder),
    Deposit(Deposit),
    Withdraw(Withdraw),
    CreateMarket(CreateMarket),
    WithdrawRequest(WithdrawRequest),
    ConfirmDeposit(ConfirmDeposit),
    ConfirmWithdrawal(ConfirmWithdrawal),
    FailWithdrawal(FailWithdrawal),
    ApproveAgent(ApproveAgent),
    RevokeAgent(RevokeAgent),
}

/// Immediate-or-cancel order that crosses the book at the best available price.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MarketOrder {
    pub market: MarketId,
    pub owner: [u8; 20],
    pub side: Side,
    /// Desired fill quantity in base-asset units.
    pub quantity: u64,
    /// Optional client-assigned ID echoed in events for correlation.
    pub client_order_id: Option<u64>,
}

/// Place a resting limit order on the book. May partially fill immediately.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlaceOrder {
    pub market: MarketId,
    pub owner: [u8; 20],
    pub side: Side,
    /// Limit price in micro-USDC per unit of the base asset.
    pub price: u64,
    /// Order size in base-asset units.
    pub quantity: u64,
    /// Optional client-assigned ID echoed in events for correlation.
    pub client_order_id: Option<u64>,
}

/// Cancel a resting order. Only the owner (or an authorized agent) may cancel.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CancelOrder {
    pub order_id: OrderId,
    pub owner: [u8; 20],
}

/// Push a new oracle (mark) price. Requires an authorized oracle signer.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OracleUpdate {
    pub market: MarketId,
    /// New mark price in micro-USDC.
    pub price: u64,
    pub signer: [u8; 20],
}

/// Direct deposit (testing/internal). Production deposits use [`ConfirmDeposit`].
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Deposit {
    pub owner: [u8; 20],
    /// Amount in micro-USDC.
    pub amount: u64,
}

/// Direct withdrawal (testing/internal). Production withdrawals use [`WithdrawRequest`].
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Withdraw {
    pub owner: [u8; 20],
    /// Amount in micro-USDC.
    pub amount: u64,
}

/// Admin action to register a market with its risk parameters.
/// Requires relayer authorization (signer must be an authorized relayer).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CreateMarket {
    pub market: MarketId,
    pub im_bps: u32,
    pub mm_bps: u32,
    pub taker_fee_bps: u32,
    pub maker_fee_bps: u32,
    pub signer: [u8; 20],
    /// Funding interval in milliseconds. 0 = funding disabled.
    pub funding_interval_ms: u64,
    /// Maximum absolute funding rate in basis points per interval.
    pub max_funding_rate_bps: u32,
}

/// User requests a USDC withdrawal to a Solana address.
/// Debits balance immediately and creates a pending withdrawal record.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WithdrawRequest {
    pub owner: [u8; 20],
    pub amount: u64,
    /// Solana destination public key (Ed25519, 32 bytes).
    pub solana_destination: [u8; 32],
}

/// Relayer confirms an on-chain USDC deposit from Solana.
/// Credits the derived internal account.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConfirmDeposit {
    pub owner: [u8; 20],
    pub amount: u64,
    /// Solana transaction signature (typically 64 bytes) for idempotency.
    pub solana_tx_sig: Vec<u8>,
    pub signer: [u8; 20],
}

/// Relayer confirms a USDC withdrawal was sent on Solana.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConfirmWithdrawal {
    pub withdrawal_id: u64,
    /// Solana transaction signature (typically 64 bytes).
    pub solana_tx_sig: Vec<u8>,
    pub signer: [u8; 20],
}

/// Relayer marks a withdrawal as permanently failed (e.g. Solana transfer
/// rejected, destination account closed).  Refunds the debited balance
/// back to the owner.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FailWithdrawal {
    pub withdrawal_id: u64,
    /// Human-readable reason for the failure (for event logging).
    pub reason: String,
    pub signer: [u8; 20],
}

/// Approve a delegate keypair ("agent wallet") to trade on the owner's behalf.
/// The agent can place/cancel orders but CANNOT withdraw or move funds.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ApproveAgent {
    pub owner: [u8; 20],
    pub agent_pubkey: [u8; 32],
}

/// Revoke a previously approved agent wallet.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RevokeAgent {
    pub owner: [u8; 20],
    pub agent_pubkey: [u8; 32],
}

/// Status of a pending withdrawal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum WithdrawalStatus {
    Pending,
    Completed,
    Failed,
}

/// On-chain record of a withdrawal request.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WithdrawalRecord {
    pub id: u64,
    pub owner: [u8; 20],
    pub amount: u64,
    pub solana_destination: [u8; 32],
    pub status: WithdrawalStatus,
    pub request_height: u64,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// Why an order was cancelled. Serialised as a string in ABCI events.
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

/// Engine output events, emitted during transaction execution and end-of-block processing.
/// Encoded as CometBFT ABCI events for indexing and WebSocket streaming.
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
        /// Execution price in micro-USDC.
        price: u64,
        /// Filled quantity in base-asset units.
        quantity: u64,
        maker_order_id: OrderId,
        maker_owner: [u8; 20],
        maker_side: Side,
        taker_owner: [u8; 20],
        /// Taker fee in micro-USDC (positive = charged, negative = rebate).
        taker_fee: i64,
        /// Maker fee in micro-USDC (positive = charged, negative = rebate).
        maker_fee: i64,
    },
    FeesCollected {
        market: MarketId,
        taker_owner: [u8; 20],
        taker_fee: i64,
        maker_owner: [u8; 20],
        maker_fee: i64,
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
        taker_fee_bps: u32,
        maker_fee_bps: u32,
        funding_interval_ms: u64,
        max_funding_rate_bps: u32,
    },
    /// Position forcibly closed by the end-of-block liquidation sweep.
    AccountLiquidated {
        owner: [u8; 20],
        market: MarketId,
        side: Side,
        size: u64,
        /// Oracle mark price at which the position was liquidated (micro-USDC).
        mark_price: u64,
        /// Realized PnL in micro-USDC (negative means a loss).
        realized_pnl: i64,
    },
    /// Insurance fund balance changed (e.g., from liquidation surplus/deficit).
    InsuranceFundUpdated {
        /// New total balance in micro-USDC (can be negative if fund is depleted).
        balance: i64,
        /// Change amount in micro-USDC (positive = inflow, negative = outflow).
        delta: i64,
    },
    WithdrawRequested {
        withdrawal_id: u64,
        owner: [u8; 20],
        amount: u64,
        solana_destination: [u8; 32],
    },
    DepositConfirmed {
        owner: [u8; 20],
        amount: u64,
        new_balance: u64,
        solana_tx_sig: Vec<u8>,
    },
    WithdrawalConfirmed {
        withdrawal_id: u64,
        solana_tx_sig: Vec<u8>,
    },
    WithdrawalFailed {
        withdrawal_id: u64,
        owner: [u8; 20],
        amount: u64,
        new_balance: u64,
        reason: String,
    },
    AgentApproved {
        owner: [u8; 20],
        agent: [u8; 20],
        agent_pubkey: [u8; 32],
    },
    AgentRevoked {
        owner: [u8; 20],
        agent: [u8; 20],
        agent_pubkey: [u8; 32],
    },
    /// A new funding rate was computed and applied to the market.
    FundingApplied {
        market: MarketId,
        /// Signed funding rate in basis points for this interval.
        funding_rate_bps: i64,
        /// New cumulative funding index after applying this rate.
        cumulative_funding: i64,
        timestamp_ms: u64,
    },
    /// Funding payment settled for a single position.
    FundingSettled {
        owner: [u8; 20],
        market: MarketId,
        /// Payment in micro-USDC (positive = received, negative = paid).
        payment: i64,
    },
    /// Account lacked sufficient balance to pay full funding obligation.
    FundingShortfall {
        owner: [u8; 20],
        market: MarketId,
        /// Full amount owed in micro-USDC.
        owed: i64,
        /// Amount actually collected in micro-USDC.
        actual: i64,
        /// Unfunded gap absorbed by the insurance fund (micro-USDC).
        shortfall: u64,
    },
    /// Emitted when a fill causes an account to drop below maintenance margin.
    /// The fill is NOT blocked — the end-of-block liquidation sweep will handle it.
    /// This event provides immediate observability for off-chain monitoring.
    MarginWarning {
        owner: [u8; 20],
        equity: i64,
        maintenance_margin: u64,
    },
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Transaction execution error. Each variant maps to a unique non-zero ABCI result code
/// via [`ExecError::code()`] (see the `impl` block below).
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
    /// Post-trade equity would fall below initial margin requirement.
    InsufficientMargin,
    /// Store read/write returned unexpected data; indicates a bug or data corruption.
    StateCorruption(String),
    /// Catch-all for unexpected runtime failures (code 255).
    InternalError(String),
    UnauthorizedRelayer,
    WithdrawalNotFound(u64),
    WithdrawalAlreadyProcessed(u64),
    /// Solana tx signature has already been used (idempotency guard).
    DuplicateDeposit,
    InvalidSignature,
    SignatureRequired,
    /// Tx signer is neither the account owner nor an approved agent.
    AgentNotAuthorized,
    /// Agent wallets may trade but are forbidden from withdrawing funds.
    AgentCannotWithdraw,
    InvalidNonce { expected: u64, got: u64 },
    MarketAlreadyExists(MarketId),
    InvalidMarketConfig(String),
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
            ExecError::UnauthorizedRelayer => 13,
            ExecError::WithdrawalNotFound(_) => 14,
            ExecError::WithdrawalAlreadyProcessed(_) => 15,
            ExecError::DuplicateDeposit => 16,
            ExecError::InvalidSignature => 17,
            ExecError::SignatureRequired => 18,
            ExecError::AgentNotAuthorized => 19,
            ExecError::AgentCannotWithdraw => 20,
            ExecError::InvalidNonce { .. } => 21,
            ExecError::MarketAlreadyExists(_) => 22,
            ExecError::InvalidMarketConfig(_) => 23,
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
            ExecError::UnauthorizedRelayer => write!(f, "unauthorized relayer signer"),
            ExecError::WithdrawalNotFound(id) => write!(f, "withdrawal not found: {id}"),
            ExecError::WithdrawalAlreadyProcessed(id) => {
                write!(f, "withdrawal already processed: {id}")
            }
            ExecError::DuplicateDeposit => write!(f, "duplicate deposit signature"),
            ExecError::InvalidSignature => write!(f, "invalid Ed25519 signature"),
            ExecError::SignatureRequired => write!(f, "signed transaction required"),
            ExecError::AgentNotAuthorized => {
                write!(f, "signer is not owner or authorized agent")
            }
            ExecError::AgentCannotWithdraw => {
                write!(f, "agent wallets cannot perform withdrawals")
            }
            ExecError::InvalidNonce { expected, got } => {
                write!(f, "invalid nonce: expected {expected}, got {got}")
            }
            ExecError::MarketAlreadyExists(id) => write!(f, "market already exists: {id}"),
            ExecError::InvalidMarketConfig(msg) => write!(f, "invalid market config: {msg}"),
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
