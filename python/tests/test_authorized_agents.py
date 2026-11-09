"""Complete current grants: canonical wire DTO, binding and bounded transport."""
import base64
from contextlib import closing
from dataclasses import FrozenInstanceError
import json
from types import SimpleNamespace

import httpx
import msgpack
import pytest

from proof_trading_sdk import AuthorizedAgentsSnapshot, ExchangeClient, SdkConfig
from proof_trading_sdk import _native
from proof_trading_sdk.authorized_agents import _decode_snapshot
import proof_trading_sdk.authorized_agents as module
from proof_trading_sdk.errors import AuthenticationError, CodecError, GatewayError, RateLimited, TransportError

OWNER = bytes([1]) * 20
HEX = OWNER.hex()
HEIGHT = (1 << 53) + 1


def raw(**changes):
    value = dict(owner=OWNER, finalized_height=HEIGHT, agents=[bytes([2]) * 20], complete=True)
    value.update(changes)
    return value


def envelope(value=None, **witness_changes):
    witness = dict(version=1, nodeId="ab" * 20, height=str(HEIGHT), finalizedBlockTimeMs="123000", appHash="cd" * 32)
    witness.update(witness_changes)
    return dict(data=base64.b64encode(msgpack.packb(raw() if value is None else value)).decode(), witness=witness)


def body(value=None, **witness_changes):
    return json.dumps(envelope(value, **witness_changes)).encode()


def client_for(handler):
    client = ExchangeClient(config=SdkConfig(gateway_url="https://gateway.example"))
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(handler))
    return closing(client)


def test_two_grants_then_each_revoke_returns_fresh_complete_snapshots():
    calls = []
    # Authoritative endpoint fixtures after two grants, one revocation, then
    # the final revocation. The SDK must query each state, never infer history.
    responses = iter([
        body(raw(agents=[bytes([2]) * 20, bytes([3]) * 20])),
        body(raw(agents=[bytes([3]) * 20], finalized_height=HEIGHT + 1), height=str(HEIGHT + 1)),
        body(raw(agents=[], finalized_height=HEIGHT + 2), height=str(HEIGHT + 2)),
    ])
    def handler(request):
        calls.append(request)
        return httpx.Response(200, content=next(responses))
    with client_for(handler) as client:
        granted = client.authorized_agents(OWNER)
        one_left = client.authorized_agents("0x" + HEX)
        revoked = client.authorized_agents(HEX)
    assert isinstance(granted, AuthorizedAgentsSnapshot)
    assert granted.agents == ("02" * 20, "03" * 20)
    assert one_left.agents == ("03" * 20,)
    assert revoked.agents == ()  # No owner-key or inherited authority invented.
    assert [s.finalized_height for s in (granted, one_left, revoked)] == [HEIGHT, HEIGHT + 1, HEIGHT + 2]
    assert granted.owner == one_left.owner == revoked.owner == HEX
    assert len(calls) == 3
    assert all(str(r.url) == f"https://gateway.example/v2/account/{HEX}/agents?witness=1" for r in calls)
    assert all(r.headers["accept-encoding"] == "identity" for r in calls)
    with pytest.raises(FrozenInstanceError):
        granted.owner = "03" * 20


def test_exact_limit_complete_succeeds_but_partial_is_never_returned():
    agents = [n.to_bytes(20, "big") for n in range(100)]
    assert len(_decode_snapshot(body(raw(agents=agents)), HEX).agents) == 100
    with pytest.raises(CodecError, match="incomplete list"):
        _decode_snapshot(body(raw(agents=agents, complete=False)), HEX)


@pytest.mark.parametrize("change", [
    {"owner": bytes(19)}, {"owner": bytes([3]) * 20}, {"owner": "01" * 20},
    {"finalized_height": HEIGHT - 1}, {"finalized_height": True}, {"finalized_height": 1.5},
    {"finalized_height": -1},
    {"agents": [bytes(19)]}, {"agents": [bytes(21)]}, {"agents": ["02" * 20]},
    {"agents": [bytes([3]) * 20, bytes([2]) * 20]},
    {"agents": [bytes([2]) * 20, bytes([2]) * 20]},
    {"agents": [n.to_bytes(20, "big") for n in range(101)]},
    {"complete": False}, {"complete": 1}, {"complete": "true"},
])
def test_malformed_or_wrongly_bound_wire_fields_refuse(change):
    with pytest.raises(CodecError):
        _decode_snapshot(body(raw(**change)), HEX)


@pytest.mark.parametrize("field", ["owner", "finalized_height", "agents", "complete"])
def test_missing_wire_fields_are_not_defaulted(field):
    value = raw()
    value.pop(field)
    with pytest.raises(CodecError):
        _decode_snapshot(body(value), HEX)


@pytest.mark.parametrize("change", [
    {"version": True}, {"version": 1.0}, {"version": 2},
    {"nodeId": "00" * 20}, {"nodeId": "AB" * 20}, {"nodeId": "ab" * 19},
    {"height": str(HEIGHT - 1)}, {"height": HEIGHT}, {"height": "0"}, {"height": "01"},
    {"height": str(1 << 63)}, {"finalizedBlockTimeMs": "0"}, {"finalizedBlockTimeMs": True},
    {"appHash": "00" * 32}, {"appHash": "xyz"},
])
def test_invalid_or_mismatched_witness_refuses(change):
    with pytest.raises(CodecError):
        _decode_snapshot(body(**change), HEX)


@pytest.mark.parametrize("value", [None, {}, [], {"data": ""}, {"data": "", "witness": None}])
def test_missing_envelopes_never_look_like_no_grants(value):
    with pytest.raises(CodecError):
        _decode_snapshot(json.dumps(value).encode(), HEX)


@pytest.mark.parametrize("data", [" ", "!", "gA===", "gA", "gB==", "A" * 21849])
def test_noncanonical_or_oversized_base64_refuses(data):
    value = envelope()
    value["data"] = data
    with pytest.raises(CodecError):
        _decode_snapshot(json.dumps(value).encode(), HEX)


def test_duplicate_json_fields_and_non_utf8_refuse():
    original = body().decode()
    duplicate_top = original.replace('{"data":', '{"data":"ignored","data":', 1)
    duplicate_witness = original.replace('"version": 1', '"version": 2, "version": 1')
    for encoded in (duplicate_top.encode(), duplicate_witness.encode(), original.encode("utf-16"), b'{"x":NaN}'):
        with pytest.raises(CodecError):
            _decode_snapshot(encoded, HEX)


def test_native_decoder_requires_map_strict_msgpack_and_bounded_payload():
    payload = msgpack.packb(raw())
    duplicate = b"\x85" + payload[1:] + msgpack.packb("complete") + b"\xc2"
    for encoded in (msgpack.packb(list(raw().values())), payload + b"\xc0", duplicate, b"x" * 16385):
        with pytest.raises(ValueError):
            _native.decode_authorized_agents(encoded)
    # Forward-compatible named fields cannot change authority or completeness.
    assert _decode_snapshot(body(raw(future="ignored")), HEX).agents == ("02" * 20,)


@pytest.mark.parametrize("owner", [b"", bytes(19), bytes(21), "../agents", "01" * 19, True])
def test_invalid_owner_does_not_issue_request(owner):
    def handler(_):
        raise AssertionError("invalid owner must not issue HTTP")
    with client_for(handler) as client, pytest.raises(ValueError):
        client.authorized_agents(owner)


@pytest.mark.parametrize("timeout", [0, -1, True, float("nan"), float("inf"), 61, 10 ** 1000])
def test_invalid_timeout_does_not_issue_request(timeout):
    def handler(_):
        raise AssertionError("invalid timeout must not issue HTTP")
    with client_for(handler) as client, pytest.raises(ValueError):
        client.authorized_agents(OWNER, timeout=timeout)


@pytest.mark.parametrize("status,error_type", [
    (201, TransportError), (301, TransportError), (401, AuthenticationError),
    (404, TransportError), (429, RateLimited), (503, GatewayError),
])
def test_unavailable_or_non_200_responses_never_return_empty_snapshot(status, error_type):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(status, content=body())
    with client_for(handler) as client, pytest.raises(error_type) as caught:
        client.authorized_agents(OWNER)
    assert len(calls) == 1  # No fallback to legacy routes or inferred history.
    if status == 404:
        assert caught.value.status_code == 404


@pytest.mark.parametrize("status,headers", [
    (200, {"X-RateLimit-Limit": "abc"}),
    (429, {"Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT"}),
])
def test_malformed_rate_limit_headers_raise_typed_transport_error(status, headers):
    with client_for(lambda _: httpx.Response(status, headers=headers, content=body())) as client:
        with pytest.raises(TransportError, match="invalid response headers"):
            client.authorized_agents(OWNER)


@pytest.mark.parametrize("error_type", [httpx.ConnectError, httpx.ReadTimeout])
def test_request_failures_raise_typed_transport_error(error_type):
    def handler(request):
        raise error_type("offline", request=request)
    with client_for(handler) as client, pytest.raises(TransportError, match="request failed"):
        client.authorized_agents(OWNER)


def test_exact_payload_and_http_body_limits_are_accepted():
    # Named future fields are ignored by the canonical DTO, but count toward budgets.
    value = raw(future=b"" )
    value["future"] = bytes(16384 - len(msgpack.packb(value)) - 1)
    assert len(msgpack.packb(value)) == 16384
    encoded = body(value)
    encoded += b" " * (32768 - len(encoded))
    assert len(encoded) == 32768
    with client_for(lambda _: httpx.Response(200, content=encoded)) as client:
        snapshot = client.authorized_agents(OWNER)
    assert snapshot.agents == ("02" * 20,)
    assert snapshot.app_hash == "CD" * 32


class Chunks(httpx.SyncByteStream):
    def __init__(self, chunks):
        self.chunks, self.read, self.closed = chunks, 0, False
    def __iter__(self):
        for chunk in self.chunks:
            self.read += 1
            yield chunk
    def close(self):
        self.closed = True


def test_compressed_response_refused_without_decoding_and_closes():
    stream = Chunks([b"not gzip"])
    with client_for(lambda _: httpx.Response(200, headers={"Content-Encoding": "gzip"}, stream=stream)) as client:
        with pytest.raises(CodecError, match="compressed"):
            client.authorized_agents(OWNER)
    assert stream.read == 0 and stream.closed


def test_oversized_body_stops_reading_and_closes():
    stream = Chunks([b" " * 32768, b"x", b"never read"])
    with client_for(lambda _: httpx.Response(200, stream=stream)) as client:
        with pytest.raises(CodecError, match="budget"):
            client.authorized_agents(OWNER)
    assert stream.read == 2 and stream.closed


def test_stream_deadline_refuses_incomplete_read(monkeypatch):
    times = iter([0, 10])
    monkeypatch.setattr(module, "time", SimpleNamespace(monotonic=lambda: next(times)))
    stream = Chunks([body()])
    with client_for(lambda _: httpx.Response(200, stream=stream)) as client:
        with pytest.raises(TransportError, match="deadline"):
            client.authorized_agents(OWNER, timeout=5)
    assert stream.closed


def test_error_prefix_deadline_stops_reading_and_preserves_http_error(monkeypatch):
    times = iter([0, 10])
    monkeypatch.setattr(module, "time", SimpleNamespace(monotonic=lambda: next(times)))
    stream = Chunks([b"error", b"must not read"])
    with client_for(lambda _: httpx.Response(503, stream=stream)) as client:
        with pytest.raises(GatewayError):
            client.authorized_agents(OWNER, timeout=5)
    assert stream.read == 1 and stream.closed
