//! Atomic, chain-bound inventory read. This is registration, not oracle health.
//! No partial result or transport failure is converted into an empty registry.

use std::collections::BTreeSet;
use std::fmt;
use std::io::Cursor;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use rmpv::Value;
use serde::{Deserialize, Serialize};

use crate::query::ImpactMarketDisplayInfo;
use crate::types::MarketConfig;

/// Whole HTTP response limit, before decoding its base64 envelope.
pub const MAX_SNAPSHOT_BYTES: usize = 1024 * 1024;
/// Resource bounds, not limits on which configured markets are eligible.
pub const MAX_SNAPSHOT_ROWS: usize = 16_384;
const MAX_DEPTH: usize = 32;

/// Node `MarketsSnapshot` positional contract. Nested records use the canonical
/// shared wire DTOs; no independently maintained market/config representation.
#[derive(Debug, Serialize, Deserialize)]
pub struct MarketsSnapshot {
    pub chain_id: [u8; 32],
    pub height: u64,
    pub markets: Vec<MarketConfig>,
    pub impact_markets: Vec<ImpactMarketDisplayInfo>,
}

/// Deliberately excludes request URLs, response bodies and provider credentials.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotError {
    InvalidEndpoint,
    InvalidTimeout,
    Transport,
    Timeout,
    Http(u16),
    TooLarge,
    Malformed,
    WrongChain,
    Uncommitted,
    DuplicateMarket,
    CatchingUp,
    RpcUnavailable,
    HashMismatch,
}

impl fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Http(status) => write!(f, "market snapshot returned HTTP {status}"),
            other => write!(f, "market snapshot refused: {other:?}"),
        }
    }
}

impl std::error::Error for SnapshotError {}

#[derive(Deserialize)]
struct Envelope {
    data: String,
    error: Option<serde_json::Value>,
}

/// Decode a complete JSON/base64/MessagePack response. Duplicate JSON `data`
/// keys, duplicate registry IDs, non-integer scalars, unknown enums, incomplete
/// records and trailing MessagePack bytes all refuse the entire read. Appended
/// tuple fields are permitted, but existing fields are never defaulted away.
pub fn decode_snapshot(
    body: &[u8],
    expected_chain: [u8; 32],
) -> Result<MarketsSnapshot, SnapshotError> {
    if body.len() > MAX_SNAPSHOT_BYTES {
        return Err(SnapshotError::TooLarge);
    }
    let envelope: Envelope = serde_json::from_slice(body).map_err(|_| SnapshotError::Malformed)?;
    if envelope.error.is_some() {
        return Err(SnapshotError::Malformed);
    }
    let bytes = STANDARD
        .decode(envelope.data)
        .map_err(|_| SnapshotError::Malformed)?;
    let mut cursor = Cursor::new(bytes.as_slice());
    // rmpv grows arrays from actual input elements, never from a declared
    // attacker-controlled length. The bounded input and depth bound allocation.
    let mut value = rmpv::decode::read_value_with_max_depth(&mut cursor, MAX_DEPTH)
        .map_err(|_| SnapshotError::Malformed)?;
    if usize::try_from(cursor.position()).ok() != Some(bytes.len()) {
        return Err(SnapshotError::Malformed);
    }
    validate_value(&value)?;
    let top = tuple(&mut value, 4)?;
    top.truncate(4);
    for (slot, width) in [(2, 25), (3, 15)] {
        let rows = match top.get_mut(slot) {
            Some(Value::Array(rows)) => rows,
            _ => return Err(SnapshotError::Malformed),
        };
        if rows.len() > MAX_SNAPSHOT_ROWS {
            return Err(SnapshotError::TooLarge);
        }
        for row in rows {
            tuple(row, width)?.truncate(width);
        }
    }
    let mut canonical = Vec::new();
    rmpv::encode::write_value(&mut canonical, &value).map_err(|_| SnapshotError::Malformed)?;
    let snapshot: MarketsSnapshot =
        rmp_serde::from_slice(&canonical).map_err(|_| SnapshotError::Malformed)?;
    if expected_chain == [0; 32] || snapshot.chain_id != expected_chain {
        return Err(SnapshotError::WrongChain);
    }
    if snapshot.height == 0 {
        return Err(SnapshotError::Uncommitted);
    }
    let mut markets = BTreeSet::new();
    for market in &snapshot.markets {
        if !markets.insert(market.market) {
            return Err(SnapshotError::DuplicateMarket);
        }
    }
    let mut impacts = BTreeSet::new();
    for market in &snapshot.impact_markets {
        if !impacts.insert(market.impact_market_id) {
            return Err(SnapshotError::DuplicateMarket);
        }
    }
    Ok(snapshot)
}

fn tuple(value: &mut Value, minimum: usize) -> Result<&mut Vec<Value>, SnapshotError> {
    match value {
        Value::Array(values) if values.len() >= minimum => Ok(values),
        _ => Err(SnapshotError::Malformed),
    }
}

fn validate_value(value: &Value) -> Result<(), SnapshotError> {
    match value {
        Value::F32(_) | Value::F64(_) | Value::Ext(_, _) => Err(SnapshotError::Malformed),
        Value::String(text) if text.as_str().is_none() => Err(SnapshotError::Malformed),
        Value::Array(values) => values.iter().try_for_each(validate_value),
        Value::Map(values) => {
            let mut keys = BTreeSet::new();
            for (key, value) in values {
                let key = key.as_str().ok_or(SnapshotError::Malformed)?;
                if !keys.insert(key) {
                    return Err(SnapshotError::Malformed);
                }
                validate_value(value)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// One-shot canonical gateway transport. No signing, nonce allocation, retry,
/// node fallback, caching or partial inventory reconciliation lives here.
#[cfg(feature = "gateway")]
#[derive(Clone)]
pub struct MarketsSnapshotClient {
    client: reqwest::Client,
    endpoint: reqwest::Url,
    timeout: std::time::Duration,
}

#[cfg(feature = "gateway")]
impl MarketsSnapshotClient {
    pub fn new(gateway_url: &str, timeout: std::time::Duration) -> Result<Self, SnapshotError> {
        let mut base =
            reqwest::Url::parse(gateway_url).map_err(|_| SnapshotError::InvalidEndpoint)?;
        if !matches!(base.scheme(), "http" | "https")
            || base.host_str().is_none()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
            || base.path() != "/"
        {
            return Err(SnapshotError::InvalidEndpoint);
        }
        if timeout.is_zero() || timeout > std::time::Duration::from_secs(60) {
            return Err(SnapshotError::InvalidTimeout);
        }
        base.set_path("/v1/markets-snapshot");
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .timeout(timeout)
            .build()
            .map_err(|_| SnapshotError::Transport)?;
        Ok(Self {
            client,
            endpoint: base,
            timeout,
        })
    }

    pub async fn read(&self, expected_chain: [u8; 32]) -> Result<MarketsSnapshot, SnapshotError> {
        decode_snapshot(&self.get("/v1/markets-snapshot").await?, expected_chain)
    }

    async fn get(&self, path: &str) -> Result<Vec<u8>, SnapshotError> {
        let mut endpoint = self.endpoint.clone();
        endpoint.set_path(path);
        let request = async {
            let mut response = self.client.get(endpoint).send().await.map_err(|err| {
                if err.is_timeout() {
                    SnapshotError::Timeout
                } else {
                    SnapshotError::Transport
                }
            })?;
            if response.status() != reqwest::StatusCode::OK {
                return Err(SnapshotError::Http(response.status().as_u16()));
            }
            if response
                .content_length()
                .is_some_and(|n| n > MAX_SNAPSHOT_BYTES as u64)
            {
                return Err(SnapshotError::TooLarge);
            }
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|err| {
                if err.is_timeout() {
                    SnapshotError::Timeout
                } else {
                    SnapshotError::Transport
                }
            })? {
                if body.len().saturating_add(chunk.len()) > MAX_SNAPSHOT_BYTES {
                    return Err(SnapshotError::TooLarge);
                }
                body.extend_from_slice(&chunk);
            }
            Ok(body)
        };
        tokio::time::timeout(self.timeout, request)
            .await
            .map_err(|_| SnapshotError::Timeout)?
    }
}

#[cfg(feature = "gateway")]
mod chain;
#[cfg(feature = "gateway")]
pub use chain::{ChainIdentity, CommittedReceipt};

#[cfg(feature = "gateway")]
mod submission;
#[cfg(feature = "gateway")]
pub use submission::{
    SubmissionError, SubmissionErrorKind, SubmissionVerdict, MAX_SIGNED_SUBMISSION_BYTES,
};

#[cfg(test)]
mod tests;
