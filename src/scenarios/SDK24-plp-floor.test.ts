/**
 * SDK24 — Proof liquidity provider (PLP) floor enforcement
 *
 * `PlpConfig.min_balance_floor` is the explicit non-Hyperliquid
 * design choice: PLP stops absorbing once its balance drops below
 * the floor (default: 60% of bootstrap). Below the floor, deficits
 * route directly to Tier 1 (per-pool IF) — PLP is preserved as a
 * profitable MM rather than being forced to inherit positions.
 *
 * The engine-level tests
 * (`engine::tests::waterfall_tier0_plp_at_floor_passes_through`,
 * `waterfall_tier0_plp_absorbs_above_floor`) cover the dispatch
 * directly with synthetic state. This scenario covers the same
 * behaviour end-to-end through the live chain — emitting events in
 * the order an off-chain consumer would observe and verifying both
 * paths produce the right event flow.
 *
 * Today the harness doesn't yet expose a `PlpConfig` setter (would
 * need a new admin action plumbed through the SDK). For v1, this
 * scenario is a placeholder that documents the expected flow once
 * the admin action lands. The framework runs but the core PLP
 * setup step is `expect.fail`-ed loudly so no one assumes the path
 * is exercised.
 *
 * Catalog: ProofOfBrain vault, testing/exchange-test-scenarios.md — "SDK-suite scenarios" section (SDK24).
 */
import { describe, it, beforeAll, expect } from "vitest";
import { seedWorld, type World } from "./harness.js";

const RPC_URL = process.env.RPC_URL;
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY;
const ORACLE_PRIVATE_KEY = process.env.ORACLE_PRIVATE_KEY;

const describeScenario =
  RPC_URL && RELAYER_PRIVATE_KEY && ORACLE_PRIVATE_KEY
    ? describe
    : describe.skip;

describeScenario("SDK24: PLP floor enforcement (e2e)", () => {
  let w: World;

  beforeAll(async () => {
    w = await seedWorld({
      relayerPrivateKey: RELAYER_PRIVATE_KEY,
      oraclePrivateKey: ORACLE_PRIVATE_KEY,
    });
    void w; // referenced once admin action lands
  }, 60_000);

  it.skip("PLP absorbs above floor, IF takes over below floor", () => {
    // Once the SDK exposes an PLP-config admin action:
    //   1. Configure PLP with bootstrap=$1B, floor=$600M, balance=$1B.
    //   2. Trigger a $100M liquidation deficit. Assert PlpAbsorbed
    //      event fires with amount=$100M and post-balance=$900M.
    //   3. Trigger another $400M deficit. Assert PlpAbsorbed fires
    //      partially (only $300M absorbable; $100M residual) and
    //      InsuranceFundUpdated fires for the residual $100M.
    //   4. Trigger a $50M deficit. Assert no PlpAbsorbed event
    //      (PLP at floor); InsuranceFundUpdated fires for the full
    //      $50M.
    expect.fail(
      "SDK24 e2e not yet runnable — needs an admin SDK action to set PlpConfig. " +
        "Engine-level coverage in `waterfall_tier0_*` tests handles the dispatch.",
    );
  });
});
