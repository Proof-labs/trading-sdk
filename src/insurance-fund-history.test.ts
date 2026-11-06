import { describe, expect, it, vi } from "vitest";
import { GatewayReads } from "./gateway-reads.js";
import {
  decodeInsuranceFundHistory,
  type InsuranceFundHistoryParams,
} from "./insurance-fund-history.js";

const params: InsuranceFundHistoryParams = { poolId: 2, stream: "balances" };
const point = {
  block_height: "9007199254740993",
  phase: "tx",
  tx_index: "0",
  event_index: "1",
};
function fixture() {
  return {
    pool_id: "2",
    stream: "balances",
    next_cursor: "",
    events: [
      {
        ...point,
        block_time: "2026-11-06T12:00:00.123456789Z",
        event_type: "insurance_fund_updated",
        payload: {
          pool_id: "2",
          balance: "-9007199254740993",
          delta: "-1",
          future_attribute: "retained",
        },
        balance_micro_usdc: "-9007199254740993",
        delta_micro_usdc: "-1",
      },
    ],
    coverage: {
      mode: "observed_events_only",
      complete_from_genesis: false,
      continuous_frontier: null,
      first_observed: { ...point },
      last_observed: { ...point },
    },
  };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("bounded insurance fund history", () => {
  it("preserves exact signed net cash and coordinates, unknown attributes and incomplete coverage", () => {
    const page = decodeInsuranceFundHistory(fixture(), params);
    expect(page.events[0]).toMatchObject({
      blockHeight: 9007199254740993n,
      balanceMicroUsdc: -9007199254740993n,
      deltaMicroUsdc: -1n,
      payload: { future_attribute: "retained" },
    });
    expect(page.coverage).toMatchObject({
      completeFromGenesis: false,
      continuousFrontier: null,
    });
  });
  it("uses one gateway request with the caller's transport and no-store", async () => {
    const fetch = vi.fn(async () => json(fixture()));
    const reads = new GatewayReads("https://gateway.example", fetch);
    await reads.insuranceFundHistory({
      ...params,
      limit: 5,
      cursor: "opaque_-",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toMatchObject([
      "https://gateway.example/v1/history/insurance-funds/2?stream=balances&limit=5&cursor=opaque_-",
      { method: "GET", cache: "no-store", signal: expect.any(AbortSignal) },
      {
        purpose: "query",
        priority: "critical",
        surface: "api_history_insurance_funds",
      },
    ]);
  });
  it("represents empty observations without claiming complete history", () => {
    const body = {
      ...fixture(),
      events: [],
      coverage: {
        ...fixture().coverage,
        first_observed: null,
        last_observed: null,
      },
    };
    expect(decodeInsuranceFundHistory(body, params).events).toEqual([]);
  });
  it("decodes activity without inventing cash, debt or equity", () => {
    const body = fixture();
    const {
      balance_micro_usdc: _balance,
      delta_micro_usdc: _delta,
      ...event
    } = body.events[0];
    const result = decodeInsuranceFundHistory(
      {
        ...body,
        stream: "activity",
        events: [{ ...event, event_type: "insurance_fund_deposited" }],
      },
      { ...params, stream: "activity" },
    );
    expect(result.events[0].balanceMicroUsdc).toBeUndefined();
  });
  it("orders phases and transaction coordinates, not timestamps", () => {
    const body = fixture();
    body.events.push({
      ...body.events[0],
      phase: "upgrade",
      tx_index: "0",
      event_index: "99",
    });
    body.coverage.first_observed = { ...body.events[1] };
    expect(decodeInsuranceFundHistory(body, params).events).toHaveLength(2);
    body.events.reverse();
    expect(() => decodeInsuranceFundHistory(body, params)).toThrow(
      "event order",
    );
  });
  it.each([
    { poolId: -1 },
    { poolId: 256 },
    { poolId: 1.5 },
    { limit: 0 },
    { limit: 201 },
    { limit: NaN },
    { stream: "equity" },
    { cursor: "x".repeat(257) },
    { cursor: "bad?" },
  ])("rejects bad request before transport %j", async (change) => {
    const fetch = vi.fn();
    const reads = new GatewayReads("", fetch);
    await expect(
      reads.insuranceFundHistory({
        ...params,
        ...change,
      } as InsuranceFundHistoryParams),
    ).rejects.toMatchObject({ kind: "configuration" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["1e3", "01", "-0", "9223372036854775808", 2, null])(
    "rejects malformed amount %j",
    (value) => {
      const body = fixture();
      Object.assign(body.events[0], { balance_micro_usdc: value });
      expect(() => decodeInsuranceFundHistory(body, params)).toThrow(
        "balance_micro_usdc",
      );
    },
  );
  it.each([
    (b: ReturnType<typeof fixture>) => {
      b.pool_id = "3";
    },
    (b: ReturnType<typeof fixture>) => {
      b.stream = "activity";
    },
    (b: ReturnType<typeof fixture>) => {
      b.events.push({ ...b.events[0] });
    },
    (b: ReturnType<typeof fixture>) => {
      b.events[0].block_time = "tomorrow";
    },
    (b: ReturnType<typeof fixture>) => {
      b.events[0].phase = "unknown";
    },
    (b: ReturnType<typeof fixture>) => {
      b.events[0].block_height = "0";
    },
    (b: ReturnType<typeof fixture>) => {
      b.events[0].phase = "end_block";
      b.events[0].tx_index = "1";
    },
    (b: ReturnType<typeof fixture>) => {
      b.coverage.complete_from_genesis = true;
    },
    (b: ReturnType<typeof fixture>) => {
      b.coverage.first_observed.event_index = "2";
    },
    (b: ReturnType<typeof fixture>) => {
      b.next_cursor = "next";
    },
    (b: ReturnType<typeof fixture>) => {
      Object.assign(b.events[0].payload, { amount: 42 });
    },
  ])("rejects malformed or unbound response %#", (mutate) => {
    const body = fixture();
    mutate(body);
    expect(() => decodeInsuranceFundHistory(body, params)).toThrow();
  });
  it("rejects a repeated continuation token", () => {
    const body = { ...fixture(), next_cursor: "same" };
    expect(() =>
      decodeInsuranceFundHistory(body, { ...params, limit: 1, cursor: "same" }),
    ).toThrow("cursor progress");
  });
  it("propagates unavailable history instead of returning zero", async () => {
    const reads = new GatewayReads("", async () =>
      json({ error: "insurance_history_unavailable" }, 503),
    );
    await expect(reads.insuranceFundHistory(params)).rejects.toMatchObject({
      status: 503,
    });
  });
  it("rejects duplicate JSON fields and oversized bodies", async () => {
    const duplicate = new GatewayReads(
      "",
      async () => new Response('{"pool_id":"2","pool_id":"2"}'),
    );
    await expect(duplicate.insuranceFundHistory(params)).rejects.toThrow(
      "Duplicate",
    );
    const oversized = new GatewayReads(
      "",
      async () => new Response(" ".repeat(1024 * 1024 + 1)),
    );
    await expect(oversized.insuranceFundHistory(params)).rejects.toMatchObject({
      kind: "limit",
    });
  });
  it("bounds stalled bodies and respects cancellation", async () => {
    const stalled = new GatewayReads(
      "",
      async () => new Response(new ReadableStream()),
    );
    await expect(
      stalled.insuranceFundHistory(params, { timeoutMs: 10 }),
    ).rejects.toMatchObject({ kind: "deadline" });
    const abort = new AbortController();
    abort.abort(new Error("stop"));
    const fetch = vi.fn();
    await expect(
      new GatewayReads("", fetch).insuranceFundHistory(params, {
        signal: abort.signal,
      }),
    ).rejects.toThrow("stop");
    expect(fetch).not.toHaveBeenCalled();
  });
});
