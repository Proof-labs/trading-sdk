"""List actions report every entry; a single order keeps its old error."""

import json

import httpx
import pytest

from proof_trading_sdk import (
    Closed,
    ExchangeClient,
    NothingToClose,
    OrderResultUnreadable,
    Side,
    TimeInForce,
    check_order_result,
)
from proof_trading_sdk.actions import (
    AtomicBasketLeg,
    AtomicBasketOrder,
    CancelClientOrder,
    CancelOrder,
    MarketOrder,
    OrderEntry,
    PlaceOrder,
)
from proof_trading_sdk.chain_evidence import TransactionEvidenceEvent
from proof_trading_sdk.client import AccountState
from proof_trading_sdk.order_lists import (
    OrderCancellation,
    OrderPlacement,
    order_cancellations,
    order_placements,
)

SEED = bytes([7]) * 32
OWNER = bytes([1]) * 20


def _event(event_type, entries, **attributes):
    attrs = [{"key": "owner", "value": OWNER.hex()}]
    attrs += [{"key": k, "value": v} for k, v in attributes.items()]
    attrs.append({"key": "orders", "value": json.dumps(entries)})
    return {"type": event_type, "attributes": attrs}


def _raw_placed(orders):
    """An ``orders_placed`` whose ``orders`` attribute is ``orders`` verbatim."""
    return {"type": "orders_placed", "attributes": [
        {"key": "owner", "value": OWNER.hex()}, {"key": "orders", "value": orders},
    ]}


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
EXECUTED = {
    "outcome": "executed", "market": "2", "client_order_id": "3", "order_id": "10",
    "requested_quantity": "5", "filled_quantity": "2", "unfilled": "no_liquidity",
}
FILLED = {
    "outcome": "executed", "market": "2", "client_order_id": "", "order_id": "11",
    "requested_quantity": "4", "filled_quantity": "4", "unfilled": "",
}
REFUSED_CLOSE = {"outcome": "rejected", "market": "2", "client_order_id": "", "code": "12"}
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
    (MarketOrder(market=1, owner=OWNER, side="Buy", quantity=1), _placed(REJECTED), 12),
    (CancelOrder(order_id=42, owner=OWNER), _cancelled(REFUSED_ID), 2),
    (CancelClientOrder(owner=OWNER, client_order_id=11), _cancelled(REFUSED_CLOID), 44),
])
def test_a_refused_single_is_reported_in_its_entry(answer, action, event, code):
    # A single order or cancel is a list of one: its refusal is its entry.
    data = answer(event).submit(action)
    assert data["code"] == 0
    [entry] = order_placements(data) or order_cancellations(data)
    assert entry.code == code


@pytest.mark.parametrize("action, event", [
    (PlaceOrder(market=1, owner=OWNER, side="Buy", price=1, quantity=1), _placed(RESTING)),
    (MarketOrder(market=2, owner=OWNER, side="Buy", quantity=5), _placed(EXECUTED)),
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
    placements = answer(_placed(RESTING, EXECUTED, REJECTED)).place_orders([entry] * 3).orders
    assert placements == [
        OrderPlacement(
            outcome="resting", market=1, order_id=9, side=Side.Buy, price=100,
            quantity=5, time_in_force=TimeInForce.Gtc, post_only=True, reduce_only=False,
        ),
        OrderPlacement(
            outcome="executed", market=2, client_order_id=3, order_id=10,
            requested_quantity=5, filled_quantity=2, unfilled="no_liquidity",
        ),
        OrderPlacement(
            outcome="rejected", market=1, client_order_id=7, code=12,
            error_name=placements[2].error_name,
        ),
    ]
    assert placements[2].rejected and placements[2].error_name


def test_a_list_of_one_refused_does_not_raise(answer):
    entry = OrderEntry(market=1, side="Buy", price=100, quantity=5)
    [placement] = answer(_placed(REJECTED)).place_orders([entry]).orders
    assert placement.rejected and placement.code == 12


def test_cancel_orders_reports_each_entry(answer):
    cancellations = answer(_cancelled(CANCELLED, REFUSED_ID)).cancel_orders([9, 42]).orders
    assert cancellations[0] == OrderCancellation(
        outcome="cancelled", order_id=9, market=1, original_quantity=5,
        remaining_quantity=3, filled_quantity=2,
    )
    assert cancellations[1].refused and cancellations[1].order_id == 42
    assert cancellations[1].code == 2


def test_cancel_client_orders_reports_each_entry(answer):
    [refused] = answer(_cancelled(REFUSED_CLOID)).cancel_client_orders([11]).orders
    assert refused.refused and refused.client_order_id == 11 and refused.code == 44


PLACE = PlaceOrder(market=1, owner=OWNER, side="Buy", price=1, quantity=1)


@pytest.mark.parametrize("action, events", [
    (PLACE, []),
    (PLACE, [_raw_placed("{}")]),
    (PLACE, [_raw_placed("not json")]),
    (PLACE, [{"type": "orders_placed", "attributes": [{"key": "owner", "value": OWNER.hex()}]}]),
    (PLACE, [_placed(REJECTED, REJECTED)]),
    (PLACE, [_placed({"outcome": "rejected", "market": "1"})]),
    # Values Rust and TypeScript refuse are refused here too.
    (PLACE, [_placed({**RESTING, "side": "BUY"})]),
    (PLACE, [_placed({**RESTING, "post_only": "1"})]),
    (PLACE, [_placed({**RESTING, "time_in_force": "day"})]),
    (PLACE, [_placed({k: v for k, v in RESTING.items() if k != "order_id"})]),
    (CancelOrder(order_id=42, owner=OWNER), [_event("orders_cancelled", [REFUSED_ID], reason="self_trade")]),
    (CancelOrder(order_id=42, owner=OWNER), [_cancelled({"outcome": "refused", "order_id": "42"})]),
])
def test_an_executed_single_that_does_not_read_is_unreadable(answer, action, events):
    with pytest.raises(OrderResultUnreadable) as raised:
        answer(*events).submit(action)
    assert len(raised.value.tx_hash) == 64
    assert "do NOT re-submit" in str(raised.value)


def test_an_unreadable_list_raises_instead_of_returning_entries(answer):
    entry = OrderEntry(market=1, side="Buy", price=100, quantity=5)
    with pytest.raises(OrderResultUnreadable):
        answer().cancel_orders([1])
    with pytest.raises(OrderResultUnreadable):
        answer(_placed(RESTING)).place_orders([entry, entry])
    with pytest.raises(OrderResultUnreadable):
        answer(_placed(RESTING, {"outcome": "lost", "market": "1"})).place_orders([entry, entry])


def test_a_refused_list_of_one_sent_as_bytes_reads_as_a_list(answer):
    client = answer(_placed(REJECTED))
    data = client.submit_action(client.sign_action(PLACE))
    assert data["code"] == 0
    assert order_placements(data)[0].code == 12


def _evidence(*events):
    return tuple(
        TransactionEvidenceEvent(type=e["type"], attributes=tuple(e["attributes"])) for e in events
    )


def test_a_reconciled_list_of_one_does_not_raise():
    check_order_result("A" * 64, _evidence(_placed(REJECTED)))
    check_order_result("A" * 64, _evidence(_cancelled(REFUSED_CLOID)))


def test_a_reconciled_result_reads_like_the_synchronous_one():
    check_order_result("A" * 64, _evidence(_placed(RESTING)))
    check_order_result("A" * 64, _evidence(_placed(REJECTED, RESTING)))
    check_order_result("A" * 64, _evidence())
    with pytest.raises(OrderResultUnreadable) as raised:
        check_order_result("A" * 64, _evidence(_raw_placed("[1]")))
    assert raised.value.tx_hash == "A" * 64


def test_place_orders_takes_market_entries(answer):
    entries = [
        OrderEntry(market=1, side="Buy", price=100, quantity=5),
        OrderEntry.market_order(2, "Sell", 4, worst_price=90),
    ]
    _, filled = answer(_placed(RESTING, FILLED)).place_orders(entries).orders
    assert (filled.outcome, filled.filled_quantity, filled.requested_quantity) == (
        "executed", 4, 4,
    )
    assert filled.unfilled is None


def test_basket_legs_read_from_orders_placed(answer):
    basket = AtomicBasketOrder(
        owner=OWNER,
        legs=[AtomicBasketLeg(market=2, side="Buy", price=100, quantity=4)],
        max_slippage_bps=50,
    )
    [leg] = order_placements(answer(_placed(FILLED)).submit(basket))
    assert leg.outcome == "executed" and leg.filled_quantity == 4


def _closing(answer, monkeypatch, positions, *events):
    client = answer(*events)
    monkeypatch.setattr(client, "account", lambda owner=None: AccountState(positions=positions))
    sent = []
    sign = client.sign_action

    def spy(action):
        sent.append(action)
        return sign(action)

    monkeypatch.setattr(client, "sign_action", spy)
    return client, sent


@pytest.mark.parametrize("side, closing_side", [("Buy", "Sell"), ("Sell", "Buy")])
def test_close_position_sends_a_reduce_only_market_order(answer, monkeypatch, side, closing_side):
    positions = [
        {"market": 1, "side": "Buy", "size": 9},
        {"market": 2, "side": side, "size": 4},
    ]
    client, sent = _closing(answer, monkeypatch, positions, _placed(FILLED))
    closed = client.close_position(2, owner=OWNER)
    assert isinstance(closed, Closed) and closed.tx["code"] == 0
    [order] = sent
    assert isinstance(order, MarketOrder)
    assert (order.market, order.owner, order.side, order.quantity, order.reduce_only) == (
        2, OWNER, closing_side, 4, True,
    )


def test_close_position_on_a_flat_account_sends_nothing(answer, monkeypatch):
    positions = [{"market": 1, "side": "Buy", "size": 9}]
    client, sent = _closing(answer, monkeypatch, positions)
    assert client.close_position(2, owner=OWNER) == NothingToClose()
    assert sent == []


def test_an_unreadable_close_raises_unreadable(answer, monkeypatch):
    positions = [{"market": 2, "side": "Buy", "size": 4}]
    client, _ = _closing(answer, monkeypatch, positions)
    with pytest.raises(OrderResultUnreadable):
        client.close_position(2, owner=OWNER)


@pytest.mark.parametrize("code", [12, 35])
def test_a_refused_close_is_reported_in_its_entry(answer, monkeypatch, code):
    # 35: the position went flat between the read and the close.
    positions = [{"market": 2, "side": "Buy", "size": 4}]
    refused = {**REFUSED_CLOSE, "code": str(code)}
    client, _ = _closing(answer, monkeypatch, positions, _placed(refused))
    closed = client.close_position(2, owner=OWNER)
    assert closed.tx["code"] == 0
    assert order_placements(closed.tx)[0].code == code


def test_a_refused_list_returns_its_code_and_no_orders():
    # A stale nonce refuses the whole transaction: a value, not an exception.
    def handler(request):
        return httpx.Response(200, json={
            "status": "error", "code": 21, "height": 5, "txHash": "A" * 64,
            "log": "invalid nonce", "events": [],
        })

    client = ExchangeClient(gateway_url="http://test-gateway", chain_id=b"\x00" * 32, secret_key=SEED)
    client._http.close()
    client._http = httpx.Client(base_url="http://test-gateway", transport=httpx.MockTransport(handler))
    try:
        entry = OrderEntry(market=1, side="Buy", price=100, quantity=5)
        result = client.place_orders([entry, entry])
        assert result.tx["code"] == 21
        assert result.orders == []
    finally:
        client.close()
