import type { GatewayReadOptions, GatewayReads } from "./gateway-reads.js";

export type MarketStatsStatus = "ready" | "stale" | "unavailable";

export interface MarketStats {
  market: number;
  sz_decimals: number | null;
  status: MarketStatsStatus;
  unavailable_reason: string | null;
  /** Sum of raw contract quantities across executions, counting each trade once. */
  volume_24h_contracts: string | null;
  /** Exact plain-decimal USDC dollars, already adjusted by sz_decimals. */
  volume_24h_usdc: string | null;
  /** Latest trade at or before window_start; raw integer micro-USDC. */
  reference_price: string | null;
  /** Latest trade before window_end; raw integer micro-USDC. */
  last_price: string | null;
  /** Signed basis points relative to reference_price, rounded to six decimals. */
  change_24h_bps: string | null;
  /** Trade extrema in [window_start, window_end); raw integer micro-USDC. */
  high_price: string | null;
  low_price: string | null;
  /** Current committed raw contracts by side, not long plus short notional. */
  open_interest: { long_contracts: string; short_contracts: string } | null;
  open_interest_unavailable_reason: string | null;
}

export interface MarketStatsResponse {
  as_of: string;
  window_start: string;
  window_end: string;
  indexed_height: string | null;
  indexed_at: string | null;
  stale_after_seconds: number;
  /** Indexer frontier freshness; inspect each market and metric's coverage too. */
  status: MarketStatsStatus;
  markets: MarketStats[];
}

/** The history database's market key is signed int32, including market zero. */
function marketId(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 0x7fff_ffff
  )
    throw new Error(
      "Invalid market statistics market: expected an integer in [0, 2147483647]",
    );
  return value;
}

/** Internal shared request validation for the raw and decoded read surfaces. */
export function marketStatsMarketIds(markets: readonly number[]): string {
  if (!Array.isArray(markets) || markets.length < 1 || markets.length > 50)
    throw new Error("Invalid market statistics request: expected 1–50 markets");
  const ids = markets.map(marketId);
  if (new Set(ids).size !== ids.length)
    throw new Error("Invalid market statistics request: duplicate market");
  return ids.join(",");
}

/** One consistent indexed snapshot through the caller's SDK gateway transport.
 * Unavailable metrics stay null; this read never substitutes zero or estimates.
 */
export async function queryMarketStats(
  reads: Pick<GatewayReads, "marketStats">,
  markets: readonly number[],
  opts: GatewayReadOptions = {},
): Promise<MarketStatsResponse> {
  marketStatsMarketIds(markets);
  const requested = [...markets];
  opts.signal?.throwIfAborted();
  const response = await reads.marketStats({ markets: requested }, opts);
  const body: unknown = await response.json();
  opts.signal?.throwIfAborted();
  const decoded = decodeMarketStatsResponse(body);
  const expected = new Set(requested);
  if (
    decoded.markets.length !== expected.size ||
    decoded.markets.some((row) => !expected.has(row.market))
  )
    throw new Error(
      "Invalid market statistics response: requested market coverage mismatch",
    );
  return decoded;
}

const UNSIGNED = /^(?:0|[1-9][0-9]*)$/;
const USDC = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,24})?$/;
const BPS = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("object");
  return value as Record<string, unknown>;
}
function invalid(field: string): never {
  throw new Error(`Invalid market statistics response: ${field}`);
}
function status(value: unknown): MarketStatsStatus {
  if (value !== "ready" && value !== "stale" && value !== "unavailable")
    invalid("status");
  return value;
}
function reason(value: unknown, field: string): string | null {
  if (value !== null && typeof value !== "string") invalid(field);
  return value;
}
function decimal(value: unknown, field: string, pattern = UNSIGNED): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid(field);
  return value;
}
function nullableDecimal(
  value: unknown,
  field: string,
  pattern = UNSIGNED,
): string | null {
  return value === null ? null : decimal(value, field, pattern);
}
function timestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  )
    invalid(field);
  return value;
}

/** Decode without losing precision or confusing absent evidence with zero.
 * Additive unknown fields are ignored for forward compatibility.
 */
export function decodeMarketStatsResponse(value: unknown): MarketStatsResponse {
  const body = record(value);
  const as_of = timestamp(body.as_of, "as_of");
  const window_start = timestamp(body.window_start, "window_start");
  const window_end = timestamp(body.window_end, "window_end");
  if (
    Date.parse(as_of) !== Date.parse(window_end) ||
    Date.parse(window_end) - Date.parse(window_start) !== 86_400_000
  )
    invalid("rolling 24-hour window");
  const indexed_height = nullableDecimal(
    body.indexed_height,
    "indexed_height",
    /^[1-9][0-9]*$/,
  );
  const indexed_at =
    body.indexed_at === null ? null : timestamp(body.indexed_at, "indexed_at");
  if ((indexed_height === null) !== (indexed_at === null))
    invalid("indexed frontier");
  if (
    typeof body.stale_after_seconds !== "number" ||
    !Number.isSafeInteger(body.stale_after_seconds) ||
    body.stale_after_seconds <= 0
  )
    invalid("stale_after_seconds");
  if (
    !Array.isArray(body.markets) ||
    body.markets.length < 1 ||
    body.markets.length > 50
  )
    invalid("markets");
  const markets = body.markets.map((value): MarketStats => {
    const row = record(value);
    if (
      row.sz_decimals !== null &&
      (typeof row.sz_decimals !== "number" ||
        !Number.isInteger(row.sz_decimals) ||
        row.sz_decimals < 0 ||
        row.sz_decimals > 18)
    )
      invalid("sz_decimals");
    const oi = row.open_interest === null ? null : record(row.open_interest);
    return {
      market: marketId(row.market),
      sz_decimals: row.sz_decimals,
      status: status(row.status),
      unavailable_reason: reason(row.unavailable_reason, "unavailable_reason"),
      volume_24h_contracts: nullableDecimal(
        row.volume_24h_contracts,
        "volume_24h_contracts",
      ),
      volume_24h_usdc: nullableDecimal(
        row.volume_24h_usdc,
        "volume_24h_usdc",
        USDC,
      ),
      reference_price: nullableDecimal(row.reference_price, "reference_price"),
      last_price: nullableDecimal(row.last_price, "last_price"),
      change_24h_bps: nullableDecimal(
        row.change_24h_bps,
        "change_24h_bps",
        BPS,
      ),
      high_price: nullableDecimal(row.high_price, "high_price"),
      low_price: nullableDecimal(row.low_price, "low_price"),
      open_interest:
        oi === null
          ? null
          : {
              long_contracts: decimal(
                oi.long_contracts,
                "open_interest.long_contracts",
              ),
              short_contracts: decimal(
                oi.short_contracts,
                "open_interest.short_contracts",
              ),
            },
      open_interest_unavailable_reason: reason(
        row.open_interest_unavailable_reason,
        "open_interest_unavailable_reason",
      ),
    };
  });
  if (new Set(markets.map((row) => row.market)).size !== markets.length)
    invalid("duplicate market");
  return {
    as_of,
    window_start,
    window_end,
    indexed_height,
    indexed_at,
    stale_after_seconds: body.stale_after_seconds,
    status: status(body.status),
    markets,
  };
}
