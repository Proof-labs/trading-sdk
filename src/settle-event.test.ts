import { describe, expect, it } from "vitest";
import { decodeTx, encodePayloadBytes, encodeSignedTx } from "./codec.js";
import { bytesToHex } from "./crypto.js";
import { ACTION_TAG_BY_KIND, decodeAdminAction } from "./governance-query.js";
import { Outcome, type Action, type AdminAction } from "./types.js";

/** exchange-wire's bytes for `SettleEvent { event_id: 4, outcome: No }`:
 *  the inner action of `propose_admin_action/settle_event` in
 *  `conformance/codec.ndjson` (regenerate with
 *  `cargo run -p proof-trading-sdk-conformance --bin gen-vectors`). */
const SETTLE_HEX = "81ab536574746c654576656e749204a24e6f";

const settleEvent = (outcome = Outcome.No): AdminAction => ({
  kind: "SettleEvent",
  value: { eventId: 4, outcome },
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

describe("SettleEvent admin action", () => {
  it("encodes to exchange-wire's bytes", () => {
    const payload = bytesToHex(encodePayloadBytes(propose(settleEvent())));
    expect(payload.endsWith(`01${SETTLE_HEX}`)).toBe(true);
  });

  it.each([Outcome.Yes, Outcome.No])(
    "round-trips outcome %s through the WASM codec",
    (outcome) => {
      const tx = encodeSignedTx(
        propose(settleEvent(outcome)),
        12n,
        new Uint8Array(32),
        new Uint8Array(64),
      );
      expect(decodeTx(tx).action).toEqual(propose(settleEvent(outcome)));
    },
  );

  it("decodes from its wire tuple, so a pending proposal lists", () => {
    expect(decodeAdminAction({ SettleEvent: [4, "No"] })).toEqual(
      settleEvent(),
    );
    expect(ACTION_TAG_BY_KIND.SettleEvent).toBe(30);
  });

  it("refuses a Void outcome", () => {
    expect(() =>
      encodePayloadBytes(propose(settleEvent(Outcome.Void))),
    ).toThrow(/outcome must be Yes or No, got Void/);
  });
});
