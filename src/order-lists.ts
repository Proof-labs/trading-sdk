/**
 * The list events of `PlaceOrders`, `CancelOrders` and `CancelClientOrders`,
 * decoded from the string attributes of one ABCI event: `orders_placed`
 * reports every placement outcome (each order of a `PlaceOrders`, each leg of
 * an `AtomicBasketOrder`, a cancel-replace's replacement), `orders_cancelled`
 * every order that left a book (or a requested cancel that removed nothing). The `orders` attribute
 * is a JSON array whose values are all strings. A malformed event throws; an
 * event of another type decodes to `null`.
 */

import { Attributes, U32_MAX, type AbciEventInput } from "./abci-event.js";
import { bytesToHex } from "./crypto.js";
import { decodeExecError, type ExecErrorInfo } from "./errors.js";
import { txEngineError, txOk } from "./tx-result.js";
import {
  Side,
  TimeInForce,
  type Action,
  type Address,
  type CancelReason,
  type TxResult,
} from "./types.js";

/** Why an order that never rested filled less than it requested; a later
 *  engine may add reasons. */
export type UnfilledReason =
  | "reduce_only_cap"
  | "self_trade"
  | "no_liquidity"
  | "margin_cap"
  | (string & {});

/** How one order of a `PlaceOrders` (or basket leg) ended. */
export type OrderPlacement =
  | {
      /** Accepted, with `quantity` left resting on the book. */
      outcome: "resting";
      market: number;
      clientOrderId: bigint | null;
      orderId: bigint;
      side: Side;
      price: bigint;
      /** The resting remainder. */
      quantity: bigint;
      timeInForce: TimeInForce;
      postOnly: boolean;
      reduceOnly: boolean;
    }
  | {
      /** Accepted and done without resting: filled in full, or an IOC or
       *  market order whose remainder was dropped. */
      outcome: "executed";
      market: number;
      clientOrderId: bigint | null;
      orderId: bigint;
      requestedQuantity: bigint;
      /** May be 0. */
      filledQuantity: bigint;
      /** Why less than requested filled; null when it all filled. */
      unfilled: UnfilledReason | null;
    }
  | {
      /** Refused for a trading reason; it wrote nothing. */
      outcome: "rejected";
      market: number;
      clientOrderId: bigint | null;
      /** The `ExecError` code, as a single order's transaction carried it. */
      code: number;
      error: ExecErrorInfo | null;
    };

/** The order a refused cancel named. */
export type CancelTarget = { orderId: bigint } | { clientOrderId: bigint };

/** One entry of an `orders_cancelled` event. */
export type OrderCancellation =
  | {
      /** The order left the book. */
      outcome: "cancelled";
      orderId: bigint;
      market: number;
      clientOrderId: bigint | null;
      /** Quantity originally accepted onto the book. */
      originalQuantity: bigint;
      /** Quantity still resting when the cancel occurred. */
      remainingQuantity: bigint;
      /** Maker quantity filled before the cancel. */
      filledQuantity: bigint;
    }
  | {
      /** A requested cancel that removed nothing. */
      outcome: "refused";
      target: CancelTarget;
      code: number;
      error: ExecErrorInfo | null;
    };

/** `orders_placed`: every order of one `PlaceOrders`, in the order sent. A
 *  cancel-replace emits one of one for its replacement. */
export interface OrdersPlacedEvent {
  type: "OrdersPlaced";
  /** Hex-encoded owner address. */
  owner: string;
  orders: OrderPlacement[];
}

/** `orders_cancelled`: orders that left `owner`'s book for `reason`, one
 *  event per action or cause. A `CancelOrders` or `CancelClientOrders` lists
 *  every entry in order, reason `user_requested`. */
export interface OrdersCancelledEvent {
  type: "OrdersCancelled";
  /** Hex-encoded owner address. */
  owner: string;
  /** One of {@link CancelReason}, or a reason a later engine adds. */
  reason: CancelReason | (string & {});
  orders: OrderCancellation[];
}

export type OrderListEvent = OrdersPlacedEvent | OrdersCancelledEvent;

/** What a `placeOrders` call did: the transaction, and each order's outcome
 *  in the order sent. `orders` is empty until the transaction has executed. */
export interface PlaceOrdersResult {
  tx: TxResult;
  orders: OrderPlacement[];
}

/** What a `cancelOrders` or `cancelClientOrders` call did, entry by entry.
 *  `orders` is empty until the transaction has executed. */
export interface CancelOrdersResult {
  tx: TxResult;
  orders: OrderCancellation[];
}

const SIDES: Record<string, Side> = { buy: Side.Buy, sell: Side.Sell };
const TIME_IN_FORCE: Record<string, TimeInForce> = {
  gtc: TimeInForce.Gtc,
  ioc: TimeInForce.Ioc,
  fok: TimeInForce.Fok,
};

/** Each entry of the `orders` JSON attribute, read with range checks. */
function entries(event: string, a: Attributes): Attributes[] {
  let list: unknown;
  try {
    list = JSON.parse(a.text("orders"));
  } catch {
    a.fail("orders", "is not JSON");
  }
  if (!Array.isArray(list)) a.fail("orders", "is not a JSON array");
  return list.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      a.fail(`orders[${index}]`, "is not an object");
    }
    return new Attributes(
      `${event}.orders[${index}]`,
      entry as Record<string, unknown>,
    );
  });
}

/** An optional id renders empty when absent. */
function optionalId(e: Attributes, key: string): bigint | null {
  return e.text(key) === "" ? null : e.u64(key);
}

function flag(e: Attributes, key: string): boolean {
  return e.oneOf(key, ["true", "false"] as const) === "true";
}

function code(e: Attributes): { code: number; error: ExecErrorInfo | null } {
  const value = e.u32("code");
  return { code: value, error: decodeExecError(value) };
}

function placement(e: Attributes): OrderPlacement {
  const market = Number(e.unsigned("market", U32_MAX));
  const clientOrderId = optionalId(e, "client_order_id");
  switch (e.oneOf("outcome", ["resting", "executed", "rejected"] as const)) {
    case "resting":
      return {
        outcome: "resting",
        market,
        clientOrderId,
        orderId: e.u64("order_id"),
        side: SIDES[e.oneOf("side", ["buy", "sell"] as const)],
        price: e.u64("price"),
        quantity: e.u64("quantity"),
        timeInForce:
          TIME_IN_FORCE[
            e.oneOf("time_in_force", ["gtc", "ioc", "fok"] as const)
          ],
        postOnly: flag(e, "post_only"),
        reduceOnly: flag(e, "reduce_only"),
      };
    case "executed":
      return {
        outcome: "executed",
        market,
        clientOrderId,
        orderId: e.u64("order_id"),
        requestedQuantity: e.u64("requested_quantity"),
        filledQuantity: e.u64("filled_quantity"),
        unfilled: e.text("unfilled") === "" ? null : e.label("unfilled"),
      };
    case "rejected":
      return { outcome: "rejected", market, clientOrderId, ...code(e) };
  }
}

function cancellation(e: Attributes): OrderCancellation {
  if (e.oneOf("outcome", ["cancelled", "refused"] as const) === "cancelled") {
    return {
      outcome: "cancelled",
      orderId: e.u64("order_id"),
      market: e.u32("market"),
      clientOrderId: optionalId(e, "client_order_id"),
      originalQuantity: e.u64("original_quantity"),
      remainingQuantity: e.u64("remaining_quantity"),
      filledQuantity: e.u64("filled_quantity"),
    };
  }
  const target: CancelTarget = e.has("order_id")
    ? { orderId: e.u64("order_id") }
    : { clientOrderId: e.u64("client_order_id") };
  return { outcome: "refused", target, ...code(e) };
}

/** Decode an `orders_placed` or `orders_cancelled` event; `null` for any
 *  other type. */
export function decodeOrderListEvent(
  event: AbciEventInput,
): OrderListEvent | null {
  if (event.type === "orders_placed") {
    const a = new Attributes(event.type, event.attributes);
    return {
      type: "OrdersPlaced",
      owner: a.owner("owner"),
      orders: entries(event.type, a).map(placement),
    };
  }
  if (event.type === "orders_cancelled") {
    const a = new Attributes(event.type, event.attributes);
    return {
      type: "OrdersCancelled",
      owner: a.owner("owner"),
      reason: a.label("reason"),
      orders: entries(event.type, a).map(cancellation),
    };
  }
  return null;
}

function listEvents(tx: TxResult, owner: Address): OrderListEvent[] {
  const hex = bytesToHex(owner);
  return (tx.events ?? [])
    .map(decodeOrderListEvent)
    .filter((e): e is OrderListEvent => e !== null && e.owner === hex);
}

/** Each order's outcome from the `orders_placed` event `owner`'s placement
 *  emitted in `tx`, in the order sent; empty when `tx` carries none. Reads an
 *  `AtomicBasketOrder`'s legs the same way, also when the basket failed (each
 *  leg `rejected` with the transaction's code). */
export function orderPlacements(
  tx: TxResult,
  owner: Address,
): OrderPlacement[] {
  const event = listEvents(tx, owner).find((e) => e.type === "OrdersPlaced");
  return event?.type === "OrdersPlaced" ? event.orders : [];
}

/** Each entry's outcome from the user-requested `orders_cancelled` event
 *  `owner`'s cancel emitted in `tx`; empty when `tx` carries none. */
export function orderCancellations(
  tx: TxResult,
  owner: Address,
): OrderCancellation[] {
  const event = listEvents(tx, owner).find(
    (e) => e.type === "OrdersCancelled" && e.reason === "user_requested",
  );
  return event?.type === "OrdersCancelled" ? event.orders : [];
}

/**
 * A single order or cancel is a list of one, and its refusal now arrives as
 * a rejected entry of a successful transaction. Report it as the engine error
 * the single action's transaction always carried, so callers of the single
 * actions see the same result. Every other result passes through.
 */
export function singleEntryRefusal(tx: TxResult, action?: Action): TxResult {
  if (!action || tx.outcome !== "ok") return tx;
  let entries: (OrderPlacement | OrderCancellation)[];
  try {
    if (action.type === "PlaceOrder" || action.type === "MarketOrder") {
      entries = orderPlacements(tx, action.data.owner);
    } else if (
      action.type === "CancelOrder" ||
      action.type === "CancelClientOrder"
    ) {
      entries = orderCancellations(tx, action.data.owner);
    } else {
      return tx;
    }
  } catch {
    // A committed result is never turned into an exception here.
    return tx;
  }
  const [refused] = entries;
  if (
    entries.length !== 1 ||
    (refused.outcome !== "rejected" && refused.outcome !== "refused")
  ) {
    return tx;
  }
  return txEngineError(refused.code, {
    hash: tx.hash,
    height: tx.height,
    log: tx.log,
    info: tx.info,
    events: tx.events,
  });
}

/** Code 35: a reduce-only order with no position (or on its side). */
const REDUCE_ONLY_REFUSED = 35;

/**
 * A close is a reduce-only market order; on a flat account the engine
 * refuses it with code 35. Report that as the successful no-op a close of a
 * flat position always was. Every other result passes through.
 */
export function closeNothingToClose(tx: TxResult): TxResult {
  if (tx.outcome !== "engine" || tx.code !== REDUCE_ONLY_REFUSED) return tx;
  return txOk({
    hash: tx.hash,
    height: tx.height,
    log: tx.log,
    info: tx.info,
    events: tx.events,
  });
}
