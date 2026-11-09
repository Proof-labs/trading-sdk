"""Account subscription lifecycle parity with the TypeScript feed."""
import json
from contextlib import closing

import pytest
import websockets.sync.client as ws_client

import proof_trading_sdk as pts
from proof_trading_sdk import _native
from proof_trading_sdk.errors import SigningError
from test_account_auth import CHAIN, FIXTURE, NOW, OWNER, SEED, client, handle
from test_ws_streams import FakeSocket


class NoWait:
    def wait(self, _timeout):
        return False

    def set(self):
        pass


def data(kind="snapshot", owner=OWNER):
    return {"type": kind, "channel": "accountEvents", "owner": owner}


class Clock:
    value = 0.0

    def __init__(self, monkeypatch):
        self.waits = []
        monkeypatch.setattr("time.monotonic", lambda: self.value)
        monkeypatch.setattr("time.time_ns", lambda: (NOW + int(self.value * 1000)) * 1_000_000)


class ScriptSocket(FakeSocket):
    def __init__(self, clock, reply=None):
        super().__init__([])
        self.clock, self.reply = clock, reply
        self.on_wait = None

    def send(self, raw):
        super().send(raw)
        if self.reply:
            self._frames.extend(json.dumps(f) for f in self.reply(self.sent[-1], len(self.sent)))

    def recv(self, timeout=None):
        if self._frames:
            return self._frames.pop(0)
        if timeout is None:
            raise AssertionError("healthy socket must remain quiet, without another subscription")
        self.clock.waits.append(timeout)
        self.clock.value += timeout
        if self.on_wait:
            self.on_wait()
        raise TimeoutError


def setup_stream(monkeypatch, reply=None, auth=None, api_key=None):
    clock = Clock(monkeypatch)
    socket = ScriptSocket(clock, reply)
    connects = []

    def connect(*args, **kwargs):
        connects.append(kwargs)
        return socket

    monkeypatch.setattr(ws_client, "connect", connect)
    c = client(secret_key=SEED)
    stream = pts.AccountEventStream("wss://gateway.example", OWNER, auth=auth or c.account_auth,
                                    api_key=api_key, recover=False)
    return c, stream, socket, clock, connects


@pytest.mark.parametrize("opaque", [False, True])
@pytest.mark.parametrize("cursor", [7, (1 << 53) - 1])
def test_cursor_matches_independent_signature(monkeypatch, opaque, cursor):
    monkeypatch.setattr("time.time_ns", lambda: NOW * 1_000_000)
    with closing(client(**({"key_handle": handle()} if opaque else {"secret_key": SEED}))) as c:
        auth = c.account_auth(OWNER, cursor)
        assert auth["after_id"] == cursor
        assert auth["signature"] == FIXTURE["cursor_signatures"][str(cursor)]
        assert auth["signature"] != c.account_auth()["signature"]


@pytest.mark.parametrize("cursor", [-1, 1 << 53, True, 1.5, "7", None])
def test_python_cursor_domain(cursor):
    with closing(client(secret_key=SEED)) as c:
        with pytest.raises(SigningError, match="cursor"):
            c.account_auth(after_id=cursor)


@pytest.mark.parametrize("cursor", [-1, 1 << 53])
def test_native_cursor_domain(cursor):
    with pytest.raises(ValueError, match="cursor"):
        _native.sign_account_ws_auth(CHAIN, NOW, SEED, cursor)
    with pytest.raises(ValueError, match="cursor"):
        handle().sign_account_ws_auth(CHAIN, NOW, cursor)


@pytest.mark.parametrize("code", [401, 429, 503])
def test_transient_refusal_retries_same_socket_with_fresh_auth(monkeypatch, code):
    def reply(msg, attempt):
        return [{"type": "error", "code": code, "id": msg["id"]}] if attempt == 1 else [data()]
    c, stream, socket, clock, connects = setup_stream(monkeypatch, reply)
    frames = iter(stream)
    try:
        assert next(frames)["code"] == code
        assert next(frames)["type"] == "snapshot"
        assert len(connects) == 1
        assert clock.waits == [0.5]
        a, b = [m["params"] for m in socket.sent]
        assert b["timestamp_ms"] == a["timestamp_ms"] + 500
        assert b["signature"] != a["signature"]
        assert "after_id" not in a and "after_id" not in b
        assert stream._confirmed and stream._auth_retry_attempts == 0
    finally:
        stream.close(); frames.close(); c.close()


def test_perpetual_backend_failure_has_six_attempts_no_unsigned_fallback(monkeypatch):
    calls = []
    class FailedHandle:
        owner = bytes.fromhex(OWNER)
        public_key = bytes.fromhex(FIXTURE["public_key"])
        def sign_account_ws_auth(self, chain_id, timestamp_ms, after_id=0):
            calls.append(timestamp_ms)
            raise ValueError("private backend diagnostic must not leak")
    c, stream, socket, clock, connects = setup_stream(monkeypatch)
    failed = client(key_handle=FailedHandle())
    stream._auth = failed.account_auth
    frames = iter(stream)
    try:
        errors = [next(frames) for _ in range(6)]
        assert all(f["type"] == "error" for f in errors)
        assert "not retrying after 5" in errors[-1]["error"]
        assert "diagnostic" not in str(errors)
        assert len(calls) == 6 and len(set(calls)) == 6
        assert clock.waits == [0.5, 1, 2, 4, 8]
        assert len(connects) == 1 and socket.sent == []
        assert stream._auth_retry_at is None and not socket.closed
        stream.close()
        with pytest.raises(StopIteration): next(frames)
    finally:
        stream.close(); frames.close(); failed.close(); c.close()


def test_perpetual_refusal_has_six_attempts_then_quiet(monkeypatch):
    c, stream, socket, clock, connects = setup_stream(monkeypatch,
        lambda msg, _: [{"type": "error", "code": 401, "id": msg["id"]}])
    frames = iter(stream)
    try:
        errors = [next(frames) for _ in range(7)]
        assert [f["code"] for f in errors[:-1]] == [401] * 6
        assert "not retrying" in errors[-1]["error"]
        assert len(socket.sent) == 6 and len(connects) == 1
        assert clock.waits == [0.5, 1, 2, 4, 8]
        assert stream._auth_retry_at is None and not stream._confirmed
        assert not socket.closed
    finally:
        stream.close(); frames.close(); c.close()


@pytest.mark.parametrize("confirmed_by", ["subscribed", "fill", None])
def test_forbidden_and_confirmed_errors_do_not_retry_or_interrupt_data(monkeypatch, confirmed_by):
    code = 403 if confirmed_by is None else 401
    def reply(msg, _):
        ack = ({"type": "subscribed", "id": msg["id"]} if confirmed_by == "subscribed" else data("fill"))
        return ([ack] if confirmed_by else []) + [{"type": "error", "code": code, "id": msg["id"]}, data("fill")]
    c, stream, socket, clock, _ = setup_stream(monkeypatch, reply)
    frames = iter(stream)
    try:
        if confirmed_by == "fill": assert next(frames)["type"] == "fill"
        assert next(frames)["code"] == code
        assert stream._auth_retry_at is None and not socket.closed
        assert next(frames)["type"] == "fill"
        assert len(socket.sent) == 1 and clock.waits == []
    finally:
        stream.close(); frames.close(); c.close()


@pytest.mark.parametrize("confirmation", ["subscribed", "fill"])
def test_confirmation_cancels_pending_retry(monkeypatch, confirmation):
    def reply(msg, _):
        confirm = {"type": "subscribed", "id": msg["id"]} if confirmation == "subscribed" else data("fill")
        return [{"type": "error", "code": 401, "id": msg["id"]}, confirm, data()]
    c, stream, socket, clock, _ = setup_stream(monkeypatch, reply)
    frames = iter(stream)
    try:
        assert next(frames)["code"] == 401
        if confirmation == "fill": assert next(frames)["type"] == "fill"
        assert next(frames)["type"] == "snapshot"
        assert stream._auth_retry_at is None and len(socket.sent) == 1
    finally:
        stream.close(); frames.close(); c.close()


def test_retry_not_starved_by_queued_control_frames(monkeypatch):
    c, stream, socket, clock, _ = setup_stream(monkeypatch,
        lambda msg, n: [{"type": "error", "code": 503, "id": msg["id"]}, {"type": "pong"}] if n == 1 else [data()])
    frames = iter(stream)
    try:
        next(frames)
        clock.value = 1
        assert next(frames)["type"] == "snapshot"
        assert len(socket.sent) == 2
    finally:
        stream.close(); frames.close(); c.close()


def test_stale_refusal_id_does_not_retry(monkeypatch):
    c, stream, socket, _, _ = setup_stream(monkeypatch,
        lambda msg, _: [{"type": "error", "code": 401, "id": msg["id"] + 10}, data()])
    frames = iter(stream)
    try:
        next(frames)
        assert stream._auth_retry_at is None
        assert next(frames)["type"] == "snapshot"
        assert len(socket.sent) == 1
    finally:
        stream.close(); frames.close(); c.close()


def test_close_during_backoff_prevents_next_attempt(monkeypatch):
    c, stream, socket, _, _ = setup_stream(monkeypatch,
        lambda msg, _: [{"type": "error", "code": 401, "id": msg["id"]}])
    socket.on_wait = stream.close
    frames = iter(stream)
    try:
        next(frames)
        with pytest.raises(StopIteration): next(frames)
        assert len(socket.sent) == 1 and socket.closed
    finally:
        stream.close(); frames.close(); c.close()


def test_close_during_signing_discards_result(monkeypatch):
    c, stream, socket, _, _ = setup_stream(monkeypatch)
    def auth():
        result = c.account_auth()
        stream.close()
        return result
    stream._auth = auth
    assert list(stream) == []
    assert socket.sent == [] and socket.closed
    c.close()


def test_reconnect_resets_exhausted_budget(monkeypatch):
    c, stream, first, clock, _ = setup_stream(monkeypatch,
        lambda msg, _: [{"type": "error", "code": 401, "id": msg["id"]}])
    second = ScriptSocket(clock, lambda msg, n: [{"type": "error", "code": 401, "id": msg["id"]}] if n == 1 else [data()])
    sockets = iter([first, second])
    monkeypatch.setattr(ws_client, "connect", lambda *a, **kw: next(sockets))
    stream._stop = NoWait()
    frames = iter(stream)
    try:
        for _ in range(7): next(frames)
        def disconnected(timeout=None): raise EOFError("peer disconnected")
        first.recv = disconnected
        assert next(frames)["code"] == 401
        assert stream._auth_retry_attempts == 1
        assert next(frames)["type"] == "snapshot"
        assert len(first.sent) == 6 and len(second.sent) == 2 and first.closed
        assert stream._confirmed and stream._auth_retry_attempts == 0
    finally:
        stream.close(); frames.close(); c.close()


def test_recovery_drain_filters_other_accounts_and_channels():
    from test_ws_streams import RecoverySocket
    stream = pts.AccountEventStream("wss://gateway.example", OWNER)
    error = {"type": "error", "code": 403}
    stream._ws = RecoverySocket([], [data("fill", "00" * 20), {"type": "update", "channel": "orderbook"}, data("fill"), error])
    buffered = []
    stream._drain(buffered)
    assert buffered == [data("fill"), error]
    assert stream._last is None
    stream.close()


def test_transient_signer_failure_then_success(monkeypatch):
    c, stream, socket, clock, _ = setup_stream(monkeypatch, lambda *_: [data()])
    calls = []
    def auth():
        calls.append(clock.value)
        if len(calls) == 1:
            raise SigningError("device busy")
        return c.account_auth()
    stream._auth = auth
    frames = iter(stream)
    try:
        assert "retrying" in next(frames)["error"]
        assert socket.sent == []
        assert next(frames)["type"] == "snapshot"
        assert calls == [0, 0.5] and len(socket.sent) == 1
        assert socket.sent[0]["params"]["timestamp_ms"] == NOW + 500
    finally:
        stream.close(); frames.close(); c.close()


def test_api_key_only_retry_keeps_header(monkeypatch):
    c, stream, socket, _, connects = setup_stream(monkeypatch,
        lambda msg, n: [{"type": "error", "code": 429, "id": msg["id"]}] if n == 1 else [data()])
    stream.close()
    keyed = client(api_key="test-key")
    monkeypatch.setattr(keyed, "account_auth", lambda *_: pytest.fail("must not sign API key subscriptions"))
    stream = keyed.account_event_stream(OWNER)
    frames = iter(stream)
    try:
        assert next(frames)["code"] == 429
        assert next(frames)["type"] == "snapshot"
        assert connects == [{"additional_headers": {"X-API-Key": "test-key"}}]
        assert all(m["params"] == {"channel": "accountEvents", "owner": OWNER} for m in socket.sent)
    finally:
        stream.close(); frames.close(); keyed.close(); c.close()


def test_owner_mismatch_is_bounded_without_unsigned_subscription(monkeypatch):
    c, stream, socket, _, _ = setup_stream(monkeypatch)
    stream._auth = lambda: c.account_auth("00" * 20)
    frames = iter(stream)
    try:
        errors = [next(frames) for _ in range(6)]
        assert "not retrying" in errors[-1]["error"]
        assert socket.sent == []
    finally:
        stream.close(); frames.close(); c.close()


def test_confirmed_signer_failure_preserves_live_subscription(monkeypatch):
    c, stream, socket, _, _ = setup_stream(monkeypatch, lambda *_: [data(), data("fill")])
    frames = iter(stream)
    try:
        assert next(frames)["type"] == "snapshot"
        def unavailable(): raise SigningError("device unavailable")
        stream._auth = unavailable
        assert list(stream._subscribe()) == []
        assert stream._auth_retry_at is None and len(socket.sent) == 1
        assert next(frames)["type"] == "fill"
    finally:
        stream.close(); frames.close(); c.close()


def test_exhausted_stream_blocks_until_close_without_reconnecting(monkeypatch):
    import threading
    c, stream, socket, _, connects = setup_stream(monkeypatch,
        lambda msg, _: [{"type": "error", "code": 401, "id": msg["id"]}])
    frames = iter(stream)
    waiting = threading.Event()
    stopped = threading.Event()
    try:
        for _ in range(7):
            next(frames)
        def quiet_recv(timeout=None):
            assert timeout is None
            waiting.set()
            assert stopped.wait(2)
            raise EOFError("closed")
        socket.recv = quiet_recv
        original_close = socket.close
        def close():
            original_close()
            stopped.set()
        socket.close = close
        outcomes = []
        def consume():
            try:
                outcomes.append(next(frames))
            except StopIteration:
                outcomes.append("closed")
        worker = threading.Thread(target=consume)
        worker.start()
        assert waiting.wait(2)
        assert len(socket.sent) == 6 and len(connects) == 1
        stream.close()
        worker.join(2)
        assert not worker.is_alive() and outcomes == ["closed"]
    finally:
        stream.close(); stopped.set(); frames.close(); c.close()


def test_close_while_connecting_never_calls_signer(monkeypatch):
    stream = pts.AccountEventStream("wss://gateway.example", OWNER,
        auth=lambda: pytest.fail("closed stream must not start signing"))
    socket = FakeSocket([])
    def connect(*args, **kwargs):
        stream.close()
        return socket
    monkeypatch.setattr(ws_client, "connect", connect)
    assert list(stream) == []
    assert socket.sent == [] and socket.closed


@pytest.mark.parametrize("opaque", [False, True])
def test_stale_api_key_does_not_suppress_valid_signer(monkeypatch, opaque):
    clock = Clock(monkeypatch)
    socket = ScriptSocket(clock, lambda msg, _: [data()] if "signature" in msg["params"] else [
        {"type": "error", "code": 401, "id": msg["id"]}])
    headers = []
    def connect(*args, **kwargs):
        headers.append(kwargs["additional_headers"])
        return socket
    monkeypatch.setattr(ws_client, "connect", connect)
    c = client(api_key="stale-key", **({"key_handle": handle()} if opaque else {"secret_key": SEED}))
    stream = c.account_event_stream(OWNER)
    frames = iter(stream)
    try:
        assert next(frames)["type"] == "snapshot"
        assert headers == [{"X-API-Key": "stale-key"}]
        assert socket.sent[0]["params"]["signature"] == FIXTURE["signature"]
        assert len(socket.sent) == 1
    finally:
        stream.close(); frames.close(); c.close()


def test_api_key_with_signer_still_requires_matching_owner(monkeypatch):
    clock = Clock(monkeypatch)
    socket = ScriptSocket(clock)
    monkeypatch.setattr(ws_client, "connect", lambda *args, **kwargs: socket)
    c = client(secret_key=SEED, api_key="authorized-key")
    stream = c.account_event_stream("00" * 20)
    frames = iter(stream)
    try:
        assert "retrying" in next(frames)["error"]
        assert socket.sent == []
    finally:
        stream.close(); frames.close(); c.close()


@pytest.mark.parametrize("opaque", [False, True])
def test_unbound_chain_fails_before_signing(monkeypatch, opaque):
    import proof_trading_sdk.client as client_module
    monkeypatch.setattr(client_module, "sign_account_ws_auth", lambda *args: pytest.fail("must not sign"))
    c = client(**({"key_handle": handle()} if opaque else {"secret_key": SEED}))
    c._chain_id = bytes(32)
    try:
        with pytest.raises(SigningError, match="chain_id not configured"):
            c.account_auth()
    finally:
        c.close()


def test_unbound_chain_stream_never_sends_unsigned_subscription(monkeypatch):
    c, stream, socket, _, _ = setup_stream(monkeypatch)
    c._chain_id = bytes(32)
    frames = iter(stream)
    try:
        assert "retrying" in next(frames)["error"]
        assert socket.sent == []
    finally:
        stream.close(); frames.close(); c.close()
