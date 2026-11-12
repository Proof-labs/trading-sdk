import { Encoder } from "@msgpack/msgpack";
import { describe, expect, it, vi } from "vitest";
import { ExchangeClient } from "./client.js";

const encoder = new Encoder({ useBigInt64: true });
// One BTC perp row of the current 24-field MarketConfig, as DevNet lists it.
const row = (): unknown[] => [
  1,
  3334,
  1667,
  5,
  2,
  3_600_000,
  400,
  "Perp",
  0,
  0,
  false,
  0,
  600_000,
  [],
  0,
  0,
  null,
  0,
  "OracleOnly",
  0,
  0,
  5,
  "BTC",
  30_000,
];
function clientFor(rows: unknown[] | undefined) {
  const body =
    rows === undefined
      ? {}
      : { data: Buffer.from(encoder.encode(rows)).toString("base64") };
  const transport = vi.fn(
    async () => new Response(JSON.stringify(body), { status: 200 }),
  );
  return {
    client: new ExchangeClient({
      gatewayUrl: "https://gateway.example",
      httpTransport: transport,
    }),
    transport,
  };
}

describe("market listing with row field counts", () => {
  it("decodes as queryMarkets does and counts each row's fields", async () => {
    const { client, transport } = clientFor([row(), row()]);
    const listing = await client.queryMarketListing();
    expect(listing.pinnedFieldCount).toBe(24);
    expect(listing.rowFieldCounts).toEqual([24, 24]);
    expect(listing.markets).toEqual(
      await clientFor([row(), row()]).client.queryMarkets(),
    );
    expect(listing.markets[0]).toMatchObject({
      market: 1,
      ticker: "BTC",
      szDecimals: 5,
    });
    expect(transport.mock.calls[0][0]).toBe(
      "https://gateway.example/v1/markets",
    );
  });

  it("shows an appended or a missing last field, which the decode tolerates", async () => {
    const appended = await clientFor([
      [...row(), 7],
      row(),
    ]).client.queryMarketListing();
    expect(appended.rowFieldCounts).toEqual([25, 24]);
    expect(appended.markets[0].maxOpenInterest).toBe(30_000n);
    const short = await clientFor([
      row().slice(0, 23),
    ]).client.queryMarketListing();
    expect(short.rowFieldCounts).toEqual([23]);
    expect(short.markets[0].maxOpenInterest).toBe(0n);
  });

  it("reports a row it cannot decode and keeps the others", async () => {
    const shifted = row().filter((_, index) => index !== 12);
    const spot = row();
    spot[0] = 7;
    spot[7] = "Spot";
    const listing = await clientFor([
      shifted,
      row(),
      spot,
    ]).client.queryMarketListing();
    expect(listing.markets.map((market) => market.market)).toEqual([1]);
    expect(listing.rowFieldCounts).toEqual([24]);
    expect(
      listing.refusedRows.map(({ index, market, fieldCount }) => ({
        index,
        market,
        fieldCount,
      })),
    ).toEqual([
      { index: 0, market: 1, fieldCount: 23 },
      { index: 2, market: 7, fieldCount: 24 },
    ]);
    expect(listing.refusedRows[1].error).toContain("Spot");
  });

  it("refuses a missing envelope and a payload that is not a list", async () => {
    await expect(
      clientFor(undefined).client.queryMarketListing(),
    ).rejects.toThrow();
    const notAList = {
      data: Buffer.from(encoder.encode(5)).toString("base64"),
    };
    const client = new ExchangeClient({
      gatewayUrl: "https://gateway.example",
      httpTransport: vi.fn(
        async () => new Response(JSON.stringify(notAList), { status: 200 }),
      ),
    });
    await expect(client.queryMarketListing()).rejects.toThrow("Markets decode");
  });

  it.each([
    ["an object row", {}],
    ["an object row with a matching length property", { length: 24 }],
  ])("reports %s as refused instead of decoding it", async (_label, extra) => {
    // The Rust decoder would accept named fields and default the missing tail.
    const namedRow = {
      market: 1,
      im_bps: 3334,
      mm_bps: 1667,
      taker_fee_bps: 5,
      maker_fee_bps: 2,
      funding_interval_ms: 3_600_000,
      max_funding_rate_bps: 400,
      ...extra,
    };
    const listing = await clientFor([
      row(),
      namedRow,
    ]).client.queryMarketListing();
    expect(listing.markets).toHaveLength(1);
    expect(listing.refusedRows).toEqual([
      { index: 1, fieldCount: 0, error: "row is not an array" },
    ]);
  });
});
