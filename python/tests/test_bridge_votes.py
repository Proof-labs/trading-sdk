"""The bridge-operator message builders: preimage layout, signing, and removals.

The preimage (`PROOF_BRIDGE_VOTE_V1 || kind || …`) is pinned here field for
field: the engine re-derives exactly these bytes before verifying each
operator's signature, so a drift is a refused vote, not a decode
inconvenience. The payload encodes ride the shared conformance vectors (see
`test_typed_actions.py`).
"""

from __future__ import annotations

import dataclasses
import json
import os
from pathlib import Path

import pytest
from proof_trading_sdk import (
    BRIDGE_VOTE_DOMAIN,
    BRIDGE_VOTE_KIND_DEPOSIT_CREDIT,
    BRIDGE_VOTE_KIND_PAUSE,
    BRIDGE_VOTE_KIND_PAYOUT_DEAD,
    BRIDGE_VOTE_KIND_PAYOUT_RECORD,
    BRIDGE_VOTE_KIND_WITHDRAWAL_PAID,
    ExternalSigner,
    RecordWithdrawalPayout,
    VoteDeposit,
    VotePauseBridge,
    VoteWithdrawalPaid,
    VoteWithdrawalPayoutDead,
    actions,
)
from proof_trading_sdk.actions import (
    bridge_message_preimage,
    record_withdrawal_payout_message,
    vote_deposit_message,
    vote_pause_bridge_message,
    vote_withdrawal_paid_message,
    vote_withdrawal_payout_dead_message,
)

DEPLOYMENT = b"\xa1" * 32
CHAIN = b"\xc7" * 32
VAULT = b"\xb2" * 32


class _Key:
    """A stand-in external signer that records what it was asked to sign."""

    def __init__(self, seed: bytes, length: int = 64) -> None:
        self.seed = seed
        self.length = length
        self.signed: list[bytes] = []

    def signer(self) -> ExternalSigner:
        def sign_raw(message: bytes) -> bytes:
            self.signed.append(message)
            return bytes([self.seed[0]]) * self.length

        return ExternalSigner(public_key=bytes(32), sign_raw=sign_raw)


def test_withdrawal_vote_preimage_is_the_documented_layout():
    message = vote_withdrawal_paid_message(777, VAULT, 11, DEPLOYMENT, CHAIN, 3)
    assert message == (
        b"PROOF_BRIDGE_VOTE_V1"
        + bytes([BRIDGE_VOTE_KIND_WITHDRAWAL_PAID])
        + (777).to_bytes(8, "big")
        + VAULT
        + (11).to_bytes(4, "big")
        + DEPLOYMENT
        + CHAIN
        + (3).to_bytes(8, "big")
    )


def test_deposit_vote_preimage_carries_the_locator_suffix():
    locator = actions.DepositLocator(top_index=2, inner_index=5)
    message = vote_deposit_message(
        b"\x11" * 20, 1_000_000, b"\x22" * 64, locator, DEPLOYMENT, CHAIN, 9
    )
    assert message == (
        BRIDGE_VOTE_DOMAIN
        + bytes([BRIDGE_VOTE_KIND_DEPOSIT_CREDIT])
        + b"\x11" * 20
        + (1_000_000).to_bytes(8, "big")
        + b"\x22" * 64
        + (2).to_bytes(2, "big")
        + (5).to_bytes(2, "big")
        + DEPLOYMENT
        + CHAIN
        + (9).to_bytes(8, "big")
    )


def test_an_absent_locator_signs_the_legacy_suffix():
    absent = vote_deposit_message(
        b"\x11" * 20, 5, b"\x22" * 64, None, DEPLOYMENT, CHAIN, 1
    )
    legacy = vote_deposit_message(
        b"\x11" * 20,
        5,
        b"\x22" * 64,
        actions.DepositLocator(top_index=0, inner_index=None),
        DEPLOYMENT,
        CHAIN,
        1,
    )
    # None and the LEGACY locator are the same reading: identical bytes.
    assert absent == legacy
    at = len(BRIDGE_VOTE_DOMAIN) + 1 + 20 + 8 + 64
    assert absent[at : at + 4] == b"\x00\x00\xff\xff"


def test_sign_fills_the_payload_signature():
    key = _Key(b"\x42")
    vote = VoteWithdrawalPaid.sign(key.signer(), 777, VAULT, 11, DEPLOYMENT, CHAIN, 3)
    assert vote.signature == b"\x42" * 64
    # The signature is over exactly the canonical preimage of the same fields.
    assert key.signed == [vote_withdrawal_paid_message(777, VAULT, 11, DEPLOYMENT, CHAIN, 3)]
    assert dataclasses.asdict(vote) == {
        "withdrawal_id": 777,
        "vault": VAULT,
        "squads_transaction_index": 11,
        "deployment_id": DEPLOYMENT,
        "chain_id": CHAIN,
        "registry_epoch": 3,
        "signature": b"\x42" * 64,
    }

    deposit = VoteDeposit.sign(
        key.signer(), b"\x11" * 20, 1_000_000, b"\x22" * 64, None, DEPLOYMENT, CHAIN, 9
    )
    assert key.signed[-1] == vote_deposit_message(
        b"\x11" * 20, 1_000_000, b"\x22" * 64, None, DEPLOYMENT, CHAIN, 9
    )
    assert deposit.locator is None


def test_payout_dead_vote_uses_its_distinct_canonical_kind():
    key = _Key(b"\x51")
    msg = vote_withdrawal_payout_dead_message(8, VAULT, 13, DEPLOYMENT, CHAIN, 4)
    assert msg == (
        BRIDGE_VOTE_DOMAIN + bytes([BRIDGE_VOTE_KIND_PAYOUT_DEAD])
        + (8).to_bytes(8, "big") + VAULT + (13).to_bytes(4, "big")
        + DEPLOYMENT + CHAIN + (4).to_bytes(8, "big")
    )
    vote = VoteWithdrawalPayoutDead.sign(key.signer(), 8, VAULT, 13, DEPLOYMENT, CHAIN, 4)
    assert vote.signature == b"\x51" * 64
    assert key.signed == [msg]


def test_the_record_and_pause_messages_carry_their_kinds():
    key = _Key(b"\x5d")
    record = RecordWithdrawalPayout.sign(key.signer(), 8, VAULT, 13, DEPLOYMENT, CHAIN, 4)
    assert key.signed[-1] == record_withdrawal_payout_message(
        8, VAULT, 13, DEPLOYMENT, CHAIN, 4
    )
    assert key.signed[-1][len(BRIDGE_VOTE_DOMAIN)] == BRIDGE_VOTE_KIND_PAYOUT_RECORD
    assert record.signature == b"\x5d" * 64

    pause = VotePauseBridge.sign(key.signer(), 1_700_000_000_123, DEPLOYMENT, CHAIN, 2)
    assert key.signed[-1] == (
        BRIDGE_VOTE_DOMAIN
        + bytes([BRIDGE_VOTE_KIND_PAUSE])
        + (1_700_000_000_123).to_bytes(8, "big")
        + DEPLOYMENT
        + CHAIN
        + (2).to_bytes(8, "big")
    )
    assert pause.signature == b"\x5d" * 64


def test_a_key_handle_signs_the_message_in_rust():
    from proof_trading_sdk import _native

    read_fd, write_fd = os.pipe()
    os.write(write_fd, b"\x07" * 32)
    os.close(write_fd)
    try:
        handle = _native.load_key_from_fd(read_fd)
    finally:
        os.close(read_fd)
    vote = VotePauseBridge.sign(handle, 5, DEPLOYMENT, CHAIN, 2)
    assert _native.verify_raw_signature(
        handle.public_key,
        vote.signature,
        vote_pause_bridge_message(5, DEPLOYMENT, CHAIN, 2),
    )
    # The handle signs only bridge messages it built, never arbitrary bytes.
    assert not hasattr(handle, "sign_raw")
    assert not hasattr(handle, "sign")


@pytest.mark.parametrize("length", [63, 65])
def test_an_external_signer_must_return_64_bytes(length):
    with pytest.raises(ValueError, match="64 signature bytes"):
        VotePauseBridge.sign(_Key(b"\x01", length).signer(), 5, DEPLOYMENT, CHAIN, 2)


@pytest.mark.parametrize(
    "field, value",
    [("vault", b"\x00" * 33), ("deployment_id", b"\x00" * 31), ("chain_id", b"\x00" * 33)],
)
def test_a_wrong_width_field_is_refused_before_signing(field, value):
    key = _Key(b"\x01")
    fields = {
        "withdrawal_id": 1,
        "vault": VAULT,
        "squads_transaction_index": 0,
        "deployment_id": DEPLOYMENT,
        "chain_id": CHAIN,
        "registry_epoch": 1,
    } | {field: value}
    with pytest.raises(ValueError, match=field):
        VoteWithdrawalPaid.sign(key.signer(), **fields)
    assert key.signed == []


def test_preimages_match_rust_generated_shared_vectors():
    vector_path = Path(__file__).parents[2] / "conformance" / "vote-preimages.ndjson"
    rows = [json.loads(line) for line in vector_path.read_text().splitlines() if line]
    assert rows
    for row in rows:
        binding = (
            bytes.fromhex(row["deployment_id"]),
            bytes.fromhex(row["chain_id"]),
            int(row["registry_epoch"]),
        )
        kind = row["kind"]
        if kind in ("withdrawal_paid", "withdrawal_payout_dead", "payout_record"):
            build = {
                "withdrawal_paid": vote_withdrawal_paid_message,
                "withdrawal_payout_dead": vote_withdrawal_payout_dead_message,
                "payout_record": record_withdrawal_payout_message,
            }[kind]
            actual = build(
                int(row["withdrawal_id"]),
                bytes.fromhex(row["vault"]),
                row["squads_transaction_index"],
                *binding,
            )
        elif kind == "deposit":
            locator = row["locator"]
            actual = vote_deposit_message(
                bytes.fromhex(row["owner"]),
                int(row["amount_micro_usdc"]),
                bytes.fromhex(row["solana_tx_sig"]),
                None
                if locator is None
                else actions.DepositLocator(locator["top_index"], locator["inner_index"]),
                *binding,
            )
        elif kind == "pause_bridge":
            actual = vote_pause_bridge_message(int(row["signed_at_ms"]), *binding)
        else:
            raise AssertionError(f"unknown bridge message kind {kind}")
        assert actual.hex() == row["preimage_hex"], row["case"]
        # The dict entry point builds the same bytes.
        assert bridge_message_preimage(_fields(row)).hex() == row["preimage_hex"], row["case"]


def _fields(row: dict) -> dict:
    fields: dict = {
        "kind": row["kind"],
        "deployment_id": bytes.fromhex(row["deployment_id"]),
        "chain_id": bytes.fromhex(row["chain_id"]),
        "registry_epoch": int(row["registry_epoch"]),
    }
    if "withdrawal_id" in row:
        fields |= {
            "withdrawal_id": int(row["withdrawal_id"]),
            "vault": bytes.fromhex(row["vault"]),
            "squads_transaction_index": row["squads_transaction_index"],
        }
    if row["kind"] == "deposit":
        fields |= {
            "owner": bytes.fromhex(row["owner"]),
            "amount_micro_usdc": int(row["amount_micro_usdc"]),
            "solana_tx_sig": bytes.fromhex(row["solana_tx_sig"]),
            "locator": row["locator"],
        }
    if row["kind"] == "pause_bridge":
        fields["signed_at_ms"] = int(row["signed_at_ms"])
    return fields


def test_the_retired_receipt_surfaces_are_gone():
    # The receipt and payout-lease actions and their helpers are retired;
    # operators sign votes and payout records instead. A retired name must
    # not import.
    for name in (
        "ClaimWithdrawalPayout",
        "AuthorizeWithdrawal",
        "ConfirmWithdrawalReceipt",
        "FailWithdrawalReceipt",
        "OperatorReceiptProof",
        "BridgeWithdrawalReceipt",
    ):
        assert not hasattr(actions, name), name
