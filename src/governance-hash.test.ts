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

/** Mirrors the engine's attach fixture (`admin_action_attach_and_batch_wire_vectors_frozen`
 *  in `codec.rs`): event 91's conditional on perp 15, books from 9100, the
 *  open-interest trailer at its zero default. */
function engineV2Attach(): AdminAction {
  return {
    kind: "AttachConditional",
    value: {
      eventId: 91,
      underlyingMarket: 15,
      childMarketBase: 9_100,
      imBps: 3334,
      mmBps: 1667,
      takerFeeBps: 5,
      makerFeeBps: 2,
      signer: new Uint8Array(20),
      maxOpenInterest: 0n,
    },
  };
}

/** The engine's golden batch: the default perp re-pointed at market 15,
 *  then its attachment above — one proposal, a perp and its conditional. */
function engineV2Batch(): AdminAction {
  const perp = engineDefaultCreateMarket();
  const attach = engineV2Attach();
  if (perp.kind !== "CreateMarket" || attach.kind !== "AttachConditional") {
    throw new Error("unreachable: fixture kinds are fixed");
  }
  return {
    kind: "Batch",
    value: [
      { kind: "CreateMarket", value: { ...perp.value, market: 15 } },
      { kind: "AttachConditional", value: attach.value },
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

  it("reproduces the engine's attach hash bit-for-bit", () => {
    const hash = adminProposalContentHash({
      ...goldenContext(),
      action: engineV2Attach(),
    });
    expect(bytesToHex(hash)).toBe(
      "3ffeb7f420cf9f4f50bade95919d885dfc590c7f8c92fb69eacc1704d4662be4",
    );
  });

  it("reproduces the engine's v2 batch hash bit-for-bit", () => {
    // Exercises the whole nested-enum path: the Batch arm's list payload,
    // both item variants, and the attachment trailer's default encoding.
    const hash = adminProposalContentHash({
      ...goldenContext(),
      action: engineV2Batch(),
    });
    expect(bytesToHex(hash)).toBe(
      "c099245946aaded3b995198f5ff0592d771729ab314fcf5736036ffb6f559fcd",
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

  it("reproduces the CancelAllOrdersForAccount hash bit-for-bit", () => {
    // Struct variant with a 20-byte newtype address and an Option market.
    // The expected value comes from exchange-wire's own
    // `codec::admin_proposal_content_hash` at the pinned revision; the
    // Python suite pins the identical constant.
    const hash = adminProposalContentHash({
      ...goldenContext(),
      action: {
        kind: "CancelAllOrdersForAccount",
        value: { owner: new Uint8Array(20).fill(0xc1), market: 7 },
      },
    });
    expect(bytesToHex(hash)).toBe(
      "39ededb641adc0e8b9c8f2f0c77fdeb2cc1880b7b882e6d91912535bfd27465e",
    );
    // The unscoped twin: the Option None path through the same hash.
    const unscoped = adminProposalContentHash({
      ...goldenContext(),
      action: {
        kind: "CancelAllOrdersForAccount",
        value: { owner: new Uint8Array(20).fill(0xc1), market: null },
      },
    });
    expect(bytesToHex(unscoped)).toBe(
      "4b9e5c528f5bf4578427fcb42018f3df7ce3239e4a3392c8e087230d5bb3358c",
    );
  });

  it("reproduces the UpdateAuthoritySet hash bit-for-bit", () => {
    // Struct variant with an externally-tagged bare-string domain and two
    // address-array fields — the shapes `CancelAllOrdersForAccount` above
    // doesn't exercise (a plain enum-name string, and `Vec<Address>`).
    const added = adminProposalContentHash({
      ...goldenContext(),
      action: {
        kind: "UpdateAuthoritySet",
        value: {
          domain: "MarketParams",
          add: [new Uint8Array(20).fill(0xb2)],
          remove: [],
        },
      },
    });
    expect(bytesToHex(added)).toBe(
      "9f344b099fd7771f04d62f186595a5d58165463dcc638adcef71be9c35ea889f",
    );
    const removed = adminProposalContentHash({
      ...goldenContext(),
      action: {
        kind: "UpdateAuthoritySet",
        value: {
          domain: "Relayer",
          add: [],
          remove: [new Uint8Array(20).fill(0xc3)],
        },
      },
    });
    expect(bytesToHex(removed)).toBe(
      "a4f4828d828c4e3e5f50ea883568e63b21d49c620f4848542dec498a292b847d",
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
