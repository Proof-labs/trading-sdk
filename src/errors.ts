/**
 * Decoder for engine `ExecError` codes returned in `TxResult.code`.
 *
 * The Rust enum lives at `exchange-wire/src/types.rs::ExecError`. Codes
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
  /** Timestamp nonce failed replay-window validation. Named `InvalidNonce` to
   *  match the engine `ExecError` variant and the Rust/Python bindings. */
  InvalidNonce = 21,
  MarketAlreadyExists = 22,
  InvalidMarketConfig = 23,
  // 24 and 25 belonged to the retired impact-market family; never reassigned.
  MarketClosedForTrading = 26,
  BinaryPriceOutOfRange = 27,
  InvalidResolution = 28,
  PositionLimitExceeded = 29,
  OracleTimestampNotMonotonic = 30,
  // 31 belonged to the retired impact-market family; never reassigned.
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
   * New engines use code 50 for AtomicBasketOrder `SlippageExceeded`. During
   * the rolling upgrade, legacy engines may still emit code 50 for
   * `OpenInterestLimitExceeded`, so pass the canonical DeliverTx log to
   * {@link decodeExecError}. Without a recognized log the decoder returns
   * `AmbiguousCode50`, never a guessed classification.
   */
  SlippageExceeded = 50,
  /** Distinct open-interest-cap rejection emitted by upgraded engines. */
  OpenInterestLimitExceeded = 51,
  /** Admin governance action submitted while no signer registry exists. */
  AdminGovernanceInactive = 52,
  /** Signer is not the declared admin actor / not in the signer registry. */
  NotAdminSigner = 53,
  // Proposal-lifecycle family (multisig governance), mirrored from the engine
  // ExecError codes 54-71. Decode-only: emitted by the propose/approve/reject
  // and emergency admin paths.
  ProposalNotFound = 54,
  ProposalNotPending = 55,
  ProposalExpired = 56,
  DuplicateApproval = 57,
  DuplicateRejection = 58,
  ProposalRegistryVersionMismatch = 59,
  ProposalContentMismatch = 60,
  InvalidAdminAction = 61,
  AdminActionTooLarge = 62,
  TooManyPendingProposals = 63,
  ProposalIdExhausted = 64,
  ConflictingVote = 65,
  MarketIdOutOfRange = 66,
  EmergencyRateLimited = 67,
  EmergencyGlobalRateLimited = 68,
  EmergencyActionRetired = 69,
  AdminActionRequiresProposal = 70,
  InvalidAdminRegistry = 71,
  BridgeReceiptRegistryInactive = 72,
  BridgeReceiptInvalid = 73,
  BridgeReceiptMismatch = 74,
  WithdrawalBelowMinimum = 75,
  WithdrawalTerminalGated = 76,
  // 77-81 are reserved on the wire for oracle-observation and oracle-policy errors.
  OracleGuardUnset = 82,
  SubAccountNotFound = 83,
  SubAccountAlreadyExists = 84,
  SubAccountTransferSameAccount = 85,
  SubAccountTransferBothChildren = 86,
  SubAccountTransferInsufficientBalance = 87,
  SubAccountIdZero = 88,
  SubAccountTransferZeroAmount = 89,
  SubAccountsInactive = 90,
  WithdrawalPayoutLeaseActive = 91,
  EventAlreadyExists = 92,
  EventNotFound = 93,
  UnderlyingAlreadyAttached = 94,
  TooManyAttachedConditionals = 95,
  TooManyActiveEvents = 96,
  /** F2 trigger expansion: the order cannot carry attached SL/TP limbs. */
  TriggerOrderIncompatible = 98,
  InternalError = 255,
}

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
    name: "InvalidNonce",
    description:
      "timestamp nonce failed replay-window validation — sign a fresh envelope",
  },
  22: { name: "MarketAlreadyExists", description: "market already exists" },
  23: {
    name: "InvalidMarketConfig",
    description: "invalid market configuration",
  },
  26: {
    name: "MarketClosedForTrading",
    description:
      "order on a conditional or binary book whose event is past settlement or resolved",
  },
  27: {
    name: "BinaryPriceOutOfRange",
    description:
      "prediction-binary order price outside the [0, 1_000_000] (= $1) range",
  },
  28: {
    name: "InvalidResolution",
    description:
      "resolve rejected — already resolved, before settlement, attachments still open, or outcome contradicts the oracle source",
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
  32: {
    name: "SettlementPriceMismatch",
    description:
      "net-delta margin grouping found legs of the same group with disagreeing settle prices (upstream data corruption)",
  },
  33: {
    name: "OracleNotApplicable",
    description:
      "OracleUpdate targets a market kind that doesn't take oracle prices (conditional and binary books mark off the book)",
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
  51: OPEN_INTEREST_LIMIT_EXCEEDED,
  52: {
    name: "AdminGovernanceInactive",
    description:
      "admin governance action submitted while no admin signer registry exists on this chain; multisig administration is inactive and every governance path fails closed",
  },
  53: {
    name: "NotAdminSigner",
    description:
      "tx signer does not match the action's declared proposer/approver/rejecter/signer field, or is not a member of the current admin signer registry",
  },
  54: {
    name: "ProposalNotFound",
    description:
      "no admin proposal exists under this id (never created, or pruned from terminal retention)",
  },
  55: {
    name: "ProposalNotPending",
    description:
      "the admin proposal is already terminal — votes are only accepted while pending",
  },
  56: {
    name: "ProposalExpired",
    description:
      "the admin proposal passed its TTL — re-propose and collect fresh approvals",
  },
  57: {
    name: "DuplicateApproval",
    description:
      "this signer already approved the proposal (the proposer approves at creation)",
  },
  58: {
    name: "DuplicateRejection",
    description: "this signer already rejected the proposal",
  },
  59: {
    name: "ProposalRegistryVersionMismatch",
    description:
      "registry version differs from the current signer registry — re-read and re-sign",
  },
  60: {
    name: "ProposalContentMismatch",
    description:
      "approval context does not byte-match the stored proposal — rebuild from the proposals query",
  },
  61: {
    name: "InvalidAdminAction",
    description:
      "inner admin/emergency action is invalid: unknown or not-admitted arm, non-zero inner signer, or out-of-bounds field",
  },
  62: {
    name: "AdminActionTooLarge",
    description: "canonical inner action bytes exceed MAX_ADMIN_ACTION_BYTES",
  },
  63: {
    name: "TooManyPendingProposals",
    description: "MAX_PENDING_PROPOSALS admin proposals are already pending",
  },
  64: {
    name: "ProposalIdExhausted",
    description: "a governance id counter is exhausted; ids never wrap",
  },
  65: {
    name: "ConflictingVote",
    description:
      "the opposite vote already exists — votes are immutable and disjoint",
  },
  66: {
    name: "MarketIdOutOfRange",
    description:
      "market id exceeds the signed-32-bit identity bound (i32::MAX)",
  },
  67: {
    name: "EmergencyRateLimited",
    description:
      "per-signer emergency action bound reached within the rolling window",
  },
  68: {
    name: "EmergencyGlobalRateLimited",
    description:
      "chain-wide emergency action bound reached within the rolling window",
  },
  69: {
    name: "EmergencyActionRetired",
    description: "this emergency arm was retired; new submissions fail closed",
  },
  70: {
    name: "AdminActionRequiresProposal",
    description:
      "the signer registry exists — this admin action is proposal-only, even for an authorized relayer",
  },
  71: {
    name: "InvalidAdminRegistry",
    description:
      "proposed signer roster violates the registry invariants (threshold bounds, sorted unique members, roster size, version headroom)",
  },
  72: {
    name: "BridgeReceiptRegistryInactive",
    description:
      "receipt-gated withdrawal action while no operator receipt registry exists; the path fails closed",
  },
  73: {
    name: "BridgeReceiptInvalid",
    description:
      "operator quorum proof failed verification (structure, member count or signature)",
  },
  74: {
    name: "BridgeReceiptMismatch",
    description:
      "signed receipt does not bind to this withdrawal or deployment; the log names the field",
  },
  75: {
    name: "WithdrawalBelowMinimum",
    description:
      "net withdrawal amount is below the effective minimum (dust-griefing gate)",
  },
  76: {
    name: "WithdrawalTerminalGated",
    description:
      "retired legacy relayer terminal submitted at or above the receipt cutover",
  },
  82: {
    name: "OracleGuardUnset",
    description:
      "mark-dependent read refused: the oracle-guard gate is active and the market's max oracle age is unset",
  },
  83: {
    name: "SubAccountNotFound",
    description: "no sub-account for this master and id",
  },
  84: {
    name: "SubAccountAlreadyExists",
    description: "a sub-account with this master and id already exists",
  },
  85: {
    name: "SubAccountTransferSameAccount",
    description: "sub-account transfer from and to are the same account",
  },
  86: {
    name: "SubAccountTransferBothChildren",
    description: "neither side of the sub-account transfer is the master",
  },
  87: {
    name: "SubAccountTransferInsufficientBalance",
    description: "source sub-account balance is below the transfer amount",
  },
  88: {
    name: "SubAccountIdZero",
    description: "sub-account id zero is not valid",
  },
  89: {
    name: "SubAccountTransferZeroAmount",
    description: "sub-account transfer amount must be greater than zero",
  },
  90: {
    name: "SubAccountsInactive",
    description:
      "sub-account actions decode but the chain has not enabled them yet",
  },
  91: {
    name: "WithdrawalPayoutLeaseActive",
    description:
      "a live payout lease on this withdrawal is held by a different watcher",
  },
  92: { name: "EventAlreadyExists", description: "event id already exists" },
  93: { name: "EventNotFound", description: "no event under this id" },
  94: {
    name: "UnderlyingAlreadyAttached",
    description: "this underlying is already attached to the event",
  },
  95: {
    name: "TooManyAttachedConditionals",
    description: "the event's attachment cap is reached",
  },
  96: {
    name: "TooManyActiveEvents",
    description:
      "account would touch more events than the scenario margin engine can enumerate (per-account cap)",
  },
  98: {
    name: "TriggerOrderIncompatible",
    description:
      "order cannot carry attached SL/TP (reduce-only order, ineligible market, or inactive feature)",
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

const AMBIGUOUS_CODE_50: ExecErrorInfo = {
  name: "AmbiguousCode50",
  description:
    "during the rolling upgrade, engine code 50 may mean legacy OpenInterestLimitExceeded or current SlippageExceeded; a canonical non-empty DeliverTx log is required to classify it safely",
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

/** Non-success gateway HTTP response; its unconsumed body remains available to callers. */
export class GatewayHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly response: Response,
  ) {
    super(`Gateway request failed (${status})`);
    this.name = "GatewayHttpError";
  }
}
