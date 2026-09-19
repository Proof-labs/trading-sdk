import type { SetOracleGuards } from "./types.js";

const U64_MAX = (1n << 64n) - 1n;

/** Mirror the engine's state-independent validate_set_oracle_guards rules.
 * Market existence and governance authorization remain engine checks. */
export function validateSetOracleGuards(action: SetOracleGuards): void {
  if (
    !Number.isInteger(action.market) ||
    action.market < 0 ||
    action.market > 0x7fff_ffff
  ) {
    throw new Error("market must be an integer in 0..=2147483647");
  }
  const age = action.markPriceMaxOracleAgeMs;
  const band = action.maxOracleDeviationBps;
  if (age == null && band == null) {
    throw new Error("SetOracleGuards requires at least one guard field");
  }
  if (age != null && (typeof age !== "bigint" || age <= 0n || age > U64_MAX)) {
    throw new Error(
      "markPriceMaxOracleAgeMs must be a non-zero unsigned 64-bit bigint",
    );
  }
  if (band != null && (!Number.isInteger(band) || band < 1 || band > 10_000)) {
    throw new Error("maxOracleDeviationBps must be an integer in 1..=10000");
  }
}
