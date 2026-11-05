import hashlib

import httpx
import pytest

from proof_trading_sdk import ExchangeClient, SdkConfig, SubmissionPending, TransportError


@pytest.mark.parametrize("failure,pending", [
    (httpx.ReadTimeout, True), (httpx.ReadError, True),
    (httpx.WriteTimeout, True), (httpx.WriteError, True),
    (httpx.RemoteProtocolError, True),
    (httpx.ConnectTimeout, False), (httpx.ConnectError, False),
    (httpx.PoolTimeout, False), (httpx.LocalProtocolError, False),
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
