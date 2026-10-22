/**
 * Typed decoders for the engine's liquidation events, from the string
 * attributes of one ABCI event: a transaction's `TxEvent`, or a payload the
 * indexer or the account feed carries verbatim.
 *
 * Every integer attribute is a decimal string; a u64 decodes to `bigint`,
 * since identifiers and amounts can exceed 2^53. An address is 40 lowercase
 * hex characters. Attributes these decoders do not name, such as the chain
 * coordinates (`block_height`, `event_key`, …), are ignored. A malformed
 * event throws; an event of another type decodes to `null`.
 */

import type { LiquidationConfig, TxEvent } from "./types.js";
import { validateLiquidationConfig } from "./liquidation-config.js";

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

/** How one owner named in a liquidation batch ended this block. */
export interface LiquidationProgressReportedEvent {
  type: "LiquidationProgressReported";
  owner: string;
  outcome: LiquidationProgress;
  configSequence: bigint;
}

export type LiquidationEvent =
  | LiquidationConfigSetEvent
  | PartialLiquidationFeeEvent
  | LiquidationProgressReportedEvent;

/** One ABCI event: a `TxEvent`'s attribute list, or the same attributes as
 *  a plain object. */
export interface LiquidationEventInput {
  type: string;
  attributes: TxEvent["attributes"] | Readonly<Record<string, unknown>>;
}

const U32_MAX = 0xffff_ffffn;
const U64_MAX = (1n << 64n) - 1n;

class Attributes {
  private readonly values = new Map<string, unknown>();

  constructor(
    private readonly event: string,
    attributes: LiquidationEventInput["attributes"],
  ) {
    const entries: [string, unknown][] = Array.isArray(attributes)
      ? (attributes as TxEvent["attributes"]).map(({ key, value }) => [
          key,
          value,
        ])
      : Object.entries(attributes);
    for (const [key, value] of entries) {
      if (this.values.has(key)) this.fail(key, "is duplicated");
      this.values.set(key, value);
    }
  }

  fail(key: string, problem: string): never {
    throw new Error(`${this.event} decode: ${key} ${problem}`);
  }

  text(key: string): string {
    const value = this.values.get(key);
    if (typeof value !== "string") this.fail(key, "is missing");
    return value;
  }

  unsigned(key: string, max: bigint): bigint {
    const text = this.text(key);
    if (!/^(0|[1-9][0-9]*)$/.test(text)) {
      this.fail(key, "is not a decimal unsigned integer");
    }
    const value = BigInt(text);
    if (value > max) this.fail(key, `exceeds ${max}`);
    return value;
  }

  u64(key: string): bigint {
    return this.unsigned(key, U64_MAX);
  }

  u32(key: string): number {
    return Number(this.unsigned(key, U32_MAX));
  }

  u8(key: string): number {
    return Number(this.unsigned(key, 0xffn));
  }

  owner(key: string): string {
    const text = this.text(key);
    if (!/^[0-9a-f]{40}$/.test(text)) {
      this.fail(key, "is not a 20-byte lowercase hex address");
    }
    return text;
  }

  /** `assessed`, `collected` and `waived`, checked to add up. */
  penalty(): { assessed: bigint; collected: bigint; waived: bigint } {
    const assessed = this.u64("assessed");
    const collected = this.u64("collected");
    const waived = this.u64("waived");
    if (collected + waived !== assessed) {
      this.fail("assessed", "is not collected + waived");
    }
    return { assessed, collected, waived };
  }
}

function liquidationConfigSet(a: Attributes): LiquidationConfigSetEvent {
  const config: LiquidationConfig = {
    targetRatioBps: a.u32("target_ratio_bps"),
    fullCloseThreshold: {
      numerator: a.u32("full_close_numerator"),
      denominator: a.u32("full_close_denominator"),
    },
    partialPenaltyBps: a.u32("partial_penalty_bps"),
    maxBookOrders: a.u32("max_book_orders"),
    maxCommittedFills: a.u32("max_committed_fills"),
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

function partialLiquidationFee(a: Attributes): PartialLiquidationFeeEvent {
  return {
    type: "PartialLiquidationFee",
    owner: a.owner("owner"),
    market: a.u32("market"),
    poolId: a.u8("pool_id"),
    fillId: a.u64("fill_id"),
    configSequence: a.u64("config_sequence"),
    ...a.penalty(),
  };
}

function liquidationProgressReported(
  a: Attributes,
): LiquidationProgressReportedEvent {
  const outcome = a.text("outcome");
  if (!(LIQUIDATION_PROGRESS_OUTCOMES as readonly string[]).includes(outcome)) {
    a.fail("outcome", `has unknown value "${outcome}"`);
  }
  return {
    type: "LiquidationProgressReported",
    owner: a.owner("owner"),
    outcome: outcome as LiquidationProgress,
    configSequence: a.u64("config_sequence"),
  };
}

const DECODERS: Record<string, (a: Attributes) => LiquidationEvent> = {
  liquidation_config_set: liquidationConfigSet,
  partial_liquidation_fee: partialLiquidationFee,
  liquidation_progress_reported: liquidationProgressReported,
};

/**
 * Decode one of the three liquidation events from its ABCI type (the
 * engine's snake_case name, e.g. `"partial_liquidation_fee"`) and string
 * attributes. Returns `null` for any other event type, so a caller can run
 * it over every event of a transaction or block.
 */
export function decodeLiquidationEvent(
  event: LiquidationEventInput,
): LiquidationEvent | null {
  const decode = Object.hasOwn(DECODERS, event.type)
    ? DECODERS[event.type]
    : undefined;
  return decode ? decode(new Attributes(event.type, event.attributes)) : null;
}
