#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use super::*;
use crate::types::{ClientTriggerId, TriggerSlippageBps};

const OWNER: [u8; 20] = [7; 20];

fn limb(trigger_price: u64) -> TriggerLimb {
    TriggerLimb {
        trigger_price,
        max_slippage_bps: TriggerSlippageBps(150),
        client_trigger_id: Some(ClientTriggerId(9)),
    }
}

fn no_order(side: Side, price: u64) -> NoOrder {
    NoOrder {
        market: 70_000,
        owner: OWNER,
        side,
        price,
        quantity: 25,
        client_order_id: Some(11),
        post_only: true,
        reduce_only: true,
        time_in_force: TimeInForce::Ioc,
        stop_loss: None,
        take_profit: None,
    }
}

#[test]
fn buying_no_sells_yes_at_the_mirrored_price() {
    let yes = yes_order(&no_order(Side::Buy, 400_000)).unwrap();
    assert_eq!(yes.market, 70_000);
    assert_eq!(yes.side, Side::Sell);
    assert_eq!(yes.price, 600_000);
    assert_eq!(yes.quantity, 25);
    assert_eq!(yes.owner, OWNER);
    assert_eq!(yes.client_order_id, Some(11));
    assert!(yes.post_only && yes.reduce_only);
    assert_eq!(yes.time_in_force, TimeInForce::Ioc);
}

#[test]
fn selling_no_buys_yes_and_keeps_reduce_only() {
    let yes = yes_order(&no_order(Side::Sell, 300_000)).unwrap();
    assert_eq!(
        (yes.side, yes.price, yes.reduce_only),
        (Side::Buy, 700_000, true)
    );
}

#[test]
fn a_no_price_without_a_mirror_is_refused() {
    for price in [0, BINARY_PRICE_MAX, BINARY_PRICE_MAX + 1] {
        assert_eq!(
            yes_order(&no_order(Side::Buy, price)).unwrap_err(),
            BinaryError::OrderPriceOutOfRange { price }
        );
    }
    assert_eq!(yes_order(&no_order(Side::Buy, 1)).unwrap().price, 999_999);
    assert_eq!(yes_order(&no_order(Side::Buy, 999_999)).unwrap().price, 1);
}

#[test]
fn no_limbs_keep_their_role_at_the_mirrored_trigger() {
    // A long No at 0.50 with a stop at No 0.30 and a take-profit at No 0.80
    // is a short Yes at 0.50 with a stop at Yes 0.70 and a take-profit at
    // Yes 0.20: the stop fires as Yes rises, the take-profit as it falls.
    let mut no = no_order(Side::Buy, 500_000);
    no.stop_loss = Some(limb(300_000));
    no.take_profit = Some(limb(800_000));
    let yes = yes_order(&no).unwrap();
    assert_eq!(yes.stop_loss, Some(limb(700_000)));
    assert_eq!(yes.take_profit, Some(limb(200_000)));
}

#[test]
fn a_limb_without_a_mirror_refuses_the_order() {
    let mut no = no_order(Side::Buy, 500_000);
    no.stop_loss = Some(limb(BINARY_PRICE_MAX));
    assert_eq!(
        yes_order(&no).unwrap_err(),
        BinaryError::TriggerPriceOutOfRange {
            price: BINARY_PRICE_MAX
        }
    );
}

#[test]
fn a_short_yes_reads_as_no_and_a_long_yes_as_yes() {
    assert_eq!(
        binary_position_view(Side::Sell, 600_000, 40).unwrap(),
        BinaryPositionView {
            outcome: Outcome::No,
            entry_price: 400_000,
            size: 40
        }
    );
    assert_eq!(
        binary_position_view(Side::Buy, 600_000, 40).unwrap(),
        BinaryPositionView {
            outcome: Outcome::Yes,
            entry_price: 600_000,
            size: 40
        }
    );
    // A No-branch conditional close issues a short Yes at $1: No at 0.
    assert_eq!(
        binary_position_view(Side::Sell, BINARY_PRICE_MAX, 5)
            .unwrap()
            .entry_price,
        0
    );
    assert_eq!(
        binary_position_view(Side::Sell, BINARY_PRICE_MAX + 1, 5),
        Err(BinaryError::EntryAboveOneDollar {
            entry_price: BINARY_PRICE_MAX + 1
        })
    );
}
