import { describe, it, expect, vi, afterEach } from "vitest";
import { encode } from "@msgpack/msgpack";
import { readFileSync } from "node:fs";
import { ExchangeClient } from "./client.js";
import { chainIdFromString } from "./crypto.js";
import {
  decodeMarketsSnapshot,
  parseSnapshotEnvelope,
  MAX_SNAPSHOT_BYTES,
} from "./market-snapshot.js";

const chain = new Uint8Array(32).fill(7);
const market = (): unknown[] => [
  1,
  1000,
  500,
  5,
  2,
  3_600_000,
  100,
  "Perp",
  0,
  0,
  false,
  0,
  30_000,
  [],
  100,
  1,
  null,
  0,
  "OracleOnly",
  0,
  0,
  false,
  5,
  "BTC",
  18_446_744_073_709_551_615n,
];
const snapshot = (): unknown[] => [
  Array.from(chain),
  9_007_199_254_740_993n,
  [market()],
  [],
];
const envelope = (value: unknown) => ({
  data: Buffer.from(encode(value, { useBigInt64: true })).toString("base64"),
});

afterEach(() => vi.unstubAllGlobals());

describe("atomic market snapshot", () => {
  it("rejects duplicate escaped JSON envelope keys and explicit upstream errors", () => {
    for (const body of [
      '{"data":"kA==","data":"kA=="}',
      '{"data":"kA==","d\\u0061ta":"kA=="}',
    ]) {
      expect(() => parseSnapshotEnvelope(body)).toThrow();
    }
    expect(
      parseSnapshotEnvelope(
        '{"data":"kA==","future":{"data":"one","key":"two"}}',
      ),
    ).toEqual({ data: "kA==", future: { data: "one", key: "two" } });
    expect(() =>
      decodeMarketsSnapshot(
        { ...envelope(snapshot()), error: "unavailable" },
        chain,
      ),
    ).toThrow();
  });
  it("reads the actual current-engine G17 snapshot with all market kinds", () => {
    const hex = readFileSync(
      new URL(
        "../crates/proof-trading-sdk/src/market_snapshot/engine-0d215eaa.hex",
        import.meta.url,
      ),
      "utf8",
    ).trim();
    const decoded = decodeMarketsSnapshot(
      { data: Buffer.from(hex, "hex").toString("base64") },
      chain,
    );
    expect(decoded.height).toBe(9_007_199_254_740_993n);
    expect(decoded.markets.map((m) => m.market)).toEqual([
      1, 101, 102, 201, 202,
    ]);
    expect(decoded.markets[3].kind).toEqual({ PredictionBinary: [123, "Yes"] });
    expect(decoded.markets[0].feeTiers?.[0].makerFeeTenthBps).toBe(-7);
    expect(decoded.markets[0].maxOpenInterest).toBe(
      18_446_744_073_709_551_615n,
    );
    expect(decoded.impactMarkets[0].impactMarketId).toBe(77);
    expect(decoded.impactMarkets[0].ebyMarket).toBe(0);
  });
  it("decodes a Rust-produced shared-wire vector losslessly", () => {
    const hex =
      "94dc00200707070707070707070707070707070707070707070707070707070707070707cfffffffffffffffff91dc001901cd03e8cd01f40502ce0036ee8064a4506572700000c200cd7530906401c000aa4f7261636c654f6e6c790000c205a3425443cfffffffffffffffff90";
    const result = decodeMarketsSnapshot(
      { data: Buffer.from(hex, "hex").toString("base64") },
      chain,
    );
    expect(result.height).toBe(18_446_744_073_709_551_615n);
    expect(result.markets[0].maxOpenInterest).toBe(result.height);
    expect(result.markets[0].kind).toBe("Perp");
  });

  it("accepts appended fields and explicit empty registries", () => {
    const value = snapshot();
    (value[2] as unknown[][])[0].push("future field");
    value.push({ future: "metadata" });
    expect(decodeMarketsSnapshot(envelope(value), chain).markets).toHaveLength(
      1,
    );
    value[2] = [];
    expect(decodeMarketsSnapshot(envelope(value), chain).markets).toEqual([]);
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { data: null },
    { data: "!" },
    { data: "kB==" },
  ])("rejects missing or malformed envelopes: %j", (value) => {
    expect(() => decodeMarketsSnapshot(value, chain)).toThrow();
  });

  it.each([
    [0, -1],
    [1, 1.5],
    [7, "UnknownKind"],
    [10, 0],
    [16, [1, 2]],
    [18, "UnknownMode"],
    [24, -1n],
  ])("rejects malformed known field %j", (slot, value) => {
    const input = snapshot();
    (input[2] as unknown[][])[0][slot as number] = value;
    expect(() => decodeMarketsSnapshot(envelope(input), chain)).toThrow();
  });

  it("rejects wrong chain, zero height, incomplete and duplicate records", () => {
    expect(() =>
      decodeMarketsSnapshot(envelope(snapshot()), new Uint8Array(32).fill(8)),
    ).toThrow("wrong chain");
    const zero = snapshot();
    zero[1] = 0;
    expect(() => decodeMarketsSnapshot(envelope(zero), chain)).toThrow(
      "uncommitted",
    );
    const duplicate = snapshot();
    duplicate[2] = [market(), market()];
    expect(() => decodeMarketsSnapshot(envelope(duplicate), chain)).toThrow();
    const incomplete = snapshot();
    incomplete[2] = [market().slice(0, 7)];
    expect(() => decodeMarketsSnapshot(envelope(incomplete), chain)).toThrow();
  });

  it("rejects integral floats, trailing bytes and declared oversized containers", () => {
    const packed = encode(snapshot(), { useBigInt64: true });
    const trailing = Buffer.concat([packed, Buffer.from([0])]);
    for (const bytes of [
      trailing,
      Buffer.from([0xdd, 255, 255, 255, 255]),
      Buffer.from([0xcb, 0x3f, 0xf0, 0, 0, 0, 0, 0, 0]),
    ]) {
      expect(() =>
        decodeMarketsSnapshot({ data: bytes.toString("base64") }, chain),
      ).toThrow();
    }
  });

  it("uses exactly one gateway read with the explicitly pinned chain", async () => {
    const pinned = chainIdFromString("proof-test");
    const value = snapshot();
    value[0] = Array.from(pinned);
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(envelope(value)), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetcher);
    const client = new ExchangeClient({
      gatewayUrl: "http://127.0.0.1:9080",
      apiUrl: "http://127.0.0.1:8080",
      rpcUrl: "http://127.0.0.1:26657",
      chainId: "proof-test",
    });
    expect((await client.queryMarketsSnapshot()).height).toBe(
      9_007_199_254_740_993n,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(
      "http://127.0.0.1:9080/v1/markets-snapshot",
    );
    expect(fetcher.mock.calls[0][1].redirect).toBe("error");
  });

  it("requires a pin and never returns inventory for HTTP or streaming errors", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      new ExchangeClient({
        gatewayUrl: "http://127.0.0.1:9080",
      }).queryMarketsSnapshot(),
    ).rejects.toThrow("pinned chainId");
    expect(fetcher).not.toHaveBeenCalled();
    const client = new ExchangeClient({
      gatewayUrl: "http://127.0.0.1:9080",
      chainId: "proof-test",
    });
    fetcher.mockResolvedValueOnce(
      new Response("secret provider URL", { status: 503 }),
    );
    await expect(client.queryMarketsSnapshot()).rejects.toThrow("HTTP 503");
    fetcher.mockResolvedValueOnce(
      new Response("x".repeat(MAX_SNAPSHOT_BYTES + 1), { status: 200 }),
    );
    await expect(client.queryMarketsSnapshot()).rejects.toThrow("malformed");
    fetcher.mockRejectedValueOnce(new Error("secret credential URL"));
    await expect(client.queryMarketsSnapshot()).rejects.toThrow(
      "transport or response unavailable",
    );
  });

  it("auto-discovered signer chain identity is not an inventory authority pin", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ result: { node_info: { network: "proof-test" } } }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const client = new ExchangeClient({ gatewayUrl: "http://127.0.0.1:9080" });
    await client.ready();
    await expect(client.queryMarketsSnapshot()).rejects.toThrow(
      "explicit pinned chainId",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
