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
import pytest

from proof_trading_sdk.client import ExchangeClient
from proof_trading_sdk.errors import GatewayError, ProofTradingSdkError


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


def test_account_decodes_trailing_position_epoch_losslessly():
    epoch = 9_007_199_254_740_993

    def handler(request: httpx.Request) -> httpx.Response:
        pos = [list(b"\x02" * 20), 1, "Buy", 6_675_000, 100, 0]
        pos.extend([0] * 7)
        pos.append(epoch)
        return _info_response([5_000, [pos], 5_000, 0, 0, 0])

    position = _client(handler).account("aa" * 20).positions[0]
    assert position["position_epoch"] == epoch


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


def test_account_raises_on_error_body():
    # A JSON {error} body must NOT silently become an empty (balance-0) account.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"error": "internal node error"})

    with pytest.raises(ProofTradingSdkError):
        _client(handler).account("aa" * 20)


def test_account_raises_on_missing_data_envelope():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"unexpected": "shape"})

    with pytest.raises(ProofTradingSdkError):
        _client(handler).account("aa" * 20)


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


def test_history_fills_uses_opaque_cursor_and_preserves_u64_ids():
    seen: list[dict[str, str]] = []
    maximum = str((1 << 64) - 1)

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(dict(request.url.params))
        if len(seen) == 1:
            return httpx.Response(
                200,
                json={"fills": [{"fill_id": maximum}], "next_cursor": "opaque+/=1"},
            )
        return httpx.Response(200, json={"fills": [], "next_cursor": None})

    client = _client(handler)
    first = client.history_fills("ab" * 20, limit=1)
    second = client.history_fills("ab" * 20, cursor=first.next_cursor, limit=1)

    assert first.data == [{"fill_id": maximum}]
    assert first.next_cursor == "opaque+/=1"
    assert second.data == []
    assert seen == [
        {"owner": "ab" * 20, "limit": "1"},
        {"owner": "ab" * 20, "cursor": "opaque+/=1", "limit": "1"},
    ]


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
    assert mkts[0]["max_open_interest"] is None


def test_markets_decodes_max_open_interest_slot_24():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/markets"
        cfg = [1, 1_000, 500, 5, 2, 3_600_000, 100, "Perp"]
        cfg.extend([None] * (23 - len(cfg)))
        cfg.extend(["BTC", 1_000_000])
        return _info_response([cfg])

    market = _client(handler).markets()[0]
    assert market["ticker"] == "BTC"
    assert market["max_open_interest"] == 1_000_000


def test_orderbook_decodes_bids_asks():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/orderbook/1"
        return _info_response([[[6_675_000, 100, 2]], [[6_680_000, 50, 1]]])

    ob = _client(handler).orderbook(1)
    assert ob["bids"][0] == {"price": 6_675_000, "total_qty": 100, "order_count": 2}
    assert ob["asks"][0]["price"] == 6_680_000


def test_adl_queue_decodes_tuples():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/adl/queue/1"
        rows = [[list(b"\x03" * 20), 1, "Buy", 100, 5, 50]]
        return _info_response(rows)

    q = _client(handler).adl_queue(1)
    assert len(q) == 1
    assert q[0]["market"] == 1
    assert q[0]["size"] == 100
    assert q[0]["adl_score"] == 50
    assert q[0]["owner"] == b"\x03" * 20


def test_ticker_routes_through_v1_ticker():
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        return httpx.Response(200, json={"market": "1", "last_price": "6675000"})

    t = _client(handler).ticker(1)
    assert seen == ["/v1/ticker/1"]
    assert t is not None and t["last_price"] == "6675000"


def test_position_triggers_use_public_gateway_route_and_preserve_ids():
    owner = "ab" * 20
    group_id = 9_007_199_254_740_993

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        assert request.url.path == f"/v1/triggers/{owner}"
        row = [
            [
                group_id,
                list(b"\xA5" * 20),
                7,
                3,
                "Buy",
                100,
                101,
                9,
                [11, "StopLoss", 95_000, 75, 11, "Armed", None],
                None,
            ],
            [4, True, 250, 5_000, 1_000, 32],
            {"Deferred": "MarkStale"},
        ]
        return _info_response([row])

    rows = _client(handler).position_triggers(owner)
    assert rows[0]["bracket"]["group_id"] == group_id
    assert rows[0]["bracket"]["owner"] == b"\xA5" * 20
    assert rows[0]["bracket"]["stop_loss"]["client_trigger_id"] == 11
    assert rows[0]["availability"] == {"kind": "Deferred", "reason": "MarkStale"}


def test_trigger_status_preserves_large_json_heights_and_503_fails_closed():
    large = 9_007_199_254_740_993

    def ok(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/triggers/status"
        return httpx.Response(
            200,
            content=(
                '{"finalized_height":9007199254740993,'
                '"admission_height":9007199254740994,"actions_active":true}'
            ),
            headers={"content-type": "application/json"},
        )

    assert _client(ok).trigger_status() == {
        "finalized_height": large,
        "admission_height": large + 1,
        "actions_active": True,
    }

    def non_next_height(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "finalized_height": 10,
                "admission_height": 12,
                "actions_active": False,
            },
        )

    with pytest.raises(ProofTradingSdkError, match="next height"):
        _client(non_next_height).trigger_status()

    def unavailable(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            503, json={"error": "trigger activation status unavailable"}
        )

    with pytest.raises(GatewayError, match="trigger activation status unavailable"):
        _client(unavailable).trigger_status()
