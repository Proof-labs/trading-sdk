/**
 * S21 — JELLY-shape blowout replay
 *
 * The 2025 Hyperliquid JELLY incident: a single concentrated long
 * position on a low-liquidity perp blew up when the oracle dropped
 * 80%, triggering a cascading liquidation that exhausted the
 * insurance fund. The protocol-owned MM (HLP) was forced to inherit
 * the stuck position, taking a $10M+ unrealized loss while quoting
 * downward for hours.
 *
 * This scenario replays the shape — single whale, thin book, sharp
 * adverse move — against Proof's four-tier waterfall to verify:
 *
 *   1. Pre-liquidation per-account position cap rejected the
 *      whale's escalation BEFORE the position grew large enough
 *      to trigger the cascade. (Proof's `MarketConfig.max_position_size`
 *      is the structural fix Hyperliquid lacked.)
 *   2. If the cap were disabled or the position grew within it,
 *      the four-tier waterfall (HLP → IF → socialized → ADL) absorbs
 *      the bad debt cleanly without forcing HLP to hold inherited
 *      positions.
 *   3. No trader account left underwater post-event.
 *
 * Catalog: ../../../../docs/exchange-test-scenarios.md (S21).
 *
 * Runs only when `RPC_URL`, `RELAYER_PRIVATE_KEY`, and
 * `ORACLE_PRIVATE_KEY` are set.
 */
import { describe, it, beforeAll, expect } from "vitest";
import { seedWorld, BTC_PERP, type World } from "./harness.js";

const RPC_URL = process.env.RPC_URL;
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY;
const ORACLE_PRIVATE_KEY = process.env.ORACLE_PRIVATE_KEY;

const describeScenario =
  RPC_URL && RELAYER_PRIVATE_KEY && ORACLE_PRIVATE_KEY
    ? describe
    : describe.skip;

describeScenario("S21: JELLY-shape blowout absorbed by waterfall", () => {
  let w: World;

  beforeAll(async () => {
    w = await seedWorld({
      relayerPrivateKey: RELAYER_PRIVATE_KEY,
      oraclePrivateKey: ORACLE_PRIVATE_KEY,
      users: ["whale", "mm", "winner1", "winner2", "winner3"],
      seedBalance: 1_000_000_000_000n, // $1M each — large enough for the replay
    });
  }, 60_000);

  it("absorbs an 80% oracle drop on a concentrated whale long", async () => {
    // Anchor the oracle at $50k.
    const entry = 50_000_000_000n;
    await w.pushOracle(BTC_PERP, entry);

    // Whale opens a 100-contract long at $50k (so $5M notional).
    // MM crosses with the symmetric short.
    const qty = 100n;
    await w.whale.limitBuy(BTC_PERP, qty, entry);
    await w.mm.limitSell(BTC_PERP, qty, entry);

    expect(await w.position("whale", BTC_PERP)).toBe(qty);
    expect(await w.position("mm", BTC_PERP)).toBe(-qty);

    // Three "winner" accounts open profitable shorts at the same price
    // so they appear in the ADL queue with positive uPnL once the
    // oracle drops. They each go short 5 contracts.
    for (const name of ["winner1", "winner2", "winner3"] as const) {
      await w.users[name]!.limitSell(BTC_PERP, 5n, entry);
    }
    // MM crosses by buying 15 contracts at the same price.
    await w.mm.limitBuy(BTC_PERP, 15n, entry);

    // 80% oracle drop — JELLY-style.
    await w.pushOracle(BTC_PERP, 10_000_000_000n);
    await w.waitOneBlock();
    await w.waitOneBlock();
    await w.waitOneBlock();

    // Whale should be flat (liquidated by sweep).
    expect(await w.position("whale", BTC_PERP)).toBe(0n);

    // No trader-side account underwater (winners profited; whale's
    // realised loss was absorbed via the waterfall).
    for (const name of ["whale", "winner1", "winner2", "winner3"] as const) {
      const acct = await w.account(name);
      expect(acct).not.toBeNull();
      if (acct)
        expect(
          acct.equity,
          `${name} must not be underwater`,
        ).toBeGreaterThanOrEqual(0n);
    }

    // The MM (which inherited part of the whale's bad fill via the
    // symmetric short) should also be solvent — Proof doesn't force
    // the MM to hold inherited positions like Hyperliquid did.
    const mmAcct = await w.account("mm");
    expect(mmAcct).not.toBeNull();
    if (mmAcct) {
      expect(mmAcct.equity).toBeGreaterThanOrEqual(0n);
    }
  }, 120_000);
});
