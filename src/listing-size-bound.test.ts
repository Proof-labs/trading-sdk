import { Encoder } from "@msgpack/msgpack";
import { describe, expect, it, vi } from "vitest";
import { ExchangeClient } from "./client.js";

const encoder = new Encoder({ useBigInt64: true });
// One row whose ticker alone is over the 1 MiB listing bound (MAX_LISTING_BYTES).
const oversized = [
  [
    1,
    0,
    0,
    0,
    0,
    0,
    0,
    "Perp",
    0,
    0,
    false,
    0,
    0,
    [],
    0,
    0,
    null,
    0,
    "OracleOnly",
    0,
    0,
    0,
    "X".repeat(1024 * 1024),
    0,
  ],
];

function client(): ExchangeClient {
  const body = {
    data: Buffer.from(encoder.encode(oversized)).toString("base64"),
  };
  return new ExchangeClient({
    gatewayUrl: "https://gateway.example",
    httpTransport: vi.fn(
      async () => new Response(JSON.stringify(body), { status: 200 }),
    ),
  });
}

describe("listing payload bound", () => {
  it("refuses a market or events listing over 1 MiB in every listing read", async () => {
    await expect(client().queryMarkets()).rejects.toThrow("too large");
    await expect(client().queryMarketListing()).rejects.toThrow("too large");
    await expect(client().queryEvents()).rejects.toThrow("too large");
    await expect(client().queryEventListing()).rejects.toThrow("too large");
  });
});
