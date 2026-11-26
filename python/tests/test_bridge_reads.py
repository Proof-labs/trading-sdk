"""The `/v2/bridge/*` reads: routing, page decode, cursors, and the
exhausted page. Mirrors the TS `wire-reads.test.ts` bridge sections.
"""

from __future__ import annotations

import base64

import httpx
import msgpack

from proof_trading_sdk.client import ExchangeClient
from proof_trading_sdk.errors import CodecError


def _client(handler) -> ExchangeClient:
    c = ExchangeClient(gateway_url="http://test-gateway", chain_id=b"\x00" * 32)
    c._http = httpx.Client(
        base_url="http://test-gateway", transport=httpx.MockTransport(handler)
    )
    return c


def _view(payload) -> httpx.Response:
    data = base64.b64encode(msgpack.packb(payload)).decode()
    return httpx.Response(200, json={"data": data})


VOTE_A = {"voter": b"\x11" * 32, "signature": b"\x77" * 64,
          "registry_epoch": 3, "verdict": "paid", "vault": b"\xa2" * 32,
          "squads_transaction_index": 7}
VOTE_B = {"voter": b"\x22" * 32, "signature": b"\x88" * 64,
          "registry_epoch": 3, "verdict": "dead", "vault": b"\xa2" * 32,
          "squads_transaction_index": 7}


class TestBridgeStatus:
    def test_decodes_the_bridge_status_enum(self):
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/v2/bridge/status"
            return _view("Paused")

        status = _client(handler).bridge_status()
        assert status == "Paused"

    def test_decodes_the_backlog_alert(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return _view("WithdrawalBacklog")

        assert _client(handler).bridge_status() == "WithdrawalBacklog"

    def test_rejects_unknown_status_variant(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return _view("UnknownStatus")

        import pytest

        with pytest.raises(CodecError, match="unknown variant"):
            _client(handler).bridge_status()


class TestBridgePayoutConfig:
    def test_decodes_the_vault_and_rent_wallet(self):
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/v2/bridge/payout-config"
            return _view({"payout_multisig": b"\xb2" * 32, "ops_wallet": b"\xb3" * 32})

        assert _client(handler).bridge_payout_config() == {
            "payout_multisig": b"\xb2" * 32,
            "ops_wallet": b"\xb3" * 32,
        }

    def test_reads_none_while_unset(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return _view(None)

        assert _client(handler).bridge_payout_config() is None


class TestBridgeRegistry:
    def test_decodes_the_roster_of_operator_keys(self):
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/v2/bridge/registry"
            return _view(
                {
                    "deployment_id": b"\xa1" * 32,
                    "epoch": 3,
                    "threshold": 2,
                    "members": [{"key": b"\x11" * 32}, {"key": b"\x22" * 32}],
                }
            )

        registry = _client(handler).bridge_registry()
        assert registry == {
            "deployment_id": b"\xa1" * 32,
            "epoch": 3,
            "threshold": 2,
            "members": [{"key": b"\x11" * 32}, {"key": b"\x22" * 32}],
        }

    def test_an_explicit_epoch_rides_the_path(self):
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/v2/bridge/registry/7"
            return _view(
                {
                    "deployment_id": b"\xa1" * 32,
                    "epoch": 7,
                    "threshold": 1,
                    "members": [],
                }
            )

        assert _client(handler).bridge_registry(7)["epoch"] == 7


class TestPendingWithdrawals:
    def _page(self):
        return {
            "rows": [
                {
                    "withdrawal": {
                        "withdrawal_id": 103,
                        "owner": b"\xab" * 20,
                        "amount": 5_000_000,
                        "solana_destination": b"\xcd" * 32,
                        "status": "pending",
                        "request_height": 42,
                        "quarantined": False,
                    },
                    "payout": {
                        "recorder": b"\x11" * 32,
                        "vault": b"\xa2" * 32,
                        "squads_transaction_index": 7,
                        "registry_epoch": 3,
                        "recorded_at_ms": 1_700_000_000_000,
                    },
                    "votes": [VOTE_A, VOTE_B],
                }
            ],
            "next_cursor": 104,
        }

    def test_decodes_one_page_and_forwards_cursor_params(self):
        calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(f"{request.url.path}?{request.url.query.decode()}")
            return _view(self._page())

        page = _client(handler).pending_withdrawals(cursor=99, limit=50)
        assert calls == ["/v2/bridge/pending-withdrawals?cursor=99&limit=50"]
        row = page["rows"][0]
        assert row["withdrawal"] == {
            "withdrawal_id": 103,
            "owner": b"\xab" * 20,
            "amount": 5_000_000,
            "solana_destination": b"\xcd" * 32,
            "status": "Pending",
            "request_height": 42,
            "quarantined": False,
        }
        assert row["payout"]["recorder"] == b"\x11" * 32
        assert row["payout"]["recorded_at_ms"] == 1_700_000_000_000
        assert [v["verdict"] for v in row["votes"]] == ["Paid", "Dead"]
        assert row["votes"][1]["signature"] == b"\x88" * 64
        assert page["next_cursor"] == 104

    def test_decodes_the_exhausted_page(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return _view({"rows": [], "next_cursor": None})

        page = _client(handler).pending_withdrawals()
        assert page == {"rows": [], "next_cursor": None}

    def test_an_unknown_status_or_verdict_reads_as_unknown(self):
        payload = self._page()
        payload["rows"][0]["withdrawal"]["status"] = "expired"
        payload["rows"][0]["votes"][0] = VOTE_A | {"verdict": "expired"}

        def handler(request: httpx.Request) -> httpx.Response:
            return _view(payload)

        row = _client(handler).pending_withdrawals()["rows"][0]
        assert row["withdrawal"]["status"] == "Unknown"
        assert row["votes"][0]["verdict"] == "Unknown"

    def test_absent_quarantine_reads_false_and_a_non_bool_is_refused(self):
        payload = self._page()
        del payload["rows"][0]["withdrawal"]["quarantined"]

        def handler(request: httpx.Request) -> httpx.Response:
            return _view(payload)

        assert _client(handler).pending_withdrawals()["rows"][0]["withdrawal"]["quarantined"] is False
        payload["rows"][0]["withdrawal"]["quarantined"] = 1
        import pytest

        with pytest.raises(CodecError, match="quarantined"):
            _client(handler).pending_withdrawals()


class TestPendingDeposits:
    def test_decodes_one_page_and_returns_the_cursor_in_route_form(self):
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/v2/bridge/pending-deposits"
            return _view(
                {
                    "rows": [
                        {
                            "solana_tx_sig": b"\x99" * 64,
                            "locator": {"top_index": 2, "inner_index": 5},
                            "votes": [{
                                "voter": b"\x11" * 32, "registry_epoch": 3,
                                "owner": b"\x66" * 20, "amount_micro_usdc": 1_000_000,
                                "signature": b"\x77" * 64,
                            }],
                        }
                    ],
                    "next_cursor": {
                        "solana_tx_sig": b"\x99" * 64,
                        "locator": {"top_index": 2, "inner_index": None},
                    },
                }
            )

        page = _client(handler).pending_deposits()
        row = page["rows"][0]
        assert row["solana_tx_sig"] == b"\x99" * 64
        assert row["locator"] == {"top_index": 2, "inner_index": 5}
        assert row["votes"][0]["amount_micro_usdc"] == 1_000_000
        # The last scanned identity: the transfer signature, then the top
        # index (0x0002) and an absent inner index (0xFFFF), big-endian.
        assert page["next_cursor"] == "99" * 64 + "0002ffff"

    def test_decodes_the_exhausted_page(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return _view({"rows": [], "next_cursor": None})

        assert _client(handler).pending_deposits() == {
            "rows": [],
            "next_cursor": None,
        }

    def test_a_wrong_width_byte_field_is_refused(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return _view(
                {
                    "rows": [
                        {
                            "solana_tx_sig": b"\x99" * 63,
                            "locator": {"top_index": 0, "inner_index": None},
                            "votes": [],
                        }
                    ],
                    "next_cursor": None,
                }
            )

        try:
            _client(handler).pending_deposits()
        except CodecError as e:
            assert "solana_tx_sig" in str(e)
        else:
            raise AssertionError("expected a CodecError")


AGREED = {
    "owner": b"\x66" * 20, "amount_micro_usdc": 20_000_000_000, "solana_tx_sig": b"\x99" * 64,
    "locator": None, "registry_epoch": 3, "agreed_height": 50, "agreed_at_ms": 1_700_000_000_000,
}


class TestAgreedAndParkedDeposits:
    def test_decodes_the_credit_queue(self):
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/v2/bridge/agreed-deposits"
            return _view({"rows": [{"sequence": 7, "deposit": AGREED}], "next_cursor": 7})

        page = _client(handler).agreed_deposits()
        assert page == {"rows": [{"sequence": 7, "deposit": AGREED}], "next_cursor": 7}

    def test_decodes_a_parked_deposit_with_its_cause_and_a_hex_cursor(self):
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/v2/bridge/parked-deposits"
            return _view({
                "rows": [{"deposit": AGREED, "cause": "over_window_cap", "parked_height": 51}],
                "next_cursor": b"\xde\xad",
            })

        page = _client(handler).parked_deposits()
        assert page["rows"][0]["cause"] == "OverWindowCap"
        assert page["rows"][0]["deposit"] == AGREED
        assert page["next_cursor"] == "dead"


class TestDepositCursorBounds:
    def test_an_index_outside_u16_is_a_codec_error(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return _view({
                "rows": [],
                "next_cursor": {"solana_tx_sig": b"\x99" * 64, "locator": {"top_index": 70000, "inner_index": None}},
            })

        import pytest

        with pytest.raises(CodecError, match="u16"):
            _client(handler).pending_deposits()
