import { describe, expect, it } from "vitest";
import { adminActionToWasm } from "./codec-adapter.js";
import { decodeTx, encodePayloadBytes, encodeSignedTx } from "./codec.js";
import { bytesToHex } from "./crypto.js";
import { ACTION_TAG_BY_KIND, decodeAdminAction } from "./governance-query.js";
import { adminProposalContentHash } from "./index.js";
import { validateSetLiquidationConfig } from "./liquidation-config.js";
import type {
  Action,
  AdminAction,
  LiquidationConfig,
  SetLiquidationConfig,
} from "./types.js";

/** The configuration exchange-wire freezes in its own vector. */
function config(): LiquidationConfig {
  return {
    targetRatioBps: 10_500,
    fullCloseThreshold: { numerator: 2, denominator: 3 },
    partialPenaltyBps: 100,
    maxBookOrders: 20,
    maxCommittedFills: 10,
    takeoverDiscountBps: 50,
  };
}

function update(
  overrides: Partial<SetLiquidationConfig> = {},
  configOverrides: Partial<LiquidationConfig> = {},
): AdminAction {
  return {
    kind: "SetLiquidationConfig",
    value: {
      predecessor: 1n,
      sequence: 2n,
      config: { ...config(), ...configOverrides },
      ...overrides,
    },
  };
}

function propose(action: AdminAction): Action {
  return {
    type: "ProposeAdminAction",
    data: {
      proposer: new Uint8Array(20).fill(0xa1),
      registryVersion: 1n,
      action,
    },
  };
}

/** exchange-wire's frozen `canonical_admin_action_bytes` for `update()`. */
const FROZEN_ACTION_HEX =
  "81b45365744c69717569646174696f6e436f6e666967" +
  "930102" +
  "96cd29049202036414" +
  "0a32";

describe("SetLiquidationConfig governance action", () => {
  it("carries inner tag 17", () => {
    expect(ACTION_TAG_BY_KIND.SetLiquidationConfig).toBe(17);
  });

  it("translates to the snake_case wasm shape", () => {
    expect(adminActionToWasm(update())).toEqual({
      SetLiquidationConfig: {
        predecessor: 1n,
        sequence: 2n,
        config: {
          target_ratio_bps: 10_500,
          full_close_threshold: { numerator: 2, denominator: 3 },
          partial_penalty_bps: 100,
          max_book_orders: 20,
          max_committed_fills: 10,
          takeover_discount_bps: 50,
        },
      },
    });
  });

  it("encodes the proposal to exchange-wire's frozen action bytes", () => {
    const payload = bytesToHex(encodePayloadBytes(propose(update())));
    expect(payload.endsWith(`01${FROZEN_ACTION_HEX}`)).toBe(true);
  });

  it("round-trips a proposal through the WASM codec", () => {
    const action = propose(update());
    const tx = encodeSignedTx(
      action,
      12n,
      new Uint8Array(32),
      new Uint8Array(64),
    );
    expect(decodeTx(tx).action).toEqual(action);
  });

  it("reproduces exchange-wire's content hash", () => {
    const hash = adminProposalContentHash({
      chainId: new Uint8Array(32).fill(0x11),
      proposalId: 42n,
      registryVersion: 3n,
      threshold: 2,
      proposer: new Uint8Array(20).fill(0x22),
      createdHeight: 7n,
      createdMs: 1_000n,
      expiryMs: 259_201_000n,
      action: update(),
    });
    expect(bytesToHex(hash)).toBe(
      "1759bbe56cdd4604699aa7fc464b04fa8e79f055a23b26c9b4f25d386943136c",
    );
  });

  it("decodes a proposal from its wire tuple", () => {
    expect(
      decodeAdminAction({
        SetLiquidationConfig: [1, 2n, [10_500, [2, 3], 100, 20, 10, 50]],
      }),
    ).toEqual(update());
  });

  it("decodes a proposal written before the takeover discount", () => {
    expect(
      decodeAdminAction({
        SetLiquidationConfig: [1, 2n, [10_500, [2, 3], 100, 20, 10]],
      }),
    ).toEqual(update());
  });

  it("refuses the proof-wire 6.x eight-field configuration", () => {
    expect(() =>
      decodeAdminAction({
        SetLiquidationConfig: [
          1,
          2,
          [10_500, [2, 3], 100, 20, 20, 10, 10_000, 1_000_000],
        ],
      }),
    ).toThrow(/config/);
  });

  it("fails closed on a malformed or invalid wire tuple", () => {
    expect(() =>
      decodeAdminAction({ SetLiquidationConfig: [1, 2, [10_500, [2, 3]]] }),
    ).toThrow(/config/);
    expect(() =>
      decodeAdminAction({
        SetLiquidationConfig: [2, 2, [10_500, [2, 3], 100, 20, 10]],
      }),
    ).toThrow(/sequence must exceed predecessor/);
  });
});

describe("validateSetLiquidationConfig mirrors the wire bounds", () => {
  const value = (action: AdminAction) =>
    (action as { value: SetLiquidationConfig }).value;

  it("accepts the frozen configuration", () => {
    expect(() => validateSetLiquidationConfig(value(update()))).not.toThrow();
  });

  it.each<[string, AdminAction, RegExp]>([
    [
      "a target ratio at one",
      update({}, { targetRatioBps: 10_000 }),
      /targetRatioBps/,
    ],
    [
      "a zero full-close numerator",
      update({}, { fullCloseThreshold: { numerator: 0, denominator: 3 } }),
      /fullCloseThreshold/,
    ],
    [
      "a full-close threshold of one",
      update({}, { fullCloseThreshold: { numerator: 3, denominator: 3 } }),
      /fullCloseThreshold/,
    ],
    [
      "a zero full-close denominator",
      update({}, { fullCloseThreshold: { numerator: 1, denominator: 0 } }),
      /fullCloseThreshold/,
    ],
    [
      "a penalty above 100 basis points",
      update({}, { partialPenaltyBps: 101 }),
      /partialPenaltyBps/,
    ],
    [
      "a takeover discount above 100 basis points",
      update({}, { takeoverDiscountBps: 101 }),
      /takeoverDiscountBps/,
    ],
    [
      "a zero book-order cap",
      update({}, { maxBookOrders: 0 }),
      /maxBookOrders must be non-zero/,
    ],
    [
      "a zero committed-fill cap",
      update({}, { maxCommittedFills: 0 }),
      /maxCommittedFills must be non-zero/,
    ],
    [
      "a sequence equal to its predecessor",
      update({ predecessor: 2n, sequence: 2n }),
      /sequence must exceed predecessor/,
    ],
    [
      "a sequence below its predecessor",
      update({ predecessor: 3n, sequence: 2n }),
      /sequence must exceed predecessor/,
    ],
    [
      "a non-integer limit",
      update({}, { maxBookOrders: 1.5 }),
      /maxBookOrders/,
    ],
  ])("refuses %s", (_name, action, message) => {
    expect(() => validateSetLiquidationConfig(value(action))).toThrow(message);
    expect(() => encodePayloadBytes(propose(action))).toThrow(message);
  });
});
