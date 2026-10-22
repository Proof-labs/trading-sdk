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


class AccountEventStream:
    """WebSocket stream for account events.

    Subscribes to the ``accountEvents`` channel of the gateway's multiplexed
    ``/ws`` feed and yields its channel-tagged frames: a ``snapshot`` frame,
    then one frame per live event (``order_update``, ``fill``,
    ``position_update``, liquidation events, ...). A refused subscription
    arrives as a ``{"type": "error", ...}`` frame. Each reconnect subscribes
    again and receives a fresh snapshot; events missed while disconnected are
    not replayed, so read ``/v1/history/account-events`` to fill that gap.

    Args:
        ws_url: WebSocket base URL (the gateway URL with a ``ws`` scheme).
        owner: 20-byte owner address (bytes) or hex string.
        api_key: API key for auth.
        reconnect_backoff_max: Maximum backoff in seconds (default 30).
        reconnect_attempts: Maximum reconnect attempts (``None`` = infinite).
    """

    def __init__(
        self,
        ws_url: str,
        owner: bytes | str,
        api_key: str = "",
        *,
        reconnect_backoff_max: float = 30.0,
        reconnect_attempts: int | None = None,
    ) -> None:
        self._ws_url = ws_url.rstrip("/")
        owner_hex = owner.hex() if isinstance(owner, bytes) else owner
        self._owner = owner_hex.removeprefix("0x").lower()
        self._api_key = api_key
        self._backoff_cap = reconnect_backoff_max
        self._max_attempts = reconnect_attempts
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
                if self._max_attempts is not None and attempt > self._max_attempts:
                    log.error("reconnect attempts exhausted")
                    return
                log.warning("ws reconnect attempt %d in %.1fs", attempt, backoff)
                time.sleep(backoff)
                backoff = min(backoff * 2, self._backoff_cap)


class OrderbookDeltaStream:
    """WebSocket stream for L2 orderbook deltas.

    The first frame is a full ``l2Book`` snapshot. Subsequent frames
    are incremental deltas. See the spec for gap recovery details.

    Args:
        ws_url: WebSocket base URL.
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

        url = f"{self._ws_url}/orderbook-deltas?market={self._market}"
        self._ws = ws_client.connect(url)

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
                    yield json.loads(raw)

            except Exception:
                if self._closed:
                    return
                attempt += 1
                log.warning("ws reconnect attempt %d in %.1fs", attempt, backoff)
                time.sleep(backoff)
                backoff = min(backoff * 2, self._backoff_cap)
