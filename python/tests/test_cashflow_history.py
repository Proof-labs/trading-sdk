import httpx
import pytest

from proof_trading_sdk import CodecError, ExchangeClient, SdkConfig


OWNER = "ab" * 20


def client_for(handler):
    client = ExchangeClient(config=SdkConfig(gateway_url="https://gateway.example"))
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(handler))
    return client


@pytest.mark.parametrize("method,kinds", [
    ("history_deposits", ["deposited", "deposit_confirmed"]),
    ("history_withdrawals", ["withdrawn", "withdraw_requested", "withdrawal_confirmed", "withdrawal_failed"]),
])
def test_cashflow_uses_filtered_events_and_limits_after_nanosecond_sort(method, kinds):
    seen = []

    def handler(request):
        params = dict(request.url.params)
        kind = params.pop("event_type")
        seen.append(kind)
        assert request.url.path == "/v1/history/account-events"
        assert params == {"owner": OWNER, "order": "desc", "limit": "2", "from": "1", "to": "2000"}
        index = kinds.index(kind)
        return httpx.Response(200, json={"account_events": [{
            "owner": OWNER, "event_type": kind, "payload": {"amount": "123"},
            "event_id": str(9007199254740993 - index),
            "block_time": "1970-01-01T00:00:01.00000000" + str(index + 1) + "Z",
        }], "next_cursor": "more"})

    client = client_for(handler)
    try:
        rows = getattr(client, method)(bytes.fromhex(OWNER), from_ms=1, to_ms=2000, limit=2)
        assert seen == kinds
        assert [r["event_type"] for r in rows] == list(reversed(kinds))[:2]
        assert all(r["payload"] == {"amount": "123"} for r in rows)
        assert all("signed_delta" not in r for r in rows)
    finally:
        client.close()


def test_cashflow_empty_pages_are_empty_and_default_limit_is_bounded():
    def handler(request):
        assert request.url.params["limit"] == "200"
        return httpx.Response(200, json={"account_events": [], "next_cursor": ""})
    client = client_for(handler)
    try:
        assert client.history_deposits(OWNER) == []
    finally:
        client.close()


@pytest.mark.parametrize("body", [{}, {"account_events": {}, "next_cursor": ""}, {
    "account_events": [{"owner": "cd" * 20, "event_type": "deposited", "payload": {}}],
    "next_cursor": ""
}])
def test_cashflow_rejects_malformed_or_wrong_scope_page(body):
    client = client_for(lambda request: httpx.Response(200, json=body))
    try:
        with pytest.raises(CodecError):
            client.history_deposits(OWNER)
    finally:
        client.close()


@pytest.mark.parametrize("options", [{"limit": 0}, {"limit": True}, {"from_ms": -1}, {"from_ms": 2, "to_ms": 1}])
def test_cashflow_rejects_invalid_bounds_before_request(options):
    def handler(request):
        pytest.fail("invalid input must not reach the gateway")
    client = client_for(handler)
    try:
        with pytest.raises(ValueError):
            client.history_deposits(OWNER, **options)
    finally:
        client.close()
