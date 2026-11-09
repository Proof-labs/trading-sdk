"""The TypeScript finalized witness/header contract, with Python exact ints."""
from copy import deepcopy
from dataclasses import replace

import pytest

import proof_trading_sdk as sdk

CHAIN = "witness-test-1"
H = 9007199254740993


def witness_wire(height=H - 1):
    return {"version": 1, "nodeId": "ab" * 20, "height": str(height),
            "finalizedBlockTimeMs": "1793008800123", "appHash": "ef" * 32}


def block_wire(height=H):
    return {"jsonrpc": "2.0", "id": 1, "result": {
        "block_id": {"hash": "ab" * 32}, "block": {"header": {
            "height": str(height), "chain_id": CHAIN,
            "last_block_id": {"hash": "cd" * 32}, "app_hash": "ef" * 32,
            "time": "2026-10-26T10:00:00.123456789Z",
        }}}}


def decode(value=None, height=H):
    return sdk.decode_block_evidence_header(block_wire(height) if value is None else value,
                                           height=height, chain_id=CHAIN)


def test_exact_header_and_witness_match_typescript_contract():
    header = decode()
    assert header == sdk.BlockEvidenceHeader("AB" * 32, CHAIN, H, "CD" * 32,
                                              "2026-10-26T10:00:00.123456789Z", "EF" * 32)
    witness = sdk.decode_finalized_read_witness(witness_wire(), expected_height=H - 1,
                                               expected_time_ms=1793008800123)
    assert witness.height == H - 1 and witness.app_hash == "EF" * 32
    assert sdk.verify_witness(witness, header, CHAIN) is None
    assert sdk.verify_witness(witness, replace(header, app_hash="ef" * 32),
                              sdk.chain_id_from_string(CHAIN)) is None
    # H's timestamp must not be compared to H+1's timestamp.
    sdk.verify_witness(replace(witness, finalized_block_time_ms=1), header, CHAIN)


@pytest.mark.parametrize("field,value", [
    ("version", True), ("version", 1.0), ("version", 2),
    ("nodeId", "00" * 20), ("nodeId", "AB" * 20), ("nodeId", "ab" * 19),
    ("appHash", "00" * 32), ("appHash", "zz" * 32), ("appHash", None),
    ("height", 1), ("height", True), ("height", "0"), ("height", "01"),
    ("height", "-1"), ("height", str(1 << 63)), ("height", "1" * 21),
    ("finalizedBlockTimeMs", 1), ("finalizedBlockTimeMs", "0"),
    ("finalizedBlockTimeMs", "1.0"), ("finalizedBlockTimeMs", str(1 << 63)),
])
def test_malformed_witness(field, value):
    with pytest.raises(sdk.GatewayReadError) as raised:
        sdk.decode_finalized_read_witness(witness_wire() | {field: value})
    assert (raised.value.kind, raised.value.field) == ("malformed", "witness")


def test_generic_witness_accepts_additional_fields_and_i64_max():
    wire = witness_wire((1 << 63) - 1) | {"extra": "allowed"}
    wire["finalizedBlockTimeMs"] = str((1 << 63) - 1)
    assert sdk.decode_finalized_read_witness(wire).height == (1 << 63) - 1


@pytest.mark.parametrize("expected", [{"expected_height": 1}, {"expected_time_ms": 1},
                                      {"expected_height": True}])
def test_witness_expected_values_are_binding_faults(expected):
    with pytest.raises(sdk.GatewayReadError) as raised:
        sdk.decode_finalized_read_witness(witness_wire(), **expected)
    assert (raised.value.kind, raised.value.field) == ("binding", "witness")


@pytest.mark.parametrize("pin", [None, "", "x" * 129, bytes(31), bytes(33), 1, "\ud800"])
def test_explicit_pin_configuration(pin):
    with pytest.raises(sdk.GatewayReadError) as raised:
        sdk.verify_witness(sdk.decode_finalized_read_witness(witness_wire()), decode(), pin)
    assert (raised.value.kind, raised.value.field) == ("configuration", "chainId")


@pytest.mark.parametrize("changes", [
    {"height": H - 1}, {"height": H + 1}, {"height": True},
    {"chain_id": "other-chain"}, {"chain_id": ""}, {"chain_id": "x" * 129},
    {"app_hash": None}, {"app_hash": "AB" * 32}, {"app_hash": "bad"},
])
def test_wrong_next_header_is_binding_fault(changes):
    with pytest.raises(sdk.GatewayReadError) as raised:
        sdk.verify_witness(sdk.decode_finalized_read_witness(witness_wire()),
                           replace(decode(), **changes), CHAIN)
    assert (raised.value.kind, raised.value.field) == ("binding", "witness")


def test_witness_at_i64_max_has_no_valid_next_header():
    witness = sdk.decode_finalized_read_witness(witness_wire((1 << 63) - 1))
    with pytest.raises(sdk.GatewayReadError) as raised:
        sdk.verify_witness(witness, replace(decode(), height=1 << 63), CHAIN)
    assert raised.value.kind == "binding"


@pytest.mark.parametrize("field", ["height", "finalized_block_time_ms"])
@pytest.mark.parametrize("value", ["1", True, 1.0, 0])
def test_manually_constructed_witness_cannot_bypass_types(field, value):
    witness = replace(sdk.decode_finalized_read_witness(witness_wire()), **{field: value})
    with pytest.raises(sdk.GatewayReadError) as raised:
        sdk.verify_witness(witness, decode(), CHAIN)
    assert raised.value.kind == "malformed"


def test_genesis_allows_only_empty_parent_and_app_hash_as_none():
    value = block_wire(1)
    value["result"]["block"]["header"].update(last_block_id={"hash": ""}, app_hash="")
    header = decode(value, height=1)
    assert header.parent_hash is None and header.app_hash is None
    value["result"]["block"]["header"]["app_hash"] = None
    with pytest.raises(sdk.GatewayReadError):
        decode(value, height=1)


@pytest.mark.parametrize("timestamp", [
    "1969-12-31T23:59:59Z", "2026-02-30T00:00:00Z", "2026-11-09T24:00:00Z",
    "2026-11-09T00:00:00+00:00", "2026-11-09T00:00:00.1234567890Z",
    "2026-11-09T00:00:00", "0000-01-01T00:00:00Z",
])
def test_block_time_uses_utc_z_valid_post_epoch_calendar(timestamp):
    value = block_wire()
    value["result"]["block"]["header"]["time"] = timestamp
    with pytest.raises(sdk.GatewayReadError) as raised:
        decode(value)
    assert (raised.value.kind, raised.value.field) == ("malformed", "block time")


@pytest.mark.parametrize("height,kind", [(str(H - 1), "binding"), (H, "malformed"),
    (True, "malformed"), (1.0, "malformed"), ("01", "malformed"), (str(1 << 63), "malformed")])
def test_block_height_string_precision_and_number_domain(height, kind):
    value = block_wire()
    value["result"]["block"]["header"]["height"] = height
    with pytest.raises(sdk.GatewayReadError) as raised:
        decode(value)
    assert raised.value.kind == kind


def test_safe_numeric_header_height_is_supported():
    value = block_wire(2)
    value["result"]["block"]["header"]["height"] = 2
    assert decode(value, height=2).height == 2


@pytest.mark.parametrize("mutation", [
    lambda b: b.update(error=None), lambda b: b.update(jsonrpc="1.0"),
    lambda b: b.update(result=[]), lambda b: b["result"].update(block_id={"hash": "bad"}),
    lambda b: b["result"]["block"]["header"].update(last_block_id={"hash": ""}),
    lambda b: b["result"]["block"]["header"].update(app_hash=""),
])
def test_invalid_rpc_and_header_fields(mutation):
    value = deepcopy(block_wire())
    mutation(value)
    with pytest.raises(sdk.GatewayReadError) as raised:
        decode(value)
    assert raised.value.kind == "malformed"


def test_huge_manual_integer_stays_inside_sdk_error_boundary():
    witness = replace(sdk.decode_finalized_read_witness(witness_wire()), height=10**5000)
    with pytest.raises(sdk.GatewayReadError) as raised:
        sdk.verify_witness(witness, decode(), CHAIN)
    assert raised.value.kind == "malformed"
