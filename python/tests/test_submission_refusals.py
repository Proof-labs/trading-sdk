"""Refusal evidence is validated before HTTP fallback; ambiguity keeps local bytes."""

import hashlib

import httpx
import pytest

from proof_trading_sdk.client import ExchangeClient
from proof_trading_sdk.errors import (
    AuthenticationError,
    GatewayError,
    PreAdmissionRefusal,
    RateLimited,
    SubmissionPending,
    TransportError,
)

WIRE = b"signed-envelope-under-test"
LOCAL_HASH = hashlib.sha256(WIRE).hexdigest().upper()


@pytest.fixture
def answer():
    clients = []

    def make(status, body):
        calls = []

        def handler(request):
            calls.append(request)
            return httpx.Response(status, json=body)

        client = ExchangeClient(gateway_url="http://test-gateway", chain_id=b"\x00" * 32)
        client._http.close()
        client._http = httpx.Client(transport=httpx.MockTransport(handler))
        clients.append(client)
        return client, calls

    yield make
    for client in clients:
        client.close()


@pytest.mark.parametrize("status", [200, 400, 401, 429, 500, 503])
@pytest.mark.parametrize("bad_fields", [
    {"txHash": "B" * 64},
    {"tx_hash": "B" * 64},
    {"txHash": None},
    {"txHash": ""},
    {"tx_hash": None},
    {"code": None},
    {"code": 12},
    {"height": None},
    {"height": 42},
    {"events": []},
    {"log": None},
    {"info": "execution"},
    {"errorCode": None},
    {"errorCode": {}},
    {"errorCode": ""},
    {"errorCode": " "},
    {"error": []},
    {"error": None},
])
def test_invalid_refusal_reconciles_only_local_hash(answer, status, bad_fields):
    body = {"status": "refused", "errorCode": "InvalidRequest", "error": "bad request"}
    body.update(bad_fields)
    client, calls = answer(status, body)
    with pytest.raises(SubmissionPending) as exc:
        client.submit_action(WIRE)
    assert exc.value.tx_hash == LOCAL_HASH
    assert len(calls) == 1
    assert calls[0].url.path == "/exchange"


@pytest.mark.parametrize("status", [200, 400, 500, 503])
def test_missing_reason_is_not_refusal_evidence(answer, status):
    client, calls = answer(status, {"status": "refused"})
    with pytest.raises(SubmissionPending) as exc:
        client.submit_action(WIRE)
    assert exc.value.tx_hash == LOCAL_HASH
    assert len(calls) == 1


@pytest.mark.parametrize("status", [200, 400, 500])
def test_encoding_failure_preserves_refusal_at_server_status(answer, status):
    client, calls = answer(status, {
        "status": "refused", "errorCode": "EncodingError", "error": "internal encoding error",
    })
    with pytest.raises(PreAdmissionRefusal) as exc:
        client.submit_action(WIRE)
    assert exc.value.error_code == "EncodingError"
    assert exc.value.message == "internal encoding error"
    assert exc.value.status_code == status
    assert len(calls) == 1


@pytest.mark.parametrize("status", [200, 400])
def test_unknown_string_code_survives_without_coercion(answer, status):
    client, calls = answer(status, {"status": "refused", "errorCode": "FutureReason"})
    with pytest.raises(PreAdmissionRefusal) as exc:
        client.submit_action(WIRE)
    assert exc.value.error_code == "FutureReason"
    assert len(calls) == 1


@pytest.mark.parametrize("status,message", [
    (411, "Content-Length required"),
    (413, "payload too large"),
])
def test_refusal_before_the_body_is_read_keeps_its_reason(answer, status, message):
    client, calls = answer(status, {
        "status": "refused", "errorCode": "InvalidRequest", "error": message,
    })
    with pytest.raises(PreAdmissionRefusal) as exc:
        client.submit_action(WIRE)
    assert exc.value.error_code == "InvalidRequest"
    assert exc.value.message == message
    assert exc.value.status_code == status
    assert len(calls) == 1


def test_auth_exception_is_preserved(answer):
    client, _ = answer(401, {"status": "refused", "errorCode": "Unauthorized"})
    with pytest.raises(AuthenticationError):
        client.submit_action(WIRE)


def test_rate_limit_exception_is_preserved(answer):
    client, _ = answer(429, {"status": "refused", "errorCode": "RateLimited"})
    with pytest.raises(RateLimited):
        client.submit_action(WIRE)


@pytest.mark.parametrize("error_code", ["Maintenance", "Unavailable"])
def test_unavailable_gateway_exception_is_preserved(answer, error_code):
    client, _ = answer(503, {"status": "refused", "errorCode": error_code})
    with pytest.raises(GatewayError) as exc:
        client.submit_action(WIRE)
    assert error_code in exc.value.body


def test_overload_exception_is_preserved(answer):
    client, _ = answer(503, {"status": "refused", "errorCode": "Overloaded"})
    with pytest.raises(GatewayError):
        client.submit_action(WIRE)


@pytest.mark.parametrize("status", [200, 400, 503])
def test_pending_body_keeps_local_hash_before_http_fallback(answer, status):
    client, calls = answer(status, {"status": "pending", "txHash": "B" * 64})
    with pytest.raises(SubmissionPending) as exc:
        client.submit_action(WIRE)
    assert exc.value.tx_hash == LOCAL_HASH
    assert len(calls) == 1


def test_unstructured_400_keeps_transport_fallback(answer):
    client, _ = answer(400, {"error": "proxy rejected request"})
    with pytest.raises(TransportError) as exc:
        client.submit_action(WIRE)
    assert exc.value.status_code == 400


@pytest.mark.parametrize("message", [
    "non-canonical encoding",
    "action type 0x2f is proposer-only and cannot enter through the gateway",
])
def test_gateway_admission_refusal_is_not_an_engine_verdict(answer, message):
    client, calls = answer(400, {
        "status": "refused", "errorCode": "InvalidRequest", "error": message,
    })
    with pytest.raises(PreAdmissionRefusal) as exc:
        client.submit_action(WIRE)
    assert exc.value.error_code == "InvalidRequest"
    assert exc.value.message == message
    assert exc.value.status_code == 400
    assert len(calls) == 1
