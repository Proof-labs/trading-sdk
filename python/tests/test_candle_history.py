from copy import deepcopy

import httpx
import pytest

from proof_trading_sdk import CandleHistoryPage, CodecError, ExchangeClient, HistoryCandle, SdkConfig, TransportError


def page():
    return {
        "market": 7, "resolution": "1m",
        "from": "2026-11-09T00:00:00Z", "to": "2026-11-09T01:00:00Z",
        "has_more": True, "earliest": "2026-11-08T00:00:00Z",
        "candles": [{
            "t": "2026-11-09T00:59:00.000000001Z",
            "o": "9007199254740993.123456", "h": "9007199254740994.000000",
            "l": "9007199254740992.000000", "c": "9007199254740993.000001",
            "v": "18446744073709551615", "quote_v": "12345678901234567890123.123456",
            "trades": 9007199254740993,
        }],
    }


@pytest.fixture
def client():
    client = ExchangeClient(config=SdkConfig(gateway_url="https://gateway.example"))
    client._http.close()
    yield client
    client.close()


def mock(client, body):
    client._http = httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=body)))


def test_request_precision_and_backward_paging(client):
    seen = []

    def handler(request):
        assert request.url.path == "/v1/history/candles"
        seen.append(dict(request.url.params))
        body = page()
        if len(seen) == 2:
            body.update(candles=[], has_more=False, earliest=None)
        return httpx.Response(200, json=body)

    client._http = httpx.Client(transport=httpx.MockTransport(handler))
    first = client.history_candles(7, from_=1794182400000, to="2026-11-09T01:00:00Z", limit=1)
    assert isinstance(first, CandleHistoryPage)
    candle = first.candles[0]
    assert isinstance(candle, HistoryCandle)
    assert candle.open == "9007199254740993.123456"
    assert candle.volume == "18446744073709551615"
    assert candle.quote_volume == "12345678901234567890123.123456"
    assert candle.trades == 9007199254740993
    assert candle.time == "2026-11-09T00:59:00.000000001Z"
    last = client.history_candles(7, to=candle.time, limit=1)
    assert last.candles == [] and not last.has_more and last.earliest is None
    assert seen == [
        {"market": "7", "resolution": "1m", "from": "1794182400000", "to": "2026-11-09T01:00:00Z", "limit": "1"},
        {"market": "7", "resolution": "1m", "to": candle.time, "limit": "1"},
    ]


@pytest.mark.parametrize("overrides", [
    {"market": True}, {"market": -1}, {"market": 2**31},
    {"resolution": "01m"}, {"resolution": "10000m"}, {"resolution": "1s"},
    {"limit": True}, {"limit": 0}, {"limit": 5001},
    {"from_": True}, {"from_": "yesterday"}, {"from_": "2026-02-30T00:00:00Z"},
    {"to": 1.5}, {"to": 2**63}, {"to": "2026-11-09T00:00:00"},
])
def test_invalid_parameters_never_reach_gateway(client, overrides):
    client._http = httpx.Client(transport=httpx.MockTransport(lambda _: pytest.fail("invalid request sent")))
    with pytest.raises(ValueError):
        client.history_candles(**({"market": 7} | overrides))


@pytest.mark.parametrize("resolution", ["90m", "5h", "3d", "2w", "3M", "1y"])
def test_resolution_grammar_includes_calendar_strides(client, resolution):
    body = page()
    body["resolution"] = resolution
    mock(client, body)
    assert client.history_candles(7, resolution).resolution == resolution


def invalid_pages():
    yield []
    for field, value in [
        ("market", 8), ("market", True), ("resolution", "1h"),
        ("candles", None), ("has_more", "false"), ("earliest", 0),
        ("from", "2026-11-09T01:00:00Z"),
    ]:
        yield page() | {field: value}
    body = page()
    del body["has_more"]
    yield body
    for field, value in [
        ("o", 1.5), ("h", "NaN"), ("v", "-1"), ("quote_v", "1e30"),
        ("trades", True), ("trades", -1), ("trades", 2**63), ("t", "bad"),
    ]:
        body = page()
        body["candles"][0][field] = value
        yield body
    body = page()
    body["candles"].append(deepcopy(body["candles"][0]))
    yield body


@pytest.mark.parametrize("body", list(invalid_pages()))
def test_malformed_data_is_not_an_empty_history(client, body):
    mock(client, body)
    with pytest.raises(CodecError):
        client.history_candles(7)


def test_ordering_compares_nanoseconds(client):
    body = page()
    later = deepcopy(body["candles"][0])
    later["t"] = "2026-11-09T00:59:00.000000002Z"
    body["candles"].append(later)
    mock(client, body)
    assert len(client.history_candles(7).candles) == 2
    body["candles"].reverse()
    client._http.close()
    mock(client, body)
    with pytest.raises(CodecError):
        client.history_candles(7)


def test_response_cannot_exceed_requested_limit(client):
    body = page()
    body["candles"] *= 2
    mock(client, body)
    with pytest.raises(CodecError):
        client.history_candles(7, limit=1)


def test_empty_window_can_have_older_data(client):
    body = page() | {"candles": []}
    mock(client, body)
    result = client.history_candles(7)
    assert result.candles == [] and result.has_more


def test_broken_json_uses_sdk_error(client):
    client._http = httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, content=b"{bad")))
    with pytest.raises(TransportError):
        client.history_candles(7)
