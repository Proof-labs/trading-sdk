"""Trusted-gateway evidence binds exact bytes and complete bounded responses."""
import base64
from array import array
from copy import deepcopy
import hashlib
import json
from pathlib import Path

import httpx
import pytest

import proof_trading_sdk as sdk
from proof_trading_sdk import chain_evidence as ce

CHAIN = "evidence-test-chain"
TX = b"previously prepared exact envelope"
TX_HASH = hashlib.sha256(TX).hexdigest().upper()
BASE_MS = 1_704_067_200_000  # 2024-01-01T00:00:00Z
EVENT = {"type": "raw_event", "attributes": [{"key": "opaque", "value": "9007199254740993", "index": False}, {}]}


def b64(value):
    return base64.b64encode(value).decode()


def h(value):
    return f"{value:064X}"


def rpc(value):
    return {"jsonrpc": "2.0", "id": 1, "result": value}


def block(height, txs=None):
    transactions = [TX] if txs is None else txs
    # Synthetic blocks contain at most one tx. Public Comet vectors below
    # independently pin the nontrivial tree with 0/1/3/5 leaves.
    data_hash = hashlib.sha256(b"\x00" + hashlib.sha256(transactions[0]).digest()).hexdigest().upper() if transactions else hashlib.sha256(b"").hexdigest().upper()
    return rpc({"block_id": {"hash": h(height)}, "block": {
        "header": {"height": str(height), "chain_id": CHAIN,
                   "last_block_id": {"hash": h(height - 1) if height != 1 else ""},
                   "time": f"2024-01-01T00:00:{height % 60:02d}.000000001Z",
                   "app_hash": h(1000 + height - 1) if height != 1 else "", "data_hash": data_hash},
        "data": {"txs": [b64(tx) for tx in transactions]},
    }})


def results(height, txs=None):
    transactions = [TX] if txs is None else txs
    return rpc({"height": str(height), "txs_results": [{"events": [EVENT]} for _ in transactions],
                "finalize_block_events": [EVENT], "app_hash": b64(bytes.fromhex(h(1000 + height)))})


def transaction():
    return rpc({"hash": TX_HASH, "height": "10", "index": 0, "tx": b64(TX), "tx_result": {"events": [EVENT]}})


@pytest.fixture
def client():
    c = sdk.ExchangeClient(config=sdk.SdkConfig(gateway_url="https://gateway.example", api_key="test-key"))
    c._http.close()
    yield c
    c.close()


def mock(client, responses=None, modify=None):
    seen = []

    def handler(request):
        seen.append(request)
        if responses is not None:
            value = deepcopy(responses[len(seen) - 1])
        elif request.url.path.startswith("/v1/tx/"):
            value = transaction()
        else:
            height = int(request.url.params["height"])
            value = results(height) if request.url.path == "/v1/block_results" else block(height)
        if modify:
            modify(value, request)
        return httpx.Response(200, json=value)

    client._http = httpx.Client(transport=httpx.MockTransport(handler), headers=client._default_headers())
    return seen


def read_tx(client, **kwargs):
    return client.transaction_evidence(TX_HASH.lower(), TX, chain_id=CHAIN, **kwargs)


def read_range(client, **kwargs):
    return client.block_results_range(9, 10, chain_id=CHAIN, **kwargs)


def read_window(client, **kwargs):
    return client.block_results_window(BASE_MS + 9000, BASE_MS + 10_000, 10, chain_id=CHAIN, **kwargs)


def test_transaction_exact_route_bytes_and_documented_zero_defaults(client):
    seen = mock(client)
    result = read_tx(client)
    assert result.source == "trusted-gateway" and result.hash == TX_HASH
    assert result.signed_bytes == TX and result.height == 10 and result.index == 0
    assert result.code == 0
    assert result.events[0].attributes == EVENT["attributes"]
    assert result.block.height == 10
    assert [str(r.url) for r in seen] == [f"https://gateway.example/v1/tx/{TX_HASH}", "https://gateway.example/v1/block?height=10"]
    assert all(r.headers["X-API-Key"] == "test-key" for r in seen)


def test_missing_protobuf_events_and_optional_attributes_are_preserved(client):
    tx = transaction()
    tx["result"]["tx_result"] = {}
    mock(client, [tx, block(10)])
    assert read_tx(client).events == []
    tx["result"]["tx_result"]["events"] = [{"type": "a"}, {"type": "b", "attributes": []}]
    mock(client, [tx, block(10)])
    assert [e.attributes for e in read_tx(client).events] == [None, []]


@pytest.mark.parametrize("field,value", [
    ("hash", "0" * 64), ("height", "0"), ("height", True), ("height", "01"),
    ("height", 1 << 53), ("index", -1), ("index", 1), ("index", 0.0),
    ("tx", b64(TX + b"x")), ("tx", b64(TX).rstrip("=")), ("tx_result", None),
])
def test_bad_transaction_response_refused(client, field, value):
    tx = transaction(); tx["result"][field] = value
    mock(client, [tx, block(10)])
    with pytest.raises(sdk.GatewayReadError):
        read_tx(client)


@pytest.mark.parametrize("value", [True, -1, 1 << 32, 1.0, None, "00"])
def test_invalid_execution_code_is_not_inferred_success(client, value):
    tx = transaction(); tx["result"]["tx_result"]["code"] = value
    mock(client, [tx, block(10)])
    with pytest.raises(sdk.GatewayReadError):
        read_tx(client)


@pytest.mark.parametrize("change", [
    lambda b: b["result"]["block"]["header"].update(chain_id="other"),
    lambda b: b["result"]["block"]["header"].update(height="11"),
    lambda b: b["result"]["block"]["header"].update(data_hash="0" * 64),
    lambda b: b["result"]["block"]["data"].update(txs=[b64(TX + b"x")]),
    lambda b: b["result"]["block"]["data"].update(txs=None),
    lambda b: b.update(error=None),
])
def test_transaction_block_binding_failure(client, change):
    b = block(10); change(b)
    mock(client, [transaction(), b])
    with pytest.raises(sdk.GatewayReadError):
        read_tx(client)


@pytest.mark.parametrize("tx_hash,tx", [("bad", TX), (TX_HASH, b"other"), (TX_HASH, b""), (TX_HASH, bytes(1024 * 1024 + 1)), (TX_HASH, "text")])
def test_invalid_selection_never_uses_transport(client, tx_hash, tx):
    seen = mock(client)
    with pytest.raises(sdk.GatewayReadError):
        client.transaction_evidence(tx_hash, tx, chain_id=CHAIN)
    assert seen == []


def test_caller_mutable_transaction_is_snapshotted_before_io(client):
    payload = bytearray(TX)
    mock(client, modify=lambda *_: payload.clear())
    assert client.transaction_evidence(TX_HASH, payload, chain_id=CHAIN).signed_bytes == TX


def test_memoryview_bound_counts_bytes_before_copy_or_request(client):
    payload = memoryview(array("I", [0] * (262144 + 1)))
    assert len(payload) < 1024 * 1024 < payload.nbytes
    seen = mock(client)
    with pytest.raises(sdk.GatewayReadError, match="signed bytes"):
        client.transaction_evidence(TX_HASH, payload, chain_id=CHAIN)
    assert seen == []


def test_range_is_complete_ordered_and_retains_rejections_system_events(client):
    def modify(value, request):
        if request.url.path == "/v1/block_results":
            value["result"]["txs_results"][0]["code"] = 21
    seen = mock(client, modify=modify)
    result = read_range(client)
    assert result.from_height == 9 and result.through_height == 10 and result.anchor.height == 11
    assert [b.header.height for b in result.blocks] == [9, 10]
    assert [b.transactions[0].code for b in result.blocks] == [21, 21]
    assert result.blocks[0].finalize_block_events[0].attributes == EVENT["attributes"]
    assert [r.url.path for r in seen] == ["/v1/block", "/v1/block", "/v1/block_results", "/v1/block", "/v1/block_results"]
    assert [r.url.params["height"] for r in seen] == ["11", "10", "10", "9", "9"]


def test_window_keeps_lower_and_end_boundaries_and_nanoseconds(client):
    seen = mock(client)
    result = read_window(client)
    # height9 is one ns AFTER from; height8 is the retained lower boundary.
    assert isinstance(result, sdk.BlockResultsWindow)
    assert [b.header.height for b in result.blocks] == [8, 9, 10]
    assert result.from_ms == BASE_MS + 9000 and result.to_ms == BASE_MS + 10_000
    assert result.blocks[1].header.time.endswith(".000000001Z")
    assert len(seen) == 7


def test_genesis_and_null_empty_slices(client):
    b, anchor, r = block(1, []), block(2, []), results(1, [])
    b["result"]["block"]["data"]["txs"] = None
    r["result"].update(txs_results=None, finalize_block_events=None)
    mock(client, [anchor, b, r])
    out = client.block_results_window(0, BASE_MS + 1000, 1, chain_id=CHAIN)
    assert out.from_height == 1
    assert out.blocks[0].header.parent_hash is out.blocks[0].header.app_hash is None
    assert out.blocks[0].transactions == out.blocks[0].finalize_block_events == []


@pytest.mark.parametrize("field", ["txs_results", "finalize_block_events", "app_hash", "height"])
def test_missing_result_fields_are_not_empty_success(client, field):
    def modify(value, request):
        if request.url.path == "/v1/block_results":
            del value["result"][field]
    mock(client, modify=modify)
    with pytest.raises(sdk.GatewayReadError):
        read_range(client)


@pytest.mark.parametrize("field,value", [("height", "9"), ("txs_results", []), ("txs_results", {}), ("app_hash", b64(bytes(32))), ("app_hash", b64(bytes(31))), ("finalize_block_events", {})])
def test_result_binding_and_shape_failures(client, field, value):
    def modify(body, request):
        if request.url.path == "/v1/block_results":
            body["result"][field] = value
    mock(client, modify=modify)
    with pytest.raises(sdk.GatewayReadError):
        read_range(client)


def test_parent_and_submicrosecond_time_discontinuity_refused(client):
    anchor = block(11)
    anchor["result"]["block"]["header"]["last_block_id"]["hash"] = h(999)
    mock(client, [anchor, block(10)])
    with pytest.raises(sdk.GatewayReadError, match="parent"):
        read_range(client)
    anchor = block(11)
    anchor["result"]["block"]["header"]["time"] = "2024-01-01T00:00:10.000000000Z"
    mock(client, [anchor, block(10)])
    with pytest.raises(sdk.GatewayReadError, match="time"):
        read_range(client)


def test_equal_block_times_are_allowed(client):
    mock(client, modify=lambda body, request: body["result"]["block"]["header"].update(time="2024-01-01T00:00:10.000000001Z") if request.url.path == "/v1/block" else None)
    assert len(read_range(client).blocks) == 2


def test_source_must_reach_window_end(client):
    seen = mock(client)
    with pytest.raises(sdk.GatewayReadError, match="window end"):
        client.block_results_window(BASE_MS, BASE_MS + 11_000, 10, chain_id=CHAIN)
    assert len(seen) == 2


@pytest.mark.parametrize("kwargs", [
    {"max_heights": 1}, {"max_decoded_bytes": 1}, {"max_transactions": 1},
    {"max_events": 3}, {"max_attributes": 7},
])
def test_exhausted_aggregate_budgets_never_return_partial_range(client, kwargs):
    mock(client)
    with pytest.raises(sdk.GatewayReadError) as err:
        read_range(client, **kwargs)
    assert err.value.kind == "limit"


def test_window_height_exhaustion_fails_without_partial_success(client):
    seen = mock(client)
    with pytest.raises(sdk.GatewayReadError) as err:
        read_window(client, max_heights=2)
    assert err.value.kind == "limit" and len(seen) == 5


@pytest.mark.parametrize("kwargs", [
    {"max_heights": 0}, {"max_heights": 129}, {"max_heights": True},
    {"max_decoded_bytes": 8 * 1024 * 1024 + 1}, {"max_transactions": 10_001},
    {"max_events": 16_385}, {"max_attributes": 65_537}, {"timeout": 0},
])
def test_invalid_limits_refused_before_transport(client, kwargs):
    seen = mock(client)
    with pytest.raises(sdk.GatewayReadError) as err:
        read_range(client, **kwargs)
    assert err.value.kind == "configuration" and seen == []


@pytest.mark.parametrize("bounds", [(0, 1), (2, 1), (True, 2), (1, 1 << 63), (1, (1 << 63) - 1), ("1", 2)])
def test_invalid_range_heights_before_transport(client, bounds):
    seen = mock(client)
    with pytest.raises(sdk.GatewayReadError):
        client.block_results_range(*bounds, chain_id=CHAIN)
    assert seen == []


@pytest.mark.parametrize("bounds", [(-1, 1), (1, 1), (2, 1), (True, 2), (0, 8_640_000_000_000_001), (0, 1.0)])
def test_invalid_window_before_transport(client, bounds):
    seen = mock(client)
    with pytest.raises(sdk.GatewayReadError):
        client.block_results_window(*bounds, 10, chain_id=CHAIN)
    assert seen == []


@pytest.mark.parametrize("read", [read_tx, read_range, read_window])
def test_shared_deadline_covers_all_requests(client, monkeypatch, read):
    clock = [0.0]
    monkeypatch.setattr(ce.time, "monotonic", lambda: clock[0])
    seen = mock(client, modify=lambda *_: clock.__setitem__(0, clock[0] + 0.3))
    with pytest.raises(sdk.GatewayReadError) as err:
        read(client, timeout=0.5)
    assert err.value.kind == "deadline" and len(seen) == 2
    assert seen[0].extensions["timeout"]["read"] == pytest.approx(0.5)
    assert seen[1].extensions["timeout"]["read"] == pytest.approx(0.2)


@pytest.mark.parametrize("events", [None, {}, [{"type": ""}], [{"type": "x", "attributes": None}], [{"type": "x", "attributes": [{"index": 0}]}]])
def test_malformed_events_not_interpreted_as_receipts(client, events):
    tx = transaction(); tx["result"]["tx_result"]["events"] = events
    mock(client, [tx, block(10)])
    with pytest.raises(sdk.GatewayReadError):
        read_tx(client)


def test_single_transaction_event_budget(client):
    tx = transaction(); tx["result"]["tx_result"]["events"] = [{"type": "x"}] * 4097
    mock(client, [tx, block(10)])
    with pytest.raises(sdk.GatewayReadError) as err:
        read_tx(client)
    assert err.value.kind == "limit"


COMET = json.loads((Path(__file__).resolve().parents[2] / "conformance/comet-transaction-roots.json").read_text())


@pytest.mark.parametrize("vector", COMET, ids=lambda v: f"real-devnet-{len(v['txs'])}-txs")
def test_merkle_root_matches_existing_ts_real_comet_vectors(vector):
    assert ce._transactions_root([base64.b64decode(tx) for tx in vector["txs"]]) == vector["dataHash"]


def test_merkle_root_is_order_sensitive():
    txs = [base64.b64decode(tx) for tx in COMET[2]["txs"]]
    assert ce._transactions_root(list(reversed(txs))) != COMET[2]["dataHash"]


@pytest.mark.parametrize("raw,js_bytes", [
    ("1e20", 30), ("1e-6", 17), ("1.0000000000000002e-6", 33),
    ("999999999999999999", 28), ("-999999999999999999", 29), ("1e309", 13),
])
def test_decoded_byte_budget_conservatively_covers_js_number_format(raw, js_bytes):
    # Expected lengths independently obtained with Node JSON.stringify({meta:...}).
    assert ce._decoded_size({"meta": json.loads(raw)}) >= js_bytes


def test_decoded_byte_budget_includes_nested_float_expansion(client):
    responses = [block(11), block(10), results(10)]
    responses[0]["metadata"] = {"nested": [1e20]}
    naive = sum(len(json.dumps(v, ensure_ascii=False, separators=(",", ":")).encode()) for v in responses)
    mock(client, responses)
    with pytest.raises(sdk.GatewayReadError) as err:
        client.block_results_range(10, 10, chain_id=CHAIN, max_decoded_bytes=naive)
    assert err.value.kind == "limit"


@pytest.mark.parametrize("tamper", [False, True])
def test_range_pairs_independent_comet_vector_in_order(client, tamper):
    vectors = json.loads((Path(__file__).resolve().parents[2] / "conformance/comet-transaction-roots.json").read_text())
    vector = next(v for v in vectors if len(v["txs"]) == 3)
    txs = [base64.b64decode(v) for v in vector["txs"]]
    b = block(10)
    b["result"]["block"]["data"]["txs"] = vector["txs"]
    b["result"]["block"]["header"]["data_hash"] = "0" * 64 if tamper else vector["dataHash"]
    r = results(10, txs)
    for entry, code in zip(r["result"]["txs_results"], [0, 21, 7]): entry["code"] = code
    mock(client, [block(11), b, r, block(9), results(9)])
    if tamper:
        with pytest.raises(sdk.GatewayReadError) as err: read_range(client)
        assert (err.value.kind, err.value.field) == ("binding", "block transactions root")
    else:
        transactions = read_range(client).blocks[-1].transactions
        assert [t.code for t in transactions] == [0, 21, 7]
        assert [t.hash for t in transactions] == [hashlib.sha256(tx).hexdigest().upper() for tx in txs]

@pytest.mark.parametrize("tx_hash,tx,kind,field", [
    ("bad", TX, "configuration", "requested hash"),
    (TX_HASH, b"other", "configuration", "requested hash/bytes mismatch"),
    (TX_HASH, b"", "configuration", "signed bytes"),
    (TX_HASH, bytes(ce._MAX_SIGNED_TX_BYTES + 1), "limit", "signed bytes"),
    (TX_HASH, "text", "configuration", "signed bytes"),
])
def test_selection_error_contract_before_io(client, tx_hash, tx, kind, field):
    seen = mock(client)
    with pytest.raises(sdk.GatewayReadError) as err:
        client.transaction_evidence(tx_hash, tx, chain_id=CHAIN)
    assert (err.value.kind, err.value.field) == (kind, field)
    assert not seen

@pytest.mark.parametrize("field,mutate", [
    ("parent hash continuity", lambda b: b["result"]["block"]["header"].update(last_block_id={"hash": "F"*64})),
    ("post-state/header binding", lambda b: b["result"]["block"]["header"].update(app_hash="F"*64)),
])
def test_range_binding_error_contract(client, field, mutate):
    anchor = block(11); mutate(anchor)
    mock(client, [anchor, block(10), results(10)])
    with pytest.raises(sdk.GatewayReadError) as err: read_range(client)
    assert (err.value.kind, err.value.field) == ("binding", field)

@pytest.mark.parametrize("start,end,field", [(0,10,"from height"),(9,0,"through height")])
def test_range_configuration_contract(client, start, end, field):
    seen = mock(client)
    with pytest.raises(sdk.GatewayReadError) as err:
        client.block_results_range(start, end, chain_id=CHAIN)
    assert (err.value.kind, err.value.field) == ("configuration", field)
    assert not seen
