import { Decoder } from "@msgpack/msgpack";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { boundedGatewayJson, decodeFinalizedReadWitness, type BoundedReadOptions, type FinalizedReadWitness } from "./bounded-read.js";
import { rejectFloats } from "./codec.js";
import { pubkeyToOwner } from "./crypto.js";
import type { ExchangeHttpTransport } from "./http-transport.js";
import { decodeOraclePermissions, type OraclePermissions } from "./oracle-permissions.js";
import { ready } from "./wasm-loader.js";

export interface InsuranceExitPrefixSelection {
  pool: number;
  agentPubkey: string;
  market: number;
  side: "Buy" | "Sell";
  quantity: bigint;
  limitPrice: bigint;
  maxTakerFeeTenthBps: number;
  protectedCash: bigint;
  minMmBuffer: bigint;
}
/** Fixed-state calculation, not an inclusion-time authorization. */
export interface InsuranceExitPrefix extends InsuranceExitPrefixSelection {
  format: 2;
  chainId: Uint8Array;
  finalizedHeight: bigint;
  finalizedTimeMs: bigint;
  owner: string;
  agentAddress: string;
  cash: bigint;
  insuranceDebt: bigint;
  negativePendingFunding: bigint;
  makerFundingHaircut: bigint;
  fillLossHaircut: bigint;
  unrealizedDropHaircut: bigint;
  syntheticCash: bigint;
  syntheticMmBuffer: bigint;
  syntheticImBuffer: bigint;
  meetsBound: boolean;
  marks: { market: number; price: bigint; providerTimeMs: bigint; markSourceMode: "OracleOnly"; oraclePermissions: OraclePermissions }[];
  witness: FinalizedReadWitness;
}
const U64 = (1n << 64n) - 1n;
const decoder = new Decoder({ useBigInt64: true, maxArrayLength: 2048, maxStrLength: 524288, maxBinLength: 524288, maxMapLength: 2048 });
function bad(field: string): never { throw new Error(`Invalid insurance exit prefix: ${field}`); }
function uint(v: unknown, field: string, max = U64): bigint {
  const n = typeof v === "bigint" ? v : typeof v === "number" && Number.isSafeInteger(v) ? BigInt(v) : bad(field);
  if (n < 0n || n > max) bad(field);
  return n;
}
function tuple(v: unknown, length: number, field: string): unknown[] {
  if (!Array.isArray(v) || v.length !== length) bad(field);
  return v;
}
function bytes(v: unknown, length: number, field: string): Uint8Array {
  return Uint8Array.from(tuple(v, length, field).map(x => Number(uint(x, field, 255n))));
}
function hex(v: Uint8Array): string { return Array.from(v, b => b.toString(16).padStart(2, "0")).join(""); }
function signed(v: unknown, field: string): bigint {
  if (typeof v !== "string" || !/^(0|-?[1-9][0-9]*)$/.test(v) || v.length > 40) bad(field);
  const n = BigInt(v);
  if (n < -(1n << 127n) || n >= (1n << 127n)) bad(field);
  return n;
}
function selection(v: InsuranceExitPrefixSelection): InsuranceExitPrefixSelection {
  if (!v || typeof v !== "object" || typeof v.pool !== "number" || typeof v.market !== "number" || typeof v.maxTakerFeeTenthBps !== "number") bad("selection");
  const pool = Number(uint(v.pool, "pool", 255n));
  const market = Number(uint(v.market, "market", 0xffffffffn));
  const fee = Number(uint(v.maxTakerFeeTenthBps, "fee", 99999n));
  if (!market || typeof v.agentPubkey !== "string" || !/^[a-f0-9]{64}$/.test(v.agentPubkey) || (v.side !== "Buy" && v.side !== "Sell")) bad("identity");
  const quantity = uint(v.quantity, "quantity"), limitPrice = uint(v.limitPrice, "limit");
  if (!quantity || !limitPrice) bad("zero order");
  return { pool, market, agentPubkey: v.agentPubkey, side: v.side, quantity, limitPrice,
    maxTakerFeeTenthBps: fee, protectedCash: uint(v.protectedCash, "protected"), minMmBuffer: uint(v.minMmBuffer, "buffer") };
}

export function decodeInsuranceExitPrefix(body: unknown, expectedChain: Uint8Array, requested: InsuranceExitPrefixSelection): InsuranceExitPrefix {
  const s = selection(requested);
  if (!(expectedChain instanceof Uint8Array) || expectedChain.length !== 32 || !expectedChain.some(x => x !== 0)) bad("chain");
  if (!body || typeof body !== "object" || Array.isArray(body)) bad("envelope");
  const envelope = body as Record<string, unknown>;
  const encoded = envelope.data;
  if (envelope.error != null || typeof encoded !== "string" || !encoded.length || encoded.length > 699052 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) bad("encoding");
  const binary = atob(encoded);
  if (btoa(binary) !== encoded || binary.length > 524288) bad("canonical encoding");
  const wire = Uint8Array.from(binary, c => c.charCodeAt(0));
  rejectFloats(wire);
  const r = tuple(decoder.decode(wire), 26, "tuple");
  if (uint(r[0], "format") !== 2n) bad("format");
  const chainId = bytes(r[1], 32, "chain");
  if (hex(chainId) !== hex(expectedChain)) bad("chain binding");
  const finalizedHeight = uint(r[2], "height"), finalizedTimeMs = uint(r[3], "time");
  if (!finalizedHeight || !finalizedTimeMs) bad("unfinalized");
  const owner = hex(bytes(r[5], 20, "owner"));
  const fund = keccak_256(new Uint8Array([...new TextEncoder().encode("ProofExchange-vault-v1"), 0, s.pool])).slice(0, 20);
  const agent = bytes(r[6], 32, "agent"), agentAddress = hex(bytes(r[7], 20, "agent address"));
  if (uint(r[4], "pool") !== BigInt(s.pool) || owner !== hex(fund) || hex(agent) !== s.agentPubkey || agentAddress !== hex(pubkeyToOwner(agent))) bad("identity binding");
  if (uint(r[8], "market") !== BigInt(s.market) || r[9] !== s.side || uint(r[10], "quantity") !== s.quantity || uint(r[11], "limit") !== s.limitPrice || uint(r[12], "fee") !== BigInt(s.maxTakerFeeTenthBps) || uint(r[13], "protected") !== s.protectedCash || uint(r[14], "buffer") !== s.minMmBuffer) bad("selector binding");
  const cash = uint(r[15], "cash"), insuranceDebt = uint(r[16], "debt"), negativePendingFunding = uint(r[17], "pending funding"), makerFundingHaircut = uint(r[18], "maker funding"), fillLossHaircut = uint(r[19], "fill loss"), unrealizedDropHaircut = uint(r[20], "unrealized drop"), syntheticCash = uint(r[21], "synthetic cash");
  if (syntheticCash !== cash - insuranceDebt - negativePendingFunding - makerFundingHaircut - fillLossHaircut - unrealizedDropHaircut - s.protectedCash) bad("cash arithmetic");
  const syntheticMmBuffer = signed(r[22], "MM"), syntheticImBuffer = signed(r[23], "IM");
  if (typeof r[24] !== "boolean" || r[24] !== (syntheticMmBuffer >= s.minMmBuffer)) bad("bound verdict");
  if (!Array.isArray(r[25]) || r[25].length === 0 || r[25].length > 32) bad("marks");
  let previous = 0;
  const marks = r[25].map(raw => {
    const mark = tuple(raw, 5, "mark");
    const market = Number(uint(mark[0], "mark market", 0xffffffffn));
    const price = uint(mark[1], "mark price"), providerTimeMs = uint(mark[2], "provider time");
    if (market <= previous || !price || !providerTimeMs || providerTimeMs > finalizedTimeMs || mark[3] !== "OracleOnly") bad("mark binding");
    previous = market;
    const oraclePermissions = decodeOraclePermissions(mark[4], market);
    if (oraclePermissions.finalizedHeight !== finalizedHeight) bad("oracle height");
    return { market, price, providerTimeMs, markSourceMode: "OracleOnly" as const, oraclePermissions };
  });
  if (!marks.some(mark => mark.market === s.market)) bad("target reference");
  return { ...s, format: 2, chainId, finalizedHeight, finalizedTimeMs, owner, agentAddress, cash, insuranceDebt, negativePendingFunding, makerFundingHaircut, fillLossHaircut, unrealizedDropHaircut, syntheticCash, syntheticMmBuffer, syntheticImBuffer, meetsBound: r[24], marks, witness: decodeFinalizedReadWitness(envelope.witness, finalizedHeight, finalizedTimeMs) };
}

export async function readInsuranceExitPrefix(gatewayUrl: string, expectedChain: Uint8Array, requested: InsuranceExitPrefixSelection, options: BoundedReadOptions, transport: ExchangeHttpTransport): Promise<InsuranceExitPrefix> {
  const s = selection(requested), chain = expectedChain.slice(), bounds = { ...options };
  bounds.signal?.throwIfAborted();
  await ready();
  const query = `pool=${s.pool}&agent=${s.agentPubkey}&market=${s.market}&side=${s.side.toLowerCase()}&quantity=${s.quantity}&limit=${s.limitPrice}&fee=${s.maxTakerFeeTenthBps}&protected=${s.protectedCash}&buffer=${s.minMmBuffer}`;
  return decodeInsuranceExitPrefix(await boundedGatewayJson(`${gatewayUrl.replace(/\/+$/, "")}/v1/insurance/exit-prefix?${query}`, transport, bounds), chain, s);
}
