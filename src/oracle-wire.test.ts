import { describe, expect, it } from "vitest";
import {
  decodeTx,
  encodePayloadBytes,
  encodeSignedTx,
  adminProposalContentHash,
} from "./codec.js";
import { fromWasmFields } from "./codec-adapter.js";
import {
  decodeAdminAction,
  decodeProposalDisplayInfo,
} from "./governance-query.js";
import { ActionType, type Action, type AdminProposalContext } from "./types.js";

const observation = (confidence: bigint | null = null): Action => ({
  type: "SubmitOracleObservation",
  data: {
    market: 7,
    policyVersion: (1n << 64n) - 1n,
    sourceId: 2,
    publishTimeMs: 1_700_000_000_123n,
    priceMicro: (1n << 64n) - 1n,
    confidenceMicro: confidence,
    evidenceDigest: new Uint8Array(32).fill(0xa5),
    signer: new Uint8Array(20).fill(0x22),
  },
});

describe("operator oracle wire conformance", () => {
  it.each([null, 25_000n, (1n << 64n) - 1n])(
    "round trips exact integer and byte fields (%s)",
    (confidence) => {
      const action = observation(confidence);
      const encoded = encodeSignedTx(
        action,
        42n,
        new Uint8Array(32),
        new Uint8Array(64),
      );
      const decoded = decodeTx(encoded);
      expect(decoded.action.type).toBe("SubmitOracleObservation");
      expect(decoded.action).toEqual(action);
      expect(ActionType.SubmitOracleObservation).toBe(0x2d);
    },
  );

  it("rejects malformed digest width and out-of-range integers", () => {
    for (const change of [
      { evidenceDigest: new Uint8Array(31) },
      { sourceId: 2 ** 32 },
      { priceMicro: 1n << 64n },
    ]) {
      const action = observation();
      Object.assign(action.data, change);
      expect(() => encodePayloadBytes(action)).toThrow();
    }
  });

  it("preserves bigint types even when u64 values fit a JavaScript number", () => {
    const action = observation(0n);
    Object.assign(action.data, {
      policyVersion: 1n,
      publishTimeMs: 2n,
      priceMicro: 3n,
    });
    expect(
      decodeTx(
        encodeSignedTx(action, 42n, new Uint8Array(32), new Uint8Array(64)),
      ).action,
    ).toEqual(action);
  });

  it("uses field names for bytes without converting future numeric lists", () => {
    const decoded = fromWasmFields(0x2d, {
      evidence_digest: [0, 255],
      future_market_ids: [1, 300],
    });
    expect(decoded.data).toMatchObject({
      evidenceDigest: new Uint8Array([0, 255]),
      futureMarketIds: [1, 300],
    });
    expect(() => fromWasmFields(0x2d, { evidence_digest: [256] })).toThrow(
      /byte field/,
    );
    expect(() => fromWasmFields(0x2d, { evidence_digest: [1.5] })).toThrow(
      /byte field/,
    );
  });

  it("round trips a policy proposal's complete opaque bytes", () => {
    const action: Action = {
      type: "ProposeAdminAction",
      data: {
        proposer: new Uint8Array(20),
        registryVersion: 1n,
        action: {
          kind: "ConfigureOraclePolicy",
          value: {
            effectiveHeight: 123n,
            bundle: new Uint8Array([0x91, 0xc0, 0xff]),
          },
        },
      },
    };
    expect(
      decodeTx(
        encodeSignedTx(action, 42n, new Uint8Array(32), new Uint8Array(64)),
      ).action,
    ).toEqual(action);
  });

  it("strictly decodes the existing proposal read model without approving contents", () => {
    expect(
      decodeAdminAction({ ConfigureOraclePolicy: [123, [0x91, 0xc0, 0xff]] }),
    ).toEqual({
      kind: "ConfigureOraclePolicy",
      value: {
        effectiveHeight: 123n,
        bundle: new Uint8Array([0x91, 0xc0, 0xff]),
      },
    });
    for (const payload of [[123], [123, [256]], [-1, []], [123, [], "extra"]]) {
      expect(() =>
        decodeAdminAction({ ConfigureOraclePolicy: payload }),
      ).toThrow();
    }
  });

  it("pins proposal display tag 0x0c and rejects the adjacent reserved tag", () => {
    const row = [
      1,
      "Pending",
      "Pending",
      1,
      2,
      new Uint8Array(20),
      [],
      [],
      1,
      1000,
      2000,
      12,
      { ConfigureOraclePolicy: [123, [0x91, 0xc0]] },
      [0x91, 0xc0],
      new Uint8Array(32),
    ];
    expect(decodeProposalDisplayInfo(row).actionTag).toBe(12);
    row[11] = 11;
    expect(() => decodeProposalDisplayInfo(row)).toThrow(/does not match/);
  });

  it("content commitment changes with any policy byte or effective height", () => {
    const context: AdminProposalContext = {
      chainId: new Uint8Array(32),
      proposalId: 1n,
      registryVersion: 1n,
      threshold: 2,
      proposer: new Uint8Array(20),
      createdHeight: 1n,
      createdMs: 1000n,
      expiryMs: 2000n,
      action: {
        kind: "ConfigureOraclePolicy",
        value: { effectiveHeight: 123n, bundle: new Uint8Array([1, 2]) },
      },
    };
    const baseline = adminProposalContentHash(context);
    expect(
      adminProposalContentHash({
        ...context,
        action: {
          kind: "ConfigureOraclePolicy",
          value: { effectiveHeight: 124n, bundle: new Uint8Array([1, 2]) },
        },
      }),
    ).not.toEqual(baseline);
    expect(
      adminProposalContentHash({
        ...context,
        action: {
          kind: "ConfigureOraclePolicy",
          value: { effectiveHeight: 123n, bundle: new Uint8Array([1, 3]) },
        },
      }),
    ).not.toEqual(baseline);
  });
});
