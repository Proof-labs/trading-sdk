//! Typed decoding of the gateway's existing nine-slot consensus read.

use super::{ErrorKind, GatewayError, Operation};
use serde::Deserialize;
use std::{fmt, io::Cursor};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadState {
    Legacy,
    Unavailable,
    Committed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OraclePermission {
    Satisfied,
    Unavailable,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerdictStatus {
    Fresh,
    Stale,
    Unpriceable,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerdictReason {
    InvalidPolicy,
    UpdateLimitExceeded,
    ClockRegression,
    ManualHalt,
    SessionUnknown,
    SessionClosed,
    BadQuality,
    Disagreement,
    AnchorUnavailable,
    MovementBound,
    MissingSource,
    ExpiredSource,
    OutsideSession,
    PairTimeMismatch,
    RecoveryPending,
    Fresh,
}

// Serde's derived enum decoder also accepts numeric ordinals and maps. Those
// are not this public read contract: the TS decoder and OpenAPI require STR.
macro_rules! string_enum {
    ($name:ident { $($variant:ident),+ $(,)? }) => {
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                struct StringOnly;
                impl serde::de::Visitor<'_> for StringOnly {
                    type Value = $name;
                    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                        f.write_str("a canonical oracle enum string")
                    }
                    fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
                        match value {
                            $(stringify!($variant) => Ok($name::$variant),)+
                            _ => Err(E::custom("unknown oracle enum string")),
                        }
                    }
                }
                d.deserialize_str(StringOnly)
            }
        }
    };
}
string_enum!(ReadState {
    Legacy,
    Unavailable,
    Committed
});
string_enum!(OraclePermission {
    Satisfied,
    Unavailable
});
string_enum!(VerdictStatus {
    Fresh,
    Stale,
    Unpriceable
});
string_enum!(VerdictReason {
    InvalidPolicy,
    UpdateLimitExceeded,
    ClockRegression,
    ManualHalt,
    SessionUnknown,
    SessionClosed,
    BadQuality,
    Disagreement,
    AnchorUnavailable,
    MovementBound,
    MissingSource,
    ExpiredSource,
    OutsideSession,
    PairTimeMismatch,
    RecoveryPending,
    Fresh,
});

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PolicySource {
    pub id: u32,
    pub authority: [u8; 32],
    pub basis: [u8; 32],
    pub scale: u8,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PolicyEpoch {
    pub version: u64,
    pub policy_hash: [u8; 32],
    pub calendar_hash: [u8; 32],
    pub calendar_provenance: [u8; 32],
    pub calendar_start: u64,
    pub calendar_end: u64,
    pub valid_until: u64,
    pub sources: [PolicySource; 2],
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingPolicy {
    pub effective_height: u64,
    pub policy: PolicyEpoch,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CertifiedPrice {
    pub price: u64,
    pub provider_time: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommittedVerdict {
    pub height: u64,
    pub block_time: u64,
    pub status: VerdictStatus,
    pub reason: VerdictReason,
    pub certified: Option<CertifiedPrice>,
    pub eligible_since: Option<u64>,
}
/// One oracle dependency, never portfolio-wide trading/withdrawal authorization.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OraclePermissions {
    pub market: u32,
    pub finalized_height: u64,
    pub activation_height: Option<u64>,
    pub oracle_active: bool,
    pub state: ReadState,
    pub oracle_permission: Option<OraclePermission>,
    pub policy: Option<PolicyEpoch>,
    pub pending: Option<PendingPolicy>,
    pub verdict: Option<CommittedVerdict>,
}

// Tuple DTOs intentionally reject maps, wrong lengths and lossy JSON integers.
type SourceWire = (u32, [u8; 32], [u8; 32], u8);
type PolicyWire = (
    u64,
    [u8; 32],
    [u8; 32],
    [u8; 32],
    u64,
    u64,
    u64,
    [SourceWire; 2],
);
type VerdictWire = (
    u64,
    u64,
    VerdictStatus,
    VerdictReason,
    Option<(u64, u64)>,
    Option<u64>,
);
type PermissionWire = (
    u32,
    u64,
    Option<u64>,
    bool,
    ReadState,
    Option<OraclePermission>,
    Option<PolicyWire>,
    Option<(u64, PolicyWire)>,
    Option<VerdictWire>,
);

fn invalid() -> GatewayError {
    GatewayError::new(Operation::OraclePermissions, ErrorKind::InvalidResponse)
}

fn policy(w: PolicyWire) -> Result<PolicyEpoch, GatewayError> {
    let sources = w.7.map(|s| PolicySource {
        id: s.0,
        authority: s.1,
        basis: s.2,
        scale: s.3,
    });
    if w.0 == 0
        || w.4 >= w.5
        || w.6 <= w.4
        || sources[0].id == sources[1].id
        || sources[0].authority == sources[1].authority
        || sources.iter().any(|s| s.scale != 6)
    {
        return Err(invalid());
    }
    Ok(PolicyEpoch {
        version: w.0,
        policy_hash: w.1,
        calendar_hash: w.2,
        calendar_provenance: w.3,
        calendar_start: w.4,
        calendar_end: w.5,
        valid_until: w.6,
        sources,
    })
}
fn verdict(w: VerdictWire) -> Result<CommittedVerdict, GatewayError> {
    let fresh = w.2 == VerdictStatus::Fresh;
    if fresh != (w.3 == VerdictReason::Fresh)
        || fresh != w.4.is_some()
        || fresh != w.5.is_some()
        || w.4.is_some_and(|c| c.0 == 0 || c.1 > w.1)
        || w.5.is_some_and(|t| t > w.1)
    {
        return Err(invalid());
    }
    Ok(CommittedVerdict {
        height: w.0,
        block_time: w.1,
        status: w.2,
        reason: w.3,
        certified: w.4.map(|c| CertifiedPrice {
            price: c.0,
            provider_time: c.1,
        }),
        eligible_since: w.5,
    })
}

pub(super) fn decode(
    bytes: &[u8],
    expected_market: u32,
) -> Result<OraclePermissions, GatewayError> {
    let mut decoder = rmp_serde::Deserializer::new(Cursor::new(bytes));
    let w = PermissionWire::deserialize(&mut decoder).map_err(|_| invalid())?;
    if decoder.get_ref().position() != bytes.len() as u64 || w.0 == 0 || w.0 != expected_market {
        return Err(invalid());
    }
    let value = OraclePermissions {
        market: w.0,
        finalized_height: w.1,
        activation_height: w.2,
        oracle_active: w.3,
        state: w.4,
        oracle_permission: w.5,
        policy: w.6.map(policy).transpose()?,
        pending: w
            .7
            .map(|p| {
                Ok(PendingPolicy {
                    effective_height: p.0,
                    policy: policy(p.1)?,
                })
            })
            .transpose()?,
        verdict: w.8.map(verdict).transpose()?,
    };
    if value.oracle_active
        != value
            .activation_height
            .is_some_and(|h| value.finalized_height >= h)
    {
        return Err(invalid());
    }
    match value.state {
        ReadState::Legacy => {
            if value.oracle_active
                || value.oracle_permission.is_some()
                || value.policy.is_some()
                || value.pending.is_some()
                || value.verdict.is_some()
            {
                return Err(invalid());
            }
        }
        ReadState::Unavailable => {
            if !value.oracle_active
                || value.policy.is_some()
                || value.verdict.is_some()
                || value.oracle_permission != Some(OraclePermission::Unavailable)
            {
                return Err(invalid());
            }
        }
        ReadState::Committed => {
            let v = value.verdict.as_ref().ok_or_else(invalid)?;
            if !value.oracle_active
                || value.policy.is_none()
                || value.oracle_permission.is_none()
                || v.height != value.finalized_height
                || (value.oracle_permission == Some(OraclePermission::Satisfied))
                    != (v.status == VerdictStatus::Fresh)
            {
                return Err(invalid());
            }
        }
    }
    if value.pending.as_ref().is_some_and(|p| {
        p.effective_height <= value.finalized_height
            || value
                .policy
                .as_ref()
                .is_some_and(|old| p.policy.version <= old.version)
    }) {
        return Err(invalid());
    }
    Ok(value)
}
