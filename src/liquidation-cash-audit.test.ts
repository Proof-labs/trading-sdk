import { describe, expect, it } from "vitest";
import { decodeLiquidationCashAudit } from "./liquidation-cash-audit.js";

const fixture = () => ({
  owner: "01".repeat(20),
  counterparty_owner: "02".repeat(20),
  market: "4294967295",
  pool_id: "255",
  plan_id: "18446744073709551615",
  policy_revision: "2",
  fill_id: "3",
  committed_height: "4",
  reservation_id: "5",
  funding_snapshot_id: "06".repeat(32),
  quantity: "7",
  reference_price: "8",
  owner_realized_pnl: "-9223372036854775808",
  counterparty_realized_pnl: "9223372036854775807",
  allocated_final_loss: "19",
  insurance_paid: "10",
  penalty_collected: "11",
  penalty_waived: "12",
  owner_cash_after: "18446744073709551615",
  counterparty_cash_after: "13",
  applied_state_digest: "0e".repeat(32),
});

describe("terminal liquidation cash audit decoding", () => {
  it("retains full widths and distinguishes an audit snapshot from another cash movement", () => {
    const attrs = fixture();
    const original = { ...attrs };
    const event = decodeLiquidationCashAudit(attrs);
    expect(event.planId).toBe((1n << 64n) - 1n);
    expect(event.ownerRealizedPnl).toBe(-(1n << 63n));
    expect(event.counterpartyRealizedPnl).toBe((1n << 63n) - 1n);
    expect(event.ownerCashAfter).toBe((1n << 64n) - 1n);
    expect(event.market).toBe(4294967295);
    expect(event.poolId).toBe(255);
    expect(event.allocatedFinalLoss - event.insurancePaid).toBe(9n);
    expect(attrs).toEqual(original);
    expect(decodeLiquidationCashAudit(attrs)).toEqual(event);
  });
  it.each(Object.keys(fixture()))(
    "requires an own string attribute for %s",
    (key) => {
      const attrs: Record<string, unknown> = fixture();
      delete attrs[key];
      expect(() => decodeLiquidationCashAudit(attrs)).toThrow(key);
      attrs[key] = 9007199254740993;
      expect(() => decodeLiquidationCashAudit(attrs)).toThrow(key);
      expect(() =>
        decodeLiquidationCashAudit(Object.create(fixture())),
      ).toThrow();
    },
  );
  it.each([
    ["market", "4294967296"],
    ["pool_id", "256"],
    ["plan_id", "18446744073709551616"],
    ["owner_cash_after", "-1"],
    ["owner_realized_pnl", "-9223372036854775809"],
    ["counterparty_realized_pnl", "9223372036854775808"],
    ["quantity", "01"],
    ["reference_price", "1e6"],
    ["fill_id", "+3"],
    ["penalty_collected", " 11"],
    ["penalty_waived", "12 "],
    ["owner_realized_pnl", "-0"],
    ["plan_id", "9".repeat(10000)],
    ["owner", "0x" + "01".repeat(20)],
    ["counterparty_owner", "GG".repeat(20)],
    ["funding_snapshot_id", "AB".repeat(32)],
    ["applied_state_digest", "00"],
  ])("refuses malformed or unrepresentable %s=%s", (key, value) => {
    expect(() =>
      decodeLiquidationCashAudit({ ...fixture(), [key]: value }),
    ).toThrow(key);
  });
  it("refuses self pairs and support exceeding the recorded allocated loss", () => {
    expect(() =>
      decodeLiquidationCashAudit({
        ...fixture(),
        counterparty_owner: fixture().owner,
      }),
    ).toThrow("self pair");
    expect(() =>
      decodeLiquidationCashAudit({ ...fixture(), insurance_paid: "20" }),
    ).toThrow("exceeds");
    for (const payload of [null, [], 0, "audit"])
      expect(() => decodeLiquidationCashAudit(payload)).toThrow("object");
  });
});
