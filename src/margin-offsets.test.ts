import { describe, expect, it } from "vitest";
import { adminActionToWasm } from "./codec-adapter.js";
import { decodeTx, encodePayloadBytes, encodeSignedTx } from "./codec.js";
import { bytesToHex } from "./crypto.js";
import { ACTION_TAG_BY_KIND, decodeAdminAction } from "./governance-query.js";
import {
  MAX_MARGIN_OFFSET_PAIRS,
  decodeMarginOffsetEvent,
  validateSetMarginOffsetPolicy,
} from "./margin-offsets.js";
import type { Action, AdminAction, MarginOffsetPair } from "./types.js";

function pair(overrides: Partial<MarginOffsetPair> = {}): MarginOffsetPair {
  return {
    perpetual: 1,
    conditional: 2,
    settlementReference: 1,
    rate: 5_000,
    resolution: "RemoveOnResolution",
    ...overrides,
  };
}

function policy(
  overrides: Partial<{
    predecessor: bigint | null;
    pairs: MarginOffsetPair[];
  }> = {},
): AdminAction {
  return {
    kind: "SetMarginOffsetPolicy",
    value: {
      predecessor: null,
      pairs: [pair()],
      ...overrides,
    },
  };
}

function pairEvent(index: number, resolution = "remove_on_resolution") {
  return {
    type: "margin_offset_pair_configured",
    attributes: [
      { key: "sequence", value: "1" },
      { key: "index", value: String(index) },
      { key: "conditional_market", value: "2" },
      { key: "perpetual_market", value: "1" },
      { key: "settlement_reference_market", value: "1" },
      { key: "rate_bps", value: "5000" },
      { key: "resolution", value: resolution },
    ],
  };
}

function propose(action: AdminAction): Action {
  return {
    type: "ProposeAdminAction",
    data: {
      proposer: new Uint8Array(20).fill(0xa1),
      registryVersion: 1n,
      action,
    },
  };
}

/** exchange-wire's frozen `canonical_admin_action_bytes` (the action map
 *  carries the variant name, not the tag; the proposal envelope carries
 *  inner tag 0x1B). */
const FROZEN_ACTION_HEX =
  "81b55365744d617267696e4f6666736574506f6c69637992c09195010201cd1388b252656d6f76654f6e5265736f6c7574696f6e";
const FROZEN_REVOKE_HEX =
  "81b55365744d617267696e4f6666736574506f6c696379920190";

describe("SetMarginOffsetPolicy governance action", () => {
  it("carries inner tag 0x1B (27)", () => {
    expect(ACTION_TAG_BY_KIND.SetMarginOffsetPolicy).toBe(27);
  });

  it("translates to the snake_case wasm shape", () => {
    // `convertObject` drops nullish fields: a missing `predecessor` is
    // `Option::None` on the Rust side, and both encode as nil.
    expect(adminActionToWasm(policy())).toEqual({
      SetMarginOffsetPolicy: {
        pairs: [
          {
            perpetual: 1,
            conditional: 2,
            settlement_reference: 1,
            rate: 5_000,
            resolution: "RemoveOnResolution",
          },
        ],
      },
    });
  });

  it("encodes the proposal to exchange-wire's frozen action bytes", () => {
    const payload = bytesToHex(encodePayloadBytes(propose(policy())));
    expect(payload.endsWith(`01${FROZEN_ACTION_HEX}`)).toBe(true);
  });

  it("encodes revocation to the frozen empty-policy bytes", () => {
    const payload = bytesToHex(
      encodePayloadBytes(propose(policy({ predecessor: 1n, pairs: [] }))),
    );
    expect(payload.endsWith(`01${FROZEN_REVOKE_HEX}`)).toBe(true);
  });

  it("round-trips a proposal through the WASM codec", () => {
    const action = propose(policy());
    const tx = encodeSignedTx(
      action,
      12n,
      new Uint8Array(32),
      new Uint8Array(64),
    );
    expect(decodeTx(tx).action).toEqual(action);
  });

  it("decodes a proposal from its wire tuple", () => {
    expect(
      decodeAdminAction({
        SetMarginOffsetPolicy: [null, [[1, 2, 1, 5_000, "RemoveOnResolution"]]],
      }),
    ).toEqual(policy());
    expect(decodeAdminAction({ SetMarginOffsetPolicy: [1n, []] })).toEqual(
      policy({ predecessor: 1n, pairs: [] }),
    );
  });

  it("fails closed on a malformed wire tuple", () => {
    expect(() =>
      decodeAdminAction({
        SetMarginOffsetPolicy: [null, [[1, 1, 1, 5_000, "RemoveOnResolution"]]],
      }),
    ).toThrow(/pair markets must differ/);
    expect(() =>
      decodeAdminAction({
        SetMarginOffsetPolicy: [null, [[1, 2, 2, 5_000, "RemoveOnResolution"]]],
      }),
    ).toThrow(/settlementReference must equal perpetual/);
    expect(() =>
      decodeAdminAction({
        SetMarginOffsetPolicy: [
          null,
          [[1, 2, 1, 10_000, "RemoveOnResolution"]],
        ],
      }),
    ).toThrow(/at most 9999/);
  });
});

describe("client-side offset policy validation", () => {
  it("accepts the frozen policy and rejects canonical violations", () => {
    expect(() =>
      validateSetMarginOffsetPolicy((policy() as { value: never }).value),
    ).not.toThrow();
    const bad = policy({ pairs: [pair(), pair()] }) as {
      value: { pairs: MarginOffsetPair[] };
    };
    bad.value.pairs[1] = pair({ conditional: 2 });
    expect(() => validateSetMarginOffsetPolicy(bad.value)).toThrow(
      /strictly increasing/,
    );
    expect(() =>
      validateSetMarginOffsetPolicy({ predecessor: 0n, pairs: [] }),
    ).toThrow(/nonzero/);
    expect(() =>
      validateSetMarginOffsetPolicy({
        predecessor: null,
        pairs: Array.from({ length: MAX_MARGIN_OFFSET_PAIRS + 1 }, (_, i) =>
          pair({ conditional: i + 2 }),
        ),
      }),
    ).toThrow(/at most/);
  });
});

describe("offset event decoding", () => {
  it("decodes the summary event", () => {
    expect(
      decodeMarginOffsetEvent({
        type: "margin_offset_policy_set",
        attributes: [
          { key: "sequence", value: "1" },
          { key: "pair_count", value: "0" },
          { key: "proposal_id", value: "42" },
        ],
      }),
    ).toEqual({
      type: "MarginOffsetPolicySet",
      sequence: 1n,
      pairCount: 0,
      proposalId: 42n,
    });
    // A proposal id has no non-zero floor, unlike the policy sequence.
    const zero = decodeMarginOffsetEvent({
      type: "margin_offset_policy_set",
      attributes: [
        { key: "sequence", value: "1" },
        { key: "pair_count", value: "0" },
        { key: "proposal_id", value: "0" },
      ],
    });
    expect(zero).toMatchObject({ proposalId: 0n });
  });

  it("decodes a pair event into a validated pair", () => {
    expect(
      decodeMarginOffsetEvent({
        type: "margin_offset_pair_configured",
        attributes: [
          { key: "sequence", value: "1" },
          { key: "index", value: "0" },
          { key: "conditional_market", value: "2" },
          { key: "perpetual_market", value: "1" },
          { key: "settlement_reference_market", value: "1" },
          { key: "rate_bps", value: "5000" },
          { key: "resolution", value: "remove_on_resolution" },
        ],
      }),
    ).toEqual({
      type: "MarginOffsetPairConfigured",
      sequence: 1n,
      index: 0,
      pair: pair(),
    });
  });

  it("enforces the declared bounds and the attribute contract", () => {
    expect(() => decodeMarginOffsetEvent(pairEvent(52))).toThrow(/exceeds 51/);
    expect(() => decodeMarginOffsetEvent(pairEvent(0, "keep"))).toThrow(
      /unknown offset resolution/,
    );
    expect(() =>
      decodeMarginOffsetEvent({
        type: "margin_offset_policy_set",
        attributes: [
          { key: "sequence", value: "1" },
          { key: "pair_count", value: "53" },
          { key: "proposal_id", value: "1" },
        ],
      }),
    ).toThrow(/exceeds 52/);
    expect(() => decodeMarginOffsetEvent(pairEvent(0))).not.toThrow();
    expect(() =>
      decodeMarginOffsetEvent({
        type: "margin_offset_policy_set",
        attributes: [
          { key: "sequence", value: "1" },
          { key: "sequence", value: "1" },
          { key: "pair_count", value: "0" },
          { key: "proposal_id", value: "1" },
        ],
      }),
    ).toThrow(/duplicate offset attribute/);
  });

  it("returns null for other events and throws on malformed ones", () => {
    expect(
      decodeMarginOffsetEvent({ type: "order_placed", attributes: [] }),
    ).toBeNull();
    expect(() =>
      decodeMarginOffsetEvent({
        type: "margin_offset_pair_configured",
        attributes: [
          { key: "sequence", value: "1" },
          { key: "index", value: "0" },
          { key: "conditional_market", value: "1" },
          { key: "perpetual_market", value: "1" },
          { key: "settlement_reference_market", value: "1" },
          { key: "rate_bps", value: "5000" },
          { key: "resolution", value: "remove_on_resolution" },
        ],
      }),
    ).toThrow(/pair markets must differ/);
  });
});
