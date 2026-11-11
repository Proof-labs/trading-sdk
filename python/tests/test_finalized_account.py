"""Witnessed account state uses the canonical native wire decoder."""
import base64
import json
from copy import deepcopy
from pathlib import Path

import httpx
import msgpack
import pytest

import proof_trading_sdk as sdk
from proof_trading_sdk import _native
from proof_trading_sdk.client import AccountState
from test_block_header import Stream

OWNER = b"\xab" * 20
H = 9007199254740993
U64 = (1 << 64) - 1
I64_MIN = -(1 << 63)


@pytest.mark.parametrize("fixture", json.loads(
    (Path(__file__).parents[2] / "conformance/finalized-account-state.json").read_text(),
), ids=lambda value: value["name"])
def test_shared_ts_python_exact_fixtures(fixture):
    result = sdk.decode_finalized_account_state(fixture["envelope"], fixture["owner"])
    actual = dict(owner=result.owner, finalizedHeight=str(result.finalized_height),
                  balance=str(result.balance), positions=[dict(
                      owner=p.owner, market=p.market, side=p.side,
                      entryPrice=str(p.entry_price), size=str(p.size),
                      lastFundingIndex=str(p.last_funding_index), entryRemainder=str(p.entry_remainder),
                  ) for p in result.positions])
    assert actual == fixture["expected"]
    assert str(result.witness.height) == fixture["envelope"]["witness"]["height"]


def position():
    return [OWNER, 0, "Sell", U64, 3, I64_MIN, 2]


def state():
    return [OWNER, H, U64, [position()]]


def envelope(raw=None):
    return {"data": base64.b64encode(msgpack.packb(state() if raw is None else raw)).decode(),
            "witness": {"version": 1, "nodeId": "cd" * 20, "height": str(H),
                        "finalizedBlockTimeMs": "1794200000000", "appHash": "ef" * 32}}


def decode(value=None, owner=OWNER):
    return sdk.decode_finalized_account_state(envelope() if value is None else value, owner)


def test_typed_raw_facts_preserve_integer_ranges_and_do_not_redefine_account():
    result = decode()
    assert result == sdk.FinalizedAccountState(OWNER.hex(), H, U64, [
        sdk.RawAccountPosition(OWNER.hex(), 0, "Sell", U64, 3, I64_MIN, 2),
    ], sdk.FinalizedReadWitness(1, "cd" * 20, H, 1794200000000, "EF" * 32))
    assert type(result) is not AccountState
    assert not hasattr(result, "equity") and not hasattr(result, "margin_ratio_bps")
    header = sdk.BlockEvidenceHeader("01" * 32, "test-chain", H + 1, "02" * 32,
                                     "2026-11-09T00:00:00Z", "EF" * 32)
    assert sdk.verify_witness(result.witness, header, "test-chain") is None


def test_legacy_six_fields_default_remainder_and_keep_zero_size_parity():
    raw = state(); raw[0] = list(OWNER); raw[3][0] = [list(OWNER), 2**32 - 1, "Buy", 0, 0, 2**63 - 1]
    result = decode(envelope(raw), "0X" + OWNER.hex().upper())
    assert result.positions[0] == sdk.RawAccountPosition(OWNER.hex(), 2**32 - 1, "Buy", 0, 0, 2**63 - 1, 0)


def test_empty_account_is_not_synthesized_and_position_bound_is_inclusive():
    raw = state(); raw[2] = 0; raw[3] = []
    assert decode(envelope(raw)).positions == []
    raw[3] = [[OWNER, n, "Buy", 0, 0, 0] for n in range(2048)]
    assert len(decode(envelope(raw)).positions) == 2048
    raw[3].append([OWNER, 2048, "Buy", 0, 0, 0])
    with pytest.raises(sdk.GatewayReadError):
        decode(envelope(raw))


@pytest.mark.parametrize("address", [b"x" * 19, b"x" * 21, list(OWNER) + [1], list(OWNER)[:-1],
                                     [True] + list(OWNER)[1:], [256] + list(OWNER)[1:], [-1] + list(OWNER)[1:]])
@pytest.mark.parametrize("which", ["root", "position"])
def test_owner_width_and_byte_types_cannot_be_truncated(address, which):
    raw = state()
    if which == "root": raw[0] = address
    else: raw[3][0][0] = address
    with pytest.raises(sdk.GatewayReadError) as raised:
        decode(envelope(raw))
    assert raised.value.kind == "malformed"
    with pytest.raises(ValueError):
        _native.decode_account_state(msgpack.packb(raw), OWNER)


def test_appended_engine_fields_decode():
    raw = state(); raw[3][0].append("future"); raw.append("future")
    assert decode(envelope(raw)) == decode()


def invalid_states():
    yield []
    yield {"owner": OWNER, "finalized_height": H, "balance": 0, "positions": []}
    yield [list(OWNER) + [1], 100, [], []]
    for index, value in [(0, b"\xcd" * 20), (1, -1), (1, True), (1, 1.0),
                         (2, -1), (2, True), (2, 1.0), (2, "1"), (3, None), (3, {})]:
        raw = state(); raw[index] = value; yield raw
    for index, value in [(0, b"\xcd" * 20), (1, -1), (1, 2**32), (1, True), (1, 1.0),
                         (2, "Long"), (2, 0), (2, {"Buy": None}), (3, -1), (3, 1.0),
                         (4, -1), (4, True), (5, 2**63), (5, 1.0), (6, -1), (6, 3), (6, None)]:
        raw = state(); raw[3][0][index] = value; yield raw
    raw = state(); raw[3][0] = raw[3][0][:5]; yield raw
    raw = state(); raw[3].append(deepcopy(raw[3][0])); yield raw
    raw = state(); raw[3][0][1] = 1; raw[3].append(position()); yield raw


@pytest.mark.parametrize("raw", list(invalid_states()))
def test_malformed_state_never_becomes_empty_or_partial(raw):
    with pytest.raises(sdk.GatewayReadError) as raised:
        decode(envelope(raw))
    assert raised.value.kind == "malformed"


@pytest.mark.parametrize("change", ["missing-data", "extra", "witness-extra", "witness-missing", "wrong-height", "zero-height"])
def test_strict_envelope_and_payload_witness_binding(change):
    value = envelope()
    if change == "missing-data": del value["data"]
    if change == "extra": value["extra"] = 0
    if change == "witness-extra": value["witness"]["extra"] = 0
    if change == "witness-missing": del value["witness"]["nodeId"]
    if change == "wrong-height": value["witness"]["height"] = str(H + 1)
    if change == "zero-height": value = envelope([OWNER, 0, 0, []])
    with pytest.raises(sdk.GatewayReadError) as raised:
        decode(value)
    assert raised.value.kind == ("binding" if change in ("wrong-height", "zero-height") else "malformed")


@pytest.mark.parametrize("data", ["", None, 1, "%%%", "kA", "kA==\n", "kB=="])
def test_noncanonical_base64(data):
    value = envelope(); value["data"] = data
    with pytest.raises(sdk.GatewayReadError):
        decode(value)


def test_trailing_extensions_and_byte_limit_refused():
    for raw in [msgpack.packb(state()) + b"\x00", msgpack.packb(msgpack.ExtType(1, b"a")), b"\x90" * (512 * 1024 + 1)]:
        value = envelope(); value["data"] = base64.b64encode(raw).decode()
        with pytest.raises(sdk.GatewayReadError):
            decode(value)


@pytest.fixture
def client():
    c = sdk.ExchangeClient(config=sdk.SdkConfig(gateway_url="https://gateway.example", api_key="test-key"))
    c._http.close()
    yield c
    c.close()


def serve(client, value=None, *, status=200, headers=None, body=None):
    stream = Stream([json.dumps(envelope() if value is None else value).encode() if body is None else body])
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(status, stream=stream, headers=headers or {})
    client._http = httpx.Client(transport=httpx.MockTransport(handler), headers=client._default_headers())
    return calls, stream


def test_client_managed_witness_route_has_no_header_or_legacy_fallback(client):
    calls, stream = serve(client, headers={"X-RateLimit-Remaining": "17"})
    result = client.finalized_account_state("0X" + OWNER.hex().upper(), timeout=3)
    assert result == decode()
    assert len(calls) == 1 and stream.closed
    assert str(calls[0].url) == f"https://gateway.example/v1/account/{OWNER.hex()}/state?witness=1"
    assert calls[0].headers["X-API-Key"] == "test-key"
    assert calls[0].headers["Accept-Encoding"] == "identity"
    assert calls[0].extensions["timeout"]["read"] == 3
    assert client.rate_limit_remaining("default") == 17


@pytest.mark.parametrize("owner", [b"short", "bad", "", True])
def test_invalid_owner_before_http(client, owner):
    calls, _ = serve(client)
    with pytest.raises(sdk.GatewayReadError):
        client.finalized_account_state(owner)
    assert not calls


@pytest.mark.parametrize("status,error", [(404, sdk.TransportError), (503, sdk.GatewayError)])
def test_unsupported_witness_http_refusal_has_no_fallback(client, status, error):
    calls, stream = serve(client, status=status)
    with pytest.raises(error):
        client.finalized_account_state(OWNER)
    assert len(calls) == 1 and stream.closed and stream.reads == 0


def test_duplicate_json_and_missing_witness_fail_closed(client):
    value = envelope(); del value["witness"]
    calls, stream = serve(client, value)
    with pytest.raises(sdk.GatewayReadError): client.finalized_account_state(OWNER)
    assert len(calls) == 1 and stream.closed
    client._http.close()
    raw = json.dumps(envelope()).replace('"version": 1', '"version": 1, "version": 1').encode()
    calls, stream = serve(client, body=raw)
    with pytest.raises(sdk.GatewayReadError): client.finalized_account_state(OWNER)
    assert len(calls) == 1 and stream.closed


def test_witness_height_zero_is_refused():
    value = envelope([OWNER, 0, U64, []])
    value["witness"]["height"] = "0"
    with pytest.raises(sdk.GatewayReadError):
        decode(value)
