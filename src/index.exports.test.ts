// Guards that the public package barrel (`@proof/trading-sdk` → src/index.ts)
// actually surfaces the governance types and action-type values. The types are
// erased at runtime, so importing them here is a COMPILE-TIME assertion: if a
// governance type stops being re-exported from the barrel, `tsc` fails on this
// file. The runtime `expect`s pin the `ActionType` byte values, which are a
// value export.
//
// Regression guard for the W30-11 review finding: the governance TS surface was
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
} from "./index.js";

describe("public barrel: governance surface", () => {
  it("re-exports the governance action-type byte values", () => {
    expect(ActionType.ProposeAdminAction).toBe(0x1e);
    expect(ActionType.ApproveAdminAction).toBe(0x1f);
    expect(ActionType.RejectAdminAction).toBe(0x20);
    expect(ActionType.EmergencyAdminAction).toBe(0x21);
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
  });
});
