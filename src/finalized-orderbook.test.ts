import { describe, expect, it, vi } from "vitest";
import { encode } from "@msgpack/msgpack";
import { ExchangeClient } from "./client.js";
import { decodeFinalizedOrderbook } from "./finalized-orderbook.js";
import type { ExchangeHttpTransport } from "./http-transport.js";

const base64 = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));

function frame(
  book: unknown = [[[100n, 9007199254740993n, 2]], [[110n, 3n, 1]]],
) {
  const data = base64(encode(book, { useBigInt64: true }));
  return {
    market: "1",
    depth: "20",
    height: 50,
    data,
    bookMsgpackB64: data,
    witness: {
      version: 1,
      nodeId: "ab".repeat(20),
      height: "50",
      finalizedBlockTimeMs: "1000",
      appHash: "cd".repeat(32),
    },
  };
}
describe("finalized orderbook read", () => {
  it("preserves exact units, zero-priced levels, height and bounded depth", () => {
    expect(decodeFinalizedOrderbook(frame(), 1)).toEqual({
      market: 1,
      depth: 20,
      height: 50n,
      bids: [{ price: 100n, totalQty: 9007199254740993n, orderCount: 2 }],
      asks: [{ price: 110n, totalQty: 3n, orderCount: 1 }],
      witness: {
        version: 1,
        nodeId: "ab".repeat(20),
        height: 50n,
        finalizedBlockTimeMs: 1000n,
        appHash: "cd".repeat(32),
      },
    });
    expect(
      decodeFinalizedOrderbook(frame([[[0, 1, 1]], []]), 1).bids[0].price,
    ).toBe(0n);
  });
  it("uses only the additive gateway snapshot route and injected transport without a signer", async () => {
    const transport = vi.fn<ExchangeHttpTransport>(
      async () => new Response(JSON.stringify({ ...frame(), depth: "100" })),
    );
    const client = new ExchangeClient({
      gatewayUrl: "https://gateway.example/",
      useGateway: false,
      rpcUrl: "https://unreachable-rpc.example",
      apiUrl: "https://unreachable-node.example",
      httpTransport: transport,
    });
    expect(
      (await client.queryFinalizedOrderbook(1, { depth: 100 })).height,
    ).toBe(50n);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0]).toBe(
      "https://gateway.example/v1/orderbook-snapshot/1?depth=100",
    );
    expect(transport.mock.calls[0][1]).toMatchObject({
      method: "GET",
      cache: "no-store",
      redirect: "error",
    });
    expect(transport.mock.calls[0][2]).toMatchObject({
      purpose: "query",
      surface: "api_orderbook_snapshot",
    });
  });
  it.each([
    { height: undefined },
    { height: 0 },
    { height: -1 },
    { height: 1.5 },
    { height: Number.MAX_SAFE_INTEGER + 1 },
    { height: "50" },
    { market: "2" },
    { market: 1 },
    { depth: "100" },
    { depth: undefined },
    { bookMsgpackB64: "kA==" },
    { data: "kA==" },
    { bookMsgpackB64: undefined },
    { witness: undefined },
    { witness: { ...frame().witness, height: "49" } },
    { witness: { ...frame().witness, height: 50 } },
    { witness: { ...frame().witness, nodeId: "" } },
    { witness: { ...frame().witness, appHash: "bad" } },
    { witness: { ...frame().witness, finalizedBlockTimeMs: "0" } },
  ])("rejects missing, unsafe or mismatched envelope facts: %j", (changes) => {
    expect(() =>
      decodeFinalizedOrderbook({ ...frame(), ...changes }, 1),
    ).toThrow();
  });
  it("refuses unheighted cached data, malformed levels, duplicates and depth truncation mismatches", () => {
    expect(() => decodeFinalizedOrderbook({ data: frame().data }, 1)).toThrow();
    for (const book of [
      [],
      [[], [], []],
      [[[1, 2]], []],
      [
        [
          [1, 2, 1],
          [1, 3, 1],
        ],
        [],
      ],
      [
        [
          [1, 1, 1],
          [2, 1, 1],
        ],
        [],
      ],
      [
        [],
        [
          [2, 1, 1],
          [1, 1, 1],
        ],
      ],
      [[[1, -1, 1]], []],
      [[[1, 1, 0x1_0000_0000]], []],
      [Array.from({ length: 21 }, (_, i) => [100 - i, 1, 1]), []],
    ]) {
      expect(() => decodeFinalizedOrderbook(frame(book), 1)).toThrow();
    }
  });
  it("rejects truncated, trailing and floating-point MessagePack before trusting a level", () => {
    for (const bytes of [
      Uint8Array.of(0x92, 0x91),
      new Uint8Array([...encode([[], []]), 0]),
      encode([[[1, 2, 1]], []], { forceIntegerToFloat: true }),
    ]) {
      const data = base64(bytes);
      expect(() =>
        decodeFinalizedOrderbook({ ...frame(), data, bookMsgpackB64: data }, 1),
      ).toThrow();
    }
  });
  it("refuses invalid selectors before networking and never retries an unsupported route", async () => {
    const transport = vi.fn(
      async () => new Response("unsupported", { status: 404 }),
    );
    const client = new ExchangeClient({
      gatewayUrl: "https://gateway.example",
      httpTransport: transport,
    });
    for (const market of [0, -1, 1.5, 0x1_0000_0000])
      await expect(client.queryFinalizedOrderbook(market)).rejects.toThrow();
    await expect(
      client.queryFinalizedOrderbook(1, { depth: 10 as 20 }),
    ).rejects.toThrow("depth");
    expect(transport).not.toHaveBeenCalled();
    await expect(client.queryFinalizedOrderbook(1)).rejects.toMatchObject({
      status: 404,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
