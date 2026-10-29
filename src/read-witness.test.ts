import { describe, expect, it } from "vitest";
import { decodeFinalizedReadWitness, verifyWitness } from "./bounded-read.js";
import { chainIdFromString } from "./crypto.js";

const wire = {
  version: 1,
  nodeId: "ab".repeat(20),
  height: "5",
  finalizedBlockTimeMs: "1000",
  appHash: "cd".repeat(32),
};
const header = {
  height: 6n,
  chainId: "witness-test-1",
  appHash: "CD".repeat(32),
};
describe("finalized witness binding", () => {
  it("requires a nonempty chain pin", () => {
    expect(() =>
      verifyWitness(decodeFinalizedReadWitness(wire), header, ""),
    ).toThrow(
      expect.objectContaining({ kind: "configuration", field: "chainId" }),
    );
  });
  it("canonicalizes lowercase wire hashes and binds to H+1 and the pinned chain", () => {
    const witness = decodeFinalizedReadWitness(wire, 5n, 1000n);
    expect(witness.appHash).toBe(header.appHash);
    expect(() => verifyWitness(witness, header, header.chainId)).not.toThrow();
    expect(() =>
      verifyWitness(
        witness,
        { ...header, appHash: wire.appHash },
        chainIdFromString(header.chainId),
      ),
    ).not.toThrow();
  });
  it.each([
    { ...header, height: 5n },
    { ...header, height: 7n },
    { ...header, chainId: "other" },
    { ...header, appHash: "ab".repeat(32) },
    { ...header, appHash: null },
  ])("refuses the wrong state or chain", (next) => {
    expect(() =>
      verifyWitness(decodeFinalizedReadWitness(wire), next, header.chainId),
    ).toThrow(expect.objectContaining({ kind: "binding" }));
  });
  it("uses signed Comet height bounds consistently", () => {
    expect(() =>
      decodeFinalizedReadWitness({ ...wire, height: String(1n << 63n) }),
    ).toThrow();
    expect(() => decodeFinalizedReadWitness(wire, 4n)).toThrow();
    expect(() => decodeFinalizedReadWitness(wire, 5n, 999n)).toThrow();
  });
});
