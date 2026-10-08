/** Minimum partial-liquidation controls. No defaults or activation authority. */
export interface PartialLiquidationPolicy {
  completionTargetBps: number;
  partialPenaltyBps: number;
  maxReferenceAgeMs: bigint;
  maxReferenceSpreadBps: number;
  minReferenceSideNotional: bigint;
  maxReferenceOrders: number;
  maxBookOrders: number;
  maxCandidatePrefixes: number;
  maxCommittedFills: number;
  maxStateReads: number;
  maxStateReadBytes: number;
  stalledProgressBlocks: bigint;
}

export interface PublishLiquidationPolicy {
  expectedCurrentRevision: bigint | null;
  revision: bigint;
  policy: PartialLiquidationPolicy;
}

export interface RevokeLiquidationPolicy {
  revision: bigint;
}

export interface SetPartialLiquidationActivation {
  expectedGeneration: bigint | null;
  generation: bigint;
  revision: bigint;
  enabled: boolean;
}

export function validateSetPartialLiquidationActivation(
  command: SetPartialLiquidationActivation,
): void {
  u64(command.generation, "generation");
  u64(command.revision, "revision");
  if (command.expectedGeneration !== null)
    u64(command.expectedGeneration, "expectedGeneration");
  if (command.generation !== (command.expectedGeneration ?? 0n) + 1n)
    throw new PartialPolicyValidationError("generation");
  if (typeof command.enabled !== "boolean")
    throw new PartialPolicyValidationError("enabled");
}

export function decodeSetPartialLiquidationActivation(
  value: unknown,
): SetPartialLiquidationActivation {
  const row = tuple(value, 4, "activation");
  const command = {
    expectedGeneration:
      row[0] === null ? null : u64(row[0], "expectedGeneration"),
    generation: u64(row[1], "generation"),
    revision: u64(row[2], "revision"),
    enabled: row[3] as boolean,
  };
  validateSetPartialLiquidationActivation(command);
  return command;
}

export class PartialPolicyValidationError extends Error {
  constructor(readonly field: string) {
    super(`Invalid partial-liquidation policy field: ${field}`);
    this.name = "PartialPolicyValidationError";
  }
}

function u32(value: unknown, field: string, minimum = 1): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > 0xffff_ffff
  ) {
    throw new PartialPolicyValidationError(field);
  }
  return value;
}

function u64(value: unknown, field: string): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value))
    value = BigInt(value);
  if (
    typeof value !== "bigint" ||
    value <= 0n ||
    value > 0xffff_ffff_ffff_ffffn
  ) {
    throw new PartialPolicyValidationError(field);
  }
  return value;
}

function tuple(value: unknown, length: number, field: string): unknown[] {
  if (!Array.isArray(value) || value.length !== length)
    throw new PartialPolicyValidationError(field);
  return value as unknown[];
}

export function validatePartialLiquidationPolicy(
  policy: PartialLiquidationPolicy,
): void {
  u32(policy.completionTargetBps, "completionTargetBps", 10_001);
  u32(policy.partialPenaltyBps, "partialPenaltyBps", 0);
  if (policy.partialPenaltyBps > 100)
    throw new PartialPolicyValidationError("partialPenaltyBps");
  u64(policy.maxReferenceAgeMs, "maxReferenceAgeMs");
  u32(policy.maxReferenceSpreadBps, "maxReferenceSpreadBps");
  if (policy.maxReferenceSpreadBps > 10_000)
    throw new PartialPolicyValidationError("maxReferenceSpreadBps");
  u64(policy.minReferenceSideNotional, "minReferenceSideNotional");
  for (const field of [
    "maxReferenceOrders",
    "maxBookOrders",
    "maxCandidatePrefixes",
    "maxCommittedFills",
    "maxStateReads",
    "maxStateReadBytes",
  ] as const) {
    u32(policy[field], field);
  }
  if (policy.maxCommittedFills > policy.maxCandidatePrefixes)
    throw new PartialPolicyValidationError("maxCommittedFills");
  u64(policy.stalledProgressBlocks, "stalledProgressBlocks");
}

export function validatePublishLiquidationPolicy(
  command: PublishLiquidationPolicy,
): void {
  u64(command.revision, "revision");
  if (command.expectedCurrentRevision !== null)
    u64(command.expectedCurrentRevision, "expectedCurrentRevision");
  validatePartialLiquidationPolicy(command.policy);
}

export function validateRevokeLiquidationPolicy(
  command: RevokeLiquidationPolicy,
): void {
  u64(command.revision, "revision");
}

/** Exact positional Rust record; no omitted fields or silent legacy defaults. */
export function decodePublishLiquidationPolicy(
  value: unknown,
): PublishLiquidationPolicy {
  const row = tuple(value, 3, "publish");
  const p = tuple(row[2], 12, "policy");
  const command: PublishLiquidationPolicy = {
    expectedCurrentRevision:
      row[0] === null ? null : u64(row[0], "expectedCurrentRevision"),
    revision: u64(row[1], "revision"),
    policy: {
      completionTargetBps: u32(p[0], "completionTargetBps", 10_001),
      partialPenaltyBps: u32(p[1], "partialPenaltyBps", 0),
      maxReferenceAgeMs: u64(p[2], "maxReferenceAgeMs"),
      maxReferenceSpreadBps: u32(p[3], "maxReferenceSpreadBps"),
      minReferenceSideNotional: u64(p[4], "minReferenceSideNotional"),
      maxReferenceOrders: u32(p[5], "maxReferenceOrders"),
      maxBookOrders: u32(p[6], "maxBookOrders"),
      maxCandidatePrefixes: u32(p[7], "maxCandidatePrefixes"),
      maxCommittedFills: u32(p[8], "maxCommittedFills"),
      maxStateReads: u32(p[9], "maxStateReads"),
      maxStateReadBytes: u32(p[10], "maxStateReadBytes"),
      stalledProgressBlocks: u64(p[11], "stalledProgressBlocks"),
    },
  };
  validatePublishLiquidationPolicy(command);
  return command;
}

export function decodeRevokeLiquidationPolicy(
  value: unknown,
): RevokeLiquidationPolicy {
  const row = tuple(value, 1, "revoke");
  return { revision: u64(row[0], "revision") };
}
