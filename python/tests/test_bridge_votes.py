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

import _ed25519
from proof_trading_sdk import _native
from proof_trading_sdk import (
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

# The wire's message domain and kind bytes, written out so the test pins them.
BRIDGE_VOTE_DOMAIN = b"PROOF_BRIDGE_VOTE_V1"
BRIDGE_VOTE_KIND_WITHDRAWAL_PAID = 1
BRIDGE_VOTE_KIND_DEPOSIT_CREDIT = 2
BRIDGE_VOTE_KIND_PAYOUT_DEAD = 4
BRIDGE_VOTE_KIND_PAYOUT_RECORD = 5
BRIDGE_VOTE_KIND_PAUSE = 6

DEPLOYMENT = b"\xa1" * 32
CHAIN = b"\xc7" * 32
VAULT = b"\xb2" * 32
SIGNED_AT = 1_700_000_000_123


def _tail(epoch: int, signed_at_ms: int = SIGNED_AT) -> bytes:
    """The signed tail every bridge message ends in."""
    return DEPLOYMENT + CHAIN + epoch.to_bytes(8, "big") + signed_at_ms.to_bytes(8, "big")


class _Key:
    """An external signer over a real ed25519 key that records what it was
    asked to sign. ``length`` truncates or pads the signature it returns;
    ``wrong_key`` reports another key's public key."""

    def __init__(self, seed: bytes, length: int = 64, wrong_key: bool = False) -> None:
        self.secret = seed[:1] * 32
        self.public_key = _ed25519.public_key(b"\xee" * 32 if wrong_key else self.secret)
        self.length = length
        self.signed: list[bytes] = []

    def signer(self) -> ExternalSigner:
        def sign_raw(message: bytes) -> bytes:
            self.signed.append(message)
            signature = _ed25519.sign(self.secret, message)
            return (signature + bytes(64))[: self.length]

        return ExternalSigner(public_key=self.public_key, sign_raw=sign_raw)


def test_withdrawal_vote_preimage_is_the_documented_layout():
    message = vote_withdrawal_paid_message(777, VAULT, 11, DEPLOYMENT, CHAIN, 3, SIGNED_AT)
    assert message == (
        b"PROOF_BRIDGE_VOTE_V1"
        + bytes([BRIDGE_VOTE_KIND_WITHDRAWAL_PAID])
        + (777).to_bytes(8, "big")
        + VAULT
        + (11).to_bytes(4, "big")
        + _tail(3)
    )


def test_deposit_vote_preimage_carries_the_locator_suffix():
    locator = actions.DepositLocator(top_index=2, inner_index=5)
    message = vote_deposit_message(
        b"\x11" * 20, 1_000_000, b"\x22" * 64, locator, DEPLOYMENT, CHAIN, 9, SIGNED_AT
    )
    assert message == (
        BRIDGE_VOTE_DOMAIN
        + bytes([BRIDGE_VOTE_KIND_DEPOSIT_CREDIT])
        + b"\x11" * 20
        + (1_000_000).to_bytes(8, "big")
        + b"\x22" * 64
        + (2).to_bytes(2, "big")
        + (5).to_bytes(2, "big")
        + _tail(9)
    )


def test_an_absent_locator_signs_the_legacy_suffix():
    absent = vote_deposit_message(
        b"\x11" * 20, 5, b"\x22" * 64, None, DEPLOYMENT, CHAIN, 1, SIGNED_AT
    )
    legacy = vote_deposit_message(
        b"\x11" * 20,
        5,
        b"\x22" * 64,
        actions.DepositLocator(top_index=0, inner_index=None),
        DEPLOYMENT,
        CHAIN,
        1,
        SIGNED_AT,
    )
    # None and the LEGACY locator are the same reading: identical bytes.
    assert absent == legacy
    at = len(BRIDGE_VOTE_DOMAIN) + 1 + 20 + 8 + 64
    assert absent[at : at + 4] == b"\x00\x00\xff\xff"


def test_sign_fills_the_payload_signature():
    key = _Key(b"\x42")
    vote = VoteWithdrawalPaid.sign(key.signer(), 777, VAULT, 11, DEPLOYMENT, CHAIN, 3, signed_at_ms=SIGNED_AT)
    assert len(vote.signature) == 64
    # The signature is over exactly the canonical preimage of the same fields.
    assert key.signed == [vote_withdrawal_paid_message(777, VAULT, 11, DEPLOYMENT, CHAIN, 3, SIGNED_AT)]
    assert dataclasses.asdict(vote) == {
        "withdrawal_id": 777,
        "vault": VAULT,
        "squads_transaction_index": 11,
        "deployment_id": DEPLOYMENT,
        "chain_id": CHAIN,
        "registry_epoch": 3,
        "signed_at_ms": SIGNED_AT,
        "signature": vote.signature,
    }

    deposit = VoteDeposit.sign(
        key.signer(),
        b"\x11" * 20, 1_000_000, b"\x22" * 64, None, DEPLOYMENT,
        CHAIN,
        9,
        signed_at_ms=SIGNED_AT,
    )
    assert key.signed[-1] == vote_deposit_message(
        b"\x11" * 20, 1_000_000, b"\x22" * 64, None, DEPLOYMENT, CHAIN, 9, SIGNED_AT
    )
    assert deposit.locator is None


def test_payout_dead_vote_uses_its_distinct_canonical_kind():
    key = _Key(b"\x51")
    msg = vote_withdrawal_payout_dead_message(8, VAULT, 13, DEPLOYMENT, CHAIN, 4, SIGNED_AT)
    assert msg == (
        BRIDGE_VOTE_DOMAIN + bytes([BRIDGE_VOTE_KIND_PAYOUT_DEAD])
        + (8).to_bytes(8, "big") + VAULT + (13).to_bytes(4, "big")
        + _tail(4)
    )
    vote = VoteWithdrawalPayoutDead.sign(key.signer(), 8, VAULT, 13, DEPLOYMENT, CHAIN, 4, signed_at_ms=SIGNED_AT)
    assert _native.verify_raw_signature(key.public_key, vote.signature, msg)
    assert key.signed == [msg]


def test_the_record_and_pause_messages_carry_their_kinds():
    key = _Key(b"\x5d")
    record = RecordWithdrawalPayout.sign(
        key.signer(), 8, VAULT, 13, DEPLOYMENT, CHAIN, 4, signed_at_ms=SIGNED_AT
    )
    assert key.signed[-1] == record_withdrawal_payout_message(
        8, VAULT, 13, DEPLOYMENT, CHAIN, 4, SIGNED_AT
    )
    assert key.signed[-1][len(BRIDGE_VOTE_DOMAIN)] == BRIDGE_VOTE_KIND_PAYOUT_RECORD
    assert _native.verify_raw_signature(key.public_key, record.signature, key.signed[-1])

    pause = VotePauseBridge.sign(key.signer(), DEPLOYMENT, CHAIN, 2, signed_at_ms=SIGNED_AT)
    # The pause vote signs the tail alone.
    assert key.signed[-1] == BRIDGE_VOTE_DOMAIN + bytes([BRIDGE_VOTE_KIND_PAUSE]) + _tail(2)
    assert _native.verify_raw_signature(key.public_key, pause.signature, key.signed[-1])


def test_a_key_handle_signs_the_message_in_rust():
    from proof_trading_sdk import _native

    read_fd, write_fd = os.pipe()
    os.write(write_fd, b"\x07" * 32)
    os.close(write_fd)
    try:
        handle = _native.load_key_from_fd(read_fd)
    finally:
        os.close(read_fd)
    vote = VotePauseBridge.sign(handle, DEPLOYMENT, CHAIN, 2, signed_at_ms=5)
    assert _native.verify_raw_signature(
        handle.public_key,
        vote.signature,
        vote_pause_bridge_message(DEPLOYMENT, CHAIN, 2, 5),
    )
    # The handle signs only bridge messages it built, never arbitrary bytes.
    assert not hasattr(handle, "sign_raw")
    assert not hasattr(handle, "sign")


@pytest.mark.parametrize("length", [63, 65])
def test_an_external_signer_must_return_64_bytes(length):
    with pytest.raises(ValueError, match="64 signature bytes"):
        VotePauseBridge.sign(_Key(b"\x01", length).signer(), DEPLOYMENT, CHAIN, 2, signed_at_ms=5)


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
            int(row["signed_at_ms"]),
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
            actual = vote_pause_bridge_message(*binding)
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
        "signed_at_ms": int(row["signed_at_ms"]),
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
    return fields


def test_an_external_signature_from_another_key_is_refused():
    with pytest.raises(ValueError, match="does not verify"):
        VotePauseBridge.sign(
            _Key(b"\x01", wrong_key=True).signer(), DEPLOYMENT, CHAIN, 2, signed_at_ms=5
        )


@pytest.mark.parametrize("value", [32, "a" * 32, None])
def test_a_byte_field_must_be_bytes(value):
    key = _Key(b"\x01")
    with pytest.raises(TypeError, match="vault must be bytes"):
        VoteWithdrawalPaid.sign(key.signer(), 7, value, 3, DEPLOYMENT, CHAIN, 1)
    with pytest.raises(TypeError, match="vault must be bytes"):
        vote_withdrawal_paid_message(7, value, 3, DEPLOYMENT, CHAIN, 1, SIGNED_AT)
    assert key.signed == []


def test_the_dict_entry_point_refuses_text_unknown_keys_and_the_sentinel():
    payout = {
        "kind": "withdrawal_paid",
        "withdrawal_id": 7,
        "vault": VAULT,
        "squads_transaction_index": 3,
        "deployment_id": DEPLOYMENT,
        "chain_id": CHAIN,
        "registry_epoch": 1,
        "signed_at_ms": SIGNED_AT,
    }
    with pytest.raises(ValueError):
        bridge_message_preimage(payout | {"vault": "a" * 32})
    with pytest.raises(ValueError, match="locator"):
        bridge_message_preimage(payout | {"locator": None})
    deposit = {
        "kind": "deposit",
        "owner": b"\x11" * 20,
        "amount_micro_usdc": 1,
        "solana_tx_sig": b"\x22" * 64,
        "deployment_id": DEPLOYMENT,
        "chain_id": CHAIN,
        "registry_epoch": 1,
        "signed_at_ms": SIGNED_AT,
    }
    # A misspelled locator would otherwise sign the legacy identity.
    with pytest.raises(ValueError, match="locater"):
        bridge_message_preimage(deposit | {"locater": {"top_index": 2, "inner_index": 5}})
    with pytest.raises(ValueError, match="inner"):
        bridge_message_preimage(deposit | {"locator": {"top_index": 2, "inner": 5}})
    with pytest.raises(ValueError, match="sentinel"):
        bridge_message_preimage(deposit | {"locator": {"top_index": 0, "inner_index": 65535}})


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


@pytest.mark.parametrize(
    "config, error",
    [
        ({"payout_multisig": bytes(32), "ops_wallet": b"\x01" * 32}, "payout_multisig must not be zero"),
        ({"payout_multisig": b"\x01" * 32, "ops_wallet": bytes(32)}, "ops_wallet must not be zero"),
        ({"payout_multisig": b"\x01" * 32, "ops_wallet": b"\x01" * 32}, "must differ"),
        ({"payout_multisig": b"\x01" * 31, "ops_wallet": b"\x02" * 32}, "32 bytes"),
    ],
)
def test_a_payout_config_proposal_follows_the_wire_rule(config, error):
    with pytest.raises(ValueError, match=error):
        actions.ProposeAdminAction(
            proposer=b"\x01" * 20,
            registry_version=1,
            action={"SetBridgePayoutConfig": config},
        )


@pytest.mark.parametrize(
    "action, error",
    [
        ({"SetWithdrawalPolicy": {"fee_micro_usdc": 2, "min_withdrawal_micro_usdc": 1}}, "below fee"),
        (
            {"SetDepositReceiptLimit": {"per_receipt_max_micro_usdc": 1, "window_cap_micro_usdc": 1, "window_secs": 0}},
            "at least 1",
        ),
        (
            {"SetDepositReceiptLimit": {"per_receipt_max_micro_usdc": 2, "window_cap_micro_usdc": 1, "window_secs": 60}},
            "above window_cap",
        ),
    ],
)
def test_admin_limits_follow_the_wire_rules(action, error):
    with pytest.raises(ValueError, match=error):
        actions.ProposeAdminAction(proposer=b"\x01" * 20, registry_version=1, action=action)


def test_a_cap_of_zero_is_off():
    actions.ProposeAdminAction(
        proposer=b"\x01" * 20,
        registry_version=1,
        action={"SetDepositReceiptLimit": {"per_receipt_max_micro_usdc": 2, "window_cap_micro_usdc": 0, "window_secs": 60}},
    )


def test_every_kind_signs_its_time():
    """The same item signed at another time is another message, so a
    signature cannot be replayed at a later time."""
    builds = [
        lambda at: vote_withdrawal_paid_message(1, VAULT, 1, DEPLOYMENT, CHAIN, 1, at),
        lambda at: vote_withdrawal_payout_dead_message(1, VAULT, 1, DEPLOYMENT, CHAIN, 1, at),
        lambda at: record_withdrawal_payout_message(1, VAULT, 1, DEPLOYMENT, CHAIN, 1, at),
        lambda at: vote_deposit_message(b"\x11" * 20, 1, b"\x22" * 64, None, DEPLOYMENT, CHAIN, 1, at),
        lambda at: vote_pause_bridge_message(DEPLOYMENT, CHAIN, 1, at),
    ]
    for build in builds:
        now, later = build(SIGNED_AT), build(SIGNED_AT + 1)
        assert now != later
        assert now[-8:] == SIGNED_AT.to_bytes(8, "big")
        assert later[-8:] == (SIGNED_AT + 1).to_bytes(8, "big")


def test_sign_uses_the_current_time_when_none_is_passed(monkeypatch):
    monkeypatch.setattr(actions.time, "time_ns", lambda: 1_800_000_000_456_000_000)
    key = _Key(b"\x42")
    pause = VotePauseBridge.sign(key.signer(), DEPLOYMENT, CHAIN, 2)
    assert pause.signed_at_ms == 1_800_000_000_456
    assert key.signed[-1] == vote_pause_bridge_message(DEPLOYMENT, CHAIN, 2, 1_800_000_000_456)
    paid = VoteWithdrawalPaid.sign(key.signer(), 1, VAULT, 1, DEPLOYMENT, CHAIN, 2)
    assert paid.signed_at_ms == 1_800_000_000_456
    assert key.signed[-1][-8:] == (1_800_000_000_456).to_bytes(8, "big")
