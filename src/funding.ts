/** One market's funding state as the engine stores it (`GET /v1/funding/{market}`). */
export interface FundingInfo {
  market: number;
  /** Current funding rate in basis points; 0 before the first funding cycle. */
  fundingRateBps: bigint;
  cumulativeFunding: bigint;
  /** 0 when the market has never funded. */
  lastFundingTimeMs: bigint;
  /** Mark price EWMA in micro-USDC. The engine serves the oracle price here
   *  until the market's first trade seeds the EWMA. */
  markPriceEwma: bigint;
  /** Oracle price in micro-USDC; 0 while no oracle price has been set. */
  oraclePrice: bigint;
  fundingIntervalMs: bigint;
  maxFundingRateBps: number;
}

function invalid(field: string): never {
  throw new Error(`funding decode: invalid ${field}`);
}
function integer(value: unknown, field: string, signed = false): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value))
    value = BigInt(value);
  const min = signed ? -(1n << 63n) : 0n;
  const max = signed ? (1n << 63n) - 1n : (1n << 64n) - 1n;
  if (typeof value !== "bigint" || value < min || value > max)
    return invalid(field);
  return value;
}
function u32(value: unknown, field: string): number {
  const v = integer(value, field);
  if (v > 0xffff_ffffn) return invalid(field);
  return Number(v);
}

/** Decode the engine's `FundingInfo` tuple. Fields the engine appends after
 *  the eight known ones are ignored; fewer than eight throws. */
export function decodeFundingInfo(raw: unknown): FundingInfo {
  if (!Array.isArray(raw) || raw.length < 8) return invalid("record");
  return {
    market: u32(raw[0], "market"),
    fundingRateBps: integer(raw[1], "funding rate", true),
    cumulativeFunding: integer(raw[2], "cumulative funding", true),
    lastFundingTimeMs: integer(raw[3], "last funding time"),
    markPriceEwma: integer(raw[4], "mark price"),
    oraclePrice: integer(raw[5], "oracle price"),
    fundingIntervalMs: integer(raw[6], "funding interval"),
    maxFundingRateBps: u32(raw[7], "max funding rate"),
  };
}
