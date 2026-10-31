# Generic finalized reads

## Design and release boundary

Task: W43-06. This is read-only SDK infrastructure, not an insurance exit policy
or permission to sign. It addresses the review on SDK #287. No engine economic
rule is selected here. Each feature remains opt-in.

Following ADR 0003, callers use `client.reads().finalized` for witnessed state,
`client.reads().evidence` for headers/transactions/block windows, and
`client.reads().tradeHistoryPage` for indexed history. These are gateway-only,
including when `useGateway: false`, just like existing `reads()` methods. That
flag still controls older query/submission paths, not the typed read facade.
There is no raw-HTTP fallback in applications.

Deploy gateway #267 before calling the new routes. Merge its compatible engine
dependencies first. A 404 remains an error, not an empty portfolio or proof that
a transaction was never admitted. No deployment or package release is part of
this change. Financial format 3 is an npm MAJOR source change: narrow `format`
before reading the format-1-only `plp` property. Include it in the next major
release alongside the existing unreleased breaking changes; do not ship as a
minor version of 8.1.0.

The unreleased raw agent read and parallel `queryFinalized*` methods are removed.
Synchronous WASM-backed decoders are internal; facade methods await `ready()`
inside their request deadline. One chain-pin guard serves evidence and market
inventory reads. Financial/account witnesses have no chain ID, so requiring a
pin on their transport alone would falsely suggest chain binding.

## Trust and composition

`FinalizedReadWitness` documents the trust boundary. `verifyWitness(w, H1, pin)`
checks H1 is height H+1, belongs to the pinned chain, and commits the witness's
app hash. Hashes are uppercase `Hash32Hex`. The source of the header must still
be authenticated; the helper does not verify validator signatures. Comet event
strings are not committed by its results hash. Keep the gateway trusted for
event truth and check node identity, same-view witnesses and freshness separately.

Use `verifyWitness` for financial/account reads before treating them as bound to
a chain. An H+1 timestamp is not H's timestamp. The helper does not compare them.
Genesis can have `parentHash: null` and `appHash: null`, never a fabricated hash.

## Routine engineering limits

| Limit                 | Value and reason                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP response         | 1 MiB for the entire envelope; matches gateway #267's bounded reads and prevents unbounded allocation. Both legacy financial/market readers and new reads share the transport implementation.                                               |
| Body fragmentation    | 4,096 chunks; bounds work even below the byte cap. Empty chunks refuse immediately.                                                                                                                                                         |
| Deadline              | 5 seconds by default, maximum 60 seconds explicitly requested. Includes setup/WASM, queue, headers and body. Multi-request scans share one deadline. Existing market-snapshot convenience transport retains its explicit 10-second setting. |
| Block window          | 32 heights default, 128 ceiling; at most 2N+1 requests. Refuses incomplete coverage.                                                                                                                                                        |
| Window aggregate work | Defaults/ceilings: 8 MiB decoded JSON, 10,000 transactions, 16,384 events, 65,536 attributes. Callers may lower each ceiling, never raise it. Busy windows must use smaller ranges, not partial-success results.                            |
| Per-result work       | 4,096 events and 4,096 attributes, bounded strings and canonical base64. Aggregate window limits are separately named `WINDOW_MAX_*`.                                                                                                       |
| Open orders           | Default/maximum 101 rows: the existing query limit and one overflow sentinel beyond a service's 100-order budget. A limit-sized result is incomplete, even if exactly full.                                                                 |
| Recent nonces         | Maximum 100, matching the engine's retained sorted set. It is prunable, not a lifetime sequence floor or non-admission proof.                                                                                                               |
| Orderbook             | 1, 20 (default), or 100 levels per side, matching the route contract. Not a full-book assertion.                                                                                                                                            |
| Indexed trades        | 200 default, 1,000 maximum; matches the indexer's bounded page.                                                                                                                                                                             |
| Market ID             | Shared validated 1..u32-max for engine facts. Indexed history additionally refuses above i32-max because its storage/route parameter is signed i32. Zero is invalid everywhere.                                                             |

Payload decoder ceilings are not promises that a whole response of that size
fits in HTTP. Financial decoded bytes are capped at 768 KiB, account/book at
512 KiB; the 1 MiB HTTP ceiling always applies first. The book envelope repeats
base64 in two fields, which must match. Actual valid 100-level/u64 books are far
below these ceilings; oversized/padded inputs are refused, never truncated.
MessagePack shape, nesting and collection checks remain independent of byte caps.

## Ordering and pagination

The gateway passes through these orders; it does not impose a new sort:

- Engine `collect_open_orders` scans the owner-order key prefix, whose suffix is
  the big-endian order ID. IDs therefore increase across markets, not by market.
- Engine `RecentNonces` stores the sorted retained set.
- Indexer `fills.rs` orders by `block_time DESC, fill_id DESC`.

One trade-history page checks this order and duplicate IDs. Callers must keep
filters fixed, remember all previously seen cursors/IDs, and check last/first
row ordering across page boundaries. A stateless page cannot detect skipped
rows or an A-to-B-to-A cursor cycle. `nextCursor` is absent on the final page;
that is not proof of complete ingestion. Use complete block/results evidence
when absence or coverage matters.

## Types, time and errors

New hex read fields use `HexAddress`, `Hash32Hex` and `MarketId`, constructed by
shared validators. Existing byte-address trading types stay unchanged.
`RawOpenOrder` is a stored engine tuple with queue priority and original/filled
quantity; `OpenOrder` is the existing user-facing projection with byte owners.
`ParticipantTrade` preserves both counterparties, exact indexed NUMERIC strings,
integer fee units and block provenance; `HistoryFill` is the existing history
projection. Neither is safely assignable to the other without explicit unit
and representation conversion. `makerSide` normalizes to the existing `Side` enum.

Header/indexer RFC3339 strings retain nanoseconds for ordering. Witness epoch
milliseconds are `bigint` to preserve wire integers. User window selections use
safe-integer epoch milliseconds for existing HTTP filters and Date range.
Names carry units; trade-window inclusion does not round to milliseconds.

`GatewayReadError` exposes `kind` and `field`: configuration, deadline, limit,
malformed or binding. Caller cancellation preserves the original signal reason.
HTTP failures use `GatewayHttpError` with a bounded readable response body after
upstream cleanup. Existing domain decoders can still raise their documented
decode errors; do not convert such errors to empty data or retry permission.

## Review sequence

Separate review surfaces: remainder validation; financial format 3; shared
bounded transport; witnessed state; chain evidence; book and indexed history.
The transport precedes dependent reads, and the public facade grows with each
feature. No service signing or activation is enabled by any of these changes.
