"""Typed gateway assertions; payloads decode through canonical Rust wire types."""
from __future__ import annotations

import base64
import binascii
import typing as t
from dataclasses import dataclass

from proof_trading_sdk import _native
from proof_trading_sdk.errors import CodecError, GatewayReadError
from proof_trading_sdk.evidence import FinalizedReadWitness, decode_finalized_read_witness
from proof_trading_sdk.trigger_history import canonical_owner


@dataclass(frozen=True)
class FinalizedPositionBrief:
    owner: bytes
    market: int
    side: t.Literal["Buy", "Sell"]
    entry_price: int
    size: int
    last_funding_index: int
    upnl_now: int
    mm_now: int
    im_now: int
    pnl_if_fires: int
    pnl_if_dies: int
    funding_since: int
    adl_score: int
    position_epoch: int | None


@dataclass(frozen=True)
class FinalizedBindingScenario:
    event_id: int
    branch: t.Literal["Yes", "No"]


@dataclass(frozen=True)
class FinalizedAccountInfo:
    owner: str
    balance: int
    positions: list[FinalizedPositionBrief]
    equity: int
    total_mm: int
    total_im: int
    margin_ratio_bps: int
    binding_scenario: list[FinalizedBindingScenario]
    fees_accrued: int
    volume_30d_micro_usdc: int
    cashout_equity: int
    witness: FinalizedReadWitness


@dataclass(frozen=True)
class FinalizedAgentAuthorization:
    owner: str
    agent: str
    authorized: bool
    witness: FinalizedReadWitness


@dataclass(frozen=True)
class FinalizedRecentNonces:
    signer: str
    recent: list[int]
    witness: FinalizedReadWitness


@dataclass(frozen=True)
class FinalizedOpenOrder:
    id: int
    market: int
    owner: str
    side: t.Literal["Buy", "Sell"]
    price: int
    quantity: int
    client_order_id: int | None
    original_quantity: int
    filled_quantity: int
    created_at_ms: int
    queue_priority: int
    time_in_force: t.Literal["Gtc", "Ioc", "Fok"]
    post_only: bool
    reduce_only: bool


@dataclass(frozen=True)
class FinalizedOpenOrders:
    owner: str
    limit: int
    orders: list[FinalizedOpenOrder]
    complete: bool
    witness: FinalizedReadWitness


def _address(value: bytes | str) -> str:
    try:
        return canonical_owner(value)
    except ValueError as err:
        raise GatewayReadError("malformed", "account address") from err


def _limit(value: int) -> int:
    if type(value) is not int or not 1 <= value <= 101:
        raise GatewayReadError("malformed", "order limit")
    return value


def _witnessed(value: t.Any) -> tuple[bytes, FinalizedReadWitness]:
    if not isinstance(value, dict) or set(value) != {"data", "witness"}:
        raise GatewayReadError("malformed", "account envelope")
    encoded = value["data"]
    maximum = 512 * 1024
    if not isinstance(encoded, str) or len(encoded) > ((maximum + 2) // 3) * 4:
        raise GatewayReadError("malformed", "account base64")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as err:
        raise GatewayReadError("malformed", "account base64") from err
    if len(data) > maximum or base64.b64encode(data).decode("ascii") != encoded:
        raise GatewayReadError("malformed", "account base64")
    witness = value["witness"]
    if not isinstance(witness, dict) or len(witness) != 5:
        raise GatewayReadError("malformed", "account witness")
    return data, decode_finalized_read_witness(witness)


def _decode(call: t.Callable[..., t.Any], *args: t.Any) -> t.Any:
    try:
        return call(*args)
    except (CodecError, ValueError) as err:
        binding = "owner does not match" in str(err) or "binding mismatch" in str(err)
        raise GatewayReadError("binding" if binding else "malformed", "account payload") from err


def decode_finalized_account(value: t.Any, owner: bytes | str) -> FinalizedAccountInfo:
    owner = _address(owner)
    data, witness = _witnessed(value)
    row = _decode(_native.decode_finalized_account, data, bytes.fromhex(owner))
    positions = [FinalizedPositionBrief(**dict(p, owner=bytes(p["owner"]))) for p in row.pop("positions")]
    scenarios = [FinalizedBindingScenario(**p) for p in row.pop("binding_scenario")]
    return FinalizedAccountInfo(owner=owner, positions=positions, binding_scenario=scenarios, witness=witness, **row)


def decode_finalized_agent_authorization(value: t.Any, owner: bytes | str, agent: bytes | str) -> FinalizedAgentAuthorization:
    owner, agent = _address(owner), _address(agent)
    data, witness = _witnessed(value)
    return FinalizedAgentAuthorization(owner, agent, _decode(_native.decode_finalized_agent_authorization, data), witness)


def decode_finalized_recent_nonces(value: t.Any, signer: bytes | str) -> FinalizedRecentNonces:
    signer = _address(signer)
    data, witness = _witnessed(value)
    return FinalizedRecentNonces(signer, _decode(_native.decode_finalized_recent_nonces, data), witness)


def decode_finalized_open_orders(value: t.Any, owner: bytes | str, limit: int = 101) -> FinalizedOpenOrders:
    owner, limit = _address(owner), _limit(limit)
    data, witness = _witnessed(value)
    rows = _decode(_native.decode_finalized_open_orders, data, bytes.fromhex(owner), limit)
    orders = [FinalizedOpenOrder(**dict(row, owner=bytes(row["owner"]).hex())) for row in rows]
    return FinalizedOpenOrders(owner, limit, orders, len(orders) < limit, witness)
