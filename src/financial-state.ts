import { Decoder } from "@msgpack/msgpack";
import {
  decodeAccountState,
  type RawAccountPosition,
} from "./account-state.js";

/** Bounded selection for one finalized-store read; not historical or risk authorization. */
export interface FinancialStateSelection {
  markets: number[];
  owners: string[];
}
export interface FinancialAccountState {
  owner: string;
  balance: bigint | null;
  /** Lifetime fee/rebate counter, NOT a cash balance to add to conservation sums. */
  feesAccrued: bigint | null;
  feeOverride: { takerBps: number; makerBps: number } | null;
  rollingVolume: { lastUpdateMs: bigint; volume: bigint } | null;
  positions: RawAccountPosition[];
}
export interface FinancialMarketState {
  market: number;
  pool: number;
  szDecimals: number;
  makerFeeBps: number;
  takerFeeBps: number;
  feeTiers: {
    min30dVolumeMicroUsdc: bigint;
    makerFeeTenthBps: number;
    takerFeeTenthBps: number;
  }[];
  fundingIntervalMs: bigint;
  maxFundingRateBps: number;
  cumulativeFunding: bigint | null;
  fundingRateBps: bigint | null;
  lastFundingTimeMs: bigint | null;
  markEwma: bigint | null;
}
/** Raw stored amounts, including absence. No equity, solvency or withdrawal verdict. */
export interface FinancialState {
  format: 1;
  finalizedHeight: bigint;
  finalizedTimeMs: bigint;
  accounts: FinancialAccountState[];
  markets: FinancialMarketState[];
  feePool: bigint | null;
  insurancePools: { pool: number; balance: bigint | null }[];
  plp: {
    owner: string;
    /** Stored bootstrap baseline, NOT additional cash to add to the PLP account balance. */
    bootstrapBalance: bigint;
    minBalanceFloor: bigint;
    enabled: boolean;
  } | null;
}

function invalid(field: string): never {
  throw new Error(`financial state decode: invalid ${field}`);
}
function tuple(raw: unknown, size: number, field: string): unknown[] {
  if (!Array.isArray(raw) || raw.length !== size) return invalid(field);
  return raw;
}
function list(
  raw: unknown,
  min: number,
  max: number,
  field: string,
): unknown[] {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max)
    return invalid(field);
  return raw;
}
function integer(
  raw: unknown,
  field: string,
  bits = 64,
  signed = false,
): bigint {
  if (typeof raw === "number" && Number.isSafeInteger(raw)) raw = BigInt(raw);
  const width = BigInt(bits - (signed ? 1 : 0));
  if (
    typeof raw !== "bigint" ||
    raw < (signed ? -(1n << width) : 0n) ||
    raw >= 1n << width
  )
    return invalid(field);
  return raw;
}
function small(raw: unknown, field: string, bits = 32, signed = false): number {
  return Number(integer(raw, field, bits, signed));
}
function optional<T>(raw: unknown, decode: (value: unknown) => T): T | null {
  return raw === null ? null : decode(raw);
}
function owner(raw: unknown): string {
  const bytes =
    raw instanceof Uint8Array ? Array.from(raw) : list(raw, 20, 20, "owner");
  if (bytes.length !== 20) return invalid("owner");
  return bytes
    .map((b) => small(b, "owner byte", 8).toString(16).padStart(2, "0"))
    .join("");
}
function equal<T>(actual: T[], expected: T[], field: string): void {
  if (
    actual.length !== expected.length ||
    actual.some((value, i) => value !== expected[i])
  )
    invalid(field);
}

/** Copies and canonicalizes values; duplicate selectors remain errors. */
export function canonicalFinancialSelection(
  selection: FinancialStateSelection,
): FinancialStateSelection {
  if (!selection || typeof selection !== "object") return invalid("selection");
  const markets = list(selection.markets, 1, 8, "market selection")
    .map((value) => {
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > 0xffffffff
      )
        return invalid("market selection");
      return value;
    })
    .sort((a, b) => a - b);
  const owners = list(selection.owners, 1, 8, "owner selection")
    .map((value) => {
      if (typeof value !== "string" || !/^[0-9a-fA-F]{40}$/.test(value))
        return invalid("owner selection");
      return value.toLowerCase();
    })
    .sort();
  if (
    new Set(markets).size !== markets.length ||
    new Set(owners).size !== owners.length
  )
    return invalid("duplicate selection");
  return { markets, owners };
}

export function decodeFinancialState(
  raw: unknown,
  selection: FinancialStateSelection,
): FinancialState {
  const expected = canonicalFinancialSelection(selection);
  const r = tuple(raw, 8, "response");
  if (integer(r[0], "format") !== 1n) return invalid("format");
  const finalizedHeight = integer(r[1], "height");
  const finalizedTimeMs = integer(r[2], "time");
  if (finalizedHeight > 0n && finalizedTimeMs === 0n)
    return invalid("finalized time");
  const plp = optional(r[7], (value) => {
    const p = tuple(value, 4, "PLP");
    if (typeof p[3] !== "boolean") return invalid("PLP enabled");
    return {
      owner: owner(p[0]),
      bootstrapBalance: integer(p[1], "PLP balance"),
      minBalanceFloor: integer(p[2], "PLP floor"),
      enabled: p[3],
    };
  });
  let positionCount = 0;
  const accounts = list(r[3], 1, 9, "accounts").map(
    (value): FinancialAccountState => {
      const a = tuple(value, 6, "account");
      const address = owner(a[0]);
      const rawPositions = list(a[5], 0, 2048, "positions");
      positionCount += rawPositions.length;
      if (positionCount > 2048) return invalid("total positions");
      return {
        owner: address,
        balance: optional(a[1], (v) => integer(v, "balance")),
        feesAccrued: optional(a[2], (v) =>
          integer(v, "fees accrued", 64, true),
        ),
        feeOverride: optional(a[3], (v) => {
          const f = tuple(v, 2, "fee override");
          return {
            takerBps: small(f[0], "override taker"),
            makerBps: small(f[1], "override maker"),
          };
        }),
        rollingVolume: optional(a[4], (v) => {
          const f = tuple(v, 2, "rolling volume");
          return {
            lastUpdateMs: integer(f[0], "volume time"),
            volume: integer(f[1], "volume"),
          };
        }),
        positions: decodeAccountState(
          [a[0], finalizedHeight, 0, rawPositions],
          address,
        ).positions,
      };
    },
  );
  equal(
    accounts.map((a) => a.owner),
    [...new Set([...expected.owners, ...(plp ? [plp.owner] : [])])].sort(),
    "account coverage/order",
  );
  const markets = list(r[4], 1, 8, "markets").map(
    (value): FinancialMarketState => {
      const m = tuple(value, 12, "market");
      return {
        market: small(m[0], "market"),
        pool: small(m[1], "pool", 8),
        szDecimals: small(m[2], "size decimals", 8),
        makerFeeBps: small(m[3], "maker fee"),
        takerFeeBps: small(m[4], "taker fee"),
        feeTiers: list(m[5], 0, 16, "fee tiers").map((value) => {
          const f = tuple(value, 3, "fee tier");
          return {
            min30dVolumeMicroUsdc: integer(f[0], "tier volume"),
            makerFeeTenthBps: small(f[1], "tier maker", 16, true),
            takerFeeTenthBps: small(f[2], "tier taker", 16, true),
          };
        }),
        fundingIntervalMs: integer(m[6], "funding interval"),
        maxFundingRateBps: small(m[7], "max funding rate"),
        cumulativeFunding: optional(m[8], (v) =>
          integer(v, "cumulative funding", 64, true),
        ),
        fundingRateBps: optional(m[9], (v) =>
          integer(v, "funding rate", 64, true),
        ),
        lastFundingTimeMs: optional(m[10], (v) => integer(v, "funding time")),
        markEwma: optional(m[11], (v) => integer(v, "mark EWMA")),
      };
    },
  );
  equal(
    markets.map((m) => m.market),
    expected.markets,
    "market coverage/order",
  );
  const insurancePools = list(r[6], 1, 8, "insurance pools").map((value) => {
    const p = tuple(value, 2, "insurance pool");
    return {
      pool: small(p[0], "insurance pool", 8),
      balance: optional(p[1], (v) => integer(v, "insurance balance", 64, true)),
    };
  });
  equal(
    insurancePools.map((p) => p.pool),
    [...new Set(markets.map((m) => m.pool))].sort((a, b) => a - b),
    "insurance coverage/order",
  );
  return {
    format: 1,
    finalizedHeight,
    finalizedTimeMs,
    accounts,
    markets,
    feePool: optional(r[5], (v) => integer(v, "fee pool", 64, true)),
    insurancePools,
    plp,
  };
}

const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Framing/resource preflight only. Values are decoded solely by msgpack below.
 * The stack is at most eight counters; declared container lengths never allocate.
 * An admitted 2048-position snapshot uses fewer than 60k aggregate value slots.
 */
function validateMessagePackBudget(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const remaining = [1];
  let offset = 0;
  let slots = 1;
  const take = (length: number): number => {
    if (length > bytes.length - offset)
      return invalid("truncated MessagePack framing");
    const start = offset;
    offset += length;
    return start;
  };
  const size = (width: 1 | 2 | 4): number => {
    const at = take(width);
    return width === 1
      ? view.getUint8(at)
      : width === 2
        ? view.getUint16(at)
        : view.getUint32(at);
  };
  const payload = (length: number, maximum: number): void => {
    if (length > maximum) invalid("MessagePack resource limit");
    take(length);
  };
  while (remaining.length) {
    const top = remaining.length - 1;
    if (remaining[top] === 0) {
      remaining.pop();
      continue;
    }
    remaining[top]--;
    const tag = bytes[take(1)];
    let arrayLength: number | undefined;
    if (
      tag <= 0x7f ||
      tag >= 0xe0 ||
      tag === 0xc0 ||
      tag === 0xc2 ||
      tag === 0xc3
    ) {
      continue;
    } else if (tag >= 0x90 && tag <= 0x9f) {
      arrayLength = tag & 15;
    } else if (tag >= 0xa0 && tag <= 0xbf) {
      payload(tag & 31, 4);
    } else {
      switch (tag) {
        case 0xcc:
        case 0xd0:
          take(1);
          break;
        case 0xcd:
        case 0xd1:
          take(2);
          break;
        case 0xce:
        case 0xd2:
          take(4);
          break;
        case 0xcf:
        case 0xd3:
          take(8);
          break;
        case 0xd9:
          payload(size(1), 4);
          break;
        case 0xda:
          payload(size(2), 4);
          break;
        case 0xdb:
          payload(size(4), 4);
          break;
        case 0xc4:
          payload(size(1), 20);
          break;
        case 0xc5:
          payload(size(2), 20);
          break;
        case 0xc6:
          payload(size(4), 20);
          break;
        case 0xdc:
          arrayLength = size(2);
          break;
        case 0xdd:
          arrayLength = size(4);
          break;
        // No floats, maps, extension payloads or reserved tags occur in this DTO.
        default:
          invalid("MessagePack resource limit");
      }
    }
    if (arrayLength !== undefined) {
      slots += arrayLength;
      if (arrayLength > 2048 || slots > 65536)
        invalid("MessagePack resource limit");
      if (arrayLength > 0) {
        if (remaining.length >= 8) invalid("MessagePack depth limit");
        remaining.push(arrayLength);
      }
    }
  }
  if (offset !== bytes.length) invalid("trailing MessagePack bytes");
}

/** Internal public-read transport: no direct-node fallback, retry or valuation defaults. */
export async function fetchFinancialState(
  gatewayUrl: string,
  selection: FinancialStateSelection,
): Promise<FinancialState> {
  const expected = canonicalFinancialSelection(selection);
  const url = `${gatewayUrl}/v1/financial/state?markets=${expected.markets.join(",")}&owners=${expected.owners.join(",")}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(`financial state HTTP ${response.status}`);
    const contentLength = response.headers.get("content-length");
    if (
      contentLength !== null &&
      (!/^\d+$/.test(contentLength) ||
        Number(contentLength) > MAX_RESPONSE_BYTES)
    )
      return invalid("response size");
    reader = response.body?.getReader();
    if (!reader) return invalid("response body");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "";
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_RESPONSE_BYTES) return invalid("response size");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const json: unknown = JSON.parse(text);
    if (
      !json ||
      typeof json !== "object" ||
      Array.isArray(json) ||
      Object.keys(json).length !== 1 ||
      !("data" in json) ||
      typeof json.data !== "string" ||
      !json.data.length
    )
      return invalid("response wrapper");
    const data = json.data;
    if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
      return invalid("base64");
    const binary = atob(data);
    if (btoa(binary) !== data) return invalid("canonical base64");
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    validateMessagePackBudget(bytes);
    return decodeFinancialState(
      new Decoder({
        useBigInt64: true,
        maxArrayLength: 2048,
        maxMapLength: 0,
        maxStrLength: 4,
        maxBinLength: 20,
        maxExtLength: 0,
      }).decode(bytes),
      expected,
    );
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await reader?.cancel().catch(() => undefined);
  }
}
