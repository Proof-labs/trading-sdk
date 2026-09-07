/**
 * `@proof/trading-sdk/testing` - engine-internal actions that exist only to
 * drive a dev stack (integration harnesses, local liquidation / funding
 * experiments). They are deliberately NOT exported from the main entry: a
 * trading integration never needs them, and the engine rejects them from any
 * signer that is not on the relayer allowlist.
 *
 * Call `registerTestActions()` once, then pass a `TestAction` to the ordinary
 * codec / client entry points (cast to `Action`).
 */
import { registerTestActionType } from "./codec-adapter.js";

/** Run one liquidation sweep now (action 0x11). Relayer-signed. */
export interface RunLiquidationSweep {
  /** 20-byte address of the relayer signer. */
  signer: Uint8Array;
}

/** Apply one funding tick to `market` now (action 0x12). Relayer-signed. */
export interface RunFundingTick {
  market: number;
  /** 20-byte address of the relayer signer. */
  signer: Uint8Array;
}

export const TestActionType = {
  RunLiquidationSweep: 0x11,
  RunFundingTick: 0x12,
} as const;

export type TestAction =
  | { type: "RunLiquidationSweep"; data: RunLiquidationSweep }
  | { type: "RunFundingTick"; data: RunFundingTick };

/** Make the test actions encodable and decodable. Idempotent. */
export function registerTestActions(): void {
  for (const [name, byte] of Object.entries(TestActionType)) {
    registerTestActionType(name, byte);
  }
}
