import json
from collections import UserList
from dataclasses import asdict
from pathlib import Path

import httpx
import pytest
import proof_trading_sdk as sdk


def stats():
    return json.loads((Path(__file__).parents[2] / "conformance/market-stats.json").read_text())


def test_stats_interest_type_does_not_shadow_existing_snapshot_type():
    from proof_trading_sdk.markets_snapshot import MarketOpenInterest
    result = sdk.decode_market_stats_response(stats())
    assert isinstance(result.markets[0].open_interest, sdk.MarketStatsOpenInterest)
    assert sdk.MarketOpenInterest is MarketOpenInterest
    assert sdk.MarketStatsOpenInterest is not sdk.MarketOpenInterest


def test_market_stats_shared_ts_precision_fixture():
    assert asdict(sdk.decode_market_stats_response(stats())) == stats()


def test_json_integral_numbers_match_ts_and_return_typed_ints():
    value = stats(); value["stale_after_seconds"] = 60.0
    value["markets"][0].update(market=0.0, sz_decimals=18.0)
    result = sdk.decode_market_stats_response(value)
    assert type(result.stale_after_seconds) is int
    assert type(result.markets[0].market) is int and type(result.markets[0].sz_decimals) is int
    assert asdict(result) == stats()


def test_market_stats_absence_and_zero_remain_distinct():
    value = stats(); value.update(indexed_height=None, indexed_at=None, status="unavailable")
    row = value["markets"][0]
    row.update(status="stale", sz_decimals=None, unavailable_reason="metadata", volume_24h_contracts="0",
               volume_24h_usdc="0", reference_price=None, change_24h_bps=None, high_price=None, low_price=None,
               open_interest=None, open_interest_unavailable_reason="history_incomplete")
    assert asdict(sdk.decode_market_stats_response(value)) == value


@pytest.mark.parametrize("start,end", [
    ("0000-01-01T00:00:00Z", "0000-01-02T00:00:00Z"),
    ("2026-11-08T09:00:00+09:00", "2026-11-09T00:00:00Z"),
])
def test_valid_window_timestamps_match_ts(start, end):
    value=stats(); value.update(window_start=start,window_end=end,as_of=end)
    assert sdk.decode_market_stats_response(value).window_start == start


@pytest.mark.parametrize("field,value", [
    ("market", True), ("market", -1), ("market", 2**31), ("sz_decimals", 19), ("sz_decimals", False),
    ("status", "unknown"), ("unavailable_reason", 1), ("volume_24h_contracts", 1),
    ("volume_24h_contracts", "01"), ("volume_24h_contracts", "-1"), ("volume_24h_contracts", "1\n"),
    ("volume_24h_usdc", "1e3"), ("volume_24h_usdc", "1."), ("volume_24h_usdc", "0."+"1"*25),
    ("change_24h_bps", "0.0000001"), ("change_24h_bps", "+1"), ("open_interest", {}),
])
def test_stats_bad_rows(field,value):
    body=stats(); body["markets"][0][field]=value
    with pytest.raises(sdk.CodecError): sdk.decode_market_stats_response(body)


@pytest.mark.parametrize("field,value", [("indexed_height", "0"), ("indexed_height", None),
    ("indexed_at", None), ("stale_after_seconds", True), ("stale_after_seconds", 2**53),
    ("stale_after_seconds", 0), ("markets", []), ("markets", {}), ("as_of", "bad"),
    ("window_start", "2026-09-21T12:34:56Z"), ("status", None)])
def test_stats_bad_response(field,value):
    body=stats(); body[field]=value
    with pytest.raises(sdk.CodecError): sdk.decode_market_stats_response(body)


def test_stats_missing_fields_duplicate_markets_and_unknown_extensions():
    body=stats(); del body["markets"][0]["reference_price"]
    with pytest.raises(sdk.CodecError): sdk.decode_market_stats_response(body)
    body=stats(); body["markets"]*=2
    with pytest.raises(sdk.CodecError): sdk.decode_market_stats_response(body)
    body=stats(); body["future"]=1; body["markets"][0]["future"]=True
    assert asdict(sdk.decode_market_stats_response(body)) == stats()


def disabled(): return {"status":"ok","embedded_feeder":False,"note":"not enabled"}
def f16(): return {"source":"f16-relay","ready":False,"submit_enabled":True,
                   "journal_healthy":{"primary":True},"divergence_bps":{"3":2**64-1}}
def freshness(): return {"status":"ok","embedded_feeder":True,"ready":False,"submit_enabled":True,
                         "source":"embedded","updated_at_unix_ms":9007199254740993,
                         "markets":{"3":{"market":3,"status":"stale","stale_seconds":71.1,"diagnostic":"kept"}},
                         "inventory":{"markets":[3]}}


def test_oracle_disabled_is_not_inferred_ready_or_fresh():
    result=sdk.decode_oracle_health(disabled())
    assert result.status == "ok" and result.embedded_feeder is False
    assert result.ready is None and result.markets is None and result.source is None


def test_oracle_f16_and_slim_route_preserve_optional_maps():
    result=sdk.decode_oracle_health(f16())
    assert result.ready is False and result.submit_enabled is True
    assert result.status is None and result.markets is None
    assert result.divergence_bps == {3:2**64-1} and result.journal_healthy == {"primary":True}
    value=f16(); del value["journal_healthy"]; del value["divergence_bps"]
    assert sdk.decode_oracle_health(value).divergence_bps is None


@pytest.mark.parametrize("factory", [disabled, f16, freshness])
@pytest.mark.parametrize("field", ["note", "error", "updated_at_unix_ms"])
def test_oracle_nullable_diagnostics_match_absent_fields(factory, field):
    body = factory()
    body.pop(field, None)
    absent = sdk.decode_oracle_health(body)
    assert sdk.decode_oracle_health(body | {field: None}) == absent


def test_f16_nullable_embedded_feeder_does_not_change_readiness():
    body = f16()
    assert sdk.decode_oracle_health(body | {"embedded_feeder": None}) == sdk.decode_oracle_health(body)


@pytest.mark.parametrize("field", ["ready", "submit_enabled"])
@pytest.mark.parametrize("invalid", [None, 0, 1, "true"])
def test_f16_readiness_still_requires_boolean_facts(field, invalid):
    with pytest.raises(sdk.CodecError):
        sdk.decode_oracle_health(f16() | {field: invalid})
    body = f16()
    del body[field]
    with pytest.raises(sdk.CodecError):
        sdk.decode_oracle_health(body)


@pytest.mark.parametrize("field, invalid", [
    ("note", 1), ("error", False), ("updated_at_unix_ms", True),
    ("updated_at_unix_ms", -1), ("updated_at_unix_ms", 2**64),
    ("embedded_feeder", 0),
])
def test_nullable_oracle_fields_still_reject_wrong_types_and_ranges(field, invalid):
    with pytest.raises(sdk.CodecError):
        sdk.decode_oracle_health(f16() | {field: invalid})


def test_disabled_feeder_still_requires_its_shape_discriminator():
    with pytest.raises(sdk.CodecError):
        sdk.decode_oracle_health(disabled() | {"embedded_feeder": None})


def test_node_proxy_market_rows_can_name_market_only_in_map_key():
    # exchange-node/api_test.go TestAPIOracleHealth_ExternalProxy fixture.
    value = {"status":"ok", "embedded_feeder":True, "source":"oracle-feeder",
             "markets":{"3":{"last_update_unix_ms":1781160240000, "stale_seconds":4.2}}}
    row = sdk.decode_oracle_health(value).markets[3]
    assert row.market == 3 and row.status is None and row.stale_seconds == 4.2
    assert row.extra == {"last_update_unix_ms":1781160240000}


def test_oracle_market_freshness_extra_diagnostics_and_empty_market_map():
    result=sdk.decode_oracle_health(freshness())
    assert result.markets[3] == sdk.OracleMarketHealth(3,"stale",71.1,{"diagnostic":"kept"})
    assert result.updated_at_unix_ms == 9007199254740993
    assert result.extra == {"inventory":{"markets":[3]}}
    value=freshness(); value["markets"]={}
    assert sdk.decode_oracle_health(value).markets == {}
    assert sdk.decode_oracle_health(disabled() | {"status":"error","error":"upstream failed"}).error == "upstream failed"


@pytest.mark.parametrize("value", [None,[],{}, {"status":"ok"}, disabled()|{"embedded_feeder":0},
    f16()|{"ready":None}, f16()|{"submit_enabled":1}, f16()|{"journal_healthy":{"a":1}},
    f16()|{"divergence_bps":{"03":1}}, f16()|{"divergence_bps":{"3":-1}},
    freshness()|{"updated_at_unix_ms":True}, freshness()|{"markets":[]},
    freshness()|{"markets":{"3":{"market":4}}}, freshness()|{"markets":{"00":{"market":0}}}])
def test_oracle_malformed_fields_fail(value):
    with pytest.raises(sdk.CodecError): sdk.decode_oracle_health(value)


@pytest.mark.parametrize("stale", [True,-1,float("nan"),float("inf"),pytest.param(10**5000,id="huge-integer"),"1"])
def test_oracle_staleness_is_finite_nonnegative(stale):
    value=freshness(); value["markets"]["3"]["stale_seconds"]=stale
    with pytest.raises(sdk.CodecError): sdk.decode_oracle_health(value)


@pytest.fixture
def client():
    c=sdk.ExchangeClient(config=sdk.SdkConfig(gateway_url="https://gateway.example",api_key="test-key"))
    c._http.close()
    yield c
    c.close()


def serve(client,value,status=200):
    calls=[]
    def handler(request):
        calls.append(request); return httpx.Response(status,json=value,headers={"X-RateLimit-Remaining":"13"})
    client._http=httpx.Client(transport=httpx.MockTransport(handler),headers=client._default_headers())
    return calls


def test_client_stats_route_and_exact_coverage(client):
    calls=serve(client,stats()); assert client.market_stats([0]).markets[0].market == 0
    assert str(calls[0].url) == "https://gateway.example/v1/history/market-stats?markets=0"
    assert calls[0].headers["X-API-Key"] == "test-key" and client.rate_limit_remaining("default") == 13
    with pytest.raises(sdk.CodecError): client.market_stats([1])


@pytest.mark.parametrize("markets", [[0], (0,), range(1), UserList([0])])
def test_stats_accepts_declared_sequence_inputs(client, markets):
    calls = serve(client, stats())
    assert client.market_stats(markets).markets[0].market == 0
    assert calls[0].url.params["markets"] == "0"


@pytest.mark.parametrize("markets", ["0", b"0", bytearray(b"0"), {0}, {0: 0}, iter([0]), None])
def test_stats_rejects_non_sequence_containers_before_http(client, markets):
    calls = serve(client, stats())
    with pytest.raises(ValueError, match="non-string sequence"):
        client.market_stats(markets)
    assert not calls


@pytest.mark.parametrize("markets", [[],[1,1],[-1],[True],[1.0],[2**31],list(range(51)),"1"])
def test_stats_selectors_fail_before_http(client, markets):
    calls=serve(client,stats())
    with pytest.raises(ValueError): client.market_stats(markets)
    assert not calls


def test_client_oracle_market_scope_and_unreported_market(client):
    calls=serve(client,freshness()); assert client.oracle_health(3).markets[3].status == "stale"
    assert str(calls[0].url) == "https://gateway.example/v1/oracle/health?market=3"
    with pytest.raises(sdk.CodecError): client.oracle_health(4)
    client._http.close(); calls=serve(client,disabled())
    assert client.oracle_health(4).markets is None
    assert client.oracle_health().embedded_feeder is False
    assert str(calls[-1].url) == "https://gateway.example/v1/oracle/health"


def test_client_accepts_null_optional_diagnostics_without_inventing_readiness(client):
    serve(client, {"status": "ok", "embedded_feeder": False,
                   "note": None, "error": None, "updated_at_unix_ms": None})
    result = client.oracle_health()
    assert result.note is None and result.error is None
    assert result.updated_at_unix_ms is None
    assert result.ready is None and result.submit_enabled is None
    assert result.markets is None and result.embedded_feeder is False


@pytest.mark.parametrize("market", [0,-1,True,1.0,2**32,"3"])
def test_oracle_bad_selection_before_http(client, market):
    calls=serve(client,disabled())
    with pytest.raises(ValueError): client.oracle_health(market)
    assert not calls


@pytest.mark.parametrize("method,args", [("market_stats",([0],)),("oracle_health",())])
@pytest.mark.parametrize("status,error", [(404,sdk.TransportError),(503,sdk.GatewayError)])
def test_http_failures_remain_errors(client,method,args,status,error):
    calls=serve(client,{"error":"unavailable"},status)
    with pytest.raises(error): getattr(client,method)(*args)
    assert len(calls) == 1


def test_a_partial_response_fails_requested_coverage(client):
    serve(client, stats())
    with pytest.raises(sdk.CodecError, match="coverage"):
        client.market_stats([0, 1])


def test_stats_read_bypasses_caches(client):
    calls = serve(client, stats())
    client.market_stats([0])
    assert calls[0].headers["Cache-Control"] == "no-store"


@pytest.mark.parametrize("value", ["2026-02-30T00:00:00Z", "2026-11-10T24:00:00Z", "2025-02-29T00:00:00Z"])
def test_invalid_calendar_timestamp_is_not_normalized(value):
    body = stats()
    body["indexed_at"] = value
    with pytest.raises(sdk.CodecError, match="indexed_at"):
        sdk.decode_market_stats_response(body)
