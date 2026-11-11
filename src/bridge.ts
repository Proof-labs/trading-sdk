/**
 * Bridge custody: the canonical payload bytes the engine's withdrawal
 * authorization binds, exposed through the WASM core.
 *
 * The byte layout is owned by the wire contract's `bridge` module
 * (`proof_wire::bridge`), the same definition the engine and the bridge program
 * compile, so the SDK hashes exactly the bytes the engine binds. The frozen
 * vectors in `bridge.test.ts` pin the marshalling.
 *
 * The wire-12 vote model retired the receipt-era surfaces this module used to
 * carry (`encodeBridgeReceipt`, `signOperatorReceipt`, the terminal/quorum
 * wire-byte constants): registry members now vote
 * `VoteWithdrawalPaid` / `VoteDeposit` and sign the canonical vote message
 * from the core's `bridge_votes` helpers — see `voteWithdrawalPaidMessage` /
 * `voteDepositMessage` in the Python SDK and the `Vote*` action types.
 */

import { getWasm } from "./wasm-loader.js";

/** Total length of a canonical `WithdrawalAuthorizationV1`. Fixed by construction. */
export const WITHDRAWAL_AUTHORIZATION_LEN = 221;

/**
 * What the withdrawal authorization binds — mirror of
 * `bridge_core::WithdrawalAuthorizationV1` (frozen v1 contract, 221 encoded
 * bytes). `withdrawalAuthorizationDigest` of these fields is the
 * authorization identity the engine binds to a withdrawal's sidecar.
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

/** u8 wire byte for `VaultTier::Hot`. */
export const VAULT_TIER_HOT = 1;
/** u8 wire byte for `VaultTier::Warm`. */
export const VAULT_TIER_WARM = 2;
/** u8 wire byte for `VaultTier::Cold`. */
export const VAULT_TIER_COLD = 3;
