import { Encoder, Decoder } from "@msgpack/msgpack";
import {
  type Action,
  ActionType,
  type ActionTypeValue,
  type Address,
  type EventOracleSource,
  type FailDepositReason,
  type FeeTier,
  Outcome,
  type PriceComparison,
  Side,
  TimeInForce,
} from "./types.js";
import { signingMessage, sign, getPublicKey } from "./crypto.js";

// ---------------------------------------------------------------------------
// MessagePack encoder/decoder configured for BigInt
// ---------------------------------------------------------------------------
//
// IMPORTANT — minimal-int compatibility with rmp-serde:
//
// rmp-serde (the Rust msgpack lib used by exchange-core and the api-gateway)
// always encodes integers in their minimal form:
//   0..=127        → positive fixint (1 byte)
//   0..=255        → uint8 (2 bytes)
//   0..=65535      → uint16 (3 bytes)
//   0..=2^32-1     → uint32 (5 bytes)
//   2^32..=2^64-1  → uint64 (9 bytes)
//
// @msgpack/msgpack v3 with `useBigInt64: true` ALWAYS encodes BigInt as
// uint64 (9 bytes), even for small values like 1n. That breaks signature
// verification: the gateway re-encodes the same logical action via
// rmp-serde, gets fewer bytes for small fields, and the canonical
// payloads don't match.
//
// The fix below: in `encode()`, walk the value tree and convert any
// BigInt that fits in u32 (0..=2^32-1) to a plain Number. @msgpack/msgpack
// encodes such Numbers using its minimal-int encoding (fixint/uint8/
// uint16/uint32), matching rmp-serde exactly. BigInts >= 2^32 are kept
// as BigInt so `useBigInt64` emits them as uint64 — which also matches
// rmp-serde for those magnitudes.
//
// We deliberately stop at 2^32 and NOT at Number.MAX_SAFE_INTEGER (2^53-1):
// @msgpack/msgpack encodes Numbers above 2^32 as float64 (9 bytes with
// the 0xcb type byte), which would NOT match rmp-serde's uint64 and would
// reintroduce the signature mismatch. See the `minimizeBigInts` comment
// below for the gory details.
//
// Decoding uses `useBigInt64: true` for symmetry: any int field that
// could be a u64 in the source is returned as bigint, so the consuming
// code can rely on a single type for those slots.

const encoder = new Encoder({ useBigInt64: true });
const decoder = new Decoder({ useBigInt64: true });

/**
 * Recursively walk a value and convert BigInts that fit in u32 (0..=2^32-1)
 * to plain Numbers. This is the only range where the conversion is safe AND
 * useful: @msgpack/msgpack encodes Numbers up to 2^32-1 as msgpack ints
 * (positive fixint, uint8, uint16, or uint32 — minimal form). For Numbers
 * above 2^32 it switches to float64 (9 bytes) which would NOT match
 * rmp-serde's uint64 encoding and would break signature verification.
 *
 * BigInts >= 2^32 are kept as BigInt; with `useBigInt64: true` the encoder
 * emits them as msgpack uint64 (9 bytes), which DOES match rmp-serde for
 * those magnitudes.
 *
 * Net effect: every integer field in an action is encoded in the same
 * minimal form rmp-serde would use, regardless of whether the SDK caller
 * passed it as Number or BigInt.
 *
 * Negative BigInts are kept as BigInt as a safety net — none of the action
 * types use signed integers, so this branch is effectively dead code, but
 * keeping it preserves correctness if a signed field is added later.
 */
const U32_MAX_BIGINT = 0xffff_ffffn; // 2^32 - 1

function minimizeBigInts(value: unknown): unknown {
  if (typeof value === "bigint") {
    if (value >= 0n && value <= U32_MAX_BIGINT) {
      return Number(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(minimizeBigInts);
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value)) {
      out[k] = minimizeBigInts((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

function encode(value: unknown): Uint8Array {
  return encoder.encode(minimizeBigInts(value));
}

function decode(bytes: Uint8Array): unknown {
  return decoder.decode(bytes);
}

function encodeFeeTier(tier: FeeTier): unknown[] {
  return [
    tier.min30dVolumeMicroUsdc,
    tier.makerFeeTenthBps,
    tier.takerFeeTenthBps,
  ];
}

function decodeFeeTiers(value: unknown): FeeTier[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) {
    throw new Error("feeTiers must decode as an array");
  }
  return value.map((row) => {
    if (!Array.isArray(row) || row.length < 3) {
      throw new Error(
        "feeTier row must decode as [minVolume, makerFee, takerFee]",
      );
    }
    return {
      min30dVolumeMicroUsdc: bi(row[0]),
      makerFeeTenthBps: Number(bi(row[1])),
      takerFeeTenthBps: Number(bi(row[2])),
    };
  });
}

// ---------------------------------------------------------------------------
// Signed wire envelope
// ---------------------------------------------------------------------------

/**
 * Encode a signed wire envelope from a pre-computed pubkey + signature.
 * Wire: `[version=2, actionType, seq, payload, pubkey(32), signature(64)]`.
 * Most callers should use `signAndEncode` instead; this exists for paths
 * that already hold raw signature bytes.
 */
export function encodeSignedTx(
  action: Action,
  seq: bigint,
  pubkey: Uint8Array,
  signature: Uint8Array,
): Uint8Array {
  const [actionType, payload] = encodePayload(action);
  const payloadBytes = encode(payload);
  return encode([
    2,
    actionType,
    seq,
    payloadBytes,
    pubkey,
    signature,
  ]) as Uint8Array;
}

/**
 * Sign an action and encode as V2 wire bytes, binding the signature
 * to `chainId` (audit B4, 2026-04-23). Production signers must pass
 * `chainIdFromString(cometbftChainId)`; only unit tests should pass
 * `UNBOUND_CHAIN_ID`. `ExchangeClient` resolves and caches this
 * automatically — call this directly only when bypassing the client.
 */
export function signAndEncode(
  chainId: Uint8Array,
  action: Action,
  seq: bigint,
  privateKey: Uint8Array,
): Uint8Array {
  const [actionType, payload] = encodePayload(action);
  const payloadBytes = encode(payload);
  const msg = signingMessage(chainId, actionType, seq, payloadBytes);
  const signature = sign(privateKey, msg);
  const pubkey = getPublicKey(privateKey);
  return encode([
    2,
    actionType,
    seq,
    payloadBytes,
    pubkey,
    signature,
  ]) as Uint8Array;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/** Peek at the action_type byte without full decode. */
export function peekActionType(bytes: Uint8Array): ActionTypeValue | null {
  try {
    const envelope = decode(bytes) as unknown[];
    return envelope[1] as ActionTypeValue;
  } catch {
    return null;
  }
}

/**
 * Coerce a decoded msgpack int (which @msgpack/msgpack returns as either
 * `number` or `bigint` depending on whether the wire form was a fixint or
 * a uint64) into a single bigint. Used by decodeTx to keep the SDK's
 * external types stable regardless of how the encoder chose to represent
 * a particular value on the wire.
 */
function toBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  throw new Error(`expected number/bigint, got ${typeof v}: ${v}`);
}

/** Decode wire bytes into an action + sequence number + auth fields. */
export function decodeTx(bytes: Uint8Array): {
  action: Action;
  seq: bigint;
  version: number;
  pubkey: Uint8Array;
  signature: Uint8Array;
} {
  const envelope = decode(bytes) as unknown[];
  const version = envelope[0] as number;

  if (version !== 2) {
    throw new Error(`unsupported version: ${version}`);
  }

  const actionType = envelope[1] as ActionTypeValue;
  // Always normalize seq to bigint — the encoder may have written it as
  // a fixint (1 byte → Number on decode) for small values, but consumers
  // of the SDK expect a single typed slot.
  const seq = toBigInt(envelope[2]);
  const payloadBytes = envelope[3] as Uint8Array;
  const payload = decode(payloadBytes) as unknown[];
  const action = decodePayload(actionType, payload);

  return {
    action,
    seq,
    version,
    pubkey: envelope[4] as Uint8Array,
    signature: envelope[5] as Uint8Array,
  };
}

// ---------------------------------------------------------------------------
// Payload encoding — field order MUST match Rust struct definitions
// ---------------------------------------------------------------------------

function sideStr(s: Side): string {
  return s === Side.Buy ? "Buy" : "Sell";
}

function timeInForceStr(tif?: TimeInForce): "Gtc" | "Ioc" | "Fok" {
  switch (tif) {
    case TimeInForce.Ioc:
      return "Ioc";
    case TimeInForce.Fok:
      return "Fok";
    default:
      return "Gtc";
  }
}

function outcomeStr(o: Outcome): string {
  switch (o) {
    case Outcome.Yes:
      return "Yes";
    case Outcome.No:
      return "No";
    case Outcome.Void:
      return "Void";
  }
}

/**
 * BE-54: encode an `EventOracleSource` to its rmp-serde wire form.
 *
 * The Rust enum encoding (from `rmp_serde` defaults) is:
 *   - `RelayerAttested` (unit variant) → bare msgpack string `"RelayerAttested"`.
 *   - `UnderlyingPriceVsStrike { strike_price, comparison }` (struct variant)
 *       → fixmap(1) `{"UnderlyingPriceVsStrike": [strikePrice, comparisonStr]}`.
 *     Note: rmp-serde represents struct variants positionally by default,
 *     so the inner value is an ARRAY of the field values in declaration
 *     order, not a map of name->value.
 *   - `MarketOracle { market, strike_price, comparison }`
 *       → `{"MarketOracle": [market, strikePrice, comparisonStr]}`.
 *
 * `undefined` (the SDK's representation of "no oracle source set") is
 * sent as msgpack `nil` so the engine's `serde(default)` treats it as
 * `Option::None` — equivalent to RelayerAttested for the resolver.
 */
function encodeEventOracleSource(src: EventOracleSource | undefined): unknown {
  if (src === undefined) return null;
  switch (src.kind) {
    case "RelayerAttested":
      return "RelayerAttested";
    case "UnderlyingPriceVsStrike":
      return {
        UnderlyingPriceVsStrike: [
          src.strikePrice,
          priceComparisonStr(src.comparison),
        ],
      };
    case "MarketOracle":
      return {
        MarketOracle: [
          src.market,
          src.strikePrice,
          priceComparisonStr(src.comparison),
        ],
      };
  }
}

/** Inverse of `encodeEventOracleSource` — used by the decoder. */
function decodeEventOracleSource(v: unknown): EventOracleSource | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") {
    if (v === "RelayerAttested") return { kind: "RelayerAttested" };
    throw new Error(`unknown EventOracleSource string variant: ${v}`);
  }
  if (typeof v === "object" && v !== null) {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length !== 1) {
      throw new Error(
        `EventOracleSource must be a single-key map, got keys [${keys.join(",")}]`,
      );
    }
    const variant = keys[0];
    const fields = obj[variant];
    if (!Array.isArray(fields)) {
      throw new Error(
        `EventOracleSource fields for ${variant} must be a positional array`,
      );
    }
    if (variant === "UnderlyingPriceVsStrike") {
      return {
        kind: "UnderlyingPriceVsStrike",
        strikePrice: toBigInt(fields[0]),
        comparison: parsePriceComparison(fields[1]),
      };
    }
    if (variant === "MarketOracle") {
      return {
        kind: "MarketOracle",
        market: Number(toBigInt(fields[0])),
        strikePrice: toBigInt(fields[1]),
        comparison: parsePriceComparison(fields[2]),
      };
    }
    throw new Error(`unknown EventOracleSource variant: ${variant}`);
  }
  throw new Error(`unexpected EventOracleSource shape: ${typeof v}`);
}

/** Map the SDK's `PriceComparison` string union to its wire representation. */
function priceComparisonStr(c: PriceComparison): string {
  // The SDK union and the Rust enum variants are name-identical.
  return c;
}

/** Inverse of `priceComparisonStr`. */
function parsePriceComparison(v: unknown): PriceComparison {
  switch (v) {
    case "GreaterThan":
      return "GreaterThan";
    case "LessThan":
      return "LessThan";
    case "GreaterThanOrEqual":
      return "GreaterThanOrEqual";
    case "LessThanOrEqual":
      return "LessThanOrEqual";
    default:
      throw new Error(`invalid PriceComparison: ${String(v)}`);
  }
}

/** Ensure an owner/signer field is a Uint8Array (not a hex string). */
function toBytes(v: Uint8Array | string): Uint8Array {
  if (v instanceof Uint8Array) return v;
  const hex = v.startsWith("0x") ? v.slice(2) : v;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Convert a byte array to a regular `number[]` for msgpack encoding.
 *
 * The exchange-core action structs use plain Rust byte arrays
 * (`[u8; 20]`, `[u8; 32]`, `Vec<u8>`) **without** `serde_bytes`. rmp-serde
 * default-encodes those via `serialize_seq`, which produces a msgpack
 * array of u8 elements (each byte either a positive fixint or a `cc XX`
 * uint8). Encoding the same field as a msgpack `bin` blob (which is what
 * `@msgpack/msgpack` does for `Uint8Array`) produces different bytes and
 * breaks signature verification on any code path that re-encodes the
 * action — including the api-gateway's POST /exchange handler.
 *
 * This helper passes the bytes as `number[]`, which @msgpack/msgpack
 * encodes as a msgpack array — matching rmp-serde byte for byte.
 *
 * Envelope fields (pubkey, signature) are NOT affected because the
 * Rust `WireTxEnvelope` uses `#[serde(with = "serde_bytes")]` for
 * those, so they really are encoded as msgpack `bin` and the SDK
 * should keep using `Uint8Array` for them.
 */
function toByteSeq(v: Uint8Array | string): number[] {
  return Array.from(toBytes(v));
}

function encodePayload(action: Action): [ActionTypeValue, unknown[]] {
  switch (action.type) {
    case "PlaceOrder": {
      const d = action.data;
      return [
        ActionType.PlaceOrder,
        [
          d.market,
          toByteSeq(d.owner),
          sideStr(d.side),
          d.price,
          d.quantity,
          d.clientOrderId ?? null,
          d.postOnly ?? false,
          d.reduceOnly ?? false,
          // timeInForce at index 8; serde encodes unit variants as strings.
          timeInForceStr(d.timeInForce),
        ],
      ];
    }
    case "CancelOrder": {
      const d = action.data;
      return [ActionType.CancelOrder, [d.orderId, toByteSeq(d.owner)]];
    }
    case "CancelClientOrder": {
      const d = action.data;
      return [
        ActionType.CancelClientOrder,
        [toByteSeq(d.owner), d.clientOrderId],
      ];
    }
    case "CancelAllOrders": {
      const d = action.data;
      return [
        ActionType.CancelAllOrders,
        [toByteSeq(d.owner), d.market ?? null],
      ];
    }
    case "CancelReplaceOrder": {
      const d = action.data;
      return [
        ActionType.CancelReplaceOrder,
        [
          toByteSeq(d.owner),
          d.cancelOrderId ?? null,
          d.cancelClientOrderId ?? null,
          d.market,
          sideStr(d.side),
          d.price,
          d.quantity,
          d.clientOrderId ?? null,
          d.postOnly ?? false,
          d.reduceOnly ?? false,
          timeInForceStr(d.timeInForce),
        ],
      ];
    }
    case "AmendOrder": {
      const d = action.data;
      return [
        ActionType.AmendOrder,
        [
          toByteSeq(d.owner),
          d.orderId,
          d.newPrice ?? null,
          d.newQuantity ?? null,
        ],
      ];
    }
    case "OracleUpdate": {
      const d = action.data;
      // Field order MUST match Rust: market, price, signer, publish_time_ms.
      // `publish_time_ms` added 2026-04-23 (B3) — replay guard on the
      // relayer-signed oracle feed.
      return [
        ActionType.OracleUpdate,
        [d.market, d.price, toByteSeq(d.signer), d.publishTimeMs],
      ];
    }
    case "MarketOrder": {
      const d = action.data;
      return [
        ActionType.MarketOrder,
        [
          d.market,
          toByteSeq(d.owner),
          sideStr(d.side),
          d.quantity,
          d.clientOrderId ?? null,
        ],
      ];
    }
    case "Deposit": {
      const d = action.data;
      // Audit B1 (2026-04-23): signer field required. Engine enforces
      // envelope pubkey's derived address === signer AND signer on the
      // relayer allowlist.
      return [
        ActionType.Deposit,
        [toByteSeq(d.owner), d.amount, toByteSeq(d.signer)],
      ];
    }
    case "Withdraw": {
      const d = action.data;
      // Audit B2 (2026-04-23): same relayer gate as Deposit.
      return [
        ActionType.Withdraw,
        [toByteSeq(d.owner), d.amount, toByteSeq(d.signer)],
      ];
    }
    case "CreateMarket": {
      const d = action.data;
      // pool_id (final field) is `serde(default)` on the engine side, so
      // omitting it from the wire-bytes lets old SDK clients keep working
      // — but if the caller sets a non-zero poolId we MUST include it.
      // Always include for forward-compatibility once any SDK build can
      // address pools other than 0.
      return [
        ActionType.CreateMarket,
        [
          d.market,
          d.imBps,
          d.mmBps,
          d.takerFeeBps,
          d.makerFeeBps,
          toByteSeq(d.signer),
          d.fundingIntervalMs,
          d.maxFundingRateBps,
          d.poolId ?? 0,
        ],
      ];
    }
    case "WithdrawRequest": {
      const d = action.data;
      return [
        ActionType.WithdrawRequest,
        [toByteSeq(d.owner), d.amount, toByteSeq(d.solanaDestination)],
      ];
    }
    case "ConfirmDeposit": {
      const d = action.data;
      return [
        ActionType.ConfirmDeposit,
        [
          toByteSeq(d.owner),
          d.amount,
          toByteSeq(d.solanaTxSig),
          toByteSeq(d.signer),
        ],
      ];
    }
    case "ConfirmWithdrawal": {
      const d = action.data;
      return [
        ActionType.ConfirmWithdrawal,
        [d.withdrawalId, toByteSeq(d.solanaTxSig), toByteSeq(d.signer)],
      ];
    }
    case "FailWithdrawal": {
      const d = action.data;
      return [
        ActionType.FailWithdrawal,
        [d.withdrawalId, d.reason, toByteSeq(d.signer)],
      ];
    }
    case "ApproveAgent": {
      const d = action.data;
      return [
        ActionType.ApproveAgent,
        [toByteSeq(d.owner), toByteSeq(d.agentPubkey)],
      ];
    }
    case "RevokeAgent": {
      const d = action.data;
      return [
        ActionType.RevokeAgent,
        [toByteSeq(d.owner), toByteSeq(d.agentPubkey)],
      ];
    }
    case "CreateImpactMarket": {
      const d = action.data;
      return [
        ActionType.CreateImpactMarket,
        [
          d.impactMarketId,
          d.underlyingMarket,
          d.childMarketBase,
          d.question,
          d.deadlineMs,
          d.resolutionWindowMs,
          d.imBps,
          d.mmBps,
          d.takerFeeBps,
          d.makerFeeBps,
          d.fundingIntervalMs,
          d.maxFundingRateBps,
          toByteSeq(d.signer),
          // BE-54: oracle_source at position 13. `null` (msgpack nil) is
          // the wire shape rmp-serde emits for `Option::None`, which
          // decodes back to `None` (= RelayerAttested behavior). Old SDK
          // clients sending a 13-element array still decode cleanly via
          // the engine's `serde(default)`.
          encodeEventOracleSource(d.oracleSource),
        ],
      ];
    }
    case "ResolveEvent": {
      const d = action.data;
      return [
        ActionType.ResolveEvent,
        [d.impactMarketId, outcomeStr(d.outcome), toByteSeq(d.signer)],
      ];
    }
    case "UpdateMarketFees": {
      const d = action.data;
      // Field order MUST match the Rust struct: market, signer,
      // taker_fee_bps, maker_fee_bps, max_funding_rate_bps,
      // funding_interval_ms, max_position_size, default_ttl_ms,
      // net_delta_margin, tick_size, lot_size, primary_oracle_signer,
      // oracle_staleness_ms, mark_source_mode, max_mark_spread_bps,
      // cex_composite_staleness_ms, partial_liquidation_enabled,
      // fee_tiers.
      // Each optional field encodes as its value or null (rmp-serde
      // accepts null for `Option<T>` via serde(default) / Option
      // deserialization). New fields are appended at the end.
      return [
        ActionType.UpdateMarketFees,
        [
          d.market,
          toByteSeq(d.signer),
          d.takerFeeBps ?? null,
          d.makerFeeBps ?? null,
          d.maxFundingRateBps ?? null,
          d.fundingIntervalMs ?? null,
          d.maxPositionSize ?? null,
          d.defaultTtlMs ?? null,
          d.netDeltaMargin ?? null,
          d.tickSize ?? null,
          d.lotSize ?? null,
          d.primaryOracleSigner ? toByteSeq(d.primaryOracleSigner) : null,
          d.oracleStalenessMs ?? null,
          d.markSourceMode ?? null,
          d.maxMarkSpreadBps ?? null,
          d.cexCompositeStalenessMs ?? null,
          d.partialLiquidationEnabled ?? null,
          d.feeTiers ? d.feeTiers.map(encodeFeeTier) : null,
        ],
      ];
    }
    case "SetAccountFeeOverride": {
      const d = action.data;
      // Field order MUST match the Rust struct: account, taker_fee_bps,
      // maker_fee_bps, signer, seq. BE-46. The trailing `seq` is the
      // BE-46.2 replay-guard sequence (Ramon's 2026-05-03 review).
      return [
        ActionType.SetAccountFeeOverride,
        [
          toByteSeq(d.account),
          d.takerFeeBps,
          d.makerFeeBps,
          toByteSeq(d.signer),
          d.seq,
        ],
      ];
    }
    case "RunLiquidationSweep": {
      const d = action.data;
      return [ActionType.RunLiquidationSweep, [toByteSeq(d.signer)]];
    }
    case "RunFundingTick": {
      const d = action.data;
      return [ActionType.RunFundingTick, [d.market, toByteSeq(d.signer)]];
    }
    case "SetUserMarketLeverage": {
      const d = action.data;
      return [
        ActionType.SetUserMarketLeverage,
        [toByteSeq(d.owner), d.market, d.userImBps],
      ];
    }
    case "FailDeposit": {
      // BE-40: positional [solanaSignature, reason, signer]. The reason
      // enum is encoded as the variant name (string) — that's what
      // rmp-serde does by default for fieldless enums.
      const d = action.data;
      return [
        ActionType.FailDeposit,
        [
          toByteSeq(d.solanaSignature),
          failDepositReasonStr(d.reason),
          toByteSeq(d.signer),
        ],
      ];
    }
    case "ClosePosition": {
      const d = action.data;
      return [ActionType.ClosePosition, [d.market, toByteSeq(d.owner)]];
    }
  }
}

/**
 * Map the SDK's `FailDepositReason` string union to the wire string the
 * Rust enum (un-tagged variant name) expects. Stays a one-to-one map so
 * the encoder/decoder cannot drift from the Rust definition silently.
 */
function failDepositReasonStr(r: FailDepositReason): string {
  switch (r) {
    case "MalformedTx":
      return "MalformedTx";
    case "UnsupportedToken":
      return "UnsupportedToken";
    case "BelowMinimum":
      return "BelowMinimum";
    case "Other":
      return "Other";
  }
}

/** Inverse of `failDepositReasonStr` — used by the decoder. */
function parseFailDepositReason(v: unknown): FailDepositReason {
  switch (v) {
    case "MalformedTx":
      return "MalformedTx";
    case "UnsupportedToken":
      return "UnsupportedToken";
    case "BelowMinimum":
      return "BelowMinimum";
    case "Other":
      return "Other";
    default:
      throw new Error(`invalid FailDepositReason: ${String(v)}`);
  }
}

// ---------------------------------------------------------------------------
// Payload decoding
// ---------------------------------------------------------------------------

function parseSide(s: unknown): Side {
  if (s === "Buy" || s === Side.Buy) return Side.Buy;
  return Side.Sell;
}

function parseTimeInForce(tif: unknown): TimeInForce {
  if (tif === "Ioc" || tif === TimeInForce.Ioc) return TimeInForce.Ioc;
  if (tif === "Fok" || tif === TimeInForce.Fok) return TimeInForce.Fok;
  return TimeInForce.Gtc;
}

// Helper: u64 fields may decode as either Number (small fixint) or BigInt
// (uint64), depending on what the encoder chose. Always normalize to bigint
// so the SDK's external types stay stable. Nullable variant for optional
// client_order_id.
function bi(v: unknown): bigint {
  return toBigInt(v);
}
function biOrNull(v: unknown): bigint | null {
  return v === null || v === undefined ? null : toBigInt(v);
}

/**
 * Decode a byte field that the engine encodes as msgpack array-of-u8 (no
 * `serde_bytes` annotation). The decoder gives us back a `number[]`; we
 * convert to `Uint8Array` so SDK consumers see the same type they pass in.
 *
 * Defensive: also accepts a `Uint8Array` directly (in case the wire bytes
 * came from a future SDK that uses `bin` encoding) so existing tests with
 * fixed wire snapshots keep working.
 */
function bytesField(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  throw new Error(`expected bytes/number[], got ${typeof v}`);
}

function decodePayload(actionType: ActionTypeValue, f: unknown[]): Action {
  switch (actionType) {
    case ActionType.PlaceOrder:
      return {
        type: "PlaceOrder",
        data: {
          market: f[0] as number,
          owner: bytesField(f[1]),
          side: parseSide(f[2]),
          price: bi(f[3]),
          quantity: bi(f[4]),
          clientOrderId: biOrNull(f[5]),
          // postOnly + reduceOnly added with the integration suite's
          // S06/S09 surfaces. Old records (6-element arrays) decode
          // with both flags = false; new records (8-element) carry
          // the explicit values.
          // timeInForce added at index 8 (BE-XX). Old records decode
          // as Gtc (0) via length-guarded fallback.
          postOnly: f.length > 6 && f[6] === true,
          reduceOnly: f.length > 7 && f[7] === true,
          timeInForce: f.length > 8 ? parseTimeInForce(f[8]) : TimeInForce.Gtc,
        },
      };
    case ActionType.CancelOrder:
      return {
        type: "CancelOrder",
        data: {
          orderId: bi(f[0]),
          owner: bytesField(f[1]),
        },
      };
    case ActionType.CancelClientOrder:
      return {
        type: "CancelClientOrder",
        data: {
          owner: bytesField(f[0]),
          clientOrderId: bi(f[1]),
        },
      };
    case ActionType.CancelAllOrders:
      return {
        type: "CancelAllOrders",
        data: {
          owner: bytesField(f[0]),
          market:
            f.length > 1 && f[1] !== null && f[1] !== undefined
              ? Number(bi(f[1]))
              : null,
        },
      };
    case ActionType.CancelReplaceOrder:
      return {
        type: "CancelReplaceOrder",
        data: {
          owner: bytesField(f[0]),
          cancelOrderId: biOrNull(f[1]),
          cancelClientOrderId: biOrNull(f[2]),
          market: f[3] as number,
          side: parseSide(f[4]),
          price: bi(f[5]),
          quantity: bi(f[6]),
          clientOrderId: biOrNull(f[7]),
          postOnly: f.length > 8 && f[8] === true,
          reduceOnly: f.length > 9 && f[9] === true,
          timeInForce:
            f.length > 10 ? parseTimeInForce(f[10]) : TimeInForce.Gtc,
        },
      };
    case ActionType.AmendOrder:
      return {
        type: "AmendOrder",
        data: {
          owner: bytesField(f[0]),
          orderId: bi(f[1]),
          newPrice: biOrNull(f[2]),
          newQuantity: biOrNull(f[3]),
        },
      };
    case ActionType.OracleUpdate:
      return {
        type: "OracleUpdate",
        data: {
          market: f[0] as number,
          price: bi(f[1]),
          signer: bytesField(f[2]),
          // publish_time_ms added 2026-04-23 (B3). Legacy records
          // written before that field existed decode as nil via
          // serde's `#[serde(default)]`, which is `null` on the
          // msgpack side. Map both shapes (absent, null) to 0n.
          publishTimeMs:
            f.length > 3 && f[3] !== null && f[3] !== undefined ? bi(f[3]) : 0n,
        },
      };
    case ActionType.MarketOrder:
      return {
        type: "MarketOrder",
        data: {
          market: f[0] as number,
          owner: bytesField(f[1]),
          side: parseSide(f[2]),
          quantity: bi(f[3]),
          clientOrderId: biOrNull(f[4]),
        },
      };
    case ActionType.Deposit:
      return {
        type: "Deposit",
        data: {
          owner: bytesField(f[0]),
          amount: bi(f[1]),
          // Audit B1: signer required. Legacy txs that pre-date B1 serialized
          // only owner+amount — tolerate absence by defaulting to 20 zero bytes
          // so decoding never throws; the engine rejects such txs anyway.
          signer: f.length > 2 ? bytesField(f[2]) : new Uint8Array(20),
        },
      };
    case ActionType.Withdraw:
      return {
        type: "Withdraw",
        data: {
          owner: bytesField(f[0]),
          amount: bi(f[1]),
          // Audit B2: same defensive decode as Deposit.
          signer: f.length > 2 ? bytesField(f[2]) : new Uint8Array(20),
        },
      };
    case ActionType.CreateMarket:
      return {
        type: "CreateMarket",
        data: {
          market: f[0] as number,
          imBps: f[1] as number,
          mmBps: f[2] as number,
          takerFeeBps: f[3] as number,
          makerFeeBps: f[4] as number,
          signer: bytesField(f[5]),
          fundingIntervalMs: bi(f[6]),
          maxFundingRateBps: f[7] as number,
          // poolId at index 8 — defensive on length so wire records
          // emitted by older SDK builds (8 fields) still decode cleanly
          // and land in pool 0, matching the engine's `serde(default)`.
          poolId: f.length > 8 ? (f[8] as number) : 0,
        },
      };
    case ActionType.WithdrawRequest:
      return {
        type: "WithdrawRequest",
        data: {
          owner: bytesField(f[0]),
          amount: bi(f[1]),
          solanaDestination: bytesField(f[2]),
        },
      };
    case ActionType.ConfirmDeposit:
      return {
        type: "ConfirmDeposit",
        data: {
          owner: bytesField(f[0]),
          amount: bi(f[1]),
          solanaTxSig: bytesField(f[2]),
          signer: bytesField(f[3]),
        },
      };
    case ActionType.ConfirmWithdrawal:
      return {
        type: "ConfirmWithdrawal",
        data: {
          withdrawalId: bi(f[0]),
          solanaTxSig: bytesField(f[1]),
          signer: bytesField(f[2]),
        },
      };
    case ActionType.FailWithdrawal:
      return {
        type: "FailWithdrawal",
        data: {
          withdrawalId: bi(f[0]),
          reason: f[1] as string,
          signer: bytesField(f[2]),
        },
      };
    case ActionType.ApproveAgent:
      return {
        type: "ApproveAgent",
        data: {
          owner: bytesField(f[0]),
          agentPubkey: bytesField(f[1]),
        },
      };
    case ActionType.RevokeAgent:
      return {
        type: "RevokeAgent",
        data: {
          owner: bytesField(f[0]),
          agentPubkey: bytesField(f[1]),
        },
      };
    case ActionType.CreateImpactMarket:
      return {
        type: "CreateImpactMarket",
        data: {
          impactMarketId: Number(bi(f[0])),
          underlyingMarket: Number(bi(f[1])),
          childMarketBase: Number(bi(f[2])),
          question: String(f[3]),
          deadlineMs: bi(f[4]),
          resolutionWindowMs: bi(f[5]),
          imBps: Number(bi(f[6])),
          mmBps: Number(bi(f[7])),
          takerFeeBps: Number(bi(f[8])),
          makerFeeBps: Number(bi(f[9])),
          fundingIntervalMs: bi(f[10]),
          maxFundingRateBps: Number(bi(f[11])),
          signer: bytesField(f[12]),
          // BE-54: oracleSource at index 13. Length-tolerant so wire
          // records emitted by pre-BE-54 SDKs (13-element arrays) still
          // decode cleanly — the missing field defaults to undefined,
          // mirroring the engine's `serde(default)` for `Option::None`.
          oracleSource:
            f.length > 13 ? decodeEventOracleSource(f[13]) : undefined,
        },
      };
    case ActionType.ResolveEvent:
      return {
        type: "ResolveEvent",
        data: {
          impactMarketId: Number(bi(f[0])),
          outcome: parseOutcome(f[1]),
          signer: bytesField(f[2]),
        },
      };
    case ActionType.UpdateMarketFees: {
      // Field order mirrors the Rust struct. Each optional u32/u64 is
      // either null (unchanged) or a number/bigint from msgpack. The
      // length-guarded reads at indices 9 and 10 (BE-31 Phase A
      // additions) let older 9-element wire records keep decoding
      // cleanly — old SDK builds emit 9 fields, new SDK builds emit 11.
      const optNum = (v: unknown): number | null =>
        v === null || v === undefined ? null : Number(bi(v));
      const optBig = (v: unknown): bigint | null =>
        v === null || v === undefined ? null : bi(v);
      const optBool = (v: unknown): boolean | null =>
        v === null || v === undefined ? null : Boolean(v);
      const optBytes = (v: unknown): Address | null =>
        v === null || v === undefined ? null : bytesField(v);
      const markSourceMode = f.length > 13 ? optNum(f[13]) : null;
      // Cast back to the union shape exported on `UpdateMarketFees`.
      const markSourceModeTyped =
        markSourceMode === 0 || markSourceMode === 1
          ? (markSourceMode as 0 | 1)
          : null;
      return {
        type: "UpdateMarketFees",
        data: {
          market: Number(bi(f[0])),
          signer: bytesField(f[1]),
          takerFeeBps: optNum(f[2]),
          makerFeeBps: optNum(f[3]),
          maxFundingRateBps: optNum(f[4]),
          fundingIntervalMs: optBig(f[5]),
          maxPositionSize: optBig(f[6]),
          defaultTtlMs: optBig(f[7]),
          netDeltaMargin: optBool(f[8]),
          tickSize: f.length > 9 ? optBig(f[9]) : null,
          lotSize: f.length > 10 ? optBig(f[10]) : null,
          primaryOracleSigner: f.length > 11 ? optBytes(f[11]) : null,
          oracleStalenessMs: f.length > 12 ? optBig(f[12]) : null,
          markSourceMode: markSourceModeTyped,
          maxMarkSpreadBps: f.length > 14 ? optNum(f[14]) : null,
          cexCompositeStalenessMs: f.length > 15 ? optBig(f[15]) : null,
          partialLiquidationEnabled: f.length > 16 ? optBool(f[16]) : null,
          feeTiers: f.length > 17 ? decodeFeeTiers(f[17]) : null,
        },
      };
    }
    case ActionType.SetAccountFeeOverride:
      // Field order mirrors the Rust struct: account, taker_fee_bps,
      // maker_fee_bps, signer, seq. BE-46 / BE-46.2. The trailing
      // `seq` is the replay-guard sequence; older payloads written
      // before BE-46.2 are absent here and decode as 0n (which the
      // engine rejects loudly via FeeOverrideStaleSeq, surfacing the
      // missing-field bug rather than silently accepting).
      return {
        type: "SetAccountFeeOverride",
        data: {
          account: bytesField(f[0]),
          takerFeeBps: Number(bi(f[1])),
          makerFeeBps: Number(bi(f[2])),
          signer: bytesField(f[3]),
          seq: f[4] === undefined ? 0n : bi(f[4]),
        },
      };
    case ActionType.RunLiquidationSweep:
      return {
        type: "RunLiquidationSweep",
        data: { signer: bytesField(f[0]) },
      };
    case ActionType.RunFundingTick:
      return {
        type: "RunFundingTick",
        data: {
          market: f[0] as number,
          signer: bytesField(f[1]),
        },
      };
    case ActionType.SetUserMarketLeverage:
      return {
        type: "SetUserMarketLeverage",
        data: {
          owner: bytesField(f[0]),
          market: Number(bi(f[1])),
          userImBps: Number(bi(f[2])),
        },
      };
    case ActionType.FailDeposit:
      return {
        type: "FailDeposit",
        data: {
          solanaSignature: bytesField(f[0]),
          reason: parseFailDepositReason(f[1]),
          signer: bytesField(f[2]),
        },
      };
    case ActionType.ClosePosition:
      return {
        type: "ClosePosition",
        data: {
          market: f[0] as number,
          owner: bytesField(f[1]),
        },
      };
    default:
      throw new Error(`unknown action_type: ${actionType}`);
  }
}

function parseOutcome(v: unknown): Outcome {
  if (v === "Yes" || v === Outcome.Yes) return Outcome.Yes;
  if (v === "No" || v === Outcome.No) return Outcome.No;
  if (v === "Void" || v === Outcome.Void) return Outcome.Void;
  throw new Error(`invalid outcome: ${String(v)}`);
}
