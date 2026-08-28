//! Conformance-vector generator (single source of truth).
//!
//! Builds the `expect` values from the Rust core and writes the three NDJSON
//! families to the repo-root `conformance/` dir. The Rust runner re-derives
//! and diff-checks; Python/TS assert against the checked-in files.
//!
//! Run:  `cargo run -p proof-trading-sdk-conformance --bin gen-vectors`
//! CI should run this and fail if `git diff --exit-code conformance/` is dirty.
//!
//! Coverage status:
//!   * codec: every `ActionType` in the registry now has at least one vector
//!     (the coverage ratchet in `src/conformance.test.ts` enforces this — the
//!     debt list is empty, #69). Remaining nice-to-haves are deeper edges, not
//!     new types: more zero/max-u64 and serde-default-tail permutations, and
//!     the nested `EventOracleSource` non-default variants (only
//!     RelayerAttested is exercised today).
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

/// The engine golden `BridgeWithdrawalReceipt` fixture (mirrors exchange-core
/// `codec::tests::golden_receipt`). `terminal_state` is `1 = Paid` for a
/// confirm, `2 = Cancelled` for a fail; every other field is fixed.
fn receipt_json(terminal_state: u8) -> serde_json::Value {
    json!({
        "deployment_id": vec![0x11u8; 32],
        "authorization_digest": vec![0x22u8; 32],
        "withdrawal_id": 777u64,
        "terminal_state": terminal_state,
        "vault_tier": 1,
        "proof_owner": vec![0x05u8; 20],
        "destination_owner": vec![0x06u8; 32],
        "destination_token_acct": vec![0x07u8; 32],
        "amount_micro_usdc": 1_000_000u64,
        "fee_micro_usdc": 1_000_000u64,
        "authorization_signer_epoch": 3u64,
        "solana_tx_signature": vec![0x10u8; 64],
        "finalized_slot": 900u64,
        "finalized_blockhash": vec![0x33u8; 32],
        "receipt_quorum_kind": 1,
        "receipt_authority_epoch": 3u64,
    })
}

/// The engine golden `OperatorReceiptProof` fixture (mirrors exchange-core
/// `codec::tests::golden_proof`): a 4-of-n bitmap and four 64-byte ed25519
/// signatures.
fn operator_proof_json() -> serde_json::Value {
    json!({
        "signer_bitmap": vec![0x0Fu8],
        "signatures": vec![
            vec![0xABu8; 64],
            vec![0xCDu8; 64],
            vec![0xEFu8; 64],
            vec![0x12u8; 64],
        ],
    })
}

fn error_case(case: &str, code: u32, log: Option<&str>) -> cv::ErrorCase {
    let name = cv::error_reference_name(code, log)
        .unwrap_or_else(|| panic!("no error name for {case} (code {code})"));
    cv::ErrorCase {
        case: case.to_string(),
        code,
        log: log.map(str::to_string),
        expect: cv::ErrorExpect {
            name: name.to_string(),
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
    const CONFIRM_DEPOSIT: u8 = 0x09;
    const CREATE_MARKET: u8 = 0x07;
    const UPDATE_MARKET_FEES: u8 = 0x10;
    const ATOMIC_BASKET_ORDER: u8 = 0x1C;
    const PROPOSE_ADMIN_ACTION: u8 = 0x1E;
    const APPROVE_ADMIN_ACTION: u8 = 0x1F;
    const REJECT_ADMIN_ACTION: u8 = 0x20;
    const EMERGENCY_ADMIN_ACTION: u8 = 0x21;
    const CONFIRM_WITHDRAWAL_RECEIPT: u8 = 0x22;
    const FAIL_WITHDRAWAL_RECEIPT: u8 = 0x23;
    const AUTHORIZE_WITHDRAWAL: u8 = 0x24;
    // Coverage burn-down (issue #69): the 15 previously-unpinned action types.
    // (CONFIRM_DEPOSIT is already declared above.)
    const DEPOSIT: u8 = 0x05;
    const WITHDRAW: u8 = 0x06;
    const WITHDRAW_REQUEST: u8 = 0x08;
    const CONFIRM_WITHDRAWAL: u8 = 0x0a;
    const FAIL_WITHDRAWAL: u8 = 0x0b;
    const APPROVE_AGENT: u8 = 0x0c;
    const REVOKE_AGENT: u8 = 0x0d;
    const CREATE_IMPACT_MARKET: u8 = 0x0e;
    const RESOLVE_EVENT: u8 = 0x0f;
    const SET_USER_MARKET_LEVERAGE: u8 = 0x16;
    const CANCEL_CLIENT_ORDER: u8 = 0x18;
    const CANCEL_ALL_ORDERS: u8 = 0x19;
    const CANCEL_REPLACE_ORDER: u8 = 0x1a;
    const AMEND_ORDER: u8 = 0x1b;
    const SET_POSITION_TRIGGERS: u8 = 0x25;
    const CANCEL_POSITION_TRIGGERS: u8 = 0x26;

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
        // ConfirmDeposit (0x09) with the trailing DepositLocator. Mirrors the
        // engine's own `all_action_variants` fixture (owner 0x55, amount
        // 100_000, sig 0xAB×64, signer 0x66, locator top=3 inner=Some(1)); the
        // locator serializes as a 2-element array `[top_index, inner_index]`.
        codec_case(
            "confirm_deposit/with_locator",
            CONFIRM_DEPOSIT,
            json!({
                "owner": vec![0x55u8; 20],
                "amount": 100_000u64,
                "solana_tx_sig": vec![0xABu8; 64],
                "signer": vec![0x66u8; 20],
                "locator": { "top_index": 3, "inner_index": 1 }
            }),
        ),
        // Pre-locator ConfirmDeposit: the locator is absent and encodes as a
        // trailing `nil`. This is the backward-compatible (MINOR) tail — old
        // 4-field bytes still decode, and the new encoder appends nil when the
        // relayer supplies no locator.
        codec_case(
            "confirm_deposit/no_locator",
            CONFIRM_DEPOSIT,
            json!({
                "owner": vec![0x55u8; 20],
                "amount": 100_000u64,
                "solana_tx_sig": vec![0xABu8; 64],
                "signer": vec![0x66u8; 20]
            }),
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
        // Admin-multisig governance (tags 0x1E–0x21). The nested
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
        // Admin-actions v2: a Batch proposal carrying both item variants —
        // the engine's own golden fixture (perp on market 15 + impact
        // family 91), so the nested-enum path (list payload, both items,
        // the impact serde(default) trailers) is pinned across all three
        // language bindings.
        codec_case(
            "propose_admin_action/batch_perp_plus_impact",
            PROPOSE_ADMIN_ACTION,
            json!({
                "proposer": vec![0x22u8; 20],
                "registry_version": 3u64,
                "action": { "Batch": [
                    { "CreateMarket": {
                        "market": 15, "im_bps": 3334, "mm_bps": 1667,
                        "taker_fee_bps": 5, "maker_fee_bps": 2, "signer": vec![0u8; 20],
                        "funding_interval_ms": 60000u64, "max_funding_rate_bps": 3000,
                        "pool_id": 0, "sz_decimals": 0, "ticker": "", "max_open_interest": 0u64
                    }},
                    { "CreateImpactMarket": {
                        "impact_market_id": 91, "underlying_market": 15,
                        "child_market_base": 9100, "question": "does it land?",
                        "deadline_ms": 1000000u64, "resolution_window_ms": 1000u64,
                        "im_bps": 3334, "mm_bps": 1667,
                        "taker_fee_bps": 5, "maker_fee_bps": 2,
                        "funding_interval_ms": 0u64, "max_funding_rate_bps": 3000,
                        "signer": vec![0u8; 20], "oracle_source": null,
                        "description": "", "rules": ""
                    }}
                ]}
            }),
        ),
        codec_case(
            "propose_admin_action/set_trigger_market_config",
            PROPOSE_ADMIN_ACTION,
            json!({
                "proposer": vec![0x22u8; 20],
                "registry_version": 3u64,
                "action": { "SetTriggerMarketConfig": {
                    "market": 7,
                    "expected_current_version": 3u64,
                    "enabled": true,
                    "max_trigger_slippage_bps": 250u32,
                    "max_mark_age_ms": 5_000u64,
                    "max_future_publish_skew_ms": 1_000u64,
                    "max_active_brackets": 32u64
                }}
            }),
        ),
        // UnpauseBridge is a UNIT admin-action variant: it carries no fields
        // and serializes as the bare string `"UnpauseBridge"` (not a
        // `{ Variant: {} }` map like the fieldless struct variant HaltTrading).
        // Byte-for-byte the engine's frozen ProposeAdminAction::UnpauseBridge
        // vector (exchange-wire `codec::tests::admin_action_wire_vectors_frozen`).
        codec_case(
            "propose_admin_action/unpause_bridge",
            PROPOSE_ADMIN_ACTION,
            json!({
                "proposer": vec![0xA1u8; 20],
                "registry_version": 1u64,
                "action": "UnpauseBridge"
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
        // HaltTrading is the trickiest arm to mirror: a fieldless STRUCT
        // variant (`HaltTrading {}`), so it stays in serde's map form
        // `{ "HaltTrading": {} }` — not the bare-string form a unit variant
        // would take.
        codec_case(
            "emergency_admin_action/halt_trading",
            EMERGENCY_ADMIN_ACTION,
            json!({
                "signer": vec![0x44u8; 20],
                "action": { "HaltTrading": {} }
            }),
        ),
        codec_case(
            "emergency_admin_action/set_reduce_only",
            EMERGENCY_ADMIN_ACTION,
            json!({
                "signer": vec![0x44u8; 20],
                "action": { "SetReduceOnly": { "market_id": 7 } }
            }),
        ),
        // W28-20 receipt-gated terminal withdrawals (0x22 / 0x23). The receipt
        // + operator-ed25519 proof fixtures mirror the engine golden vectors
        // (exchange-core `codec::tests::golden_receipt` / `golden_proof`); the
        // generated payload_hex must equal the engine's committed
        // docs/spec/golden-vectors/{confirm,fail}_withdrawal_receipt.hex.
        codec_case(
            "confirm_withdrawal_receipt/paid",
            CONFIRM_WITHDRAWAL_RECEIPT,
            json!({
                "receipt": receipt_json(1),
                "proof": operator_proof_json(),
            }),
        ),
        codec_case(
            "fail_withdrawal_receipt/cancelled",
            FAIL_WITHDRAWAL_RECEIPT,
            json!({
                "receipt": receipt_json(2),
                "proof": operator_proof_json(),
            }),
        ),
        // The authorization leg (0x24): the fixed 221-byte
        // `WithdrawalAuthorizationV1` bytes + the operator proof. The engine
        // commits no golden .hex for this action; the engine-derived pin is
        // crates/spec/golden-vectors/authorize_withdrawal.hex (see the core
        // golden test), and this case carries it to all three runners.
        codec_case(
            "authorize_withdrawal/operator",
            AUTHORIZE_WITHDRAWAL,
            json!({
                "authorization": vec![0x44u8; 221],
                "proof": operator_proof_json(),
            }),
        ),
        // ── coverage burn-down (issue #69) ───────────────────────────────
        // The 15 action types the coverage ratchet carried as debt. Each is
        // already exercised by round-trip tests but had no cross-language byte
        // pin; these vectors close the gap. Optional-bearing actions carry both
        // a populated and a null-optional case so the `nil` tail is pinned too.
        //
        // Balance movement (legacy deposit/withdraw + Solana bridge lifecycle).
        codec_case(
            "deposit/basic",
            DEPOSIT,
            json!({ "owner": owner, "amount": 100_000_000u64, "signer": signer }),
        ),
        codec_case(
            "withdraw/basic",
            WITHDRAW,
            json!({ "owner": owner, "amount": 50_000_000u64, "signer": signer }),
        ),
        codec_case(
            "withdraw_request/basic",
            WITHDRAW_REQUEST,
            json!({ "owner": owner, "amount": 50_000_000u64,
                    "solana_destination": vec![0x44u8; 32] }),
        ),
        codec_case(
            "confirm_deposit/basic",
            CONFIRM_DEPOSIT,
            json!({ "owner": owner, "amount": 100_000_000u64,
                    "solana_tx_sig": vec![0xABu8; 64], "signer": signer }),
        ),
        codec_case(
            "confirm_withdrawal/basic",
            CONFIRM_WITHDRAWAL,
            json!({ "withdrawal_id": 7u64,
                    "solana_tx_sig": vec![0xABu8; 64], "signer": signer }),
        ),
        codec_case(
            "fail_withdrawal/basic",
            FAIL_WITHDRAWAL,
            json!({ "withdrawal_id": 7u64,
                    "reason": "insufficient bridge liquidity", "signer": signer }),
        ),
        // Agent authorization.
        codec_case(
            "approve_agent/basic",
            APPROVE_AGENT,
            json!({ "owner": owner, "agent_pubkey": vec![0xAAu8; 32] }),
        ),
        codec_case(
            "revoke_agent/basic",
            REVOKE_AGENT,
            json!({ "owner": owner, "agent_pubkey": vec![0xAAu8; 32] }),
        ),
        // Impact-market create (standalone 0x0e) + resolution. oracle_source,
        // description, and rules are serde(default); the happy case leaves them
        // absent (RelayerAttested / empty), matching the common relayer path.
        codec_case(
            "create_impact_market/relayer_attested",
            CREATE_IMPACT_MARKET,
            json!({
                "impact_market_id": 91, "underlying_market": 15,
                "child_market_base": 9100, "question": "does it land?",
                "deadline_ms": 1_000_000u64, "resolution_window_ms": 1000u64,
                "im_bps": 3334, "mm_bps": 1667,
                "taker_fee_bps": 5, "maker_fee_bps": 2,
                "funding_interval_ms": 60000u64, "max_funding_rate_bps": 3000,
                "signer": signer, "oracle_source": null,
                "description": "", "rules": ""
            }),
        ),
        codec_case(
            "resolve_event/yes",
            RESOLVE_EVENT,
            json!({ "impact_market_id": 91, "outcome": "Yes", "signer": signer }),
        ),
        // Per-user leverage override.
        codec_case(
            "set_user_market_leverage/basic",
            SET_USER_MARKET_LEVERAGE,
            json!({ "owner": owner, "market": 7, "user_im_bps": 2000 }),
        ),
        // Order management: cancel-by-cloid, cancel-all (scoped + global),
        // cancel-replace (by order id + by client id), amend (populated + null).
        codec_case(
            "cancel_client_order/basic",
            CANCEL_CLIENT_ORDER,
            json!({ "owner": owner, "client_order_id": 99u64 }),
        ),
        codec_case(
            "cancel_all_orders/market_scoped",
            CANCEL_ALL_ORDERS,
            json!({ "owner": owner, "market": 7 }),
        ),
        codec_case(
            "cancel_all_orders/all_markets",
            CANCEL_ALL_ORDERS,
            json!({ "owner": owner, "market": null }),
        ),
        codec_case(
            "cancel_replace_order/by_order_id",
            CANCEL_REPLACE_ORDER,
            json!({
                "owner": owner, "cancel_order_id": 42u64,
                "cancel_client_order_id": null, "market": 1, "side": "Buy",
                "price": 6675000u64, "quantity": 3, "client_order_id": 77u64,
                "post_only": false, "reduce_only": false, "time_in_force": "Gtc"
            }),
        ),
        codec_case(
            "cancel_replace_order/by_client_id",
            CANCEL_REPLACE_ORDER,
            json!({
                "owner": owner, "cancel_order_id": null,
                "cancel_client_order_id": 88u64, "market": 2, "side": "Sell",
                "price": 250000u64, "quantity": 5, "client_order_id": null,
                "post_only": true, "reduce_only": true, "time_in_force": "Ioc"
            }),
        ),
        codec_case(
            "amend_order/price_and_quantity",
            AMEND_ORDER,
            json!({ "owner": owner, "order_id": 42u64,
                    "new_price": 6675000u64, "new_quantity": 5u64 }),
        ),
        codec_case(
            "amend_order/both_null",
            AMEND_ORDER,
            json!({ "owner": owner, "order_id": 42u64,
                    "new_price": null, "new_quantity": null }),
        ),
        // W32-10 whole-position bracket actions. This is the literal fixture
        // from exchange-core's position-trigger golden-vector test.
        codec_case(
            "set_position_triggers/engine_golden",
            SET_POSITION_TRIGGERS,
            json!({
                "market": 7,
                "owner": vec![0xA5u8; 20],
                "expected_position_epoch": 3u64,
                "stop_loss": {
                    "trigger_price": 95_000u64,
                    "max_slippage_bps": 75u32,
                    "client_trigger_id": 11u64
                },
                "take_profit": {
                    "trigger_price": 110_000u64,
                    "max_slippage_bps": 50u32,
                    "client_trigger_id": 12u64
                },
                "client_group_id": 9u64
            }),
        ),
        codec_case(
            "cancel_position_triggers/engine_golden",
            CANCEL_POSITION_TRIGGERS,
            json!({
                "market": 7,
                "owner": vec![0xA5u8; 20],
                "expected_position_epoch": 3u64
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

    // ── errors family ────────────────────────────────────────────────────
    // Manifest: pin every numeric code → canonical name. This is the family
    // that would have failed the pre-#55 SDK (which mapped open interest to 50
    // and had no 51 entry) — `manifest/51` → OpenInterestLimitExceeded and
    // `manifest/50` → SlippageExceeded together pin the split.
    //
    // Code 21 is now pinned like every other code: the TS SDK was aligned to
    // the engine/Rust/Python name `InvalidNonce` (#63), removing the
    // `TimestampNonceRejected` divergence that previously forced a carve-out.
    let mut errors: Vec<cv::ErrorCase> = proof_trading_sdk::errors::ERROR_KINDS
        .iter()
        .map(|kind| kind.code())
        .map(|code| error_case(&format!("manifest/{code}"), code, None))
        .collect();

    // Transitional code-50 rolling-upgrade family: the canonical DeliverTx log
    // disambiguates legacy open-interest from current slippage; anything else
    // stays AmbiguousCode50 (never a guess). Plus a code-51 case proving the
    // log is ignored once the engine emits the distinct code.
    errors.push(error_case(
        "code50/oi_log",
        50,
        Some("open interest limit exceeded on market 7: would be 4, cap 3"),
    ));
    errors.push(error_case(
        "code50/slippage_log",
        50,
        Some("atomic basket aggregate slippage 51 bps exceeds budget 50 bps"),
    ));
    errors.push(error_case("code50/empty", 50, Some("")));
    errors.push(error_case(
        "code50/unknown_log",
        50,
        Some("unknown code 50 diagnostic"),
    ));
    errors.push(error_case("code51/ignored_log", 51, Some("unrecognized")));
    write_ndjson(&dir.join(cv::ERRORS_FILE), &errors)?;

    eprintln!(
        "wrote {} codec, {} signing, {} nonce, {} errors cases to {}",
        codec.len(),
        signing.len(),
        nonce.len(),
        errors.len(),
        dir.display()
    );
    Ok(())
}
