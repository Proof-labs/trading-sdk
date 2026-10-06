//! Pre-admission refusal classification for `POST /exchange`: which exact
//! status and code pairs name a refusal, and which delay a refusal carries.

use super::RetryAfter;
use proof_wire::types::ExecError;
use serde::Deserialize;

/// A refusal of this one HTTP attempt, not proof about an earlier attempt of
/// these bytes. A journal may retire it only after independently establishing
/// that this was the sole attempt. Never infer non-inclusion from HTTP alone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreAdmissionRefusal {
    Unauthorized,
    RateLimited,
    Maintenance(MaintenanceMode),
    Overloaded,
    VerifierUnavailable,
    InvalidRequest,
    InvalidSignature,
    /// Bytes the engine cannot admit: undecodable, non-canonical or proposer-only.
    InvalidEncoding,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MaintenanceMode {
    Paused,
    CancelOnly,
}

// Preserve the distinction between an absent JSON delay and an invalid/null
// one. The latter must not authorize an immediate retry. Duplicate known keys
// fail serde's struct decoder rather than selecting the final occurrence.
#[derive(Default)]
struct OptionalJsonField(Option<serde_json::Value>);
impl<'de> Deserialize<'de> for OptionalJsonField {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        serde_json::Value::deserialize(deserializer).map(|value| Self(Some(value)))
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetryBody {
    #[serde(default)]
    retry_after_ms: OptionalJsonField,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RefusalRead {
    status: String,
    #[serde(rename = "error")]
    _error: String,
    #[serde(default)]
    error_code: OptionalJsonField,
    #[serde(default)]
    code: OptionalJsonField,
    #[serde(default)]
    mode: OptionalJsonField,
    #[serde(default)]
    retry_after_ms: OptionalJsonField,
}

pub(super) fn retry_after_body(bytes: &[u8]) -> Option<RetryAfter> {
    let read: RetryBody = match serde_json::from_slice(bytes) {
        Ok(read) => read,
        Err(_) => return Some(RetryAfter::Invalid),
    };
    read.retry_after_ms.0.map(|value| {
        value
            .as_u64()
            // Preserve the public enum while never shortening a millisecond
            // fallback; div_ceil avoids overflow even at u64::MAX.
            .map(|ms| RetryAfter::DelaySeconds(ms.div_ceil(1000)))
            .unwrap_or(RetryAfter::Invalid)
    })
}

fn pre_admission_refusal(status: u16, bytes: &[u8]) -> Option<PreAdmissionRefusal> {
    // Contract source: api-gateway 6.0.0, src/server.rs (authorization, rate
    // limit, maintenance), src/exchange.rs (parse and verifier admission),
    // src/types/exchange_response.rs. `error` text is never read.
    // Unknown fields (including txHash/height/log/events, even null) or
    // unknown bodies cannot be promoted to pre-broadcast proof.
    let read: RefusalRead = serde_json::from_slice(bytes).ok()?;
    if read.status != "error" {
        return None;
    }
    if let Some(code) = &read.code.0 {
        // The engine's own code for a tx the gateway refused before broadcast.
        let plain =
            read.error_code.0.is_none() && read.mode.0.is_none() && read.retry_after_ms.0.is_none();
        if status != 200 || !plain {
            return None;
        }
        let code = code.as_u64()?;
        return if code == u64::from(ExecError::InvalidSignature.code()) {
            Some(PreAdmissionRefusal::InvalidSignature)
        } else if code == u64::from(ExecError::DecodeError(String::new()).code()) {
            Some(PreAdmissionRefusal::InvalidEncoding)
        } else {
            None
        };
    }
    let error_code = read.error_code.0.as_ref()?.as_str()?;
    if status == 503 && error_code == "Maintenance" {
        if read.retry_after_ms.0.is_some() {
            return None;
        }
        // The mode must be one of the two strings. An unknown one, or a
        // container that happens to name one, is not a refusal this SDK acts
        // on: serde's enum decoder would otherwise read {"paused": null} as
        // Paused.
        return read
            .mode
            .0
            .as_ref()
            .filter(|mode| mode.is_string())
            .and_then(|mode| serde_json::from_value::<MaintenanceMode>(mode.clone()).ok())
            .map(PreAdmissionRefusal::Maintenance);
    }
    if read.mode.0.is_some() {
        return None;
    }
    if status == 429 && error_code == "RateLimited" {
        return read
            .retry_after_ms
            .0
            .as_ref()
            .and_then(serde_json::Value::as_u64)
            .map(|_| PreAdmissionRefusal::RateLimited);
    }
    if read.retry_after_ms.0.is_some() {
        return None;
    }
    match (status, error_code) {
        (401, "Unauthorized") => Some(PreAdmissionRefusal::Unauthorized),
        (503, "Overloaded") => Some(PreAdmissionRefusal::Overloaded),
        (503, "Unavailable") => Some(PreAdmissionRefusal::VerifierUnavailable),
        (200, "InvalidRequest") => Some(PreAdmissionRefusal::InvalidRequest),
        (200, "EncodingError") => Some(PreAdmissionRefusal::InvalidEncoding),
        _ => None,
    }
}

/// What a hashless `"error"` response records as its pre-admission refusal.
/// `None` leaves the submission unresolved.
/// What a non-2xx response's body is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ErrorBody {
    /// The status alone ends the request; the body is never read.
    Refuse,
    /// The body is read and classified, and an absent `Retry-After` header
    /// falls back to its JSON `retryAfterMs` field.
    Classify,
}

pub(super) trait RefusalEvidence: Sized {
    const ERROR_BODY: ErrorBody;
    fn classify(status: u16, bytes: &[u8]) -> Option<Self>;
}

impl RefusalEvidence for () {
    const ERROR_BODY: ErrorBody = ErrorBody::Refuse;
    fn classify(_: u16, _: &[u8]) -> Option<Self> {
        Some(())
    }
}

impl RefusalEvidence for PreAdmissionRefusal {
    const ERROR_BODY: ErrorBody = ErrorBody::Classify;
    fn classify(status: u16, bytes: &[u8]) -> Option<Self> {
        pre_admission_refusal(status, bytes)
    }
}
