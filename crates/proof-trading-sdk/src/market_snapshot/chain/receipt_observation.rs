//! Exact-hash observation only. Not-found does not establish non-inclusion,
//! expiry, an accepted price effect, or permission to release a pending slot.

use super::{decode_receipt, CommittedReceipt, MarketsSnapshotClient, SnapshotError};
use crate::market_snapshot::MAX_SNAPSHOT_BYTES;
use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReceiptObservation {
    Committed(CommittedReceipt),
    /// A positive, structurally verified `price_updated` event in an exact
    /// code-zero committed receipt. Composite updates share this event; a
    /// caller must also bind the hash to its retained signed primary action,
    /// chain, market and signer before inferring a primary publish-floor effect.
    /// This is gateway evidence, not a cryptographic consensus inclusion proof.
    CommittedPriceUpdate {
        receipt: CommittedReceipt,
        market: u32,
        price: u64,
        signer: [u8; 20],
    },
    /// The gateway returned the canonical not-found shape for exactly this
    /// requested hash. This is a liveness observation, never finality proof.
    ExactNotFound {
        tx_hash: [u8; 32],
    },
}

#[derive(Deserialize)]
struct NotFoundResponse {
    result: Option<serde_json::Value>,
    status: Option<String>,
    jsonrpc: Option<String>,
    error: NotFoundError,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum NotFoundError {
    Rpc {
        code: i64,
        message: String,
        data: String,
    },
    Gateway(String),
}

#[derive(Deserialize)]
struct ReceiptEvents {
    result: EventResult,
}
#[derive(Deserialize)]
struct EventResult {
    tx_result: EventExecution,
}
#[derive(Deserialize)]
struct EventExecution {
    events: Vec<PriceEvent>,
}
#[derive(Deserialize)]
struct PriceEvent {
    #[serde(rename = "type")]
    kind: String,
    attributes: Vec<EventAttribute>,
}
#[derive(Deserialize)]
struct EventAttribute {
    key: String,
    value: String,
}

fn price_update(body: &[u8], receipt: &CommittedReceipt) -> Option<ReceiptObservation> {
    if receipt.code != 0 {
        return None;
    }
    // Current OracleUpdate emits exactly one event. Extra, unknown, duplicate,
    // rejected or malformed events are not accepted-effect proof. Incomplete
    // event evidence does not erase an otherwise valid committed receipt.
    let envelope: ReceiptEvents = serde_json::from_slice(body).ok()?;
    let [event] = envelope.result.tx_result.events.as_slice() else {
        return None;
    };
    if event.kind != "price_updated" || event.attributes.len() != 3 {
        return None;
    }
    let (mut market, mut price, mut signer) = (None, None, None);
    for attribute in &event.attributes {
        match attribute.key.as_str() {
            "market" if market.is_none() => {
                market = Some(u32::try_from(super::positive_decimal(&attribute.value).ok()?).ok()?);
            }
            "price" if price.is_none() => {
                price = Some(super::positive_decimal(&attribute.value).ok()?);
            }
            "signer" if signer.is_none() => {
                // Current ABCI attributes are strings, not base64 byte slices.
                // Some(address) is 40 lowercase hex; None is empty and cannot
                // bind this positive evidence to a retained signing authority.
                if attribute.value.len() != 40
                    || !attribute
                        .value
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                {
                    return None;
                }
                let mut address = [0; 20];
                for (pair, target) in attribute.value.as_bytes().chunks_exact(2).zip(&mut address) {
                    *target = u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?;
                }
                signer = Some(address);
            }
            _ => return None,
        }
    }
    Some(ReceiptObservation::CommittedPriceUpdate {
        receipt: receipt.clone(),
        market: market?,
        price: price?,
        signer: signer?,
    })
}

fn classify(status: u16, body: &[u8], hash: [u8; 32]) -> Result<ReceiptObservation, SnapshotError> {
    if body.len() > MAX_SNAPSHOT_BYTES {
        return Err(SnapshotError::TooLarge);
    }
    if status == 200 {
        let receipt = decode_receipt(body, hash)?;
        return Ok(price_update(body, &receipt).unwrap_or(ReceiptObservation::Committed(receipt)));
    }
    if !matches!(status, 404 | 500) {
        return Err(SnapshotError::Http(status));
    }
    let response: NotFoundResponse =
        serde_json::from_slice(body).map_err(|_| SnapshotError::Malformed)?;
    if response.result.is_some()
        || response
            .status
            .as_deref()
            .is_some_and(|status| status != "error")
        || response
            .jsonrpc
            .as_deref()
            .is_some_and(|version| version != "2.0")
    {
        return Err(SnapshotError::Malformed);
    }
    let text = match response.error {
        NotFoundError::Rpc {
            code: -32603,
            message,
            data,
        } if message == "Internal error" => data,
        NotFoundError::Gateway(data) => data,
        _ => return Err(SnapshotError::RpcUnavailable),
    };
    let text = text.to_ascii_lowercase();
    // Exact Comet/gateway grammar, not just a hash somewhere beside "not found".
    // Proxy/backend errors and messages naming multiple transactions cannot
    // become progress evidence for a caller's bounded give-up policy.
    let token = text
        .strip_prefix("tx (")
        .and_then(|text| text.strip_suffix(") not found"))
        .ok_or(SnapshotError::RpcUnavailable)?;
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(SnapshotError::RpcUnavailable);
    }
    for (pair, expected) in token.as_bytes().chunks_exact(2).zip(hash) {
        let pair = std::str::from_utf8(pair).map_err(|_| SnapshotError::Malformed)?;
        if u8::from_str_radix(pair, 16).map_err(|_| SnapshotError::Malformed)? != expected {
            return Err(SnapshotError::HashMismatch);
        }
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
