import { describe, expect, it } from "vitest";
import { fromWasmFields, toWasmFields } from "./codec-adapter.js";
import { ActionType, Side, TimeInForce, type Action } from "./types.js";

// These exercise the adapter's translation layer directly — no WASM involved.
// Round-trip correctness through the WASM core is covered by codec.test.ts
// and the conformance vectors.

describe("codec-adapter enum loudness", () => {
  it("throws by field name for an out-of-range numeric enum on encode", () => {
    const action = {
      type: "PlaceOrder",
      data: { side: 99 },
    } as unknown as Action;
    expect(() => toWasmFields(action)).toThrow(/unknown side enum value: 99/);
  });

  it("throws for an out-of-range markSourceMode on encode", () => {
    const action = {
      type: "Deposit",
      data: { markSourceMode: 7 },
    } as unknown as Action;
    expect(() => toWasmFields(action)).toThrow(
      /unknown markSourceMode value: 7/,
    );
  });

  it("accepts every declared enum variant on encode", () => {
    const action = {
      type: "CancelReplaceOrder",
      data: { side: Side.Sell, timeInForce: TimeInForce.Fok },
    } as unknown as Action;
    expect(toWasmFields(action).fields).toEqual({
      side: "Sell",
      time_in_force: "Fok",
    });
  });

  it("throws by field name for an unknown enum variant on decode", () => {
    expect(() =>
      fromWasmFields(ActionType.CancelReplaceOrder, { side: "Sideways" }),
    ).toThrow(/unknown side enum variant: Sideways/);
  });

  it("throws for an unknown markSourceMode variant on decode", () => {
    expect(() =>
      fromWasmFields(ActionType.Deposit, { mark_source_mode: "Vwap" }),
    ).toThrow(/unknown markSourceMode variant: Vwap/);
  });
});

describe("codec-adapter byte fields", () => {
  it("decodes a byte field from a plain number array by name", () => {
    const action = fromWasmFields(ActionType.CancelReplaceOrder, {
      owner: [1, 2, 3],
    });
    expect((action.data as { owner: unknown }).owner).toEqual(
      Uint8Array.from([1, 2, 3]),
    );
  });

  it("decodes an empty byte field to an empty Uint8Array, not []", () => {
    const action = fromWasmFields(ActionType.CancelReplaceOrder, { owner: [] });
    expect((action.data as { owner: unknown }).owner).toEqual(
      new Uint8Array(0),
    );
  });

  it("does NOT byte-convert a numeric array on a non-byte field", () => {
    const action = fromWasmFields(ActionType.CancelReplaceOrder, {
      future_market_ids: [1, 2, 300],
    });
    expect(
      (action.data as { futureMarketIds: unknown }).futureMarketIds,
    ).toEqual([1, 2, 300]);
  });

  it("throws loudly when a byte field carries non-u8 content", () => {
    expect(() =>
      fromWasmFields(ActionType.CancelReplaceOrder, { owner: [1, 999] }),
    ).toThrow(/byte field owner: expected an array of u8/);
    expect(() =>
      fromWasmFields(ActionType.CancelReplaceOrder, { owner: ["ff"] }),
    ).toThrow(/byte field owner: expected an array of u8/);
  });
});

describe("codec-adapter order lists", () => {
  const owner = new Uint8Array(20).fill(1);

  it("sends a single order as a list of one entry of its kind", () => {
    expect(
      toWasmFields({
        type: "MarketOrder",
        data: {
          market: 3,
          owner,
          side: Side.Buy,
          quantity: 5n,
          worstPrice: 7n,
        },
      }),
    ).toEqual({
      actionType: ActionType.PlaceOrders,
      fields: {
        owner,
        orders: [
          {
            market: 3,
            side: "Buy",
            quantity: 5n,
            kind: { Market: { worst_price: 7n } },
            reduce_only: false,
          },
        ],
      },
    });
    expect(
      toWasmFields({
        type: "PlaceOrder",
        data: { market: 1, owner, side: Side.Sell, price: 9n, quantity: 2n },
      }).fields.orders,
    ).toEqual([
      {
        market: 1,
        side: "Sell",
        quantity: 2n,
        kind: { Limit: { price: 9n, time_in_force: "Gtc", post_only: false } },
        reduce_only: false,
      },
    ]);
    expect(
      toWasmFields({ type: "CancelOrder", data: { orderId: 4n, owner } }),
    ).toEqual({
      actionType: ActionType.CancelOrders,
      fields: { owner, order_ids: [4n] },
    });
  });

  it("reads a list of one market entry back as a MarketOrder", () => {
    const entry = {
      market: 3,
      side: "Buy",
      quantity: 5n,
      reduce_only: false,
      client_order_id: null,
      stop_loss: null,
      take_profit: null,
    };
    expect(
      fromWasmFields(ActionType.PlaceOrders, {
        owner: [1, 1],
        orders: [{ ...entry, kind: { Market: { worst_price: null } } }],
      }),
    ).toEqual({
      type: "MarketOrder",
      data: {
        market: 3,
        owner: Uint8Array.from([1, 1]),
        side: Side.Buy,
        quantity: 5n,
        clientOrderId: null,
        stopLoss: null,
        takeProfit: null,
      },
    });
    const limit = {
      ...entry,
      kind: { Limit: { price: 9n, time_in_force: "Ioc", post_only: true } },
    };
    const decoded = fromWasmFields(ActionType.PlaceOrders, {
      owner: [1, 1],
      orders: [limit, { ...entry, kind: { Market: { worst_price: 8n } } }],
    });
    expect(decoded.type).toBe("PlaceOrders");
    expect(decoded.type === "PlaceOrders" && decoded.data.orders).toMatchObject(
      [
        { price: 9n, timeInForce: TimeInForce.Ioc, postOnly: true },
        { kind: "market", worstPrice: 8n },
      ],
    );
  });
});

describe("codec-adapter pre-fill trigger fields", () => {
  const owner = new Uint8Array(20).fill(1);
  const limb = {
    triggerPrice: 95_000n,
    maxSlippageBps: 75,
    clientTriggerId: 11n,
  };

  it("maps stopLoss/takeProfit to the trailing snake_case wire fields on PlaceOrder", () => {
    const { fields } = toWasmFields({
      type: "PlaceOrder",
      data: {
        market: 1,
        owner,
        side: Side.Buy,
        price: 100n,
        quantity: 10n,
        stopLoss: limb,
        takeProfit: null,
      },
    });
    const [entry] = fields.orders as Record<string, unknown>[];
    expect(entry.stop_loss).toEqual({
      trigger_price: 95_000n,
      max_slippage_bps: 75,
      client_trigger_id: 11n,
    });
    // Nullish limbs are dropped, never passed as null: `Option::None` is a
    // missing key and it encodes as nil.
    expect(entry).not.toHaveProperty("take_profit");
  });

  it("applies order-trigger validation to all three order actions", () => {
    for (const type of [
      "PlaceOrder",
      "MarketOrder",
      "CancelReplaceOrder",
    ] as const) {
      expect(() =>
        toWasmFields({
          type,
          data: { stopLoss: limb, reduceOnly: true },
        } as Action),
      ).toThrow(/TriggerOrderIncompatible, code 98/);
      expect(() =>
        toWasmFields({
          type,
          data: {
            stopLoss: limb,
            takeProfit: { ...limb },
          },
        } as Action),
      ).toThrow(/must differ/);
    }
  });
});
