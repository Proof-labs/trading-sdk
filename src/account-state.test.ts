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
        },
      ],
    });
    expect(decodeAccountState([owner, 1, 0, []]).positions).toEqual([]);
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
