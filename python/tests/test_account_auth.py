"""Owner-only account auth matches the gateway and renews per connection."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
import websockets.sync.client as ws_client
from websockets.exceptions import InvalidStatus
from websockets.http11 import Response
from websockets.datastructures import Headers

import proof_trading_sdk as pts
from proof_trading_sdk import _native
from proof_trading_sdk.errors import AuthenticationError, SigningError
from test_ws_streams import FakeSocket

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "account_ws_auth.json").read_text())
SEED = bytes(range(32))
CHAIN = bytes.fromhex(FIXTURE["chain_id"])
OWNER = FIXTURE["owner"]
NOW = FIXTURE["timestamp_ms"]


def handle():
    read_fd, write_fd = os.pipe()
    os.write(write_fd, SEED)
    os.close(write_fd)
    return pts.load_key_from_fd(read_fd)


def client(**kwargs):
    return pts.ExchangeClient(
        config=pts.SdkConfig(gateway_url="https://gateway.example", api_key=""),
        chain_id=CHAIN,
        **kwargs,
    )


@pytest.mark.parametrize("opaque", [False, True])
def test_matches_independently_signed_gateway_fixture(monkeypatch, opaque):
    monkeypatch.setattr("time.time_ns", lambda: NOW * 1_000_000)
    c = client(**({"key_handle": handle()} if opaque else {"secret_key": SEED}))
    try:
        auth = c.account_auth("0X" + OWNER.upper())
        assert auth == {k: FIXTURE[k] for k in ("public_key", "signature", "timestamp_ms")}
        assert c.account_auth(bytes.fromhex(OWNER)) == auth
        assert c.account_auth() == auth
        assert "after_id" not in auth
    finally:
        c.close()


@pytest.mark.parametrize("chain", [b"", bytes(31), bytes(33)])
def test_native_auth_rejects_invalid_chain_binding(chain):
    with pytest.raises(ValueError, match="chain_id"):
        _native.sign_account_ws_auth(chain, NOW, SEED)
    with pytest.raises(ValueError, match="chain_id"):
        handle().sign_account_ws_auth(chain, NOW)


def test_native_auth_binds_chain_and_time():
    original = bytes.fromhex(FIXTURE["signature"])
    assert _native.sign_account_ws_auth(CHAIN, NOW, SEED) == original
    assert _native.sign_account_ws_auth(bytes(32), NOW, SEED) != original
    assert _native.sign_account_ws_auth(CHAIN, NOW + 1, SEED) != original
    with pytest.raises(ValueError, match="secret_key"):
        _native.sign_account_ws_auth(CHAIN, NOW, SEED[:-1])


@pytest.mark.parametrize("owner", ["00" * 20, "not-an-owner", bytes(19)])
def test_wrong_owner_never_opens_an_unsigned_connection(monkeypatch, owner):
    def unexpected_connect(*args, **kwargs):
        pytest.fail("authentication must fail before opening a connection")

    monkeypatch.setattr(ws_client, "connect", unexpected_connect)
    c = client(secret_key=SEED)
    stream = c.account_event_stream(owner)
    try:
        with pytest.raises(SigningError):
            next(iter(stream))
        assert stream._closed
    finally:
        c.close()


def test_missing_signer_reports_signing_error():
    c = client()
    try:
        with pytest.raises(SigningError):
            c.account_auth(OWNER)
    finally:
        c.close()


@pytest.mark.parametrize("opaque", [False, True])
def test_reconnect_renews_auth_and_closes_old_socket(monkeypatch, opaque):
    clock = [NOW]
    monkeypatch.setattr("time.time_ns", lambda: clock[0] * 1_000_000)
    sockets = [FakeSocket([{"type": "snapshot"}]), FakeSocket([{"type": "snapshot"}])]
    calls = []

    def connect(url, additional_headers):
        calls.append((url, additional_headers))
        return sockets[len(calls) - 1]

    monkeypatch.setattr(ws_client, "connect", connect)
    c = client(**({"key_handle": handle()} if opaque else {"secret_key": SEED}))
    stream = c.account_event_stream("0X" + OWNER.upper(), recover=False)
    frames = iter(stream)
    try:
        assert next(frames)["type"] == "snapshot"
        first = sockets[0].sent[0]["params"]
        assert first == {"channel": "accountEvents", "owner": OWNER, **c.account_auth()}
        clock[0] += 1_000
        assert next(frames)["type"] == "snapshot"
        second = sockets[1].sent[0]["params"]
        assert second["timestamp_ms"] == NOW + 1_000
        assert first["signature"] != second["signature"]
        assert sockets[0].closed
        assert calls == [("wss://gateway.example/ws", {})] * 2
    finally:
        stream.close()
        frames.close()
        c.close()
    assert sockets[1].closed


def test_api_key_keeps_other_owner_access_without_using_signer(monkeypatch):
    socket = FakeSocket([{"type": "snapshot"}])
    calls = []

    def connect(url, additional_headers):
        calls.append(additional_headers)
        return socket

    monkeypatch.setattr(ws_client, "connect", connect)
    c = client(secret_key=SEED, api_key="test-api-key")
    monkeypatch.setattr(c, "account_auth", lambda *_: pytest.fail("API key auth needs no signer"))
    other = "00" * 20
    stream = c.account_event_stream(other)
    frames = iter(stream)
    try:
        assert next(frames)["type"] == "snapshot"
        assert socket.sent[0]["params"] == {"channel": "accountEvents", "owner": other}
        assert calls == [{"X-API-Key": "test-api-key"}]
    finally:
        stream.close()
        frames.close()
        c.close()


def test_signing_backend_failure_is_reported_once_without_connection(monkeypatch):
    calls = []

    class FailedHandle:
        owner = bytes.fromhex(OWNER)
        public_key = bytes.fromhex(FIXTURE["public_key"])

        def sign_account_ws_auth(self, chain_id, timestamp_ms):
            calls.append((chain_id, timestamp_ms))
            raise ValueError("signing device unavailable")

    monkeypatch.setattr(ws_client, "connect", lambda *a, **kw: pytest.fail("unsigned fallback"))
    c = client(key_handle=FailedHandle())
    stream = c.account_event_stream(OWNER)
    try:
        with pytest.raises(SigningError):
            next(iter(stream))
        assert len(calls) == 1
        assert stream._closed
    finally:
        c.close()


@pytest.mark.parametrize("code", [401, 403])
def test_authentication_refusal_stops_and_closes_socket(monkeypatch, code):
    socket = FakeSocket([{"type": "error", "code": code, "id": 1, "error": "auth refused"}])
    calls = []

    def connect(*args, **kwargs):
        calls.append(1)
        return socket

    monkeypatch.setattr(ws_client, "connect", connect)
    c = client(secret_key=SEED)
    stream = c.account_event_stream(OWNER)
    try:
        with pytest.raises(AuthenticationError):
            next(iter(stream))
        assert calls == [1]
        assert socket.closed and stream._closed
    finally:
        c.close()


@pytest.mark.parametrize("code", [401, 403])
def test_upgrade_authentication_refusal_is_not_retried(monkeypatch, code):
    calls = []

    def connect(*args, **kwargs):
        calls.append(1)
        raise InvalidStatus(Response(code, "Forbidden", Headers()))

    monkeypatch.setattr(ws_client, "connect", connect)
    stream = pts.AccountEventStream("wss://gateway.example", OWNER, api_key="invalid")
    with pytest.raises(AuthenticationError):
        next(iter(stream))
    assert calls == [1]
    assert stream._closed


def test_non_authentication_refusal_remains_an_error_frame(monkeypatch):
    refusal = {"type": "error", "code": 429, "id": 1, "error": "subscription limit"}
    socket = FakeSocket([refusal])
    monkeypatch.setattr(ws_client, "connect", lambda *a, **kw: socket)
    stream = pts.AccountEventStream("wss://gateway.example", OWNER, api_key="key")
    frames = iter(stream)
    try:
        assert next(frames) == refusal
    finally:
        stream.close()
        frames.close()
