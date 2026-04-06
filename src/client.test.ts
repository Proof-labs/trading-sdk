import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ExchangeClient } from "./client.js";
import { generateKeypair } from "./crypto.js";
import { Side } from "./types.js";

/**
 * Tests for the submitTx auto-recovery from silent DeliverTx failures
 * (the nonce-drift bug that used to cascade into InvalidNonce errors).
 *
 * The strategy: stub global fetch to return scripted responses for the
 * RPC and API endpoints. We simulate:
 *   - broadcast_tx_sync returning code=0 (CheckTx pass)
 *   - /tx?hash=... returning a DeliverTx-failed result
 *   - /v1/nonce/... returning the chain's actual (lower) nonce
 *
 * The client should detect the silent DeliverTx failure via its background
 * verifier, call syncNonce(), and reset its local nonce to match the chain.
 */

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function makeMsgpackBigInt(n: bigint): string {
  // msgpack uint64 fixed-format: 0xcf + 8 bytes BE
  const bytes = new Uint8Array(9);
  bytes[0] = 0xcf;
  const v = BigInt.asUintN(64, n);
  for (let i = 0; i < 8; i++) {
    bytes[8 - i] = Number((v >> BigInt(i * 8)) & 0xffn);
  }
  // Base64 encode
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

describe("ExchangeClient submitTx nonce-drift recovery", () => {
  const originalFetch = globalThis.fetch;
  let calls: FetchCall[] = [];
  let nextResponses: Array<(req: FetchCall) => Response> = [];

  beforeEach(() => {
    calls = [];
    nextResponses = [];
    globalThis.fetch = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const u = url.toString();
        calls.push({ url: u, init });
        if (nextResponses.length === 0) {
          return new Response(
            JSON.stringify({ error: "unexpected fetch in test" }),
            {
              status: 500,
            },
          );
        }
        const responder = nextResponses.shift()!;
        return responder({ url: u, init });
      },
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeClient(): ExchangeClient {
    const c = new ExchangeClient({
      rpcUrl: "http://test-rpc",
      apiUrl: "http://test-api",
    });
    const kp = generateKeypair();
    c.setPrivateKey(kp.privateKey);
    return c;
  }

  it("submitTx returns CheckTx code immediately and increments local nonce", async () => {
    const client = makeClient();
    // Use unsafe fast mode so no background verifier is spawned and we don't
    // need to queue follow-up /tx?hash responses for this test in isolation.
    client.setUnsafeFastSubmit(true);
    // Pre-set nonce so we don't go through fetchNonce on first submit.
    (client as unknown as { nonce: bigint }).nonce = 5n;

    nextResponses.push(
      () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { code: 0, hash: "DEADBEEF", log: "" },
          }),
        ),
    );

    const result = await client.submitTx({
      type: "PlaceOrder",
      data: {
        market: 1,
        owner: client.getAddress()!,
        side: Side.Buy,
        price: 100_000_000n,
        quantity: 1n,
        clientOrderId: null,
      },
    });

    expect(result.code).toBe(0);
    expect(result.hash).toBe("DEADBEEF");
    expect((client as unknown as { nonce: bigint }).nonce).toBe(6n);
    // No verifier spawned in unsafe-fast mode, nothing to await.
    expect(
      (client as unknown as { pendingVerifies: Set<unknown> }).pendingVerifies
        .size,
    ).toBe(0);
  });

  it("auto-resyncs nonce when CheckTx returns code 21 (InvalidNonce)", async () => {
    const client = makeClient();
    (client as unknown as { nonce: bigint }).nonce = 99n;

    // First fetch: CheckTx returns InvalidNonce (code 21).
    nextResponses.push(
      () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { code: 21, hash: "BADBAD", log: "invalid nonce" },
          }),
        ),
    );
    // Auto-resync triggered: fetch /v1/nonce/{addr} returns chain nonce 7.
    nextResponses.push(
      () => new Response(JSON.stringify({ data: makeMsgpackBigInt(7n) })),
    );

    const result = await client.submitTx({
      type: "PlaceOrder",
      data: {
        market: 1,
        owner: client.getAddress()!,
        side: Side.Buy,
        price: 100_000_000n,
        quantity: 1n,
        clientOrderId: null,
      },
    });

    expect(result.code).toBe(21);
    // Local nonce should NOT have been incremented (CheckTx failed).
    // After the auto-syncNonce kicks in, it should match the chain value (7).
    // The auto-sync runs as a fire-and-forget Promise, so wait for next tick.
    await new Promise((r) => setTimeout(r, 50));
    expect((client as unknown as { nonce: bigint }).nonce).toBe(7n);
  });

  it("background verifier resyncs nonce on silent DeliverTx failure", async () => {
    const client = makeClient();
    (client as unknown as { nonce: bigint }).nonce = 50n;

    // 1. broadcast_tx_sync → CheckTx code 0
    nextResponses.push(
      () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { code: 0, hash: "FACEFEED", log: "" },
          }),
        ),
    );
    // 2. The background verifier polls /tx?hash. First poll returns the
    //    DeliverTx result with code 12 (InsufficientMargin).
    nextResponses.push(
      () =>
        new Response(
          JSON.stringify({
            result: {
              tx_result: { code: 12, log: "InsufficientMargin", events: [] },
              height: "100",
            },
          }),
        ),
    );
    // 3. The verifier calls syncNonce → /v1/nonce returns the chain nonce
    //    of 50 (NOT 51, because DeliverTx failed and chain didn't bump).
    nextResponses.push(
      () => new Response(JSON.stringify({ data: makeMsgpackBigInt(50n) })),
    );

    const result = await client.submitTx({
      type: "MarketOrder",
      data: {
        market: 1,
        owner: client.getAddress()!,
        side: Side.Buy,
        quantity: 1n,
        clientOrderId: null,
      },
    });

    // submitTx itself returns the CheckTx result (code 0).
    expect(result.code).toBe(0);
    // Local nonce was optimistically bumped to 51.
    expect((client as unknown as { nonce: bigint }).nonce).toBe(51n);

    // Wait for the background verifier to detect the failure and resync.
    await client.awaitPendingVerifies();

    // After verification, the local nonce should match the chain (50),
    // recovering from the silent DeliverTx failure.
    expect((client as unknown as { nonce: bigint }).nonce).toBe(50n);
  });

  it("background verifier leaves nonce alone on DeliverTx success", async () => {
    const client = makeClient();
    (client as unknown as { nonce: bigint }).nonce = 50n;

    // CheckTx pass
    nextResponses.push(
      () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { code: 0, hash: "AAAAAA", log: "" },
          }),
        ),
    );
    // Verifier polls — returns DeliverTx code 0 (success). No syncNonce call
    // expected after this.
    nextResponses.push(
      () =>
        new Response(
          JSON.stringify({
            result: {
              tx_result: { code: 0, log: "", events: [] },
              height: "101",
            },
          }),
        ),
    );

    await client.submitTx({
      type: "PlaceOrder",
      data: {
        market: 1,
        owner: client.getAddress()!,
        side: Side.Sell,
        price: 100_000_000n,
        quantity: 1n,
        clientOrderId: null,
      },
    });
    expect((client as unknown as { nonce: bigint }).nonce).toBe(51n);

    await client.awaitPendingVerifies();
    // Nonce should remain at 51 — DeliverTx succeeded, no recovery needed.
    expect((client as unknown as { nonce: bigint }).nonce).toBe(51n);
  });

  it("setUnsafeFastSubmit(true) skips background verifier", async () => {
    const client = makeClient();
    (client as unknown as { nonce: bigint }).nonce = 10n;
    client.setUnsafeFastSubmit(true);

    nextResponses.push(
      () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { code: 0, hash: "BBBBBB", log: "" },
          }),
        ),
    );

    await client.submitTx({
      type: "PlaceOrder",
      data: {
        market: 1,
        owner: client.getAddress()!,
        side: Side.Buy,
        price: 100_000_000n,
        quantity: 1n,
        clientOrderId: null,
      },
    });

    // No background verifier was spawned, so pendingVerifies is empty.
    expect(
      (client as unknown as { pendingVerifies: Set<unknown> }).pendingVerifies
        .size,
    ).toBe(0);
    // Only one fetch was made (the broadcast_tx_sync), no /tx?hash poll.
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("http://test-rpc");
  });
});
