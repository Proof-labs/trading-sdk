# ADR 0003 — Oracle freshness read for trading UI guards

- **Status:** Proposed; implemented in draft trading-sdk PR #131.
- **Date:** 2026-09-16
- **Scope:** TypeScript `ExchangeClient.reads().oracleHealth()`.
- **Amends:** The blanket read prohibition in [ADR 0002](0002-oracle-health-out-of-scope.md), upon acceptance.

## Context

ADR 0002 assumed no trading or admin consumer needed oracle-health reads.
Web-UI now consumes `/v1/oracle/health` in `useOracleHealth` and
`classifyOracleFreshness`: a 15-second delay warns the user, and a 60-second delay
blocks order entry in the trading screens. Removing that dependency during the
public SDK migration would change existing trading UI behavior.

All application gateway requests must pass through the SDK. Preserving these
guards therefore requires an SDK read for the existing endpoint. Grafana's
operational dashboards do not supply the application's request path.

## Proposed decision

Add `ExchangeClient.reads().oracleHealth(options)` alongside the existing named
response reads. It uses the configured gateway, returns the original `Response`,
propagates HTTP failures and cancellation, and leaves JSON interpretation,
thresholds, scheduling and display policy in Web-UI.

The frontend must continue distinguishing stale or missing market data from an
unavailable monitor. In particular, an HTTP 200 response with
`embedded_feeder: false` is not evidence of a fresh oracle. The SDK does not fill
missing values, classify freshness, decide trading eligibility or change the
existing UI thresholds.

## Boundaries

- This is a narrow exception for the existing trading UI consumer. Grafana
  retains operational monitoring ownership.
- No separate typed health API, monitoring service or freshness policy is added.
- No gateway endpoint, wire format, signing domain or engine permission changes.
- The exception is proposed for review in draft PR #131; this document does not
  claim the original deciders have approved it.
