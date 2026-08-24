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
