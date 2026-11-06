import { encode } from "@msgpack/msgpack";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ExchangeClient, ready } from "./index.js";
import { decodeFinalizedAuthorizedAgents } from "./authorized-agents.js";
import type { ExchangeHttpTransport } from "./http-transport.js";

const owner = "01".repeat(20);
const height = 9007199254740993n;
const witness = {
  version: 1,
  nodeId: "ab".repeat(20),
  height: height.toString(),
  finalizedBlockTimeMs: "123000",
  appHash: "cd".repeat(32),
};
const raw = () => ({
  owner: new Uint8Array(20).fill(1),
  finalized_height: height,
  agents: [new Uint8Array(20).fill(2)],
  complete: true,
});
const envelope = (value: unknown) => ({
  data: Buffer.from(encode(value, { useBigInt64: true })).toString("base64"),
  witness: { ...witness },
});
beforeAll(ready);

describe("finalized current agent grants", () => {
  it("uses the gateway with cancellation and preserves current sorted grants", async () => {
    const transport = vi.fn<ExchangeHttpTransport>(
      async () => new Response(JSON.stringify(envelope(raw()))),
    );
    const client = new ExchangeClient({
      gatewayUrl: "https://gateway.example",
      useGateway: false,
      httpTransport: transport,
    });
    const result = await client.reads().finalized.authorizedAgents(owner);
    expect(result).toMatchObject({
      owner,
      agents: ["02".repeat(20)],
      complete: true,
      witness: { height },
    });
    expect(transport.mock.calls[0][0]).toBe(
      `https://gateway.example/v2/account/${owner}/agents?witness=1`,
    );
    expect(transport.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("distinguishes an empty complete list from bounded overflow", () => {
    expect(
      decodeFinalizedAuthorizedAgents(envelope({ ...raw(), agents: [] }), owner)
        .complete,
    ).toBe(true);
    const agents = Array.from({ length: 100 }, (_, n) =>
      new Uint8Array(20).fill(n),
    );
    expect(
      decodeFinalizedAuthorizedAgents(
        envelope({ ...raw(), agents, complete: false }),
        owner,
      ).complete,
    ).toBe(false);
    expect(
      decodeFinalizedAuthorizedAgents(envelope({ ...raw(), agents }), owner)
        .complete,
    ).toBe(true);
  });

  it("rejects wrong binding, malformed grants and false completeness claims", () => {
    for (const value of [
      { ...raw(), owner: new Uint8Array(20).fill(3) },
      { ...raw(), finalized_height: height - 1n },
      { ...raw(), agents: [new Uint8Array(19)] },
      {
        ...raw(),
        agents: [new Uint8Array(20).fill(3), new Uint8Array(20).fill(2)],
      },
      {
        ...raw(),
        agents: [new Uint8Array(20).fill(2), new Uint8Array(20).fill(2)],
      },
      {
        ...raw(),
        agents: Array.from({ length: 101 }, (_, n) =>
          new Uint8Array(20).fill(n),
        ),
      },
      { ...raw(), complete: false },
      { ...raw(), complete: "true" },
      { ...raw(), finalized_height: 1.5 },
      Object.values(raw()),
    ])
      expect(() =>
        decodeFinalizedAuthorizedAgents(envelope(value), owner),
      ).toThrow();
  });

  it("rejects absent or invalid evidence rather than treating it as no grants", () => {
    for (const value of [
      null,
      {},
      { data: envelope(raw()).data },
      { ...envelope(raw()), witness: null },
      { ...envelope(raw()), witness: { ...witness, height: "0" } },
    ])
      expect(() => decodeFinalizedAuthorizedAgents(value, owner)).toThrow();
  });

  it("permits future named map fields without reinterpreting grant authority", () => {
    expect(
      decodeFinalizedAuthorizedAgents(
        envelope({ ...raw(), future: "ignored" }),
        owner,
      ).agents,
    ).toEqual(["02".repeat(20)]);
  });

  it("does not read on invalid owner or already aborted requests", async () => {
    const transport = vi.fn<ExchangeHttpTransport>();
    const client = new ExchangeClient({
      gatewayUrl: "https://gateway.example",
      httpTransport: transport,
    });
    await expect(
      client.reads().finalized.authorizedAgents("0x" + owner),
    ).rejects.toThrow();
    await expect(
      client
        .reads()
        .finalized.authorizedAgents(owner, { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it("preserves refusal status and never retries a legacy route", async () => {
    const transport = vi.fn<ExchangeHttpTransport>(
      async () => new Response("unavailable", { status: 503 }),
    );
    const client = new ExchangeClient({
      gatewayUrl: "https://gateway.example",
      httpTransport: transport,
    });
    await expect(
      client.reads().finalized.authorizedAgents(owner),
    ).rejects.toMatchObject({ status: 503 });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
