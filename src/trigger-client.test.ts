import { Encoder } from "@msgpack/msgpack";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExchangeClient } from "./client.js";
import { generateKeypair } from "./crypto.js";

function base64(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
}

describe("ExchangeClient trigger contract", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("fills owner in Set/Cancel convenience builders", async () => {
    const client = new ExchangeClient({ gatewayUrl: "http://g", chainId: "c" });
    client.setPrivateKey(generateKeypair().privateKey);
    const submit = vi
      .spyOn(client, "submitTx")
      .mockResolvedValue({ ok: true, outcome: "success", code: 0 });

    await client.setPositionTriggers({
      market: 7,
      expectedPositionEpoch: 3n,
      stopLoss: { triggerPrice: 95_000n, maxSlippageBps: 75 },
    });
    await client.cancelPositionTriggers(7, 3n);

    expect(submit.mock.calls[0][0]).toMatchObject({
      type: "SetPositionTriggers",
      data: { market: 7, expectedPositionEpoch: 3n },
    });
    expect(submit.mock.calls[1][0]).toMatchObject({
      type: "CancelPositionTriggers",
      data: { market: 7, expectedPositionEpoch: 3n },
    });
    expect(
      (submit.mock.calls[0][0] as { data: { owner: Uint8Array } }).data.owner,
    ).toEqual(client.getAddress());
  });

  it("preserves an explicit delegated owner instead of replacing it with signer", async () => {
    const client = new ExchangeClient({ gatewayUrl: "http://g", chainId: "c" });
    client.setPrivateKey(generateKeypair().privateKey);
    const signer = client.getAddress();
    const delegatedOwner = new Uint8Array(20).fill(0x7a);
    expect(delegatedOwner).not.toEqual(signer);
    const submit = vi
      .spyOn(client, "submitTx")
      .mockResolvedValue({ ok: true, outcome: "success", code: 0 });

    await client.setPositionTriggers({
      market: 7,
      owner: delegatedOwner,
      expectedPositionEpoch: 3n,
      stopLoss: { triggerPrice: 95_000n, maxSlippageBps: 75 },
    });
    await client.cancelPositionTriggers(7, 3n, delegatedOwner);

    expect(
      (submit.mock.calls[0][0] as { data: { owner: Uint8Array } }).data.owner,
    ).toBe(delegatedOwner);
    expect(
      (submit.mock.calls[1][0] as { data: { owner: Uint8Array } }).data.owner,
    ).toBe(delegatedOwner);
  });

  it.each([
    [undefined, "http://gateway/v1/triggers/"],
    [false, "http://node/v1/triggers/"],
  ] as const)(
    "reads current owner triggers through the configured node/gateway route",
    async (useGateway, prefix) => {
      const owner = "ab".repeat(20);
      const payload = new Encoder({ useBigInt64: true }).encode([]);
      const calls: string[] = [];
      globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
        calls.push(url.toString());
        return new Response(JSON.stringify({ data: base64(payload) }));
      }) as unknown as typeof fetch;
      const client = new ExchangeClient({
        gatewayUrl: "http://gateway",
        apiUrl: "http://node",
        useGateway,
        chainId: "c",
      });
      await expect(client.queryPositionTriggers(owner)).resolves.toEqual([]);
      expect(calls).toEqual([`${prefix}${owner}`]);
    },
  );

  it.each([
    [undefined, "http://gateway/v1/triggers/markets"],
    [false, "http://node/v1/triggers/markets"],
  ] as const)(
    "reads trigger-market policy through the configured strict proxy",
    async (useGateway, expectedUrl) => {
      const payload = new Encoder({ useBigInt64: true }).encode([
        [7, [[1n, true, 250, 5_000n, 1_000n, 32n], null]],
      ]);
      const calls: string[] = [];
      globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
        calls.push(url.toString());
        return new Response(JSON.stringify({ data: base64(payload) }));
      }) as unknown as typeof fetch;
      const client = new ExchangeClient({
        gatewayUrl: "http://gateway",
        apiUrl: "http://node",
        useGateway,
        chainId: "c",
      });
      await expect(client.queryTriggerMarketConfigs()).resolves.toMatchObject([
        { market: 7, state: { current: { maxTriggerSlippageBps: 250 } } },
      ]);
      expect(calls).toEqual([expectedUrl]);
    },
  );

  it("fails closed when trigger-market policy lacks the encoded envelope", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("{}"),
    ) as unknown as typeof fetch;
    const client = new ExchangeClient({ gatewayUrl: "http://g", chainId: "c" });
    await expect(client.queryTriggerMarketConfigs()).rejects.toThrow(
      /missing encoded data/,
    );
  });

  it("parses trigger status heights losslessly and propagates fail-closed 503", async () => {
    const client = new ExchangeClient({ gatewayUrl: "http://g", chainId: "c" });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          '{"finalized_height":9007199254740993,"admission_height":9007199254740994,"actions_active":true}',
        ),
    ) as unknown as typeof fetch;
    await expect(client.queryTriggerStatus()).resolves.toEqual({
      finalizedHeight: 9_007_199_254_740_993n,
      admissionHeight: 9_007_199_254_740_994n,
      actionsActive: true,
    });

    globalThis.fetch = vi.fn(
      async () =>
        new Response('{"error":"trigger activation status unavailable"}', {
          status: 503,
        }),
    ) as unknown as typeof fetch;
    await expect(client.queryTriggerStatus()).rejects.toThrow(
      /trigger activation status unavailable/,
    );
  });

  it("routes both immutable history surfaces through gateway only", async () => {
    const owner = "ab".repeat(20);
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(url.toString());
      if (url.toString().includes("trigger-markets")) {
        return new Response(
          JSON.stringify({ trigger_market_events: [], next_cursor: "" }),
        );
      }
      return new Response(
        JSON.stringify({ trigger_events: [], next_cursor: "opaque-token" }),
      );
    }) as unknown as typeof fetch;
    const client = new ExchangeClient({
      gatewayUrl: "http://gateway",
      apiUrl: "http://node",
      useGateway: false,
      chainId: "c",
    });

    await expect(
      client.queryPositionTriggerHistory(owner, {
        market: 7,
        from: 1_700_000_000_001n,
        to: "2026-04-19T20:51:00Z",
        limit: 2,
        cursor: "opaque+/=token",
      }),
    ).resolves.toEqual({ triggerEvents: [], nextCursor: "opaque-token" });
    await expect(
      client.queryTriggerMarketHistory(7, { limit: 1 }),
    ).resolves.toEqual({ triggerMarketEvents: [], nextCursor: "" });

    const ownerUrl = new URL(calls[0]);
    expect(ownerUrl.origin + ownerUrl.pathname).toBe(
      `http://gateway/v1/history/triggers/${owner}`,
    );
    expect(Object.fromEntries(ownerUrl.searchParams)).toEqual({
      from: "1700000000001",
      to: "2026-04-19T20:51:00Z",
      limit: "2",
      cursor: "opaque+/=token",
      market: "7",
    });
    expect(calls[1]).toBe(
      "http://gateway/v1/history/trigger-markets/7?limit=1",
    );
    expect(calls.every((url) => !url.startsWith("http://node"))).toBe(true);
  });

  it("fails history before transport on malformed route filters", async () => {
    const fetch = vi.fn();
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    const client = new ExchangeClient({ gatewayUrl: "http://g", chainId: "c" });
    await expect(client.queryTriggerMarketHistory(-1)).rejects.toThrow(
      /market/,
    );
    await expect(
      client.queryPositionTriggerHistory("ab".repeat(20), { cursor: "" }),
    ).rejects.toThrow(/cursor/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
