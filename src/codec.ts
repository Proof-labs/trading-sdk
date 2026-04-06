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

const encoder = new Encoder({ useBigInt64: true });
const decoder = new Decoder({ useBigInt64: true });

function encode(value: unknown): Uint8Array {
  return encoder.encode(value);
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
  return encode([2, actionType, seq, payloadBytes, pubkey, signature]) as Uint8Array;
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
  return encode([2, actionType, seq, payloadBytes, pubkey, signature]) as Uint8Array;
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
  const seq = envelope[2] as bigint;
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

function encodePayload(action: Action): [ActionTypeValue, unknown[]] {
  switch (action.type) {
    case "PlaceOrder": {
      const d = action.data;
      return [
        ActionType.PlaceOrder,
        [d.market, toBytes(d.owner), sideStr(d.side), d.price, d.quantity, d.clientOrderId ?? null],
      ];
    }
    case "CancelOrder": {
      const d = action.data;
      return [ActionType.CancelOrder, [d.orderId, toBytes(d.owner)]];
    }
    case "OracleUpdate": {
      const d = action.data;
      return [ActionType.OracleUpdate, [d.market, d.price, toBytes(d.signer)]];
    }
    case "MarketOrder": {
      const d = action.data;
      return [
        ActionType.MarketOrder,
        [d.market, toBytes(d.owner), sideStr(d.side), d.quantity, d.clientOrderId ?? null],
      ];
    }
    case "Deposit": {
      const d = action.data;
      return [ActionType.Deposit, [toBytes(d.owner), d.amount]];
    }
    case "Withdraw": {
      const d = action.data;
      return [ActionType.Withdraw, [toBytes(d.owner), d.amount]];
    }
    case "CreateMarket": {
      const d = action.data;
      return [
        ActionType.CreateMarket,
        [d.market, d.imBps, d.mmBps, d.takerFeeBps, d.makerFeeBps, toBytes(d.signer), d.fundingIntervalMs, d.maxFundingRateBps],
      ];
    }
    case "WithdrawRequest": {
      const d = action.data;
      return [ActionType.WithdrawRequest, [toBytes(d.owner), d.amount, d.solanaDestination]];
    }
    case "ConfirmDeposit": {
      const d = action.data;
      return [ActionType.ConfirmDeposit, [toBytes(d.owner), d.amount, d.solanaTxSig, toBytes(d.signer)]];
    }
    case "ConfirmWithdrawal": {
      const d = action.data;
      return [ActionType.ConfirmWithdrawal, [d.withdrawalId, d.solanaTxSig, toBytes(d.signer)]];
    }
    case "FailWithdrawal": {
      const d = action.data;
      return [ActionType.FailWithdrawal, [d.withdrawalId, d.reason, toBytes(d.signer)]];
    }
    case "ApproveAgent": {
      const d = action.data;
      return [ActionType.ApproveAgent, [toBytes(d.owner), toBytes(d.agentPubkey)]];
    }
    case "RevokeAgent": {
      const d = action.data;
      return [ActionType.RevokeAgent, [toBytes(d.owner), toBytes(d.agentPubkey)]];
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

function decodePayload(actionType: ActionTypeValue, f: unknown[]): Action {
  switch (actionType) {
    case ActionType.PlaceOrder:
      return {
        type: "PlaceOrder",
        data: {
          market: f[0] as number,
          owner: f[1] as Uint8Array,
          side: parseSide(f[2]),
          price: f[3] as bigint,
          quantity: f[4] as bigint,
          clientOrderId: f[5] as bigint | null,
        },
      };
    case ActionType.CancelOrder:
      return {
        type: "CancelOrder",
        data: {
          orderId: f[0] as bigint,
          owner: f[1] as Uint8Array,
        },
      };
    case ActionType.OracleUpdate:
      return {
        type: "OracleUpdate",
        data: {
          market: f[0] as number,
          price: f[1] as bigint,
          signer: f[2] as Uint8Array,
        },
      };
    case ActionType.MarketOrder:
      return {
        type: "MarketOrder",
        data: {
          market: f[0] as number,
          owner: f[1] as Uint8Array,
          side: parseSide(f[2]),
          quantity: f[3] as bigint,
          clientOrderId: f[4] as bigint | null,
        },
      };
    case ActionType.Deposit:
      return {
        type: "Deposit",
        data: {
          owner: f[0] as Uint8Array,
          amount: f[1] as bigint,
        },
      };
    case ActionType.Withdraw:
      return {
        type: "Withdraw",
        data: {
          owner: f[0] as Uint8Array,
          amount: f[1] as bigint,
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
          signer: f[5] as Uint8Array,
          fundingIntervalMs: f[6] as bigint,
          maxFundingRateBps: f[7] as number,
        },
      };
    case ActionType.WithdrawRequest:
      return {
        type: "WithdrawRequest",
        data: {
          owner: f[0] as Uint8Array,
          amount: f[1] as bigint,
          solanaDestination: f[2] as Uint8Array,
        },
      };
    case ActionType.ConfirmDeposit:
      return {
        type: "ConfirmDeposit",
        data: {
          owner: f[0] as Uint8Array,
          amount: f[1] as bigint,
          solanaTxSig: f[2] as Uint8Array,
          signer: f[3] as Uint8Array,
        },
      };
    case ActionType.ConfirmWithdrawal:
      return {
        type: "ConfirmWithdrawal",
        data: {
          withdrawalId: f[0] as bigint,
          solanaTxSig: f[1] as Uint8Array,
          signer: f[2] as Uint8Array,
        },
      };
    case ActionType.FailWithdrawal:
      return {
        type: "FailWithdrawal",
        data: {
          withdrawalId: f[0] as bigint,
          reason: f[1] as string,
          signer: f[2] as Uint8Array,
        },
      };
    case ActionType.ApproveAgent:
      return {
        type: "ApproveAgent",
        data: {
          owner: f[0] as Uint8Array,
          agentPubkey: f[1] as Uint8Array,
        },
      };
    case ActionType.RevokeAgent:
      return {
        type: "RevokeAgent",
        data: {
          owner: f[0] as Uint8Array,
          agentPubkey: f[1] as Uint8Array,
        },
      };
    default:
      throw new Error(`unknown action_type: ${actionType}`);
  }
}
