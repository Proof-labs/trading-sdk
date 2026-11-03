import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "./crypto.js";
import {
  canonicalBase64,
  hash32,
  invalidRead,
  rfc3339,
} from "./read-values.js";
export { I64_MAX } from "./read-values.js";
import type { Hash32Hex } from "./read-values.js";
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
export function events(
  value: unknown,
  limits = { maxEvents: MAX_EVENTS, maxAttributes: MAX_ATTRIBUTES },
): TransactionEvidenceEvent[] {
  // These defaults are defined by abci/types/types.pb.go, not inferred success.
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid("events");
  if (value.length > limits.maxEvents) invalid("event limit", "limit");
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
      if (attributes > limits.maxAttributes)
        invalid("attribute limit", "limit");
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

/** CometBFT `Txs.Hash()`: the RFC 6962 Merkle root (leaf prefix 0x00, inner
 * prefix 0x01, SHA-256) over the SHA-256 of each transaction, in block order.
 * An empty block hashes to SHA-256 of the empty string. */
export function transactionsRoot(transactions: Uint8Array[]): Hash32Hex {
  return hash32(bytesToHex(merkleRoot(transactions.map((tx) => sha256(tx)))));
}
function merkleRoot(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return sha256(new Uint8Array());
  if (leaves.length === 1) return sha256(prefixed(0, leaves[0]));
  let split = 1;
  while (split * 2 < leaves.length) split *= 2;
  const left = merkleRoot(leaves.slice(0, split));
  const right = merkleRoot(leaves.slice(split));
  const inner = new Uint8Array(1 + left.length + right.length);
  inner[0] = 1;
  inner.set(left, 1);
  inner.set(right, 1 + left.length);
  return sha256(inner);
}
function prefixed(prefix: number, value: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + value.length);
  out[0] = prefix;
  out.set(value, 1);
  return out;
}
/** Binds a block's decoded transaction list to its header's `data_hash`, so a
 * dropped, added or reordered transaction is refused, not merely mismatched. */
export function bindBlockTransactions(
  response: Record<string, unknown>,
  transactions: Uint8Array[],
): void {
  const header = object(object(response.block, "block").header, "block header");
  if (
    hash(header.data_hash, "block data hash") !== transactionsRoot(transactions)
  )
    invalid("block transactions root", "binding");
}
