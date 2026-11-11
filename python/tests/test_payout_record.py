"""Payout reports preserve the public builder's raw bytes and integer bounds."""

import json
from pathlib import Path

import pytest

from proof_trading_sdk import RecordWithdrawalPayout
from proof_trading_sdk.actions import decode_action, encode_action

_CODEC = Path(__file__).resolve().parents[2] / "conformance" / "codec.ndjson"


def _vector(case: str) -> dict:
    for line in _CODEC.read_text().splitlines():
        entry = json.loads(line)
        if entry.get("case") == case:
            return entry
    raise LookupError(case)


def report(**overrides):
    fields = {
        "withdrawal_id": (1 << 64) - 1,
        "holder": bytes([5]) * 20,
        "vault": bytes(range(32)),
        "squads_transaction_index": (1 << 32) - 1,
        "registry_epoch": (1 << 64) - 1,
    }
    return RecordWithdrawalPayout(**(fields | overrides))


def test_public_builder_matches_shared_u64_bounds_vector():
    # The bytes are pinned once in conformance/codec.ndjson, shared with Rust
    # and TypeScript; a matching encode/decode defect cannot hide here.
    action = report()
    tag, payload = encode_action(action)
    assert tag == 0x31
    assert payload.hex() == _vector("record_withdrawal_payout/u64_bounds")["expect"]["payload_hex"]
    decoded = decode_action(tag, payload)
    assert bytes(decoded["vault"]) == action.vault
    assert decoded["squads_transaction_index"] == action.squads_transaction_index
    assert decoded["registry_epoch"] == action.registry_epoch


@pytest.mark.parametrize("length", [31, 33])
def test_vault_must_be_raw_32_bytes(length):
    with pytest.raises(ValueError, match="32"):
        encode_action(report(vault=bytes(length)))


def test_registry_epoch_cannot_be_null():
    with pytest.raises(ValueError, match=r"registry_epoch|u64|integer"):
        encode_action(report(registry_epoch=None))
