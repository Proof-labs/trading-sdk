//! Pre-admission refusal classification for `POST /exchange`: which
//! `errorCode` names which refusal, and which delay a refusal carries.

use super::RetryAfter;
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
    /// The gateway could not encode the request for the chain.
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
#[serde(rename_all = "camelCase")]
struct RefusalRead {
    error_code: String,
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

/// Reads a body the gateway already stated is `status: refused` (api-gateway
/// 7.0.0, `src/types/exchange_response.rs`). `error` text is never read.
fn pre_admission_refusal(bytes: &[u8]) -> Option<PreAdmissionRefusal> {
    let read: RefusalRead = serde_json::from_slice(bytes).ok()?;
    match read.error_code.as_str() {
        "Unauthorized" => Some(PreAdmissionRefusal::Unauthorized),
        "RateLimited" => read
            .retry_after_ms
            .0
            .as_ref()
            .and_then(serde_json::Value::as_u64)
            .map(|_| PreAdmissionRefusal::RateLimited),
        // The mode must be one of the two strings: serde's enum decoder would
        // otherwise read {"paused": null} as Paused.
        "Maintenance" => read
            .mode
            .0
            .filter(serde_json::Value::is_string)
            .and_then(|mode| serde_json::from_value::<MaintenanceMode>(mode).ok())
            .map(PreAdmissionRefusal::Maintenance),
        "Overloaded" => Some(PreAdmissionRefusal::Overloaded),
        "Unavailable" => Some(PreAdmissionRefusal::VerifierUnavailable),
        "InvalidRequest" => Some(PreAdmissionRefusal::InvalidRequest),
        "EncodingError" => Some(PreAdmissionRefusal::InvalidEncoding),
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
    fn classify(bytes: &[u8]) -> Option<Self>;
}

impl RefusalEvidence for () {
    const ERROR_BODY: ErrorBody = ErrorBody::Refuse;
    fn classify(_: &[u8]) -> Option<Self> {
        Some(())
    }
}

impl RefusalEvidence for PreAdmissionRefusal {
    const ERROR_BODY: ErrorBody = ErrorBody::Classify;
    fn classify(bytes: &[u8]) -> Option<Self> {
        pre_admission_refusal(bytes)
    }
}
