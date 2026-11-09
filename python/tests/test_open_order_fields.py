import base64
import json
from pathlib import Path
from copy import deepcopy

import httpx
import msgpack
import pytest

from proof_trading_sdk import CodecError, ExchangeClient, SdkConfig
from proof_trading_sdk._native import MAX_OPEN_ORDERS_BYTES

OWNER = b"\xab" * 20
MAX_U64 = 2**64 - 1


def order():
    return [
        9007199254740993, 7, OWNER, "Buy", MAX_U64, 20,
        MAX_U64, 23, 3, 1794182400000, MAX_U64, "Gtc", True, False,
    ]


@pytest.fixture
def client():
    client = ExchangeClient(config=SdkConfig(gateway_url="https://gateway.example"))
    client._http.close()
    yield client
    client.close()


def mock(client, rows):
    raw = msgpack.packb(rows, use_bin_type=True)
    client._http = httpx.Client(transport=httpx.MockTransport(
        lambda _: httpx.Response(200, json={"data": base64.b64encode(raw).decode()})
    ))


def test_every_wire_field_survives_exactly(client):
    mock(client, [order()])
    assert client.open_orders("0x" + OWNER.hex().upper()) == [{
        "id": 9007199254740993, "market": 7, "owner": OWNER, "side": "Buy",
        "price": MAX_U64, "quantity": 20, "client_order_id": MAX_U64,
        "original_quantity": 23, "filled_quantity": 3,
        "created_at_ms": 1794182400000, "queue_priority": MAX_U64,
        "time_in_force": "Gtc", "post_only": True, "reduce_only": False,
    }]


def test_legacy_rows_use_canonical_wire_defaults(client):
    row = order()[:6]
    row[2] = list(OWNER)
    mock(client, [row])
    result = client.open_orders(OWNER)[0]
    assert result["owner"] == OWNER
    assert result["client_order_id"] is None
    assert result["original_quantity"] == result["filled_quantity"] == 0
    assert result["created_at_ms"] == result["queue_priority"] == 0
    assert result["time_in_force"] == "Gtc"
    assert result["post_only"] is result["reduce_only"] is False


def test_future_appended_fields_do_not_drop_known_metadata(client):
    mock(client, [order() + ["future", 123]])
    assert client.open_orders(OWNER)[0]["client_order_id"] == MAX_U64


def test_absent_client_id_and_empty_list(client):
    row = order()
    row[6] = None
    mock(client, [row])
    assert client.open_orders(OWNER)[0]["client_order_id"] is None
    client._http.close()
    mock(client, [])
    assert client.open_orders(OWNER) == []


def malformed_rows():
    yield None
    yield {}
    yield [order()[:5]]
    yield [order(), deepcopy(order())]
    lower = order()
    lower[0] -= 1
    yield [order(), lower]
    for index, value in [
        (0, -1), (1, True), (2, b"\xcd" * 20), (2, b"short"),
        (2, OWNER + b"X"), (2, list(OWNER) + [88]),
        (2, [256] + list(OWNER[1:])), (2, [True] + list(OWNER[1:])),
        (3, "NotASide"), (4, 10.0), (5, 0), (6, -1), (6, True),
        (7, "23"), (8, -1), (9, None), (10, -1), (11, "Unknown"),
        (12, 1), (13, "false"),
    ]:
        row = order()
        row[index] = value
        yield [row]


@pytest.mark.parametrize("rows", list(malformed_rows()))
def test_invalid_rows_never_become_empty_or_partial_state(client, rows):
    mock(client, rows)
    with pytest.raises(CodecError):
        client.open_orders(OWNER)


@pytest.mark.parametrize("data", [None, "", "%%%", "kJA=", 10])
def test_malformed_envelopes(client, data):
    client._http = httpx.Client(transport=httpx.MockTransport(
        lambda _: httpx.Response(200, json={"data": data})
    ))
    with pytest.raises(CodecError):
        client.open_orders(OWNER)


def test_oversized_response_rejected(client):
    raw = b"\x90" + bytes(MAX_OPEN_ORDERS_BYTES)
    client._http = httpx.Client(transport=httpx.MockTransport(
        lambda _: httpx.Response(200, json={"data": base64.b64encode(raw).decode()})
    ))
    with pytest.raises(CodecError):
        client.open_orders(OWNER)


@pytest.mark.parametrize("owner", ["xyz", bytes(19), True])
def test_bad_owner_rejected_before_request(client, owner):
    client._http = httpx.Client(transport=httpx.MockTransport(lambda _: pytest.fail("bad owner sent")))
    with pytest.raises(ValueError):
        client.open_orders(owner)


SHARED_VECTORS = json.loads((Path(__file__).parents[2] / "conformance" / "open-orders.json").read_text())


@pytest.mark.parametrize("vector", SHARED_VECTORS, ids=lambda v: v["name"])
def test_shared_typescript_python_read_contract(client, vector):
    client._http = httpx.Client(transport=httpx.MockTransport(
        lambda _: httpx.Response(200, json={"data": vector["msgpack_base64"]})
    ))
    orders = client.open_orders(vector["owner"])
    normalized = [{
        key: value.hex() if isinstance(value, bytes) else
        str(value) if type(value) is int and key != "market" else value
        for key, value in order.items()
    } for order in orders]
    assert normalized == vector["orders"]
