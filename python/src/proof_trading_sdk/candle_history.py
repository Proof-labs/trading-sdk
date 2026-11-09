"""Lossless models for the indexer's JSON candle history (not proof-wire reads)."""

from __future__ import annotations

import re
import typing as t
from dataclasses import dataclass

from proof_trading_sdk.errors import CodecError

CandleHistoryTime: t.TypeAlias = str | int

_RESOLUTION = re.compile(r"[1-9][0-9]{0,3}[mhdwMy]")
_DECIMAL = re.compile(r"[0-9]+(?:\.[0-9]+)?")
_TIME = re.compile(
    r"(?P<year>[+-]?[0-9]{4,})-(?P<month>[0-9]{2})-(?P<day>[0-9]{2})"
    r"T(?P<hour>[0-9]{2}):(?P<minute>[0-9]{2}):(?P<second>[0-9]{2})"
    r"(?:\.(?P<fraction>[0-9]{1,9}))?(?P<offset>Z|[+-][0-9]{2}:[0-9]{2})"
)


@dataclass(frozen=True)
class HistoryCandle:
    """One bar; decimal strings and server timestamps retain their precision."""

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


def _time(value: t.Any) -> tuple[int, int]:
    """UTC seconds and nanoseconds, including the server's extended years."""
    match = _TIME.fullmatch(value) if isinstance(value, str) else None
    if match is None:
        raise ValueError("expected a timestamp with a UTC offset")
    year, month, day, hour, minute, second = (
        int(match[name]) for name in ("year", "month", "day", "hour", "minute", "second")
    )
    leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
    month_days = (31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
    if not (1 <= month <= 12 and 1 <= day <= month_days[month - 1]):
        raise ValueError("invalid calendar date")
    if not (0 <= hour < 24 and 0 <= minute < 60 and 0 <= second <= 60):
        raise ValueError("invalid clock time")
    offset = match["offset"]
    offset_seconds = 0
    if offset != "Z":
        offset_hour, offset_minute = int(offset[1:3]), int(offset[4:6])
        if offset_hour >= 24 or offset_minute >= 60:
            raise ValueError("invalid UTC offset")
        offset_seconds = (offset_hour * 60 + offset_minute) * 60
        if offset[0] == "-":
            offset_seconds = -offset_seconds
    # Proleptic Gregorian days since 1970-01-01. Floor division also handles
    # year zero and negative years; datetime is limited to years 1..9999.
    year -= month <= 2
    era, year_of_era = divmod(year, 400)
    day_of_year = (153 * (month - 3 if month > 2 else month + 9) + 2) // 5 + day - 1
    day_of_era = year_of_era * 365 + year_of_era // 4 - year_of_era // 100 + day_of_year
    days = era * 146097 + day_of_era - 719468
    seconds = days * 86400 + hour * 3600 + minute * 60 + min(second, 59) - offset_seconds
    # A leap second sorts after :59 and before the next minute. Keep it in
    # the nanosecond component rather than equating it with the next minute.
    nanos = int((match["fraction"] or "").ljust(9, "0")) + (1_000_000_000 if second == 60 else 0)
    return seconds, nanos


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
            # The server can emit extended years but its RFC3339 query
            # parser only accepts unsigned four-digit years.
            if not (value[:4].isdigit() and value[4:5] == "-"):
                raise ValueError(f"candle {name} must be RFC3339 or integer epoch milliseconds")
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
