import { afterEach, describe, expect, it, vi } from "vitest";
import { ExchangeClient, GatewayHttpError } from "./index.js";
const owner = "03".repeat(20);
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("portfolio history pages", () => {
  const bounds = { fromMs: 1000, toMs: 3000 };
  const point = {
    t: new Date(1500).toISOString(),
    account_value: 1234567,
    equity_source: "mark_v2",
  };
  it("preserves fixed range, source, integer units and opaque cursor across pages", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json({ owner, points: [point], next_cursor: "abc+/=?" }),
      )
      .mockResolvedValueOnce(json({ owner, points: [], next_cursor: "" }));
    vi.stubGlobal("fetch", fetch);
    const client = new ExchangeClient({ gatewayUrl: "" });
    const first = await client.queryPortfolioHistory(owner, bounds);
    expect(first.points).toEqual([
      { t: point.t, accountValue: 1234567n, equitySource: "mark_v2" },
    ]);
    await client.queryPortfolioHistory(owner, {
      ...bounds,
      cursor: first.nextCursor,
    });
    const url = new URL(fetch.mock.calls[1][0], "https://same.origin");
    expect(url.pathname).toBe(`/v1/history/portfolio/${owner}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      from: "1000",
      to: "3000",
      limit: "5000",
      cursor: "abc+/=?",
    });
  });
  it.each([
    { owner: "04".repeat(20), points: [point], next_cursor: "" },
    {
      owner,
      points: [{ ...point, account_value: Number.MAX_SAFE_INTEGER + 1 }],
      next_cursor: "",
    },
    { owner, points: [{ ...point, equity_source: 2 }], next_cursor: "" },
    {
      owner,
      points: [{ ...point, t: new Date(3000).toISOString() }],
      next_cursor: "",
    },
    { owner, points: [point], next_cursor: null },
  ])(
    "rejects invalid owner, precision, provenance, range or cursor",
    async (page) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(page)));
      await expect(
        new ExchangeClient({ gatewayUrl: "" }).queryPortfolioHistory(
          owner,
          bounds,
        ),
      ).rejects.toThrow();
    },
  );
  it("rejects bad input, HTTP errors, later-page errors and cancellation", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json({ owner, points: [point], next_cursor: "next" }),
      )
      .mockResolvedValueOnce(json({}, 503));
    vi.stubGlobal("fetch", fetch);
    const client = new ExchangeClient({ gatewayUrl: "" });
    await expect(client.queryPortfolioHistory("", bounds)).rejects.toThrow(
      "owner",
    );
    await expect(
      client.queryPortfolioHistory(owner, { fromMs: 2, toMs: 1 }),
    ).rejects.toThrow("range");
    const first = await client.queryPortfolioHistory(owner, bounds);
    await expect(
      client.queryPortfolioHistory(owner, {
        ...bounds,
        cursor: first.nextCursor,
      }),
    ).rejects.toBeInstanceOf(GatewayHttpError);
    await expect(
      client.queryPortfolioHistory(owner, {
        ...bounds,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

it("keeps indexer portfolio history on the gateway in internal node mode", async () => {
  const fetch = vi.fn(async () => json({ owner, points: [], next_cursor: "" }));
  vi.stubGlobal("fetch", fetch);
  const client = new ExchangeClient({
    gatewayUrl: "https://gateway.example/",
    useGateway: false,
    apiUrl: "https://internal-node.example",
  });
  await client.queryPortfolioHistory(owner, { fromMs: 1000, toMs: 3000 });
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][0]).toBe(
    `https://gateway.example/v1/history/portfolio/${owner}?from=1000&to=3000&limit=5000`,
  );
});

it.each(["0x", "0X", ""])(
  "normalizes %s uppercase owner to the indexer's canonical response",
  async (prefix) => {
    const canonical = "ab".repeat(20);
    const fetch = vi.fn(async () =>
      json({ owner: canonical, points: [], next_cursor: "opaque" }),
    );
    vi.stubGlobal("fetch", fetch);
    const client = new ExchangeClient({ gatewayUrl: "" });
    expect(
      await client.queryPortfolioHistory(prefix + canonical.toUpperCase(), {
        fromMs: 1000,
        toMs: 3000,
      }),
    ).toEqual({ points: [], nextCursor: "opaque" });
    expect(fetch.mock.calls[0][0]).toBe(
      `/v1/history/portfolio/${canonical}?from=1000&to=3000&limit=5000`,
    );
    fetch.mockResolvedValueOnce(
      json({ owner: "cd".repeat(20), points: [], next_cursor: "" }),
    );
    await expect(
      client.queryPortfolioHistory(prefix + canonical.toUpperCase(), {
        fromMs: 1000,
        toMs: 3000,
      }),
    ).rejects.toThrow("owner mismatch");
  },
);
