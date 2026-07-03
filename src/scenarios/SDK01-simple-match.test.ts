/**
 * SDK01 — Simple full match
 *
 * Alice limit-buys 1 BTC @ $50k, Bob limit-sells 1 BTC @ $50k.
 * Expected: both orders fully fill, Alice ends +1 BTC long, Bob ends
 * -1 BTC short (symmetric), and the $50k level is cleared from the book.
 *
 * Units:
 *   - quantity: integer lots (1n = 1 contract). The mono engine uses
 *     whole-contract lot sizes, not sub-contract fractional units.
 *   - price: microUSD (6 dp). 50_000_000_000n = $50,000.
 *
 * Catalog: ProofOfBrain vault, testing/exchange-test-scenarios.md — "SDK-suite scenarios" section (SDK01).
 *
 * Runs only when `RPC_URL` is set. CI keeps this skipped so that
 * `npm test` stays green without a live node.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { seedWorld, BTC_PERP, type World } from "./harness.js";
import { invariants } from "./invariants.js";

const RPC_URL = process.env.RPC_URL;
const describeScenario = RPC_URL ? describe : describe.skip;

describeScenario("SDK01: simple full match", () => {
  let w: World;

  beforeAll(async () => {
    w = await seedWorld();
  });

  it("both sides fully filled at 50k", async () => {
    const qty = 1n; // 1 contract
    const price = 50_000_000_000n; // $50,000 in microUSD

    await w.alice.limitBuy(BTC_PERP, qty, price);
    await w.bob.limitSell(BTC_PERP, qty, price);

    // Alice is long 1, Bob is short 1, signed sum = 0 (checked by
    // positionSymmetry invariant below).
    expect(await w.position("alice", BTC_PERP)).toBe(qty);
    expect(await w.position("bob", BTC_PERP)).toBe(-qty);

    await invariants(w);
  });
});
