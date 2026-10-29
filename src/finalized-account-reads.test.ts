import { encode } from "@msgpack/msgpack";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ExchangeClient, ready } from "./index.js";
import {
  decodeFinalizedAccountState,
  decodeFinalizedAgentAuthorization,
  decodeFinalizedRecentNonces,
  decodeFinalizedOpenOrders,
} from "./finalized-account-reads.js";
import type { ExchangeHttpTransport } from "./http-transport.js";

const owner = "04".repeat(20),
  agent = "05".repeat(20),
  H = 9007199254740993n;
const witness = {
  version: 1,
  nodeId: "ab".repeat(20),
  height: H.toString(),
  finalizedBlockTimeMs: "123000",
  appHash: "cd".repeat(32),
};
const envelope = (raw: unknown) => ({
  data: Buffer.from(encode(raw, { useBigInt64: true })).toString("base64"),
  witness: { ...witness },
});
const account = () => [
  Array(20).fill(4),
  H,
  50n,
  [[Array(20).fill(4), 1, "Buy", 100, 3, -7, 2]],
];
const order = (id = 1n): unknown[] => [
  id,
  1,
  new Uint8Array(20).fill(4),
  "Sell",
  90n,
  3n,
  null,
  4n,
  1n,
  122000n,
  1n,
  "Gtc",
  false,
  true,
];
function client(body: unknown, status = 200) {
  const transport = vi.fn<ExchangeHttpTransport>(
    async () => new Response(JSON.stringify(body), { status }),
  );
  return {
    transport,
    client: new ExchangeClient({
      gatewayUrl: "https://gateway.example",
      useGateway: false,
      httpTransport: transport,
    }),
  };
}
beforeAll(async () => {
  await ready();
});

describe("generic finalized raw reads", () => {
  it("retains exact account height, cash and cost remainder", async () => {
    const c = client(envelope(account()));
    const value = await c.client.reads().finalized.accountState(owner);
    expect(value).toMatchObject({
      owner,
      finalizedHeight: H,
      balance: 50n,
      witness: { height: H },
    });
    expect(value.positions[0]).toMatchObject({
      size: 3n,
      entryRemainder: 2n,
      lastFundingIndex: -7n,
    });
    expect(String(c.transport.mock.calls[0][0])).toBe(
      `https://gateway.example/v1/account/${owner}/state?witness=1`,
    );
  });
  it.each([true, false])(
    "preserves witnessed authorization %s",
    async (authorized) => {
      const c = client(envelope(authorized));
      expect(
        await c.client.reads().finalized.agentAuthorization(owner, agent),
      ).toMatchObject({ owner, agent, authorized, witness: { height: H } });
      expect(String(c.transport.mock.calls[0][0])).toBe(
        `https://gateway.example/v1/account/${owner}/agents/${agent}?witness=1`,
      );
    },
  );
  it("reads the signer's exact retained nonce set, including the uint64 bound", async () => {
    const c = client(envelope([0n, H, (1n << 64n) - 1n]));
    expect(await c.client.reads().finalized.recentNonces(agent)).toMatchObject({
      signer: agent,
      recent: [0n, H, (1n << 64n) - 1n],
    });
    expect(String(c.transport.mock.calls[0][0])).toBe(
      `https://gateway.example/v1/account/${agent}/recent-nonces?witness=1`,
    );
    expect(decodeFinalizedRecentNonces(envelope([]), agent).recent).toEqual([]);
  });
  it("marks a limit-sized order result incomplete and preserves a full 100-order inventory", async () => {
    const c = client(envelope([order()]));
    const value = await c.client
      .reads()
      .finalized.openOrders(owner, { limit: 1 });
    expect(value.complete).toBe(false);
    expect(value.orders[0]).toMatchObject({
      owner,
      id: 1n,
      quantity: 3n,
      originalQuantity: 4n,
      filledQuantity: 1n,
      reduceOnly: true,
    });
    expect(String(c.transport.mock.calls[0][0])).toBe(
      `https://gateway.example/v1/orders/${owner}?limit=1&witness=1`,
    );
    expect(
      decodeFinalizedOpenOrders(
        envelope(Array.from({ length: 100 }, (_, i) => order(BigInt(i + 1)))),
        owner,
      ).complete,
    ).toBe(true);
    expect(
      decodeFinalizedOpenOrders(
        envelope(Array.from({ length: 101 }, (_, i) => order(BigInt(i + 1)))),
        owner,
      ).complete,
    ).toBe(false);
    expect(decodeFinalizedOpenOrders(envelope([]), owner).complete).toBe(true);
  });
  it("refuses cross-owner and cross-height account facts", () => {
    expect(() =>
      decodeFinalizedAccountState(envelope(account()), agent),
    ).toThrow("owner");
    const raw = account();
    raw[1] = H + 1n;
    expect(() => decodeFinalizedAccountState(envelope(raw), owner)).toThrow(
      "height",
    );
  });
  it.each([null, 0, 1, "true", []])(
    "refuses a nonboolean authorization",
    (value) => {
      expect(() =>
        decodeFinalizedAgentAuthorization(envelope(value), owner, agent),
      ).toThrow();
    },
  );
  it.each([
    [-1n],
    [1n << 64n],
    [2n, 1n],
    [1n, 1n],
    Array.from({ length: 101 }, (_, i) => BigInt(i)),
  ])(
    "refuses invalid, unordered, duplicate or oversized nonce sets",
    (values) => {
      expect(() =>
        decodeFinalizedRecentNonces(envelope(values), agent),
      ).toThrow();
    },
  );
  it("rejects cross-owner, duplicate, over-limit and malformed orders", () => {
    const cross = order();
    cross[2] = new Uint8Array(20).fill(5);
    const empty = order();
    empty[5] = 0n;
    for (const rows of [
      [cross],
      [empty],
      [order(), order()],
      [order().slice(0, 13)],
      [order(), order(2n)],
    ]) {
      expect(() =>
        decodeFinalizedOpenOrders(envelope(rows), owner, 1),
      ).toThrow();
    }
  });
  it.each([
    { height: "0" },
    { height: (1n << 63n).toString() },
    { nodeId: "00".repeat(20) },
    { appHash: "00".repeat(32) },
    { finalizedBlockTimeMs: "0" },
    { extra: 1 },
  ])("refuses incomplete or extended witness metadata", (patch) => {
    expect(() =>
      decodeFinalizedAgentAuthorization(
        { ...envelope(true), witness: { ...witness, ...patch } },
        owner,
        agent,
      ),
    ).toThrow();
  });
  it("rejects unwitnessed, extended, malformed, floating and trailing payloads", () => {
    for (const body of [
      { data: envelope(true).data },
      { ...envelope(true), authorized: true },
      { ...envelope(true), data: "!!!" },
      { ...envelope(true), data: Buffer.from([0xc3, 0xc3]).toString("base64") },
      {
        ...envelope(true),
        data: Buffer.from([0xca, 0x3f, 0x80, 0, 0]).toString("base64"),
      },
      envelope(Array.from({ length: 2049 }, () => 0)),
    ])
      expect(() =>
        decodeFinalizedAgentAuthorization(body, owner, agent),
      ).toThrow();
  });
  it("rejects invalid requests before I/O and refuses missing evidence without fallback", async () => {
    const c = client(envelope(account()));
    await expect(
      c.client.reads().finalized.accountState("0x" + owner),
    ).rejects.toThrow();
    await expect(
      c.client.reads().finalized.agentAuthorization(owner, "05".repeat(32)),
    ).rejects.toThrow();
    await expect(
      c.client
        .reads()
        .finalized.recentNonces(agent.toUpperCase().replace("05", "FF")),
    ).rejects.toThrow();
    for (const limit of [0, 102, 1.5, NaN])
      await expect(
        c.client.reads().finalized.openOrders(owner, { limit }),
      ).rejects.toThrow();
    expect(c.transport).not.toHaveBeenCalled();
    const unavailable = client({ error: "unavailable" }, 503);
    await expect(
      unavailable.client.reads().finalized.accountState(owner),
    ).rejects.toThrow();
    expect(unavailable.transport).toHaveBeenCalledTimes(1);
    const missing = client({ data: envelope(account()).data });
    await expect(
      missing.client.reads().finalized.accountState(owner),
    ).rejects.toThrow();
    expect(missing.transport).toHaveBeenCalledTimes(1);
  });
  it("shares cancellation and duplicate-envelope protection", async () => {
    const c = client(envelope(true));
    const abort = new AbortController();
    abort.abort();
    await expect(
      c.client.reads().finalized.agentAuthorization(owner, agent, {
        signal: abort.signal,
      }),
    ).rejects.toThrow();
    expect(c.transport).not.toHaveBeenCalled();
    c.transport.mockImplementation(
      async () =>
        new Response(
          '{"data":"ww==","data":"wg==","witness":' +
            JSON.stringify(witness) +
            "}",
        ),
    );
    await expect(
      c.client.reads().finalized.agentAuthorization(owner, agent),
    ).rejects.toThrow();
  });
});
