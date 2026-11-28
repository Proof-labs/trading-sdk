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

    def test_rejects_trailing_bytes(self):
        kp = pts.generate_keypair()
        cid = pts.chain_id_from_string("test")
        tx = pts.sign_and_encode(cid, 1, b"", 1, kp["secret_key"])
        with pytest.raises(ValueError, match="malformed"):
            pts.decode_tx(tx + b"\x00")


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

    def test_market_settings_changed_code_155(self):
        # A quorum UpdateMarketFees whose market's settings sequence moved.
        assert pts.get_error_name(155) == "MarketSettingsChanged"
        assert pts.EngineError(155, "").name == "MarketSettingsChanged"

    def test_proposal_lifecycle_codes_54_71(self):
        # Endpoints of the mirrored proposal-lifecycle family; the full range is
        # pinned by the errors.ndjson conformance manifest.
        assert pts.get_error_name(54) == "ProposalNotFound"
        assert pts.get_error_name(71) == "InvalidAdminRegistry"
        assert pts.EngineError(67, "").name == "EmergencyRateLimited"

    def test_off_curve_withdrawal_destination_code_135(self):
        # A withdrawal to an off-curve Solana destination.
        assert pts.get_error_name(135) == "OffCurveWithdrawalDestination"
        assert pts.EngineError(135, "").name == "OffCurveWithdrawalDestination"

    def test_reduce_only_refused_and_codes_136_142(self):
        # proof-wire after 12.1.0: code 35 covers both reduce-only refusals, and
        # 136-142 name the trigger, position and capacity refusals.
        assert pts.get_error_name(35) == "ReduceOnlyRefused"
        for code, name in [
            (136, "PositionEpochMismatch"),
            (137, "TriggerBracketNotFound"),
            (138, "TriggerAlreadyCrossed"),
            (139, "PositionNotFound"),
            (140, "AccountPositionCapReached"),
            (141, "SubAccountCapReached"),
            (142, "WorkCapReached"),
        ]:
            assert pts.get_error_name(code) == name
            assert pts.EngineError(code, "").name == name

    def test_bridge_vote_codes_143_157(self):
        # The bridge refusals; 91, 128, 129 and 152 are unassigned.
        for code, name in [
            (143, "UserImAboveNotional"),
            (144, "BridgePaused"),
            (145, "WithdrawalPayoutCleared"),
            (146, "BridgeVoteInvalid"),
            (147, "BridgeUnauthorizedOperator"),
            (148, "BridgePayoutReportInvalid"),
            (149, "WithdrawalQuarantined"),
            (150, "WithdrawalPayoutSlotOccupied"),
            (151, "DepositReceiptLimitExceeded"),
            (153, "OwnerPendingWithdrawalsFull"),
            (154, "PayoutRecordedForAnotherWithdrawal"),
        ]:
            assert pts.get_error_name(code) == name
            assert pts.EngineError(code, "").name == name
        for code in (91, 128, 129, 152):
            assert pts.get_error_name(code) is None

    def test_transitional_code_50_uses_delivertx_log(self):
        oi = "open interest limit exceeded on market 7: would be 4, cap 3"
        slip = "atomic basket aggregate slippage 51 bps exceeds budget 50 bps"
        assert pts.get_error_name(50, oi) == "OpenInterestLimitExceeded"
        assert pts.get_error_name(50, slip) == "SlippageExceeded"
        assert pts.get_error_name(50) == "SlippageExceeded"
        assert pts.get_error_name(50, "") == "SlippageExceeded"
        assert pts.get_error_name(50, "unknown") == "SlippageExceeded"
        assert pts.EngineError(50, oi).name == "OpenInterestLimitExceeded"
        assert pts.EngineError(50, slip).name == "SlippageExceeded"
        assert pts.EngineError(50, "").name == "SlippageExceeded"

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

    CreateMarket is an admin action only, proposed through the quorum; the
    single-key byte 0x07 is retired. Exercise it through the generic
    RawAction escape hatch (still encoded by the core).
    """

    @staticmethod
    def _propose(action: dict) -> dict:
        return {"proposer": b"\x22" * 20, "registry_version": 3, "action": action}

    def test_create_market_round_trips_with_sz_decimals_ticker(self):
        market = {
            "market": 42,
            "im_bps": 1000,
            "mm_bps": 500,
            "taker_fee_bps": 5,
            "maker_fee_bps": 2,
            "funding_interval_ms": 60_000,
            "max_funding_rate_bps": 100,
            "sz_decimals": 4,
            "ticker": "BTC",
            "pool_id": 9,
            "max_open_interest": 1_000_000,
            "tick_size": 1_000,
            "lot_size": 100,
        }
        action = pts.actions.RawAction(
            pts.ActionType["ProposeAdminAction"],
            self._propose({"CreateMarket": market}),
        )
        action_type, payload = pts.encode_action(action)
        assert not hasattr(pts.ActionType, "CreateMarket")
        decoded = pts.decode_action(action_type, payload)["action"]["CreateMarket"]
        assert "signer" not in decoded
        assert decoded["sz_decimals"] == 4
        assert decoded["ticker"] == "BTC"
        assert decoded["pool_id"] == 9
        assert decoded["max_open_interest"] == 1_000_000
        assert decoded["tick_size"] == 1_000
        assert decoded["lot_size"] == 100

    @staticmethod
    def _market(ticker: str) -> dict:
        return {
            "market": 42,
            "im_bps": 1000,
            "mm_bps": 500,
            "taker_fee_bps": 5,
            "maker_fee_bps": 2,
            "funding_interval_ms": 60_000,
            "max_funding_rate_bps": 100,
            "sz_decimals": 0,
            "ticker": ticker,
            "pool_id": 0,
            "max_open_interest": 0,
            "tick_size": 1,
            "lot_size": 1,
        }

    def _market_creations(self, ticker: str) -> list[tuple[str, int, dict]]:
        single = {"CreateMarket": self._market(ticker)}
        batch = {
            "Batch": [
                {"CreateMarket": self._market("BTC")},
                {"CreateMarket": {**self._market(ticker), "market": 43}},
            ]
        }

        def propose(action: dict) -> dict:
            return {
                "proposer": b"\x22" * 20,
                "registry_version": 3,
                "action": action,
            }

        def approve(action: dict) -> dict:
            return {
                "approver": b"\x23" * 20,
                "proposal_id": 7,
                "registry_version": 3,
                "threshold": 2,
                "proposer": b"\x22" * 20,
                "created_height": 1,
                "created_ms": 1,
                "expiry_ms": 2,
                "action": action,
                "content_hash": bytes(32),
            }

        return [
            ("proposed", pts.ActionType["ProposeAdminAction"], propose(single)),
            ("proposed batch", pts.ActionType["ProposeAdminAction"], propose(batch)),
            ("approved", pts.ActionType["ApproveAdminAction"], approve(single)),
            ("approved batch", pts.ActionType["ApproveAdminAction"], approve(batch)),
        ]

    def test_every_market_creation_refuses_a_bad_ticker(self):
        """The ticker rule is a copy of proof_wire::ticker::validate_ticker
        (Proof-labs/exchange#1351), refused with the engine's text."""
        for name, action_type, fields in self._market_creations("TEST3."):
            with pytest.raises(ValueError) as e:
                pts.encode_action(pts.actions.RawAction(action_type, fields))
            assert str(e.value) == (
                "ticker may hold only A-Z, 0-9 and '-', found '.' at character 5"
            ), name
        for _name, action_type, fields in self._market_creations("TEST3"):
            pts.encode_action(pts.actions.RawAction(action_type, fields))

    @pytest.mark.parametrize(
        "ticker,message",
        [
            ("", "ticker is empty"),
            ("X" * 25, "ticker is 25 bytes, over the 24-byte limit"),
            ("test3", "ticker must start with a capital letter A-Z, not 't'"),
            ("Btc", "ticker may hold only A-Z, 0-9 and '-', found 't' at character 1"),
            (
                "BTCÉ",
                "ticker may hold only A-Z, 0-9 and '-', found 'É' at character 3",
            ),
        ],
    )
    def test_create_market_refusal_text_matches_the_engine(self, ticker, message):
        action = pts.actions.RawAction(
            pts.ActionType["ProposeAdminAction"],
            self._propose({"CreateMarket": self._market(ticker)}),
        )
        with pytest.raises(ValueError) as e:
            pts.encode_action(action)
        assert str(e.value) == message

    def test_a_market_created_before_the_rule_still_decodes(self):
        action_type, payload = pts.encode_action(
            pts.actions.RawAction(
                pts.ActionType["ProposeAdminAction"],
                self._propose({"CreateMarket": self._market("TEST3X")}),
            )
        )
        at = payload.index(b"TEST3X")
        patched = payload[: at + 5] + b"." + payload[at + 6 :]
        decoded = pts.decode_action(action_type, patched)
        assert decoded["action"]["CreateMarket"]["ticker"] == "TEST3."

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


class TestDepositLocator:
    """The locator a VoteDeposit observation carries (the single-signer
    ConfirmDeposit that carried it is retired)."""

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
