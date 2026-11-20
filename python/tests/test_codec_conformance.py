"""Cross-language codec conformance for the Python binding.

These prove the typed Python actions encode, through the core, to the
byte-identical payloads the engine and the shared conformance vectors pin.
"""

from __future__ import annotations

import pytest
import proof_trading_sdk as pts
from proof_trading_sdk import actions


class TestGoldenVectors:
    def test_single_orders_encode_as_lists_of_one(self):
        # Payloads of conformance/codec.ndjson place_orders/limit_min,
        # place_orders/market_basic, cancel_orders/one and
        # cancel_client_orders/one.
        owner = bytes([0x01] * 20)
        cases = [
            (
                actions.PlaceOrder(
                    market=1, owner=owner, side=actions.Side.Buy, price=100, quantity=10
                ),
                0x01,
                "92dc00140101010101010101010101010101010101010101919801a3427579"
                "0a81a54c696d69749364a3477463c2c2c0c0c0",
            ),
            (
                actions.MarketOrder(
                    market=3, owner=owner, side=actions.Side.Buy, quantity=250
                ),
                0x01,
                "92dc00140101010101010101010101010101010101010101919803a3427579ccfa"
                "81a64d61726b657491c0c2c0c0c0",
            ),
            (
                actions.CancelOrder(order_id=42, owner=bytes([0x02] * 20)),
                0x02,
                "92dc00140202020202020202020202020202020202020202912a",
            ),
            (
                actions.CancelClientOrder(owner=owner, client_order_id=99),
                0x18,
                "92dc001401010101010101010101010101010101010101019163",
            ),
        ]
        for action, action_type, payload_hex in cases:
            assert actions.encode_action(action) == (action_type, bytes.fromhex(payload_hex))

    def test_retired_action_bytes_do_not_codec(self):
        # OracleUpdate, MarketOrder, RunLiquidationSweep, RunFundingTick,
        # OracleUpdateComposite, ClosePosition.
        for byte in (0x03, 0x04, 0x11, 0x12, 0x14, 0x17):
            with pytest.raises(ValueError, match="unknown action_type"):
                actions.encode_action(
                    actions.RawAction(byte, {"market": 1, "signer": bytes(20)})
                )
            with pytest.raises(ValueError, match="unknown action_type"):
                actions.decode_action(byte, bytes([0x92, 0x01, 0xC0]))


class TestEncodeDecodeRoundTrip:
    def test_position_trigger_actions_match_engine_golden_vectors(self):
        set_action = actions.SetPositionTriggers(
            market=7,
            owner=bytes([0xA5] * 20),
            expected_position_epoch=3,
            stop_loss=actions.TriggerLimb(95_000, 75, 11),
            take_profit=actions.TriggerLimb(110_000, 50, 12),
            client_group_id=9,
        )
        cancel_action = actions.CancelPositionTriggers(
            market=7,
            owner=bytes([0xA5] * 20),
            expected_position_epoch=3,
        )
        cases = [
            (
                set_action,
                "9607dc0014cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca50393ce000173184b0b93ce0001adb0320c09",
                "9602252ac43f9607dc0014cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca50393ce000173184b0b93ce0001adb0320c09c4201111111111111111111111111111111111111111111111111111111111111111c44022222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222",
            ),
            (
                cancel_action,
                "9307dc0014cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca503",
                "9602262ac42e9307dc0014cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca503c4201111111111111111111111111111111111111111111111111111111111111111c44022222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222",
            ),
        ]
        for action, payload_hex, envelope_hex in cases:
            action_type, payload = actions.encode_action(action)
            assert payload.hex() == payload_hex
            assert (
                pts.encode_signed_tx(
                    action_type,
                    payload,
                    42,
                    bytes([0x11] * 32),
                    bytes([0x22] * 64),
                ).hex()
                == envelope_hex
            )

    def test_position_trigger_validation_is_typed_and_fail_fast(self):
        with pytest.raises(ValueError, match="at least one"):
            actions.SetPositionTriggers(
                market=7,
                owner=bytes(20),
                expected_position_epoch=3,
            )
        with pytest.raises(ValueError, match="non-zero"):
            actions.TriggerLimb(95_000, 0)
        with pytest.raises(ValueError, match="must differ"):
            actions.SetPositionTriggers(
                market=7,
                owner=bytes(20),
                expected_position_epoch=3,
                stop_loss=actions.TriggerLimb(95_000, 75, 11),
                take_profit=actions.TriggerLimb(110_000, 50, 11),
            )

    def test_order_actions_with_limbs_match_engine_frozen_payloads(self):
        # Lists of one carrying limbs (conformance place_orders/limit_with_triggers),
        # and the engine's frozen cancel_replace_with_triggers payload.
        stop_loss = actions.TriggerLimb(95_000, 75, 11)
        take_profit = actions.TriggerLimb(110_000, 50, 12)
        cases = [
            (
                actions.PlaceOrder(
                    market=1,
                    owner=bytes([0x01] * 20),
                    side=actions.Side.Buy,
                    price=100,
                    quantity=10,
                    stop_loss=stop_loss,
                    take_profit=take_profit,
                ),
                "92dc00140101010101010101010101010101010101010101919801a34275790a81a54c696d6974"
                "9364a3477463c2c2c093ce000173184b0b93ce0001adb0320c",
            ),
            (
                actions.MarketOrder(
                    market=1,
                    owner=bytes([0x01] * 20),
                    side=actions.Side.Sell,
                    quantity=10,
                    stop_loss=stop_loss,
                    worst_price=95_000,
                ),
                # conformance place_orders/market_worst_price_with_triggers
                "92dc00140101010101010101010101010101010101010101919801a453656c6c0a81a64d61726b6574"
                "91ce00017318c2c093ce000173184b0bc0",
            ),
            (
                actions.CancelReplaceOrder(
                    owner=bytes([0x02] * 20),
                    market=1,
                    side=actions.Side.Sell,
                    price=100,
                    quantity=10,
                    cancel_order_id=42,
                    take_profit=take_profit,
                ),
                "9ddc001402020202020202020202020202020202020202022ac001a453656c6c640ac0c2c2a3477463c093ce0001adb0320c",
            ),
        ]
        for action, payload_hex in cases:
            _, payload = actions.encode_action(action)
            assert payload.hex() == payload_hex

    def test_each_order_limb_round_trips_independently(self):
        # The frozen vectors above carry one limb on the market and cancel-replace
        # actions; this covers the other limb of each so neither can be dropped.
        order = {"market": 1, "owner": bytes(20), "side": actions.Side.Buy}
        limb = actions.TriggerLimb(95_000, 75, 11)
        for action in (
            actions.MarketOrder(**order, quantity=10, take_profit=limb),
            actions.CancelReplaceOrder(
                **order, price=100, quantity=10, cancel_order_id=42, stop_loss=limb
            ),
        ):
            action_type, payload = actions.encode_action(action)
            decoded = actions.decode_action(action_type, payload)
            if "orders" in decoded:
                (decoded,) = decoded["orders"]
            present, absent = (
                ("take_profit", "stop_loss")
                if action.take_profit
                else ("stop_loss", "take_profit")
            )
            assert decoded[present] == limb.as_wire()
            assert decoded[absent] is None

    def test_order_trigger_validation_is_typed_and_fail_fast(self):
        limb = actions.TriggerLimb(95_000, 75, 11)
        order = {
            "market": 1,
            "owner": bytes(20),
            "side": actions.Side.Buy,
            "quantity": 10,
        }
        with pytest.raises(ValueError, match="reduce_only order.*code 98"):
            actions.PlaceOrder(**order, price=100, reduce_only=True, stop_loss=limb)
        with pytest.raises(ValueError, match="reduce_only order.*code 98"):
            actions.CancelReplaceOrder(
                **order, price=100, reduce_only=True, take_profit=limb
            )
        with pytest.raises(ValueError, match="must differ"):
            actions.MarketOrder(**order, stop_loss=limb, take_profit=limb)
        # A reduce-only order without limbs is an ordinary reduce-only order.
        actions.PlaceOrder(**order, price=100, reduce_only=True)

    def test_trigger_order_incompatible_code_matches_the_native_error_table(self):
        code = actions.TRIGGER_ORDER_INCOMPATIBLE_CODE
        assert pts.get_error_name(code) == "TriggerOrderIncompatible"

    def test_trigger_market_config_admin_hash_matches_engine(self):
        config = dict(market=7, expected_current_version=3, enabled=True,
            max_trigger_slippage_bps=250, max_mark_age_ms=5000,
            max_future_publish_skew_ms=1000, max_active_brackets=32)
        digest = pts.admin_proposal_content_hash(
            bytes([0x11] * 32),
            42,
            3,
            2,
            bytes([0x22] * 20),
            7,
            1_000,
            259_201_000,
            {"SetTriggerMarketConfig": config},
        )
        assert (
            digest.hex()
            == "c707537e8d050389a705df1ce0aa2ad1cf873e67d1c45d10a955dde9b50e933c"
        )

    def test_place_order_round_trip(self):
        act = actions.PlaceOrder(
            market=7,
            owner=bytes(range(20)),
            side=actions.Side.Sell,
            price=66_750_00,
            quantity=3,
            client_order_id=99,
            post_only=True,
            reduce_only=False,
            time_in_force=actions.TimeInForce.Ioc,
        )
        action_type, payload = actions.encode_action(act)
        assert action_type == actions.ActionType.PlaceOrders
        decoded = actions.decode_action(action_type, payload)
        (entry,) = decoded["orders"]
        assert entry["market"] == 7
        assert entry["side"] == "Sell"
        assert entry["kind"] == {
            "Limit": {"price": 66_750_00, "time_in_force": "Ioc", "post_only": True}
        }
        assert entry["client_order_id"] == 99
        assert entry["reduce_only"] is False
        # Owner surfaces as `bytes` (not a list of ints) and round-trips.
        assert isinstance(decoded["owner"], bytes)
        assert decoded["owner"] == bytes(range(20))

    def test_market_order_round_trips_as_a_market_entry(self):
        act = actions.MarketOrder(
            market=3,
            owner=bytes(20),
            side=actions.Side.Buy,
            quantity=250,
            worst_price=1_000,
            reduce_only=True,
        )
        action_type, payload = actions.encode_action(act)
        assert action_type == actions.ActionType.PlaceOrders
        (entry,) = actions.decode_action(action_type, payload)["orders"]
        assert entry["kind"] == {"Market": {"worst_price": 1_000}}
        assert entry["reduce_only"] is True
        assert entry["quantity"] == 250

    def test_byte_field_accepts_python_bytes(self):
        # The wire newtypes must accept a Python `bytes` owner directly
        # (not only a list[int]) — the pythonize-ambiguity this fixes — and
        # decode back to `bytes`.
        act = actions.CancelOrder(order_id=2, owner=bytes([0xAB] * 20))
        action_type, payload = actions.encode_action(act)
        decoded = actions.decode_action(action_type, payload)
        assert isinstance(decoded["owner"], bytes)
        assert decoded["owner"] == bytes([0xAB] * 20)

    def test_wrong_owner_length_rejected(self):
        # A 19-byte owner must be rejected by the core's length check,
        # not silently truncated.
        act = actions.CancelOrder(order_id=1, owner=bytes([0x01] * 19))
        try:
            actions.encode_action(act)
        except ValueError:
            return
        raise AssertionError("expected ValueError for 19-byte owner")
