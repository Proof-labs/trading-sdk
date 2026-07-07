import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ExchangeClient, fetchChainId } from "./client.js";
import { UNBOUND_CHAIN_ID, chainIdFromString } from "./crypto.js";

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
