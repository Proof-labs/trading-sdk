"""Regression tests for two client bugs.

FIX #7 — a non-2xx (e.g. 400) response and an engine `{"status": "error"}`
body with no `code` key must raise instead of being reported as success.

FIX #8 — `ExchangeClient()` with no args must not clobber env/TOML config
with the falsy constructor defaults (`gateway_url=""`, `timeout_secs=0`).
"""

from __future__ import annotations

import httpx
import pytest

from proof_trading_sdk.client import ExchangeClient
from proof_trading_sdk.errors import EngineError, GatewayError, ProofTradingSdkError


def _client(handler) -> ExchangeClient:
    c = ExchangeClient(gateway_url="http://test-gateway", chain_id=b"\x00" * 32)
    c._http = httpx.Client(
        base_url="http://test-gateway", transport=httpx.MockTransport(handler)
    )
    return c


def test_submit_action_400_raises():
    # A 400 (previously fell through `_check_response` as success).
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": "bad request"})

    with pytest.raises(GatewayError):
        _client(handler).submit_action(b"\x00")


def test_submit_action_error_status_no_code_raises():
    # 200 body carrying no `code` but an explicit error status: NOT code-0 success.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "error", "message": "rejected"})

    with pytest.raises(ProofTradingSdkError):
        _client(handler).submit_action(b"\x00")


def test_submit_action_code_zero_still_succeeds():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"code": 0, "tx_hash": "0xabc"})

    assert _client(handler).submit_action(b"\x00")["tx_hash"] == "0xabc"


def test_submit_action_nonzero_code_raises_engine_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"code": 12, "message": "insufficient margin"})

    with pytest.raises(EngineError):
        _client(handler).submit_action(b"\x00")


def test_env_config_not_clobbered_by_defaults(monkeypatch, tmp_path):
    # FIX #8: no-arg ExchangeClient() must inherit env config, not "" / 0.
    monkeypatch.setenv("PROOF_GATEWAY_URL", "http://env-gateway:9080")
    monkeypatch.setenv("PROOF_TIMEOUT_SECS", "30")
    # Point config-file lookup at an empty home so only env is consulted.
    monkeypatch.setattr("proof_trading_sdk.config.Path.home", lambda: tmp_path)

    c = ExchangeClient()
    assert c._gateway_url == "http://env-gateway:9080"
    assert c._timeout_secs == 30
