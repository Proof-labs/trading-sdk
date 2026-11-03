/**
 * SDK10 — Liquidation at maintenance margin threshold
 *
 * Alice opens a leveraged long on a perp created for this scenario, an
 * adverse oracle move takes her below maintenance margin, and the engine
 * liquidates her. She ends flat and not underwater.
 *
 * Catalog: ProofOfBrain vault, testing/exchange-test-scenarios.md — "SDK-suite scenarios" section (SDK10).
 *
 * Runs only when `RPC_URL`, `RELAYER_PRIVATE_KEY` and `ORACLE_PRIVATE_KEY`
 * are set; the rest of the live-stack environment is in the README.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  envWorldOptions,
  seedWorld,
  type Perp,
  type World,
} from "./harness.js";
import { invariants } from "./invariants.js";

const RPC_URL = process.env.RPC_URL;
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY;
const ORACLE_PRIVATE_KEY = process.env.ORACLE_PRIVATE_KEY;
const describeScenario =
  RPC_URL && RELAYER_PRIVATE_KEY && ORACLE_PRIVATE_KEY
    ? describe
    : describe.skip;

const ENTRY = 50_000_000_000n; // $50,000
const CRASH = 30_000_000_000n; // $30,000

describeScenario("SDK10: liquidation on adverse price move", () => {
  let w: World;
  let perp: Perp;

  beforeAll(async () => {
    w = await seedWorld(envWorldOptions());
    perp = await w.createPerp(
      { imBps: 1000, mmBps: 500, szDecimals: 5 },
      ENTRY,
    );
  }, 60_000);

  it("position closes and equity ≥ 0 after a sub-MM oracle move", async () => {
    const { market } = perp;
    // $250k notional against $100k: 2.5x, well inside the 10x IM limit.
    const qty = perp.quantityFor(250_000_000_000n, ENTRY);
    await w.alice.limitBuy(market, qty, ENTRY);
    await w.bob.limitSell(market, qty, ENTRY);
    expect(await w.position("alice", market)).toBe(qty);
    expect(await w.position("bob", market)).toBe(-qty);

    // At $30k alice has lost $100k, her whole balance; MM is $7.5k.
    const loss = perp.notional(qty, ENTRY) - perp.notional(qty, CRASH);
    const mm =
      (perp.notional(qty, CRASH) * BigInt(perp.config.mmBps)) / 10_000n;
    expect(100_000_000_000n - loss).toBeLessThan(mm);

    await w.pushOracle(market, CRASH);
    await w.untilFlat(["alice"], market);

    expect(await w.position("alice", market)).toBe(0n);
    const post = await w.account("alice");
    expect(post).not.toBeNull();
    expect(post!.equity).toBeGreaterThanOrEqual(0n);

    await invariants(w);
  }, 60_000);
});
