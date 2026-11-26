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

#[test]
fn bridge_message_preimages_match_shared_vectors() {
    use proof_trading_sdk::bridge::{
        DeploymentId, MicroUsdc, OperatorSignature, RegistryEpoch, SolanaPubkey, TxSignature,
        WithdrawalId,
    };
    use proof_trading_sdk::types::{
        DepositLocator, RecordWithdrawalPayout, VoteDeposit, VotePauseBridge, VoteWithdrawalPaid,
        VoteWithdrawalPayoutDead,
    };
    const UNSIGNED: OperatorSignature = OperatorSignature::new([0; 64]);

    let rows = lines("vote-preimages.ndjson");
    assert!(!rows.is_empty(), "no bridge message vectors");
    for line in rows {
        let row: serde_json::Value = serde_json::from_str(&line).expect("parse vote preimage");
        let case = row["case"].as_str().expect("case string").to_owned();
        let bytes = |name: &str| -> Vec<u8> {
            hex::decode(row[name].as_str().expect("hex string field"))
                .expect("valid vote preimage hex")
        };
        let array32 = |name: &str| -> [u8; 32] { bytes(name).try_into().expect("a 32-byte field") };
        let decimal = |name: &str| -> u64 {
            row[name]
                .as_str()
                .expect("a decimal string")
                .parse()
                .expect("a u64 in decimal")
        };
        let small = |value: &serde_json::Value| -> u16 {
            u16::try_from(value.as_u64().expect("an index")).expect("an index fits u16")
        };
        let deployment_id = DeploymentId::new(array32("deployment_id"));
        let chain_id = array32("chain_id");
        let registry_epoch = RegistryEpoch::new(decimal("registry_epoch"));
        let payout = || {
            (
                WithdrawalId::new(decimal("withdrawal_id")),
                SolanaPubkey::new(array32("vault")),
                u32::try_from(row["squads_transaction_index"].as_u64().expect("an index"))
                    .expect("the transaction index fits u32"),
            )
        };
        let message = match row["kind"].as_str().expect("kind string") {
            "withdrawal_paid" => {
                let (withdrawal_id, vault, squads_transaction_index) = payout();
                VoteWithdrawalPaid {
                    withdrawal_id,
                    vault,
                    squads_transaction_index,
                    deployment_id,
                    chain_id,
                    registry_epoch,
                    signature: UNSIGNED,
                }
                .vote_message()
            }
            "withdrawal_payout_dead" => {
                let (withdrawal_id, vault, squads_transaction_index) = payout();
                VoteWithdrawalPayoutDead {
                    withdrawal_id,
                    vault,
                    squads_transaction_index,
                    deployment_id,
                    chain_id,
                    registry_epoch,
                    signature: UNSIGNED,
                }
                .vote_message()
            }
            "payout_record" => {
                let (withdrawal_id, vault, squads_transaction_index) = payout();
                RecordWithdrawalPayout {
                    withdrawal_id,
                    vault,
                    squads_transaction_index,
                    deployment_id,
                    chain_id,
                    registry_epoch,
                    signature: UNSIGNED,
                }
                .record_message()
            }
            "deposit" => VoteDeposit {
                owner: bytes("owner").try_into().expect("owner is 20 bytes"),
                amount_micro_usdc: MicroUsdc::new(decimal("amount_micro_usdc")),
                solana_tx_sig: TxSignature::new(
                    bytes("solana_tx_sig")
                        .try_into()
                        .expect("the transaction signature is 64 bytes"),
                ),
                locator: (!row["locator"].is_null()).then(|| DepositLocator {
                    top_index: small(&row["locator"]["top_index"]),
                    inner_index: (!row["locator"]["inner_index"].is_null())
                        .then(|| small(&row["locator"]["inner_index"])),
                }),
                deployment_id,
                chain_id,
                registry_epoch,
                signature: UNSIGNED,
            }
            .vote_message(),
            "pause_bridge" => VotePauseBridge {
                signed_at_ms: decimal("signed_at_ms"),
                deployment_id,
                chain_id,
                registry_epoch,
                signature: UNSIGNED,
            }
            .vote_message(),
            other => panic!("[{case}] unknown bridge message kind {other}"),
        };
        assert_eq!(
            hex::encode(message),
            row["preimage_hex"].as_str().expect("expected hex"),
            "[{case}] preimage mismatch"
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
