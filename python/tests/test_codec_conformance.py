"""Cross-language codec conformance for the Python binding.

These prove the Python binding produces *byte-identical* output to the Rust
core by reusing the checked-in golden vectors in
``crates/spec/golden-vectors``. They exercise the full
``encode_action`` (build payload via core) + ``sign_and_encode`` (sign
envelope via core) path — the fix for the previously-missing Python codec.

The Rust golden vectors are generated with the signing key ``[0x42; 32]``,
``UNBOUND_CHAIN_ID`` (zeros), and the seq shown below (see
``crates/proof-trading-sdk/src/codec.rs::test_golden_vectors``).
"""

from __future__ import annotations

from pathlib import Path

import proof_trading_sdk as pts
from proof_trading_sdk import actions

_VECTORS = Path(__file__).resolve().parents[2] / "crates" / "spec" / "golden-vectors"
_KEY = bytes([0x42] * 32)
_UNBOUND = b"\x00" * 32


def _golden(name: str) -> str:
    return (_VECTORS / name).read_text().strip()


def _sign(action_type: int, payload: bytes, seq: int) -> bytes:
    return pts.sign_and_encode(_UNBOUND, action_type, payload, seq, _KEY)


class TestGoldenVectors:
    def test_place_order_matches_rust_golden(self):
        act = actions.PlaceOrder(
            market=1,
            owner=bytes([0x01] * 20),
            side=actions.Side.Buy,
            price=100,
            quantity=10,
            client_order_id=None,
            post_only=False,
            reduce_only=False,
            time_in_force=actions.TimeInForce.Gtc,
        )
        action_type, payload = actions.encode_action(act)
        envelope = _sign(action_type, payload, 1)
        assert envelope.hex() == _golden("place_order.hex")

    def test_cancel_order_matches_rust_golden(self):
        act = actions.CancelOrder(order_id=42, owner=bytes([0x02] * 20))
        action_type, payload = actions.encode_action(act)
        envelope = _sign(action_type, payload, 2)
        assert envelope.hex() == _golden("cancel_order.hex")

    def test_oracle_update_matches_rust_golden(self):
        # No dedicated builder for the relayer-only OracleUpdate — exercise
        # the generic RawAction escape hatch (still encoded by the core).
        act = actions.RawAction(
            actions.ActionType.OracleUpdate,
            {
                "market": 1,
                "price": 5000,
                "signer": bytes([0x03] * 20),
                "publish_time_ms": 0,
            },
        )
        action_type, payload = actions.encode_action(act)
        envelope = _sign(action_type, payload, 3)
        assert envelope.hex() == _golden("oracle_update.hex")


class TestEncodeDecodeRoundTrip:
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
        decoded = actions.decode_action(action_type, payload)
        assert decoded["market"] == 7
        assert decoded["side"] == "Sell"
        assert decoded["price"] == 66_750_00
        assert decoded["client_order_id"] == 99
        assert decoded["post_only"] is True
        assert decoded["time_in_force"] == "Ioc"
        # Owner surfaces as `bytes` (not a list of ints) and round-trips.
        assert isinstance(decoded["owner"], bytes)
        assert decoded["owner"] == bytes(range(20))

    def test_byte_field_accepts_python_bytes(self):
        # The wire newtypes must accept a Python `bytes` owner directly
        # (not only a list[int]) — the pythonize-ambiguity this fixes — and
        # decode back to `bytes`.
        act = actions.ClosePosition(market=2, owner=bytes([0xAB] * 20))
        action_type, payload = actions.encode_action(act)
        decoded = actions.decode_action(action_type, payload)
        assert isinstance(decoded["owner"], bytes)
        assert decoded["owner"] == bytes([0xAB] * 20)

    def test_wrong_owner_length_rejected(self):
        # A 19-byte owner must be rejected by the core's length check,
        # not silently truncated.
        act = actions.ClosePosition(market=1, owner=bytes([0x01] * 19))
        try:
            actions.encode_action(act)
        except ValueError:
            return
        raise AssertionError("expected ValueError for 19-byte owner")
