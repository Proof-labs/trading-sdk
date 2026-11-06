import base64
import json

import httpx
import pytest

from proof_trading_sdk import ExchangeClient, SdkConfig


@pytest.mark.parametrize("envelope", [b"\x00", bytes(range(256))])
@pytest.mark.parametrize("api_key", ["", "test-api-key"])
def test_exchange_posts_json_without_changing_signed_bytes(envelope, api_key):
    seen = []

    def handler(request):
        seen.append(request)
        assert request.method == "POST"
        assert request.url.path == "/exchange"
        assert request.headers["Content-Type"] == "application/json"
        assert request.headers.get("X-API-Key", "") == api_key
        body = json.loads(request.content)
        assert set(body) == {"action"}
        assert base64.b64decode(body["action"], validate=True) == envelope
        return httpx.Response(200, json={"code": 0, "height": 1})

    client = ExchangeClient(config=SdkConfig(
        gateway_url="https://gateway.example", api_key=api_key
    ))
    client._http.close()
    client._http = httpx.Client(
        headers=client._default_headers(), transport=httpx.MockTransport(handler)
    )
    try:
        assert client.submit_action(envelope) == {"code": 0, "height": 1}
        assert len(seen) == 1
    finally:
        client.close()
