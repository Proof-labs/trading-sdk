/** Channels exposed by the gateway's multiplexed `/ws` feed. */
export type FeedChannel = "orderbook" | "trades" | "accountEvents";

/** One aggregated book level on the wire: `[price, totalQuantity, orderCount]`.
 *  Price is micro-USDC, quantity integer lots. */
export type FeedOrderbookLevel = [
  price: number,
  totalQuantity: number,
  orderCount: number,
];

/** Full-book frame sent immediately on `orderbook` subscribe. */
export interface OrderbookSnapshotFrame {
  channel: "orderbook";
  type: "snapshot";
  market: number;
  bids: FeedOrderbookLevel[];
  asks: FeedOrderbookLevel[];
}

/** Single-level delta on the `orderbook` channel. `totalQuantity === 0`
 *  (and `orderCount === 0`) means the level was emptied. */
export interface OrderbookUpdateFrame {
  channel: "orderbook";
  type: "update";
  market: number;
  side: "buy" | "sell";
  price: number;
  totalQuantity: number;
  orderCount: number;
}

export type OrderbookFrame = OrderbookSnapshotFrame | OrderbookUpdateFrame;

/** A public fill on the `trades` channel. Price/quantity are decimal
 *  strings (micro-USDC / lots); `payload` is the full fill record. */
export interface TradeFrame {
  channel: "trades";
  type: "trade";
  market: number;
  fillId: string;
  makerSide: "buy" | "sell";
  price: string;
  quantity: string;
  payload: Record<string, string>;
}

/** Account state snapshot sent on `accountEvents` subscribe, proxied from
 *  the node REST `GET /v1/account/{owner}`. `account.data` is the base64
 *  msgpack envelope — decode with the same path as `queryAccount`. */
export interface AccountSnapshotFrame {
  channel: "accountEvents";
  type: "snapshot";
  owner: string;
  account: unknown;
}

/** A live engine event for a subscribed owner. `type` is the gateway's
 *  normalised family (`"order_update"`, `"fill"`, …); `eventType` is the
 *  original engine event name (`"order_placed"`, `"trade_executed"`, …). */
export interface AccountEventFrame {
  channel: "accountEvents";
  type: string;
  eventType: string;
  owner: string;
  height: number;
  payload: Record<string, unknown>;
}

export type AccountFrame = AccountSnapshotFrame | AccountEventFrame;

/** Any channel-tagged data frame delivered to a subscriber. */
export type FeedFrame = OrderbookFrame | TradeFrame | AccountFrame;

/** Error frame for a rejected control message or channel subscription.
 *  Correlates to the offending request via `id` when present. */
export interface FeedErrorFrame {
  type: "error";
  id?: number;
  channel?: string;
  code?: number;
  error: string;
}

/** Connection state of a {@link GatewayFeed}. */
export type FeedState = "closed" | "connecting" | "open" | "reconnecting";
