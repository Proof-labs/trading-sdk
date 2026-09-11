//! One-shot signed submission transport. No nonce allocation, retry, raw
//! response reflection, or inference that an ambiguous transaction was lost.

use super::{MarketsSnapshotClient, MAX_SNAPSHOT_BYTES};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;

pub const MAX_SIGNED_SUBMISSION_BYTES: usize = 4096;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SubmissionVerdict {
    Committed {
        hash: [u8; 32],
        height: u64,
        code: u32,
    },
    GatewayRejected {
        hash: [u8; 32],
        code: u32,
    },
    RejectedBeforeAdmission {
        hash: [u8; 32],
    },
    Pending {
        hash: [u8; 32],
    },
}

impl SubmissionVerdict {
    pub fn hash(&self) -> [u8; 32] {
        match self {
            Self::Committed { hash, .. }
            | Self::GatewayRejected { hash, .. }
            | Self::RejectedBeforeAdmission { hash }
            | Self::Pending { hash } => *hash,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubmissionErrorKind {
    InvalidInput,
    Transport,
    Timeout,
    Http(u16),
    TooLarge,
    Malformed,
    HashMismatch,
}

/// No URL, response body, key, signature, or executable bytes are retained.
/// An error with a hash requires continued reconciliation, not a fresh nonce.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubmissionError {
    pub hash: Option<[u8; 32]>,
    pub kind: SubmissionErrorKind,
}
impl fmt::Display for SubmissionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "signed submission unresolved: {:?}", self.kind)
    }
}
impl std::error::Error for SubmissionError {}

#[derive(Serialize)]
struct Request {
    action: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    status: String,
    error: Option<String>,
    tx_hash: Option<String>,
    code: Option<u32>,
    height: Option<i64>,
}

fn before_admission(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::BAD_REQUEST
            | StatusCode::UNAUTHORIZED
            | StatusCode::FORBIDDEN
            | StatusCode::NOT_FOUND
            | StatusCode::METHOD_NOT_ALLOWED
            | StatusCode::PAYLOAD_TOO_LARGE
            | StatusCode::UNSUPPORTED_MEDIA_TYPE
            | StatusCode::UNPROCESSABLE_ENTITY
            | StatusCode::TOO_MANY_REQUESTS
    )
}

fn classify(
    status: StatusCode,
    bytes: &[u8],
    hash: [u8; 32],
) -> Result<SubmissionVerdict, SubmissionErrorKind> {
    if before_admission(status) {
        return Ok(SubmissionVerdict::RejectedBeforeAdmission { hash });
    }
    let response: Response =
        serde_json::from_slice(bytes).map_err(|_| SubmissionErrorKind::Malformed)?;
    if let Some(returned) = &response.tx_hash {
        if returned.len() != 64 || !returned.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(SubmissionErrorKind::HashMismatch);
        }
        for (pair, expected) in returned.as_bytes().chunks_exact(2).zip(hash) {
            let pair = std::str::from_utf8(pair).map_err(|_| SubmissionErrorKind::HashMismatch)?;
            if u8::from_str_radix(pair, 16).ok() != Some(expected) {
                return Err(SubmissionErrorKind::HashMismatch);
            }
        }
    }
    if matches!(status, StatusCode::OK | StatusCode::SERVICE_UNAVAILABLE)
        && response.status == "error"
        && response.error.is_some()
        && response.tx_hash.is_none()
        && response.code.is_none()
        && response.height.is_none()
    {
        return Ok(SubmissionVerdict::RejectedBeforeAdmission { hash });
    }
    if !status.is_success() {
        return Err(SubmissionErrorKind::Http(status.as_u16()));
    }
    if response.tx_hash.is_some() {
        if response.status == "ok" && response.code == Some(0) {
            if let Some(height) = response.height.filter(|height| *height > 0) {
                return Ok(SubmissionVerdict::Committed {
                    hash,
                    height: height as u64,
                    code: 0,
                });
            }
        }
        // This is the deployed gateway's hash-bound rejection contract. A
        // response without positive height is not called an inclusion receipt.
        if status == StatusCode::OK && response.status == "error" {
            if let Some(code) = response.code.filter(|code| *code != 0) {
                return Ok(match response.height.filter(|height| *height > 0) {
                    Some(height) => SubmissionVerdict::Committed {
                        hash,
                        height: height as u64,
                        code,
                    },
                    None => SubmissionVerdict::GatewayRejected { hash, code },
                });
            }
        }
    }
    if !matches!(response.status.as_str(), "ok" | "error") {
        return Err(SubmissionErrorKind::Malformed);
    }
    Ok(SubmissionVerdict::Pending { hash })
}

impl MarketsSnapshotClient {
    /// Sends the exact already-signed envelope once. Callers must durably
    /// reserve its bytes/hash before calling; this method never retries.
    pub async fn submit_signed_bytes(
        &self,
        bytes: &[u8],
    ) -> Result<SubmissionVerdict, SubmissionError> {
        if bytes.is_empty() || bytes.len() > MAX_SIGNED_SUBMISSION_BYTES {
            return Err(SubmissionError {
                hash: None,
                kind: SubmissionErrorKind::InvalidInput,
            });
        }
        let hash: [u8; 32] = Sha256::digest(bytes).into();
        let failure = |kind| SubmissionError {
            hash: Some(hash),
            kind,
        };
        let request = async {
            let body = serde_json::to_vec(&Request {
                action: STANDARD.encode(bytes),
            })
            .map_err(|_| failure(SubmissionErrorKind::InvalidInput))?;
            let mut endpoint = self.endpoint.clone();
            endpoint.set_path("/exchange");
            let mut response = match self
                .client
                .post(endpoint)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body)
                .send()
                .await
            {
                Ok(response) => response,
                Err(error) if error.is_builder() || error.is_connect() => {
                    return Ok(SubmissionVerdict::RejectedBeforeAdmission { hash })
                }
                Err(error) => {
                    return Err(failure(if error.is_timeout() {
                        SubmissionErrorKind::Timeout
                    } else {
                        SubmissionErrorKind::Transport
                    }))
                }
            };
            let status = response.status();
            // These refusals are terminal before admission; their remote
            // bodies are deliberately neither read nor reflected.
            if before_admission(status) {
                return Ok(SubmissionVerdict::RejectedBeforeAdmission { hash });
            }
            if response
                .content_length()
                .is_some_and(|n| n > MAX_SNAPSHOT_BYTES as u64)
            {
                return Err(failure(SubmissionErrorKind::TooLarge));
            }
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|error| {
                failure(if error.is_timeout() {
                    SubmissionErrorKind::Timeout
                } else {
                    SubmissionErrorKind::Transport
                })
            })? {
                if chunk.len() > MAX_SNAPSHOT_BYTES.saturating_sub(body.len()) {
                    return Err(failure(SubmissionErrorKind::TooLarge));
                }
                body.extend_from_slice(&chunk);
            }
            classify(status, &body, hash).map_err(failure)
        };
        tokio::time::timeout(self.timeout, request)
            .await
            .map_err(|_| failure(SubmissionErrorKind::Timeout))?
    }
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::arithmetic_side_effects
    )]
    use super::*;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn hash(bytes: &[u8]) -> [u8; 32] {
        Sha256::digest(bytes).into()
    }
    fn hash_hex(bytes: &[u8]) -> String {
        hash(bytes).iter().map(|b| format!("{b:02X}")).collect()
    }

    async fn server(
        response: String,
        delay: Duration,
    ) -> (MarketsSnapshotClient, tokio::task::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = MarketsSnapshotClient::new(
            &format!("http://{}", listener.local_addr().unwrap()),
            Duration::from_millis(150),
        )
        .unwrap();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut chunk = [0; 2048];
                let count = stream.read(&mut chunk).await.unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..count]);
                if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&request[..end]);
                    let length = head
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .and_then(|s| s.parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            if !response.is_empty() {
                let _ = stream.write_all(response.as_bytes()).await;
            }
            tokio::time::sleep(delay).await;
            request
        });
        (client, task)
    }
    fn response(status: u16, body: &str) -> String {
        format!(
            "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    #[tokio::test]
    async fn exact_bytes_and_matching_positive_height_are_required() {
        let bytes = b"test-signed-envelope";
        let body = format!(
            r#"{{"status":"ok","txHash":"{}","code":0,"height":42}}"#,
            hash_hex(bytes)
        );
        let (client, task) = server(response(200, &body), Duration::ZERO).await;
        assert_eq!(
            client.submit_signed_bytes(bytes).await.unwrap(),
            SubmissionVerdict::Committed {
                hash: hash(bytes),
                height: 42,
                code: 0
            }
        );
        let request = task.await.unwrap();
        let boundary = request.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
        let body: serde_json::Value = serde_json::from_slice(&request[boundary..]).unwrap();
        assert_eq!(
            STANDARD.decode(body["action"].as_str().unwrap()).unwrap(),
            bytes
        );
        assert!(request.starts_with(b"POST /exchange "));
    }

    #[tokio::test]
    async fn malformed_wrong_hash_and_truncated_responses_keep_hash_without_disclosure() {
        let bytes = b"secret-fixture-signed-payload";
        for reply in [
            response(200, "remote_secret\nmalformed"),
            response(
                200,
                &format!(
                    r#"{{"status":"ok","txHash":"{}","code":0,"height":42,"error":"remote_secret"}}"#,
                    "FF".repeat(32)
                ),
            ),
            "HTTP/1.1 200 OK\r\nContent-Length: 999\r\nConnection: close\r\n\r\nremote_secret"
                .into(),
        ] {
            let (client, task) = server(reply, Duration::ZERO).await;
            let error = client.submit_signed_bytes(bytes).await.unwrap_err();
            assert_eq!(error.hash, Some(hash(bytes)));
            let diagnostic = format!("{error} {error:?}");
            for forbidden in [
                "remote_secret",
                "secret-fixture-signed-payload",
                "127.0.0.1",
                "/exchange",
            ] {
                assert!(!diagnostic.contains(forbidden));
            }
            task.await.unwrap();
        }
    }

    #[tokio::test]
    async fn queue_and_hash_bearing_shed_are_never_terminal() {
        let bytes = b"fixture";
        for (status, body) in [
            (
                200,
                format!(
                    r#"{{"status":"ok","txHash":"{}","code":0}}"#,
                    hash_hex(bytes)
                ),
            ),
            (
                200,
                format!(
                    r#"{{"status":"error","txHash":"{}","error":"queued"}}"#,
                    hash_hex(bytes)
                ),
            ),
            (
                503,
                format!(
                    r#"{{"status":"error","txHash":"{}","error":"queued"}}"#,
                    hash_hex(bytes)
                ),
            ),
        ] {
            let (client, task) = server(response(status, &body), Duration::ZERO).await;
            let result = client.submit_signed_bytes(bytes).await;
            assert!(matches!(
                result,
                Ok(SubmissionVerdict::Pending { .. })
                    | Err(SubmissionError {
                        kind: SubmissionErrorKind::Http(503),
                        ..
                    })
            ));
            task.await.unwrap();
        }
    }

    #[tokio::test]
    async fn canonical_hashless_503_and_pre_admission_status_preserve_refusal() {
        let bytes = b"fixture";
        for (status, body) in [
            (503, r#"{"status":"error","error":"shed"}"#),
            (200, r#"{"status":"error","error":"validation"}"#),
            (429, "remote_secret"),
            (401, "remote_secret"),
        ] {
            let (client, task) = server(response(status, body), Duration::ZERO).await;
            assert_eq!(
                client.submit_signed_bytes(bytes).await.unwrap(),
                SubmissionVerdict::RejectedBeforeAdmission { hash: hash(bytes) }
            );
            task.await.unwrap();
        }
    }

    #[tokio::test]
    async fn oversized_body_and_stream_timeout_are_bounded_and_unresolved() {
        let bytes = b"fixture";
        for (reply, delay, expected) in [
            (
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                    MAX_SNAPSHOT_BYTES + 1
                ),
                Duration::ZERO,
                SubmissionErrorKind::TooLarge,
            ),
            (
                "HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{".into(),
                Duration::from_millis(250),
                SubmissionErrorKind::Timeout,
            ),
        ] {
            let (client, task) = server(reply, delay).await;
            let error = client.submit_signed_bytes(bytes).await.unwrap_err();
            assert_eq!(error.kind, expected);
            assert_eq!(error.hash, Some(hash(bytes)));
            task.await.unwrap();
        }
    }

    #[tokio::test]
    async fn chunked_body_without_declared_length_is_still_bounded() {
        let bytes = b"fixture";
        let body = "x".repeat(MAX_SNAPSHOT_BYTES + 1);
        let reply = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:X}\r\n{body}\r\n0\r\n\r\n",
            body.len()
        );
        let (client, task) = server(reply, Duration::ZERO).await;
        let error = client.submit_signed_bytes(bytes).await.unwrap_err();
        assert_eq!(error.kind, SubmissionErrorKind::TooLarge);
        assert_eq!(error.hash, Some(hash(bytes)));
        task.await.unwrap();
    }

    #[tokio::test]
    async fn redirect_never_forwards_signed_bytes_to_another_endpoint() {
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let reply = format!(
            "HTTP/1.1 307 Redirect\r\nLocation: http://{}/untrusted\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}",
            target.local_addr().unwrap()
        );
        let (client, task) = server(reply, Duration::ZERO).await;
        let error = client.submit_signed_bytes(b"fixture").await.unwrap_err();
        assert_eq!(error.hash, Some(hash(b"fixture")));
        assert!(
            tokio::time::timeout(Duration::from_millis(50), target.accept())
                .await
                .is_err()
        );
        task.await.unwrap();
    }

    #[tokio::test]
    async fn invalid_input_is_refused_without_a_network_request() {
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = MarketsSnapshotClient::new(
            &format!("http://{}", target.local_addr().unwrap()),
            Duration::from_millis(150),
        )
        .unwrap();
        for bytes in [Vec::new(), vec![0; MAX_SIGNED_SUBMISSION_BYTES + 1]] {
            assert_eq!(
                client.submit_signed_bytes(&bytes).await.unwrap_err(),
                SubmissionError {
                    hash: None,
                    kind: SubmissionErrorKind::InvalidInput
                }
            );
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(50), target.accept())
                .await
                .is_err()
        );
    }

    #[test]
    fn exact_hash_rejection_is_distinct_from_inclusion_and_malformed_refusals() {
        let hash = hash(b"fixture");
        let text = hash_hex(b"fixture");
        let without_height = format!(r#"{{"status":"error","txHash":"{text}","code":21}}"#);
        assert_eq!(
            classify(StatusCode::OK, without_height.as_bytes(), hash).unwrap(),
            SubmissionVerdict::GatewayRejected { hash, code: 21 }
        );
        let included = format!(r#"{{"status":"error","txHash":"{text}","code":30,"height":42}}"#);
        assert_eq!(
            classify(StatusCode::OK, included.as_bytes(), hash).unwrap(),
            SubmissionVerdict::Committed {
                hash,
                height: 42,
                code: 30
            }
        );
        for body in [
            r#"{"status":"error","code":21}"#,
            r#"{"status":"error"}"#,
            r#"{"status":"ok","code":0,"height":42}"#,
        ] {
            assert_eq!(
                classify(StatusCode::OK, body.as_bytes(), hash).unwrap(),
                SubmissionVerdict::Pending { hash }
            );
        }
        assert!(classify(StatusCode::BAD_GATEWAY, without_height.as_bytes(), hash).is_err());
    }
}
