/**
 * Typed decoder for the engine's `resolution_balance_snapshot` event, from
 * the string attributes of one ABCI event, with the conventions of
 * `decodeLiquidationEvent`.
 */

import { Attributes, type AbciEventInput } from "./abci-event.js";

/**
 * One account's cash at the ends of the blocks immediately before and after
 * an event's resolution. Every balance is whole micro-USDC and excludes
 * unrealized value. The settlement balances isolate this resolution from
 * other cash changes in either block. The engine emits it in `afterHeight`,
 * not in the resolution block.
 */
export interface ResolutionBalanceSnapshotEvent {
  type: "ResolutionBalanceSnapshot";
  eventId: number;
  owner: string;
  resolutionHeight: bigint;
  beforeHeight: bigint;
  afterHeight: bigint;
  balanceBefore: bigint;
  balanceAfter: bigint;
  settlementBalanceBefore: bigint;
  settlementBalanceAfter: bigint;
}

/** Decode `resolution_balance_snapshot`; `null` for any other event type. */
export function decodeResolutionBalanceSnapshotEvent(
  event: AbciEventInput,
): ResolutionBalanceSnapshotEvent | null {
  if (event.type !== "resolution_balance_snapshot") return null;
  const a = new Attributes(event.type, event.attributes);
  return {
    type: "ResolutionBalanceSnapshot",
    eventId: a.u32("event_id"),
    owner: a.owner("owner"),
    resolutionHeight: a.u64("resolution_height"),
    beforeHeight: a.u64("before_height"),
    afterHeight: a.u64("after_height"),
    balanceBefore: a.u64("balance_before"),
    balanceAfter: a.u64("balance_after"),
    settlementBalanceBefore: a.u64("settlement_balance_before"),
    settlementBalanceAfter: a.u64("settlement_balance_after"),
  };
}
