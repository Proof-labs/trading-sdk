import { describe, expect, it } from "vitest";
import { decodeTx, encodePayloadBytes, encodeSignedTx } from "./codec.js";
import { bytesToHex, hexToBytes } from "./crypto.js";
import { ACTION_TAG_BY_KIND, decodeAdminAction } from "./governance-query.js";
import type { Action, AdminAction } from "./types.js";

/** exchange-wire's frozen ExecInsuranceFund vector: pool 2 cancels every
 *  order of 0xAB.. on market 7. */
const INNER_HEX =
  "81af43616e63656c416c6c4f726465727392dc0014" + "ccab".repeat(20) + "07";
const EXEC_HEX = "81b145786563496e737572616e636546756e649202c43e" + INNER_HEX;

/** exchange-wire's frozen SetMarginOffsetPolicy vectors. */
const OFFSET_HEX =
  "81b55365744d617267696e4f6666736574506f6c69637992c09195010201cd1388b252656d6f76654f6e5265736f6c7574696f6e";
const REVOKE_HEX = "81b55365744d617267696e4f6666736574506f6c696379920190";

const exec = (): AdminAction => ({
  kind: "ExecInsuranceFund",
  value: { poolId: 2, action: hexToBytes(INNER_HEX) },
});
const offsets = (): AdminAction => ({
  kind: "SetMarginOffsetPolicy",
  value: {
    predecessor: null,
    pairs: [
      {
        perpetual: 1,
        conditional: 2,
        settlementReference: 1,
        rate: 5_000,
        resolution: "RemoveOnResolution",
      },
    ],
  },
});
const revoke = (): AdminAction => ({
  kind: "SetMarginOffsetPolicy",
  value: { predecessor: 1n, pairs: [] },
});

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

const pair = (conditional: number, rate = 5_000, perpetual = 1) => [
  perpetual,
  conditional,
  perpetual,
  rate,
  "RemoveOnResolution",
];

describe("proof-wire 8 admin actions", () => {
  it("carries inner tags 26 and 27", () => {
    expect(ACTION_TAG_BY_KIND.ExecInsuranceFund).toBe(26);
    expect(ACTION_TAG_BY_KIND.SetMarginOffsetPolicy).toBe(27);
  });

  it.each([
    ["ExecInsuranceFund", exec, EXEC_HEX],
    ["SetMarginOffsetPolicy", offsets, OFFSET_HEX],
    ["SetMarginOffsetPolicy revoke", revoke, REVOKE_HEX],
  ])("encodes %s to exchange-wire's frozen bytes", (_, action, hex) => {
    const payload = bytesToHex(encodePayloadBytes(propose(action())));
    expect(payload.endsWith(`01${hex}`)).toBe(true);
  });

  it.each([
    ["ExecInsuranceFund", exec],
    ["SetMarginOffsetPolicy", offsets],
    ["SetMarginOffsetPolicy revoke", revoke],
  ])("round-trips %s through the WASM codec", (_, action) => {
    const tx = encodeSignedTx(
      propose(action()),
      12n,
      new Uint8Array(32),
      new Uint8Array(64),
    );
    expect(decodeTx(tx).action).toEqual(propose(action()));
  });

  it("decodes both from their wire tuples", () => {
    expect(
      decodeAdminAction({
        ExecInsuranceFund: [2, Array.from(hexToBytes(INNER_HEX))],
      }),
    ).toEqual(exec());
    expect(
      decodeAdminAction({ SetMarginOffsetPolicy: [null, [pair(2)]] }),
    ).toEqual(offsets());
    expect(decodeAdminAction({ SetMarginOffsetPolicy: [1, []] })).toEqual(
      revoke(),
    );
  });

  it.each([
    [[0, []], /sequence 0 must be non-zero/],
    [[null, [pair(2, 0)]], /rate/],
    [[null, [pair(2, 10_000)]], /rate/],
    [
      [null, [[1, 2, 3, 5_000, "RemoveOnResolution"]]],
      /settlement reference 3 must be its perpetual/,
    ],
    [[null, [pair(3), pair(2)]], /must exceed the previous conditional/],
    [[null, [pair(2), pair(2)]], /repeats conditional/],
    [[null, [[1, 2, 1, 5_000, "Keep"]]], /unknown variant `Keep`/],
  ])("refuses a non-canonical margin-offset policy %j", (payload, error) => {
    expect(() => decodeAdminAction({ SetMarginOffsetPolicy: payload })).toThrow(
      error,
    );
  });

  it("refuses a malformed ExecInsuranceFund", () => {
    expect(() => decodeAdminAction({ ExecInsuranceFund: [256, [1]] })).toThrow(
      /integer `256`, expected u8/,
    );
    expect(() => decodeAdminAction({ ExecInsuranceFund: [2] })).toThrow();
  });
});
