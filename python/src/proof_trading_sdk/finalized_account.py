"""Witnessed raw settled account facts, without valuation or authorization."""
from __future__ import annotations

import base64
import binascii
import typing as t
from dataclasses import dataclass

from proof_trading_sdk._native import MAX_ACCOUNT_STATE_BYTES, decode_account_state
from proof_trading_sdk.errors import GatewayReadError
from proof_trading_sdk.evidence import FinalizedReadWitness, decode_finalized_read_witness
from proof_trading_sdk.trigger_history import canonical_owner


@dataclass(frozen=True)
class RawAccountPosition:
    owner: str
    market: int
    side: t.Literal["Buy", "Sell"]
    entry_price: int
    size: int
    last_funding_index: int
    entry_remainder: int


@dataclass(frozen=True)
class FinalizedAccountState:
    """Settled balance and positions plus the gateway's witness assertion.

    No mark, accrued funding, PnL, equity, margin or trading authorization.
    ``verify_witness`` with an independently trusted H+1 header is separate;
    this read alone does not authenticate consensus or verify a state proof.
    """
    owner: str
    finalized_height: int
    balance: int
    positions: list[RawAccountPosition]
    witness: FinalizedReadWitness


def account_state_owner(owner: bytes | str) -> str:
    try:
        return canonical_owner(owner)
    except ValueError as err:
        raise GatewayReadError("malformed", "account.owner", "invalid account owner") from err


def decode_finalized_account_state(value: t.Any, owner: bytes | str) -> FinalizedAccountState:
    """Decode a strict witnessed envelope; native Rust owns all MessagePack."""
    bound_owner = account_state_owner(owner)
    if not isinstance(value, dict) or set(value) != {"data", "witness"}:
        raise GatewayReadError("malformed", "account.envelope")
    encoded = value["data"]
    if (
        not isinstance(encoded, str) or not encoded
        or len(encoded) > 4 * ((MAX_ACCOUNT_STATE_BYTES + 2) // 3)
    ):
        raise GatewayReadError("malformed", "account.base64")
    try:
        payload = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as err:
        raise GatewayReadError("malformed", "account.base64") from err
    if len(payload) > MAX_ACCOUNT_STATE_BYTES or base64.b64encode(payload).decode("ascii") != encoded:
        raise GatewayReadError("malformed", "account.base64")
    raw_witness = value["witness"]
    if not isinstance(raw_witness, dict) or len(raw_witness) != 5:
        raise GatewayReadError("malformed", "account.witness")
    witness = decode_finalized_read_witness(raw_witness)
    try:
        state = decode_account_state(payload, bytes.fromhex(bound_owner))
    except ValueError as err:
        raise GatewayReadError("malformed", "account.state") from err
    if state["finalized_height"] != witness.height:
        raise GatewayReadError("binding", "account.height", "account state/witness height mismatch")
    positions = [RawAccountPosition(
        owner=p["owner"].hex(), market=p["market"], side=p["side"],
        entry_price=p["entry_price"], size=p["size"],
        last_funding_index=p["last_funding_index"], entry_remainder=p.get("entry_remainder", 0),
    ) for p in state["positions"]]
    return FinalizedAccountState(
        owner=state["owner"].hex(), finalized_height=state["finalized_height"],
        balance=state["balance"], positions=positions, witness=witness,
    )
