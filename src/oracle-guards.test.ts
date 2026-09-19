import { beforeAll, describe, expect, it } from "vitest";
import { Decoder } from "@msgpack/msgpack";
import {
  adminProposalContentHash,
  bytesToHex,
  decodeTx,
  encodePayloadBytes,
  encodeSignedTx,
  hexToBytes,
  ready,
  validateSetOracleGuards,
  type Action,
  type SetOracleGuards,
} from "./index.js";
import { decodeAdminAction } from "./governance-query.js";

// Independent authority: proof-wire v2.0.0 codec.rs
// set_oracle_guards_wire_vectors_frozen (also consumed by the engine).
const vectors: Array<[SetOracleGuards, string]> = [
  [
    {
      market: 10,
      markPriceMaxOracleAgeMs: 30_000n,
      maxOracleDeviationBps: 2_000,
    },
    "81af5365744f7261636c65477561726473930acd7530cd07d0",
  ],
  [
    {
      market: 10,
      markPriceMaxOracleAgeMs: 30_000n,
      maxOracleDeviationBps: null,
    },
    "81af5365744f7261636c65477561726473930acd7530c0",
  ],
  [
    { market: 10, markPriceMaxOracleAgeMs: null, maxOracleDeviationBps: 2_000 },
    "81af5365744f7261636c65477561726473930ac0cd07d0",
  ],
];

const propose = (value: SetOracleGuards): Action => ({
  type: "ProposeAdminAction",
  data: {
    proposer: new Uint8Array(20).fill(0xa1),
    registryVersion: 1n,
    action: { kind: "SetOracleGuards", value },
  },
});

describe("SetOracleGuards (GH165)", () => {
  beforeAll(ready);

  it.each(vectors)(
    "matches the engine's canonical inner bytes and read shape: %#",
    (value, hex) => {
      const action = propose(value);
      // The inner AdminAction is the final field of ProposeAdminAction.
      expect(bytesToHex(encodePayloadBytes(action)).endsWith(hex)).toBe(true);
      const decoded = decodeTx(
        encodeSignedTx(action, 1n, new Uint8Array(32), new Uint8Array(64)),
      );
      expect(decoded.action).toEqual(action);
      expect(
        decodeAdminAction(
          new Decoder({ useBigInt64: true }).decode(hexToBytes(hex)),
        ),
      ).toEqual({ kind: "SetOracleGuards", value });
    },
  );

  it("treats omitted and null fields identically and preserves full u64 precision", () => {
    expect(
      encodePayloadBytes(propose({ market: 10, maxOracleDeviationBps: 2_000 })),
    ).toEqual(encodePayloadBytes(propose(vectors[2][0])));
    const value = {
      market: 0x7fff_ffff,
      markPriceMaxOracleAgeMs: (1n << 64n) - 1n,
      maxOracleDeviationBps: 10_000,
    };
    expect(
      decodeTx(
        encodeSignedTx(
          propose(value),
          1n,
          new Uint8Array(32),
          new Uint8Array(64),
        ),
      ).action,
    ).toEqual(propose(value));
  });

  it.each([
    { market: 1 },
    { market: 1, markPriceMaxOracleAgeMs: null, maxOracleDeviationBps: null },
    { market: 1, markPriceMaxOracleAgeMs: 0n },
    { market: 1, markPriceMaxOracleAgeMs: -1n },
    { market: 1, markPriceMaxOracleAgeMs: 1n << 64n },
    { market: 1, markPriceMaxOracleAgeMs: 30_000 },
    { market: 1, maxOracleDeviationBps: 0 },
    { market: 1, maxOracleDeviationBps: -1 },
    { market: 1, maxOracleDeviationBps: 10_001 },
    { market: 1, maxOracleDeviationBps: 1.5 },
    { market: 1, maxOracleDeviationBps: NaN },
    { market: -1, maxOracleDeviationBps: 1 },
    { market: 0x8000_0000, maxOracleDeviationBps: 1 },
    { market: 1.5, maxOracleDeviationBps: 1 },
  ])("rejects malformed guards before signing or hashing: %#", (input) => {
    const value = input as SetOracleGuards;
    expect(() => validateSetOracleGuards(value)).toThrow();
    expect(() => encodePayloadBytes(propose(value))).toThrow();
    expect(() =>
      adminProposalContentHash({
        chainId: new Uint8Array(32),
        proposalId: 1n,
        registryVersion: 1n,
        threshold: 2,
        proposer: new Uint8Array(20),
        createdHeight: 1n,
        createdMs: 1n,
        expiryMs: 10n,
        action: { kind: "SetOracleGuards", value },
      }),
    ).toThrow();
  });

  it("rejects malformed read payloads and forbids nesting guards in Batch", () => {
    for (const raw of [
      [10, 0, null],
      [10, null, 0],
      [10, null, null],
      [10, 1, 10_001],
      [10, -1, null],
      [10],
    ]) {
      expect(() => decodeAdminAction({ SetOracleGuards: raw })).toThrow();
    }
    expect(() =>
      decodeAdminAction({ Batch: [{ SetOracleGuards: [10, 30_000, 2_000] }] }),
    ).toThrow(/unknown AdminBatchItem/);
  });
});
