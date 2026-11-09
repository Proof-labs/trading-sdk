"""The public stream is live-only and owns one cancelable connection."""
import json
import threading

import pytest
import websockets.sync.client as ws_client

from proof_trading_sdk import ExchangeClient, PublicTradeStream, SdkConfig

TRADE = {
    "channel": "trades", "type": "trade", "market": 7,
    "fillId": "18446744073709551615", "makerSide": "sell",
    "price": "9007199254740993", "quantity": "18446744073709551615",
    "payload": {"fill_id": "18446744073709551615", "new_field": "kept"},
}


class Socket:
    def __init__(self, *frames, send_error=False):
        self.frames = list(frames)
        self.sent = []
        self.closed = False
        self.send_error = send_error

    def send(self, data):
        if self.send_error:
            raise OSError("send failed")
        self.sent.append(json.loads(data))

    def __iter__(self):
        for frame in self.frames:
            if isinstance(frame, Exception):
                raise frame
            yield json.dumps(frame) if not isinstance(frame, str) else frame

    def close(self):
        self.closed = True


def connect_sockets(monkeypatch, *results):
    pending = iter(results)
    calls = []

    def connect(url, **kwargs):
        calls.append((url, kwargs))
        result = next(pending)
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(ws_client, "connect", connect)
    return calls


def fast_wait(monkeypatch, stream):
    waits = []
    monkeypatch.setattr(stream._stop, "wait", lambda delay: waits.append(delay) or False)
    return waits


def test_public_subscription_preserves_raw_trade_and_keepalive(monkeypatch):
    socket = Socket({"type": "subscribed", "id": 1, "channel": "trades"}, TRADE)
    calls = connect_sockets(monkeypatch, socket)
    with PublicTradeStream("wss://gateway.example/", 7) as stream:
        frames = iter(stream)
        assert next(frames) == TRADE
    frames.close()
    assert socket.closed
    assert calls == [("wss://gateway.example/ws", {
        "additional_headers": {}, "ping_interval": 15, "ping_timeout": 10,
    })]
    assert socket.sent == [{"method": "subscribe", "id": 1, "params": {"channel": "trades", "market": 7}}]


def test_filters_controls_other_channels_markets_and_invalid_json(monkeypatch):
    socket = Socket(
        "not json", [], None, {"type": "pong"},
        {"type": "error", "id": 99}, {"type": "error", "id": True},
        {"type": "error"}, {**TRADE, "channel": "accountEvents"},
        {**TRADE, "market": 8}, {**TRADE, "market": 7.0},
        {**TRADE, "type": "snapshot"}, TRADE,
    )
    calls = connect_sockets(monkeypatch, socket)
    with PublicTradeStream("ws://g", 7) as stream:
        frames = iter(stream)
        assert next(frames) == TRADE
        assert len(calls) == 1
    frames.close()


@pytest.mark.parametrize("code", [401, 403, 429, 503])
def test_matching_refusal_is_yielded_without_resubscribe(monkeypatch, code):
    error = {"type": "error", "id": 1, "code": code, "error": "refused"}
    socket = Socket(error, TRADE)
    connect_sockets(monkeypatch, socket)
    with PublicTradeStream("ws://g", 7) as stream:
        frames = iter(stream)
        assert next(frames) == error
        assert next(frames) == TRADE
        assert len(socket.sent) == 1
    frames.close()


@pytest.mark.parametrize("disconnect", [None, OSError("peer lost")])
def test_reconnect_is_fresh_subscription_without_replay_or_dedup(monkeypatch, disconnect):
    first = Socket(TRADE, *([disconnect] if disconnect else []))
    second = Socket({"type": "error", "id": 1, "code": 429}, TRADE)
    calls = connect_sockets(monkeypatch, first, second)
    with PublicTradeStream("ws://g", 7) as stream:
        waits = fast_wait(monkeypatch, stream)
        frames = iter(stream)
        assert next(frames) == TRADE
        # No snapshot/cursor/history: even a repeated fill passes through.
        assert next(frames) == TRADE
        assert first.closed
        assert waits == [0.5]
        assert len(calls) == 2
        assert second.sent == [{"method": "subscribe", "id": 2, "params": {"channel": "trades", "market": 7}}]
    frames.close()
    assert second.closed


def test_failed_connections_back_off_and_cap_like_typescript(monkeypatch):
    socket = Socket(TRADE)
    connect_sockets(monkeypatch, *([OSError("offline")] * 7), socket)
    with PublicTradeStream("ws://g", 7) as stream:
        waits = fast_wait(monkeypatch, stream)
        frames = iter(stream)
        assert next(frames) == TRADE
        assert waits == [0.5, 1, 2, 4, 8, 10, 10]
    frames.close()


def test_successful_connection_resets_backoff(monkeypatch):
    first, second = Socket(TRADE), Socket(TRADE)
    connect_sockets(monkeypatch, OSError(), OSError(), first, second)
    with PublicTradeStream("ws://g", 7, reconnect_backoff_max=1) as stream:
        waits = fast_wait(monkeypatch, stream)
        frames = iter(stream)
        assert next(frames) == TRADE
        assert next(frames) == TRADE
        assert waits == [0.5, 1, 0.5]
    frames.close()


def test_failed_send_closes_socket_before_reconnect(monkeypatch):
    first, second = Socket(send_error=True), Socket(TRADE)
    connect_sockets(monkeypatch, first, second)
    with PublicTradeStream("ws://g", 7) as stream:
        fast_wait(monkeypatch, stream)
        frames = iter(stream)
        assert next(frames) == TRADE
        assert first.closed
    frames.close()


def test_iterator_close_releases_socket_and_prevents_reopen(monkeypatch):
    socket = Socket(TRADE)
    calls = connect_sockets(monkeypatch, socket)
    stream = PublicTradeStream("ws://g", 7)
    frames = iter(stream)
    assert next(frames) == TRADE
    frames.close()
    assert socket.closed
    assert list(stream) == []
    assert len(calls) == 1


def test_only_one_iterator_can_consume_socket(monkeypatch):
    socket = Socket(TRADE, TRADE)
    connect_sockets(monkeypatch, socket)
    with PublicTradeStream("ws://g", 7) as stream:
        frames = iter(stream)
        assert next(frames) == TRADE
        with pytest.raises(RuntimeError, match="active iterator"):
            next(iter(stream))
        assert next(frames) == TRADE
    frames.close()


def test_close_during_connect_prevents_subscribe_and_closes_result(monkeypatch):
    stream = PublicTradeStream("ws://g", 7)
    socket = Socket(TRADE)

    def connect(*args, **kwargs):
        stream.close()
        return socket

    monkeypatch.setattr(ws_client, "connect", connect)
    assert list(stream) == []
    assert socket.closed and socket.sent == []


def test_close_cancels_backoff(monkeypatch):
    called = threading.Event()
    calls = []

    def connect(*args, **kwargs):
        calls.append(1)
        called.set()
        raise OSError("offline")

    monkeypatch.setattr(ws_client, "connect", connect)
    stream = PublicTradeStream("ws://g", 7)
    worker = threading.Thread(target=lambda: list(stream))
    worker.start()
    try:
        assert called.wait(1)
    finally:
        stream.close()
        worker.join(1)
    assert not worker.is_alive()
    assert calls == [1]


def test_close_wakes_blocked_receive_without_reconnect(monkeypatch):
    receiving, closed = threading.Event(), threading.Event()

    class BlockingSocket(Socket):
        def __iter__(self):
            receiving.set()
            assert closed.wait(2)
            return
            yield  # make this an iterator

        def close(self):
            super().close()
            closed.set()

    socket = BlockingSocket()
    calls = connect_sockets(monkeypatch, socket)
    stream = PublicTradeStream("ws://g", 7)
    worker = threading.Thread(target=lambda: list(stream))
    worker.start()
    try:
        assert receiving.wait(1)
    finally:
        stream.close()
        worker.join(1)
    assert not worker.is_alive() and socket.closed
    assert len(calls) == 1


def test_client_url_api_key_and_ws_override_never_require_signer(monkeypatch):
    first, second = Socket(TRADE), Socket(TRADE)
    calls = connect_sockets(monkeypatch, first, second)
    client = ExchangeClient(config=SdkConfig(gateway_url="https://gateway.example", api_key="test-key"))
    monkeypatch.setattr(client, "_own_owner", lambda: pytest.fail("public trades must not use signer"))
    try:
        with client.trade_stream(7) as stream:
            frames = iter(stream)
            assert next(frames) == TRADE
        frames.close()
        with client.trade_stream(7, ws_url="ws://separate.example", reconnect_backoff_max=2) as stream:
            frames = iter(stream)
            assert next(frames) == TRADE
        frames.close()
    finally:
        client.close()
    assert [url for url, _ in calls] == ["wss://gateway.example/ws", "ws://separate.example/ws"]
    assert all(opts["additional_headers"] == {"X-API-Key": "test-key"} for _, opts in calls)


@pytest.mark.parametrize("market", [-1, 2**32, True, 1.5, "7", None])
def test_invalid_market_is_refused_before_connect(market):
    with pytest.raises(ValueError, match="u32"):
        PublicTradeStream("ws://g", market)


@pytest.mark.parametrize("cap", [0, -1, float("nan"), float("inf"), True, "10"])
def test_invalid_backoff_is_refused(cap):
    with pytest.raises(ValueError, match="backoff"):
        PublicTradeStream("ws://g", 7, reconnect_backoff_max=cap)


@pytest.mark.parametrize("market", [0, 2**32 - 1])
def test_wire_market_boundaries(market):
    PublicTradeStream("ws://g", market).close()
