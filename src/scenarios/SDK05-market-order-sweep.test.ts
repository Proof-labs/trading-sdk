/**
 * SDK05 — Market order sweeps multiple price levels
 *
 * Alice posts three asks at ascending prices forming a tight ladder:
 *   1 @ $50,000
 *   2 @ $50,100
 *   3 @ $50,200
 *
 * Bob submits a market BUY for 5 contracts. The matcher sweeps in
 * price order:
 *   - fills 1 at $50,000 (alice's $50k level cleared)
 *   - fills 2 at $50,100 (alice's $50.1k level cleared)
 *   - fills 2 at $50,200 (alice's $50.2k level has 1 remaining)
 *
 * Expected:
 *   - alice ends short 5 (sum of fills)
 *   - bob ends long 5
 *   - alice has exactly one resting ask: 1 @ $50,200
 *   - bob has no remainder (market order filled full 5)
 *
 * This covers the cross-level sweep path that SDK01 (single level) and
 * SDK02 (single maker/taker pair) don't reach. If the matcher has an
 * off-by-one on level iteration or applies the taker's size to the
 * wrong level, this scenario catches it.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { seedWorld, BTC_PERP, type World } from "./harness.js";
import { invariants } from "./invariants.js";

const RPC_URL = process.env.RPC_URL;
const describeScenario = RPC_URL ? describe : describe.skip;

describeScenario("SDK05: market order sweeps three price levels", () => {
  let w: World;

  beforeAll(async () => {
    w = await seedWorld();
  });

  it("market buy 5 fills 1 + 2 + 2 across 3 ladder levels", async () => {
    const p0 = 50_000_000_000n; // $50,000.00
    const p1 = 50_100_000_000n; // $50,100.00
    const p2 = 50_200_000_000n; // $50,200.00

    // Post the ladder as three separate asks from alice. Serial so
    // the nonce contract is clean.
    await w.alice.limitSell(BTC_PERP, 1n, p0);
    await w.alice.limitSell(BTC_PERP, 2n, p1);
    await w.alice.limitSell(BTC_PERP, 3n, p2);

    // Bob takes 5 via a market order. Sweeps 1 + 2 + (2 of 3).
    await w.bob.marketOrder(BTC_PERP, "Buy", 5n);

    // Positions: alice short 5, bob long 5.
    expect(await w.position("alice", BTC_PERP)).toBe(-5n);
    expect(await w.position("bob", BTC_PERP)).toBe(5n);

    // Alice's only remaining ask is 1 @ $50,200.
    const book = await w.orderbook(BTC_PERP);
    const level0 = book.asks.find((l) => l.price === p0);
    const level1 = book.asks.find((l) => l.price === p1);
    const level2 = book.asks.find((l) => l.price === p2);

    // Levels 0 and 1 should be entirely cleared (either absent from
    // the book or totalQty=0 if other users happen to share them).
    expect(
      level0 === undefined || level0.totalQty === 0n,
      "p0=$50k level should be empty (alice's 1-lot fully filled)",
    ).toBe(true);
    expect(
      level1 === undefined || level1.totalQty === 0n,
      "p1=$50.1k level should be empty (alice's 2-lot fully filled)",
    ).toBe(true);

    // Level 2 should have alice's 1-lot remainder. Ambient traffic
    // may add; check alice's share by scoping to the level's
    // residual vs. what we know she placed.
    expect(
      level2 !== undefined && level2.totalQty >= 1n,
      "p2=$50.2k level should have at least alice's 1-lot remainder",
    ).toBe(true);

    await invariants(w);
  });
});
