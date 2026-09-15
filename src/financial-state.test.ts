import { Encoder } from "@msgpack/msgpack";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeFinancialState, ExchangeClient } from "./index.js";
import { canonicalFinancialSelection } from "./financial-state.js";

const a = Array(20).fill(4);
const b = Array(20).fill(5);
const owner = "04".repeat(20);
const plpOwner = "05".repeat(20);
const selection = { markets: [1], owners: [owner] };
// Produced by the engine's typed query and rmp-serde; pinned byte-for-byte in
// exchange/spec/query-vectors/financial-state-v1.hex, not encoded by this SDK.
const RUST_FINANCIAL_V1_HEX =
  "980100cd04d29296dc001402020202020202020202020202020202020202027bc0c0c09096dc00140404040404040404040404040404040404040404c0f892ceffffffff009264ccc89296dc0014040404040404040404040404040404040404040401a453656c6c7b03d3800000000000000096dc00140404040404040404040404040404040404040404cd0101a453656c6c7b03d38000000000000000929c010000020390cdea6064d38000000000000000d09ccd03e8c09c020700020390cdea6064c0c0c0c0cf7fffffffffffffff929200ef9207d3800000000000000094dc00140202020202020202020202020202020202020202cd03e7cd01f4c3";
const account = (address = a): unknown[] => [
  address,
  null,
  null,
  null,
  null,
  [],
];
const market = (id = 1, pool = 0): unknown[] => [
  id,
  pool,
  6,
  1,
  2,
  [],
  1000,
  100,
  null,
  null,
  null,
  null,
];
const raw = (): unknown[] => [
  1,
  (1n << 64n) - 1n,
  5000,
  [account()],
  [market()],
  null,
  [[0, null]],
  null,
];
const encode = (value: unknown): string =>
  Buffer.from(new Encoder({ useBigInt64: true }).encode(value)).toString(
    "base64",
  );
const client = (): ExchangeClient =>
  new ExchangeClient({
    gatewayUrl: "http://gateway",
    apiUrl: "http://node",
    useGateway: false,
    chainId: "test",
  });

describe("atomic finalized financial state", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("decodes the real Rust query golden through the gateway transport", async () => {
    const data = Buffer.from(RUST_FINANCIAL_V1_HEX, "hex").toString("base64");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ data }))),
    );
    const result = await client().queryFinancialState({
      markets: [1, 2],
      owners: [owner],
    });
    expect(result).toMatchObject({
      format: 1,
      finalizedHeight: 0n,
      finalizedTimeMs: 1234n,
      feePool: (1n << 63n) - 1n,
    });
    expect(result.accounts[0]).toMatchObject({
      owner: "02".repeat(20),
      balance: 123n,
      feesAccrued: null,
      positions: [],
    });
    expect(result.accounts[1]).toMatchObject({
      owner,
      balance: null,
      feesAccrued: -8n,
      feeOverride: { takerBps: 4294967295, makerBps: 0 },
      rollingVolume: { lastUpdateMs: 100n, volume: 200n },
    });
    expect(result.accounts[1].positions).toEqual(
      [1, 257].map((market) => ({
        owner,
        market,
        side: "Sell",
        size: 3n,
        entryPrice: 123n,
        lastFundingIndex: -(1n << 63n),
      })),
    );
    expect(result.markets[0]).toEqual({
      market: 1,
      pool: 0,
      szDecimals: 0,
      makerFeeBps: 2,
      takerFeeBps: 3,
      feeTiers: [],
      fundingIntervalMs: 60000n,
      maxFundingRateBps: 100,
      cumulativeFunding: -(1n << 63n),
      fundingRateBps: -100n,
      lastFundingTimeMs: 1000n,
      markEwma: null,
    });
    expect(result.markets[1]).toMatchObject({
      market: 2,
      pool: 7,
      cumulativeFunding: null,
      fundingRateBps: null,
      lastFundingTimeMs: null,
      markEwma: null,
    });
    expect(result.insurancePools).toEqual([
      { pool: 0, balance: -17n },
      { pool: 7, balance: -(1n << 63n) },
    ]);
    expect(result.plp).toEqual({
      owner: "02".repeat(20),
      bootstrapBalance: 999n,
      minBalanceFloor: 500n,
      enabled: true,
    });
  });

  it("preserves absent rows and full integer precision without valuation", () => {
    const result = decodeFinancialState(raw(), selection);
    expect(result.finalizedHeight).toBe((1n << 64n) - 1n);
    expect(result.accounts).toEqual([
      {
        owner,
        balance: null,
        feesAccrued: null,
        feeOverride: null,
        rollingVolume: null,
        positions: [],
      },
    ]);
    expect(result.feePool).toBeNull();
    expect(result.insurancePools).toEqual([{ pool: 0, balance: null }]);
    expect(result.plp).toBeNull();
    expect(result).not.toHaveProperty("equity");
    expect(result).not.toHaveProperty("oraclePermission");
  });

  it("rejects missing finalized time after genesis without inventing metadata", () => {
    const r = raw();
    r[2] = 0;
    expect(() => decodeFinancialState(r, selection)).toThrow("finalized time");
    r[1] = 0;
    expect(decodeFinancialState(r, selection).finalizedTimeMs).toBe(0n);
  });

  it("accepts bounded owner BIN and ARRAY forms consistently with raw account state", () => {
    const r = raw();
    (r[3] as unknown[][])[0][0] = new Uint8Array(a);
    expect(decodeFinancialState(r, selection).accounts[0].owner).toBe(owner);
    (r[3] as unknown[][])[0][0] = new Uint8Array(21);
    expect(() => decodeFinancialState(r, selection)).toThrow("owner");
  });

  it("preserves nonzero fee/funding signs, tier order and separately stored PLP cash", () => {
    const r = raw();
    r[3] = [
      [
        a,
        (1n << 64n) - 1n,
        -12,
        [3, 2],
        [4000, 500],
        [[a, 0, "Sell", 100, 2, -(1n << 63n)]],
      ],
      [b, 7, 0, null, null, []],
    ];
    r[4] = [
      [
        1,
        8,
        6,
        2,
        3,
        [
          [20, -32768, 32767],
          [10, 0, 1],
        ],
        1000,
        100,
        -9,
        -8,
        4000,
        100,
      ],
    ];
    r[5] = -7;
    r[6] = [[8, 50]];
    r[7] = [b, 200, 10, true];
    const result = decodeFinancialState(r, selection);
    expect(result.accounts[0]).toMatchObject({
      balance: (1n << 64n) - 1n,
      feesAccrued: -12n,
      feeOverride: { takerBps: 3, makerBps: 2 },
      rollingVolume: { lastUpdateMs: 4000n, volume: 500n },
    });
    expect(result.accounts[0].positions[0].lastFundingIndex).toBe(-(1n << 63n));
    expect(result.markets[0]).toMatchObject({
      cumulativeFunding: -9n,
      fundingRateBps: -8n,
      lastFundingTimeMs: 4000n,
      markEwma: 100n,
    });
    expect(
      result.markets[0].feeTiers.map((tier) => tier.min30dVolumeMicroUsdc),
    ).toEqual([20n, 10n]);
    expect(result.feePool).toBe(-7n);
    expect(result.plp).toEqual({
      owner: plpOwner,
      bootstrapBalance: 200n,
      minBalanceFloor: 10n,
      enabled: true,
    });
    expect(
      decodeFinancialState(r, { markets: [1], owners: [plpOwner, owner] })
        .accounts,
    ).toHaveLength(2);
  });

  it("copies/sorts selection without mutation and deduplicates only auto-included PLP", () => {
    const requested = {
      markets: [2, 1],
      owners: [plpOwner, owner.toUpperCase()],
    };
    expect(canonicalFinancialSelection(requested)).toEqual({
      markets: [1, 2],
      owners: [owner, plpOwner],
    });
    expect(requested.markets).toEqual([2, 1]);
    const r = raw();
    r[4] = [market(1), market(2)];
    expect(
      decodeFinancialState(r, { markets: [2, 1], owners: [owner] })
        .insurancePools,
    ).toHaveLength(1);
  });

  it.each([
    { markets: [], owners: [owner] },
    { markets: [0], owners: [owner] },
    { markets: [1, 1], owners: [owner] },
    { markets: [1.1], owners: [owner] },
    { markets: [4294967296], owners: [owner] },
    { markets: [1], owners: [] },
    { markets: [1], owners: ["0x" + owner] },
    { markets: [1], owners: ["g".repeat(40)] },
    { markets: [1], owners: [owner, owner.toUpperCase()] },
    { markets: Array.from({ length: 9 }, (_, i) => i + 1), owners: [owner] },
    {
      markets: [1],
      owners: Array.from({ length: 9 }, (_, i) =>
        i.toString(16).padStart(40, "0"),
      ),
    },
  ])("rejects invalid selections before network I/O", async (bad) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(client().queryFinancialState(bad)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    (r: unknown[]) => r.push(0),
    (r: unknown[]) => {
      r[0] = 2;
    },
    (r: unknown[]) => {
      r[1] = Number.MAX_SAFE_INTEGER + 1;
    },
    (r: unknown[]) => {
      r[2] = -1;
    },
    (r: unknown[]) => {
      r[3] = [];
    },
    (r: unknown[]) => {
      (r[3] as unknown[][])[0][0] = b;
    },
    (r: unknown[]) => {
      (r[3] as unknown[][]).push(account());
    },
    (r: unknown[]) => {
      (r[3] as unknown[][])[0][1] = -1;
    },
    (r: unknown[]) => {
      (r[3] as unknown[][])[0][2] = 1n << 63n;
    },
    (r: unknown[]) => {
      (r[3] as unknown[][])[0][3] = [1, -1];
    },
    (r: unknown[]) => {
      (r[3] as unknown[][])[0][4] = [0];
    },
    (r: unknown[]) => {
      (r[3] as unknown[][])[0][5] = [[b, 1, "Buy", 1, 1, 0]];
    },
    (r: unknown[]) => {
      (r[3] as unknown[][])[0][5] = [[a, 1, 0, 1, 1, 0]];
    },
    (r: unknown[]) => {
      r[4] = [market(2)];
    },
    (r: unknown[]) => {
      (r[4] as unknown[][])[0][1] = 256;
    },
    (r: unknown[]) => {
      (r[4] as unknown[][])[0][2] = -1;
    },
    (r: unknown[]) => {
      (r[4] as unknown[][])[0][3] = 1n << 32n;
    },
    (r: unknown[]) => {
      (r[4] as unknown[][])[0][5] = [[0, -32769, 0]];
    },
    (r: unknown[]) => {
      (r[4] as unknown[][])[0][5] = Array(17).fill([0, 0, 0]);
    },
    (r: unknown[]) => {
      (r[4] as unknown[][])[0][8] = undefined;
    },
    (r: unknown[]) => {
      (r[4] as unknown[][])[0][10] = -1;
    },
    (r: unknown[]) => {
      r[5] = -(1n << 63n) - 1n;
    },
    (r: unknown[]) => {
      r[6] = [];
    },
    (r: unknown[]) => {
      r[6] = [[1, 0]];
    },
    (r: unknown[]) => {
      r[6] = [
        [0, 0],
        [0, 0],
      ];
    },
    (r: unknown[]) => {
      r[7] = [b, 1, 1, true];
    },
    (r: unknown[]) => {
      r[7] = [a, 1, 1, 1];
    },
    (r: unknown[]) => {
      r[7] = [a, -1, 1, true];
    },
  ])("rejects malformed, missing or cross-bound snapshot facts", (change) => {
    const r = raw();
    change(r);
    expect(() => decodeFinancialState(r, selection)).toThrow();
  });

  it("enforces the total 2048-position cap including auto-included PLP", async () => {
    const positions = (address: number[], count: number): unknown[] =>
      Array.from({ length: count }, (_, market) => [
        address,
        market,
        "Buy",
        1,
        1,
        0,
      ]);
    const r = raw();
    r[3] = [
      [a, 0, null, null, null, positions(a, 1024)],
      [b, 0, null, null, null, positions(b, 1024)],
    ];
    r[7] = [b, 1, 1, false];
    expect(decodeFinancialState(r, selection).accounts).toHaveLength(2);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ data: encode(r) }))),
    );
    const complete = await client().queryFinancialState(selection);
    expect(
      complete.accounts.reduce((n, account) => n + account.positions.length, 0),
    ).toBe(2048);
    (r[3] as unknown[][])[1][5] = positions(b, 1025);
    expect(() => decodeFinancialState(r, selection)).toThrow("total positions");
  });

  it("uses gateway-only canonical route even when legacy direct reads are opted in", async () => {
    const fetch = vi
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify({ data: encode(raw()) })),
      );
    vi.stubGlobal("fetch", fetch);
    expect((await client().queryFinancialState(selection)).format).toBe(1);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `http://gateway/v1/financial/state?markets=1&owners=${owner}`,
      { signal: expect.any(AbortSignal), redirect: "error" },
    );
  });

  it("admits every selector/metadata maximum with 2048 positions within the resource budget", async () => {
    const owners = Array.from({ length: 9 }, (_, i) =>
      (i + 1).toString(16).padStart(2, "0").repeat(20),
    );
    const addresses = Array.from({ length: 9 }, (_, i) =>
      Array(20).fill(i + 1),
    );
    const accounts = addresses.map(
      (address) => [address, 0, 0, [0, 0], [0, 0], []] as unknown[],
    );
    accounts[0][5] = Array.from({ length: 2048 }, (_, market) => [
      addresses[0],
      market,
      "Sell",
      1,
      1,
      -1,
    ]);
    const markets = Array.from({ length: 8 }, (_, i) => [
      i + 1,
      i,
      0,
      0,
      0,
      Array.from({ length: 16 }, () => [0, -1, 1]),
      1000,
      100,
      -1,
      -1,
      1000,
      1,
    ]);
    const r = [
      1,
      1,
      1234,
      accounts,
      markets,
      0,
      Array.from({ length: 8 }, (_, pool) => [pool, 0]),
      [addresses[8], 100, 10, true],
    ];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ data: encode(r) }))),
    );
    const result = await client().queryFinancialState({
      markets: Array.from({ length: 8 }, (_, i) => i + 1),
      owners: owners.slice(0, 8),
    });
    expect(result.accounts).toHaveLength(9);
    expect(result.accounts[0].positions).toHaveLength(2048);
    expect(
      result.markets.every((market) => market.feeTiers.length === 16),
    ).toBe(true);
    expect(result.insurancePools).toHaveLength(8);
  });

  it.each([400, 404, 429, 500, 502, 503])(
    "propagates HTTP %s without inventing a ledger",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response("sensitive upstream diagnostic", { status }),
          ),
      );
      await expect(client().queryFinancialState(selection)).rejects.toThrow(
        `financial state HTTP ${status}`,
      );
    },
  );

  it.each([
    null,
    {},
    { data: "" },
    { data: "AA==", error: "bad" },
    { data: "AB==" },
    { data: " AA==" },
    { data: "!!!!" },
    { data: encode(raw()) + "AA==" },
  ])("refuses malformed JSON/base64/messagepack wrappers", async (value) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(value))),
    );
    await expect(client().queryFinancialState(selection)).rejects.toThrow();
  });

  it.each([true, false])(
    "bounds content-length and streamed bytes (length present: %s)",
    async (declared) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response("x".repeat(1048577), {
            headers: declared ? { "content-length": "1048577" } : undefined,
          }),
        ),
      );
      await expect(client().queryFinancialState(selection)).rejects.toThrow(
        "response size",
      );
    },
  );

  it.each([
    [0xdd, 0xff, 0xff, 0xff, 0xff], // array32, declared 4Gi elements
    [0xdf, 0xff, 0xff, 0xff, 0xff], // map32
    [0xdb, 0xff, 0xff, 0xff, 0xff], // str32
    [0xc6, 0xff, 0xff, 0xff, 0xff], // bin32
    [0xc9, 0xff, 0xff, 0xff, 0xff, 0], // ext32
    [0x81, 0, 0], // no maps in positional DTO
    [0xa5, 65, 65, 65, 65, 65], // longest valid string is Sell
  ])(
    "bounds declared MessagePack allocations before decoding",
    async (...bytes) => {
      const data = Buffer.from(bytes).toString("base64");
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(JSON.stringify({ data }))),
      );
      await expect(client().queryFinancialState(selection)).rejects.toThrow(
        /MessagePack resource limit/,
      );
    },
  );

  it("rejects trailing MessagePack bytes after a valid snapshot", async () => {
    const bytes = Buffer.from(encode(raw()), "base64");
    const data = Buffer.concat([bytes, Buffer.from([0])]).toString("base64");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ data }))),
    );
    await expect(client().queryFinancialState(selection)).rejects.toThrow(
      /trailing MessagePack/,
    );
  });

  it("rejects excessive nesting before the allocating value decoder", async () => {
    const data = Buffer.from([...Array(9).fill(0x91), 0xc0]).toString("base64");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ data }))),
    );
    await expect(client().queryFinancialState(selection)).rejects.toThrow(
      "MessagePack depth limit",
    );
  });

  it.each([
    [0xca, 0x3f, 0x80, 0, 0],
    [0xcb, 0x3f, 0xf0, 0, 0, 0, 0, 0, 0],
  ])("rejects float-encoded integer ledger fields", async (...floatOne) => {
    const encoded = Buffer.from(encode(raw()), "base64");
    // Substitute numeric 1.0 for the integer format=1 in an otherwise valid DTO.
    expect(encoded.subarray(0, 2)).toEqual(Buffer.from([0x98, 1]));
    const data = Buffer.concat([
      encoded.subarray(0, 1),
      Buffer.from(floatOne),
      encoded.subarray(2),
    ]).toString("base64");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ data }))),
    );
    await expect(client().queryFinancialState(selection)).rejects.toThrow(
      "MessagePack resource limit",
    );
  });

  it("rejects aggregate declared slots even when each individual array is allowed", async () => {
    const child = Buffer.concat([
      Buffer.from([0xdc, 8, 0]),
      Buffer.alloc(2048),
    ]);
    const data = Buffer.concat([
      Buffer.from([0xdc, 0, 33]),
      ...Array(33).fill(child),
    ]).toString("base64");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ data }))),
    );
    await expect(client().queryFinancialState(selection)).rejects.toThrow(
      "MessagePack resource limit",
    );
  });

  it.each([[0xdc], [0xdd, 0], [0xda, 0], [0xcf, 0], [0xc4, 1]])(
    "rejects truncated MessagePack length or value framing",
    async (...bytes) => {
      const data = Buffer.from(bytes).toString("base64");
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(JSON.stringify({ data }))),
      );
      await expect(client().queryFinancialState(selection)).rejects.toThrow(
        "truncated MessagePack framing",
      );
    },
  );

  it("aborts a stalled transport after five seconds without retry", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      (_url: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const result = expect(
      client().queryFinancialState(selection),
    ).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(5000);
    await result;
    expect(fetch).toHaveBeenCalledOnce();
  });
});
