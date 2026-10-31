import {
  canonicalBase64,
  hexAddress,
  invalidRead,
  U64_MAX,
  marketId,
  type HexAddress,
  type MarketId,
} from "./read-values.js";
import { Decoder } from "@msgpack/msgpack";
import { decodeAccountState, type AccountState } from "./account-state.js";
import {
  boundedGatewayJson,
  decodeFinalizedReadWitness,
  type BoundedReadOptions,
  type FinalizedReadWitness,
} from "./bounded-read.js";
import { rejectFloats } from "./codec.js";
import { getWasm, ready } from "./wasm-loader.js";
import { accountInfoFromWasm } from "./codec-adapter.js";
import type { AccountInfo } from "./types.js";
import type { ExchangeHttpTransport } from "./http-transport.js";

export interface FinalizedAccountState extends AccountState {
  witness: FinalizedReadWitness;
}
/** Engine-valued account; fundingSince is read, never recomputed here. */
export interface FinalizedAccountInfo extends AccountInfo {
  owner: HexAddress;
  witness: FinalizedReadWitness;
}
export interface FinalizedAgentAuthorization {
  owner: HexAddress;
  agent: HexAddress;
  authorized: boolean;
  witness: FinalizedReadWitness;
}
export interface FinalizedRecentNonces {
  signer: HexAddress;
  /** Prunable retained set, never a lifetime nonce floor or absence proof. */
  recent: bigint[];
  witness: FinalizedReadWitness;
}
export interface RawOpenOrder {
  id: bigint;
  market: MarketId;
  owner: HexAddress;
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
export interface FinalizedOpenOrders {
  owner: HexAddress;
  limit: number;
  orders: RawOpenOrder[];
  /** False at the requested row limit, even when that happens to be exact. */
  complete: boolean;
  witness: FinalizedReadWitness;
}
export interface FinalizedOpenOrdersOptions extends BoundedReadOptions {
  limit?: number;
}

function fail(
  field: string,
  kind: import("./errors.js").GatewayReadError["kind"] = "malformed",
): never {
  return invalidRead(`account.${field}`, kind);
}
function address(value: string): HexAddress {
  return hexAddress(value);
}
function uint(v: unknown, field: string, max = U64_MAX): bigint {
  const n =
    typeof v === "bigint"
      ? v
      : typeof v === "number" && Number.isSafeInteger(v)
        ? BigInt(v)
        : fail(field);
  if (n < 0n || n > max) fail(field);
  return n;
}
function row(v: unknown, length: number, field: string): unknown[] {
  if (!Array.isArray(v) || v.length !== length) fail(field);
  return v;
}
function orderOwner(v: unknown): string {
  const values =
    v instanceof Uint8Array ? Array.from(v) : row(v, 20, "order owner");
  if (values.length !== 20) fail("order owner");
  return values
    .map((b) => uint(b, "owner byte", 255n).toString(16).padStart(2, "0"))
    .join("");
}
function limit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 101) fail("order limit");
  return value;
}
/** Strict raw envelope; no projections, fallback or evidence synthesized from another read.
 * Requires ready() for the authoritative MessagePack framing/depth preflight. */
function witnessedBytes(value: unknown): {
  bytes: Uint8Array;
  witness: FinalizedReadWitness;
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("envelope");
  const e = value as Record<string, unknown>;
  if (Object.keys(e).length !== 2 || !("data" in e) || !("witness" in e))
    fail("envelope");
  const bytes = canonicalBase64(e.data, "account.base64", 512 * 1024);
  const w = e.witness;
  if (
    !w ||
    typeof w !== "object" ||
    Array.isArray(w) ||
    Object.keys(w).length !== 5
  )
    fail("witness");
  return { bytes, witness: decodeFinalizedReadWitness(w) };
}

export function decodeWitnessedRead(value: unknown): {
  raw: unknown;
  witness: FinalizedReadWitness;
} {
  const { bytes, witness } = witnessedBytes(value);
  rejectFloats(bytes);
  const raw: unknown = new Decoder({
    useBigInt64: true,
    maxArrayLength: 2048,
    maxMapLength: 0,
    maxStrLength: 64,
    maxBinLength: 32,
    maxExtLength: 0,
  }).decode(bytes);
  return { raw, witness };
}

export async function readFinalizedAccount(
  gateway: string,
  owner: string,
  options: BoundedReadOptions,
  transport: ExchangeHttpTransport,
): Promise<FinalizedAccountInfo> {
  const boundOwner = address(owner);
  const { bytes, witness } = witnessedBytes(
    await read(
      gateway,
      `/v1/account/${boundOwner}?witness=1`,
      options,
      transport,
    ),
  );
  const wasm = getWasm();
  const account = accountInfoFromWasm(
    wasm.decode_read(wasm.ReadKind.Account, bytes),
  );
  const seen = new Set<number>();
  for (const p of account.positions) {
    if (
      p.owner.length !== 20 ||
      Array.from(p.owner, (b) => b.toString(16).padStart(2, "0")).join("") !==
        boundOwner ||
      seen.has(p.market)
    )
      fail("valued position binding", "binding");
    seen.add(p.market);
  }
  return { ...account, owner: boundOwner, witness };
}
export function decodeFinalizedAccountState(
  value: unknown,
  owner: string,
): FinalizedAccountState {
  address(owner);
  const { raw, witness } = decodeWitnessedRead(value);
  const state = decodeAccountState(raw, owner);
  if (state.finalizedHeight !== witness.height)
    fail("account height mismatch", "binding");
  return { ...state, witness };
}
export function decodeFinalizedAgentAuthorization(
  value: unknown,
  owner: string,
  agent: string,
): FinalizedAgentAuthorization {
  hexAddress(owner, "owner address");
  hexAddress(agent, "agent address");
  const { raw, witness } = decodeWitnessedRead(value);
  if (typeof raw !== "boolean") fail("authorization");
  return {
    owner: hexAddress(owner),
    agent: hexAddress(agent),
    authorized: raw,
    witness,
  };
}
export function decodeFinalizedRecentNonces(
  value: unknown,
  signer: string,
): FinalizedRecentNonces {
  address(signer);
  const { raw, witness } = decodeWitnessedRead(value);
  if (!Array.isArray(raw) || raw.length > 100) fail("nonce count");
  let previous = -1n;
  const recent = raw.map((v) => {
    const n = uint(v, "nonce");
    if (n <= previous) fail("nonce order or duplicate");
    previous = n;
    return n;
  });
  return { signer: hexAddress(signer), recent, witness };
}
export function decodeFinalizedOpenOrders(
  value: unknown,
  owner: string,
  requestedLimit = 101,
): FinalizedOpenOrders {
  address(owner);
  limit(requestedLimit);
  const { raw, witness } = decodeWitnessedRead(value);
  if (!Array.isArray(raw) || raw.length > requestedLimit) fail("order count");
  let previous = -1n;
  const orders = raw.map((v): RawOpenOrder => {
    const o = row(v, 14, "order tuple");
    const id = uint(o[0], "order id");
    const market = marketId(Number(uint(o[1], "order market", 0xffff_ffffn)));
    if (id <= previous) fail("order id ordering");
    if (orderOwner(o[2]) !== owner) fail("order owner mismatch", "binding");
    previous = id;
    if (o[3] !== "Buy" && o[3] !== "Sell") fail("side");
    if (o[11] !== "Gtc" && o[11] !== "Ioc" && o[11] !== "Fok")
      fail("time in force");
    if (typeof o[12] !== "boolean" || typeof o[13] !== "boolean")
      fail("order flags");
    const quantity = uint(o[5], "quantity");
    if (quantity === 0n) fail("empty order");
    return {
      id,
      market,
      owner: hexAddress(owner),
      side: o[3],
      price: uint(o[4], "price"),
      quantity,
      clientOrderId: o[6] === null ? null : uint(o[6], "client order id"),
      originalQuantity: uint(o[7], "original quantity"),
      filledQuantity: uint(o[8], "filled quantity"),
      createdAtMs: uint(o[9], "created at"),
      queuePriority: uint(o[10], "queue priority"),
      timeInForce: o[11],
      postOnly: o[12],
      reduceOnly: o[13],
    };
  });
  return {
    owner: hexAddress(owner),
    limit: requestedLimit,
    orders,
    complete: orders.length < requestedLimit,
    witness,
  };
}
async function read(
  gateway: string,
  path: string,
  options: BoundedReadOptions,
  transport: ExchangeHttpTransport,
): Promise<unknown> {
  const captured = { ...options };
  captured.signal?.throwIfAborted();
  return boundedGatewayJson(
    `${gateway.replace(/\/+$/, "")}${path}`,
    transport,
    captured,
    { purpose: "account", prepare: ready },
  );
}
export async function readFinalizedAccountState(
  gateway: string,
  owner: string,
  options: BoundedReadOptions,
  transport: ExchangeHttpTransport,
): Promise<FinalizedAccountState> {
  address(owner);
  return decodeFinalizedAccountState(
    await read(
      gateway,
      `/v1/account/${owner}/state?witness=1`,
      options,
      transport,
    ),
    owner,
  );
}
export async function readFinalizedAgentAuthorization(
  gateway: string,
  owner: string,
  agent: string,
  options: BoundedReadOptions,
  transport: ExchangeHttpTransport,
): Promise<FinalizedAgentAuthorization> {
  hexAddress(owner, "owner address");
  hexAddress(agent, "agent address");
  return decodeFinalizedAgentAuthorization(
    await read(
      gateway,
      `/v1/account/${owner}/agents/${agent}?witness=1`,
      options,
      transport,
    ),
    owner,
    agent,
  );
}
export async function readFinalizedRecentNonces(
  gateway: string,
  signer: string,
  options: BoundedReadOptions,
  transport: ExchangeHttpTransport,
): Promise<FinalizedRecentNonces> {
  address(signer);
  return decodeFinalizedRecentNonces(
    await read(
      gateway,
      `/v1/account/${signer}/recent-nonces?witness=1`,
      options,
      transport,
    ),
    signer,
  );
}
export async function readFinalizedOpenOrders(
  gateway: string,
  owner: string,
  options: FinalizedOpenOrdersOptions,
  transport: ExchangeHttpTransport,
): Promise<FinalizedOpenOrders> {
  address(owner);
  const requestedLimit = limit(options.limit ?? 101);
  return decodeFinalizedOpenOrders(
    await read(
      gateway,
      `/v1/orders/${owner}?limit=${requestedLimit}&witness=1`,
      options,
      transport,
    ),
    owner,
    requestedLimit,
  );
}
