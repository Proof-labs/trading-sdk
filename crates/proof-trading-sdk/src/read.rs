//! Node read-model (response) DTOs — the client's decode view of `/v1/account`
//! and market queries. These are plain positional-MessagePack structs over the
//! shared wire types; trailing `#[serde(default)]` fields keep older node blobs
//! decodable. (Client representation lives in the SDK, per the wire-crate split.)

use serde::{Deserialize, Serialize};

use crate::types::{
    Branch, EventOracleSource, ImpactMarketId, ImpactMarketStatus, MarketId, PositionEpoch, Side,
};

/// Position with response-only enrichment fields computed inline by
/// `query_account`. The first six fields match the on-state `Position`
/// struct in identical order, so clients decoding positional msgpack
/// tuples by index (0..=5) see unchanged values. Indices 6..=13 are
/// new and OK to ignore for older clients — rmp-serde arrays are
/// length-prefixed and TS/JS decoders access by numeric index.
///
/// Addresses Sprint 1 items in `docs/api-scope.md`:
///   * P1 #2 — `pnl_if_fires` / `pnl_if_dies` per position
///   * P2 #8 — per-position `upnl_now`, `mm_now`, `im_now`, `funding_since`
///
/// The enrichment fields are deliberately per-leg anchors, not a decomposed
/// account-health proof. From schema v9, branch equity applies one debit-only
/// shock after all firing linear legs are netted by underlying, and CP margin
/// can be floored at the underlying mark. Therefore clients cannot reconstruct
/// `AccountInfo.equity`, `total_mm`, or `total_im` by summing PositionBriefs;
/// those account fields are the canonical scenario/group result.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PositionBrief {
    // ── Raw Position fields (indices 0-5; wire-compatible with Position) ──
    pub owner: [u8; 20],
    pub market: MarketId,
    pub side: Side,
    pub entry_price: u64,
    pub size: u64,
    pub last_funding_index: i64,

    // ── Response-enrichment fields (indices 6-11) ──
    /// Unrealized P&L at the current mark, unconditional. For Perp + CP
    /// this equals `pnl_if_fires` (the firing settle price is the same as
    /// the current mark). For PredictionBinary there is no true
    /// "current mark" — returned as 0 placeholder; use pnl_if_fires /
    /// pnl_if_dies for the full payoff picture.
    pub upnl_now: i64,
    /// Stand-alone maintenance-margin anchor at the current underlying mark.
    /// It does not include v9 group netting, the selected branch displacement,
    /// or the CP `max(branch, U)` scenario floor. For CP/Binary the position
    /// contributes zero in its non-firing branch. Use `AccountInfo.total_mm`
    /// for the enforceable account requirement.
    pub mm_now: u64,
    /// Stand-alone initial-margin anchor, with the same non-additive contract
    /// as `mm_now`. Resting orders and scenario/group adjustments live only in
    /// `AccountInfo.total_im`.
    pub im_now: u64,
    /// V(p, s) when position's branch fires (μ = 1):
    ///     sign(side) × (settle × size − entry × size)
    /// Perp: always fires. CP: fires when event resolves to position's branch.
    /// Binary: fires and settles to BINARY_PRICE_MAX × size. This is a per-leg
    /// payoff anchor; it excludes the v9 per-underlying debit-only group shock.
    pub pnl_if_fires: i64,
    /// V(p, s) when position's branch does NOT fire (μ = 0). Per-kind:
    ///   * **ConditionalPerp**: 0 (voided side returns IM, no settlement
    ///     cash flow per `docs/impact-market-design.md` §2.1).
    ///   * **PredictionBinary**: `sign(side) × (0 − entry × size)`
    ///     (binaries DO settle at $0 on the losing side — long forfeits
    ///     entry × size, short keeps it).
    ///   * **Perp**: equal to `upnl_now` (perps never die; reported here
    ///     for API symmetry so the UI renders the column uniformly).
    /// (Earlier audit-affected formula was `sign(side) × (0 − entry × size)`
    /// uniformly across kinds — wrong for CPs. Fixed in `fc59cbf`.)
    pub pnl_if_dies: i64,
    /// Funding accrued since the position's last settled funding index.
    /// Positive = credit to owner, negative = debit. Convention:
    ///     funding_since = -sign(side) × (cumulative - last_index) × size
    ///                      / FUNDING_SCALE
    /// Longs pay when cumulative rises, shorts receive. For CP, funding
    /// is tracked on the CP market (not the underlying).
    pub funding_since: i64,

    /// ADL queue score: `max(0, upnl_now) × leverage_used`. Used by the
    /// Tier-3 Auto-Deleveraging queue (docs/adl-vs-socialized-loss.md
    /// §3.5) to rank profitable counterparties. Higher score = closer
    /// to the front of the ADL queue.
    ///
    /// Formula: `(positive_upnl × notional × 10_000) / im_now`, where
    /// notional = settle_price × size and im_now = notional × im_bps
    /// / 10_000. The notional cancels, so the score reduces to
    /// `upnl × 10⁸ / im_bps`: within a market the queue is ordered by
    /// absolute unrealized profit; across markets, equal profits in a
    /// lower-IM market rank higher. The account's actual leverage
    /// (notional / equity) does not enter the ranking. `im_now` is this
    /// position's stand-alone current-mark anchor, so this per-position ADL
    /// heuristic does not encode v9 group margin, branch floors, or the
    /// binding account scenario.
    ///
    /// Returned as 0 for losing positions (they're never ADL'd — only
    /// the cascading-counterparty's profitable opposites are at risk).
    /// Returned as 0 when `im_now == 0` (for example prediction-binary
    /// positions, whose payoff lives in scenario equity), avoiding division
    /// by zero.
    ///
    /// Trailing field (index 11), `#[serde(default)]` so older clients
    /// reading indices 0-10 continue to work. Added 2026-04-25.
    #[serde(default)]
    pub adl_score: i64,

    /// Persistent generation of this live position. This is the canonical
    /// first-attach input for `SetPositionTriggers.expected_position_epoch`:
    /// clients must never guess `1`, because close/reopen and direct flips
    /// advance this sidecar.
    ///
    /// `None` is retained only for pre-index legacy state while the bounded
    /// backfill has not reached the row. Trailing field (index 13); existing
    /// positional decoders keep indices 0..=12 unchanged and may ignore it.
    #[serde(default)]
    pub position_epoch: Option<PositionEpoch>,
}

/// Account info response — includes margin breakdown for liquidation bar.
#[derive(Serialize, Deserialize)]
pub struct AccountInfo {
    pub balance: u64,
    pub positions: Vec<PositionBrief>,
    /// Equity in the binding liquidation-ratio scenario. Signed (can be negative).
    pub equity: i64,
    /// Maintenance margin in the same binding scenario as `equity`.
    pub total_mm: u64,
    /// Total initial margin required (positions + resting orders).
    pub total_im: u64,
    /// Margin ratio = binding-scenario equity / binding-scenario total_mm. 0 if no positions.
    /// 1.0 = at liquidation threshold. >1.0 = healthy. Encoded as bps (10000 = 1.0x).
    pub margin_ratio_bps: u64,
    /// Resolution scenario with the lowest paired maintenance ratio — the
    /// "binding" liquidation-health outcome.
    /// One entry per active impact market the account touches, in ascending
    /// impact-market-id order. For perp-only accounts (no impact exposure)
    /// this is empty. Addresses Jesse's P1 #3 (see docs/api-scope.md).
    ///
    /// The pre-scenario-margin framing said "binding branch: YES vs NO" but
    /// that doesn't compose for 2+ impact markets. `binding_scenario` is the
    /// correct generalization — a tuple of (impact_market_id, branch) per
    /// event the account is exposed to. Shipped 2026-04-24 as a trailing
    /// msgpack field (index 6); older SDK versions reading indices 0-5
    /// continue to work.
    pub binding_scenario: Vec<(ImpactMarketId, Branch)>,
    /// Cumulative trading fees paid (positive) or rebates received
    /// (negative) by this account across its lifetime in micro-USDC.
    /// Updated atomically with the FeePool credit at fill time, so
    /// `Σ fees_accrued ≈ current FeePool balance` holds. Powers the
    /// "lifetime trading cost" line on the UI/SDK. New accounts read
    /// 0. Trailing field (index 7); decodes as 0 for callers reading
    /// older AccountInfo blobs thanks to `serde(default)`. BE-45,
    /// 2026-05-03.
    #[serde(default)]
    pub fees_accrued: i64,
    /// Per-account rolling 30-day taker volume in micro-USDC at the last
    /// volume update. The engine uses this slot to select volume fee tiers
    /// before each fill and updates it after taker volume is recorded. New
    /// accounts read 0. Trailing field (index 8); older clients may ignore it.
    #[serde(default)]
    pub volume_30d_micro_usdc: u64,
    /// Mark-to-market account value in microUSDC for portfolio charts.
    ///
    /// Unlike `equity`, this is not the worst-case resolution-scenario floor.
    /// It uses oracle marks for perps and child-market marks for event books,
    /// and is intended for "what could I cash out around now?" display surfaces.
    /// Trailing field (index 9); older clients may ignore it.
    #[serde(default)]
    pub cashout_equity: i64,
}

/// Frontend-facing impact-market info response.
///
/// Stored [`ImpactMarketInfo`] deliberately stops at `oracle_source`; this view
/// appends `description` and `rules` for `/v1/impact_market*` readers without
/// putting presentation copy in consensus state. Keep field order compatible
/// with the previous 15-field `ImpactMarketInfo` response.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImpactMarketDisplayInfo {
    pub impact_market_id: ImpactMarketId,
    pub underlying_market: MarketId,
    pub cpy_market: MarketId,
    pub cpn_market: MarketId,
    pub eby_market: MarketId,
    pub ebn_market: MarketId,
    pub question: String,
    pub deadline_ms: u64,
    pub resolution_window_ms: u64,
    pub status: ImpactMarketStatus,
    pub created_ms: u64,
    pub resolved_ms: u64,
    #[serde(default)]
    pub oracle_source: Option<EventOracleSource>,
    pub description: String,
    pub rules: String,
}
