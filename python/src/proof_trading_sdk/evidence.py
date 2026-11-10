"""Chain-bound gateway assertions; no validator-signature verification."""

from __future__ import annotations

import re
import typing as t
from dataclasses import dataclass
from datetime import datetime

from proof_trading_sdk._native import chain_id_from_string
from proof_trading_sdk.errors import GatewayReadError

_I64_MAX = (1 << 63) - 1
_SAFE_INTEGER = (1 << 53) - 1
_HASH = re.compile(r"[a-fA-F0-9]{64}")
_DECIMAL = re.compile(r"(?:0|[1-9][0-9]{0,19})")
# Hour 24 is excluded here because datetime.fromisoformat accepts it from Python 3.14.
_TIME = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z")


@dataclass(frozen=True)
class FinalizedReadWitness:
    """A gateway's finalized-view assertion, not a cryptographic state proof."""

    version: int
    node_id: str
    height: int
    finalized_block_time_ms: int
    app_hash: str


@dataclass(frozen=True)
class BlockEvidenceHeader:
    """Header H contains the app hash after H-1. Hashes are uppercase hex."""

    hash: str
    chain_id: str
    height: int
    parent_hash: str | None
    time: str
    app_hash: str | None


def _object(value: t.Any, field: str) -> dict[str, t.Any]:
    if not isinstance(value, dict):
        raise GatewayReadError("malformed", field)
    return value


def _hash(value: t.Any, field: str) -> str:
    if not isinstance(value, str) or _HASH.fullmatch(value) is None:
        raise GatewayReadError("malformed", field)
    return value.upper()


def _chain_name(value: t.Any) -> bool:
    if not isinstance(value, str) or not 1 <= len(value) <= 128:
        return False
    try:
        # TS string.length counts UTF-16 code units; reject lone surrogates.
        return len(value.encode("utf-16-le")) <= 256
    except UnicodeError:
        return False


def _chain_pin(chain_id: str | bytes) -> bytes:
    if isinstance(chain_id, bytes) and len(chain_id) == 32 and any(chain_id):
        return chain_id
    if _chain_name(chain_id):
        return chain_id_from_string(chain_id)
    raise GatewayReadError("configuration", "chainId", "an explicit chain pin is required")


def _requested_height(height: int) -> int:
    if type(height) is not int or not 1 <= height <= _I64_MAX:
        raise GatewayReadError("malformed", "requested block height")
    return height


def _uint(value: t.Any, field: str) -> int:
    if type(value) is int and 0 <= value <= _SAFE_INTEGER:
        return value
    if isinstance(value, str) and _DECIMAL.fullmatch(value):
        n = int(value)
        if n <= _I64_MAX:
            return n
    raise GatewayReadError("malformed", field)


def decode_finalized_read_witness(
    value: t.Any, *, expected_height: int | None = None,
    expected_time_ms: int | None = None,
) -> FinalizedReadWitness:
    """Decode a gateway witness, optionally binding the read's own height/time.

    Wire heights/times are canonical positive decimal strings, not JSON numbers.
    Unknown fields are tolerated, as in the generic TypeScript decoder.
    """
    w = _object(value, "witness")
    node = w.get("nodeId")
    app = w.get("appHash")
    if (
        type(w.get("version")) is not int or w["version"] != 1
        or not isinstance(node, str) or re.fullmatch(r"[a-f0-9]{40}", node) is None
        or node == "0" * 40
        or not isinstance(app, str) or _HASH.fullmatch(app) is None
        or app == "0" * 64
    ):
        raise GatewayReadError("malformed", "witness")
    numbers = []
    for key in ("height", "finalizedBlockTimeMs"):
        raw = w.get(key)
        if not isinstance(raw, str) or re.fullmatch(r"[1-9][0-9]{0,19}", raw) is None:
            raise GatewayReadError("malformed", "witness")
        n = int(raw)
        if n > _I64_MAX:
            raise GatewayReadError("malformed", "witness")
        numbers.append(n)
    height, timestamp = numbers
    if (
        expected_height is not None and (type(expected_height) is not int or height != expected_height)
        or expected_time_ms is not None and (type(expected_time_ms) is not int or timestamp != expected_time_ms)
    ):
        raise GatewayReadError("binding", "witness", "finalized witness height/time mismatch")
    return FinalizedReadWitness(1, node, height, timestamp, app.upper())


def decode_block_evidence_header(
    value: t.Any, *, height: int, chain_id: str | bytes,
) -> BlockEvidenceHeader:
    """Decode a complete gateway ``/v1/block`` JSON-RPC envelope.

    Checks the requested height and explicit chain pin, not header hashes or
    validator signatures. Use the bounded client read for untrusted JSON bytes.
    """
    chain = _chain_pin(chain_id)
    _requested_height(height)
    envelope = _object(value, "RPC envelope")
    if "error" in envelope:
        raise GatewayReadError("malformed", "RPC error")
    if envelope.get("jsonrpc") != "2.0":
        raise GatewayReadError("malformed", "RPC version")
    response = _object(envelope.get("result"), "RPC result")
    block = _object(response.get("block"), "block")
    header = _object(block.get("header"), "block header")
    if _uint(header.get("height"), "block height") != height:
        raise GatewayReadError("binding", "block height mismatch")
    name = header.get("chain_id")
    if not _chain_name(name) or chain_id_from_string(name) != chain:
        raise GatewayReadError("binding", "block chain mismatch")
    previous = _object(header.get("last_block_id"), "previous block ID").get("hash")
    parent_hash = None if height == 1 and previous == "" else _hash(previous, "parent block hash")
    timestamp = header.get("time")
    if not isinstance(timestamp, str) or _TIME.fullmatch(timestamp) is None:
        raise GatewayReadError("malformed", "block time")
    try:
        parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        if parsed.year < 1970:
            raise ValueError("pre-epoch block time")
    except ValueError as err:
        raise GatewayReadError("malformed", "block time") from err
    app = header.get("app_hash")
    return BlockEvidenceHeader(
        hash=_hash(_object(response.get("block_id"), "block ID").get("hash"), "block hash"),
        chain_id=name, height=height, parent_hash=parent_hash, time=timestamp,
        app_hash=None if height == 1 and app == "" else _hash(app, "block app hash"),
    )


def verify_witness(
    witness: FinalizedReadWitness, next_header: BlockEvidenceHeader, chain_id: str | bytes,
) -> None:
    """Bind witness H to an explicitly pinned H+1 header's app hash.

    Success is only as trustworthy as the header source. Two reads from the
    same gateway establish consistency, not validator signatures, authenticity,
    freshness, solvency, or trading authorization. H+1's time is not H's time.
    """
    expected = _chain_pin(chain_id)
    if (
        not isinstance(witness, FinalizedReadWitness)
        or type(witness.height) is not int or type(witness.finalized_block_time_ms) is not int
        or not 1 <= witness.height <= _I64_MAX
        or not 1 <= witness.finalized_block_time_ms <= _I64_MAX
    ):
        raise GatewayReadError("malformed", "witness")
    # Dataclasses can be constructed manually; don't silently trust their hints.
    checked = decode_finalized_read_witness({
        "version": witness.version, "nodeId": witness.node_id,
        "height": str(witness.height), "finalizedBlockTimeMs": str(witness.finalized_block_time_ms),
        "appHash": witness.app_hash,
    })
    if (
        not isinstance(next_header, BlockEvidenceHeader)
        or not _chain_name(next_header.chain_id)
        or type(next_header.height) is not int
        or not isinstance(next_header.app_hash, str)
        or _HASH.fullmatch(next_header.app_hash) is None
        or checked.height >= _I64_MAX
        or next_header.height != checked.height + 1
        or chain_id_from_string(next_header.chain_id) != expected
        or checked.app_hash != next_header.app_hash.upper()
    ):
        raise GatewayReadError("binding", "witness", "finalized witness/header/chain mismatch")
