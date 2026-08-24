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
from proof_trading_sdk.errors import (
    EngineError,
    SubmissionPending,
    TransportError,
)


def _client(handler) -> ExchangeClient:
    c = ExchangeClient(gateway_url="http://test-gateway", chain_id=b"\x00" * 32)
    c._http = httpx.Client(
        base_url="http://test-gateway", transport=httpx.MockTransport(handler)
    )
    return c


def test_submit_action_400_raises():
    # A 400 (previously fell through `_check_response` as success). It is a
    # TransportError, NOT a GatewayError — GatewayError means "5xx, retry with
    # backoff" and a 400 must never be blind-retried.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": "bad request"})

    with pytest.raises(TransportError) as exc:
        _client(handler).submit_action(b"\x00")
    assert exc.value.status_code == 400


def test_submit_action_error_status_no_code_raises():
    # 200 body carrying no `code` and no hash, but an explicit error status:
    # NOT code-0 success. With no leading "<code>: " in the text the engine code
    # falls back to 1 (DecodeError), matching the TypeScript binding.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "error", "message": "rejected"})

    with pytest.raises(EngineError) as exc:
        _client(handler).submit_action(b"\x00")
    assert exc.value.code == 1


def test_submit_action_error_string_recovers_leading_engine_code():
    # The gateway keeps the "<code>: <message>" compatibility format, so the
    # real engine code is recovered from the text rather than flattened to 1.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"status": "error", "error": "12: insufficient margin"}
        )

    with pytest.raises(EngineError) as exc:
        _client(handler).submit_action(b"\x00")
    assert exc.value.code == 12
    assert exc.value.name == "InsufficientMargin"


def test_submit_action_legacy_status_ok_without_code_succeeds():
    """A code-less `{"status": "ok"}` is a legacy CheckTx ack — a SUCCESS.

    The gateway contract pinned by the TS binding (`submitViaGateway`) treats
    this shape as accepted-but-unresolved. Raising here would fail every submit
    against a gateway that has not been upgraded.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "ok"})

    assert _client(handler).submit_action(b"\x00") == {"status": "ok"}


def test_submit_action_broadcast_without_result_is_pending_not_rejected():
    """`status: error` + a hash + no `code` is NOT a rejection.

    The gateway broadcast the tx and could not report the outcome in time. The
    tx may still commit, so this must surface as a reconcile-by-hash signal.
    Reporting it as an engine rejection would make a trader re-place an order
    that is about to fill — a double fill.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "status": "error",
                "txHash": "0xdeadbeef",
                "error": "gateway returned no on-chain result; reconcile by hash",
            },
        )

    with pytest.raises(SubmissionPending) as exc:
        _client(handler).submit_action(b"\x00")
    assert exc.value.tx_hash == "0xdeadbeef"
    # Never described as a rejection.
    assert "reject" not in str(exc.value).lower()


def test_submit_action_snake_case_tx_hash_also_pending():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "error", "tx_hash": "0xfeed"})

    with pytest.raises(SubmissionPending) as exc:
        _client(handler).submit_action(b"\x00")
    assert exc.value.tx_hash == "0xfeed"


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


def test_submit_action_plain_text_error_recovers_engine_code():
    """A pre-#90 gateway sends ONLY the "<code>: <message>" string.

    The TS binding keeps the raw body so the fallback can parse it; Python must
    do the same rather than flattening a real rejection into a transport error.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="12: insufficient margin")

    with pytest.raises(EngineError) as exc:
        _client(handler).submit_action(b"\x00")
    assert exc.value.code == 12


def test_submit_action_json_string_body_does_not_crash():
    # `resp.json()` returns a str here, not a dict — it must never reach .get().
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json="12: insufficient margin")

    with pytest.raises(EngineError) as exc:
        _client(handler).submit_action(b"\x00")
    assert exc.value.code == 12


def test_submit_action_bare_error_string_without_code_is_engine_error():
    """No leading "<code>: " still means a rejection, not a transport failure.

    Classifying a terminal engine rejection as transport would invite the caller
    to retry a submit that will never succeed. Falls back to code 1, matching
    the TypeScript binding.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="signature verification failed")

    with pytest.raises(EngineError) as exc:
        _client(handler).submit_action(b"\x00")
    assert exc.value.code == 1
    assert "signature verification failed" in str(exc.value)


def test_submit_action_json_string_without_code_is_engine_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json="signature verification failed")

    with pytest.raises(EngineError) as exc:
        _client(handler).submit_action(b"\x00")
    assert exc.value.code == 1


def test_submit_action_json_list_body_does_not_crash():
    # Not an object: must not reach .get(). Classified like any other non-object
    # 2xx body rather than raising AttributeError.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[1, 2, 3])

    with pytest.raises(EngineError):
        _client(handler).submit_action(b"\x00")
