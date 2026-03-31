import { Encoder, Decoder } from "@msgpack/msgpack";
import {
  Action,
  ActionType,
  type ActionTypeValue,
  type PlaceOrder,
  type CancelOrder,
  type OracleUpdate,
  type ExchangeEvent,
  Side,
} from "./types.js";

const CURRENT_VERSION = 1;

// Configure msgpack to handle BigInt as u64
const encoder = new Encoder({ useBigInt64: true });
const decoder = new Decoder({ useBigInt64: true });

function encode(value: unknown): Uint8Array {
  return encoder.encode(value);
}

function decode(bytes: Uint8Array): unknown {
  return decoder.decode(bytes);
}

/** Encode an action + sequence number into wire bytes. */
export function encodeTx(action: Action, seq: bigint): Uint8Array {
  const [actionType, payload] = encodePayload(action);
  const payloadBytes = encode(payload);
  return encode([CURRENT_VERSION, actionType, seq, payloadBytes]) as Uint8Array;
}

/** Peek at the action_type byte without full decode. */
export function peekActionType(bytes: Uint8Array): ActionTypeValue | null {
  try {
    const envelope = decode(bytes) as [number, number, bigint, Uint8Array];
    return envelope[1] as ActionTypeValue;
  } catch {
    return null;
  }
}

/** Decode wire bytes into an action + sequence number. */
export function decodeTx(bytes: Uint8Array): { action: Action; seq: bigint } {
  const envelope = decode(bytes) as [number, number, bigint, Uint8Array];
  const [version, actionType, seq, payloadBytes] = envelope;

  if (version !== CURRENT_VERSION) {
    throw new Error(`unsupported version: ${version}`);
  }

  const payload = decode(payloadBytes) as unknown[];
  const action = decodePayload(actionType as ActionTypeValue, payload);
  return { action, seq };
}

function encodePayload(action: Action): [ActionTypeValue, unknown[]] {
  switch (action.type) {
    case "PlaceOrder": {
      const d = action.data;
      const sideStr = d.side === Side.Buy ? "Buy" : "Sell";
      return [
        ActionType.PlaceOrder,
        [d.market, d.owner, sideStr, d.price, d.quantity, d.clientOrderId ?? null],
      ];
    }
    case "CancelOrder": {
      const d = action.data;
      return [ActionType.CancelOrder, [d.orderId, d.owner]];
    }
    case "OracleUpdate": {
      const d = action.data;
      return [ActionType.OracleUpdate, [d.market, d.price, d.signer]];
    }
  }
}

function decodePayload(actionType: ActionTypeValue, fields: unknown[]): Action {
  switch (actionType) {
    case ActionType.PlaceOrder: {
      const sideStr = fields[2] as string;
      return {
        type: "PlaceOrder",
        data: {
          market: fields[0] as number,
          owner: fields[1] as Uint8Array,
          side: sideStr === "Buy" ? Side.Buy : Side.Sell,
          price: fields[3] as bigint,
          quantity: fields[4] as bigint,
          clientOrderId: fields[5] as bigint | undefined,
        },
      };
    }
    case ActionType.CancelOrder:
      return {
        type: "CancelOrder",
        data: {
          orderId: fields[0] as bigint,
          owner: fields[1] as Uint8Array,
        },
      };
    case ActionType.OracleUpdate:
      return {
        type: "OracleUpdate",
        data: {
          market: fields[0] as number,
          price: fields[1] as bigint,
          signer: fields[2] as Uint8Array,
        },
      };
    default:
      throw new Error(`unknown action_type: ${actionType}`);
  }
}

/** Decode MessagePack-encoded events from FinalizeBlock response. */
export function decodeEvents(bytes: Uint8Array): ExchangeEvent[] {
  const raw = decode(bytes) as Record<string, unknown[]>[];
  return raw.map(decodeEvent);
}

function decodeEvent(obj: Record<string, unknown[]>): ExchangeEvent {
  if ("OrderPlaced" in obj) {
    const f = obj["OrderPlaced"]!;
    return {
      type: "OrderPlaced",
      orderId: f[0] as bigint,
      market: f[1] as number,
      owner: f[2] as Uint8Array,
      side: f[3] as Side,
      price: f[4] as bigint,
      quantity: f[5] as bigint,
    };
  }
  if ("OrderCancelled" in obj) {
    const f = obj["OrderCancelled"]!;
    return {
      type: "OrderCancelled",
      orderId: f[0] as bigint,
      market: f[1] as number,
      owner: f[2] as Uint8Array,
      reason: String(f[3]),
    };
  }
  if ("PriceUpdated" in obj) {
    const f = obj["PriceUpdated"]!;
    return {
      type: "PriceUpdated",
      market: f[0] as number,
      price: f[1] as bigint,
    };
  }
  throw new Error(`unknown event: ${JSON.stringify(obj)}`);
}
