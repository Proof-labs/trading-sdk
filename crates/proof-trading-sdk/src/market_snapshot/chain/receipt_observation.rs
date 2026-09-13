//! Exact-hash observation only. Not-found does not establish non-inclusion,
//! expiry, an accepted price effect, or permission to release a pending slot.

use super::{decode_receipt, CommittedReceipt, MarketsSnapshotClient, SnapshotError};
use crate::market_snapshot::MAX_SNAPSHOT_BYTES;
use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReceiptObservation {
    Committed(CommittedReceipt),
    /// The gateway returned the canonical not-found shape for exactly this
    /// requested hash. This is a liveness observation, never finality proof.
    ExactNotFound {
        tx_hash: [u8; 32],
    },
}

#[derive(Deserialize)]
struct NotFoundResponse {
    result: Option<serde_json::Value>,
    error: NotFoundError,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum NotFoundError {
    Rpc { data: String },
    Gateway(String),
}

fn classify(status: u16, body: &[u8], hash: [u8; 32]) -> Result<ReceiptObservation, SnapshotError> {
    if body.len() > MAX_SNAPSHOT_BYTES {
        return Err(SnapshotError::TooLarge);
    }
    if status == 200 {
        return decode_receipt(body, hash).map(ReceiptObservation::Committed);
    }
    if !matches!(status, 404 | 500) {
        return Err(SnapshotError::Http(status));
    }
    let response: NotFoundResponse =
        serde_json::from_slice(body).map_err(|_| SnapshotError::Malformed)?;
    if response.result.is_some() {
        return Err(SnapshotError::Malformed);
    }
    let text = match response.error {
        NotFoundError::Rpc { data } | NotFoundError::Gateway(data) => data,
    };
    let text = text.to_ascii_lowercase();
    if !text.contains("not found") {
        return Err(SnapshotError::RpcUnavailable);
    }
    // Match complete hex runs, not a substring of another hash. Every named
    // 64-hex identity must match; an extra foreign hash rejects the observation.
    let mut found = false;
    for token in text.as_bytes().split(|byte| !byte.is_ascii_hexdigit()) {
        if token.len() != 64 {
            continue;
        }
        for (pair, expected) in token.chunks_exact(2).zip(hash) {
            let pair = std::str::from_utf8(pair).map_err(|_| SnapshotError::Malformed)?;
            if u8::from_str_radix(pair, 16).map_err(|_| SnapshotError::Malformed)? != expected {
                return Err(SnapshotError::HashMismatch);
            }
        }
        found = true;
    }
    if !found {
        return Err(SnapshotError::RpcUnavailable);
    }
    Ok(ReceiptObservation::ExactNotFound { tx_hash: hash })
}

impl MarketsSnapshotClient {
    /// One gateway receipt observation with a whole-call deadline and bounded
    /// body. No retries, redirects, direct-node fallback, or pending-state
    /// changes. Existing `committed_receipt` behavior remains unchanged.
    pub async fn receipt_observation(
        &self,
        hash: [u8; 32],
    ) -> Result<ReceiptObservation, SnapshotError> {
        use std::fmt::Write;
        let mut path = String::from("/v1/tx/");
        for byte in hash {
            write!(&mut path, "{byte:02X}").map_err(|_| SnapshotError::Malformed)?;
        }
        let mut endpoint = self.endpoint.clone();
        endpoint.set_path(&path);
        let request = async {
            let mut response = self
                .client
                .get(endpoint)
                .send()
                .await
                .map_err(transport_error)?;
            let status = response.status().as_u16();
            if !matches!(status, 200 | 404 | 500) {
                return Err(SnapshotError::Http(status));
            }
            if response
                .content_length()
                .is_some_and(|n| n > MAX_SNAPSHOT_BYTES as u64)
            {
                return Err(SnapshotError::TooLarge);
            }
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(transport_error)? {
                if body.len().saturating_add(chunk.len()) > MAX_SNAPSHOT_BYTES {
                    return Err(SnapshotError::TooLarge);
                }
                body.extend_from_slice(&chunk);
            }
            classify(status, &body, hash)
        };
        tokio::time::timeout(self.timeout, request)
            .await
            .map_err(|_| SnapshotError::Timeout)?
    }
}

fn transport_error(error: reqwest::Error) -> SnapshotError {
    if error.is_timeout() {
        SnapshotError::Timeout
    } else {
        SnapshotError::Transport
    }
}

#[cfg(test)]
mod tests;
