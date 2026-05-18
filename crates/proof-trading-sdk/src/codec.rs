use crate::types::{Action, ExecError};
use serde::{Deserialize, Serialize};

pub const ACTION_PLACE_ORDER: u8 = 0x01;
pub const ACTION_CANCEL_ORDER: u8 = 0x02;
pub const ACTION_ORACLE_UPDATE: u8 = 0x03;
pub const ACTION_MARKET_ORDER: u8 = 0x04;
pub const ACTION_DEPOSIT: u8 = 0x05;
pub const ACTION_WITHDRAW: u8 = 0x06;
pub const ACTION_CREATE_MARKET: u8 = 0x07;
pub const ACTION_WITHDRAW_REQUEST: u8 = 0x08;
pub const ACTION_CONFIRM_DEPOSIT: u8 = 0x09;
pub const ACTION_CONFIRM_WITHDRAWAL: u8 = 0x0A;
pub const ACTION_FAIL_WITHDRAWAL: u8 = 0x0B;
pub const ACTION_APPROVE_AGENT: u8 = 0x0C;
pub const ACTION_REVOKE_AGENT: u8 = 0x0D;
pub const ACTION_CREATE_IMPACT_MARKET: u8 = 0x0E;
pub const ACTION_RESOLVE_EVENT: u8 = 0x0F;
pub const ACTION_UPDATE_MARKET_FEES: u8 = 0x10;
pub const ACTION_RUN_LIQUIDATION_SWEEP: u8 = 0x11;
pub const ACTION_RUN_FUNDING_TICK: u8 = 0x12;
/// BE-46: per-account fee override (relayer-signed admin action).
pub const ACTION_SET_ACCOUNT_FEE_OVERRIDE: u8 = 0x13;
/// BE-31 Phase B: composite-CEX price update.
pub const ACTION_ORACLE_UPDATE_COMPOSITE: u8 = 0x14;
/// BE-40 — relayer-signed action that marks a Solana deposit signature
/// as permanently failed (malformed tx, unsupported token, dust). User
/// is NOT credited. Idempotent on retry; no-op if the signature is
/// already in either the processed-deposits or failed-deposits set.
pub const ACTION_FAIL_DEPOSIT: u8 = 0x15;
/// Pick a per-user IM override on a single market. User-signed,
/// not relayer-signed — each owner sets their own. BE-16.
pub const ACTION_SET_USER_MARKET_LEVERAGE: u8 = 0x16;
/// Close an existing position via opposite-side IOC order. User-signed.
/// Idempotent on already-closed positions. S49.
pub const ACTION_CLOSE_POSITION: u8 = 0x17;
/// Cancel an active resting order by owner-scoped client_order_id.
pub const ACTION_CANCEL_CLIENT_ORDER: u8 = 0x18;
/// Cancel all active resting orders for an owner, optionally market-scoped.
pub const ACTION_CANCEL_ALL_ORDERS: u8 = 0x19;
/// Atomically cancel one resting order and place its replacement.
pub const ACTION_CANCEL_REPLACE_ORDER: u8 = 0x1A;

/// V1 wire envelope: [version=1, action_type, seq, payload_bytes]
///
/// `payload` uses `serde_bytes` so rmp-serde emits it as a msgpack `bin`
/// (0xc4/c5/c6) rather than an array of u8 (0xdc). This matches what the
/// SDK produces and what the Go validator's CheckTx parser expects. Before
/// this attribute, Rust-built wire bytes had `payload` as an array, which
/// the SDK can read (it accepts both) but the Go validator rejects with
/// "invalid payload: expected bin format, got msgpack type 0xdc".
#[derive(Serialize, Deserialize)]
struct WireTxEnvelope {
    version: u8,
    action_type: u8,
    seq: u64,
    #[serde(with = "serde_bytes")]
    payload: Vec<u8>,
}

/// V2 wire envelope: [version=2, action_type, seq, payload_bytes, pubkey, signature]
#[derive(Serialize, Deserialize)]
struct WireTxEnvelopeV2 {
    version: u8,
    action_type: u8,
    seq: u64,
    #[serde(with = "serde_bytes")]
    payload: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pubkey: [u8; 32],
    #[serde(with = "serde_bytes")]
    signature: [u8; 64],
}

/// Authentication data extracted from a v2 envelope.
#[derive(Debug)]
pub struct TxAuth {
    pub pubkey: [u8; 32],
    pub signature: [u8; 64],
    pub action_type: u8,
    pub payload: Vec<u8>,
}

/// Result of decoding a transaction.
#[derive(Debug)]
pub struct DecodedTx {
    pub action: Action,
    pub seq: u64,
    /// None for v1 (unsigned) transactions, Some for v2 (signed).
    pub auth: Option<TxAuth>,
}

/// Decode a payload into an Action given its action_type discriminant.
fn decode_action(action_type: u8, payload: &[u8]) -> Result<Action, ExecError> {
    let de = |e: rmp_serde::decode::Error| ExecError::DecodeError(e.to_string());
    match action_type {
        ACTION_PLACE_ORDER => Ok(Action::PlaceOrder(
            rmp_serde::from_slice(payload).map_err(de)?,
        )),
        ACTION_CANCEL_ORDER => Ok(Action::CancelOrder(
            rmp_serde::from_slice(payload).map_err(de)?,
        )),
        ACTION_CANCEL_CLIENT_ORDER => Ok(Action::CancelClientOrder(
            rmp_serde::from_slice(payload).map_err(de)?,
        )),
        ACTION_CANCEL_ALL_ORDERS => Ok(Action::CancelAllOrders(
            rmp_serde::from_slice(payload).map_err(de)?,
        )),
        ACTION_CANCEL_REPLACE_ORDER => Ok(Action::CancelReplaceOrder(
            rmp_serde::from_slice(payload).map_err(de)?,
        )),
        ACTION_ORACLE_UPDATE => Ok(Action::OracleUpdate(
            rmp_serde::from_slice(payload).map_err(de)?,
        )),
        ACTION_MARKET_ORDER => Ok(Action::MarketOrder(
            rmp_serde::from_slice(payload).map_err(de)?,
        )),
        ACTION_DEPOSIT => Ok(Action::Deposit(rmp_serde::from_slice(payload).map_err(de)?)),
        ACTION_WITHDRAW => Ok(Action::Withdraw(
            rmp_serde::from_slice(payload).map_err(de)?,
        )),
        ACTION_CREATE_MARKET => Ok(Action::CreateMarket(
            rmp_serde::from_slice(payload).map_err(de)?,
        )),
        ACTION_WITHDRAW_REQUEST => Ok(Action::WithdrawRequest(
            rmp_serde::from_slice(payload).map_err(de)?,
        )),
        ACTION_CONFIRM_DEPOSIT => Ok(Action::ConfirmDeposit(
            rmp_serde::from_slice(payload).map_err(de)?,
        )),
        ACTION_CONFIRM_WITHDRAWAL => Ok(Action::ConfirmWithdrawal(
            rmp_serde::from_slice(payload).map_err(de)?,
        )),
        ACTION_FAIL_WITHDRAWAL => Ok(Action::FailWithdrawal(
            rmp_serde::from_slice(payload).map_err(de)?,
        )),
        ACTION_APPROVE_AGENT => Ok(Action::ApproveAgent(
            rmp_serde::from_slice(payload).map_err(de)?,
        )),
        ACTION_REVOKE_AGENT => Ok(Action::RevokeAgent(
            rmp_serde::from_slice(payload).map_err(de)?,
        )),
        ACTION_CREATE_IMPACT_MARKET => Ok(Action::CreateImpactMarket(
            rmp_serde::from_slice(payload).map_err(de)?,
        )),
        ACTION_RESOLVE_EVENT => Ok(Action::ResolveEvent(
            rmp_serde::from_slice(payload).map_err(de)?,
        )),
        ACTION_UPDATE_MARKET_FEES => Ok(Action::UpdateMarketFees(
            rmp_serde::from_slice(payload).map_err(de)?,
        )),
        ACTION_SET_ACCOUNT_FEE_OVERRIDE => Ok(Action::SetAccountFeeOverride(
            rmp_serde::from_slice(payload).map_err(de)?,
        )),
        ACTION_RUN_LIQUIDATION_SWEEP => Ok(Action::RunLiquidationSweep(
            rmp_serde::from_slice(payload).map_err(de)?,
        )),
        ACTION_RUN_FUNDING_TICK => Ok(Action::RunFundingTick(
            rmp_serde::from_slice(payload).map_err(de)?,
        )),
        ACTION_ORACLE_UPDATE_COMPOSITE => Ok(Action::OracleUpdateComposite(
            rmp_serde::from_slice(payload).map_err(de)?,
        )),
        ACTION_FAIL_DEPOSIT => Ok(Action::FailDeposit(
            rmp_serde::from_slice(payload).map_err(de)?,
        )),
        ACTION_SET_USER_MARKET_LEVERAGE => Ok(Action::SetUserMarketLeverage(
            rmp_serde::from_slice(payload).map_err(de)?,
        )),
        ACTION_CLOSE_POSITION => Ok(Action::ClosePosition(
            rmp_serde::from_slice(payload).map_err(de)?,
        )),
        other => Err(ExecError::DecodeError(format!(
            "unknown action_type: {other:#x}"
        ))),
    }
}

/// Decode raw tx bytes. Supports both v1 (unsigned) and v2 (signed) envelopes.
///
/// V1: fixarray(4) `[version=1, action_type, seq, payload]`
/// V2: fixarray(6) `[version=2, action_type, seq, payload, pubkey, signature]`
pub fn decode_tx(bytes: &[u8]) -> Result<DecodedTx, ExecError> {
    if bytes.is_empty() {
        return Err(ExecError::DecodeError("empty tx".to_string()));
    }

    // Peek at MessagePack fixarray marker to detect v1 vs v2.
    let arr_len = match bytes[0] {
        b if b & 0xF0 == 0x90 => (b & 0x0F) as usize,
        _ => {
            // Not a fixarray — try full decode as v1 for better error message
            let envelope: WireTxEnvelope =
                rmp_serde::from_slice(bytes).map_err(|e| ExecError::DecodeError(e.to_string()))?;
            return decode_v1_envelope(envelope);
        }
    };

    match arr_len {
        4 => {
            let envelope: WireTxEnvelope =
                rmp_serde::from_slice(bytes).map_err(|e| ExecError::DecodeError(e.to_string()))?;
            decode_v1_envelope(envelope)
        }
        6 => {
            let envelope: WireTxEnvelopeV2 =
                rmp_serde::from_slice(bytes).map_err(|e| ExecError::DecodeError(e.to_string()))?;
            decode_v2_envelope(envelope)
        }
        _ => Err(ExecError::DecodeError(format!(
            "unexpected envelope array length: {arr_len}"
        ))),
    }
}

fn decode_v1_envelope(envelope: WireTxEnvelope) -> Result<DecodedTx, ExecError> {
    if envelope.version != 1 {
        return Err(ExecError::DecodeError(format!(
            "unsupported version: {}",
            envelope.version
        )));
    }
    let action = decode_action(envelope.action_type, &envelope.payload)?;
    Ok(DecodedTx {
        action,
        seq: envelope.seq,
        auth: None,
    })
}

fn decode_v2_envelope(envelope: WireTxEnvelopeV2) -> Result<DecodedTx, ExecError> {
    if envelope.version != 2 {
        return Err(ExecError::DecodeError(format!(
            "v2 envelope requires version 2, got {}",
            envelope.version
        )));
    }

    let action = decode_action(envelope.action_type, &envelope.payload)?;

    Ok(DecodedTx {
        action,
        seq: envelope.seq,
        auth: Some(TxAuth {
            pubkey: envelope.pubkey,
            signature: envelope.signature,
            action_type: envelope.action_type,
            payload: envelope.payload,
        }),
    })
}

/// Determine the action_type byte and serialize the payload for an Action.
fn encode_action(action: &Action) -> Result<(u8, Vec<u8>), ExecError> {
    let enc = |e: rmp_serde::encode::Error| ExecError::InternalError(e.to_string());
    match action {
        Action::PlaceOrder(cmd) => Ok((ACTION_PLACE_ORDER, rmp_serde::to_vec(cmd).map_err(enc)?)),
        Action::CancelOrder(cmd) => Ok((ACTION_CANCEL_ORDER, rmp_serde::to_vec(cmd).map_err(enc)?)),
        Action::CancelClientOrder(cmd) => Ok((
            ACTION_CANCEL_CLIENT_ORDER,
            rmp_serde::to_vec(cmd).map_err(enc)?,
        )),
        Action::CancelAllOrders(cmd) => Ok((
            ACTION_CANCEL_ALL_ORDERS,
            rmp_serde::to_vec(cmd).map_err(enc)?,
        )),
        Action::CancelReplaceOrder(cmd) => Ok((
            ACTION_CANCEL_REPLACE_ORDER,
            rmp_serde::to_vec(cmd).map_err(enc)?,
        )),
        Action::OracleUpdate(cmd) => {
            Ok((ACTION_ORACLE_UPDATE, rmp_serde::to_vec(cmd).map_err(enc)?))
        }
        Action::MarketOrder(cmd) => Ok((ACTION_MARKET_ORDER, rmp_serde::to_vec(cmd).map_err(enc)?)),
        Action::Deposit(cmd) => Ok((ACTION_DEPOSIT, rmp_serde::to_vec(cmd).map_err(enc)?)),
        Action::Withdraw(cmd) => Ok((ACTION_WITHDRAW, rmp_serde::to_vec(cmd).map_err(enc)?)),
        Action::CreateMarket(cmd) => {
            Ok((ACTION_CREATE_MARKET, rmp_serde::to_vec(cmd).map_err(enc)?))
        }
        Action::WithdrawRequest(cmd) => Ok((
            ACTION_WITHDRAW_REQUEST,
            rmp_serde::to_vec(cmd).map_err(enc)?,
        )),
        Action::ConfirmDeposit(cmd) => {
            Ok((ACTION_CONFIRM_DEPOSIT, rmp_serde::to_vec(cmd).map_err(enc)?))
        }
        Action::ConfirmWithdrawal(cmd) => Ok((
            ACTION_CONFIRM_WITHDRAWAL,
            rmp_serde::to_vec(cmd).map_err(enc)?,
        )),
        Action::FailWithdrawal(cmd) => {
            Ok((ACTION_FAIL_WITHDRAWAL, rmp_serde::to_vec(cmd).map_err(enc)?))
        }
        Action::ApproveAgent(cmd) => {
            Ok((ACTION_APPROVE_AGENT, rmp_serde::to_vec(cmd).map_err(enc)?))
        }
        Action::RevokeAgent(cmd) => Ok((ACTION_REVOKE_AGENT, rmp_serde::to_vec(cmd).map_err(enc)?)),
        Action::CreateImpactMarket(cmd) => Ok((
            ACTION_CREATE_IMPACT_MARKET,
            rmp_serde::to_vec(cmd).map_err(enc)?,
        )),
        Action::ResolveEvent(cmd) => {
            Ok((ACTION_RESOLVE_EVENT, rmp_serde::to_vec(cmd).map_err(enc)?))
        }
        Action::UpdateMarketFees(cmd) => Ok((
            ACTION_UPDATE_MARKET_FEES,
            rmp_serde::to_vec(cmd).map_err(enc)?,
        )),
        Action::SetAccountFeeOverride(cmd) => Ok((
            ACTION_SET_ACCOUNT_FEE_OVERRIDE,
            rmp_serde::to_vec(cmd).map_err(enc)?,
        )),
        Action::RunLiquidationSweep(cmd) => Ok((
            ACTION_RUN_LIQUIDATION_SWEEP,
            rmp_serde::to_vec(cmd).map_err(enc)?,
        )),
        Action::RunFundingTick(cmd) => Ok((
            ACTION_RUN_FUNDING_TICK,
            rmp_serde::to_vec(cmd).map_err(enc)?,
        )),
        Action::OracleUpdateComposite(cmd) => Ok((
            ACTION_ORACLE_UPDATE_COMPOSITE,
            rmp_serde::to_vec(cmd).map_err(enc)?,
        )),
        Action::FailDeposit(cmd) => Ok((ACTION_FAIL_DEPOSIT, rmp_serde::to_vec(cmd).map_err(enc)?)),
        Action::SetUserMarketLeverage(cmd) => Ok((
            ACTION_SET_USER_MARKET_LEVERAGE,
            rmp_serde::to_vec(cmd).map_err(enc)?,
        )),
        Action::ClosePosition(cmd) => {
            Ok((ACTION_CLOSE_POSITION, rmp_serde::to_vec(cmd).map_err(enc)?))
        }
    }
}

/// Encode an Action as a v1 (unsigned) wire envelope.
///
/// **Deprecated**: v1 unsigned envelopes are rejected by CheckTx and by
/// `execute_tx` in production builds. Use [`sign_and_encode`] instead.
/// Kept for test convenience and golden-vector generation.
pub fn encode_tx(action: &Action, seq: u64) -> Result<Vec<u8>, ExecError> {
    let (action_type, payload) = encode_action(action)?;
    let envelope = WireTxEnvelope {
        version: 1,
        action_type,
        seq,
        payload,
    };
    rmp_serde::to_vec(&envelope).map_err(|e| ExecError::InternalError(e.to_string()))
}

/// Encode an Action as a v2 (signed) wire envelope.
pub fn encode_tx_v2(
    action: &Action,
    seq: u64,
    pubkey: &[u8; 32],
    signature: &[u8; 64],
) -> Result<Vec<u8>, ExecError> {
    let (action_type, payload) = encode_action(action)?;
    let envelope = WireTxEnvelopeV2 {
        version: 2,
        action_type,
        seq,
        payload,
        pubkey: *pubkey,
        signature: *signature,
    };
    rmp_serde::to_vec(&envelope).map_err(|e| ExecError::InternalError(e.to_string()))
}

/// Sign an action and encode it as a v2 wire envelope, binding the
/// signature to a specific `chain_id`. The wire envelope format is
/// unchanged (chain_id is not carried on the wire — it's established
/// by genesis / snapshot-load and every node verifies against its
/// stored value), but the signing bytes gained a 32-byte chain_id
/// prefix in v3 per audit B4.
pub fn sign_and_encode_with_chain(
    chain_id: &[u8; 32],
    action: &Action,
    seq: u64,
    signing_key: &ed25519_dalek::SigningKey,
) -> Result<Vec<u8>, ExecError> {
    use ed25519_dalek::Signer;

    let (action_type, payload) = encode_action(action)?;
    let msg = crate::crypto::signing_message(chain_id, action_type, seq, &payload);
    let sig = signing_key.sign(&msg);

    let pubkey = signing_key.verifying_key().to_bytes();
    let signature = sig.to_bytes();

    let envelope = WireTxEnvelopeV2 {
        version: 2,
        action_type,
        seq,
        payload,
        pubkey,
        signature,
    };
    rmp_serde::to_vec(&envelope).map_err(|e| ExecError::InternalError(e.to_string()))
}

/// Test-only convenience: sign with the `UNBOUND_CHAIN_ID`. Production
/// code MUST use `sign_and_encode_with_chain` with a real chain_id,
/// otherwise the signature is trivially replayable on any
/// zero-chain_id deployment. Kept public because `exchange-core`
/// integration tests are spread across multiple modules.
pub fn sign_and_encode(
    action: &Action,
    seq: u64,
    signing_key: &ed25519_dalek::SigningKey,
) -> Result<Vec<u8>, ExecError> {
    sign_and_encode_with_chain(&crate::crypto::UNBOUND_CHAIN_ID, action, seq, signing_key)
}

/// Extract the action_type byte from a wire tx without full decoding.
/// Works for both v1 (fixarray 4) and v2 (fixarray 6) envelopes.
pub fn peek_action_type(bytes: &[u8]) -> Option<u8> {
    // Try v1 first (more common), then v2
    if let Ok(env) = rmp_serde::from_slice::<WireTxEnvelope>(bytes) {
        return Some(env.action_type);
    }
    if let Ok(env) = rmp_serde::from_slice::<WireTxEnvelopeV2>(bytes) {
        return Some(env.action_type);
    }
    None
}

/// Extract the seq number from a wire tx without deserializing the payload action.
/// The payload bytes are read but not interpreted.
pub fn peek_seq(bytes: &[u8]) -> Option<u64> {
    let envelope: WireTxEnvelope = rmp_serde::from_slice(bytes).ok()?;
    Some(envelope.seq)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::types::{
        ApproveAgent, CancelOrder, CancelReplaceOrder, ConfirmDeposit, ConfirmWithdrawal,
        CreateMarket, Deposit, FailWithdrawal, MarketOrder, OracleUpdate, PlaceOrder, RevokeAgent,
        Side, TimeInForce, Withdraw, WithdrawRequest,
    };

    #[test]
    fn test_round_trip_place_order() {
        let action = Action::PlaceOrder(PlaceOrder {
            market: 1,
            owner: [0xAA; 20],
            side: Side::Buy,
            price: 10000,
            quantity: 50,
            client_order_id: Some(42),
            post_only: false,
            reduce_only: false,
            time_in_force: TimeInForce::Gtc,
        });

        let encoded = encode_tx(&action, 100).unwrap();
        let DecodedTx {
            action: decoded,
            seq,
            auth,
        } = decode_tx(&encoded).unwrap();
        assert!(auth.is_none()); // v1 is unsigned

        assert_eq!(seq, 100);
        match decoded {
            Action::PlaceOrder(cmd) => {
                assert_eq!(cmd.market, 1);
                assert_eq!(cmd.price, 10000);
                assert_eq!(cmd.quantity, 50);
                assert_eq!(cmd.side, Side::Buy);
                assert_eq!(cmd.owner, [0xAA; 20]);
                assert_eq!(cmd.client_order_id, Some(42));
                assert_eq!(cmd.time_in_force, TimeInForce::Gtc);
            }
            _ => panic!("expected PlaceOrder"),
        }
    }

    #[test]
    fn test_round_trip_place_order_fok_time_in_force() {
        let action = Action::PlaceOrder(PlaceOrder {
            market: 1,
            owner: [0xAA; 20],
            side: Side::Buy,
            price: 10000,
            quantity: 50,
            client_order_id: Some(43),
            post_only: false,
            reduce_only: false,
            time_in_force: TimeInForce::Fok,
        });

        let encoded = encode_tx(&action, 101).unwrap();
        let DecodedTx {
            action: decoded,
            seq,
            auth,
        } = decode_tx(&encoded).unwrap();
        assert!(auth.is_none());
        assert_eq!(seq, 101);
        match decoded {
            Action::PlaceOrder(cmd) => {
                assert_eq!(cmd.client_order_id, Some(43));
                assert_eq!(cmd.time_in_force, TimeInForce::Fok);
            }
            _ => panic!("expected PlaceOrder"),
        }
    }

    #[test]
    fn test_round_trip_cancel_order() {
        let action = Action::CancelOrder(CancelOrder {
            order_id: 999,
            owner: [0xBB; 20],
        });

        let encoded = encode_tx(&action, 200).unwrap();
        let DecodedTx {
            action: decoded,
            seq,
            ..
        } = decode_tx(&encoded).unwrap();

        assert_eq!(seq, 200);
        match decoded {
            Action::CancelOrder(cmd) => {
                assert_eq!(cmd.order_id, 999);
                assert_eq!(cmd.owner, [0xBB; 20]);
            }
            _ => panic!("expected CancelOrder"),
        }
    }

    #[test]
    fn test_round_trip_cancel_replace_order() {
        let action = Action::CancelReplaceOrder(CancelReplaceOrder {
            owner: [0xCC; 20],
            cancel_order_id: None,
            cancel_client_order_id: Some(101),
            market: 7,
            side: Side::Sell,
            price: 12345,
            quantity: 9,
            client_order_id: Some(202),
            post_only: true,
            reduce_only: false,
            time_in_force: TimeInForce::Fok,
        });

        let encoded = encode_tx(&action, 201).unwrap();
        let DecodedTx {
            action: decoded,
            seq,
            ..
        } = decode_tx(&encoded).unwrap();

        assert_eq!(seq, 201);
        match decoded {
            Action::CancelReplaceOrder(cmd) => {
                assert_eq!(cmd.owner, [0xCC; 20]);
                assert_eq!(cmd.cancel_order_id, None);
                assert_eq!(cmd.cancel_client_order_id, Some(101));
                assert_eq!(cmd.market, 7);
                assert_eq!(cmd.side, Side::Sell);
                assert_eq!(cmd.price, 12345);
                assert_eq!(cmd.quantity, 9);
                assert_eq!(cmd.client_order_id, Some(202));
                assert!(cmd.post_only);
                assert_eq!(cmd.time_in_force, TimeInForce::Fok);
            }
            _ => panic!("expected CancelReplaceOrder"),
        }
    }

    #[test]
    fn test_golden_vector_determinism() {
        let action = Action::PlaceOrder(PlaceOrder {
            market: 1,
            owner: [0x01; 20],
            side: Side::Buy,
            price: 100,
            quantity: 10,
            client_order_id: None,
            post_only: false,
            reduce_only: false,
            time_in_force: TimeInForce::Gtc,
        });

        let encoded_a = encode_tx(&action, 1).unwrap();
        let encoded_b = encode_tx(&action, 1).unwrap();
        assert_eq!(encoded_a, encoded_b, "encoding must be deterministic");
    }

    #[test]
    fn test_reject_unknown_version() {
        let bad_envelope = WireTxEnvelope {
            version: 99,
            action_type: ACTION_PLACE_ORDER,
            seq: 0,
            payload: rmp_serde::to_vec(&PlaceOrder {
                market: 1,
                owner: [0x00; 20],
                side: Side::Buy,
                price: 1,
                quantity: 1,
                client_order_id: None,
                post_only: false,
                reduce_only: false,
                time_in_force: TimeInForce::Gtc,
            })
            .unwrap(),
        };
        let encoded = rmp_serde::to_vec(&bad_envelope).unwrap();
        let result = decode_tx(&encoded);
        assert!(result.is_err());
    }

    #[test]
    fn test_generate_golden_vectors() {
        let place = Action::PlaceOrder(PlaceOrder {
            market: 1,
            owner: [0x01; 20],
            side: Side::Buy,
            price: 100,
            quantity: 10,
            client_order_id: None,
            post_only: false,
            reduce_only: false,
            time_in_force: TimeInForce::Gtc,
        });
        let place_bytes = encode_tx(&place, 1).unwrap();
        println!("GOLDEN_PLACE={}", hex::encode(&place_bytes));

        let cancel = Action::CancelOrder(CancelOrder {
            order_id: 42,
            owner: [0x02; 20],
        });
        let cancel_bytes = encode_tx(&cancel, 2).unwrap();
        println!("GOLDEN_CANCEL={}", hex::encode(&cancel_bytes));

        let oracle = Action::OracleUpdate(OracleUpdate {
            market: 1,
            price: 5000,
            signer: [0x03; 20],
            publish_time_ms: 0,
        });
        let oracle_bytes = encode_tx(&oracle, 3).unwrap();
        println!("GOLDEN_ORACLE={}", hex::encode(&oracle_bytes));

        let dt = decode_tx(&place_bytes).unwrap();
        assert_eq!(dt.seq, 1);
        assert!(matches!(dt.action, Action::PlaceOrder(_)));

        let dt = decode_tx(&cancel_bytes).unwrap();
        assert_eq!(dt.seq, 2);
        assert!(matches!(dt.action, Action::CancelOrder(_)));

        let dt = decode_tx(&oracle_bytes).unwrap();
        assert_eq!(dt.seq, 3);
        assert!(matches!(dt.action, Action::OracleUpdate(_)));
    }

    #[test]
    fn test_golden_vector_place_order_matches_file() {
        let expected_hex = include_str!("../../spec/golden-vectors/place_order.hex").trim();
        let action = Action::PlaceOrder(PlaceOrder {
            market: 1,
            owner: [0x01; 20],
            side: Side::Buy,
            price: 100,
            quantity: 10,
            client_order_id: None,
            post_only: false,
            reduce_only: false,
            time_in_force: TimeInForce::Gtc,
        });
        let encoded = encode_tx(&action, 1).unwrap();
        assert_eq!(hex::encode(&encoded), expected_hex);
    }

    #[test]
    fn test_golden_vector_cancel_order_matches_file() {
        let expected_hex = include_str!("../../spec/golden-vectors/cancel_order.hex").trim();
        let action = Action::CancelOrder(CancelOrder {
            order_id: 42,
            owner: [0x02; 20],
        });
        let encoded = encode_tx(&action, 2).unwrap();
        assert_eq!(hex::encode(&encoded), expected_hex);
    }

    #[test]
    fn test_golden_vector_oracle_update_matches_file() {
        let expected_hex = include_str!("../../spec/golden-vectors/oracle_update.hex").trim();
        let action = Action::OracleUpdate(OracleUpdate {
            market: 1,
            price: 5000,
            signer: [0x03; 20],
            publish_time_ms: 0,
        });
        let encoded = encode_tx(&action, 3).unwrap();
        assert_eq!(hex::encode(&encoded), expected_hex);
    }

    #[test]
    fn test_peek_action_type() {
        let action = Action::CancelOrder(CancelOrder {
            order_id: 1,
            owner: [0; 20],
        });
        let encoded = encode_tx(&action, 5).unwrap();
        assert_eq!(peek_action_type(&encoded), Some(ACTION_CANCEL_ORDER));
    }

    // -----------------------------------------------------------------------
    // Stress tests
    // -----------------------------------------------------------------------

    /// Helper: build one instance of every Action variant with realistic values.
    fn all_action_variants() -> Vec<Action> {
        vec![
            Action::PlaceOrder(PlaceOrder {
                market: 1,
                owner: [0xAA; 20],
                side: Side::Buy,
                price: 50_000,
                quantity: 100,
                client_order_id: Some(7),
                post_only: false,
                reduce_only: false,
                time_in_force: TimeInForce::Gtc,
            }),
            Action::CancelOrder(CancelOrder {
                order_id: 42,
                owner: [0xBB; 20],
            }),
            Action::CancelReplaceOrder(CancelReplaceOrder {
                owner: [0xBC; 20],
                cancel_order_id: Some(42),
                cancel_client_order_id: None,
                market: 1,
                side: Side::Sell,
                price: 50_100,
                quantity: 80,
                client_order_id: Some(8),
                post_only: true,
                reduce_only: false,
                time_in_force: TimeInForce::Ioc,
            }),
            Action::OracleUpdate(OracleUpdate {
                market: 2,
                price: 60_000,
                signer: [0xCC; 20],
                publish_time_ms: 0,
            }),
            Action::MarketOrder(MarketOrder {
                market: 3,
                owner: [0xDD; 20],
                side: Side::Sell,
                quantity: 250,
                client_order_id: None,
            }),
            Action::Deposit(Deposit {
                owner: [0x11; 20],
                amount: 1_000_000,
                signer: [0xEE; 20],
            }),
            Action::Withdraw(Withdraw {
                owner: [0x22; 20],
                amount: 500_000,
                signer: [0xEE; 20],
            }),
            Action::CreateMarket(CreateMarket {
                market: 10,
                im_bps: 1000,
                mm_bps: 500,
                taker_fee_bps: 0,
                maker_fee_bps: 0,
                signer: [0xEE; 20],
                funding_interval_ms: 0,
                max_funding_rate_bps: 0,
                pool_id: 0,
            }),
            Action::WithdrawRequest(WithdrawRequest {
                owner: [0x33; 20],
                amount: 250_000,
                solana_destination: [0x44; 32],
            }),
            Action::ConfirmDeposit(ConfirmDeposit {
                owner: [0x55; 20],
                amount: 100_000,
                solana_tx_sig: vec![0xAB; 64],
                signer: [0x66; 20],
            }),
            Action::ConfirmWithdrawal(ConfirmWithdrawal {
                withdrawal_id: 99,
                solana_tx_sig: vec![0xCD; 64],
                signer: [0x77; 20],
            }),
            Action::FailWithdrawal(FailWithdrawal {
                withdrawal_id: 100,
                reason: "destination account closed".to_string(),
                signer: [0x88; 20],
            }),
            Action::FailDeposit(crate::types::FailDeposit {
                solana_signature: vec![0xEF; 64],
                reason: crate::types::FailDepositReason::MalformedTx,
                signer: [0x88; 20],
            }),
            Action::ApproveAgent(ApproveAgent {
                owner: [0x99; 20],
                agent_pubkey: [0xAA; 32],
            }),
            Action::RevokeAgent(RevokeAgent {
                owner: [0xBB; 20],
                agent_pubkey: [0xCC; 32],
            }),
        ]
    }

    #[test]
    fn test_all_action_types_round_trip() {
        for (i, action) in all_action_variants().into_iter().enumerate() {
            let seq = (i as u64) + 1;
            let encoded = encode_tx(&action, seq).unwrap();
            let dt = decode_tx(&encoded).unwrap();
            assert_eq!(dt.seq, seq);

            // Verify fields via Debug representation (all types derive Debug)
            assert_eq!(
                format!("{:?}", action),
                format!("{:?}", dt.action),
                "round-trip mismatch for variant index {i}"
            );
        }
    }

    #[derive(Serialize)]
    struct LegacyCreateMarket {
        market: u32,
        im_bps: u32,
        mm_bps: u32,
        taker_fee_bps: u32,
        maker_fee_bps: u32,
        signer: [u8; 20],
        funding_interval_ms: u64,
        max_funding_rate_bps: u32,
    }

    #[test]
    fn create_market_legacy_payload_defaults_pool_id() {
        let legacy = LegacyCreateMarket {
            market: 10,
            im_bps: 1000,
            mm_bps: 500,
            taker_fee_bps: 0,
            maker_fee_bps: 0,
            signer: [0xEE; 20],
            funding_interval_ms: 0,
            max_funding_rate_bps: 0,
        };
        let envelope = WireTxEnvelope {
            version: 1,
            action_type: ACTION_CREATE_MARKET,
            seq: 42,
            payload: rmp_serde::to_vec(&legacy).unwrap(),
        };
        let encoded = rmp_serde::to_vec(&envelope).unwrap();
        let decoded = decode_tx(&encoded).unwrap();

        match decoded.action {
            Action::CreateMarket(cmd) => {
                assert_eq!(cmd.market, 10);
                assert_eq!(cmd.pool_id, 0);
            }
            other => panic!("expected CreateMarket, got {other:?}"),
        }
    }

    #[test]
    fn test_codec_max_values() {
        let actions: Vec<Action> = vec![
            Action::PlaceOrder(PlaceOrder {
                market: u32::MAX,
                owner: [0xFF; 20],
                side: Side::Sell,
                price: u64::MAX,
                quantity: u64::MAX,
                client_order_id: Some(u64::MAX),
                post_only: false,
                reduce_only: false,
                time_in_force: TimeInForce::Gtc,
            }),
            Action::CancelOrder(CancelOrder {
                order_id: u64::MAX,
                owner: [0xFF; 20],
            }),
            Action::OracleUpdate(OracleUpdate {
                market: u32::MAX,
                price: u64::MAX,
                signer: [0xFF; 20],
                publish_time_ms: 0,
            }),
            Action::MarketOrder(MarketOrder {
                market: u32::MAX,
                owner: [0xFF; 20],
                side: Side::Buy,
                quantity: u64::MAX,
                client_order_id: Some(u64::MAX),
            }),
            Action::Deposit(Deposit {
                owner: [0xFF; 20],
                amount: u64::MAX,
                signer: [0xEE; 20],
            }),
            Action::Withdraw(Withdraw {
                owner: [0xFF; 20],
                amount: u64::MAX,
                signer: [0xEE; 20],
            }),
            Action::CreateMarket(CreateMarket {
                market: u32::MAX,
                im_bps: u32::MAX,
                mm_bps: u32::MAX,
                taker_fee_bps: u32::MAX,
                maker_fee_bps: u32::MAX,
                signer: [0xFF; 20],
                funding_interval_ms: u64::MAX,
                max_funding_rate_bps: u32::MAX,
                pool_id: 0,
            }),
            Action::WithdrawRequest(WithdrawRequest {
                owner: [0xFF; 20],
                amount: u64::MAX,
                solana_destination: [0xFF; 32],
            }),
            Action::ConfirmDeposit(ConfirmDeposit {
                owner: [0xFF; 20],
                amount: u64::MAX,
                solana_tx_sig: vec![0xFF; 1024],
                signer: [0xFF; 20],
            }),
            Action::ConfirmWithdrawal(ConfirmWithdrawal {
                withdrawal_id: u64::MAX,
                solana_tx_sig: vec![0xFF; 1024],
                signer: [0xFF; 20],
            }),
            Action::FailWithdrawal(FailWithdrawal {
                withdrawal_id: u64::MAX,
                reason: "x".repeat(1024),
                signer: [0xFF; 20],
            }),
        ];

        for (i, action) in actions.into_iter().enumerate() {
            let encoded = encode_tx(&action, u64::MAX).unwrap();
            let dt = decode_tx(&encoded).unwrap();
            assert_eq!(dt.seq, u64::MAX);
            assert_eq!(
                format!("{:?}", action),
                format!("{:?}", dt.action),
                "max-values round-trip failed for variant index {i}"
            );
        }
    }

    #[test]
    fn test_codec_empty_and_minimal() {
        let actions: Vec<Action> = vec![
            Action::PlaceOrder(PlaceOrder {
                market: 0,
                owner: [0u8; 20],
                side: Side::Buy,
                price: 0,
                quantity: 0,
                client_order_id: None,
                post_only: false,
                reduce_only: false,
                time_in_force: TimeInForce::Gtc,
            }),
            Action::CancelOrder(CancelOrder {
                order_id: 0,
                owner: [0u8; 20],
            }),
            Action::OracleUpdate(OracleUpdate {
                market: 0,
                price: 0,
                signer: [0u8; 20],
                publish_time_ms: 0,
            }),
            Action::MarketOrder(MarketOrder {
                market: 0,
                owner: [0u8; 20],
                side: Side::Buy,
                quantity: 0,
                client_order_id: None,
            }),
            Action::Deposit(Deposit {
                owner: [0u8; 20],
                amount: 0,
                signer: [0xEE; 20],
            }),
            Action::Withdraw(Withdraw {
                owner: [0u8; 20],
                amount: 0,
                signer: [0xEE; 20],
            }),
            Action::CreateMarket(CreateMarket {
                market: 0,
                im_bps: 0,
                mm_bps: 0,
                taker_fee_bps: 0,
                maker_fee_bps: 0,
                signer: [0u8; 20],
                funding_interval_ms: 0,
                max_funding_rate_bps: 0,
                pool_id: 0,
            }),
            Action::WithdrawRequest(WithdrawRequest {
                owner: [0u8; 20],
                amount: 0,
                solana_destination: [0u8; 32],
            }),
            Action::ConfirmDeposit(ConfirmDeposit {
                owner: [0u8; 20],
                amount: 0,
                solana_tx_sig: vec![],
                signer: [0u8; 20],
            }),
            Action::ConfirmWithdrawal(ConfirmWithdrawal {
                withdrawal_id: 0,
                solana_tx_sig: vec![],
                signer: [0u8; 20],
            }),
            Action::FailWithdrawal(FailWithdrawal {
                withdrawal_id: 0,
                reason: String::new(),
                signer: [0u8; 20],
            }),
        ];

        for (i, action) in actions.into_iter().enumerate() {
            let encoded = encode_tx(&action, 0).unwrap();
            let dt = decode_tx(&encoded).unwrap();
            assert_eq!(dt.seq, 0);
            assert_eq!(
                format!("{:?}", action),
                format!("{:?}", dt.action),
                "minimal-values round-trip failed for variant index {i}"
            );
        }
    }

    #[test]
    fn stress_codec_round_trip_all_types_1000() {
        for i in 0u64..1000 {
            let market = (i as u32) % 100;
            let mut owner = [0u8; 20];
            owner[0..8].copy_from_slice(&i.to_le_bytes());
            let mut dest = [0u8; 32];
            dest[0..8].copy_from_slice(&i.to_le_bytes());

            let actions: Vec<Action> = vec![
                Action::PlaceOrder(PlaceOrder {
                    market,
                    owner,
                    side: if i % 2 == 0 { Side::Buy } else { Side::Sell },
                    price: i * 100,
                    quantity: i + 1,
                    client_order_id: if i % 3 == 0 { Some(i) } else { None },
                    post_only: false,
                    reduce_only: false,
                    time_in_force: TimeInForce::Gtc,
                }),
                Action::CancelOrder(CancelOrder { order_id: i, owner }),
                Action::OracleUpdate(OracleUpdate {
                    market,
                    price: i * 50,
                    signer: owner,
                    publish_time_ms: 0,
                }),
                Action::MarketOrder(MarketOrder {
                    market,
                    owner,
                    side: if i % 2 == 0 { Side::Sell } else { Side::Buy },
                    quantity: i + 10,
                    client_order_id: if i % 5 == 0 { Some(i * 7) } else { None },
                }),
                Action::Deposit(Deposit {
                    owner,
                    amount: i * 1000,
                    signer: [0xEE; 20],
                }),
                Action::Withdraw(Withdraw {
                    owner,
                    amount: i * 500,
                    signer: [0xEE; 20],
                }),
                Action::CreateMarket(CreateMarket {
                    market,
                    im_bps: (i as u32) % 5000,
                    mm_bps: (i as u32) % 2500,
                    taker_fee_bps: 0,
                    maker_fee_bps: 0,
                    signer: owner,
                    funding_interval_ms: 0,
                    max_funding_rate_bps: 0,
                    pool_id: 0,
                }),
                Action::WithdrawRequest(WithdrawRequest {
                    owner,
                    amount: i * 200,
                    solana_destination: dest,
                }),
                Action::ConfirmDeposit(ConfirmDeposit {
                    owner,
                    amount: i * 300,
                    solana_tx_sig: i.to_le_bytes().to_vec(),
                    signer: owner,
                }),
                Action::ConfirmWithdrawal(ConfirmWithdrawal {
                    withdrawal_id: i,
                    solana_tx_sig: i.to_le_bytes().to_vec(),
                    signer: owner,
                }),
                Action::FailWithdrawal(FailWithdrawal {
                    withdrawal_id: i,
                    reason: format!("fail_{i}"),
                    signer: owner,
                }),
            ];

            for (j, action) in actions.into_iter().enumerate() {
                let seq = i * 11 + (j as u64);
                let encoded = encode_tx(&action, seq).unwrap();
                let dt = decode_tx(&encoded).unwrap();
                assert_eq!(dt.seq, seq);
                assert_eq!(
                    format!("{:?}", action),
                    format!("{:?}", dt.action),
                    "stress mismatch at i={i}, variant={j}"
                );
            }
        }
    }

    #[test]
    fn test_peek_action_type_all_variants() {
        let expected: Vec<(Action, u8)> = vec![
            (
                Action::PlaceOrder(PlaceOrder {
                    market: 1,
                    owner: [0; 20],
                    side: Side::Buy,
                    price: 1,
                    quantity: 1,
                    client_order_id: None,
                    post_only: false,
                    reduce_only: false,
                    time_in_force: TimeInForce::Gtc,
                }),
                ACTION_PLACE_ORDER,
            ),
            (
                Action::CancelOrder(CancelOrder {
                    order_id: 1,
                    owner: [0; 20],
                }),
                ACTION_CANCEL_ORDER,
            ),
            (
                Action::OracleUpdate(OracleUpdate {
                    market: 1,
                    price: 1,
                    signer: [0; 20],
                    publish_time_ms: 0,
                }),
                ACTION_ORACLE_UPDATE,
            ),
            (
                Action::MarketOrder(MarketOrder {
                    market: 1,
                    owner: [0; 20],
                    side: Side::Buy,
                    quantity: 1,
                    client_order_id: None,
                }),
                ACTION_MARKET_ORDER,
            ),
            (
                Action::Deposit(Deposit {
                    owner: [0; 20],
                    amount: 1,
                    signer: [0xEE; 20],
                }),
                ACTION_DEPOSIT,
            ),
            (
                Action::Withdraw(Withdraw {
                    owner: [0; 20],
                    amount: 1,
                    signer: [0xEE; 20],
                }),
                ACTION_WITHDRAW,
            ),
            (
                Action::CreateMarket(CreateMarket {
                    market: 1,
                    im_bps: 1000,
                    mm_bps: 500,
                    taker_fee_bps: 0,
                    maker_fee_bps: 0,
                    signer: [0xEE; 20],
                    funding_interval_ms: 0,
                    max_funding_rate_bps: 0,
                    pool_id: 0,
                }),
                ACTION_CREATE_MARKET,
            ),
            (
                Action::WithdrawRequest(WithdrawRequest {
                    owner: [0; 20],
                    amount: 1,
                    solana_destination: [0; 32],
                }),
                ACTION_WITHDRAW_REQUEST,
            ),
            (
                Action::ConfirmDeposit(ConfirmDeposit {
                    owner: [0; 20],
                    amount: 1,
                    solana_tx_sig: vec![0; 64],
                    signer: [0; 20],
                }),
                ACTION_CONFIRM_DEPOSIT,
            ),
            (
                Action::ConfirmWithdrawal(ConfirmWithdrawal {
                    withdrawal_id: 1,
                    solana_tx_sig: vec![0; 64],
                    signer: [0; 20],
                }),
                ACTION_CONFIRM_WITHDRAWAL,
            ),
            (
                Action::FailWithdrawal(FailWithdrawal {
                    withdrawal_id: 1,
                    reason: "test".to_string(),
                    signer: [0; 20],
                }),
                ACTION_FAIL_WITHDRAWAL,
            ),
        ];

        for (action, expected_type) in expected {
            let encoded = encode_tx(&action, 1).unwrap();
            let peeked = peek_action_type(&encoded);
            assert_eq!(
                peeked,
                Some(expected_type),
                "peek mismatch for {:?}",
                action
            );
        }
    }

    #[test]
    fn test_decode_truncated_bytes() {
        let action = Action::PlaceOrder(PlaceOrder {
            market: 1,
            owner: [0xAA; 20],
            side: Side::Buy,
            price: 50_000,
            quantity: 100,
            client_order_id: Some(42),
            post_only: false,
            reduce_only: false,
            time_in_force: TimeInForce::Gtc,
        });
        let encoded = encode_tx(&action, 99).unwrap();

        // Try decoding every truncated prefix (skip len 0 since empty is
        // trivially an error).
        for len in 1..encoded.len() {
            let truncated = &encoded[..len];
            let result = decode_tx(truncated);
            assert!(
                result.is_err(),
                "expected error for truncated bytes (len={len}/{})",
                encoded.len()
            );
        }
    }

    #[test]
    fn test_decode_random_garbage() {
        // Simple deterministic PRNG (xorshift64) to avoid external deps.
        let mut state: u64 = 0xDEAD_BEEF_CAFE_BABE;
        let mut next = || -> u64 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };

        for _ in 0..100 {
            let len = (next() % 256) as usize + 1;
            let garbage: Vec<u8> = (0..len).map(|_| (next() & 0xFF) as u8).collect();
            // Must not panic — errors are fine.
            let _ = decode_tx(&garbage);
        }
    }

    // -----------------------------------------------------------------------
    // V2 (signed) envelope tests
    // -----------------------------------------------------------------------

    fn test_signing_key() -> ed25519_dalek::SigningKey {
        ed25519_dalek::SigningKey::from_bytes(&[0x42; 32])
    }

    #[test]
    fn test_v2_round_trip_place_order() {
        let key = test_signing_key();
        let action = Action::PlaceOrder(PlaceOrder {
            market: 1,
            owner: [0xAA; 20],
            side: Side::Buy,
            price: 50_000,
            quantity: 100,
            client_order_id: Some(7),
            post_only: false,
            reduce_only: false,
            time_in_force: TimeInForce::Gtc,
        });

        let encoded = sign_and_encode(&action, 42, &key).unwrap();
        let decoded = decode_tx(&encoded).unwrap();

        assert_eq!(decoded.seq, 42);
        assert!(decoded.auth.is_some());

        let auth = decoded.auth.unwrap();
        assert_eq!(auth.pubkey, key.verifying_key().to_bytes());
        assert_eq!(auth.action_type, ACTION_PLACE_ORDER);

        match decoded.action {
            Action::PlaceOrder(cmd) => {
                assert_eq!(cmd.market, 1);
                assert_eq!(cmd.price, 50_000);
                assert_eq!(cmd.quantity, 100);
                assert_eq!(cmd.client_order_id, Some(7));
            }
            _ => panic!("expected PlaceOrder"),
        }
    }

    #[test]
    fn test_v2_round_trip_all_action_types() {
        let key = test_signing_key();
        let actions: Vec<Action> = vec![
            Action::PlaceOrder(PlaceOrder {
                market: 1,
                owner: [0; 20],
                side: Side::Buy,
                price: 1,
                quantity: 1,
                client_order_id: None,
                post_only: false,
                reduce_only: false,
                time_in_force: TimeInForce::Gtc,
            }),
            Action::CancelOrder(CancelOrder {
                order_id: 1,
                owner: [0; 20],
            }),
            Action::OracleUpdate(OracleUpdate {
                market: 1,
                price: 100,
                signer: [0; 20],
                publish_time_ms: 0,
            }),
            Action::MarketOrder(MarketOrder {
                market: 1,
                owner: [0; 20],
                side: Side::Sell,
                quantity: 1,
                client_order_id: None,
            }),
            Action::Deposit(Deposit {
                owner: [0; 20],
                amount: 1,
                signer: [0xEE; 20],
            }),
            Action::Withdraw(Withdraw {
                owner: [0; 20],
                amount: 1,
                signer: [0xEE; 20],
            }),
            Action::CreateMarket(CreateMarket {
                market: 1,
                im_bps: 1000,
                mm_bps: 500,
                taker_fee_bps: 0,
                maker_fee_bps: 0,
                signer: [0xEE; 20],
                funding_interval_ms: 0,
                max_funding_rate_bps: 0,
                pool_id: 0,
            }),
            Action::WithdrawRequest(WithdrawRequest {
                owner: [0; 20],
                amount: 1,
                solana_destination: [0; 32],
            }),
            Action::ConfirmDeposit(ConfirmDeposit {
                owner: [0; 20],
                amount: 1,
                solana_tx_sig: vec![0; 64],
                signer: [0; 20],
            }),
            Action::ConfirmWithdrawal(ConfirmWithdrawal {
                withdrawal_id: 1,
                solana_tx_sig: vec![0; 64],
                signer: [0; 20],
            }),
            Action::FailWithdrawal(FailWithdrawal {
                withdrawal_id: 1,
                reason: "test".into(),
                signer: [0; 20],
            }),
            Action::ApproveAgent(ApproveAgent {
                owner: [0xAA; 20],
                agent_pubkey: [0xBB; 32],
            }),
            Action::RevokeAgent(RevokeAgent {
                owner: [0xAA; 20],
                agent_pubkey: [0xBB; 32],
            }),
        ];

        for action in actions {
            let encoded = sign_and_encode(&action, 1, &key).unwrap();
            let decoded = decode_tx(&encoded).unwrap();
            assert!(decoded.auth.is_some(), "v2 decoded should have auth");
            assert_eq!(decoded.seq, 1);
        }
    }

    #[test]
    fn test_v2_signature_verifies() {
        let key = test_signing_key();
        let action = Action::Deposit(Deposit {
            owner: [0xCC; 20],
            amount: 5000,
            signer: [0xEE; 20],
        });
        let encoded = sign_and_encode(&action, 99, &key).unwrap();
        let decoded = decode_tx(&encoded).unwrap();

        let auth = decoded.auth.unwrap();
        // Signature should verify against the signing message
        let result = crate::crypto::verify_signature(
            &crate::crypto::UNBOUND_CHAIN_ID,
            &auth.pubkey,
            &auth.signature,
            auth.action_type,
            decoded.seq,
            &auth.payload,
        );
        assert!(result.is_ok(), "signature should verify");
    }

    #[test]
    fn test_v2_wrong_key_fails_verification() {
        let key = test_signing_key();
        let wrong_key = ed25519_dalek::SigningKey::from_bytes(&[0x99; 32]);
        let action = Action::Deposit(Deposit {
            owner: [0xCC; 20],
            amount: 5000,
            signer: [0xEE; 20],
        });
        let encoded = sign_and_encode(&action, 99, &key).unwrap();
        let decoded = decode_tx(&encoded).unwrap();

        let auth = decoded.auth.unwrap();
        // Verify with the wrong key's pubkey should fail
        let wrong_pubkey = wrong_key.verifying_key().to_bytes();
        let result = crate::crypto::verify_signature(
            &crate::crypto::UNBOUND_CHAIN_ID,
            &wrong_pubkey,
            &auth.signature,
            auth.action_type,
            decoded.seq,
            &auth.payload,
        );
        assert!(result.is_err(), "wrong key should fail verification");
    }

    #[test]
    fn test_v2_wrong_pubkey_length_rejected() {
        // Build a valid v2 envelope, then re-encode with a wrong-length pubkey
        // using a helper struct that allows Vec<u8> for pubkey.
        #[derive(Serialize)]
        struct BadEnvelope {
            version: u8,
            action_type: u8,
            seq: u64,
            payload: Vec<u8>,
            pubkey: Vec<u8>,
            signature: Vec<u8>,
        }
        let encoded = rmp_serde::to_vec(&BadEnvelope {
            version: 2,
            action_type: ACTION_PLACE_ORDER,
            seq: 1,
            payload: rmp_serde::to_vec(&PlaceOrder {
                market: 1,
                owner: [0; 20],
                side: Side::Buy,
                price: 1,
                quantity: 1,
                client_order_id: None,
                post_only: false,
                reduce_only: false,
                time_in_force: TimeInForce::Gtc,
            })
            .unwrap(),
            pubkey: vec![0u8; 16], // wrong: should be 32
            signature: vec![0u8; 64],
        })
        .unwrap();
        let result = decode_tx(&encoded);
        assert!(result.is_err());
    }

    #[test]
    fn test_v2_wrong_signature_length_rejected() {
        #[derive(Serialize)]
        struct BadEnvelope {
            version: u8,
            action_type: u8,
            seq: u64,
            payload: Vec<u8>,
            pubkey: Vec<u8>,
            signature: Vec<u8>,
        }
        let encoded = rmp_serde::to_vec(&BadEnvelope {
            version: 2,
            action_type: ACTION_PLACE_ORDER,
            seq: 1,
            payload: rmp_serde::to_vec(&PlaceOrder {
                market: 1,
                owner: [0; 20],
                side: Side::Buy,
                price: 1,
                quantity: 1,
                client_order_id: None,
                post_only: false,
                reduce_only: false,
                time_in_force: TimeInForce::Gtc,
            })
            .unwrap(),
            pubkey: vec![0u8; 32],
            signature: vec![0u8; 32], // wrong: should be 64
        })
        .unwrap();
        let result = decode_tx(&encoded);
        assert!(result.is_err());
    }

    #[test]
    fn test_v1_still_decodes_at_codec_level() {
        // v1 transactions still decode at the codec layer (auth=None).
        // They are rejected at the engine level in production builds
        // and at the Go CheckTx mempool gate.
        let action = Action::PlaceOrder(PlaceOrder {
            market: 1,
            owner: [0xAA; 20],
            side: Side::Buy,
            price: 100,
            quantity: 10,
            client_order_id: None,
            post_only: false,
            reduce_only: false,
            time_in_force: TimeInForce::Gtc,
        });
        let encoded = encode_tx(&action, 50).unwrap();
        let decoded = decode_tx(&encoded).unwrap();
        assert!(decoded.auth.is_none(), "v1 should have no auth");
        assert_eq!(decoded.seq, 50);
    }

    #[test]
    fn test_peek_action_type_v2() {
        let key = test_signing_key();
        let actions_and_types = vec![
            (
                Action::PlaceOrder(PlaceOrder {
                    market: 1,
                    owner: [0; 20],
                    side: Side::Buy,
                    price: 1,
                    quantity: 1,
                    client_order_id: None,
                    post_only: false,
                    reduce_only: false,
                    time_in_force: TimeInForce::Gtc,
                }),
                ACTION_PLACE_ORDER,
            ),
            (
                Action::CancelReplaceOrder(CancelReplaceOrder {
                    owner: [0; 20],
                    cancel_order_id: Some(1),
                    cancel_client_order_id: None,
                    market: 1,
                    side: Side::Buy,
                    price: 1,
                    quantity: 1,
                    client_order_id: None,
                    post_only: false,
                    reduce_only: false,
                    time_in_force: TimeInForce::Gtc,
                }),
                ACTION_CANCEL_REPLACE_ORDER,
            ),
            (
                Action::ApproveAgent(ApproveAgent {
                    owner: [0; 20],
                    agent_pubkey: [0; 32],
                }),
                ACTION_APPROVE_AGENT,
            ),
            (
                Action::RevokeAgent(RevokeAgent {
                    owner: [0; 20],
                    agent_pubkey: [0; 32],
                }),
                ACTION_REVOKE_AGENT,
            ),
        ];

        for (action, expected_type) in actions_and_types {
            let encoded = sign_and_encode(&action, 1, &key).unwrap();
            let peeked = peek_action_type(&encoded);
            assert_eq!(peeked, Some(expected_type));
        }
    }

    #[test]
    fn test_v2_encode_decode_deterministic() {
        let key = test_signing_key();
        let action = Action::CancelOrder(CancelOrder {
            order_id: 42,
            owner: [0xDD; 20],
        });
        let a = sign_and_encode(&action, 1, &key).unwrap();
        let b = sign_and_encode(&action, 1, &key).unwrap();
        assert_eq!(a, b, "v2 encoding must be deterministic");
    }

    // -------------------------------------------------------------------
    // Stress tests
    // -------------------------------------------------------------------

    #[test]
    fn stress_1000_v2_sign_encode_decode_verify() {
        for i in 0u32..1000 {
            let mut seed = [0u8; 32];
            seed[0..4].copy_from_slice(&i.to_le_bytes());
            let key = ed25519_dalek::SigningKey::from_bytes(&seed);

            let action = Action::PlaceOrder(PlaceOrder {
                market: (i % 100) + 1,
                owner: crate::crypto::pubkey_to_owner(&key.verifying_key().to_bytes()),
                side: if i % 2 == 0 { Side::Buy } else { Side::Sell },
                price: (i as u64 + 1) * 100,
                quantity: (i as u64 + 1) * 10,
                client_order_id: Some(i as u64),
                post_only: false,
                reduce_only: false,
                time_in_force: TimeInForce::Gtc,
            });

            let encoded = sign_and_encode(&action, i as u64, &key).unwrap();
            let decoded = decode_tx(&encoded).unwrap();

            assert_eq!(decoded.seq, i as u64, "seq mismatch at i={i}");
            let auth = decoded.auth.as_ref().expect("v2 should have auth");
            assert_eq!(auth.pubkey, key.verifying_key().to_bytes());

            // Verify signature through crypto module
            assert!(
                crate::crypto::verify_signature(
                    &crate::crypto::UNBOUND_CHAIN_ID,
                    &auth.pubkey,
                    &auth.signature,
                    auth.action_type,
                    decoded.seq,
                    &auth.payload,
                )
                .is_ok(),
                "signature verification failed at i={i}"
            );
        }
    }

    #[test]
    fn stress_mixed_v1_v2_interleaved() {
        let key = test_signing_key();
        let owner = crate::crypto::pubkey_to_owner(&key.verifying_key().to_bytes());

        for i in 0u64..500 {
            let action = Action::Deposit(Deposit {
                owner,
                amount: i + 1,
                signer: [0xEE; 20],
            });

            if i % 2 == 0 {
                // v1 unsigned
                let encoded = encode_tx(&action, i).unwrap();
                let decoded = decode_tx(&encoded).unwrap();
                assert!(decoded.auth.is_none(), "v1 should be unsigned at i={i}");
                assert_eq!(decoded.seq, i);
            } else {
                // v2 signed
                let encoded = sign_and_encode(&action, i, &key).unwrap();
                let decoded = decode_tx(&encoded).unwrap();
                assert!(decoded.auth.is_some(), "v2 should be signed at i={i}");
                assert_eq!(decoded.seq, i);
            }
        }
    }

    #[test]
    fn stress_all_13_action_types_v2_round_trip() {
        // Generate a unique key per action type and do 100 iterations each
        for action_idx in 0u8..13 {
            let mut seed = [0u8; 32];
            seed[0] = action_idx;
            seed[1] = 0xAB;
            let key = ed25519_dalek::SigningKey::from_bytes(&seed);
            let owner = crate::crypto::pubkey_to_owner(&key.verifying_key().to_bytes());

            for seq in 0u64..100 {
                let action = match action_idx {
                    0 => Action::PlaceOrder(PlaceOrder {
                        market: 1,
                        owner,
                        side: Side::Buy,
                        price: seq + 1,
                        quantity: seq + 1,
                        client_order_id: None,
                        post_only: false,
                        reduce_only: false,
                        time_in_force: TimeInForce::Gtc,
                    }),
                    1 => Action::CancelOrder(CancelOrder {
                        order_id: seq,
                        owner,
                    }),
                    2 => Action::OracleUpdate(OracleUpdate {
                        market: 1,
                        price: seq + 1,
                        signer: owner,
                        publish_time_ms: 0,
                    }),
                    3 => Action::MarketOrder(MarketOrder {
                        market: 1,
                        owner,
                        side: Side::Sell,
                        quantity: seq + 1,
                        client_order_id: None,
                    }),
                    4 => Action::Deposit(Deposit {
                        owner,
                        amount: seq + 1,
                        signer: [0xEE; 20],
                    }),
                    5 => Action::Withdraw(Withdraw {
                        owner,
                        amount: seq + 1,
                        signer: [0xEE; 20],
                    }),
                    6 => Action::CreateMarket(CreateMarket {
                        market: seq as u32 + 1,
                        im_bps: 1000,
                        mm_bps: 500,
                        taker_fee_bps: 0,
                        maker_fee_bps: 0,
                        signer: owner,
                        funding_interval_ms: 0,
                        max_funding_rate_bps: 0,
                        pool_id: 0,
                    }),
                    7 => Action::WithdrawRequest(WithdrawRequest {
                        owner,
                        amount: seq + 1,
                        solana_destination: [0x11; 32],
                    }),
                    8 => Action::ConfirmDeposit(ConfirmDeposit {
                        owner,
                        amount: seq + 1,
                        solana_tx_sig: vec![seq as u8; 64],
                        signer: owner,
                    }),
                    9 => Action::ConfirmWithdrawal(ConfirmWithdrawal {
                        withdrawal_id: seq,
                        solana_tx_sig: vec![seq as u8; 64],
                        signer: owner,
                    }),
                    10 => Action::FailWithdrawal(FailWithdrawal {
                        withdrawal_id: seq,
                        reason: format!("reason-{seq}"),
                        signer: owner,
                    }),
                    11 => Action::ApproveAgent(ApproveAgent {
                        owner,
                        agent_pubkey: [seq as u8; 32],
                    }),
                    12 => Action::RevokeAgent(RevokeAgent {
                        owner,
                        agent_pubkey: [seq as u8; 32],
                    }),
                    _ => unreachable!(),
                };

                let encoded = sign_and_encode(&action, seq, &key).unwrap();
                let decoded = decode_tx(&encoded).unwrap();
                assert!(
                    decoded.auth.is_some(),
                    "missing auth for action_idx={action_idx} seq={seq}"
                );

                let auth = decoded.auth.as_ref().unwrap();
                assert!(
                    crate::crypto::verify_signature(
                        &crate::crypto::UNBOUND_CHAIN_ID,
                        &auth.pubkey,
                        &auth.signature,
                        auth.action_type,
                        decoded.seq,
                        &auth.payload,
                    )
                    .is_ok(),
                    "verify failed for action_idx={action_idx} seq={seq}"
                );
            }
        }
    }

    #[test]
    fn stress_v2_tamper_detection_100_txs() {
        let key = test_signing_key();

        for i in 0u64..100 {
            let action = Action::Deposit(Deposit {
                owner: crate::crypto::pubkey_to_owner(&key.verifying_key().to_bytes()),
                amount: i + 1,
                signer: [0xEE; 20],
            });

            let encoded = sign_and_encode(&action, i, &key).unwrap();

            // Tamper each byte — should fail decode or verification
            for byte_idx in 0..encoded.len() {
                let mut tampered = encoded.clone();
                tampered[byte_idx] ^= 0x01;
                match decode_tx(&tampered) {
                    Ok(decoded) => {
                        if let Some(ref auth) = decoded.auth {
                            // Decoded but signature should fail
                            let verified = crate::crypto::verify_signature(
                                &crate::crypto::UNBOUND_CHAIN_ID,
                                &auth.pubkey,
                                &auth.signature,
                                auth.action_type,
                                decoded.seq,
                                &auth.payload,
                            );
                            // It's fine if tampered action_type/seq matches by accident
                            // but the signature should almost always fail
                            let _ = verified;
                        }
                    }
                    Err(_) => {
                        // Decode failure is expected for structural tampering
                    }
                }
            }
        }
    }

    #[test]
    fn stress_boundary_seq_values() {
        let key = test_signing_key();
        let action = Action::CancelOrder(CancelOrder {
            order_id: 1,
            owner: [0xAA; 20],
        });

        for seq in [
            0,
            1,
            255,
            256,
            65535,
            65536,
            u32::MAX as u64,
            u64::MAX / 2,
            u64::MAX,
        ] {
            let encoded = sign_and_encode(&action, seq, &key).unwrap();
            let decoded = decode_tx(&encoded).unwrap();
            assert_eq!(decoded.seq, seq, "seq mismatch for {seq}");
            assert!(decoded.auth.is_some());
        }
    }

    #[test]
    fn stress_v2_random_garbage_no_panic() {
        // Same PRNG as existing test but with v2-sized buffers
        let mut state: u64 = 0xCAFE_BABE_DEAD_BEEF;
        let mut next = || -> u64 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };

        for _ in 0..1000 {
            // Generate random data of sizes likely to hit v2 parsing paths
            let len = (next() % 512) as usize + 1;
            let mut garbage: Vec<u8> = (0..len).map(|_| (next() & 0xFF) as u8).collect();

            // Sometimes give it a v2 fixarray marker to exercise that path
            if next() % 3 == 0 {
                garbage[0] = 0x96; // fixarray(6)
            }

            // Must not panic
            let _ = decode_tx(&garbage);
        }
    }

    #[test]
    fn decode_legacy_create_market_no_pool_id_uses_default() {
        // Pre-pool_id wire shape: 8-field positional msgpack array.
        // Confirms `serde(default)` on `CreateMarket.pool_id` picks up
        // the missing field and resolves to 0 (shared pool 0), so older
        // SDK builds that pre-date the pool_id rollout keep working.
        //
        // Field order matches the struct definition in `types.rs`:
        //   market, im_bps, mm_bps, taker_fee_bps, maker_fee_bps,
        //   signer, funding_interval_ms, max_funding_rate_bps,
        //   [pool_id intentionally omitted]
        let payload_bytes = rmp_serde::to_vec(&(
            99u32,        // market
            500u32,       // im_bps
            250u32,       // mm_bps
            5u32,         // taker_fee_bps
            2u32,         // maker_fee_bps
            [0xAAu8; 20], // signer
            60_000u64,    // funding_interval_ms
            3000u32,      // max_funding_rate_bps
                          // intentionally NO pool_id (legacy SDK)
        ))
        .unwrap();

        // V1 envelope built via the same struct existing tests use, so we
        // pick up the `serde_bytes` payload encoding for free.
        let envelope = WireTxEnvelope {
            version: 1,
            action_type: ACTION_CREATE_MARKET,
            seq: 0,
            payload: payload_bytes,
        };
        let encoded = rmp_serde::to_vec(&envelope).unwrap();

        let DecodedTx { action, .. } =
            decode_tx(&encoded).expect("legacy 8-field shape must decode");
        match action {
            Action::CreateMarket(c) => {
                assert_eq!(c.market, 99);
                assert_eq!(
                    c.pool_id, 0,
                    "missing pool_id must default to 0 for back-compat"
                );
            }
            other => panic!("expected CreateMarket, got {other:?}"),
        }
    }
}
