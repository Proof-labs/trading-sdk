"""The wire-12 `/v2/bridge/*` reads: routing, page decode, cursors, and the
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


VOTE_A = {"voter": b"\x11" * 32, "signature": b"\x77" * 64}
VOTE_B = {"voter": b"\x22" * 32, "signature": b"\x88" * 64}


class TestBridgeStatus:
    def test_decodes_the_governance_view(self):
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/v2/bridge/status"
            return _view(
                {
                    "halted": True,
                    "payout_multisig": b"\xa2" * 32,
                    "ops_wallet": b"\xb3" * 32,
                    "registry_epoch": 3,
                    "registry_threshold": 2,
                    "operator_count": 2,
                }
            )

        status = _client(handler).bridge_status()
        assert status == {
            "halted": True,
            "payout_multisig": b"\xa2" * 32,
            "ops_wallet": b"\xb3" * 32,
            "registry_epoch": 3,
            "registry_threshold": 2,
            "operator_count": 2,
        }

    def test_leaves_ungoverned_fields_none(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return _view({"halted": False})

        status = _client(handler).bridge_status()
        assert status == {
            "halted": False,
            "payout_multisig": None,
            "ops_wallet": None,
            "registry_epoch": None,
            "registry_threshold": None,
            "operator_count": None,
        }


class TestBridgeRegistry:
    def test_decodes_the_roster_and_tolerates_a_pre_wire12_member(self):
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/v2/bridge/registry"
            return _view(
                {
                    "deployment_id": b"\xa1" * 32,
                    "epoch": 3,
                    "threshold": 2,
                    "members": [
                        {"key": b"\x11" * 32, "owner": b"\x55" * 20},
                        {"key": b"\x22" * 32, "owner": None},
                    ],
                }
            )

        registry = _client(handler).bridge_registry()
        assert registry == {
            "deployment_id": b"\xa1" * 32,
            "epoch": 3,
            "threshold": 2,
            "members": [
                {"key": b"\x11" * 32, "owner": b"\x55" * 20},
                {"key": b"\x22" * 32, "owner": None},
            ],
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
                    },
                    "lease": {
                        "holder": b"\x55" * 20,
                        "acquired_height": 43,
                        "expires_at_height": 143,
                    },
                    "payout_reports": [
                        {
                            "holder": b"\x55" * 20,
                            "vault": b"\xa2" * 32,
                            "squads_transaction_index": 7,
                            "registry_epoch": 3,
                        }
                    ],
                    "votes": {
                        "registry_epoch": 3,
                        "votes": [VOTE_A, VOTE_B],
                    },
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
            "status": "pending",
            "request_height": 42,
        }
        assert row["lease"]["expires_at_height"] == 143
        assert row["payout_reports"][0]["vault"] == b"\xa2" * 32
        assert row["votes"]["votes"] == [VOTE_A, VOTE_B]
        assert page["next_cursor"] == 104

    def test_decodes_the_exhausted_page(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return _view({"rows": [], "next_cursor": None})

        page = _client(handler).pending_withdrawals()
        assert page == {"rows": [], "next_cursor": None}


class TestPendingDeposits:
    def test_decodes_one_page_and_hexes_the_opaque_cursor(self):
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/v2/bridge/pending-deposits"
            return _view(
                {
                    "rows": [
                        {
                            "solana_tx_sig": b"\x99" * 64,
                            "locator": {"top_index": 2, "inner_index": 5},
                            "registry_epoch": 3,
                            "observations": [
                                {
                                    "owner": b"\x66" * 20,
                                    "amount_micro_usdc": 1_000_000,
                                    "votes": [VOTE_A],
                                }
                            ],
                        }
                    ],
                    "next_cursor": b"\xde\xad\xbe\xef",
                }
            )

        page = _client(handler).pending_deposits()
        row = page["rows"][0]
        assert row["solana_tx_sig"] == b"\x99" * 64
        assert row["locator"] == {"top_index": 2, "inner_index": 5}
        assert row["observations"][0]["amount_micro_usdc"] == 1_000_000
        # The raw store-key bytes, hex-encoded exactly as the route serves
        # them — an opaque token to pass back verbatim.
        assert page["next_cursor"] == "deadbeef"

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
                            "registry_epoch": 1,
                            "observations": [],
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
