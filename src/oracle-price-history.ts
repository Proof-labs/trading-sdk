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

const MAX_DATE_MS = 8_640_000_000_000_000; // ECMA-262 Date range boundary
const U64_MAX = (1n << 64n) - 1n;

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
  assertValidMarket(market);
  assertValidRange(fromMs, toMs);
  assertValidLimit(limit);
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
  let previousTimeMs: number | undefined;
  for (const event of body.admin_events) {
    // Admin-event history does not filter by market upstream.
    if (!isRecord(event) || event.event_type !== "price_updated") continue;
    const payload = event.payload;
    if (!isRecord(payload) || String(payload.market) !== String(market))
      continue;
    const timeMs =
      typeof event.block_time === "string" ? Date.parse(event.block_time) : NaN;
    // A record outside the requested window is never in the result, so it
    // must not be able to abort the page just for being malformed.
    if (Number.isFinite(timeMs) && (timeMs < fromMs || timeMs >= toMs))
      continue;
    if (!Number.isFinite(timeMs)) {
      throw new Error(
        "Invalid oracle history update: block_time is not a valid RFC3339 timestamp",
      );
    }
    const price = unsignedDecimal(
      payload.price,
      "payload.price",
      U64_MAX,
      true,
    );
    const eventId = eventIdOf(event.event_id);
    if (previousTimeMs !== undefined && timeMs > previousTimeMs) {
      throw new Error("Invalid oracle history page: page is not newest-first");
    }
    previousTimeMs = timeMs;
    points.push({ t: event.block_time as string, p: price, eventId });
  }
  return { market, points, nextCursor: body.next_cursor };
}

function assertValidMarket(market: number): void {
  if (!Number.isSafeInteger(market) || market < 0 || market > 0xffff_ffff) {
    throw new Error("Invalid oracle history market: must be a uint32");
  }
}

function assertValidRange(fromMs: number, toMs: number): void {
  if (!Number.isSafeInteger(fromMs) || fromMs < 0) {
    throw new Error(
      "Invalid oracle history range: fromMs must be a non-negative integer",
    );
  }
  if (!Number.isSafeInteger(toMs) || toMs > MAX_DATE_MS) {
    throw new Error(
      "Invalid oracle history range: toMs must be an integer within the Date range",
    );
  }
  if (fromMs > toMs) {
    throw new Error(
      "Invalid oracle history range: fromMs must not exceed toMs",
    );
  }
}

function assertValidLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error(
      "Invalid oracle history limit: must be an integer in [1, 1000]",
    );
  }
}

/** Canonical unsigned decimal, matching `trigger-history.ts`'s `unsigned()`:
 * no leading zeros, bounded, and never silently truncated. */
function unsignedDecimal(
  value: unknown,
  name: string,
  maximum: bigint,
  nonzero: boolean,
): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(
      `Invalid oracle history update: ${name} is not canonical unsigned decimal`,
    );
  }
  const parsed = BigInt(value);
  if (parsed > maximum || (nonzero && parsed === 0n)) {
    throw new Error(`Invalid oracle history update: ${name} is out of range`);
  }
  return value;
}

function eventIdOf(value: unknown): string {
  if (typeof value === "string") {
    return unsignedDecimal(value, "event_id", U64_MAX, false);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  throw new Error(
    "Invalid oracle history update: event_id must be a non-negative safe integer or a canonical unsigned decimal string",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
