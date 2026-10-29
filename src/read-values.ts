import { GatewayReadError } from "./errors.js";

declare const hexAddressBrand: unique symbol;
declare const hashBrand: unique symbol;
declare const marketBrand: unique symbol;
export type HexAddress = string & { readonly [hexAddressBrand]: true };
export type Hash32Hex = string & { readonly [hashBrand]: true };
export type MarketId = number & { readonly [marketBrand]: true };
export const U64_MAX = (1n << 64n) - 1n;
export const I64_MAX = (1n << 63n) - 1n;
export const MAX_DATE_MS = 8_640_000_000_000_000;
export const DEFAULT_READ_TIMEOUT_MS = 5_000;
export const MAX_READ_TIMEOUT_MS = 60_000;
/** Whole HTTP envelope, not decoded MessagePack. Same cap as gateway #267. */
export const MAX_READ_BYTES = 1024 * 1024;
export const MAX_READ_CHUNKS = 4096;

export function invalidRead(
  field: string,
  kind: GatewayReadError["kind"] = "malformed",
): never {
  throw new GatewayReadError(kind, field);
}
export function hexAddress(value: unknown, field = "address"): HexAddress {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value))
    invalidRead(field);
  return value as HexAddress;
}
/** Hashes use uppercase, matching CometBFT and the existing SDK tx hash. */
export function hash32(value: unknown, field = "hash"): Hash32Hex {
  if (typeof value !== "string" || !/^[a-fA-F0-9]{64}$/.test(value))
    invalidRead(field);
  return (value as string).toUpperCase() as Hash32Hex;
}
export function marketId(value: unknown): MarketId {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 0xffffffff
  )
    invalidRead("market");
  return value as MarketId;
}
export function readObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalidRead(field);
  return value as Record<string, unknown>;
}
export function canonicalBase64(
  value: unknown,
  field: string,
  maxBytes: number,
): Uint8Array {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > Math.ceil(maxBytes / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    invalidRead(field);
  const text = atob(value as string);
  if (text.length > maxBytes || btoa(text) !== value) invalidRead(field);
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}
/** Preserve nanoseconds for ordering; epoch milliseconds elsewhere are explicit units. */
export function rfc3339(
  value: unknown,
  field = "block time",
): { raw: string; nanos: bigint } {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
  )
    invalidRead(field);
  const raw = value as string;
  const ms = Date.parse(raw);
  if (
    !Number.isFinite(ms) ||
    ms < 0 ||
    new Date(ms).toISOString().slice(0, 19) !== raw.slice(0, 19)
  )
    invalidRead(field);
  const fraction = raw.slice(19, -1).replace(/^\./, "").padEnd(9, "0");
  return {
    raw,
    nanos:
      BigInt(Date.parse(`${raw.slice(0, 19)}Z`)) * 1_000_000n +
      BigInt(fraction),
  };
}
/** One monotonic deadline shared by every request in a logical read. */
export function readDeadline(options: {
  signal?: AbortSignal;
  timeoutMs?: number;
}) {
  const signal = options.signal;
  const timeoutMs = options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_READ_TIMEOUT_MS
  )
    invalidRead("timeout", "configuration");
  signal?.throwIfAborted();
  const deadline = performance.now() + timeoutMs;
  const remaining = () => {
    signal?.throwIfAborted();
    const left = Math.floor(deadline - performance.now());
    if (left < 1)
      throw new GatewayReadError(
        "deadline",
        "timeout",
        "Gateway read deadline exceeded",
      );
    return { signal, timeoutMs: left };
  };
  return { timeoutMs, remaining };
}
