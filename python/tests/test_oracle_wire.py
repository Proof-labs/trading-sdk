"""Operator wire bindings only; no network, activation or provider proofs."""
import pytest
import proof_trading_sdk as sdk
from proof_trading_sdk import actions


def observation(**changes):
    fields = dict(market=7, policy_version=(1 << 64) - 1, source_id=2,
                  publish_time_ms=1_700_000_000_123, price_micro=(1 << 64) - 1,
                  confidence_micro=None, evidence_digest=bytes([0xA5]) * 32,
                  signer=bytes([0x22]) * 20)
    fields.update(changes)
    return sdk.SubmitOracleObservation(**fields)


@pytest.mark.parametrize("confidence", [None, 25000, (1 << 64) - 1])
def test_observation_roundtrip_exact_width_and_optional_confidence(confidence):
    action = observation(confidence_micro=confidence)
    tag, payload = actions.encode_action(action)
    assert tag == 0x2D
    assert actions.decode_action(tag, payload) == action.fields()


@pytest.mark.parametrize("changes", [
    {"evidence_digest": bytes(31)}, {"signer": bytes(21)}, {"source_id": 1 << 32},
    {"price_micro": 1 << 64}, {"confidence_micro": -1}, {"policy_version": True},
])
def test_invalid_observation_rejected_without_encoding(changes):
    with pytest.raises(ValueError):
        observation(**changes)


def test_policy_proposal_bytes_are_preserved_not_interpreted_as_approval():
    policy = sdk.ConfigureOraclePolicy(effective_height=123, bundle=b"\x91\xc0\xff")
    action = actions.RawAction(actions.ActionType.ProposeAdminAction, {
        "proposer": bytes(20), "registry_version": 1,
        "action": {"ConfigureOraclePolicy": policy.as_wire()},
    })
    tag, payload = actions.encode_action(action)
    decoded = actions.decode_action(tag, payload)
    # The pre-existing governance SignerAddress decode uses a tuple; the new
    # policy's variable bytes preserve their byte-string representation.
    assert bytes(decoded["proposer"]) == bytes(20)
    assert decoded["action"] == action.fields()["action"]
    assert actions.encode_action(actions.RawAction(tag, decoded))[1] == payload


@pytest.mark.parametrize("height,bundle", [(-1, b""), (True, b""), (123, [1, 2])])
def test_invalid_policy_wrapper_rejected(height, bundle):
    with pytest.raises(ValueError):
        sdk.ConfigureOraclePolicy(effective_height=height, bundle=bundle)
