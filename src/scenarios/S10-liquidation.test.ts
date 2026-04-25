/**
 * S10 — Liquidation at maintenance margin threshold
 *
 * Alice opens a leveraged long, an adversarial price move pushes mark
 * below the maintenance margin threshold, and the end-of-block
 * liquidation sweep closes her position. The insurance fund is updated
 * iff the liquidation produced bad debt.
 *
 * Pre-2026-04-25 this file was a placeholder because the harness had
 * no way to push oracle updates. The harness now exposes
 * `world.pushOracle(market, price)` (gated on `relayerPrivateKey` /
 * the `RELAYER_PRIVATE_KEY` env var), so we can drive the oracle
 * downward without needing a market-order flow.
 *
 * Catalog: ../../../../docs/exchange-test-scenarios.md (S10).
 *
 * Runs only when both `RPC_URL` and `RELAYER_PRIVATE_KEY` are set.
 * CI keeps this skipped so `npm test` stays green without a live node.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { seedWorld, BTC_PERP, type World } from "./harness.js";
import { invariants } from "./invariants.js";

const RPC_URL = process.env.RPC_URL;
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY;
const ORACLE_PRIVATE_KEY = process.env.ORACLE_PRIVATE_KEY;
const describeScenario =
  RPC_URL && RELAYER_PRIVATE_KEY && ORACLE_PRIVATE_KEY
    ? describe
    : describe.skip;

describeScenario("S10: liquidation on adverse price move", () => {
  let w: World;

  beforeAll(async () => {
    w = await seedWorld({
      relayerPrivateKey: RELAYER_PRIVATE_KEY,
      oraclePrivateKey: ORACLE_PRIVATE_KEY,
    });
  });

  it("position closes and equity ≥ 0 after a sub-MM oracle move", async () => {
    // 1. Anchor the oracle at $50k so margin math is round.
    const entry = 50_000_000_000n; // $50,000 in microUSDC
    await w.pushOracle(BTC_PERP, entry);

    // 2. Alice opens a leveraged long. With im_bps=1000 (10x max
    //    leverage), 5 contracts at $50k = $250k notional → IM=$25k.
    //    Alice's seed balance is $100k so she's at ~25% utilisation.
    //    Bob fills as counterparty.
    const qty = 5n;
    await w.alice.limitBuy(BTC_PERP, qty, entry);
    await w.bob.limitSell(BTC_PERP, qty, entry);

    expect(await w.position("alice", BTC_PERP)).toBe(qty);
    expect(await w.position("bob", BTC_PERP)).toBe(-qty);

    // 3. Push the oracle down hard enough to break maintenance margin.
    //    With mm_bps=500 (5%), MM at $30k = 5 × 30k × 5% = $7.5k.
    //    Alice's equity at $30k mark = balance - uPnL_loss
    //                                = $100k − $25k − (5 × ($50k − $30k))
    //                                = $100k − $25k − $100k = −$25k.
    //    Wait — open IM came out of balance (engine reserves it). So
    //    available balance is $75k after open, equity = $75k − $100k
    //    realized-loss-on-mark = −$25k. That's < MM of $7.5k → liquidate.
    const liquidationMark = 30_000_000_000n; // $30k
    await w.pushOracle(BTC_PERP, liquidationMark);

    // 4. Wait for end-of-block liquidation sweep to run.
    await w.waitOneBlock();
    await w.waitOneBlock();

    // 5. Assert position closed and core invariants hold.
    expect(await w.position("alice", BTC_PERP)).toBe(0n);
    const post = await w.account("alice");
    expect(post).not.toBeNull();
    if (post) {
      // Equity may be 0 (clean liquidation, balance covered the loss)
      // or negative-clamped-to-0 (insurance fund absorbed bad debt).
      // Either way it must not be negative — the invariant guarantees
      // post-liquidation accounts never sit underwater on chain.
      expect(post.equity).toBeGreaterThanOrEqual(0n);
    }

    // 6. Run the universal invariants — orderbook not crossed,
    //    positions sum to zero across users, no underwater accounts.
    await invariants(w);
  });
});
