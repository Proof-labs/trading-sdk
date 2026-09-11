import { Decoder } from "@msgpack/msgpack";
import { decodeImpactMarketInfo } from "./governance-query.js";
import type { MarketConfig, MarketKind, MarketsSnapshot } from "./types.js";

export const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_ROWS = 16_384;
const U64_MAX = (1n << 64n) - 1n;
const decoder = new Decoder({ useBigInt64: true, maxArrayLength: MAX_ROWS });

function invalid(): never {
  throw new Error("market snapshot: malformed complete response");
}

function tuple(value: unknown, min: number): unknown[] {
  if (!Array.isArray(value) || value.length < min) invalid();
  return value;
}

function uint(value: unknown, max = U64_MAX): bigint {
  const n =
    typeof value === "bigint"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? BigInt(value)
        : invalid();
  if (n < 0n || n > max) invalid();
  return n;
}

function u32(value: unknown): number {
  return Number(uint(value, 0xffff_ffffn));
}
function u8(value: unknown): number {
  return Number(uint(value, 255n));
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") invalid();
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") invalid();
  return value;
}
function bytes(value: unknown, length: number): Uint8Array {
  const row = tuple(value, length);
  if (row.length !== length) invalid();
  return Uint8Array.from(row.map(u8));
}

function kind(value: unknown): MarketKind {
  if (value === "Perp") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const fields = Object.entries(value);
  if (fields.length !== 1) invalid();
  const [name, payload] = fields[0];
  const pair = tuple(payload, 2);
  if (pair.length !== 2 || (pair[1] !== "Yes" && pair[1] !== "No")) invalid();
  const data: [number, "Yes" | "No"] = [u32(pair[0]), pair[1]];
  if (name === "ConditionalPerp") return { ConditionalPerp: data };
  if (name === "PredictionBinary") return { PredictionBinary: data };
  return invalid();
}

function market(value: unknown): MarketConfig {
  // The atomic endpoint serializes current complete records, not old stored
  // row bytes. Missing known fields cannot silently acquire legacy defaults.
  const r = tuple(value, 25);
  const tiers = tuple(r[13], 0).map((value) => {
    const row = tuple(value, 3);
    if (
      row.length !== 3 ||
      typeof row[1] !== "number" ||
      !Number.isInteger(row[1]) ||
      row[1] < -2147483648 ||
      row[1] > 2147483647
    )
      invalid();
    return {
      min30dVolumeMicroUsdc: uint(row[0]),
      makerFeeTenthBps: row[1],
      takerFeeTenthBps: u32(row[2]),
    };
  });
  if (r[18] !== "OracleOnly" && r[18] !== "Median") invalid();
  return {
    market: u32(r[0]),
    imBps: u32(r[1]),
    mmBps: u32(r[2]),
    takerFeeBps: u32(r[3]),
    makerFeeBps: u32(r[4]),
    fundingIntervalMs: uint(r[5]),
    maxFundingRateBps: u32(r[6]),
    kind: kind(r[7]),
    maxPositionSize: uint(r[8]),
    defaultTtlMs: uint(r[9]),
    netDeltaMargin: bool(r[10]),
    poolId: u8(r[11]),
    markPriceMaxOracleAgeMs: uint(r[12]),
    feeTiers: tiers,
    tickSize: uint(r[14]),
    lotSize: uint(r[15]),
    primaryOracleSigner: r[16] === null ? undefined : bytes(r[16], 20),
    oracleStalenessMs: uint(r[17]),
    markSourceMode: r[18],
    maxMarkSpreadBps: u32(r[19]),
    cexCompositeStalenessMs: uint(r[20]),
    partialLiquidationEnabled: bool(r[21]),
    szDecimals: u8(r[22]),
    ticker: text(r[23]),
    maxOpenInterest: uint(r[24]),
  };
}

/** Bounded structural preflight before the maintained MessagePack decoder.
 * Reject floats (even integral floats), extensions, duplicate map keys and
 * deep/oversized containers before they can be coerced or allocated. */
function preflight(input: Uint8Array): void {
  let p = 0;
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const skip = (n: number) => {
    if (n < 0 || p + n > input.length) invalid();
    const start = p;
    p += n;
    return start;
  };
  const length = (n: number) => {
    const start = skip(n);
    return n === 1
      ? view.getUint8(start)
      : n === 2
        ? view.getUint16(start)
        : view.getUint32(start);
  };
  const walk = (depth: number, mapKey = false): string | undefined => {
    if (depth > 32) invalid();
    const tag = input[skip(1)];
    let count: number;
    if (
      (tag >= 0xa0 && tag <= 0xbf) ||
      tag === 0xd9 ||
      tag === 0xda ||
      tag === 0xdb
    ) {
      count =
        tag <= 0xbf
          ? tag & 31
          : length(tag === 0xd9 ? 1 : tag === 0xda ? 2 : 4);
      return utf8.decode(input.subarray(skip(count), p));
    }
    if (mapKey) invalid();
    if (
      tag <= 0x7f ||
      tag >= 0xe0 ||
      tag === 0xc0 ||
      tag === 0xc2 ||
      tag === 0xc3
    )
      return;
    if (tag >= 0xcc && tag <= 0xcf) {
      skip(2 ** (tag - 0xcc));
      return;
    }
    if (tag >= 0xd0 && tag <= 0xd3) {
      skip(2 ** (tag - 0xd0));
      return;
    }
    if (tag === 0xc4 || tag === 0xc5 || tag === 0xc6) {
      skip(length(tag === 0xc4 ? 1 : tag === 0xc5 ? 2 : 4));
      return;
    }
    if ((tag >= 0x90 && tag <= 0x9f) || tag === 0xdc || tag === 0xdd) {
      count = tag <= 0x9f ? tag & 15 : length(tag === 0xdc ? 2 : 4);
      if (count > MAX_ROWS || count > input.length - p) invalid();
      for (let i = 0; i < count; i++) walk(depth + 1);
      return;
    }
    if ((tag >= 0x80 && tag <= 0x8f) || tag === 0xde || tag === 0xdf) {
      count = tag <= 0x8f ? tag & 15 : length(tag === 0xde ? 2 : 4);
      if (count > MAX_ROWS || count * 2 > input.length - p) invalid();
      const keys = new Set<string>();
      for (let i = 0; i < count; i++) {
        const key = walk(depth + 1, true)!;
        if (keys.has(key)) invalid();
        keys.add(key);
        walk(depth + 1);
      }
      return;
    }
    return invalid();
  };
  walk(0);
  if (p !== input.length) invalid();
}

/** Strict whole-snapshot decode; future trailing tuple fields are ignored. */
export function decodeMarketsSnapshot(
  body: unknown,
  expectedChain: Uint8Array,
): MarketsSnapshot {
  if (
    !(expectedChain instanceof Uint8Array) ||
    expectedChain.length !== 32 ||
    !expectedChain.some((n) => n !== 0)
  )
    invalid();
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid();
  if ((body as Record<string, unknown>).error != null) invalid();
  const encoded = (body as Record<string, unknown>).data;
  if (
    typeof encoded !== "string" ||
    encoded.length > MAX_SNAPSHOT_BYTES ||
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  )
    invalid();
  const rawBytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  // atob tolerates nonzero padding bits; canonical base64 must round-trip.
  if (
    btoa(Array.from(rawBytes, (n) => String.fromCharCode(n)).join("")) !==
    encoded
  )
    invalid();
  preflight(rawBytes);
  const top = tuple(decoder.decode(rawBytes), 4);
  const chainId = bytes(top[0], 32);
  if (!chainId.every((n, i) => n === expectedChain[i]))
    throw new Error("market snapshot: wrong chain");
  const height = uint(top[1]);
  if (height === 0n) throw new Error("market snapshot: uncommitted height");
  const markets = tuple(top[2], 0).map(market);
  const impactMarkets = tuple(top[3], 0).map((value, index) =>
    decodeImpactMarketInfo(tuple(value, 15).slice(0, 15), index),
  );
  if (
    new Set(markets.map((m) => m.market)).size !== markets.length ||
    new Set(impactMarkets.map((m) => m.impactMarketId)).size !==
      impactMarkets.length
  )
    invalid();
  return { chainId, height, markets, impactMarkets };
}

/** Gateway-only, bounded one-shot read. No retry, node fallback or health inference. */
export async function readMarketsSnapshot(
  gatewayUrl: string,
  expectedChain: Uint8Array,
): Promise<MarketsSnapshot> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(
      `${gatewayUrl.replace(/\/$/, "")}/v1/markets-snapshot`,
      { signal: controller.signal, redirect: "error" },
    );
    if (response.status !== 200)
      throw new Error(`market snapshot returned HTTP ${response.status}`);
    if (!response.body) invalid();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_SNAPSHOT_BYTES) invalid();
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    return decodeMarketsSnapshot(
      parseSnapshotEnvelope(
        new TextDecoder("utf-8", { fatal: true }).decode(body),
      ),
      expectedChain,
    );
  } catch (error) {
    // Transport errors can embed credential-bearing URLs; never forward them.
    if (error instanceof Error && error.message.startsWith("market snapshot"))
      throw error;
    throw new Error("market snapshot: transport or response unavailable");
  } finally {
    clearTimeout(timer);
  }
}

/** JSON.parse validates grammar; this extra pass rejects duplicate top-level
 * envelope fields instead of silently taking the last `data` or `error` key.
 * Escaped spellings of the same key compare after normal JSON unescaping. */
export function parseSnapshotEnvelope(input: string): unknown {
  const parsed: unknown = JSON.parse(input);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid();
  let depth = 0;
  let expectsKey = false;
  const keys = new Set<string>();
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '"') {
      const start = i++;
      for (; i < input.length; i++) {
        if (input[i] === "\\") i++;
        else if (input[i] === '"') break;
      }
      if (depth === 1 && expectsKey) {
        const key: string = JSON.parse(input.slice(start, i + 1));
        if (keys.has(key)) invalid();
        keys.add(key);
      }
    } else if (char === "{" || char === "[") {
      depth++;
      if (depth > 32) invalid();
      if (depth === 1) expectsKey = true;
    } else if (char === "}" || char === "]") depth--;
    else if (depth === 1 && char === ",") expectsKey = true;
    else if (depth === 1 && char === ":") expectsKey = false;
  }
  return parsed;
}
