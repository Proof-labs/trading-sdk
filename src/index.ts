// Types
export {
  type Address,
  Side,
  ActionType,
  type ActionTypeValue,
  type Action,
  PRIMARY_ORACLE_CLEAR_SENTINEL,
  type PlaceOrder,
  type CancelOrder,
  type OracleUpdate,
  type MarketOrder,
  type Deposit,
  type Withdraw,
  type CreateMarket,
  type WithdrawRequest,
  type ConfirmDeposit,
  type ConfirmWithdrawal,
  type FailWithdrawal,
  type FailDeposit,
  type FailDepositReason,
  type ApproveAgent,
  type RevokeAgent,
  type CreateImpactMarket,
  type EventOracleSource,
  type PriceComparison,
  type ResolveEvent,
  type ImpactMarketInfo,
  type ImpactMarketStatus,
  Branch,
  Outcome,
  type TxResult,
  type TxEvent,
  type ExchangeEvent,
  type OrderPlacedEvent,
  type OrderCancelledEvent,
  type TradeExecutedEvent,
  type PositionUpdatedEvent,
  type PositionClosedEvent,
  type PriceUpdatedEvent,
  type FundingAppliedEvent,
  type FundingSettledEvent,
  type AccountLiquidatedEvent,
  type MarketCreatedEvent,
  type Orderbook,
  type OrderbookLevel,
  type AccountInfo,
  type PositionInfo,
  type MarketConfig,
  type AdlQueueEntry,
} from "./types.js";

// Codec
export {
  encodeTx,
  encodeTxV2,
  signAndEncode,
  decodeTx,
  peekActionType,
} from "./codec.js";
export { fetchChainId } from "./client.js";

/**
 * BE-46.1 sentinel value for `SetAccountFeeOverride.{takerFeeBps, makerFeeBps}`
 * meaning "this side reverts to the market's base fee at fill time."
 *
 * The engine accepts u32::MAX (= 4_294_967_295) past the normal
 * `[0, 10_000]` bps range check as the explicit "fall back to market
 * base" signal. Use it on either side independently — e.g.
 * `takerFeeBps: 1, makerFeeBps: FEE_OVERRIDE_REVERT_SENTINEL` keeps
 * the override on the taker side and reverts the maker side to the
 * market's `maker_fee_bps`.
 *
 * Setting both sides to this sentinel is the documented way to clear
 * an override entirely without a dedicated `Clear` action (BE-46 MVP
 * intentionally has no such action).
 *
 * The constant is exported as a `number` rather than `bigint` because
 * `SetAccountFeeOverride.{takerFeeBps, makerFeeBps}` are `number`
 * fields — assigning a `bigint` would be a type error.
 */
export const FEE_OVERRIDE_REVERT_SENTINEL = 4_294_967_295;

// Error decoder
export {
  type ExecErrorInfo,
  decodeExecError,
  execErrorName,
} from "./errors.js";

// Crypto
export {
  generateKeypair,
  getPublicKey,
  pubkeyToOwner,
  ownerToHex,
  hexToBytes,
  bytesToHex,
  signingMessage,
  sign,
  verify,
  chainIdFromString,
  UNBOUND_CHAIN_ID,
} from "./crypto.js";

// Client
export { ExchangeClient, type ExchangeClientOptions } from "./client.js";
