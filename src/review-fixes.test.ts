import { afterEach, describe, expect, it, vi } from "vitest";
import { Encoder } from "@msgpack/msgpack";
import {
  ExchangeClient,
  GatewayFeed,
  GatewayReads,
  getPublicKey,
  sign,
  verify,
  hexToBytes,
  chainIdFromString,
  decodeTx,
  type Action,
  type WebSocketLike,
} from "./index.js";
import { txFromQueryResponse } from "./tx-result.js";

const seed = new Uint8Array(32).fill(17);
const pub = getPublicKey(seed);
const now = 1_754_000_000_000;
function client(external = true) {
  const c = new ExchangeClient({
    gatewayUrl: "",
    chainId: "exchange-devnet-1",
  });
  if (external)
    c.setExternalSigner({
      publicKey: pub,
      signRaw: async (m) => sign(seed, m),
    });
  else c.setPrivateKey(seed);
  c.setUnsafeFastSubmit(true);
  return c;
}
function action(c: ExchangeClient): Action {
  return {
    type: "CancelAllOrders",
    data: { owner: c.getAddress()!, market: 1 },
  };
}
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const noncePage = (value: bigint) =>
  response({
    data: Buffer.from(
      new Encoder({ useBigInt64: true }).encode(value),
    ).toString("base64"),
  });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("timestamp nonce observation, not sequential sync", () => {
  it.each([0, 100, 60_000, 60_001, 86_400_000])(
    "does not poison signing with retained skew %i ms",
    async (skew) => {
      vi.spyOn(Date, "now").mockReturnValue(now);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => noncePage(BigInt(now + skew))),
      );
      const c = client();
      await c.syncNonce();
      const seqs = await Promise.all(
        Array.from(
          { length: 4 },
          async () => decodeTx(await c.signTx(action(c))).seq,
        ),
      );
      expect(seqs).toEqual(
        Array.from({ length: 4 }, (_, i) =>
          BigInt(now + i + (skew === 0 ? 1 : 0)),
        ),
      );
      await c.syncNonce();
      expect(decodeTx(await c.signTx(action(c))).seq).toBe(seqs[3] + 1n);
    },
  );
  it("skips an observed future value when the local clock reaches it", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => noncePage(BigInt(now + 10))),
    );
    const c = client();
    await c.syncNonce();
    expect(decodeTx(await c.signTx(action(c))).seq).toBe(BigInt(now));
    clock.mockReturnValue(now + 10);
    expect(decodeTx(await c.signTx(action(c))).seq).toBe(BigInt(now + 11));
  });
  it("never repeats the local clamp ceiling and recovers when clock advances", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const c = client();
    // Simulate an actual allocation at now+60s followed by local clock rollback.
    clock.mockReturnValue(now + 60_000);
    expect(decodeTx(await c.signTx(action(c))).seq).toBe(BigInt(now + 60_000));
    clock.mockReturnValue(now);
    await expect(c.signTx(action(c))).rejects.toThrow("clock safety window");
    clock.mockReturnValue(now + 1);
    expect(decodeTx(await c.signTx(action(c))).seq).toBe(BigInt(now + 60_001));
  });
});

describe("CometBFT verdict decoding", () => {
  it.each([
    {},
    { code: 0 },
    { code: "0" },
    { code: "12" },
    { code: 4294967295 },
  ])("accepts documented code shape %j", (exec) => {
    const r = txFromQueryResponse(
      { result: { height: "42", tx_result: { ...exec, info: "diagnostic" } } },
      "HASH",
    );
    expect(r).toMatchObject({
      hash: "HASH",
      height: 42,
      info: "diagnostic",
      code: Number("code" in exec ? exec.code : 0),
    });
  });
  it.each([
    null,
    [],
    "bad",
    false,
    0,
    { code: null },
    { code: true },
    { code: "" },
    { code: "1x" },
    { code: "-1" },
    { code: 1.5 },
    { code: -1 },
    { code: "4294967296" },
    { code: {} },
  ])("rejects unreadable ExecTxResult %j", (exec) => {
    expect(
      txFromQueryResponse({ result: { tx_result: exec } }, "HASH"),
    ).toBeNull();
  });
  it.each([null, [], {}, { result: [] }, { result: {} }, { result: null }])(
    "rejects missing result objects %j",
    (body) => {
      expect(txFromQueryResponse(body, "HASH")).toBeNull();
    },
  );
  it.each([{}, { code: "12" }])(
    "per-hash and background paths agree for %j",
    async (exec) => {
      const fetch = vi.fn().mockImplementation(async (url: string) =>
        url.endsWith("/exchange")
          ? response({ status: "ok" })
          : response({
              result: { height: "42", tx_result: { ...exec, info: "kept" } },
            }),
      );
      vi.stubGlobal("fetch", fetch);
      const c = client();
      const first = await c.submitTx(action(c));
      const direct = await c.waitForDelivery(first);
      c.setUnsafeFastSubmit(false);
      await c.submitTx(action(c));
      const background = await c.awaitPendingVerifies();
      expect(background[0]).toMatchObject({
        code: direct.code,
        outcome: direct.outcome,
        info: "kept",
      });
      expect(
        fetch.mock.calls.filter(([u]) => u.endsWith("/exchange")),
      ).toHaveLength(2);
    },
  );
  it("keeps malformed responses uncertain instead of fabricating success", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ result: { tx_result: [] } })),
    );
    const c = client();
    const result = c.waitForDelivery(
      { ok: false, outcome: "timeout", code: -1, error: null, hash: "X" },
      { timeoutMs: 500 },
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toMatchObject({ outcome: "timeout", hash: "X" });
  });
  it("aborts a polling sleep immediately and supports old AbortSignal runtimes", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "any").mockImplementation(() => {
      throw new Error("not supported");
    });
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      throw new Error("not supported");
    });
    const fetch = vi.fn(async () => response({ result: { tx_result: {} } }));
    vi.stubGlobal("fetch", fetch);
    const c = client();
    const controller = new AbortController();
    const pending = c.waitForDelivery(
      { ok: false, outcome: "timeout", code: -1, error: null, hash: "X" },
      { signal: controller.signal },
    );
    controller.abort();
    expect(await pending).toMatchObject({ outcome: "timeout", hash: "X" });
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const success = c.waitForDelivery(
      { ok: false, outcome: "timeout", code: -1, error: null, hash: "Y" },
      { signal: new AbortController().signal },
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(await success).toMatchObject({ code: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves 5xx diagnostics and the unknown transaction hash", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({ error: "upstream temporarily unavailable" }, 502),
      ),
    );
    const c = client();
    const result = await c.submitTx(action(c));
    expect(result.outcome).toBe("timeout");
    expect(result.log).toContain("upstream temporarily unavailable");
    expect(result.hash).toHaveLength(64);
  });
  it("signs without structuredClone and reads without URLSearchParams.size", async () => {
    vi.stubGlobal("structuredClone", undefined);
    const c = client();
    expect((await c.signTx(action(c))).length).toBeGreaterThan(0);
    vi.spyOn(URLSearchParams.prototype, "size", "get").mockImplementation(
      () => {
        throw new Error("not supported");
      },
    );
    const fetch = vi.fn(async () => response({}));
    await new GatewayReads({ gatewayUrl: "", fetch }).ticker(1);
    expect(fetch.mock.calls[0][0]).toBe("/v1/ticker/1");
  });
});

class Socket implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  sent: string[] = [];
  send(s: string) {
    this.sent.push(s);
  }
  close() {}
  open() {
    this.onopen?.({});
  }
  drop() {
    this.onclose?.({});
  }
}
// Independently assemble the gateway's existing account_ws_auth_message layout.
function authMessage(
  c: ExchangeClient,
  owner: string,
  timestamp: number,
  afterId = 0n,
) {
  const tail = Buffer.alloc(16);
  tail.writeBigInt64BE(afterId);
  tail.writeBigUInt64BE(BigInt(timestamp), 8);
  return Buffer.concat([
    Buffer.from("ProofExchange-account-events-v1"),
    Buffer.from(chainIdFromString("exchange-devnet-1")),
    Buffer.from(owner),
    tail,
  ]);
}
describe("account WS auth without wire changes", () => {
  it("matches existing gateway bytes and private-key/external signing including cursor", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const c = client();
    const owner = c.getAddressHex()!;
    const auth = await c.accountAuth("0x" + owner.toUpperCase(), 7n);
    expect(auth.timestamp_ms).toBe(now);
    expect(auth.after_id).toBe(7);
    expect(
      verify(pub, hexToBytes(auth.signature), authMessage(c, owner, now, 7n)),
    ).toBe(true);
    expect(await client(false).accountAuth(owner, 7n)).toEqual(auth);
    await expect(c.accountAuth("00".repeat(20))).rejects.toThrow("owner");
    await expect(c.accountAuth(owner, 2n ** 60n)).rejects.toThrow("cursor");
  });
  it("renews auth on reconnect and drops pending results after unsubscribe or close", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const c = client();
    const sockets: Socket[] = [];
    const feed = c.feed({
      pingIntervalMs: 0,
      minBackoffMs: 10,
      webSocketFactory: () => {
        const s = new Socket();
        sockets.push(s);
        return s;
      },
    });
    const dispose = c.subscribeAccount(() => {});
    sockets[0].open();
    await vi.advanceTimersByTimeAsync(0);
    const first = JSON.parse(sockets[0].sent[0]).params;
    expect(first.owner).toBe(c.getAddressHex());
    expect(first.timestamp_ms).toBe(now);
    expect(first.after_id).toBeUndefined();
    sockets[0].drop();
    await vi.advanceTimersByTimeAsync(10);
    sockets[1].open();
    await vi.advanceTimersByTimeAsync(0);
    const second = JSON.parse(sockets[1].sent[0]).params;
    expect(second.timestamp_ms).toBe(now + 10);
    expect(second.signature).not.toBe(first.signature);
    expect(
      verify(
        pub,
        hexToBytes(second.signature),
        authMessage(c, second.owner, second.timestamp_ms),
      ),
    ).toBe(true);
    dispose();
    feed.close();
    expect(vi.getTimerCount()).toBe(0);
    let resolve!: (v: typeof first) => void;
    const socket = new Socket();
    const delayed = new GatewayFeed({
      url: "wss://test/ws",
      pingIntervalMs: 0,
      webSocketFactory: () => socket,
      accountAuth: () => new Promise((r) => (resolve = r)),
    });
    const unsub = delayed.subscribeAccount(c.getAddressHex()!, () => {});
    socket.open();
    await vi.advanceTimersByTimeAsync(0);
    unsub();
    resolve(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sent.some((s) => JSON.parse(s).method === "subscribe")).toBe(
      false,
    );
  });
  it("never sends unsigned on auth rejection and cannot sign another owner", async () => {
    vi.useFakeTimers();
    const c = client();
    const socket = new Socket();
    const onError = vi.fn();
    const feed = c.feed({
      pingIntervalMs: 0,
      webSocketFactory: () => socket,
      onError,
    });
    feed.subscribeAccount("00".repeat(20), () => {});
    socket.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sent).toEqual([]);
    expect(onError).toHaveBeenCalledOnce();
    c.disconnect();
  });
  it("rejects signer replacement during pending auth", async () => {
    const c = client();
    let release!: (s: Uint8Array) => void;
    let message!: Uint8Array;
    c.setExternalSigner({
      publicKey: pub,
      signRaw: (m) => {
        message = m;
        return new Promise((r) => (release = r));
      },
    });
    const pending = c.accountAuth();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    c.setPrivateKey(new Uint8Array(32).fill(18));
    release(sign(seed, message));
    await expect(pending).rejects.toThrow("Signing connection changed");
  });
});

it("does not send old-socket auth after reconnect even when signer resolves late", async () => {
  vi.useFakeTimers();
  const sockets: Socket[] = [];
  const releases: Array<
    (auth: {
      public_key: string;
      signature: string;
      timestamp_ms: number;
    }) => void
  > = [];
  const feed = new GatewayFeed({
    url: "wss://test/ws",
    pingIntervalMs: 0,
    minBackoffMs: 10,
    webSocketFactory: () => {
      const s = new Socket();
      sockets.push(s);
      return s;
    },
    accountAuth: () => new Promise((resolve) => releases.push(resolve)),
  });
  feed.subscribeAccount("11".repeat(20), () => {});
  sockets[0].open();
  await vi.advanceTimersByTimeAsync(0);
  sockets[0].drop();
  await vi.advanceTimersByTimeAsync(10);
  sockets[1].open();
  await vi.advanceTimersByTimeAsync(0);
  releases[0]({ public_key: "old", signature: "old", timestamp_ms: 1 });
  await vi.advanceTimersByTimeAsync(0);
  expect(sockets[1].sent).toEqual([]);
  releases[1]({ public_key: "new", signature: "new", timestamp_ms: 2 });
  await vi.advanceTimersByTimeAsync(0);
  expect(JSON.parse(sockets[1].sent[0]).params.signature).toBe("new");
  feed.close();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])(
  "keeps a parsed verdict after deadline but honors caller abort=%s",
  async (cancel) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let finish!: (value: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      })),
    );
    const pending = client().waitForDelivery(
      { ok: false, outcome: "timeout", code: -1, error: null, hash: "RACE" },
      { timeoutMs: 500, signal: controller.signal },
    );
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(301);
    if (cancel) controller.abort();
    finish({ result: { height: "8", tx_result: { info: "parsed" } } });
    expect(await pending).toMatchObject(
      cancel
        ? { outcome: "timeout", hash: "RACE" }
        : { code: 0, height: 8, info: "parsed", hash: "RACE" },
    );
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("authenticates the shared feed created before wallet connection", async () => {
  vi.useFakeTimers();
  const c = new ExchangeClient({
    gatewayUrl: "",
    chainId: "exchange-devnet-1",
  });
  const socket = new Socket();
  const feed = c.feed({ pingIntervalMs: 0, webSocketFactory: () => socket });
  c.subscribeOrderbook(1, () => {});
  socket.open();
  c.setExternalSigner({ publicKey: pub, signRaw: async (m) => sign(seed, m) });
  feed.subscribeAccount(c.getAddressHex()!, () => {});
  await vi.advanceTimersByTimeAsync(0);
  const account = socket.sent
    .map((s) => JSON.parse(s))
    .find((s) => s.params.channel === "accountEvents");
  expect(account.params.public_key).toBe(Buffer.from(pub).toString("hex"));
  expect(account.params.signature).toHaveLength(128);
  c.disconnect();
});

it("allows explicit unsigned watch-only subscriptions with a signer connected", async () => {
  vi.useFakeTimers();
  const c = client();
  const socket = new Socket();
  c.feed({ pingIntervalMs: 0, webSocketFactory: () => socket });
  const owner = "00".repeat(20);
  c.subscribeAccount(() => {}, { owner, auth: false });
  socket.open();
  await vi.advanceTimersByTimeAsync(0);
  expect(JSON.parse(socket.sent[0]).params).toEqual({
    channel: "accountEvents",
    owner,
  });
  const urls: string[] = [];
  vi.stubGlobal(
    "WebSocket",
    class extends Socket {
      constructor(url: string) {
        super();
        urls.push(url);
      }
    },
  );
  c.subscribeAccountEvents(owner, () => {}, { auth: false });
  await vi.advanceTimersByTimeAsync(0);
  expect(urls).toHaveLength(1);
  expect(urls[0]).toContain("owner=" + owner);
  expect(urls[0]).not.toContain("signature");
  c.disconnect();
});
