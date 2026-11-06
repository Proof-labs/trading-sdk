import hashlib

import httpx
import pytest

from proof_trading_sdk import ExchangeClient, GatewayError, SdkConfig, SubmissionPending, TransportError


@pytest.mark.parametrize("failure,pending", [
    (httpx.ReadTimeout, True), (httpx.ReadError, True),
    (httpx.WriteTimeout, True), (httpx.WriteError, True),
    (httpx.RemoteProtocolError, True),
    (httpx.DecodingError, True), (httpx.CloseError, True),
    (httpx.ConnectTimeout, False), (httpx.ConnectError, False),
    (httpx.PoolTimeout, False), (httpx.LocalProtocolError, False),
    (httpx.UnsupportedProtocol, False),
])
def test_submit_retains_hash_only_for_potentially_sent_request(failure, pending):
    envelope = b"mock signed bytes\x00\xff"
    calls = []

    def handler(request):
        calls.append(request)
        raise failure("synthetic transport failure", request=request)

    client = ExchangeClient(config=SdkConfig(gateway_url="https://gateway.example"))
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(SubmissionPending if pending else TransportError) as caught:
            client.submit_action(envelope)
        assert len(calls) == 1  # Never automatically resend the action.
        if pending:
            assert caught.value.tx_hash == hashlib.sha256(envelope).hexdigest().upper()
        else:
            assert not isinstance(caught.value, SubmissionPending)
    finally:
        client.close()


def test_read_timeout_remains_a_transport_error():
    def handler(request):
        raise httpx.ReadTimeout("synthetic read timeout", request=request)

    client = ExchangeClient(config=SdkConfig(gateway_url="https://gateway.example"))
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(TransportError):
            client.status()
    finally:
        client.close()


@pytest.mark.parametrize("status", [500, 502, 504])
def test_5xx_preserves_hash_for_writes_and_gateway_error_for_reads(status):
    calls = []
    def handler(request):
        calls.append(request.url.path)
        return httpx.Response(status, text="upstream timeout")

    client = ExchangeClient(config=SdkConfig(gateway_url="https://gateway.example"))
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(SubmissionPending) as error:
            client.submit_action(b"original signed bytes")
        assert error.value.tx_hash == hashlib.sha256(b"original signed bytes").hexdigest().upper()
        assert isinstance(error.value.__cause__, GatewayError)
        with pytest.raises(GatewayError) as read_error:
            client.status()
        assert read_error.value.status_code == status
        assert calls == ["/exchange", "/v1/status"]
    finally:
        client.close()


@pytest.mark.parametrize("body,pending", [
    # The gateway's proven pre-admission refusal: nothing was broadcast.
    ({"status": "refused", "errorCode": "Overloaded", "error": "shed"}, False),
    # A refusal naming a hash, code or height contradicts itself.
    ({"status": "refused", "txHash": "AB" * 32}, True),
    ({"status": "refused", "code": 0}, True),
    ({"status": "pending", "txHash": "AB" * 32}, True),
    (None, True),
])
def test_503_refusal_stays_a_gateway_error(body, pending):
    envelope = b"original signed bytes"
    calls = []

    def handler(request):
        calls.append(request)
        if body is None:
            return httpx.Response(503, text="Service Unavailable")
        return httpx.Response(503, json=body)

    client = ExchangeClient(config=SdkConfig(gateway_url="https://gateway.example"))
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(SubmissionPending if pending else GatewayError) as caught:
            client.submit_action(envelope)
        assert len(calls) == 1
        if pending:
            assert caught.value.tx_hash == hashlib.sha256(envelope).hexdigest().upper()
        else:
            assert caught.value.status_code == 503
    finally:
        client.close()
