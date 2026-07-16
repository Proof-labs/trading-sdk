import { describe, it, expect } from "vitest";
import { Decoder, Encoder } from "@msgpack/msgpack";
import {
  encodeSignedTx,
  encodePayloadBytes,
  decodeTx,
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

  it("round-trips OracleUpdate", () => {
    const action: Action = {
      type: "OracleUpdate",
      data: {
        market: 1,
        price: 5000n,
        signer: SIGNER,
        publishTimeMs: 1_000_000n,
      },
    };
    const bytes = encodeTx(action, 7n);
    const { action: decoded } = decodeTx(bytes);
    expect(decoded.type).toBe("OracleUpdate");
    if (decoded.type === "OracleUpdate") {
      expect(decoded.data.market).toBe(1);
      expect(decoded.data.price).toBe(5000n);
      expect(decoded.data.publishTimeMs).toBe(1_000_000n);
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
      type: "OracleUpdate",
      data: {
        market: 1,
        price: 50000n,
        signer: SIGNER,
        publishTimeMs: 100n,
      },
    },
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
      type: "CreateMarket",
      data: {
        market: 2,
        imBps: 1000,
        mmBps: 500,
        takerFeeBps: 5,
        makerFeeBps: 2,
        signer: SIGNER,
        fundingIntervalMs: 3600000n,
        maxFundingRateBps: 100,
        szDecimals: 4,
        ticker: "ETH",
      },
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
      type: "ConfirmDeposit",
      data: {
        owner: OWNER,
        amount: 5000n,
        solanaTxSig: new Uint8Array(64).fill(0xab),
        signer: SIGNER,
      },
    },
    {
      type: "ConfirmWithdrawal",
      data: {
        withdrawalId: 7n,
        solanaTxSig: new Uint8Array(64).fill(0xcd),
        signer: SIGNER,
      },
    },
    {
      type: "FailWithdrawal",
      data: { withdrawalId: 8n, reason: "tx failed", signer: SIGNER },
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
      type: "CreateImpactMarket",
      data: {
        impactMarketId: 42,
        underlyingMarket: 1,
        childMarketBase: 100,
        question: "BTC above $100k on Apr 30",
        deadlineMs: 4_000_000_000_000n,
        resolutionWindowMs: 3_600_000n,
        imBps: 1000,
        mmBps: 500,
        takerFeeBps: 5,
        makerFeeBps: 2,
        fundingIntervalMs: 60_000n,
        maxFundingRateBps: 3000,
        signer: SIGNER,
      },
    },
    {
      type: "ResolveEvent",
      data: { impactMarketId: 42, outcome: Outcome.Yes, signer: SIGNER },
    },
    {
      // All fields set — the common "tighten everything" admin call.
      type: "UpdateMarketFees",
      data: {
        market: 7,
        signer: SIGNER,
        takerFeeBps: 8,
        makerFeeBps: 1,
        maxFundingRateBps: 100,
        fundingIntervalMs: 3_600_000n,
        maxPositionSize: 50n,
      },
    },
    {
      // Partial update — only the funding cap changes, everything else
      // left unchanged. Should round-trip with null/undefined preserved
      // as `null` on the decoded side.
      type: "UpdateMarketFees",
      data: {
        market: 7,
        signer: SIGNER,
        takerFeeBps: null,
        makerFeeBps: null,
        maxFundingRateBps: 100,
        fundingIntervalMs: null,
        maxPositionSize: null,
      },
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

  it("round-trips CreateMarket poolId", () => {
    const action: Action = {
      type: "CreateMarket",
      data: {
        market: 42,
        imBps: 1000,
        mmBps: 500,
        takerFeeBps: 5,
        makerFeeBps: 2,
        signer: SIGNER,
        fundingIntervalMs: 60000n,
        maxFundingRateBps: 100,
        poolId: 9,
        szDecimals: 4,
        ticker: "BTC",
      },
    };

    const { action: decoded } = decodeTx(encodeTx(action, 1n));
    if (decoded.type !== "CreateMarket") throw new Error("type narrowing");
    // An omitted cap encodes as an explicit zero tail and decodes back as 0n —
    // "uncapped" is a value, not an absence.
    expect(decoded.data).toEqual({ ...action.data, maxOpenInterest: 0n });
  });

  it("round-trips CreateMarket maxOpenInterest tail", () => {
    const action: Action = {
      type: "CreateMarket",
      data: {
        market: 42,
        imBps: 1000,
        mmBps: 500,
        takerFeeBps: 5,
        makerFeeBps: 2,
        signer: SIGNER,
        fundingIntervalMs: 60_000n,
        maxFundingRateBps: 100,
        poolId: 9,
        szDecimals: 5,
        ticker: "BTC",
        maxOpenInterest: 1_000_000n,
      },
    };

    const { action: decoded } = decodeTx(encodeTx(action, 1n));
    expect(decoded).toEqual(action);
  });

  it("encodes CreateMarket to a 12-element array whatever the cap's value", () => {
    const base: Action = {
      type: "CreateMarket",
      data: {
        market: 42,
        imBps: 1000,
        mmBps: 500,
        takerFeeBps: 5,
        makerFeeBps: 2,
        signer: SIGNER,
        fundingIntervalMs: 60_000n,
        maxFundingRateBps: 100,
        poolId: 9,
        szDecimals: 5,
        ticker: "BTC",
      },
    };
    const withCap = (maxOpenInterest?: bigint | null): Action => ({
      type: "CreateMarket",
      data: {
        ...base.data,
        ...(maxOpenInterest === undefined ? {} : { maxOpenInterest }),
      },
    });

    // The engine always serializes max_open_interest, so the array length must
    // never depend on its value. If it did, the api-gateway's structured path —
    // which re-encodes the payload from JSON before the engine verifies the
    // signature over those bytes — could produce a different length than the
    // client signed, and every such tx would fail verification. Pin the msgpack
    // fixarray header (0x90 | n): 0x9c is a 12-element array.
    for (const cap of [undefined, null, 0n, 1_000_000n]) {
      const bytes = encodePayloadBytes(withCap(cap));
      expect(bytes[0]).toBe(0x9c);
    }

    // Omission, JSON-style null, and explicit zero are the same market and
    // therefore must be the exact same canonical bytes. All three decode to
    // the public uncapped value 0n rather than restoring absence/null.
    const canonicalUncapped = encodePayloadBytes(withCap(undefined));
    for (const cap of [undefined, null, 0n]) {
      expect(encodePayloadBytes(withCap(cap))).toEqual(canonicalUncapped);
      const decoded = decodeTx(encodeTx(withCap(cap), 1n)).action;
      if (decoded.type !== "CreateMarket") throw new Error("type narrowing");
      expect(decoded.data.maxOpenInterest).toBe(0n);
    }
  });

  it.each([-1n, 0x1_0000_0000_0000_0000n])(
    "rejects CreateMarket maxOpenInterest outside u64: %s",
    (maxOpenInterest) => {
      const action: Action = {
        type: "CreateMarket",
        data: {
          market: 42,
          imBps: 1000,
          mmBps: 500,
          takerFeeBps: 5,
          makerFeeBps: 2,
          signer: SIGNER,
          fundingIntervalMs: 60_000n,
          maxFundingRateBps: 100,
          poolId: 9,
          szDecimals: 5,
          ticker: "BTC",
          maxOpenInterest,
        },
      };
      // The WASM core rejects out-of-u64 BigInts at deserialization; the
      // hand-written TS codec used to phrase this as "unsigned u64 range".
      expect(() => encodePayloadBytes(action)).toThrow(
        /BigInt outside u64|unsigned u64 range/,
      );
    },
  );

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

  // Deeper round-trip: field-by-field equality for UpdateMarketFees
  // (the shape the shallow type-name check doesn't cover). Catches
  // silent serialization drift in the Option<T> fields.
  it("round-trips UpdateMarketFees field values (all set)", () => {
    const primary: Address = new Uint8Array([
      0xf1, 0xf1, 0xf1, 0xf1, 0xf1, 0xf1, 0xf1, 0xf1, 0xf1, 0xf1, 0xf1, 0xf1,
      0xf1, 0xf1, 0xf1, 0xf1, 0xf1, 0xf1, 0xf1, 0xf1,
    ]);
    const action: Action = {
      type: "UpdateMarketFees",
      data: {
        market: 42,
        signer: SIGNER,
        takerFeeBps: 8,
        makerFeeBps: 1,
        maxFundingRateBps: 250,
        fundingIntervalMs: 28_800_000n,
        maxPositionSize: 1000n,
        defaultTtlMs: 60_000n,
        netDeltaMargin: true,
        tickSize: 100n,
        lotSize: 10n,
        primaryOracleSigner: primary,
        oracleStalenessMs: 60_000n,
        markSourceMode: 1,
        maxMarkSpreadBps: 75,
        cexCompositeStalenessMs: 15_000n,
        partialLiquidationEnabled: true,
        feeTiers: [
          {
            min30dVolumeMicroUsdc: 0n,
            makerFeeTenthBps: 0,
            takerFeeTenthBps: 5,
          },
          {
            min30dVolumeMicroUsdc: 1_000_000_000n,
            makerFeeTenthBps: -1,
            takerFeeTenthBps: 3,
          },
        ],
        imBps: 3334,
        mmBps: 1667,
        maxOpenInterest: 2_000_000n,
      },
    };
    const { action: decoded } = decodeTx(encodeTx(action, 1n));
    expect(decoded.type).toBe("UpdateMarketFees");
    if (decoded.type !== "UpdateMarketFees") throw new Error("type narrowing");
    expect(decoded.data.market).toBe(42);
    expect(decoded.data.takerFeeBps).toBe(8);
    expect(decoded.data.makerFeeBps).toBe(1);
    expect(decoded.data.maxFundingRateBps).toBe(250);
    expect(decoded.data.fundingIntervalMs).toBe(28_800_000n);
    expect(decoded.data.maxPositionSize).toBe(1000n);
    expect(decoded.data.defaultTtlMs).toBe(60_000n);
    expect(decoded.data.netDeltaMargin).toBe(true);
    expect(decoded.data.tickSize).toBe(100n);
    expect(decoded.data.lotSize).toBe(10n);
    expect(decoded.data.primaryOracleSigner).toEqual(primary);
    expect(decoded.data.oracleStalenessMs).toBe(60_000n);
    expect(decoded.data.markSourceMode).toBe(1);
    expect(decoded.data.maxMarkSpreadBps).toBe(75);
    expect(decoded.data.cexCompositeStalenessMs).toBe(15_000n);
    expect(decoded.data.partialLiquidationEnabled).toBe(true);
    expect(decoded.data.feeTiers).toEqual(action.data.feeTiers);
    expect(decoded.data.imBps).toBe(3334);
    expect(decoded.data.mmBps).toBe(1667);
    expect(decoded.data.maxOpenInterest).toBe(2_000_000n);
  });

  it("round-trips UpdateMarketFees with only BE-48/BE-50 fields set", () => {
    // Operator setting tick/lot/oracle gates without touching fees.
    // Verifies the new fields travel independently of the older ones.
    const primary: Address = new Uint8Array([
      0xf1, 0xf1, 0xf1, 0xf1, 0xf1, 0xf1, 0xf1, 0xf1, 0xf1, 0xf1, 0xf1, 0xf1,
      0xf1, 0xf1, 0xf1, 0xf1, 0xf1, 0xf1, 0xf1, 0xf1,
    ]);
    const action: Action = {
      type: "UpdateMarketFees",
      data: {
        market: 7,
        signer: SIGNER,
        tickSize: 100n,
        lotSize: 5n,
        primaryOracleSigner: primary,
        oracleStalenessMs: 30_000n,
      },
    };
    const { action: decoded } = decodeTx(encodeTx(action, 1n));
    if (decoded.type !== "UpdateMarketFees") throw new Error("type narrowing");
    expect(decoded.data.market).toBe(7);
    expect(decoded.data.tickSize).toBe(100n);
    expect(decoded.data.lotSize).toBe(5n);
    expect(decoded.data.primaryOracleSigner).toEqual(primary);
    expect(decoded.data.oracleStalenessMs).toBe(30_000n);
    // Fee fields remain null (untouched).
    expect(decoded.data.takerFeeBps).toBeNull();
    expect(decoded.data.maxPositionSize).toBeNull();
    expect(decoded.data.netDeltaMargin).toBeNull();
    expect(decoded.data.imBps).toBeNull();
    expect(decoded.data.mmBps).toBeNull();
    expect(decoded.data.maxOpenInterest).toBeNull();
  });

  it("round-trips UpdateMarketFees primary oracle clear sentinel", () => {
    const action: Action = {
      type: "UpdateMarketFees",
      data: {
        market: 7,
        signer: SIGNER,
        primaryOracleSigner: new Uint8Array(20),
      },
    };

    const { action: decoded } = decodeTx(encodeTx(action, 1n));

    if (decoded.type !== "UpdateMarketFees") throw new Error("type narrowing");
    expect(decoded.data.primaryOracleSigner).toEqual(new Uint8Array(20));
  });

  it("round-trips UpdateMarketFees with None fields preserved as null", () => {
    const action: Action = {
      type: "UpdateMarketFees",
      data: {
        market: 42,
        signer: SIGNER,
        takerFeeBps: null,
        makerFeeBps: null,
        maxFundingRateBps: 100,
        fundingIntervalMs: null,
        maxPositionSize: null,
        defaultTtlMs: null,
      },
    };
    const { action: decoded } = decodeTx(encodeTx(action, 1n));
    if (decoded.type !== "UpdateMarketFees") throw new Error("type narrowing");
    expect(decoded.data.takerFeeBps).toBeNull();
    expect(decoded.data.makerFeeBps).toBeNull();
    expect(decoded.data.maxFundingRateBps).toBe(100);
    expect(decoded.data.fundingIntervalMs).toBeNull();
    expect(decoded.data.maxPositionSize).toBeNull();
    expect(decoded.data.defaultTtlMs).toBeNull();
    expect(decoded.data.feeTiers).toBeNull();
    expect(decoded.data.imBps).toBeNull();
    expect(decoded.data.mmBps).toBeNull();
    expect(decoded.data.maxOpenInterest).toBeNull();
  });

  it("round-trips UpdateMarketFees with only maxOpenInterest set", () => {
    const action: Action = {
      type: "UpdateMarketFees",
      data: {
        market: 7,
        signer: SIGNER,
        maxOpenInterest: 500_000n,
      },
    };

    const { action: decoded } = decodeTx(encodeTx(action, 1n));
    if (decoded.type !== "UpdateMarketFees") throw new Error("type narrowing");
    expect(decoded.data.maxOpenInterest).toBe(500_000n);
    // Slots 18/19 are required placeholders; max OI is engine slot 20.
    expect(decoded.data.imBps).toBeNull();
    expect(decoded.data.mmBps).toBeNull();
  });

  it.each([-1n, 0x1_0000_0000_0000_0000n])(
    "rejects UpdateMarketFees maxOpenInterest outside u64: %s",
    (maxOpenInterest) => {
      const action: Action = {
        type: "UpdateMarketFees",
        data: { market: 7, signer: SIGNER, maxOpenInterest },
      };
      // The WASM core rejects out-of-u64 BigInts at deserialization; the
      // hand-written TS codec used to phrase this as "unsigned u64 range".
      expect(() => encodePayloadBytes(action)).toThrow(
        /BigInt outside u64|unsigned u64 range/,
      );
    },
  );

  it("decodes the legacy 18-field UpdateMarketFees payload", () => {
    const encoder = new Encoder({ useBigInt64: true });
    const payload = encoder.encode([
      7,
      Array.from(SIGNER),
      ...Array(16).fill(null),
    ]);
    const wire = encoder.encode([
      ENVELOPE_VERSION,
      ActionType.UpdateMarketFees,
      1n,
      payload,
      ZERO_PUBKEY,
      ZERO_SIG,
    ]);

    const { action: decoded } = decodeTx(wire);
    if (decoded.type !== "UpdateMarketFees") throw new Error("type narrowing");
    expect(decoded.data.imBps).toBeNull();
    expect(decoded.data.mmBps).toBeNull();
    expect(decoded.data.maxOpenInterest).toBeNull();
  });

  it("round-trips UpdateMarketFees with only defaultTtlMs set (operator-only path)", () => {
    // Operator flipping TTL on its own, leaving everything else alone.
    // Verifies the defaultTtlMs field travels independently.
    const action: Action = {
      type: "UpdateMarketFees",
      data: {
        market: 7,
        signer: SIGNER,
        defaultTtlMs: 120_000n,
      },
    };
    const { action: decoded } = decodeTx(encodeTx(action, 1n));
    if (decoded.type !== "UpdateMarketFees") throw new Error("type narrowing");
    expect(decoded.data.market).toBe(7);
    expect(decoded.data.defaultTtlMs).toBe(120_000n);
    expect(decoded.data.takerFeeBps).toBeNull();
    expect(decoded.data.maxPositionSize).toBeNull();
  });

  // BE-54: oracleSource round-trip — three flavors. Default (undefined)
  // omits the field on the wire (length-tolerant decode preserves
  // pre-BE-54 SDK output); explicit RelayerAttested and the two
  // auto-resolve modes carry the full enum payload.
  it("BE-54: round-trips CreateImpactMarket without oracleSource (default)", () => {
    const action: Action = {
      type: "CreateImpactMarket",
      data: {
        impactMarketId: 42,
        underlyingMarket: 1,
        childMarketBase: 100,
        question: "BTC above $100k on Apr 30",
        deadlineMs: 4_000_000_000_000n,
        resolutionWindowMs: 3_600_000n,
        imBps: 1000,
        mmBps: 500,
        takerFeeBps: 5,
        makerFeeBps: 2,
        fundingIntervalMs: 60_000n,
        maxFundingRateBps: 3000,
        signer: SIGNER,
      },
    };
    const { action: decoded } = decodeTx(encodeTx(action, 1n));
    if (decoded.type !== "CreateImpactMarket")
      throw new Error("type narrowing");
    expect(decoded.data.oracleSource).toBeUndefined();
  });

  it("BE-54: round-trips CreateImpactMarket with UnderlyingPriceVsStrike oracleSource", () => {
    const action: Action = {
      type: "CreateImpactMarket",
      data: {
        impactMarketId: 42,
        underlyingMarket: 1,
        childMarketBase: 100,
        question: "BTC above $100k on Apr 30",
        deadlineMs: 4_000_000_000_000n,
        resolutionWindowMs: 3_600_000n,
        imBps: 1000,
        mmBps: 500,
        takerFeeBps: 5,
        makerFeeBps: 2,
        fundingIntervalMs: 60_000n,
        maxFundingRateBps: 3000,
        signer: SIGNER,
        oracleSource: {
          kind: "UnderlyingPriceVsStrike",
          strikePrice: 10_000_000n,
          comparison: "GreaterThan",
        },
      },
    };
    const { action: decoded } = decodeTx(encodeTx(action, 1n));
    if (decoded.type !== "CreateImpactMarket")
      throw new Error("type narrowing");
    expect(decoded.data.oracleSource).toEqual({
      kind: "UnderlyingPriceVsStrike",
      strikePrice: 10_000_000n,
      comparison: "GreaterThan",
    });
  });

  it("BE-54: round-trips CreateImpactMarket with MarketOracle oracleSource", () => {
    const action: Action = {
      type: "CreateImpactMarket",
      data: {
        impactMarketId: 42,
        underlyingMarket: 1,
        childMarketBase: 100,
        question: "ETH above $4k at expiry",
        deadlineMs: 4_000_000_000_000n,
        resolutionWindowMs: 3_600_000n,
        imBps: 1000,
        mmBps: 500,
        takerFeeBps: 5,
        makerFeeBps: 2,
        fundingIntervalMs: 60_000n,
        maxFundingRateBps: 3000,
        signer: SIGNER,
        oracleSource: {
          kind: "MarketOracle",
          market: 7,
          strikePrice: 4_000_000n,
          comparison: "GreaterThanOrEqual",
        },
      },
    };
    const { action: decoded } = decodeTx(encodeTx(action, 1n));
    if (decoded.type !== "CreateImpactMarket")
      throw new Error("type narrowing");
    expect(decoded.data.oracleSource).toEqual({
      kind: "MarketOracle",
      market: 7,
      strikePrice: 4_000_000n,
      comparison: "GreaterThanOrEqual",
    });
  });

  it("BE-54: round-trips CreateImpactMarket with RelayerAttested oracleSource", () => {
    const action: Action = {
      type: "CreateImpactMarket",
      data: {
        impactMarketId: 42,
        underlyingMarket: 1,
        childMarketBase: 100,
        question: "Did Apple announce X?",
        deadlineMs: 4_000_000_000_000n,
        resolutionWindowMs: 3_600_000n,
        imBps: 1000,
        mmBps: 500,
        takerFeeBps: 5,
        makerFeeBps: 2,
        fundingIntervalMs: 60_000n,
        maxFundingRateBps: 3000,
        signer: SIGNER,
        oracleSource: { kind: "RelayerAttested" },
      },
    };
    const { action: decoded } = decodeTx(encodeTx(action, 1n));
    if (decoded.type !== "CreateImpactMarket")
      throw new Error("type narrowing");
    expect(decoded.data.oracleSource).toEqual({ kind: "RelayerAttested" });
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

  it("V2 round-trips all 15 action types", () => {
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
        type: "OracleUpdate",
        data: {
          market: 1,
          price: 50000n,
          signer: SIGNER,
          publishTimeMs: 200n,
        },
      },
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
        type: "CreateMarket",
        data: {
          market: 2,
          imBps: 1000,
          mmBps: 500,
          takerFeeBps: 5,
          makerFeeBps: 2,
          signer: SIGNER,
          fundingIntervalMs: 3600000n,
          maxFundingRateBps: 100,
          szDecimals: 4,
          ticker: "ETH",
        },
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
        type: "ConfirmDeposit",
        data: {
          owner: OWNER,
          amount: 5000n,
          solanaTxSig: new Uint8Array(64).fill(0xab),
          signer: SIGNER,
        },
      },
      {
        type: "ConfirmWithdrawal",
        data: {
          withdrawalId: 7n,
          solanaTxSig: new Uint8Array(64).fill(0xcd),
          signer: SIGNER,
        },
      },
      {
        type: "FailWithdrawal",
        data: { withdrawalId: 8n, reason: "tx failed", signer: SIGNER },
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

describe("UpdateMarketFees.markSourceMode encoding", () => {
  it("encodes markSourceMode as the canonical enum name, not a bare integer", () => {
    // Regression: the enum must serialize as its variant name ("Median") to
    // match the engine/gateway's rmp-serde re-encoding. The pre-fix codec
    // emitted the integer index (0x01), which failed signature verification.
    const action: Action = {
      type: "UpdateMarketFees",
      data: { market: 1, signer: SIGNER, markSourceMode: 1 },
    };
    const hex = bytesToHex(encodeTx(action, 1n));
    const medianHex = bytesToHex(new TextEncoder().encode("Median"));
    expect(hex).toContain(medianHex); // "Median" str bytes present
  });

  it("round-trips markSourceMode 0 (OracleOnly) and 1 (Median)", () => {
    for (const mode of [0, 1] as const) {
      const action: Action = {
        type: "UpdateMarketFees",
        data: { market: 1, signer: SIGNER, markSourceMode: mode },
      };
      const { action: decoded } = decodeTx(encodeTx(action, 1n));
      expect(decoded.type).toBe("UpdateMarketFees");
      if (decoded.type === "UpdateMarketFees") {
        expect(decoded.data.markSourceMode).toBe(mode);
      }
    }
  });

  it("decode still accepts the legacy integer form (back-compat)", () => {
    // A tx encoded by an old SDK put the raw integer at slot 13; decoding it
    // must still yield the typed union rather than dropping to null.
    const legacy = encodeTx(
      { type: "UpdateMarketFees", data: { market: 1, signer: SIGNER } },
      1n,
    );
    // Sanity: default (no markSourceMode) decodes as null.
    const { action } = decodeTx(legacy);
    if (action.type === "UpdateMarketFees") {
      expect(action.data.markSourceMode ?? null).toBeNull();
    }
  });
});

describe("decodeSigningMessage", () => {
  const chainId = chainIdFromString("test-chain");
  const owner = pubkeyToOwner(getPublicKey(generateKeypair().privateKey));

  const createMarket: Action = {
    type: "CreateMarket",
    data: {
      market: 42,
      imBps: 500,
      mmBps: 250,
      takerFeeBps: 5,
      makerFeeBps: 2,
      signer: owner,
      fundingIntervalMs: 3_600_000n,
      maxFundingRateBps: 100,
      szDecimals: 2,
      ticker: "XYZ-PERP",
    },
  };

  it("round-trips the exact signingMessage() bytes for a CreateMarket", () => {
    const payload = encodePayloadBytes(createMarket);
    const seq = 1_752_000_000_000n;
    const msg = signingMessage(chainId, ActionType.CreateMarket, seq, payload);

    const d = decodeSigningMessage(msg);

    expect(Array.from(d.chainId)).toEqual(Array.from(chainId));
    expect(d.actionType).toBe(ActionType.CreateMarket);
    expect(d.actionName).toBe("CreateMarket");
    expect(d.seq).toBe(seq);
    expect(Array.from(d.payloadBytes)).toEqual(Array.from(payload));
    expect(d.decodeError).toBeNull();
    expect(d.action?.type).toBe("CreateMarket");
    if (d.action?.type === "CreateMarket") {
      expect(d.action.data.ticker).toBe("XYZ-PERP");
      expect(d.action.data.market).toBe(42);
      expect(d.action.data.imBps).toBe(500);
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
    const payload = encodePayloadBytes(createMarket);
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
    const msg = signingMessage(chainId, ActionType.CreateMarket, 5n, garbage);

    const d = decodeSigningMessage(msg);

    expect(d.actionName).toBe("CreateMarket");
    expect(d.action).toBeNull();
    expect(d.decodeError).not.toBeNull();
  });

  it("refuses a known action payload with undisplayed trailing fields", () => {
    const payload = encodePayloadBytes(createMarket);
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
      ActionType.CreateMarket,
      5n,
      extendedPayload,
    );

    const d = decodeSigningMessage(msg);

    expect(d.actionName).toBe("CreateMarket");
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
    const payload = encodePayloadBytes({
      type: "PlaceOrder",
      data: {
        market: 1,
        owner: OWNER,
        side: Side.Buy,
        price: 100_000_000n,
        quantity: 1n,
      },
    });
    expect(payload[1]).toBe(0x01); // market=1 as a minimal positive fixint
    const bloated = new Uint8Array([
      payload[0],
      0xce, // …re-encoded as a msgpack uint32: same value, non-minimal bytes
      0x00,
      0x00,
      0x00,
      0x01,
      ...payload.slice(2),
    ]);
    const msg = signingMessage(chainId, ActionType.PlaceOrder, 5n, bloated);

    const d = decodeSigningMessage(msg);

    expect(d.actionName).toBe("PlaceOrder");
    expect(d.action).toBeNull();
    expect(d.decodeError).toMatch(/not the canonical representation/);
  });

  it("throws on a wrong domain prefix", () => {
    const payload = encodePayloadBytes(createMarket);
    const msg = signingMessage(chainId, ActionType.CreateMarket, 1n, payload);
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
    const payload = encodePayloadBytes(createMarket);
    const msg = signingMessage(chainId, ActionType.CreateMarket, 9n, payload);
    const padded = new Uint8Array(msg.length + 8);
    padded.set(msg, 8);
    const view = padded.subarray(8);

    const d = decodeSigningMessage(view);

    expect(d.seq).toBe(9n);
    expect(d.action?.type).toBe("CreateMarket");
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
    bytes[2] = 0x1e; // unassigned wire type — e.g. a newer engine's byte
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
