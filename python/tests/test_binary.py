"""No orders, No limbs and the No position view on an event's one book."""

from __future__ import annotations

import pytest

import proof_trading_sdk as pts
from proof_trading_sdk import _native
from proof_trading_sdk.actions import Side, TimeInForce, TriggerLimb

OWNER = bytes([7] * 20)


def _limb(price: int, client_trigger_id: int = 9) -> TriggerLimb:
    return TriggerLimb(
        trigger_price=price, max_slippage_bps=150, client_trigger_id=client_trigger_id
    )


def test_buy_no_sells_yes_at_the_mirrored_price_and_carries_flags():
    order = pts.buy_no(
        market=70_000,
        owner=OWNER,
        price=400_000,
        quantity=25,
        client_order_id=11,
        post_only=True,
        reduce_only=True,
        time_in_force=TimeInForce.Ioc,
    )
    assert (order.market, order.side, order.price, order.quantity) == (
        70_000,
        Side.Sell,
        600_000,
        25,
    )
    assert (order.client_order_id, order.post_only, order.reduce_only) == (11, True, True)
    assert order.time_in_force == TimeInForce.Ioc
    # It is an ordinary PlaceOrder: the core encodes it.
    assert _native.encode_action(order.action_type, order.fields())


def test_sell_no_with_reduce_only_is_a_reduce_only_yes_buy():
    order = pts.sell_no(
        market=70_000, owner=OWNER, price=300_000, quantity=5, reduce_only=True
    )
    assert (order.side, order.price, order.reduce_only) == (Side.Buy, 700_000, True)


@pytest.mark.parametrize("price", [0, pts.BINARY_PRICE_MAX, pts.BINARY_PRICE_MAX + 1])
def test_a_no_price_without_a_mirror_is_refused(price):
    with pytest.raises(pts.BinaryPriceError) as raised:
        pts.buy_no(market=70_000, owner=OWNER, price=price, quantity=1)
    assert raised.value.reason == "OrderPriceOutOfRange"


@pytest.mark.parametrize(
    ("side", "stop", "take", "yes_stop", "yes_take"),
    [
        # Long No = short Yes: stop at No <= 0.30 is a stop at Yes >= 0.70.
        (Side.Buy, 300_000, 800_000, 700_000, 200_000),
        # Short No = long Yes: stop at No >= 0.70 is a stop at Yes <= 0.30.
        (Side.Sell, 700_000, 200_000, 300_000, 800_000),
    ],
)
def test_no_limbs_keep_their_role_at_the_mirrored_trigger(side, stop, take, yes_stop, yes_take):
    order = pts.no_order(
        side=side,
        market=70_000,
        owner=OWNER,
        price=500_000,
        quantity=1,
        stop_loss=_limb(stop, 11),
        take_profit=_limb(take, 12),
    )
    assert order.stop_loss == _limb(yes_stop, 11)
    assert order.take_profit == _limb(yes_take, 12)


def test_a_limb_without_a_mirror_is_refused():
    with pytest.raises(pts.BinaryPriceError, match="trigger price"):
        pts.buy_no(
            market=70_000,
            owner=OWNER,
            price=500_000,
            quantity=1,
            stop_loss=_limb(pts.BINARY_PRICE_MAX),
        )


def test_a_short_yes_reads_as_no_and_a_long_yes_as_yes():
    assert pts.binary_position_view("Sell", 600_000, 40) == pts.BinaryPositionView(
        "No", 400_000, 40
    )
    assert pts.binary_position_view("Buy", 600_000, 40) == pts.BinaryPositionView(
        "Yes", 600_000, 40
    )
    assert pts.binary_position_view("Sell", pts.BINARY_PRICE_MAX, 5).entry_price == 0
    with pytest.raises(pts.BinaryPriceError):
        pts.binary_position_view("Sell", pts.BINARY_PRICE_MAX + 1, 5)
