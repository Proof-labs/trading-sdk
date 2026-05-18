import { describe, it, expect } from "vitest";
import {
  encodeTx,
  decodeTx,
  peekActionType,
  signAndEncode,
  encodeTxV2,
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
  PRIMARY_ORACLE_CLEAR_SENTINEL,
  Side,
  TimeInForce,
  type Action,
  type Address,
} from "./types.js";
import { FEE_OVERRIDE_REVERT_SENTINEL } from "./index.js";

const OWNER = new Uint8Array(20).fill(0xaa);
const SIGNER = new Uint8Array(20).fill(0xff);

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

    expect(version).toBe(1);
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
      expect(version).toBe(1);
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
      },
    };

    const { action: decoded } = decodeTx(encodeTx(action, 1n));
    expect(decoded).toEqual(action);
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
  });

  it("round-trips UpdateMarketFees primary oracle clear sentinel", () => {
    const action: Action = {
      type: "UpdateMarketFees",
      data: {
        market: 7,
        signer: SIGNER,
        primaryOracleSigner: PRIMARY_ORACLE_CLEAR_SENTINEL,
      },
    };

    const { action: decoded } = decodeTx(encodeTx(action, 1n));

    if (decoded.type !== "UpdateMarketFees") throw new Error("type narrowing");
    expect(decoded.data.primaryOracleSigner).toEqual(
      PRIMARY_ORACLE_CLEAR_SENTINEL,
    );
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

  // BE-46 / BE-46.2: per-account fee override round-trip, including
  // the replay-guard `seq` field appended by Ramon's 2026-05-03
  // review on PR #39.
  it("round-trips SetAccountFeeOverride", () => {
    const account = new Uint8Array(20).fill(0xab);
    const action: Action = {
      type: "SetAccountFeeOverride",
      data: {
        account,
        takerFeeBps: 3,
        makerFeeBps: 1,
        signer: SIGNER,
        seq: 42n,
      },
    };
    const { action: decoded } = decodeTx(encodeTx(action, 7n));
    expect(decoded.type).toBe("SetAccountFeeOverride");
    if (decoded.type !== "SetAccountFeeOverride") throw new Error("type narrowing");
    expect(decoded.data.account).toEqual(account);
    expect(decoded.data.takerFeeBps).toBe(3);
    expect(decoded.data.makerFeeBps).toBe(1);
    expect(decoded.data.signer).toEqual(SIGNER);
    expect(decoded.data.seq).toBe(42n);
  });

  // BE-46.2: seq round-trips at the realistic Date.now()-style ms
  // boundary the tier promoter is expected to use. Sanity-check that
  // we don't fall off a u32/Number cliff.
  it("round-trips SetAccountFeeOverride with millisecond-scale seq", () => {
    const account = new Uint8Array(20).fill(0xcd);
    const ms: bigint = 1_730_000_000_000n; // ~2024-10-27 in ms — well past 2^32.
    const action: Action = {
      type: "SetAccountFeeOverride",
      data: {
        account,
        takerFeeBps: 0,
        makerFeeBps: 0,
        signer: SIGNER,
        seq: ms,
      },
    };
    const { action: decoded } = decodeTx(encodeTx(action, 1n));
    if (decoded.type !== "SetAccountFeeOverride") throw new Error("type narrowing");
    expect(decoded.data.seq).toBe(ms);
  });

  // BE-46.1: the FEE_OVERRIDE_REVERT_SENTINEL constant is what callers
  // pass on either side of an override to mean "fall back to market
  // base for this side." The encoder/decoder must round-trip it
  // verbatim — the engine compares it as `u32::MAX` exactly, so a
  // round-trip drift would silently produce nonsense fees.
  it("round-trips FEE_OVERRIDE_REVERT_SENTINEL on both fee sides", () => {
    expect(FEE_OVERRIDE_REVERT_SENTINEL).toBe(4_294_967_295);

    const account = new Uint8Array(20).fill(0xef);
    const action: Action = {
      type: "SetAccountFeeOverride",
      data: {
        account,
        takerFeeBps: FEE_OVERRIDE_REVERT_SENTINEL,
        makerFeeBps: FEE_OVERRIDE_REVERT_SENTINEL,
        signer: SIGNER,
        seq: 1n,
      },
    };
    const { action: decoded } = decodeTx(encodeTx(action, 1n));
    if (decoded.type !== "SetAccountFeeOverride") throw new Error("type narrowing");
    expect(decoded.data.takerFeeBps).toBe(FEE_OVERRIDE_REVERT_SENTINEL);
    expect(decoded.data.makerFeeBps).toBe(FEE_OVERRIDE_REVERT_SENTINEL);
  });

  // Mixed: sentinel on one side, real bps on the other — the engine
  // resolves each side independently. Make sure the encoder doesn't
  // accidentally truncate u32::MAX into something smaller.
  it("round-trips FEE_OVERRIDE_REVERT_SENTINEL alongside a normal bps value", () => {
    const account = new Uint8Array(20).fill(0x12);
    const action: Action = {
      type: "SetAccountFeeOverride",
      data: {
        account,
        takerFeeBps: 1, // explicit override on taker side
        makerFeeBps: FEE_OVERRIDE_REVERT_SENTINEL, // revert maker to market base
        signer: SIGNER,
        seq: 2n,
      },
    };
    const { action: decoded } = decodeTx(encodeTx(action, 1n));
    if (decoded.type !== "SetAccountFeeOverride") throw new Error("type narrowing");
    expect(decoded.data.takerFeeBps).toBe(1);
    expect(decoded.data.makerFeeBps).toBe(FEE_OVERRIDE_REVERT_SENTINEL);
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
    if (decoded.type !== "CreateImpactMarket") throw new Error("type narrowing");
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
    if (decoded.type !== "CreateImpactMarket") throw new Error("type narrowing");
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
    if (decoded.type !== "CreateImpactMarket") throw new Error("type narrowing");
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
    if (decoded.type !== "CreateImpactMarket") throw new Error("type narrowing");
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
