//! Typed engine events, from a transaction's receipt or the account feed.
//!
//! The engine writes each event as string attributes: numbers are decimal
//! strings, `""` means absent, and a client order id of `"0"` is the engine's
//! "none". [`Event::from`] reads them once, so a bot matches on [`Event`]
//! instead of string keys. A kind this version does not type stays raw as
//! [`Event::Other`]; a kind it types whose attributes do not read stays raw as
//! [`Event::Malformed`], so a bad fill is never mistaken for an unknown event.

use std::fmt;
use std::str::FromStr;

use proof_trading_sdk::gateway::{TxAttribute, TxEvent};
use proof_trading_sdk::types::{MarketId, OrderId, Side, TimeInForce};

use crate::address::Address;
use crate::exchange::EngineError;

/// What happened, by engine event.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum Event {
    /// `trade_executed`: a fill.
    Fill(Fill),
    /// `order_placed`: an order rested on the book.
    OrderPlaced(OrderPlaced),
    /// `order_cancelled`: a resting order left the book unfilled or part
    /// filled (by request, expiry, reduce-only clamp, ...).
    OrderCancelled(OrderCancelled),
    /// `order_amended`: a resting order's price or size changed in place.
    OrderAmended(OrderAmended),
    /// `order_rejected`: the engine refused an order in the block.
    OrderRejected(OrderRejected),
    /// `market_order_processed`: an immediate order finished.
    MarketOrderProcessed(MarketOrderProcessed),
    /// `position_updated`: a position's size or entry changed.
    PositionUpdated(PositionUpdated),
    /// `position_closed`: a position went flat.
    PositionClosed(PositionClosed),
    /// `funding_settled`: a funding payment.
    FundingSettled(FundingSettled),
    /// `deposited`: collateral arrived.
    Deposited(Deposited),
    /// An event kind this version does not type, as received.
    Other(TxEvent),
    /// One of the kinds above whose attributes did not read (a required
    /// attribute missing, or a value that does not parse), as received.
    Malformed(TxEvent),
}

/// `trade_executed`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fill {
    pub fill_id: u64,
    pub market: MarketId,
    /// micro-USDC.
    pub price: u64,
    pub quantity: u64,
    pub maker_owner: Address,
    pub taker_owner: Address,
    /// The resting order's side; the taker traded the other way.
    pub maker_side: Side,
    pub maker_order_id: OrderId,
    pub taker_order_id: OrderId,
    pub maker_client_order_id: Option<u64>,
    pub taker_client_order_id: Option<u64>,
    /// micro-USDC; negative is a rebate.
    pub maker_fee: i64,
    pub taker_fee: i64,
}

impl Fill {
    /// The aggressing order's side: always the opposite of `maker_side`.
    #[must_use]
    pub fn taker_side(&self) -> Side {
        opposite(self.maker_side)
    }
}

/// `order_placed`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OrderPlaced {
    pub order_id: OrderId,
    pub market: MarketId,
    pub side: Side,
    pub price: u64,
    pub quantity: u64,
    pub client_order_id: Option<u64>,
    pub post_only: bool,
    pub reduce_only: bool,
    pub time_in_force: TimeInForce,
}

/// `order_cancelled`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderCancelled {
    pub order_id: OrderId,
    pub market: MarketId,
    pub client_order_id: Option<u64>,
    pub original_quantity: u64,
    pub filled_quantity: u64,
    pub remaining_quantity: u64,
    pub reason: CancelReason,
}

/// Why a resting order left the book.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum CancelReason {
    /// The owner (or its agent) cancelled it.
    UserRequested,
    Expired,
    AdminForce,
    Liquidation,
    /// An engine upgrade moved its book and the order would have crossed.
    Upgrade,
    /// A reduce-only order had no position left to reduce.
    ReduceOnly,
    /// The maker could not pay its side of a fill.
    Unfunded,
    /// The fill would have left the maker below maintenance.
    InsufficientMargin,
    /// The maker's own position cap refused the fill.
    MakerRefused,
    /// A reason this version does not name, as the engine wrote it.
    Other(String),
}

impl CancelReason {
    /// The engine's name for the reason, e.g. `user_requested`.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::UserRequested => "user_requested",
            Self::Expired => "expired",
            Self::AdminForce => "admin_force",
            Self::Liquidation => "liquidation",
            Self::Upgrade => "upgrade",
            Self::ReduceOnly => "reduce_only",
            Self::Unfunded => "unfunded",
            Self::InsufficientMargin => "insufficient_margin",
            Self::MakerRefused => "maker_refused",
            Self::Other(s) => s,
        }
    }
}

impl From<&str> for CancelReason {
    fn from(s: &str) -> Self {
        match s {
            "user_requested" => Self::UserRequested,
            "expired" => Self::Expired,
            "admin_force" => Self::AdminForce,
            "liquidation" => Self::Liquidation,
            "upgrade" => Self::Upgrade,
            "reduce_only" => Self::ReduceOnly,
            "unfunded" => Self::Unfunded,
            "insufficient_margin" => Self::InsufficientMargin,
            "maker_refused" => Self::MakerRefused,
            other => Self::Other(other.to_owned()),
        }
    }
}

impl fmt::Display for CancelReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// `order_amended`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OrderAmended {
    pub order_id: OrderId,
    pub market: MarketId,
    pub side: Side,
    pub client_order_id: Option<u64>,
    pub old_price: u64,
    pub new_price: u64,
    pub old_quantity: u64,
    pub new_quantity: u64,
    pub filled_quantity: u64,
    pub remaining_quantity: u64,
    /// The amend cost the order its queue position.
    pub queue_priority_reset: bool,
}

/// `order_rejected`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OrderRejected {
    pub market: MarketId,
    pub client_order_id: Option<u64>,
    pub error: EngineError,
}

/// `market_order_processed`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarketOrderProcessed {
    pub order_id: OrderId,
    pub market: MarketId,
    pub side: Side,
    pub requested_quantity: u64,
    pub filled_quantity: u64,
    pub client_order_id: Option<u64>,
    /// Why part went unfilled, when it did.
    pub unfilled_reason: Option<String>,
}

/// `position_updated`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PositionUpdated {
    pub market: MarketId,
    pub side: Side,
    pub size: u64,
    pub entry_price: u64,
    /// micro-USDC realized by this change.
    pub realized_pnl: i64,
}

/// `position_closed`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PositionClosed {
    pub market: MarketId,
    pub realized_pnl: i64,
}

/// `funding_settled`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FundingSettled {
    pub market: MarketId,
    /// micro-USDC; positive is paid to this account.
    pub payment: i64,
}

/// `deposited`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Deposited {
    pub amount: u64,
    pub new_balance: u64,
}

// -- decoding ------------------------------------------------------------------

/// Reads the engine's string attributes.
///
/// A required attribute (`u64`, `side`, ...) must be present and parse. An
/// optional one (`opt_*`) may be absent or `""`, but a value that is there
/// must parse: `None` from either means the event is malformed.
struct Attrs<'a>(&'a [TxAttribute]);

impl Attrs<'_> {
    fn str(&self, key: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|a| a.key == key)
            .map(|a| a.value.as_str())
    }
    fn parse<T: FromStr>(&self, key: &str) -> Option<T> {
        self.str(key)?.parse().ok()
    }
    /// `Some(None)` when absent or empty, `None` when present and unreadable.
    fn opt<T: FromStr>(&self, key: &str) -> Option<Option<T>> {
        match self.str(key) {
            None | Some("") => Some(None),
            Some(s) => s.parse().ok().map(Some),
        }
    }
    fn u64(&self, key: &str) -> Option<u64> {
        self.parse(key)
    }
    fn market(&self, key: &str) -> Option<MarketId> {
        self.parse(key)
    }
    fn side(&self, key: &str) -> Option<Side> {
        side(self.str(key)?)
    }
    fn address(&self, key: &str) -> Option<Address> {
        self.parse(key)
    }
    /// Absent, `""` or `"0"` (the engine's "none") reads as `0`.
    fn opt_u64(&self, key: &str) -> Option<u64> {
        Some(self.opt(key)?.unwrap_or(0))
    }
    fn opt_i64(&self, key: &str) -> Option<i64> {
        Some(self.opt(key)?.unwrap_or(0))
    }
    fn opt_bool(&self, key: &str) -> Option<bool> {
        Some(self.opt(key)?.unwrap_or(false))
    }
    /// A client order id: absent, `""` and `"0"` all mean none.
    fn client_order_id(&self, key: &str) -> Option<Option<u64>> {
        Some(self.opt::<u64>(key)?.filter(|&id| id != 0))
    }
    /// A string that is absent when empty.
    fn text(&self, key: &str) -> Option<String> {
        self.str(key).filter(|s| !s.is_empty()).map(str::to_owned)
    }
    fn time_in_force(&self, key: &str) -> Option<TimeInForce> {
        match self.str(key) {
            None | Some("") => Some(TimeInForce::default()),
            Some("gtc" | "Gtc") => Some(TimeInForce::Gtc),
            Some("ioc" | "Ioc") => Some(TimeInForce::Ioc),
            Some("fok" | "Fok") => Some(TimeInForce::Fok),
            Some(_) => None,
        }
    }
}

fn side(s: &str) -> Option<Side> {
    match s {
        "buy" | "Buy" | "bid" => Some(Side::Buy),
        "sell" | "Sell" | "ask" => Some(Side::Sell),
        _ => None,
    }
}

const fn opposite(side: Side) -> Side {
    match side {
        Side::Buy => Side::Sell,
        Side::Sell => Side::Buy,
    }
}

impl From<TxEvent> for Event {
    fn from(raw: TxEvent) -> Self {
        match typed(&raw.kind, &Attrs(&raw.attributes)) {
            Some(Some(event)) => event,
            Some(None) => Event::Malformed(raw),
            None => Event::Other(raw),
        }
    }
}

#[cfg(any(feature = "ws", test))]
/// A feed payload (a JSON object of attributes) as the raw event `kind`.
/// Non-string values keep their JSON text.
pub(crate) fn raw_from_json(kind: &str, payload: &serde_json::Value) -> TxEvent {
    use serde_json::Value;
    let attributes = payload
        .as_object()
        .into_iter()
        .flatten()
        .map(|(key, value)| TxAttribute {
            key: key.clone(),
            value: match value {
                Value::String(s) => s.clone(),
                Value::Null => String::new(),
                v => v.to_string(),
            },
        })
        .collect();
    TxEvent {
        kind: kind.to_owned(),
        attributes,
    }
}

/// `None` for a kind this version does not type; `Some(None)` for a typed
/// kind whose attributes do not read.
fn typed(event_type: &str, a: &Attrs<'_>) -> Option<Option<Event>> {
    Some(match event_type {
        "trade_executed" => fill(a).map(Event::Fill),
        "order_placed" => order_placed(a).map(Event::OrderPlaced),
        "order_cancelled" => order_cancelled(a).map(Event::OrderCancelled),
        "order_amended" => order_amended(a).map(Event::OrderAmended),
        "order_rejected" => order_rejected(a).map(Event::OrderRejected),
        "market_order_processed" => market_order_processed(a).map(Event::MarketOrderProcessed),
        "position_updated" => position_updated(a).map(Event::PositionUpdated),
        "position_closed" => position_closed(a).map(Event::PositionClosed),
        "funding_settled" => funding_settled(a).map(Event::FundingSettled),
        "deposited" => deposited(a).map(Event::Deposited),
        _ => return None,
    })
}

fn fill(a: &Attrs<'_>) -> Option<Fill> {
    Some(Fill {
        fill_id: a.u64("fill_id")?,
        market: a.market("market")?,
        price: a.u64("price")?,
        quantity: a.u64("quantity")?,
        maker_owner: a.address("maker_owner")?,
        taker_owner: a.address("taker_owner")?,
        maker_side: a.side("maker_side")?,
        maker_order_id: a.u64("maker_order_id")?,
        taker_order_id: a.u64("taker_order_id")?,
        maker_client_order_id: a.client_order_id("maker_client_order_id")?,
        taker_client_order_id: a.client_order_id("taker_client_order_id")?,
        maker_fee: a.opt_i64("maker_fee")?,
        taker_fee: a.opt_i64("taker_fee")?,
    })
}

fn order_placed(a: &Attrs<'_>) -> Option<OrderPlaced> {
    Some(OrderPlaced {
        order_id: a.u64("order_id")?,
        market: a.market("market")?,
        side: a.side("side")?,
        price: a.u64("price")?,
        quantity: a.u64("quantity")?,
        client_order_id: a.client_order_id("client_order_id")?,
        post_only: a.opt_bool("post_only")?,
        reduce_only: a.opt_bool("reduce_only")?,
        time_in_force: a.time_in_force("time_in_force")?,
    })
}

fn order_cancelled(a: &Attrs<'_>) -> Option<OrderCancelled> {
    Some(OrderCancelled {
        order_id: a.u64("order_id")?,
        market: a.market("market")?,
        client_order_id: a.client_order_id("client_order_id")?,
        original_quantity: a.opt_u64("original_quantity")?,
        filled_quantity: a.opt_u64("filled_quantity")?,
        remaining_quantity: a.opt_u64("remaining_quantity")?,
        reason: CancelReason::from(a.str("reason")?),
    })
}

fn order_amended(a: &Attrs<'_>) -> Option<OrderAmended> {
    Some(OrderAmended {
        order_id: a.u64("order_id")?,
        market: a.market("market")?,
        side: a.side("side")?,
        client_order_id: a.client_order_id("client_order_id")?,
        old_price: a.u64("old_price")?,
        new_price: a.u64("new_price")?,
        old_quantity: a.u64("old_quantity")?,
        new_quantity: a.u64("new_quantity")?,
        filled_quantity: a.opt_u64("filled_quantity")?,
        remaining_quantity: a.opt_u64("remaining_quantity")?,
        queue_priority_reset: a.opt_bool("queue_priority_reset")?,
    })
}

fn order_rejected(a: &Attrs<'_>) -> Option<OrderRejected> {
    let code: u32 = a.parse("code")?;
    Some(OrderRejected {
        market: a.market("market")?,
        client_order_id: a.client_order_id("client_order_id")?,
        error: EngineError::new(code, None),
    })
}

fn market_order_processed(a: &Attrs<'_>) -> Option<MarketOrderProcessed> {
    Some(MarketOrderProcessed {
        order_id: a.u64("order_id")?,
        market: a.market("market")?,
        side: a.side("side")?,
        requested_quantity: a.u64("requested_quantity")?,
        filled_quantity: a.opt_u64("filled_quantity")?,
        client_order_id: a.client_order_id("client_order_id")?,
        unfilled_reason: a.text("unfilled_reason"),
    })
}

fn position_updated(a: &Attrs<'_>) -> Option<PositionUpdated> {
    Some(PositionUpdated {
        market: a.market("market")?,
        side: a.side("side")?,
        size: a.u64("size")?,
        entry_price: a.u64("entry_price")?,
        realized_pnl: a.opt_i64("realized_pnl")?,
    })
}

fn position_closed(a: &Attrs<'_>) -> Option<PositionClosed> {
    Some(PositionClosed {
        market: a.market("market")?,
        realized_pnl: a.opt_i64("realized_pnl")?,
    })
}

fn funding_settled(a: &Attrs<'_>) -> Option<FundingSettled> {
    Some(FundingSettled {
        market: a.market("market")?,
        payment: a.parse("payment")?,
    })
}

fn deposited(a: &Attrs<'_>) -> Option<Deposited> {
    Some(Deposited {
        amount: a.u64("amount")?,
        new_balance: a.u64("new_balance")?,
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::panic)]
    use super::*;
    use serde_json::{json, Value};

    fn kind_of(kind: &str, payload: &Value) -> Event {
        Event::from(raw_from_json(kind, payload))
    }

    fn is_malformed(e: &Event) -> bool {
        matches!(e, Event::Malformed(_))
    }

    // Payloads below are verbatim from devnet `/v1/history/account-events`
    // (2026-11-10), which serves the same attributes receipts and the feed carry.

    const MAKER: &str = "bdae2ddf5bde1e6a5be62bcd9e008106fca6dfd9";
    const TAKER: &str = "4f19b63a2067a0164c658858b981312aedb00c77";

    #[test]
    fn a_fill_decodes_both_sides() {
        let p = json!({"block_height": "10878715", "event_key": "10878715:4:0", "event_ordinal": "0", "execution_ordinal": "4", "fill_id": "376233", "maker_client_order_id": "1794152258902228", "maker_fee": "172", "maker_order_id": "3211366", "maker_owner": MAKER, "maker_side": "sell", "mark_price": "85678332", "market": "105", "oracle_price": "", "price": "85700000", "quantity": "1", "reason": "order", "taker_client_order_id": "0", "taker_fee": "429", "taker_order_id": "3211403", "taker_owner": TAKER});
        let Event::Fill(f) = kind_of("trade_executed", &p) else {
            panic!()
        };
        let (maker, taker): (Address, Address) = (MAKER.parse().unwrap(), TAKER.parse().unwrap());
        assert_eq!((f.market, f.price, f.quantity), (105, 85_700_000, 1));
        assert_eq!((f.maker_owner, f.maker_side), (maker, Side::Sell));
        assert_eq!((f.taker_owner, f.taker_side()), (taker, Side::Buy));
        assert_eq!((f.taker_fee, f.maker_order_id), (429, 3_211_366));
        assert_eq!(f.maker_client_order_id, Some(1_794_152_258_902_228));
        assert_eq!(f.taker_client_order_id, None, "\"0\" is the engine's none");
    }

    #[test]
    fn order_lifecycle() {
        let placed = json!({"client_order_id": "1794152258902232", "market": "1", "order_id": "3211393", "owner": MAKER, "post_only": "true", "price": "74587000000", "quantity": "260", "reduce_only": "false", "side": "sell", "time_in_force": "gtc"});
        let Event::OrderPlaced(o) = kind_of("order_placed", &placed) else {
            panic!()
        };
        assert!(o.post_only && !o.reduce_only);
        assert_eq!((o.side, o.time_in_force), (Side::Sell, TimeInForce::Gtc));

        let cancelled = json!({"client_order_id": "1794152258902229", "filled_quantity": "1", "market": "1", "order_id": "3211376", "original_quantity": "260", "owner": MAKER, "reason": "user_requested", "remaining_quantity": "259"});
        let Event::OrderCancelled(c) = kind_of("order_cancelled", &cancelled) else {
            panic!()
        };
        assert_eq!(
            (c.remaining_quantity, &c.reason),
            (259, &CancelReason::UserRequested)
        );

        let amended = json!({"client_order_id": "1794152258902198", "filled_quantity": "0", "market": "1", "new_price": "74660000000", "new_quantity": "182", "old_price": "74693000000", "old_quantity": "182", "order_id": "3211222", "owner": MAKER, "queue_priority_reset": "true", "remaining_quantity": "182", "side": "sell"});
        let Event::OrderAmended(m) = kind_of("order_amended", &amended) else {
            panic!()
        };
        assert!(m.queue_priority_reset);
        assert_eq!(m.new_price, 74_660_000_000);

        let rejected =
            json!({"client_order_id": "", "code": "51", "market": "104", "owner": TAKER});
        assert_eq!(
            kind_of("order_rejected", &rejected),
            Event::OrderRejected(OrderRejected {
                market: 104,
                client_order_id: None,
                error: EngineError::new(51, None),
            })
        );

        let market = json!({"client_order_id": "0", "filled_quantity": "1", "limit_price": "", "market": "1", "order_id": "3211411", "owner": TAKER, "requested_quantity": "1", "side": "sell", "time_in_force": "ioc", "unfilled_reason": ""});
        let Event::MarketOrderProcessed(mo) = kind_of("market_order_processed", &market) else {
            panic!()
        };
        assert_eq!(mo.unfilled_reason, None);
    }

    #[test]
    fn positions_funding_deposits() {
        let up = json!({"entry_price": "86197870", "market": "105", "owner": MAKER, "realized_pnl": "0", "side": "sell", "size": "41"});
        assert!(matches!(
            kind_of("position_updated", &up),
            Event::PositionUpdated(PositionUpdated {
                size: 41,
                side: Side::Sell,
                ..
            })
        ));
        let closed = json!({"market": "104", "owner": MAKER, "realized_pnl": "6300"});
        assert!(matches!(
            kind_of("position_closed", &closed),
            Event::PositionClosed(PositionClosed {
                realized_pnl: 6300,
                ..
            })
        ));
        let funding =
            json!({"market": "3", "owner": TAKER, "payment": "-144817", "phase": "system"});
        assert!(matches!(
            kind_of("funding_settled", &funding),
            Event::FundingSettled(FundingSettled {
                payment: -144_817,
                ..
            })
        ));
        let dep = json!({"amount": "10000000000", "new_balance": "10000000000", "owner": MAKER, "signer": TAKER});
        assert!(matches!(
            kind_of("deposited", &dep),
            Event::Deposited(Deposited {
                amount: 10_000_000_000,
                ..
            })
        ));
    }

    #[test]
    fn unknown_kinds_are_other_and_bad_known_kinds_are_malformed() {
        let fees = json!({"maker_fee": "172", "maker_owner": MAKER, "market": "105", "taker_fee": "429", "taker_owner": TAKER});
        let Event::Other(raw) = kind_of("fees_collected", &fees) else {
            panic!()
        };
        assert_eq!(
            (raw.kind.as_str(), raw.attributes.len()),
            ("fees_collected", 5)
        );
        assert!(is_malformed(&kind_of(
            "trade_executed",
            &json!({"price": "x"})
        )));
        assert!(is_malformed(&kind_of("order_placed", &Value::Null)));
        // An optional attribute may be absent, but one that is there must parse.
        let fill = json!({"fill_id": "1", "market": "1", "price": "10", "quantity": "1", "maker_owner": MAKER, "taker_owner": TAKER, "maker_side": "buy", "maker_order_id": "2", "taker_order_id": "3", "taker_fee": "1.5"});
        assert!(is_malformed(&kind_of("trade_executed", &fill)));
    }
}
