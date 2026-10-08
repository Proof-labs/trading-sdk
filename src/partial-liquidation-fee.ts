/** Cash-only receipt. Canonical trade events separately describe the position close. */
export interface PartialLiquidationFeeReceipt {
  owner: string;
  market: number;
  poolId: number;
  episodeGeneration: bigint;
  policyRevision: bigint;
  fillId: bigint;
  assessed: bigint;
  collected: bigint;
  waived: bigint;
  cashDelta: bigint;
}

export class PartialFeeDecodeError extends Error {
  constructor(readonly field: string) {
    super(`Invalid partial_liquidation_fee field: ${field}`);
    this.name = "PartialFeeDecodeError";
  }
}

/** Decode ABCI string attributes or the indexer's verbatim account-history payload.
 * Never accept JSON numbers: u64 identifiers and amounts can exceed 2^53.
 * Waivers are final, not deposits, withdrawals or collectible debt.
 */
export function decodePartialLiquidationFee(value: unknown): PartialLiquidationFeeReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new PartialFeeDecodeError("payload");
  const row = value as Record<string, unknown>;
  const text = (key: string): string => {
    if (typeof row[key] !== "string") throw new PartialFeeDecodeError(key);
    return row[key];
  };
  const uint = (key: string, maximum = 0xffff_ffff_ffff_ffffn, nonzero = false): bigint => {
    const raw = text(key);
    if (!/^\d+$/.test(raw)) throw new PartialFeeDecodeError(key);
    const result = BigInt(raw);
    if (result > maximum || (nonzero && result === 0n)) throw new PartialFeeDecodeError(key);
    return result;
  };
  const owner = text("owner");
  if (!/^(?:0x)?[a-fA-F0-9]{40}$/.test(owner)) throw new PartialFeeDecodeError("owner");
  const marketText = text("market");
  if (!/^-?\d+$/.test(marketText)) throw new PartialFeeDecodeError("market");
  const market = BigInt(marketText);
  if (market < -0x8000_0000n || market > 0x7fff_ffffn) throw new PartialFeeDecodeError("market");
  const assessed = uint("assessed");
  const collected = uint("collected", 0x7fff_ffff_ffff_ffffn);
  const waived = uint("waived");
  const delta = text("cash_delta");
  if (!/^-?\d+$/.test(delta) || BigInt(delta) !== -collected || collected + waived !== assessed)
    throw new PartialFeeDecodeError("cash_delta");
  return {
    owner, market: Number(market), poolId: Number(uint("pool_id", 255n)),
    episodeGeneration: uint("episode_generation", undefined, true),
    policyRevision: uint("policy_revision", undefined, true), fillId: uint("fill_id", undefined, true),
    assessed, collected, waived, cashDelta: BigInt(delta),
  };
}
