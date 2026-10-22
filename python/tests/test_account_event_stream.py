"""AccountEventStream subscribes on the gateway's multiplexed /ws feed."""

from __future__ import annotations

import json

import websockets.sync.client as ws_client

from proof_trading_sdk import AccountEventStream

OWNER = "bd0e11d003efc8a53e4286b41d70abfb65e5f186"


class FakeSocket:
    def __init__(self, frames: list[dict]) -> None:
        self.sent: list[dict] = []
        self._frames = [json.dumps(f) for f in frames]

    def send(self, data: str) -> None:
        self.sent.append(json.loads(data))

    def __iter__(self):
        return iter(self._frames)

    def close(self) -> None:
        pass


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
