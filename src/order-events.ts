/**
 * Typed decoders for the engine's order events, from the string attributes
 * of one ABCI event: a transaction's `TxEvent`, or a payload the indexer or
 * the account feed carries verbatim.
 *
 * A u64 or i64 decodes to `bigint`. A client order id the engine writes as
 * `0` for absent decodes to `null`. Attributes these decoders do not name,
 * such as the chain coordinates, are ignored. A malformed event throws; an
 * event of another type decodes to `null`.
 */

import {
  type AbciEventInput,
  type Attributes,
  type EventSide,
  SIDES,
  decodeWith,
} from "./event-attributes.js";

export const TIMES_IN_FORCE = ["gtc", "ioc", "fok"] as const;

export type EventTimeInForce = (typeof TIMES_IN_FORCE)[number];

/** Why a never-resting order filled less than it requested. */
export const UNFILLED_REASONS = [
  "reduce_only_cap",
  "self_trade",
  "no_liquidity",
] as const;

export type UnfilledReason = (typeof UNFILLED_REASONS)[number];

/**
 * One fill between a resting maker order and a taker. `markPrice` is the
 * mark in force when the taker crossed, `oraclePrice` the stored oracle
 * price; either is `null` when the market had none, or for fills recorded
 * before the engine reported them.
 */
export interface DecodedTradeExecutedEvent {
  type: "TradeExecuted";
  fillId: bigint;
  market: number;
  price: bigint;
  quantity: bigint;
  makerOrderId: bigint;
  makerClientOrderId: bigint | null;
  makerOwner: string;
  makerSide: EventSide;
  takerOrderId: bigint;
  takerOwner: string;
  takerClientOrderId: bigint | null;
  /** Positive is charged, negative is a rebate. */
  takerFee: bigint;
  /** Positive is charged, negative is a rebate. */
  makerFee: bigint;
  markPrice: bigint | null;
  oraclePrice: bigint | null;
}

/**
 * The end of an order that never rests: a market order, a position close,
 * or an IOC or FOK limit order. `unfilledReason` is `null` when the whole
 * request filled. `limitPrice` is `null` for a market order or position
 * close.
 */
export interface DecodedMarketOrderProcessedEvent {
  type: "MarketOrderProcessed";
  orderId: bigint;
  market: number;
  owner: string;
  side: EventSide;
  requestedQuantity: bigint;
  filledQuantity: bigint;
  clientOrderId: bigint | null;
  timeInForce: EventTimeInForce;
  limitPrice: bigint | null;
  unfilledReason: UnfilledReason | null;
}

/** The engine refused an order for a trading reason; `code` is the
 *  `ExecError` code (see `decodeExecError`). */
export interface OrderRejectedEvent {
  type: "OrderRejected";
  owner: string;
  market: number;
  clientOrderId: bigint | null;
  code: number;
}

export type OrderEvent =
  | DecodedTradeExecutedEvent
  | DecodedMarketOrderProcessedEvent
  | OrderRejectedEvent;

function tradeExecuted(a: Attributes): DecodedTradeExecutedEvent {
  return {
    type: "TradeExecuted",
    fillId: a.u64("fill_id"),
    market: a.u32("market"),
    price: a.u64("price"),
    quantity: a.u64("quantity"),
    makerOrderId: a.u64("maker_order_id"),
    makerClientOrderId: a.nonZeroU64("maker_client_order_id"),
    makerOwner: a.owner("maker_owner"),
    makerSide: a.oneOf("maker_side", SIDES),
    takerOrderId: a.u64("taker_order_id"),
    takerOwner: a.owner("taker_owner"),
    takerClientOrderId: a.nonZeroU64("taker_client_order_id"),
    takerFee: a.i64("taker_fee"),
    makerFee: a.i64("maker_fee"),
    markPrice: a.optionalU64("mark_price"),
    oraclePrice: a.optionalU64("oracle_price"),
  };
}

function marketOrderProcessed(a: Attributes): DecodedMarketOrderProcessedEvent {
  return {
    type: "MarketOrderProcessed",
    orderId: a.u64("order_id"),
    market: a.u32("market"),
    owner: a.owner("owner"),
    side: a.oneOf("side", SIDES),
    requestedQuantity: a.u64("requested_quantity"),
    filledQuantity: a.u64("filled_quantity"),
    clientOrderId: a.nonZeroU64("client_order_id"),
    // Summaries from before the field existed were all market orders.
    timeInForce: a.optionalOneOf("time_in_force", TIMES_IN_FORCE) ?? "ioc",
    limitPrice: a.optionalU64("limit_price"),
    unfilledReason: a.optionalOneOf("unfilled_reason", UNFILLED_REASONS),
  };
}

function orderRejected(a: Attributes): OrderRejectedEvent {
  return {
    type: "OrderRejected",
    owner: a.owner("owner"),
    market: a.u32("market"),
    clientOrderId: a.optionalU64("client_order_id"),
    code: a.u32("code"),
  };
}

const DECODERS: Record<string, (a: Attributes) => OrderEvent> = {
  trade_executed: tradeExecuted,
  market_order_processed: marketOrderProcessed,
  order_rejected: orderRejected,
};

/**
 * Decode `trade_executed`, `market_order_processed` or `order_rejected`
 * from its ABCI type and string attributes. Returns `null` for any other
 * event type, so a caller can run it over every event of a transaction or
 * block.
 */
export function decodeOrderEvent(event: AbciEventInput): OrderEvent | null {
  return decodeWith(DECODERS, event);
}
