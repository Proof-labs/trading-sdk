import { describe, expect, it } from "vitest";
import {
  ActionType,
  decodeTx,
  encodePayloadBytes,
  encodeSignedTx,
  peekActionType,
  type RecordWithdrawalPayout,
} from "./index.js";

const report: RecordWithdrawalPayout = {
  withdrawalId: (1n << 64n) - 1n,
  holder: new Uint8Array(20).fill(5),
  solanaSignature: Uint8Array.from({ length: 64 }, (_, i) => i),
  lastValidBlockHeight: (1n << 64n) - 1n,
};

describe("RecordWithdrawalPayout contract", () => {
  it("preserves raw signature bytes and exact u64 bounds", () => {
    const action = { type: "RecordWithdrawalPayout" as const, data: report };
    const bytes = encodeSignedTx(
      action,
      1n,
      new Uint8Array(32),
      new Uint8Array(64),
    );
    const decoded = decodeTx(bytes);
    expect(peekActionType(bytes)).toBe(ActionType.RecordWithdrawalPayout);
    expect(decoded.action).toEqual(action);
  });

  it.each([63, 65])("refuses a %i-byte signature", (length) => {
    expect(() =>
      encodePayloadBytes({
        type: "RecordWithdrawalPayout",
        data: { ...report, solanaSignature: new Uint8Array(length) },
      }),
    ).toThrow(/64/);
  });

  it.each([null, undefined])("requires the transfer expiry (%s)", (expiry) => {
    expect(() =>
      encodePayloadBytes({
        type: "RecordWithdrawalPayout",
        data: { ...report, lastValidBlockHeight: expiry as unknown as bigint },
      }),
    ).toThrow(/last_valid_block_height|u64/);
  });
});
