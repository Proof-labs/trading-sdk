import { GatewayHttpError, GatewayReadError } from "./errors.js";
import {
  decodeVoidSettlementEvent,
  type EventVoidedEvent,
} from "./void-events.js";

export interface EventVoidedQueryOptions {
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
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
  const base = `${gatewayUrl.replace(/\/+$/, "")}/v1/history/admin-events`;
  let cursor = "";
  for (;;) {
    signal?.throwIfAborted();
    const params = new URLSearchParams({
      event_type: "event_voided",
      limit: "1000",
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
    const found = findEventVoided(page.admin_events, eventId);
    if (found) return found;
    const next = page.next_cursor;
    if (typeof next !== "string" || next === "") return null;
    if (next === cursor)
      throw new GatewayReadError(
        "limit",
        "next_cursor",
        "admin-events cursor did not advance",
      );
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
