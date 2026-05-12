import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Encoder } from "@msgpack/msgpack";
import { ExchangeClient } from "./client.js";
import { bytesToHex, generateKeypair } from "./crypto.js";
import { Side } from "./types.js";
import { sha256 } from "@noble/hashes/sha256";

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

function bytesFromBase64(b64: string): Uint8Array {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function expectedGatewayHash(call: FetchCall): string {
  const body = JSON.parse(call.init?.body as string) as { action: string };
  return bytesToHex(sha256(bytesFromBase64(body.action))).toUpperCase();
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
        // Auto-answer CometBFT /status chain_id discovery without
        // consuming a test-queued response slot or polluting the
        // calls[] log that tests assert on.
        if (u.endsWith("/status")) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { node_info: { network: "test-chain" } },
            }),
            { status: 200 },
          );
        }
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
    // The nonce-drift tests below mock CometBFT JSON-RPC responses, so
    // the client must take the legacy `useGateway: false` path. The
    // production-default gateway path is exercised in the dedicated
    // "submitViaGateway" test block further down.
    const c = new ExchangeClient({
      rpcUrl: "http://test-rpc",
      apiUrl: "http://test-api",
      useGateway: false,
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

  it("queryWithdrawal decodes positional tuple by index", async () => {
    const client = makeClient();

    const owner = new Uint8Array(20);
    owner.fill(0xab);
    const dest = new Uint8Array(32);
    dest.fill(0xcd);

    // Positional msgpack tuple — field order MUST match WithdrawalRecord.
    const tuple: unknown[] = [42n, owner, 1_000_000n, dest, "Pending", 100n];
    const encoder = new Encoder({ useBigInt64: true });
    const bytes = encoder.encode(tuple);
    let b64 = "";
    for (const b of bytes) b64 += String.fromCharCode(b);
    const dataB64 = btoa(b64);

    nextResponses.push(
      () => new Response(JSON.stringify({ data: dataB64 })),
    );

    const rec = await client.queryWithdrawal(42n);
    expect(rec).not.toBeNull();
    expect(rec!.id).toBe(42n);
    // Byte-exact owner/destination — guards against tuple-position swap
    // (plan §Risk warned the two byte arrays are similar shape).
    expect(rec!.owner).toEqual(owner);
    expect(rec!.amount).toBe(1_000_000n);
    expect(rec!.solanaDestination).toEqual(dest);
    expect(rec!.status).toBe("Pending");
    expect(rec!.requestHeight).toBe(100n);
    expect(calls[0].url).toBe("http://test-api/v1/withdrawal/42");
  });

  it("queryWithdrawal returns null for msgpack-nil response", async () => {
    const client = makeClient();
    // msgpack nil = single byte 0xc0
    nextResponses.push(
      () => new Response(JSON.stringify({ data: btoa("\xc0") })),
    );
    const rec = await client.queryWithdrawal(999n);
    expect(rec).toBeNull();
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

/**
 * Tests for the production-default gateway submission path.
 *
 * `useGateway: true` (the default) routes `submitTx` through the public
 * Rust API gateway (`POST gatewayUrl/exchange`) instead of CometBFT
 * `broadcast_tx_sync`. Same wire bytes; the gateway re-verifies the
 * signature, applies rate limiting, and (when configured) checks
 * `X-Api-Key`. CheckTx-level error semantics (code=21 InvalidNonce
 * auto-resync) are preserved on this path.
 */
describe("ExchangeClient submitTx gateway path", () => {
  const originalFetch = globalThis.fetch;
  let calls: FetchCall[] = [];
  let nextResponses: Array<(req: FetchCall) => Response> = [];

  beforeEach(() => {
    calls = [];
    nextResponses = [];
    globalThis.fetch = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const u = url.toString();
        // Auto-answer CometBFT /status chain_id discovery without
        // consuming a test-queued response slot or polluting the
        // calls[] log that tests assert on.
        if (u.endsWith("/status")) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { node_info: { network: "test-chain" } },
            }),
            { status: 200 },
          );
        }
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
      }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeGatewayClient(
    opts: {
      apiKey?: string;
      gatewayUrl?: string;
      rpcUrl?: string;
    } = {},
  ): ExchangeClient {
    const c = new ExchangeClient({
      rpcUrl: opts.rpcUrl ?? "http://test-rpc",
      apiUrl: "http://test-api",
      gatewayUrl: opts.gatewayUrl ?? "http://test-gateway",
      // useGateway defaults to true — explicit here for documentation.
      useGateway: true,
      apiKey: opts.apiKey,
    });
    const kp = generateKeypair();
    c.setPrivateKey(kp.privateKey);
    return c;
  }

  it("default path posts to gatewayUrl/exchange (not rpcUrl)", async () => {
    const client = makeGatewayClient();
    client.setUnsafeFastSubmit(true);
    (client as unknown as { nonce: bigint }).nonce = 5n;

    nextResponses.push(
      () =>
        new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const r = await client.submitTx({
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

    expect(r.code).toBe(0);
    expect(r.hash).toBe(expectedGatewayHash(calls[0]));
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("http://test-gateway/exchange");
    // Gateway path uses application/json + the pre-signed shape, not
    // the JSON-RPC envelope CometBFT expects.
    expect(
      (calls[0].init?.headers as Record<string, string>)["Content-Type"],
    ).toBe("application/json");
    const body = JSON.parse(calls[0].init?.body as string) as {
      action: string;
    };
    expect(typeof body.action).toBe("string");
    // Nonce was incremented on success.
    expect((client as unknown as { nonce: bigint }).nonce).toBe(6n);
  });

  it("trims trailing slash from gatewayUrl", async () => {
    const client = makeGatewayClient({ gatewayUrl: "http://test-gateway/" });
    client.setUnsafeFastSubmit(true);
    (client as unknown as { nonce: bigint }).nonce = 5n;

    nextResponses.push(
      () =>
        new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
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

    expect(calls[0].url).toBe("http://test-gateway/exchange");
  });

  it("derives default gatewayUrl from rpcUrl host when gatewayUrl is omitted", async () => {
    const c = new ExchangeClient({
      rpcUrl: "http://remote-node.example:26657",
      apiUrl: "http://test-api",
      useGateway: true,
    });
    const kp = generateKeypair();
    c.setPrivateKey(kp.privateKey);
    c.setUnsafeFastSubmit(true);
    (c as unknown as { nonce: bigint }).nonce = 5n;

    nextResponses.push(
      () =>
        new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await c.submitTx({
      type: "PlaceOrder",
      data: {
        market: 1,
        owner: c.getAddress()!,
        side: Side.Buy,
        price: 100_000_000n,
        quantity: 1n,
        clientOrderId: null,
      },
    });

    expect(calls[0].url).toBe("http://remote-node.example:9080/exchange");
  });

  it("gateway success hash drives background delivery verification", async () => {
    const client = makeGatewayClient();
    (client as unknown as { nonce: bigint }).nonce = 5n;

    nextResponses.push(
      () =>
        new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
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

    const r = await client.submitTx({
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
    const expectedHash = expectedGatewayHash(calls[0]);

    expect(r.code).toBe(0);
    expect(r.hash).toBe(expectedHash);
    await client.awaitPendingVerifies();
    expect(calls[1].url).toBe(`http://test-rpc/tx?hash=0x${expectedHash}`);
    expect((client as unknown as { nonce: bigint }).nonce).toBe(6n);
  });

  it("submitTxCommit works on the gateway path by polling the computed hash", async () => {
    const client = makeGatewayClient();
    (client as unknown as { nonce: bigint }).nonce = 5n;

    nextResponses.push(
      () =>
        new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    nextResponses.push(
      () =>
        new Response(
          JSON.stringify({
            result: {
              tx_result: { code: 0, log: "", events: [{ type: "proof.test" }] },
              height: "202",
            },
          }),
        ),
    );

    const r = await client.submitTxCommit({
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
    const expectedHash = expectedGatewayHash(calls[0]);

    expect(r).toMatchObject({
      code: 0,
      hash: expectedHash,
      height: 202,
      log: "",
    });
    expect(calls[1].url).toBe(`http://test-rpc/tx?hash=0x${expectedHash}`);
    expect((client as unknown as { nonce: bigint }).nonce).toBe(6n);
  });

  it("includes X-Api-Key header when apiKey is set", async () => {
    const client = makeGatewayClient({ apiKey: "secret-123" });
    client.setUnsafeFastSubmit(true);
    (client as unknown as { nonce: bigint }).nonce = 5n;

    nextResponses.push(
      () =>
        new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
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

    expect(calls[0].init?.headers as Record<string, string>).toMatchObject({
      "X-Api-Key": "secret-123",
    });
  });

  it("does not send X-Api-Key when apiKey is unset", async () => {
    const client = makeGatewayClient();
    client.setUnsafeFastSubmit(true);
    (client as unknown as { nonce: bigint }).nonce = 5n;

    nextResponses.push(
      () =>
        new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
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

    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBeUndefined();
  });

  it("gateway error '21: invalid nonce' parses to code 21 and triggers nonce resync", async () => {
    const client = makeGatewayClient();
    client.setUnsafeFastSubmit(true);
    (client as unknown as { nonce: bigint }).nonce = 50n;

    // First response: gateway returns the engine's InvalidNonce error.
    nextResponses.push(
      () =>
        new Response(
          JSON.stringify({
            status: "error",
            error: "21: invalid nonce: expected 51, got 50",
          }),
          { status: 200 },
        ),
    );
    // Second response: nonce resync via /v1/nonce/{addr} returns 51.
    nextResponses.push(
      () =>
        new Response(
          JSON.stringify({
            data: makeMsgpackBigInt(51n),
          }),
          { status: 200 },
        ),
    );

    const r = await client.submitTx({
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

    expect(r.code).toBe(21);
    // After resync, local nonce matches chain.
    expect((client as unknown as { nonce: bigint }).nonce).toBe(51n);
  });

  it("HTTP 401 from gateway maps to code 401 (auth failure)", async () => {
    const client = makeGatewayClient({ apiKey: "wrong-key" });
    client.setUnsafeFastSubmit(true);
    (client as unknown as { nonce: bigint }).nonce = 5n;

    nextResponses.push(
      () =>
        new Response(
          JSON.stringify({
            status: "error",
            error: "unauthorized",
          }),
          { status: 401 },
        ),
    );

    const r = await client.submitTx({
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

    expect(r.code).toBe(401);
    expect(r.log).toBe("unauthorized");
    // 401 is a transport-level rejection, not a CheckTx success — local
    // nonce should not have been incremented.
    expect((client as unknown as { nonce: bigint }).nonce).toBe(5n);
  });

  it("HTTP 429 from gateway maps to code 429 (rate limited)", async () => {
    const client = makeGatewayClient();
    client.setUnsafeFastSubmit(true);
    (client as unknown as { nonce: bigint }).nonce = 5n;

    nextResponses.push(() => new Response("rate limited", { status: 429 }));

    const r = await client.submitTx({
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

    expect(r.code).toBe(429);
    expect(r.log).toBe("rate limited");
    expect((client as unknown as { nonce: bigint }).nonce).toBe(5n);
  });

  it("HTTP 413 from gateway maps to code 413 and preserves body detail", async () => {
    const client = makeGatewayClient();
    client.setUnsafeFastSubmit(true);
    (client as unknown as { nonce: bigint }).nonce = 5n;

    nextResponses.push(
      () =>
        new Response(
          JSON.stringify({ status: "error", error: "body too large" }),
          { status: 413 },
        ),
    );

    const r = await client.submitTx({
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

    expect(r.code).toBe(413);
    expect(r.log).toBe("body too large");
    expect((client as unknown as { nonce: bigint }).nonce).toBe(5n);
  });

  it("HTTP 5xx from gateway maps to code 500 and does not increment nonce", async () => {
    const client = makeGatewayClient();
    client.setUnsafeFastSubmit(true);
    (client as unknown as { nonce: bigint }).nonce = 5n;

    nextResponses.push(
      () =>
        new Response("bad gateway", { status: 502, statusText: "Bad Gateway" }),
    );

    const r = await client.submitTx({
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

    expect(r.code).toBe(500);
    expect(r.log).toContain("bad gateway");
    expect((client as unknown as { nonce: bigint }).nonce).toBe(5n);
  });

  it("non-JSON gateway error body returns a TxResult instead of throwing", async () => {
    const client = makeGatewayClient();
    client.setUnsafeFastSubmit(true);
    (client as unknown as { nonce: bigint }).nonce = 5n;

    nextResponses.push(
      () => new Response("<html>bad request</html>", { status: 400 }),
    );

    const r = await client.submitTx({
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

    expect(r).toMatchObject({
      code: 1,
      hash: "",
      log: "<html>bad request</html>",
    });
    expect((client as unknown as { nonce: bigint }).nonce).toBe(5n);
  });

  it("useGateway: false routes to legacy CometBFT path", async () => {
    const c = new ExchangeClient({
      rpcUrl: "http://test-rpc",
      apiUrl: "http://test-api",
      gatewayUrl: "http://test-gateway",
      useGateway: false,
    });
    const kp = generateKeypair();
    c.setPrivateKey(kp.privateKey);
    c.setUnsafeFastSubmit(true);
    (c as unknown as { nonce: bigint }).nonce = 5n;

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

    await c.submitTx({
      type: "PlaceOrder",
      data: {
        market: 1,
        owner: c.getAddress()!,
        side: Side.Buy,
        price: 100_000_000n,
        quantity: 1n,
        clientOrderId: null,
      },
    });

    expect(calls[0].url).toBe("http://test-rpc");
    const body = JSON.parse(calls[0].init?.body as string) as {
      jsonrpc: string;
      id: number;
      method: string;
      params: { tx: string };
    };
    expect(body).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "broadcast_tx_sync",
    });
    expect(typeof body.params.tx).toBe("string");
  });
});
