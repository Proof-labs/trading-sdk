import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  encodePayloadBytes,
  encodeSignedTx,
  peekActionType,
  type RecordWithdrawalPayout,
} from "./index.js";

const report: RecordWithdrawalPayout = {
  withdrawalId: (1n << 64n) - 1n,
  holder: new Uint8Array(20).fill(5),
  vault: Uint8Array.from({ length: 32 }, (_, i) => i),
  squadsTransactionIndex: 4294967295,
  registryEpoch: (1n << 64n) - 1n,
};

// Pinned once in conformance/codec.ndjson, shared with Rust and Python.
const u64Bounds = readFileSync(
  new URL("../conformance/codec.ndjson", import.meta.url),
  "utf8",
)
  .split("\n")
  .filter(Boolean)
  .map(
    (line) =>
      JSON.parse(line) as { case: string; expect: { payload_hex: string } },
  )
  .find((c) => c.case === "record_withdrawal_payout/u64_bounds")!;

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

describe("RecordWithdrawalPayout contract", () => {
  it("public builder matches the shared u64_bounds vector", () => {
    const action = { type: "RecordWithdrawalPayout" as const, data: report };
    expect(hex(encodePayloadBytes(action))).toBe(u64Bounds.expect.payload_hex);
    const signed = encodeSignedTx(
      action,
      1n,
      new Uint8Array(32),
      new Uint8Array(64),
    );
    expect(peekActionType(signed)).toBe(0x31);
  });

  it.each([31, 33])("refuses a %i-byte vault", (length) => {
    expect(() =>
      encodePayloadBytes({
        type: "RecordWithdrawalPayout",
        data: { ...report, vault: new Uint8Array(length) },
      }),
    ).toThrow(/32 bytes/);
  });

  it.each([null, undefined])("requires the registry epoch (%s)", (epoch) => {
    expect(() =>
      encodePayloadBytes({
        type: "RecordWithdrawalPayout",
        data: { ...report, registryEpoch: epoch as unknown as bigint },
      }),
    ).toThrow(/registry_epoch|u64/);
  });
});
