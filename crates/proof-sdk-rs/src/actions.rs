//! Trading actions as plain values, for callers that sign and send them
//! themselves ([`crate::ExchangeClient::sign`] then
//! [`crate::ExchangeClient::send`]), batch them, or trade for another owner.
//!
//! Nothing here does I/O. The [`crate::ExchangeClient`] order helpers are these
//! functions with the client's own address, submitted at once.

use proof_trading_sdk::binary::{self, NoOrder};
use proof_trading_sdk::types::{
    Action, AmendOrder, ApproveAgent, AtomicBasketLeg, AtomicBasketOrder, CancelAllOrders,
    CancelClientOrder, CancelOrder, CancelPositionTriggers, CancelReplaceOrder,
    ClientTriggerGroupId, ClosePosition, CreateSubAccount, MarketConfig, MarketId, MarketKind,
    MarketOrder, OrderId, OwnerAddress, PlaceOrder, PositionEpoch, RevokeAgent,
    SetPositionTriggers, Side, SubAccountTransfer, TimeInForce, TriggerLimb, WithdrawRequest,
};

use crate::address::Address;
use crate::error::{Error, Result};
use crate::ids::SubAccountId;

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

/// Buy No at `price` on an event's binary book (`EventInfo::eby_market`):
/// a Yes sell at `$1 - price`. Adjust `post_only`, `client_order_id` or
/// `reduce_only` before wrapping it in [`Action::PlaceOrder`]; brackets on
/// the result are in Yes terms (see [`proof_trading_sdk::binary::yes_limb`]).
///
/// Takes the market's config, not its id: a No order on any other kind of
/// market would sign a real trade at the mirrored price.
///
/// # Errors
///
/// [`Error::InvalidInput`] when `market` is not a prediction-binary book, or
/// for a price of 0 or `$1` or more, which has no Yes mirror inside the book.
pub fn buy_no(
    owner: Address,
    market: &MarketConfig,
    price: u64,
    quantity: u64,
) -> Result<PlaceOrder> {
    no_order(owner, market, Side::Buy, price, quantity)
}

/// Sell No at `price` on an event's binary book: a Yes buy at `$1 - price`.
/// Selling No you hold is a reduce-only Yes buy; set `reduce_only` to close
/// without flipping.
///
/// # Errors
///
/// As [`buy_no`].
pub fn sell_no(
    owner: Address,
    market: &MarketConfig,
    price: u64,
    quantity: u64,
) -> Result<PlaceOrder> {
    no_order(owner, market, Side::Sell, price, quantity)
}

fn no_order(
    owner: Address,
    market: &MarketConfig,
    side: Side,
    price: u64,
    quantity: u64,
) -> Result<PlaceOrder> {
    if !matches!(market.kind, MarketKind::PredictionBinary { .. }) {
        return Err(Error::InvalidInput(format!(
            "market {} is not a prediction-binary book",
            market.market
        )));
    }
    binary::yes_order(&NoOrder {
        market: market.market,
        owner: owner.to_bytes(),
        side,
        price,
        quantity,
        client_order_id: None,
        post_only: false,
        reduce_only: false,
        time_in_force: TimeInForce::Gtc,
        stop_loss: None,
        take_profit: None,
    })
    .map_err(|e| Error::InvalidInput(e.to_string()))
}

/// `SetPositionTriggers`: replace the stop-loss/take-profit bracket on
/// `owner`'s position generation `expected_position_epoch` (from
/// [`crate::InfoClient::position_triggers`] or the account).
#[must_use]
pub fn set_position_triggers(
    owner: Address,
    market: MarketId,
    expected_position_epoch: PositionEpoch,
    stop_loss: Option<TriggerLimb>,
    take_profit: Option<TriggerLimb>,
    client_group_id: Option<ClientTriggerGroupId>,
) -> Action {
    Action::SetPositionTriggers(SetPositionTriggers {
        market,
        owner: owner.to_bytes(),
        expected_position_epoch,
        stop_loss,
        take_profit,
        client_group_id,
    })
}

/// `CancelPositionTriggers`: drop the bracket on that position generation.
#[must_use]
pub fn cancel_position_triggers(
    owner: Address,
    market: MarketId,
    expected_position_epoch: PositionEpoch,
) -> Action {
    Action::CancelPositionTriggers(CancelPositionTriggers {
        market,
        owner: owner.to_bytes(),
        expected_position_epoch,
    })
}

/// `ApproveAgent`: let the key `agent_public_key` trade for `owner`. An
/// agent can place and cancel orders but cannot withdraw or move funds.
#[must_use]
pub fn approve_agent(owner: Address, agent_public_key: [u8; 32]) -> Action {
    Action::ApproveAgent(ApproveAgent {
        owner: owner.to_bytes(),
        agent_pubkey: agent_public_key,
    })
}

/// `RevokeAgent`: withdraw an approval.
#[must_use]
pub fn revoke_agent(owner: Address, agent_public_key: [u8; 32]) -> Action {
    Action::RevokeAgent(RevokeAgent {
        owner: owner.to_bytes(),
        agent_pubkey: agent_public_key,
    })
}

/// The address of `master`'s sub-account `sub_account_id`, as
/// `CreateSubAccount` derives it.
#[must_use]
pub fn sub_account_address(master: Address, sub_account_id: SubAccountId) -> Address {
    let derived = proof_trading_sdk::crypto::derive_sub_account(
        &OwnerAddress::new(master.to_bytes()),
        sub_account_id.get(),
    );
    Address::from(derived.into_bytes())
}

/// `CreateSubAccount`: a sub-account of `owner` at
/// [`sub_account_address`]`(owner, sub_account_id)`, labelled `name`.
///
/// # Errors
///
/// [`Error::InvalidInput`] for a name over 32 bytes of UTF-8, or one with a
/// NUL byte, which the zero padding would cut it at.
pub fn create_sub_account(
    owner: Address,
    sub_account_id: SubAccountId,
    name: &str,
) -> Result<Action> {
    if name.contains('\0') {
        return Err(Error::InvalidInput(format!(
            "sub-account name {name:?} contains a NUL byte"
        )));
    }
    let mut padded = [0u8; 32];
    padded
        .get_mut(..name.len())
        .ok_or_else(|| Error::InvalidInput(format!("sub-account name {name:?} is over 32 bytes")))?
        .copy_from_slice(name.as_bytes());
    Ok(Action::CreateSubAccount(CreateSubAccount {
        owner: OwnerAddress::new(owner.to_bytes()),
        sub_account_id: sub_account_id.get(),
        name: padded,
    }))
}

/// `SubAccountTransfer`: move `amount` micro-USDC between `owner` (the
/// master) and one of its sub-accounts, either way.
#[must_use]
pub fn sub_account_transfer(owner: Address, from: Address, to: Address, amount: u64) -> Action {
    Action::SubAccountTransfer(SubAccountTransfer {
        owner: OwnerAddress::new(owner.to_bytes()),
        from: OwnerAddress::new(from.to_bytes()),
        to: OwnerAddress::new(to.to_bytes()),
        amount,
    })
}

/// `WithdrawRequest`: withdraw `amount` micro-USDC to the Solana account
/// `solana_destination`. Track it with [`crate::InfoClient::withdrawal`].
#[must_use]
pub fn withdraw_request(owner: Address, amount: u64, solana_destination: [u8; 32]) -> Action {
    Action::WithdrawRequest(WithdrawRequest {
        owner: owner.to_bytes(),
        amount,
        solana_destination,
    })
}

/// One fill-or-kill leg of an [`atomic_basket_order`]: `price` is the worst
/// acceptable. Set `client_order_id` or `reduce_only` on it as needed.
#[must_use]
pub fn basket_leg(market: MarketId, side: Side, price: u64, quantity: u64) -> AtomicBasketLeg {
    AtomicBasketLeg {
        market,
        side,
        price,
        quantity,
        client_order_id: None,
        reduce_only: false,
    }
}

/// `AtomicBasketOrder`: every leg fills in full or none does.
/// `max_slippage_bps` bounds the basket's aggregate slippage; 0 disables it.
#[must_use]
pub fn atomic_basket_order(
    owner: Address,
    legs: Vec<AtomicBasketLeg>,
    max_slippage_bps: u32,
) -> Action {
    Action::AtomicBasketOrder(AtomicBasketOrder {
        owner: owner.to_bytes(),
        legs,
        max_slippage_bps,
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

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::panic)]
    use super::*;
    use proof_trading_sdk::types::{ClientTriggerId, TriggerSlippageBps, BINARY_PRICE_MAX};
    use proof_trading_sdk::{codec, crypto, sign_action, LocalSigner};

    const OWNER: Address = Address([0xa5; 20]);
    const OTHER: Address = Address([0x11; 20]);

    /// Encoded, signed and decoded as the engine reads it: the helper built
    /// a valid wire action, and it survives intact.
    fn on_the_wire(action: &Action) -> Action {
        let chain = crypto::chain_id_from_string("exchange-devnet-1");
        let bytes = sign_action(&LocalSigner::from_bytes(&[3; 32]), &chain, action, 1).unwrap();
        let decoded = codec::decode_tx(&bytes).unwrap().action;
        assert_eq!(format!("{decoded:?}"), format!("{action:?}"));
        decoded
    }

    #[test]
    fn no_orders_trade_the_yes_book_at_the_mirrored_price_and_side() {
        // (helper, No price, Yes side, Yes price)
        type Case = (
            fn(Address, &MarketConfig, u64, u64) -> Result<PlaceOrder>,
            u64,
            Side,
            u64,
        );
        let cases: [Case; 4] = [
            (buy_no, 300_000, Side::Sell, 700_000),
            (sell_no, 250_000, Side::Buy, 750_000),
            (buy_no, 1, Side::Sell, 999_999),
            (sell_no, 999_999, Side::Buy, 1),
        ];
        for (helper, no_price, side, yes_price) in cases {
            let o = helper(OWNER, &binary_book(3300), no_price, 7).unwrap();
            assert_eq!(
                (
                    o.market,
                    Address::from(o.owner),
                    o.side,
                    o.price,
                    o.quantity
                ),
                (3300, OWNER, side, yes_price, 7)
            );
            assert!(!o.post_only && !o.reduce_only && o.time_in_force == TimeInForce::Gtc);
            on_the_wire(&Action::PlaceOrder(o));
        }
    }

    fn binary_book(market: MarketId) -> MarketConfig {
        MarketConfig {
            market,
            kind: MarketKind::PredictionBinary {
                event_id: proof_trading_sdk::types::EventId(33),
                branch: proof_trading_sdk::types::Branch::Yes,
            },
            ..MarketConfig::default()
        }
    }

    #[test]
    fn no_orders_refuse_a_market_that_is_not_a_binary_book() {
        let perp = MarketConfig {
            market: 1,
            ..MarketConfig::default()
        };
        let conditional = MarketConfig {
            market: 3302,
            kind: MarketKind::ConditionalPerp {
                event_id: proof_trading_sdk::types::EventId(33),
                branch: proof_trading_sdk::types::Branch::Yes,
            },
            ..MarketConfig::default()
        };
        for market in [&perp, &conditional] {
            for helper in [buy_no, sell_no] {
                assert!(
                    matches!(
                        helper(OWNER, market, 300_000, 1),
                        Err(Error::InvalidInput(_))
                    ),
                    "market {}",
                    market.market
                );
            }
        }
    }

    #[test]
    fn no_orders_refuse_prices_without_a_yes_mirror() {
        for price in [0, BINARY_PRICE_MAX, BINARY_PRICE_MAX + 1, u64::MAX] {
            for helper in [buy_no, sell_no] {
                assert!(
                    matches!(
                        helper(OWNER, &binary_book(3300), price, 1),
                        Err(Error::InvalidInput(_))
                    ),
                    "{price}"
                );
            }
        }
    }

    #[test]
    fn trigger_helpers_build_the_bracket_for_the_named_epoch() {
        let limb = |price| TriggerLimb {
            trigger_price: price,
            max_slippage_bps: TriggerSlippageBps(75),
            client_trigger_id: Some(ClientTriggerId(11)),
        };
        let set = set_position_triggers(
            OWNER,
            1,
            PositionEpoch(3),
            Some(limb(60_000_000_000)),
            None,
            Some(ClientTriggerGroupId(9)),
        );
        let Action::SetPositionTriggers(t) = on_the_wire(&set) else {
            panic!("{set:?}")
        };
        assert_eq!(
            (t.market, t.owner, t.expected_position_epoch),
            (1, OWNER.to_bytes(), PositionEpoch(3))
        );
        assert_eq!(t.stop_loss, Some(limb(60_000_000_000)));
        assert_eq!(
            (t.take_profit, t.client_group_id),
            (None, Some(ClientTriggerGroupId(9)))
        );

        let Action::CancelPositionTriggers(c) =
            on_the_wire(&cancel_position_triggers(OWNER, 1, PositionEpoch(3)))
        else {
            panic!()
        };
        assert_eq!(
            (c.market, c.owner, c.expected_position_epoch),
            (1, OWNER.to_bytes(), PositionEpoch(3))
        );
    }

    #[test]
    fn agent_helpers_name_the_agent_key() {
        let Action::ApproveAgent(a) = on_the_wire(&approve_agent(OWNER, [7; 32])) else {
            panic!()
        };
        assert_eq!((a.owner, a.agent_pubkey), (OWNER.to_bytes(), [7; 32]));
        let Action::RevokeAgent(r) = on_the_wire(&revoke_agent(OWNER, [7; 32])) else {
            panic!()
        };
        assert_eq!((r.owner, r.agent_pubkey), (OWNER.to_bytes(), [7; 32]));
    }

    fn id(n: u32) -> SubAccountId {
        SubAccountId::new(n).expect("a nonzero test id")
    }

    #[test]
    fn create_sub_account_refuses_a_nul_in_the_name() {
        assert!(matches!(
            create_sub_account(OWNER, id(2), "gr\0id"),
            Err(Error::InvalidInput(_))
        ));
    }

    #[test]
    fn sub_account_helpers_pad_the_name_and_derive_the_address() {
        let Action::CreateSubAccount(c) =
            on_the_wire(&create_sub_account(OWNER, id(2), "grid").unwrap())
        else {
            panic!()
        };
        assert_eq!(
            (c.owner.into_bytes(), c.sub_account_id),
            (OWNER.to_bytes(), 2)
        );
        assert_eq!(&c.name[..4], b"grid");
        assert!(c.name[4..].iter().all(|&b| b == 0));
        assert!(create_sub_account(OWNER, id(2), &"x".repeat(32)).is_ok());
        assert!(matches!(
            create_sub_account(OWNER, id(2), &"x".repeat(33)),
            Err(Error::InvalidInput(_))
        ));

        let sub = sub_account_address(OWNER, id(2));
        assert_ne!(sub, sub_account_address(OWNER, id(3)));
        assert_ne!(sub, sub_account_address(OTHER, id(2)));
        let Action::SubAccountTransfer(t) =
            on_the_wire(&sub_account_transfer(OWNER, OWNER, sub, 1_000_000))
        else {
            panic!()
        };
        assert_eq!(
            (
                t.owner.into_bytes(),
                t.from.into_bytes(),
                t.to.into_bytes(),
                t.amount
            ),
            (
                OWNER.to_bytes(),
                OWNER.to_bytes(),
                sub.to_bytes(),
                1_000_000
            )
        );
    }

    #[test]
    fn withdraw_request_names_amount_and_destination() {
        let Action::WithdrawRequest(w) = on_the_wire(&withdraw_request(OWNER, 5_000_000, [9; 32]))
        else {
            panic!()
        };
        assert_eq!(
            (w.owner, w.amount, w.solana_destination),
            (OWNER.to_bytes(), 5_000_000, [9; 32])
        );
    }

    #[test]
    fn basket_carries_every_leg_and_the_slippage_budget() {
        let mut short = basket_leg(3303, Side::Sell, 75_000_000, 2);
        short.client_order_id = Some(8);
        let legs = vec![basket_leg(3302, Side::Buy, 80_000_000, 2), short];
        let Action::AtomicBasketOrder(b) = on_the_wire(&atomic_basket_order(OWNER, legs, 50))
        else {
            panic!()
        };
        assert_eq!(
            (b.owner, b.max_slippage_bps, b.legs.len()),
            (OWNER.to_bytes(), 50, 2)
        );
        let leg = &b.legs[1];
        assert_eq!(
            (
                leg.market,
                leg.side,
                leg.price,
                leg.quantity,
                leg.client_order_id,
                leg.reduce_only
            ),
            (3303, Side::Sell, 75_000_000, 2, Some(8), false)
        );
    }
}
