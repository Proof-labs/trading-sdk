import { afterEach, describe, expect, it, vi } from "vitest";
import { Encoder } from "@msgpack/msgpack";
import { decodeStrict, rejectFloats } from "./codec.js";
import { ExchangeClient } from "./client.js";

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

describe("strict msgpack preflight", () => {
  it("decodes an integer payload after the preflight passes", () => {
    const bytes = new Encoder().encode([1, "x", [2, 3]]);
    expect(decodeStrict(bytes as Uint8Array)).toEqual([1, "x", [2, 3]]);
  });

  it("rejects an integral float64 where the wire has an integer", () => {
    // [ 1.0 ] as an array16-of-one holding a float64.
    const bytes = Uint8Array.from([
      0x91, 0xcb, 0x3f, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(() => rejectFloats(bytes)).toThrow(/msgpack float/);
  });

  it("rejects trailing bytes and duplicate map keys", () => {
    const trailing = Uint8Array.from([0x01, 0x02]);
    expect(() => rejectFloats(trailing)).toThrow(/malformed MessagePack/);
    // fixmap {"k":1,"k":2}
    const duplicate = Uint8Array.from([
      0x82, 0xa1, 0x6b, 0x01, 0xa1, 0x6b, 0x02,
    ]);
    expect(() => rejectFloats(duplicate)).toThrow(/duplicate msgpack map key/);
  });
});

describe("gateway reads reject integral floats", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("queryOrderbook rejects a float-encoded price", async () => {
    const payload = new Encoder({ forceIntegerToFloat: true }).encode([
      [[100, 10, 1]],
      [[101, 5, 1]],
    ]);
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: toB64(payload as Uint8Array) }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;
    const client = new ExchangeClient({ gatewayUrl: "http://g", chainId: "c" });
    await expect(client.queryOrderbook(1)).rejects.toThrow(/msgpack float/);
  });
});
