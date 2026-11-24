"""Per-order results of the batch actions, read from their order events.

``PlaceOrders`` emits one ``orders_placed`` (as does an ``AtomicBasketOrder``,
one result per leg) and ``CancelOrders`` / ``CancelClientOrders`` one
``orders_cancelled``. Each carries an ``orders`` attribute: a JSON array with
one object of string values per order, in the order sent.

An outcome is one of :class:`RestingOrder`, :class:`ExecutedOrder` or
:class:`RejectedOrder` (an :data:`OrderPlacement`), or one of
:class:`CancelledOrder` or :class:`RefusedCancel` (an
:data:`OrderCancellation`). Each carries its ``outcome`` tag, so a caller can
``match`` on the class or compare ``outcome``.
"""

from __future__ import annotations

import json
import typing as t
from dataclasses import dataclass, field
from typing import Optional

from proof_trading_sdk.actions import Side, TimeInForce
from proof_trading_sdk.errors import (
    CodecError,
    OrderResultUnreadable,
    get_error_name,
)

ORDERS_PLACED = "orders_placed"
ORDERS_CANCELLED = "orders_cancelled"

_SIDES = {"buy": Side.Buy, "sell": Side.Sell}
_TIME_IN_FORCE = {"gtc": TimeInForce.Gtc, "ioc": TimeInForce.Ioc, "fok": TimeInForce.Fok}


@dataclass(frozen=True)
class RestingOrder:
    """Accepted, with ``quantity`` left resting on the book."""

    market: int
    client_order_id: Optional[int]
    order_id: int
    side: Side
    price: int
    quantity: int
    time_in_force: TimeInForce
    post_only: bool
    reduce_only: bool
    outcome: t.Literal["resting"] = field(default="resting", init=False)


@dataclass(frozen=True)
class ExecutedOrder:
    """Accepted and done without resting: filled in full, or an IOC or market
    order whose remainder was dropped. ``filled_quantity`` may be 0;
    ``unfilled`` says why less than ``requested_quantity`` filled
    (``reduce_only_cap``, ``self_trade``, ``no_liquidity``, ``margin_cap``),
    ``None`` when it all filled."""

    market: int
    client_order_id: Optional[int]
    order_id: int
    requested_quantity: int
    filled_quantity: int
    unfilled: Optional[str]
    outcome: t.Literal["executed"] = field(default="executed", init=False)


@dataclass(frozen=True)
class RejectedOrder:
    """Refused for a trading reason; it wrote nothing. ``code`` is its
    ``ExecError`` code and ``error_name`` its name."""

    market: int
    client_order_id: Optional[int]
    code: int
    error_name: Optional[str]
    outcome: t.Literal["rejected"] = field(default="rejected", init=False)


OrderPlacement = t.Union[RestingOrder, ExecutedOrder, RejectedOrder]
"""How one order of a ``PlaceOrders`` (or basket leg) ended."""


@dataclass(frozen=True)
class CancelledOrder:
    """The order left the book."""

    order_id: int
    market: int
    client_order_id: Optional[int]
    original_quantity: int
    remaining_quantity: int
    filled_quantity: int
    outcome: t.Literal["cancelled"] = field(default="cancelled", init=False)


@dataclass(frozen=True)
class RefusedCancel:
    """A requested cancel that removed nothing: ``order_id`` or
    ``client_order_id`` names it, ``code`` and ``error_name`` say why."""

    order_id: Optional[int]
    client_order_id: Optional[int]
    code: int
    error_name: Optional[str]
    outcome: t.Literal["refused"] = field(default="refused", init=False)


OrderCancellation = t.Union[CancelledOrder, RefusedCancel]
"""How one cancel of a ``CancelOrders`` / ``CancelClientOrders`` ended."""


def _int(entry: dict[str, t.Any], key: str) -> Optional[int]:
    value = entry.get(key)
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError) as e:
        raise CodecError(f"order result: {key} is not an integer: {value!r}") from e


def _required(entry: dict[str, t.Any], key: str) -> int:
    value = _int(entry, key)
    if value is None:
        raise CodecError(f"order result: {key} is missing")
    return value


def _outcome(entry: dict[str, t.Any], known: tuple[str, ...]) -> str:
    outcome = entry.get("outcome")
    if outcome not in known:
        raise CodecError(f"order result: unknown outcome {outcome!r}")
    return t.cast(str, outcome)


def _bool(entry: dict[str, t.Any], key: str) -> Optional[bool]:
    value = entry.get(key)
    if value is None:
        return None
    if value not in ("true", "false"):
        raise CodecError(f"order result: {key} is not true or false: {value!r}")
    return value == "true"


def _named(entry: dict[str, t.Any], key: str, names: dict[str, t.Any]) -> t.Any:
    value = entry.get(key)
    if value is None:
        return None
    try:
        return names[value]
    except (KeyError, TypeError) as e:
        raise CodecError(f"order result: unknown {key}: {value!r}") from e


def _required_named(entry: dict[str, t.Any], key: str, names: dict[str, t.Any]) -> t.Any:
    value = _named(entry, key, names)
    if value is None:
        raise CodecError(f"order result: {key} is missing")
    return value


def _required_bool(entry: dict[str, t.Any], key: str) -> bool:
    value = _bool(entry, key)
    if value is None:
        raise CodecError(f"order result: {key} is missing")
    return value


def _list_events(events: t.Any) -> list[tuple[str, Optional[str], list[dict[str, t.Any]]]]:
    """Every ``orders_placed`` / ``orders_cancelled`` event as ``(type, reason,
    entries)``. Takes gateway event dicts or :class:`TransactionEvidenceEvent`
    values; raises :class:`CodecError` for an order event that does not read."""
    if not isinstance(events, (list, tuple)):
        return []
    found = []
    for event in events:
        if isinstance(event, dict):
            event_type, attributes = event.get("type"), event.get("attributes")
        else:
            event_type = getattr(event, "type", None)
            attributes = getattr(event, "attributes", None)
        if event_type not in (ORDERS_PLACED, ORDERS_CANCELLED):
            continue
        values = {
            a.get("key"): a.get("value") for a in attributes or () if isinstance(a, dict)
        }
        if "orders" not in values:
            raise CodecError(f"{event_type}: orders is missing")
        try:
            entries = json.loads(values["orders"] or "")
        except ValueError as e:
            raise CodecError(f"{event_type}: orders is not JSON") from e
        if not isinstance(entries, list) or not all(isinstance(e, dict) for e in entries):
            raise CodecError(f"{event_type}: orders is not a list of objects")
        found.append((t.cast(str, event_type), values.get("reason"), entries))
    return found


def _own_entries(events: t.Any, event_type: str) -> Optional[list[dict[str, t.Any]]]:
    """The transaction's own order results: its ``orders_placed``, or its user-requested
    ``orders_cancelled``; ``None`` when it emitted none."""
    for kind, reason, entries in _list_events(events):
        if kind == event_type and (kind == ORDERS_PLACED or reason == "user_requested"):
            return entries
    return None


def _placement(entry: dict[str, t.Any]) -> OrderPlacement:
    market = _required(entry, "market")
    client_order_id = _int(entry, "client_order_id")
    outcome = _outcome(entry, ("resting", "executed", "rejected"))
    if outcome == "resting":
        return RestingOrder(
            market=market,
            client_order_id=client_order_id,
            order_id=_required(entry, "order_id"),
            side=_required_named(entry, "side", _SIDES),
            price=_required(entry, "price"),
            quantity=_required(entry, "quantity"),
            time_in_force=_required_named(entry, "time_in_force", _TIME_IN_FORCE),
            post_only=_required_bool(entry, "post_only"),
            reduce_only=_required_bool(entry, "reduce_only"),
        )
    if outcome == "executed":
        return ExecutedOrder(
            market=market,
            client_order_id=client_order_id,
            order_id=_required(entry, "order_id"),
            requested_quantity=_required(entry, "requested_quantity"),
            filled_quantity=_required(entry, "filled_quantity"),
            unfilled=entry.get("unfilled") or None,
        )
    code = _required(entry, "code")
    return RejectedOrder(
        market=market,
        client_order_id=client_order_id,
        code=code,
        error_name=get_error_name(code),
    )


def _cancellation(entry: dict[str, t.Any]) -> OrderCancellation:
    if _outcome(entry, ("cancelled", "refused")) == "cancelled":
        return CancelledOrder(
            order_id=_required(entry, "order_id"),
            market=_required(entry, "market"),
            client_order_id=_int(entry, "client_order_id"),
            original_quantity=_required(entry, "original_quantity"),
            remaining_quantity=_required(entry, "remaining_quantity"),
            filled_quantity=_required(entry, "filled_quantity"),
        )
    code = _required(entry, "code")
    return RefusedCancel(
        order_id=_int(entry, "order_id"),
        client_order_id=_int(entry, "client_order_id"),
        code=code,
        error_name=get_error_name(code),
    )


def order_placements(response: dict[str, t.Any]) -> list[OrderPlacement]:
    """Each order's outcome from the response's ``orders_placed`` event, in
    order: the orders of a ``PlaceOrders`` or the legs of an
    ``AtomicBasketOrder``."""
    return [_placement(e) for e in _own_entries(response.get("events"), ORDERS_PLACED) or []]


def order_cancellations(response: dict[str, t.Any]) -> list[OrderCancellation]:
    """Each cancel's outcome from the response's user-requested
    ``orders_cancelled`` event, in order."""
    return [
        _cancellation(e) for e in _own_entries(response.get("events"), ORDERS_CANCELLED) or []
    ]


@dataclass(frozen=True)
class PlaceOrdersResult:
    """A ``place_orders`` call: its ``/exchange`` response and each order's
    outcome, in the order sent. ``tx["code"]`` is non-zero when the engine
    refused the whole transaction (a stale nonce, for example), and
    ``orders`` is then empty. A rejected order leaves ``tx["code"]`` at 0."""

    tx: dict[str, t.Any]
    orders: list[OrderPlacement]


@dataclass(frozen=True)
class CancelOrdersResult:
    """A ``cancel_orders`` / ``cancel_client_orders`` call: its response and
    each cancel's outcome, in order; read as :class:`PlaceOrdersResult`."""

    tx: dict[str, t.Any]
    orders: list[OrderCancellation]


@dataclass(frozen=True)
class PlaceOrderResult:
    """A single order call: its response and the order's outcome, ``None``
    when the engine refused the whole transaction (non-zero ``tx["code"]``)."""

    tx: dict[str, t.Any]
    order: Optional[OrderPlacement]


@dataclass(frozen=True)
class CancelOrderResult:
    """A single cancel: its response and the cancel's outcome, ``None`` when
    the engine refused the whole transaction."""

    tx: dict[str, t.Any]
    cancellation: Optional[OrderCancellation]


@dataclass(frozen=True)
class SentOrders:
    """What an order action sent: the event reporting it and how many orders.
    A single order or cancel is a batch of one."""

    event_type: str
    orders: int


def check_order_result(tx_hash: str, events: t.Any, sent: Optional[SentOrders] = None) -> None:
    """Check an executed, code-0 transaction's order results.

    Every order action is a batch, a single order a batch of one, so a
    rejected order is reported in :func:`order_placements` /
    :func:`order_cancellations` and never raises.

    Raises :class:`OrderResultUnreadable` when an order event does not read,
    or when ``sent`` says what was sent and the event is missing or has the
    wrong number of orders: the transaction executed, so never re-submit it.
    ``events`` are gateway event dicts or :class:`TransactionEvidenceEvent`
    values.
    """
    try:
        placed = _own_entries(events, ORDERS_PLACED)
        cancelled = _own_entries(events, ORDERS_CANCELLED)
        for entry in placed or []:
            _placement(entry)
        for entry in cancelled or []:
            _cancellation(entry)
    except CodecError as e:
        raise OrderResultUnreadable(tx_hash, str(e)) from e
    if sent is not None:
        results = placed if sent.event_type == ORDERS_PLACED else cancelled
        if results is None or len(results) != sent.orders:
            read = "no order event" if results is None else f"{len(results)} reported"
            raise OrderResultUnreadable(tx_hash, f"{sent.orders} sent, {read}")

__all__ = [
    "CancelOrderResult",
    "CancelOrdersResult",
    "CancelledOrder",
    "ExecutedOrder",
    "OrderCancellation",
    "OrderPlacement",
    "PlaceOrderResult",
    "PlaceOrdersResult",
    "RefusedCancel",
    "RejectedOrder",
    "RestingOrder",
    "check_order_result",
    "order_cancellations",
    "order_placements",
]
