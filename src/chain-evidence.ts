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
export const I64_MAX = (1n << 63n) - 1n;

export function invalid(field: string): never {
  throw new Error(`Invalid transaction evidence: ${field}`);
}
export function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(field);
  return value as Record<string, unknown>;
}
export function hash(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-fA-F0-9]{64}$/.test(value))
    invalid(field);
  return (value as string).toUpperCase();
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
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > Math.ceil(MAX_TX_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    invalid(field);
  const text = atob(value as string);
  if (text.length > MAX_TX_BYTES || btoa(text) !== value) invalid(field);
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
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
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
  )
    invalid("block time");
  const parsed = new Date(value as string);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 19) !== (value as string).slice(0, 19)
  )
    invalid("block time");
  return value as string;
}
