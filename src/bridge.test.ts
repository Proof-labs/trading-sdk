import { describe, expect, it } from "vitest";
import {
  BRIDGE_RECEIPT_LEN,
  QUORUM_OPERATOR_M_OF_N,
  TERMINAL_PAID,
  VAULT_TIER_HOT,
  WITHDRAWAL_AUTHORIZATION_LEN,
  encodeBridgeReceipt,
  encodeWithdrawalAuthorization,
  signOperatorReceipt,
  withdrawalAuthorizationDigest,
} from "./bridge";
import { getPublicKey, sign } from "./crypto";
import type { BridgeWithdrawalReceipt } from "./types";

/**
 * Frozen vectors printed from bridge-core at the tag the engine's Cargo.lock
 * resolves (v1.0.0): fixed fields, canonical encode, SHA-256 digest. The
 * encode fns must reproduce these byte-for-byte — a layout drift here is a
 * signing break, not a decode inconvenience.
 */
const AUTH_HEX =
  "6272696467652e7769746864726177616c2e76310000000000000000000000001111111111111111111111111111111111111111111111111111111111111111012a000000000000000102030405060708090a0b0c0d0e0f1011121314a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b240420f0000000000581b00000000000068360200000000000300000000000000a0bb0d0000000000583e0f0000000000800e8069000000000060816900000000";
const AUTH_DIGEST_HEX =
  "bcb12031ff6652086a3c4f29c6f11122421d992d5b841519e342cee85fa8fdb4";
const RECEIPT_HEX =
  "6272696467652e7769746864726177616c2d726563656970742e7631000000001111111111111111111111111111111111111111111111111111111111111111bcb12031ff6652086a3c4f29c6f11122421d992d5b841519e342cee85fa8fdb42a0000000000000001010102030405060708090a0b0c0d0e0f1011121314a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b240420f0000000000581b00000000000003000000000000005a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a94bd0d0000000000c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3010300000000000000";

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

const receipt: BridgeWithdrawalReceipt = {
  deploymentId: auth.deploymentId,
  authorizationDigest: withdrawalAuthorizationDigest(auth),
  withdrawalId: 42n,
  terminalState: TERMINAL_PAID,
  vaultTier: VAULT_TIER_HOT,
  proofOwner: auth.proofOwner,
  destinationOwner: auth.destinationOwner,
  destinationTokenAcct: auth.destinationTokenAcct,
  amountMicroUsdc: 1_000_000n,
  feeMicroUsdc: 7_000n,
  authorizationSignerEpoch: 3n,
  solanaTxSignature: HEX("5a".repeat(64)),
  finalizedSlot: 900_500n,
  finalizedBlockhash: HEX("c3".repeat(32)),
  receiptQuorumKind: QUORUM_OPERATOR_M_OF_N,
  receiptAuthorityEpoch: 3n,
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

  it("reproduces the Rust BridgeReceiptV1 encode byte-for-byte", () => {
    const bytes = encodeBridgeReceipt(receipt);
    expect(bytes).toHaveLength(BRIDGE_RECEIPT_LEN);
    expect(Buffer.from(bytes).toString("hex")).toBe(RECEIPT_HEX);
    // The receipt embeds the authorization digest at its fixed offset.
    expect([...bytes.slice(64, 96)]).toEqual([...receipt.authorizationDigest]);
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
    const badSig = {
      ...receipt,
      solanaTxSignature: HEX("5a".repeat(63)),
    };
    expect(() => encodeBridgeReceipt(badSig)).toThrow(/solanaTxSignature/);
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
    const badTerminal = { ...receipt, terminalState: 9 };
    expect(() => encodeBridgeReceipt(badTerminal)).toThrow(/terminalState/);
  });
});

describe("operator receipt proof assembly", () => {
  // Monobyte seeds, the same construction the engine tests sign with.
  const seed = (b: number): Uint8Array => new Uint8Array(32).fill(b);
  const message = encodeBridgeReceipt(receipt);
  const registryLen = 6;

  it("builds a registry-ordered bitmap and ascending signatures", async () => {
    const keys = [0x90, 0x91, 0x92, 0x93, 0x94, 0x95].map(seed);
    const proof = signOperatorReceipt(
      message,
      [
        { index: 3, secretKey: keys[3] },
        { index: 0, secretKey: keys[0] },
        { index: 2, secretKey: keys[2] },
      ],
      registryLen,
    );
    // Bits 0, 2, 3 set: 0b001101. ceil(6/8) = 1 byte, high bits zero.
    expect([...proof.signerBitmap]).toEqual([0b0000_1101]);
    expect(proof.signatures).toHaveLength(3);
    for (const sig of proof.signatures) {
      expect(sig).toHaveLength(64);
    }
    // Ascending set-bit order: signature 0 is signer 0's, 1 is signer 2's.
    const expected = [0, 2, 3].map((i) => sign(keys[i], message));
    expect(proof.signatures.map((s) => Buffer.from(s).toString("hex"))).toEqual(
      expected.map((s) => Buffer.from(s).toString("hex")),
    );
    // And the signatures verify against the derived registry keys.
    for (const [i, sig] of proof.signatures.entries()) {
      const index = [0, 2, 3][i];
      const ok = await import("@noble/ed25519").then((ed) =>
        ed.verify(sig, message, getPublicKey(keys[index])),
      );
      expect(ok).toBe(true);
    }
  });

  it("refuses proofs the engine would refuse", () => {
    const keys = [0x90, 0x91].map(seed);
    expect(() => signOperatorReceipt(message, [], registryLen)).toThrow(
      /at least one signer/,
    );
    expect(() =>
      signOperatorReceipt(
        message,
        [{ index: 6, secretKey: keys[0] }],
        registryLen,
      ),
    ).toThrow(/out of range/);
    expect(() =>
      signOperatorReceipt(
        message,
        [
          { index: 1, secretKey: keys[0] },
          { index: 1, secretKey: keys[1] },
        ],
        registryLen,
      ),
    ).toThrow(/duplicate/);
    expect(() =>
      signOperatorReceipt(message, [{ index: 0, secretKey: keys[0] }], 0),
    ).toThrow(/registryLen/);
  });
});
