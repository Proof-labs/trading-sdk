"""Historical legacy trigger-policy decoding remains supported."""
import pytest
from proof_trading_sdk.errors import ProofTradingSdkError
from proof_trading_sdk.trigger_config import decode_trigger_market_config_infos


def test_decodes_lossless_current_and_pending_policy():
    accepted = 9_007_199_254_740_992
    rows = decode_trigger_market_config_infos([[7, [[4, True, 250, 5000, 1000, 32],
        [[5, True, 200, 4000, 900, 64], accepted, accepted + 1]]]])
    assert rows[0].state.current.max_trigger_slippage_bps == 250
    assert rows[0].state.pending.accepted_height == accepted
    assert rows[0].state.pending.effective_height == accepted + 1


@pytest.mark.parametrize(
    "value,match",
    [
        ([[7, [None, None]]], "empty trigger market"),
        (
            [
                [7, [[1, False, 0, 0, 0, 0], None]],
                [7, [[1, False, 0, 0, 0, 0], None]],
            ],
            "strictly market-sorted",
        ),
        (
            [
                [
                    7,
                    [
                        [1, False, 0, 0, 0, 0],
                        [[3, True, 1, 1, 1, 1], 10, 11],
                    ],
                ]
            ],
            "version is not next",
        ),
    ],
)
def test_decoder_refuses_corrupt_policy(value, match):
    with pytest.raises(ProofTradingSdkError, match=match):
        decode_trigger_market_config_infos(value)
