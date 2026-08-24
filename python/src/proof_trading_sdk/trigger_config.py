"""Strict read models for the governed stop-loss/take-profit market policy."""

from __future__ import annotations

import typing as t
from dataclasses import dataclass

from proof_trading_sdk.errors import ProofTradingSdkError

_U64_MAX = (1 << 64) - 1
_U32_MAX = (1 << 32) - 1
_MAX_TRIGGER_SLIPPAGE_BPS = 9_999


@dataclass(frozen=True)
class TriggerMarketConfig:
    version: int
    enabled: bool
    max_trigger_slippage_bps: int
    max_mark_age_ms: int
    max_future_publish_skew_ms: int
    max_active_brackets: int


@dataclass(frozen=True)
class PendingTriggerMarketConfig:
    config: TriggerMarketConfig
    accepted_height: int
    effective_height: int


@dataclass(frozen=True)
class TriggerMarketConfigState:
    current: TriggerMarketConfig | None
    pending: PendingTriggerMarketConfig | None


@dataclass(frozen=True)
class TriggerMarketConfigInfo:
    market: int
    state: TriggerMarketConfigState


def _error(message: str) -> ProofTradingSdkError:
    return ProofTradingSdkError(f"trigger decode: {message}")


def _tuple(value: t.Any, name: str, size: int) -> t.Sequence[t.Any]:
    if not isinstance(value, (list, tuple)) or len(value) != size:
        raise _error(f"{name} must be exactly a {size}-field tuple")
    return value


def _uint(value: t.Any, name: str, maximum: int = _U64_MAX) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > maximum
    ):
        raise _error(f"{name} is not an exact unsigned integer")
    return value


def _decode_config(value: t.Any) -> TriggerMarketConfig | None:
    if value is None:
        return None
    row = _tuple(value, "TriggerMarketConfig", 6)
    version = _uint(row[0], "config.version")
    if version == 0:
        raise _error("config version is zero")
    if not isinstance(row[1], bool):
        raise _error("config.enabled is not boolean")
    max_slippage = _uint(
        row[2], "config.max_trigger_slippage_bps", _U32_MAX
    )
    if max_slippage > _MAX_TRIGGER_SLIPPAGE_BPS:
        raise _error("config slippage exceeds 9999")
    config = TriggerMarketConfig(
        version=version,
        enabled=row[1],
        max_trigger_slippage_bps=max_slippage,
        max_mark_age_ms=_uint(row[3], "config.max_mark_age_ms"),
        max_future_publish_skew_ms=_uint(
            row[4], "config.max_future_publish_skew_ms"
        ),
        max_active_brackets=_uint(row[5], "config.max_active_brackets"),
    )
    if config.enabled and (
        config.max_trigger_slippage_bps == 0
        or config.max_mark_age_ms == 0
        or config.max_future_publish_skew_ms == 0
        or config.max_active_brackets == 0
    ):
        raise _error("enabled config has a zero bound")
    return config


def _decode_state(value: t.Any) -> TriggerMarketConfigState:
    row = _tuple(value, "TriggerMarketConfigState", 2)
    current = _decode_config(row[0])
    pending = None
    if row[1] is not None:
        pending_row = _tuple(row[1], "PendingTriggerMarketConfig", 3)
        config = _decode_config(pending_row[0])
        if config is None:
            raise _error("pending config is null")
        accepted_height = _uint(pending_row[1], "pending.accepted_height")
        effective_height = _uint(pending_row[2], "pending.effective_height")
        if (
            accepted_height == 0
            or accepted_height == _U64_MAX
            or effective_height != accepted_height + 1
        ):
            raise _error("invalid pending effective height")
        expected_version = 1 if current is None else current.version + 1
        if config.version != expected_version:
            raise _error("pending config version is not next")
        pending = PendingTriggerMarketConfig(
            config=config,
            accepted_height=accepted_height,
            effective_height=effective_height,
        )
    if current is None and pending is None:
        raise _error("empty trigger market config state")
    return TriggerMarketConfigState(current=current, pending=pending)


def decode_trigger_market_config_infos(value: t.Any) -> list[TriggerMarketConfigInfo]:
    """Decode the engine's strict, ascending market-policy registry."""

    if not isinstance(value, (list, tuple)):
        raise _error("market configs response is not an array")
    result: list[TriggerMarketConfigInfo] = []
    previous_market = -1
    for entry in value:
        row = _tuple(entry, "TriggerMarketConfigInfo", 2)
        market = _uint(row[0], "market", _U32_MAX)
        if market <= previous_market:
            raise _error("market configs are not strictly market-sorted")
        previous_market = market
        result.append(TriggerMarketConfigInfo(market, _decode_state(row[1])))
    return result


__all__ = [
    "TriggerMarketConfig",
    "PendingTriggerMarketConfig",
    "TriggerMarketConfigState",
    "TriggerMarketConfigInfo",
    "decode_trigger_market_config_infos",
]
