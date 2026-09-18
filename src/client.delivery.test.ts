import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExchangeClient,
  Side,
  sign,
  getPublicKey,
  pubkeyToOwner,
  type Action,
} from "./index.js";
const key = new Uint8Array(32).fill(13);
const publicKey = getPublicKey(key);
const action: Action = {
  type: "PlaceOrder",
  data: {
    owner: pubkeyToOwner(publicKey),
    market: 3,
    side: Side.Buy,
    price: 78_451_952n,
    quantity: 400n,
  },
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
function external() {
  const client = new ExchangeClient({
    gatewayUrl: "",
    chainId: "exchange-devnet-1",
  });
  client.setExternalSigner({
    publicKey,
    signRaw: async (msg) => sign(key, msg),
  });
  client.setUnsafeFastSubmit(true);
  return client;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("gateway finality", () => {
  it.each([
    [200, "invalid signature", 1],
    [200, "invalid action parameters", 1],
    [503, "service overloaded", 503],
    [503, "service unavailable", 503],
  ])(
    "keeps hashless HTTP %i refusal terminal (%s)",
    async (status, reason, code) => {
      const fetch = vi.fn(async (_url: string) =>
        json({ status: "error", error: reason }, Number(status)),
      );
      vi.stubGlobal("fetch", fetch);
      const client = external();
      // Normal submitTx must not spawn a verifier for a proven refusal.
      client.setUnsafeFastSubmit(false);
      const result = await client.submitTx(action);
      expect(result).toMatchObject({
        ok: false,
        outcome: "transport",
        code,
        log: reason,
        hash: "",
        error: null,
      });
      expect(await client.waitForDelivery(result)).toBe(result);
      expect(await client.awaitPendingVerifies()).toEqual([]);
      expect(await client.submitTxCommit(action)).toMatchObject({
        outcome: "transport",
        code,
        log: reason,
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls.every(([url]) => url === "/exchange")).toBe(true);
    },
  );

  it.each(["paused", "cancel-only"])(
    "keeps maintenance mode %s refusal terminal",
    async (mode) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          json(
            {
              status: "error",
              error: "maintenance: signed writes are not open",
              mode,
            },
            503,
          ),
        ),
      );
      expect(await external().submitTx(action)).toMatchObject({
        outcome: "transport",
        code: 503,
        log: "maintenance: signed writes are not open",
        hash: "",
      });
    },
  );

  it.each([
    [
      200,
      { status: "error", error: "outcome unknown", txHash: "A".repeat(64) },
    ],
    [
      503,
      { status: "error", error: "outcome unknown", txHash: "A".repeat(64) },
    ],
    [502, { status: "error", error: "upstream unavailable" }],
    [504, { status: "error", error: "deadline exceeded" }],
    [503, { error: "proxy failure" }],
    [503, { status: "error", error: "" }],
    [503, { status: "error", error: "   " }],
    [503, "service overloaded"],
    [503, []],
    [503, { status: "error", error: "unknown", txHash: null }],
    [503, { status: "error", error: "unknown", txHash: "" }],
    [503, { status: "error", error: "unknown", code: 12 }],
    [503, { status: "error", error: "unknown", height: 42 }],
    [200, { status: "error", error: "unknown", log: "nonce too old" }],
    [503, { status: "error", error: "service overloaded", retryAfterMs: 500 }],
    [200, { status: "error", error: "unknown", events: [] }],
    [200, { status: "error", error: "unknown", code: "12" }],
    [503, { status: "error", error: "invalid signature" }],
    [
      503,
      {
        status: "error",
        error: "position-trigger activation status is unavailable",
      },
    ],
    [503, { status: "error", error: "unknown edge failure" }],
    [200, { status: "error", error: "unknown edge failure" }],
    [
      503,
      { status: "error", error: "service overloaded", info: "outcome unknown" },
    ],
    [200, { status: "error", error: "invalid signature", txHash: null }],
  ])("reconciles HTTP %i ambiguous envelope %j", async (status, body) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(body, Number(status)))
      .mockResolvedValue(
        json({ result: { height: "44", tx_result: { code: 0 } } }),
      );
    vi.stubGlobal("fetch", fetch);
    const client = external();
    const result = await client.submitTx(action);
    expect(result.outcome).toBe("timeout");
    expect(result.hash).toMatch(/^[0-9A-F]{64}$/);
    expect(await client.waitForDelivery(result)).toMatchObject({
      outcome: "ok",
      height: 44,
    });
    expect(
      fetch.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(fetch.mock.calls[1][0]).toBe(`/v1/tx/${result.hash}`);
  });

  it("keeps an unstructured 503 uncertain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("service overloaded", { status: 503 })),
    );
    expect(await external().submitTx(action)).toMatchObject({
      outcome: "timeout",
      hash: expect.stringMatching(/^[0-9A-F]{64}$/),
    });
  });

  it("retains legacy numeric engine rejections", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({ status: "error", error: "12: insufficient margin" }),
      ),
    );
    expect(await external().submitTx(action)).toMatchObject({
      outcome: "engine",
      code: 12,
      log: "12: insufficient margin",
    });
  });

  it.each([401, 413, 429])("keeps HTTP %i terminal", async (status) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(json({ error: "rejected" }, status));
    vi.stubGlobal("fetch", fetch);
    const client = external();
    const result = await client.submitTx(action);
    expect(result.outcome).toBe("transport");
    expect(await client.waitForDelivery(result)).toBe(result);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["network", "5xx", "malformed"])(
    "reconciles %s ambiguity by hash without retrying submission",
    async (kind) => {
      const fetch = vi
        .fn()
        .mockImplementationOnce(() =>
          kind === "network"
            ? Promise.reject(new Error("offline"))
            : Promise.resolve(
                kind === "5xx" ? json({}, 502) : new Response("oops"),
              ),
        )
        .mockResolvedValue(
          json({
            result: { height: "44", tx_result: { code: 0, events: [] } },
          }),
        );
      vi.stubGlobal("fetch", fetch);
      const client = external();
      const admitted = await client.submitTx(action);
      expect(admitted.outcome).toBe("timeout");
      expect(admitted.hash).toMatch(/^[0-9A-F]{64}$/);
      const delivered = await client.waitForDelivery(admitted, {
        timeoutMs: 20000,
      });
      expect(delivered).toMatchObject({
        outcome: "ok",
        height: 44,
        hash: admitted.hash,
      });
      expect(
        fetch.mock.calls.filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(1);
      expect(fetch.mock.calls[1][0]).toBe(`/v1/tx/${admitted.hash}`);
    },
  );
  it("keeps concurrent hash results separate and cancellation unknown", async () => {
    const fetch = vi.fn(async (url: string) =>
      json({
        result: {
          height: "45",
          tx_result: { code: url.endsWith("A") ? 0 : 12 },
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const client = external();
    const base = {
      ok: false,
      outcome: "timeout" as const,
      code: -1,
      error: null,
    };
    const [a, b] = await Promise.all(
      ["A", "B"].map((hash) =>
        client.waitForDelivery({ ...base, hash }, { timeoutMs: 1000 }),
      ),
    );
    expect(a.outcome).toBe("ok");
    expect(b.outcome).toBe("engine");
    const signal = AbortSignal.abort();
    expect(
      await client.waitForDelivery({ ...base, hash: "C" }, { signal }),
    ).toMatchObject({ outcome: "timeout", hash: "C" });
    expect(
      await client.waitForDelivery({ ...base, hash: "D" }, { timeoutMs: 0 }),
    ).toMatchObject({ outcome: "timeout", hash: "D" });
  });
});

describe("optional DeliverTx info", () => {
  it.each([0, 12])(
    "preserves inline info without changing verdict code %i",
    async (code) => {
      const fetch = vi.fn().mockResolvedValue(
        json({
          code,
          height: 42,
          log: "authoritative log",
          info: "diagnostic only",
          events: [],
        }),
      );
      vi.stubGlobal("fetch", fetch);
      const client = external();
      const result = await client.submitTxCommit(action);
      expect(result).toMatchObject({
        code,
        height: 42,
        log: "authoritative log",
        info: "diagnostic only",
        outcome: code === 0 ? "ok" : "engine",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each([0, 12])(
    "preserves per-hash polling info for code %i",
    async (code) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(json({ status: "ok" }))
        .mockResolvedValue(
          json({
            result: {
              height: "43",
              tx_result: { code, log: "log", info: "poll info" },
            },
          }),
        );
      vi.stubGlobal("fetch", fetch);
      const client = external();
      const admitted = await client.submitTx(action);
      expect(admitted.info).toBeUndefined();
      expect(await client.waitForDelivery(admitted)).toMatchObject({
        code,
        hash: admitted.hash,
        info: "poll info",
      });
    },
  );
  it("preserves empty info in the background verifier", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ status: "ok" }))
      .mockResolvedValue(
        json({
          result: {
            height: "44",
            tx_result: { code: 12, log: "rejected", info: "" },
          },
        }),
      );
    vi.stubGlobal("fetch", fetch);
    const client = external();
    client.setUnsafeFastSubmit(false);
    const admitted = await client.submitTx(action);
    expect(await client.awaitPendingVerifies()).toEqual([
      expect.objectContaining({ code: 12, hash: admitted.hash, info: "" }),
    ]);
  });
});

describe("delivery polling", () => {
  it.each([{}, { code: "12" }])(
    "per-hash and background paths agree for %j",
    async (exec) => {
      const fetch = vi.fn().mockImplementation(async (url: string) =>
        url.endsWith("/exchange")
          ? json({ status: "ok" })
          : json({
              result: { height: "42", tx_result: { ...exec, info: "kept" } },
            }),
      );
      vi.stubGlobal("fetch", fetch);
      const c = external();
      const first = await c.submitTx(action);
      const direct = await c.waitForDelivery(first);
      c.setUnsafeFastSubmit(false);
      await c.submitTx(action);
      const background = await c.awaitPendingVerifies();
      expect(background[0]).toMatchObject({
        code: direct.code,
        outcome: direct.outcome,
        info: "kept",
      });
      expect(
        fetch.mock.calls.filter(([u]) => u.endsWith("/exchange")),
      ).toHaveLength(2);
    },
  );
  it("keeps malformed responses uncertain instead of fabricating success", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ result: { tx_result: [] } })),
    );
    const c = external();
    const result = c.waitForDelivery(
      { ok: false, outcome: "timeout", code: -1, error: null, hash: "X" },
      { timeoutMs: 500 },
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toMatchObject({ outcome: "timeout", hash: "X" });
  });
  it("aborts a polling sleep immediately and supports old AbortSignal runtimes", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "any").mockImplementation(() => {
      throw new Error("not supported");
    });
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      throw new Error("not supported");
    });
    const fetch = vi.fn(async () => json({ result: { tx_result: {} } }));
    vi.stubGlobal("fetch", fetch);
    const c = external();
    const controller = new AbortController();
    const pending = c.waitForDelivery(
      { ok: false, outcome: "timeout", code: -1, error: null, hash: "X" },
      { signal: controller.signal },
    );
    controller.abort();
    expect(await pending).toMatchObject({ outcome: "timeout", hash: "X" });
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const success = c.waitForDelivery(
      { ok: false, outcome: "timeout", code: -1, error: null, hash: "Y" },
      { signal: new AbortController().signal },
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(await success).toMatchObject({ code: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves 5xx diagnostics and the unknown transaction hash", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({ error: "upstream temporarily unavailable" }, 502),
      ),
    );
    const c = external();
    const result = await c.submitTx(action);
    expect(result.outcome).toBe("timeout");
    expect(result.log).toContain("upstream temporarily unavailable");
    expect(result.hash).toHaveLength(64);
  });
});
it.each([false, true])(
  "keeps a parsed verdict after deadline but honors caller abort=%s",
  async (cancel) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let finish!: (value: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      })),
    );
    const pending = external().waitForDelivery(
      { ok: false, outcome: "timeout", code: -1, error: null, hash: "RACE" },
      { timeoutMs: 500, signal: controller.signal },
    );
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(301);
    if (cancel) controller.abort();
    finish({ result: { height: "8", tx_result: { info: "parsed" } } });
    expect(await pending).toMatchObject(
      cancel
        ? { outcome: "timeout", hash: "RACE" }
        : { code: 0, height: 8, info: "parsed", hash: "RACE" },
    );
    expect(vi.getTimerCount()).toBe(0);
  },
);
