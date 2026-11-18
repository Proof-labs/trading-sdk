"""List actions report every entry; a single order keeps its old error."""

import json

import httpx
import pytest

from proof_trading_sdk import ExchangeClient, EngineError, Side, TimeInForce
from proof_trading_sdk.actions import (
    CancelClientOrder,
    CancelOrder,
    OrderEntry,
    PlaceOrder,
)
from proof_trading_sdk.order_lists import OrderCancellation, OrderPlacement

SEED = bytes([7]) * 32
OWNER = bytes([1]) * 20


def _event(event_type, entries, **attributes):
    attrs = [{"key": "owner", "value": OWNER.hex()}]
    attrs += [{"key": k, "value": v} for k, v in attributes.items()]
    attrs.append({"key": "orders", "value": json.dumps(entries)})
    return {"type": event_type, "attributes": attrs}


def _placed(*entries):
    return _event("orders_placed", list(entries))


def _cancelled(*entries):
    return _event("orders_cancelled", list(entries), reason="user_requested")


REJECTED = {"outcome": "rejected", "market": "1", "client_order_id": "7", "code": "12"}
RESTING = {
    "outcome": "resting", "market": "1", "client_order_id": "", "order_id": "9",
    "side": "buy", "price": "100", "quantity": "5", "time_in_force": "gtc",
    "post_only": "true", "reduce_only": "false",
}
EXECUTED = {"outcome": "executed", "market": "2", "client_order_id": "3", "order_id": "10"}
CANCELLED = {
    "outcome": "cancelled", "order_id": "9", "market": "1", "client_order_id": "",
    "original_quantity": "5", "remaining_quantity": "3", "filled_quantity": "2",
}
REFUSED_ID = {"outcome": "refused", "order_id": "42", "code": "2"}
REFUSED_CLOID = {"outcome": "refused", "client_order_id": "11", "code": "44"}


@pytest.fixture
def answer():
    clients = []

    def make(*events):
        def handler(request):
            return httpx.Response(200, json={
                "status": "ok", "code": 0, "height": 5, "txHash": "A" * 64,
                "log": "entry 0 refused", "events": list(events),
            })

        client = ExchangeClient(gateway_url="http://test-gateway", chain_id=b"\x00" * 32, secret_key=SEED)
        client._http.close()
        client._http = httpx.Client(base_url="http://test-gateway", transport=httpx.MockTransport(handler))
        clients.append(client)
        return client

    yield make
    for client in clients:
        client.close()


@pytest.mark.parametrize("action, event, code", [
    (PlaceOrder(market=1, owner=OWNER, side="Buy", price=1, quantity=1), _placed(REJECTED), 12),
    (CancelOrder(order_id=42, owner=OWNER), _cancelled(REFUSED_ID), 2),
    (CancelClientOrder(owner=OWNER, client_order_id=11), _cancelled(REFUSED_CLOID), 44),
])
def test_a_refused_single_raises_its_old_engine_error(answer, action, event, code):
    with pytest.raises(EngineError) as raised:
        answer(event).submit(action)
    assert raised.value.code == code


@pytest.mark.parametrize("action, event", [
    (PlaceOrder(market=1, owner=OWNER, side="Buy", price=1, quantity=1), _placed(RESTING)),
    (CancelOrder(order_id=9, owner=OWNER), _cancelled(CANCELLED)),
])
def test_an_accepted_single_returns_the_response(answer, action, event):
    assert answer(event).submit(action)["code"] == 0


def test_a_single_cancel_ignores_other_cancel_events(answer):
    # A placement's own cancel event never turns a placement into an error.
    data = answer(_placed(RESTING), _cancelled(REFUSED_ID)).submit(
        PlaceOrder(market=1, owner=OWNER, side="Buy", price=1, quantity=1)
    )
    assert data["code"] == 0


def test_place_orders_reports_each_order_without_raising(answer):
    entry = OrderEntry(market=1, side="Buy", price=100, quantity=5)
    placements = answer(_placed(RESTING, EXECUTED, REJECTED)).place_orders([entry] * 3)
    assert placements == [
        OrderPlacement(
            outcome="resting", market=1, order_id=9, side=Side.Buy, price=100,
            quantity=5, time_in_force=TimeInForce.Gtc, post_only=True, reduce_only=False,
        ),
        OrderPlacement(outcome="executed", market=2, client_order_id=3, order_id=10),
        OrderPlacement(
            outcome="rejected", market=1, client_order_id=7, code=12,
            error_name=placements[2].error_name,
        ),
    ]
    assert placements[2].rejected and placements[2].error_name


def test_a_list_of_one_refused_does_not_raise(answer):
    entry = OrderEntry(market=1, side="Buy", price=100, quantity=5)
    [placement] = answer(_placed(REJECTED)).place_orders([entry])
    assert placement.rejected and placement.code == 12


def test_cancel_orders_reports_each_entry(answer):
    cancellations = answer(_cancelled(CANCELLED, REFUSED_ID)).cancel_orders([9, 42])
    assert cancellations[0] == OrderCancellation(
        outcome="cancelled", order_id=9, market=1, original_quantity=5,
        remaining_quantity=3, filled_quantity=2,
    )
    assert cancellations[1].refused and cancellations[1].order_id == 42
    assert cancellations[1].code == 2


def test_cancel_client_orders_reports_each_entry(answer):
    [refused] = answer(_cancelled(REFUSED_CLOID)).cancel_client_orders([11])
    assert refused.refused and refused.client_order_id == 11 and refused.code == 44


def test_no_list_event_is_no_results(answer):
    assert answer().cancel_orders([1]) == []
