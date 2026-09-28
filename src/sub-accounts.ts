/** Sub-account registry read. The gateway serves
 *  `POST /info {"type":"subAccountList","user"}` by proxying the node's
 *  `GET /v1/sub_accounts/{addr}` verbatim, so the body is the house envelope
 *  `{"data": "<base64 msgpack>"}`. The inner payload is a msgpack array of
 *  `proof-wire` `SubAccount` rows. rmp-serde encodes each row as a positional
 *  array `[master, sub_account_id, address, name, created_height]`, and each
 *  fixed byte field as an array of integers (a bin is accepted too).
 *
 *  Fail-closed like every decode module here: a malformed envelope, row or
 *  field throws rather than degrading a value-bearing read to empty state.
 *  An HTTP 501 from the route means the registry query is not available,
 *  never an empty registry. */
import { Decoder } from "@msgpack/msgpack";

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

/** `wire_bytes` encodes `[u8; N]` as a msgpack ARRAY of integers; a BIN is
 *  accepted too. Either way the exact byte length is required. */
function fixedBytes(value: unknown, length: number, field: string): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length !== length) return invalid(`${field} length`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length !== length) return invalid(`${field} length`);
    if (value.some((b) => !Number.isInteger(b) || b < 0 || b > 255))
      return invalid(`${field} byte`);
    return Uint8Array.from(value as number[]);
  }
  return invalid(`${field} encoding`);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function rowId(value: unknown): number {
  // A 64-bit msgpack integer decodes as a bigint; it is still an id, only
  // out of range.
  if (typeof value !== "bigint" && !Number.isSafeInteger(value))
    return invalid("id");
  const id = value as number | bigint;
  if (id < 1 || id > 0xffffffff)
    return invalid("id range (1..=0xFFFFFFFF, 0 is not a valid child id)");
  return Number(id);
}

function createdHeight(value: unknown): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value))
    value = BigInt(value);
  if (typeof value !== "bigint" || value < 0n || value >= 1n << 64n)
    return invalid("created_height");
  return value;
}

function rowName(value: unknown): string {
  const bytes = fixedBytes(value, 32, "name");
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.slice(0, end),
    );
  } catch {
    return invalid("name (invalid UTF-8)");
  }
}

/** Wire field count of `SubAccount`. Later fields are appended as optional,
 *  so a longer row still decodes; a shorter one is malformed. */
const ROW_FIELDS = 5;

function decodeRow(raw: unknown): SubAccountListRow {
  if (!Array.isArray(raw)) return invalid("row (expected a positional array)");
  if (raw.length < ROW_FIELDS)
    return invalid(`row (expected ${ROW_FIELDS} fields, got ${raw.length})`);
  const [master, id, address, name, height] = raw;
  return {
    address: hex(fixedBytes(address, 20, "address")),
    master: hex(fixedBytes(master, 20, "master")),
    id: rowId(id),
    name: rowName(name),
    createdHeight: createdHeight(height),
  };
}

/** Decode a `/info` `subAccountList` response: validate the
 *  `{"data": "<base64 msgpack>"}` envelope, decode the msgpack array of
 *  positional registry rows, and return typed rows. Throws on any deviation —
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
    payload = new Decoder({ useBigInt64: true }).decode(bytes);
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
