// Decoded reads a market maker previously hand-parsed: the node's recent trade
// tape, an owner's funding payments, and an owner's account events. Each is
// checked for its URL, transport priority, a well-formed decode and the
// rejection of a malformed row.
import { describe, expect, it } from "vitest";
import {
  ExchangeClient,
  GatewayReadError,
  Side,
  getPublicKey,
  ownerToHex,
  pubkeyToOwner,
  type ExchangeHttpRequestContext,
  type ExchangeHttpTransport,
} from "./index.js";

const key = new Uint8Array(32).fill(9);
const self = ownerToHex(pubkeyToOwner(getPublicKey(key)));
const maker = "aa".repeat(20);
const taker = "bb".repeat(20);

function recording(bodies: unknown[]) {
  const urls: string[] = [];
  const contexts: ExchangeHttpRequestContext[] = [];
  const transport: ExchangeHttpTransport = async (url, _init, context) => {
    urls.push(url);
    contexts.push(context);
    if (!bodies.length) throw new Error("unexpected request");
    return new Response(JSON.stringify(bodies.shift()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const client = new ExchangeClient({
    gatewayUrl: "http://gw",
    apiUrl: "http://api",
    rpcUrl: "http://rpc",
    httpTransport: transport,
  });
  client.setPrivateKey(key);
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

  it("refuses a limit outside 1-500 before sending", async () => {
    const { client, urls } = recording([]);
    await expect(client.queryRecentTrades(3, { limit: 501 })).rejects.toThrow(
      GatewayReadError,
    );
    expect(urls).toEqual([]);
  });

  it.each([
    ["an empty price", { price: "" }],
    ["a decimal quantity", { quantity: "1.5" }],
    ["another market", { market: "4" }],
    ["an unknown side", { maker_side: "Bid" }],
    ["a prefixed owner", { maker_owner: `0x${maker}` }],
    ["a numeric fee", { taker_fee: 1200 }],
  ])("rejects a row with %s", async (_label, over) => {
    const { client } = recording([{ trades: [tradeRow(over)] }]);
    await expect(client.queryRecentTrades(3)).rejects.toThrow(GatewayReadError);
  });

  it("rejects a bare array and an oldest-first tape", async () => {
    const bare = recording([[tradeRow()]]);
    await expect(bare.client.queryRecentTrades(3)).rejects.toThrow(
      GatewayReadError,
    );
    const unordered = recording([
      { trades: [tradeRow({ block_height: 1 }), tradeRow({ fill_id: "43" })] },
    ]);
    await expect(unordered.client.queryRecentTrades(3)).rejects.toThrow(
      GatewayReadError,
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
    expect(page).toEqual({ payments: [] });
  });

  it.each([
    ["a numeric payment", { payment: -1500 }],
    ["a null payment", { payment: null }],
    ["a null market", { market: null }],
    ["a string market", { market: "2" }],
    ["another owner", { owner: maker }],
    ["an epoch-millisecond time", { block_time: 1_762_300_000_000 }],
  ])("rejects a row with %s", async (_label, over) => {
    const { client } = recording([
      { funding_payments: [paymentRow(over)], next_cursor: "" },
    ]);
    await expect(client.queryHistoryFundingPayments()).rejects.toThrow(
      GatewayReadError,
    );
  });

  it("rejects the retired bare-array shape and a short page with a cursor", async () => {
    const bare = recording([[paymentRow()]]);
    await expect(bare.client.queryHistoryFundingPayments()).rejects.toThrow(
      GatewayReadError,
    );
    const short = recording([
      { funding_payments: [paymentRow()], next_cursor: "more" },
    ]);
    await expect(short.client.queryHistoryFundingPayments()).rejects.toThrow(
      GatewayReadError,
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
          eventRow({ event_id: 11, tx_hash: "", tx_position: 1 }),
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
        expect.objectContaining({ eventId: 11n, txHash: "", txPosition: 1 }),
      ],
      nextCursor: "page-2",
    });
    const second = await client.queryHistoryAccountEventsPage(undefined, {
      ...opts,
      cursor: first.nextCursor,
    });
    expect(second.nextCursor).toBeUndefined();
    expect(second.events.map((e) => e.eventId)).toEqual([12n]);
    expect(urls).toEqual([
      `http://gw/v1/history/account-events?owner=${self}&order=asc&event_type=binary_issued_from_mtm&limit=2`,
      `http://gw/v1/history/account-events?owner=${self}&order=asc&event_type=binary_issued_from_mtm&limit=2&cursor=page-2`,
    ]);
    expect(contexts.map((c) => c.priority)).toEqual(["urgent", "urgent"]);
  });

  it("sends a millisecond window and checks rows against it", async () => {
    const { client, urls } = recording([
      { account_events: [eventRow()], next_cursor: "" },
    ]);
    await expect(
      client.queryHistoryAccountEventsPage(maker, {
        order: "desc",
        fromMs: 1_762_300_000_000,
        toMs: 1_762_300_000_001,
      }),
    ).rejects.toThrow(GatewayReadError);
    expect(urls).toEqual([
      `http://gw/v1/history/account-events?owner=${maker}&order=desc&limit=500&from=1762300000000&to=1762300000001`,
    ]);
  });

  it.each([
    ["a string event id", { event_id: "10" }],
    ["a null payload", { payload: null }],
    ["another event type", { event_type: "deposited" }],
    ["a short tx hash", { tx_hash: "abcd" }],
    ["another owner", { owner: maker }],
  ])("rejects a row with %s", async (_label, over) => {
    const { client } = recording([
      { account_events: [eventRow(over)], next_cursor: "" },
    ]);
    await expect(
      client.queryHistoryAccountEventsPage(undefined, {
        order: "asc",
        eventType: "binary_issued_from_mtm",
      }),
    ).rejects.toThrow(GatewayReadError);
  });

  it("rejects rows out of the requested order", async () => {
    const { client } = recording([
      {
        account_events: [eventRow({ event_id: 11 }), eventRow()],
        next_cursor: "",
      },
    ]);
    await expect(
      client.queryHistoryAccountEventsPage(undefined, { order: "asc" }),
    ).rejects.toThrow(GatewayReadError);
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

  it("returns an empty page without an owner", async () => {
    const { contexts } = recording([]);
    const client = new ExchangeClient({ gatewayUrl: "http://gw" });
    expect(
      await client.queryHistoryAccountEventsPage(undefined, { order: "asc" }),
    ).toEqual({ events: [] });
    expect(contexts).toEqual([]);
  });
});
