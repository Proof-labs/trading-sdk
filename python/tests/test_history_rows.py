import httpx
import pytest

from proof_trading_sdk import ExchangeClient, SdkConfig


@pytest.mark.parametrize("kind", ["funding", "positions"])
@pytest.mark.parametrize("rows", [[], [{"block_height": 42, "market": 1}]])
def test_history_exposes_endpoint_rows_and_preserves_cursor(kind, rows):
    body = {kind: rows, "next_cursor": "opaque-next-page"}

    def handler(request):
        assert request.url.path == "/v1/history/" + kind
        assert dict(request.url.params) == {
            "owner": "ab" * 20, "after_height": "41", "limit": "2"
        }
        return httpx.Response(200, json=body)

    client = ExchangeClient(config=SdkConfig(gateway_url="https://gateway.example"))
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        page = getattr(client, "history_" + kind)(bytes.fromhex("ab" * 20), 41, 2)
        assert page.data == rows
        assert page.next_cursor == "opaque-next-page"
        assert page.raw == body
    finally:
        client.close()
