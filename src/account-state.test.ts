import { Encoder } from "@msgpack/msgpack";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeAccountState, ExchangeClient } from "./index.js";

const owner = Array(20).fill(4);
const hex = "04".repeat(20);
const raw = (): unknown[] => [
  owner,
  (1n << 63n) + 1n,
  (1n << 64n) - 1n,
  [[owner, 1, "Sell", 42, 7, -(1n << 63n)]],
];
describe("raw finalized account state", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("preserves exact entry cost and defaults legacy remainders to zero", () => {
    const r = raw();
    (r[3] as unknown[][])[0].push(6n);
    const p = decodeAccountState(r, hex).positions[0];
    expect(p.entryRemainder).toBe(6n);
    expect(p.entryPrice * p.size + p.entryRemainder).toBe(300n);
    expect(decodeAccountState(raw(), hex).positions[0].entryRemainder).toBe(0n);
  });
  it.each([-1n, 7n, 1n << 64n, null, undefined, Number.MAX_SAFE_INTEGER + 1])(
    "rejects malformed exact-cost remainders: %s",
    (remainder) => {
      const r = raw();
      (r[3] as unknown[][])[0].push(remainder);
      expect(() => decodeAccountState(r, hex)).toThrow("entry remainder");
    },
  );
  it("rejects unknown position extensions", () => {
    const r = raw();
    (r[3] as unknown[][])[0].push(0n, 1n);
    expect(() => decodeAccountState(r, hex)).toThrow("position");
  });
  it("preserves full integer precision and exposes no fabricated valuation", () => {
    expect(decodeAccountState(raw(), hex)).toEqual({
      owner: hex,
      finalizedHeight: (1n << 63n) + 1n,
      balance: (1n << 64n) - 1n,
      positions: [
        {
          owner: hex,
          market: 1,
          side: "Sell",
          entryPrice: 42n,
          size: 7n,
          lastFundingIndex: -(1n << 63n),
          entryRemainder: 0n,
        },
      ],
    });
    expect(decodeAccountState([owner, 1, 0, []]).positions).toEqual([]);
  });
  it("reads the entry remainder wire 8 appends when it is non-zero", () => {
    // buy 1 @ 100 then buy 2 @ 101: cost 302 over size 3 is 100 rem 2.
    const r = [owner, 1, 0, [[owner, 1, "Buy", 100, 3, 0, 2]]];
    expect(decodeAccountState(r, hex).positions[0]).toMatchObject({
      entryPrice: 100n,
      size: 3n,
      entryRemainder: 2n,
    });
  });
  it.each([
    (r: unknown[]) => r.push(0),
    (r: unknown[]) => {
      r[1] = Number.MAX_SAFE_INTEGER + 1;
    },
    (r: unknown[]) => {
      r[2] = -1;
    },
    (r: unknown[]) => {
      r[0] = Array(19).fill(4);
    },
    (r: unknown[]) => {
      (r[3] as unknown[][])[0][0] = Array(20).fill(5);
    },
    (r: unknown[]) => {
      (r[3] as unknown[][])[0][2] = "Unknown";
    },
    (r: unknown[]) => {
      (r[3] as unknown[][])[0][5] = 1n << 63n;
    },
    (r: unknown[]) => {
      (r[3] as unknown[][]).push((r[3] as unknown[][])[0]);
    },
    (r: unknown[]) => {
      (r[3] as unknown[][])[0].push(-1);
    },
    (r: unknown[]) => {
      (r[3] as unknown[][])[0].push(0, 0);
    },
  ])("rejects malformed or mismatched ledger facts", (change) => {
    const r = raw();
    change(r);
    expect(() => decodeAccountState(r, hex)).toThrow("account state decode");
  });
  it("uses the canonical gateway route and checks returned owner", async () => {
    const data = Buffer.from(
      new Encoder({ useBigInt64: true }).encode(raw()),
    ).toString("base64");
    const fetch = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ data })));
    vi.stubGlobal("fetch", fetch);
    const client = new ExchangeClient({
      gatewayUrl: "http://gateway",
      apiUrl: "http://node",
      chainId: "test",
    });
    expect((await client.queryAccountState(hex)).balance).toBe(
      (1n << 64n) - 1n,
    );
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `http://gateway/v1/account/${hex}/state`,
    );
    await expect(client.queryAccountState("05".repeat(20))).rejects.toThrow(
      "owner binding",
    );
    await expect(client.queryAccountState("bad")).rejects.toThrow(
      "40-character",
    );
    await expect(client.queryAccountState()).rejects.toThrow("40-character");
  });
  it("propagates upstream unavailability, never substitutes empty state", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ error: "committed account state unavailable" }),
            { status: 503 },
          ),
        ),
    );
    const client = new ExchangeClient({
      gatewayUrl: "http://gateway",
      chainId: "test",
    });
    await expect(client.queryAccountState(hex)).rejects.toThrow(
      "committed account state unavailable",
    );
  });
});
