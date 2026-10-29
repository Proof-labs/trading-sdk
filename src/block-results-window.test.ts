import { describe, expect, it, vi } from "vitest";
import { ExchangeClient } from "./client.js";
import { signAndEncode } from "./codec.js";
import { chainIdFromString } from "./crypto.js";
import type { ExchangeHttpTransport } from "./http-transport.js";
import { Side, TimeInForce } from "./types.js";

const CHAIN = "block-window-test-1";
const T = Date.parse("2026-10-26T00:00:00Z");
const hex = (n: number) => n.toString(16).padStart(64, "0");
const base64 = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
const appHash = (height: number) =>
  base64(Uint8Array.from(hex(height).match(/../g)!, (v) => parseInt(v, 16)));
const rpc = <T>(result: T) => ({ jsonrpc: "2.0", id: -1, result });

function fixture(first = 100) {
  const signedBytes = signAndEncode(
    chainIdFromString(CHAIN),
    {
      type: "PlaceOrder",
      data: {
        owner: new Uint8Array(20).fill(8),
        market: 1,
        side: Side.Sell,
        price: 100n,
        quantity: 2n,
        timeInForce: TimeInForce.Ioc,
        reduceOnly: true,
      },
    },
    100n,
    new Uint8Array(32).fill(9),
  );
  const block = (height: number) =>
    rpc({
      block_id: { hash: hex(height) },
      block: {
        header: {
          height: `${height}`,
          chain_id: CHAIN,
          time: new Date(T + (height - 99) * 1000).toISOString(),
          last_block_id: { hash: hex(height - 1) },
          app_hash: hex(height - 1),
        },
        data: { txs: [base64(signedBytes)] as string[] | null },
      },
    });
  // validator/rpc/core/types/responses.go: ResultBlockResults has AppHash []byte
  // and FinalizeBlockEvents []abci.Event, neither tagged omitempty. Its
  // libs/json/encoder.go encodes byte slices as base64 and nil slices as null.
  const results = (height: number) =>
    rpc({
      height: `${height}`,
      app_hash: appHash(height),
      txs_results: [
        {
          code: height === 102 ? 12 : 0,
          events: [
            {
              type: "trade_executed",
              attributes: [
                { key: "fill_id", value: `${height}` },
                { key: "maker_owner", value: "08".repeat(20) },
              ],
            },
            {
              type: "future_engine_event",
              attributes: [{ key: "opaque", value: "AA==\u0000" }],
            },
          ],
        },
      ] as
        | {
            code: number;
            events: {
              type: string;
              attributes: { key: string; value: string }[];
            }[];
          }[]
        | null,
      finalize_block_events: [
        {
          type: "trade_executed",
          attributes: [{ key: "fill_id", value: `${height + 1000}` }],
        },
      ] as
        { type: string; attributes: { key: string; value: string }[] }[] | null,
    });
  const blocks = new Map<number, ReturnType<typeof block>>();
  const executions = new Map<number, ReturnType<typeof results>>();
  for (let height = first; height <= 103; height++) {
    blocks.set(height, block(height));
    executions.set(height, results(height));
  }
  const transport = vi.fn<ExchangeHttpTransport>(async (url) => {
    const parsed = new URL(url);
    const height = Number(parsed.searchParams.get("height"));
    const value =
      parsed.pathname === "/v1/block_results"
        ? executions.get(height)
        : blocks.get(height);
    if (!value) return new Response("pruned", { status: 404 });
    return new Response(JSON.stringify(value));
  });
  const client = new ExchangeClient({
    gatewayUrl: "https://gateway.example",
    chainId: CHAIN,
    useGateway: false,
    httpTransport: transport,
  });
  const selection = {
    fromMs: T + 1500,
    toMs: T + 2500,
    throughHeight: 102n,
    maxHeights: 3,
  };
  return { blocks, executions, transport, client, selection, signedBytes };
}

describe("bounded trusted-gateway block/results windows", () => {
  it("represents the empty genesis app hash as null, not a synthetic hash", async () => {
    const f = fixture(1);
    const genesis = f.blocks.get(1)!.result.block.header;
    genesis.app_hash = "";
    genesis.last_block_id.hash = "";
    expect(await f.client.reads().evidence.blockHeader(1n)).toMatchObject({
      height: 1n,
      appHash: null,
      parentHash: null,
    });
  });
  it("allows callers to lower aggregate budgets but not raise their ceilings", async () => {
    const f = fixture();
    await expect(
      f.client
        .reads()
        .evidence.blockResultsWindow({ ...f.selection, maxTransactions: 1 }),
    ).rejects.toMatchObject({ kind: "limit" });
    for (const limits of [
      { maxDecodedBytes: 8 * 1024 * 1024 + 1 },
      { maxTransactions: 10001 },
      { maxEvents: 16385 },
      { maxAttributes: 65537 },
      { maxEvents: 0 },
    ]) {
      f.transport.mockClear();
      await expect(
        f.client
          .reads()
          .evidence.blockResultsWindow({ ...f.selection, ...limits }),
      ).rejects.toMatchObject({ kind: "configuration" });
      expect(f.transport).not.toHaveBeenCalled();
    }
  });
  it("reads every transaction and system event with exact coordinates and both window boundaries", async () => {
    const f = fixture();
    const window = await f.client
      .reads()
      .evidence.blockResultsWindow(f.selection);
    expect(window).toMatchObject({
      source: "trusted-gateway",
      fromMs: T + 1500,
      toMs: T + 2500,
      fromHeight: 100n,
      throughHeight: 102n,
      anchor: { height: 103n, hash: hex(103).toUpperCase() },
    });
    expect(window.blocks.map((block) => block.header.height)).toEqual([
      100n,
      101n,
      102n,
    ]);
    expect(window.blocks[1].transactions[0].signedBytes).toEqual(f.signedBytes);
    expect(window.blocks[1].transactions[0].events).toEqual(
      f.executions.get(101)!.result.txs_results![0].events,
    );
    expect(window.blocks[1].finalizeBlockEvents).toEqual(
      f.executions.get(101)!.result.finalize_block_events,
    );
    expect(window.blocks[2].transactions[0].code).toBe(12);
    expect(window.blocks[1].transactions[0].hash).toBe(
      window.blocks[2].transactions[0].hash,
    );
    expect(
      f.transport.mock.calls.map(
        ([url]) => new URL(url).pathname + new URL(url).search,
      ),
    ).toEqual([
      "/v1/block?height=103",
      "/v1/block?height=102",
      "/v1/block_results?height=102",
      "/v1/block?height=101",
      "/v1/block_results?height=101",
      "/v1/block?height=100",
      "/v1/block_results?height=100",
    ]);
  });
  it("accepts explicit empty block/results slices, preserving system events without transactions", async () => {
    const f = fixture();
    f.blocks.get(100)!.result.block.data.txs = null;
    f.executions.get(100)!.result.txs_results = null;
    f.executions.get(102)!.result.finalize_block_events = null;
    const window = await f.client
      .reads()
      .evidence.blockResultsWindow(f.selection);
    expect(window.blocks[0].transactions).toEqual([]);
    expect(window.blocks[0].finalizeBlockEvents).toHaveLength(1);
    expect(window.blocks[2].finalizeBlockEvents).toEqual([]);
  });
  it.each([
    [
      "chain",
      (f: ReturnType<typeof fixture>) => {
        f.blocks.get(101)!.result.block.header.chain_id = "wrong";
      },
    ],
    [
      "header height",
      (f: ReturnType<typeof fixture>) => {
        f.blocks.get(101)!.result.block.header.height = "100";
      },
    ],
    [
      "parent continuity",
      (f: ReturnType<typeof fixture>) => {
        f.blocks.get(102)!.result.block.header.last_block_id.hash = hex(88);
      },
    ],
    [
      "time continuity",
      (f: ReturnType<typeof fixture>) => {
        f.blocks.get(101)!.result.block.header.time = new Date(
          T + 5000,
        ).toISOString();
      },
    ],
    [
      "results height",
      (f: ReturnType<typeof fixture>) => {
        f.executions.get(101)!.result.height = "100";
      },
    ],
    [
      "post-state hash",
      (f: ReturnType<typeof fixture>) => {
        f.executions.get(101)!.result.app_hash = appHash(88);
      },
    ],
    [
      "truncated results",
      (f: ReturnType<typeof fixture>) => {
        f.executions.get(101)!.result.txs_results = [];
      },
    ],
    [
      "null nonempty results",
      (f: ReturnType<typeof fixture>) => {
        f.executions.get(101)!.result.txs_results = null;
      },
    ],
    [
      "missing results",
      (f: ReturnType<typeof fixture>) => {
        Reflect.deleteProperty(f.executions.get(101)!.result, "txs_results");
      },
    ],
    [
      "missing system events",
      (f: ReturnType<typeof fixture>) => {
        Reflect.deleteProperty(
          f.executions.get(101)!.result,
          "finalize_block_events",
        );
      },
    ],
    [
      "null tx result",
      (f: ReturnType<typeof fixture>) => {
        Object.assign(f.executions.get(101)!.result, { txs_results: [null] });
      },
    ],
    [
      "missing transactions",
      (f: ReturnType<typeof fixture>) => {
        Reflect.deleteProperty(f.blocks.get(101)!.result.block.data, "txs");
      },
    ],
    [
      "malformed event",
      (f: ReturnType<typeof fixture>) => {
        Object.assign(f.executions.get(101)!.result, {
          finalize_block_events: [{}],
        });
      },
    ],
  ])(
    "rejects %s rather than returning partial coverage",
    async (_name, mutate) => {
      const f = fixture();
      mutate(f);
      await expect(
        f.client.reads().evidence.blockResultsWindow(f.selection),
      ).rejects.toMatchObject({ name: "GatewayReadError" });
    },
  );
  it("refuses incomplete catch-up, pruned heights and exhausted height budgets", async () => {
    const f = fixture();
    await expect(
      f.client
        .reads()
        .evidence.blockResultsWindow({ ...f.selection, toMs: T + 3500 }),
    ).rejects.toThrow("source has not reached window end");
    await expect(
      f.client
        .reads()
        .evidence.blockResultsWindow({ ...f.selection, maxHeights: 2 }),
    ).rejects.toThrow("height budget");
    f.executions.delete(101);
    await expect(
      f.client.reads().evidence.blockResultsWindow(f.selection),
    ).rejects.toThrow();
  });
  it("honors nanosecond boundary ordering without rounding into a neighboring window", async () => {
    const f = fixture();
    f.blocks.get(101)!.result.block.header.time =
      "2026-10-26T00:00:01.500000001Z";
    const window = await f.client
      .reads()
      .evidence.blockResultsWindow(f.selection);
    expect(window.fromHeight).toBe(100n);
    f.blocks.get(101)!.result.block.header.time =
      "2026-10-26T00:00:01.499999999Z";
    expect(
      (await f.client.reads().evidence.blockResultsWindow(f.selection))
        .fromHeight,
    ).toBe(101n);
  });
  it("captures request fields before asynchronous reads", async () => {
    const f = fixture();
    const pending = f.client.reads().evidence.blockResultsWindow(f.selection);
    f.selection.fromMs = 0;
    f.selection.toMs = 1;
    f.selection.throughHeight = 1n;
    expect((await pending).throughHeight).toBe(102n);
  });
  it("requires a chain pin and rejects invalid resource or window inputs without I/O", async () => {
    const f = fixture();
    await expect(
      new ExchangeClient({
        httpTransport: f.transport,
      })
        .reads()
        .evidence.blockResultsWindow(f.selection),
    ).rejects.toThrow("pinned chainId");
    for (const selection of [
      { ...f.selection, maxHeights: 0 },
      { ...f.selection, maxHeights: 129 },
      { ...f.selection, throughHeight: 0n },
      { ...f.selection, throughHeight: (1n << 63n) - 1n },
      { ...f.selection, fromMs: 1.5 },
      { ...f.selection, fromMs: f.selection.toMs },
    ])
      await expect(
        f.client.reads().evidence.blockResultsWindow(selection),
      ).rejects.toThrow();
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("shares a cancellable deadline across all requests", async () => {
    const f = fixture();
    let clock = 100;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const implementation = f.transport.getMockImplementation()!;
    f.transport.mockImplementation(async (...args) => {
      clock += 3;
      return implementation(...args);
    });
    try {
      await expect(
        f.client
          .reads()
          .evidence.blockResultsWindow(f.selection, { timeoutMs: 12 }),
      ).rejects.toThrow(/deadline/);
      expect(f.transport.mock.calls.length).toBeLessThan(7);
    } finally {
      spy.mockRestore();
    }
    const before = f.transport.mock.calls.length;
    await expect(
      f.client.reads().evidence.blockResultsWindow(f.selection, {
        signal: AbortSignal.abort(new Error("cancelled")),
      }),
    ).rejects.toThrow("cancelled");
    expect(f.transport).toHaveBeenCalledTimes(before);
  });
  it("bounds aggregate decoded payload even when every individual response fits", async () => {
    const f = fixture(90);
    for (const block of f.blocks.values())
      Object.assign(block, { padding: "x".repeat(900_000) });
    for (const result of f.executions.values())
      Object.assign(result, { padding: "x".repeat(900_000) });
    await expect(
      f.client.reads().evidence.blockResultsWindow({
        ...f.selection,
        fromMs: T - 8000,
        maxHeights: 16,
      }),
    ).rejects.toThrow("window byte budget");
  });
  it("bounds transactions before reading an over-budget result list", async () => {
    const f = fixture();
    f.blocks.get(102)!.result.block.data.txs = Array.from(
      { length: 10_001 },
      () => "AQ==",
    );
    await expect(
      f.client.reads().evidence.blockResultsWindow(f.selection),
    ).rejects.toThrow("window transaction budget");
    expect(f.transport).toHaveBeenCalledTimes(2);
  });
  it("bounds accumulated event lists across otherwise valid responses", async () => {
    const f = fixture();
    for (const result of f.executions.values()) {
      const many = Array.from({ length: 4096 }, () => ({
        type: "future_event",
        attributes: [],
      }));
      Object.assign(result.result, {
        txs_results: [{ events: many }],
        finalize_block_events: many,
      });
    }
    await expect(
      f.client.reads().evidence.blockResultsWindow(f.selection),
    ).rejects.toThrow("window event budget");
  });
  it("bounds accumulated attributes independently of event and transaction counts", async () => {
    const f = fixture();
    const count = 17;
    f.blocks.get(102)!.result.block.data.txs = Array.from(
      { length: count },
      () => "AQ==",
    );
    Object.assign(f.executions.get(102)!.result, {
      txs_results: Array.from({ length: count }, () => ({
        events: [
          {
            type: "future_event",
            attributes: Array.from({ length: 4096 }, () => ({})),
          },
        ],
      })),
    });
    await expect(
      f.client.reads().evidence.blockResultsWindow(f.selection),
    ).rejects.toThrow("window event budget");
  });
});
