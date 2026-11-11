"""Exact indexed market statistics; unavailable values remain absent."""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
import re
import typing as t

from proof_trading_sdk.errors import CodecError
from proof_trading_sdk.candle_history import _time

MarketStatsStatus = t.Literal["ready", "stale", "unavailable"]
_UNSIGNED = re.compile(r"(?:0|[1-9][0-9]*)")
_USDC = re.compile(r"(?:0|[1-9][0-9]*)(?:\.[0-9]{1,24})?")
_BPS = re.compile(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?")


@dataclass(frozen=True)
class MarketStatsOpenInterest:
    long_contracts: str
    short_contracts: str


@dataclass(frozen=True)
class MarketStats:
    market: int
    sz_decimals: int | None
    status: MarketStatsStatus
    unavailable_reason: str | None
    volume_24h_contracts: str | None
    volume_24h_usdc: str | None
    reference_price: str | None
    last_price: str | None
    change_24h_bps: str | None
    high_price: str | None
    low_price: str | None
    open_interest: MarketStatsOpenInterest | None
    open_interest_unavailable_reason: str | None


@dataclass(frozen=True)
class MarketStatsResponse:
    as_of: str
    window_start: str
    window_end: str
    indexed_height: str | None
    indexed_at: str | None
    stale_after_seconds: int
    status: MarketStatsStatus
    markets: list[MarketStats]


def _fail(field: str) -> t.NoReturn:
    raise CodecError(f"invalid market statistics: {field}")


def _object(value: t.Any) -> dict:
    if not isinstance(value, dict): _fail("object")
    return value


def _integer(value: t.Any, minimum: int, maximum: int, field: str) -> int:
    if type(value) is float and value.is_integer() and abs(value) <= (1 << 53)-1:
        value = int(value)
    if type(value) is not int or not minimum <= value <= maximum: _fail(field)
    return value


def market_stats_markets(markets: t.Sequence[int]) -> str:
    if isinstance(markets, (str, bytes, bytearray)) or not isinstance(markets, Sequence):
        raise ValueError("market statistics markets must be a non-string sequence")
    if not 1 <= len(markets) <= 50:
        raise ValueError("market statistics requires 1–50 markets")
    markets = tuple(markets)
    if any(type(m) is not int or not 0 <= m <= 0x7fff_ffff for m in markets):
        raise ValueError("market statistics market must be an integer in 0..2147483647")
    if len(set(markets)) != len(markets): raise ValueError("duplicate market statistics market")
    return ",".join(map(str, markets))


def _status(value: t.Any) -> MarketStatsStatus:
    if value not in ("ready", "stale", "unavailable"): _fail("status")
    return value


def _reason(value: t.Any, field: str) -> str | None:
    if value is not None and not isinstance(value, str): _fail(field)
    return value


def _decimal(value: t.Any, field: str, pattern: re.Pattern = _UNSIGNED) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None: _fail(field)
    return value


def _nullable(value: t.Any, field: str, pattern: re.Pattern = _UNSIGNED) -> str | None:
    return None if value is None else _decimal(value, field, pattern)


def _timestamp(value: t.Any, field: str) -> int:
    """Validate through the shared calendar parser, retaining millisecond comparison."""
    try:
        seconds, nanos = _time(value)
    except (ValueError, TypeError):
        _fail(field)
    return seconds * 1000 + nanos // 1_000_000


def decode_market_stats_response(value: t.Any) -> MarketStatsResponse:
    body = _object(value)
    try:
        as_of, start, end = body["as_of"], body["window_start"], body["window_end"]
        if _timestamp(as_of, "as_of") != _timestamp(end, "window_end") or _timestamp(end, "window_end") - _timestamp(start, "window_start") != 86400000:
            _fail("rolling 24-hour window")
        height = _nullable(body["indexed_height"], "indexed_height", re.compile(r"[1-9][0-9]*"))
        indexed = body["indexed_at"]
        if indexed is not None: _timestamp(indexed, "indexed_at")
        if (height is None) != (indexed is None): _fail("indexed frontier")
        stale = _integer(body["stale_after_seconds"], 1, (1 << 53)-1, "stale_after_seconds")
        rows = body["markets"]
        if not isinstance(rows, list) or not 1 <= len(rows) <= 50: _fail("markets")
        markets = []
        for raw in rows:
            row = _object(raw)
            market = _integer(row["market"], 0, 0x7fff_ffff, "market")
            sz = row["sz_decimals"]
            if sz is not None: sz = _integer(sz, 0, 18, "sz_decimals")
            oi = row["open_interest"]
            if oi is not None:
                oi = _object(oi)
                oi = MarketStatsOpenInterest(_decimal(oi["long_contracts"], "long_contracts"), _decimal(oi["short_contracts"], "short_contracts"))
            markets.append(MarketStats(
                market, sz, _status(row["status"]), _reason(row["unavailable_reason"], "unavailable_reason"),
                _nullable(row["volume_24h_contracts"], "volume_24h_contracts"),
                _nullable(row["volume_24h_usdc"], "volume_24h_usdc", _USDC),
                _nullable(row["reference_price"], "reference_price"), _nullable(row["last_price"], "last_price"),
                _nullable(row["change_24h_bps"], "change_24h_bps", _BPS),
                _nullable(row["high_price"], "high_price"), _nullable(row["low_price"], "low_price"), oi,
                _reason(row["open_interest_unavailable_reason"], "open_interest_unavailable_reason"),
            ))
        if len({row.market for row in markets}) != len(markets): _fail("duplicate market")
        return MarketStatsResponse(as_of, start, end, height, indexed, stale, _status(body["status"]), markets)
    except KeyError as err:
        _fail(str(err))
