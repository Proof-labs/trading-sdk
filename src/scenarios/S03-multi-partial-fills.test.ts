/**
 * S03 — Multiple partial fills converging to zero resting
 *
 * Alice limit-buys 10 BTC @ $50k. Two other users pick at her order
 * from different sides of the stack:
 *   - Bob limit-sells 3 @ $50k     → alice filled 3, rests with 7
 *   - Carol limit-sells 4 @ $50k   → alice filled 4 more (11-4 = 7-4=3), rests with 3
 *
 * Expected:
 *   - alice ends long 7 (3 + 4)
 *   - bob ends short 3
 *   - carol ends short 4
 *   - signed position sum = 0 (invariant)
 *   - alice's remaining bid at $50k has totalQty = 3
 *   - no stray orders on the ask side (bob and carol both crossed)
 *
 * This covers the multi-maker-per-taker-sequence path that the
 * single-transaction-per-side scenarios (S01/S02) don't reach. If
 * the matching engine mishandles multiple passes against the same
 * resting order (e.g. off-by-one on remaining size, double-decrement
 * of open_order_count), this scenario catches it.
 *
 * Runs only when RPC_URL is set.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { seedWorld, BTC_PERP, type World } from "./harness.js";
import { invariants } from "./invariants.js";

const RPC_URL = process.env.RPC_URL;
const describeScenario = RPC_URL ? describe : describe.skip;

describeScenario("S03: multiple partial fills converge to remainder", () => {
  let w: World;

  beforeAll(async () => {
    w = await seedWorld();
  });

  it("alice's 10-lot bid absorbs a 3-fill then a 4-fill", async () => {
    const price = 50_000_000_000n; // $50,000 microUSD
    const bidQty = 10n;
    const bobQty = 3n;
    const carolQty = 4n;
    const expectedRemainder = bidQty - bobQty - carolQty; // 3

    await w.alice.limitBuy(BTC_PERP, bidQty, price);
    await w.bob.limitSell(BTC_PERP, bobQty, price);
    await w.carol.limitSell(BTC_PERP, carolQty, price);

    // Positions reflect the two fills.
    expect(await w.position("alice", BTC_PERP)).toBe(bobQty + carolQty);
    expect(await w.position("bob", BTC_PERP)).toBe(-bobQty);
    expect(await w.position("carol", BTC_PERP)).toBe(-carolQty);

    // Alice's remainder sits on the $50k bid level. Ambient traffic
    // (other MMs etc.) may share the level, so we find by price
    // rather than assuming bids[0].
    const book = await w.orderbook(BTC_PERP);
    const aliceLevel = book.bids.find((l) => l.price === price);
    expect(
      aliceLevel?.totalQty,
      "alice's 3-lot remainder should rest at the $50k bid level",
    ).toBe(expectedRemainder);

    // Bob and carol should have NO resting orders (both fully
    // crossed).
    const bobAsks = book.asks.filter((l) => l.price === price);
    expect(
      bobAsks.length === 0 || bobAsks[0].totalQty === 0n,
      "bob's ask should have fully crossed",
    ).toBe(true);

    await invariants(w);
  });
});
