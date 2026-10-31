import {
  canonicalBase64,
  hash32,
  invalidRead,
  rfc3339,
} from "./read-values.js";
export { I64_MAX } from "./read-values.js";
/** Internal structural decoders shared by trusted-gateway evidence reads. */
/** Comet event strings are retained verbatim, not decoded as economic facts.
 * Optional attribute fields preserve protobuf JSON's omitted default values. */
export interface TransactionEvidenceEvent {
  type: string;
  attributes?: {
    key?: string;
    value?: string;
    index?: boolean;
  }[];
}

export const MAX_TX_BYTES = 1024 * 1024;
export const MAX_BLOCK_TXS = 100_000;
export const MAX_EVENTS = 4096;
export const MAX_ATTRIBUTES = 4096;

export function invalid(
  field: string,
  kind: import("./errors.js").GatewayReadError["kind"] = "malformed",
): never {
  return invalidRead(field, kind);
}
export function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(field);
  return value as Record<string, unknown>;
}
export function hash(value: unknown, field: string) {
  return hash32(value, field);
}
export function uint(value: unknown, max: bigint, field: string): bigint {
  if (!(
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === "string" &&
      value.length <= 20 &&
      /^(0|[1-9][0-9]*)$/.test(value))
  ))
    invalid(field);
  const n = BigInt(value as string | number);
  if (n > max) invalid(field);
  return n;
}
export function bytes(value: unknown, field: string): Uint8Array {
  return canonicalBase64(value, field, MAX_TX_BYTES);
}
export function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
export function rpcResult(value: unknown): Record<string, unknown> {
  const response = object(value, "RPC envelope");
  if (response.error !== undefined) invalid("RPC error");
  if (response.jsonrpc !== "2.0") invalid("RPC version");
  return object(response.result, "RPC result");
}
export function events(value: unknown): TransactionEvidenceEvent[] {
  // These defaults are defined by abci/types/types.pb.go, not inferred success.
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_EVENTS) invalid("events");
  let attributes = 0;
  return value.map((entry) => {
    const event = object(entry, "event");
    if (
      typeof event.type !== "string" ||
      event.type.length === 0 ||
      event.type.length > 1024
    )
      invalid("event type");
    const result: TransactionEvidenceEvent = { type: event.type as string };
    if (event.attributes !== undefined) {
      if (!Array.isArray(event.attributes)) invalid("event attributes");
      attributes += (event.attributes as unknown[]).length;
      if (attributes > MAX_ATTRIBUTES) invalid("attribute limit");
      result.attributes = (event.attributes as unknown[]).map((value) => {
        const a = object(value, "event attribute");
        if (a.key !== undefined && typeof a.key !== "string")
          invalid("attribute key");
        if (a.value !== undefined && typeof a.value !== "string")
          invalid("attribute value");
        if (a.index !== undefined && typeof a.index !== "boolean")
          invalid("attribute index");
        return {
          ...(a.key !== undefined ? { key: a.key as string } : {}),
          ...(a.value !== undefined ? { value: a.value as string } : {}),
          ...(a.index !== undefined ? { index: a.index as boolean } : {}),
        };
      });
    }
    return result;
  });
}
export function blockTime(value: unknown): string {
  return rfc3339(value).raw;
}
