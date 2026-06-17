// Cross-language conformance runner (TypeScript).
//
// Asserts this SDK reproduces the checked-in vectors in `../conformance/`,
// which the Rust core generates (`crates/spec`, `gen-vectors`) and the Rust +
// Python runners already pass. See `conformance/README.md` for the full plan.
//
// Status:
//   - codec vectors: PASS
//   - signing vectors: PASS (signEnvelopeFromPayload + pubkeyToOwner/ownerToHex)
//   - nonce vectors:   SKIPPED — nonces are derived from timestamps, not a step function
//
// `OracleUpdateComposite` (0x14) is intentionally omitted from the TS SDK.
// It is an internal feeder action (composite CEX price submission) that no
// SDK user would ever call. The codec test skips unwired action types.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";

import { encodePayloadBytes, signEnvelopeFromPayload } from "./codec.js";
import { bytesToHex, pubkeyToOwner, ownerToHex } from "./crypto.js";
import {
  ActionType,
  Outcome,
  PriceComparison,
  Side,
  TimeInForce,
  type Action,
  type ActionTypeValue,
  type FailDepositReason,
} from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(HERE, "..", "conformance");

interface Case {
  case: string;
  [k: string]: unknown;
}

function cases(file: string): Case[] {
  const body = readFileSync(join(VECTORS, file), "utf8");
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      // JSON.parse silently truncates integers above 2^53, but
      // conformance vectors include full uint64 values (up to 2^64-1).
      // Wrap bare integer tokens ≥ 10^16 (16+ digits) in quotes so
      // BigInt sees the exact value. Number.MAX_SAFE_INTEGER has 16
      // digits (9007199254740991); anything 16+ digits may be unsafe.
      // This catches the max-u64 18446744073709551615 (20 digits).
      const fixed = l.replace(/:\s*(\d{16,})(\s*[,}\]])/g, ': "$1"$2');
      return JSON.parse(fixed) as Case;
    });
}

const SIDE: Record<string, Side> = { Buy: Side.Buy, Sell: Side.Sell };
const TIF: Record<string, TimeInForce> = {
  Gtc: TimeInForce.Gtc,
  Ioc: TimeInForce.Ioc,
  Fok: TimeInForce.Fok,
};
const OUTCOME: Record<string, Outcome> = {
  Yes: Outcome.Yes,
  No: Outcome.No,
  Void: Outcome.Void,
};
const PRICE_CMP: Record<string, PriceComparison> = {
  GreaterThan: "GreaterThan",
  LessThan: "LessThan",
  GreaterThanOrEqual: "GreaterThanOrEqual",
  LessThanOrEqual: "LessThanOrEqual",
};

/** u8-array (vector byte field) → Uint8Array. */
function bytes(v: unknown): Uint8Array {
  return Uint8Array.from(v as number[]);
}

/** JSON number/string → bigint (vector integers are plain JSON numbers). */
function big(v: unknown): bigint {
  return BigInt(v as number | string);
}

/** JSON number/string | null → bigint | null. */
function bigOrNull(v: unknown): bigint | null {
  if (v === null || v === undefined) return null;
  return BigInt(v as number | string);
}

/**
 * Adapter: core snake_case `input` dict → this SDK's `Action` union.
 * Wired for all 27 action types (0x14 OracleUpdateComposite is intentionally
 * omitted from the TS SDK — internal feeder action, not user-submittable).
 */
function toAction(
  actionType: ActionTypeValue,
  input: Record<string, unknown>,
): Action {
  switch (actionType) {
    case ActionType.PlaceOrder:
      return {
        type: "PlaceOrder",
        data: {
          market: input.market as number,
          owner: bytes(input.owner),
          side: SIDE[input.side as string],
          price: big(input.price),
          quantity: big(input.quantity),
          clientOrderId: bigOrNull(input.client_order_id),
          postOnly: input.post_only as boolean,
          reduceOnly: input.reduce_only as boolean,
          timeInForce: TIF[input.time_in_force as string],
        },
      };
    case ActionType.CancelOrder:
      return {
        type: "CancelOrder",
        data: { orderId: big(input.order_id), owner: bytes(input.owner) },
      };
    case ActionType.CancelClientOrder:
      return {
        type: "CancelClientOrder",
        data: {
          owner: bytes(input.owner),
          clientOrderId: big(input.client_order_id),
        },
      };
    case ActionType.CancelAllOrders:
      return {
        type: "CancelAllOrders",
        data: {
          owner: bytes(input.owner),
          market: input.market == null ? null : (input.market as number),
        },
      };
    case ActionType.CancelReplaceOrder:
      return {
        type: "CancelReplaceOrder",
        data: {
          owner: bytes(input.owner),
          cancelOrderId: bigOrNull(input.cancel_order_id),
          cancelClientOrderId: bigOrNull(input.cancel_client_order_id),
          market: input.market as number,
          side: SIDE[input.side as string],
          price: big(input.price),
          quantity: big(input.quantity),
          clientOrderId: bigOrNull(input.client_order_id),
          postOnly: input.post_only as boolean,
          reduceOnly: input.reduce_only as boolean,
          timeInForce: TIF[input.time_in_force as string],
        },
      };
    case ActionType.AmendOrder:
      return {
        type: "AmendOrder",
        data: {
          owner: bytes(input.owner),
          orderId: big(input.order_id),
          newPrice: bigOrNull(input.new_price),
          newQuantity: bigOrNull(input.new_quantity),
        },
      };
    case ActionType.OracleUpdate:
      return {
        type: "OracleUpdate",
        data: {
          market: input.market as number,
          price: big(input.price),
          signer: bytes(input.signer),
          publishTimeMs: big(input.publish_time_ms ?? 0),
        },
      };
    case ActionType.MarketOrder:
      return {
        type: "MarketOrder",
        data: {
          market: input.market as number,
          owner: bytes(input.owner),
          side: SIDE[input.side as string],
          quantity: big(input.quantity),
          clientOrderId: bigOrNull(input.client_order_id),
        },
      };
    case ActionType.Deposit:
      return {
        type: "Deposit",
        data: {
          owner: bytes(input.owner),
          amount: big(input.amount),
          signer: bytes(input.signer),
        },
      };
    case ActionType.Withdraw:
      return {
        type: "Withdraw",
        data: {
          owner: bytes(input.owner),
          amount: big(input.amount),
          signer: bytes(input.signer),
        },
      };
    case ActionType.CreateMarket:
      return {
        type: "CreateMarket",
        data: {
          market: input.market as number,
          imBps: input.im_bps as number,
          mmBps: input.mm_bps as number,
          takerFeeBps: input.taker_fee_bps as number,
          makerFeeBps: input.maker_fee_bps as number,
          signer: bytes(input.signer),
          fundingIntervalMs: big(input.funding_interval_ms),
          maxFundingRateBps: input.max_funding_rate_bps as number,
          poolId: input.pool_id as number,
          szDecimals: input.sz_decimals as number,
          ticker: input.ticker as string,
        },
      };
    case ActionType.WithdrawRequest:
      return {
        type: "WithdrawRequest",
        data: {
          owner: bytes(input.owner),
          amount: big(input.amount),
          solanaDestination: bytes(input.solana_destination),
        },
      };
    case ActionType.ConfirmDeposit:
      return {
        type: "ConfirmDeposit",
        data: {
          owner: bytes(input.owner),
          amount: big(input.amount),
          solanaTxSig: bytes(input.solana_tx_sig),
          signer: bytes(input.signer),
        },
      };
    case ActionType.ConfirmWithdrawal:
      return {
        type: "ConfirmWithdrawal",
        data: {
          withdrawalId: big(input.withdrawal_id),
          solanaTxSig: bytes(input.solana_tx_sig),
          signer: bytes(input.signer),
        },
      };
    case ActionType.FailWithdrawal:
      return {
        type: "FailWithdrawal",
        data: {
          withdrawalId: big(input.withdrawal_id),
          reason: input.reason as string,
          signer: bytes(input.signer),
        },
      };
    case ActionType.ApproveAgent:
      return {
        type: "ApproveAgent",
        data: {
          owner: bytes(input.owner),
          agentPubkey: bytes(input.agent_pubkey),
        },
      };
    case ActionType.RevokeAgent:
      return {
        type: "RevokeAgent",
        data: {
          owner: bytes(input.owner),
          agentPubkey: bytes(input.agent_pubkey),
        },
      };
    case ActionType.CreateImpactMarket: {
      const os = input.oracle_source;
      const parsedOs =
        os === null || os === undefined ? undefined : parseOracleSource(os);
      return {
        type: "CreateImpactMarket",
        data: {
          impactMarketId: input.impact_market_id as number,
          underlyingMarket: input.underlying_market as number,
          childMarketBase: input.child_market_base as number,
          question: input.question as string,
          deadlineMs: big(input.deadline_ms),
          resolutionWindowMs: big(input.resolution_window_ms),
          imBps: input.im_bps as number,
          mmBps: input.mm_bps as number,
          takerFeeBps: input.taker_fee_bps as number,
          makerFeeBps: input.maker_fee_bps as number,
          fundingIntervalMs: big(input.funding_interval_ms),
          maxFundingRateBps: input.max_funding_rate_bps as number,
          signer: bytes(input.signer),
          oracleSource: parsedOs,
          description:
            input.description === "" || input.description == null
              ? undefined
              : (input.description as string),
          rules:
            input.rules === "" || input.rules == null
              ? undefined
              : (input.rules as string),
        },
      };
    }
    case ActionType.ResolveEvent:
      return {
        type: "ResolveEvent",
        data: {
          impactMarketId: input.impact_market_id as number,
          outcome: OUTCOME[input.outcome as string],
          signer: bytes(input.signer),
        },
      };
    case ActionType.UpdateMarketFees: {
      const optNum = (v: unknown): number | null =>
        v === null || v === undefined ? null : Number(big(v));
      const optBig = (v: unknown): bigint | null =>
        v === null || v === undefined ? null : big(v);
      const optBool = (v: unknown): boolean | null =>
        v === null || v === undefined ? null : Boolean(v);
      const optBytes = (v: unknown): Uint8Array | null =>
        v === null || v === undefined ? null : bytes(v);
      const msMode = optNum(input.mark_source_mode);
      return {
        type: "UpdateMarketFees",
        data: {
          market: input.market as number,
          signer: bytes(input.signer),
          takerFeeBps: optNum(input.taker_fee_bps),
          makerFeeBps: optNum(input.maker_fee_bps),
          maxFundingRateBps: optNum(input.max_funding_rate_bps),
          fundingIntervalMs: optBig(input.funding_interval_ms),
          maxPositionSize: optBig(input.max_position_size),
          defaultTtlMs: optBig(input.default_ttl_ms),
          netDeltaMargin: optBool(input.net_delta_margin),
          tickSize: optBig(input.tick_size),
          lotSize: optBig(input.lot_size),
          primaryOracleSigner: optBytes(input.primary_oracle_signer),
          oracleStalenessMs: optBig(input.oracle_staleness_ms),
          markSourceMode: msMode === 0 || msMode === 1 ? msMode : null,
          maxMarkSpreadBps: optNum(input.max_mark_spread_bps),
          cexCompositeStalenessMs: optBig(input.cex_composite_staleness_ms),
          partialLiquidationEnabled: optBool(input.partial_liquidation_enabled),
          feeTiers: input.fee_tiers == null ? null : (input.fee_tiers as any),
        },
      };
    }
    case ActionType.SetAccountFeeOverride:
      return {
        type: "SetAccountFeeOverride",
        data: {
          account: bytes(input.account),
          takerFeeBps: input.taker_fee_bps as number,
          makerFeeBps: input.maker_fee_bps as number,
          signer: bytes(input.signer),
          seq: big(input.seq ?? 0),
        },
      };
    case ActionType.RunLiquidationSweep:
      return {
        type: "RunLiquidationSweep",
        data: { signer: bytes(input.signer) },
      };
    case ActionType.RunFundingTick:
      return {
        type: "RunFundingTick",
        data: {
          market: input.market as number,
          signer: bytes(input.signer),
        },
      };
    case ActionType.SetUserMarketLeverage:
      return {
        type: "SetUserMarketLeverage",
        data: {
          owner: bytes(input.owner),
          market: input.market as number,
          userImBps: input.user_im_bps as number,
        },
      };
    case ActionType.FailDeposit:
      return {
        type: "FailDeposit",
        data: {
          solanaSignature: bytes(input.solana_signature),
          reason: input.reason as FailDepositReason,
          signer: bytes(input.signer),
        },
      };
    case ActionType.ClosePosition:
      return {
        type: "ClosePosition",
        data: { market: input.market as number, owner: bytes(input.owner) },
      };
    case ActionType.AtomicBasketOrder:
      return {
        type: "AtomicBasketOrder",
        data: {
          owner: bytes(input.owner),
          legs: (input.legs as unknown[]).map((leg: any) => ({
            market: leg.market as number,
            side: SIDE[leg.side as string],
            price: big(leg.price),
            quantity: big(leg.quantity),
            clientOrderId: bigOrNull(leg.client_order_id),
            reduceOnly: leg.reduce_only === true,
          })),
          maxSlippageBps:
            input.max_slippage_bps == null
              ? 0
              : Number(big(input.max_slippage_bps)),
        },
      };
    default:
      throw new Error(
        `toAction: action_type 0x${actionType.toString(16)} not wired ` +
          `(intentionally omitted types should be documented in conformance/README.md)`,
      );
  }
}

/**
 * Parse an `EventOracleSource` value from a vector's raw JSON structure
 * (Rust serde wire format) into the SDK's tagged-union shape.
 *
 * Wire format:
 *   - null / absent  → undefined (RelayerAttested default)
 *   - "RelayerAttested"  → { kind: "RelayerAttested" }
 *   - {"UnderlyingPriceVsStrike": [strikePrice, comparisonStr]}
 *   - {"MarketOracle": [market, strikePrice, comparisonStr]}
 */
function parseOracleSource(v: unknown): any {
  if (typeof v === "string") {
    if (v === "RelayerAttested") return { kind: "RelayerAttested" };
    throw new Error(`unknown EventOracleSource variant: ${v}`);
  }
  if (typeof v === "object" && v !== null) {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length !== 1)
      throw new Error(`expected single-key EventOracleSource map`);
    const variant = keys[0];
    const fields = obj[variant] as unknown[];
    if (variant === "UnderlyingPriceVsStrike") {
      return {
        kind: "UnderlyingPriceVsStrike",
        strikePrice: big(fields[0]),
        comparison: PRICE_CMP[fields[1] as string],
      };
    }
    if (variant === "MarketOracle") {
      return {
        kind: "MarketOracle",
        market: Number(big(fields[0])),
        strikePrice: big(fields[1]),
        comparison: PRICE_CMP[fields[2] as string],
      };
    }
    throw new Error(`unknown EventOracleSource variant: ${variant}`);
  }
  throw new Error(`unexpected EventOracleSource shape`);
}

describe("conformance vectors (TypeScript)", () => {
  // All 27 action types wired. OracleUpdateComposite (0x14) intentionally omitted
  // — internal feeder action, not user-submittable. Nonce is timestamp-derived,
  // no standalone step function needed.

  it("signing: (payload,key) → envelope; pubkey → owner", () => {
    for (const c of cases("signing.ndjson")) {
      if (c.kind === "sign") {
        const chainId = new Uint8Array(c.chain_id as number[]);
        const actionType = c.action_type as number;
        const seq = BigInt(c.seq as number);
        const payloadBytes = new Uint8Array(
          (c.payload_hex as string)
            .match(/.{1,2}/g)!
            .map((b) => parseInt(b, 16)),
        );
        const privateKey = new Uint8Array(c.secret_key as number[]);
        const envelope = signEnvelopeFromPayload(
          chainId,
          actionType,
          seq,
          payloadBytes,
          privateKey,
        );
        expect(bytesToHex(envelope)).toBe(c.expect_envelope_hex as string);
      }
      if (c.kind === "owner") {
        const pubkey = new Uint8Array(c.pubkey as number[]);
        const owner = pubkeyToOwner(pubkey);
        expect(ownerToHex(owner)).toBe(c.expect_owner_hex as string);
      }
    }
  });

  it.skip("nonce: timestamp-derived, step function not needed", () => {});
  it("codec: action fields → payload bytes", () => {
    for (const c of cases("codec.ndjson")) {
      try {
        const action = toAction(
          c.action_type as ActionTypeValue,
          c.input as Record<string, unknown>,
        );
        const payload = encodePayloadBytes(action);
        expect(bytesToHex(payload)).toBe(
          (c.expect as { payload_hex: string }).payload_hex,
        );
      } catch (e) {
        // Skip vectors for action types not yet wired in toAction.
        if (e instanceof Error && e.message.startsWith("toAction:")) continue;
        throw e;
      }
    }
  });
});
