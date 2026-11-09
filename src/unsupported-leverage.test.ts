import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  ActionType,
  ExchangeClient,
  decodeTx,
  decodeSigningMessage,
  signingMessage,
  getPublicKey,
  encodePayloadBytes,
  encodeSignedTx,
  peekActionType,
  signAndEncode,
  signEnvelopeFromPayload,
  type Action,
} from "./index.js";
import { getWasm } from "./wasm-loader.js";

const vector = JSON.parse(
  readFileSync(
    new URL("../conformance/historical-codec.ndjson", import.meta.url),
    "utf8",
  ),
);
const payload = Uint8Array.from(Buffer.from(vector.expect.payload_hex, "hex"));
const envelope = Uint8Array.from(
  Buffer.from(vector.expect.envelope_hex, "hex"),
);
const legacy = {
  type: "SetUserMarketLeverage",
  data: { owner: new Uint8Array(20).fill(1), market: 7, userImBps: 2000 },
} as unknown as Action;
const key = new Uint8Array(32).fill(0x42);
const chain = new Uint8Array(32);
const refusal = /SetUserMarketLeverage .* is not supported/;

describe("unsupported leverage creation", () => {
  it("removes the active type but decodes frozen wire history", () => {
    expect(ActionType).not.toHaveProperty("SetUserMarketLeverage");
    expect(peekActionType(envelope)).toBeNull();
    expect(decodeTx(envelope).action).toEqual(legacy);
    expect(getWasm().decode_payload(0x16, payload)).toMatchObject({
      market: 7,
      user_im_bps: 2000,
    });
  });

  it.each([
    () => encodePayloadBytes(legacy),
    () => encodeSignedTx(legacy, 1n, chain, new Uint8Array(64)),
    () => signAndEncode(chain, legacy, 1n, key),
    () => signEnvelopeFromPayload(chain, 0x16, 1n, payload, key),
    () => getWasm().encode_payload(0x16, vector.input),
    () =>
      getWasm().encode_signed_tx(0x16, payload, 1n, chain, new Uint8Array(64)),
  ])("refuses typed casts and generic payload entrypoints", (call) => {
    expect(call).toThrow(refusal);
  });

  it("refuses before invoking an external signer", async () => {
    const signRaw = vi.fn(async () => new Uint8Array(64));
    const client = new ExchangeClient({ chainId: "unsupported-test" });
    client.setExternalSigner({ publicKey: getPublicKey(key), signRaw });
    await expect(client.signTx(legacy)).rejects.toThrow(refusal);
    expect(signRaw).not.toHaveBeenCalled();
  });

  it("marks the historical signing preimage unsupported for signer review", () => {
    const decoded = decodeSigningMessage(
      signingMessage(chain, 0x16, 1n, payload),
    );
    expect(decoded.actionName).toBe("SetUserMarketLeverage");
    expect(decoded.action).toBeNull();
    expect(decoded.decodeError).toMatch(refusal);
  });

  it("refuses client submission without sending HTTP", async () => {
    const transport = vi.fn(async () => {
      throw new Error("must not send unsupported action");
    });
    const client = new ExchangeClient({
      gatewayUrl: "http://unused.invalid",
      chainId: "unsupported-test",
      httpTransport: transport,
    });
    client.setPrivateKey(key);
    client.setUnsafeFastSubmit(true);
    await expect(client.submitTx(legacy)).rejects.toThrow(refusal);
    expect(transport).not.toHaveBeenCalled();
  });
});
