# Scenario Tests

End-to-end behaviour tests for the exchange. Each file corresponds to a single scenario ID (`SDK01`, `SDK02`, …). The intent is "behaviour that a user actually cares about, written so it reads like English."

> **Why `SDK##` and not `S##`?** This suite used to share the bare `S##`
> namespace with the proof-integration gateway suite, but the numberings
> diverged (this repo's old S04 was cancel-then-replace; proof-integration's
> S04 is a market sweep), so a bare S-id was ambiguous without naming the
> repo. The suite was renamed to its own `SDK##` namespace to make every ID
> globally unambiguous. Older notes and docs citing `S01`–`S24` for this
> suite map 1:1 to `SDK01`–`SDK24`. The `S##` ids now always refer to the
> proof-integration catalog.

## How they run

- **CI (default, no node):** scenarios auto-skip because `RPC_URL` is unset. `npm test` stays green.
- **Local, against a running node:** set `RPC_URL`, `RELAYER_PRIVATE_KEY`, and (for liquidation tests) `ORACLE_PRIVATE_KEY`, and they execute for real against live CometBFT + `exchange-node`.

The local stack lives in [proof-integration](https://github.com/Proof-labs/proof-integration), checked out next to this repository with its sibling repositories built (see its README, "Setup from cold").

```bash
# One-time, in ../proof-integration: a fresh chain with markets, oracle prices
# and funding seeded. The default stack starts no market maker; do not set WITH_MM=1.
cd ../proof-integration
npm run stack:up:fresh

# Back in this repository: run the scenarios with the seeded keys
cd ../trading-sdk
RELAYER_KEY=$(jq -r .relayer ~/.exchanged/seed-keys.json)
ORACLE_KEY=$(jq -r .oracle ~/.exchanged/seed-keys.json)

RPC_URL=http://localhost:26657 \
  RELAYER_PRIVATE_KEY=$RELAYER_KEY \
  ORACLE_PRIVATE_KEY=$ORACLE_KEY \
  npx vitest run src/scenarios/

# When done, in ../proof-integration
npm run stack:down
```

## Requirements for deterministic passes

Each scenario creates fresh random-key users (`alice`, `bob`, `carol`) and funds them via the relayer-signed `Deposit` flow (engine `handle_deposit` gates on the on-chain relayer allowlist — audit B1, 2026-04-23). The test node must therefore have:

- **Markets seeded** (`npm run stack:up:fresh` in proof-integration — creates BTC=1, SOL=3, ETH=15).
- **Oracle prices set** (same command).
- **Relayer + oracle keys exposed** via env vars (the fresh stack writes both to `~/.exchanged/seed-keys.json`; set `EXCHANGED_HOME` to move it).
- **No competing traders.** Scenarios depend on positionSymmetry (Σ signed positions = 0 across the seeded users) and on order-book emptiness around the test prices. Any concurrent market maker (proof-integration's `mm` component, the Proof liquidity provider (PLP) market maker, and so on) breaks both: a market-maker bid at $77k will eat a scenario sell at $50k. **Run scenarios on a stack started without market makers**: proof-integration's default stack, without `WITH_MM=1`, and with no `mm` in `STACK_COMPONENTS`.

If you must run against a stack with a market maker running, comment out `positionSymmetry` in `invariants.ts` and pick scenario prices that won't cross the live book — but the assertions about exact positions / fill prices won't hold and tests will fail intermittently.

## Structure

- `harness.ts` — `seedWorld()` boots the world, returns a fluent API (`w.alice.limitBuy(...)`).
- `invariants.ts` — shared assertions run at the end of every scenario (orderbook not crossed, position symmetry, no negative equity).
- `SDK##-<slug>.test.ts` — one scenario per file, named by suite ID.

## Adding a scenario

1. Take the next unused `SDK##` in this directory (ids are local to this
   suite — no external reservation needed). Then add the scenario to the
   "SDK-suite scenarios" section of the ProofOfBrain vault catalog
   (`testing/exchange-test-scenarios.md`) so the shared catalog stays
   complete.
2. Copy an existing `SDK##-*.test.ts` as a template.
3. Keep each test focused on one behaviour — split rather than branch.
4. Always end with `await invariants(w)`.

## Units — common trap

- `quantity`: integer lots. `1n` = 1 contract, not 1.0 in some base unit.
- `price`: microUSD (6 dp). `50_000_000_000n` = $50,000.
- `amount` (deposits, balances): microUSDC (6 dp).

The old 6-dp-everywhere convention from pre-mono drafts does not apply — `quantity` is integer contracts.
