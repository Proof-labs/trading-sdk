"""Reconcile one eager perpetual-funding settlement using public SDK reads.

The position side, size and last index must come from a preserved pre-settlement
position. This example compares full accrued funding with the committed cash
payment; partial/deferred debt can legitimately make them differ.
"""

from __future__ import annotations

import argparse
import json
from typing import Any

from proof_trading_sdk import ExchangeClient, SdkConfig

FUNDING_SCALE = 1_000_000


def _integer(value: Any, name: str, low: int, high: int) -> int:
    if isinstance(value, str) and value and value.removeprefix("-").isdigit():
        value = int(value)
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f"{name} must be an integer in {low}..{high}")
    return value


def accrued_payment(side: str, raw_size: int, last_index: int, cumulative_index: int,
                    sz_decimals: int) -> int:
    """Signed micro-USDC owed/receivable, before cash/reserve/debt constraints."""
    if side not in ("Buy", "Sell"):
        raise ValueError("side must be Buy (long) or Sell (short)")
    size = _integer(raw_size, "raw_size", 0, (1 << 64) - 1)
    last = _integer(last_index, "last_index", -(1 << 63), (1 << 63) - 1)
    current = _integer(cumulative_index, "cumulative_index", -(1 << 63), (1 << 63) - 1)
    decimals = _integer(sz_decimals, "sz_decimals", 0, 18)
    owed = (current - last) * size
    # The engine checks its 128-bit intermediate before applying the side.
    _integer(owed, "funding intermediate", -(1 << 127), (1 << 127) - 1)
    received = -owed if side == "Buy" else owed
    _integer(received, "signed funding intermediate", -(1 << 127), (1 << 127) - 1)
    # Python // is floor division, matching Rust div_euclid for positive divisors.
    payment = received // FUNDING_SCALE // (10 ** decimals)
    return _integer(payment, "payment", -(1 << 63), (1 << 63) - 1)


def _event_attributes(event: dict[str, Any]) -> dict[str, str]:
    attributes = event.get("attributes")
    if not isinstance(attributes, list):
        raise ValueError("missing event attributes")
    result: dict[str, str] = {}
    for attribute in attributes:
        if not isinstance(attribute, dict):
            raise ValueError("invalid event attribute")
        key, value = attribute.get("key"), attribute.get("value")
        if not isinstance(key, str) or not isinstance(value, str) or key in result:
            raise ValueError("invalid or duplicate event attribute")
        result[key] = value
    return result


def reconcile(client: ExchangeClient, *, height: int, market: int, owner: str,
              side: str, raw_size: int, last_index: int) -> dict[str, Any]:
    height = _integer(height, "height", 1, (1 << 63) - 1)
    market = _integer(market, "market", 0, (1 << 32) - 1)
    owner = owner.lower().removeprefix("0x")
    if len(owner) != 40 or any(c not in "0123456789abcdef" for c in owner):
        raise ValueError("owner must be a 20-byte hex address")
    configs = [row for row in client.markets() if row.get("market") == market]
    if len(configs) != 1 or configs[0].get("kind") != "Perp":
        raise ValueError("expected one perpetual market config")
    # Mandatory here: missing/legacy-unknown scale must never become zero.
    decimals = _integer(configs[0].get("sz_decimals"), "sz_decimals", 0, 18)
    body = client.get_block_results(height)
    result = body.get("result")
    if not isinstance(result, dict) or _integer(result.get("height"), "response height", 1, (1 << 63) - 1) != height:
        raise ValueError("block results do not match the requested height")
    events = result.get("finalize_block_events")
    if not isinstance(events, list):
        raise ValueError("missing finalize_block_events")
    applied, settled = [], []
    for event in events:
        if not isinstance(event, dict):
            raise ValueError("invalid block event")
        kind = event.get("type")
        if kind not in ("funding_applied", "funding_settled"):
            continue
        attrs = _event_attributes(event)
        if _integer(attrs.get("market"), "event market", 0, (1 << 32) - 1) != market:
            continue
        if kind == "funding_applied":
            applied.append(attrs)
        elif attrs.get("owner") == owner:
            settled.append(attrs)
    if len(applied) != 1 or len(settled) != 1:
        raise ValueError("expected one funding application and one owner settlement; missing is not zero")
    cumulative = _integer(applied[0].get("cumulative_funding"), "cumulative_funding", -(1 << 63), (1 << 63) - 1)
    rate = _integer(applied[0].get("funding_rate_bps"), "funding_rate_bps", -3000, 3000)
    observed = _integer(settled[0].get("payment"), "settled payment", -(1 << 63), (1 << 63) - 1)
    expected = accrued_payment(side, raw_size, last_index, cumulative, decimals)
    return {
        "height": height, "market": market, "sz_decimals": decimals,
        "cumulative_funding": cumulative, "funding_rate_bps": rate,
        "full_accrued_payment_micro_usdc": expected,
        "settled_payment_micro_usdc": observed,
        "full_payment_matches_event": expected == observed,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gateway-url", default="https://api.dev.proof.trade")
    parser.add_argument("--chain-id", default="exchange-devnet-1")
    parser.add_argument("--height", type=int, required=True)
    parser.add_argument("--market", type=int, required=True)
    parser.add_argument("--owner", required=True)
    parser.add_argument("--side", choices=("Buy", "Sell"), required=True)
    parser.add_argument("--raw-size", type=int, required=True)
    parser.add_argument("--last-index", type=int, required=True)
    args = parser.parse_args()
    client = ExchangeClient(config=SdkConfig(
        gateway_url=args.gateway_url, chain_id=args.chain_id, api_key="",
    ))
    try:
        network = client.status()["result"]["node_info"]["network"]
        if network != args.chain_id:
            raise ValueError("gateway chain does not match --chain-id")
        report = reconcile(client, height=args.height, market=args.market, owner=args.owner,
                           side=args.side, raw_size=args.raw_size, last_index=args.last_index)
        print(json.dumps(report, indent=2))
    finally:
        client.close()


if __name__ == "__main__":
    main()
