import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Encoder } from "@msgpack/msgpack";
import { ExchangeClient } from "./client.js";
import { decodeTx } from "./codec.js";
import { bytesToHex, generateKeypair } from "./crypto.js";
import { Side } from "./types.js";
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * Tests for timestamp-nonce submission. The strategy: stub global fetch to
 * return scripted responses for RPC/API endpoints, then inspect the signed
 * envelope to prove the SDK allocates unique millisecond nonces without a
 * GET-before-submit or failure-time resync.
 */

interface FetchCall {
  url: string;
  init?: RequestInit;
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

function gatewaySeq(call: FetchCall): bigint {
  const body = JSON.parse(call.init?.body as string) as { action: string };
  return decodeTx(bytesFromBase64(body.action)).seq;
}

function cometSeq(call: FetchCall): bigint {
  const body = JSON.parse(call.init?.body as string) as {
    params: { tx: string };
  };
  return decodeTx(bytesFromBase64(body.params.tx)).seq;
}

function primeNextNonce(client: ExchangeClient, offsetMs = 1_000n): bigint {
  const floor = BigInt(Date.now()) + offsetMs;
  (client as unknown as { lastTimestampNonce: bigint }).lastTimestampNonce =
    floor;
  return floor + 1n;
}

describe("ExchangeClient timestamp nonce submission", () => {
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
    // The timestamp-nonce tests below mock CometBFT JSON-RPC responses, so
    // the client must take the legacy `useGateway: false` path. The
    // production-default gateway path is exercised in the dedicated
    // "submitViaGateway" test block further down. `chainId` is pinned
    // explicitly so submitTx doesn't try to resolve from the mocked /status
    // (which only returns the scripted broadcast_tx_sync responses).
    const c = new ExchangeClient({
      rpcUrl: "http://test-rpc",
      apiUrl: "http://test-api",
      useGateway: false,
      chainId: "test-chain",
    });
    const kp = generateKeypair();
    c.setPrivateKey(kp.privateKey);
    return c;
  }

  it("submitTx returns CheckTx code immediately and signs a timestamp nonce", async () => {
    const client = makeClient();
    // Use unsafe fast mode so no background verifier is spawned and we don't
    // need to queue follow-up /tx?hash responses for this test in isolation.
    client.setUnsafeFastSubmit(true);
    const expectedNonce = primeNextNonce(client);

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
    expect(cometSeq(calls[0])).toBe(expectedNonce);
    expect(
      (client as unknown as { lastTimestampNonce: bigint }).lastTimestampNonce,
    ).toBe(expectedNonce);
    // No verifier spawned in unsafe-fast mode, nothing to await.
    expect(
      (client as unknown as { pendingVerifies: Set<unknown> }).pendingVerifies
        .size,
    ).toBe(0);
  });

  it("does not resync on CheckTx timestamp nonce rejection; the next submit chooses a fresh timestamp", async () => {
    const client = makeClient();
    const expectedNonce = primeNextNonce(client);

    // First fetch: CheckTx returns timestamp nonce rejection (code 21).
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
    expect(cometSeq(calls[0])).toBe(expectedNonce);
    expect(
      (client as unknown as { lastTimestampNonce: bigint }).lastTimestampNonce,
    ).toBe(expectedNonce);
    expect(calls.length).toBe(1);
  });

  it("background verifier does not rewind nonce on silent DeliverTx failure", async () => {
    const client = makeClient();
    const expectedNonce = primeNextNonce(client);

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
    expect(
      (client as unknown as { lastTimestampNonce: bigint }).lastTimestampNonce,
    ).toBe(expectedNonce);

    // Wait for the background verifier to observe the failed DeliverTx.
    await client.awaitPendingVerifies();

    // Included failed transactions burn their timestamp nonce, so no rewind.
    expect(
      (client as unknown as { lastTimestampNonce: bigint }).lastTimestampNonce,
    ).toBe(expectedNonce);
  });

  it("background verifier leaves nonce alone on DeliverTx success", async () => {
    const client = makeClient();
    const expectedNonce = primeNextNonce(client);

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
    // Verifier polls — returns DeliverTx code 0 (success).
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
    expect(
      (client as unknown as { lastTimestampNonce: bigint }).lastTimestampNonce,
    ).toBe(expectedNonce);

    await client.awaitPendingVerifies();
    expect(
      (client as unknown as { lastTimestampNonce: bigint }).lastTimestampNonce,
    ).toBe(expectedNonce);
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

    nextResponses.push(() => new Response(JSON.stringify({ data: dataB64 })));

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
    const expectedNonce = primeNextNonce(client);
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
    expect(
      (client as unknown as { lastTimestampNonce: bigint }).lastTimestampNonce,
    ).toBe(expectedNonce);
  });
});

/**
 * Tests for the production-default gateway submission path.
 *
 * `useGateway: true` (the default) routes `submitTx` through the public
 * Rust API gateway (`POST gatewayUrl/exchange`) instead of CometBFT
 * `broadcast_tx_sync`. Same wire bytes; the gateway re-verifies the
 * signature, applies rate limiting, and (when configured) checks
 * `X-Api-Key`. Timestamp nonce semantics are identical on this path.
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
      },
    ) as unknown as typeof fetch;
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
      // Pinned so submitTx doesn't fan out to the mocked /status.
      chainId: "test-chain",
    });
    const kp = generateKeypair();
    c.setPrivateKey(kp.privateKey);
    return c;
  }

  it("default path posts to gatewayUrl/exchange (not rpcUrl)", async () => {
    const client = makeGatewayClient();
    client.setUnsafeFastSubmit(true);
    const expectedNonce = primeNextNonce(client);

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
    expect(gatewaySeq(calls[0])).toBe(expectedNonce);
    expect(
      (client as unknown as { lastTimestampNonce: bigint }).lastTimestampNonce,
    ).toBe(expectedNonce);
  });

  it("concurrent submits reserve unique timestamp nonces before gateway responses", async () => {
    const client = makeGatewayClient();
    client.setUnsafeFastSubmit(true);
    const firstNonce = primeNextNonce(client);

    nextResponses.push(
      () =>
        new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      () =>
        new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const action = {
      type: "PlaceOrder" as const,
      data: {
        market: 1,
        owner: client.getAddress()!,
        side: Side.Buy,
        price: 100_000_000n,
        quantity: 1n,
        clientOrderId: null,
      },
    };

    const [a, b] = await Promise.all([
      client.submitTx(action),
      client.submitTx(action),
    ]);

    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(gatewaySeq(calls[0])).toBe(firstNonce);
    expect(gatewaySeq(calls[1])).toBe(firstNonce + 1n);
    expect(
      (client as unknown as { lastTimestampNonce: bigint }).lastTimestampNonce,
    ).toBe(firstNonce + 1n);
  });

  it("100 same-ms concurrent submits each get a unique sequential timestamp nonce", async () => {
    const client = makeGatewayClient();
    client.setUnsafeFastSubmit(true);
    const firstNonce = primeNextNonce(client);

    for (let i = 0; i < 100; i++) {
      nextResponses.push(
        () =>
          new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
    }

    const action = {
      type: "PlaceOrder" as const,
      data: {
        market: 1,
        owner: client.getAddress()!,
        side: Side.Buy,
        price: 100_000_000n,
        quantity: 1n,
        clientOrderId: null,
      },
    };

    const results = await Promise.all(
      Array.from({ length: 100 }, () => client.submitTx(action)),
    );

    expect(results.every((r) => r.code === 0)).toBe(true);
    const seqs = calls
      .slice(0, 100)
      .map(gatewaySeq)
      .sort((a, b) => Number(a - b));
    for (let i = 0; i < 100; i++) {
      expect(seqs[i]).toBe(firstNonce + BigInt(i));
    }
    expect(
      (client as unknown as { lastTimestampNonce: bigint }).lastTimestampNonce,
    ).toBe(firstNonce + 99n);
  });

  it("nextTimestampNonce caps at now + 60_000ms even under heavy bursts", () => {
    const client = makeGatewayClient();
    (client as unknown as { lastTimestampNonce: bigint }).lastTimestampNonce =
      BigInt(Date.now()) + 1_000_000n;
    const next = (
      client as unknown as { nextTimestampNonce(): bigint }
    ).nextTimestampNonce();
    expect(next).toBeLessThanOrEqual(BigInt(Date.now()) + 60_000n);
  });

  it("timestamp nonce rejection through gateway does not resync or rewind", async () => {
    const client = makeGatewayClient();
    client.setUnsafeFastSubmit(true);
    const expectedNonce = primeNextNonce(client);

    nextResponses.push(
      () =>
        new Response(
          JSON.stringify({ status: "error", error: "21: invalid nonce" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
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
    expect(gatewaySeq(calls[0])).toBe(expectedNonce);
    expect(
      (client as unknown as { lastTimestampNonce: bigint }).lastTimestampNonce,
    ).toBe(expectedNonce);
    expect(calls.length).toBe(1);
  });

  it("trims trailing slash from gatewayUrl", async () => {
    const client = makeGatewayClient({ gatewayUrl: "http://test-gateway/" });
    client.setUnsafeFastSubmit(true);
    primeNextNonce(client);

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

  it("submits to the configured gatewayUrl verbatim", async () => {
    const c = new ExchangeClient({
      gatewayUrl: "http://remote-node.example:9080",
      useGateway: true,
      chainId: "test-chain",
    });
    const kp = generateKeypair();
    c.setPrivateKey(kp.privateKey);
    c.setUnsafeFastSubmit(true);
    primeNextNonce(c);

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
    const expectedNonce = primeNextNonce(client);

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
    expect(calls[1].url).toBe(`http://test-gateway/v1/tx/${expectedHash}`);
    expect(
      (client as unknown as { lastTimestampNonce: bigint }).lastTimestampNonce,
    ).toBe(expectedNonce);
  });

  it("submitTxCommit works on the gateway path by polling the computed hash", async () => {
    const client = makeGatewayClient();
    const expectedNonce = primeNextNonce(client);

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
    expect(calls[1].url).toBe(`http://test-gateway/v1/tx/${expectedHash}`);
    expect(
      (client as unknown as { lastTimestampNonce: bigint }).lastTimestampNonce,
    ).toBe(expectedNonce);
  });

  it("includes X-Api-Key header when apiKey is set", async () => {
    const client = makeGatewayClient({ apiKey: "secret-123" });
    client.setUnsafeFastSubmit(true);
    primeNextNonce(client);

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
    primeNextNonce(client);

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

  it("gateway error '21: invalid nonce' parses to code 21 without nonce resync", async () => {
    const client = makeGatewayClient();
    client.setUnsafeFastSubmit(true);
    const expectedNonce = primeNextNonce(client);

    // First response: gateway returns the engine's timestamp nonce rejection error.
    nextResponses.push(
      () =>
        new Response(
          JSON.stringify({
            status: "error",
            error: "21: invalid timestamp nonce",
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
    expect(gatewaySeq(calls[0])).toBe(expectedNonce);
    expect(
      (client as unknown as { lastTimestampNonce: bigint }).lastTimestampNonce,
    ).toBe(expectedNonce);
    expect(calls.length).toBe(1);
  });

  it("HTTP 401 from gateway maps to code 401 (auth failure)", async () => {
    const client = makeGatewayClient({ apiKey: "wrong-key" });
    client.setUnsafeFastSubmit(true);
    const expectedNonce = primeNextNonce(client);

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
    expect(
      (client as unknown as { lastTimestampNonce: bigint }).lastTimestampNonce,
    ).toBe(expectedNonce);
  });

  it("HTTP 429 from gateway maps to code 429 (rate limited)", async () => {
    const client = makeGatewayClient();
    client.setUnsafeFastSubmit(true);
    const expectedNonce = primeNextNonce(client);

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
    expect(
      (client as unknown as { lastTimestampNonce: bigint }).lastTimestampNonce,
    ).toBe(expectedNonce);
  });

  it("HTTP 413 from gateway maps to code 413 and preserves body detail", async () => {
    const client = makeGatewayClient();
    client.setUnsafeFastSubmit(true);
    const expectedNonce = primeNextNonce(client);

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
    expect(
      (client as unknown as { lastTimestampNonce: bigint }).lastTimestampNonce,
    ).toBe(expectedNonce);
  });

  it("HTTP 5xx from gateway maps to code 500 and keeps the allocated timestamp nonce", async () => {
    const client = makeGatewayClient();
    client.setUnsafeFastSubmit(true);
    const expectedNonce = primeNextNonce(client);

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
    expect(
      (client as unknown as { lastTimestampNonce: bigint }).lastTimestampNonce,
    ).toBe(expectedNonce);
  });

  it("non-JSON gateway error body returns a TxResult instead of throwing", async () => {
    const client = makeGatewayClient();
    client.setUnsafeFastSubmit(true);
    const expectedNonce = primeNextNonce(client);

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
    expect(
      (client as unknown as { lastTimestampNonce: bigint }).lastTimestampNonce,
    ).toBe(expectedNonce);
  });

  it("useGateway: false routes to legacy CometBFT path", async () => {
    const c = new ExchangeClient({
      rpcUrl: "http://test-rpc",
      apiUrl: "http://test-api",
      gatewayUrl: "http://test-gateway",
      useGateway: false,
      chainId: "test-chain",
    });
    const kp = generateKeypair();
    c.setPrivateKey(kp.privateKey);
    c.setUnsafeFastSubmit(true);
    const expectedNonce = primeNextNonce(c);

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
    expect(cometSeq(calls[0])).toBe(expectedNonce);
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
