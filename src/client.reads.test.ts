import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Encoder } from "@msgpack/msgpack";
import { ExchangeClient } from "./client.js";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

/**
 * Read/query endpoints must honour the gateway-only network policy: under
 * the default `useGateway: true`, every `/v1/*` read goes through
 * `gatewayUrl`, never the bare `apiUrl`. The `useGateway: false` internal
 * path keeps hitting the Go API server directly (scenario harness, in-cluster
 * tools).
 */
describe("ExchangeClient read routing", () => {
  const originalFetch = globalThis.fetch;
  let calls: string[] = [];

  beforeEach(() => {
    calls = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(url.toString());
      return new Response(JSON.stringify({ status: "ok", height: 1 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("default (useGateway) routes reads through gatewayUrl, not apiUrl", async () => {
    const client = new ExchangeClient({
      apiUrl: "http://test-api",
      gatewayUrl: "http://test-gateway",
      chainId: "test-chain",
    });
    await client.queryHealth();
    expect(calls).toEqual(["http://test-gateway/v1/health"]);
  });

  it("useGateway:false routes reads to the direct apiUrl", async () => {
    const client = new ExchangeClient({
      apiUrl: "http://test-api",
      gatewayUrl: "http://test-gateway",
      useGateway: false,
      chainId: "test-chain",
    });
    await client.queryHealth();
    expect(calls).toEqual(["http://test-api/v1/health"]);
  });
});

/**
 * Owner-scoped reads (account, open orders, withdrawal) are not exposed as
 * GETs on the gateway — it 404s them and requires `POST /info`. The SDK must
 * POST the structured `/info` request on the gateway path, and only fall back
 * to a direct GET on the internal `useGateway: false` path.
 */
describe("ExchangeClient owner-scoped reads via /info", () => {
  const originalFetch = globalThis.fetch;
  let calls: FetchCall[] = [];
  const accountEncoder = new Encoder({ useBigInt64: true });

  function b64(bytes: Uint8Array): string {
    let s = "";
    for (const byte of bytes) s += String.fromCharCode(byte);
    return btoa(s);
  }

  beforeEach(() => {
    calls = [];
    globalThis.fetch = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: url.toString(), init });
        // Shape the msgpack blob to the request: account is a positional
        // tuple, open orders / withdrawal decode from a list.
        const type = init?.body
          ? (JSON.parse(init.body as string) as { type?: string }).type
          : undefined;
        const isAccount =
          type === "clearinghouseState" ||
          url.toString().includes("/v1/account/");
        const payload = isAccount
          ? // balance, positions[], equity, totalMm, totalIm, marginRatioBps
            [1_000n, [], 0n, 0n, 0n, 0n]
          : []; // empty open-orders list
        const blob = b64(accountEncoder.encode(payload) as Uint8Array);
        return new Response(JSON.stringify({ data: blob }), { status: 200 });
      },
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("default (useGateway) POSTs /info clearinghouseState instead of GET /v1/account", async () => {
    const client = new ExchangeClient({
      gatewayUrl: "http://test-gateway",
      apiUrl: "http://test-api",
      chainId: "test-chain",
    });
    const acct = await client.queryAccount("a".repeat(40));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://test-gateway/info");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      type: "clearinghouseState",
      user: "a".repeat(40),
    });
    expect(acct?.balance).toBe(1_000n);
  });

  it("default (useGateway) POSTs /info openOrders", async () => {
    const client = new ExchangeClient({
      gatewayUrl: "http://test-gateway",
      chainId: "test-chain",
    });
    await client.queryOpenOrders("b".repeat(40));
    expect(calls[0].url).toBe("http://test-gateway/info");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      type: "openOrders",
      user: "b".repeat(40),
    });
  });

  it("useGateway:false reads owner-scoped data via the direct node GET", async () => {
    const client = new ExchangeClient({
      gatewayUrl: "http://test-gateway",
      apiUrl: "http://test-api",
      useGateway: false,
      chainId: "test-chain",
    });
    await client.queryAccount("c".repeat(40));
    expect(calls[0].url).toBe(`http://test-api/v1/account/${"c".repeat(40)}`);
    expect(calls[0].init?.method ?? "GET").toBe("GET");
  });
});

/**
 * Restored ticker / ADL-queue reads route through the gateway's /v1/* paths
 * (api-gateway exposes them as public node-REST reads). Ticker returns plain
 * JSON; the ADL queue returns a base64-msgpack `{ data }` envelope.
 */
describe("ExchangeClient ticker + adl-queue routing", () => {
  const originalFetch = globalThis.fetch;
  const encoder = new Encoder({ useBigInt64: true });
  let calls: string[] = [];

  function toB64(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("queryTicker routes through the gateway /v1/ticker and maps fields", async () => {
    calls = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(url.toString());
      return new Response(
        JSON.stringify({
          market: "1",
          last_price: "6675000",
          change_24h_bps: "12",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new ExchangeClient({
      gatewayUrl: "http://test-gateway",
      chainId: "test-chain",
    });
    const t = await client.queryTicker(1);
    expect(calls).toEqual(["http://test-gateway/v1/ticker/1"]);
    expect(t?.lastPrice).toBe("6675000");
    expect(t?.change24hBps).toBe("12");
    expect(t?.openInterest).toBeNull();
  });

  it("queryAdlQueue routes through /v1/adl/queue and coerces a serde-array owner", async () => {
    calls = [];
    // serde encodes `[u8; 20]` as a msgpack ARRAY (number[]), not BIN.
    const ownerArr = Array.from({ length: 20 }, (_, i) => i + 1);
    const tuple = [[ownerArr, 1, "Buy", 100n, 5n, 50n]];
    const data = toB64(encoder.encode(tuple) as Uint8Array);
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(url.toString());
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new ExchangeClient({
      gatewayUrl: "http://test-gateway",
      chainId: "test-chain",
    });
    const queue = await client.queryAdlQueue(1);
    expect(calls).toEqual(["http://test-gateway/v1/adl/queue/1"]);
    expect(queue).toHaveLength(1);
    expect(queue[0].market).toBe(1);
    expect(queue[0].size).toBe(100n);
    expect(queue[0].adlScore).toBe(50n);
    expect(queue[0].owner).toBeInstanceOf(Uint8Array);
    expect(Array.from(queue[0].owner)).toEqual(ownerArr);
  });
});

/**
 * Owner/destination bytes: serde encodes `[u8; N]` as a msgpack ARRAY, so the
 * decoder hands back `number[]` — every decoded byte field must be coerced to
 * `Uint8Array` (the public type), for open orders, account positions, and ADL.
 */
describe("ExchangeClient owner byte-coercion (serde array shape)", () => {
  const originalFetch = globalThis.fetch;
  const encoder = new Encoder({ useBigInt64: true });
  const ownerArr = Array.from({ length: 20 }, (_, i) => i + 1);
  const hex = "ab".repeat(20);

  function toB64(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }
  function infoResponse(payload: unknown): Response {
    return new Response(
      JSON.stringify({ data: toB64(encoder.encode(payload) as Uint8Array) }),
      { status: 200 },
    );
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("queryOpenOrders coerces a number[] owner to Uint8Array", async () => {
    globalThis.fetch = vi.fn(async () =>
      infoResponse([[7n, 1, ownerArr, "Buy", 100n, 10n]]),
    ) as unknown as typeof fetch;
    const client = new ExchangeClient({ gatewayUrl: "http://g", chainId: "c" });
    const orders = await client.queryOpenOrders(hex);
    expect(orders[0].owner).toBeInstanceOf(Uint8Array);
    expect(Array.from(orders[0].owner)).toEqual(ownerArr);
  });

  it("queryAccount coerces a number[] position owner to Uint8Array", async () => {
    const position = [ownerArr, 1, "Buy", 6_675_000n, 100n, 0n];
    globalThis.fetch = vi.fn(async () =>
      infoResponse([1_000n, [position], 0n, 0n, 0n, 0n]),
    ) as unknown as typeof fetch;
    const client = new ExchangeClient({ gatewayUrl: "http://g", chainId: "c" });
    const acct = await client.queryAccount(hex);
    expect(acct?.positions[0].owner).toBeInstanceOf(Uint8Array);
    expect(Array.from(acct!.positions[0].owner)).toEqual(ownerArr);
  });
});

/**
 * queryOracleHealth normalizes the gateway's snake_case /v1/oracle/health into
 * camelCase, tolerates absent fields as null (never throws), and preserves the
 * u64 price_micro at full precision — it is parsed via a bigint-aware reviver,
 * so a value past 2^53 is not rounded to the nearest double.
 */
describe("ExchangeClient queryOracleHealth", () => {
  const originalFetch = globalThis.fetch;
  let calls: string[] = [];

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubJson(body: string): void {
    calls = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(url.toString());
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
  }

  it("routes through /v1/oracle/health and maps snake_case to camelCase", async () => {
    stubJson(
      JSON.stringify({
        status: "ok",
        embedded_feeder: true,
        source: "binance",
        updated_at_unix_ms: 1_700_000_000_000,
        markets: {
          "1": {
            market: 1,
            feed: "BTC",
            source: "binance",
            status: "ok",
            last_update_unix_ms: 1_700_000_000_000,
            stale_seconds: 2,
            source_publish_time_ms: 1_699_999_999_000,
            last_submit_unix_ms: 1_700_000_000_100,
            price_micro: 66_750_000,
            unchanged_reads: 3,
            reason: null,
            tx_hash: "abcd",
          },
        },
      }),
    );
    const client = new ExchangeClient({
      gatewayUrl: "http://test-gateway",
      chainId: "test-chain",
    });
    const snap = await client.queryOracleHealth();
    expect(calls).toEqual(["http://test-gateway/v1/oracle/health"]);
    expect(snap.status).toBe("ok");
    expect(snap.embeddedFeeder).toBe(true);
    expect(snap.source).toBe("binance");
    expect(snap.updatedAtUnixMs).toBe(1_700_000_000_000);
    const m = snap.markets["1"];
    expect(m.market).toBe(1);
    expect(m.feed).toBe("BTC");
    expect(m.status).toBe("ok");
    expect(m.lastUpdateUnixMs).toBe(1_700_000_000_000);
    expect(m.staleSeconds).toBe(2);
    expect(m.sourcePublishTimeMs).toBe(1_699_999_999_000);
    expect(m.priceMicro).toBe(66_750_000n);
    expect(m.unchangedReads).toBe(3);
    expect(m.reason).toBeNull();
    expect(m.txHash).toBe("abcd");
  });

  it("preserves a price_micro past 2^53 as an exact bigint", async () => {
    // 1e18 + 1: unrepresentable as a double, so res.json() would round it.
    const raw = "1000000000000000001";
    stubJson(
      `{"status":"ok","markets":{"7":{"market":7,"price_micro":${raw}}}}`,
    );
    const client = new ExchangeClient({
      gatewayUrl: "http://g",
      chainId: "c",
    });
    const snap = await client.queryOracleHealth();
    expect(snap.markets["7"].priceMicro).toBe(BigInt(raw));
    // Guard the silent-rounding regression this test exists to catch.
    expect(snap.markets["7"].priceMicro).not.toBe(BigInt(Number(raw)));
  });

  it("tolerates a sparse market entry — absent fields decode as null, no throw", async () => {
    stubJson(JSON.stringify({ markets: { "2": { market: 2 } } }));
    const client = new ExchangeClient({
      gatewayUrl: "http://g",
      chainId: "c",
    });
    const snap = await client.queryOracleHealth();
    expect(snap.status).toBe("unknown");
    expect(snap.embeddedFeeder).toBe(false);
    const m = snap.markets["2"];
    expect(m.market).toBe(2);
    expect(m.status).toBe("unknown");
    expect(m.lastUpdateUnixMs).toBeNull();
    expect(m.staleSeconds).toBeNull();
    expect(m.priceMicro).toBeNull();
    expect(m.reason).toBeNull();
    expect(m.txHash).toBeNull();
    expect(m.unchangedReads).toBe(0);
  });

  it("throws a typed API error on a non-2xx response", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("nope", { status: 503 }),
    ) as unknown as typeof fetch;
    const client = new ExchangeClient({
      gatewayUrl: "http://g",
      chainId: "c",
    });
    await expect(client.queryOracleHealth()).rejects.toThrow(
      "API error: HTTP 503",
    );
  });
});

/**
 * decodeMarketConfig slot 24 (max_open_interest, W27-01): present decodes as a
 * bigint through queryMarkets; absent (a shorter, pre-W27-01 tuple) decodes as
 * undefined — the null-tolerance that keeps the read backward-compatible.
 */
describe("ExchangeClient queryMarkets — MarketConfig.maxOpenInterest (slot 24)", () => {
  const originalFetch = globalThis.fetch;
  const encoder = new Encoder({ useBigInt64: true });

  function toB64(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }
  // A MarketConfig tuple. raw[5] (fundingIntervalMs) must be non-null; the rest
  // may be nil. `oi` fills slot 24 — pass null to model a pre-W27-01 market.
  function marketTuple(oi: bigint | null): unknown[] {
    const t: unknown[] = new Array(24).fill(null);
    t[0] = 1; // market id
    t[5] = 3_600_000n; // fundingIntervalMs (BigInt(null) would throw)
    t[23] = "BTC"; // ticker
    if (oi !== null) t[24] = oi;
    return t;
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubMarkets(tuple: unknown[]): void {
    const data = toB64(encoder.encode([tuple]) as Uint8Array);
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ data }), { status: 200 }),
    ) as unknown as typeof fetch;
  }

  it("decodes a present slot 24 as bigint", async () => {
    stubMarkets(marketTuple(10_000_000_000_000_000_000n));
    const client = new ExchangeClient({ gatewayUrl: "http://g", chainId: "c" });
    const [m] = await client.queryMarkets();
    expect(m.ticker).toBe("BTC");
    expect(m.maxOpenInterest).toBe(10_000_000_000_000_000_000n);
  });

  it("decodes an absent slot 24 (pre-W27-01 tuple) as undefined", async () => {
    stubMarkets(marketTuple(null));
    const client = new ExchangeClient({ gatewayUrl: "http://g", chainId: "c" });
    const [m] = await client.queryMarkets();
    expect(m.maxOpenInterest).toBeUndefined();
  });
});
