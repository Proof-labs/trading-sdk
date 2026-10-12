// Guards that the public package barrel (`@proof-labs/trading-sdk` → src/index.ts)
// actually surfaces the governance types and action-type values. The types are
// erased at runtime, so importing them here is a COMPILE-TIME assertion: if a
// governance type stops being re-exported from the barrel, `tsc` fails on this
// file. The runtime `expect`s pin the `ActionType` byte values, which are a
// value export.
//
// Regression guard for a review finding: the governance TS surface was
// declared in types.ts but not reachable from the package entrypoint.

import { describe, it, expect } from "vitest";

import {
  ActionType,
  type GovernanceAction,
  type AdminAction,
  type EmergencyAction,
  type UpdateAdminSignerRegistry,
  type ProposeAdminAction,
  type ApproveAdminAction,
  type RejectAdminAction,
  type EmergencyAdminAction,
  type SetPositionTriggers,
  type CancelPositionTriggers,
  type TriggerStatus,
  type PositionTriggerHistoryEvent,
  type TriggerMarketHistoryEvent,
  type PositionTriggerHistoryPage,
  type TriggerMarketHistoryPage,
  type TriggerMarketConfigInfo,
  decodeTriggerMarketConfigInfos,
  decodePositionTriggerHistoryPage,
  decodeTriggerMarketHistoryPage,
} from "./index.js";

describe("public barrel: governance surface", () => {
  it("re-exports the governance action-type byte values", () => {
    expect(ActionType.ProposeAdminAction).toBe(0x1e);
    expect(ActionType.ApproveAdminAction).toBe(0x1f);
    expect(ActionType.RejectAdminAction).toBe(0x20);
    expect(ActionType.EmergencyAdminAction).toBe(0x21);
    expect(ActionType.SetPositionTriggers).toBe(0x25);
    expect(ActionType.CancelPositionTriggers).toBe(0x26);
  });

  it("re-exports the governance types (compile-time reachability)", () => {
    // Construct one value of each governance type via the barrel imports.
    // This does not run meaningfully at runtime (types are erased) — its
    // purpose is that `tsc` must resolve every imported type name from the
    // barrel, which fails the build if any stops being exported.
    const registry: UpdateAdminSignerRegistry = {
      newThreshold: 2,
      newMembers: [new Uint8Array(20)],
    };
    const admin: AdminAction = {
      kind: "UpdateAdminSignerRegistry",
      value: registry,
    };
    const emergency: EmergencyAction = {
      kind: "PauseMarket",
      value: { marketId: 1 },
    };
    const propose: ProposeAdminAction = {
      proposer: new Uint8Array(20),
      registryVersion: 1n,
      action: admin,
    };
    const approve: ApproveAdminAction = {
      approver: new Uint8Array(20),
      proposalId: 1n,
      registryVersion: 1n,
      threshold: 2,
      proposer: new Uint8Array(20),
      createdHeight: 1n,
      createdMs: 1n,
      expiryMs: 1n,
      action: admin,
      contentHash: new Uint8Array(32),
    };
    const reject: RejectAdminAction = {
      rejecter: new Uint8Array(20),
      proposalId: 1n,
      contentHash: new Uint8Array(32),
    };
    const emergencyAction: EmergencyAdminAction = {
      signer: new Uint8Array(20),
      action: emergency,
    };
    const governance: GovernanceAction[] = [
      { type: "ProposeAdminAction", data: propose },
      { type: "ApproveAdminAction", data: approve },
      { type: "RejectAdminAction", data: reject },
      { type: "EmergencyAdminAction", data: emergencyAction },
    ];
    expect(governance).toHaveLength(4);

    const set: SetPositionTriggers = {
      market: 1,
      owner: new Uint8Array(20),
      expectedPositionEpoch: 1n,
      stopLoss: { triggerPrice: 1n, maxSlippageBps: 1 },
    };
    const cancel: CancelPositionTriggers = {
      market: 1,
      owner: new Uint8Array(20),
      expectedPositionEpoch: 1n,
    };
    const status: TriggerStatus = {
      finalizedHeight: 1n,
      admissionHeight: 2n,
      actionsActive: false,
    };
    const ownerEvent = null as PositionTriggerHistoryEvent | null;
    const marketEvent = null as TriggerMarketHistoryEvent | null;
    const ownerPage = null as PositionTriggerHistoryPage | null;
    const marketPage = null as TriggerMarketHistoryPage | null;
    const configInfo = null as TriggerMarketConfigInfo | null;
    expect([
      set,
      cancel,
      status,
      ownerEvent,
      marketEvent,
      ownerPage,
      marketPage,
      configInfo,
    ]).toHaveLength(8);
    expect(decodePositionTriggerHistoryPage).toBeTypeOf("function");
    expect(decodeTriggerMarketHistoryPage).toBeTypeOf("function");
    expect(decodeTriggerMarketConfigInfos).toBeTypeOf("function");
  });
});

it("keeps response reads on ExchangeClient and excludes redundant or obsolete APIs", async () => {
  const sdk = await import("./index.js");
  expect("GatewayReads" in sdk).toBe(false);
  const client = new sdk.ExchangeClient();
  expect("syncNonce" in client).toBe(false);
  expect(client.reads().oracleHealth).toBeTypeOf("function");
  expect("queryOracleHealth" in client).toBe(false);
  expect(client.reads().meta).toBeTypeOf("function");
  expect(client.reads().events).toBeTypeOf("function");
  expect(client.reads().event).toBeTypeOf("function");
  expect("impactMarkets" in client.reads()).toBe(false);
  expect("impactMarket" in client.reads()).toBe(false);
});

import {
  BinaryPriceError as BarrelBinaryPriceError,
  yesOrder as barrelYesOrder,
  type CancelReason,
  type ExchangeEvent,
  type OrderMigratedEvent,
  type PositionMigratedEvent,
} from "./index.js";

describe("public barrel: one-book events and No helpers", () => {
  it("surfaces the upgrade's migration events in the event union", () => {
    const moved: OrderMigratedEvent = {
      type: "OrderMigrated",
      orderId: "8",
      owner: "aa",
      fromMarket: "70001",
      toMarket: "70000",
      side: "Sell",
      price: "550000",
    };
    const position: PositionMigratedEvent = {
      type: "PositionMigrated",
      owner: "aa",
      fromMarket: "70001",
      toMarket: "70000",
      side: "Sell",
      entryPrice: "600000",
      size: "40",
      cashDelta: "-12",
    };
    const events: ExchangeEvent[] = [moved, position];
    const reason: CancelReason = "upgrade";
    expect(events.map((e) => e.type)).toEqual([
      "OrderMigrated",
      "PositionMigrated",
    ]);
    expect(reason).toBe("upgrade");
  });

  it("re-exports the No helpers", () => {
    expect(() =>
      barrelYesOrder({ market: 1, side: 1, price: 0n, quantity: 1n }),
    ).toThrow(BarrelBinaryPriceError);
  });
});
