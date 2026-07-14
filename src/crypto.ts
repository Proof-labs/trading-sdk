import {
  getPublicKey as ed_getPublicKey,
  hashes,
  sign as ed_sign,
  verify as ed_verify,
  utils,
} from "@noble/ed25519";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha512 } from "@noble/hashes/sha2.js";

// noble/ed25519 v3 requires injecting sha512 for synchronous sign/verify
// (v2 used `etc.sha512Sync`; v3 moved the hook to `hashes.sha512`).
hashes.sha512 = sha512;

/**
 * Domain separator matching Rust: `b"ProofExchange-v3"` (16 bytes).
 * Bumped from v2 on 2026-04-23 (audit finding B4) when the envelope
 * gained a 32-byte `chain_id` binding. A v2-signed tx submitted to a
 * v3 engine verifies against different message bytes and fails —
 * protects against cross-chain and post-wipe replay.
 */
/**
 * The 16-byte signing domain prefix every v3 signing message starts with.
 * Exported so signer-side tools can recognize (and decode) a Proof signing
 * preimage before putting it in front of a human — see
 * `decodeSigningMessage()` in codec.ts. Changing this value is a MAJOR wire
 * break (see CLAUDE.md "Versioning"); it is distinct from the envelope
 * version byte (`ENVELOPE_VERSION` = 2).
 */
export const DOMAIN_PREFIX = new TextEncoder().encode("ProofExchange-v3");

/**
 * 32-byte zero chain_id — unbound chain. Production signers MUST
 * use a real chain_id (typically `keccak256(cometbft_chain_id_string)`)
 * or their signatures are trivially replayable on any other
 * zero-chain_id deployment.
 *
 * NOTE: Treat this as read-only. It is a single shared instance and
 * cannot be truly frozen — `Object.freeze` throws on a non-empty typed
 * array, and freezing the backing `ArrayBuffer` does not stop element
 * writes through the view. Do NOT mutate it; copy it (`.slice()`) first
 * if you need a writable 32-byte buffer. `ExchangeClient` defensively
 * copies before caching so an external mutation cannot corrupt its
 * signing chain_id.
 */
export const UNBOUND_CHAIN_ID = new Uint8Array(32);

/**
 * Hash a CometBFT chain_id string into the 32-byte binding used by
 * the v3 signing envelope. Matches `chain_id_from_string` in Rust
 * `crypto.rs` byte-for-byte.
 */
export function chainIdFromString(chainId: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(chainId));
}

/** Generate a new Ed25519 keypair. */
export function generateKeypair(): {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
} {
  const privateKey = utils.randomSecretKey();
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
  return bytesToHex(owner);
}

/**
 * Parse a hex string (with or without a `0x` prefix) into bytes.
 *
 * Throws on malformed input — an odd number of digits or any
 * non-hexadecimal character — rather than silently substituting zero
 * bytes (`parseInt` on bad input yields `NaN`, which coerces to `0` in a
 * `Uint8Array`). Silent corruption on a key/address/signature field is a
 * security hazard, so validate up front.
 */
export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) {
    throw new Error(`invalid hex: odd number of digits (${h.length})`);
  }
  if (h.length > 0 && !/^[0-9a-fA-F]+$/.test(h)) {
    throw new Error("invalid hex: non-hexadecimal characters");
  }
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
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
 *
 * V3 layout: `DOMAIN_PREFIX(16) || chain_id(32) || action_type(1) || seq_be(8) || payload`
 *
 * Matches Rust `signing_message()` in `crypto.rs`. The `chainId`
 * argument must be 32 bytes — usually `chainIdFromString(cometbft_chain_id)`
 * or `UNBOUND_CHAIN_ID` for unit-test-only use.
 */
export function signingMessage(
  chainId: Uint8Array,
  actionType: number,
  seq: bigint,
  payload: Uint8Array,
): Uint8Array {
  if (chainId.length !== 32) {
    throw new Error(`chain_id must be 32 bytes, got ${chainId.length}`);
  }
  const msg = new Uint8Array(
    DOMAIN_PREFIX.length + 32 + 1 + 8 + payload.length,
  );
  let offset = 0;
  msg.set(DOMAIN_PREFIX, offset);
  offset += DOMAIN_PREFIX.length;
  msg.set(chainId, offset);
  offset += 32;
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
