/**
 * One owner's liquidation history from the gateway's
 * `GET /v1/history/liquidations/{owner}`: the owner's `position_liquidated`
 * and `liquidation_failed` rows, ordered by `(block_time, event_id)`, paged
 * by an opaque cursor. Each row's `payload` is the event's string attributes,
 * decoded with {@link decodeLiquidationEvent}.
 */

import { historySearchParams } from "./history.js";
import {
  decodeLiquidationEvent,
  type LiquidationFailedEvent,
  type PositionLiquidatedEvent,
} from "./liquidation-events.js";

/** The event types the route serves. */
export const LIQUIDATION_HISTORY_EVENT_TYPES = [
  "position_liquidated",
  "liquidation_failed",
] as const;

export type LiquidationHistoryEventType =
  (typeof LIQUIDATION_HISTORY_EVENT_TYPES)[number];

/** Query parameters. Keep every one fixed while following `cursor`. */
export interface LiquidationHistoryFilters {
  /** Direction by `(block_time, event_id)`; the gateway's default is `desc`. */
  order?: "asc" | "desc";
  /** Inclusive lower bound on block time, Unix epoch milliseconds. */
  fromMs?: number;
  /** Exclusive upper bound on block time, Unix epoch milliseconds. */
  toMs?: number;
  /** Page size, 1 to 5000. */
  limit?: number;
  /** A previous page's non-empty `nextCursor`. */
  cursor?: string;
}

/** One liquidation event in the owner's history. */
export interface LiquidationHistoryRow {
  /** The indexer's row id, not shared with live delivery. */
  eventId: bigint;
  /** Lowercase 40-hex address without `0x`. */
  owner: string;
  blockHeight: number;
  /** RFC3339 block time as served, nanoseconds kept. */
  blockTime: string;
  txHash: string;
  eventIndex: number;
  /** The event's position key, when the row carries it. */
  eventKey: string | null;
  eventType: LiquidationHistoryEventType;
  event: PositionLiquidatedEvent | LiquidationFailedEvent;
}

export interface LiquidationHistoryPage {
  liquidations: LiquidationHistoryRow[];
  /** Pass back as `cursor` for the next page; empty on the last page. */
  nextCursor: string;
}

function fail(problem: string): never {
  throw new Error(`liquidation history decode: ${problem}`);
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

/** A row id as a JSON integer, or as a decimal string when it exceeds 2^53. */
function eventId(value: unknown): bigint {
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    return BigInt(value);
  }
  return BigInt(count(value, "event_id"));
}

function blockTime(value: unknown): string {
  const raw = text(value, "block_time");
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(raw) ||
    !Number.isFinite(Date.parse(raw))
  ) {
    fail("block_time must be an RFC3339 UTC timestamp");
  }
  return raw;
}

/** Query string for the route; the time, page and cursor rules are the
 *  other `/v1/history/*` reads'. */
export function liquidationHistorySearchParams(
  filters: LiquidationHistoryFilters = {},
): URLSearchParams {
  const params = historySearchParams(filters);
  if (filters.order !== undefined) {
    if (filters.order !== "asc" && filters.order !== "desc") {
      throw new Error("Invalid history order");
    }
    params.set("order", filters.order);
  }
  return params;
}

/** Decode one page for `owner` (lowercase 40 hex). A row for another owner,
 *  of another event type, or with a malformed payload throws. */
export function decodeLiquidationHistoryPage(
  value: unknown,
  owner: string,
): LiquidationHistoryPage {
  const page = object(value, "page");
  if (!Array.isArray(page.liquidations)) fail("liquidations must be an array");
  const nextCursor = text(page.next_cursor, "next_cursor");
  const liquidations = page.liquidations.map((value, index) => {
    const row = object(value, `liquidations[${index}]`);
    if (row.owner !== owner) fail(`liquidations[${index}] is another owner's`);
    const eventType = text(row.event_type, "event_type");
    if (
      !(LIQUIDATION_HISTORY_EVENT_TYPES as readonly string[]).includes(
        eventType,
      )
    ) {
      fail(`liquidations[${index}] has event_type "${eventType}"`);
    }
    const payload = object(row.payload, `liquidations[${index}].payload`);
    const event = decodeLiquidationEvent({
      type: eventType,
      attributes: payload,
    }) as PositionLiquidatedEvent | LiquidationFailedEvent;
    if (event.owner !== owner) {
      fail(`liquidations[${index}].payload names another owner`);
    }
    return {
      eventId: eventId(row.event_id),
      owner,
      blockHeight: count(row.block_height, "block_height"),
      blockTime: blockTime(row.block_time),
      txHash: text(row.tx_hash, "tx_hash"),
      eventIndex: count(row.event_index, "event_index"),
      eventKey:
        payload.event_key === undefined
          ? null
          : text(payload.event_key, "payload.event_key"),
      eventType: eventType as LiquidationHistoryEventType,
      event,
    };
  });
  return { liquidations, nextCursor };
}
