/**
 * SDK22 — COVID-style fast crash replay
 *
 * March 12, 2020 ("Black Thursday"): BTC dropped from ~$8k to
 * ~$3.8k in 24 hours, with a single 50%+ candle. BitMEX took the
 * brunt — its insurance fund absorbed ~$30M and the venue went
 * down for "scheduled maintenance" mid-cascade. Other venues with
 * more conservative pre-liquidation caps and better waterfalls (FTX,
 * Binance) absorbed the same shock without halting.
 *
 * This scenario replays the shape on a perp created for it:
 *
 *   1. Many leveraged longs across $1k-$50k account sizes (typical
 *      retail distribution), each near its initial margin limit.
 *   2. Sharp 50% oracle drop in a single price.
 *   3. Every long is liquidated and no account is left underwater.
 *
 * Catalog: ProofOfBrain vault, testing/exchange-test-scenarios.md — "SDK-suite scenarios" section (SDK22).
 *
 * Runs only when `RPC_URL`, `RELAYER_PRIVATE_KEY` and `ORACLE_PRIVATE_KEY`
 * are set; the rest of the live-stack environment is in the README.
 */
import { describe, it, beforeAll, expect } from "vitest";
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

const ENTRY = 50_000_000_000n; // $50k
const CRASH = 25_000_000_000n; // -50%
const SEED = 1_000_000_000n; // $1k
// Account size per trader: small $1k, medium $10k, whale $50k.
const BALANCES: Record<string, bigint> = {
  s1: SEED,
  s2: SEED,
  s3: SEED,
  s4: SEED,
  s5: SEED,
  m1: 10_000_000_000n,
  m2: 10_000_000_000n,
  m3: 10_000_000_000n,
  w1: 50_000_000_000n,
  w2: 50_000_000_000n,
};
const TRADERS = Object.keys(BALANCES);

describeScenario("SDK22: COVID-style 50% crash absorbed cleanly", () => {
  let w: World;
  let perp: Perp;

  beforeAll(async () => {
    w = await seedWorld({
      ...envWorldOptions(),
      users: ["mm", ...TRADERS],
      seedBalance: SEED,
    });
    for (const name of TRADERS) {
      if (BALANCES[name]! > SEED) await w.deposit(name, BALANCES[name]! - SEED);
    }
    await w.deposit("mm", 1_000_000_000_000n);
    perp = await w.createPerp(
      { imBps: 1000, mmBps: 500, szDecimals: 5 },
      ENTRY,
    );
  }, 120_000);

  it("liquidates every long and leaves no account underwater", async () => {
    const { market } = perp;
    // Each long uses 90% of the notional its balance can margin.
    const sizes = new Map<string, bigint>();
    for (const name of TRADERS) {
      const notional =
        (BALANCES[name]! * 10_000n * 90n) / BigInt(perp.config.imBps) / 100n;
      const qty = perp.quantityFor(notional, ENTRY);
      sizes.set(name, qty);
      await w.users[name]!.limitBuy(market, qty, ENTRY);
    }
    const total = [...sizes.values()].reduce((a, b) => a + b, 0n);
    await w.users.mm!.limitSell(market, total, ENTRY);
    for (const name of TRADERS) {
      expect(await w.position(name, market)).toBe(sizes.get(name));
    }

    await w.pushOracle(market, CRASH);
    await w.untilFlat(TRADERS, market);

    for (const name of TRADERS) {
      expect(await w.position(name, market), `${name} should be flat`).toBe(0n);
    }
    for (const name of ["mm", ...TRADERS]) {
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
