"""Atomic markets-snapshot read: engine vectors, open interest, refusals."""

from __future__ import annotations

import base64
import gzip
import json
from pathlib import Path

import httpx
import msgpack
import pytest

from proof_trading_sdk import (
    CodecError,
    GatewayError,
    MarketOpenInterest,
    RateLimited,
    TransportError,
    decode_markets_snapshot,
)
from proof_trading_sdk import client as client_module
from proof_trading_sdk._native import MAX_MARKETS_SNAPSHOT_BYTES
from proof_trading_sdk.client import ExchangeClient

_VECTORS = Path(__file__).parents[2] / "crates/proof-trading-sdk/src/market_snapshot"
CHAIN = bytes([7]) * 32


def _engine_bytes(name: str) -> bytes:
    return bytes.fromhex((_VECTORS / f"{name}.hex").read_text().strip())


def _body(raw: bytes) -> bytes:
    return json.dumps({"data": base64.b64encode(raw).decode()}).encode()


def _with_open_interest(rows: object) -> bytes:
    top = msgpack.unpackb(_engine_bytes("engine-66d50df7"), raw=False)
    top[4] = rows
    return _body(msgpack.packb(top))


def _client(handler) -> ExchangeClient:
    client = ExchangeClient(gateway_url="http://g", chain_id=CHAIN)
    client._http = httpx.Client(
        base_url="http://g", transport=httpx.MockTransport(handler)
    )
    return client


def test_an_endless_body_is_refused_once_it_passes_the_limit():
    sent: list[int] = []

    def endless():
        while True:
            sent.append(1)
            yield b" " * 65_536

    client = _client(lambda request: httpx.Response(200, content=endless()))
    with pytest.raises(CodecError, match="exceeds"):
        client.markets_snapshot()
    assert len(sent) * 65_536 <= MAX_MARKETS_SNAPSHOT_BYTES + 65_536


def test_a_body_that_trickles_in_past_the_deadline_is_refused(monkeypatch):
    clock = iter(range(0, 1_000, 6))
    monkeypatch.setattr(client_module.time, "monotonic", lambda: next(clock))

    def trickle():
        for byte in _body(_engine_bytes("engine-66d50df7")):
            yield bytes([byte])

    client = _client(lambda request: httpx.Response(200, content=trickle()))
    with pytest.raises(TransportError, match="not complete within"):
        client.markets_snapshot(timeout=10.0)


def test_an_error_body_that_trickles_in_still_fails_by_the_deadline(monkeypatch):
    clock = iter(range(0, 1_000, 6))
    monkeypatch.setattr(client_module.time, "monotonic", lambda: next(clock))
    sent: list[int] = []

    def trickle():
        for byte in b"upstream unavailable" * 20:
            sent.append(1)
            yield bytes([byte])

    client = _client(lambda request: httpx.Response(500, content=trickle()))
    with pytest.raises(GatewayError):
        client.markets_snapshot(timeout=10.0)
    assert len(sent) == 2


def test_the_snapshot_is_requested_uncompressed_and_a_compressed_one_refused():
    seen: list[str] = []
    bomb = gzip.compress(b" " * (8 * MAX_MARKETS_SNAPSHOT_BYTES))

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers["Accept-Encoding"])
        return httpx.Response(
            200, headers={"Content-Encoding": "gzip"}, content=bomb
        )

    with pytest.raises(CodecError, match="content encoding 'gzip'"):
        _client(handler).markets_snapshot()
    assert seen == ["identity"]


@pytest.mark.parametrize("status,error", [(429, RateLimited), (500, GatewayError)])
def test_a_compressed_error_keeps_its_classification(status, error):
    headers = {"Content-Encoding": "gzip", "Retry-After": "7"}
    client = _client(
        lambda request: httpx.Response(
            status, headers=headers, content=gzip.compress(b"busy")
        )
    )
    with pytest.raises(error) as raised:
        client.markets_snapshot()
    if status == 429:
        assert raised.value.retry_after_secs == 7.0


@pytest.mark.parametrize(
    "status,error",
    [
        (204, TransportError),
        (302, TransportError),
        (429, RateLimited),
        (500, GatewayError),
    ],
)
def test_only_http_200_supplies_a_snapshot(status, error):
    body = _body(_engine_bytes("engine-66d50df7"))
    headers = {"Location": "http://elsewhere/"} if status == 302 else {}
    client = _client(
        lambda request: httpx.Response(status, headers=headers, content=body)
    )
    with pytest.raises(error):
        client.markets_snapshot()


def test_client_reads_the_open_interest_a_current_engine_serves():
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        return httpx.Response(200, content=_body(_engine_bytes("engine-66d50df7")))

    snapshot = _client(handler).markets_snapshot()
    assert seen == ["/v1/markets-snapshot"]
    assert snapshot.chain_id == CHAIN
    assert snapshot.height == 9_007_199_254_740_993
    assert [m["market"] for m in snapshot.markets] == [1, 2]
    assert snapshot.open_interest == [
        MarketOpenInterest(
            market=1, long=9_007_199_254_740_993, short=9_007_199_254_740_993
        ),
        MarketOpenInterest(market=2, long=0, short=0),
    ]


def test_markets_take_the_shape_markets_returns():
    raw = _engine_bytes("engine-349fa9b")
    snapshot = decode_markets_snapshot(_body(raw), CHAIN)
    rows = msgpack.unpackb(raw, raw=False)[2]
    assert snapshot.markets == [ExchangeClient._decode_market_config(r) for r in rows]
    assert snapshot.markets[2]["kind"] == {"ConditionalPerp": [91, "Yes"]}
    assert snapshot.events[0]["attached_conditionals"] == [
        {"underlying_market": 15, "cpy_market": 9100, "cpn_market": 9101}
    ]


def test_a_node_without_open_interest_is_distinct_from_none_served():
    older = decode_markets_snapshot(_body(_engine_bytes("engine-349fa9b")), CHAIN)
    assert older.open_interest is None
    assert decode_markets_snapshot(_with_open_interest([]), CHAIN).open_interest == []


@pytest.mark.parametrize(
    "rows,fault",
    [
        ([[1, 3, 3], [1, 3, 3]], "DuplicateMarket"),
        ([[2, 0, 0], [1, 3, 3]], "UnorderedOpenInterest"),
        ([[1, -1, 3]], "Malformed"),
        ([[1, 3]], "Malformed"),
        ([None], "Malformed"),
        (None, "Malformed"),
    ],
)
def test_malformed_or_unordered_open_interest_refuses_the_whole_read(rows, fault):
    with pytest.raises(CodecError, match=f"markets snapshot: .*{fault}"):
        decode_markets_snapshot(_with_open_interest(rows), CHAIN)


def test_wrong_or_unbound_chain_refuses_the_read():
    body = _body(_engine_bytes("engine-66d50df7"))
    with pytest.raises(CodecError, match="WrongChain"):
        decode_markets_snapshot(body, bytes([8]) * 32)
    with pytest.raises(CodecError, match="zero binding"):
        decode_markets_snapshot(body, bytes(32))
