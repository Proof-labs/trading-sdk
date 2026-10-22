import { describe, expect, it } from "vitest";
import {
  TIMES_IN_FORCE,
  UNFILLED_REASONS,
  decodeOrderEvent,
} from "./order-events.js";
import type { TxEvent } from "./types.js";

// Attribute lists mirror exchange-wire's ABCI rendering of each event, in
// the engine's write order.
const MAKER = "ab".repeat(20);
const TAKER = "cd".repeat(20);

function txEvent(type: string, attrs: Record<string, string>): TxEvent {
  return {
    type,
    attributes: Object.entries(attrs).map(([key, value]) => ({ key, value })),
  };
}

const trade = (overrides: Record<string, string> = {}) =>
  txEvent("trade_executed", {
    fill_id: "1",
    market: "7",
    price: "100",
    quantity: "2",
    maker_order_id: "3",
    maker_client_order_id: "0",
    maker_owner: MAKER,
    maker_side: "sell",
    taker_order_id: "4",
    taker_owner: TAKER,
    taker_client_order_id: "9",
    taker_fee: "1",
    maker_fee: "-1",
    mark_price: "1234",
    oracle_price: "",
    ...overrides,
  });

const summary = (overrides: Record<string, string> = {}) =>
  txEvent("market_order_processed", {
    order_id: "4",
    market: "7",
    owner: TAKER,
    side: "buy",
    requested_quantity: "5",
    filled_quantity: "2",
    client_order_id: "0",
    time_in_force: "ioc",
    limit_price: "100",
    unfilled_reason: "no_liquidity",
    ...overrides,
  });

function without(event: TxEvent, ...keys: string[]): TxEvent {
  return {
    type: event.type,
    attributes: event.attributes.filter(({ key }) => !keys.includes(key)),
  };
}

describe("decodeOrderEvent", () => {
  it("decodes a fill with the prices in force", () => {
    expect(decodeOrderEvent(trade())).toEqual({
      type: "TradeExecuted",
      fillId: 1n,
      market: 7,
      price: 100n,
      quantity: 2n,
      makerOrderId: 3n,
      makerClientOrderId: null,
      makerOwner: MAKER,
      makerSide: "sell",
      takerOrderId: 4n,
      takerOwner: TAKER,
      takerClientOrderId: 9n,
      takerFee: 1n,
      makerFee: -1n,
      markPrice: 1234n,
      oraclePrice: null,
    });
  });

  it("decodes a fill recorded before prices were reported", () => {
    expect(
      decodeOrderEvent(without(trade(), "mark_price", "oracle_price")),
    ).toMatchObject({ markPrice: null, oraclePrice: null });
  });

  it("decodes a summary and why it filled short", () => {
    expect(decodeOrderEvent(summary())).toEqual({
      type: "MarketOrderProcessed",
      orderId: 4n,
      market: 7,
      owner: TAKER,
      side: "buy",
      requestedQuantity: 5n,
      filledQuantity: 2n,
      clientOrderId: null,
      timeInForce: "ioc",
      limitPrice: 100n,
      unfilledReason: "no_liquidity",
    });
  });

  it("decodes every time in force and unfilled reason", () => {
    for (const timeInForce of TIMES_IN_FORCE) {
      expect(
        decodeOrderEvent(summary({ time_in_force: timeInForce })),
      ).toMatchObject({ timeInForce });
    }
    for (const unfilledReason of UNFILLED_REASONS) {
      expect(
        decodeOrderEvent(summary({ unfilled_reason: unfilledReason })),
      ).toMatchObject({ unfilledReason });
    }
  });

  it("decodes a fully filled market order", () => {
    expect(
      decodeOrderEvent(
        summary({ filled_quantity: "5", limit_price: "", unfilled_reason: "" }),
      ),
    ).toMatchObject({ limitPrice: null, unfilledReason: null });
  });

  it("decodes a summary from before the order fields as a market order", () => {
    expect(
      decodeOrderEvent(
        without(summary(), "time_in_force", "limit_price", "unfilled_reason"),
      ),
    ).toMatchObject({
      timeInForce: "ioc",
      limitPrice: null,
      unfilledReason: null,
    });
  });

  it("decodes a rejection with and without a client order id", () => {
    const rejection = (clientOrderId: string) =>
      txEvent("order_rejected", {
        owner: TAKER,
        market: "7",
        client_order_id: clientOrderId,
        code: "48",
      });
    expect(decodeOrderEvent(rejection("0"))).toEqual({
      type: "OrderRejected",
      owner: TAKER,
      market: 7,
      clientOrderId: 0n,
      code: 48,
    });
    expect(decodeOrderEvent(rejection(""))).toMatchObject({
      clientOrderId: null,
    });
  });

  it("returns null for any other event type", () => {
    expect(decodeOrderEvent(txEvent("order_placed", {}))).toBeNull();
    expect(decodeOrderEvent(txEvent("toString", {}))).toBeNull();
  });

  it.each<[string, TxEvent, RegExp]>([
    [
      "an unknown unfilled reason",
      summary({ unfilled_reason: "margin" }),
      /unfilled_reason has unknown value "margin"/,
    ],
    [
      "an unknown side",
      trade({ maker_side: "Sell" }),
      /maker_side has unknown value "Sell"/,
    ],
    [
      "a fee outside i64",
      trade({ taker_fee: "9223372036854775808" }),
      /taker_fee exceeds i64/,
    ],
    [
      "a fee with a leading zero",
      trade({ maker_fee: "-01" }),
      /maker_fee is not a decimal integer/,
    ],
    [
      "a missing required attribute",
      without(trade(), "price"),
      /price is missing/,
    ],
  ])("refuses %s", (_name, event, message) => {
    expect(() => decodeOrderEvent(event)).toThrow(message);
  });
});
