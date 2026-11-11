//! An event's one binary book, read and traded in No terms.
//!
//! Each event has a single binary book priced in Yes. A long No at price `q`
//! is the same position as a short Yes at `$1 − q`: both lose `q` if the
//! event resolves Yes and gain `$1 − q` if it resolves No. So buying No at
//! `q` is selling Yes at `$1 − q`, selling No at `q` is buying Yes at
//! `$1 − q`, and a No stop or take-profit at `x` is the same limb on the Yes
//! position at `$1 − x`. The engine has no No book; these helpers do the
//! translation on the client.
//!
//! A limb keeps its role (stop-loss stays stop-loss): a stop on a long No
//! fires when No falls to `x`, which is when Yes rises to `$1 − x` — the
//! condition a stop on the mirrored short Yes already uses. Its
//! `max_slippage_bps` is carried unchanged; it is measured against the Yes
//! trigger price.

use std::fmt;

use crate::types::{PlaceOrder, Side, TimeInForce, TriggerLimb, BINARY_PRICE_MAX};

/// A price that has no mirror inside the book.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BinaryError {
    /// A No order price outside `(0, $1)`. `$1` would mirror to a Yes price
    /// of 0, which the engine refuses; 0 is not a price.
    OrderPriceOutOfRange { price: u64 },
    /// A No trigger price outside `(0, $1)`; a limb's trigger price must be
    /// non-zero on both sides of the mirror.
    TriggerPriceOutOfRange { price: u64 },
    /// A position entry above `$1`, which no binary position can carry.
    EntryAboveOneDollar { entry_price: u64 },
}

impl fmt::Display for BinaryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::OrderPriceOutOfRange { price } => write!(
                f,
                "No order price {price} must be above 0 and below {BINARY_PRICE_MAX} (a No price of $1 is a Yes price of 0)"
            ),
            Self::TriggerPriceOutOfRange { price } => write!(
                f,
                "No trigger price {price} must be above 0 and below {BINARY_PRICE_MAX}"
            ),
            Self::EntryAboveOneDollar { entry_price } => write!(
                f,
                "binary entry price {entry_price} is above {BINARY_PRICE_MAX}"
            ),
        }
    }
}

impl std::error::Error for BinaryError {}

/// The Yes price that mirrors a No price strictly inside `(0, $1)`.
fn mirror(no_price: u64) -> Option<u64> {
    if no_price == 0 {
        return None;
    }
    BINARY_PRICE_MAX
        .checked_sub(no_price)
        .filter(|&yes_price| yes_price > 0)
}

/// The Yes order side that trades `no_side` of No.
pub fn yes_side(no_side: Side) -> Side {
    match no_side {
        Side::Buy => Side::Sell,
        Side::Sell => Side::Buy,
    }
}

/// The Yes limb equivalent to a No limb: same role and collar, mirrored
/// trigger price.
pub fn yes_limb(no_limb: &TriggerLimb) -> Result<TriggerLimb, BinaryError> {
    let trigger_price =
        mirror(no_limb.trigger_price).ok_or(BinaryError::TriggerPriceOutOfRange {
            price: no_limb.trigger_price,
        })?;
    Ok(TriggerLimb {
        trigger_price,
        ..no_limb.clone()
    })
}

/// A limit order on an event's binary book, stated in No terms.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NoOrder {
    /// The event's binary book (`EventInfo::eby_market`).
    pub market: u32,
    pub owner: [u8; 20],
    /// Buy or sell No.
    pub side: Side,
    /// No price in micro-USDC, strictly inside `(0, $1)`.
    pub price: u64,
    pub quantity: u64,
    pub client_order_id: Option<u64>,
    pub post_only: bool,
    pub reduce_only: bool,
    pub time_in_force: TimeInForce,
    /// Stop-loss on the resulting No position, at a No price.
    pub stop_loss: Option<TriggerLimb>,
    /// Take-profit on the resulting No position, at a No price.
    pub take_profit: Option<TriggerLimb>,
}

/// The Yes order the engine executes for a No order.
pub fn yes_order(no: &NoOrder) -> Result<PlaceOrder, BinaryError> {
    let price = mirror(no.price).ok_or(BinaryError::OrderPriceOutOfRange { price: no.price })?;
    Ok(PlaceOrder {
        market: no.market,
        owner: no.owner,
        side: yes_side(no.side),
        price,
        quantity: no.quantity,
        client_order_id: no.client_order_id,
        post_only: no.post_only,
        reduce_only: no.reduce_only,
        time_in_force: no.time_in_force,
        stop_loss: no.stop_loss.as_ref().map(yes_limb).transpose()?,
        take_profit: no.take_profit.as_ref().map(yes_limb).transpose()?,
    })
}

/// Which outcome a binary position pays on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Yes,
    No,
}

/// A binary position read the way a trader holds it: a long Yes as Yes, a
/// short Yes as No at the mirrored entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BinaryPositionView {
    pub outcome: Outcome,
    /// Entry price in the outcome's own terms, in micro-USDC.
    pub entry_price: u64,
    pub size: u64,
}

/// Read a position on an event's binary book. The entry may be exactly `$1`
/// (a conditional close issues a No-branch result at `$1`), which reads as
/// No at 0.
pub fn binary_position_view(
    side: Side,
    entry_price: u64,
    size: u64,
) -> Result<BinaryPositionView, BinaryError> {
    let mirrored = BINARY_PRICE_MAX
        .checked_sub(entry_price)
        .ok_or(BinaryError::EntryAboveOneDollar { entry_price })?;
    Ok(match side {
        Side::Buy => BinaryPositionView {
            outcome: Outcome::Yes,
            entry_price,
            size,
        },
        Side::Sell => BinaryPositionView {
            outcome: Outcome::No,
            entry_price: mirrored,
            size,
        },
    })
}

#[cfg(test)]
mod tests;
