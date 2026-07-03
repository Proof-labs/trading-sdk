/**
 * SDK20 — Cascade liquidation with 200+ accounts at escalating leverage
 *
 * This is the headline stress test promised in
 * `docs/adl-vs-socialized-loss.md` §Integration tests. The setup:
 *
 *   1. Spin up N (default 200) trader keys, each funded with $10k.
 *   2. Each trader takes a long perp position sized to use 95% of IM
 *      (so a 5% adverse move blows them up).
 *   3. The MM that fills the longs holds the symmetric short.
 *   4. Drop the oracle 30% in one tick.
 *   5. Run end-of-block liquidation. Every long should be closed;
 *      the four-tier waterfall must fully absorb the cumulative
 *      bad debt without crashing the chain or leaving negative
 *      account balances.
 *
 * Pre-2026-04-25 the harness had no oracle push and the engine had
 * no four-tier waterfall, so this scenario was just a placeholder.
 * Now (item 5 + item 13) it can run end-to-end. The scaffolding
 * here covers the smaller-N case (default 25); set
 * `SDK20_TRADER_COUNT=200` to reproduce the full design-doc replay.
 *
 * Catalog: ProofOfBrain vault, testing/exchange-test-scenarios.md — "SDK-suite scenarios" section (SDK20).
 *
 * Runs only when `RPC_URL`, `RELAYER_PRIVATE_KEY`, and
 * `ORACLE_PRIVATE_KEY` are set AND a quiet node (no concurrent MMs)
 * is available.
 */
import { describe, it, beforeAll, expect } from "vitest";
import { seedWorld, BTC_PERP, type World } from "./harness.js";

const RPC_URL = process.env.RPC_URL;
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY;
const ORACLE_PRIVATE_KEY = process.env.ORACLE_PRIVATE_KEY;
const TRADER_COUNT = Number(process.env.SDK20_TRADER_COUNT ?? 25);

const describeScenario =
  RPC_URL && RELAYER_PRIVATE_KEY && ORACLE_PRIVATE_KEY
    ? describe
    : describe.skip;

describeScenario("SDK20: cascade liquidation across many accounts", () => {
  let w: World;

  beforeAll(async () => {
    // Generate trader names: trader1, trader2, ..., traderN. The MM
    // (which provides the symmetric short side) is `mm`.
    const traderNames = Array.from(
      { length: TRADER_COUNT },
      (_, i) => `trader${i + 1}`,
    );
    w = await seedWorld({
      relayerPrivateKey: RELAYER_PRIVATE_KEY,
      oraclePrivateKey: ORACLE_PRIVATE_KEY,
      users: ["mm", ...traderNames],
      seedBalance: 10_000_000_000n, // $10k each
    });
  }, 60_000);

  it(`closes every long after a 30% oracle drop (${TRADER_COUNT} traders)`, async () => {
    // Anchor the oracle at $50k.
    const entry = 50_000_000_000n; // $50k
    await w.pushOracle(BTC_PERP, entry);

    // Each trader buys a 1-contract long — at $50k notional with
    // im_bps=1000 (10% IM), that reserves $5k per trader.
    // MM provides the symmetric short side at the same price.
    // Build the order tape: every trader posts a buy first, MM
    // crosses by selling N contracts at the same price.
    const qty = 1n;
    for (let i = 0; i < TRADER_COUNT; i++) {
      await w.users[`trader${i + 1}`]!.limitBuy(BTC_PERP, qty, entry);
    }
    await w.users.mm!.limitSell(BTC_PERP, BigInt(TRADER_COUNT), entry);

    // Sanity: every trader is +1 long, MM is −N short.
    for (let i = 0; i < TRADER_COUNT; i++) {
      expect(await w.position(`trader${i + 1}`, BTC_PERP)).toBe(qty);
    }
    expect(await w.position("mm", BTC_PERP)).toBe(-BigInt(TRADER_COUNT));

    // Drop the oracle 30% — every long is now under maintenance margin.
    await w.pushOracle(BTC_PERP, 35_000_000_000n);

    // Wait for the end-of-block sweep to run. Two blocks gives the
    // engine time to walk all positions.
    await w.waitOneBlock();
    await w.waitOneBlock();
    await w.waitOneBlock();

    // Every trader's position must be closed. The MM may have
    // partial residual depending on cascade order.
    for (let i = 0; i < TRADER_COUNT; i++) {
      expect(
        await w.position(`trader${i + 1}`, BTC_PERP),
        `trader${i + 1} should be flat after cascade`,
      ).toBe(0n);
    }

    // No trader should be left with negative equity — that's the
    // invariant the four-tier waterfall enforces.
    for (let i = 0; i < TRADER_COUNT; i++) {
      const acct = await w.account(`trader${i + 1}`);
      expect(acct).not.toBeNull();
      if (acct) {
        expect(
          acct.equity,
          `trader${i + 1} must not be underwater`,
        ).toBeGreaterThanOrEqual(0n);
      }
    }
  }, 120_000);
});
