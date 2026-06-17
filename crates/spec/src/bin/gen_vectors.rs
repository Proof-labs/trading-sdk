//! Conformance-vector generator (single source of truth).
//!
//! Builds the `expect` values from the Rust core and writes the three NDJSON
//! families to the repo-root `conformance/` dir. The Rust runner re-derives
//! and diff-checks; Python/TS assert against the checked-in files.
//!
//! Run:  `cargo run -p proof-trading-sdk-conformance --bin gen-vectors`
//! CI should run this and fail if `git diff --exit-code conformance/` is dirty.
//!
//! TODO(handoff): this emits a SEED set only. Extend to full coverage:
//!   * codec: all 27 action types (this seed has 6) + edges — zero/max u64,
//!     CLOID None/Some(MAX), post_only/reduce_only/TIF, serde-default tails
//!     (CreateMarket.pool_id, OracleUpdate.publish_time_ms…), every enum,
//!     nested EventOracleSource (3 variants), FeeTier lists, and
//!     OracleUpdateComposite (0x14 — which the TS SDK is missing, so its
//!     vector will fail the TS runner: that is the point).
//!   * signing: more keys / seqs (0,1,MAX) / chain_ids (unbound + bound) /
//!     payload sizes; more owner cases.
//!   * nonce: already reasonably covered; add multi-process interleavings if
//!     a vectorable model is agreed.

use std::error::Error;
use std::fs;
use std::path::PathBuf;

use proof_trading_sdk_conformance as cv;
use serde::Serialize;
use serde_json::json;

fn conformance_dir() -> PathBuf {
    // crates/spec -> repo root -> conformance/
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("conformance")
}

fn write_ndjson<T: Serialize>(path: &std::path::Path, rows: &[T]) -> Result<(), Box<dyn Error>> {
    let mut out = String::new();
    for row in rows {
        out.push_str(&serde_json::to_string(row)?);
        out.push('\n');
    }
    fs::write(path, out)?;
    Ok(())
}

fn codec_case(case: &str, action_type: u8, input: serde_json::Value) -> cv::CodecCase {
    let payload = cv::codec_payload(action_type, &input)
        .unwrap_or_else(|e| panic!("codec_payload failed for {case}: {e}"));
    cv::CodecCase {
        case: case.to_string(),
        action_type,
        input,
        expect: cv::CodecExpect {
            payload_hex: hex::encode(payload),
        },
    }
}

fn main() -> Result<(), Box<dyn Error>> {
    let dir = conformance_dir();
    fs::create_dir_all(&dir)?;

    // Action-type bytes (kept inline; the runners read action_type from the
    // vectors, and Python/TS map names→bytes via the core's get_action_types).
    const PLACE_ORDER: u8 = 0x01;
    const CANCEL_ORDER: u8 = 0x02;
    const ORACLE_UPDATE: u8 = 0x03;
    const MARKET_ORDER: u8 = 0x04;
    const CLOSE_POSITION: u8 = 0x17;
    const CREATE_MARKET: u8 = 0x07;
    const ATOMIC_BASKET_ORDER: u8 = 0x1C;

    let owner = vec![0x01u8; 20];
    let signer = vec![0x03u8; 20];

    // ── codec family ─────────────────────────────────────────────────────
    let codec = vec![
        codec_case(
            "place_order/min",
            PLACE_ORDER,
            json!({
                "market": 1, "owner": owner, "side": "Buy",
                "price": 100, "quantity": 10, "client_order_id": null,
                "post_only": false, "reduce_only": false, "time_in_force": "Gtc"
            }),
        ),
        codec_case(
            "place_order/flags_cloid_ioc",
            PLACE_ORDER,
            json!({
                "market": 7, "owner": owner, "side": "Sell",
                "price": 6675000u64, "quantity": 3, "client_order_id": 99u64,
                "post_only": true, "reduce_only": false, "time_in_force": "Ioc"
            }),
        ),
        codec_case(
            "place_order/max_u64",
            PLACE_ORDER,
            json!({
                "market": 4294967295u32, "owner": vec![0xFFu8; 20], "side": "Sell",
                "price": u64::MAX, "quantity": u64::MAX, "client_order_id": u64::MAX,
                "post_only": false, "reduce_only": true, "time_in_force": "Fok"
            }),
        ),
        codec_case(
            "cancel_order/basic",
            CANCEL_ORDER,
            json!({ "order_id": 42, "owner": vec![0x02u8; 20] }),
        ),
        codec_case(
            "oracle_update/no_publish_time",
            ORACLE_UPDATE,
            json!({ "market": 1, "price": 5000, "signer": signer, "publish_time_ms": 0 }),
        ),
        codec_case(
            "market_order/basic",
            MARKET_ORDER,
            json!({ "market": 3, "owner": owner, "side": "Buy",
                    "quantity": 250, "client_order_id": null }),
        ),
        codec_case(
            "close_position/basic",
            CLOSE_POSITION,
            json!({ "market": 2, "owner": owner }),
        ),
        // CreateMarket with the MANDATORY sz_decimals + ticker fields. Pins
        // that a market-creation payload carries them — the gap that left the
        // SDK building engine-rejected CreateMarket txs.
        codec_case(
            "create_market/full",
            CREATE_MARKET,
            json!({
                "market": 42, "im_bps": 1000, "mm_bps": 500,
                "taker_fee_bps": 5, "maker_fee_bps": 2, "signer": signer,
                "funding_interval_ms": 60000u64, "max_funding_rate_bps": 100,
                "pool_id": 9, "sz_decimals": 4, "ticker": "BTC"
            }),
        ),
        // AtomicBasketOrder (0x1c) — multi-leg, mixed leg optionals; pins the
        // action that was entirely absent from the SDK. max_slippage_bps is
        // serde(default) and encodes as 0 when absent.
        codec_case(
            "atomic_basket_order/two_legs",
            ATOMIC_BASKET_ORDER,
            json!({
                "owner": owner,
                "legs": [
                    { "market": 1, "side": "Buy", "price": 6675000u64,
                      "quantity": 3, "client_order_id": 77u64, "reduce_only": false },
                    { "market": 2, "side": "Sell", "price": 250000u64,
                      "quantity": 5, "client_order_id": null, "reduce_only": true }
                ],
                "max_slippage_bps": 50
            }),
        ),
    ];
    write_ndjson(&dir.join(cv::CODEC_FILE), &codec)?;

    // ── signing family ───────────────────────────────────────────────────
    let unbound = [0u8; 32];
    let sk = [0x42u8; 32];
    let po_payload = cv::codec_payload(
        PLACE_ORDER,
        &json!({
            "market": 1, "owner": vec![0x01u8; 20], "side": "Buy",
            "price": 100, "quantity": 10, "client_order_id": null,
            "post_only": false, "reduce_only": false, "time_in_force": "Gtc"
        }),
    )?;
    let envelope = cv::sign_envelope(&unbound, PLACE_ORDER, 1, &po_payload, &sk)?;

    let pk_42 = ed25519_dalek::SigningKey::from_bytes(&sk).verifying_key().to_bytes();
    let pk_01 = ed25519_dalek::SigningKey::from_bytes(&[0x01u8; 32]).verifying_key().to_bytes();

    let signing = vec![
        cv::SigningCase::Sign {
            case: "place_order/min@seq1/unbound".to_string(),
            chain_id: unbound.to_vec(),
            action_type: PLACE_ORDER,
            seq: 1,
            payload_hex: hex::encode(&po_payload),
            secret_key: sk.to_vec(),
            expect_envelope_hex: hex::encode(&envelope),
        },
        cv::SigningCase::Owner {
            case: "owner/key_0x42".to_string(),
            pubkey: pk_42.to_vec(),
            expect_owner_hex: hex::encode(cv::owner_of(&pk_42)?),
        },
        cv::SigningCase::Owner {
            case: "owner/key_0x01".to_string(),
            pubkey: pk_01.to_vec(),
            expect_owner_hex: hex::encode(cv::owner_of(&pk_01)?),
        },
    ];
    write_ndjson(&dir.join(cv::SIGNING_FILE), &signing)?;

    // ── nonce family ─────────────────────────────────────────────────────
    let nonce_inputs: Vec<(&str, u64, Vec<u64>)> = vec![
        ("clock_ticks", 0, vec![1000, 1001, 1002]),
        ("same_ms_collision", 0, vec![1000, 1000, 1000]),
        ("clock_backwards", 5000, vec![4000, 4001]),
        ("restart_from_zero", 0, vec![1_700_000_000_000]),
    ];
    let nonce: Vec<cv::NonceCase> = nonce_inputs
        .into_iter()
        .map(|(case, last, now_ms)| cv::NonceCase {
            case: case.to_string(),
            expect: cv::nonce_sequence(last, &now_ms),
            last,
            now_ms,
        })
        .collect();
    write_ndjson(&dir.join(cv::NONCE_FILE), &nonce)?;

    eprintln!(
        "wrote {} codec, {} signing, {} nonce cases to {}",
        codec.len(),
        signing.len(),
        nonce.len(),
        dir.display()
    );
    Ok(())
}
