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
/// Impact market family identifier (1 family owns 4 child markets — CPY/CPN/EBY/EBN).
pub type ImpactMarketId = u32;

/// Well-known market ID for the BTC-USD perpetual.
pub const MARKET_BTC_USD_PERP: MarketId = 1;

/// Maximum price (in micro-USDC) for a prediction-binary share. $1.00 = 1_000_000 µUSDC.
pub const BINARY_PRICE_MAX: u64 = 1_000_000;

// ---------------------------------------------------------------------------
// Impact market enums
// ---------------------------------------------------------------------------

/// Which branch of a binary event a conditional/prediction book represents.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Branch {
    Yes = 1,
    No = 2,
}

impl fmt::Display for Branch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Branch::Yes => f.write_str("yes"),
            Branch::No => f.write_str("no"),
        }
    }
}

/// Outcome of an impact-market event resolution.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Outcome {
    Yes = 1,
    No = 2,
    /// Auto-voided (neither branch won — e.g., resolver timeout under the auto-void policy).
    Void = 3,
}

impl fmt::Display for Outcome {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Outcome::Yes => f.write_str("yes"),
            Outcome::No => f.write_str("no"),
            Outcome::Void => f.write_str("void"),
        }
    }
}

/// Kind of market stored on-chain. Stored on [`MarketConfig`].
///
/// The existing engine paths (matching, funding, liquidation) only care that a
/// market has a CLOB. The kind affects: (a) margin computation — conditional
/// books get branch-conditional max instead of per-book sum; (b) price-range
/// validation — binaries must trade inside `[0, BINARY_PRICE_MAX]`; (c)
/// resolution — conditional books freeze at resolution, binaries settle to
/// `$1` or `$0`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MarketKind {
    /// Regular perpetual future (BTC-PERP, ETH-PERP, SOL-PERP, etc.).
    Perp,
    /// Conditional perpetual — trades like a perp until the parent event
    /// resolves, then settles (if branch wins) or voids (if branch loses).
    ConditionalPerp {
        impact_market_id: ImpactMarketId,
        branch: Branch,
    },
    /// Prediction-binary token — trades on [0, BINARY_PRICE_MAX] µUSDC.
    /// Settles to $1 if the branch wins at resolution, $0 otherwise.
    PredictionBinary {
        impact_market_id: ImpactMarketId,
        branch: Branch,
    },
}

impl Default for MarketKind {
    fn default() -> Self {
        MarketKind::Perp
    }
}

impl MarketKind {
    /// Returns the impact market family ID this market belongs to, if any.
    pub fn impact_market_id(&self) -> Option<ImpactMarketId> {
        match self {
            MarketKind::Perp => None,
            MarketKind::ConditionalPerp {
                impact_market_id, ..
            }
            | MarketKind::PredictionBinary {
                impact_market_id, ..
            } => Some(*impact_market_id),
        }
    }

    /// Returns the branch this market is tied to, if any.
    pub fn branch(&self) -> Option<Branch> {
        match self {
            MarketKind::Perp => None,
            MarketKind::ConditionalPerp { branch, .. }
            | MarketKind::PredictionBinary { branch, .. } => Some(*branch),
        }
    }

    pub fn is_conditional_perp(&self) -> bool {
        matches!(self, MarketKind::ConditionalPerp { .. })
    }

    pub fn is_prediction_binary(&self) -> bool {
        matches!(self, MarketKind::PredictionBinary { .. })
    }
}

/// Lifecycle status of an impact-market family.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ImpactMarketStatus {
    /// Open for trading on all 5 books.
    Trading,
    /// Past deadline, awaiting resolver signatures. New orders on child books rejected.
    PreResolution,
    /// Fully resolved. Winning conditional perp settled; losing voided.
    /// Binaries settled to $1 (winner) or $0 (loser).
    Resolved(Outcome),
}

/// Stored on-chain record for an impact-market family. Owns pointers to the
/// 4 child markets (CPY, CPN, EBY, EBN) plus the underlying perp.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImpactMarketInfo {
    pub impact_market_id: ImpactMarketId,
    /// Underlying perp market (unconditional book 1). Must already exist.
    pub underlying_market: MarketId,
    /// Conditional-perp YES child book.
    pub cpy_market: MarketId,
    /// Conditional-perp NO child book.
    pub cpn_market: MarketId,
    /// Prediction-binary YES child book.
    pub eby_market: MarketId,
    /// Prediction-binary NO child book.
    pub ebn_market: MarketId,
    /// Human-readable question (hashed into the market metadata).
    pub question: String,
    /// Event deadline in milliseconds since Unix epoch.
    pub deadline_ms: u64,
    /// Grace period after `deadline_ms` before the auto-void path fires.
    pub resolution_window_ms: u64,
    /// Current lifecycle status.
    pub status: ImpactMarketStatus,
    /// Block timestamp when the impact market was created (ms since epoch).
    pub created_ms: u64,
    /// Block timestamp when the impact market was resolved (ms since epoch), 0 if unresolved.
    pub resolved_ms: u64,
}

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
    /// Block timestamp (ms since epoch) when this order was placed.
    /// Paired with `MarketConfig::default_ttl_ms` to power the
    /// `run_order_expiry` end-of-block sweep. Zero means "no
    /// timestamp recorded" — which is also how on-chain `Order`
    /// records written before this field existed decode thanks to
    /// `serde(default)`. An order with `created_at_ms = 0` is
    /// treated as "never expires" for safety (we don't want to
    /// accidentally cancel legacy orders that predate the TTL work).
    #[serde(default)]
    pub created_at_ms: u64,
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
    /// 32-byte chain_id binding used by the v3 signing envelope
    /// (`crate::crypto::signing_message`). Every v2-enveloped tx at
    /// verify time requires the chain_id that was used at sign time,
    /// so the value MUST be consistent across all validators — the
    /// FFI layer sources it from genesis / snapshot-bound state and
    /// threads it through every `FinalizeBlock` call.
    ///
    /// Defaults to `crypto::UNBOUND_CHAIN_ID` ([0u8; 32]) in tests
    /// and in unbound deployments; production chains must set a
    /// non-zero value to close the cross-chain replay vector
    /// (audit B4, 2026-04-23).
    pub chain_id: [u8; 32],
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
    /// Market kind (perp / conditional perp / prediction binary).
    ///
    /// `#[serde(default)]` so existing on-chain `MarketConfig` records written
    /// before impact markets existed decode cleanly as `MarketKind::Perp`.
    #[serde(default)]
    pub kind: MarketKind,
    /// Maximum absolute position size per account, in contracts. Enforced
    /// at order-placement time: a fill that would push the taker's net
    /// position (signed) beyond ±max_position_size gets rejected with
    /// `ExecError::PositionLimitExceeded`. Zero means "no limit" — which
    /// is also what existing on-chain MarketConfig records (written
    /// before this field existed) decode as thanks to serde(default).
    ///
    /// Set this via CreateMarket or UpdateMarketFees for new markets;
    /// existing markets keep `0` until explicitly updated.
    #[serde(default)]
    pub max_position_size: u64,
    /// Default order time-to-live in milliseconds. When > 0, the
    /// end-of-block `run_order_expiry` sweep cancels any resting
    /// order whose `created_at_ms + default_ttl_ms < block_time_ms`.
    /// Zero means "no TTL" — backward-compatible default for
    /// markets created before this field existed (serde(default)).
    ///
    /// Motivation: MMs and bots that crash or restart leave
    /// orphaned orders resting forever at stale prices, silently
    /// locking up their initial margin. On 2026-04-23 alice (core
    /// MM owner) had 1432 such orders across 20+ markets pinning
    /// $6M IM against $2.9M equity — every new ask bounced with
    /// `InsufficientMargin` and the BTC book went permanently
    /// one-sided. With TTL set, the same shape self-heals within
    /// `default_ttl_ms` rather than requiring manual cleanup.
    ///
    /// Recommended value for perps: 60_000 (1 minute) to match
    /// the MM refresh cadence. For impact markets: longer (minutes)
    /// because their MMs don't re-quote as often.
    #[serde(default)]
    pub default_ttl_ms: u64,
    /// When true, this market's firing legs participate in net-delta
    /// margin aggregation: all firing legs within a scenario that share
    /// the same underlying market are combined into a single net position
    /// for MM/IM. Charges `|Σ signed_size| × settle × weighted_bps` rather
    /// than summing bps-on-notional per leg.
    ///
    /// Scope: only Perp and ConditionalPerp. PredictionBinary legs are
    /// always charged per-leg (they don't add linear delta to their
    /// underlying). Flag on a binary's MarketConfig is ignored for
    /// grouping.
    ///
    /// Grouping key: the underlying perp market id. For a perp, that's
    /// the perp itself. For a conditional perp, it's the perp referenced
    /// by the impact market's `underlying_market`. Two legs group iff
    /// they share the same underlying AND both have `net_delta_margin=true`
    /// AND both fire in the current scenario.
    ///
    /// Within a group: `mm = |Σ signed_size| × settle × weighted_mm_bps /
    /// 10_000`, where `weighted_mm_bps = Σ(|size_i| × mm_bps_i) / Σ|size_i|`.
    /// Same formula for IM with im_bps. A perfectly hedged group
    /// (net_signed = 0) charges zero MM regardless of per-leg bps.
    ///
    /// Default: false — legacy per-leg scenario margin behavior.
    /// `#[serde(default)]` keeps existing on-chain MarketConfig records
    /// decoding correctly.
    ///
    /// See docs/margin-engine.md §6 for the derivation.
    #[serde(default)]
    pub net_delta_margin: bool,
    /// Insurance-fund pool grouping. Markets with the same `pool_id`
    /// share an insurance fund — a JELLY-style blowout in one pool can
    /// drain its own IF to zero without touching the IF that backs
    /// other pools. See `docs/adl-vs-socialized-loss.md` §3 for the
    /// full waterfall design (HLP → per-pool IF → socialized loss →
    /// ADL).
    ///
    /// Defaults to 0 so existing on-chain MarketConfigs (written before
    /// per-pool IF existed) all map to the legacy single-IF behavior.
    /// Pool 0 reads/writes route to the legacy `INSURANCE_FUND` key,
    /// preserving balance continuity across the upgrade.
    ///
    /// At launch we run two pools:
    ///   * Pool 0 — BTC/ETH/SOL perps + their conditional perps (the
    ///     "majors" pool). Inherits all existing balance.
    ///   * Pool 1 — high-vol prediction binaries / longtail markets.
    ///     Per-event tighter caps, isolated from majors.
    ///
    /// **Pool IDs are operator-defined free-form labels (u8) — there is
    /// no engine-level validation against a known set.** A typo (e.g.
    /// passing `99` instead of `2`) silently creates the market in an
    /// isolated pool with empty IF and empty ADL queue. Run
    /// `scripts/admin-pool-audit.ts` after every CreateMarket batch to
    /// surface markets in singleton pools.
    #[serde(default)]
    pub pool_id: u8,
}

/// Configuration for the Hyperliquidity Provider (HLP) — the
/// protocol-owned MM that absorbs bankruptcy losses at Tier 0 of the
/// bad-debt waterfall. See `docs/adl-vs-socialized-loss.md` §3.2.
///
/// Stored under `keys::HLP_CONFIG` (single global record). The HLP's
/// trading account lives at `address`; the engine treats it like any
/// other account for matching purposes but consults `min_balance_floor`
/// when settling deficits — once HLP equity drops below the floor it
/// stops absorbing and further deficits route to the per-pool IF.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct HlpConfig {
    /// 20-byte address of the HLP vault account (matches the address
    /// derived from the HLP's signing key).
    pub address: [u8; 20],
    /// Bootstrap equity (microUSDC). Captured at HLP-onboarding time
    /// and never updated; the floor is computed from this baseline so
    /// drawdowns don't move the floor up.
    pub bootstrap_balance: u64,
    /// Minimum balance HLP must retain. Below this, Tier 0 stops
    /// absorbing. Default: 60% of bootstrap (`0.6 × bootstrap_balance`).
    /// Stored absolute so the value at config-write time is durable
    /// across bootstrap_balance migrations.
    pub min_balance_floor: u64,
    /// True iff Tier 0 is enabled. When false (initial state — no HLP
    /// configured) the waterfall starts at Tier 1 (per-pool IF).
    pub enabled: bool,
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
    CreateImpactMarket(CreateImpactMarket),
    ResolveEvent(ResolveEvent),
    UpdateMarketFees(UpdateMarketFees),
    /// Test/admin: force-run end-of-block liquidations immediately. Used by
    /// integration scenarios that need to deterministically engineer a
    /// cascade or bad-debt path without waiting for the natural end-of-block
    /// timing. Authorized by the relayer allowlist (same as OracleUpdate).
    RunLiquidationSweep(RunLiquidationSweep),
    /// Test/admin: force-run a funding tick on a single market immediately,
    /// bypassing the `funding_interval_ms` clock check. Used by S13/S14 to
    /// fire funding at a precise scenario point rather than waiting on
    /// chain time. Authorized by the relayer allowlist.
    RunFundingTick(RunFundingTick),
}

/// Test/admin action — force-runs `run_liquidations` immediately.
/// See `Action::RunLiquidationSweep` for rationale.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RunLiquidationSweep {
    pub signer: [u8; 20],
}

/// Test/admin action — force-runs a funding tick on one market.
/// See `Action::RunFundingTick` for rationale.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RunFundingTick {
    pub market: MarketId,
    pub signer: [u8; 20],
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
    /// Post-only flag: if the order would cross the book on placement, the
    /// engine rejects with `PostOnlyWouldCross` instead of taking. Used by
    /// makers who want to guarantee maker-side fills. `serde(default)` so
    /// pre-existing wire records decode with `false`.
    #[serde(default)]
    pub post_only: bool,
    /// Reduce-only flag: order may only reduce an existing position;
    /// rejected if same-side as the current position (would increase) or
    /// no position exists. Clamped to position size if the order would
    /// over-close (flip direction). `serde(default)` so old records
    /// decode with `false`.
    #[serde(default)]
    pub reduce_only: bool,
}

/// Cancel a resting order. Only the owner (or an authorized agent) may cancel.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CancelOrder {
    pub order_id: OrderId,
    pub owner: [u8; 20],
}

/// Push a new oracle (mark) price. Requires an authorized oracle signer
/// AND a strictly increasing `publish_time_ms` per market.
///
/// **Why the timestamp check** (added 2026-04-23, audit finding B3):
/// before this field existed, `OracleUpdate` had no replay protection
/// of any kind — it's relayer-signed so it skips nonce enforcement,
/// and the handler read no previous state before overwriting the
/// price. Any previously-signed update (captured from the mempool,
/// a public API, or a node log) was replayable forever. An attacker
/// could rewind the mark price to a historical value, triggering
/// mass liquidations or arbitrage at stale prices.
///
/// The field is the Pyth-style publish time of the price signal
/// (ms since Unix epoch). The handler rejects any update whose
/// `publish_time_ms` is ≤ the most recent stored value for the
/// same market. Genesis / first-update carries any timestamp; the
/// check only kicks in from the second update onward.
///
/// `#[serde(default)]` on `publish_time_ms` so on-chain records
/// written before this field existed decode with `publish_time_ms = 0`,
/// which passes the monotonicity check exactly once (and fails
/// all replays of that seed update thereafter).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OracleUpdate {
    pub market: MarketId,
    /// New mark price in micro-USDC.
    pub price: u64,
    pub signer: [u8; 20],
    /// Oracle's own publish timestamp in ms since Unix epoch.
    /// Must be strictly greater than the last accepted update's
    /// `publish_time_ms` for the same market.
    #[serde(default)]
    pub publish_time_ms: u64,
}

/// Direct deposit — requires **relayer authorization**.
///
/// Previously described as "testing/internal" with no authorization check
/// beyond `signer == owner`, which was an unauthenticated mint primitive:
/// any signed user could credit themselves arbitrary balance. See audit
/// finding B1 (2026-04-23). The handler now requires
/// `is_relayer_authorized(signer)`.
///
/// In production the primary deposit path is [`ConfirmDeposit`] (which
/// additionally dedupes on a Solana tx signature). This direct action
/// remains available to the relayer for test bootstraps and the unusual
/// cases where no Solana sig exists (e.g. migration/genesis-adjacent
/// credits). External callers must use [`ConfirmDeposit`] instead.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Deposit {
    pub owner: [u8; 20],
    /// Amount in micro-USDC.
    pub amount: u64,
    /// Relayer signer. Must be an authorized relayer; enforced by
    /// `handle_deposit`. Added 2026-04-23 per audit B1.
    #[serde(default)]
    pub signer: [u8; 20],
}

/// Direct withdrawal — requires **relayer authorization**.
///
/// Previously described as "testing/internal" with no authorization check
/// beyond `signer == owner`, which let any user debit their balance with
/// no off-chain counterparty (a silent burn). See audit finding B2
/// (2026-04-23). The handler now requires
/// `is_relayer_authorized(signer)`.
///
/// External users move funds out via the two-phase [`WithdrawRequest`] →
/// relayer [`ConfirmWithdrawal`] path. This direct action remains
/// available to the relayer for administrative adjustments (e.g.
/// refunding a stuck position) and for integration tests.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Withdraw {
    pub owner: [u8; 20],
    /// Amount in micro-USDC.
    pub amount: u64,
    /// Relayer signer. Must be an authorized relayer; enforced by
    /// `handle_withdraw`. Added 2026-04-23 per audit B2.
    #[serde(default)]
    pub signer: [u8; 20],
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
    /// Bad-debt pool the market belongs to. Markets in different pools
    /// are insulated from each other's liquidation cascades — a residual
    /// in pool 1 cannot ADL profitable counterparties holding only
    /// positions in pool 2 (see `iter_positions(pool_id)` in
    /// `absorb_via_adl`). Defaults to 0; existing markets continue to
    /// share pool 0 unless explicitly placed elsewhere.
    #[serde(default)]
    pub pool_id: u8,
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

/// Admin action to create a new impact market family. Atomically registers
/// the 4 child markets (CPY / CPN / EBY / EBN) with sequential IDs starting
/// at `child_market_base` and writes the [`ImpactMarketInfo`] record.
/// Requires relayer authorization.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CreateImpactMarket {
    pub impact_market_id: ImpactMarketId,
    /// Underlying perp market (book 1). Must already exist with `kind = Perp`.
    pub underlying_market: MarketId,
    /// Starting ID for the 4 child markets. They are allocated as:
    /// `child_market_base+0` = CPY, `+1` = CPN, `+2` = EBY, `+3` = EBN.
    /// None of these market IDs may already exist.
    pub child_market_base: MarketId,
    pub question: String,
    pub deadline_ms: u64,
    pub resolution_window_ms: u64,
    /// Initial margin ratio for the 2 conditional-perp child books (basis points).
    /// Prediction-binary books don't use bps IM — their IM is computed from payoff.
    pub im_bps: u32,
    /// Maintenance margin ratio for conditional-perp child books.
    pub mm_bps: u32,
    pub taker_fee_bps: u32,
    pub maker_fee_bps: u32,
    /// Funding interval for the conditional-perp child books (ms). 0 = disabled.
    pub funding_interval_ms: u64,
    pub max_funding_rate_bps: u32,
    pub signer: [u8; 20],
}

/// Admin action to resolve an impact-market event. Settles the winning
/// conditional-perp book and voids the loser; cash-settles both binary books
/// to $1 (winner) / $0 (loser). Requires relayer authorization.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResolveEvent {
    pub impact_market_id: ImpactMarketId,
    pub outcome: Outcome,
    pub signer: [u8; 20],
}

/// Update a subset of `MarketConfig` fields on an existing market.
/// Every tunable is `Option<T>` so the caller only supplies the fields
/// they mean to change; `None` leaves the current value untouched.
///
/// This is the admin lever that lets us tighten the funding cap, set
/// position limits, or calibrate fees on a live market — previously
/// the only way to change those was a chain rebase, which surfaced on
/// 2026-04-20 when we saw BTC funding spike to −1608 bps under the
/// seed-time `max_funding_rate_bps = 3000` cap and had no way to
/// dampen it without wiping state.
///
/// Requires relayer authorization. Fields that would violate an
/// invariant of the existing market (e.g. `mm_bps > im_bps`) are
/// rejected with `ExecError::InvalidMarketConfig`.
///
/// Fields left intentionally immutable (not exposed here):
///   * `market` — identity
///   * `kind` — changing a market's kind would break the
///     book's accounting model (perp vs conditional perp vs binary).
///   * `im_bps` / `mm_bps` — tempting to tune but too risky without a
///     migration path for existing positions. Add if/when we have a
///     well-tested position-re-margin routine.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UpdateMarketFees {
    pub market: MarketId,
    pub signer: [u8; 20],
    /// New taker fee in basis points. `None` = leave unchanged.
    #[serde(default)]
    pub taker_fee_bps: Option<u32>,
    /// New maker fee in basis points. `None` = leave unchanged.
    #[serde(default)]
    pub maker_fee_bps: Option<u32>,
    /// New max funding rate cap in basis points per interval.
    /// `None` = leave unchanged. Setting to 0 disables funding.
    #[serde(default)]
    pub max_funding_rate_bps: Option<u32>,
    /// New funding interval in ms. `None` = leave unchanged.
    #[serde(default)]
    pub funding_interval_ms: Option<u64>,
    /// New per-account position cap in contracts. `None` = leave
    /// unchanged. Setting to 0 disables the cap.
    #[serde(default)]
    pub max_position_size: Option<u64>,
    /// New default order TTL in milliseconds. `None` = leave
    /// unchanged. Setting to 0 disables auto-cancel sweeps for this
    /// market. Operators tune this per-market via the relayer-signed
    /// admin action; recommended: 60_000 (1 minute) for perps, longer
    /// for impact markets whose MMs re-quote less often. Motivated
    /// by the 2026-04-23 incident where alice's orphaned-order
    /// backlog locked $6M IM against $2.9M equity and made the BTC
    /// book permanently one-sided — see `run_order_expiry` docstring.
    #[serde(default)]
    pub default_ttl_ms: Option<u64>,
    /// Flip the net-delta portfolio margin flag on this market.
    /// `None` = leave unchanged. `Some(true)` enables net-delta
    /// grouping for firing legs on this market's underlying; `Some(false)`
    /// falls back to per-leg scenario margin.
    ///
    /// See `MarketConfig::net_delta_margin` for the semantics. Flipping
    /// this on a live market changes MM/IM for existing positions
    /// on the next check — operators should model the impact before
    /// flipping to `false` (could push accounts under MM) but
    /// flipping to `true` is always safe (can only relieve MM).
    #[serde(default)]
    pub net_delta_margin: Option<bool>,
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
    /// Per-trade MTM event for an impact-family ConditionalPerp close
    /// (no-oracle MTM redesign, 2026-04-26). Issues `signed_delta` units of
    /// the corresponding prediction binary (B+ for CPY closes, B- for CPN
    /// closes) at entry $0 to the closing party, decomposing their
    /// conditional PnL into a fungible binary token.
    ///
    /// `signed_delta` is in conditional dollars (the size of the issued
    /// binary). Positive = long binary issued (closing party gained on the
    /// CP close); negative = short binary issued (loss).
    ///
    /// `cash_pnl_realized` is the cash-settlement byproduct of the v1
    /// limitation where MTM that creates an opposite-side delta against an
    /// existing direct-traded binary position nets out, realizing PnL on
    /// the absorbed portion at the MTM-issued $0 entry. Zero in the common
    /// case (no existing opposite-side binary). Tracked separately for
    /// observability so off-chain monitoring can quantify the cash
    /// imbalance v2 multi-position support will eliminate.
    ///
    /// `final_size` and `final_entry` are the resulting state of the
    /// owner's binary position after the MTM is applied (could be 0 if
    /// the MTM netted out an equal-size opposite position).
    BinaryIssuedFromMTM {
        owner: [u8; 20],
        /// CP market that triggered the MTM (closed via fill).
        cp_market: MarketId,
        /// Target binary market (B+ for CPY closes, B- for CPN closes).
        binary_market: MarketId,
        /// Signed quantity of binary issued. + = long, - = short.
        signed_delta: i64,
        /// Resulting binary position size after MTM applied.
        final_size: u64,
        /// Resulting binary position entry after MTM applied (weighted
        /// average for same-side blends, 0 for fresh issuance).
        final_entry: u64,
        /// Cash debit/credit from netting against an existing opposite-side
        /// binary position. Zero in the common case.
        cash_pnl_realized: i64,
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
    /// Admin updated one or more tunable fields on an existing market.
    /// Event carries the FULL post-update set of mutable fields so
    /// consumers see the live config after the tx; no need to diff
    /// against prior state. Immutable fields (im_bps, mm_bps, kind)
    /// are not included because they're not what UpdateMarketFees
    /// can change.
    ///
    /// ABCI event derivation requires Display on every attribute, so
    /// Option<T> would break the codegen — we emit the whole config
    /// snapshot instead. Callers that only care about the delta can
    /// compare to the previous MarketConfigUpdated for the same market.
    MarketConfigUpdated {
        market: MarketId,
        taker_fee_bps: u32,
        maker_fee_bps: u32,
        max_funding_rate_bps: u32,
        funding_interval_ms: u64,
        max_position_size: u64,
        default_ttl_ms: u64,
        net_delta_margin: bool,
    },
    /// Impact-market family was registered. Emitted once; the 5 underlying
    /// `MarketCreated` events follow (1 reused existing perp + 4 new children).
    ImpactMarketCreated {
        impact_market_id: ImpactMarketId,
        underlying_market: MarketId,
        cpy_market: MarketId,
        cpn_market: MarketId,
        eby_market: MarketId,
        ebn_market: MarketId,
        question: String,
        deadline_ms: u64,
        resolution_window_ms: u64,
    },
    /// Event was resolved with a definitive outcome. Emitted once per family.
    EventResolved {
        impact_market_id: ImpactMarketId,
        outcome: Outcome,
        /// Oracle price of the underlying at resolution time (micro-USDC).
        /// Used as the settlement mark for the winning conditional perp.
        settlement_price: u64,
        timestamp_ms: u64,
    },
    /// A conditional-perp position was cash-settled to an owner's balance
    /// because its branch won the resolution.
    ConditionalSettled {
        impact_market_id: ImpactMarketId,
        market: MarketId,
        owner: [u8; 20],
        side: Side,
        size: u64,
        entry_price: u64,
        settlement_price: u64,
        realized_pnl: i64,
    },
    /// A conditional-perp position was voided because its branch lost. The
    /// position holder's reserved IM is released (effectively: position deleted,
    /// no balance change, as IM is equity-based not locked collateral).
    ConditionalVoided {
        impact_market_id: ImpactMarketId,
        market: MarketId,
        owner: [u8; 20],
        side: Side,
        size: u64,
    },
    /// A prediction-binary position was cash-settled. Longs receive
    /// `payoff_per_share * size` credited to their balance; shorts have
    /// `(1.0 - payoff_per_share) * size` debited. Payoff is $1 for the winner
    /// and $0 for the loser.
    PredictionSettled {
        impact_market_id: ImpactMarketId,
        market: MarketId,
        owner: [u8; 20],
        side: Side,
        size: u64,
        /// Payoff per share in micro-USDC ($1.00 = 1_000_000, $0.00 = 0).
        payoff_per_share: u64,
        /// Signed cash delta applied to owner balance (micro-USDC).
        cash_delta: i64,
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
    /// Per-pool variant — the legacy event without `pool_id` continues to
    /// be emitted for pool 0 to preserve consumer compatibility.
    InsuranceFundUpdated {
        /// Pool the change applied to. 0 for legacy/majors pool (the
        /// bare `InsuranceFund` state key); 1+ for newer pools keyed
        /// under `InsuranceFundByPool`. Added 2026-04-25 with the
        /// four-tier waterfall.
        #[serde(default)]
        pool_id: u8,
        /// New total balance in micro-USDC (can be negative if fund is depleted).
        balance: i64,
        /// Change amount in micro-USDC (positive = inflow, negative = outflow).
        delta: i64,
    },
    /// Tier 0 of the bad-debt waterfall. HLP absorbed `amount` of
    /// liquidation deficit, leaving HLP balance at `hlp_balance_after`.
    /// Emitted only when HLP is enabled AND its balance was above the
    /// floor at draw time. Once HLP hits the floor, further deficits
    /// route to Tier 1 (per-pool IF) and this event stops firing.
    HlpAbsorbed {
        /// Pool the liquidation came from (informational — HLP is
        /// pool-agnostic at Tier 0).
        pool_id: u8,
        /// Microusdc absorbed by HLP this draw.
        amount: u64,
        /// HLP balance after the draw.
        hlp_balance_after: i64,
    },
    /// Tier 2 of the bad-debt waterfall. The pool's IF was insufficient
    /// to fully absorb a liquidation deficit, so the residual was
    /// distributed pro-rata across all open positions in the pool,
    /// capped at `socialized_cap_bps × pool_notional / 10_000` per
    /// event. Each affected account is debited proportionally; the
    /// list is included so off-chain consumers can reconstruct who
    /// took what haircut.
    SocializedLossApplied {
        pool_id: u8,
        /// Microusdc actually collected this event — sum of per-counterparty
        /// debits. Floored by each counterparty's balance (current-balance
        /// constraint, not the spec-pure "negative balance allowed" model).
        total_amount: u64,
        /// Microusdc the cap-respecting model says we *should* have
        /// absorbed: `min(requested, socialized_cap_bps × pool_notional /
        /// 10_000)`. When `total_amount < cap_target`, the gap reflects
        /// counterparties that had zero balance at the moment of the
        /// shock — under the spec-pure model these would have been pushed
        /// to negative balance and re-liquidated next block. The engine
        /// instead lets the gap roll through to Tier 3 (ADL), trading
        /// spec fidelity for simpler accounting (no negative-balance
        /// state migration). Off-chain consumers compare `total_amount`
        /// vs `cap_target` to detect the deviation. Audit 2026-04-25 #4.
        cap_target: u64,
        /// Cap in bps applied to the pool's two-sided notional. Echoed
        /// here for auditability; matches the
        /// `InsuranceFundConfig.socialized_cap_bps` of the time.
        cap_bps: u32,
        /// Number of open positions that contributed.
        affected_count: u32,
    },
    /// Tier 3 of the bad-debt waterfall. A profitable counterparty was
    /// auto-deleveraged (force-closed at the bankruptcy price of the
    /// counterparty being liquidated) because all prior tiers were
    /// exhausted. The ADL queue ranks positions by
    /// `unrealized_pnl × leverage_used` descending; this event is
    /// emitted once per ADL'd position.
    PositionAutoDeleveraged {
        /// Owner whose position was force-closed.
        owner: [u8; 20],
        market: MarketId,
        side: Side,
        /// Number of contracts force-closed in this leg. May be less
        /// than the ADL'd account's full position when the deficit is
        /// covered by a partial close (per audit 2026-04-25 P0 #2 fix);
        /// the remainder of the position keeps its original entry.
        size: u64,
        /// Price the position was actually closed at — the **liquidated
        /// trader's bankruptcy price** `bp = entry − σ × balance / size`
        /// (one `bp` per liquidation event, threaded through to every
        /// ADL leg in the same waterfall call). Equals `close_price_spec`
        /// after the audit P0 #2 fix landed; the two fields are retained
        /// separately for forward compatibility with future settlement-
        /// price experimentation.
        close_price: u64,
        /// Bankruptcy price the spec (`docs/adl-vs-socialized-loss.md`
        /// §3.5) says the position should be closed at. Currently equal
        /// to `close_price`; tracked separately so any future deviation
        /// (e.g., adding a "max haircut per ADL leg" cap that would
        /// re-introduce a spec gap) can be audited via this field.
        close_price_spec: u64,
        /// Realized PnL credited to the ADL'd counterparty at
        /// `close_price` for the closed `size`. Includes any rounding
        /// surplus credited back when ceil-div over-extracted (so the
        /// counterparty's net surrender equals exactly the residual
        /// covered by this leg, not residual + rounding overshoot).
        /// May be negative if `bp` would imply a realized loss for the
        /// counterparty — note that for the alpha-deferred deviation,
        /// we cap credit at 0 rather than driving the counterparty into
        /// negative balance.
        realized_pnl: i64,
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
    /// Emitted exactly once at the end of every market-order tx that passes
    /// envelope checks, regardless of how many fills happened.
    ///
    /// Market orders use IOC semantics — any unfilled remainder is silently
    /// dropped. Without this event, callers would have to count downstream
    /// `TradeExecuted` events to learn whether a market order actually moved
    /// any quantity, and could not distinguish "no counterparty" from "fully
    /// filled and the trade events arrived in a different stream view".
    ///
    /// Off-chain monitors and SDKs should treat this as the authoritative
    /// "did my market order do anything?" signal:
    ///   - `filled_quantity == requested_quantity` → fully filled
    ///   - `0 < filled_quantity < requested_quantity` → partial fill, rest dropped
    ///   - `filled_quantity == 0` → no counterparty (or all counterparties were
    ///     the taker themselves and got rejected by self-match prevention)
    MarketOrderProcessed {
        market: MarketId,
        owner: [u8; 20],
        side: Side,
        requested_quantity: u64,
        filled_quantity: u64,
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
    InvalidNonce {
        expected: u64,
        got: u64,
    },
    MarketAlreadyExists(MarketId),
    InvalidMarketConfig(String),
    ImpactMarketAlreadyExists(ImpactMarketId),
    ImpactMarketNotFound(ImpactMarketId),
    /// Attempted to place an order on a conditional/binary book whose parent
    /// impact market is already resolved or voided.
    MarketClosedForTrading(MarketId),
    /// Binary-book order outside the [0, BINARY_PRICE_MAX] range.
    BinaryPriceOutOfRange,
    /// ResolveEvent called with an invalid outcome for the current state.
    InvalidResolution(String),
    /// A fill would push the taker's absolute net position past
    /// `MarketConfig.max_position_size`. Engine-level cap enforced at
    /// placement time so a single whale can't accumulate unbounded
    /// exposure past protocol limits, regardless of margin.
    PositionLimitExceeded {
        market: MarketId,
        limit: u64,
        would_be: u64,
    },
    /// Rejected `OracleUpdate` whose `publish_time_ms` is not strictly
    /// greater than the last accepted update for this market. Replay
    /// protection per audit B3 (2026-04-23).
    OracleTimestampNotMonotonic {
        market: MarketId,
        stored: u64,
        submitted: u64,
    },
    /// Account would touch more impact markets than the scenario margin
    /// engine can enumerate (`MAX_IMPACT_MARKETS_PER_ACCOUNT`). Returned
    /// instead of `InsufficientMargin` so clients can distinguish
    /// "basket exceeds enumeration cap" from "collateral shortfall."
    /// Audit 2026-04-25 P3.
    TooManyActiveImpactMarkets {
        current: u32,
        max: u32,
    },
    /// Net-delta margin grouping found legs of the same group with
    /// disagreeing settle prices — upstream data corruption (different
    /// markets in the same `underlying_market_id` group should resolve
    /// to identical settles per scenario). Distinct from `Overflow`,
    /// which the same path used to return as a placeholder. Audit
    /// 2026-04-25 P2 #10.
    SettlementPriceMismatch {
        market: MarketId,
        expected: u64,
        got: u64,
    },
    /// Rejected `OracleUpdate` for an impact-family market (CPY/CPN/EBY/EBN).
    /// Per the no-oracle MTM redesign (2026-04-26), these markets mark
    /// off the book directly and have no oracle layer. The only oracle
    /// reading happens at resolution, against the underlying perp.
    /// Returned defensively so a misbehaving feeder or replayed update
    /// can't corrupt the impact market's state.
    ///
    /// Variant defined in Phase A but not yet wired in `handle_oracle_update`
    /// (see comment there): the engine-side reject lands in Phase D
    /// alongside the `get_mark_price` book-mid fallback and the rewrite
    /// of impact-market test setup helpers, so the rollout is atomic.
    OracleNotApplicable {
        market: MarketId,
    },
    /// `PlaceOrder` with `post_only=true` would have crossed the book on
    /// placement. Rejected without taking, so makers can guarantee
    /// maker-side fills.
    PostOnlyWouldCross,
    /// `PlaceOrder` or `MarketOrder` with `reduce_only=true` was same-side
    /// as the existing position (would increase exposure) or no position
    /// existed at all. Reduce-only orders are required to actually reduce
    /// or close a position.
    ReduceOnlyWouldIncrease,
    /// A test/admin action (`RunLiquidationSweep`, `RunFundingTick`,
    /// `ForceLiquidate`) was rejected because the engine isn't configured
    /// to accept them in this deployment, or the position the action
    /// referenced doesn't exist.
    TestActionRejected(String),
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
            ExecError::ImpactMarketAlreadyExists(_) => 24,
            ExecError::ImpactMarketNotFound(_) => 25,
            ExecError::MarketClosedForTrading(_) => 26,
            ExecError::BinaryPriceOutOfRange => 27,
            ExecError::InvalidResolution(_) => 28,
            ExecError::PositionLimitExceeded { .. } => 29,
            ExecError::OracleTimestampNotMonotonic { .. } => 30,
            ExecError::TooManyActiveImpactMarkets { .. } => 31,
            ExecError::SettlementPriceMismatch { .. } => 32,
            ExecError::OracleNotApplicable { .. } => 33,
            ExecError::PostOnlyWouldCross => 34,
            ExecError::ReduceOnlyWouldIncrease => 35,
            ExecError::TestActionRejected(_) => 36,
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
            ExecError::ImpactMarketAlreadyExists(id) => {
                write!(f, "impact market already exists: {id}")
            }
            ExecError::ImpactMarketNotFound(id) => write!(f, "impact market not found: {id}"),
            ExecError::MarketClosedForTrading(id) => {
                write!(f, "market closed for trading: {id}")
            }
            ExecError::BinaryPriceOutOfRange => write!(
                f,
                "prediction-binary price must be in [0, {}]",
                BINARY_PRICE_MAX
            ),
            ExecError::InvalidResolution(msg) => write!(f, "invalid resolution: {msg}"),
            ExecError::PositionLimitExceeded {
                market,
                limit,
                would_be,
            } => write!(
                f,
                "position limit exceeded on market {market}: would be {would_be}, cap {limit}"
            ),
            ExecError::OracleTimestampNotMonotonic {
                market,
                stored,
                submitted,
            } => write!(
                f,
                "oracle publish_time_ms not strictly monotonic on market {market}: \
                stored {stored}, submitted {submitted} (submitted must be > stored)"
            ),
            ExecError::TooManyActiveImpactMarkets { current, max } => write!(
                f,
                "too many active impact markets in basket: current {current}, cap {max}"
            ),
            ExecError::SettlementPriceMismatch {
                market,
                expected,
                got,
            } => write!(
                f,
                "settle price disagreement on market {market}: expected {expected} (group key), got {got}"
            ),
            ExecError::OracleNotApplicable { market } => write!(
                f,
                "oracle update rejected for market {market}: impact-family markets mark off the book directly and have no oracle layer (post 2026-04-26 redesign)"
            ),
            ExecError::PostOnlyWouldCross => write!(
                f,
                "post-only order would cross the book on placement; rejected"
            ),
            ExecError::ReduceOnlyWouldIncrease => write!(
                f,
                "reduce-only order rejected: would increase exposure (same-side as position) or no position to reduce"
            ),
            ExecError::TestActionRejected(msg) => write!(f, "test action rejected: {msg}"),
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
