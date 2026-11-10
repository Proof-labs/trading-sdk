//! SDK submission policy for retired wire actions. Historical decoding stays available.
use crate::codec::ActionType;
use crate::types::{AdminAction, ApproveAdminAction, ProposeAdminAction};

/// Reject proposals and approvals for the retired trigger policy before encoding/signing.
/// Batch cannot contain this action in the wire's closed AdminBatchItem enum.
pub fn check_payload(action_type: u8, payload: &[u8]) -> Result<(), String> {
    let action = match action_type {
        t if t == ActionType::ProposeAdminAction as u8 => {
            rmp_serde::from_slice::<ProposeAdminAction>(payload)
                .map_err(|e| e.to_string())?
                .action
        }
        t if t == ActionType::ApproveAdminAction as u8 => {
            rmp_serde::from_slice::<ApproveAdminAction>(payload)
                .map_err(|e| e.to_string())?
                .action
        }
        _ => return Ok(()),
    };
    if matches!(action, AdminAction::SetTriggerMarketConfig(_)) {
        return Err(
            "SetTriggerMarketConfig is retired; new proposals and approvals are unsupported".into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn historical_vectors_decode_but_retired_policy_cannot_be_submitted() -> Result<(), String> {
        let vectors = include_str!("../../../conformance/codec.ndjson");
        let mut refused = 0;
        for line in vectors.lines().filter(|line| !line.is_empty()) {
            let value: serde_json::Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
            let tag = value["action_type"].as_u64().ok_or("missing action type")? as u8;
            let payload = hex::decode(
                value["expect"]["payload_hex"]
                    .as_str()
                    .ok_or("missing payload")?,
            )
            .map_err(|e| e.to_string())?;
            if value["case"] == "propose_admin_action/set_trigger_market_config" {
                let proposal: ProposeAdminAction =
                    rmp_serde::from_slice(&payload).map_err(|e| e.to_string())?;
                assert!(matches!(
                    proposal.action,
                    AdminAction::SetTriggerMarketConfig(_)
                ));
                assert!(check_payload(tag, &payload).is_err());
                refused += 1;
            } else {
                check_payload(tag, &payload)?;
            }
        }
        assert_eq!(refused, 1);
        Ok(())
    }
}
