import type { FundInsuranceFund, WithdrawInsuranceFund } from "./types.js";

const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;
const MAX_ENTRIES = 8;

function address(value: Uint8Array): void {
  if (
    !(value instanceof Uint8Array) ||
    value.length !== 20 ||
    !value.some(Boolean)
  ) {
    throw new Error("account address must be 20 bytes and non-zero");
  }
}

/** Mirrors proposal shape checks, not authority, balance or live-state checks. */
export function validateFundInsuranceFund(value: FundInsuranceFund): void {
  address(value.source);
  if (
    typeof value.fundingId !== "bigint" ||
    value.fundingId < 0n ||
    value.fundingId > U64_MAX
  ) {
    throw new Error("fundingId must be an unsigned 64-bit bigint");
  }
  if (
    !Array.isArray(value.allocations) ||
    value.allocations.length < 1 ||
    value.allocations.length > MAX_ENTRIES
  ) {
    throw new Error("insurance funding requires 1..8 allocations");
  }
  let previous = -1;
  let total = 0n;
  for (const allocation of value.allocations) {
    if (
      !Number.isInteger(allocation.poolId) ||
      allocation.poolId <= previous ||
      allocation.poolId > 255
    ) {
      throw new Error(
        "pool IDs must be unsigned bytes in strictly ascending order",
      );
    }
    previous = allocation.poolId;
    if (
      typeof allocation.amount !== "bigint" ||
      allocation.amount <= 0n ||
      allocation.amount > I64_MAX
    ) {
      throw new Error(
        "funding amounts must be positive signed-64-bit-compatible bigints",
      );
    }
    total += allocation.amount;
    if (total > I64_MAX) throw new Error("funding total exceeds i64::MAX");
  }
}

/** Shape checks only: quorum and pool balances remain engine checks. */
export function validateWithdrawInsuranceFund(
  value: WithdrawInsuranceFund,
): void {
  if (
    typeof value.withdrawalId !== "bigint" ||
    value.withdrawalId < 0n ||
    value.withdrawalId > U64_MAX
  ) {
    throw new Error("withdrawalId must be an unsigned 64-bit bigint");
  }
  validateFundInsuranceFund({
    fundingId: value.withdrawalId,
    source: value.recipient,
    allocations: value.allocations,
  });
}
