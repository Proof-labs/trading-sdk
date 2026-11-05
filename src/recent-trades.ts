import {
  U64_MAX,
  I64_MAX,
  hexAddress,
  invalidRead,
  marketId,
  type HexAddress,
  type MarketId,
} from "./read-values.js";
import { Side } from "./types.js";
import type { BoundedReadOptions } from "./bounded-read.js";
import type { GatewayReadError } from "./errors.js";

/** The node keeps the newest 500 fills per market and serves 100 by default. */
const DEFAULT_RECENT_TRADES_LIMIT = 100;
const MAX_RECENT_TRADES_LIMIT = 500;

export interface RecentTradesOptions extends BoundedReadOptions {
  /** 1–500; defaults to 100, the node's own default. */
  limit?: number;
}

/** One fill from the node's in-memory trade tape (`GET /v1/trades/{market}`). */
export interface RecentTrade {
  fillId: bigint;
  market: MarketId;
  /** Execution price, integer micro-USDC (6 dp). */
  price: bigint;
  /** Filled quantity, integer contracts. */
  quantity: bigint;
  makerOwner: HexAddress;
  takerOwner: HexAddress;
  makerSide: Side;
  /** Micro-USDC; positive is charged, negative is a rebate. */
  takerFee: bigint;
  makerFee: bigint;
  blockHeight: bigint;
  /** The serving node's wall clock, epoch ms, when it recorded the fill.
   * Not the block time, and not comparable across nodes. */
  recordedAtMs: number;
}

function invalid(
  field: string,
  kind: GatewayReadError["kind"] = "malformed",
): never {
  return invalidRead(`recent trades.${field}`, kind);
}

/** A decimal integer the node renders as text, within [min, max]. */
function decimal(value: unknown, field: string, min: bigint, max: bigint) {
  if (
    typeof value !== "string" ||
    value.length > 20 ||
    !/^(0|-?[1-9][0-9]*)$/.test(value)
  )
    invalid(field);
  const n = BigInt(value);
  if (n < min || n > max) invalid(field);
  return n;
}

export function recentTradesLimit(
  market: number,
  options: RecentTradesOptions,
): number {
  marketId(market);
  const limit = options.limit ?? DEFAULT_RECENT_TRADES_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_RECENT_TRADES_LIMIT
  )
    invalid("limit");
  return limit;
}

/** Newest first. The tape lives in one node's memory: it starts empty after a
 * restart, an unknown market is an empty list, and two nodes behind one
 * gateway can serve different tapes. Use the indexed trade history when
 * completeness matters. */
export function decodeRecentTrades(
  value: unknown,
  market: number,
  options: RecentTradesOptions,
): RecentTrade[] {
  const limit = recentTradesLimit(market, options);
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("page");
  const rows = (value as Record<string, unknown>).trades;
  if (!Array.isArray(rows) || rows.length > limit) invalid("page size");
  const ids = new Set<bigint>();
  let previousHeight: bigint | undefined;
  return rows.map((raw): RecentTrade => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("trade");
    const row = raw as Record<string, unknown>;
    if (
      typeof row.market !== "string" ||
      !/^[1-9][0-9]{0,9}$/.test(row.market) ||
      Number(row.market) !== market
    )
      invalid("market mismatch", "binding");
    const fillId = decimal(row.fill_id, "fill id", 0n, U64_MAX);
    if (ids.has(fillId)) invalid("duplicate trade");
    ids.add(fillId);
    if (
      !Number.isSafeInteger(row.block_height) ||
      (row.block_height as number) < 0
    )
      invalid("block height");
    const blockHeight = BigInt(row.block_height as number);
    if (previousHeight !== undefined && blockHeight > previousHeight)
      invalid("unordered trade");
    previousHeight = blockHeight;
    if (!Number.isSafeInteger(row.timestamp) || (row.timestamp as number) < 0)
      invalid("timestamp");
    if (row.maker_side !== "buy" && row.maker_side !== "sell")
      invalid("maker side");
    return {
      fillId,
      market: marketId(market),
      price: decimal(row.price, "price", 0n, U64_MAX),
      quantity: decimal(row.quantity, "quantity", 0n, U64_MAX),
      makerOwner: hexAddress(row.maker_owner, "recent trades.maker owner"),
      takerOwner: hexAddress(row.taker_owner, "recent trades.taker owner"),
      makerSide: row.maker_side === "buy" ? Side.Buy : Side.Sell,
      takerFee: decimal(row.taker_fee, "taker fee", -I64_MAX - 1n, I64_MAX),
      makerFee: decimal(row.maker_fee, "maker fee", -I64_MAX - 1n, I64_MAX),
      blockHeight,
      recordedAtMs: row.timestamp as number,
    };
  });
}
