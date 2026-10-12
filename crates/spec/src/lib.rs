//! Cross-language conformance vectors for the Proof trading SDK.
//!
//! The vectors live as **NDJSON** (one self-describing case per line) under
//! the repo-root `conformance/` directory, split into families that mirror
//! the spec (`trading-sdks.md` → "Conformance Vectors"):
//!
//! | File              | Family   | Asserts                                   |
//! |-------------------|----------|-------------------------------------------|
//! | `codec.ndjson`    | codec    | action fields → exact MessagePack payload |
//! | `signing.ndjson`  | signing  | (payload,key)→envelope; pubkey→owner      |
//! | `nonce.ndjson`    | nonce    | (last, now_ms…) → allocated nonce sequence|
//! | `errors.ndjson`   | errors   | (code, log) → ExecError classification name|
//! | `binary.ndjson`   | binary   | No order → Yes order; position → No view  |
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
pub const ERRORS_FILE: &str = "errors.ndjson";
pub const BINARY_FILE: &str = "binary.ndjson";

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

/// One error-classification case: an engine result `code` plus the optional
/// canonical DeliverTx `log` → the classified variant name. A `log: null` case
/// pins the numeric manifest (code → canonical name); a case carrying a `log`
/// pins the log-aware decoder (the transitional code-50 disambiguation).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorCase {
    pub case: String,
    pub code: u32,
    pub log: Option<String>,
    pub expect: ErrorExpect,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorExpect {
    pub name: String,
}

/// One binary-book case: a No order and the Yes order it becomes, or a
/// position and how it reads. `kind` discriminates the two.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BinaryCase {
    /// `input` is a `PlaceOrder` field dict whose `side`, `price` and limb
    /// trigger prices are in No terms. `expect` is either the Yes order's
    /// field dict with its payload, or the refusal's name.
    NoOrder {
        case: String,
        input: serde_json::Value,
        expect: NoOrderExpect,
    },
    /// A position's `side` and `entry_price` on the event's book → how it
    /// reads, or the refusal's name.
    PositionView {
        case: String,
        side: String,
        entry_price: u64,
        size: u64,
        expect: PositionViewExpect,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoOrderExpect {
    YesOrder {
        fields: serde_json::Value,
        payload_hex: String,
    },
    Error {
        name: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PositionViewExpect {
    View {
        outcome: String,
        entry_price: u64,
        size: u64,
    },
    Error {
        name: String,
    },
}

// ---------------------------------------------------------------------------
// Reference implementations — the single source of truth
// ---------------------------------------------------------------------------

/// Encode an action payload via the shared core (the same path PyO3/WASM use).
pub fn codec_payload(action_type: u8, fields: &serde_json::Value) -> Result<Vec<u8>, String> {
    proof_trading_sdk::codec::encode_payload_dyn(action_type, fields.clone())
        .map_err(|e| format!("{e:?}"))
}

/// The refusal's stable name, shared by every binding.
pub fn binary_error_name(error: &proof_trading_sdk::binary::BinaryError) -> &'static str {
    use proof_trading_sdk::binary::BinaryError;
    match error {
        BinaryError::OrderPriceOutOfRange { .. } => "OrderPriceOutOfRange",
        BinaryError::TriggerPriceOutOfRange { .. } => "TriggerPriceOutOfRange",
        BinaryError::EntryAboveOneDollar { .. } => "EntryAboveOneDollar",
    }
}

fn limb_from_json(
    value: &serde_json::Value,
) -> Result<Option<proof_trading_sdk::types::TriggerLimb>, String> {
    if value.is_null() {
        return Ok(None);
    }
    serde_json::from_value(value.clone())
        .map(Some)
        .map_err(|e| e.to_string())
}

fn limb_to_json(limb: &Option<proof_trading_sdk::types::TriggerLimb>) -> serde_json::Value {
    match limb {
        None => serde_json::Value::Null,
        Some(limb) => serde_json::json!({
            "trigger_price": limb.trigger_price,
            "max_slippage_bps": limb.max_slippage_bps.0,
            "client_trigger_id": limb.client_trigger_id.map(|id| id.0),
        }),
    }
}

/// Translate a No order (a `PlaceOrder` field dict in No terms) through the
/// core and encode the resulting Yes order.
pub fn no_order_expect(input: &serde_json::Value) -> Result<NoOrderExpect, String> {
    use proof_trading_sdk::binary::{yes_order, NoOrder};
    let get = |key: &str| input.get(key).cloned().unwrap_or(serde_json::Value::Null);
    let parse = |key: &str| -> Result<serde_json::Value, String> {
        input.get(key).cloned().ok_or(format!("missing {key}"))
    };
    let no = NoOrder {
        market: serde_json::from_value(parse("market")?).map_err(|e| e.to_string())?,
        owner: serde_json::from_value(parse("owner")?).map_err(|e| e.to_string())?,
        side: serde_json::from_value(parse("side")?).map_err(|e| e.to_string())?,
        price: serde_json::from_value(parse("price")?).map_err(|e| e.to_string())?,
        quantity: serde_json::from_value(parse("quantity")?).map_err(|e| e.to_string())?,
        client_order_id: serde_json::from_value(get("client_order_id"))
            .map_err(|e| e.to_string())?,
        post_only: serde_json::from_value(parse("post_only")?).map_err(|e| e.to_string())?,
        reduce_only: serde_json::from_value(parse("reduce_only")?).map_err(|e| e.to_string())?,
        time_in_force: serde_json::from_value(parse("time_in_force")?)
            .map_err(|e| e.to_string())?,
        stop_loss: limb_from_json(&get("stop_loss"))?,
        take_profit: limb_from_json(&get("take_profit"))?,
    };
    let yes = match yes_order(&no) {
        Ok(yes) => yes,
        Err(error) => {
            return Ok(NoOrderExpect::Error {
                name: binary_error_name(&error).to_string(),
            })
        }
    };
    let fields = serde_json::json!({
        "market": yes.market,
        "owner": yes.owner.to_vec(),
        "side": serde_json::to_value(yes.side).map_err(|e| e.to_string())?,
        "price": yes.price,
        "quantity": yes.quantity,
        "client_order_id": yes.client_order_id,
        "post_only": yes.post_only,
        "reduce_only": yes.reduce_only,
        "time_in_force": serde_json::to_value(yes.time_in_force).map_err(|e| e.to_string())?,
        "stop_loss": limb_to_json(&yes.stop_loss),
        "take_profit": limb_to_json(&yes.take_profit),
    });
    let payload = codec_payload(1, &fields)?;
    Ok(NoOrderExpect::YesOrder {
        fields,
        payload_hex: hex::encode(payload),
    })
}

/// Read a position on an event's binary book through the core.
pub fn position_view_expect(
    side: &str,
    entry_price: u64,
    size: u64,
) -> Result<PositionViewExpect, String> {
    use proof_trading_sdk::binary::{binary_position_view, Outcome};
    let side = serde_json::from_value(serde_json::Value::String(side.to_string()))
        .map_err(|e| e.to_string())?;
    Ok(match binary_position_view(side, entry_price, size) {
        Ok(view) => PositionViewExpect::View {
            outcome: match view.outcome {
                Outcome::Yes => "Yes",
                Outcome::No => "No",
            }
            .to_string(),
            entry_price: view.entry_price,
            size: view.size,
        },
        Err(error) => PositionViewExpect::Error {
            name: binary_error_name(&error).to_string(),
        },
    })
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

/// Canonical manifest name for a numeric code (the `ERROR_KINDS` table).
pub fn error_manifest_name(code: u32) -> Option<&'static str> {
    proof_trading_sdk::errors::ERROR_KINDS
        .iter()
        .find(|kind| kind.code() == code)
        .map(|kind| kind.name())
}

/// Safe log-aware classification name — the decoder the SDKs expose. Code 50
/// resolves to slippage/open-interest only via its canonical log; a bare or
/// unrecognized code 50 stays `AmbiguousCode50`.
pub fn error_classify_name(code: u32, log: Option<&str>) -> Option<&'static str> {
    proof_trading_sdk::errors::decode_exec_error_kind(code, log).map(|kind| kind.name())
}

/// The reference every runner asserts. A bare code (`log: None`) pins the
/// numeric manifest name; a code carrying a `log` pins the log-aware decoder.
/// Bare code 50 is `SlippageExceeded` (manifest); code 50 + log resolves the
/// transitional slippage/open-interest ambiguity.
pub fn error_reference_name(code: u32, log: Option<&str>) -> Option<&'static str> {
    match log {
        None => error_manifest_name(code),
        Some(log) => error_classify_name(code, Some(log)),
    }
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
