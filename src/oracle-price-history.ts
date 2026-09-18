import { GatewayHttpError } from "./errors.js";

export interface OraclePriceHistoryPoint {
  /** Chain block time (RFC3339), not the feeder's source publish time. */
  t: string;
  /** Indexed oracle price in micro-USDC, without precision loss. */
  p: string;
  eventId: string;
}

export interface OraclePriceHistoryPage {
  market: number;
  points: OraclePriceHistoryPoint[];
  nextCursor: string;
}

export interface OraclePriceHistoryOptions {
  /** Inclusive start and exclusive end, in epoch milliseconds. */
  fromMs: number;
  toMs: number;
  /** Admin-event page size, before filtering by market (1–1000). */
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

/** One newest-first page of indexed price_updated events from the gateway.
 * Primary and composite updates share this event shape; this endpoint cannot
 * distinguish their sources, so the page is not a primary-only price series.
 * Keep market and bounds fixed across cursors; an empty filtered page can
 * still have a next cursor. Aggregation and complete-range pagination belong
 * to the caller. */
export async function queryOraclePriceHistoryPage(
  gatewayUrl: string,
  market: number,
  options: OraclePriceHistoryOptions,
): Promise<OraclePriceHistoryPage> {
  const { fromMs, toMs, signal } = options;
  const limit = options.limit ?? 1000;
  if (
    !Number.isSafeInteger(market) ||
    market < 0 ||
    market > 0xffff_ffff ||
    !Number.isSafeInteger(fromMs) ||
    fromMs < 0 ||
    !Number.isSafeInteger(toMs) ||
    toMs > 8.64e15 ||
    fromMs > toMs ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000
  ) {
    throw new Error("Invalid oracle history range, market or limit");
  }
  signal?.throwIfAborted();
  const params = new URLSearchParams({
    event_type: "price_updated",
    market: String(market),
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    limit: String(limit),
  });
  if (options.cursor) params.set("cursor", options.cursor);
  const response = await (options.fetch ?? globalThis.fetch)(
    `${gatewayUrl.replace(/\/+$/, "")}/v1/history/admin-events?${params}`,
    { method: "GET", cache: "no-store", signal },
  );
  if (!response.ok) throw new GatewayHttpError(response.status, response);
  const body: unknown = await response.json();
  signal?.throwIfAborted();
  if (
    !isRecord(body) ||
    !Array.isArray(body.admin_events) ||
    typeof body.next_cursor !== "string"
  ) {
    throw new Error("Invalid oracle history page");
  }
  const points: OraclePriceHistoryPoint[] = [];
  for (const event of body.admin_events) {
    // Admin-event history does not filter by market upstream.
    if (!isRecord(event) || event.event_type !== "price_updated") continue;
    const payload = event.payload;
    if (!isRecord(payload) || String(payload.market) !== String(market))
      continue;
    const timeMs =
      typeof event.block_time === "string" ? Date.parse(event.block_time) : NaN;
    if (
      !Number.isFinite(timeMs) ||
      typeof payload.price !== "string" ||
      !/^[0-9]+$/.test(payload.price) ||
      BigInt(payload.price) <= 0n ||
      !(
        (typeof event.event_id === "string" &&
          /^[0-9]+$/.test(event.event_id)) ||
        (typeof event.event_id === "number" &&
          Number.isSafeInteger(event.event_id) &&
          event.event_id >= 0)
      )
    ) {
      throw new Error("Invalid oracle history update");
    }
    if (timeMs < fromMs || timeMs >= toMs) continue;
    points.push({
      t: event.block_time as string,
      p: payload.price,
      eventId: String(event.event_id),
    });
  }
  return { market, points, nextCursor: body.next_cursor };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
