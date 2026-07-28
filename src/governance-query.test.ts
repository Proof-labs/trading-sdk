// Golden-vector tests for the governance read-model decoders.
//
// PROVENANCE — these hex strings are not hand-written. Each is the output of
// `rmp_serde::to_vec` run against a record built with exchange-core's own
// types, harvested with a throwaway test in the engine repo:
//
//   exchange-core/tests/tmp_governance_query_vectors.rs
//     use exchange_core::query::{AdminSignerRegistryInfo, AdminSignerRegistryRoster,
//                               ProposalDisplayInfo, ProposalPage};
//     use exchange_core::types::{AdminAction, CreateMarket, ExpiryReason, ProposalId,
//                               ProposalStatus, RegistryVersion, SignatureThreshold,
//                               SignerAddress, UpdateAdminSignerRegistry};
//     ...build a record, then rmp_serde::to_vec(&record) and print it as hex.
//   cargo test -p exchange-core --test tmp_governance_query_vectors -- --nocapture
//
// That generator is deliberately NOT committed to either repo: it depends on
// exchange-core, which this SDK does not (and must not) depend on — the SDK
// mirrors the engine, it never imports it. The bytes below ARE the artifact.
// To regenerate after an engine struct changes, recreate the generator from
// the recipe above; the field values used are visible in the assertions.
//
// Why golden bytes rather than hand-written expectations: the engine encodes
// with the COMPACT MessagePack form, where structs are positional arrays and
// several encoding choices are invisible in the struct definitions —
// `[u8; N]` becomes an array of integers rather than a byte string, unit enum
// variants become bare strings while payload variants become single-entry
// maps, and `Option` is transparent. Every one of those was confirmed here,
// not assumed. A decoder that transposes two same-typed fields is silently
// wrong, so each record below gives every field a distinct value.

import { describe, it, expect } from "vitest";
import { Decoder } from "@msgpack/msgpack";
import {
  decodeAdminAction,
  decodeAdminSignerRegistry,
  decodeAdminSignerRegistryInfo,
  decodeProposalPage,
  decodeProposalDisplayInfo,
  decodeProposalStatus,
} from "./governance-query.js";

// Matches the client's decoder options: only 64-bit msgpack ints become
// bigint, so small values arrive as `number` — the case the decoders
// normalize away.
const decoder = new Decoder({ useBigInt64: true });

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Decode a golden vector the way the client does. */
function decodeVector(hex: string): unknown {
  return decoder.decode(fromHex(hex));
}

const addrOf = (fill: number) => Uint8Array.from(new Array(20).fill(fill));

// --- the vectors ------------------------------------------------------------

/** `AdminSignerRegistryInfo { registry: Some(version 7, threshold 2, 3 members) }` */
const REGISTRY_PRESENT =
  "9193070293dc0014ccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaadc0014ccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbdc0014cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

/** `AdminSignerRegistryInfo { registry: None }` — multisig inactive. */
const REGISTRY_ABSENT = "91c0";

/** `ProposalPage` — one Pending proposal wrapping a CreateMarket, no cursor. */
const PAGE_PENDING_CREATE_MARKET =
  "92919f2aa750656e64696e67a750656e64696e670702dc0014ccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaa92dc0014ccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaadc0014ccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbb91dc0014ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccce000f4549cf0000018bcfe56800cf0000018bd50bc4000181ac4372656174654d61726b65749ccd1092cd03e8cd01f40703dc00140000000000000000000000000000000000000000ce0036ee80cd03200904a4474f4c44ce075bcd1595ccdeccadccbeccef01dc00205a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5ac0";

/** `ProposalPage` — an Executed proposal wrapping a registry rewrite, with a cursor. */
const PAGE_EXECUTED_REGISTRY_UPDATE =
  "92919f2ba84578656375746564a845786563757465640702dc0014ccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaa92dc0014ccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaadc0014ccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbb91dc0014ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccce000f4549cf0000018bcfe56800cf0000018bd50bc4000281b955706461746541646d696e5369676e65725265676973747279920394dc00141111111111111111111111111111111111111111dc00142222222222222222222222222222222222222222dc00143333333333333333333333333333333333333333dc0014444444444444444444444444444444444444444495ccdeccadccbeccef01dc00205a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a2b";

/** One page per `ProposalStatus` shape — the encoding that cannot be guessed. */
const PAGE_STATUS_FAILED =
  "92919f3281a64661696c656491cd0fa181a64661696c656491cd0fa10702dc0014ccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaa92dc0014ccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaadc0014ccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbb91dc0014ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccce000f4549cf0000018bcfe56800cf0000018bd50bc4000181ac4372656174654d61726b65749ccd1092cd03e8cd01f40703dc00140000000000000000000000000000000000000000ce0036ee80cd03200904a4474f4c44ce075bcd1595ccdeccadccbeccef01dc00205a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5ac0";

const PAGE_STATUS_REJECTED =
  "92919f3281a852656a656374656491dc0014ccddccddccddccddccddccddccddccddccddccddccddccddccddccddccddccddccddccddccddccdd81a852656a656374656491dc0014ccddccddccddccddccddccddccddccddccddccddccddccddccddccddccddccddccddccddccddccdd0702dc0014ccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaa92dc0014ccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaadc0014ccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbb91dc0014ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccce000f4549cf0000018bcfe56800cf0000018bd50bc4000181ac4372656174654d61726b65749ccd1092cd03e8cd01f40703dc00140000000000000000000000000000000000000000ce0036ee80cd03200904a4474f4c44ce075bcd1595ccdeccadccbeccef01dc00205a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5ac0";

const PAGE_STATUS_EXPIRED_TTL =
  "92919f3281a74578706972656491a354746c81a74578706972656491a354746c0702dc0014ccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaa92dc0014ccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaadc0014ccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbb91dc0014ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccce000f4549cf0000018bcfe56800cf0000018bd50bc4000181ac4372656174654d61726b65749ccd1092cd03e8cd01f40703dc00140000000000000000000000000000000000000000ce0036ee80cd03200904a4474f4c44ce075bcd1595ccdeccadccbeccef01dc00205a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5ac0";

const PAGE_STATUS_EXPIRED_REGISTRY_CHANGED =
  "92919f3281a74578706972656491af52656769737472794368616e67656481a74578706972656491af52656769737472794368616e6765640702dc0014ccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaa92dc0014ccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaadc0014ccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbbccbb91dc0014ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccce000f4549cf0000018bcfe56800cf0000018bd50bc4000181ac4372656174654d61726b65749ccd1092cd03e8cd01f40703dc00140000000000000000000000000000000000000000ce0036ee80cd03200904a4474f4c44ce075bcd1595ccdeccadccbeccef01dc00205a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5ac0";

/** `ProposalPage { items: [], next_cursor: None }` */
const PAGE_EMPTY = "9290c0";

/** Pull the single proposal out of a one-item page vector. */
function firstProposal(hex: string) {
  const [items] = decodeVector(hex) as [unknown[], unknown];
  return decodeProposalDisplayInfo(items[0] as unknown[], 0);
}

describe("decodeAdminSignerRegistry", () => {
  it("decodes a seeded registry from engine bytes", () => {
    const [registry] = decodeVector(REGISTRY_PRESENT) as [unknown];
    expect(decodeAdminSignerRegistry(registry)).toEqual({
      version: 7n,
      threshold: 2,
      members: [addrOf(0xaa), addrOf(0xbb), addrOf(0xcc)],
    });
  });

  it("returns null when no registry is seeded (multisig inactive)", () => {
    const [registry] = decodeVector(REGISTRY_ABSENT) as [unknown];
    expect(registry).toBeNull();
    expect(decodeAdminSignerRegistry(registry)).toBeNull();
  });

  it("normalizes a small version to bigint", () => {
    // Version 7 encodes as a msgpack fixint, so it arrives as `number`. The
    // declared type is bigint; a field's type must not depend on magnitude.
    const [registry] = decodeVector(REGISTRY_PRESENT) as [unknown];
    expect(typeof decodeAdminSignerRegistry(registry)!.version).toBe("bigint");
  });

  it("rebuilds members as bytes, not as the number[] the wire carries", () => {
    // serde encodes [u8; 20] as an ARRAY OF INTEGERS, not msgpack bin.
    const [registry] = decodeVector(REGISTRY_PRESENT) as [unknown];
    const members = decodeAdminSignerRegistry(registry)!.members;
    expect(members[0]).toBeInstanceOf(Uint8Array);
    expect(members[0]!.length).toBe(20);
  });
});

describe("decodeProposalDisplayInfo", () => {
  it("decodes every field of a pending CreateMarket proposal", () => {
    const p = firstProposal(PAGE_PENDING_CREATE_MARKET);
    // Each value is distinct in the source record, so a transposed decode
    // cannot coincidentally satisfy this.
    expect(p.proposalId).toBe(42n);
    expect(p.statusStored).toEqual({ kind: "Pending" });
    expect(p.statusEffective).toEqual({ kind: "Pending" });
    expect(p.registryVersion).toBe(7n);
    expect(p.threshold).toBe(2);
    expect(p.proposer).toEqual(addrOf(0xaa));
    expect(p.approvals).toEqual([addrOf(0xaa), addrOf(0xbb)]);
    expect(p.rejections).toEqual([addrOf(0xcc)]);
    expect(p.createdHeight).toBe(1_000_777n);
    expect(p.createdMs).toBe(1_700_000_000_000n);
    expect(p.expiryMs).toBe(1_700_086_400_000n);
    expect(p.actionTag).toBe(1);
    expect(p.actionCanonicalBytes).toEqual(
      Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x01]),
    );
    expect(p.contentHash).toEqual(Uint8Array.from(new Array(32).fill(0x5a)));
  });

  it("decodes the wrapped CreateMarket with its own field order intact", () => {
    const p = firstProposal(PAGE_PENDING_CREATE_MARKET);
    expect(p.action.kind).toBe("CreateMarket");
    if (p.action.kind !== "CreateMarket") throw new Error("unreachable");
    expect(p.action.value).toEqual({
      market: 4242,
      imBps: 1000,
      mmBps: 500,
      takerFeeBps: 7,
      makerFeeBps: 3,
      signer: Uint8Array.from(new Array(20).fill(0)),
      fundingIntervalMs: 3_600_000n,
      maxFundingRateBps: 800,
      poolId: 9,
      szDecimals: 4,
      ticker: "GOLD",
      maxOpenInterest: 123_456_789n,
    });
  });

  it("decodes a wrapped signer-registry rewrite", () => {
    const p = firstProposal(PAGE_EXECUTED_REGISTRY_UPDATE);
    expect(p.proposalId).toBe(43n);
    expect(p.statusEffective).toEqual({ kind: "Executed" });
    expect(p.actionTag).toBe(2);
    expect(p.action.kind).toBe("UpdateAdminSignerRegistry");
    if (p.action.kind !== "UpdateAdminSignerRegistry")
      throw new Error("unreachable");
    expect(p.action.value.newThreshold).toBe(3);
    expect(p.action.value.newMembers).toEqual([
      addrOf(0x11),
      addrOf(0x22),
      addrOf(0x33),
      addrOf(0x44),
    ]);
  });

  it("names the page position when a proposal is malformed", () => {
    expect(() => decodeProposalDisplayInfo([1, "Pending"], 3)).toThrow(
      /proposal\[3\]/,
    );
  });
});

describe("decodeProposalStatus — every variant shape", () => {
  // Unit variants encode as bare strings, payload variants as single-entry
  // maps whose payload is itself a positional array. Neither is visible in
  // the Rust enum definition; both are pinned here by engine bytes.
  it("decodes a unit variant carried as a bare string", () => {
    expect(firstProposal(PAGE_PENDING_CREATE_MARKET).statusStored).toEqual({
      kind: "Pending",
    });
    expect(firstProposal(PAGE_EXECUTED_REGISTRY_UPDATE).statusStored).toEqual({
      kind: "Executed",
    });
  });

  it("decodes Failed with its unnarrowed engine error code", () => {
    expect(firstProposal(PAGE_STATUS_FAILED).statusEffective).toEqual({
      kind: "Failed",
      code: 4001,
    });
  });

  it("decodes Rejected with the deciding member", () => {
    expect(firstProposal(PAGE_STATUS_REJECTED).statusEffective).toEqual({
      kind: "Rejected",
      by: addrOf(0xdd),
    });
  });

  it.each([
    ["Ttl", PAGE_STATUS_EXPIRED_TTL],
    ["RegistryChanged", PAGE_STATUS_EXPIRED_REGISTRY_CHANGED],
  ])("decodes Expired with reason %s", (reason, hex) => {
    expect(firstProposal(hex).statusEffective).toEqual({
      kind: "Expired",
      reason,
    });
  });

  it("fails closed on a status this build does not know", () => {
    // An engine that adds a variant must not be rendered as though this SDK
    // understood it — a proposal shown with the wrong status is worse than
    // one that refuses to render.
    expect(() => decodeProposalStatus("Superseded")).toThrow(/unknown/i);
    expect(() => decodeProposalStatus({ Vetoed: [1] })).toThrow(/unknown/i);
  });

  it("rejects an enum encoding with more than one variant key", () => {
    expect(() => decodeProposalStatus({ Failed: [1], Rejected: [2] })).toThrow(
      /exactly 1/,
    );
  });
});

describe("decodeAdminAction", () => {
  it("fails closed on an operation this build does not know", () => {
    // The closed inner allowlist depends on this: an unknown operation must
    // never reach a caller that would render or approve it.
    expect(() => decodeAdminAction({ DelistMarket: [1] })).toThrow(/unknown/i);
  });

  it("rejects a non-enum value", () => {
    expect(() => decodeAdminAction("CreateMarket")).toThrow(
      /not an enum variant/,
    );
  });
});

describe("page envelope", () => {
  it("decodes an empty page", () => {
    expect(decodeProposalPage(decodeVector(PAGE_EMPTY))).toEqual({
      proposals: [],
      nextCursor: null,
    });
  });

  it("carries the next cursor when one is present", () => {
    // 43 is a fixint, so it arrives as `number` — the client normalizes it.
    expect(
      decodeProposalPage(decodeVector(PAGE_EXECUTED_REGISTRY_UPDATE))
        .nextCursor,
    ).toBe(43n);
  });

  it("decodes the registry envelope without conflating malformed data with inactivity", () => {
    expect(decodeAdminSignerRegistryInfo(decodeVector(REGISTRY_ABSENT))).toBe(
      null,
    );
    expect(() => decodeAdminSignerRegistryInfo([])).toThrow(
      /registryInfo has 0 fields, expected exactly 1/,
    );
    expect(() => decodeAdminSignerRegistryInfo([null, null])).toThrow(
      /registryInfo has 2 fields, expected exactly 1/,
    );
  });

  it("rejects malformed proposal-page envelopes", () => {
    expect(() => decodeProposalPage([])).toThrow(
      /proposalPage has 0 fields, expected exactly 2/,
    );
    expect(() => decodeProposalPage([[], null, "trailing"])).toThrow(
      /proposalPage has 3 fields, expected exactly 2/,
    );
  });
});

describe("byte-field validation", () => {
  // The byte fields on this path ARE the identities and the commitments a
  // signer approves against, so they are validated rather than coerced.
  // `Uint8Array.from` is lossy in exactly the wrong way: it truncates
  // out-of-range values modulo 256 and maps non-numbers to 0, so a corrupted
  // address would decode into a DIFFERENT but entirely plausible-looking
  // address. Every case below would have silently produced one before.

  /** The decoded-JS form of a valid proposal — what msgpack hands the
   *  decoder. Tests copy it and corrupt exactly one field. */
  function validProposalRaw(): unknown[] {
    const addr = (fill: number) => new Array(20).fill(fill);
    return [
      42n,
      "Pending",
      "Pending",
      7n,
      2,
      addr(0xaa),
      [addr(0xbb)],
      [],
      1n,
      2n,
      3n,
      1,
      {
        CreateMarket: [
          1,
          1000,
          500,
          7,
          3,
          new Array(20).fill(0),
          0n,
          800,
          0,
          4,
          "T",
          0n,
        ],
      },
      [0xde, 0xad],
      new Array(32).fill(0x5a),
    ];
  }

  /** Corrupt one positional field and decode. */
  function withField(index: number, value: unknown) {
    const raw = validProposalRaw();
    raw[index] = value;
    return () => decodeProposalDisplayInfo(raw);
  }

  it("accepts the uncorrupted baseline", () => {
    // Guards the negative cases below: if the baseline itself threw, every
    // assertion here would pass for the wrong reason.
    expect(() => decodeProposalDisplayInfo(validProposalRaw())).not.toThrow();
  });

  it("rejects missing or trailing positional fields", () => {
    const short = validProposalRaw();
    short.pop();
    expect(() => decodeProposalDisplayInfo(short)).toThrow(
      /proposal has 14 fields, expected exactly 15/,
    );

    const long = validProposalRaw();
    long.push("newer-field");
    expect(() => decodeProposalDisplayInfo(long)).toThrow(
      /proposal has 16 fields, expected exactly 15/,
    );

    expect(() => decodeAdminSignerRegistry([1n, 2, [], "trailing"])).toThrow(
      /registry has 4 fields, expected exactly 3/,
    );
    expect(() => decodeProposalStatus({ Failed: [1, "trailing"] })).toThrow(
      /Failed has 2 fields, expected exactly 1/,
    );
  });

  it("rejects an action tag that does not match the decoded action", () => {
    expect(withField(11, 2)).toThrow(
      /actionTag 2 does not match CreateMarket tag 1/,
    );
  });

  it("rejects malformed CreateMarket tuples and coerced tickers", () => {
    const raw = validProposalRaw();
    const action = raw[12] as { CreateMarket: unknown[] };
    action.CreateMarket.push("trailing");
    expect(() => decodeProposalDisplayInfo(raw)).toThrow(
      /createMarket has 13 fields, expected exactly 12/,
    );

    const nonString = validProposalRaw();
    const nonStringAction = nonString[12] as { CreateMarket: unknown[] };
    nonStringAction.CreateMarket[10] = null;
    expect(() => decodeProposalDisplayInfo(nonString)).toThrow(
      /createMarket\.ticker is not a string/,
    );
  });

  it("rejects unsafe, negative, fractional, and out-of-range integers", () => {
    expect(withField(0, -1n)).toThrow(/outside the unsigned integer range/);
    expect(withField(0, 1n << 64n)).toThrow(
      /outside the unsigned integer range/,
    );
    expect(withField(4, 0x1_0000_0000n)).toThrow(
      /outside the unsigned integer range/,
    );
    expect(withField(11, 256)).toThrow(/outside the unsigned integer range/);
    expect(withField(8, 1.5)).toThrow(/not a safe unsigned integer/);
    expect(withField(8, Number.MAX_SAFE_INTEGER + 1)).toThrow(
      /not a safe unsigned integer/,
    );
  });

  it.each([
    ["a short proposer", 5, new Array(19).fill(1)],
    ["a long proposer", 5, new Array(21).fill(1)],
    ["a short content hash", 14, new Array(31).fill(1)],
    ["a long content hash", 14, new Array(33).fill(1)],
  ])("rejects %s by length", (_label, index, value) => {
    expect(withField(index, value)).toThrow(/bytes, expected/);
  });

  it.each([
    ["above 255", 300],
    ["negative", -1],
    ["fractional", 1.5],
    ["not a number", "ff"],
    ["null", null],
  ])("rejects a byte value that is %s", (_label, bad) => {
    const corrupted = new Array(20).fill(1);
    corrupted[7] = bad;
    // Without validation, 300 would wrap to 44 and "ff"/null would become 0 —
    // a different address that still looks like a valid one.
    expect(withField(5, corrupted)).toThrow(/is not a byte/);
  });

  it("names the offending element, not just the field", () => {
    const corrupted = new Array(20).fill(1);
    corrupted[13] = 999;
    expect(withField(5, corrupted)).toThrow(/proposer\[13\]/);
  });

  it("validates every address in the approvals and rejections lists", () => {
    expect(withField(6, [new Array(19).fill(1)])).toThrow(
      /approvals\[0\] is 19 bytes/,
    );
    expect(
      withField(7, [new Array(20).fill(1), new Array(33).fill(1)]),
    ).toThrow(/rejections\[1\] is 33 bytes/);
  });

  it("validates the signer inside a wrapped CreateMarket", () => {
    const action = {
      CreateMarket: [
        1,
        1000,
        500,
        7,
        3,
        new Array(19).fill(0),
        0n,
        800,
        0,
        4,
        "T",
        0n,
      ],
    };
    expect(withField(12, action)).toThrow(
      /createMarket\.signer is 19 bytes, expected 20/,
    );
  });

  it("accepts actionCanonicalBytes at any length but still checks its elements", () => {
    // Variable by nature: it is the stored action payload, whose size
    // depends on the operation.
    expect(withField(13, [])).not.toThrow();
    expect(withField(13, new Array(500).fill(7))).not.toThrow();
    expect(withField(13, [0, 256])).toThrow(
      /actionCanonicalBytes\[1\] is not a byte/,
    );
  });

  it("validates registry members", () => {
    expect(() =>
      decodeAdminSignerRegistry([1n, 2, [new Array(20).fill(1)]]),
    ).not.toThrow();
    expect(() =>
      decodeAdminSignerRegistry([1n, 2, [new Array(19).fill(1)]]),
    ).toThrow(/registry\.members\[0\] is 19 bytes, expected 20/);
    expect(() =>
      decodeAdminSignerRegistry([1n, 2, [new Array(20).fill(-5)]]),
    ).toThrow(/is not a byte/);
  });

  it("validates the deciding member on a Rejected status", () => {
    expect(() =>
      decodeProposalStatus({ Rejected: [new Array(21).fill(1)] }),
    ).toThrow(/Rejected\.by is 21 bytes, expected 20/);
  });
});
