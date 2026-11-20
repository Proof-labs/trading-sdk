import json
from pathlib import Path

import httpx
import pytest

from proof_trading_sdk import CodecError, ExchangeClient, SdkConfig


OWNER = "ab" * 20


@pytest.fixture
def client():
    c = ExchangeClient(config=SdkConfig(gateway_url="https://gateway.example"))
    try:
        yield c
    finally:
        c.close()


@pytest.mark.parametrize("method,key,path", [
    ("history_funding", "funding_payments", "/v1/history/funding-payments/" + OWNER),
    ("history_positions", "positions", "/v1/history/positions"),
])
def test_owner_history_pagination(client, method, key, path):
    seen = []
    row = {"owner": OWNER, "market": 1, "block_height": 42}
    if key == "funding_payments":
        row["payment"] = "-9007199254740993"

    def handler(request):
        assert request.url.path == path
        params = {"limit": "1"}
        if key == "positions":
            params["owner"] = OWNER
        if seen:
            params["cursor"] = "opaque+/="
        assert dict(request.url.params) == params
        seen.append(request)
        return httpx.Response(200, json={
            key: [row] if len(seen) == 1 else [],
            "next_cursor": "opaque+/=" if len(seen) == 1 else "",
        })

    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(handler))
    read = getattr(client, method)
    first = read(bytes.fromhex(OWNER), None, 1)
    assert first.data == [row]
    last = read("0x" + OWNER.upper(), limit=1, cursor=first.next_cursor)
    assert last.data == [] and last.next_cursor is None
    assert last.raw == {key: [], "next_cursor": ""}
    with pytest.raises(ValueError, match="after_height"):
        read(OWNER, 42, 1)
    with pytest.raises(ValueError, match="cursor"):
        read(OWNER, cursor="")
    assert len(seen) == 2


def _rejected_pages(key):
    return [
        {"funding": []},  # wrong rows key
        [],  # not an object
        {key: [{"owner": "cd" * 20}], "next_cursor": ""},  # another owner's row
        {key: [], "next_cursor": 3},  # cursor of the wrong type
        {key: []},  # no next_cursor key at all
    ]


@pytest.mark.parametrize("method,key", [
    ("history_funding", "funding_payments"), ("history_positions", "positions"),
])
@pytest.mark.parametrize("case", range(5))
def test_owner_history_rejects_wrong_page_or_owner(client, method, key, case):
    body = _rejected_pages(key)[case]
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=body)))
    with pytest.raises(CodecError):
        getattr(client, method)(OWNER)


@pytest.mark.parametrize("method,key", [
    ("history_funding", "funding_payments"), ("history_positions", "positions"),
])
def test_owner_history_null_cursor_is_the_last_page(client, method, key):
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(
        lambda _: httpx.Response(200, json={key: [], "next_cursor": None})
    ))
    page = getattr(client, method)(OWNER)
    assert page.data == [] and page.next_cursor is None


@pytest.mark.parametrize("method,max_limit", [("history_funding", 1000), ("history_positions", 5000)])
def test_account_history_limit_bounds(client, method, max_limit):
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(
        lambda _: pytest.fail("invalid limit reached gateway")
    ))
    for limit in (True, 0, max_limit + 1):
        with pytest.raises(ValueError, match=f"between 1 and {max_limit}"):
            getattr(client, method)(OWNER, limit=limit)


def test_history_positions_sends_interval_only_when_set(client):
    seen = []

    def handler(request):
        seen.append(dict(request.url.params))
        return httpx.Response(200, json={"positions": [], "next_cursor": ""})

    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(handler))
    client.history_positions(OWNER, limit=10, interval="15m", cursor="next")
    client.history_positions(OWNER, limit=10)
    assert seen == [
        {"owner": OWNER, "limit": "10", "interval": "15m", "cursor": "next"},
        {"owner": OWNER, "limit": "10"},
    ]


@pytest.mark.parametrize("interval", ["", "0m", "00h", "15", "1w", "1.5h", "-1h", " 1h", "1h\n", "366d", "8761h", "525601m", "31536001s", "9" * 5000 + "s", 15])
def test_history_positions_rejects_a_malformed_interval(client, interval):
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(
        lambda _: pytest.fail("invalid interval reached gateway")
    ))
    with pytest.raises(ValueError, match="interval"):
        client.history_positions(OWNER, interval=interval)


@pytest.mark.parametrize("interval", ["1s", "90s", "15m", "1h", "365d", "8760h", "525600m", "31536000s", "0001h"])
def test_history_positions_accepts_canonical_intervals(client, interval):
    def handler(request):
        assert dict(request.url.params) == {
            "owner": OWNER, "limit": "100", "interval": interval,
            "from": "0", "to": "1000", "market": "2",
        }
        return httpx.Response(200, json={"positions": [], "next_cursor": ""})
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(handler))
    client.history_positions(OWNER, interval=interval, from_ms=0, to_ms=1000, market=2)


@pytest.mark.parametrize("filters", [
    {"from_ms": True}, {"to_ms": -1}, {"from_ms": "1000"},
    {"from_ms": 10, "to_ms": 10}, {"market": -1}, {"market": True},
    {"market": 1 << 31}, {"to_ms": 1 << 63},
])
def test_history_positions_rejects_invalid_window(client, filters):
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(
        lambda _: pytest.fail("invalid filter reached gateway")
    ))
    with pytest.raises(ValueError):
        client.history_positions(OWNER, interval="1h", **filters)


def test_history_positions_bucketed_pages_preserve_rows_and_filters(client):
    fixture = json.loads((Path(__file__).parents[2] / "conformance/positions-history.json").read_text())
    seen = []
    def handler(request):
        assert request.url.path == "/v1/history/positions"
        expected = {"owner": OWNER, "interval": "1h", "limit": "2",
                    "from": str(fixture["from_ms"]), "to": str(fixture["to_ms"])}
        if seen:
            expected["cursor"] = fixture["pages"][0]["next_cursor"]
        assert dict(request.url.params) == expected
        page = fixture["pages"][len(seen)]
        seen.append(request)
        return httpx.Response(200, json=page)
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(handler))
    opts = {"interval": "1h", "from_ms": fixture["from_ms"], "to_ms": fixture["to_ms"], "limit": 2}
    first = client.history_positions(OWNER, **opts)
    last = client.history_positions(OWNER, cursor=first.next_cursor, **opts)
    assert first.data + last.data == [row for page in fixture["pages"] for row in page["positions"]]
    assert last.next_cursor is None
    assert last.raw["next_cursor"] == ""


@pytest.mark.parametrize("error", ["invalid_interval", "invalid_cursor", "cursor_mismatch"])
def test_history_positions_propagates_server_rejection(client, error):
    from proof_trading_sdk import TransportError
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(
        lambda _: httpx.Response(400, json={"error": error})
    ))
    with pytest.raises(TransportError, match=error):
        client.history_positions(OWNER, interval="1s")
