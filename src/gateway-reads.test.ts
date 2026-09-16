import { afterEach, describe, expect, it, vi } from "vitest";
import { ExchangeClient } from "./index.js";
const owner = "03".repeat(20);
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("named gateway reads", () => {
  it("preserves exact info bodies, same-origin, envelopes, caller transport and cancellation", async () => {
    const fetch = vi.fn(async () => json({ data: "raw-tuple-envelope" }));
    const reads = new ExchangeClient({ gatewayUrl: "" }).reads({ fetch });
    const signal = new AbortController().signal;
    const cases: [string, () => Promise<Response>, object][] = [
      ["meta", () => reads.meta({ signal }), {}],
      ["impactMarkets", () => reads.impactMarkets({ signal }), {}],
      ["impactMarket", () => reads.impactMarket(43, { signal }), { id: 43 }],
      ["l2Book", () => reads.l2Book(2, { signal }), { market: 2 }],
      ["fundingRate", () => reads.fundingRate(2, { signal }), { market: 2 }],
      [
        "clearinghouseState",
        () => reads.clearinghouseState(owner, { signal }),
        { user: owner },
      ],
      [
        "openOrders",
        () => reads.openOrders(owner, { signal }),
        { user: owner },
      ],
      [
        "historyOrders",
        () => reads.historyOrders({ user: owner, limit: 200 }, { signal }),
        { user: owner, limit: 200 },
      ],
      [
        "historyFills",
        () => reads.historyFills({ user: owner, from: 1, to: 2 }, { signal }),
        { user: owner, from: 1, to: 2 },
      ],
      [
        "historyTrades",
        () => reads.historyTrades({ market: 2, to: 100 }, { signal }),
        { market: 2, to: 100 },
      ],
      [
        "historyPositions",
        () => reads.historyPositions({ user: owner, market: 2 }, { signal }),
        { user: owner, market: 2 },
      ],
      [
        "historyResolutions",
        () =>
          reads.historyResolutions(
            { user: owner, impact_market_id: 43 },
            { signal },
          ),
        { user: owner, impact_market_id: 43 },
      ],
    ];
    for (const [type, call, params] of cases) {
      expect(await (await call()).json()).toEqual({
        data: "raw-tuple-envelope",
      });
      const [url, init] = fetch.mock.calls.at(-1)! as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe("/info");
      expect(init.signal).toBe(signal);
      expect(JSON.parse(init.body as string)).toEqual({ type, ...params });
    }
  });
  it("preserves REST query strings, opaque cursors and ISO candle windows", async () => {
    const fetch = vi.fn(async () => json({ next_cursor: "opaque" }));
    const reads = new ExchangeClient({
      gatewayUrl: "https://gateway.example/",
    }).reads({ fetch });
    await reads.candles({
      market: 2,
      resolution: "1m",
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-02T00:00:00Z",
      limit: 1500,
    });
    const url = new URL((fetch.mock.calls[0] as unknown as [string])[0]);
    expect(url.pathname).toBe("/v1/history/candles");
    expect(url.searchParams.get("resolution")).toBe("1m");
    await reads.accountEvents({
      owner,
      event_type: "funding_settled",
      order: "desc",
      cursor: "a+/=?",
    });
    const account = new URL((fetch.mock.calls[1] as unknown as [string])[0]);
    expect(account.searchParams.get("cursor")).toBe("a+/=?");
    expect(account.searchParams.get("order")).toBe("desc");
    await reads.ticker(2);
    await reads.health();
    expect(
      fetch.mock.calls.slice(2).map((call) => (call as unknown as [string])[0]),
    ).toEqual([
      "https://gateway.example/v1/ticker/2",
      "https://gateway.example/v1/health",
    ]);
  });
  it("keeps HTTP status errors and pre-aborted requests do not fetch", async () => {
    const fetch = vi.fn(async () => json({}, 429));
    const reads = new ExchangeClient().reads({ fetch });
    await expect(reads.meta()).rejects.toMatchObject({
      status: 429,
      name: "GatewayHttpError",
    });
    await expect(
      reads.health({ signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

it("reads without URLSearchParams.size", async () => {
  vi.spyOn(URLSearchParams.prototype, "size", "get").mockImplementation(() => {
    throw new Error("not supported");
  });
  const fetch = vi.fn(async () => json({}));
  await new ExchangeClient({ gatewayUrl: "" }).reads({ fetch }).ticker(1);
  expect(fetch.mock.calls[0][0]).toBe("/v1/ticker/1");
});

it("keeps caller Response bodies, HTTP errors and aborts intact", async () => {
  const body = new Response("upstream body", { status: 503 });
  const transport = vi.fn(async () => body);
  const reads = new ExchangeClient({
    gatewayUrl: "https://gateway.example",
  }).reads({ fetch: transport });
  const error = (await reads.health().catch((error: unknown) => error)) as {
    status: number;
    response: Response;
  };
  expect(error.status).toBe(503);
  expect(error.response).toBe(body);
  expect(await error.response.text()).toBe("upstream body");
  const abort = new DOMException("cancelled", "AbortError");
  transport.mockRejectedValueOnce(abort);
  await expect(reads.health()).rejects.toBe(abort);
});

it("uses the configured gateway for response reads even in internal node mode", async () => {
  const fetch = vi.fn(async () => json({}));
  const client = new ExchangeClient({
    gatewayUrl: "https://gateway.example/",
    useGateway: false,
    apiUrl: "https://internal.example",
  });
  await client.reads({ fetch }).health();
  expect(fetch.mock.calls[0][0]).toBe("https://gateway.example/v1/health");
});
