"""TR-5 delegated-owner and TR-6 immutable trigger-history parity."""

from __future__ import annotations

import copy

import httpx
import pytest

from proof_trading_sdk import TriggerLimb, generate_keypair, pubkey_to_owner
from proof_trading_sdk.client import ExchangeClient
from proof_trading_sdk.errors import ProofTradingSdkError
from proof_trading_sdk.trigger_history import (
    decode_position_trigger_history_page,
    decode_trigger_market_history_page,
)

OWNER = "aabbccdd00112233445566778899aabbccddeeff"


def _client(handler=lambda _request: httpx.Response(500)) -> ExchangeClient:
    client = ExchangeClient(gateway_url="http://gateway", chain_id=b"\0" * 32)
    client._http = httpx.Client(
        base_url="http://gateway", transport=httpx.MockTransport(handler)
    )
    return client


def _executed_event() -> dict:
    return {
        "event_key": "101:18446744073709551615:0",
        "block_height": "101",
        "execution_ordinal": "18446744073709551615",
        "event_ordinal": "0",
        "block_time": "2026-04-19T20:20:00.123456789Z",
        "event_type": "position_trigger_executed",
        "owner": OWNER,
        "market": "7",
        "payload": {
            "event_key": "101:18446744073709551615:0",
            "block_height": "101",
            "execution_ordinal": "18446744073709551615",
            "event_ordinal": "0",
            "owner": OWNER,
            "market": "7",
            "position_epoch": "3",
            "group_id": "18446744073709551615",
            "limb_id": "11",
            "client_group_id": "0",
            "client_trigger_id": "0",
            "limb_kind": "stop_loss",
            "trigger_price": "95000",
            "frozen_mark": "94000",
            "limit_price": "93000",
            "requested_quantity": "4",
            "filled_quantity": "3",
            "residual_quantity": "1",
            "execution_order_id": "18446744073709551615",
            "total_fee": "-7",
            "result": "partial",
            "reason": "no_eligible_liquidity",
        },
    }


def _set_event() -> dict:
    return {
        "event_key": "100:1:0",
        "block_height": "100",
        "execution_ordinal": "1",
        "event_ordinal": "0",
        "block_time": "2026-04-19T20:10:00Z",
        "event_type": "position_triggers_set",
        "owner": OWNER,
        "market": "7",
        "payload": {
            "event_key": "100:1:0",
            "block_height": "100",
            "execution_ordinal": "1",
            "event_ordinal": "0",
            "owner": OWNER,
            "market": "7",
            "position_epoch": "3",
            "group_id": "9",
            "client_group_id": "0",
            "stop_limb_id": "10",
            "stop_client_trigger_id": "0",
            "take_profit_limb_id": "11",
            "take_profit_client_trigger_id": "0",
            "accepted_height": "100",
            "active_from_height": "101",
            "replaced_group_id": "0",
        },
    }


def _market_event(kind: str) -> dict:
    height = "201" if kind == "trigger_market_resumed" else "200"
    payload = {
        "event_key": f"{height}:4:0",
        "block_height": height,
        "execution_ordinal": "4",
        "event_ordinal": "0",
        "market": "7",
    }
    payload[
        "previous_reason" if kind == "trigger_market_resumed" else "reason"
    ] = "mark_stale"
    return {
        "event_key": f"{height}:4:0",
        "block_height": height,
        "execution_ordinal": "4",
        "event_ordinal": "0",
        "block_time": "2026-04-19T20:51:00Z",
        "event_type": kind,
        "owner": None,
        "market": "7",
        "payload": payload,
    }


def test_history_clients_use_gateway_routes_filters_and_lossless_models():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.startswith("/v1/history/trigger-markets/"):
            return httpx.Response(
                200,
                json={
                    "trigger_market_events": [
                        _market_event("trigger_market_resumed"),
                        _market_event("trigger_market_deferred"),
                    ],
                    "next_cursor": "",
                },
            )
        return httpx.Response(
            200,
            json={
                "trigger_events": [_executed_event(), _set_event()],
                "next_cursor": "opaque+/=token",
            },
        )

    client = _client(handler)
    owner_page = client.history_triggers(
        OWNER.upper(),
        market=7,
        from_=1_700_000_000_001,
        to="2026-04-19T20:51:00Z",
        limit=2,
        cursor="opaque+/=prior",
    )
    market_page = client.history_trigger_markets(7, limit=1)

    assert owner_page.next_cursor == "opaque+/=token"
    assert owner_page.trigger_events[0].execution_ordinal == str((1 << 64) - 1)
    assert owner_page.trigger_events[0].payload["execution_order_id"] == str(
        (1 << 64) - 1
    )
    assert market_page.trigger_market_events[0].owner is None
    assert seen[0].url.path == f"/v1/history/triggers/{OWNER}"
    assert dict(seen[0].url.params) == {
        "from": "1700000000001",
        "to": "2026-04-19T20:51:00Z",
        "limit": "2",
        "cursor": "opaque+/=prior",
        "market": "7",
    }
    assert seen[1].url == httpx.URL(
        "http://gateway/v1/history/trigger-markets/7?limit=1"
    )


def test_history_decoders_fail_closed_on_envelope_numbers_and_drift():
    with pytest.raises(ProofTradingSdkError, match="unexpected or missing"):
        decode_position_trigger_history_page(
            {"trigger_market_events": [], "next_cursor": ""}, OWNER
        )

    numeric = _executed_event()
    numeric["payload"]["execution_order_id"] = (1 << 64) - 1
    with pytest.raises(ProofTradingSdkError, match="must remain a string"):
        decode_position_trigger_history_page(
            {"trigger_events": [numeric], "next_cursor": ""}, OWNER
        )

    drift = _executed_event()
    drift["payload"]["event_key"] = "101:1:0"
    with pytest.raises(ProofTradingSdkError, match="identity disagrees"):
        decode_position_trigger_history_page(
            {"trigger_events": [drift], "next_cursor": ""}, OWNER
        )

    with pytest.raises(ProofTradingSdkError, match="newest-first"):
        decode_position_trigger_history_page(
            {"trigger_events": [_set_event(), _executed_event()], "next_cursor": ""},
            OWNER,
        )

    shared = _market_event("trigger_market_deferred")
    shared["owner"] = OWNER
    with pytest.raises(ProofTradingSdkError, match="owner does not match"):
        decode_trigger_market_history_page(
            {"trigger_market_events": [shared], "next_cursor": ""}, 7
        )

    nonconserving = copy.deepcopy(_executed_event())
    nonconserving["payload"]["residual_quantity"] = "2"
    with pytest.raises(ProofTradingSdkError, match="do not conserve"):
        decode_position_trigger_history_page(
            {"trigger_events": [nonconserving], "next_cursor": ""}, OWNER
        )

    impossible_terminal = copy.deepcopy(_executed_event())
    impossible_terminal["payload"]["result"] = "filled"
    impossible_terminal["payload"]["reason"] = ""
    with pytest.raises(ProofTradingSdkError, match="result, quantities, and reason disagree"):
        decode_position_trigger_history_page(
            {"trigger_events": [impossible_terminal], "next_cursor": ""}, OWNER
        )

    wrong_market_reason = _market_event("trigger_market_deferred")
    wrong_market_reason["payload"]["reason"] = "below_maintenance"
    with pytest.raises(ProofTradingSdkError, match="unknown payload.reason"):
        decode_trigger_market_history_page(
            {"trigger_market_events": [wrong_market_reason], "next_cursor": ""}, 7
        )


def test_delegated_owner_conveniences_preserve_wire_owner(monkeypatch):
    secret = bytes([0x42]) * 32
    client = ExchangeClient(
        gateway_url="http://gateway", chain_id=b"\0" * 32, secret_key=secret
    )
    delegated_owner = bytes([0x7A]) * 20
    signer_owner = pubkey_to_owner(generate_keypair(secret)["public_key"])
    assert delegated_owner != signer_owner
    submitted = []

    def submit(action):
        submitted.append(action)
        return {"code": 0}

    monkeypatch.setattr(client, "submit", submit)
    client.set_position_triggers(
        7,
        3,
        owner=delegated_owner,
        stop_loss=TriggerLimb(95_000, 75),
    )
    client.cancel_position_triggers(7, 3, owner=delegated_owner)

    assert submitted[0].owner == delegated_owner
    assert submitted[1].owner == delegated_owner


def test_history_request_filters_fail_before_transport():
    called = False

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(200, json={})

    client = _client(handler)
    with pytest.raises(ValueError, match="cursor"):
        client.history_triggers(OWNER, cursor="")
    with pytest.raises(ValueError, match="market"):
        client.history_trigger_markets(-1)
    with pytest.raises(ValueError, match="RFC3339"):
        client.history_triggers(OWNER, from_="yesterday")
    assert called is False
