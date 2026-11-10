from __future__ import annotations

import json
import logging
import math
import threading
import time
import typing as t
from dataclasses import dataclass, field
from urllib.parse import urlsplit, urlunsplit

from proof_trading_sdk.errors import AuthenticationError, SigningError, TransportError

log = logging.getLogger("proof_trading_sdk")


@dataclass
class AccountEvent:
    event_id: int
    event_type: str
    data: dict[str, t.Any] = field(default_factory=dict)


# Acknowledgements the gateway sends for control messages; not data.
_ACK_TYPES = frozenset({"subscribed", "unsubscribed", "pong"})
_RETRYABLE_ACCOUNT_REFUSALS = frozenset({401, 429, 503})
# As in TypeScript GatewayFeed: an initial attempt plus five retries.
_MAX_AUTH_RETRIES = 5


# Live frame type for a history row; mirrors api-gateway
# `account_ws_message_type`.
_FAMILIES = {
    "trade_executed": "fill",
    "order_placed": "orderUpdate",
    "order_cancelled": "orderUpdate",
    "order_amended": "orderUpdate",
    "market_order_processed": "orderUpdate",
    "order_rejected": "orderUpdate",
    "position_updated": "positionUpdate",
    "position_closed": "positionUpdate",
    "funding_settled": "funding",
    "position_triggers_set": "triggerUpdate",
    "position_triggers_cancelled": "triggerUpdate",
    "position_triggers_invalidated": "triggerUpdate",
    "position_trigger_activated": "triggerUpdate",
    "position_trigger_executed": "triggerUpdate",
    "position_trigger_deferred": "triggerUpdate",
    "margin_warning": "marginUpdate",
}

# Settlement event names before the canonical vocabulary, mapped to the names
# history rows carry. A gateway that already sends the canonical names passes
# through unchanged.
_LEGACY_EVENT_TYPES = {
    "conditional_settled": "condition_met",  # vocabulary-lint: allow
    "conditional_voided": "condition_not_met",  # vocabulary-lint: allow
}


def _canonical_event_type(event_type: t.Any) -> str:
    name = str(event_type)
    return _LEGACY_EVENT_TYPES.get(name, name)


# (height, txHash, eventIndex, eventType, txIndex): one account event's
# history key. A transaction hash can recur at different heights, and twice
# in one block, so all the fields together identify an event. A ``txIndex``
# of ``None`` is a wildcard: history rows omit ``tx_position`` for normal
# blocks, where live frames still carry the real index.
EventKey = tuple[int, str, int, str, int | None]


def same_event(a: EventKey, b: EventKey) -> bool:
    """Whether two keys denote the same event: the four identifying fields
    are equal and the positions agree, where ``None`` agrees with anything."""
    return (
        a[:4] == b[:4] and (a[4] is None or b[4] is None or a[4] == b[4])
    )


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
      even after waiting ``max_history_attempts`` status reads. Events in
      between may be missing.
    - ``failed``: a history read failed, or the gap held more rows than
      ``max_history_pages`` pages, so the boundary was never reached
      (``error``). Nothing was backfilled.
    """

    kind: str
    delivered: int = 0
    error: Exception | None = None


def _live_key(frame: dict[str, t.Any]) -> EventKey | None:
    tx_hash, index, height = frame.get("txHash"), frame.get("eventIndex"), frame.get("height")
    if not isinstance(tx_hash, str) or not isinstance(index, int) or not isinstance(height, int):
        return None
    tx_index = frame.get("txIndex")
    return (
        height,
        tx_hash,
        index,
        _canonical_event_type(frame.get("eventType")),
        tx_index if isinstance(tx_index, int) else None,
    )


def _row_key(row: dict[str, t.Any]) -> EventKey:
    tx_position = row.get("tx_position")
    return (
        int(row["block_height"]),
        str(row["tx_hash"]),
        int(row["event_index"]),
        _canonical_event_type(row["event_type"]),
        tx_position if isinstance(tx_position, int) else None,
    )


def _row_frame(row: dict[str, t.Any]) -> dict[str, t.Any]:
    tx_position = row.get("tx_position")
    return {
        "channel": "accountEvents",
        "type": _FAMILIES.get(row["event_type"], "accountEvent"),
        "owner": row["owner"],
        "eventType": row["event_type"],
        "height": int(row["block_height"]),
        "txHash": row["tx_hash"],
        "txIndex": tx_position if isinstance(tx_position, int) else None,
        "eventIndex": int(row["event_index"]),
        "payload": row.get("payload", {}),
        "backfilled": True,
    }


_UNKEYED = object()


class _WebSocketStream:
    """Shared connection ownership, startup errors and cancelable reconnects.

    Subclasses only implement a connected session. Subscription authentication
    and history recovery remain channel-specific; transport failures do not.
    """

    def __init__(
        self, ws_url: str, *, api_key: str = "",
        reconnect_backoff_max: float, reconnect_attempts: int | None = None,
    ) -> None:
        if (
            isinstance(reconnect_backoff_max, bool)
            or not isinstance(reconnect_backoff_max, (int, float))
            or not math.isfinite(reconnect_backoff_max)
            or reconnect_backoff_max <= 0
        ):
            raise ValueError("reconnect_backoff_max must be finite and positive")
        url = urlsplit(ws_url)
        path = url.path.rstrip("/")
        if not path.endswith("/ws"):
            path += "/ws"
        self._ws_url = urlunsplit(url._replace(path=path))
        self._api_key = api_key
        self._backoff_cap = reconnect_backoff_max
        self._max_attempts = reconnect_attempts
        self._stop = threading.Event()
        self._iterator_lock = threading.Lock()
        self._ws: t.Any = None
        self._closed = False

    def _connect_options(self) -> dict[str, t.Any]:
        return {"additional_headers": {"X-API-Key": self._api_key} if self._api_key else {}}

    def _session(self) -> t.Iterator[dict[str, t.Any]]:
        raise NotImplementedError

    def _close_socket(self) -> None:
        socket, self._ws = self._ws, None
        if socket is not None:
            socket.close()

    def close(self) -> None:
        self._closed = True
        self._stop.set()
        self._close_socket()

    def __enter__(self) -> t.Self:
        return self

    def __exit__(self, *_: t.Any) -> None:
        self.close()

    def __iter__(self) -> t.Iterator[dict[str, t.Any]]:
        return self._run()

    def _run(self) -> t.Iterator[dict[str, t.Any]]:
        import websockets.sync.client as ws_client
        from websockets.exceptions import InvalidStatus

        if not self._iterator_lock.acquire(blocking=False):
            raise RuntimeError("stream already has an active iterator")
        attempt = 0
        backoff = 0.5
        connected_once = False
        try:
            while not self._closed:
                try:
                    self._ws = ws_client.connect(self._ws_url, **self._connect_options())
                    connected_once = True
                    if self._closed:
                        return
                    attempt = 0
                    backoff = 0.5
                    yield from self._session()
                except Exception as error:
                    if self._closed:
                        return
                    if not connected_once:
                        code = error.response.status_code if isinstance(error, InvalidStatus) else None
                        if code in (401, 403):
                            raise AuthenticationError("stream connection authentication refused") from error
                        message = "stream connection failed"
                        if code is not None:
                            message += f" (HTTP {code})"
                        raise TransportError(message, status_code=code) from error
                    log.warning("stream disconnected; reconnecting")
                finally:
                    self._close_socket()
                if self._closed:
                    return
                attempt += 1
                if self._max_attempts is not None and attempt > self._max_attempts:
                    log.error("reconnect attempts exhausted")
                    return
                if self._stop.wait(min(backoff, self._backoff_cap)):
                    return
                backoff = min(backoff * 2, self._backoff_cap)
        finally:
            try:
                self.close()
            finally:
                self._iterator_lock.release()


class AccountEventStream(_WebSocketStream):
    """WebSocket stream for account events.

    Subscribes to the ``accountEvents`` channel of the gateway's multiplexed
    ``/ws`` feed and yields its channel-tagged frames: a ``snapshot`` frame,
    then one frame per live event (``orderUpdate``, ``fill``,
    ``positionUpdate``, liquidation events, ...). A refused subscription
    arrives as a ``{"type": "error", ...}`` frame. Before confirmation,
    signing failures and subscription refusals 401/429/503 retry on the same
    socket, with fresh auth and exponential backoff, at most five times.
    Exhaustion emits a final error frame and leaves the socket quiet until it
    disconnects or is closed. Other refusals (including 403), and errors after
    confirmation, do not resubscribe. A new socket starts a fresh retry budget.
    Before the first successful connection, HTTP upgrade 401/403 raises
    ``AuthenticationError`` and other connection failures raise ``TransportError``.
    Reconnects use the configured retry budget and backoff, preserving the
    history recovery boundary. Closing the iterator closes the stream; only
    one iterator may consume it at a time.

    Each reconnect subscribes again and receives a fresh snapshot. By default
    it then recovers the events missed while disconnected: it reads
    ``/v1/history/account-events`` back to the last yielded event (or the
    previous snapshot's ``height`` when none was yielded), once
    ``/v1/history/status`` shows history has indexed up to the new
    snapshot's ``height`` or the wait runs out. It yields the newer rows in history order (marked
    ``"backfilled": True``), then the live frames received meanwhile,
    skipping any whose key (``height``, ``txHash``, ``eventIndex``,
    ``eventType``, ``txIndex`` — a ``txIndex`` of ``None`` matches any
    position, since history rows omit ``tx_position`` for normal blocks) a
    backfilled row already had. ``on_recovery`` receives one
    :class:`RecoveryStatus` per reconnect. A snapshot marked
    ``"snapshot": "resent"`` is not a reconnect. ``recover=False`` turns
    recovery off.

    Args:
        ws_url: WebSocket base URL or endpoint already ending in ``/ws``.
        owner: 20-byte owner address (bytes) or hex string.
        api_key: API key for auth.
        auth: Optional signed-subscription params factory, called again on
            every connection. Use :meth:`ExchangeClient.account_event_stream`
            to authenticate with the client's secret key or opaque handle.
            Signing failures yield error frames without sending an unsigned
            subscription. Also used by the first-subscription retry loop.
        reconnect_backoff_max: Maximum backoff in seconds (default 10).
        reconnect_attempts: Maximum reconnect attempts (``None`` = infinite).
        recover: Backfill missed events from history on reconnect.
        on_recovery: Called with the outcome of each reconnect's recovery.
        history_url: Gateway HTTP base URL for the history reads. Defaults to
            ``ws_url`` with its scheme swapped back to ``http``/``https``,
            which is wrong when ``/ws`` is served on its own port: pass it
            then, or use :meth:`ExchangeClient.account_event_stream`, which
            sets it from the client's gateway URL.
    """

    #: Newest-first history pages read before giving up on the boundary.
    max_history_pages = 10
    #: Status reads per reconnect, ``history_retry_delay`` apart, while
    #: history lags the snapshot: about 30 seconds of indexer lag.
    max_history_attempts = 30
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
        reconnect_backoff_max: float = 10.0,
        reconnect_attempts: int | None = None,
        recover: bool = True,
        on_recovery: t.Callable[[RecoveryStatus], None] | None = None,
        history_url: str | None = None,
        auth: t.Callable[[], dict[str, t.Any]] | None = None,
    ) -> None:
        super().__init__(
            ws_url, api_key=api_key, reconnect_backoff_max=reconnect_backoff_max,
            reconnect_attempts=reconnect_attempts,
        )
        owner_hex = owner.hex() if isinstance(owner, bytes) else owner
        self._owner = owner_hex.lower().removeprefix("0x")
        self._auth = auth
        self._recover_enabled = recover
        self._on_recovery = on_recovery
        endpoint = urlsplit(self._ws_url)
        default_history = urlunsplit(endpoint._replace(
            scheme=endpoint.scheme.replace("ws", "http", 1),
            path=endpoint.path.removesuffix("/ws"), query="", fragment="",
        ))
        self._history_url = (history_url or default_history).rstrip("/")
        # None: nothing yielded yet. _UNKEYED: the last event had no key.
        self._last: t.Any = None
        # Height of the latest snapshot recovery has caught up to.
        self._snapshot_height: int | None = None
        # Events a backfill yielded, kept until a live frame passes the newest
        # of their heights: a slow socket can still deliver one the indexer
        # already served. Bucketed by the four identifying fields, so
        # :func:`same_event` only has to be tried against keys they match.
        self._recent: tuple[
            dict[tuple[int, str, int, str], list[EventKey]], int, int
        ] | None = None
        self._seen_snapshot = False
        self._next_subscribe_id = 1
        self._last_subscribe_id: int | None = None
        self._confirmed = False
        self._auth_retry_attempts = 0
        self._auth_retry_at: float | None = None

    def _subscribe(self) -> t.Iterator[dict[str, t.Any]]:
        socket = self._ws
        if self._closed or socket is None:
            return
        params: dict[str, t.Any] = {}
        if self._auth is not None:
            try:
                params.update(self._auth())
            except SigningError as err:
                # The SDK's signing errors are fixed text with no key material.
                log.warning("account-stream auth failed: %s", err)
                if not self._closed and self._ws is socket:
                    yield from self._auth_failed(str(err))
                return
            except Exception as err:
                # Backend messages may contain sensitive material: type only.
                log.warning("account-stream auth failed: %s", type(err).__name__)
                if not self._closed and self._ws is socket:
                    yield from self._auth_failed()
                return
        # A device call can finish after close(); never send that stale result.
        if self._closed or self._ws is not socket:
            return
        # Authentication providers cannot replace the subscription identity.
        params.update(channel="accountEvents", owner=self._owner)
        self._last_subscribe_id = self._next_subscribe_id
        self._next_subscribe_id += 1
        socket.send(
            json.dumps(
                {
                    "method": "subscribe",
                    "id": self._last_subscribe_id,
                    "params": params,
                }
            )
        )

    def _schedule_auth_retry(self) -> float:
        delay = min(self._backoff_cap, 0.5 * 2 ** self._auth_retry_attempts)
        self._auth_retry_attempts += 1
        self._auth_retry_at = time.monotonic() + delay
        return delay

    @staticmethod
    def _retry_exhausted(cause: str | None = None) -> dict[str, t.Any]:
        failed = f"failed ({cause})" if cause else "failed"
        return {
            "type": "error", "channel": "accountEvents",
            "error": f"accountEvents subscription authentication {failed}; not retrying after {_MAX_AUTH_RETRIES} retries",
        }

    def _auth_failed(self, cause: str | None = None) -> t.Iterator[dict[str, t.Any]]:
        if self._confirmed:
            return
        if self._auth_retry_attempts >= _MAX_AUTH_RETRIES:
            yield self._retry_exhausted(cause)
            return
        delay = self._schedule_auth_retry()
        failed = f"failed ({cause})" if cause else "failed"
        yield {
            "type": "error", "channel": "accountEvents",
            "error": f"accountEvents subscription authentication {failed}; retrying in {delay * 1000:g}ms",
        }

    def _confirm(self) -> None:
        self._confirmed = True
        self._auth_retry_attempts = 0
        self._auth_retry_at = None

    def _matches_subscribe(self, frame: dict[str, t.Any]) -> bool:
        return type(frame.get("id")) is int and frame["id"] == self._last_subscribe_id

    def _belongs_to_account(self, frame: dict[str, t.Any]) -> bool:
        owner = frame.get("owner")
        return (
            frame.get("channel") == "accountEvents"
            and isinstance(owner, str)
            and owner.lower().removeprefix("0x") == self._owner
        )

    def close(self) -> None:
        self._auth_retry_at = None
        super().close()

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
        # Status before parse: a gateway error body need not be JSON, and a
        # JSONDecodeError from ``resp.json()`` would bury the intended
        # message.
        if resp.status_code != 200:
            try:
                error = resp.json().get("error")
            except ValueError:
                error = None
            raise RuntimeError(f"{path} read failed: {error or resp.status_code}")
        body = resp.json()
        if not isinstance(body, dict):
            raise RuntimeError(f"{path} read failed: {resp.status_code}")
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
        for page in range(self.max_history_pages):
            rows, cursor = self._history_page(cursor)
            for row in rows:
                row_key = _row_key(row)
                if key is not None and same_event(row_key, key):
                    found = reached = True
                    break
                if row_key[0] < height if key is not None else row_key[0] <= height:
                    reached = True
                    break
                newer_first.append(row)
            if reached or not cursor:
                break
            if page == self.max_history_pages - 1:
                raise RuntimeError(
                    f"account history holds more than {self.max_history_pages}"
                    " pages after the recovery boundary"
                )
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
            if frame.get("type") == "error" or (
                frame.get("type") not in _ACK_TYPES and self._belongs_to_account(frame)
            ):
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
            self._drain(buffer)
            attempt = 1
            while target is not None and indexed < target and attempt < self.max_history_attempts:
                if self._stop.wait(self.history_retry_delay):
                    return
                indexed = self._indexed_height()
                self._drain(buffer)
                attempt += 1
            found, rows = self._scan(key, height)
            self._drain(buffer)
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
        delivered: dict[tuple[int, str, int, str], list[EventKey]] = (
            {key[:4]: [key]} if key is not None else {}
        )
        newest = -1
        for row in rows:
            row_key = _row_key(row)
            delivered.setdefault(row_key[:4], []).append(row_key)
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
            buckets, newest, floor = self._recent
            if (
                any(same_event(k, key) for k in buckets.get(key[:4], ()))
                or key[0] < floor
            ):
                return
            if key[0] > newest:
                self._recent = None
        self._last = key if key is not None else _UNKEYED
        yield frame

    def _session(self) -> t.Iterator[dict[str, t.Any]]:
        self._confirmed = False
        self._auth_retry_attempts = 0
        self._auth_retry_at = None
        self._last_subscribe_id = None
        yield from self._subscribe()

        while not self._closed:
            # A busy socket must not starve the scheduled auth retry.
            if self._auth_retry_at is not None and time.monotonic() >= self._auth_retry_at:
                self._auth_retry_at = None
                yield from self._subscribe()
                if self._closed:
                    return
            timeout = (
                None if self._auth_retry_at is None
                else max(0.0, self._auth_retry_at - time.monotonic())
            )
            try:
                raw = self._ws.recv(timeout=timeout)
            except TimeoutError:
                if self._closed:
                    return
                if self._auth_retry_at is None:
                    raise
                if time.monotonic() >= self._auth_retry_at:
                    self._auth_retry_at = None
                    yield from self._subscribe()
                continue
            if self._closed:
                return
            frame = json.loads(raw)
            if frame.get("type") == "subscribed" and self._matches_subscribe(frame):
                self._confirm()
            if frame.get("type") in _ACK_TYPES:
                continue
            if frame.get("type") == "error":
                retryable = (
                    not self._confirmed and self._matches_subscribe(frame)
                    and frame.get("code") in _RETRYABLE_ACCOUNT_REFUSALS
                )
                exhausted = retryable and self._auth_retry_attempts >= _MAX_AUTH_RETRIES
                if retryable and not exhausted:
                    self._schedule_auth_retry()
                yield frame
                if exhausted and not self._closed:
                    yield self._retry_exhausted()
                continue
            if not self._belongs_to_account(frame):
                continue
            self._confirm()
            if frame.get("type") != "snapshot":
                yield from self._live(frame)
                continue
            yield frame
            # A resend for another listener is not a reconnect.
            if frame.get("snapshot") == "resent":
                continue
            if not self._seen_snapshot:
                self._seen_snapshot = True
                height = frame.get("height")
                self._snapshot_height = height if isinstance(height, int) else None
            elif self._recover_enabled:
                yield from self._recover(frame)


class OrderbookDeltaStream(_WebSocketStream):
    """WebSocket stream for one market's orderbook.

    Subscribes to the ``orderbook`` channel of the gateway's multiplexed
    ``/ws`` feed and yields its channel-tagged frames: a ``snapshot`` frame
    (``bids`` / ``asks`` levels), then one ``update`` frame per changed level
    (``side``, ``price``, ``totalQuantity``, ``orderCount``; a zero quantity
    empties the level). A refused subscription arrives as a
    ``{"type": "error", ...}`` frame. Each reconnect subscribes again and
    starts from a fresh snapshot. Before the first successful connection, HTTP
    401/403 raises ``AuthenticationError``; other failures raise ``TransportError``.
    Thereafter failures retry with cancelable exponential backoff. Only one
    iterator may consume the stream; closing that iterator closes the socket.

    Args:
        ws_url: WebSocket base URL or endpoint already ending in ``/ws``.
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
        super().__init__(ws_url, reconnect_backoff_max=reconnect_backoff_max)
        self._market = market

    def _session(self) -> t.Iterator[dict[str, t.Any]]:
        self._ws.send(json.dumps({
            "method": "subscribe", "id": 1,
            "params": {"channel": "orderbook", "market": self._market},
        }))
        for raw in self._ws:
            if self._closed:
                return
            frame = json.loads(raw)
            if frame.get("type") not in _ACK_TYPES:
                yield frame


class PublicTradeStream(_WebSocketStream):
    """One market's live ``trades`` channel on a dedicated connection.

    Iterate to receive the gateway's original ``trade`` dictionaries (including
    camelCase keys and decimal strings) and subscription error frames. There is
    no initial snapshot, replay, deduplication or recovery of missed fills.
    Before the first successful connection, failures raise ``AuthenticationError``
    for HTTP 401/403, or ``TransportError`` otherwise. After connecting once,
    reconnects resubscribe with a fresh request ID and failures back off from
    0.5 seconds to 10 seconds by default, as in TypeScript GatewayFeed.
    A subscription refusal is yielded, without a same-socket retry.
    ``ws_url`` accepts a base URL or an endpoint already ending in ``/ws``.

    No signer is used. An optional API key sets the connection's gateway tier.
    WebSocket Ping/Pong uses a 15-second interval and 10-second timeout.
    TypeScript uses JSON heartbeat frames with those timings; Python uses the
    protocol-level keepalive provided by ``websockets>=15``.

    Only one iterator may consume a stream. Reconnect work runs while that
    iterator is consumed. Call ``close()`` or use a context manager when done;
    closing the iterator also closes the stream. Closing wakes pending reads
    and reconnect waits; an in-flight connect ends within its own timeout, and
    closing against an unresponsive peer can block for the library's timeout.
    """

    def __init__(
        self, ws_url: str, market: int, api_key: str = "", *,
        reconnect_backoff_max: float = 10.0,
    ) -> None:
        if type(market) is not int or not 0 <= market <= 0xffffffff:
            raise ValueError("trade stream market must be a u32 integer")
        super().__init__(ws_url, api_key=api_key, reconnect_backoff_max=reconnect_backoff_max)
        self._market = market
        self._request_id = 0

    def _connect_options(self) -> dict[str, t.Any]:
        return {**super()._connect_options(), "ping_interval": 15, "ping_timeout": 10}

    def _session(self) -> t.Iterator[dict[str, t.Any]]:
        self._request_id += 1
        self._ws.send(json.dumps({
            "method": "subscribe", "id": self._request_id,
            "params": {"channel": "trades", "market": self._market},
        }))
        for raw in self._ws:
            if self._closed:
                return
            try:
                frame = json.loads(raw)
            except (ValueError, TypeError):
                log.warning("trade stream ignored invalid JSON")
                continue
            if not isinstance(frame, dict):
                continue
            if frame.get("type") == "error":
                # Gateway errors can omit channel and market; the subscribe
                # request ID binds them to this caller.
                if type(frame.get("id")) is int and frame["id"] == self._request_id:
                    yield frame
            elif (
                frame.get("channel") == "trades"
                and frame.get("type") == "trade"
                and type(frame.get("market")) is int
                and frame["market"] == self._market
            ):
                yield frame
