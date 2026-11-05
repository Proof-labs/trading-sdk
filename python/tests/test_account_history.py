import httpx
import pytest

from proof_trading_sdk import ExchangeClient, SdkConfig


@pytest.mark.parametrize("options,order", [({}, "desc"), ({"order": "asc"}, "asc")])
def test_account_history_request_and_cursor_pages(options, order):
    requests = []

    def handler(request):
        requests.append(request)
        assert request.url.path == "/v1/history/account-events"
        params = dict(request.url.params)
        expected = {"owner": "ab" * 20, "after_id": "12", "limit": "1", "order": order}
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
        first = client.history_account_events(bytes.fromhex("ab" * 20), 12, 1, **options)
        assert first.data == [{"event_id": 14}]
        second = client.history_account_events(
            "ab" * 20, 12, 1, cursor=first.next_cursor, **options
        )
        assert second.data == [{"event_id": 13}]
        assert second.next_cursor == ""
        assert second.raw["account_events"] == second.data
        with pytest.raises(ValueError, match="order"):
            client.history_account_events("ab" * 20, order="invalid")
        assert len(requests) == 2
    finally:
        client.close()
