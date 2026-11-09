"""Public real-time fills from the gateway's multiplexed WebSocket protocol."""
from __future__ import annotations

import json
import logging
import math
import threading
import typing as t

log = logging.getLogger("proof_trading_sdk")


class PublicTradeStream:
    """One market's live ``trades`` channel on a dedicated connection.

    Iterate to receive the gateway's original ``trade`` dictionaries (including
    camelCase keys and decimal strings) and subscription error frames. There is
    no initial snapshot, replay, deduplication or recovery of missed fills.
    Reconnects resubscribe with a fresh request ID. Failed connections back off
    from 0.5 seconds to 10 seconds by default, as in TypeScript GatewayFeed.
    A subscription refusal is yielded, without a same-socket retry.

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
        if (
            isinstance(reconnect_backoff_max, bool)
            or not isinstance(reconnect_backoff_max, (int, float))
            or not math.isfinite(reconnect_backoff_max)
            or reconnect_backoff_max <= 0
        ):
            raise ValueError("reconnect_backoff_max must be finite and positive")
        self._ws_url = ws_url.rstrip("/")
        self._market = market
        self._api_key = api_key
        self._backoff_cap = reconnect_backoff_max
        self._stop = threading.Event()
        self._iterator_lock = threading.Lock()
        self._ws: t.Any = None

    def close(self) -> None:
        self._stop.set()
        socket, self._ws = self._ws, None
        if socket is not None:
            socket.close()

    def __enter__(self) -> PublicTradeStream:
        return self

    def __exit__(self, *_: t.Any) -> None:
        self.close()

    def __iter__(self) -> t.Iterator[dict[str, t.Any]]:
        return self._run()

    def _run(self) -> t.Iterator[dict[str, t.Any]]:
        import websockets.sync.client as ws_client

        if not self._iterator_lock.acquire(blocking=False):
            raise RuntimeError("trade stream already has an active iterator")
        backoff = 0.5
        request_id = 0
        try:
            while not self._stop.is_set():
                socket = None
                try:
                    headers = {"X-API-Key": self._api_key} if self._api_key else {}
                    socket = ws_client.connect(
                        f"{self._ws_url}/ws", additional_headers=headers,
                        ping_interval=15, ping_timeout=10,
                    )
                    self._ws = socket
                    if self._stop.is_set():
                        return
                    backoff = 0.5
                    request_id += 1
                    socket.send(json.dumps({
                        "method": "subscribe", "id": request_id,
                        "params": {"channel": "trades", "market": self._market},
                    }))
                    for raw in socket:
                        if self._stop.is_set():
                            return
                        try:
                            frame = json.loads(raw)
                        except (ValueError, TypeError):
                            log.warning("trade stream ignored invalid JSON")
                            continue
                        if not isinstance(frame, dict):
                            continue
                        if frame.get("type") == "error":
                            # Gateway errors can omit channel and market; the
                            # subscribe request ID binds them to this caller.
                            if type(frame.get("id")) is int and frame["id"] == request_id:
                                yield frame
                        elif (
                            frame.get("channel") == "trades"
                            and frame.get("type") == "trade"
                            and type(frame.get("market")) is int
                            and frame["market"] == self._market
                        ):
                            yield frame
                except Exception:
                    if self._stop.is_set():
                        return
                    log.warning("trade stream disconnected; reconnecting")
                finally:
                    if self._ws is socket:
                        self._ws = None
                    if socket is not None:
                        socket.close()
                if self._stop.wait(min(backoff, self._backoff_cap)):
                    return
                backoff = min(backoff * 2, self._backoff_cap)
        finally:
            try:
                self.close()
            finally:
                self._iterator_lock.release()
