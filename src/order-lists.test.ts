import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  ExchangeClient,
  Side,
  bytesToHex,
  getPublicKey,
  orderPlacements,
  placementsOf,
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

describe("order methods", () => {
  it("return each order's outcome; a rejection does not fail the transaction", async () => {
    const single = await clientAnswering([placed(rejected(12))]).placeOrder(
      order,
    );
    expect(single).toMatchObject({
      tx: { ok: true, code: 0, height: 42 },
      orders: [{ outcome: "rejected", code: 12 }],
    });

    const { tx, orders } = await clientAnswering([placed(PLACED)]).placeOrders([
      { ...order, clientOrderId: 4n },
      { ...order, market: 2 },
    ]);
    expect(tx).toMatchObject({ ok: true, code: 0 });
    expect(orders?.map((o) => o.outcome)).toEqual(["resting", "rejected"]);
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

  it("report a refused close as sent, with its order rejected", async () => {
    for (const code of [35, 12]) {
      const client = clientAnswering([placed(rejected(code))]);
      vi.spyOn(client, "queryAccount").mockResolvedValue({
        positions: [{ market: 9, side: "Sell", size: 3n }],
      } as unknown as AccountInfo);
      expect(await client.closePosition(9)).toMatchObject({
        kind: "sent",
        tx: { ok: true, code: 0 },
        order: { outcome: "rejected", code },
      });
    }
  });

  it("report each cancel of either kind, refused ones included", async () => {
    const byId = await clientAnswering([
      cancelled('[{"outcome":"refused","order_id":"10","code":"2"}]'),
    ]).cancelOrder(10n);
    expect(byId).toMatchObject({
      tx: { ok: true, code: 0 },
      orders: [{ outcome: "refused", code: 2 }],
    });

    const { orders } = await clientAnswering([
      cancelled(CANCELLED),
    ]).cancelClientOrders([9n, 10n, 11n]);
    expect(orders?.map((o) => o.outcome)).toEqual([
      "cancelled",
      "refused",
      "refused",
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
    );
    expect(legs.map((l) => [l.outcome, l.market])).toEqual([
      ["rejected", 1],
      ["rejected", 2],
    ]);
  });

  it("report an executed result whose order event does not decode as unreadable", async () => {
    for (const event of [
      placed("{}"),
      placed('[{"outcome":"resting","market":"1"}]'),
      cancelled('[{"outcome":"refused","order_id":"10"}]'),
    ]) {
      const { tx, orders } = await clientAnswering([event]).placeOrders([
        order,
      ]);
      expect(orders).toBeNull();
      expect(tx).toMatchObject({
        ok: false,
        outcome: "unreadable",
        code: -1,
        error: null,
        height: 42,
        hash: expect.stringMatching(/^[0-9A-F]{64}$/),
      });
      expect(tx.log).toContain("reconcile by hash");
    }
  });

  it("refuse 0 or 101 orders before signing", async () => {
    const client = clientAnswering([]);
    await expect(client.placeOrders([])).rejects.toThrow(
      "1 to 100 orders per call, got 0",
    );
    await expect(
      client.cancelOrders(Array.from({ length: 101 }, (_, i) => BigInt(i + 1))),
    ).rejects.toThrow("1 to 100 orders per call, got 101");
  });
});

describe("pending results reconciled later", () => {
  it("have no orders until reconciled, then read like any batch", async () => {
    const client = clientReconciling([placed(rejected(12))]);
    const pending = await client.placeOrder(order);
    expect(pending.tx.outcome).toBe("timeout");
    expect(pending.orders).toBeNull();
    const delivered = await client.waitForDelivery(pending.tx);
    expect(delivered).toMatchObject({
      ok: true,
      code: 0,
      height: 43,
      hash: pending.tx.hash,
    });
    expect(
      placementsOf(delivered),
    ).toMatchObject([{ outcome: "rejected", code: 12 }]);
  });

  it("report an unreadable result as unreadable, never success", async () => {
    const client = clientReconciling([placed("{}")]);
    const pending = await client.placeOrder(order);
    expect(await client.waitForDelivery(pending.tx)).toMatchObject({
      ok: false,
      outcome: "unreadable",
      height: 43,
      hash: pending.tx.hash,
    });
  });
});
