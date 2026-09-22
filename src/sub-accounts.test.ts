import { describe, expect, it } from "vitest";
import { encode as msgpackEncode } from "@msgpack/msgpack";
import { decodeSubAccountList, type SubAccountListRow } from "./sub-accounts.js";

const MASTER = new Uint8Array(20).fill(0xaa);
const CHILD_A = new Uint8Array(20).fill(0x11);
const CHILD_B = new Uint8Array(20).fill(0x22);

const NAME_A = new Uint8Array(32);
NAME_A.set(new TextEncoder().encode("grid"));
const NAME_B = new Uint8Array(32);
NAME_B.set(new TextEncoder().encode("basis"));

function envelope(payload: unknown): Record<string, string> {
  return { data: btoa(String.fromCharCode(...msgpackEncode(payload))) };
}

/** Wire-shaped registry row: named map, snake_case, bins for fixed fields. */
function wireRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub_addr: CHILD_A,
    master: MASTER,
    id: 1,
    name: NAME_A,
    created_height: 947727,
    ...overrides,
  };
}

describe("decodeSubAccountList", () => {
  it("decodes the gateway envelope into typed rows", () => {
    const rows = decodeSubAccountList(
      envelope([wireRow(), wireRow({ sub_addr: CHILD_B, id: 2, name: NAME_B })]),
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

  it("accepts an empty registry", () => {
    expect(decodeSubAccountList(envelope([]))).toEqual([]);
  });

  it("accepts fixed byte fields as plain arrays (serde without serde_bytes)", () => {
    const rows = decodeSubAccountList(
      envelope([wireRow({ sub_addr: Array.from(CHILD_A) })]),
    );
    expect(rows[0]?.address).toBe("11".repeat(20));
  });

  it("strips NUL padding from names", () => {
    const rows = decodeSubAccountList(envelope([wireRow()]));
    expect(rows[0]?.name).toBe("grid");
    expect(rows[0]?.name.length).toBe(4);
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
    expect(() =>
      decodeSubAccountList(envelope({ sub_addr: CHILD_A })),
    ).toThrow(/expected an array/);
  });

  it("rejects rows with wrong shapes and fields", () => {
    expect(() => decodeSubAccountList(envelope([null]))).toThrow(/named map/);
    expect(() => decodeSubAccountList(envelope([[1, 2, 3]]))).toThrow(
      /named map/,
    );
    // Missing created_height:
    expect(() =>
      decodeSubAccountList(envelope([
        { sub_addr: CHILD_A, master: MASTER, id: 1, name: NAME_A },
      ])),
    ).toThrow(/created_height/);
    // Renamed field — the wire names are snake_case and exact:
    expect(() =>
      decodeSubAccountList(envelope([
        { subAddr: CHILD_A, master: MASTER, id: 1, name: NAME_A, created_height: 1 },
      ])),
    ).toThrow(/sub_addr/);
  });

  it("rejects bad field values", () => {
    // id 0 is not a valid child id; the engine rejects it at create:
    expect(() =>
      decodeSubAccountList(envelope([wireRow({ id: 0 })])),
    ).toThrow(/not a valid child id/);
    expect(() =>
      decodeSubAccountList(envelope([wireRow({ id: 1.5 })])),
    ).toThrow(/id/);
    expect(() =>
      decodeSubAccountList(envelope([wireRow({ id: 0x100000000 })])),
    ).toThrow(/id range/);
    // Short address:
    expect(() =>
      decodeSubAccountList(envelope([wireRow({ sub_addr: CHILD_A.slice(0, 19) })])),
    ).toThrow(/sub_addr length/);
    // Negative height:
    expect(() =>
      decodeSubAccountList(envelope([wireRow({ created_height: -1 })])),
    ).toThrow(/created_height/);
  });

  it("rejects duplicate ids and duplicate addresses", () => {
    expect(() =>
      decodeSubAccountList(envelope([wireRow(), wireRow()])),
    ).toThrow(/duplicate id 1/);
    expect(() =>
      decodeSubAccountList(
        envelope([wireRow(), wireRow({ id: 2, sub_addr: CHILD_A })]),
      ),
    ).toThrow(/duplicate address/);
  });
});
