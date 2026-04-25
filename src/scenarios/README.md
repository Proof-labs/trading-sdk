# Scenario Tests

End-to-end behaviour tests for the exchange. Each file corresponds to a single scenario ID (`S01`, `S02`, …). The intent is "behaviour that a user actually cares about, written so it reads like English."

## How they run

- **CI (default, no node):** scenarios auto-skip because `RPC_URL` is unset. `make test-sdk` stays green.
- **Local, against a running node:** set `RPC_URL`, `RELAYER_PRIVATE_KEY`, and (for liquidation tests) `ORACLE_PRIVATE_KEY`, and they execute for real against live CometBFT + `exchange-node`.

```bash
# One-time: boot a clean local stack WITHOUT market-makers (see below).
./scripts/dev-stack.sh up --fresh --no-ui --no-mm --no-hlp

# Seed markets + oracles
npx tsx scripts/seed.ts setup     # first time only
npx tsx scripts/seed.ts           # every time the chain is reset

# Run scenarios with the canonical seeded keys
cd sdk
RELAYER_KEY=$(jq -r .relayer ~/.exchanged/seed-keys.json)
ORACLE_KEY=$(jq -r .oracle ~/.exchanged/seed-keys.json)

RPC_URL=http://localhost:26657 \
  RELAYER_PRIVATE_KEY=$RELAYER_KEY \
  ORACLE_PRIVATE_KEY=$ORACLE_KEY \
  npx vitest run src/scenarios/
```

## Requirements for deterministic passes

Each scenario creates fresh random-key users (`alice`, `bob`, `carol`) and funds them via the relayer-signed `Deposit` flow (engine `handle_deposit` gates on the on-chain relayer allowlist — audit B1, 2026-04-23). The test node must therefore have:

- **Markets seeded** (`scripts/seed.ts` — creates BTC-PERP=1, ETH-PERP=2, SOL-PERP=3).
- **Oracle prices set** (same script).
- **Relayer + oracle keys exposed** via env vars (the seed script writes both to `~/.exchanged/seed-keys.json`).
- **No competing traders.** Scenarios depend on positionSymmetry (Σ signed positions = 0 across the seeded users) and on order-book emptiness around the test prices. Concurrent MM activity (`spawn-mms`, `spawn-impact-mms`, `spawn-event-mms`, `hlp.ts`, etc.) breaks both: a market-maker bid at $77k will eat a scenario sell at $50k. **Run scenarios on a dedicated node started without MMs** (`./scripts/dev-stack.sh up --no-mm --no-hlp --no-impact-mms --no-event-mms` or the equivalent flag set).

If you must run against an MM-active stack, comment out `positionSymmetry` in `invariants.ts` and pick scenario prices that won't cross the live book — but the assertions about exact positions / fill prices won't hold and tests will fail intermittently.

## Structure

- `harness.ts` — `seedWorld()` boots the world, returns a fluent API (`w.alice.limitBuy(...)`).
- `invariants.ts` — shared assertions run at the end of every scenario (orderbook not crossed, position symmetry, no negative equity).
- `S##-<slug>.test.ts` — one scenario per file, named by catalog ID.

## Adding a scenario

1. Reserve the next ID in `docs/exchange-test-scenarios.md`.
2. Copy an existing `S##-*.test.ts` as a template.
3. Keep each test focused on one behaviour — split rather than branch.
4. Always end with `await invariants(w)`.

## Units — common trap

- `quantity`: integer lots. `1n` = 1 contract, not 1.0 in some base unit.
- `price`: microUSD (6 dp). `50_000_000_000n` = $50,000.
- `amount` (deposits, balances): microUSDC (6 dp).

The old 6-dp-everywhere convention from pre-mono drafts does not apply — `quantity` is integer contracts.
