/** 20-byte account address (derived from Ed25519 public key). */
export type Address = Uint8Array;

/** Order side. */
export enum Side {
  /** Buy / long. */
  Buy = 1,
  /** Sell / short. */
  Sell = 2,
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
  /** Limit price in cents (2 decimal places, e.g., 6675234 = $66,752.34). */
  price: bigint;
  /** Order quantity in contracts (integer lots). */
  quantity: bigint;
  /** Optional client-assigned order ID for tracking. */
  clientOrderId?: bigint | null;
}

/** Cancel an existing resting order by its engine-assigned ID. */
export interface CancelOrder {
  /** Engine-assigned order ID to cancel. */
  orderId: bigint;
  /** Account address of the order owner (20 bytes). Must match the order's owner. */
  owner: Address;
}

/** Submit an oracle price update for a market (relayer only). */
export interface OracleUpdate {
  /** Market identifier to update. */
  market: number;
  /** New oracle price in cents (2 decimal places, e.g., 6675234 = $66,752.34). */
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
 * Fields deliberately absent from this update path: `im_bps`,
 * `mm_bps`, `kind`. Changing them on a live market would require
 * re-margining every open position, out of scope here.
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

/** Discriminated union of all exchange actions. */
export type Action =
  | { type: "PlaceOrder"; data: PlaceOrder }
  | { type: "CancelOrder"; data: CancelOrder }
  | { type: "OracleUpdate"; data: OracleUpdate }
  | { type: "MarketOrder"; data: MarketOrder }
  | { type: "Deposit"; data: Deposit }
  | { type: "Withdraw"; data: Withdraw }
  | { type: "CreateMarket"; data: CreateMarket }
  | { type: "WithdrawRequest"; data: WithdrawRequest }
  | { type: "ConfirmDeposit"; data: ConfirmDeposit }
  | { type: "ConfirmWithdrawal"; data: ConfirmWithdrawal }
  | { type: "FailWithdrawal"; data: FailWithdrawal }
  | { type: "ApproveAgent"; data: ApproveAgent }
  | { type: "RevokeAgent"; data: RevokeAgent }
  | { type: "CreateImpactMarket"; data: CreateImpactMarket }
  | { type: "ResolveEvent"; data: ResolveEvent }
  | { type: "UpdateMarketFees"; data: UpdateMarketFees };

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
  /** Limit price in cents (2 dp, e.g., "6675234" = $66,752.34). */
  price: string;
  /** Order quantity in contracts (integer lots). */
  quantity: string;
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
}

/** Emitted when a trade (fill) is executed between a maker and taker. */
export interface TradeExecutedEvent {
  type: "TradeExecuted";
  /** Unique fill identifier. */
  fillId: string;
  /** Market identifier. */
  market: string;
  /** Execution price in cents (2 dp). */
  price: string;
  /** Fill quantity in contracts (integer lots). */
  quantity: string;
  /** Engine-assigned order ID of the resting (maker) order. */
  makerOrderId: string;
  /** Hex-encoded maker address. */
  makerOwner: string;
  /** Maker's side ("Buy" or "Sell"). */
  makerSide: string;
  /** Hex-encoded taker address. */
  takerOwner: string;
  /** Taker fee in microUSDC (signed; positive = paid, negative = rebate). */
  takerFee: string;
  /** Maker fee in microUSDC (signed; positive = paid, negative = rebate). */
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
  /** Weighted-average entry price in cents (2 dp). */
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
  /** New oracle price in cents (2 dp). */
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
  /** Mark price at liquidation in cents (2 dp). */
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
  | MarketOrderProcessedEvent;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Result of submitting a transaction to the exchange. */
export interface TxResult {
  /** Status code (0 = success, non-zero = error code from ExecError). */
  code: number;
  /** Transaction hash (hex-encoded). */
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
  /** Price in cents (2 dp, e.g., 6675234 = $66,752.34). */
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

/** One row of the auto-deleveraging queue for a market. Returned
 *  sorted by `adlScore` desc (front of the queue first). Used by the
 *  trading UI to compute a real per-position ADL percentile rather
 *  than relying on the per-account score alone.
 *
 *  Wire shape: 6-tuple `[owner, market, side, size, upnlNow, adlScore]`.
 *  Endpoint: `GET /v1/adl/queue/{market}`. Added 2026-04-25 with the
 *  Tier-3 ADL force-close path.
 */
export interface AdlQueueEntry {
  /** 20-byte owner address. */
  owner: Uint8Array;
  market: number;
  /** Position side: "Buy" = long, "Sell" = short. */
  side: "Buy" | "Sell";
  /** Position size in contracts. */
  size: bigint;
  /** Unrealized PnL at the current mark, signed. Always positive
   *  here (only profitable positions are queued). */
  upnlNow: bigint;
  /** `max(0, upnlNow) × leverage_bps`. Higher = closer to the front
   *  of the ADL queue. Tied with `PositionInfo.adlScore` for the
   *  same position. */
  adlScore: bigint;
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
  /** [3] Weighted-average entry price in cents (2 dp). */
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

/** One-round-trip market summary for the Markets-page card rail and
 * Perp trade ticker bar. Bundles trade-derived summary stats (from
 * history.db, JSON) with pass-through base64 msgpack blobs for
 * funding + orderbook top-of-book.
 *
 * Returned by `GET /v1/ticker/{market}` and the `ticker` InfoRequest.
 * Sprint 2 Day 5 (Jesse's P2 #4). */
export interface Ticker {
  /** Market id as decimal string. */
  market: string;
  /** Last fill price in the 24h window (empty/"0" if no trades). */
  lastPrice: string;
  /** Σ quantity across the 24h window (integer contracts). */
  volume24hContracts: string;
  /** Signed 24h change in basis points. Empty/"0" if no trades. */
  change24hBps: string;
  /** Base64 msgpack FundingInfo (mark EWMA, oracle, funding rate,
   * interval). Decode with @msgpack/msgpack. */
  fundingMsgpackB64: string;
  /** Base64 msgpack OrderbookSnapshot at depth=1. Empty for fresh
   * markets with no orders. */
  orderbookMsgpackB64: string;
  /** Always null today — the engine doesn't track open interest yet.
   * UIs should render "—" / "coming soon" for this column. */
  openInterest: string | null;
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
}

/** Market kind discriminator. Wire shape mirrors the Rust `MarketKind`
 *  enum exactly: `"Perp"` is a bare string, the parameterised variants
 *  are `{ ConditionalPerp: [impactId, branch] }` /
 *  `{ PredictionBinary: [impactId, branch] }`. */
export type MarketKind =
  | "Perp"
  | { ConditionalPerp: [number, "Yes" | "No"] }
  | { PredictionBinary: [number, "Yes" | "No"] };

/** Configuration for a perpetual / conditional / binary market. The wire
 *  form is a MessagePack positional array; indices below mirror the
 *  Rust struct field order in exchange-core/src/types.rs.
 *  Fields 7–10 were appended 2026-04-23..25 with `#[serde(default)]`
 *  so older on-chain records decode unchanged. */
export interface MarketConfig {
  /** [0] Market identifier (unique integer). */
  market: number;
  /** [1] Initial margin requirement in basis points (e.g., 1000 = 10% = 10x max leverage). */
  imBps: number;
  /** [2] Maintenance margin requirement in basis points (e.g., 500 = 5%). */
  mmBps: number;
  /** [3] Taker fee rate in basis points (e.g., 5 = 0.05%). */
  takerFeeBps: number;
  /** [4] Maker fee rate in basis points (e.g., 2 = 0.02%). Negative = rebate. */
  makerFeeBps: number;
  /** [5] Funding interval in milliseconds (0 = funding disabled). */
  fundingIntervalMs: bigint;
  /** [6] Maximum absolute funding rate per interval in basis points. */
  maxFundingRateBps: number;
  /** [7] Market kind. Defaults to `"Perp"` for legacy records lacking
   *  this field. */
  kind?: MarketKind;
  /** [8] Per-account absolute position cap in contracts. 0 = no limit
   *  (also the legacy default). Enforced at order-placement time —
   *  fills that would push a taker's net (signed) position past
   *  ±maxPositionSize are rejected with `PositionLimitExceeded`. */
  maxPositionSize?: bigint;
  /** [9] Default order TTL in ms. End-of-block `run_order_expiry`
   *  cancels any resting order whose
   *  `created_at_ms + defaultTtlMs < block_time_ms`. 0 disables TTL. */
  defaultTtlMs?: bigint;
  /** [10] Net-delta portfolio margin opt-in. true = firing legs that
   *  share an underlying are aggregated into a single net position
   *  for MM/IM. PredictionBinary legs ignore this flag. See
   *  docs/margin-engine.md §6 for the derivation. */
  netDeltaMargin?: boolean;
}
