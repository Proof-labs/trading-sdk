import type { ScheduleUpgrade } from "./types.js";

const U64_MAX = (1n << 64n) - 1n;
const U32_MAX = 0xffff_ffff;
const SHA256_LEN = 32;

function isU32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= U32_MAX;
}

/** Mirror the engine's state-independent validate_schedule_upgrade rules.
 * Height ordering and the release-above-active rule remain engine checks. */
export function validateScheduleUpgrade(action: ScheduleUpgrade): void {
  const height = action.targetHeight;
  if (typeof height !== "bigint" || height < 0n || height > U64_MAX) {
    throw new Error("targetHeight must be an unsigned 64-bit bigint");
  }
  if (!isU32(action.major) || action.major === 0) {
    throw new Error("major must be a non-zero unsigned 32-bit integer");
  }
  if (!isU32(action.minor)) {
    throw new Error("minor must be an unsigned 32-bit integer");
  }
  const sha = action.successorSha256;
  if (!(sha instanceof Uint8Array) || sha.length !== SHA256_LEN) {
    throw new Error(`successorSha256 must be ${SHA256_LEN} bytes`);
  }
  if (sha.every((b) => b === 0)) {
    throw new Error("successorSha256 must not be all-zero");
  }
}
