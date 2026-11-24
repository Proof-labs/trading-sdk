"""Batch actions report each order's outcome; a single order is a batch of one."""

import json

import httpx
import pytest

from proof_trading_sdk import (
    CancelledOrder,
    ExchangeClient,
    ExecutedOrder,
    NothingToClose,
    OrderResultUnreadable,
    RefusedCancel,
    RejectedOrder,
    RestingOrder,
    Sent,
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


def test_place_orders_reports_each_order_without_raising(answer):
    entry = OrderEntry(market=1, side="Buy", price=100, quantity=5)
    placements = answer(_placed(RESTING, EXECUTED, REJECTED)).place_orders([entry] * 3).orders
    assert placements == [
        RestingOrder(
            market=1, client_order_id=None, order_id=9, side=Side.Buy, price=100,
            quantity=5, time_in_force=TimeInForce.Gtc, post_only=True, reduce_only=False,
        ),
        ExecutedOrder(
            market=2, client_order_id=3, order_id=10, requested_quantity=5,
            filled_quantity=2, unfilled="no_liquidity",
        ),
        RejectedOrder(
            market=1, client_order_id=7, code=12, error_name=placements[2].error_name,
        ),
    ]
    assert [p.outcome for p in placements] == ["resting", "executed", "rejected"]
    assert placements[2].error_name


def test_place_order_returns_its_outcome(answer):
    entry = OrderEntry(market=1, side="Buy", price=100, quantity=5)
    result = answer(_placed(REJECTED)).place_order(entry)
    assert result.tx["code"] == 0
    match result.orders[0]:
        case RejectedOrder(code=code):
            assert code == 12
        case other:
            raise AssertionError(f"expected a rejected order, got {other!r}")


def test_cancel_order_returns_its_outcome(answer):
    [refused] = answer(_cancelled(REFUSED_ID)).cancel_order(42).orders
    assert isinstance(refused, RefusedCancel) and refused.code == 2
    [landed] = answer(_cancelled(CANCELLED)).cancel_client_order(9).orders
    assert isinstance(landed, CancelledOrder)


def test_cancel_orders_reports_each_entry(answer):
    cancellations = answer(_cancelled(CANCELLED, REFUSED_ID)).cancel_orders([9, 42]).orders
    assert cancellations[0] == CancelledOrder(
        order_id=9, market=1, client_order_id=None, original_quantity=5,
        remaining_quantity=3, filled_quantity=2,
    )
    assert cancellations[1] == RefusedCancel(
        order_id=42, client_order_id=None, code=2, error_name=cancellations[1].error_name,
    )


PLACE = PlaceOrder(market=1, owner=OWNER, side="Buy", price=1, quantity=1)


@pytest.mark.parametrize("action, events", [
    (PLACE, [_raw_placed("{}")]),
    (PLACE, [_raw_placed("not json")]),
    (PLACE, [{"type": "orders_placed", "attributes": [{"key": "owner", "value": OWNER.hex()}]}]),
    (PLACE, [_placed({"outcome": "rejected", "market": "1"})]),
    # Values Rust and TypeScript refuse are refused here too.
    (PLACE, [_placed({**RESTING, "side": "BUY"})]),
    (PLACE, [_placed({**RESTING, "post_only": "1"})]),
    (PLACE, [_placed({**RESTING, "time_in_force": "day"})]),
    (PLACE, [_placed({k: v for k, v in RESTING.items() if k != "order_id"})]),
    (PLACE, [_placed({**EXECUTED, "unfilled": 3})]),
    (PLACE, [_placed({**EXECUTED, "unfilled": ["no_liquidity"]})]),
    (CancelOrder(order_id=42, owner=OWNER), [_cancelled({"outcome": "refused", "order_id": "42"})]),
    (CancelOrder(order_id=42, owner=OWNER), [_cancelled({"outcome": "refused", "code": "2"})]),
])
def test_an_executed_result_that_does_not_read_is_unreadable(answer, action, events):
    with pytest.raises(OrderResultUnreadable) as raised:
        answer(*events).submit(action)
    assert len(raised.value.tx_hash) == 64
    assert "do NOT re-submit" in str(raised.value)


@pytest.mark.parametrize("value", [
    4.9, 4, True, False, "-1", "+1", "01", " 1", "1\n", "1.0", "１", "9" * 5000,
])
@pytest.mark.parametrize("event, entry, key", [
    (_placed, RESTING, "price"),
    (_placed, RESTING, "quantity"),
    (_placed, EXECUTED, "market"),
    (_placed, EXECUTED, "order_id"),
    (_placed, EXECUTED, "client_order_id"),
    (_placed, EXECUTED, "requested_quantity"),
    (_placed, EXECUTED, "filled_quantity"),
    (_placed, REJECTED, "code"),
    (_cancelled, CANCELLED, "market"),
    (_cancelled, CANCELLED, "original_quantity"),
    (_cancelled, CANCELLED, "remaining_quantity"),
    (_cancelled, CANCELLED, "filled_quantity"),
    (_cancelled, REFUSED_ID, "order_id"),
    (_cancelled, REFUSED_CLOID, "client_order_id"),
    (_cancelled, REFUSED_ID, "code"),
])
def test_numeric_order_attributes_never_coerce_invalid_values(answer, event, entry, key, value):
    with pytest.raises(OrderResultUnreadable) as raised:
        answer(event({**entry, key: value})).submit(PLACE)
    assert len(raised.value.tx_hash) == 64


@pytest.mark.parametrize("event, entry, key, bits, read", [
    (_placed, EXECUTED, "market", 32, order_placements),
    (_placed, REJECTED, "code", 32, order_placements),
    (_placed, EXECUTED, "order_id", 64, order_placements),
    (_placed, EXECUTED, "client_order_id", 64, order_placements),
    (_placed, EXECUTED, "requested_quantity", 64, order_placements),
    (_placed, EXECUTED, "filled_quantity", 64, order_placements),
    (_cancelled, CANCELLED, "market", 32, order_cancellations),
    (_cancelled, REFUSED_ID, "code", 32, order_cancellations),
    (_cancelled, CANCELLED, "remaining_quantity", 64, order_cancellations),
    (_cancelled, REFUSED_CLOID, "client_order_id", 64, order_cancellations),
])
def test_numeric_order_attributes_preserve_wire_boundaries(answer, event, entry, key, bits, read):
    for value in (0, (1 << bits) - 1):
        response = answer(event({**entry, key: str(value)})).submit(PLACE)
        assert getattr(read(response)[0], key) == value
    with pytest.raises(OrderResultUnreadable):
        answer(event({**entry, key: str(1 << bits)})).submit(PLACE)


@pytest.mark.parametrize("value", [42, True, None, [], [RESTING], {}, {"orders": []}])
@pytest.mark.parametrize("kind", ["orders_placed", "orders_cancelled"])
def test_non_string_order_lists_preserve_the_executed_verdict(answer, kind, value):
    event = _raw_placed(value)
    event["type"] = kind
    event["attributes"].append({"key": "reason", "value": "user_requested"})
    with pytest.raises(OrderResultUnreadable) as raised:
        answer(event).submit(PLACE)
    assert len(raised.value.tx_hash) == 64
    assert "do NOT re-submit" in str(raised.value)


def test_an_unreadable_list_raises_instead_of_returning_entries(answer):
    entry = OrderEntry(market=1, side="Buy", price=100, quantity=5)
    with pytest.raises(OrderResultUnreadable):
        answer(_placed(RESTING, {"outcome": "lost", "market": "1"})).place_orders([entry, entry])


@pytest.mark.parametrize("raw", [
    _raw_placed("[1]"),
    _raw_placed(42),
    _placed({**EXECUTED, "filled_quantity": 4.9}),
    _cancelled({**CANCELLED, "remaining_quantity": str(1 << 64)}),
])
def test_a_reconciled_result_that_does_not_read_is_unreadable(raw):
    evidence = (TransactionEvidenceEvent(type=raw["type"], attributes=tuple(raw["attributes"])),)
    with pytest.raises(OrderResultUnreadable) as raised:
        check_order_result("A" * 64, evidence)
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


def test_an_unfilled_reason_newer_than_the_sdk_still_reads(answer):
    [filled] = order_placements(
        answer(_placed({**EXECUTED, "unfilled": "queue_full"})).submit(PLACE)
    )
    assert (filled.unfilled, filled.filled_quantity) == ("queue_full", 2)


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
    assert isinstance(closed, Sent) and closed.tx["code"] == 0
    assert isinstance(closed.order, ExecutedOrder)
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


@pytest.mark.parametrize("code", [12, 35])
def test_a_rejected_close_is_sent_with_its_order_rejected(answer, monkeypatch, code):
    # 35: the position went flat between the read and the close.
    positions = [{"market": 2, "side": "Buy", "size": 4}]
    refused = {**REFUSED_CLOSE, "code": str(code)}
    client, _ = _closing(answer, monkeypatch, positions, _placed(refused))
    sent = client.close_position(2, owner=OWNER)
    assert isinstance(sent, Sent) and sent.tx["code"] == 0
    assert isinstance(sent.order, RejectedOrder) and sent.order.code == code


def test_a_refused_batch_returns_its_code_and_no_orders():
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
        assert result.orders is None
        assert client.place_order(entry).orders is None
    finally:
        client.close()


def test_an_acknowledged_batch_without_a_verdict_has_no_orders():
    # A legacy code-less CheckTx acknowledgement has not executed: no
    # outcomes yet, as TypeScript's null and Rust's None.
    def handler(request):
        return httpx.Response(200, json={"status": "ok"})

    client = ExchangeClient(gateway_url="http://test-gateway", chain_id=b"\x00" * 32, secret_key=SEED)
    client._http.close()
    client._http = httpx.Client(base_url="http://test-gateway", transport=httpx.MockTransport(handler))
    try:
        entry = OrderEntry(market=1, side="Buy", price=100, quantity=5)
        assert client.place_orders([entry]).orders is None
        assert client.cancel_orders([42]).orders is None
        assert client.cancel_client_orders([9]).orders is None
    finally:
        client.close()
