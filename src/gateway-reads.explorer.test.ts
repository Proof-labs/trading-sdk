import { describe, expect, it, vi } from "vitest";
import { ExchangeClient } from "./index.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("indexed Explorer gateway reads", () => {
  it("preserves status, block/transaction envelopes and opaque pagination", async () => {
    const hash = "AB".repeat(32);
    const block = {
      height: 2243588,
      hash,
      block_time: "2026-10-05T12:35:03.927864Z",
      parent_hash: null,
      proposer: "CD".repeat(20),
      num_txs: 1,
    };
    const cursor = "opaque+/=?&cursor";
    const bodies = [
      {
        ok: true,
        schema_version: { latest: 44 },
        ingest: {
          stale: false,
          block_lag_seconds: 271,
          newest_height: 2244365,
        },
      },
      { blocks: [block], next_cursor: cursor },
      // The last page ends with an empty-string cursor, never null.
      { blocks: [], next_cursor: "" },
      { ...block, transactions: [{ hash, tx_index: 0, code: 12 }] },
      {
        hash,
        block_hash: hash,
        block_height: block.height,
        block_time: block.block_time,
        tx_index: 0,
        code: 12,
        raw_tx: "AQID",
      },
    ];
    const responses = bodies.map((body) => json(body));
    let index = 0;
    const fetch = vi.fn(
      async (_url: string, _init?: RequestInit) => responses[index++],
    );
    const reads = new ExchangeClient({
      gatewayUrl: "https://gateway.example/",
    }).reads({ fetch });
    const signal = new AbortController().signal;
    const calls = [
      () => reads.historyStatus({ signal }),
      () => reads.historyBlocks({ limit: 100 }, { signal }),
      () => reads.historyBlocks({ limit: 100, cursor }, { signal }),
      () => reads.historyBlock(block.height, { signal }),
      () => reads.historyTransaction(hash, { signal }),
    ];
    for (const [i, call] of calls.entries()) {
      const response = await call();
      expect(response).toBe(responses[i]);
      expect(await response.json()).toEqual(bodies[i]);
      expect(fetch.mock.calls[i][1]).toEqual(
        i === 0
          ? { method: "GET", cache: "no-store", signal }
          : { method: "GET", signal },
      );
    }
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://gateway.example/v1/history/status",
      "https://gateway.example/v1/history/blocks?limit=100",
      `https://gateway.example/v1/history/blocks?limit=100&cursor=${encodeURIComponent(cursor)}`,
      `https://gateway.example/v1/history/blocks/${block.height}`,
      `https://gateway.example/v1/history/txs/${hash}`,
    ]);
  });

  it("keeps same-origin reads and encodes detail identifiers as a single path segment", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json({}));
    const reads = new ExchangeClient({ gatewayUrl: "" }).reads({ fetch });
    await reads.historyBlocks();
    await reads.historyBlock("AB".repeat(32));
    await reads.historyTransaction("a/b?x=1#fragment");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "/v1/history/blocks",
      `/v1/history/blocks/${"AB".repeat(32)}`,
      "/v1/history/txs/a%2Fb%3Fx%3D1%23fragment",
    ]);
  });

  it.each([400, 404, 429, 503])(
    "preserves HTTP %s without replacing it with a mock or empty page",
    async (status) => {
      const body = {
        error: "indexer_unavailable",
        errorCode: "INDEXER_UNAVAILABLE",
      };
      const response = json(body, status);
      const fetch = vi.fn(async () => response);
      const reads = new ExchangeClient().reads({ fetch });
      for (const call of [
        () => reads.historyStatus(),
        () => reads.historyBlocks(),
        () => reads.historyBlock(1),
        () => reads.historyTransaction("AB".repeat(32)),
      ]) {
        await expect(call()).rejects.toMatchObject({
          name: "GatewayHttpError",
          status,
          response,
        });
      }
      expect(await response.json()).toEqual(body);
    },
  );

  it("does not fetch pre-aborted reads and propagates in-flight cancellation", async () => {
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const reads = new ExchangeClient().reads({ fetch });
    const signal = AbortSignal.abort();
    for (const call of [
      () => reads.historyStatus({ signal }),
      () => reads.historyBlocks({}, { signal }),
      () => reads.historyBlock(1, { signal }),
      () => reads.historyTransaction("AB", { signal }),
    ])
      await expect(call()).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
    const controller = new AbortController();
    const pending = reads.historyBlocks({}, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
