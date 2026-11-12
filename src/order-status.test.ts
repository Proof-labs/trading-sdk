import { Encoder } from "@msgpack/msgpack";
import { describe, expect, it, vi } from "vitest";
import { ExchangeClient } from "./client.js";

const owner = new Uint8Array(20).fill(0xab);
const max = (1n << 64n) - 1n;
const encoder = new Encoder({ useBigInt64: true });
const row = (): unknown[] => [
  9007199254740993n,
  7,
  owner,
  "Sell",
  max,
  20n,
  null,
  23n,
  3n,
  1794182400000n,
  5n,
  "Gtc",
  false,
  true,
];
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
function clientFor(body: unknown, init: { useGateway?: boolean } = {}) {
  const transport = vi.fn(
    async (_url: string, _init: RequestInit | undefined) =>
      new Response(JSON.stringify(body), { status: 200 }),
  );
  return {
    client: new ExchangeClient({
      gatewayUrl: "https://gateway.example",
      apiUrl: "https://node.example",
      httpTransport: transport,
      ...init,
    }),
    transport,
  };
}
const packed = (value: unknown) =>
  clientFor({ data: base64(encoder.encode(value)) });

describe("order status", () => {
  it("posts /info orderStatus and decodes the full order", async () => {
    const { client, transport } = packed(row());
    expect(await client.queryOrderStatus(42n)).toEqual({
      id: 9007199254740993n,
      market: 7,
      owner,
      side: "Sell",
      price: max,
      quantity: 20n,
      clientOrderId: null,
      originalQuantity: 23n,
      filledQuantity: 3n,
      createdAtMs: 1794182400000n,
      queuePriority: 5n,
      timeInForce: "Gtc",
      postOnly: false,
      reduceOnly: true,
    });
    expect(transport.mock.calls[0][0]).toBe("https://gateway.example/info");
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).toEqual({
      type: "orderStatus",
      oid: 42,
    });
  });

  it("is null when the engine holds no such order", async () => {
    expect(await packed(null).client.queryOrderStatus(42n)).toBeNull();
  });

  it("uses wire defaults for a legacy six-field row", async () => {
    const order = await packed(row().slice(0, 6)).client.queryOrderStatus(1n);
    expect(order?.createdAtMs).toBe(0n);
    expect(order?.reduceOnly).toBe(false);
  });

  it("reads the node route when the gateway is off", async () => {
    const { client, transport } = clientFor(
      { data: base64(encoder.encode(row())) },
      { useGateway: false },
    );
    await client.queryOrderStatus(42n);
    expect(transport.mock.calls[0][0]).toBe("https://node.example/v1/order/42");
  });

  it.each([
    ["a float price", (r: unknown[]) => ((r[4] = 1.5), r)],
    ["a short row", (r: unknown[]) => r.slice(0, 3)],
    ["a 21-byte owner", (r: unknown[]) => ((r[2] = new Uint8Array(21)), r)],
    ["an unknown side", (r: unknown[]) => ((r[3] = "Hold"), r)],
  ])("rejects %s", async (_label, mutate) => {
    await expect(
      packed(mutate(row())).client.queryOrderStatus(1n),
    ).rejects.toThrow();
  });

  it("rejects a missing envelope and an oversized payload", async () => {
    await expect(clientFor({}).client.queryOrderStatus(1n)).rejects.toThrow();
    await expect(
      clientFor({ data: "A".repeat(8000) }).client.queryOrderStatus(1n),
    ).rejects.toThrow("Invalid order status data envelope");
  });

  it.each([-1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n])(
    "refuses order id %s before sending",
    async (id) => {
      const { client, transport } = packed(row());
      await expect(client.queryOrderStatus(id)).rejects.toThrow(
        "Invalid order id",
      );
      expect(transport).not.toHaveBeenCalled();
    },
  );
});
