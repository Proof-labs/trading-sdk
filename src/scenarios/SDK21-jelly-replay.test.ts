/**
 * SDK21 — JELLY-shape blowout replay
 *
 * The 2025 Hyperliquid JELLY incident: a single concentrated long
 * position on a low-liquidity perp blew up when the oracle dropped
 * 80%, triggering a cascading liquidation that exhausted the
 * insurance fund. Hyperliquid's protocol-owned market maker was
 * forced to inherit the stuck position, taking a $10M+ unrealized
 * loss while quoting downward for hours.
 *
 * This scenario replays the shape (single whale, thin book, sharp
 * adverse move) on a perp created for it and verifies that:
 *
 *   1. The whale is liquidated: its position is closed.
 *   2. No trader account, and not the MM, is left underwater.
 *
 * Catalog: ProofOfBrain vault, testing/exchange-test-scenarios.md — "SDK-suite scenarios" section (SDK21).
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

const describeScenario = canCreatePerps() ? describe : describe.skip;

const ENTRY = 50_000_000_000n; // $50k
const CRASH = 10_000_000_000n; // -80%
const WINNERS = ["winner1", "winner2", "winner3"] as const;

describeScenario("SDK21: JELLY-shape blowout absorbed by waterfall", () => {
  let w: World;
  let perp: Perp;

  beforeAll(async () => {
    w = await seedWorld({
      ...envWorldOptions(),
      users: ["whale", "mm", ...WINNERS],
      seedBalance: 1_000_000_000_000n, // $1M each
    });
    perp = await w.createPerp(
      { imBps: 1000, mmBps: 500, szDecimals: 5 },
      ENTRY,
    );
  }, 60_000);

  it("absorbs an 80% oracle drop on a concentrated whale long", async () => {
    const { market } = perp;
    // $5M notional on $1M: 5x, inside the 10x IM limit.
    const whaleQty = perp.quantityFor(5_000_000_000_000n, ENTRY);
    await w.users.whale!.limitBuy(market, whaleQty, ENTRY);
    await w.users.mm!.limitSell(market, whaleQty, ENTRY);
    expect(await w.position("whale", market)).toBe(whaleQty);
    expect(await w.position("mm", market)).toBe(-whaleQty);

    // Three winners short $250k each; the MM buys their side.
    const winnerQty = perp.quantityFor(250_000_000_000n, ENTRY);
    for (const name of WINNERS) {
      await w.users[name]!.limitSell(market, winnerQty, ENTRY);
    }
    await w.users.mm!.limitBuy(market, winnerQty * 3n, ENTRY);
    for (const name of WINNERS) {
      expect(await w.position(name, market)).toBe(-winnerQty);
    }

    await w.pushOracle(market, CRASH);
    await w.untilFlat(["whale"], market);

    expect(await w.position("whale", market)).toBe(0n);
    for (const name of ["whale", "mm", ...WINNERS]) {
      const acct = await w.account(name);
      expect(acct, `${name} account`).not.toBeNull();
      expect(
        acct!.equity,
        `${name} must not be underwater`,
      ).toBeGreaterThanOrEqual(0n);
    }

    await invariants(w);
  }, 120_000);
});
