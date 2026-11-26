// queryHoldingSteps against the bucketed position read. The fixture's `step`
// rows are a DevNet response recorded 2026-11-26 (owner 83a7ff…, 36000s
// steps); the sub-account `open`/`close` pair is added in the shape of the
// stepped-holdings contract (Proof-labs/ProofOfBrain#1066), which the indexer
// does not serve yet.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExchangeClient } from "./client.js";
import {
  HOLDING_STEPS_MAX_OWNERS,
  decodeHoldingStepPage,
  holdingStepSearchParams,
  type HoldingStepPage,
} from "./index.js";

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
      { markets: [100, 3, 3], fromMs, toMs, stepMs, limit: 5000 },
    );
    expect(calls).toEqual([
      `http://gateway/v1/history/positions/${sub}?from=${fromMs}&to=${toMs}&limit=5000&interval=36000s&markets=3%2C100&owner=${main}`,
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
        blockTime: "2026-11-25T06:40:51.903114Z",
        timestamp: 1_795_588_851_903,
      },
      {
        owner: sub,
        market: 3,
        kind: "open",
        side: "sell",
        size: "40",
        entryPrice: "74810000.000000",
        blockHeight: 14_499_117,
        blockTime: "2026-11-25T04:12:07.118402Z",
        timestamp: 1_795_579_927_118,
      },
    ]);
    const times = page.steps.map((s) => s.timestamp);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("passes the cursor and omits owner and markets when not needed", () => {
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
      interval: "3600s",
      cursor: "opaque+/=",
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
      [[main], { limit: 5001 }],
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

  it.each([
    ["an unknown kind", { kind: "bucket" }],
    ["a missing kind", { kind: undefined }],
    ["an owner not requested", { owner: sub }],
    ["a fractional size", { size: "1.5" }],
    ["an open position without a side", { side: null }],
    ["a close with a size", { kind: "close" }],
    ["a close with a side", { kind: "close", size: "0" }],
    ["an open with no size", { kind: "open", size: "0" }],
    ["a non-UTC time", { block_time: "2026-11-25T21:59:49+08:00" }],
    ["a numeric size", { size: 243378 }],
  ])("rejects %s", (_, patch) => {
    expect(() => decode(patch)).toThrow(/holding steps decode/);
  });

  it("rejects a market not requested", () => {
    expect(() => decode({}, [3])).toThrow(/outside the requested/);
  });

  it("rejects a page without a cursor", () => {
    expect(() => decodeHoldingStepPage({ positions: [] }, [main])).toThrow(
      /next_cursor/,
    );
  });
});
