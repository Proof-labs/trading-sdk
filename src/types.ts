/** 20-byte account address */
export type Address = Uint8Array;

export enum Side {
  Buy = 1,
  Sell = 2,
}

export const ActionType = {
  PlaceOrder: 0x01,
  CancelOrder: 0x02,
  OracleUpdate: 0x03,
} as const;

export type ActionTypeValue = (typeof ActionType)[keyof typeof ActionType];

export interface PlaceOrder {
  market: number;
  owner: Address;
  side: Side;
  price: bigint;
  quantity: bigint;
  clientOrderId?: bigint;
}

export interface CancelOrder {
  orderId: bigint;
  owner: Address;
}

export interface OracleUpdate {
  market: number;
  price: bigint;
  signer: Address;
}

export type Action =
  | { type: "PlaceOrder"; data: PlaceOrder }
  | { type: "CancelOrder"; data: CancelOrder }
  | { type: "OracleUpdate"; data: OracleUpdate };

export interface OrderPlacedEvent {
  type: "OrderPlaced";
  orderId: bigint;
  market: number;
  owner: Address;
  side: Side;
  price: bigint;
  quantity: bigint;
}

export interface OrderCancelledEvent {
  type: "OrderCancelled";
  orderId: bigint;
  market: number;
  owner: Address;
  reason: string;
}

export interface PriceUpdatedEvent {
  type: "PriceUpdated";
  market: number;
  price: bigint;
}

export type ExchangeEvent =
  | OrderPlacedEvent
  | OrderCancelledEvent
  | PriceUpdatedEvent;

export interface TxResult {
  code: number;
  hash: string;
  height?: number;
  log?: string;
}
