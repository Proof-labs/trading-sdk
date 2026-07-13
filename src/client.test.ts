import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Encoder } from "@msgpack/msgpack";
import { ExchangeClient, fetchChainId } from "./client.js";
import { decodeTx } from "./codec.js";
import {
  UNBOUND_CHAIN_ID,
  bytesToHex,
  chainIdFromString,
  generateKeypair,
  hexToBytes,
  ownerToHex,
  pubkeyToOwner,
  verify,
} from "./crypto.js";
import { Side, type Action } from "./types.js";
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

  /** A minimal valid order, so the tests read as being about the response. */
  function placeOrder(client: ExchangeClient): Action {
    return {
      type: "PlaceOrder",
      data: {
        market: 1,
        owner: client.getAddress()!,
        side: Side.Buy,
        price: 100_000_000n,
        quantity: 1n,
      },
    };
  }

  // ---------------------------------------------------------------------
  // Synchronous on-chain result (api-gateway#90).
  //
  // The gateway now parks the response on the tx hash and answers with the
  // chain's own code/log/height/events. The SDK's job is to stop polling for
  // something it already has — and to keep polling when it doesn't.
  // ---------------------------------------------------------------------

  it("submitTxCommit returns the gateway's on-chain result without polling /tx", async () => {
    const client = makeGatewayClient();
    primeNextNonce(client);

    nextResponses.push(
      () =>
        new Response(
          JSON.stringify({
            status: "ok",
            txHash: "ABCD",
            code: 0,
            height: 4821903,
            events: [{ type: "order_placed", attributes: [] }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const r = await client.submitTxCommit(placeOrder(client));

    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
    expect(r.height).toBe(4821903);
    expect(r.hash).toBe("ABCD");
    expect(r.events?.length).toBe(1);
    // The point of the change: exactly one round-trip. Previously this cost a
    // /tx?hash= poll loop of up to 9 seconds (the H14 complaint).
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain("/exchange");
    expect(calls.some((c) => c.url.includes("/tx"))).toBe(false);
  });

  it("a committed engine rejection is returned as an engine error, with its height", async () => {
    const client = makeGatewayClient();
    primeNextNonce(client);

    nextResponses.push(
      () =>
        new Response(
          JSON.stringify({
            status: "error",
            error: "insufficient margin",
            txHash: "ABCD",
            code: 12,
            log: "insufficient margin",
            height: 4821903,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const r = await client.submitTxCommit(placeOrder(client));

    expect(r.ok).toBe(false);
    expect(r.outcome).toBe("engine");
    expect(r.code).toBe(12);
    expect(r.height).toBe(4821903);
    expect(calls.length).toBe(1);
  });

  it("reads the structured code, not the leading integer of the error string", async () => {
    // The gateway keeps the legacy "<code>: <message>" error string for old
    // clients, but the structured `code` is authoritative. Deliberately make
    // the compatibility string disagree to prove this path does not parse it.
    const client = makeGatewayClient();
    primeNextNonce(client);

    nextResponses.push(
      () =>
        new Response(
          JSON.stringify({
            status: "error",
            error: "12: stale compatibility text",
            log: "nonce too old: minimum accepted 1783771798253, got 0",
            txHash: "ABCD",
            code: 21,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const r = await client.submitTx(placeOrder(client));

    expect(r.outcome).toBe("engine");
    expect(r.code).toBe(21);
    expect(r.error?.name).toBeDefined();
    // A CheckTx reject never entered a block: no height, and nothing to verify.
    expect(r.height).toBeUndefined();
    expect(calls.some((c) => c.url.includes("/tx"))).toBe(false);
  });

  it("submitTxCommit reconciles a hash-only error through the gateway tx route", async () => {
    const client = makeGatewayClient();
    primeNextNonce(client);

    nextResponses.push(
      () =>
        new Response(
          JSON.stringify({
            status: "error",
            error:
              "timed out waiting for on-chain result; reconcile via txHash",
            txHash: "ABCD",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    nextResponses.push(
      () =>
        new Response(
          JSON.stringify({
            result: {
              height: "4821904",
              tx_result: {
                code: 0,
                log: "",
                events: [{ type: "order_placed", attributes: [] }],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const r = await client.submitTxCommit(placeOrder(client));

    expect(r.outcome).toBe("ok");
    expect(r.ok).toBe(true);
    expect(r.hash).toBe("ABCD");
    expect(r.height).toBe(4821904);
    expect(r.events).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe("http://test-gateway/v1/tx/ABCD");
  });

  it("submitTx starts a background verifier for a hash-only error", async () => {
    // A hash with no code is ambiguous, not a rejection: the tx may already be
    // in flight. Fire-and-forget submission must therefore keep its normal
    // background reconciliation rather than silently disabling it.
    const client = makeGatewayClient();
    primeNextNonce(client);

    nextResponses.push(
      () =>
        new Response(
          JSON.stringify({
            status: "error",
            error: "duplicate in-flight tx; reconcile via txHash",
            txHash: "ABCD",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    nextResponses.push(
      () =>
        new Response(
          JSON.stringify({
            result: {
              height: "4821905",
              tx_result: {
                code: 12,
                log: "insufficient margin",
                events: [],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const initial = await client.submitTx(placeOrder(client));

    expect(initial).toMatchObject({
      ok: false,
      outcome: "timeout",
      code: -1,
      hash: "ABCD",
    });
    expect(
      (client as unknown as { pendingVerifies: Set<unknown> }).pendingVerifies
        .size,
    ).toBe(1);

    const reconciled = await client.awaitPendingVerifies();

    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toMatchObject({
      ok: false,
      outcome: "engine",
      code: 12,
      hash: "ABCD",
      height: 4821905,
      log: "insufficient margin",
    });
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe("http://test-gateway/v1/tx/ABCD");
  });

  it("still polls when the gateway only acks CheckTx (pre-#90 gateway)", async () => {
    // Back-compat: an older gateway answers {status:"ok"} with no code/height.
    // The outcome is unknown, so the poll loop must still run — otherwise the
    // SDK would silently stop confirming inclusion against a deployment that
    // hasn't been upgraded.
    const client = makeGatewayClient();
    primeNextNonce(client);

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
              height: "77",
              tx_result: { code: 0, log: "", events: [] },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const r = await client.submitTxCommit(placeOrder(client));

    expect(r.ok).toBe(true);
    expect(r.height).toBe(77);
    expect(calls.some((c) => c.url.includes("/tx"))).toBe(true);
  });

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

// ---------------------------------------------------------------------------
// chain_id resolution (audit B4)
//
// Covers the four configurations of `opts.chainId` × `opts.allowUnbound`:
//   - explicit chainId          → used immediately, no /status fetch
//   - omitted, /status reachable → resolved + cached, identical to explicit
//   - omitted, /status down, allowUnbound=false → throws on ready()
//   - omitted, /status down, allowUnbound=true  → warns + falls back to UNBOUND
//
// The bug this guards against: pre-2026-05-12 the SDK silently signed with
// UNBOUND when no chainId was provided, which "worked" against an unbound
// engine and broke loudly the moment the engine bound chain_id at FFI
// (exchange#90). Lazy resolve removes the silent path.
// ---------------------------------------------------------------------------
describe("ExchangeClient chain_id resolution", () => {
  const originalFetch = globalThis.fetch;

  function statusResponse(network: string): Response {
    return new Response(JSON.stringify({ result: { node_info: { network } } }));
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("explicit opts.chainId binds eagerly and skips /status fetch", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const client = new ExchangeClient({
      gatewayUrl: "http://test-rpc",
      chainId: "proof-explicit",
    });
    await client.ready();
    expect(client.getChainId()).toEqual(chainIdFromString("proof-explicit"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("gateway path auto-resolves chain-id from /v1/status", async () => {
    const fetchSpy = vi.fn(async (url: RequestInfo | URL) => {
      expect(url.toString()).toBe("http://test-gateway/v1/status");
      return statusResponse("proof-via-gateway");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    // Default useGateway: true — resolves from the gateway's /v1/status proxy.
    const client = new ExchangeClient({ gatewayUrl: "http://test-gateway" });
    await client.ready();
    expect(client.getChainId()).toEqual(chainIdFromString("proof-via-gateway"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("auto-resolves from /status when opts.chainId omitted", async () => {
    const fetchSpy = vi.fn(async (url: RequestInfo | URL) => {
      expect(url.toString()).toBe("http://test-rpc/status");
      return statusResponse("proof-from-status");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const client = new ExchangeClient({
      useGateway: false,
      rpcUrl: "http://test-rpc",
    });
    await client.ready();
    expect(client.getChainId()).toEqual(chainIdFromString("proof-from-status"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Cached: a second ready() does not re-hit /status.
    await client.ready();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("throws when /status is down and allowUnbound is not set", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const client = new ExchangeClient({
      useGateway: false,
      rpcUrl: "http://test-rpc",
    });
    await expect(client.ready()).rejects.toThrow(
      /could not resolve chain_id from http:\/\/test-rpc\/status/,
    );
    expect(client.getChainId()).toBeNull();
  });

  it("falls back to UNBOUND_CHAIN_ID when allowUnbound is true and /status is down", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const client = new ExchangeClient({
      useGateway: false,
      rpcUrl: "http://test-rpc",
      allowUnbound: true,
    });
    await client.ready();
    expect(client.getChainId()).toEqual(UNBOUND_CHAIN_ID);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/UNBOUND_CHAIN_ID/);
  });

  it("concurrent submits share a single /status fetch", async () => {
    const fetchSpy = vi.fn(async () => statusResponse("proof-shared"));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const client = new ExchangeClient({
      useGateway: false,
      rpcUrl: "http://test-rpc",
    });
    await Promise.all([client.ready(), client.ready(), client.ready()]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries /status after a failure when allowUnbound is false", async () => {
    let attempt = 0;
    globalThis.fetch = vi.fn(async () => {
      attempt++;
      if (attempt === 1) throw new Error("transient");
      return statusResponse("proof-after-retry");
    }) as unknown as typeof fetch;

    const client = new ExchangeClient({
      useGateway: false,
      rpcUrl: "http://test-rpc",
    });
    await expect(client.ready()).rejects.toThrow();
    // First failure cleared the in-flight cache; a second call retries
    // instead of replaying the rejected promise forever.
    await client.ready();
    expect(client.getChainId()).toEqual(chainIdFromString("proof-after-retry"));
    expect(attempt).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// fetchChainId standalone helper
//
// Exported for offline tooling that doesn't go through ExchangeClient
// (gateway-side helpers, scripts that broadcast wire bytes directly, etc.).
// ---------------------------------------------------------------------------
describe("fetchChainId", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns chainIdFromString(network) on a valid /status response", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ result: { node_info: { network: "proof-ok" } } }),
      );
    }) as unknown as typeof fetch;
    const got = await fetchChainId("http://rpc");
    expect(got).toEqual(chainIdFromString("proof-ok"));
  });

  it("throws on non-2xx /status response", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response("nope", { status: 503 });
    }) as unknown as typeof fetch;
    await expect(fetchChainId("http://rpc")).rejects.toThrow(/HTTP 503/);
  });

  it("throws when /status payload is missing result.node_info.network", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({}));
    }) as unknown as typeof fetch;
    await expect(fetchChainId("http://rpc")).rejects.toThrow(
      /missing result\.node_info\.network/,
    );
  });
});

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
 * Chain endpoints (`/status`, `/block`, `/block_results`, `/tx`) must also
 * honour the gateway-only policy under the default `useGateway: true`. The
 * `useGateway: false` internal path keeps hitting the bare CometBFT RPC.
 */
describe("ExchangeClient chain-endpoint routing", () => {
  const originalFetch = globalThis.fetch;
  let calls: string[] = [];

  beforeEach(() => {
    calls = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(url.toString());
      return new Response(
        JSON.stringify({
          result: {
            sync_info: { latest_block_height: 7, latest_app_hash: "" },
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("default (useGateway) routes status through the gateway's /v1/status", async () => {
    const client = new ExchangeClient({
      rpcUrl: "http://test-rpc",
      gatewayUrl: "http://test-gateway",
      chainId: "test-chain",
    });
    await client.status();
    expect(calls).toEqual(["http://test-gateway/v1/status"]);
  });

  it("useGateway:false routes status to the direct rpcUrl", async () => {
    const client = new ExchangeClient({
      rpcUrl: "http://test-rpc",
      gatewayUrl: "http://test-gateway",
      useGateway: false,
      chainId: "test-chain",
    });
    await client.status();
    expect(calls).toEqual(["http://test-rpc/status"]);
  });
});

/**
 * `gatewayUrl` is the single source of truth. The direct-node URLs are
 * derived from it on the internal path: a local gateway on :9080 remaps to
 * the conventional node ports (26657 / 8080); a hosted gateway with no port
 * keeps the same host (the node sits behind it).
 */
describe("ExchangeClient endpoint derivation", () => {
  const originalFetch = globalThis.fetch;
  let calls: string[] = [];

  beforeEach(() => {
    calls = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(url.toString());
      return new Response(
        JSON.stringify({
          status: "ok",
          height: 1,
          result: {
            sync_info: { latest_block_height: 7, latest_app_hash: "" },
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("derives node ports from a local :9080 gateway on the direct path", async () => {
    const client = new ExchangeClient({
      gatewayUrl: "http://localhost:9080",
      useGateway: false,
      chainId: "test-chain",
    });
    await client.queryHealth();
    await client.status();
    expect(calls).toEqual([
      "http://localhost:8080/v1/health",
      "http://localhost:26657/status",
    ]);
  });

  it("keeps the same host for a hosted gateway with no port", async () => {
    const client = new ExchangeClient({
      gatewayUrl: "https://api.dev.proof.trade",
      useGateway: false,
      chainId: "test-chain",
    });
    await client.queryHealth();
    await client.status();
    expect(calls).toEqual([
      "https://api.dev.proof.trade/v1/health",
      "https://api.dev.proof.trade/status",
    ]);
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
