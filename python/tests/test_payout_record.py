"""Payout reports preserve the public builder's raw bytes and integer bounds."""

import pytest

from proof_trading_sdk import RecordWithdrawalPayout
from proof_trading_sdk.actions import decode_action, encode_action


def report(**overrides):
    fields = {
        "withdrawal_id": (1 << 64) - 1,
        "holder": bytes([5]) * 20,
        "solana_signature": bytes(range(64)),
        "last_valid_block_height": (1 << 64) - 1,
    }
    return RecordWithdrawalPayout(**(fields | overrides))


def test_raw_signature_and_exact_u64_bounds():
    action = report()
    tag, payload = encode_action(action)
    assert tag == 0x31
    decoded = decode_action(tag, payload)
    assert decoded["withdrawal_id"] == action.withdrawal_id
    assert bytes(decoded["holder"]) == action.holder
    assert bytes(decoded["solana_signature"]) == action.solana_signature
    assert decoded["last_valid_block_height"] == action.last_valid_block_height


@pytest.mark.parametrize("length", [63, 65])
def test_signature_must_be_raw_64_bytes(length):
    with pytest.raises(ValueError, match="expected 64 raw Solana signature bytes"):
        encode_action(report(solana_signature=bytes(length)))


def test_expiry_cannot_be_null():
    with pytest.raises(ValueError, match="NoneType.*integer"):
        encode_action(report(last_valid_block_height=None))
