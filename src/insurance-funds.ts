import {
  asReadError,
  boundedGatewayJson,
  decodeFinalizedReadWitness,
  type BoundedReadOptions,
  type FinalizedReadWitness,
} from "./bounded-read.js";
import {
  canonicalBase64,
  hexAddress,
  invalidRead,
  marketId,
  readObject,
  type HexAddress,
  type MarketId,
} from "./read-values.js";
import { bytesToHex } from "./crypto.js";
import { getWasm, ready } from "./wasm-loader.js";
import type { ExchangeHttpTransport } from "./http-transport.js";

export interface InsuranceFundLedger {
  poolId: number;
  owner: HexAddress;
  registered: boolean;
  storedLedger: boolean;
  cash: bigint;
  debt: bigint;
  /**
   * Cash minus debt, not marked equity or historical profit. Funding the fund
   * still owes on its positions is not included, so this is not the amount a
   * withdrawal can take.
   */
  netCash: bigint;
}
export type InsurancePositionNotional =
  | { status: "priced"; referencePrice: bigint; notionalMicroUsdc: bigint }
  | {
      status: "unpriced";
      reason:
        | "stale"
        | "guard_unset"
        | "no_verdict"
        | "no_mark"
        | "thin_book"
        | "unknown";
    }
  | { status: "unsupported_binary" }
  | { status: "unknown" };
export interface InsuranceFundPosition {
  market: MarketId;
  side: "buy" | "sell" | "unknown";
  size: bigint;
  szDecimals: number;
  /** Engine settlement reference and floor notional, not an execution quote. */
  notional: InsurancePositionNotional;
}
export interface FinalizedInsuranceFunds {
  finalizedHeight: bigint;
  finalizedTimeMs: bigint;
  /** Complete finite directory of registered or stored-ledger pools, sorted by pool. */
  funds: InsuranceFundLedger[];
  witness: FinalizedReadWitness;
}
export interface FinalizedInsuranceFund {
  finalizedHeight: bigint;
  finalizedTimeMs: bigint;
  fund: InsuranceFundLedger;
  positions: InsuranceFundPosition[];
  /** False means more than 100 positions exist; this is not an exhaustive view. */
  positionsComplete: boolean;
  witness: FinalizedReadWitness;
}

/** Mirrors proof_wire::query_v2::INSURANCE_FUND_POSITIONS_LIMIT. Display preview only. */
const INSURANCE_FUND_POSITIONS_LIMIT = 100;

function poolId(value: unknown, callerInput = false): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 255
  )
    invalidRead("insurance pool", callerInput ? "configuration" : "malformed");
  return value;
}

/** Naming/representation adapter after canonical Rust decoding and owner binding. */
function ledger(value: unknown): InsuranceFundLedger {
  const raw = value as {
    pool_id: number;
    owner: Uint8Array;
    registered: boolean;
    stored_ledger: boolean;
    cash: bigint;
    debt: bigint;
    net_cash: bigint;
  };
  if (raw.cash - raw.debt !== raw.net_cash)
    invalidRead("insurance net cash", "binding");
  return {
    poolId: poolId(raw.pool_id),
    owner: hexAddress(bytesToHex(raw.owner)),
    registered: raw.registered,
    storedLedger: raw.stored_ledger,
    cash: raw.cash,
    debt: raw.debt,
    netCash: raw.net_cash,
  };
}

function position(value: unknown): InsuranceFundPosition {
  const raw = value as {
    market: number;
    side: string;
    size: bigint;
    sz_decimals: number;
    notional: {
      status: string;
      reference_price?: bigint;
      notional_micro_usdc?: string;
      reason?: string;
    };
  };
  if (typeof raw.side !== "string" || raw.size === 0n || raw.sz_decimals > 37)
    invalidRead("insurance position");
  let notional: InsurancePositionNotional;
  if (raw.notional.status === "priced") {
    const amount = raw.notional.notional_micro_usdc;
    const price = raw.notional.reference_price;
    if (
      typeof amount !== "string" ||
      !/^(0|[1-9][0-9]{0,38})$/.test(amount) ||
      typeof price !== "bigint" ||
      price === 0n
    )
      invalidRead("insurance notional");
    const exact = BigInt(amount);
    if (
      exact >= 1n << 128n ||
      exact !== (price * raw.size) / 10n ** BigInt(raw.sz_decimals)
    )
      invalidRead("insurance notional scale", "binding");
    notional = {
      status: "priced",
      referencePrice: price,
      notionalMicroUsdc: exact,
    };
  } else if (raw.notional.status === "unpriced") {
    const reason = raw.notional.reason;
    if (typeof reason !== "string") invalidRead("insurance unpriced reason");
    notional = {
      status: "unpriced",
      reason:
        reason === "stale" ||
        reason === "guard_unset" ||
        reason === "no_verdict" ||
        reason === "no_mark" ||
        reason === "thin_book"
          ? reason
          : "unknown",
    };
  } else if (raw.notional.status === "unsupported_binary") {
    notional = { status: "unsupported_binary" };
  } else if (typeof raw.notional.status === "string") {
    notional = { status: "unknown" };
  } else invalidRead("insurance notional status");
  return {
    market: marketId(raw.market),
    side: raw.side === "buy" || raw.side === "sell" ? raw.side : "unknown",
    size: raw.size,
    szDecimals: raw.sz_decimals,
    notional,
  };
}

function decoded(value: unknown, kind: number) {
  const envelope = readObject(value, "insurance fund envelope");
  if (
    Object.keys(envelope).length !== 2 ||
    !("data" in envelope) ||
    !("witness" in envelope)
  )
    invalidRead("insurance fund envelope");
  const witness = decodeFinalizedReadWitness(envelope.witness);
  const bytes = canonicalBase64(
    envelope.data,
    "insurance fund data",
    256 * 1024,
  );
  const raw = asReadError("insurance fund", () =>
    readObject(getWasm().decode_read(kind, bytes), "insurance fund view"),
  );
  if (
    raw.finalized_height !== witness.height ||
    raw.finalized_time_ms !== witness.finalizedBlockTimeMs
  )
    invalidRead("insurance fund witness mismatch", "binding");
  return {
    raw,
    witness,
    finalizedHeight: witness.height,
    finalizedTimeMs: witness.finalizedBlockTimeMs,
  };
}

export function decodeFinalizedInsuranceFunds(
  value: unknown,
): FinalizedInsuranceFunds {
  const { raw, ...bound } = decoded(
    value,
    getWasm().ReadKind.InsuranceFundDirectory,
  );
  if (!Array.isArray(raw.funds) || raw.funds.length > 256)
    invalidRead("insurance fund directory bound");
  let previous = -1;
  const funds = raw.funds.map((value) => {
    const fund = ledger(value);
    if (fund.poolId <= previous || (!fund.registered && !fund.storedLedger))
      invalidRead("insurance fund directory ordering or presence");
    previous = fund.poolId;
    return fund;
  });
  return { ...bound, funds };
}

export function decodeFinalizedInsuranceFund(
  value: unknown,
  pool: number,
): FinalizedInsuranceFund {
  poolId(pool, true);
  const { raw, ...bound } = decoded(
    value,
    getWasm().ReadKind.InsuranceFundState,
  );
  const fund = ledger(raw.fund);
  if (fund.poolId !== pool) invalidRead("insurance pool binding", "binding");
  if (
    !Array.isArray(raw.positions) ||
    raw.positions.length > INSURANCE_FUND_POSITIONS_LIMIT ||
    typeof raw.positions_complete !== "boolean" ||
    (!raw.positions_complete &&
      raw.positions.length !== INSURANCE_FUND_POSITIONS_LIMIT)
  )
    invalidRead("insurance positions completeness");
  let previous = 0;
  const positions = raw.positions.map((value) => {
    const item = position(value);
    if (item.market <= previous) invalidRead("insurance positions ordering");
    previous = item.market;
    return item;
  });
  return {
    ...bound,
    fund,
    positions,
    positionsComplete: raw.positions_complete,
  };
}

export async function readFinalizedInsuranceFunds(
  gateway: string,
  options: BoundedReadOptions,
  transport: ExchangeHttpTransport,
): Promise<FinalizedInsuranceFunds> {
  return decodeFinalizedInsuranceFunds(
    await boundedGatewayJson(
      `${gateway.replace(/\/+$/, "")}/v2/insurance-funds?witness=1`,
      transport,
      { ...options },
      { purpose: "query", prepare: ready, maxBytes: 512 * 1024 },
    ),
  );
}

export async function readFinalizedInsuranceFund(
  gateway: string,
  pool: number,
  options: BoundedReadOptions,
  transport: ExchangeHttpTransport,
): Promise<FinalizedInsuranceFund> {
  poolId(pool, true);
  return decodeFinalizedInsuranceFund(
    await boundedGatewayJson(
      `${gateway.replace(/\/+$/, "")}/v2/insurance-fund/${pool}?witness=1`,
      transport,
      { ...options },
      { purpose: "query", prepare: ready, maxBytes: 512 * 1024 },
    ),
    pool,
  );
}
