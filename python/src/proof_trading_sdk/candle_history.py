"""Lossless models for the indexer's JSON candle history (not proof-wire reads)."""

from __future__ import annotations

import re
import typing as t
from dataclasses import dataclass
from datetime import datetime

from proof_trading_sdk.errors import CodecError

CandleHistoryTime: t.TypeAlias = str | int

_RESOLUTION = re.compile(r"[1-9][0-9]{0,3}[mhdwMy]")
_DECIMAL = re.compile(r"[0-9]+(?:\.[0-9]+)?")
_TIME = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}"
    r"(?:\.([0-9]{1,9}))?(?:Z|[+-][0-9]{2}:[0-9]{2})"
)


@dataclass(frozen=True)
class HistoryCandle:
    """One bar; decimal strings and RFC3339 timestamps retain their precision."""

    time: str
    open: str
    high: str
    low: str
    close: str
    volume: str
    quote_volume: str
    trades: int


@dataclass(frozen=True)
class CandleHistoryPage:
    market: int
    resolution: str
    from_: str
    to: str
    candles: list[HistoryCandle]
    has_more: bool
    earliest: str | None


def _time(value: t.Any) -> tuple[datetime, int]:
    match = _TIME.fullmatch(value) if isinstance(value, str) else None
    if match is None:
        raise ValueError("expected an RFC3339 timestamp")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    # Compare every nanosecond; datetime alone truncates after six digits.
    return parsed.replace(microsecond=0), int((match[1] or "").ljust(9, "0"))


def candle_history_params(
    market: int, resolution: str, from_: CandleHistoryTime | None,
    to: CandleHistoryTime | None, limit: int,
) -> dict[str, str]:
    if isinstance(market, bool) or not isinstance(market, int) or not 0 <= market < 2**31:
        raise ValueError("candle market must be an integer in 0..2147483647")
    if not isinstance(resolution, str) or not _RESOLUTION.fullmatch(resolution):
        raise ValueError("candle resolution must be 1..9999 followed by m, h, d, w, M or y")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 5000:
        raise ValueError("candle limit must be an integer in 1..5000")
    params = {"market": str(market), "resolution": resolution, "limit": str(limit)}
    for name, value in (("from", from_), ("to", to)):
        if value is None:
            continue
        if isinstance(value, int) and not isinstance(value, bool) and -(2**63) <= value < 2**63:
            params[name] = str(value)
        elif isinstance(value, str):
            _time(value)
            params[name] = value
        else:
            raise ValueError(f"candle {name} must be RFC3339 or integer epoch milliseconds")
    return params


def decode_candle_history(
    value: t.Any, *, market: int, resolution: str, limit: int,
) -> CandleHistoryPage:
    """Validate the indexer envelope and request identity without numeric coercion."""
    try:
        if not isinstance(value, dict):
            raise ValueError("expected an object")
        if type(value["market"]) is not int or value["market"] != market:
            raise ValueError("market does not match request")
        if value["resolution"] != resolution:
            raise ValueError("resolution does not match request")
        start, end = _time(value["from"]), _time(value["to"])
        if start >= end:
            raise ValueError("invalid effective window")
        if type(value["has_more"]) is not bool:
            raise ValueError("has_more must be a boolean")
        if value["earliest"] is not None:
            _time(value["earliest"])
        rows = value["candles"]
        if not isinstance(rows, list) or len(rows) > limit:
            raise ValueError("candles must be an array within the requested limit")
        candles: list[HistoryCandle] = []
        previous = None
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError("candle must be an object")
            timestamp = _time(row["t"])
            if previous is not None and timestamp <= previous:
                raise ValueError("candles must be strictly oldest first")
            previous = timestamp
            for field in ("o", "h", "l", "c", "v", "quote_v"):
                if not isinstance(row[field], str) or not _DECIMAL.fullmatch(row[field]):
                    raise ValueError(f"{field} must be a nonnegative decimal string")
            if type(row["trades"]) is not int or not 0 <= row["trades"] < 2**63:
                raise ValueError("trades must be a nonnegative int64")
            candles.append(HistoryCandle(
                time=row["t"], open=row["o"], high=row["h"], low=row["l"],
                close=row["c"], volume=row["v"], quote_volume=row["quote_v"],
                trades=row["trades"],
            ))
        return CandleHistoryPage(
            market=market, resolution=resolution, from_=value["from"], to=value["to"],
            candles=candles, has_more=value["has_more"], earliest=value["earliest"],
        )
    except (KeyError, TypeError, ValueError, OverflowError) as exc:
        raise CodecError("invalid candle history response") from exc
