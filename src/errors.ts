/**
 * Decoder for engine `ExecError` codes returned in `TxResult.code`.
 *
 * The Rust enum lives at `exchange-core/src/types.rs::ExecError`. Codes
 * are stable wire-format identifiers — adding a new variant goes at the
 * end with the next free integer. **Keep this map in sync with that
 * `code()` impl** (CI flags drift in the audit `api-drift` lane).
 *
 * Use `decodeExecError(code)` to translate a `TxResult.code` into a
 * structured `{ name, description }`. UI can render `name` directly
 * (machine-readable) or `description` (human-readable). Code `0` is
 * success and returns `null` from this decoder — call sites should
 * branch on `code === 0` first.
 */

export interface ExecErrorInfo {
  /** Variant name from the Rust enum, e.g. `"InvalidNonce"`. Stable. */
  name: string;
  /** One-line human-readable message — what the engine prints in
   *  `Display`. Suitable for toast notifications. */
  description: string;
}

const TABLE: Record<number, ExecErrorInfo> = {
  1: { name: "DecodeError", description: "transaction decode error" },
  2: { name: "OrderNotFound", description: "order not found" },
  3: { name: "NotOwner", description: "not the owner of the order" },
  4: { name: "UnauthorizedOracle", description: "unauthorized oracle signer" },
  5: { name: "Overflow", description: "arithmetic overflow" },
  6: { name: "InvalidPrice", description: "invalid price" },
  7: { name: "InvalidQuantity", description: "invalid quantity" },
  8: { name: "InvalidSide", description: "invalid side" },
  9: { name: "UnknownMarket", description: "unknown market" },
  10: { name: "StateCorruption", description: "engine state corruption" },
  11: { name: "InsufficientBalance", description: "insufficient balance" },
  12: { name: "InsufficientMargin", description: "post-trade equity below initial margin requirement" },
  13: { name: "UnauthorizedRelayer", description: "unauthorized relayer signer" },
  14: { name: "WithdrawalNotFound", description: "withdrawal not found" },
  15: { name: "WithdrawalAlreadyProcessed", description: "withdrawal already processed" },
  16: { name: "DuplicateDeposit", description: "duplicate deposit signature (replay protection)" },
  17: { name: "InvalidSignature", description: "invalid Ed25519 signature" },
  18: { name: "SignatureRequired", description: "signed transaction required" },
  19: { name: "AgentNotAuthorized", description: "signer is not the owner or an authorized agent" },
  20: { name: "AgentCannotWithdraw", description: "agent wallets cannot perform withdrawals" },
  21: {
    name: "InvalidNonce",
    description: "invalid nonce — local cache stale; SDK auto-resyncs on this code",
  },
  22: { name: "MarketAlreadyExists", description: "market already exists" },
  23: { name: "InvalidMarketConfig", description: "invalid market configuration" },
  24: { name: "ImpactMarketAlreadyExists", description: "impact market already exists" },
  25: { name: "ImpactMarketNotFound", description: "impact market not found" },
  26: {
    name: "MarketClosedForTrading",
    description: "order on a CP/binary book whose parent impact market is resolved or voided",
  },
  27: {
    name: "BinaryPriceOutOfRange",
    description: "prediction-binary order price outside the [0, 1_000_000] (= $1) range",
  },
  28: { name: "InvalidResolution", description: "ResolveEvent rejected — invalid outcome for current state" },
  29: {
    name: "PositionLimitExceeded",
    description: "fill would push the taker's net position past MarketConfig.max_position_size",
  },
  30: {
    name: "OracleTimestampNotMonotonic",
    description: "OracleUpdate publish_time_ms must be strictly greater than the last accepted update (audit B3)",
  },
  31: {
    name: "TooManyActiveImpactMarkets",
    description: "account would touch more impact markets than the scenario margin engine can enumerate (cap = 4)",
  },
  32: {
    name: "SettlementPriceMismatch",
    description: "net-delta margin grouping found legs of the same group with disagreeing settle prices (upstream data corruption)",
  },
  255: { name: "InternalError", description: "unexpected runtime failure" },
};

/**
 * Translate a `TxResult.code` to the corresponding `ExecError` variant
 * info. Returns `null` for code 0 (success) or codes that have no entry
 * in the table (treat as unknown).
 *
 * Example:
 *   const r = await client.placeOrder(...);
 *   if (r.code !== 0) {
 *     const err = decodeExecError(r.code);
 *     console.error(`${err?.name ?? "Unknown"} (code ${r.code}): ${err?.description ?? r.log}`);
 *   }
 */
export function decodeExecError(code: number): ExecErrorInfo | null {
  if (code === 0) return null;
  return TABLE[code] ?? null;
}

/**
 * Returns just the variant name for a code, or `"UnknownError"` if the
 * code isn't in the table. Useful when you want to log a stable error
 * tag without rendering the full description.
 */
export function execErrorName(code: number): string {
  if (code === 0) return "Ok";
  return TABLE[code]?.name ?? "UnknownError";
}
