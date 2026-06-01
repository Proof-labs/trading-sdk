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


class AccountEventStream:
    """WebSocket stream for account events.

    Connects to ``/account-events``, yields typed events with
    sequence-gap recovery via ``after_id`` replay.

    Args:
        ws_url: WebSocket base URL.
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
        self._owner = owner.hex() if isinstance(owner, bytes) else owner
        self._api_key = api_key
        self._backoff_cap = reconnect_backoff_max
        self._max_attempts = reconnect_attempts
        self._last_event_id: int | None = None
        self._ws: t.Any = None
        self._closed = False

    def __iter__(self) -> t.Iterator[dict[str, t.Any]]:
        return self._run()

    def _connect(self) -> None:
        import websockets.sync.client as ws_client

        params = f"owner={self._owner}"
        if self._last_event_id is not None:
            params += f"&after_id={self._last_event_id}"
        url = f"{self._ws_url}/account-events?{params}"
        extra_headers = {}
        if self._api_key:
            extra_headers["X-API-Key"] = self._api_key
        self._ws = ws_client.connect(url, additional_headers=extra_headers)

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
                    event = json.loads(raw)
                    event_id = event.get("event_id")
                    if event_id is not None:
                        self._last_event_id = max(
                            self._last_event_id or 0, event_id
                        )
                    yield event

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
