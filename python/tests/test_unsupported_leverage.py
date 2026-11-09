"""Unsupported SDK creation must not remove historical wire decoding."""
import json
import os
from pathlib import Path
from unittest.mock import Mock

import pytest
import proof_trading_sdk as sdk
from proof_trading_sdk import _native, actions

_VECTOR = json.loads((Path(__file__).parents[2] / "conformance/historical-codec.ndjson").read_text())
_PAYLOAD = bytes.fromhex(_VECTOR["expect"]["payload_hex"])
_ENVELOPE = bytes.fromhex(_VECTOR["expect"]["envelope_hex"])
_REFUSAL = "SetUserMarketLeverage .* is not supported"


def test_no_public_builder_or_supported_action_type():
    assert not hasattr(sdk, "SetUserMarketLeverage")
    assert not hasattr(actions, "SetUserMarketLeverage")
    assert not hasattr(actions.ActionType, "SetUserMarketLeverage")
    assert not any(row["code"] == 0x16 for row in _native.get_action_types())


@pytest.mark.parametrize("call", [
    lambda: actions.encode_action(actions.RawAction(0x16, _VECTOR["input"])),
    lambda: _native.encode_action(0x16, _VECTOR["input"]),
    lambda: _native.encode_action(0x16, None),
    lambda: sdk.sign_and_encode(bytes(32), 0x16, _PAYLOAD, 1, bytes([0x42]) * 32),
    lambda: _native.encode_signed_tx(0x16, _PAYLOAD, 1, bytes(32), bytes(64)),
])
def test_generic_creation_entrypoints_refuse(call):
    with pytest.raises(ValueError, match=_REFUSAL):
        call()


def test_opaque_signing_handle_refuses():
    reader, writer = os.pipe()
    os.write(writer, bytes([0x42]) * 32)
    os.close(writer)
    handle = sdk.load_key_from_fd(reader)
    with pytest.raises(ValueError, match=_REFUSAL):
        handle.sign_and_encode(bytes(32), 0x16, _PAYLOAD, 1)


def test_frozen_history_still_decodes():
    fields = actions.decode_action(0x16, _PAYLOAD)
    assert bytes(fields["owner"]) == bytes(_VECTOR["input"]["owner"])
    assert fields["market"] == 7
    assert fields["user_im_bps"] == 2000
    decoded = sdk.decode_tx(_ENVELOPE)
    assert decoded["action_type"] == 0x16
    assert decoded["payload"] == _PAYLOAD


def test_client_refuses_before_submission(monkeypatch):
    client = sdk.ExchangeClient(gateway_url="http://unused.invalid", secret_key=bytes([0x42]) * 32)
    submit = Mock(side_effect=AssertionError("must not submit unsupported action"))
    monkeypatch.setattr(client, "submit_action", submit)
    try:
        with pytest.raises(ValueError, match=_REFUSAL):
            client.submit(actions.RawAction(0x16, _VECTOR["input"]))
        submit.assert_not_called()
    finally:
        client.close()
