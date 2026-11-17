"""Bounded public gateway block reads reuse the client's managed transport."""
import json

import httpx
import pytest

import proof_trading_sdk as sdk
from proof_trading_sdk import _bounded_read
from test_evidence import CHAIN, H, block_wire


class Stream(httpx.SyncByteStream):
    def __init__(self, chunks):
        self.chunks = chunks
        self.closed = False
        self.reads = 0

    def __iter__(self):
        for chunk in self.chunks:
            self.reads += 1
            yield chunk

    def close(self):
        self.closed = True


@pytest.fixture
def client():
    c = sdk.ExchangeClient(config=sdk.SdkConfig(gateway_url="https://gateway.example",
                                               chain_id="ignored-default", api_key="test-key"))
    c._http.close()
    yield c
    c.close()


def mock(client, body=None, *, chunks=None, status=200, headers=None):
    stream = Stream([json.dumps(block_wire()).encode() if body is None else body] if chunks is None else chunks)
    seen = []
    def handler(request):
        seen.append(request)
        return httpx.Response(status, stream=stream, headers=headers or {})
    client._http = httpx.Client(transport=httpx.MockTransport(handler), headers=client._default_headers())
    return stream, seen


def read(client, **kwargs):
    return client.block_header(H, chain_id=CHAIN, **kwargs)


def test_exact_request_uses_explicit_pin_and_managed_client(client):
    stream, seen = mock(client, headers={"X-RateLimit-Remaining": "7"})
    result = read(client)
    assert result.height == H and result.time.endswith(".123456789Z")
    assert str(seen[0].url) == f"https://gateway.example/v1/block?height={H}"
    assert seen[0].headers["X-API-Key"] == "test-key"
    assert seen[0].headers["Accept-Encoding"] == "identity"
    assert seen[0].extensions["timeout"]["read"] == 5
    assert client.rate_limit_remaining("default") == 7
    assert len(seen) == 1 and stream.closed


def test_missing_pin_never_uses_constructor_or_environment_default(client):
    _, seen = mock(client)
    with pytest.raises(TypeError):
        client.block_header(H)
    assert seen == []


@pytest.mark.parametrize("height", [0, -1, 1 << 63, True, 1.0, "1", None])
def test_invalid_height_before_transport(client, height):
    _, seen = mock(client)
    with pytest.raises(sdk.GatewayReadError) as raised:
        client.block_header(height, chain_id=CHAIN)
    assert raised.value.kind == "malformed" and seen == []


@pytest.mark.parametrize("timeout", [0, -1, 0.0009, 60.001, True, float("nan"), float("inf"), "5"])
def test_invalid_timeout_before_transport(client, timeout):
    _, seen = mock(client)
    with pytest.raises(sdk.GatewayReadError) as raised:
        read(client, timeout=timeout)
    assert (raised.value.kind, raised.value.field) == ("configuration", "timeout")
    assert seen == []


@pytest.mark.parametrize("timeout", [0.001, 60])
def test_valid_timeout_boundaries(client, timeout, monkeypatch):
    monkeypatch.setattr(_bounded_read.time, "monotonic", lambda: 0)
    _, seen = mock(client)
    read(client, timeout=timeout)
    assert seen[0].extensions["timeout"]["read"] == timeout


@pytest.mark.parametrize("status,error", [(302, sdk.TransportError), (404, sdk.TransportError),
    (429, sdk.RateLimited), (401, sdk.AuthenticationError), (403, sdk.AuthenticationError),
    (500, sdk.GatewayError), (503, sdk.GatewayError)])
def test_http_refusals_preserve_class_without_reading_error_body(client, status, error):
    def never_read():
        pytest.fail("HTTP error body must not delay or replace its status")
        yield b""
    stream, seen = mock(client, status=status, chunks=never_read(),
                        headers={"Content-Encoding": "gzip", "Retry-After": "7", "Location": "https://other.example"})
    with pytest.raises(error) as raised:
        read(client)
    if isinstance(raised.value, sdk.TransportError):
        assert raised.value.status_code == status
    assert stream.closed and stream.reads == 0 and len(seen) == 1


def test_oversized_body_stops_and_closes(client):
    stream, _ = mock(client, chunks=[b" " * 65536] * 18)
    with pytest.raises(sdk.GatewayReadError) as raised:
        read(client)
    assert (raised.value.kind, raised.value.field) == ("limit", "responseBytes")
    assert stream.closed and stream.reads == 17


def test_exact_byte_limit_is_supported(client):
    body = json.dumps(block_wire()).encode()
    stream, _ = mock(client, body=body + b" " * (_bounded_read.MAX_READ_BYTES - len(body)))
    assert read(client).height == H and stream.closed


@pytest.mark.parametrize("length", ["1048577", "01", "-1", "bad", "9" * 100])
def test_content_length_is_checked_before_body(client, length):
    stream, _ = mock(client, headers={"Content-Length": length})
    with pytest.raises(sdk.GatewayReadError) as raised:
        read(client)
    assert raised.value.kind == "limit" and stream.reads == 0 and stream.closed


def test_compressed_success_is_refused_unread(client):
    stream, _ = mock(client, headers={"Content-Encoding": "gzip"})
    with pytest.raises(sdk.GatewayReadError) as raised:
        read(client)
    assert raised.value.kind == "malformed" and stream.reads == 0 and stream.closed


def test_fragmentation_limit(client):
    stream, _ = mock(client, chunks=[b" "] * 5000)
    with pytest.raises(sdk.GatewayReadError) as raised:
        read(client)
    assert (raised.value.kind, raised.value.field) == ("limit", "chunks")
    assert stream.reads == 4097 and stream.closed


def test_exact_fragmentation_limit(client):
    body = json.dumps(block_wire()).encode()
    body += b" " * (4096 - len(body))
    stream, _ = mock(client, chunks=[bytes([byte]) for byte in body])
    assert read(client).height == H and stream.reads == 4096 and stream.closed


def test_empty_chunk_is_not_silently_discarded(client):
    stream, _ = mock(client, chunks=[b"", b"unused"])
    with pytest.raises(sdk.GatewayReadError) as raised:
        read(client)
    assert (raised.value.kind, raised.value.field) == ("malformed", "body")
    assert stream.reads == 1 and stream.closed


@pytest.mark.parametrize("body", [b"", b"[]", b"null", b"{bad", b'{"x":NaN}', b'{"x":Infinity}', b'\xff',
    b'{"jsonrpc":"2.0","jsonrpc":"2.0"}', b'{"nested":{"x":1,"\\u0078":2}}',
    b'{"nested":[{"x":1,"x":2}]}'])
def test_malformed_json_utf8_and_all_depth_duplicates(client, body):
    stream, _ = mock(client, body=body)
    with pytest.raises(sdk.GatewayReadError) as raised:
        read(client)
    assert raised.value.kind == "malformed" and stream.closed


@pytest.mark.parametrize("arrays, succeeds", [(31, True), (32, False)])
def test_json_depth_budget(client, arrays, succeeds):
    value = block_wire()
    nested = 0
    for _ in range(arrays): nested = [nested]
    value["extra"] = nested
    mock(client, body=json.dumps(value).encode())
    if succeeds:
        assert read(client).height == H
    else:
        with pytest.raises(sdk.GatewayReadError) as raised:
            read(client)
        assert (raised.value.kind, raised.value.field) == ("limit", "JSON depth")


def test_quoted_brackets_do_not_count_as_json_depth(client):
    value = block_wire() | {"extra": '["\\' * 100}
    mock(client, body=json.dumps(value).encode())
    assert read(client).height == H


def test_body_deadline_and_closure(client, monkeypatch):
    clock = [0]
    monkeypatch.setattr(_bounded_read.time, "monotonic", lambda: clock[0])
    def slow():
        clock[0] = 6
        yield json.dumps(block_wire()).encode()
    stream, _ = mock(client, chunks=slow())
    with pytest.raises(sdk.GatewayReadError) as raised:
        read(client)
    assert raised.value.kind == "deadline" and stream.closed


def test_timeout_and_network_error_classes(client):
    for err, expected in [(httpx.ReadTimeout("slow"), sdk.GatewayReadError),
                          (httpx.ConnectError("offline"), sdk.TransportError)]:
        def handler(_request): raise err
        client._http = httpx.Client(transport=httpx.MockTransport(handler))
        with pytest.raises(expected) as raised:
            read(client)
        if isinstance(raised.value, sdk.GatewayReadError): assert raised.value.kind == "deadline"
        client._http.close()


def test_huge_timeout_stays_inside_configuration_error_boundary(client):
    _, seen = mock(client)
    with pytest.raises(sdk.GatewayReadError) as raised:
        read(client, timeout=10**5000)
    assert raised.value.kind == "configuration" and seen == []


def test_deadline_is_checked_after_json_decode(client, monkeypatch):
    clock = [0]
    monkeypatch.setattr(_bounded_read.time, "monotonic", lambda: clock[0])
    original = _bounded_read._parse_json
    def slow_decode(body):
        result = original(body)
        clock[0] = 6
        return result
    monkeypatch.setattr(_bounded_read, "_parse_json", slow_decode)
    stream, _ = mock(client)
    with pytest.raises(sdk.GatewayReadError) as raised:
        read(client)
    assert raised.value.kind == "deadline" and stream.closed


def test_utf8_bom_matches_browser_text_decoder(client):
    mock(client, body=b"\xef\xbb\xbf" + json.dumps(block_wire()).encode())
    assert read(client).height == H


def test_bad_header_binding_closes_response_without_fallback(client):
    value = block_wire()
    value["result"]["block"]["header"]["chain_id"] = "wrong"
    stream, seen = mock(client, body=json.dumps(value).encode())
    with pytest.raises(sdk.GatewayReadError) as raised:
        read(client)
    assert raised.value.kind == "binding" and stream.closed and len(seen) == 1
