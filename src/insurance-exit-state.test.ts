import { encode } from "@msgpack/msgpack";
import { describe, expect, it, vi } from "vitest";
import { ExchangeClient } from "./client.js";
import { chainIdFromString, pubkeyToOwner } from "./crypto.js";
import { decodeInsuranceExitState } from "./insurance-exit-state.js";
import type { ExchangeHttpTransport } from "./http-transport.js";

const chain = chainIdFromString("insurance-test-1");
const agent = new Uint8Array(32).fill(7);
const request = { pool: 0, agentPubkey: "07".repeat(32) };
const ownerHex = "f87da77f118cfaead95a77acb4b79ae9b765e425";
const owner = Uint8Array.from(ownerHex.match(/../g)!, (byte) =>
  parseInt(byte, 16),
);
const base64 = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
function order(id = 5n): unknown[] {
  return [
    id,
    1,
    owner,
    "Sell",
    100n,
    2n,
    null,
    4n,
    2n,
    1000n,
    3n,
    "Gtc",
    false,
    true,
  ];
}
function position(market = 1): unknown[] {
  return [owner, market, "Buy", 100n, 2n, -9007199254740993n];
}
function raw(): unknown[] {
  return [
    1,
    Array.from(chain),
    50n,
    1000n,
    0,
    Array.from(owner),
    Array.from(agent),
    Array.from(pubkeyToOwner(agent)),
    true,
    9007199254740993n,
    30000000000n,
    12n,
    [position()],
    [order()],
    true,
  ];
}
function envelope(value = raw()) {
  return {
    data: base64(encode(value, { useBigInt64: true })),
    witness: {
      version: 1,
      nodeId: "ab".repeat(20),
      height: "50",
      finalizedBlockTimeMs: "1000",
      appHash: "cd".repeat(32),
    },
  };
}
describe("finalized insurance exit facts", () => {
  it("preserves a nonzero exact-cost remainder in the witnessed inventory", () => {
    const value = raw();
    (value[12] as unknown[][])[0].push(1n);
    expect(
      decodeInsuranceExitState(envelope(value), chain, request).positions[0],
    ).toMatchObject({ entryPrice: 100n, size: 2n, entryRemainder: 1n });
  });
  it("decodes the actual Rust query fixture including integer-array owners", () => {
    // Produced by exchange-core query/insurance_exit.rs with rmp_serde::to_vec.
    const rust =
      "9f01dc002007070707070707070707070707070707070707070707070707070707070707072ace0001e07804dc0014ccc2ccf4cca632cce3cc8acc9c1e5b13616accebcce9ccef1721cc91cc8cccf1dc00200303030303030303030303030303030303030303030303030303030303030303dc0014cc8e1003cce6086dccf449ccb615ccbb411c3966cc9548cce1cc9dccbac3cd03e73c469196dc0014ccc2ccf4cca632cce3cc8acc9c1e5b13616accebcce9ccef1721cc91cc8cccf10ca3427579ce000493e005f9919e0a0cdc0014ccc2ccf4cca632cce3cc8acc9c1e5b13616accebcce9ccef1721cc91cc8cccf1a453656c6cce00030d4003060502ce0001d4c00aa3477463c2c3c3";
    const state = decodeInsuranceExitState(
      {
        data: base64(
          Uint8Array.from(rust.match(/../g)!, (byte) => parseInt(byte, 16)),
        ),
        witness: {
          ...envelope().witness,
          height: "42",
          finalizedBlockTimeMs: "123000",
        },
      },
      new Uint8Array(32).fill(7),
      { pool: 4, agentPubkey: "03".repeat(32) },
    );
    expect(state).toMatchObject({
      pool: 4,
      finalizedHeight: 42n,
      finalizedTimeMs: 123000n,
      cash: 60n,
      insuranceDebt: 70n,
      greatestRecentNonce: 999n,
    });
    expect(state.positions[0]).toMatchObject({
      market: 12,
      side: "Buy",
      entryPrice: 300000n,
      size: 5n,
      lastFundingIndex: -7n,
    });
    expect(state.orders[0]).toMatchObject({
      id: 10n,
      market: 12,
      side: "Sell",
      price: 200000n,
      quantity: 3n,
      clientOrderId: 6n,
      originalQuantity: 5n,
      filledQuantity: 2n,
      createdAtMs: 120000n,
      queuePriority: 10n,
      timeInForce: "Gtc",
      postOnly: false,
      reduceOnly: true,
    });
  });
  it("binds chain, derived fund owner, requested agent and same-view witness without a signer", async () => {
    const transport = vi.fn<ExchangeHttpTransport>(
      async () => new Response(JSON.stringify(envelope())),
    );
    const client = new ExchangeClient({
      gatewayUrl: "https://gateway.example/",
      useGateway: false,
      chainId: "insurance-test-1",
      httpTransport: transport,
    });
    const state = await client.queryInsuranceExitState(request);
    expect(state).toMatchObject({
      format: 1,
      chainId: chain,
      finalizedHeight: 50n,
      finalizedTimeMs: 1000n,
      pool: 0,
      owner: ownerHex,
      agentPubkey: request.agentPubkey,
      agentAuthorized: true,
      greatestRecentNonce: 9007199254740993n,
      cash: 30000000000n,
      insuranceDebt: 12n,
      complete: true,
      witness: {
        version: 1,
        height: 50n,
        finalizedBlockTimeMs: 1000n,
        nodeId: "ab".repeat(20),
        appHash: "cd".repeat(32),
      },
    });
    expect(state.positions[0]).toEqual({
      owner: ownerHex,
      market: 1,
      side: "Buy",
      entryPrice: 100n,
      entryRemainder: 0n,
      size: 2n,
      lastFundingIndex: -9007199254740993n,
    });
    expect(state.orders[0]).toEqual({
      id: 5n,
      market: 1,
      owner: ownerHex,
      side: "Sell",
      price: 100n,
      quantity: 2n,
      clientOrderId: null,
      originalQuantity: 4n,
      filledQuantity: 2n,
      createdAtMs: 1000n,
      queuePriority: 3n,
      timeInForce: "Gtc",
      postOnly: false,
      reduceOnly: true,
    });
    expect(transport.mock.calls[0][0]).toBe(
      `https://gateway.example/v1/insurance/exit-state?pool=0&agent=${request.agentPubkey}`,
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("preserves revocation, empty retained nonce set and empty complete inventory as facts", () => {
    const r = raw();
    r[8] = false;
    r[9] = null;
    r[12] = [];
    r[13] = [];
    expect(decodeInsuranceExitState(envelope(r), chain, request)).toMatchObject(
      {
        agentAuthorized: false,
        greatestRecentNonce: null,
        positions: [],
        orders: [],
        complete: true,
      },
    );
  });
  it("requires an explicit chain and canonical bounded request before any network call", async () => {
    const transport = vi.fn<ExchangeHttpTransport>();
    const client = new ExchangeClient({
      chainId: "insurance-test-1",
      httpTransport: transport,
    });
    await expect(
      new ExchangeClient({ httpTransport: transport }).queryInsuranceExitState(
        request,
      ),
    ).rejects.toThrow("pinned chainId");
    for (const selection of [
      { ...request, pool: -1 },
      { ...request, pool: 256 },
      { ...request, pool: 0.5 },
      { ...request, agentPubkey: "AB".repeat(32) },
      { ...request, agentPubkey: "07".repeat(20) },
    ]) {
      await expect(client.queryInsuranceExitState(selection)).rejects.toThrow();
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it("rejects wrong format, missing fields and all identity mismatches", () => {
    const patches: [number, unknown][] = [
      [0, 2],
      [1, Array(32).fill(8)],
      [2, 0],
      [3, 0],
      [4, 1],
      [5, Array(20).fill(9)],
      [6, Array(32).fill(9)],
      [7, Array(20).fill(9)],
      [8, 1],
      [9, -1],
      [10, -1],
      [11, -1],
      [14, false],
    ];
    for (const [index, value] of patches) {
      const r = raw();
      r[index] = value;
      expect(() =>
        decodeInsuranceExitState(envelope(r), chain, request),
      ).toThrow();
    }
    expect(() =>
      decodeInsuranceExitState(envelope(raw().slice(0, 14)), chain, request),
    ).toThrow();
    expect(() =>
      decodeInsuranceExitState(envelope([...raw(), 1]), chain, request),
    ).toThrow();
    expect(() =>
      decodeInsuranceExitState(envelope(), new Uint8Array(32), request),
    ).toThrow("pinned chain");
  });
  it("rejects absent, mismatched, malformed and imprecise witnesses", () => {
    for (const witness of [
      undefined,
      null,
      {},
      { ...envelope().witness, version: 2 },
      { ...envelope().witness, nodeId: "bad" },
      { ...envelope().witness, nodeId: "0".repeat(40) },
      { ...envelope().witness, appHash: "CD".repeat(32) },
      { ...envelope().witness, appHash: "0".repeat(64) },
      { ...envelope().witness, height: "51" },
      { ...envelope().witness, height: 50 },
      { ...envelope().witness, height: "050" },
      { ...envelope().witness, finalizedBlockTimeMs: "1001" },
      { ...envelope().witness, height: "18446744073709551616" },
    ])
      expect(() =>
        decodeInsuranceExitState({ ...envelope(), witness }, chain, request),
      ).toThrow();
  });
  it("rejects wrong-owner, duplicate, unordered, missing or oversized positions/orders", () => {
    const badOrder = order();
    badOrder[2] = new Uint8Array(20);
    const badPosition = position();
    badPosition[0] = new Uint8Array(20);
    for (const [index, value] of [
      [12, undefined],
      [12, [badPosition]],
      [12, [position(), position()]],
      [12, [position(2), position(1)]],
      [12, [position(0)]],
      [12, Array.from({ length: 2049 }, (_, i) => position(i + 1))],
      [13, undefined],
      [13, [badOrder]],
      [13, [order(), order()]],
      [13, [order(6n), order(5n)]],
      [13, [order().slice(0, 13)]],
      [13, Array.from({ length: 101 }, (_, i) => order(BigInt(i + 1)))],
    ] as [number, unknown][]) {
      const r = raw();
      r[index] = value;
      expect(() =>
        decodeInsuranceExitState(envelope(r), chain, request),
      ).toThrow();
    }
    for (const [index, value] of [
      [3, "Unknown"],
      [5, 0],
      [6, -1],
      [11, "Unknown"],
      [12, 1],
      [13, 1],
    ] as [number, unknown][]) {
      const o = order();
      o[index] = value;
      const r = raw();
      r[13] = [o];
      expect(() =>
        decodeInsuranceExitState(envelope(r), chain, request),
      ).toThrow();
    }
  });
  it("rejects float, trailing, truncated and unsafe-number payloads instead of repairing them", () => {
    const float = raw();
    float[10] = 1.5;
    const unsafe = raw();
    unsafe[10] = Number.MAX_SAFE_INTEGER + 1;
    for (const bytes of [
      encode(float, { useBigInt64: true }),
      encode(unsafe, { useBigInt64: true }),
      new Uint8Array([...encode(raw(), { useBigInt64: true }), 0]),
      encode(raw(), { useBigInt64: true }).slice(0, -1),
    ])
      expect(() =>
        decodeInsuranceExitState(
          { ...envelope(), data: base64(bytes) },
          chain,
          request,
        ),
      ).toThrow();
  });
  it("snapshots request identity before asynchronous transport and never falls back", async () => {
    const mutable = { ...request };
    const transport = vi.fn<ExchangeHttpTransport>(async () => {
      mutable.pool = 1;
      mutable.agentPubkey = "08".repeat(32);
      return new Response(JSON.stringify(envelope()));
    });
    const client = new ExchangeClient({
      chainId: "insurance-test-1",
      httpTransport: transport,
    });
    expect((await client.queryInsuranceExitState(mutable)).pool).toBe(0);
    const unsupported = vi.fn<ExchangeHttpTransport>(
      async () => new Response("not found", { status: 404 }),
    );
    await expect(
      new ExchangeClient({
        chainId: "insurance-test-1",
        httpTransport: unsupported,
      }).queryInsuranceExitState(request),
    ).rejects.toMatchObject({ status: 404 });
    expect(unsupported).toHaveBeenCalledTimes(1);
  });
});
