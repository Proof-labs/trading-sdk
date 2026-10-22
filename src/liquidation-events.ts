/**
 * Typed decoders for the engine's liquidation events, from the string
 * attributes of one ABCI event: a transaction's `TxEvent`, or a payload the
 * indexer or the account feed carries verbatim.
 *
 * Every integer attribute is a decimal string; a u64 or i64 decodes to
 * `bigint`, since identifiers and amounts can exceed 2^53. An address is 40
 * lowercase hex characters. Attributes these decoders do not name, such as the chain
 * coordinates (`block_height`, `event_key`, …), are ignored. A malformed
 * event throws; an event of another type decodes to `null`.
 */

import type { BindingScenarioEntry, LiquidationConfig } from "./types.js";
import { validateLiquidationConfig } from "./liquidation-config.js";
import {
  type AbciEventInput,
  type Attributes,
  type EventSide,
  SIDES,
  decodeWith,
} from "./event-attributes.js";

/** How one liquidation attempt on an owner ended in a block, as the
 *  engine writes it into the `outcome` attribute. */
export const LIQUIDATION_PROGRESS_OUTCOMES = [
  "not_eligible",
  "indeterminate",
  "restored_by_cancellation",
  "no_fill",
  "safe_progress",
  "maintenance_restored_below_target",
  "target_reached",
  "full_close_restored_by_cancellation",
  "full_close_no_fill",
  "full_close_partly_closed",
  "full_close_closed",
  "insolvent",
  "deferred",
  "failed",
] as const;

export type LiquidationProgress =
  (typeof LIQUIDATION_PROGRESS_OUTCOMES)[number];

/** How a liquidation step closed a position. */
export const LIQUIDATION_MODES = ["partial", "full", "insolvent"] as const;

export type LiquidationMode = (typeof LIQUIDATION_MODES)[number];

/** Why the engine refused to liquidate an owner it was asked to. */
export const LIQUIDATION_REFUSALS = [
  "position_mismatch",
  "invalid_maker",
  "reference_unavailable",
] as const;

export type LiquidationRefusal = (typeof LIQUIDATION_REFUSALS)[number];

/** The admin quorum replaced the global liquidation configuration. */
export interface LiquidationConfigSetEvent {
  type: "LiquidationConfigSet";
  sequence: bigint;
  config: LiquidationConfig;
  proposalId: bigint;
}

/**
 * The partial-liquidation penalty on one book fill that reduced `owner`'s
 * position. `collected` was paid to `poolId`'s insurance fund; `waived` is
 * never owed later; `assessed = collected + waived`.
 */
export interface PartialLiquidationFeeEvent {
  type: "PartialLiquidationFee";
  owner: string;
  market: number;
  poolId: number;
  fillId: bigint;
  configSequence: bigint;
  assessed: bigint;
  collected: bigint;
  waived: bigint;
}

/**
 * The full-liquidation penalty, charged once when a full close of `owner`
 * ends. `closedNotional` is everything the close filled through the book,
 * across blocks and pools; `assessed = collected + waived`.
 */
export interface FullLiquidationFeeEvent {
  type: "FullLiquidationFee";
  owner: string;
  configSequence: bigint;
  closedNotional: bigint;
  assessed: bigint;
  collected: bigint;
  waived: bigint;
}

/** How one owner named in a liquidation batch ended this block. */
export interface LiquidationProgressReportedEvent {
  type: "LiquidationProgressReported";
  owner: string;
  outcome: LiquidationProgress;
  configSequence: bigint;
}

/**
 * One position a liquidation step reduced. `equity`, `maintenance` and
 * `bindingOutcome` are the account's margin state when the engine decided;
 * an empty `bindingOutcome` means no event scenario bound it.
 */
export interface PositionLiquidatedEvent {
  type: "PositionLiquidated";
  owner: string;
  market: number;
  side: EventSide;
  mode: LiquidationMode;
  sizeBefore: bigint;
  sizeClosed: bigint;
  sizeAfter: bigint;
  penaltyCollected: bigint;
  penaltyWaived: bigint;
  equity: bigint;
  maintenance: bigint;
  bindingOutcome: BindingScenarioEntry[];
  configSequence: bigint;
}

/** A liquidation of `owner` failed with engine error `code`. `refusal`
 *  names the reason when the engine refused rather than faulted. */
export interface LiquidationFailedEvent {
  type: "LiquidationFailed";
  owner: string;
  code: number;
  refusal: LiquidationRefusal | null;
}

export type LiquidationEvent =
  | LiquidationConfigSetEvent
  | PartialLiquidationFeeEvent
  | FullLiquidationFeeEvent
  | LiquidationProgressReportedEvent
  | PositionLiquidatedEvent
  | LiquidationFailedEvent;

/** One ABCI event: a `TxEvent`'s attribute list, or the same attributes as
 *  a plain object. */
export type LiquidationEventInput = AbciEventInput;

function liquidationConfigSet(a: Attributes): LiquidationConfigSetEvent {
  const config: LiquidationConfig = {
    targetRatioBps: a.u32("target_ratio_bps"),
    fullCloseThreshold: {
      numerator: a.u32("full_close_numerator"),
      denominator: a.u32("full_close_denominator"),
    },
    partialPenaltyBps: a.u32("partial_penalty_bps"),
    maxBookOrders: a.u32("max_book_orders"),
    maxCandidatePrefixes: a.u32("max_candidate_prefixes"),
    maxCommittedFills: a.u32("max_committed_fills"),
    maxStateReads: a.u32("max_state_reads"),
    maxStateReadBytes: a.u32("max_state_read_bytes"),
  };
  try {
    validateLiquidationConfig(config);
  } catch (e) {
    a.fail("config", `is invalid: ${(e as Error).message}`);
  }
  return {
    type: "LiquidationConfigSet",
    sequence: a.u64("sequence"),
    config,
    proposalId: a.u64("proposal_id"),
  };
}

/** `assessed`, `collected` and `waived`, checked to add up. */
function penalty(a: Attributes): {
  assessed: bigint;
  collected: bigint;
  waived: bigint;
} {
  const assessed = a.u64("assessed");
  const collected = a.u64("collected");
  const waived = a.u64("waived");
  if (collected + waived !== assessed) {
    a.fail("assessed", "is not collected + waived");
  }
  return { assessed, collected, waived };
}

function partialLiquidationFee(a: Attributes): PartialLiquidationFeeEvent {
  return {
    type: "PartialLiquidationFee",
    owner: a.owner("owner"),
    market: a.u32("market"),
    poolId: a.u8("pool_id"),
    fillId: a.u64("fill_id"),
    configSequence: a.u64("config_sequence"),
    ...penalty(a),
  };
}

function fullLiquidationFee(a: Attributes): FullLiquidationFeeEvent {
  return {
    type: "FullLiquidationFee",
    owner: a.owner("owner"),
    configSequence: a.u64("config_sequence"),
    closedNotional: a.u64("closed_notional"),
    ...penalty(a),
  };
}

function liquidationProgressReported(
  a: Attributes,
): LiquidationProgressReportedEvent {
  return {
    type: "LiquidationProgressReported",
    owner: a.owner("owner"),
    outcome: a.oneOf("outcome", LIQUIDATION_PROGRESS_OUTCOMES),
    configSequence: a.u64("config_sequence"),
  };
}

/** `event_id:branch` pairs joined by commas; empty for none. */
function bindingOutcome(a: Attributes): BindingScenarioEntry[] {
  const text = a.text("binding_outcome");
  if (text === "") return [];
  return text.split(",").map((pair) => {
    const match = /^(0|[1-9][0-9]*):(yes|no)$/.exec(pair);
    if (!match) a.fail("binding_outcome", `has malformed scenario "${pair}"`);
    const eventId = Number(match[1]);
    if (!Number.isSafeInteger(eventId)) {
      a.fail("binding_outcome", "event id exceeds 2^53");
    }
    return { eventId, branch: match[2] === "yes" ? "Yes" : "No" };
  });
}

function positionLiquidated(a: Attributes): PositionLiquidatedEvent {
  return {
    type: "PositionLiquidated",
    owner: a.owner("owner"),
    market: a.u32("market"),
    side: a.oneOf("side", SIDES),
    mode: a.oneOf("mode", LIQUIDATION_MODES),
    sizeBefore: a.u64("size_before"),
    sizeClosed: a.u64("size_closed"),
    sizeAfter: a.u64("size_after"),
    penaltyCollected: a.u64("penalty_collected"),
    penaltyWaived: a.u64("penalty_waived"),
    equity: a.i64("equity"),
    maintenance: a.u64("maintenance"),
    bindingOutcome: bindingOutcome(a),
    configSequence: a.u64("config_sequence"),
  };
}

function liquidationFailed(a: Attributes): LiquidationFailedEvent {
  return {
    type: "LiquidationFailed",
    owner: a.owner("owner"),
    code: a.u32("code"),
    refusal: a.optionalOneOf("refusal", LIQUIDATION_REFUSALS),
  };
}

const DECODERS: Record<string, (a: Attributes) => LiquidationEvent> = {
  liquidation_config_set: liquidationConfigSet,
  partial_liquidation_fee: partialLiquidationFee,
  full_liquidation_fee: fullLiquidationFee,
  liquidation_progress_reported: liquidationProgressReported,
  position_liquidated: positionLiquidated,
  liquidation_failed: liquidationFailed,
};

/**
 * Decode one of the liquidation events from its ABCI type (the
 * engine's snake_case name, e.g. `"partial_liquidation_fee"`) and string
 * attributes. Returns `null` for any other event type, so a caller can run
 * it over every event of a transaction or block.
 */
export function decodeLiquidationEvent(
  event: LiquidationEventInput,
): LiquidationEvent | null {
  return decodeWith(DECODERS, event);
}
