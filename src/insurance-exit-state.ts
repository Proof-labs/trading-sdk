import { Decoder } from "@msgpack/msgpack";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  decodeAccountState,
  type RawAccountPosition,
} from "./account-state.js";
import {
  boundedGatewayJson,
  decodeFinalizedReadWitness,
  type BoundedReadOptions,
  type FinalizedReadWitness,
} from "./bounded-read.js";
import { rejectFloats } from "./codec.js";
import { pubkeyToOwner } from "./crypto.js";
import type { ExchangeHttpTransport } from "./http-transport.js";
import { ready } from "./wasm-loader.js";

export interface InsuranceExitSelection {
  pool: number;
  /** Canonical lowercase Ed25519 public-key hex, not an owner address. */
  agentPubkey: string;
}
export interface InsuranceExitOrder {
  id: bigint;
  market: number;
  owner: string;
  side: "Buy" | "Sell";
  price: bigint;
  quantity: bigint;
  clientOrderId: bigint | null;
  originalQuantity: bigint;
  filledQuantity: bigint;
  createdAtMs: bigint;
  queuePriority: bigint;
  timeInForce: "Gtc" | "Ioc" | "Fok";
  postOnly: boolean;
  reduceOnly: boolean;
}
/** Same finalized node view, NOT a cryptographic state proof. Independently
 * bind node identity and appHash to the committed H+1 header before acting. */
export type InsuranceExitWitness = FinalizedReadWitness;
/** Complete bounded inventory for the derived fund owner at one finalized
 * view. No freshness, hypothetical-fill safety or submission absence verdict. */
export interface InsuranceExitState {
  format: 1;
  chainId: Uint8Array;
  finalizedHeight: bigint;
  finalizedTimeMs: bigint;
  pool: number;
  owner: string;
  agentPubkey: string;
  agentAddress: string;
  agentAuthorized: boolean;
  /** Maximum in the agent's retained replay set, NOT a lifetime nonce floor. */
  greatestRecentNonce: bigint | null;
  cash: bigint;
  insuranceDebt: bigint;
  positions: RawAccountPosition[];
  orders: InsuranceExitOrder[];
  complete: true;
  witness: InsuranceExitWitness;
}
const decoder = new Decoder({ useBigInt64: true, maxArrayLength: 2048 });
const U64_MAX = (1n << 64n) - 1n;
const domain = new TextEncoder().encode("ProofExchange-vault-v1");
function invalid(field: string): never {
  throw new Error(`Invalid insurance exit state: ${field}`);
}
function uint(value: unknown, field: string, max = U64_MAX): bigint {
  const n =
    typeof value === "bigint"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? BigInt(value)
        : invalid(field);
  if (n < 0n || n > max) invalid(field);
  return n;
}
function tuple(value: unknown, count: number, field: string): unknown[] {
  if (!Array.isArray(value) || value.length !== count) invalid(field);
  return value;
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(field);
  return value as Record<string, unknown>;
}
function bytes(
  value: unknown,
  count: number,
  field: string,
  binary = false,
): Uint8Array {
  if (binary && value instanceof Uint8Array) {
    if (value.length !== count) invalid(field);
    return value.slice();
  }
  return Uint8Array.from(
    tuple(value, count, field).map((value) => Number(uint(value, field, 255n))),
  );
}
function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(field);
  return value;
}
function selection(value: InsuranceExitSelection): InsuranceExitSelection {
  if (!value || typeof value !== "object" || typeof value.pool !== "number")
    invalid("selection");
  const pool = Number(uint(value.pool, "pool", 255n));
  if (
    typeof value.agentPubkey !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.agentPubkey)
  )
    invalid("agent public key");
  return { pool, agentPubkey: value.agentPubkey };
}

/** Strict version-1 decoder. Requires await ready() for MessagePack preflight.
 * Caller must verify finality/provenance; agentAuthorized is a snapshot fact. */
export function decodeInsuranceExitState(
  body: unknown,
  expectedChain: Uint8Array,
  requested: InsuranceExitSelection,
): InsuranceExitState {
  const expected = selection(requested);
  if (
    !(expectedChain instanceof Uint8Array) ||
    expectedChain.length !== 32 ||
    !expectedChain.some((byte) => byte !== 0)
  )
    invalid("pinned chain");
  const envelope = object(body, "envelope");
  if (envelope.error != null) invalid("error response");
  const encoded = envelope.data;
  if (
    typeof encoded !== "string" ||
    !encoded.length ||
    encoded.length > 1024 * 1024 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  )
    invalid("encoding");
  const wire = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  if (
    btoa(Array.from(wire, (byte) => String.fromCharCode(byte)).join("")) !==
    encoded
  )
    invalid("canonical base64");
  rejectFloats(wire);
  const r = tuple(decoder.decode(wire), 15, "tuple");
  if (uint(r[0], "format", 255n) !== 1n) invalid("format");
  const chainId = bytes(r[1], 32, "chain");
  if (!chainId.every((byte, i) => byte === expectedChain[i]))
    invalid("chain binding");
  const finalizedHeight = uint(r[2], "height");
  const finalizedTimeMs = uint(r[3], "time");
  if (finalizedHeight === 0n || finalizedTimeMs === 0n)
    invalid("unfinalized view");
  if (uint(r[4], "pool", 255n) !== BigInt(expected.pool))
    invalid("pool binding");
  const owner = hex(bytes(r[5], 20, "owner"));
  const fund = keccak_256(new Uint8Array([...domain, 0, expected.pool])).slice(
    0,
    20,
  );
  if (owner !== hex(fund)) invalid("derived owner binding");
  const agentBytes = bytes(r[6], 32, "agent public key");
  if (hex(agentBytes) !== expected.agentPubkey)
    invalid("agent public key binding");
  const agentAddress = hex(bytes(r[7], 20, "agent address"));
  if (agentAddress !== hex(pubkeyToOwner(agentBytes)))
    invalid("agent address binding");
  const agentAuthorized = bool(r[8], "agent authorization");
  const greatestRecentNonce = r[9] === null ? null : uint(r[9], "recent nonce");
  const cash = uint(r[10], "cash");
  const insuranceDebt = uint(r[11], "insurance debt");
  const positions = decodeAccountState(
    [fund, finalizedHeight, cash, r[12]],
    owner,
  ).positions;
  if (
    positions.some((position) => position.market === 0 || position.size === 0n)
  )
    invalid("position row");
  if (!Array.isArray(r[13]) || r[13].length > 100) invalid("order bound");
  let previous: bigint | undefined;
  const orders = r[13].map((value): InsuranceExitOrder => {
    const o = tuple(value, 14, "order tuple");
    const id = uint(o[0], "order ID");
    if (previous !== undefined && id <= previous)
      invalid("order ordering/duplicate");
    previous = id;
    const market = Number(uint(o[1], "order market", 0xffff_ffffn));
    if (market === 0 || hex(bytes(o[2], 20, "order owner", true)) !== owner)
      invalid("order identity");
    if (o[3] !== "Buy" && o[3] !== "Sell") invalid("order side");
    const quantity = uint(o[5], "quantity");
    if (quantity === 0n) invalid("empty order");
    if (o[11] !== "Gtc" && o[11] !== "Ioc" && o[11] !== "Fok")
      invalid("time in force");
    return {
      id,
      market,
      owner,
      side: o[3],
      price: uint(o[4], "price"),
      quantity,
      clientOrderId: o[6] === null ? null : uint(o[6], "client order ID"),
      originalQuantity: uint(o[7], "original quantity"),
      filledQuantity: uint(o[8], "filled quantity"),
      createdAtMs: uint(o[9], "created at"),
      queuePriority: uint(o[10], "queue priority"),
      timeInForce: o[11],
      postOnly: bool(o[12], "post only"),
      reduceOnly: bool(o[13], "reduce only"),
    };
  });
  if (r[14] !== true) invalid("incomplete inventory");
  const witness = decodeFinalizedReadWitness(
    envelope.witness,
    finalizedHeight,
    finalizedTimeMs,
  );
  return {
    format: 1,
    chainId,
    finalizedHeight,
    finalizedTimeMs,
    pool: expected.pool,
    owner,
    agentPubkey: expected.agentPubkey,
    agentAddress,
    agentAuthorized,
    greatestRecentNonce,
    cash,
    insuranceDebt,
    positions,
    orders,
    complete: true,
    witness,
  };
}

export async function readInsuranceExitState(
  gatewayUrl: string,
  expectedChain: Uint8Array,
  requested: InsuranceExitSelection,
  options: BoundedReadOptions,
  transport: ExchangeHttpTransport,
): Promise<InsuranceExitState> {
  const captured = selection(requested);
  const chain = expectedChain.slice();
  const bounds = { ...options };
  bounds.signal?.throwIfAborted();
  await ready();
  const body = await boundedGatewayJson(
    `${gatewayUrl.replace(/\/+$/, "")}/v1/insurance/exit-state?pool=${captured.pool}&agent=${captured.agentPubkey}`,
    transport,
    bounds,
  );
  return decodeInsuranceExitState(body, chain, captured);
}
