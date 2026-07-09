import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Differential check: the WASM build of the Rust core (`encode_payload` /
 * `decode_payload`) must reproduce the authoritative conformance vectors
 * byte-for-byte — the same `conformance/codec.ndjson` the Rust, Python, and
 * TS codecs are all checked against. This is the coexistence proof for the
 * WASM migration (see docs/adr/0001): if WASM matches the vectors and the TS
 * codec matches the vectors (`conformance.test.ts`), the two agree.
 *
 * Skips when `src/wasm/` has not been built (`npm run build:wasm`), so a
 * JS-only CI without the Rust toolchain stays green. A wasm-enabled CI runs it.
 */

const wasmJsUrl = new URL("./wasm/proof_trading_sdk_wasm.js", import.meta.url);
const wasmBgPath = fileURLToPath(
  new URL("./wasm/proof_trading_sdk_wasm_bg.wasm", import.meta.url),
);
const built = existsSync(fileURLToPath(wasmJsUrl)) && existsSync(wasmBgPath);

interface CodecVector {
  case: string;
  action_type: number;
  input: Record<string, unknown>;
  expect: { payload_hex: string };
}

// BigInt-preserving parse: quote integer literals with 16+ digits (2^53 has 16
// digits) before JSON.parse, then revive them to BigInt, so u64 fields survive
// at full precision. `encode_payload` accepts BigInt for u64.
function parseVector(line: string): CodecVector {
  const quoted = line.replace(/:\s*(-?\d{16,})(?=\s*[,}\]])/g, ':"$1@big"');
  return JSON.parse(quoted, (_k, v) =>
    typeof v === "string" && v.endsWith("@big") ? BigInt(v.slice(0, -4)) : v,
  ) as CodecVector;
}

const vectors: CodecVector[] = built
  ? readFileSync(
      fileURLToPath(new URL("../conformance/codec.ndjson", import.meta.url)),
      "utf8",
    )
      .trim()
      .split("\n")
      .map(parseVector)
  : [];

describe.skipIf(!built)("wasm codec ↔ authoritative vectors", () => {
  let wasm: typeof import("./wasm/proof_trading_sdk_wasm.js");

  beforeAll(async () => {
    wasm = await import(wasmJsUrl.href);
    await wasm.default(readFileSync(wasmBgPath));
  });

  it("has conformance vectors to check", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  it("encode_payload reproduces every conformance payload byte-for-byte", () => {
    for (const v of vectors) {
      const got = Buffer.from(
        wasm.encode_payload(v.action_type, v.input),
      ).toString("hex");
      expect(got, v.case).toBe(v.expect.payload_hex);
    }
  });

  it("decode_payload round-trips back to the same wire bytes (u64 precision preserved)", () => {
    for (const v of vectors) {
      const payload = Uint8Array.from(Buffer.from(v.expect.payload_hex, "hex"));
      const decoded = wasm.decode_payload(v.action_type, payload);
      const reencoded = Buffer.from(
        wasm.encode_payload(v.action_type, decoded),
      ).toString("hex");
      expect(reencoded, v.case).toBe(v.expect.payload_hex);
    }
  });
});
