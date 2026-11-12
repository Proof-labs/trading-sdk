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

  it("refuses a row missing a middle field and a missing envelope", async () => {
    const shifted = row().filter((_, index) => index !== 12);
    await expect(
      clientFor([shifted]).client.queryMarketListing(),
    ).rejects.toThrow();
    await expect(
      clientFor(undefined).client.queryMarketListing(),
    ).rejects.toThrow();
  });

  it.each([
    ["an object row", {}],
    ["an object row with a matching length property", { length: 24 }],
  ])("refuses %s instead of reporting its length", async (_label, extra) => {
    // The Rust decoder accepts named fields and defaults the missing tail.
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
    await expect(
      clientFor([row(), namedRow]).client.queryMarketListing(),
    ).rejects.toThrow("Invalid market listing rows: expected arrays");
  });
});
