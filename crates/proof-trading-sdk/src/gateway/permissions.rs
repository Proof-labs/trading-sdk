//! Typed decoding of the gateway's seven-slot consensus read.
//!
//! The committed verdict is the fourteen-field primary-with-fallback record
//! (exchange#831), faults in [`ORACLE_FAULT_BITS`] order.

use super::{ErrorKind, GatewayError, Operation};
use serde::Deserialize;
use std::{fmt, io::Cursor};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadState {
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
    /// No longer produced under the primary-with-fallback policy
    /// (exchange#831); kept for encoding stability and older nodes.
    Disagreement,
    MovementBound,
    MissingSource,
    ExpiredSource,
    OutsideSession,
    /// No longer produced under the primary-with-fallback policy
    /// (exchange#831); kept for encoding stability and older nodes.
    PairTimeMismatch,
    RecoveryPending,
    Fresh,
    ReferenceUnavailable,
}

/// Fault bits of the committed verdict in exchange `ReasonFlags::FAULTS`
/// order: bit `i` is `ORACLE_FAULT_BITS[i]`.
/// `Disagreement` (bit 7) and `PairTimeMismatch` (bit 13) are no longer
/// produced but keep their positions.
pub const ORACLE_FAULT_BITS: [VerdictReason; 15] = [
    VerdictReason::InvalidPolicy,
    VerdictReason::UpdateLimitExceeded,
    VerdictReason::ClockRegression,
    VerdictReason::ManualHalt,
    VerdictReason::SessionUnknown,
    VerdictReason::SessionClosed,
    VerdictReason::BadQuality,
    VerdictReason::Disagreement,
    VerdictReason::ReferenceUnavailable,
    VerdictReason::MovementBound,
    VerdictReason::MissingSource,
    VerdictReason::ExpiredSource,
    VerdictReason::OutsideSession,
    VerdictReason::PairTimeMismatch,
    VerdictReason::RecoveryPending,
];

/// The policy slot that priced: slot 0 is the primary, slot 1 the fallback.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SelectedSource {
    Primary,
    Fallback,
}

/// Source-selection diagnostics of a verdict. Monitoring signals,
/// not faults: none of them withholds a certificate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerdictDiagnostic {
    /// The fallback was selected.
    OnFallback,
    /// The primary deviated from a time-aligned usable fallback by more than
    /// the policy's divergence bound and was refused.
    PrimaryRefusedDivergence,
    /// Both slots were usable but too far apart in time to compare.
    DivergenceUnchecked,
    /// The fallback slot was not usable.
    FallbackUnusable,
}

/// Diagnostic bits in exchange `DiagnosticFlags::ALL` order.
pub const ORACLE_DIAGNOSTIC_BITS: [VerdictDiagnostic; 4] = [
    VerdictDiagnostic::OnFallback,
    VerdictDiagnostic::PrimaryRefusedDivergence,
    VerdictDiagnostic::DivergenceUnchecked,
    VerdictDiagnostic::FallbackUnusable,
];

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
    MovementBound,
    MissingSource,
    ExpiredSource,
    OutsideSession,
    PairTimeMismatch,
    RecoveryPending,
    Fresh,
    ReferenceUnavailable,
});
string_enum!(SelectedSource { Primary, Fallback });

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
pub struct AnchorCoverageInfo {
    pub price: Option<u64>,
    pub covered_ms: u64,
    pub required_ms: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommittedVerdict {
    pub height: u64,
    pub block_time: u64,
    pub status: VerdictStatus,
    pub reason: VerdictReason,
    pub certified: Option<CertifiedPrice>,
    pub eligible_since: Option<u64>,
    pub faults: u32,
    pub valid_sources: u8,
    pub current_times: [Option<u64>; 2],
    pub evidence: [Option<[u8; 32]>; 2],
    pub last_good: Option<CertifiedPrice>,
    pub anchor: AnchorCoverageInfo,
    /// The usable slot chosen by priority, present even when a later fault
    /// withholds the certificate.
    pub selected: Option<SelectedSource>,
    /// Raw diagnostic bitset over [`ORACLE_DIAGNOSTIC_BITS`].
    pub diagnostics: u8,
}

impl CommittedVerdict {
    /// `faults` named in bit order.
    pub fn fault_reasons(&self) -> Vec<VerdictReason> {
        ORACLE_FAULT_BITS
            .iter()
            .enumerate()
            .filter(|(bit, _)| self.faults & (1_u32 << bit) != 0)
            .map(|(_, reason)| *reason)
            .collect()
    }

    /// `diagnostics` named in bit order.
    pub fn diagnostic_flags(&self) -> Vec<VerdictDiagnostic> {
        let bits = self.diagnostics;
        ORACLE_DIAGNOSTIC_BITS
            .iter()
            .enumerate()
            .filter(|(bit, _)| bits & (1_u8 << bit) != 0)
            .map(|(_, flag)| *flag)
            .collect()
    }
}
/// One oracle dependency, never portfolio-wide trading/withdrawal authorization.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OraclePermissions {
    pub market: u32,
    pub finalized_height: u64,
    pub state: ReadState,
    pub oracle_permission: OraclePermission,
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
type CertifiedWire = Option<(u64, u64)>;
type VerdictTuple = (
    u64,
    u64,
    VerdictStatus,
    VerdictReason,
    CertifiedWire,
    Option<u64>,
    u32,
    u8,
    [Option<u64>; 2],
    [Option<[u8; 32]>; 2],
    CertifiedWire,
    (Option<u64>, u64, u64),
    Option<SelectedSource>,
    u8,
);

/// The verdict's fourteen slots by name; decodes only from the tuple.
#[derive(Deserialize)]
#[serde(from = "VerdictTuple")]
struct VerdictWire {
    height: u64,
    block_time: u64,
    status: VerdictStatus,
    reason: VerdictReason,
    certified: CertifiedWire,
    eligible_since: Option<u64>,
    faults: u32,
    valid_sources: u8,
    current_times: [Option<u64>; 2],
    evidence: [Option<[u8; 32]>; 2],
    last_good: CertifiedWire,
    anchor: (Option<u64>, u64, u64),
    selected: Option<SelectedSource>,
    diagnostics: u8,
}

impl From<VerdictTuple> for VerdictWire {
    fn from(t: VerdictTuple) -> Self {
        Self {
            height: t.0,
            block_time: t.1,
            status: t.2,
            reason: t.3,
            certified: t.4,
            eligible_since: t.5,
            faults: t.6,
            valid_sources: t.7,
            current_times: t.8,
            evidence: t.9,
            last_good: t.10,
            anchor: t.11,
            selected: t.12,
            diagnostics: t.13,
        }
    }
}
type PermissionWire = (
    u32,
    u64,
    ReadState,
    OraclePermission,
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
    let certified = w.certified.map(|c| CertifiedPrice {
        price: c.0,
        provider_time: c.1,
    });
    let last_good = w.last_good.map(|c| CertifiedPrice {
        price: c.0,
        provider_time: c.1,
    });
    let fresh = w.status == VerdictStatus::Fresh;
    if fresh != (w.reason == VerdictReason::Fresh)
        || fresh != certified.is_some()
        || fresh != w.eligible_since.is_some()
        || certified
            .as_ref()
            .is_some_and(|c| c.price == 0 || c.provider_time > w.block_time)
        || w.eligible_since.is_some_and(|t| t > w.block_time)
        || last_good
            .as_ref()
            .is_some_and(|c| c.price == 0 || c.provider_time > w.block_time)
    {
        return Err(invalid());
    }
    let value = CommittedVerdict {
        height: w.height,
        block_time: w.block_time,
        status: w.status,
        reason: w.reason,
        certified,
        eligible_since: w.eligible_since,
        faults: w.faults,
        valid_sources: w.valid_sources,
        current_times: w.current_times,
        evidence: w.evidence,
        last_good,
        anchor: AnchorCoverageInfo {
            price: w.anchor.0,
            covered_ms: w.anchor.1,
            required_ms: w.anchor.2,
        },
        selected: w.selected,
        diagnostics: w.diagnostics,
    };
    if !primary_fallback_consistent(&value) {
        return Err(invalid());
    }
    Ok(value)
}

/// Invariants of exchange#831's source selection as exposed by the read:
/// the fault word is exactly the named faults (and names the primary
/// reason), the usable-slot mask agrees with the selected slot, and each
/// diagnostic implies the slot state that raises it.
fn primary_fallback_consistent(v: &CommittedVerdict) -> bool {
    let fresh = v.status == VerdictStatus::Fresh;
    let valid = v.valid_sources;
    let flags = v.diagnostic_flags();
    let has = |flag| flags.contains(&flag);
    v.faults >> ORACLE_FAULT_BITS.len() == 0
        && fresh == (v.faults == 0)
        && (fresh || v.fault_reasons().contains(&v.reason))
        && v.diagnostics >> ORACLE_DIAGNOSTIC_BITS.len() == 0
        && valid <= 0b11
        && (!fresh || v.selected.is_some())
        && (v.selected == Some(SelectedSource::Primary)) == (valid & 0b01 != 0)
        && (v.selected == Some(SelectedSource::Fallback)) == (valid == 0b10)
        && has(VerdictDiagnostic::OnFallback) == (v.selected == Some(SelectedSource::Fallback))
        && (!has(VerdictDiagnostic::PrimaryRefusedDivergence)
            || v.selected == Some(SelectedSource::Fallback))
        && (!has(VerdictDiagnostic::DivergenceUnchecked) || valid == 0b11)
        && (!has(VerdictDiagnostic::FallbackUnusable) || valid & 0b10 == 0)
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
        state: w.2,
        oracle_permission: w.3,
        policy: w.4.map(policy).transpose()?,
        pending: w
            .5
            .map(|p| {
                Ok(PendingPolicy {
                    effective_height: p.0,
                    policy: policy(p.1)?,
                })
            })
            .transpose()?,
        verdict: w.6.map(verdict).transpose()?,
    };
    match value.state {
        ReadState::Unavailable => {
            if value.policy.is_some()
                || value.verdict.is_some()
                || value.oracle_permission != OraclePermission::Unavailable
            {
                return Err(invalid());
            }
        }
        ReadState::Committed => {
            let v = value.verdict.as_ref().ok_or_else(invalid)?;
            if value.policy.is_none()
                || v.height != value.finalized_height
                || (value.oracle_permission == OraclePermission::Satisfied)
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

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::arithmetic_side_effects
)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// exchange-core `OraclePermissionsInfo` (rmp_serde) at the `exchange`
    /// commit on each row.
    const COMMITTED: &str =
        include_str!("../../../../conformance/oracle-permissions-committed.ndjson");
    const UNAVAILABLE: &str =
        include_str!("../../../../conformance/oracle-permissions-unavailable.hex");

    fn cases() -> Vec<Value> {
        COMMITTED
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    fn case(name: &str) -> Value {
        cases()
            .into_iter()
            .find(|c| c["case"] == name)
            .unwrap_or_else(|| panic!("missing case {name}"))
    }
    fn bytes(case: &Value) -> Vec<u8> {
        hex::decode(case["hex"].as_str().unwrap()).unwrap()
    }
    fn reason(name: &str) -> VerdictReason {
        rmp_serde::from_slice(&rmp_serde::to_vec(name).unwrap()).unwrap()
    }
    fn diagnostic(name: &str) -> VerdictDiagnostic {
        *ORACLE_DIAGNOSTIC_BITS
            .iter()
            .find(|d| format!("{d:?}") == name)
            .unwrap()
    }
    /// Re-encode `case` with its verdict edited as a generic value tree.
    fn edited(case: &Value, edit: impl FnOnce(&mut Vec<rmpv::Value>)) -> Vec<u8> {
        let mut root = rmpv::decode::read_value(&mut bytes(case).as_slice()).unwrap();
        let rmpv::Value::Array(fields) = &mut root else {
            panic!("response is an array")
        };
        let rmpv::Value::Array(verdict) = &mut fields[6] else {
            panic!("committed verdict is an array")
        };
        edit(verdict);
        let mut out = Vec::new();
        rmpv::encode::write_value(&mut out, &root).expect("value encodes");
        out
    }

    #[test]
    fn exchange_encoded_committed_reads_decode_exactly() {
        for c in cases() {
            let name = c["case"].as_str().unwrap();
            let e = &c["expect"];
            let read = decode(&bytes(&c), 1).unwrap_or_else(|_| panic!("{name}"));
            assert_eq!(read.state, ReadState::Committed, "{name}");
            let v = read.verdict.unwrap();
            assert_eq!(v.height, e["height"].as_u64().unwrap(), "{name}");
            assert_eq!(format!("{:?}", v.status), e["status"], "{name}");
            assert_eq!(v.reason, reason(e["reason"].as_str().unwrap()), "{name}");
            assert_eq!(
                v.certified.as_ref().map(|c| c.price),
                e["certified_price"].as_u64(),
                "{name}"
            );
            assert_eq!(u64::from(v.faults), e["faults"].as_u64().unwrap(), "{name}");
            let faults: Vec<_> = e["fault_reasons"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| reason(r.as_str().unwrap()))
                .collect();
            assert_eq!(v.fault_reasons(), faults, "{name}");
            assert_eq!(
                u64::from(v.valid_sources),
                e["valid_sources"].as_u64().unwrap(),
                "{name}"
            );
            assert_eq!(
                v.selected.map(|s| format!("{s:?}")),
                e["selected"].as_str().map(str::to_owned),
                "{name}"
            );
            assert_eq!(
                Some(u64::from(v.diagnostics)),
                e["diagnostics"].as_u64(),
                "{name}"
            );
            let flags: Vec<_> = e["diagnostic_flags"]
                .as_array()
                .unwrap()
                .iter()
                .map(|d| diagnostic(d.as_str().unwrap()))
                .collect();
            assert_eq!(v.diagnostic_flags(), flags, "{name}");
        }
    }

    #[test]
    fn fault_bits_keep_their_positions() {
        let v3 = decode(
            &bytes(&case("v3/unpriceable_warmup_reference_unavailable")),
            1,
        )
        .unwrap()
        .verdict
        .unwrap();
        assert_eq!(v3.faults, (1 << 8) | (1 << 14));
        assert_eq!(ORACLE_FAULT_BITS[7], VerdictReason::Disagreement);
        assert_eq!(ORACLE_FAULT_BITS[13], VerdictReason::PairTimeMismatch);
    }

    #[test]
    fn unavailable_read_decodes_and_the_nine_slot_layout_does_not() {
        let unavailable = hex::decode(UNAVAILABLE.trim()).expect("fixture is hex");
        let read = decode(&unavailable, 1).expect("the seven-slot read decodes");
        assert_eq!(read.finalized_height, 9);
        assert_eq!(read.state, ReadState::Unavailable);
        assert_eq!(read.oracle_permission, OraclePermission::Unavailable);
        assert!(read.policy.is_none() && read.verdict.is_none());

        let mut root =
            rmpv::decode::read_value(&mut unavailable.as_slice()).expect("fixture is msgpack");
        let rmpv::Value::Array(fields) = &mut root else {
            panic!("response is an array")
        };
        fields.splice(2..2, [rmpv::Value::from(10), rmpv::Value::from(false)]);
        fields[3] = rmpv::Value::Nil;
        let mut nine = Vec::new();
        rmpv::encode::write_value(&mut nine, &root).expect("value encodes");
        assert!(decode(&nine, 1).is_err(), "pre-F16 layout");

        for state in ["Legacy", "Committed"] {
            let mut root =
                rmpv::decode::read_value(&mut unavailable.as_slice()).expect("fixture is msgpack");
            let rmpv::Value::Array(fields) = &mut root else {
                panic!("response is an array")
            };
            fields[2] = rmpv::Value::from(state);
            let mut out = Vec::new();
            rmpv::encode::write_value(&mut out, &root).expect("value encodes");
            assert!(decode(&out, 1).is_err(), "{state}");
        }
    }

    #[test]
    fn fallback_certificate_is_the_fallback_slots_own_record() {
        let v = decode(
            &bytes(&case("v3/fresh_fallback_primary_refused_divergence")),
            1,
        )
        .unwrap()
        .verdict
        .unwrap();
        assert_eq!(v.selected, Some(SelectedSource::Fallback));
        assert_eq!(v.certified.map(|c| c.provider_time), v.current_times[1]);
    }

    #[test]
    fn impossible_or_malformed_selection_never_decodes() {
        use rmpv::Value as V;
        let fresh = case("v3/fresh_primary");
        type Edit = Box<dyn FnOnce(&mut Vec<V>)>;
        let edits: Vec<(&str, Edit)> = vec![
            (
                "thirteen fields",
                Box::new(|v| {
                    v.pop();
                }),
            ),
            ("fifteen fields", Box::new(|v| v.push(V::from(0)))),
            ("twelve-field format 2", Box::new(|v| v.truncate(12))),
            ("unknown slot", Box::new(|v| v[12] = V::from("Secondary"))),
            ("slot ordinal", Box::new(|v| v[12] = V::from(0))),
            ("diagnostic bit 4", Box::new(|v| v[13] = V::from(0x10))),
            ("diagnostic above u8", Box::new(|v| v[13] = V::from(0x100))),
            ("fresh without a slot", Box::new(|v| v[12] = V::Nil)),
            (
                "fallback while primary usable",
                Box::new(|v| {
                    v[12] = V::from("Fallback");
                    v[13] = V::from(1);
                }),
            ),
            ("OnFallback on primary", Box::new(|v| v[13] = V::from(1))),
            (
                "unchecked without both usable",
                Box::new(|v| {
                    v[7] = V::from(1);
                    v[13] = V::from(0b100);
                }),
            ),
            (
                "fallback unusable but usable",
                Box::new(|v| v[13] = V::from(8)),
            ),
            ("fault word on fresh", Box::new(|v| v[6] = V::from(1))),
            ("fault bit 15", Box::new(|v| v[6] = V::from(1 << 15))),
            ("mask past slot 1", Box::new(|v| v[7] = V::from(7))),
        ];
        for (name, edit) in edits {
            assert!(decode(&edited(&fresh, edit), 1).is_err(), "{name}");
        }
        let stale = case("v3/unpriceable_no_usable_source");
        assert!(
            decode(&edited(&stale, |v| v[3] = V::from("ManualHalt")), 1).is_err(),
            "a non-fresh reason missing from the fault word"
        );
    }
}
