import { readFileSync } from "node:fs";
import { Encoder, Decoder } from "@msgpack/msgpack";
import { describe, expect, it } from "vitest";
import * as sdk from "./index.js";
import { getWasm } from "./wasm-loader.js";
import { fromWasmFields } from "./codec-adapter.js";
import type { Action, ActionTypeValue } from "./types.js";

const vector = readFileSync(
  new URL("../conformance/codec.ndjson", import.meta.url),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))
  .find((v) => v.case === "propose_admin_action/set_trigger_market_config");
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
  42,
  3,
  2,
  approvalFields.proposer,
  7,
  1000,
  259201000,
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
    "refuses proposal/approval %i across submission paths but preserves reads",
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
      expect(() => sdk.encodePayloadBytes(action as Action)).toThrow(/retired/);
      expect(() =>
        sdk.encodeSignedTx(
          action as Action,
          1n,
          new Uint8Array(32),
          new Uint8Array(64),
        ),
      ).toThrow(/retired/);
      expect(() => wasm.encode_payload(tag, fields)).toThrow(/retired/);
      expect(() =>
        wasm.encode_signed_tx(
          tag,
          payload,
          1n,
          new Uint8Array(32),
          new Uint8Array(64),
        ),
      ).toThrow(/retired/);
      expect(() =>
        wasm.sign_and_encode(
          new Uint8Array(32),
          tag,
          payload,
          1n,
          new Uint8Array(32),
        ),
      ).toThrow(/retired/);
      const message = wasm.signing_message(
        new Uint8Array(32),
        tag,
        1n,
        payload,
      );
      expect(sdk.decodeSigningMessage(message).action).toEqual(action);
    },
  );
});
