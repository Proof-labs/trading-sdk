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

/** Mirrors the engine's admin-actions-v2 golden fixture
 *  (`admin_proposal_content_hash_v2_golden_vectors` in `codec.rs`) — the
 *  omitted trailers (oracleSource, description, rules) encode as
 *  nil / "" / "", exactly what the engine's instance carries. */
function engineV2Impact(): AdminAction {
  return {
    kind: "CreateImpactMarket",
    value: {
      impactMarketId: 91,
      underlyingMarket: 15,
      childMarketBase: 9_100,
      question: "does it land?",
      deadlineMs: 1_000_000n,
      resolutionWindowMs: 1_000n,
      imBps: 3334,
      mmBps: 1667,
      takerFeeBps: 5,
      makerFeeBps: 2,
      fundingIntervalMs: 0n,
      maxFundingRateBps: 3000,
      signer: new Uint8Array(20),
    },
  };
}

/** The engine's golden batch: the default perp re-pointed at market 15,
 *  then the impact family above — one proposal, two creations. */
function engineV2Batch(): AdminAction {
  const perp = engineDefaultCreateMarket();
  const impact = engineV2Impact();
  if (perp.kind !== "CreateMarket" || impact.kind !== "CreateImpactMarket") {
    throw new Error("unreachable: fixture kinds are fixed");
  }
  return {
    kind: "Batch",
    value: [
      { kind: "CreateMarket", value: { ...perp.value, market: 15 } },
      { kind: "CreateImpactMarket", value: impact.value },
    ],
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

  it("reproduces the engine's v2 impact hash bit-for-bit", () => {
    const hash = adminProposalContentHash({
      ...goldenContext(),
      action: engineV2Impact(),
    });
    expect(bytesToHex(hash)).toBe(
      "d57a7faa3a17aac647a0256c38f125f6bd0913d70013e185aeb322efaab9629e",
    );
  });

  it("reproduces the engine's v2 batch hash bit-for-bit", () => {
    // Exercises the whole nested-enum path: the Batch arm's list payload,
    // both item variants, and the impact trailers' default encoding.
    const hash = adminProposalContentHash({
      ...goldenContext(),
      action: engineV2Batch(),
    });
    expect(bytesToHex(hash)).toBe(
      "f9a9b17a53b52ad72c1703b583a0ed4ac70295244cbf31f74518d5177dd86e36",
    );
  });

  it("reproduces the unit-variant (UnpauseBridge) hash bit-for-bit", () => {
    // The one admin action that is NOT a `{ Variant: … }` map: a fieldless
    // unit variant, whose canonical bytes are the bare fixstr
    // `ad 556e7061757365427269646765` ("UnpauseBridge"). That makes it the
    // only arm exercising the bare-string branch of `adminActionToWasm`, so
    // without this an approving client could recompute a hash the engine
    // never produces and refuse every legitimate UnpauseBridge approval.
    //
    // exchange-core has no frozen content-hash vector for this arm yet, so the
    // expected value is taken from the authority itself: exchange-wire's own
    // `codec::admin_proposal_content_hash` over `AdminAction::UnpauseBridge`
    // at the revision pinned in crates/proof-trading-sdk/Cargo.toml.
    const hash = adminProposalContentHash({
      ...goldenContext(),
      action: { kind: "UnpauseBridge" },
    });
    expect(bytesToHex(hash)).toBe(
      "ffa74c9323512ffb8272eea55fc49baf047f55aa8979e56e06229b57d1350f56",
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
