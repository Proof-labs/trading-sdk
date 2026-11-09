"""Operational feeder observations, never a trading authorization verdict."""
from __future__ import annotations

from dataclasses import dataclass, field
import math
import re
import typing as t

from proof_trading_sdk.errors import CodecError


@dataclass(frozen=True)
class OracleMarketHealth:
    market: int
    status: str | None
    stale_seconds: float | int | None
    extra: dict[str, t.Any] = field(default_factory=dict)


@dataclass(frozen=True)
class OracleHealth:
    status: str | None
    embedded_feeder: bool | None
    source: str | None
    ready: bool | None
    submit_enabled: bool | None
    note: str | None
    error: str | None
    updated_at_unix_ms: int | None
    markets: dict[int, OracleMarketHealth] | None
    journal_healthy: dict[str, bool] | None
    divergence_bps: dict[int, int] | None
    extra: dict[str, t.Any] = field(default_factory=dict)


def _fail(field: str) -> t.NoReturn:
    raise CodecError(f"invalid oracle health: {field}")


def oracle_health_market(market: int | None) -> int | None:
    if market is not None and (type(market) is not int or not 1 <= market <= 0xffff_ffff):
        raise ValueError("oracle health market must be an integer in 1..4294967295")
    return market


def _optional(raw: dict, name: str, kind: type) -> t.Any:
    if name not in raw: return None
    value = raw[name]
    if type(value) is not kind: _fail(name)
    return value


def _market_key(key: t.Any) -> int:
    if not isinstance(key, str) or re.fullmatch(r"(?:0|[1-9][0-9]{0,9})", key) is None:
        _fail("market key")
    value = int(key)
    if value > 0xffff_ffff: _fail("market key")
    return value


def decode_oracle_health(value: t.Any) -> OracleHealth:
    """Decode node-disabled, F16 relay, and gateway market-freshness shapes.

    Absent fields stay None. Unknown diagnostics are preserved in ``extra``;
    the caller decides freshness thresholds and action permissions separately.
    """
    if not isinstance(value, dict): _fail("object")
    status = _optional(value, "status", str)
    embedded = _optional(value, "embedded_feeder", bool)
    source = _optional(value, "source", str)
    ready = _optional(value, "ready", bool)
    submit = _optional(value, "submit_enabled", bool)
    if source == "f16-relay":
        if ready is None or submit is None: _fail("F16 readiness fields")
    elif embedded is None or status is None:
        _fail("unrecognized feeder response")
    if status == "": _fail("status")
    updated = _optional(value, "updated_at_unix_ms", int)
    if updated is not None and not 0 <= updated <= (1 << 64)-1: _fail("updated_at_unix_ms")
    markets = None
    if "markets" in value:
        rows = value["markets"]
        if not isinstance(rows, dict): _fail("markets")
        markets = {}
        for key, raw in rows.items():
            market = _market_key(key)
            if not isinstance(raw, dict) or type(raw.get("market")) is not int or raw["market"] != market:
                _fail("market binding")
            row_status = _optional(raw, "status", str)
            stale = raw.get("stale_seconds")
            if stale is not None and (type(stale) not in (int, float) or stale < 0 or stale > 1.7976931348623157e308 or (type(stale) is float and not math.isfinite(stale))):
                _fail("stale_seconds")
            markets[market] = OracleMarketHealth(market, row_status, stale,
                {k: v for k, v in raw.items() if k not in {"market", "status", "stale_seconds"}})
    journal = None
    if "journal_healthy" in value:
        raw = value["journal_healthy"]
        if not isinstance(raw, dict) or any(not isinstance(k, str) or type(v) is not bool for k, v in raw.items()):
            _fail("journal_healthy")
        journal = dict(raw)
    divergence = None
    if "divergence_bps" in value:
        raw = value["divergence_bps"]
        if not isinstance(raw, dict): _fail("divergence_bps")
        divergence = {}
        for key, v in raw.items():
            market = _market_key(key)
            if type(v) is not int or not 0 <= v <= (1 << 64)-1: _fail("divergence_bps")
            divergence[market] = v
    known = {"status", "embedded_feeder", "source", "ready", "submit_enabled", "note", "error", "updated_at_unix_ms", "markets", "journal_healthy", "divergence_bps"}
    return OracleHealth(status, embedded, source, ready, submit,
        _optional(value, "note", str), _optional(value, "error", str), updated,
        markets, journal, divergence, {k:v for k,v in value.items() if k not in known})
