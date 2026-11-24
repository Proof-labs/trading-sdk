import { encode } from "@msgpack/msgpack";
import { afterEach, describe, expect, it, vi } from "vitest";

import { surfaceFor } from "./http-transport.js";
import {
  ExchangeClient,
  Side,
  exchangeHttpPriorityForAction,
  fetchChainId,
  getPublicKey,
  pubkeyToOwner,
  sign,
  type Action,
  type ExchangeHttpRequestContext,
} from "./index.js";

const key = new Uint8Array(32).fill(13);
const publicKey = getPublicKey(key);
const owner = pubkeyToOwner(publicKey);
const ownerHex = "0d".repeat(20);

const place: Action = {
  type: "PlaceOrder",
  data: {
    owner,
    market: 3,
    side: Side.Buy,
    price: 78_451_952n,
    quantity: 400n,
  },
};
const cancel: Action = { type: "CancelOrder", data: { orderId: 7n, owner } };

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const packed = (value: unknown) =>
  json({ data: Buffer.from(encode(value)).toString("base64") });

type Call = {
  url: string;
  init: RequestInit | undefined;
  context: ExchangeHttpRequestContext;
};

/** A transport that records every request and answers from `respond`. */
function recording(
  respond: (url: string, init: RequestInit | undefined) => Response,
) {
  const calls: Call[] = [];
  const transport = vi.fn(
    async (
      url: string,
      init: RequestInit | undefined,
      context: ExchangeHttpRequestContext,
    ) => {
      calls.push({ url, init, context });
      return respond(url, init);
    },
  );
  return { calls, transport };
}

/** Any request that escapes the transport fails the test. */
function forbidGlobalFetch() {
  const global = vi.fn(async () => {
    throw new Error("global fetch called");
  });
  vi.stubGlobal("fetch", global);
  return global;
}

function signingClient(transport: ReturnType<typeof recording>["transport"]) {
  const client = new ExchangeClient({
    gatewayUrl: "http://gateway",
    chainId: "exchange-devnet-1",
    httpTransport: transport,
  });
  client.setExternalSigner({
    publicKey,
    signRaw: async (msg) => sign(key, msg),
  });
  client.setUnsafeFastSubmit(true);
  return client;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("surfaceFor", () => {
  it.each([
    ["http://gateway/v1/orderbook/7", "api_orderbook"],
    [
      `http://gateway/v1/history/fills/${ownerHex}?limit=5`,
      "api_history_fills",
    ],
    [
      `http://gateway/v1/account/0x${ownerHex}/recent-nonces`,
      "api_account_recent_nonces",
    ],
    [`http://gateway/v1/tx/${"ab".repeat(32)}`, "api_tx"],
    ["http://gateway/v1/markets-snapshot", "api_markets_snapshot"],
    ["http://gateway/info", "api_info"],
    ["/v1/health", "api_health"],
  ])("%s -> %s", (url, surface) => {
    expect(surfaceFor(url)).toBe(surface);
  });
});

describe("exchangeHttpPriorityForAction", () => {
  it("makes cancels urgent and everything else critical", () => {
    expect(exchangeHttpPriorityForAction(cancel)).toBe("urgent");
    expect(
      exchangeHttpPriorityForAction({
        type: "CancelAllOrders",
        data: { owner },
      }),
    ).toBe("urgent");
    expect(exchangeHttpPriorityForAction(place)).toBe("critical");
  });
});

describe("ExchangeClient httpTransport", () => {
  it("sends public reads through the transport as critical queries", async () => {
    const global = forbidGlobalFetch();
    const { calls, transport } = recording((url) =>
      url.endsWith("/v1/health")
        ? json({ status: "ok", height: 9 })
        : packed(url.includes("orderbook") ? [[], []] : []),
    );
    const client = new ExchangeClient({
      gatewayUrl: "http://gateway",
      httpTransport: transport,
    });

    expect(await client.queryMarkets()).toEqual([]);
    expect(await client.queryOrderbook(7)).toEqual({ bids: [], asks: [] });
    expect(await client.queryHealth()).toEqual({ status: "ok", height: 9 });

    expect(calls.map((c) => [c.url, c.context])).toEqual([
      [
        "http://gateway/v1/markets",
        { purpose: "query", priority: "critical", surface: "api_markets" },
      ],
      [
        "http://gateway/v1/orderbook/7",
        { purpose: "query", priority: "critical", surface: "api_orderbook" },
      ],
      [
        "http://gateway/v1/health",
        { purpose: "query", priority: "critical", surface: "api_health" },
      ],
    ]);
    expect(global).not.toHaveBeenCalled();
  });

  it("sends owner-scoped reads as urgent account requests", async () => {
    const global = forbidGlobalFetch();
    const { calls, transport } = recording(() => packed([]));
    const client = new ExchangeClient({
      gatewayUrl: "http://gateway",
      httpTransport: transport,
    });

    expect(await client.queryOpenOrders(ownerHex)).toEqual([]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://gateway/info");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      type: "openOrders",
      user: ownerHex,
    });
    expect(calls[0].context).toEqual({
      purpose: "account",
      priority: "urgent",
      surface: "api_info_openOrders",
    });
    expect(global).not.toHaveBeenCalled();
  });

  it("uses the client's transport for reads(), keeping owner-scoped reads urgent", async () => {
    const global = forbidGlobalFetch();
    const { calls, transport } = recording(() => json({ ok: true }));
    const client = new ExchangeClient({
      gatewayUrl: "http://gateway",
      httpTransport: transport,
    });
    const reads = client.reads();

    await reads.meta();
    await reads.openOrders(ownerHex);
    await reads.clearinghouseState(ownerHex);
    await reads.historyFills({ user: ownerHex });
    await reads.accountEvents({ owner: ownerHex, order: "desc" });
    await reads.health();

    expect(calls.map((c) => c.context)).toEqual([
      { purpose: "query", priority: "critical", surface: "api_info_meta" },
      {
        purpose: "account",
        priority: "urgent",
        surface: "api_info_openOrders",
      },
      {
        purpose: "account",
        priority: "urgent",
        surface: "api_info_clearinghouseState",
      },
      {
        purpose: "account",
        priority: "urgent",
        surface: "api_info_historyFills",
      },
      {
        purpose: "account",
        priority: "urgent",
        surface: "api_history_account_events",
      },
      { purpose: "query", priority: "critical", surface: "api_health" },
    ]);
    expect(global).not.toHaveBeenCalled();
  });

  it.each([
    ["a cancel", cancel, "urgent"],
    ["a placement", place, "critical"],
  ] as const)(
    "submits %s and polls its confirmation at the action's priority",
    async (_label, action, priority) => {
      const global = forbidGlobalFetch();
      const { calls, transport } = recording((url) =>
        url.endsWith("/exchange")
          ? json({ status: "ok" })
          : json({
              result: {
                height: "43",
                tx_result: { code: 0, log: "", info: "" },
              },
            }),
      );
      const client = signingClient(transport);

      const result = await client.submitTxCommit(action);

      expect(result).toMatchObject({ code: 0, outcome: "ok" });
      expect(calls[0].url).toBe("http://gateway/exchange");
      expect(calls[0].context).toEqual({
        purpose: "submit",
        priority,
        surface: "gateway_exchange",
        action,
      });
      const polls = calls.slice(1);
      expect(polls.length).toBeGreaterThan(0);
      for (const poll of polls) {
        expect(poll.url).toBe(`http://gateway/v1/tx/${result.hash}`);
        expect(poll.context).toEqual({
          purpose: "confirmation",
          priority,
          surface: "api_tx",
          action,
        });
      }
      expect(global).not.toHaveBeenCalled();
    },
  );

  it("submits externally signed bytes as critical, with no action", async () => {
    forbidGlobalFetch();
    const { calls, transport } = recording(() =>
      json({ status: "ok", code: 0, txHash: undefined }),
    );
    const client = signingClient(transport);
    const bytes = await client.signTx(place);

    await client.submitSignedTx(bytes);

    expect(calls[0].context).toEqual({
      purpose: "submit",
      priority: "critical",
      surface: "gateway_exchange",
      action: undefined,
    });
  });

  it("resolves the chain id through the transport", async () => {
    const global = forbidGlobalFetch();
    const { calls, transport } = recording(() =>
      json({ result: { node_info: { network: "exchange-devnet-1" } } }),
    );

    const fromHelper = await fetchChainId("http://gateway/v1", transport);
    const client = new ExchangeClient({
      gatewayUrl: "http://gateway",
      httpTransport: transport,
    });
    await client.ready();

    expect(client.getChainId()).toEqual(fromHelper);
    expect(calls.map((c) => c.context)).toEqual([
      { purpose: "chain_id", priority: "critical", surface: "status_chain_id" },
      { purpose: "chain_id", priority: "critical", surface: "status_chain_id" },
    ]);
    expect(global).not.toHaveBeenCalled();
  });
});
