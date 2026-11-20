"""The wire-13 bridge vote builders: preimage layout, signing, and removals.

The vote preimage (`PROOF_BRIDGE_VOTE_V1 || kind || …`) is pinned here
field-for-field — the engine re-derives exactly these bytes before verifying
each member's signature, so a drift is a rejected vote, not a decode
inconvenience. The payload encodes ride the shared conformance vectors (see
`test_typed_actions.py`).
"""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path

import pytest
from proof_trading_sdk import (
    BRIDGE_VOTE_DOMAIN,
    BRIDGE_VOTE_KIND_DEPOSIT_CREDIT,
    BRIDGE_VOTE_KIND_WITHDRAWAL_PAID,
    BRIDGE_VOTE_KIND_PAYOUT_DEAD,
    VoteDeposit,
    VoteWithdrawalPaid,
    VoteWithdrawalPayoutDead,
    actions,
)
from proof_trading_sdk.actions import (
    vote_deposit_message,
    vote_withdrawal_paid_message,
    vote_withdrawal_payout_dead_message,
)

DEPLOYMENT = b"\xa1" * 32
CHAIN = b"\xc7" * 32
VAULT = b"\xb2" * 32


class _Key:
    """A stand-in signer: deterministic bytes derived from the message."""

    def __init__(self, seed: bytes) -> None:
        self.seed = seed
        self.signed: list[bytes] = []

    def sign(self, message: bytes) -> bytes:
        self.signed.append(message)
        return bytes([self.seed[0]]) * 64


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
    vote = VoteWithdrawalPaid.sign(key, 777, VAULT, 11, DEPLOYMENT, CHAIN, 3)
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
        key, b"\x11" * 20, 1_000_000, b"\x22" * 64, None, DEPLOYMENT, CHAIN, 9
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
    vote = VoteWithdrawalPayoutDead.sign(key, 8, VAULT, 13, DEPLOYMENT, CHAIN, 4)
    assert vote.signature == b"\x51" * 64
    assert key.signed == [msg]


def test_preimages_match_rust_generated_shared_vectors():
    vector_path = Path(__file__).parents[2] / "conformance" / "vote-preimages.ndjson"
    rows = [json.loads(line) for line in vector_path.read_text().splitlines() if line]
    for row in rows:
        deployment_id = bytes.fromhex(row["deployment_id"])
        chain_id = bytes.fromhex(row["chain_id"])
        if row["case"] == "withdrawal_paid":
            actual = vote_withdrawal_paid_message(
                row["withdrawal_id"], bytes.fromhex(row["vault"]),
                row["squads_transaction_index"], deployment_id, chain_id, row["registry_epoch"],
            )
        elif row["case"] == "withdrawal_payout_dead":
            actual = vote_withdrawal_payout_dead_message(
                row["withdrawal_id"], bytes.fromhex(row["vault"]),
                row["squads_transaction_index"], deployment_id, chain_id, row["registry_epoch"],
            )
        else:
            actual = vote_deposit_message(
                bytes.fromhex(row["owner"]), row["amount_micro_usdc"],
                bytes.fromhex(row["solana_tx_sig"]),
                actions.DepositLocator(row["top_index"], row["inner_index"]),
                deployment_id, chain_id, row["registry_epoch"],
            )
        assert actual.hex() == row["preimage_hex"]


def test_the_retired_receipt_surfaces_are_gone():
    # Wire 12 retired the receipt-era actions and their helpers; the vote
    # actions replace them. Importing a retired name must fail.
    for name in (
        "AuthorizeWithdrawal",
        "ConfirmWithdrawalReceipt",
        "FailWithdrawalReceipt",
        "OperatorReceiptProof",
        "BridgeWithdrawalReceipt",
    ):
        assert not hasattr(actions, name), name
