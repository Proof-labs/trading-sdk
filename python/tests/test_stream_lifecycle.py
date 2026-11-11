"""Every channel obeys the same transport lifecycle without losing its protocol."""
import json
import threading

import pytest
import websockets.sync.client as ws_client
from websockets.datastructures import Headers
from websockets.exceptions import InvalidStatus
from websockets.http11 import Response

from proof_trading_sdk import AccountEventStream, OrderbookDeltaStream, PublicTradeStream
from proof_trading_sdk.errors import AuthenticationError, TransportError

OWNER = "ab" * 20


@pytest.fixture(params=["account", "orderbook", "trades"])
def channel(request):
    return request.param


def make_stream(channel, url="ws://gateway", **kwargs):
    if channel == "account":
        return AccountEventStream(url, OWNER, **kwargs)
    if channel == "orderbook":
        return OrderbookDeltaStream(url, 7, **kwargs)
    return PublicTradeStream(url, 7, **kwargs)


def data_frame(channel):
    if channel == "account":
        return {"channel": "accountEvents", "type": "snapshot", "owner": OWNER}
    if channel == "orderbook":
        return {"channel": "orderbook", "type": "snapshot", "market": 7}
    return {"channel": "trades", "type": "trade", "market": 7, "fillId": "1"}


class Socket:
    def __init__(self, frame):
        self.frame = frame
        self.sent = []
        self.closed = False

    def send(self, raw):
        self.sent.append(json.loads(raw))

    def recv(self, timeout=None):
        if self.frame is None:
            raise EOFError("peer closed")
        frame, self.frame = self.frame, None
        return json.dumps(frame)

    def __iter__(self):
        while self.frame is not None:
            yield self.recv()

    def close(self):
        self.closed = True


@pytest.mark.parametrize("error", [
    InvalidStatus(Response(code, "Refused", Headers())) for code in (401, 403, 404, 429, 503)
] + [OSError("offline"), TimeoutError("connect timeout")])
def test_initial_failures_surface_for_every_channel(monkeypatch, channel, error):
    calls = []

    def connect(*args, **kwargs):
        calls.append(args)
        raise error

    monkeypatch.setattr(ws_client, "connect", connect)
    stream = make_stream(channel)
    monkeypatch.setattr(stream._stop, "wait", lambda _: pytest.fail("startup failure retried"))
    status = error.response.status_code if isinstance(error, InvalidStatus) else None
    with pytest.raises(AuthenticationError if status in (401, 403) else TransportError) as exc:
        next(iter(stream))
    if isinstance(exc.value, TransportError):
        assert exc.value.status_code == status
    assert len(calls) == 1
    assert stream._closed and not stream._iterator_lock.locked()


@pytest.mark.parametrize("suffix", ["", "/ws", "/ws/"])
def test_url_and_iterator_cleanup(monkeypatch, channel, suffix):
    frame = data_frame(channel)
    socket = Socket(frame)
    urls = []

    def connect(url, **kwargs):
        urls.append(url)
        return socket

    monkeypatch.setattr(ws_client, "connect", connect)
    stream = make_stream(channel, "ws://gateway/prefix" + suffix)
    frames = iter(stream)
    assert next(frames) == frame
    with pytest.raises(RuntimeError, match="active iterator"):
        next(iter(stream))
    frames.close()
    assert socket.closed and list(stream) == []
    assert urls == ["ws://gateway/prefix/ws"]


def test_close_during_connect_does_not_subscribe(monkeypatch, channel):
    stream = make_stream(channel)
    socket = Socket(data_frame(channel))

    def connect(*args, **kwargs):
        stream.close()
        return socket

    monkeypatch.setattr(ws_client, "connect", connect)
    assert list(stream) == []
    assert socket.closed and not socket.sent


def test_reconnect_closes_old_socket_before_backoff_and_resubscribes(monkeypatch, channel):
    first, last = Socket(data_frame(channel)), Socket(data_frame(channel))
    results = iter([first, OSError("offline"), last])

    def connect(*args, **kwargs):
        result = next(results)
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(ws_client, "connect", connect)
    with make_stream(channel, reconnect_backoff_max=0.75) as stream:
        waits = []

        def wait(delay):
            assert first.closed
            waits.append(delay)
            return False

        monkeypatch.setattr(stream._stop, "wait", wait)
        frames = iter(stream)
        assert next(frames) == next(frames) == data_frame(channel)
        assert waits == [0.5, 0.75]
        assert last.sent[0]["params"] == first.sent[0]["params"]
    frames.close()
    assert last.closed


def test_close_cancels_reconnect_wait(monkeypatch, channel):
    stream = make_stream(channel)
    frame = data_frame(channel)
    socket = Socket(frame)
    calls = []
    waiting = threading.Event()
    real_wait = stream._stop.wait

    def wait(delay):
        waiting.set()
        return real_wait(30)

    def connect(*args, **kwargs):
        calls.append(1)
        return socket

    monkeypatch.setattr(ws_client, "connect", connect)
    monkeypatch.setattr(stream._stop, "wait", wait)
    delivered = []
    worker = threading.Thread(target=lambda: delivered.extend(stream))
    worker.start()
    try:
        assert waiting.wait(2)
    finally:
        stream.close()
        worker.join(2)
    assert not worker.is_alive()
    assert delivered == [frame] and calls == [1] and socket.closed


@pytest.mark.parametrize("response", [None, "subscribed", "error"])
def test_empty_or_refused_sessions_keep_backoff(monkeypatch, channel, response):
    stream = make_stream(channel, reconnect_backoff_max=1.5)
    sockets, waits = [], []

    def connect(*args, **kwargs):
        frame = None if response is None else {
            "type": response, "id": len(sockets) + 1,
            "code": 403, "error": "refused",
        }
        socket = Socket(frame)
        sockets.append(socket)
        return socket

    def wait(delay):
        assert sockets[-1].closed
        waits.append(delay)
        if len(waits) == 3:
            stream.close()
            return True
        return False

    monkeypatch.setattr(ws_client, "connect", connect)
    monkeypatch.setattr(stream._stop, "wait", wait)
    list(stream)
    assert len(sockets) == 3
    assert waits == [0.5, 1.0, 1.5]


def test_account_reconnect_budget_survives_successful_handshakes(monkeypatch):
    stream = AccountEventStream("ws://gateway", OWNER, reconnect_attempts=2)
    sockets, waits = [], []

    def connect(*args, **kwargs):
        assert len(sockets) < 3, "handshake reset the reconnect budget"
        socket = Socket(None)
        sockets.append(socket)
        return socket

    monkeypatch.setattr(ws_client, "connect", connect)
    monkeypatch.setattr(stream._stop, "wait", lambda delay: waits.append(delay) or False)
    assert list(stream) == []
    assert len(sockets) == 3 and all(socket.closed for socket in sockets)
    assert waits == [0.5, 1.0]
    assert list(stream) == []


def test_data_delivery_resets_account_reconnect_budget_and_backoff(monkeypatch):
    stream = AccountEventStream("ws://gateway", OWNER, reconnect_attempts=2, recover=False)
    frame = data_frame("account")
    sockets = [Socket(None), Socket(frame), Socket(None), Socket(None)]
    calls, waits = [], []

    def connect(*args, **kwargs):
        assert len(calls) < len(sockets), "reconnect budget was not exhausted"
        socket = sockets[len(calls)]
        calls.append(socket)
        return socket

    monkeypatch.setattr(ws_client, "connect", connect)
    monkeypatch.setattr(stream._stop, "wait", lambda delay: waits.append(delay) or False)
    assert list(stream) == [frame]
    assert len(calls) == 4 and all(socket.closed for socket in sockets)
    assert waits == [0.5, 0.5, 1.0]


def test_account_history_uses_http_base_not_ws_path_or_query():
    with AccountEventStream("wss://gateway/prefix/ws/?region=test", OWNER) as stream:
        assert stream._history_url == "https://gateway/prefix"
        assert stream._ws_url == "wss://gateway/prefix/ws?region=test"


def test_closed_stream_is_empty_while_original_iterator_is_suspended(monkeypatch, channel):
    socket = Socket(data_frame(channel))
    monkeypatch.setattr(ws_client, "connect", lambda *args, **kwargs: socket)
    stream = make_stream(channel)
    frames = iter(stream)
    assert next(frames) == data_frame(channel)
    stream.close()
    assert list(stream) == []
    frames.close()
    assert socket.closed and not stream._iterator_lock.locked()


def test_reconnect_logs_type_attempt_and_delay_without_error_text(monkeypatch, channel, caplog):
    first, last = Socket(data_frame(channel)), Socket(data_frame(channel))
    results = iter([first, OSError("sensitive-key-material"), last])

    def connect(*args, **kwargs):
        result = next(results)
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(ws_client, "connect", connect)
    with make_stream(channel) as stream:
        monkeypatch.setattr(stream._stop, "wait", lambda _: False)
        frames = iter(stream)
        assert next(frames) == next(frames) == data_frame(channel)
    frames.close()
    first_reason = "EOFError" if channel == "account" else "peer closed"
    assert f"reconnect attempt 1 in 0.5s ({first_reason})" in caplog.text
    assert "reconnect attempt 2 in 1.0s (OSError)" in caplog.text
    assert "sensitive-key-material" not in caplog.text
