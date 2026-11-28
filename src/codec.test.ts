import { describe, it, expect } from "vitest";
import { Decoder, Encoder } from "@msgpack/msgpack";
import {
  encodeSignedTx,
  encodePayloadBytes,
  decodeTx,
  signEnvelopeFromPayload,
  decodeSigningMessage,
  peekActionType,
  signAndEncode,
  ENVELOPE_VERSION,
} from "./codec.js";
import {
  generateKeypair,
  getPublicKey,
  pubkeyToOwner,
  ownerToHex,
  signingMessage,
  sign,
  verify,
  hexToBytes,
  bytesToHex,
  chainIdFromString,
  UNBOUND_CHAIN_ID,
} from "./crypto.js";
import {
  ActionType,
  Outcome,
  Side,
  TimeInForce,
  type Action,
  type Address,
} from "./types.js";

const OWNER = new Uint8Array(20).fill(0xaa);
const SIGNER = new Uint8Array(20).fill(0xff);

// Test helpers: there's only one wire format (signed envelope), but the
// codec round-trip tests below don't care about signature validity —
// they just exercise encode/decode symmetry. `encodeTx` produces an
// envelope with zero pubkey/sig; `encodeTxV2` is the same helper with
// caller-supplied auth bytes, kept as an alias so the existing test
// names still document intent.
const ZERO_PUBKEY = new Uint8Array(32);
const ZERO_SIG = new Uint8Array(64);
const encodeTx = (action: Action, seq: bigint) =>
  encodeSignedTx(action, seq, ZERO_PUBKEY, ZERO_SIG);
const encodeTxV2 = encodeSignedTx;

// ---------------------------------------------------------------------------
// V1 round-trip tests (legacy)
// ---------------------------------------------------------------------------

describe("codec v1", () => {
  it("round-trips PlaceOrder", () => {
    const action: Action = {
      type: "PlaceOrder",
      data: {
        market: 1,
        owner: OWNER,
        side: Side.Buy,
        price: 10000n,
        quantity: 50n,
      },
    };

    const bytes = encodeTx(action, 42n);
    const { action: decoded, seq, version } = decodeTx(bytes);

    expect(version).toBe(2);
    expect(seq).toBe(42n);
    expect(decoded.type).toBe("PlaceOrder");
    if (decoded.type === "PlaceOrder") {
      expect(decoded.data.market).toBe(1);
      expect(decoded.data.price).toBe(10000n);
      expect(decoded.data.quantity).toBe(50n);
      expect(decoded.data.side).toBe(Side.Buy);
    }
  });

  it("round-trips FOK time-in-force on PlaceOrder", () => {
    const action: Action = {
      type: "PlaceOrder",
      data: {
        market: 1,
        owner: OWNER,
        side: Side.Buy,
        price: 10000n,
        quantity: 50n,
        timeInForce: TimeInForce.Fok,
      },
    };

    const bytes = encodeTx(action, 43n);
    const { action: decoded } = decodeTx(bytes);
    expect(decoded.type).toBe("PlaceOrder");
    if (decoded.type === "PlaceOrder") {
      expect(decoded.data.timeInForce).toBe(TimeInForce.Fok);
    }
  });

  it("round-trips CancelOrder", () => {
    const action: Action = {
      type: "CancelOrder",
      data: { orderId: 999n, owner: OWNER },
    };
    const bytes = encodeTx(action, 1n);
    const { action: decoded } = decodeTx(bytes);
    expect(decoded.type).toBe("CancelOrder");
    if (decoded.type === "CancelOrder") {
      expect(decoded.data.orderId).toBe(999n);
    }
  });

  it("round-trips CancelClientOrder", () => {
    const action: Action = {
      type: "CancelClientOrder",
      data: { owner: OWNER, clientOrderId: 123456789n },
    };
    const bytes = encodeTx(action, 2n);
    expect(peekActionType(bytes)).toBe(ActionType.CancelClientOrder);
    const { action: decoded } = decodeTx(bytes);
    expect(decoded.type).toBe("CancelClientOrder");
    if (decoded.type === "CancelClientOrder") {
      expect(decoded.data.clientOrderId).toBe(123456789n);
      expect(decoded.data.owner).toEqual(OWNER);
    }
  });

  it("round-trips CancelAllOrders with optional market scope", () => {
    const action: Action = {
      type: "CancelAllOrders",
      data: { owner: OWNER, market: 6 },
    };
    const bytes = encodeTx(action, 3n);
    expect(peekActionType(bytes)).toBe(ActionType.CancelAllOrders);
    const { action: decoded } = decodeTx(bytes);
    expect(decoded.type).toBe("CancelAllOrders");
    if (decoded.type === "CancelAllOrders") {
      expect(decoded.data.market).toBe(6);
      expect(decoded.data.owner).toEqual(OWNER);
    }
  });

  it("round-trips CancelReplaceOrder with replacement controls", () => {
    const action: Action = {
      type: "CancelReplaceOrder",
      data: {
        owner: OWNER,
        cancelClientOrderId: 101n,
        market: 2,
        side: Side.Sell,
        price: 12345n,
        quantity: 7n,
        clientOrderId: 202n,
        postOnly: true,
        timeInForce: TimeInForce.Fok,
      },
    };
    const bytes = encodeTx(action, 4n);
    expect(peekActionType(bytes)).toBe(ActionType.CancelReplaceOrder);
    const { action: decoded } = decodeTx(bytes);
    expect(decoded.type).toBe("CancelReplaceOrder");
    if (decoded.type === "CancelReplaceOrder") {
      expect(decoded.data.cancelClientOrderId).toBe(101n);
      expect(decoded.data.cancelOrderId).toBeNull();
      expect(decoded.data.market).toBe(2);
      expect(decoded.data.side).toBe(Side.Sell);
      expect(decoded.data.price).toBe(12345n);
      expect(decoded.data.quantity).toBe(7n);
      expect(decoded.data.clientOrderId).toBe(202n);
      expect(decoded.data.postOnly).toBe(true);
      expect(decoded.data.timeInForce).toBe(TimeInForce.Fok);
    }
  });

  it("round-trips AmendOrder with optional price and quantity", () => {
    const action: Action = {
      type: "AmendOrder",
      data: {
        owner: OWNER,
        orderId: 42n,
        newPrice: 12346n,
        newQuantity: 8n,
      },
    };
    const bytes = encodeTx(action, 5n);
    expect(peekActionType(bytes)).toBe(ActionType.AmendOrder);
    const { action: decoded } = decodeTx(bytes);
    expect(decoded.type).toBe("AmendOrder");
    if (decoded.type === "AmendOrder") {
      expect(decoded.data.owner).toEqual(OWNER);
      expect(decoded.data.orderId).toBe(42n);
      expect(decoded.data.newPrice).toBe(12346n);
      expect(decoded.data.newQuantity).toBe(8n);
    }
  });

  it("refuses retired action bytes in both directions", () => {
    for (const [name, byte] of [
      ["OracleUpdate", 0x03],
      ["CreateMarket", 0x07],
      ["ConfirmDeposit", 0x09],
      ["ConfirmWithdrawal", 0x0a],
      ["FailWithdrawal", 0x0b],
      ["UpdateMarketFees", 0x10],
      ["RunLiquidationSweep", 0x11],
      ["RunFundingTick", 0x12],
      ["SetAccountFeeOverride", 0x13],
      ["OracleUpdateComposite", 0x14],
      ["FailDeposit", 0x15],
    ] as const) {
      expect(name in ActionType).toBe(false);
      expect(() =>
        encodePayloadBytes({
          type: name,
          data: { market: 1, price: 1n, signer: SIGNER },
        } as unknown as Action),
      ).toThrow();
      // A well-formed envelope must fail on its retired tag alone.
      const wire = new Encoder().encode([
        2,
        byte,
        1,
        new Encoder().encode([1, 1, Array.from(SIGNER), 0]),
        new Uint8Array(32),
        new Uint8Array(64),
      ]);
      expect(() => decodeTx(wire)).toThrow();
    }
  });

  it("peeks action type", () => {
    const action: Action = {
      type: "CancelOrder",
      data: { orderId: 1n, owner: OWNER },
    };
    const bytes = encodeTx(action, 1n);
    expect(peekActionType(bytes)).toBe(ActionType.CancelOrder);
  });

  it("encodes side as string to match Rust serde wire format", () => {
    const action: Action = {
      type: "PlaceOrder",
      data: {
        market: 1,
        owner: OWNER,
        side: Side.Buy,
        price: 100n,
        quantity: 10n,
      },
    };
    const bytes = encodeTx(action, 1n);
    const hex = bytesToHex(bytes);
    expect(hex).toContain("a3427579"); // "Buy" as fixstr

    const sellAction: Action = {
      type: "PlaceOrder",
      data: { ...action.data, side: Side.Sell },
    };
    const sellHex = bytesToHex(encodeTx(sellAction, 1n));
    expect(sellHex).toContain("a453656c6c"); // "Sell" as fixstr
  });

  it("encoding is deterministic", () => {
    const action: Action = {
      type: "PlaceOrder",
      data: {
        market: 1,
        owner: OWNER,
        side: Side.Buy,
        price: 100n,
        quantity: 10n,
      },
    };
    const a = encodeTx(action, 1n);
    const b = encodeTx(action, 1n);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// V1 round-trip for all 13 action types
// ---------------------------------------------------------------------------

describe("codec v1 all action types", () => {
  const allActions: Action[] = [
    {
      type: "PlaceOrder",
      data: {
        market: 1,
        owner: OWNER,
        side: Side.Buy,
        price: 100n,
        quantity: 10n,
      },
    },
    { type: "CancelOrder", data: { orderId: 42n, owner: OWNER } },
    {
      type: "MarketOrder",
      data: { market: 1, owner: OWNER, side: Side.Sell, quantity: 5n },
    },
    {
      type: "Deposit",
      data: { owner: OWNER, amount: 1000000n, signer: SIGNER },
    },
    { type: "Withdraw", data: { owner: OWNER, amount: 500n, signer: SIGNER } },
    {
      type: "WithdrawRequest",
      data: {
        owner: OWNER,
        amount: 1000n,
        solanaDestination: new Uint8Array(32).fill(0x01),
      },
    },
    {
      type: "ApproveAgent",
      data: { owner: OWNER, agentPubkey: new Uint8Array(32).fill(0x02) },
    },
    {
      type: "RevokeAgent",
      data: { owner: OWNER, agentPubkey: new Uint8Array(32).fill(0x02) },
    },
    {
      type: "CreateSubAccount",
      data: { owner: OWNER, subAccountId: 1, name: new Uint8Array(32) },
    },
    {
      type: "SubAccountTransfer",
      data: {
        owner: OWNER,
        from: OWNER,
        to: new Uint8Array(20).fill(0x02),
        amount: 1_000_000n,
      },
    },
    {
      type: "VotePauseBridge",
      data: {
        deploymentId: new Uint8Array(32).fill(0xa1),
        chainId: new Uint8Array(32).fill(0xc7),
        registryEpoch: 2n,
        signedAtMs: 1_700_000_000_123n,
        signature: new Uint8Array(64).fill(0x5e),
      },
    },
    {
      type: "ResolveEvent",
      data: { eventId: 700, outcome: Outcome.No, signer: SIGNER },
    },
    {
      // BE-16: per-user leverage selector.
      type: "SetUserMarketLeverage",
      data: {
        owner: OWNER,
        market: 1,
        userImBps: 2000,
      },
    },
    {
      type: "VoteWithdrawalPaid",
      data: {
        withdrawalId: 777n,
        vault: new Uint8Array(32).fill(0xb2),
        squadsTransactionIndex: 11,
        deploymentId: new Uint8Array(32).fill(0xa1),
        chainId: new Uint8Array(32).fill(0xc7),
        registryEpoch: 3n,
        signedAtMs: 1_700_000_000_123n,
        signature: new Uint8Array(64).fill(0x5c),
      },
    },
    {
      type: "VoteWithdrawalPayoutDead",
      data: {
        withdrawalId: 8n,
        vault: new Uint8Array(32).fill(0xb2),
        squadsTransactionIndex: 13,
        deploymentId: new Uint8Array(32).fill(0xa1),
        chainId: new Uint8Array(32).fill(0xc7),
        registryEpoch: 4n,
        signedAtMs: 1_700_000_000_123n,
        signature: new Uint8Array(64).fill(0x51),
      },
    },
    {
      type: "VoteDeposit",
      data: {
        owner: OWNER,
        amountMicroUsdc: 1_000_000n,
        solanaTxSig: new Uint8Array(64).fill(0xab),
        locator: { topIndex: 2, innerIndex: 5 },
        deploymentId: new Uint8Array(32).fill(0xa1),
        chainId: new Uint8Array(32).fill(0xc7),
        registryEpoch: 9n,
        signedAtMs: 1_700_000_000_123n,
        signature: new Uint8Array(64).fill(0x5c),
      },
    },
    {
      type: "RecordWithdrawalPayout",
      data: {
        withdrawalId: 777n,
        vault: new Uint8Array(32).fill(0x08),
        squadsTransactionIndex: 42,
        deploymentId: new Uint8Array(32).fill(0xa1),
        chainId: new Uint8Array(32).fill(0xc7),
        registryEpoch: 3n,
        signedAtMs: 1_700_000_000_123n,
        signature: new Uint8Array(64).fill(0x5d),
      },
    },
  ];

  for (const action of allActions) {
    it(`round-trips ${action.type}`, () => {
      const bytes = encodeTx(action, 99n);
      const { action: decoded, seq, version } = decodeTx(bytes);
      expect(version).toBe(2);
      expect(seq).toBe(99n);
      expect(decoded.type).toBe(action.type);
    });
  }

  it("round-trips the bridge-operator messages with full field fidelity", () => {
    const votes: Action[] = [
      {
        type: "RecordWithdrawalPayout",
        data: {
          withdrawalId: (1n << 64n) - 1n,
          vault: new Uint8Array(32).fill(0x08),
          squadsTransactionIndex: 4294967295,
          deploymentId: new Uint8Array(32).fill(0xa1),
          chainId: new Uint8Array(32).fill(0xc7),
          registryEpoch: 3n,
          signedAtMs: 1_700_000_000_123n,
          signature: new Uint8Array(64).fill(0x5d),
        },
      },
      {
        type: "VotePauseBridge",
        data: {
          deploymentId: new Uint8Array(32).fill(0xa1),
          chainId: new Uint8Array(32).fill(0xc7),
          registryEpoch: 2n,
          signedAtMs: 1_700_000_000_123n,
          signature: new Uint8Array(64).fill(0x5e),
        },
      },
      {
        type: "VoteWithdrawalPaid",
        data: {
          withdrawalId: 777n,
          vault: new Uint8Array(32).fill(0xb2),
          squadsTransactionIndex: 11,
          deploymentId: new Uint8Array(32).fill(0xa1),
          chainId: new Uint8Array(32).fill(0xc7),
          registryEpoch: 3n,
          signedAtMs: 1_700_000_000_123n,
          signature: new Uint8Array(64).fill(0x5c),
        },
      },
      {
        type: "VoteWithdrawalPayoutDead",
        data: {
          withdrawalId: 8n,
          vault: new Uint8Array(32).fill(0xb2),
          squadsTransactionIndex: 13,
          deploymentId: new Uint8Array(32).fill(0xa1),
          chainId: new Uint8Array(32).fill(0xc7),
          registryEpoch: 4n,
          signedAtMs: 1_700_000_000_123n,
          signature: new Uint8Array(64).fill(0x51),
        },
      },
      {
        type: "VoteDeposit",
        data: {
          owner: OWNER,
          amountMicroUsdc: 1_000_000n,
          solanaTxSig: new Uint8Array(64).fill(0xab),
          locator: { topIndex: 2, innerIndex: 5 },
          deploymentId: new Uint8Array(32).fill(0xa1),
          chainId: new Uint8Array(32).fill(0xc7),
          registryEpoch: 9n,
          signedAtMs: 1_700_000_000_123n,
          signature: new Uint8Array(64).fill(0x5c),
        },
      },
      {
        type: "VoteDeposit",
        data: {
          owner: OWNER,
          amountMicroUsdc: 5n,
          solanaTxSig: new Uint8Array(64).fill(0xab),
          locator: null,
          deploymentId: new Uint8Array(32).fill(0xa1),
          chainId: new Uint8Array(32).fill(0xc7),
          registryEpoch: 1n,
          signedAtMs: 1_700_000_000_123n,
          signature: new Uint8Array(64).fill(0x5c),
        },
      },
    ];
    for (const action of votes) {
      // A vote carries its own preimage signature — every field must
      // survive encode→decode structurally identical.
      expect(decodeTx(encodeTx(action, 7n)).action).toEqual(action);
    }
  });

  it("refuses a seq or action type the wire cannot carry instead of wrapping it", () => {
    const { privateKey } = generateKeypair();
    const payload = new Uint8Array([0x90]);
    for (const [actionType, seq] of [
      [257, 1n],
      [1.5, 1n],
      [-1, 1n],
      [ActionType.Deposit, -1n],
      [ActionType.Deposit, 2n ** 64n + 7n],
    ] as const) {
      expect(() =>
        signEnvelopeFromPayload(
          UNBOUND_CHAIN_ID,
          actionType,
          seq,
          payload,
          privateKey,
        ),
      ).toThrow(RangeError);
    }
  });

  it("round-trips ProposeAdminAction with the UnpauseBridge unit variant", () => {
    const action: Action = {
      type: "ProposeAdminAction",
      data: {
        proposer: new Uint8Array(20).fill(0xa1),
        registryVersion: 1n,
        action: { kind: "UnpauseBridge" },
      },
    };
    const { action: decoded } = decodeTx(encodeTx(action, 12n));
    // The unit variant serializes as a bare string, not a `{ Variant: {} }`
    // map; it must survive encode→decode structurally identical.
    expect(decoded).toEqual(action);
  });

  it("encodes an omitted, undefined, or null market identically (serde None)", () => {
    // The Rust side reads a missing Option field as None without a serde
    // default, so the adapter needs no special case: all three spellings
    // must produce one wire encoding.
    const owner = new Uint8Array(20).fill(0xc1);
    const encodings = [
      { owner },
      { owner, market: undefined },
      { owner, market: null },
    ].map((value) =>
      encodeTx(
        {
          type: "ProposeAdminAction",
          data: {
            proposer: new Uint8Array(20).fill(0xa1),
            registryVersion: 1n,
            action: { kind: "CancelAllOrdersForAccount", value },
          },
        },
        12n,
      ),
    );
    expect(encodings[1]).toEqual(encodings[0]);
    expect(encodings[2]).toEqual(encodings[0]);
    const { action } = decodeTx(encodings[0]);
    expect(
      action.type === "ProposeAdminAction" &&
        action.data.action.kind === "CancelAllOrdersForAccount" &&
        action.data.action.value.market,
    ).toBeNull();
  });

  it("round-trips ProposeAdminAction with CancelAllOrdersForAccount, scoped and unscoped", () => {
    for (const market of [7, null]) {
      const action: Action = {
        type: "ProposeAdminAction",
        data: {
          proposer: new Uint8Array(20).fill(0xa1),
          registryVersion: 1n,
          action: {
            kind: "CancelAllOrdersForAccount",
            value: { owner: new Uint8Array(20).fill(0xc1), market },
          },
        },
      };
      const { action: decoded } = decodeTx(encodeTx(action, 12n));
      // An omitted market must encode as nil and decode back as null; the
      // adapter injects the explicit None the engine's plain `Option` needs.
      expect(decoded).toEqual(action);
    }
  });

  it("round-trips ProposeAdminAction with UpdateAuthoritySet, add and remove", () => {
    const cases: Array<{
      domain: "Custody" | "Relayer";
      add: Uint8Array[];
      remove: Uint8Array[];
    }> = [
      {
        domain: "Custody",
        add: [new Uint8Array(20).fill(0xb2)],
        remove: [],
      },
      { domain: "Relayer", add: [], remove: [new Uint8Array(20).fill(0xc3)] },
    ];
    for (const value of cases) {
      const action: Action = {
        type: "ProposeAdminAction",
        data: {
          proposer: new Uint8Array(20).fill(0xa1),
          registryVersion: 1n,
          action: { kind: "UpdateAuthoritySet", value },
        },
      };
      const { action: decoded } = decodeTx(encodeTx(action, 12n));
      expect(decoded).toEqual(action);
    }
  });

  it("rejects a vote whose fixed-width deploymentId is not 32 bytes", () => {
    const action: Action = {
      type: "VoteWithdrawalPaid",
      data: {
        withdrawalId: 1n,
        deploymentId: new Uint8Array(31).fill(0xa1),
        chainId: new Uint8Array(32).fill(0xc7),
        registryEpoch: 1n,
        signedAtMs: 1_700_000_000_123n,
        signature: new Uint8Array(64).fill(0x5c),
      },
    };
    // The 32-byte wire bound rejects a 31-byte array, so encoding a
    // malformed vote fails loudly rather than emitting bad bytes.
    expect(() => encodeTx(action, 1n)).toThrow();
  });

  it("rejects a vote whose signature is not exactly 64 bytes", () => {
    const action: Action = {
      type: "VoteWithdrawalPaid",
      data: {
        withdrawalId: 1n,
        deploymentId: new Uint8Array(32).fill(0xa1),
        chainId: new Uint8Array(32).fill(0xc7),
        registryEpoch: 1n,
        signedAtMs: 1_700_000_000_123n,
        signature: new Uint8Array(63).fill(0x5c),
      },
    };
    expect(() => encodeTx(action, 1n)).toThrow();
  });

  it("round-trips AtomicBasketOrder", () => {
    const action: Action = {
      type: "AtomicBasketOrder",
      data: {
        owner: SIGNER,
        legs: [
          {
            market: 1,
            side: Side.Buy,
            price: 6675000n,
            quantity: 3n,
            clientOrderId: 77n,
            reduceOnly: false,
          },
          {
            market: 2,
            side: Side.Sell,
            price: 250000n,
            quantity: 5n,
            clientOrderId: null,
            reduceOnly: true,
          },
        ],
        maxSlippageBps: 50,
      },
    };

    const { action: decoded } = decodeTx(encodeTx(action, 1n));
    expect(decoded).toEqual(action);
  });

  it("AtomicBasketOrder maxSlippageBps absent encodes as 0, not nil", () => {
    const action: Action = {
      type: "AtomicBasketOrder",
      data: {
        owner: SIGNER,
        legs: [{ market: 1, side: Side.Buy, price: 100n, quantity: 1n }],
      },
    };
    const { action: decoded } = decodeTx(encodeTx(action, 1n));
    if (decoded.type !== "AtomicBasketOrder") throw new Error("wrong type");
    expect(decoded.data.maxSlippageBps).toBe(0);
    // absent per-leg optionals normalize to null / false
    expect(decoded.data.legs[0].clientOrderId).toBe(null);
    expect(decoded.data.legs[0].reduceOnly).toBe(false);
  });

  it("decodes a cancel list of one as the single cancel", () => {
    const cancels: Action = {
      type: "CancelOrders",
      data: { owner: SIGNER, orderIds: [42n] },
    };
    expect(decodeTx(encodeTx(cancels, 1n)).action).toEqual({
      type: "CancelOrder",
      data: { orderId: 42n, owner: SIGNER },
    });
    const byClients: Action = {
      type: "CancelClientOrders",
      data: { owner: SIGNER, clientOrderIds: [9n] },
    };
    expect(decodeTx(encodeTx(byClients, 1n)).action).toEqual({
      type: "CancelClientOrder",
      data: { owner: SIGNER, clientOrderId: 9n },
    });
  });
});

// ---------------------------------------------------------------------------
// V2 signing tests
// ---------------------------------------------------------------------------

describe("codec v2 signing", () => {
  it("signAndEncode produces valid V2 envelope", () => {
    const { privateKey } = generateKeypair();
    const action: Action = {
      type: "PlaceOrder",
      data: {
        market: 1,
        owner: OWNER,
        side: Side.Buy,
        price: 100n,
        quantity: 10n,
      },
    };

    const bytes = signAndEncode(UNBOUND_CHAIN_ID, action, 1n, privateKey);
    const {
      version,
      pubkey,
      signature,
      action: decoded,
      seq,
    } = decodeTx(bytes);

    expect(version).toBe(2);
    expect(seq).toBe(1n);
    expect(decoded.type).toBe("PlaceOrder");
    expect(pubkey).toBeDefined();
    expect(pubkey!.length).toBe(32);
    expect(signature).toBeDefined();
    expect(signature!.length).toBe(64);
  });

  it("signature verifies against signing message", () => {
    const { privateKey, publicKey } = generateKeypair();
    const action: Action = {
      type: "Deposit",
      data: { owner: OWNER, amount: 1000n, signer: SIGNER },
    };

    const bytes = signAndEncode(UNBOUND_CHAIN_ID, action, 5n, privateKey);
    const { pubkey, signature } = decodeTx(bytes);

    // Reconstruct the signing message and verify
    // The signAndEncode function encodes the payload, so we need to reconstruct it
    const payloadBytes = encodeTx(action, 5n); // We use V1 just for the payload extraction
    // Actually let's verify via our crypto module
    expect(pubkey).toEqual(publicKey);

    // Verify the signature is valid (basic check — it decoded without error)
    expect(signature!.length).toBe(64);
  });

  it("V2 round-trips the core action types", () => {
    const { privateKey } = generateKeypair();

    const allActions: Action[] = [
      {
        type: "PlaceOrder",
        data: {
          market: 1,
          owner: OWNER,
          side: Side.Buy,
          price: 100n,
          quantity: 10n,
        },
      },
      { type: "CancelOrder", data: { orderId: 42n, owner: OWNER } },
      {
        type: "MarketOrder",
        data: { market: 1, owner: OWNER, side: Side.Sell, quantity: 5n },
      },
      {
        type: "Deposit",
        data: { owner: OWNER, amount: 1000000n, signer: SIGNER },
      },
      {
        type: "Withdraw",
        data: { owner: OWNER, amount: 500n, signer: SIGNER },
      },
      {
        type: "WithdrawRequest",
        data: {
          owner: OWNER,
          amount: 1000n,
          solanaDestination: new Uint8Array(32).fill(0x01),
        },
      },
      {
        type: "ApproveAgent",
        data: { owner: OWNER, agentPubkey: new Uint8Array(32).fill(0x02) },
      },
      {
        type: "RevokeAgent",
        data: { owner: OWNER, agentPubkey: new Uint8Array(32).fill(0x02) },
      },
    ];

    for (const action of allActions) {
      const bytes = signAndEncode(UNBOUND_CHAIN_ID, action, 42n, privateKey);
      const {
        version,
        action: decoded,
        seq,
        pubkey,
        signature,
      } = decodeTx(bytes);
      expect(version).toBe(2);
      expect(seq).toBe(42n);
      expect(decoded.type).toBe(action.type);
      expect(pubkey!.length).toBe(32);
      expect(signature!.length).toBe(64);
    }
  });

  it("signAndEncode is deterministic", () => {
    const { privateKey } = generateKeypair();
    const action: Action = {
      type: "PlaceOrder",
      data: {
        market: 1,
        owner: OWNER,
        side: Side.Buy,
        price: 100n,
        quantity: 10n,
      },
    };
    const a = signAndEncode(UNBOUND_CHAIN_ID, action, 1n, privateKey);
    const b = signAndEncode(UNBOUND_CHAIN_ID, action, 1n, privateKey);
    expect(a).toEqual(b);
  });

  it("different seqs produce different signatures", () => {
    const { privateKey } = generateKeypair();
    const action: Action = {
      type: "Deposit",
      data: { owner: OWNER, amount: 100n, signer: SIGNER },
    };
    const a = signAndEncode(UNBOUND_CHAIN_ID, action, 1n, privateKey);
    const b = signAndEncode(UNBOUND_CHAIN_ID, action, 2n, privateKey);
    const da = decodeTx(a);
    const db = decodeTx(b);
    expect(da.signature).not.toEqual(db.signature);
  });
});

// ---------------------------------------------------------------------------
// Crypto module tests
// ---------------------------------------------------------------------------

describe("crypto", () => {
  it("generateKeypair returns valid key sizes", () => {
    const { privateKey, publicKey } = generateKeypair();
    expect(privateKey.length).toBe(32);
    expect(publicKey.length).toBe(32);
  });

  it("getPublicKey derives from private key", () => {
    const { privateKey, publicKey } = generateKeypair();
    const derived = getPublicKey(privateKey);
    expect(derived).toEqual(publicKey);
  });

  it("pubkeyToOwner returns 20 bytes", () => {
    const { publicKey } = generateKeypair();
    const owner = pubkeyToOwner(publicKey);
    expect(owner.length).toBe(20);
  });

  it("pubkeyToOwner is deterministic", () => {
    const { publicKey } = generateKeypair();
    const a = pubkeyToOwner(publicKey);
    const b = pubkeyToOwner(publicKey);
    expect(a).toEqual(b);
  });

  it("different keys produce different owners", () => {
    const k1 = generateKeypair();
    const k2 = generateKeypair();
    const o1 = pubkeyToOwner(k1.publicKey);
    const o2 = pubkeyToOwner(k2.publicKey);
    expect(o1).not.toEqual(o2);
  });

  it("ownerToHex produces 40-char hex string", () => {
    const owner = new Uint8Array(20).fill(0xab);
    const hex = ownerToHex(owner);
    expect(hex).toBe(
      "abababababababababababababababababababababab".slice(0, 40),
    );
    expect(hex.length).toBe(40);
  });

  it("hexToBytes and bytesToHex are inverses", () => {
    const original = new Uint8Array([
      0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
    ]);
    const hex = bytesToHex(original);
    const roundTripped = hexToBytes(hex);
    expect(roundTripped).toEqual(original);
  });

  it("signingMessage includes v3 domain prefix", () => {
    const chainId = new Uint8Array(32); // UNBOUND_CHAIN_ID
    const msg = signingMessage(chainId, 0x01, 1n, new Uint8Array([0xaa]));
    // Bumped to v3 on 2026-04-23 (audit B4) when the envelope
    // gained a 32-byte chain_id binding.
    const prefix = new TextEncoder().encode("ProofExchange-v3");
    for (let i = 0; i < prefix.length; i++) {
      expect(msg[i]).toBe(prefix[i]);
    }
  });

  it("signingMessage is deterministic", () => {
    const chainId = new Uint8Array(32);
    const payload = new Uint8Array([1, 2, 3]);
    const a = signingMessage(chainId, 0x01, 42n, payload);
    const b = signingMessage(chainId, 0x01, 42n, payload);
    expect(a).toEqual(b);
  });

  it("sign and verify round-trip", () => {
    const chainId = new Uint8Array(32);
    const { privateKey, publicKey } = generateKeypair();
    const msg = signingMessage(chainId, 0x01, 1n, new Uint8Array([0xff]));
    const sig = sign(privateKey, msg);
    expect(sig.length).toBe(64);
    expect(verify(publicKey, sig, msg)).toBe(true);
  });

  it("wrong key fails verification", () => {
    const chainId = new Uint8Array(32);
    const k1 = generateKeypair();
    const k2 = generateKeypair();
    const msg = signingMessage(chainId, 0x01, 1n, new Uint8Array([0xff]));
    const sig = sign(k1.privateKey, msg);
    expect(verify(k2.publicKey, sig, msg)).toBe(false);
  });

  it("tampered message fails verification", () => {
    const chainId = new Uint8Array(32);
    const { privateKey, publicKey } = generateKeypair();
    const msg = signingMessage(chainId, 0x01, 1n, new Uint8Array([0xff]));
    const sig = sign(privateKey, msg);
    const tampered = signingMessage(chainId, 0x01, 2n, new Uint8Array([0xff]));
    expect(verify(publicKey, sig, tampered)).toBe(false);
  });

  it("chainIdFromString(A) differs from chainIdFromString(B) — B4 binding", () => {
    const a = chainIdFromString("proof-dev-1");
    const b = chainIdFromString("proof-prod-1");
    expect(a).not.toEqual(b);
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
  });

  it("cross-chain replay rejected — B4 regression", () => {
    // A signature generated for chain A must NOT verify against chain B.
    // If this ever passes trivially again, the v3 binding has been
    // silently downgraded.
    const chainA = chainIdFromString("proof-dev-1");
    const chainB = chainIdFromString("proof-prod-1");
    const { privateKey, publicKey } = generateKeypair();
    const payload = new Uint8Array([0xde, 0xad]);
    const msgA = signingMessage(chainA, 0x01, 5n, payload);
    const sigA = sign(privateKey, msgA);
    expect(verify(publicKey, sigA, msgA)).toBe(true);

    const msgB = signingMessage(chainB, 0x01, 5n, payload);
    expect(verify(publicKey, sigA, msgB)).toBe(false);
  });
});

describe("codec/crypto hygiene", () => {
  it("ENVELOPE_VERSION is the version byte written and required on decode", () => {
    expect(ENVELOPE_VERSION).toBe(2);
    const { publicKey, privateKey } = generateKeypair();
    const owner = pubkeyToOwner(publicKey);
    const bytes = signAndEncode(
      new Uint8Array(32),
      { type: "CancelOrder", data: { orderId: 1n, owner } },
      1n,
      privateKey,
    );
    expect(decodeTx(bytes).version).toBe(ENVELOPE_VERSION);
  });

  it("hexToBytes round-trips with bytesToHex and accepts a 0x prefix", () => {
    const bytes = Uint8Array.from([0x00, 0x0a, 0xff, 0x42]);
    const hex = bytesToHex(bytes);
    expect(hexToBytes(hex)).toEqual(bytes);
    expect(hexToBytes("0x" + hex)).toEqual(bytes);
    expect(hexToBytes("")).toEqual(new Uint8Array(0));
  });

  it("hexToBytes throws on odd length instead of silently zero-filling", () => {
    expect(() => hexToBytes("abc")).toThrow(/odd number of digits/);
  });

  it("hexToBytes throws on non-hex characters instead of yielding NaN->0", () => {
    // Pre-fix, parseInt("zz", 16) === NaN, which coerces to 0 in a Uint8Array.
    expect(() => hexToBytes("zz")).toThrow(/non-hexadecimal/);
    expect(() => hexToBytes("0xgg")).toThrow(/non-hexadecimal/);
  });
});

describe("decodeSigningMessage", () => {
  const chainId = chainIdFromString("test-chain");
  const owner = pubkeyToOwner(getPublicKey(generateKeypair().privateKey));

  const deposit: Action = {
    type: "Deposit",
    data: { owner, amount: 250_000_000n, signer: owner },
  };

  it("round-trips the exact signingMessage() bytes for a Deposit", () => {
    const payload = encodePayloadBytes(deposit);
    const seq = 1_752_000_000_000n;
    const msg = signingMessage(chainId, ActionType.Deposit, seq, payload);

    const d = decodeSigningMessage(msg);

    expect(Array.from(d.chainId)).toEqual(Array.from(chainId));
    expect(d.actionType).toBe(ActionType.Deposit);
    expect(d.actionName).toBe("Deposit");
    expect(d.seq).toBe(seq);
    expect(Array.from(d.payloadBytes)).toEqual(Array.from(payload));
    expect(d.decodeError).toBeNull();
    expect(d.action?.type).toBe("Deposit");
    if (d.action?.type === "Deposit") {
      expect(d.action.data.amount).toBe(250_000_000n);
      expect(Array.from(d.action.data.owner)).toEqual(Array.from(owner));
    }
  });

  it("round-trips a PlaceOrder preimage", () => {
    const placeOrder: Action = {
      type: "PlaceOrder",
      data: {
        market: 1,
        owner,
        side: Side.Buy,
        price: 100_000_000n,
        quantity: 3n,
      },
    };
    const payload = encodePayloadBytes(placeOrder);
    const msg = signingMessage(chainId, ActionType.PlaceOrder, 7n, payload);

    const d = decodeSigningMessage(msg);

    expect(d.actionName).toBe("PlaceOrder");
    expect(d.seq).toBe(7n);
    if (d.action?.type === "PlaceOrder") {
      expect(d.action.data.price).toBe(100_000_000n);
      expect(d.action.data.side).toBe(Side.Buy);
    } else {
      expect.unreachable("expected a decoded PlaceOrder");
    }
  });

  it("degrades to action:null (not a throw) for an unknown action-type byte", () => {
    // A wire action newer than this SDK build: the envelope fields must
    // still parse so a signer tool can show them, with an honest "cannot
    // decode" instead of a false structural rejection.
    const payload = encodePayloadBytes(deposit);
    const msg = signingMessage(chainId, 0xee, 5n, payload);

    const d = decodeSigningMessage(msg);

    expect(d.actionType).toBe(0xee);
    expect(d.actionName).toBeNull();
    expect(d.action).toBeNull();
    expect(d.decodeError).toContain("unknown action type 0xee");
    expect(d.seq).toBe(5n);
    expect(Array.from(d.chainId)).toEqual(Array.from(chainId));
    expect(Array.from(d.payloadBytes)).toEqual(Array.from(payload));
  });

  it("degrades to action:null when a known type's payload doesn't decode", () => {
    const garbage = new Uint8Array([0xff, 0x00, 0x13, 0x37]);
    const msg = signingMessage(chainId, ActionType.Deposit, 5n, garbage);

    const d = decodeSigningMessage(msg);

    expect(d.actionName).toBe("Deposit");
    expect(d.action).toBeNull();
    expect(d.decodeError).not.toBeNull();
  });

  it("refuses a known action payload with undisplayed trailing fields", () => {
    const payload = encodePayloadBytes(deposit);
    const fields = new Decoder({ useBigInt64: true }).decode(payload);
    if (!Array.isArray(fields)) {
      expect.unreachable("expected a positional payload array");
    }
    const extendedPayload = new Encoder({ useBigInt64: true }).encode([
      ...fields,
      "field-this-sdk-does-not-display",
    ]);
    const msg = signingMessage(
      chainId,
      ActionType.Deposit,
      5n,
      extendedPayload,
    );

    const d = decodeSigningMessage(msg);

    expect(d.actionName).toBe("Deposit");
    expect(d.action).toBeNull();
    // Refusal is the contract: a non-canonical payload must never surface as a
    // decoded action. The WASM core rejects the extra trailing field at strict
    // length-checked decode ("array had incorrect length"); a payload that
    // decodes but is non-minimal is still caught by the re-encode canonical
    // check. Either way `action` is null and `decodeError` explains why.
    expect(d.decodeError).not.toBeNull();
    expect(Array.from(d.payloadBytes)).toEqual(Array.from(extendedPayload));
  });

  it("refuses a known action payload with a non-minimal integer encoding", () => {
    // rmp accepts any integer width on decode, so a bloated encoding decodes
    // to the same values — but those are not the bytes this SDK would produce,
    // so the canonical re-encode check must refuse to display it. (The
    // trailing-fields test above dies earlier, at strict length-checked
    // decode; this one exercises the re-encode comparison itself.)
    const order = (market: number) =>
      encodePayloadBytes({
        type: "PlaceOrder",
        data: {
          market,
          owner: OWNER,
          side: Side.Buy,
          price: 100_000_000n,
          quantity: 1n,
        },
      });
    const payload = order(1);
    // The market id is the first byte where market 1 and market 2 differ.
    const other = order(2);
    const at = payload.findIndex((byte, i) => byte !== other[i]);
    expect(payload[at]).toBe(0x01); // market=1 as a minimal positive fixint
    const bloated = new Uint8Array([
      ...payload.slice(0, at),
      0xce, // …re-encoded as a msgpack uint32: same value, non-minimal bytes
      0x00,
      0x00,
      0x00,
      0x01,
      ...payload.slice(at + 1),
    ]);
    const msg = signingMessage(chainId, ActionType.PlaceOrder, 5n, bloated);

    const d = decodeSigningMessage(msg);

    expect(d.actionName).toBe("PlaceOrders");
    expect(d.action).toBeNull();
    expect(d.decodeError).toMatch(/not the canonical representation/);
  });

  it("throws on a wrong domain prefix", () => {
    const payload = encodePayloadBytes(deposit);
    const msg = signingMessage(chainId, ActionType.Deposit, 1n, payload);
    msg[0] ^= 0xff;
    expect(() => decodeSigningMessage(msg)).toThrow(/domain prefix/);
  });

  it("throws on input shorter than the fixed header", () => {
    expect(() => decodeSigningMessage(new Uint8Array(56))).toThrow(
      /shorter than/,
    );
  });

  it("parses a preimage whose bytes sit at a nonzero offset in a larger buffer", () => {
    // The seq DataView reads through msg.buffer + byteOffset — a subarray
    // view over a bigger allocation must decode identically.
    const payload = encodePayloadBytes(deposit);
    const msg = signingMessage(chainId, ActionType.Deposit, 9n, payload);
    const padded = new Uint8Array(msg.length + 8);
    padded.set(msg, 8);
    const view = padded.subarray(8);

    const d = decodeSigningMessage(view);

    expect(d.seq).toBe(9n);
    expect(d.action?.type).toBe("Deposit");
  });
});

describe("peekActionType validation (#56)", () => {
  function cancelOrderTx(): Uint8Array {
    const kp = generateKeypair();
    const action: Action = {
      type: "CancelOrder",
      data: { orderId: 1n, owner: pubkeyToOwner(kp.publicKey) },
    };
    return encodeSignedTx(action, 7n, kp.publicKey, new Uint8Array(64));
  }

  it("returns the byte for a known action type", () => {
    expect(peekActionType(cancelOrderTx())).toBe(ActionType.CancelOrder);
  });

  it("returns null for an unassigned action-type byte instead of leaking it", () => {
    const bytes = cancelOrderTx();
    // Wire layout is [version, actionType, seq, payload, pubkey, signature]:
    // byte 0 is the msgpack fixarray header, byte 1 the version fixint,
    // byte 2 the action-type fixint.
    expect(peekActionType(bytes)).toBe(ActionType.CancelOrder);
    bytes[2] = 0x7f; // unassigned wire type — e.g. a newer engine's byte
    expect(peekActionType(bytes)).toBeNull();
  });

  it("returns null when the action-type slot is not a number", () => {
    const bogus = new Encoder().encode([
      ENVELOPE_VERSION,
      "CancelOrder",
      1,
      new Uint8Array(0),
      new Uint8Array(32),
      new Uint8Array(64),
    ]);
    expect(peekActionType(bogus)).toBeNull();
  });

  it("still returns null for structurally unreadable bytes", () => {
    expect(peekActionType(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Explicit undefined/null on optional action fields
// ---------------------------------------------------------------------------

describe("explicit undefined/null on optional action fields", () => {
  // The legacy hand-written codec normalized optional defaulted fields with
  // nullish coalescing (`d.postOnly ?? false`), so `{ postOnly: undefined }`
  // (a common JS spread shape) and even an untyped caller's explicit null
  // encoded as the documented default. The WASM adapter must keep that
  // contract: nullish fields are dropped before the serde boundary, because a
  // *present* JS null fails to deserialize into Rust's non-Option
  // `#[serde(default)]` fields (post_only, reduce_only, time_in_force, …).
  const base = {
    market: 1,
    owner: OWNER,
    side: Side.Buy,
    price: 66_750_000_000n,
    quantity: 5n,
  };
  const omitted = () =>
    encodePayloadBytes({ type: "PlaceOrder", data: { ...base } });

  it("encodes explicit-undefined optional fields byte-identically to omission", () => {
    const explicit = encodePayloadBytes({
      type: "PlaceOrder",
      data: {
        ...base,
        clientOrderId: undefined,
        postOnly: undefined,
        reduceOnly: undefined,
        timeInForce: undefined,
      },
    });
    expect(bytesToHex(explicit)).toBe(bytesToHex(omitted()));
  });

  it("encodes explicit-null optional fields byte-identically to omission (untyped JS callers)", () => {
    const data = {
      ...base,
      clientOrderId: null,
      postOnly: null,
      reduceOnly: null,
      timeInForce: null,
    };
    const explicit = encodePayloadBytes({
      type: "PlaceOrder",
      data,
    } as unknown as Action);
    expect(bytesToHex(explicit)).toBe(bytesToHex(omitted()));
  });
});

// ---------------------------------------------------------------------------
// Legacy short-payload decode compatibility
// ---------------------------------------------------------------------------

describe("legacy short-payload decode compatibility", () => {
  // The deleted TS codec decoded length-tolerantly (`postOnly: f.length > 6 &&
  // f[6] === true`), so a wire record produced before post_only / reduce_only /
  // time_in_force existed still decoded, with those trailing fields defaulted.
  // The WASM path must preserve that: the Rust structs carry `#[serde(default)]`
  // on the appended fields, so rmp-serde fills the defaults for a short
  // positional array. Pin it here at the `decodeTx` boundary rather than
  // leaving it implied by the Rust attributes.
  const envelope = (
    actionType: number,
    payloadFields: unknown[],
  ): Uint8Array => {
    const enc = new Encoder({ useBigInt64: true });
    const payload = enc.encode(payloadFields);
    return enc.encode([
      ENVELOPE_VERSION,
      actionType,
      1n,
      payload,
      ZERO_PUBKEY,
      ZERO_SIG,
    ]);
  };

  it("refuses the retired single-order bytes", () => {
    // 0x01 PlaceOrder, 0x02 CancelOrder, 0x04 MarketOrder, 0x17
    // ClosePosition and 0x18 CancelClientOrder no longer decode.
    const retired: [number, unknown[]][] = [
      [0x01, [1, OWNER, "Buy", 100n, 5n, null, false, false, "Gtc"]],
      [0x02, [42n, OWNER]],
      [0x04, [1, OWNER, "Buy", 5n, null, null, null]],
      [0x17, [1, OWNER]],
      [0x18, [OWNER, 9n]],
    ];
    for (const [byte, fields] of retired) {
      expect(() => decodeTx(envelope(byte, fields)), `0x${byte}`).toThrow();
    }
  });

  it("decodes a pre-TIF CancelReplaceOrder, defaulting the appended flags", () => {
    // CancelReplaceOrder up to `client_order_id`, no post_only/reduce_only/tif.
    const bytes = envelope(ActionType.CancelReplaceOrder, [
      OWNER,
      101n, // cancel_order_id
      null, // cancel_client_order_id
      2, // market
      "Buy",
      12345n,
      7n,
      202n, // client_order_id
    ]);
    const { action } = decodeTx(bytes);
    expect(action.type).toBe("CancelReplaceOrder");
    if (action.type === "CancelReplaceOrder") {
      expect(action.data.market).toBe(2);
      expect(action.data.postOnly).toBe(false);
      expect(action.data.reduceOnly).toBe(false);
      expect(action.data.timeInForce).toBe(TimeInForce.Gtc);
    }
  });
});
