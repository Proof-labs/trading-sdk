import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it, vi } from "vitest";
import { ExchangeClient } from "./client.js";
import { signAndEncode } from "./codec.js";
import {
  bytesToHex,
  chainIdFromString,
  getPublicKey,
  pubkeyToOwner,
} from "./crypto.js";
import { GatewayHttpError } from "./errors.js";
import type { ExchangeHttpTransport } from "./http-transport.js";
import { Side, TimeInForce } from "./types.js";

const chainName = "exchange-evidence-test-1";
const base64 = (value: Uint8Array) =>
  btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join(""));
function fixture() {
  const key = new Uint8Array(32).fill(7);
  const signedBytes = signAndEncode(
    chainIdFromString(chainName),
    {
      type: "PlaceOrder",
      data: {
        market: 1,
        owner: pubkeyToOwner(getPublicKey(key)),
        side: Side.Sell,
        price: 100_000_000n,
        quantity: 2n,
        timeInForce: TimeInForce.Ioc,
        reduceOnly: true,
      },
    },
    123456n,
    key,
  );
  const hash = bytesToHex(sha256(signedBytes)).toUpperCase();
  // Field names/defaults mirror validator rpc/core/types and abci/types.
  const tx = {
    jsonrpc: "2.0",
    id: -1,
    result: {
      hash,
      height: "9007199254740993",
      index: 1,
      tx: base64(signedBytes),
      tx_result: {
        code: 0,
        events: [
          {
            type: "trade",
            attributes: [
              { key: "fill_id", value: "9007199254740995", index: true },
              { key: "opaque", value: "AA==+/\u0000🦊" },
              { key: "empty", value: "", index: false },
            ],
          },
        ],
      },
    },
  };
  const block = {
    jsonrpc: "2.0",
    id: -1,
    result: {
      block_id: { hash: "ab".repeat(32) },
      block: {
        header: {
          chain_id: chainName,
          height: tx.result.height,
          time: "2026-10-26T13:14:15.123456789Z",
          app_hash: "cd".repeat(32),
          last_block_id: { hash: "ef".repeat(32) },
        },
        data: { txs: [base64(new Uint8Array([1])), base64(signedBytes)] },
      },
    },
  };
  return { tx, block, selection: { hash, signedBytes } };
}
function setup(f = fixture()) {
  const transport = vi.fn<ExchangeHttpTransport>(
    async (url) =>
      new Response(JSON.stringify(url.includes("/v1/tx/") ? f.tx : f.block)),
  );
  const client = new ExchangeClient({
    gatewayUrl: "https://gateway.example/",
    useGateway: false,
    chainId: chainName,
    httpTransport: transport,
  });
  return { ...f, transport, client };
}

describe("trusted-gateway transaction evidence", () => {
  it("binds real canonical signed bytes, hash, exact height/index and pinned chain without loading a key", async () => {
    const f = setup();
    const evidence = await f.client.reads().evidence.transaction(f.selection);
    expect(evidence).toEqual({
      source: "trusted-gateway",
      hash: f.selection.hash,
      signedBytes: f.selection.signedBytes,
      height: 9007199254740993n,
      index: 1,
      code: 0,
      events: f.tx.result.tx_result.events,
      block: {
        parentHash: "EF".repeat(32),
        hash: "AB".repeat(32),
        height: 9007199254740993n,
        chainId: chainName,
        time: "2026-10-26T13:14:15.123456789Z",
        appHash: "CD".repeat(32),
      },
    });
    expect(f.transport.mock.calls.map(([url]) => url)).toEqual([
      `https://gateway.example/v1/tx/${f.selection.hash}`,
      "https://gateway.example/v1/block?height=9007199254740993",
    ]);
    expect(
      f.transport.mock.calls.every(([, options]) => options?.method === "GET"),
    ).toBe(true);
  });
  it("preserves a committed rejection and documented protobuf omitted defaults", async () => {
    const f = setup();
    f.tx.result.tx_result.code = 12;
    expect(
      (await f.client.reads().evidence.transaction(f.selection)).code,
    ).toBe(12);
    Reflect.deleteProperty(f.tx.result.tx_result, "code");
    Reflect.deleteProperty(f.tx.result.tx_result, "events");
    expect(
      await f.client.reads().evidence.transaction(f.selection),
    ).toMatchObject({
      code: 0,
      events: [],
    });
  });
  it("refuses missing chain pin and invalid request bytes before any request", async () => {
    const f = setup();
    const keyless = new ExchangeClient({ httpTransport: f.transport });
    await expect(
      keyless.reads().evidence.transaction(f.selection),
    ).rejects.toThrow("pinned chainId");
    for (const selection of [
      { ...f.selection, hash: "00".repeat(32) },
      { ...f.selection, hash: `0x${f.selection.hash}` },
      { ...f.selection, signedBytes: new Uint8Array() },
      { ...f.selection, signedBytes: new Uint8Array(1024 * 1024 + 1) },
    ])
      await expect(
        f.client.reads().evidence.transaction(selection),
      ).rejects.toMatchObject({ name: "GatewayReadError" });
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each([
    [
      "transaction hash",
      (f: ReturnType<typeof fixture>) => {
        f.tx.result.hash = "00".repeat(32);
      },
    ],
    [
      "transaction bytes",
      (f: ReturnType<typeof fixture>) => {
        f.tx.result.tx = base64(new Uint8Array([1]));
      },
    ],
    [
      "block index",
      (f: ReturnType<typeof fixture>) => {
        f.tx.result.index = 0;
      },
    ],
    [
      "missing block index",
      (f: ReturnType<typeof fixture>) => {
        f.block.result.block.data.txs.pop();
      },
    ],
    [
      "chain",
      (f: ReturnType<typeof fixture>) => {
        f.block.result.block.header.chain_id = "wrong-chain";
      },
    ],
    [
      "height",
      (f: ReturnType<typeof fixture>) => {
        f.block.result.block.header.height = "42";
      },
    ],
    [
      "time",
      (f: ReturnType<typeof fixture>) => {
        f.block.result.block.header.time = "2026-02-30T00:00:00Z";
      },
    ],
    [
      "RPC error",
      (f: ReturnType<typeof fixture>) => {
        Object.assign(f.tx, { error: { code: -32603 } });
      },
    ],
    [
      "base64 padding",
      (f: ReturnType<typeof fixture>) => {
        f.tx.result.tx += "=";
      },
    ],
    [
      "missing result",
      (f: ReturnType<typeof fixture>) => {
        Reflect.deleteProperty(f.tx.result, "tx_result");
      },
    ],
    [
      "null events",
      (f: ReturnType<typeof fixture>) => {
        Object.assign(f.tx.result.tx_result, { events: null });
      },
    ],
    [
      "truncated event",
      (f: ReturnType<typeof fixture>) => {
        Object.assign(f.tx.result.tx_result, { events: [{}] });
      },
    ],
    [
      "malformed attributes",
      (f: ReturnType<typeof fixture>) => {
        Object.assign(f.tx.result.tx_result, {
          events: [{ type: "trade", attributes: [{ key: 123 }] }],
        });
      },
    ],
    [
      "attribute count",
      (f: ReturnType<typeof fixture>) => {
        Object.assign(f.tx.result.tx_result, {
          events: [
            {
              type: "trade",
              attributes: Array.from({ length: 4097 }, () => ({})),
            },
          ],
        });
      },
    ],
  ])("refuses mismatched or malformed %s evidence", async (_name, mutate) => {
    const f = setup();
    mutate(f);
    await expect(
      f.client.reads().evidence.transaction(f.selection),
    ).rejects.toMatchObject({ name: "GatewayReadError" });
  });
  it.each([9007199254740992, "01", "-1", "9223372036854775808", 1.5, null])(
    "rejects unsafe or noncanonical heights: %s",
    async (height) => {
      const f = setup();
      Object.assign(f.tx.result, { height });
      await expect(
        f.client.reads().evidence.transaction(f.selection),
      ).rejects.toThrow("transaction height");
      expect(f.transport).toHaveBeenCalledTimes(1);
    },
  );
  it.each([-1, 0x1_0000_0000, 1.5, "00", null])(
    "rejects invalid execution code: %s",
    async (code) => {
      const f = setup();
      Object.assign(f.tx.result.tx_result, { code });
      await expect(
        f.client.reads().evidence.transaction(f.selection),
      ).rejects.toThrow("execution code");
    },
  );
  it("throws on 404 and RPC not-found without concluding non-admission or retrying", async () => {
    const f = setup();
    f.transport.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    await expect(
      f.client.reads().evidence.transaction(f.selection),
    ).rejects.toBeInstanceOf(GatewayHttpError);
    expect(f.transport).toHaveBeenCalledTimes(1);
    f.transport.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "not found" },
        }),
      ),
    );
    await expect(
      f.client.reads().evidence.transaction(f.selection),
    ).rejects.toThrow("RPC error");
    expect(f.transport).toHaveBeenCalledTimes(2);
  });
  it("copies caller bytes before awaiting and preserves event text without base64 decoding", async () => {
    const f = setup();
    const expected = f.selection.signedBytes.slice();
    const pending = f.client.reads().evidence.transaction(f.selection);
    f.selection.signedBytes.fill(0);
    f.selection.hash = "00".repeat(32);
    const result = await pending;
    expect(result.signedBytes).toEqual(expected);
    expect(result.events[0].attributes?.[1].value).toBe("AA==+/\u0000🦊");
  });
  it("supports cancellation before and between reads", async () => {
    const f = setup();
    const before = AbortSignal.abort(new Error("cancelled before"));
    await expect(
      f.client.reads().evidence.transaction(f.selection, { signal: before }),
    ).rejects.toThrow("cancelled before");
    expect(f.transport).not.toHaveBeenCalled();
    const controller = new AbortController();
    f.transport.mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled in read"));
      return new Response(JSON.stringify(f.tx));
    });
    await expect(
      f.client.reads().evidence.transaction(f.selection, {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancel/);
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
  it("copies Node Buffer inputs instead of retaining Buffer.slice views", async () => {
    const f = setup();
    const expected = Uint8Array.from(f.selection.signedBytes);
    // The package is browser-first and does not depend on @types/node.
    const NodeBuffer = Reflect.get(globalThis, "Buffer") as {
      from(bytes: Uint8Array): Uint8Array;
    };
    f.selection.signedBytes = NodeBuffer.from(expected);
    const pending = f.client.reads().evidence.transaction(f.selection);
    f.selection.signedBytes.fill(0);
    expect((await pending).signedBytes).toEqual(expected);
  });
  it("uses one monotonic deadline rather than giving the block a fresh budget", async () => {
    const f = setup();
    let now = 1000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    f.transport.mockImplementation(async (url) => {
      now += 6;
      return new Response(
        JSON.stringify(url.includes("/v1/tx/") ? f.tx : f.block),
      );
    });
    try {
      await expect(
        f.client.reads().evidence.transaction(f.selection, { timeoutMs: 10 }),
      ).rejects.toThrow(/deadline/);
      expect(f.transport).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });
  it("rejects oversized, duplicate-key and truncated JSON responses", async () => {
    const f = setup();
    for (const body of [
      "x".repeat(1024 * 1024 + 1),
      JSON.stringify(f.tx).replace('"code":0', '"code":0,"code":12'),
      JSON.stringify(f.tx).slice(0, -1),
    ]) {
      f.transport.mockResolvedValueOnce(new Response(body));
      await expect(
        f.client.reads().evidence.transaction(f.selection),
      ).rejects.toThrow();
    }
  });
});
