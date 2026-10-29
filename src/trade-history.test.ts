import { describe, expect, it, vi } from "vitest";
import { ExchangeClient } from "./client.js";
import type { ExchangeHttpTransport } from "./http-transport.js";
import {
  decodeTradeHistoryPage,
  tradeHistorySearchParams,
} from "./trade-history.js";

const options = {
  fromMs: Date.parse("2026-10-26T10:00:00Z"),
  toMs: Date.parse("2026-10-26T11:00:00Z"),
  limit: 2,
};
function row() {
  return {
    fill_id: 3,
    market: 1,
    block_height: 10,
    block_time: "2026-10-26T10:59:59.123456789Z",
    price: "75000.000000",
    quantity: "2.000000",
    maker_owner: "11".repeat(20),
    taker_owner: "22".repeat(20),
    maker_side: "Buy",
    taker_fee: 5,
    maker_fee: -2,
  };
}
const page = () => ({
  fills: [row(), { ...row(), fill_id: 2 }],
  next_cursor: "opaque/cursor+=",
});

describe("participant-attributed trade history", () => {
  it("preserves participants, numeric text, fees, nanosecond times and pagination", () => {
    const result = decodeTradeHistoryPage(page(), 1, options);
    expect(result).toMatchObject({
      market: 1,
      fromMs: options.fromMs,
      toMs: options.toMs,
      nextCursor: "opaque/cursor+=",
    });
    expect(result.trades[0]).toEqual({
      fillId: 3n,
      market: 1,
      blockHeight: 10n,
      blockTime: row().block_time,
      price: "75000.000000",
      quantity: "2.000000",
      makerOwner: row().maker_owner,
      takerOwner: row().taker_owner,
      makerSide: 1,
      takerFee: 5n,
      makerFee: -2n,
    });
    const self = page();
    self.fills[0].taker_owner = self.fills[0].maker_owner;
    expect(decodeTradeHistoryPage(self, 1, options).trades).toHaveLength(2);
  });
  it("forwards fixed window and opaque cursor directly through the gateway, not /info", async () => {
    const transport = vi.fn<ExchangeHttpTransport>(
      async () => new Response(JSON.stringify({ fills: [], next_cursor: "" })),
    );
    const client = new ExchangeClient({
      gatewayUrl: "https://gateway.example",
      useGateway: false,
      httpTransport: transport,
    });
    const opts = { ...options, cursor: "opaque/cursor+=" };
    expect(await client.reads().tradeHistoryPage(1, opts)).toMatchObject({
      trades: [],
      fromMs: opts.fromMs,
    });
    const url = new URL(transport.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe(
      "https://gateway.example/v1/history/trades/1",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      from: String(opts.fromMs),
      to: String(opts.toMs),
      limit: "2",
      cursor: opts.cursor,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("accepts exact signed int64 strings without accepting unsafe JSON numbers", () => {
    const body = {
      fills: [
        {
          ...row(),
          fill_id: "9007199254740993",
          block_height: "9007199254740995",
          maker_fee: "-9223372036854775808",
        },
      ],
      next_cursor: "",
    };
    expect(decodeTradeHistoryPage(body, 1, options).trades[0]).toMatchObject({
      fillId: 9007199254740993n,
      blockHeight: 9007199254740995n,
      makerFee: -(1n << 63n),
    });
    for (const field of ["fill_id", "block_height", "maker_fee", "taker_fee"]) {
      expect(() =>
        decodeTradeHistoryPage(
          {
            fills: [{ ...row(), [field]: Number.MAX_SAFE_INTEGER + 1 }],
            next_cursor: "",
          },
          1,
          options,
        ),
      ).toThrow();
    }
  });
  it("requires page completeness metadata and progressing cursors without fabricating an end", () => {
    for (const body of [
      { fills: [] },
      { fills: [], next_cursor: "more" },
      { fills: [row()], next_cursor: "more" },
      { ...page(), fills: [...page().fills, { ...row(), fill_id: 1 }] },
      { ...page(), next_cursor: null },
    ]) {
      expect(() => decodeTradeHistoryPage(body, 1, options)).toThrow();
    }
    expect(() =>
      decodeTradeHistoryPage(page(), 1, {
        ...options,
        cursor: page().next_cursor,
      }),
    ).toThrow("non-progressing");
    expect(
      decodeTradeHistoryPage({ fills: [], next_cursor: "" }, 1, options).trades,
    ).toEqual([]);
  });
  it("rejects wrong scope, bad participants, invalid times, numeric coercion and unordered rows", () => {
    for (const patch of [
      { market: 2 },
      { maker_owner: "not-an-owner" },
      { taker_owner: null },
      { maker_side: "unknown" },
      { block_time: "2026-10-26T11:00:00Z" },
      { block_time: "2026-10-26T09:59:59.999999999Z" },
      { block_time: "2026-02-30T10:00:00Z" },
      { price: 1 },
      { price: "1e3" },
      { quantity: "-1" },
      { maker_fee: undefined },
    ]) {
      expect(() =>
        decodeTradeHistoryPage(
          { fills: [{ ...row(), ...patch }], next_cursor: "" },
          1,
          options,
        ),
      ).toThrow();
    }
    for (const rows of [
      [row(), row()],
      [{ ...row(), fill_id: 2 }, row()],
      [
        { ...row(), block_time: "2026-10-26T10:59:59.123456788Z" },
        { ...row(), fill_id: 2 },
      ],
    ]) {
      expect(() =>
        decodeTradeHistoryPage({ fills: rows, next_cursor: "" }, 1, options),
      ).toThrow();
    }
  });
  it("rejects invalid requests before networking", async () => {
    const transport = vi.fn();
    const client = new ExchangeClient({ httpTransport: transport });
    for (const change of [
      { fromMs: -1 },
      { toMs: options.fromMs },
      { fromMs: 1.5 },
      { limit: 0 },
      { limit: 1001 },
      { cursor: "a\nb" },
      { cursor: "a".repeat(4097) },
    ]) {
      await expect(
        client.reads().tradeHistoryPage(1, { ...options, ...change }),
      ).rejects.toThrow();
    }
    expect(() => tradeHistorySearchParams(2147483648, options)).toThrow(
      "market",
    );
    expect(transport).not.toHaveBeenCalled();
  });
});
