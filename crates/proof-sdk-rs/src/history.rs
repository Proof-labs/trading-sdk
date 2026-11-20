//! Typed reads of the gateway's indexed history (`/v1/history/*`).
//!
//! Owner routes are cursor-paged: pass [`HistoryPage::next_cursor`] back as
//! the query's `cursor`, with the other filters unchanged, until it is
//! `None`. History is indexed from committed blocks and can lag the chain by
//! tens of seconds; receipts and the live feed are the low-latency path.
//!
//! Every row is checked against what the query asked for: the owner, and the
//! market, event or event-type filter when one is set; on the orders,
//! account-events, funding-payments and resolutions routes also the
//! `[from_ms, to_ms)` window, which the indexer applies to block time. A row
//! outside them is [`Error::Decode`]. A row that does not decode is
//! [`Error::HistoryRow`], which carries the page's cursor so a caller can
//! continue past it.

use std::fmt;

use proof_trading_sdk::gateway::TxHash;
use proof_trading_sdk::types::{EventId, MarketId, Side};
use serde::de::{DeserializeOwned, Error as _};
use serde::{Deserialize, Deserializer};

use crate::address::Address;
use crate::error::{Error, Result};
use crate::event::{raw_from_json, ConversionFallbackReason, Event};
use crate::ids::IndexerEventId;
use crate::info::{de_market, de_side, de_u64, InfoClient};

type Json = serde_json::Map<String, serde_json::Value>;

/// One page of a cursor-paged history route.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryPage<T> {
    pub rows: Vec<T>,
    /// Pass back as `cursor` for the next page; `None` on the last one.
    pub next_cursor: Option<String>,
}

/// Filters for the fills, positions, funding-payments and triggers history.
/// Times are ms since the epoch, `from_ms` inclusive, `to_ms` exclusive.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HistoryQuery {
    pub market: Option<MarketId>,
    pub from_ms: Option<u64>,
    pub to_ms: Option<u64>,
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

/// Filters for the order history; the route has no market filter.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OrderHistoryQuery {
    pub from_ms: Option<u64>,
    pub to_ms: Option<u64>,
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

/// Which end of the history a page starts from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SortOrder {
    /// Oldest first.
    Asc,
    /// Newest first.
    Desc,
}

/// Filters for the account-events history. The route requires an order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountEventsQuery {
    pub order: SortOrder,
    /// Only this engine event kind (`order_placed`, `funding_settled`, ...).
    pub event_type: Option<String>,
    pub from_ms: Option<u64>,
    pub to_ms: Option<u64>,
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

impl AccountEventsQuery {
    /// Every event, in `order`.
    #[must_use]
    pub fn new(order: SortOrder) -> Self {
        Self {
            order,
            event_type: None,
            from_ms: None,
            to_ms: None,
            limit: None,
            cursor: None,
        }
    }
}

/// Filters for the resolution history, which is not cursor-paged: narrow it
/// with the window.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ResolutionsQuery {
    pub event_id: Option<EventId>,
    pub from_ms: Option<u64>,
    pub to_ms: Option<u64>,
    /// At most 1000.
    pub limit: Option<u32>,
}

/// A candle width: `count` of `unit`, e.g. 5 minutes. Build it with
/// [`CandleResolution::new`], which refuses a count outside 1..=9999.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct CandleResolution {
    count: u16,
    unit: CandleUnit,
}

/// The unit of a [`CandleResolution`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CandleUnit {
    Minute,
    Hour,
    Day,
    Week,
    Month,
    Year,
}

impl CandleResolution {
    /// `1m`.
    pub const ONE_MINUTE: Self = Self {
        count: 1,
        unit: CandleUnit::Minute,
    };
    /// `1h`.
    pub const ONE_HOUR: Self = Self {
        count: 1,
        unit: CandleUnit::Hour,
    };
    /// `1d`.
    pub const ONE_DAY: Self = Self {
        count: 1,
        unit: CandleUnit::Day,
    };

    /// The largest count the gateway takes.
    pub const MAX_COUNT: u16 = 9_999;

    /// `count` of `unit`.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidInput`] for a count outside 1..=9999, which the
    /// gateway refuses.
    pub fn new(count: u16, unit: CandleUnit) -> Result<Self> {
        if !(1..=Self::MAX_COUNT).contains(&count) {
            return Err(Error::InvalidInput(format!(
                "candle count {count} is outside 1..={}",
                Self::MAX_COUNT
            )));
        }
        Ok(Self { count, unit })
    }

    #[must_use]
    pub const fn count(self) -> u16 {
        self.count
    }

    #[must_use]
    pub const fn unit(self) -> CandleUnit {
        self.unit
    }
}

impl fmt::Display for CandleResolution {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let unit = match self.unit {
            CandleUnit::Minute => 'm',
            CandleUnit::Hour => 'h',
            CandleUnit::Day => 'd',
            CandleUnit::Week => 'w',
            CandleUnit::Month => 'M',
            CandleUnit::Year => 'y',
        };
        write!(f, "{}{unit}", self.count)
    }
}

/// A positions-history bucket width: `count` of `unit`, e.g. 15 minutes; the
/// widths `/v1/portfolio` takes. Build it with [`HistoryInterval::new`], which
/// refuses a zero count.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct HistoryInterval {
    count: u32,
    unit: IntervalUnit,
}

/// The unit of a [`HistoryInterval`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum IntervalUnit {
    Second,
    Minute,
    Hour,
    Day,
}

impl HistoryInterval {
    /// `15m`.
    pub const FIFTEEN_MINUTES: Self = Self {
        count: 15,
        unit: IntervalUnit::Minute,
    };
    /// `1h`.
    pub const ONE_HOUR: Self = Self {
        count: 1,
        unit: IntervalUnit::Hour,
    };
    /// `1d`.
    pub const ONE_DAY: Self = Self {
        count: 1,
        unit: IntervalUnit::Day,
    };

    /// `count` of `unit`.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidInput`] for a zero count, which the indexer refuses.
    pub fn new(count: u32, unit: IntervalUnit) -> Result<Self> {
        if count == 0 {
            return Err(Error::InvalidInput(
                "history interval count must be at least 1".into(),
            ));
        }
        Ok(Self { count, unit })
    }

    #[must_use]
    pub const fn count(self) -> u32 {
        self.count
    }

    #[must_use]
    pub const fn unit(self) -> IntervalUnit {
        self.unit
    }
}

impl fmt::Display for HistoryInterval {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let unit = match self.unit {
            IntervalUnit::Second => 's',
            IntervalUnit::Minute => 'm',
            IntervalUnit::Hour => 'h',
            IntervalUnit::Day => 'd',
        };
        write!(f, "{}{unit}", self.count)
    }
}

/// Filters for the candle and BBO history. Without a window the gateway
/// returns its default recent window.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CandleQuery {
    pub market: MarketId,
    pub resolution: CandleResolution,
    pub from_ms: Option<u64>,
    pub to_ms: Option<u64>,
    /// At most 5000.
    pub limit: Option<u32>,
}

impl CandleQuery {
    /// The latest bars of `market` at `resolution`.
    #[must_use]
    pub fn new(market: MarketId, resolution: CandleResolution) -> Self {
        Self {
            market,
            resolution,
            from_ms: None,
            to_ms: None,
            limit: None,
        }
    }
}

// -- rows ---------------------------------------------------------------------

/// One executed fill, from `GET /v1/history/fills/{owner}`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub struct HistoryFill {
    #[serde(deserialize_with = "de_u64")]
    pub fill_id: u64,
    #[serde(deserialize_with = "de_market")]
    pub market: MarketId,
    /// micro-USDC.
    #[serde(deserialize_with = "de_whole")]
    pub price: u64,
    #[serde(deserialize_with = "de_u64")]
    pub quantity: u64,
    pub maker_owner: Address,
    pub taker_owner: Address,
    /// The resting order's side; the taker traded the other way.
    #[serde(deserialize_with = "de_side")]
    pub maker_side: Side,
    /// micro-USDC; negative is a rebate.
    #[serde(deserialize_with = "de_i64")]
    pub maker_fee: i64,
    #[serde(deserialize_with = "de_i64")]
    pub taker_fee: i64,
    #[serde(deserialize_with = "de_u64")]
    pub block_height: u64,
    /// Block time, ns since the epoch.
    #[serde(rename = "block_time", deserialize_with = "de_time")]
    pub block_time_ns: u64,
}

/// One indexed engine event of an account, from the order and
/// account-events history.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryEvent {
    /// The indexer's id; unique and increasing in commit order.
    pub event_id: IndexerEventId,
    pub owner: Address,
    pub block_height: u64,
    /// Block time, ns since the epoch.
    pub block_time_ns: u64,
    /// The transaction that caused it; `None` for a block event (funding,
    /// expiry, liquidation).
    pub tx_hash: Option<TxHash>,
    /// The event's position within its transaction (or the block's events).
    pub event_index: u32,
    /// The event, typed as on a receipt. A kind this version does not type
    /// is [`Event::Other`].
    pub event: Event,
}

#[derive(Deserialize)]
struct RawEvent {
    #[serde(deserialize_with = "de_u64")]
    event_id: u64,
    owner: Address,
    #[serde(deserialize_with = "de_u64")]
    block_height: u64,
    #[serde(deserialize_with = "de_time")]
    block_time: u64,
    tx_hash: String,
    event_index: u32,
    event_type: String,
    payload: serde_json::Map<String, serde_json::Value>,
}

impl TryFrom<RawEvent> for HistoryEvent {
    type Error = Error;

    fn try_from(r: RawEvent) -> Result<Self> {
        Ok(Self {
            event_id: IndexerEventId(r.event_id),
            owner: r.owner,
            block_height: r.block_height,
            block_time_ns: r.block_time,
            tx_hash: tx_hash(&r.tx_hash)?,
            event_index: r.event_index,
            event: typed_event(&r.event_type, r.payload)?,
        })
    }
}

/// An account's position on one market after a change, from
/// `GET /v1/history/positions/{owner}`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PositionSnapshot {
    pub market: MarketId,
    pub owner: Address,
    pub position: SnapshotPosition,
    pub block_height: u64,
    /// Block time, ns since the epoch.
    pub block_time_ns: u64,
}

/// The position a [`PositionSnapshot`] records.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SnapshotPosition {
    Open {
        side: Side,
        size: u64,
        /// micro-USDC.
        entry_price: u64,
    },
    /// The position went flat.
    Closed,
}

#[derive(Deserialize)]
struct RawSnapshot {
    #[serde(deserialize_with = "de_market")]
    market: MarketId,
    owner: Address,
    #[serde(default, deserialize_with = "de_opt_side")]
    side: Option<Side>,
    #[serde(deserialize_with = "de_u64")]
    size: u64,
    #[serde(default, deserialize_with = "de_opt_whole")]
    entry_px: Option<u64>,
    #[serde(deserialize_with = "de_u64")]
    block_height: u64,
    #[serde(deserialize_with = "de_time")]
    block_time: u64,
}

impl TryFrom<RawSnapshot> for PositionSnapshot {
    type Error = Error;

    fn try_from(r: RawSnapshot) -> Result<Self> {
        let position = match (r.size, r.side, r.entry_px) {
            (0, _, _) => SnapshotPosition::Closed,
            (size, Some(side), Some(entry_price)) => SnapshotPosition::Open {
                side,
                size,
                entry_price,
            },
            _ => {
                return Err(Error::Decode(
                    "position history: an open position without a side or entry".into(),
                ))
            }
        };
        Ok(Self {
            market: r.market,
            owner: r.owner,
            position,
            block_height: r.block_height,
            block_time_ns: r.block_time,
        })
    }
}

/// One funding payment, from `GET /v1/history/funding-payments/{owner}`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub struct FundingPayment {
    #[serde(deserialize_with = "de_market")]
    pub market: MarketId,
    pub owner: Address,
    /// micro-USDC to the owner; negative is paid.
    #[serde(deserialize_with = "de_i64")]
    pub payment: i64,
    #[serde(deserialize_with = "de_u64")]
    pub block_height: u64,
    /// Block time, ns since the epoch.
    #[serde(rename = "block_time", deserialize_with = "de_time")]
    pub block_time_ns: u64,
}

/// One trigger lifecycle event, from `GET /v1/history/triggers/{owner}`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TriggerHistoryEvent {
    pub owner: Address,
    pub market: MarketId,
    pub block_height: u64,
    /// Block time, ns since the epoch.
    pub block_time_ns: u64,
    /// With `block_height`, orders events within a block.
    pub execution_ordinal: u64,
    pub event_ordinal: u64,
    /// `position_triggers_set`, `position_trigger_executed`, ... A kind this
    /// version does not type is [`Event::Other`].
    pub event: Event,
}

#[derive(Deserialize)]
struct RawTriggerEvent {
    owner: Address,
    #[serde(deserialize_with = "de_market")]
    market: MarketId,
    #[serde(deserialize_with = "de_u64")]
    block_height: u64,
    #[serde(deserialize_with = "de_time")]
    block_time: u64,
    #[serde(deserialize_with = "de_u64")]
    execution_ordinal: u64,
    #[serde(deserialize_with = "de_u64")]
    event_ordinal: u64,
    event_type: String,
    payload: serde_json::Map<String, serde_json::Value>,
}

impl TryFrom<RawTriggerEvent> for TriggerHistoryEvent {
    type Error = Error;

    fn try_from(r: RawTriggerEvent) -> Result<Self> {
        Ok(Self {
            owner: r.owner,
            market: r.market,
            block_height: r.block_height,
            block_time_ns: r.block_time,
            execution_ordinal: r.execution_ordinal,
            event_ordinal: r.event_ordinal,
            event: typed_event(&r.event_type, r.payload)?,
        })
    }
}

/// How one position ended when its event resolved, from
/// `GET /v1/history/resolutions/{owner}`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resolution {
    pub event_id: EventId,
    /// The binary or conditional market the position was on.
    pub market: MarketId,
    pub owner: Address,
    pub side: Side,
    pub size: u64,
    pub outcome: ResolutionOutcome,
    pub block_height: u64,
    /// Block time, ms since the epoch.
    pub timestamp_ms: u64,
}

/// What resolution did to a position.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ResolutionOutcome {
    /// A Yes/No position paid out in cash.
    PredictionSettled {
        /// micro-USDC per share: `$1` to the winner, 0 to the loser.
        payoff_per_share: u64,
        /// micro-USDC to the owner.
        realized_pnl: i64,
    },
    /// A conditional's branch won: settled at the underlying's price.
    ConditionMet {
        /// micro-USDC.
        entry_price: u64,
        /// The underlying's oracle price at settlement, micro-USDC.
        settlement_price: u64,
        /// micro-USDC to the owner.
        realized_pnl: i64,
        conversion: Conversion,
    },
    /// A conditional's branch lost: removed with no cash movement.
    ConditionNotMet,
    /// A conditional settled by a Void at the underlying's price, weighted
    /// by the Void's Yes price.
    ConditionalVoidSettled {
        settlement_price: u64,
        realized_pnl: i64,
    },
}

/// Whether a winning conditional became a perpetual position.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Conversion {
    /// `size` opened on the underlying perpetual at the settlement price.
    Converted { size: u64 },
    /// It stayed cash, for this reason (the same type the `condition_met`
    /// receipt event carries).
    Fallback(ConversionFallbackReason),
    /// It stayed cash under an engine from before conversion existed, which
    /// recorded no reason.
    PreConversion,
}

#[derive(Deserialize)]
struct RawResolution {
    kind: String,
    #[serde(deserialize_with = "de_u64")]
    event_id: u64,
    #[serde(deserialize_with = "de_market")]
    market: MarketId,
    owner: Address,
    #[serde(deserialize_with = "de_side")]
    side: Side,
    #[serde(deserialize_with = "de_u64")]
    size: u64,
    entry_price: String,
    settlement_price: String,
    realized_pnl: String,
    converted_size: String,
    fallback_reason: String,
    #[serde(deserialize_with = "de_u64")]
    block_height: u64,
    #[serde(deserialize_with = "de_u64")]
    timestamp: u64,
}

impl TryFrom<RawResolution> for Resolution {
    type Error = Error;

    fn try_from(r: RawResolution) -> Result<Self> {
        let bad = |what: &str| Error::Decode(format!("resolution history: {what}"));
        let num = |s: &str, what: &str| s.parse::<u64>().map_err(|_| bad(what));
        let pnl = r
            .realized_pnl
            .parse::<i64>()
            .map_err(|_| bad("realized_pnl"))?;
        let outcome = match r.kind.as_str() {
            "prediction_settled" => ResolutionOutcome::PredictionSettled {
                payoff_per_share: num(&r.settlement_price, "settlement_price")?,
                realized_pnl: pnl,
            },
            "condition_met" => {
                let converted = num(&r.converted_size, "converted_size")?;
                let conversion = match (converted, r.fallback_reason.as_str()) {
                    (0, "") => Conversion::PreConversion,
                    (0, reason) => Conversion::Fallback(ConversionFallbackReason::from(reason)),
                    (size, "") => Conversion::Converted { size },
                    _ => return Err(bad("both converted and fell back")),
                };
                ResolutionOutcome::ConditionMet {
                    entry_price: num(&r.entry_price, "entry_price")?,
                    settlement_price: num(&r.settlement_price, "settlement_price")?,
                    realized_pnl: pnl,
                    conversion,
                }
            }
            "condition_not_met" => ResolutionOutcome::ConditionNotMet,
            "conditional_void_settled" => ResolutionOutcome::ConditionalVoidSettled {
                settlement_price: num(&r.settlement_price, "settlement_price")?,
                realized_pnl: pnl,
            },
            other => return Err(bad(&format!("unknown kind {other:?}"))),
        };
        Ok(Self {
            event_id: EventId(u32::try_from(r.event_id).map_err(|_| bad("event_id"))?),
            market: r.market,
            owner: r.owner,
            side: r.side,
            size: r.size,
            outcome,
            block_height: r.block_height,
            timestamp_ms: r.timestamp,
        })
    }
}

/// A non-negative decimal as the indexer serves it (`"69517000000.000000"`),
/// kept exact. Candle prices are micro-USDC; a BBO mid can be fractional.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Decimal(String);

impl Decimal {
    /// The decimal as served.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The value as an integer, when it has no fractional part.
    #[must_use]
    pub fn to_u64(&self) -> Option<u64> {
        whole(&self.0)
    }
}

impl fmt::Display for Decimal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for Decimal {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        let (int, frac) = s.split_once('.').unwrap_or((&s, "0"));
        let digits = |p: &str| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit());
        if !(digits(int) && digits(frac)) {
            return Err(D::Error::custom(format!("not a decimal: {s:?}")));
        }
        Ok(Self(s))
    }
}

/// One OHLCV bar, from `GET /v1/history/candles`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Candle {
    /// Bucket start, ns since the epoch.
    #[serde(rename = "t", deserialize_with = "de_time")]
    pub time_ns: u64,
    #[serde(rename = "o")]
    pub open: Decimal,
    #[serde(rename = "h")]
    pub high: Decimal,
    #[serde(rename = "l")]
    pub low: Decimal,
    #[serde(rename = "c")]
    pub close: Decimal,
    /// Contracts traded.
    #[serde(rename = "v")]
    pub volume: Decimal,
    /// micro-USDC traded.
    #[serde(rename = "quote_v")]
    pub quote_volume: Decimal,
    pub trades: u64,
}

/// One bar of the book's mid, `(bid + ask) / 2`, with its closing bid and ask,
/// from `GET /v1/history/bbo`. A bucket with no two-sided book is absent.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct BboCandle {
    /// Bucket start, ns since the epoch.
    #[serde(rename = "t", deserialize_with = "de_time")]
    pub time_ns: u64,
    #[serde(rename = "o")]
    pub open: Decimal,
    #[serde(rename = "h")]
    pub high: Decimal,
    #[serde(rename = "l")]
    pub low: Decimal,
    #[serde(rename = "c")]
    pub close: Decimal,
    /// The closing best bid, micro-USDC.
    #[serde(deserialize_with = "de_whole")]
    pub bid: u64,
    /// The closing best ask, micro-USDC.
    #[serde(deserialize_with = "de_whole")]
    pub ask: u64,
}

/// Bars over a window, oldest first. Empty buckets are absent.
///
/// For older bars, query again with `to_ms` at the first bar's time (or at
/// `from_ns` when the page is empty) while `has_more` is true.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CandlePage<C> {
    pub market: MarketId,
    pub resolution: CandleResolution,
    /// The window the gateway served, ns since the epoch.
    pub from_ns: u64,
    pub to_ns: u64,
    /// The oldest bar the market has, if any.
    pub earliest_ns: Option<u64>,
    /// Older bars exist before this window.
    pub has_more: bool,
    pub candles: Vec<C>,
}

#[derive(Deserialize)]
#[serde(bound = "C: DeserializeOwned")]
struct RawCandlePage<C> {
    #[serde(deserialize_with = "de_market")]
    market: MarketId,
    resolution: String,
    #[serde(deserialize_with = "de_time")]
    from: u64,
    #[serde(deserialize_with = "de_time")]
    to: u64,
    #[serde(default, deserialize_with = "de_opt_time")]
    earliest: Option<u64>,
    has_more: bool,
    candles: Vec<C>,
}

trait Bar {
    fn time_ns(&self) -> u64;
}
impl Bar for Candle {
    fn time_ns(&self) -> u64 {
        self.time_ns
    }
}
impl Bar for BboCandle {
    fn time_ns(&self) -> u64 {
        self.time_ns
    }
}

fn candle_page<C: Bar>(raw: RawCandlePage<C>, q: &CandleQuery) -> Result<CandlePage<C>> {
    let bad = |what: &str| Error::Decode(format!("candle history: {what}"));
    if raw.market != q.market || raw.resolution != q.resolution.to_string() {
        return Err(bad("the page is for another market or resolution"));
    }
    if raw.from >= raw.to {
        return Err(bad("an empty or inverted window"));
    }
    if raw
        .candles
        .windows(2)
        .any(|w| w[0].time_ns() >= w[1].time_ns())
    {
        return Err(bad("bars are not strictly oldest first"));
    }
    Ok(CandlePage {
        market: raw.market,
        resolution: q.resolution,
        from_ns: raw.from,
        to_ns: raw.to,
        earliest_ns: raw.earliest,
        has_more: raw.has_more,
        candles: raw.candles,
    })
}

// -- reads --------------------------------------------------------------------

/// An owner page as the indexer serves it: rows under `key`, a cursor that
/// is `""` on the last page. `check` refuses a row the query did not ask for
/// (another owner, market or window), naming why.
///
/// A row that does not decode is [`Error::HistoryRow`], which keeps the
/// page's cursor so a caller can continue past it.
fn page<R: DeserializeOwned, T>(
    mut body: Json,
    key: &str,
    convert: impl Fn(R) -> Result<T>,
    check: impl Fn(&T) -> std::result::Result<(), String>,
) -> Result<HistoryPage<T>> {
    let bad = |what: String| Error::Decode(format!("{key} history: {what}"));
    let next_cursor = match body.remove("next_cursor") {
        Some(serde_json::Value::String(c)) => (!c.is_empty()).then_some(c),
        _ => return Err(bad("no next_cursor".into())),
    };
    let rows = match body.remove(key) {
        Some(serde_json::Value::Array(rows)) => rows,
        _ => return Err(bad(format!("no {key:?} rows"))),
    };
    let rows = rows
        .into_iter()
        .map(|row| {
            serde_json::from_value::<R>(row)
                .map_err(|e| Error::Decode(e.to_string()))
                .and_then(&convert)
                .map_err(|e| Error::HistoryRow {
                    message: format!("{key} history: {e}"),
                    next_cursor: next_cursor.clone(),
                })
        })
        .collect::<Result<Vec<T>>>()?;
    if let Some(why) = rows.iter().find_map(|row| check(row).err()) {
        return Err(bad(why));
    }
    Ok(HistoryPage { rows, next_cursor })
}

/// `Err` naming the filter a row is outside of.
fn within(
    what: &str,
    owner_ok: bool,
    market: Option<MarketId>,
    row_market: MarketId,
) -> std::result::Result<(), String> {
    if !owner_ok {
        return Err(format!("a {what} that is not the owner's"));
    }
    match market {
        Some(m) if m != row_market => {
            Err(format!("a {what} for market {row_market}, asked for {m}"))
        }
        _ => Ok(()),
    }
}

/// Whether a block time in ns lies in the half-open `[from_ms, to_ms)`
/// window the indexer filters on.
fn in_window_ns(t_ns: u64, from_ms: Option<u64>, to_ms: Option<u64>) -> bool {
    let ns = |ms: u64| u128::from(ms) * 1_000_000;
    let t = u128::from(t_ns);
    from_ms.is_none_or(|f| t >= ns(f)) && to_ms.is_none_or(|e| t < ns(e))
}

fn window_check(
    what: &str,
    t_ns: u64,
    from_ms: Option<u64>,
    to_ms: Option<u64>,
) -> std::result::Result<(), String> {
    if in_window_ns(t_ns, from_ms, to_ms) {
        Ok(())
    } else {
        Err(format!("a {what} outside the window asked for"))
    }
}

fn query(path: &str, pairs: &[(&str, Option<String>)]) -> String {
    let mut q = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in pairs {
        if let Some(v) = v {
            q.append_pair(k, v);
        }
    }
    let q = q.finish();
    if q.is_empty() {
        path.to_owned()
    } else {
        format!("{path}?{q}")
    }
}

fn window(
    from_ms: Option<u64>,
    to_ms: Option<u64>,
    limit: Option<u32>,
) -> [(&'static str, Option<String>); 3] {
    [
        ("from", from_ms.map(|v| v.to_string())),
        ("to", to_ms.map(|v| v.to_string())),
        ("limit", limit.map(|v| v.to_string())),
    ]
}

impl HistoryQuery {
    fn path(&self, base: &str) -> String {
        self.path_with(base, None)
    }

    fn path_with(&self, base: &str, interval: Option<HistoryInterval>) -> String {
        let [from, to, limit] = window(self.from_ms, self.to_ms, self.limit);
        query(
            base,
            &[
                ("market", self.market.map(|m| m.to_string())),
                from,
                to,
                limit,
                ("interval", interval.map(|i| i.to_string())),
                ("cursor", self.cursor.clone()),
            ],
        )
    }
}

impl InfoClient {
    /// `GET /v1/history/fills/{owner}`: `owner`'s fills, as maker or taker,
    /// newest first.
    ///
    /// # Errors
    ///
    /// A read failure: [`Error::Transport`], [`Error::Http`], [`Error::Decode`]
    /// (also for a fill `owner` is not party to) or
    /// [`Error::ResponseTooLarge`].
    pub async fn fill_history(
        &self,
        owner: Address,
        q: &HistoryQuery,
    ) -> Result<HistoryPage<HistoryFill>> {
        let body: Json = self
            .get_json(&q.path(&format!("/v1/history/fills/{owner}")))
            .await?;
        page(body, "fills", Ok, |f: &HistoryFill| {
            within(
                "fill",
                f.maker_owner == owner || f.taker_owner == owner,
                q.market,
                f.market,
            )
        })
    }

    /// `GET /v1/history/orders/{owner}`: `owner`'s order lifecycle events
    /// (placed, amended, cancelled, rejected, filled), newest first.
    ///
    /// # Errors
    ///
    /// A read failure: [`Error::Transport`], [`Error::Http`], [`Error::Decode`]
    /// (also for another owner's event, or a typed event whose payload does
    /// not read) or [`Error::ResponseTooLarge`].
    pub async fn order_history(
        &self,
        owner: Address,
        q: &OrderHistoryQuery,
    ) -> Result<HistoryPage<HistoryEvent>> {
        let [from, to, limit] = window(q.from_ms, q.to_ms, q.limit);
        let path = query(
            &format!("/v1/history/orders/{owner}"),
            &[from, to, limit, ("cursor", q.cursor.clone())],
        );
        let body: Json = self.get_json(&path).await?;
        page(
            body,
            "orders",
            <HistoryEvent as TryFrom<RawEvent>>::try_from,
            |e| {
                if e.owner != owner {
                    return Err("an event that is not the owner's".into());
                }
                window_check("event", e.block_time_ns, q.from_ms, q.to_ms)
            },
        )
    }

    /// `GET /v1/history/positions/{owner}`: `owner`'s position after each
    /// change, newest first.
    ///
    /// # Errors
    ///
    /// A read failure: [`Error::Transport`], [`Error::Http`], [`Error::Decode`]
    /// (also for another owner's row, or an open position without a side or
    /// entry) or [`Error::ResponseTooLarge`].
    pub async fn position_history(
        &self,
        owner: Address,
        q: &HistoryQuery,
    ) -> Result<HistoryPage<PositionSnapshot>> {
        self.position_snapshots(owner, q, None).await
    }

    /// [`position_history`](Self::position_history) at `interval`: per
    /// market, the last snapshot in each epoch-aligned bucket of
    /// `[from_ms, to_ms)`. A bucket in which a market has no snapshot has no
    /// row for it. Rows, order and cursor are as without it; continue with the
    /// same `interval`. Without `from_ms`/`to_ms` the window is the 24 hours
    /// before now, not all history.
    ///
    /// # Errors
    ///
    /// As [`position_history`](Self::position_history); an interval over 365
    /// days, or a window of more than 5,000 buckets, is [`Error::Http`]
    /// carrying `invalid_interval`.
    pub async fn position_history_by_interval(
        &self,
        owner: Address,
        q: &HistoryQuery,
        interval: HistoryInterval,
    ) -> Result<HistoryPage<PositionSnapshot>> {
        self.position_snapshots(owner, q, Some(interval)).await
    }

    async fn position_snapshots(
        &self,
        owner: Address,
        q: &HistoryQuery,
        interval: Option<HistoryInterval>,
    ) -> Result<HistoryPage<PositionSnapshot>> {
        let body: Json = self
            .get_json(&q.path_with(&format!("/v1/history/positions/{owner}"), interval))
            .await?;
        page(
            body,
            "positions",
            <PositionSnapshot as TryFrom<RawSnapshot>>::try_from,
            |p| within("position", p.owner == owner, q.market, p.market),
        )
    }

    /// `GET /v1/history/funding-payments/{owner}`: `owner`'s funding
    /// payments, newest first.
    ///
    /// # Errors
    ///
    /// A read failure: [`Error::Transport`], [`Error::Http`], [`Error::Decode`]
    /// (also for another owner's row) or [`Error::ResponseTooLarge`].
    pub async fn funding_history(
        &self,
        owner: Address,
        q: &HistoryQuery,
    ) -> Result<HistoryPage<FundingPayment>> {
        let body: Json = self
            .get_json(&q.path(&format!("/v1/history/funding-payments/{owner}")))
            .await?;
        page(body, "funding_payments", Ok, |p: &FundingPayment| {
            within("payment", p.owner == owner, q.market, p.market)?;
            window_check("payment", p.block_time_ns, q.from_ms, q.to_ms)
        })
    }

    /// `GET /v1/history/account-events?owner=`: every engine event of
    /// `owner`, in `q.order`.
    ///
    /// # Errors
    ///
    /// A read failure: [`Error::Transport`], [`Error::Http`], [`Error::Decode`]
    /// (also for another owner's event, or a typed event whose payload does
    /// not read) or [`Error::ResponseTooLarge`].
    pub async fn account_event_history(
        &self,
        owner: Address,
        q: &AccountEventsQuery,
    ) -> Result<HistoryPage<HistoryEvent>> {
        let order = match q.order {
            SortOrder::Asc => "asc",
            SortOrder::Desc => "desc",
        };
        let [from, to, limit] = window(q.from_ms, q.to_ms, q.limit);
        let path = query(
            "/v1/history/account-events",
            &[
                ("owner", Some(owner.to_string())),
                ("order", Some(order.to_owned())),
                ("event_type", q.event_type.clone()),
                from,
                to,
                limit,
                ("cursor", q.cursor.clone()),
            ],
        );
        let body: Json = self.get_json(&path).await?;
        if let Some(kind) = &q.event_type {
            let rows = body.get("account_events").and_then(|r| r.as_array());
            let other = rows.into_iter().flatten().find_map(|r| {
                r.get("event_type")
                    .and_then(|t| t.as_str())
                    .filter(|t| t != kind)
            });
            if let Some(other) = other {
                return Err(Error::Decode(format!(
                    "account_events history: a {other} event, asked for {kind}"
                )));
            }
        }
        page(
            body,
            "account_events",
            <HistoryEvent as TryFrom<RawEvent>>::try_from,
            |e| {
                if e.owner != owner {
                    return Err("an event that is not the owner's".into());
                }
                window_check("event", e.block_time_ns, q.from_ms, q.to_ms)
            },
        )
    }

    /// `GET /v1/history/resolutions/{owner}`: how each of `owner`'s
    /// positions ended at resolution, newest first. Not cursor-paged.
    ///
    /// # Errors
    ///
    /// A read failure: [`Error::Transport`], [`Error::Http`], [`Error::Decode`]
    /// (also for another owner's row or a kind this version does not know)
    /// or [`Error::ResponseTooLarge`].
    pub async fn resolution_history(
        &self,
        owner: Address,
        q: &ResolutionsQuery,
    ) -> Result<Vec<Resolution>> {
        let [from, to, limit] = window(q.from_ms, q.to_ms, q.limit);
        let path = query(
            &format!("/v1/history/resolutions/{owner}"),
            &[
                ("event_id", q.event_id.map(|e| e.0.to_string())),
                from,
                to,
                limit,
            ],
        );
        let rows: Vec<RawResolution> = self.get_json(&path).await?;
        let rows = rows
            .into_iter()
            .map(Resolution::try_from)
            .collect::<Result<Vec<_>>>()?;
        let bad = |what: &str| Error::Decode(format!("resolution history: {what}"));
        for r in &rows {
            if r.owner != owner {
                return Err(bad("a row that is not the owner's"));
            }
            if q.event_id.is_some_and(|id| id != r.event_id) {
                return Err(bad("a row for another event"));
            }
            let ms = |t: Option<u64>| t.map(u128::from);
            let t = u128::from(r.timestamp_ms);
            if ms(q.from_ms).is_some_and(|f| t < f) || ms(q.to_ms).is_some_and(|e| t >= e) {
                return Err(bad("a row outside the window asked for"));
            }
        }
        Ok(rows)
    }

    /// `GET /v1/history/triggers/{owner}`: `owner`'s stop-loss/take-profit
    /// lifecycle events, newest first.
    ///
    /// # Errors
    ///
    /// A read failure: [`Error::Transport`], [`Error::Http`], [`Error::Decode`]
    /// (also for another owner's event, or a typed event whose payload does
    /// not read) or [`Error::ResponseTooLarge`].
    pub async fn trigger_history(
        &self,
        owner: Address,
        q: &HistoryQuery,
    ) -> Result<HistoryPage<TriggerHistoryEvent>> {
        let body: Json = self
            .get_json(&q.path(&format!("/v1/history/triggers/{owner}")))
            .await?;
        page(
            body,
            "trigger_events",
            <TriggerHistoryEvent as TryFrom<RawTriggerEvent>>::try_from,
            |e| within("trigger event", e.owner == owner, q.market, e.market),
        )
    }

    /// `GET /v1/history/candles`: trade OHLCV bars.
    ///
    /// # Errors
    ///
    /// A read failure: [`Error::Transport`], [`Error::Http`], [`Error::Decode`]
    /// (also for a page of another market or resolution) or
    /// [`Error::ResponseTooLarge`].
    pub async fn candles(&self, q: &CandleQuery) -> Result<CandlePage<Candle>> {
        let raw = self
            .get_json(&candle_path("/v1/history/candles", q))
            .await?;
        candle_page(raw, q)
    }

    /// `GET /v1/history/bbo`: bars of the book's mid, with closing bid and
    /// ask.
    ///
    /// # Errors
    ///
    /// As [`Self::candles`].
    pub async fn bbo_candles(&self, q: &CandleQuery) -> Result<CandlePage<BboCandle>> {
        let raw = self.get_json(&candle_path("/v1/history/bbo", q)).await?;
        candle_page(raw, q)
    }
}

fn candle_path(base: &str, q: &CandleQuery) -> String {
    let [from, to, limit] = window(q.from_ms, q.to_ms, q.limit);
    query(
        base,
        &[
            ("market", Some(q.market.to_string())),
            ("resolution", Some(q.resolution.to_string())),
            from,
            to,
            limit,
        ],
    )
}

// -- field readers ------------------------------------------------------------

/// A block event's key (`height-N-kind-block-event-I`) is not a hash;
/// anything else must be one.
fn tx_hash(key: &str) -> Result<Option<TxHash>> {
    if key.starts_with("height-") {
        return Ok(None);
    }
    TxHash::from_hex(key)
        .map(Some)
        .map_err(|_| Error::Decode(format!("history: tx_hash {key:?} is not a hash")))
}

/// The payload as a receipt event; one whose kind is typed but whose
/// attributes do not read, or are not all scalars, is refused. A kind this
/// version does not type is [`Event::Other`], structured attributes and all
/// (as JSON text).
fn typed_event(kind: &str, payload: serde_json::Map<String, serde_json::Value>) -> Result<Event> {
    let structured = payload
        .iter()
        .find(|(_, v)| v.is_object() || v.is_array())
        .map(|(key, _)| key.clone());
    match Event::from(raw_from_json(kind, &serde_json::Value::Object(payload))) {
        Event::Malformed(raw) => Err(Error::Decode(format!(
            "history: {} attributes do not read",
            raw.kind
        ))),
        event @ Event::Other(_) => Ok(event),
        event => match structured {
            Some(key) => Err(Error::Decode(format!(
                "history: {kind} attribute {key:?} is not a scalar"
            ))),
            None => Ok(event),
        },
    }
}

fn de_i64<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<i64, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Raw {
        N(i64),
        S(String),
    }
    match Raw::deserialize(d)? {
        Raw::N(n) => Ok(n),
        Raw::S(s) => s.parse().map_err(D::Error::custom),
    }
}

/// An integer the indexer may write with zero decimals (`"80310000.000000"`).
fn whole(s: &str) -> Option<u64> {
    let (int, frac) = s.split_once('.').unwrap_or((s, ""));
    if !frac.bytes().all(|b| b == b'0') || (s.contains('.') && frac.is_empty()) {
        return None;
    }
    if int.is_empty() || !int.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    int.parse().ok()
}

fn de_whole<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<u64, D::Error> {
    let s = String::deserialize(d)?;
    whole(&s).ok_or_else(|| D::Error::custom(format!("not a whole number: {s:?}")))
}

fn de_opt_whole<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Option<u64>, D::Error> {
    Option::<String>::deserialize(d)?
        .map(|s| whole(&s).ok_or_else(|| D::Error::custom(format!("not a whole number: {s:?}"))))
        .transpose()
}

fn de_opt_side<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Option<Side>, D::Error> {
    #[derive(Deserialize)]
    struct S(#[serde(deserialize_with = "de_side")] Side);
    Ok(Option::<S>::deserialize(d)?.map(|s| s.0))
}

fn de_time<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<u64, D::Error> {
    let s = String::deserialize(d)?;
    utc_ns(&s).ok_or_else(|| D::Error::custom(format!("not a UTC RFC 3339 time: {s:?}")))
}

fn de_opt_time<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Option<u64>, D::Error> {
    Option::<String>::deserialize(d)?
        .map(|s| utc_ns(&s).ok_or_else(|| D::Error::custom(format!("not a UTC time: {s:?}"))))
        .transpose()
}

/// `YYYY-MM-DDTHH:MM:SS[.f{1,9}]Z` as ns since the epoch; years 1970..=2554.
fn utc_ns(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    let (head, frac) = s.strip_suffix('Z')?.split_at_checked(19)?;
    let shape_ok = b.len() >= 20
        && [4, 7].iter().all(|&i| b[i] == b'-')
        && b[10] == b'T'
        && [13, 16].iter().all(|&i| b[i] == b':');
    if !shape_ok {
        return None;
    }
    let field = |r: std::ops::Range<usize>| -> Option<u64> {
        let part = head.get(r)?;
        part.bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| part.parse().ok())
            .flatten()
    };
    let (year, month, day) = (field(0..4)?, field(5..7)?, field(8..10)?);
    let (hour, minute, second) = (field(11..13)?, field(14..16)?, field(17..19)?);
    let nanos = match frac.strip_prefix('.') {
        None if frac.is_empty() => 0,
        Some(f) if (1..=9).contains(&f.len()) && f.bytes().all(|c| c.is_ascii_digit()) => {
            format!("{f:0<9}").parse().ok()?
        }
        _ => return None,
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let max_day = *month_days.get(usize::try_from(month).ok()?.checked_sub(1)?)?;
    if year < 1970 || day == 0 || day > max_day || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    // Days since 1970-01-01 (Hinnant's days_from_civil), in checked steps.
    let y = if month <= 2 {
        year.checked_sub(1)?
    } else {
        year
    };
    let (era, yoe) = (y / 400, y % 400);
    let mp = if month > 2 {
        month.checked_sub(3)?
    } else {
        month.checked_add(9)?
    };
    let doy = (mp.checked_mul(153)?.checked_add(2)? / 5)
        .checked_add(day)?
        .checked_sub(1)?;
    let doe = yoe
        .checked_mul(365)?
        .checked_add(yoe / 4)?
        .checked_sub(yoe / 100)?
        .checked_add(doy)?;
    let days = era
        .checked_mul(146_097)?
        .checked_add(doe)?
        .checked_sub(719_468)?;
    let secs = days
        .checked_mul(86_400)?
        .checked_add(hour.checked_mul(3_600)?)?
        .checked_add(minute.checked_mul(60)?)?
        .checked_add(second)?;
    secs.checked_mul(1_000_000_000)?.checked_add(nanos)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn utc_times_read_exactly_and_refuse_anything_else() {
        assert_eq!(utc_ns("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            utc_ns("2026-11-13T11:19:31.069857Z"),
            Some(1_794_568_771_069_857_000)
        );
        assert_eq!(
            utc_ns("2000-02-29T23:59:59.5Z"),
            Some(951_868_799_500_000_000)
        );
        for bad in [
            "2026-11-13T11:19:31",
            "2026-11-13 11:19:31Z",
            "2026-02-29T00:00:00Z",
            "2026-13-01T00:00:00Z",
            "2026-11-13T24:00:00Z",
            "2026-11-13T11:19:60Z",
            "2026-11-13T11:19:31.Z",
            "2026-11-13T11:19:31.0123456789Z",
            "2026-11-13T11:19:31+00:00",
            "1969-12-31T23:59:59Z",
            "+2026-11-13T11:19:31Z",
        ] {
            assert_eq!(utc_ns(bad), None, "{bad}");
        }
    }

    #[test]
    fn whole_numbers_allow_zero_decimals_only() {
        assert_eq!(whole("80310000.000000"), Some(80_310_000));
        assert_eq!(whole("7"), Some(7));
        for bad in ["1.5", "1.", ".0", "-1", "", "1e3", "+1"] {
            assert_eq!(whole(bad), None, "{bad}");
        }
    }

    #[test]
    fn history_interval_renders_as_the_indexer_names_it() {
        assert_eq!(HistoryInterval::FIFTEEN_MINUTES.to_string(), "15m");
        assert_eq!(HistoryInterval::ONE_HOUR.to_string(), "1h");
        assert_eq!(HistoryInterval::ONE_DAY.to_string(), "1d");
        assert_eq!(
            HistoryInterval::new(30, IntervalUnit::Second)
                .unwrap()
                .to_string(),
            "30s"
        );
        assert!(matches!(
            HistoryInterval::new(0, IntervalUnit::Hour),
            Err(Error::InvalidInput(_))
        ));
    }

    #[test]
    fn candle_resolution_renders_as_the_gateway_names_it() {
        assert_eq!(CandleResolution::ONE_MINUTE.to_string(), "1m");
        assert_eq!(
            CandleResolution::new(4, CandleUnit::Month)
                .unwrap()
                .to_string(),
            "4M"
        );
        for count in [0, 10_000] {
            assert!(matches!(
                CandleResolution::new(count, CandleUnit::Minute),
                Err(Error::InvalidInput(_))
            ));
        }
    }
}
