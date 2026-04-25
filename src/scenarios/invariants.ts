/**
 * Invariants run at the end of every scenario. Any violation = the whole
 * scenario fails, regardless of what the scenario itself was checking.
 *
 * When a production bug reveals a new invariant, add it here so every
 * past and future scenario starts catching it. The philosophy: scenarios
 * test specific behaviours; invariants test properties that must hold
 * everywhere, always.
 */
import { expect } from "vitest";
import type { World } from "./harness.js";
import { BTC_PERP, ETH_PERP } from "./harness.js";

/**
 * Run every invariant against the world. Callers should `await invariants(w)`
 * at the end of each `it(...)` block.
 */
export async function invariants(w: World): Promise<void> {
  await orderbookNotCrossed(w, BTC_PERP);
  await orderbookNotCrossed(w, ETH_PERP);
  await positionSymmetry(w, BTC_PERP);
  await positionSymmetry(w, ETH_PERP);
  await noNegativeEquity(w);
  // Balance conservation would need a per-scenario baseline snapshot.
  // Add once the harness records starting deposits.
}

/**
 * The best bid price must always be strictly less than the best ask. A
 * crossed book means the matcher skipped a fill that should have
 * happened — a serious correctness bug.
 */
async function orderbookNotCrossed(w: World, market: number): Promise<void> {
  const ob = await w.orderbook(market);
  const bestBid = ob.bids[0]?.price;
  const bestAsk = ob.asks[0]?.price;
  if (bestBid !== undefined && bestAsk !== undefined) {
    expect(bestBid < bestAsk, `orderbook crossed on market ${market}`).toBe(
      true,
    );
  }
}

/**
 * Signed position sizes across all seeded users must sum to zero on every
 * market. Every contract long has a corresponding short; a non-zero sum
 * implies phantom contracts were minted or burned by the matcher.
 *
 * Caveats:
 *   - Only holds when liquidity providers and takers are all in `w.users`.
 *     If a scenario introduces off-book counterparties, skip this check
 *     or adjust the expected sum.
 */
async function positionSymmetry(w: World, market: number): Promise<void> {
  let sum = 0n;
  for (const name of Object.keys(w.users)) {
    sum += await w.position(name, market);
  }
  expect(sum, `position sum non-zero on market ${market}`).toBe(0n);
}

/**
 * Equity (balance + unrealized PnL) must never go negative. If it does,
 * the liquidation engine failed to close a position in time and the
 * account went underwater — bad debt.
 */
async function noNegativeEquity(w: World): Promise<void> {
  for (const name of Object.keys(w.users)) {
    const acct = await w.account(name);
    if (!acct) continue;
    expect(acct.equity >= 0n, `user ${name} has negative equity`).toBe(true);
  }
}
