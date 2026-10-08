import { beforeAll, describe, expect, it } from "vitest";
import {
  ready,
  encodePayloadBytes,
  encodeSignedTx,
  decodeTx,
  bytesToHex,
} from "./index.js";
import { adminActionToWasm } from "./codec-adapter.js";
import { decodeAdminAction } from "./governance-query.js";
import {
  decodePublishLiquidationPolicy,
  decodeRevokeLiquidationPolicy,
  decodeSetPartialLiquidationActivation,
  validateSetPartialLiquidationActivation,
  validatePublishLiquidationPolicy,
  type PublishLiquidationPolicy,
} from "./partial-liquidation-policy.js";

const payload = [
  null,
  1n,
  [10500, 100, 1000n, 100, 1000000n, 10, 20, 20, 10, 100, 100000, 30n],
];
const command = (): PublishLiquidationPolicy =>
  decodePublishLiquidationPolicy(payload);

describe("minimum partial liquidation policy", () => {
  beforeAll(ready);

  it("freezes the separate activation command and rejects malformed generations", () => {
    const value = decodeSetPartialLiquidationActivation([null, 1n, 1n, true]);
    const action = {
      type: "ProposeAdminAction" as const,
      data: {
        proposer: new Uint8Array(20).fill(0xa1),
        registryVersion: 1n,
        action: { kind: "SetPartialLiquidationActivation" as const, value },
      },
    };
    expect(
      bytesToHex(encodePayloadBytes(action)).endsWith(
        "81bf5365745061727469616c4c69717569646174696f6e41637469766174696f6e94c00101c3",
      ),
    ).toBe(true);
    expect(
      decodeTx(
        encodeSignedTx(action, 1n, new Uint8Array(32), new Uint8Array(64)),
      ).action,
    ).toEqual(action);
    expect(
      decodeAdminAction({
        SetPartialLiquidationActivation: [null, 1n, 1n, true],
      }),
    ).toEqual(action.data.action);
    expect(adminActionToWasm(action.data.action)).toEqual({
      SetPartialLiquidationActivation: {
        expected_generation: null,
        generation: 1n,
        revision: 1n,
        enabled: true,
      },
    });
    for (const malformed of [
      [null, 2n, 1n, false],
      [0n, 1n, 1n, false],
      [null, 1n, 1n, 1],
      [null, 1n, 0n, false],
      [null, 1n, 1n, false, 0],
    ]) {
      expect(() => decodeSetPartialLiquidationActivation(malformed)).toThrow();
    }
    expect(() =>
      validateSetPartialLiquidationActivation({
        ...value,
        expectedGeneration: 0xffff_ffff_ffff_ffffn,
      }),
    ).toThrow();
  });

  it("matches frozen engine wire bytes and round-trips through the real WASM codec", () => {
    const actions = [
      {
        kind: "PublishLiquidationPolicy" as const,
        value: command(),
        hex: "81b85075626c6973684c69717569646174696f6e506f6c69637993c0019ccd290464cd03e864ce000f42400a14140a64ce000186a01e",
      },
      {
        kind: "RevokeLiquidationPolicy" as const,
        value: { revision: 1n },
        hex: "81b75265766f6b654c69717569646174696f6e506f6c6963799101",
      },
    ];
    for (const { kind, value, hex } of actions) {
      const action = {
        type: "ProposeAdminAction" as const,
        data: {
          proposer: new Uint8Array(20).fill(0xa1),
          registryVersion: 1n,
          action:
            kind === "PublishLiquidationPolicy"
              ? { kind, value: value as PublishLiquidationPolicy }
              : { kind, value: value as { revision: bigint } },
        },
      };
      expect(bytesToHex(encodePayloadBytes(action)).endsWith(hex)).toBe(true);
      expect(
        decodeTx(
          encodeSignedTx(action, 1n, new Uint8Array(32), new Uint8Array(64)),
        ).action,
      ).toEqual(action);
    }
  });
  it("decodes the exact positional wire record without defaults", () => {
    expect(command().policy.completionTargetBps).toBe(10500);
    expect(command().policy.stalledProgressBlocks).toBe(30n);
    expect(decodeAdminAction({ PublishLiquidationPolicy: payload })).toEqual({
      kind: "PublishLiquidationPolicy",
      value: command(),
    });
    expect(decodeAdminAction({ RevokeLiquidationPolicy: [1n] })).toEqual({
      kind: "RevokeLiquidationPolicy",
      value: { revision: 1n },
    });
  });

  it("adapts fields without mutating caller input", () => {
    const value = command();
    const before = structuredClone(value);
    expect(
      adminActionToWasm({ kind: "PublishLiquidationPolicy", value }),
    ).toEqual({
      PublishLiquidationPolicy: {
        expected_current_revision: null,
        revision: 1n,
        policy: {
          completion_target_bps: 10500,
          partial_penalty_bps: 100,
          max_reference_age_ms: 1000n,
          max_reference_spread_bps: 100,
          min_reference_side_notional: 1000000n,
          max_reference_orders: 10,
          max_book_orders: 20,
          max_candidate_prefixes: 20,
          max_committed_fills: 10,
          max_state_reads: 100,
          max_state_read_bytes: 100000,
          stalled_progress_blocks: 30n,
        },
      },
    });
    expect(value).toEqual(before);
  });

  it.each([
    ["completionTargetBps", 10000],
    ["partialPenaltyBps", 101],
    ["maxReferenceAgeMs", 0n],
    ["maxReferenceSpreadBps", 10001],
    ["minReferenceSideNotional", -1n],
    ["maxReferenceOrders", 0],
    ["maxBookOrders", 1.5],
    ["maxCandidatePrefixes", 0],
    ["maxCommittedFills", 21],
    ["maxStateReads", Infinity],
    ["maxStateReadBytes", 0x100000000],
    ["stalledProgressBlocks", 1n << 64n],
  ])("rejects invalid %s before WASM encoding", (field, invalid) => {
    const value = command();
    Object.assign(value.policy, { [field]: invalid });
    expect(() => validatePublishLiquidationPolicy(value)).toThrow();
    expect(() =>
      adminActionToWasm({ kind: "PublishLiquidationPolicy", value }),
    ).toThrow();
  });

  it("rejects missing/trailing fields and unsafe integer revisions", () => {
    expect(() => decodePublishLiquidationPolicy(payload.slice(0, 2))).toThrow();
    expect(() => decodePublishLiquidationPolicy([...payload, 0])).toThrow();
    expect(() => decodePublishLiquidationPolicy([null, 1n, []])).toThrow();
    expect(() => decodeRevokeLiquidationPolicy([1n, 0])).toThrow();
    expect(() =>
      decodeRevokeLiquidationPolicy([Number.MAX_SAFE_INTEGER + 1]),
    ).toThrow();
    expect(() =>
      validatePublishLiquidationPolicy({ ...command(), revision: 0n }),
    ).toThrow();
    expect(() =>
      validatePublishLiquidationPolicy({
        ...command(),
        expectedCurrentRevision: 0n,
      }),
    ).toThrow();
  });
});
