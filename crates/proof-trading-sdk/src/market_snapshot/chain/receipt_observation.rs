//! Exact-hash observation only. Not-found does not establish non-inclusion,
//! expiry, an accepted price effect, or permission to release a pending slot.

use super::{decode_receipt, CommittedReceipt, MarketsSnapshotClient, SnapshotError};
use crate::gateway::TxHash;
use crate::market_snapshot::{MarketId, MicroUsdc, MAX_SNAPSHOT_BYTES};
use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReceiptObservation {
    Committed(CommittedReceipt),
    CommittedPriceUpdate(CommittedPriceUpdate),
    /// A code-zero receipt carrying a `price_updated` event that failed a
    /// structural check. The receipt stands; the price effect is unproven,
    /// exactly as for [`Committed`](Self::Committed). `rejection` exists so a
    /// consumer can count or alert on evidence it expected to be usable.
    RejectedPriceEvidence {
        receipt: CommittedReceipt,
        rejection: PriceEvidenceRejection,
    },
    /// The gateway returned the canonical not-found shape for exactly this
    /// requested hash. This is a liveness observation, never finality proof.
    ExactNotFound {
        tx_hash: TxHash,
    },
}

/// Why a `price_updated` event was refused as evidence. A receipt without such
/// an event, or with a non-zero code, is not a rejection: the event the caller
/// expected may simply belong to a different action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PriceEvidenceRejection {
    /// A single `price_updated` event cannot be decoded into the expected
    /// attribute shape (string keys and values).
    MalformedPriceEvent,
    /// The receipt carries a `price_updated` event alongside other events, so
    /// no single event can be read as the canonical effect.
    MultipleEvents,
    /// The event does not carry exactly the `market`, `price` and `signer`
    /// attributes.
    UnexpectedAttributeCount,
    /// An attribute key outside those three.
    UnknownAttribute,
    /// One of the three attributes appears more than once.
    DuplicateAttribute,
    /// `market` is not a positive decimal that fits `u32`.
    InvalidMarket,
    /// `price` is not a positive decimal that fits `u64`.
    InvalidPrice,
    /// `signer` is not 40 lowercase hexadecimal digits.
    InvalidSigner,
}

/// A positive, structurally verified `price_updated` event in an exact
/// code-zero committed receipt, built only by
/// [`MarketsSnapshotClient::receipt_observation`]. Composite updates share this
/// event; a caller must also bind the hash to its retained signed primary
/// action, chain, market and signer before inferring a primary publish-floor
/// effect. This is gateway evidence, not a cryptographic consensus inclusion
/// proof.
///
/// ```
/// # use proof_trading_sdk::market_snapshot::{CommittedPriceUpdate, MarketId, ReceiptObservation};
/// fn updated_market(observation: &ReceiptObservation) -> Option<MarketId> {
///     match observation {
///         ReceiptObservation::CommittedPriceUpdate(update) => Some(update.market()),
///         _ => None,
///     }
/// }
/// ```
///
/// ```compile_fail
/// # use proof_trading_sdk::market_snapshot::{CommittedPriceUpdate, CommittedReceipt};
/// fn forge(receipt: CommittedReceipt) -> CommittedPriceUpdate {
///     CommittedPriceUpdate { receipt, market: 1, price: 1, signer: [1; 20] }
/// }
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommittedPriceUpdate {
    receipt: CommittedReceipt,
    market: MarketId,
    price: MicroUsdc,
    signer: [u8; 20],
}

impl CommittedPriceUpdate {
    pub fn receipt(&self) -> &CommittedReceipt {
        &self.receipt
    }

    pub fn market(&self) -> MarketId {
        self.market
    }

    pub fn price(&self) -> MicroUsdc {
        self.price
    }

    pub fn signer(&self) -> [u8; 20] {
        self.signer
    }
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

enum PriceEvidence {
    Accepted(CommittedPriceUpdate),
    Rejected(PriceEvidenceRejection),
    /// A non-zero code or no identifiable `price_updated` event to read.
    Absent,
}

/// Diagnose a failed strict decode without treating permissively parsed JSON
/// as accepted evidence. Only an explicit event type identifies price evidence.
fn price_event_decode_failure(body: &[u8]) -> PriceEvidence {
    let Ok(envelope) = serde_json::from_slice::<serde_json::Value>(body) else {
        return PriceEvidence::Absent;
    };
    let Some(events) = envelope
        .pointer("/result/tx_result/events")
        .and_then(serde_json::Value::as_array)
    else {
        return PriceEvidence::Absent;
    };
    if !events
        .iter()
        .any(|event| event.get("type").and_then(serde_json::Value::as_str) == Some("price_updated"))
    {
        return PriceEvidence::Absent;
    }
    PriceEvidence::Rejected(if events.len() == 1 {
        PriceEvidenceRejection::MalformedPriceEvent
    } else {
        PriceEvidenceRejection::MultipleEvents
    })
}

/// ABCI attributes are strings, not base64 byte slices. An address is
/// 40 lowercase hexadecimal digits; anything else cannot bind this evidence to
/// a retained signing authority.
fn signer_address(text: &str) -> Option<[u8; 20]> {
    if text.len() != 40
        || !text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    let mut address = [0; 20];
    for (pair, target) in text.as_bytes().chunks_exact(2).zip(&mut address) {
        *target = u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?;
    }
    Some(address)
}

/// An accepted oracle update emits exactly one event. Extra, unknown, duplicate or
/// malformed attributes are never accepted-effect proof; incomplete evidence
/// does not erase an otherwise valid committed receipt, it only names why the
/// event was refused.
fn price_update(body: &[u8], receipt: &CommittedReceipt) -> PriceEvidence {
    use PriceEvidenceRejection as Refused;
    if receipt.code != 0 {
        return PriceEvidence::Absent;
    }
    let Ok(envelope) = serde_json::from_slice::<ReceiptEvents>(body) else {
        return price_event_decode_failure(body);
    };
    let events = envelope.result.tx_result.events;
    let [event] = events.as_slice() else {
        return if events.iter().any(|event| event.kind == "price_updated") {
            PriceEvidence::Rejected(Refused::MultipleEvents)
        } else {
            PriceEvidence::Absent
        };
    };
    if event.kind != "price_updated" {
        return PriceEvidence::Absent;
    }
    if event.attributes.len() != 3 {
        return PriceEvidence::Rejected(Refused::UnexpectedAttributeCount);
    }
    let (mut market, mut price, mut signer) = (None, None, None);
    for attribute in &event.attributes {
        match attribute.key.as_str() {
            "market" if market.is_some() => {
                return PriceEvidence::Rejected(Refused::DuplicateAttribute)
            }
            "price" if price.is_some() => {
                return PriceEvidence::Rejected(Refused::DuplicateAttribute)
            }
            "signer" if signer.is_some() => {
                return PriceEvidence::Rejected(Refused::DuplicateAttribute)
            }
            "market" => {
                market = super::positive_decimal(&attribute.value)
                    .ok()
                    .and_then(|value| u32::try_from(value).ok())
                    .and_then(MarketId::new);
                if market.is_none() {
                    return PriceEvidence::Rejected(Refused::InvalidMarket);
                }
            }
            "price" => {
                price = super::positive_decimal(&attribute.value)
                    .ok()
                    .map(MicroUsdc::new);
                if price.is_none() {
                    return PriceEvidence::Rejected(Refused::InvalidPrice);
                }
            }
            "signer" => {
                signer = signer_address(&attribute.value);
                if signer.is_none() {
                    return PriceEvidence::Rejected(Refused::InvalidSigner);
                }
            }
            _ => return PriceEvidence::Rejected(Refused::UnknownAttribute),
        }
    }
    // Three attributes, each a distinct known key, fill all three slots.
    let (Some(market), Some(price), Some(signer)) = (market, price, signer) else {
        return PriceEvidence::Rejected(Refused::UnexpectedAttributeCount);
    };
    PriceEvidence::Accepted(CommittedPriceUpdate {
        receipt: receipt.clone(),
        market,
        price,
        signer,
    })
}

fn classify(status: u16, body: &[u8], hash: TxHash) -> Result<ReceiptObservation, SnapshotError> {
    if body.len() > MAX_SNAPSHOT_BYTES {
        return Err(SnapshotError::TooLarge);
    }
    if status == 200 {
        let receipt = decode_receipt(body, hash)?;
        return Ok(match price_update(body, &receipt) {
            PriceEvidence::Accepted(update) => ReceiptObservation::CommittedPriceUpdate(update),
            PriceEvidence::Rejected(rejection) => {
                ReceiptObservation::RejectedPriceEvidence { receipt, rejection }
            }
            PriceEvidence::Absent => ReceiptObservation::Committed(receipt),
        });
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
    for (pair, expected) in token.as_bytes().chunks_exact(2).zip(hash.bytes()) {
        let pair = std::str::from_utf8(pair).map_err(|_| SnapshotError::Malformed)?;
        if u8::from_str_radix(pair, 16).map_err(|_| SnapshotError::Malformed)? != expected {
            return Err(SnapshotError::HashMismatch);
        }
    }
    Ok(ReceiptObservation::ExactNotFound { tx_hash: hash })
}

impl MarketsSnapshotClient {
    /// One gateway receipt read, classified: a committed receipt, price-update
    /// evidence, a refusal reason, or the canonical not-found shape for exactly
    /// this hash. One whole-call deadline and a bounded body; no retries,
    /// redirects, direct-node fallback or pending-state changes.
    pub async fn receipt_observation(
        &self,
        hash: TxHash,
    ) -> Result<ReceiptObservation, SnapshotError> {
        use std::fmt::Write;
        let mut path = String::from("/v1/tx/");
        for byte in hash.bytes() {
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
