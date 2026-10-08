import type {
  PublishLiquidationPolicy,
  RestartLiquidationPlan,
  ReleaseLiquidationPlan,
} from "./types.js";

const U64_MAX = (1n << 64n) - 1n;
const U32_MAX = 0xffffffff;
function u64(value: unknown): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value))
    value = BigInt(value);
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX)
    throw new Error("liquidation policy requires an unsigned 64-bit integer");
  return value;
}
function u32(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > U32_MAX
  )
    throw new Error("liquidation policy requires an unsigned 32-bit integer");
  return value;
}
function tuple(value: unknown, length: number): unknown[] {
  if (!Array.isArray(value) || value.length !== length)
    throw new Error("liquidation policy tuple length mismatch");
  return value;
}
function id(value: unknown): Uint8Array {
  const bytes =
    value instanceof Uint8Array ? Array.from(value) : tuple(value, 32);
  if (bytes.length !== 32 || bytes.some((v) => u32(v) > 255))
    throw new Error("liquidation funding snapshot ID must be 32 bytes");
  return Uint8Array.from(bytes as number[]);
}

/** Shape-only codec; quorum, checkpoint equality and current policy are on-chain checks. */
export function decodeLiquidationRestart(raw: unknown): RestartLiquidationPlan {
  const p = tuple(raw, 8);
  const owner = p[0] instanceof Uint8Array ? Array.from(p[0]) : tuple(p[0], 20);
  if (owner.length !== 20 || owner.some((v) => u32(v) > 255))
    throw new Error("liquidation owner must be 20 bytes");
  return {
    owner: Uint8Array.from(owner as number[]),
    planId: u64(p[1]),
    expectedRevision: u64(p[2]),
    expectedCheckpointHash: id(p[3]),
    expectedWindowGeneration: u64(p[4]),
    targetRevision: u64(p[5]),
    lifetimeBlocks: u64(p[6]),
    noProgressBlocks: u64(p[7]),
  };
}

export function validateLiquidationRestart(p: RestartLiquidationPlan): void {
  decodeLiquidationRestart([
    p.owner,
    p.planId,
    p.expectedRevision,
    p.expectedCheckpointHash,
    p.expectedWindowGeneration,
    p.targetRevision,
    p.lifetimeBlocks,
    p.noProgressBlocks,
  ]);
}

/** Shape only: immutable incident revision and current safety revision are distinct. */
export function decodeLiquidationRelease(raw: unknown): ReleaseLiquidationPlan {
  const p = tuple(raw, 6);
  const owner = p[0] instanceof Uint8Array ? Array.from(p[0]) : tuple(p[0], 20);
  if (owner.length !== 20 || owner.some((v) => u32(v) > 255))
    throw new Error("liquidation owner must be 20 bytes");
  return {
    owner: Uint8Array.from(owner as number[]),
    planId: u64(p[1]),
    expectedRevision: u64(p[2]),
    safetyRevision: u64(p[3]),
    expectedCheckpointHash: id(p[4]),
    expectedWindowGeneration: u64(p[5]),
  };
}

export function validateLiquidationRelease(p: ReleaseLiquidationPlan): void {
  decodeLiquidationRelease([
    p.owner,
    p.planId,
    p.expectedRevision,
    p.safetyRevision,
    p.expectedCheckpointHash,
    p.expectedWindowGeneration,
  ]);
}
/** Compact wire field order, not calibration, authority or funding proof. */
export function decodeLiquidationPolicy(
  raw: unknown,
): PublishLiquidationPolicy {
  const p = tuple(raw, 8),
    f = tuple(p[2], 3),
    r = tuple(p[3], 5);
  const w = tuple(p[6], 12),
    i = tuple(p[7], 6);
  return {
    expectedRevision: p[0] === null ? null : u64(p[0]),
    revision: u64(p[1]),
    funding: {
      id: id(f[0]),
      committedHeight: u64(f[1]),
      eligibleMicroUsdc: u64(f[2]),
    },
    reference: {
      maximumAgeMs: u64(r[0]),
      maximumBookSpreadBps: u32(r[1]),
      minimumSideNotionalMicroUsdc: u64(r[2]),
      executionCollarBps: u32(r[3]),
      referenceOrdersPerSide: u32(r[4]),
    },
    lifetimeBlocks: u64(p[4]),
    noProgressBlocks: u64(p[5]),
    work: {
      maximumPlanLegs: u32(w[0]),
      maximumOwnerOrders: u32(w[1]),
      owners: u32(w[2]),
      legs: u32(w[3]),
      levels: u32(w[4]),
      orders: u32(w[5]),
      fills: u32(w[6]),
      candidates: u32(w[7]),
      pointReads: u32(w[8]),
      indexRows: u32(w[9]),
      readBytes: u32(w[10]),
      checkpointBytes: u32(w[11]),
    },
    insurance: {
      planBps: u32(i[0]),
      ownerBps: u32(i[1]),
      marketBps: u32(i[2]),
      poolBps: u32(i[3]),
      globalBps: u32(i[4]),
      protectedFloorBps: u32(i[5]),
    },
  };
}
/** Shape only. Engine policy checks and quorum remain authoritative. */
export function validateLiquidationPolicy(p: PublishLiquidationPolicy): void {
  decodeLiquidationPolicy([
    p.expectedRevision,
    p.revision,
    [p.funding.id, p.funding.committedHeight, p.funding.eligibleMicroUsdc],
    [
      p.reference.maximumAgeMs,
      p.reference.maximumBookSpreadBps,
      p.reference.minimumSideNotionalMicroUsdc,
      p.reference.executionCollarBps,
      p.reference.referenceOrdersPerSide,
    ],
    p.lifetimeBlocks,
    p.noProgressBlocks,
    [
      p.work.maximumPlanLegs,
      p.work.maximumOwnerOrders,
      p.work.owners,
      p.work.legs,
      p.work.levels,
      p.work.orders,
      p.work.fills,
      p.work.candidates,
      p.work.pointReads,
      p.work.indexRows,
      p.work.readBytes,
      p.work.checkpointBytes,
    ],
    [
      p.insurance.planBps,
      p.insurance.ownerBps,
      p.insurance.marketBps,
      p.insurance.poolBps,
      p.insurance.globalBps,
      p.insurance.protectedFloorBps,
    ],
  ]);
}
