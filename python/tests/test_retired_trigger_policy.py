"""Retired helpers are removed; low-level codecs retain the wire contract."""
import os
import json
from pathlib import Path

import msgpack
import pytest
import proof_trading_sdk as sdk
from proof_trading_sdk import _native, actions
from proof_trading_sdk.client import ExchangeClient

VECTOR_CASE = 'propose_admin_action/set_trigger_market_config'
VECTOR = next((value for line in
    (Path(__file__).parents[2] / 'conformance/codec.ndjson').read_text().splitlines()
    if (value := json.loads(line))['case'] == VECTOR_CASE), None)
assert VECTOR is not None, f'Missing conformance case: {VECTOR_CASE}'


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


def test_engine_slippage_ceiling_is_advisory_and_within_wire_bound():
    # Mirrors exchange-core TRIGGER_SLIPPAGE_CEILING_BPS; encoding does not enforce it.
    assert sdk.ENGINE_TRIGGER_SLIPPAGE_CEILING_BPS == 1_000
    assert sdk.ENGINE_TRIGGER_SLIPPAGE_CEILING_BPS < sdk.MAX_TRIGGER_SLIPPAGE_BPS == 9_999


@pytest.mark.parametrize('tag,fields,payload', retired_cases())
def test_typed_builders_refuse_decoded_retired_actions(tag, fields, payload):
    builder = sdk.ProposeAdminAction if tag == 30 else sdk.ApproveAdminAction
    decoded = _native.decode_action(tag, payload)
    with pytest.raises(ValueError, match='retired'):
        builder(**decoded)


@pytest.mark.parametrize('tag,fields,payload', retired_cases())
@pytest.mark.parametrize('in_place', [False, True])
def test_typed_builders_recheck_mutated_actions_before_encoding(tag, fields, payload, in_place):
    builder = sdk.ProposeAdminAction if tag == 30 else sdk.ApproveAdminAction
    action = builder(**{**fields, 'action': {'SetMarketStatus': {'market': 7, 'status': 'ReduceOnly'}}})
    if in_place:
        action.action.clear()
        action.action.update(fields['action'])
    else:
        action.action = fields['action']
    with pytest.raises(ValueError, match='retired'):
        actions.encode_action(action)


@pytest.mark.parametrize('action,expected', [
    ('UnpauseBridge', True),
    ({'SetMarketStatus': {'market': 7, 'status': 'ReduceOnly'}}, True),
    ({'SetTriggerMarketConfig': {}}, False),
    ('SetTriggerMarketConfig', False),
    ({}, False),
    ({'UnpauseBridge': {}, 'SetTriggerMarketConfig': {}}, False),
    ({1: {}}, False),
    (None, False),
])
def test_public_admin_guard(action, expected):
    assert sdk.is_submittable_admin_action(action) is expected


@pytest.mark.parametrize('tag,fields,payload', retired_cases())
@pytest.mark.parametrize('admin_action', ['UnpauseBridge', {'SetMarketStatus': {'market': 7, 'status': 'ReduceOnly'}}])
def test_typed_current_admin_actions_still_encode(tag, fields, payload, admin_action):
    builder = sdk.ProposeAdminAction if tag == 30 else sdk.ApproveAdminAction
    encoded_tag, encoded = actions.encode_action(builder(**{**fields, 'action': admin_action}))
    assert encoded_tag == tag
    assert _native.decode_action(tag, bytes(encoded))['action'] == admin_action


@pytest.mark.parametrize('tag,fields,payload', retired_cases())
@pytest.mark.parametrize('malformed', [None, {}, {'kind': 'SetMarketStatus', 'value': {}}, {1: {}}])
def test_typed_builders_distinguish_malformed_from_retired(tag, fields, payload, malformed):
    builder = sdk.ProposeAdminAction if tag == 30 else sdk.ApproveAdminAction
    with pytest.raises(ValueError, match='kind string or a single-key dict'):
        builder(**{**fields, 'action': malformed})
