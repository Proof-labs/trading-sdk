import {
  I64_MAX,
  MAX_DATE_MS,
  hexAddress,
  invalidRead,
  marketId,
  rfc3339,
  type MarketId,
  type HexAddress,
} from "./read-values.js";
import { Side } from "./types.js";
import type { ExchangeHttpTransport } from "./http-transport.js";
import { boundedGatewayJson, type BoundedReadOptions } from "./bounded-read.js";

export interface TradeHistoryOptions extends BoundedReadOptions {
  /** Fixed inclusive lower and exclusive upper block-time bounds, epoch ms. */
  fromMs: number;
  toMs: number;
  /** 1–1000; defaults to 200. Keep all filters fixed when following a cursor. */
  limit?: number;
  /** Opaque indexer cursor. Never decode or numerically coerce it. */
  cursor?: string;
}
export interface ParticipantTrade {
  fillId: bigint;
  market: MarketId;
  blockHeight: bigint;
  /** Original RFC3339 string, retaining fractional-second precision. */
  blockTime: string;
  /** Exact NUMERIC text as indexed, without conversion or rounding. */
  price: string;
  quantity: string;
  makerOwner: HexAddress;
  takerOwner: HexAddress;
  makerSide: Side;
  takerFee: bigint;
  makerFee: bigint;
}
export interface TradeHistoryPage {
  market: MarketId;
  /** The request's bounds, not an assertion of indexer freshness/completeness. */
  fromMs: number;
  toMs: number;
  trades: ParticipantTrade[];
  /** Absent ends this indexed range, not proof of ingestion completeness. */
  nextCursor?: string;
}

function invalid(
  field: string,
  kind: import("./errors.js").GatewayReadError["kind"] = "malformed",
): never {
  return invalidRead(`trade history.${field}`, kind);
}
function integer(value: unknown, field: string, signed = false): bigint {
  const n =
    typeof value === "number" && Number.isSafeInteger(value)
      ? BigInt(value)
      : typeof value === "string" &&
          /^(0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(value) &&
          value.length <= 20
        ? BigInt(value)
        : invalid(field);
  if (n < (signed ? -(1n << 63n) : 0n) || n > I64_MAX) invalid(field);
  return n;
}
function address(value: unknown) {
  return hexAddress(value, "participant owner");
}
function numeric(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length > 100 ||
    !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)
  )
    invalid(field);
  return value;
}
function cursor(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    Array.from(value).some(
      (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
    )
  )
    invalid("cursor");
  return value;
}
function time(value: unknown) {
  return rfc3339(value);
}
export function tradeHistorySearchParams(
  market: number,
  options: TradeHistoryOptions,
): URLSearchParams {
  marketId(market);
  // Indexer storage uses signed i32; do not broaden its route contract.
  if (market > 0x7fffffff) invalid("market outside indexer range");
  if (
    !Number.isSafeInteger(options.fromMs) ||
    !Number.isSafeInteger(options.toMs) ||
    options.fromMs < 0 ||
    options.toMs <= options.fromMs ||
    options.toMs > MAX_DATE_MS
  )
    invalid("window");
  const limit = options.limit ?? 200;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    invalid("limit");
  const params = new URLSearchParams({
    from: String(options.fromMs),
    to: String(options.toMs),
    limit: String(limit),
  });
  if (options.cursor !== undefined)
    params.set("cursor", cursor(options.cursor));
  return params;
}

/** One indexed page only, not proof of completeness. Callers MUST keep filters
 * fixed, track all seen cursors and fill IDs, and compare (blockTime, fillId)
 * across boundaries. Cursor cycles, duplicates and skipped rows across pages
 * are not detectable by a stateless decoder. Use complete chain evidence when
 * absence/completeness matters. No self-trade filtering or units conversion. */
export function decodeTradeHistoryPage(
  value: unknown,
  market: number,
  options: TradeHistoryOptions,
): TradeHistoryPage {
  tradeHistorySearchParams(market, options);
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("page");
  const page = value as Record<string, unknown>;
  const limit = options.limit ?? 200;
  if (!Array.isArray(page.fills) || page.fills.length > limit)
    invalid("page size");
  const nextCursor = cursor(page.next_cursor);
  if (
    nextCursor &&
    (page.fills.length !== limit || nextCursor === options.cursor)
  )
    invalid("non-progressing or truncated page");
  let previous: { nanos: bigint; id: bigint } | undefined;
  const ids = new Set<bigint>();
  const trades = page.fills.map((raw): ParticipantTrade => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("trade");
    const row = raw as Record<string, unknown>;
    if (row.market !== market) invalid("market mismatch", "binding");
    const fillId = integer(row.fill_id, "fill id");
    const blockHeight = integer(row.block_height, "block height");
    const block = time(row.block_time);
    if (
      block.nanos < BigInt(options.fromMs) * 1_000_000n ||
      block.nanos >= BigInt(options.toMs) * 1_000_000n
    )
      invalid("trade outside window");
    if (
      ids.has(fillId) ||
      (previous &&
        (block.nanos > previous.nanos ||
          (block.nanos === previous.nanos && fillId >= previous.id)))
    )
      invalid("duplicate or unordered trade");
    ids.add(fillId);
    previous = { nanos: block.nanos, id: fillId };
    if (
      row.maker_side !== "buy" &&
      row.maker_side !== "sell" &&
      row.maker_side !== "Buy" &&
      row.maker_side !== "Sell"
    )
      invalid("maker side");
    return {
      fillId,
      market: marketId(market),
      blockHeight,
      blockTime: block.raw,
      price: numeric(row.price, "price"),
      quantity: numeric(row.quantity, "quantity"),
      makerOwner: address(row.maker_owner),
      takerOwner: address(row.taker_owner),
      makerSide: row.maker_side.toLowerCase() === "buy" ? Side.Buy : Side.Sell,
      takerFee: integer(row.taker_fee, "taker fee", true),
      makerFee: integer(row.maker_fee, "maker fee", true),
    };
  });
  return {
    market: marketId(market),
    fromMs: options.fromMs,
    toMs: options.toMs,
    trades,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

export async function readTradeHistoryPage(
  gatewayUrl: string,
  market: number,
  options: TradeHistoryOptions,
  transport: ExchangeHttpTransport,
): Promise<TradeHistoryPage> {
  const captured = { ...options };
  const params = tradeHistorySearchParams(market, captured);
  const body = await boundedGatewayJson(
    `${gatewayUrl.replace(/\/+$/, "")}/v1/history/trades/${market}?${params}`,
    transport,
    captured,
  );
  return decodeTradeHistoryPage(body, market, captured);
}
