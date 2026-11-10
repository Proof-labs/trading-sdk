"""Typed governance facts decoded through the canonical Rust wire types."""
from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
import typing as t

from proof_trading_sdk import _native
from proof_trading_sdk.errors import CodecError


@dataclass(frozen=True)
class AuthoritiesSnapshot:
    relayer: list[bytes]
    oracle: list[bytes]
    cex_composite: list[bytes]
    custody: list[bytes]
    market_params: list[bytes]
    scheduled_ops: list[bytes]


@dataclass(frozen=True)
class FullCloseThreshold:
    numerator: int
    denominator: int


@dataclass(frozen=True)
class LiquidationConfig:
    target_ratio_bps: int
    full_close_threshold: FullCloseThreshold
    partial_penalty_bps: int
    # Retained wire fields; the engine no longer applies these pacing caps.
    max_book_orders: int
    max_committed_fills: int
    takeover_discount_bps: int


@dataclass(frozen=True)
class LiquidationConfigInfo:
    sequence: int
    config: LiquidationConfig


def _payload(value: t.Any) -> bytes:
    if not isinstance(value, dict) or "error" in value:
        raise CodecError("invalid governance read envelope")
    encoded = value.get("data")
    limit = _native.MAX_GOVERNANCE_READ_BYTES
    if not isinstance(encoded, str) or not encoded or len(encoded) > 4 * ((limit + 2) // 3):
        raise CodecError("missing or oversized governance read data")
    try:
        payload = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as err:
        raise CodecError("invalid governance read base64") from err
    if len(payload) > limit or base64.b64encode(payload).decode("ascii") != encoded:
        raise CodecError("invalid or oversized governance read base64")
    return payload


def decode_authorities_snapshot(value: t.Any) -> AuthoritiesSnapshot:
    """Decode a gateway data envelope; failures never become empty authority sets."""
    try:
        raw = _native.decode_authorities(_payload(value))
    except ValueError as err:
        raise CodecError("invalid authority snapshot") from err
    return AuthoritiesSnapshot(**raw)


def decode_liquidation_config_info(value: t.Any) -> LiquidationConfigInfo:
    """Decode the stored sequence/config pair; legacy takeover discount defaults to 50."""
    try:
        sequence, config = _native.decode_liquidation_config(_payload(value))
    except ValueError as err:
        raise CodecError("invalid liquidation configuration") from err
    threshold = FullCloseThreshold(**config["full_close_threshold"])
    return LiquidationConfigInfo(sequence, LiquidationConfig(
        **(config | {"full_close_threshold": threshold}),
    ))
