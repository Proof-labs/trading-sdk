import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  deriveSubAccount,
  SUB_ACCOUNT_DERIVATION_DOMAIN,
} from "./crypto.js";

/**
 * The instantiation is frozen on the Rust side (proof-wire
 * `crypto::derive_sub_account`, wire#21). These vectors are the SAME four
 * the wire crate freezes; if one fails here the TS and Rust derivations have
 * drifted and every downstream address changes — stop and reconcile.
 */
const FROZEN_VECTORS: Array<[Uint8Array, number, string]> = [
  [
    new Uint8Array(20).fill(0xaa),
    1,
    "0a886444bda9f5afa621054d9b4d6ae9c0d4bdb7",
  ],
  [
    new Uint8Array(20).fill(0x11),
    0xdeadbeef,
    "2eddfeb4b455de6de44a8340610a15defd9cab9d",
  ],
  [
    new Uint8Array(20).fill(0x00),
    2,
    "fb0de5d58603e96d7d5fea63bbd3adbf33ba97ec",
  ],
  [
    new Uint8Array(20).fill(0x42),
    0xffffffff,
    "e7209241aa6c581de222b4671f8586cf8ddf33c7",
  ],
];

describe("deriveSubAccount", () => {
  it("pins the frozen domain bytes exactly", () => {
    expect(Array.from(SUB_ACCOUNT_DERIVATION_DOMAIN)).toEqual(
      Array.from(new TextEncoder().encode("ProofExchange-sub-account-v1")),
    );
  });

  it("reproduces the frozen wire golden vectors byte-for-byte", () => {
    for (const [master, subAccountId, expected] of FROZEN_VECTORS) {
      const derived = deriveSubAccount(master, subAccountId);
      expect(derived.length).toBe(20);
      expect(bytesToHex(derived)).toBe(expected);
    }
  });

  it("encodes the id big-endian: reordering the u32 bytes changes the address", () => {
    // 0x00000001 vs 0x01000000 must not collide; the frozen vector for id 1
    // pins the big-endian order already, but assert the property directly.
    const master = new Uint8Array(20).fill(0xaa);
    const id1 = bytesToHex(deriveSubAccount(master, 1));
    const swapped = bytesToHex(
      deriveSubAccount(master, 0x01000000),
    );
    expect(id1).not.toBe(swapped);
  });

  it("never reproduces a frozen vector under a different domain string", () => {
    for (const domain of [
      "ProofExchange-sub-account-v2",
      "proofexchange-sub-account-v1",
      "ProofExchange-sub-account",
      "ProofExchange-v3",
    ]) {
      for (const [master, subAccountId, expected] of FROZEN_VECTORS) {
        // Hash the same preimage shape with a tampered domain, exactly as
        // the Rust suite does: no other domain string may reproduce a frozen
        // address, or the derived-address space collides with another
        // Keccak preimage in the system.
        const preimage = new Uint8Array(domain.length + 24);
        preimage.set(new TextEncoder().encode(domain), 0);
        preimage.set(master, domain.length);
        preimage.set(
          new Uint8Array([
            (subAccountId >>> 24) & 0xff,
            (subAccountId >>> 16) & 0xff,
            (subAccountId >>> 8) & 0xff,
            subAccountId & 0xff,
          ]),
          domain.length + 20,
        );
        const tampered = bytesToHex(keccak_256(preimage).slice(0, 20));
        expect(tampered).not.toBe(expected);
      }
    }
  });

  it("rejects malformed masters and out-of-range ids", () => {
    const master = new Uint8Array(20).fill(0xaa);
    expect(() => deriveSubAccount(new Uint8Array(19), 1)).toThrow(
      /master must be 20 bytes/,
    );
    expect(() => deriveSubAccount(new Uint8Array(21), 1)).toThrow(
      /master must be 20 bytes/,
    );
    for (const bad of [0, -1, 0x100000000, 1.5, Number.NaN]) {
      expect(() => deriveSubAccount(master, bad)).toThrow(
        /subAccountId must be an integer in 1\.\.=4294967295/,
      );
    }
    // The valid boundary accepts.
    expect(deriveSubAccount(master, 0xffffffff).length).toBe(20);
  });
});
