/**
 * Typed decoders for the engine's Void events, from the string attributes of
 * one ABCI event, with the conventions of `decodeLiquidationEvent`.
 */

import {
  Attributes,
  type LiquidationEventInput,
} from "./liquidation-events.js";

/** The admin quorum voided an event at `yesPrice`. */
export interface EventVoidedEvent {
  type: "EventVoided";
  eventId: number;
  /** Micro-USDC per share, `0..=1_000_000`. */
  yesPrice: bigint;
  timestampMs: bigint;
  proposalId: bigint;
}

/** A conditional position settled in cash on Void: its payoff at
 *  `settlementPrice`, weighted by `branchWeight` per `1_000_000`. */
export interface ConditionalVoidSettledEvent {
  type: "ConditionalVoidSettled";
  eventId: number;
  market: number;
  owner: string;
  side: "buy" | "sell";
  size: bigint;
  entryPrice: bigint;
  settlementPrice: bigint;
  branchWeight: bigint;
  /** Signed. */
  realizedPnl: bigint;
}

export type VoidSettlementEvent =
  EventVoidedEvent | ConditionalVoidSettledEvent;

function eventVoided(a: Attributes): EventVoidedEvent {
  return {
    type: "EventVoided",
    eventId: a.u32("event_id"),
    yesPrice: a.u64("yes_price"),
    timestampMs: a.u64("timestamp_ms"),
    proposalId: a.u64("proposal_id"),
  };
}

function conditionalVoidSettled(a: Attributes): ConditionalVoidSettledEvent {
  return {
    type: "ConditionalVoidSettled",
    eventId: a.u32("event_id"),
    market: a.u32("market"),
    owner: a.owner("owner"),
    side: a.oneOf("side", ["buy", "sell"] as const),
    size: a.u64("size"),
    entryPrice: a.u64("entry_price"),
    settlementPrice: a.u64("settlement_price"),
    branchWeight: a.u64("branch_weight"),
    realizedPnl: a.i64("realized_pnl"),
  };
}

const DECODERS: Record<string, (a: Attributes) => VoidSettlementEvent> = {
  event_voided: eventVoided,
  conditional_void_settled: conditionalVoidSettled,
};

/** Decode `event_voided` or `conditional_void_settled`; `null` for any
 *  other event type. */
export function decodeVoidSettlementEvent(
  event: LiquidationEventInput,
): VoidSettlementEvent | null {
  const decode = Object.hasOwn(DECODERS, event.type)
    ? DECODERS[event.type]
    : undefined;
  return decode ? decode(new Attributes(event.type, event.attributes)) : null;
}
