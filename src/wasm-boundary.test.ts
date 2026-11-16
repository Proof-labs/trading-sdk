import { describe, expect, it } from "vitest";
import { getWasm } from "./wasm-loader";

describe("WASM binding ownership", () => {
  it("copies inputs and returns independently owned signing messages", () => {
    const wasm = getWasm();
    const chain = new Uint8Array(32).fill(7);
    const payload = new Uint8Array([0, 255, 128]);
    const first = wasm.signing_message(chain, 1, 0xffffffffffffffffn, payload);
    const expected = first.slice();
    chain.fill(0);
    payload.fill(0);
    for (let i = 0; i < 64; i++) {
      const next = wasm.signing_message(chain, 1, BigInt(i), payload);
      next.fill(0);
    }
    expect(first).toEqual(expected);
    expect([...first.slice(-3)]).toEqual([0, 255, 128]);
    const prefix = new TextEncoder().encode("ProofExchange-v3");
    expect(first.slice(0, prefix.length)).toEqual(prefix);
    expect(first.slice(prefix.length, prefix.length + 32)).toEqual(
      new Uint8Array(32).fill(7),
    );
    expect([...first.slice(prefix.length + 33, prefix.length + 41)]).toEqual(
      new Array(8).fill(255),
    );
  });

  it("rejects wrong chain widths and remains usable after errors", () => {
    const wasm = getWasm();
    for (const width of [0, 31, 33]) {
      expect(() =>
        wasm.signing_message(new Uint8Array(width), 1, 0n, new Uint8Array()),
      ).toThrow(/32/);
    }
    const result = wasm.signing_message(
      new Uint8Array(32),
      1,
      0n,
      new Uint8Array([128, 255]),
    );
    expect([...result.slice(-2)]).toEqual([128, 255]);
  });
});
