import { describe, expect, it, vi } from "vitest";
import { encode } from "@msgpack/msgpack";
import { ExchangeClient } from "./client.js";
import { chainIdFromString } from "./crypto.js";
import type { ExchangeHttpTransport } from "./http-transport.js";

const CHAIN = "state-read-test-1";
const H = 9007199254740993n;
function block() {
  return {
    jsonrpc: "2.0",
    id: -1,
    result: {
      block_id: { hash: "ab".repeat(32) },
      block: {
        header: {
          height: H.toString(),
          chain_id: CHAIN,
          time: "2026-10-26T10:00:00.123456789Z",
          last_block_id: { hash: "cd".repeat(32) },
          app_hash: "ef".repeat(32),
        },
        data: { txs: null },
      },
    },
  };
}
function markets() {
  return {
    data: Buffer.from(
      encode([Array.from(chainIdFromString(CHAIN)), H, [], []], {
        useBigInt64: true,
      }),
    ).toString("base64"),
    witness: {
      version: 1,
      nodeId: "ab".repeat(20),
      height: H.toString(),
      finalizedBlockTimeMs: "1234",
      appHash: "ef".repeat(32),
    },
  };
}
function client(body: unknown, response?: () => Response) {
  const transport = vi.fn<ExchangeHttpTransport>(
    async () => response?.() ?? new Response(JSON.stringify(body)),
  );
  return {
    transport,
    client: new ExchangeClient({
      gatewayUrl: "https://gateway.example",
      chainId: CHAIN,
      useGateway: false,
      httpTransport: transport,
    }),
  };
}
describe("bounded finalized state and header reads", () => {
  it("preserves exact heights and nanosecond header time without direct-node fallback", async () => {
    const f = client(block());
    expect(await f.client.queryBlockHeader(H)).toEqual({
      height: H,
      chainId: CHAIN,
      hash: "AB".repeat(32),
      parentHash: "CD".repeat(32),
      appHash: "EF".repeat(32),
      time: "2026-10-26T10:00:00.123456789Z",
    });
    expect(String(f.transport.mock.calls[0][0])).toBe(
      `https://gateway.example/v1/block?height=${H}`,
    );
  });
  it("decodes actual MessagePack market inventory and preserves mandatory witness", async () => {
    const f = client(markets());
    expect(await f.client.queryFinalizedMarketsSnapshot()).toMatchObject({
      height: H,
      markets: [],
      events: [],
      witness: {
        version: 1,
        nodeId: "ab".repeat(20),
        height: H,
        finalizedBlockTimeMs: 1234n,
        appHash: "ef".repeat(32),
      },
    });
    expect(String(f.transport.mock.calls[0][0])).toBe(
      "https://gateway.example/v1/markets-snapshot",
    );
  });
  it.each([0n, -1n, 1n << 63n, 2 as unknown as bigint])(
    "refuses invalid requested height %s before transport",
    async (height) => {
      const f = client(block());
      await expect(f.client.queryBlockHeader(height)).rejects.toThrow();
      expect(f.transport).not.toHaveBeenCalled();
    },
  );
  it.each(["chain", "height", "time", "parent", "appHash", "rpc"])(
    "refuses malformed header %s",
    async (field) => {
      const b = block();
      if (field === "chain") b.result.block.header.chain_id = "wrong-chain";
      if (field === "height") b.result.block.header.height = "9007199254740992";
      if (field === "time") b.result.block.header.time = "2026-02-30T00:00:00Z";
      if (field === "parent") b.result.block.header.last_block_id.hash = "";
      if (field === "appHash") b.result.block.header.app_hash = "bad";
      if (field === "rpc") b.jsonrpc = "1.0";
      await expect(client(b).client.queryBlockHeader(H)).rejects.toThrow();
    },
  );
  it.each(["missing", "height", "node", "time", "appHash", "chain"])(
    "refuses malformed market witness %s",
    async (field) => {
      const b = markets();
      if (field === "missing") delete (b as { witness?: unknown }).witness;
      if (field === "height") b.witness.height = "42";
      if (field === "node") b.witness.nodeId = "00".repeat(20);
      if (field === "time") b.witness.finalizedBlockTimeMs = "0";
      if (field === "appHash") b.witness.appHash = "AB".repeat(32);
      if (field === "chain")
        b.data = Buffer.from(
          encode([Array.from(chainIdFromString("other")), H, [], []], {
            useBigInt64: true,
          }),
        ).toString("base64");
      await expect(
        client(b).client.queryFinalizedMarketsSnapshot(),
      ).rejects.toThrow();
    },
  );
  it("requires pinned chain and never treats 404 as empty state", async () => {
    const unpinned = new ExchangeClient({
      gatewayUrl: "https://gateway.example",
    });
    await expect(unpinned.queryBlockHeader(1n)).rejects.toThrow("pinned");
    await expect(unpinned.queryFinalizedMarketsSnapshot()).rejects.toThrow(
      "pinned",
    );
    await expect(
      client(
        {},
        () => new Response("pruned", { status: 404 }),
      ).client.queryBlockHeader(H),
    ).rejects.toThrow();
  });
  it("bounds oversized and stalled bodies and honors cancellation", async () => {
    const f = client({}, () => new Response("x".repeat(1024 * 1024 + 1)));
    await expect(f.client.queryBlockHeader(H)).rejects.toThrow("byte limit");
    const stalled = client(
      {},
      () => new Response(new ReadableStream({ start() {} })),
    );
    await expect(
      stalled.client.queryBlockHeader(H, { timeoutMs: 10 }),
    ).rejects.toThrow();
    const abort = new AbortController();
    abort.abort();
    await expect(
      client(markets()).client.queryFinalizedMarketsSnapshot({
        signal: abort.signal,
      }),
    ).rejects.toThrow();
  });
  it("rejects nested duplicate witness/header fields", async () => {
    const raw = JSON.stringify(markets()).replace(
      '"height":',
      '"height":"42","height":',
    );
    await expect(
      client(
        {},
        () => new Response(raw),
      ).client.queryFinalizedMarketsSnapshot(),
    ).rejects.toThrow("Duplicate");
  });
});
