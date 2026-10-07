"""An event's one binary book, traded and read in No terms.

Each event has a single binary book priced in Yes. A long No at price ``q``
is the same position as a short Yes at ``$1 - q``, so buying No at ``q`` is
selling Yes at ``$1 - q``, selling No at ``q`` is buying Yes at ``$1 - q``,
and a No stop or take-profit at ``x`` is the same limb on the Yes position at
``$1 - x``. The engine has no No book; these helpers translate on the client.
The Rust core (``binary.rs``) is the reference, pinned for every binding by
``conformance/binary.ndjson``.

A limb keeps its role (a stop-loss stays a stop-loss) and its
``max_slippage_bps``, which applies to the Yes trigger price.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass
from typing import Literal, Optional

from proof_trading_sdk.actions import PlaceOrder, Side, TimeInForce, TriggerLimb

#: ``$1`` in micro-USDC: a binary pays this on its winning outcome.
BINARY_PRICE_MAX = 1_000_000

BinaryErrorName = Literal[
    "OrderPriceOutOfRange", "TriggerPriceOutOfRange", "EntryAboveOneDollar"
]


class BinaryPriceError(ValueError):
    """A No price, trigger or entry with no mirror inside the book."""

    def __init__(self, reason: BinaryErrorName, price: int) -> None:
        self.reason = reason
        self.price = price
        if reason == "EntryAboveOneDollar":
            message = f"binary entry price {price} is above {BINARY_PRICE_MAX}"
        elif reason == "OrderPriceOutOfRange":
            message = (
                f"No order price {price} must be above 0 and below "
                f"{BINARY_PRICE_MAX} (a No price of $1 is a Yes price of 0)"
            )
        else:
            message = (
                f"No trigger price {price} must be above 0 and below {BINARY_PRICE_MAX}"
            )
        super().__init__(message)


def _mirror(price: int, reason: BinaryErrorName) -> int:
    if price <= 0 or price >= BINARY_PRICE_MAX:
        raise BinaryPriceError(reason, price)
    return BINARY_PRICE_MAX - price


def _side(side: str) -> Side:
    """``side`` as a wire side; anything but ``"Buy"`` or ``"Sell"`` is refused,
    so a mistyped side can never turn into the opposite trade."""
    try:
        return Side(side)
    except ValueError:
        raise ValueError(f"side must be 'Buy' or 'Sell', got {side!r}") from None


def yes_side(no_side: str) -> Side:
    """The Yes order side that trades ``no_side`` of No."""
    return Side.Sell if _side(no_side) == Side.Buy else Side.Buy


def yes_limb(no_limb: TriggerLimb) -> TriggerLimb:
    """The Yes limb equivalent to a No limb: same role and collar, mirrored
    trigger price."""
    return dataclasses.replace(
        no_limb,
        trigger_price=_mirror(no_limb.trigger_price, "TriggerPriceOutOfRange"),
    )


def no_order(
    *,
    side: str,
    market: int,
    owner: bytes,
    price: int,
    quantity: int,
    client_order_id: Optional[int] = None,
    post_only: bool = False,
    reduce_only: bool = False,
    time_in_force: str = TimeInForce.Gtc,
    stop_loss: Optional[TriggerLimb] = None,
    take_profit: Optional[TriggerLimb] = None,
) -> PlaceOrder:
    """The Yes :class:`PlaceOrder` the engine executes for a No order.

    ``side`` buys or sells No; ``price`` and limb trigger prices are No
    prices; ``market`` is the event's binary book (``eby_market``). Flags
    carry over unchanged. Raises :class:`BinaryPriceError` for a price with no
    Yes mirror (0 or ``$1``).
    """
    return PlaceOrder(
        market=market,
        owner=owner,
        side=yes_side(side),
        price=_mirror(price, "OrderPriceOutOfRange"),
        quantity=quantity,
        client_order_id=client_order_id,
        post_only=post_only,
        reduce_only=reduce_only,
        time_in_force=time_in_force,
        stop_loss=yes_limb(stop_loss) if stop_loss else None,
        take_profit=yes_limb(take_profit) if take_profit else None,
    )


def buy_no(
    *,
    market: int,
    owner: bytes,
    price: int,
    quantity: int,
    client_order_id: Optional[int] = None,
    post_only: bool = False,
    reduce_only: bool = False,
    time_in_force: str = TimeInForce.Gtc,
    stop_loss: Optional[TriggerLimb] = None,
    take_profit: Optional[TriggerLimb] = None,
) -> PlaceOrder:
    """Buy No: the Yes sell at ``$1 - price``. See :func:`no_order`."""
    return no_order(
        side=Side.Buy,
        market=market,
        owner=owner,
        price=price,
        quantity=quantity,
        client_order_id=client_order_id,
        post_only=post_only,
        reduce_only=reduce_only,
        time_in_force=time_in_force,
        stop_loss=stop_loss,
        take_profit=take_profit,
    )


def sell_no(
    *,
    market: int,
    owner: bytes,
    price: int,
    quantity: int,
    client_order_id: Optional[int] = None,
    post_only: bool = False,
    reduce_only: bool = False,
    time_in_force: str = TimeInForce.Gtc,
    stop_loss: Optional[TriggerLimb] = None,
    take_profit: Optional[TriggerLimb] = None,
) -> PlaceOrder:
    """Sell No: the Yes buy at ``$1 - price``. Selling No that an account
    holds is a reduce-only Yes buy: pass ``reduce_only=True`` to close without
    flipping. See :func:`no_order`."""
    return no_order(
        side=Side.Sell,
        market=market,
        owner=owner,
        price=price,
        quantity=quantity,
        client_order_id=client_order_id,
        post_only=post_only,
        reduce_only=reduce_only,
        time_in_force=time_in_force,
        stop_loss=stop_loss,
        take_profit=take_profit,
    )


@dataclass(frozen=True)
class BinaryPositionView:
    """A binary position read the way a trader holds it."""

    outcome: Literal["Yes", "No"]
    #: Entry price in the outcome's own terms, in micro-USDC.
    entry_price: int
    size: int


def binary_position_view(side: str, entry_price: int, size: int) -> BinaryPositionView:
    """Read a position on an event's binary book: a long Yes as Yes, a short
    Yes as No at ``$1 - entry``. An entry of exactly ``$1`` (a No-branch
    conditional close is issued there) reads as No at 0."""
    if entry_price > BINARY_PRICE_MAX:
        raise BinaryPriceError("EntryAboveOneDollar", entry_price)
    if _side(side) == Side.Buy:
        return BinaryPositionView("Yes", entry_price, size)
    return BinaryPositionView("No", BINARY_PRICE_MAX - entry_price, size)
