import hashlib

import httpx
import pytest

from proof_trading_sdk import EngineError, ExchangeClient, SdkConfig, SubmissionPending, TransportError


def client_for(body):
    client = ExchangeClient(config=SdkConfig(gateway_url="https://gateway.example"))
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(
        lambda request: httpx.Response(200, content=body)
    ))
    return client


@pytest.mark.parametrize("body", [b"{bad", b"\xff", b"", b"<html>proxy error</html>", b'"unknown"', b"[]", b"null", b"{}", b'{"code": "0"}'])
def test_malformed_submit_is_ambiguous_not_an_invented_engine_verdict(body):
    client = client_for(body)
    try:
        with pytest.raises(SubmissionPending) as caught:
            client.submit_action(b"mock-envelope")
        assert caught.value.tx_hash == hashlib.sha256(b"mock-envelope").hexdigest().upper()
        assert "reconcile" in str(caught.value)
    finally:
        client.close()


@pytest.mark.parametrize("body", [b"12: insufficient margin", b'"12: insufficient margin"'])
def test_recognized_legacy_engine_verdict_stays_terminal(body):
    client = client_for(body)
    try:
        with pytest.raises(EngineError) as caught:
            client.submit_action(b"mock-envelope")
        assert caught.value.code == 12
    finally:
        client.close()


@pytest.mark.parametrize("method,args", [("status", ()), ("history_fills", ("ab" * 20,)), ("account", ("ab" * 20,))])
def test_malformed_reads_raise_sdk_transport_error(method, args):
    client = client_for(b"{bad")
    try:
        with pytest.raises(TransportError, match="malformed JSON") as caught:
            getattr(client, method)(*args)
        assert caught.value.status_code == 200
        assert "{bad" not in str(caught.value)
    finally:
        client.close()


@pytest.mark.parametrize("body", [b"[]", b"null", b'"unexpected"'])
@pytest.mark.parametrize("method,args", [
    ("status", ()), ("history_fills", ("ab" * 20,)), ("account", ("ab" * 20,)),
    ("history_triggers", ("ab" * 20,)), ("history_trigger_markets", (1,)),
    ("position_triggers", ("ab" * 20,)),
])
def test_object_reads_reject_valid_json_of_the_wrong_shape(body, method, args):
    client = client_for(body)
    try:
        with pytest.raises(TransportError, match="expected a JSON object") as error:
            getattr(client, method)(*args)
        assert error.value.status_code == 200
    finally:
        client.close()


def test_list_read_retains_valid_list():
    client = client_for(b'[{"market":1}]')
    try:
        assert client.trades(1) == [{"market": 1}]
    finally:
        client.close()
