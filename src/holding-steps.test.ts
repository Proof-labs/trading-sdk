// queryHoldingSteps against the bucketed position read.
//
// Fixture: one page for owner 83a7ff… and a sub-account, 36000s steps, newest
// first. Market 3 and 100 `step` rows are real DevNet snapshots; the
// sub-account's market-3 `open` (sampled height 14,499,500) and `close`
// (exact height 14,520,031) are a short holding in the contract's row shape,
// timed at the chain's rate between the recorded rows. The test checks the
// request URL, `next_cursor`, row count, the full decode of the first row and
// of the open/close pair, and newest-first order; the other fields are as
// served and only pass through the decoder's checks.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExchangeClient } from "./client.js";
import {
  decodeHoldingStepPage,
  holdingStepSearchParams,
  type HoldingStepPage,
} from "./index.js";
import { HOLDING_STEPS_MAX_OWNERS } from "./holding-steps.js";

const recorded = JSON.parse(
  readFileSync(
    new URL("./fixtures/holding-steps-devnet.json", import.meta.url),
    "utf8",
  ),
) as { next_cursor: string; positions: Record<string, unknown>[] };

const main = "83a7ff68818e979e31e3fbb31ac62f3b3cebe3ef";
const sub = "5ea4c0d1f1b2e3a4b5c6d7e8f9a0b1c2d3e4f5a6";
const fromMs = 1_793_059_200_000; // 2026-10-27, 30 days of 72 steps
const toMs = 1_795_651_200_000;
const stepMs = 36_000_000;

function stubFetch(body: unknown): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      calls.push(url.toString());
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return calls;
}

const client = () =>
  new ExchangeClient({ gatewayUrl: "http://gateway", chainId: "test" });

afterEach(() => vi.unstubAllGlobals());

describe("queryHoldingSteps", () => {
  it("reads every owner's steps in one request and decodes the recorded page", async () => {
    const calls = stubFetch(recorded);
    const page: HoldingStepPage = await client().queryHoldingSteps(
      [`0x${main.toUpperCase()}`, sub, main],
      { markets: [100, 3, 3], fromMs, toMs, stepMs, limit: 3000 },
    );
    expect(calls).toEqual([
      `http://gateway/v1/history/positions/${sub}?from=${fromMs}&to=${toMs}&limit=3000&interval=36000s&markets=3%2C100&owner=${main}&transitions=true`,
    ]);
    expect(page.nextCursor).toBe(recorded.next_cursor);
    expect(page.steps).toHaveLength(8);
    expect(page.steps[0]).toEqual({
      owner: main,
      market: 100,
      kind: "step",
      side: "buy",
      size: "243378",
      entryPrice: "20287.000000",
      blockHeight: 14_658_800,
      blockTime: "2026-11-25T21:59:49.260503Z",
      timestamp: 1_795_643_989_260,
    });
    const shortHolding = page.steps.filter((s) => s.owner === sub);
    expect(shortHolding).toEqual([
      {
        owner: sub,
        market: 3,
        kind: "close",
        side: null,
        size: "0",
        entryPrice: null,
        blockHeight: 14_520_031,
        blockTime: "2026-11-25T08:07:53.300358Z",
        timestamp: 1_795_594_073_300,
      },
      {
        owner: sub,
        market: 3,
        kind: "open",
        side: "sell",
        size: "40",
        entryPrice: "74810000.000000",
        blockHeight: 14_499_500,
        blockTime: "2026-11-25T06:04:48.197003Z",
        timestamp: 1_795_586_688_197,
      },
    ]);
    const times = page.steps.map((s) => s.timestamp);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("defaults limit to 3000, always asks for transitions, omits owner and markets when not needed", () => {
    expect(
      Object.fromEntries(
        holdingStepSearchParams([main], {
          fromMs,
          toMs,
          stepMs: 3_600_000,
          cursor: "opaque+/=",
        }),
      ),
    ).toEqual({
      from: String(fromMs),
      to: String(toMs),
      limit: "3000",
      interval: "3600s",
      cursor: "opaque+/=",
      transitions: "true",
    });
  });

  it("rejects bad inputs before fetching", async () => {
    const calls = stubFetch(recorded);
    const tooMany = Array.from(
      { length: HOLDING_STEPS_MAX_OWNERS + 1 },
      (_, i) => i.toString(16).padStart(40, "0"),
    );
    const bad: [string[], object][] = [
      [[], {}],
      [tooMany, {}],
      [["xyz"], {}],
      [[main], { stepMs: 1500 }],
      [[main], { stepMs: 0 }],
      [[main], { stepMs: 366 * 86_400_000 }],
      [[main], { markets: [] }],
      [[main], { markets: [-1] }],
      [[main], { fromMs: toMs }],
      [[main], { limit: 3001 }],
      [[main], { markets: Array.from({ length: 201 }, (_, i) => i) }],
      // 43,200 one-minute steps in 30 days, over the indexer's 5000.
      [[main], { stepMs: 60_000 }],
    ];
    for (const [owners, patch] of bad) {
      await expect(
        client().queryHoldingSteps(owners, {
          fromMs,
          toMs,
          stepMs,
          ...patch,
        }),
      ).rejects.toThrow();
    }
    expect(calls).toEqual([]);
  });
});

describe("holding step limit", () => {
  // The indexer divides whole seconds of `to - from` by the step in seconds.
  const at = (spanMs: number) =>
    holdingStepSearchParams([main], {
      fromMs,
      toMs: fromMs + spanMs,
      stepMs: 1000,
    });

  it("accepts 5000 steps, including a trailing part-second", () => {
    expect(() => at(5_000_999)).not.toThrow();
  });

  it("refuses 5001 steps", () => {
    expect(() => at(5_001_000)).toThrow(/Too many holding steps/);
  });
});

describe("decodeHoldingStepPage", () => {
  const row = recorded.positions[0];
  const decode = (patch: Record<string, unknown>, markets?: number[]) =>
    decodeHoldingStepPage(
      { next_cursor: "", positions: [{ ...row, ...patch }] },
      [main],
      markets,
    );

  it("accepts a recorded row", () => {
    expect(decode({}).steps[0].kind).toBe("step");
  });

  it("accepts a close with no open before it (a holding between two samples)", () => {
    const page = decode({
      kind: "close",
      size: "0",
      side: null,
      entry_px: null,
    });
    expect(page.steps).toHaveLength(1);
    expect(page.steps[0]).toMatchObject({
      kind: "close",
      size: "0",
      side: null,
    });
  });

  it.each([
    ["an unknown kind", { kind: "bucket" }],
    ["a missing kind", { kind: undefined }],
    ["a close with a size", { kind: "close" }],
    ["a close with a side", { kind: "close", size: "0" }],
    ["an open with no size", { kind: "open", size: "0" }],
    ["a size with a leading zero", { size: "0243378" }],
  ])("rejects %s", (_, patch) => {
    expect(() => decode(patch)).toThrow(/holding steps decode/);
  });

  it.each([
    ["an owner not requested", { owner: sub }],
    ["a fractional size", { size: "1.5" }],
    ["an open position without a side", { side: null }],
    ["a non-UTC time", { block_time: "2026-11-25T21:59:49+08:00" }],
    ["a numeric size", { size: 243378 }],
  ])("rejects %s, as the position history decoder does", (_, patch) => {
    expect(() => decode(patch)).toThrow(/history/i);
  });

  it("rejects a market not requested", () => {
    expect(() => decode({}, [3])).toThrow(/scope mismatch/);
  });

  it("rejects a page without a cursor", () => {
    expect(() => decodeHoldingStepPage({ positions: [] }, [main])).toThrow(
      /position history page/,
    );
  });
});
