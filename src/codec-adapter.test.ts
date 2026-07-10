import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ready, getWasm } from "./wasm-loader.js";
import { toWasmFields } from "./codec-adapter.js";
import { encodePayloadBytes } from "./codec.js";
import { Outcome, Side, TimeInForce, type Action } from "./types.js";

/**
 * Differential proof for the TS→WASM encode path: for representative actions,
 * `encode_payload(toWasmFields(action))` (the WASM path) must reproduce
 * `encodePayloadBytes(action)` (the legacy hand-written codec) byte-for-byte.
 * Skips when `src/wasm/` is unbuilt.
 */

const built = existsSync(
  fileURLToPath(
    new URL("./wasm/proof_trading_sdk_wasm_bg.wasm", import.meta.url),
  ),
);

const OWNER = new Uint8Array(20).fill(0xab);
const SIGNER = new Uint8Array(20).fill(0xcd);

const CASES: { name: string; action: Action }[] = [
  {
    name: "PlaceOrder (all fields)",
    action: {
      type: "PlaceOrder",
      data: {
        market: 1,
        owner: OWNER,
        side: Side.Buy,
        price: 6_675_234n,
        quantity: 10n,
        clientOrderId: 7n,
        postOnly: true,
        reduceOnly: false,
        timeInForce: TimeInForce.Ioc,
      },
    },
  },
  {
    name: "PlaceOrder (minimal — defaults omitted)",
    action: {
      type: "PlaceOrder",
      data: {
        market: 2,
        owner: OWNER,
        side: Side.Sell,
        price: 100n,
        quantity: 1n,
      },
    },
  },
  {
    name: "MarketOrder",
    action: {
      type: "MarketOrder",
      data: {
        market: 3,
        owner: OWNER,
        side: Side.Sell,
        quantity: 5n,
        clientOrderId: null,
      },
    },
  },
  {
    name: "CancelOrder",
    action: { type: "CancelOrder", data: { orderId: 999n, owner: OWNER } },
  },
  {
    name: "CancelClientOrder",
    action: {
      type: "CancelClientOrder",
      data: { owner: OWNER, clientOrderId: 42n },
    },
  },
  {
    name: "CancelAllOrders (market scoped)",
    action: { type: "CancelAllOrders", data: { owner: OWNER, market: 6 } },
  },
  {
    name: "CancelReplaceOrder",
    action: {
      type: "CancelReplaceOrder",
      data: {
        owner: OWNER,
        cancelClientOrderId: 101n,
        market: 2,
        side: Side.Sell,
        price: 12_345n,
        quantity: 7n,
        clientOrderId: 202n,
        postOnly: true,
        reduceOnly: false,
        timeInForce: TimeInForce.Fok,
      },
    },
  },
  {
    name: "AmendOrder",
    action: {
      type: "AmendOrder",
      data: { owner: OWNER, orderId: 42n, newPrice: 12_346n, newQuantity: 8n },
    },
  },
  {
    name: "ClosePosition",
    action: { type: "ClosePosition", data: { market: 1, owner: OWNER } },
  },
  {
    name: "OracleUpdate",
    action: {
      type: "OracleUpdate",
      data: {
        market: 1,
        price: 5000n,
        signer: SIGNER,
        publishTimeMs: 1_000_000n,
      },
    },
  },
  {
    name: "OracleUpdateComposite",
    action: {
      type: "OracleUpdateComposite",
      data: {
        market: 1,
        price: 6_675_000n,
        nSources: 4,
        signer: SIGNER,
        publishTimeMs: 1_700_000_000_000n,
      },
    },
  },
  {
    name: "ResolveEvent (outcome enum)",
    action: {
      type: "ResolveEvent",
      data: { impactMarketId: 1, outcome: Outcome.Yes, signer: SIGNER },
    },
  },
  {
    name: "AtomicBasketOrder (legs array with side enum)",
    action: {
      type: "AtomicBasketOrder",
      data: {
        owner: OWNER,
        legs: [
          { market: 1, side: Side.Buy, price: 100n, quantity: 2n },
          {
            market: 2,
            side: Side.Sell,
            price: 200n,
            quantity: 3n,
            reduceOnly: true,
          },
        ],
        maxSlippageBps: 50,
      },
    },
  },
  {
    name: "CreateMarket (poolId + ticker)",
    action: {
      type: "CreateMarket",
      data: {
        market: 1,
        imBps: 500,
        mmBps: 250,
        takerFeeBps: 10,
        makerFeeBps: 5,
        signer: SIGNER,
        fundingIntervalMs: 3_600_000n,
        maxFundingRateBps: 100,
        poolId: 0,
        szDecimals: 3,
        ticker: "BTC",
      },
    },
  },
  {
    name: "CreateImpactMarket (RelayerAttested)",
    action: {
      type: "CreateImpactMarket",
      data: {
        impactMarketId: 1,
        underlyingMarket: 1,
        childMarketBase: 100,
        question: "Will X?",
        deadlineMs: 1_000n,
        resolutionWindowMs: 2_000n,
        imBps: 500,
        mmBps: 250,
        takerFeeBps: 10,
        makerFeeBps: 5,
        fundingIntervalMs: 3_600_000n,
        maxFundingRateBps: 100,
        signer: SIGNER,
        oracleSource: { kind: "RelayerAttested" },
      },
    },
  },
  {
    name: "CreateImpactMarket (UnderlyingPriceVsStrike)",
    action: {
      type: "CreateImpactMarket",
      data: {
        impactMarketId: 2,
        underlyingMarket: 1,
        childMarketBase: 200,
        question: "Above strike?",
        deadlineMs: 1_000n,
        resolutionWindowMs: 2_000n,
        imBps: 500,
        mmBps: 250,
        takerFeeBps: 10,
        makerFeeBps: 5,
        fundingIntervalMs: 3_600_000n,
        maxFundingRateBps: 100,
        signer: SIGNER,
        oracleSource: {
          kind: "UnderlyingPriceVsStrike",
          strikePrice: 50_000n,
          comparison: "GreaterThan",
        },
      },
    },
  },
  {
    name: "CreateImpactMarket (MarketOracle)",
    action: {
      type: "CreateImpactMarket",
      data: {
        impactMarketId: 3,
        underlyingMarket: 1,
        childMarketBase: 300,
        question: "Cross-market?",
        deadlineMs: 1_000n,
        resolutionWindowMs: 2_000n,
        imBps: 500,
        mmBps: 250,
        takerFeeBps: 10,
        makerFeeBps: 5,
        fundingIntervalMs: 3_600_000n,
        maxFundingRateBps: 100,
        signer: SIGNER,
        oracleSource: {
          kind: "MarketOracle",
          market: 2,
          strikePrice: 50_000n,
          comparison: "LessThanOrEqual",
        },
      },
    },
  },
  {
    // NB: `markSourceMode` is deliberately omitted here — the legacy codec
    // encodes it incorrectly (see the "WASM fixes a latent legacy bug" test
    // below), so it is not a valid differential case.
    name: "UpdateMarketFees (feeTiers, nested struct)",
    action: {
      type: "UpdateMarketFees",
      data: {
        market: 1,
        signer: SIGNER,
        takerFeeBps: 10,
        feeTiers: [
          {
            min30dVolumeMicroUsdc: 1_000_000n,
            makerFeeTenthBps: 5,
            takerFeeTenthBps: 10,
          },
        ],
      },
    },
  },
  {
    name: "ConfirmDeposit",
    action: {
      type: "ConfirmDeposit",
      data: {
        owner: OWNER,
        amount: 1_000_000n,
        solanaTxSig: new Uint8Array(64).fill(1),
        signer: SIGNER,
      },
    },
  },
];

describe.skipIf(!built)("TS→WASM encode adapter ↔ legacy codec", () => {
  beforeAll(async () => {
    await ready();
  });

  for (const { name, action } of CASES) {
    it(`reproduces legacy payload bytes: ${name}`, () => {
      const { actionType, fields } = toWasmFields(action);
      const wasmHex = Buffer.from(
        getWasm().encode_payload(actionType, fields),
      ).toString("hex");
      const legacyHex = Buffer.from(encodePayloadBytes(action)).toString("hex");
      expect(wasmHex).toBe(legacyHex);
    });
  }
});

/**
 * The WASM differential originally surfaced a real bug in the hand-written TS
 * codec: `UpdateMarketFees.markSourceMode` used the integer variant index while
 * the authoritative Rust core uses the enum name. The legacy path has since
 * been fixed, so keep both encoders pinned to the same canonical bytes.
 */
describe.skipIf(!built)("WASM and legacy enum encoding agree", () => {
  beforeAll(async () => {
    await ready();
  });

  it("encodes markSourceMode as the canonical enum name, not a bare integer", () => {
    const action: Action = {
      type: "UpdateMarketFees",
      data: { market: 1, signer: SIGNER, markSourceMode: 1 },
    };
    const { actionType, fields } = toWasmFields(action);
    const wasmHex = Buffer.from(
      getWasm().encode_payload(actionType, fields),
    ).toString("hex");
    const legacyHex = Buffer.from(encodePayloadBytes(action)).toString("hex");

    // Both paths write the variant name "Median" (a6 = str6 tag + UTF-8 bytes).
    const medianHex = Buffer.from("Median", "utf8").toString("hex");
    expect(wasmHex).toContain(medianHex);
    expect(legacyHex).toContain(medianHex);
    expect(wasmHex).toBe(legacyHex);
  });
});
