import { describe, expect, it } from "vitest";
import { encode as msgpackEncode } from "@msgpack/msgpack";
import {
  decodeSubAccountList,
  type SubAccountListRow,
} from "./sub-accounts.js";

const MASTER = new Uint8Array(20).fill(0xaa);
const CHILD_A = new Uint8Array(20).fill(0x11);
const CHILD_B = new Uint8Array(20).fill(0x22);

const NAME_A = new Uint8Array(32);
NAME_A.set(new TextEncoder().encode("grid"));
const NAME_B = new Uint8Array(32);
NAME_B.set(new TextEncoder().encode("basis"));

function envelope(payload: unknown): Record<string, string> {
  return {
    data: btoa(
      String.fromCharCode(...msgpackEncode(payload, { useBigInt64: true })),
    ),
  };
}

// ─── hand-assembled wire bytes ─────────────────────────────────────────────
// The library's encoder never emits the float families for whole numbers, so
// the float-rejection tests plant the type bytes by hand.

function rawEnvelope(bytes: Uint8Array): Record<string, string> {
  return { data: btoa(String.fromCharCode(...bytes)) };
}

function rawList(fields: Array<number | Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [
    Uint8Array.from([0x91]), // one row
    Uint8Array.from([0x90 + fields.length]), // fixarray row
    ...fields.map((f) => (typeof f === "number" ? Uint8Array.from([f]) : f)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Several hand-assembled rows in one list. */
function rawRows(rows: Array<Array<number | Uint8Array>>): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.from([0x90 + rows.length])];
  for (const fields of rows) {
    parts.push(Uint8Array.from([0x90 + fields.length]));
    for (const f of fields)
      parts.push(typeof f === "number" ? Uint8Array.from([f]) : f);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const bin8 = (payload: Uint8Array) =>
  Uint8Array.from([0xc4, payload.length, ...payload]);
const u32 = (v: number) =>
  Uint8Array.from([
    0xce,
    (v >>> 24) & 0xff,
    (v >>> 16) & 0xff,
    (v >>> 8) & 0xff,
    v & 0xff,
  ]);
const f32 = (v: number) => {
  const b = new Uint8Array(5);
  new DataView(b.buffer).setFloat32(1, v);
  b[0] = 0xca;
  return b;
};
const f64 = (v: number) => {
  const b = new Uint8Array(9);
  new DataView(b.buffer).setFloat64(1, v);
  b[0] = 0xcb;
  return b;
};

interface WireRow {
  master: unknown;
  subAccountId: unknown;
  address: unknown;
  name: unknown;
  createdHeight: unknown;
}

/** Wire-shaped registry row exactly as rmp-serde encodes `proof-wire`
 *  `SubAccount`: a positional array
 *  `[master, sub_account_id, address, name, created_height]` whose fixed
 *  byte fields are arrays of integers (`wire_bytes`). */
function wireRow(overrides: Partial<WireRow> = {}): unknown[] {
  const row: WireRow = {
    master: MASTER,
    subAccountId: 1,
    address: CHILD_A,
    name: NAME_A,
    createdHeight: 947727,
    ...overrides,
  };
  const bytes = (v: unknown) => (v instanceof Uint8Array ? Array.from(v) : v);
  return [
    bytes(row.master),
    row.subAccountId,
    bytes(row.address),
    bytes(row.name),
    row.createdHeight,
  ];
}

describe("decodeSubAccountList", () => {
  it("decodes the gateway envelope into typed rows", () => {
    const rows = decodeSubAccountList(
      envelope([
        wireRow(),
        wireRow({ address: CHILD_B, subAccountId: 2, name: NAME_B }),
      ]),
    );
    expect(rows).toEqual([
      {
        address: "11".repeat(20),
        master: "aa".repeat(20),
        id: 1,
        name: "grid",
        createdHeight: 947727n,
      },
      {
        address: "22".repeat(20),
        master: "aa".repeat(20),
        id: 2,
        name: "basis",
        createdHeight: 947727n,
      },
    ] satisfies SubAccountListRow[]);
  });

  it("decodes the exact bytes rmp-serde emits for a SubAccount list", () => {
    // `rmp_serde::to_vec(&vec![SubAccount { master: [0xaa; 20],
    // sub_account_id: 7, address: [0x11; 20], name: b"ok" + NUL padding,
    // created_height: 947727 }])`, built by hand: rmp-serde writes each
    // `wire_bytes` field as an array of minimally encoded integers.
    const u8Array = (bytes: number[]) => [
      0xdc,
      0x00,
      bytes.length,
      ...bytes.flatMap((b) => (b < 0x80 ? [b] : [0xcc, b])),
    ];
    const name = Array<number>(32).fill(0);
    name[0] = 0x6f; // "o"
    name[1] = 0x6b; // "k"
    const bytes = new Uint8Array([
      0x91, // list of 1 row
      0x95, // row: positional array of 5 fields
      ...u8Array(Array<number>(20).fill(0xaa)), // master
      0x07, // sub_account_id
      ...u8Array(Array<number>(20).fill(0x11)), // address
      ...u8Array(name), // name
      0xce,
      0x00,
      0x0e,
      0x76,
      0x0f, // created_height = 947727 (uint32)
    ]);
    const rows = decodeSubAccountList({
      data: btoa(String.fromCharCode(...bytes)),
    });
    expect(rows).toEqual([
      {
        address: "11".repeat(20),
        master: "aa".repeat(20),
        id: 7,
        name: "ok",
        createdHeight: 947727n,
      },
    ] satisfies SubAccountListRow[]);
  });

  it("accepts an empty registry", () => {
    expect(decodeSubAccountList(envelope([]))).toEqual([]);
  });

  it("accepts fixed byte fields as bins", () => {
    const row = wireRow();
    row[2] = CHILD_A;
    const rows = decodeSubAccountList(envelope([row]));
    expect(rows[0]?.address).toBe("11".repeat(20));
  });

  it("accepts appended trailing fields", () => {
    const rows = decodeSubAccountList(envelope([[...wireRow(), null]]));
    expect(rows[0]?.id).toBe(1);
  });

  it("strips NUL padding from names", () => {
    const rows = decodeSubAccountList(envelope([wireRow()]));
    expect(rows[0]?.name).toBe("grid");
    expect(rows[0]?.name.length).toBe(4);
  });

  it("keeps a height above 2^53 exact", () => {
    const rows = decodeSubAccountList(
      envelope([wireRow({ createdHeight: 2n ** 60n })]),
    );
    expect(rows[0]?.createdHeight).toBe(2n ** 60n);
  });

  it("rejects a malformed or missing envelope", () => {
    expect(() => decodeSubAccountList(null)).toThrow(/envelope/);
    expect(() => decodeSubAccountList([])).toThrow(/envelope/);
    expect(() => decodeSubAccountList({})).toThrow(/envelope data/);
    expect(() => decodeSubAccountList({ data: "!!not-base64!!" })).toThrow(
      /invalid base64/,
    );
    expect(() => decodeSubAccountList({ data: btoa("garbage") })).toThrow(
      /invalid msgpack/,
    );
  });

  it("rejects a non-array payload", () => {
    expect(() => decodeSubAccountList(envelope({ address: CHILD_A }))).toThrow(
      /expected an array/,
    );
  });

  it("rejects rows with the wrong shape", () => {
    expect(() => decodeSubAccountList(envelope([null]))).toThrow(
      /positional array/,
    );
    // A named map is not the wire shape:
    expect(() =>
      decodeSubAccountList(
        envelope([
          {
            sub_addr: CHILD_A,
            master: MASTER,
            id: 1,
            name: NAME_A,
            created_height: 1,
          },
        ]),
      ),
    ).toThrow(/positional array/);
    // Missing created_height:
    expect(() =>
      decodeSubAccountList(envelope([wireRow().slice(0, 4)])),
    ).toThrow(/expected 5 fields/);
  });

  it("rejects bad field values", () => {
    // id 0 is not a valid child id; the engine rejects it at create:
    expect(() =>
      decodeSubAccountList(envelope([wireRow({ subAccountId: 0 })])),
    ).toThrow(/not a valid child id/);
    // A fractional id is refused by the row decoder itself.
    expect(() =>
      decodeSubAccountList(envelope([wireRow({ subAccountId: 1.5 })])),
    ).toThrow(/id/);
    expect(() =>
      decodeSubAccountList(envelope([wireRow({ subAccountId: 2n ** 32n })])),
    ).toThrow(/id range/);
    // Short address:
    expect(() =>
      decodeSubAccountList(
        envelope([wireRow({ address: CHILD_A.slice(0, 19) })]),
      ),
    ).toThrow(/address length/);
    // Negative height:
    expect(() =>
      decodeSubAccountList(envelope([wireRow({ createdHeight: -1 })])),
    ).toThrow(/created_height/);
  });

  it("rejects non-integer bytes instead of coercing them", () => {
    // A fractional byte is refused by the row decoder; only an *integral*
    // float slips past `Number.isInteger`, and the preflight catches that.
    for (const bad of [1.9, Number.NaN]) {
      const address = Array<number>(20).fill(0x11);
      address[0] = bad;
      expect(() =>
        decodeSubAccountList(envelope([wireRow({ address })])),
      ).toThrow(/address byte/);
    }
  });

  it("rejects a name that is not UTF-8", () => {
    const name = new Uint8Array(32);
    name[0] = 0xff;
    expect(() => decodeSubAccountList(envelope([wireRow({ name })]))).toThrow(
      /invalid UTF-8/,
    );
  });

  it("rejects duplicate ids and duplicate addresses", () => {
    expect(() =>
      decodeSubAccountList(envelope([wireRow(), wireRow()])),
    ).toThrow(/duplicate id 1/);
    expect(() =>
      decodeSubAccountList(
        envelope([wireRow(), wireRow({ subAccountId: 2, address: CHILD_A })]),
      ),
    ).toThrow(/duplicate address/);
  });

  it("rejects an integral float in the id at both float widths", () => {
    // `forceIntegerToFloat`-style rows: float32/float64 holding a whole
    // number decode to the same JS number as the integer, so only the raw
    // type byte can tell them apart.
    for (const enc of [f32(1), f64(1)]) {
      expect(() =>
        decodeSubAccountList(
          rawEnvelope(
            rawList([
              bin8(MASTER),
              enc,
              bin8(CHILD_A),
              bin8(NAME_A),
              u32(947727),
            ]),
          ),
        ),
      ).toThrow(/msgpack float where the wire model has an integer/);
    }
  });

  it("rejects an integral float in created_height", () => {
    expect(() =>
      decodeSubAccountList(
        rawEnvelope(
          rawList([
            bin8(MASTER),
            0x01,
            bin8(CHILD_A),
            bin8(NAME_A),
            f64(947727),
          ]),
        ),
      ),
    ).toThrow(/msgpack float where the wire model has an integer/);
  });

  it("rejects an integral float inside the array form of a byte field", () => {
    const address = Uint8Array.from([
      0xdc,
      0x00,
      0x14, // array16 of 20
      ...f64(0x11),
      ...Array<number>(19).fill(0x11),
    ]);
    expect(() =>
      decodeSubAccountList(
        rawEnvelope(
          rawList([bin8(MASTER), 0x01, address, bin8(NAME_A), u32(1)]),
        ),
      ),
    ).toThrow(/msgpack float where the wire model has an integer/);
  });

  it("rejects a float id in a row after one with a signed-integer id", () => {
    // int8 5 is a value the decoder accepts; the walk must step over it and
    // still check the next row, as the Python decoder does.
    expect(() =>
      decodeSubAccountList(
        rawEnvelope(
          rawRows([
            [
              bin8(MASTER),
              Uint8Array.from([0xd0, 0x05]),
              bin8(CHILD_A),
              bin8(NAME_A),
              u32(1),
            ],
            [bin8(MASTER), f64(2), bin8(CHILD_B), bin8(NAME_B), u32(1)],
          ]),
        ),
      ),
    ).toThrow(/msgpack float where the wire model has an integer/);
  });

  it("rejects an extension extra field", () => {
    // ext8: lead, length 1, type 1, one data byte. No read DTO carries an
    // extension, so the shared preflight refuses it rather than stepping over.
    const ext8 = Uint8Array.from([0xc7, 0x01, 0x01, 0x00]);
    expect(() =>
      decodeSubAccountList(
        rawEnvelope(
          rawRows([
            [bin8(MASTER), 0x01, bin8(CHILD_A), bin8(NAME_A), u32(1), ext8],
            [bin8(MASTER), f64(2), bin8(CHILD_B), bin8(NAME_B), u32(1)],
          ]),
        ),
      ),
    ).toThrow(/msgpack extension where the wire model has none/);
  });

  it("walks str and map extras to a float in a later row", () => {
    const extras = [
      Uint8Array.from([0xd9, 0x02, 0x68, 0x69]), // str8 "hi"
      Uint8Array.from([0x81, 0xa1, 0x6b, 0x02]), // fixmap {"k": 2}
    ];
    for (const extra of extras) {
      expect(() =>
        decodeSubAccountList(
          rawEnvelope(
            rawRows([
              [bin8(MASTER), 0x01, bin8(CHILD_A), bin8(NAME_A), u32(1), extra],
              [bin8(MASTER), f64(2), bin8(CHILD_B), bin8(NAME_B), u32(1)],
            ]),
          ),
        ),
      ).toThrow(/msgpack float where the wire model has an integer/);
    }
  });

  it("rejects a fixext extra field", () => {
    const fixext1 = Uint8Array.from([0xd4, 0x01, 0x00]); // fixext1, type 1
    expect(() =>
      decodeSubAccountList(
        rawEnvelope(
          rawRows([
            [bin8(MASTER), 0x01, bin8(CHILD_A), bin8(NAME_A), u32(1), fixext1],
            [bin8(MASTER), f64(2), bin8(CHILD_B), bin8(NAME_B), u32(1)],
          ]),
        ),
      ),
    ).toThrow(/msgpack extension where the wire model has none/);
  });

  it("steps over a nested array extra before a later float row", () => {
    const nested = Uint8Array.from([0x92, 0x01, 0x91, 0x02]); // [1, [2]]
    expect(() =>
      decodeSubAccountList(
        rawEnvelope(
          rawRows([
            [bin8(MASTER), 0x01, bin8(CHILD_A), bin8(NAME_A), u32(1), nested],
            [bin8(MASTER), f64(2), bin8(CHILD_B), bin8(NAME_B), u32(1)],
          ]),
        ),
      ),
    ).toThrow(/msgpack float where the wire model has an integer/);
  });

  it("rejects nesting deeper than the depth bound", () => {
    // The shared preflight fails closed on over-deep nesting instead of
    // standing the walk down, so a float cannot hide behind a deep extra.
    const deep = Uint8Array.from([...Array<number>(34).fill(0x91), 0x01]);
    expect(() =>
      decodeSubAccountList(
        rawEnvelope(
          rawRows([
            [bin8(MASTER), 0x01, bin8(CHILD_A), bin8(NAME_A), u32(1), deep],
            [bin8(MASTER), f64(2), bin8(CHILD_B), bin8(NAME_B), u32(1)],
          ]),
        ),
      ),
    ).toThrow(/nesting exceeds the depth bound/);
  });

  it("does not blind-scan: float-family bytes inside a bin are data", () => {
    const master = new Uint8Array(20);
    master[0] = 0xca;
    master[1] = 0xcb;
    const rows = decodeSubAccountList(envelope([wireRow({ master })]));
    expect(rows[0]?.master.startsWith("cacb")).toBe(true);
  });

  it("rejects a float in a future optional field", () => {
    // Trailing fields may be any shape except a float: no read DTO carries one.
    expect(() => decodeSubAccountList(envelope([[...wireRow(), 1.5]]))).toThrow(
      /msgpack float where the wire model has an integer/,
    );
  });
});
