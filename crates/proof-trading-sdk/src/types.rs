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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, derive_more::Display)]
pub enum Branch {
    #[display("yes")]
    Yes = 1,
    #[display("no")]
    No = 2,
}

/// Outcome of an impact-market event resolution.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, derive_more::Display)]
pub enum Outcome {
    #[display("yes")]
    Yes = 1,
    #[display("no")]
    No = 2,
    /// Auto-voided (neither branch won — e.g., resolver timeout under the auto-void policy).
    #[display("void")]
    Void = 3,
}

/// BE-54: how the YES/NO outcome of an impact-market event is determined
/// at deadline. Stored on [`ImpactMarketInfo`] (and carried on
/// [`CreateImpactMarket`]). `RelayerAttested` is the legacy default —
/// the resolver supplies the outcome and the engine trusts it. The two
/// auto-resolve modes derive YES/NO from an on-chain oracle reading,
/// turning the relayer-supplied `outcome` field into a verifiable assertion
/// (the engine recomputes and rejects on mismatch).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, derive_more::Display)]
pub enum EventOracleSource {
    /// Resolution determined by the underlying perp's oracle reading at
    /// `ResolveEvent` time, compared against `strike_price`. The classic
    /// "is BTC above $X at expiry?" pattern.
    #[display("underlying_price_vs_strike:{strike_price}:{comparison}")]
    UnderlyingPriceVsStrike {
        strike_price: u64,
        comparison: PriceComparison,
    },
    /// Resolution determined by a different on-chain market's oracle
    /// (e.g. ETH event whose outcome is gated on BTC's price). The
    /// `market` MUST exist and have a current oracle price at resolution
    /// time; otherwise the resolution is rejected.
    #[display("market_oracle:{market}:{strike_price}:{comparison}")]
    MarketOracle {
        market: MarketId,
        strike_price: u64,
        comparison: PriceComparison,
    },
    /// Resolution by relayer attestation only — the legacy/default path.
    /// The relayer-supplied `outcome` is taken at face value (still subject
    /// to the existing relayer-allowlist signature check). Use for events
    /// where there is no on-chain price (e.g. "did Apple announce X?").
    #[display("relayer_attested")]
    RelayerAttested,
}

/// BE-54: comparison operator used by the auto-resolve oracle modes.
/// `YES` fires iff `oracle_price <comparison> strike_price` (e.g.
/// `GreaterThan` means the event resolves YES when the oracle reading is
/// strictly greater than the strike). Equality on the boundary is
/// distinguished by the `OrEqual` variants.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, derive_more::Display)]
pub enum PriceComparison {
    #[display("gt")]
    GreaterThan,
    #[display("lt")]
    LessThan,
    #[display("gte")]
    GreaterThanOrEqual,
    #[display("lte")]
    LessThanOrEqual,
}

impl PriceComparison {
    /// Apply the comparison: returns true iff the YES branch wins.
    pub fn apply(self, oracle_price: u64, strike_price: u64) -> bool {
        match self {
            PriceComparison::GreaterThan => oracle_price > strike_price,
            PriceComparison::LessThan => oracle_price < strike_price,
            PriceComparison::GreaterThanOrEqual => oracle_price >= strike_price,
            PriceComparison::LessThanOrEqual => oracle_price <= strike_price,
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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum MarketKind {
    /// Regular perpetual future (BTC-PERP, ETH-PERP, SOL-PERP, etc.).
    #[default]
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

/// Mark-price source for a perp market. Selects how `get_mark_price`
/// derives the mark used for margin checks, liquidation triggers, and
/// unrealized-PnL accounting.
///
/// Defaults to `OracleOnly` (the legacy single-source path) so existing
/// on-chain `MarketConfig` records and freshly-created markets keep
/// today's behavior byte-for-byte. Operators flip individual markets
/// to `Median` via `UpdateMarketFees` once they want the multi-source
/// guard. **No big-bang switch** — each market opts in independently.
///
/// Wire layout: encoded as a positional tag (msgpack) — `OracleOnly`
/// = 0, `Median` = 1. New variants append.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum MarkSourceMode {
    /// Mark = oracle price. Single-source; same as the pre-BE-31
    /// engine. Failure mode: a stale or attacked oracle moves mark
    /// without a second opinion.
    #[default]
    OracleOnly,
    /// Mark = median of available sources (oracle, book-mid, and —
    /// once Phase B lands — composite CEX index). When fewer than 2
    /// sources are available, falls through to the average of 2, then
    /// to the single remaining source. When zero sources are
    /// available, returns `UnknownMarket`.
    ///
    /// The thin-book guard rejects book-mid from the median when the
    /// top-of-book spread exceeds `MarketConfig.max_mark_spread_bps`
    /// (a single $50-spread quote pair on an otherwise empty book
    /// can poison the median otherwise).
    Median,
}

/// Built-in default for the thin-book spread guard, used when
/// `MarketConfig.max_mark_spread_bps` is `0` (the serde default for
/// existing on-chain records). 100 bps = 1% of mid; book-mid is
/// excluded from the median when the top-of-book spread exceeds this.
pub const DEFAULT_MAX_MARK_SPREAD_BPS: u32 = 100;

/// Built-in default staleness threshold for the composite-CEX price,
/// used when `MarketConfig.cex_composite_staleness_ms` is `0`. 30s
/// = enough headroom for a 1s feeder cadence to miss a few cycles
/// without dropping out of the median; tight enough that a stuck
/// feeder shows up in the mark drift within minutes.
pub const DEFAULT_CEX_COMPOSITE_STALENESS_MS: u64 = 30_000;

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
    /// BE-54: how the YES/NO outcome is determined at deadline. Defaults
    /// to `RelayerAttested` for back-compat with pre-BE-54 records (which
    /// decode as `None` here, treated as `RelayerAttested` by the engine).
    /// Stored in addition to `CreateImpactMarket.oracle_source` so the
    /// resolver doesn't need to re-scan the original action bytes.
    #[serde(default)]
    pub oracle_source: Option<EventOracleSource>,
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/// Order/position direction. Discriminant values (1, 2) are part of the wire format.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, derive_more::Display)]
pub enum Side {
    #[display("buy")]
    Buy = 1,
    #[display("sell")]
    Sell = 2,
}

/// Time-in-force policy for a `PlaceOrder`. Controls how unmatched
/// quantity is handled after crossing the book. Serialized with serde
/// default-to-0 so old wire records decode as `Gtc`.
///
/// Wire encoding: msgpack enum variant (`Gtc`, `Ioc`, `Fok`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TimeInForce {
    /// Good-Till-Cancelled: unmatched quantity rests on the book until
    /// explicitly cancelled or TTL-expired. The default.
    #[default]
    Gtc = 0,
    /// Immediate-Or-Cancel: unmatched quantity after crossing is dropped
    /// (never rests on the book). Same IOC semantics as a `MarketOrder`
    /// but with a price limit — will not cross beyond it.
    Ioc = 1,
    /// Fill-Or-Kill: the order must be fully filled immediately at or better
    /// than the limit price. If the currently visible book cannot fill the
    /// whole quantity, the engine rejects before mutating state.
    Fok = 2,
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
    /// Optional client-assigned order ID. Stored on resting orders so
    /// fills/cancels can be reconciled without joining against the
    /// original placement request. Zero is reserved as the event-level
    /// "absent" sentinel; the optional storage field preserves the
    /// engine semantics.
    #[serde(default)]
    pub client_order_id: Option<u64>,
    /// Quantity originally accepted onto the book. Legacy orders decode
    /// with `0`, in which case event helpers fall back to the current
    /// remaining quantity.
    #[serde(default)]
    pub original_quantity: u64,
    /// Cumulative quantity filled while this order rested as maker.
    #[serde(default)]
    pub filled_quantity: u64,
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
    /// Monotonic FIFO priority within a price level. Defaults to `0` for
    /// legacy orders, in which case readers fall back to `id`. Keeping this
    /// separate lets amend preserve the public order id while still resetting
    /// queue priority when a quote moves price or increases size.
    #[serde(default)]
    pub queue_priority: u64,
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
    /// Maximum age (ms) of the oracle reading at the time of any
    /// margin/order/liquidation read. `0 = no check (back-compat)`.
    ///
    /// Oracle staleness was previously enforced only at `ResolveEvent`
    /// (60 s window) and replay-protection in `OracleUpdate`. Order
    /// placement, margin checks, and liquidation read `get_mark_price`
    /// without checking the oracle's age, so a node with a stuck
    /// feeder silently mispriced everything. With this field set on a
    /// market, the engine refuses to read an oracle whose
    /// `publish_time_ms` is older than `block_time_ms -
    /// mark_price_max_oracle_age_ms` and returns `ExecError::StaleOracle`
    /// (BE-33, 2026-05-03).
    ///
    /// Skipped on impact-family markets (CPY/CPN/EBY/EBN) — those
    /// mark off the book directly via the EWMA fallback and have no
    /// continuous oracle layer post the 2026-04-26 redesign.
    ///
    /// Recommended value: 30_000 (30 s) for major perps. Existing
    /// MarketConfig records decode with `mark_price_max_oracle_age_ms = 0`
    /// thanks to `#[serde(default)]`, preserving back-compat.
    #[serde(default)]
    pub mark_price_max_oracle_age_ms: u64,
    /// Volume-based fee tier table. Empty (default for legacy
    /// MarketConfig records) falls back to flat `taker_fee_bps` /
    /// `maker_fee_bps`. Non-empty tables are evaluated at fill time
    /// against each account's rolling 30-day taker volume and apply
    /// tenth-bps fees. Negative maker values are rebates paid from
    /// the FeePool.
    ///
    /// Added after `mark_price_max_oracle_age_ms` so already-merged
    /// BE-33 records keep their positional wire/state layout.
    #[serde(default)]
    pub fee_tiers: Vec<FeeTier>,
    /// Tick size in micro-USDC. Order prices must be exact multiples
    /// of `tick_size`. Zero (default) disables the check, preserving
    /// pre-BE-48 behavior. Recommended: $0.01 = 10_000 µUSDC for
    /// crypto perps; $0.001 = 1_000 µUSDC for high-precision impact
    /// market child books.
    #[serde(default)]
    pub tick_size: u64,
    /// Lot size in contracts. Order quantities must be exact multiples
    /// of `lot_size`. Zero (default) disables the check, preserving
    /// pre-BE-48 behavior. Recommended: 1 for whole-contract markets
    /// (BTC perps), 100 for high-volume markets where round lots
    /// improve readability.
    #[serde(default)]
    pub lot_size: u64,
    /// Primary oracle signer for this market (BE-50). When `Some`,
    /// this signer's `OracleUpdate` is always accepted (subject to
    /// the existing monotonic publish-time check).
    ///
    /// Other authorized signers (the "fallback" oracles) are accepted
    /// only when the market's last oracle update — by *any* signer —
    /// is older than `oracle_staleness_ms`. This means the gate works
    /// recursively: once a fallback takes over, the next fallback is
    /// gated against the active fallback's timestamp, not the primary's.
    /// Net effect: fail-over chains through fallbacks rather than
    /// requiring the primary itself to recover.
    ///
    /// `None` (default) preserves the pre-BE-50 behavior where any
    /// authorized signer can update at any time.
    #[serde(default)]
    pub primary_oracle_signer: Option<[u8; 20]>,
    /// Window (ms) the primary oracle has to publish before fallback
    /// signers can take over. **Zero disables the gate entirely** —
    /// any authorized relayer can post `OracleUpdate` regardless of
    /// how recent the primary's update was. Use a non-zero value
    /// when you want primary-preferred operation with fallback only
    /// on silence; use zero when you want simple
    /// "any-authorized-signer" semantics. Set per-market via
    /// `UpdateMarketFees`.
    #[serde(default)]
    pub oracle_staleness_ms: u64,
    /// Mark-price source mode. See `MarkSourceMode` docstring for
    /// semantics. `serde(default)` -> `OracleOnly` so existing on-chain
    /// `MarketConfig` records and the genesis path are byte-identical
    /// to today. Operators flip individual perp markets to `Median`
    /// via `UpdateMarketFees` once Phase A is live.
    ///
    /// Ignored on impact-family markets (`ConditionalPerp`,
    /// `PredictionBinary`) - those keep marking off the book EWMA per
    /// the no-oracle-MTM redesign (2026-04-26).
    ///
    /// Linear: BE-31 Phase A.
    #[serde(default)]
    pub mark_source_mode: MarkSourceMode,
    /// Top-of-book spread cap (bps) for the thin-book guard on
    /// `MarkSourceMode::Median`. When the top-of-book spread exceeds
    /// this, book-mid is excluded from the median.
    ///
    /// Zero means "use the built-in default `DEFAULT_MAX_MARK_SPREAD_BPS`
    /// (100 bps = 1%)" - which is also the value existing on-chain
    /// `MarketConfig` records (written before this field existed)
    /// decode to thanks to `serde(default)`. Operators tighten or
    /// loosen per-market via `UpdateMarketFees`.
    ///
    /// Linear: BE-31 Phase A.
    #[serde(default)]
    pub max_mark_spread_bps: u32,
    /// BE-31 Phase B: max age (ms) for a composite-CEX price update
    /// before the engine excludes it from the median. Zero means
    /// "use the built-in default `DEFAULT_CEX_COMPOSITE_STALENESS_MS`
    /// (30s)" — also the value existing on-chain `MarketConfig`
    /// records (written before this field existed) decode to thanks
    /// to `serde(default)`. Ignored unless `mark_source_mode` is
    /// `Median`.
    #[serde(default)]
    pub cex_composite_staleness_ms: u64,
    /// BE-26: enable partial liquidation for this market. When true,
    /// the liquidation engine closes positions one at a time and
    /// rechecks maintenance margin after each close. If MM holds after
    /// closing a single market's position, the account is considered
    /// healthy and the remaining positions are not closed.
    ///
    /// When false (default, backward-compatible with existing
    /// `MarketConfig` records), the legacy all-or-nothing liquidation
    /// runs: every position in the owner's portfolio closes when any
    /// market is under MM.
    #[serde(default)]
    pub partial_liquidation_enabled: bool,
}

/// Per-tier fee schedule for the volume-based maker-rebate program.
///
/// `*_tenth_bps` lets the engine express sub-bps fees (e.g. 1.5 bps =
/// 15 tenth-bps) and signed maker rebates without losing precision.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeeTier {
    /// Minimum 30-day rolling taker volume (micro-USDC) required to
    /// qualify for this tier. The lowest tier should be 0.
    pub min_30d_volume_micro_usdc: u64,
    /// Maker fee in tenth-basis-points. Negative means maker rebate.
    pub maker_fee_tenth_bps: i16,
    /// Taker fee in tenth-basis-points. The configured alpha tiers keep
    /// this non-negative so the protocol never pays takers.
    pub taker_fee_tenth_bps: i16,
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

// The `Action` enum is generated by `impl_action_encoding!` in `codec.rs`,
// paired with each variant's wire byte code. Re-exported here so all existing
// `crate::types::Action` paths continue to work.
pub use crate::codec::Action;

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

/// Pick a per-account override on the initial-margin ratio for one
/// market. The engine uses `max(market.im_bps, user_im_bps)` on
/// every IM-gated check (place order, withdraw post-trade margin
/// review, scenario IM enumeration), so users can choose a more
/// conservative IM but never circumvent the market's risk floor.
///
/// `user_im_bps == 0` clears the override (equivalent to "use the
/// market default"). The engine validates `user_im_bps == 0 ||
/// user_im_bps >= market.im_bps` at admission; otherwise rejects
/// with `ExecError::UserLeverageBelowMarketIm`.
///
/// This is a user-signed action (not relayer-signed). Each owner
/// can only set their own override — the dispatcher enforces
/// `signer == owner` before the handler runs.
///
/// BE-16, 2026-05-03.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SetUserMarketLeverage {
    pub owner: [u8; 20],
    pub market: MarketId,
    /// Initial margin ratio in basis points the user wants to use
    /// for this market. `0` clears the override; otherwise must be
    /// `>= market.im_bps`.
    pub user_im_bps: u32,
}

/// Close an entire position on a market by placing an opposite-side
/// immediate-or-cancel order at oracle±spread. Idempotent on
/// already-closed positions: calling on a zero position returns code=0
/// without emitting events. Semantically equivalent to a high-priority
/// market order but replaces the friction of opposite-side placement or
/// order cancellation. User-signed (owner must match position owner).
///
/// S49, Auros documentation plan (2026-05-09) §1 line 11; matches
/// the Hyperliquid pattern.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ClosePosition {
    pub market: MarketId,
    pub owner: [u8; 20],
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
    /// Active resting orders are unique per owner/client_order_id; reusing
    /// an ID while an earlier order is still live is rejected.
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
    /// Time-in-force policy. Defaults to `Gtc` for backward compat with
    /// pre-TIF wire records. `Ioc` drops unfilled quantity after crossing.
    #[serde(default)]
    pub time_in_force: TimeInForce,
}

/// Cancel a resting order. Only the owner (or an authorized agent) may cancel.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CancelOrder {
    pub order_id: OrderId,
    pub owner: [u8; 20],
}

/// Cancel a resting order by client-assigned order id.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CancelClientOrder {
    pub owner: [u8; 20],
    pub client_order_id: u64,
}

/// Cancel all resting orders for an account. If `market` is set, only orders
/// on that market are removed.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CancelAllOrders {
    pub owner: [u8; 20],
    #[serde(default)]
    pub market: Option<MarketId>,
}

/// Atomically cancel a resting order and place a replacement order.
///
/// Exactly one of `cancel_order_id` or `cancel_client_order_id` must be set.
/// The replacement uses the same semantics as `PlaceOrder`: it may cross,
/// be post-only/reduce-only, and can specify GTC/IOC/FOK.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CancelReplaceOrder {
    pub owner: [u8; 20],
    #[serde(default)]
    pub cancel_order_id: Option<OrderId>,
    #[serde(default)]
    pub cancel_client_order_id: Option<u64>,
    pub market: MarketId,
    pub side: Side,
    pub price: u64,
    pub quantity: u64,
    pub client_order_id: Option<u64>,
    #[serde(default)]
    pub post_only: bool,
    #[serde(default)]
    pub reduce_only: bool,
    #[serde(default)]
    pub time_in_force: TimeInForce,
}

/// Amend a resting order without changing its exchange order id.
///
/// `new_quantity` is the new total accepted quantity, not the remaining
/// quantity. It must be greater than the order's cumulative maker fill. Same
/// price size reductions preserve queue priority; price changes and size
/// increases reset priority.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AmendOrder {
    pub owner: [u8; 20],
    pub order_id: OrderId,
    #[serde(default)]
    pub new_price: Option<u64>,
    #[serde(default)]
    pub new_quantity: Option<u64>,
}

/// Push a new oracle (mark) price. Requires an authorized oracle signer
/// AND a strictly increasing `publish_time_ms` per market.
///
/// **Why the timestamp check** (added 2026-04-23, audit finding B3):
/// before this field existed, `OracleUpdate` relied only on the envelope
/// nonce for transaction replay protection, while the handler read no
/// previous oracle timestamp before overwriting the price. A different
/// previously-signed update carrying stale price data could rewind the
/// mark price to a historical value, triggering mass liquidations or
/// arbitrage at stale prices.
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

/// Composite-CEX price update — BE-31 Phase B's third source for the
/// multi-source mark-price median. Carries the median (or VWAP) of N
/// off-chain CEX feeds (Binance / OKX / Bybit / Coinbase) computed by
/// a separate off-chain feeder process.
///
/// **Why it's separate from `OracleUpdate`**:
///   1. Different signer set — composite uses a feeder-specific
///      allowlist, not the Pyth oracle relay's. Different trust model.
///   2. Different staleness gate — composite is polled every ~1s vs.
///      Pyth's per-block cadence; rejected from the median when older
///      than `cex_composite_staleness_ms` (default 30s).
///   3. Different aggregation — Pyth oracle is a single value; the
///      composite is explicitly a median across multiple venues, with
///      `n_sources` carried for observability.
///
/// Same monotonicity-of-publish-time replay guard as `OracleUpdate`
/// (audit B3, 2026-04-23).
///
/// Stored under `keys::CexCompositePrice` keyspace, indexed by market.
/// Read by `compute_median_mark_price` as the third source when the
/// market is in `MarkSourceMode::Median`. Has no effect on
/// `OracleOnly` markets.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OracleUpdateComposite {
    pub market: MarketId,
    /// Composite price in micro-USDC (median or VWAP of `n_sources`
    /// off-chain CEX feeds, computed off-chain by the feeder).
    pub price: u64,
    /// Number of CEX feeds that went into the composite. Carried for
    /// observability — a composite from 1 venue is much weaker
    /// signal than one from 4. Field is informational; the engine
    /// doesn't gate on it.
    #[serde(default)]
    pub n_sources: u8,
    /// Authorized feeder signer (20 bytes).
    pub signer: [u8; 20],
    /// Feeder's own publish timestamp in ms since Unix epoch. Must
    /// be strictly greater than the last accepted update's
    /// `publish_time_ms` for the same market — replay guard.
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

impl Default for CreateMarket {
    /// Conservative defaults that match the production seed config
    /// (`scripts/seed.ts`): 5% IM, 2.5% MM, 5/2 bps fees, 60 s funding
    /// cadence with a 30% per-interval cap, pool 0. Tests that just
    /// need *some* CreateMarket instance can `..Default::default()`
    /// instead of repeating the full struct literal.
    fn default() -> Self {
        Self {
            market: 0,
            im_bps: 500,
            mm_bps: 250,
            taker_fee_bps: 5,
            maker_fee_bps: 2,
            signer: [0u8; 20],
            funding_interval_ms: 60_000,
            max_funding_rate_bps: 3000,
            pool_id: 0,
        }
    }
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

/// Why a Solana deposit was rejected by the relayer. Mirrors the small
/// closed set of failure modes the bridge can detect off-chain — anything
/// else falls under [`FailDepositReason::Other`] with a free-text reason
/// in the action's `note` field.
///
/// Wire form: enum discriminant. Adding a variant is a wire-compatible
/// change for old decoders ONLY when appended at the end (msgpack maps
/// missing variants to a decode error). Treat the existing four as
/// stable; bump a new constant if you need to extend.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FailDepositReason {
    /// Solana transaction couldn't be parsed (invalid instruction layout,
    /// missing token-2022 metadata, etc.).
    MalformedTx,
    /// Deposit was for a token mint we don't accept.
    UnsupportedToken,
    /// Amount under the bridge's dust threshold; processing cost would
    /// exceed the deposit value.
    BelowMinimum,
    /// Catch-all for relayer-side errors not covered above. Keep usage
    /// rare so the breakdown stays meaningful in metrics.
    Other,
}

impl fmt::Display for FailDepositReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FailDepositReason::MalformedTx => f.write_str("malformed_tx"),
            FailDepositReason::UnsupportedToken => f.write_str("unsupported_token"),
            FailDepositReason::BelowMinimum => f.write_str("below_minimum"),
            FailDepositReason::Other => f.write_str("other"),
        }
    }
}

/// Relayer marks a Solana deposit signature as permanently failed.
/// The user is NOT credited — they simply never see the deposit. The
/// signature is recorded under a separate "failed" key so any future
/// ConfirmDeposit OR FailDeposit referencing the same signature is a
/// silent no-op (idempotent).
///
/// `solana_signature` uses `Vec<u8>` (not `[u8; 64]`) so the wire bytes
/// are byte-for-byte identical to the matching `ConfirmDeposit.solana_tx_sig`
/// — the deduplication relies on this identity. Solana sigs are typically
/// 64 bytes; the engine does not currently length-validate but the
/// gateway should reject anything else.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FailDeposit {
    /// Solana transaction signature, same bytes that the original
    /// `ConfirmDeposit.solana_tx_sig` would carry. Lookup against the
    /// processed-deposits set is byte-equality.
    pub solana_signature: Vec<u8>,
    /// Structured reason for failure (for event-stream metrics + ops UX).
    pub reason: FailDepositReason,
    /// Authorized relayer signer (mirrors `ConfirmDeposit.signer`). The
    /// envelope signer's derived address must equal this AND must be on
    /// the relayer allowlist; otherwise `UnauthorizedRelayer`.
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
    /// BE-54: how this event's YES/NO outcome is determined at deadline.
    /// Optional — `None` (or absent on the wire, via `serde(default)`) means
    /// `RelayerAttested` (the legacy default — the resolver supplies the
    /// outcome). Two auto-resolve modes derive YES/NO from an on-chain
    /// oracle; in those modes `ResolveEvent.outcome` becomes a verifiable
    /// assertion (engine recomputes and rejects on mismatch). Field at the
    /// END of the struct so old SDK clients (12-element arrays) continue
    /// to decode cleanly via the wire's `serde(default)` rule.
    #[serde(default)]
    pub oracle_source: Option<EventOracleSource>,
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
    /// Tick size in micro-USDC. `None` = leave unchanged. Setting to 0
    /// disables the tick check (any price accepted). BE-48.
    #[serde(default)]
    pub tick_size: Option<u64>,
    /// Lot size in contracts. `None` = leave unchanged. Setting to 0
    /// disables the lot check (any quantity accepted). BE-48.
    #[serde(default)]
    pub lot_size: Option<u64>,
    /// Primary oracle signer for this market. `None` = leave unchanged.
    /// `Some(addr)` sets the primary to `addr`. BE-50.
    ///
    /// Wire-format note: msgpack via rmp-serde collapses `Option<Option<T>>`
    /// in positional arrays — both `None` and `Some(None)` encode as `nil`,
    /// so we can't distinguish "leave alone" from "clear" with bare option
    /// nesting. To clear the primary without re-creating the market, send
    /// `Some([0u8; 20])` — the engine treats the all-zero address as a
    /// "clear primary" sentinel (mirrors the `FEE_OVERRIDE_REVERT_SENTINEL`
    /// pattern from BE-46.1). Real signer addresses are derived from
    /// keccak256 of an Ed25519 public key, which collides with the all-zero
    /// address only with negligible probability — safe to use as a sentinel.
    ///
    /// Alternative: setting `oracle_staleness_ms = 0` disables the gate
    /// entirely (any authorized relayer accepted) without disturbing the
    /// primary slot — useful when you want to suspend the gate temporarily.
    #[serde(default)]
    pub primary_oracle_signer: Option<[u8; 20]>,
    /// Oracle staleness threshold in ms. `None` = leave unchanged.
    /// Only consulted when `primary_oracle_signer` is set; see
    /// `MarketConfig::oracle_staleness_ms`. BE-50.
    #[serde(default)]
    pub oracle_staleness_ms: Option<u64>,
    /// New mark-source mode (BE-31 Phase A). `None` = leave unchanged.
    /// `Some(MarkSourceMode::Median)` opts the market into the
    /// multi-source median path. Has no effect on impact-family
    /// markets - those always read EWMA per the no-oracle-MTM redesign.
    ///
    /// Operational note: flipping `OracleOnly -> Median` on a live
    /// market that has a thin or absent book returns oracle-only at
    /// the floor - same value as the old path until the book is
    /// liquid enough to pass the spread guard. Safe to roll out
    /// per-market; no chain wipe.
    #[serde(default)]
    pub mark_source_mode: Option<MarkSourceMode>,
    /// New thin-book spread cap in bps for the median guard
    /// (BE-31 Phase A). `None` = leave unchanged. `Some(0)` resets
    /// to the built-in default `DEFAULT_MAX_MARK_SPREAD_BPS` (100 bps).
    /// Ignored unless `mark_source_mode` is `Median`.
    #[serde(default)]
    pub max_mark_spread_bps: Option<u32>,
    /// BE-31 Phase B: max age (ms) for a composite-CEX price update
    /// before it's excluded from the median. `None` = leave unchanged.
    /// `Some(0)` resets to the built-in default
    /// `DEFAULT_CEX_COMPOSITE_STALENESS_MS` (30s). Ignored unless
    /// `mark_source_mode` is `Median` and the market has at least
    /// one composite update.
    #[serde(default)]
    pub cex_composite_staleness_ms: Option<u64>,
    /// BE-26: enable partial liquidation for this market. `None` =
    /// leave unchanged. See `MarketConfig::partial_liquidation_enabled`
    /// for semantics. Safe to flip on at any time.
    #[serde(default)]
    pub partial_liquidation_enabled: Option<bool>,
    /// Replace the rolling-volume fee-tier table. `None` = leave
    /// unchanged. `Some([])` clears the table and returns the market to
    /// flat `taker_fee_bps` / `maker_fee_bps` pricing. Non-empty tables
    /// must start at volume 0 and have strictly increasing thresholds.
    #[serde(default)]
    pub fee_tiers: Option<Vec<FeeTier>>,
}

/// Per-account fee override (BE-46). Stored at
/// `keys::account_fee_override(addr)` whenever an account has been
/// granted a non-default fee schedule. Replaces the market's base
/// `taker_fee_bps` / `maker_fee_bps` on fills where this account is
/// the taker / maker respectively.
///
/// Override semantics intentionally apply globally across all
/// markets — a single VIP-tier flag per account is the MVP shape;
/// per-market overrides can be added later as a follow-up if a
/// real use-case shows up.
///
/// Wire-format note: this struct is stored on-chain (not sent over
/// the wire as an Action), so field order is fixed by the storage
/// layout. Do not reorder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountFeeOverride {
    /// Taker fee rate in basis points (0..10_000). Replaces the
    /// market's `taker_fee_bps` on fills taken by this account.
    pub taker_fee_bps: u32,
    /// Maker fee rate in basis points (0..10_000). Replaces the
    /// market's `maker_fee_bps` on fills made by this account.
    pub maker_fee_bps: u32,
}

/// Set (or overwrite) an account's per-account fee override.
/// Relayer-signed admin action — `signer` must be on the relayer
/// allowlist or the engine returns `UnauthorizedRelayer`.
///
/// Both `taker_fee_bps` and `maker_fee_bps` must be in
/// `[0, 10_000]`, except for `FEE_OVERRIDE_REVERT_SENTINEL`
/// (`u32::MAX`), which reverts that side to the market's base fee at
/// fill time. Other out-of-range values are rejected with
/// `FeeBpsOutOfRange`.
///
/// To "clear" an existing override, set both fee fields to
/// `FEE_OVERRIDE_REVERT_SENTINEL`; partial reverts set only the side
/// that should fall back to the market base.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SetAccountFeeOverride {
    /// Account to override fees for. 20-byte address.
    pub account: [u8; 20],
    /// New taker fee in basis points (0..10_000), or
    /// `FEE_OVERRIDE_REVERT_SENTINEL` to revert taker fills to market base.
    pub taker_fee_bps: u32,
    /// New maker fee in basis points (0..10_000), or
    /// `FEE_OVERRIDE_REVERT_SENTINEL` to revert maker fills to market base.
    pub maker_fee_bps: u32,
    /// Authorized relayer signer. Must equal the envelope's derived
    /// owner and be on the relayer allowlist.
    pub signer: [u8; 20],
    /// Replay-guard sequence (BE-46.2). The engine tracks the highest
    /// accepted `seq` per `account`; the next call must satisfy
    /// `cmd.seq > stored_seq` or it is rejected with
    /// `FeeOverrideStaleSeq`. The first call against a fresh account
    /// (stored seq = 0) accepts any `seq >= 1`. The seq advances on
    /// the no-op path too (identical override) so stale replays stay
    /// rejected even when the value didn't change.
    ///
    /// Appended at the end of the struct so absent-on-the-wire decodes
    /// as `0` (rmp-serde default for `u64`); the handler then rejects
    /// `seq == 0` against any stored seq, surfacing legacy callers
    /// loudly rather than silently accepting them. This breaks the
    /// unreleased-branch wire format intentionally — landing the
    /// guard before mainnet is the whole point.
    pub seq: u64,
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
        /// Client-assigned order id. `0` means absent.
        client_order_id: u64,
    },
    OrderCancelled {
        order_id: OrderId,
        market: MarketId,
        owner: [u8; 20],
        reason: CancelReason,
        /// Client-assigned order id. `0` means absent.
        client_order_id: u64,
        /// Quantity originally accepted onto the book.
        original_quantity: u64,
        /// Quantity still resting when the cancel occurred.
        remaining_quantity: u64,
        /// Cumulative maker quantity filled before cancellation.
        filled_quantity: u64,
    },
    OrderAmended {
        order_id: OrderId,
        market: MarketId,
        owner: [u8; 20],
        side: Side,
        old_price: u64,
        new_price: u64,
        old_quantity: u64,
        new_quantity: u64,
        remaining_quantity: u64,
        filled_quantity: u64,
        queue_priority_reset: bool,
        /// Client-assigned order id. `0` means absent.
        client_order_id: u64,
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
        /// Maker's client-assigned order id. `0` means absent.
        maker_client_order_id: u64,
        maker_owner: [u8; 20],
        maker_side: Side,
        taker_owner: [u8; 20],
        /// Taker's client-assigned order id. `0` means absent.
        taker_client_order_id: u64,
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
        // BE-48 + BE-50 fields included in the event payload so off-chain
        // consumers can mirror the live config without re-reading state.
        // `primary_oracle_signer` is flattened to `[u8; 20]` because the
        // AbciEvent derive macro requires Display on every attribute and
        // Option<T> doesn't satisfy that bound — all-zero bytes mean "no
        // primary signer set" (semantically equivalent to None).
        tick_size: u64,
        lot_size: u64,
        primary_oracle_signer: [u8; 20],
        oracle_staleness_ms: u64,
    },
    /// An account's fee override was set (BE-46). Emitted on success
    /// of `SetAccountFeeOverride`. Carries the post-update values so
    /// off-chain consumers can mirror the override without re-reading
    /// state.
    AccountFeeOverrideSet {
        account: [u8; 20],
        taker_fee_bps: u32,
        maker_fee_bps: u32,
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
    /// Relayer rejected a Solana deposit (BE-40). The user was NOT
    /// credited; the signature is recorded so any subsequent
    /// `ConfirmDeposit`/`FailDeposit` referencing the same sig is a
    /// silent no-op. `solana_signature` is the raw on-chain sig bytes
    /// (typically 64 bytes — same encoding as `DepositConfirmed.solana_tx_sig`).
    DepositFailed {
        solana_signature: Vec<u8>,
        reason: FailDepositReason,
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
        /// Client-assigned order id. `0` means absent.
        client_order_id: u64,
    },
    /// Absolute post-mutation quantity at one orderbook price level.
    ///
    /// Emitted by the matching engine immediately after every deterministic
    /// book mutation (resting add, maker fill/reduce, cancel, expiry). Market
    /// data consumers can replay these events from a snapshot instead of
    /// polling and diffing full books.
    OrderbookLevelUpdated {
        market: MarketId,
        side: Side,
        price: u64,
        total_quantity: u64,
        order_count: u32,
    },
    /// User picked a per-market IM override (BE-16). `user_im_bps == 0`
    /// means the override was cleared (engine reverts to market
    /// default).
    UserMarketLeverageSet {
        owner: [u8; 20],
        market: MarketId,
        user_im_bps: u32,
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
    NonceTooOld {
        min_accepted: u64,
        got: u64,
    },
    NonceTooFarFuture {
        max_accepted: u64,
        got: u64,
    },
    NonceReplay {
        nonce: u64,
    },
    NonceBelowOldest {
        oldest: u64,
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
    /// `SetAccountFeeOverride` rejected because a fee value is outside
    /// the legal `[0, 10_000]` basis-point range. BE-46.
    FeeBpsOutOfRange {
        bps: u32,
    },
    /// `SetAccountFeeOverride` rejected because `cmd.seq` is not
    /// strictly greater than the seq stored on this account — i.e. it
    /// is a replay or an out-of-order tx. BE-46.2 replay guard
    /// (Ramon's 2026-05-03 review on #39). The seq advances on the
    /// no-op path too, so even an identical-payload replay against a
    /// stale seq is rejected here.
    FeeOverrideStaleSeq {
        cmd_seq: u64,
        stored_seq: u64,
    },
    /// `PlaceOrder` price is not an exact multiple of the market's
    /// `tick_size`. BE-48: makes the orderbook coarser at high precision
    /// to keep MMs from quoting through fractional ticks.
    TickSizeViolation {
        market: MarketId,
        tick_size: u64,
        price: u64,
    },
    /// `PlaceOrder` quantity is not an exact multiple of the market's
    /// `lot_size`. BE-48 sibling of `TickSizeViolation`.
    LotSizeViolation {
        market: MarketId,
        lot_size: u64,
        quantity: u64,
    },
    /// `OracleUpdate` from a fallback (non-primary) signer was rejected
    /// because the market's last oracle update — by any signer — is still
    /// within the staleness window. Caller must wait until
    /// `block_time - last_publish_ms >= oracle_staleness_ms`. BE-50.
    OracleStaleNotElapsed {
        market: MarketId,
        last_publish_ms: u64,
        block_time_ms: u64,
        staleness_ms: u64,
    },
    /// `get_mark_price` rejected because the oracle for `market` is
    /// older than `MarketConfig::mark_price_max_oracle_age_ms`. Order
    /// placement, margin checks, and liquidation refuse to use a
    /// stale oracle so a node with a stuck feeder can't silently
    /// misprice the book. BE-33, 2026-05-03.
    StaleOracle {
        market: MarketId,
        /// Stored `publish_time_ms` of the most recent oracle update.
        publish_time_ms: u64,
        /// Block time at which the read was attempted.
        block_time_ms: u64,
        /// Configured staleness cap from `MarketConfig`.
        max_staleness_ms: u64,
    },
    /// `SetUserMarketLeverage` rejected because the user attempted to
    /// pick an IM ratio LOWER than the market's risk floor. The
    /// engine only allows users to deleverage (more margin, less
    /// leverage), never the other direction. BE-16, 2026-05-03.
    UserLeverageBelowMarketIm {
        market: MarketId,
        user_im_bps: u32,
        market_im_bps: u32,
    },
    /// Cancel-by-client-order-id could not find an active resting order for
    /// this owner/id pair. The order may never have rested, may have already
    /// filled, or may already have been cancelled.
    ClientOrderIdNotFound {
        client_order_id: u64,
    },
    /// A new resting order attempted to reuse an active owner/client_order_id
    /// pair. Client order IDs are how external MMs reconcile cancels, so the
    /// engine keeps the active namespace one-to-one instead of letting a later
    /// order shadow the earlier index entry.
    DuplicateClientOrderId {
        client_order_id: u64,
    },
    /// Client order ID zero is reserved as the "absent" sentinel in ABCI
    /// events. External clients must use a positive 64-bit value.
    InvalidClientOrderId {
        client_order_id: u64,
    },
    /// `PlaceOrder` with `time_in_force=Fok` could not fully fill against
    /// currently visible crossing liquidity at the submitted limit price.
    FillOrKillWouldNotFill {
        requested: u64,
        available: u64,
    },
    /// `CancelReplaceOrder` must identify exactly one active order, either by
    /// engine order id or by owner-scoped client order id.
    InvalidCancelReplaceTarget,
    /// `AmendOrder.new_quantity` is a total quantity below the order's already
    /// filled maker quantity. The engine rejects instead of creating a
    /// negative or zero resting remainder.
    AmendBelowFilled {
        order_id: OrderId,
        filled_quantity: u64,
        requested_quantity: u64,
    },
}

impl ExecError {
    pub fn code(&self) -> u32 {
        // Reserved by the SDK gateway submit path for transport-level
        // failures before the engine sees a transaction: 401, 413, 429, 500.
        // Keep consensus ExecError codes out of that range so callers can
        // distinguish engine rejects from gateway rejects.
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
            ExecError::NonceTooOld { .. }
            | ExecError::NonceTooFarFuture { .. }
            | ExecError::NonceReplay { .. }
            | ExecError::NonceBelowOldest { .. } => 21,
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
            ExecError::StaleOracle { .. } => 37,
            ExecError::UserLeverageBelowMarketIm { .. } => 38,
            ExecError::TickSizeViolation { .. } => 39,
            ExecError::LotSizeViolation { .. } => 40,
            ExecError::OracleStaleNotElapsed { .. } => 41,
            ExecError::FeeBpsOutOfRange { .. } => 42,
            ExecError::FeeOverrideStaleSeq { .. } => 43,
            ExecError::ClientOrderIdNotFound { .. } => 44,
            ExecError::DuplicateClientOrderId { .. } => 45,
            ExecError::InvalidClientOrderId { .. } => 46,
            ExecError::FillOrKillWouldNotFill { .. } => 47,
            ExecError::InvalidCancelReplaceTarget => 48,
            ExecError::AmendBelowFilled { .. } => 49,
            ExecError::InternalError(_) => 255,
        }
    }

    /// Stable, one-line human-readable meaning per variant. Intended for
    /// documentation and integration-guide tables (e.g. the openapi.yaml
    /// `ExecErrorCode` table for Auros and other MMs). The string is the
    /// **integration contract**: don't reword these without bumping a
    /// minor doc version, since downstream tooling may key off them.
    ///
    /// Wording rules: present-tense, action-oriented, names the cause not
    /// the symptom. "Order ID does not exist on the requested market"
    /// beats "the order was not found" — clients want to know what to
    /// fix, not just that something failed.
    pub fn meaning(&self) -> &'static str {
        match self {
            ExecError::DecodeError(_) => {
                "Tx envelope or payload could not be decoded as MessagePack at the expected version. \
                 Indicates a malformed wire frame or a client/server version mismatch."
            }
            ExecError::OrderNotFound(_) => {
                "Order ID does not exist on the requested market, or has already been filled or cancelled."
            }
            ExecError::NotOwner(_) => {
                "Tx signer is not the owner of the referenced order; only the owner (or an approved agent) \
                 may cancel or amend it."
            }
            ExecError::UnauthorizedOracle => {
                "Oracle update was signed by a key that is not registered as an oracle signer for the market."
            }
            ExecError::Overflow => {
                "An arithmetic operation (price * quantity, fee accrual, position size) overflowed a u64. \
                 Almost always indicates a malformed input rather than legitimate volume."
            }
            ExecError::InvalidPrice => {
                "Price is zero, exceeds the per-market max, or violates tick-size quantization."
            }
            ExecError::InvalidQuantity => {
                "Quantity is zero, exceeds the per-market max, or violates lot-size quantization."
            }
            ExecError::InvalidSide => {
                "Side byte is neither Buy (0) nor Sell (1)."
            }
            ExecError::UnknownMarket(_) => {
                "Market ID is not registered. Either the market does not exist or it has been removed."
            }
            ExecError::InsufficientBalance => {
                "Account's USDC balance cannot cover the requested debit (deposit, withdrawal, or fee)."
            }
            ExecError::InsufficientMargin => {
                "Post-trade equity would fall below the initial-margin requirement for the resulting \
                 portfolio. Reduce order size, add collateral, or close offsetting positions."
            }
            ExecError::StateCorruption(_) => {
                "Engine read state in an unexpected shape (e.g. missing required key, malformed value). \
                 Indicates a bug or data corruption — file an issue with the surrounding context."
            }
            ExecError::InternalError(_) => {
                "Catch-all for unexpected runtime failures (panics caught by the FFI boundary, etc.). \
                 Treat as a server bug."
            }
            ExecError::UnauthorizedRelayer => {
                "Tx is a relayer-only action (oracle update, funding tick, deposit confirmation, etc.) \
                 but the signer is not registered as an authorized relayer."
            }
            ExecError::WithdrawalNotFound(_) => {
                "Withdrawal ID does not exist or has already been claimed/refunded."
            }
            ExecError::WithdrawalAlreadyProcessed(_) => {
                "Withdrawal was already settled (claim or refund); duplicate finalize call rejected."
            }
            ExecError::DuplicateDeposit => {
                "On-chain deposit signature has already been credited; idempotency guard rejected the replay."
            }
            ExecError::InvalidSignature => {
                "Ed25519 verification of the V2 envelope failed. Signature, pubkey, or signed bytes are wrong."
            }
            ExecError::SignatureRequired => {
                "A signed (V2) transaction envelope is required. Unsigned (V1) envelopes are not accepted."
            }
            ExecError::AgentNotAuthorized => {
                "Tx signer is neither the account owner nor on the owner's approved-agent list."
            }
            ExecError::AgentCannotWithdraw => {
                "Agent wallets may place/cancel/market orders but are forbidden from initiating withdrawals."
            }
            ExecError::NonceTooOld { .. }
            | ExecError::NonceTooFarFuture { .. }
            | ExecError::NonceReplay { .. }
            | ExecError::NonceBelowOldest { .. } => {
                "Timestamp nonce failed replay-window validation. Use a unique millisecond Unix timestamp within \
                 [block_time-2d, block_time+1d]; included failures burn their nonce."
            }
            ExecError::MarketAlreadyExists(_) => {
                "Attempted CreateMarket for a market ID already in the registry."
            }
            ExecError::InvalidMarketConfig(_) => {
                "MarketConfig fields fail validation (e.g. fee bps out of range, lot/tick zero, IM/MM ratio \
                 inverted)."
            }
            ExecError::ImpactMarketAlreadyExists(_) => {
                "Attempted CreateImpactMarket for an impact market ID already in the registry."
            }
            ExecError::ImpactMarketNotFound(_) => {
                "Impact market ID does not exist; cannot resolve, cash-out, or query."
            }
            ExecError::MarketClosedForTrading(_) => {
                "Order placement attempted on a conditional/binary book whose parent impact market is \
                 already resolved or voided."
            }
            ExecError::BinaryPriceOutOfRange => {
                "Binary-book order price is outside the [0, BINARY_PRICE_MAX] range."
            }
            ExecError::InvalidResolution(_) => {
                "ResolveEvent called with an outcome incompatible with the current state (already resolved, \
                 outcome not in the configured set, etc.)."
            }
            ExecError::PositionLimitExceeded { .. } => {
                "Fill would push absolute net position past MarketConfig.max_position_size. Engine cap \
                 enforced at placement time independent of margin."
            }
            ExecError::OracleTimestampNotMonotonic { .. } => {
                "OracleUpdate publish_time_ms is not strictly greater than the last accepted update for \
                 this market — replay protection per audit B3 (2026-04-23)."
            }
            ExecError::TooManyActiveImpactMarkets { .. } => {
                "Account would touch more impact markets than the scenario margin engine can enumerate \
                 (MAX_IMPACT_MARKETS_PER_ACCOUNT). Close a leg before opening another."
            }
            ExecError::SettlementPriceMismatch { .. } => {
                "Net-delta margin grouping found legs with disagreeing settle prices (data corruption \
                 across same `underlying_market_id`)."
            }
            ExecError::OracleNotApplicable { .. } => {
                "OracleUpdate targets an impact-family market (CPY/CPN/EBY/EBN), which marks off the book \
                 and has no oracle layer."
            }
            ExecError::PostOnlyWouldCross => {
                "PlaceOrder with post_only=true would have crossed the book. Rejected so makers retain \
                 maker-side fills."
            }
            ExecError::ReduceOnlyWouldIncrease => {
                "PlaceOrder/MarketOrder with reduce_only=true was same-side as the existing position (would \
                 increase exposure) or no position existed."
            }
            ExecError::TestActionRejected(_) => {
                "Test/admin action (RunLiquidationSweep, RunFundingTick, ForceLiquidate) rejected because \
                 the engine isn't configured to accept them, or the position the action referenced does \
                 not exist."
            }
            ExecError::StaleOracle { .. } => {
                "Oracle price is stale for this market; refresh the oracle before placing orders, reading margin, or liquidating."
            }
            ExecError::UserLeverageBelowMarketIm { .. } => {
                "User-selected initial margin is below the market risk floor; only deleveraging above the market floor is allowed."
            }
            ExecError::TickSizeViolation { .. } => {
                "Order price is not an exact multiple of the market tick size."
            }
            ExecError::LotSizeViolation { .. } => {
                "Order quantity is not an exact multiple of the market lot size."
            }
            ExecError::OracleStaleNotElapsed { .. } => {
                "Fallback oracle signer published before the market staleness window elapsed."
            }
            ExecError::FeeBpsOutOfRange { .. } => {
                "Per-account fee override has a fee outside the legal basis-point range."
            }
            ExecError::FeeOverrideStaleSeq { .. } => {
                "Per-account fee override sequence is stale or out of order."
            }
            ExecError::ClientOrderIdNotFound { .. } => {
                "No active resting order exists for the requested client order id."
            }
            ExecError::DuplicateClientOrderId { .. } => {
                "An active resting order already uses the requested client order id."
            }
            ExecError::InvalidClientOrderId { .. } => {
                "Client order id zero is reserved and cannot be submitted."
            }
            ExecError::FillOrKillWouldNotFill { .. } => {
                "Fill-or-kill order cannot be fully filled immediately at the submitted limit price."
            }
            ExecError::InvalidCancelReplaceTarget => {
                "Cancel-replace must specify exactly one active order target: either orderId or clientOrderId."
            }
            ExecError::AmendBelowFilled { .. } => {
                "AmendOrder new quantity is below the quantity already filled while the order rested."
            }
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
            ExecError::NonceTooOld { min_accepted, got } => {
                write!(f, "nonce too old: minimum accepted {min_accepted}, got {got}")
            }
            ExecError::NonceTooFarFuture { max_accepted, got } => {
                write!(
                    f,
                    "nonce too far in future: maximum accepted {max_accepted}, got {got}"
                )
            }
            ExecError::NonceReplay { nonce } => write!(f, "nonce replay: {nonce}"),
            ExecError::NonceBelowOldest { oldest, got } => {
                write!(f, "nonce below retained oldest: oldest {oldest}, got {got}")
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
            ExecError::FeeBpsOutOfRange { bps } => write!(
                f,
                "fee out of range: {bps} bps (must be in [0, 10_000])"
            ),
            ExecError::FeeOverrideStaleSeq {
                cmd_seq,
                stored_seq,
            } => write!(
                f,
                "stale SetAccountFeeOverride seq: cmd seq {cmd_seq} <= stored seq {stored_seq} (replay or out-of-order tx)"
            ),
            ExecError::TickSizeViolation { market, tick_size, price } => write!(
                f,
                "tick size violation on market {market}: price {price} not a multiple of tick_size {tick_size}"
            ),
            ExecError::LotSizeViolation { market, lot_size, quantity } => write!(
                f,
                "lot size violation on market {market}: quantity {quantity} not a multiple of lot_size {lot_size}"
            ),
            ExecError::OracleStaleNotElapsed { market, last_publish_ms, block_time_ms, staleness_ms } => write!(
                f,
                "oracle update from fallback signer rejected on market {market}: \
                primary's last_publish_ms {last_publish_ms} is too recent \
                (block_time {block_time_ms} - last_publish < staleness_ms {staleness_ms})"
            ),
            ExecError::StaleOracle {
                market,
                publish_time_ms,
                block_time_ms,
                max_staleness_ms,
            } => write!(
                f,
                "oracle stale on market {market}: last publish_time {publish_time_ms}ms, \
                block time {block_time_ms}ms (age {age}ms > cap {max_staleness_ms}ms)",
                age = block_time_ms.saturating_sub(*publish_time_ms),
            ),
            ExecError::UserLeverageBelowMarketIm {
                market,
                user_im_bps,
                market_im_bps,
            } => write!(
                f,
                "user_im_bps {user_im_bps} below market {market}'s im_bps {market_im_bps}; \
                only deleveraging (user_im >= market_im) is allowed"
            ),
            ExecError::ClientOrderIdNotFound { client_order_id } => {
                write!(f, "client order id not found: {client_order_id}")
            }
            ExecError::DuplicateClientOrderId { client_order_id } => {
                write!(f, "duplicate active client order id: {client_order_id}")
            }
            ExecError::InvalidClientOrderId { client_order_id } => {
                write!(f, "invalid client order id: {client_order_id}")
            }
            ExecError::FillOrKillWouldNotFill {
                requested,
                available,
            } => write!(
                f,
                "fill-or-kill would not fully fill: requested {requested}, available {available}"
            ),
            ExecError::InvalidCancelReplaceTarget => {
                write!(f, "cancel-replace requires exactly one cancel target")
            }
            ExecError::AmendBelowFilled {
                order_id,
                filled_quantity,
                requested_quantity,
            } => write!(
                f,
                "amend quantity below filled for order {order_id}: requested total {requested_quantity}, filled {filled_quantity}"
            ),
            ExecError::InternalError(msg) => write!(f, "internal error: {msg}"),
        }
    }
}

// ---------------------------------------------------------------------------
// Error-kind enum (generated by macro — every variant has code + name + meaning)
// ---------------------------------------------------------------------------

macro_rules! define_error_kinds {
    ($($code:literal => $name:ident ~ $meaning:literal),+ $(,)?) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum ErrorKind {
            $($name,)+
        }

        impl ErrorKind {
            pub fn code(self) -> u32 {
                match self {
                    $(Self::$name => $code,)+
                }
            }

            pub fn name(self) -> &'static str {
                match self {
                    $(Self::$name => stringify!($name),)+
                }
            }

            pub fn meaning(self) -> &'static str {
                match self {
                    $(Self::$name => $meaning,)+
                }
            }
        }

        /// The complete error-kind manifest — one entry per variant, in
        /// definition order. Used by every language binding.
        pub const ERROR_KINDS: &[ErrorKind] = &[$(ErrorKind::$name),+];
    };
}

define_error_kinds! {
    1   => DecodeError         ~ "Tx envelope or payload could not be decoded as MessagePack at the expected version. Indicates a malformed wire frame or a client/server version mismatch.",
    2   => OrderNotFound       ~ "Order ID does not exist on the requested market, or has already been filled or cancelled.",
    3   => NotOwner            ~ "Tx signer is not the owner of the referenced order; only the owner (or an approved agent) may cancel or amend it.",
    4   => UnauthorizedOracle  ~ "Oracle update was signed by a key that is not registered as an oracle signer for the market.",
    5   => Overflow            ~ "An arithmetic operation (price * quantity, fee accrual, position size) overflowed a u64. Almost always indicates a malformed input rather than legitimate volume.",
    6   => InvalidPrice        ~ "Price is zero, exceeds the per-market max, or violates tick-size quantization.",
    7   => InvalidQuantity     ~ "Quantity is zero, exceeds the per-market max, or violates lot-size quantization.",
    8   => InvalidSide         ~ "Side byte is neither Buy (0) nor Sell (1).",
    9   => UnknownMarket       ~ "Market ID is not registered. Either the market does not exist or it has been removed.",
    10  => StateCorruption     ~ "Engine read state in an unexpected shape (e.g. missing required key, malformed value). Indicates a bug or data corruption — file an issue with the surrounding context.",
    11  => InsufficientBalance ~ "Account's USDC balance cannot cover the requested debit (deposit, withdrawal, or fee).",
    12  => InsufficientMargin  ~ "Post-trade equity would fall below the initial-margin requirement for the resulting portfolio. Reduce order size, add collateral, or close offsetting positions.",
    13  => UnauthorizedRelayer ~ "Tx is a relayer-only action (oracle update, funding tick, deposit confirmation, etc.) but the signer is not registered as an authorized relayer.",
    14  => WithdrawalNotFound            ~ "Withdrawal ID does not exist or has already been claimed/refunded.",
    15  => WithdrawalAlreadyProcessed    ~ "Withdrawal was already settled (claim or refund); duplicate finalize call rejected.",
    16  => DuplicateDeposit             ~ "On-chain deposit signature has already been credited; idempotency guard rejected the replay.",
    17  => InvalidSignature             ~ "Ed25519 verification of the V2 envelope failed. Signature, pubkey, or signed bytes are wrong.",
    18  => SignatureRequired            ~ "A signed (V2) transaction envelope is required. Unsigned (V1) envelopes are not accepted.",
    19  => AgentNotAuthorized           ~ "Tx signer is neither the account owner nor on the owner's approved-agent list.",
    20  => AgentCannotWithdraw          ~ "Agent wallets may place/cancel/market orders but are forbidden from initiating withdrawals.",
    21  => InvalidNonce                 ~ "Timestamp nonce failed replay-window validation. Use a unique millisecond Unix timestamp within [block_time-2d, block_time+1d]; included failures burn their nonce.",
    22  => MarketAlreadyExists          ~ "Attempted CreateMarket for a market ID already in the registry.",
    23  => InvalidMarketConfig          ~ "MarketConfig fields fail validation (e.g. fee bps out of range, lot/tick zero, IM/MM ratio inverted).",
    24  => ImpactMarketAlreadyExists    ~ "Attempted CreateImpactMarket for an impact market ID already in the registry.",
    25  => ImpactMarketNotFound         ~ "Impact market ID does not exist; cannot resolve, cash-out, or query.",
    26  => MarketClosedForTrading       ~ "Order placement attempted on a conditional/binary book whose parent impact market is already resolved or voided.",
    27  => BinaryPriceOutOfRange        ~ "Binary-book order price is outside the [0, BINARY_PRICE_MAX] range.",
    28  => InvalidResolution            ~ "ResolveEvent called with an outcome incompatible with the current state (already resolved, outcome not in the configured set, etc.).",
    29  => PositionLimitExceeded        ~ "Fill would push absolute net position past MarketConfig.max_position_size. Engine cap enforced at placement time independent of margin.",
    30  => OracleTimestampNotMonotonic  ~ "OracleUpdate publish_time_ms is not strictly greater than the last accepted update for this market — replay protection per audit B3 (2026-04-23).",
    31  => TooManyActiveImpactMarkets   ~ "Account would touch more impact markets than the scenario margin engine can enumerate (MAX_IMPACT_MARKETS_PER_ACCOUNT). Close a leg before opening another.",
    32  => SettlementPriceMismatch      ~ "Net-delta margin grouping found legs with disagreeing settle prices (data corruption across same underlying_market_id).",
    33  => OracleNotApplicable          ~ "OracleUpdate targets an impact-family market (CPY/CPN/EBY/EBN), which marks off the book and has no oracle layer.",
    34  => PostOnlyWouldCross           ~ "PlaceOrder with post_only=true would have crossed the book. Rejected so makers retain maker-side fills.",
    35  => ReduceOnlyWouldIncrease      ~ "PlaceOrder/MarketOrder with reduce_only=true was same-side as the existing position (would increase exposure) or no position existed.",
    36  => TestActionRejected           ~ "Test/admin action (RunLiquidationSweep, RunFundingTick, ForceLiquidate) rejected because the engine isn't configured to accept them, or the position the action referenced does not exist.",
    37  => StaleOracle                  ~ "Oracle price is stale for this market; refresh the oracle before placing orders, reading margin, or liquidating.",
    38  => UserLeverageBelowMarketIm    ~ "User-selected initial margin is below the market risk floor; only deleveraging above the market floor is allowed.",
    39  => TickSizeViolation            ~ "Order price is not an exact multiple of the market tick size.",
    40  => LotSizeViolation             ~ "Order quantity is not an exact multiple of the market lot size.",
    41  => OracleStaleNotElapsed        ~ "Fallback oracle signer published before the market staleness window elapsed.",
    42  => FeeBpsOutOfRange             ~ "Per-account fee override has a fee outside the legal basis-point range.",
    43  => FeeOverrideStaleSeq          ~ "Per-account fee override sequence is stale or out of order.",
    44  => ClientOrderIdNotFound        ~ "No active resting order exists for the requested client order id.",
    45  => DuplicateClientOrderId       ~ "An active resting order already uses the requested client order id.",
    46  => InvalidClientOrderId         ~ "Client order id zero is reserved and cannot be submitted.",
    47  => FillOrKillWouldNotFill       ~ "Fill-or-kill order cannot be fully filled immediately at the submitted limit price.",
    48  => InvalidCancelReplaceTarget   ~ "Cancel-replace must specify exactly one active order target: either orderId or clientOrderId.",
    49  => AmendBelowFilled             ~ "AmendOrder new quantity is below the quantity already filled while the order rested.",
    255 => InternalError                ~ "Catch-all for unexpected runtime failures (panics caught by the FFI boundary, etc.). Treat as a server bug.",
}

// Backward-compat alias for any callers still using `error_code_manifest()`.
pub fn error_code_manifest() -> &'static [ErrorKind] {
    ERROR_KINDS
}

impl From<StateError> for ExecError {
    fn from(value: StateError) -> Self {
        match value {
            StateError::ArithmeticInvariantViolation { .. } => ExecError::Overflow,
            other => ExecError::StateCorruption(other.to_string()),
        }
    }
}

#[cfg(test)]
mod exec_error_meaning_tests {
    use super::*;

    /// Sample one constructed value per variant. New variants added to
    /// `ExecError` must be added here, otherwise the test below fails
    /// (which is the point — it forces docs to keep up with the wire).
    fn one_of_each() -> Vec<ExecError> {
        vec![
            ExecError::DecodeError("e".into()),
            ExecError::OrderNotFound(0),
            ExecError::NotOwner(0),
            ExecError::UnauthorizedOracle,
            ExecError::Overflow,
            ExecError::InvalidPrice,
            ExecError::InvalidQuantity,
            ExecError::InvalidSide,
            ExecError::UnknownMarket(0),
            ExecError::InsufficientBalance,
            ExecError::InsufficientMargin,
            ExecError::StateCorruption("e".into()),
            ExecError::InternalError("e".into()),
            ExecError::UnauthorizedRelayer,
            ExecError::WithdrawalNotFound(0),
            ExecError::WithdrawalAlreadyProcessed(0),
            ExecError::DuplicateDeposit,
            ExecError::InvalidSignature,
            ExecError::SignatureRequired,
            ExecError::AgentNotAuthorized,
            ExecError::AgentCannotWithdraw,
            ExecError::NonceTooOld {
                min_accepted: 0,
                got: 0,
            },
            ExecError::NonceTooFarFuture {
                max_accepted: 0,
                got: 0,
            },
            ExecError::NonceReplay { nonce: 0 },
            ExecError::NonceBelowOldest { oldest: 0, got: 0 },
            ExecError::MarketAlreadyExists(0),
            ExecError::InvalidMarketConfig("e".into()),
            ExecError::ImpactMarketAlreadyExists(0),
            ExecError::ImpactMarketNotFound(0),
            ExecError::MarketClosedForTrading(0),
            ExecError::BinaryPriceOutOfRange,
            ExecError::InvalidResolution("e".into()),
            ExecError::PositionLimitExceeded {
                market: 0,
                limit: 0,
                would_be: 0,
            },
            ExecError::OracleTimestampNotMonotonic {
                market: 0,
                stored: 0,
                submitted: 0,
            },
            ExecError::TooManyActiveImpactMarkets { current: 0, max: 0 },
            ExecError::SettlementPriceMismatch {
                market: 0,
                expected: 0,
                got: 0,
            },
            ExecError::OracleNotApplicable { market: 0 },
            ExecError::PostOnlyWouldCross,
            ExecError::ReduceOnlyWouldIncrease,
            ExecError::TestActionRejected("e".into()),
            ExecError::FeeBpsOutOfRange { bps: 0 },
            ExecError::FeeOverrideStaleSeq {
                cmd_seq: 0,
                stored_seq: 0,
            },
            ExecError::TickSizeViolation {
                market: 0,
                tick_size: 1,
                price: 0,
            },
            ExecError::LotSizeViolation {
                market: 0,
                lot_size: 1,
                quantity: 0,
            },
            ExecError::OracleStaleNotElapsed {
                market: 0,
                last_publish_ms: 0,
                block_time_ms: 0,
                staleness_ms: 1,
            },
            ExecError::StaleOracle {
                market: 0,
                publish_time_ms: 0,
                block_time_ms: 0,
                max_staleness_ms: 1,
            },
            ExecError::UserLeverageBelowMarketIm {
                market: 0,
                user_im_bps: 0,
                market_im_bps: 1,
            },
            ExecError::ClientOrderIdNotFound { client_order_id: 0 },
            ExecError::DuplicateClientOrderId { client_order_id: 0 },
            ExecError::InvalidClientOrderId { client_order_id: 0 },
            ExecError::FillOrKillWouldNotFill {
                requested: 1,
                available: 0,
            },
            ExecError::InvalidCancelReplaceTarget,
            ExecError::AmendBelowFilled {
                order_id: 0,
                filled_quantity: 1,
                requested_quantity: 0,
            },
        ]
    }

    /// Every code returned by `code()` must have a non-empty `meaning()`.
    /// This is the integration contract for the openapi-yaml `ExecErrorCode`
    /// table — clients (Auros, etc.) read these to map raw codes to
    /// actionable client-side errors.
    #[test]
    fn every_variant_has_non_empty_meaning() {
        for e in one_of_each() {
            let m = e.meaning();
            assert!(
                !m.is_empty(),
                "ExecError code={} ({:?}) has empty meaning()",
                e.code(),
                e
            );
            // Heuristic: meanings should be at least one full sentence,
            // not just the variant name. Catches future placeholder
            // additions like `_ => "TODO"`.
            assert!(
                m.len() > 20,
                "ExecError code={} ({:?}) meaning is too short to be useful: {:?}",
                e.code(),
                e,
                m
            );
        }
    }

    /// Codes 1..=49 + 255 must all be covered by at least one variant.
    /// Catches the case where a code is reserved in `code()` but no
    /// variant maps to it (would surface as an unreachable arm in
    /// `meaning()`).
    #[test]
    fn no_code_holes_in_documented_range() {
        let mut codes: Vec<u32> = one_of_each().iter().map(|e| e.code()).collect();
        codes.sort();
        codes.dedup();
        let expected: Vec<u32> = (1u32..=49).chain(std::iter::once(255)).collect();
        assert_eq!(
            codes, expected,
            "ExecError codes covered by variants: {:?}; expected: {:?}. \
             A new variant was added without bumping the codes table, \
             OR a code was reserved without a corresponding variant.",
            codes, expected
        );
    }
}

// ---------------------------------------------------------------------------
// Prelude — commonly used types for internal imports
// ---------------------------------------------------------------------------

pub mod prelude {
    pub use crate::types::{
        AccountFeeOverride, Action, AmendOrder, ApproveAgent, Branch, CancelAllOrders,
        CancelClientOrder, CancelOrder, CancelReason, CancelReplaceOrder, ClosePosition,
        ConfirmDeposit, ConfirmWithdrawal, CreateImpactMarket, CreateMarket, Deposit, Event,
        EventOracleSource, ExecError, FailDeposit, FailWithdrawal, FillId, ImpactMarketId,
        ImpactMarketInfo, ImpactMarketStatus, MarkSourceMode, MarketConfig, MarketId, MarketKind,
        MarketOrder, OracleUpdate, OracleUpdateComposite, Order, OrderId, Outcome, PlaceOrder,
        Position, ResolveEvent, RevokeAgent, RunFundingTick, RunLiquidationSweep,
        SetAccountFeeOverride, SetUserMarketLeverage, Side, TimeInForce, TxContext,
        UpdateMarketFees, Withdraw, WithdrawRequest, WithdrawalStatus, BINARY_PRICE_MAX,
        DEFAULT_CEX_COMPOSITE_STALENESS_MS, DEFAULT_MAX_MARK_SPREAD_BPS,
    };
}
