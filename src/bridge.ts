/**
 * Bridge custody: the messages bridge operators sign, and the canonical
 * payload bytes the engine's withdrawal authorization binds, through the
 * WASM core.
 *
 * Byte layouts are owned by the wire contract (`proof_wire`), the same
 * definitions the engine compiles, so the SDK signs and hashes exactly the
 * bytes the engine checks. The shared vectors in `conformance/` pin them
 * across Rust, TypeScript and Python.
 *
 * A bridge operator's only identity is its registry key. It signs five
 * messages, each submitted on its own; the engine counts the distinct
 * operators whose signature verifies against the named epoch's roster. The
 * signature is the message's authority, not the envelope's, so any envelope
 * signer may submit a signed message.
 */

import { getWasm } from "./wasm-loader.js";
import type {
  DepositLocator,
  RecordWithdrawalPayout,
  VoteDeposit,
  VotePauseBridge,
  VoteWithdrawalPaid,
  VoteWithdrawalPayoutDead,
} from "./types.js";

/** Signs the exact preimage the core produced with the operator's registry
 *  key. May be asynchronous, so a key behind an HSM, KMS or remote signer
 *  (an `ExternalSigner.signRaw`) works unchanged. */
export type BridgeMessageSigner = (
  message: Uint8Array,
) => Uint8Array | Promise<Uint8Array>;

/** What every bridge-operator message binds: the deployment and chain it
 *  cannot replay across, and the registry epoch whose roster judges it. */
export interface BridgeBinding {
  /** The bridge deployment, as the registry names it (32 bytes). */
  deploymentId: Uint8Array;
  /** The chain id the envelope is signed for (32 bytes). */
  chainId: Uint8Array;
  registryEpoch: bigint;
}

/** One recorded Squads payout of one withdrawal. */
export interface PayoutIdentity {
  withdrawalId: bigint;
  /** The governed Squads vault the payout pays from (32 bytes). */
  vault: Uint8Array;
  /** The Squads vault-transaction index of the payout proposal. */
  squadsTransactionIndex: number;
}

/** One bridge-operator message's signed fields, tagged by `kind`. */
export type BridgeMessageFields =
  | ({ kind: "withdrawalPaid" } & PayoutIdentity & BridgeBinding)
  | ({ kind: "withdrawalPayoutDead" } & PayoutIdentity & BridgeBinding)
  | ({ kind: "payoutRecord" } & PayoutIdentity & BridgeBinding)
  | ({
      kind: "deposit";
      /** The receiving engine account (20 bytes). */
      owner: Uint8Array;
      amountMicroUsdc: bigint;
      /** The observed Solana transfer signature (64 bytes). */
      solanaTxSig: Uint8Array;
      /** Absent is the legacy reading (top-level instruction 0). */
      locator?: DepositLocator | null;
    } & BridgeBinding)
  | ({ kind: "pauseBridge"; signedAtMs: bigint } & BridgeBinding);

/** The canonical bytes an operator signs for one message: the wire
 *  contract's `vote_message` / `record_message`. Throws naming the field on
 *  a wrong-width input. */
export function bridgeMessagePreimage(fields: BridgeMessageFields): Uint8Array {
  const { locator, ...rest } = fields as BridgeMessageFields & {
    locator?: DepositLocator | null;
  };
  return getWasm().bridge_message_preimage(
    fields.kind === "deposit" && locator != null ? { ...rest, locator } : rest,
  );
}

async function sign(
  signer: BridgeMessageSigner,
  fields: BridgeMessageFields,
): Promise<Uint8Array> {
  const signature = await signer(bridgeMessagePreimage(fields));
  if (!(signature instanceof Uint8Array) || signature.length !== 64) {
    throw new Error(
      "bridge message signer must return exactly 64 signature bytes",
    );
  }
  return signature;
}

/** Sign one operator's vote to settle a withdrawal `Paid`. */
export async function signVoteWithdrawalPaid(
  signer: BridgeMessageSigner,
  payout: PayoutIdentity,
  binding: BridgeBinding,
): Promise<VoteWithdrawalPaid> {
  const fields = { ...payout, ...binding };
  return {
    ...fields,
    signature: await sign(signer, { kind: "withdrawalPaid", ...fields }),
  };
}

/** Sign one operator's record of the Squads payout it proposed.
 *  `binding.registryEpoch` is the epoch the proposal was made under. */
export async function signRecordWithdrawalPayout(
  signer: BridgeMessageSigner,
  payout: PayoutIdentity,
  binding: BridgeBinding,
): Promise<RecordWithdrawalPayout> {
  const fields = { ...payout, ...binding };
  return {
    ...fields,
    signature: await sign(signer, { kind: "payoutRecord", ...fields }),
  };
}

/** Sign one operator's vote that a recorded payout was rejected, so its
 *  slot can be cleared. */
export async function signVoteWithdrawalPayoutDead(
  signer: BridgeMessageSigner,
  payout: PayoutIdentity,
  binding: BridgeBinding,
): Promise<VoteWithdrawalPayoutDead> {
  const fields = { ...payout, ...binding };
  return {
    ...fields,
    signature: await sign(signer, { kind: "withdrawalPayoutDead", ...fields }),
  };
}

/** Sign one operator's vote to credit one observed deposit. Two operators
 *  voting on the same observation sign identical bytes. */
export async function signVoteDeposit(
  signer: BridgeMessageSigner,
  deposit: Omit<
    VoteDeposit,
    "deploymentId" | "chainId" | "registryEpoch" | "signature"
  >,
  binding: BridgeBinding,
): Promise<VoteDeposit> {
  const fields = { ...deposit, ...binding };
  return {
    ...fields,
    signature: await sign(signer, { kind: "deposit", ...fields }),
  };
}

/** Sign one operator's vote to pause the bridge. `signedAtMs` is the Unix
 *  time in milliseconds the operator signs at: the engine refuses a vote
 *  signed before the bridge's last unpause or after the executing block. */
export async function signVotePauseBridge(
  signer: BridgeMessageSigner,
  signedAtMs: bigint,
  binding: BridgeBinding,
): Promise<VotePauseBridge> {
  const fields = { signedAtMs, ...binding };
  return {
    ...fields,
    signature: await sign(signer, { kind: "pauseBridge", ...fields }),
  };
}

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
