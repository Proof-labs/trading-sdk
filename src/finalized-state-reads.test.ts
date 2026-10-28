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
const OWNER = "04".repeat(20);
const FINANCIAL_SELECTION = { markets: [7], owners: [OWNER] };
function financial(format: 1 | 3 = 1) {
  return {
    data: Buffer.from(
      encode(
        [
          format,
          H,
          1234,
          [
            [
              Array(20).fill(4),
              20,
              null,
              null,
              null,
              [[Array(20).fill(4), 7, "Buy", 100, 2, -3]],
            ],
          ],
          [[7, 0, 2, 1, 2, [], 1000, 100, 9, -1, 1200, null]],
          null,
          [[0, 17]],
          ...(format === 1 ? [null] : []),
        ],
        { useBigInt64: true },
      ),
    ).toString("base64"),
    witness: markets().witness,
  };
}
describe("opt-in finalized financial facts", () => {
  it("binds current format-3 financial facts to the same finalized witness", async () => {
    const state = await client(
      financial(3),
    ).client.queryFinalizedFinancialState(FINANCIAL_SELECTION);
    expect(state.format).toBe(3);
    expect(state).not.toHaveProperty("plp");
    expect(state.witness.height).toBe(state.finalizedHeight);
    expect(state.witness.finalizedBlockTimeMs).toBe(state.finalizedTimeMs);
    expect(state.insurancePools).toEqual([{ pool: 0, balance: 17n }]);
  });
  it("preserves existing financial amounts and binds the exact height and time", async () => {
    const f = client(financial());
    const state =
      await f.client.queryFinalizedFinancialState(FINANCIAL_SELECTION);
    expect(state.finalizedHeight).toBe(H);
    expect(state.finalizedTimeMs).toBe(1234n);
    expect(state.witness.height).toBe(H);
    expect(state.accounts[0].balance).toBe(20n);
    expect(state.accounts[0].positions[0].lastFundingIndex).toBe(-3n);
    expect(state.markets[0].cumulativeFunding).toBe(9n);
    expect(state.insurancePools[0].balance).toBe(17n);
    expect(String(f.transport.mock.calls[0][0])).toBe(
      `https://gateway.example/v1/financial/state?markets=7&owners=${OWNER}&witness=1`,
    );
    expect(state).not.toHaveProperty("equity");
  });
  it("legacy API still requests and accepts only the legacy envelope", async () => {
    const f = client({ data: financial().data });
    expect(
      (await f.client.queryFinancialState(FINANCIAL_SELECTION)).finalizedHeight,
    ).toBe(H);
    expect(String(f.transport.mock.calls[0][0])).not.toContain("witness");
    await expect(
      client(financial()).client.queryFinancialState(FINANCIAL_SELECTION),
    ).rejects.toThrow("response wrapper");
  });
  it.each([
    "missing",
    "height",
    "time",
    "hash",
    "extra",
    "payload",
    "selection",
  ])("refuses missing or inconsistent financial witness: %s", async (field) => {
    const b = financial();
    if (field === "missing") delete (b as { witness?: unknown }).witness;
    if (field === "height") b.witness.height = "42";
    if (field === "time") b.witness.finalizedBlockTimeMs = "1235";
    if (field === "hash") b.witness.appHash = "00".repeat(32);
    if (field === "extra") Object.assign(b, { alternate: b.witness });
    if (field === "payload")
      b.data = Buffer.from([0x91, 0x01]).toString("base64");
    const selection =
      field === "selection"
        ? { markets: [8], owners: [OWNER] }
        : FINANCIAL_SELECTION;
    await expect(
      client(b).client.queryFinalizedFinancialState(selection),
    ).rejects.toThrow();
  });
  it("captures the exact selection before awaiting the transport", async () => {
    const selection = { markets: [7], owners: [OWNER] };
    const f = client(financial());
    const pending = f.client.queryFinalizedFinancialState(selection);
    selection.markets[0] = 8;
    selection.owners[0] = "05".repeat(20);
    expect((await pending).accounts[0].owner).toBe(OWNER);
  });
  it("refuses duplicate fields, cancellation, oversize and a stalled financial body", async () => {
    const raw = JSON.stringify(financial()).replace(
      '"height":',
      '"height":"42","height":',
    );
    await expect(
      client({}, () => new Response(raw)).client.queryFinalizedFinancialState(
        FINANCIAL_SELECTION,
      ),
    ).rejects.toThrow("Duplicate");
    await expect(
      client(
        {},
        () => new Response("x".repeat(1024 * 1024 + 1)),
      ).client.queryFinalizedFinancialState(FINANCIAL_SELECTION),
    ).rejects.toThrow("byte limit");
    await expect(
      client(
        {},
        () => new Response(new ReadableStream({ start() {} })),
      ).client.queryFinalizedFinancialState(FINANCIAL_SELECTION, {
        timeoutMs: 10,
      }),
    ).rejects.toThrow();
    const abort = new AbortController();
    abort.abort();
    const f = client(financial());
    await expect(
      f.client.queryFinalizedFinancialState(FINANCIAL_SELECTION, {
        signal: abort.signal,
      }),
    ).rejects.toThrow();
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("has no unpinned or legacy-response fallback", async () => {
    await expect(
      new ExchangeClient({
        gatewayUrl: "https://gateway.example",
      }).queryFinalizedFinancialState(FINANCIAL_SELECTION),
    ).rejects.toThrow("pinned");
    await expect(
      client({ data: financial().data }).client.queryFinalizedFinancialState(
        FINANCIAL_SELECTION,
      ),
    ).rejects.toThrow();
    const f = client({}, () => new Response("unavailable", { status: 503 }));
    await expect(
      f.client.queryFinalizedFinancialState(FINANCIAL_SELECTION),
    ).rejects.toThrow();
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
});
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
