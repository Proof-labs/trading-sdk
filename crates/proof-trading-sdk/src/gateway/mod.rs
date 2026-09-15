//! Optional native gateway transport. No keys, nonce allocation, automatic retry,
//! direct-node fallback or operational oracle-health read exists in this module.
//! A committed execution receipt is not an oracle Fresh certificate.

mod permissions;
pub use permissions::*;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::{
    header::{HeaderMap, HeaderValue, RETRY_AFTER},
    Client, Method, Url,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fmt,
    num::{NonZeroU32, NonZeroU64},
    time::{Duration, SystemTime},
};

const MAX_RESPONSE_BYTES: usize = 1_048_576;
// Fits below the gateway's default 8192-byte JSON body cap after base64 wrapping.
const MAX_SIGNED_BYTES: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    Configuration,
    ChainIdentity,
    OraclePermissions,
    Submit,
    Receipt,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    InvalidConfiguration,
    InvalidInput,
    Transport,
    Timeout,
    BodyTooLarge,
    HttpStatus(u16),
    InvalidResponse,
    HashMismatch,
    RpcUnavailable,
}
/// `Invalid` must not be treated as permission to immediately retry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetryAfter {
    DelaySeconds(u64),
    At(SystemTime),
    Invalid,
}

/// Deliberately contains no URL, API key, raw response, signature or signed bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GatewayError {
    pub operation: Operation,
    pub kind: ErrorKind,
    pub retry_after: Option<RetryAfter>,
    /// A POST may have reached the gateway. Preserve and reconcile these exact
    /// bytes by this locally computed hash; do not allocate a replacement nonce.
    pub reconcile_hash: Option<TxHash>,
}
impl GatewayError {
    fn new(operation: Operation, kind: ErrorKind) -> Self {
        Self {
            operation,
            kind,
            retry_after: None,
            reconcile_hash: None,
        }
    }
    fn submission(mut self, hash: TxHash) -> Self {
        self.reconcile_hash = Some(hash);
        self
    }
}
impl fmt::Display for GatewayError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "gateway {:?}: {:?}", self.operation, self.kind)
    }
}
impl std::error::Error for GatewayError {}

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct TxHash([u8; 32]);
impl TxHash {
    pub fn of_signed_bytes(bytes: &[u8]) -> Self {
        Self(Sha256::digest(bytes).into())
    }
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
    pub fn bytes(self) -> [u8; 32] {
        self.0
    }
    pub fn from_hex(text: &str) -> Result<Self, GatewayError> {
        let text = text.strip_prefix("0x").unwrap_or(text);
        if text.len() != 64 {
            return Err(GatewayError::new(
                Operation::Receipt,
                ErrorKind::InvalidInput,
            ));
        }
        let mut bytes = [0u8; 32];
        for (pair, byte) in text.as_bytes().chunks_exact(2).zip(&mut bytes) {
            let digit = |c: u8| match c {
                b'0'..=b'9' => Some(c.wrapping_sub(b'0')),
                b'a'..=b'f' => Some(c.wrapping_sub(b'a').wrapping_add(10)),
                b'A'..=b'F' => Some(c.wrapping_sub(b'A').wrapping_add(10)),
                _ => None,
            };
            let hi = digit(pair[0])
                .ok_or_else(|| GatewayError::new(Operation::Receipt, ErrorKind::InvalidInput))?;
            let lo = digit(pair[1])
                .ok_or_else(|| GatewayError::new(Operation::Receipt, ErrorKind::InvalidInput))?;
            *byte = (hi << 4) | lo;
        }
        Ok(Self(bytes))
    }
}
impl fmt::Display for TxHash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in self.0 {
            write!(f, "{byte:02X}")?;
        }
        Ok(())
    }
}
impl fmt::Debug for TxHash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

pub struct GatewayOptions {
    /// Total request deadline including response-body consumption (1ms..60s).
    pub timeout: Duration,
    /// Bounded regardless of absent/incorrect Content-Length (1..1MiB).
    pub max_response_bytes: usize,
    /// Header only; never a URL parameter and never included in diagnostics.
    pub api_key: Option<String>,
}
impl Default for GatewayOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(10),
            max_response_bytes: 262_144,
            api_key: None,
        }
    }
}
impl fmt::Debug for GatewayOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GatewayOptions")
            .field("timeout", &self.timeout)
            .field("max_response_bytes", &self.max_response_bytes)
            .field("api_key", &self.api_key.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
}

#[derive(Clone)]
pub struct GatewayClient {
    client: Client,
    base: Url,
    max_response_bytes: usize,
}
impl fmt::Debug for GatewayClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("GatewayClient { endpoint: [REDACTED] }")
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChainIdentity {
    pub network: String,
    pub chain_binding: [u8; 32],
    pub latest_height: u64,
    /// Provider capture must be checked against consensus time, never local time alone.
    pub latest_block_time_ms: u64,
    pub catching_up: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommittedReceipt {
    pub hash: TxHash,
    pub height: NonZeroU64,
    pub code: u32,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SubmissionOutcome {
    Committed(CommittedReceipt),
    CheckTxRejected {
        hash: TxHash,
        code: NonZeroU32,
    },
    /// Includes a legacy CheckTx-only acknowledgement; inclusion is still unknown.
    Pending {
        hash: TxHash,
    },
    RejectedBeforeAdmission {
        hash: TxHash,
    },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Submission {
    pub outcome: SubmissionOutcome,
    pub retry_after: Option<RetryAfter>,
}

#[derive(Deserialize)]
struct EncodedRead {
    data: String,
}
#[derive(Deserialize)]
struct Rpc<T> {
    result: Option<T>,
    error: Option<serde_json::Value>,
}
#[derive(Deserialize)]
struct StatusRead {
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
#[derive(Serialize)]
struct SignedRequest {
    action: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubmitRead {
    status: String,
    tx_hash: Option<String>,
    code: Option<u32>,
    height: Option<u64>,
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

struct ResponseBody {
    bytes: Vec<u8>,
    retry_after: Option<RetryAfter>,
}
impl ResponseBody {
    fn decode<T: DeserializeOwned>(&self, operation: Operation) -> Result<T, GatewayError> {
        serde_json::from_slice(&self.bytes).map_err(|_| GatewayError {
            retry_after: self.retry_after,
            ..GatewayError::new(operation, ErrorKind::InvalidResponse)
        })
    }
}
fn decimal(text: &str, operation: Operation) -> Result<u64, GatewayError> {
    if text.is_empty()
        || (text.len() > 1 && text.starts_with('0'))
        || !text.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(GatewayError::new(operation, ErrorKind::InvalidResponse));
    }
    text.parse()
        .map_err(|_| GatewayError::new(operation, ErrorKind::InvalidResponse))
}
fn matching_hash(text: &str, expected: TxHash, operation: Operation) -> Result<(), GatewayError> {
    if TxHash::from_hex(text)
        .map_err(|_| GatewayError::new(operation, ErrorKind::InvalidResponse))?
        != expected
    {
        return Err(GatewayError::new(operation, ErrorKind::HashMismatch));
    }
    Ok(())
}
fn rpc_result<T>(rpc: Rpc<T>, operation: Operation) -> Result<T, GatewayError> {
    match (rpc.result, rpc.error) {
        (Some(value), None) => Ok(value),
        (None, Some(_)) => Err(GatewayError::new(operation, ErrorKind::RpcUnavailable)),
        _ => Err(GatewayError::new(operation, ErrorKind::InvalidResponse)),
    }
}
fn retry_after(headers: &HeaderMap) -> Option<RetryAfter> {
    let mut values = headers.get_all(RETRY_AFTER).iter();
    let value = values.next()?;
    if values.next().is_some() {
        return Some(RetryAfter::Invalid);
    }
    let Ok(text) = value.to_str() else {
        return Some(RetryAfter::Invalid);
    };
    if !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()) {
        return Some(
            text.parse::<u64>()
                .map(RetryAfter::DelaySeconds)
                .unwrap_or(RetryAfter::Invalid),
        );
    }
    Some(
        httpdate::parse_http_date(text)
            .map(RetryAfter::At)
            .unwrap_or(RetryAfter::Invalid),
    )
}

impl GatewayClient {
    /// HTTPS for remote hosts; HTTP requires a URL-normalized loopback IP (no
    /// DNS names). Numeric IPv4 aliases that normalize to loopback are allowed.
    /// No credentials in URLs, redirect following, environment proxy, or node fallback.
    pub fn new(gateway_url: &str, options: GatewayOptions) -> Result<Self, GatewayError> {
        let invalid =
            || GatewayError::new(Operation::Configuration, ErrorKind::InvalidConfiguration);
        let base = Url::parse(gateway_url).map_err(|_| invalid())?;
        let loopback = base.host_str().is_some_and(|h| {
            h.trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
        });
        if !(base.scheme() == "https" || (base.scheme() == "http" && loopback))
            || base.host_str().is_none()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
            || base.path() != "/"
            || options.timeout < Duration::from_millis(1)
            || options.timeout > Duration::from_secs(60)
            || options.max_response_bytes == 0
            || options.max_response_bytes > MAX_RESPONSE_BYTES
        {
            return Err(invalid());
        }
        let mut headers = HeaderMap::new();
        if let Some(key) = options.api_key {
            if key.is_empty() {
                return Err(invalid());
            }
            let mut value = HeaderValue::from_str(&key).map_err(|_| invalid())?;
            value.set_sensitive(true);
            headers.insert("X-Api-Key", value);
        }
        let client = Client::builder()
            .timeout(options.timeout)
            .connect_timeout(options.timeout)
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .default_headers(headers)
            .build()
            .map_err(|_| invalid())?;
        Ok(Self {
            client,
            base,
            max_response_bytes: options.max_response_bytes,
        })
    }

    async fn request(
        &self,
        operation: Operation,
        method: Method,
        path: &str,
        body: Option<&SignedRequest>,
    ) -> Result<ResponseBody, GatewayError> {
        let url = self
            .base
            .join(path)
            .map_err(|_| GatewayError::new(operation, ErrorKind::InvalidInput))?;
        let mut request = self.client.request(method, url);
        if let Some(body) = body {
            request = request.json(body);
        }
        let map_transport = |error: reqwest::Error| {
            GatewayError::new(
                operation,
                if error.is_timeout() {
                    ErrorKind::Timeout
                } else {
                    ErrorKind::Transport
                },
            )
        };
        let mut response = request.send().await.map_err(map_transport)?;
        let retry_after = retry_after(response.headers());
        let error = |kind| GatewayError {
            retry_after,
            ..GatewayError::new(operation, kind)
        };
        if !response.status().is_success() {
            return Err(error(ErrorKind::HttpStatus(response.status().as_u16())));
        }
        if response
            .content_length()
            .is_some_and(|n| n > self.max_response_bytes as u64)
        {
            return Err(error(ErrorKind::BodyTooLarge));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| {
            let mut e = map_transport(e);
            e.retry_after = retry_after;
            e
        })? {
            if chunk.len() > self.max_response_bytes.saturating_sub(bytes.len()) {
                return Err(error(ErrorKind::BodyTooLarge));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(ResponseBody { bytes, retry_after })
    }

    pub async fn chain_identity(&self) -> Result<ChainIdentity, GatewayError> {
        let op = Operation::ChainIdentity;
        let body = self.request(op, Method::GET, "/v1/status", None).await?;
        let status: StatusRead = rpc_result(body.decode(op)?, op)?;
        let network = status.node_info.network;
        if network.is_empty() || network.len() > 128 || network.chars().any(char::is_control) {
            return Err(GatewayError::new(op, ErrorKind::InvalidResponse));
        }
        let timestamp = chrono::DateTime::parse_from_rfc3339(&status.sync_info.latest_block_time)
            .map_err(|_| GatewayError::new(op, ErrorKind::InvalidResponse))?
            .timestamp_millis();
        let latest_block_time_ms = u64::try_from(timestamp)
            .map_err(|_| GatewayError::new(op, ErrorKind::InvalidResponse))?;
        Ok(ChainIdentity {
            chain_binding: crate::crypto::chain_id_from_string(&network),
            network,
            latest_height: decimal(&status.sync_info.latest_block_height, op)?,
            latest_block_time_ms,
            catching_up: status.sync_info.catching_up,
        })
    }

    pub async fn oracle_permissions(
        &self,
        market: NonZeroU32,
    ) -> Result<OraclePermissions, GatewayError> {
        let op = Operation::OraclePermissions;
        let body = self
            .request(
                op,
                Method::GET,
                &format!("/v1/oracle/permissions/{market}"),
                None,
            )
            .await?;
        let read: EncodedRead = body.decode(op)?;
        let bytes = STANDARD
            .decode(read.data)
            .map_err(|_| GatewayError::new(op, ErrorKind::InvalidResponse))?;
        permissions::decode(&bytes, market.get())
    }

    /// Sends the supplied signed envelope exactly once, byte-for-byte. A timeout,
    /// bad response, hash mismatch or HTTP failure never proves non-inclusion.
    pub async fn submit_signed_bytes(&self, bytes: &[u8]) -> Result<Submission, GatewayError> {
        let op = Operation::Submit;
        if bytes.is_empty() || bytes.len() > MAX_SIGNED_BYTES {
            return Err(GatewayError::new(op, ErrorKind::InvalidInput));
        }
        let hash = TxHash::of_signed_bytes(bytes);
        let result = async {
            let body = self
                .request(
                    op,
                    Method::POST,
                    "/exchange",
                    Some(&SignedRequest {
                        action: STANDARD.encode(bytes),
                    }),
                )
                .await?;
            let read: SubmitRead = body.decode(op)?;
            let invalid = || GatewayError {
                retry_after: body.retry_after,
                ..GatewayError::new(op, ErrorKind::InvalidResponse)
            };
            if !matches!(read.status.as_str(), "ok" | "error") {
                return Err(invalid());
            }
            if let Some(h) = &read.tx_hash {
                matching_hash(h, hash, op).map_err(|mut e| {
                    e.retry_after = body.retry_after;
                    e
                })?;
            }
            let has_hash = read.tx_hash.is_some();
            let outcome = match (read.code, read.height, read.tx_hash) {
                (Some(code), Some(height), Some(_)) => {
                    if (read.status == "ok") != (code == 0) {
                        return Err(invalid());
                    }
                    SubmissionOutcome::Committed(CommittedReceipt {
                        hash,
                        code,
                        height: NonZeroU64::new(height).ok_or_else(invalid)?,
                    })
                }
                (Some(code), None, Some(_)) if code != 0 && read.status == "error" => {
                    SubmissionOutcome::CheckTxRejected {
                        hash,
                        code: NonZeroU32::new(code).ok_or_else(invalid)?,
                    }
                }
                (Some(0), None, Some(_)) if read.status == "ok" => {
                    SubmissionOutcome::Pending { hash }
                }
                (None, None, Some(_)) | (None, None, None) if read.status == "ok" || has_hash => {
                    SubmissionOutcome::Pending { hash }
                }
                (None, None, None) if read.status == "error" => {
                    SubmissionOutcome::RejectedBeforeAdmission { hash }
                }
                _ => return Err(invalid()),
            };
            Ok(Submission {
                outcome,
                retry_after: body.retry_after,
            })
        }
        .await;
        result.map_err(|e: GatewayError| e.submission(hash))
    }

    /// No polling/retry is hidden here. An error (including 404/500/not indexed)
    /// is nonterminal; retain the pending transaction and reconcile later.
    pub async fn committed_receipt(&self, hash: TxHash) -> Result<CommittedReceipt, GatewayError> {
        let op = Operation::Receipt;
        let body = self
            .request(op, Method::GET, &format!("/v1/tx/{hash}"), None)
            .await?;
        let read: TxRead = rpc_result(body.decode(op)?, op)?;
        matching_hash(&read.hash, hash, op)?;
        Ok(CommittedReceipt {
            hash,
            height: NonZeroU64::new(decimal(&read.height, op)?)
                .ok_or_else(|| GatewayError::new(op, ErrorKind::InvalidResponse))?,
            code: read.tx_result.code,
        })
    }
}
