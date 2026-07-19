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
from enum import StrEnum
from typing import Any, Optional

import proof_trading_sdk._native as _native

# ── Wire-string enums (match the Rust serde unit-variant names) ──────────────


class Side(StrEnum):
    Buy = "Buy"
    Sell = "Sell"


class TimeInForce(StrEnum):
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


# ── Relayer-signed actions ────────────────────────────────────────────────────


@dataclass
class Deposit(Action):
    ACTION_NAME = "Deposit"
    owner: bytes
    amount: int
    signer: bytes

    def fields(self) -> dict[str, Any]:
        return {"owner": self.owner, "amount": self.amount, "signer": self.signer}


@dataclass
class Withdraw(Action):
    ACTION_NAME = "Withdraw"
    owner: bytes
    amount: int
    signer: bytes

    def fields(self) -> dict[str, Any]:
        return {"owner": self.owner, "amount": self.amount, "signer": self.signer}


@dataclass
class WithdrawRequest(Action):
    ACTION_NAME = "WithdrawRequest"
    owner: bytes
    amount: int
    solana_destination: bytes

    def fields(self) -> dict[str, Any]:
        return {
            "owner": self.owner,
            "amount": self.amount,
            "solana_destination": self.solana_destination,
        }


@dataclass
class ConfirmDeposit(Action):
    ACTION_NAME = "ConfirmDeposit"
    owner: bytes
    amount: int
    solana_tx_sig: bytes
    signer: bytes

    def fields(self) -> dict[str, Any]:
        return {
            "owner": self.owner,
            "amount": self.amount,
            "solana_tx_sig": self.solana_tx_sig,
            "signer": self.signer,
        }


@dataclass
class ConfirmWithdrawal(Action):
    ACTION_NAME = "ConfirmWithdrawal"
    withdrawal_id: int
    solana_tx_sig: bytes
    signer: bytes

    def fields(self) -> dict[str, Any]:
        return {
            "withdrawal_id": self.withdrawal_id,
            "solana_tx_sig": self.solana_tx_sig,
            "signer": self.signer,
        }


@dataclass
class FailWithdrawal(Action):
    ACTION_NAME = "FailWithdrawal"
    withdrawal_id: int
    reason: str
    signer: bytes

    def fields(self) -> dict[str, Any]:
        return {
            "withdrawal_id": self.withdrawal_id,
            "reason": self.reason,
            "signer": self.signer,
        }


@dataclass
class SetUserMarketLeverage(Action):
    ACTION_NAME = "SetUserMarketLeverage"
    owner: bytes
    market: int
    user_im_bps: int

    def fields(self) -> dict[str, Any]:
        return {
            "owner": self.owner,
            "market": self.market,
            "user_im_bps": self.user_im_bps,
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
    oracle_source: Any = None
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
class UpdateMarketFees(Action):
    ACTION_NAME = "UpdateMarketFees"
    market: int
    signer: bytes
    taker_fee_bps: Optional[int] = None
    maker_fee_bps: Optional[int] = None
    max_funding_rate_bps: Optional[int] = None
    funding_interval_ms: Optional[int] = None
    max_position_size: Optional[int] = None
    default_ttl_ms: Optional[int] = None
    net_delta_margin: Optional[bool] = None
    tick_size: Optional[int] = None
    lot_size: Optional[int] = None
    primary_oracle_signer: Optional[bytes] = None
    oracle_staleness_ms: Optional[int] = None
    mark_source_mode: Optional[int] = None
    max_mark_spread_bps: Optional[int] = None
    cex_composite_staleness_ms: Optional[int] = None
    partial_liquidation_enabled: Optional[bool] = None
    fee_tiers: Optional[list[dict[str, Any]]] = None
    im_bps: Optional[int] = None
    mm_bps: Optional[int] = None
    max_open_interest: Optional[int] = None

    def fields(self) -> dict[str, Any]:
        return {
            "market": self.market,
            "signer": self.signer,
            "taker_fee_bps": self.taker_fee_bps,
            "maker_fee_bps": self.maker_fee_bps,
            "max_funding_rate_bps": self.max_funding_rate_bps,
            "funding_interval_ms": self.funding_interval_ms,
            "max_position_size": self.max_position_size,
            "default_ttl_ms": self.default_ttl_ms,
            "net_delta_margin": self.net_delta_margin,
            "tick_size": self.tick_size,
            "lot_size": self.lot_size,
            "primary_oracle_signer": self.primary_oracle_signer,
            "oracle_staleness_ms": self.oracle_staleness_ms,
            "mark_source_mode": self.mark_source_mode,
            "max_mark_spread_bps": self.max_mark_spread_bps,
            "cex_composite_staleness_ms": self.cex_composite_staleness_ms,
            "partial_liquidation_enabled": self.partial_liquidation_enabled,
            "fee_tiers": self.fee_tiers,
            "im_bps": self.im_bps,
            "mm_bps": self.mm_bps,
            "max_open_interest": self.max_open_interest,
        }


# ── Operator actions (privileged — feeder / relayer infrastructure) ──────────
#
# These are NOT trading actions. A normal trading integration never builds
# them — they are submitted by the operator's oracle relay / CEX-composite
# feeder / relayer, each gated by a dedicated engine allowlist. They live in
# the public SDK so operator tooling needs no second SDK, but a trading
# consumer should ignore this section. Most operator actions (OracleUpdate,
# CreateMarket, Confirm*/Fail*, ResolveEvent, …) are reachable via
# :class:`RawAction`; OracleUpdateComposite gets a typed builder because Auros'
# Python feeder requested first-class support.


@dataclass
class OracleUpdateComposite(Action):
    """**Operator-only.** Submit a composite-CEX price for a market — BE-31
    Phase B's third source for the multi-source mark-price median.

    Not a trading action: the engine re-checks ``signer`` against a *separate*
    CEX-composite feeder allowlist (a distinct trust domain from the
    ``OracleUpdate`` relay), so a non-feeder signer is rejected regardless.
    Markets ignore the composite entirely unless an operator has flipped them
    to ``Median`` via :class:`UpdateMarketFees` (``mark_source_mode=1``).

    Field order matches the engine struct: ``market, price, n_sources,
    signer, publish_time_ms``. ``n_sources`` is observability-only (the engine
    does not gate on it); ``publish_time_ms`` is a strictly-monotonic replay
    guard, same as :class:`OracleUpdate`.
    """

    ACTION_NAME = "OracleUpdateComposite"
    market: int
    price: int
    signer: bytes
    # Required — NOT defaulted. `publish_time_ms` is the strictly-monotonic
    # replay guard the engine enforces; a silent `0` default lets a feeder mint
    # a first update at ts 0 and then have every later omitted update rejected,
    # silently dropping the composite from the median. Matches the TS builder
    # (`publishTimeMs` required) and Rust construction. The `serde(default)` on
    # the Rust struct is decode-only (legacy payloads), not a mint-time default.
    publish_time_ms: int
    # Observability-only (the engine doesn't gate on it); safe to default.
    n_sources: int = 0

    def fields(self) -> dict[str, Any]:
        return {
            "market": self.market,
            "price": self.price,
            "n_sources": self.n_sources,
            "signer": self.signer,
            "publish_time_ms": self.publish_time_ms,
        }


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
    "Deposit",
    "Withdraw",
    "WithdrawRequest",
    "ConfirmDeposit",
    "ConfirmWithdrawal",
    "FailWithdrawal",
    "SetUserMarketLeverage",
    "CreateImpactMarket",
    "UpdateMarketFees",
    "OracleUpdateComposite",
    "encode_action",
    "decode_action",
]
