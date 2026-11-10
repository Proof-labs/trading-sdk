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


def test_server_extended_year_window_preserves_original_timestamps(client):
    body = page() | {
        "resolution": "2y", "from": "-0972-01-01T00:00:00Z",
        "to": "2026-11-09T07:59:31.053233466Z",
    }
    mock(client, body)
    result = client.history_candles(7, "2y")
    assert result.from_ == "-0972-01-01T00:00:00Z"
    assert result.to == "2026-11-09T07:59:31.053233466Z"
    assert result.candles[0].time == body["candles"][0]["t"]


@pytest.mark.parametrize("timestamp, expected", [
    ("1970-01-01T00:00:00Z", (0, 0)),
    ("1969-12-31T23:59:59.999999999Z", (-1, 999999999)),
    ("0000-01-01T00:00:00Z", (-62167219200, 0)),
    ("-0001-12-31T23:59:59Z", (-62167219201, 0)),
    ("-0400-01-01T00:00:00Z", (-62167219200 - 146097 * 86400, 0)),
    ("+10000-01-01T00:00:00.123456789Z", (253402300800, 123456789)),
    ("+10000-01-01T01:30:00.123456789+01:30", (253402300800, 123456789)),
    ("9999-12-31T23:00:00-01:00", (253402300800, 0)),
])
def test_proleptic_gregorian_epoch_anchors(timestamp, expected):
    from proof_trading_sdk.candle_history import _time
    assert _time(timestamp) == expected


@pytest.mark.parametrize("timestamp", [
    "0000-02-29T00:00:00Z", "-0400-02-29T00:00:00Z",
    "+10000-02-29T00:00:00Z", "-4000-01-01T00:00:00Z",
])
def test_valid_extended_calendar_dates(timestamp):
    from proof_trading_sdk.candle_history import _time
    _time(timestamp)


@pytest.mark.parametrize("timestamp", [
    "-0100-02-29T00:00:00Z", "+10001-02-29T00:00:00Z",
    "0000-04-31T00:00:00Z", "0000-00-01T00:00:00Z",
    "0000-13-01T00:00:00Z", "0000-01-00T00:00:00Z",
    "0000-01-01T24:00:00Z", "0000-01-01T00:60:00Z",
    "0000-01-01T00:00:61Z", "0000-01-01T00:00:00+24:00",
    "0000-01-01T00:00:00-00:60", "0000-01-01T00:00:00.1234567890Z",
])
def test_invalid_extended_timestamps_are_rejected(timestamp):
    from proof_trading_sdk.candle_history import _time
    with pytest.raises(ValueError):
        _time(timestamp)


def test_extended_candle_ordering_compares_offsets_and_nanoseconds(client):
    body = page() | {"from": "-0001-01-01T00:00:00Z", "to": "+10001-01-01T00:00:00Z"}
    times = ["-0001-12-31T23:59:59.999999999Z", "0000-01-01T00:00:00Z",
             "+10000-01-01T01:00:00.000000001+01:00", "+10000-01-01T00:00:00.000000002Z"]
    body["candles"] = [body["candles"][0] | {"t": timestamp} for timestamp in times]
    mock(client, body)
    assert [row.time for row in client.history_candles(7).candles] == times
    body["candles"][-1]["t"] = "+10000-01-01T00:00:00.000000001Z"
    client._http.close()
    mock(client, body)
    with pytest.raises(CodecError):
        client.history_candles(7)


@pytest.mark.parametrize("timestamp", ["-0972-01-01T00:00:00Z", "+10000-01-01T00:00:00Z"])
def test_extended_response_year_is_not_sent_as_rfc3339_request(client, timestamp):
    client._http = httpx.Client(transport=httpx.MockTransport(lambda _: pytest.fail("invalid request sent")))
    with pytest.raises(ValueError, match="RFC3339"):
        client.history_candles(7, to=timestamp)


def test_leap_second_order_is_not_collapsed_into_next_minute():
    from proof_trading_sdk.candle_history import _time
    assert _time("2016-12-31T23:59:59.999999999Z") < _time("2016-12-31T23:59:60Z")
    assert _time("2016-12-31T23:59:60.999999999Z") < _time("2017-01-01T00:00:00Z")


def test_a_refused_window_raises_rather_than_returning_an_empty_page(client) -> None:
    client._http = httpx.Client(transport=httpx.MockTransport(
        lambda _: httpx.Response(400, json={"error": "window_too_large"})
    ))
    with pytest.raises(TransportError):
        client.history_candles(7, "1m")


def test_backward_pages_follow_exclusive_time_windows_without_gaps(client):
    rows = [page()["candles"][0] | {"t": f"2026-11-09T00:{minute:02d}:00Z"}
            for minute in (0, 1, 4, 7, 9)]
    seen = []

    def handler(request):
        params = request.url.params
        assert "from" not in params
        end = params["to"]
        seen.append(end)
        eligible = [row for row in rows if row["t"] < end]
        selected = eligible[-int(params["limit"]):]
        return httpx.Response(200, json=page() | {
            "from": "2026-11-08T00:00:00Z", "to": end,
            "candles": selected, "has_more": len(eligible) > len(selected),
            "earliest": rows[0]["t"],
        })

    client._http = httpx.Client(transport=httpx.MockTransport(handler))
    end = "2026-11-09T01:00:00Z"
    collected = []
    for _ in range(4):
        result = client.history_candles(7, "1m", to=end, limit=2)
        collected = result.candles + collected
        if not result.has_more:
            break
        end = result.candles[0].time if result.candles else result.from_
    else:
        pytest.fail("backward pagination did not terminate")
    assert [row.time for row in collected] == [row["t"] for row in rows]
    assert seen == ["2026-11-09T01:00:00Z", "2026-11-09T00:07:00Z",
                    "2026-11-09T00:01:00Z"]
