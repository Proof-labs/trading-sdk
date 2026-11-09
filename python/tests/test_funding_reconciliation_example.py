"""Executable funding reference: signed rounding and missing-data refusal."""

from copy import deepcopy
from pathlib import Path
import runpy

import pytest

EXAMPLE = runpy.run_path(str(Path(__file__).parents[1] / "examples" / "reconcile_funding.py"))
payment = EXAMPLE["accrued_payment"]
reconcile = EXAMPLE["reconcile"]
OWNER = "11" * 20
LAST = 727_219_862_587_400
CURRENT = 727_391_420_303_900


@pytest.mark.parametrize("delta,size,decimals,long,short", [
    (171_557_716_500, 1, 2, -1716, 1715),
    (-171_557_716_500, 1, 2, 1715, -1716),
    (1, 1, 0, -1, 0),
    (200_000_000, 100, 2, -200, 200),
    (0, 7, 18, 0, 0),
])
def test_signed_fractional_unit_examples(delta, size, decimals, long, short):
    assert payment("Buy", size, 0, delta, decimals) == long
    assert payment("Sell", size, 0, delta, decimals) == short


def event(kind, **attributes):
    return {"type": kind, "attributes": [
        {"key": key, "value": str(value)} for key, value in attributes.items()
    ]}


class FakeClient:
    def __init__(self):
        self.configs = [{"market": 3, "kind": "Perp", "sz_decimals": 2}]
        self.block = {"result": {
            "height": "10013501",
            "finalize_block_events": [
                event("funding_applied", market=3, funding_rate_bps=19, cumulative_funding=CURRENT),
                event("funding_settled", market=3, owner=OWNER, payment=-1716),
            ],
        }}

    def markets(self):
        return self.configs

    def get_block_results(self, height):
        assert height == 10013501
        return self.block


def run(client):
    return reconcile(client, height=10013501, market=3, owner=OWNER,
                     side="Buy", raw_size=1, last_index=LAST)


def test_reported_payment_is_reproduced_without_reading_an_expected_mark():
    report = run(FakeClient())
    assert report["full_accrued_payment_micro_usdc"] == -1716
    assert report["settled_payment_micro_usdc"] == -1716
    assert report["full_payment_matches_event"]


@pytest.mark.parametrize("market", [1 << 31, (1 << 32) - 1])
def test_node_reads_accept_the_wire_unsigned_market_id_range(market):
    c = FakeClient()
    c.configs[0]["market"] = market
    for e in c.block["result"]["finalize_block_events"]:
        for attribute in e["attributes"]:
            if attribute["key"] == "market":
                attribute["value"] = str(market)
    report = reconcile(c, height=10013501, market=market, owner=OWNER,
                       side="Buy", raw_size=1, last_index=LAST)
    assert report["market"] == market
    assert report["full_payment_matches_event"]


def test_observed_payment_is_not_an_input_to_expected_arithmetic():
    c = FakeClient()
    c.block["result"]["finalize_block_events"][1] = event(
        "funding_settled", market=3, owner=OWNER, payment=-100,
    )
    report = run(c)
    assert report["full_accrued_payment_micro_usdc"] == -1716
    assert report["settled_payment_micro_usdc"] == -100
    assert not report["full_payment_matches_event"]


@pytest.mark.parametrize("invalid", [None, -1, 19, True, 2.5])
def test_missing_or_invalid_scale_never_defaults_to_zero(invalid):
    c = FakeClient()
    c.configs[0]["sz_decimals"] = invalid
    with pytest.raises(ValueError, match="sz_decimals"):
        run(c)


@pytest.mark.parametrize("change", ["missing_applied", "missing_settled", "wrong_owner", "duplicate", "wrong_height"])
def test_missing_or_ambiguous_evidence_is_not_a_verified_zero(change):
    c = FakeClient()
    events = c.block["result"]["finalize_block_events"]
    if change == "missing_applied":
        events.pop(0)
    elif change == "missing_settled":
        events.pop()
    elif change == "wrong_owner":
        events[-1] = event("funding_settled", market=3, owner="22" * 20, payment=-1716)
    elif change == "duplicate":
        events.append(deepcopy(events[-1]))
    else:
        c.block["result"]["height"] = "10013502"
    with pytest.raises(ValueError):
        run(c)


def test_duplicate_event_attribute_is_rejected():
    c = FakeClient()
    attrs = c.block["result"]["finalize_block_events"][0]["attributes"]
    attrs.append({"key": "cumulative_funding", "value": "0"})
    with pytest.raises(ValueError, match="duplicate"):
        run(c)


@pytest.mark.parametrize("args", [
    ("Long", 1, LAST, CURRENT, 2),
    ("Buy", -1, LAST, CURRENT, 2),
    ("Buy", True, LAST, CURRENT, 2),
    ("Buy", 1, -(1 << 63) - 1, CURRENT, 2),
    ("Buy", (1 << 64) - 1, -(1 << 63), (1 << 63) - 1, 18),
    ("Buy", (1 << 64) - 1, 0, (1 << 63) - 1, 0),
])
def test_invalid_inputs_and_engine_overflow_bounds_are_rejected(args):
    with pytest.raises(ValueError):
        payment(*args)


@pytest.mark.parametrize("rate", [3001, -3001, (1 << 63) - 1, -(1 << 63)])
def test_informational_rate_does_not_gate_index_reconciliation(rate):
    c = FakeClient()
    c.block["result"]["finalize_block_events"][0] = event(
        "funding_applied", market=3, funding_rate_bps=rate, cumulative_funding=CURRENT,
    )
    report = run(c)
    assert report["funding_rate_bps"] == rate
    assert report["full_payment_matches_event"]


@pytest.mark.parametrize("change", [
    {"side": "Long"}, {"raw_size": True}, {"raw_size": -1}, {"last_index": 1 << 63},
])
def test_invalid_position_inputs_refuse_before_network_reads(change):
    class NoReads:
        def markets(self):
            raise AssertionError("invalid input must not issue reads")

    args = dict(height=10013501, market=3, owner=OWNER, side="Buy", raw_size=1, last_index=LAST)
    args.update(change)
    with pytest.raises(ValueError):
        reconcile(NoReads(), **args)
