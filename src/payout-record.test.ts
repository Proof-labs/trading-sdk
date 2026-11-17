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
  solanaSignature: Uint8Array.from({ length: 64 }, (_, i) => i),
  lastValidBlockHeight: (1n << 64n) - 1n,
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

  it.each([63, 65])("refuses a %i-byte signature", (length) => {
    expect(() =>
      encodePayloadBytes({
        type: "RecordWithdrawalPayout",
        data: { ...report, solanaSignature: new Uint8Array(length) },
      }),
    ).toThrow(/expected 64 raw Solana signature bytes/);
  });

  it.each([null, undefined])("requires the transfer expiry (%s)", (expiry) => {
    expect(() =>
      encodePayloadBytes({
        type: "RecordWithdrawalPayout",
        data: { ...report, lastValidBlockHeight: expiry as unknown as bigint },
      }),
    ).toThrow(/last_valid_block_height|u64/);
  });

  // The wire field is NonZeroU64: an expiry of 0 would make the transfer look
  // expired at once to peer watchers.
  it("refuses a zero transfer expiry", () => {
    expect(() =>
      encodePayloadBytes({
        type: "RecordWithdrawalPayout",
        data: { ...report, lastValidBlockHeight: 0n },
      }),
    ).toThrow(/nonzero/);
  });
});
