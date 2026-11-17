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
        "solana_signature": bytes(range(64)),
        "last_valid_block_height": (1 << 64) - 1,
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
    assert bytes(decoded["solana_signature"]) == action.solana_signature
    assert decoded["last_valid_block_height"] == action.last_valid_block_height


@pytest.mark.parametrize("length", [63, 65])
def test_signature_must_be_raw_64_bytes(length):
    with pytest.raises(ValueError, match="expected 64 raw Solana signature bytes"):
        encode_action(report(solana_signature=bytes(length)))


def test_expiry_cannot_be_null():
    with pytest.raises(ValueError, match=r"last_valid_block_height|u64|integer"):
        encode_action(report(last_valid_block_height=None))


def test_expiry_cannot_be_zero():
    # The wire field is NonZeroU64: an expiry of 0 would make the transfer look
    # expired at once to peer watchers.
    with pytest.raises(ValueError, match="nonzero"):
        encode_action(report(last_valid_block_height=0))
