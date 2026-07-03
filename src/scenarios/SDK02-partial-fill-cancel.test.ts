/**
 * SDK02 — Partial fill + cancel
 *
 * Alice limit-buys 5 BTC @ $50k. Bob limit-sells 2 BTC @ $50k → Alice's
 * order partially fills (2 of 5). Alice then cancels the remainder.
 *
 * Expected:
 *   - Alice ends +2 BTC long, Bob ends -2 BTC short.
 *   - After cancelAll, no Alice bid remains at $50k.
 *
 * Units match SDK01 — integer lot quantities, microUSD prices.
 *
 * Catalog: ProofOfBrain vault, testing/exchange-test-scenarios.md — "SDK-suite scenarios" section (SDK02).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { seedWorld, BTC_PERP, type World } from "./harness.js";
import { invariants } from "./invariants.js";

const RPC_URL = process.env.RPC_URL;
const describeScenario = RPC_URL ? describe : describe.skip;

describeScenario("SDK02: partial fill then cancel", () => {
  let w: World;

  beforeAll(async () => {
    w = await seedWorld();
  });

  it("partial fill leaves correct book; cancel removes remainder", async () => {
    const price = 50_000_000_000n; // $50,000 in microUSD
    const buyQty = 5n; // Alice bids 5
    const sellQty = 2n; // Bob sells 2 → 2 fill, 3 rest on Alice's bid
    const remainder = buyQty - sellQty;

    await w.alice.limitBuy(BTC_PERP, buyQty, price);
    await w.bob.limitSell(BTC_PERP, sellQty, price);

    // Positions reflect the 2-lot fill.
    expect(await w.position("alice", BTC_PERP)).toBe(sellQty);
    expect(await w.position("bob", BTC_PERP)).toBe(-sellQty);

    // Alice's 3-lot remainder sits at the $50k level. Find it by price;
    // other ambient bids (from MMs, HLP, etc.) may share the book, so
    // we cannot assume this is `bids[0]`.
    const bookBefore = await w.orderbook(BTC_PERP);
    const aliceLevelBefore = bookBefore.bids.find((l) => l.price === price);
    expect(
      aliceLevelBefore?.totalQty,
      "alice's remainder should rest at the $50k bid level",
    ).toBe(remainder);

    // Cancel all Alice's open orders and confirm the $50k level no
    // longer holds her quantity. Ambient traffic means the level may
    // still exist from other users — but Alice's contribution must go.
    const cancelled = await w.alice.cancelAll();
    expect(cancelled).toBeGreaterThanOrEqual(1);

    const bookAfter = await w.orderbook(BTC_PERP);
    const levelAfter = bookAfter.bids.find((l) => l.price === price);
    // Either the level is gone entirely, or its remaining totalQty no
    // longer includes Alice's remainder.
    if (levelAfter) {
      expect(levelAfter.totalQty).toBeLessThan(aliceLevelBefore!.totalQty);
    }

    await invariants(w);
  });
});
