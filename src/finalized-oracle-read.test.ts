import { decodeFinalizedOraclePermissions } from "./finalized-oracle-read.js";
import { readFileSync } from "node:fs";
import { Decoder, encode } from "@msgpack/msgpack";
import { beforeAll, expect, it, vi } from "vitest";
import { ExchangeClient, ready } from "./index.js";
import type { ExchangeHttpTransport } from "./http-transport.js";

beforeAll(ready);
const vectors = readFileSync(
  new URL(
    "../conformance/oracle-permissions-committed.ndjson",
    import.meta.url,
  ),
  "utf8",
)
  .trim()
  .split("\n")
  .map((s) => JSON.parse(s) as { case: string; hex: string });
const envelope = (hex: string) => {
  const raw = new Decoder({ useBigInt64: true }).decode(
    Buffer.from(hex, "hex"),
  ) as unknown[];
  const verdict = raw[8] as unknown[];
  return {
    data: Buffer.from(hex, "hex").toString("base64"),
    witness: {
      version: 1,
      nodeId: "ab".repeat(20),
      height: String(raw[1]),
      finalizedBlockTimeMs: String(verdict[1]),
      appHash: "cd".repeat(32),
    },
  };
};
it.each(vectors)(
  "preserves native oracle vector $case with a same-view witness",
  ({ hex }) => {
    const body = envelope(hex);
    const result = decodeFinalizedOraclePermissions(body, 1);
    expect(result.finalizedHeight).toBe(result.witness.height);
    expect(result.verdict?.blockTime).toBe(result.witness.finalizedBlockTimeMs);
  },
);
it("rejects cross-market, cross-height/time and absent evidence", () => {
  const body = envelope(vectors[0].hex);
  expect(() => decodeFinalizedOraclePermissions(body, 2)).toThrow();
  expect(() =>
    decodeFinalizedOraclePermissions(
      { ...body, witness: { ...body.witness, height: "999" } },
      1,
    ),
  ).toThrow();
  expect(() =>
    decodeFinalizedOraclePermissions(
      { ...body, witness: { ...body.witness, finalizedBlockTimeMs: "1" } },
      1,
    ),
  ).toThrow();
  expect(() =>
    decodeFinalizedOraclePermissions({ data: body.data }, 1),
  ).toThrow();
});
it("keeps legacy state unqualified instead of manufacturing a certificate", () => {
  const body = {
    data: Buffer.from(
      encode([1, 9, 10, false, "Legacy", null, null, null, null]),
    ).toString("base64"),
    witness: {
      version: 1,
      nodeId: "ab".repeat(20),
      height: "9",
      finalizedBlockTimeMs: "1000",
      appHash: "cd".repeat(32),
    },
  };
  expect(decodeFinalizedOraclePermissions(body, 1)).toMatchObject({
    oracleActive: false,
    state: "Legacy",
    verdict: null,
  });
});
it("uses the bounded gateway witness route with no fallback", async () => {
  const transport = vi.fn<ExchangeHttpTransport>(
    async () => new Response(JSON.stringify(envelope(vectors[0].hex))),
  );
  const client = new ExchangeClient({
    gatewayUrl: "https://gateway.example",
    useGateway: false,
    httpTransport: transport,
  });
  await client.reads().finalized.oraclePermissions(1);
  expect(String(transport.mock.calls[0][0])).toBe(
    "https://gateway.example/v1/oracle/permissions/1?witness=1",
  );
  transport.mockImplementation(
    async () => new Response("unavailable", { status: 503 }),
  );
  await expect(client.reads().finalized.oraclePermissions(1)).rejects.toThrow();
  expect(transport).toHaveBeenCalledTimes(2);
  await expect(client.reads().finalized.oraclePermissions(0)).rejects.toThrow();
  expect(transport).toHaveBeenCalledTimes(2);
});
