"""Callbacks see canonical bytes; only verified results can reach transport."""
import base64
import json
import threading
import traceback
from pathlib import Path

import httpx
import msgpack
import pytest

from proof_trading_sdk import CodecError, ExchangeClient, ExternalSigner, SdkConfig, SigningError, _native
from proof_trading_sdk.actions import CancelAllOrders

ROOT = Path(__file__).parents[2]
VECTOR = json.loads((ROOT / "conformance/signing.ndjson").read_text().splitlines()[0])
AUTH = json.loads((Path(__file__).parent / "fixtures/account_ws_auth.json").read_text())
SEED = bytes(range(32))
KEY = bytes.fromhex(AUTH["public_key"])
CHAIN = bytes.fromhex(AUTH["chain_id"])
TX_DOMAIN = b"ProofExchange-v3"
AUTH_DOMAIN = b"ProofExchange-account-events-v1"


def sign(message):
    """Synthetic device for lifecycle tests; fixed independent vectors below pin bytes."""
    assert type(message) is bytes
    if message.startswith(TX_DOMAIN):
        p = len(TX_DOMAIN)
        envelope = _native.sign_and_encode(
            message[p:p + 32], message[p + 32], message[p + 41:],
            int.from_bytes(message[p + 33:p + 41], "big"), SEED,
        )
        return msgpack.unpackb(envelope)[5]
    assert message.startswith(AUTH_DOMAIN)
    p = len(AUTH_DOMAIN)
    return _native.sign_account_ws_auth(
        message[p:p + 32], int.from_bytes(message[-8:], "big"), SEED,
        int.from_bytes(message[-16:-8], "big"),
    )


@pytest.fixture
def client():
    c = ExchangeClient(config=SdkConfig(gateway_url="https://gateway.example"), chain_id=CHAIN)
    try:
        c.set_external_signer(ExternalSigner(KEY, sign))
        yield c
    finally:
        c.close()


def test_transaction_matches_shared_fixed_wire_vector(client, monkeypatch):
    expected = bytes.fromhex(VECTOR["expect_envelope_hex"])
    public_key, signature = msgpack.unpackb(expected)[4:]
    payload = bytes.fromhex(VECTOR["payload_hex"])
    chain = bytes(VECTOR["chain_id"])
    expected_message = (TX_DOMAIN + chain + bytes([VECTOR["action_type"]])
                        + VECTOR["seq"].to_bytes(8, "big") + payload)

    def callback(message):
        assert message == expected_message
        return signature

    client._chain_id = chain
    monkeypatch.setattr(client._nonce, "allocate", lambda: VECTOR["seq"])
    client.set_external_signer(ExternalSigner(public_key, callback))
    assert client.sign_and_encode_action(VECTOR["action_type"], payload) == expected


@pytest.mark.parametrize("cursor", [0, 7, (1 << 53) - 1])
def test_auth_matches_independently_signed_gateway_vector(client, monkeypatch, cursor):
    monkeypatch.setattr("time.time_ns", lambda: AUTH["timestamp_ms"] * 1_000_000)
    signature = bytes.fromhex(AUTH["signature"] if cursor == 0 else AUTH["cursor_signatures"][str(cursor)])

    def callback(message):
        assert message == (AUTH_DOMAIN + CHAIN + AUTH["owner"].encode()
                           + cursor.to_bytes(8, "big") + AUTH["timestamp_ms"].to_bytes(8, "big"))
        return signature

    client.set_external_signer(ExternalSigner(KEY, callback))
    result = client.account_auth(after_id=cursor)
    assert result["signature"] == signature.hex()
    assert result["public_key"] == AUTH["public_key"]
    assert result.get("after_id", 0) == cursor


def test_typed_action_owner_and_submit_use_external_connection(client, monkeypatch):
    owner = bytes.fromhex(AUTH["owner"])
    assert client._own_owner() == owner
    action = CancelAllOrders(owner=owner)
    expected = client.sign_action(action)
    assert msgpack.unpackb(expected)[4] == KEY
    sent = []
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(
        lambda request: sent.append(request.content) or httpx.Response(200, json={"code": 0, "hash": "A" * 64})
    ))
    client.submit(action)
    assert len(sent) == 1
    assert msgpack.unpackb(base64.b64decode(json.loads(sent[0])["action"]))[4] == KEY


def test_snapshots_payload_public_key_and_callable(client):
    mutable_key, payload = bytearray(KEY), bytearray(b"payload")
    messages = []

    def callback(message):
        messages.append(message)
        payload[:] = b"changed"
        return bytearray(sign(message))

    client.set_external_signer(ExternalSigner(mutable_key, callback))
    mutable_key[:] = bytes(32)
    envelope = client.sign_and_encode_action(1, payload)
    assert msgpack.unpackb(envelope)[3] == b"payload"
    assert msgpack.unpackb(envelope)[4] == KEY
    assert messages[0].endswith(b"payload")


def test_setting_callback_drops_secret_and_opaque_handle(client):
    client._secret_key = SEED
    client._key_handle = object()
    client.set_external_signer(ExternalSigner(KEY, sign))
    assert client._secret_key is client._key_handle is None


@pytest.mark.parametrize("operation", ["transaction", "auth"])
def test_reentrant_connection_replacement_discards_signature(client, operation):
    def callback(message):
        client.set_external_signer(ExternalSigner(KEY, sign))
        return sign(message)

    client.set_external_signer(ExternalSigner(KEY, callback))
    with pytest.raises(SigningError, match="connection changed"):
        if operation == "auth":
            client.account_auth()
        else:
            client.sign_and_encode_action(1, b"payload")


def test_cross_thread_replacement_discards_pending_result(client):
    started, release = threading.Event(), threading.Event()
    errors = []

    def callback(message):
        started.set()
        assert release.wait(2)
        return sign(message)

    def worker():
        try:
            client.sign_and_encode_action(1, b"payload")
        except SigningError as error:
            errors.append(str(error))

    client.set_external_signer(ExternalSigner(KEY, callback))
    thread = threading.Thread(target=worker)
    thread.start()
    try:
        assert started.wait(1)
        client.set_external_signer(ExternalSigner(KEY, sign))
    finally:
        release.set()
        thread.join(2)
    assert not thread.is_alive()
    assert errors == ["signing connection changed"]


@pytest.mark.parametrize("result", [None, "secret", [0] * 64, bytes(63), bytes(65), bytes(64)])
@pytest.mark.parametrize("operation", ["transaction", "auth"])
def test_invalid_callback_result_is_never_sent(client, result, operation):
    client.set_external_signer(ExternalSigner(KEY, lambda _: result))
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(lambda _: pytest.fail("invalid signature sent")))
    with pytest.raises(SigningError, match="invalid signature"):
        if operation == "auth":
            client.account_auth()
        else:
            client.submit(CancelAllOrders(owner=client._own_owner()))


@pytest.mark.parametrize("operation", ["transaction", "auth"])
def test_callback_exceptions_are_sanitized_without_retry(client, caplog, operation):
    calls = []

    def callback(message):
        calls.append(message)
        raise RuntimeError("sensitive wallet error text")

    client.set_external_signer(ExternalSigner(KEY, callback))
    with pytest.raises(SigningError) as error:
        if operation == "auth":
            client.account_auth()
        else:
            client.sign_and_encode_action(1, b"payload")
    assert len(calls) == 1
    if operation == "transaction":
        assert client._nonce.peek() > 0
    assert error.value.__context__ is error.value.__cause__ is None
    assert "sensitive wallet error text" not in "".join(traceback.format_exception(error.value))
    assert not caplog.text


def test_valid_signature_for_different_message_is_refused(client):
    client.set_external_signer(ExternalSigner(KEY, lambda message: sign(message + b"changed")))
    with pytest.raises(SigningError, match="invalid signature"):
        client.sign_and_encode_action(1, b"payload")


def test_callback_result_conversion_errors_are_redacted(client):
    class BrokenBytes(bytes):
        def __bytes__(self):
            raise RuntimeError("sensitive conversion error")

    client.set_external_signer(ExternalSigner(KEY, lambda _: BrokenBytes(64)))
    with pytest.raises(SigningError, match="invalid signature") as error:
        client.sign_and_encode_action(1, b"payload")
    assert error.value.__context__ is error.value.__cause__ is None


def test_encoder_policy_refusal_precedes_callback(client, monkeypatch):
    client.set_external_signer(ExternalSigner(KEY, lambda _: pytest.fail("refused action signed")))

    def refuse(*_):
        raise ValueError("action unavailable")

    monkeypatch.setattr("proof_trading_sdk.client.encode_signed_tx", refuse)
    with pytest.raises(CodecError, match="action unavailable"):
        client.sign_and_encode_action(1, b"payload")


def test_concurrent_callbacks_reserve_distinct_nonces(client, monkeypatch):
    monkeypatch.setattr(client._nonce, "_now_ms", lambda: 1000)
    barrier = threading.Barrier(2)
    results = []

    def callback(message):
        barrier.wait(timeout=2)
        return sign(message)

    client.set_external_signer(ExternalSigner(KEY, callback))
    threads = [threading.Thread(target=lambda: results.append(client.sign_and_encode_action(1, b"payload"))) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(3)
        assert not thread.is_alive()
    assert sorted(msgpack.unpackb(result)[2] for result in results) == [1000, 1001]


def test_base_exceptions_are_not_wrapped(client):
    def callback(_):
        raise KeyboardInterrupt

    client.set_external_signer(ExternalSigner(KEY, callback))
    with pytest.raises(KeyboardInterrupt):
        client.sign_and_encode_action(1, b"payload")


@pytest.mark.parametrize("key", [bytes(31), bytes(33), "00" * 32, None])
def test_bad_connection_does_not_replace_current_signer(client, key):
    with pytest.raises(SigningError):
        client.set_external_signer(ExternalSigner(key, sign))
    assert client._own_owner() == bytes.fromhex(AUTH["owner"])


def test_async_callbacks_are_explicitly_refused(client):
    async def callback(_):
        return bytes(64)

    with pytest.raises(SigningError):
        client.set_external_signer(ExternalSigner(KEY, callback))
    client.set_external_signer(ExternalSigner(KEY, lambda message: callback(message)))
    with pytest.raises(SigningError, match="invalid signature"):
        client.sign_and_encode_action(1, b"payload")


def test_foreign_auth_owner_is_refused_before_callback(client):
    client.set_external_signer(ExternalSigner(KEY, lambda _: pytest.fail("foreign owner signed")))
    with pytest.raises(SigningError, match="owner"):
        client.account_auth(bytes(20))


def test_stream_calls_current_external_signer_for_each_auth_attempt(client, monkeypatch):
    import proof_trading_sdk.streams as streams
    captured, messages = {}, []

    def callback(message):
        messages.append(message)
        return sign(message)

    client.set_external_signer(ExternalSigner(KEY, callback))
    monkeypatch.setattr(streams, "AccountEventStream", lambda *args, **kwargs: captured.update(kwargs))
    client.account_event_stream(client._own_owner())
    monkeypatch.setattr("time.time_ns", lambda: 1000 * 1_000_000)
    captured["auth"]()
    monkeypatch.setattr("time.time_ns", lambda: 1001 * 1_000_000)
    captured["auth"]()
    assert messages[0] != messages[1]
    client.set_external_signer(ExternalSigner(KEY, lambda _: (_ for _ in ()).throw(RuntimeError("denied"))))
    with pytest.raises(SigningError, match="callback failed"):
        captured["auth"]()


def test_an_unbound_chain_never_reaches_the_wallet():
    calls = []

    def wallet(message):
        calls.append(message)
        return bytes(64)

    c = ExchangeClient(config=SdkConfig(gateway_url="https://gateway.example"))
    try:
        c.set_external_signer(ExternalSigner(KEY, wallet))
        with pytest.raises(SigningError, match="chain_id not configured"):
            c.sign_and_encode_action(2, b"payload")
    finally:
        c.close()
    assert calls == []


def test_a_released_public_key_view_is_a_signing_error(client):
    view = memoryview(KEY)
    view.release()
    with pytest.raises(SigningError):
        client.set_external_signer(ExternalSigner(view, sign))
