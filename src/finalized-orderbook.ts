import {
  canonicalBase64,
  invalidRead,
  marketId,
  U64_MAX,
  I64_MAX,
  type MarketId,
} from "./read-values.js";
import { Decoder } from "@msgpack/msgpack";
import { rejectFloats } from "./codec.js";
import { ready } from "./wasm-loader.js";
import type { OrderbookLevel } from "./types.js";
import type { GatewayReadError } from "./errors.js";
import type { ExchangeHttpTransport } from "./http-transport.js";
import {
  asReadError,
  boundedGatewayJson,
  decodeFinalizedReadWitness,
  type BoundedReadOptions,
  type FinalizedReadWitness,
} from "./bounded-read.js";

const ORDERBOOK_DEPTHS = [1, 20, 100] as const;
export type FinalizedOrderbookDepth = (typeof ORDERBOOK_DEPTHS)[number];
const DEFAULT_ORDERBOOK_DEPTH: FinalizedOrderbookDepth = 20;
const MAX_ORDERBOOK_DEPTH = Math.max(...ORDERBOOK_DEPTHS);
/** Decoded MessagePack ceiling for one book; the 1 MiB HTTP cap applies first. */
const MAX_BOOK_BYTES = 512 * 1024;
const U32_MAX = 0xffff_ffffn;
export interface FinalizedOrderbookOptions extends BoundedReadOptions {
  /** Requested levels per side. Default 20; this is not a full-book assertion. */
  depth?: FinalizedOrderbookDepth;
}
export interface FinalizedOrderbook {
  market: MarketId;
  depth: FinalizedOrderbookDepth;
  height: bigint;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  witness: FinalizedReadWitness;
}

const decoder = new Decoder({
  useBigInt64: true,
  maxArrayLength: MAX_ORDERBOOK_DEPTH,
});
function invalid(
  field: string,
  kind: GatewayReadError["kind"] = "malformed",
): never {
  return invalidRead(`orderbook.${field}`, kind);
}
function uint(value: unknown, field: string, maximum = U64_MAX): bigint {
  const parsed =
    typeof value === "bigint"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? BigInt(value)
        : invalid(field);
  if (parsed < 0n || parsed > maximum) invalid(field);
  return parsed;
}
function request(market: number, depth: FinalizedOrderbookDepth): void {
  marketId(market);
  if (!ORDERBOOK_DEPTHS.includes(depth)) invalid("depth");
}

/** Internal engine-height-bearing frame decoder. Requires await ready(). */
export function decodeFinalizedOrderbook(
  value: unknown,
  market: number,
  depth: FinalizedOrderbookDepth = DEFAULT_ORDERBOOK_DEPTH,
): FinalizedOrderbook {
  request(market, depth);
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("frame");
  const frame = value as Record<string, unknown>;
  if (frame.market !== String(market) || frame.depth !== String(depth))
    invalid("market/depth mismatch", "binding");
  const height = uint(frame.height, "height", I64_MAX);
  if (height === 0n) invalid("unfinalized height");
  const encoded = frame.bookMsgpackB64;
  if (typeof encoded !== "string") invalid("book encoding");
  if ("data" in frame && encoded !== frame.data)
    invalid("book encoding mismatch", "binding");
  const bytes = canonicalBase64(encoded, "book encoding", MAX_BOOK_BYTES);
  // Preflight before decoding bounds depth and rejects floats and trailing data.
  const raw: unknown = asReadError("orderbook.msgpack", () => {
    rejectFloats(bytes);
    return decoder.decode(bytes);
  });
  if (!Array.isArray(raw) || raw.length !== 2) invalid("book tuple");
  const levels = (value: unknown, side: "bids" | "asks"): OrderbookLevel[] => {
    if (!Array.isArray(value) || value.length > depth)
      invalid("depth exceeded");
    let previous: bigint | undefined;
    return value.map((row) => {
      if (!Array.isArray(row) || row.length !== 3) invalid("level tuple");
      const price = uint(row[0], "price");
      if (
        previous !== undefined &&
        (side === "bids" ? price >= previous : price <= previous)
      )
        invalid("level ordering");
      previous = price;
      return {
        price,
        totalQty: uint(row[1], "quantity"),
        orderCount: Number(uint(row[2], "order count", U32_MAX)),
      };
    });
  };
  return {
    market: marketId(market),
    depth,
    height,
    bids: levels(raw[0], "bids"),
    asks: levels(raw[1], "asks"),
    witness: decodeFinalizedReadWitness(frame.witness, height),
  };
}

export async function readFinalizedOrderbook(
  gatewayUrl: string,
  market: number,
  options: FinalizedOrderbookOptions,
  transport: ExchangeHttpTransport,
): Promise<FinalizedOrderbook> {
  const captured = { ...options };
  const depth = captured.depth ?? DEFAULT_ORDERBOOK_DEPTH;
  request(market, depth);
  captured.signal?.throwIfAborted();
  const body = await boundedGatewayJson(
    `${gatewayUrl.replace(/\/+$/, "")}/v1/orderbook-snapshot/${market}?depth=${depth}`,
    transport,
    captured,
    { prepare: ready },
  );
  return decodeFinalizedOrderbook(body, market, depth);
}
