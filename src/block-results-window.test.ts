import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "./crypto.js";
import { describe, expect, it, vi } from "vitest";
import { ExchangeClient } from "./client.js";
import { signAndEncode } from "./codec.js";
import { transactionsRoot } from "./chain-evidence.js";
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

function fixture(first = 100, last = 103) {
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
  // A consistent gateway: header data_hash commits to the served txs unless a
  // test pins a stale root to model a gateway that dropped or reordered them.
  const blockResponse = (value: unknown) => {
    const served = structuredClone(value) as ReturnType<typeof block>;
    const header = served.result.block.header as { data_hash?: string };
    const txs = served.result.block.data.txs;
    header.data_hash ??=
      txs === null || Array.isArray(txs)
        ? transactionsRoot(
            (txs ?? []).map((tx) =>
              Uint8Array.from(atob(tx), (char) => char.charCodeAt(0)),
            ),
          )
        : "00".repeat(32);
    return new Response(JSON.stringify(served));
  };
  const blocks = new Map<number, ReturnType<typeof block>>();
  const executions = new Map<number, ReturnType<typeof results>>();
  for (let height = first; height <= last; height++) {
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
    if (parsed.pathname === "/v1/block") return blockResponse(value);
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
  it("ends a window that starts before genesis at height 1", async () => {
    const f = fixture(1);
    const genesis = f.blocks.get(1)!.result.block.header;
    genesis.app_hash = "";
    genesis.last_block_id.hash = "";
    const window = await f.client.reads().evidence.blockResultsWindow({
      fromMs: T - 200_000,
      toMs: T - 97_000,
      throughHeight: 2n,
      maxHeights: 3,
    });
    expect(window.fromHeight).toBe(1n);
    expect(window.blocks.map((b) => b.header.height)).toEqual([1n, 2n]);
    expect(window.blocks[0].header.parentHash).toBeNull();
    expect(f.transport).toHaveBeenCalledTimes(5);
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
      { maxHeights: 129 },
      { maxHeights: 0 },
    ]) {
      f.transport.mockClear();
      const label = {
        maxDecodedBytes: "bytes",
        maxTransactions: "transactions",
        maxEvents: "events",
        maxAttributes: "attributes",
        maxHeights: "heights",
      }[Object.keys(limits)[0]];
      await expect(
        f.client
          .reads()
          .evidence.blockResultsWindow({ ...f.selection, ...limits }),
      ).rejects.toMatchObject({
        kind: "configuration",
        field: `window ${label}`,
      });
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
      "surplus results",
      (f: ReturnType<typeof fixture>) => {
        const results = f.executions.get(101)!.result.txs_results!;
        results.push(results[0]);
      },
    ],
    [
      "null execution code",
      (f: ReturnType<typeof fixture>) => {
        Object.assign(f.executions.get(101)!.result.txs_results![0], {
          code: null,
        });
      },
    ],
    [
      "non-array transactions",
      (f: ReturnType<typeof fixture>) => {
        Object.assign(f.blocks.get(101)!.result.block.data, { txs: "AA==" });
      },
    ],
    [
      "dropped transaction with its result",
      (f: ReturnType<typeof fixture>) => {
        const data = f.blocks.get(101)!.result.block.data;
        Object.assign(f.blocks.get(101)!.result.block.header, {
          data_hash: transactionsRoot([f.signedBytes]),
        });
        data.txs = [];
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
      await expect(
        f.client.reads().evidence.blockResultsRange({
          fromHeight: 100n,
          throughHeight: 102n,
        }),
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
  it("keeps scanning past a block timed exactly at fromMs (half-open lower bound)", async () => {
    const f = fixture();
    const window = await f.client
      .reads()
      .evidence.blockResultsWindow({ ...f.selection, fromMs: T + 2000 });
    expect(window.fromHeight).toBe(100n);
    expect(window.blocks.map((b) => b.header.height)).toEqual([
      100n,
      101n,
      102n,
    ]);
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
    ).rejects.toMatchObject({ kind: "limit" });
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
    ).rejects.toMatchObject({ kind: "limit" });
  });
  it.each(["transaction", "system"])(
    "accepts more than 4,096 %s events within the window budget",
    async (location) => {
      const f = fixture();
      const many = Array.from({ length: 4097 }, (_, i) => ({
        type: `event_${i}`,
        attributes: [],
      }));
      const result = f.executions.get(102)!.result;
      if (location === "transaction") result.txs_results![0].events = many;
      else result.finalize_block_events = many;
      const window = await f.client
        .reads()
        .evidence.blockResultsWindow(f.selection);
      expect(window.blocks).toHaveLength(3);
      const last = window.blocks[2];
      expect(
        location === "transaction"
          ? last.transactions[0].events
          : last.finalizeBlockEvents,
      ).toEqual(many);
    },
  );
  it.each(["events", "attributes"])(
    "accepts the exact aggregate %s ceiling and refuses one extra without partial coverage",
    async (resource) => {
      const ceiling = resource === "events" ? 16_384 : 65_536;
      for (const extra of [0, 1]) {
        const f = fixture();
        for (const execution of f.executions.values()) {
          execution.result.txs_results![0].events = [];
          execution.result.finalize_block_events = [];
        }
        const makeEvents = (count: number) =>
          resource === "events"
            ? Array.from({ length: count }, () => ({
                type: "event",
                attributes: [],
              }))
            : [
                {
                  type: "event",
                  attributes: Array.from({ length: count }, () => ({})),
                },
              ];
        // The budget is shared by transaction/system lists and by heights.
        Object.assign(f.executions.get(102)!.result.txs_results![0], {
          events: makeEvents(ceiling - 2),
        });
        Object.assign(f.executions.get(102)!.result, {
          finalize_block_events: makeEvents(1),
        });
        Object.assign(f.executions.get(101)!.result.txs_results![0], {
          events: makeEvents(1 + extra),
        });
        const read = f.client.reads().evidence.blockResultsWindow(f.selection);
        if (extra) {
          await expect(read).rejects.toMatchObject({ kind: "limit" });
          expect(f.transport).toHaveBeenCalledTimes(5);
        } else {
          const window = await read;
          const all = window.blocks.flatMap((block) => [
            ...block.transactions.flatMap((tx) => tx.events),
            ...block.finalizeBlockEvents,
          ]);
          expect(
            resource === "events"
              ? all.length
              : all.reduce(
                  (n, event) => n + (event.attributes?.length ?? 0),
                  0,
                ),
          ).toBe(ceiling);
        }
      }
    },
  );
  it.each([{ maxEvents: 9 }, { maxAttributes: 12 }])(
    "honors a lower caller budget across the whole window: %j",
    async (budget) => {
      const f = fixture();
      await expect(
        f.client
          .reads()
          .evidence.blockResultsWindow({ ...f.selection, ...budget }),
      ).resolves.toMatchObject({ fromHeight: 100n });
      const reduced = Object.fromEntries(
        Object.entries(budget).map(([key, value]) => [key, value - 1]),
      );
      await expect(
        f.client
          .reads()
          .evidence.blockResultsWindow({ ...f.selection, ...reduced }),
      ).rejects.toMatchObject({ kind: "limit" });
    },
  );
  it("still rejects malformed events and attributes within the resource budgets", async () => {
    for (const events of [
      null,
      [{}],
      [{ type: "event", attributes: null }],
      [{ type: "event", attributes: [{ index: "true" }] }],
    ]) {
      const f = fixture();
      Object.assign(f.executions.get(102)!.result.txs_results![0], { events });
      await expect(
        f.client.reads().evidence.blockResultsWindow(f.selection),
      ).rejects.toMatchObject({ kind: "malformed" });
    }
  });
});

describe("exact inclusive trusted-gateway block/results ranges", () => {
  const selection = { fromHeight: 100n, throughHeight: 102n, maxHeights: 3 };
  it.each([(1n << 53n) + 1n, (1n << 63n) - 4n])(
    "preserves exact heights above Number.MAX_SAFE_INTEGER from %s",
    async (fromHeight) => {
      const f = fixture();
      const replies = new Map<string, unknown>();
      for (let index = 100; index <= 103; index++) {
        const height = fromHeight + BigInt(index - 100);
        const block = f.blocks.get(index)!;
        block.result.block.header.height = height.toString();
        Object.assign(block.result.block.header, {
          data_hash: transactionsRoot([f.signedBytes]),
        });
        replies.set(`/v1/block?height=${height}`, block);
        const results = f.executions.get(index)!;
        results.result.height = height.toString();
        replies.set(`/v1/block_results?height=${height}`, results);
      }
      const transport = vi.fn<ExchangeHttpTransport>(async (url) => {
        const parsed = new URL(url);
        const value = replies.get(parsed.pathname + parsed.search);
        return value
          ? new Response(JSON.stringify(value))
          : new Response("missing", { status: 404 });
      });
      const client = new ExchangeClient({
        gatewayUrl: "https://gateway.example",
        chainId: CHAIN,
        httpTransport: transport,
      });
      const range = await client.reads().evidence.blockResultsRange({
        fromHeight,
        throughHeight: fromHeight + 2n,
      });
      expect(range.blocks.map((b) => b.header.height)).toEqual([
        fromHeight,
        fromHeight + 1n,
        fromHeight + 2n,
      ]);
      expect(range.anchor.height).toBe(fromHeight + 3n);
      expect(
        transport.mock.calls.map(([url]) =>
          new URL(url).searchParams.get("height"),
        ),
      ).toEqual(
        [3n, 2n, 2n, 1n, 1n, 0n, 0n].map((offset) =>
          (fromHeight + offset).toString(),
        ),
      );
    },
  );
  it("accepts exactly 128 heights and rejects an extra height before I/O", async () => {
    const f = fixture(1, 129);
    f.blocks.get(1)!.result.block.header.app_hash = "";
    f.blocks.get(1)!.result.block.header.last_block_id.hash = "";
    const range = await f.client.reads().evidence.blockResultsRange({
      fromHeight: 1n,
      throughHeight: 128n,
      maxHeights: 128,
    });
    expect(range.blocks).toHaveLength(128);
    expect(range.anchor.height).toBe(129n);
    expect(f.transport).toHaveBeenCalledTimes(257);
    f.transport.mockClear();
    await expect(
      f.client.reads().evidence.blockResultsRange({
        fromHeight: 1n,
        throughHeight: 129n,
        maxHeights: 128,
      }),
    ).rejects.toMatchObject({ kind: "limit", field: "height budget" });
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("shares complete evidence with windows without returning time-selection fields", async () => {
    const f = fixture();
    const window = await f.client
      .reads()
      .evidence.blockResultsWindow(f.selection);
    f.transport.mockClear();
    const range = await f.client.reads().evidence.blockResultsRange(selection);
    expect(range).toEqual({
      source: window.source,
      fromHeight: 100n,
      throughHeight: 102n,
      anchor: window.anchor,
      blocks: window.blocks,
    });
    expect(range).not.toHaveProperty("fromMs");
    expect(range).not.toHaveProperty("toMs");
    expect(f.transport).toHaveBeenCalledTimes(7);
    expect(
      f.transport.mock.calls.every(
        ([url]) => new URL(url).origin === "https://gateway.example",
      ),
    ).toBe(true);
  });
  it("reads a single requested height plus its anchor, not an earlier time boundary", async () => {
    const f = fixture();
    f.blocks.delete(100);
    f.blocks.delete(101);
    f.executions.delete(101);
    const range = await f.client.reads().evidence.blockResultsRange({
      fromHeight: 102n,
      throughHeight: 102n,
      maxHeights: 1,
    });
    expect(range.blocks.map((b) => b.header.height)).toEqual([102n]);
    expect(range.anchor.height).toBe(103n);
    expect(f.transport).toHaveBeenCalledTimes(3);
  });
  it("accepts genesis as an exact lower bound without a preceding block", async () => {
    const f = fixture(1);
    f.blocks.get(1)!.result.block.header.app_hash = "";
    f.blocks.get(1)!.result.block.header.last_block_id.hash = "";
    const range = await f.client
      .reads()
      .evidence.blockResultsRange({ fromHeight: 1n, throughHeight: 1n });
    expect(range.blocks).toHaveLength(1);
    expect(range.blocks[0].header).toMatchObject({
      height: 1n,
      parentHash: null,
      appHash: null,
    });
    expect(f.transport).toHaveBeenCalledTimes(3);
  });
  it.each([0, 1, 100_000, 1_000_000])(
    "keeps every height at %i ns timestamp spacing",
    async (spacing) => {
      const f = fixture();
      for (let h = 100; h <= 103; h++) {
        f.blocks.get(h)!.result.block.header.time =
          `2026-10-26T00:00:00.${String((h - 100) * spacing).padStart(9, "0")}Z`;
      }
      const range = await f.client
        .reads()
        .evidence.blockResultsRange(selection);
      expect(range.blocks.map((b) => b.header.height)).toEqual([
        100n,
        101n,
        102n,
      ]);
      expect(range.blocks.map((b) => b.header.time)).toEqual(
        [100, 101, 102].map((h) => f.blocks.get(h)!.result.block.header.time),
      );
      expect(f.transport).toHaveBeenCalledTimes(7);
    },
  );
  it("rejects a backwards nanosecond even when Date.parse loses the difference", async () => {
    const f = fixture();
    for (const block of f.blocks.values())
      block.result.block.header.time = "2026-10-26T00:00:00.000000001Z";
    f.blocks.get(101)!.result.block.header.time =
      "2026-10-26T00:00:00.000000002Z";
    await expect(
      f.client.reads().evidence.blockResultsRange(selection),
    ).rejects.toThrow("block time continuity");
  });
  it("captures the exact bounds and all budgets before asynchronous reads", async () => {
    const f = fixture(),
      request = { ...selection, maxEvents: 9 };
    const pending = f.client.reads().evidence.blockResultsRange(request);
    request.fromHeight = 1n;
    request.throughHeight = 1n;
    request.maxHeights = 1;
    request.maxEvents = 1;
    expect(await pending).toMatchObject({
      fromHeight: 100n,
      throughHeight: 102n,
    });
  });
  it("requires a chain pin and valid, fully bounded heights before I/O", async () => {
    const f = fixture();
    await expect(
      new ExchangeClient({ httpTransport: f.transport })
        .reads()
        .evidence.blockResultsRange(selection),
    ).rejects.toThrow("pinned chainId");
    const fromHeight = { kind: "configuration", field: "from height" };
    const throughHeight = { kind: "configuration", field: "through height" };
    const span = { kind: "limit", field: "height budget" };
    const budget = (name: string) => ({
      kind: "configuration",
      field: `range ${name}`,
    });
    for (const [invalid, expected] of [
      [{ fromHeight: 0n }, fromHeight],
      [{ fromHeight: -1n }, fromHeight],
      [{ fromHeight: 103n }, fromHeight],
      [{ fromHeight: 100 as never }, fromHeight],
      [{ throughHeight: 102 as never }, throughHeight],
      [{ throughHeight: (1n << 63n) - 1n }, throughHeight],
      [{ throughHeight: 0n }, throughHeight],
      [{ maxHeights: 0 }, budget("heights")],
      [{ maxHeights: 129 }, budget("heights")],
      [{ maxHeights: 2 }, span],
      [{ fromHeight: 1n, throughHeight: 33n, maxHeights: undefined }, span],
      [{ maxDecodedBytes: 8 * 1024 * 1024 + 1 }, budget("bytes")],
      [{ maxTransactions: 10001 }, budget("transactions")],
      [{ maxEvents: 16385 }, budget("events")],
      [{ maxAttributes: 65537 }, budget("attributes")],
      [{ maxEvents: 0 }, budget("events")],
    ] as const)
      await expect(
        f.client
          .reads()
          .evidence.blockResultsRange({ ...selection, ...invalid }),
      ).rejects.toMatchObject(expected);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each(["anchor", "middle block", "middle results"])(
    "refuses pruned %s without partial coverage",
    async (missing) => {
      const f = fixture();
      if (missing === "anchor") f.blocks.delete(103);
      else if (missing === "middle block") f.blocks.delete(101);
      else f.executions.delete(101);
      await expect(
        f.client.reads().evidence.blockResultsRange(selection),
      ).rejects.toThrow();
    },
  );
  it.each([{ maxTransactions: 3 }, { maxEvents: 9 }, { maxAttributes: 12 }])(
    "shares exact aggregate budget %j and rejects one less",
    async (budget) => {
      const f = fixture();
      await expect(
        f.client
          .reads()
          .evidence.blockResultsRange({ ...selection, ...budget }),
      ).resolves.toMatchObject({ fromHeight: 100n });
      const reduced = Object.fromEntries(
        Object.entries(budget).map(([key, value]) => [key, value - 1]),
      );
      await expect(
        f.client
          .reads()
          .evidence.blockResultsRange({ ...selection, ...reduced }),
      ).rejects.toMatchObject({ kind: "limit" });
    },
  );
  it("enforces the range byte budget and one shared cancellable deadline", async () => {
    const f = fixture();
    await expect(
      f.client
        .reads()
        .evidence.blockResultsRange({ ...selection, maxDecodedBytes: 1 }),
    ).rejects.toMatchObject({ kind: "limit", field: "range byte budget" });
    f.transport.mockClear();
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
          .evidence.blockResultsRange(selection, { timeoutMs: 12 }),
      ).rejects.toThrow(/deadline/);
      expect(f.transport.mock.calls.length).toBeLessThan(7);
    } finally {
      spy.mockRestore();
    }
    const before = f.transport.mock.calls.length;
    await expect(
      f.client.reads().evidence.blockResultsRange(selection, {
        signal: AbortSignal.abort(new Error("cancelled")),
      }),
    ).rejects.toThrow("cancelled");
    expect(f.transport).toHaveBeenCalledTimes(before);
  });
});

it.each([false, true])(
  "range pairs independent multi-tx vector (tamper=%s)",
  async (tamper) => {
    const vectors = JSON.parse(
      readFileSync(
        new URL(
          "../python/tests/fixtures/comet_transaction_roots.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { txs: string[]; dataHash: string }[];
    const vector = vectors.find((v) => v.txs.length === 3)!;
    const f = fixture();
    const b = f.blocks.get(102)!;
    b.result.block.data.txs = vector.txs;
    Object.assign(b.result.block.header, {
      data_hash: tamper ? "0".repeat(64) : vector.dataHash,
    });
    f.executions.get(102)!.result.txs_results = [0, 21, 7].map((code) => ({
      code,
      events: [],
    }));
    const pending = f.client
      .reads()
      .evidence.blockResultsRange({ fromHeight: 102n, throughHeight: 102n });
    if (tamper)
      await expect(pending).rejects.toMatchObject({ kind: "binding" });
    else {
      const txs = (await pending).blocks[0].transactions;
      expect(txs.map((tx) => tx.code)).toEqual([0, 21, 7]);
      expect(txs.map((tx) => tx.hash)).toEqual(
        vector.txs.map((tx) =>
          bytesToHex(sha256(Buffer.from(tx, "base64"))).toUpperCase(),
        ),
      );
    }
  },
);

it.each([
  ["parent hash continuity", "parent"],
  ["post-state/header binding", "post"],
] as const)("classifies %s as binding", async (field, mutation) => {
  const f = fixture();
  const header = f.blocks.get(103)!.result.block.header;
  if (mutation === "parent") header.last_block_id.hash = "F".repeat(64);
  else header.app_hash = "F".repeat(64);
  await expect(
    f.client
      .reads()
      .evidence.blockResultsRange({ fromHeight: 102n, throughHeight: 102n }),
  ).rejects.toMatchObject({ kind: "binding", field });
});
