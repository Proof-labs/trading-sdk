from __future__ import annotations

import json
import logging
import time
import typing as t
from dataclasses import dataclass, field

log = logging.getLogger("proof_trading_sdk")


@dataclass
class AccountEvent:
    event_id: int
    event_type: str
    data: dict[str, t.Any] = field(default_factory=dict)


# Acknowledgements the gateway sends for control messages; not data.
_ACK_TYPES = frozenset({"subscribed", "unsubscribed", "pong"})


# Live event family for a history row; mirrors api-gateway
# `account_ws_message_type`.
_FAMILIES = {
    "trade_executed": "fill",
    "order_placed": "order_update",
    "order_cancelled": "order_update",
    "order_amended": "order_update",
    "market_order_processed": "order_update",
    "position_updated": "position_update",
    "position_closed": "position_update",
    "funding_settled": "funding",
    "position_triggers_set": "trigger_update",
    "position_triggers_cancelled": "trigger_update",
    "position_triggers_invalidated": "trigger_update",
    "position_trigger_activated": "trigger_update",
    "position_trigger_executed": "trigger_update",
    "position_trigger_deferred": "trigger_update",
    "margin_warning": "margin_update",
}

# Settlement event names before the canonical vocabulary, mapped to the names
# history rows carry. A gateway that already sends the canonical names passes
# through unchanged.
_LEGACY_EVENT_TYPES = {
    "conditional_settled": "condition_met",
    "conditional_voided": "condition_not_met",
}


def _canonical_event_type(event_type: t.Any) -> str:
    name = str(event_type)
    return _LEGACY_EVENT_TYPES.get(name, name)


# (height, txHash, eventIndex, eventType): one account event's history key.
# A transaction hash can recur at different heights, so all four count.
EventKey = tuple[int, str, int, str]


@dataclass(frozen=True)
class RecoveryStatus:
    """What reconnect recovery did, reported once per reconnect.

    ``kind`` is one of:

    - ``backfilled``: the last delivered event was found in history and every
      later row was yielded, in history order, before live frames resumed.
    - ``unsupported``: the live frames carry no history key (``txHash`` /
      ``eventIndex``), which means a gateway older than 7.9.0. Nothing was
      backfilled; events during the outage are not recovered.
    - ``boundary_not_found``: the last delivered event is not in the history
      window that was read. Only rows at a later height were yielded; events
      at the same height as the last delivered one may be missing.
    - ``history_behind``: history had not reached the first live event after
      the reconnect, even after retrying. Events in between may be missing.
    - ``failed``: the history read failed (``error``). Nothing was backfilled.
    """

    kind: str
    delivered: int = 0
    error: Exception | None = None


def _live_key(frame: dict[str, t.Any]) -> EventKey | None:
    tx_hash, index, height = frame.get("txHash"), frame.get("eventIndex"), frame.get("height")
    if not isinstance(tx_hash, str) or not isinstance(index, int) or not isinstance(height, int):
        return None
    return (height, tx_hash, index, _canonical_event_type(frame.get("eventType")))


def _row_key(row: dict[str, t.Any]) -> EventKey:
    return (
        int(row["block_height"]),
        str(row["tx_hash"]),
        int(row["event_index"]),
        _canonical_event_type(row["event_type"]),
    )


def _row_frame(row: dict[str, t.Any]) -> dict[str, t.Any]:
    return {
        "channel": "accountEvents",
        "type": _FAMILIES.get(row["event_type"], "account_event"),
        "owner": row["owner"],
        "eventType": row["event_type"],
        "height": int(row["block_height"]),
        "txHash": row["tx_hash"],
        "txIndex": None,
        "eventIndex": int(row["event_index"]),
        "payload": row.get("payload", {}),
        "backfilled": True,
    }


_UNKEYED = object()


class AccountEventStream:
    """WebSocket stream for account events.

    Subscribes to the ``accountEvents`` channel of the gateway's multiplexed
    ``/ws`` feed and yields its channel-tagged frames: a ``snapshot`` frame,
    then one frame per live event (``order_update``, ``fill``,
    ``position_update``, liquidation events, ...). A refused subscription
    arrives as a ``{"type": "error", ...}`` frame.

    Each reconnect subscribes again and receives a fresh snapshot. By default
    it then recovers the events missed while disconnected: it reads
    ``/v1/history/account-events`` back to the last yielded event, yields the
    newer rows in history order (marked ``"backfilled": True``), then yields
    the live frames received meanwhile, skipping any whose key
    (``height``, ``txHash``, ``eventIndex``, ``eventType``) a backfilled row
    already had. ``on_recovery`` receives a :class:`RecoveryStatus` per
    reconnect, including ``unsupported`` when the gateway predates 7.9.0 and
    sends no history key. ``recover=False`` turns recovery off.

    Args:
        ws_url: WebSocket base URL (the gateway URL with a ``ws`` scheme).
        owner: 20-byte owner address (bytes) or hex string.
        api_key: API key for auth.
        reconnect_backoff_max: Maximum backoff in seconds (default 30).
        reconnect_attempts: Maximum reconnect attempts (``None`` = infinite).
        recover: Backfill missed events from history on reconnect.
        on_recovery: Called with the outcome of each reconnect's recovery.
        history_url: Gateway HTTP base URL for the history read; defaults to
            ``ws_url`` with its scheme swapped back to ``http``/``https``.
    """

    #: Newest-first history pages read per attempt.
    max_history_pages = 10
    #: History reads per reconnect while history lags the live feed.
    max_history_attempts = 5
    history_retry_delay = 1.0

    def __init__(
        self,
        ws_url: str,
        owner: bytes | str,
        api_key: str = "",
        *,
        reconnect_backoff_max: float = 30.0,
        reconnect_attempts: int | None = None,
        recover: bool = True,
        on_recovery: t.Callable[[RecoveryStatus], None] | None = None,
        history_url: str | None = None,
    ) -> None:
        self._ws_url = ws_url.rstrip("/")
        owner_hex = owner.hex() if isinstance(owner, bytes) else owner
        self._owner = owner_hex.removeprefix("0x").lower()
        self._api_key = api_key
        self._backoff_cap = reconnect_backoff_max
        self._max_attempts = reconnect_attempts
        self._recover_enabled = recover
        self._on_recovery = on_recovery
        self._history_url = (history_url or self._ws_url.replace("ws", "http", 1)).rstrip("/")
        # None: nothing yielded yet. _UNKEYED: the last event had no key.
        self._last: t.Any = None
        self._ws: t.Any = None
        self._closed = False

    def __iter__(self) -> t.Iterator[dict[str, t.Any]]:
        return self._run()

    def _connect(self) -> None:
        import websockets.sync.client as ws_client

        extra_headers = {}
        if self._api_key:
            extra_headers["X-API-Key"] = self._api_key
        self._ws = ws_client.connect(
            f"{self._ws_url}/ws", additional_headers=extra_headers
        )
        self._ws.send(
            json.dumps(
                {
                    "method": "subscribe",
                    "id": 1,
                    "params": {"channel": "accountEvents", "owner": self._owner},
                }
            )
        )

    def close(self) -> None:
        self._closed = True
        if self._ws is not None:
            self._ws.close()
            self._ws = None

    def _report(self, status: RecoveryStatus) -> None:
        if self._on_recovery is not None:
            self._on_recovery(status)

    def _history_page(self, cursor: str | None) -> tuple[list[dict[str, t.Any]], str | None]:
        import httpx

        params = {"owner": self._owner, "order": "desc", "limit": "500"}
        if cursor:
            params["cursor"] = cursor
        headers = {"X-API-Key": self._api_key} if self._api_key else {}
        resp = httpx.get(
            f"{self._history_url}/v1/history/account-events",
            params=params,
            headers=headers,
            timeout=10.0,
        )
        body = resp.json()
        if resp.status_code != 200 or not isinstance(body.get("account_events"), list):
            raise RuntimeError(
                f"account history read failed: {body.get('error', resp.status_code)}"
            )
        return body["account_events"], body.get("next_cursor") or None

    def _scan(self, boundary: EventKey) -> tuple[bool, list[dict[str, t.Any]]]:
        newer_first: list[dict[str, t.Any]] = []
        found = False
        cursor: str | None = None
        for _ in range(self.max_history_pages):
            rows, cursor = self._history_page(cursor)
            passed = False
            for row in rows:
                key = _row_key(row)
                if key == boundary:
                    found = True
                    break
                if key[0] < boundary[0]:
                    passed = True
                    break
                newer_first.append(row)
            if found or passed or not cursor:
                break
        rows = list(reversed(newer_first))
        if not found:
            rows = [r for r in rows if int(r["block_height"]) > boundary[0]]
        return found, rows

    def _drain(self, buffer: list[dict[str, t.Any]]) -> None:
        """Move frames the socket has already received into ``buffer``."""
        while True:
            try:
                raw = self._ws.recv(timeout=0)
            except TimeoutError:
                return
            frame = json.loads(raw)
            if frame.get("type") not in _ACK_TYPES:
                buffer.append(frame)

    @staticmethod
    def _covers(rows: list[dict[str, t.Any]], buffer: list[dict[str, t.Any]]) -> bool:
        events = [f for f in buffer if f.get("type") not in ("snapshot", "error")]
        first = _live_key(events[0]) if events else None
        if first is None:
            return True
        if any(_row_key(r) == first for r in rows):
            return True
        newest = int(rows[-1]["block_height"]) if rows else -1
        return newest >= first[0]

    def _recover(self, boundary: EventKey) -> t.Iterator[dict[str, t.Any]]:
        buffer: list[dict[str, t.Any]] = []
        try:
            found, rows = self._scan(boundary)
            self._drain(buffer)
            attempt = 1
            while not self._covers(rows, buffer) and attempt < self.max_history_attempts:
                time.sleep(self.history_retry_delay)
                found, rows = self._scan(boundary)
                self._drain(buffer)
                attempt += 1
        except Exception as err:  # noqa: BLE001 — reported, then live resumes
            self._report(RecoveryStatus("failed", error=err))
            # Frames that arrived during the failed read go out first, in order.
            self._drain(buffer)
            yield from self._deliver_buffer(buffer, set(), -1)
            return
        # Reported before the backfilled rows are yielded, so a consumer that
        # stops iterating part-way still learns the outcome.
        if not found:
            status = RecoveryStatus("boundary_not_found", len(rows))
        elif self._covers(rows, buffer):
            status = RecoveryStatus("backfilled", len(rows))
        else:
            status = RecoveryStatus("history_behind", len(rows))
        self._report(status)
        delivered = {boundary}
        for row in rows:
            key = _row_key(row)
            delivered.add(key)
            self._last = key
            yield _row_frame(row)
        yield from self._deliver_buffer(buffer, delivered, boundary[0])

    def _deliver_buffer(
        self,
        buffer: list[dict[str, t.Any]],
        delivered: set[EventKey],
        boundary_height: int,
    ) -> t.Iterator[dict[str, t.Any]]:
        for frame in buffer:
            yield from self._live(frame, delivered, boundary_height)

    def _live(
        self,
        frame: dict[str, t.Any],
        delivered: set[EventKey] | None = None,
        boundary_height: int = -1,
    ) -> t.Iterator[dict[str, t.Any]]:
        if frame.get("type") in ("snapshot", "error"):
            yield frame
            return
        key = _live_key(frame)
        if key is not None and delivered is not None:
            if key in delivered or key[0] < boundary_height:
                return
        self._last = key if key is not None else _UNKEYED
        yield frame

    def _run(self) -> t.Iterator[dict[str, t.Any]]:
        attempt = 0
        backoff = 0.5
        seen_snapshot = False

        while not self._closed:
            try:
                self._connect()
                attempt = 0
                backoff = 0.5

                for raw in self._ws:
                    if self._closed:
                        return
                    frame = json.loads(raw)
                    if frame.get("type") in _ACK_TYPES:
                        continue
                    if frame.get("type") != "snapshot":
                        yield from self._live(frame)
                        continue
                    yield frame
                    if not seen_snapshot:
                        seen_snapshot = True
                    elif self._recover_enabled and self._last is _UNKEYED:
                        self._report(RecoveryStatus("unsupported"))
                    elif self._recover_enabled and self._last is not None:
                        yield from self._recover(self._last)

            except Exception:
                if self._closed:
                    return
                attempt += 1
                if self._max_attempts is not None and attempt > self._max_attempts:
                    log.error("reconnect attempts exhausted")
                    return
                log.warning("ws reconnect attempt %d in %.1fs", attempt, backoff)
                time.sleep(backoff)
                backoff = min(backoff * 2, self._backoff_cap)


class OrderbookDeltaStream:
    """WebSocket stream for one market's orderbook.

    Subscribes to the ``orderbook`` channel of the gateway's multiplexed
    ``/ws`` feed and yields its channel-tagged frames: a ``snapshot`` frame
    (``bids`` / ``asks`` levels), then one ``update`` frame per changed level
    (``side``, ``price``, ``totalQuantity``, ``orderCount``; a zero quantity
    empties the level). A refused subscription arrives as a
    ``{"type": "error", ...}`` frame. Each reconnect subscribes again and
    starts from a fresh snapshot.

    Args:
        ws_url: WebSocket base URL (the gateway URL with a ``ws`` scheme).
        market: Numeric market ID.
        reconnect_backoff_max: Maximum backoff in seconds (default 30).
    """

    def __init__(
        self,
        ws_url: str,
        market: int,
        *,
        reconnect_backoff_max: float = 30.0,
    ) -> None:
        self._ws_url = ws_url.rstrip("/")
        self._market = market
        self._backoff_cap = reconnect_backoff_max
        self._ws: t.Any = None
        self._closed = False

    def close(self) -> None:
        self._closed = True
        if self._ws is not None:
            self._ws.close()
            self._ws = None

    def __iter__(self) -> t.Iterator[dict[str, t.Any]]:
        return self._run()

    def _connect(self) -> None:
        import websockets.sync.client as ws_client

        self._ws = ws_client.connect(f"{self._ws_url}/ws")
        self._ws.send(
            json.dumps(
                {
                    "method": "subscribe",
                    "id": 1,
                    "params": {"channel": "orderbook", "market": self._market},
                }
            )
        )

    def _run(self) -> t.Iterator[dict[str, t.Any]]:
        attempt = 0
        backoff = 0.5

        while not self._closed:
            try:
                self._connect()
                attempt = 0
                backoff = 0.5

                for raw in self._ws:
                    if self._closed:
                        return
                    frame = json.loads(raw)
                    if frame.get("type") in _ACK_TYPES:
                        continue
                    yield frame

            except Exception:
                if self._closed:
                    return
                attempt += 1
                log.warning("ws reconnect attempt %d in %.1fs", attempt, backoff)
                time.sleep(backoff)
                backoff = min(backoff * 2, self._backoff_cap)
