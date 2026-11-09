import { readFileSync } from "node:fs";
import { Encoder } from "@msgpack/msgpack";
import { describe, expect, it, vi } from "vitest";
import { ExchangeClient } from "./client.js";

const owner = new Uint8Array(20).fill(0xab);
const hex = "ab".repeat(20);
const max = (1n << 64n) - 1n;
const encoder = new Encoder({ useBigInt64: true });
const row = (): unknown[] => [
  9007199254740993n,
  7,
  owner,
  "Buy",
  max,
  20n,
  max,
  23n,
  3n,
  1794182400000n,
  max,
  "Gtc",
  true,
  false,
];
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
function clientFor(data: unknown) {
  const transport = vi.fn(
    async (_url: string, _init: RequestInit | undefined) =>
      new Response(JSON.stringify({ data }), { status: 200 }),
  );
  return {
    client: new ExchangeClient({
      gatewayUrl: "https://gateway.example",
      httpTransport: transport,
    }),
    transport,
  };
}
const packed = (value: unknown) => clientFor(base64(encoder.encode(value)));

describe("canonical open orders", () => {
  it("preserves all fourteen fields, exact u64s and canonical request owner", async () => {
    const { client, transport } = packed([row()]);
    expect(await client.queryOpenOrders("0X" + hex.toUpperCase())).toEqual([
      {
        id: 9007199254740993n,
        market: 7,
        owner,
        side: "Buy",
        price: max,
        quantity: 20n,
        clientOrderId: max,
        originalQuantity: 23n,
        filledQuantity: 3n,
        createdAtMs: 1794182400000n,
        queuePriority: max,
        timeInForce: "Gtc",
        postOnly: true,
        reduceOnly: false,
      },
    ]);
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).toEqual({
      type: "openOrders",
      user: hex,
    });
  });

  it("uses wire defaults for legacy six-field arrays and coerces owner bytes", async () => {
    const legacy = row().slice(0, 6);
    legacy[2] = Array.from(owner);
    expect((await packed([legacy]).client.queryOpenOrders(hex))[0]).toEqual({
      id: 9007199254740993n,
      market: 7,
      owner,
      side: "Buy",
      price: max,
      quantity: 20n,
      clientOrderId: null,
      originalQuantity: 0n,
      filledQuantity: 0n,
      createdAtMs: 0n,
      queuePriority: 0n,
      timeInForce: "Gtc",
      postOnly: false,
      reduceOnly: false,
    });
  });

  it.each([null, 0n, max])("preserves optional client ID %s", async (id) => {
    const order = row();
    order[6] = id;
    expect(
      (await packed([order]).client.queryOpenOrders(hex))[0].clientOrderId,
    ).toBe(id);
  });

  it("keeps known metadata when future fields are appended", async () => {
    expect(
      (await packed([[...row(), "future", 123]]).client.queryOpenOrders(hex))[0]
        .clientOrderId,
    ).toBe(max);
  });

  it("returns an empty array only for a valid empty payload", async () => {
    expect(await packed([]).client.queryOpenOrders(hex)).toEqual([]);
  });

  const invalid: [number, unknown][] = [
    [0, -1],
    [1, true],
    [2, new Uint8Array(20).fill(0xcd)],
    [2, new Uint8Array(19)],
    [3, "NotASide"],
    [4, 10.5],
    [5, 0],
    [6, -1],
    [6, true],
    [7, "23"],
    [8, -1],
    [9, null],
    [10, -1],
    [11, "Unknown"],
    [12, 1],
    [13, "false"],
  ];
  it.each(invalid)("rejects malformed field %s (%s)", async (index, value) => {
    const order = row();
    order[index] = value;
    await expect(packed([order]).client.queryOpenOrders(hex)).rejects.toThrow();
  });

  it.each([
    null,
    {},
    [row().slice(0, 5)],
    [row(), row()],
    [row(), [1n, ...row().slice(1)]],
  ])("rejects malformed lists and unordered IDs %#", async (value) => {
    await expect(packed(value).client.queryOpenOrders(hex)).rejects.toThrow();
  });

  it.each([undefined, null, "", "%%%", "kJA=", 10, "kA==\n", "kA"])(
    "rejects malformed envelope %#",
    async (data) => {
      await expect(
        clientFor(data).client.queryOpenOrders(hex),
      ).rejects.toThrow();
    },
  );

  it("rejects trailing data and oversized payloads", async () => {
    await expect(
      clientFor(base64(Uint8Array.of(0x90, 0x90))).client.queryOpenOrders(hex),
    ).rejects.toThrow();
    const order = row();
    order.push("x".repeat(1024 * 1024));
    await expect(packed([order]).client.queryOpenOrders(hex)).rejects.toThrow();
  });

  it.each(["", "0x123", "g".repeat(40)])(
    "rejects invalid request owner before transport",
    async (address) => {
      const { client, transport } = packed([]);
      await expect(client.queryOpenOrders(address)).rejects.toThrow(/owner/);
      expect(transport).not.toHaveBeenCalled();
    },
  );
});

const sharedVectors = JSON.parse(
  readFileSync(
    new URL("../conformance/open-orders.json", import.meta.url),
    "utf8",
  ),
);
it.each(sharedVectors)(
  "matches the shared Python/TS read contract: $name",
  async (vector) => {
    const orders = await clientFor(
      vector.msgpack_base64,
    ).client.queryOpenOrders(vector.owner);
    const normalized = orders.map((order) =>
      Object.fromEntries(
        Object.entries(order).map(([key, value]) => [
          key.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase()),
          value instanceof Uint8Array
            ? Buffer.from(value).toString("hex")
            : typeof value === "bigint"
              ? value.toString()
              : value,
        ]),
      ),
    );
    expect(normalized).toEqual(vector.orders);
  },
);
