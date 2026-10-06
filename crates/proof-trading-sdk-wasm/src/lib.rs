//! WebAssembly bindings for the `proof-trading-sdk` Rust core.
//!
//! This is the JS/WASM spoke of the wheel-and-spokes SDK (the sibling of the
//! PyO3 crate). It exposes the value-bearing codec + signing path through the
//! authoritative Rust core so the TypeScript SDK produces bytes that are
//! **identical to the exchange engine by construction** — see
//! `docs/adr/0001-wasm-core-vs-parallel-types.md`.
//!
//! The `encode_payload` / `decode_payload` bridge uses `serde_wasm_bindgen`
//! exactly where the PyO3 crate uses `pythonize`: it hands the core's
//! `encode_payload_dyn` / `decode_payload_dyn` a serde (de)serializer over a
//! JS value, so there is no per-language field-order reimplementation.

extern crate proof_trading_sdk as core_sdk;

use core_sdk::codec;
use core_sdk::crypto;
use core_sdk::governance;
use core_sdk::types::ExecError;
use wasm_bindgen::prelude::*;

/// Map a core `ExecError` to a JS exception without leaking key material.
fn to_js(e: ExecError) -> JsError {
    JsError::new(&format!("{e:?}"))
}

fn arr32(bytes: &[u8], what: &str) -> Result<[u8; 32], JsError> {
    bytes
        .try_into()
        .map_err(|_| JsError::new(&format!("{what} must be exactly 32 bytes")))
}

fn arr64(bytes: &[u8], what: &str) -> Result<[u8; 64], JsError> {
    bytes
        .try_into()
        .map_err(|_| JsError::new(&format!("{what} must be exactly 64 bytes")))
}

/// Encode a structured action payload (a JS object with the core's snake_case
/// field names) into authoritative MessagePack wire bytes, via the core's
/// `encode_payload_dyn`. The returned bytes match `rmp-serde` — and therefore
/// the exchange engine — byte-for-byte.
#[wasm_bindgen]
pub fn encode_payload(action_type: u8, fields: JsValue) -> Result<Vec<u8>, JsError> {
    let de = serde_wasm_bindgen::Deserializer::from(fields);
    codec::encode_payload_dyn(action_type, de).map_err(to_js)
}

/// Decode MessagePack payload bytes for `action_type` back into a JS object,
/// via the core's `decode_payload_dyn`. Inverse of [`encode_payload`].
#[wasm_bindgen]
pub fn decode_payload(action_type: u8, payload: &[u8]) -> Result<JsValue, JsError> {
    // Serialize 64-bit ints as JS BigInt so u64 fields past 2^53 (e.g. price /
    // quantity) survive without being rounded to the nearest f64. Smaller ints
    // (u32 market ids, bps) still come back as plain Numbers — matching the TS
    // `types.ts` field types (number vs bigint).
    let ser = serde_wasm_bindgen::Serializer::new().serialize_large_number_types_as_bigints(true);
    codec::decode_payload_dyn(action_type, payload, &ser).map_err(to_js)
}

/// Strict, type-preserving MessagePack preflight for gateway read payloads.
///
/// Rejects the float families (`0xca` f32 / `0xcb` f64) that the JS decoder
/// would otherwise fold into a plain number — letting an integral float pass a
/// `Number.isSafeInteger` check where Python keeps it distinct — along with
/// extensions, non-UTF-8 strings, duplicate map keys, over-deep nesting and
/// trailing bytes. See `proof_trading_sdk::msgpack`.
#[wasm_bindgen]
pub fn reject_floats(bytes: &[u8]) -> Result<(), JsError> {
    core_sdk::msgpack::reject_floats(bytes).map_err(|e| JsError::new(&e.to_string()))
}

/// Build the deterministic signing message
/// (`DOMAIN_PREFIX || chain_id || action_type || seq_be || payload`).
#[wasm_bindgen]
pub fn signing_message(
    chain_id: &[u8],
    action_type: u8,
    seq: u64,
    payload: &[u8],
) -> Result<Vec<u8>, JsError> {
    let cid = arr32(chain_id, "chain_id")?;
    Ok(crypto::signing_message(&cid, action_type, seq, payload))
}

/// Assemble a signed wire envelope from a pre-computed pubkey + signature.
#[wasm_bindgen]
pub fn encode_signed_tx(
    action_type: u8,
    payload: &[u8],
    seq: u64,
    pubkey: &[u8],
    signature: &[u8],
) -> Result<Vec<u8>, JsError> {
    let pk = arr32(pubkey, "pubkey")?;
    let sig = arr64(signature, "signature")?;
    codec::encode_signed_tx_raw(action_type, payload, seq, &pk, &sig).map_err(to_js)
}

/// Sign a pre-encoded payload with `secret_key` and assemble the signed wire
/// envelope — the whole value-bearing path in the authoritative core. The key
/// is used to build a deterministic Ed25519 signature and is not retained.
#[wasm_bindgen]
pub fn sign_and_encode(
    chain_id: &[u8],
    action_type: u8,
    payload: &[u8],
    seq: u64,
    secret_key: &[u8],
) -> Result<Vec<u8>, JsError> {
    let cid = arr32(chain_id, "chain_id")?;
    let sk = arr32(secret_key, "secret_key")?;
    let signing_key = ed25519_dalek::SigningKey::from_bytes(&sk);
    codec::sign_and_encode_payload(&cid, action_type, payload, seq, &signing_key).map_err(to_js)
}

/// Recompute the engine's §2.4 domain-separated admin-proposal content hash
/// (`PROOF_ADMIN_PROPOSAL_V1` preimage) in the authoritative core, so an
/// approving client can verify a proposal's `content_hash` locally instead of
/// trusting a server-supplied value. `action` is the serde map form
/// (`{ Variant: { snake_case_fields } }`), the same shape [`encode_payload`]
/// takes for the governance actions' `action` field.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)] // mirrors the core hash preimage, field for field
pub fn admin_proposal_content_hash(
    chain_id: &[u8],
    proposal_id: u64,
    registry_version: u64,
    threshold: u32,
    proposer: &[u8],
    created_height: u64,
    created_ms: u64,
    expiry_ms: u64,
    action: JsValue,
) -> Result<Vec<u8>, JsError> {
    let cid = arr32(chain_id, "chain_id")?;
    let proposer_arr: [u8; 20] = proposer
        .try_into()
        .map_err(|_| JsError::new("proposer must be exactly 20 bytes"))?;
    let action: governance::AdminAction = serde_wasm_bindgen::from_value(action)
        .map_err(|e| JsError::new(&format!("invalid AdminAction: {e}")))?;
    governance::admin_proposal_content_hash(
        &cid,
        governance::ProposalId(proposal_id),
        governance::RegistryVersion(registry_version),
        governance::SignatureThreshold(threshold),
        &governance::SignerAddress(proposer_arr),
        created_height,
        created_ms,
        expiry_ms,
        &action,
    )
    .map(|h| h.to_vec())
    .map_err(to_js)
}

/// Derive the 20-byte owner address from a 32-byte Ed25519 public key.
#[wasm_bindgen]
pub fn pubkey_to_owner(pubkey: &[u8]) -> Result<Vec<u8>, JsError> {
    let pk = arr32(pubkey, "pubkey")?;
    Ok(crypto::pubkey_to_owner(&pk).to_vec())
}

/// Hash a CometBFT chain-id string into the 32-byte signing binding.
#[wasm_bindgen]
pub fn chain_id_from_string(chain_id: &str) -> Vec<u8> {
    crypto::chain_id_from_string(chain_id).to_vec()
}

// --- bridge-core v1 canonical custody payloads (W39-07) ---------------------
//
// The deposit/withdrawal custody path signs fixed-layout payloads from
// `bridge-core` (frozen v1 contract): a 221-byte `WithdrawalAuthorizationV1`
// whose SHA-256 the engine binds to the withdrawal, and a 327-byte
// `BridgeReceiptV1` the operator quorum signs and the engine re-encodes
// before verifying that quorum. Exposing the core's own `encode()` here —
// instead of mirroring the layout in TypeScript — makes the bytes identical
// to the engine's by construction; `src/bridge.test.ts` pins the marshalling
// with vectors printed from the pinned tag.

use bridge_core::{
    BridgeReceiptV1, DeploymentId, MicroUsdc, ProofOwner, ReceiptQuorumKind, RegistryEpoch,
    RustCrypto, Slot, SolanaPubkey, TerminalState, TxSignature, UnixSeconds, VaultTier,
    WithdrawalId,
};
use serde::Deserialize;

fn arr20(bytes: &[u8], what: &str) -> Result<[u8; 20], JsError> {
    bytes
        .try_into()
        .map_err(|_| JsError::new(&format!("{what} must be exactly 20 bytes")))
}

/// Fail closed on an unknown enum wire byte — a payload that decodes nowhere
/// must not encode here.
fn vault_tier(wire: u8) -> Result<VaultTier, JsError> {
    VaultTier::from_wire(wire).map_err(|e| JsError::new(&format!("vaultTier: {e:?}")))
}

fn terminal_state(wire: u8) -> Result<TerminalState, JsError> {
    TerminalState::from_wire(wire).map_err(|e| JsError::new(&format!("terminalState: {e:?}")))
}

fn receipt_quorum_kind(wire: u8) -> Result<ReceiptQuorumKind, JsError> {
    ReceiptQuorumKind::from_wire(wire)
        .map_err(|e| JsError::new(&format!("receiptQuorumKind: {e:?}")))
}

/// JS-side field names (camelCase) so an error names the field the caller
/// wrote, not the Rust ident.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WithdrawalAuthorizationInput {
    deployment_id: Vec<u8>,
    vault_tier: u8,
    withdrawal_id: u64,
    proof_owner: Vec<u8>,
    destination_owner: Vec<u8>,
    destination_token_acct: Vec<u8>,
    amount_micro_usdc: u64,
    fee_micro_usdc: u64,
    engine_height: u64,
    signer_epoch: u64,
    not_before_slot: u64,
    expires_at_slot: u64,
    not_before_unix_seconds: i64,
    expires_at_unix_seconds: i64,
}

impl TryFrom<WithdrawalAuthorizationInput> for bridge_core::WithdrawalAuthorizationV1 {
    type Error = JsError;

    fn try_from(i: WithdrawalAuthorizationInput) -> Result<Self, Self::Error> {
        Ok(Self {
            deployment_id: DeploymentId::new(arr32(&i.deployment_id, "deploymentId")?),
            vault_tier: vault_tier(i.vault_tier)?,
            withdrawal_id: WithdrawalId::new(i.withdrawal_id),
            proof_owner: ProofOwner::new(arr20(&i.proof_owner, "proofOwner")?),
            destination_owner: SolanaPubkey::new(arr32(&i.destination_owner, "destinationOwner")?),
            destination_token_acct: SolanaPubkey::new(arr32(
                &i.destination_token_acct,
                "destinationTokenAcct",
            )?),
            amount_micro_usdc: MicroUsdc::new(i.amount_micro_usdc),
            fee_micro_usdc: MicroUsdc::new(i.fee_micro_usdc),
            engine_height: i.engine_height,
            signer_epoch: RegistryEpoch::new(i.signer_epoch),
            not_before_slot: Slot::new(i.not_before_slot),
            expires_at_slot: Slot::new(i.expires_at_slot),
            not_before_unix_seconds: UnixSeconds::new(i.not_before_unix_seconds),
            expires_at_unix_seconds: UnixSeconds::new(i.expires_at_unix_seconds),
        })
    }
}

/// The canonical 221-byte `WithdrawalAuthorizationV1` — byte-for-byte
/// bridge-core's `encode()`. `fields` is a JS object with the camelCase
/// field names of the TS `WithdrawalAuthorizationV1` interface.
#[wasm_bindgen]
pub fn encode_withdrawal_authorization(fields: JsValue) -> Result<Vec<u8>, JsError> {
    let input: WithdrawalAuthorizationInput = serde_wasm_bindgen::from_value(fields)?;
    let auth = bridge_core::WithdrawalAuthorizationV1::try_from(input)?;
    Ok(auth.encode().to_vec())
}

/// `SHA256(canonical bytes)` — the authorization identity the engine binds
/// to a withdrawal and every terminal receipt must repeat. Same input shape
/// as [`encode_withdrawal_authorization`].
#[wasm_bindgen]
pub fn withdrawal_authorization_digest(fields: JsValue) -> Result<Vec<u8>, JsError> {
    let input: WithdrawalAuthorizationInput = serde_wasm_bindgen::from_value(fields)?;
    let auth = bridge_core::WithdrawalAuthorizationV1::try_from(input)?;
    Ok(auth.digest::<RustCrypto>().to_vec())
}

/// JS-side mirror of the wire `BridgeWithdrawalReceipt` (camelCase).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeReceiptInput {
    deployment_id: Vec<u8>,
    authorization_digest: Vec<u8>,
    withdrawal_id: u64,
    terminal_state: u8,
    vault_tier: u8,
    proof_owner: Vec<u8>,
    destination_owner: Vec<u8>,
    destination_token_acct: Vec<u8>,
    amount_micro_usdc: u64,
    fee_micro_usdc: u64,
    authorization_signer_epoch: u64,
    solana_tx_signature: Vec<u8>,
    finalized_slot: u64,
    finalized_blockhash: Vec<u8>,
    receipt_quorum_kind: u8,
    receipt_authority_epoch: u64,
}

impl TryFrom<BridgeReceiptInput> for BridgeReceiptV1 {
    type Error = JsError;

    fn try_from(i: BridgeReceiptInput) -> Result<Self, Self::Error> {
        Ok(Self {
            deployment_id: DeploymentId::new(arr32(&i.deployment_id, "deploymentId")?),
            authorization_digest: arr32(&i.authorization_digest, "authorizationDigest")?,
            withdrawal_id: WithdrawalId::new(i.withdrawal_id),
            terminal_state: terminal_state(i.terminal_state)?,
            vault_tier: vault_tier(i.vault_tier)?,
            proof_owner: ProofOwner::new(arr20(&i.proof_owner, "proofOwner")?),
            destination_owner: SolanaPubkey::new(arr32(&i.destination_owner, "destinationOwner")?),
            destination_token_acct: SolanaPubkey::new(arr32(
                &i.destination_token_acct,
                "destinationTokenAcct",
            )?),
            amount_micro_usdc: MicroUsdc::new(i.amount_micro_usdc),
            fee_micro_usdc: MicroUsdc::new(i.fee_micro_usdc),
            authorization_signer_epoch: RegistryEpoch::new(i.authorization_signer_epoch),
            solana_tx_signature: TxSignature::new(arr64(
                &i.solana_tx_signature,
                "solanaTxSignature",
            )?),
            finalized_slot: Slot::new(i.finalized_slot),
            finalized_blockhash: arr32(&i.finalized_blockhash, "finalizedBlockhash")?,
            receipt_quorum_kind: receipt_quorum_kind(i.receipt_quorum_kind)?,
            receipt_authority_epoch: RegistryEpoch::new(i.receipt_authority_epoch),
        })
    }
}

/// The canonical 327-byte `BridgeReceiptV1` — the message the operator
/// quorum signs and the engine re-encodes from the submitted fields before
/// verifying that quorum. `fields` is a JS object with the camelCase field
/// names of the TS `BridgeWithdrawalReceipt`.
#[wasm_bindgen]
pub fn encode_bridge_receipt(fields: JsValue) -> Result<Vec<u8>, JsError> {
    let input: BridgeReceiptInput = serde_wasm_bindgen::from_value(fields)?;
    let receipt = BridgeReceiptV1::try_from(input)?;
    Ok(receipt.encode().to_vec())
}
