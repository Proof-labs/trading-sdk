import httpx
import pytest

from proof_trading_sdk import ExchangeClient, RateLimited, SdkConfig


@pytest.mark.parametrize("bucket_header,expected_bucket", [
    (None, "default"),
    ("info", "info"),
    ("", ""),
])
@pytest.mark.parametrize("method,args", [
    ("account", (bytes(20),)),
    ("status", ()),
    ("markets_snapshot", ()),
    ("submit_action", (b"mock-envelope",)),
])
def test_rate_limit_exception_selects_the_matching_bucket(
    bucket_header, expected_bucket, method, args
):
    headers = {
        "Retry-After": "1.5",
        "X-RateLimit-Limit": "20",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": "1234",
        "X-RateLimit-Tier": "standard",
    }
    if bucket_header is not None:
        headers["X-RateLimit-Bucket"] = bucket_header
    client = ExchangeClient(config=SdkConfig(gateway_url="https://example.invalid"))
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(
        lambda _: httpx.Response(429, headers=headers, json={"error": "rate limited"})
    ))
    try:
        with pytest.raises(RateLimited) as caught:
            getattr(client, method)(*args)
        error = caught.value
        state = client.rate_limit_state(error.bucket)
        assert error.bucket == expected_bucket
        assert error.retry_after_secs == 1.5
        assert state.bucket == expected_bucket
        assert (state.limit, state.remaining, state.reset, state.tier) == (
            20, 0, 1234, "standard"
        )
    finally:
        client.close()


def test_default_and_named_bucket_state_stay_separate():
    responses = iter([
        httpx.Response(429, headers={"X-RateLimit-Limit": "20"}),
        httpx.Response(429, headers={
            "X-RateLimit-Bucket": "orders", "X-RateLimit-Limit": "40"
        }),
    ])
    client = ExchangeClient(config=SdkConfig(gateway_url="https://example.invalid"))
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(lambda _: next(responses)))
    try:
        for bucket, limit in [("default", 20), ("orders", 40)]:
            with pytest.raises(RateLimited) as caught:
                client.status()
            assert caught.value.bucket == bucket
            assert client.rate_limit_state(caught.value.bucket).limit == limit
        assert client.rate_limit_state("default").limit == 20
        assert client.rate_limit_state("orders").limit == 40
    finally:
        client.close()


def test_bucket_lookup_returns_the_latest_response_state():
    responses = iter([
        httpx.Response(429, headers={"X-RateLimit-Remaining": "0"}),
        httpx.Response(200, headers={"X-RateLimit-Remaining": "19"}, json={}),
    ])
    client = ExchangeClient(config=SdkConfig(gateway_url="https://example.invalid"))
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(lambda _: next(responses)))
    try:
        with pytest.raises(RateLimited) as caught:
            client.status()
        assert client.rate_limit_state(caught.value.bucket).remaining == 0
        client.status()
        assert client.rate_limit_state(caught.value.bucket).remaining == 19
    finally:
        client.close()


def test_default_lookup_reads_responses_without_a_bucket_header():
    client = ExchangeClient(config=SdkConfig(gateway_url="https://example.invalid"))
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(
        lambda _: httpx.Response(200, headers={
            "X-RateLimit-Limit": "20", "X-RateLimit-Remaining": "19"
        }, json={})
    ))
    try:
        client.status()
        assert client.rate_limit_remaining() == 19
        assert client.rate_limit_state().limit == 20
    finally:
        client.close()
