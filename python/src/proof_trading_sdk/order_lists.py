"""Per-entry results of the list actions, read from their list events.

``PlaceOrders`` emits one ``orders_placed`` and ``CancelOrders`` /
``CancelClientOrders`` one ``orders_cancelled``. Each carries an ``orders``
attribute: a JSON array with one object of string values per entry, in the
order sent.
"""

from __future__ import annotations

import json
import typing as t
from dataclasses import dataclass
from typing import Optional

from proof_trading_sdk.actions import Side, TimeInForce
from proof_trading_sdk.errors import CodecError, get_error_name

ORDERS_PLACED = "orders_placed"
ORDERS_CANCELLED = "orders_cancelled"

_SIDES = {"buy": Side.Buy, "sell": Side.Sell}
_TIME_IN_FORCE = {"gtc": TimeInForce.Gtc, "ioc": TimeInForce.Ioc, "fok": TimeInForce.Fok}


@dataclass(frozen=True)
class OrderPlacement:
    """What became of one order of a ``PlaceOrders``.

    ``outcome`` is ``"resting"`` (``quantity`` is the resting remainder),
    ``"executed"`` (filled in full, or an IOC/FOK whose remainder was
    dropped) or ``"rejected"`` (``code`` and ``error_name`` say why).
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


def _bool(entry: dict[str, t.Any], key: str) -> Optional[bool]:
    value = entry.get(key)
    return None if value is None else value == "true"


def _code(entry: dict[str, t.Any]) -> tuple[Optional[int], Optional[str]]:
    code = _int(entry, "code")
    return code, (None if code is None else get_error_name(code))


def _entries(events: t.Any, event_type: str) -> list[dict[str, t.Any]]:
    """The ``orders`` array of the first ``event_type`` event, or ``[]``."""
    if not isinstance(events, list):
        return []
    for event in events:
        if not isinstance(event, dict) or event.get("type") != event_type:
            continue
        for attribute in event.get("attributes") or []:
            if isinstance(attribute, dict) and attribute.get("key") == "orders":
                try:
                    entries = json.loads(attribute.get("value") or "")
                except ValueError as e:
                    raise CodecError(f"{event_type}: orders is not JSON") from e
                if not isinstance(entries, list) or not all(
                    isinstance(entry, dict) for entry in entries
                ):
                    raise CodecError(f"{event_type}: orders is not a list of objects")
                return entries
        return []
    return []


def order_placements(response: dict[str, t.Any]) -> list[OrderPlacement]:
    """Every order of the response's ``orders_placed`` event, in order."""
    placements = []
    for entry in _entries(response.get("events"), ORDERS_PLACED):
        code, error_name = _code(entry)
        side = entry.get("side")
        tif = entry.get("time_in_force")
        placements.append(
            OrderPlacement(
                outcome=str(entry.get("outcome")),
                market=_int(entry, "market") or 0,
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
            )
        )
    return placements


def order_cancellations(response: dict[str, t.Any]) -> list[OrderCancellation]:
    """Every entry of the response's ``orders_cancelled`` event, in order."""
    cancellations = []
    for entry in _entries(response.get("events"), ORDERS_CANCELLED):
        code, error_name = _code(entry)
        cancellations.append(
            OrderCancellation(
                outcome=str(entry.get("outcome")),
                order_id=_int(entry, "order_id"),
                client_order_id=_int(entry, "client_order_id"),
                market=_int(entry, "market"),
                original_quantity=_int(entry, "original_quantity"),
                remaining_quantity=_int(entry, "remaining_quantity"),
                filled_quantity=_int(entry, "filled_quantity"),
                code=code,
                error_name=error_name,
            )
        )
    return cancellations


def single_refusal_code(response: dict[str, t.Any], event_type: str) -> Optional[int]:
    """The code of a list of one whose only entry was refused, else ``None``."""
    entries = _entries(response.get("events"), event_type)
    if len(entries) != 1 or entries[0].get("outcome") not in ("rejected", "refused"):
        return None
    return _int(entries[0], "code")


__all__ = [
    "OrderPlacement",
    "OrderCancellation",
    "order_placements",
    "order_cancellations",
]
