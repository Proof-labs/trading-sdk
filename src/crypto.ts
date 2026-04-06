import {
  etc,
  getPublicKey as ed_getPublicKey,
  sign as ed_sign,
  verify as ed_verify,
  utils,
} from "@noble/ed25519";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha512 } from "@noble/hashes/sha512";

// noble/ed25519 v2 requires setting the sha512 hash for sync operations
etc.sha512Sync = (...msgs: Uint8Array[]) => {
  const h = sha512.create();
  for (const m of msgs) h.update(m);
  return h.digest();
};

/** Domain separator matching Rust: b"ProofExchange-v2" (16 bytes) */
const DOMAIN_PREFIX = new TextEncoder().encode("ProofExchange-v2");

/** Generate a new Ed25519 keypair. */
export function generateKeypair(): {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
} {
  const privateKey = utils.randomPrivateKey();
  const publicKey = ed_getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/** Get public key from private key. */
export function getPublicKey(privateKey: Uint8Array): Uint8Array {
  return ed_getPublicKey(privateKey);
}

/**
 * Derive 20-byte owner address from 32-byte Ed25519 public key.
 * keccak256(pubkey)[12..32] — matches Rust `pubkey_to_owner`.
 */
export function pubkeyToOwner(pubkey: Uint8Array): Uint8Array {
  const hash = keccak_256(pubkey);
  return hash.slice(12, 32);
}

/** Convert a 20-byte address to hex string. */
export function ownerToHex(owner: Uint8Array): string {
  return Array.from(owner)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Parse a hex string into bytes. */
export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.substr(i * 2, 2), 16);
  }
  return bytes;
}

/** Convert bytes to hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Construct the deterministic signing message for a transaction.
 * Layout: DOMAIN_PREFIX || action_type(1) || seq_be(8) || payload
 * Matches Rust `signing_message()` in crypto.rs.
 */
export function signingMessage(
  actionType: number,
  seq: bigint,
  payload: Uint8Array,
): Uint8Array {
  const msg = new Uint8Array(DOMAIN_PREFIX.length + 1 + 8 + payload.length);
  let offset = 0;
  msg.set(DOMAIN_PREFIX, offset);
  offset += DOMAIN_PREFIX.length;
  msg[offset++] = actionType;
  // seq as big-endian u64
  const view = new DataView(msg.buffer, msg.byteOffset + offset, 8);
  view.setBigUint64(0, seq, false); // false = big-endian
  offset += 8;
  msg.set(payload, offset);
  return msg;
}

/** Sign a message with Ed25519. Returns 64-byte signature. */
export function sign(privateKey: Uint8Array, message: Uint8Array): Uint8Array {
  return ed_sign(message, privateKey);
}

/** Verify an Ed25519 signature. */
export function verify(
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): boolean {
  return ed_verify(signature, message, publicKey);
}
