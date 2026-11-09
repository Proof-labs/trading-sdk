import base64
from copy import deepcopy
from contextlib import contextmanager

import httpx
import msgpack
import pytest

import proof_trading_sdk as sdk

OWNER = bytes([7]) * 20
OTHER = bytes([8]) * 20
MAX = (1 << 64) - 1
MIN = -(1 << 63)


def envelope(raw):
    return {"data": base64.b64encode(msgpack.packb(raw, use_bin_type=True)).decode(),
            "witness": {"version": 1, "nodeId": "ab" * 20, "height": "9007199254740993",
                        "finalizedBlockTimeMs": "1793008800123", "appHash": "ef" * 32}}


def position():
    return [OWNER, 3, "Buy", MAX, 2, MIN, -7, MAX, 8, -9, -10, -11, 12, MAX]


def account():
    return [MAX, [position()], MIN, MAX, 4, 5, [[10, "Yes"]], -6, MAX, -8]


def order():
    return [MAX, 3, OWNER, "Sell", MAX, 2, MAX, MAX, 1, MAX, MAX, "Gtc", True, False]


def test_canonical_account_values_and_future_fields():
    raw = account()
    raw.append("future")
    raw[1][0].append("future")
    raw[6][0].append("future")
    value = sdk.decode_finalized_account(envelope(raw), "0x" + OWNER.hex().upper())
    assert value.owner == OWNER.hex()
    assert value.balance == MAX and value.equity == MIN and value.cashout_equity == -8
    assert value.witness.height == 9007199254740993
    p = value.positions[0]
    assert isinstance(p, sdk.FinalizedPositionBrief) and p.owner == OWNER
    assert p.position_epoch == MAX and p.last_funding_index == MIN and p.funding_since == -11
    assert value.binding_scenario == [sdk.FinalizedBindingScenario(10, "Yes")]


def test_legacy_account_defaults_and_unsorted_unique_positions():
    raw = account()[:7]
    raw[1][0] = raw[1][0][:12]
    other = deepcopy(raw[1][0]); other[1] = 1
    raw[1].append(other)
    value = sdk.decode_finalized_account(envelope(raw), OWNER)
    assert (value.fees_accrued, value.volume_30d_micro_usdc, value.cashout_equity) == (0, 0, 0)
    assert value.positions[0].adl_score == 0 and value.positions[0].position_epoch is None
    assert [p.market for p in value.positions] == [3, 1]


@pytest.mark.parametrize("bad", [OTHER, OWNER + b'x', list(OWNER) + [0], OWNER[:-1], [256] * 20])
def test_account_rejects_wrong_or_nonexact_position_owner(bad):
    raw = account(); raw[1][0][0] = bad
    with pytest.raises(sdk.GatewayReadError):
        sdk.decode_finalized_account(envelope(raw), OWNER)


def test_duplicate_account_markets_are_binding_failure():
    raw = account(); raw[1].append(position())
    with pytest.raises(sdk.GatewayReadError, match="account payload") as error:
        sdk.decode_finalized_account(envelope(raw), OWNER)
    assert error.value.kind == "binding"


@pytest.mark.parametrize("index,bad", [(0, -1), (2, MAX), (3, -1), (4, True), (5, 1.0), (6, [[1, "Maybe"]]), (7, MAX), (8, -1), (9, MAX)])
def test_account_field_domains(index, bad):
    raw = account(); raw[index] = bad
    with pytest.raises(sdk.GatewayReadError):
        sdk.decode_finalized_account(envelope(raw), OWNER)


@pytest.mark.parametrize("index,bad", [(1, 1 << 32), (2, "Maybe"), (3, -1), (5, MAX), (6, MAX), (7, -1), (8, -1), (9, MAX), (10, MAX), (11, MAX), (12, MAX), (13, -1)])
def test_position_field_domains(index, bad):
    raw = account(); raw[1][0][index] = bad
    with pytest.raises(sdk.GatewayReadError):
        sdk.decode_finalized_account(envelope(raw), OWNER)


@pytest.mark.parametrize("flag", [True, False])
def test_authorization_is_bare_boolean(flag):
    value = sdk.decode_finalized_agent_authorization(envelope(flag), OWNER, OTHER)
    assert value.authorized is flag and value.owner == OWNER.hex() and value.agent == OTHER.hex()


@pytest.mark.parametrize("bad", [0, 1, "true", [], {}, None])
def test_authorization_refuses_coercion(bad):
    with pytest.raises(sdk.GatewayReadError):
        sdk.decode_finalized_agent_authorization(envelope(bad), OWNER, OTHER)


def test_nonce_exact_u64_and_empty():
    assert sdk.decode_finalized_recent_nonces(envelope([0, MAX]), OWNER).recent == [0, MAX]
    assert sdk.decode_finalized_recent_nonces(envelope([]), OWNER).recent == []


@pytest.mark.parametrize("bad", [[1, 1], [2, 1], [-1], [True], [1.0], ["1"], list(range(101)), {}, None])
def test_nonce_invalid_domain_or_order(bad):
    with pytest.raises(sdk.GatewayReadError):
        sdk.decode_finalized_recent_nonces(envelope(bad), OWNER)


def test_orders_all_fields_and_completeness():
    value = sdk.decode_finalized_open_orders(envelope([order()]), OWNER, 1)
    row = value.orders[0]
    assert isinstance(row, sdk.FinalizedOpenOrder)
    assert row.id == MAX and row.client_order_id == MAX and row.original_quantity == MAX
    assert row.created_at_ms == MAX and row.queue_priority == MAX and row.owner == OWNER.hex()
    assert not value.complete
    assert sdk.decode_finalized_open_orders(envelope([]), OWNER, 1).complete
    assert sdk.decode_finalized_open_orders(envelope([order()]), OWNER, 2).complete


@pytest.mark.parametrize("index,bad", [(0, -1), (1, 0), (1, 1 << 32), (2, OTHER), (2, OWNER + b'x'), (2, list(OWNER) + [0]), (3, 0), (3, "Maybe"), (4, -1), (5, 0), (6, -1), (7, True), (8, -1), (9, -1), (10, -1), (11, 0), (11, "Maybe"), (12, 1), (13, 0)])
def test_order_field_domains(index, bad):
    raw = order(); raw[index] = bad
    with pytest.raises(sdk.GatewayReadError):
        sdk.decode_finalized_open_orders(envelope([raw]), OWNER)


@pytest.mark.parametrize("rows", [[order()[:6]], [order() + [0]], [order(), order()]])
def test_order_width_and_ordering(rows):
    with pytest.raises(sdk.GatewayReadError):
        sdk.decode_finalized_open_orders(envelope(rows), OWNER)


@pytest.mark.parametrize("limit", [0, 102, True, 1.0])
def test_invalid_limit(limit):
    with pytest.raises(sdk.GatewayReadError):
        sdk.decode_finalized_open_orders(envelope([]), OWNER, limit)


@pytest.mark.parametrize("bad", ["", "gg" * 20, b'x' * 21, b'x' * 19, True, None])
def test_invalid_address(bad):
    with pytest.raises(sdk.GatewayReadError):
        sdk.decode_finalized_account(envelope(account()), bad)


@pytest.mark.parametrize("mutation", ["extra", "missing", "witness_extra", "witness_missing", "base64", "noncanonical", "large", "trailing", "float", "extension"])
def test_fail_closed_envelope(mutation):
    value = envelope([])
    if mutation == "extra": value["extra"] = 1
    elif mutation == "missing": del value["data"]
    elif mutation == "witness_extra": value["witness"]["extra"] = 1
    elif mutation == "witness_missing": del value["witness"]["height"]
    elif mutation == "base64": value["data"] = "!"
    elif mutation == "noncanonical": value["data"] = "kB=="
    else:
        raw = {"large": b'x' * (512 * 1024 + 1), "trailing": b'\x90\x00',
               "float": msgpack.packb([1.0]), "extension": msgpack.packb(msgpack.ExtType(1, b'x'))}[mutation]
        value["data"] = base64.b64encode(raw).decode()
    with pytest.raises(sdk.GatewayReadError):
        sdk.decode_finalized_recent_nonces(value, OWNER)


@contextmanager
def client(handler):
    c = sdk.ExchangeClient(gateway_url="https://gateway.test")
    c._http.close()
    c._http = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        yield c
    finally:
        c.close()


def test_four_routes_use_witness_managed_transport_and_typed_results():
    calls = []
    responses = [account(), False, [0, MAX], [order()]]
    def handler(request):
        calls.append(request)
        assert request.headers["cache-control"] == "no-store"
        assert request.headers["accept-encoding"] == "identity"
        return httpx.Response(200, json=envelope(responses.pop(0)))
    with client(handler) as c:
        assert isinstance(c.finalized_account(OWNER), sdk.FinalizedAccountInfo)
        assert not c.finalized_agent_authorization(OWNER, OTHER).authorized
        assert c.finalized_recent_nonces(OWNER).recent == [0, MAX]
        assert not c.finalized_open_orders(OWNER, limit=1).complete
    assert [r.url.path for r in calls] == [f"/v1/account/{OWNER.hex()}", f"/v1/account/{OWNER.hex()}/agents/{OTHER.hex()}", f"/v1/account/{OWNER.hex()}/recent-nonces", f"/v1/orders/{OWNER.hex()}"]
    assert all(r.url.params["witness"] == "1" for r in calls)
    assert calls[-1].url.params["limit"] == "1"


@pytest.mark.parametrize("status", [401, 404, 429, 503])
def test_http_refusal_never_becomes_empty_success(status):
    with client(lambda _: httpx.Response(status, text="refused")) as c:
        with pytest.raises(sdk.ProofTradingSdkError):
            c.finalized_open_orders(OWNER)


def test_invalid_request_and_timeout_do_not_send():
    def unexpected(_): raise AssertionError("request sent")
    with client(unexpected) as c:
        for call in [lambda: c.finalized_account("bad"), lambda: c.finalized_agent_authorization(OWNER, b''), lambda: c.finalized_open_orders(OWNER, limit=True), lambda: c.finalized_recent_nonces(OWNER, timeout=0)]:
            with pytest.raises(sdk.GatewayReadError): call()
