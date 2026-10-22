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


# ── Reconnect recovery ─────────────────────────────────────────────────────


class RecoverySocket(FakeSocket):
    """A socket whose first frames are read by iteration and whose remaining
    frames are already waiting when the stream drains it after a snapshot."""

    def __init__(self, frames: list[dict], waiting: list[dict] | None = None) -> None:
        super().__init__(frames)
        self._waiting = [json.dumps(f) for f in waiting or []]

    def recv(self, timeout: float | None = None) -> str:
        if not self._waiting:
            raise TimeoutError
        return self._waiting.pop(0)


def ev(height: int, tx: str, index: int, kind: str = "trade_executed") -> tuple:
    return (height, tx, index, kind)


def live_frame(e: tuple, keyed: bool = True) -> dict:
    frame = {
        "channel": "accountEvents",
        "type": "account_event",
        "owner": OWNER,
        "eventType": e[3],
        "height": e[0],
        "payload": {"tag": f"{e[0]}-{e[2]}"},
    }
    if keyed:
        frame |= {"txHash": e[1], "txIndex": 0, "eventIndex": e[2]}
    return frame


def history_row(e: tuple, event_id: int) -> dict:
    return {
        "event_id": event_id,
        "owner": OWNER,
        "block_height": e[0],
        "tx_hash": e[1],
        "event_index": e[2],
        "event_type": e[3],
        "payload": {"tag": f"{e[0]}-{e[2]}"},
    }


ACCOUNT_SNAPSHOT = {"channel": "accountEvents", "type": "snapshot", "owner": OWNER}
# The same transaction hash at two heights: only the full key separates them.
A, B, C = ev(10, "AA", 0), ev(10, "AA", 1, "position_updated"), ev(11, "AA", 0)
D, E = ev(12, "DD", 3, "fees_collected"), ev(13, "EE", 0)


def tags(frames: list[dict]) -> list[str]:
    return [
        "snapshot"
        if f["type"] == "snapshot"
        else f["payload"]["tag"] + ("*" if f.get("backfilled") else "")
        for f in frames
    ]


def run_stream(monkeypatch, sockets, pages, count, **kwargs):
    queue = list(sockets)

    def connect(url: str, **_: object):
        if not queue:
            raise ConnectionRefusedError("no more fake sockets")
        return queue.pop(0)

    monkeypatch.setattr(ws_client, "connect", connect)
    # Bounded, so a stream that runs out of fake sockets ends instead of
    # reconnecting for ever (``time.sleep`` is stubbed below).
    kwargs.setdefault("reconnect_attempts", 2)
    reads: list[dict] = []

    class Resp:
        def __init__(self, body: dict) -> None:
            self.status_code = 200 if "account_events" in body else 400
            self._body = body

        def json(self) -> dict:
            return self._body

    def get(url: str, params: dict, **_: object) -> Resp:
        reads.append(params)
        return Resp(pages.pop(0))

    import httpx

    monkeypatch.setattr(httpx, "get", get)
    monkeypatch.setattr("time.sleep", lambda _s: None)
    statuses: list = []
    stream = AccountEventStream(
        "wss://gateway.example", OWNER, on_recovery=statuses.append, **kwargs
    )
    frames = []
    for frame in stream:
        frames.append(frame)
        if len(frames) == count:
            break
    stream.close()
    return frames, statuses, reads


def test_reconnect_backfills_the_outage_exactly_once_in_order(monkeypatch) -> None:
    first = RecoverySocket([ACCOUNT_SNAPSHOT, live_frame(A), live_frame(B)])
    # C and D happen while disconnected; D and E arrive live during the backfill.
    second = RecoverySocket(
        [ACCOUNT_SNAPSHOT, live_frame(ev(14, "FF", 0))],
        waiting=[live_frame(D), live_frame(E)],
    )
    page = {
        "account_events": [
            history_row(D, 4),
            history_row(C, 3),
            history_row(B, 2),
            history_row(A, 1),
        ],
        "next_cursor": "",
    }
    frames, statuses, reads = run_stream(monkeypatch, [first, second], [page], 8)
    assert tags(frames) == [
        "snapshot", "10-0", "10-1", "snapshot", "11-0*", "12-3*", "13-0", "14-0",
    ]
    assert [s.kind for s in statuses] == ["backfilled"]
    assert statuses[0].delivered == 2
    assert reads[0]["order"] == "desc" and reads[0]["owner"] == OWNER


def test_reconnect_retries_while_history_lags(monkeypatch) -> None:
    first = RecoverySocket([ACCOUNT_SNAPSHOT, live_frame(A)])
    second = RecoverySocket([ACCOUNT_SNAPSHOT], waiting=[live_frame(E)])
    pages = [
        {"account_events": [history_row(A, 1)], "next_cursor": ""},
        {
            "account_events": [history_row(E, 3), history_row(C, 2), history_row(A, 1)],
            "next_cursor": "",
        },
    ]
    frames, statuses, _ = run_stream(monkeypatch, [first, second], pages, 5)
    assert tags(frames) == ["snapshot", "10-0", "snapshot", "11-0*", "13-0*"]
    assert [s.kind for s in statuses] == ["backfilled"]


def test_reconnect_without_history_key_reports_unsupported(monkeypatch) -> None:
    first = RecoverySocket([ACCOUNT_SNAPSHOT, live_frame(A, keyed=False)])
    second = RecoverySocket([ACCOUNT_SNAPSHOT, live_frame(E, keyed=False)])
    frames, statuses, reads = run_stream(monkeypatch, [first, second], [], 4)
    assert tags(frames) == ["snapshot", "10-0", "snapshot", "13-0"]
    assert [s.kind for s in statuses] == ["unsupported"]
    assert reads == []


def test_reconnect_reports_a_failed_history_read(monkeypatch) -> None:
    first = RecoverySocket([ACCOUNT_SNAPSHOT, live_frame(A)])
    second = RecoverySocket([ACCOUNT_SNAPSHOT], waiting=[live_frame(E)])
    pages = [{"error": "order_required"}]
    frames, statuses, _ = run_stream(monkeypatch, [first, second], pages, 4)
    assert tags(frames) == ["snapshot", "10-0", "snapshot", "13-0"]
    assert [s.kind for s in statuses] == ["failed"]


def test_reconnect_matches_a_legacy_settlement_name_to_history(monkeypatch) -> None:
    met = ev(10, "AA", 2, "conditional_settled")
    not_met = ev(12, "DD", 1, "conditional_voided")
    first = RecoverySocket([ACCOUNT_SNAPSHOT, live_frame(met)])
    second = RecoverySocket([ACCOUNT_SNAPSHOT], waiting=[live_frame(not_met)])
    page = {
        "account_events": [
            history_row((*not_met[:3], "condition_not_met"), 3),
            history_row(C, 2),
            history_row((*met[:3], "condition_met"), 1),
        ],
        "next_cursor": "",
    }
    frames, statuses, _ = run_stream(monkeypatch, [first, second], [page], 5)
    assert tags(frames) == ["snapshot", "10-2", "snapshot", "11-0*", "12-1*"]
    assert [s.kind for s in statuses] == ["backfilled"]


def test_a_stream_out_of_sockets_ends_instead_of_reconnecting(monkeypatch) -> None:
    only = RecoverySocket([ACCOUNT_SNAPSHOT, live_frame(A)])
    frames, statuses, _ = run_stream(monkeypatch, [only], [], 99)
    assert tags(frames) == ["snapshot", "10-0"]
    assert statuses == []
