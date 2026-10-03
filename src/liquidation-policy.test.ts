import { describe, it, expect } from "vitest";
import { encodeSignedTx, decodeTx } from "./codec.js";
import { decodeAdminAction, ACTION_TAG_BY_KIND } from "./governance-query.js";
import {
  decodeLiquidationPolicy,
  validateLiquidationPolicy,
  decodeLiquidationRestart,
  validateLiquidationRestart,
} from "./liquidation-policy.js";
import type { Action, AdminAction } from "./types.js";

const U64 = (1n << 64n) - 1n,
  U32 = 0xffffffff;
const raw = (): unknown[] => [
  null,
  U64,
  [Array(32).fill(7), U64, U64],
  [U64, U32, U64, U32, U32],
  U64,
  U64,
  Array(12).fill(U32),
  Array(6).fill(U32),
];
const restartRaw = (): unknown[] => [
  Array(20).fill(3),
  U64,
  U64,
  Array(32).fill(7),
  U64,
  U64,
  U64,
  U64,
];

describe("dormant liquidation governance transport", () => {
  it("preserves widest wire integers without supplying economic defaults", () => {
    const value = decodeLiquidationPolicy(raw());
    expect(value.funding.id).toEqual(new Uint8Array(32).fill(7));
    expect(value.revision).toBe(U64);
    expect(value.work.checkpointBytes).toBe(U32);
    expect(value.expectedRevision).toBe(null);
    validateLiquidationPolicy(value);
    expect(decodeAdminAction({ PublishLiquidationPolicy: raw() })).toEqual({
      kind: "PublishLiquidationPolicy",
      value,
    });
  });
  it("uses distinct canonical publish/revoke tags and authoritative WASM bytes", () => {
    expect(ACTION_TAG_BY_KIND.PublishLiquidationPolicy).toBe(22);
    expect(ACTION_TAG_BY_KIND.RevokeLiquidationPolicy).toBe(23);
    expect(ACTION_TAG_BY_KIND.RestartLiquidationPlan).toBe(24);
    for (const action of [
      {
        kind: "PublishLiquidationPolicy",
        value: decodeLiquidationPolicy(raw()),
      },
      { kind: "RevokeLiquidationPolicy", value: { revision: U64 } },
      {
        kind: "RestartLiquidationPlan",
        value: decodeLiquidationRestart(restartRaw()),
      },
    ] satisfies AdminAction[]) {
      const proposal: Action = {
        type: "ProposeAdminAction",
        data: {
          proposer: new Uint8Array(20).fill(3),
          registryVersion: 1n,
          action,
        },
      };
      const bytes = encodeSignedTx(
        proposal,
        123n,
        new Uint8Array(32),
        new Uint8Array(64),
      );
      expect(decodeTx(bytes).action).toEqual(proposal);
    }
  });
  it("copies IDs and decodes optional predecessors exactly", () => {
    const tuple = raw();
    tuple[0] = U64;
    const decoded = decodeLiquidationPolicy(tuple);
    expect(decoded.expectedRevision).toBe(U64);
    (tuple[2] as unknown[])[0] = Array(32).fill(8);
    expect(decoded.funding.id).toEqual(new Uint8Array(32).fill(7));
    expect(decodeAdminAction({ RevokeLiquidationPolicy: [U64] })).toEqual({
      kind: "RevokeLiquidationPolicy",
      value: { revision: U64 },
    });
  });
  it("binds every restart field without narrowing u64 or inventing defaults", () => {
    const raw = restartRaw();
    const value = decodeLiquidationRestart(raw);
    validateLiquidationRestart(value);
    expect(decodeAdminAction({ RestartLiquidationPlan: raw })).toEqual({
      kind: "RestartLiquidationPlan",
      value,
    });
    expect(value.expectedWindowGeneration).toBe(U64);
    expect(value.expectedCheckpointHash).toEqual(new Uint8Array(32).fill(7));
    (raw[0] as number[])[0] = 1;
    (raw[3] as number[])[0] = 1;
    expect(value.owner[0]).toBe(3);
    expect(value.expectedCheckpointHash[0]).toBe(7);
  });
  it("rejects truncated or widened restart tuples and malformed commitments", () => {
    for (const raw of [restartRaw().slice(1), [...restartRaw(), 0]])
      expect(() => decodeLiquidationRestart(raw)).toThrow();
    for (const [index, bad] of [
      [0, Array(19).fill(0)],
      [0, Array(20).fill(256)],
      [3, Array(31).fill(0)],
      [3, Array(32).fill(-1)],
    ]) {
      const raw = restartRaw();
      raw[index as number] = bad;
      expect(() => decodeLiquidationRestart(raw)).toThrow();
    }
    for (const index of [1, 2, 4, 5, 6, 7]) {
      for (const bad of [
        -1n,
        1n << 64n,
        Number.MAX_SAFE_INTEGER + 1,
        undefined,
      ]) {
        const raw = restartRaw();
        raw[index] = bad;
        expect(() => decodeLiquidationRestart(raw)).toThrow();
      }
    }
  });
  it("refuses malformed tuples, identities and unsafe integers", () => {
    for (const input of [raw().slice(1), [...raw(), 1]])
      expect(() => decodeLiquidationPolicy(input)).toThrow();
    for (const bad of [
      -1,
      Number.MAX_SAFE_INTEGER + 1,
      -1n,
      1n << 64n,
      undefined,
    ]) {
      const p = raw();
      p[1] = bad;
      expect(() => decodeLiquidationPolicy(p)).toThrow();
    }
    for (const bad of [
      Array(31).fill(0),
      Array(32).fill(256),
      new Uint8Array(33),
    ]) {
      const p = raw();
      (p[2] as unknown[])[0] = bad;
      expect(() => decodeLiquidationPolicy(p)).toThrow();
    }
    const p = raw();
    (p[6] as number[])[0] = U32 + 1;
    expect(() => decodeLiquidationPolicy(p)).toThrow();
    expect(() => decodeAdminAction({ RevokeLiquidationPolicy: [] })).toThrow();
  });
});
