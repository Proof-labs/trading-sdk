import { afterEach, describe, expect, it, vi } from "vitest";
import { encode } from "@msgpack/msgpack";
import { ExchangeClient } from "./client.js";
import {
  decodeLiquidationPlan,
  fetchLiquidationPlan,
} from "./liquidation-plan.js";

const owner = "ab".repeat(20);
const U64 = (1n << 64n) - 1n;
function row(): unknown[] {
  return [
    1,
    120n,
    1_000n,
    new Uint8Array(20).fill(0xab),
    [
      7n,
      9n,
      new Uint8Array(32).fill(3),
      2n,
      100n,
      110n,
      101n,
      5n,
      "AbsoluteExpired",
      false,
      20n,
      8n,
    ],
  ];
}
function response(value: unknown = row()): Response {
  return Response.json({
    data: Buffer.from(encode(value, { useBigInt64: true })).toString("base64"),
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("bounded liquidation plan evidence", () => {
  it("preserves owner, checkpoint and original versus current windows", () => {
    const raw = row();
    const result = decodeLiquidationPlan(raw, owner.toUpperCase());
    expect(result).toMatchObject({
      format: 1,
      owner,
      finalizedHeight: 120n,
      active: {
        planId: 7n,
        windowGeneration: 2n,
        originalAdmissionHeight: 20n,
        executionWindowHeight: 100n,
        disposition: "AbsoluteExpired",
        lastFillId: 8n,
      },
    });
    ((raw[4] as unknown[])[2] as Uint8Array)[0] = 0;
    expect(result.active!.checkpointHash[0]).toBe(3);
    raw[4] = null;
    expect(decodeLiquidationPlan(raw, owner).active).toBeNull();
  });
  it("does not narrow full-width integers", () => {
    const raw = row();
    raw[1] = U64;
    raw[2] = U64;
    const plan = raw[4] as unknown[];
    plan[0] = U64;
    plan[1] = U64;
    plan[3] = U64;
    plan[11] = U64;
    expect(decodeLiquidationPlan(raw, owner).active!.lastFillId).toBe(U64);
  });
  it("rejects corrupt identities, widths and inconsistent windows instead of absence", () => {
    const changes: Array<(r: unknown[]) => void> = [
      (r) => {
        r[0] = 2;
      },
      (r) => {
        r.push(1);
      },
      (r) => {
        r[2] = 0;
      },
      (r) => {
        r[3] = new Uint8Array(20);
      },
      (r) => {
        r[4] = undefined;
      },
      (r) => {
        r[1] = Number.MAX_SAFE_INTEGER + 1;
      },
      (r) => {
        r[1] = -1n;
      },
      (r) => {
        r[1] = U64 + 1n;
      },
      ...[
        [0, 0n],
        [1, 0n],
        [2, new Uint8Array(31)],
        [3, 1.5],
        [4, 102n],
        [5, 100n],
        [6, 121n],
        [7, 0n],
        [8, "Expired"],
        [9, 1],
        [10, 101n],
        [11, -1n],
      ].map(([index, value]) => (r: unknown[]) => {
        (r[4] as unknown[])[index as number] = value;
      }),
    ];
    for (const mutate of changes) {
      const raw = row();
      mutate(raw);
      expect(() => decodeLiquidationPlan(raw, owner)).toThrow(
        /liquidation plan/,
      );
    }
  });
  it("uses only the gateway exact owner route, without submission or fallback", async () => {
    const fetch = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetch);
    const client = new ExchangeClient({
      gatewayUrl: "https://gateway.example",
      chainId: "test",
    });
    expect(
      (await client.queryLiquidationPlan(owner.toUpperCase())).active!.planId,
    ).toBe(7n);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `https://gateway.example/v1/liquidation/plan?owner=${owner}`,
      expect.objectContaining({
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
    for (const invalid of [`0x${owner}`, `${owner}&owner=x`, "", "ff"]) {
      await expect(client.queryLiquidationPlan(invalid)).rejects.toThrow(
        /owner/,
      );
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("fails on upstream errors rather than returning null", async () => {
    const fetch = vi.fn(
      async () => new Response("unavailable", { status: 503 }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      fetchLiquidationPlan("https://gateway.example", owner),
    ).rejects.toThrow("HTTP 503");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("bounds streamed bytes, advertised size and MessagePack collections", async () => {
    for (const make of [
      () => new Response("x", { headers: { "content-length": "4097" } }),
      () => new Response("x".repeat(4097)),
      () => Response.json({ data: "A".repeat(2052) }),
      () => response(Array(33).fill(0)),
      () => response({ unexpected: true }),
      () => response(new Uint8Array(33)),
      () => Response.json({ data: "gAA=" }),
      () => Response.json({ data: "wA==", extra: true }),
      () => Response.json({ data: "wB==" }),
      () => new Response(new Uint8Array([0xff])),
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => make()),
      );
      await expect(
        fetchLiquidationPlan("https://gateway.example", owner),
      ).rejects.toThrow();
    }
  });
  it("times out a stalled read without trying another endpoint", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const result = expect(
      fetchLiquidationPlan("https://gateway.example", owner),
    ).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(5000);
    await result;
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
