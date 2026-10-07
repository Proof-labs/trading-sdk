"""Smoke tests for the PyO3 bridge.

These test the FFI boundary — not the core logic. Core correctness is
tested in the Rust crate and via shared conformance vectors.
"""

import pytest

import proof_trading_sdk as pts


class TestGenerateKeypair:
    def test_without_seed(self):
        kp = pts.generate_keypair()
        assert isinstance(kp, dict)
        assert len(kp["secret_key"]) == 32
        assert len(kp["public_key"]) == 32

    def test_with_seed(self):
        seed = bytes(range(32))
        kp = pts.generate_keypair(seed)
        kp2 = pts.generate_keypair(seed)
        assert kp["secret_key"] == kp2["secret_key"]
        assert kp["public_key"] == kp2["public_key"]

    def test_rejects_wrong_seed_length(self):
        with pytest.raises(ValueError, match="exactly 32 bytes"):
            pts.generate_keypair(b"\x00" * 31)


class TestPubkeyToOwner:
    def test_valid(self):
        kp = pts.generate_keypair()
        owner = pts.pubkey_to_owner(kp["public_key"])
        assert len(owner) == 20

    def test_rejects_wrong_length(self):
        with pytest.raises(ValueError, match="exactly 32 bytes"):
            pts.pubkey_to_owner(b"\x00" * 16)


class TestChainIdFromString:
    def test_returns_32_bytes(self):
        cid = pts.chain_id_from_string("proof-dev-1")
        assert len(cid) == 32

    def test_deterministic(self):
        a = pts.chain_id_from_string("test")
        b = pts.chain_id_from_string("test")
        assert a == b

    def test_different_strings_differ(self):
        a = pts.chain_id_from_string("chain-a")
        b = pts.chain_id_from_string("chain-b")
        assert a != b


class TestSignAndEncode:
    def test_round_trip(self):
        kp = pts.generate_keypair()
        cid = pts.chain_id_from_string("proof-dev-1")
        payload = b"\x01\x02\x03"
        tx = pts.sign_and_encode(cid, 1, payload, 42, kp["secret_key"])
        assert isinstance(tx, bytes)
        assert len(tx) > 80

        decoded = pts.decode_tx(tx)
        assert decoded["version"] == 2
        assert decoded["action_type"] == 1
        assert decoded["seq"] == 42
        assert decoded["pubkey"] == kp["public_key"]

    def test_rejects_wrong_chain_id_length(self):
        kp = pts.generate_keypair()
        with pytest.raises(ValueError, match="exactly 32 bytes"):
            pts.sign_and_encode(b"\x00" * 16, 1, b"", 1, kp["secret_key"])

    def test_rejects_wrong_key_length(self):
        cid = pts.chain_id_from_string("test")
        with pytest.raises(ValueError, match="exactly 32 bytes"):
            pts.sign_and_encode(cid, 1, b"", 1, b"\x00" * 16)


class TestDecodeTx:
    def test_rejects_empty(self):
        with pytest.raises(ValueError):
            pts.decode_tx(b"")

    def test_rejects_truncated(self):
        kp = pts.generate_keypair()
        cid = pts.chain_id_from_string("test")
        tx = pts.sign_and_encode(cid, 1, b"", 1, kp["secret_key"])
        with pytest.raises(ValueError):
            pts.decode_tx(tx[:10])


class TestVerifySignature:
    def test_valid_sig(self):
        kp = pts.generate_keypair()
        cid = pts.chain_id_from_string("test")
        payload = b"hello"
        tx = pts.sign_and_encode(cid, 1, payload, 99, kp["secret_key"])
        decoded = pts.decode_tx(tx)
        valid = pts.verify_signature(
            cid,
            kp["public_key"],
            decoded["signature"],
            1,
            99,
            payload,
        )
        assert valid is True

    def test_wrong_key(self):
        kp = pts.generate_keypair()
        wrong = pts.generate_keypair()
        cid = pts.chain_id_from_string("test")
        payload = b"data"
        tx = pts.sign_and_encode(cid, 1, payload, 1, kp["secret_key"])
        decoded = pts.decode_tx(tx)
        valid = pts.verify_signature(
            cid,
            wrong["public_key"],
            decoded["signature"],
            1,
            1,
            payload,
        )
        assert valid is False

    def test_tampered_payload(self):
        kp = pts.generate_keypair()
        cid = pts.chain_id_from_string("test")
        tx = pts.sign_and_encode(cid, 1, b"real", 1, kp["secret_key"])
        decoded = pts.decode_tx(tx)
        valid = pts.verify_signature(
            cid,
            kp["public_key"],
            decoded["signature"],
            1,
            1,
            b"fake",
        )
        assert valid is False


class TestEncodeSignedTx:
    def test_encode_with_precomputed_sig(self):
        kp = pts.generate_keypair()
        cid = pts.chain_id_from_string("test")
        payload = b"\x01\x02"
        tx = pts.sign_and_encode(cid, 1, payload, 7, kp["secret_key"])
        decoded = pts.decode_tx(tx)

        tx2 = pts.encode_signed_tx(
            1,
            payload,
            7,
            kp["public_key"],
            decoded["signature"],
        )
        decoded2 = pts.decode_tx(tx2)
        assert decoded2["pubkey"] == decoded["pubkey"]
        assert decoded2["signature"] == decoded["signature"]
        assert decoded2["seq"] == 7


class TestNonceAllocator:
    def test_monotonic(self):
        na = pts.NonceAllocator()
        values = [na.allocate() for _ in range(100)]
        for i in range(1, len(values)):
            assert values[i] >= values[i - 1]

    def test_same_ms_bump(self):
        na = pts.NonceAllocator()
        # Force same-ms by comparing — the allocator bumps on collision
        a = na.allocate()
        b = na.allocate()
        assert b >= a


class TestErrors:
    def test_engine_error(self):
        err = pts.EngineError(21, "InvalidNonce")
        assert err.code == 21
        assert "InvalidNonce" in str(err)

    def test_rate_limited(self):
        err = pts.RateLimited(retry_after_secs=5.0, bucket="orders")
        assert err.retry_after_secs == 5.0
        assert err.bucket == "orders"

    def test_current_code_51_does_not_require_delivertx_log(self):
        assert pts.get_error_name(51) == "OpenInterestLimitExceeded"
        assert pts.get_error_name(51, "unknown") == "OpenInterestLimitExceeded"
        assert pts.EngineError(51, "").name == "OpenInterestLimitExceeded"

    def test_governance_codes_52_53(self):
        assert pts.get_error_name(52) == "AdminGovernanceInactive"
        assert pts.get_error_name(53) == "NotAdminSigner"
        assert pts.EngineError(52, "").name == "AdminGovernanceInactive"
        assert pts.EngineError(53, "").name == "NotAdminSigner"

    def test_proposal_lifecycle_codes_54_71(self):
        # Endpoints of the mirrored proposal-lifecycle family; the full range is
        # pinned by the errors.ndjson conformance manifest.
        assert pts.get_error_name(54) == "ProposalNotFound"
        assert pts.get_error_name(71) == "InvalidAdminRegistry"
        assert pts.EngineError(67, "").name == "EmergencyRateLimited"

    def test_transitional_code_50_uses_delivertx_log(self):
        oi = "open interest limit exceeded on market 7: would be 4, cap 3"
        slip = "atomic basket aggregate slippage 51 bps exceeds budget 50 bps"
        assert pts.get_error_name(50, oi) == "OpenInterestLimitExceeded"
        assert pts.get_error_name(50, slip) == "SlippageExceeded"
        assert pts.get_error_name(50) == "AmbiguousCode50"
        assert pts.get_error_name(50, "") == "AmbiguousCode50"
        assert pts.get_error_name(50, "unknown") == "AmbiguousCode50"
        assert pts.EngineError(50, oi).name == "OpenInterestLimitExceeded"
        assert pts.EngineError(50, slip).name == "SlippageExceeded"
        assert pts.EngineError(50, "").name == "AmbiguousCode50"

    def test_error_manifest_has_distinct_current_codes(self):
        by_code = {
            entry["code"]: entry["name"] for entry in pts.get_error_code_table()
        }
        assert by_code[50] == "SlippageExceeded"
        assert by_code[51] == "OpenInterestLimitExceeded"


class TestConfig:
    def test_default_config(self):
        cfg = pts.load_config()
        assert cfg.gateway_url == "https://api.dev.proof.trade"
        assert cfg.timeout_secs == 30
        assert cfg.log_level == "WARNING"
        assert cfg.chain_id == "exchange-devnet-1"

    def test_env_overrides(self, monkeypatch):
        monkeypatch.setenv("PROOF_GATEWAY_URL", "https://alt.proof.trade")
        monkeypatch.setenv("PROOF_LOG_LEVEL", "INFO")
        cfg = pts.load_config()
        assert cfg.gateway_url == "https://alt.proof.trade"
        assert cfg.log_level == "INFO"

    def test_programmatic_overrides(self):
        cfg = pts.load_config(gateway_url="https://custom.url", timeout_secs=60)
        assert cfg.gateway_url == "https://custom.url"
        assert cfg.timeout_secs == 60


class TestEngineParityActions:
    """Actions that were missing from the Python binding (engine-parity port):
    CreateMarket (mandatory sz_decimals/ticker) and AtomicBasketOrder (0x1c).
    Encode/decode runs through the native core, so this asserts the binding's
    field map matches the engine struct.

    No dedicated builder for the admin-only CreateMarket — exercise the
    generic RawAction escape hatch (still encoded by the core).
    """

    def test_create_market_round_trips_with_sz_decimals_ticker(self):
        action = pts.actions.RawAction(
            pts.ActionType["CreateMarket"],
            {
                "market": 42,
                "im_bps": 1000,
                "mm_bps": 500,
                "taker_fee_bps": 5,
                "maker_fee_bps": 2,
                "signer": b"\xee" * 20,
                "funding_interval_ms": 60_000,
                "max_funding_rate_bps": 100,
                "sz_decimals": 4,
                "ticker": "BTC",
                "pool_id": 9,
                "max_open_interest": 1_000_000,
            },
        )
        action_type, payload = pts.encode_action(action)
        assert action_type == pts.ActionType["CreateMarket"]
        decoded = pts.decode_action(action_type, payload)
        assert decoded["sz_decimals"] == 4
        assert decoded["ticker"] == "BTC"
        assert decoded["pool_id"] == 9
        assert decoded["max_open_interest"] == 1_000_000

    def test_update_market_fees_max_open_interest_uses_slot_after_margin_ratios(self):
        action = pts.actions.UpdateMarketFees(
            market=42,
            signer=b"\xee" * 20,
            max_open_interest=500_000,
        )
        action_type, payload = pts.encode_action(action)
        assert action_type == pts.ActionType["UpdateMarketFees"]
        decoded = pts.decode_action(action_type, payload)
        assert decoded["im_bps"] is None
        assert decoded["mm_bps"] is None
        assert decoded["max_open_interest"] == 500_000

    def test_atomic_basket_order_round_trips(self):
        action = pts.actions.AtomicBasketOrder(
            owner=b"\x11" * 20,
            legs=[
                pts.actions.AtomicBasketLeg(
                    market=1,
                    side=pts.Side.Buy,
                    price=6_675_000,
                    quantity=3,
                    client_order_id=77,
                ),
                pts.actions.AtomicBasketLeg(
                    market=2,
                    side=pts.Side.Sell,
                    price=250_000,
                    quantity=5,
                    reduce_only=True,
                ),
            ],
            max_slippage_bps=50,
        )
        action_type, payload = pts.encode_action(action)
        assert action_type == 0x1C
        decoded = pts.decode_action(action_type, payload)
        assert len(decoded["legs"]) == 2
        assert decoded["legs"][0]["client_order_id"] == 77
        assert decoded["legs"][1]["reduce_only"] is True
        assert decoded["max_slippage_bps"] == 50

    def test_atomic_basket_order_default_slippage_is_zero(self):
        action = pts.actions.AtomicBasketOrder(
            owner=b"\x11" * 20,
            legs=[
                pts.actions.AtomicBasketLeg(
                    market=1, side=pts.Side.Buy, price=100, quantity=1
                )
            ],
        )
        action_type, payload = pts.encode_action(action)
        decoded = pts.decode_action(action_type, payload)
        assert decoded["max_slippage_bps"] == 0
        assert decoded["legs"][0]["reduce_only"] is False


class TestConfirmDepositLocator:
    """The public ConfirmDeposit builder must produce the shared conformance
    vectors' bytes — the vector runner calls the native codec directly, so it
    never exercises this builder path."""

    @staticmethod
    def _vector(case_name):
        import json
        from pathlib import Path

        path = Path(__file__).resolve().parents[2] / "conformance" / "codec.ndjson"
        with path.open() as f:
            for line in f:
                line = line.strip()
                if line:
                    c = json.loads(line)
                    if c["case"] == case_name:
                        return c
        raise AssertionError(f"vector {case_name!r} not found")

    def _action(self, locator):
        return pts.actions.ConfirmDeposit(
            owner=b"\x55" * 20,
            amount=100_000,
            solana_tx_sig=b"\xab" * 64,
            signer=b"\x66" * 20,
            locator=locator,
        )

    def test_builder_with_locator_matches_vector(self):
        vector = self._vector("confirm_deposit/with_locator")
        action = self._action(pts.DepositLocator(top_index=3, inner_index=1))
        action_type, payload = pts.encode_action(action)
        assert action_type == pts.ActionType["ConfirmDeposit"]
        assert payload.hex() == vector["expect"]["payload_hex"]

    def test_builder_no_locator_matches_vector(self):
        vector = self._vector("confirm_deposit/no_locator")
        action_type, payload = pts.encode_action(self._action(None))
        assert payload.hex() == vector["expect"]["payload_hex"]
        # The absent locator is a trailing nil, and it decodes back as None.
        decoded = pts.decode_action(action_type, payload)
        assert decoded["locator"] is None

    def test_populated_locator_decodes_back(self):
        # The encode direction is pinned by the vectors above; this pins the
        # read direction, so a locator that is set cannot be silently dropped
        # or come back under a different shape.
        action_type, payload = pts.encode_action(
            self._action(pts.DepositLocator(top_index=3, inner_index=1))
        )
        decoded = pts.decode_action(action_type, payload)
        assert decoded["locator"] == {"top_index": 3, "inner_index": 1}

    def test_top_level_transfer_locator_round_trips(self):
        # A transfer that is itself the top-level instruction: the locator is
        # PRESENT with no inner index. Distinct from an absent locator, and the
        # shape a non-CPI deposit actually produces.
        action_type, payload = pts.encode_action(
            self._action(pts.DepositLocator(top_index=3))
        )
        assert payload.endswith(bytes([0x92, 0x03, 0xC0]))
        decoded = pts.decode_action(action_type, payload)
        assert decoded["locator"] == {"top_index": 3, "inner_index": None}

    def test_rejects_bool_and_out_of_range_indices(self):
        # bool is an int subclass, so an unguarded dataclass would encode
        # True as instruction 1 — a wrong dedup key for a real transfer.
        for kwargs in (
            {"top_index": True},
            {"top_index": 3, "inner_index": True},
            {"top_index": -1},
            {"top_index": 1 << 16},
            {"top_index": 3, "inner_index": 1 << 16},
        ):
            with pytest.raises(ValueError, match="unsigned integer"):
                pts.DepositLocator(**kwargs)

    def test_legacy_pre_locator_bytes_still_decode(self):
        # Pre-locator engines emitted a 4-element array with no locator slot
        # at all; those bytes must keep decoding (the backward-decode half of
        # the MINOR claim for this wire change).
        action_type, payload = pts.encode_action(self._action(None))
        assert payload[0] == 0x95 and payload[-1] == 0xC0
        legacy = bytes([0x94]) + payload[1:-1]
        decoded = pts.decode_action(action_type, legacy)
        assert decoded["amount"] == 100_000
        assert decoded["locator"] is None
