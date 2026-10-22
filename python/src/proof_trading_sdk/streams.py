from __future__ import annotations

import json
import logging
import threading
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

    - ``backfilled``: every history row after the last yielded event (or,
      when none was yielded, after the previous snapshot's height) was
      yielded in history order before live frames resumed, and history had
      indexed up to the reconnect snapshot's ``height``.
    - ``unverified``: rows were backfilled as for ``backfilled``, but the
      snapshot carries no ``height`` (an older gateway or node), so whether
      history had caught up cannot be checked. Events may be missing. With
      nothing yielded before the outage and no previous snapshot height
      either, there is no boundary and nothing is backfilled.
    - ``unsupported``: the live frames carry no history key (``txHash`` /
      ``eventIndex``), which means a gateway older than 7.9.0. Nothing was
      backfilled; events during the outage are not recovered.
    - ``boundary_not_found``: the last yielded event is not in the history
      window that was read. Only rows at a later height were yielded; events
      at the same height as the last yielded one may be missing.
    - ``history_behind``: history had not indexed up to the snapshot's height,
      even after retrying. Events in between may be missing.
    - ``failed``: a history read failed (``error``). Nothing was backfilled.
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
    ``/v1/history/account-events`` back to the last yielded event (or the
    previous snapshot's ``height`` when none was yielded), retrying while
    ``/v1/history/status`` shows history has not indexed up to the new
    snapshot's ``height``. It yields the newer rows in history order (marked
    ``"backfilled": True``), then the live frames received meanwhile,
    skipping any whose key (``height``, ``txHash``, ``eventIndex``,
    ``eventType``) a backfilled row already had. ``on_recovery`` receives one
    :class:`RecoveryStatus` per reconnect. A snapshot marked
    ``"snapshot": "resent"`` is not a reconnect. ``recover=False`` turns
    recovery off.

    Args:
        ws_url: WebSocket base URL (the gateway URL with a ``ws`` scheme).
        owner: 20-byte owner address (bytes) or hex string.
        api_key: API key for auth.
        reconnect_backoff_max: Maximum backoff in seconds (default 30).
        reconnect_attempts: Maximum reconnect attempts (``None`` = infinite).
        recover: Backfill missed events from history on reconnect.
        on_recovery: Called with the outcome of each reconnect's recovery.
        history_url: Gateway HTTP base URL for the history reads. Defaults to
            ``ws_url`` with its scheme swapped back to ``http``/``https``,
            which is wrong when ``/ws`` is served on its own port: pass it
            then, or use :meth:`ExchangeClient.account_event_stream`, which
            sets it from the client's gateway URL.
    """

    #: Newest-first history pages read per attempt.
    max_history_pages = 10
    #: History reads per reconnect while history lags the snapshot.
    max_history_attempts = 5
    history_retry_delay = 1.0
    #: Seconds a single history read may take; ``close()`` cannot interrupt
    #: one in flight, but nothing it returns is yielded after ``close()``.
    history_timeout = 10.0

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
        # Height of the latest snapshot recovery has caught up to.
        self._snapshot_height: int | None = None
        # Keys a backfill yielded, kept until a live frame passes the newest of
        # them: a slow socket can still deliver one the indexer already served.
        self._recent: tuple[set[EventKey], int, int] | None = None
        self._stop = threading.Event()
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
        self._stop.set()
        if self._ws is not None:
            self._ws.close()
            self._ws = None

    def _report(self, status: RecoveryStatus) -> None:
        if self._on_recovery is not None and not self._closed:
            self._on_recovery(status)

    def _get(self, path: str, params: dict[str, str] | None = None) -> dict[str, t.Any]:
        import httpx

        headers = {"X-API-Key": self._api_key} if self._api_key else {}
        resp = httpx.get(
            f"{self._history_url}{path}",
            params=params or {},
            headers=headers,
            timeout=self.history_timeout,
        )
        body = resp.json()
        if resp.status_code != 200 or not isinstance(body, dict):
            error = body.get("error") if isinstance(body, dict) else None
            raise RuntimeError(f"{path} read failed: {error or resp.status_code}")
        return body

    def _history_page(self, cursor: str | None) -> tuple[list[dict[str, t.Any]], str | None]:
        params = {"owner": self._owner, "order": "desc", "limit": "500"}
        if cursor:
            params["cursor"] = cursor
        body = self._get("/v1/history/account-events", params)
        if not isinstance(body.get("account_events"), list):
            raise RuntimeError("account history read failed: no account_events")
        return body["account_events"], body.get("next_cursor") or None

    def _indexed_height(self) -> int:
        """The newest height history has indexed in full."""
        height = self._get("/v1/history/status").get("ingest", {}).get("newest_height")
        if not isinstance(height, int):
            raise RuntimeError("history status read failed: no ingest.newest_height")
        return height

    def _scan(
        self, key: EventKey | None, height: int
    ) -> tuple[bool, list[dict[str, t.Any]]]:
        """Rows after the boundary (an event, or a height), oldest first."""
        newer_first: list[dict[str, t.Any]] = []
        # A height boundary is exact: the snapshot holds everything up to it.
        found = key is None
        reached = False
        cursor: str | None = None
        for _ in range(self.max_history_pages):
            rows, cursor = self._history_page(cursor)
            for row in rows:
                row_key = _row_key(row)
                if key is not None and row_key == key:
                    found = reached = True
                    break
                if row_key[0] < height if key is not None else row_key[0] <= height:
                    reached = True
                    break
                newer_first.append(row)
            if reached or not cursor:
                break
        rows = list(reversed(newer_first))
        if not found:
            rows = [r for r in rows if int(r["block_height"]) > height]
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

    def _recover(self, snapshot: dict[str, t.Any]) -> t.Iterator[dict[str, t.Any]]:
        target = snapshot.get("height") if isinstance(snapshot.get("height"), int) else None
        previous, self._snapshot_height = self._snapshot_height, target
        if self._last is _UNKEYED:
            self._report(RecoveryStatus("unsupported"))
            return
        if self._last is not None:
            key: EventKey | None = self._last
            height = self._last[0]
        elif previous is not None:
            key, height = None, previous
        else:
            self._recent = None
            self._report(RecoveryStatus("unverified"))
            return
        buffer: list[dict[str, t.Any]] = []
        try:
            indexed = self._indexed_height() if target is not None else -1
            found, rows = self._scan(key, height)
            self._drain(buffer)
            attempt = 1
            while target is not None and indexed < target and attempt < self.max_history_attempts:
                if self._stop.wait(self.history_retry_delay):
                    return
                indexed = self._indexed_height()
                found, rows = self._scan(key, height)
                self._drain(buffer)
                attempt += 1
        except Exception as err:  # noqa: BLE001 — reported, then live resumes
            if self._closed:
                return
            self._recent = None
            self._report(RecoveryStatus("failed", error=err))
            # Frames that arrived during the failed read go out first, in order.
            self._drain(buffer)
            for frame in buffer:
                yield from self._live(frame)
            return
        if self._closed:
            return
        # Reported before the backfilled rows are yielded, so a consumer that
        # stops iterating part-way still learns the outcome.
        if not found:
            status = RecoveryStatus("boundary_not_found", len(rows))
        elif target is None:
            status = RecoveryStatus("unverified", len(rows))
        elif indexed >= target:
            status = RecoveryStatus("backfilled", len(rows))
        else:
            status = RecoveryStatus("history_behind", len(rows))
        self._report(status)
        delivered: set[EventKey] = {key} if key is not None else set()
        newest = -1
        for row in rows:
            row_key = _row_key(row)
            delivered.add(row_key)
            newest = max(newest, row_key[0])
            self._last = row_key
            yield _row_frame(row)
        self._recent = (delivered, newest, height if key is not None else height + 1)
        for frame in buffer:
            yield from self._live(frame)

    def _live(self, frame: dict[str, t.Any]) -> t.Iterator[dict[str, t.Any]]:
        if frame.get("type") in ("snapshot", "error"):
            yield frame
            return
        key = _live_key(frame)
        if key is not None and self._recent is not None:
            keys, newest, floor = self._recent
            if key in keys or key[0] < floor:
                return
            if key[0] > newest:
                self._recent = None
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
                    # A resend for another listener is not a reconnect.
                    if frame.get("snapshot") == "resent":
                        continue
                    if not seen_snapshot:
                        seen_snapshot = True
                        height = frame.get("height")
                        self._snapshot_height = height if isinstance(height, int) else None
                    elif self._recover_enabled:
                        yield from self._recover(frame)

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
