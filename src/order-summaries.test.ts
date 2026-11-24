// `GET /v1/history/order-summaries/{owner}`: global fetch is stubbed; each
// test asserts the URL and the decoded shape.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ExchangeClient } from "./client.js";
import {
  decodeOrderSummaryPage,
  orderSummarySearchParams,
  type OrderSummaryPage,
} from "./index.js";

const owner = "aa".repeat(20);

function stubFetch(body: unknown): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      calls.push(url.toString());
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return calls;
}

const client = () =>
  new ExchangeClient({ gatewayUrl: "http://gateway", chainId: "test" });

afterEach(() => vi.unstubAllGlobals());

const row = {
  order_id: "9007199254740993",
  market: 3,
  side: "buy",
  filled_quantity: "400",
  avg_price: "550000.5",
  notional: "220000000",
  fees: "-2",
  first_fill_time: "2026-11-20T20:00:00Z",
  last_fill_time: "2026-11-20T20:01:00.123456789Z",
  fill_count: 2,
};

describe("queryOrderSummaries", () => {
  it("reads the owner's page with its filters and decodes each order", async () => {
    const calls = stubFetch({ orders: [row], next_cursor: "opaque+/=" });
    const page: OrderSummaryPage = await client().queryOrderSummaries(
      `0x${owner.toUpperCase()}`,
      {
        markets: [7400, 3, 3],
        fromMs: 1_776_000_000_000,
        toMs: 1_777_000_000_000,
        limit: 2,
        cursor: "prev",
      },
    );
    expect(calls).toEqual([
      `http://gateway/v1/history/order-summaries/${owner}?from=1776000000000&to=1777000000000&limit=2&cursor=prev&markets=3%2C7400`,
    ]);
    expect(page).toEqual({
      nextCursor: "opaque+/=",
      orders: [
        {
          orderId: 9007199254740993n,
          market: 3,
          side: "buy",
          filledQuantity: 400n,
          avgPrice: "550000.5",
          notional: "220000000",
          fees: -2n,
          firstFillTime: "2026-11-20T20:00:00Z",
          lastFillTime: "2026-11-20T20:01:00.123456789Z",
          fillCount: 2,
        },
      ],
    });
  });

  it("defaults to the client's own address with no filters", async () => {
    const calls = stubFetch({ orders: [], next_cursor: "" });
    const c = client();
    c.setPrivateKey(new Uint8Array(32).fill(7));
    const page = await c.queryOrderSummaries();
    expect(calls).toEqual([
      `http://gateway/v1/history/order-summaries/${c.getAddressHex()}`,
    ]);
    expect(page).toEqual({ orders: [], nextCursor: "" });
  });

  it("refuses market lists the route would refuse", () => {
    expect(() => orderSummarySearchParams({ markets: [] })).toThrow(/markets/);
    expect(() => orderSummarySearchParams({ markets: [1.5] })).toThrow(
      /markets/,
    );
    expect(() =>
      orderSummarySearchParams({
        markets: Array.from({ length: 201 }, (_, i) => i),
      }),
    ).toThrow(/markets/);
  });

  it("refuses malformed rows rather than skipping them", () => {
    const page = (patch: object) => ({
      orders: [{ ...row, ...patch }],
      next_cursor: "",
    });
    expect(() => decodeOrderSummaryPage(page({ side: "long" }))).toThrow(
      /side/,
    );
    expect(() =>
      decodeOrderSummaryPage(page({ filled_quantity: 400 })),
    ).toThrow(/filled_quantity/);
    expect(() => decodeOrderSummaryPage(page({ last_fill_time: "x" }))).toThrow(
      /last_fill_time/,
    );
    expect(
      decodeOrderSummaryPage(page({ avg_price: null })).orders[0].avgPrice,
    ).toBeNull();
  });
});
