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

import type {
  BindingScenarioEntry,
  LiquidationConfig,
  TxEvent,
} from "./types.js";
import { validateLiquidationConfig } from "./liquidation-config.js";

/** How one liquidation attempt on an owner ended in a block, as the
 *  engine writes it into the `outcome` attribute today. A later engine may
 *  add a value; the decoder passes it through. */
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
  (typeof LIQUIDATION_PROGRESS_OUTCOMES)[number] | (string & {});

/** Which path liquidated a position, as the `mode` attribute names it:
 *  `partial` is a step through the book toward the target ratio, `full` a
 *  close through the book below the full-close threshold, and `insolvent` a
 *  close at mark because equity is negative in some outcome. A later engine
 *  may add a mode; the decoder passes it through. */
export const LIQUIDATION_MODES = ["partial", "full", "insolvent"] as const;

export type LiquidationMode =
  (typeof LIQUIDATION_MODES)[number] | (string & {});

/** Why a liquidation attempt was refused rather than failing on an engine
 *  error: a position changed under the step reducing it, a resting order
 *  did not match its book, or a reference price was unavailable. A later
 *  engine may add a reason; the decoder passes it through. */
export const LIQUIDATION_REFUSALS = [
  "position_mismatch",
  "invalid_maker",
  "reference_unavailable",
  "net_delta_grows",
] as const;

export type LiquidationRefusal =
  (typeof LIQUIDATION_REFUSALS)[number] | (string & {});

/** The engine error code of a refused liquidation attempt
 *  (`ExecErrorCode.LiquidationRefused`). */
export const LIQUIDATION_REFUSED_CODE = 111;

/** Why auto-deleveraging left a profitable position out of a deficit's
 *  candidate set: `stale_oracle_dependency` means a market the
 *  counterparty's portfolio depends on (a position or a resting order) had
 *  no fresh oracle verdict, so its solvency was indeterminate. A later engine
 *  may add a reason; the decoder passes it through. */
export const ADL_SKIP_REASONS = ["stale_oracle_dependency"] as const;

export type AdlSkipReason = (typeof ADL_SKIP_REASONS)[number] | (string & {});

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
  /** Engine code that refused a full close's remainder after book fills
   *  that stand; `null` otherwise. */
  remainderCode: number | null;
  /** Why that remainder was refused, when refused rather than erroring. */
  remainderRefusal: LiquidationRefusal | null;
}

/**
 * One position an owner's liquidation attempt reduced, once per position
 * per attempt. `sizeBefore` is the position's size before the attempt's
 * first step, `sizeClosed` the total its steps closed, and `sizeAfter` what
 * is left. The penalty is the sum of the per-fill penalties charged on this
 * position: `penaltyCollected` went to the insurance fund and
 * `penaltyWaived` is never owed later; a close at mark charges none.
 * `equity` (signed), `maintenance` and `bindingOutcome` are the owner's
 * binding outcome, with pending funding, when the attempt was decided.
 * `bindingOutcome` has one entry per event of the account's domain, and is
 * empty when the account holds no event exposure.
 */
export interface PositionLiquidatedEvent {
  type: "PositionLiquidated";
  owner: string;
  market: number;
  side: "buy" | "sell";
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
  /** What the insurance fund paid to take the position over; the fund
   *  fields are 0 unless it did. */
  fundCharged: bigint;
  fundBinaries: bigint;
  fundReserve: bigint;
  /** Signed. */
  fundRealized: bigint;
  /** Part of `fundCharged` the fund took in kind with the position. */
  fundAbsorbed: bigint;
}

/**
 * An owner's liquidation attempt failed and kept none of its writes.
 * `code` is the engine error code. `refusal` names why when the attempt was
 * refused (the engine writes `LIQUIDATION_REFUSED_CODE` then), and is
 * `null` when it failed on another engine error.
 */
export interface LiquidationFailedEvent {
  type: "LiquidationFailed";
  owner: string;
  code: number;
  refusal: LiquidationRefusal | null;
}

/** Auto-deleveraging left `owner`'s profitable position of `size` on
 *  `market` out of the candidate set for `poolId`'s deficit. */
export interface AdlCounterpartySkippedEvent {
  type: "AdlCounterpartySkipped";
  owner: string;
  market: number;
  poolId: number;
  size: bigint;
  reason: AdlSkipReason;
}

export type LiquidationEvent =
  | LiquidationConfigSetEvent
  | PartialLiquidationFeeEvent
  | LiquidationProgressReportedEvent
  | PositionLiquidatedEvent
  | LiquidationFailedEvent
  | AdlCounterpartySkippedEvent;

/** One ABCI event: a `TxEvent`'s attribute list, or the same attributes as
 *  a plain object. */
export interface LiquidationEventInput {
  type: string;
  attributes: TxEvent["attributes"] | Readonly<Record<string, unknown>>;
}

const U32_MAX = 0xffff_ffffn;
const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const UNSIGNED = /^(0|[1-9][0-9]*)$/;

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

  has(key: string): boolean {
    return this.values.has(key);
  }

  text(key: string): string {
    const value = this.values.get(key);
    if (typeof value !== "string") this.fail(key, "is missing");
    return value;
  }

  unsigned(key: string, max: bigint): bigint {
    const text = this.text(key);
    if (!UNSIGNED.test(text)) {
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

  i64(key: string): bigint {
    const text = this.text(key);
    if (!/^(0|-?[1-9][0-9]*)$/.test(text)) {
      this.fail(key, "is not a decimal signed integer");
    }
    const value = BigInt(text);
    if (value < I64_MIN || value > I64_MAX) {
      this.fail(key, "is outside the signed 64-bit range");
    }
    return value;
  }

  oneOf<const T extends readonly string[]>(key: string, values: T): T[number] {
    const text = this.text(key);
    if (!values.includes(text)) this.fail(key, `has unknown value "${text}"`);
    return text;
  }

  /** A non-empty value passed through as written, so a value a later engine
   *  adds still decodes. */
  label(key: string): string {
    const text = this.text(key);
    if (text === "") this.fail(key, "is empty");
    return text;
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
    ...(a.has("takeover_discount_bps") && {
      takeoverDiscountBps: a.u32("takeover_discount_bps"),
    }),
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
  return {
    type: "LiquidationProgressReported",
    owner: a.owner("owner"),
    outcome: a.label("outcome"),
    configSequence: a.u64("config_sequence"),
    remainderCode: a.has("remainder_code") ? a.u32("remainder_code") : null,
    remainderRefusal: a.has("remainder_refusal")
      ? a.text("remainder_refusal")
      : null,
  };
}

/** `event_id:branch` pairs joined by commas, one per event, branch `yes` or
 *  `no`; the empty string for no event exposure. */
function bindingOutcome(a: Attributes): BindingScenarioEntry[] {
  const text = a.text("binding_outcome");
  if (text === "") return [];
  const seen = new Set<bigint>();
  return text.split(",").map((pair) => {
    const match = /^(0|[1-9][0-9]*):(yes|no)$/.exec(pair);
    if (!match) a.fail("binding_outcome", `has malformed entry "${pair}"`);
    const eventId = BigInt(match[1]);
    if (eventId > U32_MAX)
      a.fail("binding_outcome", `event id exceeds ${U32_MAX}`);
    if (seen.has(eventId)) {
      a.fail("binding_outcome", `event id ${eventId} is repeated`);
    }
    seen.add(eventId);
    return {
      eventId: Number(eventId),
      branch: match[2] === "yes" ? "Yes" : "No",
    };
  });
}

function positionLiquidated(a: Attributes): PositionLiquidatedEvent {
  return {
    type: "PositionLiquidated",
    owner: a.owner("owner"),
    market: a.u32("market"),
    side: a.oneOf("side", ["buy", "sell"] as const),
    mode: a.label("mode"),
    sizeBefore: a.u64("size_before"),
    sizeClosed: a.u64("size_closed"),
    sizeAfter: a.u64("size_after"),
    penaltyCollected: a.u64("penalty_collected"),
    penaltyWaived: a.u64("penalty_waived"),
    equity: a.i64("equity"),
    maintenance: a.u64("maintenance"),
    bindingOutcome: bindingOutcome(a),
    configSequence: a.u64("config_sequence"),
    // Engines before proof-wire 8 omit the fund fields.
    fundCharged: a.has("fund_charged") ? a.u64("fund_charged") : 0n,
    fundBinaries: a.has("fund_binaries") ? a.u64("fund_binaries") : 0n,
    fundReserve: a.has("fund_reserve") ? a.u64("fund_reserve") : 0n,
    fundRealized: a.has("fund_realized") ? a.i64("fund_realized") : 0n,
    fundAbsorbed: a.has("fund_absorbed") ? a.u64("fund_absorbed") : 0n,
  };
}

function liquidationFailed(a: Attributes): LiquidationFailedEvent {
  const refusal = a.text("refusal");
  return {
    type: "LiquidationFailed",
    owner: a.owner("owner"),
    code: a.u32("code"),
    refusal: refusal === "" ? null : refusal,
  };
}

function adlCounterpartySkipped(a: Attributes): AdlCounterpartySkippedEvent {
  return {
    type: "AdlCounterpartySkipped",
    owner: a.owner("owner"),
    market: a.u32("market"),
    poolId: a.u8("pool_id"),
    size: a.u64("size"),
    reason: a.label("reason"),
  };
}

const DECODERS: Record<string, (a: Attributes) => LiquidationEvent> = {
  liquidation_config_set: liquidationConfigSet,
  partial_liquidation_fee: partialLiquidationFee,
  liquidation_progress_reported: liquidationProgressReported,
  position_liquidated: positionLiquidated,
  liquidation_failed: liquidationFailed,
  adl_counterparty_skipped: adlCounterpartySkipped,
};

/**
 * Decode one of the six liquidation events from its ABCI type (the
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
