"""Gateway-routing parity tests for the Python client.

Mirrors the TS `client.test.ts` owner-scoped (`POST /info`) and chain-endpoint
(`/v1/status`, `/v1/block`) routing tests: the gateway 404s owner-scoped GETs
and serves chain reads only under `/v1/*`, so the client must POST `/info` for
account / open-orders / withdrawal and hit `/v1/status` etc. for chain reads.
"""

from __future__ import annotations

import base64
import json

import httpx
import msgpack

from proof_trading_sdk.client import ExchangeClient


def _client(handler) -> ExchangeClient:
    """An ExchangeClient whose HTTP layer is a MockTransport running *handler*."""
    c = ExchangeClient(gateway_url="http://test-gateway", chain_id=b"\x00" * 32)
    c._http = httpx.Client(
        base_url="http://test-gateway", transport=httpx.MockTransport(handler)
    )
    return c


def _info_response(payload) -> httpx.Response:
    """Wrap *payload* the way the gateway returns `/info`: base64 msgpack in `data`."""
    data = base64.b64encode(msgpack.packb(payload)).decode()
    return httpx.Response(200, json={"data": data})


def test_account_posts_info_not_get_v1_account():
    calls: list[tuple[str, str, bytes]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path, request.read()))
        # tuple: [balance, positions, equity, total_mm, total_im, margin_ratio_bps]
        return _info_response([1_000, [], 2_000, 0, 0, 500])

    acct = _client(handler).account("aa" * 20)

    assert calls[0][0] == "POST"
    assert calls[0][1] == "/info"  # NOT /v1/account/* (which 404s on the gateway)
    assert json.loads(calls[0][2]) == {"type": "clearinghouseState", "user": "aa" * 20}
    assert acct.balances == {"USDC": 1_000}
    assert acct.margin["equity"] == 2_000
    assert acct.margin["margin_ratio_bps"] == 500


def test_account_decodes_positions():
    def handler(request: httpx.Request) -> httpx.Response:
        pos = [list(b"\x02" * 20), 1, "Buy", 6_675_000, 100, 0]
        return _info_response([5_000, [pos], 5_000, 0, 0, 0])

    acct = _client(handler).account("aa" * 20)
    assert len(acct.positions) == 1
    assert acct.positions[0]["market"] == 1
    assert acct.positions[0]["entry_price"] == 6_675_000
    assert acct.positions[0]["owner"] == b"\x02" * 20


def test_open_orders_posts_info():
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["path"] = request.url.path
        captured["body"] = json.loads(request.read())
        orders = [[7, 1, list(b"\x01" * 20), "Buy", 6_675_000, 100]]
        return _info_response(orders)

    orders = _client(handler).open_orders("bb" * 20)

    assert captured["method"] == "POST"
    assert captured["path"] == "/info"
    assert captured["body"] == {"type": "openOrders", "user": "bb" * 20}
    assert orders[0]["id"] == 7
    assert orders[0]["price"] == 6_675_000
    assert orders[0]["owner"] == b"\x01" * 20


def test_withdrawal_status_none_when_nil():
    def handler(request: httpx.Request) -> httpx.Response:
        return _info_response(None)  # engine encodes "not found" as msgpack nil

    assert _client(handler).withdrawal_status(123) is None


def test_status_routes_through_v1_status():
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        return httpx.Response(
            200, json={"result": {"sync_info": {"latest_block_height": "7"}}}
        )

    _client(handler).status()
    assert seen == ["/v1/status"]  # NOT bare /status (404s on the gateway)


def test_get_block_routes_through_v1_block():
    seen: list[tuple[str, dict[str, str]]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.path, dict(request.url.params)))
        return httpx.Response(200, json={"result": {}})

    _client(handler).get_block(42)
    assert seen[0][0] == "/v1/block"
    assert seen[0][1] == {"height": "42"}


def test_get_block_results_routes_through_v1():
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        return httpx.Response(200, json={"result": {}})

    _client(handler).get_block_results(7)
    assert seen == ["/v1/block_results"]


def test_markets_decodes_msgpack_config():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/markets"
        # market-config tuple (trailing optional fields omitted)
        cfg = [1, 1_000, 500, 5, 2, 3_600_000, 100, "Perp"]
        return _info_response([cfg])

    mkts = _client(handler).markets()
    assert len(mkts) == 1
    assert mkts[0]["market"] == 1
    assert mkts[0]["im_bps"] == 1_000
    assert mkts[0]["kind"] == "Perp"
    assert mkts[0]["sz_decimals"] is None  # omitted optional -> None


def test_orderbook_decodes_bids_asks():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/orderbook/1"
        return _info_response([[[6_675_000, 100, 2]], [[6_680_000, 50, 1]]])

    ob = _client(handler).orderbook(1)
    assert ob["bids"][0] == {"price": 6_675_000, "total_qty": 100, "order_count": 2}
    assert ob["asks"][0]["price"] == 6_680_000
