import { describe, expect, it } from "vitest";
import { decodeTx, encodePayloadBytes, encodeSignedTx } from "./codec.js";
import { bytesToHex } from "./crypto.js";
import { ACTION_TAG_BY_KIND, decodeAdminAction } from "./governance-query.js";
import type { Action, AdminAction, MarketStatus } from "./types.js";

/** exchange-wire's bytes for `SetMarketStatus { market: 7, status: ReduceOnly }`:
 *  the inner action of `propose_admin_action/set_market_status` in
 *  `conformance/codec.ndjson`. */
const SET_MARKET_STATUS_HEX =
  "81af5365744d61726b65745374617475739207aa5265647563654f6e6c79";

const setMarketStatus = (status: MarketStatus = "ReduceOnly"): AdminAction => ({
  kind: "SetMarketStatus",
  value: { market: 7, status },
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

describe("SetMarketStatus admin action", () => {
  it("encodes to exchange-wire's bytes", () => {
    const payload = bytesToHex(encodePayloadBytes(propose(setMarketStatus())));
    expect(payload.endsWith(`01${SET_MARKET_STATUS_HEX}`)).toBe(true);
  });

  it.each<MarketStatus>(["Trading", "ReduceOnly", "Halted", "Delisted"])(
    "round-trips status %s through the WASM codec",
    (status) => {
      const tx = encodeSignedTx(
        propose(setMarketStatus(status)),
        12n,
        new Uint8Array(32),
        new Uint8Array(64),
      );
      expect(decodeTx(tx).action).toEqual(propose(setMarketStatus(status)));
    },
  );

  it("decodes from its wire tuple, so a pending proposal lists", () => {
    expect(decodeAdminAction({ SetMarketStatus: [7, "ReduceOnly"] })).toEqual(
      setMarketStatus(),
    );
    expect(ACTION_TAG_BY_KIND.SetMarketStatus).toBe(31);
  });
});
