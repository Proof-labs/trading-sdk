import { expect, it, vi } from "vitest";
import { TypedGatewayReads } from "./typed-gateway-reads.js";
import { verifyWitness } from "./bounded-read.js";
import type { ExchangeHttpTransport } from "./http-transport.js";

it("rejects zero chain pins across typed reads before transport", async () => {
  const transport = vi.fn<ExchangeHttpTransport>();
  const reads = new TypedGatewayReads(
    "https://gateway.example",
    transport,
    new Uint8Array(32),
  );
  const attempts = [
    () => reads.finalized.marketsSnapshot(),
    () => reads.evidence.blockHeader(1n),
    () =>
      reads.evidence.transaction({
        hash: "00".repeat(32),
        signedBytes: new Uint8Array([1]),
      }),
    () =>
      reads.evidence.blockResultsRange({ fromHeight: 1n, throughHeight: 1n }),
    () =>
      reads.evidence.blockResultsWindow({
        fromMs: 0,
        toMs: 1,
        throughHeight: 1n,
      }),
  ];
  for (const attempt of attempts)
    await expect(attempt()).rejects.toMatchObject({
      kind: "configuration",
      field: "chainId",
    });
  expect(transport).not.toHaveBeenCalled();
});

it("rejects a zero pin before comparing a witness", () => {
  const witness = {
    version: 1 as const,
    nodeId: "ab".repeat(20),
    height: 1n,
    finalizedBlockTimeMs: 1n,
    appHash: "CD".repeat(32),
  };
  expect(() =>
    verifyWitness(
      witness as Parameters<typeof verifyWitness>[0],
      { height: 2n, chainId: "test", appHash: witness.appHash },
      new Uint8Array(32),
    ),
  ).toThrow(
    expect.objectContaining({ kind: "configuration", field: "chainId" }),
  );
});
