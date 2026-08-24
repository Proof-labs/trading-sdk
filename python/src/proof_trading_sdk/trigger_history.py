"""Strict, lossless models for immutable trigger lifecycle history."""

from __future__ import annotations

import re
import typing as t
from dataclasses import dataclass
from datetime import datetime

from proof_trading_sdk.errors import ProofTradingSdkError

PositionTriggerHistoryEventType: t.TypeAlias = t.Literal[
    "position_triggers_set",
    "position_triggers_cancelled",
    "position_triggers_invalidated",
    "position_trigger_activated",
    "position_trigger_executed",
    "position_trigger_deferred",
]
TriggerMarketHistoryEventType: t.TypeAlias = t.Literal[
    "trigger_market_deferred",
    "trigger_market_resumed",
]
TriggerHistoryEventType: t.TypeAlias = (
    PositionTriggerHistoryEventType | TriggerMarketHistoryEventType
)
TriggerHistoryTime: t.TypeAlias = str | int

_EventTypeT = t.TypeVar("_EventTypeT", bound=str)


@dataclass(frozen=True)
class TriggerHistoryEvent(t.Generic[_EventTypeT]):
    """One immutable lifecycle event; protocol numbers remain strings."""

    event_key: str
    block_height: str
    execution_ordinal: str
    event_ordinal: str
    block_time: str
    event_type: _EventTypeT
    owner: str | None
    market: str
    payload: dict[str, str]


@dataclass(frozen=True)
class PositionTriggerHistoryPage:
    trigger_events: list[TriggerHistoryEvent[PositionTriggerHistoryEventType]]
    next_cursor: str


@dataclass(frozen=True)
class TriggerMarketHistoryPage:
    trigger_market_events: list[TriggerHistoryEvent[TriggerMarketHistoryEventType]]
    next_cursor: str


_U64_MAX = (1 << 64) - 1
_U32_MAX = (1 << 32) - 1
_I64_MIN = -(1 << 63)
_I64_MAX = (1 << 63) - 1
_I32_MAX = (1 << 31) - 1

_OWNER_TYPES = {
    "position_triggers_set",
    "position_triggers_cancelled",
    "position_triggers_invalidated",
    "position_trigger_activated",
    "position_trigger_executed",
    "position_trigger_deferred",
}
_MARKET_TYPES = {"trigger_market_deferred", "trigger_market_resumed"}
_REASONS = {
    "position_closed",
    "position_epoch_changed",
    "position_side_changed",
    "below_maintenance",
    "indeterminate_account",
    "market_disabled",
    "mark_unavailable",
    "mark_stale",
    "mark_future_dated",
    "no_eligible_liquidity",
    "self_trade_prevention",
    "work_limit_reached",
    "execution_rejected",
}
_RESULTS = {
    "filled",
    "partial",
    "no_fill",
    "rejected",
    "invalidated",
}
_EXECUTION_STOP_REASONS = {
    "no_eligible_liquidity",
    "self_trade_prevention",
    "work_limit_reached",
}
_POSITION_INVALIDATION_REASONS = {
    "position_closed",
    "position_epoch_changed",
    "position_side_changed",
}
_ACCOUNT_DEFERRED_REASONS = {"below_maintenance", "indeterminate_account"}
_MARKET_DEFERRED_REASONS = {
    "market_disabled",
    "mark_unavailable",
    "mark_stale",
    "mark_future_dated",
}
_LIMB_KINDS = {"stop_loss", "take_profit"}
_EVENT_KEYS = {
    "event_key",
    "block_height",
    "execution_ordinal",
    "event_ordinal",
    "block_time",
    "event_type",
    "owner",
    "market",
    "payload",
}
_UINT_RE = re.compile(r"^(?:0|[1-9][0-9]*)$")
_INT_RE = re.compile(r"^(?:0|-?[1-9][0-9]*)$")
_OWNER_RE = re.compile(r"^[0-9a-f]{40}$")
_RFC3339_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$"
)


def canonical_owner(value: bytes | str) -> str:
    if isinstance(value, bytes):
        if len(value) != 20:
            raise ValueError("trigger history owner must be exactly 20 bytes")
        text = value.hex()
    elif isinstance(value, str):
        text = value.removeprefix("0x").lower()
    else:
        raise ValueError("trigger history owner must be bytes or hex")
    if not _OWNER_RE.fullmatch(text):
        raise ValueError("trigger history owner must be a 40-character hex address")
    return text


def validate_market(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= _I32_MAX:
        raise ValueError(f"trigger history market must be an integer in 0..={_I32_MAX}")
    return value


def history_params(
    *,
    from_: TriggerHistoryTime | None = None,
    to: TriggerHistoryTime | None = None,
    limit: int | None = None,
    cursor: str | None = None,
    market: int | None = None,
) -> dict[str, str]:
    params: dict[str, str] = {}
    if from_ is not None:
        params["from"] = _filter_time(from_, "from")
    if to is not None:
        params["to"] = _filter_time(to, "to")
    if limit is not None:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 1_000:
            raise ValueError("trigger history limit must be an integer in 1..=1000")
        params["limit"] = str(limit)
    if cursor is not None:
        if not isinstance(cursor, str) or not cursor:
            raise ValueError("trigger history cursor must be a non-empty opaque string")
        params["cursor"] = cursor
    if market is not None:
        params["market"] = str(validate_market(market))
    return params


def decode_position_trigger_history_page(
    value: t.Any,
    expected_owner: str,
    expected_market: int | None = None,
) -> PositionTriggerHistoryPage:
    owner = canonical_owner(expected_owner)
    market = None if expected_market is None else str(validate_market(expected_market))
    row = _object(value, "owner page")
    _exact_keys(row, {"trigger_events", "next_cursor"}, "owner page")
    events_raw = row["trigger_events"]
    if not isinstance(events_raw, list):
        raise _error("trigger_events must be an array")
    events = [
        t.cast(
            TriggerHistoryEvent[PositionTriggerHistoryEventType],
            _decode_event(item, owner, market, "owner"),
        )
        for item in events_raw
    ]
    _newest_first(events)
    return PositionTriggerHistoryPage(
        trigger_events=events,
        next_cursor=_string(row["next_cursor"], "next_cursor", nonempty=False),
    )


def decode_trigger_market_history_page(
    value: t.Any,
    expected_market: int,
) -> TriggerMarketHistoryPage:
    market = str(validate_market(expected_market))
    row = _object(value, "market page")
    _exact_keys(row, {"trigger_market_events", "next_cursor"}, "market page")
    events_raw = row["trigger_market_events"]
    if not isinstance(events_raw, list):
        raise _error("trigger_market_events must be an array")
    events = [
        t.cast(
            TriggerHistoryEvent[TriggerMarketHistoryEventType],
            _decode_event(item, None, market, "market"),
        )
        for item in events_raw
    ]
    _newest_first(events)
    return TriggerMarketHistoryPage(
        trigger_market_events=events,
        next_cursor=_string(row["next_cursor"], "next_cursor", nonempty=False),
    )


def _error(message: str) -> ProofTradingSdkError:
    return ProofTradingSdkError(f"trigger history decode: {message}")


def _object(value: t.Any, name: str) -> dict[str, t.Any]:
    if not isinstance(value, dict):
        raise _error(f"{name} must be an object")
    if not all(isinstance(key, str) for key in value):
        raise _error(f"{name} contains a non-string key")
    return t.cast(dict[str, t.Any], value)


def _exact_keys(row: dict[str, t.Any], expected: set[str], name: str) -> None:
    if set(row) != expected:
        raise _error(f"{name} has unexpected or missing fields")


def _string(value: t.Any, name: str, *, nonempty: bool = True) -> str:
    if not isinstance(value, str) or (nonempty and not value):
        raise _error(f"{name} must be a string")
    return value


def _unsigned(
    value: t.Any,
    name: str,
    maximum: int = _U64_MAX,
    *,
    nonzero: bool = False,
) -> str:
    text = _string(value, name)
    if not _UINT_RE.fullmatch(text):
        raise _error(f"{name} is not canonical unsigned decimal")
    parsed = int(text)
    if parsed > maximum or (nonzero and parsed == 0):
        raise _error(f"{name} is out of range")
    return text


def _signed_i64(value: t.Any, name: str) -> str:
    text = _string(value, name)
    if not _INT_RE.fullmatch(text) or not _I64_MIN <= int(text) <= _I64_MAX:
        raise _error(f"{name} is not canonical i64 decimal")
    return text


def _rfc3339(value: t.Any, name: str) -> str:
    text = _string(value, name)
    if not _RFC3339_RE.fullmatch(text):
        raise _error(f"{name} is not RFC3339")
    try:
        datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise _error(f"{name} is not RFC3339") from exc
    return text


def _enum(value: t.Any, allowed: set[str], name: str, *, empty: bool = False) -> str:
    text = _string(value, name, nonempty=not empty)
    if text not in allowed and not (empty and text == ""):
        raise _error(f"unknown {name} {text}")
    return text


def _payload(value: t.Any) -> dict[str, str]:
    row = _object(value, "payload")
    if not all(isinstance(item, str) for item in row.values()):
        raise _error("every payload value must remain a string")
    return t.cast(dict[str, str], row)


def _response_owner(value: t.Any, name: str) -> str:
    try:
        return canonical_owner(value)
    except ValueError as exc:
        raise _error(f"{name} is not a canonical owner") from exc


def _require_unsigned(payload: dict[str, str], keys: t.Iterable[str]) -> None:
    for key in keys:
        _unsigned(payload.get(key), f"payload.{key}")


def _validate_payload(
    payload: dict[str, str],
    event_type: str,
    event_key: str,
    block_height: str,
    execution_ordinal: str,
    event_ordinal: str,
    market: str,
    event_owner: str | None,
) -> None:
    _unsigned(payload.get("block_height"), "payload.block_height", nonzero=True)
    _unsigned(payload.get("execution_ordinal"), "payload.execution_ordinal")
    _unsigned(payload.get("event_ordinal"), "payload.event_ordinal", _U32_MAX)
    _unsigned(payload.get("market"), "payload.market", _I32_MAX)
    if (
        payload.get("event_key") != event_key
        or payload.get("block_height") != block_height
        or payload.get("execution_ordinal") != execution_ordinal
        or payload.get("event_ordinal") != event_ordinal
        or payload.get("market") != market
    ):
        raise _error("payload identity disagrees with event")

    if event_type in _OWNER_TYPES:
        if (
            event_owner is None
            or _response_owner(payload.get("owner"), "payload.owner") != event_owner
        ):
            raise _error("payload owner disagrees with event")
        _require_unsigned(payload, ("position_epoch", "group_id"))
    elif "owner" in payload:
        raise _error("shared market payload carries owner")

    if event_type == "position_triggers_set":
        _require_unsigned(
            payload,
            (
                "client_group_id",
                "stop_limb_id",
                "stop_client_trigger_id",
                "take_profit_limb_id",
                "take_profit_client_trigger_id",
                "accepted_height",
                "active_from_height",
                "replaced_group_id",
            ),
        )
        if int(payload["active_from_height"]) != int(payload["accepted_height"]) + 1:
            raise _error("invalid active_from_height")
        if payload["stop_limb_id"] == "0" and payload["take_profit_limb_id"] == "0":
            raise _error("set event has no trigger limbs")
    elif event_type in {"position_triggers_cancelled", "position_triggers_invalidated"}:
        pass
    elif event_type == "position_trigger_activated":
        _require_unsigned(
            payload,
            (
                "limb_id",
                "client_group_id",
                "client_trigger_id",
                "trigger_price",
                "frozen_mark",
                "limit_price",
                "requested_quantity",
                "execution_order_id",
            ),
        )
        _enum(payload.get("limb_kind"), _LIMB_KINDS, "payload.limb_kind")
    elif event_type == "position_trigger_executed":
        _require_unsigned(
            payload,
            (
                "limb_id",
                "client_group_id",
                "client_trigger_id",
                "trigger_price",
                "frozen_mark",
                "limit_price",
                "requested_quantity",
                "filled_quantity",
                "residual_quantity",
                "execution_order_id",
            ),
        )
        _enum(payload.get("limb_kind"), _LIMB_KINDS, "payload.limb_kind")
        _enum(payload.get("result"), _RESULTS, "payload.result")
        _signed_i64(payload.get("total_fee"), "payload.total_fee")
        _enum(payload.get("reason"), _REASONS, "payload.reason", empty=True)
        if int(payload["filled_quantity"]) + int(payload["residual_quantity"]) != int(
            payload["requested_quantity"]
        ):
            raise _error("executed quantities do not conserve")
        requested = int(payload["requested_quantity"])
        filled = int(payload["filled_quantity"])
        residual = int(payload["residual_quantity"])
        result = payload["result"]
        reason = payload["reason"]
        valid = (
            result == "filled"
            and filled == requested
            and residual == 0
            and reason == ""
        ) or (
            result == "partial"
            and filled > 0
            and residual > 0
            and reason in _EXECUTION_STOP_REASONS
        ) or (
            result == "no_fill"
            and filled == 0
            and residual > 0
            and reason in _EXECUTION_STOP_REASONS
        ) or (
            result == "rejected"
            and filled == 0
            and residual > 0
            and reason == "execution_rejected"
        ) or (
            result == "invalidated"
            and filled == 0
            and residual > 0
            and reason in _POSITION_INVALIDATION_REASONS
        )
        if not valid:
            raise _error("result, quantities, and reason disagree")
    elif event_type == "position_trigger_deferred":
        _require_unsigned(
            payload,
            (
                "limb_id",
                "client_group_id",
                "client_trigger_id",
                "trigger_price",
                "frozen_mark",
                "requested_quantity",
            ),
        )
        _enum(payload.get("limb_kind"), _LIMB_KINDS, "payload.limb_kind")
        _enum(payload.get("reason"), _ACCOUNT_DEFERRED_REASONS, "payload.reason")
    elif event_type == "trigger_market_deferred":
        _enum(payload.get("reason"), _MARKET_DEFERRED_REASONS, "payload.reason")
    elif event_type == "trigger_market_resumed":
        _enum(
            payload.get("previous_reason"),
            _MARKET_DEFERRED_REASONS,
            "payload.previous_reason",
        )


def _decode_event(
    value: t.Any,
    expected_owner: str | None,
    expected_market: str | None,
    scope: t.Literal["owner", "market"],
) -> TriggerHistoryEvent[str]:
    row = _object(value, "event")
    _exact_keys(row, _EVENT_KEYS, "event")
    event_key = _string(row["event_key"], "event_key")
    block_height = _unsigned(row["block_height"], "block_height", nonzero=True)
    execution_ordinal = _unsigned(row["execution_ordinal"], "execution_ordinal")
    event_ordinal = _unsigned(row["event_ordinal"], "event_ordinal", _U32_MAX)
    if event_key != f"{block_height}:{execution_ordinal}:{event_ordinal}":
        raise _error("event_key is not canonical")
    block_time = _rfc3339(row["block_time"], "block_time")
    event_type = _string(row["event_type"], "event_type")
    allowed = _OWNER_TYPES if scope == "owner" else _MARKET_TYPES
    if event_type not in allowed:
        raise _error(f"{event_type} is invalid for {scope} history")
    event_owner = (
        None if row["owner"] is None else _response_owner(row["owner"], "owner")
    )
    if (
        scope == "owner" and (event_owner is None or event_owner != expected_owner)
    ) or (scope == "market" and event_owner is not None):
        raise _error("owner does not match route scope")
    market = _unsigned(row["market"], "market", _I32_MAX)
    if expected_market is not None and market != expected_market:
        raise _error("market does not match route scope")
    payload = _payload(row["payload"])
    _validate_payload(
        payload,
        event_type,
        event_key,
        block_height,
        execution_ordinal,
        event_ordinal,
        market,
        event_owner,
    )
    return TriggerHistoryEvent(
        event_key=event_key,
        block_height=block_height,
        execution_ordinal=execution_ordinal,
        event_ordinal=event_ordinal,
        block_time=block_time,
        event_type=event_type,
        owner=event_owner,
        market=market,
        payload=payload,
    )


def _newest_first(events: t.Sequence[TriggerHistoryEvent[str]]) -> None:
    coordinates = [
        (int(event.block_height), int(event.execution_ordinal), int(event.event_ordinal))
        for event in events
    ]
    if any(previous <= current for previous, current in zip(coordinates, coordinates[1:])):
        raise _error("page is not strictly newest-first by chain coordinate")


def _filter_time(value: TriggerHistoryTime, name: str) -> str:
    if isinstance(value, bool):
        raise ValueError(f"trigger history {name} must be epoch milliseconds or RFC3339")
    if isinstance(value, int):
        if not _I64_MIN <= value <= _I64_MAX:
            raise ValueError(f"trigger history {name} epoch milliseconds are outside i64")
        return str(value)
    if not isinstance(value, str) or not value:
        raise ValueError(f"trigger history {name} must be epoch milliseconds or RFC3339")
    if _INT_RE.fullmatch(value):
        parsed = int(value)
        if not _I64_MIN <= parsed <= _I64_MAX:
            raise ValueError(f"trigger history {name} epoch milliseconds are outside i64")
        return value
    try:
        return _rfc3339(value, name)
    except ProofTradingSdkError as exc:
        raise ValueError(f"trigger history {name} must be epoch milliseconds or RFC3339") from exc


__all__ = [
    "PositionTriggerHistoryEventType",
    "TriggerMarketHistoryEventType",
    "TriggerHistoryEventType",
    "TriggerHistoryTime",
    "TriggerHistoryEvent",
    "PositionTriggerHistoryPage",
    "TriggerMarketHistoryPage",
    "canonical_owner",
    "validate_market",
    "history_params",
    "decode_position_trigger_history_page",
    "decode_trigger_market_history_page",
]
