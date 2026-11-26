//! Rust conformance runner: load the checked-in NDJSON vectors and assert the
//! core reproduces every `expect`. This is the regression guard (the core
//! generated these); the cross-language guarantee comes from the Python and
//! TS runners asserting against the same files.

use std::fs;
use std::path::PathBuf;

use proof_trading_sdk_conformance as cv;

fn vectors_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("conformance")
}

fn lines(file: &str) -> Vec<String> {
    let path = vectors_dir().join(file);
    let body = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    body.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

#[test]
fn codec_vectors() {
    let cases = lines(cv::CODEC_FILE);
    assert!(!cases.is_empty(), "no codec vectors");
    for line in cases {
        let c: cv::CodecCase = serde_json::from_str(&line).expect("parse codec case");
        let payload = cv::codec_payload(c.action_type, &c.input)
            .unwrap_or_else(|e| panic!("[{}] encode failed: {e}", c.case));
        assert_eq!(
            hex::encode(payload),
            c.expect.payload_hex,
            "codec mismatch for case {}",
            c.case
        );
    }
}

/// One `vote-preimages.ndjson` row. Ids, epochs, amounts and times are
/// decimal strings; byte fields are lowercase hex.
#[derive(serde::Deserialize)]
struct PreimageRow {
    case: String,
    preimage_hex: String,
    deployment_id: String,
    chain_id: String,
    registry_epoch: String,
    signed_at_ms: String,
    #[serde(flatten)]
    body: PreimageBody,
}

#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum PreimageBody {
    WithdrawalPaid(PayoutRow),
    WithdrawalPayoutDead(PayoutRow),
    PayoutRecord(PayoutRow),
    Deposit {
        owner: String,
        amount_micro_usdc: String,
        solana_tx_sig: String,
        locator: Option<LocatorRow>,
    },
    PauseBridge {},
}

#[derive(serde::Deserialize)]
struct PayoutRow {
    withdrawal_id: String,
    vault: String,
    squads_transaction_index: u32,
}

#[derive(serde::Deserialize)]
struct LocatorRow {
    top_index: u16,
    inner_index: Option<u16>,
}

fn hex_array<const N: usize>(text: &str) -> [u8; N] {
    hex::decode(text)
        .expect("vector byte fields are hex")
        .try_into()
        .expect("a vector byte field has its wire width")
}

fn decimal(text: &str) -> u64 {
    text.parse()
        .expect("vector integers are u64 decimal strings")
}

impl PreimageRow {
    /// The core message this row describes, built the way every binding
    /// builds it.
    fn message(&self) -> proof_trading_sdk::bridge_votes::BridgeMessage {
        use proof_trading_sdk::bridge::{
            DeploymentId, MicroUsdc, ProofOwner, RegistryEpoch, SolanaPubkey, TxSignature,
            WithdrawalId,
        };
        use proof_trading_sdk::bridge_votes::{
            BridgeBinding, BridgeMessage, DepositObservation, PayoutIdentity,
        };
        let binding = BridgeBinding {
            deployment_id: DeploymentId::new(hex_array(&self.deployment_id)),
            chain_id: hex_array(&self.chain_id),
            registry_epoch: RegistryEpoch::new(decimal(&self.registry_epoch)),
            signed_at_ms: decimal(&self.signed_at_ms),
        };
        let payout = |row: &PayoutRow| PayoutIdentity {
            withdrawal_id: WithdrawalId::new(decimal(&row.withdrawal_id)),
            vault: SolanaPubkey::new(hex_array(&row.vault)),
            squads_transaction_index: row.squads_transaction_index,
        };
        match &self.body {
            PreimageBody::WithdrawalPaid(row) => BridgeMessage::WithdrawalPaid {
                payout: payout(row),
                binding,
            },
            PreimageBody::WithdrawalPayoutDead(row) => BridgeMessage::WithdrawalPayoutDead {
                payout: payout(row),
                binding,
            },
            PreimageBody::PayoutRecord(row) => BridgeMessage::PayoutRecord {
                payout: payout(row),
                binding,
            },
            PreimageBody::Deposit {
                owner,
                amount_micro_usdc,
                solana_tx_sig,
                locator,
            } => BridgeMessage::Deposit {
                deposit: DepositObservation {
                    owner: ProofOwner::new(hex_array(owner)),
                    amount: MicroUsdc::new(decimal(amount_micro_usdc)),
                    solana_tx_sig: TxSignature::new(hex_array(solana_tx_sig)),
                    locator: locator.as_ref().map(|l| {
                        DepositObservation::checked_locator(l.top_index, l.inner_index)
                            .expect("vector locators are signable")
                    }),
                },
                binding,
            },
            PreimageBody::PauseBridge {} => BridgeMessage::PauseBridge { binding },
        }
    }
}

#[test]
fn bridge_message_preimages_match_shared_vectors() {
    let rows = lines("vote-preimages.ndjson");
    assert!(!rows.is_empty(), "no bridge message vectors");
    for line in rows {
        let row: PreimageRow = serde_json::from_str(&line).expect("a bridge message vector row");
        assert_eq!(
            hex::encode(row.message().preimage()),
            row.preimage_hex,
            "[{}] preimage mismatch",
            row.case
        );
    }
}

#[test]
fn signing_vectors() {
    let cases = lines(cv::SIGNING_FILE);
    assert!(!cases.is_empty(), "no signing vectors");
    for line in cases {
        let c: cv::SigningCase = serde_json::from_str(&line).expect("parse signing case");
        match c {
            cv::SigningCase::Sign {
                case,
                chain_id,
                action_type,
                seq,
                payload_hex,
                secret_key,
                expect_envelope_hex,
            } => {
                let payload = hex::decode(&payload_hex).expect("payload hex");
                let env = cv::sign_envelope(&chain_id, action_type, seq, &payload, &secret_key)
                    .unwrap_or_else(|e| panic!("[{case}] sign failed: {e}"));
                assert_eq!(
                    hex::encode(env),
                    expect_envelope_hex,
                    "sign mismatch for {case}"
                );
            }
            cv::SigningCase::Owner {
                case,
                pubkey,
                expect_owner_hex,
            } => {
                let owner = cv::owner_of(&pubkey).unwrap_or_else(|e| panic!("[{case}] {e}"));
                assert_eq!(
                    hex::encode(owner),
                    expect_owner_hex,
                    "owner mismatch for {case}"
                );
            }
        }
    }
}

#[test]
fn errors_vectors() {
    let cases = lines(cv::ERRORS_FILE);
    assert!(!cases.is_empty(), "no errors vectors");
    for line in cases {
        let c: cv::ErrorCase = serde_json::from_str(&line).expect("parse errors case");
        let got = cv::error_reference_name(c.code, c.log.as_deref())
            .unwrap_or_else(|| panic!("[{}] code {} not classified", c.case, c.code));
        assert_eq!(got, c.expect.name, "errors mismatch for case {}", c.case);
    }
}

#[test]
fn events_vectors() {
    let cases = lines(cv::EVENTS_FILE);
    assert!(!cases.is_empty(), "no events vectors");
    for line in cases {
        let c: cv::EventCase = serde_json::from_str(&line).expect("parse events case");
        let got = cv::event_expect(&c.event).unwrap_or_else(|e| panic!("[{}] {e}", c.case));
        assert_eq!(got, c.expect, "events mismatch for case {}", c.case);
    }
}

#[test]
fn nonce_vectors() {
    let cases = lines(cv::NONCE_FILE);
    assert!(!cases.is_empty(), "no nonce vectors");
    for line in cases {
        let c: cv::NonceCase = serde_json::from_str(&line).expect("parse nonce case");
        assert_eq!(
            cv::nonce_sequence(c.last, &c.now_ms),
            c.expect,
            "nonce mismatch for case {}",
            c.case
        );
    }
}

#[test]
fn binary_vectors() {
    let cases = lines(cv::BINARY_FILE);
    assert!(!cases.is_empty(), "binary.ndjson is empty");
    for line in &cases {
        let case: cv::BinaryCase = serde_json::from_str(line).expect("binary line parses");
        match case {
            cv::BinaryCase::NoOrder {
                case,
                input,
                expect,
            } => assert_eq!(
                cv::no_order_expect(&input).expect("no order translates"),
                expect,
                "binary case {case}"
            ),
            cv::BinaryCase::PositionView {
                case,
                side,
                entry_price,
                size,
                expect,
            } => assert_eq!(
                cv::position_view_expect(&side, entry_price, size).expect("view reads"),
                expect,
                "binary case {case}"
            ),
        }
    }
}
