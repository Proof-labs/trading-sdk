import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedGatewayJson } from "./bounded-read.js";
import type { ExchangeHttpTransport } from "./http-transport.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("bounded read transport", () => {
  it("rejects an infinite empty-chunk producer without waiting for a starved timer", async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(0));
      },
      cancel,
    });
    await expect(
      boundedGatewayJson(
        "https://gateway.example/read",
        async () => new Response(stream),
        { timeoutMs: 60_000 },
      ),
    ).rejects.toThrow("empty body chunk");
    expect(pulls).toBeLessThanOrEqual(3);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("enforces monotonic elapsed time even when continuously ready positive chunks starve timers", async () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock++);
    vi.spyOn(Date, "now").mockImplementation(() => 100000 - clock * 1000);
    let pulls = 0;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(Uint8Array.of(32));
      },
      cancel,
    });
    await expect(
      boundedGatewayJson(
        "https://gateway.example/read",
        async () => new Response(stream),
        { timeoutMs: 3 },
      ),
    ).rejects.toThrow("deadline");
    expect(pulls).toBeLessThan(8);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("bounds both positive-byte fragmentation and aggregate response size", async () => {
    for (const [chunk, expectedError] of [
      [Uint8Array.of(32), "fragmentation"],
      [new Uint8Array(600000), "byte limit"],
    ] as const) {
      let pulls = 0;
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          controller.enqueue(chunk);
        },
        cancel,
      });
      await expect(
        boundedGatewayJson(
          "https://gateway.example/read",
          async () => new Response(stream),
          { timeoutMs: 60_000 },
        ),
      ).rejects.toThrow(expectedError);
      expect(pulls).toBeLessThanOrEqual(4099);
      expect(cancel).toHaveBeenCalledTimes(1);
    }
  });
  it("rejects abort and invalid timeout before calling transport", async () => {
    const transport = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await expect(
      boundedGatewayJson("https://gateway.example/read", transport, {
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    for (const timeoutMs of [0, -1, 1.5, 60_001])
      await expect(
        boundedGatewayJson("https://gateway.example/read", transport, {
          timeoutMs,
        }),
      ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it("bounds stalled headers even when custom transport ignores abort", async () => {
    vi.useFakeTimers();
    const transport = vi.fn<ExchangeHttpTransport>(
      () => new Promise<Response>(() => {}),
    );
    const pending = boundedGatewayJson(
      "https://gateway.example/read",
      transport,
      { timeoutMs: 20 },
    );
    const outcome = expect(pending).rejects.toThrow("deadline");
    await vi.advanceTimersByTimeAsync(20);
    await outcome;
    expect(transport.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it("bounds slow bodies with the same deadline and cancels their reader", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"data":'));
      },
      cancel,
    });
    const pending = boundedGatewayJson(
      "https://gateway.example/read",
      async () => new Response(stream),
      { timeoutMs: 20 },
    );
    const outcome = expect(pending).rejects.toThrow("deadline");
    await vi.advanceTimersByTimeAsync(20);
    await outcome;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("honors parent abort after headers without retaining the caller listener", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const pending = boundedGatewayJson(
      "https://gateway.example/read",
      async () => {
        queueMicrotask(() => controller.abort());
        return new Response(new ReadableStream({ cancel }));
      },
      { signal: controller.signal },
    );
    await expect(pending).rejects.toThrow("cancelled");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("bounds a stalled prepare step with the read deadline", async () => {
    vi.useFakeTimers();
    const transport = vi.fn<ExchangeHttpTransport>();
    const pending = boundedGatewayJson(
      "https://gateway.example/read",
      transport,
      { timeoutMs: 20 },
      { prepare: () => new Promise<void>(() => {}) },
    );
    const outcome = expect(pending).rejects.toThrow("deadline");
    await vi.advanceTimersByTimeAsync(20);
    await outcome;
    expect(transport).not.toHaveBeenCalled();
  });
  it("honors parent abort during a stalled prepare step", async () => {
    const controller = new AbortController();
    const transport = vi.fn<ExchangeHttpTransport>();
    const pending = boundedGatewayJson(
      "https://gateway.example/read",
      transport,
      { signal: controller.signal },
      { prepare: () => new Promise<void>(() => {}) },
    );
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(transport).not.toHaveBeenCalled();
  });
  it("sends owner-scoped reads on the account lane and others on the query lane", async () => {
    const transport = vi.fn<ExchangeHttpTransport>(
      async () => new Response("{}"),
    );
    await boundedGatewayJson(
      "https://gateway.example/read",
      transport,
      {},
      {
        purpose: "account",
      },
    );
    await boundedGatewayJson("https://gateway.example/read", transport, {});
    expect(transport.mock.calls.map((call) => call[2]?.priority)).toEqual([
      "urgent",
      "critical",
    ]);
  });
  it("rejects oversized, malformed, truncated, duplicate and invalid UTF-8 bodies", async () => {
    for (const response of [
      new Response("{}", { headers: { "content-length": "1048577" } }),
      new Response(" ".repeat(1048577)),
      new Response('{"fills":['),
      new Response('{"data":1,"data":2}'),
      new Response('{"witness":{"height":"1","height":"2"}}'),
      new Response('{"fills":[{"maker_owner":"aa","maker_owner":"bb"}]}'),
      new Response('{"witness":{"height":"1","hei\\u0067ht":"2"}}'),
      new Response(Uint8Array.of(255)),
    ])
      await expect(
        boundedGatewayJson(
          "https://gateway.example/read",
          async () => response,
          {},
        ),
      ).rejects.toThrow();
  });
  it("does not retry HTTP errors and releases resources after success", async () => {
    const transport = vi.fn(
      async () => new Response("failure", { status: 503 }),
    );
    await expect(
      boundedGatewayJson("https://gateway.example/read", transport, {}),
    ).rejects.toMatchObject({ status: 503 });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(
      await boundedGatewayJson(
        "https://gateway.example/read",
        async () => new Response('{"fills":[],"next_cursor":""}'),
        {},
      ),
    ).toEqual({ fills: [], next_cursor: "" });
  });
});
