/** Byte fixtures captured from the incumbent SDK before migration. */
import { beforeAll, describe, expect, it } from "vitest";
import {
  ActionType,
  type Action,
  Side,
  chainIdFromString,
  encodeSignedTx,
  bytesToHex,
  ready,
  signingMessage,
} from "./index.js";

const SEQ = 1_754_000_000_000n;
const PUBKEY = new Uint8Array(32).fill(7);
const SIGNATURE = new Uint8Array(64).fill(9);
const OWNER = new Uint8Array(20).fill(3);

/**
 * Representative actions across the shapes the app signs: a resting limit
 * order, a cancel, and a multi-leg atomic basket (the most structurally
 * complex payload the app builds).
 */
const CASES: { name: string; action: Action }[] = [
  {
    name: "AmendOrder",
    action: {
      type: "AmendOrder",
      data: { owner: OWNER, orderId: 918273645n, newQuantity: 500n },
    },
  },
  {
    name: "CancelReplaceOrder (GTC)",
    action: {
      type: "CancelReplaceOrder",
      data: {
        owner: OWNER,
        cancelOrderId: 918273645n,
        market: 3,
        side: Side.Buy,
        price: 78451952n,
        quantity: 400n,
        clientOrderId: 42n,
        postOnly: true,
        reduceOnly: false,
      },
    },
  },
  {
    name: "CancelReplaceOrder (IOC)",
    action: {
      type: "CancelReplaceOrder",
      data: {
        owner: OWNER,
        cancelOrderId: 918273645n,
        market: 3,
        side: Side.Sell,
        price: 78451952n,
        quantity: 400n,
        clientOrderId: null,
        postOnly: false,
        reduceOnly: true,
        timeInForce: 1,
      },
    },
  },
  {
    name: "SetPositionTriggers (both limbs)",
    action: {
      type: "SetPositionTriggers",
      data: {
        market: 3,
        owner: OWNER,
        expectedPositionEpoch: 9n,
        stopLoss: {
          triggerPrice: 10_000_000n,
          maxSlippageBps: 150,
          clientTriggerId: 42n,
        },
        takeProfit: { triggerPrice: 20_000_000n, maxSlippageBps: 200 },
        clientGroupId: 17n,
      },
    },
  },
  {
    name: "CancelPositionTriggers",
    action: {
      type: "CancelPositionTriggers",
      data: {
        market: 3,
        owner: OWNER,
        expectedPositionEpoch: 9n,
      },
    },
  },
  {
    name: "PlaceOrder (limit, GTC)",
    action: {
      type: "PlaceOrder",
      data: {
        market: 3,
        owner: OWNER,
        side: Side.Buy,
        price: 78_451_952n,
        quantity: 400n,
        postOnly: false,
        reduceOnly: false,
        timeInForce: 0,
      },
    },
  },
  {
    name: "PlaceOrder (reduce-only IOC)",
    action: {
      type: "PlaceOrder",
      data: {
        market: 7,
        owner: OWNER,
        side: Side.Sell,
        price: 1_250_000n,
        quantity: 25n,
        postOnly: false,
        reduceOnly: true,
        timeInForce: 1,
      },
    },
  },
  {
    name: "CancelOrder",
    action: {
      type: "CancelOrder",
      data: { owner: OWNER, orderId: 918_273_645n },
    },
  },
  {
    // The most structurally complex payload the app signs: a nested,
    // variable-length leg list with optional fields. If any encoder difference
    // exists at all, this is where it surfaces.
    name: "AtomicBasketOrder (multi-leg, mixed optionals)",
    action: {
      type: "AtomicBasketOrder",
      data: {
        owner: OWNER,
        legs: [
          {
            market: 3,
            side: Side.Buy,
            price: 78_451_952n,
            quantity: 400n,
            clientOrderId: 42n,
            reduceOnly: false,
          },
          {
            market: 7300,
            side: Side.Sell,
            price: 590_000n,
            quantity: 1_373n,
            reduceOnly: true,
          },
        ],
        maxSlippageBps: 150,
      },
    },
  },
  {
    name: "AtomicBasketOrder (single leg, omitted optionals)",
    action: {
      type: "AtomicBasketOrder",
      data: {
        owner: OWNER,
        legs: [{ market: 1, side: Side.Buy, price: 1n, quantity: 1n }],
      },
    },
  },
  {
    name: "Withdraw",
    action: {
      type: "Withdraw",
      data: { owner: OWNER, amount: 1_500_000n, signer: OWNER },
    },
  },
  {
    name: "WithdrawRequest",
    action: {
      type: "WithdrawRequest",
      data: {
        owner: OWNER,
        amount: 42_000_000n,
        solanaDestination: new Uint8Array(32).fill(5),
      },
    },
  },
  {
    name: "ApproveAgent",
    action: {
      type: "ApproveAgent",
      data: { owner: OWNER, agentPubkey: new Uint8Array(32).fill(8) },
    },
  },
  {
    name: "RevokeAgent",
    action: {
      type: "RevokeAgent",
      data: { owner: OWNER, agentPubkey: new Uint8Array(32).fill(8) },
    },
  },
  {
    name: "MarketOrder",
    action: {
      type: "MarketOrder",
      data: {
        market: 3,
        owner: OWNER,
        side: Side.Buy,
        quantity: 120n,
      },
    },
  },
];

// Captured from incumbent @exchange/sdk 0.4.0 (ten original actions) and @proof/trading-sdk 3.0.0 (position triggers and edit actions), extracted from base 6dde028684845a7f389761c55989dcd0a03371ed; never regenerate from the replacement SDK.
// Factored literal envelopes; every reconstruction checked against all 105 archived bytes.
const NONCES = [
  ["0", "00"],
  ["1", "01"],
  ["127", "7f"],
  ["128", "cc80"],
  ["65535", "cdffff"],
  ["1754000000000", "cf00000198628c0400"],
  ["9223372036854775807", "cf7fffffffffffffff"],
] as const;
// Payloads are the 2.1.0 canonical forms: the F2 trigger expansion appended
// optional stop_loss/take_profit to the three order actions, so canonical
// encodes carry two trailing nils (fixarray +2 fields) even when no bracket
// is attached. Pre-2.1.0 byte strings keep DECODING — that compat direction
// is pinned by conformance/signing.ndjson (`place_order_no_triggers@seq2`)
// and the decode-compat test in triggers.test.ts.
const PAYLOADS: Record<string, readonly [string, string]> = {
  "PlaceOrder (limit, GTC)": [
    "01",
    "c42e9b03dc00140303030303030303030303030303030303030303a3427579ce04ad14f0cd0190c0c2c2a3477463c0c0",
  ],
  "PlaceOrder (reduce-only IOC)": [
    "01",
    "c42d9b07dc00140303030303030303030303030303030303030303a453656c6cce001312d019c0c2c3a3496f63c0c0",
  ],
  CancelOrder: [
    "02",
    "c41d92ce36bbbe6ddc00140303030303030303030303030303030303030303",
  ],
  "AtomicBasketOrder (multi-leg, mixed optionals)": [
    "1c",
    "c43e93dc00140303030303030303030303030303030303030303929603a3427579ce04ad14f0cd01902ac296cd1c84a453656c6cce000900b0cd055dc0c3cc96",
  ],
  "AtomicBasketOrder (single leg, omitted optionals)": [
    "1c",
    "c42493dc00140303030303030303030303030303030303030303919601a34275790101c0c200",
  ],
  Withdraw: [
    "06",
    "c43493dc00140303030303030303030303030303030303030303ce0016e360dc00140303030303030303030303030303030303030303",
  ],
  WithdrawRequest: [
    "08",
    "c44093dc00140303030303030303030303030303030303030303ce0280de80dc00200505050505050505050505050505050505050505050505050505050505050505",
  ],
  ApproveAgent: [
    "0c",
    "c43b92dc00140303030303030303030303030303030303030303dc00200808080808080808080808080808080808080808080808080808080808080808",
  ],
  RevokeAgent: [
    "0d",
    "c43b92dc00140303030303030303030303030303030303030303dc00200808080808080808080808080808080808080808080808080808080808080808",
  ],
  MarketOrder: [
    "04",
    "c4219703dc00140303030303030303030303030303030303030303a342757978c0c0c0",
  ],
  "SetPositionTriggers (both limbs)": [
    "25",
    "c42d9603dc001403030303030303030303030303030303030303030993ce00989680cc962a93ce01312d00ccc8c011",
  ],
  CancelPositionTriggers: [
    "26",
    "c41a9303dc0014030303030303030303030303030303030303030309",
  ],
  AmendOrder: [
    "1b",
    "c42194dc00140303030303030303030303030303030303030303ce36bbbe6dc0cd01f4",
  ],
  "CancelReplaceOrder (GTC)": [
    "1a",
    "c4349ddc00140303030303030303030303030303030303030303ce36bbbe6dc003a3427579ce04ad14f0cd01902ac3c2a3477463c0c0",
  ],
  "CancelReplaceOrder (IOC)": [
    "1a",
    "c4359ddc00140303030303030303030303030303030303030303ce36bbbe6dc003a453656c6cce04ad14f0cd0190c0c2c3a3496f63c0c0",
  ],
};
const CHAIN_HEX =
  "876ca857ab380e8f03c22f73aeaaacb22370751a81baa82fce762710f9936fd9";
const SIGNING_MESSAGES = [
  {
    type: 1,
    hex: "50726f6f6645786368616e67652d7633876ca857ab380e8f03c22f73aeaaacb22370751a81baa82fce762710f9936fd90100000198628c04000102030405",
  },
  {
    type: 37,
    hex: "50726f6f6645786368616e67652d7633876ca857ab380e8f03c22f73aeaaacb22370751a81baa82fce762710f9936fd92500000198628c04000102030405",
  },
  {
    type: 38,
    hex: "50726f6f6645786368616e67652d7633876ca857ab380e8f03c22f73aeaaacb22370751a81baa82fce762710f9936fd92600000198628c04000102030405",
  },
];
const ACTION_IDS = {
  PlaceOrder: 1,
  CancelOrder: 2,
  MarketOrder: 4,
  AtomicBasketOrder: 28,
  AmendOrder: 27,
  CancelReplaceOrder: 26,
};

describe("incumbent codec compatibility", () => {
  beforeAll(async () => {
    await ready();
  });
  for (const { name, action } of CASES) {
    it(`preserves ${name} bytes across nonce widths`, () => {
      const [tag, payload] = PAYLOADS[name];
      for (const [seq, encodedNonce] of NONCES) {
        const expected =
          "9602" +
          tag +
          encodedNonce +
          payload +
          "c420" +
          "07".repeat(32) +
          "c440" +
          "09".repeat(64);
        expect(
          bytesToHex(encodeSignedTx(action, BigInt(seq), PUBKEY, SIGNATURE)),
        ).toBe(expected);
      }
    });
  }
  it("preserves chain binding and signing domain", () => {
    const chainId = chainIdFromString("exchange-devnet-1");
    expect(bytesToHex(chainId)).toBe(CHAIN_HEX);
    for (const { type, hex } of SIGNING_MESSAGES)
      expect(
        bytesToHex(
          signingMessage(chainId, type, SEQ, new Uint8Array([1, 2, 3, 4, 5])),
        ),
      ).toBe(hex);
  });
  it("preserves action IDs including position protection", () => {
    for (const [key, value] of Object.entries(ACTION_IDS))
      expect((ActionType as Record<string, number>)[key]).toBe(value);
    expect(ActionType.SetPositionTriggers).toBe(37);
    expect(ActionType.CancelPositionTriggers).toBe(38);
  });
});
