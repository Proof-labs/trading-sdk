"""The Python streams subscribe on the gateway's multiplexed /ws feed."""

from __future__ import annotations

import json

import pytest
import websockets.sync.client as ws_client

from proof_trading_sdk import AccountEventStream, OrderbookDeltaStream, RecoveryStatus
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


def at(height: int) -> tuple:
    return ev(height, f"T{height}", 0)


def live_frame(e: tuple, keyed: bool = True, tx_index: int | None = 0) -> dict:
    frame = {
        "channel": "accountEvents",
        "type": "account_event",
        "owner": OWNER,
        "eventType": e[3],
        "height": e[0],
        "payload": {"tag": f"{e[0]}-{e[2]}"},
    }
    if keyed:
        frame |= {"txHash": e[1], "txIndex": tx_index, "eventIndex": e[2]}
    return frame


def history_row(e: tuple, event_id: int, tx_position: int | None = None) -> dict:
    row = {
        "event_id": event_id,
        "owner": OWNER,
        "block_height": e[0],
        "tx_hash": e[1],
        "event_index": e[2],
        "event_type": e[3],
        "payload": {"tag": f"{e[0]}-{e[2]}"},
    }
    if tx_position is not None:
        row["tx_position"] = tx_position
    return row


def page(*events: tuple) -> dict:
    """Newest-first history page of ``events`` (given oldest first)."""
    rows = [history_row(e, i + 1) for i, e in enumerate(events)]
    return {"account_events": list(reversed(rows)), "next_cursor": ""}


def page_rows(*rows: dict) -> dict:
    """Newest-first history page of ready-made rows (given oldest first)."""
    return {"account_events": list(reversed(rows)), "next_cursor": ""}


def indexed(height: int) -> dict:
    return {"ingest": {"newest_height": height}}


def snap(height: int | None = None, marker: str | None = None) -> dict:
    frame = {"channel": "accountEvents", "type": "snapshot", "owner": OWNER, "account": {}}
    if marker:
        frame["snapshot"] = marker
    if height is not None:
        frame["height"] = height
    return frame


# The same transaction hash at two heights: only the full key separates them.
A, B, C = ev(10, "AA", 0), ev(10, "AA", 1, "position_updated"), ev(11, "AA", 0)
D, E = ev(12, "DD", 3, "fees_collected"), ev(13, "EE", 0)


def tags(frames: list[dict]) -> list[str]:
    return [
        f["type"]
        if f["type"] in ("snapshot", "error")
        else f["payload"]["tag"] + ("*" if f.get("backfilled") else "")
        for f in frames
    ]


def run_stream(monkeypatch, sockets, reads, count, *, on_stream=None, **kwargs):
    """Iterate a stream over fake sockets. ``reads`` lists the history
    responses in order: ``indexed(...)`` answers a status read, anything else
    an account-events read."""
    queue = list(sockets)

    def connect(url: str, **_: object):
        if not queue:
            raise ConnectionRefusedError("no more fake sockets")
        return queue.pop(0)

    monkeypatch.setattr(ws_client, "connect", connect)
    # Bounded, so a stream that runs out of fake sockets ends instead of
    # reconnecting for ever (``time.sleep`` is stubbed below).
    kwargs.setdefault("reconnect_attempts", 2)
    answers = list(reads)
    made: list[str] = []

    class Resp:
        def __init__(self, body: dict) -> None:
            self.status_code = 400 if "error" in body else 200
            self._body = body

        def json(self) -> dict:
            return self._body

    def get(url: str, params: dict, **_: object) -> Resp:
        path = url.split("gateway.example", 1)[1]
        made.append(path)
        assert answers, f"unexpected read of {path}"
        body = answers.pop(0)
        is_status = "ingest" in body
        assert is_status == (path == "/v1/history/status"), (path, body)
        if path != "/v1/history/status":
            assert params["order"] == "desc" and params["owner"] == OWNER
        return Resp(body)

    import httpx

    monkeypatch.setattr(httpx, "get", get)
    monkeypatch.setattr("time.sleep", lambda _s: None)
    statuses: list = []
    stream = AccountEventStream(
        "wss://gateway.example", OWNER, on_recovery=statuses.append, **kwargs
    )
    # Retry waits return at once.
    stream._stop = type("NoWait", (), {"wait": lambda self, _t: False, "set": lambda self: None})()
    if on_stream:
        on_stream(stream)
    frames = []
    for frame in stream:
        frames.append(frame)
        if len(frames) == count:
            break
    stream.close()
    return frames, statuses, made


def test_reconnect_backfills_the_outage_exactly_once_in_order(monkeypatch) -> None:
    first = RecoverySocket([snap(10, "initial"), live_frame(A), live_frame(B)])
    # C and D happen while disconnected; D and E arrive live during the backfill.
    second = RecoverySocket(
        [snap(12, "initial"), live_frame(at(14))],
        waiting=[live_frame(D), live_frame(E)],
    )
    frames, statuses, _ = run_stream(
        monkeypatch, [first, second], [indexed(12), page(A, B, C, D)], 8
    )
    assert tags(frames) == [
        "snapshot", "10-0", "10-1", "snapshot", "11-0*", "12-3*", "13-0", "14-0",
    ]
    assert statuses == [RecoveryStatus("backfilled", 2)]


def test_reconnect_retries_until_history_indexes_the_snapshot_height(monkeypatch) -> None:
    # No live frame arrives to show the lag: only the snapshot height does.
    first = RecoverySocket([snap(10), live_frame(A)])
    second = RecoverySocket([snap(13)])
    reads = [indexed(10), indexed(13), page(A, C, E)]
    frames, statuses, made = run_stream(monkeypatch, [first, second], reads, 5)
    assert tags(frames) == ["snapshot", "10-0", "snapshot", "11-0*", "13-0*"]
    assert statuses == [RecoveryStatus("backfilled", 2)]
    # History is read once, after it has caught up.
    assert made == ["/v1/history/status"] * 2 + ["/v1/history/account-events"]


def test_reconnect_reports_history_behind_not_backfilled(monkeypatch) -> None:
    first = RecoverySocket([snap(10), live_frame(A)])
    second = RecoverySocket([snap(13)])
    reads = [indexed(10)] * 30 + [page(A)]
    frames, statuses, _ = run_stream(monkeypatch, [first, second], reads, 99)
    assert tags(frames) == ["snapshot", "10-0", "snapshot"]
    assert statuses == [RecoveryStatus("history_behind", 0)]


def test_reconnect_waits_out_an_indexer_lag_of_several_seconds(monkeypatch) -> None:
    first = RecoverySocket([snap(10), live_frame(A)])
    second = RecoverySocket([snap(13)])
    # History catches up 20 one-second waits after the reconnect.
    reads = [indexed(10)] * 21 + [indexed(13), page(A, C, E)]
    frames, statuses, _ = run_stream(monkeypatch, [first, second], reads, 5)
    assert tags(frames) == ["snapshot", "10-0", "snapshot", "11-0*", "13-0*"]
    assert statuses == [RecoveryStatus("backfilled", 2)]


def test_a_gap_longer_than_the_page_budget_reports_failed(monkeypatch) -> None:
    # Nothing is yielded before the outage: the boundary is the snapshot's
    # height, and 11 full pages of newer rows lie above it.
    first = RecoverySocket([snap(10)])
    second = RecoverySocket([snap(5511)])
    pages = []
    for p in range(10):
        top = 5511 - p * 500
        pages.append(
            {**page(*(at(top - 499 + i) for i in range(500))), "next_cursor": f"c{p + 1}"}
        )
    frames, statuses, _ = run_stream(
        monkeypatch, [first, second], [indexed(5511), *pages], 99
    )
    assert tags(frames) == ["snapshot", "snapshot"]
    assert [s.kind for s in statuses] == ["failed"]


def test_reconnect_without_snapshot_height_reports_unverified(monkeypatch) -> None:
    first = RecoverySocket([snap(), live_frame(A)])
    second = RecoverySocket([snap()])
    frames, statuses, made = run_stream(monkeypatch, [first, second], [page(A, C)], 4)
    assert tags(frames) == ["snapshot", "10-0", "snapshot", "11-0*"]
    assert statuses == [RecoveryStatus("unverified", 1)]
    assert made == ["/v1/history/account-events"]


def test_reconnect_with_nothing_yielded_backfills_from_the_snapshot_height(monkeypatch) -> None:
    first = RecoverySocket([snap(10)])
    second = RecoverySocket([snap(12)])
    reads = [indexed(12), page(A, C, D)]
    frames, statuses, _ = run_stream(monkeypatch, [first, second], reads, 4)
    assert tags(frames) == ["snapshot", "snapshot", "11-0*", "12-3*"]
    assert statuses == [RecoveryStatus("backfilled", 2)]


def test_reconnect_reports_once_even_without_a_boundary(monkeypatch) -> None:
    first = RecoverySocket([snap()])
    second = RecoverySocket([snap()])
    frames, statuses, made = run_stream(monkeypatch, [first, second], [], 99)
    assert tags(frames) == ["snapshot", "snapshot"]
    assert statuses == [RecoveryStatus("unverified", 0)]
    assert made == []


def test_a_resent_snapshot_is_not_a_reconnect(monkeypatch) -> None:
    only = RecoverySocket([snap(10, "initial"), live_frame(A), snap(10, "resent"), live_frame(C)])
    frames, statuses, made = run_stream(monkeypatch, [only], [], 99)
    assert tags(frames) == ["snapshot", "10-0", "snapshot", "11-0"]
    assert statuses == [] and made == []


def test_a_live_frame_already_backfilled_is_dropped_after_the_backfill(monkeypatch) -> None:
    first = RecoverySocket([snap(10), live_frame(A)])
    # A slow socket delivers D after the indexer already served it.
    second = RecoverySocket([snap(12), live_frame(D), live_frame(E), live_frame(D)])
    reads = [indexed(12), page(A, C, D)]
    frames, statuses, _ = run_stream(monkeypatch, [first, second], reads, 99)
    assert tags(frames) == ["snapshot", "10-0", "snapshot", "11-0*", "12-3*", "13-0", "12-3"]


def test_history_rows_without_position_match_live_frames_with_one(monkeypatch) -> None:
    # A normal block: history omits tx_position, the live frame carries 0.
    first = RecoverySocket([snap(10), live_frame(A)])
    second = RecoverySocket([snap(12)], waiting=[live_frame(D)])
    reads = [indexed(12), page(A, C, D)]
    frames, statuses, _ = run_stream(monkeypatch, [first, second], reads, 99)
    # The unpositioned boundary row A still stops the scan, and the live D is
    # dropped against its unpositioned row.
    assert tags(frames) == ["snapshot", "10-0", "snapshot", "11-0*", "12-3*"]
    assert statuses == [RecoveryStatus("backfilled", 2)]


def test_two_copies_of_one_hash_in_a_block_are_separated_by_position(monkeypatch) -> None:
    # The gateway serves tx_position only when a block repeats the hash.
    f, g = ev(12, "FF", 0), ev(12, "FF", 1, "position_updated")
    first = RecoverySocket([snap(10), live_frame(A)])
    second = RecoverySocket(
        [snap(12)], waiting=[live_frame(f, tx_index=0), live_frame(g, tx_index=1)]
    )
    reads = [
        indexed(12),
        page_rows(history_row(A, 1), history_row(f, 2, 0), history_row(g, 3, 1)),
    ]
    frames, statuses, _ = run_stream(monkeypatch, [first, second], reads, 99)
    # Each live copy matches its own row: no double delivery, no skip.
    assert tags(frames) == ["snapshot", "10-0", "snapshot", "12-0*", "12-1*"]
    assert statuses == [RecoveryStatus("backfilled", 2)]


def test_a_late_live_duplicate_of_a_positionless_backfilled_row_is_dropped(monkeypatch) -> None:
    first = RecoverySocket([snap(10), live_frame(A)])
    second = RecoverySocket([snap(12), live_frame(D), live_frame(E)])
    reads = [indexed(12), page(A, C, D)]
    frames, statuses, _ = run_stream(monkeypatch, [first, second], reads, 99)
    assert tags(frames) == ["snapshot", "10-0", "snapshot", "11-0*", "12-3*", "13-0"]


def test_boundary_not_found_when_history_no_longer_holds_the_boundary(monkeypatch) -> None:
    first = RecoverySocket([snap(10), live_frame(A)])
    second = RecoverySocket([snap(13)])
    # History was pruned past the boundary: every row is newer than A.
    reads = [indexed(13), page(E, at(14))]
    frames, statuses, _ = run_stream(monkeypatch, [first, second], reads, 99)
    assert tags(frames) == ["snapshot", "10-0", "snapshot", "13-0*", "14-0*"]
    assert statuses == [RecoveryStatus("boundary_not_found", 2)]


def test_close_stops_a_backfill_waiting_to_retry(monkeypatch) -> None:
    first = RecoverySocket([snap(10), live_frame(A)])
    second = RecoverySocket([snap(13)])
    reads = [indexed(10)]

    def closing_wait(stream):
        class Stop:
            def wait(self, _t):
                stream.close()
                return True

            def set(self):
                pass

        stream._stop = Stop()

    frames, statuses, made = run_stream(
        monkeypatch, [first, second], reads, 99, on_stream=closing_wait
    )
    assert tags(frames) == ["snapshot", "10-0", "snapshot"]
    assert statuses == []
    assert len(made) == 1


def test_close_sets_the_wait_event(monkeypatch) -> None:
    stream = AccountEventStream("wss://gateway.example", OWNER)
    stream.close()
    assert stream._stop.is_set()


def test_reconnect_without_history_key_reports_unsupported(monkeypatch) -> None:
    first = RecoverySocket([snap(10), live_frame(A, keyed=False)])
    second = RecoverySocket([snap(13), live_frame(E, keyed=False)])
    frames, statuses, made = run_stream(monkeypatch, [first, second], [], 4)
    assert tags(frames) == ["snapshot", "10-0", "snapshot", "13-0"]
    assert statuses == [RecoveryStatus("unsupported")]
    assert made == []


def test_reconnect_reports_a_failed_history_read(monkeypatch) -> None:
    first = RecoverySocket([snap(10), live_frame(A)])
    second = RecoverySocket([snap(13)], waiting=[live_frame(E)])
    reads = [indexed(13), {"error": "order_required"}]
    frames, statuses, _ = run_stream(monkeypatch, [first, second], reads, 4)
    assert tags(frames) == ["snapshot", "10-0", "snapshot", "13-0"]
    assert [s.kind for s in statuses] == ["failed"]


def test_reconnect_matches_a_legacy_settlement_name_to_history(monkeypatch) -> None:
    met = ev(10, "AA", 2, "conditional_settled")
    not_met = ev(12, "DD", 1, "conditional_voided")
    first = RecoverySocket([snap(10), live_frame(met)])
    second = RecoverySocket([snap(12)], waiting=[live_frame(not_met)])
    reads = [
        indexed(12),
        page((*met[:3], "condition_met"), C, (*not_met[:3], "condition_not_met")),
    ]
    frames, statuses, _ = run_stream(monkeypatch, [first, second], reads, 5)
    assert tags(frames) == ["snapshot", "10-2", "snapshot", "11-0*", "12-1*"]
    assert statuses == [RecoveryStatus("backfilled", 2)]


def test_a_stream_out_of_sockets_ends_instead_of_reconnecting(monkeypatch) -> None:
    only = RecoverySocket([snap(10), live_frame(A)])
    frames, statuses, _ = run_stream(monkeypatch, [only], [], 99)
    assert tags(frames) == ["snapshot", "10-0"]
    assert statuses == []


def test_client_stream_reads_history_from_the_gateway_url() -> None:
    client = ExchangeClient(gateway_url="https://gateway.example", chain_id=b"\x00" * 32)
    stream = client.account_event_stream(OWNER, ws_url="wss://ws.gateway.example:9091")
    assert stream._history_url == "https://gateway.example"
    assert stream._ws_url == "wss://ws.gateway.example:9091"
