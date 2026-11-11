import type {
  FundInsuranceFund,
  InsuranceFundAllocation,
  WithdrawInsuranceFund,
} from "./types.js";

const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;
/** Allocation bound enforced by the engine's insurance `validate_transfer`. */
const MAX_ALLOCATIONS = 8;

function validateAccount(value: Uint8Array, field: string): void {
  if (
    !(value instanceof Uint8Array) ||
    value.length !== 20 ||
    !value.some(Boolean)
  ) {
    throw new Error(`${field} must be a 20-byte non-zero account address`);
  }
}

function validateId(value: bigint, field: string): void {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) {
    throw new Error(`${field} must be an unsigned 64-bit bigint`);
  }
}

function validateAllocations(
  allocations: InsuranceFundAllocation[],
  label: string,
): void {
  if (
    !Array.isArray(allocations) ||
    allocations.length < 1 ||
    allocations.length > MAX_ALLOCATIONS
  ) {
    throw new Error(`${label} requires 1..${MAX_ALLOCATIONS} allocations`);
  }
  let previous = -1;
  let total = 0n;
  for (const [i, allocation] of allocations.entries()) {
    if (
      !Number.isInteger(allocation.poolId) ||
      allocation.poolId <= previous ||
      allocation.poolId > 255
    ) {
      throw new Error(
        `${label} allocations[${i}].poolId must be an unsigned byte in strictly ascending order`,
      );
    }
    previous = allocation.poolId;
    if (
      typeof allocation.amount !== "bigint" ||
      allocation.amount <= 0n ||
      allocation.amount > I64_MAX
    ) {
      throw new Error(
        `${label} allocations[${i}].amount must be a positive bigint within i64::MAX`,
      );
    }
    total += allocation.amount;
    if (total > I64_MAX) throw new Error(`${label} total exceeds i64::MAX`);
  }
}

/** Mirrors proposal shape checks, not authority, balance or live-state checks. */
export function validateFundInsuranceFund(value: FundInsuranceFund): void {
  validateAccount(value.source, "insurance funding source");
  validateId(value.fundingId, "fundingId");
  validateAllocations(value.allocations, "insurance funding");
}

/** Shape checks only: quorum and pool balances remain engine checks. */
export function validateWithdrawInsuranceFund(
  value: WithdrawInsuranceFund,
): void {
  validateId(value.withdrawalId, "withdrawalId");
  validateAccount(value.recipient, "insurance withdrawal recipient");
  validateAllocations(value.allocations, "insurance withdrawal");
}
