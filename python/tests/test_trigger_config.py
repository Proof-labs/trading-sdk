"""Strict first-attach trigger-policy query contract."""

from __future__ import annotations

import base64

import httpx
import msgpack
import pytest

from proof_trading_sdk.client import ExchangeClient
from proof_trading_sdk.errors import ProofTradingSdkError
from proof_trading_sdk.trigger_config import decode_trigger_market_config_infos


def _response(value) -> httpx.Response:
    data = base64.b64encode(msgpack.packb(value)).decode()
    return httpx.Response(200, json={"data": data})


def test_client_decodes_lossless_current_and_pending_policy():
    accepted = 9_007_199_254_740_992
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        return _response(
            [
                [
                    7,
                    [
                        [4, True, 250, 5_000, 1_000, 32],
                        [[5, True, 200, 4_000, 900, 64], accepted, accepted + 1],
                    ],
                ]
            ]
        )

    client = ExchangeClient(gateway_url="http://g", chain_id=b"\0" * 32)
    client._http = httpx.Client(
        base_url="http://g", transport=httpx.MockTransport(handler)
    )
    rows = client.trigger_market_configs()
    assert seen == ["/v1/triggers/markets"]
    assert rows[0].market == 7
    assert rows[0].state.current.max_trigger_slippage_bps == 250
    assert rows[0].state.pending.accepted_height == accepted
    assert rows[0].state.pending.effective_height == accepted + 1


@pytest.mark.parametrize(
    "value,match",
    [
        ([[7, [None, None]]], "empty trigger market"),
        (
            [
                [7, [[1, False, 0, 0, 0, 0], None]],
                [7, [[1, False, 0, 0, 0, 0], None]],
            ],
            "strictly market-sorted",
        ),
        (
            [
                [
                    7,
                    [
                        [1, False, 0, 0, 0, 0],
                        [[3, True, 1, 1, 1, 1], 10, 11],
                    ],
                ]
            ],
            "version is not next",
        ),
    ],
)
def test_decoder_refuses_corrupt_policy(value, match):
    with pytest.raises(ProofTradingSdkError, match=match):
        decode_trigger_market_config_infos(value)


def test_client_refuses_missing_encoded_envelope():
    client = ExchangeClient(gateway_url="http://g", chain_id=b"\0" * 32)
    client._http = httpx.Client(
        base_url="http://g",
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={})),
    )
    with pytest.raises(ProofTradingSdkError, match="missing 'data' envelope"):
        client.trigger_market_configs()
