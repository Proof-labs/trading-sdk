import { describe, expect, it } from "vitest";
import {
  VAULT_TIER_HOT,
  WITHDRAWAL_AUTHORIZATION_LEN,
  encodeWithdrawalAuthorization,
  withdrawalAuthorizationDigest,
} from "./bridge";

/**
 * Frozen vectors printed from bridge-core at the tag the engine's Cargo.lock
 * resolves (v1.0.0): fixed fields, canonical encode, SHA-256 digest. The
 * encode fn must reproduce these byte-for-byte — a layout drift here is a
 * signing break, not a decode inconvenience.
 */
const AUTH_HEX =
  "6272696467652e7769746864726177616c2e76310000000000000000000000001111111111111111111111111111111111111111111111111111111111111111012a000000000000000102030405060708090a0b0c0d0e0f1011121314a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b240420f0000000000581b00000000000068360200000000000300000000000000a0bb0d0000000000583e0f0000000000800e8069000000000060816900000000";
const AUTH_DIGEST_HEX =
  "bcb12031ff6652086a3c4f29c6f11122421d992d5b841519e342cee85fa8fdb4";

const HEX = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "hex"));

/** The exact fields the Rust vector printer used. */
const auth = {
  deploymentId: HEX("11".repeat(32)),
  vaultTier: VAULT_TIER_HOT,
  withdrawalId: 42n,
  proofOwner: HEX("0102030405060708090a0b0c0d0e0f1011121314"),
  destinationOwner: HEX("a1".repeat(32)),
  destinationTokenAcct: HEX("b2".repeat(32)),
  amountMicroUsdc: 1_000_000n,
  feeMicroUsdc: 7_000n,
  engineHeight: 145_000n,
  signerEpoch: 3n,
  notBeforeSlot: 900_000n,
  expiresAtSlot: 999_000n,
  notBeforeUnixSeconds: 1_770_000_000n,
  expiresAtUnixSeconds: 1_770_086_400n,
};

describe("bridge-core v1 canonical encoders", () => {
  it("reproduces the Rust WithdrawalAuthorizationV1 encode byte-for-byte", () => {
    const bytes = encodeWithdrawalAuthorization(auth);
    expect(bytes).toHaveLength(WITHDRAWAL_AUTHORIZATION_LEN);
    expect(Buffer.from(bytes).toString("hex")).toBe(AUTH_HEX);
    // Layout spot checks: domain, tier byte, the LE u64s.
    expect([...bytes.slice(0, 20)]).toEqual([
      ...new TextEncoder().encode("bridge.withdrawal.v1"),
    ]);
    expect(bytes[64]).toBe(VAULT_TIER_HOT);
    expect(bytes[65]).toBe(42);
  });

  it("reproduces the Rust SHA-256 authorization digest", () => {
    expect(
      Buffer.from(withdrawalAuthorizationDigest(auth)).toString("hex"),
    ).toBe(AUTH_DIGEST_HEX);
  });

  it("fails closed on any wrong-width field", () => {
    const short = {
      ...auth,
      deploymentId: auth.deploymentId.slice(1),
    };
    expect(() => encodeWithdrawalAuthorization(short)).toThrow(/deploymentId/);
    const badOwner = {
      ...auth,
      proofOwner: HEX("00".repeat(19)),
    };
    expect(() => encodeWithdrawalAuthorization(badOwner)).toThrow(/proofOwner/);
    // Numeric range is the deserializer's contract: a value that cannot be a
    // u64/i64 is refused before any byte is written.
    const negative = { ...auth, amountMicroUsdc: -1n };
    expect(() => encodeWithdrawalAuthorization(negative)).toThrow(/u64/);
    const u64Overflow = { ...auth, withdrawalId: 1n << 64n };
    expect(() => encodeWithdrawalAuthorization(u64Overflow)).toThrow(/u64/);
    const i64Overflow = { ...auth, expiresAtUnixSeconds: 1n << 63n };
    expect(() => encodeWithdrawalAuthorization(i64Overflow)).toThrow(/i64/);
    // Unknown enum wire bytes fail closed too.
    const badTier = { ...auth, vaultTier: 9 };
    expect(() => encodeWithdrawalAuthorization(badTier)).toThrow(/vaultTier/);
  });
});
