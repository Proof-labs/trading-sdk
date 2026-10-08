import { describe, expect, it } from "vitest";
import { decodePartialLiquidationFee } from "./partial-liquidation-fee.js";

const receipt = () => ({
  owner: "ab".repeat(20),
  market: "7",
  pool_id: "2",
  episode_generation: "3",
  policy_revision: "8",
  fill_id: "9007199254740993",
  assessed: "5",
  collected: "3",
  waived: "2",
  cash_delta: "-3",
});

describe("partial penalty receipt", () => {
  it("retains exact identities and final waived cash without another trade", () => {
    const result = decodePartialLiquidationFee(receipt());
    expect(result.fillId).toBe(9007199254740993n);
    expect(result.cashDelta).toBe(-3n);
    expect(result.waived).toBe(2n);
    expect(result.assessed).toBe(result.collected + result.waived);
  });
  it("accepts a zero collection but not invented debt", () => {
    expect(
      decodePartialLiquidationFee({
        ...receipt(),
        collected: "0",
        waived: "5",
        cash_delta: "0",
      }).cashDelta,
    ).toBe(0n);
  });
  it.each([
    ["owner", "invalid"],
    ["market", "2147483648"],
    ["pool_id", "256"],
    ["episode_generation", "0"],
    ["policy_revision", "0"],
    ["fill_id", "0"],
    ["fill_id", 9007199254740992],
    ["assessed", "6"],
    ["cash_delta", "3"],
    ["collected", "9223372036854775808"],
    ["waived", "-1"],
  ])("refuses malformed %s", (key, value) => {
    expect(() =>
      decodePartialLiquidationFee({ ...receipt(), [key]: value }),
    ).toThrow();
  });
  it("requires every engine-owned attribute", () => {
    for (const key of Object.keys(receipt())) {
      const missing: Record<string, unknown> = receipt();
      delete missing[key];
      expect(() => decodePartialLiquidationFee(missing)).toThrow();
    }
  });
});
