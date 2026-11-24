import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  ExchangeClient,
  Side,
  TimeInForce,
  bytesToHex,
  decodeOrderListEvent,
  getPublicKey,
  orderPlacements,
  pubkeyToOwner,
  type AccountInfo,
  type TxEvent,
} from "./index.js";

const key = new Uint8Array(32).fill(21);
const owner = bytesToHex(pubkeyToOwner(getPublicKey(key)));

// The exchange's own rendering of each list (exchange-wire order_lists_tests).
const PLACED =
  '[{"outcome":"resting","market":"1","client_order_id":"4","order_id":"9","side":"buy","price":"100","quantity":"5","time_in_force":"gtc","post_only":"true","reduce_only":"false"},{"outcome":"rejected","market":"2","client_order_id":"","code":"22"}]';
const EXECUTED =
  '[{"outcome":"executed","market":"3","client_order_id":"","order_id":"12","requested_quantity":"10","filled_quantity":"4","unfilled":"no_liquidity"},{"outcome":"executed","market":"3","client_order_id":"5","order_id":"13","requested_quantity":"6","filled_quantity":"6","unfilled":""}]';
const rejected = (code: number) =>
  `[{"outcome":"rejected","market":"9","client_order_id":"","code":"${code}"}]`;
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

/** A client whose gateway answers pending; the tx then executes with `events`. */
function clientReconciling(events: TxEvent[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/exchange")
        ? new Response(
            JSON.stringify({ status: "pending", error: "park deadline" }),
          )
        : new Response(
            JSON.stringify({
              result: { height: "43", tx_result: { code: 0, events } },
            }),
          ),
    ),
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

  it("decode executed orders with their fill and unfilled reason", () => {
    expect(decodeOrderListEvent(placed(EXECUTED))?.orders).toEqual([
      {
        outcome: "executed",
        market: 3,
        clientOrderId: null,
        orderId: 12n,
        requestedQuantity: 10n,
        filledQuantity: 4n,
        unfilled: "no_liquidity",
      },
      {
        outcome: "executed",
        market: 3,
        clientOrderId: 5n,
        orderId: 13n,
        requestedQuantity: 6n,
        filledQuantity: 6n,
        unfilled: null,
      },
    ]);
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
  it("report a refused order in its entry; the transaction succeeds", async () => {
    const r = await clientAnswering([placed(rejected(12))]).placeOrder(order);
    expect(r).toMatchObject({ ok: true, code: 0, height: 42 });
    expect(orderPlacements(r, pubkeyToOwner(getPublicKey(key)))).toMatchObject([
      { outcome: "rejected", code: 12 },
    ]);

    const market = await clientAnswering([placed(rejected(12))]).marketOrder({
      market: 9,
      side: Side.Buy,
      quantity: 5n,
      worstPrice: 101n,
    });
    expect(market).toMatchObject({ ok: true, code: 0 });
  });

  it("report a refused close in its entry", async () => {
    for (const code of [35, 12]) {
      const client = clientAnswering([placed(rejected(code))]);
      vi.spyOn(client, "queryAccount").mockResolvedValue({
        positions: [{ market: 9, side: "Sell", size: 3n }],
      } as unknown as AccountInfo);
      const r = await client.closePosition(9);
      expect(r).toMatchObject({ kind: "closed", tx: { ok: true, code: 0 } });
    }
  });

  it("report refused cancels of either kind in their entries", async () => {
    const byId = await clientAnswering([
      cancelled('[{"outcome":"refused","order_id":"10","code":"2"}]'),
    ]).cancelOrder(10n);
    expect(byId).toMatchObject({ ok: true, code: 0 });

    const byClientId = await clientAnswering([
      cancelled('[{"outcome":"refused","client_order_id":"11","code":"44"}]'),
    ]).cancelClientOrder(11n);
    expect(byClientId).toMatchObject({ ok: true, code: 0 });
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

  it("report an executed single whose result does not read as unreadable", async () => {
    const twoEntries = `[${rejected(12).slice(1, -1)},${rejected(12).slice(1, -1)}]`;
    for (const events of [
      [],
      [placed("{}")],
      [placed(twoEntries)],
      // Another account's list is not this order's result.
      [placed(rejected(12), "ab".repeat(20))],
    ]) {
      const r = await clientAnswering(events).placeOrder(order);
      expect(r).toMatchObject({
        ok: false,
        outcome: "unreadable",
        code: -1,
        error: null,
        height: 42,
        hash: expect.stringMatching(/^[0-9A-F]{64}$/),
      });
      expect(r.log).toContain("reconcile by hash");
    }

    const cancel = await clientAnswering([
      cancelled('[{"outcome":"refused","order_id":"10"}]'),
    ]).cancelOrder(10n);
    expect(cancel).toMatchObject({ ok: false, outcome: "unreadable" });
  });

  it("report an unreadable close as unreadable, not closed successfully", async () => {
    const client = clientAnswering([]);
    vi.spyOn(client, "queryAccount").mockResolvedValue({
      positions: [{ market: 9, side: "Buy", size: 3n }],
    } as unknown as AccountInfo);
    expect(await client.closePosition(9)).toMatchObject({
      kind: "closed",
      tx: { ok: false, outcome: "unreadable", height: 42 },
    });
  });
});

describe("pending results reconciled later", () => {
  it("read a reconciled list of one as a list, with or without the action", async () => {
    const client = clientReconciling([placed(rejected(12))]);
    const pending = await client.placeOrder(order);
    expect(pending.outcome).toBe("timeout");
    expect(await client.waitForDelivery(pending)).toMatchObject({
      ok: true,
      code: 0,
      height: 43,
      hash: pending.hash,
    });

    const cancels = clientReconciling([
      cancelled('[{"outcome":"refused","order_id":"10","code":"2"}]'),
    ]);
    const cancel = await cancels.cancelOrder(10n);
    expect(await cancels.waitForDelivery(cancel)).toMatchObject({
      ok: true,
      code: 0,
    });
  });

  it("keep the entry when the action says it was a list", async () => {
    const client = clientReconciling([
      cancelled('[{"outcome":"refused","order_id":"10","code":"2"}]'),
    ]);
    const { tx } = await client.cancelOrders([10n]);
    const action = {
      type: "CancelOrders" as const,
      data: { owner: pubkeyToOwner(getPublicKey(key)), orderIds: [10n] },
    };
    expect(await client.waitForDelivery(tx, { action })).toMatchObject({
      ok: true,
      outcome: "ok",
    });
  });

  it("report an unreadable list as unreadable, never success", async () => {
    const client = clientReconciling([placed("{}")]);
    const pending = await client.placeOrder(order);
    expect(await client.waitForDelivery(pending)).toMatchObject({
      ok: false,
      outcome: "unreadable",
      height: 43,
      hash: pending.hash,
    });
  });

  it("leave a transaction with no list event alone", async () => {
    const client = clientReconciling([]);
    const pending = await client.cancelAllOrders();
    expect(await client.waitForDelivery(pending)).toMatchObject({
      ok: true,
      height: 43,
    });
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

  it("place market entries and report what they filled", async () => {
    const { orders } = await clientAnswering([placed(EXECUTED)]).placeOrders([
      { kind: "market", market: 3, side: Side.Buy, quantity: 10n },
      {
        kind: "market",
        market: 3,
        side: Side.Sell,
        quantity: 6n,
        worstPrice: 90n,
        clientOrderId: 5n,
      },
    ]);
    expect(orders).toMatchObject([
      { outcome: "executed", filledQuantity: 4n, unfilled: "no_liquidity" },
      { outcome: "executed", filledQuantity: 6n, unfilled: null },
    ]);
  });

  it("read a failed basket's legs from orders_placed", () => {
    const legs = orderPlacements(
      {
        ok: false,
        outcome: "engine",
        code: 47,
        error: null,
        hash: "",
        events: [
          placed(
            '[{"outcome":"rejected","market":"1","client_order_id":"","code":"47"},{"outcome":"rejected","market":"2","client_order_id":"","code":"47"}]',
          ),
        ],
      },
      pubkeyToOwner(getPublicKey(key)),
    );
    expect(legs.map((l) => [l.outcome, l.market])).toEqual([
      ["rejected", 1],
      ["rejected", 2],
    ]);
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

  it("report a list whose result does not read as unreadable with no entries", async () => {
    for (const events of [[], [placed("{}")], [placed(rejected(12))]]) {
      const { tx, orders } = await clientAnswering(events).placeOrders([
        order,
        order,
      ]);
      expect(tx).toMatchObject({
        ok: false,
        outcome: "unreadable",
        height: 42,
      });
      expect(orders).toEqual([]);
    }
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
