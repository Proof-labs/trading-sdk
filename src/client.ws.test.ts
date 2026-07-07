import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ExchangeClient } from "./client.js";
import {
  chainIdFromString,
  generateKeypair,
  hexToBytes,
  ownerToHex,
  pubkeyToOwner,
  verify,
} from "./crypto.js";

/**
 * Gateway-native WebSocket streams (mirror the Python SDK): per-stream
 * connections to `/account-events` and `/orderbook-deltas`, with the WS base
 * derived from the gateway URL (scheme swapped). The account stream signs its
 * auth params with the loaded key so it works against an authed gateway.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.closed = true;
  }
}

/** Rebuild the gateway's account-events auth message to validate byte layout. */
function expectedAccountWsAuthMessage(
  chainId: Uint8Array,
  ownerHex: string,
  afterId: bigint,
  timestampMs: bigint,
): Uint8Array {
  const prefix = new TextEncoder().encode("ProofExchange-account-events-v1");
  const owner = new TextEncoder().encode(ownerHex);
  const msg = new Uint8Array(prefix.length + 32 + owner.length + 16);
  let o = 0;
  msg.set(prefix, o);
  o += prefix.length;
  msg.set(chainId, o);
  o += 32;
  msg.set(owner, o);
  o += owner.length;
  const dv = new DataView(msg.buffer);
  dv.setBigInt64(o, afterId, false);
  o += 8;
  dv.setBigUint64(o, timestampMs, false);
  return msg;
}

describe("ExchangeClient WebSocket streams", () => {
  const originalWs = globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWs;
    vi.restoreAllMocks();
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("orderbook-deltas connects to the gateway WS base with scheme swapped", async () => {
    const client = new ExchangeClient({
      gatewayUrl: "http://test-gateway",
      chainId: "test-chain",
    });
    const unsub = client.subscribeOrderbookDeltas(1, () => {});
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toBe(
      "ws://test-gateway/orderbook-deltas?market=1",
    );
    unsub();
    expect(FakeWebSocket.instances[0].closed).toBe(true);
  });

  it("account-events signs auth params that verify against the gateway message", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const client = new ExchangeClient({
      gatewayUrl: "https://api.dev.proof.trade",
      chainId: "test-chain",
    });
    const kp = generateKeypair();
    client.setPrivateKey(kp.privateKey);
    const ownerHex = ownerToHex(pubkeyToOwner(kp.publicKey));

    const unsub = client.subscribeAccountEvents(
      pubkeyToOwner(kp.publicKey),
      () => {},
    );
    await flush();

    const url = new URL(FakeWebSocket.instances[0].url);
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("api.dev.proof.trade");
    expect(url.pathname).toBe("/account-events");
    expect(url.searchParams.get("owner")).toBe(ownerHex);

    const pub = hexToBytes(url.searchParams.get("public_key")!);
    const sig = hexToBytes(url.searchParams.get("signature")!);
    const ts = BigInt(url.searchParams.get("timestamp_ms")!);
    expect(ts).toBe(1_700_000_000_000n);
    const msg = expectedAccountWsAuthMessage(
      chainIdFromString("test-chain"),
      ownerHex,
      0n,
      ts,
    );
    expect(verify(pub, sig, msg)).toBe(true);
    unsub();
  });

  it("disconnect() closes all open streams", async () => {
    const client = new ExchangeClient({
      gatewayUrl: "http://test-gateway",
      chainId: "test-chain",
    });
    client.subscribeOrderbookDeltas(1, () => {});
    client.subscribeOrderbookDeltas(2, () => {});
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(2);
    client.disconnect();
    expect(FakeWebSocket.instances.every((w) => w.closed)).toBe(true);
  });
});
