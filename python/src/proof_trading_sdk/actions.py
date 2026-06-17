"""Typed action builders for the Proof Exchange.

The **codec is not reimplemented here.** Each builder only assembles a
field dict keyed by the Rust struct's snake_case field names; the shared
Rust core (`_native.encode_action`) deserializes that dict into the typed
payload struct and produces the authoritative MessagePack bytes via the
same `rmp-serde` path the engine uses. Field order, enum-as-string,
byte-array, and integer-width encoding all live in Rust — Python never
guesses the wire layout.

Byte fields (`owner`, `signer`, …) are passed as raw ``bytes``; the
core's `wire` newtypes accept them directly and length-check on decode.

Every action byte is pulled from the core via `get_action_types()`, so
the `ActionType` map can never drift from the Rust `impl_action_encoding!`
list. Actions without a dedicated builder (admin / relayer actions) are
still fully reachable through :class:`RawAction`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

import proof_trading_sdk._native as _native

# ── Wire-string enums (match the Rust serde unit-variant names) ──────────────


class Side:
    Buy = "Buy"
    Sell = "Sell"


class TimeInForce:
    Gtc = "Gtc"
    Ioc = "Ioc"
    Fok = "Fok"


# ── Action-type byte map (generated from the Rust core) ──────────────────────


class _ActionTypeMap:
    """``ActionType.PlaceOrder`` → the wire byte, generated from the core."""

    def __init__(self) -> None:
        for entry in _native.get_action_types():
            setattr(self, entry["name"], entry["code"])

    def __getitem__(self, name: str) -> int:
        return getattr(self, name)


ActionType = _ActionTypeMap()


# ── Action protocol ──────────────────────────────────────────────────────────


class Action:
    """Base for typed action builders. Subclasses set ``ACTION_NAME`` and
    implement :meth:`fields`."""

    ACTION_NAME: str = ""

    @property
    def action_type(self) -> int:
        return ActionType[self.ACTION_NAME]

    def fields(self) -> dict[str, Any]:  # pragma: no cover - overridden
        raise NotImplementedError


@dataclass
class RawAction(Action):
    """Escape hatch for any action without a dedicated builder (admin /
    relayer actions, or forward-compat). Pass the action byte and a field
    dict whose keys are the Rust struct's snake_case field names."""

    action_type_byte: int
    field_dict: dict[str, Any]

    @property
    def action_type(self) -> int:
        return self.action_type_byte

    def fields(self) -> dict[str, Any]:
        return self.field_dict


# ── User-signed trading actions ──────────────────────────────────────────────


@dataclass
class PlaceOrder(Action):
    ACTION_NAME = "PlaceOrder"
    market: int
    owner: bytes
    side: str
    price: int
    quantity: int
    client_order_id: Optional[int] = None
    post_only: bool = False
    reduce_only: bool = False
    time_in_force: str = TimeInForce.Gtc

    def fields(self) -> dict[str, Any]:
        return {
            "market": self.market,
            "owner": self.owner,
            "side": self.side,
            "price": self.price,
            "quantity": self.quantity,
            "client_order_id": self.client_order_id,
            "post_only": self.post_only,
            "reduce_only": self.reduce_only,
            "time_in_force": self.time_in_force,
        }


@dataclass
class MarketOrder(Action):
    ACTION_NAME = "MarketOrder"
    market: int
    owner: bytes
    side: str
    quantity: int
    client_order_id: Optional[int] = None

    def fields(self) -> dict[str, Any]:
        return {
            "market": self.market,
            "owner": self.owner,
            "side": self.side,
            "quantity": self.quantity,
            "client_order_id": self.client_order_id,
        }


@dataclass
class CancelOrder(Action):
    ACTION_NAME = "CancelOrder"
    order_id: int
    owner: bytes

    def fields(self) -> dict[str, Any]:
        return {"order_id": self.order_id, "owner": self.owner}


@dataclass
class CancelClientOrder(Action):
    ACTION_NAME = "CancelClientOrder"
    owner: bytes
    client_order_id: int

    def fields(self) -> dict[str, Any]:
        return {"owner": self.owner, "client_order_id": self.client_order_id}


@dataclass
class CancelAllOrders(Action):
    ACTION_NAME = "CancelAllOrders"
    owner: bytes
    market: Optional[int] = None

    def fields(self) -> dict[str, Any]:
        return {"owner": self.owner, "market": self.market}


@dataclass
class CancelReplaceOrder(Action):
    ACTION_NAME = "CancelReplaceOrder"
    owner: bytes
    market: int
    side: str
    price: int
    quantity: int
    cancel_order_id: Optional[int] = None
    cancel_client_order_id: Optional[int] = None
    client_order_id: Optional[int] = None
    post_only: bool = False
    reduce_only: bool = False
    time_in_force: str = TimeInForce.Gtc

    def fields(self) -> dict[str, Any]:
        return {
            "owner": self.owner,
            "cancel_order_id": self.cancel_order_id,
            "cancel_client_order_id": self.cancel_client_order_id,
            "market": self.market,
            "side": self.side,
            "price": self.price,
            "quantity": self.quantity,
            "client_order_id": self.client_order_id,
            "post_only": self.post_only,
            "reduce_only": self.reduce_only,
            "time_in_force": self.time_in_force,
        }


@dataclass
class AmendOrder(Action):
    ACTION_NAME = "AmendOrder"
    owner: bytes
    order_id: int
    new_price: Optional[int] = None
    new_quantity: Optional[int] = None

    def fields(self) -> dict[str, Any]:
        return {
            "owner": self.owner,
            "order_id": self.order_id,
            "new_price": self.new_price,
            "new_quantity": self.new_quantity,
        }


@dataclass
class ClosePosition(Action):
    ACTION_NAME = "ClosePosition"
    market: int
    owner: bytes

    def fields(self) -> dict[str, Any]:
        return {"market": self.market, "owner": self.owner}


@dataclass
class CreateMarket(Action):
    ACTION_NAME = "CreateMarket"
    market: int
    im_bps: int
    mm_bps: int
    taker_fee_bps: int
    maker_fee_bps: int
    signer: bytes
    funding_interval_ms: int
    max_funding_rate_bps: int
    # sz_decimals + ticker are MANDATORY on the engine (no serde default) — a
    # payload omitting them is rejected at decode. pool_id is serde(default).
    sz_decimals: int
    ticker: str
    pool_id: int = 0

    def fields(self) -> dict[str, Any]:
        return {
            "market": self.market,
            "im_bps": self.im_bps,
            "mm_bps": self.mm_bps,
            "taker_fee_bps": self.taker_fee_bps,
            "maker_fee_bps": self.maker_fee_bps,
            "signer": self.signer,
            "funding_interval_ms": self.funding_interval_ms,
            "max_funding_rate_bps": self.max_funding_rate_bps,
            "pool_id": self.pool_id,
            "sz_decimals": self.sz_decimals,
            "ticker": self.ticker,
        }


@dataclass
class CreateImpactMarket(Action):
    ACTION_NAME = "CreateImpactMarket"
    impact_market_id: int
    underlying_market: int
    child_market_base: int
    question: str
    deadline_ms: int
    resolution_window_ms: int
    im_bps: int
    mm_bps: int
    taker_fee_bps: int
    maker_fee_bps: int
    funding_interval_ms: int
    max_funding_rate_bps: int
    signer: bytes
    oracle_source: Optional[Any] = None
    description: str = ""
    rules: str = ""

    def fields(self) -> dict[str, Any]:
        return {
            "impact_market_id": self.impact_market_id,
            "underlying_market": self.underlying_market,
            "child_market_base": self.child_market_base,
            "question": self.question,
            "deadline_ms": self.deadline_ms,
            "resolution_window_ms": self.resolution_window_ms,
            "im_bps": self.im_bps,
            "mm_bps": self.mm_bps,
            "taker_fee_bps": self.taker_fee_bps,
            "maker_fee_bps": self.maker_fee_bps,
            "funding_interval_ms": self.funding_interval_ms,
            "max_funding_rate_bps": self.max_funding_rate_bps,
            "signer": self.signer,
            "oracle_source": self.oracle_source,
            "description": self.description,
            "rules": self.rules,
        }


@dataclass
class AtomicBasketLeg:
    """One leg of a native all-or-revert basket. Not an action on its own —
    nested inside :class:`AtomicBasketOrder`."""

    market: int
    side: str
    price: int
    quantity: int
    client_order_id: Optional[int] = None
    reduce_only: bool = False

    def as_wire(self) -> dict[str, Any]:
        return {
            "market": self.market,
            "side": self.side,
            "price": self.price,
            "quantity": self.quantity,
            "client_order_id": self.client_order_id,
            "reduce_only": self.reduce_only,
        }


@dataclass
class AtomicBasketOrder(Action):
    ACTION_NAME = "AtomicBasketOrder"
    owner: bytes
    legs: list[AtomicBasketLeg]
    # serde(default) u32 — encodes as 0 when absent, NOT nil.
    max_slippage_bps: int = 0

    def fields(self) -> dict[str, Any]:
        return {
            "owner": self.owner,
            "legs": [leg.as_wire() for leg in self.legs],
            "max_slippage_bps": self.max_slippage_bps,
        }


@dataclass
class ApproveAgent(Action):
    ACTION_NAME = "ApproveAgent"
    owner: bytes
    agent_pubkey: bytes

    def fields(self) -> dict[str, Any]:
        return {"owner": self.owner, "agent_pubkey": self.agent_pubkey}


@dataclass
class RevokeAgent(Action):
    ACTION_NAME = "RevokeAgent"
    owner: bytes
    agent_pubkey: bytes

    def fields(self) -> dict[str, Any]:
        return {"owner": self.owner, "agent_pubkey": self.agent_pubkey}


# ── Codec helpers (delegate to the shared Rust core) ─────────────────────────


def encode_action(action: Action) -> tuple[int, bytes]:
    """Encode *action* to ``(action_type, payload_bytes)`` via the core.

    The bytes are the canonical MessagePack payload, ready to hand to
    ``ExchangeClient.sign_and_encode_action`` / ``_native.sign_and_encode``.
    """
    action_type = action.action_type
    payload = _native.encode_action(action_type, action.fields())
    return action_type, payload


def decode_action(action_type: int, payload: bytes) -> dict[str, Any]:
    """Decode payload bytes back into a native field dict via the core."""
    return _native.decode_action(action_type, payload)


__all__ = [
    "Action",
    "ActionType",
    "RawAction",
    "Side",
    "TimeInForce",
    "PlaceOrder",
    "MarketOrder",
    "CancelOrder",
    "CancelClientOrder",
    "CancelAllOrders",
    "CancelReplaceOrder",
    "AmendOrder",
    "ClosePosition",
    "ApproveAgent",
    "RevokeAgent",
    "encode_action",
    "decode_action",
]
