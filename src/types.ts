import type { ExecErrorInfo } from "./errors.js";

/** 20-byte account address (derived from Ed25519 public key). */
export type Address = Uint8Array;

/** Order side. */
export enum Side {
  /** Buy / long. */
  Buy = 1,
  /** Sell / short. */
  Sell = 2,
}

/**
 * Time-in-force policy for a limit order. Controls how unmatched
 * quantity is handled after crossing the book.
 *
 * Wire encoding: msgpack enum variant (`Gtc`, `Ioc`, `Fok`).
 */
export enum TimeInForce {
  /** Good-Till-Cancelled: unmatched quantity rests on the book. The default. */
  Gtc = 0,
  /** Immediate-Or-Cancel: unmatched quantity is dropped after crossing. */
  Ioc = 1,
  /** Fill-Or-Kill: fully fill immediately or reject without mutation. */
  Fok = 2,
}

// ---------------------------------------------------------------------------
// Action type constants (wire bytes 0x01–0x0D)
// ---------------------------------------------------------------------------

/** Wire-format action type identifiers. Each value is a single byte. */
export const ActionType = {
  /** Place a limit order on the order book. */
  PlaceOrder: 0x01,
  /** Cancel an existing resting order. */
  CancelOrder: 0x02,
  /** Submit an oracle price update (relayer only). */
  OracleUpdate: 0x03,
  /** Operator-only: submit a composite-CEX price for the multi-source mark
   *  median (BE-31 Phase B). Feeder infrastructure, not a trading action. */
  OracleUpdateComposite: 0x14,
  /** Place a market order that crosses immediately. */
  MarketOrder: 0x04,
  /** Credit USDC to an account (legacy, prefer ConfirmDeposit). */
  Deposit: 0x05,
  /** Debit USDC from an account (direct withdraw, checks margin). */
  Withdraw: 0x06,
  /** Register a new perpetual market with risk parameters (admin). */
  CreateMarket: 0x07,
  /** User requests a USDC withdrawal to a Solana address. */
  WithdrawRequest: 0x08,
  /** Relayer confirms an on-chain USDC deposit from Solana. */
  ConfirmDeposit: 0x09,
  /** Relayer confirms a USDC withdrawal was sent on Solana. */
  ConfirmWithdrawal: 0x0a,
  /** Relayer marks a withdrawal as permanently failed; refunds balance. */
  FailWithdrawal: 0x0b,
  /** Approve a delegate agent wallet to trade on the owner's behalf. */
  ApproveAgent: 0x0c,
  /** Revoke a previously approved agent wallet. */
  RevokeAgent: 0x0d,
  /** Create a 5-book impact-market family (admin). */
  CreateImpactMarket: 0x0e,
  /** Resolve an impact-market event with an outcome (admin). */
  ResolveEvent: 0x0f,
  /** Update a subset of `MarketConfig` tunables on a live market (admin).
   *  Fee tiering, funding-rate cap tightening, position-limit updates
   *  without a chain rebase. */
  UpdateMarketFees: 0x10,

  /** User picks a per-market initial-margin override capped by the
   *  market's risk floor. `user_im_bps == 0` clears the override.
   *  Engine takes max(market.im_bps, user_im_bps) on every IM check.
   *  BE-16. */
  SetUserMarketLeverage: 0x16,
  /** Close an entire position by placing an opposite-side IOC order at
   *  oracle±spread. Idempotent on already-closed positions. User-signed. */
  ClosePosition: 0x17,
  /** Cancel a resting order by owner-scoped client order id. */
  CancelClientOrder: 0x18,
  /** Cancel all resting orders for an owner, optionally market-scoped. */
  CancelAllOrders: 0x19,
  /** Atomically cancel one resting order and place its replacement. */
  CancelReplaceOrder: 0x1a,
  /** Amend one resting order in place while preserving its exchange order ID. */
  AmendOrder: 0x1b,
  /** Native all-or-revert multi-leg basket order. */
  AtomicBasketOrder: 0x1c,
} as const;

/** Union of all valid action type byte values. */
export type ActionTypeValue = (typeof ActionType)[keyof typeof ActionType];

// ---------------------------------------------------------------------------
// Action data types (field order matches Rust struct → MessagePack wire layout)
// ---------------------------------------------------------------------------

/** Place a limit order on the order book. */
export interface PlaceOrder {
  /** Market identifier (unique integer). */
  market: number;
  /** Account address of the order owner (20 bytes). */
  owner: Address;
  /** Order side: Buy (1) or Sell (2). */
  side: Side;
  /** Limit price in micro-USDC (6 decimal places, e.g., 66752340000 = $66,752.34). */
  price: bigint;
  /** Order quantity in contracts (integer lots). */
  quantity: bigint;
  /** Optional client-assigned order ID for tracking. */
  clientOrderId?: bigint | null;
  /** When true, the engine rejects the order if it would cross the book on
   *  placement (PostOnlyWouldCross, code 34). For makers who require
   *  maker-side fills. Defaults to false. */
  postOnly?: boolean;
  /** When true, the order may only reduce an existing position. Same-side
   *  orders are rejected (ReduceOnlyWouldIncrease, code 35); over-closing
   *  is clamped to the position size. Defaults to false. */
  reduceOnly?: boolean;
  /**
   * Time-in-force policy. Defaults to `TimeInForce.Gtc` for backward
   * compat. `TimeInForce.Ioc` drops any unfilled quantity after crossing
   * the book (no resting order). `TimeInForce.Fok` rejects unless the
   * visible crossing book can fill the whole order immediately.
   */
  timeInForce?: TimeInForce;
}

/** Cancel an existing resting order by its engine-assigned ID. */
export interface CancelOrder {
  /** Engine-assigned order ID to cancel. */
  orderId: bigint;
  /** Account address of the order owner (20 bytes). Must match the order's owner. */
  owner: Address;
}

/** Cancel an existing resting order by the caller's client-assigned ID. */
export interface CancelClientOrder {
  /** Account address of the order owner (20 bytes). */
  owner: Address;
  /** Client-assigned order ID to cancel. */
  clientOrderId: bigint;
}

/** Cancel all resting orders for an account, optionally scoped to one market. */
export interface CancelAllOrders {
  /** Account address whose resting orders should be cancelled. */
  owner: Address;
  /** Optional market scope; omit/null to cancel across all markets. */
  market?: number | null;
}

/** Atomically cancel a resting order and place its replacement. */
export interface CancelReplaceOrder {
  /** Account address whose order should be cancelled/replaced. */
  owner: Address;
  /** Engine-assigned order ID to cancel. Mutually exclusive with `cancelClientOrderId`. */
  cancelOrderId?: bigint | null;
  /** Owner-scoped client order ID to cancel. Mutually exclusive with `cancelOrderId`. */
  cancelClientOrderId?: bigint | null;
  /** Replacement order market. */
  market: number;
  /** Replacement order side. */
  side: Side;
  /** Replacement limit price. */
  price: bigint;
  /** Replacement quantity. */
  quantity: bigint;
  /** Optional client-assigned ID for the replacement order. */
  clientOrderId?: bigint | null;
  /** Replacement post-only flag. Defaults to false. */
  postOnly?: boolean;
  /** Replacement reduce-only flag. Defaults to false. */
  reduceOnly?: boolean;
  /** Replacement time-in-force policy. Defaults to GTC. */
  timeInForce?: TimeInForce;
}

/** Amend a resting order without changing its exchange order ID. */
export interface AmendOrder {
  /** Account address whose order should be amended. */
  owner: Address;
  /** Engine-assigned order ID to amend. */
  orderId: bigint;
  /** Optional replacement price. Omit/null to keep the existing price. */
  newPrice?: bigint | null;
  /** Optional new total order quantity. Omit/null to keep the existing quantity. */
  newQuantity?: bigint | null;
}

/** Submit an oracle price update for a market (relayer only). */
export interface OracleUpdate {
  /** Market identifier to update. */
  market: number;
  /** New oracle price in micro-USDC (6 decimal places, e.g., 66752340000 = $66,752.34). */
  price: bigint;
  /** Authorized oracle signer address (20 bytes). */
  signer: Address;
  /**
   * Oracle publish timestamp in ms since Unix epoch. Must be strictly
   * greater than the last accepted update on this market (engine
   * rejects with code 30 `OracleTimestampNotMonotonic` otherwise).
   * Added 2026-04-23 per audit B3 as replay protection for the
   * relayer-signed oracle feed.
   */
  publishTimeMs: bigint;
}

/**
 * **Operator action — not for trading integrations.** Submit a composite-CEX
 * price for a market: BE-31 Phase B's third source for the multi-source
 * mark-price median (oracle + book-mid + composite CEX index).
 *
 * A normal trading integration never submits this — it is feeder
 * infrastructure run by the operator. The engine re-checks the signer against
 * a **separate CEX-composite feeder allowlist** (a distinct trust domain from
 * the {@link OracleUpdate} relay), so a non-feeder signer is rejected
 * regardless. Markets ignore the composite entirely unless an operator has
 * flipped them to `Median` via {@link UpdateMarketFees} (`markSourceMode = 1`).
 *
 * @remarks Operator-only. Requires a signer on the engine's CEX-composite
 * feeder allowlist; not needed for trading integrations.
 */
export interface OracleUpdateComposite {
  /** Market identifier to update. */
  market: number;
  /** Composite price in micro-USDC (median/VWAP of `nSources` CEX feeds). */
  price: bigint;
  /** Number of CEX feeds that went into the composite. Observability only —
   *  the engine does not gate on it. Encodes as 0 when absent. */
  nSources: number;
  /** Authorized feeder signer (20 bytes), on the CEX-composite allowlist. */
  signer: Address;
  /** Feeder publish timestamp in ms since Unix epoch. Must be strictly
   *  greater than the last accepted composite on this market (replay guard,
   *  same semantics as {@link OracleUpdate.publishTimeMs}). */
  publishTimeMs: bigint;
}

/** Place a market order that crosses immediately against resting orders. */
export interface MarketOrder {
  /** Market identifier. */
  market: number;
  /** Account address of the order owner (20 bytes). */
  owner: Address;
  /** Order side: Buy (1) or Sell (2). */
  side: Side;
  /** Order quantity in contracts (integer lots). */
  quantity: bigint;
  /** Optional client-assigned order ID for tracking. */
  clientOrderId?: bigint | null;
}

/**
 * Credit USDC to an account (dev/bootstrap action).
 *
 * Per audit B1 (2026-04-23) this action requires a relayer-authorized
 * signer — the envelope signer's derived address must equal `signer`,
 * and `signer` must be on the on-chain relayer allowlist. Clients
 * outside the allowlist see `UnauthorizedRelayer` at the engine.
 * Prefer `ConfirmDeposit` for production flows tied to Solana bridge
 * events.
 */
export interface Deposit {
  /** Account address to credit (20 bytes). */
  owner: Address;
  /** Deposit amount in microUSDC (6 decimal places, e.g., 100_000_000 = $100). */
  amount: bigint;
  /** Authorized relayer signer (20 bytes). Must match the envelope pubkey's derived owner. */
  signer: Address;
}

/**
 * Debit USDC from an account (direct withdraw, checks margin requirements).
 *
 * Per audit B2 (2026-04-23) same relayer-authorization contract as
 * `Deposit`: the envelope signer must equal `signer` and that address
 * must be on the relayer allowlist.
 */
export interface Withdraw {
  /** Account address to debit (20 bytes). */
  owner: Address;
  /** Withdrawal amount in microUSDC (6 decimal places, e.g., 100_000_000 = $100). */
  amount: bigint;
  /** Authorized relayer signer (20 bytes). Must match the envelope pubkey's derived owner. */
  signer: Address;
}

/** Register a new perpetual market with its risk and fee parameters (admin action). */
export interface CreateMarket {
  /** Market identifier (unique integer). */
  market: number;
  /** Initial margin requirement in basis points (e.g., 1000 = 10% = 10x max leverage). */
  imBps: number;
  /** Maintenance margin requirement in basis points (e.g., 500 = 5%). */
  mmBps: number;
  /** Taker fee rate in basis points (e.g., 5 = 0.05%). */
  takerFeeBps: number;
  /** Maker fee rate in basis points (e.g., 2 = 0.02%). */
  makerFeeBps: number;
  /** Authorized relayer signer address (20 bytes). */
  signer: Address;
  /** Funding interval in milliseconds (0 = funding disabled). */
  fundingIntervalMs: bigint;
  /** Maximum absolute funding rate per interval in basis points. */
  maxFundingRateBps: number;
  /**
   * Bad-debt pool the market belongs to. Markets in different pools are
   * insulated from each other's liquidation cascades. Optional — defaults
   * to 0 on the wire (matches the engine's `serde(default)`), so omitting
   * the field keeps a market in the shared pool 0.
   */
  poolId?: number;
  /**
   * Published size scale: order/position `quantity` is in units of
   * 10^-szDecimals of the base asset (display/metadata only — the engine
   * never reads it). MANDATORY: the engine struct has no `serde(default)`
   * for this field, so a payload that omits it is rejected at decode. The
   * scale is fixed at creation and immutable thereafter. Use 0 for
   * integer-unit sizing.
   */
  szDecimals: number;
  /**
   * Human-readable ticker / short symbol (e.g. `BTC`). Display/metadata only
   * — the engine never reads it. MANDATORY on the wire (no serde(default)),
   * though an empty string is accepted; capped at 24 bytes by the engine.
   * Fixed at creation and immutable thereafter.
   */
  ticker: string;
  /**
   * Aggregate market open-interest cap in contracts. Omitted, null, and 0 all
   * mean uncapped and encode identically as the canonical 12-field payload
   * with an explicit 0 tail. Legacy 11-field payloads still decode as 0n.
   */
  maxOpenInterest?: bigint | null;
}

/** User requests a USDC withdrawal to a Solana address. Debits balance immediately. */
export interface WithdrawRequest {
  /** Account address requesting the withdrawal (20 bytes). */
  owner: Address;
  /** Withdrawal amount in microUSDC (6 decimal places). */
  amount: bigint;
  /** Solana destination public key (Ed25519, 32 bytes). */
  solanaDestination: Uint8Array; // 32 bytes
}

/** Relayer confirms an on-chain USDC deposit from Solana. Credits the account. */
export interface ConfirmDeposit {
  /** Account address to credit (20 bytes). */
  owner: Address;
  /** Deposit amount in microUSDC (6 decimal places). */
  amount: bigint;
  /** Solana transaction signature for idempotency (typically 64 bytes). */
  solanaTxSig: Uint8Array;
  /** Authorized relayer signer address (20 bytes). */
  signer: Address;
}

/** Relayer confirms a USDC withdrawal was sent on Solana. */
export interface ConfirmWithdrawal {
  /** Engine-assigned withdrawal ID. */
  withdrawalId: bigint;
  /** Solana transaction signature (typically 64 bytes). */
  solanaTxSig: Uint8Array;
  /** Authorized relayer signer address (20 bytes). */
  signer: Address;
}

/** Lifecycle status of a withdrawal record. Title-case strings are
 *  serde's default for unit variants — wire format is locked. */
export type WithdrawalStatus = "Pending" | "Completed" | "Failed";

/** On-chain withdrawal record returned by `queryWithdrawal`. Mirrors
 *  `exchange-core::types::WithdrawalRecord` field-for-field. */
export interface WithdrawalRecord {
  /** Engine-assigned withdrawal id. */
  id: bigint;
  /** Account address that requested the withdrawal (20 bytes). */
  owner: Address;
  /** Withdrawal amount in microUSDC. */
  amount: bigint;
  /** Solana destination public key (Ed25519, 32 bytes). */
  solanaDestination: Uint8Array;
  /** Pending → Completed or Pending → Failed; never reverses. */
  status: WithdrawalStatus;
  /** Block height at which the request was admitted. */
  requestHeight: bigint;
}

/** Relayer marks a withdrawal as permanently failed; refunds the debited balance. */
export interface FailWithdrawal {
  /** Engine-assigned withdrawal ID. */
  withdrawalId: bigint;
  /** Human-readable reason for the failure. */
  reason: string;
  /** Authorized relayer signer address (20 bytes). */
  signer: Address;
}

/**
 * Approve a delegate keypair ("agent wallet") to trade on the owner's behalf.
 * The agent can place/cancel orders but CANNOT withdraw or move funds.
 */
export interface ApproveAgent {
  /** Account address granting the delegation (20 bytes). */
  owner: Address;
  /** Ed25519 public key of the agent wallet (32 bytes). */
  agentPubkey: Uint8Array; // 32 bytes
}

/** Revoke a previously approved agent wallet. */
export interface RevokeAgent {
  /** Account address revoking the delegation (20 bytes). */
  owner: Address;
  /** Ed25519 public key of the agent wallet to revoke (32 bytes). */
  agentPubkey: Uint8Array; // 32 bytes
}

/** Branch of a binary event. */
export enum Branch {
  Yes = 1,
  No = 2,
}

/** Outcome of an impact-market event. */
export enum Outcome {
  Yes = 1,
  No = 2,
  Void = 3,
}

/**
 * BE-54: comparison operator used by the auto-resolve oracle modes.
 * `YES` fires iff `oracle_price <comparison> strike_price` (e.g.
 * `GreaterThan` means the event resolves YES when the oracle reading is
 * strictly greater than the strike). Equality on the boundary is
 * distinguished by the `OrEqual` variants. Mirrors the engine's
 * `PriceComparison` enum exactly.
 */
export type PriceComparison =
  "GreaterThan" | "LessThan" | "GreaterThanOrEqual" | "LessThanOrEqual";

/**
 * BE-54: how an impact-market event's YES/NO outcome is determined at
 * deadline. Carried optionally on `CreateImpactMarket`; `undefined`
 * (the wire `nil`) means `RelayerAttested` — the legacy default where
 * the resolver supplies the outcome and the engine trusts it. The two
 * auto-resolve modes derive YES/NO from an on-chain oracle reading and
 * make the relayer's outcome a verifiable assertion (engine recomputes
 * and rejects on mismatch). Use `RelayerAttested` for events that have
 * no on-chain price (e.g. "did Apple announce X?").
 */
export type EventOracleSource =
  | {
      kind: "UnderlyingPriceVsStrike";
      strikePrice: bigint;
      comparison: PriceComparison;
    }
  | {
      kind: "MarketOracle";
      market: number;
      strikePrice: bigint;
      comparison: PriceComparison;
    }
  | { kind: "RelayerAttested" };

/** Create an impact-market family with 4 child books (CPY/CPN/EBY/EBN). */
export interface CreateImpactMarket {
  impactMarketId: number;
  underlyingMarket: number;
  childMarketBase: number;
  question: string;
  deadlineMs: bigint;
  resolutionWindowMs: bigint;
  imBps: number;
  mmBps: number;
  takerFeeBps: number;
  makerFeeBps: number;
  fundingIntervalMs: bigint;
  maxFundingRateBps: number;
  signer: Address;
  /**
   * BE-54: how this event's YES/NO outcome is determined at deadline.
   * Optional — `undefined` (the wire `nil`) means `RelayerAttested`,
   * which preserves the legacy behavior where the resolver supplies the
   * outcome and the engine trusts it. Setting `UnderlyingPriceVsStrike`
   * or `MarketOracle` makes the resolution self-verifying: the engine
   * derives YES/NO from the named oracle's reading and rejects any
   * `ResolveEvent` whose `outcome` doesn't match. `Outcome.Void`
   * overrides the auto-derivation in either auto-resolve mode (operator
   * escape hatch for unresolvable events).
   */
  oracleSource?: EventOracleSource;
  /** Optional event body text for frontend detail pages. Encodes as "" when
   *  absent (matches the engine's `serde(default)`). */
  description?: string;
  /** Optional resolution criteria text. Encodes as "" when absent (matches
   *  the engine's `serde(default)`). */
  rules?: string;
}

/** Resolve an impact-market event. */
export interface ResolveEvent {
  impactMarketId: number;
  outcome: Outcome;
  signer: Address;
}

/**
 * Update a subset of `MarketConfig` fields on an existing market.
 * Every tunable is optional; `null`/`undefined` leaves the current
 * value untouched. Requires relayer authorization.
 *
 * Built 2026-04-21 when we observed BTC funding spikes to −1608 bps
 * under the seed-time max_funding_rate_bps = 3000 cap on a live
 * chain we couldn't rebase. This is the engine-level lever to tighten
 * parameters on a running market.
 *
 * `kind` and `szDecimals` remain immutable. Margin ratios may only be
 * tightened by the engine; lowering either live risk floor is rejected.
 */
export interface UpdateMarketFees {
  market: number;
  signer: Address;
  /** New taker fee in basis points. Omit to leave unchanged. */
  takerFeeBps?: number | null;
  /** New maker fee in basis points. Omit to leave unchanged. */
  makerFeeBps?: number | null;
  /** New max funding rate cap in basis points per interval. 0 = disable funding. */
  maxFundingRateBps?: number | null;
  /** New funding interval in ms. Omit to leave unchanged. */
  fundingIntervalMs?: bigint | null;
  /** New per-account position cap in contracts. 0 = disable cap. */
  maxPositionSize?: bigint | null;
  /**
   * New default order TTL in milliseconds. Omit to leave unchanged.
   * 0 disables the end-of-block order-expiry sweep for this market.
   * Added 2026-04-23 (see `run_order_expiry` in the engine): gives
   * operators a live lever to auto-cancel stale MM quotes instead of
   * requiring `make repair`.
   */
  defaultTtlMs?: bigint | null;
  /**
   * Flip net-delta portfolio margin on this market. Omit to leave
   * unchanged. true = firing legs with the same underlying group into
   * a single net position for MM/IM (|Σ signed_size| × settle ×
   * weighted_bps); false = per-leg scenario margin. See
   * `MarketConfig.netDeltaMargin` and `docs/margin-engine.md §6`.
   * Safe to flip on at any time; flipping off can push accounts
   * under MM.
   */
  netDeltaMargin?: boolean | null;
  /**
   * New tick size in micro-USDC. Omit (or null) to leave unchanged.
   * 0 disables the tick gate (any price accepted). BE-48.
   */
  tickSize?: bigint | null;
  /**
   * New lot size in contracts. Omit (or null) to leave unchanged.
   * 0 disables the lot gate (any quantity accepted). BE-48.
   */
  lotSize?: bigint | null;
  /**
   * Primary oracle signer for this market. Omit (or null) to leave
   * unchanged. Pass an all-zero address (20 zero bytes) to
   * clear the primary signer; setting `oracleStalenessMs` to 0 only
   * temporarily disables the fallback gate while preserving the configured
   * primary. BE-50.
   */
  primaryOracleSigner?: Address | null;
  /**
   * Oracle staleness threshold in ms. Omit (or null) to leave
   * unchanged. Only consulted when `primaryOracleSigner` is set on
   * the market. 0 disables the gate. BE-50.
   */
  oracleStalenessMs?: bigint | null;
  /**
   * BE-31 Phase A: mark-price source mode. Omit to leave unchanged.
   * 0 = OracleOnly (legacy); 1 = Median (oracle + book-mid).
   * Has no effect on impact-family child markets - those always
   * mark off the EWMA per the no-oracle-MTM redesign.
   */
  markSourceMode?: 0 | 1 | null;
  /**
   * BE-31 Phase A: thin-book spread cap in bps for the median guard.
   * Omit to leave unchanged. 0 resets to the engine default
   * (DEFAULT_MAX_MARK_SPREAD_BPS = 100). Ignored unless
   * `markSourceMode === 1`.
   */
  maxMarkSpreadBps?: number | null;
  /**
   * BE-31 Phase B: max age in ms for the composite-CEX price source.
   * Omit to leave unchanged. 0 resets to the engine default
   * (DEFAULT_CEX_COMPOSITE_STALENESS_MS = 30s).
   */
  cexCompositeStalenessMs?: bigint | null;
  /**
   * BE-26: enable partial liquidation for this market. Omit to leave
   * unchanged. true closes one position at a time and rechecks MM.
   */
  partialLiquidationEnabled?: boolean | null;
  /**
   * Replace the rolling-volume fee-tier table. Omit to leave unchanged;
   * [] clears volume tiers and falls back to flat taker/maker bps.
   */
  feeTiers?: FeeTier[] | null;
  /**
   * New initial margin ratio in basis points. Omit to leave unchanged.
   * Must be greater than or equal to the current market value.
   */
  imBps?: number | null;
  /**
   * New maintenance margin ratio in basis points. Omit to leave unchanged.
   * Must be greater than or equal to the current value, positive, and no
   * greater than the resulting `imBps`.
   */
  mmBps?: number | null;
  /**
   * New aggregate open-interest cap in contracts. Omit to leave unchanged;
   * 0 disables the cap.
   */
  maxOpenInterest?: bigint | null;
}

/** Lifecycle status of an impact-market family. */
export type ImpactMarketStatus =
  | { kind: "Trading" }
  | { kind: "PreResolution" }
  | { kind: "Resolved"; outcome: Outcome };

/** On-chain info for an impact-market family. */
export interface ImpactMarketInfo {
  impactMarketId: number;
  underlyingMarket: number;
  cpyMarket: number;
  cpnMarket: number;
  ebyMarket: number;
  ebnMarket: number;
  question: string;
  deadlineMs: bigint;
  resolutionWindowMs: bigint;
  status: ImpactMarketStatus;
  createdMs: bigint;
  resolvedMs: bigint;
}

// ---------------------------------------------------------------------------
// Action union type
// ---------------------------------------------------------------------------

/** Pick a per-account override on the initial-margin ratio for one
 *  market. Engine takes max(market.imBps, userImBps), so users can
 *  deleverage but not exceed the market's risk floor. `userImBps == 0`
 *  clears the override. User-signed (signer == owner). BE-16. */
export interface SetUserMarketLeverage {
  /** Account address picking the override (20 bytes). Must equal the
   *  envelope signer's derived address. */
  owner: Address;
  /** Market identifier the override applies to. */
  market: number;
  /** Initial margin in basis points. `0` clears the override;
   *  otherwise must be `>= market.imBps` (engine rejects with
   *  `UserLeverageBelowMarketIm`, code 38). */
  userImBps: number;
}

/** Close an entire position on a market by placing an opposite-side IOC
 *  order at oracle±spread. Idempotent: returns code=0 without events if
 *  no position exists. User-signed (signer == owner). S49. */
export interface ClosePosition {
  /** Market identifier to close the position on. */
  market: number;
  /** Account address of the position owner (20 bytes). Must equal the
   *  envelope signer's derived address. */
  owner: Address;
}

/** One leg of a native all-or-revert basket. The engine executes every leg as
 *  a fill-or-kill limit order; if any leg cannot fully fill at `price` or
 *  better, the whole transaction rolls back. */
export interface AtomicBasketLeg {
  /** Market identifier for this leg. */
  market: number;
  /** Leg side: Buy or Sell. */
  side: Side;
  /** Worst acceptable execution price in micro-USDC. Buy legs will not pay
   *  above this; sell legs will not sell below it. */
  price: bigint;
  /** Leg quantity in contracts (integer lots). */
  quantity: bigint;
  /** Optional client-assigned order ID echoed in events for correlation. */
  clientOrderId?: bigint | null;
  /** When true, this leg may only reduce an existing position. */
  reduceOnly?: boolean;
}

/** Native all-or-revert multi-leg basket order (action `0x1c`). Every leg fills
 *  fully or the entire transaction reverts through the tx overlay. */
export interface AtomicBasketOrder {
  /** Account address of the basket owner (20 bytes). Must equal the envelope
   *  signer's derived address. */
  owner: Address;
  /** Ordered legs; each executes as a fill-or-kill limit order. */
  legs: AtomicBasketLeg[];
  /** Basket-wide slippage budget in basis points. The engine enforces each
   *  leg's explicit price limit; this value is emitted for auditability and
   *  client/UI reconciliation. Encodes as 0 when absent (NOT nil). */
  maxSlippageBps?: number;
}

/**
 * Trading actions — the surface a normal integration (market maker, bot,
 * trader) uses. User-signed: each is authorized by the account that owns the
 * order/position/funds it touches. This is the union you want by default.
 */
export type TraderAction =
  | { type: "PlaceOrder"; data: PlaceOrder }
  | { type: "CancelOrder"; data: CancelOrder }
  | { type: "CancelClientOrder"; data: CancelClientOrder }
  | { type: "CancelAllOrders"; data: CancelAllOrders }
  | { type: "CancelReplaceOrder"; data: CancelReplaceOrder }
  | { type: "AmendOrder"; data: AmendOrder }
  | { type: "AtomicBasketOrder"; data: AtomicBasketOrder }
  | { type: "MarketOrder"; data: MarketOrder }
  | { type: "WithdrawRequest"; data: WithdrawRequest }
  | { type: "ApproveAgent"; data: ApproveAgent }
  | { type: "RevokeAgent"; data: RevokeAgent }
  | { type: "SetUserMarketLeverage"; data: SetUserMarketLeverage }
  | { type: "ClosePosition"; data: ClosePosition };

/**
 * Operator actions — privileged infrastructure submitted by the operator's
 * relayer / oracle relay / CEX-composite feeder, **not** by a trading
 * integration. Each is gated by a dedicated engine allowlist (relayer, oracle,
 * or composite-feeder); a normal trader's signer is rejected. They are part of
 * the public wire contract (so operator tooling has one SDK), but a trading
 * consumer should never need them. See the "Operator actions" section in
 * AGENTS.md / README.md.
 */
export type OperatorAction =
  | { type: "OracleUpdate"; data: OracleUpdate }
  | { type: "OracleUpdateComposite"; data: OracleUpdateComposite }
  | { type: "Deposit"; data: Deposit }
  | { type: "Withdraw"; data: Withdraw }
  | { type: "CreateMarket"; data: CreateMarket }
  | { type: "ConfirmDeposit"; data: ConfirmDeposit }
  | { type: "ConfirmWithdrawal"; data: ConfirmWithdrawal }
  | { type: "FailWithdrawal"; data: FailWithdrawal }
  | { type: "CreateImpactMarket"; data: CreateImpactMarket }
  | { type: "ResolveEvent"; data: ResolveEvent }
  | { type: "UpdateMarketFees"; data: UpdateMarketFees };

/**
 * Discriminated union of every exchange action. Equals
 * {@link TraderAction} ∪ {@link OperatorAction}. `submitTx` accepts this full
 * union — trading integrations can narrow to `TraderAction` to keep operator
 * actions out of autocomplete.
 */
export type Action = TraderAction | OperatorAction;

// ---------------------------------------------------------------------------
// Event types (emitted by engine, delivered via ABCI/WebSocket)
// ---------------------------------------------------------------------------

/** Emitted when a limit order is placed on the order book. All string fields are stringified numbers. */
export interface OrderPlacedEvent {
  type: "OrderPlaced";
  /** Engine-assigned order ID. */
  orderId: string;
  /** Market identifier. */
  market: string;
  /** Hex-encoded owner address. */
  owner: string;
  /** Order side ("Buy" or "Sell"). */
  side: string;
  /** Limit price in micro-USDC (6 dp, e.g., "66752340000" = $66,752.34). */
  price: string;
  /** Order quantity in contracts (integer lots). */
  quantity: string;
  /** Client-assigned order ID, or "0" when absent. */
  clientOrderId: string;
}

/** Emitted when an order is cancelled. */
export interface OrderCancelledEvent {
  type: "OrderCancelled";
  /** Engine-assigned order ID. */
  orderId: string;
  /** Market identifier. */
  market: string;
  /** Hex-encoded owner address. */
  owner: string;
  /** Cancellation reason (e.g., "user_requested", "liquidation"). */
  reason: string;
  /** Client-assigned order ID, or "0" when absent. */
  clientOrderId: string;
  /** Quantity originally accepted onto the book. */
  originalQuantity: string;
  /** Quantity still resting when cancelled. */
  remainingQuantity: string;
  /** Cumulative maker quantity filled before cancellation. */
  filledQuantity: string;
}

/** Emitted when a trade (fill) is executed between a maker and taker. */
export interface TradeExecutedEvent {
  type: "TradeExecuted";
  /** Unique fill identifier. */
  fillId: string;
  /** Market identifier. */
  market: string;
  /** Execution price in micro-USDC (6 dp). */
  price: string;
  /** Fill quantity in contracts (integer lots). */
  quantity: string;
  /** Engine-assigned order ID of the resting (maker) order. */
  makerOrderId: string;
  /** Maker client-assigned order ID, or "0" when absent. */
  makerClientOrderId: string;
  /** Hex-encoded maker address. */
  makerOwner: string;
  /** Maker's side ("Buy" or "Sell"). */
  makerSide: string;
  /** Hex-encoded taker address. */
  takerOwner: string;
  /** Taker client-assigned order ID, or "0" when absent. */
  takerClientOrderId: string;
  /** Taker fee in microUSDC. Current engine emits non-negative charges. */
  takerFee: string;
  /** Maker fee in microUSDC. Current engine emits non-negative charges. */
  makerFee: string;
}

/** Emitted alongside TradeExecuted to summarize fees for a fill. */
export interface FeesCollectedEvent {
  type: "FeesCollected";
  /** Market identifier. */
  market: string;
  /** Hex-encoded taker address. */
  takerOwner: string;
  /** Taker fee in microUSDC (signed). */
  takerFee: string;
  /** Hex-encoded maker address. */
  makerOwner: string;
  /** Maker fee in microUSDC (signed). */
  makerFee: string;
}

/** Emitted when USDC is deposited into an account. */
export interface DepositedEvent {
  type: "Deposited";
  /** Hex-encoded owner address. */
  owner: string;
  /** Deposited amount in microUSDC (6 dp). */
  amount: string;
  /** Balance after deposit in microUSDC (6 dp). */
  newBalance: string;
}

/** Emitted when USDC is withdrawn from an account. */
export interface WithdrawnEvent {
  type: "Withdrawn";
  /** Hex-encoded owner address. */
  owner: string;
  /** Withdrawn amount in microUSDC (6 dp). */
  amount: string;
  /** Balance after withdrawal in microUSDC (6 dp). */
  newBalance: string;
}

/** Emitted when a position is opened or its size/entry changes due to a fill. */
export interface PositionUpdatedEvent {
  type: "PositionUpdated";
  /** Hex-encoded owner address. */
  owner: string;
  /** Market identifier. */
  market: string;
  /** Position side ("Buy" = long, "Sell" = short). */
  side: string;
  /** Weighted-average entry price in micro-USDC (6 dp). */
  entryPrice: string;
  /** Absolute position size in contracts (integer lots). */
  size: string;
}

/** Emitted when a position is fully closed. */
export interface PositionClosedEvent {
  type: "PositionClosed";
  /** Hex-encoded owner address. */
  owner: string;
  /** Market identifier. */
  market: string;
  /** Realized PnL in microUSDC (signed; positive = profit). */
  realizedPnl: string;
}

/** Emitted when the oracle price is updated for a market. */
export interface PriceUpdatedEvent {
  type: "PriceUpdated";
  /** Market identifier. */
  market: string;
  /** New oracle price in micro-USDC (6 dp). */
  price: string;
}

/** Emitted when a new perpetual market is registered. */
export interface MarketCreatedEvent {
  type: "MarketCreated";
  /** Market identifier. */
  market: string;
  /** Initial margin requirement in basis points. */
  imBps: string;
  /** Maintenance margin requirement in basis points. */
  mmBps: string;
  /** Taker fee rate in basis points. */
  takerFeeBps: string;
  /** Maker fee rate in basis points. */
  makerFeeBps: string;
  /** Funding interval in milliseconds (0 = disabled). */
  fundingIntervalMs: string;
  /** Maximum absolute funding rate per interval in basis points. */
  maxFundingRateBps: string;
}

/** Emitted when an account is liquidated due to insufficient maintenance margin. */
export interface AccountLiquidatedEvent {
  type: "AccountLiquidated";
  /** Hex-encoded owner address. */
  owner: string;
  /** Market identifier. */
  market: string;
  /** Liquidated position side ("Buy" or "Sell"). */
  side: string;
  /** Liquidated position size in contracts (integer lots). */
  size: string;
  /** Mark price at liquidation in micro-USDC (6 dp). */
  markPrice: string;
  /** Realized PnL from liquidation in microUSDC (signed). */
  realizedPnl: string;
}

/** Emitted when periodic funding is applied to a market. */
export interface FundingAppliedEvent {
  type: "FundingApplied";
  /** Market identifier. */
  market: string;
  /** Funding rate in basis points (signed; positive = longs pay shorts). */
  fundingRateBps: string;
  /** Cumulative funding index after this application (signed). */
  cumulativeFunding: string;
  /** Block timestamp in milliseconds when funding was applied. */
  timestampMs: string;
}

/** Emitted when funding is settled for an individual position. */
export interface FundingSettledEvent {
  type: "FundingSettled";
  /** Hex-encoded owner address. */
  owner: string;
  /** Market identifier. */
  market: string;
  /** Funding payment in microUSDC (signed; positive = received, negative = paid). */
  payment: string;
}

/** Emitted when an agent wallet is approved for delegation. */
export interface AgentApprovedEvent {
  type: "AgentApproved";
  /** Hex-encoded owner address. */
  owner: string;
  /** Hex-encoded agent address (derived from agentPubkey). */
  agent: string;
  /** Hex-encoded Ed25519 public key of the agent (32 bytes). */
  agentPubkey: string;
}

/** Emitted when an agent wallet delegation is revoked. */
export interface AgentRevokedEvent {
  type: "AgentRevoked";
  /** Hex-encoded owner address. */
  owner: string;
  /** Hex-encoded agent address (derived from agentPubkey). */
  agent: string;
  /** Hex-encoded Ed25519 public key of the agent (32 bytes). */
  agentPubkey: string;
}

/**
 * Emitted exactly once at the end of every market-order tx that passes
 * envelope checks, regardless of how many fills happened.
 *
 * This is the authoritative "did my market order do anything?" signal:
 *   - `filledQuantity == requestedQuantity`  → fully filled
 *   - `0 < filledQuantity < requestedQuantity` → partial fill, IOC remainder dropped
 *   - `filledQuantity == 0` → no counterparty (or all counterparties were
 *      the taker themselves and got rejected by self-match prevention)
 *
 * Without this event, callers would have to count downstream `TradeExecuted`
 * events and could not distinguish "no counterparty" from "trade events
 * arrived in a different stream view".
 */
export interface MarketOrderProcessedEvent {
  type: "MarketOrderProcessed";
  market: string;
  /** Hex-encoded owner address. */
  owner: string;
  /** Side of the original market order ("Buy" or "Sell"). */
  side: string;
  /** Quantity originally requested (integer lots). */
  requestedQuantity: string;
  /** Quantity actually filled before IOC drop (integer lots). */
  filledQuantity: string;
  /** Client-assigned order ID of the IOC/market/close request, when present. */
  clientOrderId?: string;
}

/** Absolute post-mutation quantity at one orderbook price level. */
export interface OrderbookLevelUpdatedEvent {
  type: "OrderbookLevelUpdated";
  /** Market identifier. */
  market: string;
  /** Book side ("Buy" or "Sell"). */
  side: string;
  /** Price level in micro-USDC. */
  price: string;
  /** Total resting quantity at this price after the mutation. */
  totalQuantity: string;
  /** Resting order count at this price after the mutation. */
  orderCount: string;
}

/** Union of all exchange events. */
export type ExchangeEvent =
  | OrderPlacedEvent
  | OrderCancelledEvent
  | TradeExecutedEvent
  | FeesCollectedEvent
  | DepositedEvent
  | WithdrawnEvent
  | PositionUpdatedEvent
  | PositionClosedEvent
  | PriceUpdatedEvent
  | MarketCreatedEvent
  | AccountLiquidatedEvent
  | FundingAppliedEvent
  | FundingSettledEvent
  | AgentApprovedEvent
  | AgentRevokedEvent
  | MarketOrderProcessedEvent
  | OrderbookLevelUpdatedEvent;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * What produced a {@link TxResult}. Lets callers separate an engine rejection
 * from a transport/timeout failure without reverse-engineering the numeric
 * `code` (engine codes and synthesized HTTP statuses share that field):
 *
 * - `"ok"`        — CheckTx accepted the tx (`code === 0`).
 * - `"engine"`    — the engine rejected it with an `ExecError` (`code` 1..50/255);
 *                   see {@link TxResult.error} for the decoded name/description.
 * - `"transport"` — a gateway/HTTP-level failure (auth, rate-limit, body too
 *                   large, 5xx, non-JSON body). `code` is the synthesized HTTP
 *                   status, not an engine code.
 * - `"timeout"`   — no final chain verdict is available yet (`code === -1`):
 *                   either the gateway returned a hash-only ambiguous response
 *                   or inclusion polling expired. The tx may still land.
 */
export type TxOutcome = "ok" | "engine" | "transport" | "timeout";

/** Result of submitting a transaction to the exchange. */
export interface TxResult {
  /**
   * True iff the tx passed CheckTx (engine `code === 0`). Primary discriminant —
   * prefer `if (!result.ok)` over `result.code !== 0`.
   */
  ok: boolean;
  /**
   * Category of the outcome — see {@link TxOutcome}. Distinguishes engine
   * rejections from transport/timeout failures that also surface via `code`.
   */
  outcome: TxOutcome;
  /**
   * Status code. `0` on success; the engine `ExecError` code on
   * `outcome === "engine"`; a synthesized HTTP status on `"transport"`; `-1` on
   * `"timeout"`. Retained for back-compat with `result.code === 0` checks.
   */
  code: number;
  /**
   * Decoded engine error, populated automatically (via `decodeExecError`) when
   * `outcome === "engine"` and the code is known — so callers get a typed
   * `{ name, description }` without decoding it themselves. `null` for success,
   * transport/timeout failures, and unknown engine codes.
   */
  error: ExecErrorInfo | null;
  /** Transaction hash (hex-encoded). Empty string when the tx never got a hash. */
  hash: string;
  /** Block height at which the transaction was included. */
  height?: number;
  /** Human-readable log message (populated on error). */
  log?: string;
  /** ABCI events emitted by the transaction. */
  events?: TxEvent[];
}

/** A single ABCI event with key-value attributes. */
export interface TxEvent {
  /** Event type string (e.g., "OrderPlaced", "TradeExecuted"). */
  type: string;
  /** Key-value attributes for the event. */
  attributes: { key: string; value: string }[];
}

// ---------------------------------------------------------------------------
// Query response types
// ---------------------------------------------------------------------------

/** A single price level in the order book. */
export interface OrderbookLevel {
  /** Price in micro-USDC (6 dp, e.g., 66752340000 = $66,752.34). */
  price: bigint;
  /** Total resting quantity at this level in contracts (integer lots). */
  totalQty: bigint;
  /** Number of resting orders at this level. */
  orderCount: number;
}

/** Aggregated order book snapshot for a market. */
export interface Orderbook {
  /** Bid (buy) levels, sorted best (highest) first. */
  bids: OrderbookLevel[];
  /** Ask (sell) levels, sorted best (lowest) first. */
  asks: OrderbookLevel[];
}

/** A resting order on the book. Returned by `GET /v1/orders/{addr}`.
 *  Wire shape: 6-tuple `[id, market, owner, side, price, quantity]`. */
export interface OpenOrder {
  /** Engine-assigned order ID (monotonic within the market). */
  id: bigint;
  /** Market ID. */
  market: number;
  /** 20-byte owner address. */
  owner: Uint8Array;
  /** Order side. */
  side: "Buy" | "Sell";
  /** Limit price in micro-USDC. */
  price: bigint;
  /** Resting quantity in contracts. */
  quantity: bigint;
}

/** One row of the auto-deleveraging queue for a market. Returned sorted by
 *  `adlScore` desc (front of the queue first). Decoded from the msgpack
 *  6-tuple `[owner, market, side, size, upnlNow, adlScore]`. Endpoint:
 *  `GET /v1/adl/queue/{market}`. */
export interface AdlQueueEntry {
  /** 20-byte owner address. */
  owner: Uint8Array;
  market: number;
  /** Position side: "Buy" = long, "Sell" = short. */
  side: "Buy" | "Sell";
  /** Position size in contracts. */
  size: bigint;
  /** Unrealized PnL at the current mark, signed. Always positive here
   *  (only profitable positions are queued). */
  upnlNow: bigint;
  /** `max(0, upnlNow) × leverage_bps`. Higher = closer to the front of the
   *  ADL queue. */
  adlScore: bigint;
}

/** One-round-trip market summary. Returned by `GET /v1/ticker/{market}`. */
export interface Ticker {
  /** Market id as decimal string. */
  market: string;
  /** Last fill price in the 24h window (empty/"0" if no trades). */
  lastPrice: string;
  /** Σ quantity across the 24h window (integer contracts). */
  volume24hContracts: string;
  /** Signed 24h change in basis points. Empty/"0" if no trades. */
  change24hBps: string;
  /** Base64 msgpack FundingInfo (mark EWMA, oracle, funding rate, interval). */
  fundingMsgpackB64: string;
  /** Base64 msgpack OrderbookSnapshot at depth=1. Empty for fresh markets. */
  orderbookMsgpackB64: string;
  /** Null today — the engine doesn't track open interest yet. */
  openInterest: string | null;
}

/** Information about a single open position.
 *
 * Fields 0-5 are the raw `Position` state; fields 6-11 (the "now"/
 * "if_fires"/"if_dies"/"since" fields) are response-only enrichments
 * computed by `query_account` in the node. Indices are stable with
 * the msgpack wire tuple returned by `/v1/account/{address}` — older
 * SDK versions that only read indices 0-5 continue to work; indices
 * 6+ are undefined on older responses (gateway returns them as of
 * commit `[Sprint 1 Day 1]` / 2026-04-24).
 */
export interface PositionInfo {
  /** [0] Owner address (20 bytes). */
  owner: Uint8Array;
  /** [1] Market identifier. */
  market: number;
  /** [2] Position side: "Buy" (long) or "Sell" (short). */
  side: "Buy" | "Sell";
  /** [3] Weighted-average entry price in micro-USDC (6 dp). */
  entryPrice: bigint;
  /** [4] Absolute position size in contracts (integer lots). */
  size: bigint;
  /** [5] Cumulative funding index at the time the position was last settled. */
  lastFundingIndex: bigint;

  // ── Response-only enrichment (indices 6-11, absent on legacy responses) ──

  /** [6] Unrealized P&L at the current mark, unconditional. Perp + CP use
   * the oracle as the current mark; binaries return 0 (no deterministic
   * current mark — use pnlIfFires/pnlIfDies for binary payoffs). */
  upnlNow?: bigint;
  /** [7] Maintenance margin this position contributes when its firing
   * branch is active. For Perp = always; for CP/Binary = zero under
   * the non-firing branch. */
  mmNow?: bigint;
  /** [8] Initial margin contribution, same semantics as mmNow. */
  imNow?: bigint;
  /** [9] Position value if its branch fires (μ = 1):
   *   `sign(side) × (settle × size − entry × size)`
   * Perp always fires. CP fires when event resolves to its branch.
   * Binary fires + settles to BINARY_PRICE_MAX × size. */
  pnlIfFires?: bigint;
  /** [10] Position value if its branch does NOT fire (μ = 0):
   *   `sign(side) × (0 − entry × size)`
   * Perp: equal to upnlNow (perps never die; reported for UI column
   * symmetry). CP/Binary: the non-firing payoff. */
  pnlIfDies?: bigint;
  /** [11] Funding accrued since the position's last settled funding index.
   * Positive = credit, negative = debit.
   *   `-sign(side) × (cumulative − lastFundingIndex) × size / FUNDING_SCALE`
   */
  fundingSince?: bigint;
  /** [12] ADL queue score: `max(0, upnlNow) × leverage_used`. Higher
   *  = closer to the front of the auto-deleveraging queue (Tier 3 of
   *  the bad-debt waterfall). Only profitable positions have a
   *  non-zero score; losers are liquidated long before they're at
   *  risk of being ADL'd.
   *
   *  Formula: `(positiveUpnl × notional × 10_000) / imNow`, with the
   *  10_000 factor expressing leverage in basis points so the product
   *  fits in i64 cleanly. Returned as 0 for losing or non-firing
   *  positions.
   *
   *  UIs should rank positions by `adlScore` desc to compute a
   *  per-market percentile and warn at >90th percentile (the v3
   *  design-doc threshold). Added 2026-04-25. */
  adlScore?: bigint;
}

/** One entry per active impact market the account touches. Tuple of
 * (impactMarketId, branch) where branch is "Yes" or "No". Ordering is
 * ascending by impactMarketId (deterministic across nodes).
 *
 * See AccountInfo.bindingScenario for semantics. */
export interface BindingScenarioEntry {
  impactMarketId: number;
  branch: "Yes" | "No";
}

/** One row of the per-user deposit/withdraw cash-flow log. Covers four
 * event kinds — see the `kind` field. Feeds the Portfolio EquityChart
 * "equity over time" reconstruction (Jesse's P2 #6).
 *
 * Returned by `GET /v1/history/deposits/{address}` and `GET
 * /v1/history/withdrawals/{address}`, and by the `historyDeposits` /
 * `historyWithdrawals` InfoRequests. Shipped 2026-04-24. */
export interface HistoryCashFlow {
  /** One of the four Rust event kinds. */
  kind:
    | "deposit_confirmed"
    | "withdraw_requested"
    | "withdrawal_confirmed"
    | "withdrawal_failed";
  /** 20-byte owner address as hex. */
  owner: string;
  /** Amount in µUSDC (always positive). Use `signedDelta` for signed
   * balance-change reconstruction. May be empty for
   * `withdrawal_confirmed` (engine doesn't emit amount on ack). */
  amount: string;
  /** Signed balance delta for this event:
   *   +amount for deposit_confirmed + withdrawal_failed (credit)
   *   -amount for withdraw_requested                    (debit)
   *   "0"     for withdrawal_confirmed                  (no change) */
  signedDelta: string;
  /** Post-event balance. Available for deposit/request/failed;
   * empty for confirmed (no balance change on that event). */
  newBalance: string;
  /** Present on withdrawal events (request, confirmed, failed). */
  withdrawalId: string;
  /** Present on deposit_confirmed + withdrawal_confirmed. */
  solanaTxSig: string;
  /** Present on withdraw_requested only. */
  solanaDestination: string;
  /** Present on withdrawal_failed only. */
  reason: string;
  /** Block height at which the event landed. */
  blockHeight: number;
  /** Unix milliseconds. */
  timestamp: number;
}

/** One row of the per-user position-at-resolution log. Covers three
 * kinds — see `kind` field. Feeds Portfolio Resolved tab + Impact /
 * Prediction resolved-state "your outcome" block.
 *
 * Returned by `GET /v1/history/resolutions/{address}` and the
 * `historyResolutions` InfoRequest. Shipped 2026-04-24 (see Jesse's
 * P2 #7 in docs/api-scope.md). */
export interface HistoryResolution {
  /** One of "conditional_settled" | "conditional_voided" | "prediction_settled". */
  kind: "conditional_settled" | "conditional_voided" | "prediction_settled";
  /** Impact-market family ID the resolved position belonged to. */
  impactMarketId: string;
  /** Child market ID (CPY/CPN or EBY/EBN). */
  market: string;
  /** 20-byte owner address as hex. */
  owner: string;
  /** Position side at resolution: "Buy" = long, "Sell" = short. */
  side: string;
  /** Position size at resolution, integer lots. String to preserve BIGINT. */
  size: string;
  /** Weighted-average entry price of the resolved position. */
  entryPrice: string;
  /** Settlement price. conditional_settled → mark_price;
   *  prediction_settled → payoff_per_share (BINARY_PRICE_MAX winner, 0 loser);
   *  conditional_voided → "" (no mark; void path returns margin, no cash movement). */
  settlementPrice: string;
  /** Signed realized PnL in µUSDC. conditional_voided → "0". */
  realizedPnl: string;
  /** Block height at which the resolution landed. */
  blockHeight: number;
  /** Unix milliseconds. */
  timestamp: number;
}

/** One row of the per-user position-history snapshot log. Each entry is
 * a point-in-time snapshot of a position written after each fill that
 * changes its state (open → grow → reduce → close). When `size` is "0"
 * the snapshot represents a CLOSE event; the immediately preceding
 * non-zero snapshot for the same `(owner, market, side)` carries the
 * weighted-average entry price.
 *
 * Returned by `GET /v1/history/positions/{address}` and the
 * `historyPositions` InfoRequest. The HTTP endpoint accepts optional
 * `?market=&from=&to=&limit=` filters; results are newest-first. */
export interface HistoryPositionSnapshot {
  /** 20-byte owner address as hex. */
  owner: string;
  /** Market ID as a decimal string. */
  market: string;
  /** Position side: "Buy" = long, "Sell" = short. */
  side: string;
  /** Weighted-average entry price in µUSDC at the time of the snapshot. */
  entryPrice: string;
  /** Absolute position size in contracts. "0" = closed. */
  size: string;
  /** Block height at which the snapshot landed. */
  blockHeight: number;
  /** Unix milliseconds. */
  timestamp: number;
}

/** Full account information including balance, positions, and margin state. */
export interface AccountInfo {
  /** [0] Available USDC balance in microUSDC (6 dp, e.g., 100_000_000_000 = $100,000). */
  balance: bigint;
  /** [1] Open positions for this account. */
  positions: PositionInfo[];
  /** [2] Total equity (balance + unrealized PnL) in microUSDC (6 dp).
   * Scenario-aware: worst-case equity across all resolution outcomes. */
  equity: bigint;
  /** [3] Total maintenance margin requirement in microUSDC (6 dp).
   * Scenario-aware: max MM across all resolution outcomes. */
  totalMm: bigint;
  /** [4] Total initial margin requirement in microUSDC (6 dp). */
  totalIm: bigint;
  /** [5] Margin ratio in basis points (equity / total notional * 10000). */
  marginRatioBps: bigint;
  /** [6] Resolution scenario that maximizes totalMm — the "binding" outcome.
   * One entry per active impact market, ascending by impactMarketId.
   * Empty for perp-only accounts. Undefined on responses from gateways
   * older than 2026-04-24 (backward compat — the SDK decoder reads
   * msgpack arrays by index). See Jesse's P1 #3 in docs/api-scope.md. */
  bindingScenario?: BindingScenarioEntry[];
  /** [7] Cumulative trading fees paid (positive) or rebates received
   * (negative) by this account, in microUSDC. Updated atomically with
   * the fee debit at fill time. Powers the "lifetime trading cost"
   * line on the UI. New accounts read 0. Undefined on responses from
   * gateways predating 2026-05-03. BE-45. */
  feesAccrued?: bigint;
  /** [8] Rolling 30-day taker volume in microUSDC at the account's last
   * volume update. This is the value the engine uses to select market
   * fee tiers before the next fill. Undefined on older gateways. */
  volume30dMicroUsdc?: bigint;
}

/** Market kind discriminator. Wire shape mirrors the Rust `MarketKind`
 *  enum exactly: `"Perp"` is a bare string, the parameterised variants
 *  are `{ ConditionalPerp: [impactId, branch] }` /
 *  `{ PredictionBinary: [impactId, branch] }`. */
export type MarketKind =
  | "Perp"
  | { ConditionalPerp: [number, "Yes" | "No"] }
  | { PredictionBinary: [number, "Yes" | "No"] };

/** Mark-price source mode. Mirrors the engine's `MarkSourceMode` enum. */
export type MarkSourceMode = "OracleOnly" | "Median";

/** Configuration for a perpetual / conditional / binary market. The wire
 *  form is a MessagePack positional array; indices mirror the Rust struct
 *  field order in exchange-core/src/types.rs.
 *  Fields after index 7 use `#[serde(default)]` so older on-chain records
 *  decode cleanly. */
export interface MarketConfig {
  /** [0] Market identifier (unique integer). */
  market: number;
  /** [1] Initial margin requirement in basis points (e.g., 1000 = 10% = 10x max leverage). */
  imBps: number;
  /** [2] Maintenance margin requirement in basis points (e.g., 500 = 5%). */
  mmBps: number;
  /** [3] Taker fee rate in basis points (e.g., 5 = 0.05%). */
  takerFeeBps: number;
  /** [4] Maker fee rate in basis points (e.g., 2 = 0.02%). */
  makerFeeBps: number;
  /** [5] Funding interval in milliseconds (0 = funding disabled). */
  fundingIntervalMs: bigint;
  /** [6] Maximum absolute funding rate per interval in basis points. */
  maxFundingRateBps: number;
  /** [7] Market kind. Defaults to `"Perp"` for legacy records lacking this field. */
  kind?: MarketKind;
  /** [8] Per-account absolute position cap in contracts. 0 = no limit. */
  maxPositionSize?: bigint;
  /** [9] Default order TTL in ms. 0 = no TTL. */
  defaultTtlMs?: bigint;
  /** [10] Net-delta portfolio margin opt-in. */
  netDeltaMargin?: boolean;
  /** [11] Insurance-fund pool ID. Markets in different pools are insulated
   *  from each other's liquidation cascades. 0 = shared default pool. */
  poolId?: number;
  /** [12] Max oracle age (ms) before the engine refuses to read it. 0 = no check. */
  markPriceMaxOracleAgeMs?: bigint;
  /** [13] Volume-based fee tier table. Empty = flat taker/maker fees. */
  feeTiers?: FeeTier[];
  /** [14] Tick size in micro-USDC. 0 = no tick gate. */
  tickSize?: bigint;
  /** [15] Lot size in contracts. 0 = no lot gate. */
  lotSize?: bigint;
  /** [16] Primary oracle signer address (20 bytes). */
  primaryOracleSigner?: Address;
  /** [17] Oracle staleness window (ms) before fallback signers may publish. 0 = disabled. */
  oracleStalenessMs?: bigint;
  /** [18] Mark-price source mode. */
  markSourceMode?: MarkSourceMode;
  /** [19] Top-of-book spread cap (bps) for thin-book guard on Median mode. */
  maxMarkSpreadBps?: number;
  /** [20] Max age (ms) for composite-CEX price in Median mode. */
  cexCompositeStalenessMs?: bigint;
  /** [21] Enable partial liquidation (close per-market rather than all-or-nothing). */
  partialLiquidationEnabled?: boolean;
  /** [22] Published size scale: quantity is in units of 10^-szDecimals. */
  szDecimals?: number;
  /** [23] Human-readable ticker / short symbol (e.g. "BTC"). */
  ticker?: string;
  /** [24] Aggregate market open-interest cap in contracts. 0 = no cap. */
  maxOpenInterest?: bigint;
}

/** Per-tier fee schedule for the BE-47 volume-based maker-rebate program. */
export interface FeeTier {
  /** [0] Minimum 30-day rolling taker volume in micro-USDC. */
  min30dVolumeMicroUsdc: bigint;
  /** [1] Maker fee in tenth-basis-points. Negative = maker rebate. */
  makerFeeTenthBps: number;
  /** [2] Taker fee in tenth-basis-points. */
  takerFeeTenthBps: number;
}
