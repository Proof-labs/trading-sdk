use crate::types::{Action, CancelOrder, ExecError, MarketOrder, OracleUpdate, PlaceOrder};
use serde::{Deserialize, Serialize};

const CURRENT_VERSION: u8 = 1;

pub const ACTION_PLACE_ORDER: u8 = 0x01;
pub const ACTION_CANCEL_ORDER: u8 = 0x02;
pub const ACTION_ORACLE_UPDATE: u8 = 0x03;
pub const ACTION_MARKET_ORDER: u8 = 0x04;

/// Wire envelope: [version, action_type, seq, payload_bytes]
/// Encoded as a positional MessagePack array for deterministic serialization.
#[derive(Serialize, Deserialize)]
struct WireTxEnvelope {
    version: u8,
    action_type: u8,
    seq: u64,
    payload: Vec<u8>,
}

/// Decode raw tx bytes into an Action and its sequence number.
pub fn decode_tx(bytes: &[u8]) -> Result<(Action, u64), ExecError> {
    let envelope: WireTxEnvelope =
        rmp_serde::from_slice(bytes).map_err(|e| ExecError::DecodeError(e.to_string()))?;

    if envelope.version != CURRENT_VERSION {
        return Err(ExecError::DecodeError(format!(
            "unsupported version: {}",
            envelope.version
        )));
    }

    let action = match envelope.action_type {
        ACTION_PLACE_ORDER => {
            let cmd: PlaceOrder = rmp_serde::from_slice(&envelope.payload)
                .map_err(|e| ExecError::DecodeError(e.to_string()))?;
            Action::PlaceOrder(cmd)
        }
        ACTION_CANCEL_ORDER => {
            let cmd: CancelOrder = rmp_serde::from_slice(&envelope.payload)
                .map_err(|e| ExecError::DecodeError(e.to_string()))?;
            Action::CancelOrder(cmd)
        }
        ACTION_ORACLE_UPDATE => {
            let cmd: OracleUpdate = rmp_serde::from_slice(&envelope.payload)
                .map_err(|e| ExecError::DecodeError(e.to_string()))?;
            Action::OracleUpdate(cmd)
        }
        ACTION_MARKET_ORDER => {
            let cmd: MarketOrder = rmp_serde::from_slice(&envelope.payload)
                .map_err(|e| ExecError::DecodeError(e.to_string()))?;
            Action::MarketOrder(cmd)
        }
        other => {
            return Err(ExecError::DecodeError(format!(
                "unknown action_type: {other:#x}"
            )));
        }
    };

    Ok((action, envelope.seq))
}

/// Encode an Action with a sequence number into wire bytes.
pub fn encode_tx(action: &Action, seq: u64) -> Result<Vec<u8>, ExecError> {
    let (action_type, payload) = match action {
        Action::PlaceOrder(cmd) => (
            ACTION_PLACE_ORDER,
            rmp_serde::to_vec(cmd).map_err(|e| ExecError::InternalError(e.to_string()))?,
        ),
        Action::CancelOrder(cmd) => (
            ACTION_CANCEL_ORDER,
            rmp_serde::to_vec(cmd).map_err(|e| ExecError::InternalError(e.to_string()))?,
        ),
        Action::OracleUpdate(cmd) => (
            ACTION_ORACLE_UPDATE,
            rmp_serde::to_vec(cmd).map_err(|e| ExecError::InternalError(e.to_string()))?,
        ),
        Action::MarketOrder(cmd) => (
            ACTION_MARKET_ORDER,
            rmp_serde::to_vec(cmd).map_err(|e| ExecError::InternalError(e.to_string()))?,
        ),
    };

    let envelope = WireTxEnvelope {
        version: CURRENT_VERSION,
        action_type,
        seq,
        payload,
    };

    rmp_serde::to_vec(&envelope).map_err(|e| ExecError::InternalError(e.to_string()))
}

/// Extract the action_type byte from a wire tx without full decoding.
/// Used by Go-side PrepareProposal for cheap classification.
pub fn peek_action_type(bytes: &[u8]) -> Option<u8> {
    let envelope: WireTxEnvelope = rmp_serde::from_slice(bytes).ok()?;
    Some(envelope.action_type)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::types::Side;

    #[test]
    fn test_round_trip_place_order() {
        let action = Action::PlaceOrder(PlaceOrder {
            market: 1,
            owner: [0xAA; 20],
            side: Side::Buy,
            price: 10000,
            quantity: 50,
            client_order_id: Some(42),
        });

        let encoded = encode_tx(&action, 100).unwrap();
        let (decoded, seq) = decode_tx(&encoded).unwrap();

        assert_eq!(seq, 100);
        match decoded {
            Action::PlaceOrder(cmd) => {
                assert_eq!(cmd.market, 1);
                assert_eq!(cmd.price, 10000);
                assert_eq!(cmd.quantity, 50);
                assert_eq!(cmd.side, Side::Buy);
                assert_eq!(cmd.owner, [0xAA; 20]);
                assert_eq!(cmd.client_order_id, Some(42));
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
        let (decoded, seq) = decode_tx(&encoded).unwrap();

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
    fn test_golden_vector_determinism() {
        let action = Action::PlaceOrder(PlaceOrder {
            market: 1,
            owner: [0x01; 20],
            side: Side::Buy,
            price: 100,
            quantity: 10,
            client_order_id: None,
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
        });
        let oracle_bytes = encode_tx(&oracle, 3).unwrap();
        println!("GOLDEN_ORACLE={}", hex::encode(&oracle_bytes));

        let (d, s) = decode_tx(&place_bytes).unwrap();
        assert_eq!(s, 1);
        assert!(matches!(d, Action::PlaceOrder(_)));

        let (d, s) = decode_tx(&cancel_bytes).unwrap();
        assert_eq!(s, 2);
        assert!(matches!(d, Action::CancelOrder(_)));

        let (d, s) = decode_tx(&oracle_bytes).unwrap();
        assert_eq!(s, 3);
        assert!(matches!(d, Action::OracleUpdate(_)));
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
}
