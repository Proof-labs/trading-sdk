"""Per-entry results of the list actions, read from their list events.

``PlaceOrders`` emits one ``orders_placed`` (as does an ``AtomicBasketOrder``,
one entry per leg) and ``CancelOrders`` / ``CancelClientOrders`` one
``orders_cancelled``. Each carries an ``orders``
attribute: a JSON array with one object of string values per entry, in the
order sent.
"""

from __future__ import annotations

import json
import typing as t
from dataclasses import dataclass
from typing import Optional

from proof_trading_sdk.actions import Side, TimeInForce
from proof_trading_sdk.errors import (
    CodecError,
    EngineError,
    OrderResultUnreadable,
    get_error_name,
)

ORDERS_PLACED = "orders_placed"
ORDERS_CANCELLED = "orders_cancelled"

_SIDES = {"buy": Side.Buy, "sell": Side.Sell}
_TIME_IN_FORCE = {"gtc": TimeInForce.Gtc, "ioc": TimeInForce.Ioc, "fok": TimeInForce.Fok}


@dataclass(frozen=True)
class OrderPlacement:
    """What became of one order of a ``PlaceOrders``.

    ``outcome`` is ``"resting"`` (``quantity`` is the resting remainder),
    ``"executed"`` (done without resting: filled in full, or an IOC or market
    order whose remainder was dropped; ``filled_quantity`` of
    ``requested_quantity`` filled, may be 0, and ``unfilled`` says why less
    filled: ``reduce_only_cap``, ``self_trade``, ``no_liquidity`` or
    ``margin_cap``) or ``"rejected"`` (``code`` and ``error_name`` say why).
    """

    outcome: str
    market: int
    client_order_id: Optional[int] = None
    order_id: Optional[int] = None
    side: Optional[Side] = None
    price: Optional[int] = None
    quantity: Optional[int] = None
    time_in_force: Optional[TimeInForce] = None
    post_only: Optional[bool] = None
    reduce_only: Optional[bool] = None
    code: Optional[int] = None
    error_name: Optional[str] = None
    requested_quantity: Optional[int] = None
    filled_quantity: Optional[int] = None
    unfilled: Optional[str] = None

    @property
    def rejected(self) -> bool:
        return self.outcome == "rejected"


@dataclass(frozen=True)
class OrderCancellation:
    """One entry of an ``orders_cancelled`` event.

    ``outcome`` is ``"cancelled"`` (the order left the book) or ``"refused"``
    (the cancel removed nothing; ``code`` and ``error_name`` say why).
    """

    outcome: str
    order_id: Optional[int] = None
    client_order_id: Optional[int] = None
    market: Optional[int] = None
    original_quantity: Optional[int] = None
    remaining_quantity: Optional[int] = None
    filled_quantity: Optional[int] = None
    code: Optional[int] = None
    error_name: Optional[str] = None

    @property
    def refused(self) -> bool:
        return self.outcome == "refused"


def _int(entry: dict[str, t.Any], key: str) -> Optional[int]:
    value = entry.get(key)
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError) as e:
        raise CodecError(f"list event entry: {key} is not an integer: {value!r}") from e


def _required(entry: dict[str, t.Any], key: str) -> int:
    value = _int(entry, key)
    if value is None:
        raise CodecError(f"list event entry: {key} is missing")
    return value


def _outcome(entry: dict[str, t.Any], known: tuple[str, ...]) -> str:
    outcome = entry.get("outcome")
    if outcome not in known:
        raise CodecError(f"list event entry: unknown outcome {outcome!r}")
    return t.cast(str, outcome)


def _bool(entry: dict[str, t.Any], key: str) -> Optional[bool]:
    value = entry.get(key)
    return None if value is None else value == "true"


def _code(entry: dict[str, t.Any]) -> tuple[Optional[int], Optional[str]]:
    code = _int(entry, "code")
    return code, (None if code is None else get_error_name(code))


def _list_events(events: t.Any) -> list[tuple[str, Optional[str], list[dict[str, t.Any]]]]:
    """Every ``orders_placed`` / ``orders_cancelled`` event as ``(type, reason,
    entries)``. Takes gateway event dicts or :class:`TransactionEvidenceEvent`
    values; raises :class:`CodecError` for a list event that does not read."""
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
    """The transaction's own list: its ``orders_placed``, or its user-requested
    ``orders_cancelled``; ``None`` when it emitted none."""
    for kind, reason, entries in _list_events(events):
        if kind == event_type and (kind == ORDERS_PLACED or reason == "user_requested"):
            return entries
    return None


def _placement(entry: dict[str, t.Any]) -> OrderPlacement:
    code, error_name = _code(entry)
    side = entry.get("side")
    tif = entry.get("time_in_force")
    outcome = _outcome(entry, ("resting", "executed", "rejected"))
    if outcome == "rejected" and code is None:
        raise CodecError("list event entry: code is missing")
    return OrderPlacement(
        outcome=outcome,
        market=_required(entry, "market"),
        client_order_id=_int(entry, "client_order_id"),
        order_id=_int(entry, "order_id"),
        side=_SIDES.get(side) if side is not None else None,
        price=_int(entry, "price"),
        quantity=_int(entry, "quantity"),
        time_in_force=_TIME_IN_FORCE.get(tif) if tif is not None else None,
        post_only=_bool(entry, "post_only"),
        reduce_only=_bool(entry, "reduce_only"),
        code=code,
        error_name=error_name,
        requested_quantity=_int(entry, "requested_quantity"),
        filled_quantity=_int(entry, "filled_quantity"),
        unfilled=entry.get("unfilled") or None,
    )


def _cancellation(entry: dict[str, t.Any]) -> OrderCancellation:
    code, error_name = _code(entry)
    outcome = _outcome(entry, ("cancelled", "refused"))
    if outcome == "refused" and code is None:
        raise CodecError("list event entry: code is missing")
    return OrderCancellation(
        outcome=outcome,
        order_id=_int(entry, "order_id"),
        client_order_id=_int(entry, "client_order_id"),
        market=_int(entry, "market"),
        original_quantity=_int(entry, "original_quantity"),
        remaining_quantity=_int(entry, "remaining_quantity"),
        filled_quantity=_int(entry, "filled_quantity"),
        code=code,
        error_name=error_name,
    )


def order_placements(response: dict[str, t.Any]) -> list[OrderPlacement]:
    """Every order of the response's ``orders_placed`` event, in order: the
    entries of a ``PlaceOrders`` or the legs of an ``AtomicBasketOrder``."""
    return [_placement(e) for e in _own_entries(response.get("events"), ORDERS_PLACED) or []]


def order_cancellations(response: dict[str, t.Any]) -> list[OrderCancellation]:
    """Every entry of the response's user-requested ``orders_cancelled``
    event, in order."""
    return [
        _cancellation(e) for e in _own_entries(response.get("events"), ORDERS_CANCELLED) or []
    ]


@dataclass(frozen=True)
class SentList:
    """What an order-list action sent: the event reporting it, its entry
    count, and whether it is a single order sent as a list of one."""

    event_type: str
    entries: int
    single: bool


def check_order_result(
    tx_hash: str, events: t.Any, sent: Optional[SentList] = None, *, log: str = ""
) -> None:
    """Raise what an executed, code-0 transaction's order list says.

    A single order or cancel is a list of one whose refusal arrives as a
    refused entry: raise it as the :class:`EngineError` the single action
    always carried. The rule reads the receipt, so a result reconciled
    without its action (``sent`` is ``None``, e.g. the events of
    :meth:`ExchangeClient.transaction_evidence` after
    :class:`SubmissionPending`) gets it too: there a list of one whose entry
    was refused is that error. The transaction's list is its
    ``orders_placed``, else its user-requested ``orders_cancelled``.

    Raises :class:`OrderResultUnreadable` when a list event does not read, or
    when ``sent`` says what was sent and the list is missing or has the wrong
    number of entries: the transaction executed, so never re-submit it.
    ``events`` are gateway event dicts or :class:`TransactionEvidenceEvent`
    values; ``log`` is the engine log the error carries.
    """
    try:
        placed = _own_entries(events, ORDERS_PLACED)
        cancelled = _own_entries(events, ORDERS_CANCELLED)
        entries = placed if placed is not None else cancelled
        if sent is not None:
            entries = placed if sent.event_type == ORDERS_PLACED else cancelled
            read = "no list event" if entries is None else f"{len(entries)} reported"
            if entries is None or len(entries) != sent.entries:
                raise OrderResultUnreadable(tx_hash, f"{sent.entries} sent, {read}")
        parsed: list[OrderPlacement | OrderCancellation] = (
            [_placement(e) for e in entries or []]
            if entries is placed
            else [_cancellation(e) for e in entries or []]
        )
    except CodecError as e:
        raise OrderResultUnreadable(tx_hash, str(e)) from e
    if sent is not None and not sent.single:
        return
    if len(parsed) == 1 and parsed[0].outcome in ("rejected", "refused"):
        refused = parsed[0]
        raise EngineError(t.cast(int, refused.code), log or refused.error_name or "")


__all__ = [
    "OrderPlacement",
    "OrderCancellation",
    "check_order_result",
    "order_placements",
    "order_cancellations",
]
