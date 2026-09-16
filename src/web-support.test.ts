import { afterEach, describe, expect, it, vi } from "vitest";
import { Encoder } from "@msgpack/msgpack";
import {
  ExchangeClient,
  GatewayReads,
  GatewayHttpError,
  Side,
  sign,
  getPublicKey,
  pubkeyToOwner,
  signAndEncode,
  decodeTx,
  type Action,
} from "./index.js";

const key = new Uint8Array(32).fill(13);
const publicKey = getPublicKey(key);
const owner = "03".repeat(20);
const action: Action = {
  type: "PlaceOrder",
  data: {
    owner: pubkeyToOwner(publicKey),
    market: 3,
    side: Side.Buy,
    price: 78_451_952n,
    quantity: 400n,
  },
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
function external() {
  const client = new ExchangeClient({
    gatewayUrl: "",
    chainId: "exchange-devnet-1",
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
  vi.useRealTimers();
});

describe("external async signer", () => {
  it("matches loaded-key bytes for fixed chain/action/nonce and reserves concurrent nonces", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_754_000_000_000);
    const client = external();
    const [a, b] = await Promise.all([
      client.signTx(action),
      client.signTx(action),
    ]);
    expect(a).toEqual(
      signAndEncode(client.getChainId()!, action, 1_754_000_000_000n, key),
    );
    expect(decodeTx(b).seq).toBe(1_754_000_000_001n);
    expect(client.currentNonce).toBe(1_754_000_000_001n);
    expect(client.getPrivateKey()).toBeNull();
    client.setPrivateKey(key);
    expect(await client.signTx(action)).toEqual(
      signAndEncode(client.getChainId()!, action, 1_754_000_000_002n, key),
    );
  });
  it("does not broadcast rejected or invalid signatures", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = external();
    client.setExternalSigner({
      publicKey,
      signRaw: async () => {
        throw new Error("wallet denied");
      },
    });
    await expect(client.submitTx(action)).rejects.toThrow("wallet denied");
    client.setExternalSigner({
      publicKey,
      signRaw: async () => new Uint8Array(64),
    });
    await expect(client.submitTxCommit(action)).rejects.toThrow(
      "invalid signature",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("snapshots input and rejects connection replacement during wallet prompt", async () => {
    const client = external();
    let release!: (signature: Uint8Array) => void;
    let message!: Uint8Array;
    client.setExternalSigner({
      publicKey,
      signRaw: (msg) => {
        message = msg;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const mutable = structuredClone(action);
    const pending = client.signTx(mutable);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    mutable.data.market = 10;
    release(sign(key, message));
    expect(decodeTx(await pending).payload).toEqual(
      decodeTx(
        signAndEncode(client.getChainId()!, action, client.currentNonce, key),
      ).payload,
    );
    const replaced = client.signTx(action);
    const check = expect(replaced).rejects.toThrow(
      "Signing connection changed",
    );
    client.setPrivateKey(key);
    await check;
  });
  it("honors cancellation after wallet prompt without reusing nonce", async () => {
    const client = external();
    const controller = new AbortController();
    client.setExternalSigner({
      publicKey,
      signRaw: async (msg) => {
        controller.abort();
        return sign(key, msg);
      },
    });
    await expect(
      client.signTx(action, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(client.currentNonce).toBeGreaterThan(0n);
  });
  it("observes a future nonce without importing a sequential floor", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_754_000_000_000);
    const fetch = vi.fn().mockResolvedValue(
      json({
        data: Buffer.from(
          new Encoder({ useBigInt64: true }).encode(1_754_000_000_100n),
        ).toString("base64"),
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const client = external();
    await client.syncNonce();
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      type: "nonce",
      user: client.getAddressHex(),
    });
    expect(decodeTx(await client.signTx(action)).seq).toBe(1_754_000_000_000n);
  });
});

describe("gateway finality", () => {
  it.each([401, 413, 429])("keeps HTTP %i terminal", async (status) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(json({ error: "rejected" }, status));
    vi.stubGlobal("fetch", fetch);
    const client = external();
    const result = await client.submitTx(action);
    expect(result.outcome).toBe("transport");
    expect(await client.waitForDelivery(result)).toBe(result);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["network", "5xx", "malformed"])(
    "reconciles %s ambiguity by hash without retrying submission",
    async (kind) => {
      const fetch = vi
        .fn()
        .mockImplementationOnce(() =>
          kind === "network"
            ? Promise.reject(new Error("offline"))
            : Promise.resolve(
                kind === "5xx" ? json({}, 502) : new Response("oops"),
              ),
        )
        .mockResolvedValue(
          json({
            result: { height: "44", tx_result: { code: 0, events: [] } },
          }),
        );
      vi.stubGlobal("fetch", fetch);
      const client = external();
      const admitted = await client.submitTx(action);
      expect(admitted.outcome).toBe("timeout");
      expect(admitted.hash).toMatch(/^[0-9A-F]{64}$/);
      const delivered = await client.waitForDelivery(admitted, {
        timeoutMs: 20000,
      });
      expect(delivered).toMatchObject({
        outcome: "ok",
        height: 44,
        hash: admitted.hash,
      });
      expect(
        fetch.mock.calls.filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(1);
      expect(fetch.mock.calls[1][0]).toBe(`/v1/tx/${admitted.hash}`);
    },
  );
  it("keeps concurrent hash results separate and cancellation unknown", async () => {
    const fetch = vi.fn(async (url: string) =>
      json({
        result: {
          height: "45",
          tx_result: { code: url.endsWith("A") ? 0 : 12 },
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const client = external();
    const base = {
      ok: false,
      outcome: "timeout" as const,
      code: -1,
      error: null,
    };
    const [a, b] = await Promise.all(
      ["A", "B"].map((hash) =>
        client.waitForDelivery({ ...base, hash }, { timeoutMs: 1000 }),
      ),
    );
    expect(a.outcome).toBe("ok");
    expect(b.outcome).toBe("engine");
    const signal = AbortSignal.abort();
    expect(
      await client.waitForDelivery({ ...base, hash: "C" }, { signal }),
    ).toMatchObject({ outcome: "timeout", hash: "C" });
    expect(
      await client.waitForDelivery({ ...base, hash: "D" }, { timeoutMs: 0 }),
    ).toMatchObject({ outcome: "timeout", hash: "D" });
  });
});

describe("named gateway reads", () => {
  it("preserves exact info bodies, same-origin, envelopes, caller transport and cancellation", async () => {
    const fetch = vi.fn(async () => json({ data: "raw-tuple-envelope" }));
    const reads = new GatewayReads({ gatewayUrl: "", fetch });
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
      ["nonce", () => reads.nonce(owner, { signal }), { user: owner }],
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
    const reads = new GatewayReads({
      gatewayUrl: "https://gateway.example/",
      fetch,
    });
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
    await reads.oracleHealth();
    expect(
      fetch.mock.calls.slice(2).map((call) => (call as unknown as [string])[0]),
    ).toEqual([
      "https://gateway.example/v1/ticker/2",
      "https://gateway.example/v1/health",
      "https://gateway.example/v1/oracle/health",
    ]);
  });
  it("keeps HTTP status errors and pre-aborted requests do not fetch", async () => {
    const fetch = vi.fn(async () => json({}, 429));
    const reads = new GatewayReads({ fetch });
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

describe("optional DeliverTx info", () => {
  it.each([0, 12])(
    "preserves inline info without changing verdict code %i",
    async (code) => {
      const fetch = vi.fn().mockResolvedValue(
        json({
          code,
          height: 42,
          log: "authoritative log",
          info: "diagnostic only",
          events: [],
        }),
      );
      vi.stubGlobal("fetch", fetch);
      const client = external();
      const result = await client.submitTxCommit(action);
      expect(result).toMatchObject({
        code,
        height: 42,
        log: "authoritative log",
        info: "diagnostic only",
        outcome: code === 0 ? "ok" : "engine",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each([0, 12])(
    "preserves per-hash polling info for code %i",
    async (code) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(json({ status: "ok" }))
        .mockResolvedValue(
          json({
            result: {
              height: "43",
              tx_result: { code, log: "log", info: "poll info" },
            },
          }),
        );
      vi.stubGlobal("fetch", fetch);
      const client = external();
      const admitted = await client.submitTx(action);
      expect(admitted.info).toBeUndefined();
      expect(await client.waitForDelivery(admitted)).toMatchObject({
        code,
        hash: admitted.hash,
        info: "poll info",
      });
    },
  );
  it("preserves empty info in the background verifier", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ status: "ok" }))
      .mockResolvedValue(
        json({
          result: {
            height: "44",
            tx_result: { code: 12, log: "rejected", info: "" },
          },
        }),
      );
    vi.stubGlobal("fetch", fetch);
    const client = external();
    client.setUnsafeFastSubmit(false);
    const admitted = await client.submitTx(action);
    expect(await client.awaitPendingVerifies()).toEqual([
      expect.objectContaining({ code: 12, hash: admitted.hash, info: "" }),
    ]);
  });
});
