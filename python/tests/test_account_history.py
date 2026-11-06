import httpx
import pytest

from proof_trading_sdk import CodecError, ExchangeClient, SdkConfig


@pytest.mark.parametrize("options,order", [({}, "desc"), ({"order": "asc"}, "asc")])
def test_account_history_request_and_cursor_pages(options, order):
    requests = []

    def handler(request):
        requests.append(request)
        assert request.url.path == "/v1/history/account-events"
        params = dict(request.url.params)
        expected = {"owner": "ab" * 20, "limit": "1", "order": order}
        if len(requests) == 2:
            expected["cursor"] = "opaque+/="
        assert params == expected
        return httpx.Response(200, json={
            "account_events": [{"event_id": 14 if len(requests) == 1 else 13}],
            "next_cursor": "opaque+/=" if len(requests) == 1 else ""
        })

    client = ExchangeClient(config=SdkConfig(gateway_url="https://gateway.example"))
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        first = client.history_account_events(bytes.fromhex("ab" * 20), None, 1, **options)
        assert first.data == [{"event_id": 14}]
        second = client.history_account_events(
            "0x" + "AB" * 20, None, 1, cursor=first.next_cursor, **options
        )
        assert second.data == [{"event_id": 13}]
        assert second.next_cursor is None
        assert second.raw["next_cursor"] == ""
        with pytest.raises(ValueError, match="after_id"):
            client.history_account_events("ab" * 20, 12)
        with pytest.raises(ValueError, match="cursor"):
            client.history_account_events("ab" * 20, cursor="")
        assert second.raw["account_events"] == second.data
        with pytest.raises(ValueError, match="order"):
            client.history_account_events("ab" * 20, order="invalid")
        assert len(requests) == 2
    finally:
        client.close()


@pytest.mark.parametrize("page", [
    {"next_cursor": ""}, {"account_events": {}, "next_cursor": ""},
    {"account_events": []}, {"account_events": [], "next_cursor": 1},
])
def test_wrong_page_shape_is_not_empty_history(page):
    client = ExchangeClient(config=SdkConfig(gateway_url="https://gateway.example"))
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=page)))
    try:
        with pytest.raises(CodecError):
            client.history_account_events("ab" * 20)
    finally:
        client.close()


def test_upper_bound_and_uppercase_hex_prefix():
    def handler(request):
        assert request.url.params["owner"] == "ab" * 20
        assert request.url.params["limit"] == "5000"
        return httpx.Response(200, json={"account_events": [], "next_cursor": ""})

    client = ExchangeClient(config=SdkConfig(gateway_url="https://gateway.example"))
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        page = client.history_account_events("0X" + "AB" * 20, limit=5000)
        assert page.next_cursor is None
    finally:
        client.close()


@pytest.mark.parametrize("invalid", [
    {"limit": True}, {"limit": 0}, {"limit": 5001}, {"limit": 1.0}, {"limit": "1"},
    {"owner": "zz" * 20}, {"owner": bytes(19)}, {"owner": "0x1234"},
])
def test_invalid_account_history_input_fails_before_request(invalid):
    def unexpected_request(request):
        pytest.fail("invalid inputs reached the gateway")

    client = ExchangeClient(config=SdkConfig(gateway_url="https://gateway.example"))
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(unexpected_request))
    try:
        with pytest.raises(ValueError, match=next(iter(invalid))):
            client.history_account_events(**{"owner": "ab" * 20, **invalid})
    finally:
        client.close()
