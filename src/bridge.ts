/**
 * Bridge custody: the canonical bridge-core v1 payload bytes the engine's
 * receipt path signs and verifies, exposed through the WASM core.
 *
 * The byte layout is owned by Rust (`bridge-core` v1.0.0, the tag the
 * exchange engine's Cargo.lock resolves — the same dependency line
 * exchange-core carries). The exchange wire crate refuses a bridge-core
 * dependency by its hygiene gate, so the canonical bytes are reachable only
 * from the WASM core; calling it means the SDK signs exactly the bytes the
 * engine verifies, by construction — no parallel layout to drift. The
 * frozen vectors in `bridge.test.ts` pin the marshalling.
 *
 * The ed25519 quorum proof stays TypeScript-side (`signOperatorReceipt`):
 * keys never enter the bridge payload path, and the signature is over the
 * canonical message these functions produce.
 */

import { sign } from "./crypto.js";
import { getWasm } from "./wasm-loader.js";
import type { BridgeWithdrawalReceipt, OperatorReceiptProof } from "./types.js";

/** Total length of a canonical `WithdrawalAuthorizationV1`. Fixed by construction. */
export const WITHDRAWAL_AUTHORIZATION_LEN = 221;
/** Total length of a canonical `BridgeReceiptV1`. Fixed by construction. */
export const BRIDGE_RECEIPT_LEN = 327;

/**
 * What a quorum signs to release one withdrawal — mirror of
 * `bridge_core::WithdrawalAuthorizationV1` (frozen v1 contract, 221 encoded
 * bytes). The engine's `AuthorizeWithdrawal` binds
 * {@link withdrawalAuthorizationDigest} of these fields to the withdrawal's
 * sidecar; a terminal receipt must carry the same digest.
 */
export interface WithdrawalAuthorizationV1 {
  /** 32-byte deployment identity — pins Proof/Solana genesis, program, mint. */
  deploymentId: Uint8Array;
  /** Vault tier wire byte: `1 = Hot`, `2 = Warm`, `3 = Cold`. */
  vaultTier: number;
  /** Engine-assigned withdrawal ID. */
  withdrawalId: bigint;
  /** 20-byte internal account that was debited. */
  proofOwner: Uint8Array;
  /** 32-byte Solana destination wallet. */
  destinationOwner: Uint8Array;
  /** 32-byte Solana destination token account. */
  destinationTokenAcct: Uint8Array;
  /** Destination amount in microUSDC (6 dp). */
  amountMicroUsdc: bigint;
  /** Flat protocol fee in microUSDC (6 dp), retained in the tier vault. */
  feeMicroUsdc: bigint;
  /** Proof block height at which the debit was recorded. */
  engineHeight: bigint;
  /** Signer-registry epoch that authorized the request. */
  signerEpoch: bigint;
  /** Execution may not happen before this Solana slot. */
  notBeforeSlot: bigint;
  /** Execution may not happen after this Solana slot. */
  expiresAtSlot: bigint;
  /** Execution may not happen before this unix second. */
  notBeforeUnixSeconds: bigint;
  /** Execution may not happen after this unix second. */
  expiresAtUnixSeconds: bigint;
}

/**
 * The canonical `WithdrawalAuthorizationV1` bytes — byte-for-byte Rust
 * `encode()`: domain, fields in declaration order, little-endian u64/i64
 * widths, tier as its wire byte. Throws naming the offending field on any
 * wrong-width input (a silently shifted field would corrupt every later one
 * in the fixed layout).
 */
export function encodeWithdrawalAuthorization(
  auth: WithdrawalAuthorizationV1,
): Uint8Array {
  return getWasm().encode_withdrawal_authorization(auth);
}

/**
 * `SHA256(canonical bytes)` — the authorization identity the engine binds
 * (byte-for-byte Rust `digest::<RustCrypto>()`).
 */
export function withdrawalAuthorizationDigest(
  auth: WithdrawalAuthorizationV1,
): Uint8Array {
  return getWasm().withdrawal_authorization_digest(auth);
}

/**
 * The canonical `BridgeReceiptV1` bytes — the message the operator quorum
 * signs and the engine re-encodes from the submitted
 * {@link BridgeWithdrawalReceipt} fields before verifying that quorum.
 * Byte-for-byte Rust `encode()`; throws naming the offending field.
 */
export function encodeBridgeReceipt(
  receipt: BridgeWithdrawalReceipt,
): Uint8Array {
  return getWasm().encode_bridge_receipt(receipt);
}

/** u8 wire byte for `TerminalState::Paid` (bridge-core frozen discriminants). */
export const TERMINAL_PAID = 1;
/** u8 wire byte for `TerminalState::Cancelled`. */
export const TERMINAL_CANCELLED = 2;
/** u8 wire byte for `ReceiptQuorumKind::OperatorMOfN`. */
export const QUORUM_OPERATOR_M_OF_N = 1;
/** u8 wire byte for `VaultTier::Hot`. */
export const VAULT_TIER_HOT = 1;
/** u8 wire byte for `VaultTier::Warm`. */
export const VAULT_TIER_WARM = 2;
/** u8 wire byte for `VaultTier::Cold`. */
export const VAULT_TIER_COLD = 3;

/**
 * Sign the canonical receipt bytes with a subset of the operator registry
 * and assemble the wire proof: one bit per signer in the registry's index
 * order (`ceil(registryLen / 8)` bytes, unused high bits zero), one 64-byte
 * signature per set bit in ascending set-bit order. The engine resolves the
 * bitmap against the bound epoch's registry and verifies each signature
 * strictly (canonical `s`, no small-order keys) — a signature from a key
 * outside the registry fails closed there.
 *
 * @param message the canonical bytes from {@link encodeBridgeReceipt}
 * @param signers secret keys (32-byte seeds) with their registry indexes
 * @param registryLen the bound registry's operator count
 * @throws on an out-of-range index, a duplicate index, or an empty signer
 * list — a proof the engine would refuse is refused here, before any wire
 * traffic.
 */
export function signOperatorReceipt(
  message: Uint8Array,
  signers: ReadonlyArray<{ index: number; secretKey: Uint8Array }>,
  registryLen: number,
): OperatorReceiptProof {
  if (signers.length === 0) {
    throw new Error("an operator proof needs at least one signer");
  }
  if (!Number.isInteger(registryLen) || registryLen < 1) {
    throw new Error(
      `registryLen must be a positive integer, got ${registryLen}`,
    );
  }
  const bitmap = new Uint8Array(Math.ceil(registryLen / 8));
  const seen = new Set<number>();
  const byIndex = [...signers].sort((a, b) => a.index - b.index);
  const signatures: Uint8Array[] = [];
  for (const { index, secretKey } of byIndex) {
    if (!Number.isInteger(index) || index < 0 || index >= registryLen) {
      throw new Error(
        `signer index ${index} out of range for registry of ${registryLen}`,
      );
    }
    if (seen.has(index)) {
      throw new Error(`duplicate signer index ${index}`);
    }
    seen.add(index);
    bitmap[index >> 3] |= 1 << (index % 8);
    signatures.push(sign(secretKey, message));
  }
  return { signerBitmap: bitmap, signatures };
}
