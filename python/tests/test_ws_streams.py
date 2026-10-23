"""The Python streams subscribe on the gateway's multiplexed /ws feed."""

from __future__ import annotations

import json

import pytest
import websockets.sync.client as ws_client

from proof_trading_sdk import AccountEventStream, OrderbookDeltaStream
from proof_trading_sdk.client import ExchangeClient
from proof_trading_sdk.errors import TransportError

OWNER = "bd0e11d003efc8a53e4286b41d70abfb65e5f186"


class FakeSocket:
    def __init__(self, frames: list[dict]) -> None:
        self.sent: list[dict] = []
        self.closed = False
        self._frames = [json.dumps(f) for f in frames]

    def send(self, data: str) -> None:
        self.sent.append(json.loads(data))

    def __iter__(self):
        return iter(self._frames)

    def recv(self, timeout: float | None = None) -> str:
        if not self._frames:
            raise TimeoutError
        return self._frames.pop(0)

    def close(self) -> None:
        self.closed = True


def test_subscribes_on_ws_and_yields_account_frames(monkeypatch) -> None:
    socket = FakeSocket(
        [
            {"type": "subscribed", "id": 1, "channel": "accountEvents"},
            {"channel": "accountEvents", "type": "snapshot", "owner": OWNER},
            {"channel": "accountEvents", "type": "fill", "owner": OWNER},
        ]
    )
    calls: list[tuple[str, dict]] = []

    def connect(url: str, additional_headers: dict) -> FakeSocket:
        calls.append((url, additional_headers))
        return socket

    monkeypatch.setattr(ws_client, "connect", connect)
    stream = AccountEventStream(
        "wss://gateway.example", "0x" + OWNER.upper(), api_key="k"
    )
    frames = iter(stream)
    assert next(frames)["type"] == "snapshot"
    assert next(frames)["type"] == "fill"
    stream.close()

    assert calls == [("wss://gateway.example/ws", {"X-API-Key": "k"})]
    assert socket.sent == [
        {
            "method": "subscribe",
            "id": 1,
            "params": {"channel": "accountEvents", "owner": OWNER},
        }
    ]


SNAPSHOT = {"channel": "orderbook", "type": "snapshot", "market": 7, "bids": [], "asks": []}


def fake_connect(monkeypatch, socket: FakeSocket) -> list[str]:
    urls: list[str] = []

    def connect(url: str, **_: object) -> FakeSocket:
        urls.append(url)
        return socket

    monkeypatch.setattr(ws_client, "connect", connect)
    return urls


def test_orderbook_stream_subscribes_on_ws(monkeypatch) -> None:
    update = {"channel": "orderbook", "type": "update", "market": 7, "side": "buy"}
    socket = FakeSocket(
        [{"type": "subscribed", "id": 1, "channel": "orderbook"}, SNAPSHOT, update]
    )
    urls = fake_connect(monkeypatch, socket)
    stream = OrderbookDeltaStream("wss://gateway.example", 7)
    frames = iter(stream)
    assert next(frames) == SNAPSHOT
    assert next(frames) == update
    stream.close()

    assert urls == ["wss://gateway.example/ws"]
    assert socket.sent == [
        {"method": "subscribe", "id": 1, "params": {"channel": "orderbook", "market": 7}}
    ]


def test_orderbook_snapshot_returns_the_ws_snapshot_frame(monkeypatch) -> None:
    socket = FakeSocket([{"type": "subscribed", "id": 1}, SNAPSHOT])
    urls = fake_connect(monkeypatch, socket)
    client = ExchangeClient(gateway_url="https://gateway.example", chain_id=b"\x00" * 32)
    assert client.orderbook_snapshot(7) == SNAPSHOT
    assert urls == ["wss://gateway.example/ws"]
    assert socket.closed


def test_orderbook_snapshot_times_out_instead_of_waiting_for_ever(monkeypatch) -> None:
    socket = FakeSocket([{"type": "subscribed", "id": 1}])
    fake_connect(monkeypatch, socket)
    client = ExchangeClient(gateway_url="https://gateway.example", chain_id=b"\x00" * 32)
    with pytest.raises(TransportError, match="timed out after 0.5s"):
        client.orderbook_snapshot(7, timeout=0.5)
    assert socket.closed


def test_orderbook_snapshot_raises_on_a_refused_subscription(monkeypatch) -> None:
    socket = FakeSocket([{"type": "error", "id": 1, "code": 404, "error": "unknown market"}])
    fake_connect(monkeypatch, socket)
    client = ExchangeClient(gateway_url="https://gateway.example", chain_id=b"\x00" * 32)
    with pytest.raises(TransportError, match="unknown market"):
        client.orderbook_snapshot(7)
