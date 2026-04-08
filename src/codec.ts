import { Encoder, Decoder } from "@msgpack/msgpack";
import {
  type Action,
  ActionType,
  type ActionTypeValue,
  Side,
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
const U32_MAX_BIGINT = 0xFFFF_FFFFn; // 2^32 - 1

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

// ---------------------------------------------------------------------------
// V1 encoding (legacy, unsigned — kept for backward compat)
// ---------------------------------------------------------------------------

/** Encode an action + sequence number into V1 wire bytes (unsigned). */
export function encodeTx(action: Action, seq: bigint): Uint8Array {
  const [actionType, payload] = encodePayload(action);
  const payloadBytes = encode(payload);
  return encode([1, actionType, seq, payloadBytes]) as Uint8Array;
}

// ---------------------------------------------------------------------------
// V2 encoding (signed)
// ---------------------------------------------------------------------------

/**
 * Encode a V2 signed envelope.
 * Wire: [version=2, actionType, seq, payload, pubkey(32), signature(64)]
 */
export function encodeTxV2(
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
 * Sign an action and encode as V2 wire bytes.
 * This is the primary function the frontend should use.
 */
export function signAndEncode(
  action: Action,
  seq: bigint,
  privateKey: Uint8Array,
): Uint8Array {
  const [actionType, payload] = encodePayload(action);
  const payloadBytes = encode(payload);
  const msg = signingMessage(actionType, seq, payloadBytes);
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

/** Decode wire bytes into an action + sequence number. Works for both V1 and V2. */
export function decodeTx(bytes: Uint8Array): {
  action: Action;
  seq: bigint;
  version: number;
  pubkey?: Uint8Array;
  signature?: Uint8Array;
} {
  const envelope = decode(bytes) as unknown[];
  const version = envelope[0] as number;

  if (version !== 1 && version !== 2) {
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

  if (version === 2) {
    return {
      action,
      seq,
      version,
      pubkey: envelope[4] as Uint8Array,
      signature: envelope[5] as Uint8Array,
    };
  }

  return { action, seq, version };
}

// ---------------------------------------------------------------------------
// Payload encoding — field order MUST match Rust struct definitions
// ---------------------------------------------------------------------------

function sideStr(s: Side): string {
  return s === Side.Buy ? "Buy" : "Sell";
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
 * Rust `WireTxEnvelopeV2` uses `#[serde(with = "serde_bytes")]` for
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
        ],
      ];
    }
    case "CancelOrder": {
      const d = action.data;
      return [ActionType.CancelOrder, [d.orderId, toByteSeq(d.owner)]];
    }
    case "OracleUpdate": {
      const d = action.data;
      return [ActionType.OracleUpdate, [d.market, d.price, toByteSeq(d.signer)]];
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
      return [ActionType.Deposit, [toByteSeq(d.owner), d.amount]];
    }
    case "Withdraw": {
      const d = action.data;
      return [ActionType.Withdraw, [toByteSeq(d.owner), d.amount]];
    }
    case "CreateMarket": {
      const d = action.data;
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
  }
}

// ---------------------------------------------------------------------------
// Payload decoding
// ---------------------------------------------------------------------------

function parseSide(s: unknown): Side {
  if (s === "Buy" || s === Side.Buy) return Side.Buy;
  return Side.Sell;
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
    case ActionType.OracleUpdate:
      return {
        type: "OracleUpdate",
        data: {
          market: f[0] as number,
          price: bi(f[1]),
          signer: bytesField(f[2]),
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
        },
      };
    case ActionType.Withdraw:
      return {
        type: "Withdraw",
        data: {
          owner: bytesField(f[0]),
          amount: bi(f[1]),
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
    default:
      throw new Error(`unknown action_type: ${actionType}`);
  }
}
