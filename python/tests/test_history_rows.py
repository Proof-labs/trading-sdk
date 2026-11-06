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
