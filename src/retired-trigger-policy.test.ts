import { readFileSync } from "node:fs";
import { Encoder, Decoder } from "@msgpack/msgpack";
import { describe, expect, it } from "vitest";
import * as sdk from "./index.js";
import { getWasm } from "./wasm-loader.js";
import { fromWasmFields } from "./codec-adapter.js";
import type { Action, ActionTypeValue } from "./types.js";

const vectorCase = "propose_admin_action/set_trigger_market_config";
const vector = readFileSync(
  new URL("../conformance/codec.ndjson", import.meta.url),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))
  .find((v) => v.case === vectorCase);
if (!vector) throw new Error(`Missing conformance case: ${vectorCase}`);
const encoder = new Encoder({ useBigInt64: true });
const proposal = Uint8Array.from(Buffer.from(vector.expect.payload_hex, "hex"));
const retired = new Decoder({ useBigInt64: true }).decode(
  proposal,
) as unknown[];
const approvalFields = {
  approver: Array(20).fill(0),
  proposal_id: 42n,
  registry_version: 3n,
  threshold: 2,
  proposer: vector.input.proposer,
  created_height: 7n,
  created_ms: 1000n,
  expiry_ms: 259201000n,
  action: vector.input.action,
  content_hash: Array(32).fill(0),
};
const approval = encoder.encode([
  approvalFields.approver,
  Number(approvalFields.proposal_id),
  Number(approvalFields.registry_version),
  approvalFields.threshold,
  approvalFields.proposer,
  Number(approvalFields.created_height),
  Number(approvalFields.created_ms),
  Number(approvalFields.expiry_ms),
  retired[2],
  approvalFields.content_hash,
]);

describe("retired trigger policy", () => {
  it("removes the public query and validator", () => {
    expect("queryTriggerMarketConfigs" in sdk.ExchangeClient.prototype).toBe(
      false,
    );
    expect("validateSetTriggerMarketConfig" in sdk).toBe(false);
  });
  it.each([
    [30, vector.input, proposal],
    [31, approvalFields, approval],
  ] as const)(
    "preserves proposal/approval %i wire encoding without copying engine policy",
    (tag, fields, payload) => {
      const wasm = getWasm();
      const action = fromWasmFields(
        tag as ActionTypeValue,
        wasm.decode_payload(tag, payload),
      );
      const envelope = encoder.encode([
        2,
        tag,
        1n,
        payload,
        new Uint8Array(32),
        new Uint8Array(64),
      ]);
      expect(sdk.decodeTx(envelope).action).toEqual(action);
      expect(sdk.isSubmittableAction(action)).toBe(false);
      // Deliberately exercise the low-level wire escape hatch for historical
      // actions; typed resubmission must first use isSubmittableAction.
      expect(sdk.encodePayloadBytes(action as Action)).toEqual(payload);
      expect(wasm.encode_payload(tag, fields)).toEqual(payload);
      for (const encoded of [
        sdk.encodeSignedTx(
          action as Action,
          1n,
          new Uint8Array(32),
          new Uint8Array(64),
        ),
        wasm.encode_signed_tx(
          tag,
          payload,
          1n,
          new Uint8Array(32),
          new Uint8Array(64),
        ),
        wasm.sign_and_encode(
          new Uint8Array(32),
          tag,
          payload,
          1n,
          new Uint8Array(32),
        ),
      ]) {
        expect(sdk.decodeTx(encoded).action).toEqual(action);
      }
      const message = wasm.signing_message(
        new Uint8Array(32),
        tag,
        1n,
        payload,
      );
      expect(sdk.decodeSigningMessage(message).action).toEqual(action);
      if (
        action.type !== "ProposeAdminAction" &&
        action.type !== "ApproveAdminAction"
      ) {
        throw new Error(`Unexpected governance action type: ${action.type}`);
      }
      const current: Action =
        action.type === "ProposeAdminAction"
          ? {
              ...action,
              data: { ...action.data, action: { kind: "UnpauseBridge" } },
            }
          : {
              ...action,
              data: { ...action.data, action: { kind: "UnpauseBridge" } },
            };
      expect(sdk.isSubmittableAction(current)).toBe(true);
      // The admin-level guard narrows a bare DecodedAdminAction (approval
      // flows hold one) without a cast.
      expect(sdk.isSubmittableAdminAction(action.data.action)).toBe(false);
      expect(sdk.isSubmittableAdminAction(current.data.action)).toBe(true);
    },
  );
  it("allows ordinary current actions through the narrowing guard", () => {
    expect(
      sdk.isSubmittableAction({
        type: "CancelOrder",
        data: { orderId: 1n, owner: new Uint8Array(20) },
      }),
    ).toBe(true);
  });
});
