import { Decoder, Encoder } from "@msgpack/msgpack";
import { beforeAll, describe, expect, it } from "vitest";
import {
  adminProposalContentHash,
  decodeTx,
  encodePayloadBytes,
  encodeSignedTx,
} from "./codec.js";
import { bytesToHex } from "./crypto.js";
import { ready } from "./wasm-loader.js";
import {
  decodePositionTriggerInfos,
  decodeTriggerMarketConfigInfos,
  decodeTriggerStatusJson,
  validateOrderTriggers,
  validateSetPositionTriggers,
} from "./triggers.js";
import type { Action, AdminAction, SetPositionTriggers } from "./types.js";

const SET_PAYLOAD =
  "9607dc0014cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca50393ce000173184b0b93ce0001adb0320c09";
const SET_ENVELOPE =
  "9602252ac43f9607dc0014cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca50393ce000173184b0b93ce0001adb0320c09c4201111111111111111111111111111111111111111111111111111111111111111c44022222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222";
const CANCEL_PAYLOAD =
  "9307dc0014cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca503";
const CANCEL_ENVELOPE =
  "9602262ac42e9307dc0014cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca503c4201111111111111111111111111111111111111111111111111111111111111111c44022222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222";

const setData = (): SetPositionTriggers => ({
  market: 7,
  owner: new Uint8Array(20).fill(0xa5),
  expectedPositionEpoch: 3n,
  stopLoss: {
    triggerPrice: 95_000n,
    maxSlippageBps: 75,
    clientTriggerId: 11n,
  },
  takeProfit: {
    triggerPrice: 110_000n,
    maxSlippageBps: 50,
    clientTriggerId: 12n,
  },
  clientGroupId: 9n,
});

beforeAll(async () => ready());

describe("W32-10 position trigger wire contract", () => {
  it("matches both exact engine payload/envelope vectors", () => {
    const actions: Array<[Action, string, string]> = [
      [
        { type: "SetPositionTriggers", data: setData() },
        SET_PAYLOAD,
        SET_ENVELOPE,
      ],
      [
        {
          type: "CancelPositionTriggers",
          data: {
            market: 7,
            owner: new Uint8Array(20).fill(0xa5),
            expectedPositionEpoch: 3n,
          },
        },
        CANCEL_PAYLOAD,
        CANCEL_ENVELOPE,
      ],
    ];
    for (const [action, payload, envelope] of actions) {
      expect(bytesToHex(encodePayloadBytes(action))).toBe(payload);
      expect(
        bytesToHex(
          encodeSignedTx(
            action,
            42n,
            new Uint8Array(32).fill(0x11),
            new Uint8Array(64).fill(0x22),
          ),
        ),
      ).toBe(envelope);
    }
  });

  it("rejects empty, zero-id and duplicate-id brackets before encoding", () => {
    const empty = setData();
    empty.stopLoss = null;
    empty.takeProfit = null;
    expect(() => validateSetPositionTriggers(empty)).toThrow(/at least one/);

    const zeroEpoch = setData();
    zeroEpoch.expectedPositionEpoch = 0n;
    expect(() =>
      encodePayloadBytes({ type: "SetPositionTriggers", data: zeroEpoch }),
    ).toThrow(/epoch.*non-zero/i);

    const duplicate = setData();
    duplicate.takeProfit!.clientTriggerId = 11n;
    expect(() => validateSetPositionTriggers(duplicate)).toThrow(/must differ/);
  });

  it("matches the engine's admin tag-5 proposal hash", () => {
    const action: AdminAction = {
      kind: "SetTriggerMarketConfig",
      value: {
        market: 7,
        expectedCurrentVersion: 3n,
        enabled: true,
        maxTriggerSlippageBps: 250,
        maxMarkAgeMs: 5_000n,
        maxFuturePublishSkewMs: 1_000n,
        maxActiveBrackets: 32n,
      },
    };
    expect(
      bytesToHex(
        adminProposalContentHash({
          chainId: new Uint8Array(32).fill(0x11),
          proposalId: 42n,
          registryVersion: 3n,
          threshold: 2,
          proposer: new Uint8Array(20).fill(0x22),
          createdHeight: 7n,
          createdMs: 1_000n,
          expiryMs: 259_201_000n,
          action,
        }),
      ),
    ).toBe("c707537e8d050389a705df1ce0aa2ad1cf873e67d1c45d10a955dde9b50e933c");
  });
});

describe("W32-10 trigger read models", () => {
  it("decodes sorted current/pending market policy without losing u64s", () => {
    const encoder = new Encoder({ useBigInt64: true });
    const decoded = new Decoder({ useBigInt64: true }).decode(
      encoder.encode([
        [
          7,
          [
            [4n, true, 250, 5_000n, 1_000n, 32n],
            [
              [5n, true, 200, 4_000n, 900n, 64n],
              9_007_199_254_740_992n,
              9_007_199_254_740_993n,
            ],
          ],
        ],
      ]),
    );
    expect(decodeTriggerMarketConfigInfos(decoded)).toEqual([
      {
        market: 7,
        state: {
          current: {
            version: 4n,
            enabled: true,
            maxTriggerSlippageBps: 250,
            maxMarkAgeMs: 5_000n,
            maxFuturePublishSkewMs: 1_000n,
            maxActiveBrackets: 32n,
          },
          pending: {
            config: {
              version: 5n,
              enabled: true,
              maxTriggerSlippageBps: 200,
              maxMarkAgeMs: 4_000n,
              maxFuturePublishSkewMs: 900n,
              maxActiveBrackets: 64n,
            },
            acceptedHeight: 9_007_199_254_740_992n,
            effectiveHeight: 9_007_199_254_740_993n,
          },
        },
      },
    ]);
  });

  it("fails closed on empty, unsorted, or version-skipping market policy", () => {
    expect(() => decodeTriggerMarketConfigInfos([[7, [null, null]]])).toThrow(
      /empty trigger market config state/,
    );
    expect(() =>
      decodeTriggerMarketConfigInfos([
        [7, [[1n, false, 0, 0n, 0n, 0n], null]],
        [7, [[1n, false, 0, 0n, 0n, 0n], null]],
      ]),
    ).toThrow(/strictly market-sorted/);
    expect(() =>
      decodeTriggerMarketConfigInfos([
        [
          7,
          [
            [1n, false, 0, 0n, 0n, 0n],
            [[3n, true, 1, 1n, 1n, 1n], 10n, 11n],
          ],
        ],
      ]),
    ).toThrow(/version is not next/);
  });

  it("decodes the engine's positional owner view with exact bigint ids", () => {
    const encoder = new Encoder({ useBigInt64: true });
    const raw = encoder.encode([
      [
        [
          9_007_199_254_740_993n,
          Array(20).fill(0xa5),
          7,
          3n,
          "Buy",
          100n,
          101n,
          9n,
          [11n, "StopLoss", 95_000n, 75, 11n, "Armed", null],
          null,
        ],
        [4n, true, 250, 5_000n, 1_000n, 32n],
        { Deferred: "MarkStale" },
      ],
    ]);
    // Decode once through msgpack to reproduce the client's number/bigint mix.
    const decoded = new Decoder({ useBigInt64: true }).decode(raw);
    const rows = decodePositionTriggerInfos(decoded);
    expect(rows[0].bracket.groupId).toBe(9_007_199_254_740_993n);
    expect(rows[0].bracket.stopLoss?.clientTriggerId).toBe(11n);
    expect(rows[0].availability).toEqual({
      kind: "Deferred",
      reason: "MarkStale",
    });
  });

  it("parses JSON heights above 2^53 losslessly and fails closed", () => {
    expect(
      decodeTriggerStatusJson(
        '{"finalized_height":9007199254740993,"admission_height":9007199254740994,"actions_active":true}',
      ),
    ).toEqual({
      finalizedHeight: 9_007_199_254_740_993n,
      admissionHeight: 9_007_199_254_740_994n,
      actionsActive: true,
    });
    expect(() => decodeTriggerStatusJson('{"actions_active":false}')).toThrow(
      /finalized_height/,
    );
    expect(() =>
      decodeTriggerStatusJson(
        '{"finalized_height":10,"admission_height":12,"actions_active":false}',
      ),
    ).toThrow(/next height/);
  });

  it("rejects relational corruption in a trigger read row", () => {
    const corrupt = [
      [
        1n,
        Array(20).fill(0xa5),
        7,
        3n,
        "Buy",
        100n,
        101n,
        null,
        [11n, "StopLoss", 95_000n, 75, null, "Armed", null],
        [11n, "TakeProfit", 110_000n, 50, null, "Armed", null],
      ],
      null,
      "Available",
    ];
    expect(() => decodePositionTriggerInfos([corrupt])).toThrow(
      /duplicate limb identity/,
    );
  });
});

describe("F2 pre-fill order trigger validation", () => {
  const limb = (over: Partial<{ triggerPrice: bigint; maxSlippageBps: number; clientTriggerId: bigint }> = {}) => ({
    triggerPrice: 95_000n,
    maxSlippageBps: 75,
    clientTriggerId: 11n,
    ...over,
  });

  it("passes with no limbs on any order action — no bracket requested", () => {
    expect(validateOrderTriggers({})).toBeUndefined();
    expect(validateOrderTriggers({ stopLoss: null, takeProfit: null })).toBeUndefined();
    // Reduce-only without limbs is an ordinary reduce-only order.
    expect(validateOrderTriggers({ reduceOnly: true })).toBeUndefined();
  });

  it("passes with one or two well-formed limbs", () => {
    expect(validateOrderTriggers({ stopLoss: limb(), takeProfit: null })).toBeUndefined();
    expect(
      validateOrderTriggers({
        stopLoss: limb(),
        takeProfit: limb({ triggerPrice: 110_000n, clientTriggerId: 12n }),
      }),
    ).toBeUndefined();
  });

  it("rejects a zero or negative trigger price by field name", () => {
    expect(() => validateOrderTriggers({ stopLoss: limb({ triggerPrice: 0n }) })).toThrow(
      /stopLoss\.triggerPrice must be non-zero/,
    );
    expect(() =>
      validateOrderTriggers({ takeProfit: limb({ triggerPrice: -1n }) }),
    ).toThrow(/takeProfit\.triggerPrice must be an unsigned 64-bit bigint/);
  });

  it("keeps the bps collar in 1..=9999", () => {
    expect(() => validateOrderTriggers({ stopLoss: limb({ maxSlippageBps: 0 }) })).toThrow(
      /stopLoss\.maxSlippageBps must be in 1..=9999/,
    );
    expect(() =>
      validateOrderTriggers({ stopLoss: limb({ maxSlippageBps: 10_000 }) }),
    ).toThrow(/stopLoss\.maxSlippageBps must be in 1..=9999/);
    expect(validateOrderTriggers({ stopLoss: limb({ maxSlippageBps: 9_999 }) })).toBeUndefined();
  });

  it("rejects duplicate limb client ids — limbs must stay distinguishable", () => {
    expect(() =>
      validateOrderTriggers({
        stopLoss: limb({ clientTriggerId: 7n }),
        takeProfit: limb({ clientTriggerId: 7n }),
      }),
    ).toThrow(/must differ/);
  });

  it("rejects a zero client trigger id on either limb", () => {
    expect(() => validateOrderTriggers({ stopLoss: limb({ clientTriggerId: 0n }) })).toThrow(
      /stopLoss\.clientTriggerId must be non-zero/,
    );
    expect(() => validateOrderTriggers({ takeProfit: limb({ clientTriggerId: 0n }) })).toThrow(
      /takeProfit\.clientTriggerId must be non-zero/,
    );
  });

  it("rejects trigger fields on a reduce-only order (TriggerOrderIncompatible, code 98)", () => {
    expect(() => validateOrderTriggers({ stopLoss: limb(), reduceOnly: true })).toThrow(
      /reduceOnly order \(TriggerOrderIncompatible, code 98\)/,
    );
    expect(() =>
      validateOrderTriggers({ takeProfit: limb(), reduceOnly: true }),
    ).toThrow(/reduceOnly/);
  });
});

describe("F2 pre-fill trigger wire contract (proof-wire 2.1.0)", () => {
  // Frozen vectors from Proof-labs/exchange exchange-wire/vectors/
  // (draft PR #655, rev 592735c6): full signed envelopes, test key 0x42×32,
  // UNBOUND_CHAIN_ID. The same bytes are pinned in conformance/signing.ndjson.
  const WITH_TRIGGERS_ENVELOPE =
    "96020101c4369b01dc00140101010101010101010101010101010101010101a3427579640ac0c2c2a347746393ce000173184b0b93ce0001adb0320cc4202152f8d19b791d24453242e15f2eab6cb7cffa7b6a5ed30097960e069881db12c440dc991c8b31063e6cd1d26cd61e3dcf91f6af2e1d9092db51ca49808316e7b3640c3f9622cb55036adbb39424508f56e1e5acdb59aa56088d2ecea3d309307e05";
  const NO_TRIGGERS_ENVELOPE =
    "96020102c4269901dc00140101010101010101010101010101010101010101a3427579640ac0c2c2a3477463c4202152f8d19b791d24453242e15f2eab6cb7cffa7b6a5ed30097960e069881db12c44063588d198e83ae1e4862432b1cf58d23fc95c6638db6e0b0c2d76b2248552a67d4200214b0299aff617aab73b91183e43def96d0e23b3d83be22a75722460b0d";
  const NO_TRIGGERS_CANONICAL_PAYLOAD =
    "9b01dc00140101010101010101010101010101010101010101a3427579640ac0c2c2a3477463c0c0";

  const hexToBytes = (hex: string): Uint8Array => {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i += 1) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  };

  it("decodes the frozen with-triggers envelope to typed limbs and re-encodes byte-exactly", () => {
    const WITH_TRIGGERS_PAYLOAD =
      "9b01dc00140101010101010101010101010101010101010101a3427579640ac0c2c2a347746393ce000173184b0b93ce0001adb0320c";
    const decoded = decodeTx(hexToBytes(WITH_TRIGGERS_ENVELOPE));
    expect(decoded.action.type).toBe("PlaceOrder");
    const data = decoded.action.data as Record<string, unknown>;
    // decode → typed: limbs come back as TriggerLimb values, u64s as bigint.
    expect(data.stopLoss).toEqual({
      triggerPrice: 95_000n,
      maxSlippageBps: 75,
      clientTriggerId: 11n,
    });
    expect(data.takeProfit).toEqual({
      triggerPrice: 110_000n,
      maxSlippageBps: 50,
      clientTriggerId: 12n,
    });
    // typed → re-encode: byte-identical payload through the SDK codec (the
    // full signed envelope itself is pinned byte-exactly in
    // conformance/signing.ndjson as place_order/with_triggers@seq1/unbound).
    expect(bytesToHex(encodePayloadBytes(decoded.action))).toBe(
      WITH_TRIGGERS_PAYLOAD,
    );
  });

  it("keeps pre-2.1.0 order bytes decoding with absent limbs, re-encoding canonically", () => {
    // The frozen pre-2.1.0 envelope carries a 9-field payload (no trailing
    // nils) — non-canonical by design now, but it must keep decoding.
    const decoded = decodeTx(hexToBytes(NO_TRIGGERS_ENVELOPE));
    expect(decoded.action.type).toBe("PlaceOrder");
    const data = decoded.action.data as Record<string, unknown>;
    expect(data.stopLoss ?? null).toBeNull();
    expect(data.takeProfit ?? null).toBeNull();
    // Re-encode is the canonical 2.1.0 form: 11 fields with two trailing
    // nils — byte-exactly the checked-in no_triggers_canonical codec vector.
    expect(bytesToHex(encodePayloadBytes(decoded.action))).toBe(
      NO_TRIGGERS_CANONICAL_PAYLOAD,
    );
  });
});
