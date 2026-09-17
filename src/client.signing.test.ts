import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExchangeClient,
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
});

describe("timestamp nonce allocation", () => {
  it("never repeats the local clamp ceiling and recovers when clock advances", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_754_000_000_000);
    const c = external();
    // Simulate an actual allocation at now+60s followed by local clock rollback.
    clock.mockReturnValue(1_754_000_000_000 + 60_000);
    expect(decodeTx(await c.signTx(action)).seq).toBe(
      BigInt(1_754_000_000_000 + 60_000),
    );
    clock.mockReturnValue(1_754_000_000_000);
    await expect(c.signTx(action)).rejects.toThrow("clock safety window");
    clock.mockReturnValue(1_754_000_000_000 + 1);
    expect(decodeTx(await c.signTx(action)).seq).toBe(
      BigInt(1_754_000_000_000 + 60_001),
    );
  });
});

it.each([0, 100, 60_000, 60_001, 86_400_000])(
  "allocates concurrently after clock advance %i without remote nonce reads",
  async (skew) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_754_000_000_000);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const c = external();
    await c.signTx(action);
    clock.mockReturnValue(1_754_000_000_000 + skew);
    const first = BigInt(1_754_000_000_000 + Math.max(skew, 1));
    const seqs = await Promise.all(
      Array.from(
        { length: 4 },
        async () => decodeTx(await c.signTx(action)).seq,
      ),
    );
    expect(seqs).toEqual(
      Array.from({ length: 4 }, (_, i) => first + BigInt(i)),
    );
    expect(fetch).not.toHaveBeenCalled();
  },
);
it("signs without structuredClone", async () => {
  vi.stubGlobal("structuredClone", undefined);
  expect((await external().signTx(action)).length).toBeGreaterThan(0);
});
