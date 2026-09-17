import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExchangeClient,
  GatewayFeed,
  getPublicKey,
  sign,
  verify,
  hexToBytes,
  chainIdFromString,
  type WebSocketLike,
} from "./index.js";
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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
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
