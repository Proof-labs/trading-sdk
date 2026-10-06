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

function rowName(bytes: Uint8Array): string {
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

/** `proof-wire SubAccount` is a positional array read by two functions: the
 *  raw-byte float walk and `decodeRow`. This schema is their single source of
 *  field order, diagnostic names and fixed byte widths. Later fields are
 *  appended as optional, so a longer row still decodes; a shorter one is
 *  malformed. */
const ROW_SCHEMA = [
  { kind: "bytes", name: "master", bytes: 20 },
  { kind: "id", name: "id" },
  { kind: "bytes", name: "address", bytes: 20 },
  { kind: "bytes", name: "name", bytes: 32 },
  { kind: "height", name: "created_height" },
] as const;

const ROW_FIELDS = ROW_SCHEMA.length;

// ─── raw MessagePack float walk ────────────────────────────────────────────
// `@msgpack/msgpack` decodes the float families (0xca/0xcb) into the same JS
// number as an integer, so `Number.isSafeInteger` cannot tell a wire uint
// from an integral float. `proof-wire SubAccount` has no float field, so an
// integral float in any known position is malformed bytes regardless of its
// value — and the Python decoder already rejects those rows, because Python
// keeps float and int distinct. This walk is the byte-level equivalent, run
// over the raw payload before the value decode.
//
// The walk only ever ADDS rejections: when the bytes deviate from the strict
// shape in any other way it stands down and lets the value decode produce
// its message (every payload the decoder accepts parses cleanly here, so a
// float in a known position can never slip past a stand-down). Fields past
// the five-field prefix are future-optional and skipped generically — their
// types are not constrained, floats included.

/** Payload width in bytes of the integer leads the walk steps over. */
const INTEGER_WIDTH: Record<number, number> = {
  0xcc: 1, // uint8
  0xcd: 2, // uint16
  0xce: 4, // uint32
  0xcf: 8, // uint64
  0xd0: 1, // int8
  0xd1: 2, // int16
  0xd2: 4, // int32
  0xd3: 8, // int64
};

/** Payload width in bytes of the float leads rejected in an integer
 *  position. */
const FLOAT_WIDTH: Record<number, number> = {
  0xca: 4, // float32
  0xcb: 8, // float64
};

/** Width in bytes of the length field of bin, str and ext leads. */
const LENGTH_WIDTH: Record<number, number> = {
  0xc4: 1, // bin8
  0xc5: 2, // bin16
  0xc6: 4, // bin32
  0xd9: 1, // str8
  0xda: 2, // str16
  0xdb: 4, // str32
  0xc7: 1, // ext8
  0xc8: 2, // ext16
  0xc9: 4, // ext32
};

/** Ext leads carry one extra type byte between the length and the payload. */
const EXT_LEADS = new Set([0xc7, 0xc8, 0xc9]);

/** Total width in bytes of a fixext value (lead + type byte + payload). */
const FIXEXT_WIDTH: Record<number, number> = {
  0xd4: 3, // fixext1
  0xd5: 4, // fixext2
  0xd6: 6, // fixext4
  0xd7: 10, // fixext8
  0xd8: 18, // fixext16
};

/** Read a big-endian unsigned integer of `width` bytes at `offset`, or null
 *  when it runs past the end of the buffer. MessagePack length fields are at
 *  most four bytes wide, so a JS number holds them exactly. */
function readLength(
  bytes: Uint8Array,
  offset: number,
  width: number,
): number | null {
  let value = 0;
  for (let i = 0; i < width; i++) {
    const byte = bytes[offset + i];
    if (byte === undefined) return null;
    value = value * 256 + byte;
  }
  return value;
}

/** Offset past an integer field, or null when the bytes are anything else
 *  (the decoder's verdict, not this walk's). Signed encodings are stepped
 *  over, not stood down on: the decoder accepts a non-negative value in them
 *  and rejects a negative one itself, and a stand-down here would end the
 *  walk for every later row. A float family byte in this position is the one
 *  thing that throws: the decoder would silently accept it when the value
 *  happens to be integral. */
function walkIntegerOffset(
  bytes: Uint8Array,
  offset: number,
  field: string,
): number | null {
  const lead = bytes[offset];
  if (lead === undefined) return null;
  if (lead in FLOAT_WIDTH)
    return invalid(`${field} (msgpack float where the wire has an integer)`);
  if (lead <= 0x7f || lead >= 0xe0) return offset + 1; // (negative) fixint
  const width = INTEGER_WIDTH[lead];
  if (width === undefined) return null;
  const end = offset + 1 + width;
  return end <= bytes.length ? end : null;
}

/** Offset past a fixed-length byte field — a bin of exactly `length` bytes,
 *  or an array of exactly `length` unsigned bytes. */
function walkFixedBytesOffset(
  bytes: Uint8Array,
  offset: number,
  length: number,
  field: string,
): number | null {
  const lead = bytes[offset];
  if (lead === undefined) return null;
  if (lead === 0xc4 || lead === 0xc5 || lead === 0xc6) {
    const width = lead === 0xc4 ? 1 : lead === 0xc5 ? 2 : 4; // bin8/16/32
    const size = readLength(bytes, offset + 1, width);
    if (size !== length) return null; // decoder: `${field} length`
    const end = offset + 1 + width + size;
    return end <= bytes.length ? end : null;
  }
  const array = walkArrayHeader(bytes, offset);
  if (!array) return null; // decoder: `${field} encoding`
  if (array.count !== length) return null; // decoder: `${field} length`
  let o = array.next;
  for (let i = 0; i < length; i++) {
    const next = walkIntegerOffset(bytes, o, `${field} byte`);
    if (next === null) return null;
    o = next;
  }
  return o;
}

/** Array header — element count and the offset of the first element. */
function walkArrayHeader(
  bytes: Uint8Array,
  offset: number,
): { count: number; next: number } | null {
  const lead = bytes[offset];
  if (lead === undefined) return null;
  if (lead >= 0x90 && lead <= 0x9f)
    return { count: lead & 0x0f, next: offset + 1 }; // fixarray
  if (lead === 0xdc || lead === 0xdd) {
    const width = lead === 0xdc ? 2 : 4; // array16 / array32
    const count = readLength(bytes, offset + 1, width);
    if (count === null) return null;
    return { count, next: offset + 1 + width };
  }
  return null;
}

/** Offset past any single well-formed value — used only for the fields past
 *  the five-field prefix, whose types are unconstrained. Bounds and depth
 *  failures stand down to the decoder. */
function walkExtraValueOffset(
  bytes: Uint8Array,
  offset: number,
  depth: number,
): number | null {
  if (depth > 32) return null;
  const lead = bytes[offset];
  if (lead === undefined) return null;
  if (lead <= 0x7f || lead >= 0xe0) return offset + 1; // (negative) fixint
  if (lead >= 0xa0 && lead <= 0xbf) {
    const end = offset + 1 + (lead & 0x1f); // fixstr
    return end <= bytes.length ? end : null;
  }
  if (lead === 0xc0 || lead === 0xc2 || lead === 0xc3) return offset + 1; // nil, false, true
  const scalar = INTEGER_WIDTH[lead] ?? FLOAT_WIDTH[lead];
  if (scalar !== undefined) {
    const end = offset + 1 + scalar;
    return end <= bytes.length ? end : null;
  }
  const fixext = FIXEXT_WIDTH[lead];
  if (fixext !== undefined) {
    const end = offset + fixext;
    return end <= bytes.length ? end : null;
  }
  // bin, str and ext with an explicit length: lead byte, the big-endian
  // length, and for ext one more byte carrying the extension type.
  const lengthWidth = LENGTH_WIDTH[lead];
  if (lengthWidth !== undefined) {
    const size = readLength(bytes, offset + 1, lengthWidth);
    if (size === null) return null;
    const typeByte = EXT_LEADS.has(lead) ? 1 : 0;
    const end = offset + 1 + lengthWidth + typeByte + size;
    return end <= bytes.length ? end : null;
  }
  const array = walkArrayHeader(bytes, offset);
  if (array) {
    let o = array.next;
    for (let i = 0; i < array.count; i++) {
      const next = walkExtraValueOffset(bytes, o, depth + 1);
      if (next === null) return null;
      o = next;
    }
    return o;
  }
  // Map: count pairs.
  let count = 0;
  let mapHeader = 0;
  if (lead >= 0x80 && lead <= 0x8f) {
    count = lead & 0x0f;
    mapHeader = 1;
  } else if (lead === 0xde || lead === 0xdf) {
    mapHeader = lead === 0xde ? 3 : 5;
    for (let i = 1; i < mapHeader; i++) count = count * 256 + bytes[offset + i];
  } else {
    return null;
  }
  let o = offset + mapHeader;
  for (let i = 0; i < count * 2; i++) {
    const next = walkExtraValueOffset(bytes, o, depth + 1);
    if (next === null) return null;
    o = next;
  }
  return o;
}

/** Throw on an integral float in any known position of the wire shape. */
function rejectFloatsInSubAccountWire(bytes: Uint8Array): void {
  const outer = walkArrayHeader(bytes, 0);
  if (!outer) return;
  let o = outer.next;
  for (let r = 0; r < outer.count; r++) {
    const row = walkArrayHeader(bytes, o);
    if (!row || row.count < ROW_FIELDS) return;
    o = row.next;
    for (const field of ROW_SCHEMA) {
      const next =
        field.kind === "bytes"
          ? walkFixedBytesOffset(bytes, o, field.bytes, field.name)
          : walkIntegerOffset(bytes, o, field.name);
      if (next === null) return;
      o = next;
    }
    for (let e = ROW_FIELDS; e < row.count; e++) {
      const next = walkExtraValueOffset(bytes, o, 0);
      if (next === null) return;
      o = next;
    }
  }
}

function decodeRow(raw: unknown): SubAccountListRow {
  if (!Array.isArray(raw)) return invalid("row (expected a positional array)");
  if (raw.length < ROW_FIELDS)
    return invalid(`row (expected ${ROW_FIELDS} fields, got ${raw.length})`);
  const [master, id, address, name, height] = raw;
  return {
    master: hex(fixedBytes(master, ROW_SCHEMA[0].bytes, ROW_SCHEMA[0].name)),
    id: rowId(id),
    address: hex(fixedBytes(address, ROW_SCHEMA[2].bytes, ROW_SCHEMA[2].name)),
    name: rowName(fixedBytes(name, ROW_SCHEMA[3].bytes, ROW_SCHEMA[3].name)),
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
  rejectFloatsInSubAccountWire(bytes);
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
