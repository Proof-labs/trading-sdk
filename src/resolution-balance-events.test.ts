import { describe, expect, it } from "vitest";
import { decodeResolutionBalanceSnapshotEvent } from "./resolution-balance-events.js";

const snapshot = {
  event_id: "4",
  owner: "ab".repeat(20),
  resolution_height: "1000",
  before_height: "999",
  after_height: "1001",
  balance_before: "5000000",
  balance_after: "6250000",
  settlement_balance_before: "5000000",
  settlement_balance_after: "18446744073709551615",
};

describe("decodeResolutionBalanceSnapshotEvent", () => {
  it("decodes every balance and height as an exact integer", () => {
    expect(
      decodeResolutionBalanceSnapshotEvent({
        type: "resolution_balance_snapshot",
        attributes: snapshot,
      }),
    ).toEqual({
      type: "ResolutionBalanceSnapshot",
      eventId: 4,
      owner: "ab".repeat(20),
      resolutionHeight: 1_000n,
      beforeHeight: 999n,
      afterHeight: 1_001n,
      balanceBefore: 5_000_000n,
      balanceAfter: 6_250_000n,
      settlementBalanceBefore: 5_000_000n,
      settlementBalanceAfter: 18_446_744_073_709_551_615n,
    });
  });

  it("returns null for another event type", () => {
    expect(
      decodeResolutionBalanceSnapshotEvent({
        type: "event_resolved",
        attributes: [],
      }),
    ).toBeNull();
  });

  it("throws on a missing or signed balance", () => {
    const { balance_after: _dropped, ...missing } = snapshot;
    expect(() =>
      decodeResolutionBalanceSnapshotEvent({
        type: "resolution_balance_snapshot",
        attributes: missing,
      }),
    ).toThrow(/resolution_balance_snapshot decode: balance_after is missing/);
    expect(() =>
      decodeResolutionBalanceSnapshotEvent({
        type: "resolution_balance_snapshot",
        attributes: { ...snapshot, balance_before: "-1" },
      }),
    ).toThrow(/resolution_balance_snapshot decode: balance_before/);
  });
});
