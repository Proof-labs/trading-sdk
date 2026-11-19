import { GatewayHttpError, GatewayReadError } from "./errors.js";
import {
  decodeVoidSettlementEvent,
  type EventVoidedEvent,
} from "./void-events.js";

/** Pages of 1000 `event_voided` records read before giving up: 100,000 Voids. */
const DEFAULT_MAX_PAGES = 100;
const PAGE_SIZE = 1000;

export interface EventVoidedQueryOptions {
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  /** Admin-events pages read before the walk fails with a `limit`
   *  `GatewayReadError`; default 100 (100,000 Voids). */
  maxPages?: number;
}

/** The indexed `event_voided` record for `eventId`, or `null` when the event
 * has not been voided (or the indexer has not ingested it yet). Walks
 * `GET /v1/history/admin-events?event_type=event_voided` pages via
 * `next_cursor` until the record is found or history is exhausted: the route
 * cannot filter by event. */
export async function queryEventVoided(
  gatewayUrl: string,
  eventId: number,
  options: EventVoidedQueryOptions = {},
): Promise<EventVoidedEvent | null> {
  if (!Number.isSafeInteger(eventId) || eventId < 0 || eventId > 0xffff_ffff) {
    throw new GatewayReadError(
      "configuration",
      "eventId",
      "Invalid event id: must be a uint32",
    );
  }
  const { signal } = options;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new GatewayReadError(
      "configuration",
      "maxPages",
      "Invalid maxPages: must be a positive integer",
    );
  }
  const base = `${gatewayUrl.replace(/\/+$/, "")}/v1/history/admin-events`;
  let cursor = "";
  const seen = new Set<string>();
  for (let pageIndex = 0; ; pageIndex++) {
    if (pageIndex >= maxPages)
      throw new GatewayReadError(
        "limit",
        "next_cursor",
        `admin-events history holds more than ${maxPages} pages`,
      );
    signal?.throwIfAborted();
    const params = new URLSearchParams({
      event_type: "event_voided",
      limit: String(PAGE_SIZE),
    });
    if (cursor) params.set("cursor", cursor);
    const response = await (options.fetch ?? globalThis.fetch)(
      `${base}?${params}`,
      { method: "GET", signal },
    );
    if (!response.ok) throw new GatewayHttpError(response.status, response);
    const body: unknown = await response.json();
    signal?.throwIfAborted();
    const page =
      typeof body === "object" && body !== null
        ? (body as { admin_events?: unknown; next_cursor?: unknown })
        : {};
    if (!Array.isArray(page.admin_events))
      throw new GatewayReadError(
        "malformed",
        "admin_events",
        "Invalid admin-events page",
      );
    // A page without a string cursor is malformed, never the end of history:
    // reading it as "no more pages" would report a voided event as not voided.
    const next = page.next_cursor;
    if (typeof next !== "string")
      throw new GatewayReadError(
        "malformed",
        "next_cursor",
        "Invalid admin-events page: next_cursor is not a string",
      );
    const found = findEventVoided(page.admin_events, eventId);
    if (found) return found;
    if (next === "") return null;
    // A cursor seen before means the upstream is cycling; following it would
    // never end.
    if (seen.has(next))
      throw new GatewayReadError(
        "limit",
        "next_cursor",
        "admin-events cursor repeated",
      );
    seen.add(next);
    cursor = next;
  }
}

function findEventVoided(
  rows: unknown[],
  eventId: number,
): EventVoidedEvent | null {
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const { event_type: type, payload } = row as {
      event_type?: unknown;
      payload?: unknown;
    };
    if (type !== "event_voided" || typeof payload !== "object" || !payload)
      continue;
    // Match on the raw attribute first so another event's malformed record
    // cannot fail this read.
    if (
      String((payload as Record<string, unknown>).event_id) !== String(eventId)
    )
      continue;
    const decoded = decodeVoidSettlementEvent({
      type,
      attributes: payload as Record<string, unknown>,
    });
    if (decoded?.type === "EventVoided") return decoded;
  }
  return null;
}
