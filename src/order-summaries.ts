/**
 * One owner's fills grouped into one row per order, from the gateway's
 * `GET /v1/history/order-summaries/{owner}`: newest last fill first, paged by
 * an opaque cursor, optionally restricted to a list of markets.
 */

import { historySearchParams } from "./history.js";

/** The most markets one read may name. */
export const ORDER_SUMMARY_MAX_MARKETS = 200;

/** Query parameters. Keep every one fixed while following `cursor`. */
export interface OrderSummaryFilters {
  /** Market ids to read; omit for every market. At most 200. */
  markets?: readonly number[];
  /** Inclusive lower bound on fill time, Unix epoch milliseconds. */
  fromMs?: number;
  /** Exclusive upper bound on fill time, Unix epoch milliseconds. A cursor
   *  walk is pinned to its first page's height, so fills arriving mid-walk
   *  cannot skip an order. */
  toMs?: number;
  /** Page size, 1 to 5000. */
  limit?: number;
  /** A previous page's non-empty `nextCursor`. */
  cursor?: string;
}

/** One order's fills inside the requested window. */
export interface OrderSummary {
  orderId: bigint;
  market: number;
  /** The owner's side. */
  side: "buy" | "sell";
  /** Summed fill quantity, integer lots. */
  filledQuantity: bigint;
  /** `notional / filledQuantity` in micro-USDC, a decimal string rounded to
   *  six places; `null` when nothing filled. */
  avgPrice: string | null;
  /** Σ price × quantity (micro-USDC × lots), an exact decimal string. */
  notional: string;
  /** The owner's signed fee sum in micro-USDC; negative is a rebate. */
  fees: bigint;
  /** RFC3339 block times of the first and last fill, as served. */
  firstFillTime: string;
  lastFillTime: string;
  fillCount: number;
}

export interface OrderSummaryPage {
  orders: OrderSummary[];
  /** Pass back as `cursor` for the next page; empty on the last page. */
  nextCursor: string;
}

function fail(problem: string): never {
  throw new Error(`order summaries decode: ${problem}`);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string") fail(`${name} must be a string`);
  return value;
}

function count(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${name} must be a non-negative safe integer`);
  }
  return value as number;
}

function integer(value: unknown, name: string, signed = false): bigint {
  const raw = text(value, name);
  if (!(signed ? /^-?(0|[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/).test(raw)) {
    fail(`${name} must be a${signed ? "n" : " non-negative"} integer string`);
  }
  return BigInt(raw);
}

function decimal(value: unknown, name: string): string {
  const raw = text(value, name);
  if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(raw)) {
    fail(`${name} must be a decimal string`);
  }
  return raw;
}

function time(value: unknown, name: string): string {
  const raw = text(value, name);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(raw) ||
    !Number.isFinite(Date.parse(raw))
  ) {
    fail(`${name} must be an RFC3339 UTC timestamp`);
  }
  return raw;
}

/** Query string for the route: the shared time, page and cursor rules plus
 *  `markets`, sorted and deduplicated. */
export function orderSummarySearchParams(
  filters: OrderSummaryFilters = {},
): URLSearchParams {
  const params = historySearchParams(filters);
  if (filters.markets !== undefined) {
    const markets = [...new Set(filters.markets)].sort((a, b) => a - b);
    if (
      markets.length === 0 ||
      markets.length > ORDER_SUMMARY_MAX_MARKETS ||
      markets.some((m) => !Number.isInteger(m) || m < 0 || m > 0x7fffffff)
    ) {
      throw new Error("Invalid order summary markets");
    }
    params.set("markets", markets.join(","));
  }
  return params;
}

/** Decode one page. A malformed row throws rather than being skipped. */
export function decodeOrderSummaryPage(value: unknown): OrderSummaryPage {
  const page = object(value, "page");
  if (!Array.isArray(page.orders)) fail("orders must be an array");
  const nextCursor = text(page.next_cursor, "next_cursor");
  const orders = page.orders.map((value, index): OrderSummary => {
    const at = `orders[${index}]`;
    const row = object(value, at);
    const side = text(row.side, `${at}.side`);
    if (side !== "buy" && side !== "sell") {
      fail(`${at}.side must be "buy" or "sell"`);
    }
    return {
      orderId: integer(row.order_id, `${at}.order_id`),
      market: count(row.market, `${at}.market`),
      side,
      filledQuantity: integer(row.filled_quantity, `${at}.filled_quantity`),
      avgPrice:
        row.avg_price === null
          ? null
          : decimal(row.avg_price, `${at}.avg_price`),
      notional: decimal(row.notional, `${at}.notional`),
      fees: integer(row.fees, `${at}.fees`, true),
      firstFillTime: time(row.first_fill_time, `${at}.first_fill_time`),
      lastFillTime: time(row.last_fill_time, `${at}.last_fill_time`),
      fillCount: count(row.fill_count, `${at}.fill_count`),
    };
  });
  return { orders, nextCursor };
}
