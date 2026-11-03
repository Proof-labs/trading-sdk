import { beforeAll, describe, expect, it, vi } from "vitest";
import { ExchangeClient } from "./client.js";
import type { ExchangeHttpTransport } from "./http-transport.js";

import { encode } from "@msgpack/msgpack";
import { ready } from "./wasm-loader.js";
beforeAll(ready);
const witness = {
  version: 1,
  nodeId: "ab".repeat(20),
  height: "5",
  finalizedBlockTimeMs: "1000",
  appHash: "cd".repeat(32),
};
const envelope = (authorized: boolean) => ({
  data: Buffer.from(encode(authorized)).toString("base64"),
  witness,
});
const owner = "ab".repeat(20);
const agent = "cd".repeat(20);
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

describe("generic agent authorization", () => {
  it.each([true, false])(
    "preserves the exact boolean %s without witness synthesis",
    async (authorized) => {
      const c = client(envelope(authorized));
      expect(
        (await c.client.reads().finalized.agentAuthorization(owner, agent))
          .authorized,
      ).toBe(authorized);
      expect(String(c.transport.mock.calls[0][0])).toBe(
        `https://gateway.example/v1/account/${owner}/agents/${agent}?witness=1`,
      );
      expect(c.transport).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    "",
    "0x" + owner,
    owner.toUpperCase(),
    "gg".repeat(20),
    "cd".repeat(32),
    owner + "/state",
    owner + "?x=1",
  ])("refuses invalid owner/agent %s before I/O", async (bad) => {
    const c = client({ authorized: true });
    await expect(
      c.client.reads().finalized.agentAuthorization(bad, agent),
    ).rejects.toThrow("address");
    await expect(
      c.client.reads().finalized.agentAuthorization(owner, bad),
    ).rejects.toThrow("address");
    expect(c.transport).not.toHaveBeenCalled();
  });
  it.each([
    null,
    [],
    {},
    { authorized: "true" },
    { authorized: 1 },
    { authorized: true, witness: {} },
  ])("refuses malformed or extended envelopes", async (body) => {
    await expect(
      client(body).client.reads().finalized.agentAuthorization(owner, agent),
    ).rejects.toThrow();
  });
  it.each([400, 404, 503])(
    "does not turn HTTP %s into false or retry",
    async (status) => {
      const c = client({ authorized: false }, status);
      await expect(
        c.client.reads().finalized.agentAuthorization(owner, agent),
      ).rejects.toThrow();
      expect(c.transport).toHaveBeenCalledTimes(1);
    },
  );
  it("refuses duplicate authorization keys", async () => {
    const c = client({});
    c.transport.mockImplementation(
      async () => new Response('{"authorized":false,"authorized":true}'),
    );
    await expect(
      c.client.reads().finalized.agentAuthorization(owner, agent),
    ).rejects.toThrow();
  });
  it("honors cancellation without transport or a direct-node fallback", async () => {
    const c = client({ authorized: true });
    const abort = new AbortController();
    abort.abort();
    await expect(
      c.client
        .reads()
        .finalized.agentAuthorization(owner, agent, { signal: abort.signal }),
    ).rejects.toThrow();
    expect(c.transport).not.toHaveBeenCalled();
  });
});
