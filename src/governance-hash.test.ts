// Pins `adminProposalContentHash` (WASM → Rust core) to the exchange engine's
// own golden content hashes — the same two vectors the core's
// `content_hash_matches_engine_golden_vectors` test pins. If the TS→WASM enum
// mapping, the hash preimage, or the canonical action bytes drift, these fail.
//
// This is what lets an approving client (Web Admin) verify a server-supplied
// `content_hash` locally instead of trusting it.

import { describe, it, expect, beforeAll } from "vitest";

import {
  adminProposalContentHash,
  bytesToHex,
  ready,
  type AdminAction,
  type AdminProposalContext,
} from "./index.js";

/** Mirrors `exchange-core`'s `impl Default for CreateMarket` — the instance
 *  the engine's golden-vector test hashes. The non-zero fee/funding defaults
 *  are load-bearing (the hash commits the full canonical bytes). */
function engineDefaultCreateMarket(): AdminAction {
  return {
    kind: "CreateMarket",
    value: {
      market: 0,
      imBps: 3334,
      mmBps: 1667,
      takerFeeBps: 5,
      makerFeeBps: 2,
      signer: new Uint8Array(20),
      fundingIntervalMs: 60_000n,
      maxFundingRateBps: 3000,
      poolId: 0,
      szDecimals: 0,
      ticker: "",
      maxOpenInterest: 0n,
    },
  };
}

function goldenContext(): AdminProposalContext {
  return {
    chainId: new Uint8Array(32).fill(0x11),
    proposalId: 42n,
    registryVersion: 3n,
    threshold: 2,
    proposer: new Uint8Array(20).fill(0x22),
    createdHeight: 7n,
    createdMs: 1_000n,
    expiryMs: 259_201_000n,
    action: engineDefaultCreateMarket(),
  };
}

describe("adminProposalContentHash (engine golden vectors)", () => {
  beforeAll(async () => {
    await ready();
  });

  it("reproduces the engine's golden hash bit-for-bit", () => {
    const hash = adminProposalContentHash(goldenContext());
    expect(hash).toBeInstanceOf(Uint8Array);
    expect(bytesToHex(hash)).toBe(
      "6cdd8d6843bb4026d396b9e80c9599530b0ac4f14862af0204794219f8f8cbea",
    );
  });

  it("is sensitive to a single context field (registry_version 3 → 4)", () => {
    const hash = adminProposalContentHash({
      ...goldenContext(),
      registryVersion: 4n,
    });
    expect(bytesToHex(hash)).toBe(
      "5fe2dd718a4aea63492a5ab95eee27588cc861c504643bf68ce3fdd2c45dab99",
    );
  });

  it("rejects a malformed proposer length", () => {
    expect(() =>
      adminProposalContentHash({
        ...goldenContext(),
        proposer: new Uint8Array(19).fill(0x22),
      }),
    ).toThrow(/proposer/);
  });
});
