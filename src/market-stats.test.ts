import { describe, expect, it, vi } from "vitest";
import { GatewayReads } from "./gateway-reads.js";
import {
  decodeMarketStatsResponse,
  queryMarketStats,
  type MarketStatsResponse,
} from "./market-stats.js";

function snapshot(): MarketStatsResponse {
  return {
    as_of: "2026-09-21T12:34:56.123456789Z",
    window_start: "2026-09-20T12:34:56.123456789Z",
    window_end: "2026-09-21T12:34:56.123456789Z",
    indexed_height: "9007199254740993",
    indexed_at: "2026-09-21T12:34:54Z",
    stale_after_seconds: 60,
    status: "ready",
    markets: [
      {
        market: 0,
        sz_decimals: 18,
        status: "ready",
        unavailable_reason: null,
        volume_24h_contracts: "1844674407370955161500",
        volume_24h_usdc: "12345678901234567890.000000000000000000000001",
        reference_price: "999999999999999999",
        last_price: "999999999999999998",
        change_24h_bps: "-0.000001",
        high_price: "999999999999999999",
        low_price: "999999999999999998",
        open_interest: {
          long_contracts: "9007199254740993",
          short_contracts: "9007199254740993",
        },
        open_interest_unavailable_reason: null,
      },
    ],
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("rolling market statistics", () => {
  it("preserves exact strings, raw prices, decimal dollar notional, sides and timestamps", () => {
    expect(decodeMarketStatsResponse(snapshot())).toEqual(snapshot());
  });
  it("uses the configured gateway transport, batch scope and cancellation", async () => {
    const body = snapshot();
    body.markets.push({ ...body.markets[0], market: 2147483647 });
    const fetch = vi.fn(async () => json(body));
    const signal = new AbortController().signal;
    const reads = new GatewayReads("https://gateway.example", fetch);
    expect(await queryMarketStats(reads, [2147483647, 0], { signal })).toEqual(
      body,
    );
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://gateway.example/v1/history/market-stats?markets=2147483647%2C0",
      { method: "GET", cache: "no-store", signal },
    );
  });
  it("returns raw Response unchanged from the named read", async () => {
    const response = json(snapshot());
    const reads = new GatewayReads("", async () => response);
    expect(await reads.marketStats({ markets: [0] })).toBe(response);
    expect(response.bodyUsed).toBe(false);
  });
  it("keeps stale and partial evidence distinct from valid zero", () => {
    const body = snapshot();
    body.status = body.markets[0].status = "stale";
    body.markets[0].volume_24h_contracts = "0";
    body.markets[0].volume_24h_usdc = "0";
    body.markets[0].reference_price = null;
    body.markets[0].change_24h_bps = null;
    body.markets[0].high_price = body.markets[0].low_price = null;
    body.markets[0].open_interest = null;
    body.markets[0].open_interest_unavailable_reason =
      "position_history_incomplete";
    expect(decodeMarketStatsResponse(body)).toEqual(body);
  });
  it("preserves unavailable frontier and market metadata", () => {
    const body = snapshot();
    body.indexed_at = body.indexed_height = null;
    body.status = body.markets[0].status = "unavailable";
    body.markets[0].sz_decimals = null;
    body.markets[0].unavailable_reason = "market_metadata_unavailable";
    expect(decodeMarketStatsResponse(body)).toEqual(body);
  });
  it.each(
    [
      [],
      [1, 1],
      [-1],
      [1.5],
      [2147483648],
      [NaN],
      Array.from({ length: 51 }, (_, i) => i),
    ].map((markets) => [markets]),
  )("rejects invalid market batches before transport: %j", async (markets) => {
    const fetch = vi.fn(async () => json(snapshot()));
    const reads = new GatewayReads("", fetch);
    await expect(queryMarketStats(reads, markets)).rejects.toThrow(
      "Invalid market statistics",
    );
    expect(() => reads.marketStats({ markets })).toThrow(
      "Invalid market statistics",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["1e3", "01", "-1", "1.0", 1, undefined])(
    "rejects malformed raw integer: %s",
    (invalid) => {
      const body = snapshot();
      (
        body.markets[0] as unknown as Record<string, unknown>
      ).volume_24h_contracts = invalid;
      expect(() => decodeMarketStatsResponse(body)).toThrow(
        "volume_24h_contracts",
      );
    },
  );
  it.each(["1e3", "-1", "01.2", ".2", "NaN", 0])(
    "rejects malformed dollar notional: %s",
    (invalid) => {
      const body = snapshot();
      (body.markets[0] as unknown as Record<string, unknown>).volume_24h_usdc =
        invalid;
      expect(() => decodeMarketStatsResponse(body)).toThrow("volume_24h_usdc");
    },
  );
  it.each(["+1", "1e3", "1.0000001", 0])(
    "rejects malformed basis points: %s",
    (invalid) => {
      const body = snapshot();
      (body.markets[0] as unknown as Record<string, unknown>).change_24h_bps =
        invalid;
      expect(() => decodeMarketStatsResponse(body)).toThrow("change_24h_bps");
    },
  );
  it.each([
    (b: MarketStatsResponse) => {
      b.window_start = b.window_end;
    },
    (b: MarketStatsResponse) => {
      b.window_end = "2026-09-22T12:34:56Z";
    },
    (b: MarketStatsResponse) => {
      b.indexed_height = null;
    },
    (b: MarketStatsResponse) => {
      b.indexed_at = "today";
    },
    (b: MarketStatsResponse) => {
      b.stale_after_seconds = 0;
    },
    (b: MarketStatsResponse) => {
      b.markets[0].sz_decimals = 19;
    },
    (b: MarketStatsResponse) => {
      b.markets.push(b.markets[0]);
    },
    (b: MarketStatsResponse) => {
      delete (b.markets[0] as Partial<(typeof b.markets)[0]>)
        .open_interest_unavailable_reason;
    },
    (b: MarketStatsResponse) => {
      (b as { status: string }).status = "healthy";
    },
  ])("rejects malformed evidence", (mutate) => {
    const body = snapshot();
    mutate(body);
    expect(() => decodeMarketStatsResponse(body)).toThrow(
      "Invalid market statistics",
    );
  });
  it("rejects missing and foreign response markets", async () => {
    const reads = new GatewayReads("", async () => json(snapshot()));
    await expect(queryMarketStats(reads, [0, 1])).rejects.toThrow(
      "coverage mismatch",
    );
    await expect(queryMarketStats(reads, [1])).rejects.toThrow(
      "coverage mismatch",
    );
  });
  it("preserves HTTP failures and cancellation before and during decoding", async () => {
    const response = json({ error: "history unavailable" }, 503);
    const fetch = vi.fn(async () => response);
    const reads = new GatewayReads("", fetch);
    await expect(queryMarketStats(reads, [0])).rejects.toMatchObject({
      name: "GatewayHttpError",
      status: 503,
      response,
    });
    await expect(
      queryMarketStats(reads, [0], { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    const late = new GatewayReads("", async () => {
      const response = json(snapshot());
      response.json = async () => {
        controller.abort();
        return snapshot();
      };
      return response;
    });
    await expect(
      queryMarketStats(late, [0], { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
