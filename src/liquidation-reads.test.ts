// The two liquidation reads: the global configuration
// (`GET /v1/liquidation-config`) and one owner's liquidation history
// (`GET /v1/history/liquidations/{owner}`). Global fetch is stubbed; each
// test asserts the URL and the decoded shape.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Encoder } from "@msgpack/msgpack";
import { ExchangeClient } from "./client.js";
import {
  decodeLiquidationConfigInfo,
  decodeLiquidationHistoryPage,
  liquidationHistorySearchParams,
  type LiquidationConfigInfo,
  type LiquidationHistoryPage,
} from "./index.js";

const encoder = new Encoder({ useBigInt64: true });
const owner = "aa".repeat(20);
const other = "bb".repeat(20);

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function stubFetch(body: unknown, status = 200): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      calls.push(url.toString());
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return calls;
}

const client = () =>
  new ExchangeClient({ gatewayUrl: "http://gateway", chainId: "test" });

afterEach(() => vi.unstubAllGlobals());

/** The genesis record `[1, [10500, [2, 3], 100, 20, 10, 50]]` as the engine
 *  encodes it (exchange `liquidation_config_query_tests.rs`). */
const GENESIS_RECORD = "kgGWzSkEkgIDZBQKMg==";

const GENESIS: LiquidationConfigInfo = {
  sequence: 1n,
  config: {
    targetRatioBps: 10_500,
    fullCloseThreshold: { numerator: 2, denominator: 3 },
    partialPenaltyBps: 100,
    maxBookOrders: 20,
    maxCommittedFills: 10,
    takeoverDiscountBps: 50,
  },
};

describe("queryLiquidationConfig", () => {
  it("reads the gateway route and decodes the engine's genesis record", async () => {
    expect(
      toB64(
        encoder.encode([1, [10_500, [2, 3], 100, 20, 10, 50]]) as Uint8Array,
      ),
    ).toBe(GENESIS_RECORD);
    const calls = stubFetch({ data: GENESIS_RECORD });
    const got: LiquidationConfigInfo = await client().queryLiquidationConfig();
    expect(calls).toEqual(["http://gateway/v1/liquidation-config"]);
    expect(got).toEqual(GENESIS);
  });

  it("keeps a sequence above 2^53 exact", () => {
    const sequence = (1n << 64n) - 1n;
    expect(
      decodeLiquidationConfigInfo([sequence, [11_000, [1, 2], 50, 30, 12, 75]]),
    ).toEqual({
      sequence,
      config: {
        targetRatioBps: 11_000,
        fullCloseThreshold: { numerator: 1, denominator: 2 },
        partialPenaltyBps: 50,
        maxBookOrders: 30,
        maxCommittedFills: 12,
        takeoverDiscountBps: 75,
      },
    });
  });

  it("decodes a record written before the takeover discount with the initial value", () => {
    expect(
      decodeLiquidationConfigInfo([1, [10_500, [2, 3], 100, 20, 10]]).config
        .takeoverDiscountBps,
    ).toBe(50);
  });

  it("fails closed on a record of the wrong shape", () => {
    expect(() =>
      decodeLiquidationConfigInfo([1, [10_500, [2, 3], 100, 20]]),
    ).toThrow(/liquidationConfig\.config has 4 fields, expected 5-6/);
    expect(() =>
      decodeLiquidationConfigInfo([[10_500, [2, 3], 100, 20, 10]]),
    ).toThrow(/liquidationConfig has 1 fields, expected exactly 2/);
    expect(() =>
      decodeLiquidationConfigInfo([-1, [10_500, [2, 3], 100, 20, 10]]),
    ).toThrow(/liquidationConfig\.sequence/);
  });

  it("throws when the gateway answers no data or an error", async () => {
    stubFetch({});
    await expect(client().queryLiquidationConfig()).rejects.toThrow();
    stubFetch({ error: "query failed (rc=-1)" }, 404);
    await expect(client().queryLiquidationConfig()).rejects.toThrow();
  });
});

const liquidated = {
  event_id: 90408,
  owner,
  block_height: 100,
  block_time: "2026-04-19T20:00:00.123456789Z",
  tx_hash: "liq-0",
  event_index: 0,
  event_type: "position_liquidated",
  payload: {
    owner,
    market: "7",
    side: "buy",
    mode: "partial",
    size_before: "200",
    size_closed: "50",
    size_after: "150",
    penalty_collected: "3",
    penalty_waived: "2",
    equity: "-15",
    maintenance: "40",
    binding_outcome: "4:yes,9:no",
    config_sequence: "8",
    block_height: "100",
    event_key: "100:0:3",
  },
};

const failed = {
  event_id: "9007199254740993",
  owner,
  block_height: 101,
  block_time: "2026-04-19T20:02:00Z",
  tx_hash: "liq-4",
  event_index: 1,
  event_type: "liquidation_failed",
  payload: { owner, code: "111", refusal: "position_mismatch" },
};

describe("queryLiquidationHistory", () => {
  it("reads the owner's page with its filters and decodes both event types", async () => {
    const calls = stubFetch({
      liquidations: [failed, liquidated],
      next_cursor: "opaque+/=",
    });
    const page: LiquidationHistoryPage = await client().queryLiquidationHistory(
      `0x${owner.toUpperCase()}`,
      {
        order: "desc",
        fromMs: 1_776_000_000_000,
        toMs: 1_777_000_000_000,
        limit: 2,
        cursor: "prev",
      },
    );
    expect(calls).toEqual([
      `http://gateway/v1/history/liquidations/${owner}?from=1776000000000&to=1777000000000&limit=2&cursor=prev&order=desc`,
    ]);
    expect(page.nextCursor).toBe("opaque+/=");
    expect(page.liquidations).toEqual([
      {
        eventId: 9007199254740993n,
        owner,
        blockHeight: 101,
        blockTime: "2026-04-19T20:02:00Z",
        txHash: "liq-4",
        eventIndex: 1,
        eventKey: null,
        eventType: "liquidation_failed",
        event: {
          type: "LiquidationFailed",
          owner,
          code: 111,
          refusal: "position_mismatch",
        },
      },
      {
        eventId: 90408n,
        owner,
        blockHeight: 100,
        blockTime: "2026-04-19T20:00:00.123456789Z",
        txHash: "liq-0",
        eventIndex: 0,
        eventKey: "100:0:3",
        eventType: "position_liquidated",
        event: {
          type: "PositionLiquidated",
          owner,
          market: 7,
          side: "buy",
          mode: "partial",
          sizeBefore: 200n,
          sizeClosed: 50n,
          sizeAfter: 150n,
          penaltyCollected: 3n,
          penaltyWaived: 2n,
          equity: -15n,
          maintenance: 40n,
          bindingOutcome: [
            { eventId: 4, branch: "Yes" },
            { eventId: 9, branch: "No" },
          ],
          configSequence: 8n,
        },
      },
    ]);
  });

  it("sends no query string without filters and ends on an empty cursor", async () => {
    const calls = stubFetch({ liquidations: [], next_cursor: "" });
    const c = client();
    c.setPrivateKey(new Uint8Array(32).fill(7));
    const page = await c.queryLiquidationHistory();
    expect(calls).toEqual([
      `http://gateway/v1/history/liquidations/${c.getAddressHex()}`,
    ]);
    expect(page).toEqual({ liquidations: [], nextCursor: "" });
  });

  it("refuses rows outside the owner's liquidation history", () => {
    const page = (row: unknown) => ({ liquidations: [row], next_cursor: "" });
    expect(() =>
      decodeLiquidationHistoryPage(page({ ...failed, owner: other }), owner),
    ).toThrow(/another owner's/);
    expect(() =>
      decodeLiquidationHistoryPage(
        page({ ...failed, payload: { ...failed.payload, owner: other } }),
        owner,
      ),
    ).toThrow(/payload names another owner/);
    expect(() =>
      decodeLiquidationHistoryPage(
        page({ ...failed, event_type: "adl_counterparty_skipped" }),
        owner,
      ),
    ).toThrow(/event_type "adl_counterparty_skipped"/);
  });

  it("refuses a malformed payload or page", () => {
    const { config_sequence: _dropped, ...payload } = liquidated.payload;
    expect(() =>
      decodeLiquidationHistoryPage(
        { liquidations: [{ ...liquidated, payload }], next_cursor: "" },
        owner,
      ),
    ).toThrow(/config_sequence is missing/);
    expect(() =>
      decodeLiquidationHistoryPage({ liquidations: [failed] }, owner),
    ).toThrow(/next_cursor must be a string/);
    expect(() =>
      decodeLiquidationHistoryPage(
        {
          liquidations: [{ ...failed, block_time: "yesterday" }],
          next_cursor: "",
        },
        owner,
      ),
    ).toThrow(/block_time/);
  });

  it("refuses invalid filters before any request", async () => {
    const calls = stubFetch({ liquidations: [], next_cursor: "" });
    expect(() =>
      liquidationHistorySearchParams({ order: "up" as "asc" }),
    ).toThrow(/Invalid history order/);
    await expect(
      client().queryLiquidationHistory(owner, { limit: 0 }),
    ).rejects.toThrow(/Invalid history limit/);
    await expect(client().queryLiquidationHistory("0x12")).rejects.toThrow(
      /Invalid history owner/,
    );
    await expect(client().queryLiquidationHistory()).rejects.toThrow(
      /No address available/,
    );
    expect(calls).toEqual([]);
  });
});
