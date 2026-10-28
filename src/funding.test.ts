// The funding read (`GET /v1/funding/{market}`). Global fetch is stubbed;
// each test asserts the URL and the decoded shape.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Encoder } from "@msgpack/msgpack";
import { ExchangeClient } from "./client.js";
import { decodeFundingInfo, type FundingInfo } from "./index.js";

const encoder = new Encoder({ useBigInt64: true });

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function stubFetch(body: unknown, status = 200): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      calls.push(url.toString());
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return calls;
}

const client = () => new ExchangeClient({ gatewayUrl: "http://gateway" });

afterEach(() => vi.unstubAllGlobals());

/** exchange `FundingInfo` field order: market, funding_rate_bps,
 *  cumulative_funding, last_funding_time_ms, mark_price_ewma, oracle_price,
 *  funding_interval_ms, max_funding_rate_bps. */
const RECORD: (number | bigint)[] = [
  7,
  -3,
  -1_250,
  1_761_600_000_000n,
  64_010_000_000n,
  64_000_000_000n,
  3_600_000,
  75,
];

const DECODED: FundingInfo = {
  market: 7,
  fundingRateBps: -3n,
  cumulativeFunding: -1_250n,
  lastFundingTimeMs: 1_761_600_000_000n,
  markPriceEwma: 64_010_000_000n,
  oraclePrice: 64_000_000_000n,
  fundingIntervalMs: 3_600_000n,
  maxFundingRateBps: 75,
};

describe("queryFunding", () => {
  it("reads the gateway route and decodes the engine's record", async () => {
    const calls = stubFetch({
      data: toB64(encoder.encode(RECORD) as Uint8Array),
    });
    expect(await client().queryFunding(7)).toEqual(DECODED);
    expect(calls).toEqual(["http://gateway/v1/funding/7"]);
  });

  it("keeps an oracle price above 2^53 exact", () => {
    const price = (1n << 64n) - 1n;
    const record = [...RECORD];
    record[5] = price;
    expect(decodeFundingInfo(record).oraclePrice).toBe(price);
  });

  it("ignores fields appended after the known eight", () => {
    expect(decodeFundingInfo([...RECORD, 1])).toEqual(DECODED);
  });

  it("fails closed on a record of the wrong shape", () => {
    expect(() => decodeFundingInfo(RECORD.slice(0, 7))).toThrow(
      /funding decode: invalid record/,
    );
    expect(() => decodeFundingInfo({ market: 7 })).toThrow(/invalid record/);
    const negativeOracle = [...RECORD];
    negativeOracle[5] = -1;
    expect(() => decodeFundingInfo(negativeOracle)).toThrow(
      /invalid oracle price/,
    );
  });

  it("throws when the gateway answers no data or an error", async () => {
    stubFetch({});
    await expect(client().queryFunding(7)).rejects.toThrow();
    stubFetch({ error: "query failed" }, 500);
    await expect(client().queryFunding(7)).rejects.toThrow();
  });
});
