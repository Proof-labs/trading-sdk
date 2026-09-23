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
  type ExchangeEvent,
  type InsuranceFundUpdatedEvent,
  type PositionAutoDeleveragedEvent,
  type HlpAbsorbedEvent,
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

describe("public barrel: bad-debt waterfall events", () => {
  it("re-exports the waterfall event types as ExchangeEvent members", () => {
    const insurance: InsuranceFundUpdatedEvent = {
      type: "InsuranceFundUpdated",
      poolId: "1",
      balance: "-2500000",
      delta: "-7500000",
    };
    const adl: PositionAutoDeleveragedEvent = {
      type: "PositionAutoDeleveraged",
      owner: "11".repeat(20),
      market: "1",
      side: "Buy",
      size: "3",
      closePrice: "65000000000",
      closePriceSpec: "65000000000",
      realizedPnl: "1200000",
    };
    const hlp: HlpAbsorbedEvent = {
      type: "HlpAbsorbed",
      poolId: "0",
      amount: "4000000",
      hlpBalanceAfter: "996000000",
    };
    const events: ExchangeEvent[] = [insurance, adl, hlp];

    const fields = events.map((event) => {
      switch (event.type) {
        case "InsuranceFundUpdated":
          return event.delta;
        case "PositionAutoDeleveraged":
          return event.closePriceSpec;
        case "HlpAbsorbed":
          return event.hlpBalanceAfter;
        default:
          return null;
      }
    });
    expect(fields).toEqual(["-7500000", "65000000000", "996000000"]);
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
