# ADR 0003 — Every gateway interaction goes through the SDK, admin calls included

- **Status:** Accepted
- **Date:** 2026-09-16
- **Deciders:** Ramon van de Ven (`Ramon2000`), agreed in the `#dev` channel
- **Supersedes:** [ADR 0002](0002-oracle-health-out-of-scope.md) (oracle health out of scope)
- **Proposed in:** [trading-sdk PR #131](https://github.com/Proof-labs/trading-sdk/pull/131)
- **Record:** ProofOfBrain `daily-summaries/2026-09-16.md`, decision "SDK scope"

## Context

ADR 0002 kept oracle health out of the SDK on the premise that no trading or
admin consumer needed to reach it through the SDK. That premise no longer holds.

Web-UI is migrating off its vendored SDKs and local gateway patches onto the
public SDK. The migration surfaced gateway calls the frontend makes that the SDK
did not cover, among them `GET /v1/oracle/health`: Web-UI's `useOracleHealth`
and `classifyOracleFreshness` warn after a 15-second delay and block order entry
after 60 seconds. Admin tooling has the same shape of need.

The organisation's network policy already makes the SDK the client boundary:
application code calls the SDK for every gateway interaction and never
hand-rolls requests against the gateway. Carving individual routes out as
"operational" or "admin-only" leaves exactly those calls hand-rolled.

## Decision

Every gateway interaction an application makes goes through the SDK. That covers
trading actions, reads, streams, the oracle health check and admin calls alike;
no category of gateway call is exempt. When an application needs a gateway route
the SDK does not cover, add the SDK method first, then consume it.

ADR 0002's prohibition on oracle-health reads is lifted. The SDK exposes
`ExchangeClient.reads().oracleHealth(options)` alongside the other named
gateway reads.

## Consequences

- **Oracle health.** `reads().oracleHealth()` uses the configured gateway,
  returns the original `Response`, and propagates HTTP failures and cancellation.
  JSON interpretation, thresholds, scheduling and display policy stay in the
  application. An HTTP 200 response with `embedded_feeder: false` is not evidence
  of a fresh oracle, and the read is not trading authorization. Extend this
  method rather than adding a parallel `queryOracleHealth()`.
- **Admin calls.** Admin and operator actions and their governance reads belong
  in the SDK for their consumers (Web Admin, signer and operator tooling). Being
  in the SDK is the client boundary, not a grant of authority: the engine still
  gates them behind dedicated allowlists and multisig, and trading integrations
  can keep typing their calls as `TraderAction`.
- **Monitoring.** Grafana Markets Health remains the operational dashboard. The
  SDK forwards the read; it does not become a monitoring service or a second
  source of truth for feed liveness.
- **`MarketConfig.maxOpenInterest`** (tuple slot 24), deferred in ADR 0002, needs
  no reversal: add it when a consumer needs it, with decoder unit tests.
- No gateway endpoint, wire format, signing domain or engine permission changes.
