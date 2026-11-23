import base64
import json
from pathlib import Path

import httpx
import msgpack
import pytest

from proof_trading_sdk import CodecError, ExchangeClient, SdkConfig

OWNER = "ab" * 20
FIXTURE = bytes.fromhex((Path(__file__).parents[2] / "conformance/account-v2.hex").read_text().strip())


@pytest.fixture
def client():
    client = ExchangeClient(config=SdkConfig(gateway_url="https://gateway.example"))
    client._http.close()
    yield client
    client.close()


def mock(client, raw=FIXTURE, envelope=None):
    requests = []
    def respond(request):
        requests.append(request)
        return httpx.Response(200, json=envelope if envelope is not None else {"data": base64.b64encode(raw).decode()})
    client._http = httpx.Client(transport=httpx.MockTransport(respond))
    return requests


def test_engine_vector_and_versioned_gateway_request(client):
    requests = mock(client)
    result = client.account_v2("0x" + OWNER.upper())
    assert result["cashout_equity"] == 1_000_090
    assert result["positions"][0]["settle_price"] == 55
    assert result["positions"][0]["book_restricted"] is True
    assert requests[0].url == "https://gateway.example/info"
    assert json.loads(requests[0].content) == {"type": "clearinghouseState", "user": OWNER, "version": 2}


def test_missing_null_false_zero_and_exact_integers(client):
    value = msgpack.unpackb(FIXTURE)
    position = value["positions"][0]
    position.pop("settle_price")
    position.pop("book_restricted")
    position["upnl_now"] = None
    value["margin_ratio_bps"] = None
    mock(client, msgpack.packb(value))
    result = client.account_v2(OWNER)
    assert result["margin_ratio_bps"] is None
    assert result["positions"][0]["settle_price"] is None
    assert result["positions"][0]["book_restricted"] is None
    assert result["positions"][0]["upnl_now"] is None
    for price in [0, 2**64 - 1]:
        position.update(settle_price=price, book_restricted=False, pnl_if_dies=-(2**63), future_field=1)
        mock(client, msgpack.packb(value))
        result = client.account_v2(OWNER)["positions"][0]
        assert result["settle_price"] == price
        assert result["book_restricted"] is False
        assert result["pnl_if_dies"] == -(2**63)


@pytest.mark.parametrize("field,bad", [("settle_price", -1), ("settle_price", "55"), ("book_restricted", 0)])
def test_bad_valuation_fields_fail(client, field, bad):
    value = msgpack.unpackb(FIXTURE)
    value["positions"][0][field] = bad
    mock(client, msgpack.packb(value))
    with pytest.raises(CodecError):
        client.account_v2(OWNER)


def test_v1_fallback_is_refused_without_retry(client):
    requests = mock(client, msgpack.packb([0, [], 0, 0, 0, 0, [], 0, 0]))
    with pytest.raises(CodecError):
        client.account_v2(OWNER)
    assert len(requests) == 1


@pytest.mark.parametrize("envelope", [{}, {"data": 123}, {"data": "invalid base64!"}])
def test_bad_envelope_fails(client, envelope):
    mock(client, envelope=envelope)
    with pytest.raises(CodecError):
        client.account_v2(OWNER)
