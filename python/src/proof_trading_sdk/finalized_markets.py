"""Witnessed market facts; consistency checks do not authenticate consensus."""
from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
import json
import typing as t

from proof_trading_sdk._native import MAX_BOOK_BYTES, decode_finalized_orderbook as _decode_book
from proof_trading_sdk.errors import CodecError, GatewayReadError
from proof_trading_sdk.evidence import FinalizedReadWitness, decode_finalized_read_witness, _chain_pin, _SAFE_INTEGER
from proof_trading_sdk.markets_snapshot import MarketsSnapshot, decode_markets_snapshot


@dataclass(frozen=True)
class FinalizedOrderbookLevel:
    price: int
    total_qty: int
    order_count: int


@dataclass(frozen=True)
class FinalizedOrderbook:
    market: int
    depth: int
    height: int
    bids: list[FinalizedOrderbookLevel]
    asks: list[FinalizedOrderbookLevel]
    witness: FinalizedReadWitness


@dataclass(frozen=True)
class FinalizedMarketsSnapshot(MarketsSnapshot):
    witness: FinalizedReadWitness


def orderbook_request(market: int, depth: int) -> None:
    if type(market) is not int or not 1 <= market <= 0xffff_ffff:
        raise GatewayReadError("malformed", "orderbook.market")
    if type(depth) is not int or depth not in (1, 20, 100):
        raise GatewayReadError("malformed", "orderbook.depth")


def decode_finalized_orderbook(value: t.Any, market: int, depth: int = 20) -> FinalizedOrderbook:
    orderbook_request(market, depth)
    if not isinstance(value, dict):
        raise GatewayReadError("malformed", "orderbook.frame")
    if value.get("market") != str(market) or value.get("depth") != str(depth):
        raise GatewayReadError("binding", "orderbook.market/depth")
    height = value.get("height")
    if type(height) is float and height.is_integer() and abs(height) <= _SAFE_INTEGER:
        height = int(height)
    if type(height) is not int or not 1 <= height <= _SAFE_INTEGER:
        raise GatewayReadError("malformed", "orderbook.height")
    encoded = value.get("bookMsgpackB64")
    if not isinstance(encoded, str):
        raise GatewayReadError("malformed", "orderbook.base64")
    if "data" in value and encoded != value["data"]:
        raise GatewayReadError("binding", "orderbook.encoding")
    if not isinstance(encoded, str) or not encoded or len(encoded) > 4*((MAX_BOOK_BYTES+2)//3):
        raise GatewayReadError("malformed", "orderbook.base64")
    try:
        payload = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as err:
        raise GatewayReadError("malformed", "orderbook.base64") from err
    if len(payload) > MAX_BOOK_BYTES or base64.b64encode(payload).decode("ascii") != encoded:
        raise GatewayReadError("malformed", "orderbook.base64")
    try:
        book = _decode_book(payload, depth)
    except ValueError as err:
        raise GatewayReadError("malformed", "orderbook.msgpack") from err
    witness = decode_finalized_read_witness(value.get("witness"), expected_height=height)
    def levels(rows):
        return [FinalizedOrderbookLevel(row["price"], row["total_quantity"], row["order_count"]) for row in rows]
    return FinalizedOrderbook(market, depth, height, levels(book["bids"]), levels(book["asks"]), witness)


def decode_finalized_markets_snapshot(value: t.Any, *, chain_id: str | bytes) -> FinalizedMarketsSnapshot:
    """Bind the existing canonical snapshot and its witness to an explicit chain pin."""
    chain = _chain_pin(chain_id)
    if not isinstance(value, dict):
        raise GatewayReadError("malformed", "market snapshot envelope")
    try:
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        snapshot = decode_markets_snapshot(body, chain)
    except (TypeError, ValueError, UnicodeError, RecursionError, CodecError) as err:
        binding = str(err) in {
            "markets snapshot: market snapshot refused: WrongChain",
            "markets snapshot: market snapshot refused: Uncommitted",
        }
        raise GatewayReadError("binding" if binding else "malformed", "market snapshot", str(err)) from err
    witness = decode_finalized_read_witness(value.get("witness"), expected_height=snapshot.height)
    return FinalizedMarketsSnapshot(**vars(snapshot), witness=witness)
