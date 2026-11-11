"""The wire-12 bridge vote builders: preimage layout, signing, and removals.

The vote preimage (`PROOF_BRIDGE_VOTE_V1 || kind || …`) is pinned here
field-for-field — the engine re-derives exactly these bytes before verifying
each member's signature, so a drift is a rejected vote, not a decode
inconvenience. The payload encodes ride the shared conformance vectors (see
`test_typed_actions.py`).
"""

from __future__ import annotations

import dataclasses

import pytest
from proof_trading_sdk import (
    BRIDGE_VOTE_DOMAIN,
    BRIDGE_VOTE_KIND_DEPOSIT_CREDIT,
    BRIDGE_VOTE_KIND_WITHDRAWAL_PAID,
    VoteDeposit,
    VoteWithdrawalPaid,
    actions,
)
from proof_trading_sdk.actions import (
    vote_deposit_message,
    vote_withdrawal_paid_message,
)

DEPLOYMENT = b"\xa1" * 32
CHAIN = b"\xc7" * 32


class _Key:
    """A stand-in signer: deterministic bytes derived from the message."""

    def __init__(self, seed: bytes) -> None:
        self.seed = seed
        self.signed: list[bytes] = []

    def sign(self, message: bytes) -> bytes:
        self.signed.append(message)
        return bytes([self.seed[0]]) * 64


def test_withdrawal_vote_preimage_is_the_documented_layout():
    message = vote_withdrawal_paid_message(777, DEPLOYMENT, CHAIN, 3)
    assert message == (
        b"PROOF_BRIDGE_VOTE_V1"
        + bytes([BRIDGE_VOTE_KIND_WITHDRAWAL_PAID])
        + (777).to_bytes(8, "big")
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
    vote = VoteWithdrawalPaid.sign(key, 777, DEPLOYMENT, CHAIN, 3)
    assert vote.signature == b"\x42" * 64
    # The signature is over exactly the canonical preimage of the same fields.
    assert key.signed == [vote_withdrawal_paid_message(777, DEPLOYMENT, CHAIN, 3)]
    assert dataclasses.asdict(vote) == {
        "withdrawal_id": 777,
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
