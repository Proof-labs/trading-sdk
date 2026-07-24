"""Pins ``admin_proposal_content_hash`` (PyO3 → Rust core) to the exchange
engine's own golden content hashes — the same two vectors the core's
``content_hash_matches_engine_golden_vectors`` test pins. If the Python enum
mapping, the hash preimage, or the canonical action bytes drift, these fail.
"""

import pytest

import proof_trading_sdk as pts

GOLDEN_V3 = "6cdd8d6843bb4026d396b9e80c9599530b0ac4f14862af0204794219f8f8cbea"
GOLDEN_V4 = "5fe2dd718a4aea63492a5ab95eee27588cc861c504643bf68ce3fdd2c45dab99"


def engine_default_create_market() -> dict:
    """Mirrors ``exchange-core``'s ``impl Default for CreateMarket`` — the
    instance the engine's golden-vector test hashes. The non-zero fee/funding
    defaults are load-bearing (the hash commits the full canonical bytes)."""
    return {
        "market": 0,
        "im_bps": 3334,
        "mm_bps": 1667,
        "taker_fee_bps": 5,
        "maker_fee_bps": 2,
        "signer": bytes(20),
        "funding_interval_ms": 60_000,
        "max_funding_rate_bps": 3000,
        "pool_id": 0,
        "sz_decimals": 0,
        "ticker": "",
        "max_open_interest": 0,
    }


def golden_kwargs(registry_version: int = 3) -> dict:
    return {
        "chain_id": bytes([0x11]) * 32,
        "proposal_id": 42,
        "registry_version": registry_version,
        "threshold": 2,
        "proposer": bytes([0x22]) * 20,
        "created_height": 7,
        "created_ms": 1_000,
        "expiry_ms": 259_201_000,
        "action": {"CreateMarket": engine_default_create_market()},
    }


class TestAdminProposalContentHash:
    def test_reproduces_engine_golden_hash(self):
        h = pts.admin_proposal_content_hash(**golden_kwargs())
        assert h.hex() == GOLDEN_V3

    def test_single_field_sensitivity(self):
        h = pts.admin_proposal_content_hash(**golden_kwargs(registry_version=4))
        assert h.hex() == GOLDEN_V4

    def test_rejects_malformed_proposer(self):
        kwargs = golden_kwargs()
        kwargs["proposer"] = bytes([0x22]) * 19
        with pytest.raises(ValueError, match="proposer"):
            pts.admin_proposal_content_hash(**kwargs)
