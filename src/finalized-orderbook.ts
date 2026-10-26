import { Decoder } from "@msgpack/msgpack";
import { rejectFloats } from "./codec.js";
import { ready } from "./wasm-loader.js";
import type { OrderbookLevel } from "./types.js";
import type { ExchangeHttpTransport } from "./http-transport.js";
import {
  boundedGatewayJson,
  decodeFinalizedReadWitness,
  type BoundedReadOptions,
  type FinalizedReadWitness,
} from "./bounded-read.js";

export type FinalizedOrderbookDepth = 1 | 20 | 100;
export interface FinalizedOrderbookOptions extends BoundedReadOptions {
  /** Requested levels per side. Default 20; this is not a full-book assertion. */
  depth?: FinalizedOrderbookDepth;
}
export interface FinalizedOrderbook {
  market: number;
  depth: FinalizedOrderbookDepth;
  height: bigint;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  witness: FinalizedReadWitness;
}
const U64_MAX = (1n << 64n) - 1n;
const decoder = new Decoder({ useBigInt64: true, maxArrayLength: 100 });
function invalid(field: string): never {
  throw new Error(`Invalid finalized orderbook: ${field}`);
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
  if (uint(market, "market", 0xffff_ffffn) === 0n) invalid("market");
  if (![1, 20, 100].includes(depth)) invalid("depth");
}

/** Decode an engine-height-bearing frame, never the unheighted gateway cache.
 * Requires a same-view witness. This is not a CometBFT commitment proof or a
 * freshness verdict; caller must bind node, chain and H+1 header independently.
 * Requires await ready() for the authoritative MessagePack preflight. */
export function decodeFinalizedOrderbook(
  value: unknown,
  market: number,
  depth: FinalizedOrderbookDepth = 20,
): FinalizedOrderbook {
  request(market, depth);
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("frame");
  const frame = value as Record<string, unknown>;
  if (frame.market !== String(market) || frame.depth !== String(depth))
    invalid("market/depth mismatch");
  const height = uint(frame.height, "height", (1n << 63n) - 1n);
  if (height === 0n) invalid("unfinalized height");
  const encoded = frame.bookMsgpackB64;
  if (
    typeof encoded !== "string" ||
    encoded !== frame.data ||
    encoded.length === 0 ||
    encoded.length > 1024 * 1024 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  )
    invalid("book encoding");
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  if (
    btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")) !==
    encoded
  )
    invalid("base64");
  // Preflight before decoding bounds depth and rejects floats and trailing data.
  rejectFloats(bytes);
  const raw: unknown = decoder.decode(bytes);
  if (!Array.isArray(raw) || raw.length !== 2) invalid("book tuple");
  const levels = (value: unknown, buy: boolean): OrderbookLevel[] => {
    if (!Array.isArray(value) || value.length > depth)
      invalid("depth exceeded");
    let previous: bigint | undefined;
    return value.map((row) => {
      if (!Array.isArray(row) || row.length !== 3) invalid("level tuple");
      const price = uint(row[0], "price");
      if (
        previous !== undefined &&
        (buy ? price >= previous : price <= previous)
      )
        invalid("level ordering");
      previous = price;
      return {
        price,
        totalQty: uint(row[1], "quantity"),
        orderCount: Number(uint(row[2], "order count", 0xffff_ffffn)),
      };
    });
  };
  return {
    market,
    depth,
    height,
    bids: levels(raw[0], true),
    asks: levels(raw[1], false),
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
  const depth = captured.depth ?? 20;
  request(market, depth);
  captured.signal?.throwIfAborted();
  await ready();
  const body = await boundedGatewayJson(
    `${gatewayUrl.replace(/\/+$/, "")}/v1/orderbook-snapshot/${market}?depth=${depth}`,
    transport,
    captured,
  );
  return decodeFinalizedOrderbook(body, market, depth);
}
