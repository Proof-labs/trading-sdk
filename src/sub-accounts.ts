/** Sub-account registry read (ProofOfBrain `delivery/epics/sub-accounts.md`,
 *  §Reads). The gateway serves `POST /info {"type":"subAccountList","user"}`
 *  by proxying the node's `GET /v1/sub_accounts/{addr}` verbatim, so the body
 *  is the house envelope `{"data": "<base64 msgpack>"}`. The inner payload is
 *  a msgpack array of registry rows in the wire `SubAccount` shape
 *  (`sub_addr`, `master`, `id`, `name`, `created_height`; fixed byte fields
 *  as bins under serde_bytes, decoded as either Uint8Array or number[]).
 *
 *  Fail-closed like every decode module here: a malformed envelope, row or
 *  field throws rather than degrading a value-bearing read to empty state.
 *  The node route answers 501 until the engine's registry query ships —
 *  callers must treat that HTTP status as "not yet available", never as an
 *  empty registry. */
import { decode as msgpackDecode } from "@msgpack/msgpack";

export interface SubAccountListRow {
  /** Derived child address, 40-char lowercase hex, no `0x` prefix. */
  address: string;
  /** Registering master, 40-char lowercase hex, no `0x` prefix. */
  master: string;
  /** Client-chosen id, 1..=0xFFFFFFFF, unique per master, never reused. */
  id: number;
  /** Display name, UTF-8, trailing NUL padding stripped. */
  name: string;
  /** Consensus height at which the child was registered. */
  createdHeight: bigint;
}

/** Decode budget, not a business rule: the engine bounds the registry
 *  (per-owner ceiling plus a global bound); this only stops a hostile or
 *  garbled payload from allocating unbounded rows. Generous against any
 *  decided limit, so a legitimate registry never trips it. */
const MAX_ROWS = 4096;

function invalid(detail: string): never {
  throw new Error(`sub-account list decode: ${detail}`);
}

/** serde encodes `[u8; N]` as a msgpack ARRAY, but `serde_bytes`-tagged
 *  fields arrive as BIN — accept both, require the exact byte length. */
function fixedBytes(value: unknown, length: number, field: string): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length !== length) return invalid(`${field} length`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length !== length) return invalid(`${field} length`);
    if (value.some((b) => typeof b !== "number" || b < 0 || b > 255))
      return invalid(`${field} byte`);
    return Uint8Array.from(value as number[]);
  }
  return invalid(`${field} encoding`);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function rowId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    return invalid("id");
  if (value < 1 || value > 0xffffffff)
    return invalid("id range (1..=0xFFFFFFFF, 0 is not a valid child id)");
  return value;
}

function createdHeight(value: unknown): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value))
    value = BigInt(value);
  if (
    typeof value !== "bigint" ||
    value < 0n ||
    value >= 1n << 64n
  )
    return invalid("created_height");
  return value;
}

function rowName(value: unknown): string {
  const bytes = fixedBytes(value, 32, "name");
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  return new TextDecoder().decode(bytes.slice(0, end));
}

function decodeRow(raw: unknown): SubAccountListRow {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return invalid("row (expected a named map)");
  const row = raw as Record<string, unknown>;
  return {
    address: hex(fixedBytes(row.sub_addr, 20, "sub_addr")),
    master: hex(fixedBytes(row.master, 20, "master")),
    id: rowId(row.id),
    name: rowName(row.name),
    createdHeight: createdHeight(row.created_height),
  };
}

/** Decode a `/info` `subAccountList` response: validate the
 *  `{"data": "<base64 msgpack>"}` envelope, decode the msgpack array of
 *  named-map registry rows, and return typed rows. Throws on any deviation —
 *  including duplicate ids or addresses, which the registry never emits. */
export function decodeSubAccountList(body: unknown): SubAccountListRow[] {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return invalid("envelope (expected an object with a data field)");
  const data = (body as Record<string, unknown>).data;
  if (typeof data !== "string" || data.length === 0)
    return invalid("envelope data (expected base64 msgpack)");
  let bytes: Uint8Array;
  try {
    const binary = atob(data);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    return invalid("envelope data (invalid base64)");
  }
  let payload: unknown;
  try {
    payload = msgpackDecode(bytes);
  } catch {
    return invalid("payload (invalid msgpack)");
  }
  if (!Array.isArray(payload)) return invalid("payload (expected an array)");
  if (payload.length > MAX_ROWS)
    return invalid(`payload length (exceeds ${MAX_ROWS} rows)`);
  const seenIds = new Set<number>();
  const seenAddresses = new Set<string>();
  return payload.map((raw): SubAccountListRow => {
    const row = decodeRow(raw);
    if (seenIds.has(row.id)) return invalid(`duplicate id ${row.id}`);
    if (seenAddresses.has(row.address)) return invalid("duplicate address");
    seenIds.add(row.id);
    seenAddresses.add(row.address);
    return row;
  });
}
