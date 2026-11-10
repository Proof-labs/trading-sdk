"""Governance raw reads keep wire facts and fail closed."""
import base64
from dataclasses import asdict

import httpx
import msgpack
import pytest

import proof_trading_sdk as sdk

U64 = (1 << 64) - 1
U32 = (1 << 32) - 1


def envelope(raw):
    return {"data": base64.b64encode(msgpack.packb(raw)).decode()}


def config():
    return [U32, [U32, U32], U32, U32, U32, U32]


def test_engine_genesis_vector_matches_typescript_liquidation_reads():
    # Same engine-produced vector as src/liquidation-reads.test.ts.
    result = sdk.decode_liquidation_config_info({"data": "kgGWzSkEkgIDZBQKMg=="})
    assert result == sdk.LiquidationConfigInfo(1, sdk.LiquidationConfig(
        10500, sdk.FullCloseThreshold(2, 3), 100, 20, 10, 50,
    ))


def test_authority_sets_preserve_addresses_and_order_without_deduplication():
    raw = [[bytes([n]) * 20, [n] * 20] for n in range(6)]
    result = sdk.decode_authorities_snapshot(envelope(raw))
    assert result == sdk.AuthoritiesSnapshot(*[[bytes([n]) * 20] * 2 for n in range(6)])
    assert all(isinstance(a, bytes) for values in asdict(result).values() for a in values)
    assert sdk.decode_authorities_snapshot(envelope([[]] * 6)) == sdk.AuthoritiesSnapshot(*[[]] * 6)


@pytest.mark.parametrize("address", [bytes(19), bytes(21), [0]*19, [0]*21,
                                     [True]*20, [-1]*20, [256]*20, "00"*20])
def test_authority_address_is_never_coerced_or_truncated(address):
    with pytest.raises(sdk.CodecError):
        sdk.decode_authorities_snapshot(envelope([[address]] + [[]]*5))


@pytest.mark.parametrize("raw", [[], [[]]*5, [[]]*7, [None]*6, {}])
def test_authority_shape(raw):
    with pytest.raises(sdk.CodecError): sdk.decode_authorities_snapshot(envelope(raw))


def test_authority_cardinality_bound_matches_engine():
    assert len(sdk.decode_authorities_snapshot(envelope([[bytes(20)] * 4096] + [[]]*5)).relayer) == 4096
    with pytest.raises(sdk.CodecError):
        sdk.decode_authorities_snapshot(envelope([[bytes(20)] * 4097] + [[]]*5))


def test_liquidation_exact_ranges_and_legacy_default_are_read_facts():
    result = sdk.decode_liquidation_config_info(envelope([U64, config()]))
    assert result.sequence == U64
    assert result.config == sdk.LiquidationConfig(U32, sdk.FullCloseThreshold(U32, U32), U32, U32, U32, U32)
    legacy = sdk.decode_liquidation_config_info(envelope([0, [0, [0, 0], 0, 0, 0]]))
    assert legacy.config.takeover_discount_bps == 50
    # Read validation does not replace action-admission policy with defaults.
    assert legacy.config.target_ratio_bps == 0


def invalid_configs():
    for raw in [[], [1], [1, config(), 1], [1, config()[:4]], [1, config()+[0]]]: yield raw
    for value in [-1, True, 1.0, "1", None]: yield [value, config()]
    for index in [0, 2, 3, 4, 5]:
        for value in [-1, U32+1, True, 1.0, "1"]:
            raw = config(); raw[index] = value; yield [0, raw]
    for value in [[], [1], [1, 2, 3], {}, [-1, 2], [1, U32+1], [True, 2]]:
        raw = config(); raw[1] = value; yield [0, raw]


@pytest.mark.parametrize("raw", list(invalid_configs()))
def test_liquidation_malformed_shapes_ranges(raw):
    with pytest.raises(sdk.CodecError): sdk.decode_liquidation_config_info(envelope(raw))


@pytest.mark.parametrize("decoder", [sdk.decode_authorities_snapshot, sdk.decode_liquidation_config_info])
@pytest.mark.parametrize("value", [{}, [], None, {"data": None}, {"data": ""}, {"data": "kA"},
                                    {"data": "kB=="}, {"data": "kA==\n"}, {"error": "failed", "data": "kA=="}])
def test_missing_malformed_envelopes_never_default(decoder, value):
    with pytest.raises(sdk.CodecError): decoder(value)


@pytest.mark.parametrize("decoder", [sdk.decode_authorities_snapshot, sdk.decode_liquidation_config_info])
def test_native_framing_and_size_limits(decoder):
    for payload in [b"\x90\x00", msgpack.packb(msgpack.ExtType(1, b"x")), b"\x90" * (1024*1024+1)]:
        with pytest.raises(sdk.CodecError):
            decoder({"data": base64.b64encode(payload).decode()})


@pytest.mark.parametrize("method,path,raw", [
    ("authorities", "/v1/admin/authorities", [[]]*6),
    ("liquidation_config", "/v1/liquidation-config", [U64, config()]),
])
def test_client_uses_managed_gateway_transport(method, path, raw):
    client = sdk.ExchangeClient(config=sdk.SdkConfig(gateway_url="https://gateway.example", api_key="test-key"))
    client._http.close()
    seen = []
    def handler(request):
        seen.append(request)
        return httpx.Response(200, json=envelope(raw), headers={"X-RateLimit-Remaining": "19"})
    client._http = httpx.Client(transport=httpx.MockTransport(handler), headers=client._default_headers())
    try:
        assert getattr(client, method)() is not None
        assert len(seen) == 1 and str(seen[0].url) == "https://gateway.example" + path
        assert seen[0].headers["X-API-Key"] == "test-key"
        assert client.rate_limit_remaining("default") == 19
    finally: client.close()


@pytest.mark.parametrize("method", ["authorities", "liquidation_config"])
@pytest.mark.parametrize("status,error", [(404, sdk.TransportError), (503, sdk.GatewayError)])
def test_http_failure_never_empty_or_default(method, status, error):
    client = sdk.ExchangeClient(config=sdk.SdkConfig(gateway_url="https://gateway.example"))
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(status, json={"error":"no"})))
    try:
        with pytest.raises(error): getattr(client, method)()
    finally: client.close()
