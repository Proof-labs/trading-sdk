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
    expect(() =>
      decodeSubAccountList(envelope([wireRow({ subAccountId: 1.5 })])),
    ).toThrow(/id/);
    expect(() =>
      decodeSubAccountList(envelope([wireRow({ subAccountId: 0x100000000 })])),
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
});
