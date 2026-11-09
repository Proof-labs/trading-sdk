"""Bounded, internally consistent gateway observations; not consensus proofs."""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import math
import time
import typing as t
from dataclasses import dataclass
from datetime import datetime
from urllib.parse import urljoin

from proof_trading_sdk._bounded_read import bounded_gateway_json, read_deadline
from proof_trading_sdk.errors import GatewayReadError
from proof_trading_sdk.evidence import (
    BlockEvidenceHeader, _chain_pin, _hash, _object, _uint,
    decode_block_evidence_header,
)

_I64_MAX = (1 << 63) - 1
_MAX_TX_BYTES = 1024 * 1024
_MAX_DATE_MS = 8_640_000_000_000_000
_MISSING = object()


class TransactionEvidenceAttribute(t.TypedDict, total=False):
    key: str
    value: str
    index: bool


@dataclass(frozen=True)
class TransactionEvidenceEvent:
    """Comet event strings, retained without economic interpretation."""
    type: str
    attributes: list[TransactionEvidenceAttribute] | None = None


@dataclass(frozen=True)
class TransactionEvidence:
    """One returned occurrence; a replay refusal cannot exclude earlier admission."""
    source: t.Literal["trusted-gateway"]
    hash: str
    signed_bytes: bytes
    height: int
    index: int
    code: int
    events: list[TransactionEvidenceEvent]
    block: BlockEvidenceHeader


@dataclass(frozen=True)
class BlockTransactionEvidence:
    index: int
    hash: str
    signed_bytes: bytes
    code: int
    events: list[TransactionEvidenceEvent]


@dataclass(frozen=True)
class BlockResultsEvidence:
    header: BlockEvidenceHeader
    post_app_hash: str
    transactions: list[BlockTransactionEvidence]
    finalize_block_events: list[TransactionEvidenceEvent]


@dataclass(frozen=True)
class BlockResultsRange:
    source: t.Literal["trusted-gateway"]
    from_height: int
    through_height: int
    anchor: BlockEvidenceHeader
    blocks: list[BlockResultsEvidence]


@dataclass(frozen=True)
class BlockResultsWindow(BlockResultsRange):
    """Includes boundary blocks; callers must apply [from_ms, to_ms) themselves."""
    from_ms: int
    to_ms: int


def _fail(field: str, kind: str = "malformed") -> t.NoReturn:
    raise GatewayReadError(kind, field)


def _rpc(value: t.Any) -> dict[str, t.Any]:
    envelope = _object(value, "RPC envelope")
    if "error" in envelope:
        _fail("RPC error")
    if envelope.get("jsonrpc") != "2.0":
        _fail("RPC version")
    return _object(envelope.get("result"), "RPC result")


def _number(value: t.Any, maximum: int, field: str) -> int:
    n = _uint(value, field)
    if n > maximum:
        _fail(field)
    return n


def _bytes(value: t.Any, field: str) -> bytes:
    if not isinstance(value, str) or not value or len(value) > 4 * ((_MAX_TX_BYTES + 2) // 3):
        _fail(field)
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        _fail(field)
    if len(decoded) > _MAX_TX_BYTES or base64.b64encode(decoded).decode("ascii") != value:
        _fail(field)
    return decoded


def _events(value: t.Any = _MISSING, *, max_events: int = 4096,
            max_attributes: int = 4096) -> list[TransactionEvidenceEvent]:
    if value is _MISSING:
        return []
    if not isinstance(value, list):
        _fail("events")
    if len(value) > max_events:
        _fail("event limit", "limit")
    count, result = 0, []
    for entry in value:
        event = _object(entry, "event")
        name = event.get("type")
        if not isinstance(name, str) or not 1 <= len(name.encode("utf-16-le", "surrogatepass")) // 2 <= 1024:
            _fail("event type")
        attributes = None
        if "attributes" in event:
            raw = event["attributes"]
            if not isinstance(raw, list):
                _fail("event attributes")
            count += len(raw)
            if count > max_attributes:
                _fail("attribute limit", "limit")
            attributes = []
            for item in raw:
                a = _object(item, "event attribute")
                decoded: TransactionEvidenceAttribute = {}
                for key in ("key", "value", "index"):
                    if key in a:
                        if type(a[key]) is not (bool if key == "index" else str):
                            _fail(f"attribute {key}")
                        decoded[key] = a[key]
                attributes.append(decoded)
        result.append(TransactionEvidenceEvent(name, attributes))
    return result


def _transactions_root(transactions: list[bytes]) -> str:
    """Comet Txs.Hash: RFC6962 Merkle tree of SHA256(transaction) leaves."""
    leaves = [hashlib.sha256(tx).digest() for tx in transactions]

    def root(start: int, end: int) -> bytes:
        size = end - start
        if size == 0:
            return hashlib.sha256(b"").digest()
        if size == 1:
            return hashlib.sha256(b"\x00" + leaves[start]).digest()
        split = 1 << ((size - 1).bit_length() - 1)
        return hashlib.sha256(b"\x01" + root(start, start + split) + root(start + split, end)).digest()

    return root(0, len(leaves)).hex().upper()


def _bind_transactions(response: dict[str, t.Any], transactions: list[bytes]) -> None:
    header = _object(_object(response.get("block"), "block").get("header"), "block header")
    if _hash(header.get("data_hash"), "block data hash") != _transactions_root(transactions):
        _fail("block transactions root", "binding")


def _nanos(validated_time: str) -> int:
    # Headers already validate UTC/calendar/epoch. Avoid float timestamps and
    # datetime's microsecond truncation: the last three digits matter here.
    seconds = datetime.fromisoformat(validated_time[:19]) - datetime(1970, 1, 1)
    fraction = validated_time[20:-1] if "." in validated_time else ""
    return (seconds.days * 86400 + seconds.seconds) * 1_000_000_000 + int(fraction.ljust(9, "0"))


def _decoded_size(raw: t.Any) -> int:
    compact = json.dumps(raw, ensure_ascii=False, separators=(",", ":"))

    def extra(value: t.Any) -> int:
        if type(value) is float and math.isfinite(value):
            # Conservative byte accounting only, never numeric decoding. This
            # fixed-point width covers JS's decimal expansion near 1e-6/1e21
            # without duplicating its number formatter (up to 17 significant
            # digits, at most 22 fractional places in that interval).
            return max(0, len(format(value, ".23f")) - len(json.dumps(value)))
        if type(value) is int and abs(value) > (1 << 53) - 1:
            # A JS Number can round across a power of ten; charge that carry.
            return 1
        if isinstance(value, list):
            return sum(extra(item) for item in value)
        if isinstance(value, dict):
            return sum(extra(item) for item in value.values())
        return 0

    # Escaped lone surrogates remain escaped, as in JSON.stringify. JSON depth
    # and HTTP byte bounds have already limited this tree before counting it.
    return len(compact.encode("utf-8", "backslashreplace")) + extra(raw)


class _Read:
    def __init__(self, client: t.Any, timeout: float, max_bytes: int | None = None):
        self.client, self.timeout, self.max_bytes = client, timeout, max_bytes
        self.deadline = read_deadline(timeout)
        self.decoded_bytes = 0

    def check(self) -> None:
        if time.monotonic() >= self.deadline:
            _fail("timeout", "deadline")

    def get(self, path: str, params: dict[str, str] | None = None) -> dict[str, t.Any]:
        raw = bounded_gateway_json(
            self.client._http, urljoin(self.client._gateway_url, path), params or {},
            timeout=self.timeout, deadline=self.deadline,
            on_response=self.client._parse_rate_limits, check_response=self.client._check_response,
        )
        if self.max_bytes is not None:
            self.decoded_bytes += _decoded_size(raw)
            if self.decoded_bytes > self.max_bytes:
                _fail("decoded byte budget", "limit")
        self.check()
        return raw


def read_transaction_evidence(client: t.Any, tx_hash: str, signed_bytes: bytes, *,
                              chain_id: str | bytes, timeout: float) -> TransactionEvidence:
    read = _Read(client, timeout)
    chain = _chain_pin(chain_id)
    if not isinstance(signed_bytes, (bytes, bytearray, memoryview)):
        _fail("signed bytes")
    try:
        size = signed_bytes.nbytes if isinstance(signed_bytes, memoryview) else len(signed_bytes)
        if not 1 <= size <= _MAX_TX_BYTES:
            _fail("signed bytes")
        signed_bytes = bytes(signed_bytes)
    except (ValueError, TypeError):
        _fail("signed bytes")
    if not 1 <= len(signed_bytes) <= _MAX_TX_BYTES:
        _fail("signed bytes")
    requested_hash = _hash(tx_hash, "requested hash")
    if hashlib.sha256(signed_bytes).hexdigest().upper() != requested_hash:
        _fail("requested hash/bytes mismatch", "binding")
    tx = _rpc(read.get(f"/v1/tx/{requested_hash}"))
    if _hash(tx.get("hash"), "transaction hash") != requested_hash or _bytes(tx.get("tx"), "transaction bytes") != signed_bytes:
        _fail("returned transaction binding")
    height = _number(tx.get("height"), _I64_MAX, "transaction height")
    if height == 0:
        _fail("transaction height")
    index = _number(tx.get("index"), 0xffffffff, "transaction index")
    result = _object(tx.get("tx_result"), "execution result")
    code = _number(result.get("code", 0), 0xffffffff, "execution code")
    events = _events(result.get("events", _MISSING))
    raw = read.get("/v1/block", {"height": str(height)})
    response = _rpc(raw)
    header = decode_block_evidence_header(raw, height=height, chain_id=chain)
    transactions = _object(_object(response.get("block"), "block").get("data"), "block data").get("txs")
    if not isinstance(transactions, list) or len(transactions) > 100_000 or index >= len(transactions):
        _fail("block transaction index")
    transactions = [_bytes(tx, "block transaction bytes") for tx in transactions]
    if transactions[index] != signed_bytes:
        _fail("block transaction binding")
    _bind_transactions(response, transactions)
    read.check()
    return TransactionEvidence("trusted-gateway", requested_hash, signed_bytes, height, index, code, events, header)


def read_block_results(
    client: t.Any, through_height: int, *, chain_id: str | bytes, timeout: float,
    from_height: int | None = None, from_ms: int | None = None, to_ms: int | None = None,
    max_heights: int = 32, max_decoded_bytes: int = 8 * 1024 * 1024,
    max_transactions: int = 10_000, max_events: int = 16_384, max_attributes: int = 65_536,
) -> BlockResultsRange | BlockResultsWindow:
    for value, ceiling, field in (
        (max_heights, 128, "heights"), (max_decoded_bytes, 8 * 1024 * 1024, "bytes"),
        (max_transactions, 10_000, "transactions"), (max_events, 16_384, "events"),
        (max_attributes, 65_536, "attributes"),
    ):
        if type(value) is not int or not 1 <= value <= ceiling:
            _fail(field, "configuration")
    read = _Read(client, timeout, max_decoded_bytes)
    chain = _chain_pin(chain_id)
    window = from_height is None
    if window:
        if type(from_ms) is not int or type(to_ms) is not int or not 0 <= from_ms < to_ms <= _MAX_DATE_MS:
            _fail("fixed window")
    if type(through_height) is not int or not 1 <= through_height < _I64_MAX:
        _fail("through height")
    if not window:
        if type(from_height) is not int or not 1 <= from_height <= through_height:
            _fail("from height")
        if through_height - from_height + 1 > max_heights:
            _fail("height budget", "limit")
    raw = read.get("/v1/block", {"height": str(through_height + 1)})
    anchor = decode_block_evidence_header(raw, height=through_height + 1, chain_id=chain)
    next_header, blocks = anchor, []
    transaction_count = event_count = attribute_count = 0

    def decode_events(raw: t.Any) -> list[TransactionEvidenceEvent]:
        nonlocal event_count, attribute_count
        decoded = _events(raw, max_events=max_events - event_count,
                          max_attributes=max_attributes - attribute_count)
        event_count += len(decoded)
        attribute_count += sum(len(event.attributes or []) for event in decoded)
        return decoded

    for height in range(through_height, max(through_height - max_heights, 0), -1):
        raw = read.get("/v1/block", {"height": str(height)})
        response = _rpc(raw)
        header = decode_block_evidence_header(raw, height=height, chain_id=chain)
        if next_header.parent_hash != header.hash:
            _fail("parent hash continuity")
        if _nanos(header.time) > _nanos(next_header.time):
            _fail("block time continuity")
        if window and height == through_height and _nanos(header.time) < to_ms * 1_000_000:
            _fail("source has not reached window end")
        txs = _object(_object(response.get("block"), "block").get("data"), "block data").get("txs", _MISSING)
        if txs is not None and not isinstance(txs, list):
            _fail("block transactions")
        txs = txs or []
        transaction_count += len(txs)
        if transaction_count > max_transactions:
            _fail("transaction budget", "limit")
        transactions = [_bytes(tx, "block transaction bytes") for tx in txs]
        _bind_transactions(response, transactions)
        result = _rpc(read.get("/v1/block_results", {"height": str(height)}))
        if _number(result.get("height"), _I64_MAX, "results height") != height:
            _fail("results height mismatch", "binding")
        tx_results = result.get("txs_results", _MISSING)
        if tx_results is not None and not isinstance(tx_results, list):
            _fail("transaction results")
        tx_results = tx_results or []
        if len(tx_results) != len(txs):
            _fail("transaction result count")
        final_events = result.get("finalize_block_events", _MISSING)
        if final_events is not None and not isinstance(final_events, list):
            _fail("finalize block events")
        post_state = _bytes(result.get("app_hash"), "results app hash")
        if len(post_state) != 32:
            _fail("results app hash length")
        post_hash = post_state.hex().upper()
        if next_header.app_hash is None or post_hash != next_header.app_hash:
            _fail("post-state/header binding")
        evidence = []
        for index, signed_bytes in enumerate(transactions):
            execution = _object(tx_results[index], "transaction result")
            evidence.append(BlockTransactionEvidence(
                index, hashlib.sha256(signed_bytes).hexdigest().upper(), signed_bytes,
                _number(execution.get("code", 0), 0xffffffff, "execution code"),
                decode_events(execution.get("events", _MISSING)),
            ))
        blocks.append(BlockResultsEvidence(header, post_hash, evidence, decode_events(final_events or [])))
        read.check()
        complete = (height == from_height) if not window else (_nanos(header.time) < from_ms * 1_000_000 or height == 1)
        if complete:
            common = dict(source="trusted-gateway", from_height=height, through_height=through_height,
                          anchor=anchor, blocks=list(reversed(blocks)))
            return BlockResultsWindow(**common, from_ms=from_ms, to_ms=to_ms) if window else BlockResultsRange(**common)
        next_header = header
    _fail("height budget", "limit")
