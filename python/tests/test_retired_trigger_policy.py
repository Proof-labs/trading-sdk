"""Retired helpers are removed; low-level codecs retain the wire contract."""
import os
import json
from pathlib import Path

import msgpack
import pytest
import proof_trading_sdk as sdk
from proof_trading_sdk import _native, actions
from proof_trading_sdk.client import ExchangeClient

VECTOR = next(json.loads(line) for line in
    (Path(__file__).parents[2] / 'conformance/codec.ndjson').read_text().splitlines()
    if json.loads(line)['case'] == 'propose_admin_action/set_trigger_market_config')


def retired_cases():
    fields = VECTOR['input']
    payload = bytes.fromhex(VECTOR['expect']['payload_hex'])
    legacy_action = msgpack.unpackb(payload)[2]
    approval = dict(approver=list(bytes(20)), proposal_id=42, registry_version=3,
        threshold=2, proposer=fields['proposer'], created_height=7, created_ms=1000,
        expiry_ms=259201000, action=fields['action'], content_hash=list(bytes(32)))
    approval_payload = msgpack.packb([approval[k] if k != 'action' else legacy_action
        for k in ['approver', 'proposal_id', 'registry_version', 'threshold', 'proposer',
                  'created_height', 'created_ms', 'expiry_ms', 'action', 'content_hash']])
    return [(30, fields, payload), (31, approval, approval_payload)]


def test_removed_public_surface():
    assert not hasattr(ExchangeClient, 'trigger_market_configs')
    assert not hasattr(actions, 'SetTriggerMarketConfig')
    assert not hasattr(sdk, 'SetTriggerMarketConfig')


@pytest.mark.parametrize('tag,fields,payload', retired_cases())
def test_low_level_codec_defers_policy_to_engine(tag, fields, payload):
    assert 'SetTriggerMarketConfig' in _native.decode_action(tag, payload)['action']
    encoded_tag, encoded = actions.encode_action(actions.RawAction(tag, fields))
    assert encoded_tag == tag and bytes(encoded) == payload
    for envelope in (
        _native.sign_and_encode(bytes(32), tag, payload, 1, bytes(32)),
        _native.encode_signed_tx(tag, payload, 1, bytes(32), bytes(64)),
    ):
        decoded = sdk.decode_tx(bytes(envelope))
        assert decoded['action_type'] == tag and decoded['payload'] == payload
    read_fd, write_fd = os.pipe()
    os.write(write_fd, bytes(32))
    os.close(write_fd)
    handle = sdk.load_key_from_fd(read_fd)
    assert sdk.decode_tx(handle.sign_and_encode(bytes(32), tag, payload, 1))['payload'] == payload
