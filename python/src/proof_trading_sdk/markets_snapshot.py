"""Atomic, chain-bound read of every market, event and per-market open interest."""

from __future__ import annotations

import typing as t
from dataclasses import dataclass

from proof_trading_sdk._native import decode_markets_snapshot as _decode_native
from proof_trading_sdk.errors import CodecError


@dataclass(frozen=True)
class MarketOpenInterest:
    """One market's open interest, in base-asset units per side."""

    market: int
    long: int
    short: int


@dataclass(frozen=True)
class MarketsSnapshot:
    chain_id: bytes
    height: int
    #: Market configurations, in the shape :meth:`ExchangeClient.markets` returns.
    markets: list[dict[str, t.Any]]
    #: Every event with its binaries and its attached conditionals.
    events: list[dict[str, t.Any]]
    #: Long and short open interest per market that has had positions, in
    #: ascending market order; a market missing from the list has none.
    #: ``None`` when the node does not serve open interest.
    open_interest: list[MarketOpenInterest] | None


def _market(raw: dict[str, t.Any]) -> dict[str, t.Any]:
    kind = raw["kind"]
    if isinstance(kind, dict):
        ((variant, fields),) = kind.items()
        kind = {variant: [fields["event_id"], fields["branch"]]}
    signer = raw["primary_oracle_signer"]
    return {
        **raw,
        "kind": kind,
        "primary_oracle_signer": None if signer is None else bytes(signer),
    }


def decode_markets_snapshot(body: bytes, chain_id: bytes) -> MarketsSnapshot:
    """Decode a complete ``GET /v1/markets-snapshot`` response body bound to
    ``chain_id``. Any fault refuses the whole read with :class:`CodecError`."""
    try:
        raw = _decode_native(body, chain_id)
    except ValueError as e:
        raise CodecError(f"markets snapshot: {e}") from e
    open_interest = raw["open_interest"]
    return MarketsSnapshot(
        chain_id=raw["chain_id"],
        height=raw["height"],
        markets=[_market(m) for m in raw["markets"]],
        events=raw["events"],
        open_interest=(
            None
            if open_interest is None
            else [MarketOpenInterest(**row) for row in open_interest]
        ),
    )
