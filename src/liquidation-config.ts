import type { LiquidationConfig, SetLiquidationConfig } from "./types.js";

const U32_MAX = 0xffff_ffff;
const U64_MAX = (1n << 64n) - 1n;

/** Basis points that equal a ratio of one. */
export const RATIO_ONE_BPS = 10_000;

/** Largest partial-liquidation penalty a configuration may carry. */
export const MAX_PARTIAL_PENALTY_BPS = 100;

function u32(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
    throw new Error(`${field} must be an integer in 0..=${U32_MAX}`);
  }
}

function u64(value: bigint, field: string): void {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) {
    throw new Error(`${field} must be an unsigned 64-bit bigint`);
  }
}

/** Mirror proof-wire's `LiquidationConfig::validate`. */
export function validateLiquidationConfig(config: LiquidationConfig): void {
  const fields = [
    "targetRatioBps",
    "partialPenaltyBps",
    "maxBookOrders",
    "maxCommittedFills",
  ] as const;
  for (const field of fields) u32(config[field], field);
  const { numerator, denominator } = config.fullCloseThreshold;
  u32(numerator, "fullCloseThreshold.numerator");
  u32(denominator, "fullCloseThreshold.denominator");

  if (config.targetRatioBps <= RATIO_ONE_BPS) {
    throw new Error(`targetRatioBps must exceed ${RATIO_ONE_BPS}`);
  }
  if (numerator === 0 || numerator >= denominator) {
    throw new Error(
      "fullCloseThreshold must be strictly between 0 and 1 (0 < numerator < denominator)",
    );
  }
  if (config.partialPenaltyBps > MAX_PARTIAL_PENALTY_BPS) {
    throw new Error(
      `partialPenaltyBps must be at most ${MAX_PARTIAL_PENALTY_BPS}`,
    );
  }
  for (const field of fields.slice(2)) {
    if (config[field] === 0) throw new Error(`${field} must be non-zero`);
  }
}

/** Mirror proof-wire's `SetLiquidationConfig::validate`. Whether
 *  `predecessor` names the stored configuration stays an engine check. */
export function validateSetLiquidationConfig(
  action: SetLiquidationConfig,
): void {
  u64(action.predecessor, "predecessor");
  u64(action.sequence, "sequence");
  if (action.sequence <= action.predecessor) {
    throw new Error("sequence must exceed predecessor");
  }
  validateLiquidationConfig(action.config);
}
