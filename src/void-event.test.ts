import { describe, expect, it } from "vitest";
import { decodeTx, encodePayloadBytes, encodeSignedTx } from "./codec.js";
import { bytesToHex } from "./crypto.js";
import { ACTION_TAG_BY_KIND, decodeAdminAction } from "./governance-query.js";
import type { Action, AdminAction } from "./types.js";
import { decodeVoidSettlementEvent } from "./void-events.js";

/** exchange-wire's bytes for `VoidEvent { event_id: 4, yes_price: 350_000 }`:
 *  the inner action of `propose_admin_action/void_event` in
 *  `conformance/codec.ndjson` (regenerate with
 *  `cargo run -p proof-trading-sdk-conformance --bin gen-vectors`). */
const VOID_HEX = "81a9566f69644576656e749204ce00055730";

const voidEvent = (yesPrice = 350_000n): AdminAction => ({
  kind: "VoidEvent",
  value: { eventId: 4, yesPrice },
});

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

const attrs = (pairs: [string, string][]) =>
  pairs.map(([key, value]) => ({ key, value }));

describe("VoidEvent admin action", () => {
  it("carries inner tag 29", () => {
    expect(ACTION_TAG_BY_KIND.VoidEvent).toBe(29);
  });

  it("encodes to exchange-wire's bytes", () => {
    const payload = bytesToHex(encodePayloadBytes(propose(voidEvent())));
    expect(payload.endsWith(`01${VOID_HEX}`)).toBe(true);
  });

  it("round-trips through the WASM codec", () => {
    const tx = encodeSignedTx(
      propose(voidEvent()),
      12n,
      new Uint8Array(32),
      new Uint8Array(64),
    );
    expect(decodeTx(tx).action).toEqual(propose(voidEvent()));
  });

  it("decodes from its wire tuple", () => {
    expect(decodeAdminAction({ VoidEvent: [4, 350_000] })).toEqual(voidEvent());
  });

  it("refuses a Yes price above 1_000_000", () => {
    expect(() => encodePayloadBytes(propose(voidEvent(1_000_001n)))).toThrow(
      /yesPrice 1000001 is outside/,
    );
    expect(() =>
      encodePayloadBytes(propose(voidEvent(1_000_000n))),
    ).not.toThrow();
  });
});

describe("decodeVoidSettlementEvent", () => {
  it("decodes event_voided", () => {
    expect(
      decodeVoidSettlementEvent({
        type: "event_voided",
        attributes: attrs([
          ["event_id", "4"],
          ["yes_price", "350000"],
          ["timestamp_ms", "1700000000000"],
          ["proposal_id", "12"],
        ]),
      }),
    ).toEqual({
      type: "EventVoided",
      eventId: 4,
      yesPrice: 350_000n,
      timestampMs: 1_700_000_000_000n,
      proposalId: 12n,
    });
  });

  it("decodes conditional_void_settled with a signed result", () => {
    expect(
      decodeVoidSettlementEvent({
        type: "conditional_void_settled",
        attributes: {
          event_id: "4",
          market: "9",
          owner: "ab".repeat(20),
          side: "sell",
          size: "5",
          entry_price: "60000000",
          settlement_price: "64000000",
          branch_weight: "650000",
          realized_pnl: "-13000000",
        },
      }),
    ).toEqual({
      type: "ConditionalVoidSettled",
      eventId: 4,
      market: 9,
      owner: "ab".repeat(20),
      side: "sell",
      size: 5n,
      entryPrice: 60_000_000n,
      settlementPrice: 64_000_000n,
      branchWeight: 650_000n,
      realizedPnl: -13_000_000n,
    });
  });

  it("returns null for another event and throws on a missing attribute", () => {
    expect(
      decodeVoidSettlementEvent({ type: "event_resolved", attributes: [] }),
    ).toBeNull();
    expect(() =>
      decodeVoidSettlementEvent({
        type: "event_voided",
        attributes: attrs([["event_id", "4"]]),
      }),
    ).toThrow(/event_voided decode: yes_price is missing/);
  });
});
