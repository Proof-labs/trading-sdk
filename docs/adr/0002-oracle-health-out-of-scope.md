# ADR 0002 — Oracle health is out of scope for the SDK (do not implement)

- **Status:** Accepted — **prohibited feature**
- **Date:** 2026-07-07
- **Deciders:** Ramon van de Ven (`Ramon2000`), Aleksandr Petrosyan
- **Applies to:** `src/client.ts` (`ExchangeClient` read methods), `src/types.ts`.

## Prohibition

**Do not add an oracle-health read to the SDK.** Concretely, do not add
`ExchangeClient.queryOracleHealth()` or any method that consumes the gateway's
`GET /v1/oracle/health`, and do not add `OracleHealth` / `OracleMarketHealth`
(or equivalent) types. This has been proposed, reviewed, and rejected; it must
not be re-introduced without a new, explicit product decision that reverses the
one recorded here.

## Context

`queryOracleHealth()` was proposed in **[trading-sdk PR #26](https://github.com/Proof-labs/trading-sdk/pull/26)**
("feat: add queryOracleHealth() + decode MarketConfig.maxOpenInterest (slot
24)"), opened by `Ramon2000`, with `aleksandr-proof` as reviewer. Its stated
consumer was the Web Admin read-only console (Admin Control Plane Phase 1).

That PR was **closed unmerged on 2026-07-06**. The author's closing note records
the reason (lightly paraphrased):

> `queryOracleHealth()` is no longer needed by anyone. The Web Admin does not
> consume `/v1/oracle/health` — feed health (liveness / freshness) belongs to
> **Grafana (Markets Health)**, and the Web Admin's oracle read-out reads the
> sources directly as a picking list. Superseded by the Web Admin spec
> re-assessment (WebAdmin PR #1, following the 2026-07-06 weekly-meeting
> decisions).

The 2026-07-06 weekly meeting also decided that **market metadata moves
on-chain and the Web Admin becomes read-only** (see the ProofOfBrain vault,
`daily-summaries/2026-07-06.md` and the W28 board `W28-21`), which removed the
last hypothetical caller.

## Decision & rationale

Oracle **feed health** — per-market liveness, staleness, source, last-update
time — is an **operational monitoring** concern, owned by the **Grafana Markets
Health / oracle-health dashboards** fed by the indexer (`admin_events`) and the
oracle-feeder. It is **not** part of the exchange wire contract and has no
trading or admin consumer that must go through the SDK. Putting it in the SDK
duplicates a monitoring surface, invents a second source of truth for feed
liveness, and creates a maintenance burden (normalizing an ops-only JSON shape)
for zero users.

The SDK's job is signing/encoding trading actions and reading trading state
(orderbook, account, markets, positions, history). Oracle _operation_ (e.g.
submitting `OracleUpdate` / `OracleUpdateComposite`) stays in the SDK as an
operator action; oracle _health monitoring_ does not.

## Scope of this prohibition

- **Prohibited:** `queryOracleHealth()` and any SDK consumption of
  `/v1/oracle/health`; `OracleHealth` / `OracleMarketHealth` types.
- **NOT prohibited (separately deferred):** `MarketConfig.maxOpenInterest`
  (msgpack tuple **slot 24**, W27-01). PR #26's author explicitly left this as a
  future option: _"If a later phase wants the OI-cap column, re-raise it as its
  own small PR **with decoder unit tests** (`decodeMarketConfig` currently has
  none — worth adding at the same time)."_ It is out of scope **today** only
  because no current phase needs it — it is not banned.

## If you think you need this

Do not add it directly. Take the requirement to product (Ramon), get the
2026-07-06 decision explicitly reversed, and only then supersede this ADR with a
new one. For a dashboard/monitoring need, use **Grafana Markets Health**, not the
SDK.

## References

- Rejected proposal: trading-sdk PR #26 (closed unmerged 2026-07-06).
- Superseding spec: WebAdmin PR #1 (Web Admin read-only re-assessment).
- Vault: `daily-summaries/2026-07-06.md`; W28 board `W28-21` (Admin Control Plane).
