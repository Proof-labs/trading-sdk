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
//!   * codec: all 27 action types (this seed has 13) + edges — zero/max u64,
//!     CLOID None/Some(MAX), post_only/reduce_only/TIF, serde-default tails
//!     (CreateMarket.pool_id, OracleUpdate.publish_time_ms…), every enum,
//!     nested EventOracleSource (3 variants), FeeTier lists.
//!     OracleUpdateComposite (0x14) is now wired across all three SDKs and
//!     covered here.
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
    const ORACLE_UPDATE_COMPOSITE: u8 = 0x14;
    const MARKET_ORDER: u8 = 0x04;
    const CLOSE_POSITION: u8 = 0x17;
    const CREATE_MARKET: u8 = 0x07;
    const UPDATE_MARKET_FEES: u8 = 0x10;
    const ATOMIC_BASKET_ORDER: u8 = 0x1C;
    const PROPOSE_ADMIN_ACTION: u8 = 0x1E;
    const APPROVE_ADMIN_ACTION: u8 = 0x1F;
    const REJECT_ADMIN_ACTION: u8 = 0x20;
    const EMERGENCY_ADMIN_ACTION: u8 = 0x21;

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
        // OracleUpdateComposite (0x14) — BE-31 composite-CEX feeder action.
        // Operator-only; pins the cross-language wire shape now that the TS
        // and Python SDKs expose it. Field order: market, price, n_sources,
        // signer, publish_time_ms (n_sources/publish_time are serde-default).
        codec_case(
            "oracle_update_composite/four_sources",
            ORACLE_UPDATE_COMPOSITE,
            json!({ "market": 1, "price": 6675000u64, "n_sources": 4,
                    "signer": signer, "publish_time_ms": 1700000000123u64 }),
        ),
        codec_case(
            "oracle_update_composite/no_publish_time",
            ORACLE_UPDATE_COMPOSITE,
            json!({ "market": 7, "price": 250000u64, "n_sources": 1,
                    "signer": signer, "publish_time_ms": 0 }),
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
        // An explicit zero cap is semantically identical to omission, so both
        // must produce the SAME bytes — the canonical 12-element uncapped
        // payload with an explicit `0` tail. The array length never depends on
        // the cap's value; see `CreateMarket::max_open_interest`.
        codec_case(
            "create_market/max_open_interest_zero_explicit",
            CREATE_MARKET,
            json!({
                "market": 42, "im_bps": 1000, "mm_bps": 500,
                "taker_fee_bps": 5, "maker_fee_bps": 2, "signer": signer,
                "funding_interval_ms": 60000u64, "max_funding_rate_bps": 100,
                "pool_id": 9, "sz_decimals": 4, "ticker": "BTC",
                "max_open_interest": 0u64
            }),
        ),
        // S40: the CreateMarket cap tail. The uncapped case above encodes the
        // same 12 elements with a zero in slot 11; this case pins a non-zero
        // slot 11. Only the value differs between them, never the length.
        codec_case(
            "create_market/max_open_interest",
            CREATE_MARKET,
            json!({
                "market": 43, "im_bps": 1000, "mm_bps": 500,
                "taker_fee_bps": 5, "maker_fee_bps": 2, "signer": signer,
                "funding_interval_ms": 60000u64, "max_funding_rate_bps": 100,
                "pool_id": 9, "sz_decimals": 5, "ticker": "ETH",
                "max_open_interest": 1_000_000u64
            }),
        ),
        // UpdateMarketFees appends the existing live-risk ratio levers at
        // slots 18/19 before the S40 OI cap at slot 20. Null placeholders are
        // intentional and prevent the cap from being decoded as im_bps.
        codec_case(
            "update_market_fees/max_open_interest_only",
            UPDATE_MARKET_FEES,
            json!({
                "market": 43, "signer": signer,
                "im_bps": null, "mm_bps": null,
                "max_open_interest": 500_000u64
            }),
        ),
        // Pin the three adjacent risk tails together across Rust, TypeScript,
        // and Python so a binding cannot shift max OI into an IM/MM slot.
        codec_case(
            "update_market_fees/margin_ratios_and_max_open_interest",
            UPDATE_MARKET_FEES,
            json!({
                "market": 44, "signer": signer,
                "im_bps": 3334, "mm_bps": 1667,
                "max_open_interest": 750_000u64
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
        // Admin-multisig governance (W29-04, tags 0x1E–0x21). The nested
        // `action` is an externally-tagged `AdminAction`/`EmergencyAction`
        // enum — serde_json's map form `{ "Variant": { snake_case } }`, which
        // is exactly what the TS adapter must reproduce. The embedded
        // CreateMarket signer is zero (governance supplies authorization).
        codec_case(
            "propose_admin_action/create_market",
            PROPOSE_ADMIN_ACTION,
            json!({
                "proposer": vec![0x22u8; 20],
                "registry_version": 3u64,
                "action": { "CreateMarket": {
                    "market": 0, "im_bps": 3334, "mm_bps": 1667,
                    "taker_fee_bps": 5, "maker_fee_bps": 2, "signer": vec![0u8; 20],
                    "funding_interval_ms": 60000u64, "max_funding_rate_bps": 3000,
                    "pool_id": 0, "sz_decimals": 0, "ticker": "", "max_open_interest": 0u64
                }}
            }),
        ),
        codec_case(
            "approve_admin_action/rotate_registry",
            APPROVE_ADMIN_ACTION,
            json!({
                "approver": vec![0x22u8; 20],
                "proposal_id": 42u64,
                "registry_version": 3u64,
                "threshold": 2u32,
                "proposer": vec![0x22u8; 20],
                "created_height": 7u64,
                "created_ms": 1000u64,
                "expiry_ms": 259201000u64,
                "action": { "UpdateAdminSignerRegistry": {
                    "new_threshold": 2u32,
                    "new_members": [vec![0xA1u8; 20], vec![0xA2u8; 20]]
                }},
                "content_hash": vec![0xABu8; 32]
            }),
        ),
        codec_case(
            "reject_admin_action/basic",
            REJECT_ADMIN_ACTION,
            json!({
                "rejecter": vec![0x33u8; 20],
                "proposal_id": 42u64,
                "content_hash": vec![0xABu8; 32]
            }),
        ),
        codec_case(
            "emergency_admin_action/pause_market",
            EMERGENCY_ADMIN_ACTION,
            json!({
                "signer": vec![0x44u8; 20],
                "action": { "PauseMarket": { "market_id": 7 } }
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

    let pk_42 = ed25519_dalek::SigningKey::from_bytes(&sk)
        .verifying_key()
        .to_bytes();
    let pk_01 = ed25519_dalek::SigningKey::from_bytes(&[0x01u8; 32])
        .verifying_key()
        .to_bytes();

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
