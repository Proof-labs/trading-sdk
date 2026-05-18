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
  /** Rust variant name when the code is one-to-one, or a grouped wire-code name. Stable. */
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
  // Code 18 (SignatureRequired) was retired when the unsigned envelope was
  // removed pre-launch — every tx is signed, so the engine never emits it.
  // The slot stays vacant rather than being reshuffled, in case any
  // downstream tooling still references it.
  19: { name: "AgentNotAuthorized", description: "signer is not the owner or an authorized agent" },
  20: { name: "AgentCannotWithdraw", description: "agent wallets cannot perform withdrawals" },
  21: {
    name: "TimestampNonceRejected",
    description: "timestamp nonce failed replay-window validation — sign a fresh envelope",
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
  33: {
    name: "OracleNotApplicable",
    description: "OracleUpdate targets a market kind that doesn't take oracle prices (impact-family children mark off the book)",
  },
  34: {
    name: "PostOnlyWouldCross",
    description: "post-only order would have crossed the book — rejected to preserve maker semantics",
  },
  35: {
    name: "ReduceOnlyWouldIncrease",
    description: "reduce-only order would have increased the position rather than reducing it",
  },
  36: { name: "TestActionRejected", description: "test/admin action rejected (e.g. unauthorized signer for RunLiquidationSweep)" },
  37: {
    name: "StaleOracle",
    description:
      "oracle for this market is older than MarketConfig.mark_price_max_oracle_age_ms; order placement, margin, and liquidation refuse to use a stale oracle (BE-33)",
  },
  38: {
    name: "UserLeverageBelowMarketIm",
    description:
      "SetUserMarketLeverage rejected: user_im_bps below market.im_bps. The engine only allows users to deleverage (more margin), never the other direction (BE-16)",
  },
  39: {
    name: "TickSizeViolation",
    description: "PlaceOrder price is not a multiple of MarketConfig.tickSize (BE-48)",
  },
  40: {
    name: "LotSizeViolation",
    description: "PlaceOrder/MarketOrder quantity is not a multiple of MarketConfig.lotSize (BE-48)",
  },
  41: {
    name: "OracleStaleNotElapsed",
    description: "fallback oracle signer published before the primary's staleness window elapsed (BE-50)",
  },
  42: {
    name: "FeeBpsOutOfRange",
    description: "SetAccountFeeOverride rejected — taker_fee_bps or maker_fee_bps outside the [0, 10_000] basis-point range (BE-46)",
  },
  43: {
    name: "FeeOverrideStaleSeq",
    description: "SetAccountFeeOverride rejected — cmd.seq must be strictly greater than the highest accepted seq for this account (BE-46.2 replay guard)",
  },
  44: {
    name: "ClientOrderIdNotFound",
    description: "cancel-by-client-order-id rejected because no active resting order exists for that owner/clientOrderId pair",
  },
  45: {
    name: "DuplicateClientOrderId",
    description: "place order rejected because an active resting order already uses that owner/clientOrderId pair",
  },
  46: {
    name: "InvalidClientOrderId",
    description: "clientOrderId 0 is reserved for absent IDs in exchange events; submit a positive 64-bit value",
  },
  47: {
    name: "FillOrKillWouldNotFill",
    description: "FOK place order rejected because visible crossing liquidity could not fill the whole order immediately",
  },
  48: {
    name: "InvalidCancelReplaceTarget",
    description: "cancel-replace rejected because exactly one of cancelOrderId or cancelClientOrderId must be supplied",
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
