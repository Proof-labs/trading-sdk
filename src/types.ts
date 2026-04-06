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

/** Credit USDC to an account (legacy action, prefer ConfirmDeposit). */
export interface Deposit {
  /** Account address to credit (20 bytes). */
  owner: Address;
  /** Deposit amount in microUSDC (6 decimal places, e.g., 100_000_000 = $100). */
  amount: bigint;
}

/** Debit USDC from an account (direct withdraw, checks margin requirements). */
export interface Withdraw {
  /** Account address to debit (20 bytes). */
  owner: Address;
  /** Withdrawal amount in microUSDC (6 decimal places, e.g., 100_000_000 = $100). */
  amount: bigint;
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
  | { type: "RevokeAgent"; data: RevokeAgent };

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

/** Information about a single open position. */
export interface PositionInfo {
  /** Owner address (20 bytes). */
  owner: Uint8Array;
  /** Market identifier. */
  market: number;
  /** Position side: "Buy" (long) or "Sell" (short). */
  side: "Buy" | "Sell";
  /** Weighted-average entry price in cents (2 dp). */
  entryPrice: bigint;
  /** Absolute position size in contracts (integer lots). */
  size: bigint;
  /** Cumulative funding index at the time the position was last settled. */
  lastFundingIndex: bigint;
}

/** Full account information including balance, positions, and margin state. */
export interface AccountInfo {
  /** Available USDC balance in microUSDC (6 dp, e.g., 100_000_000_000 = $100,000). */
  balance: bigint;
  /** Open positions for this account. */
  positions: PositionInfo[];
  /** Total equity (balance + unrealized PnL) in microUSDC (6 dp). */
  equity: bigint;
  /** Total maintenance margin requirement in microUSDC (6 dp). */
  totalMm: bigint;
  /** Total initial margin requirement in microUSDC (6 dp). */
  totalIm: bigint;
  /** Margin ratio in basis points (equity / total notional * 10000). */
  marginRatioBps: bigint;
}

/** Configuration for a perpetual futures market. */
export interface MarketConfig {
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
  /** Funding interval in milliseconds (0 = funding disabled). */
  fundingIntervalMs: bigint;
  /** Maximum absolute funding rate per interval in basis points. */
  maxFundingRateBps: number;
}
