/** Terminal audit snapshot. Amounts describe already-applied transitions;
 * applying them again to the reported balances would double count cash.
 * Decoding does not authenticate chain provenance or authorize liquidation.
 */
export interface LiquidationCashAudit {
  owner: string;
  counterpartyOwner: string;
  market: number;
  poolId: number;
  planId: bigint;
  policyRevision: bigint;
  fillId: bigint;
  committedHeight: bigint;
  reservationId: bigint;
  fundingSnapshotId: string;
  quantity: bigint;
  referencePrice: bigint;
  ownerRealizedPnl: bigint;
  counterpartyRealizedPnl: bigint;
  allocatedFinalLoss: bigint;
  insurancePaid: bigint;
  penaltyCollected: bigint;
  penaltyWaived: bigint;
  ownerCashAfter: bigint;
  counterpartyCashAfter: bigint;
  appliedStateDigest: string;
}

/** Decode the flat string attributes of `liquidation_cash_finalized`, as
 * returned by ABCI/account history. Numbers are refused, never rounded.
 * Caller must establish the event type, chain identity and replay coordinates.
 */
export function decodeLiquidationCashAudit(
  payload: unknown,
): LiquidationCashAudit {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    throw new Error("liquidation audit attributes must be an object");
  const attrs = payload as Record<string, unknown>;
  const text = (key: string): string => {
    const value = Object.hasOwn(attrs, key) ? attrs[key] : undefined;
    if (typeof value !== "string") throw new Error(`${key} must be a string`);
    return value;
  };
  const hex = (key: string, bytes: number): string => {
    const value = text(key);
    if (value.length !== bytes * 2) throw new Error(`${key} exceeds width`);
    if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value))
      throw new Error(`${key} must be canonical ${bytes}-byte hex`);
    return value;
  };
  const integer = (key: string, bits: number, signed = false): bigint => {
    const value = text(key);
    // Bound input before regex and BigInt parsing.
    if (value.length > 20) throw new Error(`${key} exceeds width`);
    if (!(signed ? /^(0|-?[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/).test(value))
      throw new Error(`${key} must be canonical decimal`);
    const parsed = BigInt(value);
    const high = (1n << BigInt(signed ? bits - 1 : bits)) - 1n;
    const low = signed ? -(1n << BigInt(bits - 1)) : 0n;
    if (parsed < low || parsed > high) throw new Error(`${key} exceeds width`);
    return parsed;
  };
  const result: LiquidationCashAudit = {
    owner: hex("owner", 20),
    counterpartyOwner: hex("counterparty_owner", 20),
    market: Number(integer("market", 32)),
    poolId: Number(integer("pool_id", 8)),
    planId: integer("plan_id", 64),
    policyRevision: integer("policy_revision", 64),
    fillId: integer("fill_id", 64),
    committedHeight: integer("committed_height", 64),
    reservationId: integer("reservation_id", 64),
    fundingSnapshotId: hex("funding_snapshot_id", 32),
    quantity: integer("quantity", 64),
    referencePrice: integer("reference_price", 64),
    ownerRealizedPnl: integer("owner_realized_pnl", 64, true),
    counterpartyRealizedPnl: integer("counterparty_realized_pnl", 64, true),
    allocatedFinalLoss: integer("allocated_final_loss", 64),
    insurancePaid: integer("insurance_paid", 64),
    penaltyCollected: integer("penalty_collected", 64),
    penaltyWaived: integer("penalty_waived", 64),
    ownerCashAfter: integer("owner_cash_after", 64),
    counterpartyCashAfter: integer("counterparty_cash_after", 64),
    appliedStateDigest: hex("applied_state_digest", 32),
  };
  if (result.owner === result.counterpartyOwner)
    throw new Error("liquidation audit cannot identify a self pair");
  if (result.insurancePaid > result.allocatedFinalLoss)
    throw new Error("insurance exceeds allocated final loss");
  return result;
}
