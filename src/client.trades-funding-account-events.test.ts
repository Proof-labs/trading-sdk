// Decoded reads a market maker previously hand-parsed: the node's recent trade
// tape, an owner's funding payments, and an owner's account events. Each is
// checked for its URL, transport priority, a well-formed decode and the
// rejection of a malformed row, with the error's kind and field.
import { describe, expect, it } from "vitest";
import {
  ExchangeClient,
  GatewayReadError,
  Side,
  getPublicKey,
  ownerToHex,
  pubkeyToOwner,
  type ExchangeHttpRequestContext,
  type AccountEventsOptions,
  type ExchangeHttpTransport,
} from "./index.js";

const key = new Uint8Array(32).fill(9);
const self = ownerToHex(pubkeyToOwner(getPublicKey(key)));
const maker = "aa".repeat(20);
const taker = "bb".repeat(20);

/** Expect a `GatewayReadError` of this kind (and field, when given). */
async function rejectsWith(
  read: Promise<unknown>,
  kind: GatewayReadError["kind"],
  field?: string,
) {
  const error: unknown = await read.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(GatewayReadError);
  expect((error as GatewayReadError).kind).toBe(kind);
  if (field !== undefined)
    expect((error as GatewayReadError).field).toBe(field);
}

/** A string body is sent verbatim; anything else as JSON. */
function recording(bodies: unknown[], withKey = true) {
  const urls: string[] = [];
  const contexts: ExchangeHttpRequestContext[] = [];
  const transport: ExchangeHttpTransport = async (url, _init, context) => {
    urls.push(url);
    contexts.push(context);
    if (!bodies.length) throw new Error("unexpected request");
    const body = bodies.shift();
    return new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };
  const client = new ExchangeClient({
    gatewayUrl: "http://gw",
    apiUrl: "http://api",
    rpcUrl: "http://rpc",
    httpTransport: transport,
  });
  if (withKey) client.setPrivateKey(key);
  return { client, urls, contexts };
}

const tradeRow = (over: Record<string, unknown> = {}) => ({
  fill_id: "42",
  market: "3",
  price: "66750000000",
  quantity: "5",
  maker_owner: maker,
  taker_owner: taker,
  maker_side: "sell",
  taker_fee: "1200",
  maker_fee: "-300",
  block_height: 900,
  timestamp: 1_760_000_000_123,
  ...over,
});

describe("queryRecentTrades", () => {
  it("reads the node tape through the gateway at query priority", async () => {
    const { client, urls, contexts } = recording([
      {
        trades: [
          tradeRow(),
          tradeRow({ fill_id: "41", block_height: 899, maker_side: "buy" }),
        ],
      },
    ]);
    const trades = await client.queryRecentTrades(3, { limit: 2 });
    expect(urls).toEqual(["http://gw/v1/trades/3?limit=2"]);
    expect(contexts[0]).toMatchObject({
      purpose: "query",
      priority: "critical",
    });
    expect(trades).toEqual([
      {
        fillId: 42n,
        market: 3,
        price: 66_750_000_000n,
        quantity: 5n,
        makerOwner: maker,
        takerOwner: taker,
        makerSide: Side.Sell,
        takerFee: 1200n,
        makerFee: -300n,
        blockHeight: 900n,
        recordedAtMs: 1_760_000_000_123,
      },
      expect.objectContaining({ fillId: 41n, makerSide: Side.Buy }),
    ]);
  });

  it("defaults the limit to the node's 100", async () => {
    const { client, urls } = recording([{ trades: [] }]);
    expect(await client.queryRecentTrades(7)).toEqual([]);
    expect(urls).toEqual(["http://gw/v1/trades/7?limit=100"]);
  });

  it.each([
    ["a limit above 500", 3, { limit: 501 }, "recent trades.limit"],
    ["a zero limit", 3, { limit: 0 }, "recent trades.limit"],
    ["market zero", 0, {}, "recent trades.market"],
  ])(
    "refuses %s as configuration before sending",
    async (_label, market, opts, field) => {
      const { client, urls } = recording([]);
      await rejectsWith(
        client.queryRecentTrades(market, opts),
        "configuration",
        field,
      );
      expect(urls).toEqual([]);
    },
  );

  it.each([
    ["an empty price", { price: "" }, "malformed", "recent trades.price"],
    [
      "a decimal quantity",
      { quantity: "1.5" },
      "malformed",
      "recent trades.quantity",
    ],
    [
      "another market",
      { market: "4" },
      "binding",
      "recent trades.market mismatch",
    ],
    [
      "an unknown side",
      { maker_side: "Bid" },
      "malformed",
      "recent trades.maker side",
    ],
    [
      "a prefixed owner",
      { maker_owner: `0x${maker}` },
      "malformed",
      "recent trades.maker owner",
    ],
    [
      "a numeric fee",
      { taker_fee: 1200 },
      "malformed",
      "recent trades.taker fee",
    ],
  ] as const)("rejects a row with %s", async (_label, over, kind, field) => {
    const { client } = recording([{ trades: [tradeRow(over)] }]);
    await rejectsWith(client.queryRecentTrades(3), kind, field);
  });

  it("rejects a bare array and an oldest-first tape", async () => {
    const bare = recording([[tradeRow()]]);
    await rejectsWith(
      bare.client.queryRecentTrades(3),
      "malformed",
      "envelope",
    );
    const unordered = recording([
      { trades: [tradeRow({ block_height: 1 }), tradeRow({ fill_id: "43" })] },
    ]);
    await rejectsWith(
      unordered.client.queryRecentTrades(3),
      "malformed",
      "recent trades.unordered trade",
    );
  });
});

const paymentRow = (over: Record<string, unknown> = {}) => ({
  owner: self,
  market: 2,
  payment: "-1500",
  block_height: 77,
  block_time: "2026-11-05T10:00:00.5Z",
  ...over,
});

describe("queryHistoryFundingPayments", () => {
  it("reads the client's own payments at urgent priority", async () => {
    const { client, urls, contexts } = recording([
      {
        funding_payments: [
          paymentRow(),
          paymentRow({ block_time: "2026-11-05T09:00:00Z", payment: "250" }),
        ],
        next_cursor: "opaque-1",
      },
    ]);
    const page = await client.queryHistoryFundingPayments(undefined, {
      market: 2,
      fromMs: 1_793_869_200_000,
      toMs: 1_793_876_400_000,
      limit: 2,
    });
    expect(urls).toEqual([
      `http://gw/v1/history/funding-payments/${self}?from=1793869200000&to=1793876400000&limit=2&market=2`,
    ]);
    expect(contexts[0]).toMatchObject({
      purpose: "account",
      priority: "urgent",
    });
    expect(page).toEqual({
      payments: [
        {
          owner: self,
          market: 2,
          payment: -1500n,
          blockHeight: 77n,
          blockTime: "2026-11-05T10:00:00.5Z",
        },
        expect.objectContaining({ payment: 250n }),
      ],
      nextCursor: "opaque-1",
    });
  });

  it("passes the cursor back and ends on an empty next cursor", async () => {
    const other = "0x" + "CC".repeat(20);
    const { client, urls } = recording([
      { funding_payments: [], next_cursor: "" },
    ]);
    const page = await client.queryHistoryFundingPayments(other, {
      cursor: "opaque-1",
    });
    expect(urls).toEqual([
      `http://gw/v1/history/funding-payments/${"cc".repeat(20)}?limit=200&cursor=opaque-1`,
    ]);
    expect(page).toEqual({ payments: [], nextCursor: "" });
  });

  it.each([
    ["a limit above 1000", { limit: 1001 }, "funding payments.limit"],
    ["market zero", { market: 0 }, "funding payments.market"],
    [
      "a market beyond the indexer's signed 32-bit range",
      { market: 0x8000_0000 },
      "funding payments.market",
    ],
    [
      "an empty window",
      { fromMs: 1_000, toMs: 1_000 },
      "funding payments.window",
    ],
    ["a cursor with a space", { cursor: "a b" }, "funding payments.cursor"],
  ])(
    "refuses %s as configuration before sending",
    async (_label, opts, field) => {
      const { client, urls } = recording([]);
      await rejectsWith(
        client.queryHistoryFundingPayments(undefined, opts),
        "configuration",
        field,
      );
      expect(urls).toEqual([]);
    },
  );

  it.each([
    [
      "a numeric payment",
      { payment: -1500 },
      "malformed",
      "funding payments.payment",
    ],
    [
      "a null payment",
      { payment: null },
      "malformed",
      "funding payments.payment",
    ],
    ["a null market", { market: null }, "malformed", "market"],
    ["a string market", { market: "2" }, "malformed", "market"],
    [
      "another owner",
      { owner: maker },
      "binding",
      "funding payments.owner mismatch",
    ],
    [
      "an epoch-millisecond time",
      { block_time: 1_762_300_000_000 },
      "malformed",
      "funding payments.block time",
    ],
  ] as const)("rejects a row with %s", async (_label, over, kind, field) => {
    const { client } = recording([
      { funding_payments: [paymentRow(over)], next_cursor: "" },
    ]);
    await rejectsWith(client.queryHistoryFundingPayments(), kind, field);
  });

  it("rejects a row of another market than the one asked for", async () => {
    const { client } = recording([
      { funding_payments: [paymentRow({ market: 4 })], next_cursor: "" },
    ]);
    await rejectsWith(
      client.queryHistoryFundingPayments(undefined, { market: 2 }),
      "binding",
      "funding payments.market mismatch",
    );
  });

  it("rejects the retired bare-array shape and a short page with a cursor", async () => {
    const bare = recording([[paymentRow()]]);
    await rejectsWith(
      bare.client.queryHistoryFundingPayments(),
      "malformed",
      "envelope",
    );
    const short = recording([
      { funding_payments: [paymentRow()], next_cursor: "more" },
    ]);
    await rejectsWith(
      short.client.queryHistoryFundingPayments(),
      "malformed",
      "funding payments.non-progressing or truncated page",
    );
  });
});

const eventRow = (over: Record<string, unknown> = {}) => ({
  event_id: 10,
  owner: self,
  block_height: 50,
  block_time: "2026-11-05T10:00:00Z",
  tx_hash: "ab".repeat(32),
  event_index: 3,
  event_type: "binary_issued_from_mtm",
  payload: { binary_market: "8", cp_market: "5", signed_delta: "-2" },
  ...over,
});

describe("queryHistoryAccountEventsPage", () => {
  it("pages through the existing raw read at urgent priority", async () => {
    const { client, urls, contexts } = recording([
      {
        account_events: [
          eventRow(),
          eventRow({ event_id: 11, tx_position: 1 }),
        ],
        next_cursor: "page-2",
      },
      { account_events: [eventRow({ event_id: 12 })], next_cursor: "" },
    ]);
    const opts = {
      order: "asc" as const,
      eventType: "binary_issued_from_mtm",
      limit: 2,
    };
    const first = await client.queryHistoryAccountEventsPage(undefined, opts);
    expect(first).toEqual({
      events: [
        {
          eventId: 10n,
          owner: self,
          blockHeight: 50n,
          blockTime: "2026-11-05T10:00:00Z",
          txHash: "AB".repeat(32),
          eventIndex: 3,
          eventType: "binary_issued_from_mtm",
          payload: { binary_market: "8", cp_market: "5", signed_delta: "-2" },
        },
        expect.objectContaining({
          eventId: 11n,
          txHash: "AB".repeat(32),
          txPosition: 1,
        }),
      ],
      nextCursor: "page-2",
    });
    const second = await client.queryHistoryAccountEventsPage(undefined, {
      ...opts,
      cursor: first.nextCursor,
    });
    expect(second.nextCursor).toBe("");
    expect(second.events.map((e) => e.eventId)).toEqual([12n]);
    expect(urls).toEqual([
      `http://gw/v1/history/account-events?owner=${self}&order=asc&event_type=binary_issued_from_mtm&limit=2`,
      `http://gw/v1/history/account-events?owner=${self}&order=asc&event_type=binary_issued_from_mtm&limit=2&cursor=page-2`,
    ]);
    expect(contexts.map((c) => c.priority)).toEqual(["urgent", "urgent"]);
  });

  it("keeps the indexer's synthetic keys for events without a transaction verbatim", async () => {
    const block = "height-50-kind-block-event-4";
    const archived = "height-49-kind-tx-idx-2-event-0";
    const { client } = recording([
      {
        account_events: [
          eventRow({
            event_id: 21,
            tx_hash: block,
            event_index: 4,
            event_type: "funding_settled",
            payload: { market: "2", payment: "-1500" },
          }),
          eventRow({
            event_id: 20,
            block_height: 49,
            block_time: "2026-11-05T09:59:59Z",
            tx_hash: archived,
            event_index: 0,
            event_type: "funding_settled",
            payload: { market: "2", payment: "250" },
          }),
        ],
        next_cursor: "",
      },
    ]);
    const page = await client.queryHistoryAccountEventsPage(undefined, {
      order: "desc",
      eventType: "funding_settled",
    });
    expect(page).toEqual({
      events: [
        {
          eventId: 21n,
          owner: self,
          blockHeight: 50n,
          blockTime: "2026-11-05T10:00:00Z",
          txHash: block,
          eventIndex: 4,
          eventType: "funding_settled",
          payload: { market: "2", payment: "-1500" },
        },
        expect.objectContaining({ eventId: 20n, txHash: archived }),
      ],
      nextCursor: "",
    });
  });

  it.each([
    [
      "a limit above 5000",
      { order: "asc", limit: 5001 },
      "account events.limit",
    ],
    [
      "a reversed window",
      { order: "asc", fromMs: 2, toMs: 1 },
      "account events.window",
    ],
    ["an unknown order", { order: "newest" }, "account events.order"],
    [
      "a capitalised event type",
      { order: "asc", eventType: "Funding" },
      "account events.event type",
    ],
    ["a zero timeout", { order: "asc", timeoutMs: 0 }, "timeout"],
  ])(
    "refuses %s as configuration before sending",
    async (_label, opts, field) => {
      const { client, urls } = recording([]);
      await rejectsWith(
        client.queryHistoryAccountEventsPage(
          undefined,
          opts as unknown as AccountEventsOptions,
        ),
        "configuration",
        field,
      );
      expect(urls).toEqual([]);
    },
  );

  it("times out a hanging read at the deadline", async () => {
    const transport: ExchangeHttpTransport = (_url, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        ),
      );
    const client = new ExchangeClient({
      gatewayUrl: "http://gw",
      httpTransport: transport,
    });
    await rejectsWith(
      client.queryHistoryAccountEventsPage(maker, {
        order: "asc",
        timeoutMs: 20,
      }),
      "deadline",
      "timeout",
    );
  });

  it("stops when the caller aborts", async () => {
    const { client, urls } = recording([]);
    const controller = new AbortController();
    controller.abort(new Error("caller stopped"));
    await expect(
      client.queryHistoryAccountEventsPage(maker, {
        order: "asc",
        signal: controller.signal,
      }),
    ).rejects.toThrow("caller stopped");
    expect(urls).toEqual([]);
  });

  it("reports a body that is not JSON as malformed", async () => {
    const { client } = recording(["<html>bad gateway</html>"]);
    await rejectsWith(
      client.queryHistoryAccountEventsPage(maker, { order: "asc" }),
      "malformed",
      "json",
    );
  });

  it("reads a page larger than the 1 MiB default and refuses one above 16 MiB", async () => {
    const payload = { blob: "x".repeat(700) };
    const rows = Array.from({ length: 2000 }, (_, i) =>
      eventRow({ event_id: i + 1, payload }),
    );
    const big = recording([{ account_events: rows, next_cursor: "" }]);
    const page = await big.client.queryHistoryAccountEventsPage(undefined, {
      order: "asc",
      limit: 5000,
    });
    expect(page.events).toHaveLength(2000);

    const transport: ExchangeHttpTransport = async () =>
      new Response("{}", {
        status: 200,
        headers: { "Content-Length": String(16 * 1024 * 1024 + 1) },
      });
    const client = new ExchangeClient({
      gatewayUrl: "http://gw",
      httpTransport: transport,
    });
    await rejectsWith(
      client.queryHistoryAccountEventsPage(maker, { order: "asc" }),
      "limit",
      "responseBytes",
    );
  });

  it("sends a millisecond window and checks rows against it", async () => {
    const { client, urls } = recording([
      { account_events: [eventRow({ owner: maker })], next_cursor: "" },
    ]);
    await rejectsWith(
      client.queryHistoryAccountEventsPage(maker, {
        order: "desc",
        fromMs: 1_762_300_000_000,
        toMs: 1_762_300_000_001,
      }),
      "malformed",
      "account events.row outside window",
    );
    expect(urls).toEqual([
      `http://gw/v1/history/account-events?owner=${maker}&order=desc&limit=500&from=1762300000000&to=1762300000001`,
    ]);
  });

  it.each([
    [
      "a string event id",
      { event_id: "10" },
      "malformed",
      "account events.event id",
    ],
    [
      "a null payload",
      { payload: null },
      "malformed",
      "account events.payload",
    ],
    [
      "another event type",
      { event_type: "deposited" },
      "binding",
      "account events.event type mismatch",
    ],
    [
      "a short tx hash",
      { tx_hash: "abcd" },
      "malformed",
      "account events.tx hash",
    ],
    [
      "an empty tx hash",
      { tx_hash: "" },
      "malformed",
      "account events.tx hash",
    ],
    [
      "an uppercased synthetic key",
      { tx_hash: "HEIGHT-50-KIND-BLOCK-EVENT-3" },
      "malformed",
      "account events.tx hash",
    ],
    [
      "an unknown synthetic kind",
      { tx_hash: "height-50-kind-begin-event-3" },
      "malformed",
      "account events.tx hash",
    ],
    [
      "another owner",
      { owner: maker },
      "binding",
      "account events.owner mismatch",
    ],
  ] as const)("rejects a row with %s", async (_label, over, kind, field) => {
    const { client } = recording([
      { account_events: [eventRow(over)], next_cursor: "" },
    ]);
    await rejectsWith(
      client.queryHistoryAccountEventsPage(undefined, {
        order: "asc",
        eventType: "binary_issued_from_mtm",
      }),
      kind,
      field,
    );
  });

  it("rejects rows out of the requested order", async () => {
    const { client } = recording([
      {
        account_events: [eventRow({ event_id: 11 }), eventRow()],
        next_cursor: "",
      },
    ]);
    await rejectsWith(
      client.queryHistoryAccountEventsPage(undefined, { order: "asc" }),
      "malformed",
      "account events.duplicate or unordered event",
    );
  });

  it("surfaces an HTTP error instead of decoding it", async () => {
    const transport: ExchangeHttpTransport = async () =>
      new Response(JSON.stringify({ error: "order_required" }), {
        status: 400,
      });
    const client = new ExchangeClient({
      gatewayUrl: "http://gw",
      httpTransport: transport,
    });
    await expect(
      client.queryHistoryAccountEventsPage(maker, { order: "asc" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("returns an empty last page without an owner, sending nothing", async () => {
    const { client, urls } = recording([], false);
    expect(
      await client.queryHistoryAccountEventsPage(undefined, { order: "asc" }),
    ).toEqual({ events: [], nextCursor: "" });
    expect(await client.queryHistoryFundingPayments()).toEqual({
      payments: [],
      nextCursor: "",
    });
    expect(urls).toEqual([]);
  });
});
