//! Established gateway chain/receipt read semantics, scoped to the inventory
//! lifecycle. Errors are never evidence that an in-flight action was rejected.

use super::{BlockHeight, MarketsSnapshotClient, SnapshotError};
use crate::gateway::TxHash;
use serde::{de::DeserializeOwned, Deserialize};

mod receipt_observation;
pub use receipt_observation::{CommittedPriceUpdate, PriceEvidenceRejection, ReceiptObservation};

// One definition each, shared with the gateway client: the same node answers
// both, and two shapes for one answer only invited them to drift.
pub use crate::gateway::{ChainIdentity, CommittedReceipt};

#[derive(Deserialize)]
struct Rpc<T> {
    result: Option<T>,
    error: Option<serde_json::Value>,
}
#[derive(Deserialize)]
struct Status {
    node_info: NodeInfo,
    sync_info: SyncInfo,
}
#[derive(Deserialize)]
struct NodeInfo {
    network: String,
}
#[derive(Deserialize)]
struct SyncInfo {
    latest_block_height: String,
    latest_block_time: String,
    catching_up: bool,
}
#[derive(Deserialize)]
struct TxRead {
    hash: String,
    height: String,
    tx_result: TxExecution,
}
#[derive(Deserialize)]
struct TxExecution {
    code: u32,
}

pub(super) fn rpc<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, SnapshotError> {
    let response: Rpc<T> = serde_json::from_slice(bytes).map_err(|_| SnapshotError::Malformed)?;
    match (response.result, response.error) {
        (Some(value), None) => Ok(value),
        (None, Some(_)) => Err(SnapshotError::RpcUnavailable),
        _ => Err(SnapshotError::Malformed),
    }
}

fn positive_height(text: &str) -> Result<BlockHeight, SnapshotError> {
    BlockHeight::new(positive_decimal(text)?).ok_or(SnapshotError::Malformed)
}

fn positive_decimal(text: &str) -> Result<u64, SnapshotError> {
    super::values::positive_decimal(text).ok_or(SnapshotError::Malformed)
}

/// The exact-hash rule both receipt reads share: a well-formed hash that is
/// not the requested one is a mismatch, not a malformed body.
pub(super) fn matching_hash(text: &str, expected: TxHash) -> Result<(), SnapshotError> {
    let read: [u8; 32] = super::values::hex_array(text).ok_or(SnapshotError::Malformed)?;
    if read != expected.bytes() {
        return Err(SnapshotError::HashMismatch);
    }
    Ok(())
}

/// `/v1/tx/{hash}`, the one path both receipt reads request.
pub(super) fn receipt_path(hash: TxHash) -> String {
    let mut path = String::from("/v1/tx/");
    for byte in hash.bytes() {
        // 32 bytes of uppercase hexadecimal, the form CometBFT indexes by.
        path.push_str(&format!("{byte:02X}"));
    }
    path
}

impl MarketsSnapshotClient {
    /// A committed, same-chain, caught-up time anchor. This does not certify
    /// oracle freshness, and it must not be spliced into a market snapshot.
    pub async fn chain_identity(
        &self,
        expected_chain: [u8; 32],
    ) -> Result<ChainIdentity, SnapshotError> {
        decode_identity(&self.get("/v1/status").await?, expected_chain)
    }

    /// One exact-hash receipt read. Any error (404, RPC not-found, timeout,
    /// mismatch or malformed body) leaves the submission unresolved. No retry,
    /// nonce allocation or inference from elapsed wall time occurs here.
    pub async fn committed_receipt(&self, hash: TxHash) -> Result<CommittedReceipt, SnapshotError> {
        decode_receipt(&self.get(&receipt_path(hash)).await?, hash)
    }
}

pub(super) fn decode_identity(
    body: &[u8],
    expected: [u8; 32],
) -> Result<ChainIdentity, SnapshotError> {
    let status: Status = rpc(body)?;
    let network = status.node_info.network;
    if network.is_empty() || network.len() > 128 || network.chars().any(char::is_control) {
        return Err(SnapshotError::Malformed);
    }
    let chain_binding = crate::crypto::chain_id_from_string(&network);
    if expected == [0; 32] || chain_binding != expected {
        return Err(SnapshotError::WrongChain);
    }
    if status.sync_info.catching_up {
        return Err(SnapshotError::CatchingUp);
    }
    let timestamp = chrono::DateTime::parse_from_rfc3339(&status.sync_info.latest_block_time)
        .map_err(|_| SnapshotError::Malformed)?
        .timestamp_millis();
    let latest_block_time_ms = u64::try_from(timestamp).map_err(|_| SnapshotError::Malformed)?;
    if latest_block_time_ms == 0 {
        return Err(SnapshotError::Uncommitted);
    }
    Ok(ChainIdentity {
        network,
        chain_binding,
        latest_height: positive_height(&status.sync_info.latest_block_height)?,
        latest_block_time_ms,
        // A catching-up node was refused above, so this read never reports one.
        catching_up: false,
    })
}

fn decode_receipt(body: &[u8], hash: TxHash) -> Result<CommittedReceipt, SnapshotError> {
    let read: TxRead = rpc(body)?;
    matching_hash(&read.hash, hash)?;
    Ok(CommittedReceipt {
        hash,
        height: positive_height(&read.height)?,
        code: read.tx_result.code,
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::arithmetic_side_effects)]
    use super::*;
    use serde_json::json;

    fn status() -> serde_json::Value {
        json!({"result":{"node_info":{"network":"proof-test"},"sync_info":{
            "latest_block_height":"9007199254740993","latest_block_time":"2026-09-11T12:00:00.123Z","catching_up":false}}})
    }
    #[test]
    fn committed_time_requires_exact_chain_height_and_caught_up_state() {
        let expected = crate::crypto::chain_id_from_string("proof-test");
        let decoded = decode_identity(&serde_json::to_vec(&status()).unwrap(), expected).unwrap();
        assert_eq!(decoded.latest_height.get(), 9_007_199_254_740_993);
        assert_eq!(decoded.latest_block_time_ms, 1_789_128_000_123);
        for (field, value) in [
            ("catching_up", json!(true)),
            ("latest_block_height", json!("0")),
            ("latest_block_height", json!("01")),
            ("latest_block_time", json!("1970-01-01T00:00:00Z")),
            ("latest_block_time", json!("not-a-timestamp")),
        ] {
            let mut body = status();
            body["result"]["sync_info"][field] = value;
            assert!(decode_identity(&serde_json::to_vec(&body).unwrap(), expected).is_err());
        }
        assert_eq!(
            decode_identity(&serde_json::to_vec(&status()).unwrap(), [9; 32]).unwrap_err(),
            SnapshotError::WrongChain
        );
    }
    #[test]
    fn only_matching_committed_receipts_are_terminal() {
        let base = json!({"result":{"hash":"AA".repeat(32),"height":"42","tx_result":{"code":0}}});
        let hash = TxHash::from_bytes([0xaa; 32]);
        let receipt = decode_receipt(&serde_json::to_vec(&base).unwrap(), hash).unwrap();
        assert_eq!((receipt.height.get(), receipt.code), (42, 0));
        let mut rejected = base.clone();
        rejected["result"]["tx_result"]["code"] = json!(23);
        assert_eq!(
            decode_receipt(&serde_json::to_vec(&rejected).unwrap(), hash)
                .unwrap()
                .code,
            23
        );
        for body in [
            json!({"error":{"code":-32603}}),
            json!({}),
            json!({"result":{"hash":"AA".repeat(32),"height":"0","tx_result":{"code":0}}}),
            json!({"result":{"hash":"BB".repeat(32),"height":"42","tx_result":{"code":0}}}),
            json!({"result":{"hash":"AA".repeat(32),"height":"42","tx_result":{}}}),
        ] {
            assert!(decode_receipt(&serde_json::to_vec(&body).unwrap(), hash).is_err());
        }
    }

    #[tokio::test]
    async fn canonical_gateway_paths_preserve_time_and_exact_receipt() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let status_body = serde_json::to_vec(&status()).unwrap();
            let receipt_body = serde_json::to_vec(&json!({"result":{
                "hash":"AA".repeat(32),"height":"42","tx_result":{"code":7}}}))
            .unwrap();
            for (path, body) in [
                ("/v1/status".to_string(), status_body),
                (format!("/v1/tx/{}", "AA".repeat(32)), receipt_body),
            ] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut input = [0; 1024];
                let n = socket.read(&mut input).await.unwrap();
                assert!(std::str::from_utf8(&input[..n])
                    .unwrap()
                    .starts_with(&format!("GET {path} HTTP/1.1\r\n")));
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                socket.write_all(header.as_bytes()).await.unwrap();
                socket.write_all(&body).await.unwrap();
            }
        });
        let client = MarketsSnapshotClient::new(&url, std::time::Duration::from_secs(1)).unwrap();
        let identity = client
            .chain_identity(crate::crypto::chain_id_from_string("proof-test"))
            .await
            .unwrap();
        assert_eq!(identity.latest_height.get(), 9_007_199_254_740_993);
        let receipt = client
            .committed_receipt(TxHash::from_bytes([0xaa; 32]))
            .await
            .unwrap();
        assert_eq!((receipt.height.get(), receipt.code), (42, 7));
        task.await.unwrap();
    }
}
