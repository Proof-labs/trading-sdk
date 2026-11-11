"""Regression tests for two client bugs.

FIX #7 — a non-2xx (e.g. 400) response and an engine `{"status": "error"}`
body with no `code` key must raise instead of being reported as success.

FIX #8 — `ExchangeClient()` with no args must not clobber env/TOML config
with the falsy constructor defaults (`gateway_url=""`, `timeout_secs=0`).
"""

from __future__ import annotations

import hashlib

import httpx
import pytest

from proof_trading_sdk.client import ExchangeClient
from proof_trading_sdk.errors import (
    EngineError,
    GatewayError,
    PreAdmissionRefusal,
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


def test_submit_action_400_refusal_is_a_refusal_not_a_transport_error():
    # Reading an HTTP 400 refusal envelope keeps the gateway's errorCode and
    # message instead of flattening them into transport text.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={
                "status": "refused",
                "error": 'invalid market ticker "btc": ticker must start with a capital letter A-Z',
                "errorCode": "InvalidRequest",
            },
        )

    with pytest.raises(PreAdmissionRefusal) as exc:
        _client(handler).submit_action(b"\x00")
    assert exc.value.error_code == "InvalidRequest"
    assert exc.value.status_code == 400
    assert "invalid market ticker" in exc.value.message
    assert not isinstance(exc.value, (EngineError, TransportError))


def test_submit_action_legacy_200_refusal_is_not_an_engine_rejection():
    # Legacy HTTP 200 refusal envelopes carry no engine verdict.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "status": "refused",
                "error": "internal encoding error",
                "errorCode": "EncodingError",
            },
        )

    with pytest.raises(PreAdmissionRefusal) as exc:
        _client(handler).submit_action(b"\x00")
    assert exc.value.error_code == "EncodingError"
    assert exc.value.status_code == 200
    assert not isinstance(exc.value, EngineError)


def test_submit_action_refusal_naming_a_hash_is_pending_not_refused():
    # A refusal that names a hash contradicts itself, so it proves nothing
    # about whether the tx was broadcast: reconcile rather than declare a
    # refusal.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={
                "status": "refused",
                "error": "contradictory",
                "errorCode": "InvalidRequest",
                "txHash": "0xdead",
            },
        )

    with pytest.raises(SubmissionPending) as exc:
        _client(handler).submit_action(b"\x00")
    assert exc.value.tx_hash == hashlib.sha256(b"\x00").hexdigest().upper()


def test_submit_action_refusal_naming_a_code_is_pending_not_an_engine_reject():
    # "Nothing was broadcast" plus an execution code proves neither. Reconcile
    # the bytes actually sent — reporting the code would announce an engine
    # rejection for a tx that may be in flight.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "status": "refused",
                "error": "contradictory",
                "errorCode": "InvalidRequest",
                "code": 12,
            },
        )

    with pytest.raises(SubmissionPending) as exc:
        _client(handler).submit_action(b"\x00")
    assert exc.value.tx_hash == hashlib.sha256(b"\x00").hexdigest().upper()


def test_submit_action_503_refusal_stays_a_gateway_error():
    # Valid overload refusals keep their existing GatewayError classification.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            503,
            json={
                "status": "refused",
                "error": "service overloaded",
                "errorCode": "Overloaded",
            },
        )

    with pytest.raises(GatewayError):
        _client(handler).submit_action(b"\x00")


@pytest.mark.parametrize("body", [
    {"status": "error", "message": "rejected"},
    {"status": "error"},
    {"error": "park deadline exceeded"},
    {"message": "upstream timeout"},
    {"error": "0: not a rejection"},
])
def test_submit_action_error_without_engine_code_is_pending(body):
    # An answer without an explicit non-zero engine code proves no rejection.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=body)

    with pytest.raises(SubmissionPending) as exc:
        _client(handler).submit_action(b"\x00")
    assert exc.value.tx_hash == hashlib.sha256(b"\x00").hexdigest().upper()


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


def test_submit_action_bare_error_string_without_code_is_pending():
    """An unstructured string without a code does not establish a verdict."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="signature verification failed")

    with pytest.raises(SubmissionPending) as exc:
        _client(handler).submit_action(b"\x00")
    assert "reconcile" in str(exc.value)


def test_submit_action_json_string_without_code_is_pending():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json="signature verification failed")

    with pytest.raises(SubmissionPending) as exc:
        _client(handler).submit_action(b"\x00")
    assert exc.value.tx_hash


def test_submit_action_json_list_body_does_not_crash():
    # A JSON list is not a verdict, and must not reach .get().
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[1, 2, 3])

    with pytest.raises(SubmissionPending):
        _client(handler).submit_action(b"\x00")


def test_pre_admission_refusal_is_exported_from_the_package():
    import proof_trading_sdk as pts

    assert pts.PreAdmissionRefusal is PreAdmissionRefusal
