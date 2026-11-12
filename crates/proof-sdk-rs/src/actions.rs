//! Trading actions as plain values, for callers that sign and send them
//! themselves ([`crate::ExchangeClient::sign`] then
//! [`crate::ExchangeClient::send`]), batch them, or trade for another owner.
//!
//! Nothing here does I/O. The [`crate::ExchangeClient`] order helpers are these
//! functions with the client's own address, submitted at once.

use proof_trading_sdk::types::{
    Action, AmendOrder, CancelAllOrders, CancelClientOrder, CancelOrder, CancelReplaceOrder,
    ClosePosition, MarketId, MarketOrder, OrderId, PlaceOrder, Side,
};

use crate::address::Address;

/// A GTC limit order. Adjust the fields (`post_only`, `client_order_id`,
/// `time_in_force`, brackets) before wrapping it in [`Action::PlaceOrder`].
#[must_use]
pub fn limit_order(
    owner: Address,
    market: MarketId,
    side: Side,
    price: u64,
    quantity: u64,
) -> PlaceOrder {
    PlaceOrder {
        market,
        owner: owner.to_bytes(),
        side,
        price,
        quantity,
        ..PlaceOrder::default()
    }
}

/// Immediate-or-cancel at the best available prices. Set `client_order_id` or
/// brackets before wrapping it in [`Action::MarketOrder`].
#[must_use]
pub fn market_order(owner: Address, market: MarketId, side: Side, quantity: u64) -> MarketOrder {
    MarketOrder {
        market,
        owner: owner.to_bytes(),
        side,
        quantity,
        client_order_id: None,
        stop_loss: None,
        take_profit: None,
    }
}

/// `CancelOrder` by exchange order id.
#[must_use]
pub fn cancel_order(owner: Address, order_id: OrderId) -> Action {
    Action::CancelOrder(CancelOrder {
        order_id,
        owner: owner.to_bytes(),
    })
}

/// `CancelClientOrder` by client order id.
#[must_use]
pub fn cancel_order_by_client_id(owner: Address, client_order_id: u64) -> Action {
    Action::CancelClientOrder(CancelClientOrder {
        owner: owner.to_bytes(),
        client_order_id,
    })
}

/// `CancelAllOrders`: every resting order, or only those on `market`.
#[must_use]
pub fn cancel_all_orders(owner: Address, market: Option<MarketId>) -> Action {
    Action::CancelAllOrders(CancelAllOrders {
        owner: owner.to_bytes(),
        market,
    })
}

/// `AmendOrder`: a new price and/or total quantity, in place. A same-price
/// size cut keeps queue priority.
#[must_use]
pub fn amend_order(
    owner: Address,
    order_id: OrderId,
    new_price: Option<u64>,
    new_quantity: Option<u64>,
) -> Action {
    Action::AmendOrder(AmendOrder {
        owner: owner.to_bytes(),
        order_id,
        new_price,
        new_quantity,
    })
}

/// `CancelReplaceOrder`: cancel exchange order `order_id` and place `order`
/// atomically, as `order.owner`. Every field of `order` carries over,
/// brackets included.
#[must_use]
pub fn cancel_replace_order(order_id: OrderId, order: PlaceOrder) -> Action {
    Action::CancelReplaceOrder(replace(Some(order_id), None, order))
}

/// [`cancel_replace_order`], naming the order to cancel by client order id.
#[must_use]
pub fn cancel_replace_order_by_client_id(client_order_id: u64, order: PlaceOrder) -> Action {
    Action::CancelReplaceOrder(replace(None, Some(client_order_id), order))
}

/// `ClosePosition`: flatten `owner`'s position on `market`.
#[must_use]
pub fn close_position(owner: Address, market: MarketId) -> Action {
    Action::ClosePosition(ClosePosition {
        market,
        owner: owner.to_bytes(),
    })
}

fn replace(
    cancel_order_id: Option<OrderId>,
    cancel_client_order_id: Option<u64>,
    o: PlaceOrder,
) -> CancelReplaceOrder {
    // Destructured so a field added to `PlaceOrder` fails to compile here
    // instead of being dropped from the replacement.
    let PlaceOrder {
        market,
        owner,
        side,
        price,
        quantity,
        client_order_id,
        post_only,
        reduce_only,
        time_in_force,
        stop_loss,
        take_profit,
    } = o;
    CancelReplaceOrder {
        owner,
        cancel_order_id,
        cancel_client_order_id,
        market,
        side,
        price,
        quantity,
        client_order_id,
        post_only,
        reduce_only,
        time_in_force,
        stop_loss,
        take_profit,
    }
}
