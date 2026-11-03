/**
 * SDK23 — Pool isolation: a blowout in one pool does NOT drain another
 *
 * The four-tier waterfall (docs/adl-vs-socialized-loss.md §3) groups
 * markets into pools by `MarketConfig.pool_id`. The whole point of
 * the per-pool insurance fund (Tier 1) is that a JELLY-shape blowout
 * in a high-vol pool can't drain the fund that backs another pool.
 *
 * This scenario creates one perp in pool 0 and one in pool 1, funds the
 * pool-1 insurance fund, liquidates an insolvent pool-0 long, and checks
 * that the pool-1 fund kept every dollar and took no position.
 *
 * Catalog: ProofOfBrain vault, testing/exchange-test-scenarios.md — "SDK-suite scenarios" section (SDK23).
 *
 * Runs only when `RPC_URL`, `RELAYER_PRIVATE_KEY` and `ORACLE_PRIVATE_KEY`
 * are set; the rest of the live-stack environment is in the README.
 */
import { describe, it, beforeAll, expect } from "vitest";
import { ExchangeClient } from "../client.js";
import {
  envWorldOptions,
  insuranceFundAddress,
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
const CRASH = 20_000_000_000n; // -60%: alice's loss exceeds her balance
const POOL_1_FUNDING = 10_000_000_000n; // $10k

describeScenario("SDK23: pool isolation across the IF dispatch", () => {
  let w: World;
  let pool0: Perp;
  let pool1: Perp;
  let reader: ExchangeClient;

  const pool1Fund = async () => {
    const state = await reader.queryFinancialState({
      markets: [pool0.market, pool1.market],
      owners: [insuranceFundAddress(1)],
    });
    const balance = state.insurancePools.find((p) => p.pool === 1)?.balance;
    return { balance, positions: state.accounts[0]?.positions ?? [] };
  };

  beforeAll(async () => {
    w = await seedWorld(envWorldOptions());
    reader = new ExchangeClient({ gatewayUrl: w.gatewayUrl });
    const spec = { imBps: 1000, mmBps: 500, szDecimals: 5 };
    pool0 = await w.createPerp({ ...spec, poolId: 0 }, ENTRY);
    pool1 = await w.createPerp({ ...spec, poolId: 1 }, ENTRY);
    await w.govern(
      {
        kind: "FundInsuranceFund",
        value: {
          fundingId: BigInt(Date.now()),
          source: w.carol.address,
          allocations: [{ poolId: 1, amount: POOL_1_FUNDING }],
        },
      },
      "FundInsuranceFund(pool 1)",
    );
  }, 120_000);

  it("a pool-0 liquidation only debits pool-0 IF", async () => {
    expect(pool0.config.poolId).toBe(0);
    expect(pool1.config.poolId).toBe(1);
    const before = await pool1Fund();
    expect(before.balance).toBeGreaterThanOrEqual(POOL_1_FUNDING);

    const { market } = pool0;
    const qty = pool0.quantityFor(250_000_000_000n, ENTRY);
    await w.alice.limitBuy(market, qty, ENTRY);
    await w.bob.limitSell(market, qty, ENTRY);
    expect(await w.position("alice", market)).toBe(qty);
    expect(await w.position("bob", market)).toBe(-qty);

    await w.pushOracle(market, CRASH);
    await w.untilFlat(["alice"], market);
    expect(await w.position("alice", market)).toBe(0n);

    const after = await pool1Fund();
    expect(after.balance).toBe(before.balance);
    expect(after.positions).toEqual(before.positions);

    await invariants(w);
  }, 120_000);
});
