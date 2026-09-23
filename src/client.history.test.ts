import { afterEach, describe, expect, it, vi } from "vitest";
import { ExchangeClient } from "./client.js";
import type { HistoryPositionsPage } from "./index.js";

const owner = "ab".repeat(20);
const client = () =>
  new ExchangeClient({ gatewayUrl: "http://gateway", chainId: "test" });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

afterEach(() => vi.unstubAllGlobals());

// The indexer serves entry_px/block_time, not the retired entry_price/timestamp.
const position = {
  owner,
  market: 7,
  block_height: 42,
  block_time: "2026-09-16T08:00:00.123456789Z",
  side: "buy",
  size: "200",
  entry_px: "9007199254740993.000000",
};

describe("position history pages", () => {
  it("preserves prices, exact block time, null close fields and the opaque cursor", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json({ positions: [position], next_cursor: "opaque+/=" }),
      )
      .mockResolvedValueOnce(
        json({
          positions: [{ ...position, side: null, entry_px: null, size: "0" }],
          next_cursor: "",
        }),
      );
    vi.stubGlobal("fetch", fetch);
    const c = client();
    const opts = {
      market: 7,
      fromMs: 1789540000000,
      toMs: 1789550000000,
      limit: 1,
    };
    const first: HistoryPositionsPage = await c.queryHistoryPositionsPage(
      `0x${owner.toUpperCase()}`,
      opts,
    );
    expect(first).toEqual({
      positions: [
        {
          owner,
          market: 7,
          side: "buy",
          size: "200",
          entryPrice: "9007199254740993.000000",
          blockHeight: 42,
          blockTime: position.block_time,
        },
      ],
      nextCursor: "opaque+/=",
    });
    const last = await c.queryHistoryPositionsPage(owner, {
      ...opts,
      cursor: first.nextCursor,
    });
    expect(last).toMatchObject({
      positions: [{ side: null, entryPrice: null, size: "0" }],
      nextCursor: "",
    });
    const url = new URL(fetch.mock.calls[1][0]);
    expect(url.pathname).toBe(`/v1/history/positions/${owner}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      from: "1789540000000",
      to: "1789550000000",
      limit: "1",
      market: "7",
      cursor: "opaque+/=",
    });
  });

  it("keeps the array API and maps absent close fields to documented empty strings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () =>
        json({
          positions: [
            position,
            { ...position, side: null, entry_px: null, size: "0" },
          ],
          next_cursor: "more",
        }),
      ),
    );
    const rows = await client().queryHistoryPositions(owner);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows[0]).toEqual({
      owner,
      market: "7",
      side: "buy",
      size: "200",
      entryPrice: "9007199254740993.000000",
      blockHeight: 42,
      timestamp: 1789545600123,
    });
    expect(rows[1]).toMatchObject({ side: "", entryPrice: "", size: "0" });
  });

  it("keeps indexer history on the gateway even in internal node mode", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(json({ positions: [], next_cursor: "" }));
    vi.stubGlobal("fetch", fetch);
    const c = new ExchangeClient({
      gatewayUrl: "http://gateway",
      apiUrl: "http://node",
      useGateway: false,
    });
    expect(await c.queryHistoryPositionsPage()).toEqual({
      positions: [],
      nextCursor: "",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(await c.queryHistoryPositionsPage(owner)).toEqual({
      positions: [],
      nextCursor: "",
    });
    expect(fetch.mock.calls[0][0]).toBe(
      `http://gateway/v1/history/positions/${owner}`,
    );
  });

  it.each([
    { positions: [position], next_cursor: null },
    { positions: null, next_cursor: "" },
    { positions: [{ ...position, owner: "cd".repeat(20) }], next_cursor: "" },
    { positions: [{ ...position, market: 8 }], next_cursor: "" },
    {
      positions: [{ ...position, entry_px: 9007199254740992 }],
      next_cursor: "",
    },
    { positions: [{ ...position, side: null }], next_cursor: "" },
    { positions: [{ ...position, block_time: "not a time" }], next_cursor: "" },
    {
      positions: [{ ...position, block_height: Number.MAX_SAFE_INTEGER + 1 }],
      next_cursor: "",
    },
  ])("rejects malformed or mismatched position history", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(body)));
    await expect(
      client().queryHistoryPositionsPage(owner, { market: 7 }),
    ).rejects.toThrow();
  });

  it("propagates gateway failure rather than returning an empty page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ error: "indexer unavailable" }, 503)),
    );
    await expect(client().queryHistoryPositionsPage(owner)).rejects.toThrow(
      "indexer unavailable",
    );
  });

  it.each([
    { limit: 0 },
    { limit: 5001 },
    { market: -1 },
    { fromMs: 2, toMs: 1 },
  ])("rejects invalid filters before fetching", async (opts) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      client().queryHistoryPositionsPage(owner, opts),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

// Shape emitted by the indexer's account-events route; payload values are strings.
const event = (
  kind: string,
  id: number,
  blockTime: string,
  payload: object,
) => ({
  event_id: id,
  owner,
  event_type: kind,
  block_height: 42,
  block_time: blockTime,
  payload,
});

describe("cash-flow history through account events", () => {
  it("includes direct deposits and merges them with custody deposits before capping", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const kind = new URL(input).searchParams.get("event_type")!;
        const direct = kind === "deposited";
        return json({
          account_events: [
            event(
              kind,
              direct ? 2 : 1,
              direct
                ? "2026-07-03T04:55:00.892279Z"
                : "2026-07-01T11:08:22.855363Z",
              { owner, amount: "10000000000", new_balance: "19998709862" },
            ),
          ],
          next_cursor: "",
        });
      }),
    );
    const rows = await client().queryHistoryDeposits(owner, { limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "deposited",
      amount: "10000000000",
      signedDelta: "10000000000",
      newBalance: "19998709862",
      withdrawalId: "",
      solanaTxSig: "",
    });
  });

  it("preserves direct withdrawal amounts and their exact fee-free event debit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const kind = new URL(input).searchParams.get("event_type")!;
        return json({
          account_events:
            kind === "withdrawn"
              ? [
                  event(kind, 1, "2026-09-16T08:00:00Z", {
                    owner,
                    amount: "9007199254740993",
                    new_balance: "10",
                  }),
                ]
              : [],
          next_cursor: "",
        });
      }),
    );
    expect(await client().queryHistoryWithdrawals(owner)).toMatchObject([
      {
        kind: "withdrawn",
        amount: "9007199254740993",
        signedDelta: "-9007199254740993",
        newBalance: "10",
        withdrawalId: "",
      },
    ]);
  });

  it("reads deposits through the gateway with bound owner, range and event type", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ account_events: [], next_cursor: "" }))
      .mockResolvedValueOnce(
        json({
          account_events: [
            event("deposit_confirmed", 9, "2026-09-16T08:00:00.123456789Z", {
              owner,
              amount: "9007199254740993",
              new_balance: "9007199254740994",
              solana_tx_sig: "deposit-tx",
            }),
          ],
          next_cursor: "",
        }),
      );
    vi.stubGlobal("fetch", fetch);
    const c = new ExchangeClient({
      gatewayUrl: "http://gateway",
      apiUrl: "http://node",
      useGateway: false,
    });
    const rows = await c.queryHistoryDeposits(`0x${owner.toUpperCase()}`, {
      fromMs: 1,
      toMs: 2,
      limit: 10,
    });
    const url = new URL(fetch.mock.calls[1][0]);
    expect(url.origin + url.pathname).toBe(
      "http://gateway/v1/history/account-events",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      from: "1",
      to: "2",
      limit: "10",
      owner,
      order: "desc",
      event_type: "deposit_confirmed",
    });
    expect(rows).toEqual([
      {
        kind: "deposit_confirmed",
        owner,
        amount: "9007199254740993",
        signedDelta: "9007199254740993",
        newBalance: "9007199254740994",
        withdrawalId: "",
        solanaTxSig: "deposit-tx",
        solanaDestination: "",
        reason: "",
        blockHeight: 42,
        timestamp: 1789545600123,
      },
    ]);
  });

  it("merges withdrawal kinds in nanosecond/event order and applies the total limit", async () => {
    const calls: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = new URL(input);
        calls.push(url);
        const kind = url.searchParams.get("event_type")!;
        const rows = {
          withdraw_requested: [
            event(kind, 5, "2026-09-16T08:00:00.123100Z", {
              amount: "80",
              withdrawal_id: "3",
              solana_destination: "destination",
            }),
          ],
          withdrawal_confirmed: [
            event(kind, 9, "2026-09-16T08:00:00.123200Z", {
              withdrawal_id: "3",
              solana_tx_sig: "withdrawal-tx",
            }),
          ],
          withdrawal_failed: [
            event(kind, 8, "2026-09-16T08:00:00.123200Z", {
              owner,
              amount: "90",
              withdrawal_id: "2",
              new_balance: "500",
              reason: "transfer failed",
            }),
          ],
        };
        return json({
          account_events: rows[kind as keyof typeof rows] ?? [],
          next_cursor: "",
        });
      }),
    );
    const rows = await client().queryHistoryWithdrawals(owner, {
      limit: 2,
      fromMs: 1,
      toMs: 2,
    });
    expect(calls).toHaveLength(4);
    for (const url of calls) {
      expect(url.searchParams.get("owner")).toBe(owner);
      expect(url.searchParams.get("order")).toBe("desc");
      expect(url.searchParams.get("limit")).toBe("2");
      expect(url.searchParams.get("from")).toBe("1");
      expect(url.searchParams.get("to")).toBe("2");
    }
    expect(rows.map((row) => row.kind)).toEqual([
      "withdrawal_confirmed",
      "withdrawal_failed",
    ]);
    expect(rows[0]).toMatchObject({
      amount: "",
      signedDelta: "0",
      newBalance: "",
      withdrawalId: "3",
    });
    expect(rows[1]).toMatchObject({
      amount: "90",
      signedDelta: "",
      newBalance: "500",
      withdrawalId: "2",
    });
  });

  it("does not infer the withdrawal debit from a principal-only event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const kind = new URL(input).searchParams.get("event_type");
        return json({
          account_events:
            kind === "withdraw_requested"
              ? [
                  event(kind, 1, "2026-09-16T08:00:00Z", {
                    owner,
                    amount: "100",
                    withdrawal_id: "4",
                    solana_destination: "destination",
                  }),
                ]
              : [],
          next_cursor: "",
        });
      }),
    );
    expect(await client().queryHistoryWithdrawals(owner)).toMatchObject([
      {
        kind: "withdraw_requested",
        amount: "100",
        signedDelta: "",
        newBalance: "",
      },
    ]);
  });

  it("propagates a failed withdrawal-kind request instead of returning partial history", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        new URL(input).searchParams.get("event_type") === "withdrawal_failed"
          ? json({ error: "history unavailable" }, 503)
          : json({ account_events: [], next_cursor: "" }),
      ),
    );
    await expect(client().queryHistoryWithdrawals(owner)).rejects.toThrow(
      "history unavailable",
    );
  });

  it.each([
    { account_events: [], next_cursor: null },
    { account_events: null, next_cursor: "" },
    {
      account_events: [
        {
          ...event("deposit_confirmed", 1, "2026-09-16T08:00:00Z", {
            amount: "1",
          }),
          owner: "cd".repeat(20),
        },
      ],
      next_cursor: "",
    },
    {
      account_events: [
        event("withdraw_requested", 1, "2026-09-16T08:00:00Z", { amount: "1" }),
      ],
      next_cursor: "",
    },
    {
      account_events: [
        event("deposit_confirmed", 1, "2026-09-16T08:00:00Z", {
          amount: 9007199254740992,
        }),
      ],
      next_cursor: "",
    },
  ])("rejects malformed or cross-owner cash-flow data", async (body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        json(
          new URL(input).searchParams.get("event_type") === "deposit_confirmed"
            ? body
            : { account_events: [], next_cursor: "" },
        ),
      ),
    );
    await expect(client().queryHistoryDeposits(owner)).rejects.toThrow();
  });

  it("distinguishes successful emptiness and an unbound client from failed reads", async () => {
    const fetch = vi.fn(async () =>
      json({ account_events: [], next_cursor: "" }),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await client().queryHistoryDeposits()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(await client().queryHistoryDeposits(owner)).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("resolution history", () => {
  const settled = {
    kind: "conditional_settled",
    event_id: "42",
    market: "100",
    owner,
    side: "buy",
    size: "25",
    entry_price: "101000000",
    settlement_price: "105000000",
    realized_pnl: "100000000",
    block_height: 100,
    timestamp: 1776630600000,
  };

  it("maps a converted winner and a winner paid in cash with its reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        json([
          { ...settled, converted_size: "25", fallback_reason: "" },
          {
            ...settled,
            converted_size: "0",
            fallback_reason: "initial_margin",
          },
        ]),
      ),
    );
    const [converted, cash] = await client().queryHistoryResolutions(owner);
    expect(converted.convertedSize).toBe("25");
    expect(converted.fallbackReason).toBe("");
    expect(cash.convertedSize).toBe("0");
    expect(cash.fallbackReason).toBe("initial_margin");
  });

  it("reads a row without the conversion keys as paid in cash", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json([settled])));
    const [row] = await client().queryHistoryResolutions(owner);
    expect(row.convertedSize).toBe("0");
    expect(row.fallbackReason).toBe("");
  });
});
