//! Signing, submission and order helpers.

use std::fmt;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use proof_trading_sdk::gateway::{
    CommittedReceipt, ErrorKind as GatewayErrorKind, MaintenanceMode, PreAdmissionRefusal,
    RetryAfter, SubmissionOutcome, TxHash,
};
use proof_trading_sdk::types::{
    Action, AmendOrder, CancelAllOrders, CancelClientOrder, CancelOrder, CancelReplaceOrder,
    ClosePosition, MarketId, MarketOrder, OrderId, PlaceOrder, Side,
};
use proof_trading_sdk::{codec, crypto, Signer};
use proof_trading_sdk::{decode_exec_error_kind, DecodedExecErrorKind, ErrorKind};

use crate::address::Address;
use crate::error::{Error, Result};
use crate::event::Event;
use crate::info::{ClientConfig, InfoClient};
use crate::nonce::NonceAllocator;

/// Signed wire bytes, ready to submit exactly once.
///
/// `hash` is the chain's transaction hash, computed locally, so it is known
/// before the gateway answers. The bytes include the signature and are kept
/// out of `Debug`.
#[derive(Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct SignedTx {
    pub bytes: Vec<u8>,
    pub hash: TxHash,
    pub seq: u64,
}

impl fmt::Debug for SignedTx {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SignedTx")
            .field("hash", &self.hash)
            .field("seq", &self.seq)
            .field("len", &self.bytes.len())
            .finish()
    }
}

/// Why the engine refused a transaction.
///
/// `Unknown` keeps the number for a code this SDK predates.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum EngineError {
    Known(ErrorKind),
    Unknown(u32),
}

impl EngineError {
    /// Classify a nonzero engine `code`, reading `log` where the code alone
    /// is ambiguous (50 during the open-interest/slippage renumbering).
    #[must_use]
    pub fn new(code: u32, log: Option<&str>) -> Self {
        match decode_exec_error_kind(code, log) {
            Some(DecodedExecErrorKind::Known(kind)) => Self::Known(kind),
            Some(DecodedExecErrorKind::SlippageExceeded) => {
                Self::Known(ErrorKind::SlippageExceeded)
            }
            Some(DecodedExecErrorKind::LegacyOpenInterestLimitExceeded) => {
                Self::Known(ErrorKind::OpenInterestLimitExceeded)
            }
            Some(DecodedExecErrorKind::AmbiguousCode50) | None => Self::Unknown(code),
        }
    }

    /// The engine's numeric code.
    #[must_use]
    pub fn code(self) -> u32 {
        match self {
            Self::Known(kind) => kind.code(),
            Self::Unknown(code) => code,
        }
    }

    /// The order a cancel, amend or replace named no longer rests (filled,
    /// cancelled or never placed).
    #[must_use]
    pub fn is_order_not_found(self) -> bool {
        matches!(
            self,
            Self::Known(ErrorKind::OrderNotFound | ErrorKind::ClientOrderIdNotFound)
        )
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Known(kind) => write!(f, "{} ({})", kind.name(), kind.code()),
            Self::Unknown(code) => write!(f, "engine error {code}"),
        }
    }
}

/// A committed transaction's result: where it landed, whether it worked, and
/// what it did.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct Receipt {
    pub hash: TxHash,
    /// The block it executed in.
    pub height: u64,
    /// `None` is success.
    pub error: Option<EngineError>,
    /// The engine's log, unchanged.
    pub log: String,
    /// What the transaction did, in emission order: [`Event::OrderPlaced`],
    /// [`Event::Fill`], [`Event::OrderCancelled`], ... One transaction can
    /// emit several of each (a basket, a cancel-replace). An order that fully
    /// fills on arrival emits fills and no `OrderPlaced`; an IOC remainder or
    /// a refused post-only emits neither.
    pub events: Vec<Event>,
}

impl Receipt {
    #[must_use]
    pub fn is_success(&self) -> bool {
        self.error.is_none()
    }
}

impl From<CommittedReceipt> for Receipt {
    fn from(r: CommittedReceipt) -> Self {
        Self {
            hash: r.hash,
            height: r.height.get(),
            error: (r.code != 0).then(|| EngineError::new(r.code, Some(&r.log))),
            log: r.log,
            events: r.events.into_iter().map(Event::from).collect(),
        }
    }
}

/// Why the gateway turned a submission away before admitting it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum RefusalReason {
    /// Missing or wrong API key.
    Unauthorized,
    /// Too many requests; see [`Submitted::retry_after`].
    RateLimited,
    /// Trading is paused.
    Paused,
    /// Only cancels are accepted.
    CancelOnly,
    /// The gateway or its verifier is overloaded or unavailable.
    Unavailable,
    /// The request itself was malformed.
    InvalidRequest,
}

impl From<PreAdmissionRefusal> for RefusalReason {
    fn from(r: PreAdmissionRefusal) -> Self {
        match r {
            PreAdmissionRefusal::Unauthorized => Self::Unauthorized,
            PreAdmissionRefusal::RateLimited => Self::RateLimited,
            PreAdmissionRefusal::Maintenance(MaintenanceMode::Paused) => Self::Paused,
            PreAdmissionRefusal::Maintenance(MaintenanceMode::CancelOnly) => Self::CancelOnly,
            PreAdmissionRefusal::Overloaded | PreAdmissionRefusal::VerifierUnavailable => {
                Self::Unavailable
            }
            PreAdmissionRefusal::InvalidRequest | PreAdmissionRefusal::InvalidEncoding => {
                Self::InvalidRequest
            }
        }
    }
}

/// Where one submission ended up.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum TxStatus {
    /// Executed in a block. Check [`Receipt::error`]: `None` is success.
    Committed(Receipt),
    /// Refused at `CheckTx`. It will never execute.
    Rejected(EngineError),
    /// Admitted with no verdict yet. Reconcile with
    /// [`ExchangeClient::wait_for_receipt`]; never re-sign.
    Pending,
    /// Turned away by the gateway before admission. It did not execute.
    Refused(RefusalReason),
}

/// The answer to one submission.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct Submitted {
    pub tx: SignedTx,
    pub status: TxStatus,
    /// How long the gateway asked callers to wait before the next request,
    /// if it said. An unreadable `Retry-After` reads as one second, never as
    /// "retry now".
    pub retry_after: Option<Duration>,
}

impl Submitted {
    /// Executed in a block with code 0.
    #[must_use]
    pub fn is_success(&self) -> bool {
        matches!(&self.status, TxStatus::Committed(r) if r.is_success())
    }

    /// Admitted, but no verdict yet.
    #[must_use]
    pub fn is_pending(&self) -> bool {
        matches!(self.status, TxStatus::Pending)
    }

    /// Why the engine refused the transaction, at `CheckTx` or in the block.
    #[must_use]
    pub fn error(&self) -> Option<EngineError> {
        match &self.status {
            TxStatus::Committed(r) => r.error,
            TxStatus::Rejected(e) => Some(*e),
            _ => None,
        }
    }

    /// The committed receipt, if the transaction executed.
    #[must_use]
    pub fn receipt(&self) -> Option<&Receipt> {
        match &self.status {
            TxStatus::Committed(r) => Some(r),
            _ => None,
        }
    }
}

/// An unreadable `Retry-After` must never mean "retry now".
const INVALID_RETRY_AFTER: Duration = Duration::from_secs(1);

fn retry_after(hint: Option<RetryAfter>) -> Option<Duration> {
    hint.map(|h| match h {
        RetryAfter::DelaySeconds(s) => Duration::from_secs(s),
        RetryAfter::At(at) => at
            .duration_since(SystemTime::now())
            .unwrap_or(Duration::ZERO),
        RetryAfter::Invalid => INVALID_RETRY_AFTER,
    })
}

fn status(outcome: SubmissionOutcome<PreAdmissionRefusal>) -> TxStatus {
    match outcome {
        SubmissionOutcome::Committed(r) => TxStatus::Committed(r.into()),
        SubmissionOutcome::CheckTxRejected { code, .. } => {
            TxStatus::Rejected(EngineError::new(code.get(), None))
        }
        SubmissionOutcome::Pending { .. } => TxStatus::Pending,
        SubmissionOutcome::RejectedBeforeAdmission { refusal, .. } => {
            TxStatus::Refused(refusal.into())
        }
    }
}

/// Signs and submits actions for one account through the gateway.
///
/// Cheap to clone. Clones share the connection pool *and* the nonce
/// allocator, so hand a clone to every task that trades with this key.
///
/// Each submit is one `POST /exchange` with no hidden retry. The order helpers
/// fill `owner` with this client's address. To trade as a delegated agent for
/// another owner, build the action yourself and call [`Self::submit`].
#[derive(Clone)]
pub struct ExchangeClient {
    inner: Arc<Inner>,
}

struct Inner {
    info: InfoClient,
    signer: Arc<dyn Signer>,
    public_key: [u8; 32],
    address: Address,
    chain_id: [u8; 32],
    network: String,
    nonces: NonceAllocator,
}

impl fmt::Debug for ExchangeClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ExchangeClient")
            .field("address", &self.inner.address)
            .field("network", &self.inner.network)
            .finish_non_exhaustive()
    }
}

/// A receipt read that means "not committed yet" (404, the node's JSON-RPC
/// not-found) or a transient failure. Anything else (401, 403, 429, a
/// malformed answer) is returned, not hidden behind a timeout.
fn still_pending(kind: GatewayErrorKind) -> bool {
    match kind {
        GatewayErrorKind::HttpStatus(status) => status == 404 || status >= 500,
        GatewayErrorKind::RpcUnavailable
        | GatewayErrorKind::Transport
        | GatewayErrorKind::Timeout => true,
        _ => false,
    }
}

/// First receipt poll delay; each poll adds [`RECEIPT_POLL_STEP`] up to
/// [`RECEIPT_POLL_MAX`]. Matches the TypeScript SDK.
const RECEIPT_POLL_START: Duration = Duration::from_millis(200);
const RECEIPT_POLL_STEP: Duration = Duration::from_millis(100);
const RECEIPT_POLL_MAX: Duration = Duration::from_millis(600);

impl ExchangeClient {
    /// Build a client signing for `config`'s chain id. Makes no request.
    /// Use [`Self::connect`] to check the chain against the gateway first.
    ///
    /// # Errors
    ///
    /// [`Error::Config`] if `config` has no chain id or is invalid.
    pub fn new(config: &ClientConfig, signer: impl Signer + 'static) -> Result<Self> {
        let network = config
            .chain_id()
            .ok_or_else(|| {
                Error::Config(
                    "ExchangeClient::new needs a chain id; use connect() to read it".into(),
                )
            })?
            .to_owned();
        Ok(Self::build(
            InfoClient::new(config)?,
            Arc::new(signer),
            network,
        ))
    }

    /// Read the gateway's chain and bind signatures to it. If `config` names
    /// a chain id, the gateway must serve that chain.
    ///
    /// # Errors
    ///
    /// [`Error::Config`] for an invalid `config`, a read failure from
    /// [`InfoClient::chain_status`], or [`Error::ChainMismatch`].
    pub async fn connect(config: &ClientConfig, signer: impl Signer + 'static) -> Result<Self> {
        let info = InfoClient::new(config)?;
        let chain = info.chain_status().await?;
        if let Some(expected) = config.chain_id() {
            if expected != chain.network {
                return Err(Error::ChainMismatch {
                    expected: expected.to_owned(),
                    actual: chain.network,
                });
            }
        }
        Ok(Self::build(info, Arc::new(signer), chain.network))
    }

    fn build(info: InfoClient, signer: Arc<dyn Signer>, network: String) -> Self {
        let public_key = signer.public_key();
        Self {
            inner: Arc::new(Inner {
                info,
                address: Address::from_public_key(&public_key),
                public_key,
                chain_id: crypto::chain_id_from_string(&network),
                network,
                signer,
                nonces: NonceAllocator::new(),
            }),
        }
    }

    /// This account's address.
    #[must_use]
    pub fn address(&self) -> Address {
        self.inner.address
    }

    /// The signer's Ed25519 public key.
    #[must_use]
    pub fn public_key(&self) -> [u8; 32] {
        self.inner.public_key
    }

    /// The network signatures are bound to (e.g. `exchange-devnet-1`).
    #[must_use]
    pub fn network(&self) -> &str {
        &self.inner.network
    }

    /// The read client sharing this client's connection pool.
    #[must_use]
    pub fn info(&self) -> &InfoClient {
        &self.inner.info
    }

    /// Signs this account's `accountEvents` WebSocket subscriptions with this
    /// client's signer, for this client's network.
    #[cfg(feature = "ws")]
    #[must_use]
    pub fn account_auth(&self) -> crate::AccountAuth {
        crate::AccountAuth::new(Arc::clone(&self.inner.signer), &self.inner.network)
    }

    /// The nonce allocator every [`Self::sign`] draws from.
    #[must_use]
    pub fn nonces(&self) -> &NonceAllocator {
        &self.inner.nonces
    }

    // -- sign / submit ------------------------------------------------------

    /// Sign `action` with the next nonce. Pure CPU, no I/O.
    ///
    /// # Errors
    ///
    /// [`Error::NonceWindow`] if the allocator would run too far ahead of the
    /// clock, [`Error::Encode`] or [`Error::Signer`].
    pub fn sign(&self, action: &Action) -> Result<SignedTx> {
        let seq = self.inner.nonces.next()?;
        self.sign_with_seq(action, seq)
    }

    /// Sign `action` with a caller-chosen `seq`. The caller guarantees it is
    /// unique for this key.
    ///
    /// # Errors
    ///
    /// [`Error::Encode`] or [`Error::Signer`].
    pub fn sign_with_seq(&self, action: &Action, seq: u64) -> Result<SignedTx> {
        let encode = |e: proof_trading_sdk::types::ExecError| Error::Encode(e.to_string());
        let inner = &*self.inner;
        // The typed codec only signs with an in-memory key. To sign through
        // `Signer` (HSM, KMS), take the canonical (action_type, payload) from an
        // unsigned envelope and sign the preimage ourselves.
        let unsigned =
            codec::encode_signed_tx(action, seq, &inner.public_key, &[0; 64]).map_err(encode)?;
        let raw = codec::decode_tx_raw(&unsigned).map_err(encode)?;
        let msg = crypto::signing_message(&inner.chain_id, raw.action_type, seq, &raw.payload);
        let signature = inner.signer.try_sign(&msg)?;
        let bytes = codec::encode_signed_tx_raw(
            raw.action_type,
            &raw.payload,
            seq,
            &inner.public_key,
            &signature,
        )
        .map_err(encode)?;
        Ok(SignedTx {
            hash: TxHash::of_signed_bytes(&bytes),
            bytes,
            seq,
        })
    }

    /// `POST /exchange` the signed bytes once. No retry.
    ///
    /// On [`Error::Transport`] or an [`Error::Http`] 5xx the bytes may still
    /// have reached the gateway: look `tx.hash` up with
    /// [`Self::wait_for_receipt`], or resend the same `tx` (same nonce, so it
    /// executes at most once). Signing the action again creates a second
    /// transaction.
    ///
    /// # Errors
    ///
    /// [`Error::Transport`] or [`Error::Http`] when no verdict came back,
    /// [`Error::Decode`] or [`Error::ResponseTooLarge`] when it was unreadable.
    pub async fn send(&self, tx: &SignedTx) -> Result<Submitted> {
        let s = self
            .inner
            .info
            .gateway()
            .submit_signed_bytes_with_evidence(&tx.bytes)
            .await?;
        Ok(Submitted {
            tx: tx.clone(),
            status: status(s.outcome),
            retry_after: retry_after(s.retry_after),
        })
    }

    /// Sign `action` with a fresh nonce and submit it.
    ///
    /// # Errors
    ///
    /// [`Error::NonceWindow`], [`Error::Encode`] or [`Error::Signer`] before
    /// anything is sent, then whatever [`Self::send`] returns.
    pub async fn submit(&self, action: &Action) -> Result<Submitted> {
        self.send(&self.sign(action)?).await
    }

    /// [`Self::submit`], then wait up to `timeout` for a pending result to
    /// commit. A refused or already-committed result returns immediately.
    ///
    /// # Errors
    ///
    /// [`Error::NonceWindow`], [`Error::Encode`] or [`Error::Signer`] before
    /// anything is sent, then whatever [`Self::send`] returns.
    /// [`Error::ReceiptTimeout`] if a pending result does not commit in time.
    pub async fn submit_and_wait(&self, action: &Action, timeout: Duration) -> Result<Submitted> {
        let mut submitted = self.submit(action).await?;
        if submitted.is_pending() {
            let receipt = self.wait_for_receipt(submitted.tx.hash, timeout).await?;
            submitted.status = TxStatus::Committed(receipt);
        }
        Ok(submitted)
    }

    /// Poll `GET /v1/tx/{hash}` until the transaction commits or `timeout`
    /// passes. Not found is not failure: it returns
    /// [`Error::ReceiptTimeout`], and the transaction may still land later.
    ///
    /// # Errors
    ///
    /// [`Error::ReceiptTimeout`] at the deadline. A 404, a 5xx or a transport
    /// failure is retried until then; any other failure is returned at once.
    pub async fn wait_for_receipt(&self, hash: TxHash, timeout: Duration) -> Result<Receipt> {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut delay = RECEIPT_POLL_START;
        loop {
            match self.inner.info.gateway().committed_receipt(hash).await {
                Ok(receipt) => return Ok(receipt.into()),
                // Not found yet, not indexed yet, or transient: keep polling.
                Err(e) if still_pending(e.kind) => {}
                Err(e) => return Err(e.into()),
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return Err(Error::ReceiptTimeout { hash });
            }
            tokio::time::sleep(delay.min(deadline - now)).await;
            delay = (delay + RECEIPT_POLL_STEP).min(RECEIPT_POLL_MAX);
        }
    }

    // -- order helpers --------------------------------------------------------

    /// A GTC limit order for this account. Adjust the fields (`post_only`,
    /// `client_order_id`, `time_in_force`, ...) before [`Self::place_order`].
    #[must_use]
    pub fn limit_order(
        &self,
        market: MarketId,
        side: Side,
        price: u64,
        quantity: u64,
    ) -> PlaceOrder {
        PlaceOrder {
            market,
            owner: self.inner.address.to_bytes(),
            side,
            price,
            quantity,
            ..PlaceOrder::default()
        }
    }

    /// Place a limit order (`PlaceOrder`).
    ///
    /// # Errors
    ///
    /// As [`Self::submit`].
    pub async fn place_order(&self, order: PlaceOrder) -> Result<Submitted> {
        self.submit(&Action::PlaceOrder(order)).await
    }

    /// Immediate-or-cancel at the best available prices (`MarketOrder`).
    ///
    /// # Errors
    ///
    /// As [`Self::submit`].
    pub async fn market_order(
        &self,
        market: MarketId,
        side: Side,
        quantity: u64,
    ) -> Result<Submitted> {
        self.submit(&Action::MarketOrder(MarketOrder {
            market,
            owner: self.owner(),
            side,
            quantity,
            client_order_id: None,
            stop_loss: None,
            take_profit: None,
        }))
        .await
    }

    /// Cancel by exchange order id (`CancelOrder`).
    ///
    /// # Errors
    ///
    /// As [`Self::submit`].
    pub async fn cancel_order(&self, order_id: OrderId) -> Result<Submitted> {
        self.submit(&Action::CancelOrder(CancelOrder {
            order_id,
            owner: self.owner(),
        }))
        .await
    }

    /// Cancel by client order id (`CancelClientOrder`).
    ///
    /// # Errors
    ///
    /// As [`Self::submit`].
    pub async fn cancel_client_order(&self, client_order_id: u64) -> Result<Submitted> {
        self.submit(&Action::CancelClientOrder(CancelClientOrder {
            owner: self.owner(),
            client_order_id,
        }))
        .await
    }

    /// Cancel every resting order, or only those on `market`
    /// (`CancelAllOrders`).
    ///
    /// # Errors
    ///
    /// As [`Self::submit`].
    pub async fn cancel_all_orders(&self, market: Option<MarketId>) -> Result<Submitted> {
        self.submit(&Action::CancelAllOrders(CancelAllOrders {
            owner: self.owner(),
            market,
        }))
        .await
    }

    /// Change a resting order's price and/or total quantity in place
    /// (`AmendOrder`). A same-price size cut keeps queue priority.
    ///
    /// # Errors
    ///
    /// As [`Self::submit`].
    pub async fn amend_order(
        &self,
        order_id: OrderId,
        new_price: Option<u64>,
        new_quantity: Option<u64>,
    ) -> Result<Submitted> {
        self.submit(&Action::AmendOrder(AmendOrder {
            owner: self.owner(),
            order_id,
            new_price,
            new_quantity,
        }))
        .await
    }

    /// Atomically cancel one order and place another
    /// (`CancelReplaceOrder`). Set exactly one of `cancel_order_id` /
    /// `cancel_client_order_id`.
    ///
    /// # Errors
    ///
    /// As [`Self::submit`].
    pub async fn cancel_replace_order(&self, order: CancelReplaceOrder) -> Result<Submitted> {
        self.submit(&Action::CancelReplaceOrder(order)).await
    }

    /// Flatten this account's position on `market` (`ClosePosition`).
    ///
    /// # Errors
    ///
    /// As [`Self::submit`].
    pub async fn close_position(&self, market: MarketId) -> Result<Submitted> {
        self.submit(&Action::ClosePosition(ClosePosition {
            market,
            owner: self.owner(),
        }))
        .await
    }

    fn owner(&self) -> [u8; 20] {
        self.inner.address.to_bytes()
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use proof_trading_sdk::LocalSigner;

    fn client() -> ExchangeClient {
        ExchangeClient::new(&ClientConfig::devnet(), LocalSigner::from_bytes(&[7; 32])).unwrap()
    }

    #[test]
    fn signer_path_is_byte_identical_to_the_engine_codec() {
        let c = client();
        let action = Action::PlaceOrder(c.limit_order(1, Side::Buy, 66_750_000_000, 3));
        let ours = c.sign_with_seq(&action, 1_762_000_000_000).unwrap();
        let reference = codec::sign_and_encode_with_chain(
            &crypto::chain_id_from_string("exchange-devnet-1"),
            &action,
            1_762_000_000_000,
            &ed25519_dalek::SigningKey::from_bytes(&[7; 32]),
        )
        .unwrap();
        assert_eq!(ours.bytes, reference);
        assert_eq!(ours.hash, TxHash::of_signed_bytes(&reference));
    }

    #[test]
    fn signatures_verify_against_the_bound_chain_only() {
        let c = client();
        let tx = c
            .sign(&Action::CancelAllOrders(CancelAllOrders {
                owner: c.owner(),
                market: None,
            }))
            .unwrap();
        let raw = codec::decode_tx_raw(&tx.bytes).unwrap();
        let verify = |chain: &str| {
            crypto::verify_signature(
                &crypto::chain_id_from_string(chain),
                &raw.pubkey,
                &raw.signature,
                raw.action_type,
                raw.seq,
                &raw.payload,
            )
            .is_ok()
        };
        assert!(verify("exchange-devnet-1"));
        assert!(!verify("exchange-mainnet-1"));
    }

    #[test]
    fn helpers_fill_this_accounts_owner() {
        let c = client();
        let order = c.limit_order(4, Side::Sell, 1, 1);
        assert_eq!(Address::from(order.owner), c.address());
        assert!(!order.post_only && !order.reduce_only);
    }

    #[test]
    fn debug_never_prints_signed_bytes() {
        let c = client();
        let tx = c
            .sign(&Action::PlaceOrder(c.limit_order(1, Side::Buy, 1, 1)))
            .unwrap();
        let shown = format!("{tx:?}");
        assert!(shown.contains("hash") && !shown.contains("bytes"));
    }

    #[test]
    fn offline_requires_a_chain_id() {
        let err = ExchangeClient::new(
            &ClientConfig::new("https://api.dev.proof.trade"),
            LocalSigner::from_bytes(&[1; 32]),
        )
        .unwrap_err();
        assert!(matches!(err, Error::Config(_)));
    }
}
