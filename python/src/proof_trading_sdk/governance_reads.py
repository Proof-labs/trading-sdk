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
    """The live authority sets. The engine's retired composite-feeder and
    scheduled-operations slots are decoded and dropped."""

    relayer: list[bytes]
    oracle: list[bytes]
    custody: list[bytes]
    market_params: list[bytes]


@dataclass(frozen=True)
class FullCloseThreshold:
    numerator: int
    denominator: int


@dataclass(frozen=True)
class FundLimits:
    """A pool insurance fund's gross notional limits, in basis points of its equity."""

    gross_bps: int
    market_bps: int


@dataclass(frozen=True)
class LiquidationConfig:
    target_ratio_bps: int
    full_close_threshold: FullCloseThreshold
    partial_penalty_bps: int
    # Retained wire fields; the engine no longer applies these pacing caps.
    max_book_orders: int
    max_committed_fills: int
    takeover_discount_bps: int
    fund_limits: FundLimits


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
    return AuthoritiesSnapshot(
        relayer=raw["relayer"],
        oracle=raw["oracle"],
        custody=raw["custody"],
        market_params=raw["market_params"],
    )


def decode_liquidation_config_info(value: t.Any) -> LiquidationConfigInfo:
    """Decode the stored sequence/config pair.

    A config written before a trailing field existed takes its initial value:
    takeover discount 50, fund limits 10,000 over all markets and 5,000 on one.
    """
    try:
        sequence, config = _native.decode_liquidation_config(_payload(value))
    except ValueError as err:
        raise CodecError("invalid liquidation configuration") from err
    threshold = FullCloseThreshold(**config["full_close_threshold"])
    fund_limits = FundLimits(**config["fund_limits"])
    return LiquidationConfigInfo(sequence, LiquidationConfig(
        **(config | {"full_close_threshold": threshold, "fund_limits": fund_limits}),
    ))
