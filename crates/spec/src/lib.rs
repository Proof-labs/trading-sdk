//! Cross-language conformance vectors for the Proof trading SDK.
//!
//! The vectors live as **NDJSON** (one self-describing case per line) under
//! the repo-root `conformance/` directory, split into three families that
//! mirror the spec (`trading-sdks.md` → "Conformance Vectors"):
//!
//! | File              | Family   | Asserts                                   |
//! |-------------------|----------|-------------------------------------------|
//! | `codec.ndjson`    | codec    | action fields → exact MessagePack payload |
//! | `signing.ndjson`  | signing  | (payload,key)→envelope; pubkey→owner      |
//! | `nonce.ndjson`    | nonce    | (last, now_ms…) → allocated nonce sequence|
//!
//! NDJSON (not a single JSON array) is deliberate: it is the indexer's
//! archive format (`indexer/pkg/envelope` — `<height>.ndjson`), so the same
//! streaming reader can replay **real historical signed txs** through the
//! SDK (see [`ArchiveEnvelope`] and the `replay/` plan in the README), it is
//! line-addressable for pinpointing a failing case, and it diffs cleanly.
//!
//! ## Byte representation
//! Byte fields in `input` are JSON **arrays of u8** (e.g. `owner: [1,1,…]`),
//! not hex strings. This is the one representation every consumer decodes
//! with no special-casing: `serde_json`/`pythonize` both route an int array
//! to the `wire` newtypes' `visit_seq`, and TS does `Uint8Array.from(arr)`.
//! Opaque outputs (`payload`, `envelope`, `owner`, `signature`) are hex.
//!
//! Authority: the Rust core is the source of truth. `gen-vectors` writes the
//! `expect` values from the core; the Rust runner re-derives them (regression
//! guard) and the Python/TS runners assert against the same file (the actual
//! cross-language check). Regenerate with:
//! `cargo run -p proof-trading-sdk-conformance --bin gen-vectors`.

use serde::{Deserialize, Serialize};

pub const CODEC_FILE: &str = "codec.ndjson";
pub const SIGNING_FILE: &str = "signing.ndjson";
pub const NONCE_FILE: &str = "nonce.ndjson";

// ---------------------------------------------------------------------------
// Vector schemas (the NDJSON line shapes)
// ---------------------------------------------------------------------------

/// One codec case: `action_type` + structured `input` fields → payload bytes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodecCase {
    /// Stable human id (e.g. `"place_order/min"`). Also recoverable as the
    /// file + line number.
    pub case: String,
    pub action_type: u8,
    /// The action's snake_case field dict; byte fields are arrays of u8.
    pub input: serde_json::Value,
    pub expect: CodecExpect,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodecExpect {
    pub payload_hex: String,
}

/// One signing-family case. `kind` discriminates signature vs owner
/// derivation so both live in `signing.ndjson`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SigningCase {
    /// Sign a payload and assert the full wire envelope.
    Sign {
        case: String,
        chain_id: Vec<u8>,
        action_type: u8,
        seq: u64,
        payload_hex: String,
        secret_key: Vec<u8>,
        expect_envelope_hex: String,
    },
    /// Derive the 20-byte owner from a pubkey.
    Owner {
        case: String,
        pubkey: Vec<u8>,
        expect_owner_hex: String,
    },
}

/// One nonce case: a starting `last` and a sequence of wall-clock `now_ms`
/// readings → the exact allocated nonce for each step.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NonceCase {
    pub case: String,
    pub last: u64,
    pub now_ms: Vec<u64>,
    pub expect: Vec<u64>,
}

// ---------------------------------------------------------------------------
// Reference implementations — the single source of truth
// ---------------------------------------------------------------------------

/// Encode an action payload via the shared core (the same path PyO3/WASM use).
pub fn codec_payload(action_type: u8, fields: &serde_json::Value) -> Result<Vec<u8>, String> {
    proof_trading_sdk::codec::encode_payload_dyn(action_type, fields.clone())
        .map_err(|e| format!("{e:?}"))
}

/// Sign a payload into the full wire envelope via the core.
pub fn sign_envelope(
    chain_id: &[u8],
    action_type: u8,
    seq: u64,
    payload: &[u8],
    secret_key: &[u8],
) -> Result<Vec<u8>, String> {
    let cid: [u8; 32] = chain_id
        .try_into()
        .map_err(|_| "chain_id must be 32 bytes")?;
    let sk: [u8; 32] = secret_key
        .try_into()
        .map_err(|_| "secret_key must be 32 bytes")?;
    let key = ed25519_dalek::SigningKey::from_bytes(&sk);
    proof_trading_sdk::codec::sign_and_encode_payload(&cid, action_type, payload, seq, &key)
        .map_err(|e| format!("{e:?}"))
}

/// Derive the owner address from a pubkey via the core.
pub fn owner_of(pubkey: &[u8]) -> Result<[u8; 20], String> {
    let pk: [u8; 32] = pubkey.try_into().map_err(|_| "pubkey must be 32 bytes")?;
    Ok(proof_trading_sdk::crypto::pubkey_to_owner(&pk))
}

/// The canonical timestamp-nonce step: `max(now_ms, last + 1)`.
///
/// This is the *pure* function the nonce vectors pin. Each native allocator
/// must expose an equivalent pure step (separate from reading the clock) so
/// it is vector-testable — see the README "nonce" note.
pub fn nonce_step(last: u64, now_ms: u64) -> u64 {
    std::cmp::max(now_ms, last.saturating_add(1))
}

/// Run a full nonce sequence through [`nonce_step`].
pub fn nonce_sequence(last: u64, now_ms: &[u64]) -> Vec<u64> {
    let mut last = last;
    now_ms
        .iter()
        .map(|&now| {
            last = nonce_step(last, now);
            last
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Replay corpus — the indexer archive shape (STUB)
// ---------------------------------------------------------------------------

/// One line of the indexer's archive NDJSON (`indexer/pkg/envelope`,
/// `<height>.ndjson`). Mirrors `envelope.Envelope` so the same files can be
/// streamed as a replay conformance corpus.
///
/// TODO(handoff): wire this to the indexer archive and assert the replay
/// invariants — see the README "replay" section. Today this is only the
/// schema + a unit test on a synthetic line.
#[derive(Debug, Clone, Deserialize)]
pub struct ArchiveEnvelope {
    #[serde(rename = "h")]
    pub height: i64,
    pub kind: String,
    #[serde(default)]
    pub tx_hash: String,
    #[serde(default)]
    pub code: u32,
    /// Block payload — for `kind == "tx"` this carries the base64 tx bytes.
    #[serde(default)]
    pub raw: serde_json::Value,
}

/// Replay invariant check for one archived signed tx (STUB).
///
/// The plan: base64-decode the archived tx, `decode_tx` it through the core,
/// re-encode, and assert byte-identical round-trip + signature verifies.
/// TODO(handoff): implement once the archive `tx` framing is confirmed (it
/// may or may not be wrapped by CometBFT — see README caveat).
pub fn replay_check(_tx_bytes: &[u8]) -> Result<(), String> {
    Err("replay_check not implemented — see conformance/README.md".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nonce_step_bumps_on_same_ms() {
        assert_eq!(nonce_step(0, 1000), 1000);
        assert_eq!(nonce_step(1000, 1000), 1001); // same-ms collision
        assert_eq!(nonce_step(1000, 999), 1001); // clock went backwards
    }

    #[test]
    fn nonce_sequence_is_monotonic() {
        let seq = nonce_sequence(0, &[1000, 1000, 1000, 1001]);
        assert_eq!(seq, vec![1000, 1001, 1002, 1003]);
    }

    #[test]
    fn archive_envelope_parses_synthetic_line() {
        let line = r#"{"h":42,"kind":"tx","tx_hash":"AB","code":0,"raw":{"tx":"kgEB"}}"#;
        let env: ArchiveEnvelope = serde_json::from_str(line).unwrap();
        assert_eq!(env.height, 42);
        assert_eq!(env.kind, "tx");
    }
}
