import { encode } from "@msgpack/msgpack";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ExchangeClient, GatewayReadError, ready } from "./index.js";
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
  it("uses the gateway and preserves current sorted grants", async () => {
    const transport = vi.fn<ExchangeHttpTransport>(
      async () =>
        new Response(
          JSON.stringify(
            envelope({
              ...raw(),
              agents: [new Uint8Array(20).fill(2), new Uint8Array(20).fill(3)],
            }),
          ),
        ),
    );
    const client = new ExchangeClient({
      gatewayUrl: "https://gateway.example",
      useGateway: false,
      httpTransport: transport,
    });
    const result = await client.reads().finalized.authorizedAgents(owner);
    expect(result).toMatchObject({
      owner,
      agents: ["02".repeat(20), "03".repeat(20)],
      complete: true,
      witness: { height },
    });
    expect(transport.mock.calls[0][0]).toBe(
      `https://gateway.example/v2/account/${owner}/agents?witness=1`,
    );
  });

  it("decodes the bytes the Rust wire type emits", () => {
    // rmp_serde::to_vec_named(&AuthorizedAgents { owner: Address([1; 20]),
    // finalized_height: 123, agents: vec![Address([2; 20]), Address([3; 20])],
    // complete: true }), which encodes the height as a one-byte integer.
    const bytes =
      "84a56f776e6572c414" +
      "01".repeat(20) +
      "b066696e616c697a65645f6865696768747ba66167656e747392c414" +
      "02".repeat(20) +
      "c414" +
      "03".repeat(20) +
      "a8636f6d706c657465c3";
    const result = decodeFinalizedAuthorizedAgents(
      {
        data: Buffer.from(bytes, "hex").toString("base64"),
        witness: { ...witness, height: "123" },
      },
      owner,
    );
    expect(result).toMatchObject({
      owner,
      agents: ["02".repeat(20), "03".repeat(20)],
      complete: true,
      witness: { height: 123n },
    });
  });

  it("distinguishes an empty complete list from bounded overflow", () => {
    expect(
      decodeFinalizedAuthorizedAgents(envelope({ ...raw(), agents: [] }), owner)
        .complete,
    ).toBe(true);
    const agents = Array.from({ length: 100 }, (_, n) =>
      new Uint8Array(20).fill(n),
    );
    const expected = agents.map((_, n) =>
      n.toString(16).padStart(2, "0").repeat(20),
    );
    expect(
      decodeFinalizedAuthorizedAgents(
        envelope({ ...raw(), agents, complete: false }),
        owner,
      ),
    ).toMatchObject({ agents: expected, complete: false });
    expect(
      decodeFinalizedAuthorizedAgents(envelope({ ...raw(), agents }), owner),
    ).toMatchObject({ agents: expected, complete: true });
  });

  it("rejects wrong binding, malformed grants and false completeness claims", () => {
    for (const value of [
      { ...raw(), owner: new Uint8Array(20).fill(3) },
      { ...raw(), finalized_height: height - 1n },
      { ...raw(), agents: [new Uint8Array(19)] },
      { ...raw(), owner: "x".repeat(20) },
      { ...raw(), owner: Array(20).fill(1) },
      { ...raw(), agents: ["x".repeat(20)] },
      { ...raw(), agents: [Array(20).fill(2)] },
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
      ).toThrow(GatewayReadError);
  });

  it("reports a payload bound to another owner or height as a binding fault", () => {
    for (const value of [
      { ...raw(), owner: new Uint8Array(20).fill(3) },
      { ...raw(), finalized_height: height - 1n },
    ])
      expect(() =>
        decodeFinalizedAuthorizedAgents(envelope(value), owner),
      ).toThrow(expect.objectContaining({ kind: "binding" }));
  });

  it("rejects absent or invalid evidence rather than treating it as no grants", () => {
    for (const value of [
      null,
      {},
      { data: envelope(raw()).data },
      { ...envelope(raw()), witness: null },
      { ...envelope(raw()), witness: { ...witness, height: "0" } },
    ])
      expect(() => decodeFinalizedAuthorizedAgents(value, owner)).toThrow(
        GatewayReadError,
      );
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

  it("cancels an in-flight request when the caller aborts", async () => {
    const abort = new AbortController();
    const transport = vi.fn<ExchangeHttpTransport>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
          abort.abort(new Error("caller cancelled"));
        }),
    );
    const client = new ExchangeClient({
      gatewayUrl: "https://gateway.example",
      httpTransport: transport,
    });
    await expect(
      client.reads().finalized.authorizedAgents(owner, {
        signal: abort.signal,
      }),
    ).rejects.toThrow("caller cancelled");
    expect(transport).toHaveBeenCalledTimes(1);
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
