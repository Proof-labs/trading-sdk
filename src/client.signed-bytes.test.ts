// Exact-byte callers: a process that signs, stores the bytes durably, and
// sends (or resends) them later. They need two things from the client:
// a nonce floor when signing (so a restart never signs below bytes it already
// stored), and the originating action on the byte-level send and confirmation
// calls (so a cancellation keeps its `urgent` transport priority).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExchangeClient,
  Side,
  decodeTx,
  getPublicKey,
  pubkeyToOwner,
  type Action,
  type ExchangeHttpRequestContext,
  type ExchangeHttpTransport,
} from "./index.js";

const key = new Uint8Array(32).fill(7);
const owner = pubkeyToOwner(getPublicKey(key));
const place: Action = {
  type: "PlaceOrder",
  data: { owner, market: 3, side: Side.Buy, price: 1_000_000n, quantity: 1n },
};
const cancel: Action = { type: "CancelOrder", data: { owner, orderId: 42n } };

function client(transport?: ExchangeHttpTransport): ExchangeClient {
  const c = new ExchangeClient({
    gatewayUrl: "http://gw",
    apiUrl: "http://api",
    rpcUrl: "http://rpc",
    chainId: "signed-bytes-test",
    ...(transport ? { httpTransport: transport } : {}),
  });
  c.setPrivateKey(key);
  c.setUnsafeFastSubmit(true);
  return c;
}

function recording(responses: Array<() => Response>) {
  const contexts: ExchangeHttpRequestContext[] = [];
  const transport: ExchangeHttpTransport = async (_url, _init, context) => {
    contexts.push(context);
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next();
  };
  return { contexts, transport };
}

const json = (body: unknown) => () =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("signTx minimumNonceExclusive", () => {
  it("signs strictly above a floor that is ahead of the clock", async () => {
    const c = client();
    const floor = BigInt(Date.now()) + 10_000n;
    const tx = await c.signTx(place, { minimumNonceExclusive: floor });
    expect(decodeTx(tx).seq).toBe(floor + 1n);
    // The next nonce without a floor continues above it, never below.
    const next = await c.signTx(place);
    expect(decodeTx(next).seq).toBe(floor + 2n);
  });

  it("uses the clock when the floor is already behind it", async () => {
    const c = client();
    const before = BigInt(Date.now());
    const tx = await c.signTx(place, { minimumNonceExclusive: 5n });
    expect(decodeTx(tx).seq >= before).toBe(true);
  });

  it("refuses a floor more than 60 seconds ahead and burns no nonce", async () => {
    const c = client();
    const lastBefore = c.currentNonce;
    await expect(
      c.signTx(place, { minimumNonceExclusive: BigInt(Date.now()) + 120_000n }),
    ).rejects.toThrow(/clock safety window/);
    expect(c.currentNonce).toBe(lastBefore);
  });

  it("refuses a floor that is not an unsigned-64 nonce", async () => {
    const c = client();
    for (const bad of [-1n, 0xffff_ffff_ffff_ffffn, 5 as unknown as bigint]) {
      await expect(
        c.signTx(place, { minimumNonceExclusive: bad }),
      ).rejects.toThrow(/unsigned-64 nonce floor/);
    }
  });
});

describe("byte-level sends carry the action's transport priority", () => {
  it("submitSignedTx marks a cancellation urgent and passes the action", async () => {
    const { contexts, transport } = recording([
      json({ status: "ok", code: 0, height: 9, events: [] }),
      json({ status: "ok", code: 0, height: 10, events: [] }),
    ]);
    const c = client(transport);
    const bytes = await c.signTx(cancel);
    await c.submitSignedTx(bytes, { action: cancel });
    expect(contexts[0]).toMatchObject({
      purpose: "submit",
      priority: "urgent",
      action: cancel,
    });
    // Without the hint the bytes stay opaque and get the default priority.
    await c.submitSignedTx(await c.signTx(cancel));
    expect(contexts[1].priority).toBe("critical");
    expect(contexts[1].action).toBeUndefined();
  });

  it("waitForDelivery polls a cancellation's confirmation as urgent", async () => {
    const { contexts, transport } = recording([
      json({ result: { height: "11", tx_result: { code: 0, events: [] } } }),
    ]);
    const c = client(transport);
    const result = await c.waitForDelivery(
      {
        ok: false,
        outcome: "timeout",
        code: -1,
        error: null,
        hash: "AB".repeat(32),
      },
      { action: cancel, timeoutMs: 5_000 },
    );
    expect(result.ok).toBe(true);
    expect(contexts[0]).toMatchObject({
      purpose: "confirmation",
      priority: "urgent",
      action: cancel,
    });
  });

  it("submitSignedTxCommit keeps the priority on the send and the poll", async () => {
    const { contexts, transport } = recording([
      // A hash-only answer: broadcast, outcome unknown, so the commit polls.
      () =>
        new Response(
          JSON.stringify({ status: "pending", error: "park deadline" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      json({ result: { height: "12", tx_result: { code: 0, events: [] } } }),
    ]);
    const c = client(transport);
    const result = await c.submitSignedTxCommit(await c.signTx(cancel), {
      action: cancel,
    });
    expect(result.ok).toBe(true);
    expect(contexts.map((x) => [x.purpose, x.priority])).toEqual([
      ["submit", "urgent"],
      ["confirmation", "urgent"],
    ]);
  });
});
