"""Upgrade refusals fail initial connections, but preserve reconnect recovery."""

import pytest
import websockets.sync.client as ws_client
from websockets.datastructures import Headers
from websockets.exceptions import InvalidStatus
from websockets.http11 import Response

from proof_trading_sdk import AccountEventStream
from proof_trading_sdk.errors import AuthenticationError, TransportError
from test_ws_streams import OWNER, A, B, FakeSocket, indexed, live_frame, page, snap, tags


def refusal(code):
    return InvalidStatus(Response(code, "Forbidden", Headers()))


def connections(monkeypatch, outcomes):
    pending = iter(outcomes)
    calls = []

    def connect(*args, **kwargs):
        calls.append(1)
        outcome = next(pending)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(ws_client, "connect", connect)
    return calls


def no_wait(monkeypatch, stream):
    waits = []
    monkeypatch.setattr(stream._stop, "wait", lambda delay: waits.append(delay) or False)
    return waits


@pytest.mark.parametrize("code", [401, 403])
def test_upgrade_refusal_before_any_connection_still_fails(monkeypatch, code):
    calls = connections(monkeypatch, [refusal(code)])
    stream = AccountEventStream("wss://gateway.example", OWNER)
    waits = no_wait(monkeypatch, stream)
    with pytest.raises(AuthenticationError):
        next(iter(stream))
    assert len(calls) == 1 and waits == []
    assert stream._closed


@pytest.mark.parametrize("code", [401, 403])
def test_reconnect_refusal_preserves_history_boundary_and_renews_auth(monkeypatch, code):
    first = FakeSocket([snap(9), live_frame(A)])
    second = FakeSocket([snap(10), live_frame(B)])
    calls = connections(monkeypatch, [first, refusal(code), refusal(code), second])
    auth_calls = []

    def auth():
        auth_calls.append(1)
        return {"timestamp_ms": len(auth_calls)}

    statuses = []
    stream = AccountEventStream("wss://gateway.example", OWNER, auth=auth,
                                on_recovery=statuses.append)
    waits = no_wait(monkeypatch, stream)
    reads = []

    def get(path, params=None):
        reads.append(path)
        return indexed(10) if path.endswith("/status") else page(A, B)

    monkeypatch.setattr(stream, "_get", get)
    frames = iter(stream)
    try:
        received = [next(frames) for _ in range(4)]
        assert tags(received) == ["snapshot", "10-0", "snapshot", "10-1*"]
        assert len(calls) == 4 and waits == [0.5, 1, 2]
        assert len(auth_calls) == 2
        assert first.sent[0]["params"]["timestamp_ms"] == 1
        assert second.sent[0]["params"]["timestamp_ms"] == 2
        assert reads == ["/v1/history/status", "/v1/history/account-events"]
        assert first.closed and not stream._closed
    finally:
        stream.close()
        frames.close()
    assert second.closed


@pytest.mark.parametrize("code", [401, 403])
def test_reconnect_refusal_respects_attempt_limit(monkeypatch, code):
    first = FakeSocket([snap(10)])
    calls = connections(monkeypatch, [first, refusal(code), refusal(code)])
    stream = AccountEventStream("wss://gateway.example", OWNER, reconnect_attempts=2)
    waits = no_wait(monkeypatch, stream)
    frames = iter(stream)
    assert next(frames) == snap(10)
    with pytest.raises(TransportError, match="reconnect attempts exhausted"):
        next(frames)
    assert len(calls) == 3 and waits == [0.5, 1]
    assert first.closed
    stream.close()


@pytest.mark.parametrize("code", [401, 403])
def test_close_during_refusal_backoff_prevents_reconnect(monkeypatch, code):
    first = FakeSocket([snap(10)])
    calls = connections(monkeypatch, [first, refusal(code)])
    stream = AccountEventStream("wss://gateway.example", OWNER)
    waits = []

    def wait(delay):
        waits.append(delay)
        if len(waits) == 2:
            stream.close()
        return stream._stop.is_set()

    monkeypatch.setattr(stream._stop, "wait", wait)
    assert list(stream) == [snap(10)]
    assert len(calls) == 2 and waits == [0.5, 1]
    assert first.closed and stream._closed
