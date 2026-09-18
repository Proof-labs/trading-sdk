"""Pins ``admin_proposal_content_hash`` (PyO3 → Rust core) to the exchange
engine's own golden content hashes — the same two vectors the core's
``content_hash_matches_engine_golden_vectors`` test pins. If the Python enum
mapping, the hash preimage, or the canonical action bytes drift, these fail.
"""

import pytest

import proof_trading_sdk as pts

GOLDEN_V3 = "6cdd8d6843bb4026d396b9e80c9599530b0ac4f14862af0204794219f8f8cbea"
GOLDEN_V4 = "5fe2dd718a4aea63492a5ab95eee27588cc861c504643bf68ce3fdd2c45dab99"
# Admin-actions v2 (engine's ``admin_proposal_content_hash_v2_golden_vectors``)
GOLDEN_ATTACH = "3ffeb7f420cf9f4f50bade95919d885dfc590c7f8c92fb69eacc1704d4662be4"
GOLDEN_BATCH = "c099245946aaded3b995198f5ff0592d771729ab314fcf5736036ffb6f559fcd"
# The one admin action that is NOT a map: a fieldless unit variant, whose
# canonical bytes are the bare fixstr "UnpauseBridge". exchange-core has no
# frozen content-hash vector for this arm yet, so the value comes from the
# authority itself -- exchange-wire's own ``codec::admin_proposal_content_hash``
# at the revision pinned in crates/proof-trading-sdk/Cargo.toml. The TypeScript
# suite pins the identical constant, which is what makes the two bindings
# provably agree on the unit-variant shape.
GOLDEN_UNPAUSE_BRIDGE = (
    "ffa74c9323512ffb8272eea55fc49baf047f55aa8979e56e06229b57d1350f56"
)
# CancelAllOrdersForAccount (inner tag 0x08): a struct variant carrying a
# 20-byte newtype address and an Option market, over the same golden
# context. Same authority as above; the TypeScript suite pins the identical
# constant.
GOLDEN_CANCEL_ALL_FOR_ACCOUNT = (
    "39ededb641adc0e8b9c8f2f0c77fdeb2cc1880b7b882e6d91912535bfd27465e"
)
# The unscoped twin (market None), pinned in TypeScript too: covers the
# pythonize None -> Option path.
GOLDEN_CANCEL_ALL_FOR_ACCOUNT_UNSCOPED = (
    "4b9e5c528f5bf4578427fcb42018f3df7ce3239e4a3392c8e087230d5bb3358c"
)



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


def engine_v2_attach() -> dict:
    """Mirrors the engine's attach fixture: event 91's conditional on perp 15,
    books from 9100, the open-interest trailer at its zero default."""
    return {
        "event_id": 91,
        "underlying_market": 15,
        "child_market_base": 9_100,
        "im_bps": 3334,
        "mm_bps": 1667,
        "taker_fee_bps": 5,
        "maker_fee_bps": 2,
        "signer": bytes(20),
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

    def test_reproduces_engine_attach_hash(self):
        kwargs = golden_kwargs()
        kwargs["action"] = {"AttachConditional": engine_v2_attach()}
        h = pts.admin_proposal_content_hash(**kwargs)
        assert h.hex() == GOLDEN_ATTACH

    def test_reproduces_engine_v2_batch_hash(self):
        # Exercises the whole nested-enum path: the Batch arm's list
        # payload, both item variants, and the attachment trailer.
        kwargs = golden_kwargs()
        kwargs["action"] = {
            "Batch": [
                {
                    "CreateMarket": {
                        **engine_default_create_market(),
                        "market": 15,
                    }
                },
                {"AttachConditional": engine_v2_attach()},
            ]
        }
        h = pts.admin_proposal_content_hash(**kwargs)
        assert h.hex() == GOLDEN_BATCH

    def test_reproduces_unit_variant_hash(self):
        # A unit variant is passed as the bare variant-name string, not a map.
        # This is the only arm exercising that shape, and the content hash is
        # what an approving client recomputes before signing -- if the bare
        # string did not reach the core correctly, every legitimate
        # UnpauseBridge approval would be refused.
        kwargs = golden_kwargs()
        kwargs["action"] = "UnpauseBridge"
        h = pts.admin_proposal_content_hash(**kwargs)
        assert h.hex() == GOLDEN_UNPAUSE_BRIDGE

    def test_cancel_all_orders_for_account_hash(self):
        kwargs = golden_kwargs()
        kwargs["action"] = {
            "CancelAllOrdersForAccount": {"owner": bytes([0xC1] * 20), "market": 7}
        }
        h = pts.admin_proposal_content_hash(**kwargs)
        assert h.hex() == GOLDEN_CANCEL_ALL_FOR_ACCOUNT

    def test_cancel_all_orders_for_account_unscoped_hash(self):
        kwargs = golden_kwargs()
        kwargs["action"] = {
            "CancelAllOrdersForAccount": {"owner": bytes([0xC1] * 20), "market": None}
        }
        h = pts.admin_proposal_content_hash(**kwargs)
        assert h.hex() == GOLDEN_CANCEL_ALL_FOR_ACCOUNT_UNSCOPED

    def test_rejects_unknown_unit_variant(self):
        kwargs = golden_kwargs()
        kwargs["action"] = "NotAnAdminAction"
        with pytest.raises(ValueError, match="AdminAction"):
            pts.admin_proposal_content_hash(**kwargs)

    def test_rejects_malformed_proposer(self):
        kwargs = golden_kwargs()
        kwargs["proposer"] = bytes([0x22]) * 19
        with pytest.raises(ValueError, match="proposer"):
            pts.admin_proposal_content_hash(**kwargs)
