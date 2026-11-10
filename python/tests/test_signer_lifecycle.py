"""Owner selection and authentication stay bound to the signing connection."""

import threading

import msgpack
import pytest

from proof_trading_sdk import ExchangeClient, ExternalSigner, SigningError, _native
from proof_trading_sdk.actions import TriggerLimb
from test_account_auth import CHAIN, OWNER, SEED
from test_ws_streams import FakeSocket

OTHER_SEED = bytes([42]) * 32
OTHER_PUBLIC_KEY = _native.generate_keypair(OTHER_SEED)["public_key"]


def replacement(c, calls):
    def sign(message):
        calls.append(message)
        offset = len(b"ProofExchange-v3")
        envelope = _native.sign_and_encode(
            message[offset:offset + 32], message[offset + 32], message[offset + 41:],
            int.from_bytes(message[offset + 33:offset + 41], "big"), OTHER_SEED,
        )
        return msgpack.unpackb(envelope)[5]

    c.set_external_signer(ExternalSigner(OTHER_PUBLIC_KEY, sign))


@pytest.mark.parametrize("operation", ["set", "cancel"])
@pytest.mark.parametrize("explicit_owner", [False, True])
def test_replacement_after_owner_selection_never_signs_or_submits(monkeypatch, operation, explicit_owner):
    import proof_trading_sdk.client as module

    c = ExchangeClient(gateway_url="https://gateway.example", chain_id=CHAIN, secret_key=SEED)
    selected, release = threading.Event(), threading.Event()
    original_encode = module.encode_action
    errors, encoded_owners, signed, submitted = [], [], [], []

    def encode(action):
        encoded_owners.append(action.owner)
        selected.set()
        assert release.wait(2)
        return original_encode(action)

    def run():
        try:
            kwargs = {"owner": bytes.fromhex(OWNER)} if explicit_owner else {}
            if operation == "set":
                c.set_position_triggers(7, 3, stop_loss=TriggerLimb(95_000, 75), **kwargs)
            else:
                c.cancel_position_triggers(7, 3, **kwargs)
        except Exception as error:
            errors.append(error)

    monkeypatch.setattr(module, "encode_action", encode)
    monkeypatch.setattr(c, "submit_action", lambda envelope: submitted.append(envelope))
    worker = threading.Thread(target=run)
    try:
        worker.start()
        assert selected.wait(2)
        replacement(c, signed)
    finally:
        release.set()
        worker.join(2)
        c.close()
    assert not worker.is_alive()
    assert encoded_owners == [bytes.fromhex(OWNER)]
    assert len(errors) == 1 and isinstance(errors[0], SigningError)
    assert str(errors[0]) == "signing connection changed"
    assert signed == submitted == []


@pytest.mark.parametrize("opaque", [False, True])
@pytest.mark.parametrize("operation", ["transaction", "auth"])
def test_replacement_during_local_signing_discards_result(monkeypatch, opaque, operation):
    import proof_trading_sdk.client as module

    c = ExchangeClient(gateway_url="https://gateway.example", chain_id=CHAIN, secret_key=SEED)
    calls = []

    def tx(chain, action_type, payload, seq, *secret):
        result = _native.sign_and_encode(chain, action_type, payload, seq, SEED)
        replacement(c, calls)
        return result

    def auth(chain, timestamp, *args):
        result = _native.sign_account_ws_auth(chain, timestamp, SEED, 0)
        replacement(c, calls)
        return result

    if opaque:
        class Handle:
            owner = bytes.fromhex(OWNER)
            public_key = _native.generate_keypair(SEED)["public_key"]
            sign_and_encode = staticmethod(tx)
            sign_account_ws_auth = staticmethod(auth)

        c._secret_key = None
        c._key_handle = Handle()
    else:
        monkeypatch.setattr(module, "sign_and_encode", tx)
        monkeypatch.setattr(module, "sign_account_ws_auth", auth)
    try:
        with pytest.raises(SigningError, match="connection changed"):
            if operation == "auth":
                c.account_auth()
            else:
                c.sign_and_encode_action(1, b"payload")
        assert calls == []
    finally:
        c.close()


def test_stream_created_before_signer_uses_it_on_next_subscription():
    from test_external_signer import KEY, sign

    c = ExchangeClient(gateway_url="https://gateway.example", chain_id=CHAIN, api_key="test-key")
    stream = c.account_event_stream(OWNER)
    socket = FakeSocket([])
    stream._ws = socket
    try:
        assert list(stream._subscribe()) == []
        assert "signature" not in socket.sent[0]["params"]
        c.set_external_signer(ExternalSigner(KEY, sign))
        assert list(stream._subscribe()) == []
        signed = socket.sent[1]["params"]
        assert signed["owner"] == OWNER
        assert signed["public_key"] == KEY.hex()
        message = _native.account_ws_auth_message(CHAIN, KEY, signed["timestamp_ms"], 0)
        assert _native.verify_raw_signature(KEY, bytes.fromhex(signed["signature"]), message)
    finally:
        stream.close()
        c.close()


def test_late_signer_for_different_owner_never_falls_back_to_api_key():
    c = ExchangeClient(gateway_url="https://gateway.example", chain_id=CHAIN, api_key="test-key")
    stream = c.account_event_stream(OWNER)
    socket = FakeSocket([])
    stream._ws = socket
    called = []
    replacement(c, called)
    try:
        frames = list(stream._subscribe())
        assert len(frames) == 1 and "owner does not match" in frames[0]["error"]
        assert socket.sent == [] and called == []
    finally:
        stream.close()
        c.close()
