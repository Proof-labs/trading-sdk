import { afterEach, describe, expect, it, vi } from "vitest";
import { queryOraclePriceHistoryPage } from "./index.js";

const fromMs = Date.UTC(2026, 8, 18, 0);
const toMs = fromMs + 60_000;
const range = { fromMs, toMs };
const update = (market = 1, timeMs = fromMs, price = "77000000000") => ({
  event_type: "price_updated",
  event_id: "9007199254740993",
  block_time: new Date(timeMs).toISOString(),
  payload: { market: String(market), price },
});
const page = (rows: unknown[], cursor = "") =>
  Response.json({ admin_events: rows, next_cursor: cursor });
afterEach(() => vi.unstubAllGlobals());

describe("oracle price history page", () => {
  it("preserves raw prices, event ids, bounds, cursor and caller transport", async () => {
    const event = update(1, fromMs, "18446744073709551615");
    const transport = vi.fn(async () => page([event], "next+/=?"));
    const signal = new AbortController().signal;
    const result = await queryOraclePriceHistoryPage(
      "https://gateway.test/",
      1,
      {
        ...range,
        limit: 25,
        cursor: "previous+/=?",
        signal,
        fetch: transport,
      },
    );
    expect(result).toEqual({
      market: 1,
      points: [
        {
          t: event.block_time,
          p: event.payload.price,
          eventId: event.event_id,
        },
      ],
      nextCursor: "next+/=?",
    });
    const [input, init] = transport.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const url = new URL(input);
    expect(url.origin + url.pathname).toBe(
      "https://gateway.test/v1/history/admin-events",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      event_type: "price_updated",
      market: "1",
      limit: "25",
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      cursor: "previous+/=?",
    });
    expect(init).toEqual({ method: "GET", cache: "no-store", signal });
  });

  it("filters other markets, unrelated events and out-of-range samples", async () => {
    const event = { ...update(), event_id: 5 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        page([
          update(2),
          { ...update(), event_type: "funding_applied" },
          update(1, fromMs - 1),
          update(1, toMs),
          event,
        ]),
      ),
    );
    expect(await queryOraclePriceHistoryPage("", 1, range)).toEqual({
      market: 1,
      points: [{ t: event.block_time, p: event.payload.price, eventId: "5" }],
      nextCursor: "",
    });
    expect(vi.mocked(fetch).mock.calls[0][0]).toMatch(
      /^\/v1\/history\/admin-events\?/,
    );
    const url = new URL(
      String(vi.mocked(fetch).mock.calls[0][0]),
      "https://gateway.test",
    );
    expect(url.searchParams.get("limit")).toBe("1000");
  });

  it("retains primary and composite events because their indexed shapes are identical", async () => {
    // exchange-core emits market, price and signer for both OracleUpdate and
    // OracleUpdateComposite; indexer attributes are strings in both cases.
    const rows = [
      {
        ...update(),
        event_id: 2,
        payload: { market: "1", price: "110000000", signer: "22".repeat(20) },
      },
      {
        ...update(),
        event_id: 1,
        payload: { market: "1", price: "100000000", signer: "11".repeat(20) },
      },
    ];
    const result = await queryOraclePriceHistoryPage("", 1, {
      ...range,
      fetch: async () => page(rows),
    });
    expect(result.points.map(({ p, eventId }) => ({ p, eventId }))).toEqual([
      { p: "110000000", eventId: "2" },
      { p: "100000000", eventId: "1" },
    ]);
  });

  it("preserves RFC3339 fractions and applies millisecond half-open bounds", async () => {
    const timestamps = [
      "2026-09-18T00:01:00.000001Z",
      "2026-09-18T00:01:00Z",
      "2026-09-18T00:00:59.999999Z",
      "2026-09-18T00:00:00Z",
      "2026-09-17T23:59:59.999999Z",
    ];
    const result = await queryOraclePriceHistoryPage("", 1, {
      ...range,
      fetch: async () =>
        page(timestamps.map((block_time) => ({ ...update(), block_time }))),
    });
    expect(result.points.map(({ t }) => t)).toEqual(timestamps.slice(2, 4));
  });

  it("accepts an empty time window", async () => {
    const result = await queryOraclePriceHistoryPage("", 1, {
      fromMs,
      toMs: fromMs,
      fetch: async () => page([]),
    });
    expect(result).toEqual({ market: 1, points: [], nextCursor: "" });
  });

  it("preserves a cursor through an empty market page without fetching another page", async () => {
    const transport = vi.fn(async () => page([update(2)], "next"));
    expect(
      await queryOraclePriceHistoryPage("", 1, { ...range, fetch: transport }),
    ).toEqual({ market: 1, points: [], nextCursor: "next" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    {},
    { admin_events: [], next_cursor: 7 },
    { admin_events: null, next_cursor: "" },
  ])("rejects malformed page %j", async (body) => {
    const transport = vi.fn(async () => Response.json(body));
    await expect(
      queryOraclePriceHistoryPage("", 1, { ...range, fetch: transport }),
    ).rejects.toThrow("Invalid oracle history page");
  });

  it.each([
    update(1, fromMs, "0"),
    update(1, fromMs, "NaN"),
    update(1, fromMs, "1.5"),
    { ...update(), payload: { market: "1" } },
    { ...update(), block_time: "invalid" },
    { ...update(), event_id: Number.MAX_SAFE_INTEGER + 1 },
    { ...update(), event_id: -1 },
  ])("rejects malformed selected update %j", async (row) => {
    await expect(
      queryOraclePriceHistoryPage("", 1, {
        ...range,
        fetch: vi.fn(async () => page([row])),
      }),
    ).rejects.toThrow("Invalid oracle history update");
  });

  it.each([
    { market: -1 },
    { market: 1.5 },
    { market: 2 ** 32 },
    { fromMs: NaN },
    { fromMs: toMs + 1 },
    { fromMs: -1 },
    { toMs: Infinity },
    { toMs: 8.64e15 + 1 },
    { limit: 0 },
    { limit: 1001 },
    { limit: 1.5 },
  ])(
    "rejects invalid request %j before fetching",
    async ({ market = 1, ...options }) => {
      const transport = vi.fn();
      await expect(
        queryOraclePriceHistoryPage("", market, {
          ...range,
          ...options,
          fetch: transport,
        }),
      ).rejects.toThrow("Invalid oracle history range, market or limit");
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it("preserves HTTP failures, malformed JSON and transport errors", async () => {
    const response = new Response("history unavailable", { status: 503 });
    const transport = vi
      .fn()
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(new Response("not json"))
      .mockRejectedValueOnce(new TypeError("offline"));
    await expect(
      queryOraclePriceHistoryPage("", 1, { ...range, fetch: transport }),
    ).rejects.toMatchObject({
      name: "GatewayHttpError",
      status: 503,
      response,
    });
    expect(await response.text()).toBe("history unavailable");
    await expect(
      queryOraclePriceHistoryPage("", 1, { ...range, fetch: transport }),
    ).rejects.toThrow();
    await expect(
      queryOraclePriceHistoryPage("", 1, { ...range, fetch: transport }),
    ).rejects.toThrow("offline");
  });

  it("honors cancellation before fetch and after an injected transport returns", async () => {
    const controller = new AbortController();
    const transport = vi.fn(async () => {
      controller.abort();
      return page([update()]);
    });
    await expect(
      queryOraclePriceHistoryPage("", 1, {
        ...range,
        fetch: transport,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(transport).not.toHaveBeenCalled();
    await expect(
      queryOraclePriceHistoryPage("", 1, {
        ...range,
        fetch: transport,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
