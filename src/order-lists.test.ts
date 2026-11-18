import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  ExchangeClient,
  Side,
  TimeInForce,
  bytesToHex,
  decodeOrderListEvent,
  getPublicKey,
  pubkeyToOwner,
  type TxEvent,
} from "./index.js";

const key = new Uint8Array(32).fill(21);
const owner = bytesToHex(pubkeyToOwner(getPublicKey(key)));

// The exchange's own rendering of each list (exchange-wire order_lists_tests).
const PLACED =
  '[{"outcome":"resting","market":"1","client_order_id":"4","order_id":"9","side":"buy","price":"100","quantity":"5","time_in_force":"gtc","post_only":"true","reduce_only":"false"},{"outcome":"rejected","market":"2","client_order_id":"","code":"22"}]';
const CANCELLED =
  '[{"outcome":"cancelled","order_id":"9","market":"1","client_order_id":"","original_quantity":"5","remaining_quantity":"3","filled_quantity":"2"},{"outcome":"refused","order_id":"10","code":"2"},{"outcome":"refused","client_order_id":"11","code":"60"}]';

const placed = (orders: string, who = owner): TxEvent => ({
  type: "orders_placed",
  attributes: [
    { key: "owner", value: who },
    { key: "orders", value: orders },
  ],
});
const cancelled = (orders: string, reason = "user_requested"): TxEvent => ({
  type: "orders_cancelled",
  attributes: [
    { key: "owner", value: owner },
    { key: "reason", value: reason },
    { key: "orders", value: orders },
  ],
});

/** A client whose gateway executes every submission with `events`. */
function clientAnswering(events: TxEvent[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const txHash = bytesToHex(
        sha256(Uint8Array.from(atob(body.action), (c) => c.charCodeAt(0))),
      ).toUpperCase();
      return new Response(
        JSON.stringify({ status: "ok", code: 0, height: 42, txHash, events }),
      );
    }),
  );
  const client = new ExchangeClient({
    gatewayUrl: "",
    chainId: "exchange-devnet-1",
  });
  client.setPrivateKey(key);
  client.setUnsafeFastSubmit(true);
  return client;
}

const order = {
  market: 1,
  side: Side.Buy,
  price: 100n,
  quantity: 5n,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("list events", () => {
  it("decode every placement outcome", () => {
    expect(decodeOrderListEvent(placed(PLACED))).toEqual({
      type: "OrdersPlaced",
      owner,
      orders: [
        {
          outcome: "resting",
          market: 1,
          clientOrderId: 4n,
          orderId: 9n,
          side: Side.Buy,
          price: 100n,
          quantity: 5n,
          timeInForce: TimeInForce.Gtc,
          postOnly: true,
          reduceOnly: false,
        },
        {
          outcome: "rejected",
          market: 2,
          clientOrderId: null,
          code: 22,
          error: expect.objectContaining({ name: expect.any(String) }),
        },
      ],
    });
  });

  it("decode every cancel entry", () => {
    const event = decodeOrderListEvent(cancelled(CANCELLED));
    expect(event?.type).toBe("OrdersCancelled");
    expect(event?.type === "OrdersCancelled" && event.reason).toBe(
      "user_requested",
    );
    expect(event?.orders).toEqual([
      {
        outcome: "cancelled",
        orderId: 9n,
        market: 1,
        clientOrderId: null,
        originalQuantity: 5n,
        remainingQuantity: 3n,
        filledQuantity: 2n,
      },
      expect.objectContaining({
        outcome: "refused",
        target: { orderId: 10n },
        code: 2,
      }),
      expect.objectContaining({
        outcome: "refused",
        target: { clientOrderId: 11n },
        code: 60,
      }),
    ]);
  });

  it("leave other events to other decoders and refuse malformed lists", () => {
    expect(
      decodeOrderListEvent({ type: "order_placed", attributes: [] }),
    ).toBeNull();
    expect(() => decodeOrderListEvent(placed("{}"))).toThrow(
      "is not a JSON array",
    );
    expect(() =>
      decodeOrderListEvent(placed('[{"outcome":"resting","market":"1"}]')),
    ).toThrow("orders_placed.orders[0] decode");
  });
});

describe("single-order methods", () => {
  it("report a refused order as the engine error a single order carried", async () => {
    const r = await clientAnswering([
      placed(
        '[{"outcome":"rejected","market":"1","client_order_id":"","code":"12"}]',
      ),
    ]).placeOrder(order);
    expect(r).toMatchObject({
      ok: false,
      outcome: "engine",
      code: 12,
      height: 42,
    });
    expect(r.error).not.toBeNull();
  });

  it("report refused cancels of either kind as the engine error", async () => {
    const byId = await clientAnswering([
      cancelled('[{"outcome":"refused","order_id":"10","code":"2"}]'),
    ]).cancelOrder(10n);
    expect(byId).toMatchObject({ ok: false, outcome: "engine", code: 2 });

    const byClientId = await clientAnswering([
      cancelled('[{"outcome":"refused","client_order_id":"11","code":"44"}]'),
    ]).cancelClientOrder(11n);
    expect(byClientId).toMatchObject({
      ok: false,
      outcome: "engine",
      code: 44,
    });
  });

  it("stay successful when the order rests or the cancel lands", async () => {
    const rested = await clientAnswering([
      placed(
        '[{"outcome":"resting","market":"1","client_order_id":"","order_id":"9","side":"buy","price":"100","quantity":"5","time_in_force":"gtc","post_only":"false","reduce_only":"false"}]',
      ),
    ]).placeOrder(order);
    expect(rested).toMatchObject({ ok: true, code: 0 });

    const landed = await clientAnswering([
      cancelled(
        '[{"outcome":"cancelled","order_id":"9","market":"1","client_order_id":"","original_quantity":"5","remaining_quantity":"5","filled_quantity":"0"}]',
      ),
    ]).cancelOrder(9n);
    expect(landed).toMatchObject({ ok: true, code: 0 });
  });

  it("ignore another account's list event", async () => {
    const r = await clientAnswering([
      placed(
        '[{"outcome":"rejected","market":"1","client_order_id":"","code":"12"}]',
        "ab".repeat(20),
      ),
    ]).placeOrder(order);
    expect(r).toMatchObject({ ok: true, code: 0 });
  });
});

describe("list methods", () => {
  it("return each order's outcome and keep the transaction successful", async () => {
    const { tx, orders } = await clientAnswering([placed(PLACED)]).placeOrders([
      { ...order, clientOrderId: 4n },
      { ...order, market: 2 },
    ]);
    expect(tx).toMatchObject({ ok: true, code: 0 });
    expect(orders.map((o) => o.outcome)).toEqual(["resting", "rejected"]);
  });

  it("keep a refused list of one as an entry, not a transaction error", async () => {
    const { tx, orders } = await clientAnswering([
      cancelled('[{"outcome":"refused","order_id":"10","code":"2"}]'),
    ]).cancelOrders([10n]);
    expect(tx).toMatchObject({ ok: true, code: 0 });
    expect(orders).toEqual([
      expect.objectContaining({ outcome: "refused", code: 2 }),
    ]);
  });

  it("read cancels by client order id entry by entry", async () => {
    const { orders } = await clientAnswering([
      cancelled(CANCELLED),
    ]).cancelClientOrders([9n, 10n, 11n]);
    expect(orders.map((o) => o.outcome)).toEqual([
      "cancelled",
      "refused",
      "refused",
    ]);
  });

  it("refuse 0 or 101 entries before signing", async () => {
    const client = clientAnswering([]);
    await expect(client.placeOrders([])).rejects.toThrow(
      "list carries 0 entries",
    );
    await expect(
      client.cancelOrders(Array.from({ length: 101 }, (_, i) => BigInt(i + 1))),
    ).rejects.toThrow("list carries 101 entries");
  });
});
