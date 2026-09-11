# Atomic committed market inventory

Use `GET /v1/markets-snapshot` through the gateway for registration reconciliation.
The node returns one committed state view, not two independently sampled lists:

```text
JSON { data: base64(MessagePack [chain_id, height, markets, impact_markets]) }
```

`chain_id` is exactly 32 bytes, `height` is a positive uint64, and both registries
contain their complete typed positional records. An explicit empty registry is
valid data. HTTP failure, absent fields, a malformed row or duplicate ID is not
an empty registry: the entire call fails. Do not remove workers on such failures.
Registration says nothing about provider reachability, source approval, funding,
oracle freshness or authority to submit transactions.

## TypeScript

```typescript
const client = new ExchangeClient({
  gatewayUrl: "https://api.dev.proof.trade",
  chainId: "exchange-devnet-1",
});
const snapshot = await client.queryMarketsSnapshot();
// snapshot.height is bigint; snapshot.markets includes all market kinds.
const perps = snapshot.markets.filter((market) => market.kind === "Perp");
```

The configured chain pin is mandatory. A chain discovered by another SDK call
does not silently become inventory authority. This method always uses the
gateway, even if an internal client opted into direct-node access elsewhere.

## Rust

Enable `proof-trading-sdk`'s optional `gateway` feature. The default Rust/WASM
codec build has no network client. All nested response records reuse
`exchange-wire`; this module does not implement another market or action codec.

```rust,ignore
use proof_trading_sdk::{crypto, market_snapshot::MarketsSnapshotClient};
use std::time::Duration;
let expected = crypto::chain_id_from_string("exchange-devnet-1");
let client = MarketsSnapshotClient::new(
    "https://api.dev.proof.trade", Duration::from_secs(10),
)?;
let snapshot = client.read(expected).await?;
let clock = client.chain_identity(expected).await?;
let receipt = client.committed_receipt(original_signed_hash).await?;
```

`chain_identity` checks the expected hash, positive committed height/time and
`catching_up == false`. It is a separate committed-time read, not part of the
atomic market view. `committed_receipt` returns only a matching original hash,
positive committed height and an explicit execution code. Nonzero committed
codes are rejection receipts, not recovery. **Every error, including 404 or RPC
not-found, leaves the submission unresolved.** No read allocates a nonce,
resubmits, retries, clears a journal or infers finality from elapsed wall time.

### Native signed submission

`client.submit_signed_bytes(&signed_envelope).await` sends the exact envelope
once through `POST /exchange`. Persist its bytes and nonce in the caller's
durable journal **before** invoking it. The client does not sign, allocate a
nonce, retry or poll in the background.

`SubmissionVerdict` distinguishes a matching positive-height committed result,
a hash-bound gateway rejection without an inclusion receipt, a documented
pre-admission refusal, and a still-pending hash. Nonzero committed codes are
failed execution, never successful oracle updates. `SubmissionError` carries a
bounded classification and, for valid input, the original hash; it never retains
the gateway URL or remote error body. Timeout, malformed/truncated responses and
hash mismatches require continued reconciliation, not a fresh nonce.

The request is limited to 4096 signed bytes and the response to 1 MiB, including
chunked responses. The configured timeout covers request and complete response
body. Redirects, automatic retries and environment proxies are disabled. This is
an operator transport primitive, not an automatic recovery policy.

## Bounds and compatibility

Only HTTP 200 supplies data. Redirects are refused. Snapshot reads enforce a
1-MiB complete HTTP-body cap, bounded MessagePack depth, at most 16,384 rows in
each registry, strict integer widths, known enums and duplicate-ID rejection.
The caller separately enforces non-regressing snapshot heights, staleness,
complete source mappings and worker-transition/drain policy. A complete snapshot
does not permit abandoning pending work for a removed market.

The current endpoint serializes full 25-field `MarketConfig` and 15-field
`ImpactMarketDisplayInfo` rows. Future fields may be appended; existing fields
cannot be removed, reordered or silently defaulted. Unknown market kinds or
resolution modes fail closed and require an SDK upgrade. No exchange-wire pin
change is needed for the current engine: the committed
`engine-0d215eaa.hex` fixture is actual `rmp_serde::to_vec` output from
`exchange-core::query::MarketsSnapshot` at
`0d215eaa326dc79776f5c329c7b6c01775fc5e17`, consumed by both Rust and TypeScript
tests. It covers Perp, both conditional branches, both G17 `EventId(123)` binary
branches, signed maker rebates, a MarketOracle impact record and uint64 bounds.
The G17 parent-field rename preserves the positional `[u32, Branch]` payload;
the older Rust wire type still names that binary parent `impact_market_id`.
Do not reinterpret that field as a current impact-family foreign key.
