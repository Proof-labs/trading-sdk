/** Byte fixtures captured from the incumbent SDK before migration. */
import { beforeAll, describe, expect, it } from "vitest";
import {
  ActionType,
  Side,
  chainIdFromString,
  encodeSignedTx,
  ready,
  signingMessage,
} from "./index.js";
import legacy from "./fixtures/web-legacy-codec-vectors.json";

const SEQ = 1_754_000_000_000n;
const PUBKEY = new Uint8Array(32).fill(7);
const SIGNATURE = new Uint8Array(64).fill(9);
const OWNER = new Uint8Array(20).fill(3);

/**
 * Representative actions across the shapes the app signs: a resting limit
 * order, a cancel, and a multi-leg atomic basket (the most structurally
 * complex payload the app builds).
 */
const CASES: { name: string; action: unknown }[] = [
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
      data: { market: 3, owner: OWNER, orderId: 918_273_645n },
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
        reduceOnly: true,
      },
    },
  },
];

describe("public SDK byte parity with incumbent fixtures", () => {
  beforeAll(async () => {
    await ready();
  });
  for (const { name, action } of CASES) {
    it(`preserves ${name} bytes across nonce widths`, () => {
      const fixture = legacy.vectors.find((v) => v.name === name)!;
      for (const { seq, hex } of fixture.encodings) {
        expect(
          Buffer.from(
            encodeSignedTx(action as never, BigInt(seq), PUBKEY, SIGNATURE),
          ).toString("hex"),
        ).toBe(hex);
      }
    });
  }
  it("preserves the chain binding and signing domain", () => {
    const chainId = chainIdFromString("exchange-devnet-1");
    expect(Buffer.from(chainId).toString("hex")).toBe(legacy.chainId);
    for (const { type, hex } of legacy.signingMessages) {
      expect(
        Buffer.from(
          signingMessage(chainId, type, SEQ, new Uint8Array([1, 2, 3, 4, 5])),
        ).toString("hex"),
      ).toBe(hex);
    }
  });
  it("preserves action IDs including position protection", () => {
    for (const [key, value] of Object.entries(legacy.actionTypes)) {
      expect((ActionType as Record<string, number>)[key]).toBe(value);
    }
    expect(ActionType.SetPositionTriggers).toBe(37);
    expect(ActionType.CancelPositionTriggers).toBe(38);
  });
});
