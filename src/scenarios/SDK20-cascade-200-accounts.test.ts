/**
 * SDK20 — Cascade liquidation with 200+ accounts at escalating leverage
 *
 * This is the headline stress test promised in
 * `docs/adl-vs-socialized-loss.md` §Integration tests. The setup:
 *
 *   1. Spin up N (default 25) trader keys, each funded with $10k.
 *   2. Each trader takes a long sized to use 95% of the perp's initial
 *      margin, so a 5% adverse move puts them under maintenance.
 *   3. The MM that fills the longs holds the symmetric short.
 *   4. Drop the oracle 30% in one price.
 *   5. Every long is liquidated and no account is left underwater.
 *
 * Set `SDK20_TRADER_COUNT=200` to reproduce the full design-doc replay.
 *
 * Catalog: ProofOfBrain vault, testing/exchange-test-scenarios.md — "SDK-suite scenarios" section (SDK20).
 *
 * Runs only when the live-stack environment in the README is set.
 */
import { describe, it, beforeAll, expect } from "vitest";
import {
  canCreatePerps,
  envWorldOptions,
  seedWorld,
  type Perp,
  type World,
} from "./harness.js";
import { invariants } from "./invariants.js";

const TRADER_COUNT = Number(process.env.SDK20_TRADER_COUNT ?? 25);

const describeScenario = canCreatePerps() ? describe : describe.skip;

const ENTRY = 50_000_000_000n; // $50k
const CRASH = 35_000_000_000n; // -30%
const BALANCE = 10_000_000_000n; // $10k per trader

describeScenario("SDK20: cascade liquidation across many accounts", () => {
  let w: World;
  let perp: Perp;
  const traders = Array.from(
    { length: TRADER_COUNT },
    (_, i) => `trader${i + 1}`,
  );

  beforeAll(async () => {
    w = await seedWorld({
      ...envWorldOptions(),
      users: ["mm", ...traders],
      seedBalance: BALANCE,
    });
    perp = await w.createPerp(
      { imBps: 1000, mmBps: 500, szDecimals: 5 },
      ENTRY,
    );
    // The MM carries every trader's short, so it needs margin for all of them.
    await w.deposit("mm", BALANCE * BigInt(TRADER_COUNT));
  }, 120_000);

  it(`closes every long after a 30% oracle drop (${TRADER_COUNT} traders)`, async () => {
    const { market } = perp;
    // 95% of the notional the trader's balance can margin.
    const notional =
      (BALANCE * 10_000n * 95n) / BigInt(perp.config.imBps) / 100n;
    const qty = perp.quantityFor(notional, ENTRY);
    for (const name of traders) {
      await w.users[name]!.limitBuy(market, qty, ENTRY);
    }
    await w.users.mm!.limitSell(market, qty * BigInt(TRADER_COUNT), ENTRY);

    for (const name of traders) {
      expect(await w.position(name, market)).toBe(qty);
    }
    expect(await w.position("mm", market)).toBe(-qty * BigInt(TRADER_COUNT));

    await w.pushOracle(market, CRASH);
    await w.untilFlat(traders, market, 30_000);

    for (const name of traders) {
      expect(await w.position(name, market), `${name} should be flat`).toBe(0n);
      const acct = await w.account(name);
      expect(acct, `${name} account`).not.toBeNull();
      expect(
        acct!.equity,
        `${name} must not be underwater`,
      ).toBeGreaterThanOrEqual(0n);
    }

    await invariants(w);
  }, 180_000);
});
