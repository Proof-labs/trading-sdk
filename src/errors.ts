/**
 * Decoder for engine `ExecError` codes returned in `TxResult.code`.
 *
 * The Rust enum lives at `exchange-core/src/types.rs::ExecError`. Codes
 * are stable wire-format identifiers — adding a new variant goes at the
 * end with the next free integer. **Keep this map in sync with that
 * `code()` impl** (CI flags drift in the audit `api-drift` lane).
 *
 * Use `decodeExecError(code, log)` to translate a `TxResult.code` into a
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

/**
 * Named engine `ExecError` codes — the machine-readable half of the {@link TABLE}
 * below, so callers can branch on `code === ExecErrorCode.InsufficientMargin`
 * instead of a bare `12`. Values are the stable wire codes; names mirror the
 * Rust `ExecError` variants. `errors.test.ts` asserts this enum and `TABLE`
 * stay in agreement.
 */
export enum ExecErrorCode {
  DecodeError = 1,
  OrderNotFound = 2,
  NotOwner = 3,
  UnauthorizedOracle = 4,
  Overflow = 5,
  InvalidPrice = 6,
  InvalidQuantity = 7,
  InvalidSide = 8,
  UnknownMarket = 9,
  StateCorruption = 10,
  InsufficientBalance = 11,
  InsufficientMargin = 12,
  UnauthorizedRelayer = 13,
  WithdrawalNotFound = 14,
  WithdrawalAlreadyProcessed = 15,
  DuplicateDeposit = 16,
  InvalidSignature = 17,
  SignatureRequired = 18,
  AgentNotAuthorized = 19,
  AgentCannotWithdraw = 20,
  TimestampNonceRejected = 21,
  MarketAlreadyExists = 22,
  InvalidMarketConfig = 23,
  ImpactMarketAlreadyExists = 24,
  ImpactMarketNotFound = 25,
  MarketClosedForTrading = 26,
  BinaryPriceOutOfRange = 27,
  InvalidResolution = 28,
  PositionLimitExceeded = 29,
  OracleTimestampNotMonotonic = 30,
  TooManyActiveImpactMarkets = 31,
  SettlementPriceMismatch = 32,
  OracleNotApplicable = 33,
  PostOnlyWouldCross = 34,
  ReduceOnlyWouldIncrease = 35,
  TestActionRejected = 36,
  StaleOracle = 37,
  UserLeverageBelowMarketIm = 38,
  TickSizeViolation = 39,
  LotSizeViolation = 40,
  OracleStaleNotElapsed = 41,
  FeeBpsOutOfRange = 42,
  FeeOverrideStaleSeq = 43,
  ClientOrderIdNotFound = 44,
  DuplicateClientOrderId = 45,
  InvalidClientOrderId = 46,
  FillOrKillWouldNotFill = 47,
  InvalidCancelReplaceTarget = 48,
  AmendBelowFilled = 49,
  /**
   * The engine currently also emits code 50 for AtomicBasketOrder
   * `SlippageExceeded`. A numeric result cannot distinguish the variants.
   * Pass the canonical DeliverTx log to {@link decodeExecError}; without a
   * recognized log the decoder returns `AmbiguousCode50`, never a guessed
   * OI-cap classification.
   */
  OpenInterestLimitExceeded = 50,
  InternalError = 255,
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
  12: {
    name: "InsufficientMargin",
    description: "post-trade equity below initial margin requirement",
  },
  13: {
    name: "UnauthorizedRelayer",
    description: "unauthorized relayer signer",
  },
  14: { name: "WithdrawalNotFound", description: "withdrawal not found" },
  15: {
    name: "WithdrawalAlreadyProcessed",
    description: "withdrawal already processed",
  },
  16: {
    name: "DuplicateDeposit",
    description: "duplicate deposit signature (replay protection)",
  },
  17: { name: "InvalidSignature", description: "invalid Ed25519 signature" },
  18: {
    name: "SignatureRequired",
    description: "signed (V2) envelope required",
  },
  19: {
    name: "AgentNotAuthorized",
    description: "signer is not the owner or an authorized agent",
  },
  20: {
    name: "AgentCannotWithdraw",
    description: "agent wallets cannot perform withdrawals",
  },
  21: {
    name: "TimestampNonceRejected",
    description:
      "timestamp nonce failed replay-window validation — sign a fresh envelope",
  },
  22: { name: "MarketAlreadyExists", description: "market already exists" },
  23: {
    name: "InvalidMarketConfig",
    description: "invalid market configuration",
  },
  24: {
    name: "ImpactMarketAlreadyExists",
    description: "impact market already exists",
  },
  25: { name: "ImpactMarketNotFound", description: "impact market not found" },
  26: {
    name: "MarketClosedForTrading",
    description:
      "order on a CP/binary book whose parent impact market is resolved or voided",
  },
  27: {
    name: "BinaryPriceOutOfRange",
    description:
      "prediction-binary order price outside the [0, 1_000_000] (= $1) range",
  },
  28: {
    name: "InvalidResolution",
    description: "ResolveEvent rejected — invalid outcome for current state",
  },
  29: {
    name: "PositionLimitExceeded",
    description:
      "fill would push the taker's net position past MarketConfig.max_position_size",
  },
  30: {
    name: "OracleTimestampNotMonotonic",
    description:
      "OracleUpdate publish_time_ms must be strictly greater than the last accepted update (audit B3)",
  },
  31: {
    name: "TooManyActiveImpactMarkets",
    description:
      "account would touch more impact markets than the scenario margin engine can enumerate (cap = 4)",
  },
  32: {
    name: "SettlementPriceMismatch",
    description:
      "net-delta margin grouping found legs of the same group with disagreeing settle prices (upstream data corruption)",
  },
  33: {
    name: "OracleNotApplicable",
    description:
      "OracleUpdate targets a market kind that doesn't take oracle prices (impact-family children mark off the book)",
  },
  34: {
    name: "PostOnlyWouldCross",
    description:
      "post-only order would have crossed the book — rejected to preserve maker semantics",
  },
  35: {
    name: "ReduceOnlyWouldIncrease",
    description:
      "reduce-only order would have increased the position rather than reducing it",
  },
  36: {
    name: "TestActionRejected",
    description:
      "test/admin action rejected (unauthorized signer or engine not configured to accept them)",
  },
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
    description:
      "PlaceOrder price is not a multiple of MarketConfig.tickSize (BE-48)",
  },
  40: {
    name: "LotSizeViolation",
    description:
      "PlaceOrder/MarketOrder quantity is not a multiple of MarketConfig.lotSize (BE-48)",
  },
  41: {
    name: "OracleStaleNotElapsed",
    description:
      "fallback oracle signer published before the primary's staleness window elapsed (BE-50)",
  },
  42: {
    name: "FeeBpsOutOfRange",
    description: "fee bps value outside the [0, 10_000] basis-point range",
  },
  43: {
    name: "FeeOverrideStaleSeq",
    description:
      "fee override rejected — seq not strictly greater than last accepted",
  },
  44: {
    name: "ClientOrderIdNotFound",
    description:
      "cancel-by-client-order-id rejected because no active resting order exists for that owner/clientOrderId pair",
  },
  45: {
    name: "DuplicateClientOrderId",
    description:
      "place order rejected because an active resting order already uses that owner/clientOrderId pair",
  },
  46: {
    name: "InvalidClientOrderId",
    description:
      "clientOrderId 0 is reserved for absent IDs in exchange events; submit a positive 64-bit value",
  },
  47: {
    name: "FillOrKillWouldNotFill",
    description:
      "FOK place order rejected because visible crossing liquidity could not fill the whole order immediately",
  },
  48: {
    name: "InvalidCancelReplaceTarget",
    description:
      "cancel-replace rejected because exactly one of cancelOrderId or cancelClientOrderId must be supplied",
  },
  49: {
    name: "AmendBelowFilled",
    description:
      "amended total quantity is below the quantity already filled while the order rested",
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
 *     const err = decodeExecError(r.code, r.log);
 *     console.error(`${err?.name ?? "Unknown"} (code ${r.code}): ${err?.description ?? r.log}`);
 *   }
 */
const OPEN_INTEREST_LOG_PREFIX = "open interest limit exceeded on market ";
const SLIPPAGE_LOG_PREFIX = "atomic basket aggregate slippage ";

const OPEN_INTEREST_LIMIT_EXCEEDED: ExecErrorInfo = {
  name: "OpenInterestLimitExceeded",
  description:
    "fill would push aggregate market open interest past MarketConfig.maxOpenInterest",
};

const SLIPPAGE_EXCEEDED: ExecErrorInfo = {
  name: "SlippageExceeded",
  description:
    "atomic basket aggregate slippage exceeded the submitted maxSlippageBps budget",
};

const AMBIGUOUS_CODE_50: ExecErrorInfo = {
  name: "AmbiguousCode50",
  description:
    "engine code 50 is shared by OpenInterestLimitExceeded and SlippageExceeded; a canonical non-empty DeliverTx log is required to classify it safely",
};

export function decodeExecError(
  code: number,
  log?: string,
): ExecErrorInfo | null {
  if (code === 0) return null;
  if (code === 50) {
    if (log?.startsWith(OPEN_INTEREST_LOG_PREFIX)) {
      return OPEN_INTEREST_LIMIT_EXCEEDED;
    }
    if (log?.startsWith(SLIPPAGE_LOG_PREFIX)) {
      return SLIPPAGE_EXCEEDED;
    }
    return AMBIGUOUS_CODE_50;
  }
  return TABLE[code] ?? null;
}

/**
 * Returns just the variant name for a code, or `"UnknownError"` if the
 * code isn't in the table. Useful when you want to log a stable error
 * tag without rendering the full description.
 */
export function execErrorName(code: number, log?: string): string {
  if (code === 0) return "Ok";
  return decodeExecError(code, log)?.name ?? "UnknownError";
}
