# Atomic committed market inventory

Use `GET /v1/markets-snapshot` through the gateway for registration reconciliation.
The node returns one committed state view, not two independently sampled lists:

```text
JSON { data: base64(MessagePack [chain_id, height, markets, events, open_interest]) }
```

`chain_id` is exactly 32 bytes, `height` is a positive uint64, and both registries
contain their complete typed positional records. An explicit empty registry is
valid data. HTTP failure, absent fields, a malformed row or duplicate ID is not
an empty registry: the entire call fails. Do not remove workers on such failures.
Registration says nothing about provider reachability, source approval, funding,
oracle freshness or authority to submit transactions.

`open_interest` lists `[market, long, short]` in base-asset units, in strictly
ascending market order, for every market that has had positions; a market
missing from the list has zero open interest. It is read at the same height as
the registries, from the counters the engine enforces its open-interest cap
with. A node without exchange#1273 (exchange 2.21.0 and earlier) ends the tuple
at `events`: every SDK then reports open interest as not served (`undefined` in
TypeScript, `None` in Rust and Python), never as an empty list. A repeated or
out-of-order market refuses the whole read.

## TypeScript

```typescript
const client = new ExchangeClient({
  gatewayUrl: "https://api.dev.proof.trade",
  chainId: "exchange-devnet-1",
});
const snapshot = await client.queryMarketsSnapshot();
// snapshot.height is bigint; snapshot.markets includes all market kinds.
const perps = snapshot.markets.filter((market) => market.kind === "Perp");
// long and short are bigint; undefined on a node that does not serve them.
const btc = snapshot.openInterest?.find((row) => row.market === 1);
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

`snapshot.open_interest` is `Option<Vec<MarketOpenInterest>>`; the free
function `market_snapshot::decode_snapshot` decodes a response body without the
`gateway` feature.

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

## Python

```python
from proof_trading_sdk import ExchangeClient, chain_id_from_string

client = ExchangeClient(
    gateway_url="https://api.dev.proof.trade",
    chain_id=chain_id_from_string("exchange-devnet-1"),
)
snapshot = client.markets_snapshot()
# snapshot.markets has the shape client.markets() returns.
if snapshot.open_interest is not None:
    btc = next((row for row in snapshot.open_interest if row.market == 1), None)
```

`markets_snapshot()` runs the Rust decoder above through the native module, so
its refusals match Rust exactly and every decode failure raises `CodecError`. The
client must be bound to a real chain; the zero binding is refused. The body is
streamed and refused past 1 MiB before it is buffered whole, and `timeout`
(10 seconds by default) bounds each network wait and the whole read, so a body
that trickles in raises `TransportError`. Only HTTP 200 supplies data, and
redirects are not followed.

## Bounds and compatibility

Only HTTP 200 supplies data. Redirects are refused. Snapshot reads enforce a
1-MiB complete HTTP-body cap, bounded MessagePack depth, at most 16,384 rows in
each registry, strict integer widths, known enums and duplicate-ID rejection.
The caller separately enforces non-regressing snapshot heights, staleness,
complete source mappings and worker-transition/drain policy. A complete snapshot
does not permit abandoning pending work for a removed market.

The current endpoint serializes full 24-field `MarketConfig` rows and 11-field
`EventInfo` rows, each event carrying its attachment list as `[underlying, cpy,
cpn]` triples. Future fields may be appended; existing fields cannot be removed,
reordered or silently defaulted. Unknown market kinds or resolution modes fail
closed and require an SDK upgrade. The committed `engine-349fa9b.hex` fixture is
actual `rmp_serde::to_vec` output from `exchange-core::query::MarketsSnapshot`
on the event-keyed wire (proof-wire 2.0.0), consumed by both Rust and TypeScript
tests. It covers Perp, both conditional branches and both binary branches of
`EventId(91)`, one attachment on perp 15, signed maker rebates and uint64
bounds. Both committed engine fixtures are re-encoded without the per-market
partial-liquidation flag (element 21 of each market row), which is what the
8.0 engine writes for the same state. Conditional and binary parents are the event id in the positional
`[u32, Branch]` payload; the impact-market family and its `impact_market_id`
no longer exist on the wire.

`engine-66d50df7.hex` is `rmp_serde::to_vec` of an
`exchange-core::query::MarketsSnapshot` built at exchange `66d50df7`: two perps,
open interest `2^53 + 1` a side on market 1 and zero on market 2. It is the
open-interest vector for all three SDKs.
